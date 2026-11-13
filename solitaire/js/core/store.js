/*
 * Persistence: SOL.Store (raw key/value), SOL.Settings, SOL.Stats, SOL.Save.
 *
 * Everything lives in localStorage under the "sol." prefix. Storage can be missing or throw
 * (private mode, file:// in some browsers, quota), so every access is guarded and falls back to
 * an in-memory map: the game always works, it just may not remember things across reloads.
 *
 * Inside the Android app (/android) there is a second, more durable place: the shell's own
 * key/value files, reached through the bridge methods SolitaireNative.storageGet / storageSet /
 * storageRemove (contract: the header of platform.js). A WebView writes localStorage to disk
 * lazily, so a move made just before the app is swiped away could be lost; the shell's store
 * has the value the moment storageSet returns. When that bridge exists:
 *   - get reads the native value first and falls back to localStorage. A value found only in
 *     localStorage (saved by an app version without the native store, or after the native copy
 *     was lost) is copied into the native store on that read;
 *   - set writes the native store AND localStorage;
 *   - remove removes from localStorage and leaves a marker in the native store (the value
 *     '<removed>', which no stored JSON can be). Without the marker a removal would be the one
 *     thing that is not durable: the lazily written localStorage could still hold the old value
 *     after the app was swiped away, and the next start would read it back and migrate it as if
 *     it were new.
 * Outside the app nothing changes: localStorage, then memory. The API is the same everywhere.
 *
 * SOL.Settings also applies the settings that CSS and the browser need to the document, when this
 * file loads and after every change (Settings.applyToDocument): data-theme, data-reduced-motion,
 * data-left-handed and data-effects on <html>, and the table theme's dark tone in the page's
 * <meta name="theme-color">, so a browser's own bars follow the theme.
 *
 * Events (SOL.Bus):
 *   'settings:change'  { key, value, previous, all }
 *   'stats:change'     { stats }
 */
(function (root) {
  'use strict';

  const SOL = (root.SOL = root.SOL || {});
  const PREFIX = 'sol.';
  const memory = new Map();

  function storage() {
    try {
      return root.localStorage || null;
    } catch (err) {
      return null;
    }
  }

  /**
   * The Android shell's key/value store, or null: outside the app, and in an app version whose
   * shell does not have it yet. Looked up on every call (it is three property reads), so nothing
   * depends on when the bridge appears.
   */
  function nativeStore() {
    try {
      const b = root.SolitaireNative;
      if (!b || typeof b !== 'object') return null;
      const ok =
        typeof b.storageGet === 'function' &&
        typeof b.storageSet === 'function' &&
        typeof b.storageRemove === 'function';
      return ok ? b : null;
    } catch (err) {
      return null;
    }
  }

  function nativeGet(nat, k) {
    try {
      const raw = nat.storageGet(k);
      // "No value" is a Java null, which a WebView hands over as undefined (not null).
      return typeof raw === 'string' ? raw : null;
    } catch (err) {
      return null;
    }
  }

  /**
   * True when the shell accepted the value. When it did not (over its size limit, bridge error)
   * the key is removed there: get prefers the native copy, so an older value left behind would
   * come back as if it were the latest. Without one, get falls through to localStorage.
   */
  function nativeSet(nat, k, raw) {
    let ok = false;
    try {
      ok = typeof raw === 'string' && nat.storageSet(k, raw) !== false;
    } catch (err) {
      ok = false;
    }
    if (!ok) nativeRemove(nat, k);
    return ok;
  }

  function nativeRemove(nat, k) {
    try {
      nat.storageRemove(k);
    } catch (err) {
      /* ignore */
    }
  }

  /**
   * What the native store holds for a key the page removed. Every stored value is the output of
   * JSON.stringify, which never starts with '<', so the marker cannot be mistaken for a value.
   */
  const REMOVED = '<removed>';

  /**
   * Store.remove inside the app: "this key was removed" has to outlive the process just like a
   * value does, so it is written as a value. If the shell does not take the marker, the key is
   * at least removed there (which is all a removal was before the marker existed).
   */
  function nativeMarkRemoved(nat, k) {
    let marked = false;
    try {
      marked = nat.storageSet(k, REMOVED) !== false;
    } catch (err) {
      marked = false;
    }
    if (!marked) nativeRemove(nat, k);
  }

  function emit(event, payload) {
    if (SOL.Bus) SOL.Bus.emit(event, payload);
  }

  // ---------------------------------------------------------------- Store
  const Store = {
    /** Read a JSON value; returns `fallback` when missing or unreadable. */
    get(key, fallback) {
      const k = PREFIX + key;
      const nat = nativeStore();
      if (nat) {
        const nativeRaw = nativeGet(nat, k);
        // Removed, and nothing was written since (a write also lands in `memory`): whatever
        // localStorage still holds for the key is the stale copy the marker is there to stop.
        if (nativeRaw === REMOVED && !memory.has(k)) return fallback;
        if (nativeRaw !== null && nativeRaw !== REMOVED) {
          try {
            return JSON.parse(nativeRaw);
          } catch (err) {
            /* unreadable native copy: fall back to localStorage, which then replaces it */
          }
        }
      }
      let raw = null;
      const ls = storage();
      try {
        raw = ls ? ls.getItem(k) : null;
      } catch (err) {
        raw = null;
      }
      const fromLocalStorage = raw !== null && raw !== undefined;
      if (raw === null && memory.has(k)) raw = memory.get(k);
      if (raw === null || raw === undefined) return fallback;
      let value;
      try {
        value = JSON.parse(raw);
      } catch (err) {
        return fallback;
      }
      // Reached only when the native store had no usable value: bring it up to date.
      if (nat && fromLocalStorage) nativeSet(nat, k, raw);
      return value;
    },

    /** Write a JSON value. Returns true when it reached persistent storage. */
    set(key, value) {
      const k = PREFIX + key;
      const raw = JSON.stringify(value);
      memory.set(k, raw);
      const nat = nativeStore();
      const savedNatively = nat ? nativeSet(nat, k, raw) : false;
      const ls = storage();
      try {
        if (ls) {
          ls.setItem(k, raw);
          return true;
        }
      } catch (err) {
        /* quota or disabled: the in-memory copy still serves this session */
      }
      return savedNatively;
    },

    remove(key) {
      const k = PREFIX + key;
      memory.delete(k);
      const nat = nativeStore();
      if (nat) nativeMarkRemoved(nat, k);
      const ls = storage();
      try {
        if (ls) ls.removeItem(k);
      } catch (err) {
        /* ignore */
      }
    },
  };

  // ---------------------------------------------------------------- Settings
  const SETTINGS_KEY = 'settings.v1';

  /** key -> { def: default value, ok: validator } */
  const SCHEMA = {
    drawCount: { def: 1, ok: (v) => v === 1 || v === 3 },
    theme: { def: 'emerald', ok: (v) => ['emerald', 'midnight', 'crimson', 'slate'].indexOf(v) !== -1 },
    cardBack: { def: 'royal', ok: (v) => typeof v === 'string' && v.length > 0 && v.length < 40 },
    sound: { def: true, ok: (v) => typeof v === 'boolean' },
    volume: { def: 0.6, ok: (v) => typeof v === 'number' && v >= 0 && v <= 1 },
    animSpeed: { def: 'normal', ok: (v) => ['slow', 'normal', 'fast'].indexOf(v) !== -1 },
    reducedMotion: { def: 'auto', ok: (v) => ['auto', 'on', 'off'].indexOf(v) !== -1 },
    tapToMove: { def: true, ok: (v) => typeof v === 'boolean' },
    winnableOnly: { def: false, ok: (v) => typeof v === 'boolean' },
    leftHanded: { def: false, ok: (v) => typeof v === 'boolean' },
    showTimer: { def: true, ok: (v) => typeof v === 'boolean' },
    effects: { def: 'high', ok: (v) => v === 'high' || v === 'low' },
    haptics: { def: true, ok: (v) => typeof v === 'boolean' },
    // Android app only: hide the status and navigation bars (applied by platform.js through
    // SolitaireNative.setFullscreen). It has no effect in a browser.
    fullscreen: { def: true, ok: (v) => typeof v === 'boolean' },
  };

  /** animSpeed -> multiplier handed to SOL.Anim.setSpeed (durations are divided by it). */
  const SPEEDS = { slow: 0.6, normal: 1, fast: 1.8 };

  /**
   * theme -> the colour a browser paints its own bars with around the page (its address bar, the
   * status bar of the installed web app), kept in the page's <meta name="theme-color">: a dark
   * tone of that table, halfway between --felt and --felt-lo of css/base.css. The Emerald one is
   * the value index.html and manifest.webmanifest start with. tests/store.test.js holds the four
   * against base.css. (The Android app has no such bar: it draws under transparent system bars.)
   */
  const THEME_COLORS = { emerald: '#0b3d2e', midnight: '#0e173c', crimson: '#400c18', slate: '#1c232c' };

  let settings = null;
  let motionQuery = null;

  function loadSettings() {
    const stored = Store.get(SETTINGS_KEY, {}) || {};
    const out = {};
    for (const key of Object.keys(SCHEMA)) {
      const spec = SCHEMA[key];
      out[key] = Object.prototype.hasOwnProperty.call(stored, key) && spec.ok(stored[key]) ? stored[key] : spec.def;
    }
    return out;
  }

  function ensureSettings() {
    if (!settings) settings = loadSettings();
    return settings;
  }

  function prefersReducedMotion() {
    try {
      if (!motionQuery && root.matchMedia) motionQuery = root.matchMedia('(prefers-reduced-motion: reduce)');
      return !!(motionQuery && motionQuery.matches);
    } catch (err) {
      return false;
    }
  }

  const Settings = {
    SPEEDS: SPEEDS,
    THEMES: ['emerald', 'midnight', 'crimson', 'slate'],

    defaults() {
      const out = {};
      for (const key of Object.keys(SCHEMA)) out[key] = SCHEMA[key].def;
      return out;
    },

    get(key) {
      if (!Object.prototype.hasOwnProperty.call(SCHEMA, key)) throw new Error('Unknown setting: ' + key);
      return ensureSettings()[key];
    },

    /** Returns true when the value was accepted (false for unknown keys / invalid values). */
    set(key, value) {
      const spec = SCHEMA[key];
      if (!spec || !spec.ok(value)) return false;
      const all = ensureSettings();
      const previous = all[key];
      if (previous === value) return true;
      all[key] = value;
      Store.set(SETTINGS_KEY, all);
      Settings.applyToDocument();
      emit('settings:change', { key: key, value: value, previous: previous, all: Settings.all() });
      return true;
    },

    all() {
      return Object.assign({}, ensureSettings());
    },

    reset() {
      const defaults = Settings.defaults();
      for (const key of Object.keys(defaults)) Settings.set(key, defaults[key]);
    },

    /** Effective reduced-motion flag: the explicit setting, or the OS preference when 'auto'. */
    reducedMotion() {
      const mode = Settings.get('reducedMotion');
      if (mode === 'on') return true;
      if (mode === 'off') return false;
      return prefersReducedMotion();
    },

    /** Multiplier for SOL.Anim.setSpeed. */
    speed() {
      return SPEEDS[Settings.get('animSpeed')] || 1;
    },

    /**
     * Mirrors theme / reduced motion / handedness / effects onto <html> so CSS can react, and the
     * theme's dark tone into the page's <meta name="theme-color"> (when the page has one) so the
     * browser's own bars match the table. Runs when this file loads and after every change.
     */
    applyToDocument() {
      const doc = root.document;
      if (!doc || !doc.documentElement) return;
      const el = doc.documentElement;
      const theme = Settings.get('theme');
      el.setAttribute('data-theme', theme);
      el.setAttribute('data-reduced-motion', Settings.reducedMotion() ? 'true' : 'false');
      el.setAttribute('data-left-handed', Settings.get('leftHanded') ? 'true' : 'false');
      el.setAttribute('data-effects', Settings.get('effects'));
      const color = THEME_COLORS[theme];
      const meta = typeof doc.querySelector === 'function' ? doc.querySelector('meta[name="theme-color"]') : null;
      if (meta && color && meta.getAttribute('content') !== color) meta.setAttribute('content', color);
    },
  };

  // ---------------------------------------------------------------- Stats
  const STATS_KEY = 'stats.v1';

  function emptyMode() {
    return {
      played: 0,
      won: 0,
      bestScore: 0,
      bestTimeMs: 0, // 0 = no win yet
      totalTimeMs: 0, // summed over won games
      totalMoves: 0, // summed over won games
      currentStreak: 0,
      bestStreak: 0,
    };
  }

  function modeKey(drawCount) {
    return drawCount === 3 ? 'd3' : 'd1';
  }

  function loadStats() {
    const stored = Store.get(STATS_KEY, null);
    const out = { d1: emptyMode(), d3: emptyMode(), open: null, lastWonId: null };
    if (stored && typeof stored === 'object') {
      for (const m of ['d1', 'd3']) {
        const src = stored[m];
        if (!src || typeof src !== 'object') continue;
        for (const key of Object.keys(out[m])) {
          const v = src[key];
          if (typeof v === 'number' && isFinite(v) && v >= 0) out[m][key] = v;
        }
      }
      if (stored.open && typeof stored.open.id === 'string') {
        out.open = { id: stored.open.id, mode: stored.open.mode === 'd3' ? 'd3' : 'd1' };
      }
      if (typeof stored.lastWonId === 'string') out.lastWonId = stored.lastWonId;
    }
    return out;
  }

  let stats = null;

  function ensureStats() {
    if (!stats) stats = loadStats();
    return stats;
  }

  function saveStats() {
    Store.set(STATS_KEY, stats);
    emit('stats:change', { stats: Stats.get() });
  }

  const Stats = {
    /** Deep copy: { d1: {...}, d3: {...} }. */
    get() {
      const s = ensureStats();
      return { d1: Object.assign({}, s.d1), d3: Object.assign({}, s.d3) };
    },

    /** Derived numbers for one draw mode (1 or 3). */
    summary(drawCount) {
      const m = ensureStats()[modeKey(drawCount)];
      return Object.assign({}, m, {
        winRate: m.played > 0 ? m.won / m.played : 0,
        avgTimeMs: m.won > 0 ? m.totalTimeMs / m.won : 0,
        avgMoves: m.won > 0 ? m.totalMoves / m.won : 0,
      });
    },

    /**
     * Call when the player makes the first move of a game. Idempotent per game id.
     * A previously started game that was never won counts as a loss and ends its streak.
     */
    recordStart(gameId, drawCount) {
      const s = ensureStats();
      const id = String(gameId);
      if ((s.open && s.open.id === id) || s.lastWonId === id) return false;
      if (s.open) s[s.open.mode].currentStreak = 0;
      const mode = modeKey(drawCount);
      s[mode].played += 1;
      s.open = { id: id, mode: mode };
      saveStats();
      return true;
    },

    /**
     * Call once when a game is won. Idempotent per game id.
     * Returns { isBestScore, isBestTime } so the win screen can celebrate records.
     */
    recordWin(gameId, result) {
      const s = ensureStats();
      const id = String(gameId);
      if (s.lastWonId === id) return { isBestScore: false, isBestTime: false };
      const mode = modeKey(result && result.drawCount);
      const m = s[mode];
      // A win without a recorded start (e.g. a restored state) still counts as a played game.
      if (!s.open || s.open.id !== id) {
        if (s.open) s[s.open.mode].currentStreak = 0;
        m.played += 1;
      }
      s.open = null;
      s.lastWonId = id;

      const score = Math.max(0, Math.round((result && result.score) || 0));
      const elapsedMs = Math.max(0, Math.round((result && result.elapsedMs) || 0));
      const moves = Math.max(0, Math.round((result && result.moves) || 0));

      m.won += 1;
      m.totalTimeMs += elapsedMs;
      m.totalMoves += moves;
      m.currentStreak += 1;
      if (m.currentStreak > m.bestStreak) m.bestStreak = m.currentStreak;

      const isBestScore = score > m.bestScore;
      if (isBestScore) m.bestScore = score;
      const isBestTime = elapsedMs > 0 && (m.bestTimeMs === 0 || elapsedMs < m.bestTimeMs);
      if (isBestTime) m.bestTimeMs = elapsedMs;

      saveStats();
      return { isBestScore: isBestScore, isBestTime: isBestTime };
    },

    reset() {
      stats = { d1: emptyMode(), d3: emptyMode(), open: null, lastWonId: null };
      saveStats();
    },
  };

  // ---------------------------------------------------------------- Save (in-progress game)
  const SAVE_KEY = 'save.v1';

  const Save = {
    /** Returns the serialized engine state string, or null. */
    load() {
      const v = Store.get(SAVE_KEY, null);
      return typeof v === 'string' ? v : null;
    },
    write(serializedState) {
      if (typeof serializedState === 'string') Store.set(SAVE_KEY, serializedState);
    },
    clear() {
      Store.remove(SAVE_KEY);
    },
  };

  SOL.Store = Store;
  SOL.Settings = Settings;
  SOL.Stats = Stats;
  SOL.Save = Save;

  // Mirror settings onto <html> right away, and follow OS reduced-motion changes while on 'auto'.
  Settings.applyToDocument();
  try {
    if (root.matchMedia) {
      motionQuery = root.matchMedia('(prefers-reduced-motion: reduce)');
      const onMotionChange = function () {
        Settings.applyToDocument();
        emit('settings:change', {
          key: 'reducedMotion',
          value: Settings.get('reducedMotion'),
          previous: Settings.get('reducedMotion'),
          all: Settings.all(),
        });
      };
      if (motionQuery.addEventListener) motionQuery.addEventListener('change', onMotionChange);
      else if (motionQuery.addListener) motionQuery.addListener(onMotionChange);
    }
  } catch (err) {
    /* matchMedia unavailable: ignore */
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { Store: Store, Settings: Settings, Stats: Stats, Save: Save };
  }
})(typeof window !== 'undefined' ? window : globalThis);
