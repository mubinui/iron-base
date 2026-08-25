package dev.ironbase.plugin.llm

/**
 * The provider-neutral message shape, mirroring `NeutralMessage` in the VS
 * Code extension's `src/llm/types.ts`.
 *
 * The skeleton only ever produces and consumes plain turns — no tool calls,
 * no cached system blocks, no raw provider blocks replayed verbatim. Porting
 * those belongs with porting the engine that uses them.
 */
data class ChatMessage(val role: Role, val text: String) {
    enum class Role { USER, ASSISTANT }
}

/** One chunk of a streaming reply. */
sealed interface StreamEvent {
    /** A slice of the assistant's reply text, as it arrives. */
    data class Text(val delta: String) : StreamEvent

    /** The stream ended normally, with what it cost. */
    data class Done(val inputTokens: Int, val outputTokens: Int) : StreamEvent
}

/** Raised for anything the caller should show as a failure, network or API. */
class LlmException(message: String, val status: Int? = null) : Exception(message)
