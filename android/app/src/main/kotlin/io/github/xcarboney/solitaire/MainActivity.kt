package io.github.xcarboney.solitaire

import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
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
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
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
 *  - page -> native: the `SolitaireNative` JavaScript interface ([NativeBridge]).
 */
class MainActivity : ComponentActivity() {

    private val mainThread = Handler(Looper.getMainLooper())

    private lateinit var container: FrameLayout
    private lateinit var assetLoader: WebViewAssetLoader

    /** Null before onStart, and between a renderer loss and the WebView being rebuilt. */
    private var webView: GameWebView? = null
    private var bridge: NativeBridge? = null

    /** True from onPageFinished of the game page until the next navigation or WebView teardown. */
    private var pageReady = false

    /** System bar + display cutout insets in physical px; null until the first dispatch. */
    private var insetsPx: Insets? = null

    /** The display density [insetsPx] was received at: CSS px = px / density. */
    private var insetsDensity = 1f

    /** uptimeMillis of the back press that showed the exit hint, 0 if none is pending. */
    private var exitHintShownAt = 0L
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

        assetLoader = WebViewAssetLoader.Builder()
            .setDomain(GameSite.HOST)
            .setHttpAllowed(false)
            .addPathHandler(GameSite.ASSETS_PATH, WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        container = FrameLayout(this)
        setContentView(container)

        // The WebView fills the window; the page keeps its controls clear of the system bars and
        // cutouts itself. The insets are passed on untouched so the WebView still sees them.
        ViewCompat.setOnApplyWindowInsetsListener(container) { _, windowInsets ->
            onWindowInsets(windowInsets)
            windowInsets
        }

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
        super.onPause()
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
        ViewCompat.requestApplyInsets(container)
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

    private fun onWindowInsets(windowInsets: WindowInsetsCompat) {
        val px = windowInsets.getInsets(
            WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
        )
        val density = resources.displayMetrics.density
        if (px == insetsPx && density == insetsDensity) return
        insetsPx = px
        insetsDensity = density
        publishInsets()
    }

    /**
     * Hands the current insets to the page. Before the page has loaded they are only stored (in
     * the bridge, for the document-start script); onPageFinished calls this again, which replays
     * them through SOL.App.setInsets.
     */
    private fun publishInsets() {
        val px = insetsPx ?: return
        val density = insetsDensity
        // Locale.US: a decimal comma would not be a number in JavaScript.
        val json = String.format(
            Locale.US,
            "{\"top\":%.2f,\"right\":%.2f,\"bottom\":%.2f,\"left\":%.2f}",
            px.top / density, px.right / density, px.bottom / density, px.left / density,
        )
        bridge?.safeAreaInsetsJson = json
        if (pageReady) {
            webView?.evaluateJavascript(SET_INSETS_SCRIPT.replace(INSETS_PLACEHOLDER, json), null)
        }
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

        val nativeBridge = NativeBridge(bridgeHost)
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

        /** Runs on a WebView background thread. Every request is answered here, never by the network. */
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse =
            assetLoader.shouldInterceptRequest(request.url) ?: blockedResponse()

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
            if (view === webView) pageReady = false
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
        if (exitHintShownAt != 0L && now - exitHintShownAt <= EXIT_CONFIRM_WINDOW_MS) {
            finish()
            return
        }
        exitHintShownAt = now
        exitHint = Toast.makeText(this, R.string.back_again_to_exit, Toast.LENGTH_SHORT).also { it.show() }
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

        const val EXIT_CONFIRM_WINDOW_MS = 2_000L
        const val BACK_ANSWER_TIMEOUT_MS = 1_000L

        const val RENDERER_LOSS_WINDOW_MS = 60_000L
        const val MAX_RENDERER_LOSSES_IN_WINDOW = 3

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
