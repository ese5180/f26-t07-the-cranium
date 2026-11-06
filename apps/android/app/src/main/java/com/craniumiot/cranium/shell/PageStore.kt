package com.craniumiot.cranium.shell

import java.io.File
import java.io.IOException
import java.security.MessageDigest

/**
 * What the pages keep on the phone through the bridge (apps/shared/bridge.json, storage.*), such as the
 * customer site's journal of sessions and its choices (Explore demo or My journal, the date range).
 *
 * The same in both apps: the iPhone's web view keeps nothing on disk, so the pages keep what they mean to
 * keep through the app, and they do so here too, where the WebView's own storage would last. One file per
 * key, named by the SHA-256 of the key (a key is never a path), in [dir], which the app puts under
 * noBackupFilesDir: on this phone only. The limits are the contract's: a value of at most [MAX_VALUE_BYTES]
 * bytes of UTF-8, [MAX_ITEMS] keys and [MAX_TOTAL_BYTES] bytes in all; past them the call fails and nothing
 * is changed.
 */
class PageStore(private val dir: File) {
    @Synchronized
    fun get(key: String): String? {
        val file = fileOf(key)
        return if (file.isFile) file.readText(Charsets.UTF_8) else null
    }

    @Synchronized
    fun set(key: String, value: String) {
        val bytes = value.toByteArray(Charsets.UTF_8)
        if (bytes.size > MAX_VALUE_BYTES) throw BridgeError("failed", "The app keeps at most 3 MB for one item of the pages.")
        if (!dir.isDirectory && !dir.mkdirs()) throw BridgeError("failed", "The app could not keep it.")
        val target = fileOf(key)
        val others = items().filter { it.name != target.name }
        if (others.size >= MAX_ITEMS) throw BridgeError("failed", "The app keeps at most $MAX_ITEMS items of the pages.")
        if (others.sumOf { it.length() } + bytes.size > MAX_TOTAL_BYTES) {
            throw BridgeError("failed", "The app keeps at most 12 MB of the pages' items.")
        }
        // Written beside it, then renamed into place: a value is never half there.
        val part = File(dir, "${target.name}.part")
        try {
            part.writeBytes(bytes)
            if (!part.renameTo(target)) {
                target.delete()
                if (!part.renameTo(target)) throw IOException("rename")
            }
        } catch (e: IOException) {
            part.delete()
            throw BridgeError("failed", "The app could not keep it.")
        }
    }

    @Synchronized
    fun remove(key: String) {
        val file = fileOf(key)
        if (file.exists() && !file.delete()) throw BridgeError("failed", "The app could not forget it.")
    }

    internal fun fileOf(key: String): File {
        val digest = MessageDigest.getInstance("SHA-256").digest(key.toByteArray(Charsets.UTF_8))
        return File(dir, digest.joinToString("") { "%02x".format(it) })
    }

    private fun items(): List<File> = dir.listFiles { file -> file.isFile && file.name.length == 64 }?.toList().orEmpty()

    companion object {
        const val MAX_VALUE_BYTES = 3_000_000
        const val MAX_ITEMS = 64
        const val MAX_TOTAL_BYTES = 12_000_000L
    }
}
