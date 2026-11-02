package com.craniumiot.cranium.core

/**
 * An MCUboot image version: the four fields of the image header. Major and minor are 8 bits,
 * the revision 16 and the build number 32.
 */
data class FirmwareVersion(
    val major: Int,
    val minor: Int,
    val revision: Int,
    val build: Long,
) : Comparable<FirmwareVersion> {

    init {
        require(major in 0..MAX_MAJOR && minor in 0..MAX_MINOR) { "major and minor are 8-bit" }
        require(revision in 0..MAX_REVISION) { "the revision is 16-bit" }
        require(build in 0..MAX_BUILD) { "the build number is 32-bit" }
    }

    override fun compareTo(other: FirmwareVersion): Int =
        compareValuesBy(this, other, { it.major }, { it.minor }, { it.revision }, { it.build })

    /** As the console writes it, always with the build number: `1.8.0+0`. */
    override fun toString(): String = "$major.$minor.$revision+$build"

    companion object {
        const val MAX_MAJOR = 0xFF
        const val MAX_MINOR = 0xFF
        const val MAX_REVISION = 0xFFFF
        const val MAX_BUILD = 0xFFFF_FFFFL

        // The console's form, as cloud/api/src/lib/mcuboot.mjs parses it: "1.8.0+0", the build optional.
        private val RELEASE =
            Regex("""^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,4})(?:\+(0|[1-9]\d{0,9}))?$""")

        // What the board's image list says. Zephyr's img_mgmt writes "1.8.0" when the build number
        // is 0 and "1.8.0.5" when it is not. A "+" is taken too.
        private val BOARD = Regex("""^(\d{1,3})\.(\d{1,3})\.(\d{1,5})(?:[.+](\d{1,10}))?$""")

        /** A release's version, `1.8.0+0`, or null if it is not one. */
        fun parseRelease(text: String): FirmwareVersion? = RELEASE.matchEntire(text)?.let(::fromMatch)

        /** The version the board reports for a slot, `1.8.0` or `1.8.0.5`, or null if it is not one. */
        fun parseBoard(text: String): FirmwareVersion? = BOARD.matchEntire(text.trim())?.let(::fromMatch)

        private fun fromMatch(match: MatchResult): FirmwareVersion? {
            val (majorText, minorText, revisionText, buildText) = match.destructured
            val major = majorText.toInt()
            val minor = minorText.toInt()
            val revision = revisionText.toInt()
            val build = if (buildText.isEmpty()) 0L else buildText.toLong()
            if (major > MAX_MAJOR || minor > MAX_MINOR || revision > MAX_REVISION || build > MAX_BUILD) return null
            return FirmwareVersion(major, minor, revision, build)
        }
    }
}
