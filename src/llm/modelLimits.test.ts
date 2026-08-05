import { describe, expect, it } from "vitest";
import {
  billsPerToken,
  contextWindowFor,
  estimateCost,
  formatCost,
  limitsFor,
} from "./modelLimits";

describe("limitsFor", () => {
  it("matches the longest prefix, not the first one listed", () => {
    // `claude-opus-4-8` contains `claude-` and `claude-opus-4`; the specific
    // one has to win or every Opus 4 run is priced as a Sonnet.
    expect(limitsFor("claude-opus-4-8").inputPerMillion).toBe(15);
    expect(limitsFor("claude-opus-5").inputPerMillion).toBe(5);
    expect(limitsFor("gpt-4.1-mini").inputPerMillion).toBe(0.4);
    expect(limitsFor("gpt-4.1").inputPerMillion).toBe(2);
  });

  it("sees through the suffixes providers actually ship", () => {
    for (const id of [
      "claude-opus-5-20250114",
      "anthropic/claude-opus-5",
      "us.anthropic.claude-opus-5-v1:0",
    ]) {
      expect(contextWindowFor(id), id).toBe(200_000);
    }
    expect(limitsFor("deepseek-chat:free").inputPerMillion).toBe(0.28);
  });

  it("assumes the smallest window in use for a model it has never heard of", () => {
    // Guessing large means compaction never fires and the run dies on a 400;
    // guessing small only means it fires earlier than it had to.
    expect(contextWindowFor("some-new-model-2027")).toBe(128_000);
  });
});

describe("estimateCost", () => {
  it("prices input and output separately", () => {
    const cost = estimateCost({
      provider: "openai",
      model: "gpt-4.1",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(10, 5); // $2 in + $8 out
  });

  it("discounts cached input", () => {
    const fresh = estimateCost({
      provider: "openai",
      model: "gpt-4.1",
      inputTokens: 1_000_000,
      outputTokens: 0,
    })!;
    const cached = estimateCost({
      provider: "openai",
      model: "gpt-4.1",
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 1_000_000,
    })!;
    expect(cached).toBeLessThan(fresh);
    expect(cached).toBeCloseTo(fresh * 0.1, 5);
  });

  it("says nothing where tokens do not become a bill", () => {
    // A subscription and a local model both cost zero extra; showing "$0.00"
    // would imply a meter that is running, and showing a real number would be
    // an invention.
    for (const provider of ["anthropic-oauth", "chatgpt-oauth", "gemini-oauth", "ollama"] as const) {
      expect(
        estimateCost({ provider, model: "claude-opus-5", inputTokens: 9e6, outputTokens: 9e6 }),
        provider,
      ).toBeUndefined();
      expect(billsPerToken(provider), provider).toBe(false);
    }
  });

  it("says nothing for a billed provider whose model it cannot price", () => {
    expect(
      estimateCost({
        provider: "openrouter",
        model: "someone/experimental-thing",
        inputTokens: 1000,
        outputTokens: 1000,
      }),
    ).toBeUndefined();
  });

  it("prices an API-key provider it does know", () => {
    expect(billsPerToken("openai")).toBe(true);
    expect(
      estimateCost({
        provider: "deepseek",
        model: "deepseek-chat",
        inputTokens: 1_000_000,
        outputTokens: 0,
      }),
    ).toBeCloseTo(0.28, 5);
  });
});

describe("formatCost", () => {
  it("never shows a row of zeros for real spending", () => {
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(0.0004)).toBe("<$0.01");
    expect(formatCost(0.42)).toBe("$0.42");
    expect(formatCost(12.6)).toBe("$13");
  });
});
