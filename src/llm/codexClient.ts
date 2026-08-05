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
 * Which model a ChatGPT account may use through Codex is an entitlement that
 * differs per account and that OpenAI changes without notice — a hardcoded id
 * works for some users and 400s for others. So rather than pick one, try this
 * ladder best-first and remember whichever the account accepts.
 */
export const CHATGPT_MODEL_CANDIDATES = [
  "gpt-5.1-codex",
  "gpt-5-codex",
  "gpt-5.1",
  "gpt-5",
  "codex-mini-latest",
];

/** The backend's wording when the account isn't entitled to a model. */
function isUnsupportedModel(err: unknown): boolean {
  return (
    err instanceof LlmHttpError &&
    err.status === 400 &&
    /is not supported when using Codex|model is not supported|unsupported[_ ]model/i.test(
      err.body,
    )
  );
}

/**
 * Talks to the ChatGPT Codex backend, which speaks the Responses API rather than
 * chat completions: the system prompt goes in `instructions`, turns go in a flat
 * `input` array, and tool schemas are flat rather than nested under `function`.
 */
export class CodexClient implements LlmClient {
  readonly id: ProviderId = "chatgpt-oauth";

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
    // Try the configured model first, then work down the ladder. Each rejection
    // is one cheap request, and the winner is cached so this happens once.
    const candidates = this.modelPinned
      ? [req.model]
      : [req.model, ...CHATGPT_MODEL_CANDIDATES.filter((m) => m !== req.model)];

    let lastUnsupported: unknown;
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
        lastUnsupported = err;
        log.warn(`ChatGPT account rejected model ${model}; trying the next one.`);
      }
    }

    throw new Error(
      this.modelPinned
        ? `Your ChatGPT account is not entitled to "${req.model}". Clear the ironbase.model setting to let IronBase pick one automatically.`
        : `Your ChatGPT account is not entitled to any model IronBase knows about (tried ${candidates.join(", ")}). ` +
          `Run \`codex\` to see which models your plan allows, then set that id in the ironbase.model setting. ` +
          `Original response: ${lastUnsupported instanceof Error ? lastUnsupported.message : String(lastUnsupported)}`,
    );
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

  private async send(
    req: ChatRequest,
    onEvent: (e: StreamEvent) => void,
    token: CancelToken,
    forceRefresh: boolean,
  ): Promise<ChatTurn> {
    const accessToken = await this.getAccessToken(forceRefresh);
    const accountId = this.getAccountId();

    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "OpenAI-Beta": "responses=experimental",
      originator: "codex_cli_rs",
    };
    if (accountId) headers["chatgpt-account-id"] = accountId;

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
