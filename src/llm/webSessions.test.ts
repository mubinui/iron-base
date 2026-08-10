import { describe, expect, it } from "vitest";
import { PROVIDER_METHODS } from "./types";
import {
  WEB_SESSIONS,
  canCaptureSession,
  expiryFromToken,
  readTokenFrom,
  type SessionStrategy,
} from "./webSessions";

/** Builds a JWT with the given payload. Only the payload segment is read. */
function jwt(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `eyJhbGciOiJIUzI1NiJ9.${body}.signature`;
}

describe("the verified-provider table", () => {
  it("only lists providers whose matrix admits a session", () => {
    // A config for a provider that cannot use it would render a sign-in button
    // the auth layer would then refuse to resolve.
    for (const [id, config] of Object.entries(WEB_SESSIONS)) {
      expect(config).toBeDefined();
      expect(
        PROVIDER_METHODS[id as keyof typeof PROVIDER_METHODS],
        `${id} has a session config but cannot use one`,
      ).toContain("webSession");
    }
  });

  it("keeps every entry self-consistent", () => {
    for (const [id, config] of Object.entries(WEB_SESSIONS)) {
      expect(config!.provider, `${id} config names a different provider`).toBe(id);
      expect(config!.loginUrl.startsWith("https://"), `${id} login is not https`).toBe(true);
      expect(config!.origin.startsWith("https://"), `${id} origin is not https`).toBe(true);
      expect(config!.risk.length, `${id} states no risk`).toBeGreaterThan(0);
    }
  });

  it("offers capture only where a config exists", () => {
    expect(canCaptureSession("chatgpt-web")).toBe(true);
    expect(canCaptureSession("xai")).toBe(true);
    expect(canCaptureSession("kimi")).toBe(true);
    // A provider with no consumer web login must report honestly rather than
    // showing a button that cannot work.
    expect(canCaptureSession("groq")).toBe(false);
    expect(canCaptureSession("openrouter")).toBe(false);
  });

  it("declares a transport for every entry", () => {
    for (const [id, config] of Object.entries(WEB_SESSIONS)) {
      expect(["fetch", "browser"], `${id} has no transport`).toContain(config!.transport);
    }
  });
});

describe("reading a token out of captured material", () => {
  const endpoint: SessionStrategy = {
    kind: "sessionEndpoint",
    url: "https://example.com/session",
    jsonPath: ["accessToken"],
  };

  it("walks the declared path", () => {
    expect(readTokenFrom(endpoint, { accessToken: "abc" })).toBe("abc");
  });

  it("walks a nested path", () => {
    const nested: SessionStrategy = {
      kind: "sessionEndpoint",
      url: "https://example.com/session",
      jsonPath: ["data", "token"],
    };
    expect(readTokenFrom(nested, { data: { token: "deep" } })).toBe("deep");
  });

  it("reports nothing for a signed-out response", () => {
    // The endpoint answers 200 with an empty object when nobody is signed in,
    // so this is the ordinary "not finished yet" case, not an error.
    expect(readTokenFrom(endpoint, {})).toBeUndefined();
    expect(readTokenFrom(endpoint, { accessToken: "" })).toBeUndefined();
    expect(readTokenFrom(endpoint, { accessToken: "   " })).toBeUndefined();
  });

  it("does not mistake a missing branch for a token", () => {
    expect(readTokenFrom(endpoint, null)).toBeUndefined();
    expect(readTokenFrom(endpoint, undefined)).toBeUndefined();
    expect(readTokenFrom(endpoint, { accessToken: { nested: true } })).toBeUndefined();
  });

  it("takes a cookie or localStorage value directly", () => {
    const cookie: SessionStrategy = { kind: "cookie", name: "sess" };
    expect(readTokenFrom(cookie, "cookie-value")).toBe("cookie-value");
    expect(readTokenFrom(cookie, "")).toBeUndefined();
  });

  it("trims what it returns", () => {
    expect(readTokenFrom({ kind: "cookie", name: "s" }, "  padded  ")).toBe("padded");
  });
});

describe("reading expiry from a token", () => {
  it("converts the exp claim to epoch milliseconds", () => {
    expect(expiryFromToken(jwt({ exp: 1_800_000_000 }))).toBe(1_800_000_000_000);
  });

  it("reports unknown rather than guessing", () => {
    // A session token need not be a JWT, and expiring a working credential
    // early is worse than not knowing when it dies.
    expect(expiryFromToken("not-a-jwt")).toBeUndefined();
    expect(expiryFromToken(jwt({ sub: "user" }))).toBeUndefined();
    expect(expiryFromToken("ey.malformed.payload")).toBeUndefined();
    expect(expiryFromToken("")).toBeUndefined();
  });
});
