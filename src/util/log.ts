import * as vscode from "vscode";

let channel: vscode.OutputChannel | undefined;

export function initLog(context: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel("IronBase");
  context.subscriptions.push(channel);
}

function write(level: string, message: string): void {
  const line = `[${new Date().toISOString()}] [${level}] ${message}`;
  channel?.appendLine(line);
}

export const log = {
  info(message: string): void {
    write("info", message);
  },
  warn(message: string): void {
    write("warn", message);
  },
  error(message: string, err?: unknown): void {
    write("error", err ? `${message}: ${describeError(err)}` : message);
  },
  /** Raw append, no timestamp — for streaming model output during dev commands. */
  raw(text: string): void {
    channel?.append(text);
  },
  show(): void {
    channel?.show(true);
  },
};

export function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? `${err.name}: ${err.message}`;
  }
  return String(err);
}
