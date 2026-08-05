import * as vscode from "vscode";
import { log } from "../util/log";

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

const KEYS = {
  anthropicOAuth: "ironbase.auth.anthropic",
  openaiOAuth: "ironbase.auth.openai",
  googleOAuth: "ironbase.auth.google",
  kimiKey: "ironbase.auth.kimi",
  deepseekKey: "ironbase.auth.deepseek",
} as const;

export type SecretKey = keyof typeof KEYS;

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

  async clearAll(): Promise<void> {
    for (const key of Object.keys(KEYS) as SecretKey[]) {
      await this.secrets.delete(KEYS[key]);
    }
    this.onChangeEmitter.fire();
  }

  dispose(): void {
    this.onChangeEmitter.dispose();
  }
}
