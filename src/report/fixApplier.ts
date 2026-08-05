import * as vscode from "vscode";
import type { CodeFix } from "../engine/findings";
import { locateAnchor } from "../engine/tools";
import { log } from "../util/log";
import { resolveInside } from "../util/paths";

export type ApplyResult =
  | { ok: true; file: string; line: number }
  | { ok: false; reason: string };

/**
 * Applies a proposed patch to the workspace.
 *
 * The anchor is re-located immediately before writing, never trusted from when
 * the review ran. A report can sit open for hours while the developer edits the
 * same file — and the failure mode of applying a stale patch is silently
 * corrupting working code, which is far worse than refusing. If the anchor has
 * moved, the match still succeeds and the patch lands in the right place; if it
 * is gone or has become ambiguous, we stop and say so.
 *
 * The edit goes through a `WorkspaceEdit` and is deliberately left unsaved, so
 * it lands in the undo stack and the developer reviews it in their editor before
 * committing to it.
 */
export async function applyFix(
  root: vscode.Uri,
  fix: CodeFix,
): Promise<ApplyResult> {
  const uri = resolveFile(root, fix.file);
  if (!uri) return { ok: false, reason: `${fix.file} is outside the workspace.` };

  if (fix.kind === "create") {
    return await createFile(uri, fix);
  }

  let document: vscode.TextDocument;
  try {
    document = await vscode.workspace.openTextDocument(uri);
  } catch {
    return {
      ok: false,
      reason: `${fix.file} no longer exists, so this fix cannot be applied.`,
    };
  }

  const located = locateAnchor(document.getText(), fix.anchor);
  if (located.kind === "missing") {
    return {
      ok: false,
      reason:
        `The code this fix targets is no longer in ${fix.file} — it has been edited or already fixed since the review ran. ` +
        "Re-run the review to get a patch against the current file.",
    };
  }
  if (located.kind === "ambiguous") {
    return {
      ok: false,
      reason:
        `The code this fix targets now appears ${located.count} times in ${fix.file}, so IronBase cannot tell which one to change. ` +
        "Apply it by hand, or re-run the review.",
    };
  }

  const start = new vscode.Position(located.startLine - 1, 0);
  const endLine = located.endLine - 1;
  const end = new vscode.Position(endLine, document.lineAt(endLine).text.length);

  const edit = new vscode.WorkspaceEdit();
  if (fix.kind === "insert-after") {
    edit.insert(uri, end, `\n${fix.replacement}`);
  } else {
    edit.replace(uri, new vscode.Range(start, end), fix.replacement);
  }

  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    return { ok: false, reason: `VS Code refused the edit to ${fix.file}.` };
  }

  await reveal(uri, located.startLine);
  log.info(`Applied fix "${fix.title}" to ${fix.file}:${located.startLine}.`);
  return { ok: true, file: fix.file, line: located.startLine };
}

async function createFile(uri: vscode.Uri, fix: CodeFix): Promise<ApplyResult> {
  try {
    await vscode.workspace.fs.stat(uri);
    return {
      ok: false,
      reason: `${fix.file} already exists — this fix expected to create it. Review it by hand.`,
    };
  } catch {
    /* good: it does not exist yet */
  }

  const edit = new vscode.WorkspaceEdit();
  edit.createFile(uri, { overwrite: false, ignoreIfExists: false });
  edit.insert(uri, new vscode.Position(0, 0), fix.replacement);
  if (!(await vscode.workspace.applyEdit(edit))) {
    return { ok: false, reason: `VS Code refused to create ${fix.file}.` };
  }
  await reveal(uri, 1);
  log.info(`Created ${fix.file} from fix "${fix.title}".`);
  return { ok: true, file: fix.file, line: 1 };
}

/**
 * Shows the patch as a diff without touching the file, so a developer can read
 * what would change before deciding. The proposed side is a virtual document —
 * nothing is written until Apply.
 */
export async function previewFix(root: vscode.Uri, fix: CodeFix): Promise<string | undefined> {
  const uri = resolveFile(root, fix.file);
  if (!uri) return `${fix.file} is outside the workspace.`;

  let original = "";
  if (fix.kind !== "create") {
    try {
      original = (await vscode.workspace.openTextDocument(uri)).getText();
    } catch {
      return `${fix.file} no longer exists.`;
    }
  }

  const patched = patchedText(original, fix);
  if (patched === undefined) {
    return `The code this fix targets is no longer in ${fix.file}. Re-run the review.`;
  }

  const proposed = await vscode.workspace.openTextDocument({
    content: patched,
    language: (await languageIdFor(uri)) ?? undefined,
  });
  await vscode.commands.executeCommand(
    "vscode.diff",
    fix.kind === "create" ? emptyUri(uri) : uri,
    proposed.uri,
    `${fix.file} ↔ proposed: ${fix.title}`,
    { preview: true },
  );
  return undefined;
}

/** The file's contents with the fix applied, or undefined if it no longer fits. */
function patchedText(original: string, fix: CodeFix): string | undefined {
  if (fix.kind === "create") return fix.replacement;

  const located = locateAnchor(original, fix.anchor);
  if (located.kind !== "found") return undefined;

  const lines = original.split(/\r?\n/);
  const before = lines.slice(0, located.startLine - 1);
  const after = lines.slice(located.endLine);
  const middle =
    fix.kind === "insert-after"
      ? [...lines.slice(located.startLine - 1, located.endLine), ...fix.replacement.split("\n")]
      : fix.replacement.split("\n");
  return [...before, ...middle, ...after].join("\n");
}

/** An in-memory empty document, so a created file diffs against nothing. */
function emptyUri(uri: vscode.Uri): vscode.Uri {
  return uri.with({ scheme: "untitled", path: `${uri.path}.new` });
}

async function languageIdFor(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return (await vscode.workspace.openTextDocument(uri)).languageId;
  } catch {
    return undefined;
  }
}

async function reveal(uri: vscode.Uri, line: number): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document, {
    viewColumn: vscode.ViewColumn.Beside,
    preserveFocus: false,
  });
  const target = new vscode.Position(Math.max(0, line - 1), 0);
  editor.selection = new vscode.Selection(target, target);
  editor.revealRange(new vscode.Range(target, target), vscode.TextEditorRevealType.InCenter);
}

/**
 * The shared workspace guard, plus one refusal it does not make on its own: a
 * patch has to name a file, and the guard maps an empty path to the root
 * directory because `list_dir` needs that. Applying a patch to a directory is
 * not a thing, so it stops here rather than failing further in.
 */
function resolveFile(root: vscode.Uri, relPath: string): vscode.Uri | undefined {
  const uri = resolveInside(root, relPath);
  return uri && uri.path !== root.path ? uri : undefined;
}
