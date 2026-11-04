package com.craniumiot.cranium.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import java.security.SecureRandom
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale

/** What one call of Cognito's user pool API came to. */
sealed class IdpAnswer {
    /** An answer, and the Date header that came with it (Cognito's clock), if any. */
    data class Reply(val body: JsonObject, val date: String?) : IdpAnswer()

    /** A refusal: Cognito's error type, such as NotAuthorizedException; '' if it does not say. */
    data class Refused(val name: String) : IdpAnswer()

    /** No usable answer: "network" or "failed". */
    data class Problem(val problem: String) : IdpAnswer()
}

/** One call of Cognito's user pool API: `operation` goes in X-Amz-Target, `body` is the request. */
fun interface IdpTransport {
    suspend fun call(operation: String, body: JsonObject): IdpAnswer
}

/** The tokens at the end of a sign-in or a refresh. A refresh may come without a new refresh token. */
data class CognitoTokens(val accessToken: String, val idToken: String?, val refreshToken: String?, val expiresIn: Long)

/** Where a sign-in stands after a step. */
sealed class SignInStep {
    /** The password checked out: the six digits from the authenticator app are next. */
    data object Code : SignInStep()

    data class Done(val tokens: CognitoTokens) : SignInStep()

    /** A step only the AWS sign-in page does, by Cognito's name for it. */
    data class Elsewhere(val challenge: String) : SignInStep()

    /** Back at the password, with a key of [SignInWords.WORDS]. */
    data class Password(val problem: String) : SignInStep()

    /** Still at the code, with a key of [SignInWords.WORDS]. */
    data class CodeProblem(val problem: String) : SignInStep()
}

/** What a refresh came to. [Ended]: the refresh token is no longer taken, so the person signs in again. */
sealed class Refreshed {
    data class Ok(val tokens: CognitoTokens) : Refreshed()
    data object Ended : Refreshed()
    data class Failed(val problem: String) : Refreshed()
}

/**
 * The app's own sign-in, as the console's own page does it (cloud/web/src/site/assets/core.js,
 * passwordSignIn and sendCode): Cognito's USER_SRP_AUTH, the proof of the password
 * ([Srp]), then the code from the authenticator app. The password is used for the proof and
 * nothing else: it is not kept and not sent. Cognito's session for the step of the code is kept
 * in memory only, in this object. It also refreshes and revokes tokens through the same API.
 */
class CognitoSignIn(
    private val transport: IdpTransport,
    private val clientId: String,
    private val userPoolId: String,
    private val now: () -> Long = System::currentTimeMillis,
    private val random: SecureRandom = SecureRandom(),
) {
    private class Challenge(val session: String, val userId: String)

    // The step that waits for the code: Cognito's session for it, and whom it is for.
    private var challenge: Challenge? = null

    val waitingForCode: Boolean get() = challenge != null

    /** Drop a sign-in that waits for its code. */
    fun cancel() {
        challenge = null
    }

    /**
     * Sign in with an e-mail address and a password: USER_SRP_AUTH, then the answer to
     * PASSWORD_VERIFIER. Returns where the sign-in stands.
     */
    suspend fun passwordSignIn(email: String, password: String): SignInStep {
        challenge = null
        val username = email.trim().lowercase(Locale.ROOT)
        if (username.isEmpty() || password.isEmpty()) return SignInStep.Password("missing")
        val start = Srp.start(random)
        val started = transport.call(
            "InitiateAuth",
            buildJsonObject {
                put("AuthFlow", "USER_SRP_AUTH")
                put("ClientId", clientId)
                putJsonObject("AuthParameters") {
                    put("USERNAME", username)
                    put("SRP_A", start.A.toString(16))
                }
            },
        )
        if (started !is IdpAnswer.Reply) return refused(started, atCode = false)
        val reply = started.body
        if (text(reply["ChallengeName"]) != "PASSWORD_VERIFIER") return following(reply, atCode = false, userId = null)

        val parameters = reply["ChallengeParameters"] as? JsonObject ?: JsonObject(emptyMap())
        val userId = text(parameters["USER_ID_FOR_SRP"]).orEmpty()
        val secretBlock = text(parameters["SECRET_BLOCK"]).orEmpty()
        // Cognito's clock, where its answer says it, or else the phone's.
        val timestamp = Srp.timestamp(cognitoTime(started.date) ?: now())
        val signature = try {
            Srp.claim(
                userPoolId = userPoolId,
                userId = userId,
                password = password,
                a = start.a,
                A = start.A,
                srpB = text(parameters["SRP_B"]).orEmpty(),
                salt = text(parameters["SALT"]).orEmpty(),
                secretBlock = secretBlock,
                timestamp = timestamp,
            )
        } catch (e: Srp.Unusable) {
            return SignInStep.Password("failed")
        }
        val session = text(reply["Session"])?.takeIf { it.isNotEmpty() }
        val verified = transport.call(
            "RespondToAuthChallenge",
            buildJsonObject {
                put("ChallengeName", "PASSWORD_VERIFIER")
                put("ClientId", clientId)
                putJsonObject("ChallengeResponses") {
                    put("USERNAME", userId)
                    put("PASSWORD_CLAIM_SECRET_BLOCK", secretBlock)
                    put("TIMESTAMP", timestamp)
                    put("PASSWORD_CLAIM_SIGNATURE", signature)
                }
                if (session != null) put("Session", session)
            },
        )
        if (verified !is IdpAnswer.Reply) return refused(verified, atCode = false)
        return following(verified.body, atCode = false, userId = userId)
    }

    /**
     * The code from the authenticator app, for the sign-in that asked for it. A wrong code leaves
     * that sign-in waiting for another; a sign-in that Cognito has ended starts again.
     */
    suspend fun sendCode(code: String): SignInStep {
        val waiting = challenge ?: return SignInStep.Password("expired")
        if (!CODE.matches(code)) return SignInStep.CodeProblem("wrong-code")
        val answered = transport.call(
            "RespondToAuthChallenge",
            buildJsonObject {
                put("ChallengeName", "SOFTWARE_TOKEN_MFA")
                put("ClientId", clientId)
                put("Session", waiting.session)
                putJsonObject("ChallengeResponses") {
                    put("USERNAME", waiting.userId)
                    put("SOFTWARE_TOKEN_MFA_CODE", code)
                }
            },
        )
        if (answered !is IdpAnswer.Reply) return refused(answered, atCode = true)
        return following(answered.body, atCode = true, userId = waiting.userId)
    }

    /** New tokens for a refresh token: InitiateAuth REFRESH_TOKEN_AUTH. */
    suspend fun refresh(refreshToken: String): Refreshed {
        val answer = transport.call(
            "InitiateAuth",
            buildJsonObject {
                put("AuthFlow", "REFRESH_TOKEN_AUTH")
                put("ClientId", clientId)
                putJsonObject("AuthParameters") { put("REFRESH_TOKEN", refreshToken) }
            },
        )
        return when (answer) {
            is IdpAnswer.Reply -> tokensOf(answer.body["AuthenticationResult"] as? JsonObject)?.let { Refreshed.Ok(it) }
                ?: Refreshed.Failed("failed")
            // A refresh token that is revoked or expired, or an account that is disabled or gone.
            is IdpAnswer.Refused -> when (answer.name) {
                "NotAuthorizedException", "UserNotFoundException" -> Refreshed.Ended
                else -> Refreshed.Failed(if (SignInWords.problem(answer.name, atCode = false) == "too-many") "too-many" else "failed")
            }
            is IdpAnswer.Problem -> Refreshed.Failed(answer.problem)
        }
    }

    /** End a refresh token, and the access tokens made with it: RevokeToken. True if Cognito answered. */
    suspend fun revoke(refreshToken: String): Boolean = transport.call(
        "RevokeToken",
        buildJsonObject {
            put("Token", refreshToken)
            put("ClientId", clientId)
        },
    ) is IdpAnswer.Reply

    /** Where a refusal leaves the sign-in. */
    private fun refused(answer: IdpAnswer, atCode: Boolean): SignInStep {
        val problem = when (answer) {
            is IdpAnswer.Problem -> return at(atCode, answer.problem)
            is IdpAnswer.Refused -> SignInWords.problem(answer.name, atCode)
            is IdpAnswer.Reply -> "failed"
        }
        if (problem == "elsewhere") return SignInStep.Elsewhere("PASSWORD_RESET_REQUIRED")
        if (problem == "expired") {
            challenge = null
            return SignInStep.Password(problem)
        }
        return at(atCode, problem)
    }

    private fun at(atCode: Boolean, problem: String): SignInStep =
        if (atCode) SignInStep.CodeProblem(problem) else SignInStep.Password(problem)

    /** What follows an answer: the code, the tokens, or a step for the AWS sign-in page. */
    private fun following(reply: JsonObject, atCode: Boolean, userId: String?): SignInStep {
        val result = reply["AuthenticationResult"]
        if (result is JsonObject) {
            val tokens = tokensOf(result) ?: return at(atCode, "failed")
            challenge = null
            return SignInStep.Done(tokens)
        }
        val name = text(reply["ChallengeName"])?.takeIf { CHALLENGE_NAME.matches(it) }.orEmpty()
        val session = text(reply["Session"]).orEmpty()
        if (name == "SOFTWARE_TOKEN_MFA" && session.isNotEmpty() && userId != null) {
            challenge = Challenge(session, userId)
            return SignInStep.Code
        }
        challenge = null
        // A new password, an authenticator app to set up, or anything else this screen does not do.
        return if (name.isEmpty()) at(atCode, "failed") else SignInStep.Elsewhere(name)
    }

    private companion object {
        val CODE = Regex("^\\d{6}$")
        val CHALLENGE_NAME = Regex("^[A-Z_]{1,40}$")

        fun text(value: kotlinx.serialization.json.JsonElement?): String? =
            (value as? JsonPrimitive)?.takeIf { it.isString }?.content

        /** Tokens as the website's usable() takes them: an access token, a lifetime, and the bearer type. */
        fun tokensOf(result: JsonObject?): CognitoTokens? {
            if (result == null) return null
            val access = text(result["AccessToken"])?.takeIf { it.isNotEmpty() } ?: return null
            val expiresIn = J.long(result["ExpiresIn"])?.takeIf { it > 0 } ?: return null
            if (text(result["TokenType"])?.lowercase(Locale.ROOT) != "bearer") return null
            return CognitoTokens(
                accessToken = access,
                idToken = text(result["IdToken"])?.takeIf { it.isNotEmpty() },
                refreshToken = text(result["RefreshToken"])?.takeIf { it.isNotEmpty() },
                expiresIn = expiresIn,
            )
        }

        /** The time in a Date header (RFC 1123), or null. */
        fun cognitoTime(date: String?): Long? = date?.let {
            runCatching { ZonedDateTime.parse(it.trim(), DateTimeFormatter.RFC_1123_DATE_TIME).toInstant().toEpochMilli() }.getOrNull()
        }
    }
}

/**
 * What went wrong with a sign-in on the app's own screen, in words (core.js SIGN_IN_WORDS). Never
 * Cognito's own message: the same words whether the account exists or not.
 */
object SignInWords {
    val WORDS: Map<String, String> = mapOf(
        "wrong-password" to "The e-mail address or password is wrong.",
        "wrong-code" to "That code is not right. Try the next one from your authenticator app.",
        "expired" to "The sign-in took too long, so it starts again. Enter your password once more.",
        "too-many" to "Too many tries. Wait a minute.",
        "network" to "The sign-in service could not be reached. Check the connection and try again.",
        "failed" to "Signing in did not work. Try again, or use the AWS sign-in page.",
        "missing" to "Enter your e-mail address and your password.",
        "short-code" to "Type all six digits of the code.",
    )

    /** Why a sign-in goes to the AWS sign-in page (app.js ELSEWHERE_WORDS). */
    val ELSEWHERE: Map<String, String> = mapOf(
        "NEW_PASSWORD_REQUIRED" to "Your account needs a new password first, and the AWS sign-in page asks for it.",
        "MFA_SETUP" to "Your account needs an authenticator app first, and the AWS sign-in page sets one up.",
        "PASSWORD_RESET_REQUIRED" to "Your password has to be reset first.",
    )

    const val ELSEWHERE_OTHER = "Your account needs a step that only that page does."

    private val NAME = Regex("^[A-Za-z]{1,64}$")

    /** What Cognito's error answer is called, from its __type or the x-amzn-errortype header; '' if it does not say. */
    fun errorName(type: String?, header: String?): String {
        val raw = type ?: header.orEmpty()
        val name = raw.substringAfterLast('#').substringBefore(':')
        return if (NAME.matches(name)) name else ""
    }

    /**
     * What an error of Cognito's means at the password ([atCode] false) or at the code: a key of
     * [WORDS], or "elsewhere" for what only the AWS sign-in page can do. After the password,
     * NotAuthorizedException is Cognito ending the sign-in: its session is over.
     */
    fun problem(name: String, atCode: Boolean): String = when (name) {
        "NotAuthorizedException", "UserNotFoundException" -> if (atCode) "expired" else "wrong-password"
        "CodeMismatchException" -> if (atCode) "wrong-code" else "failed"
        "ExpiredCodeException" -> "expired"
        "TooManyRequestsException", "LimitExceededException", "TooManyFailedAttemptsException" -> "too-many"
        "PasswordResetRequiredException" -> "elsewhere"
        else -> "failed"
    }

    fun words(problem: String): String = WORDS[problem] ?: WORDS.getValue("failed")
}

/** The six digits of an authenticator code, as one hidden field holds them. */
object CodeEntry {
    const val LENGTH = 6

    /** The digits only, at most six: what typing, a paste or the phone filling in the code leaves. */
    fun digits(text: String): String = text.filter { it in '0'..'9' }.take(LENGTH)

    fun complete(digits: String): Boolean = digits.length == LENGTH && digits.all { it in '0'..'9' }
}
