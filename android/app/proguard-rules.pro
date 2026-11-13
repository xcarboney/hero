# R8 rules for the release build.
#
# WebView finds the methods of the object passed to addJavascriptInterface() by reflection, by
# their Java names, and only exposes those that still carry @JavascriptInterface at runtime.
# The page calls SolitaireNative.haptic / keepScreenOn / exit / safeAreaInsets, so those methods
# must keep their names, must not be removed as "unused" (nothing in Kotlin calls them) and must
# keep their annotation.
-keepattributes RuntimeVisibleAnnotations

-keepclassmembers class io.github.xcarboney.solitaire.NativeBridge {
    @android.webkit.JavascriptInterface public <methods>;
}
