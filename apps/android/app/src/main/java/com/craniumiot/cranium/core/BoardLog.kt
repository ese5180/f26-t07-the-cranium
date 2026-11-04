package com.craniumiot.cranium.core

import kotlinx.serialization.json.JsonElement
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/**
 * One line of a board's own log: what it printed on its serial console, from firmware 1.12.0
 * (`GET /api/events/log`, cloud/api/src/lib/lines.mjs), read as the website reads it (core.js
 * readLine). `id` is "<boot>.<seq>", unique within its board.
 */
data class BoardLine(
    val thing: String,
    val at: String,
    val id: String,
    val kind: String,
    val tag: String,
    val level: String,
    val text: String,
    val boot: Long?,
    val seq: Long?,
    /** Lines the board could not keep before this one: its queue was full while it was offline. */
    val dropped: Long?,
) {
    val atMs: Long get() = Times.parse(at) ?: 0L
    val warn: Boolean get() = level == "warn"

    /** Unique across boards, and the same from one load to the next. */
    val key: String get() = "$thing-$id"
}

/** A page of the board log, newest first. */
data class LinePage(val lines: List<BoardLine>, val cursor: String?, val from: String?, val to: String?)

/** The board log: what is asked for, how it is read, and its words, as the website has them (telemetry.js). */
object BoardLog {
    /** The kinds a line can have: those of events, less connection and firmware, and two of its own. */
    val KINDS = listOf("bluetooth", "update", "restart", "health", "setting", "log")

    /**
     * The sources on a board's console the API keeps (lib/lines.mjs TAGS). `CMD`, a board's answer
     * to a command from the console, comes from firmware 1.13.0.
     */
    val TAGS = listOf(
        "BT", "WIFI", "STUCK", "CONSOLE",
        "CMD",
        "app", "boot_diary", "bt_ota", "cloud", "factory", "health", "identity", "net", "ota", "store", "stuck", "ui",
    )

    /** The board cuts its own lines at 160 characters. */
    const val TEXT_LIMIT = 160

    /** A page: at most 500 lines. */
    const val PAGE = 500

    /** How many of its newest lines a board's page shows, from the last 24 hours. */
    const val RECENT_COUNT = 5
    const val RECENT_MS = 24 * 60 * 60_000L
    const val RECENT_REFRESH_MS = 30_000L

    private val LINE_ID = Regex("^(0|[1-9][0-9]{0,9})\\.([1-9][0-9]{0,9})$")
    private const val MOST = 4_294_967_295L

    const val TITLE = "Board log"
    const val HIDDEN_NOTE = "Hidden. The board log is every line a board on firmware 1.12.0 or later prints on its serial " +
        "console, a passkey or anything like a password never among them."
    const val EMPTY_TITLE = "No lines in this range."
    const val EMPTY_FILTERED = "Some sources, kinds or boards are left out: show them all, or choose a longer range."
    const val EMPTY_ALL = "A board on firmware 1.12.0 or later sends what it prints on its serial console. Older firmware sends nothing here."
    const val ALL_SOURCES = "All sources"
    const val SOURCE = "Source"
    const val SHOW = "Show the board log"
    const val HIDE = "Hide the board log"
    const val FAILED = "Could not load the board log."
    const val LOAD_MORE = "Load 500 more lines"
    const val RECENT_TITLE = "Latest lines"
    const val ALL_LINES = "All lines"
    const val RECENT_EMPTY = "No lines in the last 24 hours. A board on firmware 1.12.0 or later sends what it prints on its serial console."
    const val TICKS_NOTE = "A tick at the foot of a lane is a line of that board’s own log, listed under Board log."

    /** One line, or null for one that cannot be shown. */
    internal fun read(value: JsonElement?): BoardLine? {
        val item = J.obj(value) ?: return null
        val thing = J.str(item["thing"])?.takeIf(ApiJson::isThing) ?: return null
        val at = J.instant(item["at"]) ?: return null
        val kind = J.str(item["kind"])?.takeIf { it in KINDS } ?: return null
        val tag = J.str(item["tag"])?.takeIf { it in TAGS } ?: return null
        val id = J.str(item["id"])?.takeIf { LINE_ID.matches(it) } ?: return null
        return BoardLine(
            thing = thing,
            at = at,
            id = id,
            kind = kind,
            tag = tag,
            level = if (J.str(item["level"]) == "warn") "warn" else "info",
            text = J.boardText(item["text"], TEXT_LIMIT),
            boot = J.whole(item["boot"], 0, MOST),
            seq = J.whole(item["seq"], 1, MOST),
            dropped = J.whole(item["dropped"], 1, MOST),
        )
    }

    /** What the API is asked for: the kinds switched on, when not all are, and the one source chosen. */
    data class Query(val kinds: List<String>?, val tags: List<String>?, val none: Boolean)

    fun query(hidden: Set<String>, tag: String): Query {
        val kinds = KINDS.filter { it !in hidden }
        return Query(if (kinds.size < KINDS.size) kinds else null, if (tag in TAGS) listOf(tag) else null, kinds.isEmpty())
    }

    /** The lines that are shown: those of the kinds switched on, newest first. */
    fun shown(lines: List<BoardLine>, hidden: Set<String>): List<BoardLine> = lines.filter { it.kind !in hidden }

    /** "1 line lost before this one", "3 lines lost before this one". */
    fun dropped(count: Long): String = "${Words.plural(count, "line")} lost before this one"

    /** "Boot 42, line 7 of that boot". */
    fun place(line: BoardLine): String? {
        val boot = line.boot ?: return null
        val seq = line.seq ?: return null
        return "Boot $boot, line $seq of that boot"
    }

    /** The count above the list: "24 lines · 2 warnings · more in this range". */
    fun count(lines: List<BoardLine>, more: Boolean): String {
        val warnings = lines.count { it.warn }
        return listOfNotNull(
            Words.plural(lines.size.toLong(), "line"),
            if (warnings > 0) Words.plural(warnings.toLong(), "warning") else null,
            if (more) "more in this range" else null,
        ).joinToString(" · ")
    }

    /** Why the list is empty: something is left out, or the boards send nothing. */
    fun emptyText(tag: String, thing: String, hidden: Set<String>): String =
        if (tag.isNotEmpty() || thing.isNotEmpty() || KINDS.any { it in hidden }) EMPTY_FILTERED else EMPTY_ALL

    /** The time of day to the second: lines of a log come many to a minute. */
    fun secondOfDay(at: String, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String {
        val ms = Times.parse(at) ?: return ""
        return DateTimeFormatter.ofLocalizedTime(FormatStyle.MEDIUM).withLocale(locale).format(Instant.ofEpochMilli(ms).atZone(zone))
    }
}
