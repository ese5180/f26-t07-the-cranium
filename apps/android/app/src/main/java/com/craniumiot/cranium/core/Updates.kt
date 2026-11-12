package com.craniumiot.cranium.core

/**
 * The tones of the console: act (an update waits for a person), wait, live, good, warn, bad and
 * idle. A state is never told by colour alone: every description also has an icon and words.
 */
enum class Tone { ACT, WAIT, LIVE, GOOD, WARN, BAD, IDLE }

/** The console's icons (views.js ICONS), and the few the app adds for its own navigation. */
enum class Glyph {
    CHECK, CHECK_CIRCLE, X, X_CIRCLE, CLOCK, ALERT, BAN, MINUS_CIRCLE, MINUS, UNDO, DOWNLOAD, UPLOAD, RESTART, SHIELD,
    PULSE, PRESS, STOP, HOURGLASS, OFFLINE, ONLINE, CHIP, PACKAGE, SEND, LIST, USER, COPY, ARROW_RIGHT, ARROW_LEFT, KEY,
    LOCK, PLUS, SWAP, FILE, SIGN_OUT,
    // The app's own: the sections of its navigation, Bluetooth and the USB cable.
    HOME, MORE, BLUETOOTH, USB, TERMINAL, HISTORY, SEARCH, HELP, MORE_VERT, FINGERPRINT,
    // The website's, for the fleet's entries of the activity log: a command to a board, an e-mail alert.
    LOCATE, BELL,
    // The customer site's: its overview, the mixes, and a link that opens another app.
    GRID, DISC, EXTERNAL,
}

/** One step of an update, as the step list draws it. */
enum class StepState { DONE, CURRENT, FAILED, STOPPED, SKIPPED, UPCOMING, UNKNOWN }

data class Step(val label: String, val state: StepState, val word: String? = null)

/**
 * What a board is doing in a deployment, in words (core.js describeExecution). `brief` is the
 * first sentence of `text`; `progress` the download in percent while the board reports it; `code`
 * the board's own reason when the console has no words for it; `next` what to do about an update
 * that ended short; `retry` that offering the same release again makes sense.
 */
data class ExecutionWords(
    val tone: Tone,
    val glyph: Glyph,
    val title: String,
    val text: String,
    val steps: List<Step>,
    val progress: Int? = null,
    val said: String? = null,
    val code: String? = null,
    val next: String? = null,
    val retry: Boolean = false,
    val installed: Boolean = false,
    val installedBy: String? = null,
    val unsure: Boolean = false,
) {
    val brief: String get() = text.indexOf(". ").let { if (it == -1) text else text.substring(0, it + 1) }
}

/** A short state: a tone, an icon and a label (and for a board's update, more). */
data class StateWords(
    val tone: Tone,
    val glyph: Glyph,
    val label: String,
    val text: String = "",
    val progress: Int? = null,
    val deployment: String? = null,
    val quiet: Boolean = false,
    val said: String? = null,
)

/** One count of a deployment's boards, with its words. */
data class CountWords(val name: String, val count: Int, val label: String, val tone: Tone, val glyph: Glyph)

object Updates {
    // In a heading and in the name of a step, "Button 1" is held together by a no-break space.
    private const val BUTTON_1 = "Button 1"

    /** The first firmware that starts an update by itself. */
    const val FIRST_WITH_NO_BUTTON = "1.7.2"
    private val NO_BUTTON_FROM = FirmwareVersion(1, 7, 2, 0)

    private data class StepName(val name: String, val doing: String? = null, val failed: String? = null)

    private val STEPS = listOf(
        StepName("Offered"),
        StepName("Accepted by the board", doing = "Waiting for $BUTTON_1", failed = "Not accepted"),
        StepName("Downloading", failed = "Download failed"),
        StepName("Download checked", doing = "Checking the download", failed = "Check failed"),
        StepName("Restarting", failed = "Did not start"),
        StepName("On trial", failed = "Rolled back"),
        StepName("Confirmed"),
    )
    val STEP_NAMES: List<String> = STEPS.map { it.name }
    private const val ACCEPTED = 1
    private const val DOWNLOADED = 2
    private const val VERIFIED = 3
    private const val RESTARTED = 4
    private const val TESTED = 5

    // Told in the past: every one of these is about an update that is over.
    val REFUSALS = mapOf(
        "not_newer" to "the board already ran this version or a newer one",
        "too_large" to "the image was larger than the board’s update slot",
        "bad_document" to "the board could not read the update instructions",
        "unsupported" to "the board did not support this kind of update",
        "url_not_allowed" to "the download address was not one the board accepts",
    )

    private data class Failure(val at: Int?, val title: String, val text: String, val replaced: Boolean = false)

    private val FAILURES = mapOf(
        "download_failed" to Failure(2, "The download failed", "The board could not download the image."),
        "digest_mismatch" to Failure(
            3, "The download was damaged",
            "What the board downloaded did not match the SHA-256 digest of the release, so the board discarded it.",
        ),
        "header_mismatch" to Failure(
            3, "Not the announced version",
            "The image the board downloaded does not carry the version that was announced, so the board discarded it.",
        ),
        "flash_error" to Failure(null, "The board could not store the update", "Writing to the board’s flash memory failed."),
        "interrupted" to Failure(null, "Interrupted", "The board restarted before the update was complete."),
        "not_installed" to Failure(
            4, "Not installed",
            "The board restarted, but the bootloader did not start the new image. It turns away an image with a wrong " +
                "signature or an older version.",
        ),
        "trial_lost" to Failure(
            5, "Its trial was cut short",
            "The board runs this image with nothing left to bring the old one back, because a restore of the golden image " +
                "was interrupted right after it began. The image has proved nothing. Repeat the gesture at the board to " +
                "finish the restore.",
            replaced = true,
        ),
    )

    private fun steps(
        done: Int,
        current: Int? = null,
        failed: Int? = null,
        stopped: Int? = null,
        ended: Boolean = false,
        refusal: String? = null,
        unknown: Boolean = false,
        lastSeen: Boolean = false,
    ): List<Step> = STEPS.mapIndexed { index, step ->
        var state = if (unknown) StepState.UNKNOWN else StepState.UPCOMING
        when {
            index < done -> state = StepState.DONE
            index == failed -> state = StepState.FAILED
            index == stopped -> state = StepState.STOPPED
            index == current -> state = StepState.CURRENT
            ended -> state = StepState.SKIPPED
        }
        val label = when (state) {
            StepState.CURRENT, StepState.STOPPED -> step.doing ?: step.name
            StepState.FAILED -> refusal ?: step.failed ?: step.name
            else -> step.name
        }
        Step(label, state, if (lastSeen && state == StepState.STOPPED) "last seen here" else null)
    }

    /** The steps of every update, none of them started: for the page of a console that has seen none. */
    fun previewSteps(): List<Step> = STEPS.map { Step(it.name, StepState.UPCOMING) }

    private fun mayHaveInstalled(entry: ExecutionSummary) = entry.status == "SUCCEEDED" || entry.status == "IN_PROGRESS"

    private fun versionOf(entry: ExecutionSummary) = entry.version ?: versionOfDeployment(entry.deployment)

    private fun otherInstall(history: List<ExecutionSummary>?, deployment: String?, version: String?): String? =
        history.orEmpty().firstOrNull { it.deployment != deployment && versionOf(it) == version && mayHaveInstalled(it) }?.deployment

    private fun outsideInstall(history: List<ExecutionSummary>) = history.any { versionOf(it) == null && mayHaveInstalled(it) }

    private fun movedSince(board: Device?, ranAtEnd: String?): String {
        val now = board?.fw?.version
        if (now.isNullOrEmpty() || ranAtEnd.isNullOrEmpty() || now == ranAtEnd) return ""
        return if (board.online) " It has since moved to $now." else " When last seen, it had moved to $now."
    }

    private const val STILL_OPEN = " The update stays open until the board reports back or the time limit ends."
    private const val TRIAL_RULE =
        "It is kept once the board has reconnected to AWS IoT; if it cannot, the bootloader puts the previous firmware back."

    /** The version a deployment installs, recovered from its id. */
    fun versionOfDeployment(id: String?): String? {
        val match = id?.let { Regex("^cranium-(\\d{1,3})-(\\d{1,3})-(\\d{1,5})-b(\\d{1,10})(?:-pi)?-\\d{8}T\\d{6}Z-[0-9a-f]{4}$").matchEntire(it) }
            ?: return null
        val (major, minor, revision, build) = match.destructured
        val version = "${major.toInt()}.${minor.toInt()}.${revision.toInt()}+${build.toLong()}"
        return version.takeIf { FirmwareVersion.parseStrict(it) != null }
    }

    /** True if a board reports that it runs this version or a newer one: it will refuse the offer. */
    fun alreadyRuns(device: Device, version: String?): Boolean {
        val target = version?.let { FirmwareVersion.parseStrict(it) } ?: return false
        val runs = device.fw?.version?.let { FirmwareVersion.parseStrict(it) } ?: return false
        return runs >= target
    }

    /** True if a board reports firmware that holds an update until Button 1 is pressed. */
    fun asksForButton(device: Device): Boolean {
        val runs = device.fw?.version?.let { FirmwareVersion.parseStrict(it) } ?: return false
        return runs < NO_BUTTON_FROM
    }

    /** True for a version that is not in the list of releases, once the list has been read and holds some. */
    fun isUnregistered(version: String?, releases: List<Release>?): Boolean =
        !version.isNullOrEmpty() && releases != null && releases.isNotEmpty() && releases.none { it.version == version }

    /** The board to tick without being asked: the only free one, unless it would refuse the release. */
    fun onlyChoice(devices: List<Device>, busy: Set<String>, version: String?): String? {
        val free = devices.filter { it.thing !in busy }
        if (free.size != 1 || alreadyRuns(free[0], version)) return null
        return free[0].thing
    }

    /**
     * Describe one board's part in a deployment. [board] is the board as the board list has it;
     * [history] its own list of updates, null while it has not been read; [unread] that the board
     * list has not been read yet.
     */
    fun describeExecution(
        execution: Execution,
        board: Device? = null,
        deployment: String? = null,
        version: String? = null,
        history: List<ExecutionSummary>? = null,
        historyCut: Boolean = false,
        unread: Boolean = false,
    ): ExecutionWords {
        val phase = execution.phase
        val reason = execution.reason
        val ranAtEnd = execution.ranAtEnd
        val reported = execution.reported
        val online = execution.online
        val progress = execution.progress
        val ranThen = if (ranAtEnd != null) " The board was running $ranAtEnd at the time." else ""
        val kept = if (ranAtEnd != null) " It kept running the firmware it had, $ranAtEnd." else " It kept running the firmware it had."
        val since = movedSince(board, ranAtEnd)
        var reports = ""
        if (reported != null) {
            reports = if (online) " The board reports that it runs $reported." else " When last seen, the board reported $reported."
        }
        val mayRetry = !unread && !(board != null && alreadyRuns(board, version))
        fun again(words: ExecutionWords, next: String = "To try again, start a new deployment."): ExecutionWords =
            if (mayRetry) words.copy(next = next, retry = true) else words
        val target = version ?: "an update"

        fun underWay(
            glyph: Glyph, at: Int, title: String, text: String, was: String, quiet: String,
            progressShown: Int? = null, said: String? = null,
        ): ExecutionWords = if (online) {
            ExecutionWords(Tone.LIVE, glyph, title, text, steps(at, current = at), progress = progressShown, said = said)
        } else {
            ExecutionWords(
                Tone.IDLE, glyph, "Was $was when last seen", quiet,
                steps(at, stopped = at, unknown = true, lastSeen = true),
            )
        }

        when (phase) {
            "waiting_for_device" -> {
                if (!online && board != null && board.lastSeen == null) {
                    return ExecutionWords(
                        Tone.WAIT, Glyph.MINUS_CIRCLE, "Never connected",
                        "Power it up and check that it was provisioned; it will see this update when it first connects.",
                        steps(0, current = 0),
                    )
                }
                if (!online) {
                    return ExecutionWords(
                        Tone.WAIT, Glyph.OFFLINE, "Board offline",
                        "The board is offline; it will see this update when it reconnects.", steps(0, current = 0),
                    )
                }
                return ExecutionWords(
                    Tone.WAIT, Glyph.CLOCK, "Not picked up yet",
                    "The board is online but has not picked up the offer yet. That normally takes a few seconds.",
                    steps(0, current = 0),
                )
            }
            "waiting_for_button" -> return ExecutionWords(
                Tone.ACT, Glyph.PRESS, "Press $BUTTON_1 on the board",
                "The board has the offer and waits for someone to press $BUTTON_1. LED1 blinks quickly while the offer " +
                    "is open; Button 2 declines it.",
                steps(1, current = 1),
            )
            "starting" -> return underWay(
                Glyph.DOWNLOAD, 2, "Starting",
                "The board has told AWS IoT that it starts this update, and downloads the image as soon as AWS IoT " +
                    "agrees. The firmware it runs is not touched yet.",
                was = "starting $target",
                quiet = "The board went offline as it started this update.$STILL_OPEN",
            )
            "downloading" -> return underWay(
                Glyph.DOWNLOAD, 2, if (progress == null) "Downloading" else "Downloading $progress%",
                "The board is downloading the image into its spare flash slot. The firmware it runs is not touched yet.",
                was = "downloading $target",
                quiet = "The board went offline ${if (progress == null) "during the download" else "with the download at $progress%"}.$STILL_OPEN",
                progressShown = progress, said = "Downloading",
            )
            "verifying" -> return underWay(
                Glyph.SHIELD, 3, "Checking the download",
                "The board is checking the size, the SHA-256 digest and the version in the signed header before it " +
                    "installs anything.",
                was = "checking the download of $target",
                quiet = "The board went offline while it was checking the download.$STILL_OPEN",
            )
            "rebooting" -> return underWay(
                Glyph.RESTART, 4, "Restarting",
                "The board is restarting. The bootloader checks the signature before it starts the new firmware.",
                was = "restarting into $target",
                quiet = "The board went offline while it was restarting.$STILL_OPEN",
            )
            "testing" -> return underWay(
                Glyph.PULSE, 5, "On trial", "The new firmware is running on trial. $TRIAL_RULE",
                was = "on trial with $target",
                quiet = "The board went offline with the new firmware on trial. $TRIAL_RULE",
            )
            "succeeded" -> {
                val holds = ranAtEnd != null && board?.online == true && board.fw?.version == ranAtEnd && board.fw.confirmed
                val told = when {
                    holds -> "The board runs $ranAtEnd and has confirmed it."
                    ranAtEnd != null -> "The board confirmed $ranAtEnd when this update ended.$since"
                    else -> "The board confirmed the new firmware."
                }
                return ExecutionWords(Tone.GOOD, Glyph.CHECK_CIRCLE, "Installed and confirmed", told, steps(STEPS.size))
            }
            "rolled_back" -> return ExecutionWords(
                Tone.BAD, Glyph.UNDO, "Rolled back",
                "The bootloader put the previous firmware back. The new firmware started but did not reconnect to AWS " +
                    "IoT, so it was never confirmed.${if (ranAtEnd != null) " That left the board on $ranAtEnd." else ""}$since",
                steps(5, failed = 5, ended = true),
                next = if (mayRetry) "Fix the build, then upload a newer version and deploy that." else null,
            )
            "declined" -> return again(
                ExecutionWords(
                    Tone.WARN, Glyph.MINUS_CIRCLE, "Declined on the board",
                    "Someone pressed Button 2 on the board to decline this update. Nothing was installed.$ranThen$since",
                    steps(1, failed = 1, ended = true),
                ),
            )
            "refused" -> {
                if (reason == null) {
                    return again(
                        ExecutionWords(
                            Tone.WARN, Glyph.BAN, "Refused or declined",
                            "This update was turned down on the board before anything was installed.$ranThen$since",
                            steps(1, failed = 1, ended = true),
                        ),
                    )
                }
                val why = REFUSALS[reason]
                val said = if (why != null) "Refused: $why." else "The board refused this update before installing anything."
                val words = ExecutionWords(
                    Tone.WARN, Glyph.BAN, "Refused by the board", "$said$ranThen$since",
                    steps(1, failed = 1, ended = true, refusal = "Refused"), code = if (why != null) null else reason,
                )
                return if (reason == "not_newer") {
                    words.copy(next = "To put something else on it, upload a newer version and deploy that.")
                } else {
                    again(words, "Deal with that first, then start a new deployment.")
                }
            }
            "failed" -> {
                val failure = reason?.let { FAILURES[it] }
                if (failure != null) {
                    val stepList = if (failure.at == null) {
                        steps(DOWNLOADED, stopped = DOWNLOADED, ended = true)
                    } else {
                        steps(failure.at, failed = failure.at, ended = true)
                    }
                    return again(
                        ExecutionWords(
                            Tone.BAD, Glyph.X_CIRCLE, failure.title,
                            "${failure.text}${if (failure.replaced) "" else kept}$since", stepList,
                        ),
                    )
                }
                val why = reason?.let { REFUSALS[it] }
                val said = if (why != null) "The board stopped: $why." else "The board reported that the update failed."
                return again(
                    ExecutionWords(
                        Tone.BAD, Glyph.X_CIRCLE, "Failed", "$said$kept$since",
                        if (reason != null) steps(DOWNLOADED, stopped = DOWNLOADED, ended = true) else steps(DOWNLOADED, unknown = true),
                        code = if (why != null) null else reason,
                    ),
                )
            }
            "cancelled" -> return describeCancelled(
                execution, board, deployment, version, history, historyCut, unread, reports, target, mayRetry,
            )
            "timed_out" -> return again(
                ExecutionWords(
                    Tone.BAD, Glyph.HOURGLASS, "Timed out",
                    "The board started but did not report a result before the time limit.$reports",
                    steps(DOWNLOADED, stopped = DOWNLOADED, ended = true),
                ),
                "Check that the board is powered and online, then start a new deployment.",
            )
            "removed" -> return ExecutionWords(
                Tone.IDLE, Glyph.MINUS, "Removed", "This board was taken out of the deployment.", steps(0, ended = true),
            )
            else -> return ExecutionWords(
                Tone.IDLE, Glyph.MINUS, "Unknown state", "The server reported a state this console does not know.",
                steps(0), code = phase.ifEmpty { null },
            )
        }
    }

    private fun describeCancelled(
        execution: Execution,
        board: Device?,
        deployment: String?,
        version: String?,
        history: List<ExecutionSummary>?,
        historyCut: Boolean,
        unread: Boolean,
        reports: String,
        target: String,
        mayRetry: Boolean,
    ): ExecutionWords {
        val reported = execution.reported
        val online = execution.online
        fun again(words: ExecutionWords) = if (mayRetry) words.copy(next = "To try again, start a new deployment.", retry = true) else words
        val now = reported?.let { FirmwareVersion.parseStrict(it) }
        val offered = version?.let { FirmwareVersion.parseStrict(it) }
        val movedOn = now != null && offered != null && now > offered
        val runsIt = reported != null && reported == version
        if (execution.startedAt == null) {
            if (runsIt || movedOn) {
                val installedBy = if (runsIt) otherInstall(history, deployment, version) else null
                return ExecutionWords(
                    Tone.IDLE, Glyph.STOP, "Cancelled",
                    "Cancelled before the board started, so this deployment installed nothing.$reports",
                    steps(ACCEPTED, ended = true), installedBy = installedBy,
                )
            }
            return again(
                ExecutionWords(
                    Tone.IDLE, Glyph.STOP, "Cancelled", "Cancelled before the board started. Nothing was installed.$reports",
                    steps(ACCEPTED, ended = true),
                ),
            )
        }
        val installedBy = if (runsIt) otherInstall(history, deployment, version) else null
        if (installedBy != null) {
            return ExecutionWords(
                Tone.IDLE, Glyph.STOP, "Cancelled",
                "Cancelled after the board had started, and it stopped there. Another deployment installed $reported.",
                steps(DOWNLOADED, stopped = DOWNLOADED, ended = true), installedBy = installedBy,
            )
        }
        if (movedOn) {
            return ExecutionWords(
                Tone.IDLE, Glyph.STOP, "Cancelled",
                "Cancelled after the board had started.$reports This page cannot tell how this update ended.",
                steps(DOWNLOADED, unknown = true), unsure = true,
            )
        }
        val wentThrough = runsIt && board?.fw?.confirmed == true && board.ota?.last == "succeeded" &&
            history != null && !historyCut && !outsideInstall(history)
        if (wentThrough) {
            return ExecutionWords(
                Tone.WARN, Glyph.ALERT, "Installed despite the cancellation",
                "This deployment was cancelled, but the board had gone too far to be stopped. " +
                    "${if (online) "It now runs" else "When last seen, it ran"} $reported.",
                steps(STEPS.size), next = "To replace it, upload a newer version and deploy that.", installed = true,
            )
        }
        val reached = if (board?.ota != null && board.ota.job == deployment) board.ota.state else null
        if (reached == "rebooting" || reached == "testing") {
            val at = if (reached == "rebooting") RESTARTED else TESTED
            if (!online) {
                return ExecutionWords(
                    Tone.IDLE, Glyph.RESTART,
                    "Was ${if (reached == "rebooting") "restarting into $target" else "on trial with $target"} when last seen",
                    "This deployment was cancelled, but the board was already restarting into the new firmware, and it has " +
                        "gone offline since. What it ends up running will show here.",
                    steps(at, stopped = at, unknown = true, lastSeen = true),
                )
            }
            return ExecutionWords(
                Tone.LIVE, Glyph.RESTART, "Finishing despite the cancellation",
                "This deployment was cancelled, but the board was already restarting into the new firmware and cannot be " +
                    "stopped. What it ends up running will show here.",
                steps(at, current = at, ended = true),
            )
        }
        if (runsIt) {
            return ExecutionWords(
                Tone.IDLE, Glyph.STOP, "Cancelled",
                "Cancelled after the board had started. ${if (online) "The board now runs" else "When last seen, the board ran"} " +
                    "$reported; how it got there is not on record.",
                steps(DOWNLOADED, unknown = true), unsure = true,
            )
        }
        if (unread) {
            return ExecutionWords(
                Tone.IDLE, Glyph.STOP, "Cancelled",
                "Cancelled after the board had started. What the board did next is still being read.",
                steps(DOWNLOADED, unknown = true), unsure = true,
            )
        }
        val at = if (reached == "verifying") VERIFIED else DOWNLOADED
        return again(
            ExecutionWords(
                Tone.IDLE, Glyph.STOP, "Cancelled",
                "Cancelled after the board had started. A board asks AWS before it installs, so it stops there and keeps " +
                    "the firmware it had.$reports",
                steps(at, stopped = at, ended = true),
            ),
        )
    }

    /** The words for an execution status alone, where no phase is known (a board's history). */
    fun describeStatus(status: String): StateWords = when (status) {
        "QUEUED" -> StateWords(Tone.WAIT, Glyph.CLOCK, "Waiting")
        "IN_PROGRESS" -> StateWords(Tone.LIVE, Glyph.RESTART, "Updating")
        "SUCCEEDED" -> StateWords(Tone.GOOD, Glyph.CHECK_CIRCLE, "Installed")
        "FAILED" -> StateWords(Tone.BAD, Glyph.X_CIRCLE, "Failed")
        "TIMED_OUT" -> StateWords(Tone.BAD, Glyph.HOURGLASS, "Timed out")
        "REJECTED" -> StateWords(Tone.WARN, Glyph.BAN, "Refused or declined")
        "REMOVED" -> StateWords(Tone.IDLE, Glyph.MINUS, "Removed")
        "CANCELED" -> StateWords(Tone.IDLE, Glyph.STOP, "Cancelled")
        else -> StateWords(Tone.IDLE, Glyph.MINUS, "Unknown")
    }

    /** The words for an entry of a board's history; `last` is how the board says its newest update ended. */
    fun describeHistory(status: String, last: String? = null): StateWords = when {
        status == "FAILED" && last == "rolled_back" -> StateWords(Tone.BAD, Glyph.UNDO, "Rolled back")
        status == "REJECTED" && last == "declined" -> StateWords(Tone.WARN, Glyph.MINUS_CIRCLE, "Declined on the board")
        status == "REJECTED" && last == "refused" -> StateWords(Tone.WARN, Glyph.BAN, "Refused by the board")
        else -> describeStatus(status)
    }

    // Every update of a board, from GET /api/updates (console 2.1.1), in the words of the website and both apps.

    /**
     * Whether a failed read of `GET /api/updates` says the console has no such route (2.1.0 and before
     * answer 404 `not_found`): then the app shows what it showed before, from the deployments and a
     * board's `executions`, and asks again only when the page is opened or pulled down. A 404
     * `unknown_device` is about the board, not the console.
     */
    fun noUpdatesRoute(error: Throwable?): Boolean = error is ApiError && error.status == 404 && error.code == "not_found"

    /** "over Bluetooth from Vihaan’s phone", "deployment <id>", "USB or another tool". */
    fun howWords(update: Update): String = when (update.how) {
        "bluetooth" -> update.who?.name?.trim()?.takeIf { it.isNotEmpty() }?.let { "over Bluetooth from $it’s phone" }
            ?: "over Bluetooth from a phone"
        "deployment" -> update.deployment?.let { "deployment $it" } ?: "a deployment"
        else -> "USB or another tool"
    }

    /** How an update ended: kept, rolled back, not installed, or pending (also for a word the app does not know). */
    fun outcomeWords(outcome: String): StateWords = when (outcome) {
        "kept" -> StateWords(Tone.GOOD, Glyph.CHECK_CIRCLE, "Kept")
        "rolled_back" -> StateWords(Tone.BAD, Glyph.UNDO, "Rolled back")
        "not_installed" -> StateWords(Tone.WARN, Glyph.MINUS_CIRCLE, "Not installed")
        else -> StateWords(Tone.WAIT, Glyph.CLOCK, "Pending")
    }

    /** The title of an update's row: the version it installs. */
    fun updateTitle(update: Update): String = update.to ?: "Unknown version"

    /** The time an update is told by: when it ended, else when it started. */
    fun updateTime(update: Update): String? = update.endedAt ?: update.startedAt

    /** The line under an update's title: "from 1.13.0+0 · over Bluetooth from Vihaan’s phone · 2 h ago". */
    fun updateDetail(update: Update, nowMs: Long): String = listOfNotNull(
        update.from?.let { "from $it" },
        howWords(update),
        Words.timeAgo(updateTime(update), nowMs).ifEmpty { null },
    ).joinToString(" · ")

    /** The overview's line for the newest update: "Last: 1.14.0+0 · over Bluetooth from Vihaan’s phone · 2 h ago". */
    fun lastUpdateLine(update: Update, nowMs: Long): String = listOfNotNull(
        "Last: ${updateTitle(update)}",
        howWords(update),
        Words.timeAgo(updateTime(update), nowMs).ifEmpty { null },
    ).joinToString(" · ")

    /** A board's page, in one line: "Last: 1.14.0+0 · Kept · 2 h ago". */
    fun updateSummary(update: Update, nowMs: Long): String = listOfNotNull(
        "Last: ${updateTitle(update)}",
        outcomeWords(update.outcome).label,
        Words.timeAgo(updateTime(update), nowMs).ifEmpty { null },
    ).joinToString(" · ")

    /** The deployment an update's row opens: one of this console's, for an update that came that way; else null (the board). */
    fun deploymentOf(update: Update): String? =
        update.deployment?.takeIf { update.how == "deployment" && ApiJson.isDeploymentId(it) }

    private val LAST_UPDATE = mapOf(
        "none" to StateWords(Tone.IDLE, Glyph.MINUS, "No update in progress", quiet = true),
        "succeeded" to StateWords(Tone.GOOD, Glyph.CHECK_CIRCLE, "Last update succeeded"),
        "failed" to StateWords(Tone.BAD, Glyph.X_CIRCLE, "Last update failed"),
        "rolled_back" to StateWords(Tone.BAD, Glyph.UNDO, "Last update was rolled back"),
        "declined" to StateWords(Tone.WARN, Glyph.MINUS_CIRCLE, "Last update was declined on the board"),
        "refused" to StateWords(Tone.WARN, Glyph.BAN, "Last update was refused by the board"),
        "cancelled" to StateWords(Tone.IDLE, Glyph.STOP, "Last update was cancelled"),
    )

    /** What a board last said about updates. An offline board's words are old news, and say so. */
    fun describeUpdate(device: Device): StateWords {
        val ota = device.ota ?: return StateWords(Tone.IDLE, Glyph.MINUS, "Nothing reported", quiet = true)
        val online = device.online
        val version = versionOfDeployment(ota.job)
        val target = version ?: "an update"
        fun live(tone: Tone, glyph: Glyph, title: String, text: String, progress: Int? = null, was: String? = null) = StateWords(
            tone = if (online) tone else Tone.IDLE,
            glyph = glyph,
            label = if (online) title else "Was ${was ?: (title.first().lowercase() + title.drop(1))} when last seen",
            text = if (online) text else "",
            progress = if (online) progress else null,
            deployment = ota.job,
        )
        return when (ota.state) {
            "idle" -> {
                val last = LAST_UPDATE[ota.last] ?: LAST_UPDATE.getValue("none")
                val refusal = REFUSALS[ota.error]
                val why = FAILURES[ota.error]?.title ?: if (refusal != null) "Because $refusal." else ""
                val text = if (ota.last == "failed" || ota.last == "refused") why else ""
                val told = if (last === LAST_UPDATE["none"] && !online) last.copy(label = "No update in progress when last seen") else last
                told.copy(text = text)
            }
            "awaiting_user" -> live(
                Tone.ACT, Glyph.PRESS, "Press $BUTTON_1 on the board",
                "${version ?: "An update"} is on offer. Button 1 on the board installs it, Button 2 declines.",
                was = "waiting for $BUTTON_1",
            )
            "downloading" -> live(Tone.LIVE, Glyph.DOWNLOAD, "Downloading $target", "", progress = ota.progress)
            "verifying" -> live(Tone.LIVE, Glyph.SHIELD, "Checking the download of $target", "")
            "rebooting" -> live(Tone.LIVE, Glyph.RESTART, "Restarting into $target", "")
            "testing" -> live(Tone.LIVE, Glyph.PULSE, "On trial: $target", "It is kept once the board has reconnected.", was = "on trial with $target")
            // A job with board firmware and a Raspberry Pi image (console 2.26.0): the Pi's part.
            "downloading_pi" -> live(
                Tone.LIVE, Glyph.DOWNLOAD, "Downloading the Raspberry Pi image",
                "Onto the board's SD card, with $target. Nothing is installed yet.", progress = ota.progress,
            )
            "flashing_pi" -> live(
                Tone.LIVE, Glyph.UPLOAD, "Sending the Raspberry Pi its image",
                "$target is installed; the board sends the image from its SD card.", progress = ota.progress,
            )
            "bluetooth" -> live(
                Tone.LIVE, Glyph.DOWNLOAD, "Open for an update over Bluetooth",
                "A person at the board opened Bluetooth for a phone. Updates from here wait until it closes.",
                was = "open for an update over Bluetooth",
            )
            else -> live(Tone.LIVE, Glyph.RESTART, "Updating", "")
        }
    }

    enum class Standing { CURRENT, UNHEARD, MOVED }

    data class InstallStanding(val state: Standing, val boards: List<Device>, val moved: List<Device>)

    /** Where the boards of a deployment that went through stand today. */
    fun installStanding(deployment: DeploymentSummary, devices: List<Device>?): InstallStanding {
        val boards = devices.orEmpty().filter { it.thing in deployment.things }
        val moved = if (deployment.version == null) emptyList() else boards.filter { it.fw != null && it.fw.version != deployment.version }
        if (moved.isNotEmpty()) return InstallStanding(Standing.MOVED, boards, moved)
        val current = boards.isNotEmpty() && boards.size == deployment.things.size &&
            boards.all { it.online && it.fw?.version == deployment.version && it.fw?.confirmed == true }
        return InstallStanding(if (current) Standing.CURRENT else Standing.UNHEARD, boards, moved)
    }

    /** The badge for a deployment as a whole; `said` is the sentence for one that is over and has news. */
    fun describeDeployment(deployment: DeploymentSummary, devices: List<Device>? = null): StateWords {
        val counts = deployment.counts
        val total = deployment.things.size.takeIf { it > 0 } ?: counts.total
        return when (deployment.status) {
            "IN_PROGRESS" -> if (counts.inProgress > 0) {
                StateWords(Tone.LIVE, Glyph.RESTART, "Updating")
            } else {
                StateWords(Tone.WAIT, Glyph.CLOCK, "Waiting for boards")
            }
            "COMPLETED" -> when {
                total > 0 && counts.succeeded == total -> {
                    val what = deployment.version ?: "The update"
                    val verb = if (installStanding(deployment, devices).state == Standing.CURRENT) "is" else "was"
                    StateWords(
                        Tone.GOOD, Glyph.CHECK_CIRCLE, "Succeeded",
                        said = "$what $verb installed and confirmed${if (total == 1) "" else " on $total boards"}.",
                    )
                }
                counts.succeeded > 0 -> StateWords(Tone.WARN, Glyph.ALERT, "Partly succeeded", said = "The last deployment partly succeeded.")
                counts.failed + counts.timedOut > 0 -> StateWords(Tone.BAD, Glyph.X_CIRCLE, "Failed", said = "The last deployment failed.")
                else -> StateWords(Tone.IDLE, Glyph.MINUS_CIRCLE, "Not installed")
            }
            "CANCELED" -> when {
                counts.inProgress > 0 -> StateWords(
                    Tone.LIVE, Glyph.RESTART, "Cancelled, ${Words.plural(counts.inProgress, "board")} still working",
                )
                counts.succeeded > 0 -> StateWords(
                    Tone.WARN, Glyph.ALERT, "Cancelled, ${Words.plural(counts.succeeded, "board")} finished",
                    said = "The last deployment was cancelled, but ${Words.plural(counts.succeeded, "board")} finished it.",
                )
                else -> StateWords(Tone.IDLE, Glyph.STOP, "Cancelled")
            }
            "SCHEDULED" -> StateWords(Tone.WAIT, Glyph.CLOCK, "Scheduled")
            "DELETION_IN_PROGRESS" -> StateWords(Tone.IDLE, Glyph.MINUS, "Being deleted")
            else -> StateWords(Tone.IDLE, Glyph.MINUS, "Unknown")
        }
    }

    private data class CountName(val name: String, val label: String, val tone: Tone, val glyph: Glyph)

    private val COUNT_WORDS = listOf(
        CountName("succeeded", "succeeded", Tone.GOOD, Glyph.CHECK_CIRCLE),
        CountName("inProgress", "updating", Tone.LIVE, Glyph.RESTART),
        CountName("queued", "waiting", Tone.WAIT, Glyph.CLOCK),
        CountName("failed", "failed", Tone.BAD, Glyph.X_CIRCLE),
        CountName("timedOut", "timed out", Tone.BAD, Glyph.HOURGLASS),
        CountName("rejected", "refused or declined", Tone.WARN, Glyph.BAN),
        CountName("canceled", "cancelled", Tone.IDLE, Glyph.STOP),
        CountName("removed", "removed", Tone.IDLE, Glyph.MINUS),
    )

    /** The non-zero board counts of a deployment, with `atButton` of the waiting boards told apart. */
    fun describeCounts(counts: Counts, atButton: Int = 0): List<CountWords> {
        val pressing = minOf(atButton, counts.queued)
        val lines = COUNT_WORDS
            .filter { counts[it.name] > 0 && !(it.name == "queued" && counts.queued == pressing) }
            .map { CountWords(it.name, if (it.name == "queued") counts.queued - pressing else counts[it.name], it.label, it.tone, it.glyph) }
        return if (pressing > 0) listOf(CountWords("atButton", pressing, "waiting for $BUTTON_1", Tone.ACT, Glyph.PRESS)) + lines else lines
    }

    /** "2 succeeded, 1 waiting". */
    fun countWords(counts: Counts, atButton: Int = 0): String =
        describeCounts(counts, atButton).joinToString(", ") { "${it.count} ${it.label}" }

    // Activity: what to watch closely, and how often to ask again.

    const val POLL_INSTALLING_MS = 3_000L
    const val POLL_WAITING_MS = 10_000L

    /** The polling interval for a set of execution statuses; 0 means do not poll. */
    fun pollInterval(statuses: List<String?>): Long {
        var waiting = false
        for (status in statuses) {
            if (status == "IN_PROGRESS") return POLL_INSTALLING_MS
            if (status == "QUEUED") waiting = true
        }
        return if (waiting) POLL_WAITING_MS else 0
    }

    fun executionActivity(execution: Execution): String =
        if (execution.status == "QUEUED" && execution.online) "IN_PROGRESS" else execution.status

    fun summaryActivity(deployment: DeploymentSummary, devices: List<Device>): String? {
        if (deployment.counts.inProgress > 0) return "IN_PROGRESS"
        if (deployment.counts.queued == 0) return null
        val online = devices.any { it.online && it.thing in deployment.things }
        return if (online) "IN_PROGRESS" else "QUEUED"
    }

    fun deviceActivity(device: Device): String? =
        if (!device.online || device.ota == null || device.ota.state == "idle") null else "IN_PROGRESS"

    private const val SETTLING_MS = 5 * 60_000L

    /** True while a cancelled update may still change what a board runs. */
    fun stillSettling(execution: Execution, board: Device?, deploymentId: String, nowMs: Long): Boolean {
        if (execution.status != "CANCELED" || execution.startedAt == null) return false
        val ota = board?.ota ?: return false
        if (ota.job != deploymentId || ota.state == "idle") return false
        val since = Times.parse(execution.lastUpdatedAt) ?: return false
        return nowMs - since < SETTLING_MS
    }

    /** A board that said that it is restarting and has not been written off yet. */
    fun isRestarting(device: Device): Boolean = device.online && device.ota?.state == "rebooting"

    /** On line and not restarting. */
    fun isUp(device: Device): Boolean = device.online && !isRestarting(device)

    fun isUnfinished(status: String): Boolean = status == "QUEUED" || status == "IN_PROGRESS"

    /** True while a board that a cancellation found restarting or on trial still reports this deployment. */
    fun stillFinishing(deployment: DeploymentSummary, devices: List<Device>?, nowMs: Long): Boolean {
        if (deployment.status != "CANCELED") return false
        return devices.orEmpty().any { device ->
            val ota = device.ota
            if (ota == null || ota.job != deployment.id) return@any false
            if (ota.state != "rebooting" && ota.state != "testing") return@any false
            if (device.online) return@any true
            val since = Times.parse(device.lastSeen) ?: return@any false
            nowMs - since < SETTLING_MS
        }
    }

    /** Whether a deployment still has a board waiting or at work. */
    fun isUnderWay(deployment: DeploymentSummary): Boolean =
        deployment.status == "IN_PROGRESS" || deployment.counts.inProgress + deployment.counts.queued > 0

    // Cancelling and revoking.

    /** What to say once a deployment has been cancelled. */
    fun cancelNotice(force: Boolean, withdrawn: Boolean, started: Int): String {
        if (withdrawn) return "Stop requested. Boards that had started have been asked to stop."
        if (force) {
            return if (started > 0) {
                "Cancelled. Boards that had started have been asked to stop."
            } else {
                "Cancelled. Boards that had not started are no longer offered this update."
            }
        }
        return if (started > 0) {
            "Cancelled. ${Words.plural(started, "board that had started carries", "boards that had started carry")} on."
        } else {
            "Cancelled. Boards that had not started are no longer offered this update."
        }
    }

    enum class RevocationState { COMPLETE, INCOMPLETE, UNKNOWN }

    /** Where the revocation of a release stands; null for a release that is not revoked. */
    fun revocationState(release: Release): RevocationState? {
        if (release.isActive) return null
        val mark = release.revoked
        if (mark?.enforcedAt != null) return RevocationState.COMPLETE
        return if (mark != null && mark.recordsEnforcement) RevocationState.INCOMPLETE else RevocationState.UNKNOWN
    }

    /** That boards report a release that was just revoked. */
    fun stillRunning(boards: List<Device>): String {
        val heard = boards.count { it.online }
        val quiet = boards.size - heard
        val who = if (boards.size == 1) {
            "${Boards.name(boards[0])} ${if (heard == 1) "still runs it" else "last reported running it"}"
        } else {
            listOfNotNull(
                if (heard > 0) Words.plural(heard, "board still runs it", "boards still run it") else null,
                if (quiet > 0) "${Words.plural(quiet, "board")} last reported running it" else null,
            ).joinToString(" and ")
        }
        return "$who; to replace it there, upload a newer version and deploy that."
    }

    /** What to say once a revocation has gone through. `cancelled` null: the server said all is in place. */
    fun revocationNotice(version: String, cancelled: List<String>?, again: Boolean, running: List<Device> = emptyList()): String {
        val still = if (running.isNotEmpty()) " ${stillRunning(running)}" else ""
        if (cancelled == null) {
            return (
                if (again) {
                    "The revocation of $version is in place: its image is refused and no deployment of it is open."
                } else {
                    "$version was revoked already, and that revocation is in place."
                }
                ) + still
        }
        val lead = if (again) "The revocation of $version is in place." else "Revoked $version."
        if (cancelled.isEmpty()) return "$lead No deployment of it was still open.$still"
        val stopped = Words.plural(cancelled.size, "unfinished deployment was", "unfinished deployments were")
        return "$lead $stopped cancelled.$still"
    }
}
