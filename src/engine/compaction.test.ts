import { describe, expect, it, vi } from "vitest";
import type { ChatTurn, LlmClient, NeutralMessage } from "../llm/types";
import { compact, contextPressure, needsCompaction } from "./compaction";

const noCancel = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => {} }),
};

/** A transcript of `count` turns, each carrying `filler` characters of tool output. */
function transcript(count: number, filler = 4000): NeutralMessage[] {
  const messages: NeutralMessage[] = [{ role: "user", text: "Add rate limiting to the API" }];
  for (let i = 0; i < count; i++) {
    messages.push({
      role: "assistant",
      text: `step ${i}`,
      toolCalls: [{ callId: `c${i}`, name: "read_file", input: { path: `src/f${i}.ts` } }],
    });
    messages.push({
      role: "toolResult",
      results: [{ callId: `c${i}`, name: "read_file", content: "x".repeat(filler) }],
    });
  }
  return messages;
}

function fakeClient(reply: string | Error): LlmClient {
  return {
    id: "openai",
    model: "gpt-4.1",
    chat: vi.fn(async (): Promise<ChatTurn> => {
      if (reply instanceof Error) throw reply;
      return {
        text: reply,
        toolCalls: [],
        stopReason: "end",
        usage: { inputTokens: 10, outputTokens: 10 },
      };
    }),
  };
}

describe("contextPressure", () => {
  it("scales with the transcript against the model's own window", () => {
    const small = contextPressure(transcript(2), "sys", "gpt-4.1");
    const large = contextPressure(transcript(40), "sys", "gpt-4.1");
    expect(large).toBeGreaterThan(small);
    expect(small).toBeGreaterThan(0);
  });

  it("reports a bigger window as less full for the same transcript", () => {
    const messages = transcript(20);
    // gemini's window is ~8× claude's, so the same history is far less pressing.
    expect(contextPressure(messages, "sys", "gemini-2.5-pro")).toBeLessThan(
      contextPressure(messages, "sys", "claude-opus-5"),
    );
  });
});

describe("needsCompaction", () => {
  it("leaves a short conversation alone however small the window", () => {
    expect(needsCompaction(transcript(1), "sys", "gpt-4.1")).toBe(false);
  });

  it("fires once the window is filling", () => {
    // ~120 tool results of 4k characters against a 128k-token window.
    expect(needsCompaction(transcript(60, 8000), "sys", "some-unknown-model")).toBe(true);
  });
});

describe("compact", () => {
  it("replaces the older turns with the model's summary and keeps the recent ones", async () => {
    const messages = transcript(20);
    const result = await compact(messages, "sys", fakeClient("Did X, changed Y."), noCancel);

    expect(result.compacted).toBe(true);
    expect(result.after).toBeLessThan(result.before);
    expect(result.messages.length).toBeLessThan(messages.length);

    const first = result.messages[0];
    expect(first.role).toBe("user");
    expect(first.role === "user" && first.text).toContain("Did X, changed Y.");

    // The tail is preserved exactly — that is the part the model is mid-way
    // through and cannot afford to lose.
    expect(result.messages.at(-1)).toEqual(messages.at(-1));
  });

  it("never leaves a tool result orphaned at the front of the transcript", async () => {
    // A toolResult whose call has just been summarised away is a hard 400 on
    // several providers, so the cut has to walk past it.
    for (const size of [12, 13, 20, 21, 40]) {
      const result = await compact(transcript(size), "sys", fakeClient("summary"), noCancel);
      const orphan = result.messages.findIndex((m) => m.role === "toolResult");
      const firstAssistant = result.messages.findIndex((m) => m.role === "assistant");
      expect(orphan === -1 || orphan > firstAssistant, `size ${size}`).toBe(true);
    }
  });

  it("falls back to a mechanical summary when the model cannot write one", async () => {
    const result = await compact(
      transcript(20),
      "sys",
      fakeClient(new Error("provider is down")),
      noCancel,
    );
    expect(result.compacted).toBe(true);
    const first = result.messages[0];
    expect(first.role === "user" && first.text).toContain("read_file");
    // And it tells the model not to trust its memory of what it read.
    expect(first.role === "user" && first.text).toContain("Re-read");
  });

  it("offers the summariser no tools, so it cannot resume the task instead", async () => {
    const client = fakeClient("summary");
    await compact(transcript(20), "sys", client, noCancel);
    const request = (client.chat as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(request.tools).toEqual([]);
  });

  it("leaves a transcript too short to cut exactly as it was", async () => {
    const messages = transcript(1);
    const result = await compact(messages, "sys", fakeClient("summary"), noCancel);
    expect(result.compacted).toBe(false);
    expect(result.messages).toBe(messages);
  });
});
