package io.github.xcarboney.solitaire

import java.io.File
import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The open-source notices: who may read them through the bridge ([GuardedNotices]), and the
 * file that ships in the APK (src/main/assets). That the file lists exactly the libraries that
 * are packaged is checked by the build itself (the Gradle task checkOpenSourceNotices).
 */
class OpenSourceNoticesTest {

    /** A loader that counts its calls and can be made to fail. */
    private class Loader(var answer: () -> String) : () -> String {
        var calls = 0
        override fun invoke(): String {
            calls++
            return answer()
        }
    }

    // ------------------------------------------------------------------------------ the gate

    @Test
    fun `the game's page gets the text, and it is read only once`() {
        val loader = Loader { "the notices" }
        val page = GuardedNotices(loader)
        assertEquals(0, loader.calls) // nothing is read before the page asks
        assertEquals("the notices", page.text())
        assertEquals("the notices", page.text())
        assertEquals(1, loader.calls)
    }

    @Test
    fun `a page that is not the game gets nothing, and nothing is read for it`() {
        val loader = Loader { "the notices" }
        val page = GuardedNotices(loader)
        page.pageTrusted = false
        assertEquals("", page.text())
        assertEquals(0, loader.calls)

        page.pageTrusted = true // the game's own page is back
        assertEquals("the notices", page.text())

        page.pageTrusted = false // also not from memory
        assertEquals("", page.text())
        assertEquals(1, loader.calls)
    }

    @Test
    fun `a released bridge gets nothing, whether the text was read before or not`() {
        val loader = Loader { "the notices" }
        val fresh = GuardedNotices(loader)
        fresh.released = true
        assertEquals("", fresh.text())
        assertEquals(0, loader.calls)

        val used = GuardedNotices(loader)
        assertEquals("the notices", used.text())
        used.released = true
        used.pageTrusted = true
        assertEquals("", used.text())
        assertEquals(1, loader.calls)
    }

    @Test
    fun `a text that cannot be read is answered with nothing and read again next time`() {
        val loader = Loader { throw IOException("asset missing") }
        val page = GuardedNotices(loader)
        assertEquals("", page.text())
        assertEquals("", page.text())
        assertEquals(2, loader.calls)

        loader.answer = { "" } // an empty file is not a text to remember either
        assertEquals("", page.text())
        assertEquals(3, loader.calls)

        loader.answer = { "the notices" }
        assertEquals("the notices", page.text())
        assertEquals("the notices", page.text())
        assertEquals(4, loader.calls)
    }

    // ------------------------------------------------------------------ the file in the APK

    /** Gradle runs unit tests with the module directory (app/) as the working directory. */
    private val shipped = File("src/main/assets", OpenSourceNotices.ASSET)

    @Test
    fun `the shipped notices contain the licence text exactly as the libraries ship it`() {
        // Every AndroidX library carries the Apache License 2.0 under META-INF; this one is a
        // plain jar, so the file is on the unit tests' classpath.
        val resource = javaClass.classLoader?.getResource("META-INF/androidx/annotation/annotation/LICENSE.txt")
        assertNotNull("androidx.annotation ships its LICENSE.txt", resource)
        val licence = resource!!.readText(Charsets.UTF_8)
        assertTrue("that file is the Apache License 2.0", licence.contains("Apache License") && licence.contains("Version 2.0"))
        assertTrue(licence.trimEnd().endsWith("END OF TERMS AND CONDITIONS"))

        val notices = shipped.readText(Charsets.UTF_8)
        assertTrue("the licence text is in the notices, character for character", notices.contains(licence))
        val heading = "TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION"
        assertEquals("...and only once", 1, notices.split(heading).size - 1)
    }

    @Test
    fun `the shipped notices are plain text the page can lay out`() {
        val lines = shipped.readLines(Charsets.UTF_8)
        // The page joins the lines of a paragraph again; it relies on plain ASCII without tabs
        // or carriage returns, and on the list entries being lines of their own.
        for ((index, line) in lines.withIndex()) {
            assertTrue("line ${index + 1} is printable ASCII", line.all { it in ' '..'~' })
            assertTrue("line ${index + 1} has at most 77 characters", line.length <= 77)
        }
        val libraries = lines.filter { it.startsWith("- ") }.map { it.removePrefix("- ") }
        assertTrue("the notices list libraries", libraries.size >= 3)
        val coordinate = Regex("[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+")
        for (library in libraries) assertTrue(library, coordinate.matches(library))
        assertEquals("no library is listed twice", libraries.size, libraries.toSet().size)
        for (direct in listOf("androidx.activity:activity", "androidx.core:core-ktx", "androidx.webkit:webkit")) {
            assertTrue("$direct is listed", direct in libraries)
        }
    }
}
