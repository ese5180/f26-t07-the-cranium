package com.craniumiot.cranium.shell

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File

/** The files in apps/shared that the shell's tests read: the bridge's contract and the sample bundle. */
object Shared {
    fun file(name: String): File = generateSequence(File("").absoluteFile) { it.parentFile }
        .take(6)
        .flatMap { sequenceOf(File(it, "apps/shared/$name"), File(it, "shared/$name")) }
        .firstOrNull { it.isFile }
        ?: error("apps/shared/$name is not in this checkout")

    fun json(name: String): JsonObject = Json.parseToJsonElement(file(name).readText()) as JsonObject
}

/** A bundle made in a test: its manifest's text and its files by SHA-256. */
class TestBundle(val manifest: BundleManifest, val text: String, val objects: Map<String, ByteArray>)

/** A bundle of [files] (path to text), with the two routes, as bundle.mjs makes one. */
fun bundleOf(files: Map<String, String>, bridge: Int = 1): TestBundle {
    val listed = files.map { (path, text) ->
        val bytes = text.toByteArray()
        BundleFile(path, bytes.size.toLong(), BundleManifest.sha256Hex(bytes))
    }.sortedBy { it.path }
    val routes = linkedMapOf("/" to BundleRoute("index.html", "customer"), "/admin" to BundleRoute("admin/index.html", "console"))
    val id = BundleManifest.idOf(1, bridge, routes, listed)
    val text = buildJsonObject {
        put("format", 1)
        put("id", id)
        put("bridge", bridge)
        put("console", buildJsonObject {
            put("version", "2.1.1")
            put("commit", "0123456789abcdef0123456789abcdef01234567")
        })
        put("builtAt", "2026-11-05T12:00:00.000Z")
        put("routes", buildJsonObject {
            for ((key, route) in routes) {
                put(key, buildJsonObject {
                    put("file", route.file)
                    put("policy", route.policy)
                })
            }
        })
        put("files", buildJsonArray {
            for (file in listed) {
                add(buildJsonObject {
                    put("path", file.path)
                    put("size", file.size)
                    put("sha256", file.sha256)
                })
            }
        })
    }.toString()
    val objects = files.values.map { it.toByteArray() }.associateBy { BundleManifest.sha256Hex(it) }
    return TestBundle(BundleManifest.read(text), text, objects)
}

fun pages(tag: String, extra: Map<String, String> = emptyMap()): Map<String, String> = mapOf(
    "index.html" to "<!doctype html><title>Customer $tag</title>\n",
    "admin/index.html" to "<!doctype html><title>Console $tag</title>\n",
    "assets/0123456789ab/app.js" to "export const tag = '$tag';\n",
    "assets/0123456789ab/core.js" to "export const shared = 1;\n",
) + extra

val JsonObject.text: Map<String, String>
    get() = mapValues { (it.value as JsonPrimitive).content }
