/*
 * Persistence: SOL.Store (raw key/value), SOL.Settings, SOL.Stats, SOL.Save.
 *
 * Everything lives in localStorage under the "sol." prefix. Storage can be missing or throw
 * (private mode, file:// in some browsers, quota), so every access is guarded and falls back to
 * an in-memory map: the game always works, it just may not remember things across reloads.
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

  function emit(event, payload) {
    if (SOL.Bus) SOL.Bus.emit(event, payload);
  }

  // ---------------------------------------------------------------- Store
  const Store = {
    /** Read a JSON value; returns `fallback` when missing or unreadable. */
    get(key, fallback) {
      const k = PREFIX + key;
      let raw = null;
      const ls = storage();
      try {
        raw = ls ? ls.getItem(k) : null;
      } catch (err) {
        raw = null;
      }
      if (raw === null && memory.has(k)) raw = memory.get(k);
      if (raw === null || raw === undefined) return fallback;
      try {
        return JSON.parse(raw);
      } catch (err) {
        return fallback;
      }
    },

    /** Write a JSON value. Returns true when it reached persistent storage. */
    set(key, value) {
      const k = PREFIX + key;
      const raw = JSON.stringify(value);
      memory.set(k, raw);
      const ls = storage();
      try {
        if (ls) {
          ls.setItem(k, raw);
          return true;
        }
      } catch (err) {
        /* quota or disabled: the in-memory copy still serves this session */
      }
      return false;
    },

    remove(key) {
      const k = PREFIX + key;
      memory.delete(k);
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
  };

  /** animSpeed -> multiplier handed to SOL.Anim.setSpeed (durations are divided by it). */
  const SPEEDS = { slow: 0.6, normal: 1, fast: 1.8 };

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

    /** Mirrors theme / reduced motion / handedness / effects onto <html> so CSS can react. */
    applyToDocument() {
      const doc = root.document;
      if (!doc || !doc.documentElement) return;
      const el = doc.documentElement;
      el.setAttribute('data-theme', Settings.get('theme'));
      el.setAttribute('data-reduced-motion', Settings.reducedMotion() ? 'true' : 'false');
      el.setAttribute('data-left-handed', Settings.get('leftHanded') ? 'true' : 'false');
      el.setAttribute('data-effects', Settings.get('effects'));
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
