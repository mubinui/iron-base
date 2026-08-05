# Architecture review — architect-doctor

**Grade: B**

This is a genuinely well-organised VS Code extension. The layering is clear (scanner → memory index → engine agent loop → report/webview), the module boundaries mostly hold, the caching strategy in `src/memory/indexer.ts` is thoughtful (hash-based reuse, cancellation, progress), the webview has a real CSP with a nonce and a command allowlist in `src/protocol.ts`, and the comments explain *why* rather than *what*. The pre-scan's scary signals — hardcoded secrets, SQL concatenation, sync I/O — are all either inside `test-fixtures/bad-app` (an intentional fixture) or are the analyzer's own regex literals, so none of them are real.

Fix the path sandbox first. `ReportPanel.openFile` joins a model-supplied path straight onto the workspace root with no traversal check, while two other copies of that check live in `src/engine/tools.ts` and `src/report/fixApplier.ts`. A security check that exists in three places and is missing from one of them is the thing most likely to bite you. After that, close the gap between `package.json`'s settings schema and what `src/config.ts` actually reads (two undeclared settings and three unreachable providers), and get a CI workflow plus `node:test` cases around the regex heuristics in `src/memory/symbols.ts` — that is the code most likely to regress silently and it is currently unguarded.

> ⚠️ Token budget for this run was exhausted.

4 finding(s): 3 high, 1 medium

## Structure

14 modules, 28 dependencies, 4 layers deep.

**Circular dependencies**

- src/auth ↔ src/llm
- src/engine ↔ src/memory

**Most connected**

- `src` — 4 in, 7 out, layer 1
- `src/engine` — 4 in, 5 out, layer 1
- `src/memory` — 4 in, 3 out, layer 1
- `src/util` — 7 in, 0 out, layer 3
- `src/auth` — 2 in, 3 out, layer 1

## Target architecture

IronBase should keep its current four-stage pipeline — `src/scanner` (what files exist) → `src/memory` (index, symbols, graph, digest) → `src/engine` (agent loop, tools, findings) → `src/report` + `webview` (render, apply fixes) — with `src/util` as the only shared leaf. Two things need to become explicit boundaries: a single trusted-path module that every model-supplied path must pass through, and a single schema layer where untrusted model JSON is turned into domain objects. `src/extension.ts` should shrink to command registration and wiring, delegating run orchestration to an engine-level session object.

### What should move where

- **The workspace path sandbox (`ToolRunner.resolve`, `resolveInside`, and the missing guard in `ReportPanel.openFile`)**: `src/engine/tools.ts:381, src/report/fixApplier.ts:185, src/report/reportPanel.ts:132` → `src/util/paths.ts (new) exporting `resolveInsideRoot(root, relPath)`` — One implementation of a security check means one place to fix a bypass, and one place to point a test at. Today two copies disagree and a third does not exist.
- **Argument parsing for tool calls: `parseBlueprint`, `parseScalability`, `stringArray`, `numberOrUndefined`, `clamp` and the inline `String(args.x ?? "")` coercions**: `src/engine/tools.ts (lines 338-349 and 938-1030)` → `src/engine/toolSchemas.ts (new), using zod` — Puts the trust boundary in one file, turns malformed model output into a precise error the model can act on, and cuts ~150 lines out of the 1044-line tools.ts.
- **Pure text helpers `locateAnchor` and `reindent`, currently imported by the report layer from the engine's tool-dispatch file**: `src/engine/tools.ts:875-937 (imported at src/report/fixApplier.ts:3)` → `src/engine/anchor.ts (new)` — `fixApplier` needs anchor matching, not the whole tool runner. Splitting it removes a report→engine dependency on a 1044-line module and makes the anchor logic directly unit-testable.
- **The `OPENAI_OAUTH.codexBase` constant that `llm/codexClient.ts` reaches into `auth/oauthClients.ts` for**: `src/auth/oauthClients.ts:31 (imported at src/llm/codexClient.ts:2)` → `src/llm/types.ts, alongside OPENAI_COMPATIBLE_BASES` — Breaks the only runtime edge of the src/auth ↔ src/llm cycle. An endpoint base URL is an LLM-transport concern, not an OAuth concern, so it belongs on the llm side and auth can keep depending on llm one-way.
- **Run orchestration: the ~130 lines of scan → index → runAnalysis → publish sequencing plus the `onProgress` switch**: `src/extension.ts:127-260` → `src/engine/reviewSession.ts (new), leaving extension.ts to register commands and own VS Code UI objects` — Removes most of the nine module-level `let` singletons in extension.ts and makes the run pipeline something you can drive from a test with a fake client instead of only through the command palette.

### Worth modernising

| Concern | Today | Recommended | Why |
| --- | --- | --- | --- |
| Validating untrusted LLM tool arguments | Hand-rolled coercion (`String(args.x ?? "")`, `stringArray`, `parseBlueprint`) at the bottom of src/engine/tools.ts | zod schemas in src/engine/toolSchemas.ts, one per tool, fed through `safeParse` | This is the only place untrusted input enters the extension, and the coercions silently turn missing fields into empty strings. zod gives you a precise error message to hand straight back to the model, which improves the agent loop as well as the code. |
| Automated tests | None — no `test` script; the 17 'test' hits in the index are all `RegExp.test()` calls | Node's built-in `node:test` + `node:assert`, with `test-fixtures/bad-app` as the input corpus | No new dependency, and the highest-risk code (`extractStructure`'s regex table, `buildModuleGraph`'s import resolution, `locateAnchor`) is pure functions over strings — the easiest thing in the world to table-test, and the thing most likely to break silently when a pattern is tweaked. |
| Continuous integration | Nothing — no .github/workflows, no Dockerfile, no pipeline of any kind | A single GitHub Actions workflow running `npm ci && npm run typecheck && npm run build` | You already have the scripts; CI just stops a broken build reaching a published .vsix. At this project's size one workflow file is the whole answer — no containers or release automation needed yet. |
| Provider configuration | `ProviderId` in src/llm/types.ts and the `ironbase.provider` enum in package.json are maintained by hand and have drifted; `ollama.baseUrl` and `autoFailover` are read but undeclared | Declare every setting getConfig() reads, and derive the package.json enums from `ALL_PROVIDERS` in a small build step (or assert the two match in a test) | Three providers' worth of code in AuthManager.build() is currently unreachable because the enum omits them and no command calls setApiKey. Either wire them up or delete them — dead branches in an auth manager are the ones you least want to guess about later. |
| CSP nonce generation | `createNonce()` in src/report/reportPanel.ts:188 builds the nonce from `Math.random()` | `import * as crypto from "node:crypto"` and `crypto.randomBytes(16).toString("base64url")` | A nonce is what stops injected markup executing in the webview; Math.random is predictable and there is no reason to use it when node:crypto is already available in the extension host (store.ts already imports it). Two-line change, low risk. |

## Findings

### High (3)

#### No test script and no CI, for a product whose core is hand-written regex heuristics

*Other* · medium effort

`package.json` has `build`, `watch`, `typecheck` and `package` scripts but no `test` script, and there is no `.github/workflows` directory. Everything the extension claims is derived from hand-written regexes in `src/memory/symbols.ts` and import-resolution heuristics in `src/memory/graph.ts` — exactly the kind of code that silently regresses when you tweak one pattern. Today the only way to know a change broke signal detection is to run the extension by hand on `test-fixtures/bad-app` and eyeball the output. `tsc --noEmit` catches type errors, not "this regex stopped matching `async def`". As the pattern list grows, every edit becomes a gamble.

**Fix:** Two steps, both cheap. (1) Add a CI workflow that runs `npm ci && npm run typecheck && npm run build` on every push — patch attached. (2) Add a `test` script using the built-in `node:test` runner (no new dependency) and write table-driven tests for the pure functions: `extractStructure` in `src/memory/symbols.ts` (feed it the fixture files and assert the expected `SignalKind`s come back), `buildModuleGraph` in `src/memory/graph.ts`, and `locateAnchor`/`reindent` in `src/engine/tools.ts`. `test-fixtures/bad-app` is already the perfect input corpus — turn it into assertions instead of a manual smoke test.

**Where:**

- [package.json:227](package.json#L227)
- [src/memory/symbols.ts:126](src/memory/symbols.ts#L126)

#### Settings schema in package.json has drifted from what src/config.ts actually reads

*Configuration & secrets* · small effort

`getConfig()` reads two settings that are not declared in `contributes.configuration`: `ironbase.ollama.baseUrl` (config.ts:37) and `ironbase.autoFailover` (config.ts:41). Undeclared settings do not appear in the Settings UI, get no validation, and VS Code marks them as "Unknown Configuration Setting" if a user types them by hand — so those two features are effectively unreachable and untestable by users. The same drift hits providers: `ProviderId` includes `kimi`, `deepseek` and `ollama` (they have entries in `AUTO_ORDER` and full `build()` cases), but the `ironbase.provider` enum in package.json only lists the three OAuth providers, so a user can never select them. And `AuthManager.setApiKey` — the only way to store a Kimi or DeepSeek key — is never called anywhere in the codebase. That is three providers' worth of code that can never execute: dead weight that still has to be read, typechecked and maintained.

**Fix:** Decide whether the API-key providers ship or not, and make the code say so either way. If they ship: declare `ironbase.ollama.baseUrl` and `ironbase.autoFailover` in `contributes.configuration` (patch attached), add `kimi`/`deepseek`/`ollama` to the `ironbase.provider` and `ironbase.disabledProviders` enums, and register an `ironbase.signInApiKey` command in `src/extension.ts` that prompts with `showInputBox({ password: true })` and calls `auth.setApiKey`. If they do not ship yet, delete them from `ALL_PROVIDERS`/`AUTO_ORDER`/`build()` and bring them back with the command. Longer term, generate the enum from the `ProviderId` union (or add a startup assertion in `src/config.ts`) so the two can never silently disagree again.

**Where:**

- [src/config.ts:38](src/config.ts#L38)
- [package.json:139](package.json#L139)
- [src/auth/authManager.ts:95](src/auth/authManager.ts#L95)

#### The workspace path sandbox is implemented three times, and one copy is missing entirely

*Separation of concerns* · small effort

Every path the model hands back is untrusted input, and the check that keeps it inside the workspace exists in two near-identical but not identical copies: `ToolRunner.resolve` in `src/engine/tools.ts:381` and `resolveInside` in `src/report/fixApplier.ts:185`. They differ in ordering and in how they treat an empty path. Worse, `ReportPanel.openFile` (`src/report/reportPanel.ts:132`) does no check at all — it joins the model-supplied `file` string straight onto the workspace root, so a report containing `../../../../etc/passwd` opens that file in the developer's editor when they click an evidence link. Duplicated security checks are the classic way a vulnerability gets half-fixed: someone patches a bypass in one copy, the other two stay open. This is the finding I would fix first.

**Fix:** Create one `src/util/paths.ts` exporting `resolveInsideRoot(root, relPath)` (patch attached) and make all three call sites use it: replace the body of `ToolRunner.resolve` and `resolveInside` with a delegation, and guard `ReportPanel.openFile` (second patch attached inlines the guard so it needs no new import — swap it for the shared helper once `src/util/paths.ts` exists). `src/util` is already the leaf module every other module depends on, so it is the right home. Then add a `node:test` case asserting `..`, `/etc/passwd`, `C:\\Windows` and `~/x` are all rejected — that is the test that stops this regressing.

**Where:**

- [src/engine/tools.ts:385](src/engine/tools.ts#L385)
- [src/report/fixApplier.ts:185](src/report/fixApplier.ts#L185)
- [src/report/reportPanel.ts:132](src/report/reportPanel.ts#L132)

### Medium (1)

#### Untrusted model JSON is validated by hand-rolled coercion spread across tools.ts

*Data access* · medium effort

`ToolRunner.run` casts whatever the model sent to `Record<string, unknown>` and then coerces field by field with `String(args.query ?? "")`, `numberOrUndefined`, `stringArray`, `clamp`, `parseBlueprint` and `parseScalability` — roughly 150 lines of bespoke parsing at the bottom of a 1044-line file. This is the one place in the extension where genuinely untrusted, unstructured input crosses into your domain objects, and it is the place with the least structure. `String(undefined ?? "")` silently produces `""` instead of an error, so a malformed tool call becomes a confusing empty result rather than a clear "the model sent the wrong shape" message, and the tool's JSON schema in `toolDefinitions()` can drift from the parser without anything noticing.

**Fix:** Add `zod` (one small dependency, the current standard for this) and define one schema per tool in a new `src/engine/toolSchemas.ts`: `const readFileArgs = z.object({ path: z.string().min(1), startLine: z.number().int().positive().optional(), ... })`. `ToolRunner.run` then does `const parsed = schema.safeParse(input)` and returns `{ content: parsed.error.message, isError: true }` on failure — which is genuinely useful feedback to send back to the model. Use `zod-to-json-schema`, or keep the JSON schema hand-written but assert once in a test that every tool in `toolDefinitions()` has a matching schema. That deletes `parseBlueprint`, `parseScalability`, `stringArray`, `numberOrUndefined` and `clamp` and shrinks `tools.ts` by a sixth.

**Where:**

- [src/engine/tools.ts:339](src/engine/tools.ts#L339)
- [src/engine/tools.ts:947](src/engine/tools.ts#L947)

---

Generated by IronBase on 8/5/2026, 8:05:45 PM using Claude (claude-opus-5). Capacity figures are theoretical estimates derived from the code, not measurements from a load test.
