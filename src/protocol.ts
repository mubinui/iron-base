import type { AnalysisReport, CodeFix, Finding } from "./engine/findings";
import type { ProviderId } from "./llm/types";

/** Messages the extension host sends to a webview. */
export type HostMessage =
  | { type: "state"; state: SidebarState }
  | { type: "report"; report: AnalysisReport }
  | { type: "progressText"; delta: string }
  | { type: "progressTool"; name: string }
  | { type: "progressIteration"; current: number; max: number }
  | { type: "progressFinding"; finding: Finding }
  | { type: "warning"; text: string }
  | { type: "fixResult"; fixId: string; ok: boolean; message: string };

/**
 * Commands a webview may ask the host to run.
 *
 * Typed as a closed union rather than a bare string so the host can check
 * membership before dispatching. The webview is our own bundle behind a strict
 * CSP, so this is not plugging an exploitable hole — it is refusing to leave the
 * entire VS Code command surface, including destructive built-ins, reachable
 * from a channel that also carries model-generated report content.
 */
export const ALLOWED_COMMANDS = [
  "ironbase.analyze",
  "ironbase.scalabilityCheck",
  "ironbase.cancel",
  "ironbase.exportReport",
  "ironbase.showReport",
  "ironbase.connectAccount",
  "ironbase.signInAnthropic",
  "ironbase.signInOpenAi",
  "ironbase.signInGoogle",
  "ironbase.chooseModel",
  "ironbase.clearIndex",
  "ironbase.signOutProvider",
  "ironbase.signOut",
] as const;

export type AllowedCommand = (typeof ALLOWED_COMMANDS)[number];

export function isAllowedCommand(value: unknown): value is AllowedCommand {
  return (
    typeof value === "string" && (ALLOWED_COMMANDS as readonly string[]).includes(value)
  );
}

/** Messages a webview sends back to the extension host. */
export type WebviewMessage =
  | { type: "ready" }
  | { type: "command"; command: AllowedCommand }
  | { type: "openFile"; file: string; line?: number }
  | { type: "applyFix"; fixId: string }
  | { type: "previewFix"; fixId: string }
  | { type: "copyFix"; fixId: string };

export interface SidebarState {
  /** Empty when nothing is signed in. */
  providerLabel: string | undefined;
  /** Which account is connected, for the brand mark. */
  providerId?: ProviderId;
  /** Every account with stored credentials, so the user can switch. */
  connected?: ProviderId[];
  /**
   * The model the next run will use. `automatic` means nothing is pinned in
   * settings, so `label` is only what the account resolved to this time.
   */
  model?: { label: string; automatic: boolean };
  running: boolean;
  /** Short description of what the run is doing right now. */
  activity?: string;
  iteration?: { current: number; max: number };
  findingCount: number;
  fixCount: number;
  /** Epoch ms the current run began, so the UI can tick an elapsed timer. */
  startedAt?: number;
  usage?: { inputTokens: number; outputTokens: number; budget: number };
  lastSummary?: {
    grade: string;
    summary: string;
    findingCount: number;
    fixCount: number;
    elapsedMs?: number;
    totalTokens?: number;
  };
}
