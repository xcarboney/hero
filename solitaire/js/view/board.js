/*
 * SOL.Board — the table: 52 card sprites, the pile slots, the responsive layout and every in-game animation.
 *
 * The board never decides anything about the game. SOL.Game (js/main.js) applies an action to the engine state
 * and hands the board the new state plus the engine record; the board works out where every card belongs
 * (the LAYOUT MODEL, pure arithmetic) and animates the cards there. Positions are never read from the DOM
 * while animating: the only layout read is one getBoundingClientRect of #table per (re)layout.
 *
 * PUBLIC API
 * ----------
 *   Board.init({ table, piles, cards } = {}) -> boolean     builds the slots and the 52 cards (idempotent)
 *   Board.ready                      true after init()
 *
 *   -- contract (other modules) --
 *   Board.cardEl(cardId) -> HTMLElement | null
 *   Board.pileEl(pileId) -> HTMLElement | null               the empty-pile slot
 *   Board.pileRect(pileId) -> { x, y, left, top, right, bottom, width, height } | null   viewport px, the slot
 *
 *   -- rendering a state (called by SOL.Game) --
 *   Board.render(state)              instant: every card at its place, nothing animates (also leaves deck mode)
 *   Board.restore(state)             render + a quick settle-in (restored game)
 *   Board.apply(state, record, { source, auto, step } = {})
 *                                    animates one engine record (draw / recycle / move / undo). `source: 'drag'`
 *                                    right after Board.dragEnd(): the held cards spring in from the pointer.
 *                                    `auto: true` (auto-complete): quicker flights with trails; `step` is the
 *                                    0-based index of the move inside the cascade.
 *   Board.gather() -> Promise        every card sweeps into one face-down deck, centre stage (enters deck mode)
 *   Board.shuffle() -> Promise       one visible riffle of the deck (call it again while waiting for a seed)
 *   Board.deal(state) -> Promise     deals `state` (a fresh deal) from the deck; resolves when the last card landed
 *   Board.relayout()                 re-measure #table and glide everything to its new place (also automatic:
 *                                    ResizeObserver, window resize, 'app:insets', handedness)
 *   Board.setBack(backId)            SOL.Cards.setBack on all 52
 *   Board.setLeftHanded(bool)        mirrors the top row (stock under the left thumb)
 *
 *   -- feedback --
 *   Board.hint(action) -> boolean    pulses the hinted card and its target, sends a ghost there and back
 *   Board.clearHint()
 *   Board.shake(cardId)              "no": a quick shake of the card (and the run above it)
 *   Board.nudgeStock()               gentle "nothing to suggest" cue on the stock / waste
 *   Board.setStockInvite(bool)       the stock asks for a tap (a soft pulse on its top card / recycle symbol)
 *
 *   -- dragging (called by SOL.Input; client coordinates) --
 *   Board.cardAt(clientX, clientY, slop = 0) -> cardId | -1        topmost card as currently drawn (cards in
 *                                                                   mid-flight are skipped)
 *   Board.pileAt(clientX, clientY, slop = 0) -> pileId | null      which pile's area the point is in
 *   Board.press(cardId) / Board.unpress()                           tiny "finger down" lift
 *   Board.dragStart(cardId, clientX, clientY) -> number             cards picked up (0 = cannot be picked up)
 *   Board.dragMove(clientX, clientY)
 *   Board.dragEnd() -> { card, from, target, over } | null          stops following the pointer; the run stays
 *                                    in the air until Board.apply(…, { source: 'drag' }) or Board.dragCancel().
 *                                    target: the legal pile with the largest overlap (or null);
 *                                    over: the pile the lead card mostly covers, legal or not (or null).
 *   Board.dragCancel({ invalid } = {})                              the held run returns (invalid: with a shake)
 *   Board.isDragging() -> boolean
 *
 *   -- testing hooks --
 *   Board.snapshot() -> [{ id, pile, index, x, y, z, faceUp,                     as currently drawn
 *                          target: { x, y, z, faceUp },                            the logical target
 *                          flip, lift, scale, rot, rx, ry, moving, held, covered }]  one entry per card id 0..51
 *                                    (covered: resting completely under other cards and not rendered)
 *   Board.isSettled() -> boolean     no drag, no choreography, every card at rest exactly on its target
 *
 *   -- for the celebration / animation director --
 *   Board.sprites                    the 52 Sprite objects, indexed by card id (see "SPRITES" below)
 *   Board.sprite(cardId) -> Sprite
 *   Board.layout() -> { w, h, left, top, cardW, cardH, gap, upFan, downFan, wasteFanX, wasteFanY, tableauY,
 *                       bottom, leftHanded, compact, side, piles: { pileId: { x, y } },
 *                       deck: { x, y, scale } }      table-space px (a copy). `side`: the wide / short
 *                       arrangement is in use (foundations 2 x 2 beside the columns, waste under the stock)
 *   Board.toClient(x, y) -> { x, y } table space -> viewport px (centre of a card: add cardW / 2, cardH / 2)
 *   Board.hold(cardIds, tag = 'show', { soft } = {})
 *                                    the layout stops touching these cards (you animate them yourself).
 *                                    cardIds null = all 52. `soft: true` (hover tilts, idle flourishes): the
 *                                    hold ends by itself, and the card relaxes to rest, the moment the game
 *                                    needs it — any Board.apply(), a drag start, a new deal.
 *   Board.release(tag = 'show', { how = 'fly', stagger = 0, ...flightOptions } = {}) -> Promise
 *                                    gives them back; they return to their logical places
 *   Board.sync(how = 'glide')        brings every free card whose place changed to its target
 *   Board.touch(sprite)              "I changed this sprite's values": schedules its style write
 *   Board.flush()                    write the styles of touched sprites right now (normally once per frame)
 *   Board.pulse(pileId, color?)      the slot's arrival ring
 *   Board.scorePop(x, y, delta)      "+10" at a table-space point (canvas text, or a DOM label when FX is off)
 *   Board.foundationArrive(sprite, { quiet })   the whole arrival effect (ring, particles, pitch, haptic)
 *   Board.TUNE                       every timing / distance constant (mutable: tune them live)
 *   Board.busyCount() -> number      sprites with a running animation
 *   Board.isDeckMode() -> boolean    the cards are the shuffling deck (between gather() and deal())
 *   Emits 'board:layout' <Board.layout()> on SOL.Bus after every re-layout.
 *
 * SPRITES
 * -------
 * One per card. A sprite owns its element and three groups of values:
 *   logical target   pile, index, tx, ty, tz, faceUp        — written only by the layout model (retarget)
 *   animated values  x, y (table space), ox, oy (cosmetic offset), rot (deg, in-plane), rx, ry (deg, 3D tilt),
 *                    scale, lift (0..1 → --lift), flip (0 face-up .. 180 face-down), z (z-index)
 *   handles          hFlight | hPos, hPose, hFlip, hOff     — SOL.Anim tweens / springs (so SOL.Anim.idle() and
 *                    the speed / reduced-motion settings cover everything)
 * Animated values are plain numbers: an animation writes them and calls Board.touch(sprite); one frame
 * subscriber writes the styles of touched sprites once per frame (transform on .card, --lift, --flip, z-index).
 * A resting card costs nothing per frame.
 *
 * Motion vocabulary (all start from the sprite's CURRENT values, so anything can be interrupted any time):
 *   sprite.fly(opts) -> handle       a flight: one tween that owns every value. No x/y given = flies to the
 *                                    logical target and keeps tracking it if the layout moves it mid-air.
 *       { x, y, duration, delay, arc (px the path bows towards the top of the screen), side (px sideways),
 *         spin (deg, peaks mid-flight), peakLift, peakScale (added mid-flight), rot / scale / lift (END pose,
 *         default 0 / 1 / 0), flip (END flip 0 | 180), flipFrom / flipTo (0..1 window of the flight),
 *         flipMode ('prop' | 'spin'), overshoot (px), z, trail (colour), liftSteps (coarser --lift steps for
 *         crowded choreography; default TUNE.liftSteps), lazy (a covered card stays covered
 *         until its delay is over), onStart(s), onFrame(s, t), onLand(s) }
 *   sprite.springTo(x, y, { stiffness, damping, velocity: { x, y } }) -> handle     position only; retargets a
 *                                    running spring instead of restarting it
 *   sprite.poseTo({ rot, rx, ry, scale, lift }, { duration, delay, ease }) -> handle
 *   sprite.flipTo(deg, { duration, delay, mode, hop }) -> handle        hop: px the card jumps while it turns
 *   sprite.wobble(fn(t, sprite), { duration, delay }) -> handle         drives ox / oy (they end at 0)
 *   sprite.cover(bool)               takes a card out of rendering (content-visibility) / puts it back. Every
 *                                    motion method uncovers; the board covers cards resting deep in the stock,
 *                                    the waste and the foundations (TUNE.keep*), so only ~30 cards are live
 *   sprite.stop()                    cancels every handle, values stay where they are
 *   sprite.busy() -> boolean
 * State classes the board keeps on its cards (board.css uses them to drop unused layers): .is-lifted while
 * lift > 0 or the card turns (the lift shadow is rendered only then), .is-turning while --flip is between 0 and
 * 180 (the flip shading), and .is-glare — NOT set by the board: add it to a card before you animate
 * --glare-o / --glare-x / --glare-y on it, remove it afterwards (the glare planes are display: none without it).
 * Flip modes: 'prop' animates --flip (lighting + shadow react; ~0.16 ms per card per frame) — a handful of
 * cards. 'spin' rotates .card itself and swaps the face at 90deg (transform only) — mass choreography.
 * Stacking: z-index = index in the pile at rest; a flight raises its card (TUNE.flyZ + launch order) and puts
 * it back on landing; dragged cards sit at TUNE.dragZ; held "show" cards are yours.
 * Invariant kept by the board: whenever a sprite is not held and has no handle, it is exactly on its target,
 * face, pose and z included (see Sprite._settled); Board.sync() re-places anything whose target moved.
 *
 * Needs SOL.Anim, SOL.Cards, SOL.Engine. SOL.FX, SOL.Audio, SOL.Haptics and SOL.Bus are optional.
 */
(function (root) {
  'use strict';

  const SOL = (root.SOL = root.SOL || {});
  const doc = root.document;

  // ------------------------------------------------------------------ constants
  const ASPECT = 1.4;
  const FOUNDATIONS = ['f0', 'f1', 'f2', 'f3'];
  const TABLEAU = ['t0', 't1', 't2', 't3', 't4', 't5', 't6'];
  const PILE_IDS = ['stock', 'waste'].concat(FOUNDATIONS, TABLEAU);
  const SUIT_NAMES = ['spades', 'hearts', 'clubs', 'diamonds'];
  /** Ring / glow colours per suit (dark suits get a cool ivory so they read on dark felt). */
  const SUIT_GLOW = ['#dfe8ff', '#ff6b81', '#dfe8ff', '#ff6b81'];
  const GOLD = '#f3c969';
  const MINUS = '#ff9a9a';
  const PROP = 'prop';
  const SPIN = 'spin';
  const EMPTY = Object.freeze({});
  const PI = Math.PI;

  /**
   * Every dial in one place (ms are at animation speed 1; distances are fractions of the card size).
   * The object is exposed as Board.TUNE and read at use time, so it can be tuned live from the console.
   */
  const TUNE = {
    // ---- layout
    maxCardW: 190,
    fanRoom: 2.3, // card heights of fan room below the first tableau card that the height cap guarantees
    sideGain: 1.12, // the side arrangement is used when it makes the cards at least this much wider
    upCompact: 0.34, // face-up fan offset / card height, phone art (< 60px wide)
    upClassic: 0.3, // …classic art
    down: 0.125, // face-down fan offset / card height
    upMin: 0.1,
    downMin: 0.045,
    wasteFanCompact: 0.44, // draw-3 waste fan offset / card width
    wasteFanClassic: 0.3,
    liftSteps: 8, // distinct --lift values between 0 and 1 (see Sprite._write)
    // ---- stacking
    keepStock: 3, // cards from the top of a pile that stay rendered (the rest is covered, see settlePile)
    keepWaste: 3,
    keepWaste3: 5, // draw 3: the fan plus what the next move can expose
    keepFoundation: 2,
    flyZ: 200,
    dragZ: 2000,
    showZ: 3000,
    // ---- flights
    flyBase: 170,
    flyPerPx: 0.42,
    flyMin: 230,
    flyMax: 480,
    arc: 0.42, // tap-move arc height / card height
    arcFoundation: 0.85,
    overshoot: 0.07, // landing follow-through / card width
    runLag: 30, // ms between the cards of a run that travels together
    undoTempo: 0.78,
    // ---- draw / recycle
    drawMs: 330,
    drawGap: 85,
    recycleMs: 300,
    recycleSpan: 380, // the whole cascade launches within this long
    // ---- drag
    dragScale: 1.07,
    dragLag: 0.045, // s: time constant of each trailing card
    dragStretchX: 0.4, // how far a trailing card may fall behind its neighbour / card width
    dragStretchY: 0.26, // … / card height
    tiltZ: 0.007, // deg per px/s
    tiltY: 0.016,
    tiltX: 0.014,
    dropStiffness: 330,
    dropDamping: 25,
    // ---- reveal
    revealMs: 320,
    revealDelay: 110,
    revealHop: 0.13, // card heights
    // ---- deal
    deckScale: 1.3,
    gatherMs: 400,
    gatherSpan: 300,
    dealMs: 400,
    dealGap: 38,
    dealAhead: 5, // cards kept rendered on top of the deck while dealing
    // ---- glide (layout changes, neighbours)
    glideStiffness: 230,
    glideDamping: 27,
    // ---- hint
    hintMs: 2200,
  };

  // ------------------------------------------------------------------ module state
  let inited = false;
  let tableEl = null;
  let pilesEl = null;
  let cardsEl = null;
  let overlayEl = null;
  let probeEl = null;
  const pileEls = Object.create(null);
  /** @type {Sprite[]} */
  const sprites = [];

  let state = null; // the engine state on the table (owned by SOL.Game; the board only reads it)
  let L = null; // layout metrics, see computeLayout()
  let leftHanded = false;
  let deckMode = true; // true while the cards form the shuffling deck (no state on the table yet)
  let choreoGen = 0; // bumped by anything that invalidates a running multi-step choreography
  let choreoBusy = 0; // running gather / shuffle / deal promises
  let zSeq = 0;

  const dirty = []; // sprites whose styles need writing
  let stopTick = null;
  let idleFrames = 0;

  let drag = null; // see dragStart()
  let pressed = null;
  let hintState = null;
  let pulseFlip = false;
  let resizeObserver = null;
  let inviteOn = false;
  let inviteEl = null;

  // ------------------------------------------------------------------ small helpers
  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }
  function r2(v) {
    return Math.round(v * 100) / 100;
  }
  function outCubic(t) {
    const u = 1 - t;
    return 1 - u * u * u;
  }
  function inOutSine(t) {
    return -(Math.cos(PI * t) - 1) * 0.5;
  }
  function A() {
    return SOL.Anim;
  }
  function E() {
    return SOL.Engine;
  }
  function reduced() {
    return !!(SOL.Anim && SOL.Anim.reduced);
  }

  function sfx(name, opts) {
    try {
      if (SOL.Audio) SOL.Audio.play(name, opts);
    } catch (err) {
      /* sound is never worth an exception */
    }
  }
  function haptic(kind) {
    try {
      if (!SOL.Haptics) return;
      // Before the first tap a browser refuses to vibrate and logs an intervention for every attempt
      // (the opening deal runs without any gesture). The native shell has no such rule.
      const ua = root.navigator && root.navigator.userActivation;
      if (ua && !ua.hasBeenActive && !(SOL.Platform && SOL.Platform.isNativeApp)) return;
      SOL.Haptics.play(kind);
    } catch (err) {
      /* ignore */
    }
  }
  function fx() {
    return SOL.FX && !reduced() ? SOL.FX : null;
  }
  /** Stereo position of a table-space x (subtle). */
  function panOf(x) {
    if (!L) return 0;
    return clamp(((x + L.cardW / 2) / L.w) * 2 - 1, -1, 1) * 0.45;
  }
  function suitOf(id) {
    return Math.floor(id / 13);
  }
  function rankOf(id) {
    return (id % 13) + 1;
  }

  // ------------------------------------------------------------------ Sprite
  class Sprite {
    constructor(id, el) {
      this.id = id;
      this.el = el;
      // logical target
      this.pile = 'stock';
      this.index = id;
      this.tx = 0;
      this.ty = 0;
      this.tz = id;
      this.faceUp = false;
      // animated values
      this.x = 0;
      this.y = 0;
      this.ox = 0;
      this.oy = 0;
      this.rot = 0;
      this.rx = 0;
      this.ry = 0;
      this.scale = 1;
      this.lift = 0;
      this.flip = 180;
      this.z = id;
      this.flipMode = PROP;
      // where the running motion ends (== target once at rest): lets sync() see what still has to move
      this.dx = 0;
      this.dy = 0;
      this.dflip = 180;
      this.held = null; // 'drag' | 'deck' | 'show' | …: the layout leaves a held sprite alone
      this.soft = false; // a soft hold (press, hover…) ends by itself as soon as the game needs the card
      // handles
      this.hFlight = null;
      this.tracking = false; // the flight follows (tx, ty) live
      this.hPos = null;
      this.hPose = null;
      this.hFlip = null;
      this.hOff = null;
      this.covered = false; // completely under other cards of its pile and not rendered (see cover())
      this.liftQ = 0; // --lift quantisation of the running flight (0 = TUNE.liftSteps)
      // style cache
      this._dirty = false;
      this._wT = '';
      this._wLift = '';
      this._wFlip = '';
      this._wZ = -1;
      this._wDown = null;
      this._wTurn = false;
      this._wLifted = false;
    }

    busy() {
      return !!(this.hFlight || this.hPos || this.hPose || this.hFlip || this.hOff);
    }

    /**
     * A card that lies completely under others (deep in the stock, the waste or a foundation) is not rendered
     * at all: content-visibility: hidden drops its dozen compositor layers and costs next to nothing to
     * toggle. Anything that animates a sprite uncovers it first; the board covers it again when it has
     * settled deep in a pile (settlePile).
     */
    cover(on) {
      if (this.covered === on) return;
      this.covered = on;
      if (on) this.el.style.setProperty('content-visibility', 'hidden');
      else this.el.style.removeProperty('content-visibility');
    }

    /** Cancels every running animation of this sprite. Values stay where they are. */
    stop() {
      let h;
      if ((h = this.hFlight)) {
        this.hFlight = null;
        this.tracking = false;
        h.cancel();
      }
      if ((h = this.hPos)) {
        this.hPos = null;
        h.cancel();
      }
      if ((h = this.hPose)) {
        this.hPose = null;
        h.cancel();
      }
      if ((h = this.hFlip)) {
        this.hFlip = null;
        h.cancel();
      }
      if ((h = this.hOff)) {
        this.hOff = null;
        h.cancel();
      }
      return this;
    }

    /** Folds the cosmetic offset into the position (so a new motion starts exactly where the card is drawn). */
    _fold() {
      if (this.ox !== 0 || this.oy !== 0) {
        this.x += this.ox;
        this.y += this.oy;
        this.ox = 0;
        this.oy = 0;
      }
    }

    /**
     * A flight: one tween that owns every animated value of the sprite. See the header for the options.
     * Without x / y it flies to the logical target and follows it if the layout moves it mid-air.
     */
    fly(o) {
      o = o || EMPTY;
      const s = this;
      s.stop();
      s._fold();
      // (a covered card with a delayed flight may stay unrendered until it actually takes off)
      if (!(o.lazy && s.covered && o.delay > 0)) s.cover(false);
      const tracking = o.x === undefined || o.y === undefined;
      const x0 = s.x;
      const y0 = s.y;
      const fx1 = tracking ? s.tx : o.x;
      const fy1 = tracking ? s.ty : o.y;
      const dist = Math.hypot(fx1 - x0, fy1 - y0);
      const duration = o.duration !== undefined ? o.duration : flightMs(dist);
      const rot0 = s.rot;
      const rx0 = s.rx;
      const ry0 = s.ry;
      const sc0 = s.scale;
      const lift0 = s.lift;
      const flip0 = s.flip;
      const rot1 = o.rot || 0;
      const sc1 = o.scale === undefined ? 1 : o.scale;
      const lift1 = o.lift || 0;
      const flip1 = o.flip === undefined ? (tracking ? (s.faceUp ? 0 : 180) : flip0) : o.flip;
      const fa = o.flipFrom === undefined ? 0.12 : o.flipFrom;
      const fb = Math.max(fa + 0.01, o.flipTo === undefined ? 0.82 : o.flipTo);
      const peakLift = o.peakLift === undefined ? 0.75 : o.peakLift;
      const peakScale = o.peakScale === undefined ? 0.07 : o.peakScale;
      const spin = o.spin || 0;
      const arc = o.arc || 0;
      const side = o.side || 0;
      // sideways bow: along the normal to the right of the direction of travel
      const nx = dist > 0.001 ? -(fy1 - y0) / dist : 1;
      const ny = dist > 0.001 ? (fx1 - x0) / dist : 0;
      const overPx = o.overshoot === undefined ? (L ? L.cardW * TUNE.overshoot : 0) : o.overshoot;
      const over = dist > 4 ? Math.min(overPx, dist * 0.2) / dist : 0;
      const trail = o.trail || null;
      let started = false;

      if (flip1 !== flip0) s.flipMode = o.flipMode === SPIN ? SPIN : PROP;
      s.liftQ = o.liftSteps || 0;
      s.tracking = tracking;
      if (tracking) {
        s.dx = s.tx;
        s.dy = s.ty;
        s.dflip = flip1;
      }

      const h = A().tween({
        duration: duration,
        delay: o.delay || 0,
        ease: 'linear',
        update: function (t) {
          if (s.hFlight !== h) return;
          if (!started) {
            started = true;
            s.cover(false);
            s.z = o.z !== undefined ? o.z : nextFlyZ();
            if (o.onStart) o.onStart(s);
          }
          const e = outCubic(t);
          const p = e + over * t * t * t * t * (1 - t) * 12.2; // a little past the target, then back
          const bow = 4 * p * (1 - p);
          const x1 = tracking ? s.tx : fx1;
          const y1 = tracking ? s.ty : fy1;
          s.x = x0 + (x1 - x0) * p + nx * side * bow;
          s.y = y0 + (y1 - y0) * p + ny * side * bow - arc * bow;
          const bell = Math.sin(PI * t);
          s.rot = rot0 + (rot1 - rot0) * e + spin * bell;
          s.rx = rx0 * (1 - e);
          s.ry = ry0 * (1 - e);
          s.scale = sc0 + (sc1 - sc0) * e + peakScale * bell;
          s.lift = clamp(lift0 + (lift1 - lift0) * e + peakLift * bell, 0, 1);
          if (flip1 !== flip0) s.flip = flip0 + (flip1 - flip0) * inOutSine(clamp((t - fa) / (fb - fa), 0, 1));
          if (tracking && L) {
            // In-game flights stay on the table: a bowed, scaled-up card must not be cut by the screen edge
            // or slide under the HUD.
            const ex = (s.scale - 1) * L.cardW * 0.5;
            const ey = (s.scale - 1) * L.cardH * 0.5;
            const maxX = L.w - L.cardW - ex;
            const maxY = L.h - L.cardH - ey;
            if (s.x < ex) s.x = Math.min(ex, Math.max(x0, x1));
            else if (s.x > maxX) s.x = Math.max(maxX, Math.min(x0, x1));
            if (s.y < ey) s.y = Math.min(ey, Math.max(y0, y1));
            else if (s.y > maxY) s.y = Math.max(maxY, Math.min(y0, y1));
          }
          if (trail) trailAt(s, trail);
          if (o.onFrame) o.onFrame(s, t);
          touch(s);
        },
        done: function () {
          if (s.hFlight !== h) return;
          s.hFlight = null;
          s.tracking = false;
          s.liftQ = 0;
          s.x = tracking ? s.tx : fx1;
          s.y = tracking ? s.ty : fy1;
          s.rot = rot1;
          s.rx = 0;
          s.ry = 0;
          s.scale = sc1;
          s.lift = lift1;
          s.flip = flip1;
          touch(s);
          if (o.onLand) o.onLand(s);
          s._settled();
        },
      });
      s.hFlight = h;
      return h;
    }

    /** Position spring. A running spring is retargeted (it keeps its velocity). */
    springTo(x, y, o) {
      o = o || EMPTY;
      const s = this;
      if (s.hPos && s.hPos.setTarget && !s.hFlight) {
        s.hPos.setTarget({ x: x, y: y });
        return s.hPos;
      }
      if (s.hFlight) {
        const f = s.hFlight;
        s.hFlight = null;
        s.tracking = false;
        f.cancel();
      }
      if (s.hPos) {
        const p = s.hPos;
        s.hPos = null;
        p.cancel();
      }
      // (a spring that has nowhere to go leaves a covered card covered: layout sync touches every card)
      if (s.x !== x || s.y !== y) s.cover(false);
      const h = A().spring({
        from: { x: s.x, y: s.y },
        to: { x: x, y: y },
        velocity: o.velocity || 0,
        stiffness: o.stiffness || TUNE.glideStiffness,
        damping: o.damping || TUNE.glideDamping,
        precision: 0.15,
        update: function (v) {
          if (s.hPos !== h) return;
          s.x = v.x;
          s.y = v.y;
          touch(s);
        },
        done: function () {
          if (s.hPos !== h) return;
          s.hPos = null;
          s._settled();
        },
      });
      s.hPos = h;
      return h;
    }

    /** Tweens any of rot / rx / ry / scale / lift from their current values. */
    poseTo(target, o) {
      o = o || EMPTY;
      const s = this;
      if (s.hPose) {
        const p = s.hPose;
        s.hPose = null;
        p.cancel();
      }
      s.cover(false);
      const from = { rot: s.rot, rx: s.rx, ry: s.ry, scale: s.scale, lift: s.lift };
      const to = {
        rot: target.rot === undefined ? s.rot : target.rot,
        rx: target.rx === undefined ? s.rx : target.rx,
        ry: target.ry === undefined ? s.ry : target.ry,
        scale: target.scale === undefined ? s.scale : target.scale,
        lift: target.lift === undefined ? s.lift : target.lift,
      };
      const h = A().tween({
        duration: o.duration === undefined ? 200 : o.duration,
        delay: o.delay || 0,
        ease: o.ease || 'outCubic',
        from: from,
        to: to,
        update: function (v) {
          if (s.hPose !== h) return;
          s.rot = v.rot;
          s.rx = v.rx;
          s.ry = v.ry;
          s.scale = v.scale;
          s.lift = clamp(v.lift, 0, 1);
          touch(s);
        },
        done: function () {
          if (s.hPose !== h) return;
          s.hPose = null;
          s._settled();
        },
      });
      s.hPose = h;
      return h;
    }

    /** Turns the card over in place. `hop` (px): the card jumps and lifts while it turns. */
    flipTo(deg, o) {
      o = o || EMPTY;
      const s = this;
      if (s.hFlip) {
        const p = s.hFlip;
        s.hFlip = null;
        p.cancel();
      }
      s.cover(false);
      const flip0 = s.flip;
      const hop = o.hop || 0;
      s.flipMode = o.mode === SPIN ? SPIN : PROP;
      s.dflip = deg;
      let started = false;
      const h = A().tween({
        duration: o.duration === undefined ? TUNE.revealMs : o.duration,
        delay: o.delay || 0,
        ease: 'linear',
        update: function (t) {
          if (s.hFlip !== h) return;
          if (!started) {
            started = true;
            if (o.onStart) o.onStart(s);
          }
          s.flip = flip0 + (deg - flip0) * inOutSine(t);
          if (hop) {
            const bell = Math.sin(PI * t);
            if (!s.hOff) s.oy = -hop * bell;
            if (!s.hPose && !s.held) {
              s.lift = 0.55 * bell;
              s.scale = 1 + 0.05 * bell;
            }
          }
          touch(s);
        },
        done: function () {
          if (s.hFlip !== h) return;
          s.hFlip = null;
          s.flip = deg;
          if (hop) {
            if (!s.hOff) s.oy = 0;
            if (!s.hPose && !s.held) {
              s.lift = 0;
              s.scale = 1;
            }
          }
          touch(s);
          s._settled();
        },
      });
      s.hFlip = h;
      return h;
    }

    /** Drives the cosmetic offset: fn(t, sprite) sets ox / oy; both are 0 again when it ends. */
    wobble(fn, o) {
      o = o || EMPTY;
      const s = this;
      if (s.hOff) {
        const p = s.hOff;
        s.hOff = null;
        p.cancel();
      }
      s.cover(false);
      const h = A().tween({
        duration: o.duration === undefined ? 260 : o.duration,
        delay: o.delay || 0,
        ease: 'linear',
        update: function (t) {
          if (s.hOff !== h) return;
          fn(t, s);
          touch(s);
        },
        done: function () {
          if (s.hOff !== h) return;
          s.hOff = null;
          s.ox = 0;
          s.oy = 0;
          touch(s);
          s._settled();
        },
      });
      s.hOff = h;
      return h;
    }

    /**
     * Called whenever one of the handles ends. Once nothing runs any more a free sprite must be exactly on its
     * target; if it is not (its target moved, or a motion was cut short) it is sent there.
     */
    _settled() {
      const s = this;
      if (s.held || s.busy()) return;
      const flipT = s.faceUp ? 0 : 180;
      if (s.x !== s.tx || s.y !== s.ty || s.flip !== flipT) {
        place(s, 'glide');
        return;
      }
      s.dx = s.tx;
      s.dy = s.ty;
      s.dflip = flipT;
      if (s.rot !== 0 || s.rx !== 0 || s.ry !== 0 || s.scale !== 1 || s.lift !== 0 || s.ox !== 0 || s.oy !== 0) {
        relax(s);
        return;
      }
      settlePile(s.pile);
    }

    /** Writes the styles (called by the board's frame subscriber for touched sprites). */
    _write() {
      const s = this;
      const st = s.el.style;
      let ry = s.ry;
      const flip = s.flip;
      const down = flip > 90;

      // ---- face
      if (s.flipMode === SPIN && flip !== 0 && flip !== 180) {
        // the card element itself turns; the faces only swap when it is edge-on
        ry += down ? flip - 180 : flip;
        const f = down ? '180deg' : '0deg';
        if (s._wFlip !== f) {
          st.setProperty('--flip', f);
          s._wFlip = f;
        }
      } else {
        const f = flip === 0 ? '0deg' : flip === 180 ? '180deg' : Math.round(flip * 10) / 10 + 'deg';
        if (s._wFlip !== f) {
          st.setProperty('--flip', f);
          s._wFlip = f;
        }
      }
      // Decoration that is not in use is not rendered (board.css): the flip veil only while the card turns
      // on --flip, the lift shadow only while it is off the table. Each is 2-3 compositor layers per card.
      const turning = s.flipMode !== SPIN && flip !== 0 && flip !== 180;
      if (turning !== s._wTurn) {
        s._wTurn = turning;
        s.el.classList.toggle('is-turning', turning);
      }
      const lifted = s.lift > 0 || turning;
      if (lifted !== s._wLifted) {
        s._wLifted = lifted;
        s.el.classList.toggle('is-lifted', lifted);
      }
      if (s._wDown !== down) {
        s._wDown = down;
        s.el.classList.toggle('is-face-down', down);
        // hidden cards are never announced
        s.el.setAttribute('aria-label', down ? 'Face-down card' : SOL.Cards.label(s.id));
      }

      // ---- transform
      let t = 'translate3d(' + r2(s.x + s.ox) + 'px,' + r2(s.y + s.oy) + 'px,0)';
      if (s.rx !== 0 || ry !== 0) t += ' rotateX(' + r2(s.rx) + 'deg) rotateY(' + r2(ry) + 'deg)';
      if (s.rot !== 0) t += ' rotate(' + r2(s.rot) + 'deg)';
      if (s.scale !== 1) t += ' scale(' + Math.round(s.scale * 1000) / 1000 + ')';
      if (t !== s._wT) {
        st.transform = t;
        s._wT = t;
      }

      // ---- lift (shadow)
      // Quantised: the shadow cross-fade does not need 60 distinct values a second, and every write of an
      // inherited custom property is a small restyle of the card.
      const q = s.liftQ || TUNE.liftSteps;
      const lift = s.lift <= 0 ? '0' : String(Math.round((Math.max(1, Math.round(s.lift * q)) / q) * 1000) / 1000);
      if (lift !== s._wLift) {
        st.setProperty('--lift', lift);
        s._wLift = lift;
      }

      // ---- stacking
      if (s.z !== s._wZ) {
        st.zIndex = String(s.z);
        s._wZ = s.z;
      }
    }
  }

  /**
   * Housekeeping for one pile, run whenever one of its cards lands and after every state change:
   *
   * 1. Resting z-index — from the bottom up, and only as far as the first card that is still in the air.
   *    A run lands as several cards at slightly different times; if each one dropped to its resting z on its
   *    own, a card that is still raised would cover the ones above it that have already landed. They keep
   *    their raised (and correctly ordered) z until everything below them is down.
   * 2. Covering — cards resting deep inside the stock, the waste or a foundation cannot be seen: they are
   *    taken out of rendering (Sprite.cover). The top few stay: the next ones a move can expose.
   */
  function settlePile(pileId) {
    const arr = state && !deckMode ? state.piles[pileId] : null;
    if (!arr) return;
    const n = arr.length;
    const keep =
      pileId === 'stock'
        ? TUNE.keepStock
        : pileId === 'waste'
          ? L.draw3
            ? TUNE.keepWaste3
            : TUNE.keepWaste
          : pileId.charAt(0) === 'f'
            ? TUNE.keepFoundation
            : -1;
    let blocked = false;
    let resting = 0;
    for (let i = 0; i < n; i++) {
      const c = sprites[arr[i]];
      if (c.held) {
        blocked = true;
        c.cover(false);
        continue;
      }
      if (c.busy()) {
        if (c.z >= TUNE.flyZ) blocked = true;
        c.cover(false);
        continue;
      }
      if (!blocked && c.z !== c.tz) {
        c.z = c.tz;
        touch(c);
      }
      c.cover(keep >= 0 && i < n - keep);
      resting++;
    }
    // The stock's slot doubles as the visible edge of the pile (css: .pile--stock.is-stacked): the top cards
    // sit a few px up and to the left of it, the covered ones below are not drawn.
    if (pileId === 'stock' && pileEls.stock) pileEls.stock.classList.toggle('is-stacked', resting > 0);
  }

  function nextFlyZ() {
    if (zSeq > 1500) zSeq = 0;
    return TUNE.flyZ + zSeq++;
  }

  function flightMs(dist) {
    return clamp(TUNE.flyBase + dist * TUNE.flyPerPx, TUNE.flyMin, TUNE.flyMax);
  }

  /** Tweens pose and offset back to rest (a card that stopped mid-air, or was tilted). */
  function relax(s, ms) {
    if (!s.hPose && (s.rot !== 0 || s.rx !== 0 || s.ry !== 0 || s.scale !== 1 || s.lift !== 0)) {
      s.poseTo({ rot: 0, rx: 0, ry: 0, scale: 1, lift: 0 }, { duration: ms || 220 });
    }
    if (!s.hOff && (s.ox !== 0 || s.oy !== 0)) {
      const ox = s.ox;
      const oy = s.oy;
      s.wobble(
        function (t, sp) {
          const k = 1 - outCubic(t);
          sp.ox = ox * k;
          sp.oy = oy * k;
        },
        { duration: ms || 200 }
      );
    }
  }

  // ------------------------------------------------------------------ frame subscriber: style writes + drag
  function touch(s) {
    if (!s._dirty) {
      s._dirty = true;
      dirty.push(s);
    }
    wake();
  }

  function wake() {
    idleFrames = 0;
    if (!stopTick && inited && SOL.Anim) stopTick = SOL.Anim.frame(tick);
  }

  function flush() {
    for (let i = 0; i < dirty.length; i++) {
      const s = dirty[i];
      s._dirty = false;
      s._write();
    }
    dirty.length = 0;
  }

  function tick(dt) {
    if (drag && !drag.released) dragFrame(dt);
    if (dirty.length !== 0) {
      idleFrames = 0;
      flush();
    } else if (!drag || drag.released) {
      // nothing to write: after a few quiet frames the subscription goes away (the Anim loop can sleep)
      if (++idleFrames > 3 && stopTick) {
        stopTick();
        stopTick = null;
      }
    }
  }

  // ------------------------------------------------------------------ layout model
  function readInsets() {
    const out = { l: 0, r: 0 };
    if (!probeEl || !root.getComputedStyle) return out;
    try {
      const cs = root.getComputedStyle(probeEl);
      out.l = parseFloat(cs.paddingLeft) || 0;
      out.r = parseFloat(cs.paddingRight) || 0;
    } catch (err) {
      /* keep zeros */
    }
    return out;
  }

  /**
   * Measures #table and derives every pile position. The only place that reads layout from the DOM.
   * Returns true when the metrics changed.
   */
  function computeLayout() {
    const box = tableEl.getBoundingClientRect();
    const safe = readInsets();
    const W = Math.max(120, box.width);
    const H = Math.max(120, box.height);

    const base = clamp(W * 0.014, 4, 22);
    // The HUD / toolbar pad the top and bottom insets themselves; the table only has to dodge side cutouts.
    const padL = base + safe.l;
    const padR = base + safe.r;
    const padT = clamp(H * 0.012, 4, 14);
    const padB = clamp(H * 0.014, 5, 16);
    const availW = Math.max(60, W - padL - padR);
    const availH = Math.max(60, H - padT - padB);
    const rowK = 0.14;

    // ---- arrangement A, "top row": foundations + waste + stock above seven columns that span the width.
    // Height cap: the top row plus one tableau card plus `fanRoom` card heights of fan must fit.
    let gap = clamp(availW * 0.011, 3, 20);
    let cardW = (availW - 6 * gap) / 7;
    let capped = false;
    const byHeight = availH / (2 + rowK + TUNE.fanRoom) / ASPECT;
    if (cardW > byHeight) {
      cardW = byHeight;
      capped = true;
    }
    if (cardW > TUNE.maxCardW) {
      cardW = TUNE.maxCardW;
      capped = true;
    }

    // ---- arrangement B, "side": on wide, short tables (a phone held sideways) the top row costs too much
    // height. The foundations (2 x 2) go to one side of the columns, stock and waste to the other; the
    // columns get the whole height and the cards come out about a third bigger.
    const sideGapK = 0.15;
    const sideCols = 10 + 11 * sideGapK; // 2 + 7 + 1 columns, 9 gaps, 2 slightly wider gaps between the groups
    const sideW = Math.min(availW / sideCols, availH / (1 + TUNE.fanRoom) / ASPECT, TUNE.maxCardW);
    const side = sideW >= cardW * TUNE.sideGain;
    if (side) cardW = sideW;

    cardW = Math.max(22, cardW >= 60 ? Math.floor(cardW) : Math.floor(cardW * 2) / 2);
    const cardH = cardW * ASPECT;
    const compact = cardW < 60; // cards.css swaps to the phone art below 60px
    const rowGap = clamp(cardH * rowK, 7, 30);
    const top = Math.round(padT);
    const bottom = H - padB;
    const draw3 = !!(state && state.drawCount === 3);
    const piles = {};
    const col = [];
    let wasteFanX = 0;
    let wasteFanY = 0;
    let ty;

    if (side) {
      gap = Math.min(clamp(cardW * sideGapK * 1.25, 5, 30), (availW - 10 * cardW) / 11);
      const sep = gap * 2; // between the side groups and the columns
      const total = 10 * cardW + 7 * gap + 2 * sep;
      const x0 = padL + (availW - total) / 2;
      const step = cardW + gap;
      ty = top;
      const row2 = Math.round(top + cardH + rowGap);
      wasteFanY = Math.round(cardH * (compact ? TUNE.upCompact : TUNE.upClassic) * 0.9);
      let xT;
      if (leftHanded) {
        const xS = Math.round(x0);
        xT = x0 + cardW + sep;
        const xF = xT + 6 * step + cardW + sep;
        piles.stock = { x: xS, y: top };
        piles.waste = { x: xS, y: row2 };
        for (let i = 0; i < 4; i++) piles[FOUNDATIONS[i]] = { x: Math.round(xF + (i % 2) * step), y: i < 2 ? top : row2 };
      } else {
        xT = x0 + 2 * cardW + gap + sep;
        const xS = Math.round(xT + 6 * step + cardW + sep);
        piles.stock = { x: xS, y: top };
        piles.waste = { x: xS, y: row2 };
        for (let i = 0; i < 4; i++) piles[FOUNDATIONS[i]] = { x: Math.round(x0 + (i % 2) * step), y: i < 2 ? top : row2 };
      }
      for (let i = 0; i < 7; i++) col.push(Math.round(xT + i * step));
    } else {
      gap = capped ? Math.min(clamp(cardW * 0.2, 6, 32), (availW - 7 * cardW) / 6) : (availW - 7 * cardW) / 6;
      const total = 7 * cardW + 6 * gap;
      const x0 = padL + (availW - total) / 2;
      for (let i = 0; i < 7; i++) col.push(Math.round(x0 + i * (cardW + gap)));
      ty = Math.round(top + cardH + rowGap);
      wasteFanX = Math.round(cardW * (compact ? TUNE.wasteFanCompact : TUNE.wasteFanClassic));
      if (leftHanded) {
        piles.stock = { x: col[0], y: top };
        piles.waste = { x: col[1], y: top };
        for (let i = 0; i < 4; i++) piles[FOUNDATIONS[i]] = { x: col[3 + i], y: top };
      } else {
        piles.stock = { x: col[6], y: top };
        // draw 3: the fan grows towards the stock and its top card ends in column 5
        piles.waste = { x: col[5] - (draw3 ? 2 * wasteFanX : 0), y: top };
        for (let i = 0; i < 4; i++) piles[FOUNDATIONS[i]] = { x: col[i], y: top };
      }
    }
    for (let i = 0; i < 7; i++) piles[TABLEAU[i]] = { x: col[i], y: ty };

    const deckScale = clamp(TUNE.deckScale, 1, Math.max(1, (W * 0.5) / (cardW * 2.4)));
    const next = {
      w: W,
      h: H,
      left: box.left,
      top: box.top,
      cardW: cardW,
      cardH: cardH,
      gap: gap,
      rowGap: rowGap,
      topY: top,
      tableauY: ty,
      bottom: bottom,
      compact: compact,
      side: side,
      upFan: cardH * (compact ? TUNE.upCompact : TUNE.upClassic),
      downFan: cardH * TUNE.down,
      wasteFan: wasteFanX,
      wasteFanX: wasteFanX,
      wasteFanY: wasteFanY,
      draw3: draw3,
      leftHanded: leftHanded,
      piles: piles,
      deck: {
        x: Math.round((W - cardW) / 2),
        y: Math.round(clamp((H - cardH) * 0.46, Math.min(ty, H - cardH * 1.2), Math.max(ty, H - cardH * 1.7))),
        scale: deckScale,
      },
    };
    const changed =
      !L ||
      L.w !== next.w ||
      L.h !== next.h ||
      L.cardW !== next.cardW ||
      L.gap !== next.gap ||
      L.side !== next.side ||
      L.leftHanded !== next.leftHanded ||
      L.draw3 !== next.draw3 ||
      L.piles.stock.x !== next.piles.stock.x ||
      L.piles.t0.x !== next.piles.t0.x;
    L = next;
    return changed;
  }

  /** Writes the card size and the slot positions. */
  function applyLayout() {
    const st = tableEl.style;
    st.setProperty('--card-w', L.cardW + 'px');
    st.setProperty('--card-h', r2(L.cardH) + 'px');
    st.setProperty('--card-radius', r2(L.cardW * 0.075) + 'px');
    for (let i = 0; i < PILE_IDS.length; i++) {
      const id = PILE_IDS[i];
      const p = L.piles[id];
      pileEls[id].style.transform = 'translate3d(' + p.x + 'px,' + p.y + 'px,0)';
    }
  }

  /** Fan offsets (px) of a tableau column with `nDown` face-down and `nUp` face-up cards. */
  function columnFan(nDown, nUp) {
    let down = L.downFan;
    let up = L.upFan;
    const upSteps = Math.max(0, nUp - 1);
    const room = L.bottom - L.tableauY - L.cardH;
    const need = nDown * down + upSteps * up;
    if (need > room && need > 0) {
      const k = Math.max(0, room) / need;
      down = Math.max(L.cardH * TUNE.downMin, down * k);
      if (upSteps > 0) {
        up = (room - nDown * down) / upSteps;
        const floor = L.cardH * TUNE.upMin;
        if (up < floor) {
          // even the minimum does not fit: squeeze both so the column still ends on the table
          up = Math.max(2, floor);
          const again = nDown * down + upSteps * up;
          if (again > room && again > 0) {
            const k2 = Math.max(0, room) / again;
            down *= k2;
            up *= k2;
          }
        }
      } else {
        down = Math.max(1, room / Math.max(1, nDown));
      }
    }
    return { down: down, up: up };
  }

  /** A little visible thickness for the stock (and the deck). */
  function thickness(i) {
    const step = Math.min(8, Math.floor(i / 3));
    const u = L.cardW / 100;
    return { x: -step * 0.45 * u, y: -step * 0.7 * u };
  }

  /** Logical targets of all 52 sprites from the engine state (or the deck arrangement in deck mode). */
  function retarget() {
    if (!L) return;
    if (deckMode || !state) {
      // sprites keep their deck index (set by gather / init)
      for (let i = 0; i < 52; i++) {
        const s = sprites[i];
        const th = thickness(s.index);
        s.tx = Math.round(L.deck.x + th.x * 2);
        s.ty = Math.round(L.deck.y + th.y * 2);
        s.tz = s.index;
        s.faceUp = false;
      }
      return;
    }
    const piles = state.piles;
    const faces = state.faceUp;
    for (let p = 0; p < PILE_IDS.length; p++) {
      const id = PILE_IDS[p];
      const arr = piles[id];
      const origin = L.piles[id];
      const n = arr.length;
      if (p >= 6) {
        // tableau
        let nDown = 0;
        for (let i = 0; i < n; i++) if (!faces[arr[i]]) nDown++;
        const fan = columnFan(nDown, n - nDown);
        let y = origin.y;
        for (let i = 0; i < n; i++) {
          const s = sprites[arr[i]];
          const up = !!faces[arr[i]];
          s.pile = id;
          s.index = i;
          s.tx = origin.x;
          s.ty = Math.round(y);
          s.tz = i;
          s.faceUp = up;
          y += up ? fan.up : fan.down;
        }
      } else if (id === 'waste') {
        const shown = L.draw3 ? Math.min(3, n) : 1;
        for (let i = 0; i < n; i++) {
          const s = sprites[arr[i]];
          const fromTop = n - 1 - i;
          const slot = Math.max(0, shown - 1 - fromTop);
          s.pile = id;
          s.index = i;
          s.tx = origin.x + slot * L.wasteFanX;
          s.ty = origin.y + slot * L.wasteFanY;
          s.tz = i;
          s.faceUp = !!faces[arr[i]];
        }
      } else if (id === 'stock') {
        for (let i = 0; i < n; i++) {
          const s = sprites[arr[i]];
          const th = thickness(i);
          s.pile = id;
          s.index = i;
          s.tx = Math.round(origin.x + th.x);
          s.ty = Math.round(origin.y + th.y);
          s.tz = i;
          s.faceUp = !!faces[arr[i]];
        }
      } else {
        for (let i = 0; i < n; i++) {
          const s = sprites[arr[i]];
          s.pile = id;
          s.index = i;
          s.tx = origin.x;
          s.ty = origin.y;
          s.tz = i;
          s.faceUp = !!faces[arr[i]];
        }
      }
    }
    const stockEl = pileEls.stock;
    if (stockEl) stockEl.classList.toggle('is-spent', piles.stock.length === 0 && piles.waste.length === 0);
  }

  /**
   * Brings one sprite to its logical target.
   *   'instant'  no animation
   *   'glide'    spring (layout changes, neighbours making room); the face turns in place if it has to
   *   'fly'      an arcing flight, options as Sprite.fly
   */
  function place(s, how, o) {
    const flipT = s.faceUp ? 0 : 180;
    if (how === 'instant') {
      s.stop();
      s.x = s.tx;
      s.y = s.ty;
      s.ox = 0;
      s.oy = 0;
      s.rot = 0;
      s.rx = 0;
      s.ry = 0;
      s.scale = 1;
      s.lift = 0;
      s.flip = flipT;
      s.z = s.tz;
      s.dx = s.tx;
      s.dy = s.ty;
      s.dflip = flipT;
      touch(s);
      return null;
    }
    if (how === 'fly') {
      const opts = Object.assign({}, o);
      delete opts.x;
      delete opts.y;
      opts.flip = flipT;
      return s.fly(opts);
    }
    // glide
    o = o || EMPTY;
    const wasFlying = !!s.hFlight;
    if (!s.hOff) s._fold(); // (a running wobble keeps driving the offset and ends at 0 by itself)
    const h = s.springTo(s.tx, s.ty, o);
    s.dx = s.tx;
    s.dy = s.ty;
    if (!wasFlying && s.z < TUNE.flyZ) s.z = s.tz;
    if (s.flip !== flipT && (s.dflip !== flipT || !s.hFlip)) {
      s.flipTo(flipT, { duration: 240, mode: o.flipMode });
    }
    s.dflip = flipT;
    relax(s);
    touch(s);
    return h;
  }

  /** Re-places every free sprite whose target differs from where its current motion ends. */
  function sync(how, o) {
    for (let i = 0; i < 52; i++) {
      const s = sprites[i];
      if (s.held) continue;
      const flipT = s.faceUp ? 0 : 180;
      if (s.dx !== s.tx || s.dy !== s.ty || s.dflip !== flipT) {
        if (s.hFlight && s.tracking && s.dflip === flipT) {
          // already flying to its target: the flight follows the moved target by itself
          s.dx = s.tx;
          s.dy = s.ty;
        } else {
          place(s, how || 'glide', o);
        }
      }
    }
    if (state && !deckMode) for (let p = 0; p < PILE_IDS.length; p++) settlePile(PILE_IDS[p]);
  }

  // ------------------------------------------------------------------ DOM
  const RECYCLE_SVG =
    '<svg class="pile__mark" viewBox="0 0 100 100" aria-hidden="true" focusable="false" fill="none" ' +
    'stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M80 50a30 30 0 0 1-52.5 19.8"/><path d="M20 50a30 30 0 0 1 52.5-19.8"/>' +
    '<path d="M74 12v19H55"/><path d="M26 88V69h19"/></svg>';

  function buildPiles() {
    pilesEl.textContent = '';
    for (let i = 0; i < PILE_IDS.length; i++) {
      const id = PILE_IDS[i];
      const el = doc.createElement('div');
      const kind = id === 'stock' || id === 'waste' ? id : id.charAt(0) === 'f' ? 'foundation' : 'tableau';
      el.className = 'pile pile--' + kind;
      el.setAttribute('data-pile', id);
      if (kind === 'stock') {
        el.innerHTML = RECYCLE_SVG;
      } else if (kind === 'foundation') {
        const suit = Number(id.charAt(1));
        el.setAttribute('data-suit', SUIT_NAMES[suit]);
        el.innerHTML = SOL.Cards.suitSvg(suit, { size: '50%', className: 'pile__mark' });
        el.style.setProperty('--pulse-color', SUIT_GLOW[suit]);
      }
      pilesEl.appendChild(el);
      pileEls[id] = el;
    }
    // invisible probe: resolves the safe-area insets (env() / native overrides) to pixels
    probeEl = doc.createElement('div');
    probeEl.setAttribute('aria-hidden', 'true');
    probeEl.style.cssText =
      'position:absolute;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
      'padding:0 var(--safe-r,0px) 0 var(--safe-l,0px);box-sizing:content-box';
    pilesEl.appendChild(probeEl);
  }

  function buildCards() {
    cardsEl.textContent = '';
    let back;
    try {
      back = SOL.Settings ? SOL.Settings.get('cardBack') : undefined;
    } catch (err) {
      back = undefined;
    }
    const frag = doc.createDocumentFragment();
    for (let id = 0; id < 52; id++) {
      const el = SOL.Cards.create(id, { back: back });
      const s = new Sprite(id, el);
      sprites[id] = s;
      frag.appendChild(el);
    }
    cardsEl.appendChild(frag);
  }

  function init(opts) {
    if (inited) return true;
    if (!doc || !SOL.Anim || !SOL.Cards || !SOL.Engine) return false;
    opts = opts || EMPTY;
    tableEl = opts.table || doc.getElementById('table');
    pilesEl = opts.piles || doc.getElementById('piles');
    cardsEl = opts.cards || doc.getElementById('cards');
    if (!tableEl || !pilesEl || !cardsEl) return false;

    overlayEl = doc.createElement('div');
    overlayEl.className = 'table__overlay';
    overlayEl.setAttribute('aria-hidden', 'true');
    tableEl.appendChild(overlayEl);

    try {
      leftHanded = !!(SOL.Settings && SOL.Settings.get('leftHanded'));
    } catch (err) {
      leftHanded = false;
    }
    buildPiles();
    buildCards();
    inited = true;

    computeLayout();
    applyLayout();
    // Before any game exists the cards wait as a deck, centre stage.
    deckMode = true;
    for (let i = 0; i < 52; i++) sprites[i].index = i;
    deckSnap();
    flush();

    if (typeof root.ResizeObserver === 'function') {
      resizeObserver = new root.ResizeObserver(function () {
        relayout();
      });
      resizeObserver.observe(tableEl);
    }
    root.addEventListener('resize', relayout);
    root.addEventListener('orientationchange', relayout);
    if (SOL.Bus) {
      SOL.Bus.on('app:insets', function () {
        relayout();
      });
    }
    return true;
  }

  /** Puts every sprite of the deck on the deck spot, instantly (deck mode). */
  function deckSnap() {
    retarget();
    for (let i = 0; i < 52; i++) {
      const s = sprites[i];
      s.stop();
      s.cover(false);
      s.held = 'deck';
      s.x = s.tx;
      s.y = s.ty;
      s.ox = 0;
      s.oy = 0;
      s.rot = 0;
      s.rx = 0;
      s.ry = 0;
      s.scale = L.deck.scale;
      s.lift = 0;
      s.flip = 180;
      s.z = s.tz;
      s.dx = s.tx;
      s.dy = s.ty;
      s.dflip = 180;
      touch(s);
    }
  }

  function relayout() {
    if (!inited) return;
    const changed = computeLayout();
    if (!changed) return;
    // A layout change under a finger: the held run goes home first (no stuck drag).
    if (drag) dragCancel();
    clearHint();
    applyLayout();
    retarget();
    for (let i = 0; i < 52; i++) {
      const s = sprites[i];
      if (s.held !== 'deck') continue;
      // cards still in the deck (shuffling, or waiting to be dealt) jump with it: nobody can tell them apart
      s.stop();
      if (deckMode) {
        s.x = s.tx;
        s.y = s.ty;
        s.dx = s.tx;
        s.dy = s.ty;
      } else {
        const th = thickness(s.z);
        s.x = Math.round(L.deck.x + th.x * 2);
        s.y = Math.round(L.deck.y + th.y * 2);
      }
      s.ox = 0;
      s.oy = 0;
      s.rot = 0;
      s.rx = 0;
      s.ry = 0;
      s.scale = L.deck.scale;
      s.lift = 0;
      s.flip = 180;
      touch(s);
    }
    sync('glide');
    if (SOL.Bus) SOL.Bus.emit('board:layout', layoutInfo());
  }

  function layoutInfo() {
    if (!L) return null;
    const piles = {};
    for (let i = 0; i < PILE_IDS.length; i++) {
      const p = L.piles[PILE_IDS[i]];
      piles[PILE_IDS[i]] = { x: p.x, y: p.y };
    }
    return {
      w: L.w,
      h: L.h,
      left: L.left,
      top: L.top,
      cardW: L.cardW,
      cardH: L.cardH,
      gap: L.gap,
      upFan: L.upFan,
      downFan: L.downFan,
      wasteFan: L.wasteFan,
      wasteFanX: L.wasteFanX,
      wasteFanY: L.wasteFanY,
      side: L.side,
      tableauY: L.tableauY,
      bottom: L.bottom,
      leftHanded: L.leftHanded,
      compact: L.compact,
      piles: piles,
      deck: { x: L.deck.x, y: L.deck.y, scale: L.deck.scale },
    };
  }

  function toClient(x, y) {
    return { x: (L ? L.left : 0) + x, y: (L ? L.top : 0) + y };
  }

  // ------------------------------------------------------------------ rendering a state
  /** Leaves any choreography / drag / hint and forgets the deck. */
  function resetTransient() {
    choreoGen++;
    takeDrag();
    unpress();
    clearHint();
    deckMode = false;
    for (let i = 0; i < 52; i++) {
      const s = sprites[i];
      if (s.held) releaseSprite(s);
    }
  }

  function releaseSprite(s) {
    s.held = null;
    s.soft = false;
    s.el.classList.remove('is-dragging');
  }

  function setState(next) {
    const draw3Before = L ? L.draw3 : false;
    state = next;
    const draw3 = !!(state && state.drawCount === 3);
    if (L && draw3 !== draw3Before) {
      computeLayout();
      applyLayout();
    }
  }

  function render(next) {
    if (!inited || !next) return;
    resetTransient();
    setState(next);
    retarget();
    for (let i = 0; i < 52; i++) {
      sprites[i].cover(false);
      place(sprites[i], 'instant');
    }
    for (let p = 0; p < PILE_IDS.length; p++) settlePile(PILE_IDS[p]);
    refreshInvite();
    flush();
  }

  function restore(next) {
    if (!inited || !next) return;
    render(next);
    if (reduced()) return;
    cardsEl.classList.remove('is-entering');
    cardsEl.classList.add('is-entering');
    // every pile drops into place from a little above, column by column
    for (let p = 0; p < PILE_IDS.length; p++) {
      const arr = state.piles[PILE_IDS[p]];
      const from = Math.max(0, arr.length - 14); // deep cards of a tall pile are hidden anyway
      for (let i = from; i < arr.length; i++) {
        const s = sprites[arr[i]];
        const delay = p * 16 + (i - from) * 7;
        const drop = L.cardH * 0.16;
        s.oy = -drop;
        s.lift = 0.5;
        s.scale = 1.03;
        touch(s);
        s.wobble(
          function (t, sp) {
            sp.oy = -drop * (1 - outCubic(t));
          },
          { duration: 300, delay: delay }
        );
        s.poseTo({ lift: 0, scale: 1 }, { duration: 300, delay: delay });
      }
    }
    flush();
  }

  // ------------------------------------------------------------------ effects
  function pulse(pileId, color) {
    const el = pileEls[pileId];
    if (!el) return;
    // Two identical animations under two class names: swapping restarts it without forcing a reflow.
    pulseFlip = !pulseFlip;
    el.classList.remove('is-pulse', 'is-pulse-b');
    if (color) el.style.setProperty('--pulse-color', color);
    el.classList.add(pulseFlip ? 'is-pulse' : 'is-pulse-b');
  }

  function scorePop(x, y, delta) {
    if (!delta || !L) return;
    const text = (delta > 0 ? '+' : '\u2212') + Math.abs(delta); // a real minus sign
    const rise = clamp(L.cardH * 0.6, 30, 70);
    // Near the top of the table the label starts lower (on the card) so it never drifts over the HUD.
    if (y - rise < L.cardH * 0.08) y += Math.min(L.cardH * 0.7, rise + L.cardH * 0.08);
    const f = fx();
    if (f) {
      const c = toClient(x + L.cardW / 2, y);
      f.floatText(c.x, c.y - 4, text, {
        color: delta > 0 ? GOLD : MINUS,
        size: clamp(L.cardW * 0.36, 15, 30),
        rise: rise,
        duration: 950,
      });
      return;
    }
    // Canvas effects are off (reduced motion, or no FX module): a plain label that shows and goes.
    if (!overlayEl) return;
    const el = doc.createElement('div');
    el.className = 'score-pop' + (delta < 0 ? ' score-pop--minus' : '');
    el.textContent = text;
    el.style.transform = 'translate3d(' + Math.round(x + L.cardW / 2) + 'px,' + Math.round(y - 6) + 'px,0) translate(-50%,-100%)';
    overlayEl.appendChild(el);
    // A display timeout, not animation sequencing: under reduced motion SOL.Anim.wait resolves at once.
    root.setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 950);
  }

  function trailAt(s, color) {
    const f = fx();
    if (!f || !L) return;
    f.trail(L.left + s.x + L.cardW / 2, L.top + s.y + L.cardH / 2, {
      color: color,
      size: clamp(L.cardW * 0.045, 2, 5),
    });
  }

  /** A card arrived on its foundation: slot pulse, particles, pitch, haptic. */
  function foundationArrive(s, o) {
    const suit = suitOf(s.id);
    const rank = rankOf(s.id);
    const quiet = !!(o && o.quiet);
    pulse(s.pile, SUIT_GLOW[suit]);
    try {
      if (SOL.Audio) SOL.Audio.playFoundation(rank, { pan: panOf(s.tx), volume: quiet ? 0.8 : 1 });
    } catch (err) {
      /* ignore */
    }
    haptic(rank === 13 ? 'win' : 'success');
    const f = fx();
    if (!f || !L) return;
    const w = L.cardW;
    const cx = L.left + s.tx + w / 2;
    const cy = L.top + s.ty + L.cardH / 2;
    f.ring(cx, cy, { color: SUIT_GLOW[suit], radius: w * 1.05, width: Math.max(2, w * 0.035), duration: 460 });
    f.burst(cx, cy, {
      kind: 'suit',
      suit: suit,
      count: quiet ? 5 : 9,
      size: clamp(w * 0.11, 5, 13),
      speed: w * 3.6,
      gravity: w * 8,
    });
    f.burst(cx, cy, { kind: 'spark', count: quiet ? 6 : 12, speed: w * 4.4, size: clamp(w * 0.035, 1.6, 3.2), gravity: w * 7 });
    if (rank === 13) {
      f.shimmer({ x: L.left + s.tx, y: L.top + s.ty, width: w, height: L.cardH }, { radius: w * 0.075, duration: 900 });
      f.burst(cx, cy, { kind: 'star', count: 14, speed: w * 3, size: clamp(w * 0.1, 4, 10) });
    }
  }

  /** The card a run lands on gives a little. */
  function bump(pileId, belowIndex) {
    if (!state || belowIndex < 0 || reduced()) return;
    const id = state.piles[pileId][belowIndex];
    if (id === undefined) return;
    const s = sprites[id];
    if (s.held || s.hFlight || s.hOff) return;
    const amp = clamp(L.cardH * 0.022, 1, 3);
    s.wobble(
      function (t, sp) {
        sp.oy = amp * Math.sin(PI * t) * (1 - t);
      },
      { duration: 200 }
    );
  }

  function shakeSprite(s, delay, strength) {
    if (s.hFlight || reduced()) return;
    const amp = clamp(L.cardW * 0.07, 3, 9) * (strength || 1);
    s.wobble(
      function (t, sp) {
        sp.ox = amp * Math.sin(t * PI * 6) * (1 - t);
      },
      { duration: 320, delay: delay || 0 }
    );
  }

  // ------------------------------------------------------------------ applying engine records
  /**
   * Bow of a flight: `want` px towards the top of the screen, unless that would leave the table through the
   * top edge (under the HUD) — then the path dips the other way instead.
   */
  function arcFor(s, want) {
    const room = (s.y + s.ty) / 2 + L.cardH * 0.12;
    if (want <= room) return want;
    return room >= want * 0.45 ? room : -want * 0.5;
  }

  function apply(next, record, opts) {
    if (!inited || !next || !record) return;
    const o = opts || EMPTY;
    if (deckMode) {
      // a state arrives while the deck is still out: just show it
      render(next);
      return;
    }
    const dropped = takeDrag(); // sprites that were in the player's hand (or null)
    releaseSoft();
    clearHint();
    setState(next);
    retarget();

    const undo = record.type === 'undo';
    const base = undo ? record.undone : record;
    const tempo = undo ? TUNE.undoTempo : 1;
    const transfers = record.transfers || [];
    const flips = record.flips || [];
    const moved = new Set();
    for (let i = 0; i < transfers.length; i++) moved.add(transfers[i].card);
    const delta = (record.scoreAfter || 0) - (record.scoreBefore || 0);

    if (base.type === 'draw') {
      applyDraw(transfers, undo, tempo);
    } else if (base.type === 'recycle') {
      applyRecycle(transfers, undo, tempo, delta);
    } else {
      applyMove(transfers, flips, moved, undo, tempo, o, dropped, delta);
    }

    // a run that was in the hand but is not part of this record goes home
    if (dropped) {
      for (let i = 0; i < dropped.sprites.length; i++) {
        const s = dropped.sprites[i];
        if (!moved.has(s.id)) {
          s.dx = NaN; // force a re-place
        }
      }
    }
    // everything else that changed place: columns re-fanning, the waste fan closing up
    sync('glide');
    if (undo) {
      sfx('undo');
      haptic('tap');
    }
  }

  function applyDraw(transfers, undo, tempo) {
    const n = transfers.length;
    for (let i = 0; i < n; i++) {
      const s = sprites[transfers[i].card];
      const dir = s.tx < s.x ? -1 : 1;
      place(s, 'fly', {
        duration: TUNE.drawMs * tempo,
        delay: i * TUNE.drawGap * tempo,
        // a small dip towards the player (sideways when the waste sits under the stock)
        arc: L.side ? 0 : -L.cardH * 0.1,
        side: L.side ? (L.leftHanded ? -1 : 1) * (s.ty > s.y ? 1 : -1) * L.cardW * 0.14 : 0,
        spin: dir * 5,
        peakLift: 0.85,
        peakScale: 0.1,
        flipMode: PROP,
        flipFrom: 0.08,
        flipTo: 0.78,
        onStart: undo
          ? null
          : function (sp) {
              sfx('draw', { pan: panOf(sp.x) });
            },
        onLand:
          undo || i !== n - 1
            ? null
            : function () {
                haptic('tap');
              },
      });
    }
    if (!undo) haptic('tick');
  }

  function applyRecycle(transfers, undo, tempo, delta) {
    const n = transfers.length;
    const gap = Math.min(22, TUNE.recycleSpan / Math.max(1, n)) * tempo;
    for (let i = 0; i < n; i++) {
      const s = sprites[transfers[i].card];
      const dir = s.tx < s.x ? -1 : 1;
      place(s, 'fly', {
        duration: TUNE.recycleMs * tempo,
        delay: i * gap,
        arc: L.side ? 0 : -L.cardH * (0.1 + 0.12 * ((i % 3) / 2)),
        side: L.side ? (L.leftHanded ? -1 : 1) * (s.ty > s.y ? 1 : -1) * L.cardW * (0.1 + 0.1 * ((i % 3) / 2)) : 0,
        spin: dir * 7,
        peakLift: 0, // up to 24 cards at once: transform only — no shadow layers, no restyles
        peakScale: 0.05,
        flipMode: SPIN,
        flipFrom: 0.1,
        flipTo: 0.85,
        overshoot: 0,
      });
    }
    if (!undo) {
      sfx('recycle', { duration: n * gap + TUNE.recycleMs * 0.6, pan: panOf(L.piles.stock.x) });
      haptic('thud');
      pulse('stock', GOLD);
      if (delta) scorePop(L.piles.stock.x, L.piles.stock.y + L.cardH * 0.4, delta);
    }
  }

  function applyMove(transfers, flips, moved, undo, tempo, o, dropped, delta) {
    const n = transfers.length;
    if (n === 0) return;
    const lead = sprites[transfers[0].card];
    const toPile = transfers[0].to;
    const toFoundation = toPile.charAt(0) === 'f';
    const fromDrag = !!(dropped && o.source === 'drag' && dropped.sprites.indexOf(lead) !== -1);
    const auto = !!o.auto;

    if (fromDrag) {
      // the run is in the player's hand: it springs from the pointer onto the pile
      for (let i = 0; i < n; i++) {
        const s = sprites[transfers[i].card];
        s._fold();
        s.z = TUNE.dragZ + i;
        s.dx = s.tx;
        s.dy = s.ty;
        s.dflip = s.faceUp ? 0 : 180;
        s.springTo(s.tx, s.ty, {
          stiffness: Math.max(170, TUNE.dropStiffness - i * 26),
          damping: TUNE.dropDamping,
          velocity: { x: dropped.vx, y: dropped.vy },
        });
        s.poseTo({ rot: 0, rx: 0, ry: 0, scale: 1, lift: 0 }, { duration: 230 + i * 20, ease: 'outCubic' });
        touch(s);
      }
      sfx('place', { pan: panOf(lead.tx) });
      if (toFoundation) foundationArrive(lead);
      else {
        haptic('thud');
        bump(toPile, lead.index - 1);
      }
      if (delta) scorePop(lead.tx, lead.ty, delta);
    } else {
      const dist = Math.hypot(lead.tx - lead.x, lead.ty - lead.y);
      const baseMs = (auto ? clamp(flightMs(dist) * 0.82, 220, 400) : flightMs(dist) * (toFoundation ? 1.12 : 1)) * tempo;
      const want = L.cardH * (toFoundation ? TUNE.arcFoundation : TUNE.arc) * clamp(dist / (L.cardW * 3), 0.35, 1);
      const arc = arcFor(lead, want);
      // foundation flights also bow sideways — always towards the middle of the table, never off its edge
      let side = 0;
      if (toFoundation && !undo && dist > 1) {
        const nx = -(lead.ty - lead.y) / dist; // x of the normal to the right of the direction of travel
        const inward = (lead.x + lead.tx) / 2 < (L.w - L.cardW) / 2 ? 1 : -1;
        side = (nx * inward >= 0 ? 1 : -1) * Math.min(L.cardW * 0.5, dist * 0.12) * Math.min(1, Math.abs(nx) * 3);
      }
      const spin = clamp((lead.tx - lead.x) / (L.cardW * 4), -1, 1) * (toFoundation ? 9 : 5);
      for (let i = 0; i < n; i++) {
        const s = sprites[transfers[i].card];
        const isLead = i === 0;
        place(s, 'fly', {
          duration: baseMs,
          delay: i * TUNE.runLag * tempo,
          arc: arc,
          side: side,
          spin: spin,
          peakLift: 0.9,
          liftSteps: auto ? 3 : 0,
          peakScale: toFoundation ? 0.16 : 0.09,
          trail: auto ? SUIT_GLOW[suitOf(s.id)] : null,
          onStart:
            isLead && !undo && !auto
              ? function (sp) {
                  sfx('slide', { pan: panOf(sp.x), volume: 0.5, duration: baseMs * 0.7 });
                }
              : null,
          onLand: undo
            ? isLead
              ? function (sp) {
                  sfx('place', { pan: panOf(sp.tx), volume: 0.6 });
                }
              : null
            : isLead
              ? function (sp) {
                  if (toFoundation) {
                    foundationArrive(sp, { quiet: auto });
                    if (delta && !auto) scorePop(sp.tx, sp.ty, delta);
                  } else {
                    sfx('place', { pan: panOf(sp.tx) });
                    haptic('thud');
                    bump(sp.pile, sp.index - 1);
                    if (delta) scorePop(sp.tx, sp.ty, delta);
                  }
                }
              : null,
        });
      }
    }

    // faces that changed on cards that did not travel: the uncovered tableau card
    for (let i = 0; i < flips.length; i++) {
      const f = flips[i];
      if (moved.has(f.card)) continue;
      const s = sprites[f.card];
      if (s.held) continue;
      const flipT = s.faceUp ? 0 : 180;
      if (s.hFlight) {
        place(s, 'fly', { flipMode: PROP });
        continue;
      }
      if (s.flip === flipT) continue;
      if (f.faceUp) {
        s.flipTo(0, {
          duration: TUNE.revealMs,
          delay: fromDrag ? 40 : TUNE.revealDelay,
          hop: L.cardH * TUNE.revealHop,
          onStart: function (sp) {
            sfx('flip', { pan: panOf(sp.tx) });
            haptic('tick');
          },
        });
      } else {
        // undo: the card turns back down, quickly, before the run lands on it again
        s.flipTo(180, { duration: 190 });
      }
    }
  }

  // ------------------------------------------------------------------ new game: gather, shuffle, deal
  function choreo(promise) {
    choreoBusy++;
    const done = function () {
      choreoBusy = Math.max(0, choreoBusy - 1);
    };
    promise.then(done, done);
    return promise;
  }

  /** Every card sweeps into one face-down deck in the middle of the table. */
  function gather() {
    if (!inited) return Promise.resolve();
    takeDrag();
    releaseSoft();
    clearHint();
    const gen = ++choreoGen;
    if (deckMode) {
      // already a deck (first launch): nothing to collect
      return Promise.resolve();
    }
    // Deck order = what is on the table read pile by pile; the faces all turn down so nobody can tell.
    const order = [];
    for (let p = PILE_IDS.length - 1; p >= 0; p--) {
      const arr = state ? state.piles[PILE_IDS[p]] : [];
      for (let i = 0; i < arr.length; i++) order.push(arr[i]);
    }
    if (order.length !== 52) {
      order.length = 0;
      for (let i = 0; i < 52; i++) order.push(i);
    }
    deckMode = true;
    state = null;
    inviteOn = false;
    refreshInvite();
    if (pileEls.stock) pileEls.stock.classList.remove('is-stacked', 'is-spent');
    for (let k = 0; k < 52; k++) sprites[order[k]].index = k;
    retarget();
    const gap = TUNE.gatherSpan / 52;
    const scale = L.deck.scale;
    sfx('whoosh', { duration: TUNE.gatherSpan + TUNE.gatherMs * 0.6 });
    const handles = [];
    for (let k = 0; k < 52; k++) {
      const s = sprites[order[k]];
      s.held = 'deck';
      s.dx = s.tx;
      s.dy = s.ty;
      s.dflip = 180;
      const dist = Math.hypot(s.tx - s.x, s.ty - s.y);
      handles.push(
        s.fly({
          x: s.tx,
          y: s.ty,
          flip: 180,
          flipMode: SPIN,
          flipFrom: 0.05,
          flipTo: 0.7,
          scale: scale,
          duration: TUNE.gatherMs,
          delay: k * gap,
          arc: Math.min(L.cardH * 0.5, dist * 0.18),
          spin: ((k % 5) - 2) * 4,
          peakLift: 0, // 52 cards at once: transform only (no shadow layers, no --lift restyles)
          peakScale: 0.04,
          overshoot: 0,
          z: TUNE.flyZ + k,
          onLand: function (sp) {
            sp.z = sp.tz;
            touch(sp);
          },
        }).finished
      );
    }
    return choreo(
      Promise.all(handles).then(function () {
        if (gen === choreoGen) haptic('thud');
      })
    );
  }

  /** One riffle: the deck splits into two leaning halves, the cards fall together alternately, the deck squares up. */
  function shuffle() {
    if (!inited || !deckMode) return Promise.resolve();
    const gen = choreoGen;
    const deck = [];
    for (let i = 0; i < 52; i++) if (sprites[i].held === 'deck') deck.push(sprites[i]);
    deck.sort(function (a, b) {
      return a.index - b.index;
    });
    if (deck.length < 2 || reduced()) {
      sfx('shuffle');
      return choreo(A().wait(reduced() ? 0 : 200));
    }
    const half = Math.ceil(deck.length / 2);
    const sc = L.deck.scale;
    const w = L.cardW * sc;
    const spread = Math.min(w * 0.66, Math.max(10, (L.w - w) / 2 - 6));
    const lean = 9;
    sfx('shuffle', { duration: 620 });

    // 1. split
    const split = [];
    for (let i = 0; i < deck.length; i++) {
      const s = deck[i];
      const right = i >= half;
      const k = right ? i - half : i;
      split.push(
        s.fly({
          x: s.tx + (right ? spread : -spread) + k * 0.12,
          y: s.ty - k * 0.35 * (L.cardW / 100),
          rot: right ? -lean : lean,
          scale: sc,
          duration: 190,
          delay: k * 1.5,
          peakLift: 0,
          peakScale: 0,
          overshoot: 0,
          z: s.tz,
        }).finished
      );
    }

    return choreo(
      Promise.all(split)
        .then(function () {
          if (gen !== choreoGen) return null;
          // 2. riffle: one card from each half in turn drops into the middle
          const order = [];
          for (let k = 0; k < half; k++) {
            order.push(deck[k]);
            if (half + k < deck.length) order.push(deck[half + k]);
          }
          const all = [];
          for (let j = 0; j < order.length; j++) {
            const s = order[j];
            s.index = j; // the new deck order
          }
          retarget();
          for (let j = 0; j < order.length; j++) {
            const s = order[j];
            s.dx = s.tx;
            s.dy = s.ty;
            all.push(
              s.fly({
                x: s.tx,
                y: s.ty,
                rot: 0,
                scale: sc,
                duration: 150,
                delay: j * 6.5,
                arc: L.cardH * 0.1,
                peakLift: 0,
                peakScale: 0.03,
                overshoot: 0,
                z: TUNE.flyZ + j,
                onLand: function (sp) {
                  sp.z = sp.tz;
                  touch(sp);
                },
              }).finished
            );
          }
          haptic('tick');
          return Promise.all(all);
        })
        .then(function () {
          if (gen !== choreoGen) return null;
          // 3. square up: the whole deck gets one firm tap
          haptic('thud');
          const taps = [];
          for (let i = 0; i < deck.length; i++) {
            const s = deck[i];
            if (s.held !== 'deck') continue;
            s.scale = sc * 1.045;
            touch(s);
            taps.push(s.poseTo({ scale: sc, rot: 0 }, { duration: 150, ease: 'outBack' }).finished);
          }
          return Promise.all(taps);
        })
    );
  }

  /** Deals a fresh state from the deck. Resolves when every card is home. */
  function deal(next) {
    if (!inited || !next) return Promise.resolve();
    if (!deckMode) {
      render(next);
      return Promise.resolve();
    }
    const gen = ++choreoGen;
    deckMode = false;
    setState(next);
    retarget();

    // deal order: row by row, exactly as the engine dealt
    const order = [];
    for (let row = 0; row < 7; row++) {
      for (let c = row; c < 7; c++) order.push(state.piles[TABLEAU[c]][row]);
    }
    // In the deck the stock is at the bottom and the first card to be dealt on top.
    const stock = state.piles.stock;
    for (let i = 0; i < stock.length; i++) {
      const s = sprites[stock[i]];
      s.z = i;
      touch(s);
    }
    for (let k = 0; k < order.length; k++) {
      const s = sprites[order[k]];
      s.z = 60 + (order.length - k);
      touch(s);
    }
    // Only the top of the deck is ever seen: the cards inside it are not rendered until their turn comes
    // (far fewer live layers while the deal — the busiest animation of the game — runs).
    const ahead = TUNE.dealAhead;
    for (let k = ahead; k < order.length; k++) sprites[order[k]].cover(true);
    for (let i = 0; i < stock.length - TUNE.keepStock; i++) sprites[stock[i]].cover(true);

    const speed = SOL.Anim.speed || 1;
    const dealt = A().stagger(order, TUNE.dealGap, function (id, k) {
      if (gen !== choreoGen) return null;
      if (k + ahead < order.length) sprites[order[k + ahead]].cover(false);
      const s = sprites[id];
      if (s.held !== 'deck') return null;
      s.held = null;
      const top = s.faceUp;
      const dist = Math.hypot(s.tx - s.x, s.ty - s.y);
      return s.fly({
        duration: TUNE.dealMs,
        arc: Math.min(L.cardH * 0.55, dist * 0.2),
        side: (s.tx < s.x ? -1 : 1) * Math.min(L.cardW * 0.4, dist * 0.08),
        spin: (s.tx < s.x ? -1 : 1) * (10 + (k % 4) * 3),
        peakLift: 0.9,
        liftSteps: 3, // ten cards in the air at once: a handful of shadow steps each, not one per frame
        peakScale: 0.05,
        flipMode: PROP,
        flipFrom: 0.42,
        flipTo: 0.96,
        onStart: function (sp) {
          sfx('deal', { pan: panOf(sp.tx), pitch: 0.94 + (k % 7) * 0.02 });
        },
        onLand: top
          ? function (sp) {
              haptic('tick');
              sfx('flip', { pan: panOf(sp.tx), volume: 0.5 });
            }
          : null,
      }).finished;
    });

    // The rest of the deck slides to the stock slot once the last card is on its way.
    const lastLaunch = (order.length - 1) * TUNE.dealGap;
    const stockHome = [];
    for (let i = 0; i < stock.length; i++) {
      const s = sprites[stock[i]];
      if (s.held !== 'deck') continue;
      s.held = null;
      const dist = Math.hypot(s.tx - s.x, s.ty - s.y);
      stockHome.push(
        s.fly({
          duration: 420,
          delay: lastLaunch + 60 + i * 9,
          lazy: true, // the covered ones stay unrendered until they take off
          arc: Math.min(L.cardH * 0.4, dist * 0.12),
          spin: 0,
          peakLift: 0,
          peakScale: 0,
          overshoot: L.cardW * 0.05,
          z: TUNE.flyZ + 1400 + i,
          onStart:
            i === 0
              ? function () {
                  sfx('slide', { duration: 380 / speed, pan: panOf(L.piles.stock.x) });
                }
              : null,
          onLand:
            i === stock.length - 1
              ? function () {
                  if (gen !== choreoGen) return;
                  sfx('place', { pan: panOf(L.piles.stock.x) });
                  haptic('thud');
                  pulse('stock', GOLD);
                }
              : null,
        }).finished
      );
    }
    return choreo(
      Promise.all([dealt, Promise.all(stockHome)]).then(function () {
        if (gen !== choreoGen) return;
        // anything a resize or an interruption left behind
        for (let i = 0; i < 52; i++) if (sprites[i].held === 'deck') sprites[i].held = null;
        sync('glide');
      })
    );
  }

  // ------------------------------------------------------------------ hit testing (model based, no DOM reads)
  /**
   * The topmost card drawn at a point. Cards in mid-flight are not there to be touched: when the player taps
   * the stock or the waste again while the previous card is still leaving, the tap is meant for the pile, not
   * for the card passing over it. (Gliding cards — springs — are hit where they are drawn.)
   */
  function cardAt(cx, cy, slop) {
    if (!L) return -1;
    const x = cx - L.left;
    const y = cy - L.top;
    const pad = slop || 0;
    let best = -1;
    let bestZ = -1;
    for (let i = 0; i < 52; i++) {
      const s = sprites[i];
      if (s.hFlight) continue;
      const sx = s.x + s.ox;
      const sy = s.y + s.oy;
      if (x < sx - pad || x > sx + L.cardW + pad || y < sy - pad || y > sy + L.cardH + pad) continue;
      if (s.z > bestZ) {
        bestZ = s.z;
        best = i;
      }
    }
    return best;
  }

  /** The drop / tap area of a pile, table space. Tableau columns reach down to the bottom of the table. */
  function pileZone(id) {
    const p = L.piles[id];
    const hx = L.gap / 2;
    const hy = L.rowGap / 2;
    if (id.charAt(0) === 't') {
      return { x0: p.x - hx, y0: p.y - hy, x1: p.x + L.cardW + hx, y1: L.h };
    }
    if (id === 'waste') {
      const n = L.draw3 ? 2 : 0;
      return { x0: p.x - hx, y0: p.y - hy, x1: p.x + L.cardW + n * L.wasteFanX + hx, y1: p.y + L.cardH + n * L.wasteFanY + hy };
    }
    return { x0: p.x - hx, y0: p.y - hy, x1: p.x + L.cardW + hx, y1: p.y + L.cardH + hy };
  }

  function pileAt(cx, cy, slop) {
    if (!L) return null;
    const x = cx - L.left;
    const y = cy - L.top;
    const pad = slop || 0;
    for (let i = 0; i < PILE_IDS.length; i++) {
      const z = pileZone(PILE_IDS[i]);
      if (x >= z.x0 - pad && x <= z.x1 + pad && y >= z.y0 - pad && y <= z.y1 + pad) return PILE_IDS[i];
    }
    return null;
  }

  function pileRect(id) {
    if (!L || !L.piles[id] || !tableEl) return null;
    // Public and rare: re-read the table origin so the answer is right even if the page shifted the table.
    const box = tableEl.getBoundingClientRect();
    const p = L.piles[id];
    const x = box.left + p.x;
    const y = box.top + p.y;
    return { x: x, y: y, left: x, top: y, right: x + L.cardW, bottom: y + L.cardH, width: L.cardW, height: L.cardH };
  }

  // ------------------------------------------------------------------ press + drag
  /** Finger down on a card that can move: the faintest lift, so the touch registers before anything happens. */
  function press(cardId) {
    unpress();
    const s = sprites[cardId];
    if (!s || s.held || s.hFlight || reduced() || deckMode) return;
    pressed = s;
    // a (soft) hold: a free sprite would be relaxed back to rest as soon as the little lift ended
    s.held = 'press';
    s.soft = true;
    s.poseTo({ lift: 0.3, scale: 1.025 }, { duration: 110 });
  }

  function unpress() {
    const s = pressed;
    pressed = null;
    if (!s || s.held !== 'press') return;
    s.held = null;
    s.soft = false;
    if (s.lift !== 0 || s.scale !== 1 || s.hPose) s.poseTo({ lift: 0, scale: 1 }, { duration: 140 });
    else s._settled();
  }

  /**
   * Ends every soft hold (press, a hover tilt, …): the game needs its cards. Called before anything that
   * moves cards. The sprites relax back to rest unless the caller animates them right away.
   */
  function releaseSoft() {
    pressed = null;
    for (let i = 0; i < 52; i++) {
      const s = sprites[i];
      if (!s.held || !s.soft) continue;
      s.held = null;
      s.soft = false;
      s._settled();
    }
  }

  function markTargets(d, on) {
    for (let i = 0; i < d.legal.length; i++) {
      const pileId = d.legal[i];
      const arr = state ? state.piles[pileId] : null;
      if (!arr) continue;
      if (arr.length > 0) {
        const el = sprites[arr[arr.length - 1]].el;
        el.classList.toggle('is-target', on);
        if (!on) el.classList.remove('is-drop');
      } else if (pileEls[pileId]) {
        pileEls[pileId].classList.toggle('is-target', on);
        if (!on) pileEls[pileId].classList.remove('is-drop');
      }
    }
  }

  function targetEl(pileId) {
    if (!state || !pileId) return null;
    const arr = state.piles[pileId];
    if (!arr) return null;
    return arr.length > 0 ? sprites[arr[arr.length - 1]].el : pileEls[pileId];
  }

  function setHover(d, pileId) {
    if (d.hover === pileId) return;
    const prev = targetEl(d.hover);
    if (prev) prev.classList.remove('is-drop');
    d.hover = pileId;
    const el = targetEl(pileId);
    if (el) {
      el.classList.add('is-drop');
      haptic('tick');
    }
  }

  function dragStart(cardId, cx, cy) {
    if (!inited || !state || deckMode || drag || !L) return 0;
    const run = E().getRun(state, cardId);
    if (!run || run.length === 0) return 0;
    releaseSoft();
    const spr = [];
    for (let i = 0; i < run.length; i++) {
      const s = sprites[run[i]];
      if (s.held) return 0;
      spr.push(s);
    }
    clearHint();
    const lead = spr[0];
    const px = cx - L.left;
    const py = cy - L.top;
    for (let i = 0; i < spr.length; i++) {
      const s = spr[i];
      s.stop();
      s._fold();
      s.held = 'drag';
      s.z = TUNE.dragZ + i;
      s.el.classList.add('is-dragging');
      s.poseTo({ lift: 1, scale: TUNE.dragScale }, { duration: 150, ease: 'outBack' });
      touch(s);
    }
    drag = {
      card: cardId,
      sprites: spr,
      from: lead.pile,
      gx: px - lead.x,
      gy: py - lead.y,
      px: px,
      py: py,
      vx: 0,
      vy: 0,
      rot: 0,
      rotV: 0,
      ry: 0,
      ryV: 0,
      rx: 0,
      rxV: 0,
      // the run keeps the spacing it had in its column (a compressed column does not spring apart in the hand)
      fan: spr.length > 1 ? clamp(spr[1].ty - spr[0].ty, 2, L.upFan) : L.upFan,
      legal: E().legalTargets(state, cardId),
      hover: null,
      released: false,
    };
    markTargets(drag, true);
    sfx('pick', { pan: panOf(lead.x) });
    haptic('tick');
    wake();
    return spr.length;
  }

  function dragMove(cx, cy) {
    if (!drag || drag.released || !L) return;
    drag.px = cx - L.left;
    drag.py = cy - L.top;
    wake();
  }

  /** One frame of drag physics: the lead card follows the pointer, the run trails, everything tilts. */
  function dragFrame(dt) {
    const d = drag;
    const h = Math.min(dt, 40) / 1000;
    const lead = d.sprites[0];
    // keep the grabbed card on the table (and reachable): its centre never leaves the table box
    const nx = clamp(d.px - d.gx, -L.cardW * 0.5, L.w - L.cardW * 0.5);
    const ny = clamp(d.py - d.gy, -L.cardH * 0.5, L.h - L.cardH * 0.5);
    const still = reduced();

    if (h > 0) {
      const ivx = (nx - lead.x) / h;
      const ivy = (ny - lead.y) / h;
      const k = Math.min(1, h * 16);
      d.vx += (ivx - d.vx) * k;
      d.vy += (ivy - d.vy) * k;
    }
    lead.x = nx;
    lead.y = ny;

    if (!still && h > 0) {
      // tilt: a damped spring chasing a target set by the velocity (air resistance, then a little wobble)
      const K = 150;
      const C = 13;
      const tz = clamp(d.vx * TUNE.tiltZ, -11, 11);
      const tyaw = clamp(d.vx * TUNE.tiltY, -20, 20);
      const tpitch = clamp(-d.vy * TUNE.tiltX, -16, 16);
      d.rotV += ((tz - d.rot) * K - d.rotV * C) * h;
      d.rot += d.rotV * h;
      d.ryV += ((tyaw - d.ry) * K - d.ryV * C) * h;
      d.ry += d.ryV * h;
      d.rxV += ((tpitch - d.rx) * K - d.rxV * C) * h;
      d.rx += d.rxV * h;
      lead.rot = d.rot;
      lead.ry = d.ry;
      lead.rx = d.rx;
    } else if (still) {
      lead.rot = 0;
      lead.rx = 0;
      lead.ry = 0;
    }
    touch(lead);

    // the rest of the run: each card chases the one below it
    const fan = d.fan;
    const a = still ? 1 : 1 - Math.exp(-h / TUNE.dragLag);
    const b = still ? 1 : 1 - Math.exp(-h / (TUNE.dragLag * 1.4));
    // …but the run stays a run: however fast the hand moves, neighbours never stretch far apart
    const maxX = L.cardW * TUNE.dragStretchX;
    const maxY = L.cardH * TUNE.dragStretchY;
    for (let i = 1; i < d.sprites.length; i++) {
      const s = d.sprites[i];
      const prev = d.sprites[i - 1];
      s.x = clamp(s.x + (prev.x - s.x) * a, prev.x - maxX, prev.x + maxX);
      s.y = clamp(s.y + (prev.y + fan - s.y) * a, prev.y + fan - maxY, prev.y + fan + maxY);
      s.rot += (prev.rot - s.rot) * b;
      s.rx += (prev.rx - s.rx) * b;
      s.ry += (prev.ry - s.ry) * b;
      touch(s);
    }

    const c = dropCandidate(d);
    setHover(d, c.target);
  }

  function overlap(ax0, ay0, ax1, ay1, z) {
    const w = Math.min(ax1, z.x1) - Math.max(ax0, z.x0);
    const h = Math.min(ay1, z.y1) - Math.max(ay0, z.y0);
    return w > 0 && h > 0 ? w * h : 0;
  }

  /**
   * Where the held run would go: `target` = the legal pile the lead card overlaps most (any foundation counts
   * for the card's own foundation); `over` = the pile it overlaps most, legal or not.
   */
  function dropCandidate(d) {
    const lead = d.sprites[0];
    const x0 = lead.x;
    const y0 = lead.y;
    const x1 = x0 + L.cardW;
    const y1 = y0 + L.cardH;
    const area = L.cardW * L.cardH;
    let target = null;
    let targetA = 0;
    let over = null;
    let overA = 0;
    const own = E().foundationFor(d.card);
    const ownLegal = d.legal.indexOf(own) !== -1;
    let fA = 0;
    for (let i = 1; i < PILE_IDS.length; i++) {
      const id = PILE_IDS[i];
      const a = overlap(x0, y0, x1, y1, pileZone(id));
      if (a <= 0) continue;
      if (a > overA) {
        overA = a;
        over = id;
      }
      if (id.charAt(0) === 'f') {
        fA += a;
        continue;
      }
      if (id !== d.from && d.legal.indexOf(id) !== -1 && a > targetA) {
        targetA = a;
        target = id;
      }
    }
    if (ownLegal && own !== d.from && fA > targetA) {
      targetA = fA;
      target = own;
    }
    if (targetA < area * 0.18) target = null;
    if (overA < area * 0.3) over = null;
    return { target: target, over: over };
  }

  function dragEnd() {
    if (!drag || drag.released) return null;
    const d = drag;
    const c = dropCandidate(d);
    d.released = true;
    markTargets(d, false);
    setHover(d, null);
    return { card: d.card, from: d.from, target: c.target, over: c.over };
  }

  /** Ends the drag state and hands back what was in the hand (sprites stay where they are, free again). */
  function takeDrag() {
    const d = drag;
    if (!d) return null;
    drag = null;
    if (!d.released) {
      markTargets(d, false);
      const el = targetEl(d.hover);
      if (el) el.classList.remove('is-drop');
    }
    for (let i = 0; i < d.sprites.length; i++) releaseSprite(d.sprites[i]);
    return { sprites: d.sprites, vx: clamp(d.vx, -2400, 2400), vy: clamp(d.vy, -2400, 2400), from: d.from };
  }

  function dragCancel(o) {
    const d = takeDrag();
    if (!d) return;
    const invalid = !!(o && o.invalid);
    for (let i = 0; i < d.sprites.length; i++) {
      const s = d.sprites[i];
      if (invalid && !reduced()) {
        // flies home along a curve and shakes its head
        const dist = Math.hypot(s.tx - s.x, s.ty - s.y);
        place(s, 'fly', {
          duration: clamp(240 + dist * 0.35, 260, 460),
          delay: i * 18,
          side: (s.tx < s.x ? 1 : -1) * Math.min(L.cardW * 0.7, dist * 0.16),
          peakLift: 0.2,
          peakScale: 0,
          overshoot: 0,
          z: TUNE.dragZ + i,
          onLand: function (sp) {
            shakeSprite(sp, 0, 1);
          },
        });
      } else {
        s.z = TUNE.dragZ + i;
        s.dx = s.tx;
        s.dy = s.ty;
        s.springTo(s.tx, s.ty, {
          stiffness: Math.max(170, TUNE.dropStiffness - 40 - i * 24),
          damping: TUNE.dropDamping + 2,
          velocity: { x: d.vx, y: d.vy },
        });
        s.poseTo({ rot: 0, rx: 0, ry: 0, scale: 1, lift: 0 }, { duration: 240 });
        touch(s);
      }
    }
    if (invalid) {
      sfx('invalid');
      haptic('error');
    } else {
      sfx('place', { volume: 0.5 });
    }
  }

  // ------------------------------------------------------------------ hint, shake, cues
  function clearHint() {
    const h = hintState;
    if (!h) return;
    hintState = null;
    if (h.timer) root.clearTimeout(h.timer);
    for (let i = 0; i < h.els.length; i++) h.els[i].classList.remove('is-hint', 'is-target');
    if (h.tween) h.tween.cancel();
    if (h.ghost && h.ghost.parentNode) h.ghost.parentNode.removeChild(h.ghost);
  }

  /**
   * Shows a hint: the card (or the stock, for a draw) pulses, the target lights up, and a translucent ghost of
   * the card glides to the target and back. Seam for the animation director: everything is in this function.
   */
  function hint(action) {
    if (!inited || !state || deckMode || !action || !L) return false;
    clearHint();
    const h = { els: [], timer: 0, tween: null, ghost: null };
    if (action.type === 'draw') {
      const stock = state.piles.stock;
      const el = stock.length > 0 ? sprites[stock[stock.length - 1]].el : pileEls.stock;
      el.classList.add('is-hint');
      h.els.push(el);
    } else if (action.type === 'move') {
      const s = sprites[action.card];
      if (!s) return false;
      s.el.classList.add('is-hint');
      h.els.push(s.el);
      const tEl = targetEl(action.to);
      if (tEl) {
        tEl.classList.add(tEl.classList.contains('card') ? 'is-target' : 'is-hint');
        h.els.push(tEl);
      }
      if (!reduced() && overlayEl) {
        // where the card would land
        const arr = state.piles[action.to];
        const origin = L.piles[action.to];
        let gx = origin.x;
        let gy = origin.y;
        if (action.to.charAt(0) === 't' && arr.length > 0) {
          const topS = sprites[arr[arr.length - 1]];
          gx = topS.tx;
          gy = topS.ty + (topS.faceUp ? L.upFan : L.downFan);
        }
        const ghost = SOL.Cards.create(action.card, { back: s.el.getAttribute('data-back') });
        ghost.classList.add('board-ghost');
        ghost.removeAttribute('role');
        ghost.setAttribute('aria-hidden', 'true');
        const x0 = s.tx;
        const y0 = s.ty;
        ghost.style.transform = 'translate3d(' + x0 + 'px,' + y0 + 'px,0)';
        overlayEl.appendChild(ghost);
        h.ghost = ghost;
        const lift = Math.min(L.cardH * 0.5, Math.hypot(gx - x0, gy - y0) * 0.2);
        h.tween = A().tween({
          duration: 1500,
          ease: 'linear',
          update: function (t) {
            // out (0..0.45), rest, back (0.6..1)
            const p = t < 0.45 ? inOutSine(t / 0.45) : t < 0.6 ? 1 : 1 - inOutSine((t - 0.6) / 0.4);
            const bow = 4 * p * (1 - p);
            ghost.style.transform =
              'translate3d(' + r2(x0 + (gx - x0) * p) + 'px,' + r2(y0 + (gy - y0) * p - lift * bow) + 'px,0)';
            ghost.style.opacity = String(r2(0.55 * Math.min(1, t * 8, (1 - t) * 6)));
          },
          done: function () {
            if (ghost.parentNode) ghost.parentNode.removeChild(ghost);
            if (hintState === h) {
              h.ghost = null;
              h.tween = null;
            }
          },
        });
      }
    } else {
      return false;
    }
    hintState = h;
    // UI state with a lifetime, not animation sequencing (it must also last under reduced motion).
    h.timer = root.setTimeout(function () {
      if (hintState === h) clearHint();
    }, TUNE.hintMs);
    sfx('hint');
    haptic('tap');
    return true;
  }

  function shake(cardId) {
    if (!inited || !state || deckMode) return;
    const s = sprites[cardId];
    if (!s || s.held) return;
    const arr = state.piles[s.pile] || [];
    if (s.pile.charAt(0) === 't' && s.faceUp) {
      for (let i = s.index; i < arr.length; i++) shakeSprite(sprites[arr[i]], (i - s.index) * 16, 0.7);
    } else {
      shakeSprite(s, 0, 0.7);
    }
  }

  function nudgeStock() {
    if (!inited || !state || deckMode) return;
    const ids = [];
    const st = state.piles.stock;
    const wa = state.piles.waste;
    if (st.length) ids.push(st[st.length - 1]);
    if (wa.length) ids.push(wa[wa.length - 1]);
    for (let i = 0; i < ids.length; i++) shakeSprite(sprites[ids[i]], i * 40, 0.6);
    pulse('stock', MINUS);
  }

  /**
   * "Tap me": a soft pulse on the stock — on its top card, or on the recycle symbol when it is empty.
   * CSS only (no sprite values change), so it never disturbs the layout model or the testing hooks.
   */
  function refreshInvite() {
    let el = null;
    if (inviteOn && state && !deckMode) {
      const st = state.piles.stock;
      if (st.length > 0) el = sprites[st[st.length - 1]].el;
    }
    if (el !== inviteEl) {
      if (inviteEl) inviteEl.classList.remove('is-inviting');
      if (el) el.classList.add('is-inviting');
      inviteEl = el;
    }
    if (pileEls.stock) pileEls.stock.classList.toggle('is-inviting', inviteOn && !deckMode);
  }

  function setStockInvite(on) {
    inviteOn = !!on;
    refreshInvite();
  }

  // ------------------------------------------------------------------ holds (celebration / director)
  function hold(ids, tag, o) {
    const out = [];
    if (!inited) return out;
    const list = ids || sprites.map((s) => s.id);
    const soft = !!(o && o.soft);
    for (let i = 0; i < list.length; i++) {
      const s = sprites[list[i]];
      if (!s) continue;
      s.held = tag || 'show';
      s.soft = soft;
      s.cover(false);
      out.push(s);
    }
    return out;
  }

  function release(tag, o) {
    if (!inited) return Promise.resolve();
    o = o || EMPTY;
    const t = tag || 'show';
    const how = o.how || 'fly';
    const stagger = o.stagger || 0;
    const list = [];
    for (let i = 0; i < 52; i++) if (sprites[i].held === t) list.push(sprites[i]);
    // home in stacking order, so piles rebuild from the bottom
    list.sort(function (a, b) {
      return a.tz - b.tz || a.id - b.id;
    });
    const all = [];
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      s.held = null;
      s.soft = false;
      if (deckMode || !state) continue;
      const opts = Object.assign({ delay: i * stagger }, o);
      delete opts.how;
      delete opts.stagger;
      const h = place(s, how, opts);
      if (h && h.finished) all.push(h.finished);
    }
    return Promise.all(all);
  }

  // ------------------------------------------------------------------ settings hooks
  function setBack(backId) {
    if (!inited) return;
    for (let i = 0; i < 52; i++) SOL.Cards.setBack(sprites[i].el, backId);
  }

  function setLeftHanded(on) {
    on = !!on;
    if (on === leftHanded) return;
    leftHanded = on;
    relayout();
  }

  // ------------------------------------------------------------------ testing hooks
  function snapshot() {
    const out = [];
    for (let i = 0; i < 52; i++) {
      const s = sprites[i];
      if (!s) continue;
      out.push({
        id: i,
        pile: s.pile,
        index: s.index,
        x: r2(s.x + s.ox),
        y: r2(s.y + s.oy),
        z: s.z,
        faceUp: s.flip < 90,
        target: { x: s.tx, y: s.ty, z: s.tz, faceUp: s.faceUp },
        flip: s.flip,
        lift: s.lift,
        scale: s.scale,
        rot: s.rot,
        rx: s.rx,
        ry: s.ry,
        moving: s.busy(),
        held: s.held,
        covered: s.covered,
      });
    }
    return out;
  }

  function busyCount() {
    let n = 0;
    for (let i = 0; i < sprites.length; i++) if (sprites[i].busy()) n++;
    return n;
  }

  function isSettled() {
    if (!inited) return false;
    if (drag || choreoBusy > 0 || deckMode) return false;
    for (let i = 0; i < 52; i++) {
      const s = sprites[i];
      if (s.held || s.busy()) return false;
      if (s.x !== s.tx || s.y !== s.ty || s.ox !== 0 || s.oy !== 0 || s.z !== s.tz) return false;
      if (s.flip !== (s.faceUp ? 0 : 180)) return false;
      if (s.rot !== 0 || s.rx !== 0 || s.ry !== 0 || s.scale !== 1 || s.lift !== 0) return false;
    }
    return dirty.length === 0;
  }

  // ------------------------------------------------------------------ export
  SOL.Board = {
    init: init,
    get ready() {
      return inited;
    },
    cardEl: function (id) {
      return sprites[id] ? sprites[id].el : null;
    },
    pileEl: function (id) {
      return pileEls[id] || null;
    },
    pileRect: pileRect,

    render: render,
    restore: restore,
    apply: apply,
    gather: gather,
    shuffle: shuffle,
    deal: deal,
    relayout: relayout,
    setBack: setBack,
    setLeftHanded: setLeftHanded,

    hint: hint,
    clearHint: clearHint,
    shake: shake,
    nudgeStock: nudgeStock,
    setStockInvite: setStockInvite,

    cardAt: cardAt,
    pileAt: pileAt,
    press: press,
    unpress: unpress,
    dragStart: dragStart,
    dragMove: dragMove,
    dragEnd: dragEnd,
    dragCancel: dragCancel,
    isDragging: function () {
      return !!drag;
    },

    snapshot: snapshot,
    isSettled: isSettled,

    sprites: sprites,
    sprite: function (id) {
      return sprites[id] || null;
    },
    layout: layoutInfo,
    toClient: toClient,
    hold: hold,
    release: release,
    sync: function (how, o) {
      if (!inited || deckMode) return;
      retarget();
      sync(how, o);
    },
    touch: touch,
    flush: flush,
    pulse: pulse,
    scorePop: scorePop,
    foundationArrive: foundationArrive,
    busyCount: busyCount,
    isDeckMode: function () {
      return deckMode;
    },
    TUNE: TUNE,
    PILE_IDS: PILE_IDS.slice(),
  };
})(typeof window !== 'undefined' ? window : globalThis);
