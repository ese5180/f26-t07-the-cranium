package com.craniumiot.cranium.core

/**
 * Why this app has no Board setup (docs/new-board-setup.md, "From the console: Board setup"): the console's
 * setup.js APP_WORDS, held to them by BoardSetupTextTest. Board setup needs Web Serial, which the app's pages
 * do not have, and MCUboot's half-second window, which the app's USB console (usb/UsbConsole.kt), one command
 * at a time, does not reach.
 */
object BoardSetupText {
    const val TITLE = "Board setup needs a computer"
    const val ANDROID =
        "The Android app’s pages have no Web Serial, and its own USB console sends one command at a time: it cannot " +
            "reach the bootloader’s half-second window or send it an image. Set the board up in the Windows or Linux " +
            "desktop app, or in Chrome or Edge on a computer. The Serial console in this app still talks to a board " +
            "that is set up."
}
