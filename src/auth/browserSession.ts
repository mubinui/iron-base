/**
 * A signed-in browser, kept alive to make requests from inside it.
 *
 * Some providers front their web backend with an anti-automation check that a
 * bare request from the extension host cannot pass — grok.com behind Cloudflare
 * is the example. The move that works without disguising anything is to stop
 * making the request from Node at all: keep the browser the user signed in with
 * open, and issue the fetch from *inside the page*, where the real cookies, the
 * real origin and the real browser context already are. Nothing is forged,
 * because a genuine browser is doing the genuine thing it does.
 *
 * This owns one persistent Playwright context, shared across providers and
 * reused across a build's many turns. The browser it drives is the one the user
 * already has (`playwright-core` ships none), and the profile is the same one the
 * capture flow signs in to, so a login done once persists here.
 *
 * The streaming glue below cannot be unit-tested without a live browser; it is
 * kept deliberately thin, and every provider-specific decision — what to send,
 * how to read the reply — lives in `browserWebClient.ts` where it can be.
 */

import type { BrowserContext, Page } from "playwright-core";
import { NoBrowserError } from "./sessionCapture";
import { log } from "../util/log";

export interface InPageRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  /** JSON-serialisable body, sent as the request body when present. */
  body?: unknown;
}

export interface InPageResponse {
  status: number;
  ok: boolean;
  /** Populated only on a non-2xx, so the caller can explain the failure. */
  errorText?: string;
}

const CHANNELS = ["chrome", "msedge", "chrome-beta", "msedge-beta"] as const;
const CHUNK_BINDING = "__ironbaseChunk";

/**
 * The one browser host for the extension.
 *
 * A single instance is created in `extension.ts` and disposed on deactivate;
 * everything that needs to talk to a consumer backend goes through it.
 */
export class BrowserSession {
  private context: BrowserContext | undefined;
  private launching: Promise<BrowserContext> | undefined;
  private readonly bound = new WeakSet<Page>();
  private readonly sinks = new WeakMap<Page, (chunk: string) => void>();

  constructor(private readonly profileDir: string) {}

  /**
   * Opens the provider's login page and resolves once the person is through.
   *
   * "Through" is a cookie appearing on the origin — any cookie the login sets,
   * because for a browser-transport provider the value is never used, only its
   * presence. The context is closed afterwards so no window lingers between
   * connecting and building; the login itself survives in the persistent
   * profile, so the next request opens already signed in.
   */
  async login(
    loginUrl: string,
    origin: string,
    cookieName: string,
    signal?: AbortSignal,
    timeoutMs = 5 * 60_000,
  ): Promise<boolean> {
    const context = await this.ensureContext();
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(loginUrl).catch(() => undefined);

    const deadline = Date.now() + timeoutMs;
    try {
      while (true) {
        if (signal?.aborted) return false;
        if (Date.now() > deadline) return false;
        const cookies = await context.cookies(origin).catch(() => []);
        if (cookies.some((c) => c.name === cookieName || isAuthCookie(c.name))) {
          return true;
        }
        await delay(700, signal);
      }
    } finally {
      await this.dispose();
    }
  }

  /**
   * Runs one streaming request inside a page on the given origin.
   *
   * The page's own `fetch` is used, so the request carries the site's cookies
   * and passes whatever gate would refuse a call from outside the browser. Body
   * chunks are handed back through a page binding as they arrive, which is what
   * keeps the transcript streaming rather than landing in one lump.
   */
  async stream(
    origin: string,
    request: InPageRequest,
    onChunk: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<InPageResponse> {
    const context = await this.ensureContext();
    const page = await this.pageOn(context, origin);
    await this.bind(page);
    this.sinks.set(page, onChunk);

    const abortListener = () => {
      void page.evaluate(() => (globalThis as unknown as AbortHost).__ironbaseAbort?.());
    };
    signal?.addEventListener("abort", abortListener, { once: true });

    try {
      return await page.evaluate(runInPage, {
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
      });
    } finally {
      signal?.removeEventListener("abort", abortListener);
      this.sinks.delete(page);
    }
  }

  async dispose(): Promise<void> {
    const context = this.context;
    this.context = undefined;
    this.launching = undefined;
    await context?.close().catch(() => undefined);
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    if (this.launching) return this.launching;
    this.launching = this.launch().then((ctx) => {
      this.context = ctx;
      ctx.on("close", () => {
        if (this.context === ctx) this.context = undefined;
      });
      return ctx;
    });
    try {
      return await this.launching;
    } finally {
      this.launching = undefined;
    }
  }

  private async launch(): Promise<BrowserContext> {
    const { chromium } = await import("playwright-core");
    let lastError: unknown;
    for (const channel of CHANNELS) {
      try {
        return await chromium.launchPersistentContext(this.profileDir, {
          channel,
          headless: false,
          viewport: null,
          args: ["--no-first-run", "--no-default-browser-check"],
        });
      } catch (err) {
        lastError = err;
      }
    }
    log.warn(`No installed browser could be launched for a session: ${String(lastError)}`);
    throw new NoBrowserError();
  }

  private async pageOn(context: BrowserContext, origin: string): Promise<Page> {
    for (const page of context.pages()) {
      if (safeUrl(page).startsWith(origin)) return page;
    }
    const page = context.pages()[0] ?? (await context.newPage());
    if (!safeUrl(page).startsWith(origin)) {
      await page.goto(origin).catch(() => undefined);
    }
    return page;
  }

  /** Exposes the chunk binding once per page; safe to call repeatedly. */
  private async bind(page: Page): Promise<void> {
    if (this.bound.has(page)) return;
    await page.exposeFunction(CHUNK_BINDING, (chunk: string) => {
      this.sinks.get(page)?.(chunk);
    });
    this.bound.add(page);
  }
}

interface AbortHost {
  __ironbaseAbort?: () => void;
  __ironbaseChunk?: (chunk: string) => Promise<void>;
}

/**
 * Runs entirely inside the page. Streams the response body back through the
 * binding, chunk by chunk, and reports the status. Kept small and dependency-
 * free because it is serialised across the CDP boundary to run in the browser.
 */
async function runInPage(request: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}): Promise<{ status: number; ok: boolean; errorText?: string }> {
  const host = globalThis as unknown as AbortHost;
  const controller = new AbortController();
  host.__ironbaseAbort = () => controller.abort();

  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    credentials: "include",
    signal: controller.signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    return { status: response.status, ok: false, errorText };
  }
  if (!response.body) {
    return { status: response.status, ok: true };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    if (text && host.__ironbaseChunk) await host.__ironbaseChunk(text);
  }
  return { status: response.status, ok: true };
}

/** A permissive check for "some auth cookie exists", for logins we cannot name. */
function isAuthCookie(name: string): boolean {
  return /(^|[_-])(sso|auth|session|token|access)([_-]|$)/i.test(name);
}

function safeUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return "";
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    const onAbort = () => finish();
    signal?.addEventListener("abort", onAbort, { once: true });
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
  });
}
