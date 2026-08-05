import type { ModuleGraph } from "../memory/graph";

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

export type Category =
  | "layering"
  | "coupling"
  | "separation-of-concerns"
  | "scalability"
  | "data-access"
  | "config-secrets"
  | "error-handling"
  | "performance"
  | "observability"
  | "other";

export const CATEGORIES: Category[] = [
  "layering",
  "coupling",
  "separation-of-concerns",
  "scalability",
  "data-access",
  "config-secrets",
  "error-handling",
  "performance",
  "observability",
  "other",
];

export const CATEGORY_LABELS: Record<Category, string> = {
  layering: "Layering",
  coupling: "Coupling",
  "separation-of-concerns": "Separation of concerns",
  scalability: "Scalability",
  "data-access": "Data access",
  "config-secrets": "Configuration & secrets",
  "error-handling": "Error handling",
  performance: "Performance",
  observability: "Observability",
  other: "Other",
};

export interface Evidence {
  file: string;
  startLine?: number;
  endLine?: number;
  snippetHint?: string;
}

export interface Finding {
  id: string;
  severity: Severity;
  category: Category;
  title: string;
  explanation: string;
  recommendation: string;
  evidence: Evidence[];
  effort?: "small" | "medium" | "large";
}

/**
 * A concrete, applicable code change.
 *
 * The distinction from `Finding.recommendation` is the point: prose describing a
 * fix cannot be wrong in a way anyone notices, but a patch either applies to the
 * file on disk or it does not. `anchor` is text copied verbatim out of the file,
 * so proposing a fix forces the model to have actually read the code it is
 * rewriting, and `verified` records that we checked.
 */
export interface CodeFix {
  id: string;
  /** The finding this fixes, when it came from one. */
  findingId?: string;
  title: string;
  file: string;
  kind: "replace" | "insert-after" | "create";
  /** Exact existing text this patch targets. Empty when kind is "create". */
  anchor: string;
  /** What takes its place, or follows it, or fills the new file. */
  replacement: string;
  /** Why this change is the right one — shown above the diff. */
  rationale: string;
  language?: string;
  /** Where the anchor was found when the fix was proposed (1-based). */
  startLine?: number;
  endLine?: number;
  /** True when the anchor matched the file exactly once at proposal time. */
  verified: boolean;
}

/** One piece of code that belongs somewhere other than where it is. */
export interface BlueprintMove {
  what: string;
  from: string;
  to: string;
  why: string;
}

/** A concern the project handles in a dated way, and what to use instead. */
export interface StackUpgrade {
  concern: string;
  current: string;
  recommended: string;
  why: string;
}

/**
 * What good would look like for *this* project — the shape to move toward, not
 * a generic best-practice list. Findings say what is wrong; the blueprint says
 * where it should end up.
 */
export interface Blueprint {
  summary: string;
  moves: BlueprintMove[];
  stack: StackUpgrade[];
}

export interface Bottleneck {
  rank: number;
  component: string;
  why: string;
  findingIds?: string[];
}

export interface RoadmapPhase {
  phase: string;
  actions: string[];
  expectedCapacity: string;
}

export interface ScalabilityAnalysis {
  target: string;
  estimatedCurrentCapacity: string;
  assumptions: string[];
  bottlenecks: Bottleneck[];
  roadmap: RoadmapPhase[];
}

export type Grade = "A" | "B" | "C" | "D" | "F";

export interface AnalysisReport {
  grade: Grade;
  summary: string;
  findings: Finding[];
  /** Applicable patches, each verified against the file when proposed. */
  fixes: CodeFix[];
  /** The target shape for this codebase, when the model produced one. */
  blueprint?: Blueprint;
  /** Module dependency graph, built locally from the index. */
  graph?: ModuleGraph;
  scalability?: ScalabilityAnalysis;
  /** Set when the run stopped early (cancelled, budget exhausted, cap hit). */
  incompleteReason?: string;
  workspaceName: string;
  provider: string;
  model: string;
  generatedAt: string;
}

/** Fixes belonging to one finding, in the order they were proposed. */
export function fixesFor(report: AnalysisReport, findingId: string): CodeFix[] {
  return report.fixes.filter((fix) => fix.findingId === findingId);
}

export function severityRank(severity: Severity): number {
  return SEVERITY_ORDER.indexOf(severity);
}

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
}

export function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  for (const f of findings) counts[f.severity]++;
  return counts;
}

function isSeverity(value: unknown): value is Severity {
  return typeof value === "string" && SEVERITY_ORDER.includes(value as Severity);
}

function isCategory(value: unknown): value is Category {
  return typeof value === "string" && CATEGORIES.includes(value as Category);
}

export interface ParsedFinding {
  ok: true;
  finding: Omit<Finding, "id">;
}

export interface ParseError {
  ok: false;
  error: string;
}

/** Shape-checks a model-supplied finding. File refs are validated separately. */
export function parseFindingInput(input: unknown): ParsedFinding | ParseError {
  if (typeof input !== "object" || input === null) {
    return { ok: false, error: "Expected an object." };
  }
  const raw = input as Record<string, unknown>;

  if (typeof raw.title !== "string" || raw.title.trim().length === 0) {
    return { ok: false, error: "`title` must be a non-empty string." };
  }
  if (typeof raw.explanation !== "string" || raw.explanation.trim().length === 0) {
    return { ok: false, error: "`explanation` must be a non-empty string." };
  }
  if (typeof raw.recommendation !== "string" || raw.recommendation.trim().length === 0) {
    return { ok: false, error: "`recommendation` must be a non-empty string." };
  }
  if (!isSeverity(raw.severity)) {
    return {
      ok: false,
      error: `\`severity\` must be one of: ${SEVERITY_ORDER.join(", ")}.`,
    };
  }
  if (!isCategory(raw.category)) {
    return { ok: false, error: `\`category\` must be one of: ${CATEGORIES.join(", ")}.` };
  }
  if (!Array.isArray(raw.evidence) || raw.evidence.length === 0) {
    return {
      ok: false,
      error: "`evidence` must be a non-empty array — every finding needs a file reference.",
    };
  }

  const evidence: Evidence[] = [];
  for (const item of raw.evidence) {
    if (typeof item !== "object" || item === null) {
      return { ok: false, error: "Each evidence entry must be an object." };
    }
    const e = item as Record<string, unknown>;
    if (typeof e.file !== "string" || e.file.trim().length === 0) {
      return { ok: false, error: "Each evidence entry needs a `file` path." };
    }
    evidence.push({
      file: e.file.trim(),
      startLine: typeof e.startLine === "number" ? e.startLine : undefined,
      endLine: typeof e.endLine === "number" ? e.endLine : undefined,
      snippetHint: typeof e.snippetHint === "string" ? e.snippetHint : undefined,
    });
  }

  const effort =
    raw.effort === "small" || raw.effort === "medium" || raw.effort === "large"
      ? raw.effort
      : undefined;

  return {
    ok: true,
    finding: {
      severity: raw.severity,
      category: raw.category,
      title: raw.title.trim(),
      explanation: raw.explanation.trim(),
      recommendation: raw.recommendation.trim(),
      evidence,
      effort,
    },
  };
}
