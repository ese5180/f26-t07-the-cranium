package com.craniumiot.cranium.core

import java.util.Locale

/** A file in the firmware cache: its name, its size in bytes, and when it was last used (ms). */
data class CachedFile(val name: String, val size: Long, val lastUsed: Long) {
    /** The SHA-256 it is kept under, or null for a file that is not a cached image. */
    val key: String? get() = FirmwareCachePolicy.keyOfFile(name)
}

/** What to do with what the phone holds for a release. */
sealed class CacheDecision {
    /** Nothing on the phone for it: download. */
    data object Download : CacheDecision()

    /** What the phone holds passed every check against the release: send it, with no download. */
    data object Use : CacheDecision()

    /** What the phone holds fails a check: delete it, then download. */
    data class Replace(val failure: ImageCheckResult.Failed) : CacheDecision()
}

/**
 * The rules of the firmware cache (docs/mobile-apps.md, "Cache"), apart from the files: images are
 * kept under their release's SHA-256, checked again in full before each use, at most [LIMIT] of
 * them, and only for active releases.
 */
object FirmwareCachePolicy {
    const val LIMIT = 5

    private val sha256 = Regex("^[0-9a-f]{64}$")
    private val fileName = Regex("^([0-9a-f]{64})\\.bin$")

    /** The name [release]'s image is kept under, or null if its SHA-256 is not 64 hex digits. */
    fun key(release: Release): String? =
        release.sha256.trim().lowercase(Locale.ROOT).takeIf { sha256.matches(it) }

    fun fileName(key: String): String = "$key.bin"

    /** The key of a cached image's file name, or null for anything else (a temporary file). */
    fun keyOfFile(name: String): String? = fileName.matchEntire(name)?.groupValues?.get(1)

    /** [cached] is what the phone holds under [release]'s key, or null if nothing. */
    fun decide(cached: ByteArray?, release: Release): CacheDecision {
        if (cached == null) return CacheDecision.Download
        return when (val check = ImageCheck.check(cached, release)) {
            ImageCheckResult.Ok -> CacheDecision.Use
            is ImageCheckResult.Failed -> CacheDecision.Replace(check)
        }
    }

    /**
     * The images to delete so that at most [limit] stay, oldest by last use first. [protecting],
     * the one just stored or used, stays whatever its time says.
     */
    fun toEvict(files: List<CachedFile>, limit: Int = LIMIT, protecting: String? = null): List<CachedFile> =
        files
            .filter { it.key != null }
            .sortedWith(
                compareByDescending<CachedFile> { protecting != null && it.key == protecting }
                    .thenByDescending { it.lastUsed }
                    .thenBy { it.name },
            )
            .drop(limit.coerceAtLeast(0))
            .reversed()

    /**
     * The files to delete once the release list is in: any whose release is no longer active
     * (revoked, or gone from the list), and anything that is not a cached image.
     */
    fun toRemove(files: List<CachedFile>, releases: List<Release>): List<CachedFile> {
        val keep = releases.filter { it.isActive }.mapNotNull { key(it) }.toSet()
        return files.filter { file -> file.key.let { it == null || it !in keep } }
    }
}
