/**
 * The ChatGPT web backend, driven with the user's own session token.
 *
 * This is the endpoint the chatgpt.com UI itself calls. Unlike the Codex
 * surface it needs no paid entitlement, which is the whole reason it exists
 * here — a free ChatGPT account can run a review through it.
 *
 * It is experimental, and honestly so:
 *
 * - The endpoint is undocumented. It changes without notice and this client
 *   breaks when it does.
 * - Automated use of the consumer service is against OpenAI's terms. The
 *   realistic consequence lands on the account holder, which is why connecting
 *   requires an explicit acknowledgement rather than a quiet paste box.
 * - There is no native tool calling, so the whole engine rides
 *   `textToolProtocol` — the model writes tool calls as fenced blocks and we
 *   parse them back. That is materially less reliable than a real tool API.
 * - OpenAI gates the endpoint with an anti-automation challenge. This client
 *   does not attempt to solve it: if the challenge is enforced, the request
 *   fails with an explanation instead of a workaround.
 *
 * Prefer literally any other provider. This is the floor, not a recommendation.
 */

import { abortSignalFor, readSse } from "./sse";
import {
  parseToolCalls,
  renderMalformedNudge,
  renderToolInstructions,
  renderToolResults,
} from "./textToolProtocol";
import {
  LlmCancelledError,
  LlmHttpError,
  type CancelToken,
  type ChatRequest,
  type ChatTurn,
  type LlmClient,
  type NeutralMessage,
  type ProviderId,
  type StreamEvent,
} from "./types";

const CONVERSATION_URL = "https://chatgpt.com/backend-api/conversation";

export interface ChatGptWebOptions {
  /** The account's session access token, pasted by the user. */
  getAccessToken: () => Promise<string | undefined>;
}

export class ChatGptWebClient implements LlmClient {
  private turn = 0;

  constructor(
    readonly id: ProviderId,
    readonly model: string,
    private readonly options: ChatGptWebOptions,
  ) {}

  async chat(
    req: ChatRequest,
    onEvent: (e: StreamEvent) => void,
    token: CancelToken,
  ): Promise<ChatTurn> {
    const accessToken = await this.options.getAccessToken();
    if (!accessToken) {
      throw new Error(
        "No ChatGPT session token is stored. Connect the account again to paste a fresh one.",
      );
    }

    // The endpoint keeps conversation state server-side, but the engine already
    // re-sends its whole transcript each turn and compacts it. Flattening to a
    // single message keeps this client stateless and means the compaction work
    // still pays off here.
    const prompt = flattenTranscript(req);

    const body = {
      action: "next",
      messages: [
        {
          id: crypto.randomUUID(),
          author: { role: "user" },
          content: { content_type: "text", parts: [prompt] },
        },
      ],
      model: this.model,
      parent_message_id: crypto.randomUUID(),
      history_and_training_disabled: true,
    };

    const abort = abortSignalFor(token);
    let response: Response;
    try {
      response = await fetch(CONVERSATION_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${accessToken}`,
          accept: "text/event-stream",
        },
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
      throw await describeFailure(response);
    }

    try {
      return await this.consume(response, onEvent, token);
    } finally {
      abort.dispose();
    }
  }

  /**
   * Reads the reply, then recovers the tool calls from its text.
   *
   * The stream sends the whole message so far on each event rather than a
   * delta, so progress is reported as the difference against what was already
   * seen — otherwise the sidebar would show the reply repeated dozens of times.
   */
  private async consume(
    response: Response,
    onEvent: (e: StreamEvent) => void,
    token: CancelToken,
  ): Promise<ChatTurn> {
    let full = "";

    for await (const msg of readSse(response, token)) {
      if (msg.data === "[DONE]") break;
      let payload: {
        message?: { content?: { parts?: unknown[] }; author?: { role?: string } };
        error?: unknown;
      };
      try {
        payload = JSON.parse(msg.data);
      } catch {
        continue;
      }
      if (payload.error) {
        throw new Error(`ChatGPT returned an error: ${JSON.stringify(payload.error)}`);
      }
      if (payload.message?.author?.role !== "assistant") continue;

      const parts = payload.message.content?.parts ?? [];
      const text = parts.filter((p): p is string => typeof p === "string").join("");
      if (text.length > full.length) {
        onEvent({ type: "text", delta: text.slice(full.length) });
        full = text;
      }
    }

    const parsed = parseToolCalls(full, `web-${++this.turn}`);
    for (const call of parsed.toolCalls) {
      onEvent({ type: "toolCallStart", name: call.name });
    }

    // The endpoint reports no token usage — it is a subscription surface, not a
    // metered one. Estimating from characters keeps the budget meter honest
    // rather than showing a run that appears to cost nothing.
    const estimated = Math.ceil(full.length / 4);
    onEvent({ type: "usage", inputTokens: 0, outputTokens: estimated });

    if (parsed.toolCalls.length === 0 && parsed.malformed.length > 0) {
      // Surfaced as text so the loop's own "no tool calls" nudge carries the
      // reason the blocks were rejected.
      return {
        text: `${parsed.text}\n\n${renderMalformedNudge(parsed.malformed)}`,
        toolCalls: [],
        stopReason: "end",
        usage: { inputTokens: 0, outputTokens: estimated },
      };
    }

    return {
      text: parsed.text,
      toolCalls: parsed.toolCalls,
      stopReason: parsed.toolCalls.length > 0 ? "toolUse" : "end",
      usage: { inputTokens: 0, outputTokens: estimated },
    };
  }
}

/**
 * Renders the neutral transcript as one prompt.
 *
 * The tool instructions lead, because a model that has forgotten the block
 * format produces prose that runs nothing.
 */
function flattenTranscript(req: ChatRequest): string {
  const sections: string[] = [req.system, renderToolInstructions(req.tools)];

  for (const message of req.messages) {
    sections.push(renderMessage(message));
  }
  return sections.filter((s) => s.trim().length > 0).join("\n\n---\n\n");
}

function renderMessage(message: NeutralMessage): string {
  if (message.role === "user") return message.text;
  if (message.role === "toolResult") return renderToolResults(message.results);

  const parts: string[] = [];
  if (message.text) parts.push(message.text);
  // Replayed as the block syntax the model was taught, so its own prior calls
  // read back the same way it was asked to write them.
  for (const call of message.toolCalls ?? []) {
    parts.push("```tool\n" + JSON.stringify({ name: call.name, input: call.input }) + "\n```");
  }
  return parts.join("\n\n");
}

/** Turns an HTTP failure into something that says what to actually do. */
async function describeFailure(response: Response): Promise<Error> {
  const body = await response.text().catch(() => "");

  if (response.status === 401 || response.status === 403) {
    // Cloudflare and the sentinel challenge both land here, and they are the
    // expected outcome rather than a bug — say so instead of implying a retry
    // will help.
    const challenged = /cloudflare|just a moment|sentinel|proof|challenge/i.test(body);
    return new Error(
      challenged
        ? "ChatGPT (web) blocked the request with an anti-automation challenge. " +
          "IronBase does not work around that check. Use a different provider — " +
          "Ollama, Groq, Gemini and Kimi all have free options that work properly."
        : "The ChatGPT session token was rejected. It expires quickly — reconnect " +
          "the account to paste a fresh one, or use a different provider.",
    );
  }
  if (response.status === 429) {
    return new LlmHttpError(429, body || "ChatGPT (web) rate limited this account.");
  }
  return new LlmHttpError(response.status, body);
}
