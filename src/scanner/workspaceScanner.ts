import ignore, { type Ignore } from "ignore";
import * as vscode from "vscode";
import { log } from "../util/log";
import { isInfraFile, isManifest, parseManifest, type Manifest } from "./manifests";
import { detectEntryPoints, detectFrameworks } from "./frameworkDetect";

export interface ScannedFile {
  /** Path relative to the workspace root, POSIX separators. */
  path: string;
  size: number;
  language: string;
  /** Last-modified time, so the indexer can skip unchanged files without reading them. */
  mtime: number;
}

export interface ScanResult {
  root: vscode.Uri;
  rootName: string;
  files: ScannedFile[];
  manifests: Manifest[];
  infraFiles: string[];
  frameworks: string[];
  entryPoints: string[];
  truncated: boolean;
  skippedLarge: number;
}

const MAX_MANIFEST_BYTES = 512 * 1024;
const LARGE_FILE_BYTES = 1024 * 1024;

const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "tiff", "svg",
  "pdf", "zip", "gz", "tar", "bz2", "7z", "rar", "jar", "war",
  "woff", "woff2", "ttf", "eot", "otf",
  "mp3", "mp4", "mov", "avi", "wav", "webm",
  "exe", "dll", "so", "dylib", "bin", "class", "pyc", "wasm",
  "db", "sqlite", "sqlite3",
]);

const ALWAYS_IGNORE = [
  ".git/",
  "node_modules/",
  "*.lock",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "*.min.js",
  "*.min.css",
  "*.map",
];

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript", cts: "TypeScript",
  js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  py: "Python", rb: "Ruby", go: "Go", rs: "Rust", java: "Java", kt: "Kotlin",
  cs: "C#", php: "PHP", swift: "Swift", scala: "Scala", ex: "Elixir", exs: "Elixir",
  c: "C", h: "C", cpp: "C++", cc: "C++", hpp: "C++",
  sql: "SQL", sh: "Shell", bash: "Shell", ps1: "PowerShell",
  html: "HTML", css: "CSS", scss: "CSS", less: "CSS", vue: "Vue", svelte: "Svelte",
  json: "JSON", yml: "YAML", yaml: "YAML", toml: "TOML", xml: "XML", md: "Markdown",
};

export interface ScanOptions {
  maxFiles: number;
  ignoreGlobs: string[];
}

export async function scanWorkspace(
  folder: vscode.WorkspaceFolder,
  options: ScanOptions,
  token: vscode.CancellationToken,
): Promise<ScanResult> {
  const files: ScannedFile[] = [];
  const manifestPaths: string[] = [];
  const infraFiles: string[] = [];
  let truncated = false;
  let skippedLarge = 0;

  const baseMatcher = ignore().add(ALWAYS_IGNORE).add(options.ignoreGlobs);
  // One matcher per directory that carries a .gitignore, applied to paths
  // relative to that directory — matching git's own semantics.
  const matchers: Array<{ dir: string; matcher: Ignore }> = [
    { dir: "", matcher: baseMatcher },
  ];

  async function walk(dirUri: vscode.Uri, relDir: string, depth: number): Promise<void> {
    if (token.isCancellationRequested || truncated || depth > 12) return;

    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dirUri);
    } catch (err) {
      log.warn(`Could not read directory ${relDir || "."}: ${String(err)}`);
      return;
    }

    const gitignore = entries.find(
      ([name, type]) => name === ".gitignore" && type === vscode.FileType.File,
    );
    let pushedMatcher = false;
    if (gitignore) {
      try {
        const bytes = await vscode.workspace.fs.readFile(
          vscode.Uri.joinPath(dirUri, ".gitignore"),
        );
        matchers.push({
          dir: relDir,
          matcher: ignore().add(Buffer.from(bytes).toString("utf8")),
        });
        pushedMatcher = true;
      } catch {
        /* unreadable .gitignore — fall through with what we have */
      }
    }

    try {
      // Directories last so shallow files land in the map before any cap hits.
      const sorted = [...entries].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
      for (const [name, type] of sorted) {
        if (token.isCancellationRequested || truncated) return;
        const rel = relDir ? `${relDir}/${name}` : name;
        const isDir = type === vscode.FileType.Directory;
        if (isIgnored(matchers, rel, isDir)) continue;

        const childUri = vscode.Uri.joinPath(dirUri, name);
        if (isDir) {
          await walk(childUri, rel, depth + 1);
          continue;
        }
        if (type === vscode.FileType.SymbolicLink) continue;

        // Dotfiles like `.gitignore` have no extension — splitting on "." would
        // otherwise report the filename itself as the language.
        const dot = name.lastIndexOf(".");
        const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
        if (BINARY_EXTENSIONS.has(ext)) continue;

        let size = 0;
        let mtime = 0;
        try {
          // Already stat'ing for the size, so mtime is free — and it is what
          // lets a repeat review skip reading unchanged files altogether.
          const stat = await vscode.workspace.fs.stat(childUri);
          size = stat.size;
          mtime = stat.mtime;
        } catch {
          continue;
        }
        if (size > LARGE_FILE_BYTES) {
          skippedLarge++;
          continue;
        }

        if (files.length >= options.maxFiles) {
          truncated = true;
          return;
        }
        files.push({
          path: rel,
          size,
          mtime,
          language: LANGUAGE_BY_EXT[ext] ?? (ext || "other"),
        });
        if (isManifest(name) && size <= MAX_MANIFEST_BYTES) manifestPaths.push(rel);
        if (isInfraFile(name, rel)) infraFiles.push(rel);
      }
    } finally {
      if (pushedMatcher) matchers.pop();
    }
  }

  await walk(folder.uri, "", 0);

  const manifests: Manifest[] = [];
  for (const rel of manifestPaths) {
    try {
      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.joinPath(folder.uri, ...rel.split("/")),
      );
      const parsed = parseManifest(rel, Buffer.from(bytes).toString("utf8"));
      if (parsed) manifests.push(parsed);
    } catch {
      /* skip unreadable manifest */
    }
  }

  const paths = files.map((f) => f.path);
  return {
    root: folder.uri,
    rootName: folder.name,
    files,
    manifests,
    infraFiles,
    frameworks: detectFrameworks(manifests, paths),
    entryPoints: detectEntryPoints(manifests, paths),
    truncated,
    skippedLarge,
  };
}

function isIgnored(
  matchers: Array<{ dir: string; matcher: Ignore }>,
  relPath: string,
  isDir: boolean,
): boolean {
  for (const { dir, matcher } of matchers) {
    const scoped = dir ? relPath.slice(dir.length + 1) : relPath;
    if (!scoped) continue;
    // `ignore` needs a trailing slash to match directory-only patterns.
    if (matcher.ignores(isDir ? `${scoped}/` : scoped)) return true;
  }
  return false;
}
