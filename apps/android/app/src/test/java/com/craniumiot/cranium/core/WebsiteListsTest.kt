package com.craniumiot.cranium.core

import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/**
 * The app's word lists, read against the website's and the API's own sources in this checkout, so
 * that they cannot drift apart: core.js REFUSAL_WORDS, SERIAL_WORDS, SIGNED_IN_ON, COMMAND_WORDS,
 * AUDIT_ACTIONS and LINE_TAGS, serial.js RECORDED, and the API's serial.mjs SERIAL_COMMANDS and
 * lines.mjs TAGS and LINE_KINDS. Skipped in a copy of the app without the console's sources.
 */
class WebsiteListsTest {
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

    /**
     * The text of `const NAME = {...};` or `Object.freeze([...])`, from its opening bracket to the one
     * that closes it, without its `//` comments (whose apostrophes are not quotes).
     */
    private fun block(text: String, name: String): String {
        val start = Regex("""(?:export )?const $name = (?:Object\.freeze\(|new Set\()?([\[{])""").find(text) ?: error("no $name")
        val out = StringBuilder()
        var depth = 0
        var quoted = false
        var i = start.groups[1]!!.range.first
        while (i < text.length) {
            val c = text[i]
            if (!quoted && c == '/' && text.getOrNull(i + 1) == '/') {
                while (i < text.length && text[i] != '\n') i++
                continue
            }
            out.append(c)
            if (c == '\'' && text[i - 1] != '\\') quoted = !quoted
            if (!quoted) {
                if (c == '{' || c == '[') depth++
                if (c == '}' || c == ']') {
                    depth--
                    if (depth == 0) return out.toString()
                }
            }
            i++
        }
        error("$name does not close")
    }

    /** `key: 'words'` pairs, in their order. */
    private fun pairs(block: String): Map<String, String> =
        Regex("""(?:^|[\s{,])'?([A-Za-z_][A-Za-z0-9_.]*)'?: '((?:[^'\\]|\\.)*)'""").findAll(block)
            .associate { it.groupValues[1] to it.groupValues[2].replace("\\'", "'") }

    private fun strings(block: String): List<String> = Regex("""'([^']+)'""").findAll(block).map { it.groupValues[1] }.toList()

    private val core: String get() = required("cloud/web/src/site/assets/core.js")

    @Test
    fun `the refusal words are the website's, every one`() {
        assertEquals(pairs(block(core, "REFUSAL_WORDS")), AuditText.REFUSAL_WORDS)
    }

    @Test
    fun `the words of a serial console command, a sign-in and a command to a board are the website's`() {
        assertEquals(pairs(block(core, "SERIAL_WORDS")), AuditText.SERIAL_WORDS)
        assertEquals(pairs(block(core, "SIGNED_IN_ON")), AuditText.SIGNED_IN_ON)
        assertEquals(pairs(block(core, "COMMAND_WORDS")), AuditText.COMMAND_WORDS)
    }

    @Test
    fun `every action of the website's activity log reads in the app as it does there`() {
        val actions = block(core, "AUDIT_ACTIONS")
        val names = Regex("""^ {2}'([a-z_]+\.[a-z_]+)': \{""", RegexOption.MULTILINE).findAll(actions).map { it.groupValues[1] }.toList()
        assertEquals(53, names.size)
        for (name in names) {
            val body = block(actions.substring(actions.indexOf("'$name': {")).replaceFirst("'$name': ", "const X = "), "X")
            val words = pairs(body)
            fun said(entry: AuditEntry): String {
                val line = AuditText.describe(entry)
                return listOf(line.verb, line.label, line.tail).filter { it.isNotEmpty() }.joinToString(" ")
            }
            fun withLabel(text: String) = if ("{}" in text) text.replace("{}", "L") else "$text L"
            fun alone(text: String) = text.replace("{}", "a board").removeSuffix(" of")
            val done = words.getValue("done")
            assertEquals(name, withLabel(done), said(AuditEntry(null, null, name, "L", "ok", emptyList(), "")))
            assertEquals(name, alone(words["doneAlone"] ?: done), said(AuditEntry(null, null, name, "", "ok", emptyList(), "")))
            assertEquals(name, withLabel(words.getValue("tried")), said(AuditEntry(null, null, name, "L", "rejected", emptyList(), "")))
            assertEquals(name, alone(words.getValue("triedAlone")), said(AuditEntry(null, null, name, "", "denied", emptyList(), "")))
        }
    }

    @Test
    fun `the commands that go on record are the website's and the API's`() {
        val page = required("cloud/web/src/site/assets/serial.js")
        assertEquals(strings(block(page, "RECORDED")).toSet(), SerialRules.RECORDED)
        val api = required("cloud/api/src/handlers/serial.mjs")
        assertEquals(strings(block(api, "SERIAL_COMMANDS")).toSet(), SerialRules.RECORDED)
        assertEquals(listOf("command", "device", "version"), strings(block(api, "SERIAL_FIELDS")))
    }

    @Test
    fun `the board log's sources and kinds are the API's and the website's`() {
        val lines = required("cloud/api/src/lib/lines.mjs")
        assertEquals(strings(block(lines, "TAGS")), BoardLog.TAGS)
        assertEquals(strings(block(lines, "LINE_KINDS")), BoardLog.KINDS)
        assertEquals(strings(block(core, "LINE_TAGS")), BoardLog.TAGS)
        assertEquals(strings(block(core, "LINE_KINDS")), BoardLog.KINDS)
    }
}
