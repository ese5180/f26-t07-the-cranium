package com.craniumiot.cranium.ui

import android.app.Application
import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.SystemClock
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.craniumiot.cranium.CraniumConfig
import com.craniumiot.cranium.api.ApiClient
import com.craniumiot.cranium.auth.AuthManager
import com.craniumiot.cranium.auth.SignedOutException
import com.craniumiot.cranium.auth.TokenStore
import com.craniumiot.cranium.ble.BlePermissions
import com.craniumiot.cranium.ble.BoardScanner
import com.craniumiot.cranium.ble.BoardSession
import com.craniumiot.cranium.ble.FoundBoard
import com.craniumiot.cranium.core.ApiError
import com.craniumiot.cranium.core.ApiPaths
import com.craniumiot.cranium.core.BoardBluetooth
import com.craniumiot.cranium.core.BoardImages
import com.craniumiot.cranium.core.BoardProgressText
import com.craniumiot.cranium.core.FirmwareVersion
import com.craniumiot.cranium.core.ImageCheck
import com.craniumiot.cranium.core.ImageCheckResult
import com.craniumiot.cranium.core.ImageSlot
import com.craniumiot.cranium.core.Me
import com.craniumiot.cranium.core.Release
import com.craniumiot.cranium.core.ReleaseFilter
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.concurrent.atomic.AtomicInteger

enum class Step { STARTING, SIGN_IN, RELEASES, FIND_BOARD, BOARD, DONE }

enum class BluetoothStatus { UNKNOWN, NO_BLUETOOTH, NEEDS_PERMISSION, OFF, LOCATION_OFF, READY }

enum class BoardPhase { CONNECTING, READING, READY, DOWNLOADING, CHECKING, UPLOADING, FAILED }

data class Notice(val text: String, val isError: Boolean = true)

data class BoardUi(
    val name: String,
    val phase: BoardPhase = BoardPhase.CONNECTING,
    val passkey: String? = null,
    val passkeyNote: String? = null,
    val running: String? = null,
    val offer: List<Release> = emptyList(),
    val selected: String? = null,
    val sent: Int = 0,
    val total: Int = 0,
)

data class DoneUi(val version: String, val boardName: String, val status: String? = null)

data class UiState(
    val step: Step = Step.STARTING,
    val exampleConfig: Boolean = false,
    val busy: String? = null,
    val notice: Notice? = null,
    val me: Me? = null,
    val releases: List<Release> = emptyList(),
    val chosen: String? = null,
    val bluetooth: BluetoothStatus = BluetoothStatus.UNKNOWN,
    val scanning: Boolean = false,
    val boards: List<FoundBoard> = emptyList(),
    val board: BoardUi? = null,
    val done: DoneUi? = null,
)

/**
 * The whole flow: sign in, pick a release, find the board, pair, check what it runs, download and
 * check the image, upload it, and tell the person to press Button 1. See docs/mobile-apps.md.
 */
class CraniumViewModel(application: Application) : AndroidViewModel(application) {
    private val app = application
    private val config = CraniumConfig.fromBuild()
    private val scanner = BoardScanner(app)

    private var auth: AuthManager? = null
    private var api: ApiClient? = null

    private var session: BoardSession? = null
    private var linkLost = false
    private var thing: String? = null
    private var boardWork: Job? = null
    private var pairingPoll: Job? = null
    private var keepAlive: Job? = null
    private var scanTimer: Job? = null
    private var devicePoll: Job? = null

    private val _state = MutableStateFlow(UiState(exampleConfig = config.isExample))
    val state: StateFlow<UiState> = _state.asStateFlow()

    init {
        viewModelScope.launch {
            val manager = try {
                withContext(Dispatchers.IO) { AuthManager(app, config, TokenStore(app)) }
            } catch (e: Exception) {
                _state.update { it.copy(step = Step.SIGN_IN, notice = Notice("The app could not open its secure storage: ${e.message}")) }
                return@launch
            }
            auth = manager
            api = ApiClient(ApiPaths(config.consoleUrl), manager)
            if (manager.isSignedIn) loadReleases() else _state.update { it.copy(step = Step.SIGN_IN) }
        }
        viewModelScope.launch { scanner.boards.collect { boards -> _state.update { it.copy(boards = boards) } } }
        viewModelScope.launch {
            scanner.failure.collect { failure ->
                if (failure != null) _state.update { it.copy(scanning = false, notice = Notice(failure)) }
            }
        }
    }

    // ---- Signing in and out ------------------------------------------------------------------

    /** The sign-in page, or null (with a notice) if there is no browser to show it in. */
    fun signInIntent(): Intent? {
        val manager = auth ?: return null
        return try {
            manager.signInIntent()
        } catch (e: ActivityNotFoundException) {
            _state.update { it.copy(notice = Notice("There is no web browser on this phone to sign in with.")) }
            null
        }
    }

    fun onSignInResult(data: Intent?) {
        val manager = auth ?: return
        viewModelScope.launch {
            _state.update { it.copy(busy = "Signing in…", notice = null) }
            try {
                manager.completeSignIn(data)
                loadReleases()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(step = Step.SIGN_IN, busy = null, notice = Notice(Messages.describe(e))) }
            }
        }
    }

    fun signOut() {
        stopEverything()
        val manager = auth
        _state.value = UiState(step = Step.SIGN_IN, exampleConfig = config.isExample)
        if (manager != null) viewModelScope.launch { manager.signOut() }
    }

    // ---- Releases ------------------------------------------------------------------------------

    fun refreshReleases() {
        viewModelScope.launch { loadReleases() }
    }

    fun choose(version: String) {
        _state.update { it.copy(chosen = version) }
    }

    private suspend fun loadReleases() {
        val client = api ?: return
        _state.update { it.copy(step = Step.RELEASES, busy = "Loading the releases…", notice = null) }
        try {
            val me = client.me()
            val active = ReleaseFilter.active(client.releases().releases)
            _state.update { s ->
                s.copy(
                    busy = null,
                    me = me,
                    releases = active,
                    chosen = ReleaseFilter.preselect(active, s.chosen)?.version,
                    notice = if (active.isEmpty()) Notice("There is no active release on the console.", isError = false) else null,
                )
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            showFailure(e)
        }
    }

    // ---- Finding the board ---------------------------------------------------------------------

    fun toFindBoard() {
        _state.update { it.copy(step = Step.FIND_BOARD, notice = null, boards = emptyList(), board = null, done = null) }
        lookForBoards()
    }

    /** Check permissions and Bluetooth, and scan if they allow it. Called again after each prompt. */
    fun lookForBoards() {
        val status = when {
            !scanner.hasBluetooth -> BluetoothStatus.NO_BLUETOOTH
            !BlePermissions.granted(app) -> BluetoothStatus.NEEDS_PERMISSION
            !scanner.isBluetoothOn -> BluetoothStatus.OFF
            BlePermissions.locationNeededButOff(app) -> BluetoothStatus.LOCATION_OFF
            else -> BluetoothStatus.READY
        }
        _state.update { it.copy(bluetooth = status) }
        if (status == BluetoothStatus.READY || status == BluetoothStatus.LOCATION_OFF) startScan()
    }

    fun onPermissionDenied() {
        _state.update {
            it.copy(
                bluetooth = BluetoothStatus.NEEDS_PERMISSION,
                notice = Notice(
                    "Without the Bluetooth permission the app cannot find the board. If the phone no longer " +
                        "asks, allow it in Settings, under Apps, Cranium, Permissions.",
                ),
            )
        }
    }

    private fun startScan() {
        scanTimer?.cancel()
        if (!scanner.start()) {
            _state.update { it.copy(scanning = false, bluetooth = BluetoothStatus.OFF, notice = Notice(Messages.BLUETOOTH_OFF)) }
            return
        }
        _state.update { it.copy(scanning = true, notice = null) }
        scanTimer = viewModelScope.launch {
            delay(SCAN_MS)
            scanner.stop()
            _state.update { s ->
                s.copy(scanning = false, notice = if (s.boards.isEmpty()) Notice(Messages.NO_BOARD) else s.notice)
            }
        }
    }

    private fun stopScan() {
        scanTimer?.cancel()
        scanner.stop()
        _state.update { it.copy(scanning = false) }
    }

    // ---- The board -----------------------------------------------------------------------------

    fun connect(board: FoundBoard) {
        stopScan()
        closeSession()
        val name = board.name ?: board.address
        linkLost = false
        thing = null
        val newSession = BoardSession(app, board.device) { viewModelScope.launch { onLinkLost() } }
        session = newSession
        _state.update { it.copy(step = Step.BOARD, notice = null, board = BoardUi(name = name)) }
        startPairingPoll(board.name)
        boardWork = viewModelScope.launch {
            try {
                newSession.connect()
                updateBoard { it.copy(phase = BoardPhase.READING) }
                val slots = newSession.readImages()
                pairingPoll?.cancel()
                showImages(slots)
                startKeepAlive(newSession)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                boardFailed(Messages.connectFailure(e))
            }
        }
    }

    fun chooseOffer(version: String) {
        updateBoard { it.copy(selected = version) }
    }

    /** Download the chosen release, check it, and upload it. Nothing else is sent. */
    fun send() {
        val current = session ?: return
        val client = api ?: return
        val board = _state.value.board ?: return
        val release = board.offer.firstOrNull { it.version == board.selected } ?: return
        if (board.phase != BoardPhase.READY || boardWork?.isActive == true) return

        boardWork = viewModelScope.launch {
            val image: ByteArray
            try {
                _state.update { it.copy(notice = null) }
                updateBoard { it.copy(phase = BoardPhase.DOWNLOADING) }
                image = client.image(release)
                updateBoard { it.copy(phase = BoardPhase.CHECKING) }
                val check = withContext(Dispatchers.Default) { ImageCheck.check(image, release) }
                if (check is ImageCheckResult.Failed) {
                    backToReady("The image of ${release.version} failed a check, so nothing was sent. ${check.message}")
                    return@launch
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: SignedOutException) {
                stopEverything()
                _state.update { it.copy(step = Step.SIGN_IN, board = null, notice = Notice(Messages.describe(e))) }
                return@launch
            } catch (e: Exception) {
                backToReady("Could not get the image of ${release.version}. ${Messages.describe(e)}")
                return@launch
            }

            keepAlive?.cancelAndJoin()
            updateBoard { it.copy(phase = BoardPhase.UPLOADING, sent = 0, total = image.size) }
            val taken = AtomicInteger(0)
            try {
                current.upload(image) { sent, total ->
                    taken.set(sent)
                    updateBoard { it.copy(sent = sent, total = total) }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                boardFailed(Messages.uploadFailure(e, taken.get(), linkLost))
                return@launch
            }

            // All of it has arrived. The person installs it at the board; the app lets go.
            pairingPoll?.cancel()
            closeSession()
            _state.update {
                it.copy(step = Step.DONE, board = null, notice = null, done = DoneUi(release.version, board.name))
            }
            followBoard(release)
        }
    }

    fun cancelUpload() {
        boardWork?.cancel()
        stopBoardJobs()
        closeSession()
        _state.update {
            it.copy(
                step = Step.FIND_BOARD,
                board = null,
                boards = emptyList(),
                notice = Notice("Upload cancelled. To send an image, open a new window and connect again.", isError = false),
            )
        }
    }

    /** Leave the board (not during an upload) and look for boards again. */
    fun leaveBoard() {
        if (_state.value.board?.phase == BoardPhase.UPLOADING) return
        stopBoardJobs()
        closeSession()
        _state.update { it.copy(step = Step.FIND_BOARD, board = null, boards = emptyList(), notice = null) }
    }

    fun backToReleases() {
        stopEverything()
        _state.update { it.copy(board = null, done = null, boards = emptyList()) }
        viewModelScope.launch { loadReleases() }
    }

    fun dismissNotice() {
        _state.update { it.copy(notice = null) }
    }

    private fun showImages(slots: List<ImageSlot>) {
        val slot = BoardImages.running(slots)
        val running = slot?.let { FirmwareVersion.parseBoard(it.version) }
        if (running == null) {
            boardFailed("The board did not say which version it runs (slot 0: ${slot?.version?.ifEmpty { null } ?: "nothing"}).")
            return
        }
        val offer = ReleaseFilter.newerThan(_state.value.releases, running)
        _state.update { s ->
            s.copy(
                board = s.board?.copy(
                    phase = BoardPhase.READY,
                    running = running.toString(),
                    offer = offer,
                    selected = ReleaseFilter.preselect(offer, s.chosen)?.version,
                    passkey = null,
                    passkeyNote = null,
                ),
                notice = if (offer.isEmpty()) {
                    Notice("The board runs $running. No active release is newer, so there is nothing to send.", isError = false)
                } else {
                    null
                },
            )
        }
    }

    /**
     * Ask the console for the passkey while the phone pairs (docs/mobile-apps.md, step 5). A 404
     * means no online board has one: then it is on the board's serial console.
     */
    private fun startPairingPoll(name: String?) {
        pairingPoll?.cancel()
        val client = api ?: return
        if (name == null || !BoardBluetooth.isBoardName(name)) {
            updateBoard { it.copy(passkeyNote = Messages.PASSKEY_NO_NAME) }
            return
        }
        updateBoard { it.copy(passkeyNote = Messages.PASSKEY_ASKING) }
        pairingPoll = viewModelScope.launch {
            val until = SystemClock.elapsedRealtime() + PAIRING_POLL_MS
            while (isActive && SystemClock.elapsedRealtime() < until) {
                try {
                    val pairing = client.pairing(name)
                    if (pairing != null) {
                        thing = pairing.thing
                        updateBoard { it.copy(passkey = pairing.passkey, passkeyNote = null) }
                    } else {
                        updateBoard { it.copy(passkey = null, passkeyNote = Messages.PASSKEY_NOT_IN_CLOUD) }
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    val stop = e is SignedOutException || (e is ApiError && e.status == 403)
                    updateBoard {
                        it.copy(
                            passkey = null,
                            passkeyNote = "${Messages.describe(e)} The passkey is also on the board's serial console, the line [BT] passkey.",
                        )
                    }
                    if (stop) return@launch
                }
                delay(PAIRING_POLL_INTERVAL_MS)
            }
        }
    }

    /**
     * The board drops an authenticated link on which nothing happens for 30 s. While the person
     * chooses, and while the image downloads, read the image list now and then: it is allowed.
     */
    private fun startKeepAlive(current: BoardSession) {
        keepAlive?.cancel()
        keepAlive = viewModelScope.launch {
            while (isActive) {
                delay(KEEP_ALIVE_MS)
                try {
                    current.readImages()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // A lost link is reported by onLinkLost.
                }
            }
        }
    }

    /** After the upload: follow the board in the console, if the pairing call said which it is. */
    private fun followBoard(release: Release) {
        val client = api ?: return
        val target = FirmwareVersion.parseRelease(release.version) ?: return
        val boardThing = thing
        if (boardThing == null) {
            updateDone { it.copy(status = "The console did not say which board this is, so the app cannot follow it.") }
            return
        }
        devicePoll?.cancel()
        devicePoll = viewModelScope.launch {
            repeat(DEVICE_POLLS) {
                delay(DEVICE_POLL_INTERVAL_MS)
                val progress = try {
                    BoardProgressText.of(client.device(boardThing), target)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    null
                }
                if (progress != null) {
                    updateDone { it.copy(status = progress.text) }
                    if (progress.finished) return@launch
                }
            }
        }
    }

    private fun onLinkLost() {
        linkLost = true
        val state = _state.value
        val board = state.board ?: return
        if (state.step != Step.BOARD) return
        when (board.phase) {
            BoardPhase.CONNECTING, BoardPhase.READING -> boardFailed(Messages.PAIRING_FAILED)
            BoardPhase.UPLOADING -> boardFailed(Messages.DISCONNECTED_DURING_UPLOAD)
            BoardPhase.READY, BoardPhase.DOWNLOADING, BoardPhase.CHECKING -> boardFailed(Messages.DISCONNECTED)
            BoardPhase.FAILED -> Unit
        }
    }

    private fun boardFailed(message: String) {
        if (_state.value.board?.phase == BoardPhase.FAILED) return
        stopBoardJobs()
        closeSession()
        _state.update { s ->
            s.copy(board = s.board?.copy(phase = BoardPhase.FAILED, passkey = null, passkeyNote = null), notice = Notice(message))
        }
    }

    private fun backToReady(message: String) {
        updateBoard { it.copy(phase = BoardPhase.READY) }
        _state.update { it.copy(notice = Notice(message)) }
    }

    private fun showFailure(e: Throwable) {
        if (e is SignedOutException) {
            stopEverything()
            _state.update { it.copy(step = Step.SIGN_IN, busy = null, me = null, releases = emptyList(), notice = Notice(Messages.describe(e))) }
        } else {
            _state.update { it.copy(busy = null, notice = Notice(Messages.describe(e))) }
        }
    }

    private fun updateBoard(change: (BoardUi) -> BoardUi) {
        _state.update { s -> s.board?.let { s.copy(board = change(it)) } ?: s }
    }

    private fun updateDone(change: (DoneUi) -> DoneUi) {
        _state.update { s -> s.done?.let { s.copy(done = change(it)) } ?: s }
    }

    private fun stopBoardJobs() {
        boardWork?.cancel()
        pairingPoll?.cancel()
        keepAlive?.cancel()
    }

    private fun closeSession() {
        session?.close()
        session = null
    }

    private fun stopEverything() {
        stopScan()
        stopBoardJobs()
        devicePoll?.cancel()
        closeSession()
    }

    override fun onCleared() {
        stopEverything()
        auth?.dispose()
    }

    private companion object {
        const val SCAN_MS = 30_000L
        const val PAIRING_POLL_MS = 90_000L
        const val PAIRING_POLL_INTERVAL_MS = 3_000L
        const val KEEP_ALIVE_MS = 10_000L
        const val DEVICE_POLL_INTERVAL_MS = 15_000L
        const val DEVICE_POLLS = 48
    }
}
