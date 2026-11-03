package com.craniumiot.cranium.core

import com.craniumiot.cranium.core.StepState.CURRENT
import com.craniumiot.cranium.core.StepState.DONE
import com.craniumiot.cranium.core.StepState.FAILED
import com.craniumiot.cranium.core.StepState.SKIPPED
import com.craniumiot.cranium.core.StepState.STOPPED
import com.craniumiot.cranium.core.StepState.UNKNOWN
import com.craniumiot.cranium.core.StepState.UPCOMING
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** What a board is doing during an update, in the website's words (core.js describeExecution and friends). */
class UpdatesTest {
    private val thing = "cranium-0123456789abcdef"
    private val other = "cranium-00000000000000aa"
    private val id = "cranium-1-1-0-b7-20261010T115900Z-0a0a"
    private val otherId = "cranium-1-1-0-b7-20261010T120500Z-0b0b"
    private val version = "1.1.0+7"
    private val noon = "2026-10-10T12:00:00.000Z"
    private val started = "2026-10-10T12:01:00.000Z"
    private val button = "Button 1"
    private val names = listOf("Offered", "Accepted by the board", "Downloading", "Download checked", "Restarting", "On trial", "Confirmed")

    private fun execution(
        phase: String,
        status: String = "QUEUED",
        progress: Int? = null,
        reason: String? = null,
        ranAtEnd: String? = null,
        reported: String? = null,
        online: Boolean = true,
        startedAt: String? = null,
    ) = Execution(thing, status, phase, progress, reason, null, ranAtEnd, reported, online, noon, startedAt, noon, null)

    private fun board(
        fw: String? = "1.0.0+3",
        confirmed: Boolean = true,
        online: Boolean = true,
        lastSeen: String? = noon,
        ota: Ota? = null,
        name: String? = null,
    ) = Device(thing, online, fw?.let { DeviceFirmware(it, confirmed) }, name, lastSeen, ota)

    private fun ota(state: String, job: String? = id, progress: Int = 0, last: String = "none", error: String = "") =
        Ota(state, job, progress, last, error)

    private fun describe(phase: String, vararg rest: Pair<String, Any?>): ExecutionWords {
        val map = rest.toMap()
        return Updates.describeExecution(
            execution(
                phase,
                progress = map["progress"] as Int?,
                reason = map["reason"] as String?,
                ranAtEnd = map["ranAtEnd"] as String?,
                reported = map["reported"] as String?,
                online = map["online"] as Boolean? ?: true,
                startedAt = map["startedAt"] as String?,
            ),
            version = map["version"] as String?,
        )
    }

    private fun states(words: ExecutionWords) = words.steps.map { it.state }
    private fun labels(words: ExecutionWords) = words.steps.map { it.label }

    // Each phase.

    @Test
    fun `every phase has seven steps, a full sentence and at most one current step`() {
        val phases = listOf(
            "waiting_for_device", "waiting_for_button", "starting", "downloading", "verifying", "rebooting", "testing", "succeeded",
            "rolled_back", "declined", "refused", "failed", "cancelled", "timed_out", "removed", "something_new",
        )
        for (phase in phases) {
            for (online in listOf(true, false)) {
                val words = describe(phase, "online" to online)
                assertEquals(phase, 7, words.steps.size)
                assertTrue(phase, words.text.endsWith("."))
                assertTrue(phase, words.text.startsWith(words.brief))
                assertTrue(phase, words.steps.count { it.state == CURRENT } <= 1)
                assertEquals(phase, phase == "waiting_for_button", words.tone == Tone.ACT)
            }
        }
        assertEquals(names, Updates.STEP_NAMES)
        assertEquals(names, Updates.previewSteps().map { it.label })
        assertTrue(Updates.previewSteps().all { it.state == UPCOMING })
    }

    @Test
    fun `waiting is told apart - never connected, offline, not picked up yet`() {
        val never = Updates.describeExecution(execution("waiting_for_device", online = false), board = board(online = false, lastSeen = null))
        assertEquals("Never connected", never.title)
        assertEquals(Tone.WAIT, never.tone)
        assertTrue(never.text.contains("when it first connects"))
        val seen = Updates.describeExecution(execution("waiting_for_device", online = false), board = board(online = false))
        assertEquals("Board offline", seen.title)
        assertEquals("The board is offline; it will see this update when it reconnects.", seen.text)
        assertEquals("Board offline", describe("waiting_for_device", "online" to false).title)
        val idle = describe("waiting_for_device")
        assertEquals("Not picked up yet", idle.title)
        assertEquals(listOf(CURRENT) + List(6) { UPCOMING }, states(idle))
    }

    @Test
    fun `the board waiting for its button is an instruction, in a tone of its own`() {
        val waiting = describe("waiting_for_button")
        assertEquals(Tone.ACT, waiting.tone)
        assertEquals(Glyph.PRESS, waiting.glyph)
        assertEquals("Press $button on the board", waiting.title)
        assertEquals("The board has the offer and waits for someone to press $button.", waiting.brief)
        assertTrue(waiting.text.endsWith("LED1 blinks quickly while the offer is open; Button 2 declines it."))
        assertEquals(listOf(DONE, CURRENT) + List(5) { UPCOMING }, states(waiting))
        assertEquals("Waiting for $button", labels(waiting)[1])
    }

    @Test
    fun `the installing phases move along the steps, with the download in percent`() {
        val downloading = describe("downloading", "progress" to 42, "version" to version)
        assertEquals("Downloading 42%", downloading.title)
        assertEquals("Downloading", downloading.said)
        assertEquals(42, downloading.progress)
        assertEquals(Tone.LIVE, downloading.tone)
        assertEquals(listOf(DONE, DONE, CURRENT) + List(4) { UPCOMING }, states(downloading))
        assertEquals("Downloading", describe("downloading").title)
        assertNull(describe("downloading").progress)

        val starting = describe("starting")
        assertEquals("Starting", starting.title)
        assertEquals("Accepted by the board", labels(starting)[1])
        assertEquals(2, states(starting).indexOf(CURRENT))
        assertEquals("Checking the download", labels(describe("verifying"))[3])
        assertEquals(3, states(describe("verifying")).indexOf(CURRENT))
        assertEquals(4, states(describe("rebooting")).indexOf(CURRENT))
        assertEquals("Download checked", labels(describe("rebooting"))[3])
        val testing = describe("testing")
        assertEquals(5, states(testing).indexOf(CURRENT))
        assertEquals(
            "The new firmware is running on trial. It is kept once the board has reconnected to AWS IoT; if it cannot, the " +
                "bootloader puts the previous firmware back.",
            testing.text,
        )
    }

    @Test
    fun `a board that went quiet during an update is told as where it was last seen`() {
        val quiet = describe("downloading", "online" to false, "progress" to 40, "version" to version)
        assertEquals("Was downloading $version when last seen", quiet.title)
        assertEquals(Tone.IDLE, quiet.tone)
        assertNull(quiet.progress)
        assertEquals(
            "The board went offline with the download at 40%. The update stays open until the board reports back or the time limit ends.",
            quiet.text,
        )
        assertEquals(listOf(DONE, DONE, STOPPED) + List(4) { UNKNOWN }, states(quiet))
        assertEquals("last seen here", quiet.steps[2].word)
        assertEquals("Was downloading an update when last seen", describe("downloading", "online" to false).title)
        assertEquals("Was starting $version when last seen", describe("starting", "online" to false, "version" to version).title)
        assertEquals(
            "Was checking the download of $version when last seen",
            describe("verifying", "online" to false, "version" to version).title,
        )
        assertEquals("Was restarting into $version when last seen", describe("rebooting", "online" to false, "version" to version).title)
        assertEquals("Was on trial with $version when last seen", describe("testing", "online" to false, "version" to version).title)
        assertTrue(describe("testing", "online" to false).text.startsWith("The board went offline with the new firmware on trial."))
    }

    @Test
    fun `an update that went through is told in the past, and what the board runs now beside it`() {
        val done = describe("succeeded", "ranAtEnd" to version)
        assertEquals(Tone.GOOD, done.tone)
        assertEquals("Installed and confirmed", done.title)
        assertEquals("The board confirmed $version when this update ended.", done.text)
        assertEquals(List(7) { DONE }, states(done))
        assertEquals(names, labels(done))
        assertEquals("The board confirmed the new firmware.", describe("succeeded").text)

        val holds = Updates.describeExecution(execution("succeeded", ranAtEnd = version), board = board(fw = version))
        assertEquals("The board runs $version and has confirmed it.", holds.text)
        val moved = Updates.describeExecution(execution("succeeded", ranAtEnd = version), board = board(fw = "2.0.0+0"))
        assertEquals("The board confirmed $version when this update ended. It has since moved to 2.0.0+0.", moved.text)
        val movedQuiet = Updates.describeExecution(execution("succeeded", ranAtEnd = version), board = board(fw = "2.0.0+0", online = false))
        assertTrue(movedQuiet.text.endsWith(" When last seen, it had moved to 2.0.0+0."))
    }

    @Test
    fun `a rollback says what the bootloader did, and what to do about it`() {
        val rolled = describe("rolled_back", "reason" to "rolled_back", "ranAtEnd" to "1.0.0+3", "version" to version)
        assertEquals(Tone.BAD, rolled.tone)
        assertEquals(Glyph.UNDO, rolled.glyph)
        assertTrue(rolled.text.startsWith("The bootloader put the previous firmware back."))
        assertTrue(rolled.text.endsWith("That left the board on 1.0.0+3."))
        assertEquals(List(5) { DONE } + listOf(FAILED, SKIPPED), states(rolled))
        assertEquals("Rolled back", labels(rolled)[5])
        assertEquals("Fix the build, then upload a newer version and deploy that.", rolled.next)
        assertFalse(rolled.retry)
        // A board that runs this version or a newer one already: old news.
        val later = Updates.describeExecution(
            execution("rolled_back", ranAtEnd = "1.0.0+3"), board = board(fw = "2.0.0+0"), version = version,
        )
        assertNull(later.next)
    }

    @Test
    fun `declined and refused are told apart where the board says which`() {
        val declined = describe("declined", "reason" to "declined", "ranAtEnd" to "1.0.0+3")
        assertEquals("Declined on the board", declined.title)
        assertEquals(Tone.WARN, declined.tone)
        assertEquals(
            "Someone pressed Button 2 on the board to decline this update. Nothing was installed. The board was running 1.0.0+3 at the time.",
            declined.text,
        )
        assertEquals("Not accepted", labels(declined)[1])
        assertEquals("To try again, start a new deployment.", declined.next)
        assertTrue(declined.retry)

        val notNewer = describe("refused", "reason" to "not_newer")
        assertEquals("Refused by the board", notNewer.title)
        assertEquals("Refused: the board already ran this version or a newer one.", notNewer.text)
        assertNull(notNewer.code)
        assertEquals("To put something else on it, upload a newer version and deploy that.", notNewer.next)
        assertFalse(notNewer.retry)
        assertEquals(listOf(DONE, FAILED) + List(5) { SKIPPED }, states(notNewer))
        assertEquals("Refused", labels(notNewer)[1])
        for (reason in listOf("too_large", "bad_document", "unsupported", "url_not_allowed")) {
            assertTrue(reason, describe("refused", "reason" to reason).text.startsWith("Refused: "))
        }

        val unknown = describe("refused", "reason" to "something_new")
        assertEquals("The board refused this update before installing anything.", unknown.text)
        assertEquals("something_new", unknown.code)
        assertEquals("Deal with that first, then start a new deployment.", unknown.next)

        val bare = describe("refused")
        assertEquals("Refused or declined", bare.title)
        assertEquals("This update was turned down on the board before anything was installed.", bare.text)
        assertTrue(bare.retry)
    }

    @Test
    fun `a failure says at which step, and that the board kept its firmware`() {
        val damaged = describe("failed", "reason" to "digest_mismatch", "ranAtEnd" to "1.0.0+3")
        assertEquals("The download was damaged", damaged.title)
        assertEquals(Tone.BAD, damaged.tone)
        assertEquals(List(3) { DONE } + listOf(FAILED, SKIPPED, SKIPPED, SKIPPED), states(damaged))
        assertEquals("Check failed", labels(damaged)[3])
        assertTrue(damaged.text.endsWith(" It kept running the firmware it had, 1.0.0+3."))
        assertTrue(damaged.retry)
        assertEquals("Download failed", labels(describe("failed", "reason" to "download_failed"))[2])
        assertEquals("Did not start", labels(describe("failed", "reason" to "not_installed"))[4])
        assertEquals("Check failed", labels(describe("failed", "reason" to "header_mismatch"))[3])

        val flash = describe("failed", "reason" to "flash_error")
        assertEquals("The board could not store the update", flash.title)
        assertEquals(listOf(DONE, DONE, STOPPED) + List(4) { SKIPPED }, states(flash))

        val trial = describe("failed", "reason" to "trial_lost", "ranAtEnd" to "1.0.0+3")
        assertFalse("it did not keep the firmware it had", trial.text.contains("kept running"))

        val unknown = describe("failed", "reason" to "something_new")
        assertEquals("Failed", unknown.title)
        assertEquals("The board reported that the update failed. It kept running the firmware it had.", unknown.text)
        assertEquals("something_new", unknown.code)
        assertEquals(listOf(DONE, DONE, STOPPED) + List(4) { SKIPPED }, states(unknown))

        val stopped = describe("failed", "reason" to "not_newer")
        assertTrue(stopped.text.startsWith("The board stopped: the board already ran this version or a newer one."))
        assertNull(stopped.code)

        val silent = describe("failed")
        assertEquals(listOf(DONE, DONE) + List(5) { UNKNOWN }, states(silent))
        assertNull(silent.code)
    }

    @Test
    fun `a timeout, a removal and a phase the console does not know`() {
        val timedOut = describe("timed_out", "reported" to "1.0.0+3")
        assertEquals(Tone.BAD, timedOut.tone)
        assertEquals(
            "The board started but did not report a result before the time limit. The board reports that it runs 1.0.0+3.",
            timedOut.text,
        )
        assertEquals("Check that the board is powered and online, then start a new deployment.", timedOut.next)
        val quiet = describe("timed_out", "reported" to "1.0.0+3", "online" to false)
        assertTrue(quiet.text.endsWith("When last seen, the board reported 1.0.0+3."))

        val removed = describe("removed")
        assertEquals("Removed", removed.title)
        assertEquals(List(7) { SKIPPED }, states(removed))

        val unknown = describe("something_new")
        assertEquals("Unknown state", unknown.title)
        assertEquals("something_new", unknown.code)
        assertNull(describe("").code)
    }

    // A cancelled update: what became of the board.

    private fun cancelled(
        reported: String?,
        board: Device?,
        history: List<ExecutionSummary>? = null,
        started: Boolean = true,
        online: Boolean = true,
        historyCut: Boolean = false,
        unread: Boolean = false,
    ) = Updates.describeExecution(
        execution("cancelled", status = "CANCELED", reported = reported, online = online, startedAt = if (started) this.started else null),
        board = board, deployment = id, version = version, history = history, historyCut = historyCut, unread = unread,
    )

    private fun entry(deployment: String, status: String, version: String? = this.version) =
        ExecutionSummary(deployment, version, status, noon, null, noon)

    @Test
    fun `cancelled before the board started, nothing was installed and it can be offered again`() {
        val early = Updates.describeExecution(execution("cancelled", status = "CANCELED"))
        assertEquals("Cancelled before the board started. Nothing was installed.", early.text)
        assertEquals(listOf(DONE) + List(6) { SKIPPED }, states(early))
        assertTrue(early.retry)

        for (reported in listOf(version, "2.0.0+0")) {
            val later = cancelled(reported, board(fw = reported), started = false)
            assertEquals(
                "Cancelled before the board started, so this deployment installed nothing. The board reports that it runs $reported.",
                later.text,
            )
            assertFalse(later.retry)
            assertNull(later.next)
        }
    }

    @Test
    fun `cancelled after it started - it stops where it was, with the steps before it done`() {
        val late = Updates.describeExecution(execution("cancelled", status = "CANCELED", reported = "1.0.0+3", startedAt = started))
        assertEquals(
            "Cancelled after the board had started. A board asks AWS before it installs, so it stops there and keeps the firmware " +
                "it had. The board reports that it runs 1.0.0+3.",
            late.text,
        )
        assertEquals(listOf(DONE, DONE, STOPPED) + List(4) { SKIPPED }, states(late))
        assertEquals(Tone.IDLE, late.tone)

        val verifying = cancelled("1.0.0+3", board(ota = ota("verifying")))
        assertEquals(listOf(DONE, DONE, DONE, STOPPED, SKIPPED, SKIPPED, SKIPPED), states(verifying))
        assertEquals("Checking the download", labels(verifying)[3])
        assertTrue(verifying.retry)
    }

    @Test
    fun `a board too far along to be stopped is not said to have stopped`() {
        for ((state, step) in listOf("rebooting" to 4, "testing" to 5)) {
            val finishing = cancelled("1.0.0+3", board(ota = ota(state)))
            assertEquals("Finishing despite the cancellation", finishing.title)
            assertEquals(Tone.LIVE, finishing.tone)
            assertEquals(step, states(finishing).indexOf(CURRENT))
            assertFalse(finishing.retry)
        }
        assertEquals("Cancelled", cancelled("1.0.0+3", board(ota = ota("rebooting", job = otherId))).title)
        val quiet = cancelled("1.0.0+3", board(online = false, ota = ota("rebooting")), online = false)
        assertEquals("Was restarting into $version when last seen", quiet.title)
        assertEquals(Tone.IDLE, quiet.tone)
        assertEquals("last seen here", quiet.steps[4].word)
    }

    @Test
    fun `installed despite the cancellation, on the board's own word and a whole list`() {
        val installed = cancelled(version, board(fw = version, ota = ota("idle", job = null, last = "succeeded")), history = emptyList())
        assertEquals("Installed despite the cancellation", installed.title)
        assertEquals(Tone.WARN, installed.tone)
        assertEquals(List(7) { DONE }, states(installed))
        assertTrue(installed.text.endsWith("It now runs $version."))
        assertEquals("To replace it, upload a newer version and deploy that.", installed.next)
        assertTrue(installed.installed)

        val quiet = cancelled(version, board(fw = version, online = false, ota = ota("idle", job = null, last = "succeeded")), history = emptyList(), online = false)
        assertTrue(quiet.text.endsWith("had gone too far to be stopped. When last seen, it ran $version."))

        // Not confirmed: the board has not said that its update went through.
        val onTrial = cancelled(version, board(fw = version, confirmed = false, ota = ota("idle", job = null, last = "succeeded")), history = emptyList())
        assertTrue(onTrial.unsure)
        assertFalse(onTrial.installed)
        // Another version on it: its last update is not this one.
        val otherVersion = cancelled("1.0.0+3", board(ota = ota("idle", job = null, last = "succeeded")), history = emptyList())
        assertEquals("Cancelled", otherVersion.title)
        assertFalse(otherVersion.installed)
    }

    @Test
    fun `a version that another deployment put on the board is not put down to this one`() {
        val known = board(fw = version, ota = ota("idle", job = null, last = "succeeded"))
        val later = cancelled(version, known, history = listOf(entry(id, "CANCELED"), entry(otherId, "SUCCEEDED")))
        assertEquals("Cancelled", later.title)
        assertEquals(otherId, later.installedBy)
        assertFalse(later.installed)
        assertTrue(later.text.endsWith("and it stopped there. Another deployment installed $version."))
        assertEquals(listOf(DONE, DONE, STOPPED) + List(4) { SKIPPED }, states(later))
        assertFalse(later.retry)
        assertEquals(otherId, cancelled(version, known, history = listOf(entry(otherId, "IN_PROGRESS"))).installedBy)
        assertEquals(otherId, cancelled(version, known, history = listOf(entry(otherId, "SUCCEEDED", version = null))).installedBy)
        // A job of another tool, whose version cannot be known, may have put it there.
        val outside = cancelled(version, known, history = listOf(entry(id, "CANCELED"), entry("made-elsewhere", "SUCCEEDED", version = null)))
        assertTrue(outside.unsure)
        val failedOutside = cancelled(version, known, history = listOf(entry("made-elsewhere", "FAILED", version = null)))
        assertTrue("a job that failed installed nothing", failedOutside.installed)
    }

    @Test
    fun `how a cancelled update ended is not claimed where it cannot be known`() {
        val known = board(fw = version, ota = ota("idle", job = null, last = "succeeded"))
        val unread = cancelled(version, known, history = null)
        assertTrue(unread.unsure)
        assertEquals("Cancelled after the board had started. The board now runs $version; how it got there is not on record.", unread.text)
        assertFalse(unread.retry)
        assertTrue(cancelled(version, known, history = listOf(entry(id, "CANCELED")), historyCut = true).unsure)
        val quiet = cancelled(version, board(fw = version, online = false), history = null, online = false)
        assertEquals(
            "Cancelled after the board had started. When last seen, the board ran $version; how it got there is not on record.",
            quiet.text,
        )

        val movedOn = cancelled("2.0.0+0", board(fw = "2.0.0+0"), history = emptyList())
        assertEquals(
            "Cancelled after the board had started. The board reports that it runs 2.0.0+0. This page cannot tell how this update ended.",
            movedOn.text,
        )
        assertTrue(movedOn.unsure)
        assertFalse(movedOn.retry)
        assertEquals(listOf(DONE, DONE) + List(5) { UNKNOWN }, states(movedOn))

        val listUnread = cancelled("1.0.0+3", null, unread = true)
        assertEquals("Cancelled after the board had started. What the board did next is still being read.", listUnread.text)
        assertTrue(listUnread.unsure)
        assertFalse(listUnread.retry)
        val read = cancelled("1.0.0+3", board())
        assertTrue(read.text.contains("it stops there and keeps the firmware it had"))
        assertTrue(read.retry)
    }

    // A board's own report, and its history.

    @Test
    fun `an execution status alone, and a board's history in its own words`() {
        assertEquals(StateWords(Tone.WAIT, Glyph.CLOCK, "Waiting"), Updates.describeStatus("QUEUED"))
        assertEquals("Updating", Updates.describeStatus("IN_PROGRESS").label)
        assertEquals("Installed", Updates.describeStatus("SUCCEEDED").label)
        assertEquals("Timed out", Updates.describeStatus("TIMED_OUT").label)
        assertEquals("Refused or declined", Updates.describeStatus("REJECTED").label)
        assertEquals("Cancelled", Updates.describeStatus("CANCELED").label)
        assertEquals("Unknown", Updates.describeStatus("NEW_STATUS").label)
        assertEquals("Rolled back", Updates.describeHistory("FAILED", "rolled_back").label)
        assertEquals("Declined on the board", Updates.describeHistory("REJECTED", "declined").label)
        assertEquals("Refused by the board", Updates.describeHistory("REJECTED", "refused").label)
        assertEquals("Failed", Updates.describeHistory("FAILED", "declined").label)
        assertEquals("Failed", Updates.describeHistory("FAILED").label)
    }

    @Test
    fun `what a board last reported about updates is put into words`() {
        fun update(ota: Ota?, online: Boolean = true) = Updates.describeUpdate(Device(thing, online, ota = ota))
        assertEquals("Nothing reported", update(null).label)
        assertTrue(update(null).quiet)
        val idle = update(ota("idle", job = null))
        assertEquals("No update in progress", idle.label)
        assertTrue(idle.quiet)
        assertEquals("No update in progress when last seen", update(ota("idle", job = null), online = false).label)
        assertEquals(Tone.GOOD, update(ota("idle", job = null, last = "succeeded")).tone)
        assertEquals(Tone.BAD, update(ota("idle", job = null, last = "rolled_back", error = "not confirmed")).tone)
        assertEquals("The download failed", update(ota("idle", job = null, last = "failed", error = "download_failed")).text)
        assertEquals(
            "Because the board already ran this version or a newer one.",
            update(ota("idle", job = null, last = "refused", error = "not_newer")).text,
        )
        assertEquals("", update(ota("idle", job = null, last = "succeeded", error = "download_failed")).text)
        assertEquals("No update in progress", update(ota("idle", job = null, last = "a new word")).label)

        val downloading = update(ota("downloading", progress = 40))
        assertEquals("Downloading $version", downloading.label)
        assertEquals(40, downloading.progress)
        assertEquals(id, downloading.deployment)
        assertEquals("Downloading an update", update(ota("downloading", job = null)).label)

        val waiting = update(ota("awaiting_user"))
        assertEquals("Press $button on the board", waiting.label)
        assertEquals(Tone.ACT, waiting.tone)
        assertTrue(waiting.text.startsWith("$version is on offer. Button 1 on the board installs it"))

        val stale = update(ota("downloading", progress = 40), online = false)
        assertEquals("Was downloading $version when last seen", stale.label)
        assertNull(stale.progress)
        assertEquals(Tone.IDLE, stale.tone)
        val gone = update(ota("awaiting_user"), online = false)
        assertEquals("Was waiting for $button when last seen", gone.label)
        assertEquals("", gone.text)
        assertEquals("Was checking the download of $version when last seen", update(ota("verifying"), online = false).label)
        assertEquals("Was restarting into $version when last seen", update(ota("rebooting"), online = false).label)
        assertEquals("Was on trial with $version when last seen", update(ota("testing"), online = false).label)
        assertEquals("Was updating when last seen", update(ota("a_new_state"), online = false).label)
        assertEquals(Tone.LIVE, update(ota("a_new_state")).tone)

        val bluetooth = update(ota("bluetooth", job = null))
        assertEquals("Open for an update over Bluetooth", bluetooth.label)
        assertEquals(Tone.LIVE, bluetooth.tone)
        assertTrue(bluetooth.text.contains("Updates from here wait until it closes"))
        assertEquals("Was open for an update over Bluetooth when last seen", update(ota("bluetooth"), online = false).label)
    }

    // A deployment as a whole.

    private fun summary(status: String, counts: Counts, things: List<String> = listOf(thing, other), version: String? = null) =
        DeploymentSummary(id, version, status, noon, null, null, "", things, counts)

    @Test
    fun `a deployment as a whole is summed up from its boards`() {
        fun label(status: String, counts: Counts) = Updates.describeDeployment(summary(status, counts)).label
        assertEquals("Updating", label("IN_PROGRESS", Counts(inProgress = 1, queued = 1)))
        assertEquals("Waiting for boards", label("IN_PROGRESS", Counts(queued = 2)))
        assertEquals("Succeeded", label("COMPLETED", Counts(succeeded = 2)))
        assertEquals("Partly succeeded", label("COMPLETED", Counts(succeeded = 1, failed = 1)))
        assertEquals("Failed", label("COMPLETED", Counts(failed = 1, timedOut = 1)))
        assertEquals("Not installed", label("COMPLETED", Counts(rejected = 2)))
        assertEquals("Cancelled", label("CANCELED", Counts(canceled = 2)))
        assertEquals("Cancelled, 1 board still working", label("CANCELED", Counts(inProgress = 1, canceled = 1)))
        assertEquals("Cancelled, 2 boards finished", label("CANCELED", Counts(succeeded = 2)))
        assertEquals("Scheduled", label("SCHEDULED", Counts()))
        assertEquals("Being deleted", label("DELETION_IN_PROGRESS", Counts()))
        assertEquals("Unknown", label("SOMETHING_NEW", Counts()))

        fun said(status: String, counts: Counts) = Updates.describeDeployment(summary(status, counts)).said
        assertEquals("The last deployment failed.", said("COMPLETED", Counts(failed = 2)))
        assertEquals("The last deployment partly succeeded.", said("COMPLETED", Counts(succeeded = 1, failed = 1)))
        assertEquals("The last deployment was cancelled, but 1 board finished it.", said("CANCELED", Counts(succeeded = 1)))
        assertEquals("The update was installed and confirmed on 2 boards.", said("COMPLETED", Counts(succeeded = 2)))
        assertNull(said("CANCELED", Counts(canceled = 2)))
    }

    @Test
    fun `a deployment that went through is told as current only while its boards say so`() {
        val through = summary("COMPLETED", Counts(succeeded = 1), things = listOf(thing), version = version)
        assertEquals("$version was installed and confirmed.", Updates.describeDeployment(through).said)
        assertEquals("$version is installed and confirmed.", Updates.describeDeployment(through, listOf(board(fw = version))).said)
        assertEquals(
            "$version was installed and confirmed.",
            Updates.describeDeployment(through, listOf(board(fw = version, online = false))).said,
        )
        assertEquals("$version was installed and confirmed.", Updates.describeDeployment(through, listOf(board(fw = "2.0.0+0"))).said)

        assertEquals(Updates.Standing.CURRENT, Updates.installStanding(through, listOf(board(fw = version))).state)
        assertEquals(Updates.Standing.UNHEARD, Updates.installStanding(through, listOf(board(fw = version, online = false))).state)
        assertEquals(Updates.Standing.UNHEARD, Updates.installStanding(through, emptyList()).state)
        val moved = Updates.installStanding(through, listOf(board(fw = "2.0.0+0")))
        assertEquals(Updates.Standing.MOVED, moved.state)
        assertEquals(listOf(thing), moved.moved.map { it.thing })
    }

    @Test
    fun `the counts of a deployment's boards, with those that wait for a person told apart`() {
        fun words(counts: Counts, atButton: Int = 0) = Updates.describeCounts(counts, atButton).map { "${it.count} ${it.label}" }
        assertEquals(listOf("1 updating", "2 waiting", "1 failed"), words(Counts(queued = 2, inProgress = 1, failed = 1)))
        assertEquals(listOf("1 waiting for $button", "2 waiting"), words(Counts(queued = 3), 1))
        assertEquals(listOf("1 waiting for $button"), words(Counts(queued = 1), 1))
        assertEquals(listOf("1 waiting for $button"), words(Counts(queued = 1), 5))
        assertEquals(Tone.ACT, Updates.describeCounts(Counts(queued = 1), 1)[0].tone)
        assertEquals(
            listOf("succeeded", "inProgress", "queued", "failed", "timedOut", "rejected", "canceled", "removed"),
            Updates.describeCounts(Counts(1, 1, 1, 1, 1, 1, 1, 1)).map { it.name },
        )
        assertEquals("1 updating, 2 waiting, 1 failed", Updates.countWords(Counts(queued = 2, inProgress = 1, failed = 1)))
        assertEquals("", Updates.countWords(Counts()))
    }

    // How often to ask again.

    @Test
    fun `a deployment is watched closely while a board moves, and not at all once nothing does`() {
        assertEquals(3_000L, Updates.pollInterval(listOf("QUEUED", "IN_PROGRESS")))
        assertEquals(10_000L, Updates.pollInterval(listOf("QUEUED", "SUCCEEDED", null)))
        assertEquals(0L, Updates.pollInterval(listOf("SUCCEEDED", null)))
        assertEquals(0L, Updates.pollInterval(emptyList()))

        assertEquals("IN_PROGRESS", Updates.executionActivity(execution("waiting_for_device", status = "QUEUED", online = true)))
        assertEquals("QUEUED", Updates.executionActivity(execution("waiting_for_device", status = "QUEUED", online = false)))
        assertEquals("SUCCEEDED", Updates.executionActivity(execution("succeeded", status = "SUCCEEDED")))

        assertEquals("IN_PROGRESS", Updates.summaryActivity(summary("IN_PROGRESS", Counts(inProgress = 1)), emptyList()))
        assertNull(Updates.summaryActivity(summary("COMPLETED", Counts(succeeded = 2)), emptyList()))
        assertEquals("IN_PROGRESS", Updates.summaryActivity(summary("IN_PROGRESS", Counts(queued = 1)), listOf(board())))
        assertEquals("QUEUED", Updates.summaryActivity(summary("IN_PROGRESS", Counts(queued = 1)), listOf(board(online = false))))

        assertNull(Updates.deviceActivity(board(online = false, ota = ota("downloading"))))
        assertNull(Updates.deviceActivity(board(ota = ota("idle"))))
        assertNull(Updates.deviceActivity(board()))
        assertEquals("IN_PROGRESS", Updates.deviceActivity(board(ota = ota("downloading"))))
    }

    @Test
    fun `a deployment is under way while a board waits or works, cancelled or not`() {
        assertTrue(Updates.isUnderWay(summary("IN_PROGRESS", Counts())))
        assertTrue(Updates.isUnderWay(summary("CANCELED", Counts(inProgress = 1))))
        assertFalse(Updates.isUnderWay(summary("CANCELED", Counts(canceled = 2))))
        assertTrue(Updates.isUnfinished("QUEUED"))
        assertTrue(Updates.isUnfinished("IN_PROGRESS"))
        assertFalse(Updates.isUnfinished("SUCCEEDED"))
        assertTrue(Updates.isRestarting(board(ota = ota("rebooting"))))
        assertFalse(Updates.isRestarting(board(online = false, ota = ota("rebooting"))))
        assertFalse(Updates.isUp(board(ota = ota("rebooting"))))
        assertTrue(Updates.isUp(board()))

        val nowMs = Times.parse(noon)!! + 60_000
        val stopped = summary("CANCELED", Counts(canceled = 1), things = listOf(thing))
        assertTrue(Updates.stillFinishing(stopped, listOf(board(ota = ota("testing"))), nowMs))
        assertFalse(Updates.stillFinishing(stopped, listOf(board(ota = ota("verifying"))), nowMs))
        assertFalse(Updates.stillFinishing(stopped, listOf(board(ota = ota("testing", job = otherId))), nowMs))
        assertTrue("a moment after it went quiet", Updates.stillFinishing(stopped, listOf(board(online = false, ota = ota("rebooting"))), nowMs))
        assertFalse(Updates.stillFinishing(stopped, listOf(board(online = false, ota = ota("rebooting"))), nowMs + 10 * 60_000))
        assertFalse(Updates.stillFinishing(summary("IN_PROGRESS", Counts()), listOf(board(ota = ota("testing"))), nowMs))

        val cancelledLate = execution("cancelled", status = "CANCELED", startedAt = started)
        assertTrue(Updates.stillSettling(cancelledLate, board(ota = ota("rebooting")), id, nowMs))
        assertFalse(Updates.stillSettling(cancelledLate, board(ota = ota("idle")), id, nowMs))
        assertFalse(Updates.stillSettling(cancelledLate, board(ota = ota("rebooting")), id, nowMs + 10 * 60_000))
        assertFalse(Updates.stillSettling(execution("cancelled", status = "CANCELED"), board(ota = ota("rebooting")), id, nowMs))
    }

    // Cancelling and revoking.

    @Test
    fun `what is said once a deployment has been cancelled`() {
        assertEquals("Stop requested. Boards that had started have been asked to stop.", Updates.cancelNotice(force = true, withdrawn = true, started = 1))
        assertEquals("Cancelled. Boards that had started have been asked to stop.", Updates.cancelNotice(force = true, withdrawn = false, started = 2))
        assertEquals(
            "Cancelled. Boards that had not started are no longer offered this update.",
            Updates.cancelNotice(force = true, withdrawn = false, started = 0),
        )
        assertEquals("Cancelled. 1 board that had started carries on.", Updates.cancelNotice(force = false, withdrawn = false, started = 1))
        assertEquals("Cancelled. 2 boards that had started carry on.", Updates.cancelNotice(force = false, withdrawn = false, started = 2))
        assertEquals(
            "Cancelled. Boards that had not started are no longer offered this update.",
            Updates.cancelNotice(force = false, withdrawn = false, started = 0),
        )
    }

    private fun release(status: String, revoked: Revocation? = null) = Release(version, 10, "aa", status, revoked = revoked)

    @Test
    fun `where a revocation stands`() {
        assertNull(Updates.revocationState(release("active")))
        assertEquals(
            Updates.RevocationState.COMPLETE,
            Updates.revocationState(release("revoked", Revocation(enforcedAt = "2026-11-01T00:00:00.000Z"))),
        )
        assertEquals(Updates.RevocationState.INCOMPLETE, Updates.revocationState(release("revoked", Revocation())))
        assertEquals(
            Updates.RevocationState.UNKNOWN,
            Updates.revocationState(release("revoked", Revocation(recordsEnforcement = false))),
        )
        assertEquals(Updates.RevocationState.UNKNOWN, Updates.revocationState(release("revoked")))
    }

    @Test
    fun `what is said once a release is revoked, and about the boards that still run it`() {
        val named = board(fw = version, name = "CRVIHAAN01")
        assertEquals(
            "CRVIHAAN01 still runs it; to replace it there, upload a newer version and deploy that.",
            Updates.stillRunning(listOf(named)),
        )
        assertEquals(
            "$thing last reported running it; to replace it there, upload a newer version and deploy that.",
            Updates.stillRunning(listOf(board(fw = version, online = false))),
        )
        val three = listOf(board(fw = version), board(fw = version).copy(thing = other), board(fw = version, online = false).copy(thing = "cranium-00000000000000bb"))
        assertEquals(
            "2 boards still run it and 1 board last reported running it; to replace it there, upload a newer version and deploy that.",
            Updates.stillRunning(three),
        )

        assertEquals("$version was revoked already, and that revocation is in place.", Updates.revocationNotice(version, null, again = false))
        assertEquals(
            "The revocation of $version is in place: its image is refused and no deployment of it is open.",
            Updates.revocationNotice(version, null, again = true),
        )
        assertEquals("Revoked $version. No deployment of it was still open.", Updates.revocationNotice(version, emptyList(), again = false))
        assertEquals("Revoked $version. 2 unfinished deployments were cancelled.", Updates.revocationNotice(version, listOf(id, otherId), again = false))
        assertEquals(
            "The revocation of $version is in place. 1 unfinished deployment was cancelled.",
            Updates.revocationNotice(version, listOf(id), again = true),
        )
        assertEquals(
            "Revoked $version. No deployment of it was still open. CRVIHAAN01 still runs it; to replace it there, upload a newer version and deploy that.",
            Updates.revocationNotice(version, emptyList(), again = false, running = listOf(named)),
        )
    }

    // Choosing boards for a deployment.

    @Test
    fun `the version a deployment installs is in its id`() {
        assertEquals(version, Updates.versionOfDeployment(id))
        assertEquals("1.11.4+0", Updates.versionOfDeployment("cranium-1-11-4-b0-20261102T110000Z-0a0a"))
        assertNull("out of range", Updates.versionOfDeployment("cranium-999-0-0-b1-20261010T221500Z-ffff"))
        assertNull(Updates.versionOfDeployment("made-elsewhere"))
        assertNull(Updates.versionOfDeployment(null))
    }

    @Test
    fun `a board that runs the release or a newer one will refuse it, and old firmware waits for the button`() {
        assertTrue(Updates.alreadyRuns(board(fw = version), version))
        assertTrue(Updates.alreadyRuns(board(fw = "2.0.0+0"), version))
        assertFalse(Updates.alreadyRuns(board(fw = "1.0.0+3"), version))
        assertFalse(Updates.alreadyRuns(board(fw = null), version))
        assertFalse(Updates.alreadyRuns(board(fw = version), null))
        assertTrue(Updates.asksForButton(board(fw = "1.7.1+9")))
        assertFalse(Updates.asksForButton(board(fw = "1.7.2+0")))
        assertFalse(Updates.asksForButton(board(fw = null)))
        assertEquals("1.7.2", Updates.FIRST_WITH_NO_BUTTON)
    }

    @Test
    fun `firmware that is not a registered release, and the board to tick without being asked`() {
        val releases = listOf(release("active"))
        assertTrue(Updates.isUnregistered("1.0.0+3", releases))
        assertFalse(Updates.isUnregistered(version, releases))
        assertFalse(Updates.isUnregistered("1.0.0+3", emptyList()))
        assertFalse(Updates.isUnregistered("1.0.0+3", null))
        assertFalse(Updates.isUnregistered(null, releases))

        val one = board()
        val two = board().copy(thing = other)
        assertEquals(thing, Updates.onlyChoice(listOf(one), emptySet(), version))
        assertNull(Updates.onlyChoice(listOf(one, two), emptySet(), version))
        assertEquals(other, Updates.onlyChoice(listOf(one, two), setOf(thing), version))
        assertNull("it would refuse it", Updates.onlyChoice(listOf(board(fw = version)), emptySet(), version))
    }
}
