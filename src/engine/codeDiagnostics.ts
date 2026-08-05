/**
 * Telling the agent what the editor already knows.
 *
 * VS Code has a type-checker, a linter and a language server running over this
 * project the whole time. When the agent writes a call with the wrong argument
 * count, a red squiggle appears under it within a second — and until now the
 * agent was the only participant who could not see it. It would find out at the
 * end, from `npm test`, if it remembered to run one.
 *
 * So after each write, the diagnostics for that file are read back and returned
 * with the tool result. It costs nothing — no model call, no subprocess — and it
 * closes the loop at the point where the mistake is cheapest to fix: the turn
 * that made it.
 *
 * Language servers are asynchronous, which is the whole difficulty here. A read
 * taken the instant the file is written mostly returns the *previous* state, so
 * this waits for the diagnostics to settle, with a short ceiling — a stale
 * answer would be worse than none, but blocking a build on a slow server would
 * be worse still.
 */

import * as vscode from "vscode";

/** How long to wait for a language server to catch up with a write. */
const SETTLE_TIMEOUT_MS = 2500;
/** Quiet period after the last change that counts as "settled". */
const QUIET_MS = 350;
/** Problems reported back per file. Beyond this it is noise. */
const MAX_REPORTED = 12;

export interface FileProblems {
  errors: number;
  warnings: number;
  /** Formatted `line: message` lines, most severe first. */
  lines: string[];
}

/**
 * Reads the problems for one file once its language server has settled.
 *
 * Returns nothing when the file is clean, so the caller can append this to a
 * tool result without adding a line that says "no problems" after every edit.
 */
export async function problemsFor(uri: vscode.Uri): Promise<FileProblems | undefined> {
  await settle(uri);

  const all = vscode.languages.getDiagnostics(uri);
  const relevant = all.filter(
    (d) =>
      d.severity === vscode.DiagnosticSeverity.Error ||
      d.severity === vscode.DiagnosticSeverity.Warning,
  );
  if (relevant.length === 0) return undefined;

  const errors = relevant.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length;
  const sorted = [...relevant].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity - b.severity;
    return a.range.start.line - b.range.start.line;
  });

  const lines = sorted.slice(0, MAX_REPORTED).map((d) => {
    const label = d.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning";
    const source = d.source ? ` [${d.source}]` : "";
    return `  line ${d.range.start.line + 1}: ${label}${source}: ${d.message.split("\n")[0]}`;
  });
  if (sorted.length > lines.length) {
    lines.push(`  … and ${sorted.length - lines.length} more`);
  }

  return { errors, warnings: relevant.length - errors, lines };
}

/**
 * The sentence appended to a write's tool result.
 *
 * Deliberately not phrased as an order. Some of these will be pre-existing
 * problems in a file the agent only touched the top of, and a rule that says
 * "fix every warning you see" turns a two-line change into a sprawl.
 */
export function describeProblems(file: string, problems: FileProblems): string {
  const counts = [
    problems.errors > 0 ? `${problems.errors} error${problems.errors === 1 ? "" : "s"}` : "",
    problems.warnings > 0
      ? `${problems.warnings} warning${problems.warnings === 1 ? "" : "s"}`
      : "",
  ]
    .filter(Boolean)
    .join(" and ");

  return (
    `\n\nThe editor reports ${counts} in ${file}:\n${problems.lines.join("\n")}\n` +
    (problems.errors > 0
      ? "Fix anything here that your change caused. Problems that were already there are not part of this task — leave them, and mention them at the end if they matter."
      : "Check whether your change caused any of these.")
  );
}

/**
 * Waits until this file's diagnostics stop changing, or the ceiling is reached.
 *
 * The event fires per-collection, so a file with a type-checker and a linter
 * both reporting produces several. Restarting the quiet timer on each one is
 * what stops this from reading half of the answer.
 */
async function settle(uri: vscode.Uri): Promise<void> {
  const target = uri.toString();
  await new Promise<void>((resolve) => {
    let quiet: ReturnType<typeof setTimeout>;

    const done = (): void => {
      clearTimeout(quiet);
      clearTimeout(ceiling);
      subscription.dispose();
      resolve();
    };

    const restart = (): void => {
      clearTimeout(quiet);
      quiet = setTimeout(done, QUIET_MS);
    };

    const ceiling = setTimeout(done, SETTLE_TIMEOUT_MS);
    const subscription = vscode.languages.onDidChangeDiagnostics((event) => {
      if (event.uris.some((changed) => changed.toString() === target)) restart();
    });
    restart();
  });
}
