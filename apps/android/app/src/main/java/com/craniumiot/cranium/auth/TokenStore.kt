package com.craniumiot.cranium.auth

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import net.openid.appauth.AuthState
import java.security.KeyStore

/**
 * A signed-in session: the tokens, and when the access token ends by this phone's clock. `via`
 * says how the person signed in: on the app's own screen (`srp`) or on the AWS sign-in page
 * (`hosted`). Both are refreshed the same way (AuthManager).
 */
data class Session(
    val accessToken: String,
    val idToken: String?,
    val refreshToken: String?,
    /** Epoch seconds, by this phone's clock: when the sign-in arrived plus its lifetime. */
    val expiresAt: Long,
    val via: String,
) {
    fun toJson(): String = buildJsonObject {
        put("accessToken", accessToken)
        if (idToken != null) put("idToken", idToken)
        if (refreshToken != null) put("refreshToken", refreshToken)
        put("expiresAt", expiresAt)
        put("via", via)
    }.toString()

    companion object {
        const val SRP = "srp"
        const val HOSTED = "hosted"

        fun fromJson(text: String): Session? {
            val root = runCatching { Json.parseToJsonElement(text) }.getOrNull() as? JsonObject ?: return null
            fun str(name: String) = (root[name] as? JsonPrimitive)?.takeIf { it.isString }?.content
            val access = str("accessToken")?.takeIf { it.isNotEmpty() } ?: return null
            val expires = (root["expiresAt"] as? JsonPrimitive)?.longOrNull ?: return null
            return Session(access, str("idToken"), str("refreshToken")?.takeIf { it.isNotEmpty() }, expires, str("via") ?: HOSTED)
        }

        /** A session kept by the app before 0.3.0, as AppAuth's state: the person stays signed in. */
        fun fromAuthState(state: AuthState): Session? {
            val access = state.accessToken ?: return null
            val expires = state.accessTokenExpirationTime?.let { it / 1000 } ?: 0L
            return Session(access, state.idToken, state.refreshToken, expires, HOSTED)
        }
    }
}

/**
 * Where the tokens live: in EncryptedSharedPreferences, as docs/mobile-apps.md asks. Never in
 * plain storage, never in a log. Construct it off the main thread: opening it touches the
 * keystore and the disk. The last searches are kept here too, and go with a sign-out.
 *
 * androidx.security marks EncryptedSharedPreferences deprecated since 1.1.0; it still works, and
 * it is what the contract names.
 */
@Suppress("DEPRECATION")
class TokenStore(context: Context) {
    private val prefs: SharedPreferences = openOrReset(context.applicationContext)

    fun load(): Session? {
        prefs.getString(KEY_SESSION, null)?.let { return Session.fromJson(it) }
        // The state AppAuth kept before the app had its own sign-in.
        return prefs.getString(KEY_LEGACY_STATE, null)
            ?.let { runCatching { AuthState.jsonDeserialize(it) }.getOrNull() }
            ?.takeIf { it.isAuthorized }
            ?.let(Session::fromAuthState)
    }

    fun save(session: Session) {
        prefs.edit(commit = true) {
            putString(KEY_SESSION, session.toJson())
            remove(KEY_LEGACY_STATE)
        }
    }

    /** The last searches, newest first (core RecentSearches). */
    fun recentSearches(): List<String> =
        prefs.getString(KEY_RECENT, null)?.split('\n')?.filter { it.isNotBlank() }.orEmpty()

    fun saveRecentSearches(list: List<String>) {
        prefs.edit(commit = true) { putString(KEY_RECENT, list.joinToString("\n") { it.replace('\n', ' ') }) }
    }

    /** Everything: the session and the last searches. */
    fun clear() {
        prefs.edit(commit = true) { clear() }
    }

    private companion object {
        const val FILE = "cranium_tokens"
        const val KEY_SESSION = "session"
        const val KEY_LEGACY_STATE = "auth_state"
        const val KEY_RECENT = "recent_searches"

        fun open(context: Context): SharedPreferences {
            val key = MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            return EncryptedSharedPreferences.create(
                context,
                FILE,
                key,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
        }

        /**
         * If the file and the keystore key no longer go together (a restored phone, a keystore
         * that lost its key), forget both: the person signs in again.
         */
        fun openOrReset(context: Context): SharedPreferences = try {
            open(context)
        } catch (e: Exception) {
            context.deleteSharedPreferences(FILE)
            runCatching {
                KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
                    .deleteEntry(MasterKey.DEFAULT_MASTER_KEY_ALIAS)
            }
            open(context)
        }
    }
}
