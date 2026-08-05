/**
 * One turn of an agent loop, done properly.
 *
 * Every loop in IronBase — the architecture review, the architect, the builder —
 * needs the same things around each request: pace it so a free tier does not
 * throw 429s at us, shrink the transcript before it goes over the wire, retry
 * server errors, move to another account when this one is rate limited, and
 * charge the token budget honestly. None of that is specific to what the loop is
 * *for*, and all of it took a while to get right.
 *
 * So it lives here once. What each loop keeps for itself is the part that
 * genuinely differs: which tools it offers, when it is finished, and what it
 * does with the results. That is the whole reason this is a "take one turn"
 * object rather than a `run()` that owns the loop.
 */

import type * as vscode from "vscode";
import {
  LlmCancelledError,
  LlmHttpError,
  PROVIDER_LABELS,
  type ChatRequest,
  type ChatTurn,
  type LlmClient,
  type NeutralMessage,
  type ProviderId,
  type ToolDef,
} from "../llm/types";
import { sleep } from "../util/limits";
import { log } from "../util/log";
import { compactForRequest, stripForeignBlocks } from "./transcript";

const MAX_RETRIES = 4;
/** A cache read bills at roughly a tenth of a fresh input token. */
const CACHED_TOKEN_WEIGHT = 0.1;
/** Gemini's free tier allows ~60 requests/minute; pace below that for all providers. */
const MIN_REQUEST_INTERVAL_MS = 1200;
/**
 * How many of a turn's read-only tool calls run at once.
 *
 * The work is file I/O on the extension host, so a handful in flight hides the
 * latency without starving the editor of its own thread.
 */
export const MAX_PARALLEL_TOOLS = 6;

export type TurnEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; name: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; billedTokens: number }
  | { type: "warning"; text: string };

export interface TurnRunnerOptions {
  /**
   * Resolved before every request rather than fixed at the start, so switching
   * provider or model in the sidebar takes effect on the next step of a run that
   * is already going rather than requiring a fresh one.
   */
  getClient: () => Promise<LlmClient | undefined>;
  /** Another connected account to continue on when this one is rate limited. */
  getFallback?: (exclude: ProviderId) => Promise<LlmClient | undefined>;
  autoFailover: boolean;
  token: vscode.CancellationToken;
  onEvent: (event: TurnEvent) => void;
}

export class TurnRunner {
  private current: LlmClient;
  private lastRequestAt = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  /** What the budget is charged: real tokens, with cache reads at their true cost. */
  private billed = 0;

  private constructor(
    private readonly options: TurnRunnerOptions,
    first: LlmClient,
  ) {
    this.current = first;
  }

  /** Fails here, before any work is done, when nothing is connected. */
  static async create(options: TurnRunnerOptions): Promise<TurnRunner> {
    const first = await options.getClient();
    if (!first) throw new Error("No AI provider is connected.");
    return new TurnRunner(options, first);
  }

  get client(): LlmClient {
    return this.current;
  }

  get usage(): { inputTokens: number; outputTokens: number; billedTokens: number } {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      billedTokens: this.billed,
    };
  }

  /**
   * Sends the transcript and returns what the model said.
   *
   * `messages` is not modified — appending the reply is the caller's job, since
   * only the caller knows whether it wants to keep it.
   */
  async take(
    system: string,
    messages: NeutralMessage[],
    tools: ToolDef[],
    maxTokens: number,
    task?: ChatRequest["task"],
  ): Promise<ChatTurn> {
    const { token, onEvent } = this.options;

    this.current = (await this.options.getClient()) ?? this.current;

    const sinceLast = Date.now() - this.lastRequestAt;
    if (sinceLast < MIN_REQUEST_INTERVAL_MS) {
      await sleep(MIN_REQUEST_INTERVAL_MS - sinceLast);
    }
    this.lastRequestAt = Date.now();

    return await this.withRetry(() => {
      // Rebuilt per attempt rather than once per turn, because a retry may be
      // going to a different provider than the one this request was first shaped
      // for, and `raw` blocks are only valid for their author.
      //
      // The whole transcript is re-sent every turn, so step 1 is paid for again
      // on step 40. Old file contents are the bulk of that and stop being useful
      // the moment the model has acted on them, so they travel as a one-line
      // note. The full history is kept locally — only the copy going over the
      // wire shrinks.
      const wire = compactForRequest(stripForeignBlocks(messages, this.current.id));
      if (wire.stats.resultsPruned > 0) {
        log.info(
          `Compacted ${wire.stats.resultsPruned} old tool result(s), ` +
            `~${Math.round(wire.stats.charsSaved / 4).toLocaleString()} tokens saved this turn.`,
        );
      }
      return this.current.chat(
        {
          system,
          messages: wire.messages,
          tools,
          maxTokens,
          model: this.current.model,
          task,
        },
        (event) => {
          if (event.type === "text") {
            onEvent({ type: "text", delta: event.delta });
          } else if (event.type === "toolCallStart") {
            onEvent({ type: "tool", name: event.name });
          } else if (event.type === "usage") {
            this.inputTokens += event.inputTokens;
            this.outputTokens += event.outputTokens;
            const cached = event.cachedInputTokens ?? 0;
            // The budget exists to stop a runaway *spend*, and a cached token
            // bills at about a tenth of a fresh one. Charging both the same made
            // a well-cached run — which is every run, since the brief is
            // byte-stable — look like it was burning through its budget when it
            // was replaying the cheapest tokens available.
            this.billed +=
              event.inputTokens - cached + cached * CACHED_TOKEN_WEIGHT + event.outputTokens;
            onEvent({
              type: "usage",
              inputTokens: this.inputTokens,
              outputTokens: this.outputTokens,
              billedTokens: this.billed,
            });
          }
        },
        token,
      );
    });
  }

  /**
   * Moves onto another connected account when this one is rate limited.
   *
   * A subscription tier that has hit its cap will still be capped in thirty
   * seconds, so backing off and trying the same account again mostly burns the
   * run's remaining time. Anyone with a second account signed in has somewhere
   * to go, and the transcript is provider-neutral apart from the `raw` blocks
   * that get stripped on the way out.
   */
  private async switchProvider(): Promise<boolean> {
    if (!this.options.autoFailover || !this.options.getFallback) return false;
    const alternative = await this.options.getFallback(this.current.id);
    if (!alternative || alternative.id === this.current.id) return false;
    this.options.onEvent({
      type: "warning",
      text: `${PROVIDER_LABELS[this.current.id]} is rate limited — continuing on ${
        PROVIDER_LABELS[alternative.id]
      }.`,
    });
    log.warn(
      `Failing over from ${PROVIDER_LABELS[this.current.id]} to ${PROVIDER_LABELS[alternative.id]}.`,
    );
    this.current = alternative;
    return true;
  }

  /** Retries 429s and 5xx with backoff; everything else surfaces immediately. */
  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    const { token, onEvent } = this.options;
    let attempt = 0;
    for (;;) {
      try {
        return await operation();
      } catch (err) {
        if (token.isCancellationRequested) throw new LlmCancelledError();
        const retryable = err instanceof LlmHttpError && (err.status === 429 || err.status >= 500);
        if (!retryable || attempt >= MAX_RETRIES) throw err;

        attempt++;
        const httpErr = err as LlmHttpError;

        // A rate limit is the one failure another account can answer
        // immediately, so try that before sleeping. Waiting out a subscription
        // cap can cost minutes of a run that has a step budget to spend.
        if (httpErr.status === 429 && (await this.switchProvider())) continue;

        const waitMs = httpErr.retryAfterSeconds
          ? httpErr.retryAfterSeconds * 1000
          : Math.min(30_000, 1000 * 2 ** attempt);
        const reason = httpErr.status === 429 ? "Rate limited" : "Service error";
        onEvent({
          type: "warning",
          text: `${reason} — retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt}/${MAX_RETRIES}).`,
        });
        log.warn(`${reason} (HTTP ${httpErr.status}); waiting ${waitMs}ms.`);
        await sleep(waitMs);
      }
    }
  }
}

/**
 * Runs `worker` over every item with at most `limit` in flight, returning the
 * results in input order.
 *
 * Workers pull from a shared cursor rather than being sliced into fixed batches,
 * so one slow file read cannot hold up the whole group behind it.
 */
export async function mapWithConcurrency<T, R>(
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
