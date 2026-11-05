package com.craniumiot.cranium

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.view.WindowManager
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricPrompt
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.craniumiot.cranium.core.PromptErrors
import com.craniumiot.cranium.core.PromptResult
import com.craniumiot.cranium.shell.ClassicNotice
import com.craniumiot.cranium.shell.LocalNewApp
import com.craniumiot.cranium.shell.ShellPrefs
import com.craniumiot.cranium.shell.ShellScreen
import com.craniumiot.cranium.shell.ShellStart
import com.craniumiot.cranium.shell.ShellViewModel
import com.craniumiot.cranium.shell.shellSupported
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
 * From 0.8.0 it shows the new app by default: the shell around the console's and the customer site's
 * own pages ([shell], docs/mobile-apps.md "The app shell"). The classic app, the native screens of 0.7,
 * stays for this version behind the "Classic app" switch of the shell's settings, the launcher shortcut
 * of that name, and whenever the shell cannot run on this phone. Its view models are only made when it
 * is shown, so the two never hold one sign-in twice.
 *
 * The classic app has two sides, each with its own session (docs/mobile-apps.md, "Customers"): the
 * customer side ([customer]) and admin mode, the console ([viewModel]). Only the side in front may show
 * its fingerprint prompt, and its answer goes back to the side that asked.
 */
class MainActivity : FragmentActivity() {
    private val viewModel: ConsoleViewModel by viewModels()
    private val customer: CustomerViewModel by viewModels()
    private val shell: ShellViewModel by viewModels()
    private lateinit var prompt: BiometricPrompt

    /** Whose prompt is showing: true for the customer side's. */
    private var promptForCustomer = false

    /** The shell's prompt on screen, by its question's id, and the last one shown. */
    private var shellPrompt = 0L
    private var shellPromptShown = 0L

    /** Which app is on screen: null before onCreate has chosen. */
    private var showingShell: Boolean? = null

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
        val prefs = ShellPrefs(this)
        when (intent?.action) {
            ACTION_CLASSIC -> prefs.classic = true
            ACTION_NEW_APP -> prefs.classic = false
        }
        when {
            prefs.classic -> startClassic(null)
            !shellSupported() -> startClassic(
                "This phone's Android System WebView is too old for the new app, so this is the classic app. " +
                    "Update Android System WebView in the Play Store.",
            )
            else -> startShell()
        }
    }

    /** The new app: the shell's screen, and what it asks of the activity. */
    private fun startShell() {
        showingShell = true
        lifecycleScope.launch { shell.guard.collect(::guard) }
        lifecycleScope.launch {
            shell.keepAwake.collect { on ->
                if (on) {
                    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                } else {
                    window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                }
            }
        }
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.RESUMED) {
                shell.prompts.pending.collect { asked ->
                    if (asked == null || asked.id <= shellPromptShown) return@collect
                    shellPromptShown = asked.id
                    shellPrompt = asked.id
                    show(asked.question)
                }
            }
        }
        lifecycleScope.launch {
            shell.start.collect { start -> if (start is ShellStart.Failed && showingShell == true) startClassic(start.line) }
        }
        setContent {
            CraniumTheme {
                ShellScreen(shell, onClassic = { switchApp(classic = true) })
            }
        }
    }

    /** The classic app, with a line saying why when the new one could not run. */
    private fun startClassic(line: String?) {
        showingShell = false
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
                var notice by remember { mutableStateOf(line) }
                CompositionLocalProvider(LocalNewApp provides { switchApp(classic = false) }) {
                    Box(Modifier.fillMaxSize()) {
                        CraniumRoot(customer, viewModel)
                        notice?.let { ClassicNotice(it, onDismiss = { notice = null }) }
                    }
                }
            }
        }
    }

    /** From the shell's settings, or the classic app's "Use the new app": the other app, from its start. */
    private fun switchApp(classic: Boolean) {
        ShellPrefs(this).classic = classic
        startActivity(Intent(this, MainActivity::class.java))
        finish()
    }

    private fun answer(result: PromptResult) {
        when {
            showingShell == true -> shell.prompts.answer(shellPrompt, result)
            promptForCustomer -> customer.onPrompt(result)
            else -> viewModel.onPrompt(result)
        }
    }

    override fun onStart() {
        super.onStart()
        val now = SystemClock.elapsedRealtime()
        when (showingShell) {
            true -> shell.cameToForeground(now)
            false -> {
                viewModel.cameToForeground(now)
                customer.cameToForeground(now)
            }
            null -> Unit
        }
    }

    override fun onStop() {
        super.onStop()
        if (!isChangingConfigurations) {
            val now = SystemClock.elapsedRealtime()
            when (showingShell) {
                true -> shell.wentToBackground(now)
                false -> {
                    viewModel.wentToBackground(now)
                    customer.wentToBackground(now)
                }
                null -> Unit
            }
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

    companion object {
        /** The launcher shortcuts (res/xml/shortcuts.xml): the classic app, and back to the new one. */
        const val ACTION_CLASSIC = "com.craniumiot.cranium.CLASSIC_APP"
        const val ACTION_NEW_APP = "com.craniumiot.cranium.NEW_APP"
    }
}
