import { describe, expect, it } from "vitest";
import { AGENTS, effectivePolicies, READ_ONLY_TOOL_NAMES, type AgentId } from "./agents";
import { CODING_TOOL_NAMES, codingToolDefinitions } from "./codingToolDefs";

const MODES: AgentId[] = ["architect", "build"];

const toolsFor = (id: AgentId): string[] =>
  codingToolDefinitions(new Set(AGENTS[id].tools)).map((tool) => tool.name);

describe("agent tool lists", () => {
  it("resolves every named tool to a real definition", () => {
    // The bug this exists for: an agent's list and the definitions it is
    // filtered against drift apart, and the model silently ends up without the
    // tools it was told to use.
    for (const id of MODES) {
      expect(toolsFor(id).sort(), id).toEqual([...AGENTS[id].tools].sort());
    }
  });

  it("gives both modes the tools they are told to start with", () => {
    for (const id of MODES) {
      expect(toolsFor(id), id).toContain("find_relevant");
      expect(toolsFor(id), id).toContain("read_file");
      expect(toolsFor(id), id).toContain("search");
    }
  });

  it("offers the architect no way to change anything", () => {
    const tools = toolsFor("architect");
    for (const writer of [
      CODING_TOOL_NAMES.editFile,
      CODING_TOOL_NAMES.writeFile,
      CODING_TOOL_NAMES.deleteFile,
    ]) {
      expect(tools).not.toContain(writer);
    }
    expect(AGENTS.architect.ceiling.edit).toBe("deny");
    // And no setting can change that.
    expect(effectivePolicies(AGENTS.architect, { edit: "allow", command: "allow" }).edit).toBe(
      "deny",
    );
  });

  it("never offers either mode the review's emitting tools", () => {
    for (const id of MODES) {
      expect(toolsFor(id), id).not.toContain("emit_finding");
      expect(toolsFor(id), id).not.toContain("emit_report");
      expect(toolsFor(id), id).not.toContain("propose_fix");
    }
  });

  it("gives each mode the tool its prompt tells it to finish with", () => {
    for (const id of MODES) {
      expect(toolsFor(id), id).toContain(AGENTS[id].finishTool);
    }
    expect(AGENTS.architect.finishTool).toBe(CODING_TOOL_NAMES.submitPlan);
    expect(AGENTS.build.finishTool).toBe(CODING_TOOL_NAMES.finish);
  });

  it("marks only read-only tools as safe to run in parallel", () => {
    for (const name of READ_ONLY_TOOL_NAMES) {
      expect(name.startsWith("emit_")).toBe(false);
    }
    for (const writer of Object.values(CODING_TOOL_NAMES)) {
      expect(READ_ONLY_TOOL_NAMES.has(writer), writer).toBe(false);
    }
  });

  it("describes every tool it offers", () => {
    for (const id of MODES) {
      for (const tool of codingToolDefinitions(new Set(AGENTS[id].tools))) {
        expect(tool.description.length, tool.name).toBeGreaterThan(40);
        expect(tool.inputSchema.type, tool.name).toBe("object");
      }
    }
  });
});

describe("effectivePolicies", () => {
  it("lets settings tighten a mode but never loosen it", () => {
    // Someone who sets edits to "allow" is talking about build mode. The
    // architect stays unable to write whatever the workspace says, and still
    // asks before a command — a mode whose whole promise is "this only looks"
    // should not be running things unattended on the strength of a setting
    // written for the mode that builds.
    expect(effectivePolicies(AGENTS.architect, { edit: "allow", command: "allow" })).toEqual({
      edit: "deny",
      command: "ask",
    });
    expect(effectivePolicies(AGENTS.build, { edit: "allow", command: "allow" })).toEqual({
      edit: "allow",
      command: "allow",
    });
  });

  it("takes deny from either side", () => {
    expect(effectivePolicies(AGENTS.build, { edit: "deny", command: "deny" })).toEqual({
      edit: "deny",
      command: "deny",
    });
  });

  it("keeps asking when settings say ask, which is the default", () => {
    expect(effectivePolicies(AGENTS.build, { edit: "ask", command: "ask" })).toEqual({
      edit: "ask",
      command: "ask",
    });
  });

  it("leaves the builder's ceiling open so the settings can actually decide", () => {
    // A ceiling of "ask" here would silently override anyone who turned the
    // prompting off, and the setting would look broken rather than ignored.
    expect(AGENTS.build.ceiling).toEqual({ edit: "allow", command: "allow" });
  });
});
