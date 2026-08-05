import * as vscode from "vscode";
import { log } from "../util/log";
import type { ScanResult } from "../scanner/workspaceScanner";
import { extractStructure } from "./symbols";
import { hashContent, type FileRecord, type WorkspaceIndex } from "./store";

export interface IndexStats {
  total: number;
  reused: number;
  reindexed: number;
  removed: number;
  bytesRead: number;
  elapsedMs: number;
}

/** Files above this size are recorded but not parsed — they blow the budget. */
const MAX_PARSE_BYTES = 400 * 1024;

export interface IndexProgress {
  (done: number, total: number): void;
}

/**
 * Brings the stored index up to date with what is on disk.
 *
 * Only files whose content hash changed are re-read and re-parsed, so a second
 * review of an untouched project does almost no work: the cost of a run scales
 * with what the developer edited, not with repository size.
 */
export async function updateIndex(
  index: WorkspaceIndex,
  scan: ScanResult,
  token: vscode.CancellationToken,
  onProgress?: IndexProgress,
): Promise<IndexStats> {
  const started = Date.now();
  const stats: IndexStats = {
    total: scan.files.length,
    reused: 0,
    reindexed: 0,
    removed: 0,
    bytesRead: 0,
    elapsedMs: 0,
  };

  const present = new Set(scan.files.map((f) => f.path));
  for (const known of Object.keys(index.files)) {
    if (!present.has(known)) {
      delete index.files[known];
      stats.removed++;
    }
  }

  let done = 0;
  for (const file of scan.files) {
    if (token.isCancellationRequested) break;
    done++;
    if (done % 25 === 0) onProgress?.(done, scan.files.length);

    const existing = index.files[file.path];
    // Size and mtime both matching means the bytes cannot have changed, so the
    // read is pure cost. This is what makes a repeat review of an untouched
    // repository do no file I/O at all — previously it still read and hashed
    // every byte just to decide it had nothing to do.
    if (
      existing &&
      existing.size === file.size &&
      existing.mtime !== undefined &&
      existing.mtime === file.mtime
    ) {
      stats.reused++;
      continue;
    }

    // Size alone is still a useful pre-filter: same size means the hash decides,
    // a different size skips the comparison entirely.
    if (existing && existing.size === file.size) {
      const bytes = await readFile(file.path, scan.root);
      if (!bytes) continue;
      const hash = hashContent(bytes);
      if (hash === existing.hash) {
        // Record the mtime so the next run can take the cheap path above.
        existing.mtime = file.mtime;
        stats.reused++;
        continue;
      }
      stats.bytesRead += bytes.byteLength;
      index.files[file.path] = buildRecord(file.path, file.language, file.size, file.mtime, bytes, hash);
      stats.reindexed++;
      continue;
    }

    const bytes = await readFile(file.path, scan.root);
    if (!bytes) continue;
    stats.bytesRead += bytes.byteLength;
    index.files[file.path] = buildRecord(
      file.path,
      file.language,
      file.size,
      file.mtime,
      bytes,
      hashContent(bytes),
    );
    stats.reindexed++;
  }

  stats.elapsedMs = Date.now() - started;
  log.info(
    `Index updated: ${stats.reindexed} parsed, ${stats.reused} reused from cache, ` +
      `${stats.removed} dropped, ${(stats.bytesRead / 1024).toFixed(0)}KB read in ${stats.elapsedMs}ms.`,
  );
  return stats;
}

function buildRecord(
  path: string,
  language: string,
  size: number,
  mtime: number,
  bytes: Uint8Array,
  hash: string,
): FileRecord {
  if (bytes.byteLength > MAX_PARSE_BYTES) {
    return { path, hash, size, mtime, loc: 0, language, symbols: [], imports: [], signals: [] };
  }
  const content = Buffer.from(bytes).toString("utf8");
  const structure = extractStructure(content);
  return {
    path,
    hash,
    size,
    mtime,
    loc: structure.loc,
    language,
    symbols: structure.symbols,
    imports: structure.imports,
    signals: structure.signals,
  };
}

async function readFile(relPath: string, root: vscode.Uri): Promise<Uint8Array | undefined> {
  try {
    return await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(root, ...relPath.split("/")),
    );
  } catch {
    return undefined;
  }
}
