/**
 * The build conversation, with no opinion about where it is displayed.
 *
 * It owns the session, turns its events into thread items, and answers the
 * webview's clicks. What it deliberately does not own is a window: the same
 * conversation shows in the sidebar and, if you want room for a diff, in an
 * editor tab at the same time. Both attach here as surfaces and both see the
 * identical thread, because there is only one of it.
 *
 * Two of its jobs are less obvious than the rest.
 *
 * It is the permission prompter. When the session needs an answer it calls in
 * here, a card goes on every attached surface, and the promise stays open until
 * the developer clicks — or until the last surface closes, which rejects every
 * outstanding request rather than leaving the run parked forever.
 *
 * It also keeps the thread. A webview can be disposed and rebuilt at any time —
 * closing the tab, collapsing the sidebar, switching between the two — and
 * everything on screen has to come back. So the thread lives here as data and
 * the webview replays it, which also means no rendering state is ever the
 * source of truth.
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
import { ALL_PROVIDERS, PROVIDER_LABELS, supportsMethod, type ProviderId } from "../llm/types";
import { canCaptureSession } from "../llm/webSessions";
import { describeError, log } from "../util/log";
import * as path from "node:path";
import { relativeTo, resolveInside } from "../util/paths";
import {
  type ChatHostMessage,
  type ChatState,
  type ChatWebviewMessage,
  type ModelOption,
  type PermissionCard,
  type ThreadItem,
  isAllowedCommand,
} from "../protocol";

/**
 * Names the attached files at the top of the request.
 *
 * Plain prose rather than a fenced block or a pasted dump: the model reads the
 * request as a sentence, and it has `read_file` to open what it is pointed at.
 */
function withAttachments(text: string, attachments?: string[]): string {
  if (!attachments || attachments.length === 0) return text;
  const list = attachments.map((file) => `\`${file}\``).join(", ");
  const lead =
    attachments.length === 1
      ? `Start from ${list}.`
      : `Start from these files: ${list}.`;
  return text.trim().length > 0 ? `${lead}\n\n${text}` : lead;
}

function isProvider(value: unknown): value is ProviderId {
  return typeof value === "string" && (ALL_PROVIDERS as readonly string[]).includes(value);
}

/** Scheme for the read-only "as it was before IronBase touched it" side of a diff. */
const ORIGINAL_SCHEME = "ironbase-original";

export interface ChatPanelDeps {
  extensionUri: vscode.Uri;
  auth: AuthManager;
  indexStore: IndexStore;
  sessionStore: SessionStore;
  /** Every model the connected accounts offer, for the composer's own menu. */
  listModels: () => Promise<ModelOption[]>;
  /** Pins an account and model. */
  applyModel: (provider: ProviderId | "auto", model: string) => Promise<void>;
}

/**
 * Somewhere the conversation can be drawn.
 *
 * The sidebar view and the editor panel each implement this. Nothing else about
 * them is known here, which is what stops "which window is this in" leaking
 * into the logic that runs a build.
 */
export interface ChatSurface {
  post(message: ChatHostMessage): void;
  /** Bring this surface to the front — a permission prompt needs answering. */
  reveal(): void;
}

/** How long after the last event the session is written out. */
const SAVE_DEBOUNCE_MS = 1500;

export class ChatController {
  private static instance: ChatController | undefined;

  /**
   * The one controller for this workspace, created on first use.
   *
   * Deliberately outlives every surface. Closing the editor tab while a build
   * is mid-flight must not stop the build or lose the undo history — the
   * sidebar is very often still showing it.
   */
  static forWorkspace(deps: ChatPanelDeps): ChatController | undefined {
    if (ChatController.instance) return ChatController.instance;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      void vscode.window.showWarningMessage(
        "IronBase needs an open folder to build in. Open your project first.",
      );
      return undefined;
    }
    ChatController.instance = new ChatController(deps, folder);
    return ChatController.instance;
  }

  static get active(): ChatController | undefined {
    return ChatController.instance;
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
        return ChatController.instance?.session?.checkpoint.originalOf(file) ?? "";
      },
    });
  }

  private readonly surfaces = new Set<ChatSurface>();
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

    this.disposables.push(this.deps.auth.onDidChange(() => void this.refreshAccount()));
    void this.refreshAccount();
    void this.resumeMostRecent();
  }

  // --- Surfaces --------------------------------------------------------------

  /** Attaches a window. It gets the whole conversation replayed immediately. */
  attach(surface: ChatSurface): void {
    this.surfaces.add(surface);
    surface.post({ type: "replay", thread: this.thread, todos: this.todos });
    surface.post({ type: "chatState", state: this.state });
  }

  /**
   * Detaches a window.
   *
   * Only the *last* one leaving ends the outstanding permission prompts: while
   * any surface remains, there is still someone who can answer, and cancelling
   * a build because a tab was closed would be its own bug.
   */
  detach(surface: ChatSurface): void {
    this.surfaces.delete(surface);
    if (this.surfaces.size === 0) this.closePending();
  }

  get hasSurface(): boolean {
    return this.surfaces.size > 0;
  }

  /** Called by a surface when its webview sends something. */
  handle(message: ChatWebviewMessage): void {
    this.onMessage(message);
  }

  dispose(): void {
    this.closePending();
    this.session?.stop();
    this.mcp.dispose();
    void this.persist();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    for (const item of this.disposables) item.dispose();
    ChatController.instance = undefined;
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
        this.append({
          kind: "tool",
          id: event.id,
          name: event.name,
          summary: event.summary,
          note: event.note,
          ok: event.ok,
        });
        break;

      case "toolEnd": {
        // Patched in the thread as well as posted, or a panel reopened after
        // the run would replay a row that is still spinning.
        const item = this.thread.find(
          (entry) => entry.kind === "tool" && entry.id === event.id,
        );
        if (item?.kind === "tool") {
          item.note = event.note;
          item.ok = event.ok;
        }
        this.post({ type: "toolEnd", id: event.id, note: event.note, ok: event.ok });
        break;
      }

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

    // Something has to be in front for the question to be answerable — a build
    // that silently stalls behind another tab looks like a hang.
    for (const surface of this.surfaces) surface.reveal();
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
        // A surface that reloaded its webview asks for the thread again.
        this.post({ type: "replay", thread: this.thread, todos: this.todos });
        this.post({ type: "chatState", state: this.state });
        break;

      case "send":
        void (async () => {
          const session = await this.ensureSession();
          this.streaming = false;
          await session?.send(withAttachments(message.text, message.attachments), message.mode);
        })();
        break;

      case "pickFiles":
        void this.pickFiles();
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

      case "requestModels":
        void (async () => {
          this.post({ type: "modelOptions", options: await this.deps.listModels() });
        })();
        break;

      case "selectModel":
        void (async () => {
          await this.deps.applyModel(message.provider, message.model);
          await this.refreshAccount();
        })();
        break;

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

      case "startReview":
        void vscode.commands.executeCommand(
          "ironbase.internal.review",
          message.kind,
          message.target,
        );
        break;

      case "connectProvider":
        // Same posture as the sidebar's: the pair carries arguments the command
        // allowlist cannot, so it is checked against the real provider matrix
        // before anything is dispatched rather than trusted for arriving typed.
        if (isProvider(message.id) && supportsMethod(message.id, message.method)) {
          void vscode.commands.executeCommand(
            "ironbase.internal.connect",
            message.id,
            message.method,
          );
        } else {
          log.warn(`Build panel asked to connect an unknown pair: ${message.id}/${message.method}`);
        }
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

  /**
   * Asks for files to point the agent at.
   *
   * Anything outside the workspace is dropped rather than copied in: every read
   * tool is fenced to the folder, so an attachment from elsewhere would be a
   * path the agent is structurally unable to open. Saying so beats attaching
   * something that silently fails on the first read.
   */
  private async pickFiles(): Promise<void> {
    let picked: vscode.Uri[] | undefined;
    try {
      picked = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: true,
        openLabel: "Attach",
        defaultUri: this.folder.uri,
        title: "Attach files for IronBase to read",
      });
    } catch (err) {
      // A dialog that cannot open is the one failure mode with no symptom on
      // screen at all — the clip looks broken and nothing says why.
      log.error("Could not open the attach dialog", err);
      void vscode.window.showErrorMessage(`Could not open the file picker: ${describeError(err)}`);
      return;
    }
    log.info(`Attach: picked ${picked?.length ?? 0} file(s).`);
    if (!picked || picked.length === 0) return;

    const inside: string[] = [];
    const outside: string[] = [];
    for (const uri of picked) {
      const rel = relativeTo(this.folder.uri, uri);
      if (rel.startsWith("..") || path.isAbsolute(rel)) outside.push(uri.fsPath);
      else inside.push(rel);
    }

    if (inside.length > 0) {
      this.post({ type: "filesPicked", files: inside });
      log.info(`Attach: ${inside.join(", ")}`);
    }

    // Every read tool is fenced to the workspace, so a file from elsewhere is a
    // path the agent is structurally unable to open. Saying which ones were
    // dropped beats a clip that appears to do nothing.
    if (outside.length > 0) {
      const names = outside.map((file) => path.basename(file)).join(", ");
      void vscode.window.showWarningMessage(
        inside.length === 0
          ? `Nothing attached. IronBase can only read files inside ${this.folder.name}, and ${names} ${outside.length === 1 ? "is" : "are"} outside it.`
          : `${names} left out — IronBase can only read inside ${this.folder.name}.`,
      );
    }
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
      // Carried so the panel's own start page can offer the connect matrix
      // rather than bouncing someone to the sidebar to sign in and back again.
      connected: await this.deps.auth.availableProviders(),
      sessionCapable: ALL_PROVIDERS.filter(canCaptureSession),
    });
  }

  private post(message: ChatHostMessage): void {
    for (const surface of this.surfaces) surface.post(message);
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
