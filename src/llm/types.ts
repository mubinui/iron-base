/**
 * Provider-neutral LLM interface. The agent engine only ever sees these shapes;
 * each client in this folder translates to and from its provider's wire format.
 */

/** Account sign-ins only — IronBase never asks for an API key. */
export type ProviderId = "anthropic-oauth" | "chatgpt-oauth" | "gemini-oauth";

export const ALL_PROVIDERS: ProviderId[] = [
  "anthropic-oauth",
  "chatgpt-oauth",
  "gemini-oauth",
];

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  "anthropic-oauth": "Claude",
  "chatgpt-oauth": "ChatGPT",
  "gemini-oauth": "Gemini",
};

export const PROVIDER_DETAILS: Record<ProviderId, string> = {
  "anthropic-oauth": "Claude Pro or Max subscription",
  "chatgpt-oauth": "ChatGPT Plus or Pro subscription",
  "gemini-oauth": "Google account, free tier included",
};

export const DEFAULT_MODELS: Record<ProviderId, string> = {
  "anthropic-oauth": "claude-opus-5",
  "chatgpt-oauth": "gpt-5-codex",
  "gemini-oauth": "gemini-2.5-pro",
};

export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
}

export interface ToolCall {
  callId: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  callId: string;
  name: string;
  content: string;
  isError?: boolean;
}

export type NeutralMessage =
  | { role: "user"; text: string }
  | {
      role: "assistant";
      text?: string;
      toolCalls?: ToolCall[];
      /**
       * Provider-native content blocks for this turn, when the provider needs
       * them replayed verbatim. Anthropic models require thinking blocks to be
       * echoed back unmodified on the next turn, and synthesizing them from
       * `text` + `toolCalls` would drop the signature and 400.
       */
      raw?: unknown;
    }
  | { role: "toolResult"; results: ToolResult[] };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export type StopReason = "end" | "toolUse" | "maxTokens" | "refusal" | "error";

export interface ChatTurn {
  text: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  usage: Usage;
  /** Populated when stopReason is "refusal" or "error". */
  detail?: string;
  /** Provider-native content blocks, replayed verbatim on the next turn. */
  raw?: unknown;
}

export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "toolCallStart"; name: string }
  | { type: "usage"; inputTokens: number; outputTokens: number };

export interface ChatRequest {
  /** Stable across a run — cached where the provider supports prompt caching. */
  system: string;
  messages: NeutralMessage[];
  tools: ToolDef[];
  maxTokens: number;
  model: string;
}

export interface CancelToken {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface LlmClient {
  readonly id: ProviderId;
  readonly model: string;
  chat(
    req: ChatRequest,
    onEvent: (e: StreamEvent) => void,
    token: CancelToken,
  ): Promise<ChatTurn>;
}

/** Thrown for HTTP-level failures so callers can react to 401/429 specifically. */
export class LlmHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(`HTTP ${status}: ${body.slice(0, 400)}`);
    this.name = "LlmHttpError";
  }
}

export class LlmCancelledError extends Error {
  constructor() {
    super("Request cancelled");
    this.name = "LlmCancelledError";
  }
}
