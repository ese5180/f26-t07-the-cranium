package com.craniumiot.cranium.ui

import androidx.compose.runtime.Composable
import com.craniumiot.cranium.core.Boards
import com.craniumiot.cranium.core.Device
import com.craniumiot.cranium.core.Glyph
import com.craniumiot.cranium.core.Release
import com.craniumiot.cranium.core.Tone
import com.craniumiot.cranium.core.Updates
import com.craniumiot.cranium.core.Words

const val NOT_REGISTERED = "Not a registered release"
const val NEVER_REPORTED = "Has not reported to the console yet."
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

data class Counted(val online: Int, val quiet: Int, val never: Int)

fun boardsCounted(devices: List<Device>): Counted {
    val online = devices.count(Updates::isUp)
    val quiet = devices.count { !Updates.isUp(it) && it.lastSeen != null }
    return Counted(online, quiet, devices.size - online - quiet)
}

/** The name a board goes by in a sentence. */
fun called(device: Device): String = Boards.name(device)
