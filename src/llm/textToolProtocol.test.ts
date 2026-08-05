import { describe, expect, it } from "vitest";
import {
  parseToolCalls,
  renderToolInstructions,
  renderToolResults,
} from "./textToolProtocol";

const fence = (body: string): string => "```tool\n" + body + "\n```";

describe("parseToolCalls", () => {
  it("reads a single call and strips it from the prose", () => {
    const reply = `Let me look.\n\n${fence('{"name": "read_file", "input": {"path": "a.ts"}}')}`;
    const parsed = parseToolCalls(reply, "t1");

    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0].name).toBe("read_file");
    expect(parsed.toolCalls[0].input).toEqual({ path: "a.ts" });
    expect(parsed.text).toBe("Let me look.");
  });

  it("reads several calls from one reply", () => {
    const reply =
      fence('{"name": "read_file", "input": {"path": "a.ts"}}') +
      "\n\nand also\n\n" +
      fence('{"name": "list_dir", "input": {"path": "src"}}');
    const parsed = parseToolCalls(reply, "t2");

    expect(parsed.toolCalls.map((c) => c.name)).toEqual(["read_file", "list_dir"]);
    // Ids stay distinct so results can be matched back to their call.
    expect(new Set(parsed.toolCalls.map((c) => c.callId)).size).toBe(2);
  });

  it("gives each turn its own id space", () => {
    const one = parseToolCalls(fence('{"name": "a", "input": {}}'), "turn-1");
    const two = parseToolCalls(fence('{"name": "a", "input": {}}'), "turn-2");
    expect(one.toolCalls[0].callId).not.toBe(two.toolCalls[0].callId);
  });

  // Every tolerance below is a real drift a model produces, and each one that
  // isn't handled costs a full round trip to correct.
  it("tolerates label casing, extra backticks, and loose whitespace", () => {
    for (const reply of [
      "```TOOL\n{\"name\": \"a\", \"input\": {}}\n```",
      "````tool\n{\"name\": \"a\", \"input\": {}}\n````",
      "```tool   \n{\"name\": \"a\", \"input\": {}}\n```",
    ]) {
      expect(parseToolCalls(reply, "t").toolCalls, reply).toHaveLength(1);
    }
  });

  it("repairs trailing commas rather than burning a turn", () => {
    const parsed = parseToolCalls(fence('{"name": "a", "input": {"x": 1,},}'), "t");
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0].input).toEqual({ x: 1 });
  });

  it("treats a null or missing input as no arguments", () => {
    expect(parseToolCalls(fence('{"name": "a", "input": null}'), "t").toolCalls[0].input).toEqual({});
    expect(parseToolCalls(fence('{"name": "a"}'), "t").toolCalls[0].input).toEqual({});
  });

  it("reports unreadable blocks instead of silently dropping them", () => {
    const parsed = parseToolCalls(fence("{not json at all"), "t");
    expect(parsed.toolCalls).toHaveLength(0);
    expect(parsed.malformed).toHaveLength(1);
  });

  it("rejects a block with no tool name", () => {
    const parsed = parseToolCalls(fence('{"input": {"path": "a"}}'), "t");
    expect(parsed.toolCalls).toHaveLength(0);
    expect(parsed.malformed).toHaveLength(1);
  });

  it("leaves ordinary code fences alone", () => {
    // The reviewed project is full of code; only the `tool` label may execute.
    const reply = "Here is the fix:\n\n```ts\nconst x = 1;\n```";
    const parsed = parseToolCalls(reply, "t");
    expect(parsed.toolCalls).toHaveLength(0);
    expect(parsed.text).toContain("const x = 1;");
  });

  it("returns plain prose untouched", () => {
    const parsed = parseToolCalls("No tools needed, the code looks fine.", "t");
    expect(parsed.toolCalls).toHaveLength(0);
    expect(parsed.malformed).toHaveLength(0);
    expect(parsed.text).toBe("No tools needed, the code looks fine.");
  });
});

describe("renderToolInstructions", () => {
  const tools = [
    {
      name: "read_file",
      description: "Reads a file.",
      inputSchema: { type: "object" as const, properties: { path: { type: "string" } } },
    },
  ];

  it("documents each tool with its schema", () => {
    const rendered = renderToolInstructions(tools);
    expect(rendered).toContain("read_file");
    expect(rendered).toContain("Reads a file.");
    expect(rendered).toContain('"properties"');
  });

  it("round-trips its own example", () => {
    // The instructions show the model an example block; if our parser cannot
    // read that example back, the format we teach is not the one we accept.
    const parsed = parseToolCalls(renderToolInstructions(tools), "t");
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0].name).toBe("read_file");
  });

  it("says nothing when there are no tools", () => {
    expect(renderToolInstructions([])).toBe("");
  });
});

describe("renderToolResults", () => {
  it("labels results by tool and flags errors", () => {
    const rendered = renderToolResults([
      { callId: "c1", name: "read_file", content: "line one" },
      { callId: "c2", name: "propose_fix", content: "anchor not found", isError: true },
    ]);
    expect(rendered).toContain("## read_file");
    expect(rendered).toContain("line one");
    expect(rendered).toContain("## propose_fix (error)");
  });
});
