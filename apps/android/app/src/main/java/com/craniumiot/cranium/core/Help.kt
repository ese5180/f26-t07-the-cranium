package com.craniumiot.cranium.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.net.URI

/**
 * The Help topics, from `apps/shared/help.json`, which both phone apps read (the iPhone app's
 * Help.swift reads the same file the same way). Each topic is a list of blocks: a heading, a
 * paragraph, numbered steps, a list, rows of a label and its text, a note, links to other topics,
 * and links out.
 */
data class HelpBook(val version: Int, val sections: List<HelpSection>, val topics: List<HelpTopic>) {
    fun topic(id: String): HelpTopic? = topics.firstOrNull { it.id == id }
}

data class HelpSection(val title: String, val topics: List<String>)

data class HelpTopic(
    val id: String,
    val title: String,
    val summary: String,
    val keywords: List<String>,
    /** Where every fact of the topic comes from, in the repository. */
    val sources: List<String>,
    val blocks: List<HelpBlock>,
) {
    /** The topic's words, for search. */
    val plainText: String get() = blocks.joinToString(" ") { it.plainText }
}

sealed class HelpBlock {
    data class Heading(val text: String) : HelpBlock()
    data class Text(val text: String) : HelpBlock()
    data class Steps(val items: List<String>) : HelpBlock()

    /** "list" in the file. */
    data class Items(val items: List<String>) : HelpBlock()
    data class Rows(val rows: List<Pair<String, String>>) : HelpBlock()
    data class Note(val text: String) : HelpBlock()

    /** Other topics, by id. */
    data class See(val ids: List<String>) : HelpBlock()

    /** Links out: a title and an https address. */
    data class Links(val links: List<Pair<String, String>>) : HelpBlock()

    /** The words of the block, for search. */
    val plainText: String
        get() = when (this) {
            is Heading -> text
            is Text -> text
            is Note -> text
            is Steps -> items.joinToString(" ")
            is Items -> items.joinToString(" ")
            is Rows -> rows.joinToString(" ") { "${it.first} ${it.second}" }
            is See -> ""
            is Links -> links.joinToString(" ") { it.first }
        }
}

/** What reading the help came to: a book, a file that does not hold together, or no file in this build. */
sealed class HelpLoad {
    data class Ok(val book: HelpBook) : HelpLoad()
    data class Broken(val why: String) : HelpLoad()
    data object Missing : HelpLoad()
}

/** Reads `help.json`, and checks that it holds together, as the iPhone app's HelpBook.load does. */
object HelpReader {
    private val json = Json { ignoreUnknownKeys = true }

    private class Wrong(message: String) : Exception(message)

    private fun string(value: JsonElement?, what: String): String =
        (value as? JsonPrimitive)?.takeIf { it.isString }?.content ?: throw Wrong("$what is not text")

    private fun strings(value: JsonElement?, what: String): List<String> =
        (value as? JsonArray ?: throw Wrong("$what is not a list")).map { string(it, what) }

    private fun pairs(value: JsonElement?, what: String): List<Pair<String, String>> =
        (value as? JsonArray ?: throw Wrong("$what is not a list")).map { item ->
            val pair = strings(item, what)
            if (pair.size != 2) throw Wrong("$what holds an entry that is not two texts")
            pair[0] to pair[1]
        }

    private fun block(value: JsonElement): HelpBlock {
        val item = value as? JsonObject ?: throw Wrong("A block is not an object")
        if (item.size != 1) throw Wrong("A block has one kind, not ${item.size}")
        val (kind, content) = item.entries.first()
        return when (kind) {
            "heading" -> HelpBlock.Heading(string(content, "A heading"))
            "text" -> HelpBlock.Text(string(content, "A text"))
            "note" -> HelpBlock.Note(string(content, "A note"))
            "steps" -> HelpBlock.Steps(strings(content, "Steps"))
            "list" -> HelpBlock.Items(strings(content, "A list"))
            "see" -> HelpBlock.See(strings(content, "See"))
            "rows" -> HelpBlock.Rows(pairs(content, "Rows"))
            "links" -> HelpBlock.Links(
                pairs(content, "Links").onEach { (_, address) ->
                    val uri = runCatching { URI(address) }.getOrNull()
                    if (uri == null || uri.scheme != "https") throw Wrong("A link is not an https address: $address")
                },
            )
            else -> throw Wrong("A block of an unknown kind: $kind")
        }
    }

    private fun topic(value: JsonElement): HelpTopic {
        val item = value as? JsonObject ?: throw Wrong("A topic is not an object")
        val id = string(item["id"], "A topic's id")
        return HelpTopic(
            id = id,
            title = string(item["title"], "The title of $id"),
            summary = string(item["summary"], "The summary of $id"),
            keywords = item["keywords"]?.let { strings(it, "The keywords of $id") }.orEmpty(),
            sources = item["sources"]?.let { strings(it, "The sources of $id") }.orEmpty(),
            blocks = (item["blocks"] as? JsonArray ?: throw Wrong("$id has no blocks")).map(::block),
        )
    }

    /** The book in `text`, or why it cannot be used. */
    fun parse(text: String): HelpLoad {
        val book = try {
            val root = runCatching { json.parseToJsonElement(text) }.getOrNull() as? JsonObject
                ?: throw Wrong("The help file is not a JSON object")
            val version = (root["version"] as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toIntOrNull()
                ?: throw Wrong("The help file has no version")
            val sections = (root["sections"] as? JsonArray ?: throw Wrong("The help file has no sections")).map { raw ->
                val item = raw as? JsonObject ?: throw Wrong("A section is not an object")
                HelpSection(string(item["title"], "A section's title"), strings(item["topics"], "A section's topics"))
            }
            val topics = (root["topics"] as? JsonArray ?: throw Wrong("The help file has no topics")).map(::topic)
            HelpBook(version, sections, topics)
        } catch (e: Wrong) {
            return HelpLoad.Broken(e.message ?: "The help file cannot be read")
        }
        val ids = book.topics.map { it.id }
        ids.groupBy { it }.entries.firstOrNull { it.value.size > 1 }?.let { return HelpLoad.Broken("Two topics have the id ${it.key}") }
        val known = ids.toSet()
        val listed = book.sections.flatMap { it.topics }
        listed.firstOrNull { it !in known }?.let { return HelpLoad.Broken("A section names a topic that does not exist: $it") }
        ids.firstOrNull { it !in listed }?.let { return HelpLoad.Broken("A topic is in no section: $it") }
        for (topic in book.topics) {
            for (block in topic.blocks) {
                if (block is HelpBlock.See) {
                    block.ids.firstOrNull { it !in known }?.let { return HelpLoad.Broken("${topic.id} links to a topic that does not exist: $it") }
                }
            }
        }
        return HelpLoad.Ok(book)
    }
}
