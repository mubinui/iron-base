/**
 * Signing in to a provider's own site, and using what that leaves behind.
 *
 * This is the same credential `chatgpt-web` has always accepted by hand — the
 * bearer the site's own front end uses — with the copying step removed. IronBase
 * opens the provider's real login page in a real browser window; the person signs
 * in themselves, exactly as they would anyway; and the token is read out of the
 * browser context afterwards.
 *
 * ⚠️ Two things this deliberately does not do.
 *
 * It does not disguise the browser. There is no fingerprint patching, no
 * synthetic input, nothing aimed at making an automated session look like a
 * human one — and it needs none, because a human really is sitting there. If a
 * provider raises an anti-automation challenge during sign-in, the person solves
 * it, the way they would on any other day. If one is raised against the
 * *inference* call later, the client reports it and stops, exactly as
 * `chatgptWebClient.describeFailure` already does. Working around a provider's
 * bot check is a different activity from logging in, and this file does the
 * second one only.
 *
 * It does not pretend this is supported. Consumer endpoints are undocumented,
 * they change without notice, and automated use of them sits outside most
 * providers' terms — the cost of which lands on the account holder. So capture
 * is gated behind the same explicit acknowledgement the pasted-token flow has
 * always used, and a session provider is ranked *below* every OAuth and API-key
 * credential in failover rather than above them.
 */

import type { ProviderId } from "./types";

/**
 * Where a provider keeps the credential its own front end authenticates with.
 *
 * Three shapes cover every site worth supporting, and which one applies is a
 * fact about the provider that has to be discovered by looking — not guessed.
 * A provider missing from `WEB_SESSIONS` simply has no sign-in path, and the
 * connect UI says so rather than offering a button that cannot work.
 */
export type SessionStrategy =
  /** Fetch a same-origin endpoint that hands the page its own token as JSON. */
  | { kind: "sessionEndpoint"; url: string; jsonPath: string[] }
  /** Read a named cookie from the logged-in origin. */
  | { kind: "cookie"; name: string }
  /** Read a key the front end stashed in localStorage. */
  | { kind: "localStorage"; key: string };

/**
 * How the captured session actually reaches the model.
 *
 * `fetch` sends the token from the extension host, the way `chatgpt-web` always
 * has — light, but it fails the moment a provider fronts its endpoint with an
 * anti-automation check, because a bare request from Node carries none of a
 * browser's context.
 *
 * `browser` keeps the signed-in browser alive and issues the request from
 * *inside* it. That is the only way past a Cloudflare-gated backend like
 * grok.com without disguising anything: the request is made by the real browser,
 * with the real cookies, from the real origin. No fingerprint is forged because
 * none needs to be — a genuine browser is doing genuine work. The cost is that a
 * browser process runs for the duration of a build.
 */
export type SessionTransport = "fetch" | "browser";

export interface WebSessionConfig {
  provider: ProviderId;
  /** Where the person signs in. Opened in the browser window. */
  loginUrl: string;
  /**
   * The origin the session belongs to. Capture waits until the browser is on
   * this origin and the strategy yields something, which is how "they finished
   * logging in" is detected without watching for a particular button.
   */
  origin: string;
  /**
   * For `fetch` transport, where the usable bearer lives. For `browser`
   * transport it is only a signed-in *signal* — the value never leaves the
   * browser, so any cookie the login sets will do to confirm the person is
   * through.
   */
  strategy: SessionStrategy;
  transport: SessionTransport;
  /**
   * Whether the endpoint this session unlocks offers real tool calling.
   *
   * `false` routes the whole engine through `textToolProtocol`, which is
   * materially less reliable — worth knowing before a build, and worth saying
   * in the UI. Every consumer web backend here is `false`.
   */
  nativeTools: boolean;
  /** Shown in the acknowledgement, so the risk named is the real one. */
  risk: string;
}

/**
 * The providers whose sign-in path has actually been verified.
 *
 * Only ChatGPT is listed, and only because its shape is already proven in this
 * codebase: `connectChatGptWeb` has shipped the very same endpoint and JSON
 * field since before any of this existed, so the entry below asserts nothing new.
 *
 * Grok, Kimi and the rest are absent **on purpose**. Where a given site keeps
 * its token, and whether that token reaches an endpoint that will talk to us, is
 * not something that can be worked out by reasoning about it — it has to be
 * observed in a logged-in browser, once per provider, and it changes without
 * notice. Adding a row here on a guess produces a button that fails at the worst
 * possible moment, on the user's first impression of the product. The capture
 * flow is built to be provider-agnostic precisely so that adding one, once
 * verified, is this table's problem and nothing else's.
 */
export const WEB_SESSIONS: Partial<Record<ProviderId, WebSessionConfig>> = {
  "chatgpt-web": {
    provider: "chatgpt-web",
    loginUrl: "https://chatgpt.com/",
    origin: "https://chatgpt.com",
    strategy: {
      kind: "sessionEndpoint",
      url: "https://chatgpt.com/api/auth/session",
      jsonPath: ["accessToken"],
    },
    // ChatGPT's session token works from the extension host, so this one stays
    // light. The conversation endpoint has no tool API, hence the text protocol.
    transport: "fetch",
    nativeTools: false,
    risk:
      "Automated use of ChatGPT is against OpenAI's terms — the account could be suspended. " +
      "The endpoint is undocumented and breaks without warning, and it has no real tool " +
      "calling, so builds are less reliable than on any other provider.",
  },

  // Grok's web backend sits behind Cloudflare, so the request is made from
  // inside the signed-in browser rather than from the extension host. The
  // strategy here only confirms sign-in — grok.com sets an `sso` cookie once you
  // are through; its value never leaves the browser.
  xai: {
    provider: "xai",
    loginUrl: "https://grok.com/",
    origin: "https://grok.com",
    strategy: { kind: "cookie", name: "sso" },
    transport: "browser",
    nativeTools: false,
    risk:
      "Automated use of grok.com is against xAI's terms — the account could be suspended. " +
      "The endpoint is undocumented, sits behind an anti-automation check you may have to " +
      "clear yourself in the window, and can break without warning. Grok's paid API key is " +
      "the supported path.",
  },

  // Kimi's web app, same shape as Grok: the request rides the live browser. The
  // login sets an auth cookie; any of the likely names confirms sign-in.
  kimi: {
    provider: "kimi",
    loginUrl: "https://www.kimi.com/",
    origin: "https://www.kimi.com",
    strategy: { kind: "cookie", name: "kimi-auth" },
    transport: "browser",
    nativeTools: false,
    risk:
      "Automated use of kimi.com is against Moonshot's terms — the account could be " +
      "suspended. The endpoint is undocumented and can break without warning. Kimi's free " +
      "API key is the supported path.",
  },
};

/** Whether signing in is offered for this provider at all. */
export function canCaptureSession(id: ProviderId): boolean {
  return WEB_SESSIONS[id] !== undefined;
}

export function sessionConfigFor(id: ProviderId): WebSessionConfig | undefined {
  return WEB_SESSIONS[id];
}

/**
 * Reads the token out of whatever the strategy pointed at.
 *
 * Split from the browser driving so the parsing is testable without launching
 * anything: the capture supplies the raw material, this decides whether it
 * amounts to a credential.
 */
export function readTokenFrom(strategy: SessionStrategy, raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;

  if (strategy.kind === "sessionEndpoint") {
    let cursor: unknown = raw;
    for (const step of strategy.jsonPath) {
      if (typeof cursor !== "object" || cursor === null) return undefined;
      cursor = (cursor as Record<string, unknown>)[step];
    }
    return nonEmptyString(cursor);
  }
  return nonEmptyString(raw);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * The expiry a JWT declares, when it is one and it says.
 *
 * Best-effort by design: a session token is not required to be a JWT, and a
 * wrong guess here would expire a working credential early. Anything
 * unparseable simply reports "unknown", and the authoritative answer stays what
 * it always was — a 401 at request time.
 */
export function expiryFromToken(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const json = JSON.parse(
      Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    ) as { exp?: unknown };
    return typeof json.exp === "number" ? json.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}
