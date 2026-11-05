package com.craniumiot.cranium.core

import com.craniumiot.cranium.core.UpdateWatch.Outcome
import com.craniumiot.cranium.core.UpdateWatch.State
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The steps after a Bluetooth send. The iPhone app's UpdateWatchTests have the same cases and the same words. */
class UpdateWatchTest {
    private val thing = "cranium-0123456789abcdef"
    private val sent = Times.parse("2026-11-05T12:13:00.000Z")!!

    private fun t(seconds: Double): Long = sent + (seconds * 1000).toLong()
    private fun iso(seconds: Double): String = Times.iso(t(seconds))

    private fun line(seconds: Double, text: String, tag: String = "BT", seq: Long = 1) =
        BoardLine(thing, iso(seconds), "7.$seq", "bluetooth", tag, "info", text, 7, seq, null)

    private fun connection(seconds: Double, what: String) = BoardEvent(thing, iso(seconds), "000000", "connection", what, "info", what)

    /** A board that reported at [seen] s after the send, up for [uptime] s, running [version]. */
    private fun device(seen: Double, uptime: Long, version: String, confirmed: Boolean, online: Boolean = true, bt: BtRecord? = null) =
        Device(thing = thing, online = online, fw = DeviceFirmware(version, confirmed), lastSeen = iso(seen), uptime = uptime, bt = bt)

    private fun facts(thing: String? = this.thing, onConsole: Boolean? = true, dropped: Double? = null) =
        UpdateWatch.Facts(version = "1.13.0+0", from = "1.12.0+0", sentAt = sent, thing = thing, onConsole = onConsole, linkDroppedAt = dropped?.let(::t))

    private fun states(timeline: UpdateWatch.Timeline) = timeline.rows.map { it.state }

    @Test
    fun `waiting for a button counts down`() {
        val timeline = UpdateWatch.timeline(facts())
        assertEquals(
            listOf("Sent 1.13.0+0", "Button 1 pressed, accepted", "Installing and restarting", "Running 1.13.0+0 on trial", "Kept 1.13.0+0"),
            timeline.rows.map { it.title },
        )
        assertEquals("Press Button 1 on the board within 2 minutes to install it (Button 2 throws it away).", timeline.rows[0].detail)
        assertEquals(sent, timeline.rows[0].at)
        assertEquals(listOf(State.DONE, State.CURRENT, State.WAITING, State.WAITING, State.WAITING), states(timeline))
        assertTrue(timeline.waitingForButton)
        assertEquals(t(120.0), timeline.deadline)
        assertTrue(!timeline.finished && timeline.outcome == null && timeline.note == null)
        assertEquals("1:42 left", UpdateWatch.countdown(102))
        assertEquals("2:00 left", UpdateWatch.countdown(120))
        assertEquals("0:09 left", UpdateWatch.countdown(9))
        assertEquals("The 2 minutes are up.", UpdateWatch.countdown(0))
    }

    @Test
    fun kept() {
        // The real one: offline at the press, back 15 s later on the new version, kept when it reached AWS IoT.
        var f = facts(dropped = 47.0).copy(events = listOf(connection(45.0, "disconnected"), connection(60.0, "connected")))
        val watching = UpdateWatch.timeline(f)
        assertEquals(listOf(State.DONE, State.DONE, State.DONE, State.WAITING, State.WAITING), states(watching))
        assertEquals(t(45.0), watching.rows[1].at)
        assertNull(watching.rows[1].detail)
        assertEquals(t(45.0), watching.rows[2].at)
        assertTrue(!watching.finished && !watching.waitingForButton)

        f = f.copy(lines = listOf(line(52.0, "on trial: 1.13.0+0 from 1.12.0+0, pending, proof none, update 3 of this board", seq = 1)))
        val trial = UpdateWatch.timeline(f)
        assertEquals(listOf(State.DONE, State.DONE, State.DONE, State.CURRENT, State.WAITING), states(trial))
        assertEquals("Back online with the new version, not yet kept.", trial.rows[3].detail)
        assertEquals(t(52.0), trial.rows[3].at)

        f = f.copy(lines = f.lines + line(61.0, "update over Bluetooth: 1.13.0+0 from 1.12.0+0, succeeded, proof cloud, update 3 of this board", seq = 9))
        val kept = UpdateWatch.timeline(f)
        assertEquals(listOf(State.DONE, State.DONE, State.DONE, State.DONE, State.DONE), states(kept))
        assertEquals("Kept 1.13.0+0", kept.rows[4].title)
        assertEquals("It reached AWS IoT, so the board keeps it.", kept.rows[4].detail)
        assertEquals(t(61.0), kept.rows[4].at)
        assertTrue(kept.outcome == Outcome.KEPT && !kept.tentative && kept.finished && kept.note == null)
        assertEquals(t(45.0), kept.acceptedAt)
        assertEquals(UpdateWatch.Record(thing, "1.13.0+0", t(45.0), Outcome.KEPT), UpdateWatch.record(f, kept))
    }

    @Test
    fun `kept from the board's report alone`() {
        // No lines (firmware before 1.12.0, or lost from a full queue): the board's report says it.
        var f = facts(dropped = 47.0).copy(device = device(70.0, 12, "1.13.0+0", false))
        val trial = UpdateWatch.timeline(f)
        assertEquals(listOf(State.DONE, State.DONE, State.DONE, State.CURRENT, State.WAITING), states(trial))
        assertEquals(t(58.0), trial.rows[3].at)
        f = f.copy(device = device(75.0, 17, "1.13.0+0", true, bt = BtRecord("1.12.0+0", "1.13.0+0", "succeeded", "cloud", 3)))
        val kept = UpdateWatch.timeline(f)
        assertTrue(kept.outcome == Outcome.KEPT && kept.finished)
        assertEquals("It reached AWS IoT, so the board keeps it.", kept.rows[4].detail)
        // A report from before the send says nothing about it.
        f = f.copy(device = device(-20.0, 4000, "1.12.0+0", true))
        assertNull(UpdateWatch.timeline(f).outcome)
    }

    @Test
    fun `rolled back`() {
        var f = facts(dropped = 40.0).copy(
            events = listOf(connection(38.0, "disconnected"), connection(400.0, "connected")),
            lines = listOf(
                line(52.0, "on trial: 1.13.0+0 from 1.12.0+0, pending, proof none, update 3 of this board", seq = 1),
                line(395.0, "update over Bluetooth: 1.13.0+0 from 1.12.0+0, rolled_back, proof none, update 3 of this board", seq = 2),
            ),
        )
        val timeline = UpdateWatch.timeline(f)
        assertEquals(listOf(State.DONE, State.DONE, State.DONE, State.DONE, State.FAILED), states(timeline))
        assertEquals("Rolled back to 1.12.0+0", timeline.rows[4].title)
        assertEquals("The new image was not kept: the bootloader put the old one back.", timeline.rows[4].detail)
        assertEquals(t(395.0), timeline.rows[4].at)
        assertTrue(timeline.outcome == Outcome.ROLLED_BACK && timeline.finished && timeline.rolledBackTo == "1.12.0+0")

        // Not installed at all: it never ran on trial.
        f = f.copy(lines = listOf(line(60.0, "update over Bluetooth: 1.13.0+0 from 1.12.0+0, not_installed, proof none, update 3 of this board")))
        val notInstalled = UpdateWatch.timeline(f)
        assertEquals(listOf(State.DONE, State.DONE, State.DONE, State.WAITING, State.FAILED), states(notInstalled))
        assertEquals("The bootloader did not install the new image.", notInstalled.rows[4].detail)

        // Only the board's report: back after the send, on the old version.
        f = f.copy(lines = emptyList(), events = listOf(connection(38.0, "disconnected")), device = device(90.0, 20, "1.12.0+0", true))
        val back = UpdateWatch.timeline(f)
        assertTrue(back.outcome == Outcome.ROLLED_BACK && back.rows[4].title == "Rolled back to 1.12.0+0")
        assertEquals("Back on the old version.", back.rows[4].detail)
        assertEquals(t(70.0), back.rows[4].at)
    }

    @Test
    fun `button 2`() {
        var f = facts(dropped = 31.0)
        val linkOnly = UpdateWatch.timeline(f)
        assertEquals(listOf(State.DONE, State.LIKELY, State.WAITING, State.WAITING, State.WAITING), states(linkOnly))
        assertEquals("The board closed the link: it is installing.", linkOnly.rows[1].detail)
        assertEquals(t(31.0), linkOnly.rows[1].at)
        assertFalse(linkOnly.finished)

        f = f.copy(lines = listOf(line(30.0, "closed: by Button 2")))
        val timeline = UpdateWatch.timeline(f)
        assertEquals(listOf("Sent 1.13.0+0", "Button 2 pressed: the image was thrown away"), timeline.rows.map { it.title })
        assertEquals(listOf(State.DONE, State.FAILED), states(timeline))
        assertEquals(t(30.0), timeline.rows[1].at)
        assertTrue(timeline.outcome == Outcome.DECLINED && timeline.finished && !timeline.tentative)
        assertEquals(sent, UpdateWatch.record(f, timeline)?.at)
    }

    @Test
    fun `the window ran out`() {
        var f = facts(dropped = 121.0).copy(lines = listOf(line(120.0, "closed: no image to install")))
        val timeline = UpdateWatch.timeline(f)
        assertEquals(listOf("Sent 1.13.0+0", "The 2 minutes ran out: the image was thrown away"), timeline.rows.map { it.title })
        assertTrue(timeline.outcome == Outcome.EXPIRED && timeline.finished && !timeline.tentative)

        // The link closing at the end of the 2 minutes, before the console has said so: most likely that.
        f = f.copy(lines = emptyList())
        val likely = UpdateWatch.timeline(f)
        assertEquals(listOf("Sent 1.13.0+0", "The 2 minutes ran out"), likely.rows.map { it.title })
        assertEquals(State.LIKELY, likely.rows[1].state)
        assertEquals("The board closed the link at the end of its 2 minutes: it has most likely thrown the image away.", likely.rows[1].detail)
        assertTrue(likely.outcome == Outcome.EXPIRED && likely.tentative && !likely.finished)
        // And Button 1 after all, if the board then goes offline: the console's word wins.
        f = f.copy(events = listOf(connection(118.0, "disconnected")))
        assertEquals("Button 1 pressed, accepted", UpdateWatch.timeline(f).rows[1].title)
        assertNull(UpdateWatch.timeline(f).outcome)
    }

    @Test
    fun `an offline board`() {
        val timeline = UpdateWatch.timeline(facts(onConsole = false, dropped = 40.0))
        assertEquals(listOf(State.DONE, State.LIKELY, State.WAITING, State.WAITING, State.WAITING), states(timeline))
        assertEquals("The board closed the link: it is installing.", timeline.rows[1].detail)
        assertEquals(
            "The board is not on the console, so the app can't follow it from here. After it restarts, check its version over Bluetooth.",
            timeline.note,
        )
        assertTrue(timeline.finished && timeline.outcome == null)
        // While the link is up the link is what is followed: nothing to say yet.
        assertNull(UpdateWatch.timeline(facts(onConsole = false)).note)
    }

    @Test
    fun `a link drop with no cloud`() {
        val timeline = UpdateWatch.timeline(facts(thing = null, onConsole = null, dropped = 40.0))
        assertEquals(listOf(State.DONE, State.LIKELY, State.WAITING, State.WAITING, State.WAITING), states(timeline))
        assertEquals(UpdateWatch.CANNOT_FOLLOW, timeline.note)
        assertTrue(timeline.finished)
        assertNull(UpdateWatch.record(facts(thing = null), timeline))
        // At the end of the 2 minutes, with nothing to ask: most likely thrown away, and said so.
        val late = UpdateWatch.timeline(facts(thing = null, onConsole = null, dropped = 119.0))
        assertTrue(late.outcome == Outcome.EXPIRED && late.tentative && late.finished && late.note == UpdateWatch.CANNOT_FOLLOW)
    }

    @Test
    fun `five minutes without an end`() {
        var f = facts(dropped = 40.0).copy(events = listOf(connection(39.0, "disconnected")), consoleFailed = true)
        val failing = UpdateWatch.timeline(f)
        assertEquals(listOf(State.DONE, State.DONE, State.CURRENT, State.WAITING, State.WAITING), states(failing))
        assertEquals("The board is offline on the console while it installs.", failing.rows[2].detail)
        assertEquals("The console could not be reached just now. The app keeps asking.", failing.note)
        assertFalse(failing.finished)
        f = f.copy(gaveUp = true)
        val gaveUp = UpdateWatch.timeline(f)
        assertEquals("5 minutes have passed, so the app has stopped following it. The board's page shows how it ends.", gaveUp.note)
        assertTrue(gaveUp.finished)
    }

    @Test
    fun `only this send counts`() {
        var f = facts(dropped = 40.0).copy(
            lines = listOf(
                // An earlier window, and another version.
                line(-200.0, "closed: by Button 2"),
                line(60.0, "update over Bluetooth: 1.12.0+0 from 1.11.0+0, succeeded, proof cloud, update 2 of this board"),
                // Not a line of the Bluetooth update, though it says the words.
                line(61.0, "update over Bluetooth: 1.13.0+0 from 1.12.0+0, succeeded, proof cloud, update 3 of this board", tag = "CMD"),
            ),
            events = listOf(connection(-100.0, "disconnected"), BoardEvent(thing, iso(45.0), "000000", "bluetooth", "closed", "info", "")),
        )
        val timeline = UpdateWatch.timeline(f)
        assertNull(timeline.outcome)
        assertEquals(listOf(State.DONE, State.LIKELY, State.WAITING, State.WAITING, State.WAITING), states(timeline))
        // The record of the board's restart into the bootloader, if it ever gets out before the restart, is Button 1.
        f = f.copy(lines = listOf(line(44.0, "restarting into the bootloader: 1.13.0+0 from 1.12.0+0, pending, proof none, update 3 of this board")))
        val restarting = UpdateWatch.timeline(f)
        assertTrue(restarting.rows[1].state == State.DONE && restarting.rows[1].at == t(44.0))
    }

    @Test
    fun `the board's page`() {
        val time: (Long) -> String = { "12:14" }
        val kept = UpdateWatch.Record(thing, "1.13.0+0", t(45.0), Outcome.KEPT)
        assertEquals("1.13.0+0 over Bluetooth at 12:14, kept", UpdateWatch.summary(kept, null, time))
        val back = UpdateWatch.Record(thing, "1.13.0+0", t(45.0), Outcome.ROLLED_BACK, rolledBackTo = "1.12.0+0")
        assertEquals("1.13.0+0 over Bluetooth at 12:14, rolled back to 1.12.0+0", UpdateWatch.summary(back, null, time))
        val declined = UpdateWatch.Record(thing, "1.13.0+0", t(0.0), Outcome.DECLINED)
        assertEquals("1.13.0+0 over Bluetooth at 12:14, thrown away with Button 2", UpdateWatch.summary(declined, null, time))
        val expired = UpdateWatch.Record(thing, "1.13.0+0", t(0.0), Outcome.EXPIRED)
        assertEquals("1.13.0+0 over Bluetooth at 12:14, not installed: the 2 minutes ran out", UpdateWatch.summary(expired, null, time))
        // Not followed to the end here: the board's own record finishes the sentence.
        val open = UpdateWatch.Record(thing, "1.13.0+0", t(45.0), null)
        val record = BtRecord("1.12.0+0", "1.13.0+0", "succeeded", "cloud", 3)
        assertEquals("1.13.0+0 over Bluetooth at 12:14, not followed to the end", UpdateWatch.summary(open, null, time))
        assertEquals("1.13.0+0 over Bluetooth at 12:14, kept", UpdateWatch.summary(open, record, time))
        // Only the board's record: no time, which it does not keep.
        assertEquals("1.13.0+0 over Bluetooth, kept", UpdateWatch.summary(null, record, time))
        val lost = BtRecord("1.12.0+0", "1.13.0+0", "rolled_back", "none", 0)
        assertEquals("1.13.0+0 over Bluetooth, rolled back to 1.12.0+0", UpdateWatch.summary(null, lost, time))
        assertNull(UpdateWatch.summary(null, null, time))
    }

    @Test
    fun `polling backs off on a 429`() {
        assertEquals(listOf(3_000L, 6_000L, 12_000L, 24_000L, 30_000L, 30_000L), listOf(0, 1, 2, 3, 4, 9).map(UpdateWatch::nextPoll))
    }

    // The board's own status over Bluetooth (firmware 1.14.0 on).

    private val hash = "deadbeef01020304"

    /** What the board says on the link of the send: an image on offer, by default. */
    private fun onLink(
        seconds: Double,
        window: BoardStatus.Window = BoardStatus.Window.OFFER,
        left: Int = 100,
        image: BoardStatus.Image = BoardStatus.Image.VERIFIED,
        result: BoardStatus.Result = BoardStatus.Result.NONE,
        refusal: BoardStatus.Refusal = BoardStatus.Refusal.NONE,
    ): UpdateWatch.Reading {
        val installing = result == BoardStatus.Result.INSTALLING
        return UpdateWatch.Reading(
            BoardStatus(
                window = window, secondsLeft = left, image = image, refusal = refusal, imageBytes = 872_000, imageVersion = "1.13.0+0",
                result = result, closedReason = 0, running = "1.12.0+0", onTrial = false, swap = BoardStatus.Swap.NONE,
                lastVia = BoardStatus.Via.BLUETOOTH,
                lastOutcome = if (installing) BoardStatus.Outcome.PENDING else BoardStatus.Outcome.KEPT,
                lastProof = if (installing) BoardStatus.Proof.NONE else BoardStatus.Proof.CLOUD,
                lastTarget = if (installing) "1.13.0+0" else "1.12.0+0", lastFrom = if (installing) "1.12.0+0" else "1.11.4+0",
                lastHash = if (installing) hash else "0102030405060708", lastCount = if (installing) 3 else 2, uptime = 4000,
            ),
            t(seconds),
        )
    }

    /** What the board says after its restart, to a phone that reads it with no pairing. */
    private fun afterRestart(
        seconds: Double,
        running: String = "1.13.0+0",
        onTrial: Boolean = true,
        outcome: BoardStatus.Outcome = BoardStatus.Outcome.PENDING,
        proof: BoardStatus.Proof = BoardStatus.Proof.NONE,
        target: String = "1.13.0+0",
        hash: String? = this.hash,
    ) = UpdateWatch.Reading(
        BoardStatus(
            window = BoardStatus.Window.STATUS, secondsLeft = 100, image = BoardStatus.Image.NONE, refusal = BoardStatus.Refusal.NONE,
            imageBytes = 0, imageVersion = null, result = BoardStatus.Result.NONE, closedReason = 0, running = running, onTrial = onTrial,
            swap = if (onTrial) BoardStatus.Swap.REVERT else BoardStatus.Swap.NONE, lastVia = BoardStatus.Via.BLUETOOTH,
            lastOutcome = outcome, lastProof = proof, lastTarget = target, lastFrom = "1.12.0+0", lastHash = hash, lastCount = 3,
            uptime = 20,
        ),
        t(seconds),
        afterRestart = true,
    )

    private fun told(
        vararg readings: UpdateWatch.Reading,
        dropped: Double? = null,
        thing: String? = this.thing,
        onConsole: Boolean? = true,
    ) = facts(thing, onConsole, dropped).copy(readings = readings.toList(), sentHash = hash)

    @Test
    fun `the board counts its two minutes down`() {
        val timeline = UpdateWatch.timeline(told(onLink(5.0, left = 100)))
        assertEquals(t(105.0), timeline.deadline)
        assertTrue(timeline.waitingForButton)
        assertEquals(listOf(State.DONE, State.CURRENT, State.WAITING, State.WAITING, State.WAITING), states(timeline))
        // A board without the characteristic: the phone's own count, as before.
        assertEquals(t(120.0), UpdateWatch.timeline(facts()).deadline)
    }

    @Test
    fun `button 1 from the board`() {
        var f = told(onLink(5.0), onLink(30.0, result = BoardStatus.Result.INSTALLING))
        val pressed = UpdateWatch.timeline(f)
        assertEquals(listOf(State.DONE, State.DONE, State.CURRENT, State.WAITING, State.WAITING), states(pressed))
        assertEquals("Button 1 pressed, accepted", pressed.rows[1].title)
        assertEquals("The board said so over Bluetooth, and is restarting to install it.", pressed.rows[1].detail)
        assertEquals(t(30.0), pressed.rows[1].at)
        assertEquals("The board is restarting into the bootloader, which checks the image and swaps it in.", pressed.rows[2].detail)
        assertEquals(t(30.0), pressed.rows[2].at)
        assertTrue(!pressed.waitingForButton && pressed.acceptedAt == t(30.0) && !pressed.finished)

        // The link goes, and the console has it offline: its word for the time it went.
        f = f.copy(linkDroppedAt = t(31.0), events = listOf(connection(31.0, "disconnected")))
        val offline = UpdateWatch.timeline(f)
        assertEquals(t(30.0), offline.rows[1].at)
        assertEquals("The board is offline on the console while it installs.", offline.rows[2].detail)
        assertEquals(t(31.0), offline.rows[2].at)
        assertEquals(t(30.0), UpdateWatch.record(f, offline)?.at)
    }

    @Test
    fun `kept from the board after its restart`() {
        var f = told(onLink(5.0), onLink(30.0, result = BoardStatus.Result.INSTALLING), afterRestart(140.0), dropped = 31.0)
        val trial = UpdateWatch.timeline(f)
        assertEquals(listOf(State.DONE, State.DONE, State.DONE, State.CURRENT, State.WAITING), states(trial))
        assertEquals("The board says so over Bluetooth: not yet kept.", trial.rows[3].detail)
        assertEquals(t(140.0), trial.rows[3].at)
        assertTrue(!trial.finished && trial.note == null)
        assertEquals(t(740.0), UpdateWatch.followUntil(f))

        f = f.copy(readings = f.readings + afterRestart(150.0, onTrial = false, outcome = BoardStatus.Outcome.KEPT, proof = BoardStatus.Proof.CLOUD))
        val kept = UpdateWatch.timeline(f)
        assertEquals(listOf(State.DONE, State.DONE, State.DONE, State.DONE, State.DONE), states(kept))
        assertEquals("Kept 1.13.0+0", kept.rows[4].title)
        assertEquals("It reached AWS IoT, so the board keeps it.", kept.rows[4].detail)
        assertEquals(t(150.0), kept.rows[4].at)
        assertEquals(t(140.0), kept.rows[3].at)
        assertTrue(kept.outcome == Outcome.KEPT && kept.finished && !kept.tentative)
    }

    @Test
    fun `rolled back from the board`() {
        // On trial, and 5 minutes later back on the old image, which says so.
        val f = told(
            onLink(30.0, result = BoardStatus.Result.INSTALLING),
            afterRestart(140.0),
            afterRestart(500.0, running = "1.12.0+0", onTrial = false, outcome = BoardStatus.Outcome.ROLLED_BACK),
            dropped = 31.0,
        )
        val timeline = UpdateWatch.timeline(f)
        assertEquals(listOf(State.DONE, State.DONE, State.DONE, State.DONE, State.FAILED), states(timeline))
        assertEquals("Rolled back to 1.12.0+0", timeline.rows[4].title)
        assertEquals("The new image was not kept: the bootloader put the old one back.", timeline.rows[4].detail)
        assertEquals(t(500.0), timeline.rows[4].at)
        assertTrue(timeline.outcome == Outcome.ROLLED_BACK && timeline.rolledBackTo == "1.12.0+0" && timeline.finished)

        // The bootloader did not take it, a bad signature for one: it never ran on trial.
        val notInstalled = UpdateWatch.timeline(
            told(
                onLink(30.0, result = BoardStatus.Result.INSTALLING),
                afterRestart(130.0, running = "1.12.0+0", onTrial = false, outcome = BoardStatus.Outcome.NOT_INSTALLED),
                dropped = 31.0,
            ),
        )
        assertEquals(listOf(State.DONE, State.DONE, State.DONE, State.WAITING, State.FAILED), states(notInstalled))
        assertEquals("The bootloader did not install the new image.", notInstalled.rows[4].detail)
    }

    @Test
    fun `button 2 and the time from the board`() {
        val discarded = UpdateWatch.timeline(told(onLink(5.0), onLink(30.0, window = BoardStatus.Window.CLOSED, result = BoardStatus.Result.DISCARDED)))
        assertEquals(listOf("Sent 1.13.0+0", "Button 2 pressed: the image was thrown away"), discarded.rows.map { it.title })
        assertEquals("The board said so over Bluetooth.", discarded.rows[1].detail)
        assertEquals(t(30.0), discarded.rows[1].at)
        assertTrue(discarded.outcome == Outcome.DECLINED && discarded.finished)

        val expired = UpdateWatch.timeline(
            told(onLink(5.0), onLink(120.0, window = BoardStatus.Window.CLOSED, left = 0, result = BoardStatus.Result.TIMED_OUT), dropped = 121.0),
        )
        assertEquals(listOf("Sent 1.13.0+0", "The 2 minutes ran out: the image was thrown away"), expired.rows.map { it.title })
        assertTrue(expired.rows[1].state == State.FAILED && expired.rows[1].detail == "The board said so over Bluetooth.")
        assertTrue(expired.outcome == Outcome.EXPIRED && !expired.tentative && expired.finished)
    }

    @Test
    fun `a refusal from the board says why`() {
        val f = told(
            onLink(
                3.0,
                window = BoardStatus.Window.CLOSED,
                image = BoardStatus.Image.REFUSED,
                result = BoardStatus.Result.CLOSED,
                refusal = BoardStatus.Refusal.INCOMPATIBLE_LAYOUT,
            ),
        )
        val timeline = UpdateWatch.timeline(f)
        assertEquals(listOf("Sent 1.13.0+0", "The board did not take the image"), timeline.rows.map { it.title })
        assertEquals("It is for another flash layout.", timeline.rows[1].detail)
        assertTrue(timeline.outcome == Outcome.REFUSED && timeline.finished)
    }

    @Test
    fun `only this send's status counts after the restart`() {
        // Another board's, or another image of the same version: nothing.
        val other = told(onLink(30.0, result = BoardStatus.Result.INSTALLING), afterRestart(140.0, hash = "0000000000000001"), dropped = 31.0)
        assertEquals(listOf(State.DONE, State.DONE, State.CURRENT, State.WAITING, State.WAITING), states(UpdateWatch.timeline(other)))
        val otherVersion = told(
            onLink(30.0, result = BoardStatus.Result.INSTALLING),
            afterRestart(140.0, onTrial = false, outcome = BoardStatus.Outcome.KEPT, target = "1.12.0+0"),
            dropped = 31.0,
        )
        assertNull(UpdateWatch.timeline(otherVersion).outcome)
        // An image the app could not read the hash of: the version alone.
        val noHash = told(
            onLink(30.0, result = BoardStatus.Result.INSTALLING),
            afterRestart(140.0, onTrial = false, outcome = BoardStatus.Outcome.KEPT),
            dropped = 31.0,
        ).copy(sentHash = null)
        assertEquals(Outcome.KEPT, UpdateWatch.timeline(noHash).outcome)
    }

    @Test
    fun `a board with no console is followed over Bluetooth`() {
        // A board with no Wi-Fi, which the console does not know: before 1.14.0 the app could not follow it.
        var f = told(onLink(30.0, result = BoardStatus.Result.INSTALLING), dropped = 31.0, thing = null, onConsole = null)
        val looking = UpdateWatch.timeline(f)
        assertEquals(
            "Looking for the board over Bluetooth: for 2 minutes after its restart, a phone can read how it went with no pairing.",
            looking.note,
        )
        assertFalse(looking.finished)

        f = f.copy(readings = f.readings + afterRestart(140.0))
        assertNull(UpdateWatch.timeline(f).note)

        // A person proved it at the board.
        f = f.copy(readings = f.readings + afterRestart(260.0, onTrial = false, outcome = BoardStatus.Outcome.KEPT, proof = BoardStatus.Proof.PERSON))
        val kept = UpdateWatch.timeline(f)
        assertTrue(kept.outcome == Outcome.KEPT && kept.finished)
        assertEquals("A person at the board proved it.", kept.rows[4].detail)
        assertNull(UpdateWatch.record(f, kept))

        // Not seen again.
        val lost = told(onLink(30.0, result = BoardStatus.Result.INSTALLING), dropped = 31.0, thing = null, onConsole = null).copy(gaveUp = true)
        val gaveUp = UpdateWatch.timeline(lost)
        assertEquals(
            "The board was not seen over Bluetooth again, so the app has stopped looking for it. Its version shows when Button 1 opens its window again.",
            gaveUp.note,
        )
        assertTrue(gaveUp.finished)
    }

    @Test
    fun `how long the board is followed`() {
        assertNull(UpdateWatch.followUntil(facts()))
        assertEquals(t(331.0), UpdateWatch.followUntil(facts(dropped = 31.0)))
        // A status from before the restart, or of another send, does not stretch it.
        assertEquals(t(331.0), UpdateWatch.followUntil(told(onLink(30.0, result = BoardStatus.Result.INSTALLING), dropped = 31.0)))
        assertEquals(t(331.0), UpdateWatch.followUntil(told(afterRestart(140.0, target = "1.12.0+0"), dropped = 31.0)))
        assertEquals(t(800.0), UpdateWatch.followUntil(told(afterRestart(140.0), afterRestart(200.0), dropped = 31.0)))
    }
}
