package com.craniumiot.cranium.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.craniumiot.cranium.core.ApiError
import com.craniumiot.cranium.core.Glyph
import com.craniumiot.cranium.core.ImageChecks
import com.craniumiot.cranium.core.Outcomes
import com.craniumiot.cranium.core.Release
import com.craniumiot.cranium.core.Tone
import com.craniumiot.cranium.core.UploadReview
import com.craniumiot.cranium.core.Updates
import com.craniumiot.cranium.core.Words

/** Every release, active and revoked. One action: upload. */
@Composable
fun FirmwareScreen(vm: ConsoleViewModel, store: Store, now: Long) {
    val firmware = store.firmware.value
    val canWrite = store.me?.canWrite == true
    val newest = firmware?.releases?.firstOrNull { it.isActive }
    ConsoleScreen(
        title = "Firmware",
        help = "firmware-and-signing",
        primary = if (canWrite) ScreenAction("Upload", Glyph.UPLOAD) { vm.open(Route.Upload) } else null,
        actions = listOfNotNull(
            if (canWrite) ScreenAction("Update over Bluetooth", Glyph.BLUETOOTH) { vm.open(Route.Bluetooth(null)) } else null,
            if (store.cache.count > 0) ScreenAction("Clear downloaded firmware", Glyph.X) { vm.clearFirmware() } else null,
        ),
        stale = staleOf(listOf(store.firmware), vm.intervalOf(Route.Firmware), now, vm::refreshNow),
        onRefresh = { vm.refresh(Route.Firmware, full = true) },
    ) {
        problem(store.firmware.error, "the releases", firmware != null, vm::refreshNow)
        when {
            firmware == null -> if (store.firmware.error == null) loading("releases")
            firmware.releases.isEmpty() -> item(key = "none") {
                OneLine("No firmware has been uploaded yet.", if (canWrite) "Upload" to { vm.open(Route.Upload) } else null)
            }
            else -> for (release in firmware.releases) {
                item(key = release.version) { ReleaseRow(vm, release, release == newest, store, now) }
            }
        }
    }
}

@Composable
private fun ReleaseRow(vm: ConsoleViewModel, release: Release, newest: Boolean, store: Store, now: Long) {
    val revocation = Updates.revocationState(release)
    ListRow(
        release.version,
        mono = true,
        supporting = if (release.isActive) {
            listOf(Words.fileSize(release.size), "uploaded ${Words.timeAgo(release.uploadedAt, now)}").joinToString(" · ")
        } else {
            "Revoked ${Words.timeAgo(release.revoked?.at, now)}" + (release.revoked?.reason?.takeIf { it.isNotEmpty() }?.let { ": $it" } ?: "")
        },
        leading = { StateDot(if (release.isActive) Tone.GOOD else Tone.BAD) },
        trailing = {
            when {
                revocation == Updates.RevocationState.INCOMPLETE -> Badge(Tone.WARN, Glyph.ALERT, "Incomplete")
                newest -> Tag("Newest")
                store.cache.holds(release) -> Tag("On this phone")
            }
        },
        onClick = { vm.open(Route.Release(release.version)) },
        headlineColor = if (release.isActive) null else console.ink2,
    )
}

/** A release: its facts, deploying it, and, only here, revoking it. */
@Composable
fun ReleaseScreen(vm: ConsoleViewModel, store: Store, version: String, now: Long) {
    val firmware = store.firmware.value
    val release = firmware?.releases?.firstOrNull { it.version == version }
    val canWrite = store.me?.canWrite == true
    val context = LocalContext.current
    val revocation = release?.let { Updates.revocationState(it) }
    val primary = when {
        !canWrite || release == null -> null
        release.isActive -> ScreenAction("Deploy", Glyph.SEND) { vm.openDeploy(version) }
        revocation == Updates.RevocationState.INCOMPLETE -> ScreenAction("Finish revoking", Glyph.BAN) { vm.openRevoke(version) }
        else -> null
    }
    ConsoleScreen(
        title = version,
        titleMono = true,
        help = "firmware-and-signing",
        primary = primary,
        actions = listOfNotNull(
            if (canWrite && release?.isActive == true) ScreenAction("Send over Bluetooth", Glyph.BLUETOOTH) { vm.open(Route.Bluetooth(version)) } else null,
            release?.let { r ->
                ScreenAction("Copy the SHA-256", Glyph.COPY) {
                    copyToClipboard(context, r.sha256, "the SHA-256", sensitive = false)
                    vm.notify("Copied the SHA-256 of $version.")
                }
            },
            if (canWrite && revocation == Updates.RevocationState.UNKNOWN) ScreenAction("Apply the revocation again", Glyph.BAN) { vm.openRevoke(version) } else null,
            if (canWrite && release?.isActive == true) ScreenAction("Revoke", Glyph.BAN, danger = true) { vm.openRevoke(version) } else null,
        ),
        stale = staleOf(listOf(store.firmware), vm.intervalOf(Route.Release(version)), now, vm::refreshNow),
        onRefresh = { vm.refresh(Route.Release(version), full = true) },
    ) {
        problem(store.firmware.error, "the release", firmware != null, vm::refreshNow)
        if (firmware == null) {
            if (store.firmware.error == null) loading("the release")
            return@ConsoleScreen
        }
        if (release == null) {
            item(key = "missing") { OneLine("There is no release $version.", "All releases" to { vm.open(Route.Firmware) }) }
            return@ConsoleScreen
        }
        block("status") {
            Wrap { ReleaseBadges(release) }
            if (release.notes.isNotEmpty()) Text(release.notes, style = ConsoleType.body, color = console.ink)
        }
        if (revocation == Updates.RevocationState.INCOMPLETE) {
            item(key = "incomplete") {
                OneLine("The server has not recorded that the image is refused and its deployments cancelled.", tone = Tone.WARN, glyph = Glyph.ALERT)
            }
        }
        val boards = store.deviceList.orEmpty().filter { it.fw?.version == version }
        item(key = "boards") {
            ValueRow(
                "Boards on it", Words.plural(boards.size, "board"),
                supporting = boards.joinToString(", ") { called(it) }.ifEmpty { null },
            )
        }
        item(key = "size") {
            val slot = firmware.slotSize
            ValueRow(
                "Size", sizeWords(release.size),
                supporting = slot?.takeIf { it > 0 }?.let {
                    val percent = release.size * 100.0 / it
                    "Takes ${if (percent < 1) "under 1%" else "${Math.round(percent)}%"} of the ${Words.fileSize(it)} update slot"
                },
            )
        }
        item(key = "uploaded") {
            ValueRow("Uploaded", Words.timeAgo(release.uploadedAt, now), supporting = "${Words.exactTime(release.uploadedAt)} by ${Words.nameOf(release.uploadedBy)}")
        }
        header("Image")
        if (release.filename.isNotEmpty()) item(key = "file") { ValueRow("File", release.filename, mono = true) }
        item(key = "sha") { ValueRow("File SHA-256", release.sha256, mono = true, supporting = "What a board checks after downloading") }
        if (release.imageHash.isNotEmpty()) item(key = "hash") { ValueRow("Image hash", release.imageHash, mono = true, supporting = "What the signature covers") }
        if (release.keyHash.isNotEmpty()) {
            item(key = "key") {
                val fingerprint = firmware.fingerprint
                ValueRow(
                    "Signed with", release.keyHash, mono = true,
                    supporting = when {
                        fingerprint.isNotEmpty() && release.keyHash != fingerprint -> "An earlier key, replaced since"
                        release.keyHash == fingerprint -> "This project’s signing key"
                        else -> null
                    },
                )
            }
        }
        release.loadAddress?.let { address -> item(key = "load") { ValueRow("Load address", "0x${address.toString(16)}", mono = true) } }
        release.revoked?.let { mark ->
            header("Revoked")
            item(key = "rev-when") { ValueRow("When", Words.timeAgo(mark.at, now), supporting = "${Words.exactTime(mark.at)} by ${Words.nameOf(mark.by)}") }
            if (mark.reason.isNotEmpty()) item(key = "rev-why") { ValueRow("Reason", mark.reason) }
            item(key = "rev-enforced") {
                ValueRow(
                    "Enforced", mark.enforcedAt?.let { Words.exactTime(it) } ?: "Not recorded",
                    supporting = if (mark.enforcedAt != null) "The image is refused and every open deployment of it was cancelled" else null,
                )
            }
        }
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

private fun sizeWords(bytes: Long): String {
    val short = Words.fileSize(bytes)
    return if (short == Words.exactBytes(bytes)) short else "$short (${Words.exactBytes(bytes)})"
}

// Uploading a signed image: choose it, check it here, have the server verify it, deploy it.

@Composable
fun UploadScreen(vm: ConsoleViewModel, store: Store) {
    val upload by vm.upload.collectAsStateWithLifecycle()
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> if (uri != null) vm.chooseFile(uri) }
    val pick = {
        vm.resetUpload()
        picker.launch(arrayOf("application/octet-stream", "*/*"))
    }
    val header = upload.header
    val review = if (header != null && (upload.step == UploadStep.READY || upload.step == UploadStep.REFUSED)) {
        UploadReview.review(header, upload.size, upload.digest, store.firmware.value)
    } else {
        null
    }
    val refused = upload.step == UploadStep.REFUSED
    val error = upload.error
    val final = refused && error != null && !Outcomes.canRetryUpload(error)
    val doomed = review?.doomed == true && !refused
    val release = upload.release
    val registered = release != null && store.releases?.firstOrNull { it.version == release.version }?.isActive != false
    val deployed = release?.let { r -> store.deployments.value?.firstOrNull { it.version == r.version }?.id }
    val primary = when (upload.step) {
        UploadStep.IDLE -> ScreenAction("Choose a file", Glyph.FILE) { pick() }
        UploadStep.READY, UploadStep.REFUSED -> when {
            final || doomed || review?.blocked == true -> ScreenAction("Choose another file", Glyph.FILE) { pick() }
            else -> ScreenAction(if (refused) "Try again" else "Upload for verification", Glyph.UPLOAD) { vm.startUpload() }
        }
        UploadStep.DONE -> when {
            !registered -> ScreenAction("Choose a file", Glyph.FILE) { pick() }
            deployed != null -> ScreenAction("Open its deployment", Glyph.ARROW_RIGHT) { vm.open(Route.DeploymentPage(deployed)) }
            else -> ScreenAction("Deploy this release", Glyph.SEND) { vm.openDeploy(release.version) }
        }
        else -> null
    }
    ConsoleScreen(
        title = "Upload firmware",
        help = "firmware-and-signing",
        primary = primary,
        actions = listOfNotNull(
            if (upload.step != UploadStep.IDLE && upload.step != UploadStep.SENDING && upload.step != UploadStep.CHECKING) {
                ScreenAction("Choose another file", Glyph.FILE) { pick() }
            } else {
                null
            },
        ),
    ) {
        if (store.me?.canWrite != true) {
            item(key = "viewer") { OneLine("Only a release manager can upload firmware.") }
            return@ConsoleScreen
        }
        when (upload.step) {
            UploadStep.IDLE -> item(key = "idle") {
                OneLine("Choose the signed image of a build: binaries/latest.signed.bin.")
            }
            UploadStep.READING -> loading("the file")
            UploadStep.DONE -> if (release != null && registered) {
                item(key = "done") {
                    ListRow(
                        "Registered as ${release.version}",
                        supporting = "Verified by the server: the signature is valid and the image is stored",
                        leading = { GlyphIcon(Glyph.CHECK_CIRCLE, tint = console.good) },
                        onClick = { vm.open(Route.Release(release.version)) },
                    )
                }
                header("What the server checked")
                val first = store.releases.orEmpty().all { it.version == release.version }
                for (check in ImageChecks.ALL) {
                    item(key = "check-${check.name}") {
                        ListRow(check.name, supporting = if (first && check.passedFirst != null) check.passedFirst else check.passed, leading = { GlyphIcon(Glyph.CHECK_CIRCLE, tint = console.good) })
                    }
                }
            } else {
                item(key = "gone") { OneLine("That release has been revoked since.") }
            }
            else -> {
                item(key = "file") { ListRow(upload.name, leading = { GlyphIcon(Glyph.FILE, tint = console.ink2) }) }
                if (header?.ok == true) {
                    item(key = "version") { ValueRow("Version", header.version, mono = true) }
                    item(key = "size") { ValueRow("Size", sizeWords(upload.size)) }
                    item(key = "sha") { ValueRow("SHA-256", upload.digest, mono = true) }
                    item(key = "layout") {
                        ValueRow("Layout", "${Words.exactBytes(header.headerSize.toLong())} of header, ${Words.exactBytes(header.payloadSize)} of firmware")
                    }
                    if (upload.recordedAs != upload.name) item(key = "recorded") { ValueRow("Recorded as", upload.recordedAs, mono = true) }
                }
                header("Checks")
                val notes = when {
                    final -> emptyList()
                    review == null -> emptyList()
                    review.blocked || refused || doomed || upload.step == UploadStep.SENDING || upload.step == UploadStep.CHECKING -> review.notes
                    else -> review.notes + UploadReview.Note(UploadReview.NoteTone.WAIT, UploadReview.SIGNATURE_UNCHECKED)
                }
                notes.forEachIndexed { index, note ->
                    item(key = "note-$index") {
                        val (tone, glyph) = when (note.tone) {
                            UploadReview.NoteTone.GOOD -> Tone.GOOD to Glyph.CHECK_CIRCLE
                            UploadReview.NoteTone.WARN -> Tone.WARN to Glyph.ALERT
                            UploadReview.NoteTone.BAD -> Tone.BAD to Glyph.X_CIRCLE
                            UploadReview.NoteTone.WAIT -> Tone.WAIT to Glyph.CLOCK
                        }
                        ListRow(note.text, leading = { GlyphIcon(glyph, tint = console.toneInk(tone)) })
                    }
                }
                if (refused && error != null) {
                    item(key = "refused") {
                        val check = ImageChecks.failedCheck((error as? ApiError)?.code)
                        Failure(
                            if (final) "The server refused this image." else "The image was not stored.", error,
                            Modifier.padding(horizontal = Gutter),
                            extra = check?.let { "Check that failed: $it. Nothing was stored." },
                        )
                    }
                }
                when (upload.step) {
                    UploadStep.SENDING -> block("sending") {
                        val percent = (upload.sent * 100).toInt()
                        Text("Uploading… $percent%", style = ConsoleType.small, color = console.ink)
                        Meter(percent, "Upload")
                    }
                    UploadStep.CHECKING -> block("checking") {
                        Text("Uploaded. The server is verifying the signature…", style = ConsoleType.small, color = console.ink)
                        LinearProgressIndicator(Modifier.fillMaxWidth(), color = console.barLive, trackColor = console.workWash)
                    }
                    else -> if (!final && !doomed && review?.blocked != true) {
                        block("notes") {
                            ConsoleField(upload.notes, vm::setUploadNotes, "Notes (optional)", singleLine = false, minLines = 2, maxLength = 500)
                        }
                    }
                }
            }
        }
    }
}
