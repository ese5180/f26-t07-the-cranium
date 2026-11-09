package com.craniumiot.cranium.core

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** One sign-in for everybody (customer-core.js signInEither): the team's pool first, then the customer pool. */
class OneSignInTest {
    /** A pool that knows one address and password, and counts the tries. */
    private class Pool(val email: String, val password: String, val then: SignInStep) : OneSignIn.Attempt {
        var tries = 0
        override suspend fun signIn(email: String, password: String): SignInStep {
            tries += 1
            if (email.isEmpty() || password.isEmpty()) return SignInStep.Password("missing")
            return if (email.trim().lowercase() == this.email && password == this.password) then else SignInStep.Password("wrong-password")
        }
    }

    private fun pools() = Pool("manager@example.invalid", "team pw", SignInStep.Code) to
        Pool("ada@example.invalid", "her pw", SignInStep.Done(CognitoTokens("A", null, null, 3600)))

    @Test
    fun `a team account is taken by the team pool, with its code next, and the customer pool is never asked`() = runTest {
        val (team, customer) = pools()
        assertEquals(SignInAccount.TEAM to SignInStep.Code, OneSignIn.first(team, customer, "manager@example.invalid", "team pw"))
        assertEquals(1 to 0, team.tries to customer.tries)
    }

    @Test
    fun `a customer is refused by the team pool and signed in by the customer pool, one try each`() = runTest {
        val (team, customer) = pools()
        val (account, step) = OneSignIn.first(team, customer, "ada@example.invalid", "her pw")
        assertEquals(SignInAccount.CUSTOMER, account)
        assertTrue(step is SignInStep.Done)
        assertEquals(1 to 1, team.tries to customer.tries)
    }

    @Test
    fun `a wrong password and an unknown address get the same words, with one try at each pool`() = runTest {
        for ((email, password) in listOf("manager@example.invalid" to "x", "ada@example.invalid" to "x", "nobody@example.invalid" to "x")) {
            val (team, customer) = pools()
            assertEquals(SignInStep.Password("wrong-password"), OneSignIn.first(team, customer, email, password).second)
            assertEquals(1 to 1, team.tries to customer.tries)
        }
        assertEquals("The e-mail address or password is wrong.", SignInWords.words("wrong-password"))
        // The team pool's throttling stops there, with its own words.
        val throttled = OneSignIn.Attempt { _, _ -> SignInStep.Password("too-many") }
        val (_, customer) = pools()
        assertEquals(SignInAccount.TEAM to SignInStep.Password("too-many"), OneSignIn.first(throttled, customer, "a@b", "p"))
        assertEquals(0, customer.tries)
        // A build with one pool only: that one.
        assertEquals(SignInStep.Password("wrong-password"), OneSignIn.first(null, customer, "a@b", "p").second)
    }

    @Test
    fun `the address goes to the team pool in lower case, as users_sh keeps its names`() = runTest {
        val asked = mutableListOf<String>()
        val transport = IdpTransport { operation, body ->
            if (operation == "InitiateAuth") {
                asked += ((body["AuthParameters"] as JsonObject)["USERNAME"] as JsonPrimitive).content
            }
            IdpAnswer.Refused("NotAuthorizedException")
        }
        val team = CognitoSignIn(transport, "teamclient", "us-east-1_Team")
        val step = OneSignIn.first({ e, p -> team.passwordSignIn(e, p) }, null, "  Manager@Example.INVALID ", "pw").second
        assertEquals(SignInStep.Password("wrong-password"), step)
        assertEquals(listOf("manager@example.invalid"), asked)
    }

    /** A pool's reset: the team's hides unknown names (a code "went out", any code is wrong); the customer's knows Ada. */
    private class Reset(val knows: String?, val code: String) : IdpTransport {
        val calls = mutableListOf<Pair<String, String>>()
        override suspend fun call(operation: String, body: JsonObject): IdpAnswer {
            val user = (body["Username"] as JsonPrimitive).content
            calls += operation to user
            if (operation == "ForgotPassword") return IdpAnswer.Reply(JsonObject(emptyMap()), null)
            val given = (body["ConfirmationCode"] as JsonPrimitive).content
            return when {
                user == knows && given == code -> IdpAnswer.Reply(JsonObject(emptyMap()), null)
                user == knows && given == "999999" -> IdpAnswer.Refused("ExpiredCodeException")
                else -> IdpAnswer.Refused("CodeMismatchException")
            }
        }
    }

    @Test
    fun `forgot your password asks both pools once each, and says the same either way`() = runTest {
        val teamPool = Reset(knows = null, code = "")
        val customerPool = Reset(knows = "ada@example.invalid", code = "111111")
        val team = CustomerAccount(teamPool, "teamclient") { null }
        val customer = CustomerAccount(customerPool, "customerclient") { null }
        assertEquals(AccountResult.Failed("missing-email"), OneSignIn.forgotPassword(team, customer, " "))
        assertEquals(AccountResult.Ok(Unit), OneSignIn.forgotPassword(team, customer, " Ada@Example.invalid"))
        assertEquals(listOf("ForgotPassword" to "ada@example.invalid"), teamPool.calls)
        assertEquals(listOf("ForgotPassword" to "ada@example.invalid"), customerPool.calls)
        assertEquals(AccountResult.Failed("wrong-code"), OneSignIn.confirmForgotPassword(team, customer, "ada@example.invalid", "222222", "a new password"))
        assertEquals(AccountResult.Failed("expired-code"), OneSignIn.confirmForgotPassword(team, customer, "ada@example.invalid", "999999", "a new password"))
        assertEquals(AccountResult.Ok(Unit), OneSignIn.confirmForgotPassword(team, customer, "ada@example.invalid", "111111", "a new password"))
        assertEquals(4, teamPool.calls.size)
        assertEquals(4, customerPool.calls.size)
        // An address no pool has: the same answers.
        assertEquals(AccountResult.Ok(Unit), OneSignIn.forgotPassword(team, customer, "nobody@example.invalid"))
        assertEquals(AccountResult.Failed("wrong-code"), OneSignIn.confirmForgotPassword(team, customer, "nobody@example.invalid", "111111", "a new password"))
    }

    @Test
    fun `a team account's reset settles at the team pool`() = runTest {
        val teamPool = Reset(knows = "manager@example.invalid", code = "123456")
        val customerPool = Reset(knows = null, code = "")
        val result = OneSignIn.confirmForgotPassword(
            CustomerAccount(teamPool, "teamclient") { null },
            CustomerAccount(customerPool, "customerclient") { null },
            "manager@example.invalid", "123456", "a new password",
        )
        assertEquals(AccountResult.Ok(Unit), result)
        assertTrue(customerPool.calls.isEmpty())
        assertEquals("too-many", OneSignIn.plainest(listOf("wrong-code", "too-many")))
        assertEquals("wrong-code", OneSignIn.plainest(listOf("failed", "wrong-code")))
    }
}
