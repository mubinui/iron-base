/**
 * The conversation: a task in, code out.
 *
 * This is the loop the panel watches. It looks like the review's loop and for
 * good reason — they share `TurnRunner`, so pacing, retries, failover and the
 * token accounting are the same code. What is different is everything around the
 * stop condition.
 *
 * Two things here are worth knowing before changing anything:
 *
 * The writing tools do not run in parallel with each other. Reads do, because
 * they only observe. A write asks the developer a question, and two questions
 * arriving at once is not a thing a person can answer — quite apart from two
 * edits to the same file racing each other.
 *
 * Approving a plan starts a *new* transcript rather than continuing the
 * architect's. The plan is the handover; the forty file reads that produced it
 * are not, and carrying them would mean paying for that exploration again on
 * every turn of the build. The builder re-reads what it needs, which is cheap,
 * and starts from a system prompt written for building rather than planning.
 */

import * as vscode from "vscode";
import type { IronBaseConfig } from "../config";
import {
  LlmCancelledError,
  PROVIDER_LABELS,
  type LlmClient,
  type NeutralMessage,
  type ProviderId,
  type ToolResult,
} from "../llm/types";
import { compact, contextPressure, needsCompaction } from "./compaction";
import { estimateCost } from "../llm/modelLimits";
import { buildDigest } from "../memory/digest";
import { priorBuildsSection } from "../memory/buildMemory";
import { readProjectRules } from "./projectRules";
import type { WorkspaceIndex } from "../memory/store";
import type { McpRegistry } from "../mcp/registry";
import type { ScanResult } from "../scanner/workspaceScanner";
import { describeError, log } from "../util/log";
import { AGENTS, effectivePolicies, READ_ONLY_TOOL_NAMES, type AgentId, type AgentSpec } from "./agents";
import { Checkpoint } from "./checkpoint";
import {
  ARCHITECT_FORCE_PLAN,
  BUILD_BUDGET_WARNING,
  BUILD_FORCE_FINISH,
  architectKickoff,
  builderKickoff,
  editedPlanNote,
  idleNudge,
} from "./codingPrompts";
import type { BuildPlan, Todo } from "./plan";
import { PermissionBroker, type PermissionDecision, type PermissionPrompter } from "./permissions";
import { describeResult } from "./shell";
import { SUBAGENT_TOOL } from "./codingToolDefs";
import { MAX_PARALLEL_TOOLS, TurnRunner, mapWithConcurrency } from "./turnRunner";
import {
  CodingToolRunner,
  codingToolDefinitions,
  type CodingOutcome,
  type CommandRun,
  type FileChange,
} from "./writeTools";

const MAX_TOKENS_PER_TURN = 16000;

export type SessionEvent =
  | { type: "user"; text: string }
  | { type: "assistantText"; delta: string }
  | { type: "tool"; name: string; summary: string }
  | { type: "fileChange"; change: FileChange }
  | { type: "commandStart"; id: string; command: string; why?: string }
  | { type: "commandOutput"; id: string; chunk: string }
  | { type: "commandEnd"; id: string; status: string; ok: boolean }
  | { type: "todos"; todos: Todo[] }
  | { type: "plan"; plan: BuildPlan }
  | { type: "finished"; summary: string; followUps: string[] }
  | { type: "warning"; text: string }
  | { type: "error"; text: string }
  | {
      type: "status";
      running: boolean;
      agent: AgentId;
      iteration?: { current: number; max: number };
      awaitingPlanApproval: boolean;
    }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      budget: number;
      provider: string;
      model: string;
      costUsd?: number;
      /** How full the model's context window is, 0–1. */
      contextUsed?: number;
    };

export interface CodingSessionSnapshot {
  agent: AgentId;
  messages: NeutralMessage[];
  todos: Todo[];
  pendingPlan?: BuildPlan;
  lastTask: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface CodingSessionDeps {
  root: vscode.Uri;
  scan: ScanResult;
  index: WorkspaceIndex;
  /**
   * Read per task rather than captured once, so changing a permission or a
   * budget in settings takes effect on the next thing you ask for instead of
   * needing the panel closed and reopened.
   */
  getConfig: () => IronBaseConfig;
  getClient: () => Promise<LlmClient | undefined>;
  getFallback?: (exclude: ProviderId) => Promise<LlmClient | undefined>;
  /** The panel's permission card. Wrapped below so cancelling answers it. */
  prompt: PermissionPrompter;
  /** Connected MCP servers, if any are configured. */
  mcp?: McpRegistry;
  /** A build reached `finish` having changed something worth remembering. */
  onBuildFinished?: (build: { title: string; outcome: string; files: string[] }) => void;
  emit: (event: SessionEvent) => void;
}

export class CodingSession {
  readonly checkpoint: Checkpoint;
  private readonly permissions: PermissionBroker;
  private readonly digest: string;

  private messages: NeutralMessage[] = [];
  private agent: AgentSpec = AGENTS.architect;
  private running: vscode.CancellationTokenSource | undefined;
  private todos: Todo[] = [];
  /** The last plan submitted, held until the developer approves or discards it. */
  private pendingPlan: BuildPlan | undefined;
  /** The request the current plan answers, so the builder knows the original ask. */
  private lastTask = "";
  private totalInput = 0;
  private totalOutput = 0;
  /** Said once per session, not once per task. */
  private announcedRules = false;

  constructor(private readonly deps: CodingSessionDeps) {
    this.checkpoint = new Checkpoint(deps.root);
    this.permissions = new PermissionBroker(
      effectivePolicies(this.agent, deps.getConfig().permissions),
    );
    this.digest = buildDigest(deps.index, deps.scan);
    log.info(`Coding session ready. Brief is ~${Math.ceil(this.digest.length / 4)} tokens.`);
  }

  /**
   * Everything that has to survive a window reload.
   *
   * The transcript is in here, not just the rendered thread, so a resumed
   * session can be spoken to rather than only read. What is deliberately absent
   * is the digest and the tool definitions — both are rebuilt from the index on
   * the way back in, and a stale copy of either would be worse than none.
   */
  snapshot(): CodingSessionSnapshot {
    return {
      agent: this.agent.id,
      messages: this.messages,
      todos: this.todos,
      pendingPlan: this.pendingPlan,
      lastTask: this.lastTask,
      usage: { inputTokens: this.totalInput, outputTokens: this.totalOutput },
    };
  }

  restore(snapshot: CodingSessionSnapshot): void {
    if (this.running) return;
    this.agent = AGENTS[snapshot.agent] ?? AGENTS.architect;
    this.messages = snapshot.messages;
    this.todos = snapshot.todos;
    this.pendingPlan = snapshot.pendingPlan;
    this.lastTask = snapshot.lastTask;
    this.totalInput = snapshot.usage.inputTokens;
    this.totalOutput = snapshot.usage.outputTokens;
    this.permissions.setPolicies(
      effectivePolicies(this.agent, this.deps.getConfig().permissions),
    );
  }

  /** Clears the conversation without discarding the checkpoint or the grants. */
  reset(): void {
    if (this.running) return;
    this.messages = [];
    this.todos = [];
    this.pendingPlan = undefined;
    this.lastTask = "";
    this.agent = AGENTS.architect;
  }

  get isRunning(): boolean {
    return this.running !== undefined;
  }

  get currentAgent(): AgentId {
    return this.agent.id;
  }

  get currentTodos(): Todo[] {
    return this.todos;
  }

  get awaitingPlanApproval(): boolean {
    return this.pendingPlan !== undefined;
  }

  get autoAcceptsEdits(): boolean {
    return this.permissions.autoAcceptsEdits;
  }

  setAutoAcceptEdits(on: boolean): void {
    this.permissions.setAutoAcceptEdits(on);
  }

  /** Starts a task. `mode` is what the composer's selector was set to. */
  async send(task: string, mode: AgentId): Promise<void> {
    if (this.running) {
      this.deps.emit({ type: "warning", text: "IronBase is already working. Stop it first." });
      return;
    }
    const trimmed = task.trim();
    if (trimmed.length === 0) return;

    this.deps.emit({ type: "user", text: trimmed });
    // A new instruction supersedes any plan still sitting unapproved; leaving it
    // on screen would make the next Build button ambiguous.
    this.pendingPlan = undefined;
    this.lastTask = trimmed;

    const maxIterations = this.deps.getConfig().maxBuildIterations;
    const agent = AGENTS[mode];
    // A follow-up to the same agent continues the conversation, and goes in as
    // the developer wrote it — re-sending the full "here is how to work"
    // preamble mid-conversation reads as an instruction to start over.
    // Changing mode starts fresh, because the system prompt has changed under it.
    const isFollowUp = agent.id === this.agent.id && this.messages.length > 0;
    const kickoff = isFollowUp
      ? trimmed
      : mode === "architect"
        ? architectKickoff(trimmed, maxIterations)
        : builderKickoff(trimmed, undefined, maxIterations);

    await this.runLoop(agent, kickoff, !isFollowUp);
  }

  /**
   * Approves the plan and hands it to the builder.
   *
   * `edited` is whatever the developer's copy of the plan says now, which may
   * not be what the architect wrote. Theirs wins.
   */
  async approvePlan(edited?: string): Promise<void> {
    const plan = this.pendingPlan;
    if (!plan || this.running) return;
    this.pendingPlan = undefined;

    const wasEdited = edited !== undefined && edited.trim().length > 0;
    const kickoff = wasEdited
      ? `The developer approved this plan, after editing it. Implement it.\n\n${edited!.trim()}\n\n${editedPlanNote()}\n\nThe original request was: ${this.lastTask}\n\nPublish the task list with update_todos first, then work through it. Run the project's own tests or build to check your work before calling finish.`
      : builderKickoff(this.lastTask, plan, this.deps.getConfig().maxBuildIterations);

    await this.runLoop(AGENTS.build, kickoff, true);
  }

  discardPlan(): void {
    this.pendingPlan = undefined;
    this.emitStatus(false);
  }

  stop(): void {
    this.running?.cancel();
  }

  private async runLoop(agent: AgentSpec, kickoff: string, freshTranscript: boolean): Promise<void> {
    const { emit } = this.deps;
    const config = this.deps.getConfig();

    if (freshTranscript) this.messages = [];
    this.agent = agent;
    this.permissions.setPolicies(effectivePolicies(agent, config.permissions));

    const source = new vscode.CancellationTokenSource();
    this.running = source;
    this.emitStatus(true);

    // MCP tools join the agent's own list, so the model sees one set of tools
    // and does not have to know which of them are local.
    const tools = [
      ...codingToolDefinitions(new Set(agent.tools)),
      ...(this.deps.mcp?.definitions() ?? []),
    ];
    // Re-read every task rather than cached: the most likely moment to write a
    // rule is straight after watching the agent get something wrong, and it
    // should apply to the next thing asked, not the next window opened.
    const system = await this.buildSystem(agent);
    this.messages.push({ role: "user", text: kickoff });

    // Cancelling has to answer the question on screen, not leave the loop parked
    // on a promise nobody will ever resolve.
    this.permissions.setPrompter((request) =>
      Promise.race([
        this.deps.prompt(request),
        new Promise<PermissionDecision>((resolve) => {
          if (source.token.isCancellationRequested) resolve("reject");
          source.token.onCancellationRequested(() => resolve("reject"));
        }),
      ]),
    );

    const runner = new CodingToolRunner(
      {
        root: this.deps.root,
        index: this.deps.index,
        maxFileReadBytes: config.maxFileReadBytes,
        commandTimeoutMs: config.commandTimeoutMs,
        token: source.token,
        permissions: this.permissions,
        checkpoint: this.checkpoint,
        onFileChange: (change) => emit({ type: "fileChange", change }),
        onCommandStart: (id, command, why) => emit({ type: "commandStart", id, command, why }),
        onCommandOutput: (id, chunk) => emit({ type: "commandOutput", id, chunk }),
        onCommandEnd: (run: CommandRun) =>
          emit({
            type: "commandEnd",
            id: run.id,
            status: describeResult(run.result),
            ok: run.result.exitCode === 0,
          }),
        mcp: this.deps.mcp,
        subagent: {
          root: this.deps.root,
          index: this.deps.index,
          maxFileReadBytes: config.maxFileReadBytes,
          token: source.token,
          getClient: this.deps.getClient,
          getFallback: this.deps.getFallback,
          autoFailover: config.autoFailover,
        },
        onSubagentProgress: (question, note) =>
          emit({ type: "tool", name: SUBAGENT_TOOL, summary: `${question} — ${note}` }),
      },
    );

    // Declared before the runner so the usage event can name the account that
    // served the request — which may not be the one the run started on.
    let turns: TurnRunner | undefined;

    try {
      turns = await TurnRunner.create({
        getClient: this.deps.getClient,
        getFallback: this.deps.getFallback,
        autoFailover: config.autoFailover,
        token: source.token,
        onEvent: (event) => {
          if (event.type === "usage") {
            const client = turns?.client;
            const inputTokens = this.totalInput + event.inputTokens;
            const outputTokens = this.totalOutput + event.outputTokens;
            emit({
              type: "usage",
              inputTokens,
              outputTokens,
              budget: config.maxSessionTokens,
              provider: client ? PROVIDER_LABELS[client.id] : "",
              model: client?.model ?? "",
              costUsd: client
                ? estimateCost({
                    provider: client.id,
                    model: client.model,
                    inputTokens,
                    outputTokens,
                  })
                : undefined,
              contextUsed: client
                ? contextPressure(this.messages, system, client.model)
                : undefined,
            });
          } else if (event.type === "text") {
            emit({ type: "assistantText", delta: event.delta });
          } else if (event.type === "warning") {
            emit({ type: "warning", text: event.text });
          }
        },
      });

      await this.drive(turns, agent, system, tools, runner, source.token);
    } catch (err) {
      if (err instanceof LlmCancelledError || source.token.isCancellationRequested) {
        emit({ type: "warning", text: "Stopped." });
      } else {
        log.error("Coding session failed", err);
        emit({ type: "error", text: describeError(err) });
      }
    } finally {
      // Rolled into the session total whatever happened, so a run that failed
      // half way through still shows what it cost.
      this.totalInput += turns?.usage.inputTokens ?? 0;
      this.totalOutput += turns?.usage.outputTokens ?? 0;
      this.permissions.setPrompter(undefined);
      this.running = undefined;
      source.dispose();
      this.emitStatus(false);
    }
  }

  /**
   * The system prompt for this task: the agent's own guidance, the
   * architectural brief, what this project says about itself, and what earlier
   * builds already did here.
   */
  private async buildSystem(agent: AgentSpec): Promise<string> {
    const parts = [agent.systemPrompt(this.digest)];

    const rules = await readProjectRules(this.deps.root);
    if (rules.text) {
      parts.push(rules.text);
      if (!this.announcedRules) {
        this.announcedRules = true;
        this.deps.emit({
          type: "warning",
          text: `Following this project's own instructions from ${rules.sources.join(" and ")}.`,
        });
      }
    }

    const priorBuilds = priorBuildsSection(this.deps.index);
    if (priorBuilds) parts.push(priorBuilds);

    return parts.join("\n\n");
  }

  private async drive(
    turns: TurnRunner,
    agent: AgentSpec,
    system: string,
    tools: ReturnType<typeof codingToolDefinitions>,
    runner: CodingToolRunner,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const { emit } = this.deps;
    const config = this.deps.getConfig();
    const maxIterations = config.maxBuildIterations;
    let iteration = 0;
    let warnedAboutBudget = false;
    let nudged = false;

    while (iteration < maxIterations && !token.isCancellationRequested) {
      iteration++;
      this.emitStatus(true, { current: iteration, max: maxIterations });

      // Before asking, make sure the question will still fit. Doing this here
      // rather than on a failure means the summary is written while there is
      // still room to write it.
      await this.compactIfNeeded(turns, system, emit);

      const turn = await turns.take(system, this.messages, tools, MAX_TOKENS_PER_TURN, {
        finishTool: agent.finishTool,
        noun: agent.id === "architect" ? "planning run" : "task",
      });

      if (turn.stopReason === "refusal") {
        emit({
          type: "error",
          text: `The model declined this request${turn.detail ? `: ${turn.detail}` : "."}`,
        });
        return;
      }
      if (turn.stopReason === "error") {
        emit({ type: "error", text: turn.detail ?? "The model returned a streaming error." });
        return;
      }

      this.messages.push({
        role: "assistant",
        text: turn.text || undefined,
        toolCalls: turn.toolCalls.length > 0 ? turn.toolCalls : undefined,
        raw: turn.raw,
        producedBy: turns.client.id,
      });

      if (turn.toolCalls.length === 0) {
        // Stopping without the finishing call leaves nothing reported. Nudge
        // once; a second silent turn is the model telling us it is done.
        if (nudged) return;
        nudged = true;
        this.messages.push({ role: "user", text: idleNudge(agent.finishTool) });
        continue;
      }
      nudged = false;

      const done = await this.runTools(turn.toolCalls, runner, token);
      if (done || token.isCancellationRequested) return;

      const spent = turns.usage.billedTokens / config.maxSessionTokens;
      if (spent >= 1) {
        emit({ type: "warning", text: "Token budget reached — asking for a final report." });
        this.messages.push({
          role: "user",
          text: agent.id === "architect" ? ARCHITECT_FORCE_PLAN : BUILD_FORCE_FINISH,
        });
        await this.finalTurn(turns, system, tools, runner, token);
        return;
      }
      if (spent >= 0.8 && !warnedAboutBudget) {
        warnedAboutBudget = true;
        this.messages.push({ role: "user", text: BUILD_BUDGET_WARNING });
        emit({ type: "warning", text: "Approaching the token budget — wrapping up." });
      }
    }

    if (!token.isCancellationRequested) {
      emit({
        type: "warning",
        text: `Step limit reached after ${maxIterations} steps — asking for a final report.`,
      });
      this.messages.push({
        role: "user",
        text: agent.id === "architect" ? ARCHITECT_FORCE_PLAN : BUILD_FORCE_FINISH,
      });
      await this.finalTurn(turns, system, tools, runner, token);
    }
  }

  /**
   * Summarises the older half of the transcript when the window is filling.
   *
   * The developer is told, because the model is about to become vaguer about
   * what it did an hour ago and that is worth knowing — particularly if it then
   * re-reads a file you watched it read already.
   */
  private async compactIfNeeded(
    turns: TurnRunner,
    system: string,
    emit: (event: SessionEvent) => void,
  ): Promise<void> {
    const model = turns.client.model;
    if (!needsCompaction(this.messages, system, model)) return;

    emit({ type: "warning", text: "Context is filling up — summarising the earlier steps." });
    const result = await compact(this.messages, system, turns.client, this.running!.token);
    if (!result.compacted) return;

    this.messages = result.messages;
    log.info(
      `Compacted the transcript: ${result.replaced ?? 0} message(s) replaced, ` +
        `~${result.before.toLocaleString()} → ~${result.after.toLocaleString()} tokens.`,
    );
    emit({
      type: "warning",
      text:
        `Compacted the conversation: about ${Math.round(result.before / 1000)}k tokens of history ` +
        `became ${Math.round(result.after / 1000)}k. Earlier detail is now a summary.`,
    });
  }

  /**
   * Runs a turn's tool calls. Returns true once the finishing tool has fired.
   *
   * Reads fan out; everything else is strictly ordered. See the note at the top
   * of this file for why that asymmetry is deliberate rather than an oversight.
   */
  private async runTools(
    calls: Array<{ callId: string; name: string; input: unknown }>,
    runner: CodingToolRunner,
    token: vscode.CancellationToken,
  ): Promise<boolean> {
    const { emit } = this.deps;

    const prefetched = new Map<number, CodingOutcome>();
    await mapWithConcurrency(
      calls.map((call, i) => ({ call, i })).filter(({ call }) => READ_ONLY_TOOL_NAMES.has(call.name)),
      MAX_PARALLEL_TOOLS,
      async ({ call, i }) => {
        prefetched.set(i, await runner.run(call.name, call.input));
      },
    );

    const results: ToolResult[] = [];
    let finished = false;

    for (const [i, call] of calls.entries()) {
      if (token.isCancellationRequested) break;

      // Only the looking gets a trace line. Editing, running a command and
      // finishing all draw their own card, and announcing them twice turns the
      // useful part of the thread into scrollback.
      if (READ_ONLY_TOOL_NAMES.has(call.name)) {
        emit({ type: "tool", name: call.name, summary: describeCall(call.name, call.input) });
      }
      const outcome = prefetched.get(i) ?? (await runner.run(call.name, call.input));

      if (outcome.todos) {
        this.todos = outcome.todos;
        emit({ type: "todos", todos: outcome.todos });
      }
      if (outcome.plan) {
        this.pendingPlan = outcome.plan;
        emit({ type: "plan", plan: outcome.plan });
        finished = true;
      }
      if (outcome.finished) {
        emit({
          type: "finished",
          summary: outcome.finished.summary,
          followUps: outcome.finished.followUps,
        });
        // Recorded against the project, so a build next week knows this one
        // happened rather than proposing it again.
        if (this.agent.id === "build" && this.checkpoint.size > 0) {
          this.deps.onBuildFinished?.({
            title: this.lastTask,
            outcome: outcome.finished.summary,
            files: this.checkpoint.touched,
          });
        }
        finished = true;
      }

      results.push({
        callId: call.callId,
        name: call.name,
        content: outcome.content,
        isError: outcome.isError,
      });
    }

    if (results.length > 0) this.messages.push({ role: "toolResult", results });
    return finished;
  }

  /** One last turn after a cap, to get a report out rather than stopping mute. */
  private async finalTurn(
    turns: TurnRunner,
    system: string,
    tools: ReturnType<typeof codingToolDefinitions>,
    runner: CodingToolRunner,
    token: vscode.CancellationToken,
  ): Promise<void> {
    if (token.isCancellationRequested) return;
    try {
      const turn = await turns.take(system, this.messages, tools, MAX_TOKENS_PER_TURN, {
        finishTool: this.agent.finishTool,
        noun: this.agent.id === "architect" ? "planning run" : "task",
      });
      this.messages.push({
        role: "assistant",
        text: turn.text || undefined,
        toolCalls: turn.toolCalls.length > 0 ? turn.toolCalls : undefined,
        raw: turn.raw,
        producedBy: turns.client.id,
      });
      await this.runTools(turn.toolCalls, runner, token);
    } catch (err) {
      log.warn(`Final turn failed: ${String(err)}`);
    }
  }

  private emitStatus(running: boolean, iteration?: { current: number; max: number }): void {
    this.deps.emit({
      type: "status",
      running,
      agent: this.agent.id,
      iteration,
      awaitingPlanApproval: this.pendingPlan !== undefined,
    });
  }
}

/** The one-line label a tool call gets in the thread. */
function describeCall(name: string, input: unknown): string {
  const args = (typeof input === "object" && input !== null ? input : {}) as Record<
    string,
    unknown
  >;
  const path = typeof args.path === "string" ? args.path : "";
  switch (name) {
    case "read_file":
      return path;
    case "list_dir":
      return path || ".";
    case "find_relevant":
      return typeof args.query === "string" ? args.query : "";
    case "list_signals":
      return typeof args.kind === "string" ? args.kind : "";
    case "search":
      return typeof args.pattern === "string" ? args.pattern : "";
    case "run_command":
      return typeof args.command === "string" ? args.command : "";
    case "update_todos":
      return "";
    default:
      return path;
  }
}
