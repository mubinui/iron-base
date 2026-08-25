package dev.ironbase.plugin.engine

import com.intellij.openapi.vfs.VirtualFile
import dev.ironbase.plugin.llm.AnthropicClient
import dev.ironbase.plugin.llm.MiniJson
import dev.ironbase.plugin.llm.StreamEvent
import dev.ironbase.plugin.llm.ToolCall
import dev.ironbase.plugin.llm.ToolResult
import dev.ironbase.plugin.llm.Turn

/**
 * The read-only slice of the VS Code extension's tool-calling loop
 * (`src/engine/codingSession.ts`'s `runTools`, minus everything that writes):
 * send the conversation, and while the model keeps asking for tools, run
 * them and send back what they found, until it answers in plain text or a
 * turn cap is hit.
 *
 * Sequential rather than the original's parallel-reads fan-out — this is one
 * loop with one caller (`ChatPanel`, on one background thread), and there is
 * nothing yet for a second call to race against. Worth revisiting once
 * something here can actually run two tools at once.
 */
class AgentLoop(private val client: AnthropicClient, private val root: VirtualFile) {

    sealed interface Progress {
        data class Text(val delta: String) : Progress
        data class ToolStarted(val name: String, val summary: String) : Progress
        data class ToolFinished(val note: String?, val ok: Boolean) : Progress
    }

    /**
     * Runs the loop, mutating `history` in place turn by turn — so if this
     * throws partway through (a network error mid-loop), whatever the model
     * already said and did is still there for the next call rather than lost.
     * Returns the assistant's final text.
     */
    fun run(
        history: MutableList<Turn>,
        onProgress: (Progress) -> Unit,
        isCancelled: () -> Boolean = { false },
    ): String {
        var finalText = ""
        repeat(MAX_ITERATIONS) {
            if (isCancelled()) return finalText

            val result = client.send(
                history = history,
                tools = WorkspaceTools.toolDefs(),
                system = SYSTEM_PROMPT,
                onEvent = { event ->
                    if (event is StreamEvent.Text) onProgress(Progress.Text(event.delta))
                },
                isCancelled = isCancelled,
            )
            finalText = result.text
            history.add(Turn.Assistant(result.text, result.toolCalls))

            if (result.toolCalls.isEmpty()) return finalText
            if (isCancelled()) return finalText

            val results = result.toolCalls.map { call -> runOne(call, onProgress) }
            history.add(Turn.ToolResults(results))
        }
        return finalText
    }

    private fun runOne(call: ToolCall, onProgress: (Progress) -> Unit): ToolResult {
        onProgress(Progress.ToolStarted(call.name, summarize(call)))
        val outcome = WorkspaceTools.run(root, call)
        onProgress(Progress.ToolFinished(outcome.note, ok = !outcome.isError))
        return ToolResult(call.id, outcome.content, outcome.isError)
    }

    /** The one-line label a call gets in the panel, before its result is known. */
    private fun summarize(call: ToolCall): String {
        val args = MiniJson.parse(call.inputJson.ifBlank { "{}" })
        return when (call.name) {
            WorkspaceTools.READ_FILE, WorkspaceTools.LIST_DIR -> args.get("path").asString() ?: ""
            WorkspaceTools.SEARCH -> args.get("pattern").asString() ?: ""
            else -> ""
        }
    }

    private companion object {
        // A budget-limits cap matching the shape of the VS Code engine's own
        // guard against a stuck loop, not a tuned value — there is no telemetry
        // here yet to tune it against.
        const val MAX_ITERATIONS = 20

        val SYSTEM_PROMPT = """
            You are IronBase, an AI coding assistant running inside IntelliJ IDEA.

            You can read files, list directories, and search file contents in the
            open project using the tools available to you. Use them before
            answering anything about the code — do not guess at what a file
            contains or where something lives. Cite real file paths and line
            numbers when you reference code.

            This is an early build: you can only read the project, not change it.
            If asked to make an edit, explain what you would change and where,
            since you have no tool to write it yourself yet.
        """.trimIndent()
    }
}
