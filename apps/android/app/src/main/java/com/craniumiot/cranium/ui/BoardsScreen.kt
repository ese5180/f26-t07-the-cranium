package com.craniumiot.cranium.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.craniumiot.cranium.core.ApiError
import com.craniumiot.cranium.core.Boards
import com.craniumiot.cranium.core.Device
import com.craniumiot.cranium.core.ExecutionSummary
import com.craniumiot.cranium.core.Glyph
import com.craniumiot.cranium.core.Heap
import com.craniumiot.cranium.core.Telemetry
import com.craniumiot.cranium.core.Tone
import com.craniumiot.cranium.core.Updates
import com.craniumiot.cranium.core.Words

@Composable
fun BoardsScreen(vm: ConsoleViewModel, store: Store, now: Long) {
    val devices = store.deviceList
    PageHead(
        "Boards",
        lede = "Every board registered to this project, as it last reported: its firmware, its update, its signal and memory.",
        tools = { Freshness(store.devices.loadedAt, store.devices.loading, vm.intervalOf(Route.Boards), now, vm::refreshNow) },
    )
    LoadProblem(store.devices.error, "the boards", devices != null, store.devices.loadedAt, now, vm::refreshNow)
    when {
        devices == null -> if (store.devices.error == null) Loading("boards")
        devices.isEmpty() -> Section {
            EmptyState(Glyph.CHIP, "No boards are registered yet.", "Provision one with", "python3 tools/provision_device.py")
        }
        else -> {
            val newest = store.releases?.firstOrNull { it.isActive }
            InkPanel(Modifier.padding(bottom = 28.dp)) {
                Section(title = "Fleet", zone = true) {
                    FleetFigure(
                        devices,
                        listOf(
                            "updating now" to devices.count { Updates.deviceActivity(it) != null },
                            "on trial" to devices.count { it.fw != null && !it.fw.confirmed },
                        ),
                    )
                }
                Section(title = "Firmware in the fleet", zone = true) {
                    asReported(devices, now)?.let { Note(it, Modifier.padding(bottom = 8.dp)) }
                    VersionRows(devices, newest, store)
                }
            }
            for (device in devices) BoardCard(vm, store, device, now)
        }
    }
}

/** A board in the list: its name, when it was last heard of, and the facts of the website's device grid. */
@Composable
private fun BoardCard(vm: ConsoleViewModel, store: Store, device: Device, now: Long) {
    val colors = console
    Section {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(role = Role.Button, onClickLabel = "Open the board") { vm.open(Route.Board(device.thing)) }
                .padding(bottom = 8.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(Boards.name(device), style = ConsoleType.sectionTitle.copy(fontFamily = ConsoleType.Mono), color = colors.ink)
                    GlyphIcon(Glyph.ARROW_RIGHT, size = 14.dp, tint = colors.ink2)
                }
                if (Boards.hasOwnName(device)) Mono(device.thing, style = ConsoleType.mono.copy(fontSize = 12.sp), color = colors.ink3)
                Note(seenLine(device, now))
                if (device.lastSeen == null && !device.online) Note(NEVER_REPORTED_HELP)
            }
            Presence(device)
        }
        DeviceFacts(vm, store, device, now, offer = openOffer(store, device), withHeartbeat = false, withScale = false)
    }
}

/** The deployment that is waiting for a board, from the deployments whose record has been read. */
private fun openOffer(store: Store, device: Device): Pair<String, String?>? {
    for (deployment in store.deployments.value.orEmpty()) {
        val detail = store.deploymentDetails[deployment.id]?.value
        if (!Updates.isUnderWay(deployment) || detail == null) continue
        val own = detail.executions.firstOrNull { it.thing == device.thing }
        if (own?.status == "QUEUED") return deployment.id to deployment.version
    }
    return null
}

@Composable
private fun DeviceFacts(
    vm: ConsoleViewModel,
    store: Store,
    device: Device,
    now: Long,
    offer: Pair<String, String?>?,
    withHeartbeat: Boolean,
    withScale: Boolean,
) {
    val rows = mutableListOf<Fact>()
    if (withHeartbeat) {
        rows += Fact("Heartbeat") {
            if (device.lastSeen != null) {
                Text("Last heartbeat ${Telemetry.heartbeatAge(device.lastSeen, now)}", style = ConsoleType.small, color = console.ink)
            } else {
                Quiet("None yet: it has not reported to AWS IoT.")
            }
        }
    }
    rows += Fact("Firmware") { FirmwareFact(device, store) }
    rows += Fact("Update") { UpdateFact(vm, device, offer) }
    rows += Fact("Signal") {
        SignalWords(device)
        if (withScale && device.online && device.rssi != null) SignalScale(device.rssi)
    }
    rows += Fact("Uptime") {
        val uptime = if (withHeartbeat) Telemetry.uptimeNow(device, now) else device.uptime
        if (uptime == null) Quiet("Not reported") else Text(Words.duration(uptime) + if (device.online) "" else " when last seen", style = ConsoleType.small, color = console.ink)
    }
    if (!withHeartbeat) {
        rows += Fact("Memory") {
            val heap = Telemetry.heapWords(device.diag?.heap)
            if (heap == null) Quiet(if (device.diag != null) "The heap is not reported by this build." else Telemetry.diagMissing(device)) else Text(heap.text, style = ConsoleType.small, color = console.ink)
        }
    }
    Facts(rows)
}

@Composable
private fun UpdateFact(vm: ConsoleViewModel, device: Device, offer: Pair<String, String?>?) {
    val update = Updates.describeUpdate(device)
    StatusLine(update)
    if (update.progress != null) Meter(update.progress, "Download on ${Boards.name(device)}")
    if (update.text.isNotEmpty()) Note(update.text)
    if (offer != null && update.deployment == null) {
        Note("Offered ${offer.second ?: "an update"}${if (device.online) ". It has not picked the offer up yet." else ". It will see the offer when it connects."}")
    }
    val deployment = update.deployment ?: offer?.first
    if (deployment != null) MoreLink("Open the deployment") { vm.open(Route.DeploymentPage(deployment)) }
}

/** A reading on the scale of a signal meter: the four bands, and a needle where the board is. */
@Composable
private fun SignalScale(rssi: Int) {
    val colors = console
    val quality = Words.signalQuality(rssi) ?: return
    val bands = listOf("Weak" to -90, "Fair" to -75, "Good" to -67, "Excellent" to -55)
    val place = ((rssi + 90f) / 50f).coerceIn(0f, 1f)
    Column(Modifier.fillMaxWidth().semantics(mergeDescendants = true) { contentDescription = "Wi-Fi signal ${Words.signed(rssi)} dBm, ${quality.label.lowercase()}" }) {
        BoxWithConstraints(Modifier.fillMaxWidth().height(26.dp).clearAndSetSemantics {}) {
            Row(Modifier.fillMaxWidth().height(18.dp).clip(RoundedCornerShape(3.dp))) {
                bands.forEachIndexed { index, (label, from) ->
                    val to = bands.getOrNull(index + 1)?.second ?: -40
                    Box(
                        Modifier.weight((to - from).toFloat()).fillMaxHeight().background(if (label == quality.label) colors.workWash else colors.well),
                        contentAlignment = Alignment.Center,
                    ) { Text(label, style = ConsoleType.eyebrow.copy(letterSpacing = 0.sp, fontSize = 10.sp), color = if (label == quality.label) colors.ink else colors.ink3) }
                }
            }
            Box(Modifier.offset(x = maxWidth * place - 1.dp).width(2.dp).height(26.dp).background(colors.ink))
        }
    }
}

/** How much memory is free, as a bar with the lowest point of this boot marked. */
@Composable
fun HeapBar(heap: Heap) {
    val colors = console
    val words = Telemetry.heapWords(heap) ?: return
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        BoxWithConstraints(
            Modifier
                .fillMaxWidth()
                .height(10.dp)
                .clip(RoundedCornerShape(2.dp))
                .border(1.dp, colors.lineField, RoundedCornerShape(2.dp))
                .background(colors.well)
                .semantics { contentDescription = "${words.text}, ${words.used}% in use. ${words.least}." },
        ) {
            Box(Modifier.fillMaxHeight().width(maxWidth * (words.used / 100f)).background(colors.toneBar(words.tone)))
            Box(Modifier.offset(x = maxWidth * (words.leastUsed / 100f) - 1.dp).width(2.dp).fillMaxHeight().background(colors.ink))
        }
        Wrap {
            if (words.tone == Tone.BAD) Badge(Tone.BAD, Glyph.ALERT, "Low now")
            Text(words.text, style = ConsoleType.small, color = colors.ink)
        }
        Wrap {
            if (words.ranLow) Badge(Tone.WARN, Glyph.ALERT, "Ran low")
            Note(words.least)
        }
    }
}

// A board's page.

@Composable
fun BoardScreen(vm: ConsoleViewModel, store: Store, thing: String, now: Long) {
    val resource = store.deviceDetails[thing] ?: Resource(loading = true)
    val detail = resource.value
    val board = detail?.device ?: Boards.of(thing, store.deviceList)
    val named = Boards.hasOwnName(board)
    val missing = (resource.error as? ApiError)?.status == 404
    PageHead(
        title = Boards.name(board),
        eyebrow = "Board",
        titleMono = !named,
        lede = detail?.let { seenLine(it.device, now) + if (it.device.lastSeen == null && !it.device.online) " $NEVER_REPORTED_HELP" else "" },
        meta = if (named) ({ Text("AWS IoT thing $thing", style = ConsoleType.note.copy(fontFamily = ConsoleType.Mono), color = console.ink2) }) else null,
        tools = if (missing) null else ({ Freshness(resource.loadedAt, resource.loading, vm.intervalOf(Route.Board(thing)), now, vm::refreshNow) }),
    )
    if (missing) {
        Section {
            EmptyState(
                Glyph.CHIP, "No board with this name is registered.", "Check the address, or find the board in the list of devices.",
                action = "All devices" to { vm.open(Route.Boards) },
            )
        }
        return
    }
    LoadProblem(resource.error, "this board", detail != null, resource.loadedAt, now, vm::refreshNow)
    if (detail == null) {
        if (resource.error == null) Loading("the board")
        return
    }
    val device = detail.device
    val ended = detail.executions.filter { !Updates.isUnfinished(it.status) }.maxByOrNull { com.craniumiot.cranium.core.Times.parse(it.lastUpdatedAt) ?: 0L }
    val queued = detail.executions.firstOrNull { it.status == "QUEUED" }
    val offer = queued?.let { it.deployment to (it.version ?: Updates.versionOfDeployment(it.deployment)) } ?: openOffer(store, device)

    BoardPanel(device)
    Wrap(Modifier.padding(bottom = 20.dp)) {
        ConsoleButton("Events of this board", {
            vm.chooseEventBoard(thing)
            vm.open(Route.Events)
        }, small = true, glyph = Glyph.PULSE)
        if (store.me?.canWrite == true) {
            ConsoleButton("Update over Bluetooth", { vm.open(Route.Bluetooth(null)) }, small = true, glyph = Glyph.BLUETOOTH)
        }
    }
    Section(title = "State") {
        Box(Modifier.padding(bottom = 6.dp)) { Presence(device) }
        DeviceFacts(vm, store, device, now, offer, withHeartbeat = true, withScale = true)
    }
    DiagnosticsSections(store, device, detail.certificates, now)
    Section(title = "Update history") {
        if (detail.executions.isEmpty()) {
            Quiet("This board has not been offered an update yet.")
        } else {
            for (execution in detail.executions) {
                HistoryRow(execution, now, if (execution == ended) device.ota?.last else null) { vm.open(Route.DeploymentPage(it)) }
            }
            if (detail.olderExecutions > 0) {
                Note(
                    "The newest ${detail.executions.size} are shown. " +
                        "${Words.plural(detail.olderExecutions, "older update is", "older updates are")} not listed.",
                    Modifier.padding(top = 8.dp),
                )
            }
        }
    }
}

@Composable
private fun HistoryRow(execution: ExecutionSummary, now: Long, last: String?, onOpen: (String) -> Unit) {
    val colors = console
    val version = execution.version ?: Updates.versionOfDeployment(execution.deployment)
    val ours = com.craniumiot.cranium.core.ApiJson.isDeploymentId(execution.deployment)
    Row(
        Modifier
            .fillMaxWidth()
            .drawBehind { drawLine(colors.line, Offset(0f, 0f), Offset(size.width, 0f), 1.dp.toPx()) }
            .then(if (ours) Modifier.clickable(role = Role.Button, onClickLabel = "Open the deployment") { onOpen(execution.deployment) } else Modifier)
            .padding(vertical = 10.dp)
            .semantics(mergeDescendants = true) {},
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Mono(version ?: execution.deployment, style = ConsoleType.mono.copy(fontWeight = FontWeight.SemiBold))
            Note(
                "Offered ${Words.timeAgo(execution.queuedAt, now)}" +
                    if (Updates.isUnfinished(execution.status)) "" else " · ended ${Words.timeAgo(execution.lastUpdatedAt, now)}",
            )
            if (!ours) Note("Started outside this console")
            StatusLine(Updates.describeHistory(execution.status, last))
        }
        if (ours) GlyphIcon(Glyph.ARROW_RIGHT, tint = colors.ink3)
    }
}

/** What matters most on a board's page: what it is doing, and what its flash holds. */
@Composable
private fun BoardPanel(device: Device) {
    val update = Updates.describeUpdate(device)
    val working = device.ota != null && device.ota.state != "idle"
    InkPanel(Modifier.padding(bottom = 16.dp)) {
        if (working) {
            Column(Modifier.padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                StatusLine(update.tone, update.glyph, update.label, trailing = update.progress?.let { "$it%" })
                if (update.text.isNotEmpty()) Note(update.text)
                if (update.progress != null) Meter(update.progress, "Download on ${Boards.name(device)}")
                if (update.tone == Tone.ACT) ButtonKeys()
            }
        }
        if (device.fw != null || device.ota != null) {
            FlashMapOfDevice(device)
        } else {
            StatusLine(Tone.IDLE, Glyph.MINUS_CIRCLE, "Nothing reported yet")
            Note(
                if (device.lastSeen != null) {
                    "This board has not said what it runs, so nothing is known about its flash memory."
                } else {
                    "This board has not reported to AWS IoT, so nothing is known about its flash memory."
                },
            )
        }
    }
}

/** One row of a flash map: what a slot holds, and what is happening to it. */
data class FlashSlot(
    val version: String? = null,
    val none: String = "No new image",
    val state: String,
    val tone: Tone = Tone.IDLE,
    val glyph: Glyph? = null,
    val receiving: Int? = null,
)

const val WORKED_OUT = "Worked out from the step the board last reported."

/** What a board's flash holds: the bootloader and the two slots. */
@Composable
fun FlashMap(title: String, primary: FlashSlot, secondary: FlashSlot, swapping: Boolean = false, note: String = WORKED_OUT) {
    val colors = console
    Eyebrow(title)
    Spacer(Modifier.height(8.dp))
    @Composable
    fun row(name: String, slot: FlashSlot?, version: String, state: String, tone: Tone, glyph: Glyph?, receiving: Int?) {
        Row(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(4.dp))
                .background(colors.well)
                .drawBehind {
                    if (receiving != null) drawRect(colors.workWash, size = size.copy(width = size.width * receiving / 100f))
                }
                .padding(horizontal = 10.dp, vertical = 8.dp)
                .semantics(mergeDescendants = true) {},
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Column(Modifier.weight(1f)) {
                Text(name, style = ConsoleType.note, color = colors.ink3)
                if (slot?.version != null || slot == null) Mono(version, style = ConsoleType.mono.copy(fontWeight = FontWeight.SemiBold)) else Quiet(slot.none)
            }
            Row(Modifier.weight(1.2f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (glyph != null) GlyphIcon(glyph, size = 14.dp, tint = colors.toneInk(tone))
                Text(state + if (receiving != null) " $receiving%" else "", style = ConsoleType.note, color = colors.ink)
            }
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        row("Bootloader", null, "MCUboot", "Checks every signature", Tone.IDLE, null, null)
        row("Primary slot", primary, primary.version.orEmpty(), primary.state, primary.tone, primary.glyph, primary.receiving)
        if (swapping) Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { GlyphIcon(Glyph.SWAP, tint = colors.work) }
        row("Secondary slot", secondary, secondary.version.orEmpty(), secondary.state, secondary.tone, secondary.glyph, secondary.receiving)
    }
    Note(note, Modifier.padding(top = 6.dp))
}

/** The flash map told from what a board last reported about itself (views.js slotsOfDevice). */
@Composable
private fun FlashMapOfDevice(device: Device) {
    val fw = device.fw
    val ota = device.ota
    val online = device.online
    val onTrialWords = if (online) "Runs on trial" else "Was on trial"
    val confirmedWords = if (online) "Runs from here, confirmed" else "Ran from here, confirmed"
    val running = FlashSlot(
        version = fw?.version,
        none = "Version not reported",
        state = when {
            fw?.confirmed == true -> confirmedWords
            fw != null -> onTrialWords
            else -> "Nothing reported"
        },
        tone = when {
            fw?.confirmed == true -> Tone.GOOD
            fw != null -> Tone.LIVE
            else -> Tone.IDLE
        },
        glyph = when {
            fw?.confirmed == true -> Glyph.CHECK
            fw != null -> Glyph.PULSE
            else -> null
        },
    )
    val target = Updates.versionOfDeployment(ota?.job)
    val note = if (ota != null) WORKED_OUT else "The board reports what it runs, and nothing about its other slot."
    val title = if (online) "Flash memory now" else "Flash memory when last seen"
    val update = Updates.describeUpdate(device)
    when {
        ota == null || ota.state == "idle" ->
            FlashMap(title, running, FlashSlot(none = "Not reported by the board", state = "No update under way"), note = note)
        ota.state == "awaiting_user" -> FlashMap(
            title, running,
            FlashSlot(none = "Not reported by the board", state = if (online) "Nothing is written until Button 1 is pressed" else update.label),
            note = note,
        )
        ota.state == "testing" -> FlashMap(
            title, running.copy(state = onTrialWords, tone = if (online) Tone.LIVE else Tone.IDLE, glyph = Glyph.PULSE),
            FlashSlot(none = "Previous firmware", state = "Kept to fall back on"), note = note,
        )
        ota.state == "bluetooth" -> FlashMap(
            title, running,
            FlashSlot(none = "Not reported by the board", state = if (online) "A phone may be sending an image over Bluetooth" else update.label),
            note = note,
        )
        !online -> FlashMap(title, running, FlashSlot(version = target, state = update.label), note = note)
        ota.state == "downloading" -> FlashMap(
            title, running,
            FlashSlot(version = target, state = "Receiving the image", tone = Tone.LIVE, glyph = Glyph.DOWNLOAD, receiving = ota.progress),
            note = note,
        )
        else -> FlashMap(
            title, running, FlashSlot(version = target, state = "Written, being checked", tone = Tone.LIVE, glyph = Glyph.SHIELD),
            swapping = ota.state == "rebooting", note = note,
        )
    }
}

/** The Diagnostics page's card for one board: health, readings, boots and the Bluetooth record. */
@Composable
private fun DiagnosticsSections(store: Store, device: Device, certificates: List<String>, now: Long) {
    val samples = store.samples[device.thing]
    Section(title = "Health") {
        val stuck = Telemetry.stuckWords(device.stuck)
        Facts(
            listOf(
                Fact("Stuck") {
                    if (stuck == null) {
                        Quiet("Not reported: firmware before 1.7.0 has no such timer")
                    } else {
                        Wrap {
                            if (stuck.tone == Tone.WARN && stuck.badge != null) Badge(Tone.WARN, Glyph.ALERT, stuck.badge)
                            Text(stuck.text, style = ConsoleType.small, color = console.ink)
                        }
                    }
                },
                Fact("Wi-Fi") {
                    val diag = device.diag
                    if (diag == null) {
                        Note(Telemetry.diagMissing(device))
                    } else {
                        Text(
                            (if (diag.channel != null && diag.channel > 0) "Channel ${diag.channel}" else "Not associated") +
                                " · MAC " + (diag.mac ?: "not reported"),
                            style = ConsoleType.small, color = console.ink,
                        )
                    }
                },
                Fact("Memory") {
                    val heap = device.diag?.heap
                    if (heap != null) HeapBar(heap) else Note(if (device.diag != null) "The heap is not reported by this build." else Telemetry.diagMissing(device))
                },
                Fact("Certificates") {
                    if (certificates.isEmpty()) {
                        Quiet("None attached: this board cannot connect. Run the provisioning tool again.")
                    } else {
                        for (id in certificates) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                GlyphIcon(Glyph.KEY, size = 14.dp, tint = console.ink2)
                                Mono("$id…")
                            }
                        }
                        Note("The start of each certificate ID. The certificate belongs to this board alone; its private key never leaves the board.")
                    }
                },
            ),
        )
        device.diag?.at?.let { Note("Diagnostics report ${Words.timeAgo(it, now)}.", Modifier.padding(top = 8.dp)) }
    }
    Section(title = "Readings, 24 h") {
        val value = samples?.value
        when {
            value != null -> {
                RssiChart(device, value, now)
                Spacer(Modifier.height(20.dp))
                if (device.diag != null || value.samples.any { it.heapFree != null }) {
                    HeapChart(device, value, now)
                } else {
                    Text("Free memory, 24 h", style = ConsoleType.small.copy(fontWeight = FontWeight.SemiBold), color = console.ink)
                    Quiet(Telemetry.diagMissing(device))
                }
            }
            samples?.error != null -> Failure("Could not load the readings.", samples.error)
            else -> Loading("the readings")
        }
    }
    Section(title = "Last boots") {
        val diary = device.diary
        if (diary == null) {
            Quiet(Telemetry.diaryMissing(device))
        } else {
            val rows = Telemetry.diaryRows(diary)
            if (rows.isEmpty()) {
                Quiet("The diary is empty.")
            } else {
                val line = console.line
                for (row in rows) {
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .drawBehind { drawLine(line, Offset(0f, 0f), Offset(size.width, 0f), 1.dp.toPx()) }
                            .padding(vertical = 8.dp)
                            .semantics(mergeDescendants = true) {},
                        verticalArrangement = Arrangement.spacedBy(3.dp),
                    ) {
                        Wrap {
                            Text("#${row.boot}" + if (row.running) " (running)" else "", style = ConsoleType.small.copy(fontWeight = FontWeight.SemiBold), color = console.ink)
                            Mono(row.version)
                        }
                        Wrap {
                            if (row.bad) Badge(Tone.WARN, Glyph.ALERT, "Fault")
                            Text("Before it: ${row.before}", style = ConsoleType.note, color = console.ink2)
                        }
                        Note(if (row.running) "${row.reached} so far" else row.reached)
                    }
                }
                Note(
                    "${Words.plural(diary.boots, "boot")} in all since the diary began. Each line says why the boot before it ended, " +
                        "from the chip’s own record of its reset.",
                    Modifier.padding(top = 6.dp),
                )
            }
        }
    }
    Section(title = "Last update over Bluetooth") {
        val record = device.bt
        if (record == null) {
            Quiet("No update over Bluetooth recorded. Boards on 1.9.0 or later keep a record of the last one.")
        } else {
            Facts(
                listOf(
                    Fact("Update") { Text("${record.from} to ${record.to}", style = ConsoleType.mono, color = console.ink) },
                    Fact("Result") {
                        val words = Telemetry.BT_WORDS[record.result] ?: record.result
                        if (record.result in Telemetry.BAD_BT) Badge(Tone.WARN, Glyph.ALERT, words) else Text(words, style = ConsoleType.small, color = console.ink)
                    },
                    Fact("Proof") { Text(Telemetry.PROOF_WORDS[record.proof] ?: record.proof, style = ConsoleType.small, color = console.ink) },
                    Fact("Updates") {
                        Text(Words.plural(record.count, "update", "updates"), style = ConsoleType.small, color = console.ink)
                        Note("over Bluetooth on this board, in all")
                    },
                ),
            )
        }
    }
}
