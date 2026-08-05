/**
 * The plan and the todo list — what the architect hands over and what the
 * builder works through.
 *
 * These are the two things a developer watches while an agent codes, so both are
 * parsed defensively: a model that returns a step as a bare string instead of an
 * object, or a status this build has never heard of, should degrade into
 * something still worth reading rather than emptying the panel.
 *
 * Deliberately free of `vscode`, so the parsing can be tested directly.
 */

export type TodoStatus = "pending" | "active" | "done";

export interface Todo {
  id: string;
  title: string;
  status: TodoStatus;
}

export interface PlanStep {
  title: string;
  /** Workspace-relative paths this step touches. */
  files: string[];
  detail: string;
}

export interface BuildPlan {
  title: string;
  summary: string;
  steps: PlanStep[];
  risks: string[];
  /** How to tell it worked — the commands to run, the behaviour to check. */
  verification: string[];
}

export function parsePlan(input: unknown): BuildPlan | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const raw = input as Record<string, unknown>;

  const summary = text(raw.summary);
  const steps = objects(raw.steps)
    .map((step) => ({
      title: text(step.title) || text(step.what) || text(step.description),
      files: strings(step.files),
      detail: text(step.detail) || text(step.how) || text(step.description),
    }))
    .filter((step) => step.title.length > 0);

  // A plan with no summary and no steps is not a plan; anything less than that
  // is the model having a bad turn, and the caller should say so rather than
  // showing an empty card.
  if (summary.length === 0 && steps.length === 0) return undefined;

  return {
    title: text(raw.title) || "Plan",
    summary,
    steps,
    risks: strings(raw.risks),
    verification: strings(raw.verification),
  };
}

/**
 * Reads a todo list, keeping the model's order.
 *
 * Ids are the model's if it supplied them and positional otherwise, which is
 * what lets a later call update a list rather than replace it wholesale.
 */
export function parseTodos(input: unknown): Todo[] {
  const items = Array.isArray(input) ? input : [];
  const seen = new Set<string>();
  const out: Todo[] = [];

  items.forEach((item, i) => {
    const raw =
      typeof item === "string"
        ? { title: item }
        : typeof item === "object" && item !== null
          ? (item as Record<string, unknown>)
          : undefined;
    if (!raw) return;

    const title = text(raw.title) || text(raw.content) || text(raw.task);
    if (title.length === 0) return;

    let id = text(raw.id) || `todo-${i + 1}`;
    // Two todos sharing an id would collapse into one in the UI, and a model
    // repeating "1" for every item is common enough to be worth handling.
    while (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);

    out.push({ id, title, status: parseStatus(raw.status) });
  });

  return out;
}

function parseStatus(value: unknown): TodoStatus {
  const status = text(value).toLowerCase();
  if (["done", "completed", "complete", "finished"].includes(status)) return "done";
  if (["active", "in_progress", "in-progress", "doing", "started"].includes(status)) {
    return "active";
  }
  return "pending";
}

/** "2 of 5 done", for the panel header and the status bar. */
export function summarizeTodos(todos: Todo[]): string {
  if (todos.length === 0) return "";
  const done = todos.filter((t) => t.status === "done").length;
  return `${done} of ${todos.length} done`;
}

/**
 * The plan as Markdown.
 *
 * Used for the editable copy the developer gets from "Edit plan", which is why
 * it round-trips as prose rather than as JSON: the point is that a human can
 * rewrite a step in their own words before the builder is turned loose on it.
 */
export function renderPlanMarkdown(plan: BuildPlan): string {
  const out: string[] = [`# ${plan.title}`, ""];
  if (plan.summary) out.push(plan.summary, "");

  if (plan.steps.length > 0) {
    out.push("## Steps", "");
    plan.steps.forEach((step, i) => {
      out.push(`${i + 1}. **${step.title}**`);
      if (step.files.length > 0) out.push(`   - Files: ${step.files.join(", ")}`);
      if (step.detail) out.push(`   - ${step.detail}`);
    });
    out.push("");
  }
  if (plan.risks.length > 0) {
    out.push("## Risks", "", ...plan.risks.map((r) => `- ${r}`), "");
  }
  if (plan.verification.length > 0) {
    out.push("## How to verify", "", ...plan.verification.map((v) => `- ${v}`), "");
  }
  return out.join("\n");
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function objects(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) =>
    typeof item === "string"
      ? { title: item }
      : typeof item === "object" && item !== null
        ? (item as Record<string, unknown>)
        : {},
  );
}
