package com.craniumiot.cranium.api

import com.craniumiot.cranium.core.ApiError
import com.craniumiot.cranium.core.ApiPaths
import com.craniumiot.cranium.core.FreshSignIn
import com.craniumiot.cranium.core.SerialRecord
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import kotlin.concurrent.thread

/**
 * The app's requests against a fake console on this machine: the method, path and body of each,
 * exactly, and how its answer is read. The note route is not deployed yet, so this is all it has
 * been tried against.
 */
class ApiClientTest {
    private class Request(val method: String, val path: String, val headers: Map<String, String>, val body: String)

    /** A console that answers each request with the next of [answers], over plain HTTP on localhost. */
    private class FakeConsole : AutoCloseable {
        private val server = ServerSocket(0, 8, InetAddress.getLoopbackAddress())
        val answers = LinkedBlockingQueue<Pair<Int, String>>()
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
            val length = headers["content-length"]?.toInt() ?: 0
            val body = ByteArray(length)
            var read = 0
            while (read < length) read += input.read(body, read, length - read).coerceAtLeast(0)
            requests += Request(method, path, headers, body.decodeToString())
            val (status, text) = answers.poll() ?: (500 to """{"error":{"code":"internal_error","message":"No answer left."}}""")
            val bytes = text.toByteArray(Charsets.UTF_8)
            val out = socket.getOutputStream()
            out.write(
                "HTTP/1.1 $status X\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n"
                    .toByteArray(Charsets.UTF_8),
            )
            out.write(bytes)
            out.flush()
        }

        override fun close() = server.close()
    }

    private object Tokens : AccessTokens {
        override suspend fun accessToken(forceRefresh: Boolean) = "access-token"

        override suspend fun forget() = Unit
    }

    private val console = FakeConsole()
    private val client = ApiClient(ApiPaths(console.url), Tokens)

    @After
    fun close() = console.close()

    private fun json(text: String) = Json.parseToJsonElement(text) as JsonObject

    private val release = """{"version":"1.12.0+0","size":4096,"sha256":"${"ab".repeat(32)}","status":"active","notes":"Fixes the stuck timer."}"""

    @Test
    fun `a release's note is put whole, on one line, at most 500 characters, and the release comes back`() = runBlocking {
        console.answers += 200 to """{"release":$release}"""
        val changed = client.setNotes("1.12.0+0", "  Fixes the\nstuck timer.  ")
        val sent = console.requests.single()
        assertEquals("PUT", sent.method)
        assertEquals("/api/firmware/1.12.0%2B0/notes", sent.path)
        assertEquals("Bearer access-token", sent.headers["authorization"])
        assertEquals("""{"notes":"Fixes the stuck timer."}""", sent.body)
        assertEquals("Fixes the stuck timer.", changed.notes)

        console.answers += 200 to """{"release":$release}"""
        client.setNotes("1.12.0+0", "x".repeat(600))
        assertEquals(500, json(console.requests.last().body)["notes"]!!.jsonPrimitive.content.length)
        console.answers += 200 to """{"release":$release}"""
        client.setNotes("1.12.0+0", "")
        assertEquals("""{"notes":""}""", console.requests.last().body)
    }

    @Test
    fun `a note from a sign-in older than 15 minutes is refused as the fresh sign-in rule says`() = runBlocking {
        console.answers += 403 to """{"error":{"code":"phone_sign_in_again","message":"Sign in again."}}"""
        try {
            client.setNotes("1.12.0+0", "x")
            fail("no refusal")
        } catch (e: ApiError) {
            assertTrue(FreshSignIn.isRefusal(e))
        }
    }

    @Test
    fun `a serial console command is posted once, with its name, the board's ID and version, and nothing else`() = runBlocking {
        console.answers += 201 to """{"recorded":{"command":"WIFI","device":"CRVIHAAN01","version":"1.12.0+0"}}"""
        val recorded = client.recordSerialCommand(SerialRecord("WIFI", "CRVIHAAN01", "1.12.0+0"))
        assertEquals(SerialRecord("WIFI", "CRVIHAAN01", "1.12.0+0"), recorded)
        val sent = console.requests.single()
        assertEquals("POST", sent.method)
        assertEquals("/api/serial/commands", sent.path)
        assertEquals(setOf("command", "device", "version"), json(sent.body).keys)

        console.answers += 201 to """{"recorded":{"command":"INIT","device":null,"version":null}}"""
        assertEquals(SerialRecord("INIT"), client.recordSerialCommand(SerialRecord("INIT")))
        assertEquals("""{"command":"INIT"}""", console.requests.last().body)

        // Too many in a minute is not waited out: one try, and the refusal as the server put it.
        console.answers += 429 to """{"error":{"code":"rate_limited","message":"At most 30 a minute."}}"""
        console.answers += 201 to "{}"
        val before = console.requests.size
        try {
            client.recordSerialCommand(SerialRecord("REBOOT"))
            fail("no refusal")
        } catch (e: ApiError) {
            assertEquals(listOf(429, "rate_limited", "At most 30 a minute."), listOf(e.status, e.code, e.message))
        }
        assertEquals(before + 1, console.requests.size)
    }

    @Test
    fun `the board log is read from its own route`() = runBlocking {
        console.answers += 200 to """{"lines":[],"cursor":null,"from":"2026-10-10T12:00:00Z","to":"2026-10-10T12:00:00Z"}"""
        val page = client.boardLog("2026-10-10T11:00:00Z", "2026-10-10T12:00:00Z", thing = "cranium-0123456789abcdef", limit = 5)
        assertTrue(page.lines.isEmpty())
        val sent = console.requests.single()
        assertEquals("GET", sent.method)
        assertTrue(sent.path, sent.path.startsWith("/api/events/log?from=2026-10-10T11%3A00%3A00Z&to="))
        assertTrue(sent.path, sent.path.endsWith("&thing=cranium-0123456789abcdef&limit=5"))
    }
}
