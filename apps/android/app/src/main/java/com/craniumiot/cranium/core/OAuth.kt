package com.craniumiot.cranium.core

import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/** Cognito's managed login endpoints under the login domain (docs/mobile-apps.md, "Signing in"). */
class CognitoEndpoints(loginDomain: String) {
    private val base = loginDomain.trimEnd('/')
    val authorize: String = "$base/oauth2/authorize"
    val token: String = "$base/oauth2/token"
    val revoke: String = "$base/oauth2/revoke"
}

/** A PKCE pair (RFC 7636): a random verifier and its S256 challenge. */
data class Pkce(val verifier: String, val challenge: String) {
    companion object {
        const val METHOD = "S256"

        private val VERIFIER = Regex("^[A-Za-z0-9._~-]{43,128}$")

        /** 64 random bytes, base64url without padding: an 86-character verifier. */
        fun generate(random: SecureRandom = SecureRandom()): Pkce {
            val verifier = base64Url(ByteArray(64).also(random::nextBytes))
            return Pkce(verifier, challengeOf(verifier))
        }

        /** BASE64URL(SHA-256(ASCII(verifier))), without padding. */
        fun challengeOf(verifier: String): String {
            require(isValidVerifier(verifier)) { "A code verifier is 43 to 128 unreserved characters" }
            return base64Url(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))
        }

        fun isValidVerifier(verifier: String): Boolean = VERIFIER.matches(verifier)
    }
}

/**
 * The authorization request that starts a sign-in: authorization code with PKCE (S256), the
 * scopes `openid` and `cranium/console`, a random state, no nonce, and `prompt=login`. AppAuth
 * sends exactly these values ([com.craniumiot.cranium.auth.AuthManager]); [url] is the same request
 * as text.
 *
 * `prompt=login` has the managed login ask for the password and code every time, as the web
 * console does: the Custom Tab shares the browser's cookies, so without it a sign-out in the app
 * would leave Cognito's own session in the browser, and the next sign-in would go through with no
 * question asked, as whoever signed in last.
 */
data class AuthorizeRequest(
    val endpoint: String,
    val clientId: String,
    val redirectUri: String,
    val state: String,
    val pkce: Pkce,
) {
    val scope: String get() = SCOPE
    val prompt: String get() = PROMPT

    fun parameters(): List<Pair<String, String>> = listOf(
        "response_type" to "code",
        "client_id" to clientId,
        "redirect_uri" to redirectUri,
        "scope" to scope,
        "code_challenge" to pkce.challenge,
        "code_challenge_method" to Pkce.METHOD,
        "state" to state,
        "prompt" to prompt,
    )

    fun url(): String = endpoint + "?" + formEncode(parameters())

    companion object {
        const val SCOPE = "openid cranium/console"
        const val PROMPT = "login"

        fun create(
            loginDomain: String,
            clientId: String,
            redirectUri: String,
            random: SecureRandom = SecureRandom(),
        ): AuthorizeRequest = AuthorizeRequest(
            endpoint = CognitoEndpoints(loginDomain).authorize,
            clientId = clientId,
            redirectUri = redirectUri,
            state = base64Url(ByteArray(32).also(random::nextBytes)),
            pkce = Pkce.generate(random),
        )
    }
}

/** The form that revokes a refresh token: `POST {loginDomain}/oauth2/revoke`. */
fun revokeForm(refreshToken: String, clientId: String): String =
    formEncode(listOf("token" to refreshToken, "client_id" to clientId))

/** `application/x-www-form-urlencoded`, as for a query string. */
fun formEncode(parameters: List<Pair<String, String>>): String =
    parameters.joinToString("&") { (name, value) ->
        URLEncoder.encode(name, "UTF-8") + "=" + URLEncoder.encode(value, "UTF-8")
    }

internal fun base64Url(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
