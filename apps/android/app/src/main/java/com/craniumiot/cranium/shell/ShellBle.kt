package com.craniumiot.cranium.shell

import android.content.Context
import com.craniumiot.cranium.ble.BlePermissions
import com.craniumiot.cranium.ble.BoardScanner
import com.craniumiot.cranium.ble.BoardSession
import com.craniumiot.cranium.ble.FoundBoard
import com.craniumiot.cranium.ble.OfflineLink
import com.craniumiot.cranium.ble.StatusClient
import com.craniumiot.cranium.ble.StatusFollower
import com.craniumiot.cranium.ui.Messages
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * The bridge's ble.* (apps/shared/bridge.json), on the classic app's Bluetooth pieces: BoardScanner for
 * boards that take an image, BoardSession (Nordic's MCUmgr: image list and a plain upload of image 0,
 * nothing else), StatusClient for the board's status characteristic on the link, and StatusFollower for
 * the board after its restart. The page runs the flow (cloud/web/src/site/assets/bluetooth.js): the
 * release, the passkey, the console's check before the send and the steps after it; this only does what
 * a page cannot. One board at a time. Everything runs on [scope], the main thread.
 *
 * On Android the phone asks for the passkey while the link is set up (BoardSession.connect), so
 * ble.connect answers at once and sets the link up behind it; ble.images waits for it, pairing included.
 */
class ShellBle(
    private val app: Context,
    private val scope: CoroutineScope,
    private val emit: (String, JsonObject) -> Unit,
    /** Asks for the runtime permissions; true when all are granted. */
    private val askPermissions: suspend (Array<String>) -> Boolean,
) {
    private val scanner = BoardScanner(app)
    private var scanJob: Job? = null
    private var board: FoundBoard? = null
    private var session: BoardSession? = null
    private var linking: Deferred<Unit>? = null
    private var upload: Deferred<Unit>? = null
    private var linkStatus: StatusClient? = null
    private var follower: StatusFollower? = null
    private var followJob: Job? = null
    /** The last session whose link went by itself. */
    private var dropped: BoardSession? = null

    val hasBluetooth: Boolean get() = scanner.hasBluetooth

    fun state(): JsonObject = buildJsonObject {
        put(
            "state",
            when {
                !scanner.hasBluetooth -> "unsupported"
                !BlePermissions.granted(app) -> "unauthorized"
                !scanner.isBluetoothOn -> "off"
                else -> "on"
            },
        )
    }

    /** Bluetooth there, allowed (asked for here the first time) and on; else why not. */
    private suspend fun ready() {
        if (!scanner.hasBluetooth) throw BridgeError("unavailable", "This phone has no Bluetooth LE.")
        if (!BlePermissions.granted(app) && !askPermissions(BlePermissions.required())) {
            throw BridgeError(
                "not_allowed",
                "Without the Bluetooth permission the app cannot find the board. If the phone no longer asks, " +
                    "allow it in Settings, under Apps, Cranium, Permissions.",
            )
        }
        if (!scanner.isBluetoothOn) throw BridgeError("failed", Messages.BLUETOOTH_OFF)
    }

    // ble.scan

    suspend fun scan(params: JsonObject): JsonObject {
        stopScan()
        if (!params.flag("on")) return EMPTY
        ready()
        if (!scanner.start()) throw BridgeError("failed", Messages.BLUETOOTH_OFF)
        scanJob = scope.launch {
            val collecting = launch { scanner.boards.collect { boards -> emit("ble.boards", boardsJson(boards)) } }
            // A scan is not left running: the page asks again if it still looks.
            delay(SCAN_MS)
            scanner.stop()
            collecting.cancel()
        }
        return EMPTY
    }

    private fun stopScan() {
        scanJob?.cancel()
        scanJob = null
        scanner.stop()
    }

    private fun boardsJson(boards: List<FoundBoard>) = buildJsonObject {
        put("boards", JsonArray(boards.map { found ->
            buildJsonObject {
                put("id", found.address)
                put("name", found.name?.let(::JsonPrimitive) ?: JsonNull)
                put("rssi", found.rssi)
            }
        }))
    }

    // ble.connect, ble.images

    suspend fun connect(params: JsonObject): JsonObject {
        if (offline != null) throw BridgeError("busy", "A board is connected in offline mode. Let it go first.")
        val id = params.text("id")
        val found = scanner.boards.value.firstOrNull { it.address == id }
            ?: throw BridgeError("failed", "That board is not in range any more. Look for it again.")
        ready()
        stopScan()
        closeLink()
        val name = found.name ?: found.address
        lateinit var opened: BoardSession
        opened = BoardSession(app, found.device) { scope.launch { linkLost(opened) } }
        board = found
        session = opened
        linking = scope.async {
            try {
                opened.connect()
                if (session === opened) emit("ble.link", link("connected", name, null))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (session === opened) emit("ble.link", link("disconnected", name, Messages.connectFailure(e)))
                throw e
            }
        }
        return buildJsonObject { put("name", name) }
    }

    private fun link(state: String, name: String, error: String?) = buildJsonObject {
        put("state", state)
        put("name", name)
        put("error", error?.let(::JsonPrimitive) ?: JsonNull)
    }

    private suspend fun linked(): BoardSession {
        val current = session ?: throw BridgeError("failed", "No board is connected.")
        try {
            linking?.await()
        } catch (e: CancellationException) {
            if (!currentCoroutineContext().isActive) throw e
            throw BridgeError("failed", Messages.PAIRING_FAILED)
        } catch (e: Exception) {
            throw BridgeError("failed", Messages.connectFailure(e))
        }
        if (session !== current) throw BridgeError("failed", "No board is connected.")
        return current
    }

    suspend fun images(): JsonObject {
        val current = linked()
        val slots = try {
            current.readImages()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            throw BridgeError("failed", Messages.connectFailure(e))
        }
        return ShellChecks.imagesJson(slots)
    }

    // ble.upload, ble.cancel

    suspend fun upload(params: JsonObject): JsonObject {
        if (upload?.isActive == true) throw BridgeError("busy", "An upload is under way.")
        val image = ShellChecks.uploadImage(params.text("image"), params.text("sha256"))
        val current = linked()
        val taken = AtomicInteger(0)
        val shownAt = AtomicLong(0)
        val job = scope.async {
            current.upload(image) { sent, total ->
                taken.set(sent)
                val now = System.currentTimeMillis()
                if (sent >= total || now - shownAt.get() >= PROGRESS_MS) {
                    shownAt.set(now)
                    scope.launch {
                        emit("ble.progress", buildJsonObject {
                            put("sent", sent)
                            put("total", total)
                        })
                    }
                }
            }
        }
        upload = job
        try {
            job.await()
        } catch (e: CancellationException) {
            if (!currentCoroutineContext().isActive) throw e
            throw BridgeError("cancelled", "The upload was stopped.")
        } catch (e: Exception) {
            throw BridgeError("failed", Messages.uploadFailure(e, taken.get(), dropped === current))
        } finally {
            if (upload === job) upload = null
        }
        return EMPTY
    }

    fun cancel(): JsonObject {
        upload?.cancel()
        return EMPTY
    }

    // ble.status

    /** The status characteristic on the link: the first read, and every notification after it as ble.status. */
    suspend fun status(): JsonObject {
        linked()
        val device = board?.device ?: throw BridgeError("failed", "No board is connected.")
        linkStatus?.close()
        val first = CompletableDeferred<ByteArray?>()
        lateinit var client: StatusClient
        client = StatusClient(
            app,
            device,
            scope,
            onStatus = {},
            onAbsent = { first.complete(null) },
            onGone = { first.complete(null) },
            onPayload = { raw, _ ->
                if (linkStatus === client && !first.complete(raw)) emit("ble.status", statusJson(raw, afterRestart = false))
            },
        )
        linkStatus = client
        client.open()
        val read = withTimeoutOrNull(STATUS_TIMEOUT_MS) { first.await() }
        return buildJsonObject {
            put("supported", read != null)
            put("payload", read?.let { JsonPrimitive(ShellChecks.base64(it)) } ?: JsonNull)
        }
    }

    private fun statusJson(raw: ByteArray, afterRestart: Boolean) = buildJsonObject {
        put("payload", ShellChecks.base64(raw))
        put("afterRestart", afterRestart)
    }

    // ble.watch

    suspend fun watch(params: JsonObject): JsonObject {
        stopWatch()
        if (!params.flag("on")) return EMPTY
        val version = params.textOrNull("version") ?: throw BridgeError("bad_request", "version: needed with on")
        val hash = params.textOrNull("hash")
        ready()
        val watching = StatusFollower(
            app,
            scope,
            accept = { status -> ShellChecks.aboutThisSend(status, version, hash) },
            onStatus = {},
            onPayload = { raw -> emit("ble.status", statusJson(raw, afterRestart = true)) },
        )
        follower = watching
        followJob = scope.launch {
            // Bluetooth off for a moment, or the scan refused: tried again until it works.
            var started = false
            while (isActive && follower === watching) {
                if (!started) started = watching.start()
                delay(WATCH_RETRY_MS)
            }
        }
        return EMPTY
    }

    private fun stopWatch() {
        followJob?.cancel()
        followJob = null
        follower?.stop()
        follower = null
    }

    // ble.disconnect, and the link going by itself

    fun disconnect(): JsonObject {
        closeLink()
        return EMPTY
    }

    private fun closeLink() {
        upload?.cancel()
        upload = null
        linking?.cancel()
        linking = null
        linkStatus?.close()
        linkStatus = null
        session?.close()
        session = null
        board = null
    }

    private fun linkLost(lost: BoardSession) {
        dropped = lost
        if (lost !== session) return
        val name = board?.name ?: board?.address ?: ""
        emit("ble.link", link("disconnected", name, null))
    }

    // ble.offline.*: offline mode (firmware 1.19.0), the console's Offline page. The page reads the status bytes
    // itself; this connects, pairs (Android's passkey box), hands over each status and writes the one accept.
    // Never at the same time as ble.connect's link.

    private var offline: OfflineLink? = null

    suspend fun offlineConnect(params: JsonObject): JsonObject {
        if (session != null) throw BridgeError("busy", "An update over Bluetooth has a board. Let it finish first.")
        if (offline != null) throw BridgeError("busy", "A board is connected already. Let it go first.")
        val id = params.text("id")
        val found = scanner.boards.value.firstOrNull { it.address == id }
            ?: throw BridgeError("failed", "That board is not in range any more. Look for it again.")
        ready()
        stopScan()
        lateinit var link: OfflineLink
        link = OfflineLink(
            app,
            found.device,
            scope,
            onPayload = { raw ->
                if (offline === link) emit("ble.offline.status", buildJsonObject { put("payload", ShellChecks.base64(raw)) })
            },
            onGone = { words ->
                if (offline === link) {
                    offline = null
                    emit("ble.offline.link", buildJsonObject {
                        put("state", "disconnected")
                        put("error", words)
                    })
                }
            },
        )
        offline = link
        val first = try {
            link.connect()
        } catch (e: CancellationException) {
            if (offline === link) offline = null
            link.close()
            throw e
        } catch (e: Exception) {
            val letGo = offline !== link
            if (!letGo) offline = null
            link.close()
            if (letGo) throw BridgeError("cancelled", "The board was let go.")
            throw BridgeError("failed", e.message ?: "The board did not answer.")
        }
        return buildJsonObject {
            put("name", found.name ?: found.address)
            put("payload", ShellChecks.base64(first))
        }
    }

    private fun offlineLinked(): OfflineLink = offline ?: throw BridgeError("failed", "No board is connected in offline mode.")

    /** The status read last (at most a few seconds old), and a read now, which comes as ble.offline.status. */
    fun offlineStatus(): JsonObject {
        val link = offlineLinked()
        val last = link.lastPayload ?: throw BridgeError("failed", "The board has not answered yet.")
        link.refresh()
        return buildJsonObject { put("payload", ShellChecks.base64(last)) }
    }

    suspend fun offlineAccept(params: JsonObject): JsonObject {
        val problem = offlineLinked().accept(params.text("version"))
        if (problem != null) throw BridgeError("failed", problem)
        return EMPTY
    }

    fun offlineDisconnect(): JsonObject {
        closeOffline()
        return EMPTY
    }

    private fun closeOffline() {
        val link = offline
        offline = null
        link?.close()
    }

    /** The page went (another page, a reload): whatever it had going stops. */
    fun release() {
        stopScan()
        stopWatch()
        closeLink()
        closeOffline()
    }

    private companion object {
        val EMPTY = JsonObject(emptyMap())
        const val SCAN_MS = 120_000L
        const val PROGRESS_MS = 250L
        const val STATUS_TIMEOUT_MS = 10_000L
        const val WATCH_RETRY_MS = 3_000L
    }
}
