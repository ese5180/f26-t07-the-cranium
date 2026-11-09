package com.craniumiot.cranium.ui

import android.app.Application
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.craniumiot.cranium.CraniumConfig
import com.craniumiot.cranium.api.ApiClient
import com.craniumiot.cranium.api.UploadStage
import com.craniumiot.cranium.auth.AuthManager
import com.craniumiot.cranium.auth.AuthSettings
import com.craniumiot.cranium.auth.KeystoreVault
import com.craniumiot.cranium.auth.SignInException
import com.craniumiot.cranium.auth.SignedOutException
import com.craniumiot.cranium.auth.TokenStore
import com.craniumiot.cranium.ble.BluetoothFlow
import com.craniumiot.cranium.core.ApiError
import com.craniumiot.cranium.core.ApiJson
import com.craniumiot.cranium.core.ApiPaths
import com.craniumiot.cranium.core.ApiToken
import com.craniumiot.cranium.core.AuditEntry
import com.craniumiot.cranium.core.AuditPage
import com.craniumiot.cranium.core.BiometricPolicy
import com.craniumiot.cranium.core.BoardLog
import com.craniumiot.cranium.core.CacheSummary
import com.craniumiot.cranium.core.Deployment
import com.craniumiot.cranium.core.DeploymentSummary
import com.craniumiot.cranium.core.EnrolNext
import com.craniumiot.cranium.core.EventPage
import com.craniumiot.cranium.core.FingerprintLock
import com.craniumiot.cranium.core.FingerprintWords
import com.craniumiot.cranium.core.FirmwareCache
import com.craniumiot.cranium.core.CodeEntry
import com.craniumiot.cranium.core.FreshSignIn
import com.craniumiot.cranium.core.HelpLoad
import com.craniumiot.cranium.core.HelpReader
import com.craniumiot.cranium.core.PromptResult
import com.craniumiot.cranium.core.RecentSearches
import com.craniumiot.cranium.core.SerialRecord
import com.craniumiot.cranium.core.SignInStep
import com.craniumiot.cranium.core.SignInWords
import com.craniumiot.cranium.core.ImageCheck
import com.craniumiot.cranium.core.Outcomes
import com.craniumiot.cranium.core.ReleaseList
import com.craniumiot.cranium.core.Telemetry
import com.craniumiot.cranium.core.Times
import com.craniumiot.cranium.core.Tone
import com.craniumiot.cranium.core.UnlockNext
import com.craniumiot.cranium.core.UploadReview
import com.craniumiot.cranium.core.Updates
import com.craniumiot.cranium.core.Words
import com.craniumiot.cranium.usb.UsbConsole
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import java.io.File

/**
 * The whole app: signing in, where the person is, what is read from the console and how often it
 * is read again (the website's app.js), the dialogs that change something, the upload of a signed
 * image, the update over Bluetooth and the serial console over USB.
 *
 * A change from the phone needs a sign-in in the last 15 minutes. Before it tries one, the app
 * looks at when the person last signed in; if that is too long ago, or the console answers
 * `403 phone_sign_in_again` all the same, it asks for the password and code again and makes the
 * change once more, with what the person entered kept as it was.
 */
class ConsoleViewModel(application: Application) : AndroidViewModel(application) {
    private val app = application
    private val config = CraniumConfig.fromBuild()
    val exampleConfig: Boolean get() = config.isExample

    /** App-private storage, never backed up (AndroidManifest.xml, data_extraction_rules.xml). */
    private val firmwareCache = FirmwareCache(File(app.filesDir, "firmware"))

    private var auth: AuthManager? = null
    private var api: ApiClient? = null

    private val _gate = MutableStateFlow<Gate>(Gate.Starting)
    val gate: StateFlow<Gate> = _gate.asStateFlow()

    private val _nav = MutableStateFlow(Nav())
    val nav: StateFlow<Nav> = _nav.asStateFlow()

    private val _store = MutableStateFlow(Store())
    val store: StateFlow<Store> = _store.asStateFlow()

    private val _dialog = MutableStateFlow<DialogState?>(null)
    val dialog: StateFlow<DialogState?> = _dialog.asStateFlow()

    private val _upload = MutableStateFlow(UploadState())
    val upload: StateFlow<UploadState> = _upload.asStateFlow()
    private var uploadBytes: ByteArray? = null
    private var chosenFile = 0

    private val _toasts = MutableStateFlow<List<Toast>>(emptyList())
    val toasts: StateFlow<List<Toast>> = _toasts.asStateFlow()
    private var toastId = 0L

    /** The AWS sign-in pages the screen is to open: for a step the app's own screen does not do, or when asked for. */
    private val signInRequests = Channel<Intent>(Channel.BUFFERED)
    val signInPages: Flow<Intent> = signInRequests.receiveAsFlow()

    /** The app's own sign-in screen, at the start. */
    private val _signIn = MutableStateFlow(SignInForm())
    val signIn: StateFlow<SignInForm> = _signIn.asStateFlow()

    /** The same screen over the console, for a change that needs a fresh sign-in; null while it is not shown. */
    private val _fresh = MutableStateFlow<SignInForm?>(null)
    val fresh: StateFlow<SignInForm?> = _fresh.asStateFlow()

    /** A change waiting for a fresh sign-in: what to do after it, and what to do if it does not come. */
    private var freshThen: (() -> Unit)? = null
    private var freshFailed: ((Throwable) -> Unit)? = null

    /** The address last typed on this phone while the app runs, for the next sign-in. Never the password. */
    private var lastEmail = ""

    /** The last searches, newest first; kept with the session and gone with a sign-out. */
    private val _recent = MutableStateFlow<List<String>>(emptyList())
    val recentSearches: StateFlow<List<String>> = _recent.asStateFlow()

    /** The fingerprint prompt the screen is to show, if any (MainActivity shows it). */
    private val _prompt = MutableStateFlow<PromptRequest?>(null)
    val prompt: StateFlow<PromptRequest?> = _prompt.asStateFlow()
    private var promptId = 0L
    private var promptShown = 0L

    /** "Use your fingerprint to open Cranium?", after a full sign-in. */
    private val _offer = MutableStateFlow(false)
    val offer: StateFlow<Boolean> = _offer.asStateFlow()

    private val _fingerprint = MutableStateFlow(FingerprintUi())
    val fingerprint: StateFlow<FingerprintUi> = _fingerprint.asStateFlow()

    /**
     * What the window hides. The lock screen (and the moment before the app knows whether to show
     * it): FLAG_SECURE. The console with fingerprint unlock on: no thumbnail in recents. Otherwise
     * nothing, as before.
     */
    val windowGuard: StateFlow<WindowGuard> = combine(_gate, _fingerprint) { gate, fingerprint ->
        when {
            gate is Gate.Locked || gate == Gate.Starting -> WindowGuard.SECURE
            gate == Gate.Ready && fingerprint.on -> WindowGuard.NO_RECENTS
            else -> WindowGuard.NONE
        }
    }.stateIn(viewModelScope, SharingStarted.Eagerly, WindowGuard.SECURE)

    /** When the app went to the background (elapsedRealtime), and the lock that waits for 5 minutes of it. */
    private var awaySince: Long? = null
    private var relockJob: Job? = null

    /** A full sign-in on the sign-in screen whose console has not loaded yet: then the offer, or keeping it behind the fingerprint. */
    private var pendingFullSignIn = false

    /** The lock came over a console that was loaded, which comes back as it was. */
    private var lockedFromConsole = false

    /** The Help topics of this build (apps/shared/help.json), read once. */
    private val _help = MutableStateFlow<HelpLoad>(HelpLoad.Missing)
    val help: StateFlow<HelpLoad> = _help.asStateFlow()

    private val lastRefresh = mutableMapOf<String, Long>()

    /**
     * Whether a staff session is kept on this phone (open, or behind the fingerprint): what the
     * customer side needs to offer Admin mode. Null until the app has opened its storage.
     */
    private val _held = MutableStateFlow<Boolean?>(null)
    val held: StateFlow<Boolean?> = _held.asStateFlow()

    /** The person signed out of admin mode: the app goes back to the customer side. */
    private val signOuts = Channel<Unit>(Channel.CONFLATED)
    val signedOut: Flow<Unit> = signOuts.receiveAsFlow()

    private fun noteHeld() {
        val manager = auth
        _held.value = manager != null && (manager.isSignedIn || manager.needsUnlock)
    }

    val bluetooth = BluetoothFlow(
        app = app,
        scope = viewModelScope,
        firmware = firmwareCache,
        api = { api },
        signedIn = { auth?.isSignedIn == true },
        onSignedOut = { message -> toSignIn(message) },
        onCacheChanged = { viewModelScope.launch { showCache() } },
    )

    val usb = UsbConsole(app, viewModelScope)

    /** A newer version of this app on the console (update/): checked when the console opens, installed on a tap. */
    val appUpdate = com.craniumiot.cranium.update.AppUpdater(app, viewModelScope) { auth }

    init {
        viewModelScope.launch {
            val manager = try {
                withContext(Dispatchers.IO) { AuthManager(app, AuthSettings.staff(config), TokenStore(app), KeystoreVault(app)) }
            } catch (e: Exception) {
                _gate.value = Gate.SignIn(notice = "The app could not open its secure storage: ${e.message}")
                _held.value = false
                forgetFirmware()
                return@launch
            }
            auth = manager
            api = ApiClient(ApiPaths(config.consoleUrl), manager)
            showFingerprint()
            noteHeld()
            if (manager.needsUnlock) {
                lock(fromConsole = false)
            } else if (manager.isSignedIn) {
                startConsole()
            } else {
                // A signed-out phone keeps nothing from the console, even after a sign-out cut short.
                _gate.value = Gate.SignIn()
                forgetFirmware()
            }
        }
        usb.start()
        // Without fingerprint unlock, the refresh token goes an hour after the sign-in.
        viewModelScope.launch {
            while (true) {
                delay(KEEP_RULE_EVERY_MS)
                auth?.enforceKeepRule()
            }
        }
        viewModelScope.launch {
            _help.value = withContext(Dispatchers.IO) {
                runCatching { app.assets.open("help.json").use { it.readBytes().decodeToString() } }
                    .map { HelpReader.parse(it) }
                    .getOrDefault(HelpLoad.Missing)
            }
        }
    }

    // Signing in and out.

    /** The AWS sign-in page, or null (with a notice) if there is no browser to show it in. */
    fun signInIntent(): Intent? {
        val manager = auth ?: return null
        return try {
            manager.signInIntent()
        } catch (e: ActivityNotFoundException) {
            _gate.update { if (it is Gate.SignIn) it.copy(notice = "There is no web browser on this phone to sign in with.") else it }
            null
        }
    }

    private fun form(fresh: Boolean): SignInForm? = if (fresh) _fresh.value else _signIn.value

    private fun updateForm(fresh: Boolean, change: (SignInForm) -> SignInForm) {
        if (fresh) _fresh.update { it?.let(change) } else _signIn.update(change)
    }

    fun signInEmail(fresh: Boolean, text: String) {
        if (form(fresh)?.emailFixed == true) return
        updateForm(fresh) { it.copy(email = text.take(320), problem = null) }
    }

    /**
     * The e-mail address and the password, on the app's own screen. The password goes from the
     * field to the proof and nowhere else: it is not kept here, not logged and not sent.
     */
    fun submitPassword(fresh: Boolean, password: String) {
        val manager = auth ?: return
        val current = form(fresh) ?: return
        if (current.busy || current.phase != SignInPhase.PASSWORD) return
        if (!fresh) lastEmail = current.email.trim()
        updateForm(fresh) { it.copy(busy = true, problem = null) }
        viewModelScope.launch {
            val step = try {
                manager.passwordSignIn(current.email, password)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // Nothing of what went wrong is logged: it might hold what was typed.
                SignInStep.Password("failed")
            }
            after(fresh, step)
        }
    }

    /** What the one field behind the six boxes holds now. The sixth digit sends the code, once. */
    fun codeChanged(fresh: Boolean, text: String) {
        val current = form(fresh) ?: return
        if (current.busy) return
        val digits = CodeEntry.digits(text)
        updateForm(fresh) { it.copy(code = digits, problem = null) }
        if (!CodeEntry.complete(current.code) && CodeEntry.complete(digits)) submitCode(fresh)
    }

    fun submitCode(fresh: Boolean) {
        val manager = auth ?: return
        val current = form(fresh) ?: return
        if (current.busy || current.phase != SignInPhase.CODE) return
        if (!CodeEntry.complete(current.code)) {
            updateForm(fresh) { it.copy(problem = "short-code", tries = it.tries + 1) }
            return
        }
        updateForm(fresh) { it.copy(busy = true, problem = null) }
        viewModelScope.launch {
            val step = try {
                manager.sendCode(current.code)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                SignInStep.CodeProblem("failed")
            }
            after(fresh, step)
        }
    }

    /** Where an answer of Cognito leaves the sign-in screen. */
    private suspend fun after(fresh: Boolean, step: SignInStep) {
        if (form(fresh) == null) return
        when (step) {
            is SignInStep.Done -> if (fresh) {
                _fresh.value = null
                afterFreshSignIn()
            } else {
                _signIn.value = SignInForm(email = lastEmail)
                startConsole(fullSignIn = true)
            }
            SignInStep.Code -> updateForm(fresh) {
                it.copy(phase = SignInPhase.CODE, busy = false, problem = null, code = "", tries = it.tries + 1)
            }
            is SignInStep.CodeProblem -> {
                // The boxes clear for the next code, and one line says why.
                updateForm(fresh) {
                    it.copy(phase = SignInPhase.CODE, busy = false, problem = step.problem, code = "", tries = it.tries + 1)
                }
            }
            is SignInStep.Password -> updateForm(fresh) {
                it.copy(phase = SignInPhase.PASSWORD, busy = false, problem = step.problem, code = "", tries = it.tries + 1)
            }
            is SignInStep.Elsewhere -> toAwsPage(fresh, step.challenge)
            // Only a customer's sign-in answers a new password on the screen; the staff pool's is the AWS page's.
            SignInStep.NewPassword, is SignInStep.NewPasswordProblem -> toAwsPage(fresh, "NEW_PASSWORD_REQUIRED")
        }
    }

    /**
     * The team's pool for the one sign-in screen of the customer side (CustomerViewModel): the same
     * session as this screen's own sign-in, so admin mode opens with it.
     */
    val teamSignIn: TeamSignIn = object : TeamSignIn {
        override val ready: Boolean get() = auth != null

        override suspend fun password(email: String, password: String): SignInStep =
            auth?.passwordSignIn(email, password) ?: SignInStep.Password("failed")

        override suspend fun code(code: String): SignInStep = auth?.sendCode(code) ?: SignInStep.CodeProblem("failed")

        override fun cancel() {
            auth?.cancelPasswordSignIn()
        }

        override fun signedIn() {
            _signIn.value = SignInForm(email = lastEmail)
            viewModelScope.launch { startConsole(fullSignIn = true) }
        }

        override fun awsPage(challenge: String) = toAwsPage(false, challenge)
    }

    /** Back to the password, dropping the sign-in that waits for its code. */
    fun startOver(fresh: Boolean) {
        val current = form(fresh) ?: return
        if (current.busy) return
        auth?.cancelPasswordSignIn()
        updateForm(fresh) { it.copy(phase = SignInPhase.PASSWORD, code = "", problem = null) }
    }

    /** "Use the AWS sign-in page", and "Forgot your password?". */
    fun useAwsPage(fresh: Boolean) = toAwsPage(fresh, null)

    /** Leave for the AWS sign-in page: asked for, or a step that only that page does. */
    private fun toAwsPage(fresh: Boolean, challenge: String?) {
        auth?.cancelPasswordSignIn()
        val intent = signInIntent()
        if (intent == null) {
            updateForm(fresh) { it.copy(busy = false, problem = "failed") }
            return
        }
        val reason = challenge?.takeIf { it.isNotEmpty() }?.let { SignInWords.ELSEWHERE[it] ?: SignInWords.ELSEWHERE_OTHER }
        updateForm(fresh) { it.copy(busy = true, problem = null, leaving = reason ?: "") }
        viewModelScope.launch { signInRequests.send(intent) }
    }

    /** What the AWS sign-in page returned: for the first sign-in, or for a change that waits. */
    fun onSignInResult(data: Intent?) {
        val manager = auth ?: return
        viewModelScope.launch {
            if (freshThen != null) {
                _fresh.value = null
                try {
                    manager.completeSignIn(data)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    val failed = freshFailed
                    freshThen = null
                    freshFailed = null
                    failed?.invoke(SignInException("${Messages.describe(e).removeSuffix(".")}, so nothing was changed."))
                    return@launch
                }
                afterFreshSignIn()
                return@launch
            }
            _signIn.update { it.copy(busy = false, leaving = null) }
            _gate.value = Gate.SignIn(busy = "Signing in…")
            try {
                manager.completeSignIn(data)
                startConsole(fullSignIn = true)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _gate.value = Gate.SignIn(notice = Messages.describe(e))
            }
        }
    }

    /** Load the console. After a full sign-in ([fullSignIn]), then offer fingerprint unlock, or keep the sign-in behind it. */
    private suspend fun startConsole(fullSignIn: Boolean = false) {
        val client = api ?: return
        if (fullSignIn) pendingFullSignIn = true
        _gate.value = Gate.SignIn(busy = "Loading the console…")
        noteHeld()
        try {
            val me = client.me()
            _store.update { it.copy(me = me) }
            recordSerialCommands(me.canWrite)
            _recent.value = withContext(Dispatchers.IO) { auth?.recentSearches().orEmpty() }
            _gate.value = Gate.Ready
            appUpdate.check()
            showCache()
            if (pendingFullSignIn) {
                pendingFullSignIn = false
                afterFullSignIn()
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: SignedOutException) {
            toSignIn(Messages.describe(e))
        } catch (e: Exception) {
            _gate.value = Gate.SignIn(notice = "Signed in, but the console could not be reached. ${Messages.describe(e)}")
        }
    }

    /** Try again after the console could not be reached at the start. */
    fun retryStart() {
        if (auth?.isSignedIn == true) viewModelScope.launch { startConsole() }
    }

    fun signOut() {
        signOutHere()
        signOuts.trySend(Unit)
    }

    /**
     * Sign the admin out without leaving where the app is: the customer side's Sign out, which ends
     * both sessions as the customer site's does.
     */
    fun signOutHere() {
        val manager = auth
        resetEverything()
        _gate.value = Gate.SignIn()
        _held.value = false
        if (manager != null) {
            viewModelScope.launch {
                manager.signOut()
                showFingerprint()
                noteHeld()
            }
        }
    }

    // Fingerprint unlock (docs/mobile-apps.md; the rules are core/Fingerprint.kt).

    private fun showFingerprint() {
        _fingerprint.update { it.copy(state = KeystoreVault.state(app), on = auth?.fingerprintOn == true) }
    }

    /** Whether MainActivity is to show this prompt: once, even across a rotation. */
    fun takePrompt(request: PromptRequest): Boolean {
        if (request.id <= promptShown) return false
        promptShown = request.id
        return true
    }

    /** How the prompt ended. */
    fun onPrompt(result: PromptResult) {
        val request = _prompt.value ?: return
        _prompt.value = null
        viewModelScope.launch {
            when (request.purpose) {
                PromptPurpose.UNLOCK -> unlockNext(auth?.finishUnlock(result) ?: return@launch)
                PromptPurpose.ENROL, PromptPurpose.REKEY -> afterEnrol(request.purpose, result)
            }
        }
    }

    private fun ask(purpose: PromptPurpose, cipher: javax.crypto.Cipher) {
        _prompt.value = PromptRequest(++promptId, purpose, cipher)
    }

    /** Show the lock screen, and ask for the fingerprint at once. */
    private fun lock(fromConsole: Boolean) {
        lockedFromConsole = fromConsole
        _offer.value = false
        _gate.value = Gate.Locked()
        unlock()
    }

    /** "Unlock with fingerprint". */
    fun unlock() {
        val manager = auth ?: return
        val gate = _gate.value as? Gate.Locked ?: return
        if (gate.busy || _prompt.value != null) return
        viewModelScope.launch {
            when (val begin = manager.beginUnlock()) {
                is FingerprintLock.Begin.Prompt -> ask(PromptPurpose.UNLOCK, begin.cipher)
                is FingerprintLock.Begin.Done -> unlockNext(begin.next)
            }
        }
    }

    private suspend fun unlockNext(next: UnlockNext) {
        when (next) {
            is UnlockNext.Open -> opened()
            is UnlockNext.Locked -> _gate.value = Gate.Locked(line = next.line)
            UnlockNext.Password -> signInWithPassword()
            is UnlockNext.Forget -> {
                // The key, the ciphertext and the setting are gone already; nothing of the sign-in stays.
                auth?.forget()
                showFingerprint()
                noteHeld()
                lockedFromConsole = false
                resetEverything()
                _gate.value = Gate.SignIn(notice = next.line)
            }
        }
    }

    /** The fingerprint opened the refresh token: refresh as usual, then the console. */
    private suspend fun opened() {
        val manager = auth ?: return
        _gate.value = Gate.Locked(busy = true)
        if (lockedFromConsole && _store.value.me != null) {
            lockedFromConsole = false
            try {
                manager.accessToken(forceRefresh = true)
            } catch (e: CancellationException) {
                throw e
            } catch (e: SignedOutException) {
                showFingerprint()
                toSignIn(FingerprintWords.ENDED)
                return
            } catch (e: Exception) {
                // Not reached: what is loaded stays, and the next request tries again.
            }
            _gate.value = Gate.Ready
            refreshNow()
        } else {
            lockedFromConsole = false
            startConsole()
            showFingerprint()
        }
    }

    /** "Sign in with password" on the lock screen: what is kept stays for the next time. */
    fun signInWithPassword() {
        _prompt.value = null
        lockedFromConsole = false
        resetEverything()
        _gate.value = Gate.SignIn()
        viewModelScope.launch { auth?.closeSession() }
    }

    /** After a full sign-in: keep it behind the fingerprint if that is on, or offer it once. */
    private suspend fun afterFullSignIn() {
        val manager = auth ?: return
        showFingerprint()
        if (manager.fingerprintOn) {
            enrol(PromptPurpose.REKEY)
            return
        }
        val sub = _store.value.me?.sub.orEmpty()
        val declined = sub.isNotEmpty() && manager.declinedOffer(sub)
        _offer.value = BiometricPolicy.offer(fullSignIn = true, _fingerprint.value.state, on = false, declined = declined)
    }

    /** Yes, or Not now (kept for this person on this phone). */
    fun answerOffer(yes: Boolean) {
        if (!_offer.value) return
        _offer.value = false
        val manager = auth ?: return
        val sub = _store.value.me?.sub.orEmpty()
        viewModelScope.launch {
            if (yes) enrol(PromptPurpose.ENROL) else if (sub.isNotEmpty()) manager.declineOffer(sub)
        }
    }

    /** The Account screen's switch. */
    fun setFingerprint(on: Boolean) {
        val manager = auth ?: return
        if (_fingerprint.value.busy || _prompt.value != null) return
        viewModelScope.launch {
            if (on) {
                showFingerprint()
                if (_fingerprint.value.state == com.craniumiot.cranium.core.BiometricState.READY) enrol(PromptPurpose.ENROL)
            } else {
                manager.turnOffFingerprint()
                showFingerprint()
                notify(if (manager.keepsRefreshToken) FingerprintWords.OFF else FingerprintWords.OFF_SOON)
            }
        }
    }

    private suspend fun enrol(purpose: PromptPurpose) {
        val manager = auth ?: return
        _fingerprint.update { it.copy(busy = true) }
        when (val begin = manager.beginEnrol()) {
            is FingerprintLock.Begin.Prompt -> ask(purpose, begin.cipher)
            is FingerprintLock.Begin.Done -> afterEnrolled(purpose, begin.next)
        }
    }

    private suspend fun afterEnrol(purpose: PromptPurpose, result: PromptResult) {
        val manager = auth ?: return
        afterEnrolled(purpose, manager.finishEnrol(result))
    }

    private fun afterEnrolled(purpose: PromptPurpose, next: EnrolNext) {
        showFingerprint()
        _fingerprint.update { it.copy(busy = false) }
        when (next) {
            is EnrolNext.On -> notify(FingerprintWords.ON)
            is EnrolNext.Off -> when {
                purpose == PromptPurpose.REKEY -> notify(FingerprintWords.OFF_AGAIN, Tone.WARN)
                next.line != null -> notify(next.line, Tone.BAD)
                else -> Unit
            }
        }
    }

    /** The app went to the background (SystemClock.elapsedRealtime). */
    fun wentToBackground(nowMs: Long) {
        awaySince = nowMs
        relockJob?.cancel()
        relockJob = null
        if (auth?.fingerprintOn != true || _gate.value != Gate.Ready) return
        relockJob = viewModelScope.launch {
            delay(BiometricPolicy.RELOCK_AFTER_MS)
            if (_gate.value == Gate.Ready && auth?.fingerprintOn == true && !onAwsPage()) lock(fromConsole = true)
        }
    }

    /** Back in the foreground: after 5 minutes or more away, the fingerprint again. */
    fun cameToForeground(nowMs: Long) {
        relockJob?.cancel()
        relockJob = null
        val since = awaySince
        awaySince = null
        showFingerprint()
        viewModelScope.launch { auth?.enforceKeepRule() }
        val gate = _gate.value
        if (gate == Gate.Ready && !onAwsPage() && BiometricPolicy.relock(auth?.fingerprintOn == true, since, nowMs)) {
            lock(fromConsole = true)
        } else if (gate is Gate.Locked && gate.line == null && since != null) {
            // Back to the lock screen, whose prompt the system closed: ask again.
            unlock()
        }
    }

    /** A fresh sign-in on the AWS page is under way: its answer is a sign-in of its own. */
    private fun onAwsPage(): Boolean = _fresh.value?.leaving != null

    /** The console no longer takes this sign-in: back to the sign-in screen, keeping nothing. */
    private fun toSignIn(message: String?) {
        resetEverything()
        _gate.value = Gate.SignIn(notice = message)
        noteHeld()
    }

    /**
     * A release manager's commands that change a board at its serial console go on record, once the
     * board said OK (serial.js RECORDED): by name, with the board as it gave itself, never a value.
     */
    private fun recordSerialCommands(canWrite: Boolean) {
        usb.session.recorder = if (canWrite) ::recordSerialCommand else null
    }

    /** Null once it is in the activity log, else why not, in words. The route needs no fresh sign-in. */
    private suspend fun recordSerialCommand(record: SerialRecord): String? {
        val client = api ?: return "The app is not signed in."
        return try {
            client.recordSerialCommand(record)
            null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Messages.describe(e)
        }
    }

    private fun resetEverything() {
        usb.session.recorder = null
        bluetooth.reset()
        viewModelScope.launch { usb.session.disconnect() }
        auth?.cancelPasswordSignIn()
        _store.value = Store()
        _dialog.value = null
        _upload.value = UploadState()
        uploadBytes = null
        _nav.value = Nav()
        _fresh.value = null
        _signIn.value = SignInForm(email = lastEmail)
        _recent.value = emptyList()
        freshThen = null
        freshFailed = null
        pendingFullSignIn = false
        _offer.value = false
        _prompt.value = null
        lastRefresh.clear()
        viewModelScope.launch { forgetFirmware() }
    }

    // A change from the phone, with the fresh sign-in it needs.

    /**
     * Make a change: [task] runs with the API, once the sign-in is recent enough. On
     * `403 phone_sign_in_again` the person signs in again and it runs once more. [fail] gets
     * whatever else went wrong.
     */
    private fun change(fail: (Throwable) -> Unit, retried: Boolean = false, task: suspend (ApiClient) -> Unit) {
        val client = api ?: return
        val manager = auth ?: return
        viewModelScope.launch {
            if (!retried && !FreshSignIn.isFresh(manager.authTime(), System.currentTimeMillis())) {
                askFreshSignIn(fail) { change(fail, retried = true, task = task) }
                return@launch
            }
            try {
                task(client)
            } catch (e: CancellationException) {
                throw e
            } catch (e: SignedOutException) {
                toSignIn(Messages.describe(e))
            } catch (e: Exception) {
                if (FreshSignIn.isRefusal(e) && !retried) {
                    askFreshSignIn(fail) { change(fail, retried = true, task = task) }
                } else {
                    fail(e)
                    if (Outcomes.staleAfter(e)) refreshNow()
                }
            }
        }
    }

    /** The app's sign-in screen over the console, with the address of the account that is signed in. */
    private fun askFreshSignIn(fail: (Throwable) -> Unit, then: () -> Unit) {
        auth?.cancelPasswordSignIn()
        freshThen = then
        freshFailed = fail
        val email = _store.value.me?.email.orEmpty()
        _fresh.value = SignInForm(email = email.ifEmpty { lastEmail }, fresh = true, emailFixed = email.isNotEmpty())
    }

    /** The fresh sign-in was not given: nothing is changed, and the dialog says so. */
    fun cancelFresh() {
        if (_fresh.value?.busy == true && _fresh.value?.leaving == null) return
        auth?.cancelPasswordSignIn()
        _fresh.value = null
        val failed = freshFailed
        freshThen = null
        freshFailed = null
        failed?.invoke(SignInException("Sign-in was cancelled, so nothing was changed."))
    }

    /**
     * The account, read again when it is not known, before anything that depends on the role (the
     * Bluetooth update): a release manager is never taken for a viewer because one read failed.
     */
    fun ensureMe() {
        if (_store.value.me != null) return
        val client = api ?: return
        viewModelScope.launch {
            val me = try {
                client.me()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                null
            }
            if (me != null) {
                _store.update { it.copy(me = me) }
                recordSerialCommands(me.canWrite)
            }
        }
    }

    private suspend fun afterFreshSignIn() {
        val then = freshThen ?: return
        freshThen = null
        freshFailed = null
        val before = _store.value.me?.sub
        val me = try {
            api?.me()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        }
        if (me != null && !before.isNullOrEmpty() && me.sub.isNotEmpty() && me.sub != before) {
            // Another account signed in: what was entered was meant for the first one.
            _dialog.value = null
            _upload.value = UploadState()
            _store.value = Store(me = me)
            forgetFirmware()
            notify("Signed in as ${me.email.ifEmpty { "another account" }}. Nothing was changed: do it again if you mean to.", Tone.WARN)
            refreshNow()
            return
        }
        if (me != null) _store.update { it.copy(me = me) }
        then()
    }

    // Search.

    /** Keep a search in the recent ones (at most 10, newest first). */
    fun rememberSearch(query: String) {
        val list = RecentSearches.add(_recent.value, query)
        if (list == _recent.value) return
        _recent.value = list
        viewModelScope.launch(Dispatchers.IO) { auth?.saveRecentSearches(list) }
    }

    fun forgetSearch(query: String) {
        val list = RecentSearches.remove(_recent.value, query)
        _recent.value = list
        viewModelScope.launch(Dispatchers.IO) { auth?.saveRecentSearches(list) }
    }

    // Where the person is.

    fun selectTab(tab: Tab) {
        _nav.update { nav ->
            if (nav.tab == tab) nav.copy(stacks = nav.stacks + (tab to listOf(nav.stacks.getValue(tab).first()))) else nav.copy(tab = tab)
        }
    }

    fun open(route: Route) {
        val top = when (route) {
            Route.Overview -> Tab.OVERVIEW
            Route.Boards -> Tab.BOARDS
            Route.Firmware -> Tab.FIRMWARE
            Route.Events -> Tab.EVENTS
            Route.More -> Tab.MORE
            else -> null
        }
        if (top != null) {
            _nav.update { it.copy(tab = top, stacks = it.stacks + (top to listOf(route))) }
            return
        }
        if (route is Route.Bluetooth) bluetooth.start(route.version)
        _nav.update { nav ->
            val stack = nav.stacks.getValue(nav.tab)
            if (stack.last() == route) nav else nav.copy(stacks = nav.stacks + (nav.tab to stack + route))
        }
    }

    /** Back: a page up the tab's pages, else to the Overview. False when there is nowhere to go. */
    fun back(): Boolean {
        val nav = _nav.value
        val stack = nav.stacks.getValue(nav.tab)
        if (stack.last() is Route.Bluetooth && bluetooth.isBusy) return true
        if (stack.size > 1) {
            if (stack.last() is Route.Bluetooth) bluetooth.leave()
            _nav.value = nav.copy(stacks = nav.stacks + (nav.tab to stack.dropLast(1)))
            return true
        }
        if (nav.tab != Tab.OVERVIEW) {
            _nav.value = nav.copy(tab = Tab.OVERVIEW)
            return true
        }
        return false
    }

    // Messages.

    fun notify(text: String, tone: Tone = Tone.GOOD) {
        val id = ++toastId
        _toasts.update { list -> list.filter { it.text != text } + Toast(id, text, tone) }
        viewModelScope.launch {
            delay(maxOf(5_000L, text.length * 80L))
            dismissToast(id)
        }
    }

    fun dismissToast(id: Long) = _toasts.update { list -> list.filter { it.id != id } }

    // Reading.

    private fun now() = System.currentTimeMillis()

    private suspend fun <T> load(read: (Store) -> Resource<T>, write: Store.(Resource<T>) -> Store, fetch: suspend (ApiClient) -> T): T? {
        val client = api ?: return null
        _store.update { s -> s.write(read(s).copy(loading = true)) }
        return try {
            val value = fetch(client)
            _store.update { s -> s.write(Resource(value, null, now(), false)) }
            value
        } catch (e: CancellationException) {
            _store.update { s -> s.write(read(s).copy(loading = false)) }
            throw e
        } catch (e: SignedOutException) {
            toSignIn(Messages.describe(e))
            null
        } catch (e: Exception) {
            _store.update { s -> s.write(read(s).copy(error = e, loading = false)) }
            null
        }
    }

    private fun <T> due(resource: Resource<T>, full: Boolean, every: Long = IDLE_REFRESH_MS) =
        full || resource.loadedAt == 0L || now() - resource.loadedAt >= every - 2_000

    private suspend fun loadDevices() = load({ it.devices }, { copy(devices = it) }) { it.devices() }

    private suspend fun loadDeployments() = load({ it.deployments }, { copy(deployments = it) }) { it.deployments() }

    private suspend fun loadFirmware(): ReleaseList? {
        val list = load({ it.firmware }, { copy(firmware = it) }) { it.releases() } ?: return null
        bluetooth.setReleases(list.releases)
        // Keep only images of active releases, and none for an account that cannot download.
        val canWrite = _store.value.me?.canWrite == true
        withContext(Dispatchers.IO) { if (canWrite) firmwareCache.prune(list.releases) else firmwareCache.clear() }
        showCache()
        return list
    }

    private suspend fun loadRecent() = load({ it.recent }, { copy(recent = it) }) { it.audit(RECENT_ENTRIES) }

    private suspend fun loadAudit() = load({ it.audit }, { copy(audit = it) }) { it.audit(ACTIVITY_PAGE) }

    private suspend fun loadTokens() = load({ it.tokens }, { copy(tokens = it) }) { it.tokens() }

    private suspend fun loadDetail(thing: String) =
        load({ it.deviceDetails[thing] ?: Resource() }, { copy(deviceDetails = deviceDetails + (thing to it)) }) { it.deviceDetail(thing) }

    private suspend fun loadDeployment(id: String) =
        load({ it.deploymentDetails[id] ?: Resource() }, { copy(deploymentDetails = deploymentDetails + (id to it)) }) { it.deployment(id) }

    /** The fleet's newest update, for the overview. */
    private suspend fun loadUpdates() = load({ it.updates }, { copy(updates = it) }) { it.updates(limit = UPDATES_ON_OVERVIEW) }

    /** A board's updates: the first page is enough for its page. */
    private suspend fun loadBoardUpdates(thing: String) =
        load({ it.boardUpdates[thing] ?: Resource() }, { copy(boardUpdates = boardUpdates + (thing to it)) }) { it.updates(thing = thing) }

    /**
     * Whether to read a list of updates again: when due, but from a console that has no such route
     * (2.1.0 and before) only when the page is opened or pulled down.
     */
    private fun <T> updatesDue(resource: Resource<T>, full: Boolean) =
        if (Updates.noUpdatesRoute(resource.error)) full else due(resource, full)

    private suspend fun loadSamples(thing: String) =
        load({ it.samples[thing] ?: Resource() }, { copy(samples = samples + (thing to it)) }) { it.samples(thing, 24) }

    private suspend fun loadMe() {
        val me = load({ Resource(it.me) }, { copy(me = it.value ?: me) }) { it.me() }
        if (me != null) _store.update { it.copy(me = me) }
    }

    /** The deployments whose boards the overview follows one by one: those with a board still at it. */
    private fun activeDeployments(): List<DeploymentSummary> {
        val devices = _store.value.deviceList.orEmpty()
        return _store.value.deployments.value.orEmpty()
            .filter { Updates.isUnderWay(it) || Updates.stillFinishing(it, devices, now()) }
            .take(DEPLOYMENTS_ON_OVERVIEW)
    }

    private suspend fun readActiveDeployments() = coroutineScope {
        activeDeployments().map { async { loadDeployment(it.id) } }.awaitAll()
    }

    /** The boards and the open deployments as pollInterval takes them. */
    private fun fleetActivity(): List<String?> {
        val store = _store.value
        val devices = store.deviceList.orEmpty()
        val statuses = devices.map(Updates::deviceActivity).toMutableList()
        for (deployment in activeDeployments()) {
            val detail = store.deploymentDetails[deployment.id]?.value
            if (detail != null) statuses += detail.executions.map(Updates::executionActivity)
            else statuses += Updates.summaryActivity(deployment, devices)
            if (!Updates.isUnderWay(deployment)) statuses += "IN_PROGRESS"
        }
        return statuses
    }

    private fun settling(detail: Deployment): Boolean {
        val devices = _store.value.deviceList.orEmpty()
        return detail.executions.any { execution ->
            Updates.stillSettling(execution, devices.firstOrNull { it.thing == execution.thing }, detail.id, now())
        }
    }

    /** True while the page of a deployment that is over invites somebody to offer its release again. */
    private fun canBeOfferedAgain(detail: Deployment): Boolean {
        val store = _store.value
        val release = store.releases?.firstOrNull { it.version == detail.version }
        if (release != null && !release.isActive) return false
        return detail.executions.any { execution ->
            Updates.describeExecution(
                execution,
                board = store.deviceList?.firstOrNull { it.thing == execution.thing },
                deployment = detail.id,
                version = detail.version,
                unread = store.devices.value == null,
            ).retry
        }
    }

    /** Read what a page shows. `full` is false for a scheduled refresh, which skips what cannot have changed much. */
    suspend fun refresh(route: Route, full: Boolean) {
        if (_gate.value != Gate.Ready) return
        lastRefresh[route.key] = now()
        val store = _store.value
        when (route) {
            Route.Overview -> {
                val wasActive = activeDeployments().isNotEmpty()
                coroutineScope {
                    launch { loadDevices() }
                    launch { loadDeployments() }
                    if (due(store.firmware, full)) launch { loadFirmware() }
                    if (due(store.recent, full)) launch { loadRecent() }
                    if (updatesDue(store.updates, full)) launch { loadUpdates() }
                }
                // The last update is shown once nothing is in progress: read it again when the last deployment ends.
                if (wasActive && activeDeployments().isEmpty() && !Updates.noUpdatesRoute(_store.value.updates.error)) loadUpdates()
                readActiveDeployments()
            }
            Route.Boards -> {
                coroutineScope {
                    launch { loadDevices() }
                    launch { loadDeployments() }
                    if (due(store.firmware, full)) launch { loadFirmware() }
                }
                readActiveDeployments()
            }
            is Route.Board, is Route.BoardPage -> {
                val thing = if (route is Route.Board) route.thing else (route as Route.BoardPage).thing
                // Its updates of every kind, for the page's line about them and the update history.
                val history = route is Route.Board || (route as? Route.BoardPage)?.part == BoardPart.HISTORY
                refreshBoard(route, thing, history, full)
                // The board's page names a newer update than the list holds (read more than a few seconds ago): read the list again now.
                if (history) {
                    val newest = _store.value.deviceDetails[thing]?.value?.lastUpdate
                    val read = _store.value.boardUpdates[thing]
                    val first = read?.value?.updates?.firstOrNull()
                    val differs = first?.id != newest?.id || first?.outcome != newest?.outcome
                    if (newest != null && read?.value != null && differs && now() - read.loadedAt > 5_000) loadBoardUpdates(thing)
                }
            }
            Route.Firmware -> coroutineScope {
                launch { loadFirmware() }
                if (store.devices.loadedAt == 0L || full) launch { loadDevices() }
                if (_upload.value.step == UploadStep.DONE || store.deployments.loadedAt == 0L) launch { loadDeployments() }
            }
            Route.Deployments -> {
                coroutineScope {
                    launch { loadDeployments() }
                    if (due(store.firmware, full)) launch { loadFirmware() }
                }
                if (_store.value.deployments.value.orEmpty().any(Updates::isUnderWay) || _store.value.devices.loadedAt == 0L) loadDevices()
            }
            is Route.DeploymentPage -> refreshDeployment(route.id, full)
            is Route.ExecutionPage -> refreshDeployment(route.id, full)
            is Route.Release, Route.Upload -> coroutineScope {
                if (due(store.firmware, full)) launch { loadFirmware() }
                if (store.devices.loadedAt == 0L) launch { loadDevices() }
                if (store.deployments.loadedAt == 0L) launch { loadDeployments() }
            }
            is Route.ActivityEntry -> if (store.audit.loadedAt == 0L) loadAudit()
            is Route.TokenPage -> if (store.tokens.loadedAt == 0L) loadTokens()
            Route.SearchPage -> coroutineScope {
                // What there is to find: whatever has not been read yet.
                if (store.devices.loadedAt == 0L) launch { loadDevices() }
                if (store.firmware.loadedAt == 0L) launch { loadFirmware() }
                if (store.deployments.loadedAt == 0L) launch { loadDeployments() }
                if (store.audit.loadedAt == 0L) launch { loadAudit() }
            }
            is Route.HelpPage -> Unit
            Route.Activity -> {
                coroutineScope {
                    launch { loadAudit() }
                    if (due(store.deployments, full)) launch { loadDeployments() }
                }
                if (_store.value.devices.loadedAt == 0L) loadDevices()
            }
            Route.Events -> refreshEvents(full)
            Route.Tokens -> loadTokens()
            Route.History -> if (full || store.history.value == null) load({ it.history }, { copy(history = it) }) { it.history() }
            Route.Account -> loadMe()
            is Route.Bluetooth -> if (due(store.firmware, full)) loadFirmware()
            Route.More, Route.Serial -> Unit
        }
    }

    /** A board's page or one of its parts: the board, and what the page shows of the fleet. */
    private suspend fun refreshBoard(route: Route, thing: String, history: Boolean, full: Boolean) = coroutineScope {
        val store = _store.value
        launch { loadDetail(thing) }
        if (due(store.devices, full, Telemetry.DIAGNOSTICS_REFRESH_MS)) launch { loadDevices() }
        if (due(store.firmware, full)) launch { loadFirmware() }
        if (due(store.deployments, full)) launch { loadDeployments() }
        if (due(store.samples[thing] ?: Resource(), full, Telemetry.SAMPLES_REFRESH_MS)) launch { loadSamples(thing) }
        // The board's latest lines, on its own page only: every 30 s.
        if (route is Route.Board && due(store.boardLines[thing] ?: Resource(), full, BoardLog.RECENT_REFRESH_MS)) {
            launch { loadBoardLines(thing) }
        }
        if (history && updatesDue(store.boardUpdates[thing] ?: Resource(), full)) launch { loadBoardUpdates(thing) }
    }

    private suspend fun refreshDeployment(id: String, full: Boolean) {
        val before = _store.value.deploymentDetails[id]?.value?.executions?.joinToString(" ") { "${it.thing}:${it.phase}" }
        coroutineScope {
            launch { loadDeployment(id) }
            if (due(_store.value.firmware, full)) launch { loadFirmware() }
        }
        val detail = _store.value.deploymentDetails[id]?.value ?: return
        val phases = detail.executions.joinToString(" ") { "${it.thing}:${it.phase}" }
        if (full || _store.value.devices.loadedAt == 0L || phases != before || settling(detail)) loadDevices()
        // A board that runs what was cancelled may have got it from another deployment: its own list says.
        val runningIt = detail.executions.filter { it.status == "CANCELED" && it.reported == detail.version }
        coroutineScope {
            for (execution in runningIt) {
                val known = _store.value.deviceDetails[execution.thing]
                val outdated = known?.error != null || known?.value?.device?.fw?.version != execution.reported
                if (full || outdated) launch { loadDetail(execution.thing) }
            }
        }
        // Who cancelled it is in the log and not in the deployment's record.
        if (detail.status == "CANCELED" && due(_store.value.audit, full)) loadAudit()
    }

    /** How often a page is read again, in ms; 0 for not by itself. */
    fun intervalOf(route: Route): Long {
        val store = _store.value
        return when (route) {
            Route.Overview -> Updates.pollInterval(fleetActivity()).takeIf { it > 0 } ?: IDLE_REFRESH_MS
            Route.Boards -> minOf(Updates.pollInterval(fleetActivity()).takeIf { it > 0 } ?: IDLE_REFRESH_MS, Telemetry.DIAGNOSTICS_REFRESH_MS)
            is Route.Board, is Route.BoardPage -> {
                val thing = if (route is Route.Board) route.thing else (route as Route.BoardPage).thing
                val device = store.deviceDetails[thing]?.value?.device
                val active = device?.let { Updates.pollInterval(listOf(Updates.deviceActivity(it))) } ?: 0
                if (active > 0) minOf(active, Telemetry.DIAGNOSTICS_REFRESH_MS) else Telemetry.DIAGNOSTICS_REFRESH_MS
            }
            Route.Firmware -> IDLE_REFRESH_MS
            Route.Deployments -> {
                val devices = store.deviceList.orEmpty()
                Updates.pollInterval(store.deployments.value.orEmpty().map { Updates.summaryActivity(it, devices) })
            }
            is Route.DeploymentPage, is Route.ExecutionPage -> {
                val id = if (route is Route.DeploymentPage) route.id else (route as Route.ExecutionPage).id
                val detail = store.deploymentDetails[id]?.value ?: return 0
                val statuses = detail.executions.map(Updates::executionActivity).toMutableList<String?>()
                if (settling(detail)) statuses += "IN_PROGRESS"
                Updates.pollInterval(statuses).takeIf { it > 0 } ?: if (canBeOfferedAgain(detail)) IDLE_REFRESH_MS else 0
            }
            Route.Activity -> IDLE_REFRESH_MS
            Route.Events -> if (Telemetry.rangeOf(store.events.range, 0).live) Telemetry.EVENTS_REFRESH_MS else 0
            Route.Tokens -> IDLE_REFRESH_MS
            else -> 0
        }
    }

    /** Whether a scheduled refresh would be in the way: an open dialog, a file in hand, pages loaded by hand. */
    private fun holdStill(route: Route): Boolean {
        val store = _store.value
        return when (route) {
            Route.Firmware -> _dialog.value != null || _upload.value.inHand
            Route.Activity -> store.auditMoreLoading || (store.audit.value?.entries?.size ?: 0) > ACTIVITY_PAGE
            Route.Events -> store.events.moreLoading || store.events.linesMoreLoading || (store.events.data.value?.pages ?: 1) > 1 ||
                (store.events.data.value?.log?.pages ?: 1) > 1
            Route.Tokens -> _dialog.value != null
            else -> false
        }
    }

    /** Whether a page is due to be read again now. */
    fun due(route: Route): Boolean {
        val every = intervalOf(route)
        if (every <= 0 || holdStill(route)) return false
        return now() - (lastRefresh[route.key] ?: 0L) >= every
    }

    /** Read the page that is shown again now, in full. */
    fun refreshNow() {
        val route = _nav.value.route
        viewModelScope.launch { refresh(route, full = true) }
    }

    // The firmware on the phone.

    private suspend fun forgetFirmware() {
        withContext(Dispatchers.IO) { firmwareCache.clear() }
        _store.update { it.copy(cache = CacheSummary.EMPTY) }
    }

    private suspend fun showCache() {
        val summary = withContext(Dispatchers.IO) { firmwareCache.summary() }
        _store.update { it.copy(cache = summary) }
    }

    /** "Clear downloaded firmware": the next update downloads its image again. */
    fun clearFirmware() {
        viewModelScope.launch {
            forgetFirmware()
            notify("No firmware is kept on this phone now. The next update over Bluetooth downloads its image.")
        }
    }

    // The activity log.

    fun loadMoreActivity() {
        val page = _store.value.audit.value ?: return
        val next = page.next ?: return
        if (_store.value.auditMoreLoading) return
        val client = api ?: return
        _store.update { it.copy(auditMoreLoading = true, auditMoreError = null) }
        viewModelScope.launch {
            try {
                val more = client.audit(ACTIVITY_PAGE, next)
                _store.update { s ->
                    val current = s.audit.value ?: page
                    s.copy(audit = s.audit.copy(value = AuditPage(current.entries + more.entries, more.next)), auditMoreLoading = false)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: SignedOutException) {
                toSignIn(Messages.describe(e))
            } catch (e: Exception) {
                _store.update { it.copy(auditMoreLoading = false, auditMoreError = e) }
            }
        }
    }

    // Events.

    private suspend fun consoleEntries(client: ApiClient, fromMs: Long, toMs: Long): Pair<List<AuditEntry>, Boolean> {
        val entries = mutableListOf<AuditEntry>()
        var before: String? = null
        repeat(Telemetry.AUDIT_PAGES) {
            val read = client.audit(Telemetry.AUDIT_PAGE, before)
            for (entry in read.entries) {
                val ms = Times.parse(entry.at) ?: continue
                if (ms in fromMs..toMs) entries += entry
            }
            val last = read.entries.lastOrNull()
            if (read.next == null || last == null || (Times.parse(last.at) ?: 0) < fromMs) return entries to false
            before = read.next
        }
        return entries to true
    }

    private suspend fun refreshEvents(full: Boolean) {
        val page = _store.value.events
        val span = Telemetry.rangeOf(page.range, now())
        // Connections are read even while their markers are hidden: the online bands are drawn from them.
        val kinds = ApiJson.EVENT_KINDS.filter { it == "connection" || it !in page.hidden }
        val query = EventsQuery(
            from = Times.iso(span.fromMs),
            to = Times.iso(span.toMs),
            thing = page.thing.ifEmpty { null },
            kinds = if (kinds.size < ApiJson.EVENT_KINDS.size) kinds else null,
        )
        val devicesDue = full || _store.value.devices.loadedAt == 0L || now() - _store.value.devices.loadedAt > 25_000
        coroutineScope {
            launch {
                load({ it.events.data }, {
                    copy(events = events.copy(data = it, moreLoading = false, moreError = null, linesMoreLoading = false, linesMoreError = null))
                }) { client ->
                    coroutineScope {
                        val read = async { client.events(query.from, query.to, query.thing, query.kinds, null) }
                        val audit = async { if ("console" in page.hidden) null else consoleEntries(client, span.fromMs, span.toMs) }
                        val log = async { boardLogOf(client, page, span) }
                        val events: EventPage = read.await()
                        val console = audit.await()
                        EventsData(events.events, events.cursor, span, query, console?.first, console?.second ?: false, 1, log.await())
                    }
                }
            }
            if (devicesDue) launch { loadDevices() }
        }
    }

    /**
     * The board log of the range, as the page shows it (telemetry.js boardLogOf): null while it is
     * hidden, and its error, which leaves the events as they are, when it could not be read.
     */
    private suspend fun boardLogOf(client: ApiClient, page: EventsPage, span: Telemetry.TimeSpan): LogData? {
        if (!page.log) return null
        val asked = BoardLog.query(page.hidden, page.tag)
        val query = LogQuery(Times.iso(span.fromMs), Times.iso(span.toMs), page.thing.ifEmpty { null }, asked.kinds, asked.tags)
        if (asked.none) return LogData(query = query)
        return try {
            val read = client.boardLog(query.from, query.to, query.thing, query.kinds, query.tags)
            LogData(read.lines, read.cursor, query)
        } catch (e: CancellationException) {
            throw e
        } catch (e: SignedOutException) {
            throw e
        } catch (e: Exception) {
            LogData(query = query, error = e)
        }
    }

    fun loadMoreLines() {
        val page = _store.value.events
        val log = page.data.value?.log ?: return
        val cursor = log.cursor ?: return
        val query = log.query ?: return
        if (page.linesMoreLoading) return
        val client = api ?: return
        _store.update { it.copy(events = it.events.copy(linesMoreLoading = true, linesMoreError = null)) }
        viewModelScope.launch {
            try {
                val next = client.boardLog(query.from, query.to, query.thing, query.kinds, query.tags, cursor = cursor)
                _store.update { s ->
                    val data = s.events.data.value ?: return@update s
                    val now = data.log ?: return@update s
                    s.copy(
                        events = s.events.copy(
                            data = s.events.data.copy(
                                value = data.copy(log = now.copy(lines = now.lines + next.lines, cursor = next.cursor, pages = now.pages + 1)),
                            ),
                            linesMoreLoading = false,
                        ),
                    )
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: SignedOutException) {
                toSignIn(Messages.describe(e))
            } catch (e: Exception) {
                _store.update { it.copy(events = it.events.copy(linesMoreLoading = false, linesMoreError = e)) }
            }
        }
    }

    /** "Show the board log" and "Hide the board log". */
    fun toggleLog() {
        _store.update { it.copy(events = it.events.copy(log = !it.events.log)) }
        viewModelScope.launch { refresh(Route.Events, full = true) }
    }

    /** The one source the board log is narrowed to, "" for all of them. */
    fun chooseTag(tag: String) {
        _store.update { it.copy(events = it.events.copy(tag = if (tag in BoardLog.TAGS) tag else "")) }
        viewModelScope.launch { refresh(Route.Events, full = true) }
    }

    /** "All lines" on a board's page: Events, for that board, with its log shown. */
    fun openBoardLog(thing: String) {
        _store.update {
            it.copy(events = it.events.copy(thing = if (ApiJson.isThing(thing)) thing else "", log = true, selected = null))
        }
        open(Route.Events)
    }

    /** A board's newest lines of its own log, from the last 24 hours, for its page. */
    private suspend fun loadBoardLines(thing: String) {
        val to = now()
        load({ it.boardLines[thing] ?: Resource() }, { copy(boardLines = boardLines + (thing to it)) }) { client ->
            client.boardLog(Times.iso(to - BoardLog.RECENT_MS), Times.iso(to), thing = thing, limit = BoardLog.RECENT_COUNT)
        }
    }

    fun loadMoreEvents() {
        val page = _store.value.events
        val value = page.data.value ?: return
        val cursor = value.cursor ?: return
        if (page.moreLoading) return
        val client = api ?: return
        _store.update { it.copy(events = it.events.copy(moreLoading = true, moreError = null)) }
        viewModelScope.launch {
            try {
                val q = value.query
                val next = client.events(q.from, q.to, q.thing, q.kinds, cursor)
                _store.update { s ->
                    val data = s.events.data.value ?: value
                    s.copy(
                        events = s.events.copy(
                            data = s.events.data.copy(value = data.copy(events = data.events + next.events, cursor = next.cursor, pages = data.pages + 1)),
                            moreLoading = false,
                        ),
                    )
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _store.update { it.copy(events = it.events.copy(moreLoading = false, moreError = e)) }
            }
        }
    }

    private fun changeRange(range: Telemetry.Range, zooms: List<Telemetry.Range>) {
        _store.update { it.copy(events = it.events.copy(range = range, zooms = zooms, selected = null)) }
        viewModelScope.launch { refresh(Route.Events, full = true) }
    }

    fun choosePreset(id: String) = changeRange(Telemetry.Range.Last(id), emptyList())

    fun zoomTo(fromMs: Long, toMs: Long) {
        if (toMs - fromMs < Telemetry.SHORTEST_ZOOM) return
        val page = _store.value.events
        changeRange(Telemetry.Range.Span(fromMs, toMs), page.zooms + page.range)
    }

    fun zoomOut() {
        val page = _store.value.events
        changeRange(page.zooms.lastOrNull() ?: Telemetry.Range.Last("24h"), page.zooms.dropLast(1))
    }

    /** A range the person chose; null when it is one, else what is wrong with it. */
    fun applyCustomRange(fromMs: Long?, toMs: Long?): String? = when (val chosen = Telemetry.customRange(fromMs, toMs, now())) {
        is Telemetry.Custom.Wrong -> chosen.error
        is Telemetry.Custom.Ok -> {
            changeRange(Telemetry.Range.Span(chosen.fromMs, chosen.toMs), emptyList())
            null
        }
    }

    fun chooseEventBoard(thing: String) {
        _store.update { it.copy(events = it.events.copy(thing = if (ApiJson.isThing(thing)) thing else "", selected = null)) }
        viewModelScope.launch { refresh(Route.Events, full = true) }
    }

    fun toggleKind(id: String) {
        _store.update { s ->
            val hidden = s.events.hidden
            s.copy(events = s.events.copy(hidden = if (id in hidden) hidden - id else hidden + id, selected = null))
        }
        viewModelScope.launch { refresh(Route.Events, full = true) }
    }

    /** Pick an event on the Events page, as a search result leads there. */
    fun showEvent(key: String) {
        _store.update { it.copy(events = it.events.copy(selected = key)) }
    }

    fun selectEvent(key: String?) {
        _store.update { it.copy(events = it.events.copy(selected = if (it.events.selected == key) null else key)) }
    }

    // Uploading firmware.

    /** Read a chosen file: its name, its size, its SHA-256 and its header. Nothing is sent yet. */
    fun chooseFile(uri: Uri) {
        val mine = ++chosenFile
        viewModelScope.launch {
            val resolver = app.contentResolver
            val (name, size) = withContext(Dispatchers.IO) {
                runCatching {
                    resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                        if (cursor.moveToFirst()) {
                            val nameAt = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                            val sizeAt = cursor.getColumnIndex(OpenableColumns.SIZE)
                            (if (nameAt >= 0) cursor.getString(nameAt) else null) to (if (sizeAt >= 0 && !cursor.isNull(sizeAt)) cursor.getLong(sizeAt) else null)
                        } else {
                            null
                        }
                    }
                }.getOrNull() ?: (null to null)
            }
            val shown = name ?: uri.lastPathSegment ?: "image.signed.bin"
            val recorded = Words.recordedFilename(shown)
            if (size != null && size > LARGEST_FILE_READ) {
                _upload.value = UploadState(
                    UploadStep.READY, shown, recorded, size,
                    header = UploadReview.Header(false, "This file is far too large to be firmware for the board."),
                )
                uploadBytes = null
                return@launch
            }
            _upload.value = UploadState(UploadStep.READING, shown)
            val bytes = withContext(Dispatchers.IO) {
                runCatching {
                    resolver.openInputStream(uri)?.use { input ->
                        val data = input.readNBytesCompat(LARGEST_FILE_READ + 1)
                        data
                    }
                }.getOrNull()
            }
            if (mine != chosenFile) return@launch
            if (bytes == null) {
                _upload.value = UploadState(UploadStep.READY, shown, recorded, size ?: 0, header = UploadReview.Header(false, "The file could not be read."))
                uploadBytes = null
                return@launch
            }
            if (bytes.size > LARGEST_FILE_READ) {
                _upload.value = UploadState(
                    UploadStep.READY, shown, recorded, bytes.size.toLong(),
                    header = UploadReview.Header(false, "This file is far too large to be firmware for the board."),
                )
                uploadBytes = null
                return@launch
            }
            val digest = withContext(Dispatchers.Default) { ImageCheck.sha256Hex(bytes) }
            uploadBytes = bytes
            _upload.value = UploadState(
                UploadStep.READY, shown, recorded, bytes.size.toLong(), digest, UploadReview.readHeader(bytes),
            )
            if (_store.value.firmware.loadedAt == 0L) loadFirmware()
        }
    }

    fun setUploadNotes(text: String) = _upload.update { it.copy(notes = text.take(500)) }

    fun resetUpload() {
        chosenFile++
        uploadBytes = null
        _upload.value = UploadState()
    }

    /** Upload the chosen file for the server to verify, after a fresh sign-in if one is needed. */
    fun startUpload() {
        val state = _upload.value
        val bytes = uploadBytes ?: return
        if (state.step != UploadStep.READY && state.step != UploadStep.REFUSED) return
        _upload.value = state.copy(step = UploadStep.SENDING, sent = 0f, error = null)
        change(fail = { e ->
            _upload.update { it.copy(step = UploadStep.REFUSED, error = e) }
            viewModelScope.launch { loadFirmware() }
        }) { client ->
            val release = client.upload(state.recordedAs, Words.singleLine(state.notes), bytes) { stage, sent ->
                _upload.update { current ->
                    if (current.step != UploadStep.SENDING && current.step != UploadStep.CHECKING) current
                    else current.copy(step = if (stage == UploadStage.CHECKING) UploadStep.CHECKING else UploadStep.SENDING, sent = sent)
                }
            }
            uploadBytes = null
            _upload.value = UploadState(UploadStep.DONE, release = release)
            loadFirmware()
            loadDeployments()
        }
    }

    // Deploying.

    fun openDeploy(version: String?) {
        if (_store.value.me?.canWrite != true || _dialog.value != null) return
        _dialog.value = DialogState.Deploy(step = if (version != null) 1 else 0, version = version)
        reloadDeploy()
    }

    private fun updateDeploy(change: (DialogState.Deploy) -> DialogState.Deploy) {
        _dialog.update { d -> if (d is DialogState.Deploy) change(d) else d }
    }

    /** With a single board to choose from, it is ticked when the boards come up, until the person ticks by hand. */
    private fun suggest(d: DialogState.Deploy): DialogState.Deploy {
        if (d.chosenByHand || d.step != 1 || d.devices == null) return d
        val only = Updates.onlyChoice(d.devices, d.busy.keys, d.version)
        return d.copy(things = if (only == null) emptySet() else setOf(only))
    }

    fun reloadDeploy() {
        val client = api ?: return
        updateDeploy { it.copy(loading = true, loadError = null) }
        viewModelScope.launch {
            try {
                val (firmware, fleet) = coroutineScope {
                    val f = async { client.releases() }
                    val d = async { client.devices() }
                    f.await() to d.await()
                }
                _store.update {
                    it.copy(
                        firmware = Resource(firmware, null, now(), false),
                        devices = Resource(fleet, null, now(), false),
                    )
                }
                bluetooth.setReleases(firmware.releases)
                // Whether a board still has an update open is in the board's own record.
                val gate = Semaphore(REQUESTS_AT_ONCE)
                val busy = coroutineScope {
                    fleet.devices.map { device ->
                        async {
                            gate.withPermit {
                                val detail = client.deviceDetail(device.thing)
                                detail.executions.firstOrNull { Updates.isUnfinished(it.status) }?.let { open ->
                                    device.thing to BusyInfo(open.deployment, open.version ?: Updates.versionOfDeployment(open.deployment))
                                }
                            }
                        }
                    }.awaitAll().filterNotNull().toMap()
                }
                val releases = firmware.releases.filter { it.isActive }
                updateDeploy { d ->
                    var next = d.copy(releases = releases, devices = fleet.devices, busy = busy, things = d.things - busy.keys, loading = false)
                    if (releases.none { it.version == next.version }) {
                        // A release that was asked for and has gone is not silently replaced by another.
                        val gone = next.version
                        next = next.copy(gone = gone, version = if (gone == null) releases.firstOrNull()?.version else null, step = 0)
                    }
                    suggest(next)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: SignedOutException) {
                toSignIn(Messages.describe(e))
            } catch (e: Exception) {
                updateDeploy { it.copy(loading = false, loadError = e) }
            }
        }
    }

    fun deployChoose(version: String) = updateDeploy { it.copy(version = version, gone = null, error = null) }

    fun deployNext() = updateDeploy { suggest(it.copy(step = it.step + 1, error = null)) }

    fun deployBack() = updateDeploy { it.copy(step = (it.step - 1).coerceAtLeast(0), error = null) }

    fun deployNote(text: String) = updateDeploy { it.copy(note = text.take(200)) }

    fun deployToggle(thing: String) = updateDeploy { d ->
        val things = if (thing in d.things) d.things - thing else if (thing !in d.busy) d.things + thing else d.things
        d.copy(things = things, chosenByHand = true, error = null)
    }

    fun deployToggleAll() = updateDeploy { d ->
        val free = d.devices.orEmpty().filter { it.thing !in d.busy && !Updates.alreadyRuns(it, d.version) }.map { it.thing }
        val all = free.all { it in d.things }
        d.copy(things = if (all) emptySet() else d.things + free, chosenByHand = true, error = null)
    }

    fun submitDeploy() {
        val d = _dialog.value as? DialogState.Deploy ?: return
        val version = d.version ?: return
        if (d.things.isEmpty() || d.sending) return
        updateDeploy { it.copy(sending = true, error = null) }
        change(fail = { e ->
            updateDeploy { it.copy(sending = false, error = e, step = if (e is ApiError && e.code == "device_busy") 1 else it.step) }
            // A conflict says that what the dialog offers is out of date: read it again.
            if (e is ApiError && e.status == 409) reloadDeploy()
        }) { client ->
            val deployment = client.deploy(version, d.things.sorted(), Words.singleLine(d.note))
            _store.update { it.copy(deploymentDetails = it.deploymentDetails + (deployment.id to Resource(deployment, null, now(), false))) }
            _dialog.value = null
            notify("Deployment of ${deployment.version ?: version} started.")
            open(Route.DeploymentPage(deployment.id))
            viewModelScope.launch { loadDeployments() }
        }
    }

    // Cancelling.

    fun openCancel(id: String) {
        if (_store.value.me?.canWrite != true || _dialog.value != null) return
        _dialog.value = DialogState.Cancel(id)
    }

    fun cancelForce(force: Boolean) = _dialog.update { d -> if (d is DialogState.Cancel) d.copy(force = force) else d }

    fun submitCancel(force: Boolean) {
        val d = _dialog.value as? DialogState.Cancel ?: return
        if (d.sending) return
        val before = _store.value.deploymentDetails[d.id]?.value
        _dialog.value = d.copy(sending = true, error = null)
        change(fail = { e -> _dialog.update { it.cancelFailed(e) } }) { client ->
            val started = before?.executions?.count { it.status == "IN_PROGRESS" } ?: 0
            val updated = client.cancel(d.id, force)
            _store.update { it.copy(deploymentDetails = it.deploymentDetails + (updated.id to Resource(updated, null, now(), false))) }
            _dialog.value = null
            notify(Updates.cancelNotice(force, withdrawn = before?.status == "CANCELED", started = started))
            refreshNow()
        }
    }

    private fun DialogState?.cancelFailed(e: Throwable): DialogState? = if (this is DialogState.Cancel) copy(sending = false, error = e) else this

    // Revoking.

    fun openRevoke(version: String) {
        if (_store.value.me?.canWrite != true || _dialog.value != null) return
        _dialog.value = DialogState.Revoke(version)
    }

    fun revokeReason(text: String) = _dialog.update { d -> if (d is DialogState.Revoke) d.copy(reason = text.take(REASON_LIMIT), error = null) else d }

    fun submitRevoke() {
        val d = _dialog.value as? DialogState.Revoke ?: return
        if (d.sending) return
        val release = _store.value.releases?.firstOrNull { it.version == d.version } ?: return
        val again = !release.isActive
        val reason = if (again) Words.singleLine(release.revoked?.reason).ifEmpty { REPEATED_REASON } else Words.singleLine(d.reason)
        if (reason.isEmpty()) return
        _dialog.value = d.copy(sending = true, error = null)
        change(fail = { e -> _dialog.update { if (it is DialogState.Revoke) it.copy(sending = false, error = e) else it } }) { client ->
            var cancelled: List<String>? = null
            try {
                val done = client.revoke(d.version, reason)
                cancelled = done.cancelled
                _store.update { s ->
                    val list = s.firmware.value ?: return@update s
                    s.copy(firmware = s.firmware.copy(value = list.copy(releases = list.releases.map { if (it.version == done.release.version) done.release else it })))
                }
            } catch (e: ApiError) {
                // The server found it revoked and went through the steps after the mark: what was asked for.
                if (!(e.status == 409 && e.code == "already_revoked")) throw e
            }
            _dialog.value = null
            notify(Updates.revocationNotice(d.version, cancelled, again))
            refreshNow()
            // Revoking leaves a board that runs the release as it is. Whoever revokes should know which.
            loadDevices()
            val running = _store.value.deviceList.orEmpty().filter { it.fw?.version == d.version }
            if (running.isNotEmpty()) notify(Updates.stillRunning(running), Tone.WARN)
        }
    }

    // A release's note, changed after its upload (core.js setNotes): one line, at most 500 characters.

    fun openNotes(version: String) {
        if (_store.value.me?.canWrite != true || _dialog.value != null) return
        val release = _store.value.releases?.firstOrNull { it.version == version } ?: return
        _dialog.value = DialogState.Notes(version, release.notes)
    }

    fun notesText(text: String) = _dialog.update { d ->
        if (d is DialogState.Notes) d.copy(notes = text.take(NOTES_LIMIT), error = null) else d
    }

    fun submitNotes() {
        val d = _dialog.value as? DialogState.Notes ?: return
        if (d.sending) return
        val notes = Words.singleLine(d.notes).take(NOTES_LIMIT)
        _dialog.value = d.copy(sending = true, error = null)
        change(fail = { e -> _dialog.update { if (it is DialogState.Notes) it.copy(sending = false, error = e) else it } }) { client ->
            val changed = client.setNotes(d.version, notes)
            _store.update { s ->
                val list = s.firmware.value ?: return@update s
                s.copy(firmware = s.firmware.copy(value = list.copy(releases = list.releases.map { if (it.version == changed.version) changed else it })))
            }
            _dialog.value = null
            notify(if (changed.notes.isNotEmpty()) "The note of ${changed.version} is saved." else "The note of ${changed.version} is cleared.")
        }
    }

    // API tokens.

    fun openCreateToken() {
        if (_dialog.value != null) return
        _dialog.value = DialogState.CreateToken()
    }

    fun tokenName(text: String) = _dialog.update { d -> if (d is DialogState.CreateToken) d.copy(name = text.take(40), error = null) else d }

    fun tokenDays(text: String) = _dialog.update { d -> if (d is DialogState.CreateToken) d.copy(days = text.filter(Char::isDigit).take(3), error = null) else d }

    fun submitToken() {
        val d = _dialog.value as? DialogState.CreateToken ?: return
        val name = d.name.trim()
        val days = tokenDaysOf(d.days) ?: return
        if (name.isEmpty() || d.sending || d.made != null) return
        _dialog.value = d.copy(sending = true, error = null)
        change(fail = { e -> _dialog.update { if (it is DialogState.CreateToken) it.copy(sending = false, error = e) else it } }) { client ->
            val made = client.createToken(name, days)
            _dialog.update { if (it is DialogState.CreateToken) it.copy(sending = false, made = made) else it }
            loadTokens()
        }
    }

    fun openRevokeToken(token: ApiToken) {
        if (_dialog.value != null) return
        _dialog.value = DialogState.RevokeToken(token)
    }

    fun submitRevokeToken() {
        val d = _dialog.value as? DialogState.RevokeToken ?: return
        if (d.sending) return
        _dialog.value = d.copy(sending = true, error = null)
        change(fail = { e -> _dialog.update { if (it is DialogState.RevokeToken) it.copy(sending = false, error = e) else it } }) { client ->
            try {
                val revoked = client.revokeToken(d.token.id)
                _store.update { s ->
                    val list = s.tokens.value ?: return@update s
                    s.copy(tokens = s.tokens.copy(value = list.copy(tokens = list.tokens.map { if (it.id == revoked.id) revoked else it })))
                }
            } catch (e: ApiError) {
                // Revoked already, elsewhere: what was asked for is so.
                if (!(e.status == 409 && e.code == "token_already_revoked")) throw e
            }
            _dialog.value = null
            notify("Revoked the token “${d.token.name}”. A script that uses it is refused from now on.")
            loadTokens()
        }
    }

    fun closeDialog() {
        val d = _dialog.value ?: return
        if (d.sending) return
        _dialog.value = null
    }

    override fun onCleared() {
        bluetooth.stopEverything()
        usb.stop()
        auth?.dispose()
    }

    companion object {
        const val IDLE_REFRESH_MS = 30_000L
        const val KEEP_RULE_EVERY_MS = 60_000L
        const val RECENT_ENTRIES = 6
        const val ACTIVITY_PAGE = 50
        const val DEPLOYMENTS_ON_OVERVIEW = 4
        const val UPDATES_ON_OVERVIEW = 1
        const val REQUESTS_AT_ONCE = 4
        const val LARGEST_FILE_READ = 8 * 1024 * 1024
        const val REASON_LIMIT = 200
        const val NOTES_LIMIT = 500
        const val REPEATED_REASON = "Revocation applied again."

        /** A number of days the server takes for a token's life: 1 to 90. */
        fun tokenDaysOf(text: String): Int? = text.trim().takeIf { Regex("^\\d{1,3}$").matches(it) }?.toInt()?.takeIf { it in 1..90 }
    }
}

/** At most [limit] bytes of a stream (InputStream.readNBytes is API 33). */
private fun java.io.InputStream.readNBytesCompat(limit: Int): ByteArray {
    val out = java.io.ByteArrayOutputStream()
    val buffer = ByteArray(64 * 1024)
    var total = 0
    while (total < limit) {
        val n = read(buffer, 0, minOf(buffer.size, limit - total))
        if (n < 0) break
        out.write(buffer, 0, n)
        total += n
    }
    if (total == 0 && out.size() == 0) return ByteArray(0)
    return out.toByteArray()
}
