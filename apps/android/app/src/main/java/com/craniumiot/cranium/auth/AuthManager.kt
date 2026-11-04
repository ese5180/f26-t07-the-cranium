package com.craniumiot.cranium.auth

import android.content.Context
import android.content.Intent
import androidx.core.net.toUri
import com.craniumiot.cranium.CraniumConfig
import com.craniumiot.cranium.core.AuthorizeRequest
import com.craniumiot.cranium.core.CognitoEndpoints
import com.craniumiot.cranium.core.CognitoSignIn
import com.craniumiot.cranium.core.CognitoTokens
import com.craniumiot.cranium.core.FreshSignIn
import com.craniumiot.cranium.core.Pkce
import com.craniumiot.cranium.core.Refreshed
import com.craniumiot.cranium.core.SignInStep
import com.craniumiot.cranium.core.revokeForm
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import net.openid.appauth.AuthorizationException
import net.openid.appauth.AuthorizationRequest
import net.openid.appauth.AuthorizationResponse
import net.openid.appauth.AuthorizationService
import net.openid.appauth.AuthorizationServiceConfiguration
import net.openid.appauth.ResponseTypeValues
import net.openid.appauth.TokenRequest
import net.openid.appauth.TokenResponse
import java.net.HttpURLConnection
import java.net.URL
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** The person has to sign in (again). */
class SignedOutException(message: String) : Exception(message)

/** Signing in, or refreshing the tokens, did not work. */
class SignInException(message: String) : Exception(message)

/**
 * Signing in, two ways, both ending in the same [Session]:
 *
 *  - the app's own screen: e-mail address and password, then the code in six boxes, through
 *    Cognito's user pool API (USER_SRP_AUTH, [CognitoSignIn]) as the console's own page does. The
 *    password is used for the proof and nothing else.
 *  - the AWS sign-in page (Cognito's managed login) through AppAuth: authorization code with PKCE,
 *    in a Custom Tab, redirect `cranium://signin` (docs/mobile-apps.md, "Signing in"). For a step
 *    the app's screen does not do, and when the person asks for it.
 *
 * Both kinds of session are refreshed the same way: InitiateAuth REFRESH_TOKEN_AUTH on the user
 * pool API. Cognito takes a refresh token of this client there whichever way it was issued, and
 * the sign-in trigger gives the refreshed access token of this client the console's scope
 * (cloud/api/src/signin-scope.mjs, TokenGeneration_RefreshTokens), so one way covers both. A
 * refresh keeps the `auth_time` of the sign-in, which the rule of a fresh sign-in reads.
 *
 * Construct it off the main thread; call the rest from the main thread.
 */
class AuthManager(context: Context, private val config: CraniumConfig, private val store: TokenStore) {
    private val service = AuthorizationService(context.applicationContext)
    private val endpoints = CognitoEndpoints(config.loginDomain)
    private val serviceConfig = AuthorizationServiceConfiguration(endpoints.authorize.toUri(), endpoints.token.toUri())
    private val cognito = CognitoSignIn(CognitoHttp(config.region), config.mobileClientId, config.userPoolId)
    private val mutex = Mutex()

    @Volatile
    private var session: Session? = store.load()

    val isSignedIn: Boolean get() = session != null

    /** The last searches, which go with a sign-out (TokenStore). */
    fun recentSearches(): List<String> = store.recentSearches()

    fun saveRecentSearches(list: List<String>) = store.saveRecentSearches(list)

    // The app's own sign-in screen.

    /** The e-mail address and the password: the proof of the password, then the code, a token, or the AWS page. */
    suspend fun passwordSignIn(email: String, password: String): SignInStep = keepIfDone(cognito.passwordSignIn(email, password))

    /** The six digits from the authenticator app. */
    suspend fun sendCode(code: String): SignInStep = keepIfDone(cognito.sendCode(code))

    /** Drop a sign-in that waits for its code. */
    fun cancelPasswordSignIn() = cognito.cancel()

    private suspend fun keepIfDone(step: SignInStep): SignInStep {
        if (step is SignInStep.Done) keep(step.tokens, Session.SRP)
        return step
    }

    private suspend fun keep(tokens: CognitoTokens, via: String) {
        val now = System.currentTimeMillis() / 1000
        val fresh = Session(tokens.accessToken, tokens.idToken, tokens.refreshToken, now + tokens.expiresIn, via)
        mutex.withLock {
            withContext(Dispatchers.IO) { store.save(fresh) }
            session = fresh
        }
    }

    // The AWS sign-in page.

    /** The Custom Tab with the sign-in page. Throws ActivityNotFoundException with no browser. */
    fun signInIntent(): Intent {
        val spec = AuthorizeRequest.create(config.loginDomain, config.mobileClientId, config.redirectUri)
        val request = AuthorizationRequest.Builder(serviceConfig, spec.clientId, ResponseTypeValues.CODE, spec.redirectUri.toUri())
            .setScope(spec.scope)
            .setState(spec.state)
            .setNonce(null)
            .setCodeVerifier(spec.pkce.verifier, spec.pkce.challenge, Pkce.METHOD)
            // A sign-out in the app ends the managed login's session too (AuthorizeRequest).
            .setPrompt(spec.prompt)
            .build()
        return service.getAuthorizationRequestIntent(request)
    }

    /** Finish a sign-in on the AWS page with what it returned: trade the code for tokens. */
    suspend fun completeSignIn(data: Intent?) {
        val response = data?.let { AuthorizationResponse.fromIntent(it) }
            ?: throw SignInException(describe(data?.let { AuthorizationException.fromIntent(it) }) ?: "Sign-in was cancelled.")
        val tokens = try {
            tokenRequest(response.createTokenExchangeRequest())
        } catch (e: AuthorizationException) {
            throw SignInException(describe(e) ?: "Sign-in failed.")
        }
        val access = tokens.accessToken ?: throw SignInException("The sign-in service sent no token.")
        val expiresIn = tokens.accessTokenExpirationTime?.let { (it - System.currentTimeMillis()) / 1000 } ?: 3600L
        keep(CognitoTokens(access, tokens.idToken, tokens.refreshToken, expiresIn.coerceAtLeast(60)), Session.HOSTED)
    }

    // Using the session.

    /**
     * A current access token. With [forceRefresh], as after a 401, the tokens are refreshed even if
     * they look current. A refresh token that Cognito no longer takes signs the person out.
     */
    suspend fun accessToken(forceRefresh: Boolean = false): String = mutex.withLock {
        val current = session ?: throw SignedOutException("Sign in to continue.")
        val now = System.currentTimeMillis() / 1000
        val due = forceRefresh || current.expiresAt - now <= RENEW_BEFORE_S
        if (!due) return@withLock current.accessToken
        val refreshToken = current.refreshToken
        if (refreshToken == null) {
            if (current.expiresAt > now && !forceRefresh) return@withLock current.accessToken
            forgetLocked()
            throw SignedOutException("Your session has ended. Sign in again.")
        }
        when (val refreshed = cognito.refresh(refreshToken)) {
            is Refreshed.Ok -> {
                val tokens = refreshed.tokens
                val renewed = Session(
                    tokens.accessToken, tokens.idToken ?: current.idToken, tokens.refreshToken ?: refreshToken,
                    System.currentTimeMillis() / 1000 + tokens.expiresIn, current.via,
                )
                withContext(Dispatchers.IO) { store.save(renewed) }
                session = renewed
                renewed.accessToken
            }
            Refreshed.Ended -> {
                forgetLocked()
                throw SignedOutException("Your session has ended. Sign in again.")
            }
            is Refreshed.Failed -> {
                // Still good for a moment: use it, and try again on the next call.
                if (!forceRefresh && current.expiresAt > now) return@withLock current.accessToken
                throw SignInException(
                    if (refreshed.problem == "network") "Could not reach the sign-in service. Check the phone's connection."
                    else "Could not refresh the sign-in.",
                )
            }
        }
    }

    /**
     * When the person last signed in with password and code, in epoch seconds: the `auth_time` of
     * the access token, which a refresh keeps. A change from the phone needs one in the last 15
     * minutes (FreshSignIn).
     */
    suspend fun authTime(): Long? = mutex.withLock { FreshSignIn.authTime(session?.accessToken) }

    /** Forget the tokens here, without telling Cognito: the console no longer takes them. */
    suspend fun forget() {
        mutex.withLock { forgetLocked() }
    }

    /** Forget the tokens and the last searches, then revoke the refresh token (docs/mobile-apps.md, "Sign out"). */
    suspend fun signOut() {
        cognito.cancel()
        val refreshToken = mutex.withLock {
            val token = session?.refreshToken
            forgetLocked()
            token
        }
        if (refreshToken != null) {
            val revoked = runCatching { cognito.revoke(refreshToken) }.getOrDefault(false)
            // The managed login's own endpoint, for a client or a pool that does not take RevokeToken.
            if (!revoked) withContext(Dispatchers.IO) { runCatching { revokeHosted(refreshToken) } }
        }
    }

    fun dispose() {
        service.dispose()
    }

    private suspend fun forgetLocked() {
        session = null
        withContext(Dispatchers.IO) { store.clear() }
    }

    private suspend fun tokenRequest(request: TokenRequest): TokenResponse =
        suspendCancellableCoroutine { continuation ->
            service.performTokenRequest(request) { response, exception ->
                if (!continuation.isActive) return@performTokenRequest
                if (response != null) {
                    continuation.resume(response)
                } else {
                    continuation.resumeWithException(exception ?: AuthorizationException.GeneralErrors.SERVER_ERROR)
                }
            }
        }

    private fun revokeHosted(refreshToken: String) {
        val connection = URL(endpoints.revoke).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "POST"
            connection.connectTimeout = 10_000
            connection.readTimeout = 10_000
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
            connection.outputStream.use { it.write(revokeForm(refreshToken, config.mobileClientId).toByteArray()) }
            connection.responseCode
        } finally {
            connection.disconnect()
        }
    }

    private fun describe(e: AuthorizationException?): String? = when {
        e == null -> null
        e == AuthorizationException.GeneralErrors.USER_CANCELED_AUTH_FLOW ||
            e == AuthorizationException.GeneralErrors.PROGRAM_CANCELED_AUTH_FLOW -> "Sign-in was cancelled."
        e == AuthorizationException.GeneralErrors.NETWORK_ERROR -> "Could not reach the sign-in service. Check the phone's connection."
        e == AuthorizationException.GeneralErrors.ID_TOKEN_VALIDATION_ERROR -> "The sign-in answer did not check out. Is the phone's clock right?"
        else -> e.errorDescription ?: e.error ?: e.message
    }

    private companion object {
        const val RENEW_BEFORE_S = 60L
    }
}
