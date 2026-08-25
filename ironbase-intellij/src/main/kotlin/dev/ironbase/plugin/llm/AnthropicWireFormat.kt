package dev.ironbase.plugin.llm

/**
 * Turns a `Turn` history and a `ToolDef` list into an Anthropic Messages API
 * request body, and reads a streamed event payload back into the pieces
 * `AnthropicClient` needs. Kept apart from the client itself — which is all
 * HTTP and I/O — so this half, the actual wire-format logic, can be asserted
 * against directly with no network and no IntelliJ platform on the classpath.
 */
object AnthropicWireFormat {

    fun requestBody(
        history: List<Turn>,
        tools: List<ToolDef>,
        model: String,
        maxTokens: Int,
        system: String? = null,
    ): String {
        val pairs = mutableListOf<Pair<String, Any?>>(
            "model" to model,
            "max_tokens" to maxTokens,
            "stream" to true,
            "messages" to MiniJson.RawJson(MiniJson.arr(history.map { MiniJson.RawJson(messageOf(it)) })),
        )
        if (!system.isNullOrEmpty()) pairs.add("system" to system)
        if (tools.isNotEmpty()) {
            pairs.add(
                "tools" to MiniJson.RawJson(
                    MiniJson.arr(
                        tools.map { t ->
                            MiniJson.RawJson(
                                MiniJson.obj(
                                    "name" to t.name,
                                    "description" to t.description,
                                    "input_schema" to MiniJson.RawJson(t.inputSchemaJson),
                                ),
                            )
                        },
                    ),
                ),
            )
        }
        return MiniJson.obj(*pairs.toTypedArray())
    }

    /**
     * One `Turn` as an Anthropic message. A plain `Assistant` turn with no
     * tool calls sends `content` as a bare string, matching what the rest of
     * the API surface expects for ordinary text; the moment there is a tool
     * call — or a tool result to report — `content` becomes a block array,
     * which is the only shape Anthropic accepts for either.
     */
    private fun messageOf(turn: Turn): String = when (turn) {
        is Turn.User -> MiniJson.obj("role" to "user", "content" to turn.text)

        is Turn.Assistant -> {
            val content = if (turn.toolCalls.isEmpty()) {
                MiniJson.string(turn.text)
            } else {
                val blocks = mutableListOf<MiniJson.RawJson>()
                if (turn.text.isNotEmpty()) {
                    blocks.add(MiniJson.RawJson(MiniJson.obj("type" to "text", "text" to turn.text)))
                }
                for (call in turn.toolCalls) {
                    blocks.add(
                        MiniJson.RawJson(
                            MiniJson.obj(
                                "type" to "tool_use",
                                "id" to call.id,
                                "name" to call.name,
                                "input" to MiniJson.RawJson(call.inputJson.ifBlank { "{}" }),
                            ),
                        ),
                    )
                }
                MiniJson.arr(blocks)
            }
            MiniJson.obj("role" to "assistant", "content" to MiniJson.RawJson(content))
        }

        is Turn.ToolResults -> MiniJson.obj(
            "role" to "user",
            "content" to MiniJson.RawJson(
                MiniJson.arr(
                    turn.results.map { r ->
                        MiniJson.RawJson(
                            MiniJson.obj(
                                "type" to "tool_result",
                                "tool_use_id" to r.callId,
                                "content" to r.content,
                                "is_error" to r.isError,
                            ),
                        )
                    },
                ),
            ),
        )
    }

    /**
     * Anthropic's error envelope is `{"type":"error","error":{"type":...,
     * "message":...}}`; anything that does not parse that way (a proxy's
     * plain-text 502, an HTML challenge page) falls back to a snippet of the
     * raw body rather than a bare stack trace.
     */
    fun errorMessageFrom(body: String, status: Int): String {
        val parsed = runCatching { MiniJson.parse(body) }.getOrNull()
        val apiMessage = parsed?.get("error")?.get("message")?.asString()
        if (apiMessage != null) return apiMessage
        val snippet = body.trim().take(200).replace(Regex("\\s+"), " ")
        return "Anthropic returned HTTP $status${if (snippet.isNotEmpty()) ": $snippet" else ""}"
    }
}
