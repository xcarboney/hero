package io.github.xcarboney.solitaire

import android.net.Uri
import androidx.core.net.toUri

/**
 * Where the bundled web game lives from the WebView's point of view.
 *
 * The APK carries the game under `assets/solitaire/`. WebViewAssetLoader serves the APK assets
 * on a reserved https origin that never resolves on the real network, which gives the page a
 * proper secure origin (so localStorage persists) without any network access.
 */
internal object GameSite {
    /** The host androidx.webkit reserves for in-app content (WebViewAssetLoader.DEFAULT_DOMAIN). */
    const val HOST = "appassets.androidplatform.net"
    const val ORIGIN = "https://$HOST"

    /** URL path prefix that maps to the root of the APK's assets directory. */
    const val ASSETS_PATH = "/assets/"

    const val START_URL = "$ORIGIN${ASSETS_PATH}solitaire/index.html"

    /** True only for URLs on the app's own origin. Everything else is foreign and gets blocked. */
    fun owns(uri: Uri?): Boolean =
        uri != null &&
            "https".equals(uri.scheme, ignoreCase = true) &&
            HOST.equals(uri.host, ignoreCase = true) &&
            (uri.port == -1 || uri.port == 443)

    fun owns(url: String?): Boolean = url != null && owns(url.toUri())
}
