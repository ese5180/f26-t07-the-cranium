package com.craniumiot.cranium.shell

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import java.security.MessageDigest

/** One file of the web bundle: where the pages ask for it, how long it is and its SHA-256. */
data class BundleFile(val path: String, val size: Long, val sha256: String)

/** A page of the bundle: its file, and which Content-Security-Policy goes with it (ShellPolicy). */
data class BundleRoute(val file: String, val policy: String)

/** What a request to the bundle's origin is: a page by its route, or a file by its path. */
data class Resolved(val file: BundleFile, val type: String, val policy: String?)

class ManifestException(message: String) : Exception(message)

/**
 * The web bundle's manifest (cloud/web/src/bundle.mjs; docs/mobile-apps.md, "The app shell"): every
 * file's path, size and SHA-256, the pages by their route, the bridge version the pages need, and the
 * bundle's id, which is a hash of all that ([canonicalText]). [read] takes a manifest only when every
 * rule of bundle.mjs's readManifest holds and the id is that of what it says; apps/shared/bundle-sample.json
 * keeps the three readers (Node, Swift, Kotlin) in step.
 *
 * A path is only ever a key into this manifest: the store keeps each file under its SHA-256
 * (BundleStore), so no path becomes a file name on the phone.
 */
data class BundleManifest(
    val format: Int,
    val id: String,
    val bridge: Int,
    val routes: Map<String, BundleRoute>,
    val files: List<BundleFile>,
    /** The console's version and commit the bundle was made from, where the manifest says. */
    val consoleVersion: String? = null,
    val consoleCommit: String? = null,
    val builtAt: String? = null,
) {
    private val byPath: Map<String, BundleFile> by lazy { files.associateBy { it.path } }

    fun file(path: String): BundleFile? = byPath[path]

    /**
     * A request path of the bundle's origin ("/", "/admin", "/assets/<build>/app.js"): a route's page,
     * with its policy, or else a file by its path. A page is only ever served through its route, so
     * that it never arrives without its policy: an .html file asked for by its own path is not found.
     */
    fun resolve(requestPath: String): Resolved? {
        routes[requestPath]?.let { route ->
            val file = byPath[route.file] ?: return null
            val type = typeOf(file.path) ?: return null
            return Resolved(file, type, route.policy)
        }
        if (!requestPath.startsWith("/")) return null
        val file = byPath[requestPath.substring(1)] ?: return null
        val type = typeOf(file.path) ?: return null
        if (type.startsWith("text/html")) return null
        return Resolved(file, type, null)
    }

    /** The distinct files, one for each SHA-256. */
    val objects: List<BundleFile> get() = files.distinctBy { it.sha256 }

    companion object {
        const val FORMAT = 1
        const val MAX_TEXT = 1024 * 1024
        const val MAX_FILES = 300
        const val MAX_FILE_BYTES = 8L * 1024 * 1024
        const val MAX_TOTAL_BYTES = 32L * 1024 * 1024

        /** The two routes a bundle may have, and the two policies. */
        val ROUTE_KEYS: Set<String> = setOf("/", "/admin")
        val POLICIES: Set<String> = setOf("console", "customer")

        /** bundle.mjs's PATH: at most four parts of lower-case letters, digits, dots, dashes and underscores. */
        val PATH = Regex("""^(?:[a-z0-9][a-z0-9._-]{0,63}/){0,3}[a-z0-9][a-z0-9._-]{0,63}$""")
        private val SHA256 = Regex("^[0-9a-f]{64}$")
        private val ID = Regex("^[0-9a-f]{16}$")

        /** The only kinds of file a bundle may hold, by the end of the path (bundle.mjs TYPES). */
        val TYPES: Map<String, String> = linkedMapOf(
            "html" to "text/html; charset=utf-8",
            "css" to "text/css; charset=utf-8",
            "js" to "text/javascript; charset=utf-8",
            "json" to "application/json; charset=utf-8",
            "txt" to "text/plain; charset=utf-8",
        )

        fun typeOf(path: String): String? {
            val dot = path.lastIndexOf('.')
            return if (dot < 0) null else TYPES[path.substring(dot + 1)]
        }

        /** bundle.mjs canonicalText: one fact a line, routes by key and files by path, in byte order. */
        fun canonicalText(format: Int, bridge: Int, routes: Map<String, BundleRoute>, files: List<BundleFile>): String {
            val lines = mutableListOf("cranium-bundle $format", "bridge $bridge")
            for (key in routes.keys.sorted()) {
                val route = routes.getValue(key)
                lines += "route $key ${route.file} ${route.policy}"
            }
            for (file in files.sortedBy { it.path }) lines += "file ${file.path} ${file.size} ${file.sha256}"
            return lines.joinToString("\n") + "\n"
        }

        fun idOf(format: Int, bridge: Int, routes: Map<String, BundleRoute>, files: List<BundleFile>): String =
            sha256Hex(canonicalText(format, bridge, routes, files).toByteArray(Charsets.UTF_8)).substring(0, 16)

        fun sha256Hex(bytes: ByteArray): String =
            MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

        private val json = Json { isLenient = false }

        /** A manifest, with every rule checked and the id worked out again; else [ManifestException] with the reason. */
        fun read(text: String): BundleManifest {
            if (text.length > MAX_TEXT) throw ManifestException("not a manifest")
            val root = try {
                json.parseToJsonElement(text)
            } catch (e: Exception) {
                throw ManifestException("not JSON")
            } as? JsonObject ?: throw ManifestException("not a manifest")
            val format = integer(root["format"])
            if (format != FORMAT.toLong()) throw ManifestException("not a manifest of this format")
            val id = string(root["id"])?.takeIf { ID.matches(it) } ?: throw ManifestException("no id")
            val bridge = integer(root["bridge"])?.takeIf { it in 1..1000 }?.toInt() ?: throw ManifestException("no bridge version")

            val routesObject = root["routes"] as? JsonObject ?: throw ManifestException("no routes")
            val routes = linkedMapOf<String, BundleRoute>()
            for ((key, value) in routesObject) {
                val route = value as? JsonObject
                val file = string(route?.get("file"))
                val policy = string(route?.get("policy"))
                if (key !in ROUTE_KEYS || file == null || policy !in POLICIES) throw ManifestException("a route that is not one: $key")
                routes[key] = BundleRoute(file, policy!!)
            }

            val list = root["files"] as? JsonArray ?: throw ManifestException("no files")
            if (list.isEmpty() || list.size > MAX_FILES) throw ManifestException("no files")
            val paths = mutableSetOf<String>()
            var total = 0L
            val files = list.map { element ->
                val file = element as? JsonObject ?: throw ManifestException("a file that is not one")
                val path = string(file["path"])
                if (path == null || !PATH.matches(path) || typeOf(path) == null) throw ManifestException("a file that is not one")
                if (!paths.add(path)) throw ManifestException("$path twice")
                val size = integer(file["size"])?.takeIf { it in 0..MAX_FILE_BYTES } ?: throw ManifestException("$path: no size")
                val sha = string(file["sha256"])?.takeIf { SHA256.matches(it) } ?: throw ManifestException("$path: no SHA-256")
                total += size
                BundleFile(path, size, sha)
            }
            if (total > MAX_TOTAL_BYTES) throw ManifestException("too large")
            for (route in routes.values) if (route.file !in paths) throw ManifestException("no file for ${route.file}")
            if (routes.isEmpty()) throw ManifestException("no routes")
            if (idOf(format.toInt(), bridge, routes, files) != id) throw ManifestException("the id is not that of what the manifest says")

            val console = root["console"] as? JsonObject
            return BundleManifest(
                format = format.toInt(),
                id = id,
                bridge = bridge,
                routes = routes,
                files = files,
                consoleVersion = string(console?.get("version"))?.takeIf { VERSION.matches(it) },
                consoleCommit = string(console?.get("commit"))?.takeIf { COMMIT.matches(it) },
                builtAt = string(root["builtAt"])?.take(40),
            )
        }

        private val VERSION = Regex("""^\d{1,4}\.\d{1,4}\.\d{1,6}$""")
        private val COMMIT = Regex("^[0-9a-f]{40}$")

        private fun string(element: JsonElement?): String? = (element as? JsonPrimitive)?.takeIf { it.isString }?.content

        /** A whole number as JSON writes one: not a string, no fraction. */
        private fun integer(element: JsonElement?): Long? {
            val primitive = element as? JsonPrimitive ?: return null
            if (primitive.isString) return null
            return primitive.longOrNull ?: primitive.intOrNull?.toLong()
        }
    }
}
