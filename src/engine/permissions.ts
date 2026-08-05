/**
 * Asking before acting.
 *
 * The gate between a model deciding to change something and the change
 * happening. Three settings per kind of action — always ask, allow for this
 * session, never — plus the "allow all" a developer clicks on the third prompt
 * of a twenty-file refactor.
 *
 * Two rules make this trustworthy rather than decorative:
 *
 * Deleting a file is never covered by a blanket grant. "Allow all edits" is
 * agreed to while looking at a diff, and nobody reading that diff was agreeing
 * to have files removed.
 *
 * A prompt that cannot be answered is a refusal, not a hang. The panel can be
 * closed and the run can be cancelled while a request is outstanding, and in
 * both cases the loop has to keep moving with an answer the model can act on.
 */

import type { FileDiff } from "./diff";

export type PermissionKind = "edit" | "create" | "delete" | "command";

/** What settings allow before anything is asked. */
export type PermissionPolicy = "ask" | "allow" | "deny";

export type PermissionDecision = "allow" | "allowAll" | "reject";

export interface PermissionRequest {
  kind: PermissionKind;
  /** One line naming the target: "src/db.js" or the command itself. */
  subject: string;
  /** The model's stated reason, shown under the subject. */
  why?: string;
  /**
   * The change itself, so the question on screen is "allow this diff" rather
   * than "allow a write to this path". Nobody can answer the second one.
   */
  preview?: FileDiff;
}

export type PermissionOutcome =
  | { granted: true }
  | { granted: false; reason: string };

/** What the panel implements: put the question on screen, wait for a click. */
export interface PermissionPrompter {
  (request: PermissionRequest): Promise<PermissionDecision>;
}

export interface PermissionPolicies {
  edit: PermissionPolicy;
  command: PermissionPolicy;
}

/**
 * Kinds a single "allow all" covers.
 *
 * Creating a file and editing one are the same promise from the developer's
 * point of view; deleting is not, and running a command is not.
 */
const BLANKET_GROUPS: Record<PermissionKind, PermissionKind[]> = {
  edit: ["edit", "create"],
  create: ["edit", "create"],
  delete: ["delete"],
  command: ["command"],
};

export class PermissionBroker {
  private readonly sessionGrants = new Set<PermissionKind>();
  private prompter: PermissionPrompter | undefined;

  constructor(private policies: PermissionPolicies) {}

  /** The panel registers itself here, and clears itself when it closes. */
  setPrompter(prompter: PermissionPrompter | undefined): void {
    this.prompter = prompter;
  }

  setPolicies(policies: PermissionPolicies): void {
    this.policies = policies;
  }

  /**
   * Turns on blanket approval for edits, as the composer's auto-accept toggle.
   *
   * Deletes and commands are untouched by design — the toggle sits next to a
   * stream of diffs, and that is what it should be understood to mean.
   */
  setAutoAcceptEdits(on: boolean): void {
    if (on) {
      this.sessionGrants.add("edit");
      this.sessionGrants.add("create");
    } else {
      this.sessionGrants.delete("edit");
      this.sessionGrants.delete("create");
    }
  }

  get autoAcceptsEdits(): boolean {
    return this.sessionGrants.has("edit");
  }

  async request(request: PermissionRequest): Promise<PermissionOutcome> {
    const policy = request.kind === "command" ? this.policies.command : this.policies.edit;

    if (policy === "deny") {
      return {
        granted: false,
        reason:
          request.kind === "command"
            ? "Running commands is turned off for this workspace (ironbase.permissions.command). Say what you would have run and why."
            : "Writing to files is turned off for this workspace (ironbase.permissions.edit). Describe the change instead of making it.",
      };
    }

    // A blanket grant covers everything except deletion, which always asks.
    if (policy === "allow" && request.kind !== "delete") return { granted: true };
    if (this.sessionGrants.has(request.kind) && request.kind !== "delete") {
      return { granted: true };
    }

    if (!this.prompter) {
      return {
        granted: false,
        reason:
          "There is nobody to ask — the IronBase panel is closed, so this needs approval that cannot be given. Stop and report what is left to do.",
      };
    }

    const decision = await this.prompter(request);
    if (decision === "reject") {
      return {
        granted: false,
        reason: `The developer declined this ${describeKind(request.kind)}. Do not try it again — find another way, or stop and explain what you need.`,
      };
    }
    if (decision === "allowAll") {
      for (const kind of BLANKET_GROUPS[request.kind]) this.sessionGrants.add(kind);
    }
    return { granted: true };
  }

  /** Drops session grants, so a new task starts by asking again. */
  reset(): void {
    this.sessionGrants.clear();
  }
}

function describeKind(kind: PermissionKind): string {
  switch (kind) {
    case "edit":
      return "edit";
    case "create":
      return "new file";
    case "delete":
      return "deletion";
    case "command":
      return "command";
  }
}
