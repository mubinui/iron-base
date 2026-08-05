/**
 * The build conversation in an editor tab.
 *
 * One of two surfaces onto `ChatController`, and the optional one: the sidebar
 * is where a build normally lives, and this exists for when a diff deserves the
 * full width of the editor. Both can be open at once and show the same thread,
 * because neither of them owns it.
 *
 * Everything here is about the window. Closing it detaches the surface and
 * nothing else — the build carries on, and the sidebar goes on showing it.
 */

import * as vscode from "vscode";
import { ChatController, type ChatPanelDeps, type ChatSurface } from "./chatController";
import { createNonce } from "../report/reportPanel";
import { CHAT_STYLES } from "../report/styles";
import type { ChatHostMessage, ChatWebviewMessage } from "../protocol";

export class ChatPanel implements ChatSurface {
  private static instance: ChatPanel | undefined;

  /** Opens the tab, or brings the existing one forward. */
  static show(deps: ChatPanelDeps): ChatPanel | undefined {
    if (ChatPanel.instance) {
      ChatPanel.instance.reveal();
      return ChatPanel.instance;
    }
    const controller = ChatController.forWorkspace(deps);
    if (!controller) return undefined;

    ChatPanel.instance = new ChatPanel(deps, controller);
    return ChatPanel.instance;
  }

  static get active(): ChatPanel | undefined {
    return ChatPanel.instance;
  }

  private readonly panel: vscode.WebviewPanel;

  private constructor(
    deps: ChatPanelDeps,
    private readonly controller: ChatController,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "ironbase.chat",
      "IronBase Build",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        // A long build is watched intermittently; rebuilding the thread every
        // time the tab loses focus would throw away scroll position and any
        // expanded diff along with it.
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(deps.extensionUri, "dist")],
      },
    );
    this.panel.iconPath = vscode.Uri.joinPath(deps.extensionUri, "media", "icon.svg");
    this.panel.webview.html = html(this.panel.webview, deps.extensionUri);
    this.panel.webview.onDidReceiveMessage((message: ChatWebviewMessage) =>
      this.controller.handle(message),
    );
    this.panel.onDidDispose(() => {
      this.controller.detach(this);
      ChatPanel.instance = undefined;
    });
    this.controller.attach(this);
  }

  post(message: ChatHostMessage): void {
    void this.panel.webview.postMessage(message);
  }

  reveal(): void {
    this.panel.reveal(this.panel.viewColumn, true);
  }
}

/**
 * The page both surfaces serve.
 *
 * Shared so the sidebar and the tab cannot drift into rendering the
 * conversation two subtly different ways.
 */
export function html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = createNonce();
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "chat.js"));
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
<style>${CHAT_STYLES}</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
