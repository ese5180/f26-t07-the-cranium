package com.craniumiot.cranium.core

import com.craniumiot.cranium.api.AccessTokens
import com.craniumiot.cranium.auth.SignedOutException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.io.IOException

/*
 * The customer side (docs/mobile-apps.md, "Customers"; docs/customer-site.md): a customer's own
 * boards from the customer API, read as the customer site reads them
 * (cloud/web/src/customer/assets/customer-core.js: readBoard, readEvent, createCustomerApi).
 *
 * A board is named by the id of its assignment, 16 hex digits, never by its thing name, which the
 * customer API never sends. What arrives is reduced to known shapes on the way in; anything else in
 * an answer is left out. Nothing here is logged.
 */

data class CustomerFirmware(val version: String, val confirmed: Boolean)

data class CustomerUpdate(val state: String, val progress: Int, val last: String)

/** A board as its owner sees it (customer/boards.mjs customerBoard). */
data class CustomerBoard(
    /** The assignment id: how the customer API and this app address the board. */
    val id: String,
    /** What the admin called it, or what it calls itself; null for neither. */
    val name: String?,
    /** Its own device name, which it was set up with. */
    val boardName: String?,
    /** online, updating, restarting, offline or new. */
    val status: String,
    val online: Boolean,
    val lastSeen: String?,
    val firmware: CustomerFirmware?,
    val update: CustomerUpdate?,
    val rssi: Int?,
    val uptime: Long?,
    /** Not reported by any board yet (docs/fleet.md, location by Wi-Fi). */
    val location: String? = null,
    /** When it became this customer's. */
    val since: String?,
)

/** One event of a board, as its owner sees it: the typed fields only. */
data class CustomerEvent(
    val at: String,
    val board: String,
    val kind: String,
    val what: String,
    val version: String? = null,
    val from: String? = null,
    val to: String? = null,
    val confirmed: Boolean? = null,
    val result: String? = null,
    val state: String? = null,
    val progress: Int? = null,
)

data class CustomerMe(val email: String, val name: String, val boards: Int)

data class CustomerBoardDetail(val board: CustomerBoard, val activity: List<CustomerEvent>)

/** Reading the customer API's answers into those shapes, as customer-core.js does. */
object CustomerJson {
    val BOARD_ID = Regex("^[0-9a-f]{16}$")
    private val VERSION = Regex("""^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,4})\+(0|[1-9]\d{0,9})$""")
    val STATUSES = listOf("online", "updating", "restarting", "offline", "new")
    val UPDATE_STATES = listOf("idle", "awaiting_user", "downloading", "verifying", "rebooting", "testing", "bluetooth")
    val RESULTS = listOf("none", "succeeded", "failed", "rolled_back", "declined", "refused", "cancelled")
    val KINDS = listOf("connection", "firmware", "update", "restart", "bluetooth")
    private val WHAT = Regex("^[a-z][a-z_]{0,23}$")
    private val WORD = Regex("^[a-z][a-z_]{0,31}$")
    private val TIME = Regex("""^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$""")
    private val NAME = Regex("^[A-Za-z0-9]{1,32}$")
    // What an admin called a board: printable ASCII and Latin letters, as the website keeps it.
    private val NOT_LABEL = Regex("[^\\x20-\\x7e\\u00a0-\\u024f]")
    private val json = Json { ignoreUnknownKeys = true }

    const val UNREADABLE = "The server sent a reply this page could not read."

    private fun str(value: JsonElement?): String? = (value as? JsonPrimitive)?.takeIf { it.isString }?.content

    private fun instant(value: JsonElement?): String? = str(value)?.takeIf { TIME.matches(it) }

    private fun version(value: JsonElement?): String? = str(value)?.takeIf { VERSION.matches(it) }

    /** One line of an admin's text, cut to its printable part and to 40 characters. */
    fun label(text: String?): String = text?.replace(NOT_LABEL, "")?.take(40) ?: ""

    fun unreadable() = ApiError(0, "unreadable", UNREADABLE)

    /** A board, or null if it is not one. */
    fun readBoard(raw: JsonElement?): CustomerBoard? {
        val item = raw as? JsonObject ?: return null
        val id = str(item["id"])?.takeIf { BOARD_ID.matches(it) } ?: return null
        val status = str(item["status"])?.takeIf { it in STATUSES } ?: return null
        val fw = item["firmware"] as? JsonObject
        val firmware = version(fw?.get("version"))?.let { CustomerFirmware(it, J.bool(fw?.get("confirmed"))) }
        val up = item["update"] as? JsonObject
        val update = str(up?.get("state"))?.takeIf { it in UPDATE_STATES }?.let { state ->
            CustomerUpdate(
                state = state,
                progress = J.int(up?.get("progress"), 0, 100) ?: 0,
                last = str(up?.get("last"))?.takeIf { it in RESULTS } ?: "none",
            )
        }
        return CustomerBoard(
            id = id,
            name = (item["name"] as? JsonPrimitive)?.takeIf { it.isString }?.let { label(it.content) }?.ifEmpty { null },
            boardName = str(item["boardName"])?.takeIf { NAME.matches(it) },
            status = status,
            online = J.bool(item["online"]),
            lastSeen = instant(item["lastSeen"]),
            firmware = firmware,
            update = update,
            rssi = J.int(item["rssi"], -127, 0),
            uptime = J.whole(item["uptime"], 0, 1L shl 32),
            location = null,
            since = instant(item["since"]),
        )
    }

    /** One event of a board, or null if it is not one. */
    fun readEvent(raw: JsonElement?): CustomerEvent? {
        val item = raw as? JsonObject ?: return null
        val at = instant(item["at"]) ?: return null
        val kind = str(item["kind"])?.takeIf { it in KINDS } ?: return null
        val what = str(item["what"])?.takeIf { WHAT.matches(it) } ?: return null
        val board = str(item["board"])?.takeIf { BOARD_ID.matches(it) } ?: return null
        val confirmed = (item["confirmed"] as? JsonPrimitive)?.takeIf { !it.isString && (it.content == "true" || it.content == "false") }
            ?.content?.toBooleanStrict()
        return CustomerEvent(
            at = at,
            board = board,
            kind = kind,
            what = what,
            version = version(item["version"]),
            from = version(item["from"]),
            to = version(item["to"]),
            confirmed = confirmed,
            result = str(item["result"])?.takeIf { WORD.matches(it) },
            state = str(item["state"])?.takeIf { it in UPDATE_STATES },
            progress = J.int(item["progress"], 0, 100),
        )
    }

    private fun root(text: String): JsonObject =
        runCatching { json.parseToJsonElement(text) }.getOrNull() as? JsonObject ?: throw unreadable()

    private fun <T> list(value: JsonElement?, read: (JsonElement?) -> T?): List<T> =
        J.arr(value)?.mapNotNull(read) ?: throw unreadable()

    fun me(text: String): CustomerMe {
        val body = root(text)
        return CustomerMe(
            email = str(body["email"])?.take(320).orEmpty(),
            name = label(str(body["name"])),
            boards = J.int(body["boards"], 0, 10000) ?: 0,
        )
    }

    fun boards(text: String): List<CustomerBoard> = list(root(text)["boards"], ::readBoard)

    fun board(text: String): CustomerBoardDetail {
        val body = root(text)
        val board = readBoard(body["board"]) ?: throw unreadable()
        return CustomerBoardDetail(board, list(body["activity"], ::readEvent))
    }

    fun activity(text: String): List<CustomerEvent> = list(root(text)["activity"], ::readEvent)

    /**
     * The error of an answer that is not 200: the API's own message, printable and at most 300
     * characters, and its code if it is a word. An answer that is not JSON cannot be read.
     */
    fun error(status: Int, text: String): ApiError {
        val body = runCatching { json.parseToJsonElement(text) }.getOrNull() ?: throw unreadable()
        // kotlinx reads a bare word such as <html> as a value, where JSON.parse refuses it.
        if (body is JsonPrimitive && !body.isString && body.content !in setOf("true", "false", "null") && body.content.toDoubleOrNull() == null) {
            throw unreadable()
        }
        val detail = J.obj((body as? JsonObject)?.get("error"))
        val message = str(detail?.get("message"))?.replace(Regex("[^\\x20-\\x7e]"), "")?.take(300).orEmpty()
        val code = str(detail?.get("code"))?.takeIf { WORD.matches(it) } ?: "http"
        return ApiError(status, code, message.ifEmpty { "Something went wrong." })
    }
}

/** One GET of the customer API: the status and the body, or an IOException when it cannot be reached. */
fun interface CustomerTransport {
    suspend fun get(url: String, token: String): CustomerAnswer
}

class CustomerAnswer(val status: Int, val body: String)

/**
 * The customer API (cloud/api/src/customer/app.mjs) with the customer's access token, at
 * `{customerApiUrl}/api/c/...` and nowhere else: never the console's API. On a 401 the token is
 * refreshed once and the call made again; a second 401 ends the session.
 */
class CustomerApi(base: String, private val auth: AccessTokens, private val transport: CustomerTransport) {
    private val root = "${base.trimEnd('/')}/api/c"

    suspend fun me(): CustomerMe = CustomerJson.me(get("$root/me"))

    suspend fun boards(): List<CustomerBoard> = CustomerJson.boards(get("$root/boards"))

    /** One board and its last 30 days, by its assignment id. Anything else is refused here, as 404. */
    suspend fun board(id: String): CustomerBoardDetail {
        if (!CustomerJson.BOARD_ID.matches(id)) throw ApiError(404, "not_your_board", NOT_YOURS)
        return CustomerJson.board(get("$root/boards/$id"))
    }

    /** Every board's last week, newest first. */
    suspend fun activity(): List<CustomerEvent> = CustomerJson.activity(get("$root/activity"))

    /** The address of a route, for the tests: always under the customer API. */
    fun url(path: String): String = "$root/$path"

    private suspend fun get(url: String): String {
        var answer = fetch(url, auth.accessToken())
        if (answer.status == 401) {
            answer = fetch(url, auth.accessToken(forceRefresh = true))
            if (answer.status == 401) {
                auth.forget()
                throw SignedOutException(ENDED)
            }
        }
        if (answer.status !in 200..299) throw CustomerJson.error(answer.status, answer.body)
        return answer.body
    }

    private suspend fun fetch(url: String, token: String): CustomerAnswer = try {
        transport.get(url, token)
    } catch (e: IOException) {
        throw ApiError(0, "network", NETWORK)
    }

    companion object {
        const val ENDED = "Your session has ended. Sign in again."
        const val NETWORK = "Cranium could not be reached. Check the connection."
        const val NOT_YOURS = "There is no board of yours at this address."
    }
}

/** A state of a board in words: how it is shown (tone, icon), a word, and a sentence. */
data class CustomerState(val tone: Tone, val glyph: Glyph, val label: String, val text: String)

/** One event in words. */
data class CustomerEventWords(val glyph: Glyph, val text: String)

/** How the boards stand, for the overview's figures. */
data class CustomerSummary(val total: Int, val online: Int, val busy: Int, val versions: List<String>, val lastSeen: String?)

/** What a board is doing, as its owner reads it: customer-core.js, word for word. */
object CustomerBoardWords {
    /** "1.11.2", or "1.11.2, build 3" when the build is not 0. */
    fun shortVersion(text: String?): String {
        val parts = FirmwareVersion.parseStrict(text.orEmpty()) ?: return ""
        val base = "${parts.major}.${parts.minor}.${parts.revision}"
        return if (parts.build == 0L) base else "$base, build ${parts.build}"
    }

    fun boardTitle(board: CustomerBoard?): String = board?.name ?: "Your Cranium"

    private class Words(val tone: Tone, val glyph: Glyph, val label: String)

    private val STATUS = mapOf(
        "online" to Words(Tone.GOOD, Glyph.ONLINE, "Online"),
        "updating" to Words(Tone.LIVE, Glyph.DOWNLOAD, "Updating"),
        "restarting" to Words(Tone.LIVE, Glyph.RESTART, "Restarting"),
        "offline" to Words(Tone.IDLE, Glyph.OFFLINE, "Offline"),
        "new" to Words(Tone.IDLE, Glyph.CLOCK, "Not heard from yet"),
    )

    fun statusWords(board: CustomerBoard, nowMs: Long): CustomerState {
        val words = STATUS[board.status] ?: STATUS.getValue("offline")
        val seen = board.lastSeen?.let { com.craniumiot.cranium.core.Words.timeAgo(it, nowMs) }.orEmpty()
        val text = when (board.status) {
            "online" -> "Connected, and reporting every 30 seconds."
            "updating" -> "Installing an update that Cranium sent."
            "restarting" -> "Restarting to finish an update. This takes a few minutes."
            "offline" -> if (seen.isNotEmpty()) "Last heard from $seen. It reports again once it is on and on Wi-Fi." else "Not heard from lately."
            "new" -> "It has not reported yet. Switch it on and connect it to Wi-Fi."
            else -> ""
        }
        return CustomerState(words.tone, words.glyph, words.label, text)
    }

    /** What a board's update says, in a sentence, or null when there is nothing to say. */
    fun updateWords(board: CustomerBoard): String? {
        val update = board.update ?: return null
        return when (update.state) {
            "awaiting_user" -> "An update is waiting at the board: press Button 1 on it to install the update."
            "downloading" -> "Downloading an update: ${update.progress}% so far."
            "verifying" -> "Checking the update it has downloaded."
            "rebooting" -> "Restarting into the new firmware."
            "testing" -> "Trying the new firmware. If it cannot reach Cranium within 5 minutes, it goes back to the firmware it had."
            "bluetooth" -> "Its Bluetooth window is open, for an update from a phone."
            else -> LAST[update.last]
        }
    }

    private val LAST = mapOf(
        "succeeded" to "The last update finished.",
        "failed" to "The last update did not finish, and the board kept the firmware it had.",
        "rolled_back" to "The last update did not stick, so the board went back to the firmware it had before.",
        "declined" to "The last update was declined at the board.",
        "refused" to "The board turned the last update down.",
        "cancelled" to "The last update was called off before it was installed.",
        "none" to "No update has run on it yet.",
    )

    /** Wi-Fi signal in a word, or "". */
    fun signalWords(rssi: Int?): String = com.craniumiot.cranium.core.Words.signalQuality(rssi)?.label.orEmpty()

    fun summarize(boards: List<CustomerBoard>): CustomerSummary {
        val versions = boards.mapNotNull { it.firmware?.version }.distinct()
        val seen = boards.mapNotNull { it.lastSeen }.sorted()
        return CustomerSummary(
            total = boards.size,
            online = boards.count { it.online },
            busy = boards.count { it.status == "updating" || it.status == "restarting" },
            versions = versions,
            lastSeen = seen.lastOrNull(),
        )
    }

    /** "2 of 3 online", "All 2 online", "Offline". */
    fun onlineWords(summary: CustomerSummary): String = when {
        summary.total == 0 -> "No boards yet"
        summary.online == summary.total -> if (summary.total == 1) "Online" else "All ${summary.total} online"
        summary.online == 0 -> if (summary.total == 1) "Offline" else "All ${summary.total} offline"
        else -> "${summary.online} of ${summary.total} online"
    }

    /** One event in words. */
    fun eventWords(event: CustomerEvent): CustomerEventWords {
        val v = event.version?.let(::shortVersion).orEmpty()
        return when ("${event.kind} ${event.what}") {
            "connection connected" -> CustomerEventWords(Glyph.ONLINE, "Came online")
            "connection disconnected" -> CustomerEventWords(Glyph.OFFLINE, "Went offline")
            "firmware reported" -> CustomerEventWords(Glyph.CHIP, if (v.isNotEmpty()) "Running firmware $v" else "Reported its firmware")
            "firmware changed" -> CustomerEventWords(
                Glyph.PACKAGE,
                (if (event.from != null) "Firmware went from ${shortVersion(event.from)} to $v" else "Firmware is now $v") +
                    if (event.confirmed == false) ", on trial" else "",
            )
            "firmware confirmed" -> CustomerEventWords(
                Glyph.CHECK,
                if (v.isNotEmpty()) "Kept firmware $v after its trial" else "Kept its new firmware after its trial",
            )
            "update step" -> if (event.state == "awaiting_user") {
                CustomerEventWords(Glyph.PRESS, if (v.isNotEmpty()) "Update to $v waits for Button 1" else "An update waits for Button 1")
            } else {
                CustomerEventWords(Glyph.DOWNLOAD, if (v.isNotEmpty()) "Started downloading $v" else "Started downloading an update")
            }
            "update result" -> when (event.result) {
                "succeeded" -> CustomerEventWords(Glyph.CHECK_CIRCLE, if (v.isNotEmpty()) "Update to $v finished" else "An update finished")
                "failed" -> CustomerEventWords(Glyph.X_CIRCLE, "An update did not finish; the board kept its firmware")
                "rolled_back" -> CustomerEventWords(Glyph.UNDO, "An update did not stick; the board went back to its firmware")
                "declined" -> CustomerEventWords(Glyph.MINUS_CIRCLE, "An update was declined at the board")
                "refused" -> CustomerEventWords(Glyph.MINUS_CIRCLE, "The board turned an update down")
                "cancelled" -> CustomerEventWords(Glyph.STOP, "An update was called off")
                else -> CustomerEventWords(Glyph.MINUS, "An update ended")
            }
            "restart stuck" -> CustomerEventWords(Glyph.RESTART, "Restarted itself to recover")
            "restart restarted", "restart boot" -> CustomerEventWords(Glyph.RESTART, "Restarted")
            "bluetooth opened" -> CustomerEventWords(Glyph.SHIELD, "Opened its Bluetooth window for a phone")
            "bluetooth closed" -> CustomerEventWords(Glyph.SHIELD, "Closed its Bluetooth window")
            "bluetooth record" -> if (event.result == "succeeded" && event.to != null) {
                CustomerEventWords(Glyph.CHECK_CIRCLE, "Updated to ${shortVersion(event.to)} over Bluetooth")
            } else {
                CustomerEventWords(Glyph.MINUS_CIRCLE, "An update over Bluetooth did not go through")
            }
            else -> CustomerEventWords(Glyph.MINUS, "Something changed")
        }
    }

    /** Two letters for a person, from their name or their address. */
    fun initials(name: String?, email: String?): String {
        val source = (name?.ifEmpty { null } ?: email.orEmpty()).trim()
        if (source.isEmpty()) return "?"
        val words = source.split(Regex("[\\s@._-]+")).filter { it.isNotEmpty() }
        val letters = if (words.size > 1) "${words[0][0]}${words[1][0]}" else source.take(2)
        return letters.uppercase()
    }
}
