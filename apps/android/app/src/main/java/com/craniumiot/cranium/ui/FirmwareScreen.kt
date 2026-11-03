package com.craniumiot.cranium.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.craniumiot.cranium.core.ApiError
import com.craniumiot.cranium.core.Glyph
import com.craniumiot.cranium.core.ImageChecks
import com.craniumiot.cranium.core.Outcomes
import com.craniumiot.cranium.core.Release
import com.craniumiot.cranium.core.Times
import com.craniumiot.cranium.core.Tone
import com.craniumiot.cranium.core.UploadReview
import com.craniumiot.cranium.core.Updates
import com.craniumiot.cranium.core.Words

@Composable
fun FirmwareScreen(vm: ConsoleViewModel, store: Store, now: Long) {
    val firmware = store.firmware.value
    val canWrite = store.me?.canWrite == true
    val upload by vm.upload.collectAsStateWithLifecycle()
    PageHead(
        "Firmware",
        lede = "Signed images that can be offered to boards. A version, once used, is never reused.",
        tools = { Freshness(store.firmware.loadedAt, store.firmware.loading, vm.intervalOf(Route.Firmware), now, vm::refreshNow) },
    )
    LoadProblem(store.firmware.error, "the releases", firmware != null, store.firmware.loadedAt, now, vm::refreshNow)
    if (canWrite) {
        InkPanel(Modifier.padding(bottom = 24.dp)) {
            Eyebrow("Upload, verify, deploy")
            Spacer(Modifier.height(12.dp))
            UploadStages(upload, store)
            Spacer(Modifier.height(16.dp))
            UploadPanel(vm, upload, store, now)
            Spacer(Modifier.height(20.dp))
            if (upload.step == UploadStep.DONE && stillRegistered(upload, store)) VerifiedProof(store, upload) else TrustPanel(vm, store)
        }
    }
    if (firmware != null && firmware.releases.isNotEmpty()) {
        if (canWrite) {
            Section(title = "Release timeline") { ReleaseTimeline(store, now) }
        } else {
            InkPanel(Modifier.padding(bottom = 24.dp)) {
                Eyebrow("Release timeline")
                Spacer(Modifier.height(12.dp))
                ReleaseTimeline(store, now)
            }
            Section { TrustPanel(vm, store) }
        }
    }
    if (canWrite && store.cache.count > 0) {
        Row(Modifier.fillMaxWidth().padding(bottom = 16.dp), verticalAlignment = Alignment.CenterVertically) {
            Note(Messages.firmwareOnPhone(store.cache), Modifier.weight(1f))
            ConsoleButton("Clear downloaded firmware", vm::clearFirmware, small = true, kind = ButtonKind.QUIET)
        }
    }
    Section(title = "Releases") {
        when {
            firmware == null -> if (store.firmware.error == null) Loading("releases")
            firmware.releases.isEmpty() -> EmptyState(
                Glyph.PACKAGE, "No firmware has been uploaded yet.",
                if (canWrite) "Build the firmware, then upload binaries/latest.signed.bin to register the first release."
                else "A release manager can upload the first signed image.",
            )
            else -> for (release in firmware.releases) ReleaseRow(vm, release, store, now)
        }
    }
}

private fun stillRegistered(upload: UploadState, store: Store): Boolean {
    val version = upload.release?.version ?: return false
    val known = store.releases?.firstOrNull { it.version == version }
    return known == null || known.isActive
}

private fun refusedForGood(upload: UploadState): Boolean {
    val error = upload.error ?: return false
    val status = (error as? ApiError)?.status
    return upload.step == UploadStep.REFUSED && !Outcomes.canRetryUpload(error) && status != 401 && status != 403
}

private fun deployedAlready(upload: UploadState, store: Store): String? {
    val version = upload.release?.version ?: return null
    return store.deployments.value?.firstOrNull { it.version == version }?.id
}

/** Where a file stands on its way to the boards: a word and a mark for each stage. */
@Composable
private fun UploadStages(upload: UploadState, store: Store) {
    val colors = console
    val finished = upload.step == UploadStep.DONE && stillRegistered(upload, store)
    val review = if (upload.step == UploadStep.READY && upload.header != null) {
        UploadReview.review(upload.header, upload.size, upload.digest, store.firmware.value)
    } else {
        null
    }
    val unusable = review?.blocked == true || review?.doomed == true
    val sentOff = upload.step == UploadStep.SENDING || upload.step == UploadStep.CHECKING || upload.step == UploadStep.REFUSED || finished
    val choose = when {
        sentOff -> "done" to "done"
        unusable -> "failed" to "cannot be used"
        else -> "act" to "your turn"
    }
    val verify = when {
        upload.step == UploadStep.SENDING -> "live" to "uploading"
        upload.step == UploadStep.CHECKING -> "live" to "the server is verifying"
        finished -> "good" to "signature valid"
        refusedForGood(upload) -> "failed" to "refused, nothing stored"
        upload.step == UploadStep.REFUSED -> "failed" to "not finished"
        else -> "ahead" to "not started"
    }
    val deploy = when {
        finished && deployedAlready(upload, store) != null -> "done" to "started"
        finished -> "act" to "your turn"
        else -> "ahead" to "not started"
    }
    val stages = listOf("Choose a signed image" to choose, "The server verifies it" to verify, "Deploy it to boards" to deploy)
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        stages.forEachIndexed { index, (label, stage) ->
            val (state, word) = stage
            val tint = when (state) {
                "act" -> colors.accent
                "live" -> colors.work
                "good" -> colors.good
                "failed" -> colors.bad
                "done" -> colors.ink
                else -> colors.ink3
            }
            Row(
                Modifier.semantics(mergeDescendants = true) { stateDescription = word },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Box(
                    Modifier.size(24.dp).clip(CircleShape).border(1.5.dp, tint, CircleShape).clearAndSetSemantics {},
                    contentAlignment = Alignment.Center,
                ) {
                    when (state) {
                        "done", "good" -> GlyphIcon(Glyph.CHECK, size = 14.dp, tint = tint)
                        "failed" -> GlyphIcon(Glyph.X, size = 14.dp, tint = tint)
                        else -> Text((index + 1).toString(), style = ConsoleType.note.copy(fontWeight = FontWeight.Bold), color = tint)
                    }
                }
                Column {
                    Text(label, style = ConsoleType.small.copy(fontWeight = FontWeight.SemiBold), color = colors.ink)
                    Text(word, style = ConsoleType.note, color = tint)
                }
            }
        }
    }
}

private fun sizeWords(bytes: Long): String {
    val short = Words.fileSize(bytes)
    return if (short == Words.exactBytes(bytes)) short else "${Words.exactBytes(bytes)} ($short)"
}

@Composable
private fun UploadPanel(vm: ConsoleViewModel, upload: UploadState, store: Store, now: Long) {
    val colors = console
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> if (uri != null) vm.chooseFile(uri) }
    val pick = { picker.launch(arrayOf("application/octet-stream", "*/*")) }
    when (upload.step) {
        UploadStep.IDLE -> {
            val slot = store.firmware.value?.slotSize
            Column(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(6.dp))
                    .border(1.dp, colors.lineField, RoundedCornerShape(6.dp))
                    .clickable(role = Role.Button, onClickLabel = "Choose a file", onClick = pick)
                    .padding(20.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                GlyphIcon(Glyph.UPLOAD, size = 28.dp, tint = colors.accent)
                Text(prose("Choose latest.signed.bin"), style = ConsoleType.body.copy(fontWeight = FontWeight.SemiBold), color = colors.ink)
                Note((if (slot != null) "A signed MCUboot image, up to ${Words.fileSize(slot)}. " else "A signed MCUboot image. ") + "Nothing is sent until you have checked what the file contains.")
                Note("Each build leaves its signed image in binaries/latest.signed.bin in your checkout. Copy it to the phone, or open it from a drive.")
                ConsoleButton("Choose a file", pick, kind = ButtonKind.PRIMARY, glyph = Glyph.FILE)
            }
        }
        UploadStep.READING -> {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                GlyphIcon(Glyph.FILE)
                Mono(upload.name)
            }
            Quiet("Reading the file…")
        }
        UploadStep.DONE -> if (stillRegistered(upload, store)) VerifiedResult(vm, upload, store) else {
            Quiet("That release has been revoked since. Choose another file.")
            ConsoleButton("Choose a file", { vm.resetUpload(); pick() }, small = true, glyph = Glyph.FILE)
        }
        else -> ChosenFile(vm, upload, store, now, pick)
    }
}

@Composable
private fun ChosenFile(vm: ConsoleViewModel, upload: UploadState, store: Store, now: Long, pick: () -> Unit) {
    val header = upload.header ?: UploadReview.Header(false, "The file could not be read.")
    val review = UploadReview.review(header, upload.size, upload.digest, store.firmware.value)
    val busy = upload.step == UploadStep.SENDING || upload.step == UploadStep.CHECKING
    val refused = upload.step == UploadStep.REFUSED
    val final = refused && upload.error != null && !Outcomes.canRetryUpload(upload.error)
    val ofImage = refusedForGood(upload)
    val doomed = review.doomed && !refused
    var checks: List<UploadReview.Note> = review.notes + UploadReview.Note(UploadReview.NoteTone.WAIT, UploadReview.SIGNATURE_UNCHECKED)
    if (final) checks = emptyList() else if (review.blocked || refused || doomed || busy) checks = review.notes
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            GlyphIcon(Glyph.FILE)
            Mono(upload.name, Modifier.weight(1f))
            if (!(busy || final || doomed)) ConsoleButton("Choose another file", { vm.resetUpload(); pick() }, small = true)
        }
        if (header.ok) {
            Facts(
                listOfNotNull(
                    Fact("Version") { Mono(header.version, style = ConsoleType.mono.copy(fontSize = 16.sp, fontWeight = FontWeight.SemiBold)) },
                    Fact("Size") { Text(sizeWords(upload.size), style = ConsoleType.small) },
                    Fact("SHA-256") { Mono(upload.digest, style = ConsoleType.mono.copy(fontSize = 12.sp)) },
                    Fact("Layout") { Text("${Words.exactBytes(header.headerSize.toLong())} of header, ${Words.exactBytes(header.payloadSize)} of firmware", style = ConsoleType.small) },
                    if (upload.recordedAs != upload.name) Fact("Recorded as") { Mono(upload.recordedAs) } else null,
                ),
            )
        }
        for (note in checks) {
            val (tone, glyph) = when (note.tone) {
                UploadReview.NoteTone.GOOD -> Tone.GOOD to Glyph.CHECK_CIRCLE
                UploadReview.NoteTone.WARN -> Tone.WARN to Glyph.ALERT
                UploadReview.NoteTone.BAD -> Tone.BAD to Glyph.X_CIRCLE
                UploadReview.NoteTone.WAIT -> Tone.WAIT to Glyph.CLOCK
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                GlyphIcon(glyph, Modifier.padding(top = 2.dp), tint = console.toneInk(tone))
                Text(prose(note.text), style = ConsoleType.small, color = console.ink)
            }
        }
        if (refused && upload.error != null) {
            val check = ImageChecks.failedCheck((upload.error as? ApiError)?.code)
            Failure(
                if (ofImage) "The server refused this image." else "The image was not stored.",
                upload.error,
                extra = if (ofImage) ((if (check != null) "Check that failed: $check. " else "") + "Nothing was stored.") else null,
            )
        }
        when {
            upload.step == UploadStep.SENDING -> {
                val percent = (upload.sent * 100).toInt()
                Text("Uploading… $percent%", style = ConsoleType.small, color = console.ink)
                Meter(percent, "Upload")
            }
            upload.step == UploadStep.CHECKING -> {
                Text("Uploaded. The server is verifying the signature…", style = ConsoleType.small, color = console.ink)
                androidx.compose.material3.LinearProgressIndicator(Modifier.fillMaxWidth(), color = console.barLive, trackColor = console.workWash)
            }
            final || doomed -> ConsoleButton("Choose another file", { vm.resetUpload(); pick() }, kind = ButtonKind.PRIMARY, glyph = Glyph.FILE)
            !review.blocked -> {
                ConsoleField(
                    upload.notes, vm::setUploadNotes, "Notes (optional)", singleLine = false, minLines = 2,
                    hint = "What changed in this build. Shown next to the release.", maxLength = 500,
                )
                ConsoleButton(
                    if (refused) "Try again" else "Upload for verification", vm::startUpload,
                    kind = ButtonKind.PRIMARY, glyph = Glyph.UPLOAD,
                )
                Note("Uploading is a change: it asks for your password and code again if you signed in more than 15 minutes ago.")
            }
        }
    }
}

/** What the server answered to an upload that it accepted: every value is from its reply. */
@Composable
private fun VerifiedResult(vm: ConsoleViewModel, upload: UploadState, store: Store) {
    val release = upload.release ?: return
    val colors = console
    val fingerprint = store.firmware.value?.fingerprint.orEmpty()
    val deployed = deployedAlready(upload, store)
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        StatusLine(Tone.GOOD, Glyph.SHIELD, "Verified by the server")
        Wrap {
            GlyphIcon(Glyph.CHECK_CIRCLE, size = 24.dp, tint = colors.good)
            Text("Registered as", style = ConsoleType.sectionTitle, color = colors.ink)
            Mono(release.version, style = ConsoleType.mono.copy(fontSize = 18.sp, fontWeight = FontWeight.Bold))
        }
        Text(
            if (deployed != null) "The signature is valid and the image is stored. A deployment of it has been started."
            else "The signature is valid and the image is stored. It can now be offered to boards.",
            style = ConsoleType.small, color = colors.ink2,
        )
        Wrap {
            if (deployed != null) {
                ConsoleButton("Open its deployment", { vm.open(Route.DeploymentPage(deployed)) }, kind = ButtonKind.PRIMARY, glyph = Glyph.ARROW_RIGHT)
                ConsoleButton("Deploy it again", { vm.openDeploy(release.version) }, glyph = Glyph.SEND)
            } else {
                ConsoleButton("Deploy this release", { vm.openDeploy(release.version) }, kind = ButtonKind.PRIMARY, glyph = Glyph.SEND)
            }
            ConsoleButton("Upload another", vm::resetUpload)
        }
        Facts(
            listOfNotNull(
                Fact("Signature") { StatusLine(Tone.GOOD, Glyph.CHECK_CIRCLE, "ECDSA P-256, valid") },
                if (release.keyHash.isNotEmpty()) Fact("Signing key") {
                    Mono(release.keyHash, style = ConsoleType.mono.copy(fontSize = 12.sp))
                    Note(if (release.keyHash == fingerprint) "The fingerprint of this project’s signing key." else "The fingerprint of the key that signed it.")
                } else null,
                Fact("Version") {
                    Mono(release.version, style = ConsoleType.mono.copy(fontWeight = FontWeight.SemiBold))
                    Note("Read from the signed header of the image.")
                },
                Fact("Size") {
                    Text(sizeWords(release.size), style = ConsoleType.small)
                    if (release.headerSize != null && release.payloadSize != null) {
                        Note("${Words.exactBytes(release.headerSize)} of header, ${Words.exactBytes(release.payloadSize)} of firmware, then the signature.")
                    }
                },
                if (release.sha256.isNotEmpty()) Fact("SHA-256") { Mono(release.sha256, style = ConsoleType.mono.copy(fontSize = 12.sp)) } else null,
                release.loadAddress?.let { address -> Fact("Load address") { Mono("0x${address.toString(16)}") } },
            ),
        )
    }
}

/** The proof next to the verdict: what the server checked. */
@Composable
private fun VerifiedProof(store: Store, upload: UploadState) {
    val version = upload.release?.version
    val releases = store.releases.orEmpty()
    val first = releases.isNotEmpty() && releases.all { it.version == version }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        StatusLine(Tone.IDLE, Glyph.SHIELD, "What the server checked")
        for (check in ImageChecks.ALL) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                GlyphIcon(Glyph.CHECK_CIRCLE, Modifier.padding(top = 2.dp), tint = console.good)
                Text(if (first && check.passedFirst != null) check.passedFirst else check.passed, style = ConsoleType.small, color = console.ink)
            }
        }
        Note("The board’s bootloader checks the same signature again before it starts the image.")
    }
}

/** How the image is trusted: signed at build, checked on upload, checked at boot. */
@Composable
private fun TrustPanel(vm: ConsoleViewModel, store: Store) {
    val fingerprint = store.firmware.value?.fingerprint.orEmpty()
    val earlier = store.releases.orEmpty().count { fingerprint.isNotEmpty() && it.keyHash.isNotEmpty() && it.keyHash != fingerprint }
    val colors = console
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        StatusLine(Tone.IDLE, Glyph.SHIELD, "The server verifies every upload")
        for ((glyph, title, text) in listOf(
            Triple(Glyph.KEY, "Signed at build", "With the project’s private key"),
            Triple(Glyph.SHIELD, "Checked on upload", "By this server, with the public key"),
            Triple(Glyph.CHIP, "Checked at boot", "By the board’s bootloader"),
        )) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(Modifier.size(32.dp).clip(CircleShape).background(colors.well), contentAlignment = Alignment.Center) { GlyphIcon(glyph, size = 16.dp) }
                Column {
                    Text(title, style = ConsoleType.small.copy(fontWeight = FontWeight.SemiBold), color = colors.ink)
                    Text(text, style = ConsoleType.note, color = colors.ink2)
                }
            }
        }
        Text(
            "An image is stored only if its ECDSA P-256 signature checks out against this project’s signing key. The board’s " +
                "bootloader checks the same signature again before it starts the image.",
            style = ConsoleType.small, color = colors.ink2,
        )
        Text(
            "The console holds only the public half of that key. It can check a signature; it can never make one, and neither " +
                "can anyone who signs in here.",
            style = ConsoleType.small, color = colors.ink2,
        )
        if (fingerprint.isNotEmpty()) {
            Eyebrow("Signing key fingerprint · SHA-256")
            Row(verticalAlignment = Alignment.CenterVertically) {
                Mono(fingerprint, Modifier.weight(1f), style = ConsoleType.mono.copy(fontSize = 12.sp))
                CopyButton(fingerprint, "the key fingerprint", onCopied = { vm.notify(it) })
            }
            if (earlier > 0) {
                Note(
                    "${Words.plural(earlier, "older release was", "older releases were")} signed with an earlier key, which has been " +
                        "replaced since, so ${if (earlier == 1) "it shows" else "they show"} another fingerprint.",
                )
            }
        }
    }
}

/** The releases in the order they were uploaded, with the time between them. */
@Composable
private fun ReleaseTimeline(store: Store, now: Long) {
    val colors = console
    val releases = store.releases.orEmpty()
    val newest = releases.firstOrNull { it.isActive }
    val shown = releases.take(6).reversed()
    val revoked = releases.count { !it.isActive }
    val devices = store.deviceList
    val counted = devices.orEmpty().filter { it.fw != null }.groupBy { it.fw!!.version }
    Note(
        listOfNotNull(
            Words.plural(releases.size, "release"),
            if (revoked > 0) "$revoked revoked" else null,
            if (releases.size > shown.size) "the newest ${shown.size} shown" else null,
        ).joinToString(" · "),
        Modifier.padding(bottom = 10.dp),
    )
    Column {
        shown.forEachIndexed { index, release ->
            val next = shown.getOrNull(index + 1)
            val state = when {
                release == newest -> "Newest release"
                !release.isActive -> "Revoked"
                else -> "Active"
            }
            val boards = counted[release.version].orEmpty()
            val gapTo = next?.let { Times.parse(it.uploadedAt) } ?: now
            val gap = Times.parse(release.uploadedAt)?.let { Words.duration((gapTo - it) / 1000.0) }.orEmpty()
            Row(Modifier.fillMaxWidth().semantics(mergeDescendants = true) {}, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Box(
                        Modifier
                            .size(16.dp)
                            .clip(CircleShape)
                            .background(if (release == newest) colors.accent else if (release.isActive) colors.ink else colors.well)
                            .border(1.5.dp, if (release.isActive) colors.ink else colors.lineMark, CircleShape),
                        contentAlignment = Alignment.Center,
                    ) { if (!release.isActive) GlyphIcon(Glyph.X, size = 10.dp, tint = colors.bad) }
                    Box(Modifier.size(width = 2.dp, height = 44.dp).background(colors.line))
                }
                Column(Modifier.weight(1f).padding(bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Wrap {
                        Mono(release.version, style = ConsoleType.mono.copy(fontWeight = FontWeight.SemiBold))
                        Text(state, style = ConsoleType.note, color = if (release == newest) colors.accent else if (release.isActive) colors.ink2 else colors.bad)
                    }
                    Note(
                        listOfNotNull(
                            Words.timeAgo(release.uploadedAt, now),
                            if (devices != null && boards.isNotEmpty()) "${Words.plural(boards.size, "board")} on it${if (boards.any { !it.online }) " when last seen" else ""}" else null,
                            if (gap.isNotEmpty()) (if (next != null) "next upload after $gap" else "that was $gap ago") else null,
                        ).joinToString(" · "),
                    )
                }
            }
        }
    }
}

/** A release, with what a release manager can do with it, and its details. */
@Composable
private fun ReleaseRow(vm: ConsoleViewModel, release: Release, store: Store, now: Long) {
    val colors = console
    val canWrite = store.me?.canWrite == true
    val revocation = Updates.revocationState(release)
    val slot = store.firmware.value?.slotSize
    var open by rememberSaveable(release.version) { mutableStateOf(false) }
    Column(
        Modifier
            .fillMaxWidth()
            .drawBehind { drawLine(colors.line, Offset(0f, 0f), Offset(size.width, 0f), 1.dp.toPx()) }
            .padding(vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Wrap {
            Mono(release.version, style = ConsoleType.mono.copy(fontSize = 18.sp, fontWeight = FontWeight.Bold))
            ReleaseBadges(release)
        }
        if (release.notes.isNotEmpty()) Text(release.notes, style = ConsoleType.small, color = colors.ink)
        release.revoked?.let { mark ->
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                GlyphIcon(Glyph.BAN, Modifier.padding(top = 2.dp), size = 14.dp, tint = colors.bad)
                Text(
                    "Revoked ${Words.timeAgo(mark.at, now)} by ${Words.nameOf(mark.by)}: ${mark.reason}",
                    style = ConsoleType.note, color = colors.ink2,
                )
            }
        }
        if (revocation == Updates.RevocationState.INCOMPLETE) {
            Notice(
                Tone.WARN, Glyph.ALERT,
                "The server has not recorded that the image is refused and that every open deployment of this release is " +
                    "cancelled. Until it has, a board may still be able to download or install it. " +
                    if (canWrite) "Finish revoking to make sure." else "A release manager can finish revoking.",
            )
        }
        if (slot != null && slot > 0) {
            val percent = release.size * 100.0 / slot
            val told = if (percent < 1) "under 1%" else "${Math.round(percent)}%"
            Box(Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(3.dp)).background(colors.well).clearAndSetSemantics {}) {
                Box(Modifier.fillMaxHeight().fillMaxWidth((percent / 100).toFloat().coerceIn(0f, 1f)).background(colors.lineMark))
            }
            Note("Takes $told of the ${Words.fileSize(slot)} update slot")
        }
        Note("${Words.fileSize(release.size)} · Uploaded ${Words.timeAgo(release.uploadedAt, now)} by ${Words.nameOf(release.uploadedBy)}")
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("SHA-256 ", style = ConsoleType.note, color = colors.ink2)
            Mono("${release.sha256.take(16)}…", style = ConsoleType.mono.copy(fontSize = 12.sp), color = colors.ink2)
            CopyButton(release.sha256, "the SHA-256 of ${release.version}", onCopied = { vm.notify(it) })
        }
        if (canWrite) {
            Wrap {
                when {
                    release.isActive -> {
                        ConsoleButton("Deploy", { vm.openDeploy(release.version) }, small = true, glyph = Glyph.SEND)
                        ConsoleButton("Send over Bluetooth", { vm.open(Route.Bluetooth(release.version)) }, small = true, glyph = Glyph.BLUETOOTH)
                        ConsoleButton("Revoke", { vm.openRevoke(release.version) }, small = true, kind = ButtonKind.DANGER_QUIET, glyph = Glyph.BAN)
                    }
                    revocation == Updates.RevocationState.INCOMPLETE ->
                        ConsoleButton("Finish revoking", { vm.openRevoke(release.version) }, small = true, kind = ButtonKind.PRIMARY, glyph = Glyph.BAN)
                    revocation == Updates.RevocationState.UNKNOWN ->
                        ConsoleButton("Apply the revocation again", { vm.openRevoke(release.version) }, small = true)
                    else -> Unit
                }
            }
        }
        MoreLink(if (open) "Hide details" else "Details") { open = !open }
        if (open) ReleaseDetails(release, store.firmware.value?.fingerprint.orEmpty())
    }
}

@Composable
private fun ReleaseDetails(release: Release, fingerprint: String) {
    val signedWords = when {
        fingerprint.isNotEmpty() && release.keyHash.isNotEmpty() && release.keyHash != fingerprint ->
            "Not the current signing key. This release was signed with an earlier key, which has been replaced since."
        release.keyHash == fingerprint -> "Matches this project’s signing key."
        else -> "Fingerprint of the key that signed it."
    }
    val small = ConsoleType.mono.copy(fontSize = 12.sp)
    Facts(
        listOfNotNull(
            Fact("File") { Mono(release.filename) },
            Fact("Size") {
                Text(
                    "${Words.exactBytes(release.size)}: ${Words.exactBytes(release.headerSize)} of header, " +
                        "${Words.exactBytes(release.payloadSize)} of firmware, then the signature",
                    style = ConsoleType.small,
                )
            },
            Fact("File SHA-256") { Mono(release.sha256, style = small); Note("What a board checks after downloading.") },
            Fact("Image hash") { Mono(release.imageHash, style = small); Note("What the signature covers and the bootloader verifies.") },
            Fact("Signed with") { Mono(release.keyHash, style = small); Note(signedWords) },
            Fact("Load address") { Mono("0x${(release.loadAddress ?: 0).toString(16)}") },
            Fact("Uploaded") {
                Text(Words.exactTime(release.uploadedAt), style = ConsoleType.small)
                Note("by ${Words.nameOf(release.uploadedBy)}${release.uploadedBy?.sub?.takeIf { it.isNotEmpty() }?.let { " · account $it" } ?: ""}")
            },
            release.revoked?.let { mark ->
                Fact("Revoked") {
                    Text(Words.exactTime(mark.at), style = ConsoleType.small)
                    Note("by ${Words.nameOf(mark.by)}${mark.by?.sub?.takeIf { it.isNotEmpty() }?.let { " · account $it" } ?: ""}")
                }
            },
            release.revoked?.enforcedAt?.let { at ->
                Fact("Enforced") {
                    Text(Words.exactTime(at), style = ConsoleType.small)
                    Note("The image is refused and every open deployment of it was cancelled.")
                }
            },
        ),
        labelWidth = 104.dp,
    )
}
