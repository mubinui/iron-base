/**
 * A way back.
 *
 * The moment an agent writes to disk, the developer needs an answer to "undo all
 * of that". Without one, turning off the per-edit prompt is reckless, and with
 * one it is merely fast — which is the whole difference between a tool people
 * actually let run and a tool they babysit.
 *
 * The rule is one snapshot per file, taken before the *first* write of the
 * session and never refreshed. That is deliberate: after three edits to the same
 * file, "revert" should put back what was there before the agent started, not
 * what was there before its third edit.
 *
 * It captures content, not a git operation. A repository is not guaranteed, the
 * working tree may already be dirty for reasons that have nothing to do with the
 * run, and `git stash` would sweep up the developer's own uncommitted work
 * alongside the agent's. Holding the bytes is smaller in every sense.
 */

import * as vscode from "vscode";
import { log } from "../util/log";
import { relativeTo } from "../util/paths";

interface Snapshot {
  uri: vscode.Uri;
  /** Absent when the file did not exist, in which case reverting deletes it. */
  content?: string;
  /**
   * Directories that had to be created to hold this file, innermost first.
   *
   * Reverting a created file has to take these with it, or "put everything
   * back" leaves a trail of empty folders in the tree — which is not what
   * anyone means by it, and looks like the revert half-worked.
   *
   * Recorded at capture time rather than inferred at revert time, so a
   * directory that was already there and merely happens to be empty now is
   * never mistaken for one the agent made.
   */
  createdDirs?: string[];
}

export interface RevertOutcome {
  restored: string[];
  deleted: string[];
  failed: Array<{ file: string; reason: string }>;
}

/** A snapshot in the form that survives being written to disk. */
export interface StoredSnapshot {
  file: string;
  /** Absent when the file did not exist, exactly as in memory. */
  content?: string;
}

export class Checkpoint {
  private readonly snapshots = new Map<string, Snapshot>();

  constructor(private readonly root: vscode.Uri) {}

  /**
   * The snapshots, for saving with the session.
   *
   * Without this, reloading the window loses the ability to undo a build that
   * has already changed files — which is worse than never having offered it,
   * because the offer is what made turning the prompting off reasonable.
   */
  serialize(): StoredSnapshot[] {
    return [...this.snapshots.entries()].map(([file, snapshot]) => ({
      file,
      content: snapshot.content,
    }));
  }

  /**
   * Puts saved snapshots back.
   *
   * Existing entries win: a file this session has already captured has a more
   * faithful "before" than anything on disk, and overwriting it with a restored
   * copy would move the revert target forward.
   */
  hydrate(stored: StoredSnapshot[]): void {
    for (const entry of stored) {
      if (this.snapshots.has(entry.file)) continue;
      const uri = vscode.Uri.joinPath(this.root, ...entry.file.split("/"));
      this.snapshots.set(entry.file, { uri, content: entry.content });
    }
  }

  /** Files this session has written to, in the order they were first touched. */
  get touched(): string[] {
    return [...this.snapshots.keys()];
  }

  get size(): number {
    return this.snapshots.size;
  }

  /**
   * Records a file's current state, if it has not been recorded already.
   *
   * Call this immediately before writing. Reading the file to save it can fail —
   * a permissions problem, a file that vanished between the check and the read —
   * and that is worth knowing about *before* the write rather than after, so the
   * failure is returned rather than swallowed.
   */
  async capture(uri: vscode.Uri): Promise<{ ok: true } | { ok: false; reason: string }> {
    const key = relativeTo(this.root, uri);
    if (this.snapshots.has(key)) return { ok: true };

    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      this.snapshots.set(key, { uri, content: Buffer.from(bytes).toString("utf8") });
      return { ok: true };
    } catch {
      // Two different situations land here: the file does not exist yet, which
      // is normal and means reverting deletes it, and the file exists but could
      // not be read, which must not be recorded as "did not exist" or the revert
      // would delete something it never wrote.
      try {
        await vscode.workspace.fs.stat(uri);
        return {
          ok: false,
          reason: `${key} exists but could not be read, so IronBase cannot guarantee it could undo the change. Refusing to write it.`,
        };
      } catch {
        this.snapshots.set(key, { uri, createdDirs: await this.missingAncestors(key) });
        return { ok: true };
      }
    }
  }

  /** True once this file has a snapshot — i.e. the session has written to it. */
  has(file: string): boolean {
    return this.snapshots.has(file);
  }

  /**
   * The file as it was before this session touched it.
   *
   * Empty string for a file the session created, since that is what it is
   * diffed against. Undefined means the session never wrote to it at all.
   */
  originalOf(file: string): string | undefined {
    const snapshot = this.snapshots.get(file);
    if (!snapshot) return undefined;
    return snapshot.content ?? "";
  }

  async revert(file: string): Promise<RevertOutcome> {
    const snapshot = this.snapshots.get(file);
    if (!snapshot) {
      return { restored: [], deleted: [], failed: [{ file, reason: "nothing to revert" }] };
    }
    return await this.restore([[file, snapshot]]);
  }

  async revertAll(): Promise<RevertOutcome> {
    return await this.restore([...this.snapshots.entries()]);
  }

  private async restore(entries: Array<[string, Snapshot]>): Promise<RevertOutcome> {
    const outcome: RevertOutcome = { restored: [], deleted: [], failed: [] };

    for (const [file, snapshot] of entries) {
      try {
        if (snapshot.content === undefined) {
          // The agent created it, so putting things back means removing it —
          // and any directory that only ever existed to hold it.
          await vscode.workspace.fs.delete(snapshot.uri, { useTrash: true });
          await this.removeCreatedDirs(snapshot.createdDirs ?? []);
          outcome.deleted.push(file);
        } else {
          await vscode.workspace.fs.writeFile(
            snapshot.uri,
            Buffer.from(snapshot.content, "utf8"),
          );
          outcome.restored.push(file);
        }
        this.snapshots.delete(file);
      } catch (err) {
        outcome.failed.push({ file, reason: String(err) });
      }
    }

    log.info(
      `Reverted ${outcome.restored.length} file(s), removed ${outcome.deleted.length}, ` +
        `${outcome.failed.length} failed.`,
    );
    return outcome;
  }

  /**
   * Which of this path's ancestor directories do not exist yet.
   *
   * Innermost first, which is the order they have to be removed in. The
   * workspace root is never included: it existed before any of this and is not
   * ours to delete.
   */
  private async missingAncestors(relPath: string): Promise<string[]> {
    const segments = relPath.split("/").slice(0, -1);
    const missing: string[] = [];
    for (let depth = segments.length; depth > 0; depth--) {
      const dir = segments.slice(0, depth).join("/");
      try {
        await vscode.workspace.fs.stat(vscode.Uri.joinPath(this.root, ...dir.split("/")));
        break; // This one exists, so everything above it does too.
      } catch {
        missing.push(dir);
      }
    }
    return missing;
  }

  /**
   * Removes directories the session created, innermost first.
   *
   * Each one is checked for emptiness immediately before it goes: two files may
   * have been created in the same new directory and only one of them reverted,
   * and in that case the directory is still doing its job.
   */
  private async removeCreatedDirs(dirs: string[]): Promise<void> {
    for (const dir of dirs) {
      const uri = vscode.Uri.joinPath(this.root, ...dir.split("/"));
      try {
        const entries = await vscode.workspace.fs.readDirectory(uri);
        if (entries.length > 0) return;
        await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: true });
      } catch {
        // Already gone, or not ours to remove. Either way, stop climbing.
        return;
      }
    }
  }
}
