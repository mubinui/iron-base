package dev.ironbase.plugin.engine

import com.intellij.testFramework.fixtures.BasePlatformTestCase
import dev.ironbase.plugin.llm.ToolCall

/**
 * Runs `WorkspaceTools` against a real, headless IDE fixture — no display,
 * but a real `VirtualFile` tree and real `ReadAction`s, which is what
 * actually exercises the VFS-touching code this is meant to check. A plain
 * JUnit test cannot do this: `LocalFileSystem` and friends need IntelliJ's
 * `Application` initialized first, which `BasePlatformTestCase` is what sets
 * up.
 *
 * JUnit3-style (`testXxx` methods, no annotations) because `BasePlatformTestCase`
 * is — the platform's own test suite runs this way, bridged onto Gradle's
 * `useJUnitPlatform()` by the JUnit Vintage engine.
 */
class WorkspaceToolsTest : BasePlatformTestCase() {

    private fun root() = myFixture.tempDirFixture.getFile("")!!

    fun testReadsAFileWithLineNumbers() {
        // No trailing newline: split(/\r?\n/) — faithfully ported from the
        // TS tool — turns a trailing "\n" into one extra empty line, which is
        // real behaviour worth its own test (below) rather than a surprise
        // buried in the expected count of this one.
        myFixture.addFileToProject("src/Foo.kt", "line one\nline two\nline three")

        val outcome = WorkspaceTools.run(root(), ToolCall("1", WorkspaceTools.READ_FILE, """{"path":"src/Foo.kt"}"""))

        assertFalse(outcome.isError)
        assertTrue(outcome.content.contains("src/Foo.kt (lines 1-3 of 3)"))
        assertTrue(outcome.content.contains("1\tline one"))
        assertTrue(outcome.content.contains("3\tline three"))
        assertEquals("3 lines", outcome.note)
    }

    fun testReadsALineRange() {
        myFixture.addFileToProject("src/Foo.kt", "a\nb\nc\nd\ne")

        val outcome = WorkspaceTools.run(
            root(),
            ToolCall("1", WorkspaceTools.READ_FILE, """{"path":"src/Foo.kt","startLine":2,"endLine":3}"""),
        )

        assertFalse(outcome.isError)
        assertTrue(outcome.content.contains("2\tb"))
        assertTrue(outcome.content.contains("3\tc"))
        assertFalse(outcome.content.contains("\ta"))
        assertEquals("2 of 5 lines", outcome.note)
    }

    fun testATrailingNewlineCountsAsOneMoreEmptyLine() {
        // Matches the TS tool's own split(/\r?\n/): not a Kotlin-side quirk,
        // and worth pinning down explicitly rather than leaving implicit.
        myFixture.addFileToProject("src/Foo.kt", "a\nb\n")

        val outcome = WorkspaceTools.run(root(), ToolCall("1", WorkspaceTools.READ_FILE, """{"path":"src/Foo.kt"}"""))

        assertTrue(outcome.content.contains("src/Foo.kt (lines 1-3 of 3)"))
        assertTrue(outcome.content.contains("3\t")) // the phantom trailing empty line, numbered
    }

    fun testReadFileMissingIsAnErrorWithAHelpfulNote() {
        val outcome = WorkspaceTools.run(root(), ToolCall("1", WorkspaceTools.READ_FILE, """{"path":"nope.kt"}"""))
        assertTrue(outcome.isError)
        assertEquals("no such file", outcome.note)
    }

    fun testReadFileRefusesToEscapeTheRoot() {
        val outcome = WorkspaceTools.run(
            root(),
            ToolCall("1", WorkspaceTools.READ_FILE, """{"path":"../../etc/passwd"}"""),
        )
        assertTrue(outcome.isError)
        assertEquals("outside the workspace", outcome.note)
    }

    fun testListsADirectorySorted() {
        myFixture.addFileToProject("src/b.kt", "")
        myFixture.addFileToProject("src/a.kt", "")
        myFixture.addFileToProject("src/nested/c.kt", "")

        val outcome = WorkspaceTools.run(root(), ToolCall("1", WorkspaceTools.LIST_DIR, """{"path":"src"}"""))

        assertFalse(outcome.isError)
        val lines = outcome.content.lines().drop(1) // drop the "src:" header
        assertEquals(listOf("a.kt", "b.kt", "nested/"), lines)
        assertEquals("3 entries", outcome.note)
    }

    fun testFindsAMatchByLiteralSubstring() {
        myFixture.addFileToProject("src/Foo.kt", "val sessions = mutableMapOf<String, Session>()\n")

        val outcome = WorkspaceTools.run(root(), ToolCall("1", WorkspaceTools.SEARCH, """{"pattern":"sessions"}"""))

        assertFalse(outcome.isError)
        assertTrue(outcome.content.contains("src/Foo.kt:1:"))
        assertEquals("1 match", outcome.note)
    }

    fun testSearchHonoursAnIncludeGlob() {
        myFixture.addFileToProject("src/a.kt", "needle\n")
        myFixture.addFileToProject("src/a.md", "needle\n")

        val outcome = WorkspaceTools.run(
            root(),
            ToolCall("1", WorkspaceTools.SEARCH, """{"pattern":"needle","glob":"**/*.kt"}"""),
        )

        assertTrue(outcome.content.contains("a.kt"))
        assertFalse(outcome.content.contains("a.md"))
    }

    fun testSearchSkipsNoiseDirectories() {
        myFixture.addFileToProject("node_modules/dep/index.kt", "needle\n")
        myFixture.addFileToProject("src/real.kt", "needle\n")

        val outcome = WorkspaceTools.run(root(), ToolCall("1", WorkspaceTools.SEARCH, """{"pattern":"needle"}"""))

        assertTrue(outcome.content.contains("src/real.kt"))
        assertFalse(outcome.content.contains("node_modules"))
    }

    fun testSearchRejectsANestedQuantifier() {
        val outcome = WorkspaceTools.run(
            root(),
            ToolCall("1", WorkspaceTools.SEARCH, """{"pattern":"(a+)+b","isRegex":true}"""),
        )
        assertTrue(outcome.isError)
    }
}
