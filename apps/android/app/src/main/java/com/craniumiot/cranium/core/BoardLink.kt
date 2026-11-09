package com.craniumiot.cranium.core

import java.net.URI
import java.net.URISyntaxException

/**
 * A board's QR code, as Scan board reads it (apps/shared/bridge.json `camera.scan`; docs/mobile-apps.md
 * "Scan board"). The console prints `<console>/#/devices/<thing>` on a board's label (labels.js); the app
 * opens that page only when the link is exactly that, on the console of the app's own configuration. The
 * website checks a link by the same rules (labels.js readBoardLink), and so does the iPhone app
 * (BoardLink.swift).
 */
object BoardLink {
    /** Why a code is not opened; [message] is what the page is told, with not_allowed. */
    enum class Refusal(val message: String) {
        NOT_A_LINK("That code is not a link to a board."),
        OTHER_CONSOLE("That code is for another console, so the app did not open it."),
        NOT_A_BOARD("That code is not a board’s page on this console."),
    }

    sealed interface Result {
        data class Board(val thing: String) : Result

        data class Refused(val refusal: Refusal) : Result
    }

    const val MAX_LENGTH = 2048
    private const val PREFIX = "/devices/"
    private val THING = Regex("^[A-Za-z0-9_:-]{1,128}$")

    private data class Origin(val scheme: String, val host: String, val port: Int)

    private fun parse(text: String): URI? = try {
        URI(text)
    } catch (e: URISyntaxException) {
        null
    }

    private fun defaultPort(scheme: String) = when (scheme) {
        "https" -> 443
        "http" -> 80
        else -> -1
    }

    /** The console's origin as a label has it, or null: https, or plain http on this computer, nothing past it. */
    private fun origin(console: String): Origin? {
        val uri = parse(console) ?: return null
        val scheme = uri.scheme?.lowercase() ?: return null
        val host = uri.host?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
        if (uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null) return null
        if ((uri.rawPath ?: "") !in setOf("", "/")) return null
        if (scheme != "https" && !(scheme == "http" && host in setOf("localhost", "127.0.0.1"))) return null
        return Origin(scheme, host, if (uri.port == -1) defaultPort(scheme) else uri.port)
    }

    /** The board's thing name in a scanned code, or why the app does not open it. */
    fun thing(text: String, console: String): Result {
        if (text.toByteArray(Charsets.UTF_8).size > MAX_LENGTH) return Result.Refused(Refusal.NOT_A_LINK)
        val own = origin(console) ?: return Result.Refused(Refusal.NOT_A_LINK)
        val uri = parse(text) ?: return Result.Refused(Refusal.NOT_A_LINK)
        val scheme = uri.scheme?.lowercase() ?: return Result.Refused(Refusal.NOT_A_LINK)
        val host = uri.host?.lowercase()?.takeIf { it.isNotEmpty() } ?: return Result.Refused(Refusal.NOT_A_LINK)
        val port = if (uri.port == -1) defaultPort(scheme) else uri.port
        if (scheme != own.scheme || host != own.host || port != own.port || uri.rawUserInfo != null) {
            return Result.Refused(Refusal.OTHER_CONSOLE)
        }
        if ((uri.rawPath ?: "") !in setOf("", "/") || uri.rawQuery != null) return Result.Refused(Refusal.NOT_A_BOARD)
        val fragment = uri.rawFragment ?: return Result.Refused(Refusal.NOT_A_BOARD)
        if (!fragment.startsWith(PREFIX)) return Result.Refused(Refusal.NOT_A_BOARD)
        val thing = fragment.removePrefix(PREFIX)
        return if (THING.matches(thing)) Result.Board(thing) else Result.Refused(Refusal.NOT_A_BOARD)
    }
}
