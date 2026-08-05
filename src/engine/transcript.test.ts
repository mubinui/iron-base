import { describe, expect, it } from "vitest";
import type { NeutralMessage } from "../llm/types";
import { compactForRequest, estimateTokens, stripForeignBlocks } from "./transcript";

const bigFile = (label: string): string => `${label}\n${"x".repeat(5000)}`;

function toolResult(name: string, content: string): NeutralMessage {
  return { role: "toolResult", results: [{ callId: "c1", name, content }] };
}

/** A transcript of `n` read/result pairs, oldest first. */
function transcript(n: number): NeutralMessage[] {
  const out: NeutralMessage[] = [{ role: "user", text: "review this" }];
  for (let i = 0; i < n; i++) {
    out.push({ role: "assistant", toolCalls: [{ callId: "c1", name: "read_file", input: {} }] });
    out.push(toolResult("read_file", bigFile(`file${i}.ts`)));
  }
  return out;
}

describe("compactForRequest", () => {
  it("leaves a short transcript untouched", () => {
    const messages = transcript(2);
    const { messages: out, stats } = compactForRequest(messages);
    expect(out).toBe(messages);
    expect(stats.resultsPruned).toBe(0);
  });

  it("prunes the older results and keeps the most recent verbatim", () => {
    const messages = transcript(8);
    const { messages: out, stats } = compactForRequest(messages);

    const bodies = out
      .filter((m): m is Extract<NeutralMessage, { role: "toolResult" }> => m.role === "toolResult")
      .map((m) => m.results[0].content);

    // Three most recent survive intact; the rest became one-line notes.
    expect(bodies.slice(-3).every((b) => b.length > 4000)).toBe(true);
    expect(bodies.slice(0, -3).every((b) => b.startsWith("[read_file:"))).toBe(true);
    expect(stats.resultsPruned).toBe(5);
    expect(stats.charsSaved).toBeGreaterThan(20_000);
  });

  it("does not mutate the caller's transcript", () => {
    const messages = transcript(8);
    const before = JSON.stringify(messages);
    compactForRequest(messages);
    expect(JSON.stringify(messages)).toBe(before);
  });

  it("keeps small results whole — a summary would cost more than the body", () => {
    const messages: NeutralMessage[] = [
      toolResult("list_dir", "src/"),
      toolResult("list_dir", "lib/"),
      ...transcript(4).slice(1),
    ];
    const { messages: out } = compactForRequest(messages);
    const first = out[0] as Extract<NeutralMessage, { role: "toolResult" }>;
    expect(first.results[0].content).toBe("src/");
  });

  it("keeps error text, which the model needs in order to correct itself", () => {
    const messages: NeutralMessage[] = [
      {
        role: "toolResult",
        results: [
          { callId: "c1", name: "propose_fix", content: `anchor not found\n${"y".repeat(600)}`, isError: true },
        ],
      },
      ...transcript(4).slice(1),
    ];
    const { messages: out } = compactForRequest(messages);
    const first = out[0] as Extract<NeutralMessage, { role: "toolResult" }>;
    expect(first.results[0].content).toContain("anchor not found");
    expect(first.results[0].content).not.toContain("[propose_fix:");
  });

  it("says how to get the dropped content back", () => {
    const { messages: out } = compactForRequest(transcript(6));
    const pruned = (out[2] as Extract<NeutralMessage, { role: "toolResult" }>).results[0].content;
    expect(pruned).toContain("Call the tool again");
    expect(pruned).toContain("file0.ts");
  });

  it("shrinks the request enough to matter", () => {
    const messages = transcript(20);
    const before = estimateTokens(messages, "");
    const after = estimateTokens(compactForRequest(messages).messages, "");
    expect(after).toBeLessThan(before * 0.3);
  });
});

describe("stripForeignBlocks", () => {
  const withRaw: NeutralMessage[] = [
    { role: "user", text: "go" },
    { role: "assistant", text: "thinking", raw: { signature: "abc" }, producedBy: "anthropic-oauth" },
  ];

  it("keeps provider-native blocks when the target produced them", () => {
    const out = stripForeignBlocks(withRaw, "anthropic-oauth");
    expect(out).toBe(withRaw);
    expect((out[1] as { raw?: unknown }).raw).toBeDefined();
  });

  // Anthropic's signed thinking blocks and Codex's encrypted reasoning are a
  // hard 400 at any other provider, so failover depends on this.
  it("drops them when the turn is going somewhere else", () => {
    const out = stripForeignBlocks(withRaw, "deepseek");
    expect((out[1] as { raw?: unknown }).raw).toBeUndefined();
    expect((out[1] as { text?: string }).text).toBe("thinking");
    expect((withRaw[1] as { raw?: unknown }).raw).toBeDefined();
  });

  it("strips unattributed blocks rather than risking a rejected request", () => {
    const orphan: NeutralMessage[] = [{ role: "assistant", text: "x", raw: { a: 1 } }];
    expect((stripForeignBlocks(orphan, "kimi")[0] as { raw?: unknown }).raw).toBeUndefined();
  });
});
