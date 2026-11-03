package com.craniumiot.cranium.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.craniumiot.cranium.BuildConfig
import com.craniumiot.cranium.core.ApiToken
import com.craniumiot.cranium.core.CommitHistory
import com.craniumiot.cranium.core.Glyph
import com.craniumiot.cranium.core.HistoryRead
import com.craniumiot.cranium.core.Times
import com.craniumiot.cranium.core.Tone
import com.craniumiot.cranium.core.Words

/** The rest of the website's sections, and what only the phone does. */
@Composable
fun MoreScreen(vm: ConsoleViewModel, store: Store) {
    val canWrite = store.me?.canWrite == true
    PageHead("More", lede = "The rest of the console, and what only the phone does: updates over Bluetooth and the serial console over USB.")
    Section(title = "Console") {
        MoreRow(Glyph.SEND, "Deployments", "Every deployment, with each board’s steps.") { vm.open(Route.Deployments) }
        MoreRow(Glyph.LIST, "Activity", "Every change made through the console’s API, and who asked for it.") { vm.open(Route.Activity) }
    }
    Section(title = "Developer") {
        MoreRow(Glyph.TERMINAL, "Serial console", if (canWrite) "Drive a board on its USB cable from this phone." else "For release managers.") {
            vm.open(Route.Serial)
        }
        MoreRow(Glyph.HISTORY, "History", "Every change to the project, newest first.") { vm.open(Route.History) }
        MoreRow(Glyph.KEY, "API tokens", "Tokens for scripts that use the console as you.") { vm.open(Route.Tokens) }
    }
    Section(title = "This phone") {
        if (canWrite) {
            MoreRow(Glyph.BLUETOOTH, "Update over Bluetooth", "Send a release to a board in reach, after a press of Button 1 at the board.") {
                vm.open(Route.Bluetooth(null))
            }
        }
        MoreRow(Glyph.USER, "Account", "Who is signed in, the role, and signing out.") { vm.open(Route.Account) }
    }
}

@Composable
private fun MoreRow(glyph: Glyph, title: String, text: String, onClick: () -> Unit) {
    val colors = console
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .drawBehind { drawLine(colors.line, Offset(0f, size.height), Offset(size.width, size.height), 1.dp.toPx()) }
            .clickable(role = Role.Button, onClick = onClick)
            .padding(vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Box(Modifier.size(36.dp).clip(CircleShape).background(colors.well), contentAlignment = Alignment.Center) {
            GlyphIcon(glyph, tint = colors.ink)
        }
        Column(Modifier.weight(1f)) {
            Text(title, style = ConsoleType.body.copy(fontWeight = FontWeight.SemiBold), color = colors.ink)
            Text(text, style = ConsoleType.note, color = colors.ink2)
        }
        GlyphIcon(Glyph.ARROW_RIGHT, tint = colors.ink3)
    }
}

// API tokens.

@Composable
fun TokensScreen(vm: ConsoleViewModel, store: Store, now: Long) {
    val listing = store.tokens.value
    val active = listing?.tokens?.count { it.status == "active" } ?: 0
    val full = listing != null && active >= listing.limit
    val viewer = store.me?.canWrite == false
    PageHead(
        "API tokens",
        eyebrow = "Developer",
        lede = "A token lets a script use this console’s API as you, without signing in, until it expires or you revoke it. " +
            "Each person makes and sees only their own.",
        tools = { Freshness(store.tokens.loadedAt, store.tokens.loading, vm.intervalOf(Route.Tokens), now, vm::refreshNow) },
    )
    LoadProblem(store.tokens.error, "your API tokens", listing != null, store.tokens.loadedAt, now, vm::refreshNow)
    Section(title = "Your tokens") {
        Text(
            (if (listing != null) "${Words.plural(active, "token", "tokens")} in use, of the ${listing.limit} you may have." else "") +
                if (viewer) " You are a viewer, so your tokens can only read." else "",
            style = ConsoleType.small, color = console.ink2,
        )
        Row(Modifier.padding(vertical = 12.dp)) {
            ConsoleButton("New token", vm::openCreateToken, kind = ButtonKind.PRIMARY, glyph = Glyph.PLUS, enabled = listing != null && !full)
        }
        if (full) Note("Revoke a token you no longer use first.")
        when {
            listing == null -> if (store.tokens.error == null) Loading("your API tokens")
            listing.tokens.isEmpty() -> EmptyState(
                Glyph.KEY, "You have no API tokens.",
                "Make one for a script that should use the console as you, such as scripts/ota.sh.",
            )
            else -> for (token in listing.tokens) TokenRow(vm, token, now)
        }
    }
    Section(title = "Using a token") {
        Consequences(
            listOf(
                prose("Send it as Authorization: Bearer crn_… to the API under /api/t/: GET /api/t/firmware answers what GET /api/firmware does for you here."),
                prose("scripts/ota.sh uses the token in ~/.cranium/console-token (readable by you alone: chmod 600), or in CRANIUM_TOKEN."),
                prose(
                    "It acts as you, with what you may do at that moment: a viewer’s token only reads, and if your account loses a " +
                        "role or is disabled, its tokens lose it at once.",
                ),
                prose(
                    "A change made with a token is in the activity log under your name, with the token’s ID. A token cannot make or " +
                        "revoke tokens, or read a board’s Bluetooth passkey.",
                ),
            ),
        )
        Code("curl -H \"Authorization: Bearer \$CRANIUM_TOKEN\" ${BuildConfig.CONSOLE_URL.trimEnd('/')}/api/t/me", Modifier.padding(top = 12.dp))
    }
}

@Composable
private fun TokenRow(vm: ConsoleViewModel, token: ApiToken, now: Long) {
    val colors = console
    val (tone, glyph, label) = when (token.status) {
        "active" -> Triple(Tone.GOOD, Glyph.CHECK_CIRCLE, "Active")
        "revoked" -> Triple(Tone.BAD, Glyph.BAN, "Revoked")
        else -> Triple(Tone.IDLE, Glyph.CLOCK, "Expired")
    }
    val life = when (token.status) {
        "revoked" -> "Revoked ${Words.timeAgo(token.revokedAt, now)}"
        "expired" -> "Expired ${Words.timeAgo(token.expiresAt, now)}"
        else -> "Expires ${until(token.expiresAt, now)} (${Words.dateAndTime(token.expiresAt)})"
    }
    Column(
        Modifier
            .fillMaxWidth()
            .drawBehind { drawLine(colors.line, Offset(0f, 0f), Offset(size.width, 0f), 1.dp.toPx()) }
            .padding(vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Wrap {
            Text(token.name, style = ConsoleType.body.copy(fontWeight = FontWeight.SemiBold), color = if (token.status == "active") colors.ink else colors.ink2)
            Badge(tone, glyph, label)
        }
        Note("ID ${token.id} · Made ${Words.timeAgo(token.createdAt, now)} · $life")
        if (token.status == "active") {
            ConsoleButton("Revoke", { vm.openRevokeToken(token) }, small = true, glyph = Glyph.BAN)
        }
    }
}

// History.

@Composable
fun HistoryScreen(vm: ConsoleViewModel, store: Store, now: Long) {
    val uri = LocalUriHandler.current
    PageHead(
        "History",
        eyebrow = "Developer",
        lede = "Every change to the project, newest first, as git log had it when this console was deployed.",
        tools = { Freshness(store.history.loadedAt, store.history.loading, 0, now, vm::refreshNow) },
    )
    LoadProblem(store.history.error, "the history", store.history.value != null, store.history.loadedAt, now, vm::refreshNow)
    when (val read = store.history.value) {
        null -> if (store.history.error == null) Loading("the history")
        HistoryRead.Missing -> Section {
            EmptyState(
                Glyph.LIST, "There is no history in this copy of the console.",
                "The list of commits is written when the console is deployed, and this copy never was. To see the page here, " +
                    "write the file by hand:",
                command = "node cloud/web/build-history.mjs",
            )
        }
        is HistoryRead.Failed -> Notice(Tone.BAD, Glyph.ALERT, read.why, action = { ConsoleButton("Try again", vm::refreshNow, small = true) })
        is HistoryRead.Read -> HistoryBody(read.history, now) { uri.openUri(it) }
    }
}

@Composable
private fun HistoryBody(history: CommitHistory, now: Long, open: (String) -> Unit) {
    val colors = console
    var shownTag by rememberSaveable { mutableStateOf("all") }
    val built = history.commits.firstOrNull { it.hash == history.builtFrom }
    InkPanel(Modifier.padding(bottom = 24.dp)) {
        Eyebrow("This deployment was built from")
        if (history.builtFrom != null) {
            Text(
                built?.short ?: history.builtFrom.take(7),
                Modifier.clickable(role = Role.Button, onClickLabel = "Open the commit on GitHub") { open(CommitHistory.COMMIT_BASE + history.builtFrom) },
                style = ConsoleType.pageTitle.copy(fontFamily = ConsoleType.Mono),
                color = colors.ink,
            )
        } else {
            Text("An unknown commit", style = ConsoleType.sectionTitle, color = colors.ink)
        }
        built?.let { Text(it.subject, style = ConsoleType.small, color = colors.ink2) }
        Eyebrow("Its files", Modifier.padding(top = 14.dp))
        when (history.tree) {
            "clean" -> {
                StatusLine(Tone.GOOD, Glyph.CHECK_CIRCLE, "Clean")
                Note("The files that went out matched this commit.")
            }
            "dirty" -> {
                StatusLine(Tone.WARN, Glyph.ALERT, "Not clean")
                Note("Some of the files that went out differed from this commit.")
            }
            else -> {
                StatusLine(Tone.IDLE, Glyph.MINUS_CIRCLE, "Not known")
                Note("This deployment did not record it.")
            }
        }
        Eyebrow("Deployed", Modifier.padding(top = 14.dp))
        if (history.deployedAt != null && Times.parse(history.deployedAt) != null) {
            Text(Words.timeAgo(history.deployedAt, now), style = ConsoleType.small.copy(fontWeight = FontWeight.SemiBold), color = colors.ink)
            Note(Words.exactTime(history.deployedAt))
        } else {
            Text("Not known", style = ConsoleType.small, color = colors.ink)
        }
    }
    val choices = listOf("all" to "All") + CommitHistory.TAGS
    Wrap(Modifier.padding(bottom = 12.dp)) {
        for ((tag, label) in choices) {
            val count = if (tag == "all") history.commits.size else history.commits.count { tag in it.tags }
            val on = shownTag == tag
            ConsoleButton(
                "$label $count", { shownTag = tag }, small = true,
                kind = if (on) ButtonKind.PRIMARY else ButtonKind.PLAIN,
                glyph = if (on) Glyph.CHECK else null,
                modifier = Modifier.semantics { selected = on },
            )
        }
    }
    val shown = if (shownTag == "all") history.commits else history.commits.filter { shownTag in it.tags }
    Note(
        (if (shownTag == "all") {
            "${if (history.commits.size >= 300) "The newest " else ""}${Words.plural(history.commits.size, "commit")}"
        } else {
            "${shown.size} of ${Words.plural(history.commits.size, "commit")} touched ${CommitHistory.tagLabel(shownTag)?.lowercase()}"
        }) + ". Each hash opens the commit on GitHub.",
    )
    if (shown.isEmpty()) {
        Quiet("No commit here touched that.")
        return
    }
    var day: String? = null
    for (commit in shown) {
        val label = Words.dayLabel(commit.date, now)
        if (label != day) {
            day = label
            Text(label, Modifier.padding(top = 18.dp, bottom = 4.dp), style = ConsoleType.sectionTitle, color = colors.ink)
        }
        Row(
            Modifier
                .fillMaxWidth()
                .drawBehind { drawLine(colors.line, Offset(0f, 0f), Offset(size.width, 0f), 1.dp.toPx()) }
                .padding(vertical = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(Words.timeOfDay(commit.date), style = ConsoleType.note, color = colors.ink3)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(commit.subject, style = ConsoleType.small, color = colors.ink)
                if (commit.tags.isNotEmpty() || commit.hash == history.builtFrom) {
                    Wrap {
                        if (commit.hash == history.builtFrom) Badge(Tone.IDLE, Glyph.PACKAGE, "This deployment")
                        for (tag in commit.tags) Tag(CommitHistory.tagLabel(tag) ?: tag)
                    }
                }
            }
            Text(
                commit.short,
                Modifier
                    .clickable(role = Role.Button, onClickLabel = "Open commit ${commit.short} on GitHub") { open(commit.link) }
                    .padding(4.dp),
                style = ConsoleType.mono.copy(textDecoration = androidx.compose.ui.text.style.TextDecoration.Underline),
                color = colors.ink2,
            )
        }
    }
}

// The account.

@Composable
fun AccountScreen(vm: ConsoleViewModel, store: Store, now: Long) {
    val me = store.me
    PageHead("Account", lede = "Who is signed in on this phone, and what that account may do.")
    if (me == null) {
        Loading("the account")
        return
    }
    val left = me.expiresAt?.let { it - now / 1000 }
    Section(title = "Signed in") {
        Facts(
            listOf(
                Fact("E-mail") { Text(me.email.ifEmpty { "Signed in" }, style = ConsoleType.body.copy(fontWeight = FontWeight.SemiBold)) },
                Fact("Account") {
                    Mono(me.sub)
                    Note("What the activity log files this person’s actions under.")
                },
                Fact("Role") {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        GlyphIcon(if (me.canWrite) Glyph.KEY else Glyph.USER, size = 14.dp)
                        Text(if (me.canWrite) "Release manager" else "Viewer", style = ConsoleType.small)
                    }
                    Note(
                        if (me.canWrite) {
                            "May upload, deploy, cancel and revoke, send firmware over Bluetooth and use the serial console."
                        } else {
                            "Sees everything, and changes nothing. Ask an administrator for the release manager role."
                        },
                    )
                },
                Fact("Session") {
                    Text(
                        when {
                            left == null -> "Renewed by itself while the app is used."
                            left > 0 -> "This sign-in's token ends in ${Words.duration(left)}; the app renews it by itself."
                            else -> "The token has ended; the app renews it by itself, or asks you to sign in again."
                        },
                        style = ConsoleType.small,
                    )
                    Note("A change from the phone asks for your password and code again when the last sign-in is older than 15 minutes.")
                },
            ),
        )
    }
    Section(title = "This phone") {
        Note(Messages.firmwareOnPhone(store.cache))
        if (store.cache.count > 0) {
            ConsoleButton("Clear downloaded firmware", vm::clearFirmware, small = true, modifier = Modifier.padding(top = 8.dp))
        }
        Note("App version ${BuildConfig.VERSION_NAME}", Modifier.padding(top = 12.dp))
    }
    Section {
        Text(
            "Signing out forgets the sign-in and every firmware image kept on this phone, and ends the session with the sign-in service.",
            style = ConsoleType.small, color = console.ink2,
        )
        ConsoleButton("Sign out", vm::signOut, glyph = Glyph.SIGN_OUT, modifier = Modifier.padding(top = 12.dp))
    }
}
