/**
 * A Model Context Protocol client.
 *
 * MCP is how a coding agent reaches things that are not files: an issue
 * tracker, a database schema, a design system's component list. A server
 * exposes tools over JSON-RPC; this connects to one, asks what it has, and
 * calls it.
 *
 * Two transports, because servers ship as one or the other. `stdio` spawns a
 * local process and speaks newline-delimited JSON-RPC over its pipes, which is
 * how nearly every published server works today. `http` posts to a URL and
 * reads either JSON or an SSE stream back.
 *
 * The design rule throughout: a broken server must not break the extension. A
 * server that will not start, hangs, returns nonsense, or dies mid-session
 * degrades to "that server has no tools" and everything else carries on. This
 * is why almost nothing here throws.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { JsonSchemaObject } from "../llm/types";
import { log } from "../util/log";

/** How long a server has to answer `initialize` before it is written off. */
const HANDSHAKE_TIMEOUT_MS = 15_000;
/** Per request. A tool that takes longer than this is not usable interactively. */
const CALL_TIMEOUT_MS = 60_000;
const PROTOCOL_VERSION = "2025-06-18";

export interface StdioServerConfig {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  enabled?: boolean;
}

export interface HttpServerConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export type McpServerConfig = StdioServerConfig | HttpServerConfig;

export interface McpTool {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
}

interface RpcResponse {
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

/** One connected server. Created through `connect`, which never rejects. */
export class McpConnection {
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = "";
  private nextId = 1;
  private readonly waiting = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  private constructor(
    readonly name: string,
    private readonly config: McpServerConfig,
    private _tools: McpTool[] = [],
  ) {}

  get tools(): McpTool[] {
    return this._tools;
  }

  get isStdio(): boolean {
    return this.config.type !== "http";
  }

  /**
   * Starts a server and asks what it can do.
   *
   * Returns undefined rather than throwing on any failure — a missing binary in
   * someone's settings is a normal state of the world, not an exception the
   * build panel should have to handle.
   */
  static async connect(
    name: string,
    config: McpServerConfig,
  ): Promise<McpConnection | undefined> {
    const connection = new McpConnection(name, config);
    try {
      if (config.type === "http") await connection.startHttp();
      else await connection.startStdio(config);
      await connection.handshake();
      connection._tools = await connection.listTools();
      log.info(`MCP server "${name}" connected with ${connection._tools.length} tool(s).`);
      return connection;
    } catch (err) {
      log.warn(`MCP server "${name}" could not be used: ${String(err)}`);
      connection.dispose();
      return undefined;
    }
  }

  async callTool(tool: string, args: unknown): Promise<{ content: string; isError: boolean }> {
    try {
      const result = (await this.request("tools/call", {
        name: tool,
        arguments: args ?? {},
      })) as { content?: unknown; isError?: boolean };
      return {
        content: flattenContent(result?.content) || "(the tool returned nothing)",
        isError: result?.isError === true,
      };
    } catch (err) {
      // Returned as an error result rather than thrown: the model can read this
      // and try something else, which is the useful outcome.
      return { content: `The MCP tool failed: ${String(err)}`, isError: true };
    }
  }

  dispose(): void {
    for (const pending of this.waiting.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("The MCP connection was closed."));
    }
    this.waiting.clear();
    this.child?.kill();
    this.child = undefined;
  }

  // --- Transports ------------------------------------------------------------

  private async startStdio(config: StdioServerConfig): Promise<void> {
    const child = spawn(config.command, config.args ?? [], {
      cwd: config.cwd,
      env: { ...process.env, ...config.env },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    child.on("error", (err) => {
      log.warn(`MCP server "${this.name}" failed to start: ${String(err)}`);
      this.dispose();
    });
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) log.warn(`MCP server "${this.name}" exited with ${code}.`);
      this.child = undefined;
    });
    // Servers use stderr for their own logging, which is worth having when one
    // misbehaves but does not belong in the transcript.
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text.length > 0) log.info(`[mcp:${this.name}] ${text.slice(0, 500)}`);
    });
    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk.toString()));

    this.child = child;
  }

  private async startHttp(): Promise<void> {
    // Nothing to start: each request is its own fetch. The handshake below is
    // what actually establishes that the far end speaks MCP.
  }

  /** Newline-delimited JSON, reassembled across chunk boundaries. */
  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) this.onMessage(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private onMessage(line: string): void {
    let message: RpcResponse;
    try {
      message = JSON.parse(line) as RpcResponse;
    } catch {
      return; // Not JSON-RPC; servers occasionally print banners.
    }
    if (typeof message.id !== "number") return; // A notification, not our reply.

    const pending = this.waiting.get(message.id);
    if (!pending) return;
    this.waiting.delete(message.id);
    clearTimeout(pending.timer);

    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  }

  // --- JSON-RPC --------------------------------------------------------------

  private async request(method: string, params: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
    return this.config.type === "http"
      ? await this.httpRequest(method, params, timeoutMs)
      : await this.stdioRequest(method, params, timeoutMs);
  }

  private stdioRequest(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const child = this.child;
    if (!child) return Promise.reject(new Error("The MCP server is not running."));

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private async httpRequest(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const config = this.config as HttpServerConfig;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(config.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...config.headers,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} from ${config.url}`);
      }
      const body = await response.text();
      const parsed = parseHttpBody(body);
      if (parsed.error) throw new Error(parsed.error.message);
      return parsed.result;
    } finally {
      clearTimeout(timer);
    }
  }

  private async handshake(): Promise<void> {
    await this.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        clientInfo: { name: "ironbase", version: "0.6.0" },
      },
      HANDSHAKE_TIMEOUT_MS,
    );
    // Required by the spec after a successful initialize. Fire and forget: it
    // takes no reply, and a server that ignores it still works.
    if (this.child) {
      this.child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
    }
  }

  private async listTools(): Promise<McpTool[]> {
    const result = (await this.request("tools/list", {}, HANDSHAKE_TIMEOUT_MS)) as {
      tools?: unknown;
    };
    if (!Array.isArray(result?.tools)) return [];

    return result.tools
      .filter((tool): tool is Record<string, unknown> => typeof tool === "object" && tool !== null)
      .map((tool) => ({
        name: String(tool.name ?? ""),
        description: String(tool.description ?? "").slice(0, 1200),
        inputSchema: normalizeSchema(tool.inputSchema),
      }))
      .filter((tool) => tool.name.length > 0);
  }
}

/**
 * An SSE body carries the JSON-RPC reply inside `data:` lines; a plain JSON body
 * is the reply. Servers choose per response, so both are handled.
 */
function parseHttpBody(body: string): RpcResponse {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as RpcResponse;

  for (const line of trimmed.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload.length === 0 || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload) as RpcResponse;
      if (parsed.result !== undefined || parsed.error) return parsed;
    } catch {
      /* keep looking */
    }
  }
  throw new Error("The server's reply was not JSON-RPC.");
}

/**
 * Coerces a server's schema into the shape every provider will accept.
 *
 * Schemas come from third-party servers and are frequently not quite valid —
 * missing `type`, `properties` as an array, `required` as a string. A provider
 * rejects the whole request over one of those, taking the other servers' tools
 * down with it, so anything unusable becomes an empty object schema.
 */
function normalizeSchema(schema: unknown): JsonSchemaObject {
  if (typeof schema !== "object" || schema === null) {
    return { type: "object", properties: {} };
  }
  const raw = schema as Record<string, unknown>;
  const properties =
    typeof raw.properties === "object" && raw.properties !== null && !Array.isArray(raw.properties)
      ? (raw.properties as Record<string, unknown>)
      : {};
  const required = Array.isArray(raw.required)
    ? raw.required.filter((r): r is string => typeof r === "string")
    : undefined;

  return { ...raw, type: "object", properties, ...(required ? { required } : {}) };
}

/** MCP content blocks flattened to the text a model can read. */
function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (typeof block !== "object" || block === null) continue;
    const item = block as Record<string, unknown>;
    if (typeof item.text === "string") parts.push(item.text);
    else if (item.type === "image") parts.push("[an image, which cannot be shown here]");
    else if (typeof item.resource === "object" && item.resource !== null) {
      const resource = item.resource as Record<string, unknown>;
      parts.push(String(resource.text ?? resource.uri ?? "[a resource]"));
    }
  }
  return parts.join("\n").trim();
}
