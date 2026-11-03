package com.craniumiot.cranium.api

import com.craniumiot.cranium.auth.AuthManager
import com.craniumiot.cranium.auth.SignedOutException
import com.craniumiot.cranium.core.ApiJson
import com.craniumiot.cranium.core.ApiPaths
import com.craniumiot.cranium.core.ApiToken
import com.craniumiot.cranium.core.AuditPage
import com.craniumiot.cranium.core.CommitHistory
import com.craniumiot.cranium.core.Deployment
import com.craniumiot.cranium.core.DeploymentSummary
import com.craniumiot.cranium.core.Device
import com.craniumiot.cranium.core.DeviceDetail
import com.craniumiot.cranium.core.DeviceList
import com.craniumiot.cranium.core.EventPage
import com.craniumiot.cranium.core.HistoryRead
import com.craniumiot.cranium.core.Me
import com.craniumiot.cranium.core.NewToken
import com.craniumiot.cranium.core.Pairing
import com.craniumiot.cranium.core.Release
import com.craniumiot.cranium.core.ReleaseList
import com.craniumiot.cranium.core.Revoked
import com.craniumiot.cranium.core.Samples
import com.craniumiot.cranium.core.SendCheck
import com.craniumiot.cranium.core.TokenList
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.Base64

/** An upload's progress: the share of the body sent, then the server checking it. */
enum class UploadStage { SENDING, CHECKING }

/**
 * The console's API, with the access token: every route the website uses. On a 401 the tokens
 * are refreshed once and the call made again; a second 401 signs the person out. A read that the
 * gateway throttles or cannot answer is tried up to three times, as the website does. Nothing here
 * is logged.
 */
class ApiClient(private val paths: ApiPaths, private val auth: AuthManager) {

    // Reads.

    suspend fun me(): Me = ApiJson.me(getJson(paths.me))

    suspend fun releases(): ReleaseList = ApiJson.releases(getJson(paths.firmware))

    suspend fun devices(): DeviceList = ApiJson.devices(getJson(paths.devices))

    suspend fun device(thing: String): Device = ApiJson.device(getJson(paths.device(thing)))

    suspend fun deviceDetail(thing: String): DeviceDetail = ApiJson.deviceDetail(getJson(paths.device(thing)))

    suspend fun samples(thing: String, hours: Int = 24): Samples = ApiJson.samples(getJson(paths.samples(thing, hours)))

    suspend fun events(from: String, to: String, thing: String?, kinds: List<String>?, cursor: String?): EventPage =
        ApiJson.events(getJson(paths.events(from, to, thing, kinds, cursor)))

    suspend fun deployments(): List<DeploymentSummary> = ApiJson.deployments(getJson(paths.deployments))

    suspend fun deployment(id: String): Deployment = ApiJson.deployment(getJson(paths.deployment(id)))

    suspend fun audit(limit: Int = 50, before: String? = null): AuditPage = ApiJson.audit(getJson(paths.audit(limit, before)))

    suspend fun tokens(): TokenList = ApiJson.tokens(getJson(paths.tokens))

    /**
     * The signed image of [release]. Reads at most one byte more than the release's size, which is
     * enough for the size check to see a longer file.
     */
    suspend fun image(release: Release): ByteArray =
        call("GET", paths.image(release.version), "application/octet-stream", release.size + 1, null)

    /** The passkey of the board advertising as [name], or null (404) if no online board has one. */
    suspend fun pairing(name: String): Pairing? = try {
        ApiJson.pairing(getJson(paths.pairing(name)))
    } catch (e: com.craniumiot.cranium.core.ApiError) {
        if (e.status == 404) null else throw e
    }

    /**
     * Right before every Bluetooth send: may the image whose SHA-256 is [sha256] be sent to [board]
     * as [release] now? Returns only if the console answers 200 with the same release, the same
     * SHA-256 and `active` ([SendCheck]). Throws otherwise, an [IOException] when the console cannot
     * be reached included: then nothing may be sent.
     */
    suspend fun confirmSend(release: Release, sha256: String, board: String?) {
        val body = SendCheck.body(sha256, board)
        val answer = postJson(paths.bluetooth(release.version), body)
        SendCheck.requireCleared(answer, release, sha256)
    }

    // Changes. Each needs a release manager, and from the phone a sign-in in the last 15 minutes.

    suspend fun revoke(version: String, reason: String): Revoked =
        ApiJson.revoked(postJson(paths.revoke(version), buildJsonObject { put("reason", reason) }.toString()))

    suspend fun deploy(version: String, things: List<String>, note: String): Deployment {
        val body = buildJsonObject {
            put("version", version)
            put("things", JsonArray(things.map { JsonPrimitive(it) }))
            if (note.isNotEmpty()) put("note", note)
        }
        return ApiJson.deployment(postJson(paths.deployments, body.toString()))
    }

    suspend fun cancel(id: String, force: Boolean): Deployment =
        ApiJson.deployment(postJson(paths.cancel(id), buildJsonObject { put("force", force) }.toString()))

    suspend fun createToken(name: String, days: Int): NewToken =
        ApiJson.newToken(postJson(paths.tokens, buildJsonObject { put("name", name); put("days", days) }.toString()))

    suspend fun revokeToken(id: String): ApiToken = ApiJson.revokedToken(postJson(paths.revokeToken(id), "{}"))

    /**
     * Upload a signed image: `POST /api/firmware` with `{filename, notes, data}`, the file in
     * standard base64. [onProgress] gets the share sent, then [UploadStage.CHECKING] once the body
     * is out and the server verifies it. A 429 is tried again, as the website does.
     */
    suspend fun upload(filename: String, notes: String, data: ByteArray, onProgress: (UploadStage, Float) -> Unit): Release {
        val body = buildJsonObject {
            put("filename", filename)
            put("data", Base64.getEncoder().encodeToString(data))
            if (notes.isNotEmpty()) put("notes", notes)
        }.toString().toByteArray(Charsets.UTF_8)
        for (attempt in 1..MAX_TRIES) {
            var answer = send(paths.firmware, body, auth.accessToken(), onProgress)
            if (answer.status == 401) {
                answer = send(paths.firmware, body, auth.accessToken(forceRefresh = true), onProgress)
                if (answer.status == 401) signedOut()
            }
            if (answer.status == 429 && attempt < MAX_TRIES) {
                delay(BACKOFF_MS * attempt)
                continue
            }
            if (answer.status !in 200..299) throw ApiJson.error(answer.status, answer.body.decodeToString())
            return ApiJson.uploaded(answer.body.decodeToString())
        }
        throw IOException("The upload did not go through.")
    }

    /**
     * The website's History page: the console's own page names the build its scripts are under,
     * and `history.json` is beside them. Static files: no token is sent.
     */
    suspend fun history(): HistoryRead = withContext(Dispatchers.IO) {
        try {
            val page = fetchStatic(paths.root, "text/html")
            if (page.status !in 200..299) return@withContext HistoryRead.Failed("The console's page could not be read.")
            val build = ApiPaths.buildIdIn(page.body.decodeToString())
                ?: return@withContext HistoryRead.Failed("The console's page does not say which build it is.")
            val file = fetchStatic(paths.history(build), "application/json")
            when {
                file.status == 404 || file.status == 403 -> HistoryRead.Missing
                file.status !in 200..299 -> HistoryRead.Failed("The history file could not be read. Try again in a moment.")
                else -> CommitHistory.parse(file.body.decodeToString())?.let { HistoryRead.Read(it) }
                    ?: HistoryRead.Failed("The history file could not be read. Try again in a moment.")
            }
        } catch (e: IOException) {
            HistoryRead.Failed("The history file could not be fetched. Check the phone's connection.")
        }
    }

    // The requests themselves.

    private suspend fun getJson(url: String): String {
        val body = call("GET", url, "application/json", MAX_JSON_BYTES, null)
        if (body.size >= MAX_JSON_BYTES) throw IOException("The console's answer is too long.")
        return body.decodeToString()
    }

    private suspend fun postJson(url: String, json: String): String {
        val body = call("POST", url, "application/json", MAX_JSON_BYTES, json)
        if (body.size >= MAX_JSON_BYTES) throw IOException("The console's answer is too long.")
        return body.decodeToString()
    }

    /** A GET, or a POST of [jsonBody]. Retries what the website retries. */
    private suspend fun call(method: String, url: String, accept: String, maxBytes: Long, jsonBody: String?): ByteArray {
        val retry = if (method == "GET") RETRY_GET else RETRY_POST
        for (attempt in 1..MAX_TRIES) {
            var answer = fetch(method, url, accept, maxBytes, auth.accessToken(), jsonBody)
            if (answer.status == 401) {
                answer = fetch(method, url, accept, maxBytes, auth.accessToken(forceRefresh = true), jsonBody)
                if (answer.status == 401) signedOut()
            }
            if (answer.status in retry && attempt < MAX_TRIES) {
                delay(BACKOFF_MS * attempt)
                continue
            }
            if (answer.status !in 200..299) throw ApiJson.error(answer.status, answer.body.decodeToString())
            return answer.body
        }
        throw IOException("The console did not answer.")
    }

    private suspend fun signedOut(): Nothing {
        auth.forget()
        throw SignedOutException("The console no longer takes this sign-in. Sign in again.")
    }

    private class Answer(val status: Int, val body: ByteArray)

    private suspend fun fetch(method: String, url: String, accept: String, maxBytes: Long, token: String, jsonBody: String?): Answer =
        withContext(Dispatchers.IO) {
            val connection = URL(url).openConnection() as HttpURLConnection
            try {
                connection.connectTimeout = 15_000
                connection.readTimeout = 30_000
                connection.instanceFollowRedirects = false
                connection.useCaches = false
                connection.requestMethod = method
                connection.setRequestProperty("Authorization", "Bearer $token")
                connection.setRequestProperty("Accept", accept)
                if (jsonBody != null) {
                    val bytes = jsonBody.toByteArray(Charsets.UTF_8)
                    connection.doOutput = true
                    connection.setFixedLengthStreamingMode(bytes.size)
                    connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                    connection.outputStream.use { it.write(bytes) }
                }
                read(connection, maxBytes)
            } finally {
                connection.disconnect()
            }
        }

    private suspend fun send(url: String, body: ByteArray, token: String, onProgress: (UploadStage, Float) -> Unit): Answer =
        withContext(Dispatchers.IO) {
            val connection = URL(url).openConnection() as HttpURLConnection
            try {
                connection.connectTimeout = 15_000
                connection.readTimeout = 60_000
                connection.instanceFollowRedirects = false
                connection.useCaches = false
                connection.requestMethod = "POST"
                connection.doOutput = true
                connection.setFixedLengthStreamingMode(body.size)
                connection.setRequestProperty("Authorization", "Bearer $token")
                connection.setRequestProperty("Accept", "application/json")
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                withContext(Dispatchers.Main) { onProgress(UploadStage.SENDING, 0f) }
                connection.outputStream.use { out ->
                    var offset = 0
                    while (offset < body.size) {
                        val n = minOf(UPLOAD_CHUNK, body.size - offset)
                        out.write(body, offset, n)
                        offset += n
                        val sent = offset.toFloat() / body.size
                        withContext(Dispatchers.Main) { onProgress(UploadStage.SENDING, sent) }
                    }
                }
                withContext(Dispatchers.Main) { onProgress(UploadStage.CHECKING, 1f) }
                read(connection, MAX_JSON_BYTES)
            } finally {
                connection.disconnect()
            }
        }

    private class Static(val status: Int, val body: ByteArray)

    private fun fetchStatic(url: String, accept: String): Static {
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = 15_000
            connection.readTimeout = 30_000
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            connection.setRequestProperty("Accept", accept)
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            return Static(status, stream?.use { readAtMost(it, MAX_JSON_BYTES) } ?: ByteArray(0))
        } finally {
            connection.disconnect()
        }
    }

    private fun read(connection: HttpURLConnection, maxBytes: Long): Answer {
        val status = connection.responseCode
        val stream = if (status in 200..299) connection.inputStream else connection.errorStream
        val limit = if (status in 200..299) maxBytes else MAX_JSON_BYTES
        return Answer(status, stream?.use { readAtMost(it, limit) } ?: ByteArray(0))
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
        const val MAX_TRIES = 3
        const val BACKOFF_MS = 400L
        const val UPLOAD_CHUNK = 16 * 1024
        val RETRY_GET = setOf(429, 502, 503, 504)
        val RETRY_POST = setOf(429)
    }
}
