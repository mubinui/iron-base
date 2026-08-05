import * as vscode from "vscode";
import { log } from "../util/log";
import { ANTHROPIC_OAUTH } from "./oauthClients";
import { createPkce } from "./pkce";
import type { OAuthTokens, SecretStore } from "./secretStore";

/**
 * Anthropic's authorize page redirects to a fixed console.anthropic.com callback
 * that displays a `code#state` string, so there is no loopback server to listen
 * on — the user pastes the code back. See oauthClients.ts for the ToS caveat.
 */
export class AnthropicOAuth {
  private refreshInFlight: Promise<string> | undefined;

  constructor(private readonly store: SecretStore) {}

  async isSignedIn(): Promise<boolean> {
    return (await this.store.getTokens("anthropicOAuth")) !== undefined;
  }

  async signIn(): Promise<boolean> {
    const pkce = createPkce();
    const url = new URL(ANTHROPIC_OAUTH.authorizeUrl);
    url.searchParams.set("code", "true");
    url.searchParams.set("client_id", ANTHROPIC_OAUTH.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", ANTHROPIC_OAUTH.redirectUri);
    url.searchParams.set("scope", ANTHROPIC_OAUTH.scope);
    url.searchParams.set("code_challenge", pkce.challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", pkce.verifier);

    await vscode.env.openExternal(vscode.Uri.parse(url.toString()));

    const pasted = await vscode.window.showInputBox({
      title: "Sign in with Claude",
      prompt:
        "Approve the request in your browser, then paste the code shown on the callback page.",
      placeHolder: "code#state",
      password: true,
      ignoreFocusOut: true,
    });
    if (!pasted) return false;

    const [code, state] = pasted.trim().split("#");
    if (!code) {
      throw new Error("That code looks malformed — expected the form code#state.");
    }

    const tokens = await this.exchange({
      grant_type: "authorization_code",
      code,
      state: state ?? pkce.verifier,
      client_id: ANTHROPIC_OAUTH.clientId,
      redirect_uri: ANTHROPIC_OAUTH.redirectUri,
      code_verifier: pkce.verifier,
    });
    await this.store.setTokens("anthropicOAuth", tokens);
    log.info("Signed in to Claude via OAuth.");
    return true;
  }

  /** Returns a valid access token, refreshing when it is expired or about to be. */
  async getAccessToken(forceRefresh = false): Promise<string> {
    const tokens = await this.store.getTokens("anthropicOAuth");
    if (!tokens) {
      throw new Error("Not signed in to Claude. Run “IronBase: Sign in with Claude”.");
    }
    const expiringSoon = Date.now() >= tokens.expiresAt - 60_000;
    if (!forceRefresh && !expiringSoon) {
      return tokens.accessToken;
    }
    if (!tokens.refreshToken) {
      throw new Error(
        "Your Claude session expired and no refresh token was stored. Sign in again.",
      );
    }
    // Serialize refreshes so parallel tool calls don't race for a new token.
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.refresh(tokens.refreshToken).finally(() => {
        this.refreshInFlight = undefined;
      });
    }
    return this.refreshInFlight;
  }

  private async refresh(refreshToken: string): Promise<string> {
    const tokens = await this.exchange({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: ANTHROPIC_OAUTH.clientId,
    });
    // Some providers omit the refresh token on rotation; keep the old one then.
    if (!tokens.refreshToken) tokens.refreshToken = refreshToken;
    await this.store.setTokens("anthropicOAuth", tokens);
    log.info("Refreshed Claude OAuth token.");
    return tokens.accessToken;
  }

  private async exchange(payload: Record<string, string>): Promise<OAuthTokens> {
    const response = await fetch(ANTHROPIC_OAUTH.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Claude sign-in failed (HTTP ${response.status}). ${body.slice(0, 300)}`,
      );
    }
    const json = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    };
  }

  async signOut(): Promise<void> {
    await this.store.clear("anthropicOAuth");
  }
}
