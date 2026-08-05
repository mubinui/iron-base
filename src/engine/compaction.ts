/**
 * Making room when the conversation outgrows the model.
 *
 * `transcript.ts` handles the cheap half of this: old tool-result bodies become
 * one-line notes on the way out. That is enough for a review, which is forty
 * steps and done. A build is not — it reads twenty files, writes ten, runs the
 * tests three times, and the transcript keeps growing whether or not the tool
 * results in it have been pruned.
 *
 * Eventually the request stops fitting. What happens then, without this, is a
 * 400 from the provider halfway through the work, with the transcript still too
 * big to retry — so the run is simply over, having half-edited the codebase.
 *
 * So: when the transcript passes a fraction of the window, the oldest turns are
 * replaced by a written summary of what happened in them, and the recent turns
 * are kept verbatim. That is lossy and it is meant to be — the alternative is
 * not "keep everything", it is "stop".
 *
 * The summary is produced by the model itself, because the useful version of
 * "what happened in the first thirty steps" is a paragraph about the code, not
 * a list of tool names. If that call fails, a mechanical summary is written
 * instead, which is worse but always available.
 */

import type { LlmClient, NeutralMessage, CancelToken } from "../llm/types";
import { contextWindowFor } from "../llm/modelLimits";
import { estimateTokens } from "./transcript";

/**
 * Fraction of the window at which compaction runs.
 *
 * Not 0.95: the reply itself needs room, and a turn that reads three large
 * files can add a lot at once. Leaving a third of the window free means the
 * threshold is crossed with enough space left to act on it.
 */
const PRESSURE_THRESHOLD = 0.65;
/** Turns at the end that are never summarised — the model needs its recent work. */
const KEEP_RECENT_MESSAGES = 8;
/** Below this there is nothing worth summarising; the overhead would exceed it. */
const MIN_MESSAGES_TO_COMPACT = 12;

const SUMMARY_SYSTEM = `You are compressing your own working memory so you can keep going on a coding task.

Write a factual handover note for yourself, covering:
- what was asked, and any constraint or preference the developer stated;
- what you learned about the codebase — real file paths, how the relevant parts fit together, anything that turned out to be different from what you first assumed;
- every change you have already made, file by file;
- what you ran and what it said;
- what is still left to do.

Be specific and be brief. Real names and paths, no reflection on the process, no apology, no restating these instructions. This note is all you will have of the earlier conversation, so anything you leave out is gone.`;

export interface CompactionResult {
  messages: NeutralMessage[];
  compacted: boolean;
  /** Rough token counts either side, for the log and the panel notice. */
  before: number;
  after: number;
  /** How many messages were folded into the summary. */
  replaced?: number;
}

/** How full the window is, 0–1, for the meter in the panel header. */
export function contextPressure(
  messages: NeutralMessage[],
  system: string,
  model: string,
): number {
  return estimateTokens(messages, system) / contextWindowFor(model);
}

export function needsCompaction(
  messages: NeutralMessage[],
  system: string,
  model: string,
): boolean {
  return (
    messages.length >= MIN_MESSAGES_TO_COMPACT &&
    contextPressure(messages, system, model) >= PRESSURE_THRESHOLD
  );
}

/**
 * Replaces the older half of the transcript with a summary of it.
 *
 * The returned array is new; the caller decides whether to adopt it. On any
 * failure the original is returned unchanged and marked `compacted: false`,
 * because a compaction that half-worked would leave the transcript in a state
 * neither the model nor the code could reason about.
 */
export async function compact(
  messages: NeutralMessage[],
  system: string,
  client: LlmClient,
  token: CancelToken,
): Promise<CompactionResult> {
  const before = estimateTokens(messages, system);

  const cut = findCut(messages);
  if (cut <= 0) return { messages, compacted: false, before, after: before };

  const older = messages.slice(0, cut);
  const recent = messages.slice(cut);

  let summary: string;
  try {
    const turn = await client.chat(
      {
        system: SUMMARY_SYSTEM,
        messages: [
          ...older,
          {
            role: "user",
            text: "Write the handover note now. Nothing else — no preamble, no tool calls.",
          },
        ],
        // No tools: this call must produce prose and stop. Offering the coding
        // tools here would let a model "helpfully" resume the task inside its
        // own summarisation, editing files nobody approved.
        tools: [],
        maxTokens: 2000,
        model: client.model,
      },
      () => {},
      token,
    );
    summary = turn.text.trim();
  } catch {
    // The mechanical summary below covers this. Reporting it is the caller's
    // job — this module stays free of `vscode` so it can be tested directly.
    summary = "";
  }

  if (summary.length === 0) summary = mechanicalSummary(older);

  const compactedMessages: NeutralMessage[] = [
    {
      role: "user",
      text: `[Earlier in this session — the detail has been dropped to make room, and this note is what remains of it.]\n\n${summary}`,
    },
    ...recent,
  ];

  return {
    messages: compactedMessages,
    compacted: true,
    before,
    after: estimateTokens(compactedMessages, system),
    replaced: older.length,
  };
}

/**
 * Where to cut, such that the second half still begins with a coherent turn.
 *
 * A transcript must never start with a `toolResult` whose call was in a message
 * that has just been summarised away — providers reject that outright, and the
 * ones that do not get confused by results for calls they cannot see. So the
 * cut walks forward to the next `user` or `assistant` message.
 */
function findCut(messages: NeutralMessage[]): number {
  let cut = Math.max(0, messages.length - KEEP_RECENT_MESSAGES);
  while (cut < messages.length && messages[cut].role === "toolResult") cut++;
  // Leave the very first message alone where possible: it holds the original
  // task, and everything after it is easier to read with it still there.
  return cut >= messages.length ? 0 : cut;
}

/** The fallback when the model could not write its own note. */
function mechanicalSummary(older: NeutralMessage[]): string {
  const tools = new Map<string, number>();
  const said: string[] = [];

  for (const message of older) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        tools.set(call.name, (tools.get(call.name) ?? 0) + 1);
      }
      if (message.text && message.text.trim().length > 0) said.push(message.text.trim());
    } else if (message.role === "user") {
      said.push(message.text.trim());
    }
  }

  const calls = [...tools.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name}×${count}`)
    .join(", ");

  return [
    "This session's earlier steps could not be summarised in detail, so only an outline remains.",
    calls.length > 0 ? `Tools used: ${calls}.` : "",
    said.length > 0 ? `\nWhat was said:\n${said.slice(-6).join("\n\n")}` : "",
    "\nRe-read any file you are unsure about rather than trusting your memory of it.",
  ]
    .filter((part) => part.length > 0)
    .join("\n");
}
