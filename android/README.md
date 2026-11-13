# Solitaire 3D for Android

The Android app for the Klondike solitaire in [`../solitaire`](../solitaire). The game itself is
the web page; this project wraps it in a single full-screen `WebView` and ships it as an APK
(`io.github.xcarboney.solitaire`, Android 7.0 / API 24 and newer).

The app asks for **no permissions**, not even internet access: the game is inside the APK and
the saved game, statistics and settings stay on the device (they are included in Android's
backup and device-to-device transfer).

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
`app/src/main/kotlin/.../MainActivity.kt` documents the contract with the page (system bar
insets, back button, haptics); the page's side of it is `../solitaire/js/core/platform.js`.

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
Debug builds allow inspecting the page from desktop Chrome at `chrome://inspect`.

### Android Studio

Open the `android` directory (not the repository root) in Android Studio, wait for the Gradle
sync, pick a device and press **Run**. *Build > Build App Bundle(s) / APK(s) > Build APK(s)*
produces the same `app-debug.apk` as above.

## Get the APK from GitHub Actions

Every pull request and every push to `main` runs the **Android** workflow
(`.github/workflows/android.yml`): web game unit tests, Android lint, debug build. It can also be
started by hand from the *Actions* tab (*Run workflow*).

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

   `solitaire-3d-1.0.0.apk` is the installable release.

In Android Studio the same is *Build > Generate Signed App Bundle or APK > APK*, variant
`release`.

Before publishing an update, raise `versionCode` (and `versionName`) in `app/build.gradle.kts`.

## Versions

Pinned in `gradle/libs.versions.toml` and `gradle/wrapper/gradle-wrapper.properties`:
Gradle 8.14.3, Android Gradle plugin 8.13.2, Kotlin 2.3.21, androidx.activity 1.13.0,
androidx.core 1.18.0, androidx.webkit 1.18.0. Moving to Android Gradle plugin 9 means moving the
wrapper to Gradle 9 as well; androidx.core 1.19 and newer need that step and `compileSdk` 37.
