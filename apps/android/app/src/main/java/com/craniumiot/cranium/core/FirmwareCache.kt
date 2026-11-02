package com.craniumiot.cranium.core

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/** Where the image that is sent came from. */
enum class ImageOrigin { PHONE, DOWNLOADED }

/** What [FirmwareCache.obtain] is doing, for the screen. */
enum class ImageStep { CHECKING, DOWNLOADING }

sealed class ObtainedImage {
    /** An image that passed every check against its release. */
    class Ready(val image: ByteArray, val origin: ImageOrigin) : ObtainedImage()

    /** The download failed a check. Nothing was kept, and nothing may be sent. */
    data class Failed(val failure: ImageCheckResult.Failed) : ObtainedImage()
}

/** What the phone holds: the keys (SHA-256) of the images, and their bytes in all. */
data class CacheSummary(val keys: Set<String>, val bytes: Long) {
    val count: Int get() = keys.size

    fun holds(release: Release): Boolean = FirmwareCachePolicy.key(release)?.let { it in keys } == true

    companion object {
        val EMPTY = CacheSummary(emptySet(), 0)
    }
}

/**
 * Checked firmware images kept on the phone, as `<sha256>.bin` in [dir] (docs/mobile-apps.md,
 * "Cache"). A cached image is checked again in full before every use; a download is kept only
 * once it has passed the same check, written to a temporary file and renamed into place. The
 * rules are in [FirmwareCachePolicy]; this class does the files. Nothing here throws for a file
 * it cannot write or delete: the cache only saves a download.
 */
class FirmwareCache(
    private val dir: File,
    private val limit: Int = FirmwareCachePolicy.LIMIT,
    private val now: () -> Long = System::currentTimeMillis,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {
    private val lock = Any()

    /** Moves on with every [clear], so that a download that was under way then is not kept. */
    private var generation = 0

    /**
     * [release]'s image: from the phone if it holds one that passes the check, else from
     * [download], checked, and kept. [onStep] says what is happening; it is called on the
     * caller's dispatcher.
     */
    suspend fun obtain(
        release: Release,
        onStep: (ImageStep) -> Unit = {},
        download: suspend () -> ByteArray,
    ): ObtainedImage {
        val key = FirmwareCachePolicy.key(release)
        val startedIn = synchronized(lock) { generation }
        if (key != null) {
            onStep(ImageStep.CHECKING)
            val cached = withContext(io) { useCached(key, release) }
            if (cached != null) return ObtainedImage.Ready(cached, ImageOrigin.PHONE)
        }
        onStep(ImageStep.DOWNLOADING)
        val image = download()
        onStep(ImageStep.CHECKING)
        val check = withContext(io) { ImageCheck.check(image, release) }
        if (check is ImageCheckResult.Failed) return ObtainedImage.Failed(check)
        if (key != null) withContext(io) { store(key, image, startedIn) }
        return ObtainedImage.Ready(image, ImageOrigin.DOWNLOADED)
    }

    /** Deletes what belongs to no active release in [releases] (the whole list), and any extra. */
    fun prune(releases: List<Release>) {
        synchronized(lock) {
            FirmwareCachePolicy.toRemove(files(), releases).forEach { File(dir, it.name).delete() }
            FirmwareCachePolicy.toEvict(files(), limit).forEach { File(dir, it.name).delete() }
        }
    }

    /** Deletes everything, and keeps nothing from a download that is under way. */
    fun clear() {
        synchronized(lock) {
            generation++
            dir.listFiles()?.forEach { it.delete() }
            dir.delete()
        }
    }

    fun summary(): CacheSummary = synchronized(lock) {
        val images = files().filter { it.key != null }
        CacheSummary(images.mapNotNull { it.key }.toSet(), images.sumOf { it.size })
    }

    /** Every file in the cache's folder, cached images and anything else. */
    fun files(): List<CachedFile> = synchronized(lock) {
        dir.listFiles()
            ?.filter { it.isFile }
            ?.map { CachedFile(it.name, it.length(), it.lastModified()) }
            .orEmpty()
    }

    /** The cached image of [release] if it passes the check (and is now the last used), else null. */
    private fun useCached(key: String, release: Release): ByteArray? = synchronized(lock) {
        val file = File(dir, FirmwareCachePolicy.fileName(key))
        val bytes = try {
            if (file.isFile) readAtMost(file, release.size + 1) else null
        } catch (e: IOException) {
            ByteArray(0) // Unreadable: it fails the size check, and is replaced.
        }
        when (FirmwareCachePolicy.decide(bytes, release)) {
            CacheDecision.Use -> {
                file.setLastModified(now())
                bytes
            }
            is CacheDecision.Replace -> {
                file.delete()
                null
            }
            CacheDecision.Download -> null
        }
    }

    /** Keeps a checked image: a temporary file, synced, then renamed over the final name. */
    private fun store(key: String, image: ByteArray, startedIn: Int) {
        synchronized(lock) {
            if (startedIn != generation) return
            var temporary: File? = null
            try {
                if (!dir.isDirectory && !dir.mkdirs()) return
                val tmp = File.createTempFile(".$key.", ".tmp", dir).also { temporary = it }
                FileOutputStream(tmp).use { out ->
                    out.write(image)
                    out.fd.sync()
                }
                val target = File(dir, FirmwareCachePolicy.fileName(key))
                Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
                temporary = null
                target.setLastModified(now())
                FirmwareCachePolicy.toEvict(files(), limit, protecting = key).forEach { File(dir, it.name).delete() }
            } catch (e: IOException) {
                // Not kept (a full disk, say). The image is still sent; the next update downloads it.
            } finally {
                temporary?.delete()
            }
        }
    }

    private fun readAtMost(file: File, limit: Long): ByteArray =
        FileInputStream(file).use { input ->
            val out = ByteArrayOutputStream()
            val buffer = ByteArray(16 * 1024)
            var total = 0L
            while (total < limit) {
                val n = input.read(buffer, 0, minOf(buffer.size.toLong(), limit - total).toInt())
                if (n < 0) break
                out.write(buffer, 0, n)
                total += n
            }
            out.toByteArray()
        }
}
