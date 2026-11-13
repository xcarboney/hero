/*
 * SOL.FX — particles and screen effects on the two full-viewport canvases (#fx-back behind the table,
 * #fx-front above it).
 *
 * Public API  (all coordinates are viewport / client pixels; angles are radians, 0 = right, -PI/2 = up)
 * ----------
 *   FX.init({ back: HTMLCanvasElement, front: HTMLCanvasElement })     either may be omitted; may be called
 *                                    again (whatever was showing is wiped from the canvases)
 *   FX.resize()                      re-measures both canvases. Also runs by itself on window resize and when
 *                                    the canvases change size. Front backing store = CSS size x devicePixelRatio,
 *                                    capped at 2 (1.5 in 'low' quality) and at ~8.3M pixels. The back canvas
 *                                    only ever shows soft light and is kept at 1 device pixel per CSS pixel.
 *   FX.burst(x, y, { count = 18, colors, kind = 'spark', suit, speed, spread = 2PI, angle = -PI/2,
 *                    gravity, life, size, layer = 'front' })
 *        kind 'spark'  hot streaks that arc and fall            (speed 320 px/s, gravity 560, life 700ms, size 2.4)
 *             'star'   twinkling four-point stars, drifting     (speed 210, gravity 40, life 950, size 7)
 *             'suit'   tumbling suit tokens; `suit` 0..3 = spades, hearts, clubs, diamonds; omitted = a mix
 *                                                               (speed 280, gravity 640, life 1150, size 9)
 *             'dust'   soft puffs that swell and fade           (speed 130, gravity -18, life 800, size 7)
 *        `colors`: array of CSS colours (or one string), picked at random per particle. Defaults: gold for
 *        spark/star, white for dust, card red / card ink for suits (suit tokens get an ivory outline so the
 *        dark suits read on dark felt and on white cards alike).
 *        `speed` is the fastest particle (others are slower); `size` is the particle radius in px. The default
 *        sizes and speeds above are for an 800px viewport and scale with the real one (x0.72 on a small phone
 *        up to x1.2); values you pass are used as given — scale them with the card width yourself.
 *   FX.ring(x, y, { color, radius = 60, width = 3, duration = 500, layer })      expanding shockwave ring
 *   FX.trail(x, y, { color, size = 2.6, layer })     call once per frame, per flying thing, with its current
 *                                    position: leaves fading motes and the odd twinkle. The gap to the same
 *                                    flyer's previous position is filled in, so fast flights get a continuous tail.
 *   FX.floatText(x, y, text, { color, size = 22, rise = 46, duration = 900 })    "+10" popups (centred on x, y;
 *                                    kept inside the viewport: a popup near an edge stops there)
 *   FX.confetti({ duration = 3500, density = 1, origin, colors }) -> stop()
 *        origin omitted / 'top': rains from above the top edge across the whole width.
 *        origin { x, y, angle = -PI/2, spread = 1.3 }: a cannon firing from that point.
 *        duration may be Infinity (until stop()). stop() ends the emission; airborne pieces finish falling.
 *        Rain never takes more than 70% of the particle pool, so bursts and fireworks always find room.
 *   FX.fireworks({ duration = 4500, intensity = 1, colors }) -> stop()
 *        shells rise from the bottom edge and burst with a flash of light into comet-tailed stars (peony, ring,
 *        two-colour, willow and suit-shaped shells).
 *   FX.shimmer(rect, { color, duration = 900, radius })
 *        a slanted band of light plus sparkles sweeping left to right across `rect`
 *        ({ x, y, width, height } or a DOMRect), clipped to its rounded corners.
 *   FX.ambient(enabled, { theme })   slow drifting light pools, bokeh and dust on the BACK canvas, tinted from
 *                                    the theme (--felt-glow / --felt-hi / --gold, re-read when <html data-theme>
 *                                    changes, cross-faded). `theme` is only a hint used when those CSS variables
 *                                    are missing. Remembered if called before init().
 *   FX.setQuality('high' | 'low')    'low': half the particles everywhere, half the particle cap, no ambient
 *                                    layer, lower backing-store resolution.
 *   FX.clear()                       removes every particle / ring / text / shimmer and stops running
 *                                    confetti and fireworks. The ambient layer keeps going.
 *   FX.count() -> number             live particles (ambient motes are not counted)
 *   FX.stats() -> { particles, rings, texts, shimmers, rockets, emitters, sprites, awake, quality, cap, dpr,
 *                   ambient, load, resStep, frameMs, avgFrameMs }       (extra) for tests and tuning.
 *                                    dpr = current front-canvas resolution; load / resStep: see "Load shedding".
 *
 * floatText, shimmer, confetti and fireworks always draw on the front canvas. Front-canvas order, bottom to top:
 * shimmers, particles, rockets, rings, texts.
 *
 * A typical "card reached its foundation" recipe (see dev/fx-demo.html `fx.foundation`):
 *   FX.ring(cx, cy, { radius: cardW * 1.1 });   FX.burst(cx, cy, { kind: 'suit', suit, count: 10 });
 *   FX.burst(cx, cy, { kind: 'spark', count: 14 });   FX.floatText(cx, top - 6, '+10');
 *   FX.shimmer(cardRect, { radius: cardW * 0.075 });
 *
 * Guarantees
 * ----------
 * - Every call is a silent no-op before init() and while SOL.Anim.reduced is true (confetti/fireworks then
 *   return a no-op stop function). Switching reduced motion on clears whatever is on screen.
 * - Particles live in pre-allocated typed arrays (hard cap: 1000, 500 in 'low'); when the cap is reached new
 *   particles are dropped. The frame loop allocates nothing; shapes are sprites drawn once per (kind, colour),
 *   cached, and blitted with drawImage.
 * - The loop is a SOL.Anim.frame subscription that exists only while there is something to draw; only the
 *   region touched by the previous frame is cleared.
 * - The ambient layer is built to run for hours: its light pools are composed at 1/8 resolution and repainted
 *   four times a second, its motes advance at ~20fps, and between pool updates only the motes' own boxes are
 *   repainted. It costs well under a millisecond per frame even on a software-rendered canvas.
 * - Suit particles are drawn from canvas paths (no fonts). floatText uses the system UI font.
 *
 * Load shedding
 * -------------
 * FX watches the interval between frames while 80+ particles are alive. When frames stay slow (under ~43fps
 * for 300ms) it first lowers the resolution of the front canvas (x0.75, then x0.5, never below 1 device pixel
 * per CSS pixel; full resolution returns as soon as the front canvas is empty, and a step that was needed is
 * taken at once by the next big effect for the following minute) and then thins out the continuous emitters —
 * confetti, firework shells, trails — down to 35%, recovering as frames get fast again. FX.burst() counts are
 * never reduced.
 * Trails never take more than 60% of the particle pool and confetti rain never more than 70%, so the bursts
 * that mark game events always find room.
 */
(function (root) {
  'use strict';

  const SOL = (root.SOL = root.SOL || {});
  const doc = root.document;

  // ------------------------------------------------------------------ constants
  const PI = Math.PI;
  const TAU = PI * 2;
  const CAP_HIGH = 1000;
  const CAP_LOW = 500;
  const DPR_HIGH = 2;
  const DPR_LOW = 1.5;
  const DPR_BACK = 1; // the back canvas only ever shows soft light
  const MAX_PIXELS = 8.3e6; // per canvas: a 4K backing store at most
  const MAX_DT = 50;
  const MAX_SPRITES = 160;

  const FRONT = 0;
  const BACK = 1;

  // particle kinds
  const K_SPARK = 0;
  const K_STAR = 1;
  const K_SUIT = 2;
  const K_DUST = 3;
  const K_CONFETTI = 4;
  const K_MOTE = 5;
  const K_FLASH = 6; // the burst of light when a firework shell opens
  const F_TWINKLE = 1; // flag: flickers towards the end of its life (firework stars)
  const F_COMET = 2; // flag: a long streak along the direction of travel (firework stars)

  // sprite kinds
  const S_GLOW = 0;
  const S_STAR = 1;
  const S_SUIT = 2; // + suit index (2..5)
  const S_DUST = 6;
  const S_BAND = 7;
  const S_BOKEH = 8;
  const S_POOL = 9;

  // How much of a sprite's half-size the nominal particle "size" covers.
  const GLOW_K = 1 / 0.3;
  const STAR_K = 1 / 0.92;
  const SUIT_K = 1 / 0.8;
  const DUST_K = 2;

  const GOLD = '#f3c969';
  const IVORY = '#fdfbf5';
  const RED = '#e2384d';
  const INK = '#1d2230';
  const PAL_SPARK = [GOLD, '#ffe9a8', '#fff8e1'];
  const PAL_STAR = [GOLD, '#fff3c4', '#ffffff'];
  const PAL_DUST = ['#ffffff', '#f6f1e4'];
  const PAL_RED = [RED];
  const PAL_INK = [INK];
  const PAL_CONFETTI = [GOLD, IVORY, '#ff6b6b', '#6ee7a8', '#7cc4ff', '#b79cff'];
  const PAL_FIREWORK = [GOLD, '#ff7a7a', '#6ee7a8', '#7cc4ff', '#c4a6ff', '#ffb86b', '#ff9bd2'];
  const FONT_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  const TEXT_OUTLINE = 'rgba(6, 14, 12, 0.6)';

  // Fallback tints when the theme CSS variables are not available (mirrors css/base.css --felt-glow).
  const THEME_TINTS = {
    emerald: 'rgb(120, 255, 200)',
    midnight: 'rgb(140, 170, 255)',
    crimson: 'rgb(255, 150, 160)',
    slate: 'rgb(200, 225, 255)',
  };

  const EMPTY = {};
  const rand = Math.random;

  // ------------------------------------------------------------------ state
  let inited = false;
  let quality = 'high';
  let cap = CAP_HIGH;
  let stopFrame = null; // unsubscribe function while the loop is awake
  let listening = false;

  function makeLayer() {
    return {
      canvas: null,
      ctx: null,
      w: 0, // CSS px
      h: 0,
      dpr: 1,
      ox: 0, // viewport position of the canvas' top-left corner
      oy: 0,
      n: 0, // live particles on this layer
      dirty: false, // something was drawn last frame: bounds below (device px)
      x0: 0,
      y0: 0,
      x1: 0,
      y1: 0,
    };
  }
  const layers = [makeLayer(), makeLayer()];

  // Default particle sizes / speeds are tuned for an 800px viewport and scale gently with the real one
  // (0.72 on a small phone … 1.2 on a big desktop). Explicit `size` / `speed` options are taken as given.
  let unit = 1;

  // viewport bounds used to cull particles that left the screen
  let cullL = -Infinity;
  let cullR = Infinity;
  let cullB = Infinity;

  // ---- particle pool (struct of arrays)
  const N = CAP_HIGH;
  const px = new Float32Array(N);
  const py = new Float32Array(N);
  const pvx = new Float32Array(N);
  const pvy = new Float32Array(N);
  const plife = new Float32Array(N); // ms left
  const pmax = new Float32Array(N); // ms total
  const psize = new Float32Array(N);
  const prot = new Float32Array(N);
  const pvrot = new Float32Array(N);
  const pgrav = new Float32Array(N);
  const pdrag = new Float32Array(N);
  const pa = new Float32Array(N); // phase (twinkle / tumble / flip)
  const pb = new Float32Array(N); // phase speed
  const pc = new Float32Array(N); // confetti: sway phase
  const pd = new Float32Array(N); // confetti: aspect
  const pkind = new Uint8Array(N);
  const player = new Uint8Array(N);
  const pflags = new Uint8Array(N);
  const pspr = new Uint16Array(N); // sprite index (confetti: colour-table index)
  let count = 0;

  // ---- sprites
  const sprites = [];
  const spriteMaps = [];

  // ---- confetti colours (index -> css colour; index + 1 is the darker "back side")
  const colorTable = [];
  const colorMap = new Map();

  // ---- small pools of bigger things
  function makePool(n, make) {
    const list = new Array(n);
    for (let i = 0; i < n; i++) list[i] = make();
    return list;
  }
  const rings = makePool(32, function () {
    return { x: 0, y: 0, r: 0, w: 0, dur: 1, age: 0, color: GOLD, layer: FRONT };
  });
  let ringCount = 0;
  const texts = makePool(24, function () {
    return { x: 0, y: 0, text: '', color: GOLD, size: 22, rise: 46, dur: 1, age: 0, font: '', width: 0 };
  });
  let textCount = 0;
  const shimmers = makePool(8, function () {
    return { x: 0, y: 0, w: 0, h: 0, r: 0, dur: 1, age: 0, band: 0, star: 0, acc: 0, rate: 0 };
  });
  let shimmerCount = 0;
  const rockets = makePool(16, function () {
    return { sx: 0, sy: 0, tx: 0, ty: 0, x: 0, y: 0, age: 0, fuse: 1, style: 0, c1: GOLD, c2: IVORY, scale: 1, spr: 0, tick: 0 };
  });
  let rocketCount = 0;
  const emitters = []; // running confetti / fireworks

  // ---- ambient layer
  const AMB_MAX = 48;
  const ax = new Float32Array(AMB_MAX);
  const ay = new Float32Array(AMB_MAX);
  const avx = new Float32Array(AMB_MAX);
  const avy = new Float32Array(AMB_MAX);
  const asize = new Float32Array(AMB_MAX);
  const aalpha = new Float32Array(AMB_MAX);
  const aphase = new Float32Array(AMB_MAX);
  const arate = new Float32Array(AMB_MAX);
  const aspr = new Uint16Array(AMB_MAX);
  const abokeh = new Uint8Array(AMB_MAX);
  let ambCount = 0;
  let ambWanted = false;
  let ambAlpha = 0; // current fade 0..1
  let ambTime = 0;
  let ambAcc = 0; // ms since the ambient layer last advanced (it runs at ~20fps)
  let ambTint = '';
  let ambNextTint = '';
  let ambThemeHint = '';
  let ambGold = GOLD;
  let ambW = 0;
  let ambH = 0;
  const ambPoolSpr = [0, 0, 0];
  let ambReady = false;
  // The ambient layer runs for as long as the game is open, so it has to cost next to nothing:
  //  - the three big light pools are composed into a canvas 1/8 the size (they are pure low-frequency light) and
  //    re-rendered only every AMB_BG_MS — they drift a few px per second;
  //  - motes move less than a pixel per frame, so ~20fps is indistinguishable from 60;
  //  - between pool updates only the boxes the motes occupied are repainted (clipped), not the whole canvas.
  const AMB_FRAME_MS = 48;
  const AMB_BG_MS = 250;
  const AMB_BG_SCALE = 8;
  let ambBg = null; // the composed light pools
  let ambBgCtx = null;
  let ambBgW = 0;
  let ambBgH = 0;
  let ambBgAge = Infinity; // ms since the pools were rendered
  let ambFull = true; // the next back-canvas frame must repaint everything
  const ambRect = new Float32Array(AMB_MAX * 4); // device-px boxes of the motes drawn last frame
  let ambRectN = 0;

  // ---- misc
  let trailTick = 0;
  let frameNo = 0;
  // Recent FX.trail() points: a new call close to one of them (same flyer, previous frame) fills the gap
  // between the two with motes, so a fast flyer leaves a continuous tail instead of a string of beads.
  const TRAIL_SLOTS = 12;
  const trX = new Float32Array(TRAIL_SLOTS);
  const trY = new Float32Array(TRAIL_SLOTS);
  const trFrame = new Int32Array(TRAIL_SLOTS).fill(-1000);
  let statFrame = 0;
  let statAvg = 0;
  const tmpSpr = new Uint16Array(32);
  const perf = root.performance && typeof root.performance.now === 'function' ? root.performance : null;

  function now() {
    return perf ? perf.now() : Date.now();
  }

  function isReduced() {
    const A = SOL.Anim;
    return !!(A && A.reduced);
  }

  /** True when effects may be created right now. */
  function ready() {
    return inited && !isReduced();
  }

  /** `v` when it is a finite number, else the fallback (NaN and ±Infinity are not values we can draw). */
  function num(v, fallback) {
    return typeof v === 'number' && v - v === 0 ? v : fallback;
  }

  function clampTo(v, min, max) {
    return v < min ? min : v > max ? max : v;
  }

  // Upper bounds for caller-supplied values: generous for any real effect, but a typo (or garbage) can no
  // longer park an immortal particle on screen or ask the rasteriser for a kilometre-wide sprite.
  const MAX_LIFE = 60000; // ms, also for ring / text / shimmer durations
  const MAX_SIZE = 200; // px radius

  function scaled(n) {
    return quality === 'low' ? Math.ceil(n * 0.5) : n;
  }

  // ------------------------------------------------------------------ colours
  let parseCtx = null;
  const rgba = [0, 0, 0, 1];

  /** Parses any CSS colour into `rgba` (0..255, alpha 0..1). Returns false when the string is not a colour. */
  function parseColor(str) {
    if (!doc || typeof str !== 'string') return false;
    if (!parseCtx) {
      const c = doc.createElement('canvas');
      c.width = c.height = 1;
      parseCtx = c.getContext('2d');
    }
    if (!parseCtx) return false;
    // The canvas normalises every valid colour to '#rrggbb' or 'rgba(r, g, b, a)'; invalid ones are ignored.
    parseCtx.fillStyle = '#010203';
    parseCtx.fillStyle = str.trim();
    const norm = parseCtx.fillStyle;
    if (norm === '#010203') return false;
    if (norm.charAt(0) === '#') {
      rgba[0] = parseInt(norm.slice(1, 3), 16);
      rgba[1] = parseInt(norm.slice(3, 5), 16);
      rgba[2] = parseInt(norm.slice(5, 7), 16);
      rgba[3] = 1;
      return true;
    }
    const m = /rgba?\(([^)]+)\)/.exec(norm);
    if (!m) return false;
    const parts = m[1].split(',');
    rgba[0] = parseFloat(parts[0]) || 0;
    rgba[1] = parseFloat(parts[1]) || 0;
    rgba[2] = parseFloat(parts[2]) || 0;
    rgba[3] = parts.length > 3 ? parseFloat(parts[3]) : 1;
    return true;
  }

  /** Registers a confetti colour; returns its index in colorTable (the darker back side is at index + 1). */
  function colorIndex(color) {
    let idx = colorMap.get(color);
    if (idx !== undefined) return idx;
    if (colorTable.length >= 256) return 0;
    idx = colorTable.length;
    let shade = color;
    if (parseColor(color)) {
      shade = 'rgb(' + Math.round(rgba[0] * 0.7) + ',' + Math.round(rgba[1] * 0.7) + ',' + Math.round(rgba[2] * 0.7) + ')';
    }
    colorTable.push(color, shade);
    colorMap.set(color, idx);
    return idx;
  }

  // ------------------------------------------------------------------ sprites
  function newCanvas(w, h) {
    const c = doc.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  function radial(g, cx, cy, r, stops) {
    const grad = g.createRadialGradient(cx, cy, 0, cx, cy, r);
    for (let i = 0; i < stops.length; i += 2) grad.addColorStop(stops[i], 'rgba(255,255,255,' + stops[i + 1] + ')');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(cx, cy, r, 0, TAU);
    g.fill();
  }

  /** Replaces the colour of everything painted so far with `color`, keeping the alpha. */
  function tint(g, w, h, color) {
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = '#ffffff';
    g.fillStyle = color; // an invalid colour is ignored: the sprite stays white
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'source-over';
  }

  function starPath(g, cx, cy, R) {
    const c = R * 0.11;
    g.beginPath();
    g.moveTo(cx, cy - R);
    g.quadraticCurveTo(cx + c, cy - c, cx + R, cy);
    g.quadraticCurveTo(cx + c, cy + c, cx, cy + R);
    g.quadraticCurveTo(cx - c, cy + c, cx - R, cy);
    g.quadraticCurveTo(cx - c, cy - c, cx, cy - R);
    g.closePath();
  }

  /** The four suits as paths in a box of ±u around (cx, cy). Original outlines, drawn from scratch. */
  function suitPath(g, suit, cx, cy, u) {
    g.beginPath();
    if (suit === 1) {
      // heart
      const w = u * 0.94;
      g.moveTo(cx, cy + 0.95 * u);
      g.bezierCurveTo(cx - 0.28 * w, cy + 0.62 * u, cx - w, cy + 0.22 * u, cx - w, cy - 0.34 * u);
      g.bezierCurveTo(cx - w, cy - 0.72 * u, cx - 0.74 * w, cy - 0.95 * u, cx - 0.48 * w, cy - 0.95 * u);
      g.bezierCurveTo(cx - 0.24 * w, cy - 0.95 * u, cx - 0.06 * w, cy - 0.78 * u, cx, cy - 0.56 * u);
      g.bezierCurveTo(cx + 0.06 * w, cy - 0.78 * u, cx + 0.24 * w, cy - 0.95 * u, cx + 0.48 * w, cy - 0.95 * u);
      g.bezierCurveTo(cx + 0.74 * w, cy - 0.95 * u, cx + w, cy - 0.72 * u, cx + w, cy - 0.34 * u);
      g.bezierCurveTo(cx + w, cy + 0.22 * u, cx + 0.28 * w, cy + 0.62 * u, cx, cy + 0.95 * u);
      g.closePath();
    } else if (suit === 3) {
      // diamond, with gently hollowed sides
      const w = u * 0.74;
      g.moveTo(cx, cy - u);
      g.quadraticCurveTo(cx + 0.4 * w, cy - 0.42 * u, cx + w, cy);
      g.quadraticCurveTo(cx + 0.4 * w, cy + 0.42 * u, cx, cy + u);
      g.quadraticCurveTo(cx - 0.4 * w, cy + 0.42 * u, cx - w, cy);
      g.quadraticCurveTo(cx - 0.4 * w, cy - 0.42 * u, cx, cy - u);
      g.closePath();
    } else if (suit === 2) {
      // club: three lobes, a hub and a flared stem
      const r = 0.4 * u;
      g.arc(cx, cy - 0.5 * u, r, 0, TAU);
      g.closePath();
      g.moveTo(cx - 0.5 * u + r, cy + 0.12 * u);
      g.arc(cx - 0.5 * u, cy + 0.12 * u, r, 0, TAU);
      g.closePath();
      g.moveTo(cx + 0.5 * u + r, cy + 0.12 * u);
      g.arc(cx + 0.5 * u, cy + 0.12 * u, r, 0, TAU);
      g.closePath();
      g.moveTo(cx, cy - 0.34 * u);
      g.lineTo(cx + 0.3 * u, cy + 0.2 * u);
      g.lineTo(cx - 0.3 * u, cy + 0.2 * u);
      g.closePath();
      g.moveTo(cx + 0.08 * u, cy + 0.15 * u);
      g.bezierCurveTo(cx + 0.1 * u, cy + 0.62 * u, cx + 0.2 * u, cy + 0.88 * u, cx + 0.38 * u, cy + u);
      g.lineTo(cx - 0.38 * u, cy + u);
      g.bezierCurveTo(cx - 0.2 * u, cy + 0.88 * u, cx - 0.1 * u, cy + 0.62 * u, cx - 0.08 * u, cy + 0.15 * u);
      g.closePath();
    } else {
      // spade
      const w = u * 0.88;
      g.moveTo(cx, cy - u);
      g.bezierCurveTo(cx + 0.22 * w, cy - 0.62 * u, cx + w, cy - 0.22 * u, cx + w, cy + 0.3 * u);
      g.bezierCurveTo(cx + w, cy + 0.66 * u, cx + 0.7 * w, cy + 0.82 * u, cx + 0.48 * w, cy + 0.82 * u);
      g.bezierCurveTo(cx + 0.3 * w, cy + 0.82 * u, cx + 0.15 * w, cy + 0.74 * u, cx + 0.08 * w, cy + 0.58 * u);
      g.bezierCurveTo(cx + 0.1 * w, cy + 0.8 * u, cx + 0.2 * w, cy + 0.93 * u, cx + 0.38 * w, cy + u);
      g.lineTo(cx - 0.38 * w, cy + u);
      g.bezierCurveTo(cx - 0.2 * w, cy + 0.93 * u, cx - 0.1 * w, cy + 0.8 * u, cx - 0.08 * w, cy + 0.58 * u);
      g.bezierCurveTo(cx - 0.15 * w, cy + 0.74 * u, cx - 0.3 * w, cy + 0.82 * u, cx - 0.48 * w, cy + 0.82 * u);
      g.bezierCurveTo(cx - 0.7 * w, cy + 0.82 * u, cx - w, cy + 0.66 * u, cx - w, cy + 0.3 * u);
      g.bezierCurveTo(cx - w, cy - 0.22 * u, cx - 0.22 * w, cy - 0.62 * u, cx, cy - u);
      g.closePath();
    }
  }

  function drawSprite(kind, color) {
    let c;
    let g;
    if (kind === S_GLOW) {
      c = newCanvas(64, 64);
      g = c.getContext('2d');
      radial(g, 32, 32, 32, [0, 1, 0.28, 0.94, 0.5, 0.4, 0.78, 0.09, 1, 0]);
      tint(g, 64, 64, color);
      // A small white-hot core only: the body of the particle keeps its colour (gold sparks read as gold on the
      // felt and stay visible on a white card, firework stars read as coloured light instead of white beads).
      radial(g, 32, 32, 6.4, [0, 0.9, 0.5, 0.55, 1, 0]);
    } else if (kind === S_DUST) {
      c = newCanvas(64, 64);
      g = c.getContext('2d');
      radial(g, 32, 32, 32, [0, 0.5, 0.25, 0.36, 0.5, 0.17, 0.75, 0.05, 1, 0]); // close to a gaussian: no visible disc
      tint(g, 64, 64, color);
    } else if (kind === S_STAR) {
      c = newCanvas(96, 96);
      g = c.getContext('2d');
      radial(g, 48, 48, 34, [0, 0.55, 0.45, 0.18, 1, 0]); // halo
      g.fillStyle = '#ffffff';
      starPath(g, 48, 48, 44);
      g.fill();
      tint(g, 96, 96, color);
      // a small bright heart only: on a white card the coloured star itself has to carry the shape
      g.fillStyle = 'rgba(255,255,255,0.7)';
      starPath(g, 48, 48, 13);
      g.fill();
      radial(g, 48, 48, 6, [0, 1, 0.6, 0.6, 1, 0]);
    } else if (kind >= S_SUIT && kind < S_SUIT + 4) {
      c = newCanvas(96, 96);
      g = c.getContext('2d');
      suitPath(g, kind - S_SUIT, 48, 48, 38);
      g.lineJoin = 'round';
      g.lineWidth = 7;
      g.strokeStyle = 'rgba(253, 251, 245, 0.94)';
      g.stroke();
      g.fillStyle = '#ffffff';
      g.fillStyle = color;
      g.fill();
    } else if (kind === S_BAND) {
      c = newCanvas(128, 8);
      g = c.getContext('2d');
      let grad = g.createLinearGradient(0, 0, 128, 0);
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(0.3, 'rgba(255,255,255,0.22)');
      grad.addColorStop(0.5, 'rgba(255,255,255,0.85)');
      grad.addColorStop(0.7, 'rgba(255,255,255,0.22)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 128, 8);
      tint(g, 128, 8, color);
      grad = g.createLinearGradient(0, 0, 128, 0);
      grad.addColorStop(0.4, 'rgba(255,255,255,0)');
      grad.addColorStop(0.5, 'rgba(255,255,255,0.75)');
      grad.addColorStop(0.6, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 128, 8);
    } else if (kind === S_BOKEH) {
      c = newCanvas(96, 96);
      g = c.getContext('2d');
      radial(g, 48, 48, 48, [0, 0.42, 0.7, 0.5, 0.86, 0.9, 0.94, 0.45, 1, 0]);
      tint(g, 96, 96, color);
    } else {
      // S_POOL: a very soft pool of light
      c = newCanvas(256, 256);
      g = c.getContext('2d');
      radial(g, 128, 128, 128, [0, 0.62, 0.22, 0.46, 0.48, 0.22, 0.75, 0.06, 1, 0]);
      tint(g, 256, 256, color);
    }
    return c;
  }

  /** Index of the cached sprite for (kind, colour); draws it on first use. */
  function sprite(kind, color) {
    let map = spriteMaps[kind];
    if (!map) map = spriteMaps[kind] = new Map();
    let idx = map.get(color);
    if (idx !== undefined) return idx;
    if (sprites.length >= MAX_SPRITES) {
      // Cache full (someone is generating colours): reuse any sprite of this kind. Only a kind that has no
      // sprite at all may still add one, so the cache is bounded by MAX_SPRITES + the number of kinds.
      const first = map.values().next();
      if (!first.done) return first.value;
    }
    idx = sprites.length;
    const canvas = drawSprite(kind, color);
    sprites.push(canvas);
    map.set(color, idx);
    // An immutable ImageBitmap draws measurably faster than a canvas source (no snapshot per drawImage):
    // swap it in as soon as the browser has made one. The canvas stays as the fallback.
    if (typeof root.createImageBitmap === 'function') {
      try {
        const at = idx;
        root.createImageBitmap(canvas).then(
          function (bitmap) {
            sprites[at] = bitmap;
          },
          function () {}
        );
      } catch (err) {
        /* keep the canvas */
      }
    }
    return idx;
  }

  // ------------------------------------------------------------------ particle pool
  function spawn(kind, layer, x, y, vx, vy, life, size, grav, drag, spr) {
    if (count >= cap) return -1;
    const i = count++;
    px[i] = x;
    py[i] = y;
    pvx[i] = vx;
    pvy[i] = vy;
    plife[i] = life;
    pmax[i] = life;
    psize[i] = size;
    prot[i] = 0;
    pvrot[i] = 0;
    pgrav[i] = grav;
    pdrag[i] = drag;
    pa[i] = 0;
    pb[i] = 0;
    pc[i] = 0;
    pd[i] = 0;
    pkind[i] = kind;
    player[i] = layer;
    pflags[i] = 0;
    pspr[i] = spr;
    layers[layer].n++;
    return i;
  }

  function kill(i) {
    layers[player[i]].n--;
    const j = --count;
    if (i === j) return;
    px[i] = px[j];
    py[i] = py[j];
    pvx[i] = pvx[j];
    pvy[i] = pvy[j];
    plife[i] = plife[j];
    pmax[i] = pmax[j];
    psize[i] = psize[j];
    prot[i] = prot[j];
    pvrot[i] = pvrot[j];
    pgrav[i] = pgrav[j];
    pdrag[i] = pdrag[j];
    pa[i] = pa[j];
    pb[i] = pb[j];
    pc[i] = pc[j];
    pd[i] = pd[j];
    pkind[i] = pkind[j];
    player[i] = player[j];
    pflags[i] = pflags[j];
    pspr[i] = pspr[j];
  }

  function updateParticles(dtMs) {
    const dt = dtMs * 0.001;
    let i = 0;
    while (i < count) {
      const life = plife[i] - dtMs;
      const x = px[i];
      if (life <= 0 || py[i] > cullB || x < cullL || x > cullR) {
        kill(i); // the last particle moved into slot i: process it next
        continue;
      }
      plife[i] = life;
      let k = 1 - pdrag[i] * dt;
      if (k < 0) k = 0;
      let vx = pvx[i] * k;
      const vy = (pvy[i] + pgrav[i] * dt) * k;
      pvx[i] = vx;
      pvy[i] = vy;
      if (pkind[i] === K_CONFETTI) {
        // paper flutter: a sideways sway on top of the fall
        const s = pc[i] + 2.7 * dt;
        pc[i] = s;
        vx += Math.sin(s) * 46;
      }
      px[i] = x + vx * dt;
      py[i] += vy * dt;
      prot[i] += pvrot[i] * dt;
      pa[i] += pb[i] * dt;
      i++;
    }
  }

  // ------------------------------------------------------------------ drawing
  function drawParticles(L, id) {
    const ctx = L.ctx;
    const dpr = L.dpr;
    const ox = L.ox;
    const oy = L.oy;
    let x0 = L.x0;
    let y0 = L.y0;
    let x1 = L.x1;
    let y1 = L.y1;
    let lastFill = '';
    for (let i = 0; i < count; i++) {
      if (player[i] !== id) continue;
      const t = plife[i] / pmax[i]; // 1 -> 0
      let X = (px[i] - ox) * dpr;
      let Y = (py[i] - oy) * dpr;
      let ext;
      const kind = pkind[i];
      if (kind === K_SPARK) {
        let a = t < 0.5 ? t * 2 : 1;
        if ((pflags[i] & F_TWINKLE) !== 0 && t < 0.5) a *= 0.5 + 0.5 * Math.sin(pa[i] + t * 70);
        const half = psize[i] * GLOW_K * (0.55 + 0.45 * t) * dpr;
        const vx = pvx[i];
        const vy = pvy[i];
        const sp = Math.sqrt(vx * vx + vy * vy);
        let ux = 1;
        let uy = 0;
        let long = half;
        if (sp > 8) {
          // stretched along the direction of travel, the head leading: a little comet
          ux = vx / sp;
          uy = vy / sp;
          let st;
          if ((pflags[i] & F_COMET) !== 0) {
            st = 1 + sp * 0.0125;
            if (st > 5.5) st = 5.5;
          } else {
            st = 1 + sp * 0.0048;
            if (st > 3.4) st = 3.4;
          }
          long = half * st;
          X -= ux * (long - half) * 0.55;
          Y -= uy * (long - half) * 0.55;
        }
        ctx.globalAlpha = a;
        ctx.setTransform(ux * long, uy * long, -uy * half, ux * half, X, Y);
        ctx.drawImage(sprites[pspr[i]], -1, -1, 2, 2);
        ext = long;
      } else if (kind === K_CONFETTI) {
        const a = t < 0.1 ? t * 10 : 1;
        const fl = Math.cos(pa[i]); // seen edge-on when 0; negative = the darker back side
        const w = psize[i] * dpr;
        const h = w * pd[i] * fl;
        const r = prot[i];
        const cs = Math.cos(r);
        const sn = Math.sin(r);
        const col = colorTable[pspr[i] + (fl < 0 ? 1 : 0)];
        if (col !== lastFill) {
          ctx.fillStyle = col;
          lastFill = col;
        }
        ctx.globalAlpha = a;
        ctx.setTransform(cs * w, sn * w, -sn * h, cs * h, X, Y);
        ctx.fillRect(-1, -1, 2, 2);
        ext = w;
      } else if (kind === K_STAR) {
        const a = t > 0.85 ? (1 - t) * 6.667 : t < 0.4 ? t * 2.5 : 1;
        const half = psize[i] * STAR_K * (0.72 + 0.28 * Math.sin(pa[i])) * (0.55 + 0.45 * a) * dpr;
        const r = prot[i];
        const cs = Math.cos(r) * half;
        const sn = Math.sin(r) * half;
        ctx.globalAlpha = a;
        ctx.setTransform(cs, sn, -sn, cs, X, Y);
        ctx.drawImage(sprites[pspr[i]], -1, -1, 2, 2);
        ext = half;
      } else if (kind === K_SUIT) {
        const a = t < 0.3 ? t * 3.333 : 1;
        const age = 1 - t;
        const half = psize[i] * SUIT_K * (age < 0.08 ? 0.4 + age * 7.5 : 1) * dpr;
        let fl = Math.cos(pa[i]); // tumbling about the vertical axis
        if (fl > -0.35 && fl < 0.35) fl = fl < 0 ? -0.35 : 0.35; // never a sliver: the shape must stay readable
        const r = prot[i];
        const cs = Math.cos(r) * half;
        const sn = Math.sin(r) * half;
        ctx.globalAlpha = a;
        ctx.setTransform(cs * fl, sn * fl, -sn, cs, X, Y);
        ctx.drawImage(sprites[pspr[i]], -1, -1, 2, 2);
        ext = half;
      } else if (kind === K_DUST) {
        const age = 1 - t;
        const half = psize[i] * DUST_K * (1 + age * 1.3) * dpr;
        ctx.globalAlpha = (age < 0.12 ? age * 8.333 : 1) * t * 0.26;
        ctx.setTransform(half, 0, 0, half, X, Y);
        ctx.drawImage(sprites[pspr[i]], -1, -1, 2, 2);
        ext = half;
      } else if (kind === K_FLASH) {
        // opens fast, fades as it swells: the light a shell throws when it bursts
        const age = 1 - t;
        const half = psize[i] * (0.35 + 0.65 * (1 - t * t * t)) * dpr;
        ctx.globalAlpha = (age < 0.1 ? age * 10 : t * t) * 0.9;
        ctx.setTransform(half, 0, 0, half, X, Y);
        ctx.drawImage(sprites[pspr[i]], -1, -1, 2, 2);
        ext = half;
      } else {
        // K_MOTE: a fading, shrinking glow left behind by something that flies
        const half = psize[i] * GLOW_K * (0.3 + 0.7 * t) * dpr;
        ctx.globalAlpha = t;
        ctx.setTransform(half, 0, 0, half, X, Y);
        ctx.drawImage(sprites[pspr[i]], -1, -1, 2, 2);
        ext = half;
      }
      ext = ext * 1.45 + 2; // rotation-proof margin
      if (X - ext < x0) x0 = X - ext;
      if (Y - ext < y0) y0 = Y - ext;
      if (X + ext > x1) x1 = X + ext;
      if (Y + ext > y1) y1 = Y + ext;
    }
    L.x0 = x0;
    L.y0 = y0;
    L.x1 = x1;
    L.y1 = y1;
    L.dirty = true;
  }

  function grow(L, cx, cy, ex, ey) {
    const dpr = L.dpr;
    const X = (cx - L.ox) * dpr;
    const Y = (cy - L.oy) * dpr;
    ex = ex * dpr + 3;
    ey = ey * dpr + 3;
    if (X - ex < L.x0) L.x0 = X - ex;
    if (Y - ey < L.y0) L.y0 = Y - ey;
    if (X + ex > L.x1) L.x1 = X + ex;
    if (Y + ey > L.y1) L.y1 = Y + ey;
    L.dirty = true;
  }

  /** Transform for drawing directly in viewport coordinates. */
  function viewportTransform(L) {
    const dpr = L.dpr;
    L.ctx.setTransform(dpr, 0, 0, dpr, -L.ox * dpr, -L.oy * dpr);
  }

  function drawRings(L, id) {
    const ctx = L.ctx;
    viewportTransform(L);
    for (let i = 0; i < ringCount; i++) {
      const r = rings[i];
      if (r.layer !== id) continue;
      const t = r.age / r.dur;
      const u = 1 - t;
      const rad = r.r * (0.12 + 0.88 * (1 - u * u * u));
      const lw = r.w * (0.3 + 0.7 * u);
      const a = u * Math.sqrt(u);
      ctx.strokeStyle = r.color;
      ctx.beginPath();
      ctx.arc(r.x, r.y, rad, 0, TAU);
      ctx.globalAlpha = a * 0.26;
      ctx.lineWidth = lw * 3.4;
      ctx.stroke();
      ctx.globalAlpha = a;
      ctx.lineWidth = lw;
      ctx.stroke();
      const e = rad + lw * 2;
      grow(L, r.x, r.y, e, e);
    }
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    if (r > w * 0.5) r = w * 0.5;
    if (r > h * 0.5) r = h * 0.5;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  const SHIMMER_SKEW = 0.36;

  /** Centre x of a shimmer's light band at its vertical middle. */
  function shimmerBandX(s) {
    const t = s.age / s.dur;
    const p = t * t * (3 - 2 * t);
    const bw = shimmerBandW(s);
    return s.x - bw * 0.5 + (s.w + bw) * p;
  }

  function shimmerBandW(s) {
    const bw = s.w * 0.6;
    return bw < 30 ? 30 : bw;
  }

  function drawShimmers(L) {
    const ctx = L.ctx;
    for (let i = 0; i < shimmerCount; i++) {
      const s = shimmers[i];
      const t = s.age / s.dur;
      let a = Math.sin(PI * t);
      a = a * (2 - a) * 0.6;
      const bw = shimmerBandW(s);
      const bx = shimmerBandX(s);
      const cy = s.y + s.h * 0.5;
      ctx.save();
      viewportTransform(L);
      roundRectPath(ctx, s.x, s.y, s.w, s.h, s.r);
      ctx.clip();
      ctx.globalAlpha = a;
      // slanted like light catching a glossy card: x' = x - skew * (y - cy)
      ctx.transform(1, 0, -SHIMMER_SKEW, 1, SHIMMER_SKEW * cy, 0);
      ctx.drawImage(sprites[s.band], bx - bw * 0.5, s.y - 4, bw, s.h + 8);
      ctx.restore();
      grow(L, s.x + s.w * 0.5, cy, s.w * 0.5 + 2, s.h * 0.5 + 2);
    }
  }

  function drawRockets(L) {
    const ctx = L.ctx;
    const dpr = L.dpr;
    for (let i = 0; i < rocketCount; i++) {
      const r = rockets[i];
      const half = 3.2 * GLOW_K * dpr;
      ctx.globalAlpha = 1;
      ctx.setTransform(half * 0.7, 0, 0, half * 1.5, (r.x - L.ox) * dpr, (r.y - L.oy) * dpr);
      ctx.drawImage(sprites[r.spr], -1, -1, 2, 2);
      grow(L, r.x, r.y, 3.2 * GLOW_K, 3.2 * GLOW_K * 1.5);
    }
  }

  function drawTexts(L) {
    const ctx = L.ctx;
    const dpr = L.dpr;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = TEXT_OUTLINE;
    for (let i = 0; i < textCount; i++) {
      const tx = texts[i];
      const t = tx.age / tx.dur;
      const u = 1 - t;
      // pop in with a little overshoot, drift up, fade out
      let s;
      if (t < 0.14) {
        const q = 1 - t / 0.14;
        s = 0.5 + 0.7 * (1 - q * q);
      } else if (t < 0.3) s = 1.2 - 0.2 * ((t - 0.14) / 0.16);
      else s = 1;
      let y = tx.y - tx.rise * (1 - u * u * u);
      let x = tx.x;
      // Keep the popup on screen: a score rising from the top row (or from a card at the edge of a phone)
      // stops at the edge instead of leaving the viewport.
      const hh = tx.size * 0.7;
      const hw = tx.width * 0.5 + tx.size * 0.25;
      if (L.h > hh * 2) {
        if (y < L.oy + hh) y = L.oy + hh;
        else if (y > L.oy + L.h - hh) y = L.oy + L.h - hh;
      }
      if (L.w > hw * 2) {
        if (x < L.ox + hw) x = L.ox + hw;
        else if (x > L.ox + L.w - hw) x = L.ox + L.w - hw;
      }
      const a = t < 0.08 ? t * 12.5 : t > 0.6 ? u * 2.5 : 1;
      const k = dpr * s;
      ctx.globalAlpha = a;
      ctx.setTransform(k, 0, 0, k, (x - L.ox) * dpr, (y - L.oy) * dpr);
      ctx.font = tx.font;
      ctx.lineWidth = tx.size * 0.2;
      ctx.strokeText(tx.text, 0, 0);
      ctx.fillStyle = tx.color;
      ctx.fillText(tx.text, 0, 0);
      grow(L, x, y, (tx.width * 0.5 + tx.size * 0.3) * s, tx.size * 0.9 * s);
    }
  }

  // ------------------------------------------------------------------ ambient layer
  function ambientActive() {
    return ambWanted && quality === 'high' && inited && layers[BACK].ctx !== null && !isReduced();
  }

  /** Reads the theme tint from CSS; falls back to the hint / the built-in table. */
  function readTint() {
    let tintStr = '';
    try {
      const el = layers[BACK].canvas || (doc && doc.documentElement);
      const cs = el && root.getComputedStyle ? root.getComputedStyle(el) : null;
      if (cs) {
        const glow = cs.getPropertyValue('--felt-glow');
        if (glow && parseColor(glow)) {
          tintStr = 'rgb(' + Math.round(rgba[0]) + ', ' + Math.round(rgba[1]) + ', ' + Math.round(rgba[2]) + ')';
        } else {
          const hi = cs.getPropertyValue('--felt-hi');
          if (hi && parseColor(hi)) {
            // lighten the felt highlight towards white: light, not paint
            tintStr =
              'rgb(' +
              Math.round(rgba[0] + (255 - rgba[0]) * 0.55) +
              ', ' +
              Math.round(rgba[1] + (255 - rgba[1]) * 0.55) +
              ', ' +
              Math.round(rgba[2] + (255 - rgba[2]) * 0.55) +
              ')';
          }
        }
        const gold = cs.getPropertyValue('--gold');
        ambGold = gold && parseColor(gold) ? gold.trim() : GOLD;
      }
    } catch (err) {
      tintStr = '';
    }
    if (!tintStr) {
      const attr = doc && doc.documentElement ? doc.documentElement.getAttribute('data-theme') : '';
      tintStr = THEME_TINTS[ambThemeHint] || THEME_TINTS[attr] || THEME_TINTS.emerald;
    }
    return tintStr;
  }

  function seedMote(i, anywhere) {
    const bokeh = rand() < 0.3;
    const gold = rand() < 0.38;
    abokeh[i] = bokeh ? 1 : 0;
    ax[i] = rand() * ambW;
    ay[i] = anywhere ? rand() * ambH : ambH + 30;
    avx[i] = (rand() - 0.5) * 9;
    avy[i] = -(3 + rand() * 9) * (bokeh ? 0.6 : 1);
    asize[i] = bokeh ? 7 + rand() * 17 : 0.7 + rand() * 1.5;
    aalpha[i] = bokeh ? 0.045 + rand() * 0.07 : 0.25 + rand() * 0.4;
    aphase[i] = rand() * TAU;
    arate[i] = 0.25 + rand() * 0.8;
    aspr[i] = sprite(bokeh ? S_BOKEH : S_GLOW, gold ? ambGold : ambTint);
  }

  function buildAmbient() {
    const L = layers[BACK];
    ambW = L.w;
    ambH = L.h;
    ambTint = ambNextTint || readTint();
    ambNextTint = '';
    ambPoolSpr[0] = sprite(S_POOL, ambTint);
    ambPoolSpr[1] = sprite(S_POOL, ambGold);
    ambPoolSpr[2] = ambPoolSpr[0];
    let n = Math.round((ambW * ambH) / 24000);
    n = n < 14 ? 14 : n > AMB_MAX ? AMB_MAX : n;
    ambCount = n;
    for (let i = 0; i < n; i++) seedMote(i, true);
    if (!ambBg) {
      ambBg = newCanvas(1, 1);
      ambBgCtx = ambBg.getContext('2d');
    }
    ambBgW = Math.max(1, Math.ceil(ambW / AMB_BG_SCALE));
    ambBgH = Math.max(1, Math.ceil(ambH / AMB_BG_SCALE));
    if (ambBg.width !== ambBgW || ambBg.height !== ambBgH) {
      ambBg.width = ambBgW;
      ambBg.height = ambBgH;
    }
    ambBgAge = Infinity;
    ambFull = true;
    ambReady = !!ambBgCtx;
  }

  // light pools: [cx, cy, orbitX, orbitY, speedX, speedY, phase, radius (x max side), alpha]
  const POOLS = [
    [0.3, 0.3, 0.2, 0.14, 0.071, 0.053, 0.0, 0.5, 0.2],
    [0.74, 0.62, 0.16, 0.2, 0.047, 0.066, 2.1, 0.42, 0.09],
    [0.55, 0.9, 0.3, 0.08, 0.039, 0.081, 4.2, 0.46, 0.14],
  ];

  /** Advances the ambient layer by `dtMs`: fades, the theme cross-fade, mote drift. Draws nothing. */
  function stepAmbient(L, dtMs) {
    const dt = dtMs * 0.001;
    const active = ambientActive();
    // First use, or a theme change while nothing is showing: (re)build right away.
    if (ambAlpha <= 0 && active && (ambNextTint || !ambReady)) buildAmbient();
    const want = active && !ambNextTint ? 1 : 0;
    const before = ambAlpha;
    // Fade in / out — and through zero when the theme tint changes while showing.
    if (ambAlpha < want) {
      ambAlpha += dtMs / 900;
      if (ambAlpha > 1) ambAlpha = 1;
    } else if (ambAlpha > want) {
      ambAlpha -= dtMs / 450;
      if (ambAlpha <= 0) {
        ambAlpha = 0;
        if (ambNextTint && active) buildAmbient();
      }
    }
    if (ambAlpha !== before) ambFull = true;
    if (ambAlpha <= 0) return;
    if (L.w !== ambW || L.h !== ambH) {
      // resized: redistribute the motes, keep the tint
      if (!ambNextTint) ambNextTint = ambTint;
      buildAmbient();
    }
    ambTime += dt;
    ambBgAge += dtMs;
    if (ambBgAge >= AMB_BG_MS) ambFull = true; // the pools have drifted far enough to be worth a repaint
    const W = ambW;
    for (let i = 0; i < ambCount; i++) {
      const ph = aphase[i] + arate[i] * dt;
      aphase[i] = ph;
      let x = ax[i] + (avx[i] + Math.sin(ph * 0.7) * 5) * dt;
      const y = ay[i] + avy[i] * dt;
      const m = asize[i] * 4 + 4;
      if (y < -m) {
        seedMote(i, false);
        continue;
      }
      if (x < -m) x = W + m;
      else if (x > W + m) x = -m;
      ax[i] = x;
      ay[i] = y;
    }
  }

  /** Composes the three light pools into the small `ambBg` canvas. */
  function renderPools() {
    const g = ambBgCtx;
    const W = ambW / AMB_BG_SCALE;
    const H = ambH / AMB_BG_SCALE;
    const side = W > H ? W : H;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.clearRect(0, 0, ambBgW, ambBgH);
    for (let p = 0; p < POOLS.length; p++) {
      const P = POOLS[p];
      const x = (P[0] + P[2] * Math.sin(ambTime * P[4] + P[6])) * W;
      const y = (P[1] + P[3] * Math.cos(ambTime * P[5] + P[6] * 1.7)) * H;
      const r = P[7] * side;
      g.globalAlpha = P[8] * (0.8 + 0.2 * Math.sin(ambTime * 0.23 + P[6]));
      g.drawImage(sprites[ambPoolSpr[p]], x - r, y - r, r * 2, r * 2);
    }
    g.globalAlpha = 1;
    ambBgAge = 0;
  }

  /** Paints the pools onto the back canvas (through whatever clip is set). Always the same blit, so a clipped
   *  repaint produces exactly the pixels of a full one. */
  function blitPools(L) {
    const ctx = L.ctx;
    const k = AMB_BG_SCALE * L.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = ambAlpha;
    ctx.drawImage(ambBg, 0, 0, ambBgW * k, ambBgH * k);
    ctx.globalAlpha = 1;
  }

  function drawMotes(L) {
    const ctx = L.ctx;
    const dpr = L.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    let n = 0;
    for (let i = 0; i < ambCount; i++) {
      const half = abokeh[i] ? asize[i] : asize[i] * GLOW_K;
      const x = ax[i];
      const y = ay[i];
      ctx.globalAlpha = aalpha[i] * ambAlpha * (0.55 + 0.45 * Math.sin(aphase[i]));
      ctx.drawImage(sprites[aspr[i]], x - half, y - half, half * 2, half * 2);
      // remember the box (device px, a pixel of margin) so the next frame can repaint just that
      const bx = Math.floor((x - half) * dpr) - 1;
      const by = Math.floor((y - half) * dpr) - 1;
      ambRect[n] = bx;
      ambRect[n + 1] = by;
      ambRect[n + 2] = Math.ceil((x + half) * dpr) + 1 - bx;
      ambRect[n + 3] = Math.ceil((y + half) * dpr) + 1 - by;
      n += 4;
    }
    ambRectN = n;
  }

  /**
   * One frame of the back canvas while the ambient layer is (or was just) showing: erases what the previous
   * frame drew — everything on a full repaint, otherwise only the mote boxes and the region the back particles
   * touched — puts the light pools back underneath, then draws motes, particles and rings.
   */
  function paintAmbientBack(L, busy) {
    const ctx = L.ctx;
    const W = L.canvas.width;
    const H = L.canvas.height;
    const showing = ambAlpha > 0 && ambReady;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    if (ambFull || !showing) {
      ctx.clearRect(0, 0, W, H);
      if (showing) {
        if (ambBgAge >= AMB_BG_MS) renderPools();
        blitPools(L);
      }
    } else {
      ctx.save();
      ctx.beginPath();
      for (let i = 0; i < ambRectN; i += 4) ctx.rect(ambRect[i], ambRect[i + 1], ambRect[i + 2], ambRect[i + 3]);
      if (L.dirty) {
        const x = Math.floor(L.x0) - 1;
        const y = Math.floor(L.y0) - 1;
        ctx.rect(x, y, Math.ceil(L.x1) + 1 - x, Math.ceil(L.y1) + 1 - y);
      }
      ctx.clip();
      ctx.clearRect(0, 0, W, H);
      blitPools(L);
      ctx.restore();
    }
    ambFull = false;
    L.dirty = false;
    L.x0 = Infinity;
    L.y0 = Infinity;
    L.x1 = -Infinity;
    L.y1 = -Infinity;
    if (showing) drawMotes(L);
    else ambRectN = 0;
    if (L.n > 0) drawParticles(L, BACK);
    if (busy && ringCount > 0) drawRings(L, BACK);
    ctx.globalAlpha = 1;
  }

  /** Called when the theme may have changed: cross-fade to the new tint (stepAmbient does the fading). */
  function refreshTint() {
    if (!inited || !ambWanted) return;
    const next = readTint();
    if (next === (ambNextTint || ambTint)) return;
    ambNextTint = next;
    wake();
  }

  // ------------------------------------------------------------------ emitters
  function removeRing(i) {
    const last = --ringCount;
    const tmp = rings[i];
    rings[i] = rings[last];
    rings[last] = tmp;
  }

  function addRing(x, y, color, radius, width, duration, layer) {
    if (ringCount >= rings.length) removeRing(0); // full: recycle the oldest-ish
    const r = rings[ringCount++];
    r.x = x;
    r.y = y;
    r.color = color;
    r.r = radius;
    r.w = width;
    r.dur = duration;
    r.age = 0;
    r.layer = layer;
  }

  function stepRings(dtMs) {
    for (let i = ringCount - 1; i >= 0; i--) {
      const r = rings[i];
      r.age += dtMs;
      if (r.age >= r.dur) removeRing(i);
    }
  }

  function stepTexts(dtMs) {
    for (let i = textCount - 1; i >= 0; i--) {
      const t = texts[i];
      t.age += dtMs;
      if (t.age >= t.dur) {
        const last = --textCount;
        texts[i] = texts[last];
        texts[last] = t;
      }
    }
  }

  function stepShimmers(dtMs) {
    for (let i = shimmerCount - 1; i >= 0; i--) {
      const s = shimmers[i];
      s.age += dtMs;
      if (s.age >= s.dur) {
        const last = --shimmerCount;
        shimmers[i] = shimmers[last];
        shimmers[last] = s;
        continue;
      }
      // sparkles born on the band as it passes
      s.acc += s.rate * dtMs;
      while (s.acc >= 1) {
        s.acc -= 1;
        const yy = s.y + 3 + rand() * (s.h - 6);
        let xx = shimmerBandX(s) + (rand() - 0.5) * shimmerBandW(s) * 0.5 - SHIMMER_SKEW * (yy - (s.y + s.h * 0.5));
        if (xx < s.x + 2 || xx > s.x + s.w - 2) continue;
        const m = s.w < s.h ? s.w : s.h;
        const j = spawn(K_STAR, FRONT, xx, yy, (rand() - 0.5) * 14, -4 - rand() * 14, 380 + rand() * 360, m * (0.035 + rand() * 0.05) + 1.2, 0, 1, s.star);
        if (j >= 0) {
          prot[j] = rand() * TAU;
          pvrot[j] = (rand() - 0.5) * 2.4;
          pa[j] = rand() * TAU;
          pb[j] = 9 + rand() * 8;
        }
      }
    }
  }

  function initConfetti(i, colors) {
    prot[i] = rand() * TAU;
    pvrot[i] = (rand() - 0.5) * 7;
    pa[i] = rand() * TAU;
    pb[i] = (rand() < 0.5 ? -1 : 1) * (4.5 + rand() * 8.5);
    pc[i] = rand() * TAU;
    pd[i] = rand() < 0.3 ? 0.28 + rand() * 0.12 : 0.5 + rand() * 0.3; // ribbons and squares
    pspr[i] = colors[(rand() * colors.length) | 0];
  }

  function stepConfetti(e, dtMs) {
    e.age += dtMs;
    if (e.age >= e.dur) {
      e.dead = true;
      return;
    }
    const L = layers[FRONT];
    if (e.cannon) {
      // most of the load leaves in the first third of a second
      const windowMs = e.dur < 320 ? e.dur : 320;
      if (e.age - dtMs < windowMs) e.acc += ((e.total * (0.4 + 0.6 * load)) / windowMs) * dtMs;
      while (e.acc >= 1) {
        e.acc -= 1;
        const a = e.angle + (rand() - 0.5) * e.spread;
        const sp = e.power * (0.45 + 0.55 * rand());
        const i = spawn(K_CONFETTI, FRONT, e.x + (rand() - 0.5) * 10, e.y + (rand() - 0.5) * 10, Math.cos(a) * sp, Math.sin(a) * sp, 3200 + rand() * 2600, (3.2 + rand() * 3) * unit, 430, 2.5, 0);
        if (i < 0) {
          e.acc = 0; // pool full: drop the backlog instead of dumping it later
          break;
        }
        initConfetti(i, e.colors);
      }
    } else {
      e.acc += e.rate * load * dtMs;
      // Rain never takes more than 70% of the pool: bursts and fireworks must still find room.
      if (count >= cap * 0.7) e.acc = 0;
      // long enough to fall the whole height at terminal velocity (gravity / drag = 174 px/s)
      const life = (L.h + 80) * 5.75;
      while (e.acc >= 1) {
        e.acc -= 1;
        const i = spawn(K_CONFETTI, FRONT, L.ox + rand() * L.w, L.oy - 10 - rand() * 40, (rand() - 0.5) * 130, 40 + rand() * 150, life * (1 + rand() * 0.3), (3.2 + rand() * 3) * unit, 400, 2.3, 0);
        if (i < 0) {
          e.acc = 0;
          break;
        }
        initConfetti(i, e.colors);
      }
    }
  }

  function launchRocket(e) {
    if (rocketCount >= rockets.length) return;
    const L = layers[FRONT];
    const W = L.w;
    const H = L.h;
    const r = rockets[rocketCount++];
    const colors = e.colors;
    r.sx = L.ox + W * (0.12 + rand() * 0.76);
    r.sy = L.oy + H + 10;
    r.tx = r.sx + (rand() - 0.5) * W * 0.16;
    r.ty = L.oy + H * (0.13 + rand() * 0.3);
    r.x = r.sx;
    r.y = r.sy;
    r.age = 0;
    r.fuse = 620 + rand() * 330;
    r.style = (rand() * 5) | 0;
    r.c1 = colors[(rand() * colors.length) | 0];
    r.c2 = colors[(rand() * colors.length) | 0];
    const m = W < H ? W : H;
    r.scale = (m < 380 ? 380 : m > 1000 ? 1000 : m) / 800 * e.power;
    r.spr = sprite(S_GLOW, '#ffe9a8');
    r.tick = 0;
  }

  function shell(x, y, n, speed, color, o) {
    // o: [minFactor, drag, gravity, life, size, even (ring), twinkle]
    const spr = sprite(S_GLOW, color);
    const phase = rand() * TAU;
    for (let k = 0; k < n; k++) {
      const a = o[5] ? phase + (k / n) * TAU + (rand() - 0.5) * 0.05 : rand() * TAU;
      const sp = speed * (o[5] ? 0.97 + rand() * 0.06 : o[0] + (1 - o[0]) * Math.sqrt(rand()));
      const i = spawn(K_SPARK, FRONT, x, y, Math.cos(a) * sp, Math.sin(a) * sp, o[3] * (0.72 + rand() * 0.28), o[4] * (0.8 + rand() * 0.4), o[2], o[1], spr);
      if (i < 0) return;
      if (o[6]) {
        pflags[i] = F_TWINKLE | F_COMET;
        pa[i] = rand() * TAU;
      } else {
        pflags[i] = F_COMET;
      }
    }
  }

  /** The light a shell throws when it opens: one big soft glow in the shell's colour. */
  function flash(x, y, radius, color) {
    spawn(K_FLASH, FRONT, x, y, 0, 0, 340, radius, 0, 0, sprite(S_DUST, color));
  }

  const SHELL_PEONY = [0.3, 2.1, 95, 1350, 2.9, false, true];
  const SHELL_RING = [1, 2.1, 80, 1250, 3, true, true];
  const SHELL_CORE = [0.2, 2.6, 70, 850, 2.3, false, false];
  const SHELL_WILLOW = [0.35, 1.25, 210, 2100, 2.6, false, true];

  function explode(r) {
    const x = r.tx;
    const y = r.ty;
    const S = 430 * r.scale;
    // fewer stars per shell in 'low' quality and while frames are slow (see govern())
    const q = (quality === 'low' ? 0.5 : 1) * (0.45 + 0.55 * load);
    flash(x, y, 150 * r.scale + 40, r.style === 3 ? GOLD : r.c1);
    switch (r.style) {
      case 1:
        shell(x, y, Math.round(46 * q), S, r.c1, SHELL_RING);
        shell(x, y, Math.round(14 * q), S * 0.45, '#ffffff', SHELL_CORE);
        break;
      case 2:
        shell(x, y, Math.round(40 * q), S, r.c1, SHELL_RING);
        shell(x, y, Math.round(26 * q), S * 0.58, r.c2, SHELL_PEONY);
        break;
      case 3:
        shell(x, y, Math.round(56 * q), S * 0.9, GOLD, SHELL_WILLOW);
        break;
      case 4: {
        // a shell of suit tokens: the game's own firework
        const suit = (rand() * 4) | 0;
        const spr = sprite(S_SUIT + suit, suit % 2 === 1 ? RED : INK);
        const n = Math.round(22 * q);
        for (let k = 0; k < n; k++) {
          const a = (k / n) * TAU + rand() * 0.2;
          const sp = S * (0.55 + rand() * 0.5);
          const i = spawn(K_SUIT, FRONT, x, y, Math.cos(a) * sp, Math.sin(a) * sp, 1300 + rand() * 500, (7 + rand() * 5) * (0.75 + 0.25 * r.scale), 300, 1.9, spr);
          if (i < 0) break;
          prot[i] = (rand() - 0.5) * 1.2;
          pvrot[i] = (rand() - 0.5) * 5;
          pa[i] = rand() * TAU;
          pb[i] = (rand() < 0.5 ? -1 : 1) * (3 + rand() * 5);
        }
        shell(x, y, Math.round(30 * q), S * 0.8, r.c1, SHELL_PEONY);
        break;
      }
      default:
        shell(x, y, Math.round(64 * q), S, r.c1, SHELL_PEONY);
        shell(x, y, Math.round(10 * q), S * 0.35, '#ffffff', SHELL_CORE);
    }
  }

  function stepRockets(dtMs) {
    for (let i = rocketCount - 1; i >= 0; i--) {
      const r = rockets[i];
      r.age += dtMs;
      if (r.age >= r.fuse) {
        explode(r);
        const last = --rocketCount;
        rockets[i] = rockets[last];
        rockets[last] = r;
        continue;
      }
      // decelerating climb with a slight wobble
      const t = r.age / r.fuse;
      const u = 1 - t;
      const e = 1 - u * u;
      const px0 = r.x;
      const py0 = r.y;
      r.x = r.sx + (r.tx - r.sx) * e + Math.sin(t * 9 + r.sx) * 2.5 * u;
      r.y = r.sy + (r.ty - r.sy) * e;
      const rich = quality === 'high' && load > 0.75;
      if (rich || (r.tick++ & 1) === 0) {
        spawn(K_MOTE, FRONT, r.x + (rand() - 0.5) * 3, r.y + rand() * 6, (rand() - 0.5) * 22, 30 + rand() * 50, 260 + rand() * 240, 1.5 + rand() * 1.1, 60, 1, r.spr);
        // a second ember half-way back along this frame's climb: a tail, not a string of beads
        if (rich) spawn(K_MOTE, FRONT, (r.x + px0) * 0.5 + (rand() - 0.5) * 3, (r.y + py0) * 0.5, (rand() - 0.5) * 22, 30 + rand() * 50, 220 + rand() * 220, 1.3 + rand() * 0.9, 60, 1, r.spr);
      }
    }
  }

  function stepFireworks(e, dtMs) {
    e.age += dtMs;
    if (e.age >= e.dur) {
      e.dead = true;
      return;
    }
    e.next -= dtMs;
    while (e.next <= 0) {
      launchRocket(e);
      e.next += (e.gap * (0.5 + rand())) / (0.5 + 0.5 * load);
    }
  }

  function stepEmitters(dtMs) {
    let w = 0;
    for (let i = 0; i < emitters.length; i++) {
      const e = emitters[i];
      if (!e.dead) {
        if (e.confetti) stepConfetti(e, dtMs);
        else stepFireworks(e, dtMs);
      }
      if (!e.dead) emitters[w++] = e;
    }
    emitters.length = w;
  }

  // ------------------------------------------------------------------ load shedding
  // When frames come in slowly while a lot of particles are alive, the continuous emitters thin out — confetti
  // rain, firework shells, trails — so a weak phone gets a lighter celebration instead of a slide show. Explicit
  // FX.burst() counts are never touched (callers and tests can rely on them). 1 = full richness.
  // Before the emitters thin out, the front canvas gives up resolution (x0.75, then x0.5, never under 1 device
  // pixel per CSS pixel): particles in motion look the same and a software-rendered canvas gets up to twice as
  // fast. Full resolution comes back as soon as the front canvas is empty, so small effects (a foundation
  // burst, a score popup) are always crisp; a step that was needed once is taken at once the next time a big
  // effect starts.
  const LOAD_MIN = 0.35;
  let load = 1;
  let loadDt = 16.7; // smoothed interval between frames while there is real work
  let loadSlow = 0; // ms spent over budget / comfortably under it since the last adjustment
  let loadFast = 0;
  let resStep = 0; // current resolution step of the front canvas
  let resLearned = 0; // the step big effects needed lately
  let resLearnedAt = 0; // when a step was last needed (real time): the lesson is forgotten a step a minute
  let loadSeen = 0; // when govern() last ran (real time)

  function govern(dtMs) {
    // Time spent asleep counts towards recovery too (12s from the floor to full): one bad moment — a
    // background task, a cold start — must not make every later celebration a thin one.
    const tNow = now();
    if (load < 1 && tNow - loadSeen > 1000) {
      load += (tNow - loadSeen) / 12000;
      if (load > 1) load = 1;
    }
    loadSeen = tNow;
    if (resLearned > 0 && tNow - resLearnedAt > 60000) {
      resLearned--; // try the sharper canvas again: if it is still too slow, 300ms of the next big effect show it
      resLearnedAt = tNow;
    }
    if (count >= 80) {
      loadDt += (dtMs - loadDt) * 0.12;
      if (count >= 250 && resStep < resLearned) setRes(resLearned);
      if (loadDt > 23) {
        // under ~43fps
        loadFast = 0;
        loadSlow += dtMs;
        if (loadSlow >= 300) {
          loadSlow = 0;
          if (count >= 150 && resStep < 2 && layers[FRONT].ctx && layers[FRONT].dpr > 1) {
            setRes(resStep + 1);
          } else {
            load *= 0.72;
            if (load < LOAD_MIN) load = LOAD_MIN;
          }
        }
      } else if (loadDt < 19) {
        loadSlow = 0;
        loadFast += dtMs;
        if (loadFast >= 1200) {
          loadFast = 0;
          load /= 0.85;
          if (load > 1) load = 1;
        }
      } else {
        loadSlow = 0;
        loadFast = 0;
      }
    } else if (load < 1) {
      // little on screen: these frames say nothing about the load, so drift back towards full richness
      loadDt = 16.7;
      loadSlow = 0;
      loadFast += dtMs;
      if (loadFast >= 2500) {
        loadFast = 0;
        load /= 0.85;
        if (load > 1) load = 1;
      }
    }
  }

  // ------------------------------------------------------------------ frame loop
  function subscribe(fn) {
    const A = SOL.Anim;
    if (A && typeof A.frame === 'function') return A.frame(fn);
    // SOL.Anim is not loaded (stand-alone use): a private loop with the same contract.
    let alive = true;
    let id = 0;
    let last = 0;
    const raf = root.requestAnimationFrame
      ? function (f) {
          return root.requestAnimationFrame(f);
        }
      : function (f) {
          return setTimeout(function () {
            f(now());
          }, 16);
        };
    function loop(t) {
      if (!alive) return;
      const dt = last ? Math.min(MAX_DT, Math.max(0, t - last)) : 16;
      last = t;
      id = raf(loop);
      fn(dt, t);
    }
    id = raf(loop);
    return function () {
      alive = false;
      if (root.cancelAnimationFrame) root.cancelAnimationFrame(id);
      else clearTimeout(id);
    };
  }

  function wake() {
    if (stopFrame || !inited) return;
    stopFrame = subscribe(frame);
  }

  function sleep() {
    if (!stopFrame) return;
    const stop = stopFrame;
    stopFrame = null;
    stop();
  }

  function clearLayer(L) {
    if (L === layers[BACK]) {
      // the ambient picture is gone too: its next frame repaints everything
      ambFull = true;
      ambRectN = 0;
    }
    if (!L.ctx) return;
    L.ctx.setTransform(1, 0, 0, 1, 0, 0);
    L.ctx.clearRect(0, 0, L.canvas.width, L.canvas.height);
    L.dirty = false;
  }

  /** Erases what the previous frame drew and resets the bounds. */
  function beginLayer(L) {
    const ctx = L.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (L.dirty) {
      const x = Math.floor(L.x0) - 1;
      const y = Math.floor(L.y0) - 1;
      ctx.clearRect(x, y, Math.ceil(L.x1) + 1 - x, Math.ceil(L.y1) + 1 - y);
    }
    L.dirty = false;
    L.x0 = Infinity;
    L.y0 = Infinity;
    L.x1 = -Infinity;
    L.y1 = -Infinity;
  }

  function ringsOn(id) {
    for (let i = 0; i < ringCount; i++) if (rings[i].layer === id) return true;
    return false;
  }

  function renderFront() {
    const L = layers[FRONT];
    if (!L.ctx) return;
    const any = L.n > 0 || ringCount > 0 || textCount > 0 || shimmerCount > 0 || rocketCount > 0;
    if (!any && !L.dirty) return;
    beginLayer(L);
    if (!any) return;
    if (shimmerCount > 0) drawShimmers(L);
    if (L.n > 0) drawParticles(L, FRONT);
    if (rocketCount > 0) drawRockets(L);
    if (ringCount > 0) drawRings(L, FRONT);
    if (textCount > 0) drawTexts(L);
    L.ctx.globalAlpha = 1;
  }

  function renderBack(dtMs) {
    const L = layers[BACK];
    if (!L.ctx) return;
    const ambient = ambAlpha > 0 || ambientActive();
    const busy = L.n > 0 || (ringCount > 0 && ringsOn(BACK));
    if (!ambient) {
      if (!busy && !L.dirty) return;
      beginLayer(L);
      if (L.n > 0) drawParticles(L, BACK);
      if (busy && ringCount > 0) drawRings(L, BACK);
      L.ctx.globalAlpha = 1;
      return;
    }
    // The ambient layer advances at its own slow rate; back particles (if any) still get every frame.
    ambAcc += dtMs;
    const due = ambAcc >= AMB_FRAME_MS || ambFull;
    if (!due && !busy && !L.dirty) return;
    if (due) {
      const dt = ambAcc > 100 ? 100 : ambAcc;
      ambAcc = 0;
      stepAmbient(L, dt);
    }
    paintAmbientBack(L, busy);
  }

  /** Anything alive that draws on (or will soon draw on) the front canvas. */
  function frontBusy() {
    return layers[FRONT].n > 0 || ringCount > 0 || textCount > 0 || shimmerCount > 0 || rocketCount > 0 || emitters.length > 0;
  }

  function hasWork() {
    return (
      count > 0 ||
      ringCount > 0 ||
      textCount > 0 ||
      shimmerCount > 0 ||
      rocketCount > 0 ||
      emitters.length > 0 ||
      ambAlpha > 0 ||
      ambientActive() ||
      layers[FRONT].dirty ||
      layers[BACK].dirty
    );
  }

  function wipe() {
    count = 0;
    layers[FRONT].n = 0;
    layers[BACK].n = 0;
    ringCount = 0;
    textCount = 0;
    shimmerCount = 0;
    rocketCount = 0;
    for (let i = 0; i < emitters.length; i++) emitters[i].dead = true;
    emitters.length = 0;
  }

  function frame(dtMs) {
    if (!inited) {
      sleep();
      return;
    }
    if (isReduced()) {
      // reduced motion was switched on while effects were running
      wipe();
      ambAlpha = 0;
      clearLayer(layers[FRONT]);
      clearLayer(layers[BACK]);
      restoreRes();
      sleep();
      return;
    }
    const t0 = now();
    frameNo++;
    if (!(dtMs >= 0)) dtMs = 0;
    else if (dtMs > MAX_DT) dtMs = MAX_DT;

    govern(dtMs);
    if (emitters.length > 0) stepEmitters(dtMs);
    if (rocketCount > 0) stepRockets(dtMs);
    if (shimmerCount > 0) stepShimmers(dtMs);
    if (ringCount > 0) stepRings(dtMs);
    if (textCount > 0) stepTexts(dtMs);
    if (count > 0) updateParticles(dtMs);

    renderFront();
    renderBack(dtMs);

    statFrame = now() - t0;
    statAvg += (statFrame - statAvg) * 0.05;
    // The front canvas is blank: the moment to go back to full resolution without anybody seeing the switch.
    if (resStep !== 0 && !layers[FRONT].dirty && !frontBusy()) restoreRes();
    if (!hasWork()) sleep();
  }

  // ------------------------------------------------------------------ public API
  /** Reads the canvas' CSS box (a layout read: only on init / resize, never per frame). */
  function measure(L) {
    const canvas = L.canvas;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    L.w = Math.round(rect.width);
    L.h = Math.round(rect.height);
    L.ox = rect.left;
    L.oy = rect.top;
  }

  /** Sizes the backing store for the measured box: CSS size x devicePixelRatio, capped. No layout read. */
  function allocate(L, dprCap) {
    const canvas = L.canvas;
    if (!canvas) return;
    const w = L.w;
    const h = L.h;
    let dpr = root.devicePixelRatio || 1;
    if (!(dpr <= dprCap)) dpr = dprCap; // also catches a NaN devicePixelRatio
    if (dpr < 1) dpr = 1;
    if (w * h * dpr * dpr > MAX_PIXELS) dpr = Math.sqrt(MAX_PIXELS / (w * h));
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw; // resizing clears the canvas
      canvas.height = ph;
      L.dirty = false;
      if (L === layers[BACK]) {
        ambFull = true;
        ambRectN = 0;
      }
    }
    L.dpr = w > 0 ? pw / w : dpr;
  }

  /** Resolution cap of the front canvas right now: the quality setting, lowered while frames are slow. */
  function frontCap() {
    const cap = quality === 'low' ? DPR_LOW : DPR_HIGH;
    const k = resStep === 0 ? 1 : resStep === 1 ? 0.75 : 0.5;
    return cap * k < 1 ? 1 : cap * k;
  }

  /** Changes the front canvas' resolution step (0 full, 1 = x0.75, 2 = x0.5). Clears it: call before drawing. */
  function setRes(step) {
    resStep = step;
    if (step >= resLearned) {
      resLearned = step;
      resLearnedAt = now();
    }
    allocate(layers[FRONT], frontCap());
  }

  /** Back to full resolution (only ever called while the front canvas is empty). */
  function restoreRes() {
    if (resStep === 0) return;
    resStep = 0;
    allocate(layers[FRONT], frontCap());
  }

  function resize() {
    if (!inited) return;
    measure(layers[FRONT]);
    measure(layers[BACK]);
    allocate(layers[FRONT], frontCap());
    // Everything behind the table is soft light (ambient pools and motes, dust, glows): one device pixel per CSS
    // pixel is all it needs, and it makes the always-on ambient layer four to nine times cheaper on a phone.
    allocate(layers[BACK], DPR_BACK);
    const L = layers[FRONT].canvas ? layers[FRONT] : layers[BACK];
    if (L.w > 0 && L.h > 0) {
      const m = Math.sqrt((L.w < L.h ? L.w : L.h) / 800);
      unit = m < 0.72 ? 0.72 : m > 1.2 ? 1.2 : m;
      cullL = L.ox - 90;
      cullR = L.ox + L.w + 90;
      cullB = L.oy + L.h + 70;
    } else {
      cullL = -Infinity;
      cullR = Infinity;
      cullB = Infinity;
    }
    // the canvases were cleared: redraw whatever is alive (and the ambient layer) on the next frame
    if (hasWork()) wake();
  }

  let observer = null;

  function listen() {
    try {
      // per init(): watch the canvases themselves (layout changes that are not window resizes)
      if (observer) observer.disconnect();
      if (typeof root.ResizeObserver === 'function') {
        observer = new root.ResizeObserver(resize);
        if (layers[FRONT].canvas) observer.observe(layers[FRONT].canvas);
        if (layers[BACK].canvas) observer.observe(layers[BACK].canvas);
      }
      if (listening) return;
      listening = true;
      root.addEventListener('resize', resize);
      root.addEventListener('orientationchange', resize);
      if (typeof root.MutationObserver === 'function' && doc && doc.documentElement) {
        new root.MutationObserver(refreshTint).observe(doc.documentElement, {
          attributes: true,
          attributeFilter: ['data-theme'],
        });
      }
      const A = SOL.Anim;
      if (A && typeof A.onChange === 'function') {
        // reduced motion on: the next frame wipes the canvases; off: the ambient layer comes back
        A.onChange(function () {
          if (hasWork()) wake();
        });
      }
    } catch (err) {
      /* observers are conveniences: the effects work without them */
    }
  }

  function context(canvas) {
    try {
      return canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
    } catch (err) {
      return null;
    }
  }

  function init(opts) {
    if (!doc || !opts) return;
    const front = context(opts.front);
    const back = context(opts.back);
    if (!front && !back) return;
    sleep();
    wipe();
    // A second init() while effects are showing: their last frame must not stay painted on the canvases
    // (neither on the ones we are leaving nor on the ones we are taking over).
    clearLayer(layers[FRONT]);
    clearLayer(layers[BACK]);
    layers[FRONT].canvas = front ? opts.front : null;
    layers[FRONT].ctx = front;
    layers[BACK].canvas = back ? opts.back : null;
    layers[BACK].ctx = back;
    clearLayer(layers[FRONT]);
    clearLayer(layers[BACK]);
    resStep = 0;
    inited = true;
    ambReady = false;
    ambAlpha = 0;
    resize();
    listen();
    if (hasWork()) wake();
  }

  function pickKind(name) {
    return name === 'star' ? K_STAR : name === 'suit' ? K_SUIT : name === 'dust' ? K_DUST : K_SPARK;
  }

  function burst(x, y, o) {
    if (!ready()) return;
    o = o || EMPTY;
    x = num(x, 0);
    y = num(y, 0);
    const layer = o.layer === 'back' ? BACK : FRONT;
    if (!layers[layer].ctx) return;
    const kind = pickKind(o.kind);
    let n = num(o.count, 18);
    n = scaled(n < 0 ? 0 : n > cap ? cap : Math.round(n));
    if (n === 0) return;

    let speed;
    let gravity;
    let life;
    let size;
    let drag;
    let palette;
    let sprKind;
    const suit = typeof o.suit === 'number' && o.suit >= 0 && o.suit <= 3 ? o.suit | 0 : -1;
    if (kind === K_STAR) {
      speed = 210; gravity = 40; life = 950; size = 7; drag = 1.8; palette = PAL_STAR; sprKind = S_STAR;
    } else if (kind === K_SUIT) {
      speed = 280; gravity = 640; life = 1150; size = 9; drag = 0.9; sprKind = S_SUIT;
      palette = suit === -1 ? null : suit % 2 === 1 ? PAL_RED : PAL_INK;
    } else if (kind === K_DUST) {
      speed = 130; gravity = -18; life = 800; size = 7; drag = 2.4; palette = PAL_DUST; sprKind = S_DUST;
    } else {
      speed = 320; gravity = 560; life = 700; size = 2.4; drag = 1.6; palette = PAL_SPARK; sprKind = S_GLOW;
    }
    speed = clampTo(num(o.speed, speed * unit), -20000, 20000);
    gravity = clampTo(num(o.gravity, gravity * unit), -50000, 50000);
    life = num(o.life, life);
    size = num(o.size, size * unit);
    if (!(life > 0) || !(size > 0)) return;
    if (life > MAX_LIFE) life = MAX_LIFE;
    if (size > MAX_SIZE) size = MAX_SIZE;
    const angle = num(o.angle, -PI / 2);
    const spread = num(o.spread, TAU);
    const custom = typeof o.colors === 'string' ? o.colors : Array.isArray(o.colors) && o.colors.length ? o.colors : null;
    if (custom) palette = custom;

    // resolve the sprites once per call, not once per particle
    let nSpr = 0;
    if (kind === K_SUIT && suit === -1) {
      // a mix of all four suits, each in its own colour unless colours were given
      for (let s = 0; s < 4; s++) {
        const col = typeof palette === 'string' ? palette : palette ? String(palette[s % palette.length]) : s % 2 === 1 ? RED : INK;
        tmpSpr[nSpr++] = sprite(S_SUIT + s, col);
      }
    } else if (typeof palette === 'string') {
      tmpSpr[nSpr++] = sprite(kind === K_SUIT ? S_SUIT + suit : sprKind, palette);
    } else {
      const m = palette.length < tmpSpr.length ? palette.length : tmpSpr.length;
      for (let c = 0; c < m; c++) tmpSpr[nSpr++] = sprite(kind === K_SUIT ? S_SUIT + suit : sprKind, String(palette[c]));
    }

    for (let k = 0; k < n; k++) {
      const a = angle + (rand() - 0.5) * spread;
      const sp = speed * (kind === K_SUIT ? 0.45 + 0.55 * rand() : 0.3 + 0.7 * rand());
      const jitter = kind === K_DUST ? size * 2.6 : size * 0.8; // dust starts as a loose cloud, not a point
      const i = spawn(
        kind,
        layer,
        x + (rand() - 0.5) * jitter,
        y + (rand() - 0.5) * jitter,
        Math.cos(a) * sp,
        Math.sin(a) * sp,
        life * (0.65 + 0.35 * rand()),
        size * (0.7 + 0.6 * rand()),
        gravity,
        drag,
        tmpSpr[(rand() * nSpr) | 0]
      );
      if (i < 0) break;
      if (kind === K_STAR) {
        prot[i] = rand() * TAU;
        pvrot[i] = (rand() - 0.5) * 3;
        pa[i] = rand() * TAU;
        pb[i] = 7 + rand() * 9;
      } else if (kind === K_SUIT) {
        prot[i] = (rand() - 0.5) * 1.4;
        pvrot[i] = (rand() - 0.5) * 7;
        pa[i] = rand() * TAU;
        pb[i] = (rand() < 0.5 ? -1 : 1) * (3 + rand() * 6);
      }
    }
    wake();
  }

  function ring(x, y, o) {
    if (!ready()) return;
    o = o || EMPTY;
    const layer = o.layer === 'back' ? BACK : FRONT;
    if (!layers[layer].ctx) return;
    const radius = num(o.radius, 60);
    const width = num(o.width, 3);
    const duration = num(o.duration, 500);
    if (!(radius > 0) || !(width > 0) || !(duration > 0)) return;
    addRing(
      num(x, 0),
      num(y, 0),
      typeof o.color === 'string' ? o.color : GOLD,
      radius > 4000 ? 4000 : radius,
      width > MAX_SIZE ? MAX_SIZE : width,
      duration > MAX_LIFE ? MAX_LIFE : duration,
      layer
    );
    wake();
  }

  function trailMote(layer, x, y, size, spr) {
    spawn(K_MOTE, layer, x + (rand() - 0.5) * size * 2, y + (rand() - 0.5) * size * 2, (rand() - 0.5) * 26, (rand() - 0.5) * 26 + 10, 340 + rand() * 300, size * (0.65 + rand() * 0.6), 40, 1.4, spr);
  }

  function trail(x, y, o) {
    if (!ready()) return;
    o = o || EMPTY;
    const layer = o.layer === 'back' ? BACK : FRONT;
    if (!layers[layer].ctx) return;
    const color = typeof o.color === 'string' ? o.color : GOLD;
    const size = clampTo(num(o.size, 2.6), 0.5, 60);
    x = num(x, 0);
    y = num(y, 0);
    const spr = sprite(S_GLOW, color);

    // Where was this flyer on the previous frame? The nearest fresh point within reach, if any.
    let slot = -1;
    let best = 110 * 110;
    let oldest = 0;
    for (let i = 0; i < TRAIL_SLOTS; i++) {
      if (trFrame[i] < trFrame[oldest]) oldest = i;
      // A point recorded during this very frame belongs to another flyer; older than 3 frames is stale.
      const age = frameNo - trFrame[i];
      if (age < 1 || age > 3) continue;
      const dx = x - trX[i];
      const dy = y - trY[i];
      const d = dx * dx + dy * dy;
      if (d < best) {
        best = d;
        slot = i;
      }
    }
    const tick = trailTick++;
    const low = quality === 'low';
    // Trails are decoration: they never take more than 60% of the pool (bursts, confetti and fireworks must
    // still find room) and they thin out while frames are slow.
    const room = count < cap * 0.6;
    if (slot >= 0 && room) {
      // fill the gap: one mote every few px (twice as sparse in 'low'), at most 8 per call
      const dist = Math.sqrt(best);
      const step = ((low ? 2 : 1) * (size * 1.6 + 2)) / load;
      let n = Math.floor(dist / step);
      if (n > 8) n = 8;
      for (let k = 1; k <= n; k++) {
        const f = k / (n + 1);
        trailMote(layer, trX[slot] + (x - trX[slot]) * f, trY[slot] + (y - trY[slot]) * f, size, spr);
      }
    } else if (slot < 0) {
      slot = oldest;
    }
    trX[slot] = x;
    trY[slot] = y;
    trFrame[slot] = frameNo;

    if (count < cap * 0.8 && (!low || (tick & 1) === 0)) trailMote(layer, x, y, size, spr);
    if (room && tick % (low || load < 0.6 ? 8 : 4) === 0) {
      // now and then a twinkle, so the trail sparkles instead of smearing
      const i = spawn(K_STAR, layer, x + (rand() - 0.5) * size * 5, y + (rand() - 0.5) * size * 5, (rand() - 0.5) * 20, (rand() - 0.5) * 20, 420 + rand() * 300, size * (1.1 + rand() * 0.9), 25, 1.2, sprite(S_STAR, color));
      if (i >= 0) {
        prot[i] = rand() * TAU;
        pvrot[i] = (rand() - 0.5) * 3;
        pa[i] = rand() * TAU;
        pb[i] = 9 + rand() * 8;
      }
    }
    wake();
  }

  function floatText(x, y, text, o) {
    if (!ready() || !layers[FRONT].ctx) return;
    if (text === null || text === undefined) return;
    try {
      text = String(text);
    } catch (err) {
      return; // an object whose toString throws: nothing to show
    }
    if (!text) return;
    if (text.length > 80) text = text.slice(0, 80);
    o = o || EMPTY;
    let duration = num(o.duration, 900);
    let size = num(o.size, 22);
    if (!(duration > 0) || !(size > 0)) return;
    if (duration > MAX_LIFE) duration = MAX_LIFE;
    if (size > 300) size = 300;
    if (textCount >= texts.length) {
      // full: drop the one closest to its end
      let best = 0;
      for (let i = 1; i < textCount; i++) if (texts[i].age / texts[i].dur > texts[best].age / texts[best].dur) best = i;
      const last = --textCount;
      const tmp = texts[best];
      texts[best] = texts[last];
      texts[last] = tmp;
    }
    const t = texts[textCount++];
    t.x = num(x, 0);
    t.y = num(y, 0);
    t.text = text;
    t.color = typeof o.color === 'string' ? o.color : GOLD;
    t.size = size;
    t.rise = clampTo(num(o.rise, 46), -4000, 4000);
    t.dur = duration;
    t.age = 0;
    t.font = '800 ' + size + 'px ' + FONT_STACK;
    const ctx = layers[FRONT].ctx;
    ctx.font = t.font;
    t.width = ctx.measureText(text).width;
    wake();
  }

  function noop() {}

  function paletteIndices(colors, fallback) {
    const src = Array.isArray(colors) && colors.length ? colors : typeof colors === 'string' ? [colors] : fallback;
    const out = [];
    for (let i = 0; i < src.length; i++) out.push(colorIndex(String(src[i])));
    return out;
  }

  function confetti(o) {
    if (!ready() || !layers[FRONT].ctx) return noop;
    o = o || EMPTY;
    const L = layers[FRONT];
    const density = clampTo(num(o.density, 1), 0, 10) * (quality === 'low' ? 0.5 : 1);
    const dur = o.duration === Infinity ? Infinity : Math.max(0, num(o.duration, 3500));
    if (!(density > 0) || !(dur > 0)) return noop;
    const origin = o.origin;
    const cannon = origin !== null && typeof origin === 'object';
    const widthFactor = Math.max(0.45, Math.min(2, L.w / 1000));
    const e = {
      confetti: true,
      dead: false,
      age: 0,
      dur: dur,
      acc: 0,
      colors: paletteIndices(o.colors, PAL_CONFETTI),
      cannon: cannon,
      rate: (70 * density * widthFactor) / 1000, // pieces per ms (rain)
      total: Math.round(110 * density), // pieces per shot (cannon)
      x: cannon ? num(origin.x, L.ox + L.w / 2) : 0,
      y: cannon ? num(origin.y, L.oy + L.h) : 0,
      angle: cannon ? num(origin.angle, -PI / 2) : 0,
      spread: cannon ? num(origin.spread, 1.3) : 0,
      power: Math.max(800, Math.min(2600, L.h * 2.2)), // fastest piece climbs roughly 3/4 of the screen
    };
    emitters.push(e);
    wake();
    return function stop() {
      e.dead = true;
    };
  }

  function fireworks(o) {
    if (!ready() || !layers[FRONT].ctx) return noop;
    o = o || EMPTY;
    const intensity = Math.max(0, num(o.intensity, 1));
    const dur = o.duration === Infinity ? Infinity : Math.max(0, num(o.duration, 4500));
    if (!(intensity > 0) || !(dur > 0)) return noop;
    const colors = Array.isArray(o.colors) && o.colors.length ? o.colors.map(String) : PAL_FIREWORK;
    const e = {
      confetti: false,
      dead: false,
      age: 0,
      dur: dur,
      next: 0, // the first shell leaves right away
      gap: (quality === 'low' ? 760 : 520) / Math.min(4, intensity),
      colors: colors,
      power: Math.max(0.75, Math.min(1.3, 0.85 + 0.15 * intensity)),
    };
    emitters.push(e);
    wake();
    return function stop() {
      e.dead = true;
    };
  }

  function shimmer(rect, o) {
    if (!ready() || !layers[FRONT].ctx || !rect) return;
    o = o || EMPTY;
    const w = num(rect.width, 0);
    const h = num(rect.height, 0);
    let duration = num(o.duration, 900);
    if (!(w > 0) || !(h > 0) || !(duration > 0) || w > 20000 || h > 20000) return;
    if (duration > MAX_LIFE) duration = MAX_LIFE;
    if (shimmerCount >= shimmers.length) return;
    const color = typeof o.color === 'string' ? o.color : GOLD;
    const s = shimmers[shimmerCount++];
    s.x = num(rect.x, num(rect.left, 0));
    s.y = num(rect.y, num(rect.top, 0));
    s.w = w;
    s.h = h;
    s.r = clampTo(num(o.radius, Math.min(w, h) * 0.08), 0, Math.min(w, h) * 0.5);
    s.dur = duration;
    s.age = 0;
    s.band = sprite(S_BAND, color);
    s.star = sprite(S_STAR, color);
    s.acc = 0;
    s.rate = scaled(Math.max(8, Math.min(42, Math.round((w * h) / 650)))) / duration;
    wake();
  }

  function ambient(enabled, o) {
    ambWanted = !!enabled;
    if (o && typeof o.theme === 'string') ambThemeHint = o.theme;
    if (!inited) return;
    if (ambWanted) refreshTint();
    if (hasWork()) wake(); // fades in — or out, then the loop goes back to sleep
  }

  function setQuality(q) {
    const next = q === 'low' ? 'low' : 'high';
    if (next === quality) return;
    quality = next;
    cap = next === 'low' ? CAP_LOW : CAP_HIGH;
    if (count > cap) {
      count = cap;
      layers[FRONT].n = 0;
      layers[BACK].n = 0;
      for (let i = 0; i < count; i++) layers[player[i]].n++;
    }
    if (inited) {
      resize(); // the resolution cap changed
      if (hasWork()) wake();
    }
  }

  function clear() {
    if (!inited) return;
    wipe();
    clearLayer(layers[FRONT]);
    clearLayer(layers[BACK]); // the ambient layer (if showing) repaints itself on its next frame
    restoreRes();
    if (hasWork()) wake();
  }

  function stats() {
    return {
      particles: count,
      rings: ringCount,
      texts: textCount,
      shimmers: shimmerCount,
      rockets: rocketCount,
      emitters: emitters.length,
      sprites: sprites.length,
      awake: stopFrame !== null,
      quality: quality,
      cap: cap,
      dpr: layers[FRONT].ctx ? layers[FRONT].dpr : layers[BACK].dpr,
      ambient: ambAlpha,
      load: load,
      resStep: resStep,
      frameMs: statFrame,
      avgFrameMs: statAvg,
    };
  }

  SOL.FX = {
    init: init,
    resize: resize,
    burst: burst,
    ring: ring,
    trail: trail,
    floatText: floatText,
    confetti: confetti,
    fireworks: fireworks,
    shimmer: shimmer,
    ambient: ambient,
    setQuality: setQuality,
    clear: clear,
    count: function () {
      return count;
    },
    stats: stats,
  };
})(typeof window !== 'undefined' ? window : globalThis);
