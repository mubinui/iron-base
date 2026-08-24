/**
 * Enough of the `vscode` module to construct the auth layer in a test.
 *
 * The extension host supplies this module at runtime, so it cannot be imported
 * under vitest; `vitest.config.ts` aliases it here instead. Only the surface the
 * auth code actually touches is implemented — everything else is deliberately
 * absent so that a test reaching further fails loudly rather than passing
 * against a stub that quietly returns undefined.
 */

import { posix } from "node:path";

export class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];

  readonly event = (listener: (e: T) => void): { dispose(): void } => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }

  dispose(): void {
    this.listeners = [];
  }
}

/** Defaults mirroring `contributes.configuration` in package.json. */
const CONFIG_DEFAULTS: Record<string, unknown> = {
  provider: "auto",
  disabledProviders: [],
  "ollama.baseUrl": "http://127.0.0.1:11434/v1",
  "router.baseUrl": "http://127.0.0.1:20128/v1",
};

export const workspace = {
  getConfiguration(_section?: string) {
    return {
      get<T>(key: string, fallback?: T): T {
        return (CONFIG_DEFAULTS[key] as T) ?? (fallback as T);
      },
    };
  },
};

export const window = {};
export const commands = {};
export const env = {};

/**
 * Just enough `Uri` for the workspace path guard.
 *
 * `resolveInside` only reads `.path` and calls `joinPath`, so that is all this
 * implements. Joining normalises with posix semantics the way the real one
 * does, which matters: the guard's final containment check assumes the join
 * has already collapsed the segments it was handed.
 */
export const Uri = {
  file(value: string): { scheme: string; path: string; fsPath: string } {
    const absolute = value.startsWith("/") ? value : `/${value}`;
    const normalized = posix.normalize(absolute);
    return { scheme: "file", path: normalized, fsPath: normalized };
  },

  joinPath(
    base: { path: string },
    ...segments: string[]
  ): { scheme: string; path: string; fsPath: string } {
    return Uri.file(posix.join(base.path, ...segments));
  },
};
