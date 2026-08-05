import * as vscode from "vscode";
import type { PermissionPolicies, PermissionPolicy } from "./engine/permissions";
import type { McpServerConfig } from "./mcp/client";
import { OPENAI_COMPATIBLE_BASES, type ProviderId } from "./llm/types";

export interface IronBaseConfig {
  provider: ProviderId | "auto";
  model: string;
  ignoreGlobs: string[];
  maxFiles: number;
  maxFileReadBytes: number;
  maxIterations: number;
  /** Steps a build or planning run may take. Coding needs more room than a review. */
  maxBuildIterations: number;
  maxSessionTokens: number;
  /** How long one `run_command` may take before it is stopped. */
  commandTimeoutMs: number;
  /** What the agent may do without asking. Modes may only tighten these. */
  permissions: PermissionPolicies;
  /** MCP servers to connect, keyed by the name their tools are namespaced under. */
  mcpServers: Record<string, McpServerConfig>;
  enableDiagnostics: boolean;
  disabledProviders: ProviderId[];
  /** Google OAuth client for Gemini sign-in; supplied by the user, not shipped. */
  googleClientId: string;
  googleClientSecret: string;
  /** Where the local model server listens. */
  ollamaBaseUrl: string;
  /** Continue on another connected account when one is rate limited. */
  autoFailover: boolean;
}

export function getConfig(): IronBaseConfig {
  const c = vscode.workspace.getConfiguration("ironbase");
  return {
    provider: c.get<IronBaseConfig["provider"]>("provider", "auto"),
    model: c.get<string>("model", "").trim(),
    ignoreGlobs: c.get<string[]>("ignoreGlobs", []),
    maxFiles: c.get<number>("maxFiles", 2000),
    maxFileReadBytes: c.get<number>("maxFileReadBytes", 64000),
    maxIterations: c.get<number>("maxIterations", 40),
    maxBuildIterations: c.get<number>("maxBuildIterations", 80),
    maxSessionTokens: c.get<number>("maxSessionTokens", 500000),
    commandTimeoutMs: Math.max(1000, c.get<number>("commandTimeoutMs", 120000)),
    permissions: {
      edit: policy(c.get<string>("permissions.edit", "ask")),
      command: policy(c.get<string>("permissions.command", "ask")),
    },
    mcpServers: c.get<Record<string, McpServerConfig>>("mcpServers", {}),
    enableDiagnostics: c.get<boolean>("enableDiagnostics", true),
    disabledProviders: c.get<ProviderId[]>("disabledProviders", []),
    googleClientId: c.get<string>("google.clientId", "").trim(),
    googleClientSecret: c.get<string>("google.clientSecret", "").trim(),
    ollamaBaseUrl: c
      .get<string>("ollama.baseUrl", OPENAI_COMPATIBLE_BASES.ollama)
      .trim()
      .replace(/\/+$/, ""),
    autoFailover: c.get<boolean>("autoFailover", true),
  };
}

/**
 * Reads a permission setting, defaulting to the cautious answer.
 *
 * A value this build does not recognise becomes "ask" rather than "allow" — a
 * typo in settings.json should never silently hand over write access.
 */
function policy(value: string): PermissionPolicy {
  return value === "allow" || value === "deny" ? value : "ask";
}

/** Returns the user-supplied Google client, or undefined when unconfigured. */
export function getGoogleClient(): { clientId: string; clientSecret: string } | undefined {
  const config = getConfig();
  if (!config.googleClientId || !config.googleClientSecret) return undefined;
  return {
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
  };
}
