import * as vscode from "vscode";
import type { AnalysisReport } from "../engine/findings";
import type { HostMessage, WebviewMessage } from "../protocol";
import { log } from "../util/log";

export class ReportPanel {
  private static current: ReportPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private report: AnalysisReport,
    private readonly root: vscode.Uri,
  ) {
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage(
      (message: WebviewMessage) => this.handleMessage(message),
      undefined,
      this.disposables,
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
  }

  static show(
    extensionUri: vscode.Uri,
    report: AnalysisReport,
    root: vscode.Uri,
  ): ReportPanel {
    if (ReportPanel.current) {
      ReportPanel.current.update(report);
      ReportPanel.current.panel.reveal(vscode.ViewColumn.One);
      return ReportPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      "ironbase.report",
      "Architecture Review",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist")],
      },
    );
    ReportPanel.current = new ReportPanel(panel, extensionUri, report, root);
    return ReportPanel.current;
  }

  static get active(): ReportPanel | undefined {
    return ReportPanel.current;
  }

  get currentReport(): AnalysisReport {
    return this.report;
  }

  update(report: AnalysisReport): void {
    this.report = report;
    this.post({ type: "report", report });
  }

  private post(message: HostMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case "ready":
        this.post({ type: "report", report: this.report });
        break;
      case "openFile":
        await this.openFile(message.file, message.line);
        break;
      case "command":
        await vscode.commands.executeCommand(message.command);
        break;
    }
  }

  private async openFile(file: string, line?: number): Promise<void> {
    const uri = vscode.Uri.joinPath(this.root, ...file.split("/"));
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: false,
      });
      if (line !== undefined) {
        const target = new vscode.Position(Math.max(0, line - 1), 0);
        editor.selection = new vscode.Selection(target, target);
        editor.revealRange(
          new vscode.Range(target, target),
          vscode.TextEditorRevealType.InCenter,
        );
      }
    } catch (err) {
      log.warn(`Could not open ${file}: ${String(err)}`);
      void vscode.window.showWarningMessage(`IronBase could not open ${file}.`);
    }
  }

  private html(): string {
    const nonce = createNonce();
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js"),
    );
    const csp = [
      "default-src 'none'",
      `style-src ${this.panel.webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${this.panel.webview.cspSource}`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Architecture Review</title>
<style>${STYLES}</style>
</head>
<body>
<div id="root"><p class="loading">Loading report…</p></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    ReportPanel.current = undefined;
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

export function createNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

const STYLES = `
/*
 * Severity uses the fixed status palette (good/warning/serious/critical) rather
 * than a categorical one — these encode state, not identity. Every severity is
 * always rendered next to its written label, so colour never carries the meaning
 * on its own; that pairing is what makes the sub-3:1 steps legible.
 */
:root {
  --sev-critical: #d03b3b;
  --sev-high: #ec835a;
  --sev-medium: #fab219;
  --sev-low: #6b7280;
  --sev-info: #8a8a8a;
  --good: #0ca30c;

  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 0.75rem;
  --space-4: 1rem;
  --space-6: 1.5rem;
  --space-8: 2rem;
  --space-12: 3rem;

  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 14px;

  --surface: color-mix(in srgb, var(--vscode-editor-foreground) 3%, var(--vscode-editor-background));
  --surface-raised: color-mix(in srgb, var(--vscode-editor-foreground) 6%, var(--vscode-editor-background));
  --hairline: color-mix(in srgb, var(--vscode-editor-foreground) 12%, transparent);
  --hairline-strong: color-mix(in srgb, var(--vscode-editor-foreground) 20%, transparent);
  --ink-muted: var(--vscode-descriptionForeground);
}
* { box-sizing: border-box; }

body {
  margin: 0;
  padding: 0 var(--space-8) var(--space-12);
  font-family: var(--vscode-font-family);
  font-size: 13px;
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}
#root { max-width: 58rem; margin: 0 auto; }
.loading { color: var(--ink-muted); padding-top: var(--space-8); }

/* ---- Header: the grade is the one hero figure on the page ---- */

header { padding: var(--space-12) 0 var(--space-6); }

.grade-row { display: flex; align-items: flex-start; gap: var(--space-6); }

.grade {
  font-size: 56px;
  font-weight: 300;
  line-height: 1;
  letter-spacing: -0.03em;
  flex: 0 0 auto;
  width: 5rem;
  height: 5rem;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-lg);
  background: var(--surface-raised);
  border: 1px solid var(--hairline);
}
.grade-A, .grade-B { color: var(--good); }
.grade-C { color: var(--sev-medium); }
.grade-D { color: var(--sev-high); }
.grade-F { color: var(--sev-critical); }

.titles { padding-top: var(--space-2); min-width: 0; }
.eyebrow {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--ink-muted);
  margin: 0 0 var(--space-2);
}
h1 {
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.015em;
  margin: 0 0 var(--space-2);
  line-height: 1.25;
}
.meta { color: var(--ink-muted); font-size: 12px; margin: 0; }
.summary {
  margin: var(--space-6) 0 0;
  font-size: 15px;
  line-height: 1.65;
  max-width: 46rem;
}

.notice {
  margin: var(--space-4) 0 0;
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-sm);
  background: var(--surface-raised);
  border-left: 2px solid var(--sev-medium);
  font-size: 12.5px;
  color: var(--ink-muted);
}

.toolbar { display: flex; gap: var(--space-2); margin: var(--space-6) 0 0; flex-wrap: wrap; }
button {
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  padding: 0.45rem 0.9rem;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  transition: opacity 120ms ease;
}
button:hover { opacity: 0.88; }
button.secondary {
  background: transparent;
  color: var(--vscode-foreground);
  border-color: var(--hairline-strong);
}
button.secondary:hover { background: var(--surface-raised); opacity: 1; }

/* ---- Severity counts ---- */

.counts {
  display: flex;
  gap: var(--space-4);
  flex-wrap: wrap;
  margin: var(--space-6) 0 0;
  padding-top: var(--space-4);
  border-top: 1px solid var(--hairline);
}
.count { display: flex; align-items: baseline; gap: var(--space-2); }
.count .dot {
  width: 7px; height: 7px; border-radius: 50%;
  flex: 0 0 auto; align-self: center;
}
.count .n { font-size: 15px; font-weight: 600; }
.count .label { font-size: 11.5px; color: var(--ink-muted); }

/* ---- Section headings ---- */

section { margin-top: var(--space-12); }
h2 {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--ink-muted);
  margin: 0 0 var(--space-4);
  padding-bottom: var(--space-2);
  border-bottom: 1px solid var(--hairline);
}
h3 {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-muted);
  margin: var(--space-6) 0 var(--space-3);
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
h3 .dot { width: 7px; height: 7px; border-radius: 50%; }

/* ---- Finding cards ---- */

details.finding {
  border: 1px solid var(--hairline);
  border-radius: var(--radius-md);
  margin-bottom: var(--space-2);
  background: var(--surface);
  overflow: hidden;
  transition: border-color 120ms ease;
}
details.finding:hover { border-color: var(--hairline-strong); }
details.finding > summary {
  cursor: pointer;
  padding: var(--space-3) var(--space-4);
  list-style: none;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  font-size: 13.5px;
  font-weight: 500;
}
details.finding > summary::-webkit-details-marker { display: none; }
.chev {
  flex: 0 0 auto; width: 9px; height: 9px; opacity: 0.45;
  transition: transform 140ms ease;
}
details.finding[open] .chev { transform: rotate(90deg); }
.finding-title { flex: 1; min-width: 0; }
.tag {
  font-size: 10.5px;
  font-weight: 500;
  letter-spacing: 0.03em;
  padding: 0.12rem 0.5rem;
  border-radius: 999px;
  flex: 0 0 auto;
  color: var(--ink-muted);
  border: 1px solid var(--hairline);
  white-space: nowrap;
}
.finding-body {
  padding: 0 var(--space-4) var(--space-4) calc(var(--space-4) + 9px + var(--space-3));
  font-size: 13px;
}
.finding-body p { margin: 0 0 var(--space-3); max-width: 44rem; }
.fix {
  padding: var(--space-3);
  background: var(--surface-raised);
  border-radius: var(--radius-sm);
  margin-bottom: var(--space-3) !important;
}
.fix strong { font-weight: 600; }
.evidence { display: flex; flex-direction: column; gap: 1px; }
a.ref {
  font-family: var(--vscode-editor-font-family);
  font-size: 11.5px;
  color: var(--vscode-textLink-foreground);
  cursor: pointer;
  text-decoration: none;
  align-self: flex-start;
  padding: 0.15rem 0.4rem;
  margin-left: -0.4rem;
  border-radius: 4px;
}
a.ref:hover { background: var(--surface-raised); text-decoration: underline; }

/* ---- Hotspot tree: where the problems actually are ---- */

.tree-caption { color: var(--ink-muted); font-size: 12.5px; margin: 0 0 var(--space-3); }
.tree {
  border: 1px solid var(--hairline);
  border-radius: var(--radius-md);
  background: var(--surface);
  padding: var(--space-2) 0;
  overflow-x: auto;
}
.tree-row {
  display: flex; align-items: center; gap: var(--space-2);
  padding: 3px var(--space-4) 3px 0;
  font-size: 12.5px; white-space: nowrap;
}
.tree-row .rail {
  width: 2px; height: 14px; border-radius: 1px; flex: 0 0 auto; opacity: 0.55;
}
.tree-row.dir .tree-name { font-weight: 600; }
.tree-row.file .tree-name {
  font-family: var(--vscode-editor-font-family); font-size: 12px;
}
.tree-count {
  font-size: 10.5px; color: var(--ink-muted);
  font-variant-numeric: tabular-nums;
  border: 1px solid var(--hairline); border-radius: 999px;
  padding: 0 6px; margin-left: var(--space-1);
}
.tree-finding {
  display: flex; align-items: center; gap: var(--space-2);
  padding: 3px var(--space-4) 3px 0;
  font-size: 12.5px; cursor: pointer; white-space: nowrap;
  border-radius: 4px; transition: background 100ms ease;
}
.tree-finding:hover { background: var(--surface-raised); }
.tree-finding .dot {
  width: 6px; height: 6px; border-radius: 50%; flex: 0 0 auto; margin-left: 8px;
}
.tree-finding-title { overflow: hidden; text-overflow: ellipsis; }
.tree-line {
  font-family: var(--vscode-editor-font-family); font-size: 11px;
  color: var(--vscode-textLink-foreground); flex: 0 0 auto;
}

/* ---- Scalability: a meter, not a gauge ---- */

.capacity-card {
  border: 1px solid var(--hairline);
  border-radius: var(--radius-lg);
  padding: var(--space-6);
  background: var(--surface);
}
.capacity-head {
  display: flex; justify-content: space-between; align-items: flex-end;
  gap: var(--space-4); flex-wrap: wrap; margin-bottom: var(--space-4);
}
.capacity-block { min-width: 0; }
.capacity-block.right { text-align: right; }
.label {
  font-size: 10px; font-weight: 600; letter-spacing: 0.1em;
  text-transform: uppercase; color: var(--ink-muted); margin: 0 0 var(--space-1);
}
.capacity-value {
  font-size: 17px; font-weight: 600; margin: 0; letter-spacing: -0.01em;
  line-height: 1.35;
}
.capacity-value.target { color: var(--ink-muted); font-weight: 500; }

/* Meter: fill carries severity; the track is a dimmer step of the same colour,
   so the state reads across the whole bar rather than only the filled part. */
.meter {
  height: 8px;
  border-radius: 999px;
  overflow: hidden;
  position: relative;
}
.meter-fill {
  height: 100%;
  border-radius: 999px;
  min-width: 3px;
  transition: width 320ms cubic-bezier(0.4, 0, 0.2, 1);
}
.meter-caption {
  display: flex; justify-content: space-between; gap: var(--space-4);
  margin-top: var(--space-2); font-size: 11.5px; color: var(--ink-muted);
}
.assumptions { margin-top: var(--space-6); padding-top: var(--space-4); border-top: 1px solid var(--hairline); }

/* ---- Bottlenecks ---- */

.bottleneck {
  display: flex;
  gap: var(--space-4);
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--hairline);
}
.bottleneck:last-child { border-bottom: none; }
.rank {
  flex: 0 0 auto;
  width: 1.6rem; height: 1.6rem;
  display: flex; align-items: center; justify-content: center;
  border-radius: 50%;
  background: var(--surface-raised);
  border: 1px solid var(--hairline);
  font-size: 11px; font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--ink-muted);
}
.bottleneck-body { min-width: 0; }
.bottleneck-name { font-weight: 600; font-size: 13px; margin: 0 0 2px; }
.bottleneck-why { margin: 0; font-size: 12.5px; color: var(--ink-muted); max-width: 44rem; }

/* ---- Roadmap ---- */

.phase { display: flex; gap: var(--space-4); padding-bottom: var(--space-6); position: relative; }
.phase:not(:last-child)::before {
  content: ""; position: absolute; left: 5px; top: 1.4rem; bottom: 0;
  width: 1px; background: var(--hairline);
}
.phase-marker {
  flex: 0 0 auto; width: 11px; height: 11px; border-radius: 50%;
  border: 2px solid var(--vscode-textLink-foreground);
  background: var(--vscode-editor-background);
  margin-top: 0.35rem; z-index: 1;
}
.phase-body { min-width: 0; flex: 1; }
.phase h4 { margin: 0 0 var(--space-2); font-size: 13.5px; font-weight: 600; }
.phase ul { margin: 0 0 var(--space-2); padding-left: 1.1rem; }
.phase li { margin-bottom: var(--space-1); font-size: 12.5px; }
.outcome {
  font-size: 11.5px; color: var(--ink-muted); margin: 0;
  padding: var(--space-1) var(--space-2);
  background: var(--surface-raised); border-radius: 4px; display: inline-block;
}

ul { margin: var(--space-2) 0; padding-left: 1.1rem; }
li { margin-bottom: var(--space-1); }
.assumptions li { font-size: 12.5px; color: var(--ink-muted); }

footer {
  margin-top: var(--space-12);
  padding-top: var(--space-4);
  border-top: 1px solid var(--hairline);
  font-size: 11.5px;
  color: var(--ink-muted);
  max-width: 44rem;
}
.empty { color: var(--ink-muted); font-style: italic; }
`;
