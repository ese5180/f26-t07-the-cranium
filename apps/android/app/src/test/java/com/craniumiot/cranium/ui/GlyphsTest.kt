package com.craniumiot.cranium.ui

import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.graphics.vector.VectorPath
import com.craniumiot.cranium.core.Glyph
import org.junit.Assert.assertTrue
import org.junit.Test

/** Every icon is drawn from path text at its first use: none may fail to parse, or the app would stop there. */
class GlyphsTest {

    @Test
    fun `every icon builds, with at least one path of drawing commands`() {
        for (glyph in Glyph.entries) {
            val vector = Glyphs.vector(glyph)
            val paths = (0 until vector.root.size).map { vector.root[it] }.filterIsInstance<VectorPath>()
            assertTrue("$glyph has no path", paths.isNotEmpty())
            assertTrue("$glyph has an empty path", paths.all { it.pathData.size > 1 })
        }
    }

    @Test
    fun `the brand mark's paths parse`() {
        for (d in listOf("M2 18a14 14 0 0 1 28 0v9a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3z", "M7 30V18a9 9 0 0 1 18 0v12M12 30V18a4 4 0 0 1 8 0v12")) {
            assertTrue(PathParser().parsePathString(d).toNodes().size > 2)
        }
    }
}
