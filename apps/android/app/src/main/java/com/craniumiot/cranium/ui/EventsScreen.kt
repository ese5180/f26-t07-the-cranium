package com.craniumiot.cranium.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
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
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
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

private const val LEDE = "What every board did, as it reported it: connections, updates, restarts, Bluetooth and its health, " +
    "with what people did in this console alongside. Events are kept for 90 days."

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
        Telemetry.Shape.BAR -> drawRoundRect(
            color, topLeft = center - Offset(1.6f * unit, 7f * unit), size = Size(3.2f * unit, 14f * unit),
            cornerRadius = CornerRadius(1.6f * unit),
        )
    }
}

/** A kind's mark on its own, for a chip, a row or the details of an event. */
@Composable
private fun KindSwatch(kindId: String, alpha: Float = 1f) {
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

/**
 * The Events page (the website's telemetry.js): what every board did over time, as a timeline
 * with a lane per board and one for the console, and as a list.
 */
@Composable
fun EventsScreen(vm: ConsoleViewModel, store: Store, now: Long) {
    val page = store.events
    val data = page.data.value
    val span = data?.span ?: Telemetry.rangeOf(page.range, now)
    val devices = store.deviceList.orEmpty()

    PageHead(
        "Events",
        lede = LEDE,
        tools = {
            Freshness(page.data.loadedAt, page.data.loading, vm.intervalOf(Route.Events), now, onRefresh = vm::refreshNow)
        },
    )
    RangeTools(vm, page, span)
    BoardFilter(vm, page, devices)
    LoadProblem(page.data.error, "the events", hasValue = data != null, loadedAt = page.data.loadedAt, now = now, onRetry = vm::refreshNow)

    if (data == null) {
        if (page.data.error == null) Loading("events")
        return
    }

    val consoleEvents = data.audit?.mapNotNull(Telemetry::consoleEvent)
    val lanes = Telemetry.lanesOf(data.events, devices, page.thing, consoleEvents)
    val shownByLane = lanes.associate { it.id to Telemetry.shownEvents(listOf(it), page.hidden) }
    val shown = Telemetry.shownEvents(lanes, page.hidden)
    val counts = shown.groupingBy { it.kind }.eachCount()
    val warnings = shown.count { it.level == "warn" }

    // No board at all, and none that was ever heard of in this range: the way to get one first.
    if (lanes.isEmpty() || (store.devices.value != null && devices.isEmpty() && data.events.isEmpty())) {
        Section {
            EmptyState(
                Glyph.CHIP, "No boards are registered yet.", "Provision one with",
                command = "python3 tools/provision_device.py",
            )
        }
        return
    }

    KindChips(vm, page.hidden, counts)

    val rangeText = Telemetry.rangeWords(span)
    Section(Modifier.padding(top = 16.dp), title = "Timeline") {
        Text(rangeText, Modifier.padding(bottom = 10.dp), style = ConsoleType.note, color = console.ink2)
        Timeline(vm, lanes, shownByLane, span, data, page.selected, rangeText)
        SelectedEvent(lanes, shownByLane, span, page.selected, devices)
        Text(
            "A band is a board online. Tap an event for what happened; drag across the timeline to zoom in." +
                if (data.auditCut) " The Console lane shows the newest 500 entries of the activity log in this range." else "",
            Modifier.padding(top = 10.dp),
            style = ConsoleType.note,
            color = console.ink2,
        )
    }

    Section(title = "All events") {
        Wrap(Modifier.padding(bottom = 10.dp)) {
            Text(Words.plural(shown.size, "event"), style = ConsoleType.note, color = console.ink2)
            if (warnings > 0) StatusLine(Tone.WARN, Glyph.ALERT, Words.plural(warnings, "warning"))
            if (data.cursor != null) Text("more in this range", style = ConsoleType.note, color = console.ink2)
        }
        if (shown.isEmpty()) {
            EmptyState(
                Glyph.LIST,
                "No events in this range.",
                if (page.hidden.isNotEmpty() || page.thing.isNotEmpty()) {
                    "Some kinds or boards are left out: show them all, or choose a longer range."
                } else {
                    "Boards record events when they connect, update, restart or change state. Choose a longer range."
                },
            )
        } else {
            EventList(vm, shown, page.selected, devices, now)
        }
        Column(Modifier.fillMaxWidth().padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (data.cursor != null) {
                ConsoleButton(
                    if (page.moreLoading) "Loading…" else "Load 500 more",
                    vm::loadMoreEvents,
                    enabled = !page.moreLoading,
                )
            }
            page.moreError?.let { Failure("Could not load more.", it) }
        }
    }
}

/** The range: the presets, a custom range, and the way back out of a zoom. */
@Composable
private fun RangeTools(vm: ConsoleViewModel, page: EventsPage, span: Telemetry.TimeSpan) {
    val colors = console
    var custom by remember { mutableStateOf<Pair<String, String>?>(null) }
    var customError by remember { mutableStateOf<String?>(null) }

    Column(Modifier.fillMaxWidth().padding(bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Wrap {
            Row(
                Modifier
                    .clip(RoundedCornerShape(5.dp))
                    .border(1.dp, colors.lineField, RoundedCornerShape(5.dp))
                    .semantics { contentDescription = "Time range" },
            ) {
                for (preset in Telemetry.PRESETS) {
                    val pressed = span.preset?.id == preset.id && page.zooms.isEmpty()
                    Segment(preset.label, pressed, "Show ${preset.name}") {
                        custom = null
                        customError = null
                        vm.choosePreset(preset.id)
                    }
                }
                Segment("Custom…", span.preset == null || custom != null, "Choose a range") {
                    custom = localInput(span.fromMs) to localInput(span.toMs)
                    customError = null
                }
            }
            if (page.zooms.isNotEmpty()) ConsoleButton("Zoom out", vm::zoomOut, small = true, glyph = Glyph.ARROW_LEFT)
        }

        val form = custom
        if (form != null) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                ConsoleField(
                    form.first, { custom = it to form.second; customError = null }, "From",
                    mono = true, placeholder = "2026-11-02 14:30",
                )
                ConsoleField(
                    form.second, { custom = form.first to it; customError = null }, "To",
                    mono = true, placeholder = "2026-11-02 18:00",
                )
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    ConsoleButton("Show", {
                        val error = vm.applyCustomRange(readLocal(form.first), readLocal(form.second))
                        if (error == null) custom = null
                        customError = error
                    }, kind = ButtonKind.PRIMARY, small = true)
                    ConsoleButton("Cancel", {
                        custom = null
                        customError = null
                    }, kind = ButtonKind.QUIET, small = true)
                }
                customError?.let { Text(it, Modifier.semantics { }, style = ConsoleType.note, color = colors.bad) }
                Text(
                    "Local times, at most 31 days. You can also drag across the timeline to zoom in.",
                    style = ConsoleType.note,
                    color = colors.ink2,
                )
            }
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
            .padding(horizontal = 12.dp)
            .semantics {
                contentDescription = description
                stateDescription = if (pressed) "Shown" else "Not shown"
            },
        contentAlignment = Alignment.Center,
    ) {
        Text(label, style = ConsoleType.button.copy(fontSize = 13.sp), color = if (pressed) colors.paper else colors.ink)
    }
}

/** Which boards the page is about: all of them, or one. */
@Composable
private fun BoardFilter(vm: ConsoleViewModel, page: EventsPage, devices: List<Device>) {
    val colors = console
    var open by remember { mutableStateOf(false) }
    val things = devices.map { it.thing }.toMutableList()
    if (page.thing.isNotEmpty() && page.thing !in things) things += page.thing
    val choices = boardChoices(things, devices)
    val all = "All boards (${things.size})"
    val current = choices.firstOrNull { it.first == page.thing }?.second ?: all
    Row(
        Modifier.fillMaxWidth().padding(bottom = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("Board", style = ConsoleType.note, color = colors.ink3)
        Box {
            ConsoleButton(current, { open = true }, small = true, glyph = Glyph.CHIP)
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                DropdownMenuItem(
                    text = { Text(all, style = ConsoleType.small) },
                    onClick = {
                        open = false
                        vm.chooseEventBoard("")
                    },
                    leadingIcon = { if (page.thing.isEmpty()) GlyphIcon(Glyph.CHECK) else Spacer(Modifier.width(18.dp)) },
                )
                for ((thing, label) in choices) {
                    DropdownMenuItem(
                        text = { Text(label, style = ConsoleType.mono) },
                        onClick = {
                            open = false
                            vm.chooseEventBoard(thing)
                        },
                        leadingIcon = { if (page.thing == thing) GlyphIcon(Glyph.CHECK) else Spacer(Modifier.width(18.dp)) },
                    )
                }
            }
        }
    }
}

/** The kinds of event shown, each a chip that switches it on or off, and the key to the online band. */
@Composable
private fun KindChips(vm: ConsoleViewModel, hidden: Set<String>, counts: Map<String, Int>) {
    val colors = console
    Wrap(Modifier.fillMaxWidth().semantics { contentDescription = "Kinds of event shown" }) {
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
                val count = counts[kind.id]
                if (on && count != null) {
                    Text(count.toString(), style = ConsoleType.note.copy(fontWeight = FontWeight.SemiBold), color = colors.ink2)
                }
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
    val description = "Timeline of events, $rangeText. One lane per board${if (hasConsole) " and one for the console" else ""}. " +
        "The list below has every event."

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

/** Every event shown on the timeline, newest first, under the day it happened. */
@Composable
private fun EventList(vm: ConsoleViewModel, shown: List<BoardEvent>, selected: String?, devices: List<Device>, now: Long) {
    val colors = console
    var day: String? = null
    Column(Modifier.fillMaxWidth()) {
        for (event in shown) {
            val label = Words.dayLabel(event.at, now)
            if (label != day) {
                day = label
                Text(
                    label,
                    Modifier
                        .fillMaxWidth()
                        .padding(top = 14.dp, bottom = 4.dp)
                        .semantics { heading() },
                    style = ConsoleType.small.copy(fontWeight = FontWeight.Bold),
                    color = colors.ink,
                )
            }
            EventRow(vm, event, Telemetry.eventKey(event) == selected, devices)
        }
    }
}

@Composable
private fun EventRow(vm: ConsoleViewModel, event: BoardEvent, selected: Boolean, devices: List<Device>) {
    val colors = console
    val key = Telemetry.eventKey(event)
    val kind = Telemetry.kindOf(event.kind)
    val board = event.thing?.let { Boards.of(it, devices) }
    Column(
        Modifier
            .fillMaxWidth()
            .drawBehind { drawLine(colors.line, Offset(0f, 0f), Offset(size.width, 0f), 1.dp.toPx()) }
            .background(if (selected) colors.accentWash else Color.Transparent)
            .padding(vertical = 10.dp, horizontal = 4.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(
                Words.timeOfDay(event.at),
                Modifier
                    .clip(RoundedCornerShape(4.dp))
                    .clickable(role = Role.Button, onClickLabel = "Show it on the timeline") { vm.selectEvent(key) }
                    .heightIn(min = 32.dp)
                    .padding(horizontal = 4.dp, vertical = 6.dp)
                    .semantics {
                        contentDescription = "${Words.exactTime(event.at)}. Show it on the timeline."
                        stateDescription = if (selected) "Picked" else "Not picked"
                    },
                style = ConsoleType.note.copy(fontWeight = FontWeight.SemiBold),
                color = colors.ink,
            )
            if (board != null) {
                Text(Boards.name(board), Modifier.weight(1f, fill = false), style = ConsoleType.mono.copy(fontSize = 13.sp), color = colors.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
            } else {
                Text("Console", style = ConsoleType.note, color = colors.ink)
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                KindSwatch(event.kind)
                Text(kind.label, style = ConsoleType.note, color = colors.ink2)
            }
        }
        Text(event.text, style = ConsoleType.small, color = colors.ink)
        if (event.level == "warn" || event.job != null || (event.kind == "console" && event.href != null)) {
            Wrap {
                if (event.level == "warn") Badge(Tone.WARN, Glyph.ALERT, "Warning")
                event.job?.let { job -> MoreLink("Deployment") { vm.open(Route.DeploymentPage(job)) } }
                if (event.kind == "console") {
                    val href = event.href
                    when {
                        href == null -> Unit
                        href.startsWith("deployment:") -> MoreLink("Open") { vm.open(Route.DeploymentPage(href.removePrefix("deployment:"))) }
                        href == "firmware" -> MoreLink("Open") { vm.open(Route.Firmware) }
                    }
                }
            }
        }
    }
}
