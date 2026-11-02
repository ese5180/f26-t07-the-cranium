package com.craniumiot.cranium.core

/** What the console says about a board after an upload, in words. */
data class BoardProgress(val text: String, val finished: Boolean)

object BoardProgressText {
    /**
     * How far [device] has come towards running [target]. Only a hint: the board's own LEDs and
     * console are the real answer (docs/mobile-apps.md, "Bluetooth").
     */
    fun of(device: Device, target: FirmwareVersion): BoardProgress {
        if (!device.online) return BoardProgress("The console does not see the board online right now.", false)
        val fw = device.fw ?: return BoardProgress("The board is online.", false)
        val running = FirmwareVersion.parseRelease(fw.version)
        return when {
            running == target && fw.confirmed ->
                BoardProgress("The board is online on ${fw.version}, and has kept it.", true)
            running == target ->
                BoardProgress("The board is online on ${fw.version}, on trial.", false)
            else ->
                BoardProgress("The board is online on ${fw.version}: the new image is not running yet.", false)
        }
    }
}
