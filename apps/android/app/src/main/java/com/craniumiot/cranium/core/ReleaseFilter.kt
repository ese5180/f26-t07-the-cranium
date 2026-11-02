package com.craniumiot.cranium.core

/** Which releases the app offers (docs/mobile-apps.md). */
object ReleaseFilter {

    /** Active releases with a readable version, newest first. Revoked ones are never offered. */
    fun active(releases: List<Release>): List<Release> =
        releases
            .filter { it.isActive }
            .mapNotNull { release -> FirmwareVersion.parseRelease(release.version)?.let { release to it } }
            .sortedByDescending { it.second }
            .map { it.first }

    /**
     * The releases a board that runs [running] (the version in slot 0) takes: active and strictly
     * newer. The board refuses anything else at the first packet.
     */
    fun newerThan(releases: List<Release>, running: FirmwareVersion): List<Release> =
        active(releases).filter { FirmwareVersion.parseRelease(it.version)!! > running }

    /** The one to preselect: [preferred] if it is among [offered], else the newest. */
    fun preselect(offered: List<Release>, preferred: String?): Release? =
        offered.firstOrNull { it.version == preferred } ?: offered.firstOrNull()
}
