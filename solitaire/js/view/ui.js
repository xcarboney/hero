/*
 * SOL.UI — everything outside the table: the HUD (#hud), the toolbar (#toolbar), sheets / dialogs and the
 * "no more moves" card (#overlay-root) and toasts (#toast-root). Styles: css/ui.css.
 *
 * Phone portrait first: below 640px wide every panel is a bottom sheet (springs up, can be dragged down to
 * dismiss, scrolls inside); from 640px the same markup is a centred dialog with a 3D open / close.
 *
 * Public API
 * ----------
 *   UI.init() -> UI                 builds the HUD and the toolbar and subscribes to SOL.Bus. Idempotent. SOL.Game
 *                                   may be missing or half-built: the UI then shows an empty status and fills in
 *                                   from the first 'game:status' / 'game:new'.
 *   UI.openMenu()                   3D gallery, card backs, statistics, settings, how to play, sound, restart
 *                                   this deal, install app (only when SOL.PWA.canInstall)
 *   UI.openSettings()   UI.openStats()   UI.openHelp()
 *   UI.closeAll()                   closes every sheet / dialog (pending confirm() promises resolve false)
 *   UI.isOpen() -> boolean          true while any modal sheet / dialog is open (not for toasts or the
 *                                   non-modal "no more moves" card)
 *   UI.toast(message, { type = 'info' | 'success' | 'warn' | 'error', duration = 2600 }) -> { dismiss() }
 *                                   duration 0 / Infinity = until tapped or dismiss(). At most 3 are visible;
 *                                   repeating the message of a visible toast restarts it instead of stacking.
 *   UI.confirm({ title, message, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false }) -> Promise<boolean>
 *                                   false for cancel, backdrop, Esc, Android back, drag down, closeAll().
 *
 *   Extras (not in the contract, safe to ignore):
 *   UI.newGame(opts) -> Promise<boolean>   the "New game" flow: asks only when a started, unfinished game would
 *                                   be abandoned, then calls SOL.Game.newGame(opts). Resolves true when a deal
 *                                   was started. The keyboard shortcut for a new game should go through this.
 *   UI.openGallery(tab = 'cards')   SOL.Inspector.openGallery({ tab }) with a toast when the inspector is missing
 *   UI.showWin(payload)             opens the win screen right now ('game:won' does it by itself after ~2.5 s)
 *   UI.showStuck() / UI.hideStuck() the "no more moves" card ('game:stuck' shows it)
 *   UI.refresh()                    re-reads SOL.Game.getStatus() and re-renders the HUD and the toolbar
 *
 * What it listens to (SOL.Bus): 'game:status', 'game:new', 'game:tick', 'game:change', 'game:busy', 'game:won',
 * 'game:stuck', 'settings:change', 'stats:change'.
 * What it calls: SOL.Game.undo / hint / newGame / restartDeal / autoComplete / getStatus / pause('modal') /
 * resume('modal'); SOL.Settings.get / set / reset; SOL.Stats.summary / reset; SOL.Inspector.openGallery({ tab });
 * SOL.Cards.create / createBackOnly / setBack / suitSvg; SOL.Haptics.play; SOL.Audio.play;
 * SOL.App.addBackHandler; SOL.Platform.isNativeApp / canHover; SOL.PWA.canInstall / promptInstall() and its
 * 'pwa:change' event. Every one of them is optional at run time.
 *
 * Behaviour worth knowing
 * -----------------------
 * - Modal layers form a stack. Each one registers a SOL.App back handler while it is open, traps focus,
 *   restores focus when it closes, and closes on Esc / backdrop tap. SOL.Game.pause('modal') is called when
 *   the first one opens and resume('modal') when the last one starts to close (never nested).
 * - The win screen opens ~2.5 s after 'game:won' (SOL.Anim.wait, so it follows the speed setting and is
 *   immediate under reduced motion), and at the latest 4 s of real time after it (SOL.Anim's clock runs slow
 *   when frames are long); a new game or an undo in between cancels it.
 * - The "no more moves" card is not modal: it docks over the toolbar (which is inert and faded out while it
 *   is covered; the card has Undo / New game itself), never takes focus, registers NO back handler (see
 *   showStuck), and goes away on the next 'game:change' / 'game:new'. "Keep looking" silences it until the
 *   next deal.
 * - Settings shows a control for every key of SOL.Settings; 'fullscreen' only inside the Android app
 *   (SOL.Platform.isNativeApp), where it has an effect.
 * - "New game" (toolbar, win screen, stuck card, Deal now, restart) goes through startDeal(): the New button
 *   stays disabled from the request until the controller's 'game:new' (or its promise settling).
 *
 * Motion
 * ------
 * - Sheets and dialogs open and close with CSS transitions on transform / opacity (animateIn / animateOut):
 *   they run on the compositor, so a busy main thread does not make them stutter. Their durations follow
 *   SOL.Anim.speed and they are skipped when SOL.Anim.reduced is set — the two things SOL.Anim exists for.
 * - Everything that must follow JS input or state runs on SOL.Anim: dragging a sheet and its release, the
 *   Auto-complete pill, the HUD's flash / chip / bumps (createPulse), the win screen's count-up, the win-rate
 *   ring, the "no more moves" card.
 * - Small state changes are CSS transitions / keyframes on transform and opacity only (switches, segmented
 *   thumb, rolling digits, ripples, toasts); base.css collapses those under reduced motion.
 * - HUD and toolbar adapt to the width they really have (container queries on .ui-hud-box / .ui-tb-box), so
 *   side insets count; see ui.css for the measured thresholds.
 */
(function (root) {
  'use strict';

  const SOL = (root.SOL = root.SOL || {});
  const doc = root.document;

  if (!doc) {
    // Not a browser (the file is only meant for the page): expose an inert API so nothing throws.
    const noop = function () {};
    SOL.UI = {
      init: noop, openMenu: noop, openSettings: noop, openStats: noop, openHelp: noop, closeAll: noop,
      isOpen: function () { return false; },
      toast: function () { return { dismiss: noop }; },
      confirm: function () { return Promise.resolve(false); },
    };
    return;
  }

  // ------------------------------------------------------------------ constants
  const SHEET_QUERY = '(max-width: 639.98px)'; // below this the panels are bottom sheets (must match ui.css)
  const WIN_DELAY_MS = 2500; // how long the celebration plays before the win screen comes up (SOL.Anim time)
  const WIN_DELAY_CAP_MS = 4000; // ...and the longest it may take in real time (see onWon)
  const TOAST_MAX = 3;
  const RING_R = 42;
  const RING_C = 2 * Math.PI * RING_R;

  const THEME_NAMES = { emerald: 'Emerald', midnight: 'Midnight', crimson: 'Crimson', slate: 'Slate' };

  // ------------------------------------------------------------------ icons (inline SVG, 24px grid, stroked)
  const ICONS = {
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
    hint: '<path d="M9.5 18h5"/><path d="M10.5 21h3"/><path d="M12 3a6.2 6.2 0 0 0-3.9 11c.7.6 1.1 1.3 1.2 2.2h5.4c.1-.9.5-1.6 1.2-2.2A6.2 6.2 0 0 0 12 3z"/>',
    newgame: '<rect x="5" y="3" width="14" height="18" rx="2.6"/><path d="M12 8.6v6.8M8.6 12h6.8"/>',
    cube: '<path d="M12 2.8 20 7.2v9.6l-8 4.4-8-4.4V7.2z"/><path d="M4.3 7.4 12 11.8l7.7-4.4"/><path d="M12 11.8V21"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    auto: '<path d="m5 5 7 7-7 7"/><path d="m13 5 7 7-7 7"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    stats: '<path d="M5.5 20v-7M12 20V5M18.5 20v-11"/>',
    settings: '<path d="M4 7h8.4M19.6 7H20M4 17h.4M11.6 17H20"/><circle cx="16" cy="7" r="2.7"/><circle cx="8" cy="17" r="2.7"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 1 1 3.6 2.3c-.8.5-1.2 1-1.2 1.9"/><path d="M12 16.9v.1"/>',
    soundOn: '<path d="M4 9.5v5h3.5l4.5 4v-13l-4.5 4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/><path d="M18 6.5a7.5 7.5 0 0 1 0 11"/>',
    soundOff: '<path d="M4 9.5v5h3.5l4.5 4v-13l-4.5 4z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>',
    restart: '<path d="M4.5 12a7.5 7.5 0 1 0 2.4-5.5"/><path d="M4 4.5v4.6h4.6"/>',
    install: '<path d="M12 4v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M5 19.5h14"/>',
    backs: '<rect x="5.5" y="3" width="13" height="18" rx="2.4"/><path d="M12 7.5 15 12l-3 4.5L9 12z"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 5.5H5.2a2.8 2.8 0 0 0 2.9 4"/><path d="M16 5.5h2.8a2.8 2.8 0 0 1-2.9 4"/><path d="M12 13v4M8.5 20h7M10 17h4"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.1"/>',
    warn: '<path d="M12 4 21 19.5H3z"/><path d="M12 10v4.5M12 17v.1"/>',
    error: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
    flame: '<path d="M12 3c.7 3.3 5 5.1 5 10a5 5 0 0 1-10 0c0-1.9.8-3.3 2-4.4.2 1.4.9 2.3 1.8 2.7C10.6 8.5 10.9 5.4 12 3z"/>',
    star: '<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9l-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z"/>',
    moves: '<path d="M4 8h13M13 4l4 4-4 4"/><path d="M20 16H7M11 12l-4 4 4 4"/>',
    tap: '<circle cx="12" cy="12" r="2.6" class="ui-fill"/><circle cx="12" cy="12" r="6.5"/>',
    drag: '<path d="M12 3v18M3 12h18"/><path d="m9 6 3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
    deck: '<rect x="8" y="3.5" width="11" height="15" rx="2.2"/><path d="M5 7v11.5a2 2 0 0 0 2 2h8"/>',
    press: '<circle cx="12" cy="12" r="2.6" class="ui-fill"/><path d="M12 4a8 8 0 1 1-8 8"/><path d="M4 7.5V12h4.5"/>',
    cards1: '<rect x="7" y="3.5" width="10" height="17" rx="2.2"/>',
    cards3: '<rect x="10.5" y="4" width="9" height="16" rx="2"/><path d="M7.5 5.5v13M4.5 7v10"/>',
  };

  function icon(name, cls) {
    return (
      '<svg class="ui-icon' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      (ICONS[name] || '') + '</svg>'
    );
  }

  // ------------------------------------------------------------------ small helpers
  /** h('button.a.b', { attr: value, html, text, onclick }, ...children) -> element */
  function h(spec, attrs) {
    const parts = spec.split('.');
    const node = doc.createElement(parts[0] || 'div');
    if (parts.length > 1) node.className = parts.slice(1).join(' ');
    if (attrs) {
      for (const key of Object.keys(attrs)) {
        const v = attrs[key];
        if (v === null || v === undefined || v === false) continue;
        if (key === 'html') node.innerHTML = v;
        else if (key === 'text') node.textContent = v;
        else if (key.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(key.slice(2), v);
        else node.setAttribute(key, v === true ? '' : String(v));
      }
    }
    for (let i = 2; i < arguments.length; i++) append(node, arguments[i]);
    return node;
  }

  function append(node, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) child.forEach((c) => append(node, c));
    else if (child.nodeType) node.appendChild(child);
    else node.appendChild(doc.createTextNode(String(child)));
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function fmtInt(n) {
    const v = Math.round(Number(n) || 0);
    const s = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (v < 0 ? '−' : '') + s;
  }

  /** 02:31, or 1:02:31 from an hour up. */
  function fmtTime(ms) {
    const t = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const hh = Math.floor(t / 3600);
    const mm = Math.floor((t % 3600) / 60);
    const ss = t % 60;
    const p = (v) => (v < 10 ? '0' : '') + v;
    return hh > 0 ? hh + ':' + p(mm) + ':' + p(ss) : p(mm) + ':' + p(ss);
  }

  function spokenTime(ms) {
    const t = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const m = Math.floor(t / 60);
    const s = t % 60;
    return (m ? m + (m === 1 ? ' minute ' : ' minutes ') : '') + s + (s === 1 ? ' second' : ' seconds');
  }

  function mq(query) {
    try {
      return !!(root.matchMedia && root.matchMedia(query).matches);
    } catch (err) {
      return false;
    }
  }

  function report(what, err) {
    if (root.console && typeof root.console.error === 'function') root.console.error('[SOL.UI] ' + what, err);
  }

  /** Progress of t through [a, b], clamped to 0..1. */
  function seg(t, a, b) {
    return clamp((t - a) / (b - a), 0, 1);
  }

  function easeOut3(x) {
    return 1 - Math.pow(1 - x, 3);
  }

  /**
   * A one-shot effect that can be fired again at any moment, any number of times per frame: the running one is
   * cancelled and the new one starts from the beginning. render(t) gets linear time 0..1 and writes transform /
   * opacity; reset() removes every inline style again (it also runs under reduced motion, where SOL.Anim jumps
   * straight to the end, so nothing can be left half-shown).
   *
   * Why not CSS keyframes: re-adding a class with the same animation-name does not restart a finished CSS
   * animation, and several score changes can arrive within one frame (auto-complete, cascades).
   */
  function createPulse(duration, render, reset) {
    let handle = null;
    return function fire() {
      if (handle) handle.cancel();
      handle = tween({
        duration: duration,
        ease: 'linear',
        update: render,
        done: () => {
          handle = null;
          reset();
        },
      });
    };
  }

  // ------------------------------------------------------------------ the other modules (all optional)
  function callGame(method) {
    const g = SOL.Game;
    if (!g || typeof g[method] !== 'function') return undefined;
    try {
      const out = g[method].apply(g, Array.prototype.slice.call(arguments, 1));
      // newGame / restartDeal / autoComplete return promises: a rejection must not become an unhandled one
      if (out && typeof out.then === 'function' && typeof out.catch === 'function') {
        out.catch((err) => report('SOL.Game.' + method + ' rejected', err));
      }
      return out;
    } catch (err) {
      report('SOL.Game.' + method + ' threw', err);
      return undefined;
    }
  }

  function sGet(key, fallback) {
    try {
      return SOL.Settings ? SOL.Settings.get(key) : fallback;
    } catch (err) {
      return fallback;
    }
  }

  /** Whether this build of SOL.Settings knows the key (the schema grows: never offer a control for nothing). */
  function hasSetting(key) {
    try {
      return !!SOL.Settings && Object.prototype.hasOwnProperty.call(SOL.Settings.defaults(), key);
    } catch (err) {
      return false;
    }
  }

  function sSet(key, value) {
    try {
      return SOL.Settings ? SOL.Settings.set(key, value) : false;
    } catch (err) {
      return false;
    }
  }

  function audio(name, opts) {
    try {
      if (SOL.Audio && typeof SOL.Audio.play === 'function') SOL.Audio.play(name, opts);
    } catch (err) {
      /* sound is never worth an error */
    }
  }

  function haptic(kind) {
    try {
      if (SOL.Haptics && typeof SOL.Haptics.play === 'function') SOL.Haptics.play(kind);
    } catch (err) {
      /* ignore */
    }
  }

  /** The feedback every button gives. */
  function feedback() {
    haptic('tap');
    audio('click');
  }

  function reducedMotion() {
    return !!(SOL.Anim && SOL.Anim.reduced);
  }

  // SOL.Anim wrappers: without the clock (it should always be there) everything jumps to its end state.
  const DONE_HANDLE = { cancel() {}, finish() {}, finished: Promise.resolve(true), running: false };

  function tween(o) {
    const A = SOL.Anim;
    if (A && typeof A.tween === 'function') return A.tween(o);
    if (o.update) o.update(o.to === undefined ? 1 : o.to, 1);
    if (o.done) o.done();
    return DONE_HANDLE;
  }

  function spring(o) {
    const A = SOL.Anim;
    if (A && typeof A.spring === 'function') return A.spring(o);
    if (o.update) o.update(o.to, 0);
    if (o.done) o.done();
    return DONE_HANDLE;
  }

  function wait(ms) {
    const A = SOL.Anim;
    if (A && typeof A.wait === 'function') return A.wait(ms);
    let timer = 0;
    let finish = null;
    const p = new Promise((resolve) => {
      finish = resolve;
      timer = root.setTimeout(() => resolve(true), ms);
    });
    p.cancel = function () {
      root.clearTimeout(timer);
      finish(false);
    };
    return p;
  }

  // ------------------------------------------------------------------ state
  let inited = false;
  let hudRoot = null;
  let tbRoot = null;
  let overlayRoot = null;
  let toastRoot = null;

  const status = {
    score: 0, moves: 0, elapsedMs: 0, canUndo: false, canHint: false, canAutoComplete: false,
    stockCount: 0, wasteCount: 0, drawCount: 1, won: false, started: false, busy: false, seed: 0,
  };
  let haveStatus = false; // a real status has been seen
  let quietNext = false; // the next score change is not a player's move (new deal): no flash, no chip

  const hud = {
    els: null, roller: null, score: null, moves: null, time: null, draw: null, liveTimer: 0,
    flash: null, chipFx: null, movesFx: null, badgeFx: null, // re-fireable one-shot effects (createPulse)
    box: null, bar: null, fitKey: '', // fitHud(): what the bar was last fitted for
  };
  // Stray-tap protection (see noteClick, openLayer and shield)
  const GUARD_OPEN_MS = 160; // after a panel opens on a tap, every tap on it is ignored for this long...
  const GUARD_NEAR_MS = 380; // ...and for this long when it lands where the opening tap did (a double tap)
  const GUARD_NEAR_PX = 56;
  const GUARD_SELF_MS = 320; // a panel that opened by itself (no tap): ignore taps on it for this long
  const SHIELD_MS = 300; // after a panel closes on a tap, the screen ignores taps for this long
  let lastTap = null; // { x, y, t } of the pointer click being handled (or just handled)
  let shieldEl = null;
  let shieldTimer = 0;
  const tb = { box: null, btns: {}, auto: null, autoOn: false, autoT: 0, autoAnim: null };
  const layers = []; // open modal layers, bottom -> top
  let pauseDepth = 0;
  let uid = 0;
  const toasts = []; // visible toasts, oldest -> newest
  const stuck = { el: null, muted: false, fresh: false, anim: null };
  let dealPending = false; // a deal was requested and has not begun yet (startDeal)
  let dealToken = 0;
  let dealTimer = 0;
  let winToken = 0;
  let winWait = null;
  let winCap = 0;
  let pendingWin = null;

  // ================================================================== HUD

  /**
   * Rolling number: one clipped window per digit with a strip 0-9 inside; changing a digit slides the strip
   * (a CSS transition on transform), staggered from the right so the change ripples through the number.
   */
  function createRoller(host) {
    const slots = []; // index 0 = the rightmost character
    let shown = null;
    let instantFrame = 0;

    function digitSlot() {
      const strip = h('span.ui-roll__strip');
      for (let d = 0; d < 10; d++) strip.appendChild(h('span', null, String(d)));
      return { kind: 'd', el: h('span.ui-roll__slot', null, strip), strip: strip };
    }

    function sepSlot(ch) {
      return { kind: 's', el: h('span.ui-roll__sep', null, ch), strip: null };
    }

    function set(value, animate) {
      const text = fmtInt(value);
      if (text === shown) return;
      const had = shown !== null;
      shown = text;
      if (!animate) {
        // jump: transitions off for this style pass, back on in the next frame
        host.classList.add('is-instant');
        if (instantFrame) root.cancelAnimationFrame(instantFrame);
        instantFrame = root.requestAnimationFrame(() => {
          instantFrame = 0;
          host.classList.remove('is-instant');
        });
      }
      const chars = text.split('').reverse();
      for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        const isDigit = ch >= '0' && ch <= '9';
        let slot = slots[i];
        if (!slot || slot.kind !== (isDigit ? 'd' : 's')) {
          const fresh = isDigit ? digitSlot() : sepSlot(ch);
          if (slot) host.replaceChild(fresh.el, slot.el);
          else host.insertBefore(fresh.el, host.firstChild);
          if (animate && had) fresh.el.classList.add('is-enter');
          slots[i] = slot = fresh;
        }
        if (isDigit) {
          slot.strip.style.transitionDelay = animate ? i * 30 + 'ms' : '0ms';
          slot.strip.style.setProperty('--d', String(ch.charCodeAt(0) - 48));
        }
      }
      while (slots.length > chars.length) slots.pop().el.remove();
    }

    return { set: set };
  }

  function buildHud() {
    const badge = h('div.ui-badge', { role: 'group' },
      h('span.ui-badge__icon', { 'aria-hidden': 'true' }),
      h('span', { 'aria-hidden': 'true' }, h('span.ui-badge__word', null, 'Draw'), h('span.ui-badge__n', null, '1')));

    const rollHost = h('span.ui-roll');
    const chip = h('span.ui-chip', { 'aria-hidden': 'true' });
    const glow = h('span.ui-score__glow');
    const caption = h('span.ui-stat__label-text', null, 'Score');
    const scoreValue = h('span.ui-stat__value.ui-score', { 'aria-hidden': 'true' }, glow, rollHost);
    const score = h('div.ui-stat.ui-stat--score', { role: 'group' },
      h('span.ui-stat__label', { 'aria-hidden': 'true' }, caption, chip),
      scoreValue);

    const timeValue = h('span.ui-stat__value', { 'aria-hidden': 'true' }, '00:00');
    const time = h('div.ui-stat.ui-stat--time', { role: 'group' },
      h('span.ui-stat__label', { 'aria-hidden': 'true' }, h('span.ui-stat__label-text', null, 'Time')), timeValue);

    const movesValue = h('span.ui-stat__value', { 'aria-hidden': 'true' }, '0');
    const moves = h('div.ui-stat.ui-stat--moves', { role: 'group' },
      h('span.ui-stat__label', { 'aria-hidden': 'true' }, h('span.ui-stat__label-text', null, 'Moves')), movesValue);

    const live = h('div.visually-hidden', { 'aria-live': 'polite', 'aria-atomic': 'true' });

    const bar = h('div.ui-hud', { role: 'group', 'aria-label': 'Game status' },
      h('div.ui-hud__left', null, badge), score, h('div.ui-hud__right', null, time, moves));

    hudRoot.textContent = '';
    hud.bar = bar;
    hud.box = h('div.ui-hud-box', null, bar); // the box is the container the bar's queries measure
    hud.fitKey = '';
    hudRoot.appendChild(hud.box);
    hudRoot.appendChild(live);
    if (typeof root.ResizeObserver === 'function') {
      // rotation, side insets: the room changed, fit again (the box's own size never depends on the bar)
      let width = -1;
      new root.ResizeObserver((entries) => {
        const w = entries.length ? Math.round(entries[entries.length - 1].contentRect.width) : -1;
        if (w === width) return;
        width = w;
        fitHud(true);
      }).observe(hud.box);
    }

    const pop = (el, amount) => [
      (t) => {
        el.style.transform = 'scale(' + (1 + amount * Math.sin(Math.PI * t)).toFixed(3) + ')';
      },
      () => {
        el.style.transform = '';
      },
    ];

    // gold flash: the glow spreads sideways (the bar is slim: it must stay inside it) while the digits pop
    hud.flash = createPulse(760, (t) => {
      const a = seg(t, 0, 0.22);
      const b = easeOut3(seg(t, 0.22, 1));
      glow.style.opacity = (t < 0.22 ? a : 1 - b).toFixed(3);
      glow.style.transform = 'scale(' + (t < 0.22 ? 0.5 + 0.5 * a : 1 + 0.45 * b).toFixed(3) + ',' + (t < 0.22 ? 0.8 + 0.2 * a : 1).toFixed(3) + ')';
      rollHost.style.transform = 'scale(' + (1 + 0.2 * Math.sin(Math.PI * seg(t, 0, 0.58))).toFixed(3) + ')';
    }, () => {
      glow.style.opacity = '';
      glow.style.transform = '';
      rollHost.style.transform = '';
    });

    // +10 / -15 chip: pops into the caption's place, holds, drifts up and away; the caption cross-fades with it
    hud.chipFx = createPulse(1150, (t) => {
      const rise = easeOut3(seg(t, 0, 0.13));
      const settle = seg(t, 0.13, 0.24);
      const leave = seg(t, 0.76, 1);
      const opacity = t < 0.76 ? rise : 1 - leave;
      const y = t < 0.76 ? 30 - 80 * rise : -50 - 100 * leave * leave;
      const scale = t < 0.13 ? 0.6 + 0.56 * rise : t < 0.76 ? 1.16 - 0.16 * settle : 1 - 0.1 * leave;
      chip.style.opacity = opacity.toFixed(3);
      chip.style.transform = 'translate(-50%,' + y.toFixed(1) + '%) scale(' + scale.toFixed(3) + ')';
      caption.style.opacity = (1 - opacity).toFixed(3);
    }, () => {
      chip.style.opacity = '';
      chip.style.transform = '';
      caption.style.opacity = '';
    });

    hud.movesFx = createPulse.apply(null, [320].concat(pop(movesValue, 0.2)));
    hud.badgeFx = createPulse.apply(null, [420].concat(pop(badge, 0.14)));

    hud.els = { badge, score, scoreValue, chip, time, timeValue, moves, movesValue, live };
    hud.roller = createRoller(rollHost);
    hud.roller.set(0, false);
    hud.score = null;
    hud.moves = null;
    hud.time = null;
    hud.draw = null;
  }

  function renderScore(value, animate, celebrate) {
    const e = hud.els;
    const prev = hud.score;
    if (prev === value) return;
    hud.score = value;
    hud.roller.set(value, animate);
    e.score.setAttribute('aria-label', 'Score ' + value);
    if (animate && celebrate && prev !== null) {
      const delta = value - prev;
      e.chip.textContent = (delta > 0 ? '+' : '−') + fmtInt(Math.abs(delta));
      e.chip.className = 'ui-chip ' + (delta > 0 ? 'ui-chip--plus' : 'ui-chip--minus');
      hud.flash();
      hud.chipFx();
    }
    // Announce once the score has settled (a foundation cascade must not read out every step).
    if (prev !== null) {
      root.clearTimeout(hud.liveTimer);
      hud.liveTimer = root.setTimeout(() => {
        e.live.textContent = 'Score ' + hud.score;
      }, 900);
    }
  }

  function renderMoves(value, animate) {
    if (hud.moves === value) return;
    const first = hud.moves === null;
    hud.moves = value;
    hud.els.movesValue.textContent = fmtInt(value);
    hud.els.moves.setAttribute('aria-label', 'Moves ' + value);
    if (animate && !first) hud.movesFx();
  }

  function renderTime(ms) {
    const text = fmtTime(ms);
    if (hud.time === text) return;
    hud.time = text;
    hud.els.timeValue.textContent = text;
    hud.els.time.setAttribute('aria-label', 'Time ' + spokenTime(ms));
  }

  function renderDraw(n) {
    const draw = n === 3 ? 3 : 1;
    if (hud.draw === draw) return;
    const first = hud.draw === null;
    hud.draw = draw;
    const e = hud.els.badge;
    e.querySelector('.ui-badge__n').textContent = String(draw);
    e.querySelector('.ui-badge__icon').innerHTML = icon(draw === 3 ? 'cards3' : 'cards1');
    e.setAttribute('aria-label', 'Draw ' + draw);
    if (!first) hud.badgeFx();
  }

  function renderTimerVisibility() {
    if (!hud.els) return;
    hud.els.time.hidden = sGet('showTimer', true) === false;
    fitHud(false);
  }

  /**
   * Guarantees that the bar never overlaps itself, wraps or runs off the screen, whatever the values. Normal
   * games fit with room to spare. When they do not (a seven-digit score next to an hours-long timer on a 320px
   * phone with side insets), the bar first goes "tight" (the badge drops the word Draw, gaps shrink) and, if
   * that is not enough, is scaled down as a whole to the width there is.
   *
   * It reads layout, so it only runs when the room or the number of characters on show has changed (not on
   * every status, and never inside an animation frame).
   */
  function fitHud(force) {
    const bar = hud.bar;
    const box = hud.box;
    if (!bar || !box || !hud.els) return;
    const key = [
      fmtInt(hud.score || 0).length, fmtInt(hud.moves || 0).length, (hud.time || '').length,
      hud.els.time.hidden ? 0 : 1, hud.draw || 0,
    ].join(':');
    if (!force && key === hud.fitKey) return;
    hud.fitKey = key;
    const hadFit = bar.classList.contains('is-tight') || bar.style.transform !== '';
    bar.classList.remove('is-tight');
    bar.style.width = '';
    bar.style.transform = '';
    const avail = box.clientWidth;
    if (!(avail > 0)) return;
    // Everyday values on a bar this wide always fit (up to 12 characters of score + moves + time need at most
    // 292px): skip the layout read.
    if (!hadFit && avail >= 320 && key.split(':').slice(0, 3).reduce((n, v) => n + Number(v), 0) <= 12) return;
    const natural = function () {
      bar.classList.add('is-measure'); // every column at its content's width (ui.css)
      const w = Math.ceil(bar.getBoundingClientRect().width);
      bar.classList.remove('is-measure');
      return w;
    };
    let need = natural();
    if (need <= avail) return;
    bar.classList.add('is-tight');
    need = natural();
    if (need <= avail) return;
    bar.style.width = need + 'px';
    bar.style.transform = 'scale(' + (Math.floor((avail / need) * 10000) / 10000) + ')';
  }

  // ================================================================== toolbar

  function tbButton(action, iconName, label, aria, extraClass, keys) {
    const btn = h('button.ui-tb__btn.ui-press' + (extraClass ? '.' + extraClass : ''), {
      type: 'button', 'data-action': action, 'aria-label': aria || label, 'aria-keyshortcuts': keys || null,
    },
      h('span.ui-tb__icon', { html: icon(iconName) }),
      h('span.ui-tb__label', { 'aria-hidden': 'true' }, label));
    tb.btns[action] = btn;
    return btn;
  }

  function buildToolbar() {
    tb.btns = {};
    const bar = h('div.ui-tb', { role: 'toolbar', 'aria-label': 'Game controls' },
      tbButton('undo', 'undo', 'Undo', 'Undo', '', 'U'),
      tbButton('hint', 'hint', 'Hint', 'Hint', '', 'H'),
      tbButton('new', 'newgame', 'New', 'New game', '', 'N'),
      tbButton('gallery', 'cube', '3D cards', '3D card gallery', 'ui-tb__btn--accent'),
      tbButton('menu', 'menu', 'Menu', 'Menu'));

    const auto = h('button.ui-auto', { type: 'button', 'data-action': 'auto', 'aria-label': 'Auto-complete', 'aria-keyshortcuts': 'A' },
      h('span.ui-auto__glow', { 'aria-hidden': 'true' }),
      h('span.ui-auto__clip', { 'aria-hidden': 'true' }),
      h('span', { html: icon('auto'), 'aria-hidden': 'true' }),
      h('span.ui-auto__label', { 'aria-hidden': 'true' }, 'Auto', h('span.ui-auto__rest', null, '-complete')));
    tb.auto = auto;
    tb.autoOn = false;
    tb.autoT = 0;

    tbRoot.textContent = '';
    // The box is the size container the toolbar's own queries measure: its width is what is left after the
    // side insets, which is what decides whether labels and the pill fit next to each other.
    tb.box = h('div.ui-tb-box', null, bar, h('div.ui-auto-wrap', null, auto));
    tbRoot.appendChild(tb.box);

    tbRoot.addEventListener('click', (e) => {
      const btn = e.target.closest ? e.target.closest('[data-action]') : null;
      if (!btn || !tbRoot.contains(btn) || btn.disabled) return;
      feedback();
      toolbarAction(btn.getAttribute('data-action'));
    });
  }

  function toolbarAction(action) {
    switch (action) {
      case 'undo':
        callGame('undo');
        break;
      case 'hint':
        callGame('hint');
        break;
      case 'new':
        newGame();
        break;
      case 'gallery':
        openGallery('cards');
        break;
      case 'menu':
        openMenu();
        break;
      case 'auto':
        callGame('autoComplete');
        break;
      default:
        break;
    }
  }

  function renderToolbar() {
    const b = tb.btns;
    if (!b.undo) return;
    const busy = !!status.busy;
    b.undo.disabled = !status.canUndo || busy;
    b.hint.disabled = !status.canHint || busy;
    // A finished game may always be followed by a new one, even while the celebration ("busy") still runs —
    // but not twice: once a deal has been asked for, wait until it has begun (see startDeal).
    b.new.disabled = dealPending || (busy && !status.won);
    setAuto(!!status.canAutoComplete && !busy && !status.won);
  }

  function applyAutoT(t) {
    tb.autoT = t;
    const btn = tb.auto;
    btn.style.opacity = String(clamp(t * 1.6, 0, 1));
    btn.style.transform = 'translate3d(0,' + ((1 - t) * 44).toFixed(1) + 'px,0) scale(' + (0.78 + 0.22 * t).toFixed(3) + ')';
  }

  /** The Auto-complete pill springs in while the game can finish itself and drops away otherwise. */
  function setAuto(on) {
    if (on === tb.autoOn) return;
    tb.autoOn = on;
    if (tb.autoAnim) tb.autoAnim.cancel();
    const btn = tb.auto;
    if (toastRoot) toastRoot.classList.toggle('has-auto', on);
    if (on) {
      btn.classList.add('is-on');
      tb.box.classList.add('has-auto'); // short landscape: labels make room for the pill (ui.css)
      haptic('tick');
      tb.autoAnim = spring({ from: tb.autoT, to: 1, stiffness: 240, damping: 16, precision: 0.002, update: applyAutoT });
    } else {
      tb.autoAnim = tween({
        from: tb.autoT, to: 0, duration: 200, ease: 'inCubic', update: applyAutoT,
        done: () => {
          btn.classList.remove('is-on');
          tb.box.classList.remove('has-auto');
        },
      });
    }
    layoutToasts();
  }

  // ================================================================== status

  function readStatus() {
    const g = SOL.Game;
    if (!g || typeof g.getStatus !== 'function') return null;
    try {
      const s = g.getStatus();
      return s && typeof s === 'object' ? s : null;
    } catch (err) {
      return null; // mid-construction
    }
  }

  function applyStatus(s, quiet) {
    if (!inited) return;
    const first = !haveStatus;
    const wasWon = !!status.won;
    if (s) {
      for (const key of Object.keys(status)) {
        if (Object.prototype.hasOwnProperty.call(s, key) && s[key] !== undefined && s[key] !== null) status[key] = s[key];
      }
      haveStatus = true;
    } else if (!haveStatus) {
      status.drawCount = sGet('drawCount', 1) === 3 ? 3 : 1;
    }
    // A fresh deal (or the first status ever) is not a score change to celebrate.
    const isMove = !first && !quiet && !quietNext && status.moves > 0;
    if (s) quietNext = false;
    renderScore(Math.max(0, Math.round(Number(status.score) || 0)), !first, isMove);
    renderMoves(Math.max(0, Math.round(Number(status.moves) || 0)), isMove);
    renderTime(status.elapsedMs);
    renderDraw(status.drawCount);
    fitHud(false);
    renderToolbar();
    // The win was undone: the win screen (shown or still waiting for the celebration) no longer applies.
    if (wasWon && !status.won) cancelWin(true);
  }

  function refresh() {
    applyStatus(readStatus(), false);
  }

  // ================================================================== press feedback (ripple)

  function onPressDown(e) {
    if (reducedMotion()) return;
    const t = e.target && e.target.closest ? e.target.closest('.ui-press, .ui-auto') : null;
    if (!t || t.disabled) return;
    const host = t.classList.contains('ui-auto') ? t.querySelector('.ui-auto__clip') : t;
    const rect = t.getBoundingClientRect();
    const dot = h('span.ui-ripple', { 'aria-hidden': 'true' });
    dot.style.setProperty('--rx', (e.clientX - rect.left).toFixed(1) + 'px');
    dot.style.setProperty('--ry', (e.clientY - rect.top).toFixed(1) + 'px');
    host.appendChild(dot);
    const remove = () => dot.remove();
    dot.addEventListener('animationend', remove);
    root.setTimeout(remove, 900); // in case the animation never runs (hidden tab)
  }

  // ================================================================== stray taps

  function nowMs() {
    return root.performance && typeof root.performance.now === 'function' ? root.performance.now() : Date.now();
  }

  /** True for a click made with a pointer (finger, mouse, pen) — not one a key press or a script produced. */
  function isPointerClick(e) {
    return !!e && e.isTrusted !== false && (e.detail > 0 || (typeof e.pointerType === 'string' && e.pointerType !== ''));
  }

  /** Document, capture phase: remembers where and when the current tap landed (openLayer reads it). */
  function noteClick(e) {
    if (isPointerClick(e)) lastTap = { x: e.clientX, y: e.clientY, t: nowMs() };
  }

  /**
   * A double tap must never act twice. Two things can sit under the second tap that the player never aimed at:
   * a panel that the first tap opened (Menu twice hit "Restart this deal"; New twice confirmed the question it
   * had just asked) — openLayer guards that — and whatever a closing panel uncovers (the toolbar's Undo under
   * "Keep playing", the table's cards under a toast). For the second case the screen is covered by an invisible
   * shield for a moment after a panel was closed by a tap.
   */
  function shield(ms) {
    if (!overlayRoot) return;
    if (!shieldEl) {
      shieldEl = h('div.ui-shield', { 'aria-hidden': 'true' });
      // a tap on the shield is a tap on nothing
      shieldEl.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
      });
    }
    if (shieldEl.parentNode !== overlayRoot || shieldEl.nextSibling) overlayRoot.appendChild(shieldEl); // on top
    root.clearTimeout(shieldTimer);
    shieldTimer = root.setTimeout(() => {
      if (shieldEl) shieldEl.remove();
    }, ms || SHIELD_MS);
  }

  /** Was this close caused by a tap that is still "in the air" (its double could follow)? */
  function tapJustNow() {
    return !!lastTap && nowMs() - lastTap.t < 120;
  }

  // ================================================================== modal layers (sheets / dialogs)

  function isSheetMode() {
    return mq(SHEET_QUERY);
  }

  function topLayer() {
    return layers.length ? layers[layers.length - 1] : null;
  }

  function findLayer(kind) {
    for (let i = layers.length - 1; i >= 0; i--) if (layers[i].kind === kind) return layers[i];
    return null;
  }

  function inspectorOpen() {
    try {
      return !!(SOL.Inspector && typeof SOL.Inspector.isOpen === 'function' && SOL.Inspector.isOpen());
    } catch (err) {
      return false;
    }
  }

  function focusables(rootEl) {
    const all = rootEl.querySelectorAll('button, [href], input, select, textarea, [tabindex]');
    const out = [];
    for (let i = 0; i < all.length; i++) {
      const n = all[i];
      if (n.disabled || n.hidden || n.tabIndex < 0) continue;
      if (!n.getClientRects().length) continue;
      out.push(n);
    }
    return out;
  }

  function setSheetY(layer, y) {
    layer.y = y;
    layer.sheet.style.transform = 'translate3d(0,' + y.toFixed(1) + 'px,0)';
  }

  function setDim(layer, v) {
    layer.backdrop.style.opacity = String(clamp(v, 0, 1));
  }

  // Where a dialog comes from and where it leaves to (3D: the layer has perspective).
  const DIALOG_FROM = 'translate3d(0,30px,-80px) rotateX(-16deg) scale(0.91)';
  const DIALOG_TO = 'translate3d(0,18px,-60px) rotateX(12deg) scale(0.94)';
  // A touch of overshoot on the way in: the sheet rises a few pixels past its place and settles (the strip
  // under it, .ui-sheet::after, covers the gap); a dialog tips slightly past flat.
  const EASE_SHEET_IN = 'cubic-bezier(0.22, 1.12, 0.36, 1)';
  const EASE_DIALOG_IN = 'cubic-bezier(0.2, 1.25, 0.4, 1)';
  const EASE_OUT = 'cubic-bezier(0.4, 0, 1, 1)';

  /** Duration for a CSS transition: follows the speed setting like SOL.Anim does; 0 under reduced motion. */
  function transitionMs(ms) {
    if (reducedMotion()) return 0;
    const speed = SOL.Anim && SOL.Anim.speed > 0 ? SOL.Anim.speed : 1;
    return Math.max(1, Math.round(ms / speed));
  }

  /**
   * Calls fn once when the element's transform transition has ended — or after `ms` plus a margin, because a
   * transition whose start and end are the same never runs and never reports. Returns cancel().
   *
   * Only 'transitionend' counts, never 'transitioncancel': when a sheet that is still sliding in is frozen
   * (closed or grabbed mid-way), the cancel event of THAT transition arrives a frame later, when the next
   * transition's waiter is already listening — it would take it for its own end.
   */
  function afterTransform(el, ms, fn) {
    let done = false;
    let timer = 0;
    const finish = (e) => {
      if (done || (e && (e.target !== el || e.propertyName !== 'transform'))) return;
      done = true;
      root.clearTimeout(timer);
      el.removeEventListener('transitionend', finish);
      fn();
    };
    el.addEventListener('transitionend', finish);
    timer = root.setTimeout(() => finish(null), ms + 120);
    return function cancel() {
      if (done) return;
      done = true;
      root.clearTimeout(timer);
      el.removeEventListener('transitionend', finish);
    };
  }

  /** Stops whatever is moving the layer and leaves it exactly where it is on screen (inline, no transition). */
  function freezeLayer(layer) {
    const sheet = layer.sheet;
    if (layer.anim) layer.anim.cancel(); // a drag-release spring (SOL.Anim)
    layer.anim = null;
    if (layer.afterMotion) layer.afterMotion();
    layer.afterMotion = null;
    if (sheet.style.transition && sheet.style.transition !== 'none') {
      // a CSS transition is in flight: pin the pose it has reached
      const cs = root.getComputedStyle(sheet);
      const pose = cs.transform;
      const opacity = cs.opacity;
      sheet.style.transition = 'none';
      sheet.style.transform = pose === 'none' ? 'translate3d(0,0,0)' : pose;
      sheet.style.opacity = opacity;
      if (layer.mode === 'sheet') {
        try {
          layer.y = pose === 'none' ? 0 : new root.DOMMatrixReadOnly(pose).m42;
        } catch (err) {
          layer.y = 0;
        }
      }
    }
    const backdrop = layer.backdrop;
    if (backdrop.style.transition && backdrop.style.transition !== 'none') {
      const o = root.getComputedStyle(backdrop).opacity;
      backdrop.style.transition = 'none';
      backdrop.style.opacity = o;
    }
  }

  function settleLayer(layer) {
    const sheet = layer.sheet;
    layer.afterMotion = null;
    layer.y = 0;
    sheet.style.transition = '';
    sheet.style.transform = '';
    sheet.style.opacity = '';
    layer.backdrop.style.transition = '';
    layer.backdrop.style.opacity = '1';
  }

  /**
   * Opens with CSS transitions on transform / opacity: they run on the compositor, so the panel keeps gliding
   * even when the main thread is busy (the build of its own content, effects on the table, a slow phone).
   */
  function animateIn(layer) {
    const sheet = layer.sheet;
    const backdrop = layer.backdrop;
    layer.mode = isSheetMode() ? 'sheet' : 'dialog';
    const ms = transitionMs(layer.mode === 'sheet' ? 420 : 400);
    if (!ms) {
      settleLayer(layer);
      return;
    }
    // 1. the starting pose, without a transition
    sheet.style.transition = 'none';
    backdrop.style.transition = 'none';
    backdrop.style.opacity = '0';
    if (layer.mode === 'sheet') {
      layer.y = (sheet.offsetHeight || 420) + 24;
      sheet.style.transform = 'translate3d(0,' + layer.y + 'px,0)';
    } else {
      sheet.style.transform = DIALOG_FROM;
      sheet.style.opacity = '0';
    }
    // 2. make the browser take note of it (one style flush at open time: the layout is already clean)
    void root.getComputedStyle(sheet).transform;
    void root.getComputedStyle(backdrop).opacity;
    // 3. the resting pose, with a transition
    backdrop.style.transition = 'opacity ' + transitionMs(260) + 'ms ease-out';
    backdrop.style.opacity = '1';
    if (layer.mode === 'sheet') {
      sheet.style.transition = 'transform ' + ms + 'ms ' + EASE_SHEET_IN;
      sheet.style.transform = 'translate3d(0,0,0)';
    } else {
      sheet.style.transition = 'transform ' + ms + 'ms ' + EASE_DIALOG_IN + ', opacity ' + Math.round(ms * 0.55) + 'ms linear';
      sheet.style.transform = 'translate3d(0,0,0)';
      sheet.style.opacity = '1';
    }
    layer.y = 0;
    layer.afterMotion = afterTransform(sheet, ms, () => settleLayer(layer));
  }

  /**
   * Closes. A flick (velocity in px/s, from a drag) keeps its speed on a SOL.Anim spring; everything else is a
   * CSS transition from wherever the panel is right now — also when it is still on its way in.
   */
  function animateOut(layer, velocity) {
    const sheet = layer.sheet;
    const backdrop = layer.backdrop;
    freezeLayer(layer);
    return new Promise((resolve) => {
      const sheetMode = isSheetMode();
      const ms = transitionMs(sheetMode ? 240 : 200);
      if (!ms) {
        resolve();
        return;
      }
      void root.getComputedStyle(backdrop).opacity;
      backdrop.style.transition = 'opacity ' + transitionMs(220) + 'ms linear';
      backdrop.style.opacity = '0';
      if (sheetMode) {
        const height = (sheet.offsetHeight || 420) + 24;
        const from = layer.mode === 'sheet' ? layer.y || 0 : 0;
        sheet.style.opacity = '';
        if (velocity > 300) {
          layer.anim = spring({
            from: from, to: height, velocity: velocity, stiffness: 190, damping: 28, precision: 1,
            update: (v) => setSheetY(layer, v),
            done: resolve,
          });
          // the spring ends by itself; if it is cancelled (it is not, once closing) the timer still resolves
          root.setTimeout(resolve, 1500);
          return;
        }
        void root.getComputedStyle(sheet).transform;
        const part = clamp((height - from) / height, 0.35, 1);
        const t = Math.max(1, Math.round(ms * part));
        sheet.style.transition = 'transform ' + t + 'ms ' + EASE_OUT;
        sheet.style.transform = 'translate3d(0,' + height + 'px,0)';
        layer.afterMotion = afterTransform(sheet, t, resolve);
      } else {
        void root.getComputedStyle(sheet).transform;
        sheet.style.transition = 'transform ' + ms + 'ms ' + EASE_OUT + ', opacity ' + ms + 'ms linear';
        sheet.style.transform = DIALOG_TO;
        sheet.style.opacity = '0';
        layer.afterMotion = afterTransform(sheet, ms, resolve);
      }
    });
  }

  /** Classes the body needs so the browser and the sheet agree on who owns a vertical drag. */
  function updateScrollState(layer, measure) {
    const b = layer.body;
    if (measure) layer.scrollable = b.scrollHeight - b.clientHeight > 1;
    const top = b.scrollTop <= 0;
    b.classList.toggle('is-static', !layer.scrollable);
    b.classList.toggle('at-top', layer.scrollable && top);
    layer.sheet.classList.toggle('is-scrolled', b.scrollTop > 2);
  }

  /**
   * Drag down to dismiss (sheets only). The grab bar and the header always drag; the body drags when it has
   * nothing to scroll, or when it is scrolled to the top and the finger moves down (see touch-action in ui.css).
   */
  /**
   * Downward speed (px/s) at the moment of release: how far the pointer travelled during the last 100 ms
   * before it. A pointer that was moved fast and then held still is not a flick — its speed is 0.
   */
  function releaseVelocity(trail, releaseT) {
    if (!trail || trail.length < 2) return 0;
    const last = trail[trail.length - 1];
    const now = releaseT > last.t ? releaseT : last.t;
    let from = null;
    for (let i = trail.length - 2; i >= 0; i--) {
      if (now - trail[i].t > 100) break;
      from = trail[i];
    }
    if (!from) return 0; // nothing moved in the last 100 ms
    const dt = now - from.t;
    return dt > 0 ? ((last.y - from.y) / dt) * 1000 : 0;
  }

  function attachDrag(layer) {
    const sheet = layer.sheet;
    let drag = null;

    function end(e, cancelled) {
      if (!drag || (e && e.pointerId !== drag.id)) return;
      const d = drag;
      drag = null;
      if (!d.active) return;
      sheet.classList.remove('is-dragging');
      try {
        sheet.releasePointerCapture(d.id);
      } catch (err) {
        /* already released */
      }
      // The gesture was a drag: whatever is under the finger must not also get a click.
      const swallow = (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      root.addEventListener('click', swallow, true);
      root.setTimeout(() => root.removeEventListener('click', swallow, true), 350);

      const height = sheet.offsetHeight || 1;
      const y = layer.y || 0;
      const v = releaseVelocity(d.trail, e && e.timeStamp ? e.timeStamp : 0); // px per second
      // Let go after a deliberate pull (a third of the sheet, 180 px at most — tall sheets must not need more
      // thumb travel than that) or with a flick: it leaves. Anything less springs back.
      const dismiss = !cancelled && layer.spec.dismissible !== false && y > 12 && (y > Math.min(height * 0.32, 180) || v > 650);
      if (dismiss) {
        closeLayer(layer, undefined, { velocity: Math.max(v, 0) });
      } else {
        layer.anim = spring({
          from: y, to: 0, velocity: v, stiffness: 320, damping: 30, precision: 0.4,
          update: (val) => {
            setSheetY(layer, val);
            setDim(layer, 1 - clamp(val / height, 0, 1) * 0.75);
          },
          done: () => {
            layer.anim = null;
            settleLayer(layer);
          },
        });
      }
    }

    sheet.addEventListener('pointerdown', (e) => {
      if (drag || layer.closing || !isSheetMode()) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const t = e.target;
      if (t.closest && t.closest('input, [data-no-drag]')) return;
      const inBody = layer.body.contains(t);
      if (inBody && layer.scrollable && layer.body.scrollTop > 0) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, offset: 0, active: false, trail: [{ t: e.timeStamp, y: e.clientY }] };
    });

    // The panel is closing for another reason (Android back, Esc, a new game) while a finger still holds it:
    // let go, so the finger does not keep dragging a sheet that is on its way out.
    layer.cancelDrag = function () {
      const d = drag;
      drag = null;
      if (!d || !d.active) return;
      sheet.classList.remove('is-dragging');
      try {
        sheet.releasePointerCapture(d.id);
      } catch (err) {
        /* already released */
      }
    };

    sheet.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (layer.closing) {
        layer.cancelDrag();
        return;
      }
      const dy = e.clientY - drag.y;
      const dx = e.clientX - drag.x;
      if (!drag.active) {
        if (dy < -12 || Math.abs(dx) > 24) {
          drag = null; // an upward or sideways gesture is not ours
          return;
        }
        if (dy < 8 || Math.abs(dx) > dy) return;
        drag.active = true;
        // Take the sheet over wherever it is (it may still be sliding in): no jump under the finger.
        layer.mode = 'sheet';
        freezeLayer(layer);
        drag.offset = dy - (layer.y || 0);
        sheet.classList.add('is-dragging');
        layer.dragHeight = sheet.offsetHeight || 1;
        try {
          sheet.setPointerCapture(drag.id);
        } catch (err) {
          /* capture is a nicety */
        }
      }
      // where the pointer has been lately (for the speed at the moment of release)
      drag.trail.push({ t: e.timeStamp, y: e.clientY });
      while (drag.trail.length > 2 && e.timeStamp - drag.trail[0].t > 160) drag.trail.shift();
      let y = dy - drag.offset;
      if (y < 0) y = -Math.pow(-y, 0.6); // pulling up only stretches a little
      setSheetY(layer, y);
      setDim(layer, 1 - clamp(y / layer.dragHeight, 0, 1) * 0.75);
      if (e.cancelable) e.preventDefault();
    });

    sheet.addEventListener('pointerup', (e) => end(e, false));
    sheet.addEventListener('pointercancel', (e) => end(e, true));
    // Only the capture taken above counts. A touch pointer is implicitly captured by the element it went down
    // on; taking the capture over makes THAT element fire lostpointercapture, which bubbles through here.
    sheet.addEventListener('lostpointercapture', (e) => {
      if (e.target === sheet) end(e, true);
    });
  }

  /**
   * Opens a modal layer.
   * spec: { kind, title, header = true, closeButton = true, className, role, dismissible = true, pause = true,
   *         sound = true, returnFocus, initialFocus(layer) -> element, build(layer), onClose(result),
   *         guardMs: how long taps on the new panel are ignored (default: see GUARD_OPEN_MS / GUARD_SELF_MS) }
   */
  function openLayer(spec) {
    const titleId = 'ui-title-' + ++uid;
    const sheet = h('div.ui-sheet' + (spec.className ? '.' + spec.className : ''), {
      role: spec.role || 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1',
    });
    const content = h('div.ui-sheet__content');
    const body = h('div.ui-sheet__body', null, content);
    const backdrop = h('div.ui-backdrop');
    const el = h('div.ui-layer.ui-layer--' + spec.kind, { 'data-kind': spec.kind }, backdrop, sheet);

    const layer = {
      spec: spec, kind: spec.kind, el: el, sheet: sheet, backdrop: backdrop, body: body, content: content,
      titleId: titleId, closing: false, mode: 'sheet', y: 0, anim: null, afterMotion: null, cancelDrag: null,
      scrollable: false, paused: false, cleanup: [], openedAt: nowMs(),
      returnFocus: spec.returnFocus !== undefined ? spec.returnFocus : doc.activeElement,
      removeBack: null, resolveClosed: null, closed: null,
    };
    layer.closed = new Promise((resolve) => {
      layer.resolveClosed = resolve;
    });
    /** Bus subscription that ends with the layer. */
    layer.on = function (event, fn) {
      if (SOL.Bus) layer.cleanup.push(SOL.Bus.on(event, fn));
    };

    sheet.appendChild(h('div.ui-sheet__grab', { 'aria-hidden': 'true' }));
    if (spec.header !== false) {
      const head = h('div.ui-sheet__head', null, h('h2.ui-sheet__title', { id: titleId }, spec.title || ''));
      if (spec.closeButton !== false) {
        head.appendChild(h('button.ui-sheet__close.ui-press', {
          type: 'button', 'aria-label': 'Close', html: icon('close'),
          onclick: () => {
            feedback();
            closeLayer(layer);
          },
        }));
      }
      sheet.appendChild(head);
    }
    sheet.appendChild(body);

    try {
      spec.build(layer);
    } catch (err) {
      report('building the "' + spec.kind + '" panel failed', err);
    }

    // Stray taps (see shield): the second tap of a double tap lands on whatever this panel has just put under
    // the finger, and a panel that comes up by itself (the win screen) slides in under a finger that was aimed
    // at the table. Neither may press anything. Capture phase on the layer: before any button's own handler.
    const opener = lastTap && layer.openedAt - lastTap.t < 120 ? lastTap : null;
    const guardAll = layer.openedAt + (spec.guardMs !== undefined ? spec.guardMs : opener ? GUARD_OPEN_MS : GUARD_SELF_MS);
    const guardNear = opener ? layer.openedAt + GUARD_NEAR_MS : 0;
    el.addEventListener('click', (e) => {
      if (!isPointerClick(e)) return;
      const t = nowMs();
      const near = opener && t < guardNear && Math.abs(e.clientX - opener.x) < GUARD_NEAR_PX && Math.abs(e.clientY - opener.y) < GUARD_NEAR_PX;
      if (t < guardAll || near) {
        e.stopPropagation();
        e.preventDefault();
      }
    }, true);

    backdrop.addEventListener('click', () => {
      if (spec.dismissible !== false) closeLayer(layer);
    });

    // Keys typed inside a panel are the panel's: game shortcuts on the document must not fire through it.
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        const items = focusables(sheet);
        const active = doc.activeElement;
        if (!items.length) {
          e.preventDefault();
          sheet.focus();
        } else if (e.shiftKey && (active === items[0] || active === sheet || !sheet.contains(active))) {
          e.preventDefault();
          items[items.length - 1].focus();
        } else if (!e.shiftKey && (active === items[items.length - 1] || !sheet.contains(active))) {
          e.preventDefault();
          items[0].focus();
        }
      }
      if (e.key !== 'Escape') e.stopPropagation();
    });

    body.addEventListener('scroll', () => updateScrollState(layer, false), { passive: true });
    if (typeof root.ResizeObserver === 'function') {
      const ro = new root.ResizeObserver(() => updateScrollState(layer, true));
      ro.observe(body);
      ro.observe(content);
      layer.cleanup.push(() => ro.disconnect());
    }
    attachDrag(layer);

    overlayRoot.appendChild(el);
    layers.push(layer);
    updateScrollState(layer, true);

    if (spec.pause !== false) {
      layer.paused = true;
      if (pauseDepth++ === 0) callGame('pause', 'modal');
    }
    if (SOL.App && typeof SOL.App.addBackHandler === 'function') {
      layer.removeBack = SOL.App.addBackHandler(() => {
        if (spec.dismissible !== false) closeLayer(layer);
        return true; // even a panel that cannot be dismissed keeps "back" from leaving the app
      });
    }

    let focusTarget = null;
    try {
      focusTarget = spec.initialFocus ? spec.initialFocus(layer) : null;
    } catch (err) {
      focusTarget = null;
    }
    try {
      (focusTarget || sheet).focus({ preventScroll: true });
    } catch (err) {
      /* focus is best effort */
    }

    animateIn(layer);
    if (spec.sound !== false) audio('open');
    return layer;
  }

  /**
   * Closes a layer. The result is delivered (spec.onClose, layer.closed) as soon as the close starts, so
   * whatever the player asked for begins while the panel is still sliding away.
   */
  function closeLayer(layer, result, opts) {
    if (!layer || layer.closing) return;
    const o = opts || {};
    layer.closing = true;
    if (layer.cancelDrag) layer.cancelDrag();
    if (tapJustNow()) shield(); // a tap closed it: its double must not reach what was underneath
    const i = layers.indexOf(layer);
    if (i !== -1) layers.splice(i, 1);
    if (layer.removeBack) layer.removeBack();
    layer.el.classList.add('is-closing');
    layer.sheet.setAttribute('aria-hidden', 'true');
    for (const off of layer.cleanup.splice(0)) {
      try {
        off();
      } catch (err) {
        /* ignore */
      }
    }
    if (layer.paused) {
      layer.paused = false;
      if (--pauseDepth === 0) callGame('resume', 'modal');
    }
    if (!o.keepFocus) {
      const back = layer.returnFocus;
      const inside = layer.el.contains(doc.activeElement) || doc.activeElement === doc.body || !doc.activeElement;
      if (inside) {
        if (back && back.isConnected && typeof back.focus === 'function' && !back.disabled) {
          try {
            back.focus({ preventScroll: true });
          } catch (err) {
            /* ignore */
          }
        } else if (doc.activeElement && typeof doc.activeElement.blur === 'function' && layer.el.contains(doc.activeElement)) {
          doc.activeElement.blur();
        }
      }
    }
    if (layer.spec.sound !== false && !o.silent) audio('close');

    animateOut(layer, o.velocity || 0).then(() => {
      layer.el.remove();
    });

    try {
      if (layer.spec.onClose) layer.spec.onClose(result);
    } catch (err) {
      report('closing the "' + layer.kind + '" panel failed', err);
    }
    layer.resolveClosed(result);

    if (!layers.length && pendingWin && !o.keepPendingWin) {
      const p = pendingWin;
      pendingWin = null;
      if (status.won) showWin(p);
    }
  }

  /** Opens `spec` in place of the layer `prev` (menu -> settings): focus returns to where `prev` came from. */
  function replaceLayer(prev, spec) {
    const next = openLayer(Object.assign({ returnFocus: prev ? prev.returnFocus : undefined }, spec));
    if (prev) closeLayer(prev, undefined, { keepFocus: true, silent: true, keepPendingWin: true });
    return next;
  }

  function closeAll() {
    for (const layer of layers.slice().reverse()) closeLayer(layer, undefined, { keepPendingWin: true });
    pendingWin = null;
  }

  function isOpen() {
    return layers.length > 0;
  }

  function onDocKeydown(e) {
    // A held key repeats. Enter held on "New" would press the confirm button that takes the focus next; held
    // on "Cancel" it would press the button the focus returns to, and open the question again. Only the first
    // press of Enter / Space counts on anything that opens or answers a panel (Undo and Hint may repeat).
    if (e.repeat && (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar')) {
      const t = e.target;
      const ours = t && t.closest && ((overlayRoot && overlayRoot.contains(t)) ||
        (tbRoot && tbRoot.contains(t) && !t.closest('[data-action="undo"], [data-action="hint"]')));
      if (ours && t.closest('button')) e.preventDefault();
      return;
    }
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (inspectorOpen()) return; // the inspector sits above everything of ours and owns Esc
    const top = topLayer();
    if (top) {
      e.preventDefault();
      e.stopPropagation();
      if (top.spec.dismissible !== false) closeLayer(top);
    } else if (stuck.el) {
      e.preventDefault();
      hideStuck(false);
    }
  }

  function onDocFocusIn(e) {
    const top = topLayer();
    if (!top || top.closing || inspectorOpen()) return;
    const t = e.target;
    if (!t || t === doc || t === doc.body || top.el.contains(t)) return;
    if (toastRoot && toastRoot.contains(t)) return;
    try {
      top.sheet.focus({ preventScroll: true });
    } catch (err) {
      /* ignore */
    }
  }

  // ------------------------------------------------------------------ controls

  /** Arrow keys / Home / End inside a radio group (roving tabindex). */
  function radioKeys(group, items, choose) {
    group.addEventListener('keydown', (e) => {
      const cur = items.indexOf(doc.activeElement);
      if (cur === -1) return;
      let next = -1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (cur + 1) % items.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (cur + items.length - 1) % items.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = items.length - 1;
      if (next === -1) return;
      e.preventDefault();
      choose(next);
      items[next].focus();
    });
  }

  function markRadios(items, index) {
    items.forEach((b, i) => {
      b.setAttribute('aria-checked', i === index ? 'true' : 'false');
      b.tabIndex = i === index ? 0 : -1;
    });
  }

  /** { label, options: [{ value, label }], get(), set(value) } -> { el, sync() } */
  function segmented(o) {
    const group = h('div.ui-seg', { role: 'radiogroup', 'aria-label': o.label });
    group.style.setProperty('--n', String(o.options.length));
    group.appendChild(h('span.ui-seg__thumb', { 'aria-hidden': 'true' }));
    const btns = o.options.map((opt, i) => {
      const b = h('button.ui-seg__opt', { type: 'button', role: 'radio', 'data-value': String(opt.value) }, opt.label);
      b.addEventListener('click', () => {
        feedback();
        choose(i);
      });
      group.appendChild(b);
      return b;
    });
    function index() {
      const v = o.get();
      const i = o.options.findIndex((opt) => opt.value === v);
      return i < 0 ? 0 : i;
    }
    function sync() {
      const i = index();
      group.style.setProperty('--i', String(i));
      markRadios(btns, i);
    }
    function choose(i) {
      if (i !== index()) o.set(o.options[i].value);
      sync();
    }
    radioKeys(group, btns, choose);
    sync();
    return { el: group, sync: sync };
  }

  /** { label, hint, icon, get(), set(bool) } -> { el, sync() } */
  function switchRow(o) {
    const hint = o.hint ? h('span.ui-row__hint', null, o.hint) : null;
    const row = h('button.ui-row.ui-press', { type: 'button', role: 'switch', 'data-key': o.key || null },
      o.icon ? h('span.ui-row__icon', { html: icon(o.icon), 'aria-hidden': 'true' }) : null,
      h('span.ui-row__text', null, h('span.ui-row__label', null, o.label), hint),
      h('span.ui-switch', { 'aria-hidden': 'true' }, h('span.ui-switch__thumb')));
    function sync() {
      row.setAttribute('aria-checked', o.get() ? 'true' : 'false');
      if (o.icons) row.querySelector('.ui-row__icon').innerHTML = icon(o.get() ? o.icons[0] : o.icons[1]);
    }
    row.addEventListener('click', () => {
      const next = !o.get();
      o.set(next);
      sync();
      feedback(); // after the change, so "sound on" is heard and "haptics on" is felt
      if (o.after) o.after(next);
    });
    sync();
    return { el: row, sync: sync };
  }

  function field(label, hint, control, note, key) {
    return h('div.ui-field', { 'data-setting': key || null },
      h('div.ui-field__head', null,
        h('span.ui-field__label', null, label),
        hint ? (hint.nodeType ? hint : h('span.ui-field__hint', null, hint)) : null),
      control, note || null);
  }

  function settingBinding(key, fallback) {
    return {
      get: () => sGet(key, fallback),
      set: (v) => sSet(key, v),
    };
  }

  // ------------------------------------------------------------------ gallery / new game / restart

  function openGallery(tab) {
    const insp = SOL.Inspector;
    if (insp && typeof insp.openGallery === 'function') {
      try {
        const p = insp.openGallery({ tab: tab === 'backs' ? 'backs' : 'cards' });
        if (p && typeof p.catch === 'function') p.catch((err) => report('SOL.Inspector.openGallery rejected', err));
        return true;
      } catch (err) {
        report('SOL.Inspector.openGallery threw', err);
      }
    }
    toast('The 3D gallery is not available', { type: 'warn' });
    return false;
  }

  /**
   * Asks the controller for a deal ('newGame' or 'restartDeal') and keeps the New button disabled until that
   * deal has begun. After a win the controller gathers the cards for a moment while its status still reads
   * won + busy — the one state in which New stays enabled — so a second tap would restart the whole thing.
   * Released by 'game:new', by the controller's promise settling either way, or after 10 s at the latest
   * (a button that never comes back would be worse than a double deal).
   */
  function startDeal(method, opts) {
    const token = ++dealToken;
    const release = () => {
      if (token !== dealToken || !dealPending) return;
      dealPending = false;
      root.clearTimeout(dealTimer);
      renderToolbar();
    };
    dealPending = true;
    root.clearTimeout(dealTimer);
    dealTimer = root.setTimeout(release, 10000);
    renderToolbar();
    const out = callGame(method, opts);
    if (out && typeof out.then === 'function') out.then(release, release);
    else release(); // no controller (or a synchronous one): nothing to wait for
  }

  /** The one "New game" flow. Asks only when a started, unfinished game would be abandoned. */
  function newGame(opts) {
    const go = function () {
      closeAll();
      hideStuck(false);
      cancelWin(true);
      startDeal('newGame', opts);
      return true;
    };
    if (!(status.started && !status.won)) return Promise.resolve(go());
    return confirm({
      title: 'Start a new game?',
      message: 'The game in progress will be abandoned and counts as a loss in your statistics.',
      confirmLabel: 'New game',
      cancelLabel: 'Keep playing',
    }).then((ok) => (ok ? go() : false));
  }

  function restartDeal() {
    const go = function () {
      closeAll();
      hideStuck(false);
      cancelWin(true);
      startDeal('restartDeal');
      return true;
    };
    if (!(status.started && !status.won)) return Promise.resolve(go());
    return confirm({
      title: 'Restart this deal?',
      message: 'The same cards are dealt again from the start. The game in progress counts as a loss.',
      confirmLabel: 'Restart',
      cancelLabel: 'Keep playing',
    }).then((ok) => (ok ? go() : false));
  }

  // ------------------------------------------------------------------ install (optional SOL.PWA)

  function pwaCanInstall() {
    const p = SOL.PWA;
    if (!p) return false;
    try {
      return typeof p.canInstall === 'function' ? !!p.canInstall() : !!p.canInstall;
    } catch (err) {
      return false;
    }
  }

  /** Must run inside the tap handler: the browser only shows its install dialog on a user gesture. */
  function pwaInstall() {
    const p = SOL.PWA;
    if (!p || typeof p.promptInstall !== 'function') return;
    try {
      const out = p.promptInstall();
      if (out && typeof out.catch === 'function') out.catch((err) => report('SOL.PWA.promptInstall rejected', err));
    } catch (err) {
      report('SOL.PWA.promptInstall threw', err);
    }
  }

  // ================================================================== menu

  function openMenu() {
    if (!inited) return;
    const open = findLayer('menu');
    if (open) return;
    openLayer({
      kind: 'menu',
      title: 'Menu',
      build: buildMenu,
    });
  }

  /** Three real cards fanned in 3D: the invitation to the gallery. */
  function heroCards(stage) {
    const C = SOL.Cards;
    if (!C || typeof C.create !== 'function') {
      stage.appendChild(h('span.ui-hero__cube', { html: icon('cube') }));
      return;
    }
    // left, right, then the centre card last so it paints on top
    const fan = [
      { id: 25, x: -27, y: 6, rz: -17, ry: 22 }, // king of hearts
      { id: 50, x: 27, y: 6, rz: 17, ry: -22 }, // queen of diamonds
      { id: 0, x: 0, y: -4, rz: 0, ry: 0 }, // ace of spades
    ];
    const els = [];
    for (const f of fan) {
      let card;
      try {
        card = C.create(f.id, { back: sGet('cardBack', 'royal') });
      } catch (err) {
        continue;
      }
      card.setAttribute('aria-hidden', 'true');
      card.style.setProperty('--lift', '0.35');
      stage.appendChild(card);
      els.push({ el: card, f: f });
    }
    const pose = (t) => {
      for (const c of els) {
        const f = c.f;
        c.el.style.transform =
          'translate3d(' + (f.x * t).toFixed(1) + 'px,' + (f.y * t).toFixed(1) + 'px,0) rotateZ(' +
          (f.rz * t).toFixed(1) + 'deg) rotateY(' + (f.ry * t).toFixed(1) + 'deg)';
      }
    };
    pose(0);
    tween({ from: 0, to: 1, duration: 620, delay: 160, ease: 'outBack', update: pose });
  }

  function buildMenu(layer) {
    const c = layer.content;

    const stage = h('span.ui-hero__stage', { 'aria-hidden': 'true' });
    heroCards(stage);
    c.appendChild(h('button.ui-hero.ui-press', {
      type: 'button', 'data-menu': 'gallery',
      onclick: () => {
        feedback();
        closeLayer(layer, undefined, { keepFocus: true });
        openGallery('cards');
      },
    },
      stage,
      h('span.ui-hero__text', null,
        h('span.ui-hero__title', null, '3D card gallery'),
        h('span.ui-hero__sub', null, 'Spin, flip and zoom all 52 cards')),
      h('span.ui-hero__chev', { html: icon('chevron'), 'aria-hidden': 'true' })));

    // the selected back, as a real little card
    const mini = h('span.ui-tile__mini', { 'aria-hidden': 'true' });
    let miniCard = null;
    if (SOL.Cards && typeof SOL.Cards.createBackOnly === 'function') {
      try {
        miniCard = SOL.Cards.createBackOnly(sGet('cardBack', 'royal'));
        miniCard.setAttribute('aria-hidden', 'true');
        mini.appendChild(miniCard);
      } catch (err) {
        miniCard = null;
      }
    }
    const tile = (key, iconName, label, fn, lead) =>
      h('button.ui-tile.ui-press', {
        type: 'button', 'data-menu': key,
        onclick: () => {
          feedback();
          fn();
        },
      }, lead || h('span.ui-tile__icon', { html: icon(iconName), 'aria-hidden': 'true' }), h('span', null, label));

    c.appendChild(h('div.ui-tiles', null,
      tile('backs', 'backs', 'Card backs', () => {
        // The inspector's gallery has the full 3D picker; without it the settings sheet still has one.
        if (SOL.Inspector && typeof SOL.Inspector.openGallery === 'function') {
          closeLayer(layer, undefined, { keepFocus: true });
          openGallery('backs');
        } else {
          replaceLayer(layer, settingsSpec());
        }
      }, miniCard ? mini : null),
      tile('stats', 'stats', 'Statistics', () => replaceLayer(layer, statsSpec())),
      tile('settings', 'settings', 'Settings', () => replaceLayer(layer, settingsSpec())),
      tile('help', 'help', 'How to play', () => replaceLayer(layer, helpSpec()))));

    const sound = switchRow({
      key: 'sound', label: 'Sound', icon: 'soundOn', icons: ['soundOn', 'soundOff'],
      get: () => sGet('sound', true) !== false,
      set: (v) => sSet('sound', v),
    });
    const group = h('div.ui-group', null, sound.el);
    group.appendChild(h('button.ui-row.ui-press', {
      type: 'button', 'data-menu': 'restart',
      onclick: () => {
        feedback();
        restartDeal();
      },
    },
      h('span.ui-row__icon', { html: icon('restart'), 'aria-hidden': 'true' }),
      h('span.ui-row__text', null, h('span.ui-row__label', null, 'Restart this deal'),
        h('span.ui-row__hint', null, 'Play the same cards again')),
      h('span.ui-row__chev', { html: icon('chevron'), 'aria-hidden': 'true' })));

    const install = h('button.ui-row.ui-press', {
      type: 'button', 'data-menu': 'install',
      onclick: () => {
        feedback();
        closeLayer(layer);
        pwaInstall();
      },
    },
      h('span.ui-row__icon', { html: icon('install'), 'aria-hidden': 'true' }),
      h('span.ui-row__text', null, h('span.ui-row__label', null, 'Install app'),
        h('span.ui-row__hint', null, 'Add Solitaire to your home screen')),
      h('span.ui-row__chev', { html: icon('chevron'), 'aria-hidden': 'true' }));
    const syncInstall = () => {
      const can = pwaCanInstall();
      if (can && !install.parentNode) group.appendChild(install);
      else if (!can && install.parentNode) install.remove();
    };
    syncInstall();
    c.appendChild(group);

    layer.on('settings:change', (p) => {
      sound.sync();
      if (miniCard && p && p.key === 'cardBack' && SOL.Cards.setBack) SOL.Cards.setBack(miniCard, p.value);
    });
    layer.on('pwa:change', syncInstall);
  }

  // ================================================================== settings

  function settingsSpec() {
    return { kind: 'settings', title: 'Settings', build: buildSettings };
  }

  function openSettings() {
    if (!inited || findLayer('settings')) return;
    openLayer(settingsSpec());
  }

  function buildSettings(layer) {
    const c = layer.content;
    const syncs = [];
    const add = (control) => {
      syncs.push(control.sync);
      return control.el;
    };

    // ---- game
    const dealNow = h('button.ui-btn.ui-btn--primary.ui-btn--small.ui-press', {
      type: 'button', 'data-settings': 'deal-now', hidden: true,
      onclick: () => {
        feedback();
        newGame({ drawCount: sGet('drawCount', 1) });
      },
    }, 'Deal now');
    const dealText = h('span', null, 'Applies to the next deal.');
    const syncDeal = () => {
      const want = sGet('drawCount', 1);
      const differs = haveStatus && status.drawCount !== want;
      dealNow.hidden = !differs;
      dealText.textContent = differs
        ? 'This game is Draw ' + status.drawCount + '. Draw ' + want + ' starts with the next deal.'
        : 'Applies to the next deal.';
    };
    syncs.push(syncDeal);
    syncDeal();

    c.appendChild(h('h3.ui-sec', null, 'Game'));
    c.appendChild(h('div.ui-group', null,
      field('Draw mode', null, add(segmented({
        label: 'Draw mode',
        options: [{ value: 1, label: 'Draw 1' }, { value: 3, label: 'Draw 3' }],
        get: () => (sGet('drawCount', 1) === 3 ? 3 : 1),
        set: (v) => sSet('drawCount', v),
      })), h('div.ui-field__note', null, dealText, dealNow), 'drawCount'),
      add(switchRow({
        key: 'winnableOnly', label: 'Winnable deals only', hint: 'Every new deal can be solved',
        get: () => !!sGet('winnableOnly', false), set: (v) => sSet('winnableOnly', v),
      })),
      add(switchRow({
        key: 'tapToMove', label: 'Tap to move', hint: 'One tap sends a card to its best spot',
        get: () => sGet('tapToMove', true) !== false, set: (v) => sSet('tapToMove', v),
      })),
      add(switchRow({
        key: 'leftHanded', label: 'Left-handed layout', hint: 'Deck and controls mirrored',
        get: () => !!sGet('leftHanded', false), set: (v) => sSet('leftHanded', v),
      })),
      add(switchRow({
        key: 'showTimer', label: 'Show timer',
        get: () => sGet('showTimer', true) !== false, set: (v) => sSet('showTimer', v),
      })),
      // Only the Android app can hide the system bars (platform.js applies the setting through the shell);
      // in a browser the setting does nothing, so it is not offered there.
      hasSetting('fullscreen') && SOL.Platform && SOL.Platform.isNativeApp
        ? add(switchRow({
          key: 'fullscreen', label: 'Full screen', hint: 'Hide the status and navigation bars',
          get: () => sGet('fullscreen', true) !== false, set: (v) => sSet('fullscreen', v),
        }))
        : null));

    // ---- table
    c.appendChild(h('h3.ui-sec', null, 'Table'));
    c.appendChild(h('div.ui-group', null,
      field('Table theme', null, add(themeSwatches()), null, 'theme'),
      field('Card back', null, add(backPicker()), null, 'cardBack')));

    // ---- motion
    c.appendChild(h('h3.ui-sec', null, 'Motion'));
    c.appendChild(h('div.ui-group', null,
      field('Animation speed', null, add(segmented(Object.assign({
        label: 'Animation speed',
        options: [{ value: 'slow', label: 'Slow' }, { value: 'normal', label: 'Normal' }, { value: 'fast', label: 'Fast' }],
      }, settingBinding('animSpeed', 'normal')))), null, 'animSpeed'),
      field('Reduce motion', 'Auto follows your device', add(segmented(Object.assign({
        label: 'Reduce motion',
        options: [{ value: 'auto', label: 'Auto' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }],
      }, settingBinding('reducedMotion', 'auto')))), null, 'reducedMotion'),
      field('Effects quality', 'Low saves battery', add(segmented(Object.assign({
        label: 'Effects quality',
        options: [{ value: 'high', label: 'High' }, { value: 'low', label: 'Low' }],
      }, settingBinding('effects', 'high')))), null, 'effects')));

    // ---- sound and touch
    const range = h('input.ui-range', { type: 'range', min: '0', max: '100', step: '5', 'aria-label': 'Volume', 'data-key': 'volume' });
    const rangeValue = h('span.ui-range__value', { 'aria-hidden': 'true' });
    const rangeRow = h('div.ui-range-row', null,
      h('span.ui-row__icon', { html: icon('soundOn'), 'aria-hidden': 'true' }), range, rangeValue);
    let lastBlip = 0;
    const syncRange = () => {
      const v = Math.round(clamp(Number(sGet('volume', 0.6)) || 0, 0, 1) * 100);
      if (doc.activeElement !== range || Number(range.value) !== v) range.value = String(v);
      range.style.setProperty('--v', v + '%');
      rangeValue.textContent = v + '%';
      const on = sGet('sound', true) !== false;
      range.disabled = !on;
      rangeRow.classList.toggle('is-off', !on);
    };
    range.addEventListener('input', () => {
      const v = clamp(Number(range.value) / 100, 0, 1);
      sSet('volume', v);
      syncRange();
      const now = root.performance ? root.performance.now() : 0;
      if (now - lastBlip > 110) {
        lastBlip = now;
        audio('place'); // a card sound, so the player hears the level they are choosing
      }
    });
    syncs.push(syncRange);
    syncRange();

    const hapticsOk = !SOL.Haptics || SOL.Haptics.supported !== false;
    c.appendChild(h('h3.ui-sec', null, 'Sound and touch'));
    c.appendChild(h('div.ui-group', null,
      add(switchRow({
        key: 'sound', label: 'Sound',
        get: () => sGet('sound', true) !== false, set: (v) => sSet('sound', v),
      })),
      rangeRow,
      add(switchRow({
        key: 'haptics', label: 'Haptics',
        hint: hapticsOk ? 'Vibration feedback when cards move' : 'This device does not vibrate',
        get: () => sGet('haptics', true) !== false, set: (v) => sSet('haptics', v),
        after: (on) => {
          if (on) haptic('success');
        },
      }))));

    c.appendChild(h('button.ui-btn.ui-btn--block.ui-btn--quiet.ui-reset.ui-press', {
      type: 'button', 'data-settings': 'reset',
      onclick: () => {
        feedback();
        confirm({
          title: 'Reset settings?',
          message: 'Every option goes back to its default. Your statistics and the current game are kept.',
          confirmLabel: 'Reset',
          danger: true,
        }).then((ok) => {
          if (!ok) return;
          try {
            if (SOL.Settings) SOL.Settings.reset();
          } catch (err) {
            report('SOL.Settings.reset threw', err);
          }
          sync();
          toast('Settings reset', { type: 'success' });
        });
      },
    }, h('span', { html: icon('restart'), 'aria-hidden': 'true' }), 'Reset settings'));

    function sync() {
      for (const fn of syncs) fn();
    }
    layer.on('settings:change', sync);
    layer.on('game:status', syncDeal);
    layer.on('game:new', syncDeal);
  }

  function themeSwatches() {
    const themes = (SOL.Settings && SOL.Settings.THEMES) || Object.keys(THEME_NAMES);
    const group = h('div.ui-swatches', { role: 'radiogroup', 'aria-label': 'Table theme' });
    const btns = themes.map((id, i) => {
      const name = THEME_NAMES[id] || id;
      const b = h('button.ui-swatch', { type: 'button', role: 'radio', 'data-value': id, 'aria-label': name },
        h('span.ui-swatch__felt', { 'aria-hidden': 'true' }, h('span.ui-swatch__check', { html: icon('check') })),
        h('span', { 'aria-hidden': 'true' }, name));
      b.addEventListener('click', () => {
        feedback();
        choose(i);
      });
      group.appendChild(b);
      return b;
    });
    function sync() {
      markRadios(btns, Math.max(0, themes.indexOf(sGet('theme', 'emerald'))));
    }
    function choose(i) {
      sSet('theme', themes[i]);
      sync();
    }
    radioKeys(group, btns, choose);
    sync();
    return { el: group, sync: sync };
  }

  /** The six backs as real cards (SOL.Cards.createBackOnly); the chosen one spins once in 3D. */
  function backPicker() {
    const C = SOL.Cards;
    const backs = (C && C.BACKS) || [
      { id: 'royal', name: 'Royal' }, { id: 'aurora', name: 'Aurora' }, { id: 'ember', name: 'Ember' },
      { id: 'lattice', name: 'Lattice' }, { id: 'petal', name: 'Petal' }, { id: 'mono', name: 'Mono' },
    ];
    const group = h('div.ui-backs', { role: 'radiogroup', 'aria-label': 'Card back' });
    const cards = [];
    const stages = [];
    const canCreate = !!C && typeof C.createBackOnly === 'function';
    const btns = backs.map((back, i) => {
      const stage = h('span.ui-back__stage', { 'aria-hidden': 'true' });
      if (!canCreate) stage.appendChild(h('span.ui-back__fallback'));
      stage.appendChild(h('span.ui-back__check', { html: icon('check') }));
      cards.push(null);
      stages.push(stage);
      const b = h('button.ui-back', { type: 'button', role: 'radio', 'data-value': back.id, 'aria-label': back.name },
        stage, h('span', { 'aria-hidden': 'true' }, back.name));
      b.addEventListener('click', () => {
        feedback();
        choose(i, true);
      });
      group.appendChild(b);
      return b;
    });
    // The six real cards are the most expensive thing in the settings sheet (measured: about a third of its
    // first build). They are put in one frame later, when the sheet is already on its way up — its transition
    // runs on the compositor and does not wait for them; on a phone they are below the fold anyway.
    const fill = function () {
      backs.forEach((back, i) => {
        if (cards[i]) return;
        try {
          const card = C.createBackOnly(back.id);
          card.setAttribute('aria-hidden', 'true');
          stages[i].insertBefore(card, stages[i].firstChild);
          cards[i] = card;
        } catch (err) {
          stages[i].insertBefore(h('span.ui-back__fallback'), stages[i].firstChild);
        }
      });
    };
    if (canCreate) {
      if (typeof root.requestAnimationFrame === 'function' && !reducedMotion()) root.requestAnimationFrame(fill);
      else fill();
    }
    let spin = null;
    function index() {
      const id = sGet('cardBack', 'royal');
      const i = backs.findIndex((b) => b.id === id);
      return i < 0 ? 0 : i;
    }
    function sync() {
      markRadios(btns, index());
    }
    function choose(i, flourish) {
      sSet('cardBack', backs[i].id);
      sync();
      const card = cards[i];
      if (!flourish || !card) return;
      if (spin) spin.finish();
      card.style.setProperty('--shadow-o', '0');
      spin = tween({
        from: 0, to: 1, duration: 720, ease: 'outCubic',
        update: (t) => {
          const hop = Math.sin(Math.PI * t);
          card.style.transform =
            'translate3d(0,' + (-7 * hop).toFixed(1) + 'px,0) rotateY(' + (360 * t).toFixed(1) + 'deg) scale(' +
            (1 + 0.1 * hop).toFixed(3) + ')';
        },
        done: () => {
          card.style.transform = '';
          card.style.removeProperty('--shadow-o');
          spin = null;
        },
      });
    }
    radioKeys(group, btns, (i) => choose(i, true));
    sync();
    return { el: group, sync: sync };
  }

  // ================================================================== statistics

  function statsSpec() {
    return { kind: 'stats', title: 'Statistics', build: buildStats };
  }

  function openStats() {
    if (!inited || findLayer('stats')) return;
    openLayer(statsSpec());
  }

  function summary(mode) {
    const zero = {
      played: 0, won: 0, bestScore: 0, bestTimeMs: 0, totalTimeMs: 0, totalMoves: 0, currentStreak: 0,
      bestStreak: 0, winRate: 0, avgTimeMs: 0, avgMoves: 0,
    };
    try {
      return SOL.Stats ? Object.assign(zero, SOL.Stats.summary(mode)) : zero;
    } catch (err) {
      return zero;
    }
  }

  function buildStats(layer) {
    const c = layer.content;
    let mode = (haveStatus ? status.drawCount : sGet('drawCount', 1)) === 3 ? 3 : 1;

    const figure = (key, label, iconName, big) => {
      const value = h('span.ui-fig__value', { 'data-stat': key }, '0');
      const el = h('div.ui-fig' + (big ? '.ui-fig--big' : ''), null,
        iconName ? h('span.ui-fig__icon', { html: icon(iconName), 'aria-hidden': 'true' }) : null,
        h('span.ui-fig__label', null, label), value);
      return { el: el, value: value };
    };
    const setFig = (fig, text) => {
      fig.value.textContent = text === null ? '—' : text;
      fig.value.classList.toggle('is-none', text === null);
      // Long values (an hour-long best time, a five-digit score on a 320px phone) step down in size; ui.css
      // cuts anything longer still with an ellipsis instead of letting it spill out of its box.
      const len = text === null ? 0 : text.length;
      fig.value.setAttribute('data-len', len > 9 ? 'xl' : len > 6 ? 'l' : len > 5 ? 'm' : 's');
    };

    const seg = segmented({
      label: 'Draw mode',
      options: [{ value: 1, label: 'Draw 1' }, { value: 3, label: 'Draw 3' }],
      get: () => mode,
      set: (v) => {
        mode = v;
        render(true);
      },
    });
    c.appendChild(h('div', { 'data-stats': 'mode' }, seg.el));

    const bar = doc.createElementNS('http://www.w3.org/2000/svg', 'circle');
    const ring = h('div.ui-ring', { role: 'img' });
    ring.innerHTML =
      '<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">' +
      '<circle class="ui-ring__track" cx="50" cy="50" r="' + RING_R + '"/></svg>';
    bar.setAttribute('class', 'ui-ring__bar');
    bar.setAttribute('cx', '50');
    bar.setAttribute('cy', '50');
    bar.setAttribute('r', String(RING_R));
    bar.setAttribute('stroke-dasharray', RING_C.toFixed(2) + ' ' + RING_C.toFixed(2));
    ring.firstChild.appendChild(bar);
    const pct = h('span', null, '0');
    ring.appendChild(h('div.ui-ring__text', { 'aria-hidden': 'true' },
      h('span.ui-ring__pct', { 'data-stat': 'winRate' }, pct, h('small', null, '%')),
      h('span.ui-ring__cap', null, 'Win rate')));

    const played = figure('played', 'Played', null, true);
    const won = figure('won', 'Won', null, true);
    c.appendChild(h('div.ui-stats__top', null, ring, h('div.ui-stats__sum', null, played.el, won.el)));

    const bestScore = figure('bestScore', 'Best score', 'star');
    const bestTime = figure('bestTime', 'Best time', 'clock');
    const curStreak = figure('currentStreak', 'Win streak', 'flame');
    const bestStreak = figure('bestStreak', 'Best streak', 'trophy');
    const avgTime = figure('avgTime', 'Average time', 'clock');
    const avgMoves = figure('avgMoves', 'Average moves', 'moves');
    c.appendChild(h('div.ui-stats__grid', null,
      bestScore.el, bestTime.el, curStreak.el, bestStreak.el, avgTime.el, avgMoves.el));

    const empty = h('p.ui-stats__empty', null, 'No games played in this mode yet. Your records will appear here.');
    c.appendChild(empty);

    const reset = h('button.ui-btn.ui-btn--block.ui-btn--quiet.ui-reset.ui-press', {
      type: 'button', 'data-stats': 'reset',
      onclick: () => {
        feedback();
        confirm({
          title: 'Reset statistics?',
          message: 'Games played, records and streaks for both draw modes are erased. This cannot be undone.',
          confirmLabel: 'Reset',
          danger: true,
        }).then((ok) => {
          if (!ok) return;
          try {
            if (SOL.Stats) SOL.Stats.reset();
          } catch (err) {
            report('SOL.Stats.reset threw', err);
          }
          render(true);
          toast('Statistics reset', { type: 'success' });
        });
      },
    }, h('span', { html: icon('restart'), 'aria-hidden': 'true' }), 'Reset statistics');
    c.appendChild(reset);

    let ringValue = 0;
    let ringAnim = null;
    const drawRing = (v) => {
      ringValue = v;
      bar.setAttribute('stroke-dashoffset', (RING_C * (1 - clamp(v, 0, 1))).toFixed(2));
      bar.style.opacity = v > 0.004 ? '1' : '0';
      pct.textContent = String(Math.round(v * 100));
    };
    drawRing(0);

    function render(animate) {
      const s = summary(mode);
      s.winRate = clamp(Number(s.winRate) || 0, 0, 1); // a damaged stats record may hold more wins than games
      setFig(played, fmtInt(s.played));
      setFig(won, fmtInt(s.won));
      setFig(bestScore, s.won > 0 ? fmtInt(s.bestScore) : null);
      setFig(bestTime, s.bestTimeMs > 0 ? fmtTime(s.bestTimeMs) : null);
      setFig(curStreak, fmtInt(s.currentStreak));
      setFig(bestStreak, fmtInt(s.bestStreak));
      setFig(avgTime, s.won > 0 ? fmtTime(s.avgTimeMs) : null);
      setFig(avgMoves, s.won > 0 ? fmtInt(s.avgMoves) : null);
      ring.setAttribute('aria-label', 'Win rate ' + Math.round(s.winRate * 100) + ' percent');
      empty.hidden = s.played > 0;
      const other = summary(mode === 3 ? 1 : 3);
      reset.disabled = s.played + other.played === 0;
      if (ringAnim) ringAnim.cancel();
      if (animate) {
        ringAnim = tween({ from: ringValue, to: s.winRate, duration: 850, delay: 120, ease: 'outCubic', update: drawRing });
      } else {
        drawRing(s.winRate);
      }
    }

    render(true);
    layer.on('stats:change', () => render(true));
    layer.cleanup.push(() => {
      if (ringAnim) ringAnim.cancel();
    });
  }

  // ================================================================== how to play

  function helpSpec() {
    return { kind: 'help', title: 'How to play', build: buildHelp };
  }

  function openHelp() {
    if (!inited || findLayer('help')) return;
    openLayer(helpSpec());
  }

  function buildHelp(layer) {
    const c = layer.content;
    c.classList.add('ui-help');
    const C = SOL.Cards;
    let suits = '';
    if (C && typeof C.suitSvg === 'function') {
      try {
        suits = [0, 1, 3, 2].map((s) => C.suitSvg(s, { size: 20 })).join('');
      } catch (err) {
        suits = '';
      }
    }
    const gest = (iconName, title, text, hero) =>
      h('div.ui-gest' + (hero ? '.ui-gest--hero' : ''), null,
        h('span.ui-gest__icon', { html: icon(iconName), 'aria-hidden': 'true' }),
        h('span.ui-gest__text', null, h('b', null, title), text));

    c.appendChild(h('h3.ui-sec', null, 'Goal'));
    c.appendChild(h('div.ui-help__card.ui-help__goal', null,
      suits ? h('span.ui-help__suits', { html: suits, 'aria-hidden': 'true' }) : null,
      h('p', { html: 'Build all four suits on the foundations, from <b>Ace</b> up to <b>King</b>.' })));

    c.appendChild(h('h3.ui-sec', null, 'Rules'));
    c.appendChild(h('div.ui-help__card', null, h('ul.ui-help__rules', {
      html:
        '<li>In the columns, build <b>down</b> in <b>alternating colours</b>: a red 6 goes on a black 7.</li>' +
        '<li>Move a single card or a whole run of face-up cards.</li>' +
        '<li>Only a <b>King</b> (or a run that starts with one) can fill an empty column.</li>' +
        '<li>Tap the deck to draw. When it runs out, tap it again to turn the pile over.</li>' +
        '<li>A foundation card can come back to the columns if you need it.</li>',
    })));

    c.appendChild(h('h3.ui-sec', null, 'Touch controls'));
    c.appendChild(h('div.ui-group', null,
      gest('press', '3D card preview', 'Touch and hold any face-up card to pick it up in 3D: turn it with your finger, flip it over, pinch to zoom.', true),
      gest('cube', '3D cards button', 'Opens the whole deck as a 3D gallery, and the card backs to choose from.'),
      gest('tap', 'Tap a card', 'It flies to the best place it can go. Turn off "Tap to move" in Settings to use a double tap instead.'),
      gest('drag', 'Drag', 'Move a card or a run yourself. Legal places light up while you drag.'),
      gest('deck', 'Tap the deck', 'Draws one or three cards, depending on the draw mode.'),
      gest('auto', 'Auto-complete', 'Appears when every card is face-up and finishes the game for you.')));

    c.appendChild(h('h3.ui-sec', null, 'Scoring'));
    const rows = [
      ['Card to a foundation', '+10', ''],
      ['Deck card to a column', '+5', ''],
      ['Turn over a column card', '+5', ''],
      ['Foundation card back to a column', '−15', 'is-minus'],
      ['Turn the deck over (Draw 1)', '−100', 'is-minus'],
      ['Turn the deck over (Draw 3, from the 4th pass)', '−20', 'is-minus'],
      ['Time bonus for a win (games of 30 seconds or more)', '700,000 ÷ seconds', 'is-gold'],
    ];
    const list = h('ul.ui-scores');
    for (const r of rows) list.appendChild(h('li', null, h('span', null, r[0]), h('b' + (r[2] ? '.' + r[2] : ''), null, r[1])));
    c.appendChild(h('div.ui-group', null, list));

    if (SOL.Platform ? SOL.Platform.canHover : mq('(hover: hover) and (pointer: fine)')) {
      c.appendChild(h('h3.ui-sec', null, 'Keyboard and mouse'));
      const keys = [
        ['Space', 'Draw from the deck'], ['U', 'Undo (also Ctrl+Z)'], ['H', 'Hint'], ['N', 'New game'],
        ['A', 'Auto-complete'], ['I', '3D preview of the card under the pointer'],
        ['Right-click', '3D preview of a card'], ['Esc', 'Close a panel'],
      ];
      const grid = h('div.ui-keys');
      for (const k of keys) {
        grid.appendChild(h('span.ui-keys__k', null, h('kbd', null, k[0])));
        grid.appendChild(h('span', null, k[1]));
      }
      c.appendChild(h('div.ui-group', null, grid));
    }

    c.appendChild(h('div.ui-actions', null,
      h('button.ui-btn.ui-btn--primary.ui-press', {
        type: 'button', 'data-help': 'gallery',
        onclick: () => {
          feedback();
          closeLayer(layer, undefined, { keepFocus: true });
          openGallery('cards');
        },
      }, h('span', { html: icon('cube'), 'aria-hidden': 'true' }), 'Open the 3D gallery')));
  }

  // ================================================================== confirm

  function confirm(opts) {
    const o = opts || {};
    if (!inited) return Promise.resolve(false);
    return new Promise((resolve) => {
      let confirmBtn = null;
      let cancelBtn = null;
      openLayer({
        kind: 'confirm',
        className: 'ui-sheet--compact',
        role: 'alertdialog',
        title: o.title || 'Are you sure?',
        closeButton: false,
        // A destructive question starts on the safe answer.
        initialFocus: () => (o.danger ? cancelBtn : confirmBtn),
        build: (layer) => {
          if (o.message) {
            const msg = h('p.ui-confirm__msg', { id: layer.titleId + '-msg' }, o.message);
            layer.sheet.setAttribute('aria-describedby', msg.id);
            layer.content.appendChild(msg);
          }
          cancelBtn = h('button.ui-btn.ui-press', {
            type: 'button', 'data-confirm': 'cancel',
            onclick: () => {
              feedback();
              closeLayer(layer, false);
            },
          }, o.cancelLabel || 'Cancel');
          confirmBtn = h('button.ui-btn.ui-press.' + (o.danger ? 'ui-btn--danger' : 'ui-btn--primary'), {
            type: 'button', 'data-confirm': 'ok',
            onclick: () => {
              feedback();
              closeLayer(layer, true);
            },
          }, o.confirmLabel || 'OK');
          layer.content.appendChild(h('div.ui-actions', null, cancelBtn, confirmBtn));
        },
        onClose: (result) => resolve(result === true),
      });
    });
  }

  // ================================================================== win screen

  function cancelWin(closeOpen) {
    winToken++;
    root.clearTimeout(winCap);
    winCap = 0;
    if (winWait && typeof winWait.cancel === 'function') winWait.cancel();
    winWait = null;
    pendingWin = null;
    if (closeOpen) {
      const open = findLayer('win');
      if (open) closeLayer(open, undefined, { silent: true });
    }
  }

  function onWon(payload) {
    cancelWin(true);
    status.won = true;
    hideStuck(false);
    const token = winToken;
    let shown = false;
    const show = () => {
      if (shown || token !== winToken) return; // already up, or a new game / an undo cancelled it
      shown = true;
      root.clearTimeout(winCap);
      winCap = 0;
      // Another panel is in the way (the player opened the menu during the celebration): show it afterwards.
      if (layers.length) pendingWin = payload;
      else showWin(payload);
    };
    // The normal path: SOL.Anim time, so the delay follows the speed setting and is immediate under reduced
    // motion. SOL.Anim counts at most 50 ms per frame; when the celebration makes frames longer than that, its
    // clock falls behind real time — the timer below is the upper bound (also scaled by the speed setting).
    const w = wait(WIN_DELAY_MS);
    winWait = w;
    w.then((ok) => {
      if (winWait === w) winWait = null;
      if (ok !== false) show();
    });
    const speed = SOL.Anim && SOL.Anim.speed > 0 ? SOL.Anim.speed : 1;
    winCap = root.setTimeout(() => {
      if (winWait === w && typeof w.cancel === 'function') w.cancel();
      show();
    }, WIN_DELAY_CAP_MS / speed);
  }

  function showWin(payload) {
    if (!inited) return;
    const p = payload || {};
    const score = Math.max(0, Math.round(Number(p.score) || 0));
    const bonus = Math.max(0, Math.round(Number(p.bonus) || 0));
    const total = Number.isFinite(Number(p.total)) ? Math.round(Number(p.total)) : score + bonus;
    const drawCount = p.drawCount === 3 ? 3 : p.drawCount === 1 ? 1 : status.drawCount;
    const existing = findLayer('win');
    if (existing) closeLayer(existing, undefined, { silent: true, keepFocus: true });

    let els = null;
    const layer = openLayer({
      kind: 'win',
      className: 'ui-sheet--win',
      header: false,
      // It comes up by itself, while the player may be tapping the table to hurry the celebration along: taps
      // on it count only once it has arrived.
      guardMs: 600,
      build: (ly) => {
        const c = ly.content;
        c.classList.add('ui-win');
        let suits = '';
        if (SOL.Cards && typeof SOL.Cards.suitSvg === 'function') {
          try {
            suits = [0, 1, 2, 3].map((s) => SOL.Cards.suitSvg(s, { size: 15 })).join('');
          } catch (err) {
            suits = '';
          }
        }
        const totalEl = h('div.ui-win__total', { 'data-win': 'total', 'aria-hidden': 'true' }, '0');
        const base = h('span.ui-win__part', { 'data-win': 'score' }, h('small', null, 'Score'), fmtInt(score));
        const plus = h('span.ui-win__plus', { 'aria-hidden': 'true' }, '+');
        const bonusEl = h('span.ui-win__part.ui-win__part--bonus', { 'data-win': 'bonus' }, h('small', null, 'Time bonus'), fmtInt(bonus));
        const badges = h('div.ui-win__badges');
        if (p.isBestScore) badges.appendChild(h('span.ui-win__badge', { 'data-win': 'best-score' }, h('span', { html: icon('trophy'), 'aria-hidden': 'true' }), 'New best score'));
        if (p.isBestTime) badges.appendChild(h('span.ui-win__badge', { 'data-win': 'best-time' }, h('span', { html: icon('clock'), 'aria-hidden': 'true' }), 'Best time'));
        const fig = (label, value, key) =>
          h('div.ui-fig', null, h('span.ui-fig__label', null, label), h('span.ui-fig__value', { 'data-win': key }, value));

        // Two blocks, so a phone on its side can put them next to each other (see ui.css).
        const main = h('div.ui-win__main', null,
          suits ? h('div.ui-win__suits', { html: suits, 'aria-hidden': 'true' }) : null,
          h('h2.ui-win__title', { id: ly.titleId }, 'You won!'),
          totalEl,
          h('div.ui-win__cap', { 'aria-hidden': 'true' }, 'Final score'),
          h('p.visually-hidden', null,
            'Final score ' + total + (bonus > 0 ? ', including a time bonus of ' + bonus : '') + '.'),
          bonus > 0 ? h('div.ui-win__sum', null, base, plus, bonusEl) : null,
          badges);
        const side = h('div.ui-win__side');
        c.appendChild(main);
        c.appendChild(side);
        side.appendChild(h('div.ui-win__facts', null,
          fig('Time', fmtTime(p.elapsedMs), 'time'),
          fig('Moves', fmtInt(p.moves), 'moves'),
          fig('Mode', 'Draw ' + drawCount, 'mode')));
        side.appendChild(h('div.ui-win__actions', null,
          h('button.ui-btn.ui-btn--primary.ui-press', {
            type: 'button', 'data-win': 'new',
            onclick: () => {
              feedback();
              closeLayer(ly, undefined, { silent: true });
              newGame();
            },
          }, h('span', { html: icon('newgame'), 'aria-hidden': 'true' }), 'New game'),
          h('button.ui-btn.ui-press', {
            type: 'button', 'data-win': 'stats',
            onclick: () => {
              feedback();
              openLayer(statsSpec()); // stacked: closing it comes back here
            },
          }, 'Statistics'),
          h('button.ui-btn.ui-press', {
            type: 'button', 'data-win': 'watch',
            onclick: () => {
              feedback();
              closeLayer(ly);
            },
          }, 'Watch the cards')));
        els = { total: totalEl, plus: plus, bonus: bonusEl, badges: Array.prototype.slice.call(badges.children) };
      },
    });
    if (els) runWinSequence(layer, els, score, bonus, total);
  }

  /** Score counts up, the time bonus lands with a flourish, the total counts on, record badges pop in. */
  function runWinSequence(layer, els, score, bonus, total) {
    const alive = () => !layer.closing;
    const motions = [];
    layer.cleanup.push(() => motions.forEach((m) => m.cancel()));
    const track = (handle) => {
      motions.push(handle);
      return handle.finished;
    };
    let lastTick = 0;
    const count = (from, to, duration, ticks) =>
      track(tween({
        from: from, to: to, duration: duration, ease: 'outCubic',
        update: (v, raw) => {
          els.total.textContent = fmtInt(v);
          const now = root.performance ? root.performance.now() : 0;
          if (ticks && raw < 1 && now - lastTick > 75) {
            lastTick = now;
            audio('tick', { pitch: 0.9 + raw * 0.9, volume: 0.6 });
          }
        },
      }));
    const pop = (el, kick) =>
      track(spring({
        from: 0, to: 1, stiffness: 300, damping: kick ? 13 : 17, precision: 0.002,
        update: (v) => {
          el.style.opacity = String(clamp(v * 1.8, 0, 1));
          el.style.transform = 'scale(' + (0.4 + 0.6 * v).toFixed(3) + ')';
        },
      }));

    (async function () {
      await wait(260);
      if (!alive()) return;
      await count(0, score, bonus > 0 ? 650 : 1100, true);
      if (!alive()) return;
      if (bonus > 0) {
        await wait(220);
        if (!alive()) return;
        els.plus.style.opacity = '1';
        haptic('success');
        try {
          if (SOL.Audio && typeof SOL.Audio.playFoundation === 'function') SOL.Audio.playFoundation(13);
        } catch (err) {
          /* ignore */
        }
        pop(els.bonus, true);
        await wait(380);
        if (!alive()) return;
        await count(score, total, 1200, true);
        if (!alive()) return;
      }
      els.total.textContent = fmtInt(total);
      els.total.classList.add('is-flash');
      track(tween({
        from: 0, to: 1, duration: 420, ease: 'outCubic',
        update: (t) => {
          els.total.style.transform = 'scale(' + (1 + 0.16 * Math.sin(Math.PI * t)).toFixed(3) + ')';
        },
      }));
      for (const badge of els.badges) {
        await wait(170);
        if (!alive()) return;
        haptic('tick');
        audio('hint', { volume: 0.5 });
        pop(badge, true);
      }
    })().catch((err) => report('win sequence failed', err));
  }

  // ================================================================== "no more moves" card

  /**
   * The card sits on top of the toolbar and offers Undo / New game itself. While it does, the toolbar below is
   * inert (no focus, no taps through the card's rounded corners) and faded out, so nothing of it — a focus
   * ring, a pressed state — shows around the card's edges.
   */
  function coverToolbar(covered) {
    if (!tb.box) return;
    tb.box.classList.toggle('is-covered', covered);
    if (covered) tb.box.setAttribute('inert', '');
    else tb.box.removeAttribute('inert');
  }

  function applyStuckT(el, t) {
    el.style.opacity = String(clamp(t * 1.6, 0, 1));
    el.style.transform = 'translate3d(0,' + ((1 - t) * 70).toFixed(1) + 'px,0) scale(' + (0.94 + 0.06 * t).toFixed(3) + ')';
  }

  function showStuck() {
    if (!inited || stuck.el || stuck.muted || status.won) return;
    const undoBtn = h('button.ui-btn.ui-press', {
      type: 'button', 'data-stuck': 'undo', disabled: !status.canUndo,
      onclick: () => {
        feedback();
        if (tapJustNow()) shield(); // the toolbar's own Undo sits right under this button
        hideStuck(false);
        callGame('undo');
      },
    }, 'Undo');
    const el = h('div.ui-stuck', { role: 'status', 'aria-label': 'No more moves' },
      h('div.ui-stuck__head', null,
        h('span.ui-stuck__icon', { html: icon('info'), 'aria-hidden': 'true' }),
        h('span.ui-stuck__title', null, 'No more moves')),
      h('div.ui-stuck__btns', null,
        undoBtn,
        h('button.ui-btn.ui-btn--primary.ui-press', {
          type: 'button', 'data-stuck': 'new',
          onclick: () => {
            feedback();
            if (tapJustNow()) shield();
            hideStuck(false);
            // The card itself was the question: a stuck game is dealt over without another confirm.
            closeAll();
            cancelWin(true);
            startDeal('newGame');
          },
        }, 'New game'),
        h('button.ui-btn.ui-btn--quiet.ui-press', {
          type: 'button', 'data-stuck': 'keep',
          onclick: () => {
            feedback();
            if (tapJustNow()) shield();
            hideStuck(true);
          },
        }, 'Keep looking')));
    stuck.el = el;
    stuck.fresh = true;
    Promise.resolve().then(() => {
      stuck.fresh = false;
    });
    overlayRoot.insertBefore(el, overlayRoot.firstChild);
    coverToolbar(true);
    if (toastRoot) toastRoot.classList.add('has-stuck');
    layoutToasts();
    applyStuckT(el, 0);
    stuck.anim = spring({ from: 0, to: 1, stiffness: 260, damping: 20, precision: 0.002, update: (v) => applyStuckT(el, v) });
    // No SOL.App back handler on purpose: the card is not modal and the player keeps dragging cards while it
    // shows. platform.js drops the edge gesture-exclusion strips while any back handler is registered, so one
    // here would hand every drag that starts at the screen edge to the system's Back gesture.
    haptic('thud');
  }

  /** mute = true: the player wants to keep looking; stay quiet until the next deal. */
  function hideStuck(mute) {
    if (mute) stuck.muted = true;
    const el = stuck.el;
    if (!el) return;
    stuck.el = null;
    if (stuck.anim) stuck.anim.cancel();
    coverToolbar(false);
    if (toastRoot) toastRoot.classList.remove('has-stuck');
    layoutToasts();
    el.style.pointerEvents = 'none';
    stuck.anim = tween({
      from: 1, to: 0, duration: 200, ease: 'inCubic',
      update: (v) => applyStuckT(el, v),
      done: () => el.remove(),
    });
  }

  // ================================================================== toasts

  /** Newest at the bottom; older ones are pushed up by the height of everything newer. */
  function layoutToasts() {
    let offset = 0;
    for (let i = toasts.length - 1; i >= 0; i--) {
      const t = toasts[i];
      t.node.style.transform = 'translate3d(-50%,' + -offset + 'px,0)';
      offset += t.height + 8;
    }
  }

  function dismissToast(t) {
    if (t.gone) return;
    t.gone = true;
    root.clearTimeout(t.timer);
    const i = toasts.indexOf(t);
    if (i !== -1) toasts.splice(i, 1);
    t.node.classList.add('is-leaving');
    const remove = () => t.node.remove();
    t.node.addEventListener('animationend', remove);
    root.setTimeout(remove, 400);
    layoutToasts();
  }

  function armToast(t, duration) {
    root.clearTimeout(t.timer);
    if (duration > 0 && isFinite(duration)) t.timer = root.setTimeout(() => dismissToast(t), duration);
  }

  function toast(message, opts) {
    const o = opts || {};
    const noop = { dismiss() {} };
    if (!inited || !toastRoot || message === null || message === undefined) return noop;
    const text = String(message);
    const type = ['info', 'success', 'warn', 'error'].indexOf(o.type) !== -1 ? o.type : 'info';
    const duration = o.duration === undefined ? 2600 : Number(o.duration) || 0;

    const same = toasts.find((t) => t.text === text && t.type === type);
    if (same) {
      armToast(same, duration);
      same.node.classList.remove('is-bump');
      root.requestAnimationFrame(() => same.node.classList.add('is-bump'));
      return same.api;
    }

    const iconName = type === 'success' ? 'check' : type === 'warn' ? 'warn' : type === 'error' ? 'error' : 'info';
    const card = h('div.ui-toast__card', null,
      h('span.ui-toast__icon', { html: icon(iconName), 'aria-hidden': 'true' }),
      h('span.ui-toast__msg', null, text));
    const node = h('div.ui-toast.ui-toast--' + type, { 'data-type': type }, card);
    const t = { node: node, text: text, type: type, height: 44, timer: 0, gone: false, api: null };
    t.api = { dismiss: () => dismissToast(t) };
    card.addEventListener('click', () => dismissToast(t));
    card.addEventListener('animationend', (e) => {
      if (e.animationName === 'ui-toast-bump') node.classList.remove('is-bump');
    });
    toastRoot.appendChild(node);
    t.height = node.offsetHeight || 44;
    toasts.push(t);
    while (toasts.length > TOAST_MAX) dismissToast(toasts[0]);
    layoutToasts();
    armToast(t, duration);
    return t.api;
  }

  // ================================================================== wiring

  function onSettingsChange(p) {
    const key = p && p.key;
    if (key === 'showTimer' || !key) renderTimerVisibility();
    if (key === 'drawCount' && !haveStatus) {
      renderDraw(p.value);
      fitHud(false);
    }
  }

  function init() {
    if (inited) return UI;
    hudRoot = doc.getElementById('hud');
    tbRoot = doc.getElementById('toolbar');
    overlayRoot = doc.getElementById('overlay-root');
    toastRoot = doc.getElementById('toast-root');
    if (!hudRoot || !tbRoot || !overlayRoot || !toastRoot) {
      report('mount points missing (#hud, #toolbar, #overlay-root, #toast-root)', null);
      return UI;
    }
    inited = true;

    buildHud();
    buildToolbar();
    renderTimerVisibility();

    tbRoot.addEventListener('pointerdown', onPressDown);
    overlayRoot.addEventListener('pointerdown', onPressDown);
    doc.addEventListener('keydown', onDocKeydown, true);
    doc.addEventListener('focusin', onDocFocusIn);
    doc.addEventListener('click', noteClick, true);
    // Long-press must never bring up a browser menu on the app's chrome.
    for (const el of [hudRoot, tbRoot, overlayRoot, toastRoot]) {
      el.addEventListener('contextmenu', (e) => {
        if (e.pointerType !== 'mouse') e.preventDefault();
      });
    }

    const bus = SOL.Bus;
    if (bus) {
      bus.on('game:status', (s) => applyStatus(s, false));
      bus.on('game:new', () => {
        dealPending = false; // the deal that was asked for (if any) has begun
        root.clearTimeout(dealTimer);
        quietNext = true;
        stuck.muted = false;
        hideStuck(false);
        cancelWin(true);
        const s = readStatus();
        if (s) applyStatus(s, true);
      });
      bus.on('game:tick', (p) => {
        if (p && typeof p.elapsedMs === 'number') {
          status.elapsedMs = p.elapsedMs;
          renderTime(p.elapsedMs);
          fitHud(false);
        }
      });
      bus.on('game:change', () => {
        if (stuck.el && !stuck.fresh) hideStuck(false);
      });
      bus.on('game:busy', (p) => {
        if (!p) return;
        status.busy = !!p.busy;
        renderToolbar();
      });
      bus.on('game:won', onWon);
      bus.on('game:stuck', showStuck);
      bus.on('settings:change', onSettingsChange);
    }

    applyStatus(readStatus(), true);
    return UI;
  }

  const UI = {
    init: init,
    openMenu: openMenu,
    openSettings: openSettings,
    openStats: openStats,
    openHelp: openHelp,
    closeAll: closeAll,
    isOpen: isOpen,
    toast: toast,
    confirm: confirm,
    // extras
    newGame: newGame,
    openGallery: openGallery,
    showWin: showWin,
    showStuck: showStuck,
    hideStuck: function () {
      hideStuck(false);
    },
    refresh: refresh,
  };

  SOL.UI = UI;
})(typeof window !== 'undefined' ? window : globalThis);
