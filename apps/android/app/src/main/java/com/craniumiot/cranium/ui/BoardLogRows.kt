package com.craniumiot.cranium.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.craniumiot.cranium.core.BoardLine
import com.craniumiot.cranium.core.BoardLog
import com.craniumiot.cranium.core.Boards
import com.craniumiot.cranium.core.Device
import com.craniumiot.cranium.core.Glyph
import com.craniumiot.cranium.core.Telemetry
import com.craniumiot.cranium.core.Tone
import com.craniumiot.cranium.core.Words

/**
 * One line of a board's own log (telemetry.js lineRow): its text as the board printed it, then its
 * time to the second, its board, its source and kind; a warning badge, and the lines lost before
 * it. A tap shows where it stands in the board's boots and its exact time.
 */
@Composable
fun BoardLineRow(line: BoardLine, devices: List<Device>?, showsBoard: Boolean = true) {
    var open by rememberSaveable(line.key) { mutableStateOf(false) }
    val kind = Telemetry.kindOf(line.kind)
    val facts = listOfNotNull(
        BoardLog.secondOfDay(line.at),
        if (showsBoard) Boards.name(Boards.of(line.thing, devices)) else null,
        "${line.tag}, ${kind.label.lowercase()}",
        line.dropped?.let(BoardLog::dropped),
    )
    val more = if (open) listOfNotNull(BoardLog.place(line), Words.exactTime(line.at)) else emptyList()
    ListRow(
        headline = line.text,
        supporting = (facts + more).joinToString(" · "),
        mono = true,
        leading = { Box(Modifier.padding(top = 2.dp)) { KindSwatch(line.kind) } },
        trailing = if (line.warn) ({ Badge(Tone.WARN, Glyph.ALERT, "Warning") }) else null,
        onClick = { open = !open },
        chevron = false,
    )
}
