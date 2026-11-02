package com.craniumiot.cranium.core

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BoardProgressTest {
    private val target = FirmwareVersion(1, 8, 0, 0)

    @Test
    fun `finished only when the new version is kept`() {
        assertTrue(BoardProgressText.of(Device("t", true, DeviceFirmware("1.8.0+0", true)), target).finished)
        assertFalse(BoardProgressText.of(Device("t", true, DeviceFirmware("1.8.0+0", false)), target).finished)
        assertFalse(BoardProgressText.of(Device("t", true, DeviceFirmware("1.7.0+0", true)), target).finished)
        assertFalse(BoardProgressText.of(Device("t", false, DeviceFirmware("1.8.0+0", true)), target).finished)
        assertFalse(BoardProgressText.of(Device("t", true, null), target).finished)
    }

    @Test
    fun `says trial while the new image is not kept yet`() {
        assertTrue(BoardProgressText.of(Device("t", true, DeviceFirmware("1.8.0+0", false)), target).text.contains("on trial"))
    }
}
