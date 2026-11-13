# Solitaire 3D

Klondike solitaire with animated 3D cards and a 3D card preview, built for Android phones.
The game is a plain web page; the Android app wraps that page in a full-screen `WebView` and
ships it as an APK.

## What is in the repository

| Path | What it is |
| --- | --- |
| `solitaire/` | The game: static HTML, CSS and JavaScript. No build step, no dependencies, no network requests. |
| `solitaire/tests/` | Unit tests for the game (Node's built-in test runner). |
| `android/` | The Android app (Kotlin, Gradle). It bundles `solitaire/` into the APK at build time. See [`android/README.md`](android/README.md). |
| `.github/workflows/android.yml` | CI: runs the tests, lints the app and builds a debug APK for every pull request. |
| `index.html`, `script.js`, `style.css` | An older, unrelated game. Not part of Solitaire 3D. |

## Setting up on another machine

1. **Get the code.** Clone the repository and check out the development branch, or unpack a
   source zip. Keep `solitaire/` and `android/` side by side: the Android build reads the game
   from `../solitaire`.
2. **Run the game.** Open `solitaire/index.html` in a browser; it works straight from the file
   system. To serve it instead (needed for the installable web version, which uses a service
   worker):

   ```sh
   python3 -m http.server --directory solitaire 8080
   # then open http://localhost:8080/
   ```

   The game is designed for phones first. In a desktop browser, use the developer tools' device
   toolbar to get a phone-sized screen with touch input.
3. **Run the tests.** Needs Node.js 22 or newer, nothing to install:

   ```sh
   node --test "solitaire/tests/*.test.js"
   ```

4. **Build the APK.** Needs JDK 17 or 21 and the Android SDK, or Android Studio (open the
   `android` directory, not the repository root):

   ```sh
   cd android
   ./gradlew assembleDebug        # Windows: gradlew.bat assembleDebug
   # result: app/build/outputs/apk/debug/app-debug.apk
   ```

   [`android/README.md`](android/README.md) covers the rest: installing on a phone, lint and
   unit tests, the APK that CI builds, signing a release, and how the app and the page talk.

## How the game code is organised

All scripts are classic `<script>` files (no modules, no bundler) that add to one global
namespace, `SOL`. `solitaire/index.html` lists them in load order. Every file starts with a
header comment that documents its public API; read that before reading the file.

| File | Namespace | Role |
| --- | --- | --- |
| `js/core/bus.js` | `SOL.Bus` | Event bus that connects the modules. |
| `js/core/store.js` | `SOL.Store`, `SOL.Settings`, `SOL.Stats`, `SOL.Save` | Persistence, settings, statistics and the saved game. |
| `js/core/platform.js` | `SOL.Platform`, `SOL.Haptics`, `SOL.App` | Device detection, haptics and the bridge to the Android app. |
| `js/core/rng.js`, `js/core/engine.js` | `SOL.RNG`, `SOL.Engine` | Seeded shuffling and the Klondike rules: moves, scoring, undo, hints. |
| `js/core/solver.js` | `SOL.Solver` | Finds deals that can be won. |
| `js/view/anim.js`, `js/view/fx.js` | `SOL.Anim`, `SOL.FX` | Animation clock (tweens, springs) and canvas particle effects. |
| `js/view/audio.js` | `SOL.Audio` | Synthesised sound effects. |
| `js/view/cards.js` | `SOL.Cards` | Builds the 3D card elements and their artwork. |
| `js/view/board.js`, `js/view/input.js`, `js/view/celebrate.js` | `SOL.Board`, `SOL.Input`, `SOL.Celebrate` | The table: layout, card motion, touch input and the win celebration. |
| `js/view/inspector.js` | `SOL.Inspector` | The 3D card preview and the deck gallery. |
| `js/view/ui.js` | `SOL.UI` | HUD, toolbar, menus, settings, statistics and dialogs. |
| `js/main.js` | `SOL.Game` | The controller: owns the game state and ties rules, table and UI together. |
| `js/pwa.js`, `sw.js`, `manifest.webmanifest` | `SOL.PWA` | The installable web version. Not used inside the Android app. |

Things to know before changing code:

- **Cards and piles.** A card is an id from 0 to 51: `suit = floor(id / 13)` (0 spades, 1 hearts,
  2 clubs, 3 diamonds) and `rank = id % 13 + 1`. Piles are `stock`, `waste`, `f0`..`f3`
  (foundations, one per suit) and `t0`..`t6` (tableau columns).
- **`js/core/` is pure logic.** Those files also load in Node with `require`, which is how the
  tests use them. Keep DOM access out of them.
- **Styles.** `css/base.css` holds the design tokens, the four table themes and the page shell;
  the other stylesheets build on it.
- **Adding a file the game loads.** Add it to `index.html` and to the `PRECACHE` list in
  `sw.js`, and raise `VERSION` there; `tests/pwa.test.js` checks the list.
- **No network.** The game makes no requests and uses system fonts only. The Android app has no
  internet permission, so anything fetched at runtime would fail there.
