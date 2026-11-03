package com.craniumiot.cranium.usb

import android.app.Application
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbManager
import android.os.Build
import androidx.core.content.ContextCompat
import androidx.core.content.IntentCompat
import com.craniumiot.cranium.core.SerialLink
import com.craniumiot.cranium.core.SerialRules
import com.craniumiot.cranium.core.SerialSession
import com.hoho.android.usbserial.driver.CdcAcmSerialDriver
import com.hoho.android.usbserial.driver.UsbSerialPort
import com.hoho.android.usbserial.util.SerialInputOutputManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException
import java.time.LocalTime
import java.time.format.DateTimeFormatter

/**
 * The serial console over a USB cable: the board's J-Link, a SEGGER device (vendor 0x1366), shows
 * two CDC ACM virtual COM ports, and the application's console is the second, VCOM1, at 115200
 * 8N1. The phone has to be a USB host (USB OTG) and the person has to allow the app to use the
 * device, which Android asks for. What is typed goes over the cable to the board and nowhere else.
 */
class UsbConsole(private val app: Application, private val scope: CoroutineScope) {

    /** A J-Link that is plugged in. */
    data class Probe(val name: String, val ports: Int, val deviceId: Int)

    data class UsbState(
        /** The J-Links the phone sees now. */
        val probes: List<Probe> = emptyList(),
        /** The port of the probe that is open or being opened, 0 or 1. */
        val port: Int? = null,
        val ports: Int = 0,
        val askingPermission: Boolean = false,
        val usbHost: Boolean = true,
    )

    val session = SerialSession(scope) { LocalTime.now().format(TIME) }

    private val _usb = MutableStateFlow(UsbState())
    val usb: StateFlow<UsbState> = _usb.asStateFlow()

    private val manager: UsbManager? = app.getSystemService(UsbManager::class.java)

    @OptIn(ExperimentalCoroutinesApi::class)
    private val writer = Dispatchers.IO.limitedParallelism(1)

    private var pending: Pair<UsbDevice, Int>? = null
    private var open: Opened? = null
    private var registered = false

    private class Opened(val device: UsbDevice, val port: UsbSerialPort, val connection: UsbDeviceConnection, val io: SerialInputOutputManager)

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                ACTION_PERMISSION -> {
                    val device = IntentCompat.getParcelableExtra(intent, UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
                    val granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
                    scope.launch { onPermission(device, granted) }
                }
                UsbManager.ACTION_USB_DEVICE_DETACHED -> {
                    val device = IntentCompat.getParcelableExtra(intent, UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
                    scope.launch {
                        if (device != null && open?.device?.deviceId == device.deviceId) session.lost(SerialRules.UNPLUGGED)
                        look()
                    }
                }
                UsbManager.ACTION_USB_DEVICE_ATTACHED -> scope.launch { look() }
            }
        }
    }

    /** Start listening for the cable and for the answer to the permission question. */
    fun start() {
        if (registered) return
        registered = true
        val filter = IntentFilter().apply {
            addAction(ACTION_PERMISSION)
            addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
            addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED)
        }
        ContextCompat.registerReceiver(app, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        look()
    }

    fun stop() {
        if (!registered) return
        registered = false
        runCatching { app.unregisterReceiver(receiver) }
    }

    /** Look at what is plugged in. */
    fun look() {
        val host = app.packageManager.hasSystemFeature("android.hardware.usb.host") && manager != null
        val probes = jlinks().map { device ->
            Probe(
                name = listOfNotNull(device.manufacturerName, device.productName).joinToString(" ").ifEmpty { "SEGGER J-Link" },
                ports = CdcAcmSerialDriver(device).ports.size,
                deviceId = device.deviceId,
            )
        }
        _usb.update { it.copy(probes = probes, usbHost = host) }
    }

    private fun jlinks(): List<UsbDevice> =
        manager?.deviceList?.values?.filter { it.vendorId == SerialRules.SEGGER_VENDOR_ID }.orEmpty().sortedBy { it.deviceId }

    /**
     * Connect to the console: the first J-Link, on [port] if given, else the second port (VCOM1)
     * where there are two. Android asks the person first if the app may use the device.
     */
    fun connect(port: Int? = null) {
        if (session.isOpen || session.state.value.phase != SerialSession.Phase.IDLE) return
        look()
        val device = jlinks().firstOrNull()
        if (device == null) {
            session.failedToOpen(
                "No board found on the USB cable. Connect the DK's J-Link USB port to the phone (with a USB OTG adapter if " +
                    "the phone needs one), switch the DK on, and try again.",
            )
            return
        }
        val count = CdcAcmSerialDriver(device).ports.size
        val chosen = (port ?: if (count >= 2) 1 else 0).coerceIn(0, maxOf(0, count - 1))
        session.setPhase(SerialSession.Phase.OPENING, problem = null)
        _usb.update { it.copy(port = chosen, ports = count) }
        val usb = manager ?: return
        if (usb.hasPermission(device)) {
            scope.launch { openPort(device, chosen) }
            return
        }
        pending = device to chosen
        _usb.update { it.copy(askingPermission = true) }
        val intent = Intent(ACTION_PERMISSION).setPackage(app.packageName)
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
        usb.requestPermission(device, PendingIntent.getBroadcast(app, 0, intent, flags))
    }

    /** No answer on this port: the other one carries the console. */
    fun tryOtherPort() {
        val current = _usb.value.port ?: 0
        val count = _usb.value.ports
        scope.launch {
            session.disconnect()
            connect(if (count >= 2) 1 - current else current)
        }
    }

    fun disconnect() {
        scope.launch { session.disconnect() }
    }

    private suspend fun onPermission(device: UsbDevice?, granted: Boolean) {
        val (asked, port) = pending ?: return
        pending = null
        _usb.update { it.copy(askingPermission = false) }
        if (device == null || device.deviceId != asked.deviceId) return
        if (!granted) {
            session.failedToOpen(
                "The app was not allowed to use the board's USB port. Connect again and choose Allow when Android asks.",
            )
            return
        }
        openPort(device, port)
    }

    private suspend fun openPort(device: UsbDevice, index: Int) {
        val usb = manager ?: return
        val opened = withContext(Dispatchers.IO) {
            runCatching {
                val connection = usb.openDevice(device) ?: throw IOException("no connection")
                val port = CdcAcmSerialDriver(device).ports[index]
                try {
                    port.open(connection)
                    port.setParameters(SerialRules.BAUD_RATE, UsbSerialPort.DATABITS_8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE)
                    runCatching { port.dtr = true }
                } catch (e: Exception) {
                    runCatching { port.close() }
                    runCatching { connection.close() }
                    throw e
                }
                port to connection
            }
        }
        val (port, connection) = opened.getOrElse {
            session.failedToOpen(
                "The port could not be opened. Another app may have it: close that app, unplug the board and plug it in again.",
            )
            return
        }
        val io = SerialInputOutputManager(port, object : SerialInputOutputManager.Listener {
            override fun onNewData(data: ByteArray) {
                val copy = data.copyOf()
                scope.launch { session.received(copy) }
            }

            override fun onRunError(e: Exception) {
                scope.launch { if (open?.port === port) session.lost(SerialRules.UNPLUGGED) }
            }
        })
        val current = Opened(device, port, connection, io)
        open = current
        io.start()
        session.attach(object : SerialLink {
            override suspend fun write(bytes: ByteArray) = withContext(writer) { port.write(bytes, WRITE_TIMEOUT_MS) }

            override suspend fun close() = withContext(writer) {
                if (open === current) open = null
                runCatching { io.listener = null }
                runCatching { io.stop() }
                runCatching { port.close() }
                runCatching { connection.close() }
                Unit
            }
        })
    }

    companion object {
        private const val ACTION_PERMISSION = "com.craniumiot.cranium.USB_PERMISSION"
        private const val WRITE_TIMEOUT_MS = 2_000
        private val TIME: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm:ss")
    }
}
