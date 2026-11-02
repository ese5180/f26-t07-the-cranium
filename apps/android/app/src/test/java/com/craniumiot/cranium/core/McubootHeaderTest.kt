package com.craniumiot.cranium.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class McubootHeaderTest {

    @Test
    fun `reads every field little-endian`() {
        val bytes = TestImages.header(
            major = 1,
            minor = 8,
            revision = 0x0102,
            build = 0x01020304,
            loadAddress = 0x00010000,
            headerSize = 0x200,
            protectedTlvSize = 0x30,
            imageSize = 761_963,
            flags = 0x100,
        )
        val header = McubootHeader.parse(bytes)!!
        assertEquals(0x00010000L, header.loadAddress)
        assertEquals(0x200, header.headerSize)
        assertEquals(0x30, header.protectedTlvSize)
        assertEquals(761_963L, header.imageSize)
        assertEquals(0x100L, header.flags)
        assertEquals(FirmwareVersion(1, 8, 258, 16_909_060), header.version)
    }

    @Test
    fun `the version is bytes 20 to 27`() {
        val bytes = ByteArray(32)
        listOf(0x3d, 0xb8, 0xf3, 0x96).forEachIndexed { i, b -> bytes[i] = b.toByte() }
        // major 2, minor 3, revision 0x0405 (05 04), build 0x06070809 (09 08 07 06)
        listOf(0x02, 0x03, 0x05, 0x04, 0x09, 0x08, 0x07, 0x06).forEachIndexed { i, b -> bytes[20 + i] = b.toByte() }
        assertEquals(FirmwareVersion(2, 3, 0x0405, 0x06070809), McubootHeader.parse(bytes)!!.version)
    }

    @Test
    fun `the largest fields do not turn negative`() {
        val header = McubootHeader.parse(
            TestImages.header(major = 255, minor = 255, revision = 0xFFFF, build = 0xFFFF_FFFFL, imageSize = 0xFFFF_FFFFL),
        )!!
        assertEquals(FirmwareVersion(255, 255, 65_535, 4_294_967_295L), header.version)
        assertEquals(4_294_967_295L, header.imageSize)
    }

    @Test
    fun `the magic is 3d b8 f3 96`() {
        assertTrue(McubootHeader.hasMagic(TestImages.header()))
        // The same number stored big-endian is not it.
        assertFalse(McubootHeader.hasMagic(TestImages.header(magic = listOf(0x96, 0xf3, 0xb8, 0x3d))))
        assertNull(McubootHeader.parse(TestImages.header(magic = listOf(0x96, 0xf3, 0xb8, 0x3d))))
        assertFalse(McubootHeader.hasMagic(ByteArray(0)))
        assertFalse(McubootHeader.hasMagic(byteArrayOf(0x3d, 0xb8.toByte(), 0xf3.toByte())))
    }

    @Test
    fun `a file shorter than a header has none`() {
        assertNull(McubootHeader.parse(TestImages.header().copyOf(31)))
        assertNotNull(McubootHeader.parse(TestImages.header().copyOf(32)))
    }
}
