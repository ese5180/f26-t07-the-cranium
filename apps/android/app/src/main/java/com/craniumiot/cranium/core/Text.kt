package com.craniumiot.cranium.core

import java.text.NumberFormat
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.time.temporal.ChronoUnit
import java.util.Locale
import kotlin.math.floor
import kotlin.math.roundToLong

/**
 * Numbers and times as people read them, in the website's words (core.js, "Numbers and times as
 * people read them"). Every function takes the clock, and where it matters the zone and the
 * locale, so that the tests can fix them.
 */
object Words {
    private const val SECOND = 1000L
    private const val MINUTE = 60 * SECOND
    private const val HOUR = 60 * MINUTE
    private const val DAY = 24 * HOUR

    /** From this age on a time is told by its date, not by how long ago it was. */
    private const val DATED_FROM = 14 * DAY

    /** "3 min ago". Empty if there is no time. */
    fun timeAgo(iso: String?, nowMs: Long, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String {
        val then = Times.parse(iso) ?: return ""
        val elapsed = nowMs - then
        return when {
            elapsed < 5 * SECOND -> "just now"
            elapsed < MINUTE -> "${elapsed / SECOND} s ago"
            elapsed < HOUR -> "${elapsed / MINUTE} min ago"
            elapsed < DAY -> "${elapsed / HOUR} h ago"
            elapsed < DATED_FROM -> "${elapsed / DAY} d ago"
            else -> DateTimeFormatter.ofPattern("d MMM yyyy", locale).format(Instant.ofEpochMilli(then).atZone(zone))
        }
    }

    /** True for a time that [timeAgo] tells by its date. */
    fun toldByDate(iso: String?, nowMs: Long): Boolean {
        val then = Times.parse(iso) ?: return false
        return nowMs - then >= DATED_FROM
    }

    /** The full local date and time. */
    fun exactTime(iso: String?, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String {
        val then = Times.parse(iso) ?: return ""
        return DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM).withLocale(locale)
            .format(Instant.ofEpochMilli(then).atZone(zone))
    }

    /** The time of day, with the day as well when it is not today. */
    fun clockTime(iso: String?, nowMs: Long, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String {
        val then = Times.parse(iso) ?: return ""
        val at = Instant.ofEpochMilli(then).atZone(zone)
        val time = DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale).format(at)
        return if (at.toLocalDate() == Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate()) {
            time
        } else {
            "${DateTimeFormatter.ofPattern("d MMM", locale).format(at)}, $time"
        }
    }

    /** The date and the time of day, for a time so old that "ago" says nothing. */
    fun dateAndTime(iso: String?, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String {
        val then = Times.parse(iso) ?: return ""
        val at = Instant.ofEpochMilli(then).atZone(zone)
        return "${DateTimeFormatter.ofPattern("d MMM yyyy", locale).format(at)}, " +
            DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale).format(at)
    }

    /** The time of day alone, for an entry under a heading that already names its day. */
    fun timeOfDay(iso: String?, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String {
        val then = Times.parse(iso) ?: return ""
        return DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale).format(Instant.ofEpochMilli(then).atZone(zone))
    }

    /** "Today", "Yesterday" or a date: the heading a log entry is filed under. */
    fun dayLabel(iso: String?, nowMs: Long, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String {
        val then = Times.parse(iso) ?: return "Undated"
        val day = Instant.ofEpochMilli(then).atZone(zone).toLocalDate()
        val today = Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate()
        return when (ChronoUnit.DAYS.between(day, today)) {
            0L -> "Today"
            1L -> "Yesterday"
            else -> DateTimeFormatter.ofPattern("EEE, d MMM yyyy", locale).format(day)
        }
    }

    /** A day's start in the zone, for grouping. */
    fun localDay(ms: Long, zone: ZoneId = ZoneId.systemDefault()): LocalDate = Instant.ofEpochMilli(ms).atZone(zone).toLocalDate()

    /** A length of time: "42 s", "5 min", "2 h 14 min", "3 d 4 h". Empty for no length. */
    fun duration(seconds: Double): String {
        if (!seconds.isFinite() || seconds < 0) return ""
        val total = floor(seconds).toLong()
        if (total < 60) return "$total s"
        val minutes = total / 60
        if (minutes < 60) return "$minutes min"
        val hours = minutes / 60
        if (hours < 24) return if (minutes % 60 != 0L) "$hours h ${minutes % 60} min" else "$hours h"
        val days = hours / 24
        return if (hours % 24 != 0L) "$days d ${hours % 24} h" else "$days d"
    }

    fun duration(seconds: Long): String = duration(seconds.toDouble())

    /** A size in the binary units the flash layout is described in. */
    fun fileSize(bytes: Long?): String {
        if (bytes == null || bytes < 0) return ""
        if (bytes < 1024) return "$bytes bytes"
        if (bytes < 1024 * 1024) return "${(bytes / 1024.0).roundToLong()} KiB"
        return String.format(Locale.ROOT, "%.2f MiB", bytes / (1024.0 * 1024.0))
    }

    /** "1,264 bytes". */
    fun exactBytes(bytes: Long?): String {
        if (bytes == null) return ""
        return "${NumberFormat.getIntegerInstance(Locale.US).format(bytes)} bytes"
    }

    /** "3 boards", "1 board". */
    fun plural(count: Number, one: String, many: String = "${one}s"): String =
        "$count ${if (count.toLong() == 1L) one else many}"

    /** A signed number with a true minus sign: "−61". */
    fun signed(number: Number): String = if (number.toLong() < 0) "−${Math.abs(number.toLong())}" else number.toString()

    /** Wi-Fi signal strength in words and as a number of bars out of four. */
    data class Signal(val bars: Int, val label: String)

    fun signalQuality(rssi: Int?): Signal? = when {
        rssi == null -> null
        rssi >= -55 -> Signal(4, "Excellent")
        rssi >= -67 -> Signal(3, "Good")
        rssi >= -75 -> Signal(2, "Fair")
        else -> Signal(1, "Weak")
    }

    /** A message as a sentence: some of the server's come without their full stop. */
    fun sentence(message: String?): String {
        val words = message.orEmpty().trim()
        return if (words.isEmpty() || words.last() in ".!?…") words else "$words."
    }

    /**
     * Free text as the API takes it: on one line, without control characters. A line break or
     * another control character becomes a space; characters that cannot be seen are left out.
     */
    fun singleLine(text: String?): String {
        val spaced = text.orEmpty().replace(Regex("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]+"), " ")
        // By code point, as the website's /\p{C}/u: an emoji is one, a lone half of a pair is not kept.
        val kept = StringBuilder()
        spaced.codePoints().forEach { point ->
            val type = Character.getType(point)
            if (type != Character.CONTROL.toInt() && type != Character.FORMAT.toInt() && type != Character.PRIVATE_USE.toInt() &&
                type != Character.UNASSIGNED.toInt() && type != Character.SURROGATE.toInt()
            ) {
                kept.appendCodePoint(point)
            }
        }
        return kept.toString().trim()
    }

    /** The name recorded for an upload: the file's name in the characters the API accepts. */
    fun recordedFilename(name: String?): String {
        val cleaned = name.orEmpty().replace(Regex("[^A-Za-z0-9._-]"), "_").takeLast(64)
        return cleaned.ifEmpty { "image.signed.bin" }
    }

    /** The start of an account id: enough to tell a handful of accounts apart at a glance. */
    fun shortAccount(sub: String?): String {
        val id = sub.orEmpty()
        return if (id.length > 8) "${id.take(8)}…" else id
    }

    /** What to call a person: the address, or failing that the start of the account id. */
    fun nameOf(person: Person?): String = when {
        person == null -> "an unknown account"
        person.email.isNotEmpty() -> person.email
        person.sub.isNotEmpty() -> "account ${shortAccount(person.sub)}"
        else -> "an unknown account"
    }
}

/**
 * Boards by name. A board's thing name (cranium-…) is its identity in AWS IoT: it is in every
 * address, request and record, and never changes. Its own name is the device ID a person gave
 * it at its serial console, which firmware from 1.11.4 reports. Wherever a board is shown, the
 * name comes first and the thing name second; a board without a name is shown by its thing name.
 */
object Boards {
    // device_id_valid() in firmware/app/src/device.c: 1 to 32 letters and digits.
    private val NAME = Regex("^[A-Za-z0-9]{1,32}$")

    fun isBoardName(text: String?): Boolean = text != null && NAME.matches(text)

    /** What to call a board: its own name, or its thing name if it has none. */
    fun name(thing: String, name: String?, short: Boolean = false, full: Boolean = false): String {
        if (isBoardName(name)) return if (full && thing.isNotEmpty()) "$name · $thing" else name!!
        return if (short && thing.length > 12) "${thing.take(12)}…" else thing
    }

    fun name(device: Device, short: Boolean = false, full: Boolean = false): String = name(device.thing, device.name, short, full)

    /** True if the board has a name of its own, so that its thing name is shown second. */
    fun hasOwnName(device: Device): Boolean = isBoardName(device.name)

    /** The board with a thing name in a list of boards, or one that has no name if the list does not have it. */
    fun of(thing: String, devices: List<Device>?): Device = devices?.firstOrNull { it.thing == thing } ?: Device(thing = thing)
}
