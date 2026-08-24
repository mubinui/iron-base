import type { DiffHunk } from "./engine/diff";
import type { AnalysisReport, CodeFix, Finding } from "./engine/findings";
import type { PermissionDecision, PermissionKind } from "./engine/permissions";
import type { BuildPlan, Todo } from "./engine/plan";
import type { AuthMethod, ProviderId } from "./llm/types";

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
  "ironbase.build",
  "ironbase.newBuild",
  "ironbase.switchBuild",
  "ironbase.exportBuild",
  "ironbase.cancel",
  "ironbase.exportReport",
  "ironbase.showReport",
  "ironbase.connectAccount",
  "ironbase.useConnectedAccount",
  "ironbase.signInAnthropic",
  "ironbase.signInOpenAi",
  "ironbase.signInGoogle",
  "ironbase.chooseModel",
  "ironbase.clearIndex",
  "ironbase.revertRun",
  "ironbase.buildInEditor",
  "ironbase.buildHome",
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
  | { type: "copyFix"; fixId: string }
  // Connect one provider by one method. Carries arguments the command
  // allowlist cannot, so the host validates `id` and `method` against the
  // provider matrix on receipt — the same posture as `isAllowedCommand`,
  // because this channel also carries model-generated content elsewhere.
  | { type: "connectProvider"; id: ProviderId; method: AuthMethod }
  | { type: "disconnectProvider"; id: ProviderId };

export interface SidebarState {
  /** Empty when nothing is signed in. */
  providerLabel: string | undefined;
  /** Which account is connected, for the brand mark. */
  providerId?: ProviderId;
  /** Every account with stored credentials, so the user can switch. */
  connected?: ProviderId[];
  /**
   * Providers whose browser sign-in has actually been verified.
   *
   * The connect matrix offers a "Log in" affordance only for these — every
   * provider *declares* it can take a session, but the button is shown only
   * where one has been confirmed to reach a working endpoint, so the UI never
   * offers a login that would immediately report itself unavailable.
   */
  sessionCapable?: ProviderId[];
  /**
   * Set when settings pin an account that has no stored credential, while other
   * accounts *are* connected.
   *
   * Without this the sidebar cannot tell that case apart from "nothing is
   * signed in", so it shows the sign-in page to someone who has just signed in
   * successfully — which reads as the sign-in having failed.
   */
  pinnedMissing?: ProviderId;
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

// --- The build panel -------------------------------------------------------

/** The two agents that own a thread in the panel. */
export type ChatMode = "architect" | "build";

/**
 * The two whole-workspace runs, which end in the report rather than the thread.
 *
 * They sit in the composer's mode menu beside the agents because that is where
 * someone looks for "what should IronBase do with what I am about to type" —
 * but they are deliberately a separate type, so nothing that means "which agent
 * is running" can ever be handed one of these.
 */
export type ReviewMode = "review" | "scalability";

/** Everything the composer's mode menu can be set to. */
export type ComposerMode = ChatMode | ReviewMode;

/**
 * One entry in the thread.
 *
 * Everything the panel shows is one of these, which is what lets the webview
 * rebuild the whole conversation from a replay when the panel is reopened
 * without the host having to remember how any of it was rendered.
 */
export type ThreadItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  /**
   * One step of the agent looking at the project.
   *
   * Emitted when the call starts and patched when it lands, which is what lets
   * the trace show a row as running and then settle it with what it found
   * rather than printing a line that says only that something was attempted.
   */
  | {
      kind: "tool";
      id: string;
      name: string;
      summary: string;
      /** What it found — "218 lines", "6 matches". Absent while it runs. */
      note?: string;
      /** Undefined until it lands; false when the call came back an error. */
      ok?: boolean;
    }
  | {
      kind: "change";
      id: string;
      file: string;
      change: "edit" | "create" | "delete";
      added: number;
      removed: number;
      why?: string;
      hunks: DiffHunk[];
      reverted?: boolean;
    }
  | {
      kind: "command";
      id: string;
      command: string;
      why?: string;
      output: string;
      status?: string;
      ok?: boolean;
    }
  | { kind: "notice"; level: "warning" | "error"; text: string }
  | { kind: "plan"; plan: BuildPlan }
  | { kind: "finished"; summary: string; followUps: string[] };

/**
 * One row in the composer's model menu.
 *
 * Built by the host because only it can ask an account what it is entitled to,
 * but rendered by the webview because a menu anchored to the composer has to
 * open upward from it — and VS Code's own quick pick always appears at the top
 * of the window, which is the wrong end for a control at the bottom.
 */
export interface ModelOption {
  provider: ProviderId | "auto";
  model: string;
  label: string;
  detail?: string;
  /** Which brand mark to draw, when the row belongs to a specific account. */
  providerId?: ProviderId;
  /** The account this row sits under, so the menu can group. */
  group: string;
  current: boolean;
}

/** The question on a permission card, and what it needs to show. */
export interface PermissionCard {
  id: string;
  kind: PermissionKind;
  subject: string;
  why?: string;
  hunks?: DiffHunk[];
  added?: number;
  removed?: number;
}

export interface ChatState {
  workspaceName: string;
  /** Names the build in the header and in the session picker. */
  sessionTitle: string;
  /** Empty when nothing is signed in — the panel says so instead of a composer. */
  providerLabel?: string;
  providerId?: ProviderId;
  /** Every account with a stored credential, for the start page's matrix. */
  connected?: ProviderId[];
  /** Providers whose browser sign-in has been verified. See `SidebarState`. */
  sessionCapable?: ProviderId[];
  model?: string;
  running: boolean;
  agent: ChatMode;
  /** What the panel is doing before the model is even involved. */
  activity?: string;
  iteration?: { current: number; max: number };
  usage?: {
    inputTokens: number;
    outputTokens: number;
    budget: number;
    /**
     * What this has cost so far, where the provider charges per token. Absent
     * on a subscription or a local model, where the honest answer is "nothing
     * extra" rather than a number.
     */
     costUsd?: number;
    /** How full the model's context window is, 0–1. */
    contextUsed?: number;
  };
  awaitingPlanApproval: boolean;
  autoAcceptEdits: boolean;
  /** How many files this session has written to, for the revert button. */
  changedFiles: number;
}

export type ChatHostMessage =
  | { type: "chatState"; state: ChatState }
  | { type: "replay"; thread: ThreadItem[]; todos: Todo[] }
  | { type: "append"; item: ThreadItem }
  | { type: "assistantDelta"; delta: string }
  | { type: "commandOutput"; id: string; chunk: string }
  | { type: "commandEnd"; id: string; status: string; ok: boolean }
  /** Settles a trace row that was drawn as running. */
  | { type: "toolEnd"; id: string; note?: string; ok: boolean }
  | { type: "todos"; todos: Todo[] }
  | { type: "permission"; request: PermissionCard }
  /** Takes the card off screen — answered, cancelled, or the run ended. */
  | { type: "permissionClosed"; id: string; decision: PermissionDecision }
  | { type: "changeReverted"; id: string }
  /** Workspace-relative paths the developer picked to attach. */
  | { type: "filesPicked"; files: string[] }
  | { type: "modelOptions"; options: ModelOption[] };

export type ChatWebviewMessage =
  | { type: "ready" }
  /**
   * `attachments` are workspace-relative paths the developer pointed at.
   *
   * They are named in the request rather than read and pasted in: the agent
   * already has `read_file`, and it should decide how much of a file it needs
   * rather than being handed all of every one of them.
   */
  | { type: "send"; text: string; mode: ChatMode; attachments?: string[] }
  | { type: "stop" }
  | { type: "approvePlan" }
  | { type: "editPlan" }
  | { type: "discardPlan" }
  | { type: "permissionDecision"; id: string; decision: PermissionDecision }
  | { type: "setAutoAccept"; on: boolean }
  | { type: "requestModels" }
  /** Opens the file picker; the chosen paths come back as `filesPicked`. */
  | { type: "pickFiles" }
  | { type: "selectModel"; provider: ProviderId | "auto"; model: string }
  | { type: "openFile"; file: string; line?: number }
  | { type: "showDiff"; id: string }
  | { type: "revertChange"; id: string }
  | { type: "revertAll" }
  | { type: "newSession" }
  | { type: "switchSession" }
  | { type: "exportSession" }
  /**
   * Starts one of the whole-workspace runs from the composer.
   *
   * `target` is the load description a scalability check needs; the host is
   * what decides whether an empty one is worth asking about, because only it
   * can put a prompt on screen.
   */
  | { type: "startReview"; kind: ReviewMode; target?: string }
  /** Connects an account from the panel's own start page. See `WebviewMessage`. */
  | { type: "connectProvider"; id: ProviderId; method: AuthMethod }
  | { type: "command"; command: AllowedCommand };
