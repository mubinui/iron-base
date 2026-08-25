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
 * This is a deliberately narrow port of `AnthropicClient` in the VS Code
 * extension's `src/llm/anthropicClient.ts`: no OAuth (the PKCE flow and its
 * browser-based capture belong with porting the auth manager, not the LLM
 * client), no tool calling, no prompt caching, no retry-on-401. What it does
 * do — send a conversation, stream the reply back token by token, surface a
 * readable error when the API rejects the request — is the one path the
 * skeleton's chat panel needs end to end.
 */
class AnthropicClient(private val apiKey: String, private val model: String) {

    private val http: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(20))
        .build()

    /**
     * Sends the conversation and streams the reply.
     *
     * `onEvent` is called from this method's own thread — the caller is on a
     * background thread already (see `ChatPanel`), so this never touches the
     * EDT. `isCancelled` is polled between SSE blocks, which is as fine-
     * grained as cancellation gets without threading a real interrupt through
     * the HTTP client.
     */
    fun chat(
        history: List<ChatMessage>,
        onEvent: (StreamEvent) -> Unit,
        isCancelled: () -> Boolean = { false },
    ) {
        val body = MiniJson.obj(
            "model" to model,
            "max_tokens" to 4096,
            "stream" to true,
            "messages" to MiniJson.RawJson(
                MiniJson.arr(
                    history.map { m ->
                        MiniJson.RawJson(
                            MiniJson.obj(
                                "role" to if (m.role == ChatMessage.Role.USER) "user" else "assistant",
                                "content" to m.text,
                            ),
                        )
                    },
                ),
            ),
        )

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
            throw LlmException(errorMessageFrom(text, response.statusCode()), response.statusCode())
        }

        var inputTokens = 0
        var outputTokens = 0

        BufferedReader(InputStreamReader(response.body(), StandardCharsets.UTF_8)).use { reader ->
            for (msg in readSse(reader)) {
                if (isCancelled()) return
                val payload = MiniJson.parse(msg.data)
                when (payload.get("type").asString()) {
                    "message_start" -> {
                        inputTokens = payload.get("message").get("usage").get("input_tokens").asInt() ?: 0
                    }
                    "content_block_delta" -> {
                        val delta = payload.get("delta")
                        if (delta.get("type").asString() == "text_delta") {
                            onEvent(StreamEvent.Text(delta.get("text").asString() ?: ""))
                        }
                    }
                    "message_delta" -> {
                        outputTokens = payload.get("usage").get("output_tokens").asInt() ?: outputTokens
                    }
                    "message_stop" -> {
                        onEvent(StreamEvent.Done(inputTokens, outputTokens))
                    }
                    else -> Unit // content_block_start/stop, ping — nothing this skeleton renders
                }
            }
        }
    }

    /**
     * Anthropic's error envelope is `{"type":"error","error":{"type":...,
     * "message":...}}`; anything that does not parse that way (a proxy's
     * plain-text 502, an HTML challenge page) falls back to a snippet of the
     * raw body rather than a bare stack trace.
     */
    private fun errorMessageFrom(body: String, status: Int): String {
        val parsed = runCatching { MiniJson.parse(body) }.getOrNull()
        val apiMessage = parsed?.get("error")?.get("message")?.asString()
        if (apiMessage != null) return apiMessage
        val snippet = body.trim().take(200).replace(Regex("\\s+"), " ")
        return "Anthropic returned HTTP $status${if (snippet.isNotEmpty()) ": $snippet" else ""}"
    }

    private companion object {
        const val API_URL = "https://api.anthropic.com/v1/messages"
        const val API_VERSION = "2023-06-01"
    }
}
