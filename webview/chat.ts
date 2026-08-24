/**
 * The build panel, browser half.
 *
 * A running build produces a lot of events, so this renders incrementally: each
 * thread item becomes a node once and is then mutated in place, rather than the
 * whole conversation being rebuilt on every delta. The host holds the thread as
 * data and replays it on `ready`, so nothing here is the source of truth for
 * anything — which is what lets the panel be closed and reopened mid-build.
 *
 * As with the other webviews, every node is built with `createElement` and
 * `textContent`. Model output ends up on this page, and the one guarantee worth
 * having is that no path exists by which it becomes markup.
 */

import type { DiffHunk } from "../src/engine/diff";
import type { BuildPlan, Todo } from "../src/engine/plan";
import type {
  ChatHostMessage,
  ChatState,
  ChatWebviewMessage,
  ComposerMode,
  ModelOption,
  PermissionCard,
  ThreadItem,
} from "../src/protocol";
import { formatCost } from "../src/llm/modelLimits";
import { CHAT_STYLES } from "../src/report/styles";
import { connectMatrix, hero, keychainFootnote } from "./brand";
import { icon, PROVIDER_ICONS, type IconName } from "./icons";
import { renderMarkdown } from "./markdown";

declare function acquireVsCodeApi(): { postMessage(message: ChatWebviewMessage): void };

/**
 * The stylesheet ships inside this bundle, not in the page the host writes.
 *
 * The host used to inline it from its own memory while this script was loaded
 * from disk, so installing an update under a running window served the new
 * script with the old CSS — and unstyled tiles collapse into a run of text
 * that looks nothing like the product. Same file, same bundle, no way to
 * disagree.
 */
function applyStyles(css: string): void {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
}

const vscode = acquireVsCodeApi();
const root = document.getElementById("root")!;

applyStyles(CHAT_STYLES);

const EXAMPLES = [
  "Move session storage out of process memory so the app can run on more than one instance",
  "Add input validation to every route that writes to the database",
  "Extract the database queries out of the route handlers into a data layer",
];

let state: ChatState = {
  workspaceName: "",
  sessionTitle: "New build",
  running: false,
  agent: "architect",
  awaitingPlanApproval: false,
  autoAcceptEdits: false,
  changedFiles: 0,
};
let mode: ComposerMode = "architect";
let todos: Todo[] = [];
let draft = "";

/** The bubble deltas are appended to, and the nodes keyed by their item id. */
let streamingBubble: HTMLElement | undefined;
const commandNodes = new Map<string, { out: HTMLElement; status: HTMLElement }>();
const changeNodes = new Map<string, HTMLElement>();
const askNodes = new Map<string, HTMLElement>();
const traceNodes = new Map<string, HTMLElement>();

/**
 * The trace group still taking rows.
 *
 * Consecutive looks belong together — one fan-out of reads, one sweep of the
 * index — and a dozen loose grey lines between two cards read as noise rather
 * than as a step. Anything that is not a look closes the group, so the shape of
 * the thread says where the agent was looking and where it was doing.
 */
let openTrace: HTMLElement | undefined;

/** True while the start page owns the screen, which the composer defers to. */
let onStartPage = true;

// --- Shell -----------------------------------------------------------------

const head = el("div", undefined, "chat-head");
const todoRail = el("div", undefined, "todos");
const thread = el("div", undefined, "thread");
const composer = el("div", undefined, "composer");
root.append(head, todoRail, thread, composer);

const input = document.createElement("textarea");
input.placeholder = "Describe the change you want…";
input.rows = 3;
input.addEventListener("input", () => {
  draft = input.value;
});
input.addEventListener("keydown", (event) => {
  // Enter sends, Shift+Enter breaks the line — the convention everywhere else,
  // and a build request is usually one sentence.
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    send();
  }
});

document.addEventListener("click", () => closePopovers());
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closePopovers();
});

function closePopovers(): void {
  closeModelMenu();
  closeModeMenu();
}

window.addEventListener("message", (event: MessageEvent<ChatHostMessage>) => {
  const message = event.data;
  switch (message.type) {
    case "chatState": {
      // The header ticks with every usage event; the composer holds the
      // textarea and must not be torn down and rebuilt underneath someone
      // who is typing in it. So it is rebuilt only when what it draws changed.
      const before = composerSignature();
      const beforePage = startPageSignature();
      state = message.state;
      renderHead();
      // Signing in from the start page has to redraw it: the matrix that was
      // the whole screen a second ago is now the wrong thing to be looking at.
      if (onStartPage && startPageSignature() !== beforePage) showStartPage();
      if (composerSignature() !== before) renderComposer();
      syncPlanActions();
      break;
    }

    case "replay":
      todos = message.todos;
      onStartPage = false;
      thread.replaceChildren();
      commandNodes.clear();
      changeNodes.clear();
      askNodes.clear();
      traceNodes.clear();
      streamingBubble = undefined;
      openTrace = undefined;
      for (const item of message.thread) appendItem(item);
      // A replay mid-reply must continue the bubble it rebuilt, or the rest of
      // the sentence arrives in a second paragraph below the first.
      if (message.thread[message.thread.length - 1]?.kind === "assistant") {
        streamingBubble = thread.lastElementChild as HTMLElement | undefined;
      }
      if (message.thread.length === 0) showStartPage();
      renderTodos();
      renderComposer();
      scrollToEnd();
      break;

    case "append":
      dropEmptyState();
      appendItem(message.item);
      if (message.item.kind === "plan") syncPlanActions();
      scrollToEnd();
      break;

    case "assistantDelta": {
      dropEmptyState();
      if (!streamingBubble) {
        streamingBubble = el("div", undefined, "assistant");
        streamingBubble.dataset.raw = "";
        thread.append(streamingBubble);
      }
      const raw = (streamingBubble.dataset.raw ?? "") + message.delta;
      streamingBubble.dataset.raw = raw;
      streamingBubble.replaceChildren(renderMarkdown(raw));
      scrollToEnd();
      break;
    }

    case "commandOutput": {
      const node = commandNodes.get(message.id);
      if (node) {
        node.out.textContent = (node.out.textContent ?? "") + message.chunk;
        node.out.scrollTop = node.out.scrollHeight;
      }
      break;
    }

    case "commandEnd": {
      const node = commandNodes.get(message.id);
      if (node) {
        node.status.textContent = message.status;
        node.status.className = `pill ${message.ok ? "ok" : "bad"}`;
      }
      break;
    }

    case "toolEnd": {
      settleTraceRow(message.id, message.note, message.ok);
      break;
    }

    case "todos":
      todos = message.todos;
      renderTodos();
      break;

    case "permission":
      dropEmptyState();
      thread.append(permissionCard(message.request));
      scrollToEnd();
      break;

    case "permissionClosed": {
      const node = askNodes.get(message.id);
      if (node) {
        node.remove();
        askNodes.delete(message.id);
      }
      break;
    }

    case "changeReverted": {
      changeNodes.get(message.id)?.classList.add("reverted");
      break;
    }

    case "modelOptions":
      fillModelMenu(message.options);
      break;
  }
});

// --- Header ----------------------------------------------------------------

/**
 * The header, in two zones.
 *
 * One flat row of a dozen items is what broke on resize: a flex row with no
 * wrapping simply runs off the edge of a 300px sidebar, and everything past the
 * halfway point became unreachable. Identity and actions stay on the top line
 * where they are always needed; the meters sit on their own line underneath and
 * wrap among themselves, so narrowing the view reflows them instead of
 * clipping them.
 */
function renderHead(): void {
  head.replaceChildren();

  const top = el("div", undefined, "head-row");

  // Out to the accounts screen. The panel opens straight into the conversation
  // when an account is connected, so this is the only route to the place where
  // accounts are added and models are chosen — which is why it is a marked
  // control rather than one more grey glyph, and a cog rather than an arrow.
  // An arrow says "back"; it never says what you are going back to.
  const back = el("button", undefined, "back-btn");
  back.title = "Accounts, models and reviews";
  back.setAttribute("aria-label", "Accounts and settings");
  back.append(icon("gear", 15));
  back.addEventListener("click", () =>
    vscode.postMessage({ type: "command", command: "ironbase.buildHome" }),
  );
  top.append(back);

  const chip = el("span", undefined, `mode-chip ${state.agent}`);
  chip.append(
    icon(state.agent === "architect" ? "compass" : "hammer", 11),
    el("span", state.agent === "architect" ? "Architect" : "Build"),
  );
  top.append(chip);

  // The session's own name, not the product's. Which build you are looking at
  // matters more here than which extension you are in. It takes the slack and
  // truncates, so it is the thing that gives way rather than the controls.
  const title = el("span", state.sessionTitle || "New build", "title");
  title.title = state.sessionTitle;
  top.append(title);

  const actions = el("div", undefined, "head-actions");
  if (state.running) {
    const stop = el("button", undefined, "btn stop");
    stop.append(icon("stopCircle", 13), el("span", "Stop"));
    stop.addEventListener("click", () => vscode.postMessage({ type: "stop" }));
    actions.append(stop);
  } else {
    actions.append(
      iconButton("New build", "plus", () => vscode.postMessage({ type: "newSession" })),
      iconButton("Past builds", "history", () => vscode.postMessage({ type: "switchSession" })),
      // The sidebar is narrow; a long diff is easier to read across an editor.
      iconButton("Open in editor", "layers", () =>
        vscode.postMessage({ type: "command", command: "ironbase.buildInEditor" }),
      ),
      iconButton("Export", "download", () => vscode.postMessage({ type: "exportSession" })),
    );
  }
  top.append(actions);
  head.append(top);

  // --- Meters ---------------------------------------------------------------

  const meters = el("div", undefined, "head-meters");

  if (state.activity) {
    const busy = el("span", undefined, "meter busy");
    busy.append(icon("spinner", 12, "glyph"), el("span", state.activity));
    meters.append(busy);
  } else if (state.running && state.iteration) {
    const busy = el("span", undefined, "meter busy");
    busy.append(
      icon("spinner", 12, "glyph"),
      el("span", `${state.iteration.current}/${state.iteration.max}`),
    );
    busy.title = `Step ${state.iteration.current} of ${state.iteration.max}`;
    meters.append(busy);
  }

  // How full the model's context is — the number that predicts when the
  // conversation is about to be summarised, which nothing else on screen says.
  if (state.usage?.contextUsed !== undefined && state.usage.contextUsed > 0.25) {
    const percent = Math.min(100, Math.round(state.usage.contextUsed * 100));
    const gauge = el("span", undefined, "meter");
    gauge.append(icon("context", 12, "glyph"), el("span", `${percent}%`));
    gauge.title =
      percent >= 65
        ? "The earlier part of this conversation will be summarised to make room."
        : "How much of the model's context window this conversation is using.";
    if (percent >= 65) gauge.classList.add("warn-text");
    meters.append(gauge);
  }

  if (state.usage) {
    const total = state.usage.inputTokens + state.usage.outputTokens;
    const tokens = el("span", undefined, "meter");
    tokens.title = `${total.toLocaleString()} tokens this build`;
    tokens.append(icon("layers", 12, "glyph"), el("span", formatTokens(total)));
    meters.append(tokens);

    // Money only where there is money: a subscription or a local model shows
    // the token count and nothing else, because the honest cost is zero extra.
    if (state.usage.costUsd !== undefined) {
      const cost = el("span", undefined, "meter");
      cost.title = "Estimated cost of this build";
      cost.append(icon("coin", 12, "glyph"), el("span", formatCost(state.usage.costUsd)));
      meters.append(cost);
    }
  }

  if (state.changedFiles > 0) {
    const revert = el("button", undefined, "meter changed");
    revert.append(
      icon("cycle", 12, "glyph"),
      el("span", `${state.changedFiles} changed`),
    );
    revert.title = "Put every file back to how it was before this build";
    revert.addEventListener("click", () => vscode.postMessage({ type: "revertAll" }));
    meters.append(revert);
  }

  if (meters.children.length > 0) head.append(meters);
}

function iconButton(label: string, glyph: IconName, onClick: () => void): HTMLElement {
  const node = el("button", undefined, "icon-button");
  node.title = label;
  node.setAttribute("aria-label", label);
  node.append(icon(glyph, 14));
  node.addEventListener("click", onClick);
  return node;
}

function renderTodos(): void {
  todoRail.replaceChildren();
  if (todos.length === 0) {
    todoRail.style.display = "none";
    return;
  }
  todoRail.style.display = "";
  const done = todos.filter((t) => t.status === "done").length;
  todoRail.append(el("h3", `Tasks — ${done} of ${todos.length} done`));
  for (const todo of todos) {
    const row = el("div", undefined, `todo ${todo.status}`);
    row.append(
      el("span", todo.status === "done" ? "✓" : todo.status === "active" ? "▸" : "○", "box"),
      el("span", todo.title, "label"),
    );
    todoRail.append(row);
  }
}

// --- Thread items ----------------------------------------------------------

function appendItem(item: ThreadItem): void {
  streamingBubble = undefined;
  // A look joins the open group; anything else closes it. Doing this here, on
  // the one path every item goes through, is what keeps the grouping true for
  // a replayed thread as well as a live one.
  if (item.kind !== "tool") openTrace = undefined;
  switch (item.kind) {
    case "user":
      thread.append(el("div", item.text, "bubble-user"));
      break;

    case "assistant": {
      const node = el("div", undefined, "assistant");
      node.dataset.raw = item.text;
      node.append(renderMarkdown(item.text));
      thread.append(node);
      break;
    }

    case "tool":
      appendTraceRow(item);
      break;

    case "change":
      thread.append(changeCard(item));
      break;

    case "command":
      thread.append(commandCard(item));
      break;

    case "notice": {
      const row = el("div", undefined, `notice-line ${item.level}`);
      row.append(icon("alert", 13), el("span", item.text));
      thread.append(row);
      break;
    }

    case "plan":
      thread.append(planCard(item.plan));
      break;

    case "finished":
      thread.append(finishedCard(item.summary, item.followUps));
      break;
  }
}

// --- The trace -------------------------------------------------------------

/**
 * How many rows of a group stay on screen before the older ones fold away.
 *
 * A build can read eighty files in a row. All eighty are worth having — that is
 * the audit trail — but not at the cost of pushing the edit that came out of
 * them off the top of the view. The newest stay visible because those are the
 * ones being watched; the rest go behind one line that says how many.
 */
const TRACE_VISIBLE = 7;

function appendTraceRow(item: Extract<ThreadItem, { kind: "tool" }>): void {
  const group = openTrace ?? startTrace();
  const rows = group.querySelector<HTMLElement>(".trace-rows")!;

  const row = el("div", undefined, `trace-row ${toneFor(item.name)}`);
  const chip = el("span", undefined, "chip");
  chip.append(icon(toolIcon(item.name), 12));
  const arg = el("span", item.summary, "arg");
  // A path is read from its end — which file, in which folder — so it is the
  // start that gives way when the sidebar is narrow. A query is read from the
  // front like any other sentence.
  if (looksLikePath(item.summary)) arg.classList.add("path");
  row.append(chip, el("span", toolVerb(item.name), "verb"), arg, el("span", undefined, "note"));
  row.title = `${item.name} ${item.summary}`.trim();

  rows.append(row);
  traceNodes.set(item.id, row);
  if (item.ok === undefined) row.classList.add("running");
  else settleRow(row, item.note, item.ok);

  // Exactly one row crosses the fold on each append, so only that one is
  // touched — the alternative reflows the whole group on every read.
  const total = rows.childElementCount;
  if (!group.classList.contains("open") && total > TRACE_VISIBLE) {
    rows.children[total - TRACE_VISIBLE - 1].classList.add("folded");
    setFoldedCount(group, total - TRACE_VISIBLE);
  }
}

function startTrace(): HTMLElement {
  const group = el("div", undefined, "trace");
  const more = el("button", undefined, "trace-more");
  more.hidden = true;
  more.addEventListener("click", () => {
    group.classList.add("open");
    group.querySelectorAll(".trace-row.folded").forEach((row) => row.classList.remove("folded"));
    more.hidden = true;
  });
  group.append(more, el("div", undefined, "trace-rows"));
  thread.append(group);
  openTrace = group;
  return group;
}

function setFoldedCount(group: HTMLElement, count: number): void {
  const more = group.querySelector<HTMLButtonElement>(".trace-more")!;
  more.hidden = false;
  more.replaceChildren(
    icon("chevron", 11, "chev"),
    el("span", `${count} earlier step${count === 1 ? "" : "s"}`),
  );
}

function settleTraceRow(id: string, note: string | undefined, ok: boolean): void {
  const row = traceNodes.get(id);
  if (row) settleRow(row, note, ok);
}

function settleRow(row: HTMLElement, note: string | undefined, ok: boolean): void {
  row.classList.remove("running");
  row.classList.toggle("bad", !ok);
  const slot = row.querySelector<HTMLElement>(".note");
  if (slot) slot.textContent = note ?? "";
}

/** Which of the three tones a step gets: looking, finding, or delegating. */
function toneFor(name: string): string {
  switch (name) {
    case "search":
    case "find_relevant":
    case "list_signals":
      return "tone-find";
    case "delegate_search":
      return "tone-agent";
    default:
      return name.startsWith("mcp__") ? "tone-agent" : "tone-look";
  }
}

/** Good enough to decide which end of the text to truncate, and no more. */
function looksLikePath(text: string): boolean {
  return text.includes("/") && !text.includes(" ");
}

function changeCard(item: Extract<ThreadItem, { kind: "change" }>): HTMLElement {
  const card = el("div", undefined, `card${item.reverted ? " reverted" : ""}`);
  changeNodes.set(item.id, card);

  const header = el("div", undefined, "card-head");
  header.append(
    icon(changeIcon(item.change), 13, `glyph ${item.change}`),
    el("span", verbFor(item.change), "verb"),
  );

  const path = el("button", item.file, "path");
  path.addEventListener("click", () => vscode.postMessage({ type: "openFile", file: item.file }));
  header.append(path, counts(item.added, item.removed), el("span", undefined, "spacer"));

  if (item.change !== "delete") {
    header.append(
      button("Diff", "btn quiet", () => vscode.postMessage({ type: "showDiff", id: item.id })),
    );
  }
  header.append(
    button("Undo", "btn quiet", () =>
      vscode.postMessage({ type: "revertChange", id: item.id }),
    ),
  );
  card.append(header);

  if (item.why) card.append(el("div", item.why, "why"));
  card.append(diffBody(item.hunks));
  return card;
}

/**
 * A command, its output, and how it ended.
 *
 * The verdict is the part anyone scans for, so it sits in the header as a pill
 * rather than at the bottom of however many lines of output the command
 * produced — which was frequently below the fold.
 */
function commandCard(item: Extract<ThreadItem, { kind: "command" }>): HTMLElement {
  const card = el("div", undefined, "card cmd-card");
  const header = el("div", undefined, "card-head");
  const status = el(
    "div",
    item.status ?? "running",
    `pill ${item.ok === undefined ? "running" : item.ok ? "ok" : "bad"}`,
  );
  header.append(
    icon("terminal", 13, "glyph"),
    el("span", "run", "verb"),
    el("span", undefined, "spacer"),
    status,
  );
  card.append(header);

  if (item.why) card.append(el("div", item.why, "why"));

  const body = el("div", undefined, "cmd");
  body.append(el("div", item.command, "line"));
  const out = el("pre", item.output, "out");
  body.append(out);
  card.append(body);

  commandNodes.set(item.id, { out, status });
  return card;
}

function planCard(plan: BuildPlan): HTMLElement {
  const card = el("div", undefined, "card plan");
  const header = el("div", undefined, "card-head");
  header.append(icon("compass", 13, "glyph"), el("span", "plan", "verb"));
  card.append(header);

  const body = el("div", undefined, "body");
  body.append(el("h2", plan.title));
  if (plan.summary) body.append(el("p", plan.summary, "summary"));

  if (plan.steps.length > 0) {
    const list = document.createElement("ol");
    for (const step of plan.steps) {
      const li = document.createElement("li");
      li.append(el("div", step.title, "step-title"));
      if (step.files.length > 0) li.append(el("div", step.files.join("  ·  "), "files"));
      if (step.detail) li.append(el("div", step.detail, "detail"));
      list.append(li);
    }
    body.append(list);
  }

  if (plan.risks.length > 0) {
    body.append(el("h4", "Risks"));
    const list = document.createElement("ul");
    for (const risk of plan.risks) list.append(el("li", risk, "risk"));
    body.append(list);
  }
  if (plan.verification.length > 0) {
    body.append(el("h4", "How to verify"));
    const list = document.createElement("ul");
    for (const step of plan.verification) list.append(el("li", step));
    body.append(list);
  }
  card.append(body);

  const actions = el("div", undefined, "actions");
  actions.append(
    button("Build this", "btn primary", () => vscode.postMessage({ type: "approvePlan" })),
    button("Edit plan", "btn ghost", () => vscode.postMessage({ type: "editPlan" })),
    el("span", undefined, "spacer"),
    button("Discard", "btn quiet", () => vscode.postMessage({ type: "discardPlan" })),
  );
  card.append(actions);
  return card;
}

function finishedCard(summary: string, followUps: string[]): HTMLElement {
  const card = el("div", undefined, "card done-card");
  const header = el("div", undefined, "card-head");
  header.append(icon("flag", 13, "glyph"), el("span", "done", "verb"));
  card.append(header);

  const body = el("div", undefined, "body");
  body.append(renderMarkdown(summary));
  if (followUps.length > 0) {
    body.append(el("h4", "Left for later"));
    const list = document.createElement("ul");
    for (const item of followUps) list.append(el("li", item));
    body.append(list);
  }
  card.append(body);
  return card;
}

function permissionCard(request: PermissionCard): HTMLElement {
  const dangerous = request.kind === "delete";
  const card = el("div", undefined, `card ask${dangerous ? " danger" : ""}`);
  askNodes.set(request.id, card);

  const header = el("div", undefined, "card-head");
  header.append(
    icon(askIcon(request.kind), 13, "glyph"),
    el("span", askVerb(request.kind), "verb"),
    el("span", request.subject, "path"),
  );
  if (request.added !== undefined || request.removed !== undefined) {
    header.append(counts(request.added ?? 0, request.removed ?? 0));
  }
  card.append(header);

  if (request.why) card.append(el("div", request.why, "why"));
  if (request.hunks && request.hunks.length > 0) card.append(diffBody(request.hunks));

  const actions = el("div", undefined, "actions");
  const decide = (decision: "allow" | "allowAll" | "reject"): void => {
    vscode.postMessage({ type: "permissionDecision", id: request.id, decision });
    card.remove();
    askNodes.delete(request.id);
  };
  actions.append(button("Allow", "btn primary", () => decide("allow")));
  // A blanket yes to deletions is not something anyone should be able to click
  // once and forget, so it is simply not offered.
  if (!dangerous) {
    const label = request.kind === "command" ? "Allow all commands" : "Allow all edits";
    actions.append(button(label, "btn ghost", () => decide("allowAll")));
  }
  actions.append(el("span", undefined, "spacer"), button("Reject", "btn quiet", () => decide("reject")));
  card.append(actions);
  return card;
}

/** The diff rows, with a marker where lines were skipped between hunks. */
function diffBody(hunks: DiffHunk[]): HTMLElement {
  const body = el("div", undefined, "diff");
  hunks.forEach((hunk, index) => {
    if (index > 0) body.append(el("div", "⋮", "diff-gap"));
    for (const line of hunk.lines) {
      const row = el("div", undefined, `diff-row ${line.kind}`);
      row.append(
        el("span", String(line.newLine ?? line.oldLine ?? ""), "no"),
        el("span", line.text, "txt"),
      );
      body.append(row);
    }
  });
  return body;
}

// --- Composer --------------------------------------------------------------

/**
 * The composer: one box, with its controls inside it.
 *
 * Previously the textarea sat in a bordered box and the controls floated on
 * rows underneath, which read as three separate things stacked up rather than
 * one place where you say what you want. Everything is inside a single rounded
 * surface now, and the surface itself takes the focus ring, so typing lights up
 * the whole control instead of a rectangle inside it.
 */
function renderComposer(): void {
  composer.replaceChildren();
  const inner = el("div", undefined, "inner");

  if (!state.providerLabel) {
    // The start page already carries the whole connect matrix. Repeating a
    // second "connect an account" button under it would be two calls to action
    // for one decision, so the composer stands down while that page is up and
    // speaks only once a thread exists to come back to.
    if (onStartPage) return;
    const empty = el("div", undefined, "composer-box signed-out");
    empty.append(
      el("p", "No AI account is connected yet.", "hint"),
      button("Connect an account", "btn primary", () =>
        vscode.postMessage({ type: "command", command: "ironbase.connectAccount" }),
      ),
    );
    inner.append(empty);
    composer.append(inner);
    return;
  }

  const spec = MODES[mode];
  const box = el("div", undefined, `composer-box mode-${mode}`);
  input.value = draft;
  // A whole-project review takes no brief, so the box says what will happen
  // and stops taking typing rather than accepting a sentence it would drop.
  input.disabled = state.running || spec.brief === "none";
  input.placeholder = state.running ? "Working…" : spec.placeholder;
  box.append(input);

  const bar = el("div", undefined, "composer-bar");

  // Left: the two things you set before sending.
  bar.append(
    iconButton("New build", "plus", () => vscode.postMessage({ type: "newSession" })),
  );

  const modeButton = el("button", undefined, "bar-chip mode-pick");
  modeButton.append(icon(spec.glyph, 13), el("span", spec.label), icon("chevron", 10, "caret"));
  modeButton.title = `${spec.label} — ${spec.blurb}\nClick to choose what IronBase does with what you type.`;
  modeButton.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleModeMenu(modeButton);
  });
  bar.append(modeButton);

  // Edits are the only thing this setting governs, so it goes away in the two
  // modes that never make one rather than sitting there meaning nothing.
  if (spec.kind === "agent") {
    const approve = el("button", undefined, `bar-chip${state.autoAcceptEdits ? " on" : ""}`);
    approve.append(
      icon(state.autoAcceptEdits ? "check" : "signIn", 13),
      el("span", state.autoAcceptEdits ? "Approve for me" : "Ask me"),
    );
    approve.title = state.autoAcceptEdits
      ? "Edits are applied without asking. Deletions and commands still ask. Click to be asked again."
      : "Every edit shows you a diff first. Click to apply edits without asking.";
    approve.addEventListener("click", () =>
      vscode.postMessage({ type: "setAutoAccept", on: !state.autoAcceptEdits }),
    );
    bar.append(approve);
  }
  bar.append(el("span", undefined, "spacer"));

  // Right: which model, and go.
  const model = document.createElement("button");
  model.className = "model-pick";
  model.append(
    icon(state.providerId ? (PROVIDER_ICONS[state.providerId] as IconName) : "key", 12),
    el("span", state.model || "Choose a model"),
  );
  // Deliberately live during a run. The loop re-resolves the account before
  // every step, so switching mid-build genuinely takes effect on the next one —
  // which is exactly when you want it, having just watched it burn through the
  // budget on something a cheaper model could finish.
  model.title = state.running
    ? "Change the account or model — takes effect on the next step"
    : "Change the account or model this build runs on";
  model.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleModelMenu(model);
  });
  bar.append(model);

  if (state.running) {
    const stop = el("button", undefined, "circle-btn stop");
    stop.title = "Stop";
    stop.setAttribute("aria-label", "Stop");
    stop.append(icon("stopCircle", 15));
    stop.addEventListener("click", () => vscode.postMessage({ type: "stop" }));
    bar.append(stop);
  } else {
    const sendButton = el("button", undefined, "circle-btn send");
    sendButton.title = spec.action;
    sendButton.setAttribute("aria-label", spec.action);
    sendButton.append(icon(spec.kind === "agent" ? "send" : "play", 15));
    sendButton.addEventListener("click", send);
    bar.append(sendButton);
  }

  box.append(bar);
  inner.append(box);
  composer.append(inner);

  // Re-appending the textarea drops its focus, so it is restored — but only if
  // the developer was not busy in the editor or in a permission card.
  if (!input.disabled && document.activeElement === document.body) input.focus();
}

/** What the composer draws, so a redraw can be skipped when none of it moved. */
function composerSignature(): string {
  return [
    state.running,
    state.providerLabel ?? "",
    state.model ?? "",
    state.autoAcceptEdits,
    mode,
    onStartPage,
  ].join("|");
}

// --- Modes -----------------------------------------------------------------

interface ModeSpec {
  label: string;
  glyph: IconName;
  /**
   * `agent` modes answer what you type in the thread. `run` modes look at the
   * whole project and end in the report panel — different work with a different
   * output, which is why the menu keeps them in their own group rather than
   * presenting four interchangeable settings.
   */
  kind: "agent" | "run";
  /** Whether what you type is the request, the parameter, or unused. */
  brief: "task" | "target" | "none";
  blurb: string;
  placeholder: string;
  /** What pressing the round button will do, for its tooltip. */
  action: string;
}

const MODES: Record<ComposerMode, ModeSpec> = {
  architect: {
    label: "Plan first",
    glyph: "compass",
    kind: "agent",
    brief: "task",
    blurb: "Explores read-only and hands you a plan to approve",
    placeholder: "Describe a change — it will plan first",
    action: "Send — Enter to send, Shift+Enter for a new line",
  },
  build: {
    label: "Build only",
    glyph: "hammer",
    kind: "agent",
    brief: "task",
    blurb: "Starts writing straight away",
    placeholder: "Describe a change — it will start writing",
    action: "Send — Enter to send, Shift+Enter for a new line",
  },
  review: {
    label: "Analyze",
    glyph: "graph",
    kind: "run",
    brief: "none",
    blurb: "Reviews the whole project and opens a report",
    placeholder: "Reviews the whole project — press send to start",
    action: "Analyze this project's architecture",
  },
  scalability: {
    label: "Scalability",
    glyph: "trend",
    kind: "run",
    brief: "target",
    blurb: "Checks the project against a load you name",
    placeholder: "How many users should it serve? e.g. 10,000 concurrent",
    action: "Run the scalability check",
  },
};

const MODE_GROUPS: Array<{ title: string; modes: ComposerMode[] }> = [
  { title: "Build", modes: ["architect", "build"] },
  { title: "Review the whole project", modes: ["review", "scalability"] },
];

let modeMenu: HTMLElement | undefined;

function closeModeMenu(): void {
  modeMenu?.remove();
  modeMenu = undefined;
}

function toggleModeMenu(anchor: HTMLElement): void {
  if (modeMenu) {
    closeModeMenu();
    return;
  }
  closeModelMenu();
  const menu = el("div", undefined, "popover mode-menu");
  for (const group of MODE_GROUPS) {
    menu.append(el("div", group.title, "popover-group"));
    for (const id of group.modes) {
      const spec = MODES[id];
      const row = el("button", undefined, `popover-row${id === mode ? " current" : ""}`);
      row.append(icon(spec.glyph, 14));
      const body = el("span", undefined, "body");
      body.append(el("span", spec.label, "name"), el("span", spec.blurb, "detail"));
      row.append(body);
      if (id === mode) row.append(icon("check", 13, "tick"));
      row.addEventListener("click", () => {
        closeModeMenu();
        mode = id;
        renderComposer();
      });
      menu.append(row);
    }
  }
  anchor.parentElement?.append(menu);
  modeMenu = menu;
}

/**
 * Retires a plan card's buttons once its plan is no longer the pending one.
 *
 * Approving starts a build, and a "Build this" button still sitting there
 * afterwards invites a second click that would silently do nothing.
 */
function syncPlanActions(): void {
  const cards = thread.querySelectorAll(".plan .actions");
  cards.forEach((actions, index) => {
    // Only the last plan can still be pending; earlier ones are history.
    const live = state.awaitingPlanApproval && index === cards.length - 1;
    actions.querySelectorAll("button").forEach((node) => {
      (node as HTMLButtonElement).disabled = !live;
    });
  });
}

// --- Model menu -------------------------------------------------------------

/**
 * The account and model menu, opening upward from the composer.
 *
 * Its own popover rather than VS Code's quick pick, which always appears at the
 * top of the window — the wrong end entirely for a control sitting at the
 * bottom, and a jump the eye has to follow every time.
 */
let modelMenu: HTMLElement | undefined;

function closeModelMenu(): void {
  modelMenu?.remove();
  modelMenu = undefined;
}

function toggleModelMenu(anchor: HTMLElement): void {
  if (modelMenu) {
    closeModelMenu();
    return;
  }
  closeModeMenu();
  const menu = el("div", undefined, "popover");
  menu.append(el("div", "Loading accounts…", "popover-empty"));
  anchor.parentElement?.append(menu);
  modelMenu = menu;
  vscode.postMessage({ type: "requestModels" });
}

function fillModelMenu(options: ModelOption[]): void {
  const menu = modelMenu;
  if (!menu) return;
  menu.replaceChildren();

  if (options.length === 0) {
    menu.append(el("div", "No accounts are connected.", "popover-empty"));
    return;
  }

  let group = "";
  for (const option of options) {
    if (option.group !== group) {
      group = option.group;
      menu.append(el("div", group, "popover-group"));
    }
    const row = el("button", undefined, `popover-row${option.current ? " current" : ""}`);
    row.append(
      icon(option.providerId ? (PROVIDER_ICONS[option.providerId] as IconName) : "layers", 14),
    );
    const body = el("span", undefined, "body");
    body.append(el("span", option.label, "name"));
    if (option.detail) body.append(el("span", option.detail, "detail"));
    row.append(body);
    if (option.current) row.append(icon("check", 13, "tick"));
    row.addEventListener("click", () => {
      closeModelMenu();
      vscode.postMessage({
        type: "selectModel",
        provider: option.provider,
        model: option.model,
      });
    });
    menu.append(row);
  }
}

function send(): void {
  if (state.running) return;
  const current = mode;
  const text = input.value.trim();

  if (current === "review") {
    vscode.postMessage({ type: "startReview", kind: "review" });
    return;
  }
  if (current === "scalability") {
    // Empty is allowed through: the host owns the modal fallback, and asking
    // there is better than a button that silently does nothing.
    vscode.postMessage({ type: "startReview", kind: "scalability", target: text });
    input.value = "";
    draft = "";
    return;
  }

  if (text.length === 0) return;
  vscode.postMessage({ type: "send", text, mode: current });
  input.value = "";
  draft = "";
}

/**
 * The start page.
 *
 * The panel's first screen used to be a sentence and three examples, which is a
 * thin thing to open a product with — and when nothing was connected it sent
 * people back to the sidebar to sign in, as though the two were different
 * applications. It wears the same mark, wordmark and connect matrix as the
 * sidebar now, from the one implementation of them, and answers the question
 * the reader actually has: the pitch and a way in when signed out, what to type
 * when signed in.
 */
function showStartPage(): void {
  thread.querySelector(".empty")?.remove();
  const wrap = el("div", undefined, "empty");

  if (!state.providerLabel) {
    wrap.append(
      hero({
        headline: "The coding agent that starts from your architecture",
        lede:
          "It maps your codebase first — the dependency graph, where the risk sits — then plans a change against that map and writes the code. Runs on an AI account you already have.",
      }),
    );
    wrap.append(el("h2", "Connect an account", "section"));
    wrap.append(
      ...connectMatrix(new Set(state.sessionCapable ?? []), (id, method) =>
        vscode.postMessage({ type: "connectProvider", id, method }),
      ),
    );
    wrap.append(keychainFootnote());
  } else {
    wrap.append(
      hero({
        headline: "What should IronBase build?",
        lede:
          "It already knows how this project fits together — the index and the dependency map are built. Describe a change and it will plan it first, then write it once you approve.",
      }),
    );
    wrap.append(el("h2", "Try", "section"));
    const examples = el("div", undefined, "examples");
    for (const example of EXAMPLES) {
      examples.append(
        button(example, "", () => {
          input.value = example;
          draft = example;
          input.focus();
        }),
      );
    }
    wrap.append(examples);
    wrap.append(
      el(
        "p",
        "Or use the mode button below to review the whole project instead of changing it.",
        "footnote",
      ),
    );
  }

  thread.append(wrap);
  onStartPage = true;
}

/** What the start page draws, so a redraw can be skipped when none of it moved. */
function startPageSignature(): string {
  return [state.providerLabel ?? "", (state.sessionCapable ?? []).join(",")].join("|");
}

function dropEmptyState(): void {
  const page = thread.querySelector(".empty");
  if (!page) return;
  page.remove();
  onStartPage = false;
  // The composer stands down while the start page is signed out and up, so it
  // has to be built the moment the page goes away.
  renderComposer();
}

// --- Helpers ---------------------------------------------------------------

function counts(added: number, removed: number): HTMLElement {
  const wrap = el("span", undefined, "counts");
  if (added > 0) wrap.append(el("span", `+${added}`, "add"));
  if (added > 0 && removed > 0) wrap.append(document.createTextNode(" "));
  if (removed > 0) wrap.append(el("span", `−${removed}`, "del"));
  return wrap;
}

/**
 * The glyph for a kind of work.
 *
 * A transcript is scanned rather than read — you are hunting for "where did it
 * start editing" down a column of grey lines, and a shape finds that faster
 * than a word does.
 */
function toolIcon(name: string): IconName {
  switch (name) {
    case "read_file":
      return "file";
    case "list_dir":
      return "folder";
    case "find_relevant":
      return "layers";
    case "list_signals":
      return "gauge";
    case "search":
      return "search";
    case "delegate_search":
      return "sparkles";
    case "run_command":
      return "terminal";
    case "update_todos":
      return "checklist";
    case "edit_file":
      return "pencil";
    case "write_file":
      return "filePlus";
    case "delete_file":
      return "trash";
    case "submit_plan":
      return "compass";
    case "finish":
      return "flag";
    default:
      return name.startsWith("mcp__") ? "plug" : "file";
  }
}

/**
 * The word for a kind of work, kept short on purpose.
 *
 * These sit in a fixed column so the arguments line up down the group, and a
 * verb long enough to need two words is a verb that either overflows it or
 * widens it for every other row. An MCP tool keeps its own name minus the
 * routing prefix, which is the only part that identifies it.
 */
function toolVerb(name: string): string {
  switch (name) {
    case "read_file":
      return "read";
    case "list_dir":
      return "list";
    case "find_relevant":
      return "index";
    case "list_signals":
      return "signals";
    case "search":
      return "grep";
    case "delegate_search":
      return "delegate";
    case "update_todos":
      return "tasks";
    case "submit_plan":
      return "plan";
    case "finish":
      return "done";
    default:
      return name.startsWith("mcp__")
        ? name.slice("mcp__".length).replace(/_/g, " ")
        : name.replace(/_/g, " ");
  }
}

function verbFor(kind: "edit" | "create" | "delete"): string {
  return kind === "create" ? "new file" : kind === "delete" ? "deleted" : "edit";
}

function changeIcon(kind: "edit" | "create" | "delete"): IconName {
  return kind === "create" ? "filePlus" : kind === "delete" ? "trash" : "pencil";
}

function askIcon(kind: PermissionCard["kind"]): IconName {
  switch (kind) {
    case "create":
      return "filePlus";
    case "delete":
      return "trash";
    case "command":
      return "terminal";
    default:
      return "pencil";
  }
}

function askVerb(kind: PermissionCard["kind"]): string {
  switch (kind) {
    case "create":
      return "create?";
    case "delete":
      return "delete?";
    case "command":
      return "run?";
    default:
      return "edit?";
  }
}

function formatTokens(n: number): string {
  if (!n) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Sticks to the bottom only when the reader is already there. */
function scrollToEnd(): void {
  const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 160;
  if (nearBottom) thread.scrollTop = thread.scrollHeight;
}

function el(tag: string, text?: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(label: string, className: string, onClick: () => void): HTMLElement {
  const node = el("button", label, className);
  node.addEventListener("click", onClick);
  return node;
}

renderHead();
// The todo rail collapses itself when there is nothing in it, and until that
// runs it is an empty bordered band under the header — visible for as long as
// the first replay takes to arrive.
renderTodos();
showStartPage();
renderComposer();
vscode.postMessage({ type: "ready" });
