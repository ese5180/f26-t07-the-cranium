package com.craniumiot.cranium.shell

import android.app.Activity
import android.content.ActivityNotFoundException
import android.net.Uri
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.craniumiot.cranium.BuildConfig
import com.craniumiot.cranium.core.CustomerText
import com.craniumiot.cranium.core.FingerprintWords
import com.craniumiot.cranium.ui.ConsoleType
import com.craniumiot.cranium.ui.console
import com.craniumiot.cranium.update.AppUpdateFrame

/**
 * The new app on screen: the update banner of the app's own APK updates over the web view, as in the
 * classic app, and what the shell asks of the person natively: the Bluetooth permissions, the offer of
 * fingerprint unlock, a file for an upload, and the shell's settings.
 */
@Composable
fun ShellScreen(vm: ShellViewModel, onClassic: () -> Unit) {
    val start by vm.start.collectAsStateWithLifecycle()
    val generation by vm.generation.collectAsStateWithLifecycle()
    val colors = console

    // The Bluetooth permissions, when ble.* first needs them.
    val asked by vm.permissions.pending.collectAsStateWithLifecycle()
    val permissions = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        asked?.let { vm.permissions.answer(it.id, granted.isNotEmpty() && granted.values.all { yes -> yes }) }
    }
    LaunchedEffect(asked?.id) {
        val pending = asked ?: return@LaunchedEffect
        try {
            permissions.launch(pending.question)
        } catch (e: ActivityNotFoundException) {
            vm.permissions.answer(pending.id, false)
        }
    }

    // A file for <input type=file>: the console's firmware upload.
    var fileCallback by remember { mutableStateOf<ValueCallback<Array<Uri>>?>(null) }
    val files = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val callback = fileCallback
        fileCallback = null
        callback?.onReceiveValue(
            if (result.resultCode == Activity.RESULT_OK) WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data) else null,
        )
    }
    val chooseFiles: (WebChromeClient.FileChooserParams, ValueCallback<Array<Uri>>) -> Unit = { params, callback ->
        fileCallback?.onReceiveValue(null)
        fileCallback = callback
        try {
            files.launch(params.createIntent())
        } catch (e: ActivityNotFoundException) {
            fileCallback = null
            callback.onReceiveValue(null)
        }
    }

    AppUpdateFrame(vm.updater) {
        Box(Modifier.fillMaxSize().background(colors.paper).systemBarsPadding().imePadding()) {
            when (start) {
                is ShellStart.Ready -> key(generation) {
                    AndroidView(
                        factory = { context -> shellWebView(context, vm, chooseFiles) },
                        modifier = Modifier.fillMaxSize(),
                        onRelease = { web: WebView ->
                            vm.detach(web)
                            web.destroy()
                        },
                    )
                }
                else -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = colors.accent) }
            }
        }
    }

    // The offer of fingerprint unlock, after a full sign-in, once (BiometricPolicy.offer).
    val offer by vm.offers.pending.collectAsStateWithLifecycle()
    offer?.let { pending ->
        val customer = pending.question
        AlertDialog(
            onDismissRequest = { vm.offers.answer(pending.id, false) },
            title = { Text(FingerprintWords.OFFER_TITLE) },
            text = { Text(if (customer) CustomerText.FINGERPRINT_OFFER else FingerprintWords.OFFER_TEXT) },
            confirmButton = { TextButton(onClick = { vm.offers.answer(pending.id, true) }) { Text("Use fingerprint") } },
            dismissButton = { TextButton(onClick = { vm.offers.answer(pending.id, false) }) { Text("Not now") } },
        )
    }

    val settingsOpen by vm.settingsOpen.collectAsStateWithLifecycle()
    if (settingsOpen) ShellSettings(vm, onClassic)
}

/** In the classic app: the way back to the new one ("Use the new app"), or null in the new app itself. */
val LocalNewApp = staticCompositionLocalOf<(() -> Unit)?> { null }

/** The classic app's line at the foot when the new app could not run, until it is dismissed. */
@Composable
fun ClassicNotice(line: String, onDismiss: () -> Unit) {
    val colors = console
    Box(Modifier.fillMaxSize().systemBarsPadding().padding(12.dp), contentAlignment = Alignment.BottomCenter) {
        Column(
            Modifier.fillMaxWidth().background(colors.well).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(line, style = ConsoleType.small, color = colors.ink)
            TextButton(onClick = onDismiss) { Text("OK") }
        }
    }
}

/** app.settings: the versions, a look for newer pages, and the classic app. */
@Composable
private fun ShellSettings(vm: ShellViewModel, onClassic: () -> Unit) {
    val lastCheck by vm.lastCheck.collectAsStateWithLifecycle()
    val bundle = vm.launched
    var classic by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = vm::closeSettings,
        title = { Text("This app") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("App ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})", style = ConsoleType.small)
                Text(
                    if (bundle == null) {
                        "No pages loaded."
                    } else {
                        "Pages ${bundle.manifest.id}, console ${bundle.manifest.consoleVersion ?: "unknown"}, " +
                            if (bundle.source == BundleSource.BUILT_IN) "built into the app" else "from the console"
                    },
                    style = ConsoleType.small,
                )
                Text(
                    "The pages update from the console by themselves, on any network; only this app around them needs an " +
                        "install for an update.",
                    style = ConsoleType.note,
                )
                lastCheck?.let { Text(it, style = ConsoleType.note) }
                TextButton(onClick = { vm.checkForBundle(force = true) }) { Text("Look for newer pages now") }
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f).padding(end = 12.dp)) {
                        Text("Classic app", style = ConsoleType.small.copy(fontWeight = FontWeight.SemiBold))
                        Text("The app's own screens of version 0.7, for this version only.", style = ConsoleType.note)
                    }
                    Switch(checked = classic, onCheckedChange = { on ->
                        classic = on
                        if (on) {
                            vm.closeSettings()
                            onClassic()
                        }
                    })
                }
            }
        },
        confirmButton = { TextButton(onClick = vm::closeSettings) { Text("Done") } },
    )
}
