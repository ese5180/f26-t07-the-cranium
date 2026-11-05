package com.craniumiot.cranium.update

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import com.craniumiot.cranium.core.Glyph
import com.craniumiot.cranium.core.Tone
import com.craniumiot.cranium.ui.ButtonKind
import com.craniumiot.cranium.ui.ConsoleButton
import com.craniumiot.cranium.ui.ConsoleType
import com.craniumiot.cranium.ui.GlyphIcon
import com.craniumiot.cranium.ui.Gutter
import com.craniumiot.cranium.ui.Meter
import com.craniumiot.cranium.ui.console
import com.craniumiot.cranium.ui.prose

/**
 * The console's pages with, above them, "Update available" while a newer version of the app is
 * on the console, or once, on Android 13 and later, the question whether it may say so in a
 * notification. The banner sits under the status bar, so the page below does not leave room for
 * it again.
 */
@Composable
fun AppUpdateFrame(updater: AppUpdater, content: @Composable () -> Unit) {
    val ui by updater.ui.collectAsStateWithLifecycle()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(updater) { lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) { updater.resumed() } }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        updater.notificationsAnswered(granted)
    }
    val update = ui.shown
    val ask = !update && ui.askNotifications && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
    Column(Modifier.fillMaxSize()) {
        if (update) {
            UpdateBanner(ui, onInstall = updater::install, onLater = updater::dismiss)
        } else if (ask) {
            NotificationQuestion(
                onAllow = {
                    updater.askedForNotifications()
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) permission.launch(Manifest.permission.POST_NOTIFICATIONS)
                },
                onNotNow = updater::askedForNotifications,
            )
        }
        val below = if (update || ask) Modifier.consumeWindowInsets(WindowInsets.statusBars) else Modifier
        Box(Modifier.weight(1f).fillMaxWidth().then(below)) { content() }
    }
}

/** "Update available: 0.6.0 — what is new". Tapping it anywhere starts the update. */
@Composable
private fun UpdateBanner(ui: AppUpdateUi, onInstall: () -> Unit, onLater: () -> Unit) {
    val release = ui.release ?: return
    val colors = console
    val failed = ui.step == UpdateStep.FAILED
    val tone = if (failed) Tone.BAD else Tone.ACT
    val action = when (ui.step) {
        UpdateStep.OFFERED -> "Install"
        UpdateStep.LINKING, UpdateStep.DOWNLOADING -> "Downloading"
        UpdateStep.ALLOW -> "Allow installs"
        UpdateStep.INSTALLER -> "Install"
        UpdateStep.FAILED -> "Try again"
    }
    BannerFrame(
        modifier = Modifier.clickable(enabled = !ui.busy, role = Role.Button, onClickLabel = "Install ${release.version}") { onInstall() },
        glyph = if (failed) Glyph.X_CIRCLE else Glyph.DOWNLOAD,
        tone = tone,
    ) {
        Text(
            AppUpdates.headline(release),
            style = ConsoleType.small.copy(fontWeight = FontWeight.SemiBold),
            color = colors.ink,
            maxLines = 3,
            overflow = TextOverflow.Ellipsis,
        )
        // What went wrong, or what to do next, is read out when it changes; the percent is not.
        ui.line?.let {
            Text(
                prose(it),
                Modifier.semantics { liveRegion = if (failed) LiveRegionMode.Assertive else LiveRegionMode.Polite },
                style = ConsoleType.note,
                color = if (failed) colors.ink else colors.ink2,
            )
        }
        if (ui.step == UpdateStep.DOWNLOADING) {
            val percent = ui.percent ?: 0
            Meter(percent, "Downloading ${release.version}: $percent%", Modifier.padding(top = 4.dp))
        }
        Row(Modifier.padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ConsoleButton(
                if (ui.step == UpdateStep.DOWNLOADING && ui.percent != null) "$action ${ui.percent}%" else action,
                onInstall,
                kind = ButtonKind.PRIMARY,
                small = true,
                busy = ui.busy,
            )
            if (!ui.busy) ConsoleButton("Later", onLater, kind = ButtonKind.QUIET, small = true)
        }
    }
}

/** The one question, asked once: Android's own dialog comes only after "Allow notifications". */
@Composable
private fun NotificationQuestion(onAllow: () -> Unit, onNotNow: () -> Unit) {
    BannerFrame(glyph = Glyph.BELL, tone = Tone.IDLE) {
        Text(
            "Get a notification when a new version of Cranium is out?",
            style = ConsoleType.small.copy(fontWeight = FontWeight.SemiBold),
            color = console.ink,
        )
        Row(Modifier.padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ConsoleButton("Allow notifications", onAllow, kind = ButtonKind.PLAIN, small = true)
            ConsoleButton("Not now", onNotNow, kind = ButtonKind.QUIET, small = true)
        }
    }
}

@Composable
private fun BannerFrame(
    glyph: Glyph,
    tone: Tone,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val colors = console
    Column(Modifier.fillMaxWidth().background(colors.surface)) {
        Row(
            Modifier
                .fillMaxWidth()
                .windowInsetsPadding(WindowInsets.statusBars)
                .then(modifier)
                .padding(horizontal = Gutter, vertical = 10.dp),
            verticalAlignment = Alignment.Top,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            GlyphIcon(glyph, Modifier.padding(top = 2.dp), tint = colors.toneInk(tone))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) { content() }
        }
        HorizontalDivider(color = colors.line)
    }
}
