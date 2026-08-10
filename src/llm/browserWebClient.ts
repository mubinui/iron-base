/**
 * Driving a provider's consumer web backend from inside the signed-in browser.
 *
 * The counterpart to `chatgptWebClient`, for the providers whose backend a bare
 * request from the extension host cannot reach — grok.com behind Cloudflare is
 * the case that forced this. Instead of sending the request from Node, it hands
 * the request to `BrowserSession`, which runs it inside the live page; the
 * cookies, the origin and the browser context are all real, so nothing has to
 * be forged to get through. See `browserSession.ts` and the header of
 * `webSessions.ts` for where that line is drawn.
 *
 * Everything provider-specific — the endpoint, the request body, and how to read
 * tokens out of the reply — lives in a small `BrowserAdapter`. The adapters are
 * best-effort against undocumented endpoints that change without notice, which
 * is why the transport is ranked last in failover and gated behind an explicit
 * acknowledgement. What can be tested without a browser (the stream parsing) is
 * a pure function, and is.
 */

import type { BrowserSession, InPageRequest } from "../auth/browserSession";
import { looksLikeHtml } from "./sse";
import {
  parseToolCalls,
  renderMalformedNudge,
  renderToolInstructions,
  renderToolResults,
} from "./textToolProtocol";
import {
  LlmCancelledError,
  LlmHttpError,
  PROVIDER_SIGNUP,
  type CancelToken,
  type ChatRequest,
  type ChatTurn,
  type LlmClient,
  type NeutralMessage,
  type ProviderId,
  type StreamEvent,
} from "./types";

/** What a provider's consumer backend needs, and how to read what it sends. */
export interface BrowserAdapter {
  origin: string;
  /** Builds the one request that sends `prompt` and streams a reply. */
  buildRequest(prompt: string, model: string): InPageRequest;
  /**
   * The assistant text present in the raw stream so far.
   *
   * Called on the whole accumulated buffer each time more arrives, and returns
   * the full text to date; the client emits the delta against what it last saw.
   * Pure and total — an incomplete trailing line is simply ignored until the
   * rest of it lands.
   */
  extractText(raw: string): string;
}

/** grok.com's web backend. Schema per the reverse-engineered browser calls. */
export const grokAdapter: BrowserAdapter = {
  origin: "https://grok.com",
  buildRequest(prompt) {
    return {
      url: "https://grok.com/rest/app-chat/conversations/new",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: {
        temporary: true,
        // The web app's own model id, which is not the API's. Kept fixed to the
        // flagship rather than passed through, because the picker's ids
        // (grok-4-fast, grok-code-fast-1) are API names the web backend rejects.
        modelName: "grok-4",
        message: prompt,
        fileAttachments: [],
        imageAttachments: [],
        disableSearch: false,
        enableImageGeneration: false,
        returnImageBytes: false,
        returnRawGrokInXaiRequest: false,
        enableImageStreaming: false,
        imageGenerationCount: 0,
        forceConcise: false,
        toolOverrides: {},
        enableSideBySide: false,
        isPreset: false,
        sendFinalMetadata: true,
        customInstructions: "",
        deepsearchPreset: "",
        isReasoning: false,
      },
    };
  },
  extractText: extractGrokText,
};

/**
 * Folds grok.com's NDJSON stream into the assistant text so far.
 *
 * Each complete line is a JSON object; token deltas arrive at
 * `result.response.token` and are concatenated, and a terminal line carries the
 * whole message at `result.response.modelResponse.message`, which wins when it
 * appears. A partial trailing line (no newline yet) is left for next time.
 */
export function extractGrokText(raw: string): string {
  const lastNewline = raw.lastIndexOf("\n");
  const complete = lastNewline === -1 ? "" : raw.slice(0, lastNewline);
  let text = "";
  for (const line of complete.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const response = (parsed as GrokLine)?.result?.response;
    if (!response) continue;
    const final = response.modelResponse?.message;
    if (typeof final === "string") return final;
    if (typeof response.token === "string") text += response.token;
  }
  return text;
}

interface GrokLine {
  result?: { response?: { token?: unknown; modelResponse?: { message?: unknown } } };
}

const ADAPTERS: Partial<Record<ProviderId, BrowserAdapter>> = {
  xai: grokAdapter,
};

export function browserAdapterFor(id: ProviderId): BrowserAdapter | undefined {
  return ADAPTERS[id];
}

export interface BrowserWebOptions {
  session: BrowserSession;
  adapter?: BrowserAdapter;
}

export class BrowserWebClient implements LlmClient {
  private turn = 0;

  constructor(
    readonly id: ProviderId,
    readonly model: string,
    private readonly options: BrowserWebOptions,
  ) {}

  async chat(
    req: ChatRequest,
    onEvent: (e: StreamEvent) => void,
    token: CancelToken,
  ): Promise<ChatTurn> {
    const adapter = this.options.adapter;
    if (!adapter) {
      // The login works and the account shows connected, but this provider's
      // chat endpoint has not been wired for browser-backed use. Say so, and
      // point at the path that does work, rather than failing obscurely.
      const key = PROVIDER_SIGNUP[this.id];
      throw new Error(
        `Signing in to ${this.id} works, but running builds through its web app is not wired up yet. ` +
          `Connect ${this.id} with its API key instead${key ? ` (${key})` : ""}.`,
      );
    }

    const prompt = flattenTranscript(req);
    const request = adapter.buildRequest(prompt, this.model);

    const controller = new AbortController();
    const cancelSub = token.onCancellationRequested(() => controller.abort());

    let raw = "";
    let emitted = "";
    const onChunk = (chunk: string): void => {
      raw += chunk;
      const full = adapter.extractText(raw);
      if (full.length > emitted.length) {
        onEvent({ type: "text", delta: full.slice(emitted.length) });
        emitted = full;
      }
    };

    let result;
    try {
      result = await this.options.session.stream(
        adapter.origin,
        request,
        onChunk,
        controller.signal,
      );
    } catch (err) {
      if (token.isCancellationRequested) throw new LlmCancelledError();
      throw err;
    } finally {
      cancelSub.dispose();
    }

    if (!result.ok) throw describeFailure(this.id, result.status, result.errorText ?? "");

    // A 200 is not proof the request got through. A Cloudflare interstitial is
    // served with a 200 and an HTML body, so `result.ok` passes and the stream
    // is a challenge page rather than the model's reply. Left alone this folds
    // to empty text and looks like the model said nothing; caught here it says
    // what actually happened, and points at the key that avoids it.
    if (looksLikeHtml(raw)) throw describeFailure(this.id, 403, raw);

    // One more fold, in case the last line closed the message.
    const full = adapter.extractText(raw.endsWith("\n") ? raw : raw + "\n");
    if (full.length > emitted.length) {
      onEvent({ type: "text", delta: full.slice(emitted.length) });
      emitted = full;
    }

    const parsed = parseToolCalls(full, `browser-${this.id}-${++this.turn}`);
    for (const call of parsed.toolCalls) onEvent({ type: "toolCallStart", name: call.name });

    // These backends report no token usage, so it is estimated from length to
    // keep the budget meter honest rather than showing a free-looking run.
    const estimated = Math.ceil(full.length / 4);
    onEvent({ type: "usage", inputTokens: 0, outputTokens: estimated });
    const usage = { inputTokens: 0, outputTokens: estimated };

    if (parsed.toolCalls.length === 0 && parsed.malformed.length > 0) {
      return {
        text: `${parsed.text}\n\n${renderMalformedNudge(parsed.malformed)}`,
        toolCalls: [],
        stopReason: "end",
        usage,
      };
    }

    return {
      text: parsed.text,
      toolCalls: parsed.toolCalls,
      stopReason: parsed.toolCalls.length > 0 ? "toolUse" : "end",
      usage,
    };
  }
}

/** Flattens the neutral transcript to one prompt, tool instructions leading. */
function flattenTranscript(req: ChatRequest): string {
  const sections: string[] = [req.system, renderToolInstructions(req.tools, req.task)];
  for (const message of req.messages) sections.push(renderMessage(message, req));
  return sections.filter((s) => s.trim().length > 0).join("\n\n---\n\n");
}

function renderMessage(message: NeutralMessage, req: ChatRequest): string {
  if (message.role === "user") return message.text;
  if (message.role === "toolResult") return renderToolResults(message.results, req.task);

  const parts: string[] = [];
  if (message.text) parts.push(message.text);
  for (const call of message.toolCalls ?? []) {
    parts.push("```tool\n" + JSON.stringify({ name: call.name, input: call.input }) + "\n```");
  }
  return parts.join("\n\n");
}

/** Turns an HTTP failure into something that says what to actually do. */
function describeFailure(id: ProviderId, status: number, body: string): Error {
  if (status === 401 || status === 403) {
    const challenged = /cloudflare|just a moment|challenge|captcha|attention required/i.test(body);
    return new LlmHttpError(
      status,
      challenged
        ? `${id} blocked the request with an anti-automation challenge. Clear it yourself in ` +
            `the sign-in window if one is open, or use this provider's API key. IronBase does ` +
            `not work around that check.`
        : `${id} rejected the session — sign in again to refresh it.`,
    );
  }
  if (status === 429) return new LlmHttpError(429, body || `${id} rate limited this account.`);
  return new LlmHttpError(status, body);
}
