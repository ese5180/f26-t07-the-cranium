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

    /**
     * MCUboot's `IMAGE_TLV_SHA256` (type 0x10) in the TLV area after the protected one, as hex. Null when
     * the area is not there or has no such entry.
     */
    fun imageHash(image: ByteArray, header: McubootHeader): String? {
        fun u16(at: Int): Int = (image[at].toInt() and 0xFF) or ((image[at + 1].toInt() and 0xFF) shl 8)
        val start = header.headerSize.toLong() + header.imageSize + header.protectedTlvSize
        if (start + 4 > image.size || u16(start.toInt()) != 0x6907) return null
        var i = start.toInt()
        val end = minOf(image.size, i + u16(i + 2))
        i += 4
        while (i + 4 <= end) {
            val type = u16(i)
            val length = u16(i + 2)
            i += 4
            if (type == 0x10 && length == 32 && i + 32 <= end) {
                return (i until i + 32).joinToString("") { "%02x".format(image[it]) }
            }
            i += length
        }
        return null
    }

    /**
     * The first 8 bytes of the image's own SHA-256, from its TLV area, in lower-case hex: what the board
     * keeps in its record of an update over Bluetooth, and shows in its status ([BoardStatus.lastHash]).
     * Not the SHA-256 of the file. Null when the TLV area cannot be read.
     */
    fun imageHashPrefix(image: ByteArray): String? =
        McubootHeader.parse(image)?.let { imageHash(image, it) }?.take(16)

    fun sha256Hex(data: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { "%02x".format(it) }
}
