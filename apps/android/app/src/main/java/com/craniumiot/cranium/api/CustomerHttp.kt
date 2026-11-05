package com.craniumiot.cranium.api

import com.craniumiot.cranium.core.CustomerAnswer
import com.craniumiot.cranium.core.CustomerTransport
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * One GET of the customer API over HTTPS, with the customer's access token and nothing else: no
 * cookies, no cache, no redirects followed. Nothing here is logged.
 */
class CustomerHttp : CustomerTransport {
    override suspend fun get(url: String, token: String): CustomerAnswer = withContext(Dispatchers.IO) {
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = 15_000
            connection.readTimeout = 20_000
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            connection.requestMethod = "GET"
            connection.setRequestProperty("Authorization", "Bearer $token")
            connection.setRequestProperty("Accept", "application/json")
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            CustomerAnswer(status, stream?.use { readAtMost(it) }?.decodeToString().orEmpty())
        } finally {
            connection.disconnect()
        }
    }

    private fun readAtMost(input: InputStream): ByteArray {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(16 * 1024)
        while (out.size() < MAX_BYTES) {
            val n = input.read(buffer, 0, minOf(buffer.size, MAX_BYTES - out.size()))
            if (n < 0) break
            out.write(buffer, 0, n)
        }
        return out.toByteArray()
    }

    private companion object {
        const val MAX_BYTES = 2 * 1024 * 1024
    }
}
