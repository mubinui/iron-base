import * as vscode from "vscode";
import type { IronBaseConfig } from "../config";
import {
  LlmCancelledError,
  LlmHttpError,
  type LlmClient,
  type NeutralMessage,
  type ToolResult,
} from "../llm/types";
import { PROVIDER_LABELS } from "../llm/types";
import { log } from "../util/log";
import { sleep } from "../util/limits";
import type { ScanResult } from "../scanner/workspaceScanner";
import { buildDigest } from "../memory/digest";
import type { WorkspaceIndex } from "../memory/store";
import { sortFindings, type AnalysisReport, type Finding } from "./findings";
import {
  BUDGET_WARNING,
  FORCE_REPORT,
  buildKickoffMessage,
  buildSystemPrompt,
  type RunMode,
} from "./prompts";
import { ToolRunner, toolDefinitions, type ReportSubmission } from "./tools";

const MAX_TOKENS_PER_TURN = 16000;
const MAX_RETRIES = 4;
/** Gemini's free tier allows ~60 requests/minute; pace below that for all providers. */
const MIN_REQUEST_INTERVAL_MS = 1200;

export type ProgressEvent =
  | { type: "status"; text: string }
  | { type: "text"; delta: string }
  | { type: "tool"; name: string }
  | { type: "finding"; finding: Finding }
  | { type: "iteration"; current: number; max: number }
  | { type: "warning"; text: string };

export interface RunOptions {
  client: LlmClient;
  scan: ScanResult;
  index: WorkspaceIndex;
  mode: RunMode;
  config: IronBaseConfig;
  token: vscode.CancellationToken;
  onProgress: (event: ProgressEvent) => void;
}

export async function runAnalysis(options: RunOptions): Promise<AnalysisReport> {
  const { client, scan, index, mode, config, token, onProgress } = options;

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
  let report: ReportSubmission | undefined;
  let tokensUsed = 0;
  let iteration = 0;
  let warnedAboutBudget = false;
  let incompleteReason: string | undefined;
  let lastRequestAt = 0;

  while (iteration < config.maxIterations) {
    if (token.isCancellationRequested) {
      incompleteReason = "Cancelled before the review finished.";
      break;
    }
    iteration++;
    onProgress({ type: "iteration", current: iteration, max: config.maxIterations });

    const sinceLast = Date.now() - lastRequestAt;
    if (sinceLast < MIN_REQUEST_INTERVAL_MS) {
      await sleep(MIN_REQUEST_INTERVAL_MS - sinceLast);
    }
    lastRequestAt = Date.now();

    let turn;
    try {
      turn = await callWithRetry(
        () =>
          client.chat(
            {
              system,
              messages,
              tools,
              maxTokens: MAX_TOKENS_PER_TURN,
              model: client.model,
            },
            (event) => {
              if (event.type === "text") {
                onProgress({ type: "text", delta: event.delta });
              } else if (event.type === "toolCallStart") {
                onProgress({ type: "tool", name: event.name });
              } else if (event.type === "usage") {
                tokensUsed += event.inputTokens + event.outputTokens;
              }
            },
            token,
          ),
        token,
        onProgress,
      );
    } catch (err) {
      if (err instanceof LlmCancelledError || token.isCancellationRequested) {
        incompleteReason = "Cancelled before the review finished.";
        break;
      }
      throw err;
    }

    if (turn.stopReason === "refusal") {
      throw new Error(
        `The model declined this request${turn.detail ? `: ${turn.detail}` : "."}`,
      );
    }
    if (turn.stopReason === "error") {
      throw new Error(turn.detail ?? "The model returned a streaming error.");
    }

    messages.push({
      role: "assistant",
      text: turn.text || undefined,
      toolCalls: turn.toolCalls.length > 0 ? turn.toolCalls : undefined,
      raw: turn.raw,
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

    const results: ToolResult[] = [];
    for (const call of turn.toolCalls) {
      const outcome = await runner.run(call.name, call.input);
      if (outcome.finding) {
        findings.push(outcome.finding);
        onProgress({ type: "finding", finding: outcome.finding });
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

    const budgetSpent = tokensUsed / config.maxSessionTokens;
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
      report = await finalTurn(options, system, messages, tools, () => tokensUsed, runner, findings, onProgress);
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
      report = await finalTurn(options, system, messages, tools, () => tokensUsed, runner, findings, onProgress);
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
    scalability: report?.scalability,
    incompleteReason,
    workspaceName: scan.rootName,
    provider: PROVIDER_LABELS[client.id],
    model: client.model,
    generatedAt: new Date().toISOString(),
  };
}

/** One last turn that only accepts emit_report, used when a cap forced the stop. */
async function finalTurn(
  options: RunOptions,
  system: string,
  messages: NeutralMessage[],
  tools: ReturnType<typeof toolDefinitions>,
  getTokens: () => number,
  runner: ToolRunner,
  findings: Finding[],
  onProgress: (event: ProgressEvent) => void,
): Promise<ReportSubmission | undefined> {
  const { client, token } = options;
  if (token.isCancellationRequested) return undefined;
  try {
    const turn = await client.chat(
      { system, messages, tools, maxTokens: MAX_TOKENS_PER_TURN, model: client.model },
      (event) => {
        if (event.type === "text") onProgress({ type: "text", delta: event.delta });
      },
      token,
    );
    for (const call of turn.toolCalls) {
      const outcome = await runner.run(call.name, call.input);
      if (outcome.finding) findings.push(outcome.finding);
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

/** Retries 429s and 5xx with backoff; everything else surfaces immediately. */
async function callWithRetry<T>(
  operation: () => Promise<T>,
  token: vscode.CancellationToken,
  onProgress: (event: ProgressEvent) => void,
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (err) {
      if (token.isCancellationRequested) throw new LlmCancelledError();
      const retryable =
        err instanceof LlmHttpError && (err.status === 429 || err.status >= 500);
      if (!retryable || attempt >= MAX_RETRIES) throw err;

      attempt++;
      const httpErr = err as LlmHttpError;
      const waitMs = httpErr.retryAfterSeconds
        ? httpErr.retryAfterSeconds * 1000
        : Math.min(30_000, 1000 * 2 ** attempt);
      const reason = httpErr.status === 429 ? "Rate limited" : "Service error";
      onProgress({
        type: "warning",
        text: `${reason} — retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt}/${MAX_RETRIES}).`,
      });
      log.warn(`${reason} (HTTP ${httpErr.status}); waiting ${waitMs}ms.`);
      await sleep(waitMs);
    }
  }
}
