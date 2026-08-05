import { formatBytes } from "../util/limits";
import type { ScanResult } from "../scanner/workspaceScanner";
import { countSignals } from "./retrieval";
import { classifyPriorFindings, type WorkspaceIndex } from "./store";
import { RISK_SIGNALS, SIGNAL_LABELS, type SignalKind } from "./symbols";

const MAX_HOT_FILES = 12;
const MAX_ROUTES = 20;
const MAX_TREE_LINES = 24;

/**
 * The architectural brief the model starts from.
 *
 * This deliberately replaces the old "here is the whole file tree" prompt. It is
 * built from the local index, so it costs no tokens to produce and stays roughly
 * constant in size as the repository grows — a 50-file project and a 5,000-file
 * project both yield a brief of a couple of thousand tokens. The model then pulls
 * in detail on demand through the retrieval tools.
 */
export function buildDigest(index: WorkspaceIndex, scan: ScanResult): string {
  const records = Object.values(index.files);
  const lines: string[] = [];
  const totalLoc = records.reduce((sum, r) => sum + r.loc, 0);
  const totalBytes = scan.files.reduce((sum, f) => sum + f.size, 0);

  lines.push(`# ${scan.rootName} — architectural brief`);
  lines.push(
    `${records.length} source files, about ${totalLoc.toLocaleString()} lines, ${formatBytes(totalBytes)}.` +
      (scan.truncated ? " The file cap was reached, so this is a partial view." : ""),
  );

  const languages = tally(records.map((r) => r.language));
  lines.push("");
  lines.push("## Stack");
  lines.push(
    `Languages: ${topEntries(languages, 6)
      .map(([lang, n]) => `${lang} (${n})`)
      .join(", ")}`,
  );
  lines.push(
    `Frameworks and libraries detected: ${
      scan.frameworks.length > 0 ? scan.frameworks.join(", ") : "none recognised"
    }`,
  );
  if (scan.entryPoints.length > 0) {
    lines.push(`Entry points: ${scan.entryPoints.join(", ")}`);
  }
  lines.push(
    `Infrastructure files: ${
      scan.infraFiles.length > 0
        ? scan.infraFiles.slice(0, 12).join(", ")
        : "none — no Dockerfile, compose file, Kubernetes manifest, or CI workflow"
    }`,
  );

  // Signal counts are the highest-value part of the brief: they tell the model
  // where the architectural risk already looks concentrated, before it reads
  // anything at all.
  const counts = countSignals(index);
  const risks = RISK_SIGNALS.filter((k) => counts.has(k));
  if (risks.length > 0) {
    lines.push("");
    lines.push("## Pre-scanned risk signals");
    lines.push(
      "Found by a local scan of the code, with file counts. These are leads to verify, not confirmed findings — read the code before reporting any of them.",
    );
    for (const kind of risks) {
      lines.push(`- ${SIGNAL_LABELS[kind]}: ${counts.get(kind)} file(s)`);
    }
  }

  const maturity: SignalKind[] = [
    "cache-usage",
    "queue-usage",
    "error-handling",
    "logging",
    "auth-check",
    "env-config",
    "test",
  ];
  const presentMaturity = maturity.filter((k) => counts.has(k));
  const absentMaturity = maturity.filter((k) => !counts.has(k));
  lines.push("");
  lines.push("## Operational surface");
  lines.push(
    `Present: ${
      presentMaturity.length > 0
        ? presentMaturity.map((k) => `${SIGNAL_LABELS[k]} (${counts.get(k)})`).join(", ")
        : "nothing detected"
    }`,
  );
  if (absentMaturity.length > 0) {
    lines.push(
      `Not detected anywhere: ${absentMaturity.map((k) => SIGNAL_LABELS[k]).join(", ")}`,
    );
  }

  const routes = records
    .flatMap((r) => r.symbols.filter((s) => s.kind === "route").map((s) => ({ file: r.path, path: s.name, line: s.line })))
    .slice(0, MAX_ROUTES);
  if (routes.length > 0) {
    lines.push("");
    lines.push("## Request surface");
    for (const route of routes) {
      lines.push(`- ${route.path} — ${route.file}:${route.line}`);
    }
  }

  // "Hot" files: where risk signals and size concentrate. This is where an
  // architecture review almost always needs to start.
  const hot = records
    .map((record) => ({
      record,
      risk: record.signals.filter((s) => RISK_SIGNALS.includes(s.kind)).length,
    }))
    .filter((r) => r.risk > 0 || r.record.loc > 250)
    .sort((a, b) => b.risk * 100 + b.record.loc - (a.risk * 100 + a.record.loc))
    .slice(0, MAX_HOT_FILES);

  if (hot.length > 0) {
    lines.push("");
    lines.push("## Files worth looking at first");
    for (const { record, risk } of hot) {
      const kinds = [...new Set(record.signals.filter((s) => RISK_SIGNALS.includes(s.kind)).map((s) => s.kind))];
      const detail = kinds.length > 0 ? ` — ${kinds.map((k) => SIGNAL_LABELS[k]).join(", ")}` : "";
      lines.push(`- ${record.path} (${record.loc} lines, ${risk} risk signal(s))${detail}`);
    }
  }

  lines.push("");
  lines.push("## Layout");
  lines.push(...directorySummary(records));

  if (scan.manifests.length > 0) {
    lines.push("");
    lines.push("## Dependencies");
    for (const manifest of scan.manifests.slice(0, 4)) {
      const deps = manifest.dependencies.slice(0, 30);
      const extra = manifest.dependencies.length - deps.length;
      lines.push(
        `${manifest.file}: ${deps.join(", ") || "none"}${extra > 0 ? ` (+${extra} more)` : ""}`,
      );
    }
  }

  const prior = priorSection(index);
  if (prior.length > 0) {
    lines.push("");
    lines.push(...prior);
  }

  return lines.join("\n");
}

/** Tells the model what a previous review found and what has moved since. */
function priorSection(index: WorkspaceIndex): string[] {
  if (index.priorFindings.length === 0) return [];
  const { unchanged, touched } = classifyPriorFindings(index);
  const lines: string[] = ["## What the last review found"];
  if (index.lastGrade) {
    lines.push(`Previous grade: ${index.lastGrade}.`);
  }
  if (unchanged.length > 0) {
    lines.push(
      "Still present — the files these point at have not changed since, so treat them as open unless you see otherwise:",
    );
    for (const prior of unchanged.slice(0, 20)) {
      lines.push(`- [${prior.severity}] ${prior.title} (${prior.files.join(", ")})`);
    }
  }
  if (touched.length > 0) {
    lines.push(
      "Possibly fixed — the code behind these has changed since the last review, so re-check them first:",
    );
    for (const prior of touched.slice(0, 20)) {
      lines.push(`- [${prior.severity}] ${prior.title} (${prior.files.join(", ")})`);
    }
  }
  lines.push(
    "Re-report the ones that are genuinely still there. Do not re-report anything that has been fixed.",
  );
  return lines;
}

function directorySummary(records: Array<{ path: string; loc: number }>): string[] {
  const byDir = new Map<string, { files: number; loc: number }>();
  for (const record of records) {
    const dir = record.path.includes("/")
      ? record.path.slice(0, record.path.lastIndexOf("/"))
      : ".";
    const entry = byDir.get(dir) ?? { files: 0, loc: 0 };
    entry.files++;
    entry.loc += record.loc;
    byDir.set(dir, entry);
  }
  const sorted = [...byDir.entries()].sort((a, b) => b[1].loc - a[1].loc);
  const shown = sorted.slice(0, MAX_TREE_LINES);
  const lines = shown.map(
    ([dir, { files, loc }]) =>
      `${dir}/ — ${files} ${files === 1 ? "file" : "files"}, ${loc.toLocaleString()} lines`,
  );
  if (sorted.length > shown.length) {
    lines.push(`… and ${sorted.length - shown.length} more directories`);
  }
  return lines;
}

function tally(values: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const value of values) map.set(value, (map.get(value) ?? 0) + 1);
  return map;
}

function topEntries(map: Map<string, number>, limit: number): Array<[string, number]> {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}
