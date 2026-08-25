package dev.ironbase.plugin.llm

/**
 * The provider-neutral message shape, mirroring `NeutralMessage` in the VS
 * Code extension's `src/llm/types.ts` — now a three-way union rather than
 * plain text, since a tool-calling loop needs to replay what a tool was
 * asked to do and what it answered, not just what was said.
 */
sealed interface Turn {
    data class User(val text: String) : Turn
    data class Assistant(val text: String, val toolCalls: List<ToolCall> = emptyList()) : Turn
    data class ToolResults(val results: List<ToolResult>) : Turn
}

/** One call the model asked for, with its arguments still as raw JSON text. */
data class ToolCall(val id: String, val name: String, val inputJson: String)

/** What running one `ToolCall` produced, keyed back to it by `callId`. */
data class ToolResult(val callId: String, val content: String, val isError: Boolean = false)

/** A tool the model may call — schema and prose, nothing that runs it. */
data class ToolDef(val name: String, val description: String, val inputSchemaJson: String)

/** One chunk of a streaming reply. */
sealed interface StreamEvent {
    /** A slice of the assistant's reply text, as it arrives. */
    data class Text(val delta: String) : StreamEvent

    /** A tool call started — enough to show "reading src/Foo.kt" while it runs. */
    data class ToolCallStarted(val name: String) : StreamEvent
}

/**
 * What one turn with the model came back with, once the stream has finished.
 *
 * `onEvent` (in `AnthropicClient.send`) carries the incremental text as it
 * arrives, for the panel to render live; this is the settled result the
 * agent loop acts on afterward — whether to run tools, and what to say if not.
 */
data class ChatTurnResult(val text: String, val toolCalls: List<ToolCall>, val stopReason: String)

/** Raised for anything the caller should show as a failure, network or API. */
class LlmException(message: String, val status: Int? = null) : Exception(message)
