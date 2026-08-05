/**
 * Keeping the transcript small.
 *
 * An agent loop re-sends its entire history on every turn, so a 40-step review
 * pays for step 1 forty times. The file contents that dominate that history stop
 * being useful almost immediately: once the model has read a file and emitted a
 * finding about it, the bytes are dead weight that it will keep paying to carry.
 *
 * So old tool results are replaced with a one-line note saying what was fetched
 * and how big it was. The model can always re-read a file if it genuinely needs
 * to, and in practice it does not, because whatever it learned is already in its
 * own reasoning further down the transcript.
 */

import type { NeutralMessage, ProviderId } from "../llm/types";

/** Recent tool results stay whole; older ones are worth more as a summary. */
const KEEP_VERBATIM = 3;
/** Below this a result is cheaper to keep than to describe. */
const MIN_WORTH_PRUNING = 400;

export interface CompactionStats {
  /** Roughly how many characters were removed from the next request. */
  charsSaved: number;
  resultsPruned: number;
}

/**
 * Replaces the bodies of older tool results with a short placeholder.
 *
 * Mutates nothing: the caller keeps the full transcript, and only the copy sent
 * over the wire is trimmed. That matters because the same history may later go
 * to a different provider, and because a lost tool result cannot be recovered.
 */
export function compactForRequest(messages: NeutralMessage[]): {
  messages: NeutralMessage[];
  stats: CompactionStats;
} {
  const toolResultIndexes: number[] = [];
  messages.forEach((message, i) => {
    if (message.role === "toolResult") toolResultIndexes.push(i);
  });

  const prunableBefore = toolResultIndexes.length - KEEP_VERBATIM;
  if (prunableBefore <= 0) {
    return { messages, stats: { charsSaved: 0, resultsPruned: 0 } };
  }
  const cutoff = toolResultIndexes[prunableBefore - 1];

  let charsSaved = 0;
  let resultsPruned = 0;

  const out = messages.map((message, i) => {
    if (message.role !== "toolResult" || i > cutoff) return message;
    return {
      role: "toolResult" as const,
      results: message.results.map((result) => {
        if (result.content.length < MIN_WORTH_PRUNING) return result;
        // An error keeps its text: the model needs to know what it got wrong,
        // and errors are short anyway.
        if (result.isError) return result;
        const summary = summarize(result.name, result.content);
        charsSaved += result.content.length - summary.length;
        resultsPruned++;
        return { ...result, content: summary };
      }),
    };
  });

  return { messages: out, stats: { charsSaved, resultsPruned } };
}

function summarize(tool: string, content: string): string {
  const lines = content.split("\n");
  const head = lines[0]?.slice(0, 120) ?? "";
  return (
    `[${tool}: ${lines.length} lines, ${Math.round(content.length / 1000)}KB, dropped from history to save context. ` +
    `First line was "${head}". Call the tool again if you need it back.]`
  );
}

/**
 * Makes a transcript safe to send to a different provider than the one that
 * produced it.
 *
 * `raw` holds provider-native blocks, including Anthropic's signed thinking
 * blocks and Codex's encrypted reasoning items. Those are meaningless, and
 * usually a hard 400, anywhere else. Dropping them costs a little continuity and
 * is what makes switching provider mid-review possible at all.
 */
export function stripForeignBlocks(
  messages: NeutralMessage[],
  target: ProviderId,
): NeutralMessage[] {
  let changed = false;
  const out = messages.map((message) => {
    if (message.role !== "assistant" || message.raw === undefined) return message;
    if (message.producedBy === target) return message;
    changed = true;
    const { raw, producedBy, ...rest } = message;
    return rest;
  });
  return changed ? out : messages;
}

/** Rough token estimate for logging. Four characters per token is close enough. */
export function estimateTokens(messages: NeutralMessage[], system: string): number {
  let chars = system.length;
  for (const message of messages) {
    if (message.role === "user") chars += message.text.length;
    else if (message.role === "assistant") {
      chars += (message.text ?? "").length;
      for (const call of message.toolCalls ?? []) {
        chars += call.name.length + JSON.stringify(call.input ?? {}).length;
      }
    } else {
      for (const result of message.results) chars += result.content.length;
    }
  }
  return Math.ceil(chars / 4);
}
