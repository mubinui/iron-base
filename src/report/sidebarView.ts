import * as vscode from "vscode";
import { isAllowedCommand, type HostMessage, type SidebarState, type WebviewMessage } from "../protocol";
import { log } from "../util/log";
import { createNonce } from "./reportPanel";
import { SIDEBAR_STYLES } from "./styles";

export class SidebarView implements vscode.WebviewViewProvider {
  static readonly viewType = "ironbase.sidebar";

  private view: vscode.WebviewView | undefined;
  private state: SidebarState = {
    providerLabel: undefined,
    running: false,
    findingCount: 0,
    fixCount: 0,
  };

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message: WebviewMessage) => {
      if (message.type === "ready") {
        this.post({ type: "state", state: this.state });
      } else if (message.type === "command") {
        if (isAllowedCommand(message.command)) {
          void vscode.commands.executeCommand(message.command);
        } else {
          log.warn(`Sidebar asked for a command outside the allowlist: ${message.command}`);
        }
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
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "sidebar.js"),
    );
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${SIDEBAR_STYLES}</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
