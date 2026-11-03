package com.craniumiot.cranium.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import java.util.Base64

/**
 * A change made from the phone needs a sign-in, with password and code, in the last 15 minutes
 * (docs/mobile-apps.md, "Signing in"); the API answers anything older with
 * `403 phone_sign_in_again`. The console reads the sign-in's time from the access token's
 * `auth_time`, which a refresh keeps, so the app reads it from there too and asks for the
 * sign-in before it tries, a little before the console would refuse.
 */
object FreshSignIn {
    const val CODE = "phone_sign_in_again"

    /** What the console allows: 15 minutes. */
    const val WINDOW_SECONDS = 15 * 60L

    /** What the app allows itself, so that a change is not refused on its way. */
    const val MARGIN_SECONDS = 60L

    private val json = Json { ignoreUnknownKeys = true }

    /** The `auth_time` claim of a JWT, in epoch seconds, or null if it has none or is not a JWT. */
    fun authTime(token: String?): Long? {
        val parts = token?.split('.') ?: return null
        if (parts.size != 3) return null
        val payload = runCatching { Base64.getUrlDecoder().decode(parts[1].padEnd((parts[1].length + 3) / 4 * 4, '=')) }
            .getOrNull() ?: return null
        val claims = runCatching { json.parseToJsonElement(payload.decodeToString()) }.getOrNull() as? JsonObject ?: return null
        return J.whole(claims["auth_time"], 1, 99_999_999_999)
    }

    /** Whether a sign-in at [authTime] (epoch seconds) is still recent enough for a change at [nowMs]. */
    fun isFresh(authTime: Long?, nowMs: Long): Boolean {
        if (authTime == null) return false
        val age = nowMs / 1000 - authTime
        return age >= -60 && age <= WINDOW_SECONDS - MARGIN_SECONDS
    }

    /** True for the console's refusal of a change from a phone whose sign-in is too old. */
    fun isRefusal(error: Throwable?): Boolean = error is ApiError && error.status == 403 && error.code == CODE
}
