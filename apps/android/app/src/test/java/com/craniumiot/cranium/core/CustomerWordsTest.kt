package com.craniumiot.cranium.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.time.Instant

/**
 * The customer side's words, held to the customer site's own sources in this checkout
 * (cloud/web/src/customer/assets/customer-core.js, customer-views.js and customer.js, and the
 * console's core.js and views.js), as WebsiteListsTest holds the console's: ACCOUNT_WORDS and
 * SIGN_IN_WORDS are the website's maps, and every word of the customer screens is found there,
 * but for the few the phone has of its own. Then the words of a board, against the website's tests.
 * The source checks are skipped in a copy of the app without the console's sources.
 */
class CustomerWordsTest {
    private fun source(path: String): String? = generateSequence(File("").absoluteFile) { it.parentFile }
        .take(8)
        .map { File(it, path) }
        .firstOrNull { it.isFile }
        ?.readText()

    private fun required(path: String): String {
        val text = source(path)
        assumeTrue("$path is not in this checkout", text != null)
        return text!!
    }

    /** The text of `const NAME = Object.freeze({...})`, from its brace to the one that closes it. */
    private fun block(text: String, name: String): String {
        val start = Regex("""(?:export )?const $name = (?:Object\.freeze\()?\{""").find(text) ?: error("no $name")
        var depth = 0
        var quoted = false
        val from = start.range.last
        for (i in from until text.length) {
            val c = text[i]
            if (c == '\'' && text[i - 1] != '\\') quoted = !quoted
            if (!quoted) {
                if (c == '{') depth++
                if (c == '}') {
                    depth--
                    if (depth == 0) return text.substring(from, i + 1)
                }
            }
        }
        error("$name does not close")
    }

    private fun pairs(block: String): Map<String, String> =
        Regex("""(?:^|[\s{,])'?([A-Za-z_][A-Za-z0-9_-]*)'?: '((?:[^'\\]|\\.)*)'""").findAll(block)
            .associate { it.groupValues[1] to it.groupValues[2].replace("\\'", "'") }

    private val site: String
        get() = listOf(
            "cloud/web/src/customer/assets/customer-core.js",
            "cloud/web/src/customer/assets/customer-views.js",
            "cloud/web/src/customer/assets/customer.js",
            "cloud/web/src/site/assets/views.js",
        ).joinToString("\n") { required(it) }
            // A string the source writes in pieces ('...' +\n '...') reads as one, and the shortest
            // password is the number it is.
            .replace(Regex("""'\s*\+\s*'"""), "")
            .replace("\${PASSWORD_MIN}", "10")

    @Test
    fun `the account's and the sign-in's words are the website's, every one`() {
        val core = required("cloud/web/src/customer/assets/customer-core.js")
        assertEquals(pairs(block(core, "ACCOUNT_WORDS")), CustomerAccount.WORDS)
        val console = required("cloud/web/src/site/assets/core.js")
        assertEquals(pairs(block(console, "SIGN_IN_WORDS")), SignInWords.WORDS)
        assertEquals(10, Regex("""PASSWORD_MIN = (\d+)""").find(core)!!.groupValues[1].toInt())
        assertEquals(CustomerAccount.PASSWORD_MIN, 10)
    }

    @Test
    fun `every word of the customer screens is the customer site's`() {
        val text = site
        val missing = CustomerText.WEBSITE.filter { words -> !text.contains(words) && !text.contains(words.replace("'", "\\'")) }
        assertEquals("not in the customer site's sources", emptyList<String>(), missing)
        // The phone's own words are not the website's: had it them, they would be in WEBSITE.
        for (words in CustomerText.PHONE_ONLY) assertFalse(words, text.contains(words))
    }

    @Test
    fun `the mixes have the website's four tabs, and Help its four sections and eleven questions`() {
        val views = required("cloud/web/src/customer/assets/customer-views.js")
        val tabs = Regex("""MIX_TABS = Object\.freeze\(\[([^\]]*)\]""").find(required("cloud/web/src/customer/assets/customer-core.js"))!!
            .groupValues[1].split(',').map { it.trim().trim('\'') }
        assertEquals(tabs, CustomerText.MIX_TABS.map { it.id })
        assertEquals(4, CustomerText.HELP_SECTIONS.size)
        assertEquals(11, CustomerText.HELP_SECTIONS.sumOf { it.questions.size })
        // In the website's order.
        val order = CustomerText.HELP_SECTIONS.flatMap { section -> section.questions.map { it.question } }.map { views.indexOf(it.replace("'", "\\'")) }
        assertEquals(order.sorted(), order)
        assertTrue(order.all { it > 0 })
    }

    private val now = Instant.parse("2026-11-04T12:00:00.000Z").toEpochMilli()
    private val board = CustomerBoard(
        id = "0123456789abcdef", name = "Living room deck", boardName = "CRADA01", status = "online", online = true,
        lastSeen = "2026-11-04T11:59:40.000Z", firmware = CustomerFirmware("1.11.2+0", true),
        update = CustomerUpdate("idle", 0, "succeeded"), rssi = -58, uptime = 600, since = "2026-11-01T10:00:00.000Z",
    )

    @Test
    fun `what a board is doing, in plain words, for every state and every result`() {
        assertEquals(
            CustomerState(Tone.GOOD, Glyph.ONLINE, "Online", "Connected, and reporting every 30 seconds."),
            CustomerBoardWords.statusWords(board, now),
        )
        assertTrue(CustomerBoardWords.statusWords(board.copy(status = "offline", online = false), now).text.startsWith("Last heard from 20 s ago."))
        assertEquals("Not heard from yet", CustomerBoardWords.statusWords(board.copy(status = "new", lastSeen = null), now).label)
        assertEquals("Not heard from lately.", CustomerBoardWords.statusWords(board.copy(status = "offline", lastSeen = null), now).text)
        fun update(state: String = "idle", progress: Int = 0, last: String = "succeeded") =
            CustomerBoardWords.updateWords(board.copy(update = CustomerUpdate(state, progress, last)))
        assertEquals("Downloading an update: 40% so far.", update("downloading", 40))
        assertTrue(update("awaiting_user")!!.contains("press Button 1"))
        assertTrue(update("testing")!!.contains("within 5 minutes"))
        for (last in CustomerJson.RESULTS) assertTrue(last, !update(last = last).isNullOrEmpty())
        for (state in CustomerJson.UPDATE_STATES) assertTrue(state, !update(state).isNullOrEmpty())
        assertNull(CustomerBoardWords.updateWords(board.copy(update = null)))
        assertEquals("1.11.2", CustomerBoardWords.shortVersion("1.11.2+0"))
        assertEquals("1.11.2, build 3", CustomerBoardWords.shortVersion("1.11.2+3"))
        assertEquals("", CustomerBoardWords.shortVersion("1.11"))
        assertEquals("Your Cranium", CustomerBoardWords.boardTitle(board.copy(name = null)))
        assertEquals("Good", CustomerBoardWords.signalWords(-58))
        assertEquals("", CustomerBoardWords.signalWords(null))
    }

    @Test
    fun `how the boards stand, in a figure and a few words`() {
        val two = listOf(board, board.copy(id = "1123456789abcdef", online = false, status = "updating", firmware = CustomerFirmware("1.11.3+0", false), lastSeen = "2026-11-04T11:00:00.000Z"))
        val summary = CustomerBoardWords.summarize(two)
        assertEquals(CustomerSummary(2, 1, 1, listOf("1.11.2+0", "1.11.3+0"), "2026-11-04T11:59:40.000Z"), summary)
        assertEquals("1 of 2 online", CustomerBoardWords.onlineWords(summary))
        assertEquals("No boards yet", CustomerBoardWords.onlineWords(CustomerBoardWords.summarize(emptyList())))
        assertEquals("Online", CustomerBoardWords.onlineWords(CustomerBoardWords.summarize(listOf(board))))
        assertEquals("All 2 online", CustomerBoardWords.onlineWords(CustomerBoardWords.summarize(listOf(board, board))))
        assertEquals("Offline", CustomerBoardWords.onlineWords(CustomerBoardWords.summarize(listOf(board.copy(online = false)))))
        assertEquals("All 2 offline", CustomerBoardWords.onlineWords(CustomerBoardWords.summarize(listOf(board.copy(online = false), board.copy(online = false)))))
        // The first letters of the first two words, as customer-core.js initials has it.
        assertEquals("AL", CustomerBoardWords.initials("Ada Lovelace", null))
        assertEquals("AE", CustomerBoardWords.initials("", "ada@example.invalid"))
        assertEquals("AD", CustomerBoardWords.initials("ada", null))
        assertEquals("?", CustomerBoardWords.initials(null, null))
    }

    @Test
    fun `every event the website has words for reads in words, and none names AWS`() {
        val at = "2026-11-04T11:59:40.000Z"
        fun event(kind: String, what: String, version: String? = null, from: String? = null, to: String? = null, result: String? = null, state: String? = null, confirmed: Boolean? = null) =
            CustomerEvent(at, board.id, kind, what, version = version, from = from, to = to, result = result, state = state, confirmed = confirmed)
        val cases = listOf(
            event("connection", "connected"), event("connection", "disconnected"), event("firmware", "reported", version = "1.0.0+0"),
            event("firmware", "changed", version = "1.1.0+0", from = "1.0.0+0"), event("firmware", "confirmed"),
            event("update", "step", state = "downloading"), event("update", "step", state = "awaiting_user"),
            event("update", "result", result = "rolled_back"), event("restart", "restarted"), event("restart", "stuck"),
            event("bluetooth", "opened"), event("bluetooth", "closed"), event("bluetooth", "record", result = "succeeded", to = "1.2.0+0"),
        )
        for (case in cases) {
            val words = CustomerBoardWords.eventWords(case)
            assertNotEquals("${case.kind} ${case.what}", "Something changed", words.text)
            assertFalse(Regex("AWS|IoT|job|cranium-").containsMatchIn(words.text))
        }
        assertEquals("Firmware went from 1.0.0 to 1.1.0, on trial", CustomerBoardWords.eventWords(event("firmware", "changed", "1.1.0+0", "1.0.0+0", confirmed = false)).text)
        assertEquals("Updated to 1.2.0 over Bluetooth", CustomerBoardWords.eventWords(event("bluetooth", "record", to = "1.2.0+0", result = "succeeded")).text)
        assertEquals("Update to 1.3.0, build 2 finished", CustomerBoardWords.eventWords(event("update", "result", "1.3.0+2", result = "succeeded")).text)
        assertEquals("Something changed", CustomerBoardWords.eventWords(event("restart", "odd")).text)
        // The literal parts of these words are the website's.
        val core = required("cloud/web/src/customer/assets/customer-core.js")
        for (text in listOf("Came online", "Went offline", "Restarted itself to recover", "Opened its Bluetooth window for a phone", "An update over Bluetooth did not go through")) {
            assertTrue(text, core.contains("'$text'"))
        }
    }

    @Test
    fun `passwords of at least 10 characters, a setup key people can copy, and an address that opens an authenticator`() {
        assertEquals("too-short", CustomerAccount.passwordProblem("short", "short"))
        assertEquals("mismatch", CustomerAccount.passwordProblem("long enough", "long enougj"))
        assertNull(CustomerAccount.passwordProblem("long enough", "long enough"))
        assertEquals("ABCD EFGH IJKL MNOP", CustomerAccount.groupSecret("ABCDEFGHIJKLMNOP"))
        assertEquals("", CustomerAccount.groupSecret("not a secret"))
        assertEquals(
            "otpauth://totp/Cranium%3Aada%40example.invalid?secret=ABCDEFGHIJKLMNOP&issuer=Cranium",
            CustomerAccount.otpauthUri("ABCDEFGHIJKLMNOP", "ada@example.invalid"),
        )
        assertNull(CustomerAccount.otpauthUri("javascript:alert(1)", "x"))
        assertEquals("a%20b!~*'()%C3%A9", CustomerAccount.encodeUriComponent("a b!~*'()é"))
        assertEquals("wrong-password", CustomerAccount.problemOf("NotAuthorizedException", "change"))
        assertEquals("not-yet", CustomerAccount.problemOf("NotAuthorizedException", "forgot"))
        assertEquals("session-ended", CustomerAccount.problemOf("NotAuthorizedException", "profile"))
        assertEquals("wrong-code", CustomerAccount.problemOf("CodeMismatchException"))
        assertEquals("wrong-code", CustomerAccount.problemOf("EnableSoftwareTokenMFAException"))
        assertEquals("expired-code", CustomerAccount.problemOf("ExpiredCodeException"))
        assertEquals("weak-password", CustomerAccount.problemOf("InvalidPasswordException"))
        assertEquals("too-many", CustomerAccount.problemOf("LimitExceededException"))
        assertEquals("failed", CustomerAccount.problemOf("Whatever"))
        for (words in CustomerAccount.WORDS.values) assertTrue(words, words.endsWith("."))
    }
}
