import * as vscode from "vscode";
import type { HostMessage, SidebarState, WebviewMessage } from "../protocol";
import { createNonce } from "./reportPanel";

export class SidebarView implements vscode.WebviewViewProvider {
  static readonly viewType = "ironbase.sidebar";

  private view: vscode.WebviewView | undefined;
  private state: SidebarState = {
    providerLabel: undefined,
    running: false,
    findingCount: 0,
  };

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message: WebviewMessage) => {
      if (message.type === "ready") {
        this.post({ type: "state", state: this.state });
      } else if (message.type === "command") {
        void vscode.commands.executeCommand(message.command);
      }
    });
    this.post({ type: "state", state: this.state });
  }

  setState(patch: Partial<SidebarState>): void {
    this.state = { ...this.state, ...patch };
    this.post({ type: "state", state: this.state });
  }

  get currentState(): SidebarState {
    return this.state;
  }

  appendText(delta: string): void {
    this.post({ type: "progressText", delta });
  }

  noteTool(name: string): void {
    this.post({ type: "progressTool", name });
  }

  noteWarning(text: string): void {
    this.post({ type: "warning", text });
  }

  reveal(): void {
    void vscode.commands.executeCommand("ironbase.sidebar.focus");
  }

  private post(message: HostMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private html(webview: vscode.Webview): string {
    const nonce = createNonce();
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
:root {
  --surface: color-mix(in srgb, var(--vscode-sideBar-foreground, var(--vscode-foreground)) 4%, transparent);
  --surface-raised: color-mix(in srgb, var(--vscode-sideBar-foreground, var(--vscode-foreground)) 8%, transparent);
  --hairline: color-mix(in srgb, var(--vscode-sideBar-foreground, var(--vscode-foreground)) 13%, transparent);
  --ink-muted: var(--vscode-descriptionForeground);
  --good: #0ca30c;
  --sev-medium: #fab219;
  --sev-high: #ec835a;
  --sev-critical: #d03b3b;
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 14px 12px 24px;
  font-family: var(--vscode-font-family); font-size: 12.5px;
  color: var(--vscode-foreground); line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
h2 {
  font-size: 10px; font-weight: 600; letter-spacing: 0.11em; text-transform: uppercase;
  color: var(--ink-muted); margin: 22px 0 8px;
}
h2:first-child { margin-top: 0; }
p { margin: 0 0 10px; }
.muted { color: var(--ink-muted); font-size: 11.5px; line-height: 1.5; }

/* ---- Account cards ---- */

.account {
  display: flex; align-items: center; gap: 10px; width: 100%;
  padding: 10px 12px; margin-bottom: 6px;
  border-radius: 8px; border: 1px solid var(--hairline);
  background: var(--surface); color: var(--vscode-foreground);
  font-family: inherit; font-size: 12.5px; text-align: left; cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease;
}
.account:hover { background: var(--surface-raised); border-color: var(--vscode-focusBorder); }
.account .mark {
  flex: 0 0 auto; width: 26px; height: 26px; border-radius: 7px;
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 600; letter-spacing: -0.02em;
  background: var(--surface-raised); color: var(--ink-muted);
}
.account .body { min-width: 0; flex: 1; }
.account .name { font-weight: 600; display: block; }
.account .detail { color: var(--ink-muted); font-size: 11px; display: block; }

/* ---- Primary actions ---- */

button.action {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 9px 12px; margin-bottom: 6px;
  border-radius: 8px; border: none; cursor: pointer;
  font-family: inherit; font-size: 12.5px; font-weight: 500; text-align: left;
  background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  transition: opacity 120ms ease;
}
button.action:hover { opacity: 0.88; }
button.ghost {
  background: transparent; color: var(--vscode-foreground);
  border: 1px solid var(--hairline);
}
button.ghost:hover { background: var(--surface-raised); opacity: 1; }
button.link {
  background: none; border: none; padding: 3px 0; width: auto;
  color: var(--vscode-textLink-foreground); cursor: pointer;
  font-family: inherit; font-size: 11.5px; text-align: left;
}
button.link:hover { text-decoration: underline; }

/* ---- Live run status ---- */

.status {
  padding: 12px; border-radius: 8px; margin-bottom: 10px;
  background: var(--surface); border: 1px solid var(--hairline);
}
.status .top { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.status .headline { font-weight: 600; font-size: 12.5px; flex: 1; }

/* Rotating glyph — motion signals "working" more honestly than a static dot. */
.glyph {
  flex: 0 0 auto; width: 13px; height: 13px;
  color: var(--vscode-progressBar-background, var(--vscode-textLink-foreground));
  animation: spin 1.5s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* Live telemetry row: elapsed, tokens in, tokens out. */
.telemetry {
  display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
  margin-top: 9px; padding-top: 9px; border-top: 1px solid var(--hairline);
  font-variant-numeric: tabular-nums;
}
.stat { display: flex; align-items: baseline; gap: 3px; }
.stat .v { font-size: 13px; font-weight: 600; }
.stat .k { font-size: 10px; color: var(--ink-muted); letter-spacing: 0.03em; }
.stat .arrow { font-size: 10px; color: var(--ink-muted); }
.budget {
  height: 2px; border-radius: 999px; margin-top: 8px; overflow: hidden;
  background: var(--surface-raised);
}
.budget-fill { height: 100%; border-radius: 999px; transition: width 400ms ease; }
.status .activity {
  color: var(--ink-muted); font-size: 11.5px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.track {
  height: 3px; border-radius: 999px; margin-top: 9px; overflow: hidden;
  background: var(--surface-raised);
}
.track-fill {
  height: 100%; border-radius: 999px;
  background: var(--vscode-progressBar-background, var(--vscode-textLink-foreground));
  transition: width 300ms cubic-bezier(0.4, 0, 0.2, 1);
}
.counter {
  display: flex; align-items: baseline; gap: 5px; margin-top: 9px;
  padding-top: 9px; border-top: 1px solid var(--hairline);
}
.counter .n { font-size: 15px; font-weight: 600; }
.counter .label { font-size: 11px; color: var(--ink-muted); }
#stream {
  font-family: var(--vscode-editor-font-family); font-size: 11px; line-height: 1.5;
  white-space: pre-wrap; word-break: break-word; max-height: 13rem; overflow-y: auto;
  color: var(--ink-muted); margin-top: 10px; padding: 10px;
  background: var(--surface); border-radius: 8px; border: 1px solid var(--hairline);
}
.warn {
  color: var(--sev-medium); font-size: 11.5px; margin-bottom: 8px;
}
.warn:empty { display: none; }

/* ---- Last result ---- */

.result {
  display: flex; align-items: center; gap: 12px;
  padding: 12px; border-radius: 8px; margin-bottom: 8px;
  background: var(--surface); border: 1px solid var(--hairline);
}
.result .grade {
  flex: 0 0 auto; width: 38px; height: 38px; border-radius: 9px;
  display: flex; align-items: center; justify-content: center;
  font-size: 20px; font-weight: 300; letter-spacing: -0.02em;
  background: var(--surface-raised);
}
.grade-A, .grade-B { color: var(--good); }
.grade-C { color: var(--sev-medium); }
.grade-D { color: var(--sev-high); }
.grade-F { color: var(--sev-critical); }
.result .body { min-width: 0; }
.result .count { font-weight: 600; font-size: 12.5px; }
.result .sum {
  color: var(--ink-muted); font-size: 11.5px; line-height: 1.45;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
}
.footnote {
  margin-top: 20px; padding-top: 12px; border-top: 1px solid var(--hairline);
  font-size: 11px; color: var(--ink-muted); line-height: 1.5;
}
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const root = document.getElementById("root");
let stream = "";
let warning = "";

const ACCOUNTS = [
  { mark: "C", name: "Claude", detail: "Pro or Max subscription", cmd: "ironbase.signInAnthropic" },
  { mark: "G", name: "ChatGPT", detail: "Plus or Pro subscription", cmd: "ironbase.signInOpenAi" },
  { mark: "◆", name: "Gemini", detail: "Google account — needs a free client, ~1 min", cmd: "ironbase.signInGoogle" },
];

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg.type === "state") {
    if (!msg.state.running) { stream = ""; warning = ""; clearInterval(timerId); }
    render(msg.state);
  } else if (msg.type === "progressText") {
    stream = (stream + msg.delta).slice(-4000);
    const el = document.getElementById("stream");
    if (el) { el.textContent = stream; el.scrollTop = el.scrollHeight; }
  } else if (msg.type === "progressTool") {
    const el = document.getElementById("activity");
    if (el) { el.textContent = describeTool(msg.name); }
  } else if (msg.type === "warning") {
    warning = msg.text;
    const el = document.getElementById("warning");
    if (el) { el.textContent = msg.text; }
  }
});

function describeTool(name) {
  switch (name) {
    case "find_relevant": return "Searching the project index…";
    case "list_signals": return "Pulling indexed signals…";
    case "read_file": return "Reading a file…";
    case "list_dir": return "Listing a directory…";
    case "search": return "Searching file contents…";
    case "emit_finding": return "Recording a finding…";
    case "emit_report": return "Writing the report…";
    default: return "Working…";
  }
}

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(text, command, className) {
  const b = el("button", text, className || "action");
  b.addEventListener("click", () => vscode.postMessage({ type: "command", command }));
  return b;
}

function accountCard(account) {
  const card = el("button", undefined, "account");
  const mark = el("span", account.mark, "mark");
  const body = el("span", undefined, "body");
  body.append(el("span", account.name, "name"), el("span", account.detail, "detail"));
  card.append(mark, body);
  card.addEventListener("click", () => vscode.postMessage({ type: "command", command: account.cmd }));
  return card;
}


function glyph() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "glyph");
  const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  c.setAttribute("cx", "8"); c.setAttribute("cy", "8"); c.setAttribute("r", "6");
  c.setAttribute("fill", "none"); c.setAttribute("stroke", "currentColor");
  c.setAttribute("stroke-width", "2"); c.setAttribute("stroke-linecap", "round");
  c.setAttribute("stroke-dasharray", "28"); c.setAttribute("stroke-dashoffset", "20");
  svg.append(c);
  return svg;
}

function stat(value, label, arrow) {
  const wrap = el("span", undefined, "stat");
  if (arrow) wrap.append(el("span", arrow, "arrow"));
  wrap.append(el("span", value, "v"), el("span", label, "k"));
  return wrap;
}

function fmtTokens(n) {
  if (!n) return "0";
  if (n < 1000) return String(n);
  if (n < 1000000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + "k";
  return (n / 1000000).toFixed(1) + "M";
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  return m + "m " + (s % 60) + "s";
}

let timerId;
function startTimer(startedAt) {
  clearInterval(timerId);
  if (!startedAt) return;
  const tick = () => {
    const el2 = document.getElementById("elapsed");
    if (!el2) { clearInterval(timerId); return; }
    el2.textContent = fmtDuration(Date.now() - startedAt);
  };
  tick();
  timerId = setInterval(tick, 1000);
}

function render(state) {
  const nodes = [];

  if (!state.providerLabel) {
    nodes.push(el("h2", "Connect an account"));
    nodes.push(el("p", "IronBase reviews your code using an AI account you already have. No API key, no extra billing.", "muted"));
    for (const account of ACCOUNTS) nodes.push(accountCard(account));
    nodes.push(el("div", "Your sign-in is stored in the system keychain and is only ever sent to that provider.", "footnote"));
    root.replaceChildren(...nodes);
    return;
  }

  if (state.running) {
    const status = el("div", undefined, "status");
    const top = el("div", undefined, "top");
    top.append(glyph(), el("span", "Reviewing", "headline"));
    if (state.iteration) {
      top.append(el("span", state.iteration.current + "/" + state.iteration.max, "muted"));
    }
    status.append(top);

    const activity = el("div", state.activity || "Thinking\u2026", "activity");
    activity.id = "activity";
    status.append(activity);

    // Elapsed + token spend, the two numbers that tell you a long run is healthy.
    const tel = el("div", undefined, "telemetry");
    const elapsed = stat("0s", "elapsed");
    elapsed.querySelector(".v").id = "elapsed";
    tel.append(elapsed);
    const u = state.usage;
    tel.append(stat(fmtTokens(u ? u.inputTokens : 0), "in", "\u2191"));
    tel.append(stat(fmtTokens(u ? u.outputTokens : 0), "out", "\u2193"));
    if (state.findingCount > 0) {
      tel.append(stat(String(state.findingCount), state.findingCount === 1 ? "finding" : "findings"));
    }
    status.append(tel);

    if (u && u.budget > 0) {
      const used = (u.inputTokens + u.outputTokens) / u.budget;
      const bar = el("div", undefined, "budget");
      const fill = el("div", undefined, "budget-fill");
      fill.style.width = Math.min(100, used * 100).toFixed(1) + "%";
      fill.style.background = used > 0.8
        ? "var(--sev-medium)"
        : "var(--vscode-progressBar-background, var(--vscode-textLink-foreground))";
      bar.append(fill);
      status.append(bar);
    }
    nodes.push(status);

    const warn = el("div", warning, "warn");
    warn.id = "warning";
    nodes.push(warn);
    nodes.push(button("Cancel", "ironbase.cancel", "action ghost"));

    const streamEl = el("div", stream, undefined);
    streamEl.id = "stream";
    nodes.push(streamEl);
    root.replaceChildren(...nodes);
    startTimer(state.startedAt);
    return;
  }

  nodes.push(el("h2", "Review"));
  nodes.push(button("Analyze architecture", "ironbase.analyze"));
  nodes.push(button("Scalability check…", "ironbase.scalabilityCheck", "action ghost"));

  if (state.lastSummary) {
    nodes.push(el("h2", "Last review"));
    const result = el("div", undefined, "result");
    result.append(el("div", state.lastSummary.grade, "grade grade-" + state.lastSummary.grade));
    const body = el("div", undefined, "body");
    const n = state.lastSummary.findingCount;
    const meta = [];
    if (state.lastSummary.elapsedMs) meta.push(fmtDuration(state.lastSummary.elapsedMs));
    if (state.lastSummary.totalTokens) meta.push(fmtTokens(state.lastSummary.totalTokens) + " tokens");
    body.append(
      el("div", n + (n === 1 ? " finding" : " findings") + (meta.length ? "  ·  " + meta.join("  ·  ") : ""), "count"),
      el("div", state.lastSummary.summary, "sum"),
    );
    result.append(body);
    nodes.push(result);
    nodes.push(button("Open full report", "ironbase.showReport", "action ghost"));
    nodes.push(button("Export as Markdown", "ironbase.exportReport", "link"));
  }

  nodes.push(el("h2", "Account"));
  nodes.push(el("p", "Connected to " + state.providerLabel + ".", "muted"));
  nodes.push(button("Connect a different account", "ironbase.signInAnthropic", "link"));
  nodes.push(button("Rebuild project index", "ironbase.clearIndex", "link"));
  nodes.push(button("Sign out", "ironbase.signOut", "link"));

  root.replaceChildren(...nodes);
}

vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
  }
}
