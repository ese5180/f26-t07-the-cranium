package com.craniumiot.cranium.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The website's History page: what build-history.mjs writes, read the way history.js reads it. */
class CommitHistoryTest {
    private val hash = "0123456789abcdef0123456789abcdef01234567"
    private val other = "fedcba9876543210fedcba9876543210fedcba98"

    @Test
    fun `the commits are read with the tags the page knows`() {
        val history = CommitHistory.parse(
            """
            {"commits": [
               {"hash": "$hash", "short": "0123456", "date": "2026-11-02T10:00:00+01:00", "subject": "Firmware 1.11.4",
                "tags": ["firmware", "made-up", 5, "docs"]},
               {"hash": "$other", "date": "2026-11-01T10:00:00+01:00", "subject": "Record the update", "tags": "not a list"}
             ],
             "deployment": {"commit": "$hash", "tree": "dirty", "deployedAt": "2026-11-02T11:00:00Z"}}
            """.trimIndent(),
        )!!
        assertEquals(2, history.commits.size)
        val first = history.commits[0]
        assertEquals(listOf("firmware", "docs"), first.tags)
        assertEquals("0123456", first.short)
        assertEquals("Firmware 1.11.4", first.subject)
        assertEquals("https://github.com/ese5180/f26-t07-the-cranium/commit/$hash", first.link)
        assertEquals("fedcba9", history.commits[1].short)
        assertEquals(emptyList<String>(), history.commits[1].tags)
        assertEquals(hash, history.builtFrom)
        assertEquals("dirty", history.tree)
        assertEquals("2026-11-02T11:00:00Z", history.deployedAt)
    }

    @Test
    fun `what the deployment did not record is not known`() {
        val history = CommitHistory.parse(
            """{"commits": [], "deployment": {"commit": "not a hash", "tree": "sparkling"}}""",
        )!!
        assertNull(history.builtFrom)
        assertEquals("unknown", history.tree)
        assertNull(history.deployedAt)
        assertEquals("unknown", CommitHistory.parse("""{"commits": []}""")!!.tree)
    }

    @Test
    fun `a file that is not what was written is not read at all`() {
        assertNull(CommitHistory.parse("""{"commits": [{"hash": "XYZ", "date": "d", "subject": "s"}]}"""))
        assertNull(CommitHistory.parse("""{"commits": [{"hash": "$hash", "date": "d"}]}"""))
        assertNull(CommitHistory.parse("""{"commits": ["$hash"]}"""))
        assertNull(CommitHistory.parse("""{"nothing": []}"""))
        assertNull(CommitHistory.parse("""[]"""))
        assertNull(CommitHistory.parse("not json"))
    }

    @Test
    fun `long text is cut, and at most 300 commits are kept`() {
        val subject = "s".repeat(400)
        val one = """{"hash": "$hash", "short": "${"a".repeat(20)}", "date": "d", "subject": "$subject"}"""
        val read = CommitHistory.parse("""{"commits": [$one]}""")!!.commits.single()
        assertEquals(300, read.subject.length)
        assertEquals(12, read.short.length)
        val many = List(310) { one }.joinToString(",")
        assertEquals(300, CommitHistory.parse("""{"commits": [$many]}""")!!.commits.size)
    }

    @Test
    fun `the tags have the website's names, in its order`() {
        assertEquals(listOf("website", "firmware", "cloud", "tools", "ci", "docs"), CommitHistory.TAGS.map { it.first })
        assertEquals("CI", CommitHistory.tagLabel("ci"))
        assertEquals("Website", CommitHistory.tagLabel("website"))
        assertNull(CommitHistory.tagLabel("made-up"))
    }
}
