package io.github.xcarboney.solitaire

import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface

/**
 * The object the page sees as `window.SolitaireNative` (contract: the header of
 * solitaire/js/core/platform.js, and the table in android/README.md).
 *
 * WebView calls these methods on its private "JavaBridge" thread, never on the UI thread. So a
 * method that changes the window or a View only validates its argument and hands the work to
 * the UI thread ([Host]); nothing here touches a View or the Window directly, and nothing can
 * throw back into the page.
 *
 * The storage methods are different: the page needs their answer at once, so they run on the
 * bridge thread against [storage], which is thread-safe and never makes a caller wait for a
 * disk write (see [KeyValueFileStore]). [openSourceLicenses] answers on the bridge thread too:
 * it reads one small file from the APK, once.
 *
 * Only the methods annotated with [JavascriptInterface] are visible to JavaScript. R8 keeps
 * their names (app/proguard-rules.pro).
 *
 * @param readNotices reads the open-source notices ([OpenSourceNotices]); called on the bridge
 *   thread, at most until it has returned the text once.
 */
internal class NativeBridge(
    private val host: Host,
    storage: KeyValueFileStore,
    readNotices: () -> String,
) {

    /** What the bridge can ask of the Activity. Every method is called on the UI thread. */
    interface Host {
        fun playHaptic(kind: HapticKind)
        fun setKeepScreenOn(on: Boolean)
        fun setFullscreen(on: Boolean)
        fun setGestureExclusion(rects: List<CssRect>)
        fun exitApp()
    }

    private val mainThread = Handler(Looper.getMainLooper())

    /** The store as this bridge's page may use it: not at all once [release]d or untrusted. */
    private val storage = GuardedStore(storage)

    /** The open-source notices, under the same rule as [storage]. */
    private val notices = GuardedNotices(readNotices)

    @Volatile
    private var released = false

    /**
     * The safe-area insets for a page that is about to lay itself out, as a JSON object in CSS
     * px, or "" while unknown. Written by the UI thread, read by [safeAreaInsets] on the bridge
     * thread.
     */
    @Volatile
    var safeAreaInsetsJson: String = ""

    /**
     * False while the WebView shows a page that is not the game's own origin. The UI-thread
     * methods check the WebView's URL when they run; the storage methods answer on the bridge
     * thread, where the WebView must not be touched, so the Activity keeps this flag up to date
     * from its navigation callbacks instead. It starts out true because the bridge is only ever
     * attached to a WebView that loads the game next, and the page's first scripts already read
     * the saved game: waiting for a callback there would make that first read miss.
     *
     * Like the URL check it is a second line of defence. The first is that a foreign page can
     * never load: no INTERNET permission, every request answered locally, navigation locked.
     * The flag itself lives in [GuardedStore] (and, for [openSourceLicenses], in
     * [GuardedNotices]), which is what the unit tests cover.
     */
    var pageTrusted: Boolean
        get() = storage.pageTrusted
        set(value) {
            storage.pageTrusted = value
            notices.pageTrusted = value
        }

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

    /**
     * `SolitaireNative.setFullscreen(bool)`: true hides the status and navigation bars (a swipe
     * from the edge shows them for a moment), false shows them. Idempotent.
     */
    @JavascriptInterface
    fun setFullscreen(on: Boolean) {
        onMainThread { host.setFullscreen(on) }
    }

    /**
     * `SolitaireNative.setGestureExclusion('[{"x":0,"y":120,"w":40,"h":500}, ...]')`: areas of
     * the page, in CSS px, where a swipe from the screen edge must reach the game instead of
     * being taken as the system's Back gesture. `'[]'` clears them. Anything that is not such a
     * list is ignored and the current areas stay.
     */
    @JavascriptInterface
    fun setGestureExclusion(json: String?) {
        val rects = GestureRects.parse(json) ?: return
        onMainThread { host.setGestureExclusion(rects) }
    }

    /** `SolitaireNative.exit()`: leave the app. */
    @JavascriptInterface
    fun exit() {
        onMainThread { host.exitApp() }
    }

    /**
     * `SolitaireNative.safeAreaInsets()` -> '{"top":24.00,"right":0.00,"bottom":16.00,"left":0.00}'
     * or ''. The page gets its insets through SOL.App.setInsets; this getter exists for the
     * shell's own document-start script, which seeds the --safe-* CSS variables before the first
     * layout (see MainActivity). The values are the ones SOL.App.setInsets delivers, except while
     * a request to hide the bars is still taking effect: then they are already without the bars.
     */
    @JavascriptInterface
    fun safeAreaInsets(): String = safeAreaInsetsJson

    /**
     * `SolitaireNative.storageGet(key)` -> the stored string, or null when there is none (the
     * WebView hands a null String to the page as `undefined`, so the page tests for a string).
     * Always the latest value passed to [storageSet], also before it has reached the disk.
     */
    @JavascriptInterface
    fun storageGet(key: String?): String? = storage.get(key)

    /**
     * `SolitaireNative.storageSet(key, value)` -> true when the value was accepted. False for a
     * key outside `[A-Za-z0-9._-]{1,64}`, a value over 2 MB or a full store; the previous value
     * of the key then stays as it was.
     */
    @JavascriptInterface
    fun storageSet(key: String?, value: String?): Boolean = storage.set(key, value)

    /**
     * `SolitaireNative.storageRemove(key)` -> true unless the key is not a valid key. (The page
     * rarely calls it: to remove a key durably store.js stores its marker `<removed>` instead,
     * see the header of solitaire/js/core/store.js. Values are never interpreted here.)
     */
    @JavascriptInterface
    fun storageRemove(key: String?): Boolean = storage.remove(key)

    /** `SolitaireNative.storageKeys()` -> a JSON array of the keys that have a value, sorted. */
    @JavascriptInterface
    fun storageKeys(): String = storage.keysJson()

    /**
     * `SolitaireNative.openSourceLicenses()` -> the notices of the open-source libraries in the
     * APK: which libraries, then the full text of their licence, as plain text with lines of at
     * most 77 characters ([OpenSourceNotices]). "" when the text cannot be read. The page shows
     * it in Settings under "Open-source licences" and offers that entry only when this method
     * exists.
     */
    @JavascriptInterface
    fun openSourceLicenses(): String = notices.text()

    /** Makes the bridge inert once its WebView is gone; late calls from the page are dropped. */
    fun release() {
        released = true
        storage.released = true
        notices.released = true
        mainThread.removeCallbacksAndMessages(null)
    }

    private fun onMainThread(action: () -> Unit) {
        if (released) return
        mainThread.post { if (!released) action() }
    }
}
