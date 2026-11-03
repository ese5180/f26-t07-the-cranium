package com.craniumiot.cranium.core

/** The console's API calls under [consoleUrl] (docs/mobile-apps.md, "The API"). */
class ApiPaths(consoleUrl: String) {
    private val base = consoleUrl.trimEnd('/')

    val me: String get() = "$base/api/me"
    val firmware: String get() = "$base/api/firmware"

    /** The signed image of a release. `{version}` is the text from the list, URL-encoded. */
    fun image(version: String): String = "$base/api/firmware/${encodeSegment(version)}/image"

    fun pairing(name: String): String = "$base/api/pairing/${encodeSegment(name)}"

    /** The check right before every Bluetooth send: may this image of the release be sent now? */
    fun bluetooth(version: String): String = "$base/api/firmware/${encodeSegment(version)}/bluetooth"

    fun device(thing: String): String = "$base/api/devices/${encodeSegment(thing)}"

    companion object {
        private const val HEX = "0123456789ABCDEF"

        /**
         * One path segment, percent-encoded: everything but RFC 3986's unreserved characters, so
         * that the `+` of `1.8.0+0` goes as `%2B` and is never read as a space.
         */
        fun encodeSegment(text: String): String = buildString {
            for (byte in text.toByteArray(Charsets.UTF_8)) {
                val c = byte.toInt() and 0xFF
                val ch = c.toChar()
                if (ch in 'A'..'Z' || ch in 'a'..'z' || ch in '0'..'9' || ch == '-' || ch == '.' || ch == '_' || ch == '~') {
                    append(ch)
                } else {
                    append('%').append(HEX[c shr 4]).append(HEX[c and 0x0F])
                }
            }
        }
    }
}
