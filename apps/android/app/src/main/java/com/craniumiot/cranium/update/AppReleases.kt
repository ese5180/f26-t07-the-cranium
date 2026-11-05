package com.craniumiot.cranium.update

import com.craniumiot.cranium.core.J
import com.craniumiot.cranium.core.Person
import com.craniumiot.cranium.core.Words
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import java.io.File
import java.net.URI
import java.security.MessageDigest

/**
 * The app's own updates: the versions of the Android app published on the console's Apps page
 * (cloud/api/src/handlers/apps.mjs, docs/mobile-apps.md, "The Apps page"), which one is newer
 * than this build, and the checks an APK passes before Android's installer gets it. Nothing in
 * this file touches Android, so that all of it is tested on the JVM.
 */

/** One published version of the Android app, from `GET /api/apps` (lib/apps.mjs appReleaseFromItem). */
data class AppRelease(
    val version: String,
    /** What Android compares: an update installs only over a lower versionCode. */
    val versionCode: Int,
    val size: Long,
    /** The SHA-256 of the APK, 64 lower-case hex digits. */
    val sha256: String,
    /** The first paragraph of its changelog entry. */
    val notes: String = "",
    val filename: String = "",
    val publishedBy: Person? = null,
    val publishedAt: String? = null,
) {
    /** Its name on this phone: made from the version, which was checked, never from the server's text. */
    val localName: String get() = "cranium-android-$version.apk"
}

/**
 * `GET /api/apps/android/{version}/download`: a presigned S3 link to the APK, good for 15 minutes,
 * and the APK it is for. Whoever holds the link can download it, so it is never printed.
 */
data class AppDownload(
    val url: String,
    val expiresAt: String?,
    val version: String,
    val filename: String,
    val size: Long,
    val sha256: String,
) {
    override fun toString(): String = "AppDownload(version=$version, size=$size)"
}

/** What arrived from a download: its length and its SHA-256 in hex. */
data class Arrived(val size: Long, val sha256: String)

/**
 * Reading the two answers one field at a time, as core/Json.kt does: an answer whose outline is
 * wrong is an error ([IllegalArgumentException]); a release in the list that cannot be read is
 * left out, not the list.
 */
object AppReleaseJson {
    private val json = Json { ignoreUnknownKeys = true }

    /** As lib/apps.mjs APP_VERSION: three numbers with dots, such as 0.6.0. */
    private val VERSION = Regex("^(0|[1-9]\\d{0,2})\\.(0|[1-9]\\d{0,2})\\.(0|[1-9]\\d{0,4})$")
    private val HEX64 = Regex("^[0-9a-f]{64}$")

    /** The server takes APKs of at most 100 MB (MAX_APK_BYTES); more than twice that is not this app. */
    const val MAX_SIZE = 200L * 1024 * 1024

    /** The highest versionCode the server takes (MAX_VERSION_CODE). */
    const val MAX_VERSION_CODE = 2_100_000_000

    private const val MAX_URL = 8192

    fun isVersion(text: String?): Boolean = text != null && VERSION.matches(text)

    fun isSha256(text: String?): Boolean = text != null && HEX64.matches(text)

    private fun root(text: String): JsonObject =
        runCatching { json.parseToJsonElement(text) }.getOrNull() as? JsonObject
            ?: throw IllegalArgumentException("The console's answer is not a JSON object")

    /** `GET /api/apps`: the Android app's releases, newest first as the server sorts them. */
    fun releases(text: String): List<AppRelease> {
        val android = J.obj(root(text)["android"]) ?: throw IllegalArgumentException("The answer has no Android app")
        val items = J.arr(android["releases"]) ?: throw IllegalArgumentException("The answer has no list of the Android app's versions")
        return items.mapNotNull(::release)
    }

    /** One release of the list, or null if any of what the phone relies on is missing or odd. */
    fun release(value: JsonElement?): AppRelease? {
        val item = J.obj(value) ?: return null
        val version = J.str(item["version"])?.takeIf(::isVersion) ?: return null
        val code = J.int(item["versionCode"], 1, MAX_VERSION_CODE) ?: return null
        val size = J.whole(item["size"], 1, MAX_SIZE) ?: return null
        val sha256 = J.str(item["sha256"])?.takeIf(::isSha256) ?: return null
        return AppRelease(
            version = version,
            versionCode = code,
            size = size,
            sha256 = sha256,
            notes = Words.singleLine(J.text(item["notes"], 500)),
            filename = J.text(item["filename"], 128),
            publishedBy = J.person(item["publishedBy"]),
            publishedAt = J.instant(item["publishedAt"]),
        )
    }

    /** `GET /api/apps/android/{version}/download`. Every field is needed: a link without them is not used. */
    fun download(text: String): AppDownload {
        val item = J.obj(root(text)["download"]) ?: throw IllegalArgumentException("The answer has no download link")
        val url = J.str(item["url"])?.takeIf(::isHttpsUrl)
            ?: throw IllegalArgumentException("The download link is not an https address")
        val version = J.str(item["version"])?.takeIf(::isVersion)
            ?: throw IllegalArgumentException("The download link names no version")
        val size = J.whole(item["size"], 1, MAX_SIZE) ?: throw IllegalArgumentException("The download link gives no size")
        val sha256 = J.str(item["sha256"])?.takeIf(::isSha256)
            ?: throw IllegalArgumentException("The download link gives no SHA-256")
        return AppDownload(url, J.instant(item["expiresAt"]), version, J.text(item["filename"], 128), size, sha256)
    }

    /** An https address with a host and no user name in it. */
    fun isHttpsUrl(text: String): Boolean {
        if (text.length > MAX_URL) return false
        val uri = runCatching { URI(text) }.getOrNull() ?: return false
        return uri.scheme.equals("https", ignoreCase = true) && !uri.host.isNullOrEmpty() && uri.rawUserInfo == null
    }
}

/** Which release is newer than this build, and whether a download is the APK it claims to be. */
object AppUpdates {
    /** The newest: the highest versionCode, which is what Android compares. The first listed on a tie. */
    fun newest(releases: List<AppRelease>): AppRelease? = releases.maxByOrNull { it.versionCode }

    /** The newest release if its versionCode is above [installedCode] (BuildConfig.VERSION_CODE), else null. */
    fun available(releases: List<AppRelease>, installedCode: Int): AppRelease? =
        newest(releases)?.takeIf { it.versionCode > installedCode }

    /** A notification for [release], unless one was posted for this versionCode, or a higher one, already. */
    fun shouldNotify(release: AppRelease, lastNotifiedCode: Int): Boolean = release.versionCode > lastNotifiedCode

    /** What the banner and the notification say. */
    fun title(release: AppRelease): String = "Update available: ${release.version}"

    fun headline(release: AppRelease): String =
        if (release.notes.isEmpty()) title(release) else "${title(release)} — ${release.notes}"

    /**
     * The download answer must describe the same APK as the list did: the same version, size and
     * SHA-256. Null if it does, else why not, in words.
     */
    fun disagreement(release: AppRelease, download: AppDownload): String? = when {
        download.version != release.version ->
            "The console offered ${download.version} for ${release.version}, so nothing was downloaded."
        download.size != release.size ->
            "The console gave two sizes for ${release.version}, so nothing was downloaded."
        !download.sha256.equals(release.sha256, ignoreCase = true) ->
            "The console gave two SHA-256 digests for ${release.version}, so nothing was downloaded."
        else -> null
    }

    /** The APK that arrived must be exactly the one described. Null if it is, else why not, in words. */
    fun fileProblem(release: AppRelease, arrived: Arrived): String? = when {
        arrived.size != release.size ->
            "The download of ${release.version} was ${arrived.size} bytes, not ${release.size}. It was deleted and nothing was installed."
        !arrived.sha256.equals(release.sha256, ignoreCase = true) ->
            "The download of ${release.version} does not have the SHA-256 the console gave. It was deleted and nothing was installed."
        else -> null
    }
}

/** SHA-256 in lower-case hex, as the console writes it. */
object Sha256 {
    private const val DIGITS = "0123456789abcdef"

    fun hex(bytes: ByteArray): String {
        val out = CharArray(bytes.size * 2)
        for ((i, byte) in bytes.withIndex()) {
            val b = byte.toInt() and 0xFF
            out[2 * i] = DIGITS[b shr 4]
            out[2 * i + 1] = DIGITS[b and 0x0F]
        }
        return String(out)
    }

    fun of(bytes: ByteArray): String = hex(MessageDigest.getInstance("SHA-256").digest(bytes))

    /** A file's length and SHA-256, read once. */
    fun of(file: File): Arrived {
        val digest = MessageDigest.getInstance("SHA-256")
        var total = 0L
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buffer)
                if (n < 0) break
                digest.update(buffer, 0, n)
                total += n
            }
        }
        return Arrived(total, hex(digest.digest()))
    }
}

/** The APKs kept in the app's cache while one is checked and installed (cacheDir/updates). */
object ApkFiles {
    /** Null if [file] is the APK of [release], byte for byte as described; else why not. */
    fun verify(file: File, release: AppRelease): String? =
        if (!file.isFile) "The download of ${release.version} is gone. Tap the update to download it again." else AppUpdates.fileProblem(release, Sha256.of(file))

    /** Delete every file in [dir] but the one named [keep]: older versions, and downloads cut short. */
    fun clean(dir: File, keep: String? = null) {
        dir.listFiles()?.forEach { if (it.name != keep) it.deleteRecursively() }
    }
}
