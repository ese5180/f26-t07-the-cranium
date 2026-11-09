package com.craniumiot.cranium.shell

import android.os.Handler
import android.os.Looper
import androidx.activity.compose.BackHandler
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.craniumiot.cranium.core.QrFrames
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Scan board (bridge.json `camera.scan`; docs/mobile-apps.md "Scan board"): the camera full screen until it
 * reads one QR code, then [onResult] with its text, or null when the person closes it. The camera runs only
 * while this is on screen, which is only after the person tapped Scan board; what the code says is checked
 * by BoardLink before the page hears of it.
 */
@Composable
fun BoardScanner(onResult: (String?) -> Unit) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val finished = remember { AtomicBoolean(false) }
    val main = remember { Handler(Looper.getMainLooper()) }
    val finish: (String?) -> Unit = { text -> if (finished.compareAndSet(false, true)) main.post { onResult(text) } }
    val analysing = remember { Executors.newSingleThreadExecutor() }
    val provider = remember { ProcessCameraProvider.getInstance(context) }

    DisposableEffect(Unit) {
        onDispose {
            // The camera stops with the screen, whatever closed it.
            if (provider.isDone) runCatching { provider.get().unbindAll() }
            analysing.shutdown()
        }
    }

    Dialog(
        onDismissRequest = { finish(null) },
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        BackHandler { finish(null) }
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            AndroidView(
                factory = { viewContext ->
                    val view = PreviewView(viewContext)
                    provider.addListener({
                        val cameras = runCatching { provider.get() }.getOrNull()
                        if (cameras == null) {
                            finish(null)
                            return@addListener
                        }
                        val preview = Preview.Builder().build().also { it.setSurfaceProvider(view.surfaceProvider) }
                        val analysis = ImageAnalysis.Builder()
                            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                            .build()
                        analysis.setAnalyzer(analysing) { frame -> read(frame)?.let(finish) }
                        try {
                            cameras.unbindAll()
                            cameras.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                        } catch (e: IllegalArgumentException) {
                            finish(null)
                        } catch (e: IllegalStateException) {
                            finish(null)
                        }
                    }, ContextCompat.getMainExecutor(viewContext))
                    view
                },
                modifier = Modifier.fillMaxSize(),
            )
            Text(
                "Point the camera at the board’s label.",
                color = Color.White,
                modifier = Modifier.align(Alignment.TopCenter).systemBarsPadding().padding(16.dp),
            )
            TextButton(
                onClick = { finish(null) },
                modifier = Modifier.align(Alignment.BottomCenter).systemBarsPadding().padding(24.dp),
            ) { Text("Cancel", color = Color.White) }
        }
    }
}

/** The QR code in a frame, from its brightness plane; the frame is closed either way. */
private fun read(frame: ImageProxy): String? = frame.use {
    val plane = it.planes.firstOrNull() ?: return@use null
    val buffer = plane.buffer
    val bytes = ByteArray(buffer.remaining())
    buffer.get(bytes)
    QrFrames.read(bytes, it.width, it.height, plane.rowStride)
}
