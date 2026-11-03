package com.craniumiot.cranium.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.craniumiot.cranium.core.Boards
import com.craniumiot.cranium.core.DeploymentSummary
import com.craniumiot.cranium.core.Device
import com.craniumiot.cranium.core.Glyph
import com.craniumiot.cranium.core.Release
import com.craniumiot.cranium.core.Times
import com.craniumiot.cranium.core.Tone
import com.craniumiot.cranium.core.Updates
import com.craniumiot.cranium.core.Words

@Composable
fun OverviewScreen(vm: ConsoleViewModel, store: Store, now: Long) {
    val devices = store.deviceList
    val firmware = store.firmware.value
    val deployments = store.deployments.value
    val newest = firmware?.releases?.firstOrNull { it.isActive }
    val haveBoards = !devices.isNullOrEmpty()
    val haveReleases = !firmware?.releases.isNullOrEmpty()
    val haveDeployments = !deployments.isNullOrEmpty()
    val loaded = devices != null && firmware != null && deployments != null
    val started = haveBoards && haveReleases && haveDeployments
    val blank = loaded && !haveBoards && !haveReleases && !haveDeployments
    val recorded = !store.recent.value?.entries.isNullOrEmpty()
    val failed = listOf(store.devices, store.firmware, store.deployments).filter { it.error != null }
    val oldest = listOf(store.devices, store.firmware, store.deployments).filter { it.loadedAt > 0 }.minByOrNull { it.loadedAt }

    PageHead(
        "Overview",
        lede = "What the boards last reported, and what is being updated right now.",
        tools = { Freshness(oldest?.loadedAt ?: 0, store.devices.loading, vm.intervalOf(Route.Overview), now, vm::refreshNow) },
    )
    LoadProblems(
        listOf(
            Triple(store.devices.error, "the boards", store.devices),
            Triple(store.firmware.error, "the releases", store.firmware),
            Triple(store.deployments.error, "the deployments", store.deployments),
            Triple(store.recent.error, "the activity log", store.recent),
        ),
        now, vm::refreshNow,
    )
    OpenRevocations(store, vm)
    if (loaded && !started && failed.isEmpty()) {
        if (blank) {
            InkPanel(Modifier.padding(bottom = 24.dp)) { GettingStarted(store, haveBoards, haveReleases, haveDeployments, vm) }
            UpdateJourney()
        } else {
            Section(title = "Getting started") { GettingStarted(store, haveBoards, haveReleases, haveDeployments, vm) }
        }
    }
    if (!blank) {
        InkPanel(Modifier.padding(bottom = 28.dp)) {
            UpdatesZone(vm, store, now)
            Section(title = "Fleet", zone = true) {
                when {
                    devices == null -> if (store.devices.error == null) Loading("boards")
                    devices.isEmpty() -> Quiet("No boards are registered yet.")
                    else -> FleetFigure(devices)
                }
            }
            Section(title = "Firmware in the fleet", zone = true, more = "Devices" to { vm.open(Route.Boards) }) {
                FleetVersions(store, devices, newest, now)
            }
            Section(title = "Newest release", zone = true, more = "Firmware" to { vm.open(Route.Firmware) }) {
                NewestRelease(store, newest, now)
            }
        }
        BoardsCard(vm, store, devices, now)
        ActivityCard(vm, store, now)
    } else if (recorded) {
        ActivityCard(vm, store, now)
    }
}

/** What could not be read; one lost connection fails them all alike, and that is one problem. */
@Composable
private fun LoadProblems(items: List<Triple<Throwable?, String, Resource<*>>>, now: Long, onRetry: () -> Unit) {
    val failed = items.filter { it.first != null }
    if (failed.isEmpty()) return
    val first = failed.first().first!!
    val alike = failed.all { it.first?.message == first.message }
    if (failed.size > 1 && alike) {
        val stale = failed.map { it.third }.filter { it.value != null }
        LoadProblem(first, "this page", stale.isNotEmpty(), stale.minOfOrNull { it.loadedAt } ?: 0, now, onRetry)
    } else {
        for ((error, what, resource) in failed) LoadProblem(error, what, resource.value != null, resource.loadedAt, now, onRetry)
    }
}

/** Releases whose revocation the server has not recorded as finished: said on top, to everyone. */
@Composable
private fun OpenRevocations(store: Store, vm: ConsoleViewModel) {
    val open = store.releases.orEmpty().filter { Updates.revocationState(it) == Updates.RevocationState.INCOMPLETE }
    if (open.isEmpty()) return
    val versions = open.map { it.version }.let { list ->
        if (list.size == 1) list[0] else list.dropLast(1).joinToString(", ") + " and " + list.last()
    }
    Notice(
        Tone.WARN, Glyph.ALERT,
        lead(
            "Revocation incomplete.",
            "$versions ${if (open.size == 1) "is" else "are"} marked revoked, but the server has not recorded the steps that " +
                "follow: refusing the image and cancelling every open deployment. " +
                if (store.me?.canWrite == true) "Finish revoking on the Firmware page." else "A release manager can finish revoking on the Firmware page.",
        ),
        Modifier.padding(bottom = 20.dp),
        action = { ConsoleButton("Firmware", { vm.open(Route.Firmware) }, small = true, glyph = Glyph.ARROW_RIGHT) },
    )
}

/** The first steps with a new console, ticked off as they are done. */
@Composable
private fun GettingStarted(store: Store, boards: Boolean, releases: Boolean, deployments: Boolean, vm: ConsoleViewModel) {
    val canWrite = store.me?.canWrite == true
    val done = listOf(boards, releases, deployments)
    val next = done.indexOf(false)
    val steps = listOf(
        "Register a board" to "Each board gets its own certificate and name. With the board connected over USB, run python3 tools/provision_device.py",
        "Upload a signed image" to if (canWrite) {
            "Choose binaries/latest.signed.bin on the Firmware page. The server checks its signature before it is stored."
        } else {
            "A release manager uploads a signed build. The server checks its signature before it is stored."
        },
        "Deploy it" to if (canWrite) {
            "Start a deployment from the Firmware or Deployments page. A board on firmware ${Updates.FIRST_WITH_NO_BUTTON} or newer " +
                "installs it by itself; older firmware waits for someone to press Button 1 on the board."
        } else {
            "A release manager deploys the release to boards. A board on firmware ${Updates.FIRST_WITH_NO_BUTTON} or newer installs " +
                "it by itself; older firmware waits for someone to press Button 1 on the board."
        },
    )
    val colors = console
    Eyebrow("Getting started")
    Spacer(Modifier.height(12.dp))
    steps.forEachIndexed { index, (title, text) ->
        Row(Modifier.padding(bottom = 14.dp).semantics(mergeDescendants = true) {}, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Box(
                Modifier
                    .size(24.dp)
                    .clip(CircleShape)
                    .background(if (done[index]) colors.ink else androidx.compose.ui.graphics.Color.Transparent)
                    .border(1.5.dp, if (index == next) colors.accent else colors.lineMark, CircleShape),
                contentAlignment = Alignment.Center,
            ) { if (done[index]) GlyphIcon(Glyph.CHECK, size = 14.dp, tint = colors.paper) }
            Column(Modifier.weight(1f)) {
                Text(title + if (done[index]) " (done)" else "", style = ConsoleType.body.copy(fontWeight = FontWeight.SemiBold), color = colors.ink)
                if (!done[index]) Text(prose(text), style = ConsoleType.small, color = colors.ink2)
            }
        }
    }
    if (canWrite && !releases) ConsoleButton("Firmware", { vm.open(Route.Firmware) }, small = true, glyph = Glyph.ARROW_RIGHT)
}

/** What every update goes through, for a console that has not seen one yet. */
@Composable
private fun UpdateJourney() {
    Section(title = "What every update goes through") {
        Note(
            "Nothing installs until a release manager deploys it. The board then checks what it received, and the bootloader " +
                "goes back to the previous firmware if the new one cannot reconnect.",
        )
        Spacer(Modifier.height(12.dp))
        StepList(
            com.craniumiot.cranium.core.ExecutionWords(Tone.IDLE, Glyph.MINUS, "", "", Updates.previewSteps()),
            compact = true,
        )
    }
}

// The updates zone.

private fun unregisteredWords(strangers: List<Device>, devices: List<Device>): String {
    val heard = strangers.all { it.online }
    if (devices.size == 1) {
        val fw = strangers[0].fw?.version.orEmpty()
        return "The board ${if (heard) "runs" else "last reported"} $fw, which is not a registered release."
    }
    val count = strangers.size
    if (!heard) return "${Words.plural(count, "board")} last reported firmware that is not a registered release."
    return "${Words.plural(count, "board runs", "boards run")} firmware that is not a registered release."
}

private fun offlineWords(boards: List<Device>, now: Long, alone: Boolean = boards.size == 1): String? {
    val quiet = boards.filter { !it.online && it.lastSeen != null }
    if (quiet.isEmpty()) return null
    val oldest = quiet.minBy { Times.parse(it.lastSeen) ?: Long.MAX_VALUE }
    val seen = Words.timeAgo(oldest.lastSeen, now)
    return when {
        alone -> "As last reported: the board is offline, last seen $seen."
        boards.size == 1 -> "As last reported: that board is offline, last seen $seen."
        quiet.size == 1 -> "As last reported: 1 of them is offline, last seen $seen."
        else -> "As last reported: ${quiet.size} of them are offline, the oldest report $seen."
    }
}

private fun movedWords(standing: Updates.InstallStanding, deployment: DeploymentSummary, now: Long): String {
    val moved = standing.moved
    if (deployment.things.size > 1) {
        return "${moved.size} of ${deployment.things.size} boards ${if (moved.size == 1) "has" else "have"} moved to other firmware since."
    }
    val board = moved[0]
    return if (board.online) {
        "The board has since moved to ${board.fw?.version}."
    } else {
        "When last seen, ${Words.timeAgo(board.lastSeen, now)}, the board had moved to ${board.fw?.version}."
    }
}

/** Boards that report an update, for when no deployment of this console is under way. */
private fun workWords(devices: List<Device>): String? {
    val busy = devices.filter { it.ota != null && it.ota.state != "idle" }
    if (busy.isEmpty()) return null
    val count = busy.size
    val alone = devices.size == 1
    val heard = busy.all { it.online }
    val opening = if (heard) "" else "When last seen, "
    val who = if (alone) "${if (heard) "The" else "the"} board" else Words.plural(count, "board")
    val update = if (count == 1) "an update" else "updates"
    if (busy.all { it.ota?.job == null }) {
        val verb = if (count == 1) (if (heard) "is" else "was") else (if (heard) "are" else "were")
        return "$opening$who $verb working on $update that this console did not start."
    }
    if (!heard) return "$opening$who reported $update in progress."
    return "$who ${if (count == 1) "reports" else "report"} $update in progress."
}

@Composable
private fun UpdatesZone(vm: ConsoleViewModel, store: Store, now: Long) {
    val deployments = store.deployments.value
    val devices = store.deviceList
    val active = deployments.orEmpty().filter { Updates.isUnderWay(it) || Updates.stillFinishing(it, devices, now) }
    val lastDone = deployments.orEmpty().firstOrNull { it !in active }
    val outOfDate = store.deployments.error != null
    Section(
        title = if (active.isNotEmpty()) "Updates in progress" else "Updates",
        zone = true,
        more = "All deployments" to { vm.open(Route.Deployments) },
    ) {
        when {
            deployments == null -> if (store.deployments.error == null) Loading("deployments")
            active.isEmpty() && devices == null && store.devices.error == null -> Loading("boards")
            active.isEmpty() -> Calm(vm, store, lastDone, devices.orEmpty(), outOfDate, now)
            else -> for (deployment in active) ActiveRun(vm, store, deployment, now)
        }
    }
}

@Composable
private fun Calm(vm: ConsoleViewModel, store: Store, lastDone: DeploymentSummary?, devices: List<Device>, outOfDate: Boolean, now: Long) {
    val colors = console
    val ending = lastDone?.let { Updates.describeDeployment(it, devices) }
    val standing = if (ending?.tone == Tone.GOOD) Updates.installStanding(lastDone, devices) else null
    val strangers = offList(devices, store.releases)
    val movedOn = standing?.state == Updates.Standing.MOVED
    val offRecord = !outOfDate && strangers.isNotEmpty() && ending?.tone != Tone.BAD && ending?.tone != Tone.WARN &&
        standing?.state != Updates.Standing.CURRENT
    val work = if (store.devices.error != null) null else workWords(devices)
    var tone = if (outOfDate) Tone.IDLE else ending?.tone ?: Tone.IDLE
    var news = if (outOfDate) null else ending?.said
    if (offRecord) {
        tone = Tone.WARN
        news = unregisteredWords(strangers, devices)
    } else if (movedOn) {
        tone = Tone.IDLE
        news = null
    }
    val glyph = when {
        tone == Tone.IDLE -> if (news == null && work != null) Glyph.RESTART else Glyph.MINUS_CIRCLE
        offRecord -> Glyph.ALERT
        else -> ending?.glyph ?: Glyph.MINUS_CIRCLE
    }
    val boards = lastDone?.things?.size ?: 0
    val showBar = boards > 1 && (tone == Tone.BAD || tone == Tone.WARN || tone == Tone.GOOD)
    val unknown = outOfDate || store.devices.error != null
    val atRest = !unknown && work == null
    val resting = if (unknown) "Whether an update is in progress cannot be told right now." else "No update is in progress."
    val since = when {
        offRecord -> offlineWords(strangers, now, devices.size == 1)
        !outOfDate && movedOn -> lastDone?.let { movedWords(standing, it, now) }
        !outOfDate && standing != null && standing.state != Updates.Standing.CURRENT -> offlineWords(standing.boards, now)
        else -> null
    }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            GlyphIcon(glyph, size = 24.dp, tint = colors.toneInk(tone))
            Text(prose(news ?: work ?: resting), style = ConsoleType.sectionTitle.copy(fontSize = 19.sp, lineHeight = 25.sp), color = colors.ink)
        }
        if (lastDone != null && ending != null) {
            Wrap {
                val lead = if (offRecord) "Last deployment from this console:" else if (news != null) null else "Last deployment:"
                if (lead != null) Text(lead, style = ConsoleType.small, color = colors.ink2)
                Text(
                    lastDone.version ?: lastDone.id,
                    Modifier.clickable(role = Role.Button) { vm.open(Route.DeploymentPage(lastDone.id)) },
                    style = ConsoleType.mono.copy(textDecoration = androidx.compose.ui.text.style.TextDecoration.Underline),
                    color = colors.ink,
                )
                Badge(ending)
                Text(
                    (if (lastDone.completedAt != null) Words.timeAgo(lastDone.completedAt, now) else "started ${Words.timeAgo(lastDone.createdAt, now)}") +
                        if (news != null && atRest) ". No update is in progress." else "",
                    style = ConsoleType.small, color = colors.ink2,
                )
            }
        } else {
            Note((if (news != null && atRest) "No update is in progress. " else "") + "Deployments from this console appear here while boards are being updated.")
        }
        if (news != null && work != null) Note(work)
        if (since != null) Note(since)
        if (showBar && lastDone != null) {
            val parts = Updates.describeCounts(lastDone.counts)
            Segments(parts, "Boards: ${Updates.countWords(lastDone.counts)}.", thin = true)
            CountList(parts)
        }
    }
}

@Composable
private fun ActiveRun(vm: ConsoleViewModel, store: Store, deployment: DeploymentSummary, now: Long) {
    val colors = console
    val detail = store.deploymentDetails[deployment.id]?.value
    Column(Modifier.fillMaxWidth().padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            deployment.version ?: deployment.id,
            Modifier.clickable(role = Role.Button, onClickLabel = "Open the deployment") { vm.open(Route.DeploymentPage(deployment.id)) },
            style = ConsoleType.pageTitle.copy(fontSize = 24.sp, lineHeight = 28.sp),
            color = colors.ink,
        )
        Note(startedBy(deployment, now))
        if (deployment.status == "CANCELED") {
            Note(
                if (Updates.isUnderWay(deployment)) {
                    "This deployment was cancelled. A board that had already started carries on unless it is stopped."
                } else {
                    "This deployment was cancelled, but a board was already restarting into the new firmware. That cannot be stopped."
                },
            )
        }
        if (detail != null) {
            for (execution in detail.executions) {
                val known = store.deviceList?.firstOrNull { it.thing == execution.thing }
                BoardRun(execution, deployment, known, store, now)
            }
        } else {
            Note(Updates.countWords(deployment.counts))
        }
    }
}

/** "Started 3 min ago by someone@example.com". */
fun startedBy(deployment: DeploymentSummary, now: Long, exact: Boolean = false): String =
    "Started ${if (exact) agoAt(deployment.createdAt, now) else Words.timeAgo(deployment.createdAt, now)}" +
        (deployment.createdBy?.let { " by ${Words.nameOf(it)}" } ?: "")

/** One board of a deployment that is under way, as a line on the overview. */
@Composable
fun BoardRun(execution: com.craniumiot.cranium.core.Execution, deployment: DeploymentSummary, known: Device?, store: Store, now: Long) {
    val colors = console
    val words = Updates.describeExecution(
        execution, board = known, deployment = deployment.id, version = deployment.version, unread = store.devices.value == null,
    )
    val board = known ?: Boards.of(execution.thing, store.deviceList)
    Column(
        Modifier
            .fillMaxWidth()
            .drawBehind { drawLine(colors.line, Offset(0f, 0f), Offset(size.width, 0f), 1.dp.toPx()) }
            .padding(top = 10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        BoardName(board)
        StatusLine(words.tone, words.glyph, words.said ?: words.title, trailing = words.progress?.let { "$it%" })
        if (words.progress != null) {
            Meter(words.progress, "Download on ${Boards.name(board)}")
        } else {
            Note(words.brief + if (!execution.online && known?.lastSeen != null) " Last seen ${Words.timeAgo(known.lastSeen, now)}." else "")
        }
        if (words.tone == Tone.ACT) ButtonKeys()
        StepList(words, compact = true, viewer = store.me?.canWrite != true)
    }
}

/** The two buttons on the board, while it waits for a person. */
@Composable
fun ButtonKeys() {
    val colors = console
    Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        listOf(true to "Button 1 installs", false to "Button 2 declines").forEach { (lit, words) ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Box(
                    Modifier
                        .size(22.dp)
                        .clip(CircleShape)
                        .background(if (lit) colors.accent else colors.well)
                        .border(1.dp, colors.lineMark, CircleShape),
                )
                Text(words, style = ConsoleType.small.copy(fontWeight = if (lit) FontWeight.SemiBold else FontWeight.Normal), color = colors.ink)
            }
        }
    }
}

// The fleet zones.

@Composable
private fun FleetVersions(store: Store, devices: List<Device>?, newest: Release?, now: Long) {
    if (devices == null) {
        if (store.devices.error == null) Loading("versions")
        return
    }
    val groups = versionGroups(devices)
    if (groups.isEmpty()) {
        Quiet("Versions appear here once a board has reported.")
        return
    }
    val current = groups.firstOrNull { it.first.isNotEmpty() && it.first == newest?.version }?.second?.size ?: 0
    val others = offList(devices, store.releases).size
    if (newest != null) {
        val (figure, unit) = if (current == 0 && others > 0) {
            others to " of ${devices.size} on firmware that is not a registered release"
        } else {
            current to " of ${devices.size} on the newest release"
        }
        Row(verticalAlignment = Alignment.Bottom) {
            Text(figure.toString(), style = ConsoleType.figure, color = console.ink)
            Text(unit, Modifier.padding(bottom = 6.dp), style = ConsoleType.body, color = console.ink2)
        }
    } else if (store.firmware.value != null) {
        Text("No release can be deployed.", style = ConsoleType.body.copy(fontWeight = FontWeight.SemiBold), color = console.ink)
    }
    asReported(devices, now)?.let { Note(it, Modifier.padding(bottom = 8.dp)) }
    VersionRows(devices, newest, store)
}

@Composable
private fun NewestRelease(store: Store, newest: Release?, now: Long) {
    val firmware = store.firmware.value
    if (firmware == null) {
        if (store.firmware.error == null) Loading("releases")
        return
    }
    val latest = firmware.releases.firstOrNull()
    val shown = newest ?: latest
    if (shown == null) {
        Quiet("No firmware has been uploaded yet.")
        return
    }
    Wrap {
        Text(shown.version, style = ConsoleType.pageTitle.copy(fontSize = 26.sp, lineHeight = 30.sp), color = console.ink)
        ReleaseBadges(shown)
    }
    Note("Uploaded ${Words.timeAgo(shown.uploadedAt, now)} by ${Words.nameOf(shown.uploadedBy)}")
    Note("${Words.fileSize(shown.size)} · SHA-256 ${shown.sha256.take(12)}…")
    when {
        newest == null -> Note("No release can be deployed.")
        latest != null && latest != newest -> Note(
            "A newer upload, ${latest.version}, was revoked${latest.revoked?.at?.let { " ${Words.timeAgo(it, now)}" } ?: ""}.",
        )
    }
    val reporting = store.deviceList.orEmpty().filter { it.fw != null }
    if (reporting.isNotEmpty() && reporting.none { it.fw?.version == shown.version }) {
        Note(
            if (reporting.size > 1) {
                "No board runs this release."
            } else {
                "The board ${if (reporting[0].online) "runs" else "last reported"} ${reporting[0].fw?.version}, not this release."
            },
        )
    }
}

/** The badges of a release: its status, and a warning while its revocation is not finished. */
@Composable
fun ReleaseBadges(release: Release) {
    if (release.isActive) {
        Badge(Tone.GOOD, Glyph.CHECK_CIRCLE, "Active")
    } else {
        Badge(Tone.BAD, Glyph.BAN, "Revoked")
        if (Updates.revocationState(release) == Updates.RevocationState.INCOMPLETE) Badge(Tone.WARN, Glyph.ALERT, "Revocation incomplete")
    }
}

// Boards and activity.

private const val BOARDS_SHOWN = 6

@Composable
private fun BoardsCard(vm: ConsoleViewModel, store: Store, devices: List<Device>?, now: Long) {
    val colors = console
    Section(title = "Boards", more = "All devices" to { vm.open(Route.Boards) }) {
        when {
            devices == null -> if (store.devices.error == null) Loading("boards")
            devices.isEmpty() -> Quiet("Boards appear here once they are registered.")
            else -> {
                for (device in devices.take(BOARDS_SHOWN)) {
                    val reported = Updates.describeUpdate(device)
                    // The panel above and this row say one percentage: the board list is read less often.
                    val own = store.deploymentDetails[device.ota?.job]?.value?.executions?.firstOrNull { it.thing == device.thing }
                    val progress = if (reported.progress != null && own?.phase == "downloading" && own.progress != null) own.progress else reported.progress
                    val update = if (reported.tone == Tone.ACT) reported.copy(tone = Tone.WAIT, label = "Waiting for its button") else reported.copy(progress = progress)
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .drawBehind { drawLine(colors.line, Offset(0f, 0f), Offset(size.width, 0f), 1.dp.toPx()) }
                            .clickable(role = Role.Button, onClickLabel = "Open the board") { vm.open(Route.Board(device.thing)) }
                            .padding(vertical = 12.dp)
                            .semantics(mergeDescendants = true) {},
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Box(
                            Modifier
                                .padding(top = 6.dp)
                                .size(10.dp)
                                .clip(CircleShape)
                                .background(if (Updates.isUp(device)) colors.barGood else colors.line),
                        )
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            BoardName(device)
                            Note(heartbeatWords(device, now) ?: "Never connected")
                            Wrap {
                                if (device.fw != null) {
                                    Mono(device.fw.version)
                                    if (device.fw.confirmed) GlyphIcon(Glyph.CHECK, size = 14.dp, description = "confirmed") else Tag("On trial", tone = Tone.WARN)
                                    if (Updates.isUnregistered(device.fw.version, store.releases)) Tag(NOT_REGISTERED, tone = Tone.WARN)
                                } else {
                                    Quiet("Not reported")
                                }
                                SignalWords(device, withDbm = false)
                            }
                            StatusLine(update)
                        }
                        GlyphIcon(Glyph.ARROW_RIGHT, Modifier.padding(top = 4.dp), tint = colors.ink3)
                    }
                }
                if (devices.size > BOARDS_SHOWN) MoreLink("and ${Words.plural(devices.size - BOARDS_SHOWN, "more board")}") { vm.open(Route.Boards) }
            }
        }
    }
}

@Composable
private fun ActivityCard(vm: ConsoleViewModel, store: Store, now: Long) {
    Section(title = "Recent activity", more = "All activity" to { vm.open(Route.Activity) }) {
        val recent = store.recent.value?.entries
        when {
            recent == null -> if (store.recent.error == null) Loading("activity")
            recent.isEmpty() -> Quiet("Nothing has been recorded yet. Uploads, deployments, cancellations and revocations will appear here.")
            else -> {
                val shown = recent.take(5)
                for (entry in shown) ActivityLine(entry, store, now, compact = true, onOpen = vm::open)
                ScriptedKey(shown)
            }
        }
    }
}
