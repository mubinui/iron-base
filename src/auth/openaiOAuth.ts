import * as http from "node:http";
import * as vscode from "vscode";
import { log } from "../util/log";
import { OPENAI_OAUTH } from "./oauthClients";
import { createPkce, randomState } from "./pkce";
import type { OAuthTokens, SecretStore } from "./secretStore";

const ACCOUNT_ID_KEY = "ironbase.openai.accountId";
const CALLBACK_TIMEOUT_MS = 180_000;

/**
 * ChatGPT account sign-in, using the same OAuth flow the Codex CLI uses so a
 * Plus/Pro subscription can drive the review instead of metered API credits.
 *
 * Unlike the other two flows, the redirect URI is a fixed loopback port, so the
 * callback server has to bind port 1455 exactly. See oauthClients.ts for the
 * terms-of-service caveat that applies to all three account sign-ins.
 */
export class OpenAiOAuth {
  private refreshInFlight: Promise<string> | undefined;

  constructor(
    private readonly store: SecretStore,
    private readonly globalState: vscode.Memento,
  ) {}

  async isSignedIn(): Promise<boolean> {
    return (await this.store.getTokens("openaiOAuth")) !== undefined;
  }

  async signIn(): Promise<boolean> {
    const pkce = createPkce();
    const state = randomState();

    let server: http.Server;
    let waitForCode: Promise<string>;
    try {
      ({ server, waitForCode } = await startFixedPortServer(state));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        throw new Error(
          `Port ${OPENAI_OAUTH.callbackPort} is already in use. OpenAI only accepts that exact port for sign-in — close whatever is using it (often the Codex CLI mid-login) and try again.`,
        );
      }
      throw err;
    }

    try {
      const url = new URL(OPENAI_OAUTH.authorizeUrl);
      url.searchParams.set("client_id", OPENAI_OAUTH.clientId);
      url.searchParams.set("redirect_uri", OPENAI_OAUTH.redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", OPENAI_OAUTH.scope);
      url.searchParams.set("code_challenge", pkce.challenge);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("state", state);
      url.searchParams.set("prompt", "login");
      url.searchParams.set("id_token_add_organizations", "true");

      await vscode.env.openExternal(vscode.Uri.parse(url.toString()));

      const code = await waitForCode;
      const { tokens, accountId } = await this.exchange({
        grant_type: "authorization_code",
        code,
        client_id: OPENAI_OAUTH.clientId,
        redirect_uri: OPENAI_OAUTH.redirectUri,
        code_verifier: pkce.verifier,
      });

      await this.store.setTokens("openaiOAuth", tokens);
      if (accountId) {
        await this.globalState.update(ACCOUNT_ID_KEY, accountId);
      }
      log.info("Signed in to ChatGPT.");
      return true;
    } finally {
      server.close();
    }
  }

  async getAccessToken(forceRefresh = false): Promise<string> {
    const tokens = await this.store.getTokens("openaiOAuth");
    if (!tokens) {
      throw new Error("Not signed in to ChatGPT. Run “IronBase: Sign in with ChatGPT”.");
    }
    if (!forceRefresh && Date.now() < tokens.expiresAt - 60_000) {
      return tokens.accessToken;
    }
    if (!tokens.refreshToken) {
      throw new Error("Your ChatGPT session expired. Sign in again.");
    }
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.refresh(tokens.refreshToken).finally(() => {
        this.refreshInFlight = undefined;
      });
    }
    return this.refreshInFlight;
  }

  /** The Codex backend requires the account the subscription belongs to. */
  getAccountId(): string | undefined {
    return this.globalState.get<string>(ACCOUNT_ID_KEY);
  }

  private async refresh(refreshToken: string): Promise<string> {
    const { tokens, accountId } = await this.exchange({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OPENAI_OAUTH.clientId,
      scope: OPENAI_OAUTH.scope,
    });
    if (!tokens.refreshToken) tokens.refreshToken = refreshToken;
    await this.store.setTokens("openaiOAuth", tokens);
    if (accountId) await this.globalState.update(ACCOUNT_ID_KEY, accountId);
    return tokens.accessToken;
  }

  private async exchange(
    payload: Record<string, string>,
  ): Promise<{ tokens: OAuthTokens; accountId?: string }> {
    const response = await fetch(OPENAI_OAUTH.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(payload).toString(),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `ChatGPT sign-in failed (HTTP ${response.status}). ${body.slice(0, 300)}`,
      );
    }
    const json = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      id_token?: string;
      expires_in?: number;
    };
    return {
      tokens: {
        accessToken: json.access_token,
        refreshToken: json.refresh_token,
        expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
      },
      accountId: json.id_token ? accountIdFromIdToken(json.id_token) : undefined,
    };
  }

  async signOut(): Promise<void> {
    await this.store.clear("openaiOAuth");
    await this.globalState.update(ACCOUNT_ID_KEY, undefined);
  }
}

/**
 * Digs the ChatGPT account id out of the id_token. The claim has moved between
 * Codex releases, so several known locations are tried before giving up.
 */
export function accountIdFromIdToken(idToken: string): string | undefined {
  try {
    const payload = idToken.split(".")[1];
    if (!payload) return undefined;
    const json = JSON.parse(
      Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    ) as Record<string, any>;

    const candidates = [
      json["https://api.openai.com/auth"]?.chatgpt_account_id,
      json["https://api.openai.com/auth"]?.user_id,
      json.chatgpt_account_id,
      json.account_id,
      json["https://api.openai.com/profile"]?.chatgpt_account_id,
      json.organizations?.[0]?.id,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.length > 0) return candidate;
    }
  } catch (err) {
    log.warn(`Could not read the ChatGPT account id from the id_token: ${String(err)}`);
  }
  return undefined;
}

async function startFixedPortServer(
  expectedState: string,
): Promise<{ server: http.Server; waitForCode: Promise<string> }> {
  let resolveCode: (code: string) => void;
  let rejectCode: (err: Error) => void;
  const waitForCode = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/auth/callback")) {
      res.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (error || !code) {
      res.end(page("Sign-in failed", error ?? "No authorization code was returned."));
      rejectCode(new Error(error ?? "No authorization code was returned."));
      return;
    }
    if (state !== expectedState) {
      res.end(page("Sign-in failed", "State mismatch — the request may be forged."));
      rejectCode(new Error("OAuth state mismatch."));
      return;
    }
    res.end(page("You're signed in", "You can close this tab and return to VS Code."));
    resolveCode(code);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(OPENAI_OAUTH.callbackPort, "127.0.0.1", resolve);
  });

  const timer = setTimeout(() => {
    rejectCode(new Error("Timed out waiting for the ChatGPT sign-in redirect."));
  }, CALLBACK_TIMEOUT_MS);
  waitForCode.finally(() => clearTimeout(timer)).catch(() => undefined);

  return { server, waitForCode };
}

function page(title: string, message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui,sans-serif;padding:3rem;max-width:32rem;margin:auto">
<h1 style="font-size:1.3rem">${title}</h1><p style="color:#555">${message}</p></body>`;
}
