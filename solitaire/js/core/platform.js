/*
 * Platform glue: SOL.Platform (what are we running on), SOL.Haptics (touch feedback) and
 * SOL.App (the contract with the Android shell: back button and screen insets).
 *
 * The game is a plain web page. On Android it runs inside a WebView hosted by the app in
 * /android, which injects a JavaScript interface named `SolitaireNative`:
 *
 *   SolitaireNative.haptic(kind)        kind: 'tick' | 'tap' | 'thud' | 'success' | 'error' | 'heavy' | 'win'
 *   SolitaireNative.keepScreenOn(bool)  optional
 *   SolitaireNative.exit()              optional: leave the app
 *
 * and calls back into the page:
 *
 *   SOL.App.onBack() -> boolean         Android back button. true = the page handled it (closed
 *                                       something); false = nothing to close, the shell may exit.
 *   SOL.App.setInsets({ top, right, bottom, left })   system bar / cutout insets in CSS px
 *
 * Everything degrades to a no-op in a normal browser.
 *
 * API
 *   SOL.Platform.isNativeApp   true inside the Android shell
 *   SOL.Platform.isAndroid     Android (app or browser)
 *   SOL.Platform.isTouch       primary input is touch (coarse pointer)
 *   SOL.Platform.canHover      a hover-capable fine pointer exists
 *
 *   SOL.Haptics.play(kind)     fire-and-forget; honours the 'haptics' setting; rate limited
 *   SOL.Haptics.supported      boolean
 *
 *   SOL.App.addBackHandler(fn) -> remove()   LIFO stack. fn() returning false declines (the next
 *                                            handler is tried); any other result means "handled".
 *                                            Overlays register on open and remove on close.
 *   SOL.App.onBack() -> boolean
 *   SOL.App.setInsets(insets)
 *   SOL.App.keepScreenOn(bool)
 */
(function (root) {
  'use strict';

  const SOL = (root.SOL = root.SOL || {});
  const nav = root.navigator || {};

  function bridge() {
    const b = root.SolitaireNative;
    return b && typeof b === 'object' ? b : null;
  }

  function media(query) {
    try {
      return !!(root.matchMedia && root.matchMedia(query).matches);
    } catch (err) {
      return false;
    }
  }

  // ---------------------------------------------------------------- Platform
  const Platform = {
    get isNativeApp() {
      return bridge() !== null;
    },
    isAndroid: /Android/i.test(nav.userAgent || ''),
    get isTouch() {
      return media('(pointer: coarse)') || (nav.maxTouchPoints || 0) > 0;
    },
    get canHover() {
      return media('(hover: hover) and (pointer: fine)');
    },
  };

  // ---------------------------------------------------------------- Haptics
  /** navigator.vibrate patterns (ms) used when the native bridge is absent. */
  const PATTERNS = {
    tick: 6,
    tap: 10,
    thud: 16,
    success: [10, 36, 16],
    error: [18, 44, 18],
    heavy: 30,
    win: [26, 60, 26, 60, 48],
  };
  const MIN_GAP_MS = 35; // a 28-card deal must not turn into one long buzz
  let lastHapticAt = 0;

  function now() {
    return root.performance && root.performance.now ? root.performance.now() : Date.now();
  }

  const Haptics = {
    get supported() {
      const b = bridge();
      return !!(b && typeof b.haptic === 'function') || typeof nav.vibrate === 'function';
    },

    play(kind) {
      if (!Object.prototype.hasOwnProperty.call(PATTERNS, kind)) return false;
      try {
        if (SOL.Settings && SOL.Settings.get('haptics') === false) return false;
      } catch (err) {
        /* settings unavailable: default to on */
      }
      const t = now();
      // Accents always get through; the small ticks are rate limited.
      const light = kind === 'tick' || kind === 'tap' || kind === 'thud';
      if (light && t - lastHapticAt < MIN_GAP_MS) return false;
      lastHapticAt = t;
      try {
        const b = bridge();
        if (b && typeof b.haptic === 'function') {
          b.haptic(kind);
          return true;
        }
        if (typeof nav.vibrate === 'function') return !!nav.vibrate(PATTERNS[kind]);
      } catch (err) {
        /* vibration blocked (no user activation yet, permissions policy): ignore */
      }
      return false;
    },
  };

  // ---------------------------------------------------------------- App (shell contract)
  const backHandlers = [];

  const App = {
    addBackHandler(fn) {
      if (typeof fn !== 'function') throw new TypeError('SOL.App.addBackHandler: handler must be a function');
      backHandlers.push(fn);
      let removed = false;
      return function remove() {
        if (removed) return;
        removed = true;
        const i = backHandlers.lastIndexOf(fn);
        if (i !== -1) backHandlers.splice(i, 1);
      };
    },

    /** Android back button. Returns true when something consumed it. */
    onBack() {
      for (let i = backHandlers.length - 1; i >= 0; i--) {
        const fn = backHandlers[i];
        let result;
        try {
          result = fn();
        } catch (err) {
          if (root.console) root.console.error('[SOL.App] back handler threw', err);
          result = false;
        }
        if (result !== false) return true;
      }
      return false;
    },

    /** Insets in CSS px from the native shell; overrides the env(safe-area-inset-*) defaults. */
    setInsets(insets) {
      const doc = root.document;
      if (!doc || !doc.documentElement || !insets) return;
      const style = doc.documentElement.style;
      const sides = { top: '--safe-t', right: '--safe-r', bottom: '--safe-b', left: '--safe-l' };
      for (const side of Object.keys(sides)) {
        const v = Number(insets[side]);
        if (isFinite(v) && v >= 0) style.setProperty(sides[side], v + 'px');
      }
      if (SOL.Bus) SOL.Bus.emit('app:insets', insets);
    },

    keepScreenOn(on) {
      try {
        const b = bridge();
        if (b && typeof b.keepScreenOn === 'function') b.keepScreenOn(!!on);
      } catch (err) {
        /* ignore */
      }
    },
  };

  SOL.Platform = Platform;
  SOL.Haptics = Haptics;
  SOL.App = App;

  if (root.document && root.document.documentElement) {
    const el = root.document.documentElement;
    el.setAttribute('data-platform', bridge() ? 'android-app' : Platform.isAndroid ? 'android-web' : 'web');
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { Platform: Platform, Haptics: Haptics, App: App };
  }
})(typeof window !== 'undefined' ? window : globalThis);
