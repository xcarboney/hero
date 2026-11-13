/*
 * Platform glue: SOL.Platform (what are we running on), SOL.Haptics (touch feedback) and
 * SOL.App (the contract with the Android shell: back button, screen insets, full screen and
 * the edge areas that must not trigger the system's Back gesture).
 *
 * The game is a plain web page. On Android it runs inside a WebView hosted by the app in
 * /android, which injects a JavaScript interface named `SolitaireNative`. Every method is
 * optional from the page's point of view: it is looked up before each call, so an older shell
 * that lacks one simply does not get that feature.
 *
 *   SolitaireNative.haptic(kind)         kind: 'tick' | 'tap' | 'thud' | 'success' | 'error' | 'heavy' | 'win'
 *   SolitaireNative.keepScreenOn(bool)   keep the display awake while true
 *   SolitaireNative.setFullscreen(bool)  true: hide the status and navigation bars (a swipe from
 *                                        the edge shows them for a moment); false: show them.
 *                                        Idempotent. The shell remembers the last value for its
 *                                        next start.
 *   SolitaireNative.setGestureExclusion(json)
 *                                        json: '[{"x":0,"y":120,"w":40,"h":500}, ...]', at most
 *                                        8 rectangles in CSS px relative to the viewport, where
 *                                        a swipe from the screen edge belongs to the game and
 *                                        not to the system's Back gesture. '[]' clears them.
 *   SolitaireNative.exit()               leave the app
 *   SolitaireNative.safeAreaInsets()     -> '{"top":24,"right":0,"bottom":16,"left":0}' (CSS px)
 *                                        or '' while unknown. Used by the shell's own script
 *                                        that seeds --safe-* before the first layout; the page
 *                                        gets the same values through SOL.App.setInsets.
 *   SolitaireNative.storageGet(key)      -> string, or no string at all when there is no value
 *                                        (a WebView hands a Java null over as undefined)
 *   SolitaireNative.storageSet(key, v)   -> boolean: false when the value was not accepted
 *   SolitaireNative.storageRemove(key)   -> boolean
 *   SolitaireNative.storageKeys()        -> string: JSON array of the keys that have a value
 *                                        The shell's durable key/value store, used by store.js
 *                                        (SOL.Store) next to localStorage. Keys: [A-Za-z0-9._-],
 *                                        1-64 chars; values: strings up to 2 MB. A value can be
 *                                        read back the moment storageSet returns and is written
 *                                        to disk in the background. store.js stores JSON, and
 *                                        '<removed>' for a key it has removed.
 *
 * and calls back into the page:
 *
 *   SOL.App.onBack() -> boolean         Android back button. true = the page handled it (closed
 *                                       something); false = nothing to close, the shell may exit.
 *   SOL.App.setInsets({ top, right, bottom, left })   what the page must keep clear, in CSS px:
 *                                       display cutouts always, system bars while they are
 *                                       visible (so not in full-screen mode).
 *
 * Everything degrades to a no-op in a normal browser.
 *
 * Done here without any help from the other modules, and only inside the Android app:
 *   - the 'fullscreen' setting is sent to the shell when this file loads (after store.js) and
 *     again whenever it changes ('settings:change');
 *   - the gesture exclusion: two strips along the left and right edges of #table, where cards
 *     are dragged from. They are measured again (debounced) on resize, orientation change,
 *     'app:insets', when #table changes size, when the 'fullscreen' setting changes and when a
 *     back handler is added or removed. While any back handler is registered (an overlay is
 *     open) there are no strips: nothing is being dragged, and Back must be easy to reach.
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
 *   SOL.App.setFullscreen(bool) -> boolean   true when the shell was told. Normally not needed:
 *                                            change the 'fullscreen' setting instead.
 *   SOL.App.setGestureExclusion(rects) -> boolean   rects: [{ x, y, w, h }] in CSS px (see
 *                                            above); true when the shell was told. Normally not
 *                                            needed: the strips along #table are kept up to
 *                                            date here, and their next update replaces these.
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

  /*
   * Gesture exclusion. With Android's gesture navigation a swipe that starts at the left or
   * right screen edge is "Back", and the outer tableau columns sit right there. The shell can
   * exempt rectangles from that (View.setSystemGestureExclusionRects, Android 10+), with one
   * limit set by the system: at most 200dp of height per edge is taken into account (stock
   * Android keeps the bottom-most 200dp of a taller request). The limit does not apply while
   * the navigation bar is hidden in the shell's full-screen mode. In the shell's WebView 1 CSS
   * px is 1dp. So:
   *   - full screen on:  the strips run the whole height of #table;
   *   - full screen off: they cover the lowest 200 CSS px of #table, the part where the long
   *     tableau columns are picked up and dragged from.
   * The strips are as wide as the widest back-gesture zone of stock Android (about 24dp by
   * default, about 40dp at the highest "back sensitivity" setting); the system does not limit
   * the width.
   */
  const EDGE_STRIP_PX = 40;
  const EDGE_LIMIT_PX = 200;
  const MAX_EXCLUSION_RECTS = 8; // the shell accepts no more
  const EXCLUSION_DEBOUNCE_MS = 80; // resize events come in bursts while the device rotates

  let exclusionWatched = false; // true inside the app once the listeners are installed
  let exclusionTimer = null;
  let lastExclusion = null; // the JSON last handed to the shell

  function fullscreenWanted() {
    try {
      return !!(SOL.Settings && SOL.Settings.get('fullscreen') === true);
    } catch (err) {
      return false;
    }
  }

  /** The strips for the current layout; [] while an overlay is open; null when there is no #table. */
  function tableStrips() {
    const doc = root.document;
    const table = doc && typeof doc.getElementById === 'function' ? doc.getElementById('table') : null;
    if (!table || typeof table.getBoundingClientRect !== 'function') return null;
    if (backHandlers.length > 0) return [];
    const r = table.getBoundingClientRect();
    const width = r.right - r.left;
    let top = r.top;
    if (!fullscreenWanted() && r.bottom - top > EDGE_LIMIT_PX) top = r.bottom - EDGE_LIMIT_PX;
    const height = r.bottom - top;
    if (!(width > 0) || !(height > 0)) return [];
    const w = Math.min(EDGE_STRIP_PX, width / 2);
    return [
      { x: r.left, y: top, w: w, h: height },
      { x: r.right - w, y: top, w: w, h: height },
    ];
  }

  function updateExclusion() {
    exclusionTimer = null;
    try {
      const rects = tableStrips();
      if (rects !== null) App.setGestureExclusion(rects);
    } catch (err) {
      /* a timer callback: nothing to report to, and the next layout change measures again */
    }
  }

  /** Debounced: measures after the layout has settled and sends only what changed. */
  function scheduleExclusion() {
    if (!exclusionWatched || typeof root.setTimeout !== 'function') return;
    if (exclusionTimer !== null && typeof root.clearTimeout === 'function') root.clearTimeout(exclusionTimer);
    exclusionTimer = root.setTimeout(updateExclusion, EXCLUSION_DEBOUNCE_MS);
  }

  const App = {
    addBackHandler(fn) {
      if (typeof fn !== 'function') throw new TypeError('SOL.App.addBackHandler: handler must be a function');
      backHandlers.push(fn);
      scheduleExclusion();
      let removed = false;
      return function remove() {
        if (removed) return;
        removed = true;
        const i = backHandlers.lastIndexOf(fn);
        if (i !== -1) backHandlers.splice(i, 1);
        scheduleExclusion();
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

    /** Hide (true) or show (false) the system bars. Returns true when the shell was told. */
    setFullscreen(on) {
      try {
        const b = bridge();
        if (b && typeof b.setFullscreen === 'function') {
          b.setFullscreen(!!on);
          return true;
        }
      } catch (err) {
        /* ignore */
      }
      return false;
    },

    /**
     * Tell the shell where an edge swipe belongs to the game. `rects` is an array of
     * { x, y, w, h } in CSS px relative to the viewport; entries that are not four finite
     * numbers with a size above zero are dropped, as is everything after the eighth. The shell
     * clips them to the screen. An empty array clears the exclusion.
     * Returns true when the shell was told (also when it already had exactly these).
     */
    setGestureExclusion(rects) {
      try {
        const b = bridge();
        if (!b || typeof b.setGestureExclusion !== 'function') return false;
        const clean = [];
        const list = Array.isArray(rects) ? rects : [];
        for (let i = 0; i < list.length && clean.length < MAX_EXCLUSION_RECTS; i++) {
          const r = list[i] || {};
          const x = Number(r.x);
          const y = Number(r.y);
          const w = Number(r.w);
          const h = Number(r.h);
          if (!(isFinite(x) && isFinite(y) && isFinite(w) && isFinite(h) && w > 0 && h > 0)) continue;
          // Whole CSS px, rounded outwards: a strip must not stop a fraction short of the edge.
          const left = Math.floor(x);
          const top = Math.floor(y);
          clean.push({ x: left, y: top, w: Math.ceil(x + w) - left, h: Math.ceil(y + h) - top });
        }
        const json = JSON.stringify(clean);
        if (json !== lastExclusion) {
          b.setGestureExclusion(json);
          lastExclusion = json;
        }
        return true;
      } catch (err) {
        return false;
      }
    },
  };

  SOL.Platform = Platform;
  SOL.Haptics = Haptics;
  SOL.App = App;

  // ---------------------------------------------------------------- shell sync (Android app only)
  /** Sends the 'fullscreen' setting to the shell now and on every change. */
  function syncFullscreen() {
    if (SOL.Settings) App.setFullscreen(fullscreenWanted());
    if (!SOL.Bus) return;
    SOL.Bus.on('settings:change', function (change) {
      if (!change || change.key !== 'fullscreen') return;
      App.setFullscreen(change.value === true);
      scheduleExclusion(); // the 200dp limit applies in one mode and not in the other
    });
  }

  /** Keeps the strips along #table up to date. Needs a document; does nothing without #table. */
  function watchExclusion() {
    const doc = root.document;
    if (!doc || typeof doc.getElementById !== 'function') return;
    exclusionWatched = true;

    if (typeof root.addEventListener === 'function') {
      root.addEventListener('resize', scheduleExclusion);
      root.addEventListener('orientationchange', scheduleExclusion);
      root.addEventListener('load', scheduleExclusion); // stylesheets applied: final geometry
    }
    if (SOL.Bus) SOL.Bus.on('app:insets', scheduleExclusion);

    // #table also moves without a window resize: the HUD above and the toolbar below it are
    // built after this file runs and take their height out of it.
    let observed = false;
    const observeTable = function () {
      scheduleExclusion();
      if (observed || typeof root.ResizeObserver !== 'function') return;
      const table = doc.getElementById('table');
      if (!table) return;
      try {
        new root.ResizeObserver(scheduleExclusion).observe(table);
        observed = true;
      } catch (err) {
        /* no observer: the window events above still apply */
      }
    };
    observeTable();
    if (doc.readyState === 'loading' && typeof doc.addEventListener === 'function') {
      doc.addEventListener('DOMContentLoaded', observeTable);
    }
  }

  (function startShellSync() {
    const b = bridge();
    if (!b) return; // a normal browser: nothing to sync, no listeners, no timers
    try {
      if (typeof b.setFullscreen === 'function') syncFullscreen();
      if (typeof b.setGestureExclusion === 'function') watchExclusion();
    } catch (err) {
      /* the game must load even if the shell misbehaves */
    }
  })();

  if (root.document && root.document.documentElement) {
    const el = root.document.documentElement;
    el.setAttribute('data-platform', bridge() ? 'android-app' : Platform.isAndroid ? 'android-web' : 'web');
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { Platform: Platform, Haptics: Haptics, App: App };
  }
})(typeof window !== 'undefined' ? window : globalThis);
