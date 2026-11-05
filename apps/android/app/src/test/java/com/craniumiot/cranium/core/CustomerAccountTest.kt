package com.craniumiot.cranium.core

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** A customer's own account at Cognito (customer-core.js createAccount), against a stand-in for the user pool API. */
class CustomerAccountTest {
    private class Pool : IdpTransport {
        val calls = mutableListOf<Pair<String, JsonObject>>()
        val answers = mutableMapOf<String, IdpAnswer>()
        override suspend fun call(operation: String, body: JsonObject): IdpAnswer {
            calls += operation to body
            return answers[operation] ?: IdpAnswer.Reply(JsonObject(emptyMap()), null)
        }
    }

    private fun text(body: JsonObject, name: String) = (body[name] as? JsonPrimitive)?.content

    @Test
    fun `who is signed in, and whether sign-in asks for a code, from GetUser with the customer's token`() = runTest {
        val pool = Pool()
        pool.answers["GetUser"] = IdpAnswer.Reply(
            buildJsonObject {
                putJsonArray("UserAttributes") {
                    add(buildJsonObject { put("Name", "email"); put("Value", "ada@example.invalid") })
                    add(buildJsonObject { put("Name", "name"); put("Value", "Ada\u0000 Lovelace") })
                }
                put("UserMFASettingList", buildJsonArray { add(JsonPrimitive("SOFTWARE_TOKEN_MFA")) })
            },
            null,
        )
        val account = CustomerAccount(pool, "customerclient") { "CUSTOMER-TOKEN" }
        assertEquals(AccountResult.Ok(CustomerProfile("ada@example.invalid", "Ada Lovelace", true)), account.profile())
        assertEquals("CUSTOMER-TOKEN", text(pool.calls.single().second, "AccessToken"))
        pool.answers["GetUser"] = IdpAnswer.Reply(JsonObject(emptyMap()), null)
        assertEquals(AccountResult.Ok(CustomerProfile("", "", false)), account.profile())
    }

    @Test
    fun `without a session nothing is asked, and Cognito's refusals are the website's words`() = runTest {
        val pool = Pool()
        val ended = CustomerAccount(pool, "customerclient") { null }
        assertEquals(AccountResult.Failed("session-ended"), ended.profile())
        assertEquals(AccountResult.Failed("session-ended"), ended.changePassword("old password", "new password!"))
        assertTrue(pool.calls.isEmpty())

        val account = CustomerAccount(pool, "customerclient") { "T" }
        assertEquals(AccountResult.Failed("wrong-password"), account.changePassword("", "new password!"))
        pool.answers["ChangePassword"] = IdpAnswer.Refused("NotAuthorizedException")
        assertEquals(AccountResult.Failed("wrong-password"), account.changePassword("old password", "new password!"))
        pool.answers["ChangePassword"] = IdpAnswer.Refused("InvalidPasswordException")
        assertEquals(AccountResult.Failed("weak-password"), account.changePassword("old password", "short"))
        pool.answers["ChangePassword"] = IdpAnswer.Problem("network")
        assertEquals(AccountResult.Failed("network"), account.changePassword("old password", "new password!"))
        pool.answers.remove("ChangePassword")
        assertEquals(AccountResult.Ok(Unit), account.changePassword("old password", "new password!"))
        val sent = pool.calls.last().second
        assertEquals("old password", text(sent, "PreviousPassword"))
        assertEquals("new password!", text(sent, "ProposedPassword"))
    }

    @Test
    fun `an authenticator app, its secret and its first code, then sign-in asks for a code`() = runTest {
        val pool = Pool()
        val account = CustomerAccount(pool, "customerclient") { "T" }
        pool.answers["AssociateSoftwareToken"] = IdpAnswer.Reply(buildJsonObject { put("SecretCode", "not a secret") }, null)
        assertEquals(AccountResult.Failed("failed"), account.startAuthenticator())
        pool.answers["AssociateSoftwareToken"] = IdpAnswer.Reply(buildJsonObject { put("SecretCode", "ABCDEFGHIJKLMNOP") }, null)
        assertEquals(AccountResult.Ok("ABCDEFGHIJKLMNOP"), account.startAuthenticator())

        assertEquals(AccountResult.Failed("short-code"), account.confirmAuthenticator("12345"))
        pool.answers["VerifySoftwareToken"] = IdpAnswer.Reply(buildJsonObject { put("Status", "ERROR") }, null)
        assertEquals(AccountResult.Failed("wrong-code"), account.confirmAuthenticator("123456"))
        pool.answers["VerifySoftwareToken"] = IdpAnswer.Refused("EnableSoftwareTokenMFAException")
        assertEquals(AccountResult.Failed("wrong-code"), account.confirmAuthenticator("123456"))
        pool.calls.clear()
        pool.answers["VerifySoftwareToken"] = IdpAnswer.Reply(buildJsonObject { put("Status", "SUCCESS") }, null)
        assertEquals(AccountResult.Ok(Unit), account.confirmAuthenticator("123456"))
        assertEquals(listOf("VerifySoftwareToken", "SetUserMFAPreference"), pool.calls.map { it.first })
        assertEquals("Cranium", text(pool.calls[0].second, "FriendlyDeviceName"))
        val on = pool.calls[1].second["SoftwareTokenMfaSettings"] as JsonObject
        assertEquals("true", (on["Enabled"] as JsonPrimitive).content)
        assertEquals("true", (on["PreferredMfa"] as JsonPrimitive).content)

        assertEquals(AccountResult.Ok(Unit), account.stopAuthenticator())
        val off = pool.calls.last().second["SoftwareTokenMfaSettings"] as JsonObject
        assertEquals("false", (off["Enabled"] as JsonPrimitive).content)
    }

    @Test
    fun `a forgotten password, a code to the address and then the new password with it, with the customer client`() = runTest {
        val pool = Pool()
        val account = CustomerAccount(pool, "customerclient") { null }
        assertEquals(AccountResult.Failed("missing-email"), account.forgotPassword("  "))
        assertEquals(AccountResult.Ok(Unit), account.forgotPassword("  Ada@Example.INVALID "))
        val asked = pool.calls.single()
        assertEquals("ForgotPassword", asked.first)
        assertEquals("customerclient", text(asked.second, "ClientId"))
        assertEquals("ada@example.invalid", text(asked.second, "Username"))
        assertFalse("no token is needed, nor sent", asked.second.containsKey("AccessToken"))
        pool.answers["ForgotPassword"] = IdpAnswer.Refused("NotAuthorizedException")
        assertEquals(AccountResult.Failed("not-yet"), account.forgotPassword("ada@example.invalid"))

        assertEquals(AccountResult.Failed("short-code"), account.confirmForgotPassword("ada@example.invalid", "12a456", "a new password"))
        pool.answers["ConfirmForgotPassword"] = IdpAnswer.Refused("CodeMismatchException")
        assertEquals(AccountResult.Failed("wrong-code"), account.confirmForgotPassword("ada@example.invalid", "123456", "a new password"))
        pool.answers["ConfirmForgotPassword"] = IdpAnswer.Refused("ExpiredCodeException")
        assertEquals(AccountResult.Failed("expired-code"), account.confirmForgotPassword("ada@example.invalid", "123456", "a new password"))
        pool.answers.remove("ConfirmForgotPassword")
        assertEquals(AccountResult.Ok(Unit), account.confirmForgotPassword("Ada@example.invalid", "123456", "a new password"))
        val reset = pool.calls.last().second
        assertEquals("ada@example.invalid", text(reset, "Username"))
        assertEquals("123456", text(reset, "ConfirmationCode"))
        assertEquals("customerclient", text(reset, "ClientId"))
    }
}
