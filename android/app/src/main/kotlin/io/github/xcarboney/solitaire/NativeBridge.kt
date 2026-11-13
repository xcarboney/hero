package io.github.xcarboney.solitaire

import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface

/**
 * The object the page sees as `window.SolitaireNative` (contract: the header of
 * solitaire/js/core/platform.js).
 *
 * WebView calls these methods on its private "JavaBridge" thread, never on the UI thread. So a
 * method only validates its argument and hands the work to the UI thread; nothing here touches a
 * View or the Window directly, and nothing can throw back into the page.
 *
 * Only the methods annotated with [JavascriptInterface] are visible to JavaScript. R8 keeps
 * their names (app/proguard-rules.pro).
 */
internal class NativeBridge(private val host: Host) {

    /** What the bridge can ask of the Activity. Every method is called on the UI thread. */
    interface Host {
        fun playHaptic(kind: HapticKind)
        fun setKeepScreenOn(on: Boolean)
        fun exitApp()
    }

    private val mainThread = Handler(Looper.getMainLooper())

    @Volatile
    private var released = false

    /**
     * The current safe-area insets as a JSON object in CSS px, or "" while unknown. Written by
     * the UI thread, read by [safeAreaInsets] on the bridge thread.
     */
    @Volatile
    var safeAreaInsetsJson: String = ""

    /** `SolitaireNative.haptic(kind)`. Unknown kinds (and non-strings) are ignored. */
    @JavascriptInterface
    fun haptic(kind: String?) {
        val known = HapticKind.fromJsName(kind) ?: return
        onMainThread { host.playHaptic(known) }
    }

    /** `SolitaireNative.keepScreenOn(bool)`. Non-boolean arguments arrive as false. */
    @JavascriptInterface
    fun keepScreenOn(on: Boolean) {
        onMainThread { host.setKeepScreenOn(on) }
    }

    /** `SolitaireNative.exit()`: leave the app. */
    @JavascriptInterface
    fun exit() {
        onMainThread { host.exitApp() }
    }

    /**
     * `SolitaireNative.safeAreaInsets()` -> '{"top":24.00,"right":0.00,"bottom":16.00,"left":0.00}'
     * or ''. Not part of the page's contract: the shell's own document-start script uses it to
     * seed the --safe-* CSS variables before the first layout (see MainActivity).
     */
    @JavascriptInterface
    fun safeAreaInsets(): String = safeAreaInsetsJson

    /** Makes the bridge inert once its WebView is gone; late calls from the page are dropped. */
    fun release() {
        released = true
        mainThread.removeCallbacksAndMessages(null)
    }

    private fun onMainThread(action: () -> Unit) {
        if (released) return
        mainThread.post { if (!released) action() }
    }
}
