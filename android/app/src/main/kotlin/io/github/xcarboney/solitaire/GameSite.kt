package io.github.xcarboney.solitaire

import android.content.Context
import android.net.Uri
import android.webkit.WebResourceResponse
import androidx.annotation.WorkerThread
import androidx.core.net.toUri
import androidx.webkit.WebViewAssetLoader

/**
 * Where the bundled web game lives from the WebView's point of view.
 *
 * The APK carries the game under `assets/solitaire/`. WebViewAssetLoader serves that directory
 * on a reserved https origin that never resolves on the real network, which gives the page a
 * proper secure origin (so localStorage persists) without any network access.
 */
internal object GameSite {
    /** The host androidx.webkit reserves for in-app content (WebViewAssetLoader.DEFAULT_DOMAIN). */
    const val HOST = "appassets.androidplatform.net"
    const val ORIGIN = "https://$HOST"

    /** The game's directory inside the APK's assets (filled by the Gradle task bundleWebGame). */
    const val ASSET_DIR = "solitaire"

    /** URL path prefix that maps to [ASSET_DIR]. No other path on the origin serves anything. */
    const val GAME_PATH = "/assets/$ASSET_DIR/"

    const val START_URL = "$ORIGIN${GAME_PATH}index.html"

    /** True only for URLs on the app's own origin. Everything else is foreign and gets blocked. */
    fun owns(uri: Uri?): Boolean =
        uri != null &&
            "https".equals(uri.scheme, ignoreCase = true) &&
            HOST.equals(uri.host, ignoreCase = true) &&
            (uri.port == -1 || uri.port == 443)

    fun owns(url: String?): Boolean = url != null && owns(url.toUri())

    /**
     * data: and blob: URLs carry content the page built itself (the card backs are SVG data:
     * URIs). They never involve the network, so they are neither served nor blocked by the shell.
     */
    fun isInPageData(uri: Uri): Boolean =
        "data".equals(uri.scheme, ignoreCase = true) || "blob".equals(uri.scheme, ignoreCase = true)
}

/**
 * Serves `https://appassets.androidplatform.net/assets/solitaire/<path>` from the APK's
 * `assets/solitaire/<path>`, and only that directory.
 *
 * The stock AssetsPathHandler mounted on `/assets/` would hand out everything AssetManager can
 * open: other APK assets (release builds carry `assets/dexopt/`), plus the framework's and the
 * WebView package's own assets. The page has no business reading those, so the game directory
 * is the root here and any path that tries to step out of it is refused.
 */
internal class GameAssetsHandler(context: Context) : WebViewAssetLoader.PathHandler {

    // Application context: this object is used from WebView's IO threads and must not pin the
    // Activity. The APK's assets are the same through either context.
    private val assets = WebViewAssetLoader.AssetsPathHandler(context.applicationContext)

    /**
     * [path] is the already percent-decoded part of the URL path after [GameSite.GAME_PATH].
     * Returns null (the caller then answers 403) unless it is a plain relative file path.
     */
    @WorkerThread
    override fun handle(path: String): WebResourceResponse? {
        if (!isPlainRelativePath(path)) return null
        return assets.handle("${GameSite.ASSET_DIR}/$path")
    }

    private fun isPlainRelativePath(path: String): Boolean =
        path.isNotEmpty() &&
            '\\' !in path &&
            path.split('/').none { it.isEmpty() || it == "." || it == ".." }
}
