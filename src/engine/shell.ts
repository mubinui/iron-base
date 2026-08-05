/**
 * Running the project's own commands.
 *
 * This is what separates writing code from finishing it: a builder that cannot
 * run `npm test` is guessing about whether its own edit works. The output comes
 * back to the model, so it can read a stack trace and fix what it broke.
 *
 * Three things matter here and each of them has bitten this kind of tool before.
 * A command must not be able to hang the run forever, so there is a deadline. It
 * must not be able to flood the transcript with a hundred thousand lines of
 * webpack output, so the capture is capped from both ends — the start says what
 * ran, the end says how it failed, and the middle of a huge log is never the
 * interesting part. And cancelling has to kill the whole process tree, because
 * `npm test` is a shell that spawns node that spawns a watcher, and killing only
 * the shell leaves the rest running after the panel says it stopped.
 */

import { spawn } from "node:child_process";
import * as vscode from "vscode";
import { log } from "../util/log";

/** Characters of output kept. Beyond this the middle is dropped, not the end. */
const MAX_OUTPUT_CHARS = 24_000;
const HEAD_SHARE = 0.3;

export interface CommandResult {
  /** Combined stdout and stderr, interleaved as the process wrote them. */
  output: string;
  exitCode: number | null;
  /** Set when the deadline or a cancellation ended it rather than the process. */
  endedBy?: "timeout" | "cancelled";
  durationMs: number;
  truncated: boolean;
}

export interface RunCommandOptions {
  command: string;
  cwd: vscode.Uri;
  timeoutMs: number;
  token: vscode.CancellationToken;
  /** Called as output arrives, so the panel can show a long build progressing. */
  onOutput?: (chunk: string) => void;
}

export async function runCommand(options: RunCommandOptions): Promise<CommandResult> {
  const { command, cwd, timeoutMs, token, onOutput } = options;
  const startedAt = Date.now();

  return await new Promise<CommandResult>((resolve) => {
    const child = spawn(command, {
      cwd: cwd.fsPath,
      shell: true,
      // Its own process group, so cancelling can take the children with it.
      // Windows has no process groups; `taskkill /T` covers that case below.
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        // Test runners and package managers draw progress bars and colour codes
        // when they think a human is watching. The model is not a terminal, and
        // escape sequences make its job harder for no benefit.
        CI: "1",
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        TERM: "dumb",
      },
    });

    let output = "";
    let truncated = false;
    let settled = false;
    /**
     * Why we asked it to stop, remembered separately from how it stopped.
     *
     * A process killed on a timeout usually exits before the fallback timer
     * fires, so `close` reports an ordinary exit code — and "exit 143" is not
     * what the developer needs to read when the truth is that it ran too long.
     */
    let stopping: CommandResult["endedBy"] | undefined;

    const collect = (chunk: Buffer | string): void => {
      const text = chunk.toString();
      onOutput?.(text);
      if (output.length < MAX_OUTPUT_CHARS * 2) output += text;
      else truncated = true;
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    const finish = (exitCode: number | null, endedBy?: CommandResult["endedBy"]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      cancellation.dispose();
      const capped = capOutput(output);
      resolve({
        output: capped.text,
        exitCode,
        endedBy: endedBy ?? stopping,
        durationMs: Date.now() - startedAt,
        truncated: truncated || capped.truncated,
      });
    };

    const stop = (endedBy: "timeout" | "cancelled"): void => {
      stopping = endedBy;
      killTree(child.pid);
      // The process may ignore the signal; do not wait on it forever.
      setTimeout(() => finish(null, endedBy), 2000);
    };

    const deadline = setTimeout(() => stop("timeout"), timeoutMs);
    const cancellation = token.onCancellationRequested(() => stop("cancelled"));

    child.on("error", (err) => {
      output += `\n${String(err)}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

/**
 * Kills the process and everything it started.
 *
 * On POSIX the negative pid addresses the group the `detached` spawn created.
 * On Windows there are no groups, so `taskkill` walks the tree instead.
 */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"]);
    } else {
      process.kill(-pid, "SIGTERM");
    }
  } catch (err) {
    log.warn(`Could not stop the command's process tree: ${String(err)}`);
  }
}

/**
 * Trims the middle out of long output.
 *
 * A failing test run puts the command echo at the top and the failure at the
 * bottom; it is the thousand lines of passing tests in between that can go.
 */
function capOutput(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) return { text, truncated: false };
  const head = Math.floor(MAX_OUTPUT_CHARS * HEAD_SHARE);
  const tail = MAX_OUTPUT_CHARS - head;
  const dropped = text.length - MAX_OUTPUT_CHARS;
  return {
    text: `${text.slice(0, head)}\n\n… [${dropped.toLocaleString()} characters of output dropped from the middle] …\n\n${text.slice(-tail)}`,
    truncated: true,
  };
}

/** How the result reads in the transcript and on the command card. */
export function describeResult(result: CommandResult): string {
  if (result.endedBy === "timeout") {
    return `timed out after ${Math.round(result.durationMs / 1000)}s`;
  }
  if (result.endedBy === "cancelled") return "cancelled";
  if (result.exitCode === 0) return `exit 0 in ${formatDuration(result.durationMs)}`;
  return `exit ${result.exitCode ?? "?"} in ${formatDuration(result.durationMs)}`;
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
