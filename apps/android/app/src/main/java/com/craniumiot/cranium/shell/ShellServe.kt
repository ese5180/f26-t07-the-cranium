package com.craniumiot.cranium.shell

/** One answer of the bundle's origin, in the pieces a WebResourceResponse takes. */
class Served(
    val status: Int,
    val reason: String,
    val mimeType: String,
    val encoding: String?,
    val headers: Map<String, String>,
    val body: ByteArray,
)

/**
 * What the shell answers on the bundle's origin (https://appassets.androidplatform.net): a route's page
 * with its Content-Security-Policy, or a file of the bundle by its path, from the bundle that was
 * launched, which is in memory and was checked against its SHA-256s. The path is only a key into the
 * manifest; anything not in it is a 404, never a request to the network.
 */
object ShellServe {
    private val COMMON = mapOf(
        "X-Content-Type-Options" to "nosniff",
        "Referrer-Policy" to "no-referrer",
        "Cache-Control" to "no-cache",
    )

    fun serve(bundle: LaunchedBundle?, path: String, config: ShellConfig): Served {
        val resolved = bundle?.manifest?.resolve(path) ?: return notFound()
        val body = bundle.bytes(resolved.file) ?: return notFound()
        val (mime, encoding) = split(resolved.type)
        val headers = if (resolved.policy != null) {
            COMMON + ("Content-Security-Policy" to ShellPolicy.csp(resolved.policy, config))
        } else {
            COMMON
        }
        return Served(200, "OK", mime, encoding, headers, body)
    }

    fun notFound(): Served = Served(404, "Not Found", "text/plain", "utf-8", COMMON, "Not found\n".toByteArray())

    /** A main-frame load of another origin, stopped before it reaches the network. */
    fun blocked(): Served = Served(403, "Forbidden", "text/plain", "utf-8", COMMON, "Not in the app\n".toByteArray())

    /** "text/javascript; charset=utf-8" as "text/javascript" and "utf-8". */
    fun split(type: String): Pair<String, String?> {
        val parts = type.split(';').map { it.trim() }
        val charset = parts.drop(1).firstOrNull { it.startsWith("charset=") }?.removePrefix("charset=")
        return parts[0] to charset
    }
}
