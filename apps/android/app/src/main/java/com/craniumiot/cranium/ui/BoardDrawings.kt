package com.craniumiot.cranium.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.craniumiot.cranium.core.Device
import com.craniumiot.cranium.core.Glyph
import com.craniumiot.cranium.core.Heap
import com.craniumiot.cranium.core.Telemetry
import com.craniumiot.cranium.core.Tone
import com.craniumiot.cranium.core.Updates
import com.craniumiot.cranium.core.Words

// The drawings of a board's state: its signal on a scale, its memory, and its flash slots.

/** A reading on the scale of a signal meter: the four bands, and a needle where the board is. */
@Composable
fun SignalScale(rssi: Int) {
    val colors = console
    val quality = Words.signalQuality(rssi) ?: return
    val bands = listOf("Weak" to -90, "Fair" to -75, "Good" to -67, "Excellent" to -55)
    val place = ((rssi + 90f) / 50f).coerceIn(0f, 1f)
    Column(Modifier.fillMaxWidth().semantics(mergeDescendants = true) { contentDescription = "Wi-Fi signal ${Words.signed(rssi)} dBm, ${quality.label.lowercase()}" }) {
        BoxWithConstraints(Modifier.fillMaxWidth().height(26.dp).clearAndSetSemantics {}) {
            Row(Modifier.fillMaxWidth().height(18.dp).clip(RoundedCornerShape(3.dp))) {
                bands.forEachIndexed { index, (label, from) ->
                    val to = bands.getOrNull(index + 1)?.second ?: -40
                    Box(
                        Modifier.weight((to - from).toFloat()).fillMaxHeight().background(if (label == quality.label) colors.workWash else colors.well),
                        contentAlignment = Alignment.Center,
                    ) { Text(label, style = ConsoleType.eyebrow.copy(letterSpacing = 0.sp, fontSize = 10.sp), color = if (label == quality.label) colors.ink else colors.ink3) }
                }
            }
            Box(Modifier.offset(x = maxWidth * place - 1.dp).width(2.dp).height(26.dp).background(colors.ink))
        }
    }
}

/** How much memory is free, as a bar with the lowest point of this boot marked. */
@Composable
fun HeapBar(heap: Heap) {
    val colors = console
    val words = Telemetry.heapWords(heap) ?: return
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        BoxWithConstraints(
            Modifier
                .fillMaxWidth()
                .height(10.dp)
                .clip(RoundedCornerShape(2.dp))
                .border(1.dp, colors.lineField, RoundedCornerShape(2.dp))
                .background(colors.well)
                .semantics { contentDescription = "${words.text}, ${words.used}% in use. ${words.least}." },
        ) {
            Box(Modifier.fillMaxHeight().width(maxWidth * (words.used / 100f)).background(colors.toneBar(words.tone)))
            Box(Modifier.offset(x = maxWidth * (words.leastUsed / 100f) - 1.dp).width(2.dp).fillMaxHeight().background(colors.ink))
        }
        Wrap {
            if (words.tone == Tone.BAD) Badge(Tone.BAD, Glyph.ALERT, "Low now")
            Text(words.text, style = ConsoleType.small, color = colors.ink)
        }
        Wrap {
            if (words.ranLow) Badge(Tone.WARN, Glyph.ALERT, "Ran low")
            Note(words.least)
        }
    }
}

/** One row of a flash map: what a slot holds, and what is happening to it. */
data class FlashSlot(
    val version: String? = null,
    val none: String = "No new image",
    val state: String,
    val tone: Tone = Tone.IDLE,
    val glyph: Glyph? = null,
    val receiving: Int? = null,
)

const val WORKED_OUT = "Worked out from the step the board last reported."

/** What a board's flash holds: the bootloader and the two slots. */
@Composable
fun FlashMap(title: String, primary: FlashSlot, secondary: FlashSlot, swapping: Boolean = false, note: String = WORKED_OUT) {
    val colors = console
    Eyebrow(title)
    Spacer(Modifier.height(8.dp))
    @Composable
    fun row(name: String, slot: FlashSlot?, version: String, state: String, tone: Tone, glyph: Glyph?, receiving: Int?) {
        Row(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(4.dp))
                .background(colors.well)
                .drawBehind {
                    if (receiving != null) drawRect(colors.workWash, size = size.copy(width = size.width * receiving / 100f))
                }
                .padding(horizontal = 10.dp, vertical = 8.dp)
                .semantics(mergeDescendants = true) {},
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Column(Modifier.weight(1f)) {
                Text(name, style = ConsoleType.note, color = colors.ink3)
                if (slot?.version != null || slot == null) Mono(version, style = ConsoleType.mono.copy(fontWeight = FontWeight.SemiBold)) else Quiet(slot.none)
            }
            Row(Modifier.weight(1.2f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (glyph != null) GlyphIcon(glyph, size = 14.dp, tint = colors.toneInk(tone))
                Text(state + if (receiving != null) " $receiving%" else "", style = ConsoleType.note, color = colors.ink)
            }
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        row("Bootloader", null, "MCUboot", "Checks every signature", Tone.IDLE, null, null)
        row("Primary slot", primary, primary.version.orEmpty(), primary.state, primary.tone, primary.glyph, primary.receiving)
        if (swapping) Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { GlyphIcon(Glyph.SWAP, tint = colors.work) }
        row("Secondary slot", secondary, secondary.version.orEmpty(), secondary.state, secondary.tone, secondary.glyph, secondary.receiving)
    }
    Note(note, Modifier.padding(top = 6.dp))
}

/** The flash map told from what a board last reported about itself (views.js slotsOfDevice). */
@Composable
fun FlashMapOfDevice(device: Device) {
    val fw = device.fw
    val ota = device.ota
    val online = device.online
    val onTrialWords = if (online) "Runs on trial" else "Was on trial"
    val confirmedWords = if (online) "Runs from here, confirmed" else "Ran from here, confirmed"
    val running = FlashSlot(
        version = fw?.version,
        none = "Version not reported",
        state = when {
            fw?.confirmed == true -> confirmedWords
            fw != null -> onTrialWords
            else -> "Nothing reported"
        },
        tone = when {
            fw?.confirmed == true -> Tone.GOOD
            fw != null -> Tone.LIVE
            else -> Tone.IDLE
        },
        glyph = when {
            fw?.confirmed == true -> Glyph.CHECK
            fw != null -> Glyph.PULSE
            else -> null
        },
    )
    val target = Updates.versionOfDeployment(ota?.job)
    val note = if (ota != null) WORKED_OUT else "The board reports what it runs, and nothing about its other slot."
    val title = if (online) "Flash memory now" else "Flash memory when last seen"
    val update = Updates.describeUpdate(device)
    when {
        ota == null || ota.state == "idle" ->
            FlashMap(title, running, FlashSlot(none = "Not reported by the board", state = "No update under way"), note = note)
        ota.state == "awaiting_user" -> FlashMap(
            title, running,
            FlashSlot(none = "Not reported by the board", state = if (online) "Nothing is written until Button 1 is pressed" else update.label),
            note = note,
        )
        ota.state == "testing" -> FlashMap(
            title, running.copy(state = onTrialWords, tone = if (online) Tone.LIVE else Tone.IDLE, glyph = Glyph.PULSE),
            FlashSlot(none = "Previous firmware", state = "Kept to fall back on"), note = note,
        )
        ota.state == "bluetooth" -> FlashMap(
            title, running,
            FlashSlot(none = "Not reported by the board", state = if (online) "A phone may be sending an image over Bluetooth" else update.label),
            note = note,
        )
        !online -> FlashMap(title, running, FlashSlot(version = target, state = update.label), note = note)
        ota.state == "downloading" -> FlashMap(
            title, running,
            FlashSlot(version = target, state = "Receiving the image", tone = Tone.LIVE, glyph = Glyph.DOWNLOAD, receiving = ota.progress),
            note = note,
        )
        else -> FlashMap(
            title, running, FlashSlot(version = target, state = "Written, being checked", tone = Tone.LIVE, glyph = Glyph.SHIELD),
            swapping = ota.state == "rebooting", note = note,
        )
    }
}

