package com.craniumiot.cranium.shell

import com.craniumiot.cranium.core.BoardStatus
import com.craniumiot.cranium.core.FirmwareVersion
import com.craniumiot.cranium.core.ImageSlot
import com.craniumiot.cranium.core.McubootHeader
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.Base64

/** The checks and the shapes of the bridge's handlers that need no phone, so that they are tested on the JVM. */
object ShellChecks {
    /** What ble.upload takes at most: 2.5 MiB of image. */
    const val MAX_IMAGE_BYTES = 2_621_440

    /**
     * ble.upload's image: base64 that decodes, no larger than a board's slot can be, with the SHA-256 the
     * page gave and MCUboot's magic at the start. The page checked it against the console's release; this is
     * the app's own check that what it sends is what the page checked.
     */
    fun uploadImage(base64: String, sha256: String): ByteArray {
        val bytes = try {
            Base64.getDecoder().decode(base64)
        } catch (e: IllegalArgumentException) {
            throw BridgeError("bad_request", "image: not base64")
        }
        if (bytes.isEmpty() || bytes.size > MAX_IMAGE_BYTES) throw BridgeError("bad_request", "image: not the size of an image")
        if (BundleManifest.sha256Hex(bytes) != sha256) throw BridgeError("bad_request", "The image's SHA-256 is not the one given.")
        if (!McubootHeader.hasMagic(bytes)) throw BridgeError("bad_request", "That is not a signed MCUboot image.")
        return bytes
    }

    /**
     * ble.watch: a status read after the restart is followed only if its last update over Bluetooth is
     * [version] and, where both are known, of the image with [hash] (UpdateWatch.Facts.isAboutThisSend).
     */
    fun aboutThisSend(status: BoardStatus, version: String, hash: String?): Boolean {
        if (status.lastVia != BoardStatus.Via.BLUETOOTH) return false
        val theirs = status.lastTarget?.let(FirmwareVersion::parseRelease) ?: return false
        if (theirs != FirmwareVersion.parseRelease(version)) return false
        val board = status.lastHash ?: return true
        return hash == null || hash == board
    }

    /** One claim of a JWT's payload, as text; null when it is not a JWT or has no such claim. The signature is not checked here. */
    fun claim(token: String, name: String): String? {
        val parts = token.split('.')
        if (parts.size != 3) return null
        val payload = runCatching { Base64.getUrlDecoder().decode(parts[1].padEnd((parts[1].length + 3) / 4 * 4, '=')) }.getOrNull() ?: return null
        val claims = runCatching { Json.parseToJsonElement(payload.decodeToString()) as? JsonObject }.getOrNull() ?: return null
        return (claims[name] as? JsonPrimitive)?.takeIf { it.isString }?.content
    }

    /**
     * auth.store: the access token must be of the pool's phone client, as the app refreshes it with that
     * client; a token of any other client, or of another pool, is refused before anything is kept.
     */
    fun tokenFits(accessToken: String, clientId: String, userPoolId: String): Boolean {
        val client = claim(accessToken, "client_id") ?: return false
        val issuer = claim(accessToken, "iss") ?: return false
        return client == clientId && issuer.endsWith("/$userPoolId")
    }

    fun configJson(config: ShellConfig): JsonObject = buildJsonObject {
        put("consoleUrl", config.consoleUrl)
        put("region", config.region)
        put("userPoolId", config.userPoolId)
        put("mobileClientId", config.mobileClientId)
        put("customerApiUrl", config.customerApiUrl?.let(::JsonPrimitive) ?: JsonNull)
        put("customerRegion", config.customerRegion?.let(::JsonPrimitive) ?: JsonNull)
        put("customerUserPoolId", config.customerUserPoolId?.let(::JsonPrimitive) ?: JsonNull)
        put("customerClientId", config.customerClientId?.let(::JsonPrimitive) ?: JsonNull)
        put("example", config.example)
    }

    fun helloJson(
        version: String,
        build: Int,
        bundle: LaunchedBundle?,
        features: Collection<String>,
        needsNewerApp: Boolean,
    ): JsonObject = buildJsonObject {
        put("bridge", BridgeSpec.VERSION)
        put("platform", "android")
        put("shell", buildJsonObject {
            put("version", version)
            put("build", build.toString())
        })
        put("bundle", buildJsonObject {
            put("id", bundle?.manifest?.id?.let(::JsonPrimitive) ?: JsonNull)
            put("console", bundle?.manifest?.consoleVersion?.let(::JsonPrimitive) ?: JsonNull)
            put("source", bundle?.source?.word?.let(::JsonPrimitive) ?: JsonNull)
        })
        put("features", buildJsonArray { features.forEach { add(JsonPrimitive(it)) } })
        // The console's bundle needs a newer bridge: the app itself needs an update (bridge.json, "update").
        put("needsNewerApp", needsNewerApp)
    }

    /** ble.images: image 0's slots as the board lists them. */
    fun imagesJson(slots: List<ImageSlot>): JsonObject = buildJsonObject {
        put("images", JsonArray(slots.filter { it.image == 0 }.map { slot ->
            buildJsonObject {
                put("slot", slot.slot)
                put("version", slot.version)
                put("active", slot.active)
                put("confirmed", slot.confirmed)
                put("pending", slot.pending)
                put("permanent", slot.permanent)
            }
        }))
    }

    fun base64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)
}
