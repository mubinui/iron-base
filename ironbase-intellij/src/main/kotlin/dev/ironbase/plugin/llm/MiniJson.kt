package dev.ironbase.plugin.llm

/**
 * The smallest JSON reader and writer that can carry an Anthropic request out
 * and its streamed events back, written by hand rather than pulled in as a
 * dependency.
 *
 * The IntelliJ Platform bundles its own JSON library inside the IDE's
 * classloader, and a plugin that also declares one risks resolving to
 * whichever copy the platform loads first — a real source of version-skew
 * bugs that show up only at runtime, in a different IDE build. For the two
 * fixed, small shapes this client needs, hand-rolling both directions is
 * less code than negotiating that, and has nothing to go wrong at a version
 * boundary.
 */
object MiniJson {

    // ---- Writing ------------------------------------------------------

    fun obj(vararg pairs: Pair<String, Any?>): String =
        pairs.joinToString(",", "{", "}") { (k, v) -> "${string(k)}:${value(v)}" }

    fun arr(items: List<Any?>): String = items.joinToString(",", "[", "]") { value(it) }

    private fun value(v: Any?): String = when (v) {
        null -> "null"
        is String -> string(v)
        is Boolean -> v.toString()
        is Int, is Long, is Double -> v.toString()
        is RawJson -> v.text
        else -> throw IllegalArgumentException("MiniJson cannot write a ${v::class}")
    }

    /** Marks a string as already-serialized JSON, so `obj`/`arr` splice it in raw. */
    data class RawJson(val text: String)

    fun string(s: String): String {
        val out = StringBuilder(s.length + 2)
        out.append('"')
        for (c in s) {
            when (c) {
                '"' -> out.append("\\\"")
                '\\' -> out.append("\\\\")
                '\n' -> out.append("\\n")
                '\r' -> out.append("\\r")
                '\t' -> out.append("\\t")
                else -> if (c.code < 0x20) out.append("\\u%04x".format(c.code)) else out.append(c)
            }
        }
        out.append('"')
        return out.toString()
    }

    // ---- Reading --------------------------------------------------------

    /** A parsed value, navigated with `get`/`asString`/etc. rather than cast. */
    sealed class Value {
        open fun get(key: String): Value = Missing
        open fun at(index: Int): Value = Missing
        open fun asString(): String? = null
        open fun asInt(): Int? = null
        open fun asList(): List<Value> = emptyList()
    }

    data class JObject(val fields: Map<String, Value>) : Value() {
        override fun get(key: String): Value = fields[key] ?: Missing
    }

    data class JArray(val items: List<Value>) : Value() {
        override fun at(index: Int): Value = items.getOrNull(index) ?: Missing
        override fun asList(): List<Value> = items
    }

    data class JString(val text: String) : Value() {
        override fun asString(): String = text
    }

    data class JNumber(val raw: String) : Value() {
        override fun asInt(): Int? = raw.toDoubleOrNull()?.toInt()
    }

    data class JBool(val bool: Boolean) : Value()
    object JNull : Value()

    /** A missing key or index — every accessor answers null/empty rather than throwing. */
    object Missing : Value()

    fun parse(text: String): Value = Parser(text).parseValue()

    private class Parser(private val s: String) {
        private var i = 0

        fun parseValue(): Value {
            skipWs()
            return when {
                i >= s.length -> Missing
                s[i] == '{' -> parseObject()
                s[i] == '[' -> parseArray()
                s[i] == '"' -> JString(parseString())
                s.startsWith("true", i) -> { i += 4; JBool(true) }
                s.startsWith("false", i) -> { i += 5; JBool(false) }
                s.startsWith("null", i) -> { i += 4; JNull }
                else -> parseNumber()
            }
        }

        private fun parseObject(): JObject {
            expect('{')
            val fields = LinkedHashMap<String, Value>()
            skipWs()
            if (peek() == '}') { i++; return JObject(fields) }
            while (true) {
                skipWs()
                val key = parseString()
                skipWs(); expect(':')
                fields[key] = parseValue()
                skipWs()
                when (peek()) {
                    ',' -> { i++; continue }
                    '}' -> { i++; break }
                    else -> throw IllegalStateException("Malformed JSON object at $i")
                }
            }
            return JObject(fields)
        }

        private fun parseArray(): JArray {
            expect('[')
            val items = mutableListOf<Value>()
            skipWs()
            if (peek() == ']') { i++; return JArray(items) }
            while (true) {
                items.add(parseValue())
                skipWs()
                when (peek()) {
                    ',' -> { i++; continue }
                    ']' -> { i++; break }
                    else -> throw IllegalStateException("Malformed JSON array at $i")
                }
            }
            return JArray(items)
        }

        private fun parseString(): String {
            expect('"')
            val out = StringBuilder()
            while (true) {
                val c = s[i++]
                when {
                    c == '"' -> return out.toString()
                    c == '\\' -> {
                        val esc = s[i++]
                        when (esc) {
                            '"' -> out.append('"')
                            '\\' -> out.append('\\')
                            '/' -> out.append('/')
                            'n' -> out.append('\n')
                            'r' -> out.append('\r')
                            't' -> out.append('\t')
                            'b' -> out.append('\b')
                            'u' -> {
                                val hex = s.substring(i, i + 4)
                                i += 4
                                out.append(hex.toInt(16).toChar())
                            }
                            else -> out.append(esc)
                        }
                    }
                    else -> out.append(c)
                }
            }
        }

        private fun parseNumber(): JNumber {
            val start = i
            while (i < s.length && (s[i].isDigit() || s[i] in "+-.eE")) i++
            return JNumber(s.substring(start, i))
        }

        private fun peek(): Char = if (i < s.length) s[i] else ' '
        private fun expect(c: Char) {
            if (peek() != c) throw IllegalStateException("Expected '$c' at $i in: ${s.take(120)}")
            i++
        }
        private fun skipWs() { while (i < s.length && s[i].isWhitespace()) i++ }
    }
}
