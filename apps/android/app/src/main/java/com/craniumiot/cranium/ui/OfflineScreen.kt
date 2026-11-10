package com.craniumiot.cranium.ui

import android.bluetooth.BluetoothAdapter
import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.craniumiot.cranium.ble.BlePermissions
import com.craniumiot.cranium.ble.BluetoothStatus
import com.craniumiot.cranium.ble.OfflinePhase
import com.craniumiot.cranium.ble.OfflineStep
import com.craniumiot.cranium.core.Glyph
import com.craniumiot.cranium.core.OfflineStatus
import com.craniumiot.cranium.core.Tone

/**
 * Offline mode (firmware 1.19.0, docs/mobile-apps.md, "Offline mode"): find a board, pair with its
 * passkey, read its status, accept the update that waits. It needs no internet.
 */
@Composable
fun OfflineScreen(vm: ConsoleViewModel) {
    val flow = vm.offline
    val state by flow.state.collectAsStateWithLifecycle()
    val permissions = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        if (granted.values.all { it }) flow.lookForBoards() else flow.onPermissionDenied()
    }
    val enable = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { flow.lookForBoards() }

    val primary: ScreenAction? = when (state.step) {
        OfflineStep.FIND_BOARD -> if (!state.scanning) ScreenAction("Look again", Glyph.RESTART, onClick = flow::lookForBoards) else null
        OfflineStep.BOARD -> when {
            state.phase == OfflinePhase.FAILED -> ScreenAction("Look for the board again", Glyph.BLUETOOTH, onClick = flow::lookForBoards)
            state.status?.canAccept == true -> ScreenAction("Accept the update", Glyph.CHECK_CIRCLE, onClick = flow::askToAccept)
            else -> null
        }
    }
    val actions = buildList {
        if (state.step == OfflineStep.BOARD) add(ScreenAction("Other boards", Glyph.ARROW_LEFT, onClick = flow::backToBoards))
    }

    ConsoleScreen(title = "Offline", subtitle = if (state.step == OfflineStep.BOARD) state.name else null, actions = actions, primary = primary) {
        state.message?.let { text ->
            item(key = "message") { OneLine(text, tone = Tone.BAD, glyph = Glyph.ALERT) }
        }
        when (state.step) {
            OfflineStep.FIND_BOARD -> {
                item(key = "hint") {
                    OneLine(
                        "Hold Button 1 for 5 s and let go: LED1 flashes four times. This talks to the board directly, with no Wi-Fi or " +
                            "internet. The phone asks for the board's passkey, which Board setup showed once.",
                        glyph = Glyph.PRESS,
                    )
                }
                when (state.bluetooth) {
                    BluetoothStatus.NO_BLUETOOTH -> item(key = "bt") { OneLine("This phone has no Bluetooth LE.", tone = Tone.BAD, glyph = Glyph.ALERT) }
                    BluetoothStatus.NEEDS_PERMISSION -> item(key = "bt") {
                        OneLine("The app needs the Bluetooth permission to find the board.", "Allow" to { permissions.launch(BlePermissions.required()) }, Tone.WARN, Glyph.LOCK)
                    }
                    BluetoothStatus.OFF -> item(key = "bt") {
                        OneLine("Bluetooth is off.", "Turn on" to { enable.launch(Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE)) }, Tone.WARN, Glyph.BLUETOOTH)
                    }
                    BluetoothStatus.LOCATION_OFF -> item(key = "bt") {
                        OneLine("Turn on Location: Android 11 and older find no Bluetooth devices without it.", tone = Tone.WARN, glyph = Glyph.ALERT)
                    }
                    BluetoothStatus.READY, BluetoothStatus.UNKNOWN -> Unit
                }
                header("Boards in reach")
                if (state.scanning) {
                    item(key = "scanning") { Waiting("Looking for boards…") }
                } else if (state.boards.isEmpty()) {
                    item(key = "no-boards") { OneLine("No board found yet.") }
                }
                for (found in state.boards) {
                    item(key = "board-${found.address}") {
                        ListRow(
                            headline = found.name ?: "A device with no name",
                            supporting = "Signal ${found.rssi} dBm",
                            mono = found.name != null,
                            leading = { GlyphIcon(Glyph.BLUETOOTH, tint = if (found.isCranium) console.accent else console.ink3) },
                            onClick = { flow.connect(found) },
                        )
                    }
                }
            }
            OfflineStep.BOARD -> when (state.phase) {
                OfflinePhase.CONNECTING -> item(key = "busy") { Waiting("Connecting…") }
                OfflinePhase.PAIRING -> item(key = "busy") { Waiting("Pairing. Type the board's passkey when the phone asks for it.") }
                OfflinePhase.FAILED -> Unit
                OfflinePhase.READY -> state.status?.let { status ->
                    header("Board")
                    item(key = "running") { ValueRow("Firmware", status.running, mono = true) }
                    item(key = "uptime") { ValueRow("Up for", status.uptimeWord) }
                    item(key = "reboot") { ValueRow("Last restart", status.rebootWord) }
                    header("Connection")
                    item(key = "wifi") { ValueRow("Wi-Fi", status.wifiWord) }
                    item(key = "cloud") { ValueRow("Cloud", status.cloudWord) }
                    header("Update")
                    item(key = "update") { OneLine(status.updateWord, glyph = if (status.canAccept) Glyph.DOWNLOAD else null) }
                    if (state.accepted) item(key = "accepted") { OneLine("Accepted. The board installs the update and restarts.", glyph = Glyph.CHECK_CIRCLE) }
                }
            }
        }
    }

    if (state.confirming) {
        val version = state.status?.waiting.orEmpty()
        AlertDialog(
            onDismissRequest = flow::dismissConfirm,
            containerColor = console.surface,
            title = { Text("Install $version?", style = ConsoleType.sectionTitle, color = console.ink) },
            text = {
                Text(
                    "The board restarts into the new version. It goes back to the old one if you do not keep it.",
                    style = ConsoleType.body, color = console.ink,
                )
            },
            confirmButton = { ConsoleButton("Install $version", flow::accept, kind = ButtonKind.PRIMARY, small = true) },
            dismissButton = { ConsoleButton("Not now", flow::dismissConfirm, kind = ButtonKind.QUIET, small = true) },
        )
    }
}

@Composable
private fun Waiting(text: String) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = Gutter, vertical = 12.dp).semantics { liveRegion = LiveRegionMode.Polite },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = console.accent)
        Text(text, style = ConsoleType.small, color = console.ink)
    }
}
