package io.github.xcarboney.solitaire

/**
 * The notices of the open-source libraries the APK bundles: which libraries, and the full text
 * of the licence they are distributed under (Apache License 2.0 asks that whoever receives a
 * copy of the libraries is given that text). The page shows it in Settings under "Open-source
 * licences", which it gets through `SolitaireNative.openSourceLicenses()`.
 *
 * The text is the plain-text file [ASSET] in the APK's assets (app/src/main/assets). It lies
 * next to `assets/solitaire/`, not inside it, so the page cannot load it by URL (only the game
 * directory is served, see [GameAssetsHandler]) and the web version, which bundles no
 * libraries, does not carry it. The Gradle task `checkOpenSourceNotices` (app/build.gradle.kts)
 * fails the build when the list in the file and the libraries that are packaged differ.
 */
internal object OpenSourceNotices {
    const val ASSET = "open_source_licenses.txt"
}

/**
 * The notices as one page may read them through `SolitaireNative.openSourceLicenses()`: not at
 * all once the page's bridge has been released or while the WebView shows something that is not
 * the game ([NativeBridge.pageTrusted]), the same rule as for [GuardedStore].
 *
 * Pure JVM code (no Android classes) so that it is covered by the unit tests in src/test.
 *
 * Both flags are written by the UI thread and read on the WebView's bridge thread, which is
 * also the thread [load] runs on.
 *
 * @param load reads the whole text. Called for the first request and not again once it has
 *   returned a text; a text that cannot be read (it throws, or is empty) is tried again with
 *   the next request.
 */
internal class GuardedNotices(private val load: () -> String) {
    @Volatile
    var released = false

    @Volatile
    var pageTrusted = true

    @Volatile
    private var loaded: String? = null

    /** The text, or "" when it is off limits for the page or cannot be read. */
    fun text(): String {
        if (released || !pageTrusted) return ""
        loaded?.let { return it }
        val text = try {
            load()
        } catch (e: Exception) {
            ""
        }
        if (text.isNotEmpty()) loaded = text
        return text
    }
}
