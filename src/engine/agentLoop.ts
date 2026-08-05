import * as vscode from "vscode";
import type { IronBaseConfig } from "../config";
import {
  LlmCancelledError,
  LlmHttpError,
  type LlmClient,
  type NeutralMessage,
  type ProviderId,
  type ToolResult,
} from "../llm/types";
import { PROVIDER_LABELS } from "../llm/types";
import { log } from "../util/log";
import { sleep } from "../util/limits";
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
import { compactForRequest, stripForeignBlocks } from "./transcript";

const MAX_TOKENS_PER_TURN = 16000;
const MAX_RETRIES = 4;
/**
 * How many of a turn's tool calls run at once.
 *
 * The work is file I/O on the extension host, so a handful in flight hides the
 * latency without starving the editor of its own thread.
 */
const MAX_PARALLEL_TOOLS = 6;
/** A cache read bills at roughly a tenth of a fresh input token. */
const CACHED_TOKEN_WEIGHT = 0.1;

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
/** Gemini's free tier allows ~60 requests/minute; pace below that for all providers. */
const MIN_REQUEST_INTERVAL_MS = 1200;

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

  const first = await options.getClient();
  if (!first) throw new Error("No AI provider is connected.");
  let client: LlmClient = first;

  /**
   * Moves the run onto another connected account when this one is rate limited.
   *
   * A subscription tier that has hit its cap will still be capped in thirty
   * seconds, so backing off and trying the same account again mostly burns the
   * review's remaining time. Anyone with a second account signed in has somewhere
   * to go, and the transcript is provider-neutral apart from the `raw` blocks
   * that get stripped on the way out.
   */
  const switchProvider = async (): Promise<boolean> => {
    if (!config.autoFailover || !options.getFallback) return false;
    const alternative = await options.getFallback(client.id);
    if (!alternative || alternative.id === client.id) return false;
    onProgress({
      type: "warning",
      text: `${PROVIDER_LABELS[client.id]} is rate limited — continuing on ${PROVIDER_LABELS[alternative.id]}.`,
    });
    log.warn(
      `Failing over from ${PROVIDER_LABELS[client.id]} to ${PROVIDER_LABELS[alternative.id]}.`,
    );
    client = alternative;
    return true;
  };

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
  let tokensUsed = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  /** What the budget is charged: real tokens, with cache reads at their true cost. */
  let billedTokens = 0;
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

    // Re-resolved every step rather than captured once, so changing provider or
    // model in the sidebar takes effect on the review already running. A failed
    // resolve keeps the previous client rather than killing the run.
    client = (await options.getClient()) ?? client;

    const sinceLast = Date.now() - lastRequestAt;
    if (sinceLast < MIN_REQUEST_INTERVAL_MS) {
      await sleep(MIN_REQUEST_INTERVAL_MS - sinceLast);
    }
    lastRequestAt = Date.now();

    let turn;
    try {
      turn = await callWithRetry(
        () => {
          // Rebuilt per attempt rather than once per turn, because a retry may
          // be going to a different provider than the one this request was
          // first shaped for, and `raw` blocks are only valid for their author.
          //
          // The whole transcript is re-sent every turn, so step 1 is paid for
          // again on step 40. Old file contents are the bulk of that and stop
          // being useful the moment a finding is written about them, so they
          // travel as a one-line note. The full history is kept locally — only
          // the copy going over the wire shrinks.
          const wire = compactForRequest(stripForeignBlocks(messages, client.id));
          if (wire.stats.resultsPruned > 0) {
            log.info(
              `Compacted ${wire.stats.resultsPruned} old tool result(s), ` +
                `~${Math.round(wire.stats.charsSaved / 4).toLocaleString()} tokens saved this turn.`,
            );
          }
          return client.chat(
            {
              system,
              messages: wire.messages,
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
                inputTokens += event.inputTokens;
                outputTokens += event.outputTokens;
                const cached = event.cachedInputTokens ?? 0;
                // The budget exists to stop a runaway *spend*, and a cached
                // token bills at about a tenth of a fresh one. Charging both the
                // same made a well-cached run — which is every run, since the
                // brief is byte-stable — look like it was burning through its
                // budget when it was replaying the cheapest tokens available.
                billedTokens +=
                  event.inputTokens - cached + cached * CACHED_TOKEN_WEIGHT + event.outputTokens;
                tokensUsed = billedTokens;
                onProgress({
                  type: "usage",
                  inputTokens,
                  outputTokens,
                  budget: config.maxSessionTokens,
                });
              }
            },
            token,
          );
        },
        token,
        onProgress,
        switchProvider,
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
      // Stamped so these blocks can be stripped if a later turn goes to a
      // different provider — Anthropic's signed thinking blocks and Codex's
      // encrypted reasoning are a hard 400 anywhere else.
      producedBy: client.id,
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
      report = await finalTurn(options, system, messages, tools, runner, findings, fixes, onProgress);
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
      report = await finalTurn(options, system, messages, tools, runner, findings, fixes, onProgress);
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
  runner: ToolRunner,
  findings: Finding[],
  fixes: CodeFix[],
  onProgress: (event: ProgressEvent) => void,
): Promise<ReportSubmission | undefined> {
  const { token } = options;
  if (token.isCancellationRequested) return undefined;
  const client = await options.getClient();
  if (!client) return undefined;
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
      if (outcome.fix) fixes.push(outcome.fix);
      if (outcome.report) return outcome.report;
    }
  } catch (err) {
    log.warn(`Final report turn failed: ${String(err)}`);
  }
  return undefined;
}

/**
 * Runs `worker` over every item with at most `limit` in flight, returning the
 * results in input order.
 *
 * Workers pull from a shared cursor rather than being sliced into fixed batches,
 * so one slow file read cannot hold up the whole group behind it.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
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
  switchProvider?: () => Promise<boolean>,
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

      // A rate limit is the one failure another account can answer immediately,
      // so try that before sleeping. Waiting out a subscription cap can cost
      // minutes of a review that has a step budget to spend.
      if (httpErr.status === 429 && switchProvider && (await switchProvider())) {
        continue;
      }

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
