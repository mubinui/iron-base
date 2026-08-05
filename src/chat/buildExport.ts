/**
 * A build, written down.
 *
 * What a developer needs after the fact is not a replay of the panel — it is
 * something they can paste into a pull request or a review: what was asked,
 * what changed, what was run, and what it said. So the diffs come out as fenced
 * `diff` blocks that render everywhere, the tool trace is collapsed to a count
 * because nobody reads "read src/app.js" forty times, and command output is
 * kept because that is the evidence the change works.
 */

import * as vscode from "vscode";
import { formatUnified } from "../engine/diff";
import { renderPlanMarkdown } from "../engine/plan";
import type { ThreadItem } from "../protocol";
import type { SessionUsage } from "./sessionStore";

export interface BuildExportInput {
  title: string;
  workspaceName: string;
  thread: ThreadItem[];
  usage?: SessionUsage;
  model?: string;
  provider?: string;
  startedAt?: string;
}

export function renderBuildMarkdown(input: BuildExportInput): string {
  const out: string[] = [`# ${input.title}`, ""];

  const meta: string[] = [input.workspaceName];
  if (input.provider) meta.push(input.provider);
  if (input.model) meta.push(`\`${input.model}\``);
  if (input.startedAt) meta.push(new Date(input.startedAt).toLocaleString());
  out.push(meta.join(" · "), "");

  const changes = input.thread.filter(
    (item): item is Extract<ThreadItem, { kind: "change" }> => item.kind === "change",
  );
  const live = changes.filter((change) => !change.reverted);
  if (live.length > 0) {
    out.push("## Files changed", "");
    for (const change of live) {
      const counts = [
        change.added > 0 ? `+${change.added}` : "",
        change.removed > 0 ? `−${change.removed}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      out.push(`- \`${change.file}\` — ${verbOf(change.change)}${counts ? ` (${counts})` : ""}`);
    }
    out.push("");
  }

  out.push("## What happened", "");

  // Consecutive tool calls become one line. Twenty of them in a row is a fact
  // about how the agent works, not twenty facts worth reading.
  let pendingReads = 0;
  const flushReads = (): void => {
    if (pendingReads === 0) return;
    out.push(`*…${pendingReads} file${pendingReads === 1 ? "" : "s"} read and searched*`, "");
    pendingReads = 0;
  };

  for (const item of input.thread) {
    if (item.kind === "tool") {
      pendingReads++;
      continue;
    }
    flushReads();

    switch (item.kind) {
      case "user":
        out.push(`### ▸ ${firstLine(item.text)}`, "");
        if (item.text.includes("\n")) out.push(quote(item.text), "");
        break;

      case "assistant":
        if (item.text.trim().length > 0) out.push(item.text.trim(), "");
        break;

      case "change": {
        const header = `**${verbOf(item.change)} \`${item.file}\`**${
          item.reverted ? " *(reverted)*" : ""
        }`;
        out.push(header, "");
        if (item.why) out.push(item.why, "");
        const unified = formatUnified({
          hunks: item.hunks,
          added: item.added,
          removed: item.removed,
          coarse: false,
        });
        if (unified.trim().length > 0) {
          out.push("```diff", unified, "```", "");
        }
        break;
      }

      case "command": {
        out.push("```console", `$ ${item.command}`, truncateOutput(item.output), "```", "");
        if (item.status) out.push(`*${item.status}*`, "");
        break;
      }

      case "plan":
        out.push(renderPlanMarkdown(item.plan), "");
        break;

      case "finished":
        out.push("## Result", "", item.summary.trim(), "");
        if (item.followUps.length > 0) {
          out.push("### Left for later", "", ...item.followUps.map((f) => `- ${f}`), "");
        }
        break;

      case "notice":
        out.push(`> ${item.level === "error" ? "❌" : "⚠️"} ${item.text}`, "");
        break;
    }
  }
  flushReads();

  if (input.usage) {
    const total = input.usage.inputTokens + input.usage.outputTokens;
    const cost = input.usage.costUsd ? ` · about $${input.usage.costUsd.toFixed(3)}` : "";
    out.push("---", "", `*${total.toLocaleString()} tokens${cost}*`, "");
  }
  return out.join("\n");
}

/** Writes the export where the developer asks, and opens it. */
export async function exportBuild(input: BuildExportInput): Promise<void> {
  const safe = input.title.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  const target = await vscode.window.showSaveDialog({
    title: "Export build",
    filters: { Markdown: ["md"] },
    defaultUri: vscode.Uri.file(`${safe || "build"}.md`),
  });
  if (!target) return;

  await vscode.workspace.fs.writeFile(
    target,
    Buffer.from(renderBuildMarkdown(input), "utf8"),
  );
  const document = await vscode.workspace.openTextDocument(target);
  await vscode.window.showTextDocument(document, { preview: false });
}

function verbOf(kind: "edit" | "create" | "delete"): string {
  return kind === "create" ? "Created" : kind === "delete" ? "Deleted" : "Edited";
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0].trim();
}

function quote(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/** Command output is evidence, but a 4,000-line build log is not. */
function truncateOutput(output: string): string {
  const lines = output.trimEnd().split("\n");
  if (lines.length <= 40) return lines.join("\n");
  return [
    ...lines.slice(0, 12),
    `… ${lines.length - 32} lines omitted …`,
    ...lines.slice(-20),
  ].join("\n");
}
