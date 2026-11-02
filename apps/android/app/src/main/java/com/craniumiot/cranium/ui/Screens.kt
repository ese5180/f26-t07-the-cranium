package com.craniumiot.cranium.ui

import android.bluetooth.BluetoothAdapter
import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.craniumiot.cranium.ble.BlePermissions
import com.craniumiot.cranium.ble.FoundBoard
import com.craniumiot.cranium.core.Release

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CraniumApp(vm: CraniumViewModel) {
    val state by vm.state.collectAsStateWithLifecycle()

    val signIn = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        vm.onSignInResult(result.data)
    }
    val permissions = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        if (granted.values.all { it }) vm.lookForBoards() else vm.onPermissionDenied()
    }
    val enableBluetooth = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        vm.lookForBoards()
    }

    BackHandler(enabled = state.step == Step.FIND_BOARD || state.step == Step.BOARD || state.step == Step.DONE) {
        when (state.step) {
            Step.FIND_BOARD, Step.DONE -> vm.backToReleases()
            Step.BOARD -> vm.leaveBoard()
            else -> Unit
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Cranium") },
                actions = {
                    if (state.step == Step.RELEASES) TextButton(onClick = vm::signOut) { Text("Sign out") }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier
                .padding(padding)
                .fillMaxSize()
                .padding(horizontal = 16.dp),
        ) {
            if (state.exampleConfig) ExampleConfigCard()
            state.notice?.let { NoticeCard(it, onDismiss = vm::dismissNotice) }
            when (state.step) {
                Step.STARTING -> Busy("Starting…")
                Step.SIGN_IN -> SignInScreen(state, onSignIn = { vm.signInIntent()?.let(signIn::launch) })
                Step.RELEASES -> ReleasesScreen(state, vm::choose, vm::refreshReleases, vm::toFindBoard, vm::clearFirmware)
                Step.FIND_BOARD -> FindBoardScreen(
                    state,
                    onAllow = { permissions.launch(BlePermissions.required()) },
                    onTurnOn = { enableBluetooth.launch(Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE)) },
                    onLookAgain = vm::lookForBoards,
                    onPick = vm::connect,
                    onBack = vm::backToReleases,
                )
                Step.BOARD -> BoardScreen(
                    state,
                    onChoose = vm::chooseOffer,
                    onSend = vm::send,
                    onCancel = vm::cancelUpload,
                    onLeave = vm::leaveBoard,
                    onFindAgain = vm::toFindBoard,
                    onBackToReleases = vm::backToReleases,
                )
                Step.DONE -> DoneScreen(state, onAnother = vm::backToReleases)
            }
        }
    }
}

@Composable
private fun ColumnScope.SignInScreen(state: UiState, onSignIn: () -> Unit) {
    Column(
        Modifier
            .weight(1f)
            .fillMaxWidth(),
        verticalArrangement = Arrangement.Center,
    ) {
        Text("Update a board over Bluetooth", style = MaterialTheme.typography.headlineSmall)
        Text(
            "Sign in with your console account. Only a release manager can download firmware.",
            style = MaterialTheme.typography.bodyLarge,
            modifier = Modifier.padding(vertical = 16.dp),
        )
        val busy = state.busy
        if (busy != null) Busy(busy) else Button(onClick = onSignIn, modifier = Modifier.fillMaxWidth()) { Text("Sign in") }
    }
}

@Composable
private fun ColumnScope.ReleasesScreen(
    state: UiState,
    onChoose: (String) -> Unit,
    onRefresh: () -> Unit,
    onNext: () -> Unit,
    onClearFirmware: () -> Unit,
) {
    state.me?.let { me ->
        Text("Signed in as ${me.email.ifEmpty { "an account with no email" }}", style = MaterialTheme.typography.bodyMedium)
        if (!me.canWrite) {
            Text(
                "This account is not a release manager, so the console will not hand out firmware. " +
                    "Ask an administrator for the role.",
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(top = 4.dp),
            )
        }
    }
    if (state.firmware.count > 0) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                Messages.firmwareOnPhone(state.firmware),
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = onClearFirmware, enabled = state.busy == null) { Text("Clear downloaded firmware") }
        }
    }
    Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("Firmware releases", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
        TextButton(onClick = onRefresh, enabled = state.busy == null) { Text("Refresh") }
    }
    Text(
        "Active releases, newest first. The board only takes one newer than what it runs.",
        style = MaterialTheme.typography.bodySmall,
    )
    state.busy?.let { Busy(it) }
    LazyColumn(Modifier.weight(1f)) {
        items(state.releases, key = { it.version }) { release ->
            ReleaseRow(
                release = release,
                selected = release.version == state.chosen,
                newest = release == state.releases.firstOrNull(),
                onPhone = state.firmware.holds(release),
                enabled = true,
                onClick = { onChoose(release.version) },
            )
            HorizontalDivider()
        }
    }
    Button(
        onClick = onNext,
        enabled = state.chosen != null && state.busy == null,
        modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp),
    ) { Text("Next: find the board") }
}

@Composable
private fun ColumnScope.FindBoardScreen(
    state: UiState,
    onAllow: () -> Unit,
    onTurnOn: () -> Unit,
    onLookAgain: () -> Unit,
    onPick: (FoundBoard) -> Unit,
    onBack: () -> Unit,
) {
    Card(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
        Column(Modifier.padding(16.dp)) {
            Text("At the board", style = MaterialTheme.typography.titleMedium)
            Text("1. Hold Button 1 for 5 s and let go.")
            Text("2. LED1 flashes four times: Bluetooth is open for 2 minutes.")
            Text("3. Pick the board below: Cranium- and four hex digits.")
        }
    }
    when (state.bluetooth) {
        BluetoothStatus.NO_BLUETOOTH -> Text("This phone has no Bluetooth LE.")
        BluetoothStatus.NEEDS_PERMISSION -> {
            Text("The app needs the Bluetooth permission to find the board.")
            Button(onClick = onAllow, modifier = Modifier.padding(vertical = 8.dp)) { Text("Allow Bluetooth") }
        }
        BluetoothStatus.OFF -> {
            Text("Bluetooth is off.")
            Button(onClick = onTurnOn, modifier = Modifier.padding(vertical = 8.dp)) { Text("Turn on Bluetooth") }
        }
        BluetoothStatus.LOCATION_OFF ->
            Text("Turn on Location: Android 11 and older find no Bluetooth devices without it.")
        BluetoothStatus.READY, BluetoothStatus.UNKNOWN -> Unit
    }
    if (state.scanning) Busy("Looking for boards…")
    LazyColumn(Modifier.weight(1f)) {
        items(state.boards, key = { it.address }) { board ->
            ListItem(
                headlineContent = { Text(board.name ?: "A device with no name") },
                supportingContent = {
                    Text(
                        if (board.isCranium) "Signal ${board.rssi} dBm"
                        else "Not named like a Cranium board · signal ${board.rssi} dBm",
                    )
                },
                modifier = Modifier.clickable { onPick(board) },
            )
            HorizontalDivider()
        }
    }
    Row(Modifier.fillMaxWidth().padding(vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        OutlinedButton(onClick = onBack, modifier = Modifier.weight(1f)) { Text("Back") }
        Button(
            onClick = onLookAgain,
            enabled = !state.scanning,
            modifier = Modifier.weight(1f),
        ) { Text("Look again") }
    }
}

@Composable
private fun ColumnScope.BoardScreen(
    state: UiState,
    onChoose: (String) -> Unit,
    onSend: () -> Unit,
    onCancel: () -> Unit,
    onLeave: () -> Unit,
    onFindAgain: () -> Unit,
    onBackToReleases: () -> Unit,
) {
    val board = state.board ?: return
    Text(board.name, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(vertical = 8.dp))
    when (board.phase) {
        BoardPhase.CONNECTING, BoardPhase.READING -> {
            Busy(if (board.phase == BoardPhase.CONNECTING) "Connecting and pairing…" else "Reading what the board runs…")
            PasskeyCard(board)
            Spacer(Modifier.weight(1f))
            OutlinedButton(onClick = onLeave, modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp)) { Text("Stop") }
        }
        BoardPhase.READY, BoardPhase.DOWNLOADING, BoardPhase.CHECKING -> {
            Text("The board runs ${board.running}.", style = MaterialTheme.typography.bodyLarge)
            if (board.offer.isNotEmpty()) {
                Text(
                    "Releases newer than that:",
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.padding(top = 12.dp),
                )
                LazyColumn(Modifier.weight(1f)) {
                    items(board.offer, key = { it.version }) { release ->
                        ReleaseRow(
                            release = release,
                            selected = release.version == board.selected,
                            newest = release == board.offer.firstOrNull(),
                            onPhone = state.firmware.holds(release),
                            enabled = board.phase == BoardPhase.READY,
                            onClick = { onChoose(release.version) },
                        )
                        HorizontalDivider()
                    }
                }
                when (board.phase) {
                    BoardPhase.DOWNLOADING -> Busy("Downloading ${board.selected} from the console…")
                    BoardPhase.CHECKING -> Busy("Checking the image of ${board.selected}…")
                    else -> Unit
                }
                Button(
                    onClick = onSend,
                    enabled = board.phase == BoardPhase.READY && board.selected != null,
                    modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                ) { Text("Send ${board.selected.orEmpty()}") }
            } else {
                Spacer(Modifier.weight(1f))
            }
            OutlinedButton(onClick = onLeave, modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp)) { Text("Disconnect") }
        }
        BoardPhase.UPLOADING -> {
            Text(
                "Sending ${board.selected} to the board. It takes a few minutes: keep the phone near the board.",
                style = MaterialTheme.typography.bodyLarge,
            )
            val fraction = if (board.total > 0) board.sent.toFloat() / board.total else 0f
            LinearProgressIndicator(progress = { fraction }, modifier = Modifier.fillMaxWidth().padding(vertical = 16.dp))
            Text("${kilobytes(board.sent.toLong())} of ${kilobytes(board.total.toLong())} (${(fraction * 100).toInt()} %)")
            board.image?.let {
                Text(Messages.imageOrigin(it), style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp))
            }
            Spacer(Modifier.weight(1f))
            OutlinedButton(onClick = onCancel, modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp)) { Text("Cancel") }
        }
        BoardPhase.FAILED -> {
            Spacer(Modifier.weight(1f))
            Button(onClick = onFindAgain, modifier = Modifier.fillMaxWidth()) { Text("Look for the board again") }
            OutlinedButton(onClick = onBackToReleases, modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp)) {
                Text("Back to releases")
            }
        }
    }
}

@Composable
private fun ColumnScope.DoneScreen(state: UiState, onAnother: () -> Unit) {
    val done = state.done ?: return
    Text(
        "${done.version} has arrived on ${done.boardName}.",
        style = MaterialTheme.typography.headlineSmall,
        modifier = Modifier.padding(vertical = 8.dp),
    )
    Card(
        Modifier.fillMaxWidth().padding(vertical = 8.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer),
    ) {
        Column(Modifier.padding(16.dp)) {
            Text("Now, at the board", style = MaterialTheme.typography.titleMedium)
            Text(
                "Press Button 1 within 2 minutes to install it. Button 2 throws it away.",
                style = MaterialTheme.typography.bodyLarge,
            )
        }
    }
    Text("The board restarts and runs the new image on trial. It keeps it once it reaches AWS IoT.")
    done.image?.let {
        Text(Messages.imageOrigin(it), style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp))
    }
    done.status?.let {
        Text(it, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 12.dp))
    }
    Text(
        "The board's own LEDs and console are the real answer.",
        style = MaterialTheme.typography.bodySmall,
        modifier = Modifier.padding(top = 8.dp),
    )
    Spacer(Modifier.weight(1f))
    Button(onClick = onAnother, modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp)) { Text("Update another board") }
}

@Composable
private fun PasskeyCard(board: BoardUi) {
    Card(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
        Column(Modifier.padding(16.dp)) {
            Text("Pairing", style = MaterialTheme.typography.titleMedium)
            Text("When the phone asks to pair, type the 6-digit passkey the board shows.")
            board.passkey?.let {
                Text(
                    it.chunked(3).joinToString(" "),
                    style = MaterialTheme.typography.displayMedium,
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier.padding(vertical = 8.dp),
                )
            }
            board.passkeyNote?.let { Text(it, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 8.dp)) }
        }
    }
}

@Composable
private fun ReleaseRow(
    release: Release,
    selected: Boolean,
    newest: Boolean,
    onPhone: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = onClick)
            .padding(vertical = 8.dp),
        verticalAlignment = Alignment.Top,
    ) {
        RadioButton(selected = selected, onClick = null, enabled = enabled)
        Column(Modifier.padding(start = 12.dp)) {
            Text(
                if (newest) "${release.version}  (newest)" else release.version,
                style = MaterialTheme.typography.titleMedium,
            )
            Text(
                listOf(kilobytes(release.size), release.uploadedAt.take(10), if (onPhone) "on this phone" else "")
                    .filter { it.isNotEmpty() }
                    .joinToString(" · "),
                style = MaterialTheme.typography.bodySmall,
            )
            if (release.notes.isNotBlank()) {
                Text(release.notes, style = MaterialTheme.typography.bodySmall, maxLines = 3, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

@Composable
private fun NoticeCard(notice: Notice, onDismiss: () -> Unit) {
    val colors = if (notice.isError) {
        CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)
    } else {
        CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)
    }
    Card(Modifier.fillMaxWidth().padding(vertical = 8.dp), colors = colors) {
        Row(Modifier.padding(start = 16.dp, top = 8.dp, bottom = 8.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(notice.text, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
            TextButton(onClick = onDismiss) { Text("OK") }
        }
    }
}

@Composable
private fun ExampleConfigCard() {
    Card(
        Modifier.fillMaxWidth().padding(vertical = 8.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer),
    ) {
        Text(
            "This build has the example configuration, so sign-in will not work. " +
                "Run apps/configure.sh and build again.",
            modifier = Modifier.padding(16.dp),
            style = MaterialTheme.typography.bodyMedium,
        )
    }
}

@Composable
private fun Busy(text: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
        Text(text, modifier = Modifier.padding(start = 12.dp))
    }
}

private fun kilobytes(bytes: Long): String = Messages.kilobytes(bytes)
