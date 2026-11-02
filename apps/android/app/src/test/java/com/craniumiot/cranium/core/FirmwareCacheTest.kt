package com.craniumiot.cranium.core

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException

/** The cache on real files, in a temporary folder, with a clock the test moves. */
class FirmwareCacheTest {
    @get:Rule
    val folder = TemporaryFolder()

    private val dir: File by lazy { File(folder.root, "firmware") }
    private var clock = 1_800_000_000_000L
    private val cache by lazy { FirmwareCache(dir, now = { clock }) }

    private fun image(minor: Int) = TestImages.image(FirmwareVersion(1, minor, 0, 0))

    private fun releaseOf(image: ByteArray, status: String = "active"): Release =
        TestImages.releaseFor(image, "1.${image[21]}.0+0", status)

    private fun fileOf(release: Release) = File(dir, "${release.sha256}.bin")

    /** Obtains [release], counting the downloads of [served]; returns the result and the steps. */
    private fun obtain(release: Release, served: ByteArray, downloads: IntArray = IntArray(1)): Pair<ObtainedImage, List<ImageStep>> {
        val steps = mutableListOf<ImageStep>()
        val result = runBlocking {
            cache.obtain(release, onStep = { steps += it }) {
                downloads[0]++
                served
            }
        }
        return result to steps
    }

    private fun ready(result: ObtainedImage): ObtainedImage.Ready =
        result as? ObtainedImage.Ready ?: throw AssertionError("expected an image, got $result")

    @Test
    fun `nothing on the phone - downloads, checks, and keeps it under its SHA-256`() {
        val image = image(8)
        val release = releaseOf(image)
        val downloads = IntArray(1)

        val (result, steps) = obtain(release, image, downloads)

        assertEquals(1, downloads[0])
        assertEquals(ImageOrigin.DOWNLOADED, ready(result).origin)
        assertArrayEquals(image, ready(result).image)
        assertEquals(listOf(ImageStep.CHECKING, ImageStep.DOWNLOADING, ImageStep.CHECKING), steps)
        assertArrayEquals(image, fileOf(release).readBytes())
        assertEquals(listOf("${release.sha256}.bin"), dir.list()!!.toList())
        assertEquals(CacheSummary(setOf(release.sha256), image.size.toLong()), cache.summary())
        assertTrue(cache.summary().holds(release))
    }

    @Test
    fun `on the phone and passing the check - used, with no download`() {
        val image = image(8)
        val release = releaseOf(image)
        obtain(release, image)
        clock += 60_000

        val downloads = IntArray(1)
        val (result, steps) = obtain(release, ByteArray(0), downloads)

        assertEquals(0, downloads[0])
        assertEquals(ImageOrigin.PHONE, ready(result).origin)
        assertArrayEquals(image, ready(result).image)
        assertEquals(listOf(ImageStep.CHECKING), steps)
        assertEquals("using it makes it the last used", clock, fileOf(release).lastModified())
    }

    @Test
    fun `on the phone but changed - deleted, downloaded again, and replaced`() {
        val image = image(8)
        val release = releaseOf(image)
        obtain(release, image)
        // Same size, one byte different: only the SHA-256 tells.
        fileOf(release).writeBytes(image.copyOf().also { it[300] = (it[300] + 1).toByte() })

        val downloads = IntArray(1)
        val (result, _) = obtain(release, image, downloads)

        assertEquals(1, downloads[0])
        assertEquals(ImageOrigin.DOWNLOADED, ready(result).origin)
        assertArrayEquals(image, fileOf(release).readBytes())
    }

    @Test
    fun `on the phone but cut short or too long - replaced`() {
        val image = image(8)
        val release = releaseOf(image)
        for (bad in listOf(image.copyOf(100), image + ByteArray(5000), ByteArray(0))) {
            dir.mkdirs()
            fileOf(release).writeBytes(bad)
            val downloads = IntArray(1)
            val (result, _) = obtain(release, image, downloads)
            assertEquals(1, downloads[0])
            assertEquals(ImageOrigin.DOWNLOADED, ready(result).origin)
            assertArrayEquals(image, fileOf(release).readBytes())
        }
    }

    @Test
    fun `a download that fails the check is not kept, and not sent`() {
        val image = image(8)
        val release = releaseOf(image)
        val wrong = image(9)

        val (result, _) = obtain(release, wrong)

        assertEquals(ImageProblem.SHA256, (result as ObtainedImage.Failed).failure.problem)
        assertFalse(fileOf(release).exists())
        assertEquals(CacheSummary.EMPTY, cache.summary())
    }

    @Test
    fun `a cached file that fails, then a download that fails - nothing is left`() {
        val image = image(8)
        val release = releaseOf(image)
        dir.mkdirs()
        fileOf(release).writeBytes(image.copyOf(10))

        val (result, _) = obtain(release, image.copyOf(10))

        assertTrue(result is ObtainedImage.Failed)
        assertEquals(emptyList<String>(), dir.list()!!.toList())
    }

    @Test
    fun `a download that throws keeps nothing`() {
        val release = releaseOf(image(8))
        try {
            runBlocking { cache.obtain(release) { throw IOException("offline") } }
            fail("expected the download's exception")
        } catch (e: IOException) {
            assertEquals("offline", e.message)
        }
        assertEquals(CacheSummary.EMPTY, cache.summary())
    }

    @Test
    fun `no temporary file is left after a download is kept`() {
        val image = image(8)
        obtain(releaseOf(image), image)
        assertTrue(cache.files().all { it.key != null })
    }

    @Test
    fun `at most five are kept, and the least recently used goes`() {
        val images = (1..6).map { image(it) }
        val releases = images.map { releaseOf(it) }
        images.zip(releases).take(5).forEach { (image, release) ->
            obtain(release, image)
            clock += 1_000
        }
        // Use the first again: now the second is the least recently used.
        assertEquals(ImageOrigin.PHONE, ready(obtain(releases[0], ByteArray(0)).first).origin)
        clock += 1_000

        obtain(releases[5], images[5])

        assertEquals(5, cache.summary().count)
        assertFalse(fileOf(releases[1]).exists())
        listOf(0, 2, 3, 4, 5).forEach { assertTrue("release ${releases[it].version}", fileOf(releases[it]).exists()) }
    }

    @Test
    fun `loading the list removes the images of revoked and vanished releases, and stray files`() {
        val images = (1..3).map { image(it) }
        val releases = images.map { releaseOf(it) }
        images.zip(releases).forEach { (image, release) -> obtain(release, image) }
        File(dir, ".${releases[0].sha256}.123.tmp").writeBytes(ByteArray(3))

        // 1.1.0 stays active, 1.2.0 is revoked, 1.3.0 is gone from the list.
        cache.prune(listOf(releases[0], releases[1].copy(status = "revoked")))

        assertEquals(listOf("${releases[0].sha256}.bin"), dir.list()!!.toList())
    }

    @Test
    fun `clear removes everything`() {
        val image = image(8)
        obtain(releaseOf(image), image)
        cache.clear()
        assertFalse(dir.exists())
        assertEquals(CacheSummary.EMPTY, cache.summary())
    }

    @Test
    fun `a download under way when the cache is cleared is sent, but not kept`() {
        val image = image(8)
        val release = releaseOf(image)
        val result = runBlocking {
            cache.obtain(release) {
                cache.clear() // Sign-out, or "Clear downloaded firmware", during the download.
                image
            }
        }
        assertEquals(ImageOrigin.DOWNLOADED, ready(result).origin)
        assertFalse(fileOf(release).exists())
    }

    @Test
    fun `a release whose SHA-256 is not usable as a name is downloaded every time and never kept`() {
        val image = image(8)
        val release = releaseOf(image).copy(sha256 = "../escape")
        val downloads = IntArray(1)
        val (result, _) = obtain(release, image, downloads)
        assertEquals(1, downloads[0])
        assertTrue(result is ObtainedImage.Failed) // The check needs the real SHA-256 anyway.
        assertFalse(File(folder.root, "escape").exists())
        assertFalse(dir.exists())
    }
}
