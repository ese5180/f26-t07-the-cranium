package com.craniumiot.cranium.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** The console did not clear an image for a Bluetooth send. Nothing may be sent. */
class SendNotCleared(message: String) : Exception(message)

/**
 * The console's word right before every Bluetooth send (docs/mobile-apps.md, "The API"):
 * `POST /api/firmware/{version}/bluetooth` with the SHA-256 of the image that is about to go and
 * the board's name. It is asked whether the image was downloaded just now or kept on the phone,
 * because only the console knows whether a release has been revoked since. Only an answer of 200
 * that names the same release, the same SHA-256 and `active` lets the image go. Whatever else comes
 * back, or nothing at all because the phone is offline, nothing is sent: there is no falling back
 * on the cache, and no earlier answer counts.
 */
object SendCheck {
    private val SHA256 = Regex("^[0-9a-f]{64}$")
    private val json = Json { ignoreUnknownKeys = true }

    /**
     * The request body: `{"sha256": "…", "board": "Cranium-1A2B"}`. [sha256] is the image's, in
     * lower case; [board] goes in only if it is a board's name, and is left out otherwise.
     */
    fun body(sha256: String, board: String?): String {
        require(SHA256.matches(sha256)) { "A SHA-256 is 64 lower-case hex digits" }
        return buildJsonObject {
            put("sha256", sha256)
            if (board != null && BoardBluetooth.isBoardName(board)) put("board", board)
        }.toString()
    }

    /**
     * Returns only if [answer], the body of a 200, clears [release] with exactly [sha256]: the same
     * version, the same digest, and `active`. Throws [SendNotCleared] for anything else.
     */
    fun requireCleared(answer: String, release: Release, sha256: String) {
        val root = runCatching { json.parseToJsonElement(answer) as? JsonObject }.getOrNull()
            ?: throw SendNotCleared("The console's answer could not be read, so nothing was sent.")
        fun text(name: String): String? = (root[name] as? JsonPrimitive)?.takeIf { it.isString }?.content
        if (text("version") != release.version || text("sha256") != sha256 || text("status") != "active") {
            throw SendNotCleared(
                "The console did not confirm that this image of ${release.version} is still active, so nothing was sent.",
            )
        }
    }
}
