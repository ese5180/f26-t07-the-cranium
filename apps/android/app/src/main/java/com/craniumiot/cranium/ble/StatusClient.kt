package com.craniumiot.cranium.ble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Build
import android.os.ParcelUuid
import com.craniumiot.cranium.core.BoardStatus
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.UUID

/**
 * The board's status characteristic (firmware 1.14.0 on, docs/mobile-apps.md, "The status
 * characteristic"), through a GATT client of the app's own: it connects, asks for an MTU that carries
 * a whole notification, reads the status and asks for its notifications. It never pairs and never bonds:
 * the status needs neither, and nothing else is touched. On the link of a send it is a second client
 * next to MCUmgr's, on the same link; after the board's restart it is the only one.
 *
 * Every callback is handed to [scope], which is the flow's (the main thread).
 */
@SuppressLint("MissingPermission")
class StatusClient(
    private val context: Context,
    private val device: BluetoothDevice,
    private val scope: CoroutineScope,
    /** A read or a notification that parsed. */
    private val onStatus: (BoardStatus) -> Unit,
    /** The board has no status service: firmware before 1.14.0, or not a board of ours. */
    private val onAbsent: () -> Unit = {},
    /** The link went, or could not be made. */
    private val onGone: () -> Unit = {},
) {
    private var gatt: BluetoothGatt? = null
    private var ended = false

    val address: String get() = device.address

    /** Its newer form only adds a handler for the callbacks, which go to [scope] here anyway. */
    @Suppress("DEPRECATION")
    fun open() {
        if (gatt != null || ended) return
        gatt = device.connectGatt(context.applicationContext, false, callback, BluetoothDevice.TRANSPORT_LE)
        if (gatt == null) end(gone = true)
    }

    /** Lets go of the link, if no other client holds it. No callback follows. */
    fun close() {
        ended = true
        val current = gatt ?: return
        gatt = null
        runCatching { current.disconnect() }
        runCatching { current.close() }
    }

    private fun end(gone: Boolean, absent: Boolean = false) {
        if (ended) return
        close()
        scope.launch {
            if (absent) onAbsent()
            if (gone) onGone()
        }
    }

    private fun deliver(value: ByteArray?) {
        val status = value?.let(BoardStatus::parse) ?: return
        scope.launch { if (!ended) onStatus(status) }
    }

    private fun characteristic(g: BluetoothGatt): BluetoothGattCharacteristic? =
        g.getService(SERVICE)?.getCharacteristic(CHARACTERISTIC)

    private val callback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                // A notification of 64 bytes needs an ATT MTU of 67 at least.
                if (!g.requestMtu(MTU)) g.discoverServices()
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED || status != BluetoothGatt.GATT_SUCCESS) {
                end(gone = true)
            }
        }

        override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
            if (!g.discoverServices()) end(gone = true)
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            val found = characteristic(g)
            if (status != BluetoothGatt.GATT_SUCCESS || found == null) {
                end(gone = true, absent = true)
                return
            }
            g.setCharacteristicNotification(found, true)
            val ccc = found.getDescriptor(CCC)
            val asked = ccc != null && if (Build.VERSION.SDK_INT >= 33) {
                g.writeDescriptor(ccc, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) == BluetoothGatt.GATT_SUCCESS
            } else {
                legacyWrite(g, ccc)
            }
            // Without notifications the status is still read, once.
            if (!asked) g.readCharacteristic(found)
        }

        override fun onDescriptorWrite(g: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            characteristic(g)?.let { g.readCharacteristic(it) }
        }

        override fun onCharacteristicRead(g: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray, status: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS && c.uuid == CHARACTERISTIC) deliver(value)
        }

        @Deprecated("Before Android 13")
        @Suppress("DEPRECATION")
        override fun onCharacteristicRead(g: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) {
            if (Build.VERSION.SDK_INT < 33 && status == BluetoothGatt.GATT_SUCCESS && c.uuid == CHARACTERISTIC) deliver(c.value)
        }

        override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray) {
            if (c.uuid == CHARACTERISTIC) deliver(value)
        }

        @Deprecated("Before Android 13")
        @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic) {
            if (Build.VERSION.SDK_INT < 33 && c.uuid == CHARACTERISTIC) deliver(c.value)
        }
    }

    @Suppress("DEPRECATION")
    private fun legacyWrite(g: BluetoothGatt, ccc: BluetoothGattDescriptor): Boolean {
        ccc.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
        return g.writeDescriptor(ccc)
    }

    companion object {
        val SERVICE: UUID = UUID.fromString(BoardStatus.SERVICE_UUID)
        val CHARACTERISTIC: UUID = UUID.fromString(BoardStatus.CHARACTERISTIC_UUID)
        private val CCC: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
        private const val MTU = 247
    }
}

/**
 * After a send, the board once it has restarted: for 2 minutes it advertises the status service, under a
 * new name and a new private address, and any phone may read its status with no pairing. One scan runs
 * for as long as this does (Android limits how often an app may start one); a board it finds is read, and
 * kept only if [accept] says that its status is about this send. One that is not, or has no status, is
 * left alone from then on. When the link goes (the board restarts again, back into the old image if its
 * trial failed), the next board seen is read again.
 */
@SuppressLint("MissingPermission")
class StatusFollower(
    private val context: Context,
    private val scope: CoroutineScope,
    private val accept: (BoardStatus) -> Boolean,
    private val onStatus: (BoardStatus) -> Unit,
) {
    private val adapter = context.getSystemService(BluetoothManager::class.java)?.adapter
    private var scan: ScanCallback? = null
    private var client: StatusClient? = null
    private var accepted = false
    private var timeout: Job? = null
    private val passedOver = mutableSetOf<String>()

    /** False when Bluetooth is off or the scan could not start. */
    fun start(): Boolean {
        if (scan != null) return true
        val scanner = adapter?.takeIf { it.isEnabled }?.bluetoothLeScanner ?: return false
        val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(StatusClient.SERVICE)).build()
        val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
        val callback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                scope.launch { seen(result.device) }
            }

            override fun onBatchScanResults(results: MutableList<ScanResult>) {
                scope.launch { results.forEach { seen(it.device) } }
            }

            override fun onScanFailed(errorCode: Int) {
                scan = null
            }
        }
        scan = callback
        return runCatching { scanner.startScan(listOf(filter), settings, callback) }.isSuccess
    }

    fun stop() {
        scan?.let { callback -> runCatching { adapter?.bluetoothLeScanner?.stopScan(callback) } }
        scan = null
        timeout?.cancel()
        client?.close()
        client = null
    }

    private fun seen(device: BluetoothDevice) {
        if (scan == null || client != null || device.address in passedOver) return
        accepted = false
        lateinit var opened: StatusClient
        opened = StatusClient(
            context,
            device,
            scope,
            onStatus = { status -> read(opened, status) },
            onAbsent = { passedOver += opened.address },
            onGone = { gone(opened) },
        )
        client = opened
        opened.open()
        // A board that does not answer in time is not waited for.
        timeout?.cancel()
        timeout = scope.launch {
            delay(READ_TIMEOUT_MS)
            if (client === opened && !accepted) {
                opened.close()
                client = null
            }
        }
    }

    private fun read(from: StatusClient, status: BoardStatus) {
        if (client !== from) return
        if (!accepted && !accept(status)) {
            passedOver += from.address
            from.close()
            client = null
            return
        }
        accepted = true
        onStatus(status)
    }

    private fun gone(from: StatusClient) {
        if (client === from) client = null
    }

    private companion object {
        const val READ_TIMEOUT_MS = 15_000L
    }
}
