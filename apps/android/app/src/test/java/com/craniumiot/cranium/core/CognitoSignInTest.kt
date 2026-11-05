package com.craniumiot.cranium.core

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.math.BigInteger
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Base64
import java.util.Locale
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * The app's own sign-in against a stand-in for Cognito's user pool API. The stand-in plays the
 * server's half of SRP and checks every claim with its own maths, written apart from Srp.kt (after
 * cloud/web/test/cognito.mjs): numbers as Java's BigInteger.toByteArray() writes them,
 * v = g^x, B = k*v + g^b, S = (A * v^u)^b, the key by its own HKDF, and the HMAC.
 */
class CognitoSignInTest {

    /** [afterNew]: what follows a first sign-in's new password: the tokens (null), or the code. */
    private data class User(
        val email: String,
        val userId: String,
        val password: String,
        val code: String,
        val next: String = "SOFTWARE_TOKEN_MFA",
        val afterNew: String? = null,
    )

    /** Cognito, as far as the app's own sign-in uses it. */
    private class FakeCognito(
        val userPoolId: String,
        val clientId: String,
        users: List<User>,
        var now: () -> Long,
        var dateHeader: () -> String? = { null },
    ) : IdpTransport {
        private val N = BigInteger(
            "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DD" +
                "EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED" +
                "EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F" +
                "83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B" +
                "E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA0510" +
                "15728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7" +
                "ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200C" +
                "BBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF",
            16,
        )
        private val g = BigInteger.valueOf(2)
        private val random = SecureRandom()
        private fun h(vararg parts: ByteArray): ByteArray {
            val digest = MessageDigest.getInstance("SHA-256")
            for (part in parts) digest.update(part)
            return digest.digest()
        }
        private fun num(bytes: ByteArray) = BigInteger(1, bytes)
        private val k = num(h(N.toByteArray(), g.toByteArray()))
        private val poolName = userPoolId.split('_')[1]

        private class Account(val user: User, val salt: BigInteger, val verifier: BigInteger)
        private class Exchange(val account: Account?, val userId: String, val verifier: BigInteger, val A: BigInteger, val b: BigInteger, @get:JvmName("getPublicB") val B: BigInteger)
        private class Session(val user: User, val expiresAt: Long, var tries: Int = 0)

        private val accounts = users.associate { user ->
            val salt = num(ByteArray(16).also(random::nextBytes))
            val x = num(h(salt.toByteArray(), h("$poolName${user.userId}:${user.password}".toByteArray(Charsets.UTF_8))))
            user.email.lowercase() to Account(user, salt, g.modPow(x, N))
        }
        private val exchanges = mutableMapOf<String, Exchange>()
        private val sessions = mutableMapOf<String, Session>()
        val refreshTokens = mutableMapOf<String, User>()
        val revoked = mutableListOf<String>()
        val calls = mutableListOf<Pair<String, JsonObject>>()
        var failNext: String? = null
        var networkDown = false
        var rotateRefresh = false
        private var issued = 0

        private fun s(value: kotlinx.serialization.json.JsonElement?) = (value as? JsonPrimitive)?.content
        private fun obj(value: kotlinx.serialization.json.JsonElement?) = value as? JsonObject ?: JsonObject(emptyMap())
        private fun ok(body: JsonObject) = IdpAnswer.Reply(body, dateHeader())
        private fun hmac(key: ByteArray, vararg parts: ByteArray): ByteArray {
            val mac = Mac.getInstance("HmacSHA256")
            mac.init(SecretKeySpec(key, "HmacSHA256"))
            for (part in parts) mac.update(part)
            return mac.doFinal()
        }

        private fun tokens(user: User): JsonObject {
            issued += 1
            val refresh = "REFRESH-$issued"
            refreshTokens[refresh] = user
            return buildJsonObject {
                putJsonObject("AuthenticationResult") {
                    put("AccessToken", "ACCESS-$issued")
                    put("IdToken", "ID-$issued")
                    put("RefreshToken", refresh)
                    put("ExpiresIn", 3600)
                    put("TokenType", "Bearer")
                }
            }
        }

        /** The instant a claim's timestamp names, or null if it is not written as Cognito writes it. */
        private fun timestampAt(text: String): Long? {
            if (!Regex("^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([1-9]|[12]\\d|3[01]) \\d\\d:\\d\\d:\\d\\d UTC \\d{4}$").matches(text)) return null
            return runCatching {
                java.time.ZonedDateTime.parse(text.replace(" UTC ", " +0000 "), DateTimeFormatter.ofPattern("EEE MMM d HH:mm:ss Z yyyy", Locale.US))
                    .toInstant().toEpochMilli()
            }.getOrNull()
        }

        override suspend fun call(operation: String, body: JsonObject): IdpAnswer {
            calls += operation to body
            if (networkDown) return IdpAnswer.Problem("network")
            failNext?.let { name ->
                failNext = null
                return IdpAnswer.Refused(name)
            }
            if (s(body["ClientId"]) != clientId) return IdpAnswer.Refused("ResourceNotFoundException")
            return when (operation) {
                "InitiateAuth" -> initiate(body)
                "RespondToAuthChallenge" -> when (s(body["ChallengeName"])) {
                    "PASSWORD_VERIFIER" -> verifyPassword(body)
                    "SOFTWARE_TOKEN_MFA" -> verifyCode(body)
                    "NEW_PASSWORD_REQUIRED" -> verifyNewPassword(body)
                    else -> IdpAnswer.Refused("InvalidParameterException")
                }
                "RevokeToken" -> {
                    val token = s(body["Token"]).orEmpty()
                    revoked += token
                    refreshTokens.remove(token)
                    ok(JsonObject(emptyMap()))
                }
                else -> IdpAnswer.Refused("UnknownOperationException")
            }
        }

        private fun initiate(body: JsonObject): IdpAnswer {
            val parameters = obj(body["AuthParameters"])
            when (s(body["AuthFlow"])) {
                "REFRESH_TOKEN_AUTH" -> {
                    val user = refreshTokens[s(parameters["REFRESH_TOKEN"])] ?: return IdpAnswer.Refused("NotAuthorizedException")
                    issued += 1
                    return ok(
                        buildJsonObject {
                            putJsonObject("AuthenticationResult") {
                                put("AccessToken", "ACCESS-$issued")
                                put("IdToken", "ID-$issued")
                                if (rotateRefresh) {
                                    put("RefreshToken", "REFRESH-$issued")
                                    refreshTokens["REFRESH-$issued"] = user
                                }
                                put("ExpiresIn", 3600)
                                put("TokenType", "Bearer")
                            }
                        },
                    )
                }
                "USER_SRP_AUTH" -> Unit
                else -> return IdpAnswer.Refused("InvalidParameterException")
            }
            val username = s(parameters["USERNAME"]) ?: return IdpAnswer.Refused("InvalidParameterException")
            val A = BigInteger(s(parameters["SRP_A"]) ?: return IdpAnswer.Refused("InvalidParameterException"), 16)
            if (A.mod(N).signum() == 0) return IdpAnswer.Refused("NotAuthorizedException")
            val account = accounts[username]
            // An address nobody has gets a challenge that nothing can answer.
            val salt = account?.salt ?: num(ByteArray(16).also(random::nextBytes))
            val verifier = account?.verifier ?: g.modPow(num(ByteArray(32).also(random::nextBytes)), N)
            val userId = account?.user?.userId ?: "unknown-${random.nextInt(1_000_000)}"
            val b = num(ByteArray(32).also(random::nextBytes))
            val B = k.multiply(verifier).add(g.modPow(b, N)).mod(N)
            val block = Base64.getEncoder().encodeToString(ByteArray(96).also(random::nextBytes))
            exchanges[block] = Exchange(account, userId, verifier, A, b, B)
            return ok(
                buildJsonObject {
                    put("ChallengeName", "PASSWORD_VERIFIER")
                    putJsonObject("ChallengeParameters") {
                        put("SALT", salt.toString(16))
                        put("SECRET_BLOCK", block)
                        put("SRP_B", B.toString(16))
                        put("USERNAME", userId)
                        put("USER_ID_FOR_SRP", userId)
                    }
                },
            )
        }

        private fun verifyPassword(body: JsonObject): IdpAnswer {
            val answer = obj(body["ChallengeResponses"])
            val block = s(answer["PASSWORD_CLAIM_SECRET_BLOCK"]).orEmpty()
            val exchange = exchanges.remove(block) ?: return IdpAnswer.Refused("NotAuthorizedException")
            val at = timestampAt(s(answer["TIMESTAMP"]).orEmpty()) ?: return IdpAnswer.Refused("NotAuthorizedException")
            if (Math.abs(at - now()) > 5 * 60_000) return IdpAnswer.Refused("NotAuthorizedException")
            val u = num(h(exchange.A.toByteArray(), exchange.B.toByteArray()))
            val S = exchange.A.multiply(exchange.verifier.modPow(u, N)).mod(N).modPow(exchange.b, N)
            val prk = hmac(u.toByteArray(), S.toByteArray())
            val key = hmac(prk, "Caldera Derived Key".toByteArray(), byteArrayOf(1)).copyOf(16)
            val expected = Base64.getEncoder().encodeToString(
                hmac(key, poolName.toByteArray(), exchange.userId.toByteArray(), Base64.getDecoder().decode(block), s(answer["TIMESTAMP"])!!.toByteArray()),
            )
            if (exchange.account == null || s(answer["USERNAME"]) != exchange.userId || s(answer["PASSWORD_CLAIM_SIGNATURE"]) != expected) {
                return IdpAnswer.Refused("NotAuthorizedException")
            }
            val user = exchange.account.user
            val session = "SESSION-${random.nextInt(1_000_000)}"
            sessions[session] = Session(user, now() + 15 * 60_000)
            return ok(
                buildJsonObject {
                    put("ChallengeName", user.next)
                    put("Session", session)
                    putJsonObject("ChallengeParameters") {}
                },
            )
        }

        private fun verifyCode(body: JsonObject): IdpAnswer {
            val id = s(body["Session"]).orEmpty()
            val session = sessions[id]
            if (session == null || session.expiresAt <= now()) {
                sessions.remove(id)
                return IdpAnswer.Refused("NotAuthorizedException")
            }
            val answer = obj(body["ChallengeResponses"])
            if (s(answer["USERNAME"]) != session.user.userId) return IdpAnswer.Refused("NotAuthorizedException")
            if (s(answer["SOFTWARE_TOKEN_MFA_CODE"]) != session.user.code) {
                session.tries += 1
                if (session.tries >= 3) sessions.remove(id)
                return IdpAnswer.Refused("CodeMismatchException")
            }
            sessions.remove(id)
            return ok(tokens(session.user))
        }

        /** A first sign-in's new password: at least 10 characters, as the customer pool asks. */
        val newPasswords = mutableListOf<String>()

        private fun verifyNewPassword(body: JsonObject): IdpAnswer {
            val id = s(body["Session"]).orEmpty()
            val session = sessions[id]
            if (session == null || session.expiresAt <= now() || session.user.next != "NEW_PASSWORD_REQUIRED") {
                sessions.remove(id)
                return IdpAnswer.Refused("NotAuthorizedException")
            }
            val answer = obj(body["ChallengeResponses"])
            if (s(answer["USERNAME"]) != session.user.userId) return IdpAnswer.Refused("NotAuthorizedException")
            val chosen = s(answer["NEW_PASSWORD"]).orEmpty()
            if (chosen.length < 10) return IdpAnswer.Refused("InvalidPasswordException")
            sessions.remove(id)
            newPasswords += chosen
            if (session.user.afterNew == "SOFTWARE_TOKEN_MFA") {
                val next = "SESSION-${random.nextInt(1_000_000)}"
                sessions[next] = Session(session.user.copy(next = "SOFTWARE_TOKEN_MFA"), now() + 15 * 60_000)
                return ok(
                    buildJsonObject {
                        put("ChallengeName", "SOFTWARE_TOKEN_MFA")
                        put("Session", next)
                        putJsonObject("ChallengeParameters") {}
                    },
                )
            }
            return ok(tokens(session.user))
        }
    }

    private val pool = "xx-test-1_Pool0Tests"
    private val client = "client-1"
    private val nowMs = Instant.parse("2026-11-02T03:04:05Z").toEpochMilli()
    // Made up for these tests: a reserved domain that cannot receive mail.
    private val user = User("person@example.invalid", "6f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b", "Correct-Horse-B4ttery", "246810")

    private fun setup(users: List<User> = listOf(user), phoneNow: Long = nowMs, cognitoNow: Long = nowMs): Pair<FakeCognito, CognitoSignIn> {
        val cognito = FakeCognito(pool, client, users, { cognitoNow })
        return cognito to CognitoSignIn(cognito, client, pool, now = { phoneNow })
    }

    @Test
    fun `password, then the code, then the tokens`() = runTest {
        val (cognito, signIn) = setup()
        assertEquals(SignInStep.Code, signIn.passwordSignIn("  Person@Example.INVALID ", user.password))
        assertTrue(signIn.waitingForCode)
        val done = signIn.sendCode(user.code) as SignInStep.Done
        assertTrue(done.tokens.accessToken.startsWith("ACCESS-"))
        assertTrue(done.tokens.refreshToken!!.startsWith("REFRESH-"))
        assertEquals(3600L, done.tokens.expiresIn)
        assertFalse(signIn.waitingForCode)
        // What went where: the address in lower case, A in hex, the proof under Cognito's user ID.
        val (op1, first) = cognito.calls[0]
        assertEquals("InitiateAuth", op1)
        assertEquals("USER_SRP_AUTH", (first["AuthFlow"] as JsonPrimitive).content)
        val params = first["AuthParameters"] as JsonObject
        assertEquals("person@example.invalid", (params["USERNAME"] as JsonPrimitive).content)
        assertTrue(Regex("^[0-9a-f]+$").matches((params["SRP_A"] as JsonPrimitive).content))
        val (op2, second) = cognito.calls[1]
        assertEquals("RespondToAuthChallenge", op2)
        val responses = second["ChallengeResponses"] as JsonObject
        assertEquals(user.userId, (responses["USERNAME"] as JsonPrimitive).content)
        assertEquals("Mon Nov 2 03:04:05 UTC 2026", (responses["TIMESTAMP"] as JsonPrimitive).content)
        // The password is never sent, in any call.
        for ((_, body) in cognito.calls) assertFalse(body.toString().contains(user.password))
        val third = cognito.calls[2].second
        assertEquals("SOFTWARE_TOKEN_MFA", (third["ChallengeName"] as JsonPrimitive).content)
        assertEquals(user.code, ((third["ChallengeResponses"] as JsonObject)["SOFTWARE_TOKEN_MFA_CODE"] as JsonPrimitive).content)
    }

    @Test
    fun `a wrong password, or an address nobody has, is the same wrong-password`() = runTest {
        val (_, signIn) = setup()
        assertEquals(SignInStep.Password("wrong-password"), signIn.passwordSignIn(user.email, "${user.password}x"))
        assertEquals(SignInStep.Password("wrong-password"), signIn.passwordSignIn("nobody@example.invalid", user.password))
        assertFalse(signIn.waitingForCode)
    }

    @Test
    fun `a wrong code keeps the sign-in waiting, and the right one then goes through`() = runTest {
        val (_, signIn) = setup()
        signIn.passwordSignIn(user.email, user.password)
        assertEquals(SignInStep.CodeProblem("wrong-code"), signIn.sendCode("135791"))
        assertTrue(signIn.waitingForCode)
        assertEquals(SignInStep.CodeProblem("wrong-code"), signIn.sendCode("12345"))
        assertTrue(signIn.sendCode(user.code) is SignInStep.Done)
    }

    @Test
    fun `a code without a sign-in waiting for it, or after Cognito ended it, starts again`() = runTest {
        var cognitoNow = nowMs
        val cognito = FakeCognito(pool, client, listOf(user), { cognitoNow })
        val signIn = CognitoSignIn(cognito, client, pool, now = { nowMs })
        assertEquals(SignInStep.Password("expired"), signIn.sendCode(user.code))
        signIn.passwordSignIn(user.email, user.password)
        cognitoNow += 16 * 60_000
        assertEquals(SignInStep.Password("expired"), signIn.sendCode(user.code))
        assertFalse(signIn.waitingForCode)
        assertEquals(SignInStep.Password("expired"), signIn.sendCode(user.code))
    }

    @Test
    fun `a step only the AWS sign-in page does goes there, by its name`() = runTest {
        val newPassword = user.copy(email = "new@example.invalid", next = "NEW_PASSWORD_REQUIRED")
        val (cognito, signIn) = setup(listOf(user, newPassword))
        assertEquals(SignInStep.Elsewhere("NEW_PASSWORD_REQUIRED"), signIn.passwordSignIn(newPassword.email, newPassword.password))
        assertFalse(signIn.waitingForCode)
        cognito.failNext = "PasswordResetRequiredException"
        assertEquals(SignInStep.Elsewhere("PASSWORD_RESET_REQUIRED"), signIn.passwordSignIn(user.email, user.password))
    }

    @Test
    fun `a customer's first sign-in chooses the new password on the screen, then signs in`() = runTest {
        val invited = user.copy(email = "ada@example.invalid", userId = "ada-id", next = "NEW_PASSWORD_REQUIRED")
        val cognito = FakeCognito(pool, client, listOf(invited), { nowMs })
        val signIn = CognitoSignIn(cognito, client, pool, now = { nowMs }, newPasswordHere = true)
        assertEquals(SignInStep.NewPassword, signIn.passwordSignIn(invited.email, invited.password))
        assertTrue(signIn.waitingForNewPassword)
        assertFalse(signIn.waitingForCode)
        // The code is not what this sign-in waits for.
        assertEquals(SignInStep.Password("expired"), signIn.sendCode("123456"))
        assertEquals(SignInStep.NewPassword, signIn.passwordSignIn(invited.email, invited.password))
        assertEquals(SignInStep.NewPasswordProblem("missing-new"), signIn.sendNewPassword(""))
        assertEquals(SignInStep.NewPasswordProblem("weak-password"), signIn.sendNewPassword("short"))
        assertTrue(signIn.waitingForNewPassword)
        val done = signIn.sendNewPassword("a good long password") as SignInStep.Done
        assertTrue(done.tokens.accessToken.startsWith("ACCESS-"))
        assertEquals(listOf("a good long password"), cognito.newPasswords)
        val call = cognito.calls.last().second
        assertEquals("NEW_PASSWORD_REQUIRED", (call["ChallengeName"] as JsonPrimitive).content)
        assertEquals("ada-id", ((call["ChallengeResponses"] as JsonObject)["USERNAME"] as JsonPrimitive).content)
        // The temporary password itself is never sent: only its proof.
        for ((_, body) in cognito.calls) assertFalse(body.toString().contains(invited.password))
        assertEquals(SignInStep.Password("expired"), signIn.sendNewPassword("a good long password"))
    }

    @Test
    fun `a new password can be followed by the code, and the staff sign-in leaves it to the AWS page`() = runTest {
        val invited = user.copy(email = "ben@example.invalid", userId = "ben-id", next = "NEW_PASSWORD_REQUIRED", afterNew = "SOFTWARE_TOKEN_MFA")
        val cognito = FakeCognito(pool, client, listOf(invited), { nowMs })
        val customer = CognitoSignIn(cognito, client, pool, now = { nowMs }, newPasswordHere = true)
        assertEquals(SignInStep.NewPassword, customer.passwordSignIn(invited.email, invited.password))
        assertEquals(SignInStep.Code, customer.sendNewPassword("another long password"))
        assertTrue(customer.sendCode(invited.code) is SignInStep.Done)
        val staff = CognitoSignIn(cognito, client, pool, now = { nowMs })
        assertEquals(SignInStep.Elsewhere("NEW_PASSWORD_REQUIRED"), staff.passwordSignIn(invited.email, invited.password))
        assertEquals(SignInStep.Password("expired"), staff.sendNewPassword("another long password"))
    }

    @Test
    fun `at the new password, Cognito's answers are the website's signInProblem`() {
        assertEquals("expired", SignInWords.problemAt("NotAuthorizedException", "new-password"))
        assertEquals("weak-password", SignInWords.problemAt("InvalidPasswordException", "new-password"))
        assertEquals("failed", SignInWords.problemAt("InvalidPasswordException", "password"))
        assertEquals("wrong-password", SignInWords.problemAt("UserNotFoundException", "password"))
        assertEquals("failed", SignInWords.problemAt("CodeMismatchException", "new-password"))
        assertEquals("That password is not accepted. Choose one of at least 10 characters.", SignInWords.WORDS["weak-password"])
    }

    @Test
    fun `no connection is said as such, and Cognito's own refusals in the console's words`() = runTest {
        val (cognito, signIn) = setup()
        cognito.networkDown = true
        assertEquals(SignInStep.Password("network"), signIn.passwordSignIn(user.email, user.password))
        cognito.networkDown = false
        cognito.failNext = "TooManyRequestsException"
        assertEquals(SignInStep.Password("too-many"), signIn.passwordSignIn(user.email, user.password))
        signIn.passwordSignIn(user.email, user.password)
        cognito.networkDown = true
        assertEquals(SignInStep.CodeProblem("network"), signIn.sendCode(user.code))
        assertTrue("a code that did not get through can be sent again", signIn.waitingForCode)
        cognito.networkDown = false
        assertTrue(signIn.sendCode(user.code) is SignInStep.Done)
    }

    @Test
    fun `the time in the proof is Cognito's, from its Date header, not the phone's`() = runTest {
        // The phone's clock is 20 minutes slow; Cognito says the time in its answer.
        val cognito = FakeCognito(pool, client, listOf(user), { nowMs })
        cognito.dateHeader = { DateTimeFormatter.RFC_1123_DATE_TIME.format(Instant.ofEpochMilli(nowMs).atZone(ZoneOffset.UTC)) }
        val slow = CognitoSignIn(cognito, client, pool, now = { nowMs - 20 * 60_000 })
        assertEquals(SignInStep.Code, slow.passwordSignIn(user.email, user.password))
        // Without the header, the slow clock's time is refused by Cognito.
        cognito.dateHeader = { null }
        assertEquals(SignInStep.Password("wrong-password"), slow.passwordSignIn(user.email, user.password))
        // An unreadable header falls back on the phone's clock.
        cognito.dateHeader = { "not a date" }
        val right = CognitoSignIn(cognito, client, pool, now = { nowMs })
        assertEquals(SignInStep.Code, right.passwordSignIn(user.email, user.password))
    }

    @Test
    fun `nothing is asked without an address and a password`() = runTest {
        val (cognito, signIn) = setup()
        assertEquals(SignInStep.Password("missing"), signIn.passwordSignIn("  ", user.password))
        assertEquals(SignInStep.Password("missing"), signIn.passwordSignIn(user.email, ""))
        assertTrue(cognito.calls.isEmpty())
    }

    @Test
    fun `an answer without usable tokens is a failure, not a sign-in`() = runTest {
        val transport = IdpTransport { _, _ ->
            IdpAnswer.Reply(
                buildJsonObject {
                    putJsonObject("AuthenticationResult") {
                        put("AccessToken", "x")
                        put("ExpiresIn", 0)
                        put("TokenType", "Bearer")
                    }
                },
                null,
            )
        }
        val signIn = CognitoSignIn(transport, client, pool, now = { nowMs })
        assertEquals(SignInStep.Password("failed"), signIn.passwordSignIn(user.email, user.password))
        val noChallenge = CognitoSignIn(IdpTransport { _, _ -> IdpAnswer.Reply(JsonObject(emptyMap()), null) }, client, pool, now = { nowMs })
        assertEquals(SignInStep.Password("failed"), noChallenge.passwordSignIn(user.email, user.password))
    }

    @Test
    fun `a challenge that cannot be used is not answered`() = runTest {
        var calls = 0
        val transport = IdpTransport { _, _ ->
            calls += 1
            IdpAnswer.Reply(
                buildJsonObject {
                    put("ChallengeName", "PASSWORD_VERIFIER")
                    putJsonObject("ChallengeParameters") {
                        put("SALT", "beef")
                        put("SECRET_BLOCK", "AAAA")
                        put("SRP_B", "0")
                        put("USER_ID_FOR_SRP", "someone")
                    }
                },
                null,
            )
        }
        val signIn = CognitoSignIn(transport, client, pool, now = { nowMs })
        assertEquals(SignInStep.Password("failed"), signIn.passwordSignIn(user.email, user.password))
        assertEquals(1, calls)
    }

    @Test
    fun `a refresh gives new tokens, with or without a new refresh token, and ends with the refresh token`() = runTest {
        val (cognito, signIn) = setup()
        signIn.passwordSignIn(user.email, user.password)
        val first = (signIn.sendCode(user.code) as SignInStep.Done).tokens
        val again = signIn.refresh(first.refreshToken!!) as Refreshed.Ok
        assertTrue(again.tokens.accessToken.startsWith("ACCESS-"))
        assertNull("no new refresh token: the old one stays", again.tokens.refreshToken)
        val refresh = cognito.calls.last().second
        assertEquals("REFRESH_TOKEN_AUTH", (refresh["AuthFlow"] as JsonPrimitive).content)
        assertEquals(first.refreshToken, ((refresh["AuthParameters"] as JsonObject)["REFRESH_TOKEN"] as JsonPrimitive).content)
        cognito.rotateRefresh = true
        val rotated = signIn.refresh(first.refreshToken) as Refreshed.Ok
        assertTrue(rotated.tokens.refreshToken!!.startsWith("REFRESH-"))

        assertTrue(signIn.revoke(first.refreshToken))
        assertEquals(listOf(first.refreshToken), cognito.revoked)
        assertEquals(Refreshed.Ended, signIn.refresh(first.refreshToken))
        cognito.networkDown = true
        assertEquals(Refreshed.Failed("network"), signIn.refresh("REFRESH-anything"))
        assertFalse(signIn.revoke("REFRESH-anything"))
        cognito.networkDown = false
        cognito.failNext = "TooManyRequestsException"
        assertEquals(Refreshed.Failed("too-many"), signIn.refresh("REFRESH-anything"))
        cognito.failNext = "InternalErrorException"
        assertEquals(Refreshed.Failed("failed"), signIn.refresh("REFRESH-anything"))
    }

    @Test
    fun `every answer of Cognito is put in the console's words`() {
        val table = listOf(
            Triple("NotAuthorizedException", false, "wrong-password"),
            Triple("UserNotFoundException", false, "wrong-password"),
            Triple("NotAuthorizedException", true, "expired"),
            Triple("CodeMismatchException", true, "wrong-code"),
            Triple("ExpiredCodeException", true, "expired"),
            Triple("TooManyRequestsException", false, "too-many"),
            Triple("LimitExceededException", true, "too-many"),
            Triple("TooManyFailedAttemptsException", true, "too-many"),
            Triple("PasswordResetRequiredException", false, "elsewhere"),
            Triple("InternalErrorException", false, "failed"),
            Triple("", true, "failed"),
        )
        for ((name, atCode, problem) in table) assertEquals("$name at code=$atCode", problem, SignInWords.problem(name, atCode))
        assertEquals("That code is not right. Try the next one from your authenticator app.", SignInWords.WORDS["wrong-code"])
        assertEquals("Too many tries. Wait a minute.", SignInWords.WORDS["too-many"])
        for (words in SignInWords.WORDS.values) assertFalse(words.contains("Exception") || words.contains("Cognito"))
        assertEquals(SignInWords.WORDS["failed"], SignInWords.words("anything else"))

        assertEquals("NotAuthorizedException", SignInWords.errorName("NotAuthorizedException", null))
        assertEquals("UnknownOperationException", SignInWords.errorName("com.amazon.coral.service#UnknownOperationException", null))
        assertEquals("CodeMismatchException", SignInWords.errorName(null, "CodeMismatchException:http://internal.amazon.com/coral/"))
        assertEquals("", SignInWords.errorName("<script>", null))
        assertEquals("", SignInWords.errorName(null, null))
        assertEquals("Your password has to be reset first.", SignInWords.ELSEWHERE["PASSWORD_RESET_REQUIRED"])
    }

    @Test
    fun `the one field of the code keeps six digits and nothing else`() {
        assertEquals("123456", CodeEntry.digits("12 34 56"))
        assertEquals("123456", CodeEntry.digits("1234567"))
        assertEquals("12", CodeEntry.digits("a1b2"))
        assertEquals("", CodeEntry.digits("code"))
        assertTrue(CodeEntry.complete("246810"))
        assertFalse(CodeEntry.complete("24681"))
        assertFalse(CodeEntry.complete("24681a"))
    }
}
