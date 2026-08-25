package dev.ironbase.plugin.llm

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Exercises `MiniJson` against the two things it actually has to get right:
 * writing a request body that survives a round trip, and reading the handful
 * of streamed-event shapes `AnthropicClient` pulls fields out of.
 */
class MiniJsonTest {

    @Test
    fun `writes and reads back a request body`() {
        val body = MiniJson.obj(
            "model" to "claude-opus-5",
            "max_tokens" to 4096,
            "stream" to true,
            "messages" to MiniJson.RawJson(
                MiniJson.arr(
                    listOf(MiniJson.RawJson(MiniJson.obj("role" to "user", "content" to "hi \"there\"\nline two"))),
                ),
            ),
        )
        val parsed = MiniJson.parse(body)
        assertEquals("claude-opus-5", parsed.get("model").asString())
        assertEquals(4096, parsed.get("max_tokens").asInt())
        assertEquals(
            "hi \"there\"\nline two",
            parsed.get("messages").at(0).get("content").asString(),
        )
    }

    @Test
    fun `reads a content_block_delta text event`() {
        val payload = MiniJson.parse(
            """{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}""",
        )
        assertEquals("content_block_delta", payload.get("type").asString())
        assertEquals("text_delta", payload.get("delta").get("type").asString())
        assertEquals("hello", payload.get("delta").get("text").asString())
    }

    @Test
    fun `reads nested usage counts from message_start`() {
        val payload = MiniJson.parse(
            """{"type":"message_start","message":{"usage":{"input_tokens":123,"cache_read_input_tokens":0}}}""",
        )
        assertEquals(123, payload.get("message").get("usage").get("input_tokens").asInt())
    }

    @Test
    fun `a missing key answers null rather than throwing`() {
        val payload = MiniJson.parse("""{"type":"ping"}""")
        assertNull(payload.get("delta").get("text").asString())
        assertNull(payload.get("nope").asInt())
    }

    @Test
    fun `reads the anthropic error envelope`() {
        val payload = MiniJson.parse(
            """{"type":"error","error":{"type":"invalid_request_error","message":"model: field required"}}""",
        )
        assertEquals("model: field required", payload.get("error").get("message").asString())
    }
}
