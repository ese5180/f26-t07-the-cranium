package com.craniumiot.cranium.core

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Bluetooth relay's frames, against the bytes that firmware/tests/host/test_ble_relay.c makes
 * (`build/ble_relay_tests --print`), and the pump between a fake board and a fake server. The iPhone app's
 * RelayProtocolTests and RelayPumpTests have the same cases: change all three together.
 */
class RelayTest {
    private val hello = "011c000100f0006372616e69756d2d30313233343536373839616263646566"
    private val open = "022900b3226578616d706c652d6174732e696f742e75732d656173742d312e616d617a6f6e6177732e636f6d"
    private val data = "0405001603030001"
    private val opened = "030000"
    private val close = "05010001"

    private val host = "a1b2c3d4e5f6g7-ats.iot.us-east-1.amazonaws.com"
    private val thing = "cranium-0123456789abcdef"

    private fun bytes(hex: String): ByteArray = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    private fun helloFrame(name: String, version: Int = 1, dataMax: Int = 240) =
        RelayProtocol.frame(RelayProtocol.HELLO, byteArrayOf(version.toByte(), 0, (dataMax and 0xff).toByte(), (dataMax shr 8).toByte()) + name.encodeToByteArray())

    private fun openFrame(name: String, port: Int = 8883) =
        RelayProtocol.frame(RelayProtocol.OPEN, byteArrayOf((port and 0xff).toByte(), (port shr 8).toByte()) + name.encodeToByteArray())

    private fun relaying(): RelayPump {
        val pump = RelayPump(thing, "us-east-1")
        pump.fromBoard(helloFrame(thing))
        pump.fromBoard(openFrame(host))
        pump.serverConnected()
        return pump
    }

    @Test
    fun `the board's frames are read`() {
        val reader = RelayReader()
        val messages = reader.feed(bytes(hello + open + data))
        assertEquals(
            listOf(
                RelayMessage.Hello(1, 0, 240, thing),
                RelayMessage.Open("example-ats.iot.us-east-1.amazonaws.com", 8883),
                RelayMessage.Data(byteArrayOf(0x16, 0x03, 0x03, 0x00, 0x01)),
            ),
            messages,
        )
        assertFalse(reader.broken)
    }

    @Test
    fun `the app writes what the board reads`() {
        assertArrayEquals(bytes(opened), RelayProtocol.opened())
        assertArrayEquals(bytes(close), RelayProtocol.close(RelayProtocol.REFUSED))
        assertArrayEquals(bytes(data), RelayProtocol.data(byteArrayOf(0x16, 0x03, 0x03, 0x00, 0x01)))
        assertEquals("D38F3C14-34A8-4CDD-8E9A-BDB7FE83A2F0", RelayProtocol.SERVICE_UUID)
        assertEquals("D38F3C15-34A8-4CDD-8E9A-BDB7FE83A2F0", RelayProtocol.PSM_UUID)
    }

    @Test
    fun `any pieces give the same messages`() {
        val stream = bytes(hello + open + data + "7e020061620403000a0b0c" + close)
        for (step in listOf(1, 2, 3, 5, 64, stream.size)) {
            val reader = RelayReader()
            val messages = mutableListOf<RelayMessage>()
            var at = 0
            while (at < stream.size) {
                val end = minOf(at + step, stream.size)
                messages += reader.feed(stream.copyOfRange(at, end))
                at = end
            }
            // The unknown 0x7e frame is skipped.
            assertEquals(5, messages.size)
            assertEquals(RelayMessage.Data(byteArrayOf(0x0a, 0x0b, 0x0c)), messages[3])
            assertEquals(RelayMessage.Close(1), messages[4])
        }
    }

    @Test
    fun `too long breaks the stream`() {
        val reader = RelayReader()
        assertTrue(reader.feed(byteArrayOf(0x04, 0x01, 0x02)).isEmpty())
        assertTrue(reader.broken)
        assertTrue(reader.feed(bytes(data)).isEmpty())
        val withPayload = RelayReader()
        withPayload.feed(byteArrayOf(0x03, 0x01, 0x00, 0x00))
        assertTrue(withPayload.broken)
    }

    @Test
    fun `data is split at the board's limit`() {
        val messages = RelayReader().feed(RelayProtocol.data(ByteArray(500) { 7 }, 240))
        assertEquals(listOf(240, 240, 20), messages.map { (it as RelayMessage.Data).bytes.size })
    }

    @Test
    fun `only AWS IoT in the app's region on 8883`() {
        assertTrue(RelayProtocol.allowed(host, 8883, "us-east-1"))
        assertFalse(RelayProtocol.allowed(host, 443, "us-east-1"))
        assertFalse(RelayProtocol.allowed(host, 8883, "eu-west-1"))
        assertFalse(RelayProtocol.allowed(host, 8883, ""))
        assertFalse(RelayProtocol.allowed("a1b2-ats.iot.us-east-1.amazonaws.com.example.net", 8883, "us-east-1"))
        assertFalse(RelayProtocol.allowed("a1b2.iot.us-east-1.amazonaws.com", 8883, "us-east-1"))
        assertFalse(RelayProtocol.allowed("example.com", 8883, "us-east-1"))
        assertFalse(RelayProtocol.allowed("a1b2-ats.iot.us-east-1xamazonaws.com", 8883, "us-east-1"))
        assertFalse(RelayProtocol.allowed(host, 8883, "us-east-1|.*"))
    }

    @Test
    fun `a stream from HELLO to CLOSE`() {
        val pump = RelayPump(thing, "us-east-1")
        assertTrue(pump.fromBoard(helloFrame(thing)).isEmpty())
        assertEquals(RelayPump.State.Ready(thing), pump.state)
        assertEquals(listOf(RelayPump.Action.Connect(host, 8883)), pump.fromBoard(openFrame(host)))
        assertEquals(listOf(RelayPump.Action.ToBoard(RelayProtocol.opened())), pump.serverConnected())
        assertEquals(RelayPump.State.Relaying(thing, host), pump.state)

        val clientHello = byteArrayOf(0x16, 0x03, 0x01, 0x00, 0x05, 1, 2, 3, 4, 5)
        assertEquals(listOf(RelayPump.Action.ToServer(clientHello)), pump.fromBoard(RelayProtocol.data(clientHello)))
        assertEquals(
            listOf(RelayPump.Action.ToBoard(RelayProtocol.data(ByteArray(300) { 9 }, 240))),
            pump.fromServer(ByteArray(300) { 9 }),
        )
        assertEquals(10L, pump.bytesUp)
        assertEquals(300L, pump.bytesDown)

        // The server ends it: the board hears, and may open again on the same channel.
        assertEquals(listOf(RelayPump.Action.ToBoard(RelayProtocol.close(RelayProtocol.PEER_CLOSED))), pump.serverClosed())
        assertEquals(RelayPump.State.Ready(thing), pump.state)
        assertEquals(listOf(RelayPump.Action.Connect(host, 8883)), pump.fromBoard(openFrame(host)))

        // The board ends it.
        pump.serverConnected()
        assertEquals(listOf(RelayPump.Action.CloseServer), pump.fromBoard(RelayProtocol.close(RelayProtocol.HANDBACK)))
        assertTrue(pump.fromBoard(RelayProtocol.data(byteArrayOf(1))).isEmpty())
    }

    @Test
    fun `another board is let go`() {
        val pump = RelayPump(thing, "us-east-1")
        assertEquals(listOf(RelayPump.Action.CloseChannel), pump.fromBoard(helloFrame("cranium-ffffffffffffffff")))
        assertEquals(RelayPump.State.Ended("That is another board."), pump.state)
        assertTrue(pump.fromBoard(openFrame(host)).isEmpty())
    }

    @Test
    fun `a host outside the rule is refused, and a failed connection is said`() {
        val pump = RelayPump(null, "us-east-1")
        pump.fromBoard(helloFrame(thing))
        val refused = listOf(RelayPump.Action.ToBoard(RelayProtocol.close(RelayProtocol.REFUSED)))
        assertEquals(refused, pump.fromBoard(openFrame("example.com")))
        assertEquals(refused, pump.fromBoard(openFrame(host, 443)))
        assertEquals(RelayPump.State.Ready(thing), pump.state)

        pump.fromBoard(openFrame(host))
        assertEquals(listOf(RelayPump.Action.ToBoard(RelayProtocol.close(RelayProtocol.CONNECT_FAILED))), pump.serverFailed())
        assertEquals(RelayPump.State.Ready(thing), pump.state)
    }

    @Test
    fun `broken rules end the relay`() {
        val both = listOf(RelayPump.Action.CloseServer, RelayPump.Action.CloseChannel)
        assertEquals(both, relaying().fromBoard(helloFrame(thing)))

        val early = RelayPump(thing, "us-east-1")
        early.fromBoard(helloFrame(thing))
        early.fromBoard(openFrame(host))
        // DATA before OPENED.
        assertEquals(both, early.fromBoard(RelayProtocol.data(byteArrayOf(1))))

        assertEquals(both, relaying().fromBoard(byteArrayOf(0x04, 0xff.toByte(), 0xff.toByte())))
        assertEquals(listOf(RelayPump.Action.CloseChannel), RelayPump(thing, "us-east-1").fromBoard(helloFrame(thing, version = 2)))
    }

    @Test
    fun `the link or the person ends it`() {
        val pump = relaying()
        assertEquals(listOf(RelayPump.Action.CloseServer), pump.channelClosed())
        assertTrue(pump.channelClosed().isEmpty())

        val stopped = relaying()
        assertEquals(listOf(RelayPump.Action.CloseServer, RelayPump.Action.CloseChannel), stopped.stop())
        assertTrue(stopped.fromServer(byteArrayOf(1)).isEmpty())
    }
}
