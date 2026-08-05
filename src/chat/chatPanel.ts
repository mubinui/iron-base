/**
 * The build panel: where a task is described and watched as it happens.
 *
 * The host half. It owns the session, turns its events into thread items, and
 * answers the webview's clicks. Two of its jobs are less obvious than the rest.
 *
 * It is the permission prompter. When the session needs an answer it calls in
 * here, a card goes on screen, and the promise stays open until the developer
 * clicks — or until the panel closes, which rejects every outstanding request
 * rather than leaving the run parked forever.
 *
 * It also keeps the thread. The webview can be disposed and rebuilt at any time
 * — closing the tab, moving it to another group — and everything on screen has
 * to come back. So the thread lives here as data and the webview replays it,
 * which also means no rendering state is ever the source of truth.
 */

import * as vscode from "vscode";
import type { AuthManager } from "../auth/authManager";
import { getConfig } from "../config";
import { CodingSession, type SessionEvent } from "../engine/codingSession";
import type { PermissionDecision, PermissionRequest } from "../engine/permissions";
import { renderPlanMarkdown, type Todo } from "../engine/plan";
import { updateIndex } from "../memory/indexer";
import { rememberBuild } from "../memory/buildMemory";
import { McpRegistry } from "../mcp/registry";
import type { IndexStore } from "../memory/store";
import { exportBuild } from "./buildExport";
import {
  SessionStore,
  relativeTime,
  titleFromTask,
  type StoredSession,
} from "./sessionStore";
import { scanWorkspace } from "../scanner/workspaceScanner";
import { createNonce } from "../report/reportPanel";
import { CHAT_STYLES } from "../report/styles";
import { PROVIDER_LABELS } from "../llm/types";
import { log } from "../util/log";
import { resolveInside } from "../util/paths";
import {
  type ChatHostMessage,
  type ChatState,
  type ChatWebviewMessage,
  type PermissionCard,
  type ThreadItem,
  isAllowedCommand,
} from "../protocol";

/** Scheme for the read-only "as it was before IronBase touched it" side of a diff. */
const ORIGINAL_SCHEME = "ironbase-original";

export interface ChatPanelDeps {
  extensionUri: vscode.Uri;
  auth: AuthManager;
  indexStore: IndexStore;
  sessionStore: SessionStore;
}

/** How long after the last event the session is written out. */
const SAVE_DEBOUNCE_MS = 1500;

export class ChatPanel {
  private static instance: ChatPanel | undefined;

  static show(deps: ChatPanelDeps): ChatPanel | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      void vscode.window.showWarningMessage(
        "IronBase needs an open folder to build in. Open your project first.",
      );
      return undefined;
    }
    if (ChatPanel.instance) {
      ChatPanel.instance.panel.reveal(vscode.ViewColumn.Beside);
      return ChatPanel.instance;
    }
    ChatPanel.instance = new ChatPanel(deps, folder);
    return ChatPanel.instance;
  }

  static get active(): ChatPanel | undefined {
    return ChatPanel.instance;
  }

  /**
   * Serves the pre-change content of a file, for the side-by-side diff.
   *
   * It comes from the checkpoint rather than from a second copy kept here, so
   * "before" in the diff view is exactly what Revert would put back — one
   * source of truth for both, and no way for them to drift apart.
   */
  static registerOriginalProvider(): vscode.Disposable {
    return vscode.workspace.registerTextDocumentContentProvider(ORIGINAL_SCHEME, {
      provideTextDocumentContent(uri) {
        const file = uri.path.replace(/^\//, "");
        return ChatPanel.instance?.session?.checkpoint.originalOf(file) ?? "";
      },
    });
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly thread: ThreadItem[] = [];
  /**
   * Questions on screen with nobody's answer yet.
   *
   * The kind is kept alongside the resolver because clicking "Allow all edits"
   * on a card is the same act as flipping the composer's toggle, and the two
   * have to agree afterwards or the toggle is lying about what will happen next.
   */
  private readonly pending = new Map<
    string,
    { kind: PermissionRequest["kind"]; resolve: (decision: PermissionDecision) => void }
  >();

  private session: CodingSession | undefined;
  private preparing: Promise<CodingSession | undefined> | undefined;
  private todos: Todo[] = [];
  private permissionCounter = 0;
  private state: ChatState;
  /** Set while the model is streaming, so deltas append to one bubble. */
  private streaming = false;

  private readonly workspaceKey: string;
  private sessionId: string;
  private sessionTitle = "New build";
  private sessionCreatedAt = new Date().toISOString();
  /**
   * The saved session waiting to be put back once the index has been built.
   *
   * Restoring the thread has to happen immediately — a panel that opens empty
   * and fills in ten seconds later reads as data loss — but restoring the
   * transcript needs a `CodingSession`, and building one means scanning first.
   */
  private pendingRestore: StoredSession | undefined;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly mcp = new McpRegistry();
  /** The index the session reads and writes; kept so builds can be remembered. */
  private index: Awaited<ReturnType<IndexStore["load"]>> | undefined;

  private constructor(
    private readonly deps: ChatPanelDeps,
    private readonly folder: vscode.WorkspaceFolder,
  ) {
    this.workspaceKey = SessionStore.keyFor(folder.uri);
    this.sessionId = SessionStore.newId();
    this.state = {
      workspaceName: folder.name,
      running: false,
      agent: "architect",
      awaitingPlanApproval: false,
      autoAcceptEdits: false,
      changedFiles: 0,
      sessionTitle: this.sessionTitle,
    };

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
    this.panel.webview.html = this.html();
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((message: ChatWebviewMessage) =>
        this.onMessage(message),
      ),
      this.deps.auth.onDidChange(() => void this.refreshAccount()),
    );
    this.panel.onDidDispose(() => this.dispose());
    void this.refreshAccount();
    void this.resumeMostRecent();
  }

  private dispose(): void {
    // Anything still waiting on a click will never get one now.
    this.closePending();
    this.session?.stop();
    this.mcp.dispose();
    // Written synchronously rather than through the debounce, which is about to
    // stop existing along with the panel.
    void this.persist();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    for (const item of this.disposables) item.dispose();
    ChatPanel.instance = undefined;
  }

  // --- Saved sessions --------------------------------------------------------

  /**
   * Reopens the last build in this workspace.
   *
   * The thread and the checkpoint go back immediately; the transcript waits for
   * the index, because until then there is no session object to put it in.
   */
  private async resumeMostRecent(): Promise<void> {
    const saved = await this.deps.sessionStore.mostRecent(this.workspaceKey);
    if (!saved || this.thread.length > 0) return;
    this.adopt(saved);
  }

  private adopt(saved: StoredSession): void {
    this.sessionId = saved.id;
    this.sessionTitle = saved.title;
    this.sessionCreatedAt = saved.createdAt;
    this.thread.length = 0;
    this.thread.push(...saved.thread);
    this.todos = saved.todos;
    this.pendingRestore = saved;

    if (this.session) {
      this.session.restore(this.snapshotFrom(saved));
      this.session.checkpoint.hydrate(saved.checkpoint);
      this.pendingRestore = undefined;
    }

    this.post({ type: "replay", thread: this.thread, todos: this.todos });
    this.patchState({
      sessionTitle: saved.title,
      agent: saved.agent,
      awaitingPlanApproval: saved.pendingPlan !== undefined,
      changedFiles: saved.checkpoint.length,
      usage:
        saved.usage.inputTokens + saved.usage.outputTokens > 0
          ? {
              inputTokens: saved.usage.inputTokens,
              outputTokens: saved.usage.outputTokens,
              budget: getConfig().maxSessionTokens,
            }
          : undefined,
    });

    if (saved.checkpointTrimmed) {
      this.append({
        kind: "notice",
        level: "warning",
        text:
          "This build changed more than IronBase could store, so its undo history did not survive the reload. " +
          "The files themselves are untouched — use git to review them.",
      });
    }
  }

  private snapshotFrom(saved: StoredSession): Parameters<CodingSession["restore"]>[0] {
    return {
      agent: saved.agent,
      messages: saved.messages,
      todos: saved.todos,
      pendingPlan: saved.pendingPlan,
      lastTask: saved.lastTask,
      usage: saved.usage,
    };
  }

  /** Queues a save. Events arrive in bursts, and each one need not hit the disk. */
  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.persist(), SAVE_DEBOUNCE_MS);
  }

  private async persist(): Promise<void> {
    if (this.thread.length === 0) return;
    const snapshot = this.session?.snapshot();
    await this.deps.sessionStore.save({
      id: this.sessionId,
      version: 1,
      workspaceKey: this.workspaceKey,
      title: this.sessionTitle,
      createdAt: this.sessionCreatedAt,
      updatedAt: new Date().toISOString(),
      agent: snapshot?.agent ?? this.state.agent,
      thread: this.thread,
      todos: this.todos,
      messages: snapshot?.messages ?? [],
      checkpoint: this.session?.checkpoint.serialize() ?? [],
      usage: {
        inputTokens: snapshot?.usage.inputTokens ?? 0,
        outputTokens: snapshot?.usage.outputTokens ?? 0,
        costUsd: this.state.usage?.costUsd,
      },
      pendingPlan: snapshot?.pendingPlan,
      lastTask: snapshot?.lastTask ?? "",
    });
  }

  /** Files the current thread away and starts an empty one. */
  async newSession(): Promise<void> {
    if (this.session?.isRunning) {
      void vscode.window.showInformationMessage("Stop the current build first.");
      return;
    }
    await this.persist();
    this.sessionId = SessionStore.newId();
    this.sessionTitle = "New build";
    this.sessionCreatedAt = new Date().toISOString();
    this.thread.length = 0;
    this.todos = [];
    this.session?.reset();
    this.post({ type: "replay", thread: [], todos: [] });
    this.patchState({
      sessionTitle: this.sessionTitle,
      agent: "architect",
      awaitingPlanApproval: false,
      usage: undefined,
      // The checkpoint deliberately survives: the files those snapshots describe
      // are still changed on disk, and dropping them would silently retire the
      // only way back.
      changedFiles: this.session?.checkpoint.size ?? 0,
    });
  }

  /** The session picker. */
  async switchSession(): Promise<void> {
    if (this.session?.isRunning) {
      void vscode.window.showInformationMessage("Stop the current build first.");
      return;
    }
    await this.persist();

    const summaries = await this.deps.sessionStore.list(this.workspaceKey);
    if (summaries.length === 0) {
      void vscode.window.showInformationMessage("There are no saved builds in this workspace yet.");
      return;
    }

    interface Pick extends vscode.QuickPickItem {
      id: string;
    }
    const picked = await vscode.window.showQuickPick<Pick>(
      summaries.map((summary) => ({
        id: summary.id,
        label: summary.id === this.sessionId ? `$(check) ${summary.title}` : summary.title,
        description: relativeTime(summary.updatedAt),
        detail: [
          `${summary.messageCount} message${summary.messageCount === 1 ? "" : "s"}`,
          summary.changedFiles > 0
            ? `${summary.changedFiles} file${summary.changedFiles === 1 ? "" : "s"} changed`
            : undefined,
        ]
          .filter(Boolean)
          .join(" · "),
      })),
      { title: "IronBase: Builds", placeHolder: "Reopen a build" },
    );
    if (!picked || picked.id === this.sessionId) return;

    const saved = await this.deps.sessionStore.load(this.workspaceKey, picked.id);
    if (!saved) {
      void vscode.window.showWarningMessage("That build could not be read.");
      return;
    }
    this.adopt(saved);
  }

  async exportSession(): Promise<void> {
    if (this.thread.length === 0) {
      void vscode.window.showInformationMessage("There is nothing in this build to export yet.");
      return;
    }
    await exportBuild({
      title: this.sessionTitle,
      workspaceName: this.folder.name,
      thread: this.thread,
      usage: this.state.usage
        ? {
            inputTokens: this.state.usage.inputTokens,
            outputTokens: this.state.usage.outputTokens,
            costUsd: this.state.usage.costUsd,
          }
        : undefined,
      model: this.state.model,
      provider: this.state.providerLabel,
      startedAt: this.sessionCreatedAt,
    });
  }

  // --- Session ---------------------------------------------------------------

  /**
   * Builds the session on first use.
   *
   * Scanning and indexing takes a moment on a large project and there is no
   * point paying for it when the panel is opened and never used. Concurrent
   * callers share the one promise rather than each starting their own scan.
   */
  private async ensureSession(): Promise<CodingSession | undefined> {
    if (this.session) return this.session;
    if (this.preparing) return await this.preparing;

    this.preparing = (async () => {
      const client = await this.deps.auth.getActiveClient();
      if (!client) {
        this.append({
          kind: "notice",
          level: "error",
          text: "Connect an AI account before starting a build.",
        });
        return undefined;
      }

      const config = getConfig();
      const source = new vscode.CancellationTokenSource();
      try {
        this.patchState({ activity: "Scanning the workspace…" });
        const scan = await scanWorkspace(
          this.folder,
          { maxFiles: config.maxFiles, ignoreGlobs: config.ignoreGlobs },
          source.token,
        );
        this.patchState({ activity: "Updating the project index…" });
        const index = await this.deps.indexStore.load(this.folder.uri, this.folder.name);
        this.index = index;
        await updateIndex(index, scan, source.token, (done, total) => {
          this.patchState({ activity: `Indexing ${done} of ${total} files…` });
        });
        await this.deps.indexStore.save(index);

        // MCP servers start alongside the index rather than at activation, so a
        // workspace that configures none never pays for the machinery.
        if (Object.keys(config.mcpServers).length > 0) {
          this.patchState({ activity: "Connecting MCP servers…" });
          await this.mcp.load(config.mcpServers);
          const described = this.mcp.describe();
          if (described) {
            this.append({ kind: "notice", level: "warning", text: `Connected ${described}.` });
          }
        }

        this.session = new CodingSession({
          root: this.folder.uri,
          scan,
          index,
          getConfig,
          getClient: () => this.deps.auth.getActiveClient(),
          getFallback: (exclude) => this.deps.auth.nextConnectedAfter(exclude),
          prompt: (request) => this.ask(request),
          emit: (event) => this.onSessionEvent(event),
          mcp: this.mcp.isEmpty ? undefined : this.mcp,
          onBuildFinished: (build) => {
            if (!this.index) return;
            rememberBuild(this.index, build);
            void this.deps.indexStore.save(this.index);
          },
        });
        // A resumed panel has its thread back already; this is the half that
        // needed the index first — the transcript and the undo history.
        if (this.pendingRestore) {
          this.session.restore(this.snapshotFrom(this.pendingRestore));
          this.session.checkpoint.hydrate(this.pendingRestore.checkpoint);
          this.patchState({ changedFiles: this.session.checkpoint.size });
          this.pendingRestore = undefined;
        }
        return this.session;
      } catch (err) {
        log.error("Could not prepare the build session", err);
        this.append({
          kind: "notice",
          level: "error",
          text: `Could not index this workspace: ${String(err)}`,
        });
        return undefined;
      } finally {
        source.dispose();
        this.patchState({ activity: undefined });
        this.preparing = undefined;
      }
    })();

    return await this.preparing;
  }

  private onSessionEvent(event: SessionEvent): void {
    switch (event.type) {
      case "user":
        if (this.thread.length === 0) {
          this.sessionTitle = titleFromTask(event.text);
          this.patchState({ sessionTitle: this.sessionTitle });
        }
        this.append({ kind: "user", text: event.text });
        break;

      case "assistantText":
        // Deltas land in one bubble until something else interrupts the model,
        // which is what makes the reply read as prose rather than as fragments.
        if (!this.streaming) {
          this.streaming = true;
          this.thread.push({ kind: "assistant", text: "" });
        }
        {
          const last = this.thread[this.thread.length - 1];
          if (last?.kind === "assistant") last.text += event.delta;
        }
        this.post({ type: "assistantDelta", delta: event.delta });
        break;

      case "tool":
        this.append({ kind: "tool", name: event.name, summary: event.summary });
        break;

      case "fileChange": {
        const change = event.change;
        this.append({
          kind: "change",
          id: change.id,
          file: change.file,
          change: change.kind,
          added: change.diff.added,
          removed: change.diff.removed,
          why: change.why,
          hunks: change.diff.hunks,
        });
        this.patchState({ changedFiles: this.session?.checkpoint.size ?? 0 });
        break;
      }

      case "commandStart":
        this.append({
          kind: "command",
          id: event.id,
          command: event.command,
          why: event.why,
          output: "",
        });
        break;

      case "commandOutput": {
        const item = this.thread.find(
          (entry) => entry.kind === "command" && entry.id === event.id,
        );
        if (item?.kind === "command") item.output += event.chunk;
        this.post({ type: "commandOutput", id: event.id, chunk: event.chunk });
        break;
      }

      case "commandEnd": {
        const item = this.thread.find(
          (entry) => entry.kind === "command" && entry.id === event.id,
        );
        if (item?.kind === "command") {
          item.status = event.status;
          item.ok = event.ok;
        }
        this.post({ type: "commandEnd", id: event.id, status: event.status, ok: event.ok });
        break;
      }

      case "todos":
        this.todos = event.todos;
        this.post({ type: "todos", todos: event.todos });
        break;

      case "plan":
        this.append({ kind: "plan", plan: event.plan });
        break;

      case "finished":
        this.append({
          kind: "finished",
          summary: event.summary,
          followUps: event.followUps,
        });
        break;

      case "warning":
        this.append({ kind: "notice", level: "warning", text: event.text });
        break;

      case "error":
        this.append({ kind: "notice", level: "error", text: event.text });
        break;

      case "status":
        // A stopped run has nobody left to act on an answer, so a card still
        // sitting there is asking a question that no longer means anything.
        if (!event.running) {
          this.closePending();
          void this.persist();
        }
        this.patchState({
          running: event.running,
          agent: event.agent,
          iteration: event.iteration,
          awaitingPlanApproval: event.awaitingPlanApproval,
          autoAcceptEdits: this.session?.autoAcceptsEdits ?? false,
        });
        if (!event.running) this.streaming = false;
        break;

      case "usage":
        this.patchState({
          usage: {
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            budget: event.budget,
            costUsd: event.costUsd,
            contextUsed: event.contextUsed,
          },
          model: event.model || this.state.model,
        });
        break;
    }
  }

  // --- Permission prompting --------------------------------------------------

  private ask(request: PermissionRequest): Promise<PermissionDecision> {
    const id = `permission-${++this.permissionCounter}`;
    const card: PermissionCard = {
      id,
      kind: request.kind,
      subject: request.subject,
      why: request.why,
      hunks: request.preview?.hunks,
      added: request.preview?.added,
      removed: request.preview?.removed,
    };

    // The panel has to be in front for the question to be answerable — a build
    // that silently stalls behind another tab looks like a hang.
    this.panel.reveal(this.panel.viewColumn, true);
    this.post({ type: "permission", request: card });

    return new Promise<PermissionDecision>((resolve) => {
      this.pending.set(id, {
        kind: request.kind,
        resolve: (decision) => {
          this.pending.delete(id);
          this.post({ type: "permissionClosed", id, decision });
          resolve(decision);
        },
      });
    });
  }

  // --- Webview messages ------------------------------------------------------

  private onMessage(message: ChatWebviewMessage): void {
    switch (message.type) {
      case "ready":
        this.post({ type: "replay", thread: this.thread, todos: this.todos });
        this.post({ type: "chatState", state: this.state });
        break;

      case "send":
        void (async () => {
          const session = await this.ensureSession();
          this.streaming = false;
          await session?.send(message.text, message.mode);
        })();
        break;

      case "stop":
        this.session?.stop();
        break;

      case "approvePlan":
        void (async () => {
          this.streaming = false;
          await this.session?.approvePlan(await this.editedPlanText());
        })();
        break;

      case "editPlan":
        void this.openPlanForEditing();
        break;

      case "discardPlan":
        this.session?.discardPlan();
        break;

      case "permissionDecision": {
        const request = this.pending.get(message.id);
        request?.resolve(message.decision);
        // "Allow all edits" and the composer toggle are the same setting; the
        // one that was not clicked has to catch up.
        if (
          message.decision === "allowAll" &&
          (request?.kind === "edit" || request?.kind === "create")
        ) {
          this.patchState({ autoAcceptEdits: true });
        }
        break;
      }

      case "setAutoAccept":
        this.session?.setAutoAcceptEdits(message.on);
        this.patchState({ autoAcceptEdits: message.on });
        break;

      case "openFile":
        void this.openFile(message.file, message.line);
        break;

      case "showDiff":
        void this.showDiff(message.id);
        break;

      case "revertChange":
        void this.revertChange(message.id);
        break;

      case "revertAll":
        void vscode.commands.executeCommand("ironbase.revertRun");
        break;

      case "newSession":
        void this.newSession();
        break;

      case "switchSession":
        void this.switchSession();
        break;

      case "exportSession":
        void this.exportSession();
        break;

      case "command":
        if (isAllowedCommand(message.command)) {
          void vscode.commands.executeCommand(message.command);
        } else {
          log.warn(`Build panel asked for a command outside the allowlist: ${message.command}`);
        }
        break;
    }
  }

  // --- Plan editing ----------------------------------------------------------

  /** The plan document the developer may have edited, if it is still open. */
  private planDocument: vscode.TextDocument | undefined;

  private async openPlanForEditing(): Promise<void> {
    const plan = [...this.thread].reverse().find((item) => item.kind === "plan");
    if (plan?.kind !== "plan") return;
    this.planDocument = await vscode.workspace.openTextDocument({
      content: renderPlanMarkdown(plan.plan),
      language: "markdown",
    });
    await vscode.window.showTextDocument(this.planDocument, {
      viewColumn: vscode.ViewColumn.One,
      preview: false,
    });
    void vscode.window.showInformationMessage(
      "Edit the plan, then press Build in the IronBase panel. What the document says is what gets built.",
    );
  }

  private async editedPlanText(): Promise<string | undefined> {
    const doc = this.planDocument;
    this.planDocument = undefined;
    if (!doc || doc.isClosed) return undefined;
    const text = doc.getText().trim();
    return text.length > 0 ? text : undefined;
  }

  // --- File actions ----------------------------------------------------------

  private async openFile(file: string, line?: number): Promise<void> {
    const uri = resolveInside(this.folder.uri, file);
    if (!uri) return;
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.One,
        preview: true,
      });
      if (line !== undefined) {
        const target = new vscode.Position(Math.max(0, line - 1), 0);
        editor.selection = new vscode.Selection(target, target);
        editor.revealRange(new vscode.Range(target, target), vscode.TextEditorRevealType.InCenter);
      }
    } catch {
      void vscode.window.showWarningMessage(`${file} could not be opened — it may have been deleted.`);
    }
  }

  private async showDiff(changeId: string): Promise<void> {
    const item = this.thread.find((entry) => entry.kind === "change" && entry.id === changeId);
    if (item?.kind !== "change") return;

    const uri = resolveInside(this.folder.uri, item.file);
    if (!uri) return;
    await vscode.commands.executeCommand(
      "vscode.diff",
      uri.with({ scheme: ORIGINAL_SCHEME, path: `/${item.file}` }),
      uri,
      `${item.file} — before IronBase ↔ now`,
      { preview: true, viewColumn: vscode.ViewColumn.One },
    );
  }

  private async revertChange(changeId: string): Promise<void> {
    const item = this.thread.find((entry) => entry.kind === "change" && entry.id === changeId);
    if (item?.kind !== "change" || !this.session) return;

    const outcome = await this.session.checkpoint.revert(item.file);
    if (outcome.failed.length > 0) {
      void vscode.window.showWarningMessage(
        `Could not revert ${item.file}: ${outcome.failed[0].reason}`,
      );
      return;
    }
    // Every card touching this file is now stale, not just the one clicked —
    // the file went back to how it started, which undoes all of them.
    for (const entry of this.thread) {
      if (entry.kind === "change" && entry.file === item.file) {
        entry.reverted = true;
        this.post({ type: "changeReverted", id: entry.id });
      }
    }
    this.patchState({ changedFiles: this.session.checkpoint.size });
  }

  // --- Plumbing --------------------------------------------------------------

  /** Answers every outstanding question with "no", and clears the cards. */
  private closePending(): void {
    for (const request of [...this.pending.values()]) request.resolve("reject");
    this.pending.clear();
  }

  private append(item: ThreadItem): void {
    // Anything arriving mid-reply closes the current bubble, so a tool card
    // never lands inside a paragraph the model is still writing.
    this.streaming = false;
    this.thread.push(item);
    this.post({ type: "append", item });
    this.scheduleSave();
  }

  private patchState(patch: Partial<ChatState>): void {
    this.state = { ...this.state, ...patch };
    this.post({ type: "chatState", state: this.state });
  }

  private async refreshAccount(): Promise<void> {
    const client = await this.deps.auth.getActiveClient();
    this.patchState({
      providerLabel: client ? PROVIDER_LABELS[client.id] : undefined,
      providerId: client?.id,
      model: client?.model,
    });
  }

  private post(message: ChatHostMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private html(): string {
    const nonce = createNonce();
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.deps.extensionUri, "dist", "chat.js"),
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
<style>${CHAT_STYLES}</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  /** Puts every file this session wrote back to how it started. */
  async revertAll(): Promise<void> {
    if (!this.session || this.session.checkpoint.size === 0) {
      void vscode.window.showInformationMessage("IronBase has not changed any files this session.");
      return;
    }
    const count = this.session.checkpoint.size;
    const confirm = await vscode.window.showWarningMessage(
      `Put ${count} file${count === 1 ? "" : "s"} back to how they were before this build?`,
      { modal: true, detail: "Anything you changed by hand in those files goes back too." },
      "Revert everything",
    );
    if (confirm !== "Revert everything") return;

    const outcome = await this.session.checkpoint.revertAll();
    for (const entry of this.thread) {
      if (entry.kind === "change") {
        entry.reverted = true;
        this.post({ type: "changeReverted", id: entry.id });
      }
    }
    this.patchState({ changedFiles: this.session.checkpoint.size });
    this.append({
      kind: "notice",
      level: "warning",
      text:
        `Reverted ${outcome.restored.length} file(s)` +
        (outcome.deleted.length > 0 ? `, removed ${outcome.deleted.length} created file(s)` : "") +
        (outcome.failed.length > 0 ? `. ${outcome.failed.length} could not be put back.` : "."),
    });
  }

  get changedFileCount(): number {
    return this.session?.checkpoint.size ?? 0;
  }

  stopRun(): void {
    this.session?.stop();
  }
}
