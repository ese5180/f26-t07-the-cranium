package com.craniumiot.cranium.core

/**
 * Where each of the two sessions is kept on the phone, kept apart in every name as the customer
 * site keeps its two sessions under keys of their own (docs/customer-site.md, "The two sessions do
 * not mix"): the staff session of admin mode as the app has always kept it, so that an installed
 * app keeps its sign-in after the update, and the customer's under names of its own.
 *
 * Each is an EncryptedSharedPreferences file with its own master key in the Android Keystore, and
 * its own Keystore key for fingerprint unlock. Signing out, or losing a key, of one touches nothing
 * of the other.
 */
object SessionKeys {
    /** The staff session: the file, its master key (androidx.security's default) and the fingerprint key. */
    const val STAFF_FILE = "cranium_tokens"
    const val STAFF_MASTER_KEY = "_androidx_security_master_key_"
    const val STAFF_FINGERPRINT = "cranium_refresh_token_fingerprint_v1"

    /** The customer's. */
    const val CUSTOMER_FILE = "cranium_customer_tokens"
    const val CUSTOMER_MASTER_KEY = "cranium_customer_master_key"
    const val CUSTOMER_FINGERPRINT = "cranium_customer_refresh_token_fingerprint_v1"
}
