package com.craniumiot.cranium.auth

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import com.craniumiot.cranium.core.BiometricState
import com.craniumiot.cranium.core.BiometricVault
import com.craniumiot.cranium.core.Sealed
import com.craniumiot.cranium.core.SessionKeys
import com.craniumiot.cranium.core.VaultCrypto
import com.craniumiot.cranium.core.VaultException
import com.craniumiot.cranium.core.VaultProblem
import java.security.GeneralSecurityException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The key that keeps the refresh token behind the fingerprint: AES-256-GCM in the Android
 * Keystore, in StrongBox when the phone has one and otherwise in the TEE, usable only after a
 * strong biometric for each single use (no device PIN, no time window), and invalidated when a
 * fingerprint is added or all are removed. The token itself never leaves the cipher the prompt
 * authorised; the ciphertext and its IV go to EncryptedSharedPreferences (TokenStore).
 *
 * The staff session and a customer's each have a key of their own, under [alias] (SessionKeys).
 */
class KeystoreVault(context: Context, private val alias: String = ALIAS) : BiometricVault {
    private val strongBox = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
        context.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)

    private fun keyStore(): KeyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }

    override fun encrypter(): Cipher {
        delete()
        val key = try {
            generate(strongBox)
        } catch (e: GeneralSecurityException) {
            // StrongBoxUnavailableException, or a StrongBox that takes no AES-256: the TEE.
            if (strongBox) generateOrFail(false) else throw VaultException(VaultProblem.UNAVAILABLE, e)
        } catch (e: IllegalStateException) {
            throw VaultException(VaultProblem.UNAVAILABLE, e)
        }
        return try {
            Cipher.getInstance(VaultCrypto.TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, key) }
        } catch (e: GeneralSecurityException) {
            delete()
            throw VaultException(VaultProblem.UNAVAILABLE, e)
        }
    }

    override fun decrypter(sealed: Sealed): Cipher {
        val key = try {
            keyStore().getKey(alias, null) as? SecretKey
        } catch (e: GeneralSecurityException) {
            throw VaultException(VaultProblem.BROKEN, e)
        } ?: throw VaultException(VaultProblem.MISSING)
        return try {
            Cipher.getInstance(VaultCrypto.TRANSFORMATION).apply {
                init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(VaultCrypto.TAG_BITS, sealed.iv))
            }
        } catch (e: KeyPermanentlyInvalidatedException) {
            throw VaultException(VaultProblem.INVALIDATED, e)
        } catch (e: GeneralSecurityException) {
            throw VaultException(VaultProblem.BROKEN, e)
        }
    }

    override fun delete() {
        runCatching { keyStore().deleteEntry(alias) }
    }

    private fun generateOrFail(inStrongBox: Boolean): SecretKey = try {
        generate(inStrongBox)
    } catch (e: GeneralSecurityException) {
        throw VaultException(VaultProblem.UNAVAILABLE, e)
    }

    private fun generate(inStrongBox: Boolean): SecretKey {
        val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setKeySize(KEY_BITS)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true)
            .apply {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    // Every use, and only a strong biometric: never the device PIN.
                    setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
                } else {
                    // -1: every use needs an authentication through a CryptoObject, which below API 30 is a biometric.
                    @Suppress("DEPRECATION")
                    setUserAuthenticationValidityDurationSeconds(-1)
                }
                if (inStrongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) setIsStrongBoxBacked(true)
            }
            .build()
        return try {
            KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER).run {
                init(spec)
                generateKey()
            }
        } catch (e: RuntimeException) {
            // StrongBoxUnavailableException is a ProviderException, a RuntimeException.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && e is StrongBoxUnavailableException) {
                throw GeneralSecurityException("StrongBox unavailable", e)
            }
            throw VaultException(VaultProblem.UNAVAILABLE, e)
        }
    }

    companion object {
        const val PROVIDER = "AndroidKeyStore"
        const val ALIAS = SessionKeys.STAFF_FINGERPRINT

        /** A customer's key, apart from the staff session's. */
        const val CUSTOMER_ALIAS = SessionKeys.CUSTOMER_FINGERPRINT
        const val KEY_BITS = 256

        /** BiometricManager.canAuthenticate(BIOMETRIC_STRONG): only a strong biometric, never the device PIN. */
        fun state(context: Context): BiometricState =
            when (BiometricManager.from(context).canAuthenticate(BIOMETRIC_STRONG)) {
                BiometricManager.BIOMETRIC_SUCCESS -> BiometricState.READY
                BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> BiometricState.NOT_ENROLLED
                BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE -> BiometricState.NO_HARDWARE
                BiometricManager.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED -> BiometricState.UPDATE_NEEDED
                BiometricManager.BIOMETRIC_ERROR_UNSUPPORTED -> BiometricState.UNSUPPORTED
                else -> BiometricState.UNAVAILABLE
            }
    }
}
