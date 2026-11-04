package com.craniumiot.cranium.core

import java.math.BigInteger
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Instant
import java.time.ZoneOffset
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * The proof of a password that Cognito asks for: SRP-6a as Cognito does it, the same as the
 * console's own sign-in page (cloud/web/src/site/assets/core.js, "The proof of a password that
 * Cognito asks for"). The password never leaves the phone; only the proof does.
 *
 * - N is the 3072-bit prime of RFC 3526 (group 15), and g = 2.
 * - A number is hashed as its shortest big-endian bytes with room for a sign, the way Java's
 *   BigInteger.toByteArray() writes it ([hex]).
 * - k = H(N | g), u = H(A | B), x = H(salt | H(poolName | userId | ":" | password)), where
 *   poolName is the part of the pool ID after the underscore and userId is USER_ID_FOR_SRP.
 * - S = (B - k * g^x) ^ (a + u * x) mod N.
 * - The key is the first 16 bytes of HKDF-SHA-256 (RFC 5869) with S as the input, u as the salt
 *   and "Caldera Derived Key" as the info.
 * - The claim is HMAC-SHA-256 under that key of poolName | userId | SECRET_BLOCK's bytes | the
 *   time, written as "Mon Nov 2 03:04:05 UTC 2026".
 *
 * a is 128 random bytes from the CSPRNG and lives for one sign-in, in memory.
 */
object Srp {
    val N: BigInteger = BigInteger(
        listOf(
            "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1",
            "29024E088A67CC74020BBEA63B139B22514A08798E3404DD",
            "EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245",
            "E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED",
            "EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3D",
            "C2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F",
            "83655D23DCA3AD961C62F356208552BB9ED529077096966D",
            "670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B",
            "E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9",
            "DE2BCBF6955817183995497CEA956AE515D2261898FA0510",
            "15728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64",
            "ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7",
            "ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6B",
            "F12FFA06D98A0864D87602733EC86A64521F2B18177B200C",
            "BBE117577A615D6C770988C0BAD946E208E24FA074E5AB31",
            "43DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF",
        ).joinToString(""),
        16,
    )
    val g: BigInteger = BigInteger.valueOf(2)

    const val INFO = "Caldera Derived Key"
    private const val KEY_BYTES = 16
    private const val SECRET_BYTES = 128

    private val WEEKDAYS = listOf("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")
    private val MONTHS = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

    // What Cognito sends in its challenge, checked before it is used.
    private val NUMBER = Regex("^[0-9a-fA-F]{1,1024}$")
    private val BLOCK = Regex("^[A-Za-z0-9+/]{1,8192}={0,2}$")

    // As JavaScript's \s: Unicode white space too.
    private val USER = Regex("(?U)^[^\\s:]{1,128}$")

    /** A whole number as Cognito hashes it, in hex: its shortest bytes with room for a sign. */
    fun hex(value: BigInteger): String {
        require(value.signum() >= 0) { "Only a whole number of 0 or more" }
        val text = value.toString(16)
        return when {
            text.length % 2 == 1 -> "0$text"
            text[0] in "89abcdef" -> "00$text"
            else -> text
        }
    }

    private fun bytesOfHex(hex: String): ByteArray = ByteArray(hex.length / 2) { index ->
        hex.substring(index * 2, index * 2 + 2).toInt(16).toByte()
    }

    private fun bytes(value: BigInteger): ByteArray = bytesOfHex(hex(value))

    private fun sha256(vararg parts: ByteArray): ByteArray {
        val digest = MessageDigest.getInstance("SHA-256")
        for (part in parts) digest.update(part)
        return digest.digest()
    }

    private fun numberOf(bytes: ByteArray): BigInteger = BigInteger(1, bytes)

    /** H of numbers written one after the other, as a number. */
    private fun hashOfNumbers(vararg values: BigInteger): BigInteger = numberOf(sha256(*values.map { bytes(it) }.toTypedArray()))

    private fun hmac(key: ByteArray, vararg parts: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        for (part in parts) mac.update(part)
        return mac.doFinal()
    }

    /** The time as Cognito wants it in a PASSWORD_VERIFIER answer: English names, UTC, the day without a leading zero. */
    fun timestamp(ms: Long): String {
        val at = Instant.ofEpochMilli(ms).atZone(ZoneOffset.UTC)
        fun two(value: Int) = value.toString().padStart(2, '0')
        return "${WEEKDAYS[at.dayOfWeek.value % 7]} ${MONTHS[at.monthValue - 1]} ${at.dayOfMonth} " +
            "${two(at.hour)}:${two(at.minute)}:${two(at.second)} UTC ${at.year}"
    }

    /** The first 16 bytes of HKDF-SHA-256 (RFC 5869). */
    fun hkdf16(input: ByteArray, salt: ByteArray, info: ByteArray = INFO.toByteArray(Charsets.UTF_8)): ByteArray {
        val prk = hmac(salt, input)
        return hmac(prk, info, byteArrayOf(1)).copyOf(KEY_BYTES)
    }

    /** The phone's half of an exchange: a secret a and the A that goes to Cognito. */
    data class Start(val a: BigInteger, @get:JvmName("getPublicA") val A: BigInteger)

    fun start(random: SecureRandom = SecureRandom()): Start = start(ByteArray(SECRET_BYTES).also(random::nextBytes))

    /** From the 128 bytes of a: for a sign-in, from the CSPRNG; for a test, fixed. */
    fun start(aBytes: ByteArray): Start {
        val a = numberOf(aBytes)
        val A = g.modPow(a, N)
        // Only a broken random source gets here.
        check(a.signum() != 0 && A.mod(N).signum() != 0) { "No usable random number for the sign-in." }
        return Start(a, A)
    }

    /** What Cognito sent cannot be used: nothing is answered. */
    class Unusable : Exception("Cognito sent a challenge that cannot be used.")

    /** Every number of a proof, for the cross-check with the website's own code. */
    data class Parts(
        val u: BigInteger,
        val k: BigInteger,
        val x: BigInteger,
        val S: BigInteger,
        val key: ByteArray,
        val signature: String,
    )

    /**
     * The PASSWORD_CLAIM_SIGNATURE for Cognito's PASSWORD_VERIFIER challenge, with the numbers it
     * is made of. Throws [Unusable] if what Cognito sent cannot be used.
     */
    fun parts(
        userPoolId: String,
        userId: String,
        password: String,
        a: BigInteger,
        A: BigInteger,
        srpB: String,
        salt: String,
        secretBlock: String,
        timestamp: String,
    ): Parts {
        if (!NUMBER.matches(srpB) || !NUMBER.matches(salt) || !BLOCK.matches(secretBlock) || !USER.matches(userId)) {
            throw Unusable()
        }
        val B = BigInteger(srpB, 16)
        if (B.mod(N).signum() == 0) throw Unusable()
        val u = hashOfNumbers(A, B)
        if (u.signum() == 0) throw Unusable()
        val k = hashOfNumbers(N, g)
        val poolName = userPoolId.substring(userPoolId.indexOf('_') + 1)
        val inner = sha256("$poolName$userId:$password".toByteArray(Charsets.UTF_8))
        val x = numberOf(sha256(bytes(BigInteger(salt, 16)), inner))
        val S = B.subtract(k.multiply(g.modPow(x, N))).mod(N).modPow(a.add(u.multiply(x)), N)
        val key = hkdf16(bytes(S), bytes(u))
        val block = try {
            Base64.getDecoder().decode(secretBlock)
        } catch (e: IllegalArgumentException) {
            throw Unusable()
        }
        val signature = hmac(
            key,
            poolName.toByteArray(Charsets.UTF_8),
            userId.toByteArray(Charsets.UTF_8),
            block,
            timestamp.toByteArray(Charsets.UTF_8),
        )
        return Parts(u, k, x, S, key, Base64.getEncoder().encodeToString(signature))
    }

    /** The PASSWORD_CLAIM_SIGNATURE alone. */
    fun claim(
        userPoolId: String,
        userId: String,
        password: String,
        a: BigInteger,
        A: BigInteger,
        srpB: String,
        salt: String,
        secretBlock: String,
        timestamp: String,
    ): String = parts(userPoolId, userId, password, a, A, srpB, salt, secretBlock, timestamp).signature
}
