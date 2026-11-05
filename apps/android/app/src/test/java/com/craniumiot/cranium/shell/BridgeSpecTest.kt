package com.craniumiot.cranium.shell

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.longOrNull
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The bridge's table in this app (BridgeSpec) is apps/shared/bridge.json, method for method and
 * parameter for parameter, as the page's bridge.js and the iPhone app's are.
 */
class BridgeSpecTest {
    private val spec = Shared.json("bridge.json")

    private fun JsonObject.string(name: String) = (this[name] as JsonPrimitive).content

    @Test
    fun `the version, the origin and the limits are the contract's`() {
        assertEquals(BridgeSpec.VERSION.toLong(), (spec["bridge"] as JsonPrimitive).longOrNull)
        assertEquals(BridgeSpec.ORIGIN, (spec["origins"] as JsonObject).string("android"))
        assertEquals(BridgeSpec.MAX_REQUEST_BYTES.toLong(), ((spec["envelope"] as JsonObject)["maxRequestBytes"] as JsonPrimitive).longOrNull)
        assertEquals(BridgeSpec.ERRORS, (spec["errors"] as JsonObject).keys.toList())
        assertEquals(BridgeSpec.FEATURES, (spec["features"] as JsonArray).map { (it as JsonPrimitive).content })
        assertEquals(BridgeSpec.EVENTS.toSet(), (spec["events"] as JsonObject).keys)
    }

    @Test
    fun `every method and every parameter is the contract's`() {
        val methods = spec["methods"] as JsonObject
        assertEquals(methods.keys.toList(), BridgeSpec.METHODS.keys.toList())
        for ((name, value) in methods) {
            val method = value as JsonObject
            val ours = BridgeSpec.METHODS.getValue(name)
            val feature = (method["feature"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            assertEquals("$name: feature", feature, ours.feature)
            val params = method["params"] as JsonObject
            assertEquals("$name: parameters", params.keys, ours.params.keys)
            for ((param, described) in params) {
                assertEquals("$name.$param", fromContract(described as JsonObject), ours.params.getValue(param))
            }
        }
    }

    @Test
    fun `the policies are the contract's templates`() {
        val policies = spec["policies"] as JsonObject
        assertEquals(policies.string("console"), ShellPolicy.CONSOLE_TEMPLATE)
        assertEquals(policies.string("customer"), ShellPolicy.CUSTOMER_TEMPLATE)
    }

    private fun fromContract(param: JsonObject): ParamSpec {
        val optional = (param["optional"] as? JsonPrimitive)?.booleanOrNull ?: false
        fun number(name: String) = (param[name] as JsonPrimitive).longOrNull!!
        return when (param.string("type")) {
            "string" -> ParamSpec.Text(number("max").toInt(), (param["pattern"] as? JsonPrimitive)?.content, optional)
            "integer" -> ParamSpec.Whole(number("min"), number("max"), optional)
            "boolean" -> ParamSpec.Flag(optional)
            "enum" -> ParamSpec.OneOf((param["values"] as JsonArray).map { (it as JsonPrimitive).content }, optional)
            else -> error("unknown type in bridge.json")
        }
    }
}
