# IronBase

A VS Code extension that reviews your project's **architecture**, not just its syntax.

Most tools tell you a variable is unused. IronBase tells you that your sessions live in
process memory so the app can never run on more than one server, and shows you the line
where that happens. It is built for developers who can ship a working app but haven't yet
had someone senior look over their shoulder.

Two things it does:

- **Analyze architecture** — finds the structural problems that will hurt as the project
  grows, each with a real file and line, why it matters, and a concrete fix.
- **Scalability check** — you say "I want to serve 10,000 concurrent users"; it estimates
  what the code handles today, ranks what caps it, and lays out a phased plan.

Findings also land in the Problems panel, and the report exports to Markdown.

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

## How it stays fast and cheap

IronBase does **not** send your codebase to the model. It builds a local index first, and
the model pulls in only what it asks for.

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

## Trust: every reference is verified

Before any finding reaches you, its file and line are checked against the real filesystem.
A finding citing a file that doesn't exist is rejected and the model is told to correct it.
A line number that has drifted is re-anchored using the snippet the model quoted. Only
verified references become clickable links and squiggles — which is why a link in the report
actually goes somewhere.

## Getting started

1. Install the extension and open your project folder.
2. Click the IronBase icon in the activity bar.
3. Connect an account.
4. Click **Analyze architecture**, or **Scalability check…** and type your target.

## Commands

| Command | What it does |
| --- | --- |
| `IronBase: Analyze Architecture` | Full architecture review |
| `IronBase: Scalability Check…` | Review plus a capacity estimate for a target you name |
| `IronBase: Connect Claude Account` | Sign in with Claude Pro/Max |
| `IronBase: Connect ChatGPT Account` | Sign in with ChatGPT Plus/Pro |
| `IronBase: Connect Gemini Account` | Sign in with a Google account |
| `IronBase: Choose Model…` | Pick which connected account and model to review with |
| `IronBase: Sign Out / Clear Credentials` | Delete every stored credential |
| `IronBase: Rebuild Project Index` | Drop the cache and re-index from scratch |
| `IronBase: Cancel Analysis` | Stop a running review |
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
| `ironbase.maxSessionTokens` | `500000` | Token budget per run |
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

Your code goes to whichever account you connected, and only when you start a review. There
is no IronBase server. The index lives on your machine. Only the parts of files the model
asks to read are ever transmitted.

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
