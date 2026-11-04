package com.craniumiot.cranium.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId
import java.util.Locale

/** The Events and Diagnostics pages apart from drawing (the website's telemetry.js and its tests). */
class TelemetryTest {
    private val utc = ZoneId.of("UTC")
    private val us = Locale.US
    private val now = 1_793_620_800_000L // 2026-11-02T12:00:00Z
    private val minute = 60_000L
    private val hour = 60 * minute
    private val day = 24 * hour
    private val a = "cranium-00000000000000aa"
    private val b = "cranium-00000000000000bb"
    private val d = "cranium-00000000000000dd"
    private val deployment = "cranium-1-2-3-b5-20261102T110000Z-0a0a"

    private fun at(msAgo: Long) = Times.iso(now - msAgo)

    private var ids = 0

    private fun event(thing: String?, msAgo: Long, kind: String, what: String, text: String, level: String = "info"): BoardEvent {
        ids += 1
        return BoardEvent(thing, at(msAgo), ids.toString(16).padStart(6, '0'), kind, what, level, text)
    }

    private fun board(thing: String, online: Boolean = true, lastSeen: String? = at(20_000), uptime: Long? = 3600, fw: String? = "1.10.0+0") =
        Device(thing, online, fw?.let { DeviceFirmware(it, true) }, null, lastSeen, uptime = uptime)

    // Ranges and the axis.

    @Test
    fun `a preset ends now and moves with it, a range chosen by hand stays where it is`() {
        val last = Telemetry.rangeOf(Telemetry.Range.Last("24h"), now)
        assertEquals(listOf(now - day, now), listOf(last.fromMs, last.toMs))
        assertTrue(last.live)
        assertEquals("the last 24 hours, up to now", Telemetry.rangeWords(last, utc, us))
        assertEquals(listOf("1 h", "24 h", "7 d", "30 d"), Telemetry.PRESETS.map { it.label })
        assertEquals("24h", Telemetry.rangeOf(Telemetry.Range.Last("made up"), now).preset!!.id)
        assertEquals(now - 30 * day, Telemetry.rangeOf(Telemetry.Range.Last("30d"), now).fromMs)

        val fixed = Telemetry.rangeOf(Telemetry.Range.Span(now - hour, now - minute), now + day)
        assertEquals(listOf(now - hour, now - minute), listOf(fixed.fromMs, fixed.toMs))
        assertFalse(fixed.live)
        assertNull(fixed.preset)
        assertTrue(Telemetry.rangeWords(fixed, utc, us).contains(" to "))
        assertTrue(Telemetry.rangeWords(fixed, utc, us).startsWith("2 Nov 2026, "))
    }

    @Test
    fun `a time's place across a span, clamped to it`() {
        assertEquals(0.5f, Telemetry.place(now - day / 2, now - day, now), 0.0001f)
        assertEquals(1f, Telemetry.place(now + hour, now - day, now), 0f)
        assertEquals(0f, Telemetry.place(now - 2 * day, now - day, now), 0f)
        assertEquals(0f, Telemetry.place(now, now, now), 0f)
    }

    @Test
    fun `the axis has a few ticks on whole steps of local time, and names the day where one begins`() {
        for ((span, step) in listOf(hour to 10 * minute, day to 6 * hour, 7 * day to day, 30 * day to 7 * day)) {
            val ticks = Telemetry.timeTicks(now - span, now, 7, utc, us)
            assertTrue("$span: ${ticks.size}", ticks.size in 3..8)
            ticks.forEachIndexed { index, tick ->
                assertTrue(tick.ms >= now - span && tick.ms <= now)
                if (index > 0) assertEquals(step, tick.ms - ticks[index - 1].ms)
                val local = Instant.ofEpochMilli(tick.ms).atZone(utc)
                assertEquals(local.hour == 0 && local.minute == 0, tick.newDay)
            }
        }
        val dayTicks = Telemetry.timeTicks(now - day, now, 7, utc, us)
        assertEquals(5, dayTicks.size)
        val midnight = dayTicks.single { it.newDay }
        assertEquals("Mon 2 Nov", midnight.label)
        // The first whole day after the start of the range, told by its date.
        assertEquals("27 Oct", Telemetry.timeTicks(now - 7 * day, now, 7, utc, us).first().label)
        assertEquals(emptyList<Telemetry.Tick>(), Telemetry.timeTicks(now, now, 7, utc, us))
    }

    @Test
    fun `a span between steps takes the coarser one, as on the website`() {
        // 7.5 hours over at most 7 ticks: 1 h steps would make 7.5 > 7, so 2 h steps.
        val ticks = Telemetry.timeTicks(now - 7 * hour - 30 * minute, now, 7, utc, us)
        assertEquals(2 * hour, ticks[1].ms - ticks[0].ms)
    }

    @Test
    fun `a range chosen by hand is checked before anything is asked for`() {
        assertEquals(
            Telemetry.Custom.Wrong("Give a start and an end, both with a date and a time."),
            Telemetry.customRange(null, now - hour, now),
        )
        assertEquals(
            Telemetry.Custom.Wrong("The start has to be before the end, and before now."),
            Telemetry.customRange(now - hour, now - 2 * hour, now),
        )
        assertEquals(
            Telemetry.Custom.Wrong("The start has to be before the end, and before now."),
            Telemetry.customRange(now + hour, now + 2 * hour, now),
        )
        assertEquals(Telemetry.Custom.Wrong("A range can be at most 31 days long."), Telemetry.customRange(now - 40 * day, now - day, now))
        assertEquals(Telemetry.Custom.Ok(now - 2 * hour, now - 30 * minute), Telemetry.customRange(now - 2 * hour, now - 30 * minute, now))
        assertEquals("an end in the future is now", Telemetry.Custom.Ok(now - hour, now), Telemetry.customRange(now - hour, now + day, now))
    }

    // Lanes, bands and filters.

    @Test
    fun `a key for an event stays the same from one load to the next and holds only plain characters`() {
        val item = event(a, minute, "update", "step", "x")
        assertEquals("000000aa-${now - minute}-${item.id}", Telemetry.eventKey(item))
        assertEquals(Telemetry.eventKey(item), Telemetry.eventKey(item.copy()))
        val console = BoardEvent(null, at(minute), "Root=1-abc/def+=", "console", "deployment.create", "info", "x")
        assertEquals("console-${now - minute}-Root_1_abc_def__", Telemetry.eventKey(console))
        assertTrue(Regex("^[A-Za-z0-9_-]+$").matches(Telemetry.eventKey(console)))
    }

    @Test
    fun `an entry of the activity log is an event of the Console lane, a refusal a warning`() {
        val entry = AuditEntry(at(minute), Person("x", "manager@example.invalid"), "deployment.create", deployment, "ok", emptyList(), "req-1")
        val made = Telemetry.consoleEvent(entry)!!
        assertNull(made.thing)
        assertEquals("console", made.kind)
        assertEquals("info", made.level)
        assertEquals("manager@example.invalid deployed 1.2.3+5", made.text)
        assertEquals("deployment:$deployment", made.href)
        assertEquals("req-1", made.id)
        val refused = Telemetry.consoleEvent(entry.copy(outcome = "rejected"))!!
        assertEquals("warn", refused.level)
        assertTrue(refused.text.endsWith("(refused)"))
        assertEquals("firmware", Telemetry.consoleEvent(entry.copy(action = "firmware.upload", target = "1.2.3+5"))!!.href)
        assertNull(Telemetry.consoleEvent(entry.copy(target = "zephyr.signed.bin", action = "firmware.upload"))!!.href)
        assertEquals("0", Telemetry.consoleEvent(entry.copy(requestId = ""))!!.id)
        assertNull("no time, no place on the timeline", Telemetry.consoleEvent(entry.copy(at = null)))
    }

    @Test
    fun `every board of the group has a lane, in the order of their names, and the console has the last`() {
        val events = listOf(event(b, minute, "firmware", "changed", "x"), event(d, minute, "restart", "restarted", "y"))
        val lanes = Telemetry.lanesOf(events, listOf(board(b), board(a).copy(name = "BENCH1")), consoleEvents = emptyList())
        assertEquals(listOf(a, b, d, "console"), lanes.map { it.id })
        assertEquals("BENCH1", lanes[0].label)
        assertEquals(a, lanes[0].thing)
        assertEquals(0, lanes[0].events.size)
        assertNull("a board that is gone keeps its lane for its events", lanes[2].device)
        assertEquals(1, lanes[2].events.size)
        assertNull(lanes[3].thing)
        assertEquals("Console", lanes[3].label)
        assertEquals(listOf(b), Telemetry.lanesOf(events, listOf(board(a), board(b)), thing = b, consoleEvents = null).map { it.id })
        assertEquals(listOf(a, b, d), Telemetry.lanesOf(events, listOf(board(a)), consoleEvents = null).map { it.id })
    }

    private fun presence(msAgo: Long, what: String) = event(a, msAgo, "connection", what, what)

    private fun bands(events: List<BoardEvent>, device: Device? = null, live: Boolean = false): List<Triple<Double, Double, Boolean>> {
        val from = now - hour
        return Telemetry.onlineBands(events, from, now, device, live)
            .map { Triple((it.fromMs - from).toDouble() / minute, (it.toMs - from).toDouble() / minute, it.inferred) }
    }

    @Test
    fun `online bands follow connections, and the heartbeat where no connection says`() {
        assertEquals(listOf(Triple(10.0, 20.0, false)), bands(listOf(presence(50 * minute, "connected"), presence(40 * minute, "disconnected"))))
        // The first word is a disconnection: it was online until then.
        assertEquals(listOf(Triple(0.0, 15.0, false)), bands(listOf(presence(45 * minute, "disconnected"))))
        // AWS can say a thing twice.
        assertEquals(
            listOf(Triple(10.0, 20.0, false)),
            bands(
                listOf(
                    presence(50 * minute, "connected"), presence(49 * minute, "connected"),
                    presence(40 * minute, "disconnected"), presence(39 * minute, "disconnected"),
                ),
            ),
        )
        // Nothing in the range: the heartbeat says, for a range that ends now; nothing otherwise.
        assertEquals(listOf(Triple(0.0, 60.0, false)), bands(emptyList(), board(a), live = true))
        assertEquals(emptyList<Triple<Double, Double, Boolean>>(), bands(emptyList(), board(a, online = false), live = true))
        assertEquals(emptyList<Triple<Double, Double, Boolean>>(), bands(emptyList(), board(a), live = false))
        // Connected, then quiet without a word: until its heartbeat stopped counting.
        assertEquals(
            listOf(Triple(10.0, 31.5, false)),
            bands(listOf(presence(50 * minute, "connected")), board(a, online = false, lastSeen = at(30 * minute)), live = true),
        )
        // Disconnected, and online now: since then, as far as is known.
        assertEquals(
            listOf(Triple(0.0, 10.0, false), Triple(10.0, 60.0, true)),
            bands(listOf(presence(50 * minute, "disconnected")), board(a), live = true),
        )
        // Other kinds say nothing about it.
        assertEquals(emptyList<Triple<Double, Double, Boolean>>(), bands(listOf(event(a, minute, "update", "step", "x"))))
    }

    @Test
    fun `switched-off kinds are left out, what is left is newest first, and close markers are one spot`() {
        val events = listOf(
            event(a, 3 * minute, "update", "step", "old"),
            event(a, minute, "connection", "connected", "new"),
            event(a, 2 * minute, "health", "memory", "mid"),
        )
        val lanes = listOf(Telemetry.Lane(a, a, a, null, events))
        assertEquals(listOf("new", "mid", "old"), Telemetry.shownEvents(lanes, emptySet()).map { it.text })
        assertEquals(listOf("mid"), Telemetry.shownEvents(lanes, setOf("connection", "update")).map { it.text })
        // Two minutes on a day's width are one spot; on an hour's they are not.
        assertEquals(3, Telemetry.neighbours(events, now - 2 * minute, now - day, now).size)
        assertEquals(1, Telemetry.neighbours(events, now - 2 * minute, now - hour, now).size)

        val same = listOf(event(a, minute, "update", "step", "1"), event(a, minute, "update", "step", "2"), event(a, minute, "update", "step", "3"))
        val lifts = Telemetry.staggered(same, now - day, now)
        assertEquals(listOf(0, -1, 1), same.map { lifts.getValue(Telemetry.eventKey(it)) })
        val apart = listOf(event(a, 10 * hour, "update", "step", "far"), event(a, minute, "update", "step", "near"))
        assertEquals(listOf(0, 0), apart.map { Telemetry.staggered(apart, now - day, now).getValue(Telemetry.eventKey(it)) })
    }

    @Test
    fun `every kind the API knows has a look, three hues by family and a shape of its own`() {
        for (kind in ApiJson.EVENT_KINDS) assertTrue(kind, Telemetry.KINDS.any { it.id == kind })
        assertEquals(Telemetry.KINDS.size, Telemetry.KINDS.map { it.shape }.toSet().size)
        assertEquals(Telemetry.Hue.values().toSet(), Telemetry.KINDS.map { it.hue }.toSet())
        assertEquals(Telemetry.Hue.QUIET, Telemetry.kindOf("connection").hue)
        assertEquals("Wi-Fi and memory", Telemetry.kindOf("health").label)
        assertEquals("update", Telemetry.kindOf("made up").id)
    }

    @Test
    fun `a board's state now, for its lane`() {
        assertEquals(Tone.GOOD to "Online now", Telemetry.laneState(board(a)))
        assertEquals(Tone.IDLE to "Never connected", Telemetry.laneState(board(a, online = false, lastSeen = null)))
        assertEquals(Tone.IDLE to "Offline now", Telemetry.laneState(board(a, online = false)))
    }

    // What a board reports, in words.

    @Test
    fun `restarts and boots are said in words`() {
        assertEquals("the watchdog", Telemetry.causeWords(listOf("watchdog")))
        assertEquals("a brownout and a CPU lockup", Telemetry.causeWords(listOf("brownout", "lockup")))
        assertEquals("a clock fault", Telemetry.causeWords(listOf("pll", "clock")))
        assertEquals("an unknown cause", Telemetry.causeWords(emptyList()))
        assertEquals("an unknown cause", Telemetry.causeWords(listOf("made_up")))
        assertEquals("Reached the cloud", Telemetry.stageWords(4))
        assertEquals("Did not start its program", Telemetry.stageWords(0))
        assertEquals("Stage 9", Telemetry.stageWords(9))

        val rows = Telemetry.diaryRows(
            Diary(9, listOf(DiaryEntry("1.10.0+0", "1", listOf("pin"), 4), DiaryEntry("1.10.0+0", "10", listOf("watchdog"), 3))),
        )
        assertEquals(
            listOf(
                Telemetry.BootRow(9, "1.10.0+0", true, "Reached the cloud", "the reset pin", false),
                Telemetry.BootRow(8, "1.10.0+0", false, "Got onto the network", "the watchdog", true),
            ),
            rows,
        )
        assertEquals(emptyList<Telemetry.BootRow>(), Telemetry.diaryRows(null))

        assertNull(Telemetry.stuckWords(null))
        assertEquals(Telemetry.StuckWords(Tone.GOOD, null, "Has not had to restart itself for being stuck"), Telemetry.stuckWords(Stuck(0, "none")))
        assertEquals(
            Telemetry.StuckWords(Tone.WARN, "Once", "Restarted itself once for being stuck, because no connection to the cloud for 15 minutes"),
            Telemetry.stuckWords(Stuck(1, "no_cloud")),
        )
        assertEquals(
            Telemetry.StuckWords(
                Tone.WARN, "2 in a row",
                "Restarted itself 2 times in a row for being stuck; the last time because the Wi-Fi chip stopped answering",
            ),
            Telemetry.stuckWords(Stuck(2, "wifi_silent")),
        )
        assertTrue(Telemetry.stuckWords(Stuck(1, "new_timer"))!!.text.endsWith("because reason new_timer"))
    }

    @Test
    fun `memory is said as what is free now, and whether it ran low`() {
        val heap = Telemetry.heapWords(Heap(21312, 9840, 44240))!!
        assertEquals(Tone.LIVE, heap.tone)
        assertEquals(52, heap.used)
        assertEquals(78, heap.leastUsed)
        assertEquals("21 KiB free of 43 KiB", heap.text)
        assertEquals("At least 10 KiB has stayed free since it started (22%)", heap.least)
        assertFalse(heap.ranLow)
        assertEquals(Tone.WARN, Telemetry.heapWords(Heap(10000, 9000, 44240))!!.tone)
        assertEquals(Tone.BAD, Telemetry.heapWords(Heap(6000, 6000, 44240))!!.tone)
        val earlier = Telemetry.heapWords(Heap(20000, 6000, 44240))!!
        assertEquals(Tone.LIVE, earlier.tone)
        assertTrue(earlier.ranLow)
        assertNull(Telemetry.heapWords(null))
    }

    @Test
    fun `a missing report is explained by the firmware the board runs`() {
        assertEquals("Needs firmware 1.10.0 or later. This board runs 1.9.0+0.", Telemetry.diagMissing(board(a, fw = "1.9.0+0")))
        assertEquals("Needs firmware 1.10.0 or later. This board has not said what it runs.", Telemetry.diagMissing(board(a, fw = null)))
        assertTrue(Telemetry.diagMissing(board(a, fw = "1.10.1+0")).startsWith("No diagnostics report yet"))
        assertTrue(Telemetry.diagMissing(board(a, fw = "2.0.0+0")).startsWith("No diagnostics report yet"))
        assertEquals("Needs firmware 1.7.4 or later. This board runs 1.7.3+9.", Telemetry.diaryMissing(board(a, fw = "1.7.3+9")))
        assertEquals("No boot diary yet. A board on 1.7.4 or later sends it when it connects.", Telemetry.diaryMissing(board(a, fw = "1.7.4+0")))
        assertEquals("No boot diary yet. A board on 1.7.4 or later sends it when it connects.", Telemetry.diaryMissing(board(a, fw = null)))
    }

    @Test
    fun `the heartbeat's age counts in seconds for two minutes, and the uptime counts on`() {
        assertEquals("20 s ago", Telemetry.heartbeatAge(at(20_000), now))
        assertEquals("119 s ago", Telemetry.heartbeatAge(at(119_000), now))
        assertEquals("0 s ago", Telemetry.heartbeatAge(Times.iso(now + 3_000), now))
        assertEquals("3 min ago", Telemetry.heartbeatAge(at(3 * minute), now))
        assertEquals("", Telemetry.heartbeatAge(null, now))
        assertEquals(120L, Telemetry.uptimeNow(board(a, uptime = 100), now))
        assertEquals(100L, Telemetry.uptimeNow(board(a, uptime = 100, online = false), now))
        assertNull(Telemetry.uptimeNow(board(a, uptime = null), now))
        assertEquals(100L, Telemetry.uptimeNow(board(a, uptime = 100, lastSeen = null), now))
    }

    // Readings.

    @Test
    fun `a gap in the readings breaks the line`() {
        val points = listOf(0, 30, 60, 90, 700, 730).map { seconds -> Telemetry.Point(now - hour + seconds * 1000L, -50 - seconds / 30.0) }
        assertEquals(listOf(4, 2), Telemetry.lineRuns(points, Telemetry.gapFor(0)).map { it.size })
        assertEquals(150_000L, Telemetry.gapFor(0))
        assertEquals(2_520_000L, Telemetry.gapFor(1008))
        assertEquals(emptyList<List<Telemetry.Point>>(), Telemetry.lineRuns(emptyList(), 1))
    }

    @Test
    fun `a field of the readings becomes points, readings without it left out`() {
        val samples = listOf(Sample(at(hour), -60, null, null, null), Sample(at(hour - 1000), null, null, 100, 90), Sample("not a time", -50, null, null, null))
        assertEquals(listOf(Telemetry.Point(now - hour, -60.0)), Telemetry.pointsOf(samples) { it.rssi })
        assertEquals(listOf(Telemetry.Point(now - hour + 1000, 100.0)), Telemetry.pointsOf(samples) { it.heapFree })
    }

    @Test
    fun `the table under a chart has every hour, newest first`() {
        val hours = Telemetry.hourlyRows(
            listOf(
                Telemetry.Point(Times.parse("2026-11-02T10:05:00Z")!!, -60.0),
                Telemetry.Point(Times.parse("2026-11-02T10:35:00Z")!!, -50.0),
                Telemetry.Point(Times.parse("2026-11-02T11:05:00Z")!!, -70.0),
            ),
            utc,
        )
        assertEquals(
            listOf(listOf(-70.0, -70.0, -70.0, 1.0), listOf(-60.0, -55.0, -50.0, 2.0)),
            hours.map { listOf(it.low, it.mean, it.high, it.count.toDouble()) },
        )
        assertEquals(Times.parse("2026-11-02T11:00:00Z"), hours[0].ms)
    }
}
