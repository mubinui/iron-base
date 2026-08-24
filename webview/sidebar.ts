/**
 * The sidebar: connect an account, start a review, watch it run.
 *
 * This is the first thing anyone sees, so it carries the product's whole first
 * impression — which is why the provider marks are real logos rather than letters
 * in boxes. "Which of my accounts is this?" should be answerable at a glance.
 */

import {
  ALL_PROVIDERS,
  PROVIDER_DETAILS,
  PROVIDER_LABELS,
  type ProviderId,
} from "../src/llm/types";
import type { AllowedCommand, HostMessage, SidebarState, WebviewMessage } from "../src/protocol";
import {
  brandMark,
  capabilityList,
  connectMatrix,
  hero,
  keychainFootnote,
  pricingNote,
  wordmark,
} from "./brand";
import { icon, PROVIDER_ICONS, type IconName } from "./icons";

declare function acquireVsCodeApi(): { postMessage(message: WebviewMessage): void };

const vscode = acquireVsCodeApi();
const root = document.getElementById("root")!;

/**
 * Derived from the engine's own provider list rather than written out again
 * here, so a backend can never be added without a way to connect to it — which
 * is exactly how three of them ended up unreachable.
 */
interface Account {
  id: ProviderId;
  name: string;
  detail: string;
}

const ACCOUNTS: Account[] = ALL_PROVIDERS.map((id) => ({
  id,
  name: PROVIDER_LABELS[id],
  detail: PROVIDER_DETAILS[id],
}));

/** Every card routes through the one picker, which knows how each connects. */
const CONNECT: AllowedCommand = "ironbase.connectAccount";

let stream = "";
let warning = "";
let timerId: number | undefined;

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  if (message.type === "state") {
    if (!message.state.running) {
      stream = "";
      warning = "";
      if (timerId !== undefined) clearInterval(timerId);
    }
    render(message.state);
  } else if (message.type === "progressText") {
    stream = (stream + message.delta).slice(-4000);
    const el = document.getElementById("stream");
    if (el) {
      el.textContent = stream;
      el.scrollTop = el.scrollHeight;
    }
  } else if (message.type === "progressTool") {
    const el = document.getElementById("activity");
    if (el) el.textContent = describeTool(message.name);
  } else if (message.type === "warning") {
    warning = message.text;
    const el = document.getElementById("warning-text");
    if (el) el.textContent = message.text;
  }
});

function describeTool(name: string): string {
  switch (name) {
    case "find_relevant":
      return "Searching the project index…";
    case "list_signals":
      return "Pulling indexed signals…";
    case "read_file":
      return "Reading a file…";
    case "list_dir":
      return "Listing a directory…";
    case "search":
      return "Searching file contents…";
    case "emit_finding":
      return "Recording a finding…";
    case "propose_fix":
      return "Writing a patch…";
    case "emit_report":
      return "Writing the report…";
    default:
      return "Working…";
  }
}

function render(state: SidebarState): void {
  // A pin left on an account that is not connected is its own state, and it has
  // to be said out loud. Falling through to the sign-in page here told someone
  // who had *just* signed in successfully to go and sign in — with no way to
  // discover that a setting, not the sign-in, was the problem.
  const page = state.pinnedMissing
    ? pinBroken(state, state.pinnedMissing)
    : state.providerLabel
      ? connected(state)
      : signedOut(state);
  root.replaceChildren(...page);
  if (state.running) startTimer(state.startedAt);
}

function pinBroken(state: SidebarState, missing: ProviderId): HTMLElement[] {
  const out: HTMLElement[] = [];
  const label = PROVIDER_LABELS[missing];
  const others = (state.connected ?? []).filter((id) => id !== missing);

  const warn = el("div", undefined, "warn");
  warn.append(
    icon("alert", 13),
    el("span", `Settings point at ${label}, which has no stored credential.`),
  );
  out.push(warn);

  out.push(
    el(
      "p",
      others.length > 0
        ? `You are signed in to ${others.map((id) => PROVIDER_LABELS[id]).join(" and ")}. Switch to it and IronBase will work straight away.`
        : `Connect ${label}, or switch to another account.`,
      "muted",
    ),
  );

  out.push(actionButton("Use my connected account", "switchAccount", "ironbase.useConnectedAccount"));
  out.push(linkButton("Choose a different model", "switchAccount", "ironbase.chooseModel"));
  out.push(linkButton("Connect another account", "signIn", CONNECT));

  out.push(el("h2", "Connected"));
  for (const account of ACCOUNTS) {
    if (!others.includes(account.id)) continue;
    out.push(accountCard(account, true, false));
  }
  return out;
}

// --- Signed out ------------------------------------------------------------

function signedOut(state: SidebarState): HTMLElement[] {
  const out: HTMLElement[] = [];
  const sessionCapable = new Set(state.sessionCapable ?? []);

  out.push(
    hero({
      headline: "The coding agent that starts from your architecture",
      lede:
        "It maps your codebase first — the dependency graph, where the risk sits — then plans a change against that map and writes the code. Runs on an AI account you already have.",
    }),
  );

  out.push(sectionLabel("What it does"));
  out.push(capabilityList());
  out.push(pricingNote());

  out.push(sectionLabel("Connect an account"));
  out.push(...connectMatrix(sessionCapable, (id, method) =>
    vscode.postMessage({ type: "connectProvider", id, method }),
  ));
  out.push(keychainFootnote());
  return out;
}

function sectionLabel(text: string): HTMLElement {
  return el("h2", text, "section");
}

function accountCard(account: Account, isConnected: boolean, isActive: boolean): HTMLElement {
  const card = el("button", undefined, `account${isConnected ? " connected" : ""}`);
  const mark = el("span", undefined, "mark");
  mark.append(icon(PROVIDER_ICONS[account.id] as IconName, 17));

  const body = el("span", undefined, "body");
  body.append(
    el("span", account.name, "name"),
    el("span", isActive ? "In use for reviews" : isConnected ? "Connected" : account.detail, "detail"),
  );

  card.append(mark, body);
  if (isActive) {
    card.append(el("span", undefined, "active-dot"));
  } else {
    const go = el("span", undefined, "go");
    go.append(icon(isConnected ? "switchAccount" : "signIn", 15));
    card.append(go);
  }
  card.addEventListener("click", () => vscode.postMessage({ type: "command", command: CONNECT }));
  return card;
}

// --- Connected -------------------------------------------------------------

function connected(state: SidebarState): HTMLElement[] {
  if (state.running) return running(state);

  const out: HTMLElement[] = [];

  // The mark, small. Signed in, this is the screen someone opens every day, so
  // it identifies itself and gets out of the way rather than re-pitching the
  // product at them — that job belongs to the signed-out screen.
  const head = el("div", undefined, "home-head");
  head.append(brandMark(17), wordmark());
  out.push(head);

  // Build leads: reviewing tells you what is wrong, building is what fixes it,
  // and the panel it opens is where someone spends their time. Each of the
  // three says what it does, because "Analyze architecture" and "Scalability
  // check" were bare buttons that gave no reason to press either.
  out.push(
    actionTile(
      "Build something",
      "Describe a change. It plans against the project map, you approve, then it writes the code and runs your tests.",
      "wrench",
      "ironbase.build",
      "primary",
    ),
  );

  out.push(el("h2", "Review the whole project"));
  out.push(
    actionTile(
      "Analyze architecture",
      "What will hurt as this grows — each with a real file and line, on a dependency map.",
      "graph",
      "ironbase.analyze",
    ),
  );
  out.push(
    actionTile(
      "Scalability check",
      "Name the load you want to serve; it ranks what caps you today and plans the way up.",
      "trend",
      "ironbase.scalabilityCheck",
    ),
  );

  if (state.lastSummary) {
    out.push(el("h2", "Last review"));
    const result = el("div", undefined, "result");
    result.append(el("div", state.lastSummary.grade, `grade grade-${state.lastSummary.grade}`));

    const body = el("div", undefined, "body");
    const parts: string[] = [
      `${state.lastSummary.findingCount} finding${state.lastSummary.findingCount === 1 ? "" : "s"}`,
    ];
    if (state.lastSummary.fixCount > 0) {
      parts.push(`${state.lastSummary.fixCount} fix${state.lastSummary.fixCount === 1 ? "" : "es"}`);
    }
    if (state.lastSummary.elapsedMs) parts.push(formatDuration(state.lastSummary.elapsedMs));
    if (state.lastSummary.totalTokens) {
      parts.push(`${formatTokens(state.lastSummary.totalTokens)} tokens`);
    }
    body.append(
      el("div", parts.join("  ·  "), "count"),
      el("div", state.lastSummary.summary, "sum"),
    );
    result.append(body);
    out.push(result);
    out.push(actionButton("Open full report", "graph", "ironbase.showReport", "ghost"));
    out.push(linkButton("Export as Markdown", "download", "ironbase.exportReport"));
  }

  out.push(el("h2", "Account"));
  const connectedIds = new Set(state.connected ?? []);
  for (const account of ACCOUNTS) {
    if (!connectedIds.has(account.id) && account.id !== state.providerId) continue;
    out.push(accountCard(account, true, account.id === state.providerId));
  }
  out.push(el("p", describeAccount(state), "muted"));
  out.push(linkButton("Change model", "switchAccount", "ironbase.chooseModel"));

  // Always the picker, never a guess: jumping straight into whichever provider
  // happened to be first in the list meant "connect another account" started a
  // ChatGPT sign-in for someone who wanted Gemini.
  if (ACCOUNTS.some((a) => !connectedIds.has(a.id) && a.id !== state.providerId)) {
    out.push(linkButton("Connect another account", "signIn", CONNECT));
  }
  out.push(linkButton("Rebuild project index", "refresh", "ironbase.clearIndex"));
  // Disconnecting one account is the common case; wiping every credential is
  // the rare one, so it goes second.
  if (connectedIds.size > 1) {
    out.push(linkButton("Disconnect an account", "signOut", "ironbase.signOutProvider"));
  }
  out.push(linkButton("Sign out of everything", "signOut", "ironbase.signOut"));
  return out;
}

/** "Automatic" is worth saying: the model shown is only what this account
 *  resolved to, not a choice that will hold if the provider changes it. */
function describeAccount(state: SidebarState): string {
  if (!state.model) return `Connected to ${state.providerLabel}.`;
  return state.model.automatic
    ? `Using ${state.model.label}, chosen automatically for this account.`
    : `Pinned to ${state.model.label}.`;
}

// --- Live run --------------------------------------------------------------

function running(state: SidebarState): HTMLElement[] {
  const out: HTMLElement[] = [];

  const status = el("div", undefined, "status");
  const top = el("div", undefined, "top");
  top.append(icon("spinner", 14, "glyph"), el("span", "Reviewing", "headline"));
  if (state.iteration) {
    top.append(el("span", `${state.iteration.current}/${state.iteration.max}`, "muted"));
  }
  status.append(top);

  const activity = el("div", state.activity ?? "Thinking…", "activity");
  activity.id = "activity";
  status.append(activity);

  const telemetry = el("div", undefined, "telemetry");
  const elapsed = stat("0s", "elapsed");
  elapsed.querySelector<HTMLElement>(".v")!.id = "elapsed";
  telemetry.append(elapsed);
  telemetry.append(stat(formatTokens(state.usage?.inputTokens ?? 0), "in", "↑"));
  telemetry.append(stat(formatTokens(state.usage?.outputTokens ?? 0), "out", "↓"));
  if (state.findingCount > 0) {
    telemetry.append(
      stat(String(state.findingCount), state.findingCount === 1 ? "finding" : "findings"),
    );
  }
  if (state.fixCount > 0) {
    telemetry.append(stat(String(state.fixCount), state.fixCount === 1 ? "fix" : "fixes"));
  }
  status.append(telemetry);

  const usage = state.usage;
  if (usage && usage.budget > 0) {
    const used = (usage.inputTokens + usage.outputTokens) / usage.budget;
    const bar = el("div", undefined, "budget");
    const fill = el("div", undefined, "budget-fill");
    fill.style.width = `${Math.min(100, used * 100).toFixed(1)}%`;
    fill.style.background = used > 0.8 ? "var(--sev-medium)" : "var(--accent)";
    bar.append(fill);
    status.append(bar);
  }
  out.push(status);

  const warn = el("div", undefined, "warn");
  warn.id = "warning";
  if (warning) {
    warn.append(icon("alert", 13), el("span", warning));
    warn.querySelector("span")!.id = "warning-text";
  }
  out.push(warn);

  out.push(actionButton("Cancel", "close", "ironbase.cancel", "ghost"));

  const streamEl = el("div", stream);
  streamEl.id = "stream";
  out.push(streamEl);
  return out;
}

function startTimer(startedAt: number | undefined): void {
  if (timerId !== undefined) clearInterval(timerId);
  if (!startedAt) return;
  const tick = (): void => {
    const el2 = document.getElementById("elapsed");
    if (!el2) {
      if (timerId !== undefined) clearInterval(timerId);
      return;
    }
    el2.textContent = formatDuration(Date.now() - startedAt);
  };
  tick();
  timerId = window.setInterval(tick, 1000);
}

// --- Helpers ---------------------------------------------------------------

function stat(value: string, label: string, arrow?: string): HTMLElement {
  const wrap = el("span", undefined, "stat");
  if (arrow) wrap.append(el("span", arrow, "arrow"));
  wrap.append(el("span", value, "v"), el("span", label, "k"));
  return wrap;
}

function formatTokens(n: number): string {
  if (!n) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function el(tag: string, text?: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

/**
 * One thing IronBase can do, with the sentence that explains why you would.
 *
 * The mark carries the colour and the arrow says it goes somewhere; the body
 * is what a bare button could not say.
 */
function actionTile(
  title: string,
  line: string,
  glyph: IconName,
  command: AllowedCommand,
  variant: "primary" | "ghost" = "ghost",
): HTMLElement {
  const tile = el("button", undefined, `tile${variant === "primary" ? " primary" : ""}`);
  const mark = el("span", undefined, "mark");
  mark.append(icon(glyph, 17));
  const body = el("span", undefined, "body");
  body.append(el("span", title, "name"), el("span", line, "line"));
  const go = el("span", undefined, "go");
  go.append(icon("chevron", 13));
  tile.append(mark, body, go);
  tile.addEventListener("click", () => vscode.postMessage({ type: "command", command }));
  return tile;
}

function actionButton(
  label: string,
  glyph: IconName,
  command: AllowedCommand,
  variant: "primary" | "ghost" = "primary",
): HTMLElement {
  const button = el("button", undefined, `action${variant === "ghost" ? " ghost" : ""}`);
  button.append(icon(glyph, 15), el("span", label));
  button.addEventListener("click", () => vscode.postMessage({ type: "command", command }));
  return button;
}

function linkButton(
  label: string,
  glyph: IconName,
  command: AllowedCommand,
): HTMLElement {
  const button = el("button", undefined, "link");
  button.append(icon(glyph, 13), el("span", label));
  button.addEventListener("click", () => vscode.postMessage({ type: "command", command }));
  return button;
}

vscode.postMessage({ type: "ready" });
