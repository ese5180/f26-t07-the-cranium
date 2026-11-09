package com.craniumiot.cranium.core

/**
 * What the classic screens say of Board setup (docs/new-board-setup.md, "From the console: Board setup"): the
 * console's setup.js APP_WORDS, held to them by BoardSetupTextTest. The classic USB console (usb/UsbConsole.kt)
 * sends one command at a time and does not reach MCUboot's half-second window; the app's own pages do Board
 * setup, through the bridge's usb.* (shell/ShellUsb.kt).
 */
object BoardSetupText {
    const val TITLE = "Board setup is in the app’s pages"
    const val ANDROID =
        "These classic screens cannot set a board up: their USB console sends one command at a time, too slow for " +
            "the bootloader’s half-second window. Board setup is under Developer in the app’s own pages, with the board " +
            "on the phone’s USB cable, and in the Windows or Linux desktop app, or Chrome or Edge on a computer. The " +
            "Serial console here still talks to a board that is set up."
}
