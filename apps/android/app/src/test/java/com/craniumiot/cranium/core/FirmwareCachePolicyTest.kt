package com.craniumiot.cranium.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FirmwareCachePolicyTest {
    private val image = TestImages.image(FirmwareVersion(1, 8, 0, 0))
    private val release = TestImages.releaseFor(image, "1.8.0+0")
    private val key = release.sha256

    private fun file(key: String, lastUsed: Long, size: Long = 100) = CachedFile("$key.bin", size, lastUsed)

    private fun hex(c: Char) = c.toString().repeat(64)

    // ---- Keys and names ----------------------------------------------------------------------

    @Test
    fun `an image is kept under its release's SHA-256, in lower case`() {
        assertEquals(key, FirmwareCachePolicy.key(release))
        assertEquals(key, FirmwareCachePolicy.key(release.copy(sha256 = key.uppercase())))
        assertEquals("$key.bin", FirmwareCachePolicy.fileName(key))
        assertEquals(key, FirmwareCachePolicy.keyOfFile("$key.bin"))
    }

    @Test
    fun `a SHA-256 that is not 64 hex digits names no file`() {
        listOf("", "00", "../../shared_prefs/x", "g".repeat(64), "a".repeat(63), "a".repeat(65), "${"a".repeat(62)}/x")
            .forEach { assertNull(it, FirmwareCachePolicy.key(release.copy(sha256 = it))) }
    }

    @Test
    fun `only a key and bin is a cached image`() {
        listOf(".$key.123.tmp", "$key.bin.tmp", "$key.BIN", "${key.uppercase()}.bin", "notes.txt", "$key")
            .forEach { assertNull(it, FirmwareCachePolicy.keyOfFile(it)) }
    }

    // ---- What to do with what the phone holds ------------------------------------------------

    @Test
    fun `nothing on the phone means a download`() {
        assertEquals(CacheDecision.Download, FirmwareCachePolicy.decide(null, release))
    }

    @Test
    fun `an image that passes the whole check is used`() {
        assertEquals(CacheDecision.Use, FirmwareCachePolicy.decide(image.copyOf(), release))
    }

    @Test
    fun `an image that fails any part of the check is replaced`() {
        fun problem(bytes: ByteArray, release: Release = this.release) =
            (FirmwareCachePolicy.decide(bytes, release) as CacheDecision.Replace).failure.problem

        assertEquals(ImageProblem.SIZE, problem(image.copyOf(image.size - 1)))
        assertEquals(ImageProblem.SIZE, problem(ByteArray(0)))
        val flipped = image.copyOf().also { it[100] = (it[100] + 1).toByte() }
        assertEquals(ImageProblem.SHA256, problem(flipped))
        // The same bytes listed as another release: right hash, wrong header version.
        assertEquals(ImageProblem.VERSION, problem(image, release.copy(version = "1.8.1+0")))
        val noMagic = image.copyOf().also { it[0] = 0 }
        assertEquals(ImageProblem.MAGIC, problem(noMagic, TestImages.releaseFor(noMagic, "1.8.0+0")))
    }

    // ---- At most five, oldest by last use first ----------------------------------------------

    @Test
    fun `five or fewer are all kept`() {
        val files = (1..5).map { file(hex("abcde"[it - 1]), lastUsed = it * 1000L) }
        assertEquals(emptyList<CachedFile>(), FirmwareCachePolicy.toEvict(files))
        assertEquals(emptyList<CachedFile>(), FirmwareCachePolicy.toEvict(emptyList()))
    }

    @Test
    fun `beyond five the least recently used go, oldest first`() {
        val files = listOf(
            file(hex('a'), lastUsed = 5_000),
            file(hex('b'), lastUsed = 1_000),
            file(hex('c'), lastUsed = 7_000),
            file(hex('d'), lastUsed = 3_000),
            file(hex('e'), lastUsed = 6_000),
            file(hex('f'), lastUsed = 2_000),
            file(hex('0'), lastUsed = 4_000),
        )
        assertEquals(listOf(hex('b'), hex('f')), FirmwareCachePolicy.toEvict(files).map { it.key })
        assertEquals(
            listOf(hex('b'), hex('f'), hex('d'), hex('0'), hex('a')),
            FirmwareCachePolicy.toEvict(files, limit = 2).map { it.key },
        )
    }

    @Test
    fun `the image just stored or used stays, whatever its time says`() {
        // A clock that went back, or a file system with coarse times: the new one looks oldest.
        val files = (0..5).map { file(hex("012345"[it]), lastUsed = 10_000L - it) }
        val evicted = FirmwareCachePolicy.toEvict(files, protecting = hex('5'))
        assertEquals(listOf(hex('4')), evicted.map { it.key })
    }

    @Test
    fun `files that are not cached images are not counted against the five`() {
        val files = (1..5).map { file(hex("abcde"[it - 1]), lastUsed = it * 1000L) } +
            CachedFile(".$key.1.tmp", 10, 0) + CachedFile("other", 10, 0)
        assertEquals(emptyList<CachedFile>(), FirmwareCachePolicy.toEvict(files))
    }

    // ---- Revoked releases --------------------------------------------------------------------

    @Test
    fun `an image whose release is revoked or gone is removed when the list loads`() {
        val other = TestImages.image(FirmwareVersion(1, 9, 0, 0))
        val revoked = TestImages.releaseFor(other, "1.9.0+0", status = "revoked")
        val gone = hex('9')
        val files = listOf(file(key, 1), file(revoked.sha256, 2), file(gone, 3))

        val removed = FirmwareCachePolicy.toRemove(files, listOf(release, revoked))
        assertEquals(setOf(revoked.sha256, gone), removed.map { it.key }.toSet())
    }

    @Test
    fun `an active release's image stays, whatever the case of its SHA-256 in the list`() {
        val files = listOf(file(key, 1))
        assertEquals(emptyList<CachedFile>(), FirmwareCachePolicy.toRemove(files, listOf(release.copy(sha256 = key.uppercase()))))
    }

    @Test
    fun `with no active release nothing stays, and stray files go too`() {
        val files = listOf(file(key, 1), CachedFile(".$key.1.tmp", 10, 0), CachedFile("notes.txt", 1, 0))
        assertEquals(files, FirmwareCachePolicy.toRemove(files, emptyList()))
        val stray = FirmwareCachePolicy.toRemove(files, listOf(release))
        assertEquals(listOf(".$key.1.tmp", "notes.txt"), stray.map { it.name })
        assertTrue(stray.none { it.key == key })
    }
}
