package com.craniumiot.cranium.ui

import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.craniumiot.cranium.core.Glyph

/**
 * The console's icons (views.js ICONS): line drawings on a 24 grid, stroked in the colour of the
 * text beside them. Each is decoration: its meaning is always also given in words.
 */
object Glyphs {
    private fun polyline(points: String): String {
        val numbers = points.trim().split(Regex("\\s+"))
        return numbers.chunked(2).mapIndexed { index, (x, y) -> "${if (index == 0) "M" else "L"}$x $y" }.joinToString("")
    }

    private fun circle(cx: Float, cy: Float, r: Float): String =
        "M${cx - r} ${cy}a$r $r 0 1 0 ${2 * r} 0a$r $r 0 1 0 ${-2 * r} 0"

    private fun rect(x: Float, y: Float, w: Float, h: Float, r: Float): String =
        "M${x + r} ${y}h${w - 2 * r}a$r $r 0 0 1 $r ${r}v${h - 2 * r}a$r $r 0 0 1 ${-r} ${r}h${-(w - 2 * r)}" +
            "a$r $r 0 0 1 ${-r} ${-r}v${-(h - 2 * r)}a$r $r 0 0 1 $r ${-r}z"

    private val RING = circle(12f, 12f, 9f)

    private val SHAPES: Map<Glyph, List<String>> = mapOf(
        Glyph.CHECK to listOf(polyline("5 12.5 10 17.5 19 7")),
        Glyph.CHECK_CIRCLE to listOf(RING, polyline("8 12.4 11 15.4 16.2 9.4")),
        Glyph.X to listOf("M6.5 6.5l11 11M17.5 6.5l-11 11"),
        Glyph.X_CIRCLE to listOf(RING, "M9 9l6 6M15 9l-6 6"),
        Glyph.CLOCK to listOf(RING, polyline("12 7.5 12 12 15 14")),
        Glyph.ALERT to listOf("M12 4.5l8.5 14.5h-17z", "M12 10.5v3.5M12 16.6v.1"),
        Glyph.BAN to listOf(RING, "M5.7 5.7l12.6 12.6"),
        Glyph.MINUS_CIRCLE to listOf(RING, "M8 12h8"),
        Glyph.MINUS to listOf("M6 12h12"),
        Glyph.UNDO to listOf(polyline("8 5 4 9 8 13"), "M4 9h10.5a5.5 5.5 0 0 1 0 11H10"),
        Glyph.DOWNLOAD to listOf("M12 4v11.5M5 20h14", polyline("7 11 12 16 17 11")),
        Glyph.UPLOAD to listOf("M12 16V4.5M5 20h14", polyline("7 9 12 4 17 9")),
        Glyph.RESTART to listOf("M19.5 12a7.5 7.5 0 1 1-2.2-5.3", polyline("19.5 3.5 19.5 7.5 15.5 7.5")),
        Glyph.SHIELD to listOf("M12 3.5l7 2.6v5.4c0 4.2-2.8 7.4-7 9-4.2-1.6-7-4.8-7-9V6.1z", polyline("9 12.2 11.2 14.4 15.2 9.9")),
        Glyph.PULSE to listOf(polyline("3 12 7.5 12 10 6 14 18 16.5 12 21 12")),
        Glyph.PRESS to listOf(RING, circle(12f, 12f, 3.5f)),
        Glyph.STOP to listOf(rect(6.5f, 6.5f, 11f, 11f, 2f)),
        Glyph.HOURGLASS to listOf("M7 4h10M7 20h10M8 4c0 4.5 4 5.5 4 8s-4 3.5-4 8M16 4c0 4.5-4 5.5-4 8s4 3.5 4 8"),
        Glyph.OFFLINE to listOf("M3.5 9.5a12 12 0 0 1 17 0M7 13a7 7 0 0 1 10 0M12 17v.1M5 4l14 16"),
        Glyph.ONLINE to listOf("M3.5 9.5a12 12 0 0 1 17 0M7 13a7 7 0 0 1 10 0M12 17v.1"),
        Glyph.CHIP to listOf(rect(7f, 7f, 10f, 10f, 1.5f), "M10 4v3M14 4v3M10 17v3M14 17v3M4 10h3M4 14h3M17 10h3M17 14h3"),
        Glyph.PACKAGE to listOf("M12 3.5l7.5 4.2v8.6L12 20.5l-7.5-4.2V7.7zM4.5 7.7l7.5 4.3 7.5-4.3M12 12v8.5"),
        Glyph.SEND to listOf("M20.5 3.5L10 14M20.5 3.5l-6.5 17-4-6.5-6.5-4z"),
        Glyph.LIST to listOf("M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5v.1M4.5 12v.1M4.5 17.5v.1"),
        Glyph.USER to listOf(circle(12f, 8.5f, 3.5f), "M5 20a7 7 0 0 1 14 0"),
        Glyph.COPY to listOf(rect(9f, 9f, 11f, 11f, 2f), "M5 15V6a2 2 0 0 1 2-2h8"),
        Glyph.ARROW_RIGHT to listOf("M5 12h14", polyline("13 6 19 12 13 18")),
        Glyph.ARROW_LEFT to listOf("M19 12H5", polyline("11 6 5 12 11 18")),
        Glyph.KEY to listOf(circle(8f, 15.5f, 4f), "M11 12.6l8.5-8.6M15.5 8l3 3"),
        Glyph.LOCK to listOf(rect(5.5f, 11f, 13f, 9f, 2f), "M8.5 11V8a3.5 3.5 0 0 1 7 0v3"),
        Glyph.PLUS to listOf("M12 5.5v13M5.5 12h13"),
        Glyph.SWAP to listOf(polyline("8 4 4 8 8 12"), "M4 8h13", polyline("16 12 20 16 16 20"), "M20 16H7"),
        Glyph.FILE to listOf("M7 3.5h7l4 4v13H7zM14 3.5v4h4"),
        Glyph.SIGN_OUT to listOf("M10 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2H10M9.5 12H20", polyline("16 8 20 12 16 16")),
        // The app's own, in the same hand.
        Glyph.HOME to listOf("M4 19.5v-6.5a8 8 0 0 1 16 0v6.5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z", "M8.5 20.5V13a3.5 3.5 0 0 1 7 0v7.5"),
        Glyph.MORE to listOf("M5.5 12v.1M12 12v.1M18.5 12v.1"),
        Glyph.BLUETOOTH to listOf(polyline("7 7.5 17 16.5 12 21 12 3 17 7.5 7 16.5")),
        Glyph.USB to listOf("M12 3v14", polyline("9 6 12 3 15 6"), "M12 13l-4-2.5V8M12 15.5l4-2.5V10.5", circle(12f, 19f, 2f)),
        Glyph.TERMINAL to listOf(rect(3.5f, 5f, 17f, 14f, 2f), polyline("7.5 10 10 12.5 7.5 15"), "M12.5 15h4"),
        Glyph.SEARCH to listOf(circle(10.5f, 10.5f, 6f), "M15 15l5 5"),
        Glyph.HELP to listOf(RING, "M9.6 9.4a2.5 2.5 0 0 1 4.8 1c0 1.7-2.4 2.1-2.4 3.6M12 17v.1"),
        Glyph.MORE_VERT to listOf("M12 5.5v.1M12 12v.1M12 18.5v.1"),
        Glyph.HISTORY to listOf("M4.5 12a7.5 7.5 0 1 0 2.2-5.3", polyline("4.5 3.5 4.5 7.5 8.5 7.5"), polyline("12 8 12 12 14.5 13.5")),
    )

    private val cache = mutableMapOf<Glyph, ImageVector>()

    fun vector(glyph: Glyph): ImageVector = cache.getOrPut(glyph) {
        val builder = ImageVector.Builder(
            name = glyph.name,
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f,
        )
        for (d in SHAPES[glyph] ?: SHAPES.getValue(Glyph.MINUS)) {
            builder.addPath(
                pathData = addPathNodes(d),
                fill = null,
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 1.75f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            )
        }
        builder.build()
    }
}

/** A decorative icon in the console's hand, 18 dp unless told otherwise. */
@Composable
fun GlyphIcon(glyph: Glyph, modifier: Modifier = Modifier, size: Dp = 18.dp, tint: Color = LocalContentColor.current, description: String? = null) {
    Icon(Glyphs.vector(glyph), contentDescription = description, modifier = modifier.size(size), tint = tint)
}
