package com.craniumiot.cranium.auth

import android.content.Context
import android.content.Intent
import androidx.core.net.toUri
import com.craniumiot.cranium.CraniumConfig
import com.craniumiot.cranium.api.AccessTokens
import com.craniumiot.cranium.core.AuthorizeRequest
import com.craniumiot.cranium.core.BiometricPolicy
import com.craniumiot.cranium.core.BiometricVault
import com.craniumiot.cranium.core.CognitoEndpoints
import com.craniumiot.cranium.core.CognitoSignIn
import com.craniumiot.cranium.core.CognitoTokens
import com.craniumiot.cranium.core.EnrolNext
import com.craniumiot.cranium.core.FingerprintLock
import com.craniumiot.cranium.core.FingerprintWords
import com.craniumiot.cranium.core.FreshSignIn
import com.craniumiot.cranium.core.IdpTransport
import com.craniumiot.cranium.core.Pkce
import com.craniumiot.cranium.core.PromptResult
import com.craniumiot.cranium.core.Refreshed
import com.craniumiot.cranium.core.Sealed
import com.craniumiot.cranium.core.SignInStep
import com.craniumiot.cranium.core.UnlockNext
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
 * Which user pool and app client a sign-in is with. The staff session of admin mode has the AWS
 * sign-in page as well ([loginDomain], [redirectUri]); a customer's has neither, and answers a first
 * sign-in's new password on the screen ([newPasswordHere]), as the customer site does.
 */
data class AuthSettings(
    val clientId: String,
    val region: String,
    val userPoolId: String,
    val loginDomain: String?,
    val redirectUri: String?,
    val newPasswordHere: Boolean,
) {
    /** Never the values. */
    override fun toString(): String = "AuthSettings(awsPage=${loginDomain != null}, newPasswordHere=$newPasswordHere)"

    companion object {
        /** The staff pool and the phone apps' client: admin mode, as the app has always signed in. */
        fun staff(config: CraniumConfig) = AuthSettings(
            config.mobileClientId, config.region, config.userPoolId, config.loginDomain, config.redirectUri, newPasswordHere = false,
        )

        /** The customer pool and its phone client; null when the build has no customer pool. */
        fun customer(config: CraniumConfig): AuthSettings? = if (!config.hasCustomer) {
            null
        } else {
            AuthSettings(config.customerClientId, config.customerRegion, config.customerUserPoolId, null, null, newPasswordHere = true)
        }
    }
}

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
 * Fingerprint unlock (docs/mobile-apps.md): with it on, the refresh token is kept only sealed with
 * the [vault]'s key, and no session is stored in the clear; the app holds the tokens in memory
 * once the fingerprint has opened them. With it off, the refresh token is forgotten an hour after
 * the sign-in (BiometricPolicy), however long Cognito would take it.
 *
 * Two of these run side by side (docs/mobile-apps.md, "Customers"): the staff session of admin mode,
 * with the staff pool, the phone apps' client and the AWS sign-in page; and a customer's, with the
 * customer pool and its phone client, which has no managed login pages ([AuthSettings.loginDomain]
 * null), takes a first sign-in's new password on the screen, and is revoked with RevokeToken only.
 * Each has its own [store] and [vault], so that neither session can read or end the other.
 *
 * Construct it off the main thread; call the rest from the main thread.
 */
class AuthManager(
    private val context: Context?,
    private val settings: AuthSettings,
    private val store: SessionStore,
    private val vault: BiometricVault,
    transport: IdpTransport = CognitoHttp(settings.region),
) : AccessTokens {
    /** AppAuth, for the AWS sign-in page: made when that page is first wanted, and never for a customer. */
    private var authService: AuthorizationService? = null
    private val endpoints = settings.loginDomain?.let { CognitoEndpoints(it) }
    private val serviceConfig by lazy {
        val pages = endpoints ?: error("This sign-in has no AWS sign-in page")
        AuthorizationServiceConfiguration(pages.authorize.toUri(), pages.token.toUri())
    }
    private val cognito = CognitoSignIn(transport, settings.clientId, settings.userPoolId, newPasswordHere = settings.newPasswordHere)
    private val mutex = Mutex()

    private val service: AuthorizationService
        get() = authService ?: AuthorizationService(requireNotNull(context) { "AppAuth needs a context" }.applicationContext)
            .also { authService = it }
    private val lock = FingerprintLock(vault)

    /** Fingerprint unlock is on: the refresh token is kept only behind it. */
    @Volatile
    var fingerprintOn: Boolean = store.fingerprintOn()
        private set

    @Volatile
    private var sealed: Sealed? = if (fingerprintOn) store.vault() else null

    @Volatile
    private var session: Session? = if (fingerprintOn) {
        // Nothing in the clear with it on, even if an older version left something.
        store.clearSession()
        null
    } else {
        store.load()?.let { kept -> withoutStaleRefresh(kept, nowS()).also { if (it != kept) store.save(it) } }
    }

    val isSignedIn: Boolean get() = session != null

    /** The session can still be refreshed: false once the hour without fingerprint unlock is over. */
    val keepsRefreshToken: Boolean get() = session?.refreshToken != null

    /** A sign-in is kept behind the fingerprint, and none is open: the lock screen. */
    val needsUnlock: Boolean get() = fingerprintOn && sealed != null && session == null

    /** The last searches, which go with a sign-out (TokenStore). */
    fun recentSearches(): List<String> = store.recentSearches()

    fun saveRecentSearches(list: List<String>) = store.saveRecentSearches(list)

    // The app's own sign-in screen.

    /** The e-mail address and the password: the proof of the password, then the code, a token, or the AWS page. */
    suspend fun passwordSignIn(email: String, password: String): SignInStep = keepIfDone(cognito.passwordSignIn(email, password))

    /** The six digits from the authenticator app. */
    suspend fun sendCode(code: String): SignInStep = keepIfDone(cognito.sendCode(code))

    /** A first sign-in's new password, chosen on the screen (the customer side). */
    suspend fun sendNewPassword(password: String): SignInStep = keepIfDone(cognito.sendNewPassword(password))

    /** Drop a sign-in that waits for its code. */
    fun cancelPasswordSignIn() = cognito.cancel()

    private suspend fun keepIfDone(step: SignInStep): SignInStep {
        if (step is SignInStep.Done) keep(step.tokens, Session.SRP)
        return step
    }

    /**
     * A full sign-in, with password and code. With fingerprint unlock on, it stays in memory: the
     * sign-in screen then asks to keep it behind the fingerprint ([beginEnrol]), and a fresh
     * sign-in for a change leaves the one kept as it is.
     */
    private suspend fun keep(tokens: CognitoTokens, via: String) {
        val now = nowS()
        val fresh = Session(tokens.accessToken, tokens.idToken, tokens.refreshToken, now + tokens.expiresIn, via, signedInAt = now)
        mutex.withLock {
            if (!fingerprintOn) withContext(Dispatchers.IO) { store.save(fresh) }
            session = fresh
        }
    }

    // The AWS sign-in page.

    /** Whether this sign-in has the AWS sign-in page: the staff session's has, a customer's has not. */
    val hasAwsPage: Boolean get() = settings.loginDomain != null && settings.redirectUri != null

    /** The Custom Tab with the sign-in page. Throws ActivityNotFoundException with no browser. */
    fun signInIntent(): Intent {
        val loginDomain = settings.loginDomain ?: throw IllegalStateException("This sign-in has no AWS sign-in page")
        val spec = AuthorizeRequest.create(loginDomain, settings.clientId, settings.redirectUri ?: throw IllegalStateException("No redirect"))
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
    override suspend fun accessToken(forceRefresh: Boolean): String = mutex.withLock {
        enforceKeepRuleLocked()
        val current = session ?: throw SignedOutException("Sign in to continue.")
        val now = nowS()
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
                    nowS() + tokens.expiresIn, current.via,
                    // An opened sign-in learns its time from the token: a refresh keeps auth_time.
                    signedInAt = current.signedInAt.takeIf { it > 0 } ?: FreshSignIn.authTime(tokens.accessToken) ?: 0,
                )
                if (!fingerprintOn) withContext(Dispatchers.IO) { store.save(renewed) }
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
    override suspend fun forget() {
        mutex.withLock { forgetLocked() }
    }

    /**
     * With fingerprint unlock off, an hour after the sign-in the refresh token goes: the session
     * then lasts as long as its access token. Called on every use and every minute while the app
     * runs, and when it starts.
     */
    suspend fun enforceKeepRule() {
        mutex.withLock { enforceKeepRuleLocked() }
    }

    private suspend fun enforceKeepRuleLocked() {
        val current = session ?: return
        if (fingerprintOn) return
        val kept = withoutStaleRefresh(current, nowS())
        if (kept != current) {
            session = kept
            withContext(Dispatchers.IO) { store.save(kept) }
        }
    }

    // Fingerprint unlock.

    /** Whether this person said "Not now" to the offer on this phone. */
    suspend fun declinedOffer(sub: String): Boolean = withContext(Dispatchers.IO) { store.declined(BiometricPolicy.personKey(sub)) }

    suspend fun declineOffer(sub: String) = withContext(Dispatchers.IO) { store.decline(BiometricPolicy.personKey(sub)) }

    /**
     * Turning it on, or keeping a new sign-in behind it: the cipher for the prompt. A new key is
     * made for it, so what was sealed before no longer opens; if no key can be made, it is off.
     */
    suspend fun beginEnrol(): FingerprintLock.Begin<EnrolNext> {
        val begin = withContext(Dispatchers.IO) { lock.beginEnrol() }
        mutex.withLock {
            when {
                begin is FingerprintLock.Begin.Done && fingerprintOn -> turnOffLocked()
                // The old key is gone, so what it sealed is of no use, even if this prompt never answers.
                fingerprintOn -> {
                    sealed = null
                    withContext(Dispatchers.IO) { store.clearVault() }
                }
            }
        }
        return begin
    }

    /**
     * The prompt answered. On: the refresh token is sealed and no session is kept in the clear. Not:
     * with it on before (a new sign-in that was to be kept), it is turned off, and the session is
     * kept as without it.
     */
    suspend fun finishEnrol(result: PromptResult): EnrolNext = mutex.withLock {
        val next = lock.finishEnrol(result, session?.refreshToken)
        when (next) {
            is EnrolNext.On -> {
                withContext(Dispatchers.IO) { store.saveVault(next.sealed) }
                sealed = next.sealed
                fingerprintOn = true
            }
            is EnrolNext.Off -> if (fingerprintOn) turnOffLocked()
        }
        next
    }

    /** Unlocking: the cipher for the prompt, or what to do without one. */
    suspend fun beginUnlock(): FingerprintLock.Begin<UnlockNext> {
        val kept = sealed
        val begin = withContext(Dispatchers.IO) { lock.beginUnlock(kept) }
        if (begin is FingerprintLock.Begin.Done && begin.next is UnlockNext.Forget) mutex.withLock { turnOffLocked() }
        return begin
    }

    /**
     * The prompt answered. Opened: the refresh token goes into the session in memory, to be
     * refreshed as usual. Forget: the key, the ciphertext and the setting go.
     */
    suspend fun finishUnlock(result: PromptResult): UnlockNext = mutex.withLock {
        val kept = sealed
        if (kept == null) {
            turnOffLocked()
            return@withLock UnlockNext.Forget(FingerprintWords.MISSING)
        }
        val next = withContext(Dispatchers.IO) { lock.finishUnlock(result, kept) }
        when (next) {
            is UnlockNext.Open -> {
                val current = session
                session = current?.copy(refreshToken = next.refreshToken)
                    ?: Session("", null, next.refreshToken, 0, Session.FINGERPRINT)
            }
            is UnlockNext.Forget -> turnOffLocked()
            else -> Unit
        }
        next
    }

    /** Turn it off: the key and the ciphertext go; the session is kept as without it, for the hour after the sign-in. */
    suspend fun turnOffFingerprint() {
        mutex.withLock { turnOffLocked() }
    }

    /** Leave the lock screen for the password: drop the open session, keep what is sealed for next time. */
    suspend fun closeSession() {
        mutex.withLock { session = null }
    }

    private suspend fun turnOffLocked() {
        vault.delete()
        sealed = null
        fingerprintOn = false
        val current = session
        withContext(Dispatchers.IO) {
            store.fingerprintOff()
            if (current != null) {
                val kept = withoutStaleRefresh(current, nowS())
                session = kept
                if (kept.accessToken.isNotEmpty()) store.save(kept)
            }
        }
    }

    /** Forget the tokens and the last searches, then revoke the refresh token (docs/mobile-apps.md, "Sign out"). */
    suspend fun signOut() {
        cognito.cancel()
        val refreshToken = mutex.withLock {
            val token = session?.refreshToken
            forgetLocked()
            // Sign-out ends fingerprint unlock too: the key and the ciphertext go with the rest.
            vault.delete()
            sealed = null
            fingerprintOn = false
            withContext(Dispatchers.IO) { store.clear() }
            token
        }
        if (refreshToken != null) {
            val revoked = runCatching { cognito.revoke(refreshToken) }.getOrDefault(false)
            // The managed login's own endpoint, for a client or a pool that does not take RevokeToken.
            // A customer's sign-in has none: RevokeToken is the only way, as on the customer site.
            if (!revoked && endpoints != null) withContext(Dispatchers.IO) { runCatching { revokeHosted(refreshToken) } }
        }
    }

    fun dispose() {
        authService?.dispose()
        authService = null
    }

    /**
     * The tokens no longer work. Without fingerprint unlock, everything goes, as before. With it,
     * the ciphertext goes (it held the same refresh token) and the setting stays, so that the next
     * full sign-in is kept behind the fingerprint again.
     */
    private suspend fun forgetLocked() {
        session = null
        if (fingerprintOn) {
            vault.delete()
            sealed = null
            withContext(Dispatchers.IO) {
                store.clearVault()
                store.clearSession()
            }
        } else {
            withContext(Dispatchers.IO) { store.clear() }
        }
    }

    private fun nowS() = System.currentTimeMillis() / 1000

    /** The session without its refresh token once the hour after the sign-in is over, without fingerprint unlock. */
    private fun withoutStaleRefresh(current: Session, now: Long): Session =
        if (current.refreshToken != null && !BiometricPolicy.keepsRefreshToken(false, current.signedIn, now)) {
            current.copy(refreshToken = null)
        } else {
            current
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
        val pages = endpoints ?: return
        val connection = URL(pages.revoke).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "POST"
            connection.connectTimeout = 10_000
            connection.readTimeout = 10_000
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
            connection.outputStream.use { it.write(revokeForm(refreshToken, settings.clientId).toByteArray()) }
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
