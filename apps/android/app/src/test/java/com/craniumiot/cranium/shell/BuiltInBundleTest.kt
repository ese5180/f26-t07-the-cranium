package com.craniumiot.cranium.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * The bundle this build carries (the Gradle task buildWebBundle, cloud/web/build-bundle.mjs), read as the
 * app reads it: Node wrote the manifest, and the app's own reader must take it, with every file there and
 * matching its SHA-256, and the store must launch it.
 */
class BuiltInBundleTest {
    private val folder = System.getProperty("cranium.webBundle")?.let(::File)

    private val builtIn = object : BuiltInBundle {
        override fun manifestText(): String? = File(folder, "manifest.json").takeIf { it.isFile }?.readText()
        override fun read(sha256: String): ByteArray? = File(folder, "files/$sha256").takeIf { it.isFile }?.readBytes()
    }

    @Test
    fun `the bundle built into the app reads, checks out and launches`() {
        assumeTrue("no built-in bundle in this build", folder != null && File(folder, "manifest.json").isFile)
        val manifest = BundleManifest.read(builtIn.manifestText()!!)
        assertEquals(BridgeSpec.VERSION, manifest.bridge)
        for (file in manifest.objects) {
            val bytes = builtIn.read(file.sha256)
            assertNotNull("${file.path} is not in the build", bytes)
            assertEquals(file.path, file.sha256, BundleManifest.sha256Hex(bytes!!))
        }
        // The two pages, each with its policy, and their scripts by path.
        assertEquals("customer", manifest.resolve("/")!!.policy)
        assertEquals("console", manifest.resolve("/admin")!!.policy)
        assertTrue(manifest.files.any { it.path.endsWith("/core.js") })

        val dir = Files.createTempDirectory("cranium-built-in").toFile()
        try {
            val launched = BundleStore(dir, builtIn).launch()!!
            assertEquals(BundleSource.BUILT_IN, launched.source)
            assertEquals(manifest.id, launched.manifest.id)
        } finally {
            dir.deleteRecursively()
        }
    }
}
