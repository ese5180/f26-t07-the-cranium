package com.craniumiot.cranium.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The file picker's types for a page's accept list (ShellFiles): never the ".json" that WebView would ask for. */
class ShellFilesTest {
    @Test
    fun theCustomerSitesImportOffersCsvAndJsonByEveryNameTheyGo() {
        // The customer site's Import session (customer-mix-views.js), split or not, as WebView may give it.
        for (accept in listOf(arrayOf(".json,.csv,application/json,text/csv"), arrayOf(".json", ".csv", "application/json", "text/csv"))) {
            val types = ShellFiles.mimeTypes(accept)
            for (type in listOf("application/json", "text/csv", "text/comma-separated-values", "text/plain", "application/octet-stream")) {
                assertTrue("$type for ${accept.joinToString()}", type in types)
            }
            assertTrue(types.none { it.startsWith(".") })
            assertEquals(types.distinct(), types)
        }
    }

    @Test
    fun theConsolesFirmwareUploadOffersBinaryFiles() {
        assertEquals(
            listOf("application/octet-stream", "application/x-binary", "application/macbinary"),
            ShellFiles.mimeTypes(arrayOf(".bin,application/octet-stream")),
        )
    }

    @Test
    fun anEntryItDoesNotKnowOrNoneLetsAnyFileThrough() {
        assertEquals(emptyList<String>(), ShellFiles.mimeTypes(null))
        assertEquals(emptyList<String>(), ShellFiles.mimeTypes(arrayOf("")))
        assertEquals(emptyList<String>(), ShellFiles.mimeTypes(arrayOf(".csv,image/*")))
        assertEquals(ShellFiles.mimeTypes(arrayOf(".csv")), ShellFiles.mimeTypes(arrayOf(" .CSV ")))
    }
}
