/**
 * Capturing a provider's web session by watching a real sign-in.
 *
 * The mechanism is deliberately dull: open the provider's own login page in a
 * real, visible browser window, let the person sign in the way they always do,
 * and once they are through, read the token the site handed its own front end.
 * Nothing here disguises the browser or fakes a human — a human is genuinely
 * present, which is the whole reason no disguise is needed. See the header of
 * `webSessions.ts` for why that line is drawn where it is.
 *
 * The browser is the one the user already has. `playwright-core` ships without a
 * bundled Chromium (that would be ~150MB in the .vsix), so it drives an
 * installed Chrome or Edge over the `channel` option instead. The profile is
 * persistent, so a second capture for a site you are still logged in to is
 * near-instant, and so signing in here does not disturb your everyday browser.
 */

import type { BrowserContext, Page } from "playwright-core";
import {
  expiryFromToken,
  readTokenFrom,
  type WebSessionConfig,
} from "../llm/webSessions";
import { log } from "../util/log";

export interface CapturedSession {
  token: string;
  expiresAt?: number;
}

export interface CaptureOptions {
  /** A directory to keep the browser profile in, so logins persist. */
  profileDir: string;
  /** Give up if the sign-in is not completed within this window. */
  timeoutMs?: number;
  /** Abort when the user cancels from VS Code. */
  signal?: AbortSignal;
}

/** No installed browser could be driven — the one thing the user must fix. */
export class NoBrowserError extends Error {
  constructor() {
    super(
      "IronBase could not find Chrome or Edge to open for sign-in. Install one of them " +
        "(or connect this provider with an API key instead) and try again.",
    );
    this.name = "NoBrowserError";
  }
}

export class CaptureCancelledError extends Error {
  constructor() {
    super("Sign-in was cancelled.");
    this.name = "CaptureCancelledError";
  }
}

/** Installed browsers to try, in order. `channel` drives them without a download. */
const CHANNELS = ["chrome", "msedge", "chrome-beta", "msedge-beta"] as const;

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 800;

/**
 * Opens a sign-in window and resolves once the session token appears.
 *
 * Resolves when the strategy first yields a token — which is how "they finished
 * logging in" is detected without hunting for a particular button on a page that
 * is free to change. Rejects on timeout, on cancellation, and if the window is
 * closed before a token is seen.
 */
export async function captureWebSession(
  config: WebSessionConfig,
  options: CaptureOptions,
): Promise<CapturedSession> {
  const context = await launchContext(options.profileDir);
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let closedByUser = false;
  context.on("close", () => {
    closedByUser = true;
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(config.loginUrl).catch(() => undefined);

    while (true) {
      if (options.signal?.aborted) throw new CaptureCancelledError();
      if (closedByUser) throw new CaptureCancelledError();
      if (Date.now() > deadline) {
        throw new Error(
          "Timed out waiting for sign-in. Connect again when you are ready to finish it.",
        );
      }

      const token = await tryReadToken(context, page, config).catch(() => undefined);
      if (token) {
        log.info(`Read a ${config.provider} session from the sign-in window.`);
        return { token, expiresAt: expiryFromToken(token) };
      }

      await delay(POLL_INTERVAL_MS, options.signal);
    }
  } finally {
    // Closing here is what returns the person to their editor once it worked;
    // the persistent profile means the login itself survives the close.
    await context.close().catch(() => undefined);
  }
}

/** Runs the provider's strategy against the live browser, once. */
async function tryReadToken(
  context: BrowserContext,
  page: Page,
  config: WebSessionConfig,
): Promise<string | undefined> {
  // Only look once the browser is actually on the provider's origin, so a token
  // is never read from some unrelated page the profile happened to have open.
  if (!currentUrl(page).startsWith(config.origin)) return undefined;

  const strategy = config.strategy;
  switch (strategy.kind) {
    case "sessionEndpoint": {
      // Fetched from inside the page so it carries the site's own cookies — the
      // same request the front end makes, not one forged from the extension host.
      const raw = await page.evaluate(async (url: string) => {
        const response = await fetch(url, { credentials: "include" });
        if (!response.ok) return null;
        return response.json().catch(() => null);
      }, strategy.url);
      return readTokenFrom(strategy, raw);
    }
    case "cookie": {
      const cookies = await context.cookies(config.origin);
      const match = cookies.find((c) => c.name === strategy.name);
      return readTokenFrom(strategy, match?.value);
    }
    case "localStorage": {
      // Runs in the page; `globalThis` reaches its localStorage without needing
      // the DOM lib in the extension host's own tsconfig.
      const value = await page.evaluate((key: string) => {
        const store = (globalThis as { localStorage?: { getItem(k: string): string | null } })
          .localStorage;
        return store ? store.getItem(key) : null;
      }, strategy.key);
      return readTokenFrom(strategy, value);
    }
  }
}

function currentUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return "";
  }
}

/**
 * Launches a persistent context on the first installed browser that will start.
 *
 * `playwright-core` carries no browser of its own, so every channel here is one
 * the user already has. If none of them start, that is the single actionable
 * failure — surfaced as `NoBrowserError` rather than a Playwright stack trace.
 */
async function launchContext(profileDir: string): Promise<BrowserContext> {
  const { chromium } = await import("playwright-core");

  let lastError: unknown;
  for (const channel of CHANNELS) {
    try {
      return await chromium.launchPersistentContext(profileDir, {
        channel,
        headless: false,
        // The window is the point — the person signs in here — so it opens at a
        // usable size rather than the automation default.
        viewport: null,
        args: ["--no-first-run", "--no-default-browser-check"],
      });
    } catch (err) {
      lastError = err;
    }
  }

  log.warn(`No installed browser could be launched for capture: ${String(lastError)}`);
  throw new NoBrowserError();
}

/** A cancellable sleep, so the poll loop reacts to Cancel without waiting out the tick. */
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
