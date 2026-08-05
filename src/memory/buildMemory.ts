/**
 * What earlier builds did, so a later one does not start from nothing.
 *
 * The review already remembers its findings across runs. Builds did not
 * remember anything, which showed up as the same conversation twice: a session
 * that had just moved sessions into Redis, followed a week later by a session
 * proposing to move sessions into Redis.
 *
 * Kept small on purpose — a title, the files, the date, one line of outcome.
 * The code itself is the record of what changed; this is only the pointer that
 * tells the agent where to look and what not to redo.
 */

import type { WorkspaceIndex } from "./store";

/** Builds remembered per workspace. Older ones fall off the end. */
const MAX_REMEMBERED = 12;
/** Files listed per build, before it stops being a summary. */
const MAX_FILES_PER_BUILD = 12;

export interface PriorBuild {
  title: string;
  /** What the builder said it did, trimmed to a sentence or two. */
  outcome: string;
  files: string[];
  at: string;
}

/** `priorBuilds` is optional on the index so older stored copies still load. */
export interface IndexWithBuilds extends WorkspaceIndex {
  priorBuilds?: PriorBuild[];
}

export function rememberBuild(
  index: WorkspaceIndex,
  build: { title: string; outcome: string; files: string[] },
): void {
  const withBuilds = index as IndexWithBuilds;
  const entry: PriorBuild = {
    title: build.title.slice(0, 120),
    outcome: firstSentences(build.outcome, 2).slice(0, 400),
    files: [...new Set(build.files)].slice(0, MAX_FILES_PER_BUILD),
    at: new Date().toISOString(),
  };
  withBuilds.priorBuilds = [entry, ...(withBuilds.priorBuilds ?? [])].slice(0, MAX_REMEMBERED);
}

/**
 * The section that goes into the brief.
 *
 * Phrased as history rather than as instruction. "This was done" is a fact the
 * model can weigh; "do not do this again" is a rule that goes wrong the moment
 * the developer genuinely wants it revisited.
 */
export function priorBuildsSection(index: WorkspaceIndex): string {
  const builds = (index as IndexWithBuilds).priorBuilds ?? [];
  if (builds.length === 0) return "";

  const lines = [
    "## Earlier IronBase builds in this project",
    "",
    "Work already done here. Read the current code before assuming any of it is still exactly as described — the developer may have changed it since, or reverted it.",
    "",
  ];
  for (const build of builds.slice(0, 6)) {
    lines.push(`- **${build.title}** (${build.at.slice(0, 10)}) — ${build.outcome}`);
    if (build.files.length > 0) {
      lines.push(`  Touched: ${build.files.map((f) => `\`${f}\``).join(", ")}`);
    }
  }
  return lines.join("\n");
}

function firstSentences(text: string, count: number): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  const parts = trimmed.split(/(?<=[.!?])\s+/);
  return parts.slice(0, count).join(" ");
}
