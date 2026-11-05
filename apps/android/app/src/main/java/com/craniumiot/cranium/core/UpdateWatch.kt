package com.craniumiot.cranium.core

/**
 * What became of an image sent over Bluetooth, step by step, from what the phone can see: the link to
 * the board while it lasts, then the console (docs/mobile-apps.md, "What a person does"). A pure
 * function of what was seen, so that both apps say the same thing at the same point: the iPhone app's
 * CraniumKit/UpdateWatch.swift is the same, case for case, and so are the tests.
 *
 * What the board tells, and how (firmware/app/src/bt_ota.c):
 *
 * - Button 1: it records the update, leaves AWS IoT and restarts into the bootloader at once. The line
 *   it prints for it ("restarting into the bootloader: …") is lost with the restart, so the press shows
 *   as the board closing the Bluetooth link, then as its disconnect from AWS IoT (an event of kind
 *   connection) at the moment of the press. After the restart: "on trial: <new> from <old>, …", and
 *   once it is kept or not, "update over Bluetooth: <new> from <old>, <result>, proof <who>, …".
 * - Button 2: "closed: by Button 2", and the link closes. The board stays online.
 * - The 2 minutes running out: "closed: no image to install", and the link closes.
 *
 * Times are epoch milliseconds.
 */
object UpdateWatch {
    /** The board keeps an image that has arrived for this long, for a button (BT_OTA_OFFER_SECONDS). */
    const val OFFER_MS = 120_000L

    /** After the link drops, the console is followed for this long at most. */
    const val FOLLOW_MS = 300_000L

    /** How often the console is asked while it is followed, and the most that is backed off to on a 429. */
    const val POLL_MS = 3_000L
    const val SLOWEST_POLL_MS = 30_000L

    /** While the link is up, the image list is read this often: an answer says the link is still there. */
    const val LINK_READ_MS = 3_000L

    /**
     * The board closes the link when its 2 minutes are up: a drop this close to the end, or after it, is
     * taken for that rather than for Button 1.
     */
    const val END_SLACK_MS = 3_000L

    /** Lines and events from this long before the send count: the phone's clock and AWS's differ a little. */
    const val CLOCK_SLACK_MS = 30_000L

    /** A boot this long before the send still counts as after it: the board's uptime is in whole seconds. */
    private const val BOOT_SLACK_MS = 10_000L

    /** A flow reopened this soon after its board was last followed shows how it went. */
    const val KEEP_MS = 300_000L

    enum class Step { SENT, BUTTON, INSTALLING, TRIAL, END }

    enum class State {
        WAITING,

        /** Reached, and where things stand now. */
        CURRENT,
        DONE,

        /** Reached by the app's reading of the link only: not the board's word yet. */
        LIKELY,
        FAILED,
    }

    enum class Outcome {
        KEPT,
        ROLLED_BACK,

        /** Button 2. */
        DECLINED,

        /** The 2 minutes ran out. */
        EXPIRED,

        /** The board did not take the image it got. */
        REFUSED,
    }

    data class Row(val step: Step, val state: State, val title: String, val detail: String? = null, val at: Long? = null)

    /** Everything seen since the send. */
    data class Facts(
        /** The release sent, `1.13.0+0`. */
        val version: String,
        /** What the board ran when it was sent, `1.12.0+0`. */
        val from: String? = null,
        /** When the upload ended, on the phone's clock. */
        val sentAt: Long,
        /** The board in the console, from the pairing call. Null: the console did not say which board this is. */
        val thing: String? = null,
        /** Whether the console had the board online right after the send; null when not known. */
        val onConsole: Boolean? = null,
        /** When the phone saw the Bluetooth link go. */
        val linkDroppedAt: Long? = null,
        /** The board's log since the send (`GET /api/events/log`). */
        val lines: List<BoardLine> = emptyList(),
        /** Its events since the send (`GET /api/events`): those of kind connection are used. */
        val events: List<BoardEvent> = emptyList(),
        /** The newest read of the board (`GET /api/devices/{thing}`). */
        val device: Device? = null,
        /** The last time the console was asked, it could not be reached. */
        val consoleFailed: Boolean = false,
        /** The console has been followed for [FOLLOW_MS] after the drop. */
        val gaveUp: Boolean = false,
    ) {
        /** The console can follow this board: it knows which board it is, and did not have it offline. */
        val followable: Boolean get() = thing != null && onConsole != false
    }

    data class Timeline(
        val rows: List<Row>,
        val outcome: Outcome?,
        /** The outcome is the app's reading of the link alone, not the board's word. */
        val tentative: Boolean,
        /** When the board's 2 minutes end. */
        val deadline: Long,
        /** No button is known yet and the link is up: the countdown shows. */
        val waitingForButton: Boolean,
        /** One plain line under the steps. */
        val note: String?,
        /** Nothing more can be learned: stop asking the console. */
        val finished: Boolean,
        /** The version the board went back to. */
        val rolledBackTo: String?,
        /** When Button 1 was taken, where that is known. */
        val acceptedAt: Long?,
    )

    /** The last update a phone followed on a board, for the board's page. */
    data class Record(
        val thing: String,
        val version: String,
        /** When Button 1 was taken, or else when the image was sent. */
        val at: Long,
        val outcome: Outcome?,
        val tentative: Boolean = false,
        val rolledBackTo: String? = null,
    )

    // Words.

    fun sentTitle(version: String): String = "Sent $version"
    const val SENT_DETAIL = "Press Button 1 on the board within 2 minutes to install it (Button 2 throws it away)."
    const val BUTTON_TITLE = "Button 1 pressed, accepted"
    const val LINK_CLOSED = "The board closed the link: it is installing."
    const val DECLINED_TITLE = "Button 2 pressed: the image was thrown away"
    const val EXPIRED_TITLE = "The 2 minutes ran out: the image was thrown away"
    const val LIKELY_EXPIRED_TITLE = "The 2 minutes ran out"
    const val LIKELY_EXPIRED_DETAIL = "The board closed the link at the end of its 2 minutes: it has most likely thrown the image away."
    const val REFUSED_TITLE = "The board did not take the image"
    const val INSTALLING_TITLE = "Installing and restarting"
    const val INSTALLING_DETAIL = "The board is offline on the console while it installs."
    fun trialTitle(version: String): String = "Running $version on trial"
    const val TRIAL_DETAIL = "Back online with the new version, not yet kept."
    fun keptTitle(version: String): String = "Kept $version"
    fun rolledBackTitle(old: String?): String = old?.let { "Rolled back to $it" } ?: "Rolled back"
    const val CANNOT_FOLLOW = "The board is not on the console, so the app can't follow it from here. After it restarts, check its version over Bluetooth."
    const val GAVE_UP = "5 minutes have passed, so the app has stopped following it. The board's page shows how it ends."
    const val CONSOLE_FAILED = "The console could not be reached just now. The app keeps asking."
    const val TIME_UP = "The 2 minutes are up."

    /** Who kept it, from the board's record. */
    fun keptDetail(proof: String?): String = when (proof) {
        "cloud" -> "It reached AWS IoT, so the board keeps it."
        "person" -> "A person at the board proved it."
        else -> "The board keeps it."
    }

    /** Why it went back, from the board's record; "Back on the old version." when the board only shows it. */
    fun rolledBackDetail(result: String?): String = when (result) {
        "rolled_back" -> "The new image was not kept: the bootloader put the old one back."
        "not_installed" -> "The bootloader did not install the new image."
        "trial_lost" -> "The new image lost its trial."
        "flash_error" -> "The new image could not be written to flash."
        "superseded" -> "A cloud update replaced it."
        "incompatible_board" -> "The image is for another kind of board."
        "incompatible_layout" -> "The image is for another flash layout."
        else -> "Back on the old version."
    }

    /** "1:42 left", then "The 2 minutes are up." */
    fun countdown(secondsLeft: Int): String {
        if (secondsLeft <= 0) return TIME_UP
        val seconds = secondsLeft % 60
        return "${secondsLeft / 60}:${if (seconds < 10) "0" else ""}$seconds left"
    }

    /** How long to wait before asking the console again, after [throttled] answers of 429 in a row. */
    fun nextPoll(throttled: Int): Long = minOf(SLOWEST_POLL_MS, POLL_MS shl throttled.coerceIn(0, 8))

    // What the board said.

    /** One of the board's records of an update: "<what>: <to> from <from>, <result>, proof <who>, update N of this board". */
    internal data class Said(val what: String, val to: String, val from: String, val result: String, val proof: String)

    private val RECORD_KINDS = listOf("restarting into the bootloader", "on trial", "last update over Bluetooth", "update over Bluetooth")

    internal fun parseRecord(text: String): Said? {
        val what = RECORD_KINDS.firstOrNull { text.startsWith("$it: ") } ?: return null
        val parts = text.substring(what.length + 2).split(", ")
        if (parts.size < 3 || !parts[2].startsWith("proof ")) return null
        val versions = parts[0].split(" from ")
        if (versions.size != 2) return null
        return Said(what, versions[0], versions[1], parts[1], parts[2].removePrefix("proof "))
    }

    private fun same(a: String?, b: String): Boolean {
        val left = a?.let(FirmwareVersion::parseRelease) ?: return false
        return left == FirmwareVersion.parseRelease(b)
    }

    // The timeline.

    fun timeline(facts: Facts): Timeline {
        val deadline = facts.sentAt + OFFER_MS
        val since = facts.sentAt - CLOCK_SLACK_MS
        val version = facts.version

        val lines = facts.lines
            .filter { (it.tag == "BT" || it.tag == "bt_ota") && Times.parse(it.at)?.let { at -> at >= since } == true }
            .sortedWith(compareBy({ it.atMs }, { it.boot ?: 0L }, { it.seq ?: 0L }))
        fun first(what: String): Pair<Said, Long>? {
            for (line in lines) {
                val said = parseRecord(line.text) ?: continue
                if (said.what == what && same(said.to, version)) return said to line.atMs
            }
            return null
        }
        fun firstLine(test: (String) -> Boolean): BoardLine? = lines.firstOrNull { test(it.text) }

        val restarting = first("restarting into the bootloader")
        val onTrial = first("on trial")
        val finished = first("update over Bluetooth") ?: first("last update over Bluetooth")
        val button2 = firstLine { it.startsWith("closed: by Button 2") }
        val refused = firstLine {
            it.startsWith("refused the image") || it.startsWith("what arrived cannot be installed") || it.startsWith("the image could not be installed")
        }
        val noImage = firstLine { it.startsWith("closed: no image to install") }

        val connections = facts.events
            .filter { it.kind == "connection" }
            .mapNotNull { event -> Times.parse(event.at)?.takeIf { it >= since }?.let { event.what to it } }
            .sortedBy { it.second }
        val offlineAt = connections.firstOrNull { it.first == "disconnected" }?.second
        val backAt = connections.firstOrNull { it.first == "connected" && it.second > (offlineAt ?: since) }?.second

        // The board as the console last read it: a boot after the send, and what that boot runs.
        val device = facts.device
        val seen = Times.parse(device?.lastSeen)
        val up = device?.uptime
        val bootAt = if (seen != null && up != null) (seen - up * 1000).takeIf { it >= facts.sentAt - BOOT_SLACK_MS } else null
        val runs = if (bootAt == null) null else device?.fw?.takeIf { it.version.isNotEmpty() }
        val record = device?.bt?.takeIf { same(it.to, version) }

        // How it ended, the board's own word first.
        var outcome: Outcome? = null
        var endAt: Long? = null
        var proof: String? = null
        var reason: String? = null
        var old: String? = null
        var refusal: String? = null
        when {
            finished != null && finished.first.result != "pending" -> {
                val said = finished.first
                if (said.result == "succeeded") {
                    outcome = Outcome.KEPT
                    proof = said.proof
                } else {
                    outcome = Outcome.ROLLED_BACK
                    reason = said.result
                    old = said.from
                }
                endAt = finished.second
            }
            button2 != null -> {
                outcome = Outcome.DECLINED
                endAt = button2.atMs
            }
            refused != null -> {
                outcome = Outcome.REFUSED
                endAt = refused.atMs
                refusal = refused.text
            }
            noImage != null -> {
                outcome = Outcome.EXPIRED
                endAt = noImage.atMs
            }
            runs != null && same(runs.version, version) && runs.confirmed -> {
                outcome = Outcome.KEPT
                endAt = backAt ?: bootAt
                proof = record?.proof
            }
            runs != null && !same(runs.version, version) -> {
                outcome = Outcome.ROLLED_BACK
                endAt = backAt ?: bootAt
                old = runs.version
                reason = record?.result?.takeIf { it in Telemetry.BAD_BT }
            }
        }

        val dropped = facts.linkDroppedAt
        val ranOnTrial = onTrial != null || (runs != null && same(runs.version, version)) || outcome == Outcome.KEPT
        val acceptedSure = restarting != null || ranOnTrial || outcome == Outcome.ROLLED_BACK || (dropped != null && offlineAt != null)
        val acceptedAt = restarting?.second ?: offlineAt ?: dropped
        val likelyAccepted = !acceptedSure && outcome == null && dropped != null && dropped < deadline - END_SLACK_MS
        val likelyExpired = !acceptedSure && outcome == null && dropped != null && dropped >= deadline - END_SLACK_MS

        val rows = mutableListOf(Row(Step.SENT, State.DONE, sentTitle(version), SENT_DETAIL, facts.sentAt))
        var tentative = false
        var stopped = false

        when (outcome) {
            Outcome.DECLINED -> {
                rows += Row(Step.BUTTON, State.FAILED, DECLINED_TITLE, at = endAt)
                stopped = true
            }
            Outcome.EXPIRED -> {
                rows += Row(Step.BUTTON, State.FAILED, EXPIRED_TITLE, at = endAt)
                stopped = true
            }
            Outcome.REFUSED -> {
                rows += Row(Step.BUTTON, State.FAILED, REFUSED_TITLE, refusal, endAt)
                stopped = true
            }
            else -> when {
                likelyExpired -> {
                    rows += Row(Step.BUTTON, State.LIKELY, LIKELY_EXPIRED_TITLE, LIKELY_EXPIRED_DETAIL, dropped)
                    outcome = Outcome.EXPIRED
                    tentative = true
                    stopped = true
                }
                acceptedSure -> rows += Row(Step.BUTTON, State.DONE, BUTTON_TITLE, at = acceptedAt)
                likelyAccepted -> rows += Row(Step.BUTTON, State.LIKELY, BUTTON_TITLE, LINK_CLOSED, dropped)
                else -> rows += Row(Step.BUTTON, State.CURRENT, BUTTON_TITLE)
            }
        }

        if (!stopped) {
            val offline = offlineAt != null || (dropped != null && device?.online == false)
            val pastInstall = backAt != null || ranOnTrial || outcome != null
            rows += when {
                pastInstall -> Row(Step.INSTALLING, State.DONE, INSTALLING_TITLE, at = offlineAt)
                offline -> Row(Step.INSTALLING, State.CURRENT, INSTALLING_TITLE, INSTALLING_DETAIL, offlineAt)
                else -> Row(Step.INSTALLING, State.WAITING, INSTALLING_TITLE)
            }

            val trialAt = onTrial?.second ?: backAt ?: bootAt
            rows += when (outcome) {
                Outcome.KEPT -> Row(Step.TRIAL, State.DONE, trialTitle(version), at = trialAt)
                Outcome.ROLLED_BACK -> Row(Step.TRIAL, if (onTrial != null) State.DONE else State.WAITING, trialTitle(version), at = onTrial?.second)
                else -> if (ranOnTrial) {
                    Row(Step.TRIAL, State.CURRENT, trialTitle(version), TRIAL_DETAIL, trialAt)
                } else {
                    Row(Step.TRIAL, State.WAITING, trialTitle(version))
                }
            }

            rows += when (outcome) {
                Outcome.KEPT -> Row(Step.END, State.DONE, keptTitle(version), keptDetail(proof), endAt)
                Outcome.ROLLED_BACK -> Row(Step.END, State.FAILED, rolledBackTitle(old ?: facts.from), rolledBackDetail(reason), endAt)
                else -> Row(Step.END, State.WAITING, keptTitle(version))
            }
        }

        // Once the link is gone, what the console can still tell.
        var note: String? = null
        var done = outcome != null && !tentative
        if (outcome == null || tentative) {
            when {
                dropped != null && !facts.followable -> {
                    note = CANNOT_FOLLOW
                    done = true
                }
                facts.gaveUp -> {
                    note = GAVE_UP
                    done = true
                }
                facts.consoleFailed -> note = CONSOLE_FAILED
            }
        }

        return Timeline(
            rows = rows,
            outcome = outcome,
            tentative = tentative,
            deadline = deadline,
            waitingForButton = dropped == null && !acceptedSure && outcome == null,
            note = note,
            finished = done,
            rolledBackTo = if (outcome == Outcome.ROLLED_BACK) old ?: facts.from else null,
            acceptedAt = if (acceptedSure || likelyAccepted) acceptedAt else null,
        )
    }

    /** What a board's page keeps of a followed update. */
    fun record(facts: Facts, timeline: Timeline): Record? {
        val thing = facts.thing ?: return null
        return Record(thing, facts.version, timeline.acceptedAt ?: facts.sentAt, timeline.outcome, timeline.tentative, timeline.rolledBackTo)
    }

    // On the board's page.

    /**
     * "1.13.0+0 over Bluetooth at 12:14, kept": what this phone followed, else the board's own record
     * (without a time, which it does not keep). Null when there is neither.
     */
    fun summary(record: Record?, bt: BtRecord?, time: (Long) -> String): String? {
        if (record != null) {
            val head = "${record.version} over Bluetooth at ${time(record.at)}"
            if (bt != null && same(bt.to, record.version) && (record.outcome == null || record.tentative)) {
                words(bt)?.let { return "$head, $it" }
            }
            return "$head, ${words(record.outcome, record.rolledBackTo)}"
        }
        if (bt == null) return null
        return words(bt)?.let { "${bt.to} over Bluetooth, $it" }
    }

    private fun words(outcome: Outcome?, rolledBackTo: String?): String = when (outcome) {
        Outcome.KEPT -> "kept"
        Outcome.ROLLED_BACK -> rolledBackTo?.let { "rolled back to $it" } ?: "rolled back"
        Outcome.DECLINED -> "thrown away with Button 2"
        Outcome.EXPIRED -> "not installed: the 2 minutes ran out"
        Outcome.REFUSED -> "not taken by the board"
        null -> "not followed to the end"
    }

    private fun words(bt: BtRecord): String? = when (bt.result) {
        "succeeded" -> "kept"
        "pending" -> "on trial"
        "superseded" -> "replaced by a cloud update"
        else -> if (bt.result in Telemetry.BAD_BT) "rolled back to ${bt.from}" else null
    }
}
