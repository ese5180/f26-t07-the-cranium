package com.craniumiot.cranium.api

import com.craniumiot.cranium.auth.AuthManager
import com.craniumiot.cranium.auth.SignedOutException
import com.craniumiot.cranium.core.ApiError
import com.craniumiot.cranium.core.ApiJson
import com.craniumiot.cranium.core.ApiPaths
import com.craniumiot.cranium.core.Device
import com.craniumiot.cranium.core.Me
import com.craniumiot.cranium.core.Pairing
import com.craniumiot.cranium.core.Release
import com.craniumiot.cranium.core.ReleaseList
import com.craniumiot.cranium.core.SendCheck
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * The console's API, with the access token. On a 401 the tokens are refreshed once and the call
 * made again; a second 401 signs the person out. Nothing here is logged.
 */
class ApiClient(private val paths: ApiPaths, private val auth: AuthManager) {

    suspend fun me(): Me = ApiJson.me(getJson(paths.me))

    suspend fun releases(): ReleaseList = ApiJson.releases(getJson(paths.firmware))

    /**
     * The signed image of [release]. Reads at most one byte more than the release's size, which is
     * enough for the size check to see a longer file.
     */
    suspend fun image(release: Release): ByteArray =
        get(paths.image(release.version), "application/octet-stream", release.size + 1)

    /** The passkey of the board advertising as [name], or null (404) if no online board has one. */
    suspend fun pairing(name: String): Pairing? = try {
        ApiJson.pairing(getJson(paths.pairing(name)))
    } catch (e: ApiError) {
        if (e.status == 404) null else throw e
    }

    suspend fun device(thing: String): Device = ApiJson.device(getJson(paths.device(thing)))

    /**
     * Right before every Bluetooth send: may the image whose SHA-256 is [sha256] be sent to [board]
     * as [release] now? Returns only if the console answers 200 with the same release, the same
     * SHA-256 and `active` ([SendCheck]). Throws otherwise, an [IOException] when the console cannot
     * be reached included: then nothing may be sent.
     */
    suspend fun confirmSend(release: Release, sha256: String, board: String?) {
        val body = SendCheck.body(sha256, board)
        val answer = call(paths.bluetooth(release.version), "application/json", MAX_JSON_BYTES, body)
        if (answer.size >= MAX_JSON_BYTES) throw IOException("The console's answer is too long.")
        SendCheck.requireCleared(answer.decodeToString(), release, sha256)
    }

    private suspend fun getJson(url: String): String {
        val body = get(url, "application/json", MAX_JSON_BYTES)
        if (body.size >= MAX_JSON_BYTES) throw IOException("The console's answer is too long.")
        return body.decodeToString()
    }

    private suspend fun get(url: String, accept: String, maxBytes: Long): ByteArray = call(url, accept, maxBytes, null)

    /** A GET, or with [jsonBody] a POST of that JSON. */
    private suspend fun call(url: String, accept: String, maxBytes: Long, jsonBody: String?): ByteArray {
        var answer = fetch(url, accept, maxBytes, auth.accessToken(), jsonBody)
        if (answer.status == 401) {
            answer = fetch(url, accept, maxBytes, auth.accessToken(forceRefresh = true), jsonBody)
            if (answer.status == 401) {
                auth.forget()
                throw SignedOutException("The console no longer takes this sign-in. Sign in again.")
            }
        }
        if (answer.status !in 200..299) throw ApiJson.error(answer.status, answer.body.decodeToString())
        return answer.body
    }

    private class Answer(val status: Int, val body: ByteArray)

    private suspend fun fetch(url: String, accept: String, maxBytes: Long, token: String, jsonBody: String?): Answer =
        withContext(Dispatchers.IO) {
            val connection = URL(url).openConnection() as HttpURLConnection
            try {
                connection.connectTimeout = 15_000
                connection.readTimeout = 30_000
                connection.instanceFollowRedirects = false
                connection.useCaches = false
                connection.setRequestProperty("Authorization", "Bearer $token")
                connection.setRequestProperty("Accept", accept)
                if (jsonBody != null) {
                    val bytes = jsonBody.toByteArray(Charsets.UTF_8)
                    connection.requestMethod = "POST"
                    connection.doOutput = true
                    connection.setFixedLengthStreamingMode(bytes.size)
                    connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                    connection.outputStream.use { it.write(bytes) }
                }
                val status = connection.responseCode
                val stream = if (status in 200..299) connection.inputStream else connection.errorStream
                val limit = if (status in 200..299) maxBytes else MAX_JSON_BYTES
                Answer(status, stream?.use { readAtMost(it, limit) } ?: ByteArray(0))
            } finally {
                connection.disconnect()
            }
        }

    private fun readAtMost(input: InputStream, limit: Long): ByteArray {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(16 * 1024)
        var total = 0L
        while (total < limit) {
            val n = input.read(buffer, 0, minOf(buffer.size.toLong(), limit - total).toInt())
            if (n < 0) break
            out.write(buffer, 0, n)
            total += n
        }
        return out.toByteArray()
    }

    private companion object {
        const val MAX_JSON_BYTES = 4L * 1024 * 1024
    }
}
