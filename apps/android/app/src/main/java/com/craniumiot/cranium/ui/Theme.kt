package com.craniumiot.cranium.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.craniumiot.cranium.core.Tone

/**
 * The console's colours (cloud/web/src/site/assets/app.css), named for what they do and defined
 * for light and for dark: paper, ink and a single rust accent, and the status tones. The ink
 * panel redefines them for what lies inside it.
 */
@Immutable
data class ConsoleColors(
    val paper: Color,
    val surface: Color,
    val well: Color,
    val line: Color,
    val lineStrong: Color,
    val lineField: Color,
    val rule: Color,
    val ink: Color,
    val ink2: Color,
    val ink3: Color,
    val accent: Color,
    val accentStrong: Color,
    val accentWash: Color,
    val onAccent: Color,
    val good: Color,
    val goodWash: Color,
    val warn: Color,
    val warnWash: Color,
    val bad: Color,
    val badWash: Color,
    val work: Color,
    val workWash: Color,
    val badFill: Color,
    val onBadFill: Color,
    val barGood: Color,
    val barLive: Color,
    val barAct: Color,
    val barWait: Color,
    val barBad: Color,
    val barWarn: Color,
    val barIdle: Color,
    val onBar: Color,
    val onBarLive: Color,
    val onBarGood: Color,
    val onBarBad: Color,
    val lineMark: Color,
    val kindA: Color,
    val kindB: Color,
    val kindC: Color,
    val kindQuiet: Color,
    val series: Color,
    val bandOnline: Color,
    val dark: Boolean,
    val onInk: Boolean = false,
) {
    /** The colour of a tone's icon (`.is-good > .icon`). */
    fun toneInk(tone: Tone): Color = when (tone) {
        Tone.GOOD -> good
        Tone.WARN -> warn
        Tone.BAD -> bad
        Tone.LIVE -> work
        Tone.ACT -> accent
        Tone.WAIT, Tone.IDLE -> ink2
    }

    /** The wash behind a badge of a tone (`.badge.is-good`). */
    fun toneWash(tone: Tone): Color = when (tone) {
        Tone.GOOD -> goodWash
        Tone.WARN -> warnWash
        Tone.BAD -> badWash
        Tone.LIVE -> workWash
        Tone.ACT -> accentWash
        Tone.WAIT -> well
        Tone.IDLE -> Color.Transparent
    }

    /** The fill of a bar or a segment of a tone. */
    fun toneBar(tone: Tone): Color = when (tone) {
        Tone.GOOD -> barGood
        Tone.WARN -> barWarn
        Tone.BAD -> barBad
        Tone.LIVE -> barLive
        Tone.ACT -> barAct
        Tone.WAIT -> barWait
        Tone.IDLE -> barIdle
    }

    fun onToneBar(tone: Tone): Color = when (tone) {
        Tone.GOOD -> onBarGood
        Tone.BAD -> onBarBad
        Tone.LIVE -> onBarLive
        Tone.ACT -> onAccent
        else -> onBar
    }

    companion object {
        val Light = ConsoleColors(
            paper = Color(0xFFFAF7F2), surface = Color(0xFFFFFDFA), well = Color(0xFFF4EFE7), line = Color(0xFFE7DFD3),
            lineStrong = Color(0xFFD1C6B6), lineField = Color(0xFF94887A), rule = Color(0xFF1C1814), ink = Color(0xFF1C1814),
            ink2 = Color(0xFF574E45), ink3 = Color(0xFF72675B), accent = Color(0xFFB7410E), accentStrong = Color(0xFF983509),
            accentWash = Color(0xFFF8E8DD), onAccent = Color(0xFFFFFAF5), good = Color(0xFF2D6A3E), goodWash = Color(0xFFE4EFE2),
            warn = Color(0xFF8F5B00), warnWash = Color(0xFFF8ECD0), bad = Color(0xFF9C1C3F), badWash = Color(0xFFF9E3E6),
            work = Color(0xFF1C5C94), workWash = Color(0xFFE2ECF4), badFill = Color(0xFF9C1C3F), onBadFill = Color(0xFFFFFAF7),
            barGood = Color(0xFF3F9A68), barLive = Color(0xFF2A6FA8), barAct = Color(0xFFB7410E), barWait = Color(0xFF8F8478),
            barBad = Color(0xFFA3173D), barWarn = Color(0xFFB8800F), barIdle = Color(0xFF9A8D7E), onBar = Color(0xFF17110C),
            onBarLive = Color(0xFFFFFFFF), onBarGood = Color(0xFF0E1A12), onBarBad = Color(0xFFFFF7F4), lineMark = Color(0xFF8A7E70),
            kindA = Color(0xFF2A78D6), kindB = Color(0xFFEB6834), kindC = Color(0xFF1BAF7A), kindQuiet = Color(0xFF898781),
            series = Color(0xFF2A78D6), bandOnline = Color(0xFFD3E6CF), dark = false,
        )

        val Dark = ConsoleColors(
            paper = Color(0xFF171411), surface = Color(0xFF211D19), well = Color(0xFF2A2520), line = Color(0xFF342E28),
            lineStrong = Color(0xFF4A4239), lineField = Color(0xFF7D7166), rule = Color(0xFF6D6257), ink = Color(0xFFF3EEE7),
            ink2 = Color(0xFFC2B8AC), ink3 = Color(0xFF9C9185), accent = Color(0xFFE2703A), accentStrong = Color(0xFFEE8855),
            accentWash = Color(0xFF3A2418), onAccent = Color(0xFF1A120C), good = Color(0xFF86C794), goodWash = Color(0xFF1F2C21),
            warn = Color(0xFFE2B455), warnWash = Color(0xFF33290F), bad = Color(0xFFFF9D96), badWash = Color(0xFF3A1B20),
            work = Color(0xFF8ABCEA), workWash = Color(0xFF1C2A37), badFill = Color(0xFFB92F52), onBadFill = Color(0xFFFFF6F5),
            barGood = Color(0xFF7FCB99), barLive = Color(0xFF6FAEE6), barAct = Color(0xFFE2703A), barWait = Color(0xFFD9CFC2),
            barBad = Color(0xFFD0324A), barWarn = Color(0xFFE9C468), barIdle = Color(0xFF8A8074), onBar = Color(0xFF17110C),
            onBarLive = Color(0xFF101A24), onBarGood = Color(0xFF0E1A12), onBarBad = Color(0xFFFFF7F4), lineMark = Color(0xFF8A7F72),
            kindA = Color(0xFF3987E5), kindB = Color(0xFFD95926), kindC = Color(0xFF199E70), kindQuiet = Color(0xFF898781),
            series = Color(0xFF3987E5), bandOnline = Color(0xFF263F2A), dark = true,
        )

        /** The ink panel: the colours of the dark theme, on ink. The same panel in both themes. */
        val InkOnLight = Dark.copy(
            paper = Color(0xFF1C1814), surface = Color(0xFF1C1814), well = Color(0xFF2B2520), line = Color(0xFF3A332C),
            lineStrong = Color(0xFF574E44), lineField = Color(0xFF8A7F72), lineMark = Color(0xFF8A7F72), rule = Color(0xFFF7F2EA),
            ink = Color(0xFFF7F2EA), ink2 = Color(0xFFD2C8BB), ink3 = Color(0xFFAB9F92), accent = Color(0xFFEF7A41),
            accentStrong = Color(0xFFF6955F), accentWash = Color(0xFF3E2415), onAccent = Color(0xFF1A120C), good = Color(0xFF8FD4A0),
            goodWash = Color(0xFF1F2E23), warn = Color(0xFFECBF62), warnWash = Color(0xFF372C10), bad = Color(0xFFFF9D96),
            badWash = Color(0xFF431C22), work = Color(0xFF93C3EF), workWash = Color(0xFF1C2A37), barAct = Color(0xFFEF7A41),
            barIdle = Color(0xFF8A7F72), onInk = true,
        )

        /** On a dark page the panel stands one step above the page instead of far below it. */
        val InkOnDark = InkOnLight.copy(
            paper = Color(0xFF28241F), surface = Color(0xFF28241F), well = Color(0xFF332E28), line = Color(0xFF443E36),
            lineStrong = Color(0xFF61574C), lineMark = Color(0xFF938779), ink2 = Color(0xFFD6CCC0), ink3 = Color(0xFFB5A99C),
            good = Color(0xFF97DBA8), warn = Color(0xFFEFC46C), bad = Color(0xFFFFA79C), work = Color(0xFF9CCAF2),
            accentWash = Color(0xFF46291A), goodWash = Color(0xFF243428), warnWash = Color(0xFF3D3214), badWash = Color(0xFF4A2126),
            workWash = Color(0xFF22313F),
        )
    }
}

val LocalConsole = staticCompositionLocalOf { ConsoleColors.Light }

/** The colours of the console in the composition. */
val console: ConsoleColors
    @Composable get() = LocalConsole.current

/** The type: system faces, as on the website, and a monospace face for versions, names and digests. */
object ConsoleType {
    val Mono = FontFamily.Monospace
    val pageTitle = TextStyle(fontSize = 30.sp, lineHeight = 33.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.022).em)
    val sectionTitle = TextStyle(fontSize = 17.sp, lineHeight = 23.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.018).em)
    val body = TextStyle(fontSize = 15.sp, lineHeight = 22.sp)
    val lede = TextStyle(fontSize = 16.sp, lineHeight = 23.sp, letterSpacing = (-0.008).em)
    val small = TextStyle(fontSize = 14.sp, lineHeight = 20.sp)
    val note = TextStyle(fontSize = 13.sp, lineHeight = 19.sp)
    val eyebrow = TextStyle(fontSize = 11.5.sp, lineHeight = 16.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.085.em)
    val badge = TextStyle(fontSize = 12.5.sp, lineHeight = 18.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.003).em)
    val button = TextStyle(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.006).em)
    val figure = TextStyle(fontSize = 40.sp, lineHeight = 44.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.03).em)
    val mono = TextStyle(fontFamily = Mono, fontSize = 14.sp, lineHeight = 20.sp, letterSpacing = (-0.015).em)
}

/**
 * Material 3 with the console's tokens: rust for what asks for action, paper and ink for the
 * rest. Light and dark follow the phone.
 */
@Composable
fun CraniumTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val colors = if (dark) ConsoleColors.Dark else ConsoleColors.Light
    val scheme = if (dark) {
        darkColorScheme(
            primary = colors.accent, onPrimary = colors.onAccent, primaryContainer = colors.accentWash, onPrimaryContainer = colors.ink,
            secondary = colors.ink2, onSecondary = colors.paper, secondaryContainer = colors.well, onSecondaryContainer = colors.ink,
            tertiary = colors.work, onTertiary = colors.paper, tertiaryContainer = colors.workWash, onTertiaryContainer = colors.ink,
            background = colors.paper, onBackground = colors.ink, surface = colors.paper, onSurface = colors.ink,
            surfaceVariant = colors.well, onSurfaceVariant = colors.ink2, surfaceContainer = colors.surface,
            surfaceContainerLow = colors.surface, surfaceContainerHigh = colors.well, surfaceContainerHighest = colors.well,
            surfaceContainerLowest = colors.paper, outline = colors.lineField, outlineVariant = colors.line,
            error = colors.bad, onError = colors.paper, errorContainer = colors.badWash, onErrorContainer = colors.ink,
        )
    } else {
        lightColorScheme(
            primary = colors.accent, onPrimary = colors.onAccent, primaryContainer = colors.accentWash, onPrimaryContainer = colors.ink,
            secondary = colors.ink2, onSecondary = colors.paper, secondaryContainer = colors.well, onSecondaryContainer = colors.ink,
            tertiary = colors.work, onTertiary = colors.paper, tertiaryContainer = colors.workWash, onTertiaryContainer = colors.ink,
            background = colors.paper, onBackground = colors.ink, surface = colors.paper, onSurface = colors.ink,
            surfaceVariant = colors.well, onSurfaceVariant = colors.ink2, surfaceContainer = colors.surface,
            surfaceContainerLow = colors.surface, surfaceContainerHigh = colors.well, surfaceContainerHighest = colors.well,
            surfaceContainerLowest = colors.paper, outline = colors.lineField, outlineVariant = colors.line,
            error = colors.bad, onError = colors.paper, errorContainer = colors.badWash, onErrorContainer = colors.ink,
        )
    }
    val type = Typography(
        bodyLarge = ConsoleType.body,
        bodyMedium = ConsoleType.small,
        bodySmall = ConsoleType.note,
        titleLarge = ConsoleType.pageTitle,
        titleMedium = ConsoleType.sectionTitle,
        labelLarge = ConsoleType.button,
        labelMedium = ConsoleType.badge,
        labelSmall = ConsoleType.eyebrow,
    )
    CompositionLocalProvider(LocalConsole provides colors) {
        MaterialTheme(colorScheme = scheme, typography = type) {
            CompositionLocalProvider(LocalContentColor provides colors.ink, content = content)
        }
    }
}

/**
 * The ink panel: what matters most on a page, in the dark colours on ink, in both themes. On a
 * dark page the heaviest rule says that it stands above the page.
 */
@Composable
fun InkPanel(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    val outer = console
    val ink = if (outer.dark) ConsoleColors.InkOnDark else ConsoleColors.InkOnLight
    CompositionLocalProvider(LocalConsole provides ink, LocalContentColor provides ink.ink) {
        Column(
            modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(6.dp))
                .background(ink.surface)
                .drawBehind {
                    if (outer.dark) drawLine(ink.ink, Offset(0f, 1.5.dp.toPx()), Offset(size.width, 1.5.dp.toPx()), 3.dp.toPx())
                }
                .padding(20.dp),
            content = content,
        )
    }
}
