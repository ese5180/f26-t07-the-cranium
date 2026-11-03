package com.craniumiot.cranium.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ApiJsonTest {

    // The shape cloud/api/src/handlers/firmware.mjs answers with, fields the app does not use included.
    private val list = """
        {
          "releases": [
            {
              "version": "1.8.0+0", "size": 761963,
              "sha256": "4f0c3a1c9e2d4b5a6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6",
              "imageHash": "", "keyHash": "", "payloadSize": 761000, "headerSize": 512, "loadAddress": 65536,
              "filename": "cranium-1.8.0.signed.bin", "notes": "LED1 and LED2 take turns",
              "uploadedBy": {"sub": "abc", "email": "someone@example.com"},
              "uploadedAt": "2026-11-01T17:00:00.000Z", "status": "active", "revoked": null
            },
            {
              "version": "1.7.9+0", "size": 760000,
              "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
              "notes": "", "uploadedAt": "2026-10-31T10:00:00.000Z", "status": "revoked",
              "revoked": {"by": {"sub": "", "email": ""}, "at": "2026-11-01T00:00:00.000Z", "reason": "bad", "enforcedAt": null}
            }
          ],
          "signingKey": {"fingerprint": "ab:cd"},
          "slotSize": 794624
        }
    """.trimIndent()

    @Test
    fun `decodes the release list`() {
        val decoded = ApiJson.releases(list)
        assertEquals(794_624L, decoded.slotSize)
        assertEquals(2, decoded.releases.size)
        val first = decoded.releases[0]
        assertEquals("1.8.0+0", first.version)
        assertEquals(761_963L, first.size)
        assertEquals("4f0c3a1c9e2d4b5a6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6", first.sha256)
        assertEquals("LED1 and LED2 take turns", first.notes)
        assertEquals("2026-11-01T17:00:00.000Z", first.uploadedAt)
        assertTrue(first.isActive)
        assertFalse(decoded.releases[1].isActive)
    }

    @Test
    fun `a release it cannot read is left out, not the list`() {
        val decoded = ApiJson.releases(
            """
            {"releases": [
              {"version": "1.8.0+0", "size": 10, "sha256": "aa", "status": "active"},
              {"version": "1.7.0+0", "size": "ten", "sha256": "bb", "status": "active"},
              {"version": "1.6.0+0", "size": 10, "status": "active"},
              "not an object",
              {"version": "1.5.0+0", "size": 10, "sha256": "cc", "status": "active", "notes": null}
            ]}
            """.trimIndent(),
        )
        assertEquals(listOf("1.8.0+0", "1.5.0+0"), decoded.releases.map { it.version })
        assertEquals("", decoded.releases[1].notes)
        assertNull(decoded.slotSize)
    }

    @Test
    fun `an empty list is a list`() {
        assertEquals(emptyList<Release>(), ApiJson.releases("""{"releases": [], "slotSize": 794624}""").releases)
    }

    @Test(expected = IllegalArgumentException::class)
    fun `an answer with no release list is an error`() {
        ApiJson.releases("""{"error": {"code": "x", "message": "y"}}""")
    }

    @Test
    fun `decodes me, pairing and a device`() {
        val me = ApiJson.me("""{"email": "rm@example.com", "groups": ["release-managers"], "canWrite": true, "expiresAt": 1798000000}""")
        assertEquals(Me("rm@example.com", listOf("release-managers"), true, expiresAt = 1798000000), me)
        assertFalse(ApiJson.me("""{"email": "viewer@example.com", "groups": [], "canWrite": false}""").canWrite)

        val pairing = ApiJson.pairing(
            """{"thing": "cranium-0123456789abcdef", "name": "Cranium-1A2B", "passkey": "012345", "reportedAt": "2026-11-02T10:00:00.000Z"}""",
        )
        assertEquals("012345", pairing.passkey)
        assertEquals("cranium-0123456789abcdef", pairing.thing)

        val device = ApiJson.device(
            """{"device": {"thing": "cranium-0123456789abcdef", "online": true, "lastSeen": null,
               "fw": {"version": "1.8.0+0", "confirmed": false}, "ota": null, "rssi": -60, "uptime": 12},
               "certificates": [], "executions": [], "olderExecutions": 0}""",
        )
        assertTrue(device.online)
        assertEquals(DeviceFirmware("1.8.0+0", false), device.fw)
        assertNull(ApiJson.device("""{"device": {"thing": "t", "online": false, "fw": null}}""").fw)
    }

    @Test
    fun `an error shows the console's message`() {
        val error = ApiJson.error(404, """{"error": {"code": "unknown_version", "message": "There is no active release 1.9.0+0."}}""")
        assertEquals(404, error.status)
        assertEquals("unknown_version", error.code)
        assertEquals("There is no active release 1.9.0+0.", error.message)
    }

    @Test
    fun `a 403 also says to ask for the role`() {
        val error = ApiJson.error(403, """{"error": {"code": "forbidden", "message": "Only release managers can do this."}}""")
        assertTrue(error.message!!.startsWith("Only release managers can do this."))
        assertTrue(error.message!!.contains("ask an administrator for the role"))
    }

    @Test
    fun `a 403 that is not about the role is shown as it is`() {
        val error = ApiJson.error(403, """{"error": {"code": "phone_sign_in_again", "message": "Sign in again first."}}""")
        assertEquals("Sign in again first.", error.message)
        assertEquals("phone_sign_in_again", error.code)
    }

    @Test
    fun `an error that is not JSON still says something`() {
        val error = ApiJson.error(502, "<html>Bad Gateway</html>")
        assertEquals("", error.code)
        assertEquals("The console answered with HTTP 502.", error.message)
    }
}
