package com.craniumiot.cranium.core

/**
 * The 32-byte header at the start of a signed MCUboot image (bootutil/image.h), all fields
 * little-endian:
 *
 * ```
 *  0  magic            u32  0x96f3b83d, stored as 3d b8 f3 96
 *  4  load address     u32
 *  8  header size      u16
 * 10  protected TLVs   u16
 * 12  image size       u32
 * 16  flags            u32
 * 20  version          u8 major, u8 minor, u16 revision, u32 build number
 * 28  padding          u32
 * ```
 */
data class McubootHeader(
    val loadAddress: Long,
    val headerSize: Int,
    val protectedTlvSize: Int,
    val imageSize: Long,
    val flags: Long,
    val version: FirmwareVersion,
) {
    companion object {
        const val LENGTH = 32

        /** The magic as it is stored in the file. */
        val MAGIC: List<Byte> = listOf(0x3d, 0xb8, 0xf3, 0x96).map { it.toByte() }

        /** Whether [image] starts with MCUboot's magic. */
        fun hasMagic(image: ByteArray): Boolean =
            image.size >= MAGIC.size && MAGIC.indices.all { image[it] == MAGIC[it] }

        /** The header of [image], or null if it is shorter than a header or has no magic. */
        fun parse(image: ByteArray): McubootHeader? {
            if (image.size < LENGTH || !hasMagic(image)) return null
            return McubootHeader(
                loadAddress = u32(image, 4),
                headerSize = u16(image, 8),
                protectedTlvSize = u16(image, 10),
                imageSize = u32(image, 12),
                flags = u32(image, 16),
                version = FirmwareVersion(
                    major = u8(image, 20),
                    minor = u8(image, 21),
                    revision = u16(image, 22),
                    build = u32(image, 24),
                ),
            )
        }

        private fun u8(bytes: ByteArray, at: Int): Int = bytes[at].toInt() and 0xFF

        private fun u16(bytes: ByteArray, at: Int): Int = u8(bytes, at) or (u8(bytes, at + 1) shl 8)

        private fun u32(bytes: ByteArray, at: Int): Long =
            u16(bytes, at).toLong() or (u16(bytes, at + 2).toLong() shl 16)
    }
}
