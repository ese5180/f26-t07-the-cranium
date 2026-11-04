package com.craniumiot.cranium.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.URI
import java.net.URLDecoder
import java.time.ZoneOffset
import java.util.Locale

/** The board log: how it is asked for, read line by line, filtered and put into words, as on the website. */
class BoardLogTest {
    private val thing = "cranium-0123456789abcdef"
    private val noon = "2026-10-10T12:00:00Z"

    private fun line(id: String, kind: String = "log", tag: String = "app", level: String = "info", dropped: Long? = null, on: String = thing) =
        BoardLine(on, noon, id, kind, tag, level, "text $id", 42, id.substringAfter('.').toLong(), dropped)

    // core.test.mjs: "the board log is asked for with its range, board, kinds and sources, and read line by line"
    @Test
    fun `the board log is asked for with its range, board, kinds and sources, and read line by line`() {
        val url = ApiPaths("https://console.example").boardLog(noon, noon, thing, listOf("health", "setting"), listOf("WIFI", "net"), cursor = "xyz")
        val asked = URI(url)
        assertEquals("/api/events/log", asked.path)
        val query = asked.rawQuery.split('&').associate { part ->
            val (key, value) = part.split('=', limit = 2)
            key to URLDecoder.decode(value, "UTF-8")
        }
        assertEquals(mapOf("from" to noon, "to" to noon, "thing" to thing, "kinds" to "health,setting", "tags" to "WIFI,net", "cursor" to "xyz"), query)
        assertTrue(ApiPaths("https://c").boardLog(noon, noon, limit = 9999).endsWith("limit=500"))

        val read = ApiJson.lines(
            """{"lines":[
              {"thing":"$thing","at":"$noon","id":"42.17","kind":"health","tag":"WIFI","level":"warn","text":"connected\u0007 é","boot":42,"seq":17,"dropped":3},
              {"thing":"$thing","at":"$noon","id":"42.18","kind":"connection","tag":"WIFI","text":"not a kind of the log"},
              {"thing":"$thing","at":"$noon","id":"42.19","kind":"log","tag":"zephyr","text":"not a source of the log"},
              {"thing":"someone","at":"$noon","id":"42.20","kind":"log","tag":"app","text":"not a board"},
              {"thing":"$thing","at":"$noon","id":"42.0","kind":"log","tag":"app","text":"a line has no number 0"}
            ],"cursor":"abc_-1","from":"$noon","to":"$noon"}""",
        )
        assertEquals(listOf(BoardLine(thing, noon, "42.17", "health", "WIFI", "warn", "connected? ?", 42, 17, 3)), read.lines)
        assertEquals("abc_-1", read.cursor)
        val bare = ApiJson.lines("""{"lines":[{"thing":"$thing","at":"$noon","id":"0.1","kind":"setting","tag":"CMD","text":"${"x".repeat(200)}","dropped":0}]}""")
        assertEquals(160, bare.lines.single().text.length)
        assertNull(bare.lines.single().dropped)
        assertEquals("info", bare.lines.single().level)
    }

    @Test
    fun `what is asked for is the kinds switched on when not all are, and one source`() {
        assertEquals(BoardLog.Query(null, null, false), BoardLog.query(emptySet(), ""))
        assertEquals(BoardLog.Query(listOf("bluetooth", "update", "restart", "health", "setting"), listOf("CMD"), false), BoardLog.query(setOf("log", "console"), "CMD"))
        assertEquals(true, BoardLog.query(BoardLog.KINDS.toSet(), "").none)
        assertNull(BoardLog.query(emptySet(), "zephyr").tags)
    }

    @Test
    fun `lines are filtered by kind, counted and put into words`() {
        val lines = listOf(line("1.1", kind = "setting", tag = "CMD"), line("1.2", level = "warn", dropped = 3), line("1.3", kind = "health", tag = "WIFI"))
        assertEquals(listOf("1.1", "1.3"), BoardLog.shown(lines, setOf("log")).map { it.id })
        assertEquals("3 lines · 1 warning · more in this range", BoardLog.count(lines, more = true))
        assertEquals("1 line", BoardLog.count(lines.take(1), more = false))
        assertEquals("1 line lost before this one", BoardLog.dropped(1))
        assertEquals("3 lines lost before this one", BoardLog.dropped(3))
        assertEquals("Boot 42, line 2 of that boot", BoardLog.place(lines[1]))
        assertNull(BoardLog.place(lines[1].copy(boot = null)))
        assertEquals(BoardLog.EMPTY_ALL, BoardLog.emptyText("", "", setOf("console")))
        assertEquals(BoardLog.EMPTY_FILTERED, BoardLog.emptyText("CMD", "", emptySet()))
        assertEquals(BoardLog.EMPTY_FILTERED, BoardLog.emptyText("", thing, emptySet()))
        assertEquals(BoardLog.EMPTY_FILTERED, BoardLog.emptyText("", "", setOf("setting")))
        assertEquals("12:00:00 PM", BoardLog.secondOfDay(noon, ZoneOffset.UTC, Locale.US))
        assertEquals("", BoardLog.secondOfDay("not a time"))
    }

    @Test
    fun `the new kinds have the website's words and look, and each board's lane gets its lines`() {
        assertEquals(Telemetry.Kind("setting", "Settings", Telemetry.Shape.PLUS, Telemetry.Hue.B), Telemetry.kindOf("setting"))
        assertEquals(Telemetry.Kind("log", "Other lines", Telemetry.Shape.DOT, Telemetry.Hue.QUIET), Telemetry.kindOf("log"))
        for (kind in BoardLog.KINDS) assertEquals(kind, Telemetry.kindOf(kind).id)
        val other = "cranium-fedcba9876543210"
        val lines = listOf(line("1.1"), line("1.2", on = other))
        val lanes = Telemetry.lanesOf(emptyList(), listOf(Device(thing = thing)), consoleEvents = null, lines = lines)
        // A board that is no longer listed keeps a lane for its lines.
        assertEquals(listOf(thing, other), lanes.map { it.id })
        assertEquals(listOf("1.1"), lanes[0].lines.map { it.id })
        assertEquals(listOf("1.2"), lanes[1].lines.map { it.id })
    }

    @Test
    fun `a line of the board log can be found, by its text, board and source`() {
        val devices = listOf(Device(thing = thing, name = "CRVIHAAN01"))
        val items = Search.lines(listOf(line("1.1", tag = "WIFI", level = "warn").copy(text = "Wi-Fi lost, retrying")), devices)
        val hit = Search.rank("retrying", items).single()
        assertEquals(SearchKind.LINE, hit.item.kind)
        assertEquals(SearchTarget.BoardLog(thing), hit.item.target)
        assertTrue(hit.item.subtitle.startsWith("CRVIHAAN01 · WIFI · "))
        assertTrue(hit.item.subtitle.endsWith(" · Warning"))
        assertEquals(1, Search.rank("wifi", items).size)
    }
}
