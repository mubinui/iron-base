import * as vscode from "vscode";
import type { IronBaseConfig } from "../config";
import {
  LlmCancelledError,
  type LlmClient,
  type NeutralMessage,
  type ProviderId,
  type ToolResult,
} from "../llm/types";
import { PROVIDER_LABELS } from "../llm/types";
import { log } from "../util/log";
import type { ScanResult } from "../scanner/workspaceScanner";
import { buildDigest } from "../memory/digest";
import { buildModuleGraph } from "../memory/graph";
import type { WorkspaceIndex } from "../memory/store";
import { sortFindings, type AnalysisReport, type CodeFix, type Finding } from "./findings";
import {
  BUDGET_WARNING,
  FORCE_REPORT,
  buildKickoffMessage,
  buildSystemPrompt,
  type RunMode,
} from "./prompts";
import {
  ToolRunner,
  TOOL_NAMES,
  toolDefinitions,
  type ReportSubmission,
  type ToolOutcome,
} from "./tools";
import { MAX_PARALLEL_TOOLS, TurnRunner, mapWithConcurrency } from "./turnRunner";

const MAX_TOKENS_PER_TURN = 16000;

/** Told to backends without native tool calling: what ends this run. */
const REVIEW_TASK = { finishTool: TOOL_NAMES.emitReport, noun: "review" };

/**
 * Tools that only read the workspace, so they are safe to run side by side.
 *
 * The emitting tools are absent on purpose — they mutate the run's ledger and
 * depend on each other's effects within a turn.
 */
const READ_ONLY_TOOLS = new Set<string>([
  TOOL_NAMES.findRelevant,
  TOOL_NAMES.listSignals,
  TOOL_NAMES.listDir,
  TOOL_NAMES.readFile,
  TOOL_NAMES.search,
]);

export type ProgressEvent =
  | { type: "status"; text: string }
  | { type: "text"; delta: string }
  | { type: "tool"; name: string }
  | { type: "finding"; finding: Finding }
  | { type: "fix"; fix: CodeFix }
  | { type: "iteration"; current: number; max: number }
  | { type: "usage"; inputTokens: number; outputTokens: number; budget: number }
  | { type: "warning"; text: string };

export interface RunOptions {
  /**
   * Resolved before every request rather than fixed at the start, so switching
   * provider or model in the sidebar takes effect on the next step of the review
   * that is already running instead of requiring a fresh one.
   */
  getClient: () => Promise<LlmClient | undefined>;
  /** Another connected account to continue on when this one is rate limited. */
  getFallback?: (exclude: ProviderId) => Promise<LlmClient | undefined>;
  scan: ScanResult;
  index: WorkspaceIndex;
  mode: RunMode;
  config: IronBaseConfig;
  token: vscode.CancellationToken;
  onProgress: (event: ProgressEvent) => void;
}

export async function runAnalysis(options: RunOptions): Promise<AnalysisReport> {
  const { scan, index, mode, config, token, onProgress } = options;

  const turns = await TurnRunner.create({
    getClient: options.getClient,
    getFallback: options.getFallback,
    autoFailover: config.autoFailover,
    token,
    onEvent: (event) => {
      if (event.type === "usage") {
        onProgress({
          type: "usage",
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          budget: config.maxSessionTokens,
        });
      } else {
        onProgress(event);
      }
    },
  });

  const digest = buildDigest(index, scan);
  const system = buildSystemPrompt(mode, digest);
  log.info(`Architectural brief: ~${Math.ceil(digest.length / 4)} tokens.`);
  const tools = toolDefinitions();
  const runner = new ToolRunner({
    root: scan.root,
    maxFileReadBytes: config.maxFileReadBytes,
    token,
    index,
  });

  const messages: NeutralMessage[] = [
    { role: "user", text: buildKickoffMessage(mode, config.maxIterations) },
  ];
  const findings: Finding[] = [];
  const fixes: CodeFix[] = [];
  let report: ReportSubmission | undefined;
  let iteration = 0;
  let warnedAboutBudget = false;
  let incompleteReason: string | undefined;

  while (iteration < config.maxIterations) {
    if (token.isCancellationRequested) {
      incompleteReason = "Cancelled before the review finished.";
      break;
    }
    iteration++;
    onProgress({ type: "iteration", current: iteration, max: config.maxIterations });

    let turn;
    try {
      turn = await turns.take(system, messages, tools, MAX_TOKENS_PER_TURN, REVIEW_TASK);
    } catch (err) {
      if (err instanceof LlmCancelledError || token.isCancellationRequested) {
        incompleteReason = "Cancelled before the review finished.";
        break;
      }
      throw err;
    }

    if (turn.stopReason === "refusal") {
      throw new Error(`The model declined this request${turn.detail ? `: ${turn.detail}` : "."}`);
    }
    if (turn.stopReason === "error") {
      throw new Error(turn.detail ?? "The model returned a streaming error.");
    }

    messages.push({
      role: "assistant",
      text: turn.text || undefined,
      toolCalls: turn.toolCalls.length > 0 ? turn.toolCalls : undefined,
      raw: turn.raw,
      // Stamped so these blocks can be stripped if a later turn goes to a
      // different provider — Anthropic's signed thinking blocks and Codex's
      // encrypted reasoning are a hard 400 anywhere else.
      producedBy: turns.client.id,
    });

    if (turn.toolCalls.length === 0) {
      // Model stopped talking without finishing — nudge it once toward a report.
      if (!report) {
        messages.push({ role: "user", text: FORCE_REPORT });
        if (iteration >= config.maxIterations - 1) break;
        continue;
      }
      break;
    }

    // Fork the lookups, keep the ledger in order.
    //
    // Reads, searches and index lookups only observe the workspace, so running
    // them one await at a time just stacks up latency — those go together,
    // bounded so a model asking for twenty files cannot flood the file system.
    //
    // The emitting tools are deliberately left out of that. `propose_fix` links
    // itself to a finding by title, so it has to see the `emit_finding` from the
    // same turn as already applied; running the two side by side loses the link
    // and the patch turns up orphaned. They stay strictly ordered below, which
    // also keeps finding ids matching the order the model asked for them.
    const prefetched = new Map<number, ToolOutcome>();
    await mapWithConcurrency(
      turn.toolCalls
        .map((call, i) => ({ call, i }))
        .filter(({ call }) => READ_ONLY_TOOLS.has(call.name)),
      MAX_PARALLEL_TOOLS,
      async ({ call, i }) => {
        prefetched.set(i, await runner.run(call.name, call.input));
      },
    );

    const results: ToolResult[] = [];
    for (const [i, call] of turn.toolCalls.entries()) {
      const outcome = prefetched.get(i) ?? (await runner.run(call.name, call.input));
      if (outcome.finding) {
        findings.push(outcome.finding);
        onProgress({ type: "finding", finding: outcome.finding });
      }
      if (outcome.fix) {
        fixes.push(outcome.fix);
        onProgress({ type: "fix", fix: outcome.fix });
      }
      if (outcome.report) {
        report = outcome.report;
      }
      results.push({
        callId: call.callId,
        name: call.name,
        content: outcome.content,
        isError: outcome.isError,
      });
    }
    messages.push({ role: "toolResult", results });

    if (report) break;

    const budgetSpent = turns.usage.billedTokens / config.maxSessionTokens;
    if (budgetSpent >= 1) {
      incompleteReason = "Token budget for this run was exhausted.";
      // A turn large enough to jump the whole 80–100% band would otherwise stop
      // the run with no warning at all, which reads as an unexplained halt.
      if (!warnedAboutBudget) {
        onProgress({
          type: "warning",
          text: "Token budget reached — asking for the report now.",
        });
      }
      messages.push({ role: "user", text: FORCE_REPORT });
      report = await finalTurn(turns, system, messages, tools, runner, findings, fixes, token);
      break;
    }
    if (budgetSpent >= 0.8 && !warnedAboutBudget) {
      warnedAboutBudget = true;
      messages.push({ role: "user", text: BUDGET_WARNING });
      onProgress({ type: "warning", text: "Approaching the token budget — wrapping up." });
    }
  }

  if (!report && iteration >= config.maxIterations) {
    incompleteReason ??= `Stopped after ${config.maxIterations} steps.`;
    if (!token.isCancellationRequested) {
      onProgress({ type: "status", text: "Step limit reached — asking for the report." });
      messages.push({ role: "user", text: FORCE_REPORT });
      report = await finalTurn(turns, system, messages, tools, runner, findings, fixes, token);
    }
  }

  const sorted = sortFindings(findings);
  return {
    grade: report?.grade ?? (sorted.length === 0 ? "C" : gradeFromFindings(sorted)),
    summary:
      report?.summary ??
      (sorted.length > 0
        ? `The review stopped early, but ${sorted.length} issue(s) were found. See the findings below.`
        : "The review stopped before producing a summary."),
    findings: sorted,
    fixes,
    blueprint: report?.blueprint,
    graph: buildModuleGraph(Object.values(index.files), {
      entryPoints: scan.entryPoints,
    }),
    scalability: report?.scalability,
    incompleteReason,
    workspaceName: scan.rootName,
    provider: PROVIDER_LABELS[turns.client.id],
    model: turns.client.model,
    generatedAt: new Date().toISOString(),
  };
}

/** One last turn that only accepts emit_report, used when a cap forced the stop. */
async function finalTurn(
  turns: TurnRunner,
  system: string,
  messages: NeutralMessage[],
  tools: ReturnType<typeof toolDefinitions>,
  runner: ToolRunner,
  findings: Finding[],
  fixes: CodeFix[],
  token: vscode.CancellationToken,
): Promise<ReportSubmission | undefined> {
  if (token.isCancellationRequested) return undefined;
  try {
    const turn = await turns.take(system, messages, tools, MAX_TOKENS_PER_TURN, REVIEW_TASK);
    for (const call of turn.toolCalls) {
      const outcome = await runner.run(call.name, call.input);
      if (outcome.finding) findings.push(outcome.finding);
      if (outcome.fix) fixes.push(outcome.fix);
      if (outcome.report) return outcome.report;
    }
  } catch (err) {
    log.warn(`Final report turn failed: ${String(err)}`);
  }
  return undefined;
}

function gradeFromFindings(findings: Finding[]): AnalysisReport["grade"] {
  const critical = findings.filter((f) => f.severity === "critical").length;
  const high = findings.filter((f) => f.severity === "high").length;
  if (critical >= 2) return "F";
  if (critical >= 1) return "D";
  if (high >= 3) return "D";
  if (high >= 1) return "C";
  return "B";
}
