/**
 * What the model is offered, as data.
 *
 * Kept apart from `tools.ts` — which runs these — because a tool definition is
 * pure schema and prose, while running one needs the file system. Splitting them
 * means the definitions can be asserted against directly in a test, and an agent
 * whose tool list names something that does not exist is caught there rather
 * than by a model quietly finding it has nothing to read files with.
 */

import type { JsonSchemaObject, ToolDef } from "../llm/types";
import { SIGNAL_LABELS, type SignalKind } from "../memory/symbols";
import { CATEGORIES, SEVERITY_ORDER } from "./findings";

const ALL_SIGNAL_KINDS = Object.keys(SIGNAL_LABELS) as SignalKind[];

export const TOOL_NAMES = {
  findRelevant: "find_relevant",
  listSignals: "list_signals",
  listDir: "list_dir",
  readFile: "read_file",
  search: "search",
  emitFinding: "emit_finding",
  proposeFix: "propose_fix",
  emitReport: "emit_report",
} as const;

export function toolDefinitions(): ToolDef[] {
  return [
    {
      name: TOOL_NAMES.findRelevant,
      description:
        "Ask the project index a question in plain language and get back the files most likely to answer it, each with the specific lines that matched. This is the cheapest way to locate anything — start here rather than listing directories or reading files at random. Examples: \"where are sessions stored\", \"database queries inside loops\", \"how is configuration loaded\".",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "What you are looking for, in plain language.",
          },
          limit: { type: "number", description: "How many files to return. Default 8." },
        },
        required: ["query"],
      },
    },
    {
      name: TOOL_NAMES.listSignals,
      description:
        "List every place in the project carrying one pre-scanned architecture signal, with file and line. The counts in the brief come from this index, so use it to jump straight to the evidence behind them.",
      inputSchema: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: [...ALL_SIGNAL_KINDS],
            description: "Which signal to list.",
          },
        },
        required: ["kind"],
      },
    },
    {
      name: TOOL_NAMES.listDir,
      description:
        "List the contents of a directory in the workspace. Prefer find_relevant unless you specifically need to see a directory's layout.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative directory path. Use \"\" or \".\" for the root.",
          },
        },
        required: ["path"],
      },
    },
    {
      name: TOOL_NAMES.readFile,
      description:
        "Read a file from the workspace. Returns numbered lines so you can cite exact line numbers as evidence. Prefer a line range for large files.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path." },
          startLine: { type: "number", description: "First line to return (1-based)." },
          endLine: { type: "number", description: "Last line to return (inclusive)." },
        },
        required: ["path"],
      },
    },
    {
      name: TOOL_NAMES.search,
      description:
        "Search file contents across the workspace. Returns `path:line: text` matches. Cheaper than reading whole files — use it to locate patterns such as query calls, session handling, or hardcoded secrets.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Text or regular expression to find." },
          isRegex: { type: "boolean", description: "Treat the pattern as a regex. Default false." },
          glob: {
            type: "string",
            description: "Optional include glob, e.g. \"**/*.ts\".",
          },
        },
        required: ["pattern"],
      },
    },
    {
      name: TOOL_NAMES.emitFinding,
      description:
        "Record one architecture problem. Every finding needs concrete evidence: a real file path, and a line number where you can point at one. Call this as you go, not all at the end.",
      inputSchema: {
        type: "object",
        properties: {
          severity: { type: "string", enum: [...SEVERITY_ORDER] },
          category: { type: "string", enum: [...CATEGORIES] },
          title: { type: "string", description: "Short problem statement." },
          explanation: {
            type: "string",
            description: "What is wrong and why it matters, in plain language a junior developer will understand.",
          },
          recommendation: {
            type: "string",
            description: "The concrete fix, naming files, libraries, or patterns where possible.",
          },
          effort: { type: "string", enum: ["small", "medium", "large"] },
          evidence: {
            type: "array",
            description: "One or more real locations backing this finding.",
            items: {
              type: "object",
              properties: {
                file: { type: "string", description: "Workspace-relative file path." },
                startLine: { type: "number" },
                endLine: { type: "number" },
                snippetHint: {
                  type: "string",
                  description: "A short exact line of code from that location, used to verify the reference.",
                },
              },
              required: ["file"],
            },
          },
        },
        required: ["severity", "category", "title", "explanation", "recommendation", "evidence"],
      } as JsonSchemaObject,
    },
    {
      name: TOOL_NAMES.proposeFix,
      description:
        "Attach an applicable code change to a finding you already emitted. The developer sees it as a diff with an Apply button, so it has to be real code that compiles in context — not a sketch. `anchor` must be copied character-for-character from the file, including indentation, and must appear exactly once; if it does not match, the fix is rejected and you will be told why. Propose a fix for every finding where the change is small and local enough to write out. Skip it for findings whose fix is a multi-file redesign — say that in the recommendation instead.",
      inputSchema: {
        type: "object",
        properties: {
          findingTitle: {
            type: "string",
            description:
              "The exact title of the finding this fixes, so the two can be shown together.",
          },
          title: {
            type: "string",
            description: "What this change does, in a few words, e.g. \"Move the API key into an environment variable\".",
          },
          file: { type: "string", description: "Workspace-relative file path." },
          kind: {
            type: "string",
            enum: ["replace", "insert-after", "create"],
            description:
              "replace: swap the anchor for the replacement. insert-after: keep the anchor and add the replacement below it. create: write a new file, with the replacement as its whole contents.",
          },
          anchor: {
            type: "string",
            description:
              "The exact existing lines to target, copied verbatim from read_file output with the line numbers and tab stripped. Include enough lines to be unique in the file. Omit only when kind is \"create\".",
          },
          replacement: {
            type: "string",
            description:
              "The new code. Match the file's existing indentation, quote style, and language conventions.",
          },
          rationale: {
            type: "string",
            description:
              "Why this change is correct and what it buys, in one or two sentences a junior developer will follow.",
          },
        },
        required: ["title", "file", "kind", "replacement", "rationale"],
      } as JsonSchemaObject,
    },
    {
      name: TOOL_NAMES.emitReport,
      description:
        "Finish the review and produce the overall report. Call this exactly once, after you have emitted your findings.",
      inputSchema: {
        type: "object",
        properties: {
          grade: {
            type: "string",
            enum: ["A", "B", "C", "D", "F"],
            description: "Overall architectural health.",
          },
          summary: {
            type: "string",
            description: "A few sentences summarising the state of the architecture and the most important thing to fix first.",
          },
          blueprint: {
            type: "object",
            description:
              "What this codebase should look like once the findings are addressed. Required for a full review — this is the part developers act on.",
            properties: {
              summary: {
                type: "string",
                description:
                  "The target shape in two or three sentences: the layers or boundaries this project should have, named after its own domain rather than in the abstract.",
              },
              moves: {
                type: "array",
                description:
                  "Code that belongs somewhere other than where it is. Name real paths on both sides.",
                items: {
                  type: "object",
                  properties: {
                    what: { type: "string", description: "The code or responsibility that should move." },
                    from: { type: "string", description: "Where it lives now — a real path." },
                    to: { type: "string", description: "Where it should live — a path to create or extend." },
                    why: { type: "string", description: "What that buys, concretely." },
                  },
                  required: ["what", "from", "to", "why"],
                },
              },
              stack: {
                type: "array",
                description:
                  "Concerns this project handles in a dated or hand-rolled way, and the current standard approach. Only include ones that would genuinely pay off at this project's size — do not recommend Kubernetes to a side project.",
                items: {
                  type: "object",
                  properties: {
                    concern: { type: "string", description: "e.g. \"Session storage\", \"Schema validation\", \"CI\"." },
                    current: { type: "string", description: "How the project does it today." },
                    recommended: { type: "string", description: "The specific library, service, or pattern to adopt, named." },
                    why: { type: "string", description: "Why it is better here, not in general." },
                  },
                  required: ["concern", "current", "recommended", "why"],
                },
              },
            },
            required: ["summary"],
          },
          scalability: {
            type: "object",
            description: "Required in scalability mode; omit otherwise.",
            properties: {
              target: { type: "string" },
              estimatedCurrentCapacity: { type: "string" },
              assumptions: { type: "array", items: { type: "string" } },
              bottlenecks: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    rank: { type: "number" },
                    component: { type: "string" },
                    why: { type: "string" },
                  },
                  required: ["rank", "component", "why"],
                },
              },
              roadmap: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    phase: { type: "string" },
                    actions: { type: "array", items: { type: "string" } },
                    expectedCapacity: { type: "string" },
                  },
                  required: ["phase", "actions", "expectedCapacity"],
                },
              },
            },
            required: [
              "target",
              "estimatedCurrentCapacity",
              "assumptions",
              "bottlenecks",
              "roadmap",
            ],
          },
        },
        required: ["grade", "summary"],
      } as JsonSchemaObject,
    },
  ];
}
