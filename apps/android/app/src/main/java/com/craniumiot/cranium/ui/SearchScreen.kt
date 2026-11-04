package com.craniumiot.cranium.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.IconButton
import androidx.compose.material3.SearchBarDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.craniumiot.cranium.core.Glyph
import com.craniumiot.cranium.core.HelpLoad
import com.craniumiot.cranium.core.Search
import com.craniumiot.cranium.core.SearchCatalog
import com.craniumiot.cranium.core.SearchHit
import com.craniumiot.cranium.core.SearchItem
import com.craniumiot.cranium.core.SearchKind
import com.craniumiot.cranium.core.SearchTarget

/**
 * Search across what the app has read: boards, releases, deployments, events, the activity log,
 * the app's own screens and actions, and Help. Results by kind, the match highlighted.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SearchScreen(vm: ConsoleViewModel, store: Store) {
    val colors = console
    val recent by vm.recentSearches.collectAsStateWithLifecycle()
    val help by vm.help.collectAsStateWithLifecycle()
    var query by rememberSaveable { mutableStateOf("") }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }

    val items = remember(store, help) { searchItems(store, help) }
    val hits = remember(query, items) { Search.rank(query, items) }
    val groups = remember(hits) { Search.grouped(hits) }
    val go = { item: SearchItem ->
        vm.rememberSearch(query)
        openTarget(vm, item.target)
    }

    Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.statusBars)) {
        SearchBarDefaults.InputField(
            query = query,
            onQueryChange = { query = it },
            onSearch = { if (it.isNotBlank()) vm.rememberSearch(it) },
            expanded = true,
            onExpandedChange = { expanded -> if (!expanded) vm.back() },
            modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp).focusRequester(focus),
            placeholder = { Text("Search boards, releases, help…", color = colors.ink3) },
            leadingIcon = { IconButton(onClick = { vm.back() }) { GlyphIcon(Glyph.ARROW_LEFT, description = "Back") } },
            trailingIcon = if (query.isNotEmpty()) ({ IconButton(onClick = { query = "" }) { GlyphIcon(Glyph.X, description = "Clear the search") } }) else null,
        )
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 32.dp)) {
            if (query.isBlank()) {
                if (recent.isEmpty()) {
                    item(key = "hint") { OneLine("Boards, versions, deployments, events, the activity log, screens and help.") }
                } else {
                    header("Recent")
                    for (past in recent) {
                        item(key = "recent-$past") {
                            ListRow(
                                past,
                                leading = { GlyphIcon(Glyph.HISTORY, tint = colors.ink3) },
                                trailing = { IconButton(onClick = { vm.forgetSearch(past) }) { GlyphIcon(Glyph.X, size = 16.dp, tint = colors.ink3, description = "Forget this search") } },
                                onClick = { query = past },
                                chevron = false,
                            )
                        }
                    }
                }
                return@LazyColumn
            }
            if (groups.isEmpty()) {
                item(key = "none") { OneLine("Nothing found for “${query.trim()}”.") }
                return@LazyColumn
            }
            for ((kind, kindHits) in groups) {
                header(kind.heading, key = "kind-${kind.name}")
                for (hit in kindHits) {
                    item(key = hit.item.id) {
                        ListRow(
                            hit.item.title,
                            headlineText = highlighted(hit.item.title, hit.titleRanges),
                            supportingText = hit.item.subtitle.takeIf { it.isNotEmpty() }?.let { highlighted(it, hit.subtitleRanges) },
                            mono = hit.item.kind == SearchKind.RELEASE,
                            leading = { GlyphIcon(glyphOf(hit), tint = colors.ink2) },
                            onClick = { go(hit.item) },
                        )
                    }
                }
            }
        }
    }
}

/** Everything there is to find, from what has been read. */
private fun searchItems(store: Store, help: HelpLoad): List<SearchItem> {
    val devices = store.deviceList.orEmpty()
    val audit = (store.audit.value?.entries.orEmpty() + store.recent.value?.entries.orEmpty())
        .distinctBy { activityKey(it) }
    return SearchCatalog.items(store.me?.canWrite == true) +
        Search.boards(devices) +
        Search.releases(store.releases.orEmpty()) +
        Search.deployments(store.deployments.value.orEmpty(), devices) +
        Search.events(store.events.data.value?.events.orEmpty(), devices) +
        Search.activity(audit) +
        ((help as? HelpLoad.Ok)?.let { Search.help(it.book) } ?: emptyList())
}

private fun highlighted(text: String, ranges: List<IntRange>): AnnotatedString = buildAnnotatedString {
    var at = 0
    for (range in ranges.sortedBy { it.first }) {
        val start = range.first.coerceIn(at, text.length)
        val end = (range.last + 1).coerceIn(start, text.length)
        append(text.substring(at, start))
        withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(text.substring(start, end)) }
        at = end
    }
    append(text.substring(at))
}

private fun glyphOf(hit: SearchHit): Glyph = when (hit.item.kind) {
    SearchKind.SCREEN -> Glyph.ARROW_RIGHT
    SearchKind.BOARD -> Glyph.CHIP
    SearchKind.RELEASE -> Glyph.PACKAGE
    SearchKind.DEPLOYMENT -> Glyph.SEND
    SearchKind.EVENT -> Glyph.PULSE
    SearchKind.ACTIVITY -> Glyph.LIST
    SearchKind.HELP -> Glyph.HELP
}

/** Where a result leads. */
private fun openTarget(vm: ConsoleViewModel, target: SearchTarget) {
    when (target) {
        is SearchTarget.Board -> vm.open(Route.Board(target.thing))
        is SearchTarget.Release -> vm.open(Route.Release(target.version))
        is SearchTarget.Deployment -> vm.open(Route.DeploymentPage(target.id))
        is SearchTarget.Event -> {
            vm.showEvent(target.key)
            vm.open(Route.Events)
        }
        is SearchTarget.Activity -> vm.open(routeOf(target.link) ?: Route.Activity)
        is SearchTarget.Help -> vm.open(Route.HelpPage(target.id))
        is SearchTarget.Screen -> when (target.id) {
            "overview" -> vm.open(Route.Overview)
            "boards" -> vm.open(Route.Boards)
            "firmware" -> vm.open(Route.Firmware)
            "events" -> vm.open(Route.Events)
            "deployments" -> vm.open(Route.Deployments)
            "activity" -> vm.open(Route.Activity)
            "tokens" -> vm.open(Route.Tokens)
            "history" -> vm.open(Route.History)
            "serial" -> vm.open(Route.Serial)
            "account" -> vm.open(Route.Account)
            "fingerprint" -> vm.open(Route.Account)
            "help" -> vm.open(Route.HelpPage(null))
            "deploy" -> vm.openDeploy(null)
            "upload" -> vm.open(Route.Upload)
            "bluetooth" -> vm.open(Route.Bluetooth(null))
            "signout" -> vm.signOut()
            else -> vm.open(Route.Overview)
        }
    }
}
