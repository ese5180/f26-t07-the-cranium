package com.craniumiot.cranium.shell

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test

/**
 * The manifest as the shell reads it: apps/shared/bundle-sample.json, written by cloud/web/src/bundle.mjs,
 * which the website's tests and the iPhone app's read too. The three readers take the same manifests
 * and refuse the same ones.
 */
class BundleManifestTest {
    private val sample = Shared.json("bundle-sample.json")
    private val manifestText = sample["manifest"].toString()

    @Test
    fun `the sample manifest reads, and its id is that of its canonical text`() {
        val manifest = BundleManifest.read(manifestText)
        val canonical = (sample["canonical"] as JsonPrimitive).content
        assertEquals(canonical, BundleManifest.canonicalText(manifest.format, manifest.bridge, manifest.routes, manifest.files))
        assertEquals(BundleManifest.sha256Hex(canonical.toByteArray()).substring(0, 16), manifest.id)
        assertEquals("2.1.1", manifest.consoleVersion)
        assertEquals("0123456789abcdef0123456789abcdef01234567", manifest.consoleCommit)
        assertEquals(1, manifest.bridge)
        assertEquals((sample["objects"] as JsonPrimitive).content.toInt(), manifest.objects.size)
    }

    @Test
    fun `each file's text has the SHA-256 and the size the manifest gives`() {
        val manifest = BundleManifest.read(manifestText)
        val files = (sample["files"] as JsonObject).text
        assertEquals(files.keys, manifest.files.map { it.path }.toSet())
        for (file in manifest.files) {
            val bytes = files.getValue(file.path).toByteArray()
            assertEquals(file.path, file.sha256, BundleManifest.sha256Hex(bytes))
            assertEquals(file.path, file.size, bytes.size.toLong())
        }
    }

    @Test
    fun `every broken manifest of the sample is refused`() {
        val broken = sample["broken"] as JsonObject
        assertEquals(9, broken.size)
        for ((name, manifest) in broken) {
            try {
                BundleManifest.read(manifest.toString())
                fail("taken: $name")
            } catch (e: ManifestException) {
                // As it should be.
            }
        }
    }

    @Test
    fun `what is not a manifest at all is refused`() {
        for (text in listOf("", "null", "[]", "{}", "not json", "{\"format\": \"1\"}", "x".repeat(BundleManifest.MAX_TEXT + 1))) {
            try {
                BundleManifest.read(text)
                fail("taken: ${text.take(20)}")
            } catch (e: ManifestException) {
                // As it should be.
            }
        }
    }

    @Test
    fun `a page is served only through its route, with its policy`() {
        val manifest = BundleManifest.read(manifestText)
        val customer = manifest.resolve("/")!!
        assertEquals("index.html", customer.file.path)
        assertEquals("customer", customer.policy)
        assertEquals("text/html; charset=utf-8", customer.type)
        val console = manifest.resolve("/admin")!!
        assertEquals("admin/index.html", console.file.path)
        assertEquals("console", console.policy)
        val script = manifest.resolve("/assets/ba9876543210/app.js")!!
        assertEquals("text/javascript; charset=utf-8", script.type)
        assertNull(script.policy)
        assertEquals("text/css; charset=utf-8", manifest.resolve("/assets/ba9876543210/app.css")!!.type)
        // An .html file by its own path would come without its policy.
        assertNull(manifest.resolve("/index.html"))
        assertNull(manifest.resolve("/admin/index.html"))
        assertNull(manifest.resolve("/admin/"))
        assertNull(manifest.resolve("/missing.js"))
        assertNull(manifest.resolve("assets/ba9876543210/app.js"))
        assertNull(manifest.resolve("/assets/ba9876543210/../app.js"))
    }

    @Test
    fun `the kinds of file a bundle may hold`() {
        assertEquals("application/json; charset=utf-8", BundleManifest.typeOf("assets/x/versions.json"))
        assertEquals("text/plain; charset=utf-8", BundleManifest.typeOf("assets/x/leaflet-license.txt"))
        assertNull(BundleManifest.typeOf("assets/x/run.sh"))
        assertNull(BundleManifest.typeOf("README"))
        assertNull(BundleManifest.typeOf("assets/x/image.svg"))
    }

    @Test
    fun `a bundle made here reads, as the store's tests make them`() {
        val bundle = bundleOf(pages("a"))
        assertNotNull(bundle.manifest.resolve("/assets/0123456789ab/app.js"))
        assertEquals(4, bundle.manifest.files.size)
    }
}
