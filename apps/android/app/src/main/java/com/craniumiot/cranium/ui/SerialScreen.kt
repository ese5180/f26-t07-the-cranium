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
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
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
import com.craniumiot.cranium.usb.UsbConsole
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * The serial console over the USB cable (the website's serial.js serialView): the connection and
 * the transcript, a free command line, and the commands by group, one group open at a time.
 * Nothing here talks to the API. A Wi-Fi password lives only in the field it is typed in, held
 * with `remember` and never in saved state, and is cleared as soon as it is sent, or when its
 * group is closed; the transcript holds the masked command only.
 */
@Composable
fun SerialScreen(vm: ConsoleViewModel, me: Me?) {
    if (me?.canWrite != true) {
        ConsoleScreen(title = "Serial console", help = "serial") {
            item(key = "viewer") { OneLine("The serial console is for release managers.", glyph = Glyph.LOCK) }
        }
        return
    }
    val usbState by vm.usb.usb.collectAsStateWithLifecycle()
    val state by vm.usb.session.state.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { vm.usb.look() }
    if (!usbState.usbHost) {
        ConsoleScreen(title = "Serial console", help = "serial") {
            item(key = "host") { OneLine("This phone cannot be a USB host, so it cannot reach the board's cable.", glyph = Glyph.USB) }
        }
        return
    }

    val scope = rememberCoroutineScope()
    val usb = vm.usb
    val session = usb.session
    val phase = state.phase
    val ready = phase == SerialSession.Phase.READY
    val open = phase != SerialSession.Phase.IDLE && phase != SerialSession.Phase.OPENING
    val form = remember { FormState() }
    var openGroup by remember { mutableStateOf<String?>(null) }

    val primary = when {
        phase == SerialSession.Phase.IDLE -> ScreenAction("Connect a board", Glyph.USB) { usb.connect() }
        open && phase != SerialSession.Phase.CLOSING -> ScreenAction("Disconnect", Glyph.X, onClick = usb::disconnect)
        else -> null
    }
    val actions = buildList {
        if (phase == SerialSession.Phase.SILENT) {
            add(ScreenAction("Ask again", Glyph.RESTART) { scope.launch { session.probe() } })
            if (usbState.ports >= 2) add(ScreenAction("Try the other port", Glyph.SWAP, onClick = usb::tryOtherPort))
        }
        if (state.lines.isNotEmpty()) add(ScreenAction("Clear", Glyph.MINUS_CIRCLE, onClick = session::clear))
    }

    ConsoleScreen(title = "Serial console", help = "serial", actions = actions, primary = primary) {
        item(key = "state") { ConnectionRow(state, usbState) }
        state.problem?.let { problem ->
            val warn = phase == SerialSession.Phase.SILENT || problem.startsWith("No board found") || problem.startsWith("The app was not allowed")
            item(key = "problem") { OneLine(problem, tone = if (warn) Tone.WARN else Tone.BAD, glyph = Glyph.ALERT) }
        }
        item(key = "transcript") {
            Column(Modifier.fillMaxWidth().padding(horizontal = Gutter, vertical = 8.dp)) { Transcript(state) }
        }
        item(key = "typed") {
            Column(Modifier.fillMaxWidth().padding(horizontal = Gutter, vertical = 8.dp)) { TypedInput(session, state, ready, scope) }
        }
        header("Commands")
        if (!ready) item(key = "locked") { OneLine("Connect a board to use these.", glyph = Glyph.LOCK) }
        for ((group, title) in SerialRules.GROUPS) {
            val expanded = openGroup == group
            item(key = "group-$group") {
                GroupRow(group, title, expanded) {
                    // A password typed and not sent does not wait in a closed group.
                    form.forgetSecrets()
                    openGroup = if (expanded) null else group
                }
            }
            if (expanded) {
                item(key = "forms-$group") {
                    Column(
                        Modifier.fillMaxWidth().padding(horizontal = Gutter, vertical = 8.dp),
                        verticalArrangement = Arrangement.spacedBy(20.dp),
                    ) {
                        if (group == "mqtt") {
                            MqttPanel(session, state, ready, scope, form)
                        } else {
                            for (command in SerialRules.COMMANDS.filter { it.group == group }) {
                                CommandRow(command, session, state, ready, scope, form)
                            }
                        }
                    }
                }
            }
        }
    }
}

// The connection.

/** Where the connection stands, the board and its firmware, and the port, in one row. */
@Composable
private fun ConnectionRow(state: SerialSession.State, usb: UsbConsole.UsbState) {
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
    val board = state.board
    val port = usb.port
    val details = buildList {
        if (state.phase == SerialSession.Phase.READY && board != null) {
            add(board.id.ifEmpty { "No ID yet" } + if (board.version.isNotEmpty()) " · firmware ${board.version}" else "")
        }
        if (port != null && state.phase != SerialSession.Phase.IDLE) add("VCOM$port of ${usb.ports}")
        if (state.phase == SerialSession.Phase.IDLE) {
            val probe = usb.probes.firstOrNull()
            add(if (probe == null) "Plug the DK's J-Link USB port into this phone." else "${probe.name} is plugged in.")
        }
    }
    val busy = state.phase == SerialSession.Phase.OPENING || state.phase == SerialSession.Phase.PROBING ||
        state.phase == SerialSession.Phase.CLOSING
    ListRow(
        headline = words,
        supporting = details.joinToString(" · ").ifEmpty { null },
        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        leading = {
            if (busy) {
                CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = colors.accent)
            } else {
                GlyphIcon(glyph, tint = colors.toneInk(tone))
            }
        },
        chevron = false,
    )
}

// The transcript.

@Composable
private fun Transcript(state: SerialSession.State) {
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
        Box(
            Modifier
                .fillMaxWidth()
                .height(320.dp)
                .clip(RoundedCornerShape(5.dp))
                .border(1.dp, colors.line, RoundedCornerShape(5.dp))
                .background(colors.surface)
                .semantics { contentDescription = "Transcript of what was sent and what the board said" },
        ) {
            if (state.lines.isEmpty()) {
                Text("What is sent and what the board says appears here.", Modifier.padding(12.dp), style = ConsoleType.note, color = colors.ink3)
            } else {
                LazyColumn(
                    Modifier.fillMaxSize().nestedScroll(connection),
                    state = listState,
                    contentPadding = PaddingValues(horizontal = 10.dp, vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(3.dp),
                ) {
                    if (dropped) {
                        item(key = "dropped") {
                            Text("${state.linesDropped} earlier lines are no longer kept.", style = ConsoleType.note, color = colors.ink3)
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
                        if (line.auto) Text("sent by the app", style = ConsoleType.note.copy(fontSize = 11.5.sp), color = colors.ink3)
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
            SerialRules.Typed.Empty -> problem = null
            is SerialRules.Typed.Refused -> problem = result.why
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
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ConsoleField(
                value = typed,
                onValueChange = {
                    typed = it
                    problem = null
                },
                label = "Command",
                modifier = Modifier.weight(1f),
                mono = true,
                secret = hidden,
                enabled = ready,
                placeholder = "COMMAND|arg1|arg2",
                hint = if (hidden) "Holds a password: hidden, and not kept." else null,
            )
            ConsoleButton("Send", { submit() }, kind = ButtonKind.PRIMARY, glyph = Glyph.SEND, small = true, enabled = ready)
        }
        problem?.let { ErrorLine(it) }
        val recalled = state.typed.asReversed().take(10)
        if (recalled.isNotEmpty()) {
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
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

    /** Every password field emptied, and every typed confirmation. */
    fun forgetSecrets() {
        for (command in SerialRules.COMMANDS) {
            for (field in command.fields) if (field.secret) values.remove(fieldKey(command, field.key))
            if (command.confirm != null) values.remove(fieldKey(command, "confirm"))
        }
    }
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

/** A group of commands, opened in place; one at a time. */
@Composable
private fun GroupRow(group: String, title: String, expanded: Boolean, onClick: () -> Unit) {
    val names = if (group == "mqtt") {
        "MQTT, MQTT_HOST, MQTT_RECONNECT"
    } else {
        SerialRules.COMMANDS.filter { it.group == group }.joinToString(", ") { it.name }
    }
    ListRow(
        headline = title,
        supporting = names,
        modifier = Modifier.semantics { stateDescription = if (expanded) "Open" else "Closed" },
        trailing = { GlyphIcon(if (expanded) Glyph.MINUS else Glyph.PLUS, size = 18.dp, tint = console.ink2) },
        onClick = onClick,
        chevron = false,
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChoiceField(command: SerialRules.Command, field: SerialRules.Field, form: FormState, ready: Boolean) {
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

/** One command: a button for one that takes nothing, else its fields and its button. */
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
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                ConsoleButton(command.name, { sendFrom(form, session, scope, command.name, command.name) }, small = true, enabled = ready)
                Text(command.text, Modifier.weight(1f), style = ConsoleType.note, color = colors.ink2)
            }
        } else {
            Text(command.name, style = ConsoleType.mono.copy(fontWeight = FontWeight.SemiBold), color = colors.ink)
            Text(command.text, style = ConsoleType.note, color = colors.ink2)
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
    RecordLine(reply)
}

/** Whether the command a form sent is in the activity log, said under the board's own answer (serial.js recordOf). */
@Composable
private fun RecordLine(reply: SerialSession.Reply) {
    val colors = console
    val (glyph, text, tint) = when (reply.record ?: return) {
        SerialSession.Record.SENDING -> Triple(Glyph.HOURGLASS, "Putting it in the activity log…", colors.ink2)
        SerialSession.Record.DONE -> Triple(Glyph.CHECK, "In the activity log.", colors.good)
        SerialSession.Record.FAILED -> Triple(Glyph.ALERT, reply.recordProblem ?: "Done on the board, but not in the activity log.", colors.warn)
    }
    Row(
        Modifier.semantics(mergeDescendants = true) {
            liveRegion = if (reply.record == SerialSession.Record.FAILED) LiveRegionMode.Assertive else LiveRegionMode.Polite
        },
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        GlyphIcon(glyph, Modifier.padding(top = 2.dp), size = 14.dp, tint = tint)
        Text(text, style = ConsoleType.note, color = if (reply.record == SerialSession.Record.FAILED) colors.ink else colors.ink2)
    }
}

// The MQTT group: what MQTT says, a new server, and a new connection.

@Composable
private fun MqttReply(name: String, state: SerialSession.State, form: FormState) {
    ReplyLine(name, state, form)
    val reply = state.reply
    if (reply != null && reply.form == name && reply.kind == SerialSession.ReplyKind.ERR && reply.text.startsWith("unknown command")) {
        Text(SerialRules.OLD_FIRMWARE, style = ConsoleType.note, color = console.ink2)
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

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            ConsoleButton("Check MQTT", { sendFrom(form, session, scope, check.name, check.name) }, small = true, glyph = Glyph.PULSE, enabled = ready)
            Text(check.text, Modifier.weight(1f), style = ConsoleType.note, color = colors.ink2)
        }
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
            Text(
                if (mqtt.stale) "As of ${mqtt.at}, before the last change: check again." else "As of ${mqtt.at}.",
                style = ConsoleType.note,
                color = colors.ink3,
            )
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Set server", style = ConsoleType.body.copy(fontWeight = FontWeight.SemiBold), color = colors.ink)
        val error = form.errors[host.name]?.get("host")
        ConsoleField(
            value = form.values[hostKey] ?: "",
            onValueChange = {
                form.values[hostKey] = it
                // What is being confirmed is what was in the field: a change takes the question back.
                confirming = null
            },
            label = SerialRules.HOST_FIELD.label,
            hint = current?.let { "Now: $it" },
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
            Column(Modifier.semantics { liveRegion = LiveRegionMode.Polite }, verticalArrangement = Arrangement.spacedBy(8.dp)) {
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
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            ConsoleButton("Reconnect", { sendFrom(form, session, scope, reconnect.name, reconnect.name) }, small = true, glyph = Glyph.RESTART, enabled = ready)
            Text(reconnect.text, Modifier.weight(1f), style = ConsoleType.note, color = colors.ink2)
        }
        MqttReply(reconnect.name, state, form)
    }
}
