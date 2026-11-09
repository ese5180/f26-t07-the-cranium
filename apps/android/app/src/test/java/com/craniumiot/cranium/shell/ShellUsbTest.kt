package com.craniumiot.cranium.shell

import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.util.Base64

/**
 * usb.* against a fake J-Link: the two ports, the permission, the console's lines, the bootloader's answer
 * after the restart, and an image of about 900 KB in the page's chunks (bridge.js USB_WRITE_BYTES).
 */
class ShellUsbTest {
    /** A J-Link with [ports] ports; what is written to a port is kept, and [answer] says what the board sends back. */
    private class FakePorts(var ports: Int = 2, var allowed: Boolean = true, override val hasHost: Boolean = true) : UsbPorts {
        val written = HashMap<Int, ByteArrayOutputStream>()
        val readers = HashMap<Int, (ByteArray) -> Unit>()
        val errors = HashMap<Int, () -> Unit>()
        val closed = mutableListOf<Int>()
        var asked = 0
        var baud = 0
        var answer: (Int, ByteArray) -> ByteArray? = { _, _ -> null }

        override fun count() = ports

        override suspend fun permit(): Boolean {
            asked += 1
            return allowed
        }

        override suspend fun open(index: Int, baudRate: Int, onData: (ByteArray) -> Unit, onError: () -> Unit): UsbLine {
            baud = baudRate
            readers[index] = onData
            errors[index] = onError
            written[index] = ByteArrayOutputStream()
            return object : UsbLine {
                override suspend fun write(bytes: ByteArray) {
                    written.getValue(index).write(bytes)
                    answer(index, bytes)?.let(onData)
                }

                override suspend fun close() {
                    closed += index
                }
            }
        }
    }

    private class Setup(scope: TestScope, val fake: FakePorts) {
        val events = mutableListOf<Pair<String, JsonObject>>()
        val usb = ShellUsb(scope, { name, data -> events += name to data }, fake)
        val bridge = Bridge { if (usb.available) setOf("usb") else emptySet() }.apply {
            register("usb.open") { usb.open(it) }
            register("usb.write") { usb.write(it) }
            register("usb.close") { usb.close(it) }
        }
        private var id = 0

        suspend fun call(method: String, params: JsonObject = JsonObject(emptyMap())): JsonObject {
            id += 1
            val text = buildJsonObject {
                put("v", 1)
                put("id", id)
                put("method", method)
                put("params", params)
            }.toString()
            return Json.parseToJsonElement(bridge.handle(text)!!).jsonObject
        }

        suspend fun open() = call("usb.open", buildJsonObject { put("baudRate", 115200) })

        suspend fun write(port: Int, bytes: ByteArray) =
            call("usb.write", buildJsonObject {
                put("port", port)
                put("data", Base64.getEncoder().encodeToString(bytes))
            })

        fun data(port: Int): ByteArray {
            val out = ByteArrayOutputStream()
            for ((name, data) in events) {
                if (name == "usb.data" && data.getValue("port").jsonPrimitive.int == port) {
                    out.write(Base64.getDecoder().decode(data.getValue("data").jsonPrimitive.content))
                }
            }
            return out.toByteArray()
        }
    }

    private fun JsonObject.ok() = getValue("ok").jsonPrimitive.content == "true"

    private fun JsonObject.code() = getValue("error").jsonObject.getValue("code").jsonPrimitive.content

    private fun JsonObject.result() = getValue("result").jsonObject

    @Test
    fun `the console's port opens first, then the other, then none`() = runTest {
        val setup = Setup(this, FakePorts())
        val first = setup.open()
        assertEquals(1, first.result().getValue("port").jsonPrimitive.int)
        assertEquals(2, first.result().getValue("ports").jsonPrimitive.int)
        assertEquals(115200, setup.fake.baud)
        assertEquals(0, setup.open().result().getValue("port").jsonPrimitive.int)
        assertEquals("busy", setup.open().code())
        setup.call("usb.close", buildJsonObject { put("port", 1) })
        assertEquals(listOf(1), setup.fake.closed)
        assertEquals(1, setup.open().result().getValue("port").jsonPrimitive.int)
    }

    @Test
    fun `no board, a refusal and a phone that is no USB host are said`() = runTest {
        assertEquals("failed", Setup(this, FakePorts(ports = 0)).open().code())
        val refused = Setup(this, FakePorts(allowed = false))
        assertEquals("cancelled", refused.open().code())
        assertEquals(1, refused.fake.asked)
        assertEquals("unavailable", Setup(this, FakePorts(hasHost = false)).open().code())
        val setup = Setup(this, FakePorts())
        assertEquals("bad_request", setup.call("usb.open", buildJsonObject { put("baudRate", 50) }).code())
        assertEquals("failed", setup.write(1, byteArrayOf(1)).code())
    }

    @Test
    fun `a console line of 384 bytes goes out and comes back whole, in order`() = runTest {
        val fake = FakePorts().apply { answer = { _, bytes -> bytes } }
        val setup = Setup(this, fake)
        setup.open()
        val line = ByteArray(383) { ('A'.code + it % 26).toByte() } + '\r'.code.toByte()
        assertTrue(setup.write(1, line).ok())
        runCurrent()
        assertArrayEquals(line, fake.written.getValue(1).toByteArray())
        assertArrayEquals(line, setup.data(1))
    }

    @Test
    fun `after ENTER_BOOTLOADER the bootloader's answer reaches the page at once`() = runTest {
        val enter = "\rENTER_BOOTLOADER\r".toByteArray()
        // MCUboot's serial recovery: a frame starts with 06 09, then base64 and a newline.
        val frame = byteArrayOf(6, 9) + "AAwBAAAAAAABAAAA\n".toByteArray()
        val fake = FakePorts().apply { answer = { _, bytes -> if (bytes.contentEquals(enter)) frame else null } }
        val setup = Setup(this, fake)
        setup.open()
        setup.write(1, enter)
        runCurrent()
        assertEquals(0L, testScheduler.currentTime)
        assertArrayEquals(frame, setup.data(1))
    }

    @Test
    fun `an image of 900 KB goes up in the page's chunks, byte for byte`() = runTest {
        val fake = FakePorts()
        val setup = Setup(this, fake)
        setup.open()
        val image = ByteArray(900 * 1024) { (it * 31 + 7).toByte() }
        // The page sends recovery lines of at most 128 bytes, in requests of at most 1 KiB, and never
        // more than 12 KiB (USB_WRITE_BYTES) in one usb.write; the largest chunk tests the bridge's limit.
        var at = 0
        while (at < image.size) {
            val end = minOf(image.size, at + 12288)
            assertTrue(setup.write(1, image.copyOfRange(at, end)).ok())
            at = end
        }
        val sent = fake.written.getValue(1).toByteArray()
        val sha = MessageDigest.getInstance("SHA-256")
        assertArrayEquals(sha.digest(image), MessageDigest.getInstance("SHA-256").digest(sent))
        val tooLong = Base64.getEncoder().encodeToString(ByteArray(12289))
        assertEquals("bad_request", setup.call("usb.write", buildJsonObject {
            put("port", 1)
            put("data", tooLong)
        }).code())
    }

    @Test
    fun `a port that fails or comes off the cable is closed and the page told`() = runTest {
        val fake = FakePorts()
        val setup = Setup(this, fake)
        setup.open()
        setup.open()
        fake.errors.getValue(0)()
        runCurrent()
        assertEquals("usb.closed", setup.events.last().first)
        assertEquals("failed", setup.events.last().second.getValue("reason").jsonPrimitive.content)
        setup.usb.unplugged()
        runCurrent()
        assertEquals(1, setup.events.last().second.getValue("port").jsonPrimitive.int)
        assertEquals("unplugged", setup.events.last().second.getValue("reason").jsonPrimitive.content)
        assertEquals("failed", setup.write(1, byteArrayOf(1)).code())
        // Data after the close does not reach the page.
        fake.readers.getValue(1)(byteArrayOf(1, 2))
        runCurrent()
        assertEquals(0, setup.data(1).size)
        assertEquals(setOf(0, 1), fake.closed.toSet())
    }
}
