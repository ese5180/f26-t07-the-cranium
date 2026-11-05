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
import com.craniumiot.cranium.ui.CraniumRoot
import com.craniumiot.cranium.ui.CraniumTheme
import com.craniumiot.cranium.ui.CustomerViewModel
import com.craniumiot.cranium.ui.PromptRequest
import com.craniumiot.cranium.ui.Side
import com.craniumiot.cranium.ui.WindowGuard
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/**
 * The one activity. A FragmentActivity because BiometricPrompt needs one; the prompt is made here,
 * in onCreate, so that it survives a rotation and its answer still arrives.
 *
 * Two sides, each with its own session (docs/mobile-apps.md, "Customers"): the customer side
 * ([customer]) and admin mode, the console ([viewModel]). Only the side in front may show its
 * fingerprint prompt, and its answer goes back to the side that asked.
 */
class MainActivity : FragmentActivity() {
    private val viewModel: ConsoleViewModel by viewModels()
    private val customer: CustomerViewModel by viewModels()
    private lateinit var prompt: BiometricPrompt

    /** Whose prompt is showing: true for the customer side's. */
    private var promptForCustomer = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        prompt = BiometricPrompt(
            this,
            ContextCompat.getMainExecutor(this),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    answer(PromptResult.Passed(result.cryptoObject?.cipher))
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    answer(PromptErrors.result(errorCode))
                }

                // A finger that was not recognised: the prompt says so itself and goes on.
            },
        )
        lifecycleScope.launch {
            combine(customer.side, viewModel.windowGuard, customer.windowGuard) { side, admin, mine ->
                when (side) {
                    Side.ADMIN -> admin
                    Side.CUSTOMER -> mine
                    Side.STARTING -> WindowGuard.SECURE
                }
            }.collect(::guard)
        }
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.RESUMED) {
                combine(customer.side, viewModel.prompt, customer.prompt) { side, admin, mine ->
                    when (side) {
                        Side.ADMIN -> admin?.let { false to it }
                        Side.CUSTOMER -> mine?.let { true to it }
                        Side.STARTING -> null
                    }
                }.collect { asked ->
                    if (asked == null) return@collect
                    val (forCustomer, request) = asked
                    val take = if (forCustomer) customer.takePrompt(request) else viewModel.takePrompt(request)
                    if (take) {
                        promptForCustomer = forCustomer
                        show(request)
                    }
                }
            }
        }
        setContent {
            CraniumTheme {
                CraniumRoot(customer, viewModel)
            }
        }
    }

    private fun answer(result: PromptResult) {
        if (promptForCustomer) customer.onPrompt(result) else viewModel.onPrompt(result)
    }

    override fun onStart() {
        super.onStart()
        val now = SystemClock.elapsedRealtime()
        viewModel.cameToForeground(now)
        customer.cameToForeground(now)
    }

    override fun onStop() {
        super.onStop()
        if (!isChangingConfigurations) {
            val now = SystemClock.elapsedRealtime()
            viewModel.wentToBackground(now)
            customer.wentToBackground(now)
        }
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
            answer(PromptResult.Unavailable)
        } catch (e: IllegalStateException) {
            answer(PromptResult.Unavailable)
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
