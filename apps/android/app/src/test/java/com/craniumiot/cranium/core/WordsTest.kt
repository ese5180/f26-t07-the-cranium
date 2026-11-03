package com.craniumiot.cranium.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId
import java.util.Locale

/** Numbers, times and names as people read them (core.js, "Numbers and times as people read them"). */
class WordsTest {
    private val utc = ZoneId.of("UTC")
    private val us = Locale.US
    private val now = 1_793_620_800_000L // 2026-11-02T12:00:00Z, a Monday
    private val second = 1_000L
    private val minute = 60 * second
    private val hour = 60 * minute
    private val day = 24 * hour

    private fun ago(ms: Long) = Times.iso(now - ms)

    @Test
    fun `how long ago, then the date`() {
        assertEquals("just now", Words.timeAgo(ago(4 * second), now, utc, us))
        assertEquals("just now", Words.timeAgo(Times.iso(now + 3 * second), now, utc, us))
        assertEquals("42 s ago", Words.timeAgo(ago(42 * second), now, utc, us))
        assertEquals("5 min ago", Words.timeAgo(ago(5 * minute + 59 * second), now, utc, us))
        assertEquals("3 h ago", Words.timeAgo(ago(3 * hour), now, utc, us))
        assertEquals("13 d ago", Words.timeAgo(ago(13 * day), now, utc, us))
        assertEquals("19 Oct 2026", Words.timeAgo(ago(14 * day), now, utc, us))
        assertEquals("", Words.timeAgo("not a time", now, utc, us))
        assertEquals("", Words.timeAgo(null, now, utc, us))
    }

    @Test
    fun `a time is told by its date from 14 days on`() {
        assertFalse(Words.toldByDate(ago(13 * day), now))
        assertTrue(Words.toldByDate(ago(14 * day), now))
        assertFalse(Words.toldByDate("not a time", now))
        assertFalse(Words.toldByDate(null, now))
    }

    @Test
    fun `a log is filed under today, yesterday or a date`() {
        assertEquals("Today", Words.dayLabel("2026-11-02T00:00:01.000Z", now, utc, us))
        assertEquals("Yesterday", Words.dayLabel("2026-11-01T23:59:00.000Z", now, utc, us))
        assertEquals("Fri, 30 Oct 2026", Words.dayLabel("2026-10-30T08:00:00.000Z", now, utc, us))
        assertEquals("Undated", Words.dayLabel("nope", now, utc, us))
    }

    @Test
    fun `the date and the time of day are written out where they matter`() {
        assertTrue(Words.dateAndTime("2026-10-19T08:05:00.000Z", utc, us).startsWith("19 Oct 2026, "))
        assertTrue(Words.clockTime("2026-11-01T08:05:00.000Z", now, utc, us).startsWith("1 Nov, "))
        assertFalse("today has no date", Words.clockTime("2026-11-02T08:05:00.000Z", now, utc, us).contains("Nov"))
        assertTrue(Words.exactTime("2026-11-02T08:05:00.000Z", utc, us).contains("2026"))
        assertEquals("", Words.exactTime(null, utc, us))
        assertEquals("", Words.timeOfDay("nope", utc, us))
        assertEquals(java.time.LocalDate.of(2026, 11, 2), Words.localDay(now, utc))
    }

    @Test
    fun `a length of time`() {
        assertEquals("0 s", Words.duration(0))
        assertEquals("42 s", Words.duration(42))
        assertEquals("42 s", Words.duration(42.9))
        assertEquals("5 min", Words.duration(300))
        assertEquals("2 h", Words.duration(7200))
        assertEquals("2 h 14 min", Words.duration(8040))
        assertEquals("3 d", Words.duration(3 * 86_400L))
        assertEquals("3 d 4 h", Words.duration(273_600L))
        assertEquals("", Words.duration(-1))
        assertEquals("", Words.duration(Double.NaN))
    }

    @Test
    fun `sizes in the units of the flash layout, and exact`() {
        assertEquals("500 bytes", Words.fileSize(500))
        assertEquals("1023 bytes", Words.fileSize(1023))
        assertEquals("1 KiB", Words.fileSize(1024))
        assertEquals("2 KiB", Words.fileSize(1536))
        assertEquals("776 KiB", Words.fileSize(794_624))
        assertEquals("1.00 MiB", Words.fileSize(1_048_576))
        assertEquals("", Words.fileSize(null))
        assertEquals("", Words.fileSize(-1))
        assertEquals("1,264 bytes", Words.exactBytes(1264))
        assertEquals("794,624 bytes", Words.exactBytes(794_624))
        assertEquals("", Words.exactBytes(null))
    }

    @Test
    fun `plurals and signed numbers`() {
        assertEquals("1 board", Words.plural(1, "board"))
        assertEquals("3 boards", Words.plural(3, "board"))
        assertEquals("0 boards", Words.plural(0, "board"))
        assertEquals("2 entries", Words.plural(2, "entry", "entries"))
        assertEquals("1 day", Words.plural(1L, "day"))
        assertEquals("−61", Words.signed(-61))
        assertEquals("0", Words.signed(0))
        assertEquals("5", Words.signed(5))
    }

    @Test
    fun `the signal in words and bars`() {
        assertEquals(Words.Signal(4, "Excellent"), Words.signalQuality(-55))
        assertEquals(Words.Signal(3, "Good"), Words.signalQuality(-56))
        assertEquals(Words.Signal(3, "Good"), Words.signalQuality(-67))
        assertEquals(Words.Signal(2, "Fair"), Words.signalQuality(-68))
        assertEquals(Words.Signal(2, "Fair"), Words.signalQuality(-75))
        assertEquals(Words.Signal(1, "Weak"), Words.signalQuality(-76))
        assertNull(Words.signalQuality(null))
    }

    @Test
    fun `the server's words as a sentence, and free text as the API takes it`() {
        assertEquals("No such release.", Words.sentence("No such release"))
        assertEquals("Done.", Words.sentence("Done."))
        assertEquals("Really?", Words.sentence("  Really?  "))
        assertEquals("", Words.sentence(null))
        assertEquals("a b", Words.singleLine("a\nb"))
        assertEquals("a b", Words.singleLine("a\r\n\tb"))
        assertEquals("ab", Words.singleLine("a​b"))
        assertEquals("x", Words.singleLine("\t x \r\n"))
        assertEquals("", Words.singleLine(null))
    }

    @Test
    fun `the name an upload is recorded under`() {
        assertEquals("my_image__1_.bin", Words.recordedFilename("my image (1).bin"))
        assertEquals("latest.signed.bin", Words.recordedFilename("latest.signed.bin"))
        assertEquals("image.signed.bin", Words.recordedFilename(""))
        assertEquals("image.signed.bin", Words.recordedFilename(null))
        val long = "a".repeat(70) + ".bin"
        assertEquals(64, Words.recordedFilename(long).length)
        assertTrue(Words.recordedFilename(long).endsWith(".bin"))
    }

    @Test
    fun `a person is called by the address, or the start of the account`() {
        assertEquals("rm@example.com", Words.nameOf(Person("abc", "rm@example.com")))
        assertEquals("account 01234567…", Words.nameOf(Person("0123456789abc", "")))
        assertEquals("account abc", Words.nameOf(Person("abc", "")))
        assertEquals("an unknown account", Words.nameOf(Person()))
        assertEquals("an unknown account", Words.nameOf(null))
        assertEquals("01234567…", Words.shortAccount("0123456789abc"))
        assertEquals("01234567", Words.shortAccount("01234567"))
        assertEquals("", Words.shortAccount(null))
    }

    @Test
    fun `a board is called by its own name first and its thing name second`() {
        val thing = "cranium-0123456789abcdef"
        assertEquals("CRVIHAAN01", Boards.name(thing, "CRVIHAAN01"))
        assertEquals("CRVIHAAN01 · $thing", Boards.name(thing, "CRVIHAAN01", full = true))
        assertEquals(thing, Boards.name(thing, null))
        assertEquals("cranium-0123…", Boards.name(thing, null, short = true))
        assertEquals(thing, Boards.name(thing, "bad name!"))
        assertEquals("CRVIHAAN01", Boards.name(Device(thing = thing, name = "CRVIHAAN01"), short = true))
        assertTrue(Boards.hasOwnName(Device(thing = thing, name = "A1")))
        assertFalse(Boards.hasOwnName(Device(thing = thing)))
        assertTrue(Boards.isBoardName("A".repeat(32)))
        assertFalse(Boards.isBoardName("A".repeat(33)))
        assertFalse(Boards.isBoardName(""))
        val listed = Device(thing = thing, name = "CRVIHAAN01")
        assertEquals(listed, Boards.of(thing, listOf(listed)))
        assertEquals(Device(thing = "cranium-00000000000000aa"), Boards.of("cranium-00000000000000aa", listOf(listed)))
        assertEquals(Device(thing = thing), Boards.of(thing, null))
    }

    @Test
    fun `times go and come back as the console writes them`() {
        assertEquals(now, Times.parse("2026-11-02T12:00:00.000Z"))
        assertEquals(now, Times.parse("2026-11-02T12:00:00Z"))
        assertEquals(now, Times.parse("2026-11-02T13:00:00+01:00"))
        assertEquals("2026-11-02T12:00:00.000Z", Times.iso(now))
        assertEquals("2026-11-02T12:00:00.123Z", Times.iso(now + 123))
        assertEquals("2026-11-02T12:00:00.100Z", Times.iso(now + 100))
        assertEquals(now + 123, Times.parse(Times.iso(now + 123)))
        assertNull(Times.parse("not a time"))
        assertNull(Times.parse(""))
        assertNull(Times.parse(null))
    }
}
