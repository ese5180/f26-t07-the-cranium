package com.craniumiot.cranium.update

import com.craniumiot.cranium.api.AccessTokens
import com.craniumiot.cranium.core.ApiError
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import kotlin.concurrent.thread

/**
 * The update's requests against a fake console on this machine, which also stands in for S3:
 * the path and the headers of each, and how the answers are read.
 */
class UpdateApiTest {
    @get:Rule
    val folder = TemporaryFolder()

    private class Request(val method: String, val path: String, val headers: Map<String, String>)

    /** Answers each request with the next of [answers], over plain HTTP on localhost. */
    private class FakeServer : AutoCloseable {
        private val server = ServerSocket(0, 8, InetAddress.getLoopbackAddress())
        val answers = LinkedBlockingQueue<Pair<Int, ByteArray>>()
        val requests = CopyOnWriteArrayList<Request>()
        val url = "http://127.0.0.1:${server.localPort}"

        init {
            thread(isDaemon = true) {
                while (!server.isClosed) {
                    val socket = runCatching { server.accept() }.getOrNull() ?: break
                    runCatching { socket.use { answer(it) } }
                }
            }
        }

        private fun answer(socket: Socket) {
            val input = BufferedInputStream(socket.getInputStream())
            fun line(): String {
                val out = ByteArrayOutputStream()
                while (true) {
                    val b = input.read()
                    if (b < 0 || b == '\n'.code) break
                    if (b != '\r'.code) out.write(b)
                }
                return out.toString(Charsets.UTF_8.name())
            }
            val (method, path) = line().split(' ').let { it[0] to it[1] }
            val headers = mutableMapOf<String, String>()
            while (true) {
                val header = line()
                if (header.isEmpty()) break
                val colon = header.indexOf(':')
                headers[header.substring(0, colon).lowercase()] = header.substring(colon + 1).trim()
            }
            requests += Request(method, path, headers)
            val (status, body) = answers.poll() ?: (500 to """{"error":{"code":"internal_error","message":"No answer left."}}""".toByteArray())
            val out = socket.getOutputStream()
            out.write("HTTP/1.1 $status X\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n".toByteArray(Charsets.UTF_8))
            out.write(body)
            out.flush()
        }

        override fun close() = server.close()
    }

    /** A token, renewed on request; [forgotten] if the client ever asked to forget the sign-in. */
    private class Tokens : AccessTokens {
        var renewed = 0
        var forgotten = false

        override suspend fun accessToken(forceRefresh: Boolean): String {
            if (forceRefresh) renewed++
            return if (renewed > 0) "renewed-token" else "access-token"
        }

        override suspend fun forget() {
            forgotten = true
        }
    }

    private val server = FakeServer()
    private val tokens = Tokens()
    private val api = UpdateApi(server.url + "/", tokens)

    @After
    fun close() = server.close()

    private fun json(status: Int, text: String) = status to text.toByteArray(Charsets.UTF_8)

    private val apk = ByteArray(70_000) { (it * 7 % 256).toByte() }
    private val release = AppRelease("0.6.0", 6, apk.size.toLong(), Sha256.of(apk), "New versions reach every phone.")

    private fun link(path: String = "/bucket/cranium-android-0.6.0.apk?X-Amz-Signature=ab") =
        AppDownload(server.url + path, null, release.version, "cranium-android-0.6.0.apk", release.size, release.sha256)

    @Test
    fun `the list is read from the Apps route, with the token`() = runBlocking {
        server.answers += json(
            200,
            """{"android": {"latest": "0.6.0", "releases": [{"version": "0.6.0", "versionCode": 6, "size": ${apk.size}, "sha256": "${release.sha256}"}]}}""",
        )
        val releases = api.releases()
        assertEquals(listOf(6), releases.map { it.versionCode })
        val sent = server.requests.single()
        assertEquals("GET", sent.method)
        assertEquals("/api/apps", sent.path)
        assertEquals("Bearer access-token", sent.headers["authorization"])
    }

    @Test
    fun `the link is asked for as the app, with the token`() = runBlocking {
        server.answers += json(
            200,
            """{"download": {"url": "https://bucket.example.com/a.apk?sig=1", "expiresAt": "2026-11-05T12:15:00.000Z",
                "version": "0.6.0", "filename": "cranium-android-0.6.0.apk", "size": ${apk.size}, "sha256": "${release.sha256}"}}""",
        )
        val link = api.link(release)
        assertNull(AppUpdates.disagreement(release, link))
        val sent = server.requests.single()
        assertEquals("/api/apps/android/0.6.0/download?via=app", sent.path)
        assertEquals("Bearer access-token", sent.headers["authorization"])
    }

    @Test
    fun `a 401 renews the token once, a second is an error, and nobody is signed out`() = runBlocking {
        server.answers += json(401, """{"message": "Unauthorized"}""")
        server.answers += json(200, """{"android": {"releases": []}}""")
        assertEquals(emptyList<AppRelease>(), api.releases())
        assertEquals("Bearer renewed-token", server.requests.last().headers["authorization"])

        server.answers += json(401, """{"message": "Unauthorized"}""")
        server.answers += json(401, """{"message": "Unauthorized"}""")
        try {
            api.releases()
            fail("no refusal")
        } catch (e: ApiError) {
            assertEquals(401, e.status)
        }
        assertFalse(tokens.forgotten)
    }

    @Test
    fun `a refusal is the console's error, as it put it`() = runBlocking {
        server.answers += json(404, """{"error": {"code": "unknown_version", "message": "There is no Android app 0.6.0 on the console."}}""")
        try {
            api.link(release)
            fail("no refusal")
        } catch (e: ApiError) {
            assertEquals(listOf(404, "unknown_version"), listOf(e.status, e.code))
        }
    }

    @Test
    fun `the APK comes from the link without the console's token, and is digested on the way`() = runBlocking {
        server.answers += 200 to apk
        val into = folder.root.resolve("updates/cranium-android-0.6.0.apk.part")
        var last = 0L
        val arrived = api.fetch(link(), into) { last = it }
        assertEquals(Arrived(apk.size.toLong(), release.sha256), arrived)
        assertNull(AppUpdates.fileProblem(release, arrived))
        assertEquals(apk.size.toLong(), last)
        assertTrue(into.readBytes().contentEquals(apk))
        val sent = server.requests.single()
        assertEquals("/bucket/cranium-android-0.6.0.apk?X-Amz-Signature=ab", sent.path)
        assertNull(sent.headers["authorization"])
    }

    @Test
    fun `a longer or different file is caught, reading at most one byte more than described`() = runBlocking {
        server.answers += 200 to (apk + ByteArray(50_000))
        val into = folder.root.resolve("long.part")
        val long = api.fetch(link(), into)
        assertEquals(apk.size + 1L, long.size)
        assertTrue(AppUpdates.fileProblem(release, long)!!.contains("bytes"))

        val changed = apk.copyOf().also { it[0] = (it[0] + 1).toByte() }
        server.answers += 200 to changed
        val other = api.fetch(link(), folder.root.resolve("other.part"))
        assertEquals(apk.size.toLong(), other.size)
        assertTrue(AppUpdates.fileProblem(release, other)!!.contains("SHA-256"))
    }

    @Test
    fun `a link that ran out says so`() = runBlocking {
        server.answers += 403 to "<Error><Code>AccessDenied</Code></Error>".toByteArray()
        try {
            api.fetch(link(), folder.root.resolve("x.part"))
            fail("no refusal")
        } catch (e: DownloadFailed) {
            assertTrue(e.message!!, e.message!!.contains("ran out"))
        }
    }
}
