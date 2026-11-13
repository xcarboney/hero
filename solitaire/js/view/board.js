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
 *   Board.gather() -> Promise        the old game is swept up: one pass round the table, every card curling into
 *                                    one face-down deck, centre stage (enters deck mode)
 *   Board.shuffle() -> Promise       one riffle shuffle: cut into two bowed halves, riffle, square up (call it
 *                                    again while waiting for a seed)
 *   Board.deal(state) -> Promise     deals `state` (a fresh deal) from the deck with a dealer's flick — a turn in
 *                                    the plane of the table, overshoot, settle; column tops turn over as they
 *                                    land. Resolves when the last card landed (its face may still be turning).
 *                                    gather + shuffle + deal take about 2.5 s at speed 1.
 *   Board.relayout()                 re-measure #table and glide everything to its new place (also automatic:
 *                                    ResizeObserver, window resize, 'app:insets', handedness)
 *   Board.setBack(backId)            SOL.Cards.setBack on all 52
 *   Board.setLeftHanded(bool)        mirrors the top row (stock under the left thumb)
 *
 *   -- feedback --
 *   Board.hint(action) -> boolean    move: the card and its run lift, a translucent ghost of them glides along an
 *                                    arc to the target and dissolves — twice — while the target glows; draw: the
 *                                    stock's top card beckons and its slot rings twice. Returns at once and never
 *                                    blocks input (the next action clears it). Reduced motion: gold rings only.
 *   Board.clearHint()
 *   Board.shake(cardId)              "no": a quick shake of the card (and the run above it)
 *   Board.nudgeStock()               "nothing to suggest": stock and waste shake their heads, the whole table
 *                                    shudders once (CSS), the stock slot shows a red outline for a moment
 *   Board.setStockInvite(bool)       the stock asks for a tap: its top card breathes (CSS only)
 *   Board.hoverAt(clientX, clientY) -> boolean      idle life for fine pointers: the top face-up card under the
 *                                    pointer leans towards it with a moving glare (a soft hold). SOL.Input calls
 *                                    it on mouse / pen moves; Board.hoverEnd() or (-1, -1) ends it.
 *   Board.hoverEnd()
 *   Board.suitComplete(sprite)       the flourish of a finished foundation (shimmer, ring, stars, the King nods);
 *                                    Board.foundationArrive calls it for a King
 *   Board.setLite(bool) / Board.isLite()            lite mode (see SOL.Game): transform-only choreography, no
 *                                    trails, fewer particles
 *
 *   -- dragging (called by SOL.Input; client coordinates) --
 *   Board.cardAt(clientX, clientY, slop = 0) -> cardId | -1        the card a touch at this point means: the
 *                                    topmost card drawn there; with `slop`, when no card is hit exactly, the
 *                                    NEAREST card within `slop` px (a card lying face-down in a column is
 *                                    never taken by a near miss, only by an exact hit). A card in flight is hit
 *                                    at its landing place (it counts as lying there already) and where it is
 *                                    drawn — but there it gives way to the stock and to a face-up card of another
 *                                    pile under it. A card flying to the stock is hit at the stock only.
 *   Board.pileAt(clientX, clientY, slop = 0) -> pileId | null      which pile's area the point is in. In both,
 *                                    the stock's `slop` does not reach onto the waste slot: a point on that
 *                                    slot — empty or not — never means the stock.
 *   Board.press(cardId) / Board.unpress()                           finger down: the card (and the run on it) is
 *                                    pushed into the felt a little; a drag lifts it out of the dip, a release
 *                                    lets it spring back
 *   Board.dragStart(cardId, clientX, clientY) -> number             cards picked up (0 = cannot be picked up).
 *                                    The point is where the pointer went DOWN: the card is held by that spot
 *                                    of its face. Wherever the card is by now (the pointer has moved on before
 *                                    the drag was recognised, or the card was caught in flight) it slides under
 *                                    the finger within a few frames (TUNE.dragCatch) and then follows rigidly.
 *   Board.dragMove(clientX, clientY)                                the pointer is here now
 *   Board.dragEnd() -> { card, from, target, over } | null          stops following the pointer; the run stays
 *                                    in the air until Board.apply(…, { source: 'drag' }) or Board.dragCancel().
 *                                    Judged where the finger holds the card at the last dragMove position (not
 *                                    where the last frame drew it):
 *                                    target: the legal pile with the largest overlap (or null — also while
 *                                    most of the card is still over its own pile, TUNE.dropLeave);
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
 *   Board.scorePop(x, y, delta, openY?)   "+10" for the card whose top-left corner is the table-space point
 *                                    (x, y): gold on a dark pill, rising from the card's top edge — near the
 *                                    top of the table (the top row; in the side arrangement also the first
 *                                    cards of a column), where that would run under the HUD, it plays on the
 *                                    lower half of the card instead, clear of its rank and suit. `openY`: the
 *                                    y of the last card of a run that came with it (the label then plays on
 *                                    that card, the one in view). Canvas, or a DOM label when FX is off.
 *   Board.foundationArrive(sprite, { quiet })   the whole arrival effect (ring, particles, pitch, haptic)
 *   Board.TUNE                       every timing / distance constant (mutable: tune them live)
 *   Board.busyCount() -> number      sprites with a running animation
 *   Board.flyingCount() -> number    sprites that are travelling (flights and position springs only)
 *   Board.release(tag, { how: 'instant' })          puts the held cards exactly on their places, no animation
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
 *       { x, y, duration, delay, ease (function; default outCubic), arc (px the path bows towards the top of the
 *         screen), side (px sideways), spin (deg, peaks mid-flight), turns (whole in-plane turns — the card
 *         lands looking the same; turnsBy: finished by this fraction of the flight), peakLift, peakScale (added
 *         mid-flight), rot / rx / ry / scale / lift (END pose, default 0 / 0 / 0 / 1 / 0), flip (END flip 0 | 180;
 *         a flight that does not change the face leaves --flip to a running flipTo), flipFrom / flipTo (0..1
 *         window of the flight),
 *         flipMode ('prop' | 'spin'; default 'prop', in lite mode 'spin'), overshoot (px), z, trail (colour),
 *         liftSteps (coarser --lift steps for
 *         crowded choreography; default TUNE.liftSteps), lazy (a covered card stays covered
 *         until its delay is over), onStart(s), onFrame(s, t), onLand(s) }
 *   sprite.springTo(x, y, { stiffness, damping, velocity: { x, y } }) -> handle     position only; retargets a
 *                                    running spring instead of restarting it
 *   sprite.poseTo({ rot, rx, ry, scale, lift }, { duration, delay, ease }) -> handle
 *   sprite.flipTo(deg, { duration, delay, mode, hop }) -> handle        hop: px the card jumps while it turns;
 *                                    mode: 'prop' | 'spin' (default as flipMode above)
 *   sprite.wobble(fn(t, sprite), { duration, delay }) -> handle         drives ox / oy (they end at 0)
 *   sprite.act(fn(t, sprite), { duration, delay }) -> handle            a performance in place: fn writes rot /
 *                                    rx / ry / scale / lift and brings them back to rest by t = 1
 *   sprite.cover(bool)               takes a card out of rendering (content-visibility) / puts it back. Every
 *                                    motion method uncovers; the board covers cards resting deep in the stock,
 *                                    the waste and the foundations (TUNE.keep*), so only ~30 cards are live
 *   sprite.stop()                    cancels every handle, values stay where they are
 *   sprite.busy() -> boolean
 * State classes the board keeps on its cards (board.css uses them to drop unused layers): .is-lifted while
 * lift > 0 or the card turns (the lift shadow is rendered only then), .is-turning while --flip is between 0 and
 * 180 (the flip shading), and .is-glare while a card carries a glare (the hover tilt sets it; add it yourself
 * before you animate --glare-o / --glare-x / --glare-y on a card, remove it afterwards). One more, for the
 * card art: .is-fanned on every waste card under the top one while the draw-3 waste fans sideways — such a
 * card shows only its left edge, and cards.css gives the phone art a small suit under the rank there (not
 * on the card that lies open while the player holds the top card in a drag: it shows the normal art). And
 * .is-tight on every covered face-up card of a tableau column whose fan step is squeezed below
 * TUNE.tightBelow (0.25 of the card height; classic art only — long columns on wide, short tables): the suit
 * under the rank of its corner index is cut off there, and cards.css shows the suit once more top-right.
 * FLAT CARDS (board.css): a table card that is neither .is-turning nor .is-glare is flattened into ONE
 * compositor layer — its inner 3D boxes are switched off and only the visible face is rendered. So when you
 * rotate a sprite yourself (rx / ry), never go past edge-on (|ry| > 90) with flip left at 0: set flip to 180
 * and ry to the remainder instead (the back is swapped in — see face() in celebrate.js). rot, rx and small ry
 * need no care.
 * Flip modes: 'prop' animates --flip (lighting + shadow react; ~0.16 ms per card per frame, and the card is a
 * full 3D scene while it turns) — single, unhurried turns: the tableau reveal, the column tops of a deal.
 * 'spin' rotates .card itself and swaps the face at 90deg (transform only, the card stays flat) — mass
 * choreography (gather, recycle), every draw and undone draw (the most frequent turn of all, three at a time
 * in draw 3; they also cast no lift shadow), and every flip in lite mode.
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
    tightBelow: 0.25, // classic art: a face-up fan step under this (/ card height) cuts the corner suit (see markTight)
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
    // ---- press + drag ("stiff paper": quick, well damped, small angles)
    pressScale: 0.955, // finger down: the card is pushed into the felt before anything else happens
    pressMs: 90,
    dragScale: 1.07,
    dragLiftMs: 170,
    dragCatch: 0.035, // s: time constant with which a card that is not under the finger yet slides there
    dragLag: 0.03, // s: time constant of the first trailing card…
    dragLagGrow: 0.22, // …and how much softer each further card of the run is
    dragStretchX: 0.4, // how far a trailing card may fall behind its neighbour / card width
    dragStretchY: 0.26, // … / card height
    tiltK: 320, // tilt spring (per s²) — critically-ish damped: it leans into the motion and comes straight back
    tiltC: 27,
    tiltZ: 0.0055, // deg per px/s
    tiltY: 0.012,
    tiltX: 0.011,
    tiltMaxZ: 8, // clamps (deg)
    tiltMaxY: 14,
    tiltMaxX: 12,
    dropLeave: 0.65, // a held card with more than this share of itself still over its own pile has not left it
    dropStiffness: 620, // the magnetic snap onto a legal pile
    dropDamping: 36,
    dropRunSoften: 46, // each further card of a dropped run lands this much softer (stiffness)
    returnStiffness: 300, // a cancelled drag going home
    returnDamping: 27,
    // ---- reveal
    revealMs: 320,
    revealDelay: 110,
    revealHop: 0.13, // card heights
    // ---- new game: gather, shuffle, deal (about 2.5 s together at speed 1)
    deckScale: 1.8, // the deck is shuffled close to the player (capped by deckMaxW and the table width)
    deckMaxW: 170, // px: widest a deck card gets
    gatherMs: 330, // flight of the farthest card (nearer ones are quicker)
    gatherSpan: 170, // the sweep goes round the table within this long
    cutMs: 170,
    riffleGap: 5.4, // ms between two cards falling
    riffleMs: 135, // one card's fall
    squareMs: 190,
    dealMs: 330, // + distance (see deal())
    dealGap: 30,
    dealAhead: 5, // cards kept rendered on top of the deck while dealing
    dealFlipMs: 270,
    // ---- glide (layout changes, neighbours)
    glideStiffness: 230,
    glideDamping: 27,
    // ---- hint
    hintMs: 2200, // lifetime of the static cue (reduced motion); the animated hint lasts two ghost passes
    hintPassMs: 780,
    hintGhostMax: 6, // cards of a run that get a ghost
    // ---- hover (fine pointers only)
    hoverTilt: 9, // deg at the edge of the card
    hoverGlare: 0.42,
    hoverLift: 0.3,
    hoverScale: 1.035,
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
  const tightWant = new Uint8Array(52); // scratch of markTight()
  let stopTick = null;
  let idleFrames = 0;

  let drag = null; // see dragStart()
  let pressed = null; // { sprites } while a finger rests on a card (see press())
  let hover = null; // { s, px, py, rx, ry, go } while a fine pointer rests on a top card (see hoverAt())
  let hintState = null;
  let lite = false; // the device is struggling (or effects are 'low'): transform-only choreography, fewer particles
  let nopeFlip = false;
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
  function outBack(t) {
    const c = 1.70158;
    const u = t - 1;
    return 1 + (c + 1) * u * u * u + c * u * u;
  }
  function inOutSine(t) {
    return -(Math.cos(PI * t) - 1) * 0.5;
  }
  function inOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }
  /** Maps an angle in degrees into (-180, 180]. */
  function wrap180(a) {
    a = a % 360;
    if (a > 180) a -= 360;
    else if (a <= -180) a += 360;
    return a;
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
      // (SOL.Haptics itself holds back before the first user gesture in a browser: the opening deal)
      if (SOL.Haptics) SOL.Haptics.play(kind);
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
      this.fanned = false; // a covered card of the sideways draw-3 waste fan (see markFanned())
      this.tight = false; // a covered face-up card of a column squeezed below its corner index (see markTight())
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
      this._wFan = false;
      this._wTight = false;
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
      // (angles left over from a 3D show unwind the short way round)
      const rot0 = (s.rot = wrap180(s.rot));
      const rx0 = (s.rx = wrap180(s.rx));
      const ry0 = (s.ry = wrap180(s.ry));
      const sc0 = s.scale;
      const lift0 = s.lift;
      const flip0 = s.flip;
      const rot1 = o.rot || 0;
      const rx1 = o.rx || 0;
      const ry1 = o.ry || 0;
      const sc1 = o.scale === undefined ? 1 : o.scale;
      const lift1 = o.lift || 0;
      const flip1 = o.flip === undefined ? (tracking ? (s.faceUp ? 0 : 180) : flip0) : o.flip;
      const fa = o.flipFrom === undefined ? 0.12 : o.flipFrom;
      const fb = Math.max(fa + 0.01, o.flipTo === undefined ? 0.82 : o.flipTo);
      const peakLift = o.peakLift === undefined ? 0.75 : o.peakLift;
      const peakScale = o.peakScale === undefined ? 0.07 : o.peakScale;
      const spin = o.spin || 0;
      const turns = (o.turns || 0) * 360; // whole in-plane turns: the card ends looking exactly as without them
      const turnsBy = o.turnsBy || 1; // …finished by this fraction of the flight (the rest is a straight slide)
      const ease = o.ease || outCubic;
      const ownsFlip = flip1 !== flip0;
      const arc = o.arc || 0;
      const side = o.side || 0;
      // sideways bow: along the normal to the right of the direction of travel
      const nx = dist > 0.001 ? -(fy1 - y0) / dist : 1;
      const ny = dist > 0.001 ? (fx1 - x0) / dist : 0;
      const overPx = o.overshoot === undefined ? (L ? L.cardW * TUNE.overshoot : 0) : o.overshoot;
      const over = dist > 4 ? Math.min(overPx, dist * 0.2) / dist : 0;
      const trail = o.trail || null;
      let started = false;

      if (flip1 !== flip0) s.flipMode = o.flipMode === SPIN || (o.flipMode === undefined && lite) ? SPIN : PROP;
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
          const e = ease(t);
          const p = e + over * t * t * t * t * (1 - t) * 12.2; // a little past the target, then back
          const bow = 4 * p * (1 - p);
          const x1 = tracking ? s.tx : fx1;
          const y1 = tracking ? s.ty : fy1;
          s.x = x0 + (x1 - x0) * p + nx * side * bow;
          s.y = y0 + (y1 - y0) * p + ny * side * bow - arc * bow;
          const bell = Math.sin(PI * t);
          s.rot = rot0 + (rot1 - rot0) * e + spin * bell;
          if (turns) s.rot += turns * (turnsBy < 1 ? outCubic(Math.min(1, t / turnsBy)) : e);
          s.rx = rx0 + (rx1 - rx0) * e;
          s.ry = ry0 + (ry1 - ry0) * e;
          s.scale = sc0 + (sc1 - sc0) * e + peakScale * bell;
          s.lift = clamp(lift0 + (lift1 - lift0) * e + peakLift * bell, 0, 1);
          if (ownsFlip) s.flip = flip0 + (flip1 - flip0) * inOutSine(clamp((t - fa) / (fb - fa), 0, 1));
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
          s.rx = rx1;
          s.ry = ry1;
          s.scale = sc1;
          s.lift = lift1;
          // (a flight that does not turn the card leaves the face to whoever is turning it — see deal())
          if (ownsFlip) s.flip = flip1;
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
      s.flipMode = o.mode === SPIN || (o.mode === undefined && lite) ? SPIN : PROP;
      s.dflip = deg;
      let started = false;
      let air = false; // the hop also lifts the card — unless a flight or a pose owns lift / scale meanwhile
      const h = A().tween({
        duration: o.duration === undefined ? TUNE.revealMs : o.duration,
        delay: o.delay || 0,
        ease: 'linear',
        update: function (t) {
          if (s.hFlip !== h) return;
          if (!started) {
            started = true;
            air = !!hop && !s.hFlight && !s.hPose && !s.held;
            if (o.onStart) o.onStart(s);
          }
          s.flip = flip0 + (deg - flip0) * inOutSine(t);
          if (hop) {
            const bell = Math.sin(PI * t);
            if (!s.hOff) s.oy = -hop * bell;
            if (air && !s.hFlight && !s.hPose && !s.held) {
              s.lift = lite ? 0 : 0.55 * bell; // (lite mode: transform only, no shadow layers)
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
            if (air && !s.hFlight && !s.hPose && !s.held) {
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
     * A little performance in place: fn(t, sprite) writes any of rot / rx / ry / scale / lift for t = 0..1 and
     * must bring them back to rest by t = 1 (they are forced to rest when it ends). Runs in the pose slot, so
     * it is cancelled by anything that takes the card (a flight, a drag, another pose).
     */
    act(fn, o) {
      o = o || EMPTY;
      const s = this;
      if (s.hPose) {
        const p = s.hPose;
        s.hPose = null;
        p.cancel();
      }
      s.cover(false);
      const h = A().tween({
        duration: o.duration === undefined ? 420 : o.duration,
        delay: o.delay || 0,
        ease: 'linear',
        update: function (t) {
          if (s.hPose !== h) return;
          fn(t, s);
          s.lift = clamp(s.lift, 0, 1);
          touch(s);
        },
        done: function () {
          if (s.hPose !== h) return;
          s.hPose = null;
          if (!s.held) {
            s.rot = 0;
            s.rx = 0;
            s.ry = 0;
            s.scale = 1;
            s.lift = 0;
          }
          touch(s);
          s._settled();
        },
      });
      s.hPose = h;
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
      if (s.fanned !== s._wFan) {
        s._wFan = s.fanned;
        s.el.classList.toggle('is-fanned', s.fanned);
      }
      if (s.tight !== s._wTight) {
        s._wTight = s.tight;
        s.el.classList.toggle('is-tight', s.tight);
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
    if (hover) hoverFrame(dt);
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
    // cards.css swaps to the phone art below this width; SOL.Cards publishes the number (one source of truth)
    const compact = cardW < ((SOL.Cards && SOL.Cards.COMPACT_BELOW) || 60);
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
      // Between the side groups and the columns: two gaps at least and, where the outer margins have the room,
      // up to 0.6 of a card — the 2 x 2 foundation block (and the stock) must read as groups of their own, not
      // as two more columns.
      const spare = Math.max(0, availW - 10 * cardW - 11 * gap);
      let sep = gap * 2 + Math.min(spare / 2, Math.max(0, cardW * 0.6 - gap * 2));
      // No room in the margins (a small phone held sideways: the cards take the whole width): the columns move a
      // little closer together instead — down to a tenth of a card, still more air than the columns of the
      // portrait table have — until the groups stand half a card apart. The cards keep their size.
      const tight = Math.max(4, cardW * 0.1);
      if (sep < cardW * 0.5 && gap > tight) {
        const give = Math.min(gap - tight, ((cardW * 0.5 - sep) * 2) / 7);
        gap -= give;
        sep += (give * 7) / 2;
      }
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

    // two halves side by side (the cut) must fit the table with room to spare
    const deckScale = clamp(TUNE.deckScale, 1, Math.max(1, Math.min((W * 0.4) / cardW, TUNE.deckMaxW / cardW)));
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
      markFanned(null);
      markTight(null);
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
    // .has-cards: the stock is not empty in the game — wherever its cards are at this moment (gliding to a slot
    // that moved, flying back in a recycle). board.css shows the recycle symbol only without it.
    if (stockEl) stockEl.classList.toggle('has-cards', piles.stock.length > 0);
    markFanned(piles.waste);
    markTight(piles);
  }

  /**
   * Draw 3 with the waste fanned sideways: every waste card under the top one shows only its left edge, where
   * the phone art has the rank but not the suit. Those cards carry .is-fanned and cards.css gives them a small
   * suit under the rank (compact art only; the classic corner index has one anyway). `waste` null: nobody.
   * While the top card is in the player's hand the card under it lies open, face and all: it shows the normal
   * art, and gets the mark back the moment the hand lets go and the top card comes home (dragStart and
   * dragCancel call this; a drop that moves the card away changes the state, and retarget() marks the new fan).
   */
  function markFanned(waste) {
    const sideways = !!waste && L.draw3 && L.wasteFanX > 0;
    const n = waste ? waste.length : 0;
    const top = n > 0 ? waste[n - 1] : -1;
    const open = n > 1 && sprites[top].held === 'drag' ? waste[n - 2] : -1;
    for (let i = 0; i < 52; i++) {
      const s = sprites[i];
      const on = sideways && s.pile === 'waste' && i !== top && i !== open;
      if (on !== s.fanned) {
        s.fanned = on;
        touch(s);
      }
    }
  }

  /**
   * A column squeezed so far (wide and short tables, late in a game) that its fan step is lower than the
   * classic corner index — rank over suit — is high: the suit under the rank of every covered face-up card is
   * cut off. Those cards carry .is-tight and cards.css shows their suit once more, top-right, level with the
   * rank (classic art only; the phone art has its suit there anyway). `piles` null: nobody.
   */
  function markTight(piles) {
    tightWant.fill(0);
    if (piles && !L.compact) {
      const faces = state.faceUp;
      for (let c = 0; c < 7; c++) {
        const arr = piles[TABLEAU[c]];
        const n = arr.length;
        let nDown = 0;
        for (let i = 0; i < n; i++) if (!faces[arr[i]]) nDown++;
        if (n - nDown < 2 || columnFan(nDown, n - nDown).up >= L.cardH * TUNE.tightBelow) continue;
        for (let i = 0; i < n - 1; i++) if (faces[arr[i]]) tightWant[arr[i]] = 1;
      }
    }
    for (let i = 0; i < 52; i++) {
      const s = sprites[i];
      const on = tightWant[i] === 1;
      if (on !== s.tight) {
        s.tight = on;
        touch(s);
      }
    }
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
    setDealing(true); // (before the first style pass below: the symbol must not start visible and fade out)
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
    hoverEnd(true);
    clearHint();
    deckMode = false;
    setDealing(false);
    for (let i = 0; i < 52; i++) {
      const s = sprites[i];
      if (s.held) releaseSprite(s);
    }
  }

  /**
   * The deck is out — from the moment the old game is swept up until the new deal has landed. The stock slot
   * is empty all that time, but not "run out": .is-dealing keeps its recycle symbol hidden (board.css).
   */
  function setDealing(on) {
    if (pileEls.stock) pileEls.stock.classList.toggle('is-dealing', on);
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

  function scorePop(x, y, delta, openY) {
    if (!delta || !L) return;
    const text = (delta > 0 ? '+' : '\u2212') + Math.abs(delta); // a real minus sign
    const size = clamp(L.cardW * 0.36, 15, 30);
    let rise = clamp(L.cardH * 0.6, 30, 70);
    let onCard = false;
    if (y - 4 - rise < size * 0.7) {
      // Near the top of the table (a card reached its foundation, a recycle; in the side arrangement also the
      // first cards of a column): rising from the card's top edge, the pill (size * 0.7 high each way) would
      // run under the HUD. The label can neither do that nor may it settle on the rank and suit of the card
      // that has just landed, so it plays on the lower half of THAT card — from 0.84 of its height up to the
      // middle. `openY`: the top of the last card of a run that landed with it (the card whose lower half
      // can be seen).
      y = (openY > y ? openY : y) + L.cardH * 0.84;
      rise = L.cardH * 0.34;
      onCard = true;
    }
    const f = fx();
    if (f) {
      const c = toClient(x + L.cardW / 2, y);
      f.floatText(c.x, onCard ? c.y : c.y - 4, text, {
        color: delta > 0 ? GOLD : MINUS,
        size: size,
        rise: rise,
        duration: 950,
        plate: true, // a dark pill, like the DOM label below: score labels play over cards, and gold on ivory is weak
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

  /**
   * A card arrived on its foundation: slot pulse, particles in the suit's colour, a note that climbs with the
   * rank, a haptic. `quiet` (auto-complete, where a card lands every few frames): fewer particles.
   */
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
    if (rank === 13) suitComplete(s);
    const f = fx();
    if (!f || !L) return;
    const w = L.cardW;
    const cx = L.left + s.tx + w / 2;
    const cy = L.top + s.ty + L.cardH / 2;
    if (!quiet) {
      f.ring(cx, cy, { color: SUIT_GLOW[suit], radius: w * 1.05, width: Math.max(2, w * 0.035), duration: 460 });
    }
    f.burst(cx, cy, {
      kind: 'suit',
      suit: suit,
      count: quiet ? (lite ? 2 : 4) : 9,
      size: clamp(w * 0.11, 5, 13),
      speed: w * 3.6,
      gravity: w * 8,
    });
    if (!quiet || !lite) {
      f.burst(cx, cy, { kind: 'spark', count: quiet ? 5 : 12, speed: w * 4.4, size: clamp(w * 0.035, 1.6, 3.2), gravity: w * 7 });
    }
  }

  /** The cards a run lands on give a little: the one right under it most, the next two less, a beat later. */
  function bump(pileId, belowIndex) {
    if (!state || belowIndex < 0 || reduced()) return;
    const arr = state.piles[pileId];
    if (!arr) return;
    const amp = clamp(L.cardH * 0.024, 1, 3.2);
    for (let k = 0; k < 3; k++) {
      const id = arr[belowIndex - k];
      if (id === undefined) break;
      const s = sprites[id];
      if (s.held || s.busy() || s.covered) continue;
      const a = amp * (1 - k * 0.3);
      s.wobble(
        function (t, sp) {
          sp.oy = a * Math.sin(PI * t) * (1 - t);
        },
        { duration: 210, delay: k * 18 }
      );
    }
  }

  /** A run landed on a column: the top cards of the columns next to it lean away for a moment. */
  function ripple(pileId) {
    if (!state || reduced() || pileId.charAt(0) !== 't') return;
    const c = Number(pileId.charAt(1));
    const amp = clamp(L.cardW * 0.028, 1, 2.6);
    for (let d = -1; d <= 1; d += 2) {
      const arr = state.piles['t' + (c + d)];
      if (!arr || arr.length === 0) continue;
      const s = sprites[arr[arr.length - 1]];
      if (s.held || s.busy()) continue;
      s.wobble(
        function (t, sp) {
          sp.ox = d * amp * Math.sin(PI * t) * (1 - t);
        },
        { duration: 240, delay: 40 }
      );
    }
  }

  /**
   * A foundation is complete (its King just arrived): the stack takes a bow. A sweep of light across it, a
   * wide gold ring, stars — and the King nods in 3D (top edge towards the player, back, settle).
   */
  function suitComplete(s) {
    const el = pileEls[s.pile];
    if (el) {
      // a static gold crown on the slot for a moment: the cue that needs no motion
      el.classList.add('is-crowned');
      root.setTimeout(function () {
        el.classList.remove('is-crowned');
      }, 900);
    }
    if (reduced() || !L) return;
    if (!s.held && !s.hFlight) {
      s.act(
        function (t, sp) {
          // down-up-settle: a damped nod
          const env = Math.sin(PI * Math.min(1, t * 1.15)) * (1 - t);
          sp.rx = -26 * Math.sin(t * PI * 2.2) * (1 - t);
          sp.scale = 1 + 0.16 * env;
          sp.lift = lite ? 0 : 0.7 * Math.sin(PI * t);
        },
        { duration: 620 }
      );
    }
    const f = fx();
    if (!f) return;
    const w = L.cardW;
    const cx = L.left + s.tx + w / 2;
    const cy = L.top + s.ty + L.cardH / 2;
    f.shimmer({ x: L.left + s.tx, y: L.top + s.ty, width: w, height: L.cardH }, { radius: w * 0.075, duration: 900 });
    f.ring(cx, cy, { color: GOLD, radius: w * 1.9, width: Math.max(2, w * 0.05), duration: 640 });
    f.burst(cx, cy, { kind: 'star', count: lite ? 8 : 16, speed: w * 3.4, size: clamp(w * 0.1, 4, 10) });
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
        // Transform only, like the recycle: the card stays flat (one layer) and nothing but its own transform
        // is restyled. A draw is the most frequent animation of the game and three of them overlap in draw 3:
        // the lit --flip turn with its lift shadow cost about three times the paints and layout passes.
        peakLift: 0,
        peakScale: 0.1,
        flipMode: SPIN,
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
      if (delta) scorePop(L.piles.stock.x, L.piles.stock.y, delta); // (plays on the lower half of the slot)
    }
  }

  function applyMove(transfers, flips, moved, undo, tempo, o, dropped, delta) {
    const n = transfers.length;
    if (n === 0) return;
    const lead = sprites[transfers[0].card];
    const tail = sprites[transfers[n - 1].card]; // the last card of the run (its lower half stays in view)
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
        // The magnetic snap: a stiff spring pulls the card straight onto its place (the hand's velocity is
        // mostly dropped — the pile takes over), each further card of a run a touch softer.
        s.springTo(s.tx, s.ty, {
          stiffness: Math.max(240, TUNE.dropStiffness - i * TUNE.dropRunSoften),
          damping: TUNE.dropDamping,
          velocity: { x: dropped.vx * 0.35, y: dropped.vy * 0.35 },
        });
        s.poseTo({ rot: 0, rx: 0, ry: 0, scale: 1, lift: 0 }, { duration: 170 + i * 16, ease: 'outCubic' });
        touch(s);
      }
      sfx('place', { pan: panOf(lead.tx) });
      if (toFoundation) foundationArrive(lead);
      else {
        haptic('thud');
        bump(toPile, lead.index - 1);
        ripple(toPile);
      }
      if (delta) scorePop(lead.tx, lead.ty, delta, tail.ty);
    } else {
      const dist = Math.hypot(lead.tx - lead.x, lead.ty - lead.y);
      const step = o.step || 0;
      const baseMs = (auto ? clamp(flightMs(dist) * 0.95, 280, 440) : flightMs(dist) * (toFoundation ? 1.12 : 1)) * tempo;
      const want = L.cardH * (toFoundation ? TUNE.arcFoundation : TUNE.arc) * clamp(dist / (L.cardW * 3), 0.35, 1);
      const arc = arcFor(lead, want);
      // foundation flights also bow sideways — always towards the middle of the table, never off its edge
      let side = 0;
      if (toFoundation && !undo && dist > 1) {
        const nx = -(lead.ty - lead.y) / dist; // x of the normal to the right of the direction of travel
        const inward = (lead.x + lead.tx) / 2 < (L.w - L.cardW) / 2 ? 1 : -1;
        side = (nx * inward >= 0 ? 1 : -1) * Math.min(L.cardW * 0.5, dist * 0.12) * Math.min(1, Math.abs(nx) * 3);
        // the auto-complete cascade braids: successive cards take a wider, then a tighter curve
        if (auto) side *= 1 + (step % 3) * 0.7;
      }
      const spin = clamp((lead.tx - lead.x) / (L.cardW * 4), -1, 1) * (toFoundation ? 9 : 5) + (auto ? (step % 2 ? 10 : -10) : 0);
      for (let i = 0; i < n; i++) {
        const s = sprites[transfers[i].card];
        const isLead = i === 0;
        place(s, 'fly', {
          duration: baseMs,
          delay: i * TUNE.runLag * tempo,
          arc: arc,
          side: side,
          spin: spin,
          peakLift: auto && lite ? 0 : 0.9,
          liftSteps: auto ? 3 : 0,
          peakScale: toFoundation ? (auto ? 0.22 : 0.16) : 0.09,
          trail: auto && !lite ? SUIT_GLOW[suitOf(s.id)] : null,
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
                    ripple(sp.pile);
                    if (delta) scorePop(sp.tx, sp.ty, delta, tail.ty);
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
        place(s, 'fly'); // (turns on the way: the lit flip, or the plain one in lite mode — fly()'s default)
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

  /**
   * The old game is swept up: one pass round the table (left, top, right — like an arm collecting the cards),
   * every card curling in towards the deck spot on the same side, turning face-down on the way. They all
   * arrive within a few frames of each other, so the deck forms with one beat.
   */
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
    const sizes = Object.create(null);
    if (state) for (let p = 0; p < PILE_IDS.length; p++) sizes[PILE_IDS[p]] = state.piles[PILE_IDS[p]].length;
    deckMode = true;
    state = null;
    inviteOn = false;
    refreshInvite();
    if (pileEls.stock) pileEls.stock.classList.remove('is-stacked', 'is-spent', 'has-cards');
    setDealing(true);
    // where each card is now (retarget overwrites the logical place)
    const from = [];
    for (let k = 0; k < 52; k++) {
      const s = sprites[order[k]];
      from.push({ fromTop: (sizes[s.pile] || 1) - 1 - s.index, covered: s.covered });
      s.index = k;
    }
    retarget();
    const scale = L.deck.scale;
    const far = Math.max(1, Math.hypot(L.w, L.h) * 0.6);
    const total = TUNE.gatherSpan + TUNE.gatherMs;
    sfx('whoosh', { duration: total * 0.9 });
    const handles = [];
    const late = [];
    for (let k = 0; k < 52; k++) {
      const s = sprites[order[k]];
      s.held = 'deck';
      s.soft = false;
      s.dx = s.tx;
      s.dy = s.ty;
      s.dflip = 180;
      if (from[k].covered && !s.busy()) {
        // Buried in the stock / waste / a foundation: nobody sees it leave. It waits (not rendered) under
        // the deck spot and joins the deck when the visible cards land on it.
        s.stop();
        s.x = s.tx;
        s.y = s.ty;
        s.ox = 0;
        s.oy = 0;
        s.rot = 0;
        s.rx = 0;
        s.ry = 0;
        s.scale = scale;
        s.lift = 0;
        s.flip = 180;
        s.z = s.tz;
        touch(s);
        late.push(s);
        continue;
      }
      const ddx = s.tx - s.x;
      const ddy = s.ty - s.y;
      const dist = Math.hypot(ddx, ddy);
      // the sweep: cards to the left of the deck go first, then the ones above it, then the right
      const ang = Math.atan2(-ddy, -ddx); // direction from the deck to the card
      const sweep = dist < 2 ? 0.5 : clamp(((ang + PI) / PI) % 2, 0, 1); // left 0 … up 0.5 … right 1 (below: 0..1 too)
      const delay = sweep * TUNE.gatherSpan + Math.min(6, from[k].fromTop) * 9;
      handles.push(
        s.fly({
          x: s.tx,
          y: s.ty,
          flip: 180,
          flipMode: SPIN,
          flipFrom: 0.02,
          flipTo: 0.62,
          scale: scale,
          duration: TUNE.gatherMs * (0.62 + 0.38 * clamp(dist / far, 0, 1)),
          delay: delay,
          ease: inOutSine, // gathers speed, then lands softly: it is pulled in, not thrown
          arc: 0,
          side: Math.min(L.cardW * 1.5, dist * 0.3), // every card curls the same way round
          spin: clamp(-ddx / (L.cardW * 3), -1, 1) * 16,
          peakLift: 0, // dozens of cards at once: transform only (no shadow layers, no --lift restyles)
          peakScale: 0.05,
          overshoot: 0,
          z: TUNE.flyZ + k,
          onLand: function (sp) {
            sp.z = sp.tz;
            touch(sp);
          },
        }).finished
      );
    }
    if (late.length) {
      handles.push(
        A()
          .wait(total * 0.82)
          .then(function () {
            if (gen !== choreoGen) return;
            for (let i = 0; i < late.length; i++) if (late[i].held === 'deck') late[i].cover(false);
          })
      );
    }
    return choreo(
      Promise.all(handles).then(function () {
        if (gen !== choreoGen) return;
        for (let i = 0; i < 52; i++) if (sprites[i].held === 'deck') sprites[i].cover(false);
        haptic('thud');
      })
    );
  }

  /**
   * One riffle shuffle:
   *   cut      the top half lifts off and the two halves swing apart into a V, inner corners together, inner
   *            edges bowed up towards the player (3D);
   *   riffle   cards fall alternately from the left and the right half into the middle — each keeps a little of
   *            its half's angle, so the growing pile shows the two interleaved halves;
   *   square   both sides are pushed together: the deck is one clean block again, with a tap.
   * Called again while the controller waits for a seed (winnable deals): the deck simply riffles once more.
   */
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
    const n = deck.length;
    const half = Math.ceil(n / 2);
    const sc = L.deck.scale;
    const w = L.cardW * sc;
    const u = L.cardW / 100;
    // the halves leave a gap between them: the riffled pile grows there, in plain sight
    const spread = Math.min(w * 0.86, Math.max(10, (L.w - w) / 2 - 4));
    const drop = L.cardH * sc * 0.2; // the pile forms a little below the two halves
    const lean = 16; // deg: the V
    const bow = lite ? 0 : 30; // deg: inner edges up
    const speed = SOL.Anim.speed || 1;
    const riffleSpan = (n - 1) * TUNE.riffleGap + TUNE.riffleMs;

    // 1. cut — the bottom half slides left, the top half lifts off to the right
    const cut = [];
    for (let i = 0; i < n; i++) {
      const s = deck[i];
      const right = i >= half;
      const k = right ? i - half : i;
      s.cover(false);
      cut.push(
        s.fly({
          x: s.tx + (right ? spread : -spread) + (right ? -1 : 1) * k * 0.1 * u,
          y: Math.round(L.deck.y) - k * 0.5 * u - drop,
          rot: right ? lean : -lean,
          scale: sc,
          duration: TUNE.cutMs,
          delay: right ? 0 : 26,
          ease: inOutCubic,
          arc: right ? L.cardH * 0.16 : 0,
          peakLift: 0,
          peakScale: right ? 0.05 : 0,
          overshoot: 0,
          ry: right ? bow : -bow,
          z: s.tz,
        }).finished
      );
    }
    haptic('tick');

    return choreo(
      Promise.all(cut)
        .then(function () {
          if (gen !== choreoGen) return null;
          // 2. riffle: one card from each half in turn falls into the middle (bottom cards first)
          sfx('shuffle', { duration: riffleSpan / speed });
          const order = [];
          for (let k = 0; k < half; k++) {
            order.push(deck[k]);
            if (half + k < n) order.push(deck[half + k]);
          }
          for (let j = 0; j < order.length; j++) order[j].index = j; // the new deck order
          retarget();
          const all = [];
          for (let j = 0; j < order.length; j++) {
            const s = order[j];
            const right = j % 2 === 1;
            s.dx = s.tx;
            s.dy = s.ty;
            // (fly() eases the bow out: the card springs flat as it leaves the thumb)
            all.push(
              s.fly({
                x: s.tx + (right ? 1 : -1) * w * 0.13,
                y: s.ty,
                rot: right ? 9 : -9,
                scale: sc,
                duration: TUNE.riffleMs,
                delay: j * TUNE.riffleGap,
                arc: -L.cardH * sc * 0.1, // falls: the path sags instead of rising
                peakLift: 0,
                peakScale: 0.035,
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
          // 3. square up: the two interleaved halves are pushed into one block, which takes a firm tap
          haptic('thud');
          const taps = [];
          for (let i = 0; i < n; i++) {
            const s = deck[i];
            if (s.held !== 'deck') continue;
            taps.push(
              s.fly({
                x: s.tx,
                y: s.ty,
                rot: 0,
                scale: sc,
                duration: TUNE.squareMs,
                ease: outBack,
                peakLift: 0,
                peakScale: 0.05,
                overshoot: 0,
                z: s.tz,
              }).finished
            );
          }
          return Promise.all(taps);
        })
    );
  }

  /**
   * Deals a fresh state from the deck, the way a dealer flicks cards across a table: each one leaves fast,
   * turning once in the plane of the table, bows over the felt, slides a little past its place and settles;
   * the card that ends on top of a column is turned over as it touches down. The rest of the deck is then set
   * down on the stock. Resolves when every card is home (the last face may still be turning).
   */
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
    const far = Math.max(1, L.w * 0.55);
    const dealt = A().stagger(order, TUNE.dealGap, function (id, k) {
      if (gen !== choreoGen) return null;
      if (k + ahead < order.length) sprites[order[k + ahead]].cover(false);
      const s = sprites[id];
      if (s.held !== 'deck') return null;
      s.held = null;
      const top = s.faceUp;
      const ddx = s.tx - s.x;
      const dist = Math.hypot(ddx, s.ty - s.y);
      const dir = ddx < 0 ? -1 : 1;
      const reach = clamp(dist / far, 0, 1);
      const ms = TUNE.dealMs + 70 * reach;
      const h = s.fly({
        duration: ms,
        // thrown: all the speed is at the start (outCubic, the default)
        arc: Math.min(L.cardH * 0.5, dist * 0.2),
        side: dir * Math.min(L.cardW * 0.5, dist * 0.1),
        turns: lite ? 0 : dir, // one full turn in the plane of the table…
        turnsBy: 0.8, // …done before the card slides into place
        spin: lite ? dir * 14 : 0,
        peakLift: lite ? 0 : 0.8,
        liftSteps: 3, // ten cards in the air at once: a handful of shadow steps each, not one per frame
        peakScale: 0.04,
        overshoot: L.cardW * 0.2,
        flip: 180, // lands face-down; the top card of a column is turned by the flipTo below
        onStart: function (sp) {
          sfx('deal', { pan: panOf(sp.tx), pitch: 0.92 + (k % 7) * 0.025 });
        },
        onLand: function (sp) {
          if (gen !== choreoGen) return;
          bump(sp.pile, sp.index - 1);
          if (k % 3 === 0) haptic('tick');
        },
      });
      if (top) {
        // timed to the landing: the turn starts as the card comes down and ends just after it touched
        s.flipTo(0, {
          duration: TUNE.dealFlipMs,
          delay: ms * 0.7,
          mode: lite ? SPIN : PROP,
          hop: L.cardH * 0.1,
          onStart: function (sp) {
            sfx('flip', { pan: panOf(sp.tx), volume: 0.6 });
            haptic('tap');
          },
        });
      }
      return h.finished;
    });

    // The rest of the deck is set down on the stock while the last cards are still in the air.
    const lastLaunch = (order.length - 1) * TUNE.dealGap;
    const stockHome = [];
    for (let i = 0; i < stock.length; i++) {
      const s = sprites[stock[i]];
      if (s.held !== 'deck') continue;
      s.held = null;
      const dist = Math.hypot(s.tx - s.x, s.ty - s.y);
      stockHome.push(
        s.fly({
          duration: 360,
          delay: Math.max(0, lastLaunch - 110) + i * 2.4,
          lazy: true, // the covered ones stay unrendered until they take off
          ease: inOutCubic,
          arc: Math.min(L.cardH * 0.45, dist * 0.14),
          spin: 0,
          peakLift: 0,
          peakScale: 0,
          overshoot: 0,
          z: TUNE.flyZ + 1400 + i,
          onStart:
            i === 0
              ? function () {
                  sfx('slide', { duration: 340 / speed, pan: panOf(L.piles.stock.x) });
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
        setDealing(false);
        // anything a resize or an interruption left behind
        for (let i = 0; i < 52; i++) if (sprites[i].held === 'deck') sprites[i].held = null;
        sync('glide');
      })
    );
  }

  // ------------------------------------------------------------------ hit testing (model based, no DOM reads)
  /** Distance (px) from a table-space point to the card rectangle with its top-left corner at (sx, sy); 0 inside. */
  function cardGap(x, y, sx, sy) {
    const dx = x < sx ? sx - x : Math.max(0, x - sx - L.cardW);
    const dy = y < sy ? sy - y : Math.max(0, y - sy - L.cardH);
    return dx === 0 ? dy : dy === 0 ? dx : Math.hypot(dx, dy);
  }

  /**
   * The card a touch at this point means, or -1. A card that is hit exactly always wins. With `slop`, a touch
   * that misses every card takes the NEAREST card within `slop` px — not the one highest in the stacking order:
   * a finger in the gap between two columns means the card it almost touched. Cards at the same distance
   * (the overlapping cards of a column): the topmost, which is the one whose strip is level with the finger.
   * Only cards the player can do something with are in that race: the stock, and every card that lies (or is
   * about to lie) face-up. A card lying face-down in a column answers an exact hit only — a finger in the gap
   * between it and the stock above it, or the face-up card beside it, means the stock, or that card.
   * The stock's slack ends where the waste slot begins (stockPad): on that slot the stock is never meant.
   *
   * A card in flight can be touched in two places:
   *   - where it is going to land: it counts as lying there already, on top of its pile;
   *   - where it is drawn at this moment — except on the stock (quick draws are taps on the pile, not on the
   *     card that is still leaving it) and except over a face-up card of another pile (the flight is only
   *     passing over that card: the waste tapped again while its previous top card is leaving, the column
   *     next to a landing place). A card that still shows its back does not shield the flight above it.
   *     A card flying to the stock (an undone draw, a recycle) is not hit on its way at all: touching it would
   *     draw, and a touch on the waste slot it has just left, or on anything else under its path, is no draw.
   * (Gliding cards — springs — are hit where they are drawn.)
   */
  function cardAt(cx, cy, slop) {
    if (!L) return -1;
    const x = cx - L.left;
    const y = cy - L.top;
    const pad = slop || 0;
    const padS = stockPad(x, y, pad);
    const sz = pileZone('stock');
    const onStock = x >= sz.x0 - padS && x <= sz.x1 + padS && y >= sz.y0 - padS && y <= sz.y1 + padS;
    let rest = -1; // a card lying (or gliding) here
    let restD = Infinity;
    let land = -1; // a card in flight that lands here
    let landD = Infinity;
    let air = -1; // a card in flight that is drawn here
    let airD = Infinity;
    for (let i = 0; i < 52; i++) {
      const s = sprites[i];
      // (a card lying face-down in a column has to be hit exactly: nothing can be done with it, so a near
      // miss is never meant for it and it must not take one from the stock above or the card beside it)
      const reach = s.pile === 'stock' ? padS : !s.faceUp && s.pile.charAt(0) === 't' ? 0 : pad;
      let d;
      if (!s.hFlight) {
        d = cardGap(x, y, s.x + s.ox, s.y + s.oy);
        if (d <= reach && (d < restD || (d === restD && s.z > sprites[rest].z))) {
          rest = i;
          restD = d;
        }
        continue;
      }
      if (s.tracking) {
        d = cardGap(x, y, s.tx, s.ty);
        if (d <= reach && (d < landD || (d === landD && s.tz > sprites[land].tz))) {
          land = i;
          landD = d;
        }
      }
      // (a card on its way to the stock means "draw" wherever it is touched, and that is meant only at the stock)
      if (!onStock && s.pile !== 'stock') {
        d = cardGap(x, y, s.x + s.ox, s.y + s.oy);
        if (d <= reach && (d < airD || (d === airD && s.z > sprites[air].z))) {
          air = i;
          airD = d;
        }
      }
    }
    let best = rest;
    let bestD = restD;
    if (air >= 0 && airD <= bestD) {
      let wins = airD < bestD;
      if (!wins) {
        // both under the finger: the flight covers the cards of the pile it is arriving on, and any card
        // that is not showing its face
        const a = sprites[air];
        const r = sprites[rest];
        wins = r.pile === a.pile ? a.tz > r.tz : !(r.faceUp && r.flip < 90);
      }
      if (wins) {
        best = air;
        bestD = airD;
      }
    }
    if (land >= 0 && landD <= bestD) best = land;
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

  /**
   * The finger slack of the stock at a table-space point: `pad` — but none on the waste slot. That slot is hit
   * exactly there, with or without a card on it, so a touch on it is never a near miss of the stock beside it:
   * touching the empty waste slot does not draw.
   */
  function stockPad(x, y, pad) {
    const p = L.piles.waste;
    return pad > 0 && x >= p.x && x <= p.x + L.cardW && y >= p.y && y <= p.y + L.cardH ? 0 : pad;
  }

  function pileAt(cx, cy, slop) {
    if (!L) return null;
    const x = cx - L.left;
    const y = cy - L.top;
    const pad = slop || 0;
    const padS = stockPad(x, y, pad);
    for (let i = 0; i < PILE_IDS.length; i++) {
      const z = pileZone(PILE_IDS[i]);
      const p = i === 0 ? padS : pad; // (PILE_IDS[0] is the stock)
      if (x >= z.x0 - p && x <= z.x1 + p && y >= z.y0 - p && y <= z.y1 + p) return PILE_IDS[i];
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

  // ------------------------------------------------------------------ press + hover + drag
  /**
   * Finger (or button) down on a card that can move: it is pushed into the felt a little — the card and the run
   * on top of it — so the touch registers before anything else happens. A drag then lifts it out of that
   * dip; a tap sends it flying from there; a release without either lets it spring back.
   */
  function press(cardId) {
    unpress();
    hoverEnd();
    const s = sprites[cardId];
    if (!s || s.held || s.hFlight || reduced() || deckMode || !state) return;
    const arr = state.piles[s.pile] || [];
    const list = [];
    if (s.pile.charAt(0) === 't') {
      for (let i = s.index; i < arr.length; i++) {
        const c = sprites[arr[i]];
        if (c.held || c.hFlight) break;
        list.push(c);
      }
    } else {
      list.push(s);
    }
    if (list.length === 0) return;
    pressed = { sprites: list };
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      // a (soft) hold: a free sprite would be relaxed back to rest as soon as the little dip ended
      c.held = 'press';
      c.soft = true;
      c.poseTo(
        { scale: TUNE.pressScale + Math.min(0.03, i * 0.006), lift: 0, rot: 0, rx: 0, ry: 0 },
        { duration: TUNE.pressMs, delay: i * 8 }
      );
    }
  }

  function unpress() {
    const p = pressed;
    pressed = null;
    if (!p) return;
    for (let i = 0; i < p.sprites.length; i++) {
      const s = p.sprites[i];
      if (s.held !== 'press') continue;
      s.held = null;
      s.soft = false;
      // springs back up with a little bounce
      if (s.lift !== 0 || s.scale !== 1 || s.hPose) s.poseTo({ lift: 0, scale: 1 }, { duration: 200, ease: 'outBack' });
      else s._settled();
    }
  }

  /**
   * Ends every soft hold (press, hover tilt, …): the game needs its cards. Called before anything that moves
   * cards. The sprites relax back to rest unless the caller animates them right away.
   */
  function releaseSoft() {
    pressed = null;
    hoverEnd(true);
    for (let i = 0; i < 52; i++) {
      const s = sprites[i];
      if (!s.held || !s.soft) continue;
      s.held = null;
      s.soft = false;
      s._settled();
    }
  }

  /**
   * Idle life for fine pointers: the top face-up card under the pointer leans towards it (the corner under
   * the pointer goes down, as if pressed by a fingertip) and a soft highlight follows the pointer across
   * its face. SOL.Input calls this on every mouse move; (-1, -1) or leaving the table ends it.
   * A soft hold: the moment the game needs the card (a move, a drag, a deal) it lets go.
   */
  function hoverAt(cx, cy) {
    if (!inited || !L || !state || deckMode || drag || pressed || reduced() || choreoBusy > 0 || cx < 0) {
      hoverEnd();
      return false;
    }
    const id = cardAt(cx, cy, 0);
    const s = id >= 0 ? sprites[id] : null;
    let ok = !!s && s.faceUp && s.flip === 0 && !s.hFlight && !s.hPos && !s.hFlip && !s.hOff;
    if (ok && s.held && s.held !== 'hover') ok = false;
    if (ok && (!hover || hover.s !== s) && s.hPose) ok = false;
    if (ok) {
      const arr = state.piles[s.pile];
      if (!arr || arr[arr.length - 1] !== s.id) ok = false; // only the card on top of a pile
    }
    if (!ok) {
      hoverEnd();
      return false;
    }
    if (!hover || hover.s !== s) {
      hoverEnd();
      s.held = 'hover';
      s.soft = true;
      s.el.classList.add('is-glare');
      hover = { s: s, px: 0, py: 0, rx: 0, ry: 0, go: 0, gx: 50, gy: 50, live: true };
    }
    hover.px = clamp((cx - L.left - s.x) / L.cardW - 0.5, -0.5, 0.5);
    hover.py = clamp((cy - L.top - s.y) / L.cardH - 0.5, -0.5, 0.5);
    hover.live = true;
    wake();
    return true;
  }

  /** One frame of the hover tilt: everything eases towards where the pointer is. */
  function hoverFrame(dt) {
    const h = hover;
    const s = h.s;
    if (s.held !== 'hover') {
      hoverEnd(true);
      return;
    }
    if (!h.live) return;
    const k = 1 - Math.exp(-Math.min(dt, 50) / 70);
    const trx = -h.py * 2 * TUNE.hoverTilt;
    const tryy = h.px * 2 * TUNE.hoverTilt;
    const tgx = 50 + h.px * 90;
    const tgy = 50 + h.py * 90;
    h.rx += (trx - h.rx) * k;
    h.ry += (tryy - h.ry) * k;
    h.go += (TUNE.hoverGlare - h.go) * k;
    h.gx += (tgx - h.gx) * k;
    h.gy += (tgy - h.gy) * k;
    s.rx = h.rx;
    s.ry = h.ry;
    s.lift += (TUNE.hoverLift - s.lift) * k;
    s.scale += (TUNE.hoverScale - s.scale) * k;
    touch(s);
    const st = s.el.style;
    st.setProperty('--glare-x', r2(h.gx) + '%');
    st.setProperty('--glare-y', r2(h.gy) + '%');
    st.setProperty('--glare-o', String(Math.round(h.go * 100) / 100));
    // close enough: stop writing (the frame subscription may go back to sleep) until the pointer moves again
    if (Math.abs(trx - h.rx) < 0.05 && Math.abs(tryy - h.ry) < 0.05 && Math.abs(TUNE.hoverGlare - h.go) < 0.01) h.live = false;
  }

  /** The pointer left the card: it settles flat again. `taken` = the game took the card (its hold is gone). */
  function hoverEnd(taken) {
    const h = hover;
    if (!h) return;
    hover = null;
    const s = h.s;
    const el = s.el;
    const go = h.go;
    // the highlight fades with a tween of its own (it is not a sprite value)
    A().tween({
      duration: 150,
      ease: 'linear',
      update: function (t) {
        el.style.setProperty('--glare-o', String(Math.round(go * (1 - t) * 100) / 100));
      },
      done: function () {
        if (hover && hover.s === s) return; // hovered again meanwhile
        el.classList.remove('is-glare');
        el.style.removeProperty('--glare-o');
        el.style.removeProperty('--glare-x');
        el.style.removeProperty('--glare-y');
      },
    });
    if (!taken && s.held === 'hover') {
      s.held = null;
      s.soft = false;
      if (s.rx !== 0 || s.ry !== 0 || s.lift !== 0 || s.scale !== 1) relax(s, 200);
      else s._settled();
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
      // out of the press dip and up, quickly, with a little overshoot: the card is in the hand
      s.poseTo({ lift: 1, scale: TUNE.dragScale }, { duration: TUNE.dragLiftMs, delay: i * 10, ease: 'outBack' });
      // (caught in flight in the middle of its turn — a card just drawn: it finishes turning in the hand)
      if (s.flip !== (s.faceUp ? 0 : 180)) s.flipTo(s.faceUp ? 0 : 180, { duration: 150 });
      touch(s);
    }
    if (lead.pile === 'waste') markFanned(state.piles.waste); // (the card under it lies open now)
    // Where on the card the finger went down. Normally that is on the card as it is drawn. A card caught in
    // flight at its landing place is held as if it already lay there. Anything else — a touch that only just
    // missed the card, a card that has flown on since the press — is held by the nearest point of its face.
    let gx = px - lead.x;
    let gy = py - lead.y;
    if (gx < 0 || gx > L.cardW || gy < 0 || gy > L.cardH) {
      const lx = px - lead.tx;
      const ly = py - lead.ty;
      if (lx >= 0 && lx <= L.cardW && ly >= 0 && ly <= L.cardH) {
        gx = lx;
        gy = ly;
      } else {
        gx = clamp(gx, 0, L.cardW);
        gy = clamp(gy, 0, L.cardH);
      }
    }
    drag = {
      card: cardId,
      sprites: spr,
      from: lead.pile,
      gx: gx,
      gy: gy,
      px: px,
      py: py,
      // where the finger holds the lead card (see holdPoint) and how far the card still is from there
      hx: lead.x,
      hy: lead.y,
      late: 1, // 1: not measured yet, 2: catching up, 0: under the finger
      lx: 0,
      ly: 0,
      vx: 0,
      vy: 0,
      // (the tilt springs start from the pose the card has: a card caught in flight does not snap straight)
      rot: wrap180(lead.rot),
      rotV: 0,
      ry: wrap180(lead.ry),
      ryV: 0,
      rx: wrap180(lead.rx),
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

  /**
   * Where the finger holds the lead card at this moment (table space): the pointer minus the spot of the card
   * it went down on. Kept on the table (and reachable): the card's centre never leaves the table box.
   */
  function holdPoint(d) {
    d.hx = clamp(d.px - d.gx, -L.cardW * 0.5, L.w - L.cardW * 0.5);
    d.hy = clamp(d.py - d.gy, -L.cardH * 0.5, L.h - L.cardH * 0.5);
  }

  /** One frame of drag physics: the lead card follows the pointer, the run trails, everything tilts. */
  function dragFrame(dt) {
    const d = drag;
    const h = Math.min(dt, 40) / 1000;
    const lead = d.sprites[0];
    const still = reduced();
    holdPoint(d);
    let nx = d.hx;
    let ny = d.hy;
    if (d.late) {
      // The card is not under the finger yet: the pointer had moved on before the drag was recognised (the
      // slop, a fast start) or the card was caught in flight. It closes the distance quickly but not in one
      // jump, then follows rigidly.
      if (d.late === 1) {
        d.late = 2;
        d.lx = lead.x - nx;
        d.ly = lead.y - ny;
      }
      const keep = still ? 0 : Math.exp(-h / TUNE.dragCatch);
      d.lx *= keep;
      d.ly *= keep;
      if (Math.abs(d.lx) < 0.5 && Math.abs(d.ly) < 0.5) {
        d.late = 0;
      } else {
        nx += d.lx;
        ny += d.ly;
      }
    }

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
      // tilt: a stiff, well damped spring chasing a target set by the velocity — paper leaning into the air,
      // proportional to the speed and clamped, straight again the moment the hand stops
      const K = TUNE.tiltK;
      const C = TUNE.tiltC;
      const tz = clamp(d.vx * TUNE.tiltZ, -TUNE.tiltMaxZ, TUNE.tiltMaxZ);
      const tyaw = clamp(d.vx * TUNE.tiltY, -TUNE.tiltMaxY, TUNE.tiltMaxY);
      const tpitch = clamp(-d.vy * TUNE.tiltX, -TUNE.tiltMaxX, TUNE.tiltMaxX);
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

    // the rest of the run: each card chases the one below it — and each is a little softer than the last, so
    // the tail of a long run swings wider than its head
    const fan = d.fan;
    // …but the run stays a run: however fast the hand moves, neighbours never stretch far apart
    const maxX = L.cardW * TUNE.dragStretchX;
    const maxY = L.cardH * TUNE.dragStretchY;
    for (let i = 1; i < d.sprites.length; i++) {
      const s = d.sprites[i];
      const prev = d.sprites[i - 1];
      const lag = TUNE.dragLag * (1 + (i - 1) * TUNE.dragLagGrow);
      const a = still ? 1 : 1 - Math.exp(-h / lag);
      const b = still ? 1 : 1 - Math.exp(-h / (lag * 1.5));
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
   * for the card's own foundation); `over` = the pile it overlaps most, legal or not. The lead card is taken
   * where the finger holds it (holdPoint), which is where it is drawn except while it is still catching up.
   */
  function dropCandidate(d) {
    const x0 = d.hx;
    const y0 = d.hy;
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
    // A card that has hardly left its own pile — most of it is still over it — is put back, not moved: a tap
    // that slipped past the slop, or a drag that was called off, is not a drop on the pile next door.
    if (target && overlap(x0, y0, x1, y1, pileZone(d.from)) > area * TUNE.dropLeave) target = null;
    if (overA < area * 0.3) over = null;
    return { target: target, over: over };
  }

  function dragEnd() {
    if (!drag || drag.released) return null;
    const d = drag;
    // judged where the finger is now: the last pointer position may be newer than the last frame
    holdPoint(d);
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
        // flies home along a curve and shakes its head — AS a run: every card on the lead card's curve (one
        // duration, one bow) and only a breath apart, so the run trails a little but never opens into a row
        const lead = d.sprites[0];
        const dist = Math.hypot(lead.tx - lead.x, lead.ty - lead.y);
        // The bow of a level flight rises towards the top of the screen, and flights are kept on the table:
        // where the lead card has less room above its path than the bow is high — a run going home along the
        // top row of a wide table — the cards were pressed against the table edge, one onto the other. So the
        // bow is only as high as fits: (√y0 + √y1)² / 4 for a path between the heights y0 and y1 (none for a
        // card that was let go above the edge: it comes back onto the table the shortest way).
        let side = Math.min(L.cardW * 0.7, dist * 0.16);
        const rise = dist > 0.001 ? (Math.abs(lead.tx - lead.x) / dist) * side : 0;
        const edge = L.cardH * Math.max(0, lead.scale - 1) * 0.5; // (a card still scaled up is kept this far in)
        const room = lead.y > edge ? Math.pow(Math.sqrt(lead.y - edge) + Math.sqrt(Math.max(0, lead.ty - edge)), 2) / 4 : 0;
        if (rise > room) side *= room / rise;
        place(s, 'fly', {
          duration: clamp(240 + dist * 0.35, 260, 460),
          delay: i * 5,
          side: (lead.tx < lead.x ? 1 : -1) * side,
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
          stiffness: Math.max(170, TUNE.returnStiffness - i * 22),
          damping: TUNE.returnDamping,
          velocity: { x: d.vx, y: d.vy },
        });
        s.poseTo({ rot: 0, rx: 0, ry: 0, scale: 1, lift: 0 }, { duration: 240 });
        touch(s);
      }
    }
    if (d.from === 'waste' && state) markFanned(state.piles.waste); // (the card under it is covered again)
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
    for (let i = 0; i < h.els.length; i++) h.els[i].classList.remove('is-hint');
    if (h.tween) h.tween.cancel();
    if (h.ghost && h.ghost.parentNode) h.ghost.parentNode.removeChild(h.ghost);
    // the lifted cards come back down (unless the game has already taken them)
    for (let i = 0; i < h.lifted.length; i++) {
      const s = h.lifted[i];
      if (s.held !== 'hint') continue;
      s.held = null;
      s.soft = false;
      s._settled();
    }
  }

  /** Where a run moved to `pileId` would land (table space). */
  function landingSpot(pileId) {
    const arr = state.piles[pileId];
    const origin = L.piles[pileId];
    if (pileId.charAt(0) === 't' && arr.length > 0) {
      const top = sprites[arr[arr.length - 1]];
      return { x: top.tx, y: top.ty + (top.faceUp ? L.upFan : L.downFan) };
    }
    return { x: origin.x, y: origin.y };
  }

  /**
   * Shows a hint and returns at once (it never blocks input; the next action simply clears it).
   *   move   the suggested card and the run on it lift; a translucent ghost of them glides along an arc to
   *          where they would land and dissolves there — twice — while the target card / slot glows.
   *   draw   the top card of the stock beckons (two small bounces) and its slot rings twice.
   * Under reduced motion: the gold rings only, for TUNE.hintMs.
   */
  function hint(action) {
    if (!inited || !state || deckMode || !action || !L) return false;
    clearHint();
    const h = { els: [], timer: 0, tween: null, ghost: null, lifted: [] };
    const calm = reduced();
    const passMs = TUNE.hintPassMs;
    if (action.type === 'draw') {
      const stock = state.piles.stock;
      const top = stock.length > 0 ? sprites[stock[stock.length - 1]] : null;
      const el = top ? top.el : pileEls.stock;
      el.classList.add('is-hint');
      h.els.push(el);
      pulse('stock', GOLD);
      if (!calm) {
        if (top && !top.held && !top.busy()) {
          top.act(
            function (t, sp) {
              const w = Math.abs(Math.sin(t * PI * 2)) * (1 - t * 0.35);
              sp.scale = 1 + 0.1 * w;
              sp.lift = lite ? 0 : 0.6 * w;
            },
            { duration: passMs * 1.1 }
          );
        }
        let second = false;
        h.tween = A().tween({
          duration: passMs * 2,
          ease: 'linear',
          update: function (t) {
            if (!second && t >= 0.5) {
              second = true;
              pulse('stock', GOLD);
            }
          },
          done: function () {
            if (hintState === h) clearHint();
          },
        });
      }
    } else if (action.type === 'move') {
      const s = sprites[action.card];
      if (!s || !state.piles[action.to]) return false;
      s.el.classList.add('is-hint');
      h.els.push(s.el);
      const tEl = targetEl(action.to);
      if (tEl && tEl !== s.el) {
        tEl.classList.add('is-hint');
        h.els.push(tEl);
      }
      if (!calm && overlayEl) {
        let run = [];
        try {
          run = E().getRun(state, action.card) || [];
        } catch (err) {
          run = [];
        }
        if (run.length === 0) run = [action.card];
        // ---- the real cards lift
        for (let i = 0; i < run.length; i++) {
          const c = sprites[run[i]];
          if (c.held || c.busy()) continue;
          c.held = 'hint';
          c.soft = true;
          h.lifted.push(c);
          c.poseTo({ lift: lite ? 0 : 0.7, scale: 1.06 }, { duration: 220, delay: i * 22, ease: 'outBack' });
        }
        // ---- the ghost: a translucent copy of the run in the overlay layer
        const to = landingSpot(action.to);
        const x0 = s.tx;
        const y0 = s.ty;
        const fan = run.length > 1 ? clamp(sprites[run[1]].ty - sprites[run[0]].ty, 2, L.upFan) : 0;
        const ghost = doc.createElement('div');
        ghost.className = 'board-ghost';
        ghost.setAttribute('aria-hidden', 'true');
        const shown = Math.min(run.length, TUNE.hintGhostMax);
        for (let i = 0; i < shown; i++) {
          const g = SOL.Cards.create(run[i], { back: s.el.getAttribute('data-back') });
          g.removeAttribute('role');
          g.removeAttribute('aria-label');
          g.style.transform = 'translate3d(0,' + r2(i * fan) + 'px,0)';
          ghost.appendChild(g);
        }
        ghost.style.opacity = '0';
        ghost.style.transform = 'translate3d(' + x0 + 'px,' + y0 + 'px,0)';
        overlayEl.appendChild(ghost);
        h.ghost = ghost;
        const dist = Math.hypot(to.x - x0, to.y - y0);
        let bowY = Math.min(L.cardH * 0.9, Math.max(L.cardH * 0.3, dist * 0.28));
        if ((y0 + to.y) / 2 - bowY < -L.cardH * 0.15) bowY = -bowY * 0.6; // no room above: dip below instead
        const lean = clamp((to.x - x0) / (L.cardW * 3), -1, 1) * 7;
        h.tween = A().tween({
          duration: passMs * 2,
          ease: 'linear',
          update: function (t) {
            const u = (t * 2) % 1 || (t >= 1 ? 1 : 0); // 0..1 within each of the two passes
            // lift off (fade in), glide, dissolve
            const p = inOutCubic(clamp((u - 0.06) / 0.72, 0, 1));
            const bowT = 4 * p * (1 - p);
            const fade = u < 0.14 ? u / 0.14 : u > 0.78 ? Math.max(0, 1 - (u - 0.78) / 0.2) : 1;
            const grow = u > 0.78 ? 1 + 0.14 * Math.min(1, (u - 0.78) / 0.2) : 1 + 0.05 * Math.min(1, u / 0.14);
            ghost.style.transform =
              'translate3d(' + r2(x0 + (to.x - x0) * p) + 'px,' + r2(y0 + (to.y - y0) * p - bowY * bowT) + 'px,0) rotate(' +
              r2(lean * bowT) + 'deg) scale(' + Math.round(grow * 1000) / 1000 + ')';
            ghost.style.opacity = String(Math.round(0.62 * fade * 100) / 100);
          },
          done: function () {
            if (hintState === h) clearHint();
          },
        });
      }
    } else {
      return false;
    }
    hintState = h;
    if (calm) {
      // UI state with a lifetime, not animation sequencing (SOL.Anim.wait resolves at once under reduced motion).
      h.timer = root.setTimeout(function () {
        if (hintState === h) clearHint();
      }, TUNE.hintMs);
    }
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

  /**
   * "Nothing to suggest": the stock and the waste shake their heads, the whole table gives a small shudder
   * (a CSS animation on the two layers — nothing in the model moves) and the stock slot shows a red outline
   * for a moment (the cue that needs no motion).
   */
  function nudgeStock() {
    if (!inited || !state || deckMode) return;
    const ids = [];
    const st = state.piles.stock;
    const wa = state.piles.waste;
    if (st.length) ids.push(st[st.length - 1]);
    if (wa.length) ids.push(wa[wa.length - 1]);
    for (let i = 0; i < ids.length; i++) shakeSprite(sprites[ids[i]], i * 40, 0.6);
    pulse('stock', MINUS);
    nopeFlip = !nopeFlip;
    const layers = [cardsEl, pilesEl];
    for (let i = 0; i < layers.length; i++) {
      layers[i].classList.remove('is-entering', 'is-nope', 'is-nope-b');
      layers[i].classList.add(nopeFlip ? 'is-nope' : 'is-nope-b');
    }
    const el = pileEls.stock;
    if (el) {
      el.classList.add('is-refusing');
      root.setTimeout(function () {
        el.classList.remove('is-refusing');
      }, 700);
    }
    haptic('error');
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
    if (how === 'instant' && state && !deckMode) {
      for (let p = 0; p < PILE_IDS.length; p++) settlePile(PILE_IDS[p]);
    }
    return Promise.all(all);
  }

  /**
   * Lite mode: the device is struggling (SOL.Game measures the deal) or effects are set to 'low'. Heavy
   * choreography is simplified — flips turn the card element instead of animating --flip, mass flights cast
   * no shadows, trails and most particles are skipped. SOL.Celebrate reads it too.
   */
  function setLite(on) {
    lite = !!on;
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

  /** Sprites that are travelling (a flight or a position spring) — poses, flips and wobbles do not count. */
  function flyingCount() {
    let n = 0;
    for (let i = 0; i < sprites.length; i++) if (sprites[i].hFlight || sprites[i].hPos) n++;
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
    hoverAt: hoverAt,
    hoverEnd: function () {
      hoverEnd();
    },

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
    suitComplete: suitComplete,
    setLite: setLite,
    isLite: function () {
      return lite;
    },
    busyCount: busyCount,
    flyingCount: flyingCount,
    isDeckMode: function () {
      return deckMode;
    },
    TUNE: TUNE,
    PILE_IDS: PILE_IDS.slice(),
  };
})(typeof window !== 'undefined' ? window : globalThis);
