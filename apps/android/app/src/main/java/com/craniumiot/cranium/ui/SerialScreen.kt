package com.craniumiot.cranium.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateMap
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.craniumiot.cranium.core.Glyph
import com.craniumiot.cranium.core.Me
import com.craniumiot.cranium.core.SerialRules
import com.craniumiot.cranium.core.SerialSession
import com.craniumiot.cranium.core.Tone
import com.craniumiot.cranium.core.Words
import com.craniumiot.cranium.usb.UsbConsole
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * The serial console over the USB cable (the website's serial.js serialView): the connection and
 * the transcript on the ink panel, a free command line, and a form for each command by group.
 * Nothing here talks to the API. A Wi-Fi password lives only in the field it is typed in, held
 * with `remember` and never in saved state, and is cleared as soon as it is sent; the transcript
 * holds the masked command only.
 */
@Composable
fun SerialScreen(vm: ConsoleViewModel, me: Me?) {
    if (me?.canWrite != true) {
        Explained(
            Glyph.LOCK,
            "The serial console is for release managers.",
            "It drives a board directly and can erase it, so a viewer does not get its controls. " +
                "Ask a release manager to do what you need, or to add you to their group.",
        )
        return
    }
    val usbState by vm.usb.usb.collectAsStateWithLifecycle()
    val state by vm.usb.session.state.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { vm.usb.look() }
    if (!usbState.usbHost) {
        Explained(
            Glyph.USB,
            "This phone cannot be a USB host.",
            "The serial console needs a phone that supports USB OTG, so that the board's J-Link can be plugged into it. " +
                "On a computer, a plain serial monitor at 115200 baud works:",
            command = "screen /dev/cu.usbmodem<port> 115200",
        )
        return
    }

    val scope = rememberCoroutineScope()
    val session = vm.usb.session
    val ready = state.phase == SerialSession.Phase.READY

    Column(Modifier.fillMaxWidth()) {
        PageHead(
            "Serial console",
            lede = "Drive a board on its USB cable from this phone. What you type here goes only over the cable to the " +
                "board, never to the server, and nothing is saved.",
        )
        InkPanel {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                ConnectionState(state, usbState)
                ConnectionTools(vm.usb, state, usbState, scope)
                state.problem?.let { problem ->
                    val warn = state.phase == SerialSession.Phase.SILENT ||
                        problem.startsWith("No board found") || problem.startsWith("The app was not allowed")
                    Notice(if (warn) Tone.WARN else Tone.BAD, Glyph.ALERT, problem)
                }
                if (state.phase == SerialSession.Phase.IDLE) ProbeHint(usbState)
                Transcript(state, onClear = session::clear)
                TypedInput(session, state, ready, scope)
            }
        }
        Spacer(Modifier.height(28.dp))
        CommandForms(session, state, ready, scope)
    }
}

/** A page that says why the console is not offered here. */
@Composable
private fun Explained(glyph: Glyph, title: String, text: String, command: String? = null) {
    Column(Modifier.fillMaxWidth()) {
        PageHead("Serial console", lede = "Drive a board on its USB cable from this phone.")
        Section { EmptyState(glyph, title, text, command) }
    }
}

// The connection.

@Composable
private fun ConnectionState(state: SerialSession.State, usb: UsbConsole.UsbState) {
    val colors = console
    val (tone, glyph, words) = when (state.phase) {
        SerialSession.Phase.IDLE -> Triple(Tone.IDLE, Glyph.MINUS_CIRCLE, "Not connected")
        SerialSession.Phase.OPENING ->
            Triple(Tone.LIVE, Glyph.HOURGLASS, if (usb.askingPermission) "Asking for the USB port…" else "Choosing a port…")
        SerialSession.Phase.PROBING -> Triple(Tone.LIVE, Glyph.HOURGLASS, "Asking the board who it is…")
        SerialSession.Phase.SILENT -> Triple(Tone.WARN, Glyph.ALERT, "No answer on this port")
        SerialSession.Phase.READY -> Triple(Tone.GOOD, Glyph.CHECK_CIRCLE, "Connected")
        SerialSession.Phase.CLOSING -> Triple(Tone.IDLE, Glyph.HOURGLASS, "Disconnecting…")
    }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        StatusLine(
            tone, glyph, words,
            Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            quiet = state.phase == SerialSession.Phase.IDLE || state.phase == SerialSession.Phase.CLOSING,
        )
        val board = state.board
        if (state.phase == SerialSession.Phase.READY && board != null) {
            Text(
                buildAnnotatedString {
                    if (board.id.isNotEmpty()) {
                        withStyle(SpanStyle(fontFamily = ConsoleType.Mono)) { append(board.id) }
                    } else {
                        append("No ID yet")
                    }
                    if (board.version.isNotEmpty()) {
                        append(" · firmware ")
                        withStyle(SpanStyle(fontFamily = ConsoleType.Mono)) { append(board.version) }
                    }
                },
                style = ConsoleType.small,
                color = colors.ink2,
            )
        }
        val port = usb.port
        if (port != null && state.phase != SerialSession.Phase.IDLE) {
            Text("Port VCOM$port of ${usb.ports}", style = ConsoleType.note, color = colors.ink3)
        }
    }
}

@Composable
private fun ConnectionTools(usb: UsbConsole, state: SerialSession.State, usbState: UsbConsole.UsbState, scope: CoroutineScope) {
    val phase = state.phase
    val open = phase != SerialSession.Phase.IDLE && phase != SerialSession.Phase.OPENING
    Wrap {
        if (open) {
            if (phase == SerialSession.Phase.SILENT) {
                ConsoleButton("Ask again", { scope.launch { usb.session.probe() } }, small = true, glyph = Glyph.RESTART)
                if (usbState.ports >= 2) ConsoleButton("Try the other port", usb::tryOtherPort, small = true, glyph = Glyph.SWAP)
            }
            ConsoleButton("Disconnect", usb::disconnect, small = true, enabled = phase != SerialSession.Phase.CLOSING)
        } else {
            ConsoleButton(
                "Connect a board",
                { usb.connect() },
                kind = ButtonKind.PRIMARY,
                small = true,
                glyph = Glyph.USB,
                enabled = phase != SerialSession.Phase.OPENING,
                busy = phase == SerialSession.Phase.OPENING,
            )
        }
    }
}

/** What is plugged in, or how to plug it in. */
@Composable
private fun ProbeHint(usb: UsbConsole.UsbState) {
    val probe = usb.probes.firstOrNull()
    if (probe == null) {
        Note("Connect the DK's J-Link USB port to this phone with a USB OTG cable, and switch the DK on.")
    } else {
        Note(
            "Found ${probe.name}, with ${Words.plural(probe.ports, "virtual COM port")}. " +
                if (probe.ports >= 2) "The console is on the second, VCOM1." else "The console is on it.",
        )
    }
}

// The transcript.

@Composable
private fun Transcript(state: SerialSession.State, onClear: () -> Unit) {
    val colors = console
    val listState = rememberLazyListState()
    var pinned by remember { mutableStateOf(true) }
    var seenId by remember { mutableLongStateOf(0L) }
    val lastId = state.lines.lastOrNull()?.id ?: 0L
    val dropped = state.linesDropped > 0
    val itemCount = state.lines.size + if (dropped) 1 else 0
    // Only the person's own scrolling passes through here: following the newest line does not.
    val connection = remember(listState) {
        object : NestedScrollConnection {
            override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
                pinned = !listState.canScrollForward
                return Offset.Zero
            }
        }
    }
    LaunchedEffect(lastId, pinned, itemCount) {
        if (pinned) {
            if (itemCount > 0) listState.scrollToItem(itemCount - 1)
            seenId = lastId
        }
    }
    val unseen = state.lines.count { it.id > seenId }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Eyebrow("Transcript", Modifier.weight(1f))
            ConsoleButton(
                "Clear",
                {
                    onClear()
                    pinned = true
                },
                kind = ButtonKind.QUIET,
                small = true,
                enabled = state.lines.isNotEmpty(),
            )
        }
        Box(
            Modifier
                .fillMaxWidth()
                .height(360.dp)
                .clip(RoundedCornerShape(5.dp))
                .border(1.dp, colors.line, RoundedCornerShape(5.dp))
                .background(colors.paper)
                .semantics { contentDescription = "Transcript of what was sent and what the board said" },
        ) {
            if (state.lines.isEmpty()) {
                Text(
                    "What is sent and what the board says will appear here.",
                    Modifier.padding(12.dp),
                    style = ConsoleType.note,
                    color = colors.ink3,
                )
            } else {
                LazyColumn(
                    Modifier.fillMaxSize().nestedScroll(connection),
                    state = listState,
                    contentPadding = PaddingValues(horizontal = 10.dp, vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(3.dp),
                ) {
                    if (dropped) {
                        item(key = "dropped") {
                            Text(
                                "${state.linesDropped} earlier lines are no longer kept.",
                                style = ConsoleType.note,
                                color = colors.ink3,
                            )
                        }
                    }
                    items(state.lines, key = { it.id }) { line -> TranscriptLine(line) }
                }
            }
        }
        if (!pinned && unseen > 0) {
            ConsoleButton("$unseen new, go to the latest", { pinned = true }, small = true, glyph = Glyph.DOWNLOAD)
        }
        if (state.said.isNotEmpty()) {
            // Only the final line of a reply is read out. A repeated sentence differs by a space.
            Text(
                "Last reply: ${state.said}${if (state.saidCount % 2 == 0) " " else ""}",
                Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                style = ConsoleType.note,
                color = colors.ink2,
            )
        }
    }
}

private val TRANSCRIPT = ConsoleType.mono.copy(fontSize = 12.5.sp, lineHeight = 17.sp)

@Composable
private fun TranscriptLine(line: SerialSession.Line) {
    val colors = console
    // A time on every row of a table would take the width its columns need.
    val table = line.kind == SerialSession.Kind.OUTPUT && SerialRules.COLUMNS.containsMatchIn(line.text)
    Row(
        Modifier.fillMaxWidth().semantics(mergeDescendants = true) {},
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.Top) {
            when (line.kind) {
                SerialSession.Kind.SENT -> {
                    Text(">", Modifier.clearAndSetSemantics { contentDescription = "Sent:" }, style = TRANSCRIPT, color = colors.accent)
                    Column {
                        Text(line.text, style = TRANSCRIPT, color = colors.ink)
                        if (line.auto) Text("sent by the page", style = ConsoleType.note.copy(fontSize = 11.5.sp), color = colors.ink3)
                    }
                }
                SerialSession.Kind.OK, SerialSession.Kind.ERR -> {
                    val ok = line.kind == SerialSession.Kind.OK
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                        GlyphIcon(if (ok) Glyph.CHECK_CIRCLE else Glyph.X_CIRCLE, size = 14.dp, tint = if (ok) colors.good else colors.bad)
                        Text(if (ok) "OK" else "ERR", style = TRANSCRIPT.copy(fontWeight = FontWeight.Bold), color = if (ok) colors.good else colors.bad)
                    }
                    Text(line.text, style = TRANSCRIPT, color = colors.ink)
                }
                SerialSession.Kind.TAG -> {
                    Text("[${line.tag}]", style = TRANSCRIPT, color = colors.ink3)
                    val level = line.level
                    if (level != null) {
                        val bad = level == "ERR"
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                            GlyphIcon(if (bad) Glyph.X_CIRCLE else Glyph.ALERT, size = 14.dp, tint = if (bad) colors.bad else colors.warn)
                            Text(level, style = TRANSCRIPT.copy(fontWeight = FontWeight.Bold), color = if (bad) colors.bad else colors.warn)
                        }
                    }
                    Text(line.text, style = TRANSCRIPT, color = colors.ink2)
                }
                SerialSession.Kind.OUTPUT -> {
                    if (table) {
                        // These keep their columns: no wrapping, and they scroll sideways.
                        Text(line.text, Modifier.horizontalScroll(rememberScrollState()), style = TRANSCRIPT, color = colors.ink, softWrap = false)
                    } else {
                        Text(line.text, style = TRANSCRIPT, color = colors.ink)
                    }
                }
                SerialSession.Kind.NOTE -> {
                    val (glyph, tint) = when (line.tone) {
                        SerialSession.NoteTone.IDLE -> Glyph.MINUS to colors.ink3
                        SerialSession.NoteTone.WARN -> Glyph.ALERT to colors.warn
                        SerialSession.NoteTone.BAD -> Glyph.X_CIRCLE to colors.bad
                    }
                    GlyphIcon(glyph, size = 14.dp, tint = tint)
                    Text(line.text, style = ConsoleType.note, color = colors.ink2)
                }
            }
        }
        if (!table) Text(line.at, style = ConsoleType.note.copy(fontSize = 11.sp), color = colors.ink3)
    }
}

// The free command line.

@Composable
private fun TypedInput(session: SerialSession, state: SerialSession.State, ready: Boolean, scope: CoroutineScope) {
    val colors = console
    // Plain remember: a line can hold a Wi-Fi password, which never goes into saved state.
    var typed by remember { mutableStateOf("") }
    var problem by remember { mutableStateOf<String?>(null) }
    val hidden = SerialRules.holdsSecret(typed)
    fun submit() {
        when (val result = SerialRules.checkTyped(typed)) {
            SerialRules.Typed.Empty -> {
                problem = null
            }
            is SerialRules.Typed.Refused -> {
                problem = result.why
            }
            is SerialRules.Typed.Send -> {
                // Out of the field before anything else can happen to it.
                typed = ""
                problem = null
                if (result.keep) session.remember(result.line.trimEnd())
                scope.launch {
                    val sent = session.send(result.line)
                    if (!sent.sent) problem = sent.problem
                }
            }
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        ConsoleField(
            value = typed,
            onValueChange = {
                typed = it
                problem = null
            },
            label = "Command",
            mono = true,
            secret = hidden,
            enabled = ready,
            placeholder = "COMMAND|arg1|arg2",
            hint = if (hidden) {
                "This line holds a password, so it stays hidden and will not be kept."
            } else {
                "Earlier commands: tap one below to bring it back. Wi-Fi commands are never kept."
            },
        )
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            ConsoleButton("Send", { submit() }, kind = ButtonKind.PRIMARY, glyph = Glyph.SEND, small = true, enabled = ready)
        }
        problem?.let { ErrorLine(it) }
        val recalled = state.typed.asReversed().take(10)
        if (recalled.isNotEmpty()) {
            Wrap {
                for (command in recalled) {
                    Text(
                        command,
                        Modifier
                            .clip(RoundedCornerShape(4.dp))
                            .border(1.dp, colors.lineStrong, RoundedCornerShape(4.dp))
                            .clickable(enabled = ready, role = Role.Button, onClickLabel = "Bring back $command") {
                                typed = command
                                problem = null
                            }
                            .heightIn(min = 36.dp)
                            .padding(horizontal = 10.dp, vertical = 8.dp),
                        style = ConsoleType.mono.copy(fontSize = 13.sp),
                        color = if (ready) colors.ink else colors.ink3,
                        maxLines = 1,
                    )
                }
            }
        }
    }
}

@Composable
private fun ErrorLine(text: String) {
    val colors = console
    Row(
        Modifier.semantics { liveRegion = LiveRegionMode.Assertive },
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        GlyphIcon(Glyph.ALERT, Modifier.padding(top = 2.dp), size = 14.dp, tint = colors.bad)
        Text(text, style = ConsoleType.note, color = colors.bad)
    }
}

// The forms.

private fun fieldKey(command: SerialRules.Command, field: String) = "${command.name}.$field"

/** The forms' own state while the page is shown: values (a password among them, until it is sent), errors and problems. */
private class FormState {
    val values: SnapshotStateMap<String, String> = mutableStateMapOf()
    val errors: SnapshotStateMap<String, Map<String, String>> = mutableStateMapOf()
    val problems: SnapshotStateMap<String, String> = mutableStateMapOf()

    fun value(command: SerialRules.Command, field: SerialRules.Field): String =
        values[fieldKey(command, field.key)] ?: field.choices?.firstOrNull() ?: ""
}

/** Send a line from a form, and keep its problem if it is not sent. */
private fun sendFrom(form: FormState, session: SerialSession, scope: CoroutineScope, name: String, line: String) {
    form.problems.remove(name)
    scope.launch {
        val sent = session.send(line, form = name)
        if (!sent.sent) form.problems[name] = sent.problem ?: "Not sent."
    }
}

/** Check a form's fields against the firmware's rules, and send: out of the field first if it is a password. */
private fun submitForm(command: SerialRules.Command, form: FormState, session: SerialSession, scope: CoroutineScope) {
    val values = command.fields.associate { it.key to form.value(command, it) }.toMutableMap()
    if (command.confirm != null) values["confirm"] = form.values[fieldKey(command, "confirm")] ?: ""
    val checked = SerialRules.checkCommand(command, values)
    form.problems.remove(command.name)
    if (checked.errors.isNotEmpty()) {
        form.errors[command.name] = checked.errors
        return
    }
    form.errors.remove(command.name)
    for (field in command.fields) if (field.secret) form.values.remove(fieldKey(command, field.key))
    if (command.confirm != null) form.values.remove(fieldKey(command, "confirm"))
    sendFrom(form, session, scope, command.name, checked.line)
}

@Composable
private fun CommandForms(session: SerialSession, state: SerialSession.State, ready: Boolean, scope: CoroutineScope) {
    val colors = console
    val form = remember { FormState() }
    Column(Modifier.fillMaxWidth()) {
        if (!ready) {
            Row(
                Modifier.padding(bottom = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                GlyphIcon(Glyph.LOCK, size = 14.dp, tint = colors.ink2)
                Text("Connect a board to use these.", style = ConsoleType.small, color = colors.ink2)
            }
        }
        for ((group, title) in SerialRules.GROUPS) {
            Section(title = title) {
                if (group == "mqtt") {
                    MqttPanel(session, state, ready, scope, form)
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(20.dp)) {
                        for (command in SerialRules.COMMANDS.filter { it.group == group }) {
                            CommandRow(command, session, state, ready, scope, form)
                        }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChoiceField(
    command: SerialRules.Command,
    field: SerialRules.Field,
    form: FormState,
    ready: Boolean,
) {
    val colors = console
    val chosen = form.value(command, field)
    val error = form.errors[command.name]?.get(field.key)
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(field.label, style = ConsoleType.note, color = colors.ink2)
        Wrap {
            for (choice in field.choices.orEmpty()) {
                FilterChip(
                    selected = choice == chosen,
                    onClick = { form.values[fieldKey(command, field.key)] = choice },
                    label = { Text(if (choice.isEmpty()) "All of them" else choice, style = ConsoleType.mono.copy(fontSize = 13.sp)) },
                    enabled = ready,
                    colors = FilterChipDefaults.filterChipColors(
                        selectedContainerColor = colors.accentWash,
                        selectedLabelColor = colors.ink,
                        labelColor = colors.ink2,
                    ),
                )
            }
        }
        if (error != null) ErrorLine(error)
    }
}

@Composable
private fun CommandRow(
    command: SerialRules.Command,
    session: SerialSession,
    state: SerialSession.State,
    ready: Boolean,
    scope: CoroutineScope,
    form: FormState,
) {
    val colors = console
    val plain = command.fields.isEmpty() && command.confirm == null
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (plain) {
            ConsoleButton(command.name, { sendFrom(form, session, scope, command.name, command.name) }, small = true, enabled = ready)
            Note(command.text)
        } else {
            Text(
                command.name,
                Modifier.semantics { heading() },
                style = ConsoleType.mono.copy(fontWeight = FontWeight.SemiBold),
                color = colors.ink,
            )
            Note(command.text)
            val errors = form.errors[command.name].orEmpty()
            for (field in command.fields) {
                if (field.choices != null) {
                    ChoiceField(command, field, form, ready)
                } else {
                    ConsoleField(
                        value = form.values[fieldKey(command, field.key)] ?: "",
                        onValueChange = { form.values[fieldKey(command, field.key)] = it },
                        label = field.label,
                        hint = field.hint,
                        error = errors[field.key],
                        mono = !field.secret,
                        secret = field.secret,
                        enabled = ready,
                    )
                }
            }
            val confirm = command.confirm
            if (confirm != null) {
                ConsoleField(
                    value = form.values[fieldKey(command, "confirm")] ?: "",
                    onValueChange = { form.values[fieldKey(command, "confirm")] = it },
                    label = "Type $confirm to confirm",
                    error = errors["confirm"],
                    mono = true,
                    enabled = ready,
                )
            }
            ConsoleButton(
                command.name,
                { submitForm(command, form, session, scope) },
                kind = if (confirm != null) ButtonKind.DANGER else ButtonKind.PLAIN,
                small = true,
                enabled = ready,
            )
        }
        if (command.factory) Tag("Also in factory mode")
        ReplyLine(command.name, state, form)
    }
}

/** The reply to a form's command: its final line, or that it is waiting, or that none came. */
@Composable
private fun ReplyLine(name: String, state: SerialSession.State, form: FormState) {
    val colors = console
    val problem = form.problems[name]
    if (problem != null) {
        ErrorLine(problem)
        return
    }
    val reply = state.reply ?: return
    if (reply.form != name) return
    val (glyph, word, tint) = when (reply.kind) {
        SerialSession.ReplyKind.OK -> Triple(Glyph.CHECK_CIRCLE, "OK", colors.good)
        SerialSession.ReplyKind.ERR -> Triple(Glyph.X_CIRCLE, "ERR", colors.bad)
        SerialSession.ReplyKind.WAIT -> Triple(Glyph.HOURGLASS, "", colors.ink2)
        SerialSession.ReplyKind.NONE -> Triple(Glyph.ALERT, "", colors.warn)
    }
    Row(
        Modifier.semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        GlyphIcon(glyph, Modifier.padding(top = 2.dp), size = 14.dp, tint = tint)
        Text(
            buildAnnotatedString {
                if (word.isNotEmpty()) {
                    withStyle(SpanStyle(fontWeight = FontWeight.Bold, color = tint)) { append(word) }
                    append(" ")
                }
                append(reply.text)
            },
            style = ConsoleType.mono.copy(fontSize = 13.sp),
            color = colors.ink,
        )
    }
}

// The MQTT panel: what MQTT says, a new server, and a new connection.

@Composable
private fun MqttReply(name: String, state: SerialSession.State, form: FormState) {
    ReplyLine(name, state, form)
    val reply = state.reply
    if (reply != null && reply.form == name && reply.kind == SerialSession.ReplyKind.ERR && reply.text.startsWith("unknown command")) {
        Note(SerialRules.OLD_FIRMWARE)
    }
}

@Composable
private fun MqttPanel(session: SerialSession, state: SerialSession.State, ready: Boolean, scope: CoroutineScope, form: FormState) {
    val colors = console
    val check = SerialRules.command("MQTT")!!
    val host = SerialRules.command("MQTT_HOST")!!
    val reconnect = SerialRules.command("MQTT_RECONNECT")!!
    // The server that "Set server" waits to have confirmed. Not a secret.
    var confirming by remember { mutableStateOf<String?>(null) }
    val hostKey = fieldKey(host, "host")
    val current = state.mqtt?.facts?.firstOrNull { it.key == "endpoint" }?.values?.firstOrNull()

    Column(verticalArrangement = Arrangement.spacedBy(20.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            ConsoleButton("Check MQTT", { sendFrom(form, session, scope, check.name, check.name) }, small = true, glyph = Glyph.PULSE, enabled = ready)
            Note(check.text)
            MqttReply(check.name, state, form)
            val mqtt = state.mqtt
            if (mqtt != null) {
                val rows = mqtt.facts.map { fact ->
                    Fact(fact.label) {
                        for (value in fact.values) {
                            Text(
                                value,
                                style = when {
                                    fact.key in SerialRules.MONO_FACTS -> ConsoleType.mono.copy(fontSize = 13.sp)
                                    fact.key == "state" -> ConsoleType.body.copy(fontWeight = FontWeight.SemiBold)
                                    else -> ConsoleType.small
                                },
                                color = colors.ink,
                            )
                        }
                    }
                }
                Facts(rows)
                Note(
                    if (mqtt.stale) {
                        "As of ${mqtt.at}, before the last change: check again to see how it stands now."
                    } else {
                        "As of ${mqtt.at}."
                    },
                )
            }
        }

        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Set server", Modifier.semantics { heading() }, style = ConsoleType.body.copy(fontWeight = FontWeight.SemiBold), color = colors.ink)
            Note("${host.text} Sends MQTT_HOST|<endpoint>.")
            val error = form.errors[host.name]?.get("host")
            ConsoleField(
                value = form.values[hostKey] ?: "",
                onValueChange = {
                    form.values[hostKey] = it
                    // What is being confirmed is what was in the field: a change takes the question back.
                    confirming = null
                },
                label = SerialRules.HOST_FIELD.label,
                hint = SerialRules.HOST_FIELD.hint + (current?.let { " Now: $it." } ?: ""),
                error = error,
                mono = true,
                enabled = ready,
                placeholder = current ?: "xxxxxxxxxxxxxx-ats.iot.us-east-1.amazonaws.com",
            )
            val asking = confirming
            if (asking == null) {
                ConsoleButton(
                    "Set server",
                    {
                        val value = form.values[hostKey] ?: ""
                        val checked = SerialRules.checkCommand(host, mapOf("host" to value))
                        form.problems.remove(host.name)
                        if (checked.errors.isNotEmpty()) {
                            form.errors[host.name] = checked.errors
                            confirming = null
                        } else {
                            form.errors.remove(host.name)
                            confirming = value
                        }
                    },
                    small = true,
                    enabled = ready,
                )
            } else {
                Column(
                    Modifier.semantics(mergeDescendants = false) { liveRegion = LiveRegionMode.Polite },
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        buildAnnotatedString {
                            append("Set the server to ")
                            withStyle(SpanStyle(fontFamily = ConsoleType.Mono)) { append(asking) }
                            append("? The board drops its MQTT connection and connects to this one.")
                        },
                        style = ConsoleType.small,
                        color = colors.ink,
                    )
                    Wrap {
                        ConsoleButton(
                            "Yes, set the server",
                            {
                                val checked = SerialRules.checkCommand(host, mapOf("host" to asking))
                                confirming = null
                                if (checked.errors.isNotEmpty()) {
                                    form.errors[host.name] = checked.errors
                                } else {
                                    sendFrom(form, session, scope, host.name, checked.line)
                                }
                            },
                            kind = ButtonKind.PRIMARY,
                            small = true,
                            enabled = ready,
                        )
                        ConsoleButton("Cancel", { confirming = null }, kind = ButtonKind.QUIET, small = true)
                    }
                }
            }
            MqttReply(host.name, state, form)
        }

        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            ConsoleButton("Reconnect", { sendFrom(form, session, scope, reconnect.name, reconnect.name) }, small = true, glyph = Glyph.RESTART, enabled = ready)
            Note(reconnect.text)
            MqttReply(reconnect.name, state, form)
        }
    }
}
