/**
 * One client for every backend that speaks the OpenAI chat-completions dialect.
 *
 * Kimi, DeepSeek and Ollama all expose the same shape, so writing three clients
 * would be writing the same client three times. What differs between them is a
 * base URL, whether there is a key, and which models exist, and all three of
 * those are constructor arguments. A custom endpoint works for free.
 */

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

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  /**
   * Resolved per request rather than captured at construction: reading a secret
   * is async, and a key the user pastes mid-session then works immediately.
   * Absent for a local server that does not check one.
   */
  getApiKey?: () => Promise<string | undefined>;
  /**
   * Sent on every request to this backend. For endpoints that want a fixed
   * header rather than a secret — OpenCode's free tier identifies its client
   * and takes the literal bearer "public", neither of which is a credential.
   * A resolved `getApiKey` still wins, so a key can be layered on top.
   */
  headers?: Record<string, string>;
  /** Shown in errors so the user knows which backend refused. */
  label: string;
  /**
   * Local models are slower and smaller, so they get a shorter reply budget:
   * a 16k-token completion from a 30B model on a laptop takes minutes.
   */
  maxTokensCap?: number;
}

interface StreamingToolCall {
  id: string;
  name: string;
  args: string;
}

export class OpenAiCompatibleClient implements LlmClient {
  constructor(
    readonly id: ProviderId,
    readonly model: string,
    private readonly options: OpenAiCompatibleOptions,
  ) {}

  async chat(
    req: ChatRequest,
    onEvent: (e: StreamEvent) => void,
    token: CancelToken,
  ): Promise<ChatTurn> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      ...this.options.headers,
    };
    const apiKey = await this.options.getApiKey?.();
    if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;

    const body: Record<string, unknown> = {
      model: req.model,
      messages: toOpenAiMessages(req.system, req.messages),
      max_tokens: Math.min(req.maxTokens, this.options.maxTokensCap ?? req.maxTokens),
      stream: true,
      // Ask for usage on the final chunk; servers that do not know this field
      // ignore it, and the ones that do save us from estimating token spend.
      stream_options: { include_usage: true },
    };
    if (req.tools.length > 0) {
      body.tools = req.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
      body.tool_choice = "auto";
    }

    const abort = abortSignalFor(token);
    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: abort.signal,
      });
    } catch (err) {
      abort.dispose();
      if (token.isCancellationRequested) throw new LlmCancelledError();
      throw new Error(describeConnectionFailure(err, this.options));
    }

    if (!response.ok) {
      abort.dispose();
      await throwHttpError(response);
    }

    try {
      return await this.consume(response, onEvent, token);
    } finally {
      abort.dispose();
    }
  }

  private async consume(
    response: Response,
    onEvent: (e: StreamEvent) => void,
    token: CancelToken,
  ): Promise<ChatTurn> {
    let text = "";
    let stopReason: StopReason = "end";
    let inputTokens = 0;
    let outputTokens = 0;
    // Tool calls stream in fragments keyed by index, not by id: the name lands
    // in the first delta and the arguments accumulate across later ones.
    const partial = new Map<number, StreamingToolCall>();

    for await (const message of readSse(response, token)) {
      if (message.data === "[DONE]") break;
      let payload: any;
      try {
        payload = JSON.parse(message.data);
      } catch {
        continue;
      }

      if (payload.usage) {
        inputTokens = payload.usage.prompt_tokens ?? inputTokens;
        outputTokens = payload.usage.completion_tokens ?? outputTokens;
      }
      if (payload.error) {
        stopReason = "error";
        return {
          text,
          toolCalls: [],
          stopReason,
          usage: { inputTokens, outputTokens },
          detail: String(payload.error.message ?? payload.error),
        };
      }

      const choice = payload.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};

      if (typeof delta.content === "string" && delta.content.length > 0) {
        text += delta.content;
        onEvent({ type: "text", delta: delta.content });
      }
      // Reasoning models stream their scratchpad separately. It is worth showing
      // live, but it is not part of the answer and is never replayed.
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
        onEvent({ type: "text", delta: delta.reasoning_content });
      }

      for (const call of delta.tool_calls ?? []) {
        const index = typeof call.index === "number" ? call.index : 0;
        const existing = partial.get(index) ?? { id: "", name: "", args: "" };
        if (call.id) existing.id = String(call.id);
        if (call.function?.name) {
          existing.name = String(call.function.name);
          onEvent({ type: "toolCallStart", name: existing.name });
        }
        if (typeof call.function?.arguments === "string") {
          existing.args += call.function.arguments;
        }
        partial.set(index, existing);
      }

      if (choice.finish_reason === "length") stopReason = "maxTokens";
      else if (choice.finish_reason === "content_filter") stopReason = "refusal";
      else if (choice.finish_reason === "tool_calls") stopReason = "toolUse";
    }

    const toolCalls: ToolCall[] = [...partial.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, call]) => call.name.length > 0)
      .map(([index, call]) => ({
        callId: call.id || `call_${index}`,
        name: call.name,
        input: safeParse(call.args),
      }));

    if (toolCalls.length > 0 && stopReason === "end") stopReason = "toolUse";
    onEvent({ type: "usage", inputTokens, outputTokens });

    return { text, toolCalls, stopReason, usage: { inputTokens, outputTokens } };
  }
}

/**
 * Flattens the neutral transcript into OpenAI's message list.
 *
 * Provider-native `raw` blocks are deliberately ignored: this dialect has no
 * place to put them, and every field here is reconstructible from `text` and
 * `toolCalls`. That is also what makes these providers safe to switch to
 * mid-run, where a provider carrying opaque state would not be.
 */
function toOpenAiMessages(system: string, messages: NeutralMessage[]): unknown[] {
  const out: unknown[] = [{ role: "system", content: system }];

  for (const message of messages) {
    if (message.role === "user") {
      out.push({ role: "user", content: message.text });
      continue;
    }
    if (message.role === "assistant") {
      const entry: Record<string, unknown> = {
        role: "assistant",
        content: message.text ?? "",
      };
      if (message.toolCalls && message.toolCalls.length > 0) {
        entry.tool_calls = message.toolCalls.map((call) => ({
          id: call.callId,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
        }));
      }
      out.push(entry);
      continue;
    }
    for (const result of message.results) {
      out.push({
        role: "tool",
        tool_call_id: result.callId,
        content: result.content,
      });
    }
  }
  return out;
}

function safeParse(raw: string): unknown {
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * A local server that is not running is the single most common failure here,
 * and "fetch failed" tells the user nothing about what to do next.
 */
function describeConnectionFailure(err: unknown, options: OpenAiCompatibleOptions): string {
  const detail = err instanceof Error ? err.message : String(err);
  if (options.baseUrl.includes("127.0.0.1") || options.baseUrl.includes("localhost")) {
    return (
      `Could not reach ${options.label} at ${options.baseUrl}. ` +
      `Start it with \`ollama serve\`, check the model is pulled with \`ollama list\`, ` +
      `and set ironbase.ollama.baseUrl if it listens somewhere else. (${detail})`
    );
  }
  return `Could not reach ${options.label} at ${options.baseUrl}. (${detail})`;
}

/** Model ids the server actually has, used to populate the picker. */
export async function listOpenAiCompatibleModels(
  baseUrl: string,
  apiKey?: string,
  extraHeaders?: Record<string, string>,
): Promise<string[]> {
  const headers: Record<string, string> = { accept: "application/json", ...extraHeaders };
  if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;

  const response = await fetch(`${baseUrl}/models`, { method: "GET", headers });
  if (!response.ok) return [];
  // A model list is best-effort — the caller falls back to a default when it
  // comes back empty — so a body that is not JSON (an HTML page served with a
  // 200, which `response.ok` does not catch) means "offer nothing" rather than
  // a thrown parser error. `response.ok` alone is not enough of a guard here.
  const body = await response.text().catch(() => "");
  let json: { data?: Array<{ id?: unknown }> };
  try {
    json = JSON.parse(body);
  } catch {
    return [];
  }
  return (json.data ?? [])
    .map((entry) => entry.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .sort();
}
