package com.craniumiot.cranium.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Every call the app makes, under the console's address (cloud/api/src/app.mjs). */
class ApiPathsTest {
    private val paths = ApiPaths("https://console.example.com/")
    private val base = "https://console.example.com"
    private val thing = "cranium-0123456789abcdef"
    private val deployment = "cranium-1-1-0-b7-20261010T115900Z-0a0a"

    @Test
    fun `the plain routes`() {
        assertEquals("$base/", paths.root)
        assertEquals("$base/api/me", paths.me)
        assertEquals("$base/api/firmware", paths.firmware)
        assertEquals("$base/api/devices", paths.devices)
        assertEquals("$base/api/deployments", paths.deployments)
        assertEquals("$base/api/tokens", paths.tokens)
    }

    @Test
    fun `a version goes with its plus sign encoded, never as a space`() {
        assertEquals("$base/api/firmware/1.8.0%2B0/image", paths.image("1.8.0+0"))
        assertEquals("$base/api/firmware/1.8.0%2B0/bluetooth", paths.bluetooth("1.8.0+0"))
        assertEquals("$base/api/firmware/1.8.0%2B0/revoke", paths.revoke("1.8.0+0"))
    }

    @Test
    fun `boards, deployments and tokens by their names`() {
        assertEquals("$base/api/devices/$thing", paths.device(thing))
        assertEquals("$base/api/devices/$thing/samples?hours=24", paths.samples(thing, 24))
        assertEquals("$base/api/deployments/$deployment", paths.deployment(deployment))
        assertEquals("$base/api/deployments/$deployment/cancel", paths.cancel(deployment))
        assertEquals("$base/api/tokens/0123456789abcdef/revoke", paths.revokeToken("0123456789abcdef"))
        assertEquals("$base/api/pairing/Cranium-1A2B", paths.pairing("Cranium-1A2B"))
        assertEquals("$base/api/devices/..%2Fme", paths.device("../me"))
    }

    @Test
    fun `the activity log a page at a time`() {
        assertEquals("$base/api/audit?limit=50", paths.audit(50, null))
        assertEquals("$base/api/audit?limit=100&before=abc_-123", paths.audit(100, "abc_-123"))
    }

    @Test
    fun `the events of a range, with the times and kinds as a query`() {
        assertEquals(
            "$base/api/events?from=2026-11-02T14%3A30%3A00.000Z&to=2026-11-02T15%3A30%3A00.000Z",
            paths.events("2026-11-02T14:30:00.000Z", "2026-11-02T15:30:00.000Z", null, null, null),
        )
        assertEquals(
            "$base/api/events?from=2026-11-02T14%3A30%3A00.000Z&to=2026-11-02T15%3A30%3A00.000Z&thing=$thing" +
                "&kinds=connection%2Cupdate&cursor=abc",
            paths.events("2026-11-02T14:30:00.000Z", "2026-11-02T15:30:00.000Z", thing, listOf("connection", "update"), "abc"),
        )
    }

    @Test
    fun `the updates of every board, or of one board, a page at a time`() {
        assertEquals("$base/api/updates", paths.updates())
        assertEquals("$base/api/updates?thing=$thing", paths.updates(thing))
        assertEquals("$base/api/updates?limit=1", paths.updates(limit = 1))
        assertEquals("$base/api/updates?thing=$thing&limit=100&cursor=eyJrIjoxfQ%3D%3D", paths.updates(thing, 500, "eyJrIjoxfQ=="))
        assertEquals("$base/api/updates?limit=1", paths.updates(limit = 0))
    }

    @Test
    fun `the history file is beside the console's scripts, under its build`() {
        assertEquals("$base/assets/20261102-abc/history.json", paths.history("20261102-abc"))
        assertEquals(
            "20261102-abc",
            ApiPaths.buildIdIn("""<link rel="modulepreload" href="/assets/20261102-abc/core.js"><script type="module" src="/assets/20261102-abc/app.js"></script>"""),
        )
        assertNull(ApiPaths.buildIdIn("""<script src="/app.js"></script>"""))
        assertNull(ApiPaths.buildIdIn("""<script src="/assets/../app.js"></script>"""))
        assertNull(ApiPaths.buildIdIn("""<script src="/assets/./app.js"></script>"""))
        assertNull(ApiPaths.buildIdIn(""))
    }

    @Test
    fun `an address without a trailing slash is the same`() {
        assertEquals("$base/api/me", ApiPaths(base).me)
        assertEquals("$base/", ApiPaths(base).root)
    }
}
