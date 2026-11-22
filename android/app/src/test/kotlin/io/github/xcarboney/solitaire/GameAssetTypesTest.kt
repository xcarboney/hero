package io.github.xcarboney.solitaire

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * The content types the bundled game is served with.
 *
 * [GameAssetsHandler] hands every request to androidx.webkit's AssetsPathHandler, and that names
 * the type from the file name alone: first by the platform's table, then by a table of its own,
 * and `text/plain` for anything neither knows. A WebView does not decode a picture that arrives
 * as text/plain, so a file type the library does not know would show as an empty card. The
 * game's card art is WebP (`solitaire/art/`); these tests pin that the library names it
 * `image/webp`, and that the art folder holds nothing else.
 *
 * The library's helper is internal API, so it is called by reflection: when a new version of
 * androidx.webkit moves it, this test fails with a message that says what to check, instead of
 * the build failing to compile.
 */
class GameAssetTypesTest {

    private fun helper(className: String, method: String) =
        try {
            Class.forName(className).getDeclaredMethod(method, String::class.java).apply { isAccessible = true }
        } catch (e: ReflectiveOperationException) {
            fail(
                "androidx.webkit has changed ($className.$method is gone). Check by hand that " +
                    "WebViewAssetLoader.AssetsPathHandler still serves .webp as image/webp, then update this test.",
            )
            throw e
        }

    /** The type AssetsPathHandler gives a response for [path]. */
    private fun servedType(path: String): String =
        helper("androidx.webkit.internal.AssetHelper", "guessMimeType").invoke(null, path) as String

    /** The library's own table, which answers when the platform's does not know the extension. */
    private fun libraryType(path: String): String? =
        helper("androidx.webkit.internal.MimeUtil", "guessHardcodedMime").invoke(null, path) as String?

    @Test
    fun `webp pictures are served as image webp`() {
        assertEquals("image/webp", servedType("${GameSite.ASSET_DIR}/art/holo/back-a-s.webp"))
        assertEquals("image/webp", servedType("${GameSite.ASSET_DIR}/art/holo/court-spades-13-l.webp"))
        // Not left to the platform's table: the library knows the extension itself.
        assertEquals("image/webp", libraryType("back-a-s.webp"))
    }

    @Test
    fun `the page, its styles and its scripts keep their types`() {
        assertEquals("text/html", servedType("${GameSite.ASSET_DIR}/index.html"))
        assertEquals("text/css", servedType("${GameSite.ASSET_DIR}/css/cards.css"))
        assertTrue(servedType("${GameSite.ASSET_DIR}/js/main.js") in setOf("text/javascript", "application/javascript"))
    }

    @Test
    fun `every file of the card art is a picture the app can serve`() {
        // Unit tests run in the app module's directory; the game lies next to the android project.
        val art = sequenceOf(File("../../solitaire/art"), File("../solitaire/art")).firstOrNull { it.isDirectory }
        assertTrue("the game's art folder was not found from ${File(".").absolutePath}", art != null)
        val files = art!!.walkTopDown().filter { it.isFile && !it.name.startsWith(".") }.toList()
        assertTrue("the art folder is empty", files.isNotEmpty())
        for (file in files) {
            val type = servedType("${GameSite.ASSET_DIR}/art/${file.relativeTo(art).invariantSeparatorsPath}")
            assertTrue("${file.name} would be served as $type, which a WebView does not show as a picture", type.startsWith("image/"))
        }
    }
}
