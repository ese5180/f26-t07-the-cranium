package com.craniumiot.cranium.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ReleaseFilterTest {
    private fun release(version: String, status: String = "active") =
        Release(version = version, size = 1, sha256 = "00", status = status)

    // Out of order on purpose, with a revoked release, an unknown status and a bad version.
    private val releases = listOf(
        release("1.7.0+0"),
        release("1.10.0+0"),
        release("1.9.0+0", status = "revoked"),
        release("1.8.0+0"),
        release("1.8.0+1"),
        release("2.0.0+0", status = "pending"),
        release("not-a-version"),
        release("1.6.0+0"),
    )

    @Test
    fun `offers only active releases, newest first`() {
        assertEquals(
            listOf("1.10.0+0", "1.8.0+1", "1.8.0+0", "1.7.0+0", "1.6.0+0"),
            ReleaseFilter.active(releases).map { it.version },
        )
    }

    @Test
    fun `offers only releases strictly newer than slot 0`() {
        val running = FirmwareVersion.parseBoard("1.8.0")!!
        assertEquals(listOf("1.10.0+0", "1.8.0+1"), ReleaseFilter.newerThan(releases, running).map { it.version })
    }

    @Test
    fun `the same version is not newer`() {
        val running = FirmwareVersion.parseBoard("1.10.0")!!
        assertEquals(emptyList<Release>(), ReleaseFilter.newerThan(releases, running))
    }

    @Test
    fun `a build number from the board counts`() {
        // The board writes 1.8.0 build 1 as "1.8.0.1".
        val running = FirmwareVersion.parseBoard("1.8.0.1")!!
        assertEquals(listOf("1.10.0+0"), ReleaseFilter.newerThan(releases, running).map { it.version })
    }

    @Test
    fun `a revoked newer release is never offered`() {
        val running = FirmwareVersion.parseBoard("1.8.5")!!
        assertEquals(listOf("1.10.0+0"), ReleaseFilter.newerThan(releases, running).map { it.version })
    }

    @Test
    fun `preselects the chosen release if it is offered, else the newest`() {
        val offered = ReleaseFilter.newerThan(releases, FirmwareVersion(1, 7, 0, 0))
        assertEquals("1.8.0+0", ReleaseFilter.preselect(offered, "1.8.0+0")?.version)
        assertEquals("1.10.0+0", ReleaseFilter.preselect(offered, "1.7.0+0")?.version)
        assertEquals("1.10.0+0", ReleaseFilter.preselect(offered, null)?.version)
        assertNull(ReleaseFilter.preselect(emptyList(), "1.8.0+0"))
    }

    @Test
    fun `what runs is image 0, slot 0`() {
        val slots = listOf(
            ImageSlot(image = 0, slot = 1, version = "1.9.0", active = false, confirmed = false, pending = false),
            ImageSlot(image = 1, slot = 0, version = "0.1.0", active = true, confirmed = true, pending = false),
            ImageSlot(image = 0, slot = 0, version = "1.8.0", active = true, confirmed = true, pending = false),
        )
        assertEquals("1.8.0", BoardImages.running(slots)?.version)
        assertNull(BoardImages.running(slots.take(2)))
    }
}
