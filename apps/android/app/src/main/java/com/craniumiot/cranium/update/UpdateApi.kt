package com.craniumiot.cranium.update

import com.craniumiot.cranium.api.AccessTokens
import com.craniumiot.cranium.core.ApiJson
import com.craniumiot.cranium.core.ApiPaths
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/** The APK's link answered with something else than the file: what to tell the person. */
class DownloadFailed(message: String) : IOException(message)

/**
 * The console's two routes for the app's own updates, with the same access token as every other
 * call (api/ApiClient.kt), and the download of the APK from the link the second one hands out.
 *
 * On a 401 the token is renewed once ([AccessTokens.accessToken] with forceRefresh) and the call
 * made again. A second 401 is an error, and nothing more: signing the person out is the console
 * client's business, which finds out on its own next call. A read that the gateway throttles or
 * cannot answer is tried up to three times, as ApiClient does. Nothing here is logged.
 */
class UpdateApi(consoleUrl: String, private val tokens: AccessTokens) {
    private val base = consoleUrl.trimEnd('/')

    val appsUrl: String get() = "$base/api/apps"

    /** The link for one version. `via=app` puts it on the activity log as asked for by the app itself. */
    fun downloadUrl(version: String): String = "$base/api/apps/android/${ApiPaths.encodeSegment(version)}/download?via=app"

    /** The Android app's releases on the console. */
    suspend fun releases(): List<AppRelease> = AppReleaseJson.releases(getJson(appsUrl))

    /** A link to the APK of [release], good for 15 minutes. Any signed-in member may ask; no fresh sign-in. */
    suspend fun link(release: AppRelease): AppDownload = AppReleaseJson.download(getJson(downloadUrl(release.version)))

    /**
     * The APK behind [download], written to [into] and digested on the way. At most one byte more
     * than its size is read, which is enough for the size check to see a longer file. The link is
     * presigned: it carries its own signature, so no Authorization header goes with it, and the
     * console's token never goes to S3. [onProgress] gets the bytes so far, on this IO thread.
     */
    suspend fun fetch(download: AppDownload, into: File, onProgress: (Long) -> Unit = {}): Arrived = withContext(Dispatchers.IO) {
        val connection = URL(download.url).openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = 15_000
            connection.readTimeout = 30_000
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            val status = connection.responseCode
            if (status !in 200..299) {
                throw DownloadFailed(
                    if (status == 403) "The download link ran out before the APK arrived. Tap the update to get a new one."
                    else "The APK could not be downloaded (HTTP $status). Try again in a moment.",
                )
            }
            into.parentFile?.mkdirs()
            val digest = MessageDigest.getInstance("SHA-256")
            val limit = download.size + 1
            var total = 0L
            connection.inputStream.use { input ->
                into.outputStream().use { out ->
                    val buffer = ByteArray(64 * 1024)
                    while (total < limit) {
                        coroutineContext.ensureActive()
                        val n = input.read(buffer, 0, minOf(buffer.size.toLong(), limit - total).toInt())
                        if (n < 0) break
                        out.write(buffer, 0, n)
                        digest.update(buffer, 0, n)
                        total += n
                        onProgress(total)
                    }
                }
            }
            Arrived(total, Sha256.hex(digest.digest()))
        } finally {
            connection.disconnect()
        }
    }

    private suspend fun getJson(url: String): String {
        for (attempt in 1..MAX_TRIES) {
            var answer = get(url, tokens.accessToken())
            if (answer.status == 401) answer = get(url, tokens.accessToken(forceRefresh = true))
            if (answer.status in RETRY && attempt < MAX_TRIES) {
                delay(BACKOFF_MS * attempt)
                continue
            }
            if (answer.status !in 200..299) throw ApiJson.error(answer.status, answer.body.decodeToString())
            if (answer.body.size >= MAX_JSON_BYTES) throw IOException("The console's answer is too long.")
            return answer.body.decodeToString()
        }
        throw IOException("The console did not answer.")
    }

    private class Answer(val status: Int, val body: ByteArray)

    private suspend fun get(url: String, token: String): Answer = withContext(Dispatchers.IO) {
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = 15_000
            connection.readTimeout = 30_000
            // The token goes to the console only: never on to wherever a redirect points.
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            connection.requestMethod = "GET"
            connection.setRequestProperty("Authorization", "Bearer $token")
            connection.setRequestProperty("Accept", "application/json")
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            Answer(status, stream?.use { readAtMost(it, MAX_JSON_BYTES) } ?: ByteArray(0))
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
        const val MAX_JSON_BYTES = 1L * 1024 * 1024
        const val MAX_TRIES = 3
        const val BACKOFF_MS = 400L
        val RETRY = setOf(429, 502, 503, 504)
    }
}
