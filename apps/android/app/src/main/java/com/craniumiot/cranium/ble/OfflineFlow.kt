package com.craniumiot.cranium.ble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothProfile
import android.content.Context
import android.os.Build
import com.craniumiot.cranium.core.OfflineStatus
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.UUID

/** Where the offline screen is. */
enum class OfflineStep { FIND_BOARD, BOARD }

enum class OfflinePhase { CONNECTING, PAIRING, READY, FAILED }

data class OfflineState(
    val step: OfflineStep = OfflineStep.FIND_BOARD,
    val boards: List<FoundBoard> = emptyList(),
    val scanning: Boolean = false,
    val bluetooth: BluetoothStatus = BluetoothStatus.UNKNOWN,
    val name: String? = null,
    val phase: OfflinePhase = OfflinePhase.CONNECTING,
    val status: OfflineStatus? = null,
    val message: String? = null,
    /** The person is asked whether to accept the version that waits. */
    val confirming: Boolean = false,
    val accepted: Boolean = false,
)

/**
 * Offline mode (firmware 1.19.0, docs/mobile-apps.md, "Offline mode"): the phone talks to a board
 * directly, with no internet. It scans for boards with their Bluetooth window open, connects, reads the
 * offline status (which makes the phone ask for the board's passkey, the one that Board setup showed
 * once), and writes "accept" for the update that waits. The passkey never passes through this app.
 * Nothing is bonded by the board, so the next window asks again.
 *
 * Callbacks are handed to [scope], the main thread's.
 */
@SuppressLint("MissingPermission")
class OfflineFlow(
    private val context: Context,
    private val scope: CoroutineScope,
) {
    private val scanner = BoardScanner(context)
    private val _state = MutableStateFlow(OfflineState())
    val state: StateFlow<OfflineState> = _state

    private var gatt: BluetoothGatt? = null
    private var refreshing: Job? = null
    private var watchdog: Job? = null
    private var ended = true

    init {
        scope.launch { scanner.boards.collect { found -> _state.update { it.copy(boards = found) } } }
        scope.launch {
            scanner.failure.collect { problem -> if (problem != null) _state.update { it.copy(message = problem) } }
        }
    }

    fun lookForBoards() {
        leave(keepMessage = false)
        val status = when {
            !scanner.hasBluetooth -> BluetoothStatus.NO_BLUETOOTH
            !BlePermissions.granted(context) -> BluetoothStatus.NEEDS_PERMISSION
            !scanner.isBluetoothOn -> BluetoothStatus.OFF
            BlePermissions.locationNeededButOff(context) -> BluetoothStatus.LOCATION_OFF
            else -> BluetoothStatus.READY
        }
        _state.update { it.copy(step = OfflineStep.FIND_BOARD, bluetooth = status, message = null) }
        if (status != BluetoothStatus.READY && status != BluetoothStatus.LOCATION_OFF) return
        val started = scanner.start()
        _state.update { it.copy(scanning = started) }
    }

    fun onPermissionDenied() {
        _state.update { it.copy(bluetooth = BluetoothStatus.NEEDS_PERMISSION) }
    }

    fun connect(found: FoundBoard) {
        scanner.stop()
        ended = false
        _state.update {
            it.copy(
                step = OfflineStep.BOARD, scanning = false, name = found.name, phase = OfflinePhase.CONNECTING,
                status = null, message = null, confirming = false, accepted = false,
            )
        }
        gatt = found.device.connectGatt(context.applicationContext, false, callback, BluetoothDevice.TRANSPORT_LE)
        if (gatt == null) fail("Could not connect to the board.")
        arm("The board did not answer. Hold its button 1 for five seconds to open Bluetooth again.")
    }

    fun askToAccept() = _state.update { if (it.status?.canAccept == true) it.copy(confirming = true) else it }

    fun dismissConfirm() = _state.update { it.copy(confirming = false) }

    /** The person confirmed the version they were shown. */
    fun accept() {
        val version = _state.value.status?.waiting
        _state.update { it.copy(confirming = false) }
        val request = version?.let { OfflineStatus.acceptRequest(it) }
        val control = gatt?.getService(SERVICE)?.getCharacteristic(CONTROL)
        val link = gatt
        if (request == null || control == null || link == null) {
            _state.update { it.copy(message = "This board cannot take that.") }
            return
        }
        val started = if (Build.VERSION.SDK_INT >= 33) {
            link.writeCharacteristic(control, request, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) == BluetoothGatt.GATT_SUCCESS
        } else {
            @Suppress("DEPRECATION")
            run {
                control.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                control.value = request
                link.writeCharacteristic(control)
            }
        }
        if (!started) _state.update { it.copy(message = "The phone could not send that. Try again.") }
    }

    fun backToBoards() = lookForBoards()

    /** Lets go of the link and the scan. */
    fun stop() {
        leave(keepMessage = false)
        scanner.stop()
        _state.update { OfflineState(bluetooth = it.bluetooth) }
    }

    // MARK: -

    private fun leave(keepMessage: Boolean) {
        ended = true
        refreshing?.cancel()
        watchdog?.cancel()
        val current = gatt
        gatt = null
        if (current != null) {
            runCatching { current.disconnect() }
            runCatching { current.close() }
        }
        if (!keepMessage) _state.update { it.copy(message = null) }
    }

    private fun fail(text: String) {
        if (ended) return
        leave(keepMessage = true)
        scope.launch { _state.update { it.copy(phase = OfflinePhase.FAILED, message = text, confirming = false) } }
    }

    private fun arm(text: String) {
        watchdog?.cancel()
        watchdog = scope.launch {
            delay(STEP_TIMEOUT_MS)
            fail(text)
        }
    }

    private fun readStatus() {
        val link = gatt ?: return
        val characteristic = link.getService(SERVICE)?.getCharacteristic(STATUS) ?: return
        if (!link.readCharacteristic(characteristic)) fail("The phone could not read the board.")
    }

    private fun deliver(value: ByteArray?) {
        val status = value?.let { OfflineStatus.parse(it) }
        scope.launch {
            if (ended) return@launch
            if (status == null) {
                fail("The board sent something this app cannot read. Update the app.")
                return@launch
            }
            watchdog?.cancel()
            _state.update { it.copy(phase = OfflinePhase.READY, status = status, message = if (it.accepted) null else it.message) }
            if (refreshing == null || refreshing?.isActive != true) {
                refreshing = scope.launch {
                    while (true) {
                        delay(REFRESH_MS)
                        readStatus()
                    }
                }
            }
        }
    }

    private val callback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                scope.launch { _state.update { it.copy(phase = OfflinePhase.PAIRING) } }
                if (!g.discoverServices()) scope.launch { fail("Could not look at the board.") }
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED || status != BluetoothGatt.GATT_SUCCESS) {
                scope.launch { fail("The board closed the link. It does that when its Bluetooth window ends.") }
            }
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            val service = g.getService(SERVICE)
            if (status != BluetoothGatt.GATT_SUCCESS || service?.getCharacteristic(STATUS) == null || service.getCharacteristic(CONTROL) == null) {
                scope.launch { fail("This board's firmware has no offline mode. It needs 1.19.0 or later.") }
                return
            }
            // The first read is what makes the phone pair: it asks for the passkey and retries it.
            scope.launch {
                arm("The board did not pair. Check the passkey, and open Bluetooth on the board again.")
                readStatus()
            }
        }

        override fun onCharacteristicRead(g: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray, status: Int) {
            handleRead(c, value, status)
        }

        @Deprecated("Before Android 13")
        @Suppress("DEPRECATION")
        override fun onCharacteristicRead(g: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) {
            if (Build.VERSION.SDK_INT < 33) handleRead(c, c.value, status)
        }

        private fun handleRead(c: BluetoothGattCharacteristic, value: ByteArray?, status: Int) {
            if (c.uuid != STATUS) return
            if (status == BluetoothGatt.GATT_SUCCESS) deliver(value) else scope.launch { fail(wordsForGattStatus(status)) }
        }

        override fun onCharacteristicWrite(g: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) {
            if (c.uuid != CONTROL) return
            scope.launch {
                if (status == BluetoothGatt.GATT_SUCCESS) {
                    _state.update { it.copy(accepted = true, message = null) }
                    readStatus()
                } else {
                    val text = if (status == ATT_UNLIKELY) {
                        "That update no longer waits. Look at the board's status again."
                    } else {
                        wordsForGattStatus(status)
                    }
                    _state.update { it.copy(message = text) }
                }
            }
        }
    }

    companion object {
        val SERVICE: UUID = UUID.fromString(OfflineStatus.SERVICE_UUID)
        val STATUS: UUID = UUID.fromString(OfflineStatus.STATUS_UUID)
        val CONTROL: UUID = UUID.fromString(OfflineStatus.CONTROL_UUID)
        private const val STEP_TIMEOUT_MS = 40_000L
        private const val REFRESH_MS = 3_000L
        private const val ATT_UNLIKELY = 0x0e

        /** What to tell the person for a GATT status the board answered with. */
        fun wordsForGattStatus(status: Int): String = when (status) {
            // Insufficient authentication or encryption: the passkey was not accepted.
            5, 15 -> "The board needs its passkey. Try again and type the passkey that Board setup showed."
            ATT_UNLIKELY -> "The board refused that."
            else -> "The board refused (code $status)."
        }
    }
}
