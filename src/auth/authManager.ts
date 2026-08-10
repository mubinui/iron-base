import * as vscode from "vscode";
import { getConfig } from "../config";
import { AnthropicClient } from "../llm/anthropicClient";
import { ChatGptWebClient } from "../llm/chatgptWebClient";
import { BrowserWebClient, browserAdapterFor } from "../llm/browserWebClient";
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
  OPENCODE_HEADERS,
  PROVIDERS_BY_TIER,
  PROVIDER_CREDENTIALS,
  PROVIDER_LABELS,
  PROVIDER_METHODS,
  isFreeOpenCodeModel,
  isOpenAiCompatible,
  supportsMethod,
  type AuthMethod,
  type LlmClient,
  type OpenAiCompatibleProvider,
  type ProviderId,
} from "../llm/types";
import { sessionConfigFor } from "../llm/webSessions";
import { log } from "../util/log";
import { AnthropicOAuth } from "./anthropicOAuth";
import type { BrowserSession } from "./browserSession";
import { GoogleOAuth } from "./googleOAuth";
import { OpenAiOAuth } from "./openaiOAuth";
import { SecretStore, type SecretKey, type WebSession } from "./secretStore";

/** Providers that authenticate with a pasted key. */
export type ApiKeyProvider = Exclude<
  ProviderId,
  "anthropic-oauth" | "chatgpt-oauth" | "gemini-oauth" | "opencode" | "ollama"
>;

/** The keychain entry holding one provider's API key. */
function secretKeyFor(id: ApiKeyProvider): SecretKey {
  return `${id}Key` as SecretKey;
}

/**
 * Order used when `ironbase.provider` is "auto", and when a rate-limited run
 * goes looking for somewhere to continue.
 *
 * Cheapest-last rather than declaration order: a free endpoint that is always
 * reachable would otherwise be able to outrank the subscription the user is
 * already paying for, and silently downgrade every run.
 */
const AUTO_ORDER: ProviderId[] = [...PROVIDERS_BY_TIER];

/** Caches whichever Codex model this ChatGPT account turned out to allow. */
const CHATGPT_MODEL_KEY = "ironbase.chatgpt.model";
/** Per-provider model choice, so switching provider does not lose the model. */
const MODEL_KEY_PREFIX = "ironbase.model.";
/** Set once the user has agreed to a no-account provider being used. */
const FREE_OPT_IN_PREFIX = "ironbase.freeTier.";
/** Per-provider override of which stored credential to prefer. */
const AUTH_METHOD_PREFIX = "ironbase.authMethod.";

/**
 * Which stored credential a provider is going to be reached with.
 *
 * Resolved rather than assumed, because a provider can now hold more than one
 * at a time: a key you pasted months ago and a session you signed in for this
 * morning are both valid, and they behave differently enough — expiry, tool
 * calling, rate limits — that the rest of the code needs to know which is live.
 */
export interface ResolvedCredential {
  method: AuthMethod;
  /** The bearer string, for the two methods that carry one directly. */
  secret?: string;
  /** Set for `webSession`, so callers can report staleness. */
  session?: WebSession;
}

/**
 * Backends whose catalogue is whatever their owner happens to have, rather than
 * a list that can be shipped. Asking them beats guessing — see `resolveModel`.
 */
const CATALOGUE_BACKED: ReadonlySet<ProviderId> = new Set<ProviderId>([
  "ollama",
  "router",
  "opencode",
]);

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
    return (await this.resolveCredential(id)) !== undefined;
  }

  /**
   * Picks which of a provider's stored credentials to use.
   *
   * Walks `PROVIDER_METHODS[id]`, which is ordered most-durable first, and takes
   * the first one that is actually present. The user can pin a different method
   * per provider — that choice is honoured first, and falls through if whatever
   * they pinned has since been cleared, because a stale preference should not be
   * able to disconnect an account that still has a working credential.
   */
  async resolveCredential(id: ProviderId): Promise<ResolvedCredential | undefined> {
    const preferred = this.authMethodOverride(id);
    const order = preferred
      ? [preferred, ...PROVIDER_METHODS[id].filter((m) => m !== preferred)]
      : PROVIDER_METHODS[id];

    for (const method of order) {
      const resolved = await this.credentialFor(id, method);
      if (resolved) return resolved;
    }
    return undefined;
  }

  /** Whether one specific method is currently connected for this provider. */
  private async credentialFor(
    id: ProviderId,
    method: AuthMethod,
  ): Promise<ResolvedCredential | undefined> {
    if (!supportsMethod(id, method)) return undefined;

    switch (method) {
      case "oauth": {
        const signedIn =
          id === "anthropic-oauth"
            ? await this.anthropic.isSignedIn()
            : id === "chatgpt-oauth"
              ? await this.openai.isSignedIn()
              : id === "gemini-oauth"
                ? await this.google.isSignedIn()
                : false;
        return signedIn ? { method } : undefined;
      }
      case "apiKey": {
        const secret = await this.apiKeyFor(id);
        return secret ? { method, secret } : undefined;
      }
      case "webSession": {
        const session = await this.store.getSession(id);
        return session ? { method, secret: session.token, session } : undefined;
      }
      case "free":
        // Nothing is stored, so "connected" can only mean the user said yes.
        // Treating a keyless endpoint as always-on would quietly enrol every
        // install into sending its code to a third party.
        return this.isFreeTierEnabled(id) ? { method } : undefined;
      case "local":
        // A local server counts as connected only while it is actually running,
        // otherwise every run would start by failing to reach it.
        return (await this.isListening(this.localBaseUrl(id), id === "router"))
          ? { method }
          : undefined;
    }
  }

  /** The method the user pinned for this provider, if they pinned one. */
  authMethodOverride(id: ProviderId): AuthMethod | undefined {
    const stored = this.globalState.get<AuthMethod>(AUTH_METHOD_PREFIX + id);
    return stored && supportsMethod(id, stored) ? stored : undefined;
  }

  async setAuthMethodOverride(id: ProviderId, method: AuthMethod | undefined): Promise<void> {
    await this.globalState.update(AUTH_METHOD_PREFIX + id, method);
    this.onChangeEmitter.fire();
  }

  /** Stores a session captured from a provider's own web login. */
  async setWebSession(id: ProviderId, session: WebSession): Promise<void> {
    await this.store.setSession(id, session);
    log.info(`Captured a ${PROVIDER_LABELS[id]} web session.`);
  }

  /** Whether the user has opted this no-account provider in. */
  isFreeTierEnabled(id: ProviderId): boolean {
    return this.globalState.get<boolean>(FREE_OPT_IN_PREFIX + id) === true;
  }

  /** Records the opt-in, which is all "connecting" a free provider amounts to. */
  async setFreeTierEnabled(id: ProviderId, enabled: boolean): Promise<void> {
    await this.globalState.update(FREE_OPT_IN_PREFIX + id, enabled || undefined);
    this.onChangeEmitter.fire();
  }

  /** Stores an API key for any key-based provider. */
  async setApiKey(id: ApiKeyProvider, key: string): Promise<void> {
    await this.store.setString(secretKeyFor(id), key.trim());
    log.info(`Stored the ${PROVIDER_LABELS[id]} API key.`);
  }

  private async apiKeyFor(id: ProviderId): Promise<string | undefined> {
    // The router is reached like a local server but may still want a key, so it
    // is the one provider that has one without being an `apiKey` provider.
    if (id === "router") return this.store.getString("routerKey");
    if (!supportsMethod(id, "apiKey")) return undefined;
    return this.store.getString(secretKeyFor(id as ApiKeyProvider));
  }

  /**
   * The bearer string to send for this provider right now.
   *
   * Resolved per request rather than captured at construction, which is what
   * lets a key pasted — or a session signed in for — mid-run take effect on the
   * very next call instead of after a restart. Returns nothing for the local and
   * keyless providers, and no auth header is then sent at all.
   */
  private async bearerFor(id: ProviderId): Promise<string | undefined> {
    return (await this.resolveCredential(id))?.secret;
  }

  /** Where a server the user runs is expected to be listening. */
  private localBaseUrl(id: ProviderId): string {
    const config = getConfig();
    return id === "router" ? config.routerBaseUrl : config.ollamaBaseUrl;
  }

  /**
   * Whether something is answering there.
   *
   * `anyStatusCounts` is for the router: one configured to require a key
   * answers 401 to an unauthenticated catalogue request, and that is a router
   * that is up rather than one that is missing. Ollama gets the stricter check,
   * where only a 200 rules out something unrelated holding the port.
   */
  private async isListening(base: string, anyStatusCounts: boolean): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1200);
      const response = await fetch(`${base}/models`, { signal: controller.signal });
      clearTimeout(timer);
      return anyStatusCounts || response.ok;
    } catch {
      return false;
    }
  }

  /** Resolves the client to run with, or undefined when nothing is connected. */
  async getActiveClient(): Promise<LlmClient | undefined> {
    const config = getConfig();
    if (config.provider !== "auto") {
      if (this.isDisabled(config.provider)) return undefined;
      const resolved = await this.resolveCredential(config.provider);
      if (!resolved) return undefined;
      return this.build(
        config.provider,
        await this.resolveModel(config.provider, this.modelFor(config.provider, config.model)),
        resolved.method,
      );
    }
    for (const id of AUTO_ORDER) {
      if (this.isDisabled(id)) continue;
      const resolved = await this.resolveCredential(id);
      if (resolved) {
        return this.build(
          id,
          await this.resolveModel(id, this.modelFor(id, config.model)),
          resolved.method,
        );
      }
    }
    return undefined;
  }

  /**
   * Last check before a model id goes over the wire.
   *
   * Only the catalogue-backed backends need it, and for the same reason: what
   * they serve is whatever the user pulled, connected to their router, or what
   * OpenCode is giving away this month, so a default that ships with the
   * extension is a 404 more often than not. Asking costs one request and turns
   * "model not found" into a run that happens.
   */
  private async resolveModel(id: ProviderId, model: string): Promise<string> {
    if (!CATALOGUE_BACKED.has(id)) return model;
    const available = await this.listModels(id);
    if (available.length === 0 || available.includes(model)) return model;
    const substitute = preferredModel(available);
    log.warn(`${PROVIDER_LABELS[id]} has no "${model}"; using "${substitute}" instead.`);
    return substitute;
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
    if (!isOpenAiCompatible(id)) return [];
    try {
      const models = await listOpenAiCompatibleModels(
        this.baseUrlFor(id),
        await this.apiKeyFor(id),
        id === "opencode" ? OPENCODE_HEADERS : undefined,
      );
      // OpenCode advertises its paid catalogue on the same endpoint. Offering a
      // model this provider has no way to pay for is a 401 at the worst moment.
      return id === "opencode" ? models.filter(isFreeOpenCodeModel) : models;
    } catch (err) {
      log.warn(`Could not list ${PROVIDER_LABELS[id]} models: ${String(err)}`);
      return [];
    }
  }

  /** Where one OpenAI-dialect provider lives, honouring the two settable ones. */
  private baseUrlFor(id: OpenAiCompatibleProvider): string {
    if (id === "ollama" || id === "router") return this.localBaseUrl(id);
    return OPENAI_COMPATIBLE_BASES[id];
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
    if (this.isDisabled(id)) return undefined;
    const resolved = await this.resolveCredential(id);
    if (!resolved) return undefined;
    return this.build(id, await this.resolveModel(id, this.modelFor(id, "")), resolved.method);
  }

  /**
   * Another connected account to continue a rate-limited review on.
   *
   * Walks the same tiered order the picker uses, wrapping around, so the choice
   * is predictable rather than "whichever happened to be next in a Set", and so
   * a run that falls off a subscription lands on a metered key before it lands
   * on a free endpoint. Returns nothing when only one account is connected,
   * which is the common case and simply means the run backs off and waits.
   */
  async nextConnectedAfter(exclude: ProviderId): Promise<LlmClient | undefined> {
    const start = AUTO_ORDER.indexOf(exclude);
    // Providers reached by a captured session are held back for a second pass.
    // A session expires in hours and often has no native tool calling, so
    // falling onto one while a pasted key is still available further down the
    // order would quietly downgrade the run.
    const deferred: ProviderId[] = [];

    for (let step = 1; step <= AUTO_ORDER.length; step++) {
      const id = AUTO_ORDER[(start + step) % AUTO_ORDER.length];
      if (id === exclude || this.isDisabled(id)) continue;
      const resolved = await this.resolveCredential(id);
      if (!resolved) continue;
      if (resolved.method === "webSession") {
        deferred.push(id);
        continue;
      }
      return this.build(id, await this.resolveModel(id, this.modelFor(id, "")), resolved.method);
    }

    for (const id of deferred) {
      const resolved = await this.resolveCredential(id);
      return this.build(id, await this.resolveModel(id, this.modelFor(id, "")), resolved?.method);
    }
    return undefined;
  }

  /** The browser host used for providers whose backend must be reached in-page. */
  private browser: BrowserSession | undefined;

  attachBrowserSession(session: BrowserSession): void {
    this.browser = session;
  }

  private build(id: ProviderId, model: string, method?: AuthMethod): LlmClient {
    // A session reached through the live browser is a different client entirely
    // from the same provider on a pasted key, so this fork comes before the
    // per-provider switch, which still assumes one client per id.
    if (method === "webSession" && sessionConfigFor(id)?.transport === "browser") {
      if (!this.browser) {
        throw new Error("The browser session is not ready yet. Try again in a moment.");
      }
      return new BrowserWebClient(id, model, {
        session: this.browser,
        adapter: browserAdapterFor(id),
      });
    }

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
      case "chatgpt-web":
        return new ChatGptWebClient(id, model, {
          // Prefers a captured session over a pasted one, which is the whole
          // point of this provider now: the token it wants is exactly what a
          // sign-in leaves behind.
          getAccessToken: () => this.bearerFor(id),
        });
      case "ollama":
        return new OpenAiCompatibleClient(id, model, {
          baseUrl: config.ollamaBaseUrl,
          label: PROVIDER_LABELS[id],
          maxTokensCap: 8000,
        });
      case "router":
        return new OpenAiCompatibleClient(id, model, {
          baseUrl: config.routerBaseUrl,
          label: PROVIDER_LABELS[id],
          // Only sent if one was stored; a router without REQUIRE_API_KEY set
          // takes the request unauthenticated.
          getApiKey: () => this.apiKeyFor(id),
        });
      case "opencode":
        return new OpenAiCompatibleClient(id, model, {
          baseUrl: OPENAI_COMPATIBLE_BASES.opencode,
          label: PROVIDER_LABELS[id],
          headers: OPENCODE_HEADERS,
          // The free models are small and get slower the longer the reply, so
          // they get the same shorter budget a local model does.
          maxTokensCap: 8000,
        });
      default:
        // Every remaining backend speaks the OpenAI dialect, so adding one is a
        // row in OPENAI_COMPATIBLE_BASES rather than a new case here.
        return new OpenAiCompatibleClient(id, model, {
          baseUrl: OPENAI_COMPATIBLE_BASES[id as OpenAiCompatibleProvider],
          label: PROVIDER_LABELS[id],
          // Whichever credential resolved — a pasted key or a captured session
          // are the same thing on the wire.
          getApiKey: () => this.bearerFor(id),
        });
    }
  }

  /**
   * Disconnects a provider entirely — every method, not just the live one.
   *
   * Clearing only the credential that happened to resolve would leave the
   * account still connected through another method, which is not what
   * "disconnect" means to the person clicking it.
   */
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
      case "ollama":
        // Nothing is stored for a local server.
        break;
      case "opencode":
        await this.setFreeTierEnabled(id, false);
        break;
      default:
        await this.store.clear(secretKeyFor(id as ApiKeyProvider));
        break;
    }
    if (supportsMethod(id, "webSession")) await this.store.clearSession(id);
    await this.setAuthMethodOverride(id, undefined);
  }

  async signOutAll(): Promise<void> {
    await this.google.signOut();
    await this.openai.signOut();
    for (const id of ALL_PROVIDERS) {
      if (PROVIDER_CREDENTIALS[id] === "free") await this.setFreeTierEnabled(id, false);
    }
    await this.store.clearAll();
  }
}

/** Prefers a coding-tuned model, then whatever came first. */
function preferredModel(available: string[]): string {
  const coder = available.find((m) => /coder|code/i.test(m));
  return coder ?? available[0];
}
