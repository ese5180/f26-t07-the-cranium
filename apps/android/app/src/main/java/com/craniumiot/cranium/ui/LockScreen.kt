package com.craniumiot.cranium.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.IconButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.craniumiot.cranium.core.FingerprintWords
import com.craniumiot.cranium.core.Glyph

/** The Help topic of fingerprint unlock (apps/shared/help.json). */
const val FINGERPRINT_HELP = "biometric-sign-in"

/**
 * The lock screen: the mark, and the two ways in. Nothing of the console is drawn while it shows,
 * and the window is FLAG_SECURE (MainActivity).
 */
@Composable
fun LockScreen(vm: ConsoleViewModel, gate: Gate.Locked) {
    val colors = console
    var help by rememberSaveable { mutableStateOf<String?>(null) }
    Box(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
        IconButton(onClick = { help = FINGERPRINT_HELP }, modifier = Modifier.align(Alignment.TopEnd).padding(4.dp)) {
            GlyphIcon(Glyph.HELP, size = 22.dp, tint = colors.ink2, description = "Help")
        }
        Column(
            Modifier.align(Alignment.Center).widthIn(max = 420.dp).fillMaxWidth().padding(horizontal = Gutter),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            BrandMark(56.dp)
            Text("Cranium", Modifier.semantics { heading() }, style = ConsoleType.pageTitle.copy(fontSize = 26.sp), color = colors.ink)
            Spacer(Modifier.height(8.dp))
            if (gate.line != null) {
                Row(
                    Modifier.semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    GlyphIcon(Glyph.ALERT, Modifier.padding(top = 2.dp), tint = colors.warn)
                    Text(gate.line, style = ConsoleType.small, color = colors.ink, textAlign = TextAlign.Start)
                }
            }
            if (gate.busy) {
                CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 2.dp, color = colors.accent)
            } else {
                ConsoleButton(
                    FingerprintWords.UNLOCK, vm::unlock, Modifier.fillMaxWidth(),
                    kind = ButtonKind.PRIMARY, glyph = Glyph.FINGERPRINT,
                )
                ConsoleButton(FingerprintWords.PASSWORD, vm::signInWithPassword, Modifier.fillMaxWidth(), kind = ButtonKind.QUIET)
            }
        }
    }
    help?.let { topic -> LockHelp(vm, topic, onTopic = { help = it }, onClose = { help = null }) }
}

/** Help over the lock screen, in a window of its own: Help is not the console. */
@Composable
private fun LockHelp(vm: ConsoleViewModel, topic: String, onTopic: (String) -> Unit, onClose: () -> Unit) {
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize(), color = console.paper, contentColor = console.ink) {
            val chrome = remember(onClose) { Chrome(canGoBack = true, onBack = onClose, onSearch = null, onHelp = { it?.let(onTopic) }) }
            BackHandler(onBack = onClose)
            CompositionLocalProvider(LocalChrome provides chrome) {
                Box(Modifier.windowInsetsPadding(WindowInsets.safeDrawing)) { HelpScreen(vm, topic, onTopic = onTopic) }
            }
        }
    }
}

/** After a full sign-in: "Use your fingerprint to open Cranium?", once. */
@Composable
fun FingerprintOffer(vm: ConsoleViewModel) {
    ConsoleDialog(
        title = AnnotatedString(FingerprintWords.OFFER_TITLE),
        onClose = { vm.answerOffer(false) },
        busy = false,
        foot = {
            ConsoleButton("Not now", { vm.answerOffer(false) }, kind = ButtonKind.QUIET)
            ConsoleButton("Yes", { vm.answerOffer(true) }, kind = ButtonKind.PRIMARY, glyph = Glyph.FINGERPRINT)
        },
    ) {
        Text(FingerprintWords.OFFER_TEXT, style = ConsoleType.body, color = console.ink2)
    }
}
