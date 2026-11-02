package com.craniumiot.cranium.auth

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import net.openid.appauth.AuthState
import java.security.KeyStore

/**
 * Where the tokens live: AppAuth's state, in EncryptedSharedPreferences, as docs/mobile-apps.md
 * asks. Never in plain storage, never in a log. Construct it off the main thread: opening it
 * touches the keystore and the disk.
 *
 * androidx.security marks EncryptedSharedPreferences deprecated since 1.1.0; it still works, and
 * it is what the contract names.
 */
@Suppress("DEPRECATION")
class TokenStore(context: Context) {
    private val prefs: SharedPreferences = openOrReset(context.applicationContext)

    fun load(): AuthState? =
        prefs.getString(KEY_STATE, null)?.let { runCatching { AuthState.jsonDeserialize(it) }.getOrNull() }

    fun save(state: AuthState) {
        prefs.edit(commit = true) { putString(KEY_STATE, state.jsonSerializeString()) }
    }

    fun clear() {
        prefs.edit(commit = true) { clear() }
    }

    private companion object {
        const val FILE = "cranium_tokens"
        const val KEY_STATE = "auth_state"

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
