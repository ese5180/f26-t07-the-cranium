package com.craniumiot.cranium.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.craniumiot.cranium.core.ApiError
import com.craniumiot.cranium.core.ApiJson
import com.craniumiot.cranium.core.BoardLog
import com.craniumiot.cranium.core.Boards
import com.craniumiot.cranium.core.Device
import com.craniumiot.cranium.core.DeviceDetail
import com.craniumiot.cranium.core.Glyph
import com.craniumiot.cranium.core.Telemetry
import com.craniumiot.cranium.core.Times
import com.craniumiot.cranium.core.Tone
import com.craniumiot.cranium.core.UpdateWatch
import com.craniumiot.cranium.core.Updates
import com.craniumiot.cranium.core.Words

/** The tone of a board's dot: online, restarting, or quiet. */
private fun presenceTone(device: Device): Tone = when {
    Updates.isRestarting(device) -> Tone.LIVE
    device.online -> Tone.GOOD
    else -> Tone.IDLE
}

private fun presenceWord(device: Device): String = when {
    Updates.isRestarting(device) -> "Restarting"
    device.online -> "Online"
    device.lastSeen == null -> "Never connected"
    else -> "Offline"
}

@Composable
fun BoardsScreen(vm: ConsoleViewModel, store: Store, now: Long) {
    val devices = store.deviceList
    val counted = devices?.let(::boardsCounted)
    ConsoleScreen(
        title = "Boards",
        subtitle = if (devices != null && devices.isNotEmpty()) "${counted?.online} of ${devices.size} online" else null,
        help = "boards-and-diagnostics",
        stale = staleOf(listOf(store.devices), vm.intervalOf(Route.Boards), now, vm::refreshNow),
        onRefresh = { vm.refresh(Route.Boards, full = true) },
    ) {
        problem(store.devices.error, "the boards", devices != null, vm::refreshNow)
        when {
            devices == null -> if (store.devices.error == null) loading("boards")
            devices.isEmpty() -> item(key = "none") { OneLine("No boards are registered yet.", "How" to { vm.open(Route.HelpPage("getting-started")) }) }
            else -> for (device in devices) {
                item(key = device.thing) {
                    val update = Updates.describeUpdate(device)
                    val working = device.ota != null && device.ota.state != "idle"
                    ListRow(
                        Boards.name(device),
                        supporting = listOfNotNull(
                            if (Boards.hasOwnName(device)) device.thing else null,
                            device.fw?.let { it.version + if (it.confirmed) "" else ", on trial" } ?: "Firmware not reported",
                            if (working) update.label + (update.progress?.let { " $it%" } ?: "") else null,
                        ).joinToString(" · "),
                        leading = { StateDot(presenceTone(device)) },
                        trailing = {
                            Words.signalQuality(device.rssi)?.let { SignalBars(it.bars, old = !device.online) }
                        },
                        onClick = { vm.open(Route.Board(device.thing)) },
                    )
                }
            }
        }
    }
}

// A board's page: a header, the update while there is one, and the rest a tap away.

@Composable
fun BoardScreen(vm: ConsoleViewModel, store: Store, thing: String, now: Long) {
    val resource = store.deviceDetails[thing] ?: Resource(loading = true)
    val detail = resource.value
    val board = detail?.device ?: Boards.of(thing, store.deviceList)
    val missing = (resource.error as? ApiError)?.status == 404
    val context = LocalContext.current
    val canWrite = store.me?.canWrite == true
    val bt by vm.bluetooth.state.collectAsStateWithLifecycle()
    val followed = bt.outcomes[thing]
    ConsoleScreen(
        title = Boards.name(board),
        titleMono = !Boards.hasOwnName(board),
        help = "board-states",
        stale = staleOf(listOf(resource), vm.intervalOf(Route.Board(thing)), now, vm::refreshNow),
        onRefresh = { vm.refresh(Route.Board(thing), full = true) },
        actions = listOfNotNull(
            ScreenAction("Events of this board", Glyph.PULSE) {
                vm.chooseEventBoard(thing)
                vm.open(Route.Events)
            },
            if (canWrite) ScreenAction("Update over Bluetooth", Glyph.BLUETOOTH) { vm.open(Route.Bluetooth(null)) } else null,
            ScreenAction("Copy the thing name", Glyph.COPY) {
                copyToClipboard(context, thing, "the thing name", sensitive = false)
                vm.notify("Copied the thing name.")
            },
        ),
    ) {
        if (missing) {
            item(key = "missing") { OneLine("No board with this name is registered.", "All boards" to { vm.open(Route.Boards) }) }
            return@ConsoleScreen
        }
        problem(resource.error, "this board", detail != null, vm::refreshNow)
        if (detail == null) {
            if (resource.error == null) loading("the board")
            return@ConsoleScreen
        }
        val device = detail.device
        block("header") { BoardHeader(device, store, now) }
        val working = device.ota != null && device.ota.state != "idle"
        if (working) block("update") { UpdateCard(vm, device) }
        val queued = detail.executions.firstOrNull { it.status == "QUEUED" }
        if (queued != null && !working) {
            item(key = "offer") {
                val version = queued.version ?: Updates.versionOfDeployment(queued.deployment)
                ListRow(
                    "Offered ${version ?: "an update"}",
                    supporting = if (device.online) "It has not picked the offer up yet" else "It will see the offer when it connects",
                    leading = { StateDot(Tone.WAIT) },
                    onClick = if (ApiJson.isDeploymentId(queued.deployment)) ({ vm.open(Route.DeploymentPage(queued.deployment)) }) else null,
                )
            }
        }
        header("Details")
        for (part in BoardPart.entries) {
            item(key = part.name) {
                ListRow(part.title, supporting = partSummary(part, device, detail, store, followed), onClick = { vm.open(Route.BoardPage(thing, part)) })
            }
        }
        latestLines(vm, store, thing)
    }
}

/** A board's newest lines of its own log, from the last 24 hours, and the way to all of them under Events. */
private fun androidx.compose.foundation.lazy.LazyListScope.latestLines(vm: ConsoleViewModel, store: Store, thing: String) {
    header(BoardLog.RECENT_TITLE, key = "lines-head")
    val recent = store.boardLines[thing]
    val lines = recent?.value?.lines
    val error = recent?.error
    when {
        lines != null && lines.isEmpty() -> item(key = "lines-none") { OneLine(BoardLog.RECENT_EMPTY) }
        lines != null -> for (line in lines) item(key = "line-${line.key}") { BoardLineRow(line, store.deviceList, showsBoard = false) }
        error != null -> item(key = "lines-failed") { OneLine("${BoardLog.FAILED} ${messageOf(error)}", tone = Tone.BAD, glyph = Glyph.ALERT) }
        else -> loading("its lines")
    }
    item(key = "lines-all") { ListRow(BoardLog.ALL_LINES, onClick = { vm.openBoardLog(thing) }) }
}

/** The board at a glance: its thing name, whether it is online, and its firmware. */
@Composable
private fun BoardHeader(device: Device, store: Store, now: Long) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (Boards.hasOwnName(device)) Mono(device.thing, style = ConsoleType.mono.copy(fontSize = 13.sp), color = console.ink3)
        Wrap {
            Presence(device)
            device.fw?.let { fw ->
                Mono(fw.version, style = ConsoleType.mono.copy(fontWeight = FontWeight.SemiBold))
                if (fw.confirmed) Badge(Tone.GOOD, Glyph.CHECK, "Confirmed") else Badge(Tone.WARN, Glyph.PULSE, "On trial")
                if (fw.version in revokedVersions(store)) Badge(Tone.BAD, Glyph.BAN, "Revoked release")
                if (Updates.isUnregistered(fw.version, store.releases)) Badge(Tone.WARN, Glyph.ALERT, NOT_REGISTERED)
            } ?: Quiet("Firmware not reported")
        }
        Text(heartbeatWords(device, now) ?: NEVER_REPORTED, style = ConsoleType.small, color = console.ink2)
    }
}

/** The update a board is working on: only while there is one. */
@Composable
private fun UpdateCard(vm: ConsoleViewModel, device: Device) {
    val update = Updates.describeUpdate(device)
    InkPanel {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            StatusLine(update.tone, update.glyph, update.label, trailing = update.progress?.let { "$it%" })
            if (update.text.isNotEmpty()) Note(update.text)
            if (update.progress != null) Meter(update.progress, "Download on ${Boards.name(device)}")
            if (update.tone == Tone.ACT) ButtonKeys()
            update.deployment?.let { id -> MoreLink("Open the deployment") { vm.open(Route.DeploymentPage(id)) } }
        }
    }
}

/** One short line for each part of a board's page. */
private fun partSummary(part: BoardPart, device: Device, detail: DeviceDetail, store: Store, followed: UpdateWatch.Record?): String = when (part) {
    BoardPart.FIRMWARE -> device.fw?.let { "${it.version}, ${if (it.confirmed) "confirmed" else "on trial"}" } ?: "Not reported"
    BoardPart.DIAGNOSTICS -> listOfNotNull(
        Words.signalQuality(device.rssi)?.let { "${it.label} · ${Words.signed(device.rssi!!)} dBm" },
        Telemetry.heapWords(device.diag?.heap)?.text,
        device.uptime?.let { "up ${Words.duration(it)}" },
    ).joinToString(" · ").ifEmpty { "Nothing reported" }
    BoardPart.CHARTS -> "Signal and free memory, 24 h"
    BoardPart.BLUETOOTH -> bluetoothSummary(device, followed) ?: "No update over Bluetooth recorded"
    BoardPart.HISTORY -> if (detail.executions.isEmpty()) "Not offered an update yet" else {
        val last = detail.executions.first()
        "${Words.plural(detail.executions.size + detail.olderExecutions, "update")} · last: ${Updates.describeHistory(last.status).label}"
    }
}

// The parts of a board's page.

@Composable
fun BoardPartScreen(vm: ConsoleViewModel, store: Store, thing: String, part: BoardPart, now: Long) {
    val resource = store.deviceDetails[thing] ?: Resource(loading = true)
    val detail = resource.value
    val board = detail?.device ?: Boards.of(thing, store.deviceList)
    val route = Route.BoardPage(thing, part)
    val bt by vm.bluetooth.state.collectAsStateWithLifecycle()
    ConsoleScreen(
        title = part.title,
        subtitle = Boards.name(board),
        help = "boards-and-diagnostics",
        stale = staleOf(listOf(resource), vm.intervalOf(route), now, vm::refreshNow),
        onRefresh = { vm.refresh(route, full = true) },
    ) {
        problem(resource.error, "this board", detail != null, vm::refreshNow)
        if (detail == null) {
            if (resource.error == null) loading("the board")
            return@ConsoleScreen
        }
        val device = detail.device
        when (part) {
            BoardPart.FIRMWARE -> firmwarePart(vm, device, store)
            BoardPart.DIAGNOSTICS -> diagnosticsPart(device, detail, now)
            BoardPart.CHARTS -> chartsPart(vm, store, device, now)
            BoardPart.BLUETOOTH -> bluetoothPart(device, bt.outcomes[thing])
            BoardPart.HISTORY -> historyPart(vm, device, detail, now)
        }
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.firmwarePart(vm: ConsoleViewModel, device: Device, store: Store) {
    val fw = device.fw
    item(key = "fw") {
        ValueRow(
            "Runs" + if (device.online) "" else ", when last seen",
            fw?.version ?: "Not reported",
            mono = fw != null,
            supporting = fw?.let { if (it.confirmed) "Confirmed" else "On trial: not confirmed yet" },
            onClick = fw?.takeIf { f -> store.releases?.any { it.version == f.version } == true }?.let { f -> { vm.open(Route.Release(f.version)) } },
        )
    }
    if (fw != null && fw.version in revokedVersions(store)) {
        item(key = "revoked") { OneLine("A revoked release. To replace it, upload a newer version and deploy that.", tone = Tone.BAD, glyph = Glyph.BAN) }
    }
    if (fw != null && Updates.isUnregistered(fw.version, store.releases)) {
        item(key = "unregistered") { OneLine(NOT_REGISTERED + ".", tone = Tone.WARN, glyph = Glyph.ALERT) }
    }
    item(key = "update") {
        val update = Updates.describeUpdate(device)
        ValueRow(
            "Update", update.label + (update.progress?.let { " $it%" } ?: ""),
            supporting = update.text.ifEmpty { null },
            onClick = update.deployment?.let { id -> { vm.open(Route.DeploymentPage(id)) } },
        )
    }
    header("Flash memory")
    block("flash") { FlashMapOfDevice(device) }
}

private fun androidx.compose.foundation.lazy.LazyListScope.diagnosticsPart(device: Device, detail: DeviceDetail, now: Long) {
    item(key = "heartbeat") {
        ValueRow(
            "Heartbeat",
            device.lastSeen?.let { "Last ${Telemetry.heartbeatAge(it, now)}" } ?: "None yet",
            supporting = presenceWord(device),
        )
    }
    item(key = "uptime") {
        val uptime = Telemetry.uptimeNow(device, now)
        ValueRow("Uptime", uptime?.let { Words.duration(it) + if (device.online) "" else " when last seen" } ?: "Not reported")
    }
    item(key = "signal") {
        val quality = Words.signalQuality(device.rssi)
        ValueRow(
            "Signal",
            if (quality != null && device.rssi != null) "${quality.label} · ${Words.signed(device.rssi)} dBm" else "Not reported",
            supporting = if (quality != null && !device.online) "When last seen" else null,
        )
    }
    if (device.online && device.rssi != null) block("scale") { SignalScale(device.rssi) }
    val diag = device.diag
    item(key = "wifi") {
        ValueRow(
            "Wi-Fi",
            if (diag == null) "Not reported" else if (diag.channel != null && diag.channel > 0) "Channel ${diag.channel}" else "Not associated",
            supporting = if (diag == null) Telemetry.diagMissing(device) else null,
        )
    }
    if (diag?.mac != null) item(key = "mac") { ValueRow("MAC", diag.mac, mono = true) }
    item(key = "memory") {
        val heap = Telemetry.heapWords(diag?.heap)
        ValueRow("Memory", heap?.text ?: "Not reported", supporting = heap?.least)
    }
    diag?.heap?.let { heap -> block("heap") { HeapBar(heap) } }
    item(key = "stuck") {
        val stuck = Telemetry.stuckWords(device.stuck)
        ValueRow("Stuck restarts", stuck?.badge ?: if (stuck == null) "Not reported" else "None", supporting = stuck?.text)
    }
    diag?.at?.let { at -> item(key = "diag-at") { ValueRow("Diagnostics report", Words.timeAgo(at, now)) } }
    header("Certificates")
    if (detail.certificates.isEmpty()) {
        item(key = "certs-none") { OneLine("None attached: this board cannot connect.", tone = Tone.BAD, glyph = Glyph.ALERT) }
    } else {
        for (id in detail.certificates) item(key = "cert-$id") { ListRow("$id…", mono = true, leading = { GlyphIcon(Glyph.KEY, tint = console.ink2) }) }
    }
    header("Last boots")
    val diary = device.diary
    val rows = Telemetry.diaryRows(diary)
    when {
        diary == null -> item(key = "boots-none") { OneLine(Telemetry.diaryMissing(device)) }
        rows.isEmpty() -> item(key = "boots-empty") { OneLine("The diary is empty.") }
        else -> for (row in rows) {
            item(key = "boot-${row.boot}") {
                ListRow(
                    "#${row.boot} · ${row.version}" + if (row.running) " (running)" else "",
                    supporting = "Before it: ${row.before}. ${if (row.running) "${row.reached} so far" else row.reached}.",
                    leading = { StateDot(if (row.bad) Tone.WARN else Tone.IDLE) },
                )
            }
        }
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.chartsPart(vm: ConsoleViewModel, store: Store, device: Device, now: Long) {
    val samples = store.samples[device.thing]
    val value = samples?.value
    when {
        value != null -> {
            block("rssi") { RssiChart(device, value, now) }
            if (device.diag != null || value.samples.any { it.heapFree != null }) {
                block("heap") { HeapChart(device, value, now) }
            } else {
                item(key = "heap-none") { OneLine("Free memory: ${Telemetry.diagMissing(device)}") }
            }
        }
        samples?.error != null -> problem(samples.error, "the readings", false, vm::refreshNow)
        else -> loading("the readings")
    }
}

/**
 * "1.13.0+0 over Bluetooth at 12:14, kept": the last update this phone followed on the board, else the
 * board's own record of its last one (core/UpdateWatch.kt).
 */
private fun bluetoothSummary(device: Device, followed: UpdateWatch.Record?): String? =
    UpdateWatch.summary(followed, device.bt) { Words.timeOfDay(Times.iso(it)) }

private fun androidx.compose.foundation.lazy.LazyListScope.bluetoothPart(device: Device, followed: UpdateWatch.Record?) {
    val record = device.bt
    bluetoothSummary(device, followed)?.let { summary -> item(key = "last") { ValueRow("Last update", summary) } }
    if (record == null) {
        item(key = "none") { OneLine("No update over Bluetooth recorded. Boards on 1.9.0 or later keep a record of the last one.") }
        return
    }
    item(key = "update") { ValueRow("Update", "${record.from} to ${record.to}", mono = true) }
    item(key = "result") {
        val bad = record.result in Telemetry.BAD_BT
        ListRow(
            Telemetry.BT_WORDS[record.result] ?: record.result,
            overline = "Result",
            leading = { StateDot(if (bad) Tone.WARN else Tone.GOOD) },
        )
    }
    item(key = "proof") { ValueRow("Proof", Telemetry.PROOF_WORDS[record.proof] ?: record.proof) }
    item(key = "count") { ValueRow("Updates over Bluetooth", Words.plural(record.count, "update", "updates"), supporting = "On this board, in all") }
}

private fun androidx.compose.foundation.lazy.LazyListScope.historyPart(vm: ConsoleViewModel, device: Device, detail: DeviceDetail, now: Long) {
    if (detail.executions.isEmpty()) {
        item(key = "none") { OneLine("This board has not been offered an update yet.") }
        return
    }
    val ended = detail.executions.filter { !Updates.isUnfinished(it.status) }.maxByOrNull { Times.parse(it.lastUpdatedAt) ?: 0L }
    for (execution in detail.executions) {
        item(key = execution.deployment) {
            val words = Updates.describeHistory(execution.status, if (execution == ended) device.ota?.last else null)
            val ours = ApiJson.isDeploymentId(execution.deployment)
            ListRow(
                execution.version ?: Updates.versionOfDeployment(execution.deployment) ?: execution.deployment,
                mono = true,
                supporting = "Offered ${Words.timeAgo(execution.queuedAt, now)}" +
                    (if (Updates.isUnfinished(execution.status)) "" else " · ended ${Words.timeAgo(execution.lastUpdatedAt, now)}") +
                    if (ours) "" else " · started outside this console",
                leading = { StateDot(words.tone) },
                trailingText = words.label,
                onClick = if (ours) ({ vm.open(Route.DeploymentPage(execution.deployment)) }) else null,
            )
        }
    }
    if (detail.olderExecutions > 0) {
        item(key = "older") { OneLine("${Words.plural(detail.olderExecutions, "older update is", "older updates are")} not listed.") }
    }
}
