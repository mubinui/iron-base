/**
 * The tools that change things.
 *
 * Everything here sits behind two checks the reading tools never needed: the
 * path guard, which is all that keeps a model-written string from addressing a
 * file outside the workspace, and the permission broker, which is what makes the
 * developer the one who decides. Between those two, a snapshot goes into the
 * checkpoint so any of it can be taken back.
 *
 * The reading tools are not reimplemented here. `CodingToolRunner` wraps the
 * review's `ToolRunner`, so the index lookups, the file reads and the search
 * behave identically in both modes — including the caps and the regex guard that
 * keep a bad pattern from freezing the editor.
 */

import * as vscode from "vscode";
import { log } from "../util/log";
import { relativeTo, resolveInside } from "../util/paths";
import type { WorkspaceIndex } from "../memory/store";
import { screenCommand } from "./commandGuard";
import { describeProblems, problemsFor } from "./codeDiagnostics";
import { reindexFile } from "../memory/indexer";
import type { McpRegistry } from "../mcp/registry";
import { runSubagent, type SubagentContext } from "./subagent";
import type { Checkpoint } from "./checkpoint";
import { diffLines, formatDiffCounts, type FileDiff } from "./diff";
import { parsePlan, parseTodos, type BuildPlan, type Todo } from "./plan";
import type { PermissionBroker } from "./permissions";
import { describeResult, runCommand, type CommandResult } from "./shell";
import { locateAnchor, reindent, ToolRunner, TOOL_NAMES, type ToolOutcome } from "./tools";
import { CODING_TOOL_NAMES, SUBAGENT_TOOL, codingToolDefinitions } from "./codingToolDefs";

// Re-exported so callers reach the tools and the runner through one import,
// the way `tools.ts` does for the review.
export { CODING_TOOL_NAMES, codingToolDefinitions };

/** Bytes above which a single write is refused as implausible. */
const MAX_WRITE_BYTES = 512 * 1024;

export interface FileChange {
  id: string;
  file: string;
  kind: "edit" | "create" | "delete";
  diff: FileDiff;
  why?: string;
}

export interface CommandRun {
  id: string;
  command: string;
  why?: string;
  result: CommandResult;
}

export interface CodingOutcome extends ToolOutcome {
  todos?: Todo[];
  plan?: BuildPlan;
  finished?: { summary: string; followUps: string[] };
}

export interface CodingToolContext {
  root: vscode.Uri;
  maxFileReadBytes: number;
  commandTimeoutMs: number;
  token: vscode.CancellationToken;
  permissions: PermissionBroker;
  checkpoint: Checkpoint;
  /** A file was written, created or deleted — the panel draws the card. */
  onFileChange: (change: FileChange) => void;
  /** A command is starting; output streams through `onCommandOutput`. */
  onCommandStart: (id: string, command: string, why?: string) => void;
  onCommandOutput: (id: string, chunk: string) => void;
  onCommandEnd: (run: CommandRun) => void;
  /** The live project index, kept current as the agent edits. */
  index: WorkspaceIndex;
  /** Absent when the agent is not allowed to delegate. */
  subagent?: Omit<SubagentContext, "onProgress">;
  /** Absent when no MCP server is configured or all of them failed to start. */
  mcp?: McpRegistry;
  /**
   * Distinguishes this run's ids from every other run's in the same session.
   *
   * A runner is built per task and its counters start at one, so without this
   * the second task in a session hands out `change-1` again — and the panel
   * resolves an id by searching the thread, so Undo on the newer card found
   * the older card and put back a file nobody had asked about.
   */
  runId: string;
  onSubagentProgress?: (question: string, note: string) => void;
}

export class CodingToolRunner {
  private readonly reader: ToolRunner;
  /**
   * Files read in this session.
   *
   * `write_file` overwrites blind otherwise, which is the classic way an agent
   * destroys work: it decides a file "should" contain something, writes its idea
   * of it, and everything the file also contained is gone. `edit_file` needs no
   * such rule — its anchor cannot match text the model never saw.
   */
  private readonly readFiles = new Set<string>();
  private changeCounter = 0;
  private commandCounter = 0;

  constructor(private readonly ctx: CodingToolContext) {
    // The same index object the write path re-reads files into, so a lookup
    // made after an edit sees the edit.
    this.reader = new ToolRunner({
      root: ctx.root,
      maxFileReadBytes: ctx.maxFileReadBytes,
      token: ctx.token,
      index: ctx.index,
    });
  }

  async run(name: string, input: unknown): Promise<CodingOutcome> {
    const args = (typeof input === "object" && input !== null ? input : {}) as Record<
      string,
      unknown
    >;
    try {
      switch (name) {
        case CODING_TOOL_NAMES.editFile:
          return await this.editFile(args);
        case CODING_TOOL_NAMES.writeFile:
          return await this.writeFile(args);
        case CODING_TOOL_NAMES.deleteFile:
          return await this.deleteFile(args);
        case CODING_TOOL_NAMES.runCommand:
          return await this.runShell(args);
        case CODING_TOOL_NAMES.updateTodos:
          return this.updateTodos(args);
        case CODING_TOOL_NAMES.submitPlan:
          return this.submitPlan(args);
        case CODING_TOOL_NAMES.finish:
          return this.finish(args);
        case SUBAGENT_TOOL:
          return await this.delegate(args);
        default: {
          if (this.ctx.mcp?.isMcpTool(name)) return await this.callMcp(name, args);
          const outcome = await this.reader.run(name, input);
          if (name === TOOL_NAMES.readFile && !outcome.isError) {
            const uri = resolveInside(this.ctx.root, String(args.path ?? ""));
            if (uri) this.readFiles.add(relativeTo(this.ctx.root, uri));
          }
          return outcome;
        }
      }
    } catch (err) {
      return { content: `Tool failed: ${String(err)}`, isError: true };
    }
  }

  private async editFile(args: Record<string, unknown>): Promise<CodingOutcome> {
    const path = String(args.path ?? "").trim();
    const oldText = typeof args.old_text === "string" ? args.old_text : "";
    const newText = typeof args.new_text === "string" ? args.new_text : "";
    const why = String(args.why ?? "").trim() || undefined;

    if (!path) return fail("`path` is required.");
    if (oldText.trim().length === 0) {
      return fail(
        "`old_text` is required — copy the exact lines you are changing out of read_file output, without the line-number prefix.",
      );
    }
    if (oldText === newText) {
      return fail("`old_text` and `new_text` are identical, so this edit would change nothing.");
    }

    const uri = resolveInside(this.ctx.root, path);
    if (!uri || uri.path === this.ctx.root.path) {
      return fail(`${path} is not a file inside the workspace.`);
    }

    const before = await readText(uri);
    if (before === undefined) {
      return fail(
        `No such file: ${path}. Use write_file to create it, or list_dir to find the real path.`,
      );
    }

    // The same tolerant-but-not-careless matcher the review's patches go
    // through: trailing whitespace and indentation may differ, nothing else may.
    const located = locateAnchor(before, oldText);
    if (located.kind === "missing") {
      return fail(
        `\`old_text\` does not appear in ${path}. Read the file again and copy the target lines exactly as they are now — they may have changed since you last looked.`,
      );
    }
    if (located.kind === "ambiguous") {
      return fail(
        `\`old_text\` appears ${located.count} times in ${path}, so there is no way to know which one you mean. Extend it with the surrounding lines until it is unique.`,
      );
    }

    const lines = before.split(/\r?\n/);
    const after = [
      ...lines.slice(0, located.startLine - 1),
      // Shift the new code by however much the anchor's indentation was off, so
      // a patch transcribed at the wrong nesting level still lands correctly.
      ...reindent(newText, located.anchorIndent, located.fileIndent).split("\n"),
      ...lines.slice(located.endLine),
    ].join("\n");

    return await this.commit(uri, path, before, after, "edit", why);
  }

  private async writeFile(args: Record<string, unknown>): Promise<CodingOutcome> {
    const path = String(args.path ?? "").trim();
    const content = typeof args.content === "string" ? args.content : "";
    const why = String(args.why ?? "").trim() || undefined;

    if (!path) return fail("`path` is required.");
    if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
      return fail(
        `That file would be ${Math.round(Buffer.byteLength(content, "utf8") / 1024)}KB, which is past what IronBase will write in one go. Split it up, or edit the file in pieces.`,
      );
    }

    const uri = resolveInside(this.ctx.root, path);
    if (!uri || uri.path === this.ctx.root.path) {
      return fail(`${path} is not a file inside the workspace.`);
    }

    const before = await readText(uri);
    if (before !== undefined && !this.readFiles.has(relativeTo(this.ctx.root, uri))) {
      return fail(
        `${path} already exists and you have not read it in this session. Read it first — overwriting a file you have not seen destroys whatever else was in it. If you only mean to change part of it, use edit_file.`,
      );
    }
    if (before === content) {
      return fail(`${path} already contains exactly that, so this write would change nothing.`);
    }

    return await this.commit(uri, path, before ?? "", content, before === undefined ? "create" : "edit", why);
  }

  /** The one path where bytes actually reach the disk. */
  private async commit(
    uri: vscode.Uri,
    rawPath: string,
    before: string,
    after: string,
    kind: "edit" | "create",
    why: string | undefined,
  ): Promise<CodingOutcome> {
    // From here on the path is the workspace-relative form, never the one the
    // model typed. The checkpoint keys its snapshots this way, so a model that
    // writes `./src/db.js` where it wrote `src/db.js` last time would otherwise
    // produce a change card whose Undo button matches nothing.
    const path = relativeTo(this.ctx.root, uri);
    const diff = diffLines(before, after);

    const permitted = await this.ctx.permissions.request({
      kind,
      subject: path,
      why,
      preview: diff,
    });
    if (!permitted.granted) return fail(permitted.reason);

    // Snapshot before writing, and refuse the write if the snapshot could not be
    // taken — a change nobody can undo is not worth the convenience.
    const captured = await this.ctx.checkpoint.capture(uri);
    if (!captured.ok) return fail(captured.reason);

    await writeText(uri, after);

    const change: FileChange = {
      id: `change-${this.ctx.runId}-${++this.changeCounter}`,
      file: path,
      kind,
      diff,
      why,
    };
    this.ctx.onFileChange(change);
    log.info(`${kind === "create" ? "Created" : "Edited"} ${path} (${formatDiffCounts(diff)}).`);

    // The index answered every `find_relevant` in this session from what this
    // file said when the session started. Now that is wrong, so it is re-read
    // before the next question is asked of it.
    await reindexFile(this.ctx.index, this.ctx.root, path, "");

    const lineCount = after.length === 0 ? 0 : after.split(/\r?\n/).length;
    let content =
      `${kind === "create" ? "Created" : "Updated"} ${path} — ${formatDiffCounts(diff)}. ` +
      `The file is now ${lineCount} line(s) and the change is on disk, so a test run will see it.`;

    // What the editor's own language server makes of the change, which it knows
    // within a second and the agent would otherwise not learn until it ran the
    // tests — if it remembered to.
    const problems = await problemsFor(uri);
    if (problems) content += describeProblems(path, problems);

    return { content };
  }

  private async deleteFile(args: Record<string, unknown>): Promise<CodingOutcome> {
    const requested = String(args.path ?? "").trim();
    const why = String(args.why ?? "").trim() || undefined;
    if (!requested) return fail("`path` is required.");

    const uri = resolveInside(this.ctx.root, requested);
    if (!uri || uri.path === this.ctx.root.path) {
      return fail(`${requested} is not a file inside the workspace.`);
    }

    const before = await readText(uri);
    if (before === undefined) return fail(`No such file: ${requested}.`);

    const path = relativeTo(this.ctx.root, uri);

    const permitted = await this.ctx.permissions.request({
      kind: "delete",
      subject: path,
      why,
      preview: diffLines(before, ""),
    });
    if (!permitted.granted) return fail(permitted.reason);

    const captured = await this.ctx.checkpoint.capture(uri);
    if (!captured.ok) return fail(captured.reason);

    // To the trash rather than gone: the checkpoint can put it back, but the
    // developer's own recovery routes should stay open too.
    await vscode.workspace.fs.delete(uri, { useTrash: true });
    await reindexFile(this.ctx.index, this.ctx.root, path, "");
    this.ctx.onFileChange({
      id: `change-${this.ctx.runId}-${++this.changeCounter}`,
      file: path,
      kind: "delete",
      diff: diffLines(before, ""),
      why,
    });
    log.info(`Deleted ${path}.`);
    return { content: `Deleted ${path}.` };
  }

  private async runShell(args: Record<string, unknown>): Promise<CodingOutcome> {
    const command = String(args.command ?? "").trim();
    const why = String(args.why ?? "").trim() || undefined;

    const screened = screenCommand(command);
    if (!screened.ok) return fail(screened.reason);

    const permitted = await this.ctx.permissions.request({
      kind: "command",
      subject: command,
      why,
    });
    if (!permitted.granted) return fail(permitted.reason);

    const id = `command-${this.ctx.runId}-${++this.commandCounter}`;
    this.ctx.onCommandStart(id, command, why);
    const result = await runCommand({
      command,
      cwd: this.ctx.root,
      timeoutMs: this.ctx.commandTimeoutMs,
      token: this.ctx.token,
      onOutput: (chunk) => this.ctx.onCommandOutput(id, chunk),
    });
    this.ctx.onCommandEnd({ id, command, why, result });

    const status = describeResult(result);
    const body = result.output.trim().length > 0 ? result.output.trimEnd() : "(no output)";
    return {
      content: `$ ${command}\n${status}\n\n${body}`,
      // A non-zero exit is reported as an error so the model treats it as
      // something to fix rather than a step it can tick off.
      isError: result.exitCode !== 0,
    };
  }

  /**
   * Hands a research question to a subagent and returns its written answer.
   *
   * The searching it does never enters this transcript — that is the point of
   * delegating — so what comes back has to stand alone.
   */
  private async delegate(args: Record<string, unknown>): Promise<CodingOutcome> {
    const question = String(args.question ?? "").trim();
    if (question.length === 0) return fail("`question` is required.");
    if (!this.ctx.subagent) {
      return fail("Delegated search is not available here. Use find_relevant yourself.");
    }

    const result = await runSubagent(question, {
      ...this.ctx.subagent,
      onProgress: (note) => this.ctx.onSubagentProgress?.(question, note),
    });
    log.info(`Delegated search finished in ${result.steps} step(s).`);

    return {
      content:
        `Answer from the delegated search (${result.steps} step(s)):\n\n${result.answer}\n\n` +
        "That assistant could only read, and its working is not available to you — if you are going to act on this, confirm the specific lines yourself first.",
    };
  }

  /** Calls a tool on an MCP server, behind the same prompt a command gets. */
  private async callMcp(name: string, args: Record<string, unknown>): Promise<CodingOutcome> {
    const registry = this.ctx.mcp;
    if (!registry) return fail(`No MCP server is connected, so ${name} cannot be called.`);

    const route = registry.routeFor(name);
    // Gated as a command, not as an edit: an MCP tool reaches outside the
    // workspace by design, and "allow all edits" was never agreed to for that.
    const permitted = await this.ctx.permissions.request({
      kind: "command",
      subject: `${route?.server ?? "mcp"} → ${route?.tool ?? name}`,
      why: typeof args.why === "string" ? args.why : undefined,
    });
    if (!permitted.granted) return fail(permitted.reason);

    const result = await registry.call(name, args);
    return { content: result.content, isError: result.isError };
  }

  private updateTodos(args: Record<string, unknown>): CodingOutcome {
    const todos = parseTodos(args.todos);
    if (todos.length === 0) {
      return fail("`todos` must be a non-empty array, each item with a `title` and a `status`.");
    }
    const active = todos.filter((t) => t.status === "active").length;
    const done = todos.filter((t) => t.status === "done").length;
    return {
      content:
        `Task list updated: ${done} of ${todos.length} done.` +
        (active > 1
          ? " More than one task is marked active — keep exactly one, so it is clear what you are on."
          : ""),
      todos,
    };
  }

  private submitPlan(args: Record<string, unknown>): CodingOutcome {
    const plan = parsePlan(args);
    if (!plan) {
      return fail(
        "The plan needs at least a `summary` and one entry in `steps`, each step with a `title`.",
      );
    }
    if (plan.steps.length === 0) {
      return fail("A plan with no steps is not something the developer can approve. Add the steps.");
    }
    return { content: "Plan submitted for approval. Stop here — do not start building.", plan };
  }

  private finish(args: Record<string, unknown>): CodingOutcome {
    const summary = String(args.summary ?? "").trim();
    if (summary.length === 0) return fail("`summary` is required.");
    const followUps = Array.isArray(args.followUps)
      ? args.followUps.filter((f): f is string => typeof f === "string")
      : [];
    return { content: "Reported. The task is complete.", finished: { summary, followUps } };
  }
}

function fail(content: string): CodingOutcome {
  return { content, isError: true };
}

function dirname(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type !== vscode.FileType.File) return undefined;
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
  } catch {
    return undefined;
  }
}

/**
 * Writes the file, and leaves it saved.
 *
 * Saved, not dirty — unlike the review's Apply button, because the next thing
 * that happens here is usually `npm test`, and a test run reads the disk. When
 * the file is already open in an editor the write goes through a `WorkspaceEdit`
 * so it lands in that editor's undo stack, which is one more way back for the
 * developer beyond IronBase's own.
 */
async function writeText(uri: vscode.Uri, content: string): Promise<void> {
  const open = vscode.workspace.textDocuments.find(
    (doc) => doc.uri.toString() === uri.toString() && !doc.isClosed,
  );
  if (!open) {
    // A new file often lands in a directory that does not exist yet — creating
    // it is idempotent, so this costs nothing on the common path.
    await vscode.workspace.fs.createDirectory(uri.with({ path: dirname(uri.path) }));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    uri,
    new vscode.Range(new vscode.Position(0, 0), open.lineAt(open.lineCount - 1).range.end),
    content,
  );
  if (!(await vscode.workspace.applyEdit(edit))) {
    // The editor refused for its own reasons; the file still has to end up
    // correct, so fall through to writing it directly.
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
    return;
  }
  await open.save();
}
