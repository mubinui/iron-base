/**
 * Provider-neutral LLM interface. The agent engine only ever sees these shapes;
 * each client in this folder translates to and from its provider's wire format.
 */

/**
 * Every backend a review can run on.
 *
 * Three connect with the account the user already has, two take an API key, and
 * one talks to a model running on their own machine. They are all equal here:
 * the engine only ever sees `LlmClient`, so which one is active is a runtime
 * choice the user can change without restarting anything.
 */
export type ProviderId =
  | "anthropic-oauth"
  | "chatgpt-oauth"
  | "chatgpt-web"
  | "gemini-oauth"
  | "openai"
  | "xai"
  | "openrouter"
  | "groq"
  | "mistral"
  | "kimi"
  | "deepseek"
  | "ollama";

export const ALL_PROVIDERS: ProviderId[] = [
  "anthropic-oauth",
  "chatgpt-oauth",
  "chatgpt-web",
  "gemini-oauth",
  "openai",
  "xai",
  "openrouter",
  "groq",
  "mistral",
  "kimi",
  "deepseek",
  "ollama",
];

/** How a provider proves who you are, which decides its whole sign-in flow. */
export type CredentialKind = "oauth" | "apiKey" | "local";

export const PROVIDER_CREDENTIALS: Record<ProviderId, CredentialKind> = {
  "anthropic-oauth": "oauth",
  "chatgpt-oauth": "oauth",
  "chatgpt-web": "apiKey",
  "gemini-oauth": "oauth",
  openai: "apiKey",
  xai: "apiKey",
  openrouter: "apiKey",
  groq: "apiKey",
  mistral: "apiKey",
  kimi: "apiKey",
  deepseek: "apiKey",
  ollama: "local",
};

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  "anthropic-oauth": "Claude",
  "chatgpt-oauth": "ChatGPT",
  "chatgpt-web": "ChatGPT (web)",
  "gemini-oauth": "Gemini",
  openai: "OpenAI",
  xai: "Grok",
  openrouter: "OpenRouter",
  groq: "Groq",
  mistral: "Mistral",
  kimi: "Kimi",
  deepseek: "DeepSeek",
  ollama: "Ollama",
};

/**
 * Shown directly beneath the provider's name in both the sidebar cards and the
 * picker, so these deliberately do not repeat it — "Claude / Claude Pro or Max
 * subscription" reads as a stutter.
 */
export const PROVIDER_DETAILS: Record<ProviderId, string> = {
  "anthropic-oauth": "Pro or Max subscription",
  // Codex access is an entitlement of the plan, not of every ChatGPT account —
  // saying so here saves a failed run and a confusing error.
  "chatgpt-oauth": "Plus or Pro subscription with Codex access",
  "chatgpt-web": "Free account \u2014 experimental, against OpenAI\u2019s terms",
  "gemini-oauth": "Google account, free tier included",
  openai: "Platform API key — billed separately from ChatGPT",
  xai: "xAI API key, for Grok",
  openrouter: "One key, most models — Grok, Llama, Qwen, Claude",
  groq: "Free API key, very fast inference",
  mistral: "Mistral API key, free tier included",
  kimi: "Moonshot API key, free tier included",
  deepseek: "API key, pay as you go",
  ollama: "Models on this machine, no account",
};

/** Where to get a key, shown when a provider needs one. */
export const PROVIDER_SIGNUP: Partial<Record<ProviderId, string>> = {
  openai: "https://platform.openai.com/api-keys",
  xai: "https://console.x.ai",
  openrouter: "https://openrouter.ai/keys",
  groq: "https://console.groq.com/keys",
  mistral: "https://console.mistral.ai/api-keys",
  kimi: "https://platform.moonshot.ai/console/api-keys",
  deepseek: "https://platform.deepseek.com/api_keys",
  ollama: "https://ollama.com/download",
};

export const DEFAULT_MODELS: Record<ProviderId, string> = {
  "anthropic-oauth": "claude-opus-5",
  "chatgpt-oauth": "gpt-5.1-codex",
  "gemini-oauth": "gemini-2.5-pro",
  "chatgpt-web": "auto",
  openai: "gpt-5.1",
  xai: "grok-4",
  openrouter: "x-ai/grok-4",
  groq: "llama-3.3-70b-versatile",
  mistral: "mistral-large-latest",
  kimi: "kimi-k2-thinking",
  deepseek: "deepseek-reasoner",
  // Only a starting point — whatever is actually pulled locally wins, because
  // asking for a model that is not installed is a 404 rather than a fallback.
  ollama: "qwen3-coder:30b",
};

/**
 * Base URLs for the providers that speak the OpenAI chat-completions dialect.
 * Ollama's is overridable because people move it off the default port.
 */
export type OpenAiCompatibleProvider =
  | "openai"
  | "xai"
  | "openrouter"
  | "groq"
  | "mistral"
  | "kimi"
  | "deepseek"
  | "ollama";

export const OPENAI_COMPATIBLE_BASES: Record<OpenAiCompatibleProvider, string> = {
  openai: "https://api.openai.com/v1",
  xai: "https://api.x.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai/v1",
  kimi: "https://api.moonshot.ai/v1",
  deepseek: "https://api.deepseek.com/v1",
  ollama: "http://127.0.0.1:11434/v1",
};

/** True for providers reached over the OpenAI chat-completions dialect. */
export function isOpenAiCompatible(id: ProviderId): id is OpenAiCompatibleProvider {
  return id in OPENAI_COMPATIBLE_BASES;
}

export interface ModelChoice {
  id: string;
  label: string;
  note: string;
}

/**
 * What the model picker offers per provider. Which of these an account may
 * actually use is an entitlement question the provider answers at request time,
 * so "Automatic" stays the default — it negotiates rather than guessing.
 */
export const MODEL_CHOICES: Record<ProviderId, ModelChoice[]> = {
  "anthropic-oauth": [
    { id: "claude-opus-5", label: "Claude Opus 5", note: "Most capable" },
    { id: "claude-opus-4-8", label: "Claude Opus 4.8", note: "Previous Opus" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5", note: "Faster, cheaper" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", note: "Fastest" },
  ],
  "chatgpt-oauth": [
    { id: "gpt-5.2-codex", label: "GPT-5.2 Codex", note: "Coding-tuned" },
    { id: "gpt-5.1-codex", label: "GPT-5.1 Codex", note: "Coding-tuned" },
    { id: "gpt-5.1-codex-mini", label: "GPT-5.1 Codex Mini", note: "Cheapest" },
    { id: "gpt-5-codex", label: "GPT-5 Codex", note: "Previous Codex" },
    { id: "gpt-5.1", label: "GPT-5.1", note: "General" },
  ],
  // The web endpoint picks the model from the account's own entitlement, so
  // there is nothing meaningful to choose between.
  "chatgpt-web": [{ id: "auto", label: "Whatever the account allows", note: "Not selectable" }],
  "gemini-oauth": [
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", note: "Most capable" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", note: "Faster, higher quota" },
  ],
  // The OpenAI platform API, which is billed per token and is entirely separate
  // from a ChatGPT subscription — unlike the Codex path, it has no entitlement
  // to negotiate, so any model the key can reach simply works.
  openai: [
    { id: "gpt-5.2", label: "GPT-5.2", note: "Most capable" },
    { id: "gpt-5.1", label: "GPT-5.1", note: "Previous flagship" },
    { id: "gpt-5.1-codex", label: "GPT-5.1 Codex", note: "Coding-tuned" },
    { id: "gpt-5-mini", label: "GPT-5 Mini", note: "Cheapest" },
  ],
  xai: [
    { id: "grok-4", label: "Grok 4", note: "Most capable" },
    { id: "grok-4-fast", label: "Grok 4 Fast", note: "Faster, cheaper" },
    { id: "grok-code-fast-1", label: "Grok Code Fast", note: "Coding-tuned" },
  ],
  // One key, many vendors — the pragmatic way to reach a model this build does
  // not list. Ids are `vendor/model`, and the picker fetches the live catalogue.
  openrouter: [
    { id: "x-ai/grok-4", label: "Grok 4", note: "via OpenRouter" },
    { id: "anthropic/claude-opus-4.5", label: "Claude Opus 4.5", note: "via OpenRouter" },
    { id: "qwen/qwen3-coder", label: "Qwen3 Coder", note: "Coding-tuned" },
    { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B", note: "Open weights" },
  ],
  groq: [
    { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B", note: "Fast" },
    { id: "qwen-2.5-coder-32b", label: "Qwen2.5 Coder 32B", note: "Coding-tuned" },
  ],
  mistral: [
    { id: "mistral-large-latest", label: "Mistral Large", note: "Most capable" },
    { id: "codestral-latest", label: "Codestral", note: "Coding-tuned" },
  ],
  kimi: [
    { id: "kimi-k2-thinking", label: "Kimi K2 Thinking", note: "Most capable" },
    { id: "kimi-k2-0905-preview", label: "Kimi K2", note: "Faster" },
    { id: "moonshot-v1-128k", label: "Moonshot v1 128k", note: "Long context" },
  ],
  deepseek: [
    { id: "deepseek-reasoner", label: "DeepSeek Reasoner", note: "Most capable" },
    { id: "deepseek-chat", label: "DeepSeek Chat", note: "Faster, cheaper" },
  ],
  // Whatever is pulled locally wins over this list; it is only a starting point
  // for a machine that has nothing installed yet.
  ollama: [
    { id: "qwen3-coder:30b", label: "Qwen3 Coder 30B", note: "Best local for code" },
    { id: "qwen3:14b", label: "Qwen3 14B", note: "Fits in 16GB" },
    { id: "llama3.3:70b", label: "Llama 3.3 70B", note: "Needs 48GB+" },
    { id: "deepseek-r1:14b", label: "DeepSeek R1 14B", note: "Reasoning, local" },
  ],
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
      /**
       * Which provider produced this turn. Only meaningful alongside `raw`:
       * those blocks are one provider's private format, so replaying them to a
       * different provider is guaranteed to fail. Switching mid-run drops them.
       */
      producedBy?: ProviderId;
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
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      /**
       * The part of `inputTokens` served from the provider's prompt cache.
       *
       * Reported separately because a cached token bills at roughly a tenth of a
       * fresh one. Counting the two the same makes a run that is caching well
       * look like a run that is burning its budget.
       */
      cachedInputTokens?: number;
    };

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
