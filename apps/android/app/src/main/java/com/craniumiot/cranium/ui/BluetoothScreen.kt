package com.craniumiot.cranium.ui

import android.bluetooth.BluetoothAdapter
import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.craniumiot.cranium.ble.BlePermissions
import com.craniumiot.cranium.ble.BluetoothFlow
import com.craniumiot.cranium.ble.BluetoothStatus
import com.craniumiot.cranium.ble.BoardPhase
import com.craniumiot.cranium.ble.BtState
import com.craniumiot.cranium.ble.BtStep
import com.craniumiot.cranium.core.BoardLog
import com.craniumiot.cranium.core.Glyph
import com.craniumiot.cranium.core.Release
import com.craniumiot.cranium.core.Times
import com.craniumiot.cranium.core.Tone
import com.craniumiot.cranium.core.UpdateWatch
import com.craniumiot.cranium.core.Words
import kotlinx.coroutines.delay

/**
 * The update over Bluetooth (docs/mobile-apps.md): choose a release, find the board, pair with
 * the passkey, send, and press Button 1 at the board. One step at a time, each with its one action.
 * After the send, what the board does until it keeps the image or goes back.
 */
@Composable
fun BluetoothScreen(vm: ConsoleViewModel, store: Store) {
    val flow = vm.bluetooth
    val state by flow.state.collectAsStateWithLifecycle()
    val permissions = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        if (granted.values.all { it }) flow.lookForBoards() else flow.onPermissionDenied()
    }
    val enable = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { flow.lookForBoards() }

    if (store.me == null) {
        // Not known yet, or one read of it failed: ask again, and never take the person for a viewer.
        LaunchedEffect(Unit) { vm.ensureMe() }
        ConsoleScreen(title = "Update over Bluetooth", help = "bluetooth") {
            item(key = "checking") {
                OneLine("Your account could not be checked with the console yet.", action = "Check again" to { vm.ensureMe() })
            }
        }
        return
    }
    if (store.me.canWrite != true) {
        ConsoleScreen(title = "Update over Bluetooth", help = "bluetooth") {
            item(key = "viewer") { OneLine("Only a release manager can send firmware.", glyph = Glyph.LOCK) }
        }
        return
    }

    val board = state.board
    val primary: ScreenAction? = when (state.step) {
        BtStep.CHOOSE -> if (state.chosen != null) ScreenAction("Find the board", Glyph.BLUETOOTH, onClick = flow::toFindBoard) else null
        BtStep.FIND_BOARD -> if (!state.scanning) ScreenAction("Look again", Glyph.RESTART, onClick = flow::lookForBoards) else null
        BtStep.BOARD -> when (board?.phase) {
            BoardPhase.CONNECTING, BoardPhase.READING -> ScreenAction("Stop", Glyph.STOP, onClick = flow::leaveBoard)
            BoardPhase.READY -> board.selected?.let { version -> ScreenAction("Send $version", Glyph.SEND, onClick = flow::send) }
            BoardPhase.UPLOADING -> ScreenAction("Cancel", Glyph.X, onClick = flow::cancelUpload)
            BoardPhase.FAILED -> ScreenAction("Look for the board again", Glyph.BLUETOOTH, onClick = flow::toFindBoard)
            else -> null
        }
        BtStep.DONE -> ScreenAction("Update another board", Glyph.BLUETOOTH, onClick = flow::backToChoose)
    }
    val actions = buildList {
        when {
            state.step == BtStep.FIND_BOARD -> add(ScreenAction("Back to releases", Glyph.ARROW_LEFT, onClick = flow::backToChoose))
            state.step == BtStep.BOARD && board?.phase in setOf(BoardPhase.READY, BoardPhase.DOWNLOADING, BoardPhase.CHECKING, BoardPhase.CONFIRMING) ->
                add(ScreenAction("Disconnect", Glyph.X, onClick = flow::leaveBoard))
            state.step == BtStep.BOARD && board?.phase == BoardPhase.FAILED ->
                add(ScreenAction("Back to releases", Glyph.ARROW_LEFT, onClick = flow::backToChoose))
        }
        if (store.cache.count > 0 && board?.phase != BoardPhase.UPLOADING) {
            add(ScreenAction("Clear downloaded firmware", Glyph.MINUS_CIRCLE, onClick = vm::clearFirmware))
        }
    }

    ConsoleScreen(
        title = "Update over Bluetooth",
        // While pairing, the passkey sits at the top, above the phone's pairing dialog.
        subtitle = if (state.step == BtStep.BOARD) {
            board?.takeIf { it.phase == BoardPhase.CONNECTING || it.phase == BoardPhase.READING }?.passkey
                ?.let { "Passkey ${it.chunked(3).joinToString(" ")} · on the clipboard" } ?: board?.name
        } else null,
        help = "bluetooth",
        actions = actions,
        primary = primary,
    ) {
        state.notice?.let { notice ->
            item(key = "notice") {
                OneLine(
                    notice.text, "OK" to flow::dismissNotice,
                    if (notice.isError) Tone.BAD else Tone.IDLE, if (notice.isError) Glyph.ALERT else Glyph.CHECK_CIRCLE,
                )
            }
        }
        when (state.step) {
            BtStep.CHOOSE -> chooseStep(flow, state, store)
            BtStep.FIND_BOARD -> findStep(
                flow, state,
                onAllow = { permissions.launch(BlePermissions.required()) },
                onTurnOn = { enable.launch(Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE)) },
            )
            BtStep.BOARD -> boardStep(flow, state, store)
            BtStep.DONE -> doneStep(state)
        }
    }
}

/** The three steps at the board that open its Bluetooth window. */
@Composable
private fun AtTheBoard() {
    InkPanel {
        Eyebrow("At the board")
        Spacer(Modifier.height(8.dp))
        Text("1. Hold Button 1 for 5 s and let go.", style = ConsoleType.body, color = console.ink)
        Text("2. LED1 flashes four times: Bluetooth is open for 3 minutes.", style = ConsoleType.body, color = console.ink)
        Text("3. Pick the board here: Cranium- and four hex digits.", style = ConsoleType.body, color = console.ink)
    }
}

private fun LazyListScope.chooseStep(flow: BluetoothFlow, state: BtState, store: Store) {
    header("Release")
    if (state.releases.isEmpty()) {
        if (store.firmware.value == null) loading("the releases") else item(key = "none") { OneLine("There is no active release on the console.") }
    }
    for (release in state.releases) {
        item(key = "release-${release.version}") {
            ReleaseChoice(release, release.version == state.chosen, release == state.releases.firstOrNull(), store.cache.holds(release)) {
                flow.choose(release.version)
            }
        }
    }
    item(key = "at-board") { Box(Modifier.padding(horizontal = Gutter, vertical = 16.dp)) { AtTheBoard() } }
}

/** A release to pick, with whether it is the newest and whether this phone holds its image. */
@Composable
private fun ReleaseChoice(release: Release, selected: Boolean, newest: Boolean, onPhone: Boolean, enabled: Boolean = true, onClick: () -> Unit) {
    val tags = listOfNotNull(if (newest) "Newest" else null, if (onPhone) "On this phone" else null)
    ListRow(
        headline = release.version,
        supporting = listOf(Words.fileSize(release.size), release.uploadedAt.take(10), release.notes.take(80))
            .filter { it.isNotEmpty() }.joinToString(" · "),
        mono = true,
        leading = {
            RadioButton(selected = selected, onClick = null, enabled = enabled, colors = RadioButtonDefaults.colors(selectedColor = console.accent))
        },
        trailing = if (tags.isNotEmpty()) {
            { for (tag in tags) Tag(tag) }
        } else {
            null
        },
        onClick = if (enabled) onClick else null,
        chevron = false,
    )
}

private fun LazyListScope.findStep(flow: BluetoothFlow, state: BtState, onAllow: () -> Unit, onTurnOn: () -> Unit) {
    item(key = "hint") { OneLine("Hold Button 1 for 5 s and let go: LED1 flashes four times. Then pick the board.", glyph = Glyph.PRESS) }
    when (state.bluetooth) {
        BluetoothStatus.NO_BLUETOOTH -> item(key = "bt") { OneLine("This phone has no Bluetooth LE.", tone = Tone.BAD, glyph = Glyph.ALERT) }
        BluetoothStatus.NEEDS_PERMISSION -> item(key = "bt") {
            OneLine("The app needs the Bluetooth permission to find the board.", "Allow" to onAllow, Tone.WARN, Glyph.LOCK)
        }
        BluetoothStatus.OFF -> item(key = "bt") { OneLine("Bluetooth is off.", "Turn on" to onTurnOn, Tone.WARN, Glyph.BLUETOOTH) }
        BluetoothStatus.LOCATION_OFF -> item(key = "bt") {
            OneLine("Turn on Location: Android 11 and older find no Bluetooth devices without it.", tone = Tone.WARN, glyph = Glyph.ALERT)
        }
        BluetoothStatus.READY, BluetoothStatus.UNKNOWN -> Unit
    }
    header("Boards in reach")
    if (state.scanning) {
        item(key = "scanning") { Busy("Looking for boards…") }
    } else if (state.boards.isEmpty()) {
        item(key = "no-boards") { OneLine("No board found yet.") }
    }
    for (found in state.boards) {
        item(key = "board-${found.address}") {
            ListRow(
                headline = found.name ?: "A device with no name",
                supporting = if (found.isCranium) "Signal ${found.rssi} dBm" else "Not named like a Cranium board · signal ${found.rssi} dBm",
                mono = found.name != null,
                leading = { GlyphIcon(Glyph.BLUETOOTH, tint = if (found.isCranium) console.accent else console.ink3) },
                onClick = { flow.connect(found) },
            )
        }
    }
}

private fun LazyListScope.boardStep(flow: BluetoothFlow, state: BtState, store: Store) {
    val board = state.board ?: return
    when (board.phase) {
        BoardPhase.CONNECTING, BoardPhase.READING -> {
            item(key = "busy") { Busy(if (board.phase == BoardPhase.CONNECTING) "Connecting and pairing…" else "Reading what the board runs…") }
            item(key = "passkey") {
                Box(Modifier.padding(horizontal = Gutter, vertical = 8.dp)) {
                    InkPanel {
                        Eyebrow("Passkey")
                        Spacer(Modifier.height(8.dp))
                        Text("When the phone asks to pair, paste the passkey: it is on the clipboard, and at the top of the screen.", style = ConsoleType.body, color = console.ink)
                        board.passkey?.let { passkey ->
                            Text(
                                passkey.chunked(3).joinToString(" "),
                                Modifier.padding(vertical = 10.dp).semantics { liveRegion = LiveRegionMode.Polite },
                                style = ConsoleType.figure.copy(fontFamily = ConsoleType.Mono, fontSize = 44.sp),
                                color = console.ink,
                            )
                            board.consoleThing?.let { Text(Messages.boardInConsole(it), style = ConsoleType.mono, color = console.ink2) }
                        }
                        board.passkeyNote?.let {
                            Text(prose(it), Modifier.padding(top = 8.dp), style = ConsoleType.note, color = console.ink2)
                        }
                    }
                }
            }
        }
        BoardPhase.READY, BoardPhase.DOWNLOADING, BoardPhase.CHECKING, BoardPhase.CONFIRMING -> {
            item(key = "runs") { ValueRow("The board runs", board.running.orEmpty(), mono = true) }
            if (board.offer.isNotEmpty()) {
                header("Newer releases")
                for (release in board.offer) {
                    item(key = "offer-${release.version}") {
                        ReleaseChoice(
                            release, release.version == board.selected, release == board.offer.firstOrNull(), store.cache.holds(release),
                            enabled = board.phase == BoardPhase.READY,
                        ) { flow.chooseOffer(release.version) }
                    }
                }
            }
            when (board.phase) {
                BoardPhase.DOWNLOADING -> item(key = "step") { Busy("Downloading ${board.selected} from the console…") }
                BoardPhase.CHECKING -> item(key = "step") { Busy("Checking the image of ${board.selected}…") }
                BoardPhase.CONFIRMING -> item(key = "step") { Busy("Asking the console whether ${board.selected} may still be sent…") }
                else -> Unit
            }
        }
        BoardPhase.UPLOADING -> {
            item(key = "upload") {
                val percent = if (board.total > 0) (board.sent * 100L / board.total).toInt() else 0
                Column(Modifier.fillMaxWidth().padding(horizontal = Gutter, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(
                        prose("Sending ${board.selected} to the board. Keep the phone near it."),
                        style = ConsoleType.body.copy(fontWeight = FontWeight.SemiBold),
                        color = console.ink,
                    )
                    Meter(percent, "Upload to the board")
                    Text(
                        "${Messages.kilobytes(board.sent.toLong())} of ${Messages.kilobytes(board.total.toLong())} ($percent %)",
                        style = ConsoleType.small,
                        color = console.ink2,
                    )
                    board.image?.let { Text(Messages.imageOrigin(it), style = ConsoleType.note, color = console.ink3) }
                }
            }
        }
        BoardPhase.FAILED -> Unit
    }
}

private fun LazyListScope.doneStep(state: BtState) {
    val done = state.done ?: return
    val timeline = done.timeline
    item(key = "arrived") {
        Column(Modifier.fillMaxWidth().padding(horizontal = Gutter, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(prose("${done.version} to ${done.boardName}"), style = ConsoleType.sectionTitle, color = console.ink)
            WatchSteps(timeline)
            if (timeline.waitingForButton) {
                InkPanel {
                    Eyebrow("Now, at the board")
                    Spacer(Modifier.height(8.dp))
                    Countdown(timeline.deadline)
                    Spacer(Modifier.height(12.dp))
                    Keys()
                }
            }
            timeline.note?.let {
                Text(prose(it), Modifier.semantics { liveRegion = LiveRegionMode.Polite }, style = ConsoleType.small, color = console.ink)
            }
            done.image?.let { Text(Messages.imageOrigin(it), style = ConsoleType.note, color = console.ink3) }
        }
    }
}

/** The steps after the send, each with the time it happened (core/UpdateWatch.kt). */
@Composable
private fun WatchSteps(timeline: UpdateWatch.Timeline) {
    val colors = console
    val icons = mapOf(
        UpdateWatch.Step.SENT to Glyph.SEND, UpdateWatch.Step.BUTTON to Glyph.PRESS, UpdateWatch.Step.INSTALLING to Glyph.RESTART,
        UpdateWatch.Step.TRIAL to Glyph.PULSE, UpdateWatch.Step.END to Glyph.CHECK_CIRCLE,
    )
    Column(Modifier.fillMaxWidth().semantics { contentDescription = "Steps of the update" }, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        for (row in timeline.rows) {
            val icon = icons.getValue(row.step)
            val (mark, tint, fill) = when (row.state) {
                UpdateWatch.State.DONE -> Triple(Glyph.CHECK, colors.ink, colors.well)
                UpdateWatch.State.CURRENT -> Triple(icon, colors.toneInk(Tone.LIVE), colors.toneWash(Tone.LIVE).takeIf { it != Color.Transparent } ?: colors.well)
                UpdateWatch.State.LIKELY -> Triple(icon, colors.toneInk(Tone.WAIT), colors.toneWash(Tone.WAIT).takeIf { it != Color.Transparent } ?: colors.well)
                UpdateWatch.State.FAILED -> Triple(
                    if (row.step == UpdateWatch.Step.END) Glyph.UNDO else Glyph.X,
                    colors.toneInk(Tone.WARN), colors.toneWash(Tone.WARN).takeIf { it != Color.Transparent } ?: colors.well,
                )
                UpdateWatch.State.WAITING -> Triple(icon, colors.ink3, Color.Transparent)
            }
            val waiting = row.state == UpdateWatch.State.WAITING
            val now = row.state == UpdateWatch.State.CURRENT || row.state == UpdateWatch.State.LIKELY || row.state == UpdateWatch.State.FAILED
            Row(
                Modifier.fillMaxWidth().semantics(mergeDescendants = true) { if (now) liveRegion = LiveRegionMode.Polite },
                verticalAlignment = Alignment.Top,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Box(
                    Modifier.size(26.dp).clip(CircleShape).background(fill).border(1.dp, if (waiting) colors.line else tint, CircleShape),
                    contentAlignment = Alignment.Center,
                ) { GlyphIcon(mark, size = 15.dp, tint = tint) }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(
                        prose(row.title),
                        style = ConsoleType.small.copy(fontWeight = if (now) FontWeight.SemiBold else FontWeight.Normal),
                        color = if (waiting) colors.ink3 else colors.ink,
                    )
                    row.detail?.let { Text(prose(it), style = ConsoleType.note, color = colors.ink2) }
                }
                row.at?.let { Text(BoardLog.secondOfDay(Times.iso(it)), style = ConsoleType.note, color = colors.ink3) }
            }
        }
    }
}

/** The board's 2 minutes, to the second, from the end of the upload. */
@Composable
private fun Countdown(deadline: Long) {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(deadline) {
        while (now < deadline) {
            delay(1_000)
            now = System.currentTimeMillis()
        }
    }
    val left = ((deadline - now + 999) / 1_000).toInt().coerceAtLeast(0)
    Text(UpdateWatch.countdown(left), style = ConsoleType.lede.copy(fontWeight = FontWeight.SemiBold), color = console.ink)
}

/** The two buttons on the board: Button 1 installs, Button 2 declines. */
@Composable
private fun Keys() {
    val colors = console
    Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        listOf(true to "Button 1 installs", false to "Button 2 declines").forEach { (lit, words) ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Box(
                    Modifier
                        .size(22.dp)
                        .clip(CircleShape)
                        .background(if (lit) colors.accent else colors.well)
                        .border(1.dp, colors.lineMark, CircleShape)
                        .clearAndSetSemantics {},
                )
                Text(words, style = ConsoleType.small.copy(fontWeight = if (lit) FontWeight.SemiBold else FontWeight.Normal), color = colors.ink)
            }
        }
    }
}

@Composable
private fun Busy(text: String) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = Gutter, vertical = 12.dp).semantics { liveRegion = LiveRegionMode.Polite },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = console.accent)
        Text(text, style = ConsoleType.small, color = console.ink)
    }
}
