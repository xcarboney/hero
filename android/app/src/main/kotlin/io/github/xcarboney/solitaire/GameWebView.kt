package io.github.xcarboney.solitaire

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.view.View
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.core.content.ContextCompat

/**
 * The one WebView of the app: locked down so that it can show the bundled game and nothing else,
 * and stripped of the browser behaviours a game does not want (zoom, overscroll glow, the
 * platform long-press).
 */
internal class GameWebView(context: Context) : WebView(context) {

    init {
        applySettings()

        // Same colour as the window, the splash screen and the page's own background, so there
        // is no white (or black) frame between app start and the first paint of the game.
        setBackgroundColor(ContextCompat.getColor(context, R.color.table))

        overScrollMode = View.OVER_SCROLL_NEVER
        isVerticalScrollBarEnabled = false
        isHorizontalScrollBarEnabled = false

        // NativeBridge plays haptics through this view (View.performHapticFeedback).
        isHapticFeedbackEnabled = true

        // Hardware keyboards work in the game too: let key events reach the page.
        isFocusable = true
        isFocusableInTouchMode = true
    }

    /**
     * Long-press belongs to the page (it opens the 3D card inspector). WebView offers every
     * long-press to its View first, and a "handled" answer keeps the gesture away from the
     * platform behaviours (text selection, image drag, context menu) that would otherwise cancel
     * the page's own pointer events.
     *
     * Overriding this instead of using setOnLongClickListener { true } is deliberate: a listener
     * that returns true makes View play its own LONG_PRESS haptic on top of the game's haptics.
     */
    override fun performLongClick(): Boolean = true

    override fun performLongClick(x: Float, y: Float): Boolean = true

    // JavaScript is the whole point here: the only content ever loaded is the game from the APK.
    @SuppressLint("SetJavaScriptEnabled")
    @Suppress("DEPRECATION") // the file-URL switches are deprecated but still worth pinning to false
    private fun applySettings() {
        settings.apply {
            // What the game needs.
            javaScriptEnabled = true
            domStorageEnabled = true // localStorage: saved game, statistics, settings
            mediaPlaybackRequiresUserGesture = false // Web Audio may start with the first deal

            // What it must never get. Assets are served by WebViewAssetLoader over https, so
            // file:// and content:// access can be switched off completely.
            allowFileAccess = false
            allowContentAccess = false
            allowFileAccessFromFileURLs = false
            allowUniversalAccessFromFileURLs = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            // Already the default for an app without the INTERNET permission; explicit so it
            // stays true if a permission is ever added. Intercepted requests are still served.
            blockNetworkLoads = true
            setGeolocationEnabled(false)
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                safeBrowsingEnabled = false // nothing to check: no content comes from the network
            }

            // Layout: honour the page's viewport meta tag, no zooming of any kind, and ignore the
            // system font scale (the card layout is sized in CSS px and must not be inflated).
            useWideViewPort = true
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            textZoom = 100
        }
    }
}
