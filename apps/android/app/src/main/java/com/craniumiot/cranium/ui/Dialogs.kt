package com.craniumiot.cranium.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.craniumiot.cranium.core.ApiError
import com.craniumiot.cranium.core.Boards
import com.craniumiot.cranium.core.Device
import com.craniumiot.cranium.core.Glyph
import com.craniumiot.cranium.core.Tone
import com.craniumiot.cranium.core.Updates
import com.craniumiot.cranium.core.Words

private fun titled(vararg parts: Pair<String, Boolean>): AnnotatedString = buildAnnotatedString {
    for ((text, mono) in parts) {
        if (mono) withStyle(SpanStyle(fontFamily = ConsoleType.Mono)) { append(text) } else append(text)
    }
}

private const val FRESH_NOTE = "This is a change: if you signed in more than 15 minutes ago, the app asks for your password and code again first, and keeps what you entered here."

/** A busy board's deployment, in words: where its update is held up. */
private fun heldBy(error: Throwable?, devices: List<Device>?): String? {
    val busy = (error as? ApiError)?.details.orEmpty()
    if (busy.isEmpty()) return null
    fun where(deployment: String?) = Updates.versionOfDeployment(deployment)?.let { "the deployment of $it" } ?: "another deployment"
    if (busy.size == 1) {
        val board = Boards.of(busy[0].thing, devices)
        val named = Boards.hasOwnName(board)
        return "That update${if (named) " on ${Boards.name(board)}" else ""} is ${where(busy[0].deployment)}."
    }
    return busy.joinToString(" ") { "${Boards.name(Boards.of(it.thing, devices), full = true)}: ${where(it.deployment)}." }
}

@Composable
fun DeployDialog(vm: ConsoleViewModel, model: DialogState.Deploy, store: Store, now: Long) {
    val colors = console
    val releases = model.releases.orEmpty()
    val devices = model.devices.orEmpty()
    val release = releases.firstOrNull { it.version == model.version }
    val chosen = devices.filter { it.thing in model.things }
    val free = devices.filter { it.thing !in model.busy }
    val selectable = free.filter { !Updates.alreadyRuns(it, model.version) }
    val ready = !model.loading && model.loadError == null
    val steps = listOf("Release", "Boards", "Review")
    val last = model.step == steps.size - 1
    val canGoOn = if (model.step == 0) release != null else chosen.isNotEmpty()
    val hint = when {
        ready && model.step == 0 && releases.isNotEmpty() && release == null -> "Choose a release."
        ready && model.step == 1 && devices.isNotEmpty() && chosen.isEmpty() ->
            if (free.isEmpty()) "Every board has an unfinished update." else "Choose at least one board."
        else -> null
    }
    ConsoleDialog(
        title = AnnotatedString("New deployment"),
        onClose = vm::closeDialog,
        busy = model.sending,
        error = if (model.error != null) {
            { Failure("The deployment was not started.", model.error, extra = heldBy(model.error, devices)) }
        } else {
            null
        },
        foot = {
            ConsoleButton("Cancel", vm::closeDialog, enabled = !model.sending, small = true)
            Spacer(Modifier.weight(1f))
            if (model.step > 0) ConsoleButton("Back", vm::deployBack, enabled = !model.sending, small = true)
            if (last) {
                ConsoleButton(
                    if (model.sending) "Starting…" else "Deploy to ${Words.plural(chosen.size, "board")}",
                    vm::submitDeploy, kind = ButtonKind.PRIMARY, glyph = Glyph.SEND, small = true,
                    enabled = chosen.isNotEmpty(), busy = model.sending,
                )
            } else {
                ConsoleButton("Next", vm::deployNext, kind = ButtonKind.PRIMARY, small = true, enabled = !model.loading && canGoOn)
            }
        },
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            steps.forEachIndexed { index, label ->
                val current = index == model.step
                val done = index < model.step
                Row(Modifier.semantics(mergeDescendants = true) {}, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Box(
                        Modifier
                            .size(22.dp)
                            .clip(CircleShape)
                            .background(if (current) colors.accent else if (done) colors.ink else colors.well),
                        contentAlignment = Alignment.Center,
                    ) {
                        if (done) GlyphIcon(Glyph.CHECK, size = 12.dp, tint = colors.paper)
                        else Text((index + 1).toString(), style = ConsoleType.note.copy(fontWeight = FontWeight.Bold), color = if (current) colors.onAccent else colors.ink2)
                    }
                    Text(label + if (done) " (done)" else "", style = ConsoleType.note.copy(fontWeight = if (current) FontWeight.Bold else FontWeight.Normal), color = colors.ink)
                }
            }
        }
        if (hint != null) Note(hint)
        val gone = if (ready && model.gone != null) {
            @Composable {
                Notice(
                    Tone.WARN, Glyph.ALERT,
                    lead("${model.gone} has been revoked", ", so it cannot be deployed any more." + if (releases.isNotEmpty()) " Choose another release if you want to deploy one." else ""),
                )
            }
        } else {
            null
        }
        when {
            model.loading -> Loading("releases and boards")
            model.loadError != null -> Notice(
                Tone.BAD, Glyph.ALERT, lead("Could not load what a deployment needs.", messageOf(model.loadError)),
                more = problemRef(model.loadError),
                action = { ConsoleButton("Try again", vm::reloadDeploy, small = true) },
            )
            model.step == 0 && releases.isEmpty() -> {
                gone?.invoke()
                EmptyState(
                    Glyph.PACKAGE, "There is no release to deploy.",
                    "Upload a signed image on the Firmware page first. Revoked releases cannot be deployed.",
                    action = "Go to Firmware" to {
                        vm.closeDialog()
                        vm.open(Route.Firmware)
                    },
                )
            }
            model.step == 0 -> {
                gone?.invoke()
                Text("Which release?", style = ConsoleType.small.copy(fontWeight = FontWeight.SemiBold), color = colors.ink)
                for (candidate in releases) {
                    Choice(candidate.version == model.version, { vm.deployChoose(candidate.version) }, radio = true) {
                        Mono(candidate.version, style = ConsoleType.mono.copy(fontWeight = FontWeight.SemiBold))
                        Note("${Words.fileSize(candidate.size)} · uploaded ${Words.timeAgo(candidate.uploadedAt, now)} by ${Words.nameOf(candidate.uploadedBy)}")
                        if (candidate.notes.isNotEmpty()) Note(candidate.notes)
                    }
                }
            }
            model.step == 1 && devices.isEmpty() ->
                EmptyState(Glyph.CHIP, "No boards are registered yet.", "Provision one with", "python3 tools/provision_device.py")
            model.step == 1 -> {
                Text(
                    titled("Which boards get " to false, (model.version ?: "") to true, "?" to false),
                    style = ConsoleType.small.copy(fontWeight = FontWeight.SemiBold), color = colors.ink,
                )
                for (device in devices) {
                    val busy = model.busy[device.thing]
                    Choice(device.thing in model.things, { vm.deployToggle(device.thing) }, radio = false, enabled = busy == null) {
                        Wrap {
                            BoardName(device)
                            Presence(device)
                        }
                        Note(
                            (if (device.fw != null) "${if (device.online) "Runs" else "Last reported"} ${device.fw.version}" else "Has not reported a version") +
                                if (!device.online && device.lastSeen != null) " · last seen ${Words.timeAgo(device.lastSeen, now)}" else "",
                        )
                        when {
                            busy != null -> Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                GlyphIcon(Glyph.LOCK, Modifier.padding(top = 2.dp), size = 14.dp, tint = colors.warn)
                                Text(
                                    prose(
                                        "Has an unfinished update${busy.version?.let { " to $it" } ?: ""}. Finish or cancel that deployment first.",
                                    ),
                                    style = ConsoleType.note, color = colors.ink,
                                )
                            }
                            Updates.alreadyRuns(device, model.version) -> WillRefuse()
                            !device.online && device.lastSeen == null -> Note("It will see the offer when it first connects. $NEVER_REPORTED_HELP")
                            !device.online -> Note("Offline: it will see the offer when it reconnects.")
                        }
                    }
                }
                if (selectable.size > 1) {
                    ConsoleButton(
                        if (selectable.all { it.thing in model.things }) "Clear the selection" else "Select all ${selectable.size} available boards",
                        vm::deployToggleAll, small = true, kind = ButtonKind.QUIET,
                    )
                }
            }
            else -> DeployReview(vm, model, release, chosen, now)
        }
    }
}

@Composable
private fun WillRefuse() {
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        GlyphIcon(Glyph.ALERT, Modifier.padding(top = 2.dp), size = 14.dp, tint = console.warn)
        Text("Reports that it already runs this version or a newer one, so it will refuse the offer.", style = ConsoleType.note, color = console.ink)
    }
}

@Composable
private fun DeployReview(vm: ConsoleViewModel, model: DialogState.Deploy, release: com.craniumiot.cranium.core.Release?, chosen: List<Device>, now: Long) {
    val offline = chosen.count { !it.online && it.lastSeen != null }
    val never = chosen.count { !it.online && it.lastSeen == null }
    val asking = chosen.count(Updates::asksForButton)
    Facts(
        listOf(
            Fact("Release") {
                Mono(model.version.orEmpty(), style = ConsoleType.mono.copy(fontSize = 16.sp, fontWeight = FontWeight.SemiBold))
                if (release != null) Note("${Words.fileSize(release.size)} · SHA-256 ${release.sha256.take(12)}…")
            },
            Fact("Boards") {
                for (device in chosen) {
                    Wrap {
                        BoardName(device)
                        Presence(device)
                    }
                    if (Updates.alreadyRuns(device, model.version)) WillRefuse()
                }
            },
        ),
    )
    ConsoleField(
        model.note, vm::deployNote, "Note (optional, shown with the deployment)", maxLength = 200, enabled = !model.sending,
    )
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(6.dp))
            .border(1.dp, console.line, RoundedCornerShape(6.dp))
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("What happens when you deploy", style = ConsoleType.small.copy(fontWeight = FontWeight.SemiBold), color = console.ink)
        Consequences(
            listOfNotNull(
                prose(
                    "Each board gets ${model.version}. Firmware ${Updates.FIRST_WITH_NO_BUTTON} or newer installs it as soon as the " +
                        "board sees it, with nobody at the board.",
                ),
                if (asking > 0) {
                    prose(
                        "${Words.plural(asking, "board runs", "boards run")} older firmware, which installs nothing until someone presses " +
                            "Button 1 on the board; Button 2 declines.",
                    )
                } else {
                    null
                },
                prose(
                    if (offline > 0) {
                        "${Words.plural(offline, "board is", "boards are")} offline and will see the update after reconnecting. " +
                            "It stays open until it is cancelled."
                    } else {
                        "It stays open until a board acts on it or the deployment is cancelled."
                    },
                ),
                if (never > 0) {
                    prose(
                        "${Words.plural(never, "board has", "boards have")} never connected and will see the update when first " +
                            "connected. $NEVER_REPORTED_HELP",
                    )
                } else {
                    null
                },
                prose(
                    "A board checks the download and its bootloader checks the signature. If the new firmware cannot reconnect, " +
                        "the bootloader puts the previous one back.",
                ),
                prose("These boards cannot be given another deployment until this one has finished or been cancelled."),
            ),
        )
    }
    Note(FRESH_NOTE)
}

@Composable
fun CancelDialog(vm: ConsoleViewModel, model: DialogState.Cancel, store: Store) {
    val detail = store.deploymentDetails[model.id]?.value
    val executions = detail?.executions.orEmpty()
    val waiting = executions.count { it.status == "QUEUED" }
    val started = executions.count { it.status == "IN_PROGRESS" }
    val over = waiting + started == 0
    // Cancelled before, without force: the one thing left is to stop the boards that had started.
    val withdrawn = !over && detail?.status == "CANCELED"
    val force = model.force || withdrawn
    val version = detail?.version ?: Updates.versionOfDeployment(model.id) ?: "this release"
    val label = when {
        withdrawn && model.sending -> "Stopping…"
        withdrawn -> "Stop boards"
        model.sending -> "Cancelling…"
        force -> "Cancel and stop boards"
        else -> "Cancel the deployment"
    }
    ConsoleDialog(
        title = if (withdrawn) titled("Stop the boards that are installing " to false, version to true, "?" to false)
        else titled("Cancel the deployment of " to false, version to true, "?" to false),
        onClose = vm::closeDialog,
        busy = model.sending,
        error = if (model.error != null && !over) {
            { Failure(if (withdrawn) "The boards were not stopped." else "Not cancelled.", model.error) }
        } else {
            null
        },
        foot = {
            ConsoleButton(if (over || withdrawn) "Close" else "Keep the deployment", vm::closeDialog, enabled = !model.sending, small = true)
            Spacer(Modifier.weight(1f))
            ConsoleButton(label, { vm.submitCancel(force) }, kind = ButtonKind.DANGER, small = true, enabled = !over, busy = model.sending)
        },
    ) {
        if (over) {
            Text(lead("Nothing is left to cancel.", "No board is waiting for this update any more, and none is installing it."), style = ConsoleType.small)
        } else {
            Text(
                buildAnnotatedString {
                    append("Right now ")
                    withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append("${Words.plural(waiting, "board is", "boards are")} waiting") }
                    append(" and ")
                    withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append("${Words.plural(started, "board has", "boards have")} started") }
                    append(". Boards that already finished are not affected.")
                },
                style = ConsoleType.small,
            )
            Text("How far should the cancellation go?", style = ConsoleType.small.copy(fontWeight = FontWeight.SemiBold), color = console.ink)
            Choice(!force, { vm.cancelForce(false) }, radio = true, enabled = !model.sending && !withdrawn) {
                Text("Withdraw the offer", style = ConsoleType.small.copy(fontWeight = FontWeight.SemiBold))
                Note(
                    if (withdrawn) {
                        "Done already: this deployment was cancelled before, so boards that had not started are no longer offered it."
                    } else {
                        "Boards that have not started are no longer offered this update. A board that is already downloading or " +
                            "installing carries on and finishes."
                    },
                )
            }
            Choice(force, { vm.cancelForce(true) }, radio = true, enabled = !model.sending) {
                Text("Withdraw the offer and stop boards that have started", style = ConsoleType.small.copy(fontWeight = FontWeight.SemiBold))
                Note(
                    "Forced. A board that is downloading or checking the image stops before installing, because it asks AWS first " +
                        "and finds the update cancelled. A board that is already restarting into the new firmware cannot be " +
                        "stopped; it may still finish, but it can no longer report the result here.",
                )
            }
            Quiet(
                "A cancellation takes a few seconds to reach every board’s record. It cannot be undone; to try again, start a new deployment.",
                style = ConsoleType.note,
            )
            Note(FRESH_NOTE)
        }
    }
}

@Composable
fun RevokeDialog(vm: ConsoleViewModel, model: DialogState.Revoke, store: Store, now: Long) {
    val release = store.releases?.firstOrNull { it.version == model.version } ?: return
    val steps = listOf(
        prose("The image stops downloading at once, also for a board that is in the middle of downloading it."),
        prose("Every unfinished deployment of ${release.version} is cancelled, including on boards that have already started. They stop before installing."),
    )
    if (!release.isActive) {
        val open = Updates.revocationState(release) == Updates.RevocationState.INCOMPLETE
        val mark = release.revoked
        ConsoleDialog(
            title = if (open) titled("Finish revoking " to false, release.version to true, "?" to false)
            else titled("Apply the revocation of " to false, release.version to true, " again?" to false),
            onClose = vm::closeDialog,
            busy = model.sending,
            error = if (model.error != null) { { Failure(if (open) "Not finished." else "Not applied.", model.error) } } else null,
            foot = {
                ConsoleButton("Close", vm::closeDialog, enabled = !model.sending, small = true)
                Spacer(Modifier.weight(1f))
                ConsoleButton(
                    when {
                        model.sending && open -> "Finishing…"
                        model.sending -> "Applying…"
                        open -> "Finish revoking"
                        else -> "Apply again"
                    },
                    vm::submitRevoke, kind = ButtonKind.PRIMARY, glyph = Glyph.BAN, small = true, busy = model.sending,
                )
            },
        ) {
            Text(
                if (open) {
                    "This release is marked revoked, but the server has not recorded that the two steps after the mark were " +
                        "completed. Finishing repeats them:"
                } else {
                    "This release is revoked. Applying the revocation again repeats the two steps after the mark, in case one of " +
                        "them did not go through:"
                },
                style = ConsoleType.small,
            )
            Consequences(steps)
            if (mark != null) {
                Note("Revoked ${Words.timeAgo(mark.at, now)} by ${Words.nameOf(mark.by)}${if (mark.reason.isNotEmpty()) ": ${mark.reason}" else ""}")
            }
            Quiet("That record stays as it is: who revoked the release, when and why.", style = ConsoleType.note)
            Note(FRESH_NOTE)
        }
        return
    }
    val reason = Words.singleLine(model.reason)
    val length = model.reason.length
    ConsoleDialog(
        title = titled("Revoke " to false, release.version to true, "?" to false),
        onClose = vm::closeDialog,
        busy = model.sending,
        error = if (model.error != null) { { Failure("Not revoked.", model.error) } } else null,
        foot = {
            ConsoleButton("Keep the release", vm::closeDialog, enabled = !model.sending, small = true)
            Spacer(Modifier.weight(1f))
            ConsoleButton(
                if (model.sending) "Revoking…" else "Revoke ${release.version}", vm::submitRevoke,
                kind = ButtonKind.DANGER, glyph = Glyph.BAN, small = true, enabled = reason.isNotEmpty(), busy = model.sending,
            )
        },
    ) {
        Text("Revoking withdraws a release for good. Use it when an image must not be installed any more.", style = ConsoleType.small)
        Consequences(
            steps + listOf(
                prose("It can never be deployed again, and its version number stays used: the next upload must still be newer."),
                prose("Boards that already run ${release.version} keep running it. To replace it there, upload a newer version and deploy that."),
                prose("This cannot be undone."),
            ),
        )
        ConsoleField(
            model.reason, vm::revokeReason, "Reason (required)", singleLine = false, minLines = 2, enabled = !model.sending,
            hint = "Recorded in the activity log and shown next to the release. Up to ${ConsoleViewModel.REASON_LIMIT} characters." +
                if (length >= 160) " $length / ${ConsoleViewModel.REASON_LIMIT}" else "",
            maxLength = ConsoleViewModel.REASON_LIMIT,
        )
        if (reason.isEmpty()) Note("Give a reason first.")
        Note(FRESH_NOTE)
    }
}

@Composable
fun CreateTokenDialog(vm: ConsoleViewModel, model: DialogState.CreateToken, now: Long) {
    val made = model.made
    if (made != null) {
        ConsoleDialog(
            title = AnnotatedString("Your new API token"),
            onClose = vm::closeDialog,
            busy = false,
            locked = true,
            foot = {
                Spacer(Modifier.weight(1f))
                ConsoleButton("Done", vm::closeDialog, kind = ButtonKind.PRIMARY, small = true)
            },
        ) {
            Notice(
                Tone.WARN, Glyph.ALERT,
                lead("Copy it now: you won’t see this token again.", "The console keeps only a digest of it, from which it cannot be read back."),
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                SelectionContainer(Modifier.weight(1f)) { Code(made.token) }
                CopyButton(made.token, "the token", sensitive = true, onCopied = { vm.notify(it) })
            }
            Facts(
                listOf(
                    Fact("Name") { Text(made.name, style = ConsoleType.small) },
                    Fact("ID") {
                        Mono(made.id)
                        Note("How the list and the activity log name it.")
                    },
                    Fact("Expires") { Text(made.expiresAt?.let { Words.dateAndTime(it) } ?: "—", style = ConsoleType.small) },
                ),
            )
            Text(
                prose(
                    "Keep it like a password. For scripts/ota.sh, put it in ~/.cranium/console-token on your computer and make that " +
                        "file readable by you alone, for example on a Mac after copying:",
                ),
                style = ConsoleType.small,
            )
            Code("mkdir -p ~/.cranium && (umask 077 && pbpaste > ~/.cranium/console-token)")
        }
        return
    }
    val name = model.name.trim()
    val days = ConsoleViewModel.tokenDaysOf(model.days)
    val hint = when {
        name.isEmpty() -> "Give it a name first."
        days == null -> "Choose 1 to 90 days."
        else -> null
    }
    ConsoleDialog(
        title = AnnotatedString("New API token"),
        onClose = vm::closeDialog,
        busy = model.sending,
        error = if (model.error != null) { { Failure("No token was made.", model.error) } } else null,
        foot = {
            ConsoleButton("Cancel", vm::closeDialog, enabled = !model.sending, small = true)
            Spacer(Modifier.weight(1f))
            ConsoleButton(
                if (model.sending) "Making…" else "Make token", vm::submitToken, kind = ButtonKind.PRIMARY, glyph = Glyph.KEY,
                small = true, enabled = hint == null, busy = model.sending,
            )
        },
    ) {
        Text("A script that has this token can use the console’s API as you, with what you may do at that moment.", style = ConsoleType.small)
        ConsoleField(
            model.name, vm::tokenName, "Name (required)", enabled = !model.sending, maxLength = 40,
            hint = "What it is for: the computer or the script that uses it. Up to 40 characters.",
        )
        ConsoleField(
            model.days, vm::tokenDays, "Valid for, in days", enabled = !model.sending, keyboardType = KeyboardType.Number,
            hint = "From 1 to 90. A token cannot be extended: make a new one when it runs out.",
        )
        if (hint != null) Note(hint)
        Note(FRESH_NOTE)
    }
}

@Composable
fun RevokeTokenDialog(vm: ConsoleViewModel, model: DialogState.RevokeToken, now: Long) {
    val token = model.token
    ConsoleDialog(
        title = titled("Revoke the token “${token.name}”?" to false),
        onClose = vm::closeDialog,
        busy = model.sending,
        error = if (model.error != null) { { Failure("Not revoked.", model.error) } } else null,
        foot = {
            ConsoleButton("Keep the token", vm::closeDialog, enabled = !model.sending, small = true)
            Spacer(Modifier.weight(1f))
            ConsoleButton(
                if (model.sending) "Revoking…" else "Revoke token", vm::submitRevokeToken, kind = ButtonKind.DANGER,
                glyph = Glyph.BAN, small = true, busy = model.sending,
            )
        },
    ) {
        Facts(
            listOf(
                Fact("ID") { Mono(token.id) },
                Fact("Made") { Text(Words.timeAgo(token.createdAt, now), style = ConsoleType.small) },
                Fact("Expires") { Text(until(token.expiresAt, now), style = ConsoleType.small) },
            ),
        )
        Consequences(
            listOf(
                prose("A script that uses it is refused from its next request on."),
                prose("What it has done stays done, and stays in the activity log."),
                prose("This cannot be undone. A script that still needs access needs a new token."),
            ),
        )
        Note(FRESH_NOTE)
    }
}

/** A time still to come: how long until then. */
fun until(iso: String?, now: Long): String {
    val at = com.craniumiot.cranium.core.Times.parse(iso) ?: return ""
    val left = at - now
    return if (left > 0) "in ${Words.duration(left / 1000.0)}" else Words.dateAndTime(iso)
}
