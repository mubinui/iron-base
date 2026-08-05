import * as vscode from "vscode";
import { getConfig } from "../config";
import { AnthropicClient } from "../llm/anthropicClient";
import { CodexClient } from "../llm/codexClient";
import { GeminiClient } from "../llm/geminiClient";
import {
  ALL_PROVIDERS,
  DEFAULT_MODELS,
  PROVIDER_LABELS,
  type LlmClient,
  type ProviderId,
} from "../llm/types";
import { AnthropicOAuth } from "./anthropicOAuth";
import { GoogleOAuth } from "./googleOAuth";
import { OpenAiOAuth } from "./openaiOAuth";
import { SecretStore } from "./secretStore";

/** Order used when `ironbase.provider` is "auto". */
const AUTO_ORDER: ProviderId[] = ["anthropic-oauth", "chatgpt-oauth", "gemini-oauth"];

export class AuthManager {
  readonly store: SecretStore;
  readonly anthropic: AnthropicOAuth;
  readonly openai: OpenAiOAuth;
  readonly google: GoogleOAuth;

  private readonly onChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onChangeEmitter.event;

  constructor(context: vscode.ExtensionContext) {
    this.store = new SecretStore(context.secrets);
    this.anthropic = new AnthropicOAuth(this.store);
    this.openai = new OpenAiOAuth(this.store, context.globalState);
    this.google = new GoogleOAuth(this.store, context.globalState);
    context.subscriptions.push(
      this.store.onDidChange(() => this.onChangeEmitter.fire()),
      this.onChangeEmitter,
    );
  }

  private isDisabled(id: ProviderId): boolean {
    return getConfig().disabledProviders.includes(id);
  }

  async availableProviders(): Promise<ProviderId[]> {
    const available: ProviderId[] = [];
    for (const id of ALL_PROVIDERS) {
      if (this.isDisabled(id)) continue;
      if (await this.hasCredential(id)) available.push(id);
    }
    return available;
  }

  async hasCredential(id: ProviderId): Promise<boolean> {
    switch (id) {
      case "anthropic-oauth":
        return this.anthropic.isSignedIn();
      case "chatgpt-oauth":
        return this.openai.isSignedIn();
      case "gemini-oauth":
        return this.google.isSignedIn();
    }
  }

  /** Resolves the client to run with, or undefined when nothing is signed in. */
  async getActiveClient(): Promise<LlmClient | undefined> {
    const config = getConfig();
    if (config.provider !== "auto") {
      if (this.isDisabled(config.provider)) return undefined;
      if (!(await this.hasCredential(config.provider))) return undefined;
      return this.build(config.provider, config.model);
    }
    for (const id of AUTO_ORDER) {
      if (this.isDisabled(id)) continue;
      if (await this.hasCredential(id)) return this.build(id, config.model);
    }
    return undefined;
  }

  async describeActive(): Promise<string> {
    const client = await this.getActiveClient();
    return client ? PROVIDER_LABELS[client.id] : "not signed in";
  }

  private build(id: ProviderId, modelOverride: string): LlmClient {
    const model = modelOverride || DEFAULT_MODELS[id];
    switch (id) {
      case "anthropic-oauth":
        return new AnthropicClient(id, model, {
          kind: "oauth",
          getAccessToken: (force) => this.anthropic.getAccessToken(force),
        });
      case "chatgpt-oauth":
        return new CodexClient(
          model,
          (force) => this.openai.getAccessToken(force),
          () => this.openai.getAccountId(),
        );
      case "gemini-oauth":
        return new GeminiClient(id, model, {
          kind: "oauth",
          getAccessToken: (force) => this.google.getAccessToken(force),
          getProjectId: () => this.google.getProjectId(),
        });
    }
  }

  async signOut(id: ProviderId): Promise<void> {
    switch (id) {
      case "anthropic-oauth":
        await this.anthropic.signOut();
        break;
      case "chatgpt-oauth":
        await this.openai.signOut();
        break;
      case "gemini-oauth":
        await this.google.signOut();
        break;
    }
  }

  async signOutAll(): Promise<void> {
    await this.google.signOut();
    await this.openai.signOut();
    await this.store.clearAll();
  }
}
