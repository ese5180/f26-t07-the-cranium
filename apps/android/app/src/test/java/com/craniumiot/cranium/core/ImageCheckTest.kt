package com.craniumiot.cranium.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ImageCheckTest {
    private val version = FirmwareVersion(1, 8, 0, 0)
    private val image = TestImages.image(version)
    private val release = TestImages.releaseFor(image, "1.8.0+0")

    private fun problem(image: ByteArray, release: Release): ImageProblem? =
        (ImageCheck.check(image, release) as? ImageCheckResult.Failed)?.problem

    @Test
    fun `an image that matches its release passes`() {
        assertEquals(ImageCheckResult.Ok, ImageCheck.check(image, release))
        // The console writes the digest in lower case; upper case is the same digest.
        assertEquals(ImageCheckResult.Ok, ImageCheck.check(image, release.copy(sha256 = release.sha256.uppercase())))
    }

    @Test
    fun `the size must match`() {
        assertEquals(ImageProblem.SIZE, problem(image.copyOf(image.size - 1), release))
        assertEquals(ImageProblem.SIZE, problem(image + byteArrayOf(0), release))
        assertEquals(ImageProblem.SIZE, problem(image, release.copy(size = release.size + 1)))
    }

    @Test
    fun `the SHA-256 must match`() {
        val changed = image.copyOf().also { it[it.size - 1] = (it[it.size - 1] + 1).toByte() }
        assertEquals(ImageProblem.SHA256, problem(changed, release))
        assertEquals(ImageProblem.SHA256, problem(image, release.copy(sha256 = "0".repeat(64))))
    }

    @Test
    fun `it must start with MCUboot's magic`() {
        val noMagic = image.copyOf().also { it[0] = 0 }
        assertEquals(ImageProblem.MAGIC, problem(noMagic, TestImages.releaseFor(noMagic, "1.8.0+0")))
        val tiny = byteArrayOf(0x3d, 0xb8.toByte(), 0xf3.toByte(), 0x96.toByte())
        assertEquals(ImageProblem.MAGIC, problem(tiny, TestImages.releaseFor(tiny, "1.8.0+0")))
    }

    @Test
    fun `the header's version must be the release's`() {
        listOf("1.8.1+0", "1.8.0+1", "1.9.0+0", "2.8.0+0", "0.8.0+0").forEach {
            assertEquals(it, ImageProblem.VERSION, problem(image, release.copy(version = it)))
        }
        // "1.8.0" is "1.8.0+0".
        assertEquals(ImageCheckResult.Ok, ImageCheck.check(image, release.copy(version = "1.8.0")))
        assertEquals(ImageProblem.VERSION, problem(image, release.copy(version = "not a version")))
    }

    @Test
    fun `a build number and revision in the header are compared too`() {
        val other = TestImages.image(FirmwareVersion(1, 8, 258, 4_000_000_000L))
        assertEquals(ImageCheckResult.Ok, ImageCheck.check(other, TestImages.releaseFor(other, "1.8.258+4000000000")))
        assertEquals(ImageProblem.VERSION, problem(other, TestImages.releaseFor(other, "1.8.258+0")))
    }

    @Test
    fun `the size is checked first, so a short download says so`() {
        val failed = ImageCheck.check(ByteArray(10), release) as ImageCheckResult.Failed
        assertEquals(ImageProblem.SIZE, failed.problem)
        assertTrue(failed.message.contains("10 bytes"))
    }

    @Test
    fun `sha256Hex is lower-case hex`() {
        // SHA-256 of "abc", FIPS 180-2.
        assertEquals(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            ImageCheck.sha256Hex("abc".toByteArray()),
        )
    }
}
