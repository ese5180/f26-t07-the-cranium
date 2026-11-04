package com.craniumiot.cranium.auth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import java.util.Base64

/** The session as it is kept: when the sign-in was, which the hour without fingerprint unlock counts from. */
class SessionTest {
    private fun jwt(claims: String): String {
        val encoder = Base64.getUrlEncoder().withoutPadding()
        return "${encoder.encodeToString("{\"alg\":\"none\"}".toByteArray())}.${encoder.encodeToString(claims.toByteArray())}.sig"
    }

    @Test
    fun `the time of the sign-in is kept, and read back`() {
        val session = Session(jwt("""{"auth_time":1800000000}"""), null, "refresh-secret", 1_800_003_600, Session.SRP, signedInAt = 1_800_000_005)
        val back = Session.fromJson(session.toJson())!!
        assertEquals(session, back)
        assertEquals(1_800_000_005, back.signedIn)
    }

    @Test
    fun `a session kept by 0_3_0 has no time of its own, so the access token's auth_time stands in`() {
        val kept = """{"accessToken":"${jwt("""{"auth_time":1800000000}""")}","refreshToken":"r","expiresAt":1800003600,"via":"srp"}"""
        val session = Session.fromJson(kept)!!
        assertEquals(0, session.signedInAt)
        assertEquals(1_800_000_000, session.signedIn)
        assertEquals(0, Session("not-a-jwt", null, "r", 0, Session.HOSTED).signedIn)
    }

    @Test
    fun `printed, a session shows no token`() {
        val session = Session("access-secret", "id-secret", "refresh-secret", 1, Session.FINGERPRINT)
        val text = session.toString()
        for (secret in listOf("access-secret", "id-secret", "refresh-secret")) assertFalse(text.contains(secret))
        assertNull(Session.fromJson("""{"accessToken":"","expiresAt":1}"""))
    }
}
