import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { log } from "../util/log";
import type { CodeSymbol, Signal } from "./symbols";
import type { Finding } from "../engine/findings";

export const INDEX_VERSION = 2;

export interface FileRecord {
  path: string;
  /** Content hash — the whole point of the cache: unchanged files are skipped. */
  hash: string;
  size: number;
  /**
   * Last-modified time when this record was built. Absent on records written by
   * older versions, which simply fall back to hashing.
   */
  mtime?: number;
  loc: number;
  language: string;
  symbols: CodeSymbol[];
  imports: string[];
  signals: Signal[];
}

export interface PriorFinding {
  title: string;
  severity: string;
  category: string;
  files: string[];
  /** Hashes of the files it referenced, so we can tell if they have changed. */
  fileHashes: Record<string, string>;
  seenAt: string;
}

export interface WorkspaceIndex {
  version: number;
  workspaceKey: string;
  workspaceName: string;
  updatedAt: string;
  files: Record<string, FileRecord>;
  priorFindings: PriorFinding[];
  /** Grade from the most recent completed review, for trend context. */
  lastGrade?: string;
}

export function hashContent(content: Uint8Array | string): string {
  return crypto.createHash("sha1").update(content).digest("hex").slice(0, 16);
}

export function workspaceKeyFor(root: vscode.Uri): string {
  return crypto.createHash("sha1").update(root.toString()).digest("hex").slice(0, 20);
}

/**
 * Persists one index per workspace under the extension's global storage, so a
 * second review of the same project starts from what the first one learned.
 */
export class IndexStore {
  constructor(private readonly storageUri: vscode.Uri) {}

  private fileFor(key: string): vscode.Uri {
    return vscode.Uri.joinPath(this.storageUri, `index-${key}.json`);
  }

  async load(root: vscode.Uri, name: string): Promise<WorkspaceIndex> {
    const key = workspaceKeyFor(root);
    try {
      const bytes = await vscode.workspace.fs.readFile(this.fileFor(key));
      const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as WorkspaceIndex;
      if (parsed.version === INDEX_VERSION && parsed.workspaceKey === key) {
        return parsed;
      }
      log.info("Stored index is from an older format; rebuilding it.");
    } catch {
      /* first run for this workspace */
    }
    return {
      version: INDEX_VERSION,
      workspaceKey: key,
      workspaceName: name,
      updatedAt: new Date().toISOString(),
      files: {},
      priorFindings: [],
    };
  }

  async save(index: WorkspaceIndex): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(this.storageUri);
      index.updatedAt = new Date().toISOString();
      await vscode.workspace.fs.writeFile(
        this.fileFor(index.workspaceKey),
        Buffer.from(JSON.stringify(index), "utf8"),
      );
    } catch (err) {
      // A cache write failure must never break a review.
      log.warn(`Could not save the index: ${String(err)}`);
    }
  }

  async clear(root: vscode.Uri): Promise<void> {
    try {
      await vscode.workspace.fs.delete(this.fileFor(workspaceKeyFor(root)));
    } catch {
      /* nothing stored */
    }
  }
}

/** Records this run's findings so the next review can check them for regressions. */
export function rememberFindings(
  index: WorkspaceIndex,
  findings: Finding[],
  grade: string,
): void {
  const seenAt = new Date().toISOString();
  index.lastGrade = grade;
  index.priorFindings = findings.slice(0, 60).map((finding) => {
    const files = [...new Set(finding.evidence.map((e) => e.file))];
    const fileHashes: Record<string, string> = {};
    for (const file of files) {
      const record = index.files[file];
      if (record) fileHashes[file] = record.hash;
    }
    return {
      title: finding.title,
      severity: finding.severity,
      category: finding.category,
      files,
      fileHashes,
      seenAt,
    };
  });
}

/**
 * Splits remembered findings by whether the code they pointed at has changed.
 * Untouched files mean the issue is almost certainly still present, which lets a
 * re-review skip re-deriving it and focus on what moved.
 */
export function classifyPriorFindings(index: WorkspaceIndex): {
  unchanged: PriorFinding[];
  touched: PriorFinding[];
} {
  const unchanged: PriorFinding[] = [];
  const touched: PriorFinding[] = [];
  for (const prior of index.priorFindings) {
    const changed = Object.entries(prior.fileHashes).some(
      ([file, hash]) => index.files[file]?.hash !== hash,
    );
    (changed ? touched : unchanged).push(prior);
  }
  return { unchanged, touched };
}
