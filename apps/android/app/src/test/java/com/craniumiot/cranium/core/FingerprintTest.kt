package com.craniumiot.cranium.core

import androidx.biometric.BiometricPrompt
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Fingerprint unlock on the JVM: the policy, and every answer of the vault and the prompt, with a
 * software AES-256-GCM key standing in for the Keystore's.
 */
class FingerprintTest {
    /** The Keystore, as far as the app can tell: a key that can be gone, or invalidated by a new fingerprint. */
    private class FakeVault : BiometricVault {
        var key: SecretKey? = null
        var invalidated = false
        var cannotMakeKeys = false
        var deletes = 0

        override fun encrypter(): Cipher {
            if (cannotMakeKeys) throw VaultException(VaultProblem.UNAVAILABLE)
            invalidated = false
            val made = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
            key = made
            return Cipher.getInstance(VaultCrypto.TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, made) }
        }

        override fun decrypter(sealed: Sealed): Cipher {
            val kept = key ?: throw VaultException(VaultProblem.MISSING)
            if (invalidated) throw VaultException(VaultProblem.INVALIDATED)
            return Cipher.getInstance(VaultCrypto.TRANSFORMATION).apply {
                init(Cipher.DECRYPT_MODE, kept, GCMParameterSpec(VaultCrypto.TAG_BITS, sealed.iv))
            }
        }

        override fun delete() {
            key = null
            deletes++
        }
    }

    private val token = "eyJjdHkiOiJKV1QiLCJlbmMiOiJBMjU2R0NNIn0.refresh-token-for-the-test"

    /** Turn it on: the prompt passes, and the token is sealed. */
    private fun enrolled(vault: FakeVault, lock: FingerprintLock): Sealed {
        val begin = lock.beginEnrol() as FingerprintLock.Begin.Prompt
        val next = lock.finishEnrol(PromptResult.Passed(begin.cipher), token)
        return (next as EnrolNext.On).sealed.also { assertTrue(vault.key != null) }
    }

    private fun unlock(lock: FingerprintLock, sealed: Sealed, result: (Cipher) -> PromptResult = { PromptResult.Passed(it) }): UnlockNext =
        when (val begin = lock.beginUnlock(sealed)) {
            is FingerprintLock.Begin.Prompt -> lock.finishUnlock(result(begin.cipher), sealed)
            is FingerprintLock.Begin.Done -> begin.next
        }

    @Test
    fun `turned on, the token is kept only as ciphertext and opens again with the fingerprint`() {
        val vault = FakeVault()
        val lock = FingerprintLock(vault)
        val sealed = enrolled(vault, lock)
        val stored = sealed.toJson()
        assertFalse(stored.contains(token))
        assertFalse(stored.contains("refresh-token"))
        assertEquals(12, sealed.iv.size)

        val reread = Sealed.fromJson(stored)!!
        val opened = unlock(lock, reread) as UnlockNext.Open
        assertEquals(token, opened.refreshToken)
    }

    @Test
    fun `a new fingerprint invalidates the key, which is forgotten with the line that says why`() {
        val vault = FakeVault()
        val lock = FingerprintLock(vault)
        val sealed = enrolled(vault, lock)
        vault.invalidated = true
        assertEquals(UnlockNext.Forget(FingerprintWords.INVALIDATED), unlock(lock, sealed))
        assertNull(vault.key)
    }

    @Test
    fun `a key that is missing, or nothing kept, is forgotten too`() {
        val vault = FakeVault()
        val lock = FingerprintLock(vault)
        val sealed = enrolled(vault, lock)
        vault.key = null
        assertEquals(UnlockNext.Forget(FingerprintWords.MISSING), unlock(lock, sealed))
        assertEquals(UnlockNext.Forget(FingerprintWords.MISSING), (lock.beginUnlock(null) as FingerprintLock.Begin.Done).next)
    }

    @Test
    fun `a ciphertext that does not open is forgotten, whether changed, of an older key, or sealed without the app's binding`() {
        val vault = FakeVault()
        val lock = FingerprintLock(vault)
        val sealed = enrolled(vault, lock)

        val changed = Sealed(sealed.ciphertext.copyOf().also { it[0] = (it[0].toInt() xor 1).toByte() }, sealed.iv)
        assertEquals(UnlockNext.Forget(FingerprintWords.BROKEN), unlock(lock, changed))

        // Turned on again: a new key, so the old ciphertext is of no use.
        val older = enrolled(vault, lock)
        enrolled(vault, lock)
        assertEquals(UnlockNext.Forget(FingerprintWords.BROKEN), unlock(lock, older))

        // The same key, but without the associated data the app seals with.
        val unbound = (lock.beginEnrol() as FingerprintLock.Begin.Prompt).cipher.let { Sealed(it.doFinal(token.toByteArray()), it.iv) }
        assertEquals(UnlockNext.Forget(FingerprintWords.BROKEN), unlock(lock, unbound))
    }

    @Test
    fun `each answer of the unlock prompt`() {
        val vault = FakeVault()
        val lock = FingerprintLock(vault)
        val sealed = enrolled(vault, lock)
        assertEquals(UnlockNext.Locked(null), unlock(lock, sealed) { PromptResult.Cancelled })
        assertEquals(UnlockNext.Password, unlock(lock, sealed) { PromptResult.Declined })
        assertEquals(UnlockNext.Locked(FingerprintWords.LOCKED_OUT), unlock(lock, sealed) { PromptResult.LockedOut })
        assertEquals(UnlockNext.Locked(FingerprintWords.NO_SENSOR), unlock(lock, sealed) { PromptResult.Unavailable })
        assertTrue(vault.key != null)
        // None of those touched the key; a passed prompt without a cipher, or no fingerprint left, does.
        assertEquals(UnlockNext.Forget(FingerprintWords.BROKEN), unlock(lock, sealed) { PromptResult.Passed(null) })
        val again = enrolled(vault, lock)
        assertEquals(UnlockNext.Forget(FingerprintWords.INVALIDATED), unlock(lock, again) { PromptResult.NoFingerprint })
    }

    @Test
    fun `turning it on keeps nothing unless the prompt passes, and says why`() {
        val vault = FakeVault()
        val lock = FingerprintLock(vault)
        fun answer(result: PromptResult, refresh: String? = token): EnrolNext {
            val begin = lock.beginEnrol() as FingerprintLock.Begin.Prompt
            return lock.finishEnrol(if (result is PromptResult.Passed) PromptResult.Passed(begin.cipher) else result, refresh)
        }
        assertEquals(EnrolNext.Off(null), answer(PromptResult.Cancelled))
        assertNull(vault.key)
        assertEquals(EnrolNext.Off(null), answer(PromptResult.Declined))
        assertEquals(EnrolNext.Off(FingerprintWords.LOCKED_OUT), answer(PromptResult.LockedOut))
        assertEquals(EnrolNext.Off(FingerprintWords.NO_FINGERPRINT), answer(PromptResult.NoFingerprint))
        assertEquals(EnrolNext.Off(FingerprintWords.NO_SENSOR), answer(PromptResult.Unavailable))
        assertEquals(EnrolNext.Off(FingerprintWords.NO_SESSION), answer(PromptResult.Passed(null), refresh = null))
        assertNull(vault.key)

        vault.cannotMakeKeys = true
        val begin = lock.beginEnrol() as FingerprintLock.Begin.Done
        assertEquals(EnrolNext.Off(FingerprintWords.NOT_KEPT), begin.next)
    }

    @Test
    fun `the prompt's error codes are the library's, and each leads where the rule says`() {
        assertEquals(BiometricPrompt.ERROR_HW_UNAVAILABLE, PromptErrors.HW_UNAVAILABLE)
        assertEquals(BiometricPrompt.ERROR_UNABLE_TO_PROCESS, PromptErrors.UNABLE_TO_PROCESS)
        assertEquals(BiometricPrompt.ERROR_TIMEOUT, PromptErrors.TIMEOUT)
        assertEquals(BiometricPrompt.ERROR_NO_SPACE, PromptErrors.NO_SPACE)
        assertEquals(BiometricPrompt.ERROR_CANCELED, PromptErrors.CANCELED)
        assertEquals(BiometricPrompt.ERROR_LOCKOUT, PromptErrors.LOCKOUT)
        assertEquals(BiometricPrompt.ERROR_VENDOR, PromptErrors.VENDOR)
        assertEquals(BiometricPrompt.ERROR_LOCKOUT_PERMANENT, PromptErrors.LOCKOUT_PERMANENT)
        assertEquals(BiometricPrompt.ERROR_USER_CANCELED, PromptErrors.USER_CANCELED)
        assertEquals(BiometricPrompt.ERROR_NO_BIOMETRICS, PromptErrors.NO_BIOMETRICS)
        assertEquals(BiometricPrompt.ERROR_HW_NOT_PRESENT, PromptErrors.HW_NOT_PRESENT)
        assertEquals(BiometricPrompt.ERROR_NEGATIVE_BUTTON, PromptErrors.NEGATIVE_BUTTON)
        assertEquals(BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL, PromptErrors.NO_DEVICE_CREDENTIAL)
        assertEquals(BiometricPrompt.ERROR_SECURITY_UPDATE_REQUIRED, PromptErrors.SECURITY_UPDATE_REQUIRED)

        assertEquals(PromptResult.Declined, PromptErrors.result(BiometricPrompt.ERROR_NEGATIVE_BUTTON))
        for (code in listOf(BiometricPrompt.ERROR_USER_CANCELED, BiometricPrompt.ERROR_CANCELED, BiometricPrompt.ERROR_TIMEOUT)) {
            assertEquals(PromptResult.Cancelled, PromptErrors.result(code))
        }
        assertEquals(PromptResult.LockedOut, PromptErrors.result(BiometricPrompt.ERROR_LOCKOUT))
        assertEquals(PromptResult.LockedOut, PromptErrors.result(BiometricPrompt.ERROR_LOCKOUT_PERMANENT))
        assertEquals(PromptResult.NoFingerprint, PromptErrors.result(BiometricPrompt.ERROR_NO_BIOMETRICS))
        for (code in listOf(1, 2, 4, 8, 12, 15, 99)) assertEquals(PromptResult.Unavailable, PromptErrors.result(code))
    }

    @Test
    fun `offered once, after a full sign-in, on a phone with a strong biometric`() {
        assertTrue(BiometricPolicy.offer(fullSignIn = true, BiometricState.READY, on = false, declined = false))
        assertFalse(BiometricPolicy.offer(fullSignIn = false, BiometricState.READY, on = false, declined = false))
        assertFalse(BiometricPolicy.offer(fullSignIn = true, BiometricState.READY, on = true, declined = false))
        assertFalse(BiometricPolicy.offer(fullSignIn = true, BiometricState.READY, on = false, declined = true))
        for (state in BiometricState.entries - BiometricState.READY) {
            assertFalse(state.name, BiometricPolicy.offer(fullSignIn = true, state, on = false, declined = false))
            assertTrue(state.name, FingerprintWords.state(state) != null)
        }
        assertNull(FingerprintWords.state(BiometricState.READY))
    }

    @Test
    fun `back after 5 minutes or more asks again, and not before that or with it off`() {
        val away = 1_000_000L
        assertTrue(BiometricPolicy.relock(on = true, away, away + 5 * 60_000))
        assertTrue(BiometricPolicy.relock(on = true, away, away + 60 * 60_000))
        assertFalse(BiometricPolicy.relock(on = true, away, away + 5 * 60_000 - 1))
        assertFalse(BiometricPolicy.relock(on = false, away, away + 60 * 60_000))
        assertFalse(BiometricPolicy.relock(on = true, null, away))
    }

    @Test
    fun `without it, a refresh token is kept for the hour after the sign-in only`() {
        val signedIn = 1_800_000_000L
        assertTrue(BiometricPolicy.keepsRefreshToken(on = false, signedIn, signedIn))
        assertTrue(BiometricPolicy.keepsRefreshToken(on = false, signedIn, signedIn + 3_599))
        assertFalse(BiometricPolicy.keepsRefreshToken(on = false, signedIn, signedIn + 3_600))
        assertFalse(BiometricPolicy.keepsRefreshToken(on = false, signedIn, signedIn + 30 * 86_400))
        // A sign-in of unknown time is not kept.
        assertFalse(BiometricPolicy.keepsRefreshToken(on = false, 0, signedIn))
        // Behind the fingerprint, for as long as Cognito takes it (30 days).
        assertTrue(BiometricPolicy.keepsRefreshToken(on = true, signedIn, signedIn + 29 * 86_400))
    }

    @Test
    fun `a Not now is kept for the person as a hash of the account, not the account`() {
        val sub = "0d4c5f0e-1111-2222-3333-444455556666"
        val key = BiometricPolicy.personKey(sub)
        assertEquals(64, key.length)
        assertTrue(key.all { it in '0'..'9' || it in 'a'..'f' })
        assertEquals(key, BiometricPolicy.personKey(sub))
        assertNotEquals(key, BiometricPolicy.personKey("$sub-other"))
        assertFalse(key.contains(sub))
    }

    @Test
    fun `what is stored reads back only as it was written`() {
        val sealed = Sealed(byteArrayOf(1, 2, 3), ByteArray(12) { it.toByte() })
        val back = Sealed.fromJson(sealed.toJson())!!
        assertTrue(back.ciphertext.contentEquals(sealed.ciphertext))
        assertTrue(back.iv.contentEquals(sealed.iv))
        for (bad in listOf(null, "", "{}", "not json", """{"v":2,"ct":"AQID","iv":"AAAA"}""", """{"v":1,"ct":"","iv":"AAAA"}""", """{"v":1,"ct":"AQID","iv":"%%"}""")) {
            assertNull(bad, Sealed.fromJson(bad))
        }
    }
}
