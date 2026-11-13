# Solitaire 3D for Android

The Android app for the Klondike solitaire in [`../solitaire`](../solitaire). The game itself is
the web page; this project wraps it in a single full-screen `WebView` and ships it as an APK
(`io.github.xcarboney.solitaire`, Android 7.0 / API 24 and newer).

The app asks for **no permissions**, not even internet access: the game is inside the APK and
the saved game, statistics and settings stay on the device (they are included in Android's
backup and device-to-device transfer, see [Where the saved game lives](#where-the-saved-game-lives)).

It runs full screen by default, so that dragging a card from the edge of the screen is never
taken for the system's Back gesture; see [Full screen and the Back gesture](#full-screen-and-the-back-gesture).

## How the web game gets into the APK

There is exactly one copy of the game in the repository: `../solitaire`. Nothing is copied into
`app/src`. On every build the Gradle task `:app:bundleWebGame` syncs the runtime files of
`../solitaire` into `app/build/generated/assets/bundleWebGame/solitaire/`, and that directory is
merged into the APK as `assets/solitaire/`.

- Left out: `dev/`, `tests/`, dot-files, `*.md`, `*.map`, and the files only the installable
  web version uses (`sw.js`, the web manifest, `icons/`). Everything else under `../solitaire`
  ships; the list is in `app/build.gradle.kts`.
- The task is incremental: change a file of the game, build again, and the APK has the change.
- The build fails with "Web game not found" if `../solitaire/index.html` is missing, so check
  out the whole repository, not only `android/`.

At runtime the page is loaded from `https://appassets.androidplatform.net/assets/solitaire/index.html`.
That address never leaves the device: `WebViewAssetLoader` answers it from the APK, and only
`assets/solitaire/` is reachable that way.

## How the app and the page talk

The app injects one object into the page, `window.SolitaireNative` (`NativeBridge.kt`), and
calls two functions of the page. The page's side is `../solitaire/js/core/platform.js` (its
header is the same contract seen from JavaScript) and, for storage, `../solitaire/js/core/store.js`.
The page looks every method up before calling it, so a page and a shell of different ages still
work together; each side just goes without what the other does not have.

Page to app, `SolitaireNative.…`:

| Method | Returns | What it does |
| --- | --- | --- |
| `haptic(kind)` | | Plays a haptic effect: `tick`, `tap`, `thud`, `success`, `error`, `heavy` or `win`. Unknown kinds are ignored. |
| `keepScreenOn(bool)` | | Keeps the display awake while `true`. |
| `setFullscreen(bool)` | | `true` hides the status and navigation bars, `false` shows them. Idempotent. The app remembers the last value and starts in that mode next time. |
| `setGestureExclusion(json)` | | `json` is an array of at most 8 rectangles in CSS px relative to the viewport, `[{"x":0,"y":120,"w":40,"h":500}, …]`: areas where a swipe from the screen edge belongs to the game, not to the Back gesture. `[]` clears them. Invalid input is ignored. Android 10 and newer. |
| `exit()` | | Closes the app. |
| `safeAreaInsets()` | string | `{"top":24.00,"right":0.00,"bottom":16.00,"left":0.00}` in CSS px, or `""` while unknown. Read by the app's own start-up script, which sizes the first layout; the page gets the same values through `SOL.App.setInsets`. (While the bars are on their way out, right after a start in full-screen mode, this already answers without them.) |
| `storageGet(key)` | string | The stored value; always the latest one, also before it has reached the disk. No value is a Java `null`, which arrives in the page as `undefined`. |
| `storageSet(key, value)` | boolean | Stores a string. `false`, and the previous value stays, for an invalid key, a value over 2 MB or a full store (32 keys, 8 MB in total). |
| `storageRemove(key)` | boolean | Removes the value. `false` only for an invalid key. |
| `storageKeys()` | string | JSON array of the keys that have a value, sorted. |

Keys are 1 to 64 characters out of `A-Z a-z 0-9 . _ -` (the page uses `sol.save.v1`,
`sol.settings.v1`, `sol.stats.v1`). The app stores the values as they are; the page puts JSON
there, and the one value that is not JSON, `<removed>`, is how it marks a key it has removed
(see [Where the saved game lives](#where-the-saved-game-lives)). Such a key still counts as
having a value for `storageKeys()`.

App to page:

| Call | What it does |
| --- | --- |
| `SOL.App.setInsets({top, right, bottom, left})` | What the page has to keep clear, in CSS px: display cutouts always, system bars only while they are visible. Sent after every page load and whenever it changes. |
| `SOL.App.onBack()` | The back button or gesture. `true` means the page used it (it closed something). Otherwise a second press closes the app, if it comes within two seconds (3.5 seconds in full-screen mode, where every press first needs the swipe that shows the bars). |

All of them only act while the WebView shows the game's own page. The methods that touch the
window run on the UI thread; the storage methods answer on the WebView's bridge thread and never
wait for a disk write.

## Full screen and the Back gesture

The seven card columns reach both screen edges. With Android's gesture navigation a swipe that
starts at the left or right edge is "Back", so a card dragged from an outer column could leave
the game. Two things prevent that:

1. **Full screen** (the game's `fullscreen` setting, on by default). The status and navigation
   bars are hidden in the "swipe to show" mode: a swipe from the top or bottom edge shows them,
   translucent, over the game for a few seconds, and the system hides them again. While the
   navigation bar is hidden the system does not take an edge swipe as Back: Back needs the bars
   to be shown first. The page is not laid out again for those temporary bars: it is told about
   display cutouts always, and about bars only while they are really visible. The bars are
   hidden again when the window gets its focus back and, if a device shows them for real
   instead of temporarily, three seconds later. A window that shares the screen (split screen,
   freeform) is never full screen, because the system does not allow it there.

   With the setting off the app is edge to edge under visible, transparent bars, and the page
   keeps its controls clear of them.

2. **Gesture exclusion** (Android 10 and newer). The page reports two 40 px wide strips along
   the left and right edges of the card table (`platform.js`), and the app hands them to the
   system as areas where an edge swipe belongs to the game. That matters in both modes:

   - In full-screen mode with gesture navigation, stock Android also takes a swipe from a
     *side* edge as "show the bars", and while they are shown the next edge swipe is Back. A
     swipe that starts inside a strip does not show the bars, so dragging a card from an outer
     column stays a drag.
   - With the bars visible (the setting is off, split screen, a device that does not hide
     them), a swipe that starts inside a strip is not Back.

   Android takes at most 200dp of height per screen edge into account (stock Android keeps the
   bottom-most 200dp of a taller request), unless the navigation bar is hidden as in
   full-screen mode. So the strips cover the whole table in full-screen mode and its lowest
   200 px otherwise: the part long columns are dragged from. The 40 px match the widest Back
   zone of stock Android (its highest "back sensitivity" setting). While a dialog or the card
   inspector is open there are no strips, so that the bars and Back can be reached from
   anywhere along the edge when they are wanted.

## Where the saved game lives

The page saves the game after every move, and it does so twice:

- **`files/store/`** in the app's private data directory, one file per key (`sol.save.v1.val`,
  `sol.settings.v1.val`, `sol.stats.v1.val`), through `SolitaireNative.storageSet`
  (`KeyValueFileStore.kt`). This is the copy the page reads first. A value is available to
  `storageGet` the moment `storageSet` returns; one background thread writes it out at once to
  a temporary file, syncs it and renames it over the old file, so the file is always either the
  old value or the new one. A write that was cut off by the process dying is completed or
  discarded on the next start, and a file that fails its checksum counts as missing. Leaving
  the app (`onPause`, `onStop`) waits briefly for a write that is still under way.
- **The WebView's localStorage** (`app_webview/…/Local Storage`), as in a browser. WebView
  writes it to disk lazily, which is why it is not enough on its own: a move made just before
  the app was swiped away could be missing. The page falls back to it when the first copy has no
  value, and copies what it finds there into `files/store/`. That is also how a game saved by an
  app version without `files/store/` is picked up.

Removing a value (the page does that with the saved game when a new game starts) has to be as
durable as writing one. If the first copy simply lost the key, the page would fall back to the
second, and that one may still hold the old game because WebView had not written the removal
out yet. So the page stores the marker `<removed>` in `files/store/` instead, and a key marked
that way is never looked up in localStorage.

Both are included in Android's backup and device-to-device transfer (`res/xml/backup_rules.xml`,
`res/xml/data_extraction_rules.xml`), nothing else is. *Clear storage* in the system settings
deletes both; *Clear cache* deletes neither.

If the device cannot write (storage full), the value stays in memory and the write is tried
again with every later change and whenever the app is left. Until one succeeds, the file keeps
the last value that did reach it, and that is what the next start reads.

## Build a debug APK

You need JDK 17 or 21 and the Android SDK (`ANDROID_HOME` set, or `sdk.dir=...` in
`android/local.properties`). The Gradle wrapper downloads Gradle 8.14.3 itself; the Android
Gradle plugin installs SDK platform 36 and build-tools 36.0.0 if they are missing and the SDK
licences are accepted.

```sh
cd android
./gradlew assembleDebug        # Windows: gradlew.bat assembleDebug
```

The APK lands in `app/build/outputs/apk/debug/app-debug.apk`.

Install it on a phone with USB debugging enabled (or on a running emulator):

```sh
./gradlew installDebug
# or
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

`./gradlew lint` runs Android lint (report: `app/build/reports/lint-results-debug.html`).
`./gradlew testDebugUnitTest` runs the unit tests of the app's own logic (`app/src/test`: the
key/value store and the gesture exclusion rectangles; plain JUnit on the JVM, no device needed;
report: `app/build/reports/tests/testDebugUnitTest/index.html`). The page's side of the contract
is tested with the web game: `node --test "solitaire/tests/*.test.js"` in the repository root.
Debug builds allow inspecting the page from desktop Chrome at `chrome://inspect`.

### Android Studio

Open the `android` directory (not the repository root) in Android Studio, wait for the Gradle
sync, pick a device and press **Run**. *Build > Build App Bundle(s) / APK(s) > Build APK(s)*
produces the same `app-debug.apk` as above.

## Get the APK from GitHub Actions

Every pull request and every push to `main` runs the **Android** workflow
(`.github/workflows/android.yml`): web game unit tests, Android lint, the app's unit tests, debug
build. It can also be started by hand from the *Actions* tab (*Run workflow*).

Open the run, scroll to **Artifacts** and download `solitaire-debug-apk`; the zip contains
`app-debug.apk`. With the GitHub CLI:

```sh
gh run download --name solitaire-debug-apk
```

Copy the APK to the phone and open it (Android asks once to allow installing from that source).

Debug APKs are signed with a debug key that differs between machines. Android refuses to install
an APK over one signed with another key, so switching between a CI build and a local build means
uninstalling first, which deletes the saved game.

## Make a signed release build

The release build is shrunk and optimised by R8. No signing configuration or keystore is checked
in, so the build output is unsigned and has to be signed before it can be installed.

1. Create a keystore once and keep it (and its passwords) out of the repository. `*.jks`,
   `*.keystore` and `keystore.properties` are git-ignored. Every later update must be signed with
   the same key.

   ```sh
   keytool -genkeypair -v -keystore ~/solitaire-release.jks -alias solitaire \
       -keyalg RSA -keysize 4096 -validity 10000
   ```

2. Build and sign:

   ```sh
   cd android
   ./gradlew assembleRelease
   # -> app/build/outputs/apk/release/app-release-unsigned.apk (already zip-aligned)

   BUILD_TOOLS="$ANDROID_HOME/build-tools/36.0.0"
   "$BUILD_TOOLS/apksigner" sign --ks ~/solitaire-release.jks --ks-key-alias solitaire \
       --out solitaire-3d-1.0.0.apk app/build/outputs/apk/release/app-release-unsigned.apk
   "$BUILD_TOOLS/apksigner" verify --print-certs solitaire-3d-1.0.0.apk
   ```

   `solitaire-3d-1.0.0.apk` is the installable release (`*.apk` and `*.idsig` are git-ignored
   here, so it cannot be committed by accident).

In Android Studio the same is *Build > Generate Signed App Bundle or APK > APK*, variant
`release`.

Before publishing an update, raise `versionCode` (and `versionName`) in `app/build.gradle.kts`.

## Versions

Pinned in `gradle/libs.versions.toml` and `gradle/wrapper/gradle-wrapper.properties`:
Gradle 8.14.3, Android Gradle plugin 8.13.2, Kotlin 2.3.21, androidx.activity 1.13.0,
androidx.core 1.18.0, androidx.webkit 1.18.0, and JUnit 4.13.2 for the unit tests. Moving to
Android Gradle plugin 9 means moving the wrapper to Gradle 9 as well; androidx.core 1.19 and newer
need that step and `compileSdk` 37.
