import { abortSignalFor, readSse, throwHttpError } from "./sse";
import {
  LlmCancelledError,
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

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

/**
 * OAuth-mode inference is gated to Claude-Code-shaped traffic: the identity line
 * must lead the system prompt or requests are rejected. See README for the
 * terms-of-service caveats around reusing the first-party OAuth client.
 */
const CLAUDE_CODE_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";

export type AnthropicAuth =
  | { kind: "apiKey"; apiKey: string }
  | { kind: "oauth"; getAccessToken: (forceRefresh?: boolean) => Promise<string> };

interface AnthropicBlock {
  type: string;
  [key: string]: unknown;
}

export class AnthropicClient implements LlmClient {
  constructor(
    readonly id: ProviderId,
    readonly model: string,
    private readonly auth: AnthropicAuth,
  ) {}

  async chat(
    req: ChatRequest,
    onEvent: (e: StreamEvent) => void,
    token: CancelToken,
  ): Promise<ChatTurn> {
    // A 401 mid-run usually means the access token expired; refresh once and retry.
    try {
      return await this.send(req, onEvent, token, false);
    } catch (err) {
      if (this.auth.kind === "oauth" && isUnauthorized(err)) {
        return await this.send(req, onEvent, token, true);
      }
      throw err;
    }
  }

  private async send(
    req: ChatRequest,
    onEvent: (e: StreamEvent) => void,
    token: CancelToken,
    forceRefresh: boolean,
  ): Promise<ChatTurn> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": API_VERSION,
    };

    const systemBlocks: AnthropicBlock[] = [];
    if (this.auth.kind === "oauth") {
      const accessToken = await this.auth.getAccessToken(forceRefresh);
      headers["authorization"] = `Bearer ${accessToken}`;
      headers["anthropic-beta"] = "oauth-2025-04-20";
      systemBlocks.push({ type: "text", text: CLAUDE_CODE_IDENTITY });
    } else {
      headers["x-api-key"] = this.auth.apiKey;
    }

    // The repo map + methodology are byte-stable for the whole run, so caching
    // the system prefix makes the 40-iteration transcript replay affordable.
    systemBlocks.push({
      type: "text",
      text: req.system,
      cache_control: { type: "ephemeral" },
    });

    const body = {
      model: req.model,
      max_tokens: req.maxTokens,
      system: systemBlocks,
      messages: toAnthropicMessages(req.messages),
      tools: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      })),
      output_config: { effort: "high" },
      stream: true,
    };

    const abort = abortSignalFor(token);
    let response: Response;
    try {
      response = await fetch(API_URL, {
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
    const blocks: AnthropicBlock[] = [];
    const jsonBuffers = new Map<number, string>();
    let text = "";
    let stopReason: StopReason = "end";
    let detail: string | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;

    for await (const msg of readSse(response, token)) {
      let payload: any;
      try {
        payload = JSON.parse(msg.data);
      } catch {
        continue;
      }

      switch (payload.type) {
        case "message_start": {
          const usage = payload.message?.usage;
          if (usage) {
            // Cache *creation* is billed at a premium and cache *reads* at a
            // fraction, so the read half is tracked apart from the rest — the
            // budget charges it at what it actually costs.
            cachedInputTokens = usage.cache_read_input_tokens ?? 0;
            inputTokens =
              (usage.input_tokens ?? 0) +
              (usage.cache_creation_input_tokens ?? 0) +
              cachedInputTokens;
          }
          break;
        }
        case "content_block_start": {
          const block = payload.content_block as AnthropicBlock;
          blocks[payload.index] = { ...block };
          if (block.type === "tool_use") {
            jsonBuffers.set(payload.index, "");
            onEvent({ type: "toolCallStart", name: String(block.name ?? "") });
          }
          break;
        }
        case "content_block_delta": {
          const delta = payload.delta;
          const idx: number = payload.index;
          if (delta?.type === "text_delta") {
            text += delta.text;
            const existing = blocks[idx];
            if (existing) existing.text = String(existing.text ?? "") + delta.text;
            onEvent({ type: "text", delta: delta.text });
          } else if (delta?.type === "input_json_delta") {
            jsonBuffers.set(idx, (jsonBuffers.get(idx) ?? "") + delta.partial_json);
          } else if (delta?.type === "thinking_delta") {
            const existing = blocks[idx];
            if (existing) {
              existing.thinking = String(existing.thinking ?? "") + delta.thinking;
            }
          } else if (delta?.type === "signature_delta") {
            const existing = blocks[idx];
            if (existing) {
              existing.signature = String(existing.signature ?? "") + delta.signature;
            }
          }
          break;
        }
        case "content_block_stop": {
          const idx: number = payload.index;
          const buffered = jsonBuffers.get(idx);
          if (buffered !== undefined) {
            const block = blocks[idx];
            if (block) {
              try {
                block.input = buffered.length > 0 ? JSON.parse(buffered) : {};
              } catch {
                block.input = {};
              }
            }
            jsonBuffers.delete(idx);
          }
          break;
        }
        case "message_delta": {
          const reason = payload.delta?.stop_reason;
          if (reason) stopReason = mapStopReason(reason);
          if (payload.delta?.stop_details) {
            detail =
              payload.delta.stop_details.explanation ??
              payload.delta.stop_details.category ??
              undefined;
          }
          if (payload.usage?.output_tokens != null) {
            outputTokens = payload.usage.output_tokens;
          }
          break;
        }
        case "error": {
          stopReason = "error";
          detail = payload.error?.message ?? "Unknown streaming error";
          break;
        }
        default:
          break;
      }
    }

    onEvent({ type: "usage", inputTokens, outputTokens, cachedInputTokens });

    const content = blocks.filter(Boolean);
    const toolCalls: ToolCall[] = content
      .filter((b) => b.type === "tool_use")
      .map((b) => ({
        callId: String(b.id),
        name: String(b.name),
        input: b.input ?? {},
      }));

    return {
      text,
      toolCalls,
      stopReason,
      usage: { inputTokens, outputTokens },
      detail,
      raw: content,
    };
  }
}

function mapStopReason(reason: string): StopReason {
  switch (reason) {
    case "tool_use":
      return "toolUse";
    case "max_tokens":
      return "maxTokens";
    case "refusal":
      return "refusal";
    case "end_turn":
    case "stop_sequence":
      return "end";
    default:
      return "end";
  }
}

function toAnthropicMessages(messages: NeutralMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "user") {
      return { role: "user", content: [{ type: "text", text: m.text }] };
    }
    if (m.role === "assistant") {
      // Replay the native blocks so thinking signatures survive the round trip.
      if (Array.isArray(m.raw) && m.raw.length > 0) {
        return { role: "assistant", content: m.raw };
      }
      const content: AnthropicBlock[] = [];
      if (m.text) content.push({ type: "text", text: m.text });
      for (const call of m.toolCalls ?? []) {
        content.push({
          type: "tool_use",
          id: call.callId,
          name: call.name,
          input: call.input,
        });
      }
      return { role: "assistant", content };
    }
    // All tool results for a turn go back in a single user message; splitting
    // them trains the model out of parallel tool calls.
    return {
      role: "user",
      content: m.results.map((r) => ({
        type: "tool_result",
        tool_use_id: r.callId,
        content: r.content,
        ...(r.isError ? { is_error: true } : {}),
      })),
    };
  });
}

function isUnauthorized(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status: unknown }).status === 401
  );
}
