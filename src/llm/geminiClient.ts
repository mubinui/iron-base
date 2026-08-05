import { abortSignalFor, readSse, throwHttpError } from "./sse";
import {
  LlmCancelledError,
  type CancelToken,
  type ChatRequest,
  type ChatTurn,
  type LlmClient,
  type NeutralMessage,
  type ProviderId,
  type StopReason,
  type StreamEvent,
  type ToolCall,
} from "./types";

const CODE_ASSIST_BASE = "https://cloudcode-pa.googleapis.com/v1internal";
const GENERATIVE_LANGUAGE_BASE = "https://generativelanguage.googleapis.com/v1beta";

export type GeminiAuth =
  | { kind: "apiKey"; apiKey: string }
  | {
      kind: "oauth";
      getAccessToken: (forceRefresh?: boolean) => Promise<string>;
      getProjectId: () => Promise<string | undefined>;
    };

export class GeminiClient implements LlmClient {
  constructor(
    readonly id: ProviderId,
    readonly model: string,
    private readonly auth: GeminiAuth,
  ) {}

  async chat(
    req: ChatRequest,
    onEvent: (e: StreamEvent) => void,
    token: CancelToken,
  ): Promise<ChatTurn> {
    try {
      return await this.send(req, onEvent, token, false);
    } catch (err) {
      if (this.auth.kind === "oauth" && isUnauthorized(err)) {
        return await this.send(req, onEvent, token, true);
      }
      throw err;
    }
  }

  private async send(
    req: ChatRequest,
    onEvent: (e: StreamEvent) => void,
    token: CancelToken,
    forceRefresh: boolean,
  ): Promise<ChatTurn> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    let url: string;
    let payload: unknown;

    const inner = {
      systemInstruction: { role: "user", parts: [{ text: req.system }] },
      contents: toGeminiContents(req.messages),
      tools:
        req.tools.length > 0
          ? [
              {
                functionDeclarations: req.tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  parameters: stripUnsupportedSchema(t.inputSchema),
                })),
              },
            ]
          : undefined,
      generationConfig: { maxOutputTokens: req.maxTokens },
    };

    if (this.auth.kind === "oauth") {
      const accessToken = await this.auth.getAccessToken(forceRefresh);
      const project = await this.auth.getProjectId();
      headers["authorization"] = `Bearer ${accessToken}`;
      url = `${CODE_ASSIST_BASE}:streamGenerateContent?alt=sse`;
      payload = { model: req.model, project, request: inner };
    } else {
      headers["x-goog-api-key"] = this.auth.apiKey;
      url = `${GENERATIVE_LANGUAGE_BASE}/models/${encodeURIComponent(
        req.model,
      )}:streamGenerateContent?alt=sse`;
      payload = inner;
    }

    const abort = abortSignalFor(token);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: abort.signal,
      });
    } catch (err) {
      abort.dispose();
      if (token.isCancellationRequested) throw new LlmCancelledError();
      throw err;
    }

    if (!response.ok) {
      abort.dispose();
      await throwHttpError(response);
    }

    try {
      return await this.consumeStream(response, onEvent, token);
    } finally {
      abort.dispose();
    }
  }

  private async consumeStream(
    response: Response,
    onEvent: (e: StreamEvent) => void,
    token: CancelToken,
  ): Promise<ChatTurn> {
    let text = "";
    const toolCalls: ToolCall[] = [];
    let stopReason: StopReason = "end";
    let inputTokens = 0;
    let outputTokens = 0;
    let callCounter = 0;

    for await (const msg of readSse(response, token)) {
      if (msg.data === "[DONE]") break;
      let payload: any;
      try {
        payload = JSON.parse(msg.data);
      } catch {
        continue;
      }
      // The Code Assist endpoint nests the standard response under `response`.
      const chunk = payload.response ?? payload;

      const usage = chunk.usageMetadata;
      if (usage) {
        inputTokens = usage.promptTokenCount ?? inputTokens;
        outputTokens = usage.candidatesTokenCount ?? outputTokens;
      }

      const candidate = chunk.candidates?.[0];
      if (!candidate) continue;

      for (const part of candidate.content?.parts ?? []) {
        if (typeof part.text === "string" && part.text.length > 0) {
          text += part.text;
          onEvent({ type: "text", delta: part.text });
        }
        if (part.functionCall) {
          const name = String(part.functionCall.name ?? "");
          toolCalls.push({
            callId: `gemini_call_${callCounter++}_${name}`,
            name,
            input: part.functionCall.args ?? {},
          });
          onEvent({ type: "toolCallStart", name });
        }
      }

      const finish = candidate.finishReason;
      if (finish) {
        stopReason = mapFinishReason(finish);
      }
    }

    if (toolCalls.length > 0 && stopReason === "end") {
      stopReason = "toolUse";
    }

    onEvent({ type: "usage", inputTokens, outputTokens });
    return { text, toolCalls, stopReason, usage: { inputTokens, outputTokens } };
  }
}

function mapFinishReason(reason: string): StopReason {
  switch (reason) {
    case "MAX_TOKENS":
      return "maxTokens";
    case "SAFETY":
    case "PROHIBITED_CONTENT":
    case "BLOCKLIST":
      return "refusal";
    case "STOP":
      return "end";
    default:
      return "end";
  }
}

function toGeminiContents(messages: NeutralMessage[]): unknown[] {
  const contents: unknown[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      contents.push({ role: "user", parts: [{ text: m.text }] });
    } else if (m.role === "assistant") {
      const parts: unknown[] = [];
      if (m.text) parts.push({ text: m.text });
      for (const call of m.toolCalls ?? []) {
        parts.push({ functionCall: { name: call.name, args: call.input ?? {} } });
      }
      if (parts.length > 0) contents.push({ role: "model", parts });
    } else {
      contents.push({
        role: "user",
        parts: m.results.map((r) => ({
          functionResponse: {
            name: r.name,
            response: r.isError ? { error: r.content } : { result: r.content },
          },
        })),
      });
    }
  }
  return contents;
}

/**
 * Gemini's function-declaration schema subset rejects JSON Schema keywords like
 * `additionalProperties` and `$schema`, so drop them recursively.
 */
function stripUnsupportedSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(stripUnsupportedSchema);
  if (schema === null || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === "additionalProperties" || key === "$schema" || key === "default") {
      continue;
    }
    out[key] = stripUnsupportedSchema(value);
  }
  return out;
}

function isUnauthorized(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status: unknown }).status === 401
  );
}
