package com.craniumiot.cranium.core

import java.security.MessageDigest

enum class ImageProblem { SIZE, SHA256, MAGIC, VERSION }

sealed class ImageCheckResult {
    data object Ok : ImageCheckResult()

    data class Failed(val problem: ImageProblem, val message: String) : ImageCheckResult()
}

/**
 * The checks on a downloaded image before it is sent (docs/mobile-apps.md, "The API"): its size and
 * SHA-256 match the release, it starts with MCUboot's magic, and the version in its header is the
 * release's. The board and its bootloader check it again; this catches a wrong file early.
 */
object ImageCheck {

    fun check(image: ByteArray, release: Release): ImageCheckResult {
        if (image.size.toLong() != release.size) {
            return ImageCheckResult.Failed(
                ImageProblem.SIZE,
                "The image is ${image.size} bytes, but release ${release.version} is ${release.size}.",
            )
        }
        if (!sha256Hex(image).equals(release.sha256, ignoreCase = true)) {
            return ImageCheckResult.Failed(
                ImageProblem.SHA256,
                "The image's SHA-256 does not match release ${release.version}.",
            )
        }
        val header = McubootHeader.parse(image)
            ?: return ImageCheckResult.Failed(
                ImageProblem.MAGIC,
                "This is not an MCUboot image: it does not start with 3d b8 f3 96.",
            )
        val expected = FirmwareVersion.parseRelease(release.version)
            ?: return ImageCheckResult.Failed(
                ImageProblem.VERSION,
                "Release version ${release.version} cannot be read.",
            )
        if (header.version != expected) {
            return ImageCheckResult.Failed(
                ImageProblem.VERSION,
                "The image's header says ${header.version}, but the release is ${release.version}.",
            )
        }
        return ImageCheckResult.Ok
    }

    fun sha256Hex(data: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { "%02x".format(it) }
}
