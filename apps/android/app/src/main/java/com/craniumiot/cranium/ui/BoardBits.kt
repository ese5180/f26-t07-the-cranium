package com.craniumiot.cranium.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.craniumiot.cranium.core.Boards
import com.craniumiot.cranium.core.Device
import com.craniumiot.cranium.core.FirmwareVersion
import com.craniumiot.cranium.core.Glyph
import com.craniumiot.cranium.core.Release
import com.craniumiot.cranium.core.Tone
import com.craniumiot.cranium.core.Updates
import com.craniumiot.cranium.core.Words

const val NOT_REGISTERED = "Not a registered release"
const val NEVER_REPORTED = "Has not reported to AWS IoT yet."
const val NEVER_REPORTED_HELP = "Power it up and check that it was provisioned."

/** The versions of the releases that are revoked, as far as they are known. */
fun revokedVersions(store: Store): Set<String> = store.releases.orEmpty().filter { !it.isActive }.map { it.version }.toSet()

/** The boards that report a version that is not in the list of releases. */
fun offList(devices: List<Device>?, releases: List<Release>?): List<Device> =
    devices.orEmpty().filter { Updates.isUnregistered(it.fw?.version, releases) }

/** Online, restarting, offline or never connected (views.js presence). */
@Composable
fun Presence(device: Device) {
    when {
        Updates.isRestarting(device) -> Badge(Tone.IDLE, Glyph.RESTART, "Restarting")
        device.online -> Badge(Tone.GOOD, Glyph.ONLINE, "Online")
        device.lastSeen == null -> Badge(Tone.IDLE, Glyph.MINUS_CIRCLE, "Never connected")
        else -> Badge(Tone.IDLE, Glyph.OFFLINE, "Offline")
    }
}

/** "Online, heartbeat 12 s ago", or null for a board that has never had one. */
fun heartbeatWords(device: Device, now: Long): String? {
    val words = when {
        Updates.isRestarting(device) -> "Restarting" to "last heartbeat"
        device.online -> "Online" to "heartbeat"
        else -> "Offline" to "last heartbeat"
    }
    if (device.lastSeen != null) return "${words.first}, ${words.second} ${Words.timeAgo(device.lastSeen, now)}"
    return if (device.online) words.first else null
}

fun seenLine(device: Device, now: Long): String = heartbeatWords(device, now) ?: NEVER_REPORTED

/** A board's signal: bars and words, or the reading an offline board last gave, muted. */
@Composable
fun SignalWords(device: Device, withDbm: Boolean = true) {
    val quality = Words.signalQuality(device.rssi)
    if (quality == null || device.rssi == null) {
        Quiet("Not reported")
        return
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        SignalBars(quality.bars, old = !device.online)
        if (device.online) {
            Text(if (withDbm) "${quality.label} · ${Words.signed(device.rssi)} dBm" else quality.label, style = ConsoleType.small, color = console.ink)
        } else {
            Quiet("${Words.signed(device.rssi)} dBm when last seen")
        }
    }
}

/** The firmware a board reports, with whether it confirmed it, and what is known of that version. */
@Composable
fun FirmwareFact(device: Device, store: Store) {
    val fw = device.fw
    if (fw == null) {
        Quiet("Not reported")
        return
    }
    Wrap {
        Mono(fw.version, style = ConsoleType.mono.copy(fontSize = 16.sp, fontWeight = FontWeight.SemiBold))
        if (!device.online) Quiet("when last seen")
        if (fw.confirmed) Badge(Tone.GOOD, Glyph.CHECK, "Confirmed") else Badge(Tone.WARN, Glyph.PULSE, "On trial")
        if (Updates.isUnregistered(fw.version, store.releases)) Badge(Tone.WARN, Glyph.ALERT, NOT_REGISTERED)
        if (fw.version in revokedVersions(store)) Badge(Tone.BAD, Glyph.BAN, "Revoked release")
    }
    if (!fw.confirmed) Note("Not confirmed yet. The bootloader goes back to the previous firmware if the board restarts before it confirms.")
    if (fw.version in revokedVersions(store)) Note("To replace it, upload a newer version and deploy that.")
}

/** One tile per board: filled while it is online, an outline once it has gone quiet, dashed if it has never reported. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun BoardTiles(devices: List<Device>, tone: (Device) -> Color? = { null }) {
    val colors = console
    val ordered = devices.sortedBy { if (Updates.isUp(it)) 0 else if (it.lastSeen != null) 1 else 2 }
    FlowRow(Modifier.clearAndSetSemantics {}, horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        for (device in ordered) {
            val fill = tone(device)
            val up = Updates.isUp(device)
            val never = !up && device.lastSeen == null
            Box(
                Modifier
                    .size(14.dp)
                    .clip(RoundedCornerShape(2.dp))
                    .background(fill ?: if (up) colors.ink else Color.Transparent)
                    .drawBehind {
                        if (fill == null && !up) {
                            drawRoundRect(
                                colors.lineMark,
                                cornerRadius = CornerRadius(2.dp.toPx()),
                                style = Stroke(1.dp.toPx(), pathEffect = if (never) PathEffect.dashPathEffect(floatArrayOf(3f, 3f)) else null),
                            )
                        }
                    },
            )
        }
    }
}

data class Counted(val online: Int, val quiet: Int, val never: Int)

fun boardsCounted(devices: List<Device>): Counted {
    val online = devices.count(Updates::isUp)
    val quiet = devices.count { !Updates.isUp(it) && it.lastSeen != null }
    return Counted(online, quiet, devices.size - online - quiet)
}

/** "3 of 4 boards online", with the tiles and their words. */
@Composable
fun FleetFigure(devices: List<Device>, extra: List<Pair<String, Int>> = emptyList()) {
    val counted = boardsCounted(devices)
    Row(verticalAlignment = Alignment.Bottom) {
        Text(counted.online.toString(), style = ConsoleType.figure, color = console.ink)
        Text(" of ${Words.plural(devices.size, "board")} online", Modifier.padding(bottom = 6.dp), style = ConsoleType.body, color = console.ink2)
    }
    if (devices.size > 1) {
        BoardTiles(devices)
        val words = listOfNotNull(
            if (counted.online > 0) "${counted.online} online" else null,
            if (counted.quiet > 0) "${counted.quiet} offline" else null,
            if (counted.never > 0) "${counted.never} never connected" else null,
        ) + extra.filter { it.second > 0 }.map { "${it.second} ${it.first}" }
        Note(words.joinToString(" · "))
    }
}

/** The boards by the version they report: newest first, boards that have not said last. */
fun versionGroups(devices: List<Device>): List<Pair<String, List<Device>>> =
    devices.groupBy { it.fw?.version ?: "" }.entries.sortedWith { a, b ->
        when {
            a.key.isEmpty() -> 1
            b.key.isEmpty() -> -1
            else -> {
                val va = FirmwareVersion.parseStrict(a.key)
                val vb = FirmwareVersion.parseStrict(b.key)
                if (va != null && vb != null) vb.compareTo(va) else b.key.compareTo(a.key)
            }
        }
    }.map { it.key to it.value }

/** The fleet by firmware: a row per version, with one tile per board. */
@Composable
fun VersionRows(devices: List<Device>, newest: Release?, store: Store) {
    val colors = console
    val revoked = revokedVersions(store)
    val tiled = devices.size > 1
    var behind = 0
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        for ((version, members) in versionGroups(devices)) {
            val unregistered = Updates.isUnregistered(version, store.releases)
            val shade: Color = when {
                version.isNotEmpty() && version == newest?.version -> colors.ink
                unregistered -> colors.barWarn
                version.isNotEmpty() -> {
                    behind = minOf(behind + 1, 3)
                    listOf(colors.ink2, colors.ink3, colors.lineMark)[behind - 1]
                }
                else -> colors.line
            }
            val onTrial = members.count { it.fw != null && !it.fw.confirmed }
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Wrap {
                    if (version.isNotEmpty()) Mono(version, style = ConsoleType.mono.copy(fontWeight = FontWeight.SemiBold)) else Quiet("Not reported")
                    if (version.isNotEmpty() && newest?.version == version) Tag("Newest release")
                    if (unregistered) Tag(NOT_REGISTERED, tone = Tone.WARN)
                    if (onTrial > 0) Tag("$onTrial on trial", tone = Tone.WARN)
                    Text(Words.plural(members.size, "board"), style = ConsoleType.note, color = colors.ink2)
                    if (version in revoked) Tag("Revoked release", tone = Tone.BAD)
                }
                if (tiled) BoardTiles(members) { shade }
            }
        }
    }
}

/** "As last reported, the oldest 3 min ago." under a figure that counts boards by what they run. */
fun asReported(devices: List<Device>, now: Long): String? {
    val quiet = devices.filter { it.fw != null && !it.online && it.lastSeen != null }
    if (quiet.isEmpty()) return null
    val oldest = quiet.minBy { com.craniumiot.cranium.core.Times.parse(it.lastSeen) ?: Long.MAX_VALUE }
    return "${if (quiet.size == 1) "As last reported " else "As last reported, the oldest "}${Words.timeAgo(oldest.lastSeen, now)}."
}

/** The name a board goes by in a sentence. */
fun called(device: Device): String = Boards.name(device)
