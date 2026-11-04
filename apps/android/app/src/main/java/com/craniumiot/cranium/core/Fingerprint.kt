package com.craniumiot.cranium.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put
import java.security.GeneralSecurityException
import java.security.MessageDigest
import java.util.Base64
import javax.crypto.Cipher

/*
 * Unlocking with a fingerprint (docs/mobile-apps.md, "Unlocking with Face ID (iPhone) or a
 * fingerprint (Android)"). With it on, the refresh token is kept only encrypted, with a Keystore
 * key that the fingerprint has to release for every use; with it off, the app forgets the refresh
 * token an hour after the sign-in. Everything here runs on the JVM: the phone's side is
 * auth/KeystoreVault.kt and the prompt in MainActivity.
 */

/** What BiometricManager.canAuthenticate(BIOMETRIC_STRONG) answered. Only READY may turn it on. */
enum class BiometricState { READY, NOT_ENROLLED, NO_HARDWARE, UNAVAILABLE, UPDATE_NEEDED, UNSUPPORTED }

/** The refresh token, encrypted, and its IV: what is stored, never the token. */
class Sealed(val ciphertext: ByteArray, val iv: ByteArray) {
    fun toJson(): String = buildJsonObject {
        put("v", 1)
        put("ct", Base64.getEncoder().encodeToString(ciphertext))
        put("iv", Base64.getEncoder().encodeToString(iv))
    }.toString()

    companion object {
        fun fromJson(text: String?): Sealed? {
            if (text == null) return null
            val root = runCatching { Json.parseToJsonElement(text) }.getOrNull() as? JsonObject ?: return null
            if ((root["v"] as? JsonPrimitive)?.intOrNull != 1) return null
            fun bytes(name: String) = (root[name] as? JsonPrimitive)?.takeIf { it.isString }
                ?.let { runCatching { Base64.getDecoder().decode(it.content) }.getOrNull() }
            val ct = bytes("ct")?.takeIf { it.isNotEmpty() } ?: return null
            val iv = bytes("iv")?.takeIf { it.isNotEmpty() } ?: return null
            return Sealed(ct, iv)
        }
    }
}

/** Why the vault could not give a cipher, or the cipher could not open what was kept. */
enum class VaultProblem {
    /** KeyPermanentlyInvalidatedException: a fingerprint was added or removed, or the screen lock was turned off. */
    INVALIDATED,

    /** No key under the alias, or nothing kept to open. */
    MISSING,

    /** The kept ciphertext does not open with the key: changed, cut short, or of another key. */
    BROKEN,

    /** The keystore could not make a key or a cipher at all. */
    UNAVAILABLE,
}

class VaultException(val problem: VaultProblem, cause: Throwable? = null) : Exception("fingerprint vault: ${problem.name}", cause)

/**
 * Where the key lives. On a phone: an AES-256-GCM key in the Android Keystore that needs a strong
 * biometric for every use (auth/KeystoreVault.kt). In the tests: a software key.
 *
 * The prompt authorises the cipher the vault hands out (BiometricPrompt.CryptoObject); only then
 * can [VaultCrypto] seal or open with it.
 */
interface BiometricVault {
    /** A new key, replacing any key there was, and a cipher to encrypt with it. */
    fun encrypter(): Cipher

    /** A cipher to decrypt [sealed] with the key there is. */
    fun decrypter(sealed: Sealed): Cipher

    /** Delete the key. */
    fun delete()
}

/** Sealing and opening with a cipher the prompt has authorised. */
object VaultCrypto {
    const val TRANSFORMATION = "AES/GCM/NoPadding"
    const val TAG_BITS = 128

    /** Binds the ciphertext to what it is, so that nothing else sealed with the key opens as a token. */
    private val AAD = "cranium refresh token 1".toByteArray(Charsets.UTF_8)

    fun seal(cipher: Cipher, secret: String): Sealed = try {
        cipher.updateAAD(AAD)
        val ciphertext = cipher.doFinal(secret.toByteArray(Charsets.UTF_8))
        Sealed(ciphertext, cipher.iv ?: throw VaultException(VaultProblem.UNAVAILABLE))
    } catch (e: GeneralSecurityException) {
        throw VaultException(VaultProblem.UNAVAILABLE, e)
    } catch (e: IllegalStateException) {
        throw VaultException(VaultProblem.UNAVAILABLE, e)
    }

    fun open(cipher: Cipher, sealed: Sealed): String = try {
        cipher.updateAAD(AAD)
        cipher.doFinal(sealed.ciphertext).toString(Charsets.UTF_8).also {
            if (it.isEmpty()) throw VaultException(VaultProblem.BROKEN)
        }
    } catch (e: GeneralSecurityException) {
        throw VaultException(VaultProblem.BROKEN, e)
    } catch (e: IllegalStateException) {
        throw VaultException(VaultProblem.BROKEN, e)
    }
}

/** How a BiometricPrompt ended, as the app sees it. */
sealed interface PromptResult {
    /** The fingerprint passed; the cipher of the CryptoObject, now authorised. */
    class Passed(val cipher: Cipher?) : PromptResult

    /** Cancel, Back, a time-out, or the system ended it (the app went to the background). */
    data object Cancelled : PromptResult

    /** The prompt's own button: "Sign in with password", or "Not now". */
    data object Declined : PromptResult

    /** Too many attempts: for 30 s, or until the phone is unlocked with its PIN. */
    data object LockedOut : PromptResult

    /** No fingerprint enrolled any more. */
    data object NoFingerprint : PromptResult

    /** The sensor could not be used. */
    data object Unavailable : PromptResult
}

/** BiometricPrompt's error codes (androidx.biometric 1.1.0; BiometricTest checks them against the library). */
object PromptErrors {
    const val HW_UNAVAILABLE = 1
    const val UNABLE_TO_PROCESS = 2
    const val TIMEOUT = 3
    const val NO_SPACE = 4
    const val CANCELED = 5
    const val LOCKOUT = 7
    const val VENDOR = 8
    const val LOCKOUT_PERMANENT = 9
    const val USER_CANCELED = 10
    const val NO_BIOMETRICS = 11
    const val HW_NOT_PRESENT = 12
    const val NEGATIVE_BUTTON = 13
    const val NO_DEVICE_CREDENTIAL = 14
    const val SECURITY_UPDATE_REQUIRED = 15

    fun result(code: Int): PromptResult = when (code) {
        NEGATIVE_BUTTON -> PromptResult.Declined
        USER_CANCELED, CANCELED, TIMEOUT -> PromptResult.Cancelled
        LOCKOUT, LOCKOUT_PERMANENT -> PromptResult.LockedOut
        NO_BIOMETRICS, NO_DEVICE_CREDENTIAL -> PromptResult.NoFingerprint
        else -> PromptResult.Unavailable
    }
}

/** What the lock screen does after the vault or the prompt answered. */
sealed interface UnlockNext {
    /** Opened: the refresh token, to refresh with as usual. */
    class Open(val refreshToken: String) : UnlockNext

    /** Stay on the lock screen, with a line (or none), offering "Sign in with password". */
    data class Locked(val line: String?) : UnlockNext

    /** To the sign-in screen, keeping what is saved for the next time. */
    data object Password : UnlockNext

    /** Delete the key and the ciphertext, turn the setting off, and show the sign-in with this line. */
    data class Forget(val line: String) : UnlockNext
}

/** What turning it on (or keeping a new sign-in behind it) came to. */
sealed interface EnrolNext {
    class On(val sealed: Sealed) : EnrolNext

    /** Nothing kept behind the fingerprint; the line says why, or null when the person said no. */
    data class Off(val line: String?) : EnrolNext
}

/** The words of it. The phone's own name for it is "fingerprint" (BIOMETRIC_STRONG). */
object FingerprintWords {
    const val OFFER_TITLE = "Use your fingerprint to open Cranium?"
    const val OFFER_TEXT = "For up to 30 days, instead of your password and code. A change still asks for them."
    const val UNLOCK = "Unlock with fingerprint"
    const val PASSWORD = "Sign in with password"
    const val SETTING = "Unlock with fingerprint"

    const val LOCKED_OUT = "Too many attempts. Sign in with your password and code, or try again later."
    const val NO_SENSOR = "The fingerprint sensor cannot be used right now."
    const val NO_FINGERPRINT = "There is no fingerprint on this phone any more."
    const val INVALIDATED = "A fingerprint or the screen lock changed on this phone, so fingerprint unlock is off. Sign in with your password and code."
    const val MISSING = "The saved sign-in is not on this phone any more, so fingerprint unlock is off. Sign in with your password and code."
    const val BROKEN = "The saved sign-in could not be opened, so fingerprint unlock is off. Sign in with your password and code."
    const val ENDED = "Your saved sign-in has ended. Sign in with your password and code."
    const val ON = "Fingerprint unlock is on."
    const val OFF = "Fingerprint unlock is off."
    const val OFF_AGAIN = "Fingerprint unlock is off. Turn it on again under More, Account."
    const val OFF_SOON = "Fingerprint unlock is off. This sign-in ends within the hour: sign in again then."
    const val NOT_KEPT = "Fingerprint unlock could not be turned on."
    const val NO_SESSION = "Sign in again first: this sign-in can no longer be kept."

    /** Under the setting, when the phone cannot do it. */
    fun state(state: BiometricState): String? = when (state) {
        BiometricState.READY -> null
        BiometricState.NOT_ENROLLED -> "Add a fingerprint in the phone's settings first."
        BiometricState.NO_HARDWARE, BiometricState.UNSUPPORTED -> "This phone has no fingerprint sensor the app can use."
        BiometricState.UNAVAILABLE -> "The fingerprint sensor cannot be used right now."
        BiometricState.UPDATE_NEEDED -> "The phone needs a security update before the sensor can be used."
    }
}

/** When to ask, when to lock, how long a token is kept without it. */
object BiometricPolicy {
    /** Back after this long in the background, the app asks for the fingerprint again. */
    const val RELOCK_AFTER_MS = 5 * 60_000L

    /** With it off, the refresh token is forgotten this long after the sign-in. */
    const val KEEP_WITHOUT_S = 60 * 60L

    /**
     * Offer it once, after a full sign-in on the sign-in screen (not the fresh sign-in for a
     * change), when the phone has a strong biometric, it is not on yet, and this person has not
     * said "Not now" on this phone.
     */
    fun offer(fullSignIn: Boolean, state: BiometricState, on: Boolean, declined: Boolean): Boolean =
        fullSignIn && state == BiometricState.READY && !on && !declined

    /** Whether coming back to the console asks for the fingerprint: on, and away 5 minutes or more. */
    fun relock(on: Boolean, awaySinceMs: Long?, nowMs: Long): Boolean =
        on && awaySinceMs != null && nowMs - awaySinceMs >= RELOCK_AFTER_MS

    /** Whether a refresh token may still be kept: always behind the fingerprint, otherwise for an hour. */
    fun keepsRefreshToken(on: Boolean, signedInAt: Long, nowS: Long): Boolean =
        on || (signedInAt > 0 && nowS < signedInAt + KEEP_WITHOUT_S)

    /** The person a "Not now" is kept for, without keeping their account ID: SHA-256 of `sub`. */
    fun personKey(sub: String): String =
        MessageDigest.getInstance("SHA-256").digest(sub.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
}

/** The steps of turning it on and of unlocking, with what each answer leads to. */
class FingerprintLock(private val vault: BiometricVault) {
    /** Either a cipher for the prompt, or what to do at once without one. */
    sealed interface Begin<out T> {
        class Prompt(val cipher: Cipher) : Begin<Nothing>

        class Done<T>(val next: T) : Begin<T>
    }

    /** Turning it on: a new key, and its cipher for the prompt. */
    fun beginEnrol(): Begin<EnrolNext> = try {
        Begin.Prompt(vault.encrypter())
    } catch (e: VaultException) {
        Begin.Done(EnrolNext.Off(FingerprintWords.NOT_KEPT))
    } catch (e: GeneralSecurityException) {
        Begin.Done(EnrolNext.Off(FingerprintWords.NOT_KEPT))
    }

    /** The prompt answered: seal the refresh token, or say why nothing was kept. */
    fun finishEnrol(result: PromptResult, refreshToken: String?): EnrolNext {
        val cipher = (result as? PromptResult.Passed)?.cipher
        if (cipher != null && !refreshToken.isNullOrEmpty()) {
            try {
                return EnrolNext.On(VaultCrypto.seal(cipher, refreshToken))
            } catch (e: VaultException) {
                // Not sealed: nothing is kept, as below.
            }
        }
        // The new key seals nothing: it goes.
        runCatching { vault.delete() }
        return EnrolNext.Off(
            when (result) {
                is PromptResult.Passed -> if (refreshToken.isNullOrEmpty()) FingerprintWords.NO_SESSION else FingerprintWords.NOT_KEPT
                PromptResult.Cancelled, PromptResult.Declined -> null
                PromptResult.LockedOut -> FingerprintWords.LOCKED_OUT
                PromptResult.NoFingerprint -> FingerprintWords.NO_FINGERPRINT
                PromptResult.Unavailable -> FingerprintWords.NO_SENSOR
            },
        )
    }

    /** Unlocking: a cipher for what was kept, or why it cannot be opened. */
    fun beginUnlock(sealed: Sealed?): Begin<UnlockNext> {
        if (sealed == null) return Begin.Done(forget(VaultProblem.MISSING))
        return try {
            Begin.Prompt(vault.decrypter(sealed))
        } catch (e: VaultException) {
            Begin.Done(forget(e.problem))
        } catch (e: GeneralSecurityException) {
            Begin.Done(forget(VaultProblem.BROKEN))
        }
    }

    /** The prompt answered: open the refresh token, stay locked, or forget it. */
    fun finishUnlock(result: PromptResult, sealed: Sealed): UnlockNext = when (result) {
        is PromptResult.Passed -> {
            val cipher = result.cipher
            if (cipher == null) {
                forget(VaultProblem.BROKEN)
            } else {
                try {
                    UnlockNext.Open(VaultCrypto.open(cipher, sealed))
                } catch (e: VaultException) {
                    forget(e.problem)
                }
            }
        }
        PromptResult.Cancelled -> UnlockNext.Locked(null)
        PromptResult.Declined -> UnlockNext.Password
        PromptResult.LockedOut -> UnlockNext.Locked(FingerprintWords.LOCKED_OUT)
        PromptResult.Unavailable -> UnlockNext.Locked(FingerprintWords.NO_SENSOR)
        // Without a fingerprint the key is gone with it (setInvalidatedByBiometricEnrollment).
        PromptResult.NoFingerprint -> forget(VaultProblem.INVALIDATED)
    }

    private fun forget(problem: VaultProblem): UnlockNext.Forget {
        runCatching { vault.delete() }
        return UnlockNext.Forget(
            when (problem) {
                VaultProblem.INVALIDATED -> FingerprintWords.INVALIDATED
                VaultProblem.MISSING -> FingerprintWords.MISSING
                VaultProblem.BROKEN, VaultProblem.UNAVAILABLE -> FingerprintWords.BROKEN
            },
        )
    }
}
