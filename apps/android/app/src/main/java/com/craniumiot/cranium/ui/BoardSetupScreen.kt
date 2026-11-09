package com.craniumiot.cranium.ui

import androidx.compose.runtime.Composable
import com.craniumiot.cranium.core.BoardSetupText
import com.craniumiot.cranium.core.Glyph

/**
 * The console's Developer → Board setup, which this app does not do: why, and where it is done instead
 * (BoardSetupText). The Serial console is one tap away, for a board that is set up.
 */
@Composable
fun BoardSetupScreen(vm: ConsoleViewModel) {
    ConsoleScreen(title = "Board setup", help = "serial") {
        item(key = "title") { OneLine(BoardSetupText.TITLE, glyph = Glyph.USB) }
        item(key = "why") { OneLine(BoardSetupText.ANDROID, action = "Serial console" to { vm.open(Route.Serial) }) }
    }
}
