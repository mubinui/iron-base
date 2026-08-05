/**
 * The two coding modes, described in one place.
 *
 * An agent here is a small thing: a prompt, a set of tools, and what it is
 * allowed to do without asking. Keeping those three together is what makes
 * "architect mode cannot edit files" a fact about the request that goes over the
 * wire rather than a promise made in a prompt — the write tools are simply not
 * in its list, so there is nothing for it to call even if it tries.
 */

import { buildArchitectPrompt, buildBuilderPrompt } from "./codingPrompts";
import type { PermissionPolicies } from "./permissions";
import { CODING_TOOL_NAMES, SUBAGENT_TOOL } from "./codingToolDefs";
import { TOOL_NAMES } from "./toolDefs";

export type AgentId = "architect" | "build";

/** Every tool that only looks at the workspace. Both modes get all of them. */
const READ_TOOLS = [
  TOOL_NAMES.findRelevant,
  TOOL_NAMES.listSignals,
  TOOL_NAMES.listDir,
  TOOL_NAMES.readFile,
  TOOL_NAMES.search,
] as const;

export interface AgentSpec {
  id: AgentId;
  label: string;
  /** One line under the mode chip in the panel. */
  blurb: string;
  systemPrompt: (digest: string) => string;
  tools: string[];
  /** The tool whose call ends the run. */
  finishTool: string;
  /**
   * The most this mode may ever be allowed to do — a limit, not a default.
   *
   * Settings decide the actual policy and can only tighten this, never loosen
   * it. So an architect stays read-only even in a workspace that set edits to
   * "allow", while a builder in that same workspace does what it was told.
   */
  ceiling: PermissionPolicies;
}

export const AGENTS: Record<AgentId, AgentSpec> = {
  architect: {
    id: "architect",
    label: "Architect",
    blurb: "Explores and plans. Cannot change files.",
    systemPrompt: buildArchitectPrompt,
    tools: [
      ...READ_TOOLS,
      SUBAGENT_TOOL,
      CODING_TOOL_NAMES.runCommand,
      CODING_TOOL_NAMES.submitPlan,
    ],
    finishTool: CODING_TOOL_NAMES.submitPlan,
    // Commands stay available because understanding a project often means
    // reading its git history or running its tests once to see what passes
    // today — and every one of those is still a prompt.
    ceiling: { edit: "deny", command: "ask" },
  },
  build: {
    id: "build",
    label: "Build",
    blurb: "Writes code, runs commands, checks its work.",
    systemPrompt: buildBuilderPrompt,
    tools: [
      ...READ_TOOLS,
      SUBAGENT_TOOL,
      CODING_TOOL_NAMES.editFile,
      CODING_TOOL_NAMES.writeFile,
      CODING_TOOL_NAMES.deleteFile,
      CODING_TOOL_NAMES.runCommand,
      CODING_TOOL_NAMES.updateTodos,
      CODING_TOOL_NAMES.finish,
    ],
    finishTool: CODING_TOOL_NAMES.finish,
    // The builder is the mode that is allowed to do things, so its ceiling is
    // open and `ironbase.permissions.*` — which defaults to "ask" — is what
    // actually decides. Pinning this to "ask" would have made the settings
    // unable to say anything.
    ceiling: { edit: "allow", command: "allow" },
  },
};

/**
 * The stricter of what the mode allows and what settings allow.
 *
 * Order matters: `deny` beats `ask` beats `allow`, so neither side can widen
 * what the other closed.
 */
export function effectivePolicies(
  agent: AgentSpec,
  configured: PermissionPolicies,
): PermissionPolicies {
  return {
    edit: stricter(agent.ceiling.edit, configured.edit),
    command: stricter(agent.ceiling.command, configured.command),
  };
}

function stricter(
  a: PermissionPolicies["edit"],
  b: PermissionPolicies["edit"],
): PermissionPolicies["edit"] {
  if (a === "deny" || b === "deny") return "deny";
  if (a === "ask" || b === "ask") return "ask";
  return "allow";
}

/** Tools that only read, so they are safe to run side by side within a turn. */
export const READ_ONLY_TOOL_NAMES = new Set<string>(READ_TOOLS);
