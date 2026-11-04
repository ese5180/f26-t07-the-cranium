package com.craniumiot.cranium.core

import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/**
 * apps/shared/help.json, which both phone apps read, as the Android app reads it. Skipped in a
 * checkout without it; the iPhone agent writes it.
 */
class SharedHelpTest {
    private fun shared(): File? = generateSequence(File("").absoluteFile) { it.parentFile }
        .take(6)
        .map { File(it, "apps/shared/help.json") }
        .firstOrNull { it.isFile }
        ?: generateSequence(File("").absoluteFile) { it.parentFile }.take(6).map { File(it, "shared/help.json") }.firstOrNull { it.isFile }

    @Test
    fun `the shared help file holds together, and its topics can be searched`() {
        val file = shared()
        assumeTrue("apps/shared/help.json is not in this checkout", file != null)
        val load = HelpReader.parse(file!!.readText())
        assertTrue("the help file does not read: $load", load is HelpLoad.Ok)
        val book = (load as HelpLoad.Ok).book
        assertTrue(book.topics.isNotEmpty())
        // The topics the app's screens open with their (?) button.
        for (id in listOf("overview", "events", "activity", "deployments", "api-tokens", "firmware-and-signing", "bluetooth-update", "biometric-sign-in")) {
            assertTrue("no topic $id", book.topic(id) != null)
        }
        val items = Search.help(book)
        assertTrue(Search.rank("passkey", items).isNotEmpty())
        // The lock screen's and the Account switch's (?) (ui/LockScreen.kt, FINGERPRINT_HELP).
        assertTrue(Search.rank("fingerprint", items).any { it.item.target == SearchTarget.Help("biometric-sign-in") })
    }
}
