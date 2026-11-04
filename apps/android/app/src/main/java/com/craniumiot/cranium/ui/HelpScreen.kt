package com.craniumiot.cranium.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.craniumiot.cranium.core.Glyph
import com.craniumiot.cranium.core.HelpBlock
import com.craniumiot.cranium.core.HelpBook
import com.craniumiot.cranium.core.HelpLoad
import com.craniumiot.cranium.core.HelpTopic
import com.craniumiot.cranium.core.Tone

/**
 * The names the app's screens use for a topic that the help file names otherwise. A topic the
 * file does not have opens the list of topics.
 */
private val ALIASES = mapOf(
    "bluetooth" to "bluetooth-update",
    "board" to "board-states",
    "boards" to "boards-and-diagnostics",
    "firmware" to "firmware-and-signing",
    "release" to "firmware-and-signing",
    "upload" to "firmware-and-signing",
    "tokens" to "api-tokens",
    "deploy" to "wifi-update",
    "sign-in" to "trouble-sign-in",
)

private fun HelpBook.find(id: String?): HelpTopic? = id?.let { topic(it) ?: ALIASES[it]?.let(::topic) }

/** Help: the topics of apps/shared/help.json, by section, and one topic at a time. */
@Composable
fun HelpScreen(vm: ConsoleViewModel, topicId: String?) {
    val load by vm.help.collectAsStateWithLifecycle()
    val book = (load as? HelpLoad.Ok)?.book
    val topic = book?.find(topicId)
    ConsoleScreen(title = topic?.title ?: "Help") {
        when (val current = load) {
            HelpLoad.Missing -> item(key = "missing") { OneLine("This build has no help.") }
            is HelpLoad.Broken -> item(key = "broken") { OneLine("The help in this build could not be read: ${current.why}", tone = Tone.BAD, glyph = Glyph.ALERT) }
            is HelpLoad.Ok -> if (topic == null) index(vm, current.book) else topicPage(vm, current.book, topic)
        }
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.index(vm: ConsoleViewModel, book: HelpBook) {
    for (section in book.sections) {
        header(section.title, key = "section-${section.title}")
        for (id in section.topics) {
            val topic = book.topic(id) ?: continue
            item(key = "topic-$id") { ListRow(topic.title, supporting = topic.summary, onClick = { vm.open(Route.HelpPage(id)) }) }
        }
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.topicPage(vm: ConsoleViewModel, book: HelpBook, topic: HelpTopic) {
    block("summary") { Text(topic.summary, style = ConsoleType.lede, color = console.ink2) }
    topic.blocks.forEachIndexed { index, part ->
        val key = "block-$index"
        when (part) {
            is HelpBlock.Heading -> header(part.text, key = key)
            is HelpBlock.Text -> block(key) { Text(part.text, style = ConsoleType.body, color = console.ink) }
            is HelpBlock.Note -> block(key) { Notice(Tone.IDLE, Glyph.ALERT, part.text) }
            is HelpBlock.Steps -> block(key) {
                part.items.forEachIndexed { number, step ->
                    Row(Modifier.padding(vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text("${number + 1}.", Modifier.width(22.dp), style = ConsoleType.body.copy(fontWeight = FontWeight.SemiBold), color = console.accent)
                        Text(step, Modifier.weight(1f), style = ConsoleType.body, color = console.ink)
                    }
                }
            }
            is HelpBlock.Items -> block(key) {
                for (entry in part.items) {
                    Row(Modifier.padding(vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text("•", style = ConsoleType.body, color = console.ink3)
                        Text(entry, Modifier.weight(1f), style = ConsoleType.body, color = console.ink)
                    }
                }
            }
            is HelpBlock.Rows -> part.rows.forEachIndexed { row, (label, text) ->
                item(key = "$key-$row") { ValueRow(label, text) }
            }
            is HelpBlock.See -> {
                header("See also", key = "$key-head")
                for (id in part.ids) {
                    val other = book.topic(id) ?: continue
                    item(key = "$key-$id") { ListRow(other.title, supporting = other.summary, onClick = { vm.open(Route.HelpPage(id)) }) }
                }
            }
            is HelpBlock.Links -> part.links.forEachIndexed { link, (title, url) ->
                item(key = "$key-$link") { LinkRow(title, url) }
            }
        }
    }
}

@Composable
private fun LinkRow(title: String, url: String) {
    val uri = LocalUriHandler.current
    ListRow(title, supporting = url.removePrefix("https://"), leading = { GlyphIcon(Glyph.ARROW_RIGHT, tint = console.ink2) }, onClick = { uri.openUri(url) }, chevron = false)
}
