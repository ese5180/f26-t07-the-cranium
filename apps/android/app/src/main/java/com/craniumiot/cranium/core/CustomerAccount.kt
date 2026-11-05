package com.craniumiot.cranium.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import java.util.Locale

/** What an account call came to: its value, or one of [CustomerAccount.WORDS]' keys. */
sealed interface AccountResult<out T> {
    data class Ok<T>(val value: T) : AccountResult<T>

    data class Failed(val problem: String) : AccountResult<Nothing>
}

/** Who is signed in, as Cognito has it, and whether sign-in asks for a code. */
data class CustomerProfile(val email: String, val name: String, val authenticator: Boolean)

/**
 * A customer's own account at Cognito (customer-core.js createAccount): the calls a signed-in person
 * makes with their own access token on the user pool API, and the reset of a forgotten password,
 * which needs none. Cognito's answer is the one that counts; the words never repeat Cognito's own
 * message. Passwords and codes are sent to Cognito and kept nowhere.
 *
 * @param accessToken the customer's current access token, or null when the session has ended
 */
class CustomerAccount(
    private val transport: IdpTransport,
    private val clientId: String,
    private val accessToken: suspend () -> String?,
) {
    private fun failed(answer: IdpAnswer, step: String): AccountResult.Failed = AccountResult.Failed(
        when (answer) {
            is IdpAnswer.Problem -> answer.problem
            is IdpAnswer.Refused -> problemOf(answer.name, step)
            is IdpAnswer.Reply -> "failed"
        },
    )

    private suspend fun withToken(operation: String, step: String, body: JsonObject = JsonObject(emptyMap())): AccountResult<JsonObject> {
        val token = accessToken() ?: return AccountResult.Failed("session-ended")
        val answer = transport.call(operation, JsonObject(mapOf("AccessToken" to JsonPrimitive(token)) + body))
        return if (answer is IdpAnswer.Reply) AccountResult.Ok(answer.body) else failed(answer, step)
    }

    /** E-mail, name, and whether sign-in asks for a code (SOFTWARE_TOKEN_MFA among the methods). */
    suspend fun profile(): AccountResult<CustomerProfile> {
        val answer = withToken("GetUser", "profile")
        if (answer !is AccountResult.Ok) return answer as AccountResult.Failed
        val attributes = (answer.value["UserAttributes"] as? JsonArray).orEmpty()
        fun value(name: String): String = attributes.firstNotNullOfOrNull { item ->
            val entry = item as? JsonObject ?: return@firstNotNullOfOrNull null
            if (J.str(entry["Name"]) == name) J.str(entry["Value"]) else null
        }.orEmpty()
        val methods = (answer.value["UserMFASettingList"] as? JsonArray).orEmpty().mapNotNull { J.str(it) }
        return AccountResult.Ok(CustomerProfile(value("email").take(320), CustomerJson.label(value("name")), "SOFTWARE_TOKEN_MFA" in methods))
    }

    suspend fun changePassword(current: String, next: String): AccountResult<Unit> {
        if (current.isEmpty()) return AccountResult.Failed("wrong-password")
        val answer = withToken(
            "ChangePassword", "change",
            buildJsonObject {
                put("PreviousPassword", current)
                put("ProposedPassword", next)
            },
        )
        return if (answer is AccountResult.Ok) AccountResult.Ok(Unit) else answer as AccountResult.Failed
    }

    /** The secret of a new authenticator app. */
    suspend fun startAuthenticator(): AccountResult<String> {
        val answer = withToken("AssociateSoftwareToken", "authenticator")
        if (answer !is AccountResult.Ok) return answer as AccountResult.Failed
        val secret = J.str(answer.value["SecretCode"])
        return if (secret != null && SECRET.matches(secret)) AccountResult.Ok(secret) else AccountResult.Failed("failed")
    }

    /** The first code from the new authenticator: once it is right, sign-in asks for a code. */
    suspend fun confirmAuthenticator(code: String): AccountResult<Unit> {
        if (!SIX.matches(code)) return AccountResult.Failed("short-code")
        val verified = withToken(
            "VerifySoftwareToken", "authenticator",
            buildJsonObject {
                put("UserCode", code)
                put("FriendlyDeviceName", "Cranium")
            },
        )
        if (verified !is AccountResult.Ok) return verified as AccountResult.Failed
        if (J.str(verified.value["Status"]) != "SUCCESS") return AccountResult.Failed("wrong-code")
        val set = withToken("SetUserMFAPreference", "authenticator", mfa(true))
        return if (set is AccountResult.Ok) AccountResult.Ok(Unit) else set as AccountResult.Failed
    }

    suspend fun stopAuthenticator(): AccountResult<Unit> {
        val answer = withToken("SetUserMFAPreference", "authenticator", mfa(false))
        return if (answer is AccountResult.Ok) AccountResult.Ok(Unit) else answer as AccountResult.Failed
    }

    private fun mfa(on: Boolean) = buildJsonObject {
        putJsonObject("SoftwareTokenMfaSettings") {
            put("Enabled", on)
            put("PreferredMfa", on)
        }
    }

    /**
     * Ask for the code of a password reset. Cognito sends it to the address, and answers alike
     * whether or not the address has an account: the screen says the same either way.
     */
    suspend fun forgotPassword(email: String): AccountResult<Unit> {
        val username = email.trim().lowercase(Locale.ROOT)
        if (username.isEmpty()) return AccountResult.Failed("missing-email")
        val answer = transport.call(
            "ForgotPassword",
            buildJsonObject {
                put("ClientId", clientId)
                put("Username", username)
            },
        )
        return if (answer is IdpAnswer.Reply) AccountResult.Ok(Unit) else failed(answer, "forgot")
    }

    suspend fun confirmForgotPassword(email: String, code: String, password: String): AccountResult<Unit> {
        if (!SIX.matches(code)) return AccountResult.Failed("short-code")
        val answer = transport.call(
            "ConfirmForgotPassword",
            buildJsonObject {
                put("ClientId", clientId)
                put("Username", email.trim().lowercase(Locale.ROOT))
                put("ConfirmationCode", code)
                put("Password", password)
            },
        )
        return if (answer is IdpAnswer.Reply) AccountResult.Ok(Unit) else failed(answer, "reset")
    }

    companion object {
        const val PASSWORD_MIN = 10
        private val SECRET = Regex("^[A-Z2-7]{16,128}$")
        private val SIX = Regex("^\\d{6}$")

        /** customer-core.js ACCOUNT_WORDS, word for word. */
        val WORDS: Map<String, String> = mapOf(
            "wrong-password" to "The current password is not right.",
            "weak-password" to "That password is not accepted. Choose one of at least 10 characters.",
            "too-short" to "A password needs at least 10 characters.",
            "mismatch" to "The two new passwords are not the same.",
            "missing-email" to "Type the e-mail address you sign in with.",
            "wrong-code" to "That code is not right. Check it and try again.",
            "expired-code" to "That code has expired. Ask for a new one.",
            "short-code" to "Type all six digits of the code.",
            "too-many" to "Too many tries. Wait a few minutes, then try again.",
            "not-yet" to "This account still has the temporary password from its invitation. Sign in with that one first.",
            "network" to "The sign-in service could not be reached. Check the connection and try again.",
            "session-ended" to "Your session has ended. Sign in again, then try once more.",
            "failed" to "That did not work. Try again in a moment.",
        )

        fun words(problem: String?): String = WORDS[problem] ?: WORDS.getValue("failed")

        /** What an error of Cognito's means here (customer-core.js accountProblem): a key of [WORDS]. */
        fun problemOf(name: String, step: String = ""): String = when (name) {
            "NotAuthorizedException" -> when (step) {
                "change" -> "wrong-password"
                "forgot" -> "not-yet"
                else -> "session-ended"
            }
            "InvalidPasswordException" -> "weak-password"
            "CodeMismatchException", "EnableSoftwareTokenMFAException" -> "wrong-code"
            "ExpiredCodeException" -> "expired-code"
            "LimitExceededException", "TooManyRequestsException", "TooManyFailedAttemptsException" -> "too-many"
            else -> "failed"
        }

        /** A new password as it was typed twice: null if it will do, else a key of [WORDS]. */
        fun passwordProblem(password: String, again: String): String? = when {
            password.length < PASSWORD_MIN -> "too-short"
            password != again -> "mismatch"
            else -> null
        }

        /** The secret of an authenticator app in groups of four, as people copy it by hand. */
        fun groupSecret(secret: String?): String =
            if (secret != null && SECRET.matches(secret)) secret.chunked(4).joinToString(" ") else ""

        /** The address that opens an authenticator app on this phone with the account filled in. */
        fun otpauthUri(secret: String?, email: String?): String? {
            if (secret == null || !SECRET.matches(secret)) return null
            val account = encodeUriComponent("Cranium:${email.orEmpty().take(254)}")
            return "otpauth://totp/$account?secret=$secret&issuer=Cranium"
        }

        /** JavaScript's encodeURIComponent: UTF-8, every byte escaped but A-Z a-z 0-9 - _ . ! ~ * ' ( ). */
        fun encodeUriComponent(text: String): String {
            val out = StringBuilder()
            for (byte in text.toByteArray(Charsets.UTF_8)) {
                val c = (byte.toInt() and 0xff).toChar()
                if (c in 'A'..'Z' || c in 'a'..'z' || c in '0'..'9' || c in "-_.!~*'()") out.append(c)
                else out.append('%').append("%02X".format(byte.toInt() and 0xff))
            }
            return out.toString()
        }
    }
}
