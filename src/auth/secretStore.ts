import * as vscode from "vscode";
import { ALL_PROVIDERS, type ProviderId } from "../llm/types";
import { log } from "../util/log";

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/**
 * A credential lifted out of a provider's own web login.
 *
 * Unlike `OAuthTokens` there is no refresh token and no reliable expiry: a
 * consumer session is whatever the site issued the browser, it dies in hours
 * rather than days, and the only way to renew it is to sign in again. So
 * `expiresAt` is a hint read from the JWT when it happens to carry one, not a
 * contract — the authoritative answer is a 401 at request time.
 */
export interface WebSession {
  token: string;
  /** Epoch milliseconds, when the token said so. Absent means "unknown". */
  expiresAt?: number;
  /** Epoch milliseconds. Used to show how stale a session is. */
  capturedAt: number;
  /** Whatever the login told us about who this is, for the account card. */
  accountLabel?: string;
}

const KEYS = {
  anthropicOAuth: "ironbase.auth.anthropic",
  openaiOAuth: "ironbase.auth.openai",
  googleOAuth: "ironbase.auth.google",
  // One entry per API-key provider. Named after the provider id so the auth
  // manager can derive the key rather than carry a switch that has to be
  // updated every time a backend is added.
  "chatgpt-webKey": "ironbase.auth.key.chatgptweb",
  openaiKey: "ironbase.auth.key.openai",
  xaiKey: "ironbase.auth.key.xai",
  openrouterKey: "ironbase.auth.key.openrouter",
  groqKey: "ironbase.auth.key.groq",
  mistralKey: "ironbase.auth.key.mistral",
  kimiKey: "ironbase.auth.kimi",
  deepseekKey: "ironbase.auth.deepseek",
  // Optional: a router only asks for one when its owner turned on
  // REQUIRE_API_KEY, so its absence is not a sign of being disconnected.
  routerKey: "ironbase.auth.key.router",
} as const;

export type SecretKey = keyof typeof KEYS;

/**
 * Where one provider's captured web session lives.
 *
 * Derived from the provider id rather than added to `KEYS`, for two reasons.
 * Every provider can hold a session, so listing them would double that map and
 * have to be edited every time a backend is added. And `KEYS` is the record of
 * identifiers users already have credentials stored under — rewriting its shape
 * is how you silently sign everyone out.
 */
function sessionKeyFor(id: ProviderId): string {
  return `ironbase.auth.session.${id}`;
}

export class SecretStore {
  private readonly onChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onChangeEmitter.event;

  constructor(private readonly secrets: vscode.SecretStorage) {}

  async getTokens(key: SecretKey): Promise<OAuthTokens | undefined> {
    const raw = await this.secrets.get(KEYS[key]);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as OAuthTokens;
    } catch (err) {
      log.warn(`Stored credential for ${key} was unreadable; clearing it.`);
      await this.secrets.delete(KEYS[key]);
      return undefined;
    }
  }

  async setTokens(key: SecretKey, tokens: OAuthTokens): Promise<void> {
    await this.secrets.store(KEYS[key], JSON.stringify(tokens));
    this.onChangeEmitter.fire();
  }

  async getString(key: SecretKey): Promise<string | undefined> {
    return this.secrets.get(KEYS[key]);
  }

  async setString(key: SecretKey, value: string): Promise<void> {
    await this.secrets.store(KEYS[key], value);
    this.onChangeEmitter.fire();
  }

  async clear(key: SecretKey): Promise<void> {
    await this.secrets.delete(KEYS[key]);
    this.onChangeEmitter.fire();
  }

  // --- Captured web sessions -------------------------------------------------

  async getSession(id: ProviderId): Promise<WebSession | undefined> {
    const raw = await this.secrets.get(sessionKeyFor(id));
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as WebSession;
    } catch {
      log.warn(`Stored session for ${id} was unreadable; clearing it.`);
      await this.secrets.delete(sessionKeyFor(id));
      return undefined;
    }
  }

  async setSession(id: ProviderId, session: WebSession): Promise<void> {
    await this.secrets.store(sessionKeyFor(id), JSON.stringify(session));
    this.onChangeEmitter.fire();
  }

  async clearSession(id: ProviderId): Promise<void> {
    await this.secrets.delete(sessionKeyFor(id));
    this.onChangeEmitter.fire();
  }

  /**
   * Deletes every credential this extension has stored.
   *
   * Sessions are swept by walking `ALL_PROVIDERS` rather than `KEYS`, because
   * their identifiers are derived and so appear in neither map. Missing one
   * here would leave a live token in the keychain after the user asked for
   * everything to be forgotten.
   */
  async clearAll(): Promise<void> {
    for (const key of Object.keys(KEYS) as SecretKey[]) {
      await this.secrets.delete(KEYS[key]);
    }
    for (const id of ALL_PROVIDERS) {
      await this.secrets.delete(sessionKeyFor(id));
    }
    this.onChangeEmitter.fire();
  }

  dispose(): void {
    this.onChangeEmitter.dispose();
  }
}
