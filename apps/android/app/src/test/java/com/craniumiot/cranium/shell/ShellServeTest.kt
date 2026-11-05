package com.craniumiot.cranium.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** What the bundle's origin answers. */
class ShellServeTest {
    private val bundle = bundleOf(pages("x"))
    private val launched = LaunchedBundle(bundle.manifest, BundleSource.DOWNLOADED, bundle.objects)
    private val config = ShellConfig("https://console.example.com", "us-east-1", "us-east-1_A", "phone", null, null, null, null, example = false)

    @Test
    fun `a page comes with its policy, a file without, both not to be sniffed`() {
        val page = ShellServe.serve(launched, "/admin", config)
        assertEquals(200, page.status)
        assertEquals("text/html", page.mimeType)
        assertEquals("utf-8", page.encoding)
        assertEquals(ShellPolicy.csp("console", config), page.headers["Content-Security-Policy"])
        assertEquals("nosniff", page.headers["X-Content-Type-Options"])
        assertEquals("<!doctype html><title>Console x</title>\n", page.body.decodeToString())
        assertTrue(ShellServe.serve(launched, "/", config).headers.getValue("Content-Security-Policy").contains("trusted-types"))

        val script = ShellServe.serve(launched, "/assets/0123456789ab/app.js", config)
        assertEquals("text/javascript", script.mimeType)
        assertFalse(script.headers.containsKey("Content-Security-Policy"))
        assertEquals("nosniff", script.headers["X-Content-Type-Options"])
    }

    @Test
    fun `anything else is a 404, never the network`() {
        for (path in listOf("/index.html", "/admin/index.html", "/nothing.js", "/assets/0123456789ab/../core.js", "", "/admin/")) {
            assertEquals(path, 404, ShellServe.serve(launched, path, config).status)
        }
        assertEquals(404, ShellServe.serve(null, "/", config).status)
        assertEquals(403, ShellServe.blocked().status)
        assertEquals("text/css" to "utf-8", ShellServe.split("text/css; charset=utf-8"))
    }
}
