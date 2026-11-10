package com.craniumiot.cranium.core

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The offline status, parsed from the payload that firmware/tests/host/test_bt_offline.c makes
 * (`build/bt_offline_tests --print`). The iPhone app's OfflineStatusTests have the same cases.
 */
class OfflineStatusTest {
    private val sample = "010101040200011202010d0c0b0a040302010113"

    private fun bytes(hex: String): ByteArray = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    @Test
    fun `the firmware's sample`() {
        val status = OfflineStatus.parse(bytes(sample))!!
        assertEquals(OfflineStatus.Wifi.DOWN, status.wifi)
        assertEquals(OfflineStatus.Cloud.DOWN, status.cloud)
        assertEquals(OfflineStatus.Update.WAITING, status.update)
        assertEquals(2, status.rebootCode)
        assertEquals("Watchdog", status.rebootWord)
        assertEquals("1.18.258+168496141", status.running)
        assertEquals(0x01020304L, status.uptime)
        assertEquals("1.19", status.waiting)
        assertTrue(status.canAccept)
        assertEquals("Version 1.19 has arrived and waits for you", status.updateWord)
    }

    @Test
    fun `a payload that is short or of another format says nothing`() {
        assertNull(OfflineStatus.parse(ByteArray(0)))
        assertNull(OfflineStatus.parse(bytes(sample.dropLast(2))))
        assertNull(OfflineStatus.parse(bytes("02" + sample.drop(2))))
    }

    @Test
    fun `nothing waits unless the board says so`() {
        val idle = OfflineStatus.parse(bytes(sample.replaceRange(6, 8, "00")))!!
        assertEquals(OfflineStatus.Update.IDLE, idle.update)
        assertNull(idle.waiting)
        assertFalse(idle.canAccept)
        assertEquals("No update", idle.updateWord)
    }

    @Test
    fun `numbers this app does not know are unknown, not wrong`() {
        val odd = OfflineStatus.parse(bytes("01090903ff00" + sample.drop(12)))!!
        assertEquals(OfflineStatus.Wifi.UNKNOWN, odd.wifi)
        assertEquals(OfflineStatus.Cloud.UNKNOWN, odd.cloud)
        assertEquals("Not known", odd.rebootWord)
        assertNotNull(odd)
    }

    @Test
    fun `the accept write names the version the person saw`() {
        assertArrayEquals(byteArrayOf(1, 1, 19), OfflineStatus.acceptRequest("1.19"))
        assertArrayEquals(byteArrayOf(1, 1, 19), OfflineStatus.acceptRequest("1.19.0+4"))
        assertNull(OfflineStatus.acceptRequest("1"))
        assertNull(OfflineStatus.acceptRequest("1.300"))
        assertNull(OfflineStatus.acceptRequest("a.b"))
    }

    @Test
    fun `uptime reads in the largest units`() {
        fun word(seconds: Int): String {
            val b = bytes(sample)
            for (i in 0 until 4) b[14 + i] = (seconds shr (8 * i)).toByte()
            return OfflineStatus.parse(b)!!.uptimeWord
        }
        assertEquals("1 min 15 s", word(75))
        assertEquals("1 h 1 min", word(3_700))
        assertEquals("1 d 1 h", word(90_000))
    }
}
