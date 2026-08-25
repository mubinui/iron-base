package dev.ironbase.plugin.llm

import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets
import java.time.Duration

/**
 * A minimal, streaming Anthropic Messages API client — API key auth only.
 *
 * A narrow port of `AnthropicClient` in the VS Code extension's
 * `src/llm/anthropicClient.ts`: no OAuth (the PKCE flow and its browser-based
 * capture belong with porting the auth manager, not the LLM client), no
 * prompt caching, no retry-on-401. Tool calling is ported, since the agent
 * loop needs it — text and tool-use blocks both stream, and this assembles
 * both before handing back a settled `ChatTurnResult`.
 */
class AnthropicClient(private val apiKey: String, private val model: String) {

    private val http: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(20))
        .build()

    /**
     * Sends the conversation and streams the reply.
     *
     * `onEvent` fires from this method's own thread — the caller is already on
     * a background thread (see `ChatPanel`/`AgentLoop`), so this never touches
     * the EDT. The return value is the settled turn: the full text, and any
     * tool calls the model made, once the stream has actually finished —
     * there is nothing useful to act on from a tool call until its arguments
     * have fully arrived.
     */
    fun send(
        history: List<Turn>,
        tools: List<ToolDef> = emptyList(),
        system: String? = null,
        onEvent: (StreamEvent) -> Unit = {},
        isCancelled: () -> Boolean = { false },
    ): ChatTurnResult {
        val body = AnthropicWireFormat.requestBody(history, tools, model, MAX_TOKENS, system)

        val request = HttpRequest.newBuilder(URI.create(API_URL))
            .header("content-type", "application/json")
            .header("anthropic-version", API_VERSION)
            .header("x-api-key", apiKey)
            .POST(HttpRequest.BodyPublishers.ofString(body))
            .build()

        val response = try {
            http.send(request, HttpResponse.BodyHandlers.ofInputStream())
        } catch (err: java.io.IOException) {
            throw LlmException("Could not reach the Anthropic API: ${err.message}")
        }

        if (response.statusCode() !in 200..299) {
            val text = response.body().bufferedReader(StandardCharsets.UTF_8).readText()
            throw LlmException(AnthropicWireFormat.errorMessageFrom(text, response.statusCode()), response.statusCode())
        }

        var text = StringBuilder()
        var stopReason = "end_turn"
        // Keyed by content-block index, same as the TS client: a tool call's
        // arguments stream in as fragments of one JSON object, one
        // `input_json_delta` at a time, and there is nothing valid to parse
        // until `content_block_stop` closes it out.
        val toolCallsByIndex = LinkedHashMap<Int, PendingToolCall>()

        BufferedReader(InputStreamReader(response.body(), StandardCharsets.UTF_8)).use { reader ->
            for (msg in readSse(reader)) {
                if (isCancelled()) break
                val payload = MiniJson.parse(msg.data)
                when (payload.get("type").asString()) {
                    "content_block_start" -> {
                        val index = payload.get("index").asInt() ?: continue
                        val block = payload.get("content_block")
                        if (block.get("type").asString() == "tool_use") {
                            val name = block.get("name").asString() ?: ""
                            toolCallsByIndex[index] = PendingToolCall(block.get("id").asString() ?: "", name)
                            onEvent(StreamEvent.ToolCallStarted(name))
                        }
                    }
                    "content_block_delta" -> {
                        val index = payload.get("index").asInt() ?: continue
                        val delta = payload.get("delta")
                        when (delta.get("type").asString()) {
                            "text_delta" -> {
                                val chunk = delta.get("text").asString() ?: ""
                                text.append(chunk)
                                onEvent(StreamEvent.Text(chunk))
                            }
                            "input_json_delta" -> {
                                toolCallsByIndex[index]?.let { it.json.append(delta.get("partial_json").asString() ?: "") }
                            }
                        }
                    }
                    "message_delta" -> {
                        payload.get("delta").get("stop_reason").asString()?.let { stopReason = it }
                    }
                    "message_stop" -> Unit // the loop ends naturally when the body closes
                    else -> Unit // message_start, content_block_stop, ping — nothing more to capture
                }
            }
        }

        return ChatTurnResult(
            text = text.toString(),
            toolCalls = toolCallsByIndex.values.map { ToolCall(it.id, it.name, it.json.toString()) },
            stopReason = stopReason,
        )
    }

    private class PendingToolCall(val id: String, val name: String) {
        val json = StringBuilder()
    }

    private companion object {
        const val API_URL = "https://api.anthropic.com/v1/messages"
        const val API_VERSION = "2023-06-01"
        const val MAX_TOKENS = 4096
    }
}
