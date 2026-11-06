package com.craniumiot.cranium.shell

import android.content.Intent
import android.webkit.WebChromeClient

/**
 * The picker for a page's `<input type=file>`: the console's firmware upload (accept ".bin,application/octet-stream")
 * and the customer site's Import session (".json,.csv,application/json,text/csv").
 *
 * WebView's own FileChooserParams.createIntent() asks for the first entry of the accept list as the type, so
 * ".json" or ".bin", which is no type at all: the picker then shows no file to choose. This asks for any file
 * and names the types the list means in EXTRA_MIME_TYPES, with the other names the phone's file providers give
 * the same files (a .csv is often text/comma-separated-values, a .json often application/octet-stream). An entry
 * it does not know lets any file through: the page checks what it reads either way.
 */
object ShellFiles {
    private val CSV = listOf("text/csv", "text/comma-separated-values", "application/csv", "text/plain")
    private val JSON = listOf("application/json", "text/json", "text/plain", "application/octet-stream")
    private val BINARY = listOf("application/octet-stream", "application/x-binary", "application/macbinary")

    private val TYPES: Map<String, List<String>> = mapOf(
        ".csv" to CSV,
        "text/csv" to CSV,
        ".json" to JSON,
        "application/json" to JSON,
        ".bin" to BINARY,
        "application/octet-stream" to BINARY,
    )

    /** The types the picker offers for an input's accept list, or an empty list for any file. */
    fun mimeTypes(accept: Array<String>?): List<String> {
        val entries = accept.orEmpty().flatMap { it.split(',') }.map { it.trim().lowercase() }.filter { it.isNotEmpty() }
        if (entries.isEmpty()) return emptyList()
        val types = linkedSetOf<String>()
        for (entry in entries) types += TYPES[entry] ?: return emptyList()
        return types.toList()
    }

    /** Android's picker for files that can be opened, of those types. */
    fun intentFor(params: WebChromeClient.FileChooserParams): Intent {
        val intent = Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
        val types = mimeTypes(params.acceptTypes)
        if (types.isNotEmpty()) intent.putExtra(Intent.EXTRA_MIME_TYPES, types.toTypedArray())
        if (params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        return intent
    }
}
