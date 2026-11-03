package com.craniumiot.cranium.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** The check right before every Bluetooth send: `POST /api/firmware/{version}/bluetooth`. */
class SendCheckTest {
    private val image = TestImages.image(FirmwareVersion(1, 8, 0, 0))
    private val release = TestImages.releaseFor(image, "1.8.0+0")
    private val sha256 = ImageCheck.sha256Hex(image)

    // The answer cloud/api/src/handlers/firmware.mjs gives when the image may be sent.
    private fun answer(version: String = "1.8.0+0", sha: String = sha256, status: String = "active") =
        """{"version": "$version", "sha256": "$sha", "status": "$status"}"""

    private fun cleared(answer: String, sha: String = sha256): Boolean = try {
        SendCheck.requireCleared(answer, release, sha)
        true
    } catch (e: SendNotCleared) {
        assertTrue(e.message!!.contains("nothing was sent"))
        false
    }

    @Test
    fun `the body carries the image's SHA-256, and the board's name only if it is one`() {
        val withBoard = Json.parseToJsonElement(SendCheck.body(sha256, "Cranium-1A2B")) as JsonObject
        assertEquals(setOf("sha256", "board"), withBoard.keys)
        assertEquals(sha256, withBoard.getValue("sha256").jsonPrimitive.content)
        assertEquals("Cranium-1A2B", withBoard.getValue("board").jsonPrimitive.content)
        // A board found by its address, or under another name, is not named: the console would refuse it.
        for (board in listOf(null, "", "AA:BB:CC:DD:EE:FF", "Cranium-1a2b", "Cranium-12345")) {
            val body = Json.parseToJsonElement(SendCheck.body(sha256, board)) as JsonObject
            assertEquals("$board", setOf("sha256"), body.keys)
        }
    }

    @Test
    fun `only a SHA-256 in lower case is ever sent`() {
        for (bad in listOf("", sha256.uppercase(), sha256.drop(1), "${sha256}0", "x".repeat(64))) {
            try {
                SendCheck.body(bad, null)
                fail("sent $bad")
            } catch (e: IllegalArgumentException) {
                // Refused before anything is sent.
            }
        }
    }

    @Test
    fun `an answer that names the same release, the same SHA-256 and active clears the send`() {
        assertTrue(cleared(answer()))
        // Fields the app does not read do not matter.
        assertTrue(cleared("""{"version": "1.8.0+0", "sha256": "$sha256", "status": "active", "extra": 1}"""))
    }

    @Test
    fun `anything else is no`() {
        assertFalse(cleared(answer(sha = "0".repeat(64))))
        assertFalse(cleared(answer(sha = sha256.uppercase())))
        assertFalse(cleared(answer(version = "1.8.0+1")))
        assertFalse(cleared(answer(version = "1.8.0")))
        assertFalse(cleared(answer(status = "revoked")))
        assertFalse(cleared(answer(status = "Active")))
        assertFalse(cleared(answer(), sha = "0".repeat(64)))
        for (odd in listOf(
            "", "{", "null", "[]", "\"active\"", "{}",
            """{"version": "1.8.0+0", "sha256": "$sha256"}""",
            """{"version": "1.8.0+0", "sha256": "$sha256", "status": true}""",
            """{"version": "1.8.0+0", "sha256": null, "status": "active"}""",
            """{"error": {"code": "release_revoked", "message": "Release 1.8.0+0 is revoked."}}""",
        )) {
            assertFalse(odd, cleared(odd))
        }
    }
}
