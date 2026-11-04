package com.craniumiot.cranium.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.craniumiot.cranium.core.Glyph
import com.craniumiot.cranium.core.Times
import com.craniumiot.cranium.core.Tone
import com.craniumiot.cranium.core.Words
import kotlinx.coroutines.launch

/** An action of a screen: its one primary action, or one of its menu. */
data class ScreenAction(val label: String, val glyph: Glyph? = null, val danger: Boolean = false, val onClick: () -> Unit)

/** What the frame gives every screen: going back, Search and Help. */
class Chrome(
    val canGoBack: Boolean,
    val onBack: () -> Unit,
    val onSearch: () -> Unit,
    val onHelp: (String?) -> Unit,
)

val LocalChrome = staticCompositionLocalOf { Chrome(false, {}, {}, {}) }

/** That what a screen shows may be old: it could not be read again, or not for a while. */
data class Stale(val words: String, val onRefresh: () -> Unit)

/**
 * Whether a screen's data is out of date: the last read failed, or it is older than three
 * times its interval (at least 90 s). Null while it is current: then nothing is shown.
 */
fun staleOf(resources: List<Resource<*>>, intervalMs: Long, now: Long, onRefresh: () -> Unit): Stale? {
    val read = resources.filter { it.loadedAt > 0 }
    val failed = resources.firstOrNull { it.error != null && it.value != null }
    val oldest = read.minByOrNull { it.loadedAt }?.loadedAt ?: return null
    val age = now - oldest
    val limit = maxOf(90_000L, 3 * intervalMs)
    return when {
        failed != null -> Stale("Could not refresh. Last read ${Words.timeAgo(Times.iso(oldest), now)}.", onRefresh)
        intervalMs > 0 && age > limit -> Stale("Not up to date. Last read ${Words.timeAgo(Times.iso(oldest), now)}.", onRefresh)
        else -> null
    }
}

/**
 * A screen of the app: a top bar with the way back, Search, Help and a menu, an optional line
 * under the title, one primary action, and a list that can be pulled to refresh.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConsoleScreen(
    title: String,
    subtitle: String? = null,
    help: String? = null,
    actions: List<ScreenAction> = emptyList(),
    primary: ScreenAction? = null,
    stale: Stale? = null,
    onRefresh: (suspend () -> Unit)? = null,
    titleMono: Boolean = false,
    content: LazyListScope.() -> Unit,
) {
    val colors = console
    val chrome = LocalChrome.current
    Scaffold(
        containerColor = colors.paper,
        contentColor = colors.ink,
        contentWindowInsets = androidx.compose.foundation.layout.WindowInsets(0, 0, 0, 0),
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        title,
                        Modifier.semantics { heading() },
                        style = if (titleMono) ConsoleType.mono.copy(fontSize = 19.sp, fontWeight = FontWeight.SemiBold) else ConsoleType.sectionTitle.copy(fontSize = 20.sp),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                },
                navigationIcon = {
                    if (chrome.canGoBack) {
                        IconButton(onClick = chrome.onBack) { GlyphIcon(Glyph.ARROW_LEFT, size = 22.dp, description = "Back") }
                    }
                },
                actions = {
                    if (stale != null) {
                        IconButton(onClick = stale.onRefresh) { GlyphIcon(Glyph.CLOCK, size = 20.dp, tint = colors.warn, description = stale.words) }
                    }
                    IconButton(onClick = chrome.onSearch) { GlyphIcon(Glyph.SEARCH, size = 22.dp, description = "Search") }
                    if (help != null) {
                        IconButton(onClick = { chrome.onHelp(help) }) { GlyphIcon(Glyph.HELP, size = 22.dp, description = "Help") }
                    }
                    if (actions.isNotEmpty()) OverflowMenu(actions)
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = colors.paper,
                    scrolledContainerColor = colors.surface,
                    titleContentColor = colors.ink,
                    navigationIconContentColor = colors.ink,
                    actionIconContentColor = colors.ink2,
                ),
            )
        },
        floatingActionButton = {
            if (primary != null) {
                ExtendedFloatingActionButton(
                    text = { Text(primary.label, style = ConsoleType.button) },
                    icon = { primary.glyph?.let { GlyphIcon(it, size = 20.dp) } },
                    onClick = primary.onClick,
                    containerColor = colors.accent,
                    contentColor = colors.onAccent,
                )
            }
        },
    ) { padding ->
        var refreshing by remember { mutableStateOf(false) }
        val scope = rememberCoroutineScope()
        val list: @Composable () -> Unit = {
            LazyColumn(
                Modifier.fillMaxSize(),
                contentPadding = PaddingValues(bottom = if (primary != null) 96.dp else 32.dp),
            ) {
                if (subtitle != null) {
                    item(key = "subtitle") {
                        Text(subtitle, Modifier.padding(horizontal = Gutter).padding(bottom = 8.dp), style = ConsoleType.small, color = colors.ink2)
                    }
                }
                if (stale != null) {
                    item(key = "stale") {
                        Text(stale.words, Modifier.padding(horizontal = Gutter).padding(bottom = 8.dp), style = ConsoleType.note, color = colors.ink3)
                    }
                }
                content()
            }
        }
        Box(Modifier.fillMaxSize().padding(padding)) {
            if (onRefresh != null) {
                PullToRefreshBox(
                    isRefreshing = refreshing,
                    onRefresh = {
                        scope.launch {
                            refreshing = true
                            onRefresh()
                            refreshing = false
                        }
                    },
                    modifier = Modifier.fillMaxSize(),
                ) { list() }
            } else {
                list()
            }
        }
    }
}

@Composable
private fun OverflowMenu(actions: List<ScreenAction>) {
    var open by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { open = true }) { GlyphIcon(Glyph.MORE_VERT, size = 22.dp, description = "More options") }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }, containerColor = console.surface) {
            for (action in actions) {
                DropdownMenuItem(
                    text = { Text(action.label, color = if (action.danger) console.bad else console.ink) },
                    leadingIcon = if (action.glyph != null) {
                        { GlyphIcon(action.glyph, tint = if (action.danger) console.bad else console.ink2) }
                    } else {
                        null
                    },
                    onClick = {
                        open = false
                        action.onClick()
                    },
                )
            }
        }
    }
}

// Rows.

/** A short section header (`.card-head`), in a list. */
fun LazyListScope.header(text: String, key: String = "header-$text") {
    item(key = key) { SectionHeader(text) }
}

@Composable
fun SectionHeader(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        modifier.fillMaxWidth().padding(start = Gutter, end = Gutter, top = 24.dp, bottom = 4.dp).semantics { heading() },
        style = ConsoleType.small.copy(fontWeight = FontWeight.SemiBold),
        color = console.accent,
    )
}

/** A standard row: a headline, a line under it, and what stands at either side. */
@Composable
fun ListRow(
    headline: String,
    modifier: Modifier = Modifier,
    supporting: String? = null,
    overline: String? = null,
    mono: Boolean = false,
    leading: (@Composable () -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
    trailingText: String? = null,
    onClick: (() -> Unit)? = null,
    chevron: Boolean = onClick != null,
    headlineColor: Color? = null,
    headlineText: AnnotatedString? = null,
    supportingText: AnnotatedString? = null,
) {
    val colors = console
    ListItem(
        headlineContent = {
            Text(
                headlineText ?: AnnotatedString(headline),
                style = if (mono) ConsoleType.mono.copy(fontSize = 15.sp) else ConsoleType.body,
                color = headlineColor ?: colors.ink,
            )
        },
        modifier = modifier.then(if (onClick != null) Modifier.clickableRow(onClick) else Modifier),
        overlineContent = overline?.let { { Text(it, style = ConsoleType.note, color = colors.ink3) } },
        supportingContent = when {
            supportingText != null -> ({ Text(supportingText, style = ConsoleType.small, color = colors.ink2) })
            supporting != null -> ({ Text(prose(supporting), style = ConsoleType.small, color = colors.ink2) })
            else -> null
        },
        leadingContent = leading,
        trailingContent = if (trailing != null || trailingText != null || chevron) {
            {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    trailingText?.let { Text(it, style = ConsoleType.small, color = colors.ink2) }
                    trailing?.invoke()
                    if (chevron) GlyphIcon(Glyph.ARROW_RIGHT, size = 16.dp, tint = colors.ink3)
                }
            }
        } else {
            null
        },
        colors = ListItemDefaults.colors(containerColor = colors.paper),
    )
}

private fun Modifier.clickableRow(onClick: () -> Unit): Modifier = this.clickable(role = Role.Button, onClick = onClick)

/** A label and its value: the value is what the eye is after, the label says what it is. */
@Composable
fun ValueRow(
    label: String,
    value: String,
    supporting: String? = null,
    mono: Boolean = false,
    onClick: (() -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
) {
    ListRow(
        headline = value,
        supporting = supporting,
        overline = label,
        mono = mono,
        trailing = trailing,
        onClick = onClick,
    )
}

/** A thin rule between groups of rows. */
@Composable
fun Rule() {
    HorizontalDivider(Modifier.padding(horizontal = Gutter), color = console.line)
}

/** A dot of a state, beside a row. */
@Composable
fun StateDot(tone: Tone) {
    Box(Modifier.size(10.dp).clip(CircleShape).background(if (tone == Tone.IDLE) console.line else console.toneBar(tone)).clearAndSetSemantics {})
}

/** Nothing here, or something went wrong: one line, and at most one thing to do. */
@Composable
fun OneLine(text: String, action: Pair<String, () -> Unit>? = null, tone: Tone = Tone.IDLE, glyph: Glyph? = null) {
    val colors = console
    Row(
        Modifier.fillMaxWidth().padding(horizontal = Gutter, vertical = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (glyph != null) GlyphIcon(glyph, tint = colors.toneInk(tone))
        Text(prose(text), Modifier.weight(1f), style = ConsoleType.small, color = if (tone == Tone.BAD) colors.ink else colors.ink2)
        if (action != null) ConsoleButton(action.first, action.second, small = true)
    }
}

/** What could not be read, in one line, with Try again. */
fun LazyListScope.problem(error: Throwable?, what: String, hasValue: Boolean, onRetry: () -> Unit) {
    if (error == null || hasValue) return
    item(key = "problem-$what") {
        OneLine("Could not load $what. ${messageOf(error)}", "Try again" to onRetry, Tone.BAD, Glyph.ALERT)
    }
}

/** Loading, in one line. */
fun LazyListScope.loading(what: String) {
    item(key = "loading-$what") { Loading(what, Modifier.padding(horizontal = Gutter)) }
}

/** A block of free-form content in a list, with the page's gutter. */
fun LazyListScope.block(key: String, content: @Composable () -> Unit) {
    item(key = key) { Column(Modifier.fillMaxWidth().padding(horizontal = Gutter, vertical = 8.dp)) { content() } }
}
