package com.craniumiot.cranium.auth

import com.craniumiot.cranium.core.IdpAnswer
import com.craniumiot.cranium.core.IdpTransport
import com.craniumiot.cranium.core.SignInWords
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Cognito's user pool API, as the console's own sign-in page calls it: one address in the pool's
 * Region, the operation in a header, JSON in and out. Nothing here is logged: the bodies hold the
 * proof of the password, the code and the tokens.
 */
class CognitoHttp(region: String) : IdpTransport {
    private val endpoint = "https://cognito-idp.$region.amazonaws.com/"

    override suspend fun call(operation: String, body: JsonObject): IdpAnswer = withContext(Dispatchers.IO) {
        val connection = URL(endpoint).openConnection() as HttpURLConnection
        try {
            val bytes = body.toString().toByteArray(Charsets.UTF_8)
            connection.connectTimeout = 15_000
            connection.readTimeout = 15_000
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            connection.requestMethod = "POST"
            connection.doOutput = true
            connection.setFixedLengthStreamingMode(bytes.size)
            connection.setRequestProperty("Content-Type", "application/x-amz-json-1.1")
            connection.setRequestProperty("X-Amz-Target", "AWSCognitoIdentityProviderService.$operation")
            connection.outputStream.use { it.write(bytes) }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.use { readAtMost(it, MAX_BYTES) }?.decodeToString().orEmpty()
            val reply = runCatching { Json.parseToJsonElement(text) }.getOrNull() as? JsonObject
            if (status !in 200..299) {
                val type = (reply?.get("__type") as? JsonPrimitive)?.takeIf { it.isString }?.content
                return@withContext IdpAnswer.Refused(SignInWords.errorName(type, connection.getHeaderField("x-amzn-errortype")))
            }
            if (reply == null) return@withContext IdpAnswer.Problem("failed")
            IdpAnswer.Reply(reply, connection.getHeaderField("Date"))
        } catch (e: IOException) {
            IdpAnswer.Problem("network")
        } finally {
            connection.disconnect()
        }
    }

    private fun readAtMost(input: InputStream, limit: Int): ByteArray {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(8 * 1024)
        while (out.size() < limit) {
            val n = input.read(buffer, 0, minOf(buffer.size, limit - out.size()))
            if (n < 0) break
            out.write(buffer, 0, n)
        }
        return out.toByteArray()
    }

    private companion object {
        const val MAX_BYTES = 256 * 1024
    }
}
