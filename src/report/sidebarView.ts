/**
 * The sidebar: two screens in one view.
 *
 * Home is accounts and the two ways in. Build is the conversation. They swap in
 * place rather than the build opening an editor tab, because the sidebar is
 * where you already are when you ask for something — being thrown into a new
 * tab to answer a permission prompt is a context switch nobody asked for.
 *
 * Swapping means replacing the webview's HTML, which throws away everything the
 * page had. That is safe here only because neither screen owns its own state:
 * home rebuilds from `SidebarState`, and the conversation is replayed from
 * `ChatController` the moment the new page says it is ready.
 */

import * as vscode from "vscode";
import type { ChatController, ChatSurface } from "../chat/chatController";
import { html as chatHtml } from "../chat/chatPanel";
import { ALL_PROVIDERS, supportsMethod, type ProviderId } from "../llm/types";
import {
  isAllowedCommand,
  type ChatHostMessage,
  type ChatWebviewMessage,
  type HostMessage,
  type SidebarState,
  type WebviewMessage,
} from "../protocol";
import { log } from "../util/log";

/** Narrows an untrusted string off the message channel to a real provider id. */
function isProvider(value: unknown): value is ProviderId {
  return typeof value === "string" && (ALL_PROVIDERS as string[]).includes(value);
}
import { createNonce } from "./reportPanel";
import { SIDEBAR_STYLES } from "./styles";

export type SidebarScreen = "home" | "build";

export class SidebarView implements vscode.WebviewViewProvider, ChatSurface {
  static readonly viewType = "ironbase.sidebar";

  private view: vscode.WebviewView | undefined;
  private screen: SidebarScreen = "home";
  private controller: ChatController | undefined;
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
    view.onDidDispose(() => {
      this.detachController();
      this.view = undefined;
    });
    view.webview.onDidReceiveMessage((message: WebviewMessage | ChatWebviewMessage) =>
      this.onMessage(message),
    );
    this.renderScreen();
  }

  // --- Screens ---------------------------------------------------------------

  /**
   * Shows the conversation in the sidebar, attaching to the controller.
   *
   * Idempotent: asking for the build screen while it is already up just brings
   * the sidebar forward, which is what the command should do on a second press.
   */
  showBuild(controller: ChatController): void {
    this.reveal();
    if (this.screen === "build" && this.controller === controller) return;
    this.detachController();
    this.controller = controller;
    this.screen = "build";
    this.renderScreen();
  }

  showHome(): void {
    if (this.screen === "home") return;
    this.detachController();
    this.screen = "home";
    this.renderScreen();
  }

  get currentScreen(): SidebarScreen {
    return this.screen;
  }

  private detachController(): void {
    if (!this.controller) return;
    this.controller.detach(this);
    this.controller = undefined;
  }

  /**
   * Rebuilds the page for the current screen.
   *
   * The controller is attached only *after* the HTML is set: attaching replays
   * the whole thread, and a page that has not loaded yet would drop it. The new
   * page asks again with `ready` regardless, so this is belt and braces.
   */
  private renderScreen(): void {
    const view = this.view;
    if (!view) return;

    view.webview.html =
      this.screen === "build"
        ? chatHtml(view.webview, this.extensionUri)
        : this.homeHtml(view.webview);

    if (this.screen === "build" && this.controller) {
      this.controller.attach(this);
    } else {
      this.post({ type: "state", state: this.state });
    }
  }

  // --- ChatSurface -----------------------------------------------------------

  post(message: ChatHostMessage | HostMessage): void {
    void this.view?.webview.postMessage(message);
  }

  reveal(): void {
    void vscode.commands.executeCommand("ironbase.sidebar.focus");
  }

  // --- Home state ------------------------------------------------------------

  setState(patch: Partial<SidebarState>): void {
    this.state = { ...this.state, ...patch };
    // Only the home screen draws this. Posting it to the build page would be
    // a message it has no case for.
    if (this.screen === "home") this.post({ type: "state", state: this.state });
  }

  get currentState(): SidebarState {
    return this.state;
  }

  appendText(delta: string): void {
    if (this.screen === "home") this.post({ type: "progressText", delta });
  }

  noteTool(name: string): void {
    if (this.screen === "home") this.post({ type: "progressTool", name });
  }

  noteWarning(text: string): void {
    if (this.screen === "home") this.post({ type: "warning", text });
  }

  // --- Messages --------------------------------------------------------------

  private onMessage(message: WebviewMessage | ChatWebviewMessage): void {
    // The build page's messages belong to the controller, and its own `ready`
    // means "replay the thread" rather than "send me the sidebar state".
    if (this.screen === "build" && this.controller) {
      if (message.type === "command" && isAllowedCommand(message.command)) {
        void vscode.commands.executeCommand(message.command);
        return;
      }
      this.controller.handle(message as ChatWebviewMessage);
      return;
    }

    if (message.type === "ready") {
      this.post({ type: "state", state: this.state });
    } else if (message.type === "command") {
      if (isAllowedCommand(message.command)) {
        void vscode.commands.executeCommand(message.command);
      } else {
        log.warn(`Sidebar asked for a command outside the allowlist: ${message.command}`);
      }
    } else if (message.type === "connectProvider") {
      // The provider and method come off a channel that also carries
      // model-generated content on other surfaces, so both are checked against
      // the real matrix before anything is dispatched — a bad pair is dropped,
      // not guessed at.
      if (isProvider(message.id) && supportsMethod(message.id, message.method)) {
        void vscode.commands.executeCommand(
          "ironbase.internal.connect",
          message.id,
          message.method,
        );
      } else {
        log.warn(`Sidebar asked to connect an unknown pair: ${message.id}/${message.method}`);
      }
    } else if (message.type === "disconnectProvider") {
      if (isProvider(message.id)) {
        void vscode.commands.executeCommand("ironbase.signOutProvider", message.id);
      }
    }
  }

  private homeHtml(webview: vscode.Webview): string {
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
