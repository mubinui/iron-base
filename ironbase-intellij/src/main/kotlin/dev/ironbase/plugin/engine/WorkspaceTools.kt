package dev.ironbase.plugin.engine

import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.VirtualFile
import dev.ironbase.plugin.llm.MiniJson
import dev.ironbase.plugin.llm.ToolCall
import dev.ironbase.plugin.llm.ToolDef

/**
 * What one tool call answered — content for the model, whether it counts as
 * a failure, and a short note for whatever surfaces a trace of the run.
 * Mirrors `ToolOutcome` in the VS Code extension's `src/engine/tools.ts`.
 */
data class ToolOutcome(val content: String, val isError: Boolean = false, val note: String? = null)

/**
 * `read_file`, `list_dir` and `search`, ported from `src/engine/tools.ts` —
 * the three read-only tools that need nothing but filesystem access. Left out
 * of this pass: `find_relevant` and `list_signals`, which answer from the
 * project index rather than the disk, and the index has not been ported.
 *
 * Every VFS access goes through `ReadAction.compute`, which is what
 * IntelliJ's threading model requires for anything touching the virtual
 * file system or its content — this runs on a background thread (the agent
 * loop's), never the EDT, so skipping it is not just a style question.
 */
object WorkspaceTools {

    const val READ_FILE = "read_file"
    const val LIST_DIR = "list_dir"
    const val SEARCH = "search"

    private const val MAX_DIR_ENTRIES = 200
    private const val MAX_SEARCH_RESULTS = 50
    private const val MAX_MATCH_CHARS = 200
    private const val MAX_FILES_SCANNED = 1500
    private const val MAX_SEARCH_FILE_BYTES = 512 * 1024
    private const val SEARCH_TIME_BUDGET_MS = 3000L
    private val NOISE_DIRS = setOf("node_modules", "dist", "build", ".git", "out", "vendor", "coverage")

    // A raw NUL char literal survived poorly through this session's own tooling
    // more than once; Char(0) needs no escape sequence to go wrong in the first
    // place, which is worth more here than the one-line brevity of '\\u0000'.
    private val NUL_CHAR = Char(0)

    /**
     * A quantified group that is itself quantified — `(a+)+`, `(x*)*`,
     * `(ab+)+`. The classic catastrophic-backtracking shape, refused before it
     * reaches Java's regex engine: the pattern comes straight from a model,
     * and one bad pattern against the wrong line would hang the thread
     * running it with no way to cancel mid-match.
     */
    private val NESTED_QUANTIFIER = Regex("""\([^)]*[+*][^)]*\)\s*[+*{]""")

    fun toolDefs(): List<ToolDef> = listOf(
        ToolDef(
            name = LIST_DIR,
            description = "List the contents of a directory in the workspace.",
            inputSchemaJson = MiniJson.obj(
                "type" to "object",
                "properties" to MiniJson.RawJson(
                    MiniJson.obj(
                        "path" to MiniJson.RawJson(
                            MiniJson.obj(
                                "type" to "string",
                                "description" to "Workspace-relative directory path. Use \"\" or \".\" for the root.",
                            ),
                        ),
                    ),
                ),
                "required" to MiniJson.RawJson(MiniJson.arr(listOf("path"))),
            ),
        ),
        ToolDef(
            name = READ_FILE,
            description = "Read a file from the workspace. Returns numbered lines so you can cite exact line numbers as evidence. Prefer a line range for large files.",
            inputSchemaJson = MiniJson.obj(
                "type" to "object",
                "properties" to MiniJson.RawJson(
                    MiniJson.obj(
                        "path" to MiniJson.RawJson(MiniJson.obj("type" to "string", "description" to "Workspace-relative file path.")),
                        "startLine" to MiniJson.RawJson(MiniJson.obj("type" to "number", "description" to "First line to return (1-based).")),
                        "endLine" to MiniJson.RawJson(MiniJson.obj("type" to "number", "description" to "Last line to return (inclusive).")),
                    ),
                ),
                "required" to MiniJson.RawJson(MiniJson.arr(listOf("path"))),
            ),
        ),
        ToolDef(
            name = SEARCH,
            description = "Search file contents across the workspace. Returns `path:line: text` matches. Cheaper than reading whole files.",
            inputSchemaJson = MiniJson.obj(
                "type" to "object",
                "properties" to MiniJson.RawJson(
                    MiniJson.obj(
                        "pattern" to MiniJson.RawJson(MiniJson.obj("type" to "string", "description" to "Text or regular expression to find.")),
                        "isRegex" to MiniJson.RawJson(MiniJson.obj("type" to "boolean", "description" to "Treat the pattern as a regex. Default false.")),
                        "glob" to MiniJson.RawJson(MiniJson.obj("type" to "string", "description" to "Optional include glob, e.g. \"**/*.kt\".")),
                    ),
                ),
                "required" to MiniJson.RawJson(MiniJson.arr(listOf("pattern"))),
            ),
        ),
    )

    /** Runs one tool call against `root`, dispatching on its name. */
    fun run(root: VirtualFile, call: ToolCall): ToolOutcome {
        val args = MiniJson.parse(call.inputJson.ifBlank { "{}" })
        return when (call.name) {
            READ_FILE -> readFile(root, args.get("path").asString() ?: "", args.get("startLine").asInt(), args.get("endLine").asInt())
            LIST_DIR -> listDir(root, args.get("path").asString() ?: "")
            SEARCH -> search(
                root,
                args.get("pattern").asString() ?: "",
                (args.get("isRegex") as? MiniJson.JBool)?.bool ?: false,
                args.get("glob").asString(),
            )
            else -> ToolOutcome("Unknown tool: ${call.name}", isError = true)
        }
    }

    // --- read_file -----------------------------------------------------

    private fun readFile(root: VirtualFile, relPath: String, startLine: Int?, endLine: Int?): ToolOutcome {
        val file = when (val resolved = resolve(root, relPath)) {
            Resolved.OutsideWorkspace -> return ToolOutcome(
                "Path is outside the workspace: $relPath", isError = true, note = "outside the workspace",
            )
            Resolved.NotFound -> return ToolOutcome(
                "No such file: $relPath. Use list_dir or search to find the correct path.",
                isError = true,
                note = "no such file",
            )
            is Resolved.Found -> resolved.file
        }
        if (file.isDirectory) {
            return ToolOutcome("$relPath is a directory, not a file.", isError = true, note = "is a directory")
        }
        val text = try {
            ReadAction.compute<String, Exception> { VfsUtilCore.loadText(file) }
        } catch (err: Exception) {
            return ToolOutcome(
                "No such file: $relPath. Use list_dir or search to find the correct path.",
                isError = true,
                note = "no such file",
            )
        }

        val allLines = text.split(Regex("\r?\n"))
        val from = maxOf(1, startLine ?: 1)
        val to = minOf(allLines.size, endLine ?: allLines.size)
        val selected = if (from <= to) allLines.subList(from - 1, to) else emptyList()
        val numbered = selected.mapIndexed { i, line -> "${from + i}\t$line" }.joinToString("\n")

        val (capped, truncated) = truncateUtf8(numbered, MAX_FILE_READ_BYTES)
        val header = "$relPath (lines $from-$to of ${allLines.size})"
        val note = if (selected.size >= allLines.size) {
            count(allLines.size, "line")
        } else {
            "${selected.size} of ${allLines.size} lines"
        }
        return ToolOutcome(
            "$header\n$capped${if (truncated) "\n… [truncated: request a narrower line range]" else ""}",
            note = note,
        )
    }

    // --- list_dir --------------------------------------------------------

    private fun listDir(root: VirtualFile, relPath: String): ToolOutcome {
        val dir = when (val resolved = resolve(root, relPath)) {
            Resolved.OutsideWorkspace -> return ToolOutcome(
                "Path is outside the workspace: $relPath", isError = true, note = "outside the workspace",
            )
            Resolved.NotFound -> return ToolOutcome(
                "No such directory: $relPath.", isError = true, note = "no such directory",
            )
            is Resolved.Found -> resolved.file
        }
        if (!dir.isDirectory) return ToolOutcome("$relPath is not a directory.", isError = true, note = "not a directory")

        val children = ReadAction.compute<List<VirtualFile>, Exception> { dir.children.toList() }
        val label = relPath.ifBlank { "." }
        if (children.isEmpty()) return ToolOutcome("$label is empty.", note = "empty")

        val sorted = children.sortedBy { it.name.lowercase() }
        val shown = sorted.take(MAX_DIR_ENTRIES)
        val lines = shown.map { if (it.isDirectory) "${it.name}/" else it.name }.toMutableList()
        if (sorted.size > shown.size) lines.add("… +${sorted.size - shown.size} more entries")
        return ToolOutcome("$label:\n${lines.joinToString("\n")}", note = count(sorted.size, "entry", "entries"))
    }

    // --- search ------------------------------------------------------------

    private fun search(root: VirtualFile, pattern: String, isRegex: Boolean, glob: String?): ToolOutcome {
        if (pattern.isEmpty()) return ToolOutcome("`pattern` is required.", isError = true)

        if (isRegex && NESTED_QUANTIFIER.containsMatchIn(pattern)) {
            return ToolOutcome(
                "That pattern nests one quantifier inside another, which can hang the IDE. " +
                    "Rewrite it without the nesting, or search for a literal substring instead.",
                isError = true,
            )
        }

        val matcher = try {
            Regex(if (isRegex) pattern else Regex.escape(pattern), RegexOption.IGNORE_CASE)
        } catch (err: Exception) {
            return ToolOutcome("Invalid regular expression: ${err.message}", isError = true, note = "bad pattern")
        }
        val globRegex = glob?.let { globToRegex(it) }

        val matches = mutableListOf<String>()
        var filesScanned = 0
        var filesVisited = 0
        var timedOut = false
        val deadline = System.currentTimeMillis() + SEARCH_TIME_BUDGET_MS

        fun visit(dir: VirtualFile) {
            if (matches.size >= MAX_SEARCH_RESULTS || timedOut) return
            val children = ReadAction.compute<List<VirtualFile>, Exception> { dir.children.toList() }
            for (child in children) {
                if (matches.size >= MAX_SEARCH_RESULTS) return
                if (System.currentTimeMillis() > deadline) {
                    timedOut = true
                    return
                }
                if (child.isDirectory) {
                    if (child.name in NOISE_DIRS) continue
                    visit(child)
                    continue
                }
                if (filesVisited >= MAX_FILES_SCANNED) return
                filesVisited++
                val rel = relativePath(root, child)
                if (globRegex != null && !globRegex.matches(rel)) continue
                if (child.length > MAX_SEARCH_FILE_BYTES) continue

                val text = try {
                    ReadAction.compute<String, Exception> { VfsUtilCore.loadText(child) }
                } catch (err: Exception) {
                    continue
                }
                if (text.contains(NUL_CHAR)) continue // skip binary files
                filesScanned++

                for ((i, line) in text.split(Regex("\r?\n")).withIndex()) {
                    if (matches.size >= MAX_SEARCH_RESULTS) break
                    if (matcher.containsMatchIn(line)) {
                        matches.add("$rel:${i + 1}: ${line.trim().take(MAX_MATCH_CHARS)}")
                    }
                }
            }
        }
        visit(root)

        val ranOut = if (timedOut) {
            "\n… stopped after ${SEARCH_TIME_BUDGET_MS / 1000}s and $filesScanned files; narrow the pattern or pass a glob."
        } else {
            ""
        }
        if (matches.isEmpty()) {
            return ToolOutcome("No matches for $pattern (searched $filesScanned files).$ranOut", note = "no match")
        }
        val capped = matches.size >= MAX_SEARCH_RESULTS
        return ToolOutcome(
            "${matches.size} match(es) for $pattern:\n${matches.joinToString("\n")}" +
                if (capped) "\n… result cap reached; narrow the pattern for more." else ranOut,
            note = "${count(matches.size, "match", "matches")}${if (capped) "+" else ""}",
        )
    }

    // --- shared ----------------------------------------------------------

    /**
     * What `resolve` found, keeping "this path would step outside the
     * workspace" apart from "this path is fine but nothing is there" — the
     * first bug this class shipped with collapsed both into one `null` and a
     * request for a file that had simply never existed came back saying it
     * was outside the workspace, which was not true and sent whoever read it
     * looking in the wrong direction entirely.
     */
    private sealed interface Resolved {
        data class Found(val file: VirtualFile) : Resolved
        object OutsideWorkspace : Resolved
        object NotFound : Resolved
    }

    /**
     * Resolves a workspace-relative path against `root`, refusing anything
     * that would step outside it — the same containment `resolveInside` in
     * the VS Code extension's `src/util/paths.ts` enforces.
     */
    private fun resolve(root: VirtualFile, relPath: String): Resolved {
        val cleaned = relPath.trim().removePrefix("/")
        if (cleaned.isEmpty() || cleaned == ".") return Resolved.Found(root)
        if (cleaned.split("/").any { it == ".." }) return Resolved.OutsideWorkspace
        val file = ReadAction.compute<VirtualFile?, Exception> { root.findFileByRelativePath(cleaned) }
        return if (file != null) Resolved.Found(file) else Resolved.NotFound
    }

    private fun relativePath(root: VirtualFile, file: VirtualFile): String {
        val prefix = root.path.trimEnd('/') + "/"
        return if (file.path.startsWith(prefix)) file.path.substring(prefix.length) else file.path
    }

    // Supports the ** and * and ? wildcards only — enough for a pattern shaped like: two stars, slash, star, dot, kt
    private fun globToRegex(glob: String): Regex {
        val sb = StringBuilder()
        var i = 0
        while (i < glob.length) {
            when {
                glob.startsWith("**/", i) -> { sb.append("(?:.*/)?"); i += 3 }
                glob[i] == '*' -> { sb.append("[^/]*"); i++ }
                glob[i] == '?' -> { sb.append("[^/]"); i++ }
                glob[i] in ".()+^$|\\[]{}" -> { sb.append('\\').append(glob[i]); i++ }
                else -> { sb.append(glob[i]); i++ }
            }
        }
        return Regex(sb.toString())
    }

    private fun truncateUtf8(text: String, maxBytes: Int): Pair<String, Boolean> {
        if (text.toByteArray(Charsets.UTF_8).size <= maxBytes) return text to false
        var sliced = text
        while (sliced.toByteArray(Charsets.UTF_8).size > maxBytes && sliced.isNotEmpty()) {
            sliced = sliced.substring(0, (sliced.length * 0.9).toInt())
        }
        return sliced to true
    }

    private fun count(n: Int, singular: String, plural: String = "${singular}s") =
        "$n ${if (n == 1) singular else plural}"

    /** The default in the VS Code extension's `ironbase.maxFileReadBytes` setting. */
    private const val MAX_FILE_READ_BYTES = 64_000
}
