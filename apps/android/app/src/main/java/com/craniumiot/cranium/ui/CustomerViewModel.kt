package com.craniumiot.cranium.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.craniumiot.cranium.CraniumConfig
import com.craniumiot.cranium.api.CustomerHttp
import com.craniumiot.cranium.auth.AuthManager
import com.craniumiot.cranium.auth.AuthSettings
import com.craniumiot.cranium.auth.CognitoHttp
import com.craniumiot.cranium.auth.KeystoreVault
import com.craniumiot.cranium.auth.SignedOutException
import com.craniumiot.cranium.auth.TokenStore
import com.craniumiot.cranium.core.AccountResult
import com.craniumiot.cranium.core.BiometricPolicy
import com.craniumiot.cranium.core.BiometricState
import com.craniumiot.cranium.core.CodeEntry
import com.craniumiot.cranium.core.CustomerAccount
import com.craniumiot.cranium.core.CustomerApi
import com.craniumiot.cranium.core.CustomerBoard
import com.craniumiot.cranium.core.CustomerBoardDetail
import com.craniumiot.cranium.core.CustomerEvent
import com.craniumiot.cranium.core.CustomerMe
import com.craniumiot.cranium.core.CustomerProfile
import com.craniumiot.cranium.core.CustomerText
import com.craniumiot.cranium.core.EnrolNext
import com.craniumiot.cranium.core.FingerprintLock
import com.craniumiot.cranium.core.FingerprintWords
import com.craniumiot.cranium.core.Glyph
import com.craniumiot.cranium.core.PromptResult
import com.craniumiot.cranium.core.SignInStep
import com.craniumiot.cranium.core.Tone
import com.craniumiot.cranium.core.UnlockNext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Which of the app's two sides is in front: the customer side, or admin mode (the console). */
enum class Side { STARTING, CUSTOMER, ADMIN }

/** The customer side's sections (customer-views.js SECTIONS). */
enum class CustomerTab(val label: String, val glyph: Glyph) {
    OVERVIEW(CustomerText.OVERVIEW, Glyph.GRID),
    DEVICES(CustomerText.DEVICES, Glyph.CHIP),
    MIXES(CustomerText.MIXES, Glyph.DISC),
    ACCOUNT(CustomerText.ACCOUNT, Glyph.USER),
    HELP(CustomerText.HELP, Glyph.HELP),
}

/** Before the customer side's pages: starting, the sign-in, a password reset, the lock screen, or the pages. */
sealed interface CustomerGate {
    data object Starting : CustomerGate

    data object SignIn : CustomerGate

    data object Forgot : CustomerGate

    data class Locked(val line: String? = null, val busy: Boolean = false) : CustomerGate

    /** The pages: a customer's, or with only an admin signed in, the admin's overview. */
    data object Frame : CustomerGate
}

enum class CustomerPhase { PASSWORD, CODE, NEW_PASSWORD, ELSEWHERE }

data class CustomerSignInForm(
    val phase: CustomerPhase = CustomerPhase.PASSWORD,
    val email: String = "",
    val code: String = "",
    val busy: Boolean = false,
    /** A key of SignInWords.WORDS, or of CustomerAccount.WORDS. */
    val problem: String? = null,
    val tries: Int = 0,
    /** Why the sign-in is shown, in place of its usual lead: "Your session has ended..." */
    val lead: String? = null,
    /** Why the app could not open its storage, or that this build has no customer pool. */
    val notice: String? = null,
)

enum class ForgotStep { EMAIL, CODE, DONE }

data class ForgotForm(
    val step: ForgotStep = ForgotStep.EMAIL,
    val email: String = "",
    val code: String = "",
    val busy: Boolean = false,
    val problem: String? = null,
    val tries: Int = 0,
)

/** Where the person is on the customer side: a section, and in Devices or from the overview one board. */
data class CustomerNav(val tab: CustomerTab = CustomerTab.OVERVIEW, val board: String? = null, val mixTab: String = "sessions")

/** What the customer API and Cognito said, as the site's state holds it. */
data class CustomerStore(
    val me: Resource<CustomerMe> = Resource(),
    val boards: Resource<List<CustomerBoard>> = Resource(),
    val activity: Resource<List<CustomerEvent>> = Resource(),
    val details: Map<String, Resource<CustomerBoardDetail>> = emptyMap(),
    val profile: Resource<CustomerProfile> = Resource(),
)

data class PasswordForm(val busy: Boolean = false, val problem: String? = null, val done: Boolean = false, val tries: Int = 0)

enum class AuthenticatorStep { IDLE, SECRET, CONFIRM_OFF }

data class AuthenticatorForm(
    val step: AuthenticatorStep = AuthenticatorStep.IDLE,
    val secret: String = "",
    val code: String = "",
    val busy: Boolean = false,
    val problem: String? = null,
    val done: String? = null,
    val tries: Int = 0,
)

/**
 * The customer side (docs/mobile-apps.md, "Customers"), as the customer site has it
 * (cloud/web/src/customer/assets/customer.js): who is signed in, the sign-in and a password reset,
 * what each section reads and how often, the account, and fingerprint unlock for the customer's own
 * sign-in. Admin mode is the console (ConsoleViewModel), with a session of its own: this side only
 * says which of the two is in front.
 *
 * A customer's session is kept apart from the staff session in every stored key (SessionKeys), is
 * sent to the customer API only, and its sign-out leaves the staff session to ConsoleViewModel.
 */
class CustomerViewModel(application: Application) : AndroidViewModel(application) {
    private val app = application
    private val config = CraniumConfig.fromBuild()

    /** Whether this build has the customer pool. Without it, only the admin sign-in works. */
    val available: Boolean = config.hasCustomer
    val exampleConfig: Boolean get() = config.isExample

    private var auth: AuthManager? = null
    private var api: CustomerApi? = null
    private var account: CustomerAccount? = null

    private val _side = MutableStateFlow(Side.STARTING)
    val side: StateFlow<Side> = _side.asStateFlow()

    private val _gate = MutableStateFlow<CustomerGate>(CustomerGate.Starting)
    val gate: StateFlow<CustomerGate> = _gate.asStateFlow()

    /** A customer is signed in (not only an admin). */
    private val _signedIn = MutableStateFlow(false)
    val signedIn: StateFlow<Boolean> = _signedIn.asStateFlow()

    private val _nav = MutableStateFlow(CustomerNav())
    val nav: StateFlow<CustomerNav> = _nav.asStateFlow()

    private val _store = MutableStateFlow(CustomerStore())
    val store: StateFlow<CustomerStore> = _store.asStateFlow()

    private val _signIn = MutableStateFlow(CustomerSignInForm())
    val signIn: StateFlow<CustomerSignInForm> = _signIn.asStateFlow()

    private val _forgot = MutableStateFlow(ForgotForm())
    val forgot: StateFlow<ForgotForm> = _forgot.asStateFlow()

    private val _password = MutableStateFlow(PasswordForm())
    val password: StateFlow<PasswordForm> = _password.asStateFlow()

    private val _authenticator = MutableStateFlow(AuthenticatorForm())
    val authenticator: StateFlow<AuthenticatorForm> = _authenticator.asStateFlow()

    private val _toasts = MutableStateFlow<List<Toast>>(emptyList())
    val toasts: StateFlow<List<Toast>> = _toasts.asStateFlow()
    private var toastId = 0L

    private val _prompt = MutableStateFlow<PromptRequest?>(null)
    val prompt: StateFlow<PromptRequest?> = _prompt.asStateFlow()
    private var promptId = 0L
    private var promptShown = 0L

    private val _offer = MutableStateFlow(false)
    val offer: StateFlow<Boolean> = _offer.asStateFlow()

    private val _fingerprint = MutableStateFlow(FingerprintUi())
    val fingerprint: StateFlow<FingerprintUi> = _fingerprint.asStateFlow()

    /** As the console's: the lock screen and the start are FLAG_SECURE; the pages with fingerprint unlock have no thumbnail. */
    val windowGuard: StateFlow<WindowGuard> = combine(_gate, _fingerprint) { gate, fingerprint ->
        when {
            gate is CustomerGate.Locked || gate == CustomerGate.Starting -> WindowGuard.SECURE
            gate == CustomerGate.Frame && fingerprint.on -> WindowGuard.NO_RECENTS
            else -> WindowGuard.NONE
        }
    }.stateIn(viewModelScope, SharingStarted.Eagerly, WindowGuard.SECURE)

    private var lastEmail = ""
    private var started = false
    private var staffHeld: Boolean? = null
    private var awaySince: Long? = null
    private var relockJob: Job? = null
    private var lockedFromPages = false

    init {
        viewModelScope.launch {
            val settings = AuthSettings.customer(config)
            if (settings != null) {
                try {
                    val manager = withContext(Dispatchers.IO) {
                        AuthManager(app, settings, TokenStore.customer(app), KeystoreVault(app, KeystoreVault.CUSTOMER_ALIAS))
                    }
                    auth = manager
                    api = CustomerApi(config.customerApiUrl, manager, CustomerHttp())
                    account = CustomerAccount(CognitoHttp(config.customerRegion), config.customerClientId) { currentToken() }
                } catch (e: Exception) {
                    _signIn.update { it.copy(notice = "The app could not open its secure storage: ${e.message}") }
                }
            } else {
                _signIn.update { it.copy(notice = CustomerText.NOT_SET_UP) }
            }
            showFingerprint()
            started = true
            decide()
        }
        // Without fingerprint unlock, the refresh token goes an hour after the sign-in.
        viewModelScope.launch {
            while (true) {
                delay(KEEP_RULE_EVERY_MS)
                auth?.enforceKeepRule()
            }
        }
    }

    // Which side is in front.

    /** What the console knows of the staff session: kept on the phone or not (ConsoleViewModel.held). */
    fun noteStaff(held: Boolean?) {
        if (held == null) return
        staffHeld = held
        decide()
    }

    private val adminHeld: Boolean get() = staffHeld == true

    /**
     * Where the app opens, once both sessions are known: a customer's session first (behind the
     * fingerprint if it is on), else admin mode for a staff session, else the customer sign-in.
     */
    private fun decide() {
        if (!started || staffHeld == null || _side.value != Side.STARTING) return
        val manager = auth
        when {
            manager != null && manager.needsUnlock -> {
                _side.value = Side.CUSTOMER
                lock(fromPages = false)
            }
            manager != null && manager.isSignedIn -> {
                _side.value = Side.CUSTOMER
                opened(fullSignIn = false)
            }
            adminHeld -> _side.value = Side.ADMIN
            else -> {
                _side.value = Side.CUSTOMER
                _gate.value = CustomerGate.SignIn
            }
        }
    }

    /** "Admin mode" and "Open admin mode": the console, signed in already. */
    fun openAdmin() {
        _side.value = Side.ADMIN
    }

    /** "Admin sign-in": the console's own sign-in screen. */
    fun adminSignIn() {
        _side.value = Side.ADMIN
    }

    /** "Leave admin mode": back here, the admin still signed in. */
    fun leaveAdmin() {
        _side.value = Side.CUSTOMER
        showCustomerSide()
    }

    /** "Customer sign-in", from the admin's sign-in or the admin's overview. */
    fun customerSignIn() {
        _side.value = Side.CUSTOMER
        if (_signedIn.value || _gate.value is CustomerGate.Locked) return
        _signIn.update { it.copy(phase = CustomerPhase.PASSWORD, busy = false, problem = null, lead = null) }
        _gate.value = CustomerGate.SignIn
    }

    /** The admin signed out in admin mode: the customer side, as it stands. */
    fun afterAdminSignOut() {
        staffHeld = false
        _side.value = Side.CUSTOMER
        showCustomerSide()
    }

    private fun showCustomerSide() {
        val gate = _gate.value
        when {
            _signedIn.value || gate is CustomerGate.Locked -> Unit
            gate == CustomerGate.Forgot -> Unit
            adminHeld -> _gate.value = CustomerGate.Frame
            else -> _gate.value = CustomerGate.SignIn
        }
    }

    // Signing in.

    fun signInEmail(text: String) {
        if (_signIn.value.busy) return
        _signIn.update { it.copy(email = text.take(320), problem = null) }
    }

    /** The password goes from the field to the proof and nowhere else. */
    fun submitPassword(password: String) {
        val manager = auth ?: return
        val form = _signIn.value
        if (form.busy || form.phase != CustomerPhase.PASSWORD) return
        lastEmail = form.email.trim()
        _signIn.update { it.copy(busy = true, problem = null) }
        viewModelScope.launch {
            after(guarded(SignInStep.Password("failed")) { manager.passwordSignIn(form.email, password) })
        }
    }

    fun codeChanged(text: String) {
        val form = _signIn.value
        if (form.busy) return
        val digits = CodeEntry.digits(text)
        _signIn.update { it.copy(code = digits, problem = null) }
        if (!CodeEntry.complete(form.code) && CodeEntry.complete(digits)) submitCode()
    }

    fun submitCode() {
        val manager = auth ?: return
        val form = _signIn.value
        if (form.busy || form.phase != CustomerPhase.CODE) return
        if (!CodeEntry.complete(form.code)) {
            _signIn.update { it.copy(problem = "short-code", tries = it.tries + 1) }
            return
        }
        _signIn.update { it.copy(busy = true, problem = null) }
        viewModelScope.launch { after(guarded(SignInStep.CodeProblem("failed")) { manager.sendCode(form.code) }) }
    }

    /** The new password of a first sign-in, typed twice: checked here first, as the website does. */
    fun submitNewPassword(next: String, again: String) {
        val manager = auth ?: return
        val form = _signIn.value
        if (form.busy || form.phase != CustomerPhase.NEW_PASSWORD) return
        val problem = CustomerAccount.passwordProblem(next, again)
        if (problem != null) {
            _signIn.update { it.copy(problem = problem, tries = it.tries + 1) }
            return
        }
        _signIn.update { it.copy(busy = true, problem = null) }
        viewModelScope.launch { after(guarded(SignInStep.NewPasswordProblem("failed")) { manager.sendNewPassword(next) }) }
    }

    private suspend fun guarded(otherwise: SignInStep, step: suspend () -> SignInStep): SignInStep = try {
        step()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        // Nothing of what went wrong is logged: it might hold what was typed.
        otherwise
    }

    private fun after(step: SignInStep) {
        when (step) {
            is SignInStep.Done -> {
                _signIn.value = CustomerSignInForm(email = lastEmail)
                opened(fullSignIn = true)
            }
            SignInStep.Code -> _signIn.update {
                it.copy(phase = CustomerPhase.CODE, busy = false, problem = null, code = "", tries = it.tries + 1)
            }
            is SignInStep.CodeProblem -> _signIn.update {
                it.copy(phase = CustomerPhase.CODE, busy = false, problem = step.problem, code = "", tries = it.tries + 1)
            }
            SignInStep.NewPassword -> _signIn.update {
                it.copy(phase = CustomerPhase.NEW_PASSWORD, busy = false, problem = null, tries = it.tries + 1)
            }
            is SignInStep.NewPasswordProblem -> _signIn.update {
                it.copy(phase = CustomerPhase.NEW_PASSWORD, busy = false, problem = step.problem, tries = it.tries + 1)
            }
            is SignInStep.Password -> _signIn.update {
                it.copy(phase = CustomerPhase.PASSWORD, busy = false, problem = step.problem, code = "", tries = it.tries + 1)
            }
            // The customer pool has no AWS sign-in page: a step this screen does not do is a new password by e-mail.
            is SignInStep.Elsewhere -> _signIn.update { it.copy(phase = CustomerPhase.ELSEWHERE, busy = false, problem = null) }
        }
    }

    /** "Start again": back to the password, dropping the sign-in that waits. */
    fun startOver() {
        if (_signIn.value.busy) return
        auth?.cancelPasswordSignIn()
        _signIn.update { it.copy(phase = CustomerPhase.PASSWORD, code = "", problem = null) }
    }

    // A forgotten password.

    fun openForgot() {
        auth?.cancelPasswordSignIn()
        _forgot.value = ForgotForm(email = lastEmail.ifEmpty { _signIn.value.email })
        _gate.value = CustomerGate.Forgot
    }

    fun closeForgot() {
        _signIn.update { it.copy(phase = CustomerPhase.PASSWORD, busy = false, problem = null, code = "", email = lastEmail.ifEmpty { it.email }) }
        _gate.value = CustomerGate.SignIn
    }

    fun forgotEmail(text: String) {
        if (_forgot.value.busy) return
        lastEmail = text.take(320)
        _forgot.update { it.copy(email = text.take(320), problem = null) }
    }

    fun submitForgotEmail() {
        val account = account ?: return
        val form = _forgot.value
        if (form.busy) return
        _forgot.update { it.copy(busy = true, problem = null) }
        viewModelScope.launch {
            when (val result = account.forgotPassword(form.email)) {
                is AccountResult.Ok -> _forgot.update { it.copy(step = ForgotStep.CODE, busy = false, code = "", tries = it.tries + 1) }
                is AccountResult.Failed -> _forgot.update { it.copy(busy = false, problem = result.problem, tries = it.tries + 1) }
            }
        }
    }

    /** The code of a reset goes with the new password, so it is not sent by itself. */
    fun forgotCodeChanged(text: String) {
        if (_forgot.value.busy) return
        _forgot.update { it.copy(code = CodeEntry.digits(text), problem = null) }
    }

    fun submitReset(next: String, again: String) {
        val account = account ?: return
        val form = _forgot.value
        if (form.busy) return
        val problem = if (CodeEntry.complete(form.code)) CustomerAccount.passwordProblem(next, again) else "short-code"
        if (problem != null) {
            _forgot.update { it.copy(problem = problem, tries = it.tries + 1) }
            return
        }
        _forgot.update { it.copy(busy = true, problem = null) }
        viewModelScope.launch {
            when (val result = account.confirmForgotPassword(form.email, form.code, next)) {
                is AccountResult.Ok -> _forgot.update { it.copy(step = ForgotStep.DONE, busy = false) }
                is AccountResult.Failed -> _forgot.update {
                    it.copy(busy = false, problem = result.problem, code = if (result.problem == "wrong-code") "" else it.code, tries = it.tries + 1)
                }
            }
        }
    }

    /** "Send another code". */
    fun forgotStartOver() {
        _forgot.update { it.copy(step = ForgotStep.EMAIL, problem = null, code = "") }
    }

    // The pages.

    /** Signed in, or opened with the fingerprint: the pages, and after a full sign-in the offer. */
    private fun opened(fullSignIn: Boolean) {
        _signedIn.value = true
        _gate.value = CustomerGate.Frame
        _side.value = Side.CUSTOMER
        showFingerprint()
        viewModelScope.launch {
            refresh(full = true)
            if (fullSignIn) afterFullSignIn()
        }
    }

    fun selectTab(tab: CustomerTab) {
        _nav.update { if (it.tab == tab) it.copy(board = null) else it.copy(tab = tab, board = null) }
    }

    /** One board, by its assignment id: never a thing name. */
    fun openBoard(id: String) {
        _nav.update { it.copy(tab = CustomerTab.DEVICES, board = id) }
    }

    fun chooseMixTab(id: String) {
        if (CustomerText.MIX_TABS.any { it.id == id }) _nav.update { it.copy(mixTab = id) }
    }

    /** Back: from a board to the list, then to the overview. False when there is nowhere to go back to. */
    fun back(): Boolean {
        val nav = _nav.value
        return when {
            nav.board != null -> {
                _nav.update { it.copy(board = null) }
                true
            }
            nav.tab != CustomerTab.OVERVIEW -> {
                _nav.update { it.copy(tab = CustomerTab.OVERVIEW) }
                true
            }
            else -> false
        }
    }

    private suspend fun <T> load(read: (CustomerStore) -> Resource<T>, write: CustomerStore.(Resource<T>) -> CustomerStore, fetch: suspend () -> T) {
        if (read(_store.value).loading) return
        _store.update { it.write(read(it).copy(loading = true)) }
        try {
            val value = fetch()
            _store.update { it.write(Resource(value, null, System.currentTimeMillis(), false)) }
        } catch (e: CancellationException) {
            _store.update { it.write(read(it).copy(loading = false)) }
            throw e
        } catch (e: SignedOutException) {
            _store.update { it.write(read(it).copy(loading = false)) }
            customerEnded(CustomerText.SESSION_ENDED)
        } catch (e: Exception) {
            _store.update { it.write(read(it).copy(loading = false, error = e)) }
        }
    }

    /** What the section in front shows (customer.js refresh): read when it opens, and every 30 s while it shows. */
    suspend fun refresh(full: Boolean) {
        val api = api ?: return
        if (!_signedIn.value) return
        val nav = _nav.value
        val jobs = mutableListOf<kotlinx.coroutines.Deferred<Unit>>()
        kotlinx.coroutines.coroutineScope {
            if (_store.value.me.value == null) jobs += async { load({ it.me }, { copy(me = it) }) { api.me() } }
            val board = nav.board
            if (nav.tab == CustomerTab.OVERVIEW || (nav.tab == CustomerTab.DEVICES && board == null)) {
                jobs += async { load({ it.boards }, { copy(boards = it) }) { api.boards() } }
            }
            if (nav.tab == CustomerTab.OVERVIEW) jobs += async { load({ it.activity }, { copy(activity = it) }) { api.activity() } }
            if (nav.tab == CustomerTab.DEVICES && board != null) {
                jobs += async {
                    load({ it.details[board] ?: Resource() }, { copy(details = details + (board to it)) }) { api.board(board) }
                }
            }
            if (nav.tab == CustomerTab.ACCOUNT && (full || _store.value.profile.value == null)) {
                jobs += async { load({ it.profile }, { copy(profile = it) }) { readProfile() } }
            }
            jobs.forEach { it.await() }
        }
    }

    fun refreshNow() {
        viewModelScope.launch { refresh(full = true) }
    }

    private suspend fun readProfile(): CustomerProfile = when (val result = account?.profile()) {
        is AccountResult.Ok -> result.value
        is AccountResult.Failed -> throw IllegalStateException(
            if (result.problem == "session-ended") "Your session has ended." else "Your account could not be read.",
        )
        null -> throw IllegalStateException("Your account could not be read.")
    }

    private suspend fun currentToken(): String? = try {
        auth?.accessToken()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        null
    }

    // The account page.

    fun changePassword(current: String, next: String, again: String) {
        val account = account ?: return
        if (_password.value.busy) return
        val problem = CustomerAccount.passwordProblem(next, again)
        if (problem != null) {
            _password.update { it.copy(problem = problem, done = false, tries = it.tries + 1) }
            return
        }
        _password.update { it.copy(busy = true, problem = null, done = false) }
        viewModelScope.launch {
            val result = account.changePassword(current, next)
            _password.update {
                it.copy(busy = false, problem = (result as? AccountResult.Failed)?.problem, done = result is AccountResult.Ok, tries = it.tries + 1)
            }
        }
    }

    fun startAuthenticator() {
        val account = account ?: return
        if (_authenticator.value.busy) return
        _authenticator.update { it.copy(busy = true, problem = null, done = null) }
        viewModelScope.launch {
            when (val result = account.startAuthenticator()) {
                is AccountResult.Ok -> _authenticator.update { it.copy(step = AuthenticatorStep.SECRET, secret = result.value, code = "", busy = false) }
                is AccountResult.Failed -> _authenticator.update { it.copy(busy = false, problem = result.problem, tries = it.tries + 1) }
            }
        }
    }

    /** The six boxes of the first code: the sixth digit sends it, as on the website. */
    fun authenticatorCode(text: String) {
        val form = _authenticator.value
        if (form.busy) return
        val digits = CodeEntry.digits(text)
        _authenticator.update { it.copy(code = digits, problem = null) }
        if (!CodeEntry.complete(form.code) && CodeEntry.complete(digits)) confirmAuthenticator()
    }

    fun confirmAuthenticator() {
        val account = account ?: return
        val form = _authenticator.value
        if (form.busy) return
        if (!CodeEntry.complete(form.code)) {
            _authenticator.update { it.copy(problem = "short-code", tries = it.tries + 1) }
            return
        }
        _authenticator.update { it.copy(busy = true, problem = null) }
        viewModelScope.launch {
            when (val result = account.confirmAuthenticator(form.code)) {
                is AccountResult.Failed -> _authenticator.update {
                    it.copy(busy = false, problem = result.problem, code = "", tries = it.tries + 1)
                }
                is AccountResult.Ok -> {
                    load({ it.profile }, { copy(profile = it) }) { readProfile() }
                    _authenticator.value = AuthenticatorForm(done = CustomerText.TWO_STEP_IS_ON)
                }
            }
        }
    }

    fun askToStopAuthenticator() {
        _authenticator.update { it.copy(step = AuthenticatorStep.CONFIRM_OFF, problem = null, done = null) }
    }

    fun stopAuthenticator() {
        val account = account ?: return
        if (_authenticator.value.busy) return
        _authenticator.update { it.copy(busy = true, problem = null) }
        viewModelScope.launch {
            when (val result = account.stopAuthenticator()) {
                is AccountResult.Ok -> {
                    load({ it.profile }, { copy(profile = it) }) { readProfile() }
                    _authenticator.value = AuthenticatorForm(done = CustomerText.TWO_STEP_IS_OFF)
                }
                is AccountResult.Failed -> _authenticator.update {
                    it.copy(step = AuthenticatorStep.CONFIRM_OFF, busy = false, problem = result.problem, tries = it.tries + 1)
                }
            }
        }
    }

    fun cancelAuthenticator() {
        _authenticator.value = AuthenticatorForm()
    }

    // Signing out, and a session that ended.

    /**
     * Sign out: the customer's session here, its refresh token revoked. The customer side's Sign out
     * ends the admin's too, as the customer site's does; that half is the console's (CraniumRoot).
     */
    fun signOut() {
        val manager = auth
        resetEverything()
        _signedIn.value = false
        staffHeld = false
        _side.value = Side.CUSTOMER
        _gate.value = CustomerGate.SignIn
        if (manager != null) {
            viewModelScope.launch {
                manager.signOut()
                showFingerprint()
            }
        }
    }

    /** The customer API no longer takes this session (customer.js customerEnded). */
    private fun customerEnded(lead: String) {
        if (!_signedIn.value) return
        _signedIn.value = false
        resetEverything()
        if (adminHeld) {
            _gate.value = CustomerGate.Frame
            notify(lead, Tone.WARN)
        } else {
            _signIn.value = CustomerSignInForm(email = lastEmail, lead = lead)
            _gate.value = CustomerGate.SignIn
        }
    }

    private fun resetEverything() {
        auth?.cancelPasswordSignIn()
        _store.value = CustomerStore()
        _nav.value = CustomerNav()
        _password.value = PasswordForm()
        _authenticator.value = AuthenticatorForm()
        _signIn.value = CustomerSignInForm(email = lastEmail, notice = _signIn.value.notice)
        _offer.value = false
        _prompt.value = null
    }

    // Fingerprint unlock, for the customer's own sign-in, by the same rules as the console's.

    private fun showFingerprint() {
        _fingerprint.update { it.copy(state = KeystoreVault.state(app), on = auth?.fingerprintOn == true) }
    }

    fun takePrompt(request: PromptRequest): Boolean {
        if (request.id <= promptShown) return false
        promptShown = request.id
        return true
    }

    fun onPrompt(result: PromptResult) {
        val request = _prompt.value ?: return
        _prompt.value = null
        viewModelScope.launch {
            when (request.purpose) {
                PromptPurpose.UNLOCK -> unlockNext(auth?.finishUnlock(result) ?: return@launch)
                PromptPurpose.ENROL, PromptPurpose.REKEY -> afterEnrolled(request.purpose, auth?.finishEnrol(result) ?: return@launch)
            }
        }
    }

    private fun ask(purpose: PromptPurpose, cipher: javax.crypto.Cipher) {
        _prompt.value = PromptRequest(++promptId, purpose, cipher, customer = true)
    }

    private fun lock(fromPages: Boolean) {
        lockedFromPages = fromPages
        _offer.value = false
        _gate.value = CustomerGate.Locked()
        unlock()
    }

    fun unlock() {
        val manager = auth ?: return
        val gate = _gate.value as? CustomerGate.Locked ?: return
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
            is UnlockNext.Open -> {
                val manager = auth ?: return
                _gate.value = CustomerGate.Locked(busy = true)
                try {
                    manager.accessToken(forceRefresh = true)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: SignedOutException) {
                    showFingerprint()
                    lockedFromPages = false
                    _signedIn.value = false
                    resetEverything()
                    _signIn.value = CustomerSignInForm(email = lastEmail, lead = FingerprintWords.ENDED)
                    _gate.value = CustomerGate.SignIn
                    return
                } catch (e: Exception) {
                    // Not reached: the pages say so, and the next read tries again.
                }
                if (lockedFromPages && _signedIn.value) {
                    lockedFromPages = false
                    _gate.value = CustomerGate.Frame
                    refreshNow()
                } else {
                    lockedFromPages = false
                    opened(fullSignIn = false)
                }
            }
            is UnlockNext.Locked -> _gate.value = CustomerGate.Locked(line = next.line)
            UnlockNext.Password -> signInWithPassword()
            is UnlockNext.Forget -> {
                auth?.forget()
                showFingerprint()
                lockedFromPages = false
                _signedIn.value = false
                resetEverything()
                _signIn.value = CustomerSignInForm(email = lastEmail, lead = next.line)
                _gate.value = CustomerGate.SignIn
            }
        }
    }

    /** "Sign in with password" on the lock screen: what is kept stays for the next time. */
    fun signInWithPassword() {
        _prompt.value = null
        lockedFromPages = false
        _signedIn.value = false
        resetEverything()
        _gate.value = CustomerGate.SignIn
        viewModelScope.launch { auth?.closeSession() }
    }

    private suspend fun afterFullSignIn() {
        val manager = auth ?: return
        showFingerprint()
        if (manager.fingerprintOn) {
            enrol(PromptPurpose.REKEY)
            return
        }
        val sub = subOf()
        val declined = sub.isNotEmpty() && manager.declinedOffer(sub)
        _offer.value = BiometricPolicy.offer(fullSignIn = true, _fingerprint.value.state, on = false, declined = declined)
    }

    /** Who the customer is, for "Not now": the address, as the customer API names them; never kept as such. */
    private fun subOf(): String = _store.value.me.value?.email.orEmpty().ifEmpty { lastEmail }.lowercase()

    fun answerOffer(yes: Boolean) {
        if (!_offer.value) return
        _offer.value = false
        val manager = auth ?: return
        val sub = subOf()
        viewModelScope.launch {
            if (yes) enrol(PromptPurpose.ENROL) else if (sub.isNotEmpty()) manager.declineOffer(sub)
        }
    }

    fun setFingerprint(on: Boolean) {
        val manager = auth ?: return
        if (_fingerprint.value.busy || _prompt.value != null) return
        viewModelScope.launch {
            if (on) {
                showFingerprint()
                if (_fingerprint.value.state == BiometricState.READY) enrol(PromptPurpose.ENROL)
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

    private fun afterEnrolled(purpose: PromptPurpose, next: EnrolNext) {
        showFingerprint()
        _fingerprint.update { it.copy(busy = false) }
        when (next) {
            is EnrolNext.On -> notify(FingerprintWords.ON)
            is EnrolNext.Off -> when {
                purpose == PromptPurpose.REKEY -> notify(FingerprintWords.OFF, Tone.WARN)
                next.line != null -> notify(next.line, Tone.BAD)
                else -> Unit
            }
        }
    }

    fun wentToBackground(nowMs: Long) {
        awaySince = nowMs
        relockJob?.cancel()
        relockJob = null
        if (auth?.fingerprintOn != true || _gate.value != CustomerGate.Frame || !_signedIn.value) return
        relockJob = viewModelScope.launch {
            delay(BiometricPolicy.RELOCK_AFTER_MS)
            if (_gate.value == CustomerGate.Frame && _signedIn.value && auth?.fingerprintOn == true) lock(fromPages = true)
        }
    }

    fun cameToForeground(nowMs: Long) {
        relockJob?.cancel()
        relockJob = null
        val since = awaySince
        awaySince = null
        showFingerprint()
        viewModelScope.launch { auth?.enforceKeepRule() }
        val gate = _gate.value
        if (gate == CustomerGate.Frame && _signedIn.value && BiometricPolicy.relock(auth?.fingerprintOn == true, since, nowMs)) {
            lock(fromPages = true)
        } else if (gate is CustomerGate.Locked && gate.line == null && since != null) {
            unlock()
        }
    }

    // Messages.

    fun notify(text: String, tone: Tone = Tone.GOOD) {
        val toast = Toast(++toastId, text, tone)
        _toasts.update { (it + toast).takeLast(3) }
        viewModelScope.launch {
            delay(TOAST_MS)
            dismissToast(toast.id)
        }
    }

    fun dismissToast(id: Long) = _toasts.update { list -> list.filter { it.id != id } }

    override fun onCleared() {
        auth?.dispose()
        super.onCleared()
    }

    companion object {
        /** customer.js REFRESH_MS. */
        const val REFRESH_MS = 30_000L
        private const val KEEP_RULE_EVERY_MS = 60_000L
        private const val TOAST_MS = 6_000L
    }
}
