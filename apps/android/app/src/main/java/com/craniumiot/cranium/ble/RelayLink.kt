package com.craniumiot.cranium.ble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothSocket
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Build
import android.os.ParcelUuid
import androidx.annotation.RequiresApi
import com.craniumiot.cranium.core.RelayProtocol
import com.craniumiot.cranium.core.RelayPump
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.io.IOException
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.util.UUID
import kotlin.coroutines.resume

/**
 * The Bluetooth relay for one board (firmware 1.21.0, docs/ble-relay.md): this phone carries the board's own
 * TLS connection to AWS IoT. It finds a board advertising the relay service, reads the PSM over GATT, opens
 * the L2CAP channel (API 29 and later) and lets [RelayPump] decide; TCP is a plain [Socket], with no TLS of its
 * own, since the bytes are the board's TLS already. Each side is read on its own coroutine and written with
 * blocking writes, so a slow side holds the other back: L2CAP's credits stop the board, TCP's window the server.
 *
 * A board that turns out to be another one is let go, and the next one tried; a board that goes out of reach is
 * looked for again until [stop]. [onStatus] is called on [scope]'s thread.
 */
@SuppressLint("MissingPermission")
@RequiresApi(Build.VERSION_CODES.Q)
class RelayLink(
    private val context: Context,
    private val scope: CoroutineScope,
    private val thing: String?,
    private val region: String,
    private val onStatus: (Status) -> Unit,
) {
    data class Status(val state: String, val thing: String?, val bytesUp: Long, val bytesDown: Long, val error: String?)

    @Volatile
    var status = Status("looking", null, 0, 0, null)
        private set

    private var job: Job? = null
    private val tried = mutableSetOf<String>()
    private val adapter get() = (context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter

    fun start() {
        if (job != null) return
        job = scope.launch {
            while (isActive) {
                report(status.copy(state = "looking"))
                val device = find() ?: continue
                tried += device.address
                val words = try {
                    relay(device)
                } catch (e: IOException) {
                    "The board went out of reach."
                }
                report(status.copy(state = "looking", error = words))
            }
        }
    }

    suspend fun stop() {
        val running = job
        job = null
        running?.cancelAndJoin()
        report(status.copy(state = "stopped"))
    }

    private fun report(next: Status) {
        status = next
        scope.launch { onStatus(next) }
    }

    /** The next board offering the relay that was not tried yet; null after 10 s with none, which starts over. */
    private suspend fun find(): BluetoothDevice? {
        val scanner = adapter?.takeIf { it.isEnabled }?.bluetoothLeScanner
        if (scanner == null) {
            report(status.copy(state = "looking", error = "Bluetooth is off. Switch it on."))
            kotlinx.coroutines.delay(SCAN_MS)
            return null
        }
        val found = withTimeoutOrNull(SCAN_MS) {
            suspendCancellableCoroutine { waiting ->
                val callback = object : ScanCallback() {
                    override fun onScanResult(callbackType: Int, result: ScanResult) {
                        if (result.device.address in tried || !waiting.isActive) return
                        scanner.stopScan(this)
                        waiting.resume(result.device)
                    }
                }
                val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(UUID.fromString(RelayProtocol.SERVICE_UUID))).build()
                val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
                scanner.startScan(listOf(filter), settings, callback)
                waiting.invokeOnCancellation { runCatching { scanner.stopScan(callback) } }
            }
        }
        if (found == null) tried.clear()
        return found
    }

    /** One board, from connecting to the end of its channel. Returns why it ended, in words. */
    private suspend fun relay(device: BluetoothDevice): String? {
        report(status.copy(state = "connecting", error = null))
        val psm = CompletableDeferred<Int>()
        val gatt = device.connectGatt(context.applicationContext, false, psmReader(psm), BluetoothDevice.TRANSPORT_LE)
        var channel: BluetoothSocket? = null
        try {
            val number = withTimeoutOrNull(STEP_MS) { psm.await() } ?: return "The board did not open the relay in time."
            if (number == 0) return "The board's relay is not listening yet."
            channel = device.createInsecureL2capChannel(number)
            withContext(Dispatchers.IO) { channel.connect() }
            return pipe(channel)
        } finally {
            runCatching { channel?.close() }
            gatt.disconnect()
            gatt.close()
        }
    }

    private fun psmReader(psm: CompletableDeferred<Int>) = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            if (newState == BluetoothProfile.STATE_CONNECTED) gatt.discoverServices()
            else if (newState == BluetoothProfile.STATE_DISCONNECTED) psm.completeExceptionally(IOException("gone"))
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            val characteristic = gatt.getService(UUID.fromString(RelayProtocol.SERVICE_UUID))
                ?.getCharacteristic(UUID.fromString(RelayProtocol.PSM_UUID))
            if (characteristic == null) psm.complete(0) else gatt.readCharacteristic(characteristic)
        }

        @Deprecated("Before Android 13")
        @Suppress("DEPRECATION")
        override fun onCharacteristicRead(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
            if (Build.VERSION.SDK_INT < 33) take(characteristic.value, status)
        }

        override fun onCharacteristicRead(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray, status: Int) =
            take(value, status)

        private fun take(value: ByteArray?, status: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS || value == null || value.size < 2) psm.complete(0)
            else psm.complete((value[0].toInt() and 0xff) or ((value[1].toInt() and 0xff) shl 8))
        }
    }

    /** The channel's life: both ways at once, until the pump ends it or a side goes. */
    private suspend fun pipe(channel: BluetoothSocket): String? = coroutineScope {
        val pump = RelayPump(thing, region)
        val lock = Mutex()
        val toBoard = Mutex()
        val toServer = Mutex()
        var server: Socket? = null
        var serverJob: Job? = null
        val ended = CompletableDeferred<String?>()

        suspend fun write(out: OutputStream, guard: Mutex, bytes: ByteArray) = guard.withLock {
            withContext(Dispatchers.IO) {
                out.write(bytes)
                out.flush()
            }
        }

        lateinit var perform: suspend (List<RelayPump.Action>) -> Unit
        suspend fun step(take: RelayPump.() -> List<RelayPump.Action>) {
            val actions = lock.withLock { pump.take() }
            perform(actions)
            report(Status(
                state = when (pump.state) {
                    is RelayPump.State.Relaying -> "relaying"
                    is RelayPump.State.Ended -> status.state
                    else -> "ready"
                },
                thing = pump.thing ?: status.thing,
                bytesUp = pump.bytesUp,
                bytesDown = pump.bytesDown,
                error = null,
            ))
        }

        perform = { actions ->
            for (action in actions) {
                when (action) {
                    is RelayPump.Action.ToBoard -> runCatching { write(channel.outputStream, toBoard, action.bytes) }
                        .onFailure { ended.complete("The board went out of reach.") }
                    is RelayPump.Action.Connect -> {
                        serverJob?.cancel()
                        serverJob = launch {
                            val socket = Socket()
                            val connected = runCatching {
                                withContext(Dispatchers.IO) { socket.connect(InetSocketAddress(action.host, action.port), CONNECT_MS) }
                            }.isSuccess
                            if (!connected) {
                                runCatching { socket.close() }
                                step { serverFailed() }
                                return@launch
                            }
                            server = socket
                            step { serverConnected() }
                            val buffer = ByteArray(BUFFER)
                            while (isActive) {
                                val count = runCatching { withContext(Dispatchers.IO) { socket.getInputStream().read(buffer) } }.getOrDefault(-1)
                                if (count < 0) break
                                if (count > 0) step { fromServer(buffer.copyOf(count)) }
                            }
                            if (server === socket) {
                                server = null
                                runCatching { socket.close() }
                                step { serverClosed() }
                            }
                        }
                    }
                    is RelayPump.Action.ToServer -> {
                        val socket = server
                        if (socket != null) {
                            runCatching { write(socket.getOutputStream(), toServer, action.bytes) }.onFailure {
                                if (server === socket) {
                                    server = null
                                    runCatching { socket.close() }
                                    step { serverClosed() }
                                }
                            }
                        }
                    }
                    RelayPump.Action.CloseServer -> {
                        val socket = server
                        server = null
                        serverJob?.cancel()
                        runCatching { socket?.close() }
                    }
                    RelayPump.Action.CloseChannel -> ended.complete((pump.state as? RelayPump.State.Ended)?.words)
                }
            }
        }

        val boardJob = launch {
            val buffer = ByteArray(BUFFER)
            while (isActive) {
                val count = runCatching { withContext(Dispatchers.IO) { channel.inputStream.read(buffer) } }.getOrDefault(-1)
                if (count < 0) {
                    step { channelClosed() }
                    ended.complete("The board went out of reach.")
                    break
                }
                if (count > 0) step { fromBoard(buffer.copyOf(count)) }
            }
        }

        try {
            ended.await()
        } finally {
            runCatching { server?.close() }
            runCatching { channel.close() }
            serverJob?.cancel()
            boardJob.cancel()
        }
    }

    private companion object {
        const val SCAN_MS = 10_000L
        const val STEP_MS = 15_000L
        const val CONNECT_MS = 10_000
        const val BUFFER = 4096
    }
}
