package com.craniumiot.cranium.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.IconButton
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.craniumiot.cranium.BuildConfig
import com.craniumiot.cranium.core.BiometricState
import com.craniumiot.cranium.core.CommitHistory
import com.craniumiot.cranium.core.CustomerText
import com.craniumiot.cranium.core.FingerprintWords
import com.craniumiot.cranium.core.Glyph
import com.craniumiot.cranium.core.HistoryRead
import com.craniumiot.cranium.core.Times
import com.craniumiot.cranium.core.Tone
import com.craniumiot.cranium.core.Words

/** The rest of the console's sections, and what only the phone does. */
@Composable
fun MoreScreen(vm: ConsoleViewModel, store: Store) {
    val canWrite = store.me?.canWrite == true
    val exits = LocalAdminExits.current
    val newApp = com.craniumiot.cranium.shell.LocalNewApp.current
    ConsoleScreen(title = "More") {
        header("Console")
        item(key = "deployments") { ListRow("Deployments", leading = { GlyphIcon(Glyph.SEND, tint = console.ink2) }, onClick = { vm.open(Route.Deployments) }) }
        item(key = "activity") { ListRow("Activity", leading = { GlyphIcon(Glyph.LIST, tint = console.ink2) }, onClick = { vm.open(Route.Activity) }) }
        header("This phone")
        if (canWrite) {
            item(key = "bluetooth") { ListRow("Update over Bluetooth", leading = { GlyphIcon(Glyph.BLUETOOTH, tint = console.ink2) }, onClick = { vm.open(Route.Bluetooth(null)) }) }
        }
        item(key = "serial") {
            ListRow(
                "Serial console", supporting = if (canWrite) null else "For release managers",
                leading = { GlyphIcon(Glyph.TERMINAL, tint = console.ink2) }, onClick = { vm.open(Route.Serial) },
            )
        }
        header("Developer")
        item(key = "board-setup") {
            ListRow(
                "Board setup", supporting = "On a computer",
                leading = { GlyphIcon(Glyph.USB, tint = console.ink2) }, onClick = { vm.open(Route.BoardSetup) },
            )
        }
        item(key = "tokens") { ListRow("API tokens", leading = { GlyphIcon(Glyph.KEY, tint = console.ink2) }, onClick = { vm.open(Route.Tokens) }) }
        item(key = "history") { ListRow("History", leading = { GlyphIcon(Glyph.HISTORY, tint = console.ink2) }, onClick = { vm.open(Route.History) }) }
        header("You")
        item(key = "help") { ListRow("Help", leading = { GlyphIcon(Glyph.HELP, tint = console.ink2) }, onClick = { vm.open(Route.HelpPage(null)) }) }
        item(key = "account") {
            ListRow("Account", supporting = store.me?.email, leading = { GlyphIcon(Glyph.USER, tint = console.ink2) }, onClick = { vm.open(Route.Account) })
        }
        exits?.let { exits ->
            item(key = "leave-admin") {
                ListRow(CustomerText.LEAVE_ADMIN_MODE, leading = { GlyphIcon(Glyph.ARROW_LEFT, tint = console.ink2) }, onClick = exits.leave)
            }
        }
        // The classic app, from 0.8.0: back to the new one (shell/, docs/mobile-apps.md "The app shell").
        newApp?.let { open ->
            item(key = "new-app") {
                ListRow("Use the new app", supporting = "The classic app's screens are for this version only", leading = { GlyphIcon(Glyph.ARROW_LEFT, tint = console.ink2) }, onClick = open)
            }
        }
    }
}

// API tokens.

private fun tokenTone(status: String): Tone = when (status) {
    "active" -> Tone.GOOD
    "revoked" -> Tone.BAD
    else -> Tone.IDLE
}

private fun tokenLife(token: com.craniumiot.cranium.core.ApiToken, now: Long): String = when (token.status) {
    "revoked" -> "Revoked ${Words.timeAgo(token.revokedAt, now)}"
    "expired" -> "Expired ${Words.timeAgo(token.expiresAt, now)}"
    else -> "Expires ${until(token.expiresAt, now)}"
}

@Composable
fun TokensScreen(vm: ConsoleViewModel, store: Store, now: Long) {
    val listing = store.tokens.value
    val active = listing?.tokens?.count { it.status == "active" } ?: 0
    val full = listing != null && active >= listing.limit
    ConsoleScreen(
        title = "API tokens",
        subtitle = listing?.let { "$active in use, of the ${it.limit} you may have" + if (store.me?.canWrite == false) "; yours only read" else "" },
        help = "api-tokens",
        primary = if (listing != null && !full) ScreenAction("New token", Glyph.PLUS) { vm.openCreateToken() } else null,
        stale = staleOf(listOf(store.tokens), vm.intervalOf(Route.Tokens), now, vm::refreshNow),
        onRefresh = { vm.refresh(Route.Tokens, full = true) },
    ) {
        problem(store.tokens.error, "your API tokens", listing != null, vm::refreshNow)
        when {
            listing == null -> if (store.tokens.error == null) loading("your API tokens")
            listing.tokens.isEmpty() -> item(key = "none") { OneLine("You have no API tokens.", "New token" to vm::openCreateToken) }
            else -> {
                if (full) item(key = "full") { OneLine("As many as you may have: revoke one you no longer use first.", tone = Tone.WARN, glyph = Glyph.ALERT) }
                for (token in listing.tokens) {
                    item(key = token.id) {
                        ListRow(
                            token.name,
                            supporting = tokenLife(token, now),
                            leading = { StateDot(tokenTone(token.status)) },
                            onClick = { vm.open(Route.TokenPage(token.id)) },
                            headlineColor = if (token.status == "active") null else console.ink2,
                        )
                    }
                }
            }
        }
    }
}

/** One token: what it is, and, only here, revoking it. */
@Composable
fun TokenScreen(vm: ConsoleViewModel, store: Store, id: String, now: Long) {
    val token = store.tokens.value?.tokens?.firstOrNull { it.id == id }
    ConsoleScreen(
        title = token?.name ?: "API token",
        help = "api-tokens",
        actions = if (token?.status == "active") listOf(ScreenAction("Revoke", Glyph.BAN, danger = true) { vm.openRevokeToken(token) }) else emptyList(),
    ) {
        if (token == null) {
            item(key = "missing") { OneLine("This token is no longer listed.", "API tokens" to { vm.open(Route.Tokens) }) }
            return@ConsoleScreen
        }
        item(key = "status") {
            ListRow(
                when (token.status) {
                    "active" -> "Active"
                    "revoked" -> "Revoked"
                    else -> "Expired"
                },
                overline = "Status",
                leading = { StateDot(tokenTone(token.status)) },
            )
        }
        item(key = "id") { ValueRow("ID", token.id, mono = true, supporting = "How the list and the activity log name it") }
        item(key = "made") { ValueRow("Made", Words.timeAgo(token.createdAt, now), supporting = Words.exactTime(token.createdAt)) }
        item(key = "life") { ValueRow(if (token.status == "active") "Expires" else "Ended", tokenLife(token, now), supporting = Words.exactTime(token.expiresAt)) }
    }
}

// History.

@Composable
fun HistoryScreen(vm: ConsoleViewModel, store: Store, now: Long) {
    val uri = LocalUriHandler.current
    var shownTag by rememberSaveable { mutableStateOf("all") }
    val read = store.history.value
    val history = (read as? HistoryRead.Read)?.history
    val built = history?.commits?.firstOrNull { it.hash == history.builtFrom }
    ConsoleScreen(
        title = "History",
        subtitle = history?.let {
            listOfNotNull(
                "Built from ${built?.short ?: it.builtFrom?.take(7) ?: "an unknown commit"}",
                when (it.tree) {
                    "clean" -> "clean"
                    "dirty" -> "not clean"
                    else -> null
                },
                it.deployedAt?.takeIf { at -> Times.parse(at) != null }?.let { at -> "deployed ${Words.timeAgo(at, now)}" },
            ).joinToString(" · ")
        },
        help = "about",
        onRefresh = { vm.refresh(Route.History, full = true) },
    ) {
        problem(store.history.error, "the history", read != null, vm::refreshNow)
        when (read) {
            null -> if (store.history.error == null) loading("the history")
            HistoryRead.Missing -> item(key = "missing") { OneLine("This deployment of the console has no history file.") }
            is HistoryRead.Failed -> item(key = "failed") { OneLine(read.why, "Try again" to vm::refreshNow, Tone.BAD, Glyph.ALERT) }
            is HistoryRead.Read -> {
                val commits = read.history.commits
                item(key = "filter") {
                    Row(
                        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = Gutter),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        for ((tag, label) in listOf("all" to "All") + CommitHistory.TAGS) {
                            val count = if (tag == "all") commits.size else commits.count { tag in it.tags }
                            FilterChip(
                                selected = shownTag == tag,
                                onClick = { shownTag = tag },
                                label = { Text("$label $count") },
                                colors = FilterChipDefaults.filterChipColors(selectedContainerColor = console.accentWash, selectedLabelColor = console.ink),
                            )
                        }
                    }
                }
                val shown = if (shownTag == "all") commits else commits.filter { shownTag in it.tags }
                if (shown.isEmpty()) item(key = "none") { OneLine("No commit here touched that.") }
                var day: String? = null
                for (commit in shown) {
                    val label = Words.dayLabel(commit.date, now)
                    if (label != day) {
                        day = label
                        header(label, key = "day-$label")
                    }
                    item(key = commit.hash) {
                        ListRow(
                            commit.subject,
                            supporting = listOfNotNull(
                                commit.short,
                                Words.timeOfDay(commit.date),
                                if (commit.hash == read.history.builtFrom) "this deployment" else null,
                                commit.tags.mapNotNull(CommitHistory::tagLabel).joinToString(", ").ifEmpty { null },
                            ).joinToString(" · "),
                            onClick = { uri.openUri(commit.link) },
                        )
                    }
                }
            }
        }
    }
}

// The account.

/** Fingerprint unlock: on or off, with a (?) for its Help topic. */
@Composable
private fun FingerprintRow(vm: ConsoleViewModel) {
    val fingerprint by vm.fingerprint.collectAsStateWithLifecycle()
    val chrome = LocalChrome.current
    val ready = fingerprint.state == BiometricState.READY
    val enabled = !fingerprint.busy && (fingerprint.on || ready)
    ListRow(
        FingerprintWords.SETTING,
        modifier = Modifier.toggleable(
            value = fingerprint.on,
            enabled = enabled,
            role = Role.Switch,
            onValueChange = vm::setFingerprint,
        ),
        supporting = when {
            fingerprint.on -> "Asked when the app opens, and after 5 minutes away"
            !ready -> FingerprintWords.state(fingerprint.state)
            else -> "Instead of your password and code, for up to 30 days"
        },
        leading = { GlyphIcon(Glyph.FINGERPRINT, tint = console.ink2) },
        trailing = {
            IconButton(onClick = { chrome.onHelp(FINGERPRINT_HELP) }) {
                GlyphIcon(Glyph.HELP, size = 20.dp, tint = console.ink2, description = "Help on fingerprint unlock")
            }
            // The row is the switch for TalkBack; this one only shows it.
            Switch(
                checked = fingerprint.on,
                onCheckedChange = null,
                enabled = enabled,
                modifier = Modifier.clearAndSetSemantics {},
                colors = SwitchDefaults.colors(checkedTrackColor = console.accent, checkedThumbColor = console.onAccent),
            )
        },
        chevron = false,
    )
}

@Composable
fun AccountScreen(vm: ConsoleViewModel, store: Store, now: Long) {
    val me = store.me
    val exits = LocalAdminExits.current
    ConsoleScreen(
        title = "Account",
        help = "sign-in-again",
        actions = if (store.cache.count > 0) listOf(ScreenAction("Clear downloaded firmware", Glyph.X) { vm.clearFirmware() }) else emptyList(),
        onRefresh = { vm.refresh(Route.Account, full = true) },
    ) {
        if (me == null) {
            loading("the account")
            return@ConsoleScreen
        }
        item(key = "email") { ValueRow("E-mail", me.email.ifEmpty { "Signed in" }) }
        item(key = "role") { ValueRow("Role", if (me.canWrite) "Release manager" else "Viewer", supporting = if (me.canWrite) null else "Sees everything, changes nothing") }
        if (me.sub.isNotEmpty()) item(key = "sub") { ValueRow("Account", me.sub, mono = true) }
        me.expiresAt?.let { expires ->
            item(key = "session") {
                val left = expires - now / 1000
                ValueRow("Session", if (left > 0) "Token renews in ${Words.duration(left)}" else "Token renews on the next request")
            }
        }
        header("This phone")
        item(key = "fingerprint") { FingerprintRow(vm) }
        item(key = "cache") { ValueRow("Firmware on this phone", Messages.firmwareOnPhone(store.cache).removeSuffix(".")) }
        item(key = "version") { ValueRow("App version", BuildConfig.VERSION_NAME) }
        exits?.let { exits ->
            block("leave-admin") {
                ConsoleButton(CustomerText.LEAVE_ADMIN_MODE, exits.leave, Modifier.fillMaxWidth().padding(top = 16.dp), glyph = Glyph.ARROW_LEFT)
            }
        }
        block("sign-out") {
            ConsoleButton("Sign out", vm::signOut, Modifier.fillMaxWidth().padding(top = 16.dp), glyph = Glyph.SIGN_OUT)
        }
    }
}
