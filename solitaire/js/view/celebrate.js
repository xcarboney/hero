/*
 * SOL.Celebrate — the win celebration: one continuous, skippable show of about eight seconds, played by the
 * real 52 cards in 3D with SOL.FX on top.
 *
 *   0.0 s  HUSH     the four finished stacks draw breath (the fanfare starts);
 *   0.2 s  ERUPT    the foundations erupt one after the other in suit order — spades, hearts, clubs, diamonds —
 *                   king first: every card shoots up, tumbles and is swept into…
 *   …      VORTEX   …a funnel of cards turning in space: a helix around a vertical axis, cards facing outwards
 *                   (faces in front, real backs behind), seen in perspective from a camera that keeps tilting;
 *   2.9 s  RING     the helix winds down into one ring — a crown of cards — that spins faster and beats twice;
 *   5.2 s  BURST    the ring bursts: the cards fly apart like the stars of a firework shell and hang in the air,
 *                   glittering, while fireworks go up and confetti falls;
 *   6.3 s  HOME     ace first, rank by rank on a rising scale, the cards cascade back onto four neat stacks.
 *   7.8 s  the table is tidy; a last sweep of light crosses the foundations.
 *
 * The whole show is one function of time (one SOL.Anim tween drives a director that computes all 52 poses per
 * frame), so it follows the speed setting, can be cut at any frame, and adapts while it runs:
 *   - STAGE: it plays in whatever part of the screen is free. When the win screen slides up from the bottom
 *     ('game:pause' { reason: 'modal' }) the show glides into the space above it; when it closes, back.
 *   - a re-layout (rotation, resize) moves the stage and the foundations under it.
 * Cost: transforms only. The cards themselves are rotated (rx / ry / rot / scale on .card — no --flip, no
 * --lift, no shadows), z-order is re-sorted a few times a second instead of every frame, and cards buried in
 * the stacks stay unrendered until they launch and are covered again as the stacks rebuild.
 *
 * Public API
 *   Celebrate.play(result?) -> Promise<boolean>   starts the show (while it runs the same promise is returned).
 *                                                 Resolves true when it ran to the end, false when it was
 *                                                 skipped / stopped; the cards are home (or, after a skip, on
 *                                                 their way home) when it resolves. `result` is the 'game:won'
 *                                                 payload (unused). Does nothing (resolves false) unless all
 *                                                 52 cards lie on the foundations.
 *   Celebrate.skip()                              the player tapped: straight to the tidy end state (the
 *                                                 cards fly home in a third of a second)
 *   Celebrate.stop()                              no homecoming at all: releases the cards where they are (the
 *                                                 caller is about to re-deal or re-render)
 *   Celebrate.isPlaying() -> boolean
 *   Celebrate.DURATION                            length of the show in ms at speed 1
 *   Celebrate.TIMELINE                            the beats (ms at speed 1; mutable, for tuning)
 * Emits 'celebrate:start' {} and 'celebrate:end' { skipped } on SOL.Bus, and sets .is-celebrating on #app while
 * it runs (base.css lifts the table above the HUD and toolbar so the cards can fly over them).
 *
 * Reduced motion: a calm version — the chime, a haptic and a gold crown on the four stacks for about a second.
 * Lite mode (SOL.Board.isLite(): a struggling device or effects 'low'): no trails, far fewer particles.
 *
 * Needs SOL.Board and SOL.Anim. SOL.FX, SOL.Audio, SOL.Haptics, SOL.Bus and SOL.Game are optional.
 */
(function (root) {
  'use strict';

  const SOL = (root.SOL = root.SOL || {});
  const doc = root.document;
  const PI = Math.PI;
  const TAU = PI * 2;
  const DEG = 180 / PI;
  const GOLD = '#f3c969';
  const SUIT_GLOW = ['#dfe8ff', '#ff6b81', '#dfe8ff', '#ff6b81'];
  const FOUNDATIONS = ['f0', 'f1', 'f2', 'f3'];
  const CALM_MS = 1300;

  /** The beats, in ms at animation speed 1. */
  const T = {
    hush: 200, // the stacks draw breath
    suitGap: 150, // between two eruptions
    cardGap: 26, // between two cards of one eruption
    launchMs: 640, // one card's way into the vortex
    unwind: 2900, // the helix starts winding down…
    ring: 3900, // …and is a ring
    pulse1: 4250, // the ring beats
    pulse2: 4700,
    pulseMs: 240,
    burst: 5180, // …and bursts
    burstMs: 560,
    home: 6200, // the first aces leave for home
    homeGap: 74, // between two ranks
    homeMs: 430, // one card's way home
    tail: 240, // after the last landing
  };

  function duration() {
    return T.home + 12 * T.homeGap + 36 + T.homeMs + T.tail;
  }

  let playing = false;
  let token = 0;
  let current = null; // the promise of the running show
  let finish = null; // resolves it
  let stops = []; // FX emitters to stop
  let timeline = null; // the tween that drives the show
  let show = null; // per-show state, see play()
  let calmTimer = 0;
  let offs = []; // bus subscriptions of the running show

  // ------------------------------------------------------------------ small helpers
  function sfx(name, opts) {
    try {
      if (SOL.Audio) SOL.Audio.play(name, opts);
    } catch (err) {
      /* ignore */
    }
  }
  function note(rank, opts) {
    try {
      if (SOL.Audio) SOL.Audio.playFoundation(rank, opts);
    } catch (err) {
      /* ignore */
    }
  }
  function haptic(kind) {
    try {
      if (!SOL.Haptics) return;
      // Before the first tap a browser refuses to vibrate and logs an intervention for every attempt.
      // The native shell has no such rule.
      const ua = root.navigator && root.navigator.userActivation;
      if (ua && !ua.hasBeenActive && !(SOL.Platform && SOL.Platform.isNativeApp)) return;
      SOL.Haptics.play(kind);
    } catch (err) {
      /* ignore */
    }
  }
  function fx() {
    return SOL.FX && SOL.Anim && !SOL.Anim.reduced ? SOL.FX : null;
  }
  function appEl() {
    return doc ? doc.getElementById('app') : null;
  }
  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }
  function outCubic(t) {
    const u = 1 - t;
    return 1 - u * u * u;
  }
  function outQuart(t) {
    const u = 1 - t;
    return 1 - u * u * u * u;
  }
  function inCubic(t) {
    return t * t * t;
  }
  function inOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }
  function inOutSine(t) {
    return -(Math.cos(PI * t) - 1) * 0.5;
  }
  function wrap180(a) {
    a = a % 360;
    if (a > 180) a -= 360;
    else if (a <= -180) a += 360;
    return a;
  }
  function stopEmitters() {
    for (let i = 0; i < stops.length; i++) {
      try {
        stops[i]();
      } catch (err) {
        /* ignore */
      }
    }
    stops = [];
  }

  function crown(on) {
    const B = SOL.Board;
    if (!B || !B.ready) return;
    for (let i = 0; i < 4; i++) {
      const el = B.pileEl(FOUNDATIONS[i]);
      if (el) el.classList.toggle('is-crowned', on);
    }
  }

  /** Ends the show state and resolves the promise. */
  function end(completed) {
    if (!playing) return;
    playing = false;
    stopEmitters();
    if (timeline) {
      const h = timeline;
      timeline = null;
      h.cancel();
    }
    if (calmTimer) {
      root.clearTimeout(calmTimer);
      calmTimer = 0;
      crown(false);
    }
    for (let i = 0; i < offs.length; i++) offs[i]();
    offs = [];
    show = null;
    const app = appEl();
    if (app) app.classList.remove('is-celebrating');
    if (SOL.Bus) SOL.Bus.emit('celebrate:end', { skipped: !completed });
    const resolve = finish;
    finish = null;
    current = null;
    if (resolve) resolve(completed);
  }

  // ------------------------------------------------------------------ the stage
  /**
   * Top edge (viewport px) of a sheet docked to the bottom of the screen — the win screen on phones — or null.
   * One layout read, made when a dialog opens (never inside the frame loop); offsets, not client rects, so a
   * sheet that is still sliding in is measured where it will come to rest.
   */
  function measureSheet() {
    try {
      const host = doc.getElementById('overlay-root');
      if (!host) return null;
      const all = host.querySelectorAll('[aria-modal="true"]');
      const sheet = all.length ? all[all.length - 1] : null;
      if (!sheet) return null;
      let top = 0;
      let el = sheet;
      while (el && el !== doc.body && el !== doc.documentElement) {
        top += el.offsetTop;
        el = el.offsetParent;
      }
      const h = sheet.offsetHeight;
      const vh = root.innerHeight;
      if (h > 0 && top + h >= vh - 3 && top > vh * 0.2 && sheet.offsetWidth >= root.innerWidth * 0.7) return top;
      return null;
    } catch (err) {
      return null;
    }
  }

  /** Recomputes the stage the show should play in (table space) from the layout, the viewport and the sheet. */
  function aimStage(sh) {
    const L = sh.L;
    const left = -L.left + 3;
    const right = sh.vw - L.left - 3;
    const top = -L.top + 4;
    let bottom = sh.vh - L.top - 4;
    if (sh.sheetTop !== null) bottom = Math.min(bottom, sh.sheetTop - L.top + L.cardH * 0.12);
    bottom = Math.max(bottom, top + L.cardH * 2.6);
    sh.aim.cx = (left + right) / 2;
    sh.aim.cy = (top + bottom) / 2;
    sh.aim.a = (right - left) / 2;
    sh.aim.b = (bottom - top) / 2;
  }

  // ------------------------------------------------------------------ play
  function play() {
    if (playing && current) return current;
    const B = SOL.Board;
    const A = SOL.Anim;
    const G = SOL.Game;
    if (!B || !B.ready || !A) return Promise.resolve(false);
    const L0 = B.layout();
    if (!L0 || B.isDeckMode()) return Promise.resolve(false);
    // the show is written for a finished game: every card on its foundation
    const cards = B.sprites;
    for (let i = 0; i < 52; i++) {
      const s = cards[i];
      if (!s || s.pile !== 'f' + Math.floor(i / 13) || s.index !== i % 13) return Promise.resolve(false);
    }

    const my = ++token;
    playing = true;
    current = new Promise(function (resolve) {
      finish = resolve;
    });
    if (SOL.Bus) SOL.Bus.emit('celebrate:start', {});
    sfx('win');
    haptic('win');

    if (A.reduced) {
      // ---- the calm version: no motion at all — the chime, and a gold crown on the four stacks
      crown(true);
      calmTimer = root.setTimeout(function () {
        if (my !== token) return;
        calmTimer = 0;
        crown(false);
        end(true);
      }, CALM_MS);
      return current;
    }

    const app = appEl();
    if (app) app.classList.add('is-celebrating');
    const lite = !!(B.isLite && B.isLite());
    const showZ = B.TUNE.showZ;
    const total = duration();

    const sh = (show = {
      L: L0,
      vw: root.innerWidth,
      vh: root.innerHeight,
      sheetTop: null,
      measure: 0, // frames until the sheet is measured (0 = nothing pending)
      measureAgain: 0,
      st: { cx: 0, cy: 0, a: 0, b: 0 },
      aim: { cx: 0, cy: 0, a: 0, b: 0 },
      last: 0,
      frame: 0,
      phase: new Uint8Array(52), // 0 waiting, 1 launching, 2 in the vortex / ring, 3 burst, 4 homing, 5 home
      from: [], // pose at the start of the current phase
      burst: [], // per card: where the burst takes it
      depth: new Float32Array(52),
      order: [],
      fired: Object.create(null),
      landed: 0,
    });
    aimStage(sh);
    sh.st.cx = sh.aim.cx;
    sh.st.cy = sh.aim.cy;
    sh.st.a = sh.aim.a;
    sh.st.b = sh.aim.b;
    for (let i = 0; i < 52; i++) {
      const s = cards[i];
      s.stop();
      s.held = 'show';
      s.soft = false;
      sh.from.push({ x: s.x + s.ox, y: s.y + s.oy, rot: wrap180(s.rot), rx: wrap180(s.rx), ry: wrap180(s.ry), scale: s.scale });
      s.x += s.ox;
      s.y += s.oy;
      s.ox = 0;
      s.oy = 0;
      s.lift = 0;
      s.flip = 0;
      sh.burst.push(null);
      sh.order.push(i);
    }
    if (G && typeof G.isPaused === 'function' && G.isPaused()) sh.measure = 1;
    if (SOL.Bus) {
      offs.push(
        SOL.Bus.on('game:pause', function (e) {
          if (!show || !e || e.reason !== 'modal') return;
          if (e.paused) {
            // measured on the next frames: the sheet may still be on its way into the document
            show.measure = 1;
            show.measureAgain = 20;
          } else {
            show.sheetTop = null;
            show.measure = 0;
            show.measureAgain = 0;
            aimStage(show);
          }
        })
      );
      offs.push(
        SOL.Bus.on('board:layout', function (layout) {
          if (!show || !layout) return;
          show.L = layout;
          show.vw = root.innerWidth;
          show.vh = root.innerHeight;
          if (show.sheetTop !== null) show.measure = 2;
          aimStage(show);
        })
      );
    }

    function beat(name) {
      if (sh.fired[name]) return false;
      sh.fired[name] = true;
      return true;
    }

    /** Client-space point of a table-space point. */
    function cx(x) {
      return sh.L.left + x;
    }
    function cy(y) {
      return sh.L.top + y;
    }

    /**
     * The director: all 52 poses at time t (ms on the show clock). Everything is derived from t, the live
     * stage and each card's slot (suit * 13 + (13 - rank): the kings lead their suits).
     */
    function direct(t, dt) {
      const L = sh.L;
      const cw = L.cardW;
      const ch = L.cardH;
      const f = fx();
      sh.frame++;

      // ---- the stage follows its target
      if (sh.measure > 0 && --sh.measure === 0) {
        sh.sheetTop = measureSheet();
        aimStage(sh);
      }
      if (sh.measureAgain > 0 && --sh.measureAgain === 0) {
        sh.sheetTop = measureSheet();
        aimStage(sh);
      }
      const follow = 1 - Math.exp(-Math.min(dt, 60) / 230);
      const st = sh.st;
      st.cx += (sh.aim.cx - st.cx) * follow;
      st.cy += (sh.aim.cy - st.cy) * follow;
      st.a += (sh.aim.a - st.a) * follow;
      st.b += (sh.aim.b - st.b) * follow;

      // ---- the shape of the vortex right now
      const focal = clamp(cw * 12, 800, 1800); // the same perspective as #cards (board.css)
      const R0 = Math.max(cw * 1.5, Math.min(st.a - cw * 0.6, cw * 3.5));
      // (height budget: the tilted rings reach R * sin(tilt) above and below the axis ends, plus a card)
      const Hh = Math.max(ch * 1.2, Math.min(st.b * 2 - ch * 1.25 - R0 * 0.8, ch * 4.6));
      const Rring = Math.max(cw * 1.5, Math.min(st.a - cw * 0.66, st.b * 1.5, cw * 3.3));
      const w = inOutCubic(clamp((t - T.unwind) / (T.ring - T.unwind), 0, 1)); // 0 helix … 1 ring
      const turns = lerp(2.35, 51 / 52, w);
      const tsec = t / 1000;
      const spin = 1.5 * tsec + 0.27 * tsec * tsec; // rad: it keeps accelerating
      const tilt = lerp(0.3 + 0.16 * Math.sin(tsec * 1.7), 0.62, w); // rad: the camera keeps moving
      const sinT = Math.sin(tilt);
      const cosT = Math.cos(tilt);
      let pulse = 1;
      const p1 = (t - T.pulse1) / T.pulseMs;
      const p2 = (t - T.pulse2) / T.pulseMs;
      if (p1 > 0 && p1 < 1) pulse -= 0.2 * Math.sin(PI * p1);
      if (p2 > 0 && p2 < 1) pulse -= 0.24 * Math.sin(PI * p2);
      const squeeze = clamp((t - (T.burst - 190)) / 190, 0, 1);
      pulse *= 1 - 0.42 * inCubic(squeeze); // the breath before the burst
      const vScale = lerp(0.9, 0.84, w);

      // ---- beats that are not tied to one card
      if (t >= T.pulse1 && beat('p1')) ringBeat(f, st, Rring, 0);
      if (t >= T.pulse2 && beat('p2')) ringBeat(f, st, Rring, 1);
      if (t >= T.burst && beat('burst')) burstBeat(f, st, cw);
      if (t >= total - T.tail && beat('tidy')) tidyBeat(f, L);

      let sortNeeded = false;
      for (let id = 0; id < 52; id++) {
        const s = cards[id];
        const suit = (id / 13) | 0;
        const rank = (id % 13) + 1;
        const k = suit * 13 + (13 - rank);
        const launch = T.hush + suit * T.suitGap + (13 - rank) * T.cardGap;
        let ph = sh.phase[id];

        // ---- waiting on the foundation: the stacks draw breath
        if (ph === 0) {
          if (t < launch) {
            if (!s.covered) {
              const q = clamp(t / 140, 0, 1);
              const fr = sh.from[id];
              const breath = Math.sin(PI * clamp(t / T.hush, 0, 1));
              s.x = lerp(fr.x, s.tx, q);
              s.y = lerp(fr.y, s.ty, q) + ch * 0.03 * breath;
              s.rot = fr.rot * (1 - q);
              s.rx = fr.rx * (1 - q);
              s.ry = fr.ry * (1 - q);
              s.scale = lerp(fr.scale, 1, q) - 0.07 * breath;
              B.touch(s);
            }
            continue;
          }
          // ---- launch
          ph = sh.phase[id] = 1;
          s.cover(false);
          s.z = showZ + 100 + k;
          const fr = sh.from[id];
          fr.x = s.tx;
          fr.y = s.ty;
          fr.th0 = (spin + turns * TAU * (k / 51)) * DEG; // the slot's angle at launch
          if (rank === 13) eruptBeat(f, s, suit, cw, ch);
        }

        // ---- the slot in the vortex / ring (also the target of a launch)
        let x = 0;
        let y = 0;
        let sc = 1;
        let rx = 0;
        let ry = 0;
        let rot = 0;
        if (ph <= 2) {
          const u = 1 - k / 51;
          const th = spin + turns * TAU * (k / 51);
          const R = lerp(R0 * (0.46 + 0.54 * u), Rring, w) * (w > 0 ? lerp(1, pulse, w) : 1);
          const X = R * Math.sin(th);
          const Z = R * Math.cos(th);
          const Y = (0.5 - u) * Hh * (1 - w);
          const Yt = Y * cosT + Z * sinT;
          const Zt = -Y * sinT + Z * cosT;
          const persp = focal / (focal - Zt);
          x = st.cx + X * persp - cw / 2;
          y = st.cy + Yt * persp - ch / 2;
          sc = persp * vScale;
          rx = -tilt * DEG;
          ry = th * DEG;
          sh.depth[id] = Zt;

          if (ph === 1) {
            const p = clamp((t - launch) / T.launchMs, 0, 1);
            const fr = sh.from[id];
            const e = outCubic(p);
            const bell = 4 * p * (1 - p);
            const sideways = (k % 2 ? 1 : -1) * cw * 0.55;
            const fx0 = fr.x;
            const fy0 = fr.y;
            x = lerp(fx0, x, e) + sideways * bell * (1 - p);
            y = lerp(fy0, y, e) - ch * 1.05 * bell * (1 - p * 0.6);
            sc = lerp(1, sc, e) + 0.3 * bell;
            rx = rx * e;
            // winds up into the turning frame: starts flat (0), ends on the slot's own angle
            ry = ry - fr.th0 + wrap180(fr.th0) * e;
            rot = (k % 2 ? -1 : 1) * 38 * bell * (1 - p);
            if (f && !lite && k % 3 === 0 && p < 0.9) {
              f.trail(cx(x + cw / 2), cy(y + ch / 2), { color: k % 2 ? GOLD : SUIT_GLOW[suit], size: clamp(cw * 0.05, 2, 5) });
            }
            if (p >= 1) {
              sh.phase[id] = 2;
              sortNeeded = true;
            }
          } else if (t >= T.burst) {
            // ---- the ring bursts into a bloom: three counter-turning rings of cards, tops pointing outwards
            sh.phase[id] = ph = 3;
            const ring = rank <= 2 ? 0 : rank <= 6 ? 1 : 2;
            const n = ring === 0 ? 8 : ring === 1 ? 16 : 28;
            const j = (rank - (ring === 0 ? 1 : ring === 1 ? 3 : 7)) * 4 + suit;
            const ryNow = wrap180(ry);
            sh.from[id] = { x: x, y: y, rot: 0, rx: rx, ry: ryNow, scale: sc };
            sh.burst[id] = {
              ring: ring,
              a0: (j / n) * TAU - PI / 2 + (ring === 1 ? PI / n : 0),
              // one and a bit turns about its own axis on the way out, ending face to the player
              ry: 360 * Math.round((ryNow + (k % 2 ? 1 : -1) * 430) / 360),
              rot0: null,
            };
            s.z = showZ + ring * 40 + j;
          }
        }

        if (ph === 3) {
          // ---- flung outwards, then hanging in the air
          const b = sh.burst[id];
          const fr = sh.from[id];
          const homeAt = T.home + (rank - 1) * T.homeGap + suit * 12;
          if (t >= homeAt) {
            // ---- time to go home: remember where the card is
            sh.phase[id] = ph = 4;
            sh.from[id] = { x: s.x, y: s.y, rot: wrap180(s.rot), rx: wrap180(s.rx), ry: wrap180(s.ry), scale: s.scale, at: homeAt };
            s.z = showZ + 200 + rank * 4 + suit;
          } else {
            const p = clamp((t - T.burst) / T.burstMs, 0, 1);
            const e = outQuart(p);
            const hang = Math.max(0, t - T.burst) / 1000;
            // the bloom: radii and card sizes from the free stage, so it fills a phone and a desktop alike
            const M = Math.min(st.a, st.b);
            const ring = b.ring;
            const r = M * (ring === 0 ? 0.29 : ring === 1 ? 0.56 : 0.84) * (1 + 0.035 * Math.sin(hang * 4.2 + ring * 1.3));
            const size =
              ring === 0
                ? Math.min(0.9, (M * 0.24) / ch)
                : clamp(((TAU * r) / (ring === 1 ? 16 : 28)) * (ring === 1 ? 1.05 : 1.22) / cw, 0.45, 1.3);
            const ang = b.a0 + (ring === 1 ? -1 : 1) * (0.5 * hang * (1 - 0.25 * hang)) * (ring === 0 ? 1.6 : 1);
            const seatX = st.cx + Math.cos(ang) * r - cw / 2;
            const seatY = st.cy + Math.sin(ang) * r - ch / 2;
            const seatRot = ang * DEG + 90;
            if (b.rot0 === null) b.rot0 = seatRot - wrap180(seatRot); // keeps the turn into the seat the short way round
            x = lerp(fr.x, seatX, e);
            y = lerp(fr.y, seatY, e);
            sc = lerp(fr.scale, size, e);
            rot = lerp(0, seatRot - b.rot0, e);
            // glitter: every card rocks a little on its own
            rx = lerp(fr.rx, 0, e) + 11 * Math.sin(hang * 6.1 + k * 1.3) * e;
            ry = lerp(fr.ry, b.ry, e) + 16 * Math.sin(hang * 4.7 + k * 0.7) * e;
          }
        }

        if (ph === 4) {
          // ---- the cascade home
          const fr = sh.from[id];
          const p = clamp((t - fr.at) / T.homeMs, 0, 1);
          if (p >= 1) {
            sh.phase[id] = 5;
            s.x = s.tx;
            s.y = s.ty;
            s.rot = 0;
            s.rx = 0;
            s.ry = 0;
            s.scale = 1;
            s.z = s.tz;
            B.touch(s);
            sh.landed++;
            landBeat(f, s, suit, rank, cw, ch);
            // the stack below is hidden again (the board keeps the top two of a foundation rendered)
            if (rank > 2) cards[id - 2].cover(true);
            continue;
          }
          const e = inOutCubic(p);
          const bell = 4 * e * (1 - e);
          x = lerp(fr.x, s.tx, e);
          y = lerp(fr.y, s.ty, e) - ch * 0.5 * bell;
          sc = lerp(fr.scale, 1, e) + 0.12 * bell;
          rot = fr.rot * (1 - e);
          rx = fr.rx * (1 - e);
          ry = fr.ry * (1 - e);
        } else if (ph === 5) {
          continue;
        }

        s.x = x;
        s.y = y;
        s.scale = sc;
        s.rot = rot;
        s.rx = rx;
        s.ry = ry;
        B.touch(s);
      }

      // ---- depth order in the vortex: every few frames (a z-index change costs far more than a transform)
      if (t < T.burst && (sortNeeded || sh.frame % (lite ? 6 : 4) === 0)) {
        const order = sh.order;
        const depth = sh.depth;
        order.sort(function (a, b) {
          return depth[a] - depth[b];
        });
        for (let i = 0; i < 52; i++) {
          const id = order[i];
          if (sh.phase[id] === 2) cards[id].z = showZ + i;
        }
      }
    }

    function eruptBeat(f, s, suit, cw, ch) {
      sfx('whoosh', { pitch: 0.82 + suit * 0.12, volume: 0.8, duration: 520 });
      haptic(suit === 0 ? 'heavy' : 'thud');
      B.pulse(s.pile, SUIT_GLOW[suit]);
      if (!f) return;
      const x = cx(s.tx + cw / 2);
      const y = cy(s.ty + ch / 2);
      f.ring(x, y, { color: SUIT_GLOW[suit], radius: cw * 1.5, width: Math.max(2, cw * 0.05), duration: 520 });
      f.burst(x, y, { kind: 'suit', suit: suit, count: lite ? 6 : 14, size: clamp(cw * 0.12, 5, 14), speed: cw * 6, gravity: cw * 9, spread: PI * 0.9 });
      f.burst(x, y, { kind: 'spark', count: lite ? 8 : 20, speed: cw * 7, size: clamp(cw * 0.04, 1.6, 3.4), gravity: cw * 8, spread: PI * 0.8 });
    }

    function ringBeat(f, st, R, n) {
      haptic('heavy');
      sfx('place', { pitch: n ? 0.8 : 0.7, volume: 1.1 });
      if (!f) return;
      f.ring(cx(st.cx), cy(st.cy), { color: GOLD, radius: R * (1.25 + n * 0.2), width: Math.max(2, R * 0.03), duration: 520 });
      if (!lite) f.burst(cx(st.cx), cy(st.cy), { kind: 'star', count: 10, speed: R * 1.6, size: clamp(R * 0.05, 4, 10) });
    }

    function burstBeat(f, st, cw) {
      haptic('win');
      sfx('whoosh', { pitch: 0.7, volume: 1.1, duration: 640 });
      sfx('autocomplete', { volume: 0.8 });
      if (!f) return;
      const x = cx(st.cx);
      const y = cy(st.cy);
      const reach = Math.min(st.a, st.b);
      f.ring(x, y, { color: '#ffffff', radius: reach * 1.5, width: Math.max(3, cw * 0.08), duration: 620 });
      f.ring(x, y, { color: GOLD, radius: reach * 1.1, width: Math.max(2, cw * 0.05), duration: 760 });
      f.burst(x, y, { kind: 'spark', count: lite ? 20 : 46, speed: reach * 3.4, size: clamp(cw * 0.05, 2, 4), gravity: cw * 3 });
      f.burst(x, y, { kind: 'star', count: lite ? 10 : 24, speed: reach * 2.2, size: clamp(cw * 0.12, 5, 12) });
      stops.push(f.fireworks({ duration: 1700, intensity: lite ? 0.5 : 1 }));
      stops.push(f.confetti({ duration: 2300, density: lite ? 0.4 : 0.85 }));
    }

    function landBeat(f, s, suit, rank, cw, ch) {
      B.pulse(s.pile, SUIT_GLOW[suit]);
      if (suit === 0) {
        // one note per rank: thirteen steps up the scale, the kings land on the tonic
        note(rank, { volume: 0.75 });
        haptic(rank === 13 ? 'success' : 'tick');
      }
      if (f && !lite && (rank === 13 || (rank + suit) % 3 === 0)) {
        f.burst(cx(s.tx + cw / 2), cy(s.ty + ch / 2), {
          kind: 'spark',
          count: rank === 13 ? 12 : 4,
          speed: cw * 4,
          size: clamp(cw * 0.035, 1.6, 3),
          gravity: cw * 7,
        });
      }
    }

    function tidyBeat(f, L) {
      sfx('place', { volume: 0.9 });
      if (!f) return;
      for (let i = 0; i < 4; i++) {
        const p = L.piles[FOUNDATIONS[i]];
        f.shimmer({ x: cx(p.x), y: cy(p.y), width: L.cardW, height: L.cardH }, { radius: L.cardW * 0.075, duration: 700 });
      }
    }

    timeline = A.tween({
      duration: total,
      ease: 'linear',
      update: function (e) {
        if (my !== token || !show) return;
        const t = e * total;
        const dt = Math.max(0, t - sh.last);
        sh.last = t;
        direct(t, dt);
      },
      done: function () {
        if (my !== token) return;
        timeline = null;
        // every card is home: hand them back exactly on their places
        B.release('show', { how: 'instant' });
        B.flush();
        end(true);
      },
    });

    return current;
  }

  /** Gives the cards back to the board. `home`: they fly to their places; otherwise they stay where they are. */
  function handBack(home) {
    const B = SOL.Board;
    if (!B || !B.ready) return;
    if (home) {
      const L = B.layout();
      B.release('show', {
        how: 'fly',
        stagger: 3,
        duration: 330,
        arc: L ? L.cardH * 0.25 : 0,
        peakLift: 0,
        peakScale: 0.03,
        spin: 0,
        overshoot: 0,
      });
      return;
    }
    const all = B.sprites;
    for (let i = 0; i < all.length; i++) {
      if (all[i].held === 'show') {
        all[i].held = null;
        all[i].soft = false;
      }
    }
    B.sync('glide'); // whatever the caller does next starts from a consistent table
  }

  /** The player tapped: straight to the tidy end state. */
  function skip() {
    if (!playing) return;
    token++;
    stopEmitters();
    if (timeline) {
      const h = timeline;
      timeline = null;
      h.cancel();
      handBack(true);
      sfx('whoosh', { volume: 0.6, duration: 300 });
      haptic('tap');
    }
    end(false);
  }

  /** Stops without sending the cards anywhere (the caller re-renders or re-deals right away). */
  function stop() {
    if (!playing) return;
    token++;
    stopEmitters();
    if (timeline) {
      const h = timeline;
      timeline = null;
      h.cancel();
      handBack(false);
    }
    try {
      if (SOL.FX) SOL.FX.clear();
    } catch (err) {
      /* ignore */
    }
    end(false);
  }

  SOL.Celebrate = {
    play: play,
    skip: skip,
    stop: stop,
    isPlaying: function () {
      return playing;
    },
    get DURATION() {
      return duration();
    },
    TIMELINE: T,
  };
})(typeof window !== 'undefined' ? window : globalThis);
