package com.craniumiot.cranium.shell

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.Base64

/**
 * The bridge's usb.* (apps/shared/bridge.json): the J-Link's virtual COM ports on the USB cable, which the
 * page uses as its Web Serial (bridge.js createBridgeSerial) for the Serial console and Board setup. The page
 * runs the flows (serial.js, setup.js, recovery.js): MCUboot's serial recovery is base64 lines of at most 128
 * bytes and the image goes up in requests of at most 1 KiB, so the bridge only carries bytes both ways, with
 * no pacing of its own. Writes go out in order, one at a time; what the board sends goes to the page as
 * usb.data as it comes, so the bootloader's half-second window after ENTER_BOOTLOADER is the page's to meet.
 * Everything runs on [scope], the main thread.
 */
class ShellUsb(
    private val scope: CoroutineScope,
    private val emit: (String, JsonObject) -> Unit,
    private val ports: UsbPorts,
) {
    private val open = HashMap<Int, UsbLine>()

    /** Whether this phone can be a USB host: the feature `usb` of app.hello. */
    val available: Boolean get() = ports.hasHost

    suspend fun open(params: JsonObject): JsonObject {
        val baudRate = params.whole("baudRate").toInt()
        if (!ports.hasHost) throw BridgeError("unavailable", "This phone cannot be a USB host.")
        val count = ports.count()
        if (count == 0) {
            throw BridgeError(
                "failed",
                "No board found on the USB cable. Connect the DK's J-Link USB port to the phone (with a USB OTG " +
                    "adapter if the phone needs one), switch the DK on, and try again.",
            )
        }
        // The console (VCOM1, the last) first, then the other one.
        val index = (count - 1 downTo 0).firstOrNull { it !in open }
            ?: throw BridgeError("busy", "Every port of the board is open already.")
        if (!ports.permit()) {
            throw BridgeError("cancelled", "The app was not allowed to use the board's USB port. Choose Allow when Android asks.")
        }
        val line = try {
            ports.open(
                index,
                baudRate,
                onData = { bytes -> scope.launch { received(index, bytes) } },
                onError = { scope.launch { lost(index) } },
            )
        } catch (e: Exception) {
            throw BridgeError("failed", "The port could not be opened. Another app may have it: close that app, unplug the board and plug it in again.")
        }
        open[index] = line
        return buildJsonObject {
            put("port", index)
            put("ports", count)
        }
    }

    suspend fun write(params: JsonObject): JsonObject {
        val port = params.whole("port").toInt()
        val line = open[port] ?: throw BridgeError("failed", "That port is not open.")
        val bytes = try {
            Base64.getDecoder().decode(params.text("data"))
        } catch (e: IllegalArgumentException) {
            throw BridgeError("bad_request", "data: not base64")
        }
        try {
            line.write(bytes)
        } catch (e: Exception) {
            throw BridgeError("failed", "The write to the board did not go.")
        }
        return EMPTY
    }

    suspend fun close(params: JsonObject): JsonObject {
        open.remove(params.whole("port").toInt())?.let { runCatching { it.close() } }
        return EMPTY
    }

    /** Every port closed: the page went away, or the app is done. */
    suspend fun closeAll() {
        val lines = open.values.toList()
        open.clear()
        for (line in lines) runCatching { line.close() }
    }

    /** The cable came out: the port is closed, and the page told. */
    fun unplugged() {
        for (port in open.keys.toList()) lost(port, "unplugged")
    }

    private fun received(port: Int, bytes: ByteArray) {
        if (port !in open || bytes.isEmpty()) return
        emit("usb.data", buildJsonObject {
            put("port", port)
            put("data", Base64.getEncoder().encodeToString(bytes))
        })
    }

    private fun lost(port: Int, reason: String = "failed") {
        val line = open.remove(port) ?: return
        scope.launch { runCatching { line.close() } }
        emit("usb.closed", buildJsonObject {
            put("port", port)
            put("reason", reason)
        })
    }

    private companion object {
        val EMPTY = JsonObject(emptyMap())
    }
}

/** The J-Link on the cable, as ShellUsb needs it: AndroidUsbPorts on a phone, a fake in the tests. */
interface UsbPorts {
    val hasHost: Boolean

    /** The number of virtual COM ports of the first J-Link on the cable; 0 when there is none. */
    fun count(): Int

    /** Whether the app may use it: Android asks the person the first time. */
    suspend fun permit(): Boolean

    /** Opens port [index] at [baudRate], 8N1; [onData] and [onError] come from a reading thread. */
    suspend fun open(index: Int, baudRate: Int, onData: (ByteArray) -> Unit, onError: () -> Unit): UsbLine
}

/** One open port. */
interface UsbLine {
    suspend fun write(bytes: ByteArray)

    suspend fun close()
}
