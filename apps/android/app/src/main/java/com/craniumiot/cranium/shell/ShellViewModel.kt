package com.craniumiot.cranium.shell

import android.app.Application
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PersistableBundle
import android.view.HapticFeedbackConstants
import android.webkit.WebView
import androidx.core.content.FileProvider
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.webkit.JavaScriptReplyProxy
import com.craniumiot.cranium.BuildConfig
import com.craniumiot.cranium.CraniumConfig
import com.craniumiot.cranium.auth.KeystoreVault
import com.craniumiot.cranium.core.BiometricState
import com.craniumiot.cranium.core.PromptResult
import com.craniumiot.cranium.ui.PromptRequest
import com.craniumiot.cranium.ui.WindowGuard
import com.craniumiot.cranium.update.AppUpdater
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.util.Base64

/** How the shell's start went: still loading the bundle, ready to serve one, or no bundle at all. */
sealed interface ShellStart {
    data object Loading : ShellStart

    class Ready(val bundle: LaunchedBundle) : ShellStart

    /** Not even the built-in bundle checks out, or this phone's WebView cannot run the shell: the classic app, with why. */
    class Failed(val line: String) : ShellStart
}

/**
 * The new app (docs/mobile-apps.md, "The app shell"): one web view on the bundle's origin, served from the
 * bundle the store launched, and the bridge's handlers behind it (apps/shared/bridge.json). It outlives a
 * rotation; the activity shows what it asks for (a fingerprint prompt, a permission, a dialog).
 */
class ShellViewModel(application: Application) : AndroidViewModel(application) {
    private val app = application
    val config: CraniumConfig = CraniumConfig.fromBuild()
    val shellConfig = ShellConfig.of(config)
    private val prefs = ShellPrefs(app)
    private val store = BundleStore(File(app.noBackupFilesDir, "web"), AssetsBuiltIn(app.assets))
    private val fetcher = HttpFetcher()

    private val _start = MutableStateFlow<ShellStart>(ShellStart.Loading)
    val start: StateFlow<ShellStart> = _start.asStateFlow()

    @Volatile
    var launched: LaunchedBundle? = null
        private set

    val prompts = Asker<PromptRequest, PromptResult>()
    val offers = Asker<Boolean, Boolean>()
    val permissions = Asker<Array<String>, Boolean>()

    private val _settingsOpen = MutableStateFlow(false)
    val settingsOpen: StateFlow<Boolean> = _settingsOpen.asStateFlow()
    private val _lastCheck = MutableStateFlow<String?>(null)
    val lastCheck: StateFlow<String?> = _lastCheck.asStateFlow()
    private val _keepAwake = MutableStateFlow(false)
    val keepAwake: StateFlow<Boolean> = _keepAwake.asStateFlow()
    private val _guard = MutableStateFlow(WindowGuard.NONE)
    val guard: StateFlow<WindowGuard> = _guard.asStateFlow()
    private val _generation = MutableStateFlow(0)
    /** A new web view is made each time this changes: after its renderer went away. */
    val generation: StateFlow<Int> = _generation.asStateFlow()

    /** The web view while it is on screen (ShellWeb.kt), and the page's way back. Main thread only. */
    private var view: WebView? = null
    private var proxy: JavaScriptReplyProxy? = null

    val auth = ShellAuth(
        app, config, prompts, offers,
        onLocked = { pool -> emit("auth.locked", buildJsonObject { put("pool", pool) }) },
        onAdminSession = ::adminSession,
    )
    val ble = ShellBle(app, viewModelScope, ::emit) { asked -> permissions.ask(asked) }

    /** A board's USB serial port for the Serial console and Board setup (usb.*). */
    private val usbPorts: AndroidUsbPorts = AndroidUsbPorts(app) { usb.unplugged() }
    val usb: ShellUsb = ShellUsb(viewModelScope, ::emit, usbPorts)

    /** The app's own APK updates (update/), as in the classic app: the banner, the daily check, the notification. */
    val updater = AppUpdater(app, viewModelScope) { auth.adminTokens() }
    private var updaterChecked = false

    private val clipboard = ShellClipboard()
    private var checking: Job? = null

    /** What the pages keep through storage.* (PageStore): on this phone only, never backed up. */
    private val pages = PageStore(File(app.noBackupFilesDir, "page-store"))

    private val _canGoBack = MutableStateFlow(false)
    /** Whether the page has somewhere to go back to, for the back button (#/sessions/<id> to Sessions, and so on). */
    val canGoBack: StateFlow<Boolean> = _canGoBack.asStateFlow()

    val bridge = Bridge { features() }.apply {
        register("app.hello") {
            // A page that starts has no port open: those of the page before it are closed.
            usb.closeAll()
            ShellChecks.helloJson(BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE, launched, this@ShellViewModel.features(), store.needsNewerApp)
        }
        register("app.config") { ShellChecks.configJson(shellConfig) }
        register("app.ready") {
            launched?.let { bundle -> withContext(Dispatchers.IO) { store.markReady(bundle.manifest.id) } }
            EMPTY
        }
        register("app.reload") { reload() }
        register("app.open") { params ->
            val url = params.text("url")
            if (!ShellPolicy.openable(url)) throw BridgeError("not_allowed", "The app does not open that address.")
            if (!openOutside(url)) throw BridgeError("failed", "Nothing on this phone opens that address.")
            EMPTY
        }
        register("app.settings") {
            _settingsOpen.value = true
            EMPTY
        }
        register("app.keepAwake") { params ->
            _keepAwake.value = params.flag("on")
            EMPTY
        }
        register("auth.store") { params -> auth.store(params).also { guardWindow() } }
        register("auth.session") { params -> auth.session(params).also { guardWindow() } }
        register("auth.signOut") { params -> auth.signOut(params).also { guardWindow() } }
        register("biometric.status") { params -> auth.biometricStatus(params) }
        register("biometric.set") { params -> auth.biometricSet(params).also { guardWindow() } }
        register("clipboard.write") { params ->
            clipboard.write(params.text("text"), params.wholeOrNull("expiresIn"))
            EMPTY
        }
        register("haptics.play") { params ->
            haptic(params.text("kind"))
            EMPTY
        }
        register("file.share") { params -> share(params.text("name"), params.text("type"), params.text("data")) }
        register("storage.get") { params ->
            val value = withContext(Dispatchers.IO) { pages.get(params.text("key")) }
            buildJsonObject { put("value", value?.let(::JsonPrimitive) ?: JsonNull) }
        }
        register("storage.set") { params ->
            withContext(Dispatchers.IO) { pages.set(params.text("key"), params.text("value")) }
            EMPTY
        }
        register("storage.remove") { params ->
            withContext(Dispatchers.IO) { pages.remove(params.text("key")) }
            EMPTY
        }
        register("ble.state") { ble.state() }
        register("ble.scan") { params -> ble.scan(params) }
        register("ble.connect") { params -> ble.connect(params) }
        register("ble.images") { ble.images() }
        register("ble.upload") { params -> ble.upload(params) }
        register("ble.cancel") { ble.cancel() }
        register("ble.status") { ble.status() }
        register("ble.disconnect") { ble.disconnect() }
        register("ble.watch") { params -> ble.watch(params) }
        register("usb.open") { params -> usb.open(params) }
        register("usb.write") { params -> usb.write(params) }
        register("usb.close") { params -> usb.close(params) }
        register("update.check") {
            updater.check().join()
            val release = updater.ui.value.release
            buildJsonObject {
                if (release == null) {
                    put("available", JsonNull)
                } else {
                    put("available", buildJsonObject {
                        put("version", release.version)
                        put("note", release.notes)
                    })
                }
            }
        }
        register("update.install") {
            updater.install()
            EMPTY
        }
    }

    init {
        viewModelScope.launch {
            val bundle = withContext(Dispatchers.IO) { runCatching { store.launch() }.getOrNull() }
            if (bundle == null) {
                _start.value = ShellStart.Failed(
                    "The new app's pages could not be loaded on this phone, so this is the classic app. " +
                        "Reinstalling the app brings them back.",
                )
                return@launch
            }
            launched = bundle
            _start.value = ShellStart.Ready(bundle)
            // The first look for a newer bundle, once the page has had time to start.
            delay(FIRST_CHECK_DELAY_MS)
            checkForBundle(force = true)
        }
    }

    /** What this phone and this app offer the pages (app.hello's features). */
    fun features(): Set<String> {
        val all = linkedSetOf("auth", "clipboard", "haptics", "share", "open", "keepAwake", "settings", "appUpdate", "storage")
        val biometric = KeystoreVault.state(app)
        if (biometric != BiometricState.NO_HARDWARE && biometric != BiometricState.UNSUPPORTED) all += "biometric"
        if (ble.hasBluetooth) all += "ble"
        if (usb.available) all += "usb"
        return BridgeSpec.FEATURES.filter { it in all }.toSet()
    }

    fun fail(line: String) {
        _start.value = ShellStart.Failed(line)
    }

    // The page.

    /** A message from the page: only from the bundle's origin, in the main frame. */
    fun onMessage(text: String, origin: String, isMainFrame: Boolean, reply: JavaScriptReplyProxy) {
        if (!isMainFrame || origin != ShellPolicy.ORIGIN) return
        proxy = reply
        viewModelScope.launch {
            val answer = bridge.handle(text) ?: return@launch
            runCatching { reply.postMessage(answer) }
        }
    }

    /** An event for the page that is on screen, if it has spoken to the app yet. */
    fun emit(name: String, data: JsonObject) {
        val to = proxy ?: return
        viewModelScope.launch(Dispatchers.Main) { runCatching { to.postMessage(BridgeProtocol.event(name, data)) } }
    }

    fun attach(webView: WebView) {
        view = webView
    }

    fun detach(webView: WebView) {
        if (view === webView) {
            view = null
            proxy = null
            _canGoBack.value = false
        }
        ble.release()
        _keepAwake.value = false
    }

    /** The web view's history changed, a page's #/... route included: whether back has somewhere to go. */
    fun historyChanged(webView: WebView) {
        if (view === webView) _canGoBack.value = webView.canGoBack()
    }

    /** The back button, while the page has somewhere to go back to: as a browser's back does. */
    fun goBack() {
        val web = view ?: return
        if (web.canGoBack()) web.goBack()
        _canGoBack.value = web.canGoBack()
    }

    /**
     * A new page started loading in the main frame: what the old one had going stops. The way back to the
     * page is taken from each message, so the new page's first request replaces the old page's.
     */
    fun pageStarted() {
        ble.release()
        _keepAwake.value = false
    }

    fun rendererGone() {
        pageStarted()
        _generation.value += 1
    }

    private suspend fun reload(): JsonObject {
        val next = withContext(Dispatchers.IO) { runCatching { store.launch() }.getOrNull() }
        if (next != null) {
            launched = next
            _start.value = ShellStart.Ready(next)
        }
        view?.reload()
        return EMPTY
    }

    // The bundle.

    /** Look for a newer bundle on the console: at the start, and back in the foreground at most every 10 minutes. */
    fun checkForBundle(force: Boolean) {
        if (checking?.isActive == true) return
        val now = System.currentTimeMillis()
        if (!force && now - prefs.lastCheckMs < CHECK_EVERY_MS) return
        prefs.lastCheckMs = now
        val base = shellConfig.consoleUrl
        checking = viewModelScope.launch {
            val result = store.update(fetcher, "$base/app/manifest.json") { sha -> "$base/app/files/$sha" }
            _lastCheck.value = when (result) {
                is BundleUpdate.Taken -> "A newer version of the pages is ready (console ${result.manifest.consoleVersion ?: "unknown"}). It shows after Reload, or the next time the app starts."
                is BundleUpdate.UpToDate -> "The pages are up to date."
                is BundleUpdate.NeedsNewerApp -> "The console's pages need a newer version of this app: install the update from the console's Apps page."
                is BundleUpdate.Refused -> result.reason
                is BundleUpdate.Failed -> "The console could not be reached: ${result.reason}"
            }
            if (result is BundleUpdate.Taken) {
                emit("app.bundleReady", buildJsonObject {
                    put("id", result.manifest.id)
                    put("console", result.manifest.consoleVersion?.let(::JsonPrimitive) ?: JsonNull)
                })
            }
        }
    }

    fun closeSettings() {
        _settingsOpen.value = false
    }

    // The app in the foreground and the background.

    fun cameToForeground(nowMs: Long) {
        emit("app.lifecycle", buildJsonObject { put("state", "foreground") })
        viewModelScope.launch {
            auth.cameToForeground(nowMs)
            guardWindow()
        }
        clipboard.foreground()
        if (_start.value is ShellStart.Ready) checkForBundle(force = false)
    }

    fun wentToBackground(nowMs: Long) {
        auth.wentToBackground(nowMs)
        clipboard.background()
        emit("app.lifecycle", buildJsonObject { put("state", "background") })
    }

    private fun guardWindow() {
        _guard.value = if (auth.anyFingerprintOn) WindowGuard.NO_RECENTS else WindowGuard.NONE
    }

    /** The admin has a session: the app's own update check runs once a start, as the classic app's does. */
    private fun adminSession() {
        if (updaterChecked) return
        updaterChecked = true
        updater.check()
    }

    // What the page asks of the phone.

    /** An address for outside the app: the browser for https, else the app that takes the scheme. */
    fun openOutside(url: String): Boolean {
        if (!ShellPolicy.openable(url)) return false
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (url.startsWith("https:")) intent.addCategory(Intent.CATEGORY_BROWSABLE)
        return try {
            app.startActivity(intent)
            true
        } catch (e: ActivityNotFoundException) {
            false
        } catch (e: SecurityException) {
            false
        }
    }

    private fun haptic(kind: String) {
        val target = view ?: return
        val constant = when (kind) {
            "success" -> if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY
            "warning" -> HapticFeedbackConstants.LONG_PRESS
            "error" -> if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS
            "selection" -> HapticFeedbackConstants.CLOCK_TICK
            else -> HapticFeedbackConstants.VIRTUAL_KEY
        }
        target.performHapticFeedback(constant)
    }

    /** file.share: the file in cacheDir/shared, through ShareFileProvider, to Android's share sheet. */
    private suspend fun share(name: String, type: String, data: String): JsonObject {
        val bytes = try {
            Base64.getDecoder().decode(data)
        } catch (e: IllegalArgumentException) {
            throw BridgeError("bad_request", "data: not base64")
        }
        val dir = File(app.cacheDir, "shared")
        val file = withContext(Dispatchers.IO) {
            dir.deleteRecursively()
            dir.mkdirs()
            val target = File(dir, name)
            if (target.canonicalFile.parentFile != dir.canonicalFile) throw BridgeError("bad_request", "name: not a file name")
            target.writeBytes(bytes)
            target
        }
        val uri = FileProvider.getUriForFile(app, "${app.packageName}.share", file)
        val send = Intent(Intent.ACTION_SEND)
            .setType(type)
            .putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        send.clipData = ClipData.newRawUri(name, uri)
        val chooser = Intent.createChooser(send, name).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        val context = view?.context
        return try {
            if (context != null) context.startActivity(chooser) else app.startActivity(chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            buildJsonObject { put("shared", true) }
        } catch (e: ActivityNotFoundException) {
            buildJsonObject { put("shared", false) }
        }
    }

    /**
     * clipboard.write. With an expiry, as for the board's passkey: marked sensitive, so that Android hides it
     * in its clipboard preview, and taken off the clipboard after that time if it still holds the text (Android
     * lets an app read the clipboard only in the foreground, so a time that ends in the background is kept to then).
     */
    private inner class ShellClipboard {
        private val manager get() = app.getSystemService(ClipboardManager::class.java)
        private var clearJob: Job? = null
        private var due: Pair<String, Long>? = null
        private var inForeground = true

        fun write(text: String, expiresIn: Long?) {
            val clip = ClipData.newPlainText("Cranium", text)
            if (expiresIn != null && Build.VERSION.SDK_INT >= 33) {
                clip.description.extras = PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true) }
            }
            manager?.setPrimaryClip(clip) ?: throw BridgeError("failed", "The clipboard cannot be used.")
            clearJob?.cancel()
            due = null
            if (expiresIn == null) return
            due = text to System.currentTimeMillis() + expiresIn * 1000
            clearJob = viewModelScope.launch {
                delay(expiresIn * 1000)
                if (inForeground) clearIfDue()
            }
        }

        fun foreground() {
            inForeground = true
            clearIfDue()
        }

        fun background() {
            inForeground = false
        }

        private fun clearIfDue() {
            val (text, at) = due ?: return
            if (System.currentTimeMillis() < at) return
            due = null
            val clipboard = manager ?: return
            val holds = runCatching { clipboard.primaryClip?.getItemAt(0)?.text?.toString() }.getOrNull()
            if (holds != text) return
            if (Build.VERSION.SDK_INT >= 28) clipboard.clearPrimaryClip() else clipboard.setPrimaryClip(ClipData.newPlainText("", ""))
        }
    }

    override fun onCleared() {
        ble.release()
        usbPorts.release()
        CoroutineScope(Dispatchers.IO).launch { usb.closeAll() }
        auth.dispose()
        view = null
        proxy = null
    }

    private companion object {
        val EMPTY = JsonObject(emptyMap())
        const val CHECK_EVERY_MS = 10 * 60_000L
        const val FIRST_CHECK_DELAY_MS = 3_000L
    }
}
