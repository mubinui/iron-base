/**
 * What the coding modes are offered, as data.
 *
 * Separate from `writeTools.ts` for the same reason `toolDefs.ts` is separate
 * from `tools.ts`: a schema is pure, running one is not, and only the pure half
 * can be asserted against in a test. The thing that test catches is an agent
 * listing a tool that no longer exists — which fails silently at run time, as a
 * model that quietly has no way to read a file.
 */

import type { JsonSchemaObject, ToolDef } from "../llm/types";
import { toolDefinitions } from "./toolDefs";

export const SUBAGENT_TOOL = "delegate_search";

/** Steps one subagent may take. Small on purpose: this is a lookup, not a project. */
export const MAX_SUBAGENT_STEPS = 12;

export function subagentToolDefinition(): ToolDef {
  return {
    name: SUBAGENT_TOOL,
    description:
      "Hand a self-contained research question to an assistant that can read this codebase, and get back a written answer. Use it when finding something out would take many file reads that you do not otherwise need — \"where is input validated\", \"which modules talk to the payment provider\", \"is there already a retry helper\". The searching happens outside this conversation, so it does not fill up your context. The assistant cannot change anything, and it only knows what you tell it: write the question so it stands alone.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description:
            "The question, in full. The assistant has no idea what you are working on, so include whatever it needs to know.",
        },
        why: {
          type: "string",
          description: "One line on what you will do with the answer, shown to the developer.",
        },
      },
      required: ["question", "why"],
    },
  };
}


export const CODING_TOOL_NAMES = {
  writeFile: "write_file",
  editFile: "edit_file",
  deleteFile: "delete_file",
  runCommand: "run_command",
  updateTodos: "update_todos",
  submitPlan: "submit_plan",
  finish: "finish",
} as const;

/**
 * Tool definitions for the coding modes.
 *
 * `include` names every tool this agent may call, and the list is filtered down
 * to it. That is what makes "the architect cannot edit files" true on the wire
 * rather than only in the prompt — there is nothing for it to call.
 *
 * The reading tools come from the review's own definitions, so their
 * descriptions cannot drift between the two modes. The review's emitting
 * tools live in that same list and are simply never included here.
 */
export function codingToolDefinitions(include: Set<string>): ToolDef[] {
  const all: ToolDef[] = [
    ...toolDefinitions(),
    subagentToolDefinition(),
    {
      name: CODING_TOOL_NAMES.editFile,
      description:
        "Change part of a file. `old_text` must be copied character-for-character out of read_file output (line numbers and the tab stripped) and must appear exactly once in the file — if it does not match, the edit is refused and you are told why, so re-read and copy it properly rather than guessing. This is the tool to reach for: prefer several small edits over rewriting a file.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path." },
          old_text: {
            type: "string",
            description:
              "The exact existing lines to replace, copied verbatim from the file. Include enough surrounding lines to be unique.",
          },
          new_text: {
            type: "string",
            description:
              "What replaces them. Match the file's indentation, quote style and conventions. Never leave a TODO or an ellipsis standing in for code.",
          },
          why: {
            type: "string",
            description: "One line on what this change accomplishes, shown to the developer.",
          },
        },
        required: ["path", "old_text", "new_text", "why"],
      },
    },
    {
      name: CODING_TOOL_NAMES.writeFile,
      description:
        "Write a whole file. Use it to create new files. Overwriting an existing file is allowed only after you have read it in this session, and edit_file is almost always the better choice for a file that already exists.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path." },
          content: { type: "string", description: "The file's complete contents." },
          why: {
            type: "string",
            description: "One line on what this file is for, shown to the developer.",
          },
        },
        required: ["path", "content", "why"],
      },
    },
    {
      name: CODING_TOOL_NAMES.deleteFile,
      description:
        "Delete a file. Always asks the developer, and cannot be pre-approved. Use it when code has genuinely moved elsewhere, not to clear away something you would rather not fix.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path." },
          why: { type: "string", description: "Why this file should no longer exist." },
        },
        required: ["path", "why"],
      },
    },
    {
      name: CODING_TOOL_NAMES.runCommand,
      description:
        "Run a shell command in the workspace root and get its output back. This is how you check your own work — run the project's own test, build or type-check command after making changes. Long output is trimmed in the middle, and the command is stopped if it outruns its timeout.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command line to run." },
          why: {
            type: "string",
            description: "What you expect this to tell you, in one line.",
          },
        },
        required: ["command", "why"],
      },
    },
    {
      name: CODING_TOOL_NAMES.updateTodos,
      description:
        "Publish the task list the developer watches. Call it once at the start with everything you intend to do, then again each time a task's state changes. Keep exactly one task `active`. This costs almost nothing and is the only way anyone can see where you are.",
      inputSchema: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            description: "The full list, in order. Send all of them every time.",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Stable across calls." },
                title: { type: "string", description: "What this task is, in a few words." },
                status: { type: "string", enum: ["pending", "active", "done"] },
              },
              required: ["title", "status"],
            },
          },
        },
        required: ["todos"],
      } as JsonSchemaObject,
    },
    {
      name: CODING_TOOL_NAMES.submitPlan,
      description:
        "Hand the plan over for approval. This ends your turn — you do not write any code. The developer reads it, edits it if they disagree, and approves it before anything is built, so it has to be specific enough to argue with: real paths, real names, and the smallest change that actually solves the problem.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "The change in a few words." },
          summary: {
            type: "string",
            description:
              "What is wrong or missing today, and the shape of the fix, in a short paragraph a junior developer will follow.",
          },
          steps: {
            type: "array",
            description: "The work in order. Each step should be one coherent change.",
            items: {
              type: "object",
              properties: {
                title: { type: "string", description: "What this step does." },
                files: {
                  type: "array",
                  items: { type: "string" },
                  description: "Real workspace-relative paths this step touches.",
                },
                detail: {
                  type: "string",
                  description: "How, concretely — names of functions, libraries, and patterns.",
                },
              },
              required: ["title", "files", "detail"],
            },
          },
          risks: {
            type: "array",
            items: { type: "string" },
            description: "What could go wrong or break, honestly. An empty list is a claim.",
          },
          verification: {
            type: "array",
            items: { type: "string" },
            description:
              "How to tell it worked — the commands to run and the behaviour to check.",
          },
        },
        required: ["title", "summary", "steps", "verification"],
      } as JsonSchemaObject,
    },
    {
      name: CODING_TOOL_NAMES.finish,
      description:
        "End the task and report. Call this once the work is done and you have verified it, or once you are blocked and cannot go further — in which case say so plainly rather than reporting success.",
      inputSchema: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description:
              "What changed, what you ran to check it, and what the result was. If something is unfinished or unverified, say which part.",
          },
          followUps: {
            type: "array",
            items: { type: "string" },
            description: "Work you deliberately left out, and why it is worth doing later.",
          },
        },
        required: ["summary"],
      } as JsonSchemaObject,
    },
  ];

  return all.filter((tool) => include.has(tool.name));
}

