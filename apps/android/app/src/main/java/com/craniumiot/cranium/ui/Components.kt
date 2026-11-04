package com.craniumiot.cranium.ui

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.PersistableBundle
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.craniumiot.cranium.core.ApiError
import com.craniumiot.cranium.core.Boards
import com.craniumiot.cranium.core.CountWords
import com.craniumiot.cranium.core.Device
import com.craniumiot.cranium.core.ExecutionWords
import com.craniumiot.cranium.core.Glyph
import com.craniumiot.cranium.core.ImageChecks
import com.craniumiot.cranium.core.Outcomes
import com.craniumiot.cranium.core.StateWords
import com.craniumiot.cranium.core.StepState
import com.craniumiot.cranium.core.Tone
import com.craniumiot.cranium.core.Words
import kotlinx.coroutines.delay

// Text.

private val TECHNICAL = Regex("(\\d+\\.\\d+\\.\\d+\\+\\d+|(?:[\\w-]+/)*(?:[\\w*-]+\\.)?signed\\.bin|cranium-[0-9a-f]{16})")

/** A sentence from the core, with the versions, file names and thing names in it set in the monospace face. */
fun prose(text: String): AnnotatedString = buildAnnotatedString {
    var at = 0
    for (match in TECHNICAL.findAll(text)) {
        append(text.substring(at, match.range.first))
        withStyle(SpanStyle(fontFamily = ConsoleType.Mono, fontSize = 0.92.em)) { append(match.value) }
        at = match.range.last + 1
    }
    append(text.substring(at))
}

@Composable
fun Mono(text: String, modifier: Modifier = Modifier, style: TextStyle = ConsoleType.mono, color: Color = LocalContentColor.current, maxLines: Int = Int.MAX_VALUE) {
    Text(text, modifier, style = style, color = color, maxLines = maxLines, overflow = TextOverflow.Ellipsis)
}

@Composable
fun Eyebrow(text: String, modifier: Modifier = Modifier, color: Color = console.ink3) {
    Text(text.uppercase(), modifier.semantics { heading() }, style = ConsoleType.eyebrow, color = color)
}

@Composable
fun Note(text: String, modifier: Modifier = Modifier, color: Color = console.ink2) {
    Text(prose(text), modifier, style = ConsoleType.note, color = color)
}

@Composable
fun Quiet(text: String, modifier: Modifier = Modifier, style: TextStyle = ConsoleType.small) {
    Text(prose(text), modifier, style = style, color = console.ink3)
}

/** A time, told relative to now. */
fun ago(iso: String?, now: Long, prefix: String = ""): String = if (iso == null) "" else "$prefix${Words.timeAgo(iso, now)}"

/** The same, with the time of day written out, for where the exact moment matters. */
fun agoAt(iso: String?, now: Long, prefix: String = ""): String {
    if (iso == null) return ""
    if (Words.toldByDate(iso, now)) return "$prefix${Words.dateAndTime(iso)}"
    return "$prefix${Words.timeAgo(iso, now)} (${Words.clockTime(iso, now)})"
}

/** The clock of the screen, moved on every second while it is shown. */
@Composable
fun rememberNow(everyMs: Long = 1_000): Long {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(everyMs) {
        while (true) {
            delay(everyMs)
            now = System.currentTimeMillis()
        }
    }
    return now
}

// States.

/** A badge: the tone's wash, its icon and a word (`.badge`). */
@Composable
fun Badge(tone: Tone, glyph: Glyph, label: String, modifier: Modifier = Modifier) {
    val colors = console
    val shape = RoundedCornerShape(4.dp)
    Row(
        modifier
            .clip(shape)
            .background(colors.toneWash(tone))
            .then(if (tone == Tone.IDLE) Modifier.border(1.dp, colors.lineStrong, shape) else Modifier)
            .padding(start = 6.dp, end = 9.dp, top = 2.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        GlyphIcon(glyph, size = 14.dp, tint = if (tone == Tone.WAIT || tone == Tone.IDLE) colors.ink2 else colors.toneInk(tone))
        Text(label, style = ConsoleType.badge, color = if (tone == Tone.IDLE) colors.ink2 else colors.ink, maxLines = 2)
    }
}

@Composable
fun Badge(words: StateWords, modifier: Modifier = Modifier) = Badge(words.tone, words.glyph, words.label, modifier)

/** A small label beside a version or a name (`.tag`). */
@Composable
fun Tag(text: String, modifier: Modifier = Modifier, tone: Tone? = null) {
    val colors = console
    val shape = RoundedCornerShape(4.dp)
    val background = when (tone) {
        Tone.WARN -> colors.warnWash
        Tone.BAD -> colors.badWash
        else -> Color.Transparent
    }
    Text(
        text,
        modifier
            .clip(shape)
            .background(background)
            .then(if (tone == null) Modifier.border(1.dp, colors.lineStrong, shape) else Modifier)
            .padding(horizontal = 8.dp, vertical = 1.dp),
        style = ConsoleType.eyebrow.copy(letterSpacing = 0.sp, fontWeight = FontWeight.Medium),
        color = if (tone == null) colors.ink2 else colors.ink,
        maxLines = 1,
    )
}

/** An icon and a few words for a state (`.status`). */
@Composable
fun StatusLine(tone: Tone, glyph: Glyph, text: String, modifier: Modifier = Modifier, quiet: Boolean = false, trailing: String? = null) {
    val colors = console
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        GlyphIcon(glyph, tint = colors.toneInk(tone))
        Text(
            buildAnnotatedString {
                append(prose(text))
                if (trailing != null) withStyle(SpanStyle(color = colors.ink2, fontWeight = FontWeight.Normal)) { append(" $trailing") }
            },
            style = ConsoleType.body.copy(fontWeight = if (quiet) FontWeight.Normal else FontWeight.SemiBold),
            color = if (quiet) colors.ink2 else colors.ink,
        )
    }
}

@Composable
fun StatusLine(words: StateWords, modifier: Modifier = Modifier) =
    StatusLine(words.tone, words.glyph, words.label, modifier, quiet = words.quiet, trailing = words.progress?.let { "$it%" })

/** A boxed message (`.notice`): bad news, a warning, or something to know. */
@Composable
fun Notice(
    tone: Tone,
    glyph: Glyph,
    said: AnnotatedString,
    modifier: Modifier = Modifier,
    more: String? = null,
    action: (@Composable () -> Unit)? = null,
) {
    val colors = console
    val background = when (tone) {
        Tone.BAD -> colors.badWash
        Tone.WARN -> colors.warnWash
        else -> colors.well
    }
    Row(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(6.dp))
            .background(background)
            .then(if (tone == Tone.BAD || tone == Tone.WARN) Modifier else Modifier.border(1.dp, colors.line, RoundedCornerShape(6.dp)))
            .padding(horizontal = 16.dp, vertical = 13.dp)
            .semantics { liveRegion = if (tone == Tone.BAD) LiveRegionMode.Assertive else LiveRegionMode.Polite },
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        GlyphIcon(glyph, Modifier.padding(top = 2.dp), tint = colors.toneInk(tone))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(said, style = ConsoleType.small, color = colors.ink)
            if (more != null) Text(prose(more), style = ConsoleType.note, color = colors.ink2)
            if (action != null) action()
        }
    }
}

@Composable
fun Notice(tone: Tone, glyph: Glyph, said: String, modifier: Modifier = Modifier, more: String? = null, action: (@Composable () -> Unit)? = null) =
    Notice(tone, glyph, prose(said), modifier, more, action)

/** A lead in bold, then the rest: how a notice usually reads. */
fun lead(strong: String, rest: String): AnnotatedString = buildAnnotatedString {
    withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(strong) }
    append(" ")
    append(prose(rest))
}

/** How to refer to a failed request: the server's code and the request id. */
fun problemRef(error: Throwable?): String? {
    val api = error as? ApiError ?: return null
    val coded = api.status >= 400 && api.code.isNotEmpty() && api.code !in setOf("gateway", "http", "unauthorized")
    val parts = listOfNotNull(if (coded) "Code ${api.code}" else null, api.requestId?.let { "Request $it" })
    return parts.joinToString(" · ").ifEmpty { null }
}

/** The words of a failure: the server's own, unless they are jargon. */
fun messageOf(error: Throwable?): String = when (error) {
    null -> ""
    is ApiError -> Words.sentence(ImageChecks.plainMessage(error))
    else -> Words.sentence(Messages.describe(error))
}

/**
 * A failed action: what did not happen, then the server's own words. Only a refusal says for
 * certain that nothing was done; after anything else it may have gone through all the same.
 */
@Composable
fun Failure(refusal: String, error: Throwable, modifier: Modifier = Modifier, extra: String? = null) {
    val status = (error as? ApiError)?.status ?: 0
    val leadWords = if (Outcomes.isRefusal(status) || error !is ApiError && error !is java.io.IOException) refusal else "It is not certain whether this went through."
    Notice(
        Tone.BAD, Glyph.X_CIRCLE, lead(leadWords, messageOf(error)), modifier,
        more = listOfNotNull(extra, problemRef(error)).joinToString(" ").ifEmpty { null },
    )
}

// Layout.

/** A section of a page: a heavy rule and a heading, no box (`.card`). Inside a panel, a quiet eyebrow (`.is-zone`). */
@Composable
fun Section(
    modifier: Modifier = Modifier,
    title: String? = null,
    more: Pair<String, () -> Unit>? = null,
    zone: Boolean = false,
    content: @Composable ColumnScope.() -> Unit,
) {
    val colors = console
    Column(
        modifier
            .fillMaxWidth()
            .padding(bottom = if (zone) 20.dp else 32.dp)
            .then(
                if (zone) {
                    Modifier
                } else {
                    Modifier.drawBehind { drawLine(colors.rule, Offset(0f, 1.dp.toPx()), Offset(size.width, 1.dp.toPx()), 2.dp.toPx()) }
                },
            )
            .padding(top = if (zone) 0.dp else 12.dp),
    ) {
        if (title != null || more != null) {
            Row(Modifier.fillMaxWidth().padding(bottom = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                if (title != null) {
                    if (zone) {
                        Eyebrow(title, Modifier.weight(1f))
                    } else {
                        Text(title, Modifier.weight(1f).semantics { heading() }, style = ConsoleType.sectionTitle, color = colors.ink)
                    }
                } else {
                    Spacer(Modifier.weight(1f))
                }
                if (more != null) MoreLink(more.first, more.second)
            }
        }
        content()
    }
}

/** "All devices →". */
@Composable
fun MoreLink(label: String, onClick: () -> Unit) {
    Row(
        Modifier
            .clip(RoundedCornerShape(4.dp))
            .clickable(role = Role.Button, onClick = onClick)
            .heightIn(min = 40.dp)
            .padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(label, style = ConsoleType.note.copy(fontWeight = FontWeight.Medium), color = console.ink2)
        GlyphIcon(Glyph.ARROW_RIGHT, size = 14.dp, tint = console.ink2)
    }
}

/** One row of [Facts]: a label, and its value. */
class Fact(val label: String, val value: @Composable ColumnScope.() -> Unit)

/** A label and its value side by side, each row under a hairline (`.facts`). */
@Composable
fun Facts(rows: List<Fact>, modifier: Modifier = Modifier, labelWidth: Dp = 96.dp) {
    val colors = console
    Column(modifier.fillMaxWidth()) {
        for (fact in rows) {
            val label = fact.label
            val value = fact.value
            Row(
                Modifier
                    .fillMaxWidth()
                    .drawBehind { drawLine(colors.line, Offset(0f, 0f), Offset(size.width, 0f), 1.dp.toPx()) }
                    .padding(vertical = 11.dp)
                    .semantics(mergeDescendants = true) {},
                horizontalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Text(label, Modifier.width(labelWidth).padding(top = 2.dp), style = ConsoleType.note, color = colors.ink3)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp), content = value)
            }
        }
    }
}

/** A row of items that wraps, with the gaps of a fact's value. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun Wrap(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    FlowRow(
        modifier,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
        itemVerticalAlignment = Alignment.CenterVertically,
    ) { content() }
}

/** A progress bar of the download or the upload (`.meter`). */
@Composable
fun Meter(percent: Int, label: String, modifier: Modifier = Modifier) {
    val colors = console
    Box(
        modifier
            .fillMaxWidth()
            .widthIn(max = 440.dp)
            .height(8.dp)
            .clip(RoundedCornerShape(2.dp))
            .border(1.dp, colors.lineField, RoundedCornerShape(2.dp))
            .background(colors.workWash)
            .semantics {
                contentDescription = label
                progressBarRangeInfo = ProgressBarRangeInfo(percent / 100f, 0f..1f)
            },
    ) {
        Box(Modifier.fillMaxHeight().fillMaxWidth(percent.coerceIn(0, 100) / 100f).background(colors.barLive))
    }
}

/** One whole split into parts, each as wide as its share, with its amount on it (`.segments`). */
@Composable
fun Segments(parts: List<CountWords>, label: String, modifier: Modifier = Modifier, thin: Boolean = false) {
    val colors = console
    val shown = parts.filter { it.count > 0 }
    Row(
        modifier
            .fillMaxWidth()
            .height(if (thin) 8.dp else 28.dp)
            .clip(RoundedCornerShape(4.dp))
            .clearAndSetSemantics { contentDescription = label },
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        for (part in shown) {
            Box(
                Modifier.weight(part.count.toFloat()).fillMaxHeight().background(colors.toneBar(part.tone)),
                contentAlignment = Alignment.Center,
            ) {
                if (!thin) Text(part.count.toString(), style = ConsoleType.badge, color = colors.onToneBar(part.tone))
            }
        }
    }
}

/** The steps of one board's update (core STEPS), with where it stands. */
@Composable
fun StepList(words: ExecutionWords, modifier: Modifier = Modifier, compact: Boolean = false, viewer: Boolean = false) {
    val colors = console
    val stepIcons = listOf(Glyph.SEND, Glyph.PRESS, Glyph.DOWNLOAD, Glyph.SHIELD, Glyph.RESTART, Glyph.PULSE, Glyph.CHECK_CIRCLE)
    Column(modifier.fillMaxWidth().semantics { contentDescription = "Steps of the update" }, verticalArrangement = Arrangement.spacedBy(if (compact) 2.dp else 6.dp)) {
        words.steps.forEachIndexed { index, step ->
            val current = step.state == StepState.CURRENT
            val (mark, tint, fill) = when (step.state) {
                StepState.DONE -> Triple(Glyph.CHECK, colors.ink, colors.well)
                StepState.CURRENT -> Triple(stepIcons[index], colors.toneInk(words.tone), colors.toneWash(words.tone).takeIf { it != Color.Transparent } ?: colors.well)
                StepState.FAILED -> Triple(
                    when {
                        words.glyph == Glyph.UNDO || words.glyph == Glyph.BAN -> words.glyph
                        words.tone == Tone.WARN -> Glyph.MINUS
                        else -> Glyph.X
                    },
                    colors.toneInk(words.tone), colors.toneWash(words.tone).takeIf { it != Color.Transparent } ?: colors.well,
                )
                StepState.STOPPED, StepState.UNKNOWN -> Triple(Glyph.MINUS, colors.ink2, Color.Transparent)
                else -> Triple(stepIcons[index], colors.ink3, Color.Transparent)
            }
            val stateWord = step.word ?: when (step.state) {
                StepState.DONE -> "done"
                StepState.CURRENT -> when {
                    viewer && words.tone == Tone.ACT -> "waiting for someone"
                    words.tone == Tone.ACT -> "your turn"
                    words.tone == Tone.WAIT -> "waiting"
                    else -> "in progress"
                }
                StepState.FAILED, StepState.STOPPED -> "stopped here"
                StepState.SKIPPED -> "not reached"
                StepState.UPCOMING -> "not started"
                StepState.UNKNOWN -> "not known"
            }
            val downloading = current && index == 2 && words.progress != null
            Row(
                Modifier.fillMaxWidth().semantics(mergeDescendants = true) {},
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Box(
                    Modifier
                        .size(if (compact) 22.dp else 26.dp)
                        .clip(CircleShape)
                        .background(fill)
                        .border(1.dp, if (step.state == StepState.UPCOMING || step.state == StepState.SKIPPED || step.state == StepState.UNKNOWN) colors.line else tint, CircleShape),
                    contentAlignment = Alignment.Center,
                ) { GlyphIcon(mark, size = if (compact) 13.dp else 15.dp, tint = tint) }
                Text(
                    step.label + if (downloading) " ${words.progress}%" else "",
                    Modifier.weight(1f),
                    style = (if (compact) ConsoleType.note else ConsoleType.small).copy(
                        fontWeight = if (current || step.state == StepState.FAILED) FontWeight.SemiBold else FontWeight.Normal,
                    ),
                    color = when (step.state) {
                        StepState.UPCOMING, StepState.SKIPPED, StepState.UNKNOWN -> colors.ink3
                        else -> colors.ink
                    },
                )
                Text(stateWord, style = ConsoleType.note, color = colors.ink3)
            }
        }
    }
}

/** Wi-Fi bars out of four (`.signal`). */
@Composable
fun SignalBars(bars: Int, modifier: Modifier = Modifier, old: Boolean = false) {
    val colors = console
    androidx.compose.foundation.Canvas(modifier.size(width = 22.dp, height = 16.dp).clearAndSetSemantics {}) {
        val unit = size.width / 22f
        for (index in 0 until 4) {
            val height = (5 + index * 3.67f) * unit
            val color = if (index < bars) (if (old) colors.ink3 else colors.ink) else colors.line
            drawRoundRect(
                color,
                topLeft = Offset(index * 6 * unit, size.height - height),
                size = Size(4 * unit, height),
                cornerRadius = CornerRadius(unit, unit),
            )
        }
    }
}

/** A board by what people call it: its own name, and its thing name second, smaller and quieter. */
@Composable
fun BoardName(device: Device, modifier: Modifier = Modifier, style: TextStyle = ConsoleType.mono.copy(fontSize = 15.sp, fontWeight = FontWeight.SemiBold)) {
    Column(modifier) {
        Text(Boards.name(device), style = style, color = console.ink)
        if (Boards.hasOwnName(device)) {
            Text(device.thing, style = ConsoleType.mono.copy(fontSize = 12.sp), color = console.ink3)
        }
    }
}

// Buttons.

enum class ButtonKind { PRIMARY, PLAIN, QUIET, DANGER, DANGER_QUIET }

/** A button of the console (`.btn`): primary is the rust, danger is the bad fill. */
@Composable
fun ConsoleButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    kind: ButtonKind = ButtonKind.PLAIN,
    glyph: Glyph? = null,
    small: Boolean = false,
    enabled: Boolean = true,
    busy: Boolean = false,
) {
    val colors = console
    val shape = RoundedCornerShape(5.dp)
    val usable = enabled && !busy
    val (background, border, content) = when {
        !enabled -> Triple(colors.well, colors.lineStrong, colors.ink3)
        kind == ButtonKind.PRIMARY -> Triple(colors.accent, colors.accent, colors.onAccent)
        kind == ButtonKind.DANGER -> Triple(colors.badFill, colors.badFill, colors.onBadFill)
        kind == ButtonKind.QUIET -> Triple(Color.Transparent, Color.Transparent, colors.ink2)
        else -> Triple(Color.Transparent, colors.lineField, colors.ink)
    }
    Surface(
        onClick = { if (usable) onClick() },
        enabled = enabled,
        modifier = modifier.heightIn(min = if (small) 40.dp else 48.dp).semantics { if (busy) stateDescription = "Working" },
        shape = shape,
        color = background,
        contentColor = content,
        border = BorderStroke(1.dp, border),
    ) {
        Row(
            Modifier.padding(horizontal = if (small) 12.dp else 16.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(7.dp, Alignment.CenterHorizontally),
        ) {
            if (busy) {
                CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = content)
            } else if (glyph != null) {
                GlyphIcon(glyph, size = if (small) 15.dp else 18.dp, tint = if (kind == ButtonKind.DANGER_QUIET && enabled) colors.bad else content)
            }
            Text(text, style = if (small) ConsoleType.button.copy(fontSize = 13.sp) else ConsoleType.button, maxLines = 2)
        }
    }
}

/** A button that copies a value, with what it copies said to a screen reader. */
@Composable
fun CopyButton(value: String, label: String, sensitive: Boolean = false, onCopied: (String) -> Unit = {}) {
    val context = LocalContext.current
    Box(
        Modifier
            .size(40.dp)
            .clip(RoundedCornerShape(5.dp))
            .clickable(role = Role.Button, onClickLabel = "Copy $label") {
                copyToClipboard(context, value, label, sensitive)
                onCopied("Copied $label.")
            }
            .semantics { contentDescription = "Copy $label" },
        contentAlignment = Alignment.Center,
    ) { GlyphIcon(Glyph.COPY, tint = console.ink2) }
}

fun copyToClipboard(context: Context, value: String, label: String, sensitive: Boolean) {
    val clipboard = context.getSystemService(ClipboardManager::class.java) ?: return
    val clip = ClipData.newPlainText(label, value)
    if (sensitive && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        clip.description.extras = PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true) }
    }
    clipboard.setPrimaryClip(clip)
}

// What a page says about its data.

/** Nothing here yet: what that means, and what to do next. */
@Composable
fun EmptyState(glyph: Glyph, title: String, text: String? = null, command: String? = null, action: Pair<String, () -> Unit>? = null) {
    val colors = console
    Column(
        Modifier.fillMaxWidth().padding(vertical = 20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(Modifier.size(48.dp).clip(CircleShape).background(colors.well), contentAlignment = Alignment.Center) {
            GlyphIcon(glyph, size = 24.dp, tint = colors.ink2)
        }
        Text(title, style = ConsoleType.body.copy(fontWeight = FontWeight.SemiBold), color = colors.ink)
        if (text != null) Text(prose(text), style = ConsoleType.small, color = colors.ink2)
        if (command != null) Code(command)
        if (action != null) ConsoleButton(action.first, action.second, small = true)
    }
}

/** A command or a value to copy by hand (`.code`). */
@Composable
fun Code(text: String, modifier: Modifier = Modifier) {
    val colors = console
    Text(
        text,
        modifier
            .clip(RoundedCornerShape(4.dp))
            .background(colors.well)
            .border(1.dp, colors.line, RoundedCornerShape(4.dp))
            .padding(horizontal = 8.dp, vertical = 4.dp),
        style = ConsoleType.mono.copy(fontSize = 13.sp),
        color = colors.ink,
    )
}

@Composable
fun Loading(what: String, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth().padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = console.ink2)
        Text("Loading $what…", style = ConsoleType.small, color = console.ink2)
    }
}

// Forms.

@Composable
fun ConsoleField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    hint: String? = null,
    error: String? = null,
    singleLine: Boolean = true,
    minLines: Int = 1,
    mono: Boolean = false,
    secret: Boolean = false,
    enabled: Boolean = true,
    placeholder: String? = null,
    keyboardType: KeyboardType = KeyboardType.Text,
    maxLength: Int? = null,
) {
    val colors = console
    OutlinedTextField(
        value = value,
        onValueChange = { text -> onValueChange(if (maxLength != null) text.take(maxLength) else text) },
        modifier = modifier.fillMaxWidth(),
        label = { Text(label) },
        placeholder = placeholder?.let { { Text(it, style = if (mono) ConsoleType.mono else ConsoleType.body, color = colors.ink3) } },
        supportingText = if (error != null || hint != null) {
            { Text(error ?: hint!!, color = if (error != null) colors.bad else colors.ink2) }
        } else {
            null
        },
        isError = error != null,
        singleLine = singleLine,
        minLines = minLines,
        enabled = enabled,
        textStyle = if (mono) ConsoleType.mono.copy(fontSize = 15.sp) else ConsoleType.body,
        visualTransformation = if (secret) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = KeyboardOptions(
            keyboardType = if (secret) KeyboardType.Password else keyboardType,
            autoCorrectEnabled = !(mono || secret),
        ),
        shape = RoundedCornerShape(5.dp),
        colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = colors.accent,
            unfocusedBorderColor = colors.lineField,
            focusedLabelColor = colors.accent,
            unfocusedLabelColor = colors.ink2,
            cursorColor = colors.accent,
            focusedContainerColor = colors.surface,
            unfocusedContainerColor = colors.surface,
            errorBorderColor = colors.bad,
            errorLabelColor = colors.bad,
        ),
    )
}

/** A choice of a radio group or a set of boxes, with what it means under it (`.choice`). */
@Composable
fun Choice(
    checked: Boolean,
    onClick: () -> Unit,
    radio: Boolean,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    content: @Composable ColumnScope.() -> Unit,
) {
    val colors = console
    val shape = RoundedCornerShape(6.dp)
    val base = modifier
        .fillMaxWidth()
        .clip(shape)
        .border(1.dp, if (checked) colors.accent else colors.line, shape)
        .background(if (checked) colors.accentWash.copy(alpha = 0.5f) else Color.Transparent)
    val clickable = if (radio) {
        base.selectable(selected = checked, enabled = enabled, role = Role.RadioButton, onClick = onClick)
    } else {
        base.toggleable(value = checked, enabled = enabled, role = Role.Checkbox, onValueChange = { onClick() })
    }
    Row(clickable.padding(12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        if (radio) {
            RadioButton(selected = checked, onClick = null, enabled = enabled, colors = RadioButtonDefaults.colors(selectedColor = colors.accent))
        } else {
            Checkbox(checked = checked, onCheckedChange = null, enabled = enabled, colors = CheckboxDefaults.colors(checkedColor = colors.accent, checkmarkColor = colors.onAccent))
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            CompositionLocalProvider(LocalContentColor provides if (enabled) colors.ink else colors.ink3) { content() }
        }
    }
}

/** A list of what something does, with a mark before each (`.consequences`). */
@Composable
fun Consequences(items: List<AnnotatedString>) {
    val colors = console
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        for (item in items) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(Modifier.padding(top = 8.dp).size(5.dp).clip(CircleShape).background(colors.ink3))
                Text(item, style = ConsoleType.small, color = colors.ink)
            }
        }
    }
}

/**
 * A dialog of the console: a title, a body that scrolls, the server's words on a failure above
 * the buttons, and the buttons. It closes only by its own buttons while a request is on its way.
 */
@Composable
fun ConsoleDialog(
    title: AnnotatedString,
    onClose: () -> Unit,
    busy: Boolean,
    error: (@Composable () -> Unit)? = null,
    /** Only its own buttons close it: it shows something that cannot be shown again. */
    locked: Boolean = false,
    foot: @Composable RowScope.() -> Unit,
    body: @Composable ColumnScope.() -> Unit,
) {
    val colors = console
    Dialog(
        onDismissRequest = { if (!busy && !locked) onClose() },
        properties = DialogProperties(usePlatformDefaultWidth = false, dismissOnBackPress = !busy && !locked, dismissOnClickOutside = false),
    ) {
        Surface(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 24.dp).imePadding(),
            shape = RoundedCornerShape(8.dp),
            color = colors.surface,
            contentColor = colors.ink,
        ) {
            Column {
                Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp, top = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(title, Modifier.weight(1f).semantics { heading() }, style = ConsoleType.sectionTitle.copy(fontSize = 19.sp))
                    Box(
                        Modifier
                            .size(44.dp)
                            .clip(RoundedCornerShape(5.dp))
                            .clickable(enabled = !busy, role = Role.Button, onClickLabel = "Close", onClick = onClose)
                            .semantics { contentDescription = "Close" },
                        contentAlignment = Alignment.Center,
                    ) { GlyphIcon(Glyph.X, tint = colors.ink2) }
                }
                Column(
                    Modifier
                        .weight(1f, fill = false)
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = 20.dp, vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(14.dp),
                    content = body,
                )
                if (error != null) Box(Modifier.padding(horizontal = 20.dp, vertical = 4.dp)) { error() }
                Row(
                    Modifier
                        .fillMaxWidth()
                        .drawBehind { drawLine(colors.line, Offset(0f, 0f), Offset(size.width, 0f), 1.dp.toPx()) }
                        .padding(horizontal = 16.dp, vertical = 12.dp),
                    horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.End),
                    verticalAlignment = Alignment.CenterVertically,
                    content = foot,
                )
            }
        }
    }
}

/** The page's main column on a phone: the gutter of the website. */
val Gutter = 16.dp
