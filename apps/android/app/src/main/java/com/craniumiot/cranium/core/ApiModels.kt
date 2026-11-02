package com.craniumiot.cranium.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.longOrNull

/** One firmware release, from `GET /api/firmware`. Only the fields the app uses. */
@Serializable
data class Release(
    val version: String,
    val size: Long,
    val sha256: String,
    val status: String,
    val uploadedAt: String = "",
    val notes: String = "",
) {
    val isActive: Boolean get() = status == "active"
}

/** `GET /api/firmware`: the releases, newest first, and the size of an image slot. */
data class ReleaseList(val releases: List<Release>, val slotSize: Long?)

/** `GET /api/me`. `canWrite` is true for a release manager. */
@Serializable
data class Me(
    val email: String = "",
    val groups: List<String> = emptyList(),
    val canWrite: Boolean = false,
)

/** `GET /api/pairing/{name}`: the passkey a board shows while a phone pairs with it. */
@Serializable
data class Pairing(
    val thing: String,
    val name: String,
    val passkey: String,
    val reportedAt: String = "",
)

/** The part of `GET /api/devices/{thing}` the app shows after an upload. */
@Serializable
data class Device(
    val thing: String = "",
    val online: Boolean = false,
    val fw: DeviceFirmware? = null,
)

@Serializable
data class DeviceFirmware(val version: String = "", val confirmed: Boolean = false)

@Serializable
private data class DeviceAnswer(val device: Device)

@Serializable
private data class ErrorAnswer(val error: ErrorDetail)

@Serializable
private data class ErrorDetail(val code: String = "", val message: String = "")

/** An error the console answered with: `{"error": {"code", "message"}}` and an HTTP status. */
class ApiError(val status: Int, val code: String, message: String) : Exception(message)

/** Decoding of the console's answers (docs/mobile-apps.md, "The API"). */
object ApiJson {
    private val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
    }

    /**
     * The release list. A release that cannot be read is left out rather than failing the
     * whole list; the filters further on leave out what is not active or has no version.
     */
    fun releases(text: String): ReleaseList {
        val root = json.parseToJsonElement(text) as? JsonObject
            ?: throw IllegalArgumentException("The release list is not a JSON object")
        val items = root["releases"] as? JsonArray
            ?: throw IllegalArgumentException("The answer has no release list")
        val releases = items.mapNotNull { item ->
            runCatching { json.decodeFromJsonElement<Release>(item) }.getOrNull()
        }
        val slotSize = (root["slotSize"] as? JsonPrimitive)?.longOrNull
        return ReleaseList(releases, slotSize)
    }

    fun me(text: String): Me = json.decodeFromString(text)

    fun pairing(text: String): Pairing = json.decodeFromString(text)

    fun device(text: String): Device = json.decodeFromString<DeviceAnswer>(text).device

    /**
     * The error for an answer with [status] and [body]. Shows the console's own message, and for
     * a 403 also what to do about it.
     */
    fun error(status: Int, body: String): ApiError {
        val detail = runCatching { json.decodeFromString<ErrorAnswer>(body).error }.getOrNull()
        val message = detail?.message?.trim().orEmpty().ifEmpty { "The console answered with HTTP $status." }
        val text = if (status == 403) "$message Only a release manager can do this: ask an administrator for the role." else message
        return ApiError(status, detail?.code.orEmpty(), text)
    }
}
