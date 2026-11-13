package io.github.xcarboney.solitaire

import android.content.SharedPreferences
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.ViewGroup
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.WindowManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.annotation.RequiresApi
import androidx.annotation.StringRes
import androidx.core.content.edit
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.Lifecycle
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.ByteArrayInputStream
import java.util.Locale

/**
 * The whole app: one full-screen, edge-to-edge WebView showing the web game bundled in the APK
 * (assets/solitaire/, copied from /solitaire at build time).
 *
 * Contract with the page (see solitaire/js/core/platform.js):
 *  - native -> page: `SOL.App.setInsets({top,right,bottom,left})` in CSS px, after every page
 *    load and whenever the insets change; `SOL.App.onBack()` for the back button.
 *  - page -> native: the `SolitaireNative` JavaScript interface ([NativeBridge]): haptics,
 *    keep-screen-on, full screen, gesture exclusion, the durable key/value store, exit.
 *
 * Full screen (the page's 'fullscreen' setting, on by default): the status and navigation bars
 * are hidden and a swipe from the edge only shows them for a moment. That is what keeps a card
 * drag that starts at the screen edge from being taken as the system's Back gesture: while the
 * navigation bar is hidden, system gestures need that reveal swipe first. With the setting off
 * the app is edge to edge under visible, transparent bars.
 */
class MainActivity : ComponentActivity() {

    private val mainThread = Handler(Looper.getMainLooper())

    private lateinit var container: FrameLayout
    private lateinit var assetLoader: WebViewAssetLoader

    /** The saved game, statistics and settings ([GameStorage]); shared by every WebView. */
    private lateinit var storage: KeyValueFileStore

    /** The shell's own few bits of state. Not the game's data: that is in [storage]. */
    private lateinit var shellPrefs: SharedPreferences

    /**
     * What the page asked for with SolitaireNative.setFullscreen. Remembered in [shellPrefs] so
     * that the next launch starts in the right mode instead of switching after the page loaded.
     */
    private var fullscreen = true

    /** True once the insets showed the bars hidden; see [watchForBarsComingBack]. */
    private var barsSeenHidden = false

    /** Null before onStart, and between a renderer loss and the WebView being rebuilt. */
    private var webView: GameWebView? = null
    private var bridge: NativeBridge? = null

    /** True from onPageFinished of the game page until the next navigation or WebView teardown. */
    private var pageReady = false

    /** System bar + display cutout insets in physical px; null until the first dispatch. */
    private var insetsPx: Insets? = null

    /**
     * What [insetsPx] is going to be once the bars are the way [applySystemBars] asked for them.
     * The two only differ for the moment in which a request to hide the bars has not taken
     * effect yet; see [onWindowInsets].
     */
    private var settledInsetsPx: Insets? = null

    /** The display density [insetsPx] was received at: CSS px = px / density. */
    private var insetsDensity = 1f

    /** uptimeMillis of the back press that showed the exit hint, 0 if none is pending. */
    private var exitHintShownAt = 0L

    /** How long after [exitHintShownAt] a second back press still closes the app. */
    private var exitHintWindowMs = EXIT_CONFIRM_WINDOW_MS
    private var exitHint: Toast? = null

    private var rendererLossWindowStart = 0L
    private var rendererLossesInWindow = 0

    // ------------------------------------------------------------------------------ lifecycle

    override fun onCreate(savedInstanceState: Bundle?) {
        // Transparent system bars with light icons: the table is dark in every theme of the game.
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)
        drawUnderDisplayCutouts()

        // Starts reading the stored values on its own thread; they are in memory long before
        // the page asks for them.
        storage = GameStorage.get(this)
        shellPrefs = getSharedPreferences(SHELL_PREFS, MODE_PRIVATE)
        fullscreen = shellPrefs.getBoolean(PREF_FULLSCREEN, true)

        // The game only plays short sound effects. Before Android 9 the volume keys change the
        // ringer volume unless media is audible at that very moment, so point them at the
        // stream the WebView plays on.
        volumeControlStream = AudioManager.STREAM_MUSIC

        assetLoader = WebViewAssetLoader.Builder()
            .setDomain(GameSite.HOST)
            .setHttpAllowed(false)
            // Only assets/solitaire/ is mounted: nothing else in the APK is reachable by URL.
            .addPathHandler(GameSite.GAME_PATH, GameAssetsHandler(this))
            .build()

        container = FrameLayout(this)
        setContentView(container)

        // The WebView fills the window; the page keeps its controls clear of the system bars and
        // cutouts itself. The insets are passed on untouched so the WebView still sees them.
        ViewCompat.setOnApplyWindowInsetsListener(container) { _, windowInsets ->
            onWindowInsets(windowInsets)
            windowInsets
        }

        applySystemBars()
        // Split screen and freeform windows cannot be immersive; follow the window in and out.
        addOnMultiWindowModeChangedListener { applySystemBars() }
        watchLegacySystemUiFlags()

        onBackPressedDispatcher.addCallback(this, backCallback)
    }

    override fun onStart() {
        super.onStart()
        // First start, or the renderer was lost while the app was in the background.
        if (webView == null) attachWebView()
    }

    override fun onResume() {
        super.onResume()
        webView?.onResume()
    }

    override fun onPause() {
        // Makes the page hidden (visibilitychange): it stops its clock, saves and suspends audio.
        webView?.onPause()
        // Every move is handed to the storage thread as it is made and written at once; this
        // only waits, briefly, for a write that is still under way.
        storage.flush(FLUSH_ON_PAUSE_MS)
        super.onPause()
    }

    override fun onStop() {
        // From here on the process may be killed without another callback (swiped away from
        // Recents, memory pressure). The page saved when it became hidden; make sure that, and
        // every move before it, is on disk before this returns.
        storage.flush(FLUSH_ON_STOP_MS)
        super.onStop()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        // The documented companion of immersive mode: whatever had the focus in between (a
        // dialog, the notification shade, Recents) may have left the bars showing. Ask again.
        if (hasFocus && fullscreen) applySystemBars()
    }

    override fun onDestroy() {
        destroyWebView()
        mainThread.removeCallbacksAndMessages(null)
        exitHint?.cancel()
        super.onDestroy()
    }

    /**
     * Every configuration change is declared in the manifest, so the Activity (and with it the
     * running game) survives rotation, resizing, density, dark mode and keyboard changes. The
     * WebView resizes with its parent and the page lays itself out again.
     */
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        // The page gets its insets in CSS px (px / density), so a density change alters them even
        // if the px values stay the same: ask for a fresh dispatch, onWindowInsets compares both.
        // applySystemBars does that, and repeats the bar request, which costs nothing while it
        // is still in force and puts it back if the new configuration dropped it.
        applySystemBars()
    }

    // -------------------------------------------------------------------------------- window

    private fun drawUnderDisplayCutouts() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return
        window.attributes = window.attributes.apply {
            layoutInDisplayCutoutMode =
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                } else {
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
                }
        }
    }

    /**
     * Shows or hides the status and navigation bars for the current [fullscreen] choice. Safe to
     * call again at any time: it only repeats what is already requested.
     *
     * Hidden means BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE ("sticky immersive"): a swipe from the
     * edge shows translucent bars over the game for a few seconds and the system hides them
     * again by itself. Those transient bars are not part of the window insets, so the page is
     * not laid out again for them. The display cutout mode is untouched: the window keeps
     * drawing into the cutout either way.
     *
     * The caption bar of a freeform window is left alone, and a window that shares the screen
     * (split screen, freeform, picture in picture) is never immersive: the system does not hide
     * the bars for it, and before Android 11 the insets would nevertheless claim they are gone.
     */
    private fun applySystemBars() {
        mainThread.removeCallbacks(hideBarsAgain)
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        val bars = WindowInsetsCompat.Type.statusBars() or WindowInsetsCompat.Type.navigationBars()
        if (fullscreen && !isInMultiWindowMode) {
            controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            controller.hide(bars)
        } else {
            controller.show(bars)
            controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_DEFAULT
        }
        // Before Android 11 hiding a bar does not change the (stable) insets the system sends,
        // so nothing is dispatched by itself; the compat insets do take the request into account.
        ViewCompat.requestApplyInsets(container)
    }

    /**
     * Android 7-10 only: the system can drop the hide flags on its own (it does so for a window
     * that is not in the sticky mode, and some devices do it after a system dialog). The stable
     * insets do not change then, so ask for a dispatch; [onWindowInsets] sees the bars as visible
     * again, tells the page and schedules [hideBarsAgain].
     */
    @Suppress("DEPRECATION") // the replacement (WindowInsets visibility) exists from API 30
    private fun watchLegacySystemUiFlags() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) return
        window.decorView.setOnSystemUiVisibilityChangeListener { ViewCompat.requestApplyInsets(container) }
    }

    /**
     * What the page has to keep clear, in physical px: display cutouts always, system bars only
     * while they are laid out as visible. getInsets() is zero for a hidden bar and is not
     * affected by the transient bars of the full-screen mode, so neither moves the board.
     *
     * On Android 11 and newer a request to hide the bars takes effect only once the window is
     * on screen and in control of them, so at a launch in full-screen mode the first insets can
     * still contain the bars, and the ones without them follow a few frames later. The page is
     * told the truth ([insetsPx]) as always, but the document-start script, which sizes the
     * very first layout, gets the insets the window is about to have ([settledInsetsPx]): a
     * page that starts loading in that moment would otherwise lay the board out for bars that
     * are already on their way out and jump when they are gone. (Should a device refuse to
     * hide them, SOL.App.setInsets corrects the layout as soon as the page has loaded.)
     */
    private fun onWindowInsets(windowInsets: WindowInsetsCompat) {
        watchForBarsComingBack(windowInsets)
        val px = windowInsets.getInsets(
            WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
        )
        val settledPx = if (fullscreen && !isInMultiWindowMode) {
            // systemBars() without the two bars applySystemBars hides: the caption bar stays.
            windowInsets.getInsets(
                WindowInsetsCompat.Type.captionBar() or WindowInsetsCompat.Type.displayCutout(),
            )
        } else {
            px
        }
        val density = resources.displayMetrics.density
        val changedForPage = px != insetsPx || density != insetsDensity
        if (!changedForPage && settledPx == settledInsetsPx) return
        insetsPx = px
        settledInsetsPx = settledPx
        insetsDensity = density
        publishInsets(tellPage = changedForPage)
    }

    /**
     * In full-screen mode the bars should only ever appear as transient overlays, which the
     * insets do not report. If the insets do report a bar that was hidden before, something put
     * it back for real (a device that does not honour the sticky mode, a system dialog): give
     * the player a moment to use it, then hide it again. One attempt per reappearance, so a
     * window whose bars cannot be hidden is left in peace.
     */
    private fun watchForBarsComingBack(windowInsets: WindowInsetsCompat) {
        val visible = windowInsets.isVisible(WindowInsetsCompat.Type.statusBars()) ||
            windowInsets.isVisible(WindowInsetsCompat.Type.navigationBars())
        if (!visible) {
            barsSeenHidden = true
            mainThread.removeCallbacks(hideBarsAgain)
        } else if (fullscreen && barsSeenHidden && !isInMultiWindowMode) {
            barsSeenHidden = false
            mainThread.removeCallbacks(hideBarsAgain)
            mainThread.postDelayed(hideBarsAgain, HIDE_BARS_AGAIN_DELAY_MS)
        }
    }

    private val hideBarsAgain = Runnable {
        // Without focus something is on top of the game; onWindowFocusChanged hides the bars later.
        if (fullscreen && hasWindowFocus() && !isFinishing) applySystemBars()
    }

    /**
     * Hands the current insets to the page. Before the page has loaded they are only stored (in
     * the bridge, for the document-start script); onPageFinished calls this again, which replays
     * them through SOL.App.setInsets.
     *
     * @param tellPage false when only [settledInsetsPx] changed: the page already has [insetsPx].
     */
    private fun publishInsets(tellPage: Boolean = true) {
        val px = insetsPx ?: return
        bridge?.safeAreaInsetsJson = insetsJson(settledInsetsPx ?: px)
        if (tellPage && pageReady) {
            webView?.evaluateJavascript(SET_INSETS_SCRIPT.replace(INSETS_PLACEHOLDER, insetsJson(px)), null)
        }
    }

    /** [px] as the JSON object the page expects, in CSS px at [insetsDensity]. */
    private fun insetsJson(px: Insets): String {
        val density = insetsDensity
        // Locale.US: a decimal comma would not be a number in JavaScript.
        return String.format(
            Locale.US,
            "{\"top\":%.2f,\"right\":%.2f,\"bottom\":%.2f,\"left\":%.2f}",
            px.top / density, px.right / density, px.bottom / density, px.left / density,
        )
    }

    // ------------------------------------------------------------------------------- WebView

    private fun attachWebView() {
        if (webView != null || isFinishing || isDestroyed) return

        val view = try {
            GameWebView(this)
        } catch (e: RuntimeException) {
            // The WebView provider is missing, disabled or in the middle of an update.
            Log.e(TAG, "WebView is not available", e)
            closeWithMessage(R.string.error_webview_unavailable)
            return
        }
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)

        val nativeBridge = NativeBridge(bridgeHost, storage)
        view.webViewClient = GameClient()
        view.addJavascriptInterface(nativeBridge, JS_INTERFACE_NAME)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            // Seeds the page's --safe-* variables before its first layout, so the board does not
            // jump when the insets arrive through SOL.App.setInsets after the load.
            WebViewCompat.addDocumentStartJavaScript(view, SEED_INSETS_SCRIPT, setOf(GameSite.ORIGIN))
        }

        webView = view
        bridge = nativeBridge
        pageReady = false
        publishInsets() // stores the insets in the new bridge if they are already known

        container.addView(view, MATCH_PARENT, MATCH_PARENT)
        view.requestFocus()
        view.loadUrl(GameSite.START_URL)
    }

    private fun destroyWebView() {
        val view = webView ?: return
        webView = null
        pageReady = false
        bridge?.release()
        bridge = null
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        container.removeView(view)
        view.destroy()
    }

    /**
     * The renderer process died (it crashed, or the system reclaimed its memory). The WebView is
     * unusable from here on, but the app is fine: build a new one, and the game restores itself
     * from the state it saves after every move.
     */
    private fun onRendererGone(crashed: Boolean) {
        Log.w(TAG, "WebView renderer is gone (crashed=$crashed)")
        destroyWebView()
        if (isFinishing || isDestroyed) return
        // In the background, wait: onStart() rebuilds the WebView when the user comes back.
        if (!lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) return

        val now = SystemClock.uptimeMillis()
        if (rendererLossesInWindow == 0 || now - rendererLossWindowStart > RENDERER_LOSS_WINDOW_MS) {
            rendererLossWindowStart = now
            rendererLossesInWindow = 0
        }
        rendererLossesInWindow++
        if (rendererLossesInWindow >= MAX_RENDERER_LOSSES_IN_WINDOW) {
            // Something is badly wrong: close cleanly instead of reloading forever.
            closeWithMessage(R.string.error_game_keeps_stopping)
            return
        }
        attachWebView()
    }

    private fun closeWithMessage(@StringRes message: Int) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
        finish()
    }

    private inner class GameClient : WebViewClient() {

        /**
         * Runs on a WebView background thread. Every request that could leave the app is answered
         * here, never by the network: with the game's file, or with an empty 403.
         *
         * The platform documents that this callback can also be invoked for data: URLs. Those
         * are content the page generated itself (its card backs are SVG data: URIs), so they are
         * left to WebView instead of being answered with the 403.
         */
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            val url = request.url
            if (GameSite.isInPageData(url)) return null
            // WebViewAssetLoader dereferences the scheme; a URL without one is not ours anyway.
            if (url.scheme == null) return blockedResponse()
            return assetLoader.shouldInterceptRequest(url) ?: blockedResponse()
        }

        /**
         * Navigation lock: the page may only ever navigate within the app's own origin. Anything
         * else is dropped, so foreign content can never run next to the SolitaireNative bridge.
         */
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (GameSite.owns(request.url)) return false
            Log.w(TAG, "Blocked navigation to ${request.url}")
            return true
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            if (view !== webView) return
            pageReady = false
            // The storage methods of the bridge answer off the UI thread and cannot look at the
            // WebView's URL themselves: tell them whether this is still the game. An empty
            // document is not a foreign page (it has no content of its own), and treating it as
            // one could make the game's very first read miss if it were reported just before
            // the game: the page would then take its older localStorage copy for the latest.
            bridge?.pageTrusted = url == null || url == BLANK_URL || GameSite.owns(url)
        }

        override fun onPageFinished(view: WebView, url: String?) {
            if (view !== webView || !GameSite.owns(url)) return
            pageReady = true
            publishInsets()
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            Log.w(TAG, "Failed to load ${request.url}: ${error.errorCode} ${error.description}")
        }

        @RequiresApi(Build.VERSION_CODES.O)
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            if (view === webView) {
                onRendererGone(detail.didCrash())
            } else {
                (view.parent as? ViewGroup)?.removeView(view)
                view.destroy()
            }
            return true // handled: without this the system kills the whole app
        }
    }

    // ---------------------------------------------------------------------------- back button

    private val backCallback = object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() = onBack()
    }

    /**
     * Back first goes to the page (it closes its top overlay and answers true). Only when the
     * page has nothing to close does it count towards "press back again to exit". If the page
     * cannot answer (not loaded, script error, unresponsive renderer) the press counts too.
     */
    private fun onBack() {
        val view = webView
        if (view == null || !pageReady) {
            exitOnSecondPress()
            return
        }

        var settled = false
        val noAnswer = Runnable {
            if (!settled) {
                settled = true
                exitOnSecondPress()
            }
        }
        mainThread.postDelayed(noAnswer, BACK_ANSWER_TIMEOUT_MS)
        view.evaluateJavascript(ON_BACK_SCRIPT) { answer ->
            if (settled) return@evaluateJavascript
            settled = true
            mainThread.removeCallbacks(noAnswer)
            if (answer == "true") {
                // The page used this press: an exit needs two fresh ones.
                exitHintShownAt = 0L
                exitHint?.cancel()
            } else {
                exitOnSecondPress()
            }
        }
    }

    private fun exitOnSecondPress() {
        if (isFinishing || isDestroyed) return
        val now = SystemClock.uptimeMillis()
        exitHint?.cancel()
        if (exitHintShownAt != 0L && now - exitHintShownAt <= exitHintWindowMs) {
            finish()
            return
        }
        // With the bars hidden a back press is two gestures, not one: a swipe that shows the bars
        // and then Back itself. With gesture navigation the system hides the bars again right
        // after the first Back, so the second one needs both gestures once more. Two seconds are
        // not enough for that; give the hint (and the player) the long toast's time instead.
        val barsHidden = fullscreen && !isInMultiWindowMode
        exitHintWindowMs = if (barsHidden) EXIT_CONFIRM_WINDOW_FULLSCREEN_MS else EXIT_CONFIRM_WINDOW_MS
        exitHintShownAt = now
        val duration = if (barsHidden) Toast.LENGTH_LONG else Toast.LENGTH_SHORT
        exitHint = Toast.makeText(this, R.string.back_again_to_exit, duration).also { it.show() }
    }

    // --------------------------------------------------------------------------------- bridge

    /** Runs on the UI thread (NativeBridge hops over from the JavaScript bridge thread). */
    private val bridgeHost = object : NativeBridge.Host {

        override fun playHaptic(kind: HapticKind) {
            val view = trustedWebView() ?: return
            Haptics.play(view, kind)
        }

        override fun setKeepScreenOn(on: Boolean) {
            if (trustedWebView() == null) return
            if (on) {
                window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            } else {
                window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }

        override fun setFullscreen(on: Boolean) {
            if (trustedWebView() == null || on == fullscreen) return
            fullscreen = on
            shellPrefs.edit { putBoolean(PREF_FULLSCREEN, on) }
            barsSeenHidden = false
            applySystemBars()
        }

        override fun setGestureExclusion(rects: List<CssRect>) {
            trustedWebView()?.setGestureExclusion(rects)
        }

        override fun exitApp() {
            if (trustedWebView() == null) return
            finish()
        }

        /** Second line of defence behind the navigation lock: only act for the game's own page. */
        private fun trustedWebView(): GameWebView? = webView?.takeIf { GameSite.owns(it.url) }
    }

    private companion object {
        const val TAG = "Solitaire"

        /** The name the page looks for: `window.SolitaireNative`. */
        const val JS_INTERFACE_NAME = "SolitaireNative"

        /** As long as the hint is on screen: Toast.LENGTH_SHORT is 2 s, Toast.LENGTH_LONG 3.5 s. */
        const val EXIT_CONFIRM_WINDOW_MS = 2_000L
        const val EXIT_CONFIRM_WINDOW_FULLSCREEN_MS = 3_500L
        const val BACK_ANSWER_TIMEOUT_MS = 1_000L

        /** SharedPreferences file of the shell (not backed up: the page's setting is, and wins). */
        const val SHELL_PREFS = "shell"
        const val PREF_FULLSCREEN = "fullscreen"

        /** How long bars that came back in full-screen mode stay before they are hidden again. */
        const val HIDE_BARS_AGAIN_DELAY_MS = 3_000L

        /**
         * Upper bounds for waiting on the storage thread in onPause / onStop. A write takes a
         * few milliseconds, so normally there is nothing to wait for; the bounds only matter on
         * a device whose storage is stalling. onPause has to stay brief (the next screen waits
         * for it), onStop is where the platform expects saving to finish.
         */
        const val FLUSH_ON_PAUSE_MS = 100L
        const val FLUSH_ON_STOP_MS = 500L

        const val RENDERER_LOSS_WINDOW_MS = 60_000L
        const val MAX_RENDERER_LOSSES_IN_WINDOW = 3

        /** The empty document a WebView shows before its first load. */
        const val BLANK_URL = "about:blank"

        const val INSETS_PLACEHOLDER = "__INSETS__"

        /** Safe before SOL exists and after a failed load: it simply does nothing then. */
        const val SET_INSETS_SCRIPT =
            "(function(i){var a=window.SOL&&window.SOL.App;" +
                "if(a&&typeof a.setInsets==='function')a.setInsets(i);})($INSETS_PLACEHOLDER);"

        /** Evaluates to true only when the page really consumed the back press. */
        const val ON_BACK_SCRIPT =
            "(function(){try{var a=window.SOL&&window.SOL.App;" +
                "return !!(a&&typeof a.onBack==='function'&&a.onBack()===true);}" +
                "catch(e){return false;}})();"

        /**
         * Runs at document start (before any page script) where the WebView supports it: copies
         * the insets the shell already knows into the CSS variables that css/base.css reads, so
         * the very first layout is already clear of the system bars. SOL.App.setInsets sets the
         * same variables again after the load. If the <html> element does not exist yet, the
         * script waits for it (the observer fires before the first page script runs).
         */
        const val SEED_INSETS_SCRIPT =
            "(function(){function seed(){try{var n=window.$JS_INTERFACE_NAME;" +
                "if(!n||typeof n.safeAreaInsets!=='function')return;" +
                "var j=n.safeAreaInsets();if(!j)return;" +
                "var i=JSON.parse(j),s=document.documentElement.style;" +
                "s.setProperty('--safe-t',i.top+'px');s.setProperty('--safe-r',i.right+'px');" +
                "s.setProperty('--safe-b',i.bottom+'px');s.setProperty('--safe-l',i.left+'px');" +
                "}catch(e){}}" +
                "if(document.documentElement){seed();return;}" +
                "try{new MutationObserver(function(m,o){if(document.documentElement){" +
                "o.disconnect();seed();}}).observe(document,{childList:true});}catch(e){}" +
                "})();"

        fun blockedResponse(): WebResourceResponse =
            WebResourceResponse(
                "text/plain", "utf-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)),
            )
    }
}
