package com.craniumiot.cranium.ui

import android.bluetooth.BluetoothAdapter
import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
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
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.craniumiot.cranium.ble.BlePermissions
import com.craniumiot.cranium.ble.BluetoothStatus
import com.craniumiot.cranium.ble.BoardPhase
import com.craniumiot.cranium.ble.BtState
import com.craniumiot.cranium.ble.BtStep
import com.craniumiot.cranium.core.Glyph
import com.craniumiot.cranium.core.Release
import com.craniumiot.cranium.core.Tone
import com.craniumiot.cranium.core.Words

/** The update over Bluetooth (docs/mobile-apps.md): choose, find the board, pair, send, press Button 1. */
@Composable
fun BluetoothScreen(vm: ConsoleViewModel, store: Store) {
    val flow = vm.bluetooth
    val state by flow.state.collectAsStateWithLifecycle()
    val permissions = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        if (granted.values.all { it }) flow.lookForBoards() else flow.onPermissionDenied()
    }
    val enable = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { flow.lookForBoards() }

    PageHead(
        "Update over Bluetooth",
        eyebrow = "This phone",
        lede = "Send a release that is on AWS to a board in reach. The board checks the signature and asks for Button 1 before " +
            "it installs anything, and the new firmware runs on trial.",
    )
    if (store.me?.canWrite != true) {
        Section {
            EmptyState(
                Glyph.LOCK, "Only a release manager can send firmware.",
                "The console hands out a release's image only to a release manager. Ask an administrator for the role.",
            )
        }
        return
    }
    state.notice?.let { notice ->
        Notice(
            if (notice.isError) Tone.BAD else Tone.IDLE, if (notice.isError) Glyph.ALERT else Glyph.CHECK_CIRCLE, notice.text,
            Modifier.padding(bottom = 16.dp),
            action = { ConsoleButton("OK", flow::dismissNotice, small = true, kind = ButtonKind.QUIET) },
        )
    }
    when (state.step) {
        BtStep.CHOOSE -> Choose(vm, state, store)
        BtStep.FIND_BOARD -> FindBoard(
            state,
            onAllow = { permissions.launch(BlePermissions.required()) },
            onTurnOn = { enable.launch(Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE)) },
            onLookAgain = flow::lookForBoards,
            onBack = flow::backToChoose,
            onPick = flow::connect,
        )
        BtStep.BOARD -> Board(vm, state, store)
        BtStep.DONE -> Done(vm, state)
    }
}

@Composable
private fun Choose(vm: ConsoleViewModel, state: BtState, store: Store) {
    val flow = vm.bluetooth
    Section(title = "Release") {
        if (state.releases.isEmpty()) {
            if (store.firmware.value == null) Loading("the releases") else Quiet("There is no active release on the console.")
        }
        Note("Active releases, newest first. The board only takes one newer than what it runs.", Modifier.padding(bottom = 8.dp))
        for (release in state.releases) {
            Choice(release.version == state.chosen, { flow.choose(release.version) }, radio = true) {
                ReleaseWords(release, newest = release == state.releases.firstOrNull(), onPhone = store.cache.holds(release))
            }
            Spacer(Modifier.height(8.dp))
        }
        Note(Messages.firmwareOnPhone(store.cache))
        if (store.cache.count > 0) ConsoleButton("Clear downloaded firmware", vm::clearFirmware, small = true, kind = ButtonKind.QUIET)
    }
    InkPanel(Modifier.padding(bottom = 16.dp)) {
        Eyebrow("At the board")
        Spacer(Modifier.height(8.dp))
        Text("1. Hold Button 1 for 5 s and let go.", style = ConsoleType.body, color = console.ink)
        Text("2. LED1 flashes four times: Bluetooth is open for 3 minutes (2 before firmware 1.11.2).", style = ConsoleType.body, color = console.ink)
        Text("3. Find the board here: Cranium- and four hex digits.", style = ConsoleType.body, color = console.ink)
        Spacer(Modifier.height(12.dp))
        ConsoleButton("Find the board", vm.bluetooth::toFindBoard, kind = ButtonKind.PRIMARY, glyph = Glyph.BLUETOOTH, enabled = state.chosen != null)
    }
}

@Composable
private fun ReleaseWords(release: Release, newest: Boolean, onPhone: Boolean) {
    Wrap {
        Mono(release.version, style = ConsoleType.mono.copy(fontWeight = FontWeight.SemiBold))
        if (newest) Tag("Newest")
        if (onPhone) Tag("On this phone")
    }
    Note(listOf(Words.fileSize(release.size), release.uploadedAt.take(10)).filter { it.isNotEmpty() }.joinToString(" · "))
    if (release.notes.isNotBlank()) Note(release.notes)
}

@Composable
private fun FindBoard(
    state: BtState,
    onAllow: () -> Unit,
    onTurnOn: () -> Unit,
    onLookAgain: () -> Unit,
    onBack: () -> Unit,
    onPick: (com.craniumiot.cranium.ble.FoundBoard) -> Unit,
) {
    val colors = console
    InkPanel(Modifier.padding(bottom = 16.dp)) {
        Eyebrow("At the board")
        Spacer(Modifier.height(8.dp))
        Text("Hold Button 1 for 5 s and let go. LED1 flashes four times: Bluetooth is open. Pick the board below.", style = ConsoleType.body, color = console.ink)
    }
    when (state.bluetooth) {
        BluetoothStatus.NO_BLUETOOTH -> Notice(Tone.BAD, Glyph.ALERT, "This phone has no Bluetooth LE.")
        BluetoothStatus.NEEDS_PERMISSION -> Notice(
            Tone.WARN, Glyph.LOCK, "The app needs the Bluetooth permission to find the board.",
            action = { ConsoleButton("Allow Bluetooth", onAllow, small = true, kind = ButtonKind.PRIMARY) },
        )
        BluetoothStatus.OFF -> Notice(
            Tone.WARN, Glyph.BLUETOOTH, "Bluetooth is off.",
            action = { ConsoleButton("Turn on Bluetooth", onTurnOn, small = true, kind = ButtonKind.PRIMARY) },
        )
        BluetoothStatus.LOCATION_OFF -> Notice(Tone.WARN, Glyph.ALERT, "Turn on Location: Android 11 and older find no Bluetooth devices without it.")
        BluetoothStatus.READY, BluetoothStatus.UNKNOWN -> Unit
    }
    Section(title = "Boards in reach") {
        if (state.scanning) {
            Row(Modifier.semantics { liveRegion = LiveRegionMode.Polite }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = colors.accent)
                Text("Looking for boards…", style = ConsoleType.small, color = colors.ink2)
            }
        }
        for (board in state.boards) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .drawBehind { drawLine(colors.line, Offset(0f, 0f), Offset(size.width, 0f), 1.dp.toPx()) }
                    .clickable(role = Role.Button, onClickLabel = "Connect") { onPick(board) }
                    .padding(vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                GlyphIcon(Glyph.BLUETOOTH, tint = if (board.isCranium) colors.accent else colors.ink3)
                Column(Modifier.weight(1f)) {
                    Mono(board.name ?: "A device with no name", style = ConsoleType.mono.copy(fontWeight = FontWeight.SemiBold))
                    Note(if (board.isCranium) "Signal ${board.rssi} dBm" else "Not named like a Cranium board · signal ${board.rssi} dBm")
                }
                GlyphIcon(Glyph.ARROW_RIGHT, tint = colors.ink3)
            }
        }
        Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            ConsoleButton("Back", onBack)
            ConsoleButton("Look again", onLookAgain, kind = ButtonKind.PRIMARY, enabled = !state.scanning, glyph = Glyph.RESTART)
        }
    }
}

@Composable
private fun Board(vm: ConsoleViewModel, state: BtState, store: Store) {
    val flow = vm.bluetooth
    val board = state.board ?: return
    val colors = console
    Text(board.name, Modifier.padding(bottom = 8.dp), style = ConsoleType.pageTitle.copy(fontFamily = ConsoleType.Mono, fontSize = 24.sp), color = colors.ink)
    when (board.phase) {
        BoardPhase.CONNECTING, BoardPhase.READING -> {
            Busy(if (board.phase == BoardPhase.CONNECTING) "Connecting and pairing…" else "Reading what the board runs…")
            InkPanel(Modifier.padding(vertical = 12.dp)) {
                Eyebrow("Pairing")
                Spacer(Modifier.height(8.dp))
                Text("When the phone asks to pair, type the 6-digit passkey the board shows.", style = ConsoleType.body, color = console.ink)
                board.passkey?.let { passkey ->
                    Text(
                        passkey.chunked(3).joinToString(" "),
                        Modifier.padding(vertical = 10.dp).semantics { liveRegion = LiveRegionMode.Polite },
                        style = ConsoleType.figure.copy(fontFamily = ConsoleType.Mono, fontSize = 44.sp),
                        color = console.ink,
                    )
                    board.consoleThing?.let { Text(Messages.boardInConsole(it), style = ConsoleType.mono, color = console.ink2) }
                }
                board.passkeyNote?.let { Note(it, Modifier.padding(top = 8.dp)) }
            }
            ConsoleButton("Stop", flow::leaveBoard)
        }
        BoardPhase.READY, BoardPhase.DOWNLOADING, BoardPhase.CHECKING, BoardPhase.CONFIRMING -> {
            Text("The board runs ${board.running}.", style = ConsoleType.lede, color = colors.ink)
            if (board.offer.isNotEmpty()) {
                Section(title = "Releases newer than that", modifier = Modifier.padding(top = 16.dp)) {
                    for (release in board.offer) {
                        Choice(release.version == board.selected, { flow.chooseOffer(release.version) }, radio = true, enabled = board.phase == BoardPhase.READY) {
                            ReleaseWords(release, newest = release == board.offer.firstOrNull(), onPhone = store.cache.holds(release))
                        }
                        Spacer(Modifier.height(8.dp))
                    }
                    when (board.phase) {
                        BoardPhase.DOWNLOADING -> Busy("Downloading ${board.selected} from the console…")
                        BoardPhase.CHECKING -> Busy("Checking the image of ${board.selected}…")
                        BoardPhase.CONFIRMING -> Busy("Asking the console whether ${board.selected} may still be sent…")
                        else -> Unit
                    }
                    ConsoleButton(
                        "Send ${board.selected.orEmpty()}", flow::send, Modifier.fillMaxWidth(), kind = ButtonKind.PRIMARY, glyph = Glyph.SEND,
                        enabled = board.phase == BoardPhase.READY && board.selected != null,
                    )
                }
            }
            ConsoleButton("Disconnect", flow::leaveBoard, Modifier.fillMaxWidth().padding(top = 12.dp))
        }
        BoardPhase.UPLOADING -> {
            Text(
                "Sending ${board.selected} to the board. It takes a few minutes: keep the phone near the board.",
                style = ConsoleType.lede, color = colors.ink,
            )
            val percent = if (board.total > 0) (board.sent * 100L / board.total).toInt() else 0
            Meter(percent, "Upload to the board", Modifier.padding(vertical = 16.dp))
            Text("${Messages.kilobytes(board.sent.toLong())} of ${Messages.kilobytes(board.total.toLong())} ($percent %)", style = ConsoleType.small, color = colors.ink)
            board.image?.let { Note(Messages.imageOrigin(it), Modifier.padding(top = 8.dp)) }
            ConsoleButton("Cancel", flow::cancelUpload, Modifier.fillMaxWidth().padding(top = 16.dp))
        }
        BoardPhase.FAILED -> {
            ConsoleButton("Look for the board again", flow::toFindBoard, Modifier.fillMaxWidth(), kind = ButtonKind.PRIMARY)
            ConsoleButton("Back to releases", flow::backToChoose, Modifier.fillMaxWidth().padding(top = 12.dp))
        }
    }
}

@Composable
private fun Done(vm: ConsoleViewModel, state: BtState) {
    val done = state.done ?: return
    Text(prose("${done.version} has arrived on ${done.boardName}."), style = ConsoleType.sectionTitle.copy(fontSize = 22.sp), color = console.ink)
    InkPanel(Modifier.padding(vertical = 16.dp)) {
        Eyebrow("Now, at the board")
        Spacer(Modifier.height(8.dp))
        Text("Press Button 1 within 2 minutes to install it. Button 2 throws it away.", style = ConsoleType.lede, color = console.ink)
        Spacer(Modifier.height(12.dp))
        ButtonKeys()
    }
    Text("The board restarts and runs the new image on trial. It keeps it once it reaches AWS IoT.", style = ConsoleType.body, color = console.ink)
    done.image?.let { Note(Messages.imageOrigin(it), Modifier.padding(top = 8.dp)) }
    done.status?.let {
        Text(it, Modifier.padding(top = 12.dp).semantics { liveRegion = LiveRegionMode.Polite }, style = ConsoleType.small, color = console.ink)
    }
    Note("The board's own LEDs and console are the real answer.", Modifier.padding(top = 8.dp))
    ConsoleButton("Update another board", vm.bluetooth::backToChoose, Modifier.fillMaxWidth().padding(top = 16.dp), kind = ButtonKind.PRIMARY)
}

@Composable
private fun Busy(text: String) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 12.dp).semantics { liveRegion = LiveRegionMode.Polite },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = console.accent)
        Text(text, style = ConsoleType.small, color = console.ink)
    }
}
