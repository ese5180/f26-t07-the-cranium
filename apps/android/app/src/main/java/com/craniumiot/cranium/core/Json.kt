package com.craniumiot.cranium.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.longOrNull
import java.time.Instant
import java.time.OffsetDateTime

/**
 * Reading the console's answers one field at a time, as the website does (core.js, "Reading API
 * replies"): a reply whose outline is wrong is an error, a single odd value becomes null or a
 * harmless default. Text that a board reported is cut down to printable ASCII.
 */
internal object J {
    fun obj(value: JsonElement?): JsonObject? = value as? JsonObject

    fun arr(value: JsonElement?): JsonArray? = value as? JsonArray

    fun str(value: JsonElement?): String? = (value as? JsonPrimitive)?.takeIf { it.isString }?.content

    fun text(value: JsonElement?, limit: Int = 200): String = str(value)?.take(limit) ?: ""

    fun optionalText(value: JsonElement?, limit: Int = 200): String? = str(value)?.takeIf { it.isNotEmpty() }?.take(limit)

    /** Text that originates on a board: printable ASCII only, and short. */
    fun boardText(value: JsonElement?, limit: Int = 96): String =
        str(value)?.map { if (it in ' '..'~') it else '?' }?.joinToString("")?.take(limit) ?: ""

    /** A whole number, as JSON writes one: not text, and without a fraction. */
    fun long(value: JsonElement?): Long? {
        val primitive = value as? JsonPrimitive ?: return null
        if (primitive.isString) return null
        primitive.longOrNull?.let { return it }
        // 12.0 is a whole number in JavaScript too.
        val double = primitive.content.toDoubleOrNull() ?: return null
        return if (double.isFinite() && double == Math.floor(double) && Math.abs(double) < 9.0e15) double.toLong() else null
    }

    fun whole(value: JsonElement?, least: Long, most: Long): Long? = long(value)?.takeIf { it in least..most }

    fun int(value: JsonElement?, least: Int, most: Int): Int? = long(value)?.takeIf { it in least..most }?.toInt()

    fun bool(value: JsonElement?): Boolean = (value as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull == true

    /** A time the console wrote (ISO 8601), or null. */
    fun instant(value: JsonElement?): String? = str(value)?.takeIf { Times.parse(it) != null }

    /** The strings in a list, each cut to a sensible length; anything else in it is left out. */
    fun texts(value: JsonElement?, limit: Int = 64): List<String> =
        arr(value)?.mapNotNull { str(it)?.take(limit) }.orEmpty()

    fun person(value: JsonElement?): Person? {
        val item = obj(value) ?: return null
        return Person(sub = text(item["sub"], 64), email = text(item["email"], 254))
    }
}

/** Times as the console writes them: ISO 8601, in UTC. */
object Times {
    /** Epoch milliseconds, or null for text that is not a time. */
    fun parse(text: String?): Long? {
        if (text.isNullOrBlank()) return null
        return runCatching { Instant.parse(text).toEpochMilli() }.getOrNull()
            ?: runCatching { OffsetDateTime.parse(text).toInstant().toEpochMilli() }.getOrNull()
    }

    /** As toISOString() writes it: 2026-11-02T14:30:00.000Z. */
    fun iso(ms: Long): String = Instant.ofEpochMilli(ms).toString().let { text ->
        // Instant.toString leaves out zero milliseconds; the API takes both, the website writes them.
        if (text.length == 20) text.dropLast(1) + ".000Z" else text
    }
}
