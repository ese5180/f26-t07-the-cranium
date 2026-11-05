package com.craniumiot.cranium.auth

import androidx.security.crypto.MasterKey
import com.craniumiot.cranium.CraniumConfig
import com.craniumiot.cranium.core.BiometricVault
import com.craniumiot.cranium.core.IdpAnswer
import com.craniumiot.cranium.core.IdpTransport
import com.craniumiot.cranium.core.Sealed
import com.craniumiot.cranium.core.SessionKeys
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import javax.crypto.Cipher

/**
 * The two sessions apart (docs/mobile-apps.md, "Customers"): a customer's and the staff session of
 * admin mode are kept under names of their own, each is refreshed and revoked with its own pool's
 * client, and ending one leaves the other as it was.
 */
class CustomerSessionTest {
    private class MemoryStore(var session: Session? = null) : SessionStore {
        var cleared = 0
        private var searches = emptyList<String>()
        private val declinedPeople = mutableSetOf<String>()
        override fun load() = session
        override fun save(session: Session) { this.session = session }
        override fun clearSession() { session = null }
        override fun fingerprintOn() = false
        override fun vault(): Sealed? = null
        override fun saveVault(sealed: Sealed) = Unit
        override fun clearVault() = Unit
        override fun fingerprintOff() = Unit
        override fun declined(person: String) = person in declinedPeople
        override fun decline(person: String) { declinedPeople += person }
        override fun recentSearches() = searches
        override fun saveRecentSearches(list: List<String>) { searches = list }
        override fun clear() {
            cleared += 1
            session = null
            searches = emptyList()
        }
    }

    private class NoVault : BiometricVault {
        var deleted = 0
        override fun encrypter(): Cipher = throw UnsupportedOperationException()
        override fun decrypter(sealed: Sealed): Cipher = throw UnsupportedOperationException()
        override fun delete() { deleted += 1 }
    }

    private class Pool(val clientId: String) : IdpTransport {
        val calls = mutableListOf<Pair<String, JsonObject>>()
        override suspend fun call(operation: String, body: JsonObject): IdpAnswer {
            calls += operation to body
            if ((body["ClientId"] as? JsonPrimitive)?.content != clientId) return IdpAnswer.Refused("ResourceNotFoundException")
            return when (operation) {
                "InitiateAuth" -> IdpAnswer.Reply(
                    buildJsonObject {
                        putJsonObject("AuthenticationResult") {
                            put("AccessToken", "ACCESS-$clientId-2")
                            put("ExpiresIn", 3600)
                            put("TokenType", "Bearer")
                        }
                    },
                    null,
                )
                "RevokeToken" -> IdpAnswer.Reply(JsonObject(emptyMap()), null)
                else -> IdpAnswer.Refused("UnknownOperationException")
            }
        }
    }

    private val config = CraniumConfig(
        consoleUrl = "https://console.example.invalid",
        loginDomain = "https://login.example.invalid",
        mobileClientId = "staffphone",
        redirectUri = "cranium://signin",
        region = "us-east-1",
        userPoolId = "us-east-1_Staff",
        isExample = true,
        customerApiUrl = "https://customer.example.invalid",
        customerClientId = "customerphone",
        customerRegion = "us-east-1",
        customerUserPoolId = "us-east-1_Customers",
    )

    private fun now() = System.currentTimeMillis() / 1000

    private fun session(token: String) = Session(token, null, "REFRESH-$token", now() - 10, Session.SRP, signedInAt = now() - 60)

    @Test
    fun `each session has a file, a master key and a fingerprint key of its own, and the staff's are as before`() {
        val staff = listOf(SessionKeys.STAFF_FILE, SessionKeys.STAFF_MASTER_KEY, SessionKeys.STAFF_FINGERPRINT)
        val customer = listOf(SessionKeys.CUSTOMER_FILE, SessionKeys.CUSTOMER_MASTER_KEY, SessionKeys.CUSTOMER_FINGERPRINT)
        assertTrue((staff + customer).toSet().size == 6)
        // An installed app keeps its staff session after the update: the names it always had.
        assertEquals("cranium_tokens", SessionKeys.STAFF_FILE)
        assertEquals(MasterKey.DEFAULT_MASTER_KEY_ALIAS, SessionKeys.STAFF_MASTER_KEY)
        assertEquals("cranium_refresh_token_fingerprint_v1", KeystoreVault.ALIAS)
        assertEquals(SessionKeys.CUSTOMER_FINGERPRINT, KeystoreVault.CUSTOMER_ALIAS)
    }

    @Test
    fun `the customer's sign-in is with the customer pool, its phone client, and no AWS sign-in page`() {
        val customer = AuthSettings.customer(config)!!
        assertEquals("customerphone", customer.clientId)
        assertEquals("us-east-1_Customers", customer.userPoolId)
        assertNull(customer.loginDomain)
        assertTrue(customer.newPasswordHere)
        val staff = AuthSettings.staff(config)
        assertEquals("staffphone", staff.clientId)
        assertFalse(staff.newPasswordHere)
        assertNull(AuthSettings.customer(config.copy(customerClientId = "")))
        assertFalse(config.copy(customerApiUrl = "").hasCustomer)
        // Printed, neither says what it holds.
        assertFalse(customer.toString().contains("customerphone"))
        assertFalse(config.toString().contains("customer.example.invalid"))
    }

    @Test
    fun `each session refreshes and revokes with its own client, and signing one out leaves the other`() = runTest {
        val customerStore = MemoryStore(session("C"))
        val staffStore = MemoryStore(session("S"))
        val customerPool = Pool("customerphone")
        val staffPool = Pool("staffphone")
        val customerVault = NoVault()
        val staffVault = NoVault()
        val customer = AuthManager(null, AuthSettings.customer(config)!!, customerStore, customerVault, customerPool)
        val staff = AuthManager(null, AuthSettings.staff(config), staffStore, staffVault, staffPool)
        assertTrue(customer.isSignedIn && staff.isSignedIn)
        assertFalse(customer.hasAwsPage)
        assertTrue(staff.hasAwsPage)

        assertEquals("ACCESS-customerphone-2", customer.accessToken())
        assertEquals("ACCESS-staffphone-2", staff.accessToken())
        assertEquals("REFRESH_TOKEN_AUTH", (customerPool.calls.single().second["AuthFlow"] as JsonPrimitive).content)
        assertEquals("ACCESS-customerphone-2", customerStore.session?.accessToken)
        assertEquals("ACCESS-staffphone-2", staffStore.session?.accessToken)

        customer.signOut()
        assertFalse(customer.isSignedIn)
        assertNull(customerStore.session)
        assertEquals(1, customerVault.deleted)
        val revoke = customerPool.calls.last()
        assertEquals("RevokeToken", revoke.first)
        assertEquals("REFRESH-C", (revoke.second["Token"] as JsonPrimitive).content)
        // The staff session is as it was: its store, its key, its pool untouched.
        assertTrue(staff.isSignedIn)
        assertNotNull(staffStore.session)
        assertEquals(0, staffStore.cleared)
        assertEquals(0, staffVault.deleted)
        assertEquals(1, staffPool.calls.size)
        assertEquals("ACCESS-staffphone-2", staff.accessToken())
    }
}
