package com.craniumiot.cranium.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.craniumiot.cranium.core.AuditEntry
import com.craniumiot.cranium.core.AuditText
import com.craniumiot.cranium.core.Boards
import com.craniumiot.cranium.core.Glyph
import com.craniumiot.cranium.core.LogLink
import com.craniumiot.cranium.core.Tone
import com.craniumiot.cranium.core.Updates
import com.craniumiot.cranium.core.Words

/** Where a link of the log leads in the app. */
fun routeOf(link: LogLink?): Route? = when (link) {
    is LogLink.ToDeployment -> Route.DeploymentPage(link.id)
    LogLink.ToFirmware -> Route.Firmware
    null -> null
}

/** One entry of the activity log. The short form is for the overview. */
@Composable
fun ActivityLine(entry: AuditEntry, store: Store, now: Long, compact: Boolean, onOpen: (Route) -> Unit, onCopied: (String) -> Unit = {}) {
    val colors = console
    val words = AuditText.describe(entry)
    val name = Words.nameOf(entry.actor)
    // How a deployment ended is not in the log: it follows from the deployment, once it is over.
    val run = if (entry.action == "deployment.create" && entry.outcome == "ok") {
        store.deployments.value?.firstOrNull { it.id == entry.target }
    } else {
        null
    }
    val ending = run?.takeIf { !Updates.isUnderWay(it) }?.let { Updates.describeDeployment(it) }
    val target = routeOf(words.link)
    Row(
        Modifier
            .fillMaxWidth()
            .drawBehind { drawLine(colors.line, Offset(0f, 0f), Offset(size.width, 0f), 1.dp.toPx()) }
            .then(if (target != null) Modifier.clickable(role = Role.Button, onClickLabel = "Open") { onOpen(target) } else Modifier)
            .padding(vertical = 12.dp)
            .semantics(mergeDescendants = true) {},
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        val tone = words.outcome?.tone
        Box(
            Modifier.size(32.dp).clip(CircleShape).background(if (tone != null) colors.toneWash(tone) else colors.well),
            contentAlignment = Alignment.Center,
        ) { GlyphIcon(words.glyph, size = 16.dp, tint = if (tone != null) colors.toneInk(tone) else colors.ink2) }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                buildAnnotatedString {
                    withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(name) }
                    append(" ${words.verb} ")
                    if (words.label.isNotEmpty()) {
                        withStyle(SpanStyle(fontFamily = ConsoleType.Mono, textDecoration = if (target != null) androidx.compose.ui.text.style.TextDecoration.Underline else null)) {
                            append(words.label)
                        }
                    }
                },
                style = ConsoleType.small,
                color = colors.ink,
            )
            if (words.outcome != null || ending != null || words.scripted) {
                Wrap {
                    words.outcome?.let { Badge(it) }
                    ending?.let { Badge(it) }
                    if (words.scripted) Tag(AuditText.SCRIPTED_TAG, tone = Tone.WARN)
                }
            }
            if (!compact) {
                for (fact in words.facts) FactLine(fact, store, onCopied)
                val refs = listOfNotNull(
                    entry.actor?.sub?.takeIf { it.isNotEmpty() }?.let { "Account ${Words.shortAccount(it)}" },
                    entry.requestId.takeIf { it.isNotEmpty() }?.let { "Request $it" },
                )
                if (refs.isNotEmpty()) Text(refs.joinToString(" · "), style = ConsoleType.note.copy(fontFamily = ConsoleType.Mono), color = colors.ink3)
            }
        }
        Text(
            if (compact) Words.timeAgo(entry.at, now) else Words.timeOfDay(entry.at),
            style = ConsoleType.note,
            color = colors.ink3,
        )
    }
}

/** One fact of a log entry, in the console's words. A digest is shortened, with a button that copies it all. */
@Composable
private fun FactLine(fact: com.craniumiot.cranium.core.AuditFact, store: Store, onCopied: (String) -> Unit) {
    val colors = console
    when {
        fact.key == "sha256" -> Row(verticalAlignment = Alignment.CenterVertically) {
            Text("${fact.label} ", style = ConsoleType.note, color = colors.ink2)
            Mono("${fact.value.take(12)}…", style = ConsoleType.mono.copy(fontSize = ConsoleType.note.fontSize), color = colors.ink2)
            CopyButton(fact.value, "the SHA-256 of ${fact.value.take(12)}…", onCopied = onCopied)
        }
        fact.words != null -> Text("${fact.words}. (Code ${fact.value})", style = ConsoleType.note, color = colors.ink2)
        fact.key == "thing" -> {
            val board = Boards.of(fact.value, store.deviceList)
            Text(
                buildAnnotatedString {
                    append("${fact.label} ")
                    withStyle(SpanStyle(fontFamily = ConsoleType.Mono)) { append(Boards.name(board, full = true)) }
                },
                style = ConsoleType.note, color = colors.ink2,
            )
        }
        else -> Text(
            buildAnnotatedString {
                append(if (fact.phrase) "${fact.label} " else "${fact.label}: ")
                if (fact.code) withStyle(SpanStyle(fontFamily = ConsoleType.Mono)) { append(fact.value) } else append(fact.value)
            },
            style = ConsoleType.note, color = colors.ink2,
        )
    }
}

/** What the scripted tag means, said once, where it appears. */
@Composable
fun ScriptedKey(entries: List<AuditEntry>) {
    if (entries.none { AuditText.describe(it).scripted }) return
    Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Tag(AuditText.SCRIPTED_TAG, tone = Tone.WARN)
        Note(AuditText.SCRIPTED_NOTE)
    }
}

@Composable
fun ActivityScreen(vm: ConsoleViewModel, store: Store, now: Long) {
    val audit = store.audit.value
    PageHead(
        "Activity",
        lede = "Every upload, deployment, cancellation and revocation made through this console’s API, with who asked for " +
            "it and whether it went through. A job made directly in AWS IoT does not pass through that API, so it is not in " +
            "this log, though its board’s page lists it. A deployment that is over shows how it ended. This console has no " +
            "way to change an entry.",
        tools = { Freshness(store.audit.loadedAt, store.audit.loading, vm.intervalOf(Route.Activity), now, vm::refreshNow) },
    )
    LoadProblem(store.audit.error, "the activity log", audit != null, store.audit.loadedAt, now, vm::refreshNow)
    when {
        audit == null -> if (store.audit.error == null) Loading("activity")
        audit.entries.isEmpty() -> Section {
            EmptyState(
                Glyph.LIST, "Nothing has been recorded yet.",
                "Uploads, deployments, cancellations and revocations made through this console’s API will appear here, " +
                    "including attempts that were refused.",
            )
        }
        else -> {
            val entries = audit.entries
            fun count(action: String) = entries.count { it.action == action }
            val refused = entries.count { it.outcome != "ok" }
            val said = listOf(
                Triple(count("firmware.upload"), "upload", "uploads"),
                Triple(count("deployment.create"), "deployment", "deployments"),
                Triple(count("deployment.cancel"), "cancellation", "cancellations"),
                Triple(count("firmware.revoke"), "revocation", "revocations"),
                Triple(count("firmware.bluetooth_send"), "send over Bluetooth", "sends over Bluetooth"),
            ).filter { it.first > 0 }.map { (amount, one, many) -> Words.plural(amount, one, many) }
            val scope = if (audit.next != null) "The latest ${Words.plural(entries.size, "entry", "entries")}" else if (entries.size == 1) "The only entry" else "All ${entries.size} entries"
            Wrap(Modifier.padding(bottom = 12.dp)) {
                Text(scope, style = ConsoleType.small.copy(fontWeight = FontWeight.SemiBold), color = console.ink)
                for (words in said) Text(words, style = ConsoleType.small, color = console.ink2)
                if (refused > 0) StatusLine(Tone.WARN, Glyph.ALERT, "$refused refused or failed")
            }
            ScriptedKey(entries)
            var day: String? = null
            for (entry in entries) {
                val label = Words.dayLabel(entry.at, now)
                if (label != day) {
                    day = label
                    Text(label, Modifier.padding(top = 20.dp, bottom = 4.dp), style = ConsoleType.sectionTitle, color = console.ink)
                }
                ActivityLine(entry, store, now, compact = false, onOpen = vm::open, onCopied = { vm.notify(it) })
            }
            Column(Modifier.fillMaxWidth().padding(top = 16.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (audit.next != null) {
                    ConsoleButton(if (store.auditMoreLoading) "Loading…" else "Load more", vm::loadMoreActivity, enabled = !store.auditMoreLoading)
                } else {
                    Quiet("That is every entry in this log.")
                }
                store.auditMoreError?.let { Failure("Could not load more.", it) }
            }
        }
    }
}
