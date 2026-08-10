/**
 * Provider-neutral LLM interface. The agent engine only ever sees these shapes;
 * each client in this folder translates to and from its provider's wire format.
 */

/**
 * Every backend a review can run on.
 *
 * Three connect with the account the user already has, several take an API key,
 * one needs no account at all, and two talk to something on their own machine.
 * They are all equal here: the engine only ever sees `LlmClient`, so which one
 * is active is a runtime choice the user can change without restarting anything.
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
  | "router"
  | "opencode"
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
  "router",
  "opencode",
  "ollama",
];

/** How a provider proves who you are, which decides its whole sign-in flow. */
export type CredentialKind = "oauth" | "apiKey" | "free" | "local";

/**
 * One way of proving who you are.
 *
 * `webSession` is the credential a consumer web login leaves behind — the same
 * kind of token `chatgpt-web` has always taken by hand. It is a *method*, not a
 * provider: the same account can usually be reached either by pasting a key or
 * by signing in, and which one is in play changes only where the credential came
 * from, never how the engine talks to the model.
 */
export type AuthMethod = "oauth" | "apiKey" | "webSession" | "free" | "local";

/**
 * Every way each provider can be connected, best-first.
 *
 * Order is the default precedence, and it is deliberate rather than cosmetic: a
 * subscription OAuth token refreshes itself, an API key does not expire, and a
 * captured web session dies in hours and often has no native tool calling. So a
 * provider holding two credentials should reach for the durable one, and only
 * fall to the session when that is all there is. `authMethodOverride` in
 * globalState lets a user say otherwise, per provider.
 *
 * Every provider lists `webSession` because the point of the capture flow is
 * that it works everywhere; whether a given provider's session actually reaches
 * a usable endpoint is answered at runtime by `WEB_SESSIONS`, not asserted here.
 */
export const PROVIDER_METHODS: Record<ProviderId, AuthMethod[]> = {
  "anthropic-oauth": ["oauth", "apiKey", "webSession"],
  "chatgpt-oauth": ["oauth", "apiKey", "webSession"],
  // The one provider whose *primary* method is the session, because that is the
  // whole reason it exists — a free account with no key to paste.
  "chatgpt-web": ["webSession", "apiKey"],
  "gemini-oauth": ["oauth", "apiKey", "webSession"],
  openai: ["apiKey", "webSession"],
  xai: ["apiKey", "webSession"],
  openrouter: ["apiKey", "webSession"],
  groq: ["apiKey", "webSession"],
  mistral: ["apiKey", "webSession"],
  kimi: ["apiKey", "webSession"],
  deepseek: ["apiKey", "webSession"],
  // A router runs on the user's machine and is reached like Ollama is: if it is
  // listening it is connected, and any credential it wants is its own business.
  router: ["local", "apiKey"],
  // Nothing to sign into and nothing to paste — connecting is only the user
  // saying yes to the traffic leaving for a third party.
  opencode: ["free"],
  ollama: ["local"],
};

/**
 * The method a provider leads with, in the four-value vocabulary that predates
 * the matrix.
 *
 * Derived rather than written out twice, so the call sites that only care about
 * the headline way in — the connect picker, the sidebar's card filter — keep
 * working while the ones that need the full matrix read `PROVIDER_METHODS`.
 *
 * A captured session reports as `apiKey` because that is exactly what it is at
 * this layer: an opaque bearer string, stored and sent the way a key is. The
 * distinction between "you pasted this" and "you signed in for this" matters to
 * the connect UI and to failover ranking, and both of those read the matrix.
 * Collapsing it here is what keeps `apiKeyFor` and the connect switch behaving
 * for `chatgpt-web` exactly as they did before.
 */
export const PROVIDER_CREDENTIALS: Record<ProviderId, CredentialKind> = Object.fromEntries(
  ALL_PROVIDERS.map((id) => [id, legacyKind(PROVIDER_METHODS[id][0])]),
) as Record<ProviderId, CredentialKind>;

function legacyKind(method: AuthMethod): CredentialKind {
  return method === "webSession" ? "apiKey" : method;
}

/** Whether this provider can be connected this way at all. */
export function supportsMethod(id: ProviderId, method: AuthMethod): boolean {
  return PROVIDER_METHODS[id].includes(method);
}

/**
 * Roughly what one request costs, which is the order failover should try things
 * in: spend the subscription that is already paid for, then metered keys, then
 * whatever is free.
 *
 * This is the tiering 9Router applies across its own provider list, kept here
 * for the same reason — a rate limit on Claude should land on OpenRouter before
 * it lands on a free endpoint whose quality nobody chose.
 */
export type ProviderTier = "subscription" | "metered" | "free";

export const PROVIDER_TIERS: Record<ProviderId, ProviderTier> = {
  "anthropic-oauth": "subscription",
  "chatgpt-oauth": "subscription",
  "gemini-oauth": "subscription",
  openai: "metered",
  xai: "metered",
  openrouter: "metered",
  mistral: "metered",
  kimi: "metered",
  deepseek: "metered",
  // Whatever the router falls through to is the router's decision, and it does
  // its own tiering — so it sits with the accounts rather than the free tail.
  router: "metered",
  groq: "free",
  ollama: "free",
  opencode: "free",
  // Last resort of the last resort: it works on a free account, and it is the
  // one provider here that can get that account suspended.
  "chatgpt-web": "free",
};

const TIER_ORDER: ProviderTier[] = ["subscription", "metered", "free"];

/**
 * `ALL_PROVIDERS` grouped by tier, preserving declaration order within each.
 *
 * Used wherever a provider is chosen rather than named — "auto", and the hunt
 * for somewhere to continue a rate-limited run.
 */
export const PROVIDERS_BY_TIER: ProviderId[] = TIER_ORDER.flatMap((tier) =>
  ALL_PROVIDERS.filter((id) => PROVIDER_TIERS[id] === tier),
);

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
  router: "9Router",
  opencode: "OpenCode Free",
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
  router: "Local router — every account you connected there, one endpoint",
  opencode: "No account, no key — free models, lower quality",
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
  router: "https://github.com/decolua/9router",
  opencode: "https://opencode.ai",
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
  // Both of these are starting points only; the live catalogue wins. A router
  // serves whatever its owner connected, and OpenCode moves its free lineup.
  // `oc/` is 9Router's own alias for OpenCode, so this is the one model a
  // freshly installed router can serve before anything has been connected to it.
  router: "oc/big-pickle",
  opencode: "big-pickle",
  // Only a starting point — whatever is actually pulled locally wins, because
  // asking for a model that is not installed is a 404 rather than a fallback.
  ollama: "qwen3-coder:30b",
};

/**
 * Base URLs for the providers that speak the OpenAI chat-completions dialect.
 * Ollama's and the router's are overridable because both are servers the user
 * runs and can move to another port.
 */
export type OpenAiCompatibleProvider =
  | "openai"
  | "xai"
  | "openrouter"
  | "groq"
  | "mistral"
  | "kimi"
  | "deepseek"
  | "router"
  | "opencode"
  | "ollama";

export const OPENAI_COMPATIBLE_BASES: Record<OpenAiCompatibleProvider, string> = {
  openai: "https://api.openai.com/v1",
  xai: "https://api.x.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai/v1",
  kimi: "https://api.moonshot.ai/v1",
  deepseek: "https://api.deepseek.com/v1",
  router: "http://127.0.0.1:20128/v1",
  opencode: "https://opencode.ai/zen/v1",
  ollama: "http://127.0.0.1:11434/v1",
};

/**
 * Headers OpenCode's free endpoint expects.
 *
 * The bearer is the literal string "public" — the tier is open, so the token is
 * a formality the endpoint still insists on rather than a credential, and there
 * is nothing here worth putting in the keychain.
 */
export const OPENCODE_HEADERS: Record<string, string> = {
  authorization: "Bearer public",
  "x-opencode-client": "desktop",
};

/**
 * OpenCode lists its whole catalogue at `/models`, most of which needs a paid
 * Zen account. The free ones are suffixed `-free`, plus one that is not.
 * Filtering here is what keeps the model picker from offering a 401.
 */
const OPENCODE_FREE_EXCEPTIONS = new Set(["big-pickle"]);

export function isFreeOpenCodeModel(id: string): boolean {
  return id.endsWith("-free") || OPENCODE_FREE_EXCEPTIONS.has(id);
}

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
  // A router serves whatever its owner connected to it, under `alias/model`
  // ids, so this list is only what a fresh install can already reach. The
  // picker fetches the real catalogue, which is where the combos show up.
  router: [
    { id: "oc/big-pickle", label: "Big Pickle", note: "Free, no account" },
    { id: "cc/claude-opus-5", label: "Claude Opus 5", note: "via a connected Claude account" },
    { id: "cx/gpt-5.1-codex", label: "GPT-5.1 Codex", note: "via a connected Codex account" },
    { id: "kr/claude-sonnet-4.5", label: "Claude Sonnet 4.5", note: "via Kiro's free credits" },
  ],
  // Only the free tier is listed: the rest of OpenCode's catalogue needs a paid
  // Zen account, and this provider deliberately has nowhere to put one.
  opencode: [
    { id: "big-pickle", label: "Big Pickle", note: "Best free one here" },
    { id: "deepseek-v4-flash-free", label: "DeepSeek V4 Flash", note: "Fast" },
    { id: "north-mini-code-free", label: "North Mini Code", note: "Coding-tuned" },
    { id: "longcat-2.0-free", label: "LongCat 2.0", note: "Long context" },
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
  /**
   * Which tool ends this run, and what to call the run.
   *
   * Only backends without native tool calling need it: they are told in prose to
   * keep going until they call it, and naming a tool the request never offered
   * sends the model looking for something that is not there. Providers with real
   * tool calling ignore this.
   */
  task?: { finishTool: string; noun: string };
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
