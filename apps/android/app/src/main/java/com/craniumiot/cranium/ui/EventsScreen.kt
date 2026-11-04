package com.craniumiot.cranium.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.craniumiot.cranium.core.BoardEvent
import com.craniumiot.cranium.core.BoardLine
import com.craniumiot.cranium.core.BoardLog
import com.craniumiot.cranium.core.Boards
import com.craniumiot.cranium.core.Device
import com.craniumiot.cranium.core.Glyph
import com.craniumiot.cranium.core.Telemetry
import com.craniumiot.cranium.core.Tone
import com.craniumiot.cranium.core.Words
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlin.math.abs

private val LOCAL_INPUT: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")

/** A local date and time as the custom range's fields write it. */
private fun localInput(ms: Long): String = Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault()).format(LOCAL_INPUT)

/** What a person typed into a field of the custom range, as epoch milliseconds, or null. */
private fun readLocal(text: String): Long? =
    runCatching { LocalDateTime.parse(text.trim(), LOCAL_INPUT).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli() }.getOrNull()

/** The colour of a kind's family (telemetry.js: three hues and grey for connections). */
private fun hueColor(hue: Telemetry.Hue, colors: ConsoleColors): Color = when (hue) {
    Telemetry.Hue.A -> colors.kindA
    Telemetry.Hue.B -> colors.kindB
    Telemetry.Hue.C -> colors.kindC
    Telemetry.Hue.QUIET -> colors.kindQuiet
}

private fun polygon(center: Offset, unit: Float, corners: List<Pair<Float, Float>>): Path = Path().apply {
    corners.forEachIndexed { index, (x, y) ->
        if (index == 0) moveTo(center.x + x * unit, center.y + y * unit) else lineTo(center.x + x * unit, center.y + y * unit)
    }
    close()
}

/** A kind's shape, drawn around a centre in about 12 dp ([unit] is one dp in pixels). */
private fun DrawScope.drawKindMark(shape: Telemetry.Shape, center: Offset, color: Color, unit: Float) {
    when (shape) {
        Telemetry.Shape.CIRCLE -> drawCircle(color, 5f * unit, center)
        Telemetry.Shape.SQUARE -> drawRoundRect(
            color, topLeft = center - Offset(4.5f * unit, 4.5f * unit), size = Size(9f * unit, 9f * unit),
            cornerRadius = CornerRadius(1.5f * unit),
        )
        Telemetry.Shape.DIAMOND -> drawPath(polygon(center, unit, listOf(0f to -6.2f, 6.2f to 0f, 0f to 6.2f, -6.2f to 0f)), color)
        Telemetry.Shape.UP -> drawPath(polygon(center, unit, listOf(0f to -6f, 5.8f to 4.6f, -5.8f to 4.6f)), color)
        Telemetry.Shape.DOWN -> drawPath(polygon(center, unit, listOf(0f to 6f, 5.8f to -4.6f, -5.8f to -4.6f)), color)
        Telemetry.Shape.RING -> drawCircle(color, 4.4f * unit, center, style = Stroke(width = 2f * unit))
        Telemetry.Shape.PLUS -> drawPath(
            polygon(
                center, unit,
                listOf(
                    -1.8f to -6f, 1.8f to -6f, 1.8f to -1.8f, 6f to -1.8f, 6f to 1.8f, 1.8f to 1.8f,
                    1.8f to 6f, -1.8f to 6f, -1.8f to 1.8f, -6f to 1.8f, -6f to -1.8f, -1.8f to -1.8f,
                ),
            ),
            color,
        )
        Telemetry.Shape.DOT -> drawCircle(color, 3.2f * unit, center)
        Telemetry.Shape.BAR -> drawRoundRect(
            color, topLeft = center - Offset(1.6f * unit, 7f * unit), size = Size(3.2f * unit, 14f * unit),
            cornerRadius = CornerRadius(1.6f * unit),
        )
    }
}

/** A kind's mark on its own, for a chip, a row or the details of an event. */
@Composable
internal fun KindSwatch(kindId: String, alpha: Float = 1f) {
    val colors = console
    val kind = Telemetry.kindOf(kindId)
    val color = hueColor(kind.hue, colors).copy(alpha = alpha)
    Canvas(Modifier.size(16.dp).clearAndSetSemantics {}) {
        drawKindMark(kind.shape, Offset(size.width / 2f, size.height / 2f), color, 1.dp.toPx())
    }
}

/** What each board is called in the list to choose from; with its thing name where two share a name. */
private fun boardChoices(things: List<String>, devices: List<Device>): List<Pair<String, String>> {
    val names = things.map { Boards.name(Boards.of(it, devices)) }
    return things.mapIndexed { index, thing ->
        val unique = names.count { it == names[index] } == 1
        thing to if (unique) names[index] else Boards.name(Boards.of(thing, devices), full = true)
    }
}

/** Where an event's link leads in the app: its deployment, or what a console entry is about. */
private fun eventTarget(event: BoardEvent): Route? {
    event.job?.let { return Route.DeploymentPage(it) }
    if (event.kind != "console") return null
    val href = event.href ?: return null
    return when {
        href.startsWith("deployment:") -> Route.DeploymentPage(href.removePrefix("deployment:"))
        href == "firmware" -> Route.Firmware
        else -> null
    }
}

/**
 * The Events page (the website's telemetry.js): what every board did over time, as a timeline
 * with a lane per board and one for the console, and as a list. The range presets and the kinds
 * stand above the timeline; a custom range, zooming out and the board go in the menu.
 */
@Composable
fun EventsScreen(vm: ConsoleViewModel, store: Store, now: Long) {
    val page = store.events
    val data = page.data.value
    val span = data?.span ?: Telemetry.rangeOf(page.range, now)
    val devices = store.deviceList.orEmpty()
    val colors = console
    var customOpen by remember { mutableStateOf(false) }
    var boardOpen by remember { mutableStateOf(false) }

    val things = devices.map { it.thing }.toMutableList()
    if (page.thing.isNotEmpty() && page.thing !in things) things += page.thing
    val choices = boardChoices(things, devices)
    val allBoards = "All boards (${things.size})"
    val boardLabel = choices.firstOrNull { it.first == page.thing }?.second ?: "All boards"

    val actions = buildList {
        add(ScreenAction("Custom range…", Glyph.CLOCK) { customOpen = true })
        if (page.zooms.isNotEmpty()) add(ScreenAction("Zoom out", Glyph.ARROW_LEFT, onClick = vm::zoomOut))
        add(ScreenAction("Board: $boardLabel", Glyph.CHIP) { boardOpen = true })
    }

    val consoleEvents = data?.audit?.mapNotNull { Telemetry.consoleEvent(it, devices) }
    val log = data?.log
    val lines = if (page.log && log != null && log.error == null) BoardLog.shown(log.lines, page.hidden) else emptyList()
    val lanes = if (data != null) Telemetry.lanesOf(data.events, devices, page.thing, consoleEvents, lines) else emptyList()
    val shownByLane = lanes.associate { it.id to Telemetry.shownEvents(listOf(it), page.hidden) }
    val shown = Telemetry.shownEvents(lanes, page.hidden).distinctBy { Telemetry.eventKey(it) }
    val rangeText = Telemetry.rangeWords(span)
    val noBoards = data != null && (lanes.isEmpty() || (store.devices.value != null && devices.isEmpty() && data.events.isEmpty()))

    ConsoleScreen(
        title = "Events",
        subtitle = rangeText,
        help = "events",
        actions = actions,
        stale = staleOf(listOf(page.data, store.devices), vm.intervalOf(Route.Events), now, vm::refreshNow),
        onRefresh = { vm.refresh(Route.Events, full = true) },
    ) {
        item(key = "ranges") { RangeRow(vm, page, span) }
        problem(page.data.error, "the events", data != null, vm::refreshNow)
        if (data == null) {
            if (page.data.error == null) loading("events")
            return@ConsoleScreen
        }
        if (noBoards) {
            item(key = "none") { OneLine("No boards are registered yet.", glyph = Glyph.CHIP) }
            return@ConsoleScreen
        }
        item(key = "kinds") { KindChips(vm, page.hidden) }
        item(key = "timeline") {
            Column(Modifier.fillMaxWidth().padding(horizontal = Gutter, vertical = 8.dp)) {
                Timeline(vm, lanes, shownByLane, span, data, page.selected, rangeText)
                SelectedEvent(lanes, shownByLane, span, page.selected, devices)
                if (data.auditCut) {
                    Text(
                        "The Console lane holds the newest 500 entries of the log in this range.",
                        Modifier.padding(top = 8.dp),
                        style = ConsoleType.note,
                        color = colors.ink3,
                    )
                }
                if (lines.isNotEmpty()) {
                    Text(BoardLog.TICKS_NOTE, Modifier.padding(top = 8.dp), style = ConsoleType.note, color = colors.ink3)
                }
            }
        }
        if (shown.isEmpty()) {
            val action: Pair<String, () -> Unit>? = when {
                page.thing.isNotEmpty() -> "All boards" to { vm.chooseEventBoard("") }
                page.hidden.isNotEmpty() -> "Show every kind" to { page.hidden.forEach(vm::toggleKind) }
                span.preset?.id != "30d" -> "Last 30 days" to { vm.choosePreset("30d") }
                else -> null
            }
            item(key = "empty") { OneLine("No events in this range.", action) }
        } else {
            var day: String? = null
            for (event in shown) {
                val label = Words.dayLabel(event.at, now)
                if (label != day) {
                    day = label
                    header(label, key = "day-$label")
                }
                val key = Telemetry.eventKey(event)
                item(key = "event-$key") { EventRow(vm, event, key == page.selected, devices) }
            }
        }
        if (data.cursor != null) {
            item(key = "more") {
                Row(Modifier.fillMaxWidth().padding(horizontal = Gutter, vertical = 12.dp)) {
                    ConsoleButton(
                        if (page.moreLoading) "Loading…" else "Load 500 more",
                        vm::loadMoreEvents,
                        enabled = !page.moreLoading,
                        small = true,
                    )
                }
            }
        }
        page.moreError?.let { error ->
            item(key = "more-error") { OneLine("Could not load more. ${messageOf(error)}", "Try again" to vm::loadMoreEvents, Tone.BAD, Glyph.ALERT) }
        }
        boardLog(vm, page, log, lines, devices, now)
    }

    if (customOpen) CustomRangeDialog(vm, span) { customOpen = false }
    if (boardOpen) {
        BoardDialog(
            all = allBoards,
            chosen = page.thing,
            choices = choices,
            onChoose = { thing ->
                boardOpen = false
                vm.chooseEventBoard(thing)
            },
            onClose = { boardOpen = false },
        )
    }
}

/**
 * The Board log (telemetry.js boardLogCard): every line a board on firmware 1.12.0 or later printed
 * on its serial console in the range, newest first, by day, with a source to narrow it to, or hidden.
 */
private fun LazyListScope.boardLog(
    vm: ConsoleViewModel,
    page: EventsPage,
    log: LogData?,
    lines: List<BoardLine>,
    devices: List<Device>,
    now: Long,
) {
    header(BoardLog.TITLE, key = "log-head")
    item(key = "log-tools") { LogTools(vm, page, log, lines) }
    val error = log?.error
    when {
        !page.log -> item(key = "log-hidden") { OneLine(BoardLog.HIDDEN_NOTE) }
        error != null -> item(key = "log-failed") {
            OneLine("${BoardLog.FAILED} ${messageOf(error)}", "Try again" to vm::refreshNow, Tone.BAD, Glyph.ALERT)
        }
        log == null -> loading("the board log")
        lines.isEmpty() -> item(key = "log-empty") {
            OneLine("${BoardLog.EMPTY_TITLE} ${BoardLog.emptyText(page.tag, page.thing, page.hidden)}", glyph = Glyph.LIST)
        }
        else -> {
            var day: String? = null
            for (line in lines) {
                val label = Words.dayLabel(line.at, now)
                if (label != day) {
                    day = label
                    header("${BoardLog.TITLE} · $label", key = "log-day-$label")
                }
                item(key = "line-${line.key}") { BoardLineRow(line, devices) }
            }
        }
    }
    if (page.log && log?.cursor != null && error == null) {
        item(key = "log-more") {
            Row(Modifier.fillMaxWidth().padding(horizontal = Gutter, vertical = 12.dp)) {
                ConsoleButton(
                    if (page.linesMoreLoading) "Loading…" else BoardLog.LOAD_MORE,
                    vm::loadMoreLines,
                    enabled = !page.linesMoreLoading,
                    small = true,
                )
            }
        }
    }
    page.linesMoreError?.let { problem ->
        item(key = "log-more-error") { OneLine("Could not load more. ${messageOf(problem)}", "Try again" to vm::loadMoreLines, Tone.BAD, Glyph.ALERT) }
    }
}

/** Above the lines: how many, the source they are narrowed to, and Hide or Show. */
@Composable
private fun LogTools(vm: ConsoleViewModel, page: EventsPage, log: LogData?, lines: List<BoardLine>) {
    var choosing by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(horizontal = Gutter, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (page.log && log != null && log.error == null && lines.isNotEmpty()) {
            Text(BoardLog.count(lines, more = log.cursor != null), style = ConsoleType.small, color = console.ink2)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            if (page.log) {
                Box {
                    ConsoleButton(
                        "${BoardLog.SOURCE}: ${page.tag.ifEmpty { BoardLog.ALL_SOURCES }}",
                        { choosing = true },
                        small = true,
                        glyph = Glyph.LIST,
                    )
                    DropdownMenu(expanded = choosing, onDismissRequest = { choosing = false }, containerColor = console.surface) {
                        for (tag in listOf("") + BoardLog.TAGS) {
                            DropdownMenuItem(
                                text = {
                                    Text(
                                        tag.ifEmpty { BoardLog.ALL_SOURCES },
                                        style = if (tag.isEmpty()) ConsoleType.body else ConsoleType.mono,
                                        color = console.ink,
                                    )
                                },
                                leadingIcon = if (tag == page.tag) ({ GlyphIcon(Glyph.CHECK, tint = console.accent) }) else null,
                                onClick = {
                                    choosing = false
                                    vm.chooseTag(tag)
                                },
                            )
                        }
                    }
                }
            }
            ConsoleButton(
                if (page.log) BoardLog.HIDE else BoardLog.SHOW,
                vm::toggleLog,
                Modifier.semantics { stateDescription = if (page.log) "Shown" else "Hidden" },
                small = true,
            )
        }
    }
}

/** The presets of the range, as one compact row. */
@Composable
private fun RangeRow(vm: ConsoleViewModel, page: EventsPage, span: Telemetry.TimeSpan) {
    val colors = console
    Row(
        Modifier
            .padding(horizontal = Gutter, vertical = 4.dp)
            .clip(RoundedCornerShape(5.dp))
            .border(1.dp, colors.lineField, RoundedCornerShape(5.dp))
            .semantics { contentDescription = "Time range" },
    ) {
        for (preset in Telemetry.PRESETS) {
            val pressed = span.preset?.id == preset.id && page.zooms.isEmpty()
            Segment(preset.label, pressed, "Show ${preset.name}") { vm.choosePreset(preset.id) }
        }
    }
}

/** One option of the segmented range control. */
@Composable
private fun Segment(label: String, pressed: Boolean, description: String, onClick: () -> Unit) {
    val colors = console
    Box(
        Modifier
            .background(if (pressed) colors.ink else Color.Transparent)
            .selectable(selected = pressed, role = Role.Button, onClick = onClick)
            .heightIn(min = 40.dp)
            .padding(horizontal = 14.dp)
            .semantics {
                contentDescription = description
                stateDescription = if (pressed) "Shown" else "Not shown"
            },
        contentAlignment = Alignment.Center,
    ) {
        Text(label, style = ConsoleType.button.copy(fontSize = 13.sp), color = if (pressed) colors.paper else colors.ink)
    }
}

/** A range of local times, asked for only when wanted. */
@Composable
private fun CustomRangeDialog(vm: ConsoleViewModel, span: Telemetry.TimeSpan, onClose: () -> Unit) {
    val colors = console
    var from by remember { mutableStateOf(localInput(span.fromMs)) }
    var to by remember { mutableStateOf(localInput(span.toMs)) }
    var error by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        onDismissRequest = onClose,
        containerColor = colors.surface,
        title = { Text("Custom range", style = ConsoleType.sectionTitle, color = colors.ink) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                ConsoleField(from, { from = it; error = null }, "From", mono = true, placeholder = "2026-11-02 14:30")
                ConsoleField(to, { to = it; error = null }, "To", mono = true, placeholder = "2026-11-02 18:00", hint = "Local times, at most 31 days.")
                error?.let { Text(it, style = ConsoleType.note, color = colors.bad) }
            }
        },
        confirmButton = {
            ConsoleButton("Show", {
                val wrong = vm.applyCustomRange(readLocal(from), readLocal(to))
                if (wrong == null) onClose() else error = wrong
            }, kind = ButtonKind.PRIMARY, small = true)
        },
        dismissButton = { ConsoleButton("Cancel", onClose, kind = ButtonKind.QUIET, small = true) },
    )
}

/** Which boards the page is about: all of them, or one. */
@Composable
private fun BoardDialog(all: String, chosen: String, choices: List<Pair<String, String>>, onChoose: (String) -> Unit, onClose: () -> Unit) {
    val colors = console
    AlertDialog(
        onDismissRequest = onClose,
        containerColor = colors.surface,
        title = { Text("Board", style = ConsoleType.sectionTitle, color = colors.ink) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                BoardOption(all, chosen.isEmpty(), mono = false) { onChoose("") }
                for ((thing, label) in choices) BoardOption(label, chosen == thing, mono = true) { onChoose(thing) }
            }
        },
        confirmButton = { ConsoleButton("Close", onClose, kind = ButtonKind.QUIET, small = true) },
    )
}

@Composable
private fun BoardOption(label: String, selected: Boolean, mono: Boolean, onClick: () -> Unit) {
    val colors = console
    Row(
        Modifier
            .fillMaxWidth()
            .selectable(selected = selected, role = Role.RadioButton, onClick = onClick)
            .heightIn(min = 48.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (selected) GlyphIcon(Glyph.CHECK, tint = colors.accent) else Spacer(Modifier.width(18.dp))
        Text(label, style = if (mono) ConsoleType.mono else ConsoleType.body, color = colors.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** The kinds of event shown, each a chip that switches it on or off, and the key to the online band. */
@Composable
private fun KindChips(vm: ConsoleViewModel, hidden: Set<String>) {
    val colors = console
    Row(
        Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = Gutter, vertical = 4.dp)
            .semantics { contentDescription = "Kinds of event shown" },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        for (kind in Telemetry.KINDS) {
            val on = kind.id !in hidden
            val shape = RoundedCornerShape(16.dp)
            Row(
                Modifier
                    .clip(shape)
                    .border(1.dp, if (on) colors.lineStrong else colors.line, shape)
                    .toggleable(value = on, role = Role.Checkbox, onValueChange = { vm.toggleKind(kind.id) })
                    .heightIn(min = 40.dp)
                    .padding(horizontal = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                KindSwatch(kind.id, if (on) 1f else 0.35f)
                Text(kind.label, style = ConsoleType.note, color = if (on) colors.ink else colors.ink3)
            }
        }
        Row(
            Modifier.heightIn(min = 40.dp).padding(horizontal = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Box(Modifier.size(width = 16.dp, height = 10.dp).clip(RoundedCornerShape(2.dp)).background(colors.bandOnline))
            Text("Online", style = ConsoleType.note, color = colors.ink2)
        }
    }
}

/**
 * The timeline: a lane per board and one for the console, the times a board was online as
 * bands, and its events as marks by kind. A tap picks an event; a drag across zooms in.
 */
@Composable
private fun Timeline(
    vm: ConsoleViewModel,
    lanes: List<Telemetry.Lane>,
    shownByLane: Map<String, List<BoardEvent>>,
    span: Telemetry.TimeSpan,
    data: EventsData,
    selected: String?,
    rangeText: String,
) {
    val colors = console
    val measurer = rememberTextMeasurer()
    val fontScale = LocalDensity.current.fontScale.coerceAtLeast(1f)
    val axis = (24 * fontScale).dp
    val head = (20 * fontScale).dp
    val track = 28.dp
    val gap = 14.dp
    val lane = head + track + gap
    val height = axis + lane * lanes.size
    var drag by remember { mutableStateOf<Pair<Float, Float>?>(null) }
    val ticks = Telemetry.timeTicks(span.fromMs, span.toMs, 4)
    // Where the loaded events of a range with more pages begin.
    val oldestLoaded = if (data.cursor != null && data.events.isNotEmpty()) data.events.last().atMs else null
    val hasConsole = lanes.any { it.id == "console" }
    val hasLines = lanes.any { it.lines.isNotEmpty() }
    val description = "Timeline of events, $rangeText. One lane per board${if (hasConsole) " and one for the console" else ""}. " +
        "The list below has every event${if (hasLines) ", and the board log under it every line of the boards’ own logs" else ""}."

    Canvas(
        Modifier
            .fillMaxWidth()
            .height(height)
            .semantics { contentDescription = description }
            .pointerInput(lanes, span, shownByLane) {
                detectTapGestures { offset ->
                    val axisPx = axis.toPx()
                    val lanePx = lane.toPx()
                    if (offset.y < axisPx) return@detectTapGestures
                    val index = ((offset.y - axisPx) / lanePx).toInt()
                    val picked = lanes.getOrNull(index) ?: return@detectTapGestures
                    val events = shownByLane[picked.id].orEmpty()
                    val width = size.width.toFloat()
                    val nearest = events.minByOrNull { abs(Telemetry.place(it.atMs, span.fromMs, span.toMs) * width - offset.x) }
                        ?: return@detectTapGestures
                    if (abs(Telemetry.place(nearest.atMs, span.fromMs, span.toMs) * width - offset.x) <= 20.dp.toPx()) {
                        vm.selectEvent(Telemetry.eventKey(nearest))
                    }
                }
            }
            .pointerInput(span) {
                var start = 0f
                var current = 0f
                detectHorizontalDragGestures(
                    onDragStart = { offset ->
                        val width = size.width.toFloat().coerceAtLeast(1f)
                        start = (offset.x / width).coerceIn(0f, 1f)
                        current = start
                        drag = start to current
                    },
                    onDragEnd = {
                        val (low, high) = listOf(start, current).sorted()
                        drag = null
                        val width = span.toMs - span.fromMs
                        val fromMs = span.fromMs + (low * width).toLong()
                        val toMs = span.fromMs + (high * width).toLong()
                        if (toMs - fromMs >= Telemetry.SHORTEST_ZOOM) vm.zoomTo(fromMs, toMs)
                    },
                    onDragCancel = { drag = null },
                    onHorizontalDrag = { change, amount ->
                        change.consume()
                        val width = size.width.toFloat().coerceAtLeast(1f)
                        current = (current + amount / width).coerceIn(0f, 1f)
                        drag = start to current
                    },
                )
            },
    ) {
        val width = size.width
        val axisPx = axis.toPx()
        val headPx = head.toPx()
        val trackPx = track.toPx()
        val lanePx = lane.toPx()
        val unit = 1.dp.toPx()
        fun x(ms: Long): Float = Telemetry.place(ms, span.fromMs, span.toMs) * width
        val tickStyle = TextStyle(fontSize = 11.sp, color = colors.ink3)

        // The time axis and its grid.
        for (tick in ticks) {
            val at = x(tick.ms)
            drawLine(if (tick.newDay) colors.lineStrong else colors.line, Offset(at, axisPx - 6 * unit), Offset(at, size.height), unit)
            val label = measurer.measure(tick.label, style = tickStyle)
            val placeAt = Telemetry.place(tick.ms, span.fromMs, span.toMs)
            val left = when {
                placeAt < 0.04f -> at
                placeAt > 0.96f -> at - label.size.width
                else -> at - label.size.width / 2f
            }
            drawText(label, topLeft = Offset(left.coerceIn(0f, (width - label.size.width).coerceAtLeast(0f)), 0f))
        }

        lanes.forEachIndexed { index, item ->
            val top = axisPx + index * lanePx
            val trackTop = top + headPx
            val middle = trackTop + trackPx / 2f
            val events = shownByLane[item.id].orEmpty()

            // The lane's name, and how the board stands now.
            val state = item.device?.let { Telemetry.laneState(it) }
            val name = buildAnnotatedString {
                withStyle(SpanStyle(color = colors.ink, fontWeight = FontWeight.SemiBold)) { append(item.label) }
                if (state != null) {
                    append("  ")
                    withStyle(SpanStyle(color = if (state.first == Tone.GOOD) colors.good else colors.ink3)) { append(state.second) }
                }
                if (events.isEmpty()) {
                    append("  ")
                    withStyle(SpanStyle(color = colors.ink3)) { append("No events") }
                }
            }
            val nameLayout = measurer.measure(
                name,
                style = TextStyle(fontSize = 12.sp),
                overflow = TextOverflow.Ellipsis,
                maxLines = 1,
                constraints = Constraints(maxWidth = width.toInt().coerceAtLeast(1)),
            )
            drawText(nameLayout, topLeft = Offset(0f, top + (headPx - nameLayout.size.height) / 2f))

            // The track, and the times the board was online.
            drawRoundRect(colors.well, topLeft = Offset(0f, trackTop), size = Size(width, trackPx), cornerRadius = CornerRadius(3 * unit))
            if (item.id != "console") {
                for (band in Telemetry.onlineBands(item.events, span.fromMs, span.toMs, item.device, span.live)) {
                    val from = x(band.fromMs)
                    drawRect(
                        colors.bandOnline.copy(alpha = if (band.inferred) 0.5f else 1f),
                        topLeft = Offset(from, trackTop),
                        size = Size((x(band.toMs) - from).coerceAtLeast(unit), trackPx),
                    )
                }
            }

            // The board's own log, as ticks at the foot of the lane: part of the drawing only, never read out.
            for (line in item.lines) {
                val at = x(line.atMs)
                val warn = line.warn
                drawLine(
                    if (warn) colors.warn else hueColor(Telemetry.kindOf(line.kind).hue, colors).copy(alpha = 0.8f),
                    Offset(at, trackTop + trackPx - 7 * unit),
                    Offset(at, trackTop + trackPx - 1 * unit),
                    strokeWidth = (if (warn) 2f else 1.5f) * unit,
                    cap = StrokeCap.Round,
                )
            }

            // The events, oldest first, so that the newest lies on top.
            val lift = Telemetry.staggered(events, span.fromMs, span.toMs)
            for (event in events.sortedBy { it.atMs }) {
                val key = Telemetry.eventKey(event)
                val kind = Telemetry.kindOf(event.kind)
                val center = Offset(x(event.atMs), middle + (lift[key] ?: 0) * 7 * unit)
                drawCircle(colors.surface, 7 * unit, center)
                drawKindMark(kind.shape, center, hueColor(kind.hue, colors), unit)
                if (event.level == "warn") drawCircle(colors.warn, 8.5f * unit, center, style = Stroke(width = 1.5f * unit))
                if (key == selected) drawCircle(colors.ink, 10.5f * unit, center, style = Stroke(width = 2 * unit))
            }
        }

        // What a range with more pages has not loaded yet.
        if (oldestLoaded != null && oldestLoaded > span.fromMs) {
            val until = x(oldestLoaded)
            drawRect(colors.paper.copy(alpha = 0.7f), topLeft = Offset(0f, axisPx - 2 * unit), size = Size(until, size.height - axisPx + 2 * unit))
            val label = measurer.measure("Not loaded yet", style = TextStyle(fontSize = 11.sp, color = colors.ink2))
            drawText(label, topLeft = Offset(6 * unit, axisPx + 2 * unit))
        }

        // A drag that may become a zoom.
        drag?.let { (from, to) ->
            val left = minOf(from, to) * width
            val right = maxOf(from, to) * width
            drawRect(colors.accent.copy(alpha = 0.15f), topLeft = Offset(left, axisPx - 4 * unit), size = Size(right - left, size.height - axisPx + 4 * unit))
            drawLine(colors.accent, Offset(left, axisPx - 4 * unit), Offset(left, size.height), unit)
            drawLine(colors.accent, Offset(right, axisPx - 4 * unit), Offset(right, size.height), unit)
        }
    }
}

/** What happened at the spot of the picked event: every event there, the newest first. */
@Composable
private fun SelectedEvent(
    lanes: List<Telemetry.Lane>,
    shownByLane: Map<String, List<BoardEvent>>,
    span: Telemetry.TimeSpan,
    selected: String?,
    devices: List<Device>,
) {
    if (selected == null) return
    val colors = console
    val lane = lanes.firstOrNull { item -> shownByLane[item.id].orEmpty().any { Telemetry.eventKey(it) == selected } } ?: return
    val events = shownByLane[lane.id].orEmpty()
    val event = events.first { Telemetry.eventKey(it) == selected }
    val spot = Telemetry.neighbours(events, event.atMs, span.fromMs, span.toMs).sortedByDescending { it.atMs }
    val shown = spot.take(5)
    Column(
        Modifier
            .fillMaxWidth()
            .padding(top = 10.dp)
            .clip(RoundedCornerShape(6.dp))
            .background(colors.surface)
            .border(1.dp, colors.lineStrong, RoundedCornerShape(6.dp))
            .padding(12.dp)
            .semantics { },
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (lane.id == "console") {
            Text("Console", style = ConsoleType.small.copy(fontWeight = FontWeight.SemiBold), color = colors.ink)
        } else {
            BoardName(Boards.of(lane.thing ?: lane.id, devices))
        }
        for (item in shown) {
            Row(Modifier.semantics(mergeDescendants = true) {}, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Box(Modifier.padding(top = 2.dp)) { KindSwatch(item.kind) }
                Column(Modifier.weight(1f)) {
                    Text(item.text, style = ConsoleType.small.copy(fontWeight = FontWeight.SemiBold), color = colors.ink)
                    Text(
                        "${Telemetry.kindOf(item.kind).label} · ${Words.exactTime(item.at)}${if (item.level == "warn") " · warning" else ""}",
                        style = ConsoleType.note,
                        color = colors.ink2,
                    )
                }
            }
        }
        if (spot.size > shown.size) {
            Text("and ${spot.size - shown.size} more at this point", style = ConsoleType.note, color = colors.ink2)
        }
    }
}

/** One event of the list: tapping it picks it on the timeline; the arrow opens what it is about. */
@Composable
private fun EventRow(vm: ConsoleViewModel, event: BoardEvent, selected: Boolean, devices: List<Device>) {
    val colors = console
    val key = Telemetry.eventKey(event)
    val kind = Telemetry.kindOf(event.kind)
    val board = event.thing?.let { Boards.name(Boards.of(it, devices)) } ?: "Console"
    val target = eventTarget(event)
    ListRow(
        headline = event.text,
        supporting = "$board · ${kind.label} · ${Words.timeOfDay(event.at)}",
        modifier = Modifier.semantics { stateDescription = if (selected) "Picked on the timeline" else "Not picked" },
        leading = { KindSwatch(event.kind) },
        trailing = if (event.level == "warn" || target != null) {
            {
                if (event.level == "warn") Badge(Tone.WARN, Glyph.ALERT, "Warning")
                if (target != null) {
                    IconButton(onClick = { vm.open(target) }) {
                        GlyphIcon(Glyph.ARROW_RIGHT, size = 18.dp, tint = colors.ink2, description = "Open")
                    }
                }
            }
        } else {
            null
        },
        onClick = { vm.selectEvent(key) },
        chevron = false,
        headlineColor = if (selected) colors.accent else null,
    )
}
