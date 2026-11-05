package com.craniumiot.cranium.shell

import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/** A parameter of a bridge method, as apps/shared/bridge.json describes it. */
sealed interface ParamSpec {
    val optional: Boolean

    data class Text(val max: Int, val pattern: String? = null, override val optional: Boolean = false) : ParamSpec {
        val regex: Regex? by lazy { pattern?.let(::Regex) }
    }

    data class Whole(val min: Long, val max: Long, override val optional: Boolean = false) : ParamSpec

    data class Flag(override val optional: Boolean = false) : ParamSpec

    data class OneOf(val values: List<String>, override val optional: Boolean = false) : ParamSpec
}

data class MethodSpec(val feature: String?, val params: Map<String, ParamSpec> = emptyMap())

/**
 * The bridge between the shell and the pages of the bundle, version 1: apps/shared/bridge.json, which
 * BridgeSpecTest reads and compares with this table. A method that is not here does not exist, and a
 * parameter that is not here, of another type or out of its range, is refused with bad_request before
 * any handler runs.
 */
object BridgeSpec {
    const val VERSION = 1
    const val MAX_REQUEST_BYTES = 4_194_304
    const val ORIGIN = "https://appassets.androidplatform.net"

    val FEATURES = listOf("auth", "biometric", "ble", "clipboard", "haptics", "share", "open", "keepAwake", "settings", "appUpdate")
    val ERRORS = listOf("bad_request", "unknown_method", "unavailable", "not_allowed", "cancelled", "locked", "signed_out", "busy", "network", "failed")
    val EVENTS = listOf("app.lifecycle", "app.bundleReady", "auth.locked", "ble.boards", "ble.link", "ble.progress", "ble.status")

    private val pool = ParamSpec.OneOf(listOf("admin", "customer"))
    private const val VERSION_PATTERN = """^\d{1,3}\.\d{1,3}\.\d{1,5}\+\d{1,10}$"""

    val METHODS: Map<String, MethodSpec> = linkedMapOf(
        "app.hello" to MethodSpec(null),
        "app.config" to MethodSpec(null),
        "app.ready" to MethodSpec(null),
        "app.reload" to MethodSpec(null),
        "app.open" to MethodSpec("open", mapOf("url" to ParamSpec.Text(4096))),
        "app.settings" to MethodSpec("settings"),
        "app.keepAwake" to MethodSpec("keepAwake", mapOf("on" to ParamSpec.Flag())),
        "auth.store" to MethodSpec(
            "auth",
            mapOf(
                "pool" to pool,
                "refreshToken" to ParamSpec.Text(8192),
                "accessToken" to ParamSpec.Text(8192),
                "idToken" to ParamSpec.Text(8192, optional = true),
                "expiresIn" to ParamSpec.Whole(1, 86400),
            ),
        ),
        "auth.session" to MethodSpec("auth", mapOf("pool" to pool)),
        "auth.signOut" to MethodSpec("auth", mapOf("pool" to pool)),
        "biometric.status" to MethodSpec("biometric", mapOf("pool" to pool)),
        "biometric.set" to MethodSpec("biometric", mapOf("pool" to pool, "enabled" to ParamSpec.Flag())),
        "clipboard.write" to MethodSpec(
            "clipboard",
            mapOf("text" to ParamSpec.Text(1024), "expiresIn" to ParamSpec.Whole(1, 600, optional = true)),
        ),
        "haptics.play" to MethodSpec(
            "haptics",
            mapOf("kind" to ParamSpec.OneOf(listOf("success", "warning", "error", "selection", "impact"))),
        ),
        "file.share" to MethodSpec(
            "share",
            mapOf(
                "name" to ParamSpec.Text(100, "^[A-Za-z0-9][A-Za-z0-9._ -]{0,99}$"),
                "type" to ParamSpec.OneOf(listOf("text/csv", "application/json", "text/plain", "application/pdf")),
                "data" to ParamSpec.Text(11_184_812),
            ),
        ),
        "ble.state" to MethodSpec("ble"),
        "ble.scan" to MethodSpec("ble", mapOf("on" to ParamSpec.Flag())),
        "ble.connect" to MethodSpec("ble", mapOf("id" to ParamSpec.Text(64, "^[A-Za-z0-9:-]{1,64}$"))),
        "ble.images" to MethodSpec("ble"),
        "ble.upload" to MethodSpec(
            "ble",
            mapOf("image" to ParamSpec.Text(3_495_256), "sha256" to ParamSpec.Text(64, "^[0-9a-f]{64}$")),
        ),
        "ble.cancel" to MethodSpec("ble"),
        "ble.status" to MethodSpec("ble"),
        "ble.disconnect" to MethodSpec("ble"),
        "ble.watch" to MethodSpec(
            "ble",
            mapOf(
                "on" to ParamSpec.Flag(),
                "version" to ParamSpec.Text(40, VERSION_PATTERN, optional = true),
                "hash" to ParamSpec.Text(16, "^[0-9a-f]{16}$", optional = true),
            ),
        ),
        "update.check" to MethodSpec("appUpdate"),
        "update.install" to MethodSpec("appUpdate"),
    )
}

/** A refusal that goes back to the page as {ok: false, error: {code, message}}. */
class BridgeError(val code: String, message: String) : Exception(message)

data class BridgeRequest(val id: Long, val method: String, val params: JsonObject)

/** The envelope of the bridge: reading requests, checking parameters, writing answers and events. */
object BridgeProtocol {
    private val json = Json { isLenient = false }
    private val METHOD = Regex("^[a-zA-Z]{1,20}\\.[a-zA-Z]{1,30}$")
    private val ID_IN_TEXT = Regex("\"id\"\\s*:\\s*(\\d{1,10})")

    sealed interface Parsed {
        data class Ok(val request: BridgeRequest) : Parsed

        /** Not a request that can be done; answered with [id] when the request had a readable one. */
        data class Bad(val id: Long?, val error: BridgeError) : Parsed
    }

    fun parse(text: String): Parsed {
        if (text.length > BridgeSpec.MAX_REQUEST_BYTES || text.toByteArray(Charsets.UTF_8).size > BridgeSpec.MAX_REQUEST_BYTES) {
            val id = ID_IN_TEXT.find(text.take(200))?.groupValues?.get(1)?.toLongOrNull()?.takeIf(::isId)
            return Parsed.Bad(id, BridgeError("bad_request", "The request is larger than the bridge takes."))
        }
        val root = runCatching { json.parseToJsonElement(text) }.getOrNull() as? JsonObject
            ?: return Parsed.Bad(null, BridgeError("bad_request", "Not a request of this bridge."))
        val id = whole(root["id"])?.takeIf(::isId)
            ?: return Parsed.Bad(null, BridgeError("bad_request", "The request has no id."))
        if (whole(root["v"]) != BridgeSpec.VERSION.toLong()) return Parsed.Bad(id, BridgeError("bad_request", "Not a request of this bridge's version."))
        val method = (root["method"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { METHOD.matches(it) }
            ?: return Parsed.Bad(id, BridgeError("bad_request", "The request names no method."))
        val params = root["params"] as? JsonObject ?: return Parsed.Bad(id, BridgeError("bad_request", "The request has no parameters."))
        return Parsed.Ok(BridgeRequest(id, method, params))
    }

    private fun isId(id: Long) = id in 1..2_147_483_647L

    /** Null when [params] fit [spec]; else what is wrong. */
    fun validate(spec: MethodSpec, params: JsonObject): BridgeError? {
        for (key in params.keys) if (key !in spec.params) return BridgeError("bad_request", "Unknown parameter: $key")
        for ((name, param) in spec.params) {
            val value = params[name]
            if (value == null || value is JsonNull) {
                if (param.optional) continue
                return BridgeError("bad_request", "Missing parameter: $name")
            }
            val problem = check(param, value) ?: continue
            return BridgeError("bad_request", "$name: $problem")
        }
        return null
    }

    private fun check(param: ParamSpec, value: JsonElement): String? {
        val primitive = value as? JsonPrimitive ?: return "not of its type"
        return when (param) {
            is ParamSpec.Text -> when {
                !primitive.isString -> "not text"
                primitive.content.length > param.max -> "too long"
                param.regex != null && !param.regex!!.matches(primitive.content) -> "not of its form"
                else -> null
            }
            is ParamSpec.Whole -> {
                val number = if (primitive.isString) null else primitive.longOrNull
                when {
                    number == null -> "not a whole number"
                    number < param.min || number > param.max -> "out of range"
                    else -> null
                }
            }
            is ParamSpec.Flag -> if (primitive.isString || primitive.booleanOrNull == null) "not true or false" else null
            is ParamSpec.OneOf -> if (!primitive.isString || primitive.content !in param.values) "not one of its values" else null
        }
    }

    private fun whole(element: JsonElement?): Long? = (element as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull

    fun ok(id: Long, result: JsonObject): String = buildJsonObject {
        put("id", id)
        put("ok", true)
        put("result", result)
    }.toString()

    fun error(id: Long, code: String, message: String): String = buildJsonObject {
        put("id", id)
        put("ok", false)
        put("error", buildJsonObject {
            put("code", code)
            put("message", message)
        })
    }.toString()

    fun event(name: String, data: JsonObject): String = buildJsonObject {
        put("event", name)
        put("data", data)
    }.toString()
}

typealias BridgeHandler = suspend (JsonObject) -> JsonObject

/**
 * Dispatch: a request is read, its method looked up, its feature checked against what this phone and
 * this app offer ([features]), its parameters checked against the table, and only then handed to the
 * handler registered for it. Whatever a handler throws becomes an error answer; nothing reaches the page
 * that the page did not ask for, but for events.
 */
class Bridge(private val features: () -> Set<String>) {
    private val handlers = HashMap<String, BridgeHandler>()

    fun register(method: String, handler: BridgeHandler) {
        require(method in BridgeSpec.METHODS) { "$method is not a method of the bridge" }
        handlers[method] = handler
    }

    val registered: Set<String> get() = handlers.keys

    /** The answer to [text], or null when it had no id to answer to. */
    suspend fun handle(text: String): String? {
        val request = when (val parsed = BridgeProtocol.parse(text)) {
            is BridgeProtocol.Parsed.Bad -> return parsed.id?.let { BridgeProtocol.error(it, parsed.error.code, parsed.error.message ?: "") }
            is BridgeProtocol.Parsed.Ok -> parsed.request
        }
        val spec = BridgeSpec.METHODS[request.method]
            ?: return BridgeProtocol.error(request.id, "unknown_method", "No method ${request.method} in this version of the bridge.")
        if (spec.feature != null && spec.feature !in features()) {
            return BridgeProtocol.error(request.id, "unavailable", "${request.method} is not on this phone.")
        }
        BridgeProtocol.validate(spec, request.params)?.let { return BridgeProtocol.error(request.id, it.code, it.message ?: "") }
        val handler = handlers[request.method]
            ?: return BridgeProtocol.error(request.id, "unavailable", "${request.method} is not in this app.")
        return try {
            BridgeProtocol.ok(request.id, handler(request.params))
        } catch (e: CancellationException) {
            throw e
        } catch (e: BridgeError) {
            BridgeProtocol.error(request.id, if (e.code in BridgeSpec.ERRORS) e.code else "failed", e.message ?: "")
        } catch (e: Exception) {
            BridgeProtocol.error(request.id, "failed", "Something went wrong in the app.")
        }
    }
}
