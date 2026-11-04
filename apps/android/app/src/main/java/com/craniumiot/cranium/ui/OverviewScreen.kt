package com.craniumiot.cranium.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import com.craniumiot.cranium.core.AuditText
import com.craniumiot.cranium.core.Boards
import com.craniumiot.cranium.core.DeploymentSummary
import com.craniumiot.cranium.core.Device
import com.craniumiot.cranium.core.Glyph
import com.craniumiot.cranium.core.Tone
import com.craniumiot.cranium.core.Updates
import com.craniumiot.cranium.core.Words

/** A compact summary: updates in progress, the fleet, the newest release, and what happened last. */
@Composable
fun OverviewScreen(vm: ConsoleViewModel, store: Store, now: Long) {
    val devices = store.deviceList
    val firmware = store.firmware.value
    val deployments = store.deployments.value
    val newest = firmware?.releases?.firstOrNull { it.isActive }
    val active = deployments.orEmpty().filter { Updates.isUnderWay(it) || Updates.stillFinishing(it, devices, now) }
    val lastDone = deployments.orEmpty().firstOrNull { it !in active }
    val loaded = devices != null && firmware != null && deployments != null
    val blank = loaded && devices.isNullOrEmpty() && firmware.releases.isEmpty() && deployments.isNullOrEmpty()
    val resources = listOf(store.devices, store.firmware, store.deployments)
    val failed = resources.firstOrNull { it.error != null && it.value == null }

    ConsoleScreen(
        title = "Overview",
        help = "overview",
        stale = staleOf(resources, vm.intervalOf(Route.Overview), now, vm::refreshNow),
        onRefresh = { vm.refresh(Route.Overview, full = true) },
    ) {
        if (failed != null) {
            item(key = "failed") { OneLine("Could not load this page. ${messageOf(failed.error)}", "Try again" to vm::refreshNow, Tone.BAD, Glyph.ALERT) }
        }
        val open = store.releases.orEmpty().filter { Updates.revocationState(it) == Updates.RevocationState.INCOMPLETE }
        if (open.isNotEmpty()) {
            item(key = "revocation") {
                OneLine(
                    "Revocation incomplete: ${open.joinToString(", ") { it.version }}.",
                    "Open" to { vm.open(Route.Release(open.first().version)) }, Tone.WARN, Glyph.ALERT,
                )
            }
        }
        if (!loaded) {
            if (failed == null) loading("the overview")
            return@ConsoleScreen
        }
        if (blank) {
            gettingStarted(vm, store)
            return@ConsoleScreen
        }

        header("Updates")
        if (active.isEmpty()) {
            item(key = "calm") { Calm(vm, store, lastDone, devices.orEmpty(), now) }
        } else {
            for (deployment in active) item(key = "run-${deployment.id}") { ActiveRow(vm, store, deployment) }
        }

        header("Fleet")
        item(key = "online") {
            val counted = boardsCounted(devices.orEmpty())
            ValueRow(
                "Boards online", "${counted.online} of ${devices.orEmpty().size}",
                supporting = listOfNotNull(
                    if (counted.quiet > 0) "${counted.quiet} offline" else null,
                    if (counted.never > 0) "${counted.never} never connected" else null,
                ).joinToString(" · ").ifEmpty { null },
                onClick = { vm.open(Route.Boards) },
            )
        }
        if (newest != null) {
            item(key = "newest") {
                val on = devices.orEmpty().count { it.fw?.version == newest.version }
                ValueRow(
                    "Newest release", newest.version, mono = true,
                    supporting = "${Words.plural(on, "board")} on it · uploaded ${Words.timeAgo(newest.uploadedAt, now)}",
                    onClick = { vm.open(Route.Release(newest.version)) },
                )
            }
        } else if (firmware.releases.isNotEmpty()) {
            item(key = "newest") { ValueRow("Newest release", "None can be deployed", onClick = { vm.open(Route.Firmware) }) }
        }
        val strangers = offList(devices, store.releases)
        if (strangers.isNotEmpty()) {
            item(key = "strangers") {
                ListRow(
                    "${Words.plural(strangers.size, "board runs", "boards run")} unregistered firmware",
                    supporting = strangers.joinToString(", ") { "${Boards.name(it)} (${it.fw?.version})" },
                    leading = { GlyphIcon(Glyph.ALERT, tint = console.warn) },
                    onClick = { vm.open(Route.Boards) },
                )
            }
        }

        header("Recent")
        val recent = store.recent.value?.entries
        when {
            recent == null -> if (store.recent.error == null) loading("activity")
            recent.isEmpty() -> item(key = "recent-none") { OneLine("Nothing recorded yet.") }
            else -> for (entry in recent.take(5)) {
                item(key = "recent-${entry.at}-${entry.requestId}") { ActivityRow(vm, entry, now, compact = true) }
            }
        }
        item(key = "all-activity") { ListRow("All activity", onClick = { vm.open(Route.Activity) }) }
    }
}

/** The first steps with a new console, ticked off as they are done. */
private fun androidx.compose.foundation.lazy.LazyListScope.gettingStarted(vm: ConsoleViewModel, store: Store) {
    header("Getting started")
    val canWrite = store.me?.canWrite == true
    val steps = listOf(
        Triple("Register a board", "python3 tools/provision_device.py, with the board on USB", !store.deviceList.isNullOrEmpty()),
        Triple("Upload a signed image", if (canWrite) "On the Firmware page" else "A release manager uploads one", !store.releases.isNullOrEmpty()),
        Triple("Deploy it", if (canWrite) "From the release's page" else "A release manager deploys it", !store.deployments.value.isNullOrEmpty()),
    )
    steps.forEachIndexed { index, (title, text, done) ->
        item(key = "step-$index") {
            ListRow(
                title + if (done) " (done)" else "",
                supporting = if (done) null else text,
                leading = {
                    Box(Modifier.size(24.dp).clip(CircleShape).background(if (done) console.ink else console.well), contentAlignment = Alignment.Center) {
                        if (done) GlyphIcon(Glyph.CHECK, size = 14.dp, tint = console.paper)
                    }
                },
                onClick = if (!done && index == 1 && canWrite) ({ vm.open(Route.Upload) }) else null,
            )
        }
    }
    item(key = "help") { ListRow("How updates work", onClick = { vm.open(Route.HelpPage("getting-started")) }) }
}

/** No update under way: how the last one ended, in one row. */
@Composable
private fun Calm(vm: ConsoleViewModel, store: Store, lastDone: DeploymentSummary?, devices: List<Device>, now: Long) {
    val work = devices.count { it.ota != null && it.ota.state != "idle" }
    if (lastDone == null) {
        ListRow(
            if (work > 0) "${Words.plural(work, "board reports", "boards report")} an update in progress" else "No update in progress",
            supporting = "No deployment yet",
            leading = { StateDot(Tone.IDLE) },
        )
        return
    }
    val ending = Updates.describeDeployment(lastDone, devices)
    val standing = if (ending.tone == Tone.GOOD) Updates.installStanding(lastDone, devices) else null
    val headline = when {
        work > 0 -> "${Words.plural(work, "board reports", "boards report")} an update in progress"
        standing?.state == Updates.Standing.MOVED -> "No update in progress"
        ending.said != null -> ending.said
        else -> "No update in progress"
    }
    ListRow(
        headline,
        supporting = "Last: ${lastDone.version ?: lastDone.id} · ${ending.label} · " +
            (lastDone.completedAt?.let { Words.timeAgo(it, now) } ?: "started ${Words.timeAgo(lastDone.createdAt, now)}"),
        leading = { StateDot(ending.tone) },
        onClick = { vm.open(Route.DeploymentPage(lastDone.id)) },
    )
}

/** A deployment under way: its version, and where its boards are. */
@Composable
private fun ActiveRow(vm: ConsoleViewModel, store: Store, deployment: DeploymentSummary) {
    val detail = store.deploymentDetails[deployment.id]?.value
    val single = detail?.executions?.singleOrNull()
    val words = single?.let {
        Updates.describeExecution(
            it, board = store.deviceList?.firstOrNull { d -> d.thing == it.thing }, deployment = deployment.id,
            version = deployment.version, unread = store.devices.value == null,
        )
    }
    val summary = Updates.describeDeployment(deployment)
    ListRow(
        "Deployment of ${deployment.version ?: "an update"}",
        supporting = if (single != null && words != null) {
            "${Boards.name(Boards.of(single.thing, store.deviceList))}: ${words.said ?: words.title}"
        } else {
            Updates.countWords(deployment.counts)
        },
        leading = { StateDot(words?.tone ?: summary.tone) },
        trailingText = words?.progress?.let { "$it%" },
        onClick = { vm.open(Route.DeploymentPage(deployment.id)) },
    )
}

/** One entry of the activity log as a row; the short form is for the overview. */
@Composable
fun ActivityRow(vm: ConsoleViewModel, entry: com.craniumiot.cranium.core.AuditEntry, now: Long, compact: Boolean) {
    val words = AuditText.describe(entry)
    val tone = words.outcome?.tone
    ListRow(
        AuditText.sentence(entry),
        supporting = listOfNotNull(
            if (compact) Words.timeAgo(entry.at, now) else Words.timeOfDay(entry.at),
            words.outcome?.label,
            if (words.scripted) AuditText.SCRIPTED_TAG else null,
        ).joinToString(" · "),
        leading = {
            Box(Modifier.size(32.dp).clip(CircleShape).background(if (tone != null) console.toneWash(tone) else console.well), contentAlignment = Alignment.Center) {
                GlyphIcon(words.glyph, size = 16.dp, tint = if (tone != null) console.toneInk(tone) else console.ink2)
            }
        },
        onClick = { vm.open(Route.ActivityEntry(activityKey(entry))) },
    )
}

/** How an entry of the log is found again: its time and its request (core Search uses the same). */
fun activityKey(entry: com.craniumiot.cranium.core.AuditEntry): String = "${entry.at.orEmpty()}#${entry.requestId}"
