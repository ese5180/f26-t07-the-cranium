package com.craniumiot.cranium.shell

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import androidx.core.content.ContextCompat
import androidx.core.content.IntentCompat
import com.craniumiot.cranium.core.SerialRules
import com.hoho.android.usbserial.driver.CdcAcmSerialDriver
import com.hoho.android.usbserial.driver.UsbSerialPort
import com.hoho.android.usbserial.util.SerialInputOutputManager
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.withContext
import java.io.IOException

/**
 * UsbPorts on the phone, with the classic console's pieces (usb/UsbConsole.kt): the first SEGGER J-Link
 * (vendor 0x1366) on the cable, its CDC ACM ports through usb-serial-for-android, Android's permission
 * question, and [onDetached] when a J-Link comes off the cable.
 */
class AndroidUsbPorts(private val app: Context, private val onDetached: () -> Unit) : UsbPorts {
    private val manager: UsbManager? = app.getSystemService(UsbManager::class.java)
    private var asking: CompletableDeferred<Boolean>? = null
    private var registered = false

    @OptIn(ExperimentalCoroutinesApi::class)
    private val writer = Dispatchers.IO.limitedParallelism(1)

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                ACTION_PERMISSION -> asking?.complete(intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false))
                UsbManager.ACTION_USB_DEVICE_DETACHED -> {
                    val device = IntentCompat.getParcelableExtra(intent, UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
                    if (device?.vendorId == SerialRules.SEGGER_VENDOR_ID) onDetached()
                }
            }
        }
    }

    override val hasHost: Boolean
        get() = manager != null && app.packageManager.hasSystemFeature("android.hardware.usb.host")

    private fun jlink(): UsbDevice? =
        manager?.deviceList?.values?.filter { it.vendorId == SerialRules.SEGGER_VENDOR_ID }?.minByOrNull { it.deviceId }

    override fun count(): Int = jlink()?.let { CdcAcmSerialDriver(it).ports.size } ?: 0

    private fun listen() {
        if (registered) return
        registered = true
        val filter = IntentFilter().apply {
            addAction(ACTION_PERMISSION)
            addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
        }
        ContextCompat.registerReceiver(app, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
    }

    fun release() {
        if (!registered) return
        registered = false
        runCatching { app.unregisterReceiver(receiver) }
        asking?.complete(false)
    }

    override suspend fun permit(): Boolean {
        val usb = manager ?: return false
        val device = jlink() ?: return false
        listen()
        if (usb.hasPermission(device)) return true
        asking?.let { return it.await() }
        val answer = CompletableDeferred<Boolean>()
        asking = answer
        val intent = Intent(ACTION_PERMISSION).setPackage(app.packageName)
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
        usb.requestPermission(device, PendingIntent.getBroadcast(app, 0, intent, flags))
        return try {
            answer.await()
        } finally {
            if (asking === answer) asking = null
        }
    }

    override suspend fun open(index: Int, baudRate: Int, onData: (ByteArray) -> Unit, onError: () -> Unit): UsbLine {
        val usb = manager ?: throw IOException("no USB")
        val device = jlink() ?: throw IOException("no J-Link")
        val (port, connection) = withContext(Dispatchers.IO) {
            val connection = usb.openDevice(device) ?: throw IOException("no connection")
            val port = CdcAcmSerialDriver(device).ports[index]
            try {
                port.open(connection)
                port.setParameters(baudRate, UsbSerialPort.DATABITS_8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE)
                runCatching { port.dtr = true }
            } catch (e: Exception) {
                runCatching { port.close() }
                runCatching { connection.close() }
                throw e
            }
            port to connection
        }
        val io = SerialInputOutputManager(port, object : SerialInputOutputManager.Listener {
            override fun onNewData(data: ByteArray) = onData(data.copyOf())

            override fun onRunError(e: Exception) = onError()
        })
        io.start()
        return object : UsbLine {
            override suspend fun write(bytes: ByteArray) = withContext(writer) { port.write(bytes, WRITE_TIMEOUT_MS) }

            override suspend fun close() = withContext(writer) {
                runCatching { io.listener = null }
                runCatching { io.stop() }
                runCatching { port.close() }
                runCatching { connection.close() }
                Unit
            }
        }
    }

    private companion object {
        const val ACTION_PERMISSION = "com.craniumiot.cranium.SHELL_USB_PERMISSION"
        const val WRITE_TIMEOUT_MS = 5_000
    }
}
