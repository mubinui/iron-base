import * as vscode from "vscode";
import type { ProviderId } from "./llm/types";

export interface IronBaseConfig {
  provider: ProviderId | "auto";
  model: string;
  ignoreGlobs: string[];
  maxFiles: number;
  maxFileReadBytes: number;
  maxIterations: number;
  maxSessionTokens: number;
  enableDiagnostics: boolean;
  disabledProviders: ProviderId[];
  /** Google OAuth client for Gemini sign-in; supplied by the user, not shipped. */
  googleClientId: string;
  googleClientSecret: string;
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
    maxSessionTokens: c.get<number>("maxSessionTokens", 500000),
    enableDiagnostics: c.get<boolean>("enableDiagnostics", true),
    disabledProviders: c.get<ProviderId[]>("disabledProviders", []),
    googleClientId: c.get<string>("google.clientId", "").trim(),
    googleClientSecret: c.get<string>("google.clientSecret", "").trim(),
  };
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
