package com.craniumiot.cranium.core

/**
 * The board's status in offline mode, from firmware 1.19.0 (firmware/app/src/policy/bt_offline_policy.h):
 * what a phone reads of a board that has no Wi-Fi or no cloud, over Bluetooth directly. Unlike the status
 * characteristic of an update, it needs a link paired with the board's own passkey (the phone asks for the
 * passkey when it first reads it), and the one write, [acceptRequest], installs the update that a phone
 * has sent and that waits. See docs/mobile-apps.md, "Offline mode". The iPhone app's OfflineStatus.swift
 * is the same, case for case.
 */
data class OfflineStatus(
    val wifi: Wifi,
    val cloud: Cloud,
    val update: Update,
    /** The board's reset kind (`enum reset_kind`), or 255 when it is not known. */
    val rebootCode: Int,
    val running: String,
    val uptime: Long,
    /** `major.minor` of the update that waits, while [update] is [Update.WAITING]. */
    val waiting: String?,
) {
    enum class Wifi(val code: Int) { NONE(0), DOWN(1), UP(2), UNKNOWN(255) }

    enum class Cloud(val code: Int) { NONE(0), DOWN(1), UP(2), UNKNOWN(255) }

    enum class Update(val code: Int) {
        IDLE(0),

        /** A cloud update is on offer and waits for a button at the board. */
        CLOUD_OFFER(1),
        CLOUD_BUSY(2),
        TRIAL(3),

        /** An update sent over Bluetooth has arrived and waits: this phone may accept it. */
        WAITING(4),
        RECEIVING(5),
        UNKNOWN(255),
    }

    val wifiWord: String
        get() = when (wifi) {
            Wifi.NONE -> "No Wi-Fi on this board"
            Wifi.DOWN -> "Not connected"
            Wifi.UP -> "Connected"
            Wifi.UNKNOWN -> "Unknown"
        }

    val cloudWord: String
        get() = when (cloud) {
            Cloud.NONE -> "No cloud on this board"
            Cloud.DOWN -> "Not connected"
            Cloud.UP -> "Connected"
            Cloud.UNKNOWN -> "Unknown"
        }

    val updateWord: String
        get() = when (update) {
            Update.IDLE -> "No update"
            Update.CLOUD_OFFER -> "An update from the cloud waits for a button at the board"
            Update.CLOUD_BUSY -> "An update from the cloud is being installed"
            Update.TRIAL -> "A new version is on trial"
            Update.WAITING -> "Version ${waiting ?: "?"} has arrived and waits for you"
            Update.RECEIVING -> "An update is arriving"
            Update.UNKNOWN -> "Unknown"
        }

    /** Why the board last restarted, by `enum reset_kind` (reset_cause.h). */
    val rebootWord: String get() = REBOOT_NAMES.getOrNull(rebootCode) ?: "Not known"

    /** Whether the person can accept an update at this moment. */
    val canAccept: Boolean get() = update == Update.WAITING && waiting != null

    val uptimeWord: String
        get() {
            val d = uptime / 86_400
            val h = uptime % 86_400 / 3_600
            val m = uptime % 3_600 / 60
            return when {
                d > 0 -> "$d d $h h"
                h > 0 -> "$h h $m min"
                else -> "$m min ${uptime % 60} s"
            }
        }

    companion object {
        const val SERVICE_UUID = "9112B1B6-2A51-40F0-94D3-A76440F0E6CC"
        const val STATUS_UUID = "9112B1B7-2A51-40F0-94D3-A76440F0E6CC"
        const val CONTROL_UUID = "9112B1B8-2A51-40F0-94D3-A76440F0E6CC"
        const val FORMAT = 1
        const val LENGTH = 20

        private val REBOOT_NAMES = listOf(
            "Brown-out", "Power on", "Watchdog", "Debugger", "Security", "Wake from low power", "Lock-up",
            "Parity", "Clock", "Hardware", "Reset by the user", "Temperature", "Software", "Reset pin",
        )

        /** Reads a payload. Null when it is short, or of a format this app does not know. */
        fun parse(data: ByteArray): OfflineStatus? {
            if (data.size < LENGTH || (data[0].toInt() and 0xff) != FORMAT) return null
            fun u8(at: Int) = data[at].toInt() and 0xff
            fun u16(at: Int) = u8(at) or (u8(at + 1) shl 8)
            fun u32(at: Int) = u16(at).toLong() or (u16(at + 2).toLong() shl 16)
            val update = Update.entries.firstOrNull { it.code == u8(3) } ?: Update.UNKNOWN
            return OfflineStatus(
                wifi = Wifi.entries.firstOrNull { it.code == u8(1) } ?: Wifi.UNKNOWN,
                cloud = Cloud.entries.firstOrNull { it.code == u8(2) } ?: Cloud.UNKNOWN,
                update = update,
                rebootCode = u8(4),
                running = "${u8(6)}.${u8(7)}.${u16(8)}+${u32(10)}",
                uptime = u32(14),
                waiting = if (update == Update.WAITING) "${u8(18)}.${u8(19)}" else null,
            )
        }

        /**
         * The one write: accept the update that waits, naming the version the person was shown. The board
         * refuses it if another version waits by now. Null for a version that is not `major.minor`.
         */
        fun acceptRequest(version: String): ByteArray? {
            val parts = version.split(".").take(2).map { it.toIntOrNull() ?: return null }
            if (parts.size != 2 || parts.any { it !in 0..255 }) return null
            return byteArrayOf(1, parts[0].toByte(), parts[1].toByte())
        }
    }
}
