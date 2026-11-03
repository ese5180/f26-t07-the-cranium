package com.craniumiot.cranium.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.util.Base64

/** A change from the phone needs a sign-in in the last 15 minutes (docs/mobile-apps.md, "Signing in"). */
class FreshSignInTest {
    private val signedInAt = 1_798_000_000L

    private fun part(json: String) = Base64.getUrlEncoder().withoutPadding().encodeToString(json.toByteArray())

    private fun jwt(payload: String) = "${part("""{"alg":"RS256","kid":"k"}""")}.${part(payload)}.c2lnbmF0dXJl"

    @Test
    fun `the sign-in time is read from the access token`() {
        assertEquals(signedInAt, FreshSignIn.authTime(jwt("""{"sub":"s-1","auth_time":$signedInAt,"exp":1798003600}""")))
        // A payload whose length needs padding in standard base64.
        assertEquals(signedInAt, FreshSignIn.authTime(jwt("""{"auth_time":$signedInAt}""")))
        assertEquals(signedInAt, FreshSignIn.authTime(jwt("""{"auth_time":$signedInAt,"x":"ab"}""")))
    }

    @Test
    fun `a token without a sign-in time, or that is not a JWT, has none`() {
        assertNull(FreshSignIn.authTime(jwt("""{"sub":"s-1"}""")))
        assertNull(FreshSignIn.authTime(jwt("""{"auth_time":"$signedInAt"}""")))
        assertNull(FreshSignIn.authTime(jwt("""{"auth_time":0}""")))
        assertNull(FreshSignIn.authTime(jwt("""[1, 2]""")))
        assertNull(FreshSignIn.authTime(jwt("not json")))
        assertNull(FreshSignIn.authTime("only.two"))
        assertNull(FreshSignIn.authTime("a.b.c.d"))
        assertNull(FreshSignIn.authTime("abc.###.def"))
        assertNull(FreshSignIn.authTime(""))
        assertNull(FreshSignIn.authTime(null))
    }

    @Test
    fun `a sign-in is fresh for 14 minutes, a minute short of what the console allows`() {
        val at = signedInAt * 1000
        assertTrue(FreshSignIn.isFresh(signedInAt, at))
        assertTrue(FreshSignIn.isFresh(signedInAt, at + 14 * 60_000))
        assertFalse(FreshSignIn.isFresh(signedInAt, at + 14 * 60_000 + 1_000))
        assertFalse(FreshSignIn.isFresh(signedInAt, at + 15 * 60_000))
        // The phone's clock a little behind the one that stamped the token.
        assertTrue(FreshSignIn.isFresh(signedInAt, at - 60_000))
        assertFalse(FreshSignIn.isFresh(signedInAt, at - 61_000))
        assertFalse(FreshSignIn.isFresh(null, at))
        assertEquals(15 * 60L, FreshSignIn.WINDOW_SECONDS)
    }

    @Test
    fun `only the console's refusal of an old sign-in asks for a new one`() {
        assertTrue(FreshSignIn.isRefusal(ApiError(403, "phone_sign_in_again", "Sign in again first.")))
        assertFalse(FreshSignIn.isRefusal(ApiError(403, "release_manager_required", "Only release managers can do this.")))
        assertFalse(FreshSignIn.isRefusal(ApiError(401, "phone_sign_in_again", "x")))
        assertFalse(FreshSignIn.isRefusal(IOException("offline")))
        assertFalse(FreshSignIn.isRefusal(null))
        assertEquals("phone_sign_in_again", FreshSignIn.CODE)
    }
}
