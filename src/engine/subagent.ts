/**
 * Delegating a search.
 *
 * "Find everywhere we validate user input" is a question whose answer is one
 * paragraph and whose cost is twenty file reads. Done in the main conversation,
 * those twenty reads stay in the transcript and are re-sent on every subsequent
 * turn for the rest of the session — the answer is cheap, the searching is what
 * is expensive to carry.
 *
 * So it happens somewhere else. A subagent gets its own transcript, the same
 * index and read tools, and a budget it cannot exceed; the parent gets back the
 * paragraph. The searching is paid for once and then discarded.
 *
 * It can only read. That is not a limitation to be relaxed later — a delegated
 * agent working from a one-line brief, whose reasoning nobody watched, is the
 * last thing that should be allowed to edit files. Anything it finds comes back
 * as words, and the parent decides what to do about it.
 */

import type * as vscode from "vscode";
import type { LlmClient, NeutralMessage, ProviderId, ToolResult } from "../llm/types";
import type { WorkspaceIndex } from "../memory/store";
import { log } from "../util/log";
import { MAX_SUBAGENT_STEPS } from "./codingToolDefs";
import { TOOL_NAMES, toolDefinitions } from "./toolDefs";
import { ToolRunner } from "./tools";
import { MAX_PARALLEL_TOOLS, TurnRunner, mapWithConcurrency } from "./turnRunner";

const MAX_TOKENS_PER_TURN = 4000;

const READ_TOOLS = new Set<string>([
  TOOL_NAMES.findRelevant,
  TOOL_NAMES.listSignals,
  TOOL_NAMES.listDir,
  TOOL_NAMES.readFile,
  TOOL_NAMES.search,
]);

const SUBAGENT_SYSTEM = `You are a research assistant working inside a codebase for another engineer who is mid-task and waiting on you.

You have the project's index and its files, and you can only read. Answer the question you were given and nothing else.

How to work:
- Start with \`find_relevant\`. It queries a prebuilt index in plain language and is far cheaper than searching or reading. Use \`search\` for an exact string, and \`read_file\` only once you know which file matters.
- Read enough to be sure. A confident wrong answer costs the engineer more than a slow one.
- Stop as soon as you can answer. You have about ${MAX_SUBAGENT_STEPS} steps.

Your final message is the entire answer — the engineer never sees your searching, so nothing you found is known unless you write it down. Give real file paths and line numbers. Quote the two or three lines that actually matter. If the answer is "this does not exist here", say that plainly; it is a useful answer and inventing something is not.`;

export interface SubagentContext {
  root: vscode.Uri;
  index: WorkspaceIndex;
  maxFileReadBytes: number;
  token: vscode.CancellationToken;
  getClient: () => Promise<LlmClient | undefined>;
  getFallback?: (exclude: ProviderId) => Promise<LlmClient | undefined>;
  autoFailover: boolean;
  /** Told to the panel so a long delegation is not silence. */
  onProgress?: (note: string) => void;
}

export interface SubagentResult {
  answer: string;
  steps: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Runs one delegated search to completion.
 *
 * Never throws: a subagent that fails should hand the parent a sentence saying
 * so, which the parent can work around, rather than taking down a build that
 * had nothing to do with it.
 */
export async function runSubagent(
  question: string,
  ctx: SubagentContext,
): Promise<SubagentResult> {
  const empty = { steps: 0, inputTokens: 0, outputTokens: 0 };
  let turns: TurnRunner | undefined;

  try {
    turns = await TurnRunner.create({
      getClient: ctx.getClient,
      getFallback: ctx.getFallback,
      autoFailover: ctx.autoFailover,
      token: ctx.token,
      // The parent's stream belongs to the parent; a subagent narrating into it
      // would read as the main agent having changed the subject.
      onEvent: () => {},
    });

    const runner = new ToolRunner({
      root: ctx.root,
      maxFileReadBytes: ctx.maxFileReadBytes,
      token: ctx.token,
      index: ctx.index,
    });

    // Only the reading tools are offered. The emitting tools would let it file
    // findings against a review that is not running.
    const tools = toolDefinitions().filter((tool) => READ_TOOLS.has(tool.name));
    const messages: NeutralMessage[] = [{ role: "user", text: question }];

    for (let step = 1; step <= MAX_SUBAGENT_STEPS; step++) {
      if (ctx.token.isCancellationRequested) {
        return { ...empty, steps: step, answer: "The search was cancelled." };
      }

      const turn = await turns.take(SUBAGENT_SYSTEM, messages, tools, MAX_TOKENS_PER_TURN);
      messages.push({
        role: "assistant",
        text: turn.text || undefined,
        toolCalls: turn.toolCalls.length > 0 ? turn.toolCalls : undefined,
        raw: turn.raw,
        producedBy: turns.client.id,
      });

      if (turn.toolCalls.length === 0) {
        const answer = turn.text.trim();
        return {
          answer: answer.length > 0 ? answer : "The search returned nothing usable.",
          steps: step,
          inputTokens: turns.usage.inputTokens,
          outputTokens: turns.usage.outputTokens,
        };
      }

      ctx.onProgress?.(`${step}/${MAX_SUBAGENT_STEPS} · ${turn.toolCalls[0].name}`);

      // All read-only, so they all go at once.
      const outcomes = await mapWithConcurrency(turn.toolCalls, MAX_PARALLEL_TOOLS, (call) =>
        runner.run(call.name, call.input),
      );
      const results: ToolResult[] = turn.toolCalls.map((call, i) => ({
        callId: call.callId,
        name: call.name,
        content: outcomes[i].content,
        isError: outcomes[i].isError,
      }));
      messages.push({ role: "toolResult", results });
    }

    // Out of steps with no answer written. One more turn, tools withheld, so
    // whatever it did learn is not thrown away.
    messages.push({
      role: "user",
      text: "You are out of steps. Write your answer now from what you have found, and say which parts you could not check.",
    });
    const last = await turns.take(SUBAGENT_SYSTEM, messages, [], MAX_TOKENS_PER_TURN);
    return {
      answer: last.text.trim() || "The search ran out of steps without reaching an answer.",
      steps: MAX_SUBAGENT_STEPS,
      inputTokens: turns.usage.inputTokens,
      outputTokens: turns.usage.outputTokens,
    };
  } catch (err) {
    log.warn(`Delegated search failed: ${String(err)}`);
    return {
      ...empty,
      inputTokens: turns?.usage.inputTokens ?? 0,
      outputTokens: turns?.usage.outputTokens ?? 0,
      answer:
        `The delegated search could not be completed (${String(err)}). ` +
        "Look into it yourself with find_relevant if you still need the answer.",
    };
  }
}
