import * as vscode from "vscode";
import { getConfig } from "../config";
import { AnthropicClient } from "../llm/anthropicClient";
import { CodexClient } from "../llm/codexClient";
import { GeminiClient } from "../llm/geminiClient";
import {
  listOpenAiCompatibleModels,
  OpenAiCompatibleClient,
} from "../llm/openAiCompatibleClient";
import {
  ALL_PROVIDERS,
  DEFAULT_MODELS,
  OPENAI_COMPATIBLE_BASES,
  PROVIDER_CREDENTIALS,
  PROVIDER_LABELS,
  type LlmClient,
  type ProviderId,
} from "../llm/types";
import { log } from "../util/log";
import { AnthropicOAuth } from "./anthropicOAuth";
import { GoogleOAuth } from "./googleOAuth";
import { OpenAiOAuth } from "./openaiOAuth";
import { SecretStore } from "./secretStore";

/** Order used when `ironbase.provider` is "auto". */
const AUTO_ORDER: ProviderId[] = [
  "anthropic-oauth",
  "chatgpt-oauth",
  "gemini-oauth",
  "kimi",
  "deepseek",
  "ollama",
];

/** Caches whichever Codex model this ChatGPT account turned out to allow. */
const CHATGPT_MODEL_KEY = "ironbase.chatgpt.model";
/** Per-provider model choice, so switching provider does not lose the model. */
const MODEL_KEY_PREFIX = "ironbase.model.";

export class AuthManager {
  readonly store: SecretStore;
  readonly anthropic: AnthropicOAuth;
  readonly openai: OpenAiOAuth;
  readonly google: GoogleOAuth;
  private readonly globalState: vscode.Memento;

  private readonly onChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onChangeEmitter.event;

  constructor(context: vscode.ExtensionContext) {
    this.globalState = context.globalState;
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
      case "kimi":
        return (await this.store.getString("kimiKey")) !== undefined;
      case "deepseek":
        return (await this.store.getString("deepseekKey")) !== undefined;
      case "ollama":
        // A local server counts as connected only while it is actually running,
        // otherwise every run would start by failing to reach it.
        return this.isOllamaRunning();
    }
  }

  /** Stores an API key and makes that provider active. */
  async setApiKey(id: "kimi" | "deepseek", key: string): Promise<void> {
    await this.store.setString(id === "kimi" ? "kimiKey" : "deepseekKey", key.trim());
    log.info(`Stored the ${PROVIDER_LABELS[id]} API key.`);
  }

  private async apiKeyFor(id: ProviderId): Promise<string | undefined> {
    if (id === "kimi") return this.store.getString("kimiKey");
    if (id === "deepseek") return this.store.getString("deepseekKey");
    return undefined;
  }

  private async isOllamaRunning(): Promise<boolean> {
    const base = getConfig().ollamaBaseUrl;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1200);
      const response = await fetch(`${base}/models`, { signal: controller.signal });
      clearTimeout(timer);
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Resolves the client to run with, or undefined when nothing is connected. */
  async getActiveClient(): Promise<LlmClient | undefined> {
    const config = getConfig();
    if (config.provider !== "auto") {
      if (this.isDisabled(config.provider)) return undefined;
      if (!(await this.hasCredential(config.provider))) return undefined;
      return this.build(config.provider, this.modelFor(config.provider, config.model));
    }
    for (const id of AUTO_ORDER) {
      if (this.isDisabled(id)) continue;
      if (await this.hasCredential(id)) return this.build(id, this.modelFor(id, config.model));
    }
    return undefined;
  }

  /**
   * The model to use for one provider.
   *
   * `ironbase.model` is a single setting, so it only applies to the provider it
   * was chosen for; a Claude model id sent to DeepSeek is a guaranteed 400.
   * Per-provider choices live in workspace state, which is what lets switching
   * provider mid-session keep each one's model.
   */
  private modelFor(id: ProviderId, globalOverride: string): string {
    const config = getConfig();
    if (globalOverride.length > 0 && config.provider === id) return globalOverride;
    return this.globalState.get<string>(MODEL_KEY_PREFIX + id) ?? DEFAULT_MODELS[id];
  }

  async setModel(id: ProviderId, model: string): Promise<void> {
    await this.globalState.update(MODEL_KEY_PREFIX + id, model || undefined);
    this.onChangeEmitter.fire();
  }

  /** The models this provider can actually offer right now. */
  async listModels(id: ProviderId): Promise<string[]> {
    if (PROVIDER_CREDENTIALS[id] !== "apiKey" && id !== "ollama") return [];
    const base = id === "ollama" ? getConfig().ollamaBaseUrl : OPENAI_COMPATIBLE_BASES[id as "kimi" | "deepseek"];
    try {
      return await listOpenAiCompatibleModels(base, await this.apiKeyFor(id));
    } catch (err) {
      log.warn(`Could not list ${PROVIDER_LABELS[id]} models: ${String(err)}`);
      return [];
    }
  }

  async describeActive(): Promise<string> {
    const client = await this.getActiveClient();
    return client ? PROVIDER_LABELS[client.id] : "not connected";
  }

  /**
   * Builds a client for one provider without touching settings.
   *
   * Used by mid-run failover, which needs a different provider for the next
   * request while leaving the user's chosen default exactly as it was.
   */
  async clientFor(id: ProviderId): Promise<LlmClient | undefined> {
    if (this.isDisabled(id) || !(await this.hasCredential(id))) return undefined;
    return this.build(id, this.modelFor(id, ""));
  }

  /**
   * Another connected account to continue a rate-limited review on.
   *
   * Walks the same fixed order the picker uses, wrapping around, so the choice
   * is predictable rather than "whichever happened to be next in a Set". Returns
   * nothing when only one account is connected, which is the common case and
   * simply means the run backs off and waits instead.
   */
  async nextConnectedAfter(exclude: ProviderId): Promise<LlmClient | undefined> {
    const start = AUTO_ORDER.indexOf(exclude);
    for (let step = 1; step <= AUTO_ORDER.length; step++) {
      const id = AUTO_ORDER[(start + step) % AUTO_ORDER.length];
      if (id === exclude || this.isDisabled(id)) continue;
      if (await this.hasCredential(id)) return this.build(id, this.modelFor(id, ""));
    }
    return undefined;
  }

  private build(id: ProviderId, model: string): LlmClient {
    const config = getConfig();
    switch (id) {
      case "anthropic-oauth":
        return new AnthropicClient(id, model, {
          kind: "oauth",
          getAccessToken: (force) => this.anthropic.getAccessToken(force),
        });
      case "chatgpt-oauth": {
        // A previously negotiated model is tried first, so the ladder is walked
        // once per account rather than on every run.
        const pinned = config.model.length > 0 && config.provider === id;
        const remembered = this.globalState.get<string>(CHATGPT_MODEL_KEY);
        return new CodexClient(
          pinned ? model : (remembered ?? model),
          (force) => this.openai.getAccessToken(force),
          () => this.openai.getAccountId(),
          pinned,
          (winner) => void this.globalState.update(CHATGPT_MODEL_KEY, winner),
        );
      }
      case "gemini-oauth":
        return new GeminiClient(id, model, {
          kind: "oauth",
          getAccessToken: (force) => this.google.getAccessToken(force),
          getProjectId: () => this.google.getProjectId(),
        });
      case "kimi":
      case "deepseek":
        return new OpenAiCompatibleClient(id, model, {
          baseUrl: OPENAI_COMPATIBLE_BASES[id],
          label: PROVIDER_LABELS[id],
          getApiKey: () => this.apiKeyFor(id),
        });
      case "ollama":
        return new OpenAiCompatibleClient(id, model, {
          baseUrl: config.ollamaBaseUrl,
          label: PROVIDER_LABELS[id],
          maxTokensCap: 8000,
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
      case "kimi":
        await this.store.clear("kimiKey");
        break;
      case "deepseek":
        await this.store.clear("deepseekKey");
        break;
      case "ollama":
        // Nothing is stored for a local server.
        break;
    }
  }

  async signOutAll(): Promise<void> {
    await this.google.signOut();
    await this.openai.signOut();
    await this.store.clearAll();
  }
}
