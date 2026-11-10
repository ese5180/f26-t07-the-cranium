package com.craniumiot.cranium.shell

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put
import java.io.File
import java.io.IOException
import java.util.UUID

/** Where the bundle the shell serves came from. */
enum class BundleSource(val word: String) { DOWNLOADED("downloaded"), BUILT_IN("built-in") }

/** The bundle copy shipped inside the app (assets/web/): its manifest and its files by SHA-256. */
interface BuiltInBundle {
    fun manifestText(): String?
    fun read(sha256: String): ByteArray?
}

/** Fetches one address over HTTPS: its bytes, at most [maxBytes]; IOException otherwise. */
fun interface BundleFetcher {
    suspend fun fetch(url: String, maxBytes: Long): ByteArray
}

/** A bundle that checked out, in memory: what the shell serves until the next launch or reload. */
class LaunchedBundle(val manifest: BundleManifest, val source: BundleSource, private val objects: Map<String, ByteArray>) {
    fun bytes(file: BundleFile): ByteArray? = objects[file.sha256]
}

/** What a look for a newer bundle came to. */
sealed interface BundleUpdate {
    /** The console's bundle is the one kept already (its files are all there). */
    data class UpToDate(val id: String) : BundleUpdate

    /** A newer bundle is checked and kept: the next launch, or app.reload, shows it. */
    data class Taken(val manifest: BundleManifest) : BundleUpdate

    /** The console's bundle needs a newer bridge than this app has: the app itself needs an update. */
    data class NeedsNewerApp(val bridge: Int) : BundleUpdate

    /** Not taken: a manifest that did not read, a file that did not check out, or a bundle marked bad. */
    data class Refused(val reason: String) : BundleUpdate

    /** The console could not be reached. */
    data class Failed(val reason: String) : BundleUpdate
}

/**
 * The web bundles the app keeps (apps/shared/bridge.json, "bundle"), in app-private storage that is not
 * backed up:
 *
 *     objects/<sha256>   each file, checked against its size and SHA-256 before it is renamed into place
 *     current.json       the manifest of the newest bundle taken
 *     previous.json      the one before it, kept to fall back on
 *     state.json         per bundle id, how often it was started without app.ready, and whether it was
 *                        ever ready; and the ids marked bad
 *
 * [launch] picks current, then previous, then the copy built into the app, taking the first one whose
 * every file is there and matches its SHA-256 and that is not bad. A bundle that has not sent app.ready
 * after two starts is marked bad: it is never launched or fetched again. A downloaded bundle of an older
 * console than the built-in one gives way to it (the app was built with newer pages than the console has
 * deployed, such as a new page waiting for its console release); an equal or unknown version keeps the
 * downloaded one, as before, and [update] takes nothing older than the built-in pages. [update] fetches the console's
 * manifest and the files it names that are not kept yet, at most four at a time, checks each, and only
 * then makes it the current one, in one rename.
 */
class BundleStore(
    private val dir: File,
    private val builtIn: BuiltInBundle,
    private val bridgeVersion: Int = BridgeSpec.VERSION,
) {
    private val objects = File(dir, "objects")
    private val currentFile = File(dir, "current.json")
    private val previousFile = File(dir, "previous.json")
    private val stateFile = File(dir, "state.json")
    private val lock = Any()
    private val updating = Mutex()

    /** Whether the last manifest seen needed a newer bridge: the app itself needs an update. */
    @Volatile
    var needsNewerApp: Boolean = false
        private set

    private data class Entry(val tries: Int = 0, val good: Boolean = false)

    private data class State(val bundles: Map<String, Entry> = emptyMap(), val bad: List<String> = emptyList())

    // Launching.

    /** The bundle to serve, or null when not even the built-in one checks out. */
    fun launch(): LaunchedBundle? = synchronized(lock) {
        var state = readState()
        for (file in listOf(currentFile, previousFile)) {
            val manifest = readManifest(file) ?: continue
            if (manifest.id in state.bad || manifest.bridge > bridgeVersion) continue
            val entry = state.bundles[manifest.id] ?: Entry()
            if (!entry.good && entry.tries >= MAX_TRIES) {
                state = state.copy(bad = (state.bad + manifest.id).distinct().takeLast(MAX_BAD))
                writeState(state)
                continue
            }
            // Older than the pages built into the app: those, and no start of this one is counted.
            builtInNewerThan(manifest)?.let { return it }
            val loaded = verified(manifest) { sha -> File(objects, sha).takeIf { it.isFile }?.readBytes() } ?: continue
            if (!entry.good) {
                state = state.copy(bundles = state.bundles + (manifest.id to entry.copy(tries = entry.tries + 1)))
                writeState(state)
            }
            return LaunchedBundle(manifest, BundleSource.DOWNLOADED, loaded)
        }
        builtInBundle()
    }

    private fun builtInManifest(): BundleManifest? =
        builtIn.manifestText()?.let { runCatching { BundleManifest.read(it) }.getOrNull() }?.takeIf { it.bridge <= bridgeVersion }

    private fun builtInBundle(): LaunchedBundle? {
        val manifest = builtInManifest() ?: return null
        val loaded = verified(manifest, builtIn::read) ?: return null
        return LaunchedBundle(manifest, BundleSource.BUILT_IN, loaded)
    }

    /** The built-in bundle, when it is of a newer console than [manifest] and checks out. */
    private fun builtInNewerThan(manifest: BundleManifest): LaunchedBundle? {
        val shipped = builtInManifest() ?: return null
        return if (isNewer(shipped.consoleVersion, manifest.consoleVersion)) builtInBundle() else null
    }

    /** The page of [id] started (app.ready): it is good, and kept as the last good one. */
    fun markReady(id: String) = synchronized(lock) {
        val state = readState()
        val entry = state.bundles[id]
        if (entry != null && !entry.good) writeState(state.copy(bundles = state.bundles + (id to entry.copy(good = true))))
    }

    /** The id of the current bundle, where there is one. */
    fun currentId(): String? = synchronized(lock) { readManifest(currentFile)?.id }

    private fun verified(manifest: BundleManifest, read: (String) -> ByteArray?): Map<String, ByteArray>? {
        val loaded = HashMap<String, ByteArray>()
        for (file in manifest.objects) {
            val bytes = runCatching { read(file.sha256) }.getOrNull() ?: return null
            if (bytes.size.toLong() != file.size || BundleManifest.sha256Hex(bytes) != file.sha256) return null
            loaded[file.sha256] = bytes
        }
        return loaded
    }

    // Updating.

    /**
     * Look for a newer bundle at [manifestUrl]; each file comes from [fileUrl] of its SHA-256. Never
     * throws for what the console or the network does: that is in the answer.
     */
    suspend fun update(fetcher: BundleFetcher, manifestUrl: String, fileUrl: (String) -> String): BundleUpdate = updating.withLock {
        val text = try {
            fetcher.fetch(manifestUrl, BundleManifest.MAX_TEXT.toLong()).toString(Charsets.UTF_8)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return@withLock BundleUpdate.Failed(e.message ?: "The console could not be reached.")
        }
        val manifest = try {
            BundleManifest.read(text)
        } catch (e: ManifestException) {
            return@withLock BundleUpdate.Refused("The console's manifest did not check out: ${e.message}")
        }
        if (manifest.bridge > bridgeVersion) {
            needsNewerApp = true
            return@withLock BundleUpdate.NeedsNewerApp(manifest.bridge)
        }
        needsNewerApp = false
        val (bad, currentId) = synchronized(lock) { readState().bad to readManifest(currentFile)?.id }
        if (manifest.id in bad) return@withLock BundleUpdate.Refused("The console's bundle ${manifest.id} did not start on this phone before.")
        // The console's pages are older than the ones built into the app: nothing to fetch or to offer.
        val shipped = synchronized(lock) { builtInManifest() }
        if (shipped != null && isNewer(shipped.consoleVersion, manifest.consoleVersion)) {
            return@withLock BundleUpdate.UpToDate(shipped.id)
        }

        val missing = manifest.objects.filter { !kept(it) }
        try {
            withContext(Dispatchers.IO) {
                objects.mkdirs()
                coroutineScope {
                    val gate = Semaphore(MAX_DOWNLOADS)
                    missing.map { file -> async { gate.withPermit { download(fetcher, fileUrl(file.sha256), file) } } }.awaitAll()
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: BundleFileRefused) {
            return@withLock BundleUpdate.Refused(e.message ?: "A file of the bundle did not check out.")
        } catch (e: Exception) {
            return@withLock BundleUpdate.Failed(e.message ?: "A file of the bundle could not be fetched.")
        }
        if (manifest.id == currentId) {
            collect()
            return@withLock BundleUpdate.UpToDate(manifest.id)
        }
        withContext(Dispatchers.IO) { take(manifest, text) }
        BundleUpdate.Taken(manifest)
    }

    private class BundleFileRefused(message: String) : IOException(message)

    private fun kept(file: BundleFile): Boolean {
        val found = File(objects, file.sha256)
        return found.isFile && found.length() == file.size
    }

    private suspend fun download(fetcher: BundleFetcher, url: String, file: BundleFile) {
        val bytes = fetcher.fetch(url, file.size)
        if (bytes.size.toLong() != file.size || BundleManifest.sha256Hex(bytes) != file.sha256) {
            throw BundleFileRefused("${file.path} did not match its SHA-256.")
        }
        val part = File(objects, "${file.sha256}.part-${UUID.randomUUID()}")
        try {
            part.writeBytes(bytes)
            if (!part.renameTo(File(objects, file.sha256))) throw IOException("${file.path} could not be kept on this phone.")
        } finally {
            part.delete()
        }
    }

    /** Make [manifest] the current bundle: the old current one becomes the previous one. */
    private fun take(manifest: BundleManifest, text: String) = synchronized(lock) {
        dir.mkdirs()
        val next = File(dir, "next.json")
        next.writeText(text)
        if (currentFile.isFile && !currentFile.renameTo(previousFile)) {
            previousFile.delete()
            currentFile.renameTo(previousFile)
        }
        if (!next.renameTo(currentFile)) throw IOException("The bundle could not be kept on this phone.")
        val state = readState()
        val keep = setOfNotNull(manifest.id, readManifest(previousFile)?.id)
        writeState(state.copy(bundles = state.bundles.filterKeys { it in keep } + (manifest.id to Entry())))
        collect()
    }

    /** Delete every file that neither manifest names, and what an interrupted download left behind. */
    private fun collect() = synchronized(lock) {
        val named = listOfNotNull(readManifest(currentFile), readManifest(previousFile)).flatMap { m -> m.files.map { it.sha256 } }.toSet()
        objects.listFiles()?.forEach { if (it.name !in named) it.delete() }
    }

    private fun readManifest(file: File): BundleManifest? =
        runCatching { if (file.isFile) BundleManifest.read(file.readText()) else null }.getOrNull()

    private fun readState(): State {
        val root = runCatching { Json.parseToJsonElement(stateFile.readText()) as? JsonObject }.getOrNull() ?: return State()
        val bundles = (root["bundles"] as? JsonObject)?.mapNotNull { (id, value) ->
            val entry = value as? JsonObject ?: return@mapNotNull null
            id to Entry(
                tries = (entry["tries"] as? JsonPrimitive)?.intOrNull ?: 0,
                good = (entry["good"] as? JsonPrimitive)?.booleanOrNull ?: false,
            )
        }?.toMap().orEmpty()
        val bad = (root["bad"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }.orEmpty()
        return State(bundles, bad)
    }

    private fun writeState(state: State) {
        dir.mkdirs()
        val text = buildJsonObject {
            put("bundles", buildJsonObject {
                for ((id, entry) in state.bundles) {
                    put(id, buildJsonObject {
                        put("tries", entry.tries)
                        put("good", entry.good)
                    })
                }
            })
            put("bad", buildJsonArray { state.bad.forEach { add(JsonPrimitive(it)) } })
        }.toString()
        val part = File(dir, "state.json.part")
        part.writeText(text)
        if (!part.renameTo(stateFile)) {
            stateFile.delete()
            part.renameTo(stateFile)
        }
    }

    companion object {
        /** Starts without app.ready before a bundle is taken for bad. */
        const val MAX_TRIES = 2

        /**
         * Whether console version [a] is newer than [b] ("2.27.0" against "2.25.5"); false when either is
         * missing or not three numbers, so that a manifest without a version keeps the rule from before.
         */
        fun isNewer(a: String?, b: String?): Boolean {
            fun parts(text: String?): List<Int>? {
                val numbers = text?.substringBefore('+')?.split('.')?.map { it.toIntOrNull() ?: return null } ?: return null
                return numbers.takeIf { it.size == 3 }
            }
            val x = parts(a) ?: return false
            val y = parts(b) ?: return false
            for (i in 0 until 3) if (x[i] != y[i]) return x[i] > y[i]
            return false
        }
        const val MAX_DOWNLOADS = 4
        private const val MAX_BAD = 20
    }
}
