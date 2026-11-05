package com.craniumiot.cranium.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The board's status characteristic, as the firmware writes it: firmware/tests/host/test_bt_status.c makes
 * this same payload (`build/bt_status_tests --print`). The iPhone app's BoardStatusTests have the same cases.
 */
class BoardStatusTest {
    /** An offer of 1.14.1+0 on a board that runs 1.14.0+0 on trial, after an update over Bluetooth before. */
    private val sample =
        "010302010300384e0d00010e0100000000000000010e00000000000007010100010e000000000000010d020007000000deadbeef010203040300040302010000"

    private fun bytes(hex: String): ByteArray = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    @Test
    fun `the firmware's sample`() {
        val status = BoardStatus.parse(bytes(sample))!!
        assertEquals(BoardStatus.Window.OFFER, status.window)
        assertEquals(258, status.secondsLeft)
        assertEquals(BoardStatus.Image.VERIFIED, status.image)
        assertEquals(BoardStatus.Refusal.NONE, status.refusal)
        assertEquals(0x000d_4e38L, status.imageBytes)
        assertEquals("1.14.1+0", status.imageVersion)
        assertEquals(BoardStatus.Result.NONE, status.result)
        assertEquals(0, status.closedReason)
        assertEquals("1.14.0+0", status.running)
        assertTrue(status.onTrial)
        assertEquals(BoardStatus.Swap.REVERT, status.swap)
        assertEquals(BoardStatus.Via.BLUETOOTH, status.lastVia)
        assertEquals(BoardStatus.Outcome.PENDING, status.lastOutcome)
        assertEquals(BoardStatus.Proof.NONE, status.lastProof)
        assertEquals("1.14.0+0", status.lastTarget)
        assertEquals("1.13.2+7", status.lastFrom)
        assertEquals("deadbeef01020304", status.lastHash)
        assertEquals(3, status.lastCount)
        assertEquals(0x0102_0304L, status.uptime)
    }

    @Test
    fun `what cannot be read`() {
        // Too short, as a read on a link of the default MTU would be if it were not a long read.
        assertNull(BoardStatus.parse(bytes(sample.take(40))))
        // Another format.
        assertNull(BoardStatus.parse(bytes("02" + sample.drop(2))))
        assertNull(BoardStatus.parse(ByteArray(0)))
        // Longer is fine: a later firmware may add to the end.
        assertNotNull(BoardStatus.parse(bytes(sample + "ffff")))
    }

    @Test
    fun `nothing to say`() {
        val raw = ByteArray(64)
        raw[0] = 1
        raw[20] = 1
        raw[21] = 14
        val status = BoardStatus.parse(raw)!!
        assertTrue(status.window == BoardStatus.Window.CLOSED && status.image == BoardStatus.Image.NONE)
        assertTrue(status.imageVersion == null && status.lastTarget == null && status.lastFrom == null && status.lastHash == null)
        assertEquals("1.14.0+0", status.running)
        assertTrue(!status.onTrial && status.swap == BoardStatus.Swap.NONE && status.lastVia == BoardStatus.Via.NONE)
    }

    @Test
    fun `numbers from a later firmware`() {
        val raw = bytes(sample)
        raw[1] = 9
        raw[5] = 42
        raw[30] = 99
        val status = BoardStatus.parse(raw)!!
        assertTrue(
            status.window == BoardStatus.Window.UNKNOWN && status.refusal == BoardStatus.Refusal.UNKNOWN &&
                status.lastOutcome == BoardStatus.Outcome.UNKNOWN,
        )
        assertFalse(status.lastOutcome.isEnd)
    }

    @Test
    fun `what counts as news`() {
        val status = BoardStatus.parse(bytes(sample))!!
        val raw = bytes(sample)
        raw[2] = 1 // seconds left
        raw[7] = 0x50 // bytes
        raw[58] = 9 // uptime
        val counted = BoardStatus.parse(raw)!!
        assertFalse(counted.isNews(status))
        raw[18] = 1 // installing
        val installing = BoardStatus.parse(raw)!!
        assertTrue(installing.isNews(status))
        assertEquals(BoardStatus.Result.INSTALLING, installing.result)
        assertTrue(status.isNews(null))
    }

    @Test
    fun `words for each refusal and outcome`() {
        assertEquals("It is not newer than what the board runs.", BoardStatus.words(BoardStatus.Refusal.OLDER))
        assertEquals("It is for another kind of board.", BoardStatus.words(BoardStatus.Refusal.INCOMPATIBLE_BOARD))
        assertEquals("It is for another flash layout.", BoardStatus.words(BoardStatus.Refusal.INCOMPATIBLE_LAYOUT))
        assertEquals("The board did not say why.", BoardStatus.words(BoardStatus.Refusal.UNKNOWN))
        assertEquals("succeeded", BoardStatus.Outcome.KEPT.word)
        assertEquals("rolled_back", BoardStatus.Outcome.ROLLED_BACK.word)
        assertEquals("not_installed", BoardStatus.Outcome.NOT_INSTALLED.word)
        assertTrue(!BoardStatus.Outcome.PENDING.isEnd && BoardStatus.Outcome.KEPT.isEnd)
        assertTrue(BoardStatus.Proof.CLOUD.word == "cloud" && BoardStatus.Proof.UNKNOWN.word == "none")
    }

    @Test
    fun `the UUIDs are the firmware's`() {
        assertEquals("9112B1B4-2A51-40F0-94D3-A76440F0E6CC", BoardStatus.SERVICE_UUID)
        assertEquals("9112B1B5-2A51-40F0-94D3-A76440F0E6CC", BoardStatus.CHARACTERISTIC_UUID)
    }

    /** The image's own hash, which the board keeps: from the TLV area, not the SHA-256 of the file. */
    @Test
    fun `the image's own hash`() {
        val head = ByteArray(32)
        listOf(0x3d, 0xb8, 0xf3, 0x96).forEachIndexed { i, b -> head[i] = b.toByte() }
        head[8] = 32 // header size
        head[12] = 16 // image size
        // The TLV area: magic 0x6907, its length, a key hash entry (0x01) and then the SHA-256 (0x10).
        val digest = (0 until 32).map { (it + 0xa0).toByte() }
        val tlv = (listOf(0x07, 0x69, 0x00, 0x00, 0x01, 0x00, 0x04, 0x00, 1, 2, 3, 4, 0x10, 0x00, 0x20, 0x00).map { it.toByte() } + digest)
            .toByteArray()
        tlv[2] = tlv.size.toByte()
        val file = head + ByteArray(16) + tlv
        val header = McubootHeader.parse(file)!!
        val hex = digest.joinToString("") { "%02x".format(it) }
        assertEquals(hex, ImageCheck.imageHash(file, header))
        assertEquals(hex.take(16), ImageCheck.imageHashPrefix(file))

        // No TLV area where the header says.
        assertNull(ImageCheck.imageHash(file.copyOf(60), header))
        val wrong = file.copyOf()
        wrong[48] = 0x08
        assertNull(ImageCheck.imageHash(wrong, header))
    }
}
