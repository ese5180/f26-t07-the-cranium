package com.craniumiot.cranium.core

import com.craniumiot.cranium.api.AccessTokens
import com.craniumiot.cranium.auth.SignedOutException
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException

/**
 * The customer API's client and readers, against the customer site's own examples
 * (cloud/web/test/customer.test.mjs): a board is read into a known shape and anything else is left
 * out, a board is addressed by its assignment id only, the customer's token goes to the customer API
 * only, and a 401 is tried once more before the session ends.
 */
class CustomerApiTest {
    private val board = """
        {"id":"0123456789abcdef","name":"Living room deck","boardName":"CRADA01","status":"online","online":true,
         "lastSeen":"2026-11-04T11:59:40.000Z","firmware":{"version":"1.11.2+0","confirmed":true},
         "update":{"state":"idle","progress":0,"last":"succeeded"},"rssi":-58,"uptime":600,"location":null,
         "since":"2026-11-01T10:00:00.000Z"}
    """.trimIndent()

    private fun parse(text: String) = Json.parseToJsonElement(text)

    private val expected = CustomerBoard(
        id = "0123456789abcdef", name = "Living room deck", boardName = "CRADA01", status = "online", online = true,
        lastSeen = "2026-11-04T11:59:40.000Z", firmware = CustomerFirmware("1.11.2+0", true),
        update = CustomerUpdate("idle", 0, "succeeded"), rssi = -58, uptime = 600, location = null, since = "2026-11-01T10:00:00.000Z",
    )

    @Test
    fun `a board is read into a known shape, and anything else from the API is left out`() {
        assertEquals(expected, CustomerJson.readBoard(parse(board)))
        assertNull(CustomerJson.readBoard(parse(board.replace("\"0123456789abcdef\"", "\"cranium-0123456789abcdef\""))))
        assertNull(CustomerJson.readBoard(parse(board.replace("\"status\":\"online\"", "\"status\":\"hacked\""))))
        val odd = CustomerJson.readBoard(
            parse(
                board.replace("\"Living room deck\"", "\"Deck\\u0000\\u202e<b>\"")
                    .replace("\"1.11.2+0\"", "\"1.2\"").replace("-58", "5")
                    .replace("\"uptime\":600", "\"uptime\":600,\"thing\":\"cranium-x\",\"mac\":\"aa\""),
            ),
        )!!
        assertEquals("Deck<b>", odd.name)
        assertNull(odd.firmware)
        assertNull(odd.rssi)
        assertNull(CustomerJson.readBoard(parse("[]")))
        // A time not in the API's form, an update in a state nobody knows, a progress out of range.
        val loose = CustomerJson.readBoard(
            parse(board.replace("\"2026-11-04T11:59:40.000Z\"", "\"yesterday\"").replace("\"progress\":0", "\"progress\":150")),
        )!!
        assertNull(loose.lastSeen)
        assertEquals(0, loose.update!!.progress)
        assertNull(CustomerJson.readBoard(parse(board.replace("\"state\":\"idle\"", "\"state\":\"exploding\"")))!!.update)
        assertEquals("none", CustomerJson.readBoard(parse(board.replace("\"last\":\"succeeded\"", "\"last\":\"odd\"")))!!.update!!.last)
        // An empty name is no name.
        assertNull(CustomerJson.readBoard(parse(board.replace("\"Living room deck\"", "\"\\u0001\"")))!!.name)
    }

    @Test
    fun `an event keeps its typed fields only, and one of another kind is left out`() {
        val at = "2026-11-04T11:59:40.000Z"
        assertNull(CustomerJson.readEvent(parse("""{"at":"$at","board":"0123456789abcdef","kind":"health","what":"memory"}""")))
        assertEquals(
            CustomerEvent(at, "0123456789abcdef", "firmware", "changed", version = "1.11.3+0", from = "1.11.2+0", confirmed = false),
            CustomerJson.readEvent(
                parse("""{"at":"$at","board":"0123456789abcdef","kind":"firmware","what":"changed","version":"1.11.3+0","from":"1.11.2+0","confirmed":false,"text":"x"}"""),
            ),
        )
        assertNull(CustomerJson.readEvent(parse("""{"at":"$at","board":"cranium-0123456789abcdef","kind":"firmware","what":"changed"}""")))
        val step = CustomerJson.readEvent(parse("""{"at":"$at","board":"0123456789abcdef","kind":"update","what":"step","state":"downloading","progress":40,"result":"Not A Word"}"""))!!
        assertEquals("downloading", step.state)
        assertEquals(40, step.progress)
        assertNull(step.result)
        assertNull(CustomerJson.readEvent(parse("""{"at":"$at","board":"0123456789abcdef","kind":"update","what":"step","confirmed":"yes"}"""))!!.confirmed)
    }

    private class Tokens(var token: String = "CUSTOMER-TOKEN", val refreshed: String = "CUSTOMER-TOKEN-2") : AccessTokens {
        var refreshes = 0
        var forgotten = 0
        override suspend fun accessToken(forceRefresh: Boolean): String {
            if (forceRefresh) {
                refreshes += 1
                token = refreshed
            }
            return token
        }

        override suspend fun forget() {
            forgotten += 1
        }
    }

    private class Calls(val answers: MutableList<CustomerAnswer>) : CustomerTransport {
        val seen = mutableListOf<Pair<String, String>>()
        var down = false
        override suspend fun get(url: String, token: String): CustomerAnswer {
            seen += url to token
            if (down) throw IOException("no route")
            return answers.removeAt(0)
        }
    }

    private val base = "https://customer.example.invalid"

    @Test
    fun `the customer's token goes to the customer API, and its answers are read`() = runTest {
        val calls = Calls(
            mutableListOf(
                CustomerAnswer(200, """{"email":"ada@example.invalid","name":"Ada","boards":2}"""),
                CustomerAnswer(200, """{"boards":[$board,{"id":"x"}],"generatedAt":"2026-11-04T12:00:00.000Z"}"""),
                CustomerAnswer(200, """{"board":$board,"activity":[]}"""),
                CustomerAnswer(200, """{"activity":[{"at":"2026-11-04T11:59:40.000Z","board":"0123456789abcdef","kind":"connection","what":"connected"}]}"""),
            ),
        )
        val api = CustomerApi("$base/", Tokens(), calls)
        assertEquals(CustomerMe("ada@example.invalid", "Ada", 2), api.me())
        assertEquals(listOf(expected), api.boards())
        assertEquals(expected, api.board("0123456789abcdef").board)
        assertEquals("connected", api.activity().single().what)
        assertEquals(
            listOf("$base/api/c/me", "$base/api/c/boards", "$base/api/c/boards/0123456789abcdef", "$base/api/c/activity"),
            calls.seen.map { it.first },
        )
        assertTrue(calls.seen.all { it.second == "CUSTOMER-TOKEN" })
        // Every address is under the customer API, never the console's routes.
        assertTrue(calls.seen.all { it.first.startsWith("$base/api/c/") })
        assertFalse(ApiPaths("https://console.example.invalid").me.contains("/api/c/"))
    }

    @Test
    fun `a board is asked for by its assignment id only, and a thing name never leaves the phone`() = runTest {
        val calls = Calls(mutableListOf())
        val api = CustomerApi(base, Tokens(), calls)
        for (id in listOf("cranium-0123456789abcdef", "0123456789ABCDEF", "../me", "")) {
            try {
                api.board(id)
                fail("$id was asked for")
            } catch (e: ApiError) {
                assertEquals(404, e.status)
                assertEquals("not_your_board", e.code)
                assertEquals("There is no board of yours at this address.", e.message)
            }
        }
        assertTrue(calls.seen.isEmpty())
    }

    @Test
    fun `a 401 is tried once more with a fresh token, and a second ends the session`() = runTest {
        val tokens = Tokens()
        val calls = Calls(mutableListOf(CustomerAnswer(401, ""), CustomerAnswer(200, """{"activity":[]}""")))
        assertEquals(emptyList<CustomerEvent>(), CustomerApi(base, tokens, calls).activity())
        assertEquals(listOf("CUSTOMER-TOKEN", "CUSTOMER-TOKEN-2"), calls.seen.map { it.second })
        assertEquals(0, tokens.forgotten)

        val ended = Tokens()
        val refused = Calls(mutableListOf(CustomerAnswer(401, ""), CustomerAnswer(401, "")))
        try {
            CustomerApi(base, ended, refused).boards()
            fail("signed in still")
        } catch (e: SignedOutException) {
            assertEquals("Your session has ended. Sign in again.", e.message)
        }
        assertEquals(1, ended.forgotten)
    }

    @Test
    fun `a refusal is in the API's own words, cleaned, and what cannot be read is said so`() = runTest {
        suspend fun refusal(status: Int, body: String): ApiError = try {
            CustomerApi(base, Tokens(), Calls(mutableListOf(CustomerAnswer(status, body)))).boards()
            throw AssertionError("not refused")
        } catch (e: ApiError) {
            e
        }
        val gone = refusal(403, """{"error":{"code":"account_inactive","message":"This account is switched off.\u0000\u202e"}}""")
        assertEquals(403, gone.status)
        assertEquals("account_inactive", gone.code)
        assertEquals("This account is switched off.", gone.message)
        val odd = refusal(500, """{"error":{"code":"Not-A-Word","message":"${"x".repeat(400)}"}}""")
        assertEquals("http", odd.code)
        assertEquals(300, odd.message!!.length)
        assertEquals("Something went wrong.", refusal(502, """{"message":""}""").message)
        val html = refusal(502, "<html>")
        assertEquals("unreadable", html.code)
        assertEquals("The server sent a reply this page could not read.", html.message)
        assertEquals("unreadable", refusal(200, """{"boards":"many"}""").code)
        assertEquals("unreadable", refusal(200, "[]").code)

        val calls = Calls(mutableListOf())
        calls.down = true
        try {
            CustomerApi(base, Tokens(), calls).me()
            fail("reached")
        } catch (e: ApiError) {
            assertEquals("network", e.code)
            assertEquals("Cranium could not be reached. Check the connection.", e.message)
        }
    }
}
