import * as http from "node:http";
import { AddressInfo } from "node:net";
import * as vscode from "vscode";
import { log } from "../util/log";
import { getGoogleClient } from "../config";
import { GOOGLE_OAUTH, MissingGoogleClientError } from "./oauthClients";
import { createPkce, randomState } from "./pkce";
import type { OAuthTokens, SecretStore } from "./secretStore";

const PROJECT_ID_KEY = "ironbase.gemini.projectId";
const CALLBACK_TIMEOUT_MS = 120_000;

/**
 * Google installed-app flow: a loopback HTTP server on 127.0.0.1 receives the
 * redirect. After token exchange we run Code Assist onboarding, which is what
 * provisions the free-tier project the Gemini endpoint requires.
 * See oauthClients.ts for the ToS caveat on reusing the CLI's client.
 */
export class GoogleOAuth {
  private refreshInFlight: Promise<string> | undefined;

  constructor(
    private readonly store: SecretStore,
    private readonly globalState: vscode.Memento,
  ) {}

  async isSignedIn(): Promise<boolean> {
    return (await this.store.getTokens("googleOAuth")) !== undefined;
  }

  async signIn(): Promise<boolean> {
    const client = getGoogleClient();
    if (!client) throw new MissingGoogleClientError();

    const pkce = createPkce();
    const state = randomState();
    const { server, port, waitForCode } = await startLoopbackServer(state);

    try {
      const redirectUri = `http://localhost:${port}/oauth/callback`;
      const url = new URL(GOOGLE_OAUTH.authorizeUrl);
      url.searchParams.set("client_id", client.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", GOOGLE_OAUTH.scopes.join(" "));
      url.searchParams.set("code_challenge", pkce.challenge);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("state", state);
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("prompt", "consent");

      await vscode.env.openExternal(vscode.Uri.parse(url.toString()));

      const code = await waitForCode;
      const tokens = await this.exchange({
        grant_type: "authorization_code",
        code,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        redirect_uri: redirectUri,
        code_verifier: pkce.verifier,
      });
      await this.store.setTokens("googleOAuth", tokens);
      log.info("Signed in to Google.");
    } finally {
      server.close();
    }

    // Onboarding failures shouldn't block sign-in; the first request retries it.
    try {
      await this.ensureProject();
    } catch (err) {
      log.warn(`Code Assist onboarding deferred: ${String(err)}`);
    }
    return true;
  }

  async getAccessToken(forceRefresh = false): Promise<string> {
    const tokens = await this.store.getTokens("googleOAuth");
    if (!tokens) {
      throw new Error("Not signed in to Google. Run “IronBase: Sign in with Google”.");
    }
    if (!forceRefresh && Date.now() < tokens.expiresAt - 60_000) {
      return tokens.accessToken;
    }
    if (!tokens.refreshToken) {
      throw new Error("Your Google session expired. Sign in again.");
    }
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.refresh(tokens.refreshToken).finally(() => {
        this.refreshInFlight = undefined;
      });
    }
    return this.refreshInFlight;
  }

  /** Resolves (and caches) the Code Assist project the free tier runs under. */
  async getProjectId(): Promise<string | undefined> {
    const cached = this.globalState.get<string>(PROJECT_ID_KEY);
    if (cached) return cached;
    return this.ensureProject();
  }

  private async ensureProject(): Promise<string | undefined> {
    const accessToken = await this.getAccessToken();
    const loaded = await this.callCodeAssist(accessToken, ":loadCodeAssist", {
      metadata: { pluginType: "GEMINI" },
    });

    let projectId: string | undefined = loaded?.cloudaicompanionProject;
    if (!projectId) {
      const tierId =
        loaded?.allowedTiers?.find((t: any) => t.isDefault)?.id ?? "free-tier";
      const onboarded = await this.callCodeAssist(accessToken, ":onboardUser", {
        tierId,
        metadata: { pluginType: "GEMINI" },
      });
      projectId =
        onboarded?.response?.cloudaicompanionProject?.id ??
        onboarded?.cloudaicompanionProject?.id;
    }

    if (projectId) {
      await this.globalState.update(PROJECT_ID_KEY, projectId);
      log.info(`Code Assist project resolved: ${projectId}`);
    }
    return projectId;
  }

  private async callCodeAssist(
    accessToken: string,
    path: string,
    body: unknown,
  ): Promise<any> {
    const response = await fetch(`${GOOGLE_OAUTH.codeAssistBase}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Code Assist ${path} failed (HTTP ${response.status}). ${text.slice(0, 300)}`,
      );
    }
    return response.json();
  }

  private async refresh(refreshToken: string): Promise<string> {
    const client = getGoogleClient();
    if (!client) throw new MissingGoogleClientError();
    const tokens = await this.exchange({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    });
    if (!tokens.refreshToken) tokens.refreshToken = refreshToken;
    await this.store.setTokens("googleOAuth", tokens);
    return tokens.accessToken;
  }

  private async exchange(payload: Record<string, string>): Promise<OAuthTokens> {
    const response = await fetch(GOOGLE_OAUTH.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(payload).toString(),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Google sign-in failed (HTTP ${response.status}). ${body.slice(0, 300)}`,
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
    await this.store.clear("googleOAuth");
    await this.globalState.update(PROJECT_ID_KEY, undefined);
  }
}

async function startLoopbackServer(expectedState: string): Promise<{
  server: http.Server;
  port: number;
  waitForCode: Promise<string>;
}> {
  let resolveCode: (code: string) => void;
  let rejectCode: (err: Error) => void;
  const waitForCode = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/oauth/callback") {
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
    server.listen(0, "127.0.0.1", resolve);
  });

  const timer = setTimeout(() => {
    rejectCode(new Error("Timed out waiting for the Google sign-in redirect."));
  }, CALLBACK_TIMEOUT_MS);
  waitForCode.finally(() => clearTimeout(timer)).catch(() => undefined);

  const port = (server.address() as AddressInfo).port;
  return { server, port, waitForCode };
}

function page(title: string, message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui,sans-serif;padding:3rem;max-width:32rem;margin:auto">
<h1 style="font-size:1.3rem">${title}</h1><p style="color:#555">${message}</p></body>`;
}
