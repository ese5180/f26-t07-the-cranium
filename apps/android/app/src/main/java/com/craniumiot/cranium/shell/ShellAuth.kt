package com.craniumiot.cranium.shell

import android.content.Context
import com.craniumiot.cranium.CraniumConfig
import com.craniumiot.cranium.api.AccessTokens
import com.craniumiot.cranium.auth.AuthManager
import com.craniumiot.cranium.auth.AuthSettings
import com.craniumiot.cranium.auth.KeystoreVault
import com.craniumiot.cranium.auth.SignInException
import com.craniumiot.cranium.auth.SignedOutException
import com.craniumiot.cranium.auth.TokenStore
import com.craniumiot.cranium.core.BiometricPolicy
import com.craniumiot.cranium.core.BiometricState
import com.craniumiot.cranium.core.CognitoTokens
import com.craniumiot.cranium.core.EnrolNext
import com.craniumiot.cranium.core.FingerprintLock
import com.craniumiot.cranium.core.FingerprintWords
import com.craniumiot.cranium.core.PromptResult
import com.craniumiot.cranium.core.UnlockNext
import com.craniumiot.cranium.ui.PromptPurpose
import com.craniumiot.cranium.ui.PromptRequest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** A question the shell has for the person (a fingerprint prompt, the offer of fingerprint unlock), one at a time. */
class Asker<Q, A> {
    class Pending<Q, A>(val id: Long, val question: Q) {
        internal val answer = CompletableDeferred<A>()
    }

    private val mutex = Mutex()
    private var next = 0L
    private val _pending = MutableStateFlow<Pending<Q, A>?>(null)
    val pending: StateFlow<Pending<Q, A>?> = _pending.asStateFlow()

    suspend fun ask(question: Q): A = mutex.withLock {
        val asked = Pending<Q, A>(++next, question)
        _pending.value = asked
        try {
            asked.answer.await()
        } finally {
            _pending.value = null
        }
    }

    fun answer(id: Long, answer: A) {
        _pending.value?.takeIf { it.id == id }?.answer?.complete(answer)
    }
}

/**
 * The sign-ins behind the bridge's auth.* and biometric.* (apps/shared/bridge.json): the staff pool's
 * ("admin") and the customer pool's ("customer"), each an [AuthManager] over the very store, key and
 * rules of the classic app (TokenStore, KeystoreVault, BiometricPolicy), so the shell and the classic app
 * share one sign-in per pool. The page signs in itself and hands the tokens over (auth.store); from then
 * on it gets only access tokens (auth.session), refreshed here with the pool's phone client
 * (InitiateAuth REFRESH_TOKEN_AUTH, AuthManager), behind the fingerprint when that is on. Without the
 * fingerprint the refresh token goes an hour after the sign-in, as in the classic app; with it, the
 * sign-in locks again after 5 minutes in the background (auth.locked).
 */
class ShellAuth(
    private val app: Context,
    private val config: CraniumConfig,
    private val prompts: Asker<PromptRequest, PromptResult>,
    private val offers: Asker<Boolean, Boolean>,
    private val onLocked: (String) -> Unit,
    private val onAdminSession: () -> Unit,
) {
    private val managers = HashMap<String, AuthManager>()
    private val making = Mutex()
    private val locks = mapOf(ADMIN to Mutex(), CUSTOMER to Mutex())
    private var promptId = 0L
    private var awaySince: Long? = null

    /** Fingerprint unlock is on for a pool: the window keeps out of the recents screen. */
    val anyFingerprintOn: Boolean get() = synchronized(managers) { managers.values.any { it.fingerprintOn } }

    /** The admin's session for the app's own update check (update/), when there is one. */
    fun adminTokens(): AccessTokens? = synchronized(managers) { managers[ADMIN] }?.takeIf { it.isSignedIn }

    private fun settings(pool: String): AuthSettings? = if (pool == ADMIN) AuthSettings.staff(config) else AuthSettings.customer(config)

    private suspend fun manager(pool: String): AuthManager {
        val settings = settings(pool) ?: throw BridgeError("unavailable", "This build of the app has no customer sign-in.")
        return making.withLock {
            synchronized(managers) { managers[pool] } ?: try {
                withContext(Dispatchers.IO) {
                    if (pool == ADMIN) {
                        AuthManager(app, settings, TokenStore(app), KeystoreVault(app))
                    } else {
                        AuthManager(app, settings, TokenStore.customer(app), KeystoreVault(app, KeystoreVault.CUSTOMER_ALIAS))
                    }
                }
            } catch (e: Exception) {
                throw BridgeError("failed", "The app could not open its secure storage.")
            }.also { made -> synchronized(managers) { managers[pool] = made } }
        }
    }

    private fun lockOf(pool: String): Mutex = locks.getValue(pool)

    private fun biometric(manager: AuthManager): JsonObject {
        val state = KeystoreVault.state(app)
        return buildJsonObject {
            put("available", state == BiometricState.READY)
            put("kind", if (state == BiometricState.NO_HARDWARE || state == BiometricState.UNSUPPORTED) JsonNull else JsonPrimitive("fingerprint"))
            put("enabled", manager.fingerprintOn)
        }
    }

    // auth.store

    suspend fun store(params: JsonObject): JsonObject {
        val pool = params.text("pool")
        val manager = manager(pool)
        val settings = settings(pool)!!
        val access = params.text("accessToken")
        if (!ShellChecks.tokenFits(access, settings.clientId, settings.userPoolId)) {
            throw BridgeError("bad_request", "That sign-in is not one of this app's: it is of another client or pool.")
        }
        val tokens = CognitoTokens(
            accessToken = access,
            idToken = params.textOrNull("idToken"),
            refreshToken = params.text("refreshToken"),
            expiresIn = params.whole("expiresIn"),
        )
        lockOf(pool).withLock {
            manager.adopt(tokens)
            afterFullSignIn(pool, manager, ShellChecks.claim(access, "sub").orEmpty())
        }
        if (pool == ADMIN) onAdminSession()
        return buildJsonObject { put("biometric", biometric(manager)) }
    }

    /** As the classic app after a full sign-in: keep it behind the fingerprint if that is on, or offer it once. */
    private suspend fun afterFullSignIn(pool: String, manager: AuthManager, sub: String) {
        if (manager.fingerprintOn) {
            enrol(pool, manager, PromptPurpose.REKEY)
            return
        }
        val declined = sub.isNotEmpty() && manager.declinedOffer(sub)
        if (!BiometricPolicy.offer(fullSignIn = true, KeystoreVault.state(app), on = false, declined = declined)) return
        if (offers.ask(pool == CUSTOMER)) {
            enrol(pool, manager, PromptPurpose.ENROL)
        } else if (sub.isNotEmpty()) {
            manager.declineOffer(sub)
        }
    }

    private suspend fun enrol(pool: String, manager: AuthManager, purpose: PromptPurpose): EnrolNext =
        when (val begin = manager.beginEnrol()) {
            is FingerprintLock.Begin.Prompt -> manager.finishEnrol(ask(pool, purpose, begin.cipher))
            is FingerprintLock.Begin.Done -> begin.next
        }

    private suspend fun ask(pool: String, purpose: PromptPurpose, cipher: javax.crypto.Cipher): PromptResult =
        prompts.ask(PromptRequest(++promptId, purpose, cipher, customer = pool == CUSTOMER))

    // auth.session

    suspend fun session(params: JsonObject): JsonObject {
        val pool = params.text("pool")
        val manager = manager(pool)
        lockOf(pool).withLock {
            manager.enforceKeepRule()
            if (manager.needsUnlock) unlock(pool, manager)?.let { return it }
        }
        if (!manager.isSignedIn) return SIGNED_OUT
        var token = try {
            manager.accessToken(forceRefresh = false)
        } catch (e: CancellationException) {
            throw e
        } catch (e: SignedOutException) {
            return SIGNED_OUT
        } catch (e: SignInException) {
            throw BridgeError("network", e.message ?: "Could not reach the sign-in service.")
        }
        val now = System.currentTimeMillis() / 1000
        var expiresAt = manager.accessTokenExpiresAt ?: now
        if (expiresAt - now <= RENEW_BEFORE_S) {
            try {
                token = manager.accessToken(forceRefresh = true)
                expiresAt = manager.accessTokenExpiresAt ?: now
            } catch (e: CancellationException) {
                throw e
            } catch (e: SignedOutException) {
                return SIGNED_OUT
            } catch (e: Exception) {
                if (expiresAt <= now) throw BridgeError("network", e.message ?: "Could not reach the sign-in service.")
            }
        }
        if (pool == ADMIN) onAdminSession()
        return buildJsonObject {
            put("signedIn", true)
            put("accessToken", token)
            put("expiresIn", (expiresAt - System.currentTimeMillis() / 1000).coerceAtLeast(0))
        }
    }

    /** The fingerprint opens the refresh token; null when it did, else the answer to give. */
    private suspend fun unlock(pool: String, manager: AuthManager): JsonObject? {
        val next = when (val begin = manager.beginUnlock()) {
            is FingerprintLock.Begin.Prompt -> manager.finishUnlock(ask(pool, PromptPurpose.UNLOCK, begin.cipher))
            is FingerprintLock.Begin.Done -> begin.next
        }
        return when (next) {
            is UnlockNext.Open -> null
            is UnlockNext.Locked -> throw if (next.line == null) {
                BridgeError("cancelled", "Unlocking was cancelled.")
            } else {
                BridgeError("locked", next.line)
            }
            // "Sign in with password": what is kept stays for the next time.
            UnlockNext.Password -> {
                manager.closeSession()
                SIGNED_OUT
            }
            is UnlockNext.Forget -> {
                manager.forget()
                throw BridgeError("locked", next.line)
            }
        }
    }

    // auth.signOut

    suspend fun signOut(params: JsonObject): JsonObject {
        val manager = manager(params.text("pool"))
        manager.signOut()
        return JsonObject(emptyMap())
    }

    // biometric.*

    suspend fun biometricStatus(params: JsonObject): JsonObject = biometric(manager(params.text("pool")))

    suspend fun biometricSet(params: JsonObject): JsonObject {
        val pool = params.text("pool")
        val manager = manager(pool)
        val on = params.flag("enabled")
        lockOf(pool).withLock {
            if (!on) {
                manager.turnOffFingerprint()
                return buildJsonObject { put("enabled", false) }
            }
            val state = KeystoreVault.state(app)
            if (state != BiometricState.READY) throw BridgeError("unavailable", FingerprintWords.state(state) ?: FingerprintWords.NO_SENSOR)
            if (manager.fingerprintOn) return buildJsonObject { put("enabled", true) }
            if (!manager.keepsRefreshToken) throw BridgeError("signed_out", FingerprintWords.NO_SESSION)
            when (val next = enrol(pool, manager, PromptPurpose.ENROL)) {
                is EnrolNext.On -> return buildJsonObject { put("enabled", true) }
                is EnrolNext.Off -> throw if (next.line == null) BridgeError("cancelled", "Cancelled.") else BridgeError("failed", next.line)
            }
        }
    }

    // The app in the background.

    fun wentToBackground(nowMs: Long) {
        awaySince = nowMs
    }

    /** Back after 5 minutes or more with the fingerprint on: the sign-in is locked again, and the page told. */
    suspend fun cameToForeground(nowMs: Long) {
        val away = awaySince
        awaySince = null
        val all = synchronized(managers) { managers.toMap() }
        for ((pool, manager) in all) {
            if (BiometricPolicy.relock(manager.fingerprintOn, away, nowMs) && manager.isSignedIn) {
                lockOf(pool).withLock { manager.closeSession() }
                onLocked(pool)
            }
        }
    }

    fun dispose() {
        synchronized(managers) { managers.values.forEach { it.dispose() } }
    }

    companion object {
        const val ADMIN = "admin"
        const val CUSTOMER = "customer"

        /** auth.session refreshes when less than this is left (bridge.json). */
        const val RENEW_BEFORE_S = 120L

        private val SIGNED_OUT = buildJsonObject { put("signedIn", false) }
    }
}

// Reading parameters that the bridge has checked already (BridgeProtocol.validate).

internal fun JsonObject.text(name: String): String = (getValue(name) as JsonPrimitive).content

internal fun JsonObject.textOrNull(name: String): String? = (this[name] as? JsonPrimitive)?.takeIf { it.isString }?.content

internal fun JsonObject.whole(name: String): Long = (getValue(name) as JsonPrimitive).content.toLong()

internal fun JsonObject.wholeOrNull(name: String): Long? = (this[name] as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toLongOrNull()

internal fun JsonObject.flag(name: String): Boolean = (getValue(name) as JsonPrimitive).content.toBoolean()
