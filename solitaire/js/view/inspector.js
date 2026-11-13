/*
 * SOL.Inspector — the "3D card preview": a card inspector (hold one card in your hand) and a deck gallery
 * (a 3D carousel of all the cards + a picker for the six card backs). Lives in #inspector-root, above every
 * other layer. Styles: css/inspector.css.
 *
 * Public API
 * ----------
 *   Inspector.init({ root } = {})          root = #inspector-root (default: that element; created on <body> when
 *                                          missing). Optional: every open call initialises on demand. Idempotent.
 *   Inspector.open(cardId, { sourceEl, back, cards, hideSource, elementFor } = {}) -> Promise<void>
 *       Opens the card inspector on card 0..51. The promise resolves when the inspector has closed again (or was
 *       replaced by another open call). Never rejects; an invalid card id resolves at once.
 *       sourceEl    element whose on-screen rectangle the card flies out of, and back into on close (its
 *                   rectangle is measured again at that moment; when it is gone the card just fades).
 *       back        card back id (SOL.Cards.BACKS). Default: the 'cardBack' setting, else Cards.DEFAULT_BACK.
 *                   Follows 'settings:change' while open.
 *       cards       number[] — the list that previous / next step through, in that order. Default: all 52 in
 *                   deck order. The game passes only face-up cards so nothing hidden is ever revealed. cardId is
 *                   put first when it is not in the list.
 *       hideSource  hide sourceEl (visibility) while its card is "in the hand". Default: true when sourceEl is a
 *                   .card element, false otherwise. Always restored on close.
 *       elementFor  (cardId) -> Element | null. Where a card lives on the table, for the flight home when the
 *                   player has stepped to another card with previous / next. Default: SOL.Board.cardEl when
 *                   SOL.Board exists (and a sourceEl was given), otherwise such a card just fades.
 *   Inspector.openGallery({ startCard, tab = 'cards', filter = 'all' } = {}) -> Promise<void>
 *       Opens the deck gallery. tab: 'cards' (carousel) | 'backs' (card back picker).
 *       filter: 'all' | 'spades' | 'hearts' | 'clubs' | 'diamonds' (or 0..3). Resolves when closed.
 *       startCard   card 0..51 the carousel opens on (a card outside `filter` switches the filter to 'all').
 *                   Default: the card the gallery was on when it was last closed (since the page loaded), else
 *                   the first card.
 *   Inspector.close()                      Closes whatever is open (animated). No-op when nothing is open.
 *   Inspector.back() -> boolean            What Esc / Android back / the close button do: from a card that was
 *                                          opened out of the gallery it returns to the gallery, otherwise it
 *                                          closes. Returns false when nothing is open.
 *   Inspector.isOpen() -> boolean          true from open() until close() is requested (false while the closing
 *                                          animation plays).
 *   Inspector.state() -> object            (extra, for tests and tools) { open, closing, covered, view: 'card' |
 *                                          'gallery' | null, card, index, count, flipped, spinning, zoom, yaw,
 *                                          pitch, roll, settled, idle, tiltYaw, tiltPitch, objects, cardWidth,
 *                                          tab, filter, pos, focus, focusCard, galleryCount, galleryDom, back,
 *                                          backFocus }
 *
 * Events on SOL.Bus
 *   'inspector:open'    { card, mode: 'card' | 'gallery' }   once per open call (card is null for the gallery
 *                                                             unless startCard was given)
 *   'inspector:close'   {}                                   once, when the closing animation has finished
 *   'inspector:change'  { card, mode }                       (extra) the inspected card or the mode changed
 *                                                             while open (previous / next, gallery <-> card)
 *
 * Integration
 *   - SOL.Game.pause('inspector') on open and SOL.Game.resume('inspector') after the close animation, when
 *     SOL.Game exists. Exactly one pause / resume pair per open call.
 *   - A SOL.App back handler is registered while open (Android back = Inspector.back()).
 *   - Choosing a card back calls SOL.Settings.set('cardBack', id).
 *   - Sound (SOL.Audio) and haptics (SOL.Haptics) are used when present; SOL.Anim and SOL.Cards are required.
 *   - While the inspector covers the screen, <html> carries the class `insp-covered` and inspector.css takes
 *     the table out of rendering (`.table { content-visibility: hidden }`, `.fx-layer { visibility: hidden }`).
 *     The backdrop is opaque, so nothing is lost visually, and it is what keeps the inspector smooth on a
 *     phone: a JS-driven 3D rotation makes the browser rebuild its compositor layer list every frame, at a cost
 *     proportional to all the layers on the page (see cover()). The class goes on ~190ms after opening and
 *     comes off before the backdrop fades out; layout under it stays valid (getBoundingClientRect works).
 *   - sourceEl gets the class `insp-src-hidden` (visibility: hidden) while its card is in the hand.
 *
 * Gestures (card inspector): one-finger / mouse drag rotates on two axes with inertia, a fast horizontal fling
 * flips the card or spins it a full turn, release springs back to a resting pose; two fingers pinch (zoom) and
 * twist; wheel zooms; double-tap / double-click flips; a tap on the card pokes it; a tap beside it closes; a
 * horizontal swipe that starts beside the card goes to the previous / next card; on Android, tilting the phone
 * tilts the card a little (deviceorientation; never asked for where a prompt would be needed). Keyboard: arrows
 * rotate, F flip, S spin, R reset, [ ] or , . previous / next, + - 0 zoom, Esc back, Tab stays inside.
 * Gallery: drag / fling / wheel / arrows / Home / End / PageUp / PageDown move the carousel, Enter opens the
 * focused card, tapping a card focuses it (or opens it when it already is), 1..5 pick a suit filter.
 * Buttons, chips and tabs act when the pointer comes up on them (see onPress(): a `click` would be withheld
 * by the browser right after a fling); keyboard and scripted clicks work as usual.
 *
 * How the 3D card is built: the inspector owns a wrapper (.insp-obj, transform-style: preserve-3d) that holds
 * a thick SOL.Cards card plus two overlay planes of its own (one per face) with a shade veil and a holographic
 * foil band. Every frame only `transform` / `opacity` are written (plus the card's documented --glare-*
 * properties, quantised so the highlight repaints rarely). All motion runs on SOL.Anim: springs and tweens for
 * poses, and one Anim.frame subscription — only while a card is in the hand (idle float, auto-spin, device
 * tilt, rendering) or the card backs are turning; a gallery resting on its carousel runs no loop at all. The
 * few CSS transitions (chrome fades, the 3D turn between the two gallery tabs) are transform / opacity only
 * and are sequenced with SOL.Anim.wait.
 *
 * The carousel is a cover-flow on an arc seen a little from above: the focused card faces the viewer at z = 0,
 * its neighbours step aside, turn inwards and stand back, overlapping like a fanned deck (three a side on a
 * portrait phone, five where there is room). It is virtualised: 7-8 cards are in the document on a portrait
 * phone, 11-12 in landscape and on a desktop. The six card backs are thick cards; where all six are on screen
 * on a touch device only the chosen one is (see setBackThick()).
 */
(function (root) {
  'use strict';

  const SOL = (root.SOL = root.SOL || {});
  const doc = root.document;

  // ------------------------------------------------------------------ tuning
  const DEG = Math.PI / 180;
  const REST_YAW = -15; // resting pose: turned a little so the thickness and the lighting read
  const REST_PITCH = 7;
  const ZOOM_MIN = 0.6;
  const ZOOM_MAX = 2.4;
  const SPIN_SPEED = 64; // deg / s (auto-spin)
  const IDLE_DELAY = 2200; // ms without input before the idle float starts
  const KEY_RETURN = 1500; // ms after the last arrow key before the card returns to rest
  const TAP_SLOP = 9; // px
  const TAP_MS = 420;
  const DOUBLE_TAP_MS = 330;
  const FLING_YAW = 430; // deg / s: faster horizontal releases flip / spin instead of springing back
  const FLING_PITCH = 560;
  const COVER_MS = 190; // the backdrop is opaque after this long: the table underneath can stop rendering
  // light: where it comes from (towards the viewer's upper left) and the half vector for the specular term
  const LIGHT = norm3(-0.38, -0.52, 0.77);
  const HALF = norm3(LIGHT[0], LIGHT[1], LIGHT[2] + 1);
  const SUIT_NAMES = ['spades', 'hearts', 'clubs', 'diamonds'];
  const SUIT_LABELS = ['Spades', 'Hearts', 'Clubs', 'Diamonds'];
  // Carousel arc, in card widths (placeItem): the first neighbour steps ARC_X1 aside, ARC_Z1 back and turns
  // ARC_RY1 degrees inwards; every further one adds ARC_XN / ARC_ZN (+ ARC_ZQ per step squared: the arc curves
  // away) / ARC_RYN. The steps are much smaller than a turned card is wide, so the cards overlap like a fanned
  // deck and three or four of them fit beside the focused card even on a narrow phone.
  const ARC_X1 = 0.62;
  const ARC_XN = 0.18; // on a narrow screen; up to ARC_XN_WIDE where there is room to spread the arc out (G.xn)
  const ARC_XN_WIDE = 0.34;
  const ARC_Z1 = 0.5;
  const ARC_ZN = 0.25;
  const ARC_ZQ = 0.014;
  const ARC_RY1 = 60;
  const ARC_RYN = 2.6;
  const ARC_PERSP = 5.2; // perspective distance of the carousel
  const ARC_MAX = 5; // most neighbours per side that are ever shown at full strength

  // ------------------------------------------------------------------ small helpers
  function norm3(x, y, z) {
    const l = Math.sqrt(x * x + y * y + z * z) || 1;
    return [x / l, y / l, z / l];
  }

  function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  /** Angle folded into (-180, 180]. */
  function wrap180(a) {
    a = ((a % 360) + 360) % 360;
    return a > 180 ? a - 360 : a;
  }

  /** The rest value `base + k * period` closest to `v`. */
  function nearest(v, base, period) {
    return base + period * Math.round((v - base) / period);
  }

  function r1(v) {
    return Math.round(v * 10) / 10;
  }

  function r2(v) {
    return Math.round(v * 100) / 100;
  }

  function r3(v) {
    return Math.round(v * 1000) / 1000;
  }

  function r4(v) {
    return Math.round(v * 10000) / 10000;
  }

  function nowMs() {
    return root.performance && root.performance.now ? root.performance.now() : Date.now();
  }

  /** Resistance outside [min, max]: the further out, the less the value follows. */
  function rubber(v, min, max, give) {
    if (v < min) return min - (1 - 1 / ((min - v) / give + 1)) * give;
    if (v > max) return max + (1 - 1 / ((v - max) / give + 1)) * give;
    return v;
  }

  function h(tag, className, attrs, html) {
    const el = doc.createElement(tag);
    if (className) el.className = className;
    if (attrs) for (const k of Object.keys(attrs)) el.setAttribute(k, attrs[k]);
    if (html !== undefined && html !== null) el.innerHTML = html;
    return el;
  }

  function validCard(id) {
    return Number.isInteger(id) && id >= 0 && id <= 51;
  }

  /*
   * Activation of the buttons, chips and tabs. A tap counts when the pointer comes up, not on `click`: after a
   * fling (a card spun with a flick, the carousel sent on its way) the browser withholds the click of a tap
   * that follows within a few hundred ms — it reads it as "stop the fling" — and the player's press on Flip or
   * on a suit chip would simply be lost. `click` is still honoured when no pointer produced it (keyboard and
   * scripts: `detail` 0; assistive technology: no pointer release before it). A pointer's own click, arriving
   * right after its release inside the inspector, is that same tap again — wherever the browser delivers it —
   * and is dropped.
   */
  let lastPointerUp = -1e9;

  function onPress(container, selector, handler) {
    let down = null;
    const find = function (e) {
      const el = e.target && e.target.closest ? e.target.closest(selector) : null;
      return el && container.contains(el) ? el : null;
    };
    container.addEventListener('pointerdown', function (e) {
      down = null;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const el = find(e);
      if (el) down = { id: e.pointerId, el: el };
    });
    container.addEventListener('pointerup', function (e) {
      const d = down;
      down = null;
      if (!d || d.id !== e.pointerId) return;
      // like a native button: a finger that slid off before lifting does not press it
      const r = d.el.getBoundingClientRect();
      if (e.clientX < r.left - 10 || e.clientX > r.right + 10 || e.clientY < r.top - 10 || e.clientY > r.bottom + 10) return;
      handler(d.el);
    });
    container.addEventListener('pointercancel', function () {
      down = null;
    });
    container.addEventListener('click', function (e) {
      if (e.detail !== 0 && nowMs() - lastPointerUp < 700) return;
      const el = find(e);
      if (el) handler(el);
    });
  }

  function isReduced() {
    return !!(SOL.Anim && SOL.Anim.reduced);
  }

  function lowEffects() {
    return !!doc && doc.documentElement.getAttribute('data-effects') === 'low';
  }

  function play(name, opts) {
    try {
      if (SOL.Audio && SOL.Audio.play) SOL.Audio.play(name, opts);
    } catch (err) {
      /* sound is decoration */
    }
  }

  function haptic(kind) {
    try {
      if (SOL.Haptics && SOL.Haptics.play) SOL.Haptics.play(kind);
    } catch (err) {
      /* so are haptics */
    }
  }

  function emit(event, payload) {
    if (SOL.Bus && SOL.Bus.emit) SOL.Bus.emit(event, payload);
  }

  function setting(key, fallback) {
    try {
      if (SOL.Settings && SOL.Settings.get) return SOL.Settings.get(key);
    } catch (err) {
      /* unknown key / settings unavailable */
    }
    return fallback;
  }

  function backIds() {
    return SOL.Cards.BACKS.map((b) => b.id);
  }

  function resolveBack(id) {
    const ids = backIds();
    if (ids.indexOf(id) !== -1) return id;
    const s = setting('cardBack', null);
    if (ids.indexOf(s) !== -1) return s;
    return SOL.Cards.DEFAULT_BACK;
  }

  /** On-screen rectangle of an element as { cx, cy, w, h }, or null when it is detached / hidden / empty. */
  function rectOf(el) {
    if (!el || !el.isConnected || !el.getBoundingClientRect) return null;
    const r = el.getBoundingClientRect();
    if (!(r.width > 1) || !(r.height > 1)) return null;
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, h: r.height };
  }

  // ------------------------------------------------------------------ icons (inline SVG, 24 x 24, stroke = currentColor)
  const ICON_PATHS = {
    prev: '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
    next: '<path d="M9.5 5.5 16 12l-6.5 6.5"/>',
    flip:
      '<rect x="8.2" y="6" width="7.6" height="12" rx="1.6"/><path d="M4.6 9.4C3.4 10.2 2.8 11.1 2.8 12s.6 1.8 1.8 2.6"/>' +
      '<path d="M19.4 9.4c1.2.8 1.8 1.7 1.8 2.6s-.6 1.8-1.8 2.6"/><path d="M3.2 15.9l1.5-1.2 1.2 1.6"/><path d="M20.8 8.1l-1.5 1.2-1.2-1.6"/>',
    spin:
      '<path d="M12 4.2c-4.9 0-8.8 1.8-8.8 4.1s3.9 4.1 8.8 4.1 8.8-1.8 8.8-4.1c0-1.1-.9-2.1-2.4-2.9"/>' +
      '<path d="M19.4 2.6l-1.1 2.9 3 .7"/><path d="M12 12.4v7.4"/><path d="M8.6 17.2 12 20.4l3.4-3.2"/>',
    reset:
      '<path d="M5.2 8.2A8 8 0 1 1 4 12"/><path d="M4.4 3.8v4.6H9"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
    close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
    check: '<path d="M5 12.6l4.4 4.4L19 7.4"/>',
  };

  function icon(name) {
    return (
      '<svg class="insp-ic" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + ICON_PATHS[name] + '</svg>'
    );
  }

  function button(act, label, iconName, extraClass) {
    return (
      '<button type="button" class="insp-btn' + (extraClass ? ' ' + extraClass : '') + '" data-act="' + act + '" aria-label="' +
      label + '" title="' + label + '">' + icon(iconName) + '<span class="insp-btn__label" aria-hidden="true">' +
      label.split(' ')[0] + '</span></button>'
    );
  }

  // ------------------------------------------------------------------ module state
  let mount = null; // #inspector-root
  let ui = null; // DOM references, built once
  let session = null; // the open (or closing) inspector, or null
  let sessionSeq = 0;
  let stopFrame = null; // SOL.Anim.frame subscription while open
  let busHooked = false;

  /** Card-inspector state (valid while a card view is up). */
  const C = {
    live: false,
    active: null, // the object under the fingers
    objs: [], // every live object (the active one + cards still flying out)
    list: [],
    index: 0,
    back: 'royal',
    sourceEl: null,
    sourceId: -1, // the card sourceEl belongs to
    elementFor: null, // optional resolver: card id -> its element on the table
    hideSource: false,
    hidden: null, // the element currently hidden with .insp-src-hidden
    fromGallery: false,
    spin: false,
    spinDir: 1,
    lastInput: 0,
    keyReturnAt: 0,
    idle: { amp: 0, t: 0, yaw: 0, pitch: 0, roll: 0, y: 0 },
    tilt: { on: false, has: false, rx: 0, ry: 0, bx: 0, by: 0, yaw: 0, pitch: 0, w: 1 },
    pointers: new Map(),
    g: null, // current gesture
    lastTap: null,
    hintShown: false,
    zoomed: false,
  };

  /** Layout numbers, measured in layout() — never inside an animation frame. */
  const M = { vw: 0, vh: 0, cx: 0, cy: 0, W: 200, H: 280, fw: 0, fh: 0, sens: 0.6, low: false };

  /** Gallery state (valid while a gallery exists in the session). */
  const G = {
    live: false,
    tab: 'cards',
    filter: 'all',
    list: [],
    pos: 0,
    focus: -1,
    cw: 160,
    xn: ARC_XN, // sideways step between two neighbours, in card widths (layoutGallery)
    radius: 5,
    items: new Map(), // card id -> carousel item
    cache: new Map(), // card id -> detached .card element
    morph: null, // running filter re-flow
    fl: null, // carousel flinger
    lastCard: -1, // the card the gallery was on when it was last closed
    lastTick: 0,
    backs: { items: [], pos: 0, focus: -1, bw: 150, gap: 190, fits: false, lean: false, angle: 0, selected: 'royal', fl: null },
    tabAnim: null,
    scrub: null,
  };

  // ------------------------------------------------------------------ DOM
  function build() {
    if (ui) return;
    const Cards = SOL.Cards;

    const bar =
      button('prev', 'Previous card', 'prev') +
      button('flip', 'Flip card', 'flip') +
      button('spin', 'Spin automatically', 'spin') +
      button('reset', 'Reset pose', 'reset') +
      button('next', 'Next card', 'next') +
      button('close', 'Close', 'close', 'insp-btn--close');

    let chips = '<button type="button" class="insp-chip" role="radio" data-filter="all" aria-checked="true" aria-label="All suits">All</button>';
    for (let s = 0; s < 4; s++) {
      chips +=
        '<button type="button" class="insp-chip insp-chip--' + (s % 2 ? 'red' : 'black') + '" role="radio" data-filter="' + SUIT_NAMES[s] +
        '" aria-checked="false" aria-label="' + SUIT_LABELS[s] + '">' + Cards.suitSvg(s, { size: 20 }) + '</button>';
    }

    const el = h('div', 'insp', { role: 'dialog', 'aria-modal': 'true', 'aria-label': '3D card preview', tabindex: '-1' });
    el.hidden = true;
    el.innerHTML =
      '<div class="insp__backdrop"></div>' +
      '<div class="insp__live visually-hidden" aria-live="polite" aria-atomic="true"></div>' +
      // ---- card inspector
      '<section class="insp__view insp-card" data-view="card" aria-label="Card inspector" hidden>' +
        '<div class="insp-card__stage">' +
          '<div class="insp-card__glow"></div>' +
          '<div class="insp-card__floor"><i class="insp-card__pool"></i>' +
            '<i class="insp-card__shadow insp-card__shadow--soft"></i><i class="insp-card__shadow insp-card__shadow--core"></i></div>' +
        '</div>' +
        '<div class="insp-card__frame"></div>' +
        '<div class="insp-card__caption"><h2 class="insp-card__name"></h2><p class="insp-card__meta"></p>' +
          '<p class="insp-card__hint" aria-hidden="true"></p></div>' +
        '<div class="insp-card__bar" role="toolbar" aria-label="Card controls">' + bar + '</div>' +
      '</section>' +
      // ---- deck gallery
      '<section class="insp__view insp-gal" data-view="gallery" aria-label="Deck gallery" hidden>' +
        '<header class="insp-gal__head"><h2 class="insp-gal__title">Deck gallery</h2></header>' +
        '<div class="insp-gal__panels">' +
          '<div class="insp-gal__panel" data-panel="cards" role="tabpanel" id="insp-panel-cards" aria-labelledby="insp-tab-cards">' +
            '<div class="insp-gal__ring" tabindex="0" role="group" aria-roledescription="carousel" ' +
              'aria-label="Cards. Swipe or use the arrow keys to browse, Enter opens the card in 3D."></div>' +
            '<div class="insp-gal__info"><div class="insp-gal__name"></div><div class="insp-gal__count"></div></div>' +
            '<div class="insp-gal__scrub" role="slider" tabindex="0" aria-label="Position in the deck" aria-valuemin="1">' +
              '<div class="insp-gal__scrub-track"><i></i><i></i><i></i><i></i></div><i class="insp-gal__scrub-thumb"></i></div>' +
            '<div class="insp-gal__chips" role="radiogroup" aria-label="Filter by suit">' + chips + '</div>' +
          '</div>' +
          '<div class="insp-gal__panel" data-panel="backs" role="tabpanel" id="insp-panel-backs" aria-labelledby="insp-tab-backs" hidden>' +
            '<div class="insp-gal__row" role="radiogroup" aria-label="Card back"></div>' +
            '<div class="insp-gal__info"><div class="insp-gal__count"></div></div>' +
            '<div class="insp-gal__dots" aria-hidden="true"></div>' +
          '</div>' +
        '</div>' +
        '<div class="insp-gal__bar">' +
          '<div class="insp-gal__tabs" role="tablist" aria-label="Gallery">' +
            '<i class="insp-gal__tabs-pill" aria-hidden="true"></i>' +
            '<button type="button" class="insp-tab" role="tab" id="insp-tab-cards" data-tab="cards" aria-controls="insp-panel-cards" aria-selected="true">Cards</button>' +
            '<button type="button" class="insp-tab" role="tab" id="insp-tab-backs" data-tab="backs" aria-controls="insp-panel-backs" aria-selected="false">Card backs</button>' +
          '</div>' +
          button('close', 'Close', 'close', 'insp-btn--close') +
        '</div>' +
      '</section>';
    mount.appendChild(el);

    const q = (sel, from) => (from || el).querySelector(sel);
    const cardsPanel = q('[data-panel="cards"]');
    const backsPanel = q('[data-panel="backs"]');
    ui = {
      root: el,
      backdrop: q('.insp__backdrop'),
      live: q('.insp__live'),
      cardView: q('.insp-card'),
      stage: q('.insp-card__stage'),
      floor: q('.insp-card__floor'),
      shadowSoft: q('.insp-card__shadow--soft'),
      shadowCore: q('.insp-card__shadow--core'),
      frame: q('.insp-card__frame'),
      name: q('.insp-card__name'),
      meta: q('.insp-card__meta'),
      hint: q('.insp-card__hint'),
      bar: q('.insp-card__bar'),
      btn: {},
      galView: q('.insp-gal'),
      galTitle: q('.insp-gal__title'),
      panels: q('.insp-gal__panels'),
      cardsPanel: cardsPanel,
      backsPanel: backsPanel,
      ring: q('.insp-gal__ring'),
      galName: q('.insp-gal__name', cardsPanel),
      galCount: q('.insp-gal__count', cardsPanel),
      scrub: q('.insp-gal__scrub'),
      scrubThumb: q('.insp-gal__scrub-thumb'),
      chips: q('.insp-gal__chips'),
      row: q('.insp-gal__row'),
      backStatus: q('.insp-gal__count', backsPanel),
      dots: q('.insp-gal__dots'),
      tabs: q('.insp-gal__tabs'),
      galBar: q('.insp-gal__bar'),
    };
    for (const b of ui.bar.querySelectorAll('[data-act]')) ui.btn[b.getAttribute('data-act')] = b;
    ui.btn.spin.setAttribute('aria-pressed', 'false');

    // card inspector input
    ui.stage.addEventListener('pointerdown', onStageDown);
    ui.stage.addEventListener('pointermove', onStageMove);
    ui.stage.addEventListener('pointerup', onStageUp);
    ui.stage.addEventListener('pointercancel', onStageCancel);
    ui.stage.addEventListener('lostpointercapture', onStageLost);
    onPress(ui.bar, '[data-act]', onBarPress);
    // gallery input
    onPress(ui.galBar, '[data-tab], [data-act="close"]', onGalleryBarPress);
    onPress(ui.chips, '[data-filter]', onChipPress);
    ui.row.addEventListener('focusin', onRowFocus);
    G.fl = makeFlinger({
      surface: ui.ring,
      get: function () {
        return G.pos;
      },
      set: function (v) {
        G.pos = v;
        renderCarousel();
      },
      max: function () {
        return G.list.length - 1;
      },
      unit: function () {
        return G.cw * 0.56; // a card follows the finger closely as it comes to the front
      },
      locked: function () {
        return !galleryInteractive();
      },
      onTap: onRingTap,
    });
    G.backs.fl = makeFlinger({
      surface: ui.row,
      get: function () {
        return G.backs.pos;
      },
      set: function (v) {
        G.backs.pos = v;
        renderBacks(0);
      },
      max: function () {
        return G.backs.items.length - 1;
      },
      unit: function () {
        return G.backs.gap;
      },
      fixed: function () {
        return G.backs.fits;
      },
      locked: function () {
        return !galleryInteractive();
      },
      onTap: onRowTap,
    });
    hookScrub();
    // the page must never scroll / zoom / pop a menu from inside the inspector
    el.addEventListener(
      'pointerup',
      function () {
        lastPointerUp = nowMs(); // see onPress()
      },
      true
    );
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('dragstart', (e) => e.preventDefault());
  }

  function ensureInit() {
    if (ui) return true;
    if (!doc || !SOL.Anim || !SOL.Cards) {
      if (root.console) root.console.error('[SOL.Inspector] needs a document, SOL.Anim and SOL.Cards');
      return false;
    }
    if (!mount) mount = doc.getElementById('inspector-root');
    if (!mount) {
      mount = h('div', 'inspector-root', { id: 'inspector-root' });
      doc.body.appendChild(mount);
    }
    build();
    hookBus();
    return true;
  }

  function init(opts) {
    if (opts && opts.root && !ui) mount = opts.root;
    ensureInit();
    return Inspector;
  }

  function hookBus() {
    if (busHooked || !SOL.Bus || !SOL.Bus.on) return;
    busHooked = true;
    SOL.Bus.on('settings:change', function (p) {
      if (!p || !session) return;
      if (p.key === 'cardBack') {
        const id = resolveBack(p.value);
        if (C.live) {
          C.back = id;
          for (const o of C.objs) SOL.Cards.setBack(o.card, id);
        }
        if (G.live) markSelectedBack(id, false);
      } else if (p.key === 'effects' || p.key === 'reducedMotion') {
        ui.root.classList.toggle('is-low', lowEffects());
        layout();
        if (G.live) {
          renderCarousel();
          renderBacks(0);
        }
      }
    });
  }

  // ------------------------------------------------------------------ layout (the only place that measures)
  function layout() {
    if (!ui || !session) return;
    const rr = ui.root.getBoundingClientRect();
    M.vw = rr.width;
    M.vh = rr.height;
    M.ox = rr.left;
    M.oy = rr.top;
    M.low = lowEffects();
    if (C.live) {
      const fr = ui.frame.getBoundingClientRect();
      M.fw = fr.width;
      M.fh = fr.height;
      // About 62% of the width in portrait; in landscape the height is what limits it. The card sits a little
      // above the middle of its frame so the floor shadow has room underneath.
      const W = Math.min(M.vw * 0.62, fr.width * 0.86, (fr.height * 0.74) / 1.4, 470);
      M.W = Math.max(96, Math.round(W));
      M.H = M.W * 1.4;
      M.cx = fr.left - rr.left + fr.width / 2;
      M.cy = fr.top - rr.top + fr.height * 0.46;
      M.sens = 165 / M.W; // degrees per px: a drag across the card is almost half a turn
      const st = ui.stage.style;
      st.setProperty('--card-w', M.W + 'px');
      st.setProperty('--insp-cx', r1(M.cx) + 'px');
      st.setProperty('--insp-cy', r1(M.cy) + 'px');
      st.setProperty('--insp-persp', Math.round(M.W * 4.3) + 'px');
      for (const o of C.objs) o.dirty = true;
      C.floorKey = '';
    }
    if (G.live) layoutGallery();
  }

  // ------------------------------------------------------------------ frame loop + global listeners
  function frame(dt, now, sdt) {
    const s = session;
    if (!s) return;
    if (C.live) tickCard(dt, sdt, now);
    if (G.live && s.view === 'gallery') tickGallery(dt, sdt);
  }

  function stopLoop() {
    if (stopFrame) stopFrame();
    stopFrame = null;
  }

  /**
   * The per-frame loop runs only while something needs it: a card in the hand (idle float, auto-spin, device
   * tilt, rendering) or the turning card backs. The carousel is driven by its own springs and tweens, so a
   * gallery left open on the cards tab costs nothing; neither does a backgrounded page.
   */
  function syncLoop() {
    const s = session;
    const need = !!s && !s.done && !doc.hidden && (C.live || (G.live && s.view === 'gallery' && G.tab === 'backs'));
    if (!need) stopLoop();
    else if (!stopFrame) stopFrame = SOL.Anim.frame(frame);
  }

  function onVisibility() {
    if (!session) return;
    // Backgrounded: no loop at all (rAF would be throttled anyway, but nothing should even be queued).
    if (doc.hidden) cancelGesture();
    else C.lastInput = nowMs();
    syncLoop();
  }

  function onResize() {
    if (!session) return;
    layout();
    if (G.live) {
      renderCarousel();
      renderBacks(0);
    }
  }

  let listening = false;

  function addGlobalListeners() {
    if (listening) return;
    listening = true;
    root.addEventListener('keydown', onKey, true);
    root.addEventListener('resize', onResize);
    root.addEventListener('orientationchange', onResize);
    if (root.visualViewport && root.visualViewport.addEventListener) root.visualViewport.addEventListener('resize', onResize);
    doc.addEventListener('visibilitychange', onVisibility);
    doc.addEventListener('focusin', onFocusIn);
  }

  function removeGlobalListeners() {
    if (!listening) return;
    listening = false;
    root.removeEventListener('keydown', onKey, true);
    root.removeEventListener('resize', onResize);
    root.removeEventListener('orientationchange', onResize);
    if (root.visualViewport && root.visualViewport.removeEventListener) root.visualViewport.removeEventListener('resize', onResize);
    doc.removeEventListener('visibilitychange', onVisibility);
    doc.removeEventListener('focusin', onFocusIn);
  }

  // ---- focus: trapped while open, restored on close
  function focusables() {
    if (!session) return [];
    const view = session.view === 'card' ? ui.cardView : ui.galView;
    const out = [];
    for (const el of view.querySelectorAll('button, [tabindex="0"]')) {
      if (el.disabled || el.closest('[hidden]')) continue;
      out.push(el);
    }
    return out;
  }

  function trapTab(e) {
    const list = focusables();
    e.preventDefault();
    if (!list.length) {
      ui.root.focus({ preventScroll: true });
      return;
    }
    let i = list.indexOf(doc.activeElement);
    if (i === -1) i = e.shiftKey ? 0 : -1;
    i = (i + (e.shiftKey ? -1 : 1) + list.length) % list.length;
    list[i].focus({ preventScroll: true });
  }

  function onFocusIn(e) {
    if (!session || session.closing || !ui) return;
    if (!ui.root.contains(e.target)) ui.root.focus({ preventScroll: true });
  }

  function onKey(e) {
    const s = session;
    if (!s) return;
    // Nothing typed here may reach the game underneath.
    e.stopPropagation();
    const k = e.key;
    if (k === 'Tab') {
      trapTab(e);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    let used = false;
    if (k === 'Escape') {
      back();
      used = true;
    } else if (!s.closing) {
      used = s.view === 'card' ? cardKey(e, k) : galleryKey(e, k);
    }
    if (used) e.preventDefault();
  }

  function onWheel(e) {
    e.preventDefault();
    const s = session;
    if (!s || s.closing) return;
    // Lines / pages -> px so every mouse feels alike.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 320 : 1;
    if (s.view === 'card') cardWheel(e.deltaY * unit);
    else galleryWheel((Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * unit);
  }

  function announce(text) {
    if (ui) ui.live.textContent = text;
  }

  // ------------------------------------------------------------------ session lifecycle
  /*
   * "Covering". A JS-driven 3D rotation makes the browser rebuild its compositor layer list on every frame, and
   * that costs time in proportion to ALL the layers of the page — the paused table underneath alone is several
   * hundred (measured: 3.9 ms a frame with it against 1.0 ms without, before any CPU throttling). So as soon as
   * the backdrop is opaque the table is taken out of rendering (html.insp-covered -> content-visibility: hidden
   * in inspector.css; its layout stays valid and queryable), and it is brought back, under the still opaque
   * backdrop, just before the backdrop fades away again.
   */
  function cover(s) {
    if (session !== s || s.done || s.covered || s.closing) return;
    s.covered = true;
    doc.documentElement.classList.add('insp-covered');
  }

  function uncover(s) {
    if (!s.covered) return;
    s.covered = false;
    doc.documentElement.classList.remove('insp-covered');
  }

  function startSession() {
    if (session) finishSession(session); // replace whatever is open (or still closing), at once
    const s = {
      id: ++sessionSeq,
      view: null,
      closing: false,
      done: false,
      paused: false,
      covered: false,
      coverWait: null, // resolves when the backdrop has faded in (the next frame under reduced motion)
      restoreFocus: doc.activeElement,
      removeBack: null,
      resolve: null,
      promise: null,
    };
    s.promise = new Promise(function (resolve) {
      s.resolve = resolve;
    });
    session = s;
    ui.root.hidden = false;
    ui.root.classList.remove('is-closing');
    ui.root.classList.toggle('is-low', lowEffects());
    void ui.root.offsetWidth; // flush styles so the opening transitions start from the closed state
    ui.root.classList.add('is-open');
    if (SOL.Game && typeof SOL.Game.pause === 'function') {
      try {
        SOL.Game.pause('inspector');
        s.paused = true;
      } catch (err) {
        if (root.console) root.console.error('[SOL.Inspector] Game.pause threw', err);
      }
    }
    if (SOL.App && SOL.App.addBackHandler) {
      s.removeBack = SOL.App.addBackHandler(function () {
        back();
        return true; // also swallowed while the closing animation runs
      });
    }
    addGlobalListeners();
    // (the backdrop's fade is a CSS transition and does not follow the speed setting: wait in real time)
    s.coverWait = SOL.Anim.wait(COVER_MS * SOL.Anim.speed).then(function () {
      cover(s);
    });
    return s;
  }

  function setView(s, name) {
    s.view = name;
    const card = name === 'card';
    ui.cardView.hidden = !C.live;
    ui.galView.hidden = !G.live;
    void ui.root.offsetWidth;
    ui.cardView.classList.toggle('is-active', card);
    ui.galView.classList.toggle('is-active', !card);
    ui.galView.classList.toggle('is-behind', card && G.live);
    ui.cardView.setAttribute('aria-hidden', card ? 'false' : 'true');
    ui.galView.setAttribute('aria-hidden', card ? 'true' : 'false');
    ui.root.setAttribute('data-view', name);
  }

  /** Everything is torn down synchronously: safe to call at any point of any animation. */
  function finishSession(s) {
    if (!s || s.done) return;
    s.done = true;
    cancelGesture();
    destroyCardView();
    destroyGallery();
    removeGlobalListeners();
    stopLoop();
    uncover(s);
    ui.root.classList.remove('is-open', 'is-closing');
    ui.root.removeAttribute('data-view');
    ui.cardView.classList.remove('is-active');
    ui.galView.classList.remove('is-active', 'is-behind');
    ui.cardView.hidden = true;
    ui.galView.hidden = true;
    ui.root.hidden = true;
    if (s.removeBack) s.removeBack();
    if (session === s) session = null;
    if (s.paused && SOL.Game && typeof SOL.Game.resume === 'function') {
      try {
        SOL.Game.resume('inspector');
      } catch (err) {
        if (root.console) root.console.error('[SOL.Inspector] Game.resume threw', err);
      }
    }
    const f = s.restoreFocus;
    if (f && f !== doc.body && f.isConnected && typeof f.focus === 'function') {
      try {
        f.focus({ preventScroll: true });
      } catch (err) {
        /* not focusable any more */
      }
    }
    emit('inspector:close', {});
    s.resolve();
  }

  function close() {
    const s = session;
    if (!s || s.closing) return;
    s.closing = true;
    cancelGesture();
    // 1. controls and gallery fade (CSS), the card flies home or fades — all still over the opaque backdrop
    ui.cardView.classList.remove('is-active');
    ui.galView.classList.remove('is-active');
    play('close');
    haptic('tick');
    const A = SOL.Anim;
    const first = C.live
      ? // back to its place on the table, or a plain fade when it has none / it came from the gallery
        flyOut(C.active, s.view === 'card' && !C.fromGallery && C.active ? homeOf(C.active.id) : null)
      : A.wait(190);
    if (G.live) galleryStop();
    Promise.resolve(first)
      .then(function () {
        if (s.done) return null;
        // 2. the table comes back and repaints, still hidden by the backdrop
        uncover(s);
        return A.nextFrame().then(function () {
          return A.nextFrame();
        });
      })
      .then(function () {
        if (s.done) return null;
        // 3. the backdrop fades away, and the stand-in dissolves with it: the real card is back in its place,
        //    under whatever covers it on the table
        ui.root.classList.add('is-closing');
        ui.root.classList.remove('is-open');
        unhideSource();
        for (const o of C.objs) fadeObj(o, 190);
        return A.wait(210);
      })
      .then(function () {
        finishSession(s);
      });
  }

  /** Esc / Android back / close button / tap beside the card. */
  function back() {
    const s = session;
    if (!s) return false;
    if (s.closing) return true;
    if (s.view === 'card' && C.fromGallery && G.live) returnToGallery();
    else close();
    return true;
  }

  // ====================================================================================================
  // CARD INSPECTOR
  // ====================================================================================================

  // ------------------------------------------------------------------ the 3D object
  function makePlane(side) {
    const el = h('div', 'insp-obj__plane insp-obj__plane--' + side);
    const shade = h('i', 'insp-obj__shade');
    const sheen = h('i', 'insp-obj__sheen');
    el.appendChild(shade);
    el.appendChild(sheen);
    return { el: el, shade: shade, sheen: sheen, _sh: -1, _so: -1, _tx: NaN };
  }

  /**
   * One card "in the hand": a perspective scene (so it can fade as a whole without flattening the 3D inside),
   * the rotating object, a thick SOL.Cards card and the two lighting planes. Pose fields are plain numbers that
   * springs, tweens and fingers write; renderObj() turns them into styles once per frame when `dirty`.
   */
  function makeObj(cardId) {
    const wrap = h('div', 'insp-scene');
    const el = h('div', 'insp-obj');
    const card = SOL.Cards.create(cardId, { thick: true, back: C.back });
    const front = makePlane('front');
    const backPlane = makePlane('back');
    el.appendChild(card);
    el.appendChild(front.el);
    el.appendChild(backPlane.el);
    wrap.appendChild(el);
    return {
      id: cardId,
      wrap: wrap,
      el: el,
      card: card,
      front: front,
      back: backPlane,
      x: 0, // px from the stage centre
      y: 0,
      z: 0,
      nx: 0, // extra x while an edge swipe drags the card along
      by: 0, // left-over idle bob, decays
      br: 0, // left-over idle roll, decays
      s: 1, // flight scale (source size -> 1)
      zoom: 1,
      zoomT: 1, // where the zoom is heading
      pop: 0, // small extra scale pulse (flip)
      yaw: REST_YAW,
      pitch: REST_PITCH,
      roll: 0,
      yawT: undefined, // rotation spring targets while one runs
      pitchT: undefined,
      light: 1, // 0..1 how much of the lighting rig is on (0 while it imitates the flat source card)
      ground: 1, // 0..1 floor shadow strength
      alpha: 1,
      rot: null,
      zoomS: null,
      rollS: null,
      navS: null,
      fly: null,
      handles: new Set(),
      dirty: true,
      dead: false,
      retired: false, // flying out: no input, no idle, no floor
      pendingSpin: false, // opening flourish not started yet (it waits for the table to be covered)
      compact: false, // front pinned to the compact layout (see pinLayout)
      _ly: 0, // last rendered angles: fast turns update the highlight less often
      _lp: 0,
      _gs: 0,
      _t: '',
      _a: 1,
      _gx: -999,
      _gy: -999,
      _go: -1,
    };
  }

  function attach(o) {
    ui.stage.appendChild(o.wrap);
    C.objs.push(o);
  }

  /**
   * Small cards on the table use the compact front (SOL.Cards.COMPACT_BELOW). While the big card stands in for
   * such a card — the first frames after leaving it, the last before landing on it — it is pinned to the same
   * layout, so it really is indistinguishable from the card it replaces.
   */
  function pinLayout(o, compact) {
    if (o.compact === compact) return;
    o.compact = compact;
    if (compact) o.card.setAttribute('data-layout', 'compact');
    else o.card.removeAttribute('data-layout');
  }

  function compactBelow() {
    return SOL.Cards.COMPACT_BELOW || 60;
  }

  /** Remember a one-shot animation so destroying the object cancels it. */
  function own(o, handle) {
    o.handles.add(handle);
    handle.finished.then(function () {
      o.handles.delete(handle);
    });
    return handle;
  }

  function releaseObj(o) {
    if (o.rot) o.rot.cancel();
    if (o.zoomS) o.zoomS.cancel();
    if (o.rollS) o.rollS.cancel();
    if (o.navS) o.navS.cancel();
    if (o.fly) o.fly.cancel();
    o.rot = o.zoomS = o.rollS = o.navS = o.fly = null;
    o.yawT = o.pitchT = undefined;
    for (const hd of Array.from(o.handles)) hd.cancel();
    o.handles.clear();
  }

  function destroyObj(o) {
    if (o.dead) return;
    o.dead = true;
    releaseObj(o);
    if (o.wrap.parentNode) o.wrap.parentNode.removeChild(o.wrap);
    const i = C.objs.indexOf(o);
    if (i !== -1) C.objs.splice(i, 1);
    if (C.active === o) C.active = null;
  }

  // ------------------------------------------------------------------ pose drivers
  function stopRot(o) {
    if (o.rot) o.rot.cancel();
    o.rot = null;
    o.yawT = o.pitchT = undefined;
  }

  /**
   * Springs the rotation to `to` ({ yaw?, pitch? } in degrees). `vel` (deg/s) defaults to the velocity of the
   * spring it replaces, so retargeting mid-motion never stutters.
   */
  function springRot(o, to, vel, stiffness, damping) {
    o.pendingSpin = false;
    const from = {};
    const v = {};
    const target = {};
    let cvy = 0;
    let cvp = 0;
    if (o.rot) {
      const cv = o.rot.velocity;
      cvy = cv.yaw || 0;
      cvp = cv.pitch || 0;
      o.rot.cancel();
    }
    o.yawT = o.pitchT = undefined;
    if (typeof to.yaw === 'number') {
      from.yaw = o.yaw;
      target.yaw = o.yawT = to.yaw;
      v.yaw = vel && typeof vel.yaw === 'number' ? vel.yaw : cvy;
    }
    if (typeof to.pitch === 'number') {
      from.pitch = o.pitch;
      target.pitch = o.pitchT = to.pitch;
      v.pitch = vel && typeof vel.pitch === 'number' ? vel.pitch : cvp;
    }
    const sp = SOL.Anim.spring({
      from: from,
      to: target,
      velocity: v,
      stiffness: stiffness || 58,
      damping: damping || 11,
      precision: 0.04,
      update: function (val) {
        if (val.yaw !== undefined) o.yaw = val.yaw;
        if (val.pitch !== undefined) o.pitch = val.pitch;
        o.dirty = true;
      },
      done: function () {
        if (o.rot !== sp) return;
        o.rot = null;
        o.yawT = o.pitchT = undefined;
        // fold the angles back so they never grow without bound (the picture is identical)
        o.yaw = wrap180(o.yaw);
        o.pitch = wrap180(o.pitch);
      },
    });
    o.rot = sp;
    return sp;
  }

  function restTarget(o) {
    const t = { pitch: nearest(o.pitch, REST_PITCH, 360) };
    if (!C.spin) t.yaw = nearest(o.yaw, REST_YAW, 180);
    return t;
  }

  /** Back to the nearest resting pose (front or back, whichever is closer). */
  function settle(o, vel) {
    if (!o || o.dead || o.retired) return;
    springRot(o, restTarget(o), vel || null, 58, 11);
  }

  function zoomTo(o, z, stiffness) {
    z = clamp(z, ZOOM_MIN, ZOOM_MAX);
    o.zoomT = z;
    if (o.zoomS) o.zoomS.cancel();
    const sp = SOL.Anim.spring({
      from: o.zoom,
      to: z,
      stiffness: stiffness || 210,
      damping: 26,
      precision: 0.001,
      update: function (v) {
        o.zoom = v;
        o.dirty = true;
      },
      done: function () {
        if (o.zoomS === sp) o.zoomS = null;
      },
    });
    o.zoomS = sp;
  }

  function zoomBy(factor) {
    const o = C.active;
    if (!o) return;
    touch();
    zoomTo(o, o.zoomT * factor);
  }

  function rollTo(o, deg) {
    if (o.rollS) o.rollS.cancel();
    if (Math.abs(o.roll - deg) < 0.01) {
      o.roll = deg;
      o.rollS = null;
      return;
    }
    const sp = SOL.Anim.spring({
      from: o.roll,
      to: deg,
      stiffness: 80,
      damping: 12,
      precision: 0.03,
      update: function (v) {
        o.roll = v;
        o.dirty = true;
      },
      done: function () {
        if (o.rollS === sp) o.rollS = null;
      },
    });
    o.rollS = sp;
  }

  function springNx(o, to, vel) {
    if (o.navS) o.navS.cancel();
    const sp = SOL.Anim.spring({
      from: o.nx,
      to: to,
      velocity: vel || 0,
      stiffness: 240,
      damping: 21,
      precision: 0.05,
      update: function (v) {
        o.nx = v;
        o.dirty = true;
      },
      done: function () {
        if (o.navS === sp) o.navS = null;
      },
    });
    o.navS = sp;
  }

  /** A quick swell of the whole card (flips, selections). */
  function pop(o, amount) {
    own(
      o,
      SOL.Anim.tween({
        duration: 460,
        ease: 'linear',
        update: function (t) {
          o.pop = amount * Math.sin(Math.PI * t) * (1 - t * 0.35);
          o.dirty = true;
        },
        done: function () {
          o.pop = 0;
          o.dirty = true;
        },
      })
    );
  }

  function isFlipped(o) {
    const yaw = o.yawT !== undefined ? o.yawT : o.yaw;
    const pitch = o.pitchT !== undefined ? o.pitchT : o.pitch;
    return Math.cos(yaw * DEG) * Math.cos(pitch * DEG) < 0;
  }

  function announceFace(o) {
    announce(SOL.Cards.label(o.id) + (isFlipped(o) ? ', showing the back' : ', showing the front'));
  }

  // ------------------------------------------------------------------ rendering (styles are written here only)
  function setPlane(p, shade, sheen, tx) {
    if (shade !== p._sh) {
      p.shade.style.opacity = String(shade);
      p._sh = shade;
    }
    if (sheen !== p._so) {
      p.sheen.style.opacity = String(sheen);
      p._so = sheen;
    }
    if (sheen > 0 && tx !== p._tx) {
      p.sheen.style.transform = 'translate3d(' + tx + 'px,0,0) skewX(-20deg)';
      p._tx = tx;
    }
  }

  function renderObj(o, active) {
    o.dirty = false;
    let yaw = o.yaw;
    let pitch = o.pitch;
    let roll = o.roll + o.br;
    let y = o.y + o.by;
    if (active) {
      const idle = C.idle;
      const T = C.tilt;
      yaw += idle.yaw + T.yaw;
      pitch += idle.pitch + T.pitch;
      roll += idle.roll;
      y += idle.y;
    }
    const sc = o.s * o.zoom * (1 + o.pop);
    const t =
      'translate3d(' + r2(o.x + o.nx) + 'px,' + r2(y) + 'px,' + r2(o.z) + 'px) rotateZ(' + r2(roll) + 'deg) rotateX(' +
      r2(pitch) + 'deg) rotateY(' + r2(yaw) + 'deg) scale3d(' + r4(sc) + ',' + r4(sc) + ',' + r4(sc) + ')';
    if (t !== o._t) {
      o.el.style.transform = t;
      o._t = t;
    }
    const a = r2(o.alpha);
    if (a !== o._a) {
      o.wrap.style.opacity = String(a);
      o._a = a;
    }

    // ---- lighting. Normal of the visible face in view space (x right, y down, z towards the viewer).
    const cy = Math.cos(yaw * DEG);
    const sy = Math.sin(yaw * DEG);
    const cp = Math.cos(pitch * DEG);
    const sp = Math.sin(pitch * DEG);
    let nx = sy;
    let ny = -cy * sp;
    let nz = cy * cp;
    if (nz < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const cr = Math.cos(roll * DEG);
    const sr = Math.sin(roll * DEG);
    if (roll !== 0) {
      const tx = nx * cr - ny * sr;
      ny = nx * sr + ny * cr;
      nx = tx;
    }
    const L = o.light;
    const diffuse = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
    const ndh = Math.max(0, nx * HALF[0] + ny * HALF[1] + nz * HALF[2]);
    const spec = Math.pow(ndh, 12);
    // a face turned away from the lamp goes dark; grazing angles bring the foil out
    const shade = Math.round(clamp(0.7 * (1 - diffuse) - 0.06, 0, 0.62) * L * 100) / 100;
    // (the foil glows where the lamp reaches it and is subdued on a face in shadow)
    const sheen = M.low
      ? 0
      : Math.round(clamp(0.08 + 0.62 * Math.pow(1 - nz, 0.8), 0, 0.66) * (0.45 + 0.55 * diffuse) * L * 100) / 100;
    // The foil pattern is periodic: slide it by the fractional part and it wraps without a seam.
    const period = M.W * 1.1;
    let phase = nx * 0.9 + ny * 0.6 + 0.35;
    phase -= Math.floor(phase);
    const band = -Math.round(phase * period);
    setPlane(o.front, shade, sheen, band);
    setPlane(o.back, shade, sheen, band);

    // Specular highlight: on a flat glossy face it sits towards the side that is nearer the viewer, and high up
    // because the lamp is (at rest: over the blank paper of the top right corner, clear of the index and the
    // art; it crosses the face as the card turns through the frontal position). Expressed in the visible face's
    // own box: undo the roll; a face seen upside-down (pitched past edge-on) has both axes reversed.
    let hx = -1.2 * nx - 0.03;
    let hy = -1.2 * ny - 0.76;
    if (roll !== 0) {
      const tx = hx * cr + hy * sr;
      hy = -hx * sr + hy * cr;
      hx = tx;
    }
    if (cp < 0) {
      hx = -hx;
      hy = -hy;
    }
    // Every new value restyles and repaints the card's two highlight layers, so: 2% steps (invisible on a
    // highlight this soft), and while the card turns fast only every third frame.
    const fast = Math.abs(yaw - o._ly) + Math.abs(pitch - o._lp) > 5;
    o._ly = yaw;
    o._lp = pitch;
    o._gs = fast ? (o._gs + 1) % 3 : 0;
    if (o._gs === 0) {
      const gx = Math.round(clamp(50 + hx * 100, -46, 146) / 2) * 2;
      const gy = Math.round(clamp(50 + (hy * 100) / 1.4, -46, 146) / 2) * 2;
      const go = Math.round(clamp(0.08 + 0.55 * spec, 0, 0.7) * L * 25) / 25;
      const cs = o.card.style;
      if (gx !== o._gx) {
        cs.setProperty('--glare-x', gx + '%');
        o._gx = gx;
      }
      if (gy !== o._gy) {
        cs.setProperty('--glare-y', gy + '%');
        o._gy = gy;
      }
      if (go !== o._go) {
        cs.setProperty('--glare-o', String(go));
        o._go = go;
      }
    } else {
      o.dirty = true; // catch up on a following frame
    }

    if (active) renderFloor(o, cy, sy, cp, sp, sc, y);
  }

  /**
   * The soft shadow on the "floor" under the card: it follows the card sideways, narrows as the card turns
   * edge-on, deepens as it tips, grows and softens as the card comes closer (zoom) or bobs up. Two static
   * blurred blobs cross-faded with opacity — nothing is ever re-blurred.
   */
  function renderFloor(o, cy, sy, cp, sp, sc, y) {
    const W = M.W;
    const g = C.fg;
    const acy = Math.abs(cy);
    const asp = Math.abs(sp);
    const asy = Math.abs(sy);
    const up = clamp(-(y - o.y) / (W * 0.03 + 1), -1, 1); // idle bob, -1..1 (1 = highest)
    const near = clamp(sc - 1, -0.5, 1.6); // > 0: closer to the viewer, higher above the floor
    const size = (0.62 + 0.38 * sc) * (1 - 0.05 * up);
    const fw = (0.22 + 0.78 * acy) * size;
    const fd = (0.6 + 0.9 * asp + 0.45 * asy) * size;
    const fx = o.x + o.nx + W * (0.05 + 0.03 * sy) * sc;
    const fy = y * 0.35 + M.H * 0.5 * Math.max(0.2, Math.abs(cp)) * (sc - 1) * 0.92 + W * 0.05 * near;
    const coreO = clamp(0.78 - 0.4 * near - 0.2 * asp - 0.1 * up, 0.08, 0.85) * g;
    const softO = clamp(0.6 + 0.25 * near + 0.1 * up, 0.3, 0.95) * g;
    const key = r1(fx) + '|' + r1(fy) + '|' + r3(fw) + '|' + r3(fd) + '|' + r2(coreO) + '|' + r2(softO);
    if (key === C.floorKey) return;
    C.floorKey = key;
    const pos = 'translate3d(' + r1(fx) + 'px,' + r1(fy) + 'px,0) ';
    ui.shadowCore.style.transform = pos + 'scale(' + r3(fw) + ',' + r3(fd) + ')';
    ui.shadowCore.style.opacity = String(r2(coreO));
    ui.shadowSoft.style.transform = pos + 'scale(' + r3(fw * 1.12 + 0.18) + ',' + r3(fd * 1.3 + 0.1 * near) + ')';
    ui.shadowSoft.style.opacity = String(r2(softO));
  }

  // ------------------------------------------------------------------ per-frame: idle float, spin, tilt, render
  function absorbIdle(o) {
    const idle = C.idle;
    if (idle.amp <= 0 && idle.yaw === 0 && idle.y === 0) return;
    // The sway becomes part of the pose (so nothing jumps under the finger); bob and roll ease out.
    o.yaw += idle.yaw;
    o.pitch += idle.pitch;
    o.br += idle.roll;
    o.by += idle.y;
    idle.amp = idle.t = idle.yaw = idle.pitch = idle.roll = idle.y = 0;
    o.dirty = true;
  }

  /** Any deliberate input: the idle float stops at once and its clock restarts. */
  function touch() {
    C.lastInput = nowMs();
    const o = C.active;
    if (o && !o.dead) absorbIdle(o);
    if (C.hintShown) hideHint();
  }

  function tickCard(dt, sdt, now) {
    const s = session;
    const o = C.active;
    const reduced = SOL.Anim.reduced;
    if (o && !o.retired && !o.dead && !s.closing) {
      const busy = !!C.g;
      // auto-spin: a steady turn about the card's own axis whenever nothing else is steering the yaw
      if (C.spin && !busy && o.yawT === undefined && !o.fly) {
        o.yaw += (C.spinDir * (reduced ? SPIN_SPEED * 0.45 : SPIN_SPEED) * (reduced ? dt : sdt)) / 1000;
        if (o.yaw > 720 || o.yaw < -720) o.yaw = wrap180(o.yaw);
        o.dirty = true;
      }
      if (C.keyReturnAt && now >= C.keyReturnAt && !busy) {
        C.keyReturnAt = 0;
        settle(o);
      }
      if (C.hintShown && now > C.hintUntil) hideHint();
      // zoomed in, the card reaches the caption: the caption steps aside
      const zoomed = o.zoom > 1.22;
      if (zoomed !== C.zoomed) {
        C.zoomed = zoomed;
        ui.cardView.classList.toggle('is-zoomed', zoomed);
      }

      // idle float: a slow bob and a few degrees of sway once the card has been left alone for a moment
      const idle = C.idle;
      const calm = !reduced && !busy && !o.rot && !o.fly && !o.zoomS && !o.rollS && !o.navS && now - C.lastInput > IDLE_DELAY;
      if (calm) {
        idle.amp = Math.min(1, idle.amp + dt / 1600);
        idle.t += sdt / 1000;
        const e = idle.amp * idle.amp * (3 - 2 * idle.amp);
        const t = idle.t;
        idle.yaw = C.spin ? 0 : e * 5.5 * Math.sin(t * 0.62);
        idle.pitch = e * 2.6 * Math.sin(t * 0.47);
        idle.roll = e * 1.1 * Math.sin(t * 0.38);
        idle.y = -e * M.W * 0.03 * Math.sin(t * 0.9);
        o.dirty = true;
      } else if (idle.amp > 0) {
        absorbIdle(o);
      }
      if (!busy && (o.by !== 0 || o.br !== 0)) {
        // what was left of the idle bob eases out — but never under a finger: there only the finger moves it
        const k = Math.exp(-dt / 150);
        o.by = Math.abs(o.by) < 0.02 ? 0 : o.by * k;
        o.br = Math.abs(o.br) < 0.005 ? 0 : o.br * k;
        o.dirty = true;
      }
      tickTilt(dt, busy || reduced, o);
    }
    // the floor shadow belongs to the active card; its strength glides so swapping cards never pops
    const want = o && !o.dead ? o.ground : 0;
    if (Math.abs(want - C.fg) > 0.003) {
      C.fg += (want - C.fg) * (1 - Math.exp(-dt / 80));
      if (o) o.dirty = true;
    } else if (C.fg !== want) {
      C.fg = want;
      if (o) o.dirty = true;
    }
    for (let i = 0; i < C.objs.length; i++) {
      const ob = C.objs[i];
      if (ob.dirty) renderObj(ob, ob === o);
    }
  }

  // ---- device tilt (Android): subtle, smoothed, never while a finger is down, silently absent elsewhere
  function onTilt(e) {
    const T = C.tilt;
    if (typeof e.beta !== 'number' || typeof e.gamma !== 'number') return;
    let ang = 0;
    try {
      ang = (root.screen && root.screen.orientation && root.screen.orientation.angle) || root.orientation || 0;
    } catch (err) {
      ang = 0;
    }
    let x = e.gamma;
    let y = e.beta;
    if (ang === 90) {
      x = e.beta;
      y = -e.gamma;
    } else if (ang === 270 || ang === -90) {
      x = -e.beta;
      y = e.gamma;
    } else if (ang === 180) {
      x = -e.gamma;
      y = -e.beta;
    }
    if (!T.has) {
      T.has = true;
      T.bx = x;
      T.by = y;
    }
    T.rx = x;
    T.ry = y;
  }

  function tickTilt(dt, off, o) {
    const T = C.tilt;
    if (!T.has) return;
    // "Neutral" drifts towards however the phone is being held, so a new grip re-centres within seconds.
    const kb = 1 - Math.exp(-dt / 4500);
    T.bx += wrap180(T.rx - T.bx) * kb;
    T.by += wrap180(T.ry - T.by) * kb;
    const dx = clamp(wrap180(T.rx - T.bx), -28, 28);
    const dy = clamp(wrap180(T.ry - T.by), -28, 28);
    T.w += ((off ? 0 : 1) - T.w) * (1 - Math.exp(-dt / 160));
    const k = 1 - Math.exp(-dt / 110);
    const yaw = T.yaw + (dx * 0.5 * T.w - T.yaw) * k;
    const pitch = T.pitch + (-dy * 0.42 * T.w - T.pitch) * k;
    if (Math.abs(yaw - T.yaw) > 0.004 || Math.abs(pitch - T.pitch) > 0.004) {
      T.yaw = yaw;
      T.pitch = pitch;
      o.dirty = true;
    }
  }

  function startTilt() {
    const T = C.tilt;
    T.has = false;
    T.yaw = T.pitch = 0;
    T.w = 1;
    if (T.on) return;
    // Just listen. Android delivers the events as they are; where a permission prompt would be needed (iOS) we
    // never ask — not worth interrupting for a flourish — so nothing arrives and the card simply does not tilt.
    if (!root.DeviceOrientationEvent) return;
    T.on = true;
    root.addEventListener('deviceorientation', onTilt);
  }

  function stopTilt() {
    const T = C.tilt;
    if (T.on) root.removeEventListener('deviceorientation', onTilt);
    T.on = T.has = false;
    T.yaw = T.pitch = 0;
  }

  // ------------------------------------------------------------------ actions
  function flip(o, dir) {
    if (!o || o.dead || o.retired) return;
    touch();
    const base = nearest(o.yawT !== undefined ? o.yawT : o.yaw, REST_YAW, 180);
    const d = dir || C.spinDir || 1;
    springRot(o, { yaw: base + 180 * d, pitch: nearest(o.pitch, REST_PITCH, 360) }, null, 78, 12.5);
    pop(o, 0.07);
    play('flip');
    haptic('tap');
    announceFace(o);
  }

  function setSpin(on, quiet) {
    on = !!on;
    if (C.spin === on) return;
    C.spin = on;
    ui.btn.spin.setAttribute('aria-pressed', on ? 'true' : 'false');
    ui.btn.spin.classList.toggle('is-on', on);
    const o = C.active;
    if (o && !o.dead && !o.retired) {
      if (on) {
        stopRot(o);
        springRot(o, { pitch: nearest(o.pitch, REST_PITCH, 360) }, null, 58, 11);
      } else {
        settle(o);
      }
    }
    if (!quiet) announce(on ? 'Spinning' : 'Spin stopped');
  }

  function toggleSpin() {
    touch();
    setSpin(!C.spin);
    play('click');
    haptic('tick');
  }

  function resetPose() {
    const o = C.active;
    if (!o || o.dead || o.retired) return;
    touch();
    setSpin(false, true);
    springRot(o, { yaw: nearest(o.yaw, REST_YAW, 360), pitch: nearest(o.pitch, REST_PITCH, 360) }, null, 74, 13.5);
    zoomTo(o, 1, 150);
    rollTo(o, 0);
    springNx(o, 0);
    play('slide', { volume: 0.5 });
    haptic('tick');
    announce('Pose reset');
  }

  function keyRotate(o, dYaw, dPitch) {
    touch();
    const to = { pitch: (o.pitchT !== undefined ? o.pitchT : o.pitch) + dPitch };
    if (!C.spin || dYaw) to.yaw = (o.yawT !== undefined ? o.yawT : o.yaw) + dYaw;
    springRot(o, to, null, 130, 19);
    C.keyReturnAt = nowMs() + KEY_RETURN;
  }

  function cardKey(e, k) {
    const o = C.active;
    if (!o || o.dead || o.retired) return false;
    const step = e.shiftKey ? 90 : 24;
    switch (k) {
      case 'ArrowLeft':
        keyRotate(o, -step, 0);
        return true;
      case 'ArrowRight':
        keyRotate(o, step, 0);
        return true;
      case 'ArrowUp':
        keyRotate(o, 0, 15);
        return true;
      case 'ArrowDown':
        keyRotate(o, 0, -15);
        return true;
      case 'f':
      case 'F':
        flip(o);
        return true;
      case 'r':
      case 'R':
        resetPose();
        return true;
      case 's':
      case 'S':
        toggleSpin();
        return true;
      case '[':
      case ',':
        navigate(-1);
        return true;
      case ']':
      case '.':
        navigate(1);
        return true;
      case '+':
      case '=':
        zoomBy(1.2);
        return true;
      case '-':
      case '_':
        zoomBy(1 / 1.2);
        return true;
      case '0':
        touch();
        zoomTo(o, 1);
        return true;
      default:
        return false;
    }
  }

  function cardWheel(delta) {
    zoomBy(Math.exp(-clamp(delta, -400, 400) * 0.0018));
  }

  function onBarPress(b) {
    const s = session;
    if (!s || s.closing || s.view !== 'card') return;
    switch (b.getAttribute('data-act')) {
      case 'prev':
        navigate(-1);
        break;
      case 'next':
        navigate(1);
        break;
      case 'flip':
        flip(C.active);
        break;
      case 'spin':
        toggleSpin();
        break;
      case 'reset':
        resetPose();
        break;
      case 'close':
        back();
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------------ caption + controls state
  function updateCaption() {
    const id = C.list[C.index];
    const info = SOL.Cards.info(id);
    let html = '';
    let i = 0;
    for (const word of info.label.split(' ')) {
      html += '<span class="insp-word">';
      for (const ch of word) html += '<span class="insp-ch" style="--i:' + i++ + '">' + ch + '</span>';
      html += '</span> ';
    }
    ui.name.innerHTML = html;
    ui.name.setAttribute('aria-label', info.label);
    ui.name.setAttribute('data-color', info.color);
    const n = C.list.length;
    ui.meta.innerHTML =
      SOL.Cards.suitSvg(info.suit, { size: 13 }) + '<span>' + (n > 1 ? C.index + 1 + ' of ' + n : SUIT_LABELS[info.suit]) + '</span>';
    ui.meta.setAttribute('data-color', info.color);
    announce(info.label + (n > 1 ? ', card ' + (C.index + 1) + ' of ' + n : ''));
  }

  function updateNav() {
    const n = C.list.length;
    const set = function (b, off) {
      b.setAttribute('aria-disabled', off ? 'true' : 'false');
      b.classList.toggle('is-disabled', off);
    };
    set(ui.btn.prev, C.index <= 0);
    set(ui.btn.next, C.index >= n - 1);
  }

  function showHint() {
    const touchy = SOL.Platform ? SOL.Platform.isTouch : 'ontouchstart' in root;
    ui.hint.textContent = touchy
      ? 'Drag to rotate · pinch to zoom · double-tap to flip'
      : 'Drag to rotate · scroll to zoom · double-click to flip';
    ui.hint.classList.add('is-on');
    C.hintShown = true;
    C.hintUntil = nowMs() + 6500;
  }

  function hideHint() {
    C.hintShown = false;
    if (ui) ui.hint.classList.remove('is-on');
  }

  // ------------------------------------------------------------------ previous / next: a 3D pass-through
  function retire(o, dir) {
    o.retired = true;
    releaseObj(o);
    const far = M.vw * 0.5 + M.W;
    const x0 = o.x + o.nx;
    const z0 = o.z;
    const yaw0 = o.yaw + (C.active === o ? C.idle.yaw + C.tilt.yaw : 0);
    o.nx = 0;
    own(
      o,
      SOL.Anim.tween({
        duration: 420,
        ease: 'linear',
        update: function (t) {
          const e = t * t; // accelerates away
          o.x = lerp(x0, -dir * far, e);
          o.z = lerp(z0, -M.W * 1.5, t);
          o.yaw = yaw0 - dir * 115 * t;
          o.alpha = clamp(2.2 * (1 - t), 0, 1);
          o.dirty = true;
        },
        done: function () {
          destroyObj(o);
        },
      })
    );
  }

  function bump(o, dir) {
    if (!o || o.dead || o.retired) return;
    springNx(o, 0, dir * M.W * 4.2);
    springRot(o, restTarget(o), { yaw: -dir * 170 }, 95, 11.5);
    play('tick', { pitch: 0.7 });
    haptic('thud');
    announce(dir > 0 ? 'Last card' : 'First card');
  }

  function navigate(dir) {
    const s = session;
    if (!s || s.closing || !C.live || s.view !== 'card' || C.returning) return false;
    const old = C.active;
    if (!old || old.dead) return false;
    touch();
    const ni = C.index + dir;
    if (ni < 0 || ni >= C.list.length) {
      bump(old, dir);
      return false;
    }
    C.index = ni;
    const keepZoom = clamp(old.zoomT, ZOOM_MIN, ZOOM_MAX);
    // The old card keeps flying out by itself; the new one is live at once — input never waits for a transition.
    retire(old, dir);
    const o = makeObj(C.list[ni]);
    const far = M.vw * 0.5 + M.W * 0.9;
    o.x = dir * far;
    o.z = M.W * 0.7; // comes in closer to the eye than the one leaving: they pass each other in depth
    o.yaw = REST_YAW + dir * 110;
    o.pitch = REST_PITCH;
    o.zoom = o.zoomT = keepZoom;
    o.ground = 0;
    attach(o);
    C.active = o;
    const x0 = o.x;
    const z0 = o.z;
    o.fly = SOL.Anim.tween({
      duration: 520,
      ease: 'outCubic',
      update: function (e) {
        o.x = lerp(x0, 0, e);
        o.z = lerp(z0, 0, e);
        o.ground = e;
        o.dirty = true;
      },
      done: function () {
        o.fly = null;
      },
    });
    // turns from edge-on to the resting pose as it arrives (with auto-spin on it simply keeps turning)
    springRot(o, C.spin ? { pitch: REST_PITCH } : { yaw: REST_YAW, pitch: REST_PITCH }, { yaw: 0, pitch: 0 }, 52, 10.5);
    updateCaption();
    updateNav();
    ui.name.setAttribute('data-dir', dir > 0 ? 'next' : 'prev');
    play('whoosh', { duration: 240, volume: 0.55, pan: dir * 0.25 });
    haptic('tick');
    emit('inspector:change', { card: o.id, mode: 'card' });
    return true;
  }

  // ------------------------------------------------------------------ flights: out of the source, and back
  function hideSourceEl(el) {
    unhideSource();
    if (!el || !el.classList) return;
    el.classList.add('insp-src-hidden');
    C.hidden = el;
  }

  function unhideSource() {
    if (C.hidden && C.hidden.classList) C.hidden.classList.remove('insp-src-hidden');
    C.hidden = null;
  }

  /**
   * The card arrives. With a source it starts as an exact, flat, unlit stand-in for it and lifts off towards the
   * stage straight away; the turn, the lighting and the floor shadow only join in once the table is covered
   * (see cover()): until then every frame is a plain translate + scale that the compositor applies without
   * rebuilding anything. Without a source it materialises on the stage at that moment.
   */
  function flyIn(o, src, s) {
    const A = SOL.Anim;
    const E = A.ease;
    if (src) {
      const x0 = src.cx - M.ox - M.cx;
      const y0 = src.cy - M.oy - M.cy;
      const s0 = src.w / M.W;
      o.x = x0;
      o.y = y0;
      o.s = s0;
      // (a source that lies face down is stood in for face down, and turns over on the way in)
      o.yaw = C.sourceEl && C.sourceEl.classList && C.sourceEl.classList.contains('is-face-down') ? 180 : 0;
      o.pitch = 0;
      o.light = 0;
      o.ground = 0;
      o.pendingSpin = true;
      const limit = compactBelow();
      const small = src.w < limit;
      pinLayout(o, small);
      const path = A.arc({ x: x0, y: y0 }, { x: 0, y: 0 }, { lift: Math.min(80, Math.hypot(x0, y0) * 0.16) });
      const turn = x0 > 0 ? -1 : 1; // it rolls into the direction it travels
      const t0 = Math.min(0.62, (COVER_MS * A.speed) / 640); // progress at which the lighting may start
      o.fly = A.tween({
        duration: 640,
        ease: 'linear',
        update: function (t) {
          const e = E.inOutSine(t); // a gentle lift-off, then away
          const p = path(e);
          o.x = p.x;
          o.y = p.y;
          o.s = lerp(s0, 1, e);
          if (small && o.s * M.W >= limit) pinLayout(o, false);
          o.light = s.covered ? clamp((t - t0) / 0.3, 0, 1) : 0;
          o.ground = s.covered ? clamp((t - 0.5) / 0.5, 0, 1) : 0;
          o.dirty = true;
        },
        done: function () {
          o.fly = null;
          o.light = 1;
          o.ground = 1;
          o.dirty = true;
          pinLayout(o, false);
        },
      });
      s.coverWait.then(function () {
        if (o.dead || o.retired || !o.pendingSpin) return;
        // one full turn on the way in, carried by a spring so it lands with a little life
        springRot(o, { yaw: REST_YAW + 360 * turn, pitch: REST_PITCH }, { yaw: turn * 700, pitch: -40 }, 48, 11.5);
        play('whoosh', { duration: 300, volume: 0.5 });
      });
    } else {
      const y0 = M.H * 0.14;
      o.y = y0;
      o.s = 0.74;
      o.alpha = 0;
      o.ground = 0;
      o.yaw = REST_YAW - 140;
      o.pendingSpin = true;
      s.coverWait.then(function () {
        if (o.dead || o.retired) return;
        o.fly = A.tween({
          duration: 500,
          ease: 'outCubic',
          update: function (e, t) {
            o.y = lerp(y0, 0, e);
            o.s = lerp(0.74, 1, e);
            o.alpha = clamp(t / 0.4, 0, 1);
            o.ground = e;
            o.dirty = true;
          },
          done: function () {
            o.fly = null;
          },
        });
        if (o.pendingSpin) springRot(o, { yaw: REST_YAW, pitch: REST_PITCH }, { yaw: 0, pitch: 0 }, 50, 10.5);
      });
    }
  }

  /**
   * Sends a card away: into `targetEl`'s current on-screen rectangle when it has one (landing flat, exactly
   * covering it), otherwise a quick fade. Resolves when it has landed; the caller removes it.
   */
  function flyOut(o, targetEl) {
    if (!o || o.dead) return Promise.resolve();
    const A = SOL.Anim;
    const E = A.ease;
    const wasActive = C.active === o;
    releaseObj(o);
    o.retired = true;
    // whatever idle float / device tilt was showing becomes the starting pose
    const f = {
      x: o.x + o.nx,
      y: o.y + o.by + (wasActive ? C.idle.y : 0),
      s: o.s * o.zoom * (1 + o.pop),
      yaw: o.yaw + (wasActive ? C.idle.yaw + C.tilt.yaw : 0),
      pitch: o.pitch + (wasActive ? C.idle.pitch + C.tilt.pitch : 0),
      roll: o.roll + o.br + (wasActive ? C.idle.roll : 0),
      light: o.light,
      g: o.ground,
      a: o.alpha,
    };
    if (wasActive) {
      const idle = C.idle;
      idle.amp = idle.t = idle.yaw = idle.pitch = idle.roll = idle.y = 0;
      C.tilt.yaw = C.tilt.pitch = 0;
      C.tilt.has = false;
    }
    o.nx = o.by = o.br = o.pop = 0;
    o.zoom = o.zoomT = 1;
    o.x = f.x;
    o.y = f.y;
    o.s = f.s;
    o.yaw = f.yaw;
    o.pitch = f.pitch;
    o.roll = f.roll;
    const dst = rectOf(targetEl);
    let handle;
    if (dst) {
      const x1 = dst.cx - M.ox - M.cx;
      const y1 = dst.cy - M.oy - M.cy;
      const s1 = dst.w / M.W;
      const faceDown = !!(targetEl.classList && targetEl.classList.contains('is-face-down'));
      const yaw1 = nearest(f.yaw, faceDown ? 180 : 0, 360);
      const pitch1 = nearest(f.pitch, 0, 360);
      const roll1 = nearest(f.roll, 0, 360);
      const limit = compactBelow();
      const small = dst.w < limit;
      const path = A.arc({ x: f.x, y: f.y }, { x: x1, y: y1 }, { lift: Math.min(60, Math.hypot(x1 - f.x, y1 - f.y) * 0.12) });
      handle = A.tween({
        duration: 460,
        ease: 'linear',
        update: function (t) {
          const e = E.inOutCubic(t);
          const p = path(e);
          o.x = p.x;
          o.y = p.y;
          o.s = lerp(f.s, s1, e);
          if (small && o.s * M.W < limit) pinLayout(o, true);
          const er = E.outCubic(Math.min(1, t / 0.85));
          o.yaw = lerp(f.yaw, yaw1, er);
          o.pitch = lerp(f.pitch, pitch1, er);
          o.roll = lerp(f.roll, roll1, er);
          o.light = f.light * (1 - clamp((t - 0.35) / 0.55, 0, 1));
          o.ground = f.g * (1 - clamp(t / 0.3, 0, 1));
          o.dirty = true;
        },
      });
    } else {
      handle = A.tween({
        duration: 240,
        ease: 'outCubic',
        update: function (e) {
          o.alpha = f.a * (1 - e);
          o.s = f.s * (1 - 0.12 * e);
          o.y = f.y + e * M.H * 0.05;
          o.ground = f.g * (1 - e);
          o.dirty = true;
        },
      });
    }
    own(o, handle);
    return handle.finished;
  }

  function fadeObj(o, ms) {
    if (o.dead) return;
    const a0 = o.alpha;
    own(
      o,
      SOL.Anim.tween({
        duration: ms,
        ease: 'linear',
        update: function (t) {
          o.alpha = a0 * (1 - t);
          o.dirty = true;
        },
      })
    );
  }

  // ------------------------------------------------------------------ card view lifecycle
  function startCardView(s, p) {
    C.live = true;
    C.returning = false;
    C.list = p.list;
    C.index = Math.max(0, p.list.indexOf(p.id));
    C.back = p.back;
    C.sourceEl = p.sourceEl || null;
    C.sourceId = p.id;
    C.elementFor = typeof p.elementFor === 'function' ? p.elementFor : null;
    C.fromGallery = !!p.fromGallery;
    C.hideSource =
      p.hideSource !== undefined && p.hideSource !== null
        ? !!p.hideSource
        : !!(C.sourceEl && C.sourceEl.classList && C.sourceEl.classList.contains('card'));
    C.spin = false;
    C.spinDir = 1;
    ui.btn.spin.setAttribute('aria-pressed', 'false');
    ui.btn.spin.classList.remove('is-on');
    C.pointers.clear();
    C.g = null;
    C.lastTap = null;
    C.keyReturnAt = 0;
    C.zoomed = false;
    ui.cardView.classList.remove('is-zoomed');
    C.fg = 0;
    C.floorKey = '';
    C.lastInput = nowMs();
    const idle = C.idle;
    idle.amp = idle.t = idle.yaw = idle.pitch = idle.roll = idle.y = 0;

    const src = rectOf(C.sourceEl); // measured before our own layout work
    setView(s, 'card');
    layout();
    const o = makeObj(p.id);
    attach(o);
    C.active = o;
    flyIn(o, src, s);
    renderObj(o, true); // first frame: already standing in for the source when it disappears
    if (src && C.hideSource) hideSourceEl(C.sourceEl);
    updateCaption();
    ui.name.removeAttribute('data-dir');
    updateNav();
    showHint();
    startTilt();
    syncLoop();
    ui.root.focus({ preventScroll: true });
  }

  /**
   * The element on the table a card flies home to: the source it came out of, or — after previous / next —
   * that card's own element when someone can tell us where it is. null: it just fades.
   */
  function homeOf(id) {
    if (id === C.sourceId && C.sourceEl) return C.sourceEl;
    try {
      if (C.elementFor) return C.elementFor(id) || null;
      if (C.sourceEl && SOL.Board && typeof SOL.Board.cardEl === 'function') return SOL.Board.cardEl(id) || null;
    } catch (err) {
      /* no home: fade */
    }
    return null;
  }

  function destroyCardView() {
    if (!C.live) return;
    C.live = false;
    C.returning = false;
    C.elementFor = null;
    for (const o of C.objs.slice()) destroyObj(o);
    C.objs.length = 0;
    C.active = null;
    C.sourceEl = null;
    C.pointers.clear();
    C.g = null;
    unhideSource();
    stopTilt();
    hideHint();
    ui.name.textContent = ''; // the caption's letters are DOM too: nothing of a closed inspector stays behind
    ui.meta.textContent = '';
    ui.cardView.classList.remove('is-zoomed');
    ui.shadowCore.style.opacity = '0';
    ui.shadowSoft.style.opacity = '0';
    C.floorKey = '';
    C.fg = 0;
  }

  // ------------------------------------------------------------------ gestures on the stage
  /** Is the viewport point over the card's resting footprint (plus `pad` px)? No layout read: pure maths. */
  function overCard(x, y, pad) {
    const o = C.active;
    if (!o) return false;
    const sc = o.s * o.zoom;
    return (
      Math.abs(x - (M.ox + M.cx + o.x)) <= (M.W * sc) / 2 + pad && Math.abs(y - (M.oy + M.cy + o.y)) <= (M.H * sc) / 2 + pad
    );
  }

  function pushSample(g, x, y) {
    g.samples.push({ t: nowMs(), x: x, y: y });
    if (g.samples.length > 10) g.samples.shift();
  }

  /** Release velocity in px/s from the last ~80ms of movement; zero when the finger rested before lifting. */
  function releaseVelocity(g) {
    const sm = g.samples;
    const n = sm.length;
    if (n < 2) return { x: 0, y: 0 };
    const last = sm[n - 1];
    if (nowMs() - last.t > 110) return { x: 0, y: 0 };
    let i = n - 2;
    while (i > 0 && last.t - sm[i].t < 70) i--;
    const first = sm[i];
    const dt = last.t - first.t;
    if (dt < 6) return { x: 0, y: 0 };
    return { x: ((last.x - first.x) / dt) * 1000, y: ((last.y - first.y) / dt) * 1000 };
  }

  function grab(o) {
    stopRot(o);
    o.pendingSpin = false;
    C.keyReturnAt = 0;
  }

  function newGesture(p, mode, onCard) {
    const o = C.active;
    return {
      mode: mode, // 'rotate' | 'edge' (undecided: began beside the card) | 'swipe' | 'pinch'
      id: p.id,
      sx: p.x,
      sy: p.y,
      lx: p.x,
      ly: p.y,
      t0: nowMs(),
      moved: 0,
      samples: [{ t: nowMs(), x: p.x, y: p.y }],
      onCard: onCard,
      tapOK: true,
      turning: false,
      noFling: false,
      // Past edge-on in pitch the card is upside-down: a rightward drag must still move the near surface right.
      dir: Math.cos(o.pitch * DEG) >= 0 ? 1 : -1,
    };
  }

  function onStageDown(e) {
    const s = session;
    const o = C.active;
    if (!s || s.closing || s.view !== 'card' || !o || o.dead || o.retired || C.returning) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (C.pointers.size >= 2) return; // a third finger is ignored
    e.preventDefault();
    try {
      ui.stage.setPointerCapture(e.pointerId);
    } catch (err) {
      /* synthetic pointer: capture is a nicety */
    }
    const p = { id: e.pointerId, x: e.clientX, y: e.clientY };
    C.pointers.set(e.pointerId, p);
    touch();
    if (C.pointers.size === 1) {
      const onCard = overCard(p.x, p.y, 14);
      const sc = o.s * o.zoom;
      const beside = !onCard && Math.abs(p.x - (M.ox + M.cx + o.x)) > (M.W * sc) / 2;
      C.g = newGesture(p, beside ? 'edge' : 'rotate', onCard);
      if (!beside) grab(o);
    } else {
      beginPinch();
    }
  }

  function beginPinch() {
    const o = C.active;
    const pts = Array.from(C.pointers.values());
    const dx = pts[1].x - pts[0].x;
    const dy = pts[1].y - pts[0].y;
    grab(o);
    if (o.zoomS) o.zoomS.cancel();
    if (o.rollS) o.rollS.cancel();
    o.zoomS = o.rollS = null;
    if (o.nx !== 0) springNx(o, 0);
    C.g = {
      mode: 'pinch',
      d0: Math.max(24, Math.hypot(dx, dy)),
      a: Math.atan2(dy, dx) / DEG,
      zoom0: o.zoom,
      tapOK: false,
    };
  }

  function onStageMove(e) {
    const p = C.pointers.get(e.pointerId);
    const g = C.g;
    const o = C.active;
    if (!p || !g || !o || o.dead) return;
    p.x = e.clientX;
    p.y = e.clientY;
    C.lastInput = nowMs();
    if (g.mode === 'pinch') {
      const pts = Array.from(C.pointers.values());
      if (pts.length < 2) return;
      const dx = pts[1].x - pts[0].x;
      const dy = pts[1].y - pts[0].y;
      const a = Math.atan2(dy, dx) / DEG;
      o.zoom = o.zoomT = rubber((g.zoom0 * Math.hypot(dx, dy)) / g.d0, ZOOM_MIN, ZOOM_MAX, 0.4);
      o.roll += wrap180(a - g.a); // twist
      g.a = a;
      o.dirty = true;
      return;
    }
    if (e.pointerId !== g.id) return;
    const dx = p.x - g.lx;
    const dy = p.y - g.ly;
    g.lx = p.x;
    g.ly = p.y;
    const tx = p.x - g.sx;
    const ty = p.y - g.sy;
    g.moved = Math.max(g.moved, Math.hypot(tx, ty));
    pushSample(g, p.x, p.y);
    if (g.mode === 'edge') {
      if (g.moved < TAP_SLOP) return;
      if (Math.abs(tx) >= Math.abs(ty)) {
        g.mode = 'swipe';
      } else {
        g.mode = 'rotate';
        grab(o);
      }
    }
    if (g.mode === 'swipe') {
      // the card leans after the finger; at either end of the list it barely gives
      const dir = tx < 0 ? 1 : -1;
      const ni = C.index + dir;
      const open = ni >= 0 && ni < C.list.length;
      if (o.navS) {
        o.navS.cancel();
        o.navS = null;
      }
      o.nx = tx * (open ? 0.5 : 0.16);
      o.dirty = true;
      return;
    }
    if (!g.turning) {
      if (g.moved < 3) return; // keeps taps perfectly still
      g.turning = true;
    }
    o.yaw += dx * M.sens * g.dir;
    o.pitch -= dy * M.sens;
    o.dirty = true;
  }

  function dropPointer(e) {
    const p = C.pointers.get(e.pointerId);
    if (!p) return null;
    C.pointers.delete(e.pointerId);
    try {
      if (ui.stage.hasPointerCapture && ui.stage.hasPointerCapture(e.pointerId)) ui.stage.releasePointerCapture(e.pointerId);
    } catch (err) {
      /* already released */
    }
    return p;
  }

  function onStageUp(e) {
    const p = dropPointer(e);
    const g = C.g;
    if (!p || !g) return;
    const o = C.active;
    C.lastInput = nowMs();
    if (g.mode === 'pinch') {
      endPinch();
      return;
    }
    if (e.pointerId !== g.id) return;
    C.g = null;
    if (!o || o.dead || o.retired) return;
    const tap = g.tapOK && g.moved < TAP_SLOP && nowMs() - g.t0 < TAP_MS;
    if (tap) {
      if (o.nx !== 0) springNx(o, 0);
      onStageTap(o, g);
      return;
    }
    const v = releaseVelocity(g);
    if (g.mode === 'swipe') {
      const tx = p.x - g.sx;
      const dir = tx < 0 ? 1 : -1;
      const far = Math.abs(tx) > Math.max(44, M.W * 0.2);
      const fast = Math.abs(v.x) > 480 && v.x * tx > 0;
      if (!(far || fast) || !navigate(dir)) springNx(o, 0, v.x * 0.5);
      return;
    }
    if (g.mode === 'edge' || g.noFling || !g.turning) {
      settle(o);
      return;
    }
    releaseRot(o, g, v);
  }

  function onStageTap(o, g) {
    if (!g.onCard) {
      // beside the card: the backdrop closes (or goes back to the gallery)
      settle(o);
      back();
      return;
    }
    const t = nowMs();
    const lt = C.lastTap;
    if (lt && t - lt.t < DOUBLE_TAP_MS && Math.hypot(g.sx - lt.x, g.sy - lt.y) < 48) {
      C.lastTap = null;
      flip(o);
      return;
    }
    C.lastTap = { t: t, x: g.sx, y: g.sy };
    // a single tap pokes the card: the touched corner dips away and it wobbles back
    const sc = o.s * o.zoom;
    const ux = clamp((g.sx - (M.ox + M.cx + o.x)) / ((M.W * sc) / 2), -1, 1);
    const uy = clamp((g.sy - (M.oy + M.cy + o.y)) / ((M.H * sc) / 2), -1, 1);
    springRot(o, restTarget(o), { yaw: ux * 150, pitch: -uy * 120 }, 96, 9.5);
    haptic('tick');
  }

  /** The finger let go of a rotating card: fling (flip / full turn / tumble) or spring back to rest. */
  function releaseRot(o, g, v) {
    const vyaw = v.x * M.sens * g.dir;
    const vpitch = -v.y * M.sens;
    const ax = Math.abs(v.x);
    const ay = Math.abs(v.y);
    if (C.spin) {
      // a flick sets the spinning direction; the tilt relaxes
      if (Math.abs(vyaw) > 90) C.spinDir = vyaw > 0 ? 1 : -1;
      springRot(o, { pitch: nearest(o.pitch, REST_PITCH, 360) }, { pitch: vpitch }, 58, 11);
      return;
    }
    if (Math.abs(vyaw) > FLING_YAW && ax >= ay * 0.8) {
      // carried by its own momentum to the resting pose it would reach — at least over to the other side
      const here = nearest(o.yaw, REST_YAW, 180);
      let target = nearest(clamp(o.yaw + vyaw * 0.34, o.yaw - 800, o.yaw + 800), REST_YAW, 180);
      if (target === here) target += 180 * (vyaw > 0 ? 1 : -1);
      C.spinDir = vyaw > 0 ? 1 : -1;
      springRot(o, { yaw: target, pitch: nearest(o.pitch, REST_PITCH, 360) }, { yaw: vyaw, pitch: vpitch }, 34, 9.2);
      play('whoosh', { duration: 300, volume: 0.5 });
      if (Math.round((target - here) / 180) % 2 !== 0) play('flip', { delay: 140, volume: 0.7 });
      haptic('tap');
      announceFace(o);
      return;
    }
    if (Math.abs(vpitch) > FLING_PITCH && ay > ax) {
      // a vertical fling tumbles it head over heels, a full turn at a time
      let target = nearest(clamp(o.pitch + vpitch * 0.34, o.pitch - 760, o.pitch + 760), REST_PITCH, 360);
      if (target === nearest(o.pitch, REST_PITCH, 360) && Math.abs(vpitch) > 900) target += 360 * (vpitch > 0 ? 1 : -1);
      springRot(o, { yaw: nearest(o.yaw, REST_YAW, 180), pitch: target }, { yaw: vyaw, pitch: vpitch }, 34, 9.2);
      play('whoosh', { duration: 300, volume: 0.5 });
      haptic('tap');
      return;
    }
    springRot(o, restTarget(o), { yaw: vyaw, pitch: vpitch }, 58, 11);
  }

  function endPinch() {
    const o = C.active;
    C.g = null;
    if (!o || o.dead || o.retired) return;
    // the zoom stays where the fingers left it (pulled back into range); the twist relaxes
    if (o.zoom < ZOOM_MIN || o.zoom > ZOOM_MAX) zoomTo(o, o.zoom, 170);
    else o.zoomT = o.zoom;
    rollTo(o, nearest(o.roll, 0, 360));
    const rest = Array.from(C.pointers.values());
    if (rest.length === 1) {
      // the finger that stayed goes on rotating, but its release is neither a tap nor a fling
      const g = newGesture(rest[0], 'rotate', true);
      g.tapOK = false;
      g.noFling = true;
      g.turning = true;
      g.moved = TAP_SLOP + 1;
      C.g = g;
    } else {
      settle(o);
    }
  }

  function onStageCancel(e) {
    const p = dropPointer(e);
    if (!p) return;
    const o = C.active;
    if (C.pointers.size === 0) {
      const g = C.g;
      C.g = null;
      if (o && !o.dead && !o.retired) {
        if (g && g.mode === 'pinch') {
          if (o.zoom < ZOOM_MIN || o.zoom > ZOOM_MAX) zoomTo(o, o.zoom, 170);
          rollTo(o, nearest(o.roll, 0, 360));
        }
        if (o.nx !== 0) springNx(o, 0);
        settle(o);
      }
    } else if (C.g && C.g.mode === 'pinch') {
      endPinch();
    }
  }

  function onStageLost(e) {
    // capture taken away without an up / cancel (window blur, DOM change): treat as cancelled
    if (C.pointers.has(e.pointerId)) onStageCancel(e);
  }

  /** Forget every pointer and let the card settle (visibility change, closing, leaving the card view). */
  function cancelGesture() {
    if (!ui) return;
    for (const id of Array.from(C.pointers.keys())) {
      try {
        if (ui.stage.hasPointerCapture && ui.stage.hasPointerCapture(id)) ui.stage.releasePointerCapture(id);
      } catch (err) {
        /* ignore */
      }
    }
    C.pointers.clear();
    const had = C.g;
    C.g = null;
    const o = C.active;
    if (had && o && !o.dead && !o.retired) {
      if (o.nx !== 0) springNx(o, 0);
      rollTo(o, nearest(o.roll, 0, 360));
      settle(o);
    }
    if (G.live) galleryCancelDrag();
  }

  // ====================================================================================================
  // DECK GALLERY
  // ====================================================================================================

  /**
   * One-dimensional drag / fling / snap controller shared by the card carousel and the card-back row.
   * Positions are in items (0 = first). cfg:
   *   surface          element that receives the pointers
   *   get() / set(v)   position accessors (set also renders)
   *   max()            last index
   *   unit()           px of finger travel per item
   *   fixed()          optional: true when the row does not scroll (presses can still be taps)
   *   locked()         optional: true while input must be ignored
   *   onTap(target)    a press that did not move; target = the element that was pressed
   */
  function makeFlinger(cfg) {
    const F = { drag: null, anim: null, target: null, wheelAcc: 0, wheelAt: 0 };
    const el = cfg.surface;

    function stop() {
      if (F.anim) F.anim.cancel();
      F.anim = null;
      F.target = null;
    }

    /** Spring to `target` (clamped), starting at `velocity` items/s. */
    function to(target, velocity) {
      stop();
      target = clamp(target, 0, Math.max(0, cfg.max()));
      const from = cfg.get();
      if (Math.abs(from - target) < 0.0005 && !velocity) {
        cfg.set(target);
        return;
      }
      F.target = target;
      const sp = SOL.Anim.spring({
        from: from,
        to: target,
        velocity: velocity || 0,
        stiffness: 140,
        damping: 22,
        precision: 0.002,
        update: function (v) {
          cfg.set(v);
        },
        done: function () {
          if (F.anim === sp) {
            F.anim = null;
            F.target = null;
          }
        },
      });
      F.anim = sp;
    }

    /**
     * Let go at `v` items/s: glide on, slowing down, and stop exactly on a card. `carry` is where an earlier
     * glide was heading when this drag caught it: flicking again the same way keeps that leftover distance, so
     * repeated flicks build up speed through the deck.
     */
    function fling(v, carry, p0) {
      const from = cfg.get();
      const max = Math.max(0, cfg.max());
      const reach = v * 0.3 + (v < 0 ? -1 : 1) * v * v * 0.011;
      const base = typeof carry === 'number' && (carry - from) * v > 0 ? carry : from;
      const target = clamp(Math.round(base + reach), 0, max);
      const dist = target - from;
      if (Math.abs(v) < 1.4 || Math.abs(dist) < 0.8 || from < 0 || from > max) {
        // Slow release (or let go beyond an end): settle on a card. Which one leans the way the finger went: a
        // card dragged a good quarter of the way is meant to change, it need not be hauled past the middle.
        const moved = typeof p0 === 'number' ? from - p0 : 0;
        const lean = Math.abs(moved) > 0.24 ? (moved > 0 ? 0.26 : -0.26) : 0;
        to(Math.round(from + clamp(v * 0.14 + lean, -0.55, 0.55)), v);
        return;
      }
      stop();
      F.target = target;
      // outQuart starts at four times its mean speed: pick the duration so that it starts at the finger's speed
      const dur = clamp(((4 * Math.abs(dist)) / Math.abs(v)) * 1000, 420, 1800);
      const tw = SOL.Anim.tween({
        duration: dur,
        ease: 'outQuart',
        from: from,
        to: target,
        update: function (val) {
          cfg.set(val);
        },
        done: function () {
          if (F.anim === tw) {
            F.anim = null;
            F.target = null;
          }
        },
      });
      F.anim = tw;
    }

    function step(n) {
      const base = F.target !== null ? F.target : Math.round(cfg.get());
      to(base + n);
    }

    function wheel(delta) {
      const t = nowMs();
      if (t - F.wheelAt > 260) F.wheelAcc = 0;
      F.wheelAt = t;
      F.wheelAcc += delta;
      const n = Math.trunc(F.wheelAcc / 56);
      if (n) {
        F.wheelAcc -= n * 56;
        step(n);
      }
    }

    function cancelDrag() {
      const d = F.drag;
      if (!d) return;
      F.drag = null;
      try {
        if (el.hasPointerCapture && el.hasPointerCapture(d.id)) el.releasePointerCapture(d.id);
      } catch (err) {
        /* ignore */
      }
      if (!(cfg.fixed && cfg.fixed())) to(Math.round(cfg.get()));
    }

    el.addEventListener('pointerdown', function (e) {
      if (F.drag || (cfg.locked && cfg.locked())) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      // Catching a carousel that is still travelling is a catch, not a tap on whatever passes under the finger.
      const carry = F.anim && F.target !== null ? F.target : null;
      const caught = carry !== null && Math.abs(cfg.get() - carry) > 0.6;
      if (!(cfg.fixed && cfg.fixed())) stop();
      F.drag = {
        id: e.pointerId,
        sx: e.clientX,
        sy: e.clientY,
        p0: cfg.get(),
        t0: nowMs(),
        moved: 0,
        sliding: false,
        caught: caught,
        carry: carry,
        hit: e.target,
        samples: [{ t: nowMs(), x: e.clientX, y: e.clientY }],
      };
      try {
        el.setPointerCapture(e.pointerId);
      } catch (err) {
        /* synthetic pointer */
      }
    });

    el.addEventListener('pointermove', function (e) {
      const d = F.drag;
      if (!d || e.pointerId !== d.id) return;
      d.moved = Math.max(d.moved, Math.hypot(e.clientX - d.sx, e.clientY - d.sy));
      pushSample(d, e.clientX, e.clientY);
      if (cfg.fixed && cfg.fixed()) return;
      if (!d.sliding) {
        if (d.moved < 4) return;
        d.sliding = true;
      }
      cfg.set(rubber(d.p0 - (e.clientX - d.sx) / cfg.unit(), 0, Math.max(0, cfg.max()), 0.9));
    });

    el.addEventListener('pointerup', function (e) {
      const d = F.drag;
      if (!d || e.pointerId !== d.id) return;
      F.drag = null;
      try {
        if (el.hasPointerCapture && el.hasPointerCapture(d.id)) el.releasePointerCapture(d.id);
      } catch (err) {
        /* ignore */
      }
      const fixed = !!(cfg.fixed && cfg.fixed());
      if (d.moved < TAP_SLOP && nowMs() - d.t0 < TAP_MS) {
        if (d.caught) to(Math.round(cfg.get()));
        else if (cfg.onTap(d.hit) !== true && !fixed) to(Math.round(cfg.get()));
        return;
      }
      if (fixed) return;
      fling(-releaseVelocity(d).x / cfg.unit(), d.carry, d.p0);
    });

    el.addEventListener('pointercancel', cancelDrag);

    F.stop = stop;
    F.to = to;
    F.step = step;
    F.wheel = wheel;
    F.cancelDrag = cancelDrag;
    return F;
  }

  function galleryInteractive() {
    const s = session;
    return !!s && !s.closing && s.view === 'gallery' && G.live && !C.live;
  }

  function normFilter(f) {
    if (typeof f === 'number' && f >= 0 && f <= 3) return f | 0;
    const i = SUIT_NAMES.indexOf(f);
    return i === -1 ? 'all' : i;
  }

  function listFor(filter) {
    const out = [];
    if (filter === 'all') for (let i = 0; i < 52; i++) out.push(i);
    else for (let r = 0; r < 13; r++) out.push(filter * 13 + r);
    return out;
  }

  // ------------------------------------------------------------------ carousel: layout + virtualised rendering
  function layoutGallery() {
    const rr = ui.ring.getBoundingClientRect();
    if (rr.width > 0 && rr.height > 0) {
      // Portrait: the width decides (the neighbours have to peek in on both sides). Landscape / desktop: the height.
      const cw = Math.min(rr.width * 0.52, (rr.height * 0.8) / 1.4, 300);
      G.cw = Math.max(72, Math.round(cw));
      G.ringW = rr.width;
      ui.ring.style.setProperty('--card-w', G.cw + 'px');
      ui.ring.style.setProperty('--insp-persp', Math.round(G.cw * ARC_PERSP) + 'px');
      // R = how many neighbours on each side are shown at full strength: the ones that can be seen. One more per
      // side fades in / out while the carousel moves, so the DOM holds 2R+1 cards at rest and 2R+2 on the move:
      // 7..8 on a portrait phone, 11..12 in landscape and on a desktop.
      const half = rr.width / 2;
      const P = G.cw * ARC_PERSP;
      // The arc spreads out as far as the screen lets it: packed like a fanned deck on a portrait phone, wide
      // open on a desktop (ARC_MAX cards a side, the last one about at the edge; 0.8 = what perspective leaves
      // of a far card's offset, 0.2 = half of what a turned card covers on screen, both in card widths).
      G.xn = clamp(((half / G.cw - 0.2) / 0.8 - ARC_X1) / (ARC_MAX - 1), ARC_XN, ARC_XN_WIDE);
      const depth = function (d) {
        const o = d - 1;
        return G.cw * (ARC_Z1 + ARC_ZN * o + ARC_ZQ * o * o);
      };
      const reach = function (d) {
        if (d <= 0) return 0;
        return (G.cw * (ARC_X1 + G.xn * (d - 1)) * P) / (P + depth(d)); // middle of that card on screen
      };
      // Every card stands behind the one before it, so what shows of card d + 1 is the strip beyond the outer
      // edge of card d (its middle + about 0.2 card widths).
      let R = 2;
      while (R < ARC_MAX && reach(R) + G.cw * 0.2 < half) R++;
      G.radius = M.low ? Math.min(R, 4) : R;
      // The eye sits above the cards (inspector.css), so the far ones also stand higher on screen. As high as
      // looks good (1.5 card widths) — but the farthest card must not rise out of the top of the carousel.
      // (measured at its nearer, taller edge: a turned card comes 0.45 card widths towards the eye)
      const sFar = P / (P + depth(R) - 0.45 * G.cw);
      const room = rr.height * 0.47 - 0.7 * sFar * G.cw - 12;
      const eye = clamp(room / (1 - sFar), 0, G.cw * 1.5);
      ui.ring.style.setProperty('--insp-eye', Math.round(eye) + 'px');
      const sr = ui.scrub.getBoundingClientRect();
      G.scrubL = sr.left + 12;
      G.scrubW = Math.max(1, sr.width - 24);
      G._sx = NaN;
      for (const it of G.items.values()) it._t = '';
    }
    const br = ui.row.getBoundingClientRect();
    if (br.width > 0 && br.height > 0) {
      const B = G.backs;
      const n = B.items.length || 6;
      const labelH = 46;
      const byHeight = ((br.height - labelH) * 0.82) / 1.4;
      let bw = Math.min(br.width * 0.6, byHeight, 260);
      // when all six fit side by side (desktop, tablets, most landscape phones) the row does not scroll
      const fitW = (br.width - 32) / (n * 1.24);
      B.fits = fitW >= 96;
      if (B.fits) bw = Math.min(byHeight, fitW, 220);
      B.bw = Math.max(64, Math.round(bw));
      B.gap = B.fits ? B.bw * 1.24 : B.bw + 20; // on a phone the neighbours peek in from both sides
      B.rowW = br.width;
      ui.row.style.setProperty('--card-w', B.bw + 'px');
      ui.row.style.setProperty('--insp-persp', Math.round(B.bw * 4.6) + 'px');
      B.lean = B.fits && (SOL.Platform ? !!SOL.Platform.isTouch : 'ontouchstart' in root); // see setBackThick()
      ui.row.classList.toggle('is-fit', B.fits);
      if (B.fits) B.pos = (n - 1) / 2;
      else B.pos = clamp(Math.round(B.pos), 0, n - 1);
      for (const it of B.items) it._t = '';
    }
  }

  function attachItem(id) {
    let card = G.cache.get(id);
    if (!card) {
      card = SOL.Cards.create(id, { back: G.backs.selected });
      G.cache.set(id, card);
    }
    const el = h('div', 'insp-gal__item', { 'data-id': String(id) });
    const veil = h('i', 'insp-gal__veil');
    el.appendChild(card);
    el.appendChild(veil);
    ui.ring.appendChild(el);
    const it = { id: id, el: el, card: card, veil: veil, idx: 0, keep: true, exiting: false, fresh: false, from: undefined, _t: '', _v: -1, _o: -1, _z: -1 };
    G.items.set(id, it);
    return it;
  }

  function detachItem(it) {
    if (it.el.parentNode) it.el.parentNode.removeChild(it.el);
    G.items.delete(it.id);
  }

  /**
   * Cover-flow on an arc. d = distance from the focus in cards (fractional while moving). The focused card
   * faces the viewer at z = 0 (so its on-screen box is exactly its layout box — the inspector flies in and out
   * of it); its neighbours step aside, turn inwards and recede, further ones follow the arc and darken.
   */
  function placeItem(it, d, dy, alpha) {
    const cw = G.cw;
    const ad = Math.abs(d);
    const sg = d < 0 ? -1 : 1;
    const t = ad < 1 ? ad : 1;
    const o = ad - t;
    const e = t * t * (3 - 2 * t);
    const x = sg * cw * (ARC_X1 * e + G.xn * o);
    const z = -cw * (ARC_Z1 * e + ARC_ZN * o + ARC_ZQ * o * o);
    const ry = -sg * (ARC_RY1 * e + ARC_RYN * o);
    const tf = 'translate3d(' + r1(x) + 'px,' + r1(dy) + 'px,' + r1(z) + 'px) rotateY(' + r1(ry) + 'deg)';
    if (tf !== it._t) {
      it.el.style.transform = tf;
      it._t = tf;
    }
    // (the light falls off along the arc: quickly at first, then ever more slowly)
    const va = ad < 6 ? ad : 6;
    const veil = Math.round(clamp(0.25 * va - 0.021 * va * va, 0, 0.76) * 50) / 50;
    if (veil !== it._v) {
      it.veil.style.opacity = String(veil);
      it._v = veil;
    }
    // fade at the edge of the virtual window, so cards entering / leaving the DOM never pop
    const op = Math.round(clamp(G.radius + 1 - ad, 0, 1) * alpha * 50) / 50;
    if (op !== it._o) {
      it.el.style.opacity = String(op);
      it._o = op;
    }
    // stacking by rank: it only changes at the instant two cards trade places
    const zi = 100 - Math.round(ad);
    if (zi !== it._z) {
      it.el.style.zIndex = String(zi);
      it._z = zi;
    }
  }

  function renderCarousel() {
    if (!G.live) return;
    const n = G.list.length;
    const R = G.radius;
    const pos = G.pos;
    const m = G.morph;
    const cw = G.cw;
    const settled = !m || m.t >= 0.36; // re-flow: nothing new joins before the leavers are gone (DOM stays small)
    if (settled) {
      const lo = Math.max(0, Math.ceil(pos - R - 0.999));
      const hi = Math.min(n - 1, Math.floor(pos + R + 0.999));
      for (const it of G.items.values()) it.keep = false;
      for (let i = lo; i <= hi; i++) {
        const id = G.list[i];
        let it = G.items.get(id);
        if (!it) {
          it = attachItem(id);
          it.fresh = !!m;
        } else if (it.exiting) {
          it.exiting = false;
          it.from = undefined;
          it.fresh = !!m;
        }
        it.idx = i;
        it.keep = true;
      }
      for (const it of Array.from(G.items.values())) if (!it.keep) detachItem(it);
    }
    for (const it of G.items.values()) {
      let d = it.idx - pos;
      let dy = 0;
      let alpha = 1;
      if (m) {
        if (it.exiting) {
          // leavers drop away, the outer ones a touch later
          d = it.from;
          const p = clamp((m.t - 0.012 * Math.min(6, Math.abs(d))) / 0.27, 0, 1);
          dy = cw * 0.62 * p * p;
          alpha = 1 - p;
        } else if (it.from !== undefined) {
          // stayers glide to their new place
          const p = clamp(m.t / 0.7, 0, 1);
          d = lerp(it.from, d, p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
        } else if (it.fresh) {
          // newcomers are dealt in from above, the centre first
          const p = clamp((m.t - 0.36 - 0.034 * Math.min(6, Math.abs(d))) / 0.4, 0, 1);
          const e = 1 - Math.pow(1 - p, 3);
          dy = -cw * 0.46 * (1 - e);
          alpha = p;
        }
      }
      placeItem(it, d, dy, alpha);
    }
    const f = clamp(Math.round(pos), 0, n - 1);
    if (f !== G.focus || G.focusList !== G.list) {
      G.focus = f;
      G.focusList = G.list;
      onGalleryFocus();
    }
    const frac = n > 1 ? clamp(pos / (n - 1), 0, 1) : 0.5;
    const sx = r1(frac * G.scrubW);
    if (sx !== G._sx) {
      ui.scrubThumb.style.transform = 'translate3d(' + sx + 'px,0,0)';
      G._sx = sx;
    }
  }

  function onGalleryFocus() {
    const id = G.list[G.focus];
    const info = SOL.Cards.info(id);
    ui.galName.textContent = info.label;
    ui.galName.setAttribute('data-color', info.color);
    ui.galCount.textContent = G.focus + 1 + ' / ' + G.list.length;
    ui.scrub.setAttribute('aria-valuemax', String(G.list.length));
    ui.scrub.setAttribute('aria-valuenow', String(G.focus + 1));
    ui.scrub.setAttribute('aria-valuetext', info.label);
    // a detent you can hear and feel as the cards go by (rate limited: a hard fling passes 30 cards a second)
    const t = nowMs();
    if (G.armed && t - G.lastTick > 60) {
      G.lastTick = t;
      play('tick', { volume: 0.45, pitch: 0.9 + (id % 13) * 0.018 });
      haptic('tick');
    }
  }

  /** Runs the re-flow clock from `from` (0 = leavers first, 0.36 = only deal the newcomers in). */
  function startMorph(from, duration) {
    if (G.morph) G.morph.tween.cancel();
    const m = { t: from, tween: null };
    G.morph = m;
    m.tween = SOL.Anim.tween({
      duration: duration,
      ease: 'linear',
      from: from,
      to: 1,
      update: function (t) {
        m.t = t;
        renderCarousel();
      },
      done: function () {
        if (G.morph === m) G.morph = null;
        for (const it of G.items.values()) {
          it.from = undefined;
          it.fresh = false;
        }
        renderCarousel();
      },
    });
  }

  function endMorph() {
    if (G.morph) G.morph.tween.finish();
  }

  function updateChips() {
    const cur = G.filter === 'all' ? 'all' : SUIT_NAMES[G.filter];
    for (const b of ui.chips.querySelectorAll('[data-filter]')) {
      b.setAttribute('aria-checked', b.getAttribute('data-filter') === cur ? 'true' : 'false');
    }
    ui.scrub.setAttribute('data-filter', cur);
  }

  /** Suit filter: the carousel re-flows — cards that stay glide over, the others drop out and new ones are dealt in. */
  function setFilter(f) {
    f = normFilter(f);
    if (!G.live || f === G.filter) return;
    endMorph();
    G.fl.stop();
    const focusId = G.list[clamp(Math.round(G.pos), 0, G.list.length - 1)];
    const list = listFor(f);
    let ni = list.indexOf(focusId);
    if (ni === -1) {
      // hopping to another suit keeps the rank: Queen of Hearts -> Queen of Spades
      ni = list.findIndex((id) => id % 13 === focusId % 13);
      if (ni === -1) ni = 0;
    }
    const oldPos = G.pos;
    const lo = Math.max(0, ni - G.radius);
    const hi = Math.min(list.length - 1, ni + G.radius);
    for (const it of G.items.values()) {
      const idx = list.indexOf(it.id);
      it.from = it.idx - oldPos;
      it.fresh = false;
      if (idx >= lo && idx <= hi) {
        it.idx = idx;
        it.exiting = false;
      } else {
        it.exiting = true;
      }
    }
    G.filter = f;
    G.list = list;
    G.pos = ni;
    G.armed = false; // the focus hops: no detent tick for that
    updateChips();
    startMorph(0, 640);
    renderCarousel();
    G.armed = true;
    play('slide', { volume: 0.6 });
    haptic('tick');
    announce((f === 'all' ? 'All suits' : SUIT_LABELS[f]) + ', ' + list.length + ' cards');
  }

  function onChipPress(b) {
    if (!galleryInteractive()) return;
    setFilter(b.getAttribute('data-filter'));
  }

  function onRingTap(target) {
    const itemEl = target && target.closest ? target.closest('.insp-gal__item') : null;
    if (!itemEl) return false;
    const id = Number(itemEl.getAttribute('data-id'));
    const idx = G.list.indexOf(id);
    if (idx === -1) return false;
    if (idx === G.focus && Math.abs(G.pos - idx) < 0.35) {
      openFromGallery(id);
    } else {
      G.fl.to(idx);
    }
    return true;
  }

  function scrubTo(clientX) {
    const n = G.list.length;
    endMorph();
    G.fl.stop();
    G.pos = clamp((clientX - G.scrubL) / G.scrubW, 0, 1) * (n - 1);
    renderCarousel();
  }

  function hookScrub() {
    const el = ui.scrub;
    let id = null;
    el.addEventListener('pointerdown', function (e) {
      if (id !== null || !galleryInteractive()) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      id = e.pointerId;
      try {
        el.setPointerCapture(id);
      } catch (err) {
        /* synthetic pointer */
      }
      scrubTo(e.clientX);
    });
    el.addEventListener('pointermove', function (e) {
      if (e.pointerId === id) scrubTo(e.clientX);
    });
    const end = function (e) {
      if (e.pointerId !== id) return;
      id = null;
      if (G.live) G.fl.to(Math.round(G.pos));
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    G.scrub = {
      cancel: function () {
        id = null;
      },
    };
  }

  // ------------------------------------------------------------------ card backs
  function buildBacks() {
    const B = G.backs;
    ui.row.textContent = '';
    ui.dots.textContent = '';
    B.items = SOL.Cards.BACKS.map(function (b) {
      const el = h('div', 'insp-back', { role: 'radio', tabindex: '0', 'aria-checked': 'false', 'aria-label': b.name + ' card back', 'data-back': b.id });
      el.innerHTML =
        '<i class="insp-back__ring" aria-hidden="true"></i><div class="insp-back__scene"></div>' +
        '<div class="insp-back__label" aria-hidden="true"><span class="insp-back__name">' + b.name + '</span>' +
        '<span class="insp-back__tag">' + icon('check') + 'Selected</span></div>';
      const card = SOL.Cards.createBackOnly(b.id, { thick: true });
      el.querySelector('.insp-back__scene').appendChild(card);
      ui.row.appendChild(el);
      const dot = h('i', 'insp-gal__dot');
      ui.dots.appendChild(dot);
      return { id: b.id, name: b.name, el: el, scene: el.querySelector('.insp-back__scene'), card: card, thick: true, on: true, dot: dot, spin: 0, hop: 0, conf: null, _t: '', _f: '', _c: '' };
    });
    B.focus = -1;
    B.angle = 0;
  }

  /**
   * Gives a back its solid (thick) or its paper-thin card. A thick card is some fifty compositor layers, and
   * every frame in which anything moves costs time in proportion to all the layers on the page: six thick
   * cards turning at once are too much for a phone (measured: 17 ms of main thread a frame at 4x CPU
   * throttling). So where the whole row is on screen on a touch device, only the chosen back is solid.
   */
  function setBackThick(it, thick) {
    if (it.thick === thick) return;
    it.thick = thick;
    const card = SOL.Cards.createBackOnly(it.id, { thick: thick });
    // a thin card that turns freely must not drag its table shadow along (cards.css: --shadow-o)
    if (!thick) card.style.setProperty('--shadow-o', '0');
    if (it.card.parentNode) it.card.parentNode.replaceChild(card, it.card);
    it.card = card;
    it._f = it._c = '';
  }

  /**
   * Places the six backs and turns them (see below how the turn is shared between the card's --flip and its
   * transform); the row itself only moves by transform. `dt` = ms since the last call (0: just place).
   */
  function renderBacks(dt) {
    const B = G.backs;
    const n = B.items.length;
    if (!G.live || !n || ui.backsPanel.hidden) return;
    const reduced = isReduced();
    if (!reduced) B.angle = (B.angle + dt * 0.03) % 360;
    const half = (B.rowW || M.vw) / 2 + B.bw;
    for (let i = 0; i < n; i++) {
      const it = B.items[i];
      const d = i - B.pos;
      const k = B.fits ? 0 : Math.min(Math.abs(d), 1);
      const x = d * B.gap;
      const tf = 'translate3d(' + r1(x) + 'px,0,0) scale(' + r3(1 - 0.16 * k) + ')';
      if (tf !== it._t) {
        it.el.style.transform = tf;
        it._t = tf;
      }
      setBackThick(it, !B.lean || it.id === B.selected);
      // …and where the row scrolls, only the backs in view are in the document at all.
      const near = B.fits || Math.abs(d) < 1.6;
      if (near !== it.on) {
        it.on = near;
        if (near) it.scene.appendChild(it.card);
        else if (it.card.parentNode) it.card.parentNode.removeChild(it.card);
      }
      if (!near || Math.abs(x) > half) continue; // out of sight: leave it as it is
      // 33 degrees apart: the six never turn edge-on together, one after the other does. The turn is uneven on
      // purpose: slow while a back faces the viewer, quick through edge-on — the design is what is on show.
      let a = reduced ? -22 : B.angle + i * 33;
      if (!reduced) a -= 19 * Math.sin(2 * a * DEG);
      a += it.spin * 360;
      // The turn is split in two. The card's own --flip takes it in steps of 6 degrees: that is what darkens the
      // faces as they turn edge-on, but every new value restyles the inside of a thick card. The rest goes into
      // the transform of the card element, which costs next to nothing — so a frame only moves the card, and the
      // inside is touched a few times a second (six of these turn at once where the whole row fits).
      const q = Math.round(a / 6) * 6;
      const fl = q + 'deg';
      if (fl !== it._f) {
        it.card.style.setProperty('--flip', fl);
        it._f = fl;
      }
      const hop = it.hop;
      const ct =
        'translate3d(0,' + r1(-hop * B.bw * 0.1) + 'px,0) rotateX(7deg) rotateY(' + r1(a - q) + 'deg) scale3d(' + r3(1 + hop * 0.09) + ',' +
        r3(1 + hop * 0.09) + ',' + r3(1 + hop * 0.09) + ')';
      if (ct !== it._c) {
        it.card.style.transform = ct;
        it._c = ct;
      }
    }
    const f = clamp(Math.round(B.pos), 0, n - 1);
    if (f !== B.focus) {
      B.focus = f;
      for (let i = 0; i < n; i++) B.items[i].dot.classList.toggle('is-on', i === f);
      updateBackInfo();
    }
  }

  function updateBackInfo() {
    const B = G.backs;
    // When every back is on screen the caption describes the choice; otherwise the one in the middle.
    const it = B.fits ? B.items.find((b) => b.id === B.selected) : B.items[B.focus];
    if (!it) return;
    const sel = it.id === B.selected;
    ui.backStatus.textContent = B.fits ? 'Tap a card to choose your card back' : sel ? 'This is your card back' : 'Tap the card to use it';
    ui.backStatus.classList.toggle('is-selected', sel && !B.fits);
  }

  function markSelectedBack(id, user) {
    const B = G.backs;
    B.selected = id;
    for (const it of B.items) {
      const on = it.id === id;
      it.el.setAttribute('aria-checked', on ? 'true' : 'false');
      it.el.classList.toggle('is-selected', on);
      it.dot.classList.toggle('is-selected', on);
    }
    updateBackInfo();
    if (user) announce(id.charAt(0).toUpperCase() + id.slice(1) + ' card back selected');
  }

  /** The player picks a back: saved at once, confirmed with a full turn, a hop, a ring and a tick in the hand. */
  function selectBack(id) {
    const B = G.backs;
    const i = B.items.findIndex((b) => b.id === id);
    if (i === -1 || !galleryInteractive()) return;
    const it = B.items[i];
    if (!B.fits) B.fl.to(i);
    markSelectedBack(id, true);
    try {
      if (SOL.Settings && SOL.Settings.set) SOL.Settings.set('cardBack', id);
    } catch (err) {
      if (root.console) root.console.error('[SOL.Inspector] Settings.set threw', err);
    }
    for (const card of G.cache.values()) SOL.Cards.setBack(card, id);
    if (it.conf) it.conf.cancel();
    const E = SOL.Anim.ease;
    it.conf = SOL.Anim.tween({
      duration: 820,
      ease: 'linear',
      update: function (t) {
        it.spin = E.outCubic(t); // one extra turn, on top of the slow rotation
        it.hop = Math.sin(Math.PI * Math.min(1, t * 1.5)) * (1 - t * 0.3);
      },
      done: function () {
        it.spin = 0;
        it.hop = 0;
        it.conf = null;
      },
    });
    // a fresh element each time: its CSS animation runs on insertion, no reflow tricks needed
    const old = it.el.querySelector('.insp-back__burst');
    if (old) old.parentNode.removeChild(old);
    it.el.insertBefore(h('i', 'insp-back__burst', { 'aria-hidden': 'true' }), it.el.firstChild);
    play('flip');
    if (SOL.Audio && SOL.Audio.playFoundation) {
      try {
        SOL.Audio.playFoundation(9, { delay: 170, volume: 0.8 });
      } catch (err) {
        /* decoration */
      }
    }
    haptic('success');
  }

  function onRowTap(target) {
    const el = target && target.closest ? target.closest('.insp-back') : null;
    if (!el) return false;
    selectBack(el.getAttribute('data-back'));
    return true;
  }

  function onRowFocus(e) {
    // keyboard focus brings the back into the middle
    const el = e.target && e.target.closest ? e.target.closest('.insp-back') : null;
    const B = G.backs;
    if (!el || !G.live || B.fits || B.fl.drag) return;
    const i = B.items.findIndex((b) => b.el === el);
    if (i !== -1 && i !== Math.round(B.pos)) B.fl.to(i);
  }

  // ------------------------------------------------------------------ tabs (a 3D turn between the two panels)
  function showTab(tab) {
    for (const b of ui.tabs.querySelectorAll('[data-tab]')) {
      b.setAttribute('aria-selected', b.getAttribute('data-tab') === tab ? 'true' : 'false');
    }
    ui.tabs.setAttribute('data-tab', tab);
    ui.galTitle.textContent = tab === 'backs' ? 'Card backs' : 'Deck gallery';
  }

  function resetPanel(p) {
    p.classList.remove('is-turning', 'is-turning--in');
    p.style.transform = '';
    p.style.opacity = '';
  }

  /**
   * Ends the turn between the two tabs now: the panel that left is hidden, both are back to their plain,
   * untransformed selves. Safe to call at any time.
   */
  function endTabTurn() {
    const t = G.tabAnim;
    if (!t) return;
    G.tabAnim = null;
    if (t.wait.cancel) t.wait.cancel();
    t.outP.hidden = true;
    t.outP.classList.remove('is-turning');
    t.inP.classList.remove('is-turning');
    resetPanel(t.outP);
    resetPanel(t.inP);
  }

  function setTab(tab) {
    tab = tab === 'backs' ? 'backs' : 'cards';
    if (!G.live || tab === G.tab) return;
    endTabTurn();
    G.tab = tab;
    showTab(tab);
    G.fl.stop();
    G.backs.fl.stop();
    G.fl.cancelDrag();
    G.backs.fl.cancelDrag();
    endMorph();
    const inP = tab === 'backs' ? ui.backsPanel : ui.cardsPanel;
    const outP = tab === 'backs' ? ui.cardsPanel : ui.backsPanel;
    const dir = tab === 'backs' ? 1 : -1;
    inP.hidden = false;
    // Not quite 0: a box at opacity 0 is not painted at all, and its first paint (six thick cards) would then
    // fall into the middle of the turn instead of this first frame, before anything moves.
    inP.style.opacity = '0.01';
    layout(); // the panel that was display:none can be measured now (it must not be transformed yet)
    renderCarousel();
    renderBacks(0);
    syncLoop();
    /*
     * The turn itself is a CSS transition of transform + opacity on the two panels (.is-turning in
     * inspector.css), so it runs on the compositor: no frame of it needs the main thread. (Driven from JS, each
     * frame restyled both panels and rebuilt the layer list, and half-way through the browser re-laid-out and
     * repainted every card's art because its on-screen scale had changed: the turn stuttered on a phone.)
     * Its length follows the speed setting through --insp-turn; reduced motion collapses it (base.css); what
     * comes after it is sequenced with SOL.Anim.wait like everything else.
     */
    const ms = 480;
    inP.style.transform = 'translate3d(' + dir * 38 + '%,0,-260px) rotateY(' + -dir * 68 + 'deg)';
    void inP.offsetWidth; // the pose above is where the transition starts from
    ui.panels.style.setProperty('--insp-turn', Math.round(ms / SOL.Anim.speed) + 'ms');
    inP.classList.add('is-turning', 'is-turning--in');
    outP.classList.add('is-turning');
    outP.classList.remove('is-turning--in');
    inP.style.transform = 'translate3d(0,0,0) rotateY(0deg)';
    inP.style.opacity = '1';
    outP.style.transform = 'translate3d(' + -dir * 38 + '%,0,-260px) rotateY(' + dir * 68 + 'deg)';
    outP.style.opacity = '0';
    const t = { inP: inP, outP: outP, wait: SOL.Anim.wait(ms + 30) };
    G.tabAnim = t;
    t.wait.then(function () {
      if (G.tabAnim === t) endTabTurn();
    });
    play('whoosh', { duration: 220, volume: 0.4 });
    haptic('tick');
    announce(tab === 'backs' ? 'Card backs' : 'Cards');
  }

  function onGalleryBarPress(b) {
    const s = session;
    if (!s || s.closing || s.view !== 'gallery') return;
    if (b.hasAttribute('data-tab')) setTab(b.getAttribute('data-tab'));
    else back();
  }

  function galleryKey(e, k) {
    if (!galleryInteractive()) return false;
    const ae = doc.activeElement;
    const onButton = !!ae && ae.tagName === 'BUTTON';
    const onBack = !!ae && ae.classList && ae.classList.contains('insp-back');
    const B = G.backs;
    if (G.tab === 'backs') {
      if ((k === 'Enter' || k === ' ') && onBack) {
        selectBack(ae.getAttribute('data-back'));
        return true;
      }
      if (k === 'ArrowLeft' || k === 'ArrowRight') {
        // roving focus along the row
        const cur = onBack ? B.items.findIndex((b) => b.el === ae) : clamp(Math.round(B.pos), 0, B.items.length - 1);
        const ni = clamp(cur + (k === 'ArrowRight' ? 1 : -1), 0, B.items.length - 1);
        B.items[ni].el.focus({ preventScroll: true });
        if (!B.fits) B.fl.to(ni);
        return true;
      }
      return false;
    }
    const max = G.list.length - 1;
    switch (k) {
      case 'ArrowLeft':
        G.fl.step(-1);
        return true;
      case 'ArrowRight':
        G.fl.step(1);
        return true;
      case 'PageUp':
        G.fl.step(-5);
        return true;
      case 'PageDown':
        G.fl.step(5);
        return true;
      case 'Home':
        G.fl.to(0);
        return true;
      case 'End':
        G.fl.to(max);
        return true;
      case 'Enter':
      case ' ':
        if (onButton) return false; // the focused button handles its own activation
        endMorph();
        if (Math.abs(G.pos - G.focus) < 0.35) openFromGallery(G.list[G.focus]);
        return true;
      case '1':
      case '2':
      case '3':
      case '4':
      case '5':
        setFilter(['all', 0, 1, 2, 3][Number(k) - 1]);
        return true;
      default:
        return false;
    }
  }

  function galleryWheel(delta) {
    if (!galleryInteractive()) return;
    if (G.tab === 'backs') {
      if (!G.backs.fits) G.backs.fl.wheel(delta);
    } else {
      endMorph();
      G.fl.wheel(delta);
    }
  }

  function tickGallery(dt, sdt) {
    // (the backs hold still while the panels turn: the turn is motion enough, and its frames stay light)
    if (G.tab === 'backs' && !G.tabAnim) renderBacks(sdt);
  }

  function galleryStop() {
    if (G.fl) G.fl.stop();
    if (G.backs.fl) G.backs.fl.stop();
  }

  function galleryCancelDrag() {
    if (G.fl) G.fl.cancelDrag();
    if (G.backs.fl) G.backs.fl.cancelDrag();
    if (G.scrub) G.scrub.cancel();
  }

  // ------------------------------------------------------------------ gallery <-> card inspector
  function openFromGallery(id) {
    const s = session;
    if (!galleryInteractive()) return;
    endMorph(); // a filter re-flow still running: its cards go to their places first (the card flies out of one)
    const it = G.items.get(id);
    if (!it) return;
    galleryStop();
    startCardView(s, {
      id: id,
      list: G.list.slice(),
      sourceEl: it.card,
      back: G.backs.selected,
      hideSource: true,
      fromGallery: true,
    });
    play('open', { volume: 0.8 });
    haptic('tap');
    emit('inspector:change', { card: id, mode: 'card' });
  }

  /** Back from an inspected card: the carousel turns to that card and the card flies home into its slot. */
  function returnToGallery() {
    const s = session;
    if (!s || s.closing || !C.live || !G.live || C.returning) return;
    C.returning = true;
    cancelGesture();
    const o = C.active;
    const id = o ? o.id : C.list[C.index];
    endMorph();
    G.fl.stop();
    const idx = G.list.indexOf(id);
    G.armed = false;
    if (idx !== -1) G.pos = idx;
    renderCarousel();
    G.armed = true;
    const it = G.items.get(id);
    if (it) hideSourceEl(it.card);
    else unhideSource();
    setView(s, 'gallery');
    play('close', { volume: 0.7 });
    haptic('tick');
    flyOut(o, it ? it.card : null).then(function () {
      if (session !== s || s.done || !C.live) return;
      destroyCardView();
      syncLoop();
      ui.cardView.hidden = true;
      if (!s.closing) {
        ui.ring.focus({ preventScroll: true });
        emit('inspector:change', { card: id, mode: 'gallery' });
      }
    });
  }

  function destroyGallery() {
    if (!G.live) return;
    G.live = false;
    if (G.focus >= 0 && G.focus < G.list.length) G.lastCard = G.list[G.focus];
    galleryStop();
    galleryCancelDrag();
    if (G.morph) G.morph.tween.cancel();
    G.morph = null;
    endTabTurn();
    for (const it of G.backs.items) if (it.conf) it.conf.cancel();
    G.backs.items = [];
    G.items.clear();
    G.cache.clear();
    G.focus = -1;
    G.focusList = null;
    ui.ring.textContent = '';
    ui.row.textContent = '';
    ui.dots.textContent = '';
    resetPanel(ui.cardsPanel);
    resetPanel(ui.backsPanel);
  }

  // ====================================================================================================
  // PUBLIC API
  // ====================================================================================================
  function cleanList(cards, cardId) {
    let list = null;
    if (Array.isArray(cards)) {
      const seen = new Set();
      list = [];
      for (const id of cards) {
        if (validCard(id) && !seen.has(id)) {
          seen.add(id);
          list.push(id);
        }
      }
    }
    if (!list || !list.length) list = listFor('all');
    if (list.indexOf(cardId) === -1) list.unshift(cardId);
    return list;
  }

  function open(cardId, opts) {
    const o = opts || {};
    if (!validCard(cardId)) {
      if (root.console) root.console.warn('[SOL.Inspector] open: card id must be an integer 0..51, got', cardId);
      return Promise.resolve();
    }
    if (!ensureInit()) return Promise.resolve();
    const s = startSession();
    startCardView(s, {
      id: cardId,
      list: cleanList(o.cards, cardId),
      sourceEl: o.sourceEl || null,
      back: resolveBack(o.back),
      hideSource: o.hideSource,
      elementFor: o.elementFor,
      fromGallery: false,
    });
    emit('inspector:open', { card: cardId, mode: 'card' });
    play('open');
    haptic('tap');
    return s.promise;
  }

  function openGallery(opts) {
    const o = opts || {};
    if (!ensureInit()) return Promise.resolve();
    const s = startSession();
    const B = G.backs;
    const start = validCard(o.startCard) ? o.startCard : -1;
    G.live = true;
    G.filter = normFilter(o.filter);
    G.list = listFor(G.filter);
    if (start !== -1 && G.list.indexOf(start) === -1) {
      G.filter = 'all';
      G.list = listFor('all');
    }
    // no card asked for: back to where the player last was (this page load), else the top of the deck
    G.pos = Math.max(0, G.list.indexOf(start !== -1 ? start : G.lastCard));
    G.focus = -1;
    G.focusList = null;
    G.armed = false;
    G.tab = o.tab === 'backs' ? 'backs' : 'cards';
    B.selected = resolveBack();
    buildBacks();
    B.pos = Math.max(0, B.items.findIndex((b) => b.id === B.selected));
    setView(s, 'gallery');
    ui.cardsPanel.hidden = G.tab !== 'cards';
    ui.backsPanel.hidden = G.tab !== 'backs';
    resetPanel(ui.cardsPanel);
    resetPanel(ui.backsPanel);
    showTab(G.tab);
    updateChips();
    layout();
    markSelectedBack(B.selected, false);
    // the cards are dealt onto the arc as the gallery opens
    startMorph(0.36, 520);
    renderCarousel();
    for (const it of G.items.values()) it.fresh = true;
    renderCarousel();
    renderBacks(0);
    syncLoop();
    G.armed = true;
    emit('inspector:open', { card: start === -1 ? null : start, mode: 'gallery' });
    play('open');
    haptic('tap');
    ui.root.focus({ preventScroll: true });
    return s.promise;
  }

  function isOpen() {
    return !!session && !session.closing;
  }

  function state() {
    const s = session;
    const o = C.live ? C.active : null;
    return {
      open: !!s && !s.closing,
      closing: !!s && s.closing,
      view: s ? s.view : null,
      card: C.live && C.list.length ? C.list[C.index] : null,
      index: C.live ? C.index : -1,
      count: C.live ? C.list.length : 0,
      flipped: !!o && isFlipped(o),
      spinning: C.live && C.spin,
      zoom: o ? o.zoom : 1,
      yaw: o ? o.yaw : 0,
      pitch: o ? o.pitch : 0,
      roll: o ? o.roll : 0,
      settled: !!o && !o.rot && !o.fly && !o.zoomS && !o.rollS && !o.navS,
      idle: C.live ? C.idle.amp : 0,
      tiltYaw: C.live ? C.tilt.yaw : 0,
      tiltPitch: C.live ? C.tilt.pitch : 0,
      covered: !!s && s.covered,
      objects: C.objs.length,
      cardWidth: M.W,
      tab: G.live ? G.tab : null,
      filter: G.live ? (G.filter === 'all' ? 'all' : SUIT_NAMES[G.filter]) : null,
      pos: G.live ? G.pos : 0,
      focus: G.live ? G.focus : -1,
      focusCard: G.live && G.focus >= 0 ? G.list[G.focus] : null,
      galleryCount: G.live ? G.list.length : 0,
      galleryDom: G.items.size,
      back: G.live ? G.backs.selected : C.live ? C.back : null,
      backFocus: G.live ? G.backs.focus : -1,
    };
  }

  const Inspector = {
    init: init,
    open: open,
    openGallery: openGallery,
    close: close,
    back: back,
    isOpen: isOpen,
    state: state,
  };

  SOL.Inspector = Inspector;
})(typeof window !== 'undefined' ? window : globalThis);
