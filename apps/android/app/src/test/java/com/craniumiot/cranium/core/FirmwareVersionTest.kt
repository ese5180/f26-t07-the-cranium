package com.craniumiot.cranium.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FirmwareVersionTest {

    @Test
    fun `reads a release version as the console writes it`() {
        assertEquals(FirmwareVersion(1, 8, 0, 0), FirmwareVersion.parseRelease("1.8.0+0"))
        assertEquals(FirmwareVersion(1, 8, 0, 7), FirmwareVersion.parseRelease("1.8.0+7"))
        assertEquals(FirmwareVersion(1, 8, 0, 0), FirmwareVersion.parseRelease("1.8.0"))
        assertEquals(
            FirmwareVersion(255, 255, 65_535, 4_294_967_295L),
            FirmwareVersion.parseRelease("255.255.65535+4294967295"),
        )
    }

    @Test
    fun `refuses what the console would refuse`() {
        listOf(
            "", "1.8", "1.8.0+", "1.8.0.5", "v1.8.0", "01.8.0", "1.08.0", "1.8.0+01", " 1.8.0+0",
            "256.0.0+0", "0.256.0+0", "0.0.65536+0", "1.8.0+4294967296", "1.8.0-rc1", "1.8.0+0+0",
        ).forEach { assertNull(it, FirmwareVersion.parseRelease(it)) }
    }

    @Test
    fun `reads what the board's image list says`() {
        // Zephyr's img_mgmt leaves out a build number of 0, and writes another one after a dot.
        assertEquals(FirmwareVersion(1, 8, 0, 0), FirmwareVersion.parseBoard("1.8.0"))
        assertEquals(FirmwareVersion(1, 8, 0, 5), FirmwareVersion.parseBoard("1.8.0.5"))
        assertEquals(FirmwareVersion(1, 8, 0, 5), FirmwareVersion.parseBoard("1.8.0+5"))
        assertEquals(FirmwareVersion(1, 8, 0, 0), FirmwareVersion.parseBoard(" 1.8.0 "))
        listOf("", "1.8", "abc", "1.8.0.5.6", "256.0.0", "1.8.65536", "1.8.0.4294967296")
            .forEach { assertNull(it, FirmwareVersion.parseBoard(it)) }
    }

    @Test
    fun `compares field by field, as numbers`() {
        val ordered = listOf("0.0.0+0", "1.7.9+0", "1.8.0+0", "1.8.0+1", "1.8.1+0", "1.9.0+0", "1.10.0+0", "2.0.0+0")
            .map { FirmwareVersion.parseRelease(it)!! }
        assertEquals(ordered, ordered.shuffled(java.util.Random(1)).sorted())
        for (i in 0 until ordered.size - 1) assertTrue(ordered[i] < ordered[i + 1])
        assertEquals(0, FirmwareVersion.parseRelease("1.8.0")!!.compareTo(FirmwareVersion.parseBoard("1.8.0")!!))
    }

    @Test
    fun `release text equals the header fields it names`() {
        val header = McubootHeader.parse(TestImages.header(major = 1, minor = 8, revision = 258, build = 16_909_060))!!
        assertEquals(FirmwareVersion.parseRelease("1.8.258+16909060"), header.version)
        assertEquals("1.8.258+16909060", header.version.toString())
        assertTrue(FirmwareVersion.parseRelease("1.8.258+16909061")!! != header.version)
    }

    @Test
    fun `is written with the build number`() {
        assertEquals("1.8.0+0", FirmwareVersion.parseBoard("1.8.0").toString())
        assertEquals("1.8.0+5", FirmwareVersion.parseBoard("1.8.0.5").toString())
    }
}
