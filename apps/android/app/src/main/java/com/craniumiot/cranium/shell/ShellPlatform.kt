package com.craniumiot.cranium.shell

import android.content.Context
import android.content.res.AssetManager
import androidx.core.content.FileProvider
import androidx.core.content.edit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.FileNotFoundException
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * The shell's own settings: whether the classic app (the native screens of 0.7) is shown instead of the
 * new one, and when the console was last asked for a newer bundle. Nothing in here is secret.
 */
class ShellPrefs(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    var classic: Boolean
        get() = prefs.getBoolean(KEY_CLASSIC, false)
        set(value) = prefs.edit { putBoolean(KEY_CLASSIC, value) }

    var lastCheckMs: Long
        get() = prefs.getLong(KEY_LAST_CHECK, 0)
        set(value) = prefs.edit { putLong(KEY_LAST_CHECK, value) }

    private companion object {
        const val FILE = "cranium_shell"
        const val KEY_CLASSIC = "classic_app"
        const val KEY_LAST_CHECK = "bundle_checked_at"
    }
}

/** The bundle built into the app (cloud/web/build-bundle.mjs, into assets/web/ at build time). */
class AssetsBuiltIn(private val assets: AssetManager) : BuiltInBundle {
    override fun manifestText(): String? = try {
        assets.open("web/manifest.json").use { it.readBytes().toString(Charsets.UTF_8) }
    } catch (e: FileNotFoundException) {
        null
    } catch (e: IOException) {
        null
    }

    override fun read(sha256: String): ByteArray? {
        if (!SHA256.matches(sha256)) return null
        return try {
            assets.open("web/files/$sha256").use { it.readBytes() }
        } catch (e: IOException) {
            null
        }
    }

    private companion object {
        val SHA256 = Regex("^[0-9a-f]{64}$")
    }
}

/**
 * The console's bundle over HTTPS only: no redirect is followed (a manifest or a file comes from the
 * console's own address or not at all), nothing is cached, 15 s to connect and to read, and never more
 * than the bytes asked for.
 */
class HttpFetcher : BundleFetcher {
    override suspend fun fetch(url: String, maxBytes: Long): ByteArray = withContext(Dispatchers.IO) {
        val address = URL(url)
        if (address.protocol != "https") throw IOException("Only HTTPS.")
        val connection = address.openConnection() as HttpURLConnection
        try {
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            connection.connectTimeout = TIMEOUT_MS
            connection.readTimeout = TIMEOUT_MS
            connection.setRequestProperty("Accept", "application/json, */*")
            connection.setRequestProperty("Cache-Control", "no-cache")
            val status = connection.responseCode
            if (status != 200) throw IOException("The console answered $status.")
            val declared = connection.contentLengthLong
            if (declared > maxBytes) throw IOException("Larger than expected.")
            connection.inputStream.use { input ->
                val out = ByteArrayOutputStream(if (declared in 1..maxBytes) declared.toInt() else 8192)
                val buffer = ByteArray(16 * 1024)
                var total = 0L
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    total += read
                    if (total > maxBytes) throw IOException("Larger than expected.")
                    out.write(buffer, 0, read)
                }
                out.toByteArray()
            }
        } finally {
            connection.disconnect()
        }
    }

    private companion object {
        const val TIMEOUT_MS = 15_000
    }
}

/** A file the page shares (file.share): cacheDir/shared only, read-only, granted per file. */
class ShareFileProvider : FileProvider()
