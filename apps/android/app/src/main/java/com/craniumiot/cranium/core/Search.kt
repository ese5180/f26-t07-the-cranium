package com.craniumiot.cranium.core

import java.text.Normalizer
import java.util.Locale

// Search across what the app has loaded: boards, releases, deployments, events, the activity log,
// the app's own screens and actions, and the Help topics. Matching is case- and
// accent-insensitive, on the start of words and, less highly, anywhere inside them. The same
// rules and scores as the iPhone app's Search.swift, so that both apps find the same things.

/** What a result is, in the order its group is shown when scores tie. */
enum class SearchKind(val heading: String) {
    SCREEN("Screens and actions"),
    BOARD("Boards"),
    RELEASE("Releases"),
    DEPLOYMENT("Deployments"),
    EVENT("Events"),
    ACTIVITY("Activity"),
    HELP("Help"),
}

/** Where a result leads. */
sealed class SearchTarget {
    data class Board(val thing: String) : SearchTarget()
    data class Release(val version: String) : SearchTarget()
    data class Deployment(val id: String) : SearchTarget()

    /** An event: its board, and the event itself, to pick it on the timeline. */
    data class Event(val thing: String?, val key: String) : SearchTarget()

    /** An entry of the activity log: what it is about, if that has a page, else the log. */
    data class Activity(val link: LogLink?) : SearchTarget()

    /** One of the app's screens or actions, by its id in [SearchCatalog.SCREENS]. */
    data class Screen(val id: String) : SearchTarget()
    data class Help(val id: String) : SearchTarget()
}

/** Something that can be found. `keywords` is more text that matches and is not shown. */
data class SearchItem(
    val kind: SearchKind,
    val key: String,
    val title: String,
    val subtitle: String = "",
    val keywords: List<String> = emptyList(),
    val target: SearchTarget,
) {
    val id: String get() = "${kind.name}:$key"
}

/**
 * A match, with where it matched in the title and the subtitle: ranges of the text as it is
 * shown (String indices, end included), to highlight.
 */
data class SearchHit(val item: SearchItem, val score: Double, val titleRanges: List<IntRange>, val subtitleRanges: List<IntRange>)

object Search {
    /**
     * Text folded for matching, character by character, with where each folded character came
     * from in the original text: the first and the last String index of its code point, and of
     * any marks that followed it.
     */
    internal class Folded(text: String) {
        val chars: CharArray
        private val start: IntArray
        private val end: IntArray

        init {
            val chars = StringBuilder()
            val start = ArrayList<Int>()
            val end = ArrayList<Int>()
            var index = 0
            while (index < text.length) {
                val point = text.codePointAt(index)
                val width = Character.charCount(point)
                val folded = foldPoint(point)
                if (folded.isEmpty()) {
                    // A mark on its own, as in a decomposed "a" with its dots: part of the letter before it.
                    if (end.isNotEmpty()) end[end.size - 1] = index + width - 1
                } else {
                    for (character in folded) {
                        chars.append(character)
                        start += index
                        end += index + width - 1
                    }
                }
                index += width
            }
            this.chars = chars.toString().toCharArray()
            this.start = start.toIntArray()
            this.end = end.toIntArray()
        }

        val text: String get() = String(chars)

        /** Where `token` occurs: at the start of a word, and anywhere. */
        fun find(token: CharArray): Pair<Int?, Int?> {
            if (token.isEmpty() || token.size > chars.size) return null to null
            var anywhere: Int? = null
            for (at in 0..chars.size - token.size) {
                if (!matchesAt(at, token)) continue
                if (at == 0 || !isWordCharacter(chars[at - 1]) || !isWordCharacter(token[0])) return at to (anywhere ?: at)
                if (anywhere == null) anywhere = at
            }
            return null to anywhere
        }

        private fun matchesAt(at: Int, token: CharArray): Boolean {
            for (offset in token.indices) if (chars[at + offset] != token[offset]) return false
            return true
        }

        /** The original characters a folded range came from. */
        fun originalRange(at: Int, length: Int): IntRange = start[at]..end[at + length - 1]
    }

    private fun stripMarks(text: String): String =
        text.filter { Character.getType(it) != Character.NON_SPACING_MARK.toInt() && Character.getType(it) != Character.ENCLOSING_MARK.toInt() }

    /** One code point folded: compatibility forms (full width) to their plain ones, accents off, case folded. */
    private fun foldPoint(point: Int): String {
        val decomposed = stripMarks(Normalizer.normalize(String(Character.toChars(point)), Normalizer.Form.NFKD))
        // Upper then lower case folds what lower case alone does not, such as ß to ss.
        val cased = decomposed.uppercase(Locale.ROOT).lowercase(Locale.ROOT)
        return stripMarks(Normalizer.normalize(cased, Normalizer.Form.NFD))
    }

    /** Text folded for matching: case- and accent-insensitive, full width as plain. */
    fun fold(text: String): String = Folded(text).text

    internal fun isWordCharacter(character: Char): Boolean = Character.isLetterOrDigit(character)

    /**
     * The words of a query, folded: split on white space. Punctuation inside a word stays, so
     * that "1.11" finds the version 1.11.4+0.
     */
    fun tokens(query: String): List<String> =
        query.split(Regex("\\s+")).map { fold(it) }.filter { it.isNotEmpty() }

    /** The items that match every word of the query, best first. */
    fun rank(query: String, items: List<SearchItem>): List<SearchHit> {
        val words = tokens(query)
        if (words.isEmpty()) return emptyList()
        val whole = fold(query.trim())
        val hits = mutableListOf<SearchHit>()
        for (item in items) {
            val title = Folded(item.title)
            val subtitle = Folded(item.subtitle)
            val keywords = item.keywords.map(::Folded)
            var score = 0.0
            val titleRanges = mutableListOf<IntRange>()
            val subtitleRanges = mutableListOf<IntRange>()
            var matched = true
            for (word in words) {
                val token = word.toCharArray()
                val (titleStart, titleAnywhere) = title.find(token)
                val (subtitleStart, subtitleAnywhere) = subtitle.find(token)
                when {
                    titleStart != null -> {
                        score += if (titleStart == 0) 70 else 50
                        titleRanges += title.originalRange(titleStart, token.size)
                    }
                    titleAnywhere != null -> {
                        score += 25
                        titleRanges += title.originalRange(titleAnywhere, token.size)
                    }
                    subtitleStart != null -> {
                        score += 18
                        subtitleRanges += subtitle.originalRange(subtitleStart, token.size)
                    }
                    keywords.any { it.find(token).first != null } -> score += 15
                    subtitleAnywhere != null -> {
                        score += 6
                        subtitleRanges += subtitle.originalRange(subtitleAnywhere, token.size)
                    }
                    keywords.any { it.find(token).second != null } -> score += 4
                    else -> {
                        matched = false
                    }
                }
                if (!matched) break
            }
            if (!matched) continue
            val folded = title.text
            if (folded == whole) score += 200 else if (folded.startsWith(whole)) score += 60
            // Among equals, the shorter title is the closer match.
            score -= folded.length * 0.05
            hits += SearchHit(item, score, merged(titleRanges), merged(subtitleRanges))
        }
        return hits.sortedWith(
            compareByDescending<SearchHit> { it.score }.thenComparator { a, b -> String.CASE_INSENSITIVE_ORDER.compare(a.item.title, b.item.title) },
        )
    }

    /** The hits by kind, at most `limit` of each, the group with the best hit first. */
    fun grouped(hits: List<SearchHit>, limit: Int = 8): List<Pair<SearchKind, List<SearchHit>>> =
        SearchKind.entries
            .mapNotNull { kind -> hits.filter { it.item.kind == kind }.takeIf { it.isNotEmpty() }?.let { kind to it.take(limit) } }
            .sortedByDescending { it.second.first().score }

    internal fun merged(ranges: List<IntRange>): List<IntRange> {
        val out = mutableListOf<IntRange>()
        for (range in ranges.sortedBy { it.first }) {
            val last = out.lastOrNull()
            if (last != null && range.first <= last.last + 1) {
                out[out.size - 1] = last.first..maxOf(last.last, range.last)
            } else {
                out += range
            }
        }
        return out
    }

    // What can be found.

    private fun stateOf(device: Device): String = when {
        Updates.isRestarting(device) -> "Restarting"
        device.online -> "Online"
        device.lastSeen == null -> "Never connected"
        else -> "Offline"
    }

    fun boards(devices: List<Device>): List<SearchItem> = devices.map { device ->
        val firmware = device.fw?.let { "${it.version}${if (it.confirmed) "" else " on trial"}" } ?: "Firmware not reported"
        SearchItem(
            kind = SearchKind.BOARD,
            key = device.thing,
            title = Boards.name(device),
            subtitle = listOfNotNull(if (Boards.hasOwnName(device)) device.thing else null, stateOf(device), firmware).joinToString(" · "),
            keywords = listOf(device.thing, Updates.describeUpdate(device).label),
            target = SearchTarget.Board(device.thing),
        )
    }

    fun releases(releases: List<Release>): List<SearchItem> = releases.map { release ->
        SearchItem(
            kind = SearchKind.RELEASE,
            key = release.version,
            title = release.version,
            subtitle = listOf(if (release.isActive) "Active" else "Revoked", release.notes).filter { it.isNotEmpty() }.joinToString(" · "),
            keywords = listOf(release.revoked?.reason.orEmpty(), release.filename, Words.nameOf(release.uploadedBy)),
            target = SearchTarget.Release(release.version),
        )
    }

    fun deployments(deployments: List<DeploymentSummary>, devices: List<Device>): List<SearchItem> = deployments.map { deployment ->
        val names = deployment.things.map { thing -> Boards.name(Boards.of(thing, devices)) }
        val look = Updates.describeDeployment(deployment, devices)
        SearchItem(
            kind = SearchKind.DEPLOYMENT,
            key = deployment.id,
            title = "Deployment of ${deployment.version ?: "unknown version"}",
            subtitle = "${look.label} · ${names.joinToString(", ")}",
            keywords = listOf(deployment.id, deployment.note, Words.nameOf(deployment.createdBy)) + deployment.things,
            target = SearchTarget.Deployment(deployment.id),
        )
    }

    /** The boards' events. The Console lane's entries are found as activity, not here. */
    fun events(events: List<BoardEvent>, devices: List<Device>): List<SearchItem> = events.mapNotNull { event ->
        val thing = event.thing ?: return@mapNotNull null
        val key = Telemetry.eventKey(event)
        SearchItem(
            kind = SearchKind.EVENT,
            key = key,
            title = event.text,
            subtitle = "${Boards.name(Boards.of(thing, devices))} · ${Telemetry.kindOf(event.kind).label} · ${Words.dateAndTime(event.at)}",
            keywords = listOf(thing, event.what),
            target = SearchTarget.Event(thing, key),
        )
    }

    fun activity(entries: List<AuditEntry>): List<SearchItem> = entries.map { entry ->
        val words = AuditText.describe(entry)
        SearchItem(
            kind = SearchKind.ACTIVITY,
            key = "${entry.at.orEmpty()}#${entry.requestId}",
            title = AuditText.sentence(entry),
            subtitle = Words.dateAndTime(entry.at),
            keywords = listOf(entry.action, entry.target, entry.actor?.sub.orEmpty()) + words.facts.map { it.value },
            target = SearchTarget.Activity(words.link),
        )
    }

    fun help(book: HelpBook): List<SearchItem> = book.topics.map { topic ->
        SearchItem(
            kind = SearchKind.HELP,
            key = topic.id,
            title = topic.title,
            subtitle = topic.summary,
            keywords = topic.keywords + topic.plainText,
            target = SearchTarget.Help(topic.id),
        )
    }
}

/** The app's own screens and actions, so that "API tokens" or "sign out" can be searched for. */
object SearchCatalog {
    /** `changes`: only for a release manager. */
    data class Screen(val id: String, val title: String, val subtitle: String, val keywords: List<String>, val changes: Boolean)

    val SCREENS: List<Screen> = listOf(
        Screen("overview", "Overview", "Updates in progress, boards online, the newest release", listOf("home", "summary", "fleet"), false),
        Screen("boards", "Boards", "Every board, as it last reported", listOf("devices", "diagnostics", "online"), false),
        Screen("firmware", "Firmware", "Every release on AWS", listOf("releases", "images"), false),
        Screen("events", "Events", "What every board did", listOf("timeline", "log", "history"), false),
        Screen("deployments", "Deployments", "Releases offered to boards over the internet", listOf("updates", "ota", "jobs"), false),
        Screen("activity", "Activity", "Who changed what, and when", listOf("audit", "log"), false),
        Screen("tokens", "API tokens", "Tokens for scripts that use the console as you", listOf("token", "script", "ota.sh", "key"), false),
        Screen("history", "History", "The project's commits", listOf("commits", "git", "changes"), false),
        Screen("serial", "Serial console", "Drive a board on its USB cable", listOf("usb", "cable", "terminal", "uart"), true),
        Screen("account", "Account", "Who is signed in, and the firmware kept on this phone", listOf("profile", "role", "email"), false),
        Screen("help", "Help", "How updates work, the LEDs, troubleshooting", listOf("guide", "faq"), false),
        Screen("deploy", "Deploy a release", "Offer a release to boards over the internet", listOf("new deployment", "update", "ota", "wifi"), true),
        Screen("upload", "Upload firmware", "Register a signed image", listOf("new release", "signed.bin", "image"), true),
        Screen("bluetooth", "Update over Bluetooth", "Send a release to a board in the room", listOf("ble", "passkey", "phone"), true),
        Screen("signout", "Sign out", "Forget the sign-in and the firmware on this phone", listOf("log out", "logout"), false),
    )

    fun items(canWrite: Boolean): List<SearchItem> =
        SCREENS.filter { canWrite || !it.changes }.map {
            SearchItem(SearchKind.SCREEN, it.id, it.title, it.subtitle, it.keywords, SearchTarget.Screen(it.id))
        }
}

/** The last searches, newest first, at most [LIMIT]. Kept on the phone by the app and cleared at sign-out. */
object RecentSearches {
    const val LIMIT = 10

    /** Keeps `query` first. The same search, in other case or spacing, is kept once. A blank one changes nothing. */
    fun add(list: List<String>, query: String): List<String> {
        val trimmed = query.trim()
        if (trimmed.isEmpty()) return list
        val folded = Search.tokens(trimmed)
        return (listOf(trimmed) + list.filter { Search.tokens(it) != folded }).take(LIMIT)
    }

    fun remove(list: List<String>, query: String): List<String> = list.filter { it != query }
}
