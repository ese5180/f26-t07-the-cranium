package com.craniumiot.cranium.auth

import android.content.Context
import android.content.Intent
import androidx.core.net.toUri
import com.craniumiot.cranium.CraniumConfig
import com.craniumiot.cranium.core.AuthorizeRequest
import com.craniumiot.cranium.core.CognitoEndpoints
import com.craniumiot.cranium.core.Pkce
import com.craniumiot.cranium.core.revokeForm
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import net.openid.appauth.AuthState
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
 * Sign-in with Cognito's managed login through AppAuth: authorization code with PKCE, in a Custom
 * Tab, redirect `cranium://signin` (docs/mobile-apps.md, "Signing in"). Tokens are kept in
 * [TokenStore]. Construct it off the main thread; call the rest from the main thread.
 */
class AuthManager(context: Context, private val config: CraniumConfig, private val store: TokenStore) {
    private val service = AuthorizationService(context.applicationContext)
    private val endpoints = CognitoEndpoints(config.loginDomain)
    private val serviceConfig = AuthorizationServiceConfiguration(
        endpoints.authorize.toUri(),
        endpoints.token.toUri(),
    )
    private val mutex = Mutex()

    @Volatile
    private var state: AuthState? = store.load()?.takeIf { it.isAuthorized }

    val isSignedIn: Boolean get() = state != null

    /** The Custom Tab with the sign-in page. Throws ActivityNotFoundException with no browser. */
    fun signInIntent(): Intent {
        val spec = AuthorizeRequest.create(config.loginDomain, config.mobileClientId, config.redirectUri)
        val request = AuthorizationRequest.Builder(
            serviceConfig,
            spec.clientId,
            ResponseTypeValues.CODE,
            spec.redirectUri.toUri(),
        )
            .setScope(spec.scope)
            .setState(spec.state)
            .setNonce(null)
            .setCodeVerifier(spec.pkce.verifier, spec.pkce.challenge, Pkce.METHOD)
            // A sign-out in the app ends the managed login's session too (AuthorizeRequest).
            .setPrompt(spec.prompt)
            .build()
        return service.getAuthorizationRequestIntent(request)
    }

    /** Finish a sign-in with what the sign-in activity returned: trade the code for tokens. */
    suspend fun completeSignIn(data: Intent?) {
        val response = data?.let { AuthorizationResponse.fromIntent(it) }
        if (response == null) {
            throw SignInException(describe(data?.let { AuthorizationException.fromIntent(it) }) ?: "Sign-in was cancelled.")
        }
        val newState = AuthState(response, null)
        val tokens = try {
            tokenRequest(response.createTokenExchangeRequest())
        } catch (e: AuthorizationException) {
            throw SignInException(describe(e) ?: "Sign-in failed.")
        }
        newState.update(tokens, null)
        mutex.withLock {
            withContext(Dispatchers.IO) { store.save(newState) }
            state = newState
        }
    }

    /**
     * A current access token. With [forceRefresh], as after a 401, the tokens are refreshed even if
     * they look current. A refresh token that no longer works signs the person out.
     */
    suspend fun accessToken(forceRefresh: Boolean = false): String = mutex.withLock {
        val current = state ?: throw SignedOutException("Sign in to continue.")
        if (forceRefresh) current.needsTokenRefresh = true
        val before = current.accessToken
        val token = try {
            freshAccessToken(current)
        } catch (e: AuthorizationException) {
            if (e.type == AuthorizationException.TYPE_OAUTH_TOKEN_ERROR) {
                forgetLocked()
                throw SignedOutException("Your session has ended. Sign in again.")
            }
            throw SignInException(describe(e) ?: "Could not refresh the sign-in.")
        }
        if (token != before) withContext(Dispatchers.IO) { store.save(current) }
        token
    }

    /** Forget the tokens here, without telling Cognito: the console no longer takes them. */
    suspend fun forget() {
        mutex.withLock { forgetLocked() }
    }

    /** Forget the tokens, then revoke the refresh token (docs/mobile-apps.md, "Sign out"). */
    suspend fun signOut() {
        val refreshToken = mutex.withLock {
            val token = state?.refreshToken
            forgetLocked()
            token
        }
        if (refreshToken != null) {
            withContext(Dispatchers.IO) { runCatching { revoke(refreshToken) } }
        }
    }

    fun dispose() {
        service.dispose()
    }

    private suspend fun forgetLocked() {
        state = null
        withContext(Dispatchers.IO) { store.clear() }
    }

    private suspend fun tokenRequest(request: TokenRequest): TokenResponse =
        suspendCancellableCoroutine { continuation ->
            service.performTokenRequest(request) { response, exception ->
                if (!continuation.isActive) return@performTokenRequest
                if (response != null) {
                    continuation.resume(response)
                } else {
                    continuation.resumeWithException(
                        exception ?: AuthorizationException.GeneralErrors.SERVER_ERROR,
                    )
                }
            }
        }

    private suspend fun freshAccessToken(current: AuthState): String =
        suspendCancellableCoroutine { continuation ->
            current.performActionWithFreshTokens(service) { accessToken, _, exception ->
                if (!continuation.isActive) return@performActionWithFreshTokens
                if (accessToken != null && exception == null) {
                    continuation.resume(accessToken)
                } else {
                    continuation.resumeWithException(
                        exception ?: AuthorizationException.GeneralErrors.SERVER_ERROR,
                    )
                }
            }
        }

    private fun revoke(refreshToken: String) {
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
        e == AuthorizationException.GeneralErrors.NETWORK_ERROR ->
            "Could not reach the sign-in service. Check the phone's connection."
        e == AuthorizationException.GeneralErrors.ID_TOKEN_VALIDATION_ERROR ->
            "The sign-in answer did not check out. Is the phone's clock right?"
        else -> e.errorDescription ?: e.error ?: e.message
    }
}
