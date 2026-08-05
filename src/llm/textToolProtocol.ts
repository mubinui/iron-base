/**
 * Tool calling for models that cannot call tools.
 *
 * The engine is built on structured tool calls — `read_file`, `emit_finding`,
 * `propose_fix`. Some backends have no such concept: the ChatGPT web endpoint
 * returns chat prose, and plenty of small local models ignore the tool schema
 * even when the API accepts one. This bridges the gap by describing the tools in
 * the system prompt and reading the calls back out of the reply text.
 *
 * It is strictly worse than native tool calling and should never be preferred
 * where the real thing exists: a model can write a malformed block, narrate its
 * intention instead of emitting one, or bury a call inside prose. What it buys
 * is that a review runs at all on a backend that would otherwise be unusable.
 *
 * Deliberately free of `vscode` and of any network code, so the parsing rules
 * can be tested directly.
 */

import type { ToolCall, ToolDef, ToolResult } from "./types";

/** Fence label the model is told to use. Distinct from ``` code fences. */
const FENCE = "tool";

/**
 * Matches a fenced tool block.
 *
 * Tolerant on purpose: models drift on whitespace, capitalise the label, and
 * sometimes use four backticks. Every one of those is the model trying to
 * comply, and rejecting it wastes a whole turn.
 */
const BLOCK = /```+[ \t]*tool[ \t]*\r?\n([\s\S]*?)```+/gi;

export function renderToolInstructions(tools: ToolDef[]): string {
  if (tools.length === 0) return "";

  const lines: string[] = [
    "# Calling tools",
    "",
    "You have no built-in tool calling here, so tools are invoked by writing a",
    "fenced block. To call one, reply with the block and nothing else:",
    "",
    "```" + FENCE,
    '{"name": "read_file", "input": {"path": "src/server.js"}}',
    "```",
    "",
    "Rules:",
    "- One JSON object per block: `name` and `input`. `input` must be an object.",
    "- To call several tools at once, write several blocks in the same reply.",
    "- Emit the block by itself. Do not explain that you are about to call a",
    "  tool, and do not wrap it in any other fence — a described call does not",
    "  run, and the turn is wasted.",
    "- Results come back in the next message. Keep going until you have called",
    "  `emit_report`, which ends the review.",
    "",
    "## Available tools",
    "",
  ];

  for (const tool of tools) {
    lines.push(`### ${tool.name}`);
    lines.push(tool.description);
    lines.push(`Input schema: ${JSON.stringify(tool.inputSchema)}`);
    lines.push("");
  }
  return lines.join("\n");
}

export interface ParsedReply {
  /** Prose with the tool blocks removed — what the user sees streamed. */
  text: string;
  toolCalls: ToolCall[];
  /** Blocks that looked like calls but could not be read, for nudging back. */
  malformed: string[];
}

/**
 * Pulls tool calls out of a model reply.
 *
 * `idPrefix` keys the synthesized call ids to the turn, so a result can still be
 * matched to its call after several turns of history.
 */
export function parseToolCalls(reply: string, idPrefix: string): ParsedReply {
  const toolCalls: ToolCall[] = [];
  const malformed: string[] = [];
  let index = 0;

  const text = reply.replace(BLOCK, (_match, body: string) => {
    const raw = String(body).trim();
    if (raw.length === 0) return "";
    try {
      const parsed = JSON.parse(stripTrailingCommas(raw)) as {
        name?: unknown;
        input?: unknown;
      };
      if (typeof parsed.name !== "string" || parsed.name.length === 0) {
        malformed.push(raw);
        return "";
      }
      toolCalls.push({
        callId: `${idPrefix}-${index++}`,
        name: parsed.name,
        // A model that writes `"input": null` means "no arguments", which is
        // valid for the tools that take none.
        input: typeof parsed.input === "object" && parsed.input !== null ? parsed.input : {},
      });
    } catch {
      malformed.push(raw);
    }
    return "";
  });

  return { text: text.trim(), toolCalls, malformed };
}

/**
 * Formats tool results as the user turn the model reads next.
 *
 * Results are labelled with the tool name rather than an opaque id — the model
 * is reading prose, and "read_file returned" is followable where a call id is
 * not.
 */
export function renderToolResults(results: ToolResult[]): string {
  const lines: string[] = ["Tool results:", ""];
  for (const result of results) {
    lines.push(`## ${result.name}${result.isError ? " (error)" : ""}`);
    lines.push(result.content);
    lines.push("");
  }
  lines.push(
    "Continue. Emit the next tool block, or call `emit_report` if you have enough.",
  );
  return lines.join("\n");
}

/** Told to the model when it wrote something block-shaped we could not read. */
export function renderMalformedNudge(blocks: string[]): string {
  return (
    `${blocks.length} tool block(s) could not be parsed as JSON. ` +
    "Each block must contain exactly one object with `name` and `input`, and " +
    "nothing else — no comments, no trailing text inside the fence. Try again:\n\n" +
    blocks.map((b) => `- ${b.slice(0, 200)}`).join("\n")
  );
}

/**
 * Models trained on JavaScript emit trailing commas fairly often. Repairing
 * that is far cheaper than spending a turn asking for the block again.
 */
function stripTrailingCommas(json: string): string {
  return json.replace(/,(\s*[}\]])/g, "$1");
}
