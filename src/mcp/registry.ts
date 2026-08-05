/**
 * Every MCP server's tools, gathered into one list the agent can use.
 *
 * The registry owns the connections, namespaces the tools so two servers can
 * both have a `search`, and routes a call back to whichever server owns it.
 *
 * Namespacing is the important part. Tool names come from third parties, and
 * without a prefix a server could ship a tool called `edit_file` that quietly
 * shadows the real one — the model would call it believing it was writing to
 * disk. `mcp__<server>__<tool>` makes that impossible and makes it obvious in
 * the transcript where a tool came from.
 *
 * Every MCP call is permission-gated as a command would be. These tools reach
 * outside the workspace by definition: that is what they are for, and it is
 * exactly why they should not run unwatched.
 */

import type { JsonSchemaObject, ToolDef } from "../llm/types";
import { log } from "../util/log";
import { McpConnection, type McpServerConfig } from "./client";

const PREFIX = "mcp__";
/** Tools accepted from one server, so a chatty server cannot swamp the list. */
const MAX_TOOLS_PER_SERVER = 40;

export interface McpToolRoute {
  server: string;
  tool: string;
}

export class McpRegistry {
  private readonly connections = new Map<string, McpConnection>();
  private readonly routes = new Map<string, McpToolRoute>();
  private loading: Promise<void> | undefined;

  get isEmpty(): boolean {
    return this.routes.size === 0;
  }

  get serverNames(): string[] {
    return [...this.connections.keys()];
  }

  /** Human-readable summary for the panel: "2 servers, 11 tools". */
  describe(): string {
    if (this.connections.size === 0) return "";
    const servers = this.connections.size;
    return (
      `${servers} MCP server${servers === 1 ? "" : "s"}, ` +
      `${this.routes.size} tool${this.routes.size === 1 ? "" : "s"}`
    );
  }

  /**
   * Connects everything in settings.
   *
   * Servers start in parallel because a slow one should not hold up the others,
   * and callers share one attempt rather than each triggering their own.
   */
  async load(servers: Record<string, McpServerConfig>): Promise<void> {
    if (this.loading) return await this.loading;
    this.loading = this.connectAll(servers);
    try {
      await this.loading;
    } finally {
      this.loading = undefined;
    }
  }

  private async connectAll(servers: Record<string, McpServerConfig>): Promise<void> {
    this.dispose();
    const entries = Object.entries(servers).filter(([, config]) => config.enabled !== false);
    if (entries.length === 0) return;

    await Promise.all(
      entries.map(async ([name, config]) => {
        const connection = await McpConnection.connect(name, config);
        if (!connection) return;
        this.connections.set(name, connection);

        for (const tool of connection.tools.slice(0, MAX_TOOLS_PER_SERVER)) {
          this.routes.set(qualify(name, tool.name), { server: name, tool: tool.name });
        }
        if (connection.tools.length > MAX_TOOLS_PER_SERVER) {
          log.warn(
            `MCP server "${name}" offers ${connection.tools.length} tools; only the first ${MAX_TOOLS_PER_SERVER} are used.`,
          );
        }
      }),
    );
  }

  /** The tool definitions to add to the agent's list. */
  definitions(): ToolDef[] {
    const out: ToolDef[] = [];
    for (const [name, connection] of this.connections) {
      for (const tool of connection.tools.slice(0, MAX_TOOLS_PER_SERVER)) {
        out.push({
          name: qualify(name, tool.name),
          // The server name is stated in the description as well as the tool
          // name, because a model choosing between two similar tools is reading
          // the descriptions, not parsing the prefix.
          description:
            `[${name}] ${tool.description || "No description was supplied by the server."}`.slice(
              0,
              1400,
            ),
          inputSchema: tool.inputSchema as JsonSchemaObject,
        });
      }
    }
    return out;
  }

  isMcpTool(name: string): boolean {
    return this.routes.has(name);
  }

  routeFor(name: string): McpToolRoute | undefined {
    return this.routes.get(name);
  }

  async call(name: string, args: unknown): Promise<{ content: string; isError: boolean }> {
    const route = this.routes.get(name);
    if (!route) {
      return { content: `No MCP tool is registered as ${name}.`, isError: true };
    }
    const connection = this.connections.get(route.server);
    if (!connection) {
      return {
        content: `The MCP server "${route.server}" is no longer connected. Carry on without it.`,
        isError: true,
      };
    }
    return await connection.callTool(route.tool, args);
  }

  dispose(): void {
    for (const connection of this.connections.values()) connection.dispose();
    this.connections.clear();
    this.routes.clear();
  }
}

/**
 * `mcp__server__tool`, with anything a provider might reject stripped out.
 *
 * Tool names have to match `^[a-zA-Z0-9_-]+$` for several providers, and server
 * authors use dots and slashes freely.
 */
function qualify(server: string, tool: string): string {
  return `${PREFIX}${sanitize(server)}__${sanitize(tool)}`.slice(0, 64);
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "x";
}
