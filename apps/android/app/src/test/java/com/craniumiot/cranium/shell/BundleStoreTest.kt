package com.craniumiot.cranium.shell

import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.util.concurrent.atomic.AtomicInteger

/** The bundles the shell keeps, launches and fetches (BundleStore), in a folder of the test's own. */
class BundleStoreTest {
    private val dir: File = Files.createTempDirectory("cranium-bundles").toFile()
    private val builtInBundle = bundleOf(pages("built-in"))
    private val builtIn = object : BuiltInBundle {
        override fun manifestText() = builtInBundle.text
        override fun read(sha256: String) = builtInBundle.objects[sha256]
    }

    @After
    fun cleanUp() {
        dir.deleteRecursively()
    }

    private fun store(bridge: Int = 1) = BundleStore(dir, builtIn, bridge)

    /** The console: one bundle at a time, its manifest and its files. */
    private class Console(var bundle: TestBundle) {
        val asked = mutableListOf<String>()
        var failing = false
        var corrupt: String? = null
        val atOnce = AtomicInteger()
        var most = 0

        val fetcher = BundleFetcher { url, maxBytes ->
            synchronized(asked) { asked += url }
            if (failing) throw IOException("The console could not be reached.")
            val now = atOnce.incrementAndGet()
            synchronized(this) { most = maxOf(most, now) }
            try {
                delay(5)
                val bytes = if (url == MANIFEST) {
                    bundle.text.toByteArray()
                } else {
                    val sha = url.removePrefix(FILES)
                    if (sha == corrupt) "something else".toByteArray() else bundle.objects[sha] ?: throw IOException("404")
                }
                if (bytes.size > maxBytes) throw IOException("too large")
                bytes
            } finally {
                atOnce.decrementAndGet()
            }
        }
    }

    private fun update(store: BundleStore, console: Console) = runBlocking { store.update(console.fetcher, MANIFEST) { FILES + it } }

    /** A store whose built-in pages are of console [version]. */
    private fun storeWithBuiltIn(version: String?): Pair<BundleStore, TestBundle> {
        val shipped = bundleOf(pages("built-in $version"), version = version)
        val source = object : BuiltInBundle {
            override fun manifestText() = shipped.text
            override fun read(sha256: String) = shipped.objects[sha256]
        }
        return BundleStore(dir, source, 1) to shipped
    }

    @Test
    fun `built-in pages of a newer console win over an older download, which is not even fetched`() {
        val (store, shipped) = storeWithBuiltIn("2.27.0")
        val console = Console(bundleOf(pages("console"), version = "2.25.5"))
        assertEquals(BundleUpdate.UpToDate(shipped.manifest.id), update(store, console))
        assertEquals(listOf(MANIFEST), console.asked)
        val launched = store.launch()!!
        assertEquals(BundleSource.BUILT_IN, launched.source)
        assertEquals(shipped.manifest.id, launched.manifest.id)
    }

    @Test
    fun `an older download kept from before gives way to newer built-in pages`() {
        val (before, _) = storeWithBuiltIn("2.20.0")
        val older = Console(bundleOf(pages("console"), version = "2.25.5"))
        assertTrue(update(before, older) is BundleUpdate.Taken)
        assertEquals(BundleSource.DOWNLOADED, before.launch()!!.source)
        // The app is updated with 2.27.0's pages built in.
        val (after, shipped) = storeWithBuiltIn("2.27.0")
        repeat(3) { assertEquals(shipped.manifest.id, after.launch()!!.manifest.id) }
    }

    @Test
    fun `a newer or equal download still wins, and so does one without a version`() {
        for ((shipped, deployed) in listOf("2.27.0" to "2.27.1", "2.27.0" to "2.27.0", "2.9.0" to "2.10.0", "2.27.0" to null)) {
            dir.deleteRecursively()
            dir.mkdirs()
            val (store, _) = storeWithBuiltIn(shipped)
            val console = Console(bundleOf(pages("console $deployed"), version = deployed))
            assertTrue(update(store, console) is BundleUpdate.Taken)
            assertEquals("$deployed against $shipped", console.bundle.manifest.id, store.launch()!!.manifest.id)
        }
        assertTrue(BundleStore.isNewer("2.27.0", "2.25.5"))
        assertFalse(BundleStore.isNewer("2.25.5", "2.27.0"))
        assertTrue(BundleStore.isNewer("2.10.0", "2.9.9"))
        assertFalse(BundleStore.isNewer("2.27.0", null))
        assertFalse(BundleStore.isNewer("garbage", "1.0.0"))
    }

    @Test
    fun `with nothing fetched yet, the built-in bundle is served`() {
        val launched = store().launch()!!
        assertEquals(BundleSource.BUILT_IN, launched.source)
        assertEquals(builtInBundle.manifest.id, launched.manifest.id)
        val page = launched.manifest.resolve("/")!!
        assertEquals("<!doctype html><title>Customer built-in</title>\n", launched.bytes(page.file)!!.decodeToString())
    }

    @Test
    fun `a newer bundle is fetched, checked, kept, and served from the next launch`() {
        val store = store()
        val console = Console(bundleOf(pages("one")))
        val taken = update(store, console)
        assertTrue(taken is BundleUpdate.Taken)
        assertEquals(console.bundle.manifest.id, store.currentId())
        val launched = store.launch()!!
        assertEquals(BundleSource.DOWNLOADED, launched.source)
        assertEquals(console.bundle.manifest.id, launched.manifest.id)
        assertEquals("export const tag = 'one';\n", launched.bytes(launched.manifest.resolve("/assets/0123456789ab/app.js")!!.file)!!.decodeToString())

        // The same bundle again: nothing to fetch but the manifest.
        console.asked.clear()
        assertEquals(BundleUpdate.UpToDate(console.bundle.manifest.id), update(store, console))
        assertEquals(listOf(MANIFEST), console.asked)
    }

    @Test
    fun `only the files that are not kept yet are fetched, at most four at a time`() {
        val store = store()
        val many = (1..12).associate { "assets/0123456789ab/part$it.js" to "export const part = $it;\n" }
        val console = Console(bundleOf(pages("one", many)))
        assertTrue(update(store, console) is BundleUpdate.Taken)
        assertTrue("${console.most} at once", console.most in 1..BundleStore.MAX_DOWNLOADS)

        console.bundle = bundleOf(pages("two", many))
        console.asked.clear()
        assertTrue(update(store, console) is BundleUpdate.Taken)
        // The pages and app.js changed; core.js and the twelve parts were kept.
        assertEquals(4, console.asked.size)
    }

    @Test
    fun `a file that does not match its SHA-256 keeps the bundle out`() {
        val store = store()
        val console = Console(bundleOf(pages("one")))
        console.corrupt = console.bundle.manifest.resolve("/assets/0123456789ab/app.js")!!.file.sha256
        val answer = update(store, console)
        assertTrue(answer is BundleUpdate.Refused)
        assertNull(store.currentId())
        assertEquals(BundleSource.BUILT_IN, store.launch()!!.source)
    }

    @Test
    fun `a manifest that does not read is refused, and an unreachable console fails quietly`() {
        val store = store()
        val console = Console(bundleOf(pages("one")))
        console.bundle = TestBundle(console.bundle.manifest, console.bundle.text.replace("\"bridge\":1", "\"bridge\":1,\"id\":\"0\""), console.bundle.objects)
        assertTrue(update(store, console) is BundleUpdate.Refused)
        console.failing = true
        assertTrue(update(store, console) is BundleUpdate.Failed)
        assertNull(store.currentId())
    }

    @Test
    fun `a bundle that needs a newer bridge is not taken, and the app says it needs an update`() {
        val store = store(bridge = 1)
        val console = Console(bundleOf(pages("two"), bridge = 2))
        assertEquals(BundleUpdate.NeedsNewerApp(2), update(store, console))
        assertTrue(store.needsNewerApp)
        assertNull(store.currentId())
        console.bundle = bundleOf(pages("one"))
        assertTrue(update(store, console) is BundleUpdate.Taken)
        assertFalse(store.needsNewerApp)
    }

    @Test
    fun `a bundle that never says it is ready is given up after two starts, and not fetched again`() {
        val store = store()
        val console = Console(bundleOf(pages("one")))
        update(store, console)
        val first = console.bundle.manifest.id
        assertEquals(first, store.launch()!!.manifest.id)
        assertEquals(first, store.launch()!!.manifest.id)
        // The third start: back to what came before it, here the built-in one.
        assertEquals(BundleSource.BUILT_IN, store.launch()!!.source)
        assertTrue(update(store, console) is BundleUpdate.Refused)
    }

    @Test
    fun `a bundle that said it is ready stays the one served`() {
        val store = store()
        val console = Console(bundleOf(pages("one")))
        update(store, console)
        val id = console.bundle.manifest.id
        store.launch()
        store.markReady(id)
        repeat(4) { assertEquals(id, store.launch()!!.manifest.id) }
    }

    @Test
    fun `a broken newer bundle falls back to the previous one`() {
        val store = store()
        val console = Console(bundleOf(pages("one")))
        update(store, console)
        val one = console.bundle.manifest.id
        store.launch()
        store.markReady(one)
        console.bundle = bundleOf(pages("two"))
        update(store, console)
        val two = console.bundle.manifest.id
        // A file of the new one changed on the phone: it does not launch, the one before does.
        val page = console.bundle.manifest.resolve("/admin")!!.file
        File(dir, "objects/${page.sha256}").writeText("changed")
        assertEquals(one, store.launch()!!.manifest.id)
        assertEquals(two, store.currentId())
    }

    @Test
    fun `only the files of the current and the previous bundle stay`() {
        val store = store()
        val console = Console(bundleOf(pages("one")))
        update(store, console)
        val first = console.bundle.objects.keys
        console.bundle = bundleOf(pages("two"))
        update(store, console)
        console.bundle = bundleOf(pages("three"))
        update(store, console)
        val kept = File(dir, "objects").list()!!.toSet()
        val three = console.bundle.objects.keys
        assertTrue(kept.containsAll(three))
        // "one"'s own pages and app.js are gone; core.js, which all three share, stays.
        assertEquals(first.intersect(three), first.intersect(kept))
        assertTrue(kept.none { it.contains(".part") })
    }
}

private const val MANIFEST = "https://console.test/app/manifest.json"
private const val FILES = "https://console.test/app/files/"
