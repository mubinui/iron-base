import { describe, expect, it } from "vitest";
import { parsePlan, parseTodos, renderPlanMarkdown, summarizeTodos } from "./plan";

describe("parsePlan", () => {
  it("reads a well-formed plan", () => {
    const plan = parsePlan({
      title: "Move sessions to Redis",
      summary: "Sessions live in a process-local object, so the app cannot run twice.",
      steps: [
        {
          title: "Add a session store",
          files: ["src/session.js"],
          detail: "Wrap ioredis behind get/set.",
        },
      ],
      risks: ["Redis becomes a new dependency to run locally."],
      verification: ["npm test", "Start two instances and share a login."],
    });

    expect(plan?.title).toBe("Move sessions to Redis");
    expect(plan?.steps[0].files).toEqual(["src/session.js"]);
    expect(plan?.verification).toHaveLength(2);
  });

  it("accepts the field names models reach for instead", () => {
    const plan = parsePlan({
      summary: "s",
      steps: [{ what: "Extract the query", how: "Into src/db.js" }],
    });
    expect(plan?.steps[0].title).toBe("Extract the query");
    expect(plan?.steps[0].detail).toBe("Into src/db.js");
  });

  it("accepts steps written as bare strings", () => {
    const plan = parsePlan({ summary: "s", steps: ["Add a pool", "Use it"] });
    expect(plan?.steps.map((s) => s.title)).toEqual(["Add a pool", "Use it"]);
  });

  it("drops steps with no title rather than rendering blank rows", () => {
    const plan = parsePlan({ summary: "s", steps: [{ files: ["a.js"] }, { title: "Real" }] });
    expect(plan?.steps).toHaveLength(1);
  });

  it("returns nothing when there is neither a summary nor a step", () => {
    expect(parsePlan({ risks: ["x"] })).toBeUndefined();
    expect(parsePlan(undefined)).toBeUndefined();
    expect(parsePlan("a plan")).toBeUndefined();
  });

  it("titles an untitled plan rather than showing an empty heading", () => {
    expect(parsePlan({ summary: "s" })?.title).toBe("Plan");
  });
});

describe("parseTodos", () => {
  it("keeps the model's order and normalises status wording", () => {
    const todos = parseTodos([
      { id: "a", title: "First", status: "completed" },
      { id: "b", title: "Second", status: "in_progress" },
      { id: "c", title: "Third" },
    ]);
    expect(todos.map((t) => t.status)).toEqual(["done", "active", "pending"]);
    expect(todos.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("accepts plain strings", () => {
    expect(parseTodos(["Write the test", "Make it pass"]).map((t) => t.title)).toEqual([
      "Write the test",
      "Make it pass",
    ]);
  });

  it("gives positional ids when the model supplies none", () => {
    expect(parseTodos(["a", "b"]).map((t) => t.id)).toEqual(["todo-1", "todo-2"]);
  });

  it("keeps repeated ids distinct so the list cannot collapse", () => {
    const todos = parseTodos([
      { id: "1", title: "a" },
      { id: "1", title: "b" },
    ]);
    expect(new Set(todos.map((t) => t.id)).size).toBe(2);
    expect(todos).toHaveLength(2);
  });

  it("treats an unknown status as not started", () => {
    expect(parseTodos([{ title: "x", status: "wibble" }])[0].status).toBe("pending");
  });

  it("ignores entries with nothing to show", () => {
    expect(parseTodos([{ status: "done" }, null, 7, { title: "  " }])).toEqual([]);
  });

  it("returns an empty list for a non-array", () => {
    expect(parseTodos({ todos: [] })).toEqual([]);
  });
});

describe("summarizeTodos", () => {
  it("counts what is finished", () => {
    const todos = parseTodos([
      { title: "a", status: "done" },
      { title: "b", status: "active" },
      { title: "c" },
    ]);
    expect(summarizeTodos(todos)).toBe("1 of 3 done");
    expect(summarizeTodos([])).toBe("");
  });
});

describe("renderPlanMarkdown", () => {
  it("renders every section a developer would edit", () => {
    const plan = parsePlan({
      title: "T",
      summary: "S",
      steps: [{ title: "Step one", files: ["a.ts"], detail: "D" }],
      risks: ["R"],
      verification: ["V"],
    })!;
    const markdown = renderPlanMarkdown(plan);
    expect(markdown).toContain("# T");
    expect(markdown).toContain("1. **Step one**");
    expect(markdown).toContain("Files: a.ts");
    expect(markdown).toContain("## Risks");
    expect(markdown).toContain("## How to verify");
  });

  it("leaves out sections the plan does not have", () => {
    const markdown = renderPlanMarkdown(parsePlan({ summary: "S" })!);
    expect(markdown).not.toContain("## Risks");
    expect(markdown).not.toContain("## Steps");
  });
});
