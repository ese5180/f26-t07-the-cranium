package com.craniumiot.cranium.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.craniumiot.cranium.core.ApiError
import com.craniumiot.cranium.core.Boards
import com.craniumiot.cranium.core.Counts
import com.craniumiot.cranium.core.Deployment
import com.craniumiot.cranium.core.DeploymentSummary
import com.craniumiot.cranium.core.Device
import com.craniumiot.cranium.core.Execution
import com.craniumiot.cranium.core.ExecutionWords
import com.craniumiot.cranium.core.Glyph
import com.craniumiot.cranium.core.Tone
import com.craniumiot.cranium.core.Updates
import com.craniumiot.cranium.core.Words

/** The boards that wait for a person, among those of these deployments. */
private fun waitingForButton(devices: List<Device>, ids: Set<String>): Int =
    devices.count { it.online && it.ota?.state == "awaiting_user" && it.ota.job in ids }

/** How far the download is, where one board is downloading and so one number can say it. */
private fun onePercent(devices: List<Device>, ids: Set<String>, updating: Int): Int? {
    val moving = devices.filter { it.online && it.ota?.state == "downloading" && it.ota.job in ids }
    return if (updating == 1 && moving.size == 1) moving[0].ota?.progress else null
}

@Composable
fun DeploymentsScreen(vm: ConsoleViewModel, store: Store, now: Long) {
    val deployments = store.deployments.value
    val canWrite = store.me?.canWrite == true
    val firmware = store.firmware.value
    val deployable = firmware == null || firmware.releases.any { it.isActive }
    PageHead(
        "Deployments",
        lede = "A deployment sends one release to a set of boards. A board on firmware ${Updates.FIRST_WITH_NO_BUTTON} or newer " +
            "starts as soon as it sees it, and older firmware waits for someone to press Button 1 on the board. A job made " +
            "directly in AWS IoT is not listed here; its board’s page shows it.",
        tools = {
            Freshness(store.deployments.loadedAt, store.deployments.loading, vm.intervalOf(Route.Deployments), now, vm::refreshNow)
        },
    )
    if (canWrite) {
        Row(Modifier.padding(bottom = 16.dp)) {
            if (deployable) {
                ConsoleButton("New deployment", { vm.openDeploy(null) }, kind = ButtonKind.PRIMARY, glyph = Glyph.PLUS)
            } else {
                ConsoleButton("Upload firmware first", { vm.open(Route.Firmware) }, kind = ButtonKind.PRIMARY, glyph = Glyph.UPLOAD)
            }
        }
    }
    LoadProblem(store.deployments.error, "the deployments", deployments != null, store.deployments.loadedAt, now, vm::refreshNow)
    when {
        deployments == null -> if (store.deployments.error == null) Loading("deployments")
        deployments.isEmpty() -> Section {
            EmptyState(
                Glyph.SEND, "No deployments yet.",
                when {
                    !canWrite -> "When a release manager offers a release to boards, it appears here."
                    !deployable -> "Upload a signed image on the Firmware page first; then it can be offered to boards here."
                    else -> "Choose New deployment to offer a release to one or more boards."
                },
            )
        }
        else -> {
            DeploymentsPanel(deployments, store)
            Section {
                for (deployment in deployments) DeploymentRow(vm, deployment, store, now)
            }
        }
    }
}

/** Every board of every deployment, by how it went. */
@Composable
private fun DeploymentsPanel(deployments: List<DeploymentSummary>, store: Store) {
    val total = deployments.fold(Counts()) { sum, deployment -> sum + deployment.counts }
    val devices = store.deviceList.orEmpty()
    val ids = deployments.map { it.id }.toSet()
    val atButton = waitingForButton(devices, ids)
    val parts = Updates.describeCounts(total, atButton)
    val boards = parts.sumOf { it.count }
    val underWay = deployments.count(Updates::isUnderWay)
    val percent = onePercent(devices, ids, total.inProgress)
    InkPanel(Modifier.padding(bottom = 24.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(32.dp)) {
            for ((label, value) in listOf("Deployments" to deployments.size, "Under way" to underWay)) {
                Column(Modifier.semantics(mergeDescendants = true) {}) {
                    Eyebrow(label)
                    Text(value.toString(), style = ConsoleType.figure, color = console.ink)
                }
            }
        }
        Spacer(Modifier.height(16.dp))
        Eyebrow("Where each board’s update stands")
        Spacer(Modifier.height(8.dp))
        if (boards > 0) {
            if (boards > 1) Segments(parts, "${Words.plural(boards, "board update")}: ${Updates.countWords(total, atButton)}.")
            Spacer(Modifier.height(8.dp))
            CountList(parts, percent = percent)
        } else {
            Quiet("AWS IoT has not listed any board for these deployments yet.")
        }
    }
}

@Composable
private fun DeploymentRow(vm: ConsoleViewModel, deployment: DeploymentSummary, store: Store, now: Long) {
    val colors = console
    val summary = Updates.describeDeployment(deployment)
    val devices = store.deviceList.orEmpty()
    val own = setOf(deployment.id)
    val atButton = waitingForButton(devices, own)
    Column(
        Modifier
            .fillMaxWidth()
            .drawBehind { drawLine(colors.line, Offset(0f, 0f), Offset(size.width, 0f), 1.dp.toPx()) }
            .clickable(role = Role.Button, onClickLabel = "Open the deployment") { vm.open(Route.DeploymentPage(deployment.id)) }
            .padding(vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Wrap(Modifier.weight(1f)) {
                Mono(deployment.version ?: "Unknown version", style = ConsoleType.mono.copy(fontSize = 18.sp, fontWeight = FontWeight.Bold))
                Badge(summary)
            }
            GlyphIcon(Glyph.ARROW_RIGHT, tint = colors.ink3)
        }
        if (deployment.note.isNotEmpty()) Text(deployment.note, style = ConsoleType.small, color = colors.ink)
        Note("${startedBy(deployment, now)} · ${Words.plural(deployment.things.size, "board")}")
        if (deployment.things.size > 1) {
            Segments(Updates.describeCounts(deployment.counts, atButton), "Boards: ${Updates.countWords(deployment.counts, atButton)}.", thin = true)
        }
        CountList(Updates.describeCounts(deployment.counts, atButton), percent = onePercent(devices, own, deployment.counts.inProgress))
    }
}

// A deployment's page.

@Composable
fun DeploymentScreen(vm: ConsoleViewModel, store: Store, id: String, now: Long) {
    val resource = store.deploymentDetails[id] ?: Resource(loading = true)
    val deployment = resource.value
    val version = deployment?.version ?: Updates.versionOfDeployment(id)
    val missing = (resource.error as? ApiError)?.status == 404
    if (missing) {
        PageHead("Not found", eyebrow = "Deployment")
        Section {
            EmptyState(
                Glyph.SEND, "There is no deployment with this address.", "Check the address, or find it in the list of deployments.",
                action = "All deployments" to { vm.open(Route.Deployments) },
            )
        }
        return
    }
    val summary = deployment?.let { Updates.describeDeployment(it.summary) }
    val unfinished = deployment?.executions?.any { Updates.isUnfinished(it.status) } == true
    val withdrawn = unfinished && deployment.status == "CANCELED"
    val atWork = withdrawn && deployment.executions.any { it.status == "IN_PROGRESS" }
    val canWrite = store.me?.canWrite == true
    val revoked = revokedVersions(store)
    val boards = store.deviceList.orEmpty()
    val shortOfDone = deployment != null && !unfinished && !Updates.isUnderWay(deployment.summary) && deployment.executions.any { execution ->
        Updates.describeExecution(
            execution, board = boards.firstOrNull { it.thing == execution.thing }, deployment = id, version = deployment.version,
            unread = store.devices.value == null,
        ).retry
    }
    val offerAgain = shortOfDone && canWrite && store.firmware.value != null && deployment.version !in revoked
    // Who cancelled it is in the log, not in the deployment's record; the earliest such entry took it off the list.
    val cancelledBy = if (deployment?.status == "CANCELED") {
        store.audit.value?.entries?.lastOrNull { it.action == "deployment.cancel" && it.outcome == "ok" && it.target == id }
    } else {
        null
    }

    PageHead(
        title = version ?: "unknown version",
        eyebrow = "Deployment of",
        titleMono = true,
        lede = deployment?.summary?.note?.ifEmpty { null },
        meta = if (deployment != null) {
            {
                summary?.let { Badge(it) }
                Note(
                    startedBy(deployment.summary, now, exact = true) +
                        (deployment.summary.completedAt?.let { ", finished ${agoAt(it, now)}" } ?: ""),
                )
                if (cancelledBy != null) Note("Cancelled ${agoAt(cancelledBy.at, now)} by ${Words.nameOf(cancelledBy.actor)}")
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Mono(deployment.id, Modifier.weight(1f), style = ConsoleType.mono.copy(fontSize = 12.sp), color = console.ink2)
                    CopyButton(deployment.id, "the deployment ID", onCopied = { vm.notify(it) })
                }
            }
        } else {
            null
        },
        tools = { Freshness(resource.loadedAt, resource.loading, vm.intervalOf(Route.DeploymentPage(id)), now, vm::refreshNow) },
    )
    if (deployment != null && (canWrite && unfinished || offerAgain)) {
        Wrap(Modifier.padding(bottom = 16.dp)) {
            if (canWrite && unfinished) {
                ConsoleButton(
                    if (withdrawn) "Stop boards that have started" else "Cancel deployment", { vm.openCancel(id) },
                    kind = ButtonKind.DANGER_QUIET, glyph = Glyph.STOP,
                )
            }
            if (offerAgain) ConsoleButton("Offer again", { vm.openDeploy(deployment.version) }, glyph = Glyph.SEND)
        }
    }
    LoadProblem(resource.error, "this deployment", deployment != null, resource.loadedAt, now, vm::refreshNow)
    if (deployment == null) {
        if (resource.error == null) Loading("the deployment")
        return
    }
    if (store.devices.value == null) LoadProblem(store.devices.error, "the list of boards", false, 0, now, vm::refreshNow)
    if (withdrawn) {
        Notice(
            Tone.IDLE, Glyph.STOP,
            if (atWork) "This deployment was cancelled. A board that had already started carries on unless it is stopped."
            else "This deployment was cancelled. AWS takes a few seconds to withdraw the offer from every board.",
            Modifier.padding(bottom = 16.dp),
        )
    }
    val release = store.releases?.firstOrNull { it.version == deployment.version }
    val mark = release?.revoked
    if (release != null && mark != null) {
        val firstCancelled = cancelledBy?.at?.let { com.craniumiot.cranium.core.Times.parse(it) }
        val revokedAt = com.craniumiot.cranium.core.Times.parse(mark.at)
        val byHandFirst = firstCancelled != null && revokedAt != null && firstCancelled < revokedAt
        Notice(
            Tone.IDLE, Glyph.BAN,
            "${release.version} was revoked ${Words.timeAgo(mark.at, now)} by ${Words.nameOf(mark.by)}" +
                (if (mark.reason.isNotEmpty()) ": ${Words.sentence(mark.reason)}" else ".") +
                if (deployment.status != "CANCELED" || byHandFirst) "" else " Revoking cancels every open deployment of a release.",
            Modifier.padding(bottom = 16.dp),
            action = { ConsoleButton("Firmware", { vm.open(Route.Firmware) }, small = true, glyph = Glyph.ARROW_RIGHT) },
        )
    }
    if (deployment.executions.isEmpty()) {
        Section { Quiet("AWS IoT has not listed any board for this deployment yet.") }
        return
    }
    if (deployment.executions.size > 1) {
        val parts = Updates.describeCounts(deployment.summary.counts)
        Segments(parts, "Boards: ${Updates.countWords(deployment.summary.counts)}.", thin = true)
        CountList(parts, Modifier.padding(top = 8.dp, bottom = 16.dp))
    }
    for (execution in deployment.executions) ExecutionCard(vm, execution, deployment, store, now, deployment.executions.size)
}

/** A board's own history says how a cancelled deployment ended, when it was read after the board got there. */
private fun historyOf(execution: Execution, store: Store): Pair<List<com.craniumiot.cranium.core.ExecutionSummary>?, Boolean> {
    val detail = store.deviceDetails[execution.thing]?.value ?: return null to false
    if (detail.device.fw?.version != execution.reported) return null to false
    return detail.executions to (detail.olderExecutions > 0)
}

@Composable
private fun ExecutionPresence(execution: Execution, known: Device?, unread: Boolean) {
    val restarting = execution.phase == "rebooting" || (known != null && Updates.isRestarting(known))
    when {
        unread && execution.status == "CANCELED" && execution.startedAt != null -> Badge(Tone.IDLE, Glyph.CLOCK, "Not known yet")
        execution.online && restarting -> Badge(Tone.IDLE, Glyph.RESTART, "Restarting")
        execution.online -> Badge(Tone.GOOD, Glyph.ONLINE, "Online")
        known != null && known.lastSeen == null -> Badge(Tone.IDLE, Glyph.MINUS_CIRCLE, "Never connected")
        else -> Badge(Tone.IDLE, Glyph.OFFLINE, "Offline")
    }
}

/** One board's part in a deployment: what it is doing, in words and as steps. */
@Composable
private fun ExecutionCard(vm: ConsoleViewModel, execution: Execution, deployment: Deployment, store: Store, now: Long, boards: Int) {
    val colors = console
    val known = store.deviceList?.firstOrNull { it.thing == execution.thing }
    val unread = store.devices.value == null
    val board = known ?: store.deviceDetails[execution.thing]?.value?.device ?: Boards.of(execution.thing, null)
    val (history, historyCut) = historyOf(execution, store)
    val words = Updates.describeExecution(
        execution, board = known, deployment = deployment.id, version = deployment.version, history = history,
        historyCut = historyCut, unread = unread,
    )
    val target = deployment.version ?: Updates.versionOfDeployment(deployment.id)
    val finished = !Updates.isUnfinished(execution.status)
    val compact = boards > 1 && (boards > 3 || words.tone !in setOf(Tone.ACT, Tone.LIVE, Tone.BAD))
    val offerable = deployment.version !in revokedVersions(store)
    val next = words.next?.takeIf { store.me?.canWrite == true && (offerable || !words.retry) }
    val moments = listOfNotNull(
        execution.queuedAt?.let { agoAt(it, now, "Offered ") },
        execution.startedAt?.let { agoAt(it, now, "Started ") },
        if (finished && words.tone != Tone.LIVE && execution.lastUpdatedAt != null) agoAt(execution.lastUpdatedAt, now, "Ended ") else null,
        if (execution.status == "IN_PROGRESS" && execution.secondsLeft != null) "Times out in ${Words.duration(execution.secondsLeft)}" else null,
        if (finished && execution.ranAtEnd == null && execution.reported == null && known?.fw != null) {
            "${if (known.online) "Board now reports" else "Board last reported"} ${known.fw.version}"
        } else {
            null
        },
        if (!execution.online && known?.lastSeen != null) "Board last seen ${Words.timeAgo(known.lastSeen, now)}" else null,
    )
    val panel: @Composable () -> Unit = {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.Top) {
                BoardName(board, Modifier.weight(1f))
                ExecutionPresence(execution, known, unread)
            }
            Row(
                Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                GlyphIcon(words.glyph, size = 22.dp, tint = console.toneInk(words.tone))
                Text(words.said ?: words.title, style = ConsoleType.sectionTitle, color = console.ink)
                if (words.progress != null) Text("${words.progress}%", style = ConsoleType.figure.copy(fontSize = 28.sp), color = console.toneInk(words.tone))
            }
            Text(prose(words.text), style = ConsoleType.small, color = console.ink2)
            if (next != null) Text(next, style = ConsoleType.small.copy(fontWeight = FontWeight.SemiBold), color = console.ink)
            words.installedBy?.let { other -> MoreLink("Open the deployment that installed it") { vm.open(Route.DeploymentPage(other)) } }
            words.code?.let { Note("The board gave the reason $it") }
            execution.detail?.let { Note("Board’s note: $it") }
            if (words.progress != null) Meter(words.progress, "Download on ${Boards.name(board)}")
            if (words.tone == Tone.ACT) ButtonKeys()
            ReturnPath(execution, words)
            StepList(words, compact = compact, viewer = store.me?.canWrite != true)
            if (!compact) ExecutionFlash(execution, known, target, words, deployment.id)
            if (moments.isNotEmpty()) {
                if (!compact) Eyebrow("What happened when")
                for (moment in moments) Note(moment)
            }
        }
    }
    // An update that is moving, waiting for a person or stopped short gets the ink panel; the rest a plain section.
    if (!compact && words.tone in setOf(Tone.ACT, Tone.LIVE, Tone.BAD, Tone.WAIT, Tone.WARN)) {
        InkPanel(Modifier.padding(bottom = 16.dp)) { panel() }
    } else {
        Section { panel() }
    }
}

/** The way back when an update stops: where it stopped, and what the board runs. */
@Composable
private fun ReturnPath(execution: Execution, words: ExecutionWords) {
    val at = words.steps.indexOfFirst { it.state == com.craniumiot.cranium.core.StepState.FAILED }
    if (at < 1) return
    val ran = execution.ranAtEnd
    val text = when (execution.phase) {
        "rolled_back" -> "It went back to the previous firmware" + (ran?.let { ": $it" } ?: "")
        "declined", "refused" -> "Nothing was installed" + (ran?.let { ". It stayed on $it" } ?: "")
        else -> "It stayed on the firmware it had" + (ran?.let { ": $it" } ?: "")
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        GlyphIcon(Glyph.UNDO, tint = console.toneInk(words.tone))
        Text(prose(text), style = ConsoleType.small, color = console.ink)
    }
}

private const val FLASH_NOW = "Flash memory now"
private const val FLASH_ENDED = "Flash memory when this update ended"
private const val FLASH_SEEN = "Flash memory when last seen"

/** What each slot holds at this point of an update, told from the phase the board last reported. */
@Composable
private fun ExecutionFlash(execution: Execution, known: Device?, target: String?, words: ExecutionWords, deployment: String) {
    val online = execution.online
    val flashNow = if (online) FLASH_NOW else FLASH_SEEN
    val latest = execution.reported ?: known?.fw?.version
    val previous = latest?.takeIf { it != target }
    val stays = FlashSlot(latest, "Version not reported", if (online) "Runs from here, not touched" else "Ran from here, not touched", Tone.IDLE)
    val old = FlashSlot(previous, "Previous firmware", "Kept to fall back on")
    fun atWork(state: String, was: String, glyph: Glyph) = if (online) Triple(state, Tone.LIVE, glyph) else Triple(was, Tone.IDLE, null)
    val ranFromHere = FlashSlot(execution.ranAtEnd, "Previous firmware", "Ran from here, not touched")
    val stayed = FlashSlot(null, "Previous firmware", "Stayed in place")

    @Composable
    fun restarting() {
        val (s1, t1, g1) = atWork("Being replaced", "Was being replaced", Glyph.RESTART)
        val (s2, t2, g2) = atWork("Bootloader checks the signature", "Was with the bootloader", Glyph.SHIELD)
        FlashMap(flashNow, stays.copy(state = s1, tone = t1, glyph = g1), FlashSlot(target, state = s2, tone = t2, glyph = g2), swapping = online)
    }

    @Composable
    fun onTrial() {
        val (s, t, g) = atWork("Runs on trial", "Was on trial", Glyph.PULSE)
        FlashMap(flashNow, FlashSlot(target, state = s, tone = t, glyph = g), old)
    }

    when (execution.phase) {
        "waiting_for_device", "starting" -> FlashMap(flashNow, stays, FlashSlot(state = "Nothing written yet"))
        "waiting_for_button" -> FlashMap(flashNow, stays, FlashSlot(state = "Nothing is written until Button 1 is pressed"))
        "downloading" -> {
            val (s, t, g) = atWork("Receiving the image", "Was receiving the image", Glyph.DOWNLOAD)
            FlashMap(flashNow, stays, FlashSlot(target, state = s, tone = t, glyph = g, receiving = if (online) execution.progress ?: 0 else null))
        }
        "verifying" -> {
            val (s, t, g) = atWork("Written, being checked", "Was being checked", Glyph.SHIELD)
            FlashMap(flashNow, stays, FlashSlot(target, state = s, tone = t, glyph = g))
        }
        "rebooting" -> restarting()
        "testing" -> onTrial()
        "succeeded" -> FlashMap(
            FLASH_ENDED, FlashSlot(execution.ranAtEnd ?: target, state = "Ran from here, confirmed", tone = Tone.GOOD, glyph = Glyph.CHECK),
            FlashSlot(null, "Previous firmware", "No longer needed"),
        )
        "rolled_back" -> FlashMap(
            FLASH_ENDED, ranFromHere.copy(state = "Put back by the bootloader", tone = Tone.GOOD, glyph = Glyph.UNDO),
            FlashSlot(target, state = "Started but never confirmed", tone = Tone.BAD, glyph = Glyph.X_CIRCLE),
        )
        "declined", "refused" -> FlashMap(FLASH_ENDED, ranFromHere, FlashSlot(state = "Nothing written"))
        "failed" -> FlashMap(FLASH_ENDED, ranFromHere, FlashSlot(target, state = "Not installed", tone = Tone.BAD, glyph = Glyph.X_CIRCLE))
        "cancelled" -> {
            val reached = if (known?.ota?.job == deployment) known.ota.state else null
            when {
                execution.startedAt == null -> FlashMap(FLASH_ENDED, stayed, FlashSlot(state = "Nothing written"))
                words.installed -> FlashMap(
                    flashNow,
                    FlashSlot(target, state = if (online) "Runs from here, confirmed" else "Ran from here, confirmed", tone = Tone.GOOD, glyph = Glyph.CHECK),
                    FlashSlot(null, "Previous firmware", "No longer needed"),
                )
                reached == "rebooting" -> restarting()
                reached == "testing" -> onTrial()
                words.unsure -> FlashMap(
                    flashNow, stays.copy(state = if (online) "What the board reports" else "What the board last reported"),
                    FlashSlot(null, "Not reported by the board", "How this update ended is not known"),
                    note = "A board that AWS has cancelled cannot report the end of that update.",
                )
                else -> FlashMap(FLASH_ENDED, stayed, FlashSlot(target, state = "Not installed"))
            }
        }
        else -> Unit
    }
}
