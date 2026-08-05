import * as vscode from "vscode";
import type { AnalysisReport, CodeFix } from "../engine/findings";
import { isAllowedCommand, type HostMessage, type WebviewMessage } from "../protocol";
import { log } from "../util/log";
import { applyFix, previewFix } from "./fixApplier";
import { REPORT_STYLES } from "./styles";

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
        // The webview is our own bundle, but the report it renders is model
        // output — so the command surface it can reach stays a closed list.
        if (isAllowedCommand(message.command)) {
          await vscode.commands.executeCommand(message.command);
        } else {
          log.warn(`Webview asked for a command outside the allowlist: ${message.command}`);
        }
        break;
      case "applyFix":
        await this.applyFix(message.fixId);
        break;
      case "previewFix":
        await this.previewFix(message.fixId);
        break;
      case "copyFix":
        await this.copyFix(message.fixId);
        break;
    }
  }

  private fixById(fixId: string): CodeFix | undefined {
    return this.report.fixes.find((fix) => fix.id === fixId);
  }

  private async applyFix(fixId: string): Promise<void> {
    const fix = this.fixById(fixId);
    if (!fix) return;
    const result = await applyFix(this.root, fix);
    this.post({
      type: "fixResult",
      fixId,
      ok: result.ok,
      message: result.ok
        ? `Applied to ${result.file}:${result.line}. The change is unsaved — review it, then save or undo.`
        : result.reason,
    });
  }

  private async previewFix(fixId: string): Promise<void> {
    const fix = this.fixById(fixId);
    if (!fix) return;
    const problem = await previewFix(this.root, fix);
    if (problem) {
      this.post({ type: "fixResult", fixId, ok: false, message: problem });
    }
  }

  private async copyFix(fixId: string): Promise<void> {
    const fix = this.fixById(fixId);
    if (!fix) return;
    await vscode.env.clipboard.writeText(fix.replacement);
    this.post({ type: "fixResult", fixId, ok: true, message: "Copied to the clipboard." });
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
<style>${REPORT_STYLES}</style>
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

