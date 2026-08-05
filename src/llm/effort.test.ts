import { describe, expect, it } from "vitest";
import { supportsEffort } from "./effort";

/**
 * `output_config.effort` is not universal. Sending it to a model that has no
 * such parameter is a 400, and because it was sent unconditionally, picking
 * Haiku in the model menu made every review fail before its first tool call.
 */
describe("supportsEffort", () => {
  it("accepts the models that take an effort hint", () => {
    for (const model of [
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-opus-4-5",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "claude-fable-5",
    ]) {
      expect(supportsEffort(model), model).toBe(true);
    }
  });

  it("refuses the models that reject it", () => {
    // Haiku 4.5 is in the extension's own model picker, which is how this
    // shipped: "This model does not support the effort parameter."
    for (const model of [
      "claude-haiku-4-5",
      "claude-haiku-4-5-20251001",
      "claude-sonnet-4-5",
      "claude-sonnet-4-5-20250929",
      "claude-opus-4-1",
      "claude-3-haiku-20240307",
    ]) {
      expect(supportsEffort(model), model).toBe(false);
    }
  });

  it("stays quiet for a model id it has never seen", () => {
    // Users can type any id, so the default has to be the safe one: omit the
    // optional hint rather than risk a 400 on a model that may not take it.
    expect(supportsEffort("some-future-model")).toBe(false);
    expect(supportsEffort("")).toBe(false);
  });

  it("ignores case, since ids are echoed back from settings", () => {
    expect(supportsEffort("Claude-Opus-5")).toBe(true);
  });
});
