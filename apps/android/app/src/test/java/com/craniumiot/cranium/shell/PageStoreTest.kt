package com.craniumiot.cranium.shell

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/** What the pages keep through storage.* (PageStore): the customer site's journal, and its limits. */
class PageStoreTest {
    private val dir: File = Files.createTempDirectory("cranium-pages").toFile()
    private val key = "cranium.mixes.journal.v1:person@example.invalid"

    @After
    fun cleanUp() {
        dir.deleteRecursively()
    }

    @Test
    fun keepsReplacesAndForgets() {
        val store = PageStore(File(dir, "page-store"))
        assertNull(store.get(key))
        store.set(key, """{"sessions":[],"moments":[]}""")
        assertEquals("""{"sessions":[],"moments":[]}""", store.get(key))
        store.set(key, "second, with ünïcödé")
        assertEquals("second, with ünïcödé", store.get(key))
        // A new store on the same folder, as at the app's next start, finds it.
        assertEquals("second, with ünïcödé", PageStore(File(dir, "page-store")).get(key))
        store.remove(key)
        assertNull(store.get(key))
        store.remove(key)
    }

    @Test
    fun aKeyIsNeverAPath() {
        val store = PageStore(dir)
        store.set("cranium.../../escape", "x")
        val names = dir.listFiles()!!.map { it.name }
        assertEquals(1, names.size)
        assertTrue(names.single().matches(Regex("^[0-9a-f]{64}$")))
        assertEquals("x", store.get("cranium.../../escape"))
    }

    @Test
    fun pastTheLimitsNothingIsChanged() {
        val store = PageStore(dir)
        store.set(key, "kept")
        val tooLong = "x".repeat(PageStore.MAX_VALUE_BYTES + 1)
        assertEquals("failed", assertThrows(BridgeError::class.java) { store.set(key, tooLong) }.code)
        assertEquals("kept", store.get(key))
        // Bytes, not characters: two bytes each.
        assertThrows(BridgeError::class.java) { store.set(key, "é".repeat(PageStore.MAX_VALUE_BYTES / 2 + 1)) }

        for (index in 1 until PageStore.MAX_ITEMS) store.set("cranium.item.$index", "v")
        assertEquals("failed", assertThrows(BridgeError::class.java) { store.set("cranium.one.more", "v") }.code)
        assertNull(store.get("cranium.one.more"))
        // Replacing one that is there is not one more.
        store.set("cranium.item.1", "again")
        assertEquals("again", store.get("cranium.item.1"))
    }

    @Test
    fun theTotalIsCapped() {
        val store = PageStore(dir)
        val big = "y".repeat(PageStore.MAX_VALUE_BYTES)
        store.set("cranium.big.1", big)
        store.set("cranium.big.2", big)
        store.set("cranium.big.3", big)
        store.set("cranium.big.4", big)
        assertThrows(BridgeError::class.java) { store.set("cranium.big.5", "z") }
        // The same key again is the same room.
        store.set("cranium.big.4", "small")
        store.set("cranium.big.5", "z")
        assertEquals("z", store.get("cranium.big.5"))
    }
}
