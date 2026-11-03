package com.craniumiot.cranium.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.craniumiot.cranium.core.Device
import com.craniumiot.cranium.core.Glyph
import com.craniumiot.cranium.core.Samples
import com.craniumiot.cranium.core.Telemetry
import com.craniumiot.cranium.core.Times
import com.craniumiot.cranium.core.Words
import java.util.Locale
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.roundToLong

private const val HOUR_MS = 3_600_000L
private const val MINUTE_MS = 60_000L

/** A board's Wi-Fi signal over the last 24 hours, from its heartbeat (telemetry.js rssiChart). */
@Composable
fun RssiChart(device: Device, samples: Samples, now: Long) {
    val points = Telemetry.pointsOf(samples.samples) { it.rssi }
    val toMs = Times.parse(samples.to) ?: now
    LineChart(
        key = "${device.thing}-rssi",
        title = "Wi-Fi signal, 24 h",
        unit = "dBm (0 is the strongest)",
        axisUnit = "dBm",
        points = points,
        fromMs = toMs - samples.hours * HOUR_MS,
        toMs = toMs,
        yMin = -100.0,
        yMax = -30.0,
        yTicks = listOf(-90.0, -75.0, -60.0, -45.0),
        refs = listOf(-67.0 to "Good", -75.0 to "Fair"),
        format = { value -> "${Words.signed(value.roundToLong())} dBm" },
        tickFormat = { value -> Words.signed(value.roundToLong()) },
        words = { value -> Words.signalQuality(value.roundToLong().toInt())?.label },
        gapMs = Telemetry.gapFor(samples.bucketSeconds),
        describe = "from the heartbeat every 30 seconds",
        emptyText = "No readings in the last 24 hours.",
    )
}

/** A board's free memory over the last 24 hours, from its diagnostics report (telemetry.js heapChart). */
@Composable
fun HeapChart(device: Device, samples: Samples, now: Long) {
    val points = Telemetry.pointsOf(samples.samples) { it.heapFree }
    val toMs = Times.parse(samples.to) ?: now
    val size = device.diag?.heap?.size?.toDouble() ?: max(1024.0, points.maxOfOrNull { it.v } ?: 0.0)
    val step = when {
        size > 64 * 1024 -> 16 * 1024.0
        size > 16 * 1024 -> 8 * 1024.0
        else -> 2 * 1024.0
    }
    val ticks = generateSequence(0.0) { it + step }.takeWhile { it <= size }.toList()
    LineChart(
        key = "${device.thing}-heap",
        title = "Free memory, 24 h",
        unit = "KiB of the system heap",
        axisUnit = "KiB",
        points = points,
        fromMs = toMs - samples.hours * HOUR_MS,
        toMs = toMs,
        yMin = 0.0,
        yMax = size,
        yTicks = ticks,
        refs = listOf(size * Telemetry.LOW_HEAP_SHARE to "Low"),
        format = { value -> String.format(Locale.ROOT, "%.1f KiB", value / 1024) },
        tickFormat = { value -> (value / 1024).roundToLong().toString() },
        words = null,
        gapMs = max(Telemetry.gapFor(samples.bucketSeconds), 11 * MINUTE_MS),
        describe = "from the diagnostics report every 5 minutes, of ${Words.fileSize(size.roundToLong())} in all",
        emptyText = if (device.diag != null) "No readings in the last 24 hours." else Telemetry.diagMissing(device),
    )
}

/** The index of the point nearest a time. */
private fun nearest(points: List<Telemetry.Point>, ms: Long): Int {
    var best = 0
    for (index in 1 until points.size) {
        if (abs(points[index].ms - ms) < abs(points[best].ms - ms)) best = index
    }
    return best
}

/**
 * A line chart of one series over time: one axis, a 2 dp line with a faint wash below, a hairline
 * grid, the latest value at the end, and a readout that follows a tap or a drag. The table under it
 * has every hour, for whoever does not read charts.
 */
@Composable
private fun LineChart(
    key: String,
    title: String,
    unit: String,
    axisUnit: String,
    points: List<Telemetry.Point>,
    fromMs: Long,
    toMs: Long,
    yMin: Double,
    yMax: Double,
    yTicks: List<Double>,
    refs: List<Pair<Double, String>>,
    format: (Double) -> String,
    tickFormat: (Double) -> String,
    words: ((Double) -> String?)?,
    gapMs: Long,
    describe: String,
    emptyText: String,
) {
    val colors = console
    val measurer = rememberTextMeasurer()
    val fontScale = LocalDensity.current.fontScale.coerceAtLeast(1f)
    var read by remember(key) { mutableStateOf<Int?>(null) }
    var tableOpen by remember(key) { mutableStateOf(false) }

    val latest = points.lastOrNull()
    val summary = if (latest != null) {
        "Now ${format(latest.v)} · lowest ${format(points.minOf { it.v })} · highest ${format(points.maxOf { it.v })}"
    } else {
        emptyText
    }
    val span = (toMs - fromMs).coerceAtLeast(1)
    val ticks = Telemetry.timeTicks(fromMs, toMs, 4)
    val runs = Telemetry.lineRuns(points, gapMs)
    val readPoint = read?.let { points.getOrNull(it.coerceIn(0, (points.size - 1).coerceAtLeast(0))) }

    Column(Modifier.fillMaxWidth().padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title, Modifier.semantics { heading() }, style = ConsoleType.small.copy(fontWeight = FontWeight.SemiBold), color = colors.ink)
        Text(prose(summary), style = ConsoleType.note, color = colors.ink2)
        if (readPoint != null) {
            // The readout in words, under the chart's head, for a reader who cannot see the tip.
            Text(
                listOfNotNull(format(readPoint.v), words?.invoke(readPoint.v), Words.clockTime(Times.iso(readPoint.ms), toMs)).joinToString(" · "),
                style = ConsoleType.note.copy(fontWeight = FontWeight.SemiBold),
                color = colors.ink,
            )
        }
        val labelStyle = TextStyle(fontSize = 11.sp, color = colors.ink3)
        val plotHeight = 160.dp
        val topPad = (14 * fontScale).dp
        val bottomPad = (20 * fontScale).dp
        val leftPad = (34 * fontScale).dp
        Canvas(
            Modifier
                .fillMaxWidth()
                .height(plotHeight + topPad + bottomPad)
                .semantics {
                    contentDescription = "$title, $describe. $summary." +
                        if (points.isNotEmpty()) " Tap or drag along the chart to read a value; the table below has every hour." else ""
                }
                .pointerInput(points, fromMs, toMs) {
                    if (points.isEmpty()) return@pointerInput
                    val left = leftPad.toPx()
                    fun pick(x: Float) {
                        val width = (size.width - left).coerceAtLeast(1f)
                        val fraction = ((x - left) / width).coerceIn(0f, 1f)
                        read = nearest(points, fromMs + (fraction * span).toLong())
                    }
                    detectTapGestures(onTap = { pick(it.x) })
                }
                .pointerInput(points, fromMs, toMs) {
                    if (points.isEmpty()) return@pointerInput
                    val left = leftPad.toPx()
                    fun pick(x: Float) {
                        val width = (size.width - left).coerceAtLeast(1f)
                        val fraction = ((x - left) / width).coerceIn(0f, 1f)
                        read = nearest(points, fromMs + (fraction * span).toLong())
                    }
                    detectHorizontalDragGestures(
                        onDragStart = { pick(it.x) },
                        onHorizontalDrag = { change, _ ->
                            change.consume()
                            pick(change.position.x)
                        },
                    )
                },
        ) {
            val left = leftPad.toPx()
            val top = topPad.toPx()
            val plotH = plotHeight.toPx()
            val plotW = (size.width - left).coerceAtLeast(1f)
            val bottom = top + plotH
            fun x(ms: Long): Float = left + Telemetry.place(ms, fromMs, toMs) * plotW
            fun y(v: Double): Float {
                val clamped = v.coerceIn(yMin, yMax)
                val share = if (yMax > yMin) (clamped - yMin) / (yMax - yMin) else 0.0
                return (bottom - share * plotH).toFloat()
            }

            // The unit above the axis, the grid and its labels.
            val unitLayout = measurer.measure(axisUnit, style = labelStyle)
            drawText(unitLayout, topLeft = Offset(0f, 0f))
            for (tick in yTicks) {
                val at = y(tick)
                drawLine(colors.line, Offset(left, at), Offset(left + plotW, at), 1.dp.toPx())
                val label = measurer.measure(tickFormat(tick), style = labelStyle)
                drawText(label, topLeft = Offset((left - 6.dp.toPx() - label.size.width).coerceAtLeast(0f), at - label.size.height / 2f))
            }
            // The reference lines: what the readings are compared with.
            for ((value, name) in refs) {
                val at = y(value)
                drawLine(
                    colors.lineMark, Offset(left, at), Offset(left + plotW, at), 1.dp.toPx(),
                    pathEffect = PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 3.dp.toPx())),
                )
                val label = measurer.measure(name, style = labelStyle.copy(color = colors.ink2))
                drawText(label, topLeft = Offset(left + plotW - label.size.width - 2.dp.toPx(), at - label.size.height - 1.dp.toPx()))
            }
            // The time axis.
            for (tick in ticks) {
                val at = x(tick.ms)
                drawLine(colors.line, Offset(at, bottom), Offset(at, bottom + 4.dp.toPx()), 1.dp.toPx())
                val label = measurer.measure(tick.label, style = labelStyle)
                val placeAt = Telemetry.place(tick.ms, fromMs, toMs)
                val start = when {
                    placeAt < 0.08f -> at
                    placeAt > 0.92f -> at - label.size.width
                    else -> at - label.size.width / 2f
                }
                drawText(label, topLeft = Offset(start.coerceIn(left, (size.width - label.size.width).coerceAtLeast(left)), bottom + 5.dp.toPx()))
            }

            if (points.isEmpty()) {
                val words = measurer.measure(
                    emptyText,
                    style = TextStyle(fontSize = 13.sp, color = colors.ink3, textAlign = TextAlign.Center),
                    constraints = androidx.compose.ui.unit.Constraints(maxWidth = plotW.toInt().coerceAtLeast(1)),
                )
                drawText(words, topLeft = Offset(left + (plotW - words.size.width) / 2f, top + (plotH - words.size.height) / 2f))
                return@Canvas
            }

            // The wash below the line, then the line, broken where the board was not reporting.
            for (run in runs) {
                if (run.size < 2) continue
                val area = Path().apply {
                    moveTo(x(run.first().ms), bottom)
                    for (point in run) lineTo(x(point.ms), y(point.v))
                    lineTo(x(run.last().ms), bottom)
                    close()
                }
                drawPath(area, colors.series.copy(alpha = 0.12f))
            }
            for (run in runs) {
                if (run.size == 1) {
                    val at = Offset(x(run[0].ms), y(run[0].v))
                    drawLine(colors.series, at - Offset(2.dp.toPx(), 0f), at + Offset(2.dp.toPx(), 0f), 2.dp.toPx(), cap = StrokeCap.Round)
                    continue
                }
                val line = Path().apply {
                    run.forEachIndexed { index, point ->
                        if (index == 0) moveTo(x(point.ms), y(point.v)) else lineTo(x(point.ms), y(point.v))
                    }
                }
                drawPath(line, colors.series, style = Stroke(width = 2.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
            }

            // The latest value, at the end.
            val end = Offset(x(latest!!.ms), y(latest.v))
            drawCircle(colors.surface, 5.dp.toPx(), end)
            drawCircle(colors.series, 3.5.dp.toPx(), end)

            // The readout: a crosshair, a dot, and the value with its time.
            if (readPoint != null) {
                val at = x(readPoint.ms)
                drawLine(colors.ink3, Offset(at, top), Offset(at, bottom), 1.dp.toPx())
                val dot = Offset(at, y(readPoint.v))
                drawCircle(colors.surface, 5.dp.toPx(), dot)
                drawCircle(colors.ink, 3.5.dp.toPx(), dot)
                val tip = listOfNotNull(format(readPoint.v), words?.invoke(readPoint.v), Words.clockTime(Times.iso(readPoint.ms), toMs))
                    .joinToString(" · ")
                val layout = measurer.measure(tip, style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = colors.ink))
                val pad = 6.dp.toPx()
                val boxW = layout.size.width + 2 * pad
                val boxH = layout.size.height + 2 * pad
                val boxX = if (Telemetry.place(readPoint.ms, fromMs, toMs) > 0.6f) at - boxW - 8.dp.toPx() else at + 8.dp.toPx()
                val boxLeft = boxX.coerceIn(left, (size.width - boxW).coerceAtLeast(left))
                val boxTop = top
                drawRoundRect(
                    colors.surface, topLeft = Offset(boxLeft, boxTop), size = Size(boxW, boxH),
                    cornerRadius = androidx.compose.ui.geometry.CornerRadius(4.dp.toPx(), 4.dp.toPx()),
                )
                drawRoundRect(
                    colors.lineStrong, topLeft = Offset(boxLeft, boxTop), size = Size(boxW, boxH),
                    cornerRadius = androidx.compose.ui.geometry.CornerRadius(4.dp.toPx(), 4.dp.toPx()),
                    style = Stroke(width = 1.dp.toPx()),
                )
                drawText(layout, topLeft = Offset(boxLeft + pad, boxTop + pad))
            }
        }

        if (points.isNotEmpty()) {
            val tableTitle = "$title by the hour, as a table"
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 44.dp)
                    .clickable(role = Role.Button, onClickLabel = if (tableOpen) "Hide the table" else "Show the table") { tableOpen = !tableOpen }
                    .semantics { stateDescription = if (tableOpen) "Shown" else "Hidden" },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                GlyphIcon(if (tableOpen) Glyph.MINUS else Glyph.PLUS, size = 16.dp, tint = colors.ink2)
                Text(tableTitle, style = ConsoleType.note.copy(fontWeight = FontWeight.Medium), color = colors.ink2)
            }
            if (tableOpen) HourTable(points, toMs, format, unit)
        }
    }
}

/** The readings of each hour: lowest, mean and highest, newest hour first. */
@Composable
private fun HourTable(points: List<Telemetry.Point>, toMs: Long, format: (Double) -> String, unit: String) {
    val colors = console
    val rows = Telemetry.hourlyRows(points)
    val head = ConsoleType.note.copy(fontWeight = FontWeight.SemiBold)
    val cell = ConsoleType.note
    Column(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("Hour", Modifier.weight(1.2f), style = head, color = colors.ink3)
            Text("Lowest", Modifier.weight(1f), style = head, color = colors.ink3)
            Text("Mean", Modifier.weight(1f), style = head, color = colors.ink3)
            Text("Highest", Modifier.weight(1f), style = head, color = colors.ink3)
            Text("Readings", Modifier.weight(0.8f), style = head, color = colors.ink3, textAlign = TextAlign.End)
        }
        for (row in rows) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .drawBehind { drawLine(colors.line, Offset(0f, 0f), Offset(size.width, 0f), 1.dp.toPx()) }
                    .padding(vertical = 6.dp)
                    .semantics(mergeDescendants = true) {},
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(Words.clockTime(Times.iso(row.ms), toMs), Modifier.weight(1.2f), style = cell.copy(fontWeight = FontWeight.Medium), color = colors.ink)
                Text(format(row.low), Modifier.weight(1f), style = cell, color = colors.ink)
                Text(format(row.mean), Modifier.weight(1f), style = cell, color = colors.ink)
                Text(format(row.high), Modifier.weight(1f), style = cell, color = colors.ink)
                Text(row.count.toString(), Modifier.weight(0.8f), style = cell, color = colors.ink, textAlign = TextAlign.End)
            }
        }
        Text("In $unit. Each reading is one report of the board.", Modifier.padding(top = 6.dp), style = ConsoleType.note, color = colors.ink2)
    }
}
