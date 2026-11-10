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
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.UUID

/**
 * Offline mode's link to one board (firmware 1.19.0, docs/mobile-apps.md, "Offline mode"), for the
 * bridge's ble.offline.* (shell/ShellBle.kt): connect, read the offline status (which makes the phone ask
 * for the board's passkey, the one `BT_OFFLINE|NEW` showed once), read it again every 3 s, and write
 * "accept" for the update that waits. The console's Offline page reads the bytes; this hands them over.
 * The passkey never passes through this app. Nothing is bonded by the board, so the next window asks again.
 *
 * Callbacks are handed to [scope], the main thread's.
 */
@SuppressLint("MissingPermission")
class OfflineLink(
    private val context: Context,
    private val device: BluetoothDevice,
    private val scope: CoroutineScope,
    /** Each status after the first, as the board sent it. */
    private val onPayload: (ByteArray) -> Unit,
    /** The link went by itself, with what to tell the person. */
    private val onGone: (String) -> Unit,
) {
    private var gatt: BluetoothGatt? = null
    private var refreshing: Job? = null
    private var watchdog: Job? = null
    private var ended = false
    private var first: CompletableDeferred<ByteArray>? = null
    private var accepting: CompletableDeferred<String?>? = null

    /**
     * A GATT read or write is under way. Android runs one at a time and refuses the next while one is out, so
     * the 3-s read waits its turn (it is skipped, not failed) and the accept waits for a read to finish:
     * the link is never dropped because two operations met.
     */
    @Volatile
    private var inFlight = false

    /** The status the board sent last. */
    var lastPayload: ByteArray? = null
        private set

    /** Connects, pairs and reads the first status; throws with words for the person if that fails. */
    suspend fun connect(): ByteArray {
        val read = CompletableDeferred<ByteArray>()
        first = read
        gatt = device.connectGatt(context.applicationContext, false, callback, BluetoothDevice.TRANSPORT_LE)
        if (gatt == null) fail("Could not connect to the board.")
        arm("The board did not answer. Hold its button 1 for five seconds to open Bluetooth again.")
        return read.await()
    }

    /** Reads the status again now, unless an operation is under way; the answer comes to onPayload. */
    fun refresh() = readStatus(required = false)

    /** Accepts the update that waits, naming the version the person saw: null once the board took it, else why not. */
    suspend fun accept(version: String): String? {
        val request = OfflineStatus.acceptRequest(version) ?: return "This board cannot take that."
        val link = gatt ?: return "No board is connected in offline mode."
        val control = link.getService(SERVICE)?.getCharacteristic(CONTROL) ?: return "This board cannot take that."
        if (accepting?.isActive == true) return "The board is answering the last one."
        // A read under way finishes first (at most a few hundred milliseconds).
        var waited = 0L
        while (inFlight && waited < OPERATION_WAIT_MS) {
            delay(20)
            waited += 20
        }
        if (inFlight) return "The board is busy. Try again."
        val answer = CompletableDeferred<String?>()
        accepting = answer
        inFlight = true
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
        if (!started) {
            accepting = null
            inFlight = false
            return "The phone could not send that. Try again."
        }
        return answer.await()
    }

    /** Lets go of the link. Nothing is said for it. */
    fun close() {
        ended = true
        refreshing?.cancel()
        watchdog?.cancel()
        first?.completeExceptionally(OfflineFailure("The board was let go."))
        accepting?.complete("The link to the board was closed.")
        val current = gatt
        gatt = null
        if (current != null) {
            runCatching { current.disconnect() }
            runCatching { current.close() }
        }
    }

    // MARK: -

    private fun fail(text: String) {
        if (ended) return
        // Before close(), which would answer a connect still under way with words of its own.
        val connecting = first?.completeExceptionally(OfflineFailure(text)) == true
        close()
        if (!connecting) scope.launch { onGone(text) }
    }

    private fun arm(text: String) {
        watchdog?.cancel()
        watchdog = scope.launch {
            delay(STEP_TIMEOUT_MS)
            fail(text)
        }
    }

    /**
     * The first read (required) must start: it is what pairs. A later one waits for its turn: skipped while
     * another operation is out, and tried again at the next 3 s.
     */
    private fun readStatus(required: Boolean = true) {
        val link = gatt ?: return
        val characteristic = link.getService(SERVICE)?.getCharacteristic(STATUS) ?: return
        if (inFlight) {
            if (required) fail("The phone could not read the board.")
            return
        }
        inFlight = true
        if (!link.readCharacteristic(characteristic)) {
            inFlight = false
            if (required) fail("The phone could not read the board.")
        }
    }

    private fun deliver(value: ByteArray?) {
        scope.launch {
            if (ended) return@launch
            if (value == null || OfflineStatus.parse(value) == null) {
                fail("The board sent something this app cannot read. Update the app.")
                return@launch
            }
            watchdog?.cancel()
            lastPayload = value
            val waiting = first
            if (waiting != null && waiting.isActive) {
                waiting.complete(value)
            } else {
                onPayload(value)
            }
            if (refreshing?.isActive != true) {
                refreshing = scope.launch {
                    while (true) {
                        delay(REFRESH_MS)
                        readStatus(required = false)
                    }
                }
            }
        }
    }

    private val callback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
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
            inFlight = false
            if (status == BluetoothGatt.GATT_SUCCESS) deliver(value) else scope.launch { fail(wordsForGattStatus(status)) }
        }

        override fun onCharacteristicWrite(g: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) {
            if (c.uuid != CONTROL) return
            inFlight = false
            scope.launch {
                val answer = accepting
                accepting = null
                if (status == BluetoothGatt.GATT_SUCCESS) {
                    answer?.complete(null)
                    readStatus(required = false)
                } else {
                    answer?.complete(
                        if (status == ATT_UNLIKELY) "That update no longer waits. Look at the board's status again." else wordsForGattStatus(status),
                    )
                }
            }
        }
    }

    /** Why connecting failed, in words for the person. */
    class OfflineFailure(message: String) : Exception(message)

    companion object {
        val SERVICE: UUID = UUID.fromString(OfflineStatus.SERVICE_UUID)
        val STATUS: UUID = UUID.fromString(OfflineStatus.STATUS_UUID)
        val CONTROL: UUID = UUID.fromString(OfflineStatus.CONTROL_UUID)
        private const val STEP_TIMEOUT_MS = 40_000L
        private const val REFRESH_MS = 3_000L
        private const val OPERATION_WAIT_MS = 2_000L
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
