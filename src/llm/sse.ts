import { LlmCancelledError, LlmHttpError, type CancelToken } from "./types";

export interface SseMessage {
  event?: string;
  data: string;
}

/**
 * Reads an SSE body, yielding one message per blank-line-delimited block.
 * Multi-line `data:` fields are joined with newlines, per the SSE spec.
 */
export async function* readSse(
  response: Response,
  token: CancelToken,
): AsyncGenerator<SseMessage> {
  if (!response.body) {
    throw new Error("Response has no body to stream");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (token.isCancellationRequested) {
        throw new LlmCancelledError();
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      // Blocks are separated by a blank line; tolerate CRLF.
      while ((sep = findBlockEnd(buffer)) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^(\r?\n){2}/, "");
        const msg = parseBlock(raw);
        if (msg) yield msg;
      }
    }
    const tail = parseBlock(buffer);
    if (tail) yield tail;
  } finally {
    reader.cancel().catch(() => {
      /* stream already closed */
    });
  }
}

function findBlockEnd(buffer: string): number {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

function parseBlock(raw: string): SseMessage | undefined {
  const lines = raw.split(/\r?\n/);
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith(":")) continue; // comment / heartbeat
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (dataLines.length === 0) return undefined;
  return { event, data: dataLines.join("\n") };
}

/** Turns a non-2xx response into an LlmHttpError carrying retry-after when present. */
export async function throwHttpError(response: Response): Promise<never> {
  const body = await response.text().catch(() => "");
  const retryAfterRaw = response.headers.get("retry-after");
  const retryAfter = retryAfterRaw ? Number(retryAfterRaw) : undefined;
  throw new LlmHttpError(
    response.status,
    body,
    Number.isFinite(retryAfter) ? retryAfter : undefined,
  );
}

/**
 * Whether a body is an HTML document rather than the JSON we asked for.
 *
 * This is the shape a Cloudflare interstitial, a login wall, or an SPA's
 * 404-fallback `index.html` takes — all of which a provider can return with a
 * 200 status, which is exactly why checking `response.ok` is not enough. Catching
 * it here is what turns `Unexpected token '<', "<!DOCTYPE"…` — a raw parser error
 * the user can do nothing with — into a sentence that names what happened.
 */
export function looksLikeHtml(body: string): boolean {
  return /^\s*(<!doctype html|<html[\s>]|<head[\s>]|<!--)/i.test(body);
}

/**
 * Reads a response body as JSON, or fails with an error worth reading.
 *
 * `response.json()` throws a bare `SyntaxError` the instant a body is not JSON,
 * and at a provider boundary that body is routinely an HTML challenge page rather
 * than the API's own error envelope. This reads the text once, and on a parse
 * failure raises an `LlmHttpError` that says whether it looked like an
 * anti-automation page and quotes a short snippet — so the failure is
 * diagnosable instead of cryptic. `label` names the provider in that message.
 */
export async function readJsonBody<T>(response: Response, label: string): Promise<T> {
  const body = await response.text().catch(() => "");
  try {
    return JSON.parse(body) as T;
  } catch {
    const snippet = body.trim().slice(0, 200).replace(/\s+/g, " ");
    const reason = looksLikeHtml(body)
      ? `${label} returned an HTML page instead of JSON — usually an anti-automation ` +
        `challenge or a signed-out session, not the API.`
      : `${label} returned a response that was not JSON.`;
    throw new LlmHttpError(response.status, `${reason}${snippet ? ` (${snippet}…)` : ""}`);
  }
}

/** Bridges a VS Code CancellationToken to fetch's AbortSignal. */
export function abortSignalFor(token: CancelToken): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  if (token.isCancellationRequested) {
    controller.abort();
  }
  const sub = token.onCancellationRequested(() => controller.abort());
  return {
    signal: controller.signal,
    dispose: () => sub.dispose(),
  };
}
