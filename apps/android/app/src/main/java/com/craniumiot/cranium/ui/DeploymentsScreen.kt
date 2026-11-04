package com.craniumiot.cranium.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.craniumiot.cranium.core.ApiError
import com.craniumiot.cranium.core.Boards
import com.craniumiot.cranium.core.Deployment
import com.craniumiot.cranium.core.DeploymentSummary
import com.craniumiot.cranium.core.Device
import com.craniumiot.cranium.core.Execution
import com.craniumiot.cranium.core.ExecutionWords
import com.craniumiot.cranium.core.Glyph
import com.craniumiot.cranium.core.Times
import com.craniumiot.cranium.core.Tone
import com.craniumiot.cranium.core.Updates
import com.craniumiot.cranium.core.Words

/** "Started 3 min ago by someone@example.com". */
fun startedBy(deployment: DeploymentSummary, now: Long, exact: Boolean = false): String =
    "Started ${if (exact) agoAt(deployment.createdAt, now) else Words.timeAgo(deployment.createdAt, now)}" +
        (deployment.createdBy?.let { " by ${Words.nameOf(it)}" } ?: "")

/** The two buttons on the board, while it waits for a person. */
@Composable
fun ButtonKeys() {
    Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        StatusLine(Tone.ACT, Glyph.PRESS, "Button 1 installs")
        StatusLine(Tone.IDLE, Glyph.MINUS_CIRCLE, "Button 2 declines", quiet = true)
    }
}

@Composable
fun DeploymentsScreen(vm: ConsoleViewModel, store: Store, now: Long) {
    val deployments = store.deployments.value
    val canWrite = store.me?.canWrite == true
    val deployable = store.firmware.value?.releases?.any { it.isActive } != false
    val underWay = deployments.orEmpty().count(Updates::isUnderWay)
    ConsoleScreen(
        title = "Deployments",
        subtitle = if (deployments != null && underWay > 0) "${Words.plural(underWay, "deployment")} under way" else null,
        help = "deployments",
        primary = if (canWrite && deployable) ScreenAction("New deployment", Glyph.PLUS) { vm.openDeploy(null) } else null,
        stale = staleOf(listOf(store.deployments), vm.intervalOf(Route.Deployments), now, vm::refreshNow),
        onRefresh = { vm.refresh(Route.Deployments, full = true) },
    ) {
        problem(store.deployments.error, "the deployments", deployments != null, vm::refreshNow)
        when {
            deployments == null -> if (store.deployments.error == null) loading("deployments")
            deployments.isEmpty() -> item(key = "none") {
                OneLine(
                    "No deployments yet.",
                    if (canWrite && !deployable) "Upload firmware" to { vm.open(Route.Upload) } else null,
                )
            }
            else -> for (deployment in deployments) {
                item(key = deployment.id) {
                    val summary = Updates.describeDeployment(deployment)
                    ListRow(
                        deployment.version ?: "Unknown version",
                        mono = true,
                        supporting = "${Words.plural(deployment.things.size, "board")} · ${startedBy(deployment, now)}",
                        leading = { StateDot(summary.tone) },
                        trailingText = summary.label,
                        onClick = { vm.open(Route.DeploymentPage(deployment.id)) },
                    )
                }
            }
        }
    }
}

// A deployment's page: who started it, and one row per board.

@Composable
fun DeploymentScreen(vm: ConsoleViewModel, store: Store, id: String, now: Long) {
    val resource = store.deploymentDetails[id] ?: Resource(loading = true)
    val deployment = resource.value
    val version = deployment?.version ?: Updates.versionOfDeployment(id)
    val missing = (resource.error as? ApiError)?.status == 404
    val canWrite = store.me?.canWrite == true
    val context = LocalContext.current
    val unfinished = deployment?.executions?.any { Updates.isUnfinished(it.status) } == true
    val withdrawn = unfinished && deployment.status == "CANCELED"
    val boards = store.deviceList.orEmpty()
    val offerAgain = deployment != null && canWrite && !unfinished && !Updates.isUnderWay(deployment.summary) &&
        store.firmware.value != null && deployment.version !in revokedVersions(store) &&
        deployment.executions.any { execution ->
            Updates.describeExecution(
                execution, board = boards.firstOrNull { it.thing == execution.thing }, deployment = id, version = deployment.version,
                unread = store.devices.value == null,
            ).retry
        }
    val cancelledBy = if (deployment?.status == "CANCELED") {
        store.audit.value?.entries?.lastOrNull { it.action == "deployment.cancel" && it.outcome == "ok" && it.target == id }
    } else {
        null
    }
    ConsoleScreen(
        title = version ?: "Deployment",
        titleMono = version != null,
        subtitle = "Deployment",
        help = "wifi-update",
        primary = if (offerAgain) ScreenAction("Offer again", Glyph.SEND) { vm.openDeploy(deployment.version) } else null,
        actions = listOfNotNull(
            ScreenAction("Copy the deployment ID", Glyph.COPY) {
                copyToClipboard(context, id, "the deployment ID", sensitive = false)
                vm.notify("Copied the deployment ID.")
            },
            if (canWrite && unfinished) {
                ScreenAction(if (withdrawn) "Stop boards that have started" else "Cancel deployment", Glyph.STOP, danger = true) { vm.openCancel(id) }
            } else {
                null
            },
        ),
        stale = staleOf(listOf(resource), vm.intervalOf(Route.DeploymentPage(id)), now, vm::refreshNow),
        onRefresh = { vm.refresh(Route.DeploymentPage(id), full = true) },
    ) {
        if (missing) {
            item(key = "missing") { OneLine("There is no deployment with this address.", "All deployments" to { vm.open(Route.Deployments) }) }
            return@ConsoleScreen
        }
        problem(resource.error, "this deployment", deployment != null, vm::refreshNow)
        if (deployment == null) {
            if (resource.error == null) loading("the deployment")
            return@ConsoleScreen
        }
        val summary = Updates.describeDeployment(deployment.summary)
        block("head") {
            Wrap { Badge(summary) }
            Text(
                startedBy(deployment.summary, now, exact = true) +
                    (deployment.summary.completedAt?.let { ", finished ${agoAt(it, now)}" } ?: ""),
                style = ConsoleType.small, color = console.ink2,
            )
            if (cancelledBy != null) Text("Cancelled ${agoAt(cancelledBy.at, now)} by ${Words.nameOf(cancelledBy.actor)}", style = ConsoleType.small, color = console.ink2)
            if (deployment.summary.note.isNotEmpty()) Text(deployment.summary.note, style = ConsoleType.body, color = console.ink)
        }
        if (withdrawn) {
            val atWork = deployment.executions.any { it.status == "IN_PROGRESS" }
            item(key = "withdrawn") {
                OneLine(
                    if (atWork) "Cancelled. A board that had already started carries on unless it is stopped."
                    else "Cancelled. AWS takes a few seconds to withdraw the offer from every board.",
                    glyph = Glyph.STOP,
                )
            }
        }
        store.releases?.firstOrNull { it.version == deployment.version }?.revoked?.let { mark ->
            item(key = "revoked") {
                OneLine(
                    "${deployment.version} was revoked ${Words.timeAgo(mark.at, now)}" + (mark.reason.takeIf { it.isNotEmpty() }?.let { ": $it" } ?: "."),
                    "Release" to { vm.open(Route.Release(deployment.version ?: "")) }, Tone.IDLE, Glyph.BAN,
                )
            }
        }
        if (store.devices.value == null && store.devices.error != null) problem(store.devices.error, "the list of boards", false, vm::refreshNow)
        header("Boards")
        if (deployment.executions.isEmpty()) {
            item(key = "none") { OneLine("AWS IoT has not listed any board for this deployment yet.") }
            return@ConsoleScreen
        }
        if (deployment.executions.size > 1) {
            block("counts") {
                val parts = Updates.describeCounts(deployment.summary.counts)
                Segments(parts, "Boards: ${Updates.countWords(deployment.summary.counts)}.", thin = true)
            }
        }
        for (execution in deployment.executions) {
            item(key = execution.thing) {
                val words = wordsOf(execution, deployment, store)
                val board = Boards.of(execution.thing, store.deviceList)
                ListRow(
                    Boards.name(board),
                    supporting = (words.said ?: words.title),
                    leading = { StateDot(words.tone) },
                    trailingText = words.progress?.let { "$it%" },
                    onClick = { vm.open(Route.ExecutionPage(id, execution.thing)) },
                )
            }
        }
    }
}

/** What a board is doing in a deployment, with everything that is known of it. */
private fun wordsOf(execution: Execution, deployment: Deployment, store: Store): ExecutionWords {
    val (history, historyCut) = historyOf(execution, store)
    return Updates.describeExecution(
        execution, board = store.deviceList?.firstOrNull { it.thing == execution.thing }, deployment = deployment.id,
        version = deployment.version, history = history, historyCut = historyCut, unread = store.devices.value == null,
    )
}

// One board's part in a deployment: its steps, its flash, and what happened when.

@Composable
fun ExecutionScreen(vm: ConsoleViewModel, store: Store, id: String, thing: String, now: Long) {
    val resource = store.deploymentDetails[id] ?: Resource(loading = true)
    val deployment = resource.value
    val execution = deployment?.executions?.firstOrNull { it.thing == thing }
    val known = store.deviceList?.firstOrNull { it.thing == thing }
    val board = known ?: store.deviceDetails[thing]?.value?.device ?: Boards.of(thing, null)
    val route = Route.ExecutionPage(id, thing)
    ConsoleScreen(
        title = Boards.name(board),
        titleMono = !Boards.hasOwnName(board),
        subtitle = "Deployment of ${deployment?.version ?: Updates.versionOfDeployment(id) ?: "an update"}",
        help = "wifi-update",
        actions = listOf(ScreenAction("Open the board", Glyph.CHIP) { vm.open(Route.Board(thing)) }),
        stale = staleOf(listOf(resource), vm.intervalOf(route), now, vm::refreshNow),
        onRefresh = { vm.refresh(route, full = true) },
    ) {
        problem(resource.error, "this deployment", deployment != null, vm::refreshNow)
        if (deployment == null || execution == null) {
            if (resource.error == null) loading("the board's update")
            return@ConsoleScreen
        }
        val words = wordsOf(execution, deployment, store)
        val target = deployment.version ?: Updates.versionOfDeployment(deployment.id)
        val finished = !Updates.isUnfinished(execution.status)
        val next = words.next?.takeIf { store.me?.canWrite == true && (deployment.version !in revokedVersions(store) || !words.retry) }
        block("state") {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    ExecutionPresence(execution, known, store.devices.value == null)
                }
                Row(
                    Modifier.semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    GlyphIcon(words.glyph, size = 22.dp, tint = console.toneInk(words.tone))
                    Text(words.said ?: words.title, style = ConsoleType.sectionTitle, color = console.ink)
                    words.progress?.let { Text("$it%", style = ConsoleType.figure.copy(fontSize = 26.sp), color = console.toneInk(words.tone)) }
                }
                Text(prose(words.text), style = ConsoleType.small, color = console.ink2)
                if (next != null) Text(next, style = ConsoleType.small.copy(fontWeight = FontWeight.SemiBold), color = console.ink)
                words.installedBy?.let { other -> MoreLink("Open the deployment that installed it") { vm.open(Route.DeploymentPage(other)) } }
                words.code?.let { Note("The board gave the reason $it") }
                execution.detail?.let { Note("Board’s note: $it") }
                if (words.progress != null) Meter(words.progress, "Download on ${Boards.name(board)}")
                if (words.tone == Tone.ACT) ButtonKeys()
                ReturnPath(execution, words)
            }
        }
        header("Steps")
        block("steps") { StepList(words, viewer = store.me?.canWrite != true) }
        header("Flash memory")
        block("flash") { ExecutionFlash(execution, known, target, words, deployment.id) }
        header("What happened when")
        execution.queuedAt?.let { item(key = "offered") { ValueRow("Offered", agoAt(it, now)) } }
        execution.startedAt?.let { item(key = "started") { ValueRow("Started", agoAt(it, now)) } }
        if (finished && words.tone != Tone.LIVE && execution.lastUpdatedAt != null) {
            item(key = "ended") { ValueRow("Ended", agoAt(execution.lastUpdatedAt, now)) }
        }
        if (execution.status == "IN_PROGRESS" && execution.secondsLeft != null) {
            item(key = "timeout") { ValueRow("Times out in", Words.duration(execution.secondsLeft)) }
        }
        if (finished && execution.ranAtEnd == null && execution.reported == null && known?.fw != null) {
            item(key = "reports") { ValueRow(if (known.online) "Board now reports" else "Board last reported", known.fw.version, mono = true) }
        }
        if (!execution.online && known?.lastSeen != null) {
            item(key = "seen") { ValueRow("Board last seen", Words.timeAgo(known.lastSeen, now)) }
        }
    }
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
