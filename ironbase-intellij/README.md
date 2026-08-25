# IronBase for IntelliJ IDEA

A skeleton, ported from the [VS Code extension](../README.md) of the same
name — not a feature-complete mirror of it. This document says plainly what
that means: what works today, what does not exist yet, and why the two
platforms could not simply share code.

## What actually works

Open the **IronBase** tool window (right-hand sidebar), paste a Claude API
key, press **Save**, ask it something about the open project, press Enter.
It can read files, list directories and search file contents — via
`AgentLoop` and `WorkspaceTools` — before it answers, and you can watch it
do that: each call shows as a line ("→ read_file src/Foo.kt — 218 lines")
while the reply streams in around it.

Nothing else from the VS Code extension is here: no planning-before-writing,
no writing or editing a file, no permission prompts, no checkpoint/undo, no
project *index* (these tools walk the live file system, not a built index —
`find_relevant`/`list_signals` are not ported), no architecture review, no
scalability check, no OAuth sign-in, no providers besides Claude by API key.
Building those out is real work on top of this, not a flag to flip — see
"What porting the rest looks like" below.

## Why this is a second implementation, not a port

The VS Code extension is TypeScript running in a Node host with VS Code's
own extension API; this is Kotlin running on the JVM with the IntelliJ
Platform SDK. They share nothing at the language or runtime level, and the
UI layers are furthest apart of all: VS Code's build panel is HTML/CSS/JS in
a webview, and there is no equivalent surface here without embedding JCEF (a
bundled Chromium instance) — which was deliberately not reached for. See
"Swing, not JCEF" below.

Checked directly rather than assumed: of the 71 non-test source files in
`src/`, 32 import the `vscode` module, including most of `src/engine/` (the
tool-calling loop, the checkpoint, the shell runner) and the project
indexer. Only the two-way message shapes in `src/llm/` and the pure-logic
pieces have nothing VS Code-specific in them, and even those needed
rewriting here, not copying — Kotlin is not TypeScript with different
punctuation.

What *did* port directly, as ideas even where the code is new:

| VS Code extension | This plugin |
|---|---|
| `vscode.SecretStorage` | `PasswordSafe` — `settings/CredentialStore.kt` |
| `src/llm/anthropicClient.ts` | `llm/AnthropicClient.kt` + `llm/AnthropicWireFormat.kt` (API key only, no OAuth) |
| `src/llm/sse.ts` | `llm/Sse.kt` |
| `src/llm/types.ts` (the neutral message shapes) | `llm/NeutralTypes.kt` — now a `Turn` union (user/assistant/tool-results), since a tool loop needs to replay what a tool was asked and what it answered |
| `src/engine/tools.ts` — `read_file`, `list_dir`, `search` only | `engine/WorkspaceTools.kt`, against `VirtualFile` instead of `vscode.workspace.fs` |
| `src/engine/codingSession.ts`'s `runTools` (the read-only slice) | `engine/AgentLoop.kt` — sequential, not the original's parallel-reads fan-out |
| the build panel's webview | `ui/ChatPanel.kt` (Swing, not a webview) |

### Swing, not JCEF

The VS Code panel's trace, its diff cards, its composer — all of that is
real UI work that would need to be rebuilt to be judged, and JCEF (embedding
Chromium inside a Swing component) is a bundled browser process with its
own async-initialization races and JS-bridge failure modes. Those cannot be
exercised from outside a running IDE, which is exactly the kind of bug that
ships invisibly in a skeleton nobody has clicked through yet. Plain Swing —
a `JTextArea`, a `JTextField`, two buttons — is plain enough to read
correctly by inspection, which is what this had to be verifiable by, since
the build in this session was CLI-only: no way to launch the IDE and click
through it.

### No external JSON or HTTP library

`llm/MiniJson.kt` is a hand-written recursive-descent JSON reader and
writer, and `llm/AnthropicClient.kt` uses `java.net.http.HttpClient` rather
than OkHttp or a JSON library such as Gson. The IntelliJ Platform bundles
its own copies of common libraries inside the IDE's classloader; a plugin
that also declares one risks resolving to whichever copy loads first — a
real source of version-skew bugs that show up only at runtime, in a
different IDE build, not at compile time. For the two fixed, small JSON
shapes this client needs, hand-rolling both directions is less code than
negotiating that classloading question, and has nothing to go wrong at a
version boundary.

## Building and running

```bash
./gradlew buildPlugin   # assembles build/distributions/ironbase-intellij-*.zip
./gradlew runIde        # launches a sandboxed IDE with the plugin installed
./gradlew test          # runs the unit tests — 22, none require a display
```

Two kinds of test, deliberately kept apart. `MiniJsonTest` and
`AnthropicWireFormatTest` are plain JUnit — no platform, no network, just the
serialization logic. `WorkspaceToolsTest` runs against
`BasePlatformTestCase`, a real headless IDE fixture with an actual
`VirtualFile` tree and real `ReadAction`s: the only way to genuinely verify
code that touches the VFS without a display, which is what let this be
checked for real in a session with no way to launch the IDE and click
through it — and it caught a real bug (`resolve()` telling a request for a
file that had simply never existed that it was "outside the workspace",
because both cases collapsed to the same `null`) before it shipped.

The Gradle wrapper is committed, so no local Gradle install is required —
only a JDK. `runIde` downloads and launches IntelliJ IDEA Community
2024.2 the first time, which takes a while and needs network access.

Requires JDK 21 (matching the IDE this targets, IC 2024.2, which itself
runs on JBR 21) — `jvmToolchain(21)` in `build.gradle.kts` asks Gradle to
provision or locate one; `sdk install java 21-tem` (SDKMAN) or your
platform's usual JDK install is enough if none is found.

## What porting the rest looks like

Roughly the order the coupling above suggests, each a real chunk of work on
its own:

1. **Writing** — `edit_file`, `write_file`, `delete_file`. The read-only
   three are done; these are the ones that need a permission prompt in front
   of them before they run, which does not exist yet either.
2. **The checkpoint/undo system** — IntelliJ's own `LocalHistory` may cover
   part of what `src/engine/checkpoint.ts` does by hand; worth checking
   before reimplementing it.
3. **Running commands** — `run_command`, backed by `GeneralCommandLine`
   instead of `child_process`, plus the command-guard denylist from
   `src/engine/commandGuard.ts`.
4. **OAuth sign-in** (Claude, ChatGPT, Gemini) — PKCE plus a loopback HTTP
   listener for the redirect. `com.intellij.credentialStore` already
   answers the "where does the token live" half; the flow itself needs
   writing.
5. **The project indexer** (`src/memory/`) — what `find_relevant` and
   `list_signals` answer from instead of walking the live disk on every
   call, the way `WorkspaceTools.search` does now. The VS Code version
   leans on `vscode.workspace.findFiles`; the IntelliJ equivalent is
   `FilenameIndex`/`ProjectFileIndex`, a different traversal model, not a
   search-and-replace.
6. **The chat UI itself** — now that there is a real tool trace to show,
   decide for real whether Swing keeps up with it and with streaming diffs,
   or whether that is where JCEF becomes worth its complexity.

Each of those is independently useful and independently testable — a
reasonable place to stop and check in, not a stretch goal to reach in one
pass.
