package dev.ironbase.plugin.llm

import java.io.BufferedReader

/** One blank-line-delimited SSE block: an optional event name and its data. */
data class SseMessage(val event: String?, val data: String)

/**
 * Reads a Server-Sent Events body, yielding one message per block.
 *
 * A port of `readSse` in the VS Code extension's `src/llm/sse.ts`, adapted to
 * `BufferedReader.readLine()` rather than manual buffer scanning — Java
 * already normalizes CRLF/LF for us at that layer, which is most of what the
 * original function existed to do by hand.
 */
fun readSse(reader: BufferedReader): Sequence<SseMessage> = sequence {
    var event: String? = null
    val dataLines = mutableListOf<String>()

    fun flush(): SseMessage? {
        if (dataLines.isEmpty()) return null
        val msg = SseMessage(event, dataLines.joinToString("\n"))
        event = null
        dataLines.clear()
        return msg
    }

    while (true) {
        val line = reader.readLine() ?: break
        when {
            line.isEmpty() -> flush()?.let { yield(it) }
            line.startsWith(":") -> Unit // comment / heartbeat
            line.startsWith("event:") -> event = line.substring(6).trim()
            line.startsWith("data:") -> {
                val value = line.substring(5)
                dataLines.add(if (value.startsWith(" ")) value.substring(1) else value)
            }
            else -> Unit
        }
    }
    flush()?.let { yield(it) }
}
