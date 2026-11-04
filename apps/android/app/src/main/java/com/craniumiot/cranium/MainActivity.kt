package com.craniumiot.cranium

import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.view.WindowManager
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.craniumiot.cranium.core.PromptErrors
import com.craniumiot.cranium.core.PromptResult
import com.craniumiot.cranium.ui.ConsoleViewModel
import com.craniumiot.cranium.ui.CraniumApp
import com.craniumiot.cranium.ui.CraniumTheme
import com.craniumiot.cranium.ui.PromptRequest
import com.craniumiot.cranium.ui.WindowGuard
import kotlinx.coroutines.launch

/**
 * The one activity. A FragmentActivity because BiometricPrompt needs one; the prompt is made here,
 * in onCreate, so that it survives a rotation and its answer still arrives.
 */
class MainActivity : FragmentActivity() {
    private val viewModel: ConsoleViewModel by viewModels()
    private lateinit var prompt: BiometricPrompt

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        prompt = BiometricPrompt(
            this,
            ContextCompat.getMainExecutor(this),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    viewModel.onPrompt(PromptResult.Passed(result.cryptoObject?.cipher))
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    viewModel.onPrompt(PromptErrors.result(errorCode))
                }

                // A finger that was not recognised: the prompt says so itself and goes on.
            },
        )
        lifecycleScope.launch { viewModel.windowGuard.collect(::guard) }
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.RESUMED) {
                viewModel.prompt.collect { request -> if (request != null && viewModel.takePrompt(request)) show(request) }
            }
        }
        setContent {
            CraniumTheme {
                CraniumApp(viewModel)
            }
        }
    }

    override fun onStart() {
        super.onStart()
        viewModel.cameToForeground(SystemClock.elapsedRealtime())
    }

    override fun onStop() {
        super.onStop()
        if (!isChangingConfigurations) viewModel.wentToBackground(SystemClock.elapsedRealtime())
    }

    /** Only a strong biometric, with the key's cipher; the other way in is the app's own sign-in. */
    private fun show(request: PromptRequest) {
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(request.title)
            .setSubtitle(request.subtitle)
            .setNegativeButtonText(request.negative)
            .setAllowedAuthenticators(BIOMETRIC_STRONG)
            .setConfirmationRequired(false)
            .build()
        try {
            prompt.authenticate(info, BiometricPrompt.CryptoObject(request.cipher))
        } catch (e: IllegalArgumentException) {
            viewModel.onPrompt(PromptResult.Unavailable)
        } catch (e: IllegalStateException) {
            viewModel.onPrompt(PromptResult.Unavailable)
        }
    }

    /**
     * The lock screen is FLAG_SECURE: no screenshot, no thumbnail in recents. With fingerprint
     * unlock on, the console has no thumbnail in recents either: from Android 13 without blocking
     * screenshots (setRecentsScreenshotEnabled), before it with FLAG_SECURE.
     */
    private fun guard(guard: WindowGuard) {
        val secure = guard == WindowGuard.SECURE || (guard == WindowGuard.NO_RECENTS && Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU)
        if (secure) {
            window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) setRecentsScreenshotEnabled(guard == WindowGuard.NONE)
    }
}
