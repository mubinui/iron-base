/**
 * How much a model can hold, and what it charges.
 *
 * Two numbers per model that the rest of the extension cannot work without.
 * The context window decides when a conversation has to be compacted — without
 * it the only signal that a transcript grew too large is a 400 from the
 * provider, halfway through a build, with nothing salvaged. The prices turn the
 * token counter into something a person can act on.
 *
 * Both are matched by prefix, not by exact id. Providers ship `-20250114` date
 * suffixes, regional prefixes and `:free` variants constantly, and a table keyed
 * on exact ids is wrong within a month. A prefix match degrades to the family's
 * numbers, which is close enough for a budget bar and far better than nothing.
 *
 * Deliberately free of `vscode`, so it can be tested directly.
 */

import type { ProviderId } from "./types";

export interface ModelLimits {
  /** Total tokens the model will accept in one request. */
  contextWindow: number;
  /** USD per million input tokens. Zero where the account is not billed per token. */
  inputPerMillion: number;
  outputPerMillion: number;
  /** Cached input, where the provider discounts it. Defaults to a tenth. */
  cachedInputPerMillion?: number;
}

/**
 * Matched longest-prefix-first, so `claude-opus-4-8` does not pick up
 * `claude-opus-5`'s numbers just because it was listed earlier.
 */
const TABLE: Array<[string, ModelLimits]> = [
  // Anthropic
  ["claude-opus-5", { contextWindow: 200_000, inputPerMillion: 5, outputPerMillion: 25 }],
  ["claude-opus-4", { contextWindow: 200_000, inputPerMillion: 15, outputPerMillion: 75 }],
  ["claude-sonnet-5", { contextWindow: 200_000, inputPerMillion: 3, outputPerMillion: 15 }],
  ["claude-sonnet-4", { contextWindow: 200_000, inputPerMillion: 3, outputPerMillion: 15 }],
  ["claude-haiku-4", { contextWindow: 200_000, inputPerMillion: 1, outputPerMillion: 5 }],
  ["claude-3-5-haiku", { contextWindow: 200_000, inputPerMillion: 0.8, outputPerMillion: 4 }],
  ["claude-", { contextWindow: 200_000, inputPerMillion: 3, outputPerMillion: 15 }],

  // OpenAI
  ["gpt-5", { contextWindow: 400_000, inputPerMillion: 1.25, outputPerMillion: 10 }],
  ["gpt-4.1-mini", { contextWindow: 1_047_576, inputPerMillion: 0.4, outputPerMillion: 1.6 }],
  ["gpt-4.1", { contextWindow: 1_047_576, inputPerMillion: 2, outputPerMillion: 8 }],
  ["gpt-4o-mini", { contextWindow: 128_000, inputPerMillion: 0.15, outputPerMillion: 0.6 }],
  ["gpt-4o", { contextWindow: 128_000, inputPerMillion: 2.5, outputPerMillion: 10 }],
  ["o4-mini", { contextWindow: 200_000, inputPerMillion: 1.1, outputPerMillion: 4.4 }],
  ["o3", { contextWindow: 200_000, inputPerMillion: 2, outputPerMillion: 8 }],
  ["codex", { contextWindow: 400_000, inputPerMillion: 1.25, outputPerMillion: 10 }],
  ["gpt-", { contextWindow: 128_000, inputPerMillion: 2.5, outputPerMillion: 10 }],

  // Google
  ["gemini-2.5-pro", { contextWindow: 1_048_576, inputPerMillion: 1.25, outputPerMillion: 10 }],
  ["gemini-2.5-flash", { contextWindow: 1_048_576, inputPerMillion: 0.3, outputPerMillion: 2.5 }],
  ["gemini-2.0-flash", { contextWindow: 1_048_576, inputPerMillion: 0.1, outputPerMillion: 0.4 }],
  ["gemini-", { contextWindow: 1_048_576, inputPerMillion: 1.25, outputPerMillion: 10 }],

  // Others reachable through the OpenAI-compatible clients
  ["grok-", { contextWindow: 256_000, inputPerMillion: 3, outputPerMillion: 15 }],
  ["deepseek-", { contextWindow: 128_000, inputPerMillion: 0.28, outputPerMillion: 0.42 }],
  ["moonshot", { contextWindow: 256_000, inputPerMillion: 0.6, outputPerMillion: 2.5 }],
  ["kimi", { contextWindow: 256_000, inputPerMillion: 0.6, outputPerMillion: 2.5 }],
  ["mistral-large", { contextWindow: 128_000, inputPerMillion: 2, outputPerMillion: 6 }],
  ["mistral-", { contextWindow: 128_000, inputPerMillion: 0.2, outputPerMillion: 0.6 }],
  ["codestral", { contextWindow: 256_000, inputPerMillion: 0.3, outputPerMillion: 0.9 }],
  ["llama-", { contextWindow: 128_000, inputPerMillion: 0.2, outputPerMillion: 0.6 }],
  ["qwen", { contextWindow: 128_000, inputPerMillion: 0.2, outputPerMillion: 0.6 }],
];

/**
 * What is assumed about a model nobody has heard of.
 *
 * 128k is the smallest window in current use, so assuming it means compaction
 * fires early rather than never — the failure that costs a run is the other one.
 */
const UNKNOWN: ModelLimits = {
  contextWindow: 128_000,
  inputPerMillion: 0,
  outputPerMillion: 0,
};

/**
 * Providers where tokens do not translate into a bill.
 *
 * A subscription has already been paid for and a local model costs electricity,
 * so quoting a dollar figure against either would be inventing a number. The
 * token count still shows; the money does not.
 */
const NOT_BILLED_PER_TOKEN = new Set<ProviderId>([
  "anthropic-oauth",
  "chatgpt-oauth",
  "chatgpt-web",
  "gemini-oauth",
  "ollama",
]);

export function limitsFor(model: string): ModelLimits {
  const id = model.toLowerCase();
  let best: ModelLimits | undefined;
  let bestLength = -1;
  for (const [prefix, limits] of TABLE) {
    if (id.includes(prefix) && prefix.length > bestLength) {
      best = limits;
      bestLength = prefix.length;
    }
  }
  return best ?? UNKNOWN;
}

export function contextWindowFor(model: string): number {
  return limitsFor(model).contextWindow;
}

export function billsPerToken(provider: ProviderId): boolean {
  return !NOT_BILLED_PER_TOKEN.has(provider);
}

export interface CostInput {
  provider: ProviderId;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

/**
 * What a run has cost, in dollars — or undefined when that is not a real number.
 *
 * Undefined is the honest answer three different ways: a subscription where the
 * marginal cost is zero, a local model where there is no bill, and a model whose
 * price this build does not know. All three are better served by showing nothing
 * than by showing a confident zero or a guess.
 */
export function estimateCost(input: CostInput): number | undefined {
  if (!billsPerToken(input.provider)) return undefined;

  const limits = limitsFor(input.model);
  if (limits.inputPerMillion === 0 && limits.outputPerMillion === 0) return undefined;

  const cached = input.cachedInputTokens ?? 0;
  const fresh = Math.max(0, input.inputTokens - cached);
  const cachedRate = limits.cachedInputPerMillion ?? limits.inputPerMillion * 0.1;

  return (
    (fresh * limits.inputPerMillion +
      cached * cachedRate +
      input.outputTokens * limits.outputPerMillion) /
    1_000_000
  );
}

/** "$0.42", or "<$0.01" rather than a row of zeros. */
export function formatCost(usd: number): string {
  if (usd <= 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  return usd < 10 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(0)}`;
}
