import * as vscode from "vscode";
import type { JsonSchemaObject, ToolDef } from "../llm/types";
import { truncate } from "../util/limits";
import { retrieve, signalsOfKind } from "../memory/retrieval";
import type { WorkspaceIndex } from "../memory/store";
import { SIGNAL_LABELS, type SignalKind } from "../memory/symbols";
import {
  CATEGORIES,
  SEVERITY_ORDER,
  parseFindingInput,
  type Blueprint,
  type CodeFix,
  type Evidence,
  type Finding,
  type Grade,
  type ScalabilityAnalysis,
} from "./findings";

const ALL_SIGNAL_KINDS = Object.keys(SIGNAL_LABELS) as SignalKind[];

const MAX_SEARCH_RESULTS = 50;
const MAX_MATCH_CHARS = 200;
const MAX_DIR_ENTRIES = 200;
const SNIPPET_ANCHOR_WINDOW = 10;
const MAX_FILES_SCANNED = 1500;
const MAX_SEARCH_FILE_BYTES = 512 * 1024;
/** How long one search may hold the extension host before giving back partial results. */
const SEARCH_TIME_BUDGET_MS = 3000;
/**
 * A quantified group that is itself quantified — `(a+)+`, `(x*)*`, `(ab+)+`.
 * The classic catastrophic-backtracking shape.
 */
const NESTED_QUANTIFIER = /\([^)]*[+*][^)]*\)\s*[+*{]/;

export const TOOL_NAMES = {
  findRelevant: "find_relevant",
  listSignals: "list_signals",
  listDir: "list_dir",
  readFile: "read_file",
  search: "search",
  emitFinding: "emit_finding",
  proposeFix: "propose_fix",
  emitReport: "emit_report",
} as const;

export function toolDefinitions(): ToolDef[] {
  return [
    {
      name: TOOL_NAMES.findRelevant,
      description:
        "Ask the project index a question in plain language and get back the files most likely to answer it, each with the specific lines that matched. This is the cheapest way to locate anything — start here rather than listing directories or reading files at random. Examples: \"where are sessions stored\", \"database queries inside loops\", \"how is configuration loaded\".",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "What you are looking for, in plain language.",
          },
          limit: { type: "number", description: "How many files to return. Default 8." },
        },
        required: ["query"],
      },
    },
    {
      name: TOOL_NAMES.listSignals,
      description:
        "List every place in the project carrying one pre-scanned architecture signal, with file and line. The counts in the brief come from this index, so use it to jump straight to the evidence behind them.",
      inputSchema: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: [...ALL_SIGNAL_KINDS],
            description: "Which signal to list.",
          },
        },
        required: ["kind"],
      },
    },
    {
      name: TOOL_NAMES.listDir,
      description:
        "List the contents of a directory in the workspace. Prefer find_relevant unless you specifically need to see a directory's layout.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative directory path. Use \"\" or \".\" for the root.",
          },
        },
        required: ["path"],
      },
    },
    {
      name: TOOL_NAMES.readFile,
      description:
        "Read a file from the workspace. Returns numbered lines so you can cite exact line numbers as evidence. Prefer a line range for large files.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path." },
          startLine: { type: "number", description: "First line to return (1-based)." },
          endLine: { type: "number", description: "Last line to return (inclusive)." },
        },
        required: ["path"],
      },
    },
    {
      name: TOOL_NAMES.search,
      description:
        "Search file contents across the workspace. Returns `path:line: text` matches. Cheaper than reading whole files — use it to locate patterns such as query calls, session handling, or hardcoded secrets.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Text or regular expression to find." },
          isRegex: { type: "boolean", description: "Treat the pattern as a regex. Default false." },
          glob: {
            type: "string",
            description: "Optional include glob, e.g. \"**/*.ts\".",
          },
        },
        required: ["pattern"],
      },
    },
    {
      name: TOOL_NAMES.emitFinding,
      description:
        "Record one architecture problem. Every finding needs concrete evidence: a real file path, and a line number where you can point at one. Call this as you go, not all at the end.",
      inputSchema: {
        type: "object",
        properties: {
          severity: { type: "string", enum: [...SEVERITY_ORDER] },
          category: { type: "string", enum: [...CATEGORIES] },
          title: { type: "string", description: "Short problem statement." },
          explanation: {
            type: "string",
            description: "What is wrong and why it matters, in plain language a junior developer will understand.",
          },
          recommendation: {
            type: "string",
            description: "The concrete fix, naming files, libraries, or patterns where possible.",
          },
          effort: { type: "string", enum: ["small", "medium", "large"] },
          evidence: {
            type: "array",
            description: "One or more real locations backing this finding.",
            items: {
              type: "object",
              properties: {
                file: { type: "string", description: "Workspace-relative file path." },
                startLine: { type: "number" },
                endLine: { type: "number" },
                snippetHint: {
                  type: "string",
                  description: "A short exact line of code from that location, used to verify the reference.",
                },
              },
              required: ["file"],
            },
          },
        },
        required: ["severity", "category", "title", "explanation", "recommendation", "evidence"],
      } as JsonSchemaObject,
    },
    {
      name: TOOL_NAMES.proposeFix,
      description:
        "Attach an applicable code change to a finding you already emitted. The developer sees it as a diff with an Apply button, so it has to be real code that compiles in context — not a sketch. `anchor` must be copied character-for-character from the file, including indentation, and must appear exactly once; if it does not match, the fix is rejected and you will be told why. Propose a fix for every finding where the change is small and local enough to write out. Skip it for findings whose fix is a multi-file redesign — say that in the recommendation instead.",
      inputSchema: {
        type: "object",
        properties: {
          findingTitle: {
            type: "string",
            description:
              "The exact title of the finding this fixes, so the two can be shown together.",
          },
          title: {
            type: "string",
            description: "What this change does, in a few words, e.g. \"Move the API key into an environment variable\".",
          },
          file: { type: "string", description: "Workspace-relative file path." },
          kind: {
            type: "string",
            enum: ["replace", "insert-after", "create"],
            description:
              "replace: swap the anchor for the replacement. insert-after: keep the anchor and add the replacement below it. create: write a new file, with the replacement as its whole contents.",
          },
          anchor: {
            type: "string",
            description:
              "The exact existing lines to target, copied verbatim from read_file output with the line numbers and tab stripped. Include enough lines to be unique in the file. Omit only when kind is \"create\".",
          },
          replacement: {
            type: "string",
            description:
              "The new code. Match the file's existing indentation, quote style, and language conventions.",
          },
          rationale: {
            type: "string",
            description:
              "Why this change is correct and what it buys, in one or two sentences a junior developer will follow.",
          },
        },
        required: ["title", "file", "kind", "replacement", "rationale"],
      } as JsonSchemaObject,
    },
    {
      name: TOOL_NAMES.emitReport,
      description:
        "Finish the review and produce the overall report. Call this exactly once, after you have emitted your findings.",
      inputSchema: {
        type: "object",
        properties: {
          grade: {
            type: "string",
            enum: ["A", "B", "C", "D", "F"],
            description: "Overall architectural health.",
          },
          summary: {
            type: "string",
            description: "A few sentences summarising the state of the architecture and the most important thing to fix first.",
          },
          blueprint: {
            type: "object",
            description:
              "What this codebase should look like once the findings are addressed. Required for a full review — this is the part developers act on.",
            properties: {
              summary: {
                type: "string",
                description:
                  "The target shape in two or three sentences: the layers or boundaries this project should have, named after its own domain rather than in the abstract.",
              },
              moves: {
                type: "array",
                description:
                  "Code that belongs somewhere other than where it is. Name real paths on both sides.",
                items: {
                  type: "object",
                  properties: {
                    what: { type: "string", description: "The code or responsibility that should move." },
                    from: { type: "string", description: "Where it lives now — a real path." },
                    to: { type: "string", description: "Where it should live — a path to create or extend." },
                    why: { type: "string", description: "What that buys, concretely." },
                  },
                  required: ["what", "from", "to", "why"],
                },
              },
              stack: {
                type: "array",
                description:
                  "Concerns this project handles in a dated or hand-rolled way, and the current standard approach. Only include ones that would genuinely pay off at this project's size — do not recommend Kubernetes to a side project.",
                items: {
                  type: "object",
                  properties: {
                    concern: { type: "string", description: "e.g. \"Session storage\", \"Schema validation\", \"CI\"." },
                    current: { type: "string", description: "How the project does it today." },
                    recommended: { type: "string", description: "The specific library, service, or pattern to adopt, named." },
                    why: { type: "string", description: "Why it is better here, not in general." },
                  },
                  required: ["concern", "current", "recommended", "why"],
                },
              },
            },
            required: ["summary"],
          },
          scalability: {
            type: "object",
            description: "Required in scalability mode; omit otherwise.",
            properties: {
              target: { type: "string" },
              estimatedCurrentCapacity: { type: "string" },
              assumptions: { type: "array", items: { type: "string" } },
              bottlenecks: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    rank: { type: "number" },
                    component: { type: "string" },
                    why: { type: "string" },
                  },
                  required: ["rank", "component", "why"],
                },
              },
              roadmap: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    phase: { type: "string" },
                    actions: { type: "array", items: { type: "string" } },
                    expectedCapacity: { type: "string" },
                  },
                  required: ["phase", "actions", "expectedCapacity"],
                },
              },
            },
            required: [
              "target",
              "estimatedCurrentCapacity",
              "assumptions",
              "bottlenecks",
              "roadmap",
            ],
          },
        },
        required: ["grade", "summary"],
      } as JsonSchemaObject,
    },
  ];
}

export interface ToolContext {
  root: vscode.Uri;
  maxFileReadBytes: number;
  token: vscode.CancellationToken;
  /** The local project index that backs find_relevant and list_signals. */
  index: WorkspaceIndex;
}

export interface ReportSubmission {
  grade: Grade;
  summary: string;
  blueprint?: Blueprint;
  scalability?: ScalabilityAnalysis;
}

export interface ToolOutcome {
  content: string;
  isError?: boolean;
  finding?: Finding;
  fix?: CodeFix;
  report?: ReportSubmission;
}

export class ToolRunner {
  private findingCounter = 0;
  private fixCounter = 0;
  /** Emitted finding titles, so a fix can be linked back to one. */
  private readonly findingsByTitle = new Map<string, string>();

  constructor(private readonly ctx: ToolContext) {}

  async run(name: string, input: unknown): Promise<ToolOutcome> {
    const args = (typeof input === "object" && input !== null ? input : {}) as Record<
      string,
      unknown
    >;
    try {
      switch (name) {
        case TOOL_NAMES.findRelevant:
          return this.findRelevant(
            String(args.query ?? ""),
            numberOrUndefined(args.limit),
          );
        case TOOL_NAMES.listSignals:
          return this.listSignals(String(args.kind ?? ""));
        case TOOL_NAMES.listDir:
          return await this.listDir(String(args.path ?? ""));
        case TOOL_NAMES.readFile:
          return await this.readFile(
            String(args.path ?? ""),
            numberOrUndefined(args.startLine),
            numberOrUndefined(args.endLine),
          );
        case TOOL_NAMES.search:
          return await this.search(
            String(args.pattern ?? ""),
            Boolean(args.isRegex),
            typeof args.glob === "string" ? args.glob : undefined,
          );
        case TOOL_NAMES.emitFinding:
          return await this.emitFinding(args);
        case TOOL_NAMES.proposeFix:
          return await this.proposeFix(args);
        case TOOL_NAMES.emitReport:
          return this.emitReport(args);
        default:
          return { content: `Unknown tool: ${name}`, isError: true };
      }
    } catch (err) {
      return { content: `Tool failed: ${String(err)}`, isError: true };
    }
  }

  /** Resolves a model-supplied path, rejecting anything outside the workspace. */
  private resolve(relPath: string): vscode.Uri | undefined {
    const cleaned = relPath.trim().replace(/^\.?\//, "");
    if (cleaned === "" || cleaned === ".") return this.ctx.root;
    const segments = cleaned.split(/[\\/]+/).filter((s) => s.length > 0);
    if (segments.some((s) => s === "..")) return undefined;
    if (/^([a-zA-Z]:|~)/.test(cleaned) || relPath.startsWith("/")) return undefined;
    const uri = vscode.Uri.joinPath(this.ctx.root, ...segments);
    if (!uri.path.startsWith(this.ctx.root.path)) return undefined;
    return uri;
  }

  /**
   * Ranked lookup over the local index. Answers "where is X" without the model
   * having to read the repository, which is where most of the token cost used to go.
   */
  private findRelevant(query: string, limit?: number): ToolOutcome {
    if (!query.trim()) {
      return { content: "`query` is required.", isError: true };
    }
    const hits = retrieve(this.ctx.index, query, Math.min(limit ?? 8, 15));
    if (hits.length === 0) {
      return {
        content: `Nothing in the index matched "${query}". Try different words, list_signals for a specific marker, or search for an exact string.`,
      };
    }
    const lines = [`Files most relevant to "${query}":`, ""];
    for (const hit of hits) {
      lines.push(`${hit.path}${hit.reasons.length > 0 ? ` — ${hit.reasons.join("; ")}` : ""}`);
      for (const excerpt of hit.excerpts) {
        lines.push(`    ${excerpt.line}: ${excerpt.text}`);
      }
    }
    lines.push("");
    lines.push("Read the ones that matter before drawing conclusions from them.");
    return { content: lines.join("\n") };
  }

  private listSignals(kind: string): ToolOutcome {
    if (!ALL_SIGNAL_KINDS.includes(kind as SignalKind)) {
      return {
        content: `Unknown signal kind "${kind}". Valid kinds: ${ALL_SIGNAL_KINDS.join(", ")}.`,
        isError: true,
      };
    }
    const results = signalsOfKind(this.ctx.index, kind as SignalKind);
    if (results.length === 0) {
      return { content: `No occurrences of ${SIGNAL_LABELS[kind as SignalKind]} were indexed.` };
    }
    const lines = [`${SIGNAL_LABELS[kind as SignalKind]} — ${results.length} occurrence(s):`];
    for (const result of results) {
      lines.push(`${result.path}:${result.line}: ${result.text}`);
    }
    return { content: lines.join("\n") };
  }

  private async listDir(relPath: string): Promise<ToolOutcome> {
    const uri = this.resolve(relPath);
    if (!uri) {
      return { content: `Path is outside the workspace: ${relPath}`, isError: true };
    }
    const entries = await vscode.workspace.fs.readDirectory(uri);
    if (entries.length === 0) {
      return { content: `${relPath || "."} is empty.` };
    }
    const shown = entries.slice(0, MAX_DIR_ENTRIES);
    const lines = shown.map(([name, type]) =>
      type === vscode.FileType.Directory ? `${name}/` : name,
    );
    if (entries.length > shown.length) {
      lines.push(`… +${entries.length - shown.length} more entries`);
    }
    return { content: `${relPath || "."}:\n${lines.join("\n")}` };
  }

  private async readFile(
    relPath: string,
    startLine?: number,
    endLine?: number,
  ): Promise<ToolOutcome> {
    const uri = this.resolve(relPath);
    if (!uri) {
      return { content: `Path is outside the workspace: ${relPath}`, isError: true };
    }
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch {
      return {
        content: `No such file: ${relPath}. Use list_dir or search to find the correct path.`,
        isError: true,
      };
    }
    const text = Buffer.from(bytes).toString("utf8");
    const allLines = text.split(/\r?\n/);

    const from = Math.max(1, startLine ?? 1);
    const to = Math.min(allLines.length, endLine ?? allLines.length);
    const selected = allLines.slice(from - 1, to);
    const numbered = selected.map((line, i) => `${from + i}\t${line}`).join("\n");

    const { text: capped, truncated } = truncate(numbered, this.ctx.maxFileReadBytes);
    const header = `${relPath} (lines ${from}-${to} of ${allLines.length})`;
    return {
      content: `${header}\n${capped}${truncated ? "\n… [truncated: request a narrower line range]" : ""}`,
    };
  }

  /**
   * Content search over the workspace. `workspace.findTextInFiles` is still a
   * proposed API, so this reads candidate files itself — bounded by
   * MAX_FILES_SCANNED and the result cap to keep a broad pattern cheap.
   */
  private async search(
    pattern: string,
    isRegex: boolean,
    glob?: string,
  ): Promise<ToolOutcome> {
    if (!pattern) return { content: "`pattern` is required.", isError: true };

    // Nested quantifiers are the shape that backtracks catastrophically, and the
    // pattern here comes straight from a language model. One `(a+)+b` against
    // the wrong line would spin inside a single `test()` call — on the extension
    // host, which is the same thread the editor draws on, so the whole UI
    // freezes with no cancellation possible. Refusing is cheap and the model
    // simply retries with something simpler.
    if (isRegex && NESTED_QUANTIFIER.test(pattern)) {
      return {
        content:
          "That pattern nests one quantifier inside another, which can hang the editor. " +
          "Rewrite it without the nesting, or search for a literal substring instead.",
        isError: true,
      };
    }

    let matcher: RegExp;
    try {
      matcher = isRegex
        ? new RegExp(pattern, "i")
        : new RegExp(escapeRegex(pattern), "i");
    } catch (err) {
      return { content: `Invalid regular expression: ${String(err)}`, isError: true };
    }

    const files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(this.ctx.root, glob ?? "**/*"),
      "{**/node_modules/**,**/dist/**,**/build/**,**/.git/**,**/out/**,**/vendor/**,**/coverage/**}",
      MAX_FILES_SCANNED,
      this.ctx.token,
    );

    const matches: string[] = [];
    let scanned = 0;
    // The caps on files and results bound how much is read, but not how long is
    // spent reading it: a well-formed pattern over a large monorepo still walks
    // every line of 1500 files without yielding. A wall clock is the only bound
    // that actually holds, and a partial answer beats a stalled editor.
    const deadline = Date.now() + SEARCH_TIME_BUDGET_MS;
    let timedOut = false;
    for (const uri of files) {
      if (matches.length >= MAX_SEARCH_RESULTS) break;
      if (this.ctx.token.isCancellationRequested) break;
      if (Date.now() > deadline) {
        timedOut = true;
        break;
      }

      let bytes: Uint8Array;
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type !== vscode.FileType.File || stat.size > MAX_SEARCH_FILE_BYTES) {
          continue;
        }
        bytes = await vscode.workspace.fs.readFile(uri);
      } catch {
        continue;
      }
      const text = Buffer.from(bytes).toString("utf8");
      if (text.includes("\u0000")) continue; // skip binary files
      scanned++;

      const rel = relativeTo(this.ctx.root, uri);
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (matches.length >= MAX_SEARCH_RESULTS) break;
        if (matcher.test(lines[i])) {
          matches.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, MAX_MATCH_CHARS)}`);
        }
      }
    }

    const ranOut = timedOut
      ? `\n… stopped after ${SEARCH_TIME_BUDGET_MS / 1000}s and ${scanned} files; narrow the pattern or pass a glob.`
      : "";
    if (matches.length === 0) {
      return {
        content: `No matches for ${pattern} (searched ${scanned} files).${ranOut}`,
      };
    }
    const capped = matches.length >= MAX_SEARCH_RESULTS;
    return {
      content:
        `${matches.length} match(es) for ${pattern}:\n${matches.join("\n")}` +
        (capped ? "\n… result cap reached; narrow the pattern for more." : ranOut),
    };
  }

  private async emitFinding(args: Record<string, unknown>): Promise<ToolOutcome> {
    const parsed = parseFindingInput(args);
    if (!parsed.ok) {
      return { content: `Finding rejected: ${parsed.error}`, isError: true };
    }

    const validated: Evidence[] = [];
    const problems: string[] = [];
    for (const evidence of parsed.finding.evidence) {
      const checked = await this.validateEvidence(evidence);
      if (checked.ok) {
        validated.push(checked.evidence);
      } else {
        problems.push(checked.reason);
      }
    }

    if (validated.length === 0) {
      return {
        content:
          `Finding rejected — none of its evidence could be verified against the workspace: ${problems.join(
            " ",
          )} Re-read the file to get the real path and line numbers, then call emit_finding again.`,
        isError: true,
      };
    }

    const finding: Finding = {
      ...parsed.finding,
      evidence: validated,
      id: `finding-${++this.findingCounter}`,
    };
    this.findingsByTitle.set(normalizeTitle(finding.title), finding.id);
    const note =
      problems.length > 0
        ? ` (${problems.length} evidence item(s) dropped: ${problems.join(" ")})`
        : "";
    return {
      content:
        `Recorded "${finding.title}".${note}` +
        " If the fix is small and local, call propose_fix now to attach an applicable patch.",
      finding,
    };
  }

  /**
   * Accepts a patch only if it actually applies.
   *
   * This is the whole value of the tool. A recommendation written in prose is
   * unfalsifiable — it sounds right whether or not the model read the file. A
   * patch anchored to verbatim text either matches what is on disk or it does
   * not, and a rejection here sends the model back to read the code properly
   * rather than shipping a confident patch against imagined source.
   */
  private async proposeFix(args: Record<string, unknown>): Promise<ToolOutcome> {
    const file = String(args.file ?? "").trim();
    const title = String(args.title ?? "").trim();
    const replacement = typeof args.replacement === "string" ? args.replacement : "";
    const rationale = String(args.rationale ?? "").trim();
    const kind =
      args.kind === "replace" || args.kind === "insert-after" || args.kind === "create"
        ? args.kind
        : "replace";

    if (!file || !title || !rationale) {
      return { content: "`file`, `title` and `rationale` are all required.", isError: true };
    }
    if (replacement.trim().length === 0 && kind !== "replace") {
      return { content: "`replacement` cannot be empty for this kind of fix.", isError: true };
    }

    const uri = this.resolve(file);
    if (!uri) {
      return { content: `Path is outside the workspace: ${file}`, isError: true };
    }

    let existing: string | undefined;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type === vscode.FileType.File) {
        existing = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
      }
    } catch {
      /* no such file yet */
    }

    if (kind === "create") {
      if (existing !== undefined) {
        return {
          content: `${file} already exists — use kind "replace" or "insert-after", or pick a new path.`,
          isError: true,
        };
      }
      return this.acceptFix({
        title,
        file: relativeTo(this.ctx.root, uri),
        kind,
        anchor: "",
        replacement,
        rationale,
        findingTitle: args.findingTitle,
        verified: true,
      });
    }

    if (existing === undefined) {
      return {
        content: `No such file: ${file}. Read the file first so the anchor can be copied from it.`,
        isError: true,
      };
    }

    const anchor = typeof args.anchor === "string" ? args.anchor : "";
    if (anchor.trim().length === 0) {
      return {
        content:
          "`anchor` is required for this kind of fix — copy the exact lines you are changing out of read_file output.",
        isError: true,
      };
    }

    const located = locateAnchor(existing, anchor);
    if (located.kind === "missing") {
      return {
        content:
          `The anchor does not appear in ${file}, so this patch cannot be applied. ` +
          "Re-read the file and copy the target lines exactly as they are, without the line-number prefix, then call propose_fix again.",
        isError: true,
      };
    }
    if (located.kind === "ambiguous") {
      return {
        content:
          `The anchor appears ${located.count} times in ${file}, so there is no way to know which one you mean. ` +
          "Extend it with the surrounding lines until it is unique.",
        isError: true,
      };
    }
    if (kind === "replace" && located.text === replacement) {
      return {
        content: "The replacement is identical to the anchor — this patch would change nothing.",
        isError: true,
      };
    }

    return this.acceptFix({
      title,
      file: relativeTo(this.ctx.root, uri),
      kind,
      // Store what is actually in the file, so whitespace-tolerant matching
      // never produces a patch that differs from what the user is shown.
      anchor: located.text,
      // …and shift the new code by the same amount the anchor was off by.
      replacement: reindent(replacement, located.anchorIndent, located.fileIndent),
      rationale,
      findingTitle: args.findingTitle,
      startLine: located.startLine,
      endLine: located.endLine,
      verified: true,
    });
  }

  /**
   * Links a fix to the finding it repairs. Models paraphrase their own titles
   * when referring back to them, so an exact match is tried first and a
   * containment match second — close enough to be safe, since the titles being
   * compared are all ones this run produced.
   */
  private matchFinding(title: string): string | undefined {
    const wanted = normalizeTitle(title);
    if (wanted.length === 0) return undefined;
    const exact = this.findingsByTitle.get(wanted);
    if (exact) return exact;
    for (const [known, id] of this.findingsByTitle) {
      if (known.includes(wanted) || wanted.includes(known)) return id;
    }
    return undefined;
  }

  private acceptFix(input: {
    title: string;
    file: string;
    kind: CodeFix["kind"];
    anchor: string;
    replacement: string;
    rationale: string;
    findingTitle: unknown;
    startLine?: number;
    endLine?: number;
    verified: boolean;
  }): ToolOutcome {
    const findingId =
      typeof input.findingTitle === "string"
        ? this.matchFinding(input.findingTitle)
        : undefined;

    const fix: CodeFix = {
      id: `fix-${++this.fixCounter}`,
      findingId,
      title: input.title,
      file: input.file,
      kind: input.kind,
      anchor: input.anchor,
      replacement: input.replacement,
      rationale: input.rationale,
      language: languageOf(input.file),
      startLine: input.startLine,
      endLine: input.endLine,
      verified: input.verified,
    };

    const note = findingId
      ? ""
      : " It is not linked to a finding — pass the finding's exact title as `findingTitle` if it belongs to one.";
    return {
      content: `Fix verified against ${fix.file} and attached.${note}`,
      fix,
    };
  }

  /**
   * Confirms the file exists, clamps line numbers to the file, and re-anchors on
   * the snippet hint when the model's line number drifted. Findings that survive
   * this are safe to render as clickable links and diagnostics.
   */
  private async validateEvidence(
    evidence: Evidence,
  ): Promise<{ ok: true; evidence: Evidence } | { ok: false; reason: string }> {
    const uri = this.resolve(evidence.file);
    if (!uri) return { ok: false, reason: `${evidence.file} is outside the workspace.` };

    let bytes: Uint8Array;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type !== vscode.FileType.File) {
        return { ok: false, reason: `${evidence.file} is not a file.` };
      }
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch {
      return { ok: false, reason: `${evidence.file} does not exist.` };
    }

    const lines = Buffer.from(bytes).toString("utf8").split(/\r?\n/);
    const normalizedFile = relativeTo(this.ctx.root, uri);
    let startLine = evidence.startLine;
    let endLine = evidence.endLine;

    if (startLine !== undefined) {
      startLine = clamp(Math.floor(startLine), 1, lines.length);
      const hint = evidence.snippetHint?.trim();
      if (hint && hint.length >= 4) {
        const anchored = anchorSnippet(lines, hint, startLine);
        if (anchored !== undefined) {
          startLine = anchored;
        } else if (!lines[startLine - 1]?.includes(hint)) {
          // Snippet is nowhere near the cited line — keep the file, drop the line.
          startLine = undefined;
          endLine = undefined;
        }
      }
    }
    if (startLine !== undefined && endLine !== undefined) {
      endLine = clamp(Math.floor(endLine), startLine, lines.length);
    } else {
      endLine = undefined;
    }

    return {
      ok: true,
      evidence: { ...evidence, file: normalizedFile, startLine, endLine },
    };
  }

  private emitReport(args: Record<string, unknown>): ToolOutcome {
    const grade = args.grade;
    const summary = args.summary;
    if (typeof summary !== "string" || summary.trim().length === 0) {
      return { content: "`summary` is required.", isError: true };
    }
    const validGrades: Grade[] = ["A", "B", "C", "D", "F"];
    const finalGrade = validGrades.includes(grade as Grade) ? (grade as Grade) : "C";

    return {
      content: "Report received. The review is complete.",
      report: {
        grade: finalGrade,
        summary: summary.trim(),
        blueprint: parseBlueprint(args.blueprint),
        scalability: parseScalability(args.scalability),
      },
    };
  }
}

type AnchorMatch =
  | {
      kind: "found";
      /** The text exactly as it appears in the file. */
      text: string;
      startLine: number;
      endLine: number;
      /** Leading whitespace on the first matched line, in the file and in the anchor. */
      fileIndent: string;
      anchorIndent: string;
    }
  | { kind: "missing" }
  | { kind: "ambiguous"; count: number };

/**
 * Finds the anchor in the file, tolerantly but not carelessly.
 *
 * Two passes. The first ignores only trailing whitespace and line endings —
 * differences that cannot change meaning. The second ignores indentation too,
 * because a model transcribing code out of numbered `read_file` output very
 * often re-indents it; that match is still trustworthy, and the caller shifts
 * the replacement by the same amount so the patched code lands correctly.
 * Anything looser would start matching code the model never actually read.
 */
export function locateAnchor(content: string, anchor: string): AnchorMatch {
  const fileLines = content.split(/\r?\n/);
  const anchorLines = anchor.split(/\r?\n/);
  while (anchorLines.length > 0 && anchorLines[0].trim() === "") anchorLines.shift();
  while (anchorLines.length > 0 && anchorLines[anchorLines.length - 1].trim() === "") {
    anchorLines.pop();
  }
  if (anchorLines.length === 0) return { kind: "missing" };

  const found = (starts: number[]): AnchorMatch => {
    if (starts.length === 0) return { kind: "missing" };
    if (starts.length > 1) return { kind: "ambiguous", count: starts.length };
    const start = starts[0];
    const slice = fileLines.slice(start, start + anchorLines.length);
    return {
      kind: "found",
      text: slice.join("\n"),
      startLine: start + 1,
      endLine: start + anchorLines.length,
      fileIndent: indentOf(slice[0]),
      anchorIndent: indentOf(anchorLines[0]),
    };
  };

  const scan = (compare: (a: string, b: string) => boolean): number[] => {
    const starts: number[] = [];
    for (let i = 0; i + anchorLines.length <= fileLines.length; i++) {
      let ok = true;
      for (let j = 0; j < anchorLines.length; j++) {
        if (!compare(fileLines[i + j], anchorLines[j])) {
          ok = false;
          break;
        }
      }
      if (ok) starts.push(i);
    }
    return starts;
  };

  const exact = scan((a, b) => a.trimEnd() === b.trimEnd());
  if (exact.length > 0) return found(exact);
  return found(scan((a, b) => a.trim() === b.trim()));
}

function indentOf(line: string): string {
  return /^[ \t]*/.exec(line ?? "")?.[0] ?? "";
}

/**
 * Shifts a block of code by the difference between two indents, so a patch
 * written at one nesting level lands correctly at another.
 */
export function reindent(text: string, from: string, to: string): string {
  if (from === to) return text;
  return text
    .split("\n")
    .map((line) => {
      if (line.trim() === "") return line;
      return line.startsWith(from) ? to + line.slice(from.length) : to + line.trimStart();
    })
    .join("\n");
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function languageOf(file: string): string | undefined {
  const ext = file.includes(".") ? file.split(".").pop()?.toLowerCase() : undefined;
  return ext && ext.length <= 5 ? ext : undefined;
}

function parseBlueprint(input: unknown): Blueprint | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const raw = input as Record<string, unknown>;
  const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
  if (summary.length === 0) return undefined;

  const objects = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value)
      ? value.filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
      : [];

  return {
    summary,
    moves: objects(raw.moves)
      .filter((m) => typeof m.what === "string" && typeof m.to === "string")
      .map((m) => ({
        what: String(m.what),
        from: String(m.from ?? "unspecified"),
        to: String(m.to),
        why: String(m.why ?? ""),
      })),
    stack: objects(raw.stack)
      .filter((s) => typeof s.concern === "string" && typeof s.recommended === "string")
      .map((s) => ({
        concern: String(s.concern),
        current: String(s.current ?? "not handled"),
        recommended: String(s.recommended),
        why: String(s.why ?? ""),
      })),
  };
}

function parseScalability(input: unknown): ScalabilityAnalysis | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const raw = input as Record<string, unknown>;
  if (typeof raw.target !== "string") return undefined;

  return {
    target: raw.target,
    estimatedCurrentCapacity:
      typeof raw.estimatedCurrentCapacity === "string"
        ? raw.estimatedCurrentCapacity
        : "not estimated",
    assumptions: stringArray(raw.assumptions),
    bottlenecks: Array.isArray(raw.bottlenecks)
      ? raw.bottlenecks
          .filter((b): b is Record<string, unknown> => typeof b === "object" && b !== null)
          .map((b, i) => ({
            rank: typeof b.rank === "number" ? b.rank : i + 1,
            component: String(b.component ?? "unnamed component"),
            why: String(b.why ?? ""),
          }))
          .sort((a, b) => a.rank - b.rank)
      : [],
    roadmap: Array.isArray(raw.roadmap)
      ? raw.roadmap
          .filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null)
          .map((p) => ({
            phase: String(p.phase ?? "Phase"),
            actions: stringArray(p.actions),
            expectedCapacity: String(p.expectedCapacity ?? ""),
          }))
      : [],
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Finds the snippet within ±SNIPPET_ANCHOR_WINDOW lines of the claimed line. */
function anchorSnippet(lines: string[], hint: string, claimed: number): number | undefined {
  const from = Math.max(0, claimed - 1 - SNIPPET_ANCHOR_WINDOW);
  const to = Math.min(lines.length, claimed + SNIPPET_ANCHOR_WINDOW);
  const needle = hint.replace(/\s+/g, " ").trim();
  for (let i = from; i < to; i++) {
    if (lines[i].replace(/\s+/g, " ").includes(needle)) return i + 1;
  }
  return undefined;
}

export function relativeTo(root: vscode.Uri, uri: vscode.Uri): string {
  const rootPath = root.path.endsWith("/") ? root.path : `${root.path}/`;
  return uri.path.startsWith(rootPath) ? uri.path.slice(rootPath.length) : uri.path;
}
