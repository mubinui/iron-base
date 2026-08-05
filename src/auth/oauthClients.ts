/**
 * First-party OAuth client identifiers, reused so users can sign in with the
 * subscription or free-tier account they already have instead of buying tokens.
 *
 * ⚠️ These are *not* public API surfaces. The providers can rotate, revoke, or
 * gate them at any time, and reusing them sits in a grey area of each provider's
 * terms of service. Everything provider-specific about that reuse is confined to
 * this file plus `anthropicOAuth.ts` / `googleOAuth.ts`, so if a flow breaks the
 * blast radius is small: users can fall back to an API key immediately, and the
 * `ironbase.disabledProviders` setting turns the affected flow off without a
 * code change. See the README's "How sign-in works" section.
 */

export const ANTHROPIC_OAUTH = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authorizeUrl: "https://claude.ai/oauth/authorize",
  tokenUrl: "https://console.anthropic.com/v1/oauth/token",
  redirectUri: "https://console.anthropic.com/oauth/code/callback",
  scope: "org:create_api_key user:profile user:inference",
} as const;

export const OPENAI_OAUTH = {
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  /** Fixed by OpenAI — the loopback server has to bind this exact port. */
  redirectUri: "http://localhost:1455/auth/callback",
  callbackPort: 1455,
  scope: "openid profile email offline_access",
  /** The Codex backend that serves ChatGPT-subscription inference. */
  codexBase: "https://chatgpt.com/backend-api/codex",
} as const;

/**
 * Google is the one provider whose OAuth client is **not** shipped with the
 * extension. Unlike Anthropic's and OpenAI's client identifiers, Google's pair
 * includes a value formatted as a client secret, and vendoring another
 * project's credential into this repository would mean publishing it — which
 * secret scanners rightly object to, and which is not ours to publish.
 *
 * The user supplies their own via `ironbase.google.clientId` /
 * `ironbase.google.clientSecret`. See the README for how to get one; a Desktop
 * app client from Google Cloud Console takes about a minute and is free.
 */
export const GOOGLE_OAUTH = {
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  scopes: [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
  ],
  codeAssistBase: "https://cloudcode-pa.googleapis.com/v1internal",
} as const;

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
}

export class MissingGoogleClientError extends Error {
  constructor() {
    super(
      "Gemini sign-in needs a Google OAuth client. Set ironbase.google.clientId " +
        "and ironbase.google.clientSecret in your settings — the README explains " +
        "how to create one (free, about a minute). Claude and ChatGPT need no setup.",
    );
    this.name = "MissingGoogleClientError";
  }
}
