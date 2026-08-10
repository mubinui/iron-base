import { describe, expect, it } from "vitest";
import { LlmHttpError } from "./types";
import { looksLikeHtml, readJsonBody } from "./sse";

describe("recognising an HTML body", () => {
  it("flags the pages a provider returns instead of JSON", () => {
    // The three real shapes: a Cloudflare interstitial, an SPA index fallback,
    // and a bare document — each of which can arrive with a 200 status.
    expect(looksLikeHtml("<!DOCTYPE html><html>…")).toBe(true);
    expect(looksLikeHtml("  \n <!doctype HTML>")).toBe(true);
    expect(looksLikeHtml("<html lang=\"en\">")).toBe(true);
    expect(looksLikeHtml("<head><title>Just a moment…")).toBe(true);
    expect(looksLikeHtml("<!-- comment first -->")).toBe(true);
  });

  it("does not flag JSON, even JSON that mentions a tag", () => {
    expect(looksLikeHtml("{\"error\":\"<tag> in a string\"}")).toBe(false);
    expect(looksLikeHtml("[1,2,3]")).toBe(false);
    expect(looksLikeHtml("\"a string\"")).toBe(false);
    expect(looksLikeHtml("")).toBe(false);
  });
});

describe("reading a JSON body defensively", () => {
  it("parses ordinary JSON", async () => {
    const response = new Response(JSON.stringify({ ok: true }), { status: 200 });
    expect(await readJsonBody<{ ok: boolean }>(response, "Grok")).toEqual({ ok: true });
  });

  it("raises a named, diagnosable error for an HTML challenge on a 200", async () => {
    // The exact case behind the original bug report: a challenge page served
    // with a success status, which `response.ok` waves through.
    const response = new Response("<!DOCTYPE html><html><body>Just a moment</body></html>", {
      status: 200,
    });

    const err = await readJsonBody(response, "Grok").catch((e) => e);
    expect(err).toBeInstanceOf(LlmHttpError);
    expect((err as LlmHttpError).message).toContain("Grok");
    expect((err as LlmHttpError).message).toContain("HTML page");
    // Never the raw parser message the user could do nothing with.
    expect((err as LlmHttpError).message).not.toContain("Unexpected token");
  });

  it("names the provider even when the non-JSON body is not HTML", async () => {
    const response = new Response("upstream timeout", { status: 502 });
    const err = await readJsonBody(response, "Kimi").catch((e) => e);
    expect((err as LlmHttpError).message).toContain("Kimi");
    expect((err as LlmHttpError).message).toContain("not JSON");
  });
});
