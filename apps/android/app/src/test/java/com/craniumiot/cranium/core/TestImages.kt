package com.craniumiot.cranium.core

/** Synthetic MCUboot images for the tests: a real header, made-up payload, no signature. */
object TestImages {
    fun header(
        major: Int = 1,
        minor: Int = 8,
        revision: Int = 0,
        build: Long = 0,
        magic: List<Int> = listOf(0x3d, 0xb8, 0xf3, 0x96),
        loadAddress: Long = 0,
        headerSize: Int = 0x200,
        protectedTlvSize: Int = 0,
        imageSize: Long = 0,
        flags: Long = 0,
    ): ByteArray {
        val bytes = ByteArray(McubootHeader.LENGTH)
        magic.forEachIndexed { i, b -> bytes[i] = b.toByte() }
        putU32(bytes, 4, loadAddress)
        putU16(bytes, 8, headerSize)
        putU16(bytes, 10, protectedTlvSize)
        putU32(bytes, 12, imageSize)
        putU32(bytes, 16, flags)
        bytes[20] = major.toByte()
        bytes[21] = minor.toByte()
        putU16(bytes, 22, revision)
        putU32(bytes, 24, build)
        return bytes
    }

    /** A header for [version] padded to 0x200 bytes, then [payloadSize] bytes of payload. */
    fun image(version: FirmwareVersion = FirmwareVersion(1, 8, 0, 0), payloadSize: Int = 4096): ByteArray {
        val head = header(version.major, version.minor, version.revision, version.build, imageSize = payloadSize.toLong())
        val image = ByteArray(0x200 + payloadSize) { i -> (i * 31 + 7).toByte() }
        head.copyInto(image)
        for (i in McubootHeader.LENGTH until 0x200) image[i] = 0
        return image
    }

    /** The release the console would list for [image]. */
    fun releaseFor(image: ByteArray, version: String, status: String = "active"): Release =
        Release(version = version, size = image.size.toLong(), sha256 = ImageCheck.sha256Hex(image), status = status)

    private fun putU16(bytes: ByteArray, at: Int, value: Int) {
        bytes[at] = (value and 0xFF).toByte()
        bytes[at + 1] = ((value shr 8) and 0xFF).toByte()
    }

    private fun putU32(bytes: ByteArray, at: Int, value: Long) {
        for (i in 0 until 4) bytes[at + i] = ((value shr (8 * i)) and 0xFF).toByte()
    }
}
