package com.craniumiot.cranium.ble

import android.app.Application
import android.os.SystemClock
import com.craniumiot.cranium.api.ApiClient
import com.craniumiot.cranium.auth.SignedOutException
import com.craniumiot.cranium.core.ApiError
import com.craniumiot.cranium.core.BoardBluetooth
import com.craniumiot.cranium.core.BoardImages
import com.craniumiot.cranium.core.BoardProgressText
import com.craniumiot.cranium.core.FirmwareCache
import com.craniumiot.cranium.core.FirmwareVersion
import com.craniumiot.cranium.core.ImageCheck
import com.craniumiot.cranium.core.ImageOrigin
import com.craniumiot.cranium.core.ImageSlot
import com.craniumiot.cranium.core.ImageStep
import com.craniumiot.cranium.core.ObtainedImage
import com.craniumiot.cranium.core.Release
import com.craniumiot.cranium.core.ReleaseFilter
import com.craniumiot.cranium.ui.Messages
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
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

enum class BtStep { CHOOSE, FIND_BOARD, BOARD, DONE }

enum class BluetoothStatus { UNKNOWN, NO_BLUETOOTH, NEEDS_PERMISSION, OFF, LOCATION_OFF, READY }

/** CONFIRMING: asking the console, right before the upload, whether the image may still be sent. */
enum class BoardPhase { CONNECTING, READING, READY, DOWNLOADING, CHECKING, CONFIRMING, UPLOADING, FAILED }

data class BtNotice(val text: String, val isError: Boolean = true)

/** The image that is sent: from the phone, or downloaded just now, and its size. */
data class ImageNote(val origin: ImageOrigin, val bytes: Long)

data class BoardUi(
    val name: String,
    val phase: BoardPhase = BoardPhase.CONNECTING,
    val passkey: String? = null,
    val passkeyNote: String? = null,
    /** The board the console says is pairing under this name, shown with the passkey to catch a mix-up. */
    val consoleThing: String? = null,
    val running: String? = null,
    val offer: List<Release> = emptyList(),
    val selected: String? = null,
    val sent: Int = 0,
    val total: Int = 0,
    val image: ImageNote? = null,
)

data class DoneUi(val version: String, val boardName: String, val status: String? = null, val image: ImageNote? = null)

data class BtState(
    val step: BtStep = BtStep.CHOOSE,
    val notice: BtNotice? = null,
    /** The active releases, newest first: the ones that may be offered. */
    val releases: List<Release> = emptyList(),
    val chosen: String? = null,
    val bluetooth: BluetoothStatus = BluetoothStatus.UNKNOWN,
    val scanning: Boolean = false,
    val boards: List<FoundBoard> = emptyList(),
    val board: BoardUi? = null,
    val done: DoneUi? = null,
)

/**
 * The update over Bluetooth (docs/mobile-apps.md): pick a release, find the board, pair, check
 * what it runs, take the image from the phone or download it, check it, ask the console whether it
 * may still be sent, upload it, and tell the person to press Button 1.
 */
class BluetoothFlow(
    private val app: Application,
    private val scope: CoroutineScope,
    private val firmware: FirmwareCache,
    private val api: () -> ApiClient?,
    private val signedIn: () -> Boolean,
    /** The phone's sign-in is gone: the app goes back to its sign-in page. */
    private val onSignedOut: (String) -> Unit,
    /** The images on the phone changed: the app shows them again. */
    private val onCacheChanged: () -> Unit,
) {
    private val scanner = BoardScanner(app)

    private var session: BoardSession? = null
    private var linkLost = false
    private var thing: String? = null
    private var boardWork: Job? = null
    private var pairingPoll: Job? = null
    private var keepAlive: Job? = null
    private var scanTimer: Job? = null
    private var devicePoll: Job? = null

    private val _state = MutableStateFlow(BtState())
    val state: StateFlow<BtState> = _state.asStateFlow()

    init {
        scope.launch { scanner.boards.collect { boards -> _state.update { it.copy(boards = boards) } } }
        scope.launch {
            scanner.failure.collect { failure ->
                if (failure != null) _state.update { it.copy(scanning = false, notice = BtNotice(failure)) }
            }
        }
    }

    /** The releases on the console changed: keep only active ones, and the choice if it is still there. */
    fun setReleases(all: List<Release>) {
        val active = ReleaseFilter.active(all)
        _state.update { s -> s.copy(releases = active, chosen = ReleaseFilter.preselect(active, s.chosen)?.version) }
    }

    /** Start over with [version] chosen (from the Firmware page), at the step that picks it. */
    fun start(version: String?) {
        stopEverything()
        _state.update { s ->
            s.copy(
                step = BtStep.CHOOSE, notice = null, board = null, done = null, boards = emptyList(),
                // Kept even before the list has arrived: setReleases keeps it if it is active.
                chosen = version ?: ReleaseFilter.preselect(s.releases, null)?.version,
            )
        }
    }

    fun choose(version: String) = _state.update { it.copy(chosen = version) }

    fun dismissNotice() = _state.update { it.copy(notice = null) }

    // Finding the board.

    fun toFindBoard() {
        _state.update { it.copy(step = BtStep.FIND_BOARD, notice = null, boards = emptyList(), board = null, done = null) }
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
                notice = BtNotice(
                    "Without the Bluetooth permission the app cannot find the board. If the phone no longer " +
                        "asks, allow it in Settings, under Apps, Cranium, Permissions.",
                ),
            )
        }
    }

    private fun startScan() {
        scanTimer?.cancel()
        if (!scanner.start()) {
            _state.update { it.copy(scanning = false, bluetooth = BluetoothStatus.OFF, notice = BtNotice(Messages.BLUETOOTH_OFF)) }
            return
        }
        _state.update { it.copy(scanning = true, notice = null) }
        scanTimer = scope.launch {
            delay(SCAN_MS)
            scanner.stop()
            _state.update { s -> s.copy(scanning = false, notice = if (s.boards.isEmpty()) BtNotice(Messages.NO_BOARD) else s.notice) }
        }
    }

    private fun stopScan() {
        scanTimer?.cancel()
        scanner.stop()
        _state.update { it.copy(scanning = false) }
    }

    // The board.

    fun connect(board: FoundBoard) {
        stopScan()
        closeSession()
        val name = board.name ?: board.address
        linkLost = false
        thing = null
        val newSession = BoardSession(app, board.device) { scope.launch { onLinkLost() } }
        session = newSession
        _state.update { it.copy(step = BtStep.BOARD, notice = null, board = BoardUi(name = name)) }
        startPairingPoll(board.name)
        boardWork = scope.launch {
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

    fun chooseOffer(version: String) = updateBoard { it.copy(selected = version) }

    /**
     * Take the chosen release's image from the phone if it holds one that passes the check, else
     * download it and check it; ask the console whether it may still be sent; then upload it.
     * Nothing else is sent, and nothing at all without the console's answer.
     */
    fun send() {
        val current = session ?: return
        val client = api() ?: return
        val board = _state.value.board ?: return
        val release = board.offer.firstOrNull { it.version == board.selected } ?: return
        if (board.phase != BoardPhase.READY || boardWork?.isActive == true) return

        boardWork = scope.launch {
            val image: ByteArray
            val note: ImageNote
            try {
                _state.update { it.copy(notice = null) }
                // An image on the phone is only for a phone that is still signed in.
                if (!signedIn()) throw SignedOutException("Sign in to continue.")
                val obtained = firmware.obtain(
                    release,
                    onStep = { step ->
                        val phase = if (step == ImageStep.DOWNLOADING) BoardPhase.DOWNLOADING else BoardPhase.CHECKING
                        updateBoard { it.copy(phase = phase) }
                    },
                ) { client.image(release) }
                onCacheChanged()
                when (obtained) {
                    is ObtainedImage.Failed -> {
                        backToReady("The image of ${release.version} failed a check, so nothing was sent. ${obtained.failure.message}")
                        return@launch
                    }
                    is ObtainedImage.Ready -> {
                        image = obtained.image
                        note = ImageNote(obtained.origin, image.size.toLong())
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: SignedOutException) {
                stopEverything()
                _state.update { it.copy(step = BtStep.CHOOSE, board = null) }
                onSignedOut(Messages.describe(e))
                return@launch
            } catch (e: Exception) {
                backToReady("Could not get the image of ${release.version}. ${Messages.describe(e)}")
                return@launch
            }

            // The console's word, right before the upload, wherever the image came from: a release
            // may have been revoked since it was downloaded (docs/mobile-apps.md, step 6). Without
            // an answer, offline included, nothing is sent.
            try {
                updateBoard { it.copy(phase = BoardPhase.CONFIRMING) }
                val sha256 = withContext(Dispatchers.Default) { ImageCheck.sha256Hex(image) }
                client.confirmSend(release, sha256, board.name)
            } catch (e: CancellationException) {
                throw e
            } catch (e: SignedOutException) {
                stopEverything()
                _state.update { it.copy(step = BtStep.CHOOSE, board = null) }
                onSignedOut(Messages.describe(e))
                return@launch
            } catch (e: Exception) {
                backToReady(Messages.notCleared(release.version, e))
                return@launch
            }

            keepAlive?.cancelAndJoin()
            updateBoard { it.copy(phase = BoardPhase.UPLOADING, sent = 0, total = image.size, image = note) }
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
                it.copy(step = BtStep.DONE, board = null, notice = null, done = DoneUi(release.version, board.name, image = note))
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
                step = BtStep.FIND_BOARD,
                board = null,
                boards = emptyList(),
                notice = BtNotice("Upload cancelled. To send an image, open a new window and connect again.", isError = false),
            )
        }
    }

    /** Leave the board (not during an upload) and look for boards again. */
    fun leaveBoard() {
        if (_state.value.board?.phase == BoardPhase.UPLOADING) return
        stopBoardJobs()
        closeSession()
        _state.update { it.copy(step = BtStep.FIND_BOARD, board = null, boards = emptyList(), notice = null) }
    }

    /** Back to choosing a release. Not while an image is on its way. */
    fun backToChoose() {
        if (_state.value.board?.phase == BoardPhase.UPLOADING) return
        stopEverything()
        _state.update { it.copy(step = BtStep.CHOOSE, board = null, done = null, boards = emptyList()) }
    }

    val isBusy: Boolean get() = _state.value.board?.phase == BoardPhase.UPLOADING

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
                    BtNotice("The board runs $running. No active release is newer, so there is nothing to send.", isError = false)
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
        val client = api() ?: return
        if (name == null || !BoardBluetooth.isBoardName(name)) {
            updateBoard { it.copy(passkeyNote = Messages.PASSKEY_NO_NAME) }
            return
        }
        updateBoard { it.copy(passkeyNote = Messages.PASSKEY_ASKING) }
        pairingPoll = scope.launch {
            val until = SystemClock.elapsedRealtime() + PAIRING_POLL_MS
            while (isActive && SystemClock.elapsedRealtime() < until) {
                try {
                    val pairing = client.pairing(name)
                    if (pairing != null) {
                        thing = pairing.thing
                        val shown = pairing.thing.takeIf { BoardBluetooth.isThing(it) }
                        updateBoard { it.copy(passkey = pairing.passkey, passkeyNote = null, consoleThing = shown) }
                    } else {
                        updateBoard { it.copy(passkey = null, passkeyNote = Messages.PASSKEY_NOT_IN_CLOUD, consoleThing = null) }
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    val stop = e is SignedOutException || (e is ApiError && e.status == 403)
                    updateBoard {
                        it.copy(
                            passkey = null,
                            passkeyNote = "${Messages.describe(e)} The passkey is also on the board's serial console, the line [BT] passkey.",
                            consoleThing = null,
                        )
                    }
                    if (stop) return@launch
                }
                delay(PAIRING_POLL_INTERVAL_MS)
            }
        }
    }

    /**
     * The board drops an authenticated link on which nothing happens for a while. While the person
     * chooses, and while the image downloads, read the image list now and then: it is allowed.
     */
    private fun startKeepAlive(current: BoardSession) {
        keepAlive?.cancel()
        keepAlive = scope.launch {
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
        val client = api() ?: return
        val target = FirmwareVersion.parseRelease(release.version) ?: return
        val boardThing = thing
        if (boardThing == null) {
            updateDone { it.copy(status = "The console did not say which board this is, so the app cannot follow it.") }
            return
        }
        devicePoll?.cancel()
        devicePoll = scope.launch {
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
        if (state.step != BtStep.BOARD) return
        when (board.phase) {
            BoardPhase.CONNECTING, BoardPhase.READING -> boardFailed(Messages.PAIRING_FAILED)
            BoardPhase.UPLOADING -> boardFailed(Messages.DISCONNECTED_DURING_UPLOAD)
            BoardPhase.READY, BoardPhase.DOWNLOADING, BoardPhase.CHECKING, BoardPhase.CONFIRMING -> boardFailed(Messages.DISCONNECTED)
            BoardPhase.FAILED -> Unit
        }
    }

    private fun boardFailed(message: String) {
        if (_state.value.board?.phase == BoardPhase.FAILED) return
        stopBoardJobs()
        closeSession()
        _state.update { s ->
            s.copy(board = s.board?.copy(phase = BoardPhase.FAILED, passkey = null, passkeyNote = null), notice = BtNotice(message))
        }
    }

    private fun backToReady(message: String) {
        updateBoard { it.copy(phase = BoardPhase.READY) }
        _state.update { it.copy(notice = BtNotice(message)) }
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

    fun stopEverything() {
        stopScan()
        stopBoardJobs()
        devicePoll?.cancel()
        closeSession()
    }

    /** Signed out: nothing of the console is kept. */
    fun reset() {
        stopEverything()
        _state.value = BtState()
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
