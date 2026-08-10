import { describe, expect, it } from "vitest";
import { extractGrokText, grokAdapter, browserAdapterFor } from "./browserWebClient";

/** One NDJSON line as grok.com sends it. */
function line(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}
const tok = (t: string) => line({ result: { response: { token: t } } });
const final = (m: string) => line({ result: { response: { modelResponse: { message: m } } } });

describe("folding grok.com's NDJSON stream", () => {
  it("concatenates token deltas", () => {
    expect(extractGrokText(tok("Hello") + tok(", ") + tok("world"))).toBe("Hello, world");
  });

  it("prefers the final message once it arrives", () => {
    // The terminal line carries the authoritative text, which may differ from
    // the concatenated tokens (trailing formatting, corrections).
    const raw = tok("Hel") + tok("lo") + final("Hello, world!");
    expect(extractGrokText(raw)).toBe("Hello, world!");
  });

  it("ignores a partial trailing line until it completes", () => {
    // Mid-stream, the last line usually has no newline yet — parsing it would
    // throw, and treating a throw as end-of-message would truncate the reply.
    const raw = tok("Hello") + '{"result":{"response":{"token":", wor';
    expect(extractGrokText(raw)).toBe("Hello");
  });

  it("completes once the trailing line's newline lands", () => {
    const raw = tok("Hello") + tok(", world");
    expect(extractGrokText(raw)).toBe("Hello, world");
  });

  it("skips lines it cannot parse or does not recognise", () => {
    const raw =
      tok("A") +
      "not json at all\n" +
      line({ result: { response: {} } }) +
      line({ unrelated: true }) +
      tok("B");
    expect(extractGrokText(raw)).toBe("AB");
  });

  it("returns empty for an empty or tokenless stream", () => {
    expect(extractGrokText("")).toBe("");
    expect(extractGrokText(line({ result: { response: {} } }))).toBe("");
  });
});

describe("the grok request", () => {
  it("posts the message to the web backend", () => {
    const req = grokAdapter.buildRequest("review this", "grok-4");
    expect(req.url).toBe("https://grok.com/rest/app-chat/conversations/new");
    expect(req.method).toBe("POST");
    expect((req.body as { message: string }).message).toBe("review this");
    // The web app's own model id, not the API's.
    expect((req.body as { modelName: string }).modelName).toBe("grok-4");
  });
});

describe("adapter availability", () => {
  it("has a grounded adapter for Grok", () => {
    expect(browserAdapterFor("xai")).toBeDefined();
  });

  it("has none for a provider whose endpoint is unconfirmed", () => {
    // Kimi signs in, but its web chat endpoint is not wired — the client turns
    // that into an honest message rather than a fabricated request.
    expect(browserAdapterFor("kimi")).toBeUndefined();
  });
});
