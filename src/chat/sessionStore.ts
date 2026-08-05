/**
 * Builds that outlive the window.
 *
 * A coding session is not a thing you finish in one sitting. You start a
 * refactor, reload the window because an extension updated, and come back —
 * and until this existed, everything went with it: the conversation, the task
 * list, and worst of all the checkpoint, so a build that had already rewritten
 * eight files became one you could no longer undo.
 *
 * One JSON file per session under the extension's global storage, grouped by
 * workspace. Global storage rather than `workspaceState` because the checkpoint
 * carries whole file contents, and a Memento is the wrong place to put
 * megabytes.
 */

import * as vscode from "vscode";
import type { StoredSnapshot } from "../engine/checkpoint";
import type { AgentId } from "../engine/agents";
import type { BuildPlan, Todo } from "../engine/plan";
import type { NeutralMessage } from "../llm/types";
import { workspaceKeyFor } from "../memory/store";
import type { ThreadItem } from "../protocol";
import { log } from "../util/log";

/** Sessions kept per workspace. Older ones are dropped oldest-first. */
const MAX_SESSIONS = 25;
/**
 * Ceiling on the checkpoint carried in one saved session.
 *
 * A revert that cannot restore everything is worse than a clear refusal, so
 * when this is hit the snapshots are kept and the *session* is what gets
 * trimmed — see `pruneOldest`. What this actually guards is a single build that
 * rewrote a hundred large files turning into a 200MB file on someone's disk.
 */
const MAX_CHECKPOINT_BYTES = 24 * 1024 * 1024;

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

export interface StoredSession {
  id: string;
  version: number;
  workspaceKey: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  agent: AgentId;
  thread: ThreadItem[];
  todos: Todo[];
  /** The model transcript, so a resumed session still knows what was said. */
  messages: NeutralMessage[];
  checkpoint: StoredSnapshot[];
  usage: SessionUsage;
  pendingPlan?: BuildPlan;
  lastTask: string;
  /** Set when the checkpoint had to be dropped to fit, so revert can say so. */
  checkpointTrimmed?: boolean;
}

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
  changedFiles: number;
}

const SESSION_VERSION = 1;

export class SessionStore {
  constructor(private readonly storageUri: vscode.Uri) {}

  private dirFor(workspaceKey: string): vscode.Uri {
    return vscode.Uri.joinPath(this.storageUri, "sessions", workspaceKey);
  }

  private fileFor(workspaceKey: string, id: string): vscode.Uri {
    return vscode.Uri.joinPath(this.dirFor(workspaceKey), `${id}.json`);
  }

  static keyFor(root: vscode.Uri): string {
    return workspaceKeyFor(root);
  }

  static newId(): string {
    // Time-ordered, so the directory sorts chronologically without opening
    // every file just to find the newest.
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /** Newest first. Reads every session file, so it is for menus, not hot paths. */
  async list(workspaceKey: string): Promise<SessionSummary[]> {
    const sessions = await this.loadAll(workspaceKey);
    return sessions
      .map((session) => ({
        id: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
        messageCount: session.thread.filter((item) => item.kind === "user").length,
        changedFiles: session.checkpoint.length,
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async load(workspaceKey: string, id: string): Promise<StoredSession | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.fileFor(workspaceKey, id));
      const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as StoredSession;
      return parsed.version === SESSION_VERSION ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  /** The session to reopen the panel on, if there is one worth reopening. */
  async mostRecent(workspaceKey: string): Promise<StoredSession | undefined> {
    const [newest] = await this.list(workspaceKey);
    return newest ? await this.load(workspaceKey, newest.id) : undefined;
  }

  async save(session: StoredSession): Promise<void> {
    try {
      const dir = this.dirFor(session.workspaceKey);
      await vscode.workspace.fs.createDirectory(dir);
      const payload = this.fit(session);
      await vscode.workspace.fs.writeFile(
        this.fileFor(session.workspaceKey, session.id),
        Buffer.from(JSON.stringify(payload), "utf8"),
      );
      await this.pruneOldest(session.workspaceKey);
    } catch (err) {
      // Failing to save history must never take a running build down with it.
      log.warn(`Could not save the build session: ${String(err)}`);
    }
  }

  async delete(workspaceKey: string, id: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(this.fileFor(workspaceKey, id));
    } catch {
      /* already gone */
    }
  }

  async deleteAll(workspaceKey: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(this.dirFor(workspaceKey), { recursive: true });
    } catch {
      /* nothing stored */
    }
  }

  /**
   * Drops the checkpoint if it alone would blow the size ceiling.
   *
   * Recorded on the session rather than done quietly, because "revert this
   * build" must not come back with fewer files than it promised and no
   * explanation for the difference.
   */
  private fit(session: StoredSession): StoredSession {
    const size = session.checkpoint.reduce(
      (total, entry) => total + (entry.content?.length ?? 0),
      0,
    );
    if (size <= MAX_CHECKPOINT_BYTES) return session;
    log.warn(
      `Build checkpoint is ${(size / 1024 / 1024).toFixed(1)}MB, past the ${
        MAX_CHECKPOINT_BYTES / 1024 / 1024
      }MB ceiling — it will not survive a reload.`,
    );
    return { ...session, checkpoint: [], checkpointTrimmed: true };
  }

  private async loadAll(workspaceKey: string): Promise<StoredSession[]> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(this.dirFor(workspaceKey));
    } catch {
      return [];
    }
    const out: StoredSession[] = [];
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File || !name.endsWith(".json")) continue;
      const session = await this.load(workspaceKey, name.slice(0, -5));
      if (session) out.push(session);
    }
    return out;
  }

  /** Keeps the newest MAX_SESSIONS and removes the rest. */
  private async pruneOldest(workspaceKey: string): Promise<void> {
    const summaries = await this.list(workspaceKey);
    for (const stale of summaries.slice(MAX_SESSIONS)) {
      await this.delete(workspaceKey, stale.id);
    }
  }
}

/**
 * Names a session after the first thing that was asked of it.
 *
 * A list of sessions all called "Build" is a list nobody can navigate, and
 * asking someone to name a session before they have started it is a chore they
 * will skip.
 */
export function titleFromTask(task: string): string {
  const line = task.trim().split("\n")[0].trim();
  if (line.length === 0) return "Untitled build";
  return line.length <= 64 ? line : `${line.slice(0, 61).trimEnd()}…`;
}

/** "2 hours ago" — what a session list actually needs to show. */
export function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d ago` : new Date(then).toLocaleDateString();
}
