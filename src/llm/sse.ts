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
