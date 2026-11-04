package com.craniumiot.cranium.ui

import androidx.compose.runtime.Composable
import com.craniumiot.cranium.core.AuditText
import com.craniumiot.cranium.core.Boards
import com.craniumiot.cranium.core.Glyph
import com.craniumiot.cranium.core.LogLink
import com.craniumiot.cranium.core.Tone
import com.craniumiot.cranium.core.Words

/** Where a link of the log leads in the app. */
fun routeOf(link: LogLink?): Route? = when (link) {
    is LogLink.ToDeployment -> Route.DeploymentPage(link.id)
    LogLink.ToFirmware -> Route.Firmware
    null -> null
}

/** The activity log, newest first, by day. */
@Composable
fun ActivityScreen(vm: ConsoleViewModel, store: Store, now: Long) {
    val audit = store.audit.value
    ConsoleScreen(
        title = "Activity",
        help = "activity",
        stale = staleOf(listOf(store.audit), vm.intervalOf(Route.Activity), now, vm::refreshNow),
        onRefresh = { vm.refresh(Route.Activity, full = true) },
    ) {
        problem(store.audit.error, "the activity log", audit != null, vm::refreshNow)
        when {
            audit == null -> if (store.audit.error == null) loading("activity")
            audit.entries.isEmpty() -> item(key = "none") { OneLine("Nothing has been recorded yet.") }
            else -> {
                var day: String? = null
                for (entry in audit.entries) {
                    val label = Words.dayLabel(entry.at, now)
                    if (label != day) {
                        day = label
                        header(label, key = "day-$label")
                    }
                    item(key = "entry-${activityKey(entry)}") { ActivityRow(vm, entry, now, compact = false) }
                }
                item(key = "more") {
                    when {
                        audit.next != null -> ListRow(
                            if (store.auditMoreLoading) "Loading…" else "Load more",
                            onClick = if (store.auditMoreLoading) null else vm::loadMoreActivity,
                            chevron = false,
                            headlineColor = console.accent,
                        )
                        else -> OneLine("That is every entry in this log.")
                    }
                }
                store.auditMoreError?.let { error ->
                    item(key = "more-error") { OneLine("Could not load more. ${messageOf(error)}", "Try again" to vm::loadMoreActivity, Tone.BAD, Glyph.ALERT) }
                }
            }
        }
    }
}

/** One entry of the log: who, what, when, how it ended, and the details it was recorded with. */
@Composable
fun ActivityEntryScreen(vm: ConsoleViewModel, store: Store, id: String, now: Long) {
    val entry = (store.audit.value?.entries.orEmpty() + store.recent.value?.entries.orEmpty()).firstOrNull { activityKey(it) == id }
    val words = entry?.let { AuditText.describe(it) }
    val target = routeOf(words?.link)
    ConsoleScreen(
        title = "Activity",
        help = "activity",
        primary = target?.let { ScreenAction(if (it is Route.DeploymentPage) "Open the deployment" else "Open the release", Glyph.ARROW_RIGHT) { vm.open(it) } },
    ) {
        if (entry == null || words == null) {
            item(key = "missing") { OneLine("This entry is no longer loaded.", "Activity" to { vm.open(Route.Activity) }) }
            return@ConsoleScreen
        }
        block("sentence") { androidx.compose.material3.Text(prose(AuditText.sentence(entry)), style = ConsoleType.body, color = console.ink) }
        item(key = "when") { ValueRow("When", Words.timeAgo(entry.at, now), supporting = Words.exactTime(entry.at)) }
        item(key = "who") { ValueRow("Who", Words.nameOf(entry.actor), supporting = entry.actor?.sub?.takeIf { it.isNotEmpty() }?.let { "Account $it" }) }
        item(key = "outcome") {
            val outcome = words.outcome
            ListRow(
                outcome?.label ?: "Went through",
                overline = "Outcome",
                leading = { StateDot(outcome?.tone ?: Tone.GOOD) },
            )
        }
        if (words.scripted) item(key = "scripted") { ValueRow(AuditText.SCRIPTED_TAG, "Sent by a script with AWS credentials; nobody signed in") }
        if (words.facts.isNotEmpty()) header("Details")
        for (fact in words.facts) {
            item(key = "fact-${fact.key}") {
                when {
                    fact.words != null -> ValueRow(fact.label, fact.words, supporting = "Code ${fact.value}")
                    fact.key == "thing" -> {
                        val board = Boards.of(fact.value, store.deviceList)
                        ValueRow(fact.label, Boards.name(board), supporting = if (Boards.hasOwnName(board)) board.thing else null, onClick = { vm.open(Route.Board(fact.value)) })
                    }
                    else -> ValueRow(fact.label, fact.value, mono = fact.code)
                }
            }
        }
        if (entry.requestId.isNotEmpty()) item(key = "request") { ValueRow("Request", entry.requestId, mono = true) }
    }
}
