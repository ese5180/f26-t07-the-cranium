package com.craniumiot.cranium.core

/** The console's API calls under [consoleUrl] (cloud/api/src/app.mjs; docs/mobile-apps.md, "The API"). */
class ApiPaths(consoleUrl: String) {
    private val base = consoleUrl.trimEnd('/')

    val root: String get() = "$base/"
    val me: String get() = "$base/api/me"
    val firmware: String get() = "$base/api/firmware"
    val devices: String get() = "$base/api/devices"
    val deployments: String get() = "$base/api/deployments"
    val tokens: String get() = "$base/api/tokens"

    /** The signed image of a release. `{version}` is the text from the list, URL-encoded. */
    fun image(version: String): String = "$base/api/firmware/${encodeSegment(version)}/image"

    fun pairing(name: String): String = "$base/api/pairing/${encodeSegment(name)}"

    /** The check right before every Bluetooth send: may this image of the release be sent now? */
    fun bluetooth(version: String): String = "$base/api/firmware/${encodeSegment(version)}/bluetooth"

    fun revoke(version: String): String = "$base/api/firmware/${encodeSegment(version)}/revoke"

    fun device(thing: String): String = "$base/api/devices/${encodeSegment(thing)}"

    fun samples(thing: String, hours: Int): String = "$base/api/devices/${encodeSegment(thing)}/samples?hours=$hours"

    fun deployment(id: String): String = "$base/api/deployments/${encodeSegment(id)}"

    fun cancel(id: String): String = "$base/api/deployments/${encodeSegment(id)}/cancel"

    fun revokeToken(id: String): String = "$base/api/tokens/${encodeSegment(id)}/revoke"

    fun audit(limit: Int, before: String?): String =
        "$base/api/audit?" + formEncode(listOfNotNull("limit" to limit.toString(), before?.let { "before" to it }))

    /** The boards' events between two times (ISO), newest first, a page at a time. */
    fun events(from: String, to: String, thing: String?, kinds: List<String>?, cursor: String?): String =
        "$base/api/events?" + formEncode(
            listOfNotNull(
                "from" to from,
                "to" to to,
                thing?.let { "thing" to it },
                kinds?.let { "kinds" to it.joinToString(",") },
                cursor?.let { "cursor" to it },
            ),
        )

    /** The boards' own log between two times (ISO), newest first, a page at a time (`thing` is one board). */
    fun boardLog(
        from: String,
        to: String,
        thing: String? = null,
        kinds: List<String>? = null,
        tags: List<String>? = null,
        limit: Int? = null,
        cursor: String? = null,
    ): String = "$base/api/events/log?" + formEncode(
        listOfNotNull(
            "from" to from,
            "to" to to,
            thing?.let { "thing" to it },
            kinds?.let { "kinds" to it.joinToString(",") },
            tags?.let { "tags" to it.joinToString(",") },
            limit?.let { "limit" to it.coerceIn(1, BoardLog.PAGE).toString() },
            cursor?.let { "cursor" to it },
        ),
    )

    /**
     * Every update of every board, or of the board `thing`, newest first, a page at a time (console
     * 2.1.1): deployments and the updates the boards reported themselves. `limit` is 1 to 100.
     */
    fun updates(thing: String? = null, limit: Int? = null, cursor: String? = null): String {
        val query = listOfNotNull(
            thing?.let { "thing" to it },
            limit?.let { "limit" to it.coerceIn(1, UPDATES_PAGE).toString() },
            cursor?.let { "cursor" to it },
        )
        return "$base/api/updates" + if (query.isEmpty()) "" else "?" + formEncode(query)
    }

    /** A release's note, changed after its upload. */
    fun notes(version: String): String = "$base/api/firmware/${encodeSegment(version)}/notes"

    /** The record of a command that changed a board at its serial console. */
    val serialCommands: String get() = "$base/api/serial/commands"

    /** The website's history of commits, beside its scripts under the build id. */
    fun history(build: String): String = "$base/assets/${encodeSegment(build)}/history.json"

    companion object {
        private const val HEX = "0123456789ABCDEF"

        /** The most updates one page of `GET /api/updates` holds. */
        const val UPDATES_PAGE = 100

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

        /** The build id in the console's own page: its scripts are under `/assets/<build>/`. */
        fun buildIdIn(html: String): String? {
            val match = Regex("/assets/([A-Za-z0-9._-]{1,64})/app\\.js").find(html) ?: return null
            val build = match.groupValues[1]
            return build.takeIf { it != "." && it != ".." }
        }
    }
}
