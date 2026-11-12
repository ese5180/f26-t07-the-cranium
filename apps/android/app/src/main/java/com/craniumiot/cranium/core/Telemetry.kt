package com.craniumiot.cranium.core

import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlin.math.roundToLong

/** The Events and Diagnostics pages, apart from drawing (the website's telemetry.js). */
object Telemetry {
    private const val MINUTE = 60_000L
    private const val HOUR = 60 * MINUTE
    private const val DAY = 24 * HOUR

    data class Preset(val id: String, val label: String, val ms: Long, val name: String)

    val PRESETS = listOf(
        Preset("1h", "1 h", HOUR, "the last hour"),
        Preset("24h", "24 h", DAY, "the last 24 hours"),
        Preset("7d", "7 d", 7 * DAY, "the last 7 days"),
        Preset("30d", "30 d", 30 * DAY, "the last 30 days"),
    )
    const val LONGEST_RANGE = 31 * DAY
    const val SHORTEST_ZOOM = MINUTE
    const val EVENTS_REFRESH_MS = 15_000L
    const val DIAGNOSTICS_REFRESH_MS = 10_000L
    const val SAMPLES_REFRESH_MS = 60_000L
    const val DETAILS_REFRESH_MS = 5 * MINUTE
    const val AUDIT_PAGE = 100
    const val AUDIT_PAGES = 5
    private const val ONLINE_WINDOW_MS = 90_000L
    const val LOW_HEAP_SHARE = 0.15
    private const val TIGHT_HEAP_SHARE = 0.3

    /** The kinds of event: a family hue (a, b, c, quiet) and a shape, in the order of the legend. */
    enum class Shape { CIRCLE, SQUARE, DIAMOND, DOWN, UP, RING, PLUS, DOT, BAR }

    enum class Hue { A, B, C, QUIET }

    data class Kind(val id: String, val label: String, val shape: Shape, val hue: Hue)

    val KINDS = listOf(
        Kind("update", "Update", Shape.CIRCLE, Hue.A),
        Kind("firmware", "Firmware", Shape.SQUARE, Hue.A),
        Kind("restart", "Restart", Shape.DIAMOND, Hue.C),
        Kind("health", "Wi-Fi and memory", Shape.DOWN, Hue.C),
        Kind("bluetooth", "Bluetooth", Shape.UP, Hue.B),
        Kind("console", "Console", Shape.RING, Hue.B),
        // Lines of the board log only: a setting changed at a board's serial console, and the rest.
        Kind("setting", "Settings", Shape.PLUS, Hue.B),
        Kind("log", "Other lines", Shape.DOT, Hue.QUIET),
        Kind("connection", "Connection", Shape.BAR, Hue.QUIET),
    )

    fun kindOf(id: String): Kind = KINDS.firstOrNull { it.id == id } ?: KINDS[0]

    /** A range: a preset that ends now, or a fixed span. */
    sealed class Range {
        data class Last(val preset: String) : Range()
        data class Span(val fromMs: Long, val toMs: Long) : Range()
    }

    data class TimeSpan(val fromMs: Long, val toMs: Long, val live: Boolean, val preset: Preset?)

    /** The span a range stands for now. A preset ends now and moves with it. */
    fun rangeOf(range: Range, nowMs: Long): TimeSpan = when (range) {
        is Range.Last -> {
            val preset = PRESETS.firstOrNull { it.id == range.preset } ?: PRESETS[1]
            TimeSpan(nowMs - preset.ms, nowMs, true, preset)
        }
        is Range.Span -> TimeSpan(range.fromMs, range.toMs, false, null)
    }

    fun rangeWords(span: TimeSpan, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String =
        span.preset?.let { "${it.name}, up to now" }
            ?: "${Words.dateAndTime(Times.iso(span.fromMs), zone, locale)} to ${Words.dateAndTime(Times.iso(span.toMs), zone, locale)}"

    /** Where a time lies across a span, from 0 to 1. */
    fun place(ms: Long, fromMs: Long, toMs: Long): Float =
        if (toMs <= fromMs) 0f else ((ms - fromMs).toFloat() / (toMs - fromMs)).coerceIn(0f, 1f)

    data class Tick(val ms: Long, val label: String, val newDay: Boolean)

    private val STEPS = listOf(
        MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR,
        DAY, 2 * DAY, 7 * DAY,
    )

    /** The ticks of a time axis: at most `most`, on whole steps of local time. */
    fun timeTicks(
        fromMs: Long,
        toMs: Long,
        most: Int = 7,
        zone: ZoneId = ZoneId.systemDefault(),
        locale: Locale = Locale.getDefault(),
    ): List<Tick> {
        val span = toMs - fromMs
        if (span <= 0) return emptyList()
        val step = STEPS.firstOrNull { span.toDouble() / it <= most } ?: (7 * DAY)
        val startDay = Instant.ofEpochMilli(fromMs).atZone(zone).toLocalDate().atStartOfDay()
        fun local(index: Long): Long = if (step >= DAY) {
            startDay.plusDays(index * (step / DAY)).atZone(zone).toInstant().toEpochMilli()
        } else {
            startDay.plusMinutes(index * (step / MINUTE)).atZone(zone).toInstant().toEpochMilli()
        }
        var index = 0L
        while (local(index) < fromMs) index += 1
        val ticks = mutableListOf<Tick>()
        var at = local(index)
        val time = DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale)
        while (at <= toMs && ticks.size < most + 1) {
            val date: LocalDateTime = Instant.ofEpochMilli(at).atZone(zone).toLocalDateTime()
            val newDay = date.hour == 0 && date.minute == 0
            val label = when {
                step >= DAY -> DateTimeFormatter.ofPattern("d MMM", locale).format(date)
                newDay -> DateTimeFormatter.ofPattern("EEE d MMM", locale).format(date)
                else -> time.format(date)
            }
            ticks += Tick(at, label, newDay)
            index += 1
            at = local(index)
        }
        return ticks
    }

    sealed class Custom {
        data class Ok(val fromMs: Long, val toMs: Long) : Custom()
        data class Wrong(val error: String) : Custom()
    }

    /** The range a person chose: local times, at most 31 days, before now. */
    fun customRange(fromMs: Long?, toMs: Long?, nowMs: Long): Custom {
        if (fromMs == null || toMs == null) return Custom.Wrong("Give a start and an end, both with a date and a time.")
        val to = minOf(toMs, nowMs)
        if (fromMs >= to) return Custom.Wrong("The start has to be before the end, and before now.")
        if (to - fromMs > LONGEST_RANGE) return Custom.Wrong("A range can be at most 31 days long.")
        return Custom.Ok(fromMs, to)
    }

    /** A key for an event that stays the same from one load to the next. */
    fun eventKey(event: BoardEvent): String {
        val owner = event.thing?.takeLast(8) ?: "console"
        return "$owner-${event.atMs}-${event.id.replace(Regex("[^A-Za-z0-9]"), "_")}"
    }

    /** An entry of the activity log as an event of the Console lane. */
    fun consoleEvent(entry: AuditEntry, devices: List<Device>? = null): BoardEvent? {
        val at = entry.at ?: return null
        val words = AuditText.describe(entry)
        val link = when (val target = words.link) {
            is LogLink.ToDeployment -> "deployment:${target.id}"
            LogLink.ToFirmware -> "firmware"
            null -> null
        }
        return BoardEvent(
            thing = null,
            at = at,
            id = entry.requestId.ifEmpty { "0" },
            kind = "console",
            what = entry.action,
            level = if (entry.outcome == "ok") "info" else "warn",
            text = AuditText.spoken(entry, devices),
            href = link,
        )
    }

    /**
     * A lane of the timeline. [lines] are its board's own log in the range, drawn as ticks at the
     * foot of the lane: where it was talking, not read out (the Board log lists every one).
     */
    data class Lane(
        val id: String,
        val thing: String?,
        val label: String,
        val device: Device?,
        val events: List<BoardEvent>,
        val lines: List<BoardLine> = emptyList(),
    )

    /**
     * The lanes of the timeline: one per board, in the order of their thing names, and the Console
     * lane last. A board that has events or lines and is no longer in the list keeps its lane.
     */
    fun lanesOf(
        events: List<BoardEvent>,
        devices: List<Device>,
        thing: String = "",
        consoleEvents: List<BoardEvent>?,
        lines: List<BoardLine> = emptyList(),
    ): List<Lane> {
        val names = if (thing.isNotEmpty()) {
            listOf(thing)
        } else {
            (devices.map { it.thing } + events.mapNotNull { it.thing } + lines.map { it.thing }).toSortedSet().filter { ApiJson.isThing(it) }
        }
        val lanes = names.map { name ->
            Lane(
                name, name, Boards.name(Boards.of(name, devices)), devices.firstOrNull { it.thing == name },
                events.filter { it.thing == name }, lines.filter { it.thing == name },
            )
        }.toMutableList()
        if (consoleEvents != null) lanes += Lane("console", null, "Console", null, consoleEvents)
        return lanes
    }

    data class Band(val fromMs: Long, val toMs: Long, val inferred: Boolean)

    /** When a board was online within the range, from its connected and disconnected events. */
    fun onlineBands(events: List<BoardEvent>, fromMs: Long, toMs: Long, device: Device?, live: Boolean): List<Band> {
        data class Change(val ms: Long, val up: Boolean)
        val changes = events.filter { it.kind == "connection" }
            .mapNotNull { event -> Times.parse(event.at)?.let { Change(it, event.what == "connected") } }
            .sortedBy { it.ms }
        val heard = if (live) Times.parse(device?.lastSeen) else null
        val bands = mutableListOf<Band>()
        var up = if (changes.isNotEmpty()) !changes[0].up else live && device?.online == true
        var since = fromMs
        for (change in changes) {
            if (change.up && !up) {
                up = true
                since = change.ms
            } else if (!change.up && up) {
                bands += Band(since, change.ms, false)
                up = false
            }
        }
        if (up) {
            val end = if (live && device != null && !device.online && heard != null) minOf(toMs, heard + ONLINE_WINDOW_MS) else toMs
            bands += Band(since, end, false)
        } else if (live && device?.online == true && changes.isNotEmpty()) {
            bands += Band(changes.last().ms, toMs, true)
        }
        return bands
            .map { it.copy(fromMs = it.fromMs.coerceIn(fromMs, toMs), toMs = it.toMs.coerceIn(fromMs, toMs)) }
            .filter { it.toMs > it.fromMs }
    }

    /** Events newest first, the kinds that are switched off left out. */
    fun shownEvents(lanes: List<Lane>, hidden: Set<String>): List<BoardEvent> =
        lanes.flatMap { it.events }
            .filter { it.kind !in hidden }
            .sortedWith(compareByDescending<BoardEvent> { it.atMs }.thenByDescending { eventKey(it) })

    /** How far up or down to move each marker of a lane so that markers at one spot do not hide each other. */
    fun staggered(events: List<BoardEvent>, fromMs: Long, toMs: Long, reach: Float = 0.007f): Map<String, Int> {
        val lift = mutableMapOf<String, Int>()
        var anchor = Float.NEGATIVE_INFINITY
        var run = 0
        for (event in events.sortedBy { it.atMs }) {
            val x = place(event.atMs, fromMs, toMs)
            if (x - anchor <= reach) {
                run += 1
            } else {
                anchor = x
                run = 0
            }
            lift[eventKey(event)] = listOf(0, -1, 1)[run % 3]
        }
        return lift
    }

    /** The markers of a lane that sit close to one: the details of one name them all. */
    fun neighbours(events: List<BoardEvent>, atMs: Long, fromMs: Long, toMs: Long, reach: Float = 0.006f): List<BoardEvent> {
        val here = place(atMs, fromMs, toMs)
        return events.filter { abs(place(it.atMs, fromMs, toMs) - here) <= reach }
    }

    /** A board's state now, for its lane. */
    fun laneState(device: Device): Pair<Tone, String> = when {
        device.online -> Tone.GOOD to "Online now"
        device.lastSeen == null -> Tone.IDLE to "Never connected"
        else -> Tone.IDLE to "Offline now"
    }

    // Words for what a board reports.

    private val CAUSE_WORDS = mapOf(
        "pin" to "the reset pin", "software" to "a software restart", "brownout" to "a brownout", "power_on" to "a loss of power",
        "watchdog" to "the watchdog", "debugger" to "the debugger", "security" to "a security reset", "wake" to "a wake from off",
        "lockup" to "a CPU lockup", "parity" to "a parity error", "pll" to "a clock fault", "clock" to "a clock fault",
        "hardware" to "a hardware reset", "user" to "a user reset", "temperature" to "a temperature reset", "unknown" to "an unknown cause",
    )
    private val BAD_CAUSES = setOf("brownout", "watchdog", "lockup", "security", "parity", "pll", "clock", "hardware", "temperature")
    private val STAGE_WORDS = mapOf(
        0 to "Did not start its program", 1 to "Started its program", 2 to "Started its update manager",
        3 to "Got onto the network", 4 to "Reached the cloud",
    )
    private val STUCK_WORDS = mapOf(
        "wifi_silent" to "the Wi-Fi chip stopped answering",
        "no_cloud" to "no connection to the cloud for 15 minutes",
        "update_stall" to "an update stopped moving",
    )
    val BT_WORDS = mapOf(
        "pending" to "Waiting to be proved", "succeeded" to "Succeeded", "rolled_back" to "Rolled back",
        "not_installed" to "Not installed", "trial_lost" to "Lost its trial", "superseded" to "Replaced by a cloud update",
        "flash_error" to "Could not be written to flash",
        "incompatible_board" to "Refused: the image is for another board",
        "incompatible_layout" to "Refused: the image is for another flash layout",
    )
    val BAD_BT = setOf("rolled_back", "not_installed", "trial_lost", "flash_error", "incompatible_board", "incompatible_layout")
    val PROOF_WORDS = mapOf("person" to "Kept by a person at the board", "cloud" to "Proved by the cloud", "none" to "Not proved")

    /** Why a boot ended, in words: "the watchdog", "a brownout and a CPU lockup". */
    fun causeWords(causes: List<String>): String {
        val words = causes.map { CAUSE_WORDS[it] ?: CAUSE_WORDS.getValue("unknown") }.distinct()
        return if (words.isNotEmpty()) words.joinToString(" and ") else CAUSE_WORDS.getValue("unknown")
    }

    fun stageWords(stage: Int): String = STAGE_WORDS[stage] ?: "Stage $stage"

    data class BootRow(val boot: Long, val version: String, val running: Boolean, val reached: String, val before: String, val bad: Boolean)

    /** The boot diary as table rows, newest first. */
    fun diaryRows(diary: Diary?): List<BootRow> = diary?.entries?.mapIndexed { index, entry ->
        BootRow(
            boot = diary.boots - index,
            version = entry.version,
            running = index == 0,
            reached = stageWords(entry.stage),
            before = causeWords(entry.causes),
            bad = entry.causes.any { it in BAD_CAUSES },
        )
    }.orEmpty()

    data class StuckWords(val tone: Tone, val badge: String?, val text: String)

    fun stuckWords(stuck: Stuck?): StuckWords? {
        if (stuck == null) return null
        if (stuck.count == 0L) return StuckWords(Tone.GOOD, null, "Has not had to restart itself for being stuck")
        val why = STUCK_WORDS[stuck.reason] ?: "reason ${stuck.reason}"
        return if (stuck.count == 1L) {
            StuckWords(Tone.WARN, "Once", "Restarted itself once for being stuck, because $why")
        } else {
            StuckWords(
                Tone.WARN, "${stuck.count} in a row",
                "Restarted itself ${stuck.count} times in a row for being stuck; the last time because $why",
            )
        }
    }

    data class HeapWords(val tone: Tone, val ranLow: Boolean, val used: Int, val leastUsed: Int, val text: String, val least: String)

    /** How much memory is free, as words and a tone for the bar. */
    fun heapWords(heap: Heap?): HeapWords? {
        if (heap == null) return null
        val share = heap.free.toDouble() / heap.size
        val leastShare = heap.least.toDouble() / heap.size
        val tone = when {
            share < LOW_HEAP_SHARE -> Tone.BAD
            share < TIGHT_HEAP_SHARE -> Tone.WARN
            else -> Tone.LIVE
        }
        return HeapWords(
            tone = tone,
            ranLow = leastShare < LOW_HEAP_SHARE,
            used = ((1 - share) * 100).roundToInt(),
            leastUsed = ((1 - leastShare) * 100).roundToInt(),
            text = "${Words.fileSize(heap.free)} free of ${Words.fileSize(heap.size)}",
            least = "At least ${Words.fileSize(heap.least)} has stayed free since it started (${(leastShare * 100).roundToInt()}%)",
        )
    }

    private fun versionAtLeast(version: String?, major: Int, minor: Int, revision: Int): Boolean {
        val parsed = version?.let { FirmwareVersion.parseStrict(it) } ?: return false
        return parsed >= FirmwareVersion(major, minor, revision, 0)
    }

    /** Why a board shows no diagnostics report: plainly, by its firmware. */
    fun diagMissing(device: Device): String {
        val version = device.fw?.version
        if (version != null && !versionAtLeast(version, 1, 10, 0)) return "Needs firmware 1.10.0 or later. This board runs $version."
        if (version == null) return "Needs firmware 1.10.0 or later. This board has not said what it runs."
        return "No diagnostics report yet. A board on 1.10.0 or later sends one when it connects and every 5 minutes."
    }

    fun diaryMissing(device: Device): String {
        val version = device.fw?.version
        if (version != null && !versionAtLeast(version, 1, 7, 4)) return "Needs firmware 1.7.4 or later. This board runs $version."
        return "No boot diary yet. A board on 1.7.4 or later sends it when it connects."
    }

    /** "12 s ago" to the second for the first two minutes, then as the rest of the console says it. */
    fun heartbeatAge(lastSeen: String?, nowMs: Long): String {
        val then = Times.parse(lastSeen) ?: return ""
        val seconds = (nowMs - then) / 1000
        if (seconds < 120) return "${maxOf(0, seconds)} s ago"
        return Words.timeAgo(lastSeen, nowMs)
    }

    /** The uptime now, counted on from the last heartbeat while the board is online. */
    fun uptimeNow(device: Device, nowMs: Long): Long? {
        val uptime = device.uptime ?: return null
        val seen = Times.parse(device.lastSeen)
        if (!device.online || seen == null) return uptime
        return uptime + maxOf(0, (nowMs - seen) / 1000)
    }

    // Readings.

    data class Point(val ms: Long, val v: Double)

    /** A series as runs of points that belong together: a long gap between two readings breaks the line. */
    fun lineRuns(points: List<Point>, gapMs: Long): List<List<Point>> {
        val runs = mutableListOf<List<Point>>()
        var run = mutableListOf<Point>()
        for (point in points) {
            if (run.isNotEmpty() && point.ms - run.last().ms > gapMs) {
                runs += run
                run = mutableListOf()
            }
            run += point
        }
        if (run.isNotEmpty()) runs += run
        return runs
    }

    /** The longest gap between readings that still counts as reporting, for points `bucketSeconds` apart. */
    fun gapFor(bucketSeconds: Long): Long = maxOf(150_000L, (2.5 * bucketSeconds * 1000).roundToLong())

    /** The readings of one field as points, oldest first. */
    fun pointsOf(samples: List<Sample>, field: (Sample) -> Number?): List<Point> =
        samples.mapNotNull { sample ->
            val value = field(sample)?.toDouble() ?: return@mapNotNull null
            val ms = Times.parse(sample.at) ?: return@mapNotNull null
            Point(ms, value)
        }

    data class HourRow(val ms: Long, val low: Double, val mean: Double, val high: Double, val count: Int)

    /** The readings of each hour: lowest, mean and highest, newest hour first. */
    fun hourlyRows(points: List<Point>, zone: ZoneId = ZoneId.systemDefault()): List<HourRow> =
        points.groupBy { point ->
            Instant.ofEpochMilli(point.ms).atZone(zone).withMinute(0).withSecond(0).withNano(0).toInstant().toEpochMilli()
        }.entries.sortedByDescending { it.key }.map { (ms, group) ->
            val values = group.map { it.v }
            HourRow(ms, values.min(), Math.round(values.average()).toDouble(), values.max(), values.size)
        }
}
