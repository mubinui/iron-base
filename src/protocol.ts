import type { AnalysisReport, Finding } from "./engine/findings";

/** Messages the extension host sends to a webview. */
export type HostMessage =
  | { type: "state"; state: SidebarState }
  | { type: "report"; report: AnalysisReport }
  | { type: "progressText"; delta: string }
  | { type: "progressTool"; name: string }
  | { type: "progressIteration"; current: number; max: number }
  | { type: "progressFinding"; finding: Finding }
  | { type: "warning"; text: string };

/** Messages a webview sends back to the extension host. */
export type WebviewMessage =
  | { type: "ready" }
  | { type: "command"; command: string }
  | { type: "openFile"; file: string; line?: number };

export interface SidebarState {
  /** Empty when nothing is signed in. */
  providerLabel: string | undefined;
  running: boolean;
  /** Short description of what the run is doing right now. */
  activity?: string;
  iteration?: { current: number; max: number };
  findingCount: number;
  lastSummary?: { grade: string; summary: string; findingCount: number };
}
