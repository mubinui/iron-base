package dev.ironbase.plugin.llm

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The request-serialization half of `AnthropicClient`, checked with no
 * network and no IntelliJ platform on the classpath — the point of splitting
 * `AnthropicWireFormat` out in the first place.
 */
class AnthropicWireFormatTest {

    @Test
    fun `a plain assistant turn sends content as a bare string`() {
        val body = AnthropicWireFormat.requestBody(
            history = listOf(Turn.User("hi"), Turn.Assistant("hello there")),
            tools = emptyList(),
            model = "claude-opus-5",
            maxTokens = 4096,
        )
        val messages = MiniJson.parse(body).get("messages").asList()
        assertEquals("hello there", messages[1].get("content").asString())
    }

    @Test
    fun `an assistant turn with a tool call sends content as blocks`() {
        val call = ToolCall(id = "call_1", name = "read_file", inputJson = """{"path":"a.kt"}""")
        val body = AnthropicWireFormat.requestBody(
            history = listOf(Turn.User("what is in a.kt?"), Turn.Assistant("Let me check.", listOf(call))),
            tools = emptyList(),
            model = "claude-opus-5",
            maxTokens = 4096,
        )
        val blocks = MiniJson.parse(body).get("messages").at(1).get("content").asList()
        assertEquals("text", blocks[0].get("type").asString())
        assertEquals("Let me check.", blocks[0].get("text").asString())
        assertEquals("tool_use", blocks[1].get("type").asString())
        assertEquals("call_1", blocks[1].get("id").asString())
        assertEquals("read_file", blocks[1].get("name").asString())
        assertEquals("a.kt", blocks[1].get("input").get("path").asString())
    }

    @Test
    fun `tool results become a user turn of tool_result blocks`() {
        val body = AnthropicWireFormat.requestBody(
            history = listOf(Turn.ToolResults(listOf(ToolResult("call_1", "3 lines", isError = false)))),
            tools = emptyList(),
            model = "claude-opus-5",
            maxTokens = 4096,
        )
        val message = MiniJson.parse(body).get("messages").at(0)
        assertEquals("user", message.get("role").asString())
        val block = message.get("content").at(0)
        assertEquals("tool_result", block.get("type").asString())
        assertEquals("call_1", block.get("tool_use_id").asString())
        assertEquals("3 lines", block.get("content").asString())
    }

    @Test
    fun `tools are included by name and schema when offered`() {
        val body = AnthropicWireFormat.requestBody(
            history = listOf(Turn.User("hi")),
            tools = listOf(ToolDef("read_file", "Reads a file.", """{"type":"object"}""")),
            model = "claude-opus-5",
            maxTokens = 4096,
        )
        val tools = MiniJson.parse(body).get("tools").asList()
        assertEquals("read_file", tools[0].get("name").asString())
        assertEquals("object", tools[0].get("input_schema").get("type").asString())
    }

    @Test
    fun `no tools key at all when none are offered`() {
        val body = AnthropicWireFormat.requestBody(
            history = listOf(Turn.User("hi")),
            tools = emptyList(),
            model = "claude-opus-5",
            maxTokens = 4096,
        )
        assertTrue(!body.contains("\"tools\""))
    }

    @Test
    fun `reads the anthropic error envelope`() {
        val message = AnthropicWireFormat.errorMessageFrom(
            """{"type":"error","error":{"type":"invalid_request_error","message":"model: field required"}}""",
            400,
        )
        assertEquals("model: field required", message)
    }

    @Test
    fun `falls back to a snippet when the body is not the error envelope`() {
        val message = AnthropicWireFormat.errorMessageFrom("<html>502 Bad Gateway</html>", 502)
        assertTrue(message.contains("502"))
        assertTrue(message.contains("Bad Gateway"))
    }
}
