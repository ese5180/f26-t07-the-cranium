package com.craniumiot.cranium.update

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import com.craniumiot.cranium.BuildConfig
import com.craniumiot.cranium.CraniumConfig
import com.craniumiot.cranium.api.AccessTokens
import com.craniumiot.cranium.ui.Messages
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException

/** Where an update is: offered, its link asked for, downloading, waiting for installs to be allowed, with the installer, or failed. */
enum class UpdateStep { OFFERED, LINKING, DOWNLOADING, ALLOW, INSTALLER, FAILED }

/** What the banner shows. [hidden] after "Later", until the app starts again. */
data class AppUpdateUi(
    val release: AppRelease? = null,
    val step: UpdateStep = UpdateStep.OFFERED,
    val percent: Int? = null,
    val line: String? = null,
    val hidden: Boolean = false,
    /** Android 13 or later, notifications not allowed, and never asked: the one polite question. */
    val askNotifications: Boolean = false,
) {
    val busy: Boolean get() = step == UpdateStep.LINKING || step == UpdateStep.DOWNLOADING
    val shown: Boolean get() = release != null && !hidden
}

/**
 * The app's own updates while it runs (ConsoleViewModel holds one): the check when the console
 * opens, the banner's state, and on a tap the download, the checks and Android's installer.
 *
 * Before anything is handed to the installer: the download answer must describe the APK as the
 * list did (version, size, SHA-256); the file must be that size with that SHA-256, checked as it
 * arrives and again right before the hand-over; and Android must read it as this app with that
 * versionCode and this app's signing key. A file that fails is deleted, and the banner says why.
 */
class AppUpdater(context: Context, private val scope: CoroutineScope, private val tokens: () -> AccessTokens?) {
    private val app = context.applicationContext
    private val consoleUrl = CraniumConfig.fromBuild().consoleUrl
    private val prefs by lazy { UpdatePrefs(app) }

    private val _ui = MutableStateFlow(AppUpdateUi())
    val ui: StateFlow<AppUpdateUi> = _ui.asStateFlow()

    private var checking: Job? = null
    private var work: Job? = null

    /**
     * On start, once signed in: keep the daily check scheduled, ask the console, and show what it
     * says. Quiet when the console cannot be asked: the next start, or the daily check, asks again.
     */
    fun check() {
        if (checking?.isActive == true) return
        checking = scope.launch {
            val ask = withContext(Dispatchers.IO) {
                runCatching { UpdateWorker.schedule(app) }
                UpdateNotifier.mayAsk(app, prefs)
            }
            _ui.update { it.copy(askNotifications = ask) }
            val auth = tokens() ?: return@launch
            val releases = try {
                UpdateApi(consoleUrl, auth).releases()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                return@launch
            }
            val found = AppUpdates.available(releases, BuildConfig.VERSION_CODE)
            // A download or an install under way keeps its file and what the banner says.
            if (work?.isActive == true || _ui.value.step == UpdateStep.ALLOW) return@launch
            withContext(Dispatchers.IO) {
                ApkFiles.clean(ApkInstaller.dir(app), keep = found?.localName)
                if (found == null) UpdateNotifier.clear(app) else UpdateNotifier.notifyOnce(app, prefs, found)
            }
            _ui.update { now ->
                when {
                    found == null -> AppUpdateUi(askNotifications = now.askNotifications)
                    now.release?.versionCode == found.versionCode -> now.copy(release = found)
                    else -> AppUpdateUi(release = found, askNotifications = now.askNotifications)
                }
            }
        }
    }

    /** The banner was tapped: download, check, and hand it to Android's installer. */
    fun install() {
        val release = _ui.value.release ?: return
        if (work?.isActive == true) return
        work = scope.launch {
            try {
                val dir = ApkInstaller.dir(app)
                val apk = File(dir, release.localName)
                // One downloaded before (say, before installs were allowed) is used again if it still checks out.
                val kept = withContext(Dispatchers.IO) { apk.isFile && ApkFiles.verify(apk, release) == null }
                if (kept || download(release, dir, apk)) handOver(release, apk)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                fail(describe(e))
            }
        }
    }

    /** "Later": the banner goes until the app starts again. The notification stays. */
    fun dismiss() = _ui.update { it.copy(hidden = true) }

    /** Back in the app: from Settings with installs now allowed, the installer is asked at once. */
    fun resumed() {
        val now = _ui.value
        if (now.step == UpdateStep.ALLOW && work?.isActive != true) {
            if (ApkInstaller.mayInstall(app)) {
                install()
            } else {
                _ui.update { it.copy(line = "Installs from Cranium are not allowed yet. Tap the update to open the setting again.") }
            }
        }
    }

    /** The person answered the one question about notifications, or is about to see Android's. */
    fun askedForNotifications() {
        _ui.update { it.copy(askNotifications = false) }
        scope.launch(Dispatchers.IO) { prefs.askedForNotifications = true }
    }

    /** Android's answer: allowed, and a version is offered, then its notification too. */
    fun notificationsAnswered(granted: Boolean) {
        val release = _ui.value.release
        if (granted && release != null) scope.launch(Dispatchers.IO) { UpdateNotifier.notifyOnce(app, prefs, release) }
    }

    /** True once [apk] is there and checked; else the banner says why not, and nothing is kept. */
    private suspend fun download(release: AppRelease, dir: File, apk: File): Boolean {
        val auth = tokens()
        if (auth == null) {
            fail("Sign in to download the update.")
            return false
        }
        _ui.update { it.copy(step = UpdateStep.LINKING, percent = null, line = null) }
        val api = UpdateApi(consoleUrl, auth)
        val link = api.link(release)
        AppUpdates.disagreement(release, link)?.let {
            fail(it)
            return false
        }
        _ui.update { it.copy(step = UpdateStep.DOWNLOADING, percent = 0) }
        val part = File(dir, release.localName + ".part")
        withContext(Dispatchers.IO) {
            ApkFiles.clean(dir)
            dir.mkdirs()
        }
        var shown = 0
        val arrived = try {
            api.fetch(link, part) { bytes ->
                val percent = (bytes * 100 / release.size).toInt().coerceIn(0, 100)
                if (percent != shown) {
                    shown = percent
                    _ui.update { it.copy(percent = percent) }
                }
            }
        } catch (e: Exception) {
            withContext(NonCancellable + Dispatchers.IO) { part.delete() }
            throw e
        }
        AppUpdates.fileProblem(release, arrived)?.let {
            withContext(Dispatchers.IO) { part.delete() }
            fail(it)
            return false
        }
        if (!withContext(Dispatchers.IO) { part.renameTo(apk) }) {
            withContext(Dispatchers.IO) { part.delete() }
            fail("The download could not be kept on this phone. Free some space, then tap the update again.")
            return false
        }
        return true
    }

    /** Checked once more, then to Android's installer, or first to the setting that allows it. */
    private suspend fun handOver(release: AppRelease, apk: File) {
        val problem = withContext(Dispatchers.IO) { ApkFiles.verify(apk, release) ?: ApkInstaller.mismatch(app, apk, release) }
        if (problem != null) {
            withContext(Dispatchers.IO) { apk.delete() }
            fail(problem)
            return
        }
        if (!ApkInstaller.mayInstall(app)) {
            _ui.update {
                it.copy(
                    step = UpdateStep.ALLOW, percent = null,
                    line = "Android asks once: allow installs from Cranium, then come back here and the update installs.",
                )
            }
            start(ApkInstaller.allowInstalls(app))
            return
        }
        if (start(ApkInstaller.install(app, apk))) {
            _ui.update {
                it.copy(step = UpdateStep.INSTALLER, percent = null, line = "Checked. Android's installer has it now; if it did not install, tap the update again.")
            }
        }
    }

    private fun start(intent: Intent): Boolean = try {
        app.startActivity(intent)
        true
    } catch (e: ActivityNotFoundException) {
        fail("This phone has nothing that installs apps from a file.")
        false
    }

    private fun fail(line: String) = _ui.update { it.copy(step = UpdateStep.FAILED, percent = null, line = line) }

    private fun describe(e: Exception): String = when {
        e is DownloadFailed -> e.message ?: "The APK could not be downloaded."
        e is IOException && _ui.value.step == UpdateStep.DOWNLOADING ->
            "The download stopped. Check the phone's connection, then tap the update again."
        else -> Messages.describe(e)
    }
}
