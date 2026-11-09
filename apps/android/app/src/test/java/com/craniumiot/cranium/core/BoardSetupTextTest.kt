package com.craniumiot.cranium.core

import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/** The app's words for Board setup are the website's (setup.js APP_WORDS). Skipped without the console's sources. */
class BoardSetupTextTest {
    private fun setupJs(): String? = generateSequence(File("").absoluteFile) { it.parentFile }
        .take(8)
        .map { File(it, "cloud/web/src/site/assets/setup.js") }
        .firstOrNull { it.isFile }
        ?.readText()

    @Test
    fun `the words are the website's`() {
        val text = setupJs()
        assumeTrue("setup.js is not in this checkout", text != null)
        val block = text!!.substringAfter("export const APP_WORDS = Object.freeze({").substringBefore("});")
            .replace(Regex("""'\s*\+\s*'"""), "")
        fun value(key: String) = Regex("""$key:\s*'([^']*)'""").find(block)!!.groupValues[1]
        assertEquals(value("title"), BoardSetupText.TITLE)
        assertEquals(value("android"), BoardSetupText.ANDROID)
    }
}
