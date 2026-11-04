package com.craniumiot.cranium.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.math.BigInteger

/**
 * The proof of a password against the website's own code. srp/vectors.json is made by
 * srp/make-vectors.mjs from cloud/web/src/site/assets/core.js (startSrp, srpKey, srpClaim, and its
 * srpHex and modPow for the steps it keeps to itself), so these numbers are the website's.
 */
class SrpTest {
    private data class Vector(
        val name: String,
        val userPoolId: String,
        val userId: String,
        val password: String,
        val a: String,
        @get:JvmName("getPublicA") val A: String,
        val B: String,
        val salt: String,
        val secretBlock: String,
        val timestampMs: Long,
        val timestamp: String,
        val u: String,
        val k: String,
        val x: String,
        val S: String,
        val key: String,
        val signature: String,
    )

    private val vectors: List<Vector> by lazy {
        val text = javaClass.classLoader!!.getResource("srp/vectors.json")!!.readText()
        val root = Json.parseToJsonElement(text) as JsonObject
        (root["vectors"] as JsonArray).map { item ->
            val v = item as JsonObject
            fun s(name: String) = v.getValue(name).jsonPrimitive.content
            Vector(
                s("name"), s("userPoolId"), s("userId"), s("password"), s("a"), s("A"), s("B"), s("salt"), s("secretBlock"),
                v.getValue("timestampMs").jsonPrimitive.long, s("timestamp"), s("u"), s("k"), s("x"), s("S"), s("key"),
                s("signature"),
            )
        }
    }

    private fun bytesOfHex(hex: String) = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    private fun hexOf(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }

    private fun big(hex: String) = BigInteger(hex, 16)

    @Test
    fun `every vector of the website gives the same A, u, k, x, S, key and signature`() {
        assertTrue("the vectors are there", vectors.size >= 3)
        for (v in vectors) {
            val start = Srp.start(bytesOfHex(v.a))
            assertEquals("${v.name}: a", big(v.a), start.a)
            assertEquals("${v.name}: A", big(v.A), start.A)
            assertEquals("${v.name}: timestamp", v.timestamp, Srp.timestamp(v.timestampMs))
            val parts = Srp.parts(v.userPoolId, v.userId, v.password, start.a, start.A, v.B, v.salt, v.secretBlock, v.timestamp)
            assertEquals("${v.name}: u", big(v.u), parts.u)
            assertEquals("${v.name}: k", big(v.k), parts.k)
            assertEquals("${v.name}: x", big(v.x), parts.x)
            assertEquals("${v.name}: S", big(v.S), parts.S)
            assertEquals("${v.name}: key", v.key, hexOf(parts.key))
            assertEquals("${v.name}: signature", v.signature, parts.signature)
            assertEquals(v.signature, Srp.claim(v.userPoolId, v.userId, v.password, start.a, start.A, v.B, v.salt, v.secretBlock, v.timestamp))
        }
    }

    @Test
    fun `a wrong password, by one letter, makes another signature`() {
        val v = vectors.first()
        val start = Srp.start(bytesOfHex(v.a))
        val wrong = Srp.claim(v.userPoolId, v.userId, "${v.password}x", start.a, start.A, v.B, v.salt, v.secretBlock, v.timestamp)
        assertNotEquals(v.signature, wrong)
        assertTrue(Regex("^[A-Za-z0-9+/]{43}=$").matches(wrong))
    }

    @Test
    fun `the group is the 3072-bit prime of RFC 3526 with g = 2`() {
        assertEquals(3072, Srp.N.bitLength())
        assertEquals(BigInteger.valueOf(2), Srp.g)
        assertTrue(Srp.N.isProbablePrime(20))
    }

    @Test
    fun `a number is hashed as Java writes it, a 00 byte in front when the top bit is set`() {
        val vectors = listOf(
            0L to "00", 1L to "01", 0x7fL to "7f", 0x80L to "0080", 0xffL to "00ff", 0x100L to "0100",
            0xabcL to "0abc", 0x8abcL to "008abc", 0x0123L to "0123", 0x7fffL to "7fff", 0x8000L to "008000",
        )
        for ((value, written) in vectors) {
            val number = BigInteger.valueOf(value)
            assertEquals(written, Srp.hex(number))
            assertEquals(written, hexOf(number.toByteArray()))
        }
        assertTrue(Srp.hex(Srp.N).startsWith("00ffffffffffffffffc90fdaa2"))
        assertEquals(2 * 385, Srp.hex(Srp.N).length)
        try {
            Srp.hex(BigInteger.valueOf(-1))
            fail("a number below zero is refused")
        } catch (e: IllegalArgumentException) {
            // As the website's RangeError.
        }
    }

    @Test
    fun `the time is written as Cognito wants it, the day of the month without a leading zero`() {
        val vectors = listOf(
            "2026-11-02T03:04:05Z" to "Mon Nov 2 03:04:05 UTC 2026",
            "2026-12-31T23:59:59Z" to "Thu Dec 31 23:59:59 UTC 2026",
            "2026-03-01T00:00:00Z" to "Sun Mar 1 00:00:00 UTC 2026",
            "2027-01-09T12:30:07.999Z" to "Sat Jan 9 12:30:07 UTC 2027",
            "2026-10-10T09:00:00Z" to "Sat Oct 10 09:00:00 UTC 2026",
        )
        for ((iso, written) in vectors) assertEquals(written, Srp.timestamp(java.time.Instant.parse(iso).toEpochMilli()))
    }

    @Test
    fun `the key is 16 bytes of HKDF-SHA-256, RFC 5869 test case 1`() {
        val ikm = ByteArray(22) { 0x0b }
        val salt = bytesOfHex("000102030405060708090a0b0c")
        val info = bytesOfHex("f0f1f2f3f4f5f6f7f8f9")
        assertEquals("3cb25f25faacd57a90434f64d0362f2a", hexOf(Srp.hkdf16(ikm, salt, info)))
    }

    @Test
    fun `a is 128 bytes, and a random source that gives nothing is refused`() {
        val start = Srp.start(ByteArray(128) { 7 })
        assertEquals(BigInteger("07".repeat(128), 16), start.a)
        assertEquals(Srp.g.modPow(start.a, Srp.N), start.A)
        try {
            Srp.start(ByteArray(128))
            fail("a = 0 is not used")
        } catch (e: IllegalStateException) {
            // Only a broken random source gets here.
        }
        val drawn = Srp.start()
        assertTrue(drawn.a.signum() > 0 && drawn.a.bitLength() <= 1024)
    }

    @Test
    fun `a challenge that cannot be used is refused, not answered`() {
        val start = Srp.start(ByteArray(128) { 3 })
        val pool = "xx-test-1_Pool0Tests"
        val user = "6f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b"
        val time = Srp.timestamp(0)
        fun claim(srpB: String = "abc123", salt: String = "beef", block: String = "AAAA", userId: String = user) =
            Srp.claim(pool, userId, "Correct-Horse-B4ttery", start.a, start.A, srpB, salt, block, time)
        claim()
        val broken: List<() -> String> = listOf(
            { claim(srpB = "0") }, { claim(srpB = Srp.N.toString(16)) }, { claim(srpB = Srp.N.shiftLeft(1).toString(16)) },
            { claim(srpB = "xyz") }, { claim(srpB = "") }, { claim(srpB = "f".repeat(1025)) }, { claim(salt = "") },
            { claim(salt = "12 34") }, { claim(block = "not base64!") }, { claim(block = "") }, { claim(userId = "") },
            { claim(userId = "a:b") }, { claim(userId = "two words") }, { claim(userId = "no break") },
        )
        for ((index, attempt) in broken.withIndex()) {
            try {
                attempt()
                fail("case $index was answered")
            } catch (e: Srp.Unusable) {
                // Refused.
            }
        }
    }
}
