package com.craniumiot.cranium.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.net.URI
import java.net.URLDecoder

class OAuthTest {

    /** apps/config/cranium.example.json: made-up values. The tests never read the real file. */
    private val example: JsonObject by lazy {
        val file = listOf("../../config/cranium.example.json", "../config/cranium.example.json")
            .map(::File).first { it.isFile }
        Json.parseToJsonElement(file.readText()) as JsonObject
    }

    private fun exampleValue(key: String) = example.getValue(key).jsonPrimitive.content

    // RFC 7636, appendix B.
    private val rfcVerifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    private val rfcChallenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"

    private fun query(url: String): List<Pair<String, String>> =
        URI(url).rawQuery.split("&").map {
            val (name, value) = it.split("=", limit = 2)
            URLDecoder.decode(name, "UTF-8") to URLDecoder.decode(value, "UTF-8")
        }

    @Test
    fun `the S256 challenge is RFC 7636's`() {
        assertEquals(rfcChallenge, Pkce.challengeOf(rfcVerifier))
    }

    @Test
    fun `a new verifier is long, random and unreserved`() {
        val one = Pkce.generate()
        val two = Pkce.generate()
        assertEquals(86, one.verifier.length)
        assertTrue(Pkce.isValidVerifier(one.verifier))
        assertTrue(one.verifier.matches(Regex("^[A-Za-z0-9_-]+$")))
        assertEquals(Pkce.challengeOf(one.verifier), one.challenge)
        assertEquals(43, one.challenge.length)
        assertNotEquals(one.verifier, two.verifier)
    }

    @Test(expected = IllegalArgumentException::class)
    fun `a verifier shorter than 43 characters is refused`() {
        Pkce.challengeOf("a".repeat(42))
    }

    @Test
    fun `the authorize URL has exactly the contract's parameters`() {
        val request = AuthorizeRequest(
            endpoint = CognitoEndpoints(exampleValue("loginDomain")).authorize,
            clientId = exampleValue("mobileClientId"),
            redirectUri = exampleValue("redirectUri"),
            state = "af0ifjsldkj",
            pkce = Pkce(rfcVerifier, rfcChallenge),
        )
        val url = request.url()
        assertTrue(url.startsWith("${exampleValue("loginDomain")}/oauth2/authorize?"))
        assertEquals(
            listOf(
                "response_type" to "code",
                "client_id" to "exampleclientid0000000000",
                "redirect_uri" to "cranium://signin",
                "scope" to "openid cranium/console",
                "code_challenge" to rfcChallenge,
                "code_challenge_method" to "S256",
                "state" to "af0ifjsldkj",
                "prompt" to "login",
            ),
            query(url),
        )
        // Spaces as "+", everything reserved escaped.
        assertTrue(url.contains("&scope=openid+cranium%2Fconsole&"))
        assertTrue(url.contains("&redirect_uri=cranium%3A%2F%2Fsignin&"))
        // No nonce, no client secret, nothing else.
        assertEquals(8, query(url).size)
    }

    @Test
    fun `every sign-in asks for the password again, so a sign-out ends the managed login's session too`() {
        val request = AuthorizeRequest.create(exampleValue("loginDomain"), "client", "cranium://signin")
        assertEquals("login", request.prompt)
        assertEquals("login", query(request.url()).toMap()["prompt"])
        // AppAuth's request is built with android.net.Uri, which a JVM test cannot make, so this
        // checks that AuthManager hands AppAuth the same prompt, once, before the request is built.
        val source = listOf(
            "src/main/java/com/craniumiot/cranium/auth/AuthManager.kt",
            "app/src/main/java/com/craniumiot/cranium/auth/AuthManager.kt",
        ).map(::File).first { it.isFile }.readText()
        val built = source.substringAfter("AuthorizationRequest.Builder(").substringBefore(".build()")
        assertEquals(1, Regex("""\.setPrompt\(spec\.prompt\)""").findAll(built).count())
        assertEquals(1, Regex("""\.setPrompt\(""").findAll(source).count())
    }

    @Test
    fun `a new request has a fresh state and PKCE pair`() {
        val one = AuthorizeRequest.create(exampleValue("loginDomain") + "/", "client", "cranium://signin")
        val two = AuthorizeRequest.create(exampleValue("loginDomain"), "client", "cranium://signin")
        assertEquals(two.endpoint, one.endpoint)
        assertTrue(one.endpoint.endsWith(".amazoncognito.com/oauth2/authorize"))
        assertEquals(43, one.state.length)
        assertNotEquals(one.state, two.state)
        assertNotEquals(one.pkce, two.pkce)
        assertEquals(Pkce.challengeOf(one.pkce.verifier), query(one.url()).toMap()["code_challenge"])
    }

    @Test
    fun `the token and revoke endpoints and the revoke form`() {
        val endpoints = CognitoEndpoints("https://login.example.com/")
        assertEquals("https://login.example.com/oauth2/token", endpoints.token)
        assertEquals("https://login.example.com/oauth2/revoke", endpoints.revoke)
        assertEquals("token=a%2Bb%3D&client_id=client", revokeForm("a+b=", "client"))
    }

    @Test
    fun `API paths encode the version's plus sign`() {
        val paths = ApiPaths("https://console.example.com/")
        assertEquals("https://console.example.com/api/me", paths.me)
        assertEquals("https://console.example.com/api/firmware", paths.firmware)
        assertEquals("https://console.example.com/api/firmware/1.8.0%2B0/image", paths.image("1.8.0+0"))
        assertEquals("https://console.example.com/api/pairing/Cranium-1A2B", paths.pairing("Cranium-1A2B"))
        assertEquals("https://console.example.com/api/firmware/1.8.0%2B0/bluetooth", paths.bluetooth("1.8.0+0"))
        assertEquals("a%20b%2Fc%C3%A9", ApiPaths.encodeSegment("a b/cé"))
    }

    @Test
    fun `board names are Cranium- and four upper-case hex digits`() {
        listOf("Cranium-1A2B", "Cranium-0000", "Cranium-FFFF").forEach { assertTrue(it, BoardBluetooth.isBoardName(it)) }
        listOf(null, "", "Cranium-1a2b", "Cranium-12345", "Cranium-123", "cranium-1A2B", "Cranium-1A2G", "Cranium")
            .forEach { assertTrue("$it", !BoardBluetooth.isBoardName(it)) }
    }

    @Test
    fun `a board's name in the console is cranium- and 16 lower-case hex digits`() {
        assertTrue(BoardBluetooth.isThing("cranium-0123456789abcdef"))
        listOf(null, "", "cranium-0123456789ABCDEF", "cranium-0123456789abcde", "cranium-0123456789abcdef0",
            "Cranium-1A2B", "cranium-0123456789abcdeg", " cranium-0123456789abcdef")
            .forEach { assertTrue("$it", !BoardBluetooth.isThing(it)) }
    }
}
