# IronBase

A VS Code coding agent that starts by understanding your **architecture**.

Most coding agents open your project cold and grep their way in. IronBase builds a local
map of your codebase first — the dependency graph, what every file declares, where the
risk concentrates — and the agent starts from that. It knows your sessions live in process
memory before you ask it to fix them.

It does two things:

**Build.** Describe a change. An architect explores the code read-only and hands you a
plan; you approve or edit it; then a builder works through it as a live task list —
editing files, running your tests, checking its own work. Every edit is a diff you approve,
and one click puts every file back.

**Review.** A full architecture review: what will hurt as the project grows, each with a
real file and line, plus a dependency map, one-click patches, and a modernization
blueprint.

What that gets you:

- **Maps your architecture.** A dependency graph built from your imports, laid out by
  depth: what sits on top, what everything rests on, and which modules import each other
  in a ring. Click a module to see what depends on it and what was found inside it.
- **Plans before it codes.** The architect cannot write to your files — the write tools
  are not in its list, so this is a fact about the request, not a promise in a prompt.
- **Verifies its own work.** The builder finds and runs your real test or build command,
  reads the failure, and fixes it rather than reporting success over a red test.
- **Finds the structural problems** that will hurt as the project grows, each with a real
  file and line, why it matters, and what to do about it.
- **Writes the patch.** Where a fix is small enough to write out, you get a diff with an
  Apply button. Every patch is checked against the file when it is proposed *and* again
  the moment you apply it, so a stale patch is refused rather than silently applied to
  code that has moved on.
- **Draws the target.** A blueprint of what this codebase should look like — which code
  belongs elsewhere, and which concerns it handles in a dated way — named after your own
  directories, not in the abstract.
- **Scalability check** — you say "I want to serve 10,000 concurrent users"; it estimates
  what the code handles today, ranks what caps it, and lays out a phased plan.

Findings also land in the Problems panel, and the whole report exports to Markdown with
the patches as fenced diffs.

## Building something

Click **Build something…** in the sidebar, or run `IronBase: Build…`.

```
you  ▸  move sessions out of process memory so this can run on two instances

     ◆ ARCHITECT — read-only
       search index   where are sessions stored
       read           src/app.js
       read           src/routes/auth.js

     PLAN  Back sessions with Redis
       1. src/session.js (new) — wrap ioredis behind get/set/destroy
       2. src/app.js — replace the module-level `sessions` object
       3. package.json — add ioredis
       Risks: Redis becomes a dependency to run locally
       Verify: npm test, then start two instances and share a login
       [Build this]  [Edit plan]                          [Discard]
```

Approve it and the builder takes over: a task list appears, ticks over as it works, and
each edit arrives as a diff with **Allow** / **Allow all edits** / **Reject**. Flip
**Auto-accept edits** in the composer and it stops asking.

**Plan first** is the default. **Build only** skips the architect for small, obvious
changes.

Builds are saved. Reload the window, come back tomorrow, and the conversation, the task
list and the undo history are still there — `IronBase: Past Builds…` reopens any of the
last 25 in this workspace, and `IronBase: Export Build as Markdown` writes one out as a
diff you can paste into a pull request.

### What can be undone

Before IronBase writes to a file for the first time, it keeps a copy of what was there.
That gives you **Undo** on any individual change and **Revert Changes from This Build**
for all of them. Files it created are removed; files it changed go back byte for byte. If
it cannot take that snapshot — an unreadable file, a permissions problem — it refuses the
write rather than making a change it could not reverse.

Deleting a file always asks, even with auto-accept on. "Allow all edits" is agreed to
while looking at a diff, and nobody reading a diff was agreeing to have files removed.

### It reads your project's own instructions

If your repository has an `AGENTS.md`, a `CLAUDE.md`, a `.cursorrules` or a
`.github/copilot-instructions.md`, IronBase reads it and follows it. You should not have
to write your house style out again for every tool that turns up. They are re-read at the
start of every task, so a rule you add after watching it get something wrong applies to
the very next thing you ask.

### Running commands

The builder can run your project's own commands, because an agent that cannot run
`npm test` is guessing about whether its edit works. Output streams into the panel and
goes back to the model, so it can read a stack trace and fix what it broke.

Every command asks first, and a short list is refused outright whatever you click:
deletes aimed at `/` or your home directory, `sudo`, force pushes, `git reset --hard`,
disk writes, `curl … | sh`, publishing a package.

**This is a guard against accidents, not a sandbox.** A model set on doing harm could
express any of those another way. What the list actually stops is the ordinary failure:
a confident one-liner, a damage that is invisible in the text of it, and Allow being one
keystroke away. Turn commands off entirely with `ironbase.permissions.command: "deny"`.

## No API keys. Ever.

IronBase runs on an AI account you already pay for — or don't:

| Connect | Uses | Setup |
| --- | --- | --- |
| **Claude** | Your Claude Pro or Max subscription | None — one click |
| **ChatGPT** | Your ChatGPT Plus or Pro subscription | None — one click |
| **Gemini** | Your Google account, including the free tier | A free OAuth client, ~1 minute ([below](#connecting-gemini)) |

There is no API-key field anywhere in the extension, and no billing to set up. Sign-in is
stored in your OS keychain via VS Code's `SecretStorage` and is only ever sent to that
provider.

### Connecting Gemini

Claude and ChatGPT ship with the OAuth client their vendor's own CLI uses, so they connect
with a single click. Google's pair includes a value formatted as a client secret, and
vendoring another project's credential into a public repository would mean publishing
it — which isn't ours to publish, and which secret scanners rightly block. So Gemini asks
you to bring your own, once:

1. Open [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials).
2. Create a project if you don't have one, then **Create credentials → OAuth client ID**.
3. Choose application type **Desktop app**. Name it anything.
4. Copy the **Client ID** and **Client secret** into VS Code settings:

```jsonc
"ironbase.google.clientId": "…apps.googleusercontent.com",
"ironbase.google.clientSecret": "…"
```

5. Enable the **Gemini for Google Cloud API** on that project if prompted during sign-in.

It's free, and the free tier's quota is generous. If you'd rather not bother, Claude or
ChatGPT will get you running immediately.

### ⚠️ How the sign-ins actually work

Claude and ChatGPT sign-in reuse the OAuth client that each vendor's own command-line tool
ships with — Claude Code and Codex CLI respectively. **These are not public, supported API
surfaces.** Before you rely on them:

- Either vendor can rotate or revoke their client at any time, and sign-in would break with
  no warning. (Gemini is unaffected: you supply your own client, so nobody else can revoke it.)
- Reusing them this way sits in a grey area of each vendor's terms of service. This is fine
  for your own development; it is not something to ship inside a company product.
- Subscription and free tiers have usage caps. Connect more than one account so you have
  somewhere to fall back to when one is throttled.

All of it is confined to `src/auth/oauthClients.ts` plus the flow files beside it, so a
break in one provider doesn't touch the rest. You can disable a provider from settings
without a code change:

```jsonc
// settings.json
"ironbase.disabledProviders": ["chatgpt-oauth"]
```

### Reaching things that are not files

IronBase speaks MCP, so an issue tracker, a database schema or an internal docs server can
be part of a build. Servers are configured in settings and their tools appear namespaced as
`mcp__<server>__<tool>`, which is both how two servers can each have a `search` and how a
third-party server is prevented from shipping a tool named `edit_file` that shadows the
real one.

```jsonc
"ironbase.mcpServers": {
  "github": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": { "GITHUB_TOKEN": "..." }
  },
  "docs": { "type": "http", "url": "https://internal.example.com/mcp" }
}
```

Every MCP call asks before it runs, and is gated as a command rather than as an edit —
these tools reach outside your workspace by design, which is exactly why "allow all edits"
should not cover them. A server that will not start is logged and skipped; it never takes
the build down with it.

## How it stays fast and cheap

IronBase does **not** send your codebase to the model. It builds a local index first, and
the model pulls in only what it asks for. **Both modes start from that index** — the
architect and the builder get the same brief the reviewer does, which is why neither of
them opens with twenty minutes of grep.

**1. Local index, built once.** A dependency-free scan extracts, per file, the symbols it
declares, what it imports, and the architecture-relevant signals it carries — SQL built by
concatenation, module-level mutable state, blocking I/O, credentials that look hardcoded,
queries inside loops, and a dozen more. This costs zero tokens because no model is involved.

**2. Incremental.** Every file is keyed by content hash. A second review re-reads only what
you edited. On this extension's own source: **30 ms cold, 2 ms warm** with 51 files cached.

**3. A brief, not a dump.** The model starts from a compact architectural brief built from
the index — the stack, the request surface, where risk concentrates, what's missing
operationally. For this repository that brief is **776 tokens against 62,626 tokens of raw
source: about 80× smaller**, and it stays roughly flat as a project grows.

**4. Retrieval, not grep.** Instead of hunting through files, the model asks the index
questions — `find_relevant("where are sessions stored")` — and gets back ranked files with
the exact matching lines. It opens a file only once the index says it matters.

**5. Memory across runs.** Findings are remembered with the hashes of the files they cited.
On a re-review the model is told which issues sit in untouched code (still open) and which
sit in code you've since changed (check these first), so it spends its budget on what moved.

**6. It delegates the expensive searching.** "Where do we validate input" is a question
whose answer is a paragraph and whose cost is twenty file reads. Asked in the main
conversation, those reads stay in the transcript and are re-sent on every turn afterwards.
So the agent can hand that question to a read-only assistant with its own transcript, and
get back only the paragraph — the searching is paid for once and then discarded.

**7. It summarises itself before it runs out of room.** A long build eventually outgrows
the model's context window. Rather than dying on a 400 halfway through, IronBase watches
how full the window is and, at around two-thirds, has the model write a handover note of
the earlier steps and continues from that. The panel shows the gauge and tells you when it
happens.

**8. The dependency graph, computed locally.** Import statements are resolved to real
files, rolled up into modules, and checked for cycles and hub modules. That analysis costs
no tokens, it drives the Architecture map, and a summary of it goes into the brief — so the
model starts out knowing which modules are tangled, which is not something it could work
out by reading files one at a time.

## Trust: every reference is verified

Before any finding reaches you, its file and line are checked against the real filesystem.
A finding citing a file that doesn't exist is rejected and the model is told to correct it.
A line number that has drifted is re-anchored using the snippet the model quoted. Only
verified references become clickable links and squiggles — which is why a link in the report
actually goes somewhere.

The same standard applies to patches, and this is what makes the Apply button safe to
press. A patch has to quote the exact lines it targets; if that text isn't in the file, or
appears more than once, the patch is rejected at review time and the model is sent back to
read the code properly. The check runs again when you click Apply, against the file as it
is right then — so if you have edited that code since, IronBase tells you the patch is
stale instead of writing it over your work. Applied changes land unsaved in your editor,
inside the normal undo stack.

## Getting started

1. Install the extension and open your project folder.
2. Click the IronBase icon in the activity bar.
3. Connect an account.
4. Click **Build something…** and describe a change — or **Analyze architecture** to see
   what is there first.

## Commands

| Command | What it does |
| --- | --- |
| `IronBase: Build…` | Open the build panel: plan a change, approve it, watch it happen |
| `IronBase: Revert Changes from This Build` | Put every file this build touched back |
| `IronBase: New Build` | Start a fresh conversation, keeping the undo history |
| `IronBase: Past Builds…` | Reopen an earlier build in this workspace |
| `IronBase: Export Build as Markdown` | Write the build out as a diff and a summary |
| `IronBase: Analyze Architecture` | Full architecture review |
| `IronBase: Scalability Check…` | Review plus a capacity estimate for a target you name |
| `IronBase: Connect Claude Account` | Sign in with Claude Pro/Max |
| `IronBase: Connect ChatGPT Account` | Sign in with ChatGPT Plus/Pro |
| `IronBase: Connect Gemini Account` | Sign in with a Google account |
| `IronBase: Choose Model…` | Pick which connected account and model to review with |
| `IronBase: Sign Out / Clear Credentials` | Delete every stored credential |
| `IronBase: Rebuild Project Index` | Drop the cache and re-index from scratch |
| `IronBase: Cancel Analysis` | Stop whatever is running — a review or a build |
| `IronBase: Export Report as Markdown` | Save the report to a file |
| `IronBase: Open Last Report` | Reopen the report panel |

## Settings

| Setting | Default | Controls |
| --- | --- | --- |
| `ironbase.provider` | `auto` | Which connected account to use |
| `ironbase.model` | *(empty)* | Model override; empty lets the account decide |
| `ironbase.ignoreGlobs` | `node_modules`, `dist`, … | Extra paths to skip, on top of `.gitignore` |
| `ironbase.maxFiles` | `2000` | Cap on files indexed |
| `ironbase.maxFileReadBytes` | `64000` | Cap on bytes per file read |
| `ironbase.maxIterations` | `40` | Cap on review steps per run |
| `ironbase.maxBuildIterations` | `80` | Cap on steps for one planning or build task |
| `ironbase.maxSessionTokens` | `500000` | Token budget per run |
| `ironbase.permissions.edit` | `ask` | Whether the builder may write files: `ask`, `allow`, `deny` |
| `ironbase.permissions.command` | `ask` | Whether it may run commands: `ask`, `allow`, `deny` |
| `ironbase.commandTimeoutMs` | `120000` | How long one command may run before it is stopped |
| `ironbase.mcpServers` | `{}` | MCP servers to make available to the build agent |
| `ironbase.enableDiagnostics` | `true` | Show findings in the Problems panel |
| `ironbase.google.clientId` | *(empty)* | Google OAuth client ID for Gemini sign-in |
| `ironbase.google.clientSecret` | *(empty)* | Google OAuth client secret for Gemini sign-in |
| `ironbase.disabledProviders` | `[]` | Hide specific sign-in methods |

## What the capacity numbers mean

The scalability estimate is **read from your code, not measured**. It's a reasoned starting
point — "a single database connection and in-process sessions put you in the low hundreds of
concurrent users" — with its assumptions written out so you can check them. Treat it as
direction for your own load testing, not as a benchmark result.

## Privacy

Your code goes to whichever account you connected, and only when you start a review or a
build. There is no IronBase server. The index lives on your machine. Only the parts of
files the model asks to read are ever transmitted.

## Development

```bash
npm install
npm run build       # bundles dist/extension.js and dist/webview.js
npm run typecheck   # both tsconfigs
npm run watch       # rebuild on change
```

Press <kbd>F5</kbd> to launch an Extension Development Host on `test-fixtures/bad-app`, a
deliberately badly-architected Express app with planted problems — in-memory sessions, an
N+1 query, hardcoded secrets, SQL string concatenation, synchronous file I/O in a handler.
Useful for checking that the review finds what it should and that every link lands on the
right line.

Two developer commands help when working on the index or a provider client:

- `IronBase: Developer: Dump Architectural Brief` — prints the architectural brief and index timings
  to the output channel without calling a model.
- `IronBase: Developer: Ping Model` — one cheap round trip to confirm a provider is wired up.

## License

MIT
