import { randomUUID } from "node:crypto";
import { OPENAI_OAUTH } from "../auth/oauthClients";
import { log } from "../util/log";
import { abortSignalFor, readSse, throwHttpError } from "./sse";
import {
  LlmCancelledError,
  LlmHttpError,
  type CancelToken,
  type ChatRequest,
  type ChatTurn,
  type LlmClient,
  type NeutralMessage,
  type ProviderId,
  type StopReason,
  type StreamEvent,
  type ToolCall,
} from "./types";

/**
 * Fallback ladder, used only when the backend will not tell us what the account
 * may use. Which model a ChatGPT account can drive through Codex is an
 * entitlement that differs per account and that OpenAI changes without notice,
 * so guessing is always the second-best option — see `discoverModels`.
 */
/**
 * Sent as the `version` header. The Codex backend keys the model list it offers
 * on the client version, and an absent or very old one gets a reduced set.
 */
const CODEX_CLIENT_VERSION = "0.56.0";

export const CHATGPT_MODEL_CANDIDATES = [
  "gpt-5.2-codex",
  "gpt-5.1-codex",
  "gpt-5.1-codex-mini",
  "gpt-5-codex",
  "gpt-5.2",
  "gpt-5.1",
  "gpt-5",
];

/** The backend's wording when the account isn't entitled to a model. */
function isUnsupportedModel(err: unknown): boolean {
  return (
    err instanceof LlmHttpError &&
    err.status === 400 &&
    /is not supported when using Codex|model is not supported|unsupported[_ ]model|does not exist|invalid[_ ]model/i.test(
      err.body,
    )
  );
}

/** Pulls the human-readable half out of a JSON error body for the log. */
function errorDetail(err: unknown): string {
  if (!(err instanceof LlmHttpError)) return String(err);
  try {
    const parsed = JSON.parse(err.body) as { detail?: unknown; error?: { message?: unknown } };
    const detail = parsed.detail ?? parsed.error?.message;
    if (typeof detail === "string" && detail.length > 0) return detail;
  } catch {
    /* not JSON — fall through to the raw body */
  }
  return err.body.slice(0, 200);
}

/**
 * Talks to the ChatGPT Codex backend, which speaks the Responses API rather than
 * chat completions: the system prompt goes in `instructions`, turns go in a flat
 * `input` array, and tool schemas are flat rather than nested under `function`.
 */
export class CodexClient implements LlmClient {
  readonly id: ProviderId = "chatgpt-oauth";

  /** What the backend said this account may use. Resolved once per session. */
  private allowed: string[] | undefined;
  private discovery: Promise<string[] | undefined> | undefined;
  /**
   * One id per Codex session, sent on every request. The backend groups requests
   * by it, and older builds gated the model list on its presence.
   */
  private readonly sessionId = randomUUID();

  constructor(
    readonly model: string,
    private readonly getAccessToken: (forceRefresh?: boolean) => Promise<string>,
    private readonly getAccountId: () => string | undefined,
    /** Set when the user pinned a model; disables negotiation. */
    private readonly modelPinned = false,
    private readonly rememberModel: (model: string) => void = () => {},
  ) {}

  async chat(
    req: ChatRequest,
    onEvent: (e: StreamEvent) => void,
    token: CancelToken,
  ): Promise<ChatTurn> {
    const candidates = await this.candidateModels(req.model);

    const rejections: string[] = [];
    for (const model of candidates) {
      try {
        const turn = await this.attempt({ ...req, model }, onEvent, token);
        if (model !== req.model) {
          log.info(`ChatGPT account is not entitled to ${req.model}; using ${model}.`);
        }
        this.rememberModel(model);
        return turn;
      } catch (err) {
        if (!isUnsupportedModel(err)) throw err;
        const detail = errorDetail(err);
        rejections.push(`${model}: ${detail}`);
        log.warn(`ChatGPT rejected ${model} — ${detail}`);
      }
    }

    throw new Error(buildEntitlementError(candidates, rejections, this.modelPinned));
  }

  /**
   * Which model ids to try, best first.
   *
   * Asking the backend beats guessing: OpenAI renames Codex model slugs without
   * notice, and when every id in a hardcoded ladder has been retired the user
   * gets a wall of 400s that reads like a broken extension. The discovery call
   * is one cheap GET per session, and a failure just falls back to the ladder.
   */
  private async candidateModels(requested: string): Promise<string[]> {
    if (this.modelPinned) return [requested];

    const allowed = await this.discoverAllowedModels();
    if (allowed && allowed.length > 0) {
      // A requested id the backend did not list is still worth one attempt —
      // the list may be partial — but it goes last rather than first.
      const known = allowed.includes(requested);
      return known ? [requested, ...allowed.filter((m) => m !== requested)] : [...allowed, requested];
    }
    return [requested, ...CHATGPT_MODEL_CANDIDATES.filter((m) => m !== requested)];
  }

  private discoverAllowedModels(): Promise<string[] | undefined> {
    if (this.allowed) return Promise.resolve(this.allowed);
    this.discovery ??= this.fetchAllowedModels()
      .then((models) => {
        if (models && models.length > 0) {
          this.allowed = models;
          log.info(`ChatGPT account offers: ${models.join(", ")}.`);
        }
        return models;
      })
      .catch((err) => {
        log.warn(`Could not list ChatGPT models (${String(err)}); falling back to the ladder.`);
        return undefined;
      });
    return this.discovery;
  }

  private async fetchAllowedModels(): Promise<string[] | undefined> {
    const response = await fetch(`${OPENAI_OAUTH.codexBase}/models`, {
      method: "GET",
      headers: { ...(await this.headers()), accept: "application/json" },
    });
    if (!response.ok) {
      log.warn(`Model list unavailable (HTTP ${response.status}).`);
      return undefined;
    }
    const json = (await response.json()) as unknown;
    return extractModelIds(json);
  }

  private async attempt(
    req: ChatRequest,
    onEvent: (e: StreamEvent) => void,
    token: CancelToken,
  ): Promise<ChatTurn> {
    try {
      return await this.send(req, onEvent, token, false);
    } catch (err) {
      if (isUnauthorized(err)) return await this.send(req, onEvent, token, true);
      throw err;
    }
  }

  /**
   * The identity headers every Codex request carries. `originator`, `version`
   * and `session_id` are what the backend uses to decide which models a client
   * may ask for, so they belong on the model-list call as well as on inference.
   */
  private async headers(forceRefresh = false): Promise<Record<string, string>> {
    const accessToken = await this.getAccessToken(forceRefresh);
    const accountId = this.getAccountId();
    const headers: Record<string, string> = {
      authorization: `Bearer ${accessToken}`,
      "OpenAI-Beta": "responses=experimental",
      originator: "codex_cli_rs",
      version: CODEX_CLIENT_VERSION,
      session_id: this.sessionId,
    };
    if (accountId) headers["chatgpt-account-id"] = accountId;
    return headers;
  }

  private async send(
    req: ChatRequest,
    onEvent: (e: StreamEvent) => void,
    token: CancelToken,
    forceRefresh: boolean,
  ): Promise<ChatTurn> {
    const headers: Record<string, string> = {
      ...(await this.headers(forceRefresh)),
      "content-type": "application/json",
      accept: "text/event-stream",
    };

    const body = {
      model: req.model,
      // The backend rejects an empty instructions field.
      instructions: req.system || "You are a helpful assistant.",
      input: toResponsesInput(req.messages),
      tools: req.tools.map((t) => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      })),
      stream: true,
      store: false,
      include: ["reasoning.encrypted_content"],
    };

    const abort = abortSignalFor(token);
    let response: Response;
    try {
      response = await fetch(`${OPENAI_OAUTH.codexBase}/responses`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: abort.signal,
      });
    } catch (err) {
      abort.dispose();
      if (token.isCancellationRequested) throw new LlmCancelledError();
      throw err;
    }

    if (!response.ok) {
      abort.dispose();
      await throwHttpError(response);
    }

    try {
      return await this.consumeStream(response, onEvent, token);
    } finally {
      abort.dispose();
    }
  }

  private async consumeStream(
    response: Response,
    onEvent: (e: StreamEvent) => void,
    token: CancelToken,
  ): Promise<ChatTurn> {
    let text = "";
    const toolCalls: ToolCall[] = [];
    const rawItems: unknown[] = [];
    let stopReason: StopReason = "end";
    let detail: string | undefined;
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const msg of readSse(response, token)) {
      if (msg.data === "[DONE]") break;
      let payload: any;
      try {
        payload = JSON.parse(msg.data);
      } catch {
        continue;
      }

      switch (payload.type) {
        case "response.output_text.delta": {
          if (typeof payload.delta === "string") {
            text += payload.delta;
            onEvent({ type: "text", delta: payload.delta });
          }
          break;
        }
        case "response.output_item.added": {
          if (payload.item?.type === "function_call") {
            onEvent({ type: "toolCallStart", name: String(payload.item.name ?? "") });
          }
          break;
        }
        case "response.output_item.done": {
          const item = payload.item;
          if (!item) break;
          // Reasoning items must be echoed back verbatim on the next turn.
          if (item.type === "reasoning" || item.type === "function_call") {
            rawItems.push(item);
          }
          if (item.type === "function_call") {
            toolCalls.push({
              callId: String(item.call_id ?? item.id ?? ""),
              name: String(item.name ?? ""),
              input: safeParse(item.arguments),
            });
          }
          break;
        }
        case "response.completed":
        case "response.incomplete": {
          const usage = payload.response?.usage;
          if (usage) {
            inputTokens = usage.input_tokens ?? inputTokens;
            outputTokens = usage.output_tokens ?? outputTokens;
          }
          if (payload.type === "response.incomplete") {
            stopReason =
              payload.response?.incomplete_details?.reason === "max_output_tokens"
                ? "maxTokens"
                : "end";
          }
          break;
        }
        case "response.failed":
        case "error": {
          stopReason = "error";
          detail =
            payload.response?.error?.message ??
            payload.error?.message ??
            "The ChatGPT backend returned an error.";
          break;
        }
        case "response.refusal.done": {
          stopReason = "refusal";
          detail = payload.refusal ?? "The model declined this request.";
          break;
        }
        default:
          break;
      }
    }

    if (toolCalls.length > 0 && stopReason === "end") stopReason = "toolUse";
    onEvent({ type: "usage", inputTokens, outputTokens });

    return {
      text,
      toolCalls,
      stopReason,
      usage: { inputTokens, outputTokens },
      detail,
      raw: rawItems.length > 0 ? rawItems : undefined,
    };
  }
}

/**
 * Pulls model ids out of whatever shape the model-list endpoint returns. The
 * response format has changed across Codex releases (`{data:[…]}`, `{models:[…]}`,
 * a bare array, ids under `id` or `slug`), so this is deliberately shape-agnostic
 * rather than tied to one version's contract.
 */
export function extractModelIds(json: unknown): string[] | undefined {
  const list = Array.isArray(json)
    ? json
    : typeof json === "object" && json !== null
      ? ((json as Record<string, unknown>).models ??
        (json as Record<string, unknown>).data ??
        undefined)
      : undefined;
  if (!Array.isArray(list)) return undefined;

  const ids: string[] = [];
  for (const entry of list) {
    if (typeof entry === "string") {
      ids.push(entry);
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = record.id ?? record.slug ?? record.model ?? record.name;
    if (typeof id === "string" && id.length > 0) ids.push(id);
  }
  return ids.length > 0 ? [...new Set(ids)] : undefined;
}

/**
 * Turns a pile of 400s into something the user can act on. The three cases need
 * different advice: a pinned id that does not exist, an account with no Codex
 * entitlement at all, and a ladder that has simply gone stale.
 */
function buildEntitlementError(
  tried: string[],
  rejections: string[],
  pinned: boolean,
): string {
  const detail = rejections[0]?.split(": ").slice(1).join(": ") ?? "";
  const noEntitlement = /ChatGPT account|plan|subscription|entitl/i.test(detail);

  // Entitlement is checked first on purpose. When the account has no Codex
  // access, *no* model works — so telling a pinned user to "pick Automatic"
  // sends them round a loop that walks the same ladder and fails again. That
  // advice only helps when other models would have worked.
  if (noEntitlement) {
    return (
      `Your ChatGPT plan does not include Codex, which is the only thing a ChatGPT login can reach. ` +
      `The backend said: ${detail}\n\n` +
      `No model will work here — changing the model setting cannot fix it, because the account lacks the entitlement rather than the model being wrong. ` +
      `Codex needs an active ChatGPT Plus, Pro, Business, or Edu plan.\n\n` +
      `Free alternatives that work properly: Ollama (local), Groq, Gemini, Kimi, or Mistral. ` +
      `Run "IronBase: Connect an Account…" to pick one.`
    );
  }
  if (pinned) {
    return (
      `Your ChatGPT account cannot use "${tried[0]}". The backend said: ${detail}\n\n` +
      `Run "IronBase: Choose Model…" and pick Automatic to let IronBase ask your account which models it may use.`
    );
  }
  return (
    `None of the ChatGPT models IronBase tried were accepted (${tried.join(", ")}).\n\n` +
    rejections.map((r) => `  • ${r}`).join("\n") +
    `\n\nIf you know an id your plan allows, set it in the ironbase.model setting — IronBase will use it verbatim.`
  );
}

function toResponsesInput(messages: NeutralMessage[]): unknown[] {
  const input: unknown[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      input.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: m.text }],
      });
    } else if (m.role === "assistant") {
      // Replay reasoning items exactly; the backend rejects edited ones.
      if (Array.isArray(m.raw)) {
        for (const item of m.raw) input.push(item);
      }
      if (m.text) {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: m.text }],
        });
      }
      if (!Array.isArray(m.raw)) {
        for (const call of m.toolCalls ?? []) {
          input.push({
            type: "function_call",
            call_id: call.callId,
            name: call.name,
            arguments: JSON.stringify(call.input ?? {}),
          });
        }
      }
    } else {
      for (const result of m.results) {
        input.push({
          type: "function_call_output",
          call_id: result.callId,
          output: result.content,
        });
      }
    }
  }
  return input;
}

function safeParse(raw: unknown): unknown {
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function isUnauthorized(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    ((err as { status: unknown }).status === 401 ||
      (err as { status: unknown }).status === 403)
  );
}
