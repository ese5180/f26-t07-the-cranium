package com.craniumiot.cranium.shell

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Dispatch and the checks of every request, before any handler runs. */
class BridgeTest {
    private val calls = mutableListOf<String>()
    private var features = BridgeSpec.FEATURES.toSet()
    private val bridge = Bridge { features }.apply {
        register("app.hello") { buildJsonObject { put("bridge", 1) } }
        register("app.open") { params -> calls += "open ${params["url"]!!.jsonPrimitive.content}"; JsonObject(emptyMap()) }
        register("clipboard.write") { params -> calls += "copy ${params["text"]!!.jsonPrimitive.content}"; JsonObject(emptyMap()) }
        register("auth.session") { throw BridgeError("cancelled", "Cancelled.") }
        register("ble.scan") { throw IllegalStateException("inside") }
        register("ble.upload") { throw BridgeError("made_up", "A code that is not one.") }
        register("ble.watch") { params -> calls += "watch $params"; JsonObject(emptyMap()) }
        register("clipboard.write") { params -> calls += "copy ${params["text"]!!.jsonPrimitive.content}"; JsonObject(emptyMap()) }
        register("haptics.play") { JsonObject(emptyMap()) }
        register("auth.store") { JsonObject(emptyMap()) }
    }

    private fun ask(text: String): JsonObject? = runBlocking { bridge.handle(text) }?.let { Json.parseToJsonElement(it).jsonObject }

    private fun request(method: String, params: String = "{}", id: Long = 7) = """{"v":1,"id":$id,"method":"$method","params":$params}"""

    private fun error(answer: JsonObject?): String = answer!!["error"]!!.jsonObject["code"]!!.jsonPrimitive.content

    @Test
    fun `a request is answered by its handler, under its id`() {
        val answer = ask(request("app.hello", id = 41))!!
        assertEquals(41L, answer["id"]!!.jsonPrimitive.content.toLong())
        assertEquals(true, answer["ok"]!!.jsonPrimitive.content.toBoolean())
        assertEquals(1, answer["result"]!!.jsonObject["bridge"]!!.jsonPrimitive.content.toInt())
    }

    @Test
    fun `what is not a request of this bridge is refused or dropped`() {
        // No id to answer to: nothing goes back.
        assertNull(ask("not json"))
        assertNull(ask("""{"v":1,"method":"app.hello","params":{}}"""))
        assertNull(ask("""{"v":1,"id":0,"method":"app.hello","params":{}}"""))
        assertNull(ask("""{"v":1,"id":2147483648,"method":"app.hello","params":{}}"""))
        assertNull(ask("""{"v":1,"id":"7","method":"app.hello","params":{}}"""))
        // An id, but no request of version 1.
        assertEquals("bad_request", error(ask("""{"v":2,"id":7,"method":"app.hello","params":{}}""")))
        assertEquals("bad_request", error(ask("""{"id":7,"method":"app.hello","params":{}}""")))
        assertEquals("bad_request", error(ask("""{"v":1,"id":7,"method":"app.hello"}""")))
        assertEquals("bad_request", error(ask("""{"v":1,"id":7,"method":"app.hello","params":[]}""")))
        assertEquals("bad_request", error(ask("""{"v":1,"id":7,"method":"../../x","params":{}}""")))
    }

    @Test
    fun `a request larger than the bridge takes is refused, with its id`() {
        val big = "a".repeat(BridgeSpec.MAX_REQUEST_BYTES)
        val answer = ask("""{"v":1,"id":9,"method":"clipboard.write","params":{"text":"$big"}}""")
        assertEquals(9L, answer!!["id"]!!.jsonPrimitive.content.toLong())
        assertEquals("bad_request", error(answer))
        assertTrue(calls.isEmpty())
    }

    @Test
    fun `an unknown method, and one whose feature this phone lacks`() {
        assertEquals("unknown_method", error(ask(request("app.format"))))
        assertEquals("unknown_method", error(ask(request("shell.exec", """{"cmd":"rm"}"""))))
        // In the contract but not registered here.
        assertEquals("unavailable", error(ask(request("ble.state"))))
        features = features - "clipboard"
        assertEquals("unavailable", error(ask(request("clipboard.write", """{"text":"123456"}"""))))
        assertTrue(calls.isEmpty())
    }

    @Test
    fun `parameters are checked against the contract before the handler runs`() {
        val refused = listOf(
            "app.open" to "{}",
            "app.open" to """{"url":"https://example.com","target":"_blank"}""",
            "app.open" to """{"url":42}""",
            "app.open" to """{"url":"${"a".repeat(4097)}"}""",
            "clipboard.write" to """{"text":"123456","expiresIn":0}""",
            "clipboard.write" to """{"text":"123456","expiresIn":601}""",
            "clipboard.write" to """{"text":"123456","expiresIn":1.5}""",
            "clipboard.write" to """{"text":"123456","expiresIn":"60"}""",
            "clipboard.write" to """{"text":null}""",
            "haptics.play" to """{"kind":"explode"}""",
            "haptics.play" to """{"kind":["success"]}""",
            "ble.watch" to """{"on":"yes"}""",
            "ble.watch" to """{"on":true,"version":"1.13.0"}""",
            "ble.watch" to """{"on":true,"version":"1.13.0+0","hash":"DEADBEEF01020304"}""",
            "ble.upload" to """{"image":"AA==","sha256":"${"a".repeat(63)}"}""",
            "auth.store" to """{"pool":"root","refreshToken":"r","accessToken":"a","expiresIn":3600}""",
            "auth.store" to """{"pool":"admin","refreshToken":"r","accessToken":"a","expiresIn":0}""",
            "auth.store" to """{"pool":"admin","refreshToken":"r","accessToken":"a","expiresIn":86401}""",
        )
        for ((method, params) in refused) {
            assertEquals("$method $params", "bad_request", error(ask(request(method, params))))
        }
        assertTrue(calls.isEmpty())

        assertEquals(true, ask(request("clipboard.write", """{"text":"123456","expiresIn":120}"""))!!["ok"]!!.jsonPrimitive.content.toBoolean())
        // An optional parameter may be left out, or be null.
        assertEquals(true, ask(request("ble.watch", """{"on":false,"version":null}"""))!!["ok"]!!.jsonPrimitive.content.toBoolean())
        assertEquals(true, ask(request("ble.watch", """{"on":true,"version":"1.13.0+0","hash":"deadbeef01020304"}"""))!!["ok"]!!.jsonPrimitive.content.toBoolean())
        assertEquals(listOf("copy 123456"), calls.take(1))
    }

    @Test
    fun `what a handler throws becomes an error answer`() {
        val cancelled = ask(request("auth.session", """{"pool":"admin"}"""))!!
        assertEquals("cancelled", error(cancelled))
        assertEquals("Cancelled.", cancelled["error"]!!.jsonObject["message"]!!.jsonPrimitive.content)
        // Nothing of what went wrong inside reaches the page.
        val inside = ask(request("ble.scan", """{"on":true}"""))!!
        assertEquals("failed", error(inside))
        assertTrue("inside" !in inside.toString())
        // A code that is not the contract's is "failed".
        assertEquals("failed", error(ask(request("ble.upload", """{"image":"AA==","sha256":"${"a".repeat(64)}"}"""))))
    }

    @Test
    fun `only methods of the contract can be registered, and events have their shape`() {
        try {
            bridge.register("app.exec") { JsonObject(emptyMap()) }
            throw AssertionError("registered")
        } catch (e: IllegalArgumentException) {
            // As it should be.
        }
        val event = Json.parseToJsonElement(BridgeProtocol.event("ble.progress", buildJsonObject { put("sent", 1); put("total", 2) })).jsonObject
        assertEquals("ble.progress", event["event"]!!.jsonPrimitive.content)
        assertEquals(JsonPrimitive(2), event["data"]!!.jsonObject["total"])
    }
}
