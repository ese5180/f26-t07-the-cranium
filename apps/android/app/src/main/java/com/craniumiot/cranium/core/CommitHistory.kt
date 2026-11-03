package com.craniumiot.cranium.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

/**
 * The website's History page: the project's commits, newest first, and what this deployment of
 * the console was built from (history.js). The data is `history.json` beside the console's
 * scripts, written at deployment by cloud/web/build-history.mjs.
 */
data class CommitHistory(val commits: List<Commit>, val builtFrom: String?, val tree: String, val deployedAt: String?) {
    data class Commit(val hash: String, val short: String, val date: String, val subject: String, val tags: List<String>) {
        /** Where a person can read it. Nothing is fetched from there. */
        val link: String get() = COMMIT_BASE + hash
    }

    companion object {
        const val COMMIT_BASE = "https://github.com/ese5180/f26-t07-the-cranium/commit/"
        private const val COMMITS_KEPT = 300
        private val HASH = Regex("^[0-9a-f]{7,64}$")
        private val json = Json { ignoreUnknownKeys = true }

        /** The same names in the same order as cloud/web/build-history.mjs. */
        val TAGS = listOf(
            "website" to "Website", "firmware" to "Firmware", "cloud" to "Cloud", "tools" to "Tools", "ci" to "CI", "docs" to "Docs",
        )

        fun tagLabel(id: String): String? = TAGS.firstOrNull { it.first == id }?.second

        /** The file's data with only what the page uses, or null if it is not what was written. */
        fun parse(text: String): CommitHistory? {
            val root = runCatching { json.parseToJsonElement(text) }.getOrNull() as? JsonObject ?: return null
            val list = J.arr(root["commits"]) ?: return null
            val known = TAGS.map { it.first }.toSet()
            val commits = mutableListOf<Commit>()
            for (raw in list.take(COMMITS_KEPT)) {
                val item = J.obj(raw) ?: return null
                val hash = J.str(item["hash"])?.takeIf { HASH.matches(it) } ?: return null
                val subject = J.str(item["subject"]) ?: return null
                val date = J.str(item["date"]) ?: return null
                commits += Commit(
                    hash = hash,
                    short = (J.str(item["short"]) ?: hash.take(7)).take(12),
                    date = date,
                    subject = subject.take(300),
                    tags = J.texts(item["tags"]).filter { it in known },
                )
            }
            val built = J.obj(root["deployment"])
            return CommitHistory(
                commits = commits,
                builtFrom = J.str(built?.get("commit"))?.takeIf { HASH.matches(it) },
                tree = J.str(built?.get("tree"))?.takeIf { it == "clean" || it == "dirty" } ?: "unknown",
                deployedAt = J.str(built?.get("deployedAt")),
            )
        }
    }
}

/** What reading the history came to: the data, no file in this deployment, or a failure. */
sealed class HistoryRead {
    data class Read(val history: CommitHistory) : HistoryRead()
    data object Missing : HistoryRead()
    data class Failed(val why: String) : HistoryRead()
}
