package com.craniumiot.cranium.ble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.ParcelUuid
import com.craniumiot.cranium.core.BoardBluetooth
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import java.util.UUID

/** A device that advertises the SMP service. */
data class FoundBoard(
    val name: String?,
    val address: String,
    val rssi: Int,
    val device: BluetoothDevice,
) {
    val isCranium: Boolean get() = BoardBluetooth.isBoardName(name)
}

/**
 * Scans for the SMP service UUID, which is all a board advertises besides its name
 * (docs/mobile-apps.md, "Bluetooth"). The caller checks [BlePermissions] first.
 */
class BoardScanner(context: Context) {
    private val adapter = context.getSystemService(BluetoothManager::class.java)?.adapter
    private var callback: ScanCallback? = null

    private val _boards = MutableStateFlow<List<FoundBoard>>(emptyList())
    val boards: StateFlow<List<FoundBoard>> = _boards

    private val _failure = MutableStateFlow<String?>(null)
    val failure: StateFlow<String?> = _failure

    val hasBluetooth: Boolean get() = adapter != null
    val isBluetoothOn: Boolean get() = adapter?.isEnabled == true
    val isScanning: Boolean get() = callback != null

    /** Start a new scan, forgetting what the last one found. False if Bluetooth is off. */
    @SuppressLint("MissingPermission")
    fun start(): Boolean {
        stop()
        _boards.value = emptyList()
        _failure.value = null
        val scanner = adapter?.takeIf { it.isEnabled }?.bluetoothLeScanner ?: return false
        val filter = ScanFilter.Builder()
            .setServiceUuid(ParcelUuid(UUID.fromString(BoardBluetooth.SMP_SERVICE_UUID)))
            .build()
        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build()
        val scanCallback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) = add(result)

            override fun onBatchScanResults(results: MutableList<ScanResult>) = results.forEach(::add)

            override fun onScanFailed(errorCode: Int) {
                callback = null
                _failure.value = "The phone could not scan for Bluetooth devices (error $errorCode). " +
                    "Turn Bluetooth off and on, then look again."
            }
        }
        callback = scanCallback
        scanner.startScan(listOf(filter), settings, scanCallback)
        return true
    }

    @SuppressLint("MissingPermission")
    fun stop() {
        val scanCallback = callback ?: return
        callback = null
        runCatching { adapter?.bluetoothLeScanner?.stopScan(scanCallback) }
    }

    @SuppressLint("MissingPermission")
    private fun add(result: ScanResult) {
        val name = result.scanRecord?.deviceName ?: runCatching { result.device.name }.getOrNull()
        val found = FoundBoard(name, result.device.address, result.rssi, result.device)
        _boards.update { boards ->
            val previous = boards.firstOrNull { it.address == found.address }
            val merged = if (found.name == null && previous?.name != null) found.copy(name = previous.name) else found
            (boards.filter { it.address != found.address } + merged)
                .sortedWith(compareByDescending<FoundBoard> { it.isCranium }.thenBy { it.name ?: "~" }.thenBy { it.address })
        }
    }
}
