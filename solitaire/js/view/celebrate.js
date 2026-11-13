/*
 * SOL.Celebrate — the win celebration. First version: a clean, skippable three-act show built entirely on the
 * board's sprite API, meant to be replaced / elevated act by act.
 *
 *   act 1  ERUPT    the four foundations empty themselves, king first: every card launches along a high arc
 *                   into one big ring around the table, with sparks at the launch pad;
 *   act 2  WHEEL    the ring turns one and a quarter times while it breathes, a wave of flips runs around it,
 *                   fireworks go up and confetti falls;
 *   act 3  HOME     the cards stream back onto their foundations, ace first.
 *
 * Public API
 *   Celebrate.play(result?) -> Promise<boolean>   starts the show (once: while it runs the same promise is
 *                                                 returned). Resolves true when it ran to the end, false when
 *                                                 it was skipped / stopped. The cards are on their way home
 *                                                 (or home) when it resolves. `result` is the 'game:won'
 *                                                 payload (unused by this version).
 *   Celebrate.skip()                              the player tapped: straight to act 3, fast
 *   Celebrate.stop()                              no act 3 at all: releases the cards where they are (the
 *                                                 caller is about to re-deal or re-render)
 *   Celebrate.isPlaying() -> boolean
 * Emits 'celebrate:start' {} and 'celebrate:end' { skipped } on SOL.Bus, and sets .is-celebrating on #app while
 * it runs (base.css lifts the table above the HUD and toolbar so the cards can fly over them).
 *
 * How it drives the cards (the seam for the animation director):
 *   const cards = SOL.Board.hold(null, 'show')     // all 52 sprites; the layout leaves held sprites alone
 *   sprite.fly({ x, y, rot, scale, … })            // explicit destinations, see board.js "SPRITES"
 *   sprite.x = …; sprite.rot = …; SOL.Board.touch(sprite)      // or write values directly, once per frame
 *   SOL.Board.release('show', { how: 'fly', stagger, … })      // everything flies back to its logical place
 * All timing goes through SOL.Anim (speed setting, reduced motion). Under reduced motion there is no show:
 * a chime, a haptic, and the promise resolves at once.
 */
(function (root) {
  'use strict';

  const SOL = (root.SOL = root.SOL || {});
  const doc = root.document;
  const PI = Math.PI;
  const TAU = PI * 2;

  let playing = false;
  let token = 0;
  let current = null; // the promise of the running show
  let finish = null; // resolves it
  let stops = []; // FX emitters to stop
  let handles = []; // tweens to cancel

  function sfx(name, opts) {
    try {
      if (SOL.Audio) SOL.Audio.play(name, opts);
    } catch (err) {
      /* ignore */
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
  function appEl() {
    return doc ? doc.getElementById('app') : null;
  }

  function cleanupEffects() {
    for (let i = 0; i < stops.length; i++) {
      try {
        stops[i]();
      } catch (err) {
        /* ignore */
      }
    }
    stops = [];
    for (let i = 0; i < handles.length; i++) handles[i].cancel();
    handles = [];
  }

  /** Ends the show state and resolves the promise. */
  function end(completed) {
    if (!playing) return;
    playing = false;
    cleanupEffects();
    const app = appEl();
    if (app) app.classList.remove('is-celebrating');
    if (SOL.Bus) SOL.Bus.emit('celebrate:end', { skipped: !completed });
    const resolve = finish;
    finish = null;
    current = null;
    if (resolve) resolve(completed);
  }

  function play() {
    if (playing && current) return current;
    const B = SOL.Board;
    const A = SOL.Anim;
    if (!B || !B.ready || !A) return Promise.resolve(false);

    sfx('win');
    haptic('win');
    if (A.reduced) return Promise.resolve(true); // no motion: the chime is the celebration

    const L = B.layout();
    if (!L) return Promise.resolve(false);
    const my = ++token;
    playing = true;
    current = new Promise(function (resolve) {
      finish = resolve;
    });
    const app = appEl();
    if (app) app.classList.add('is-celebrating');
    if (SOL.Bus) SOL.Bus.emit('celebrate:start', {});

    const cards = B.hold(null, 'show');
    const FX = SOL.FX;
    const cw = L.cardW;
    const ch = L.cardH;

    // ---- the ring: 52 seats around the middle of the table
    const cx = L.w / 2 - cw / 2;
    const cy = L.h / 2 - ch / 2;
    const rx = Math.max(cw * 1.4, Math.min(L.w / 2 - cw / 2 - 4, cw * 6.5));
    const ry = Math.max(ch * 0.9, Math.min((L.h - ch) / 2 - 4, rx * 1.12));
    // launch order: kings first (they are on top), suit by suit around the ring
    const order = [];
    for (let rank = 13; rank >= 1; rank--) for (let suit = 0; suit < 4; suit++) order.push(suit * 13 + rank - 1);
    const seat = new Array(52);
    for (let k = 0; k < 52; k++) seat[order[k]] = k;

    function seatPos(k, turn, breathe) {
      const a = (k / 52) * TAU - PI / 2 + turn;
      return {
        x: cx + Math.cos(a) * rx * breathe,
        y: cy + Math.sin(a) * ry * breathe,
        rot: ((a + PI / 2) * 180) / PI,
      };
    }

    // ---- act 1: erupt
    const launchGap = 30;
    const launchMs = 640;
    const flights = [];
    for (let k = 0; k < 52; k++) {
      const s = B.sprite(order[k]);
      const p = seatPos(k, 0, 1);
      const rot = ((p.rot + 180) % 360) - 180; // shortest way round
      flights.push(
        s.fly({
          x: p.x,
          y: p.y,
          rot: rot,
          scale: 1,
          duration: launchMs,
          delay: k * launchGap,
          arc: ch * 0.9,
          spin: (k % 2 ? -1 : 1) * 22,
          peakLift: 0.6,
          peakScale: 0.3,
          overshoot: cw * 0.1,
          z: B.TUNE.showZ + k,
          trail: k % 2 === 0 ? '#f3c969' : null,
          onStart: function (sp) {
            if (my !== token) return;
            if (k % 4 === 0) {
              sfx('whoosh', { volume: 0.5, pitch: 0.9 + (k / 52) * 0.5 });
              haptic('tick');
            }
            if (FX && k % 2 === 0) {
              const c = B.toClient(sp.x + cw / 2, sp.y + ch / 2);
              FX.burst(c.x, c.y, { kind: 'spark', count: 8, speed: cw * 5, size: Math.max(1.6, cw * 0.035) });
            }
          },
        }).finished
      );
    }
    if (FX) stops.push(FX.confetti({ duration: 5200, density: 0.9 }));

    Promise.all(flights)
      .then(function () {
        if (my !== token) return null;
        // ---- act 2: wheel
        if (FX) stops.push(FX.fireworks({ duration: 3000, intensity: 1 }));
        haptic('win');
        return new Promise(function (resolve) {
          const h = A.tween({
            duration: 3000,
            ease: 'linear',
            update: function (t) {
              if (my !== token) return;
              const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // inOutQuad
              const turn = e * TAU * 1.25;
              const breathe = 1 + 0.1 * Math.sin(t * PI * 3) * Math.sin(t * PI);
              const env = Math.sin(t * PI);
              for (let i = 0; i < 52; i++) {
                const s = cards[i];
                const k = seat[s.id];
                const p = seatPos(k, turn, breathe);
                s.x = p.x;
                s.y = p.y;
                s.rot = ((p.rot + 180) % 360) - 180;
                // a wave of flips travelling round the ring (transform-only flip mode)
                const w = 0.5 - 0.5 * Math.cos(TAU * (t * 2 - k / 52));
                s.flipMode = 'spin';
                s.flip = 180 * env * w;
                s.scale = 1 + 0.12 * env;
                s.z = B.TUNE.showZ + ((k + Math.floor((turn / TAU) * 52)) % 52);
                B.touch(s);
              }
            },
            done: function () {
              for (let i = 0; i < 52; i++) {
                cards[i].flip = 0;
                cards[i].scale = 1;
                B.touch(cards[i]);
              }
              resolve();
            },
          });
          handles.push(h);
          // a cancelled tween never calls done(): resolve anyway so the chain can end
          h.finished.then(function (ok) {
            if (!ok) resolve();
          });
        });
      })
      .then(function () {
        if (my !== token) return null;
        // ---- act 3: home
        sfx('whoosh', { duration: 700 });
        return B.release('show', {
          how: 'fly',
          stagger: 16,
          duration: 560,
          arc: ch * 0.7,
          spin: 14,
          peakLift: 0.5,
          peakScale: 0.12,
        });
      })
      .then(function () {
        if (my !== token) return;
        sfx('place');
        haptic('thud');
        end(true);
      });

    return current;
  }

  /** The player tapped: the cards go straight home, quickly. */
  function skip() {
    if (!playing) return;
    token++;
    cleanupEffects();
    const B = SOL.Board;
    if (B && B.ready) {
      B.release('show', { how: 'fly', stagger: 3, duration: 300, peakLift: 0.3, peakScale: 0.04, spin: 0 });
    }
    end(false);
  }

  /** Stops without sending the cards anywhere (the caller re-renders or re-deals right away). */
  function stop() {
    if (!playing) return;
    token++;
    cleanupEffects();
    const B = SOL.Board;
    if (B && B.ready) {
      const all = B.sprites;
      for (let i = 0; i < all.length; i++) {
        if (all[i].held === 'show') {
          all[i].held = null;
          all[i].soft = false;
        }
      }
      B.sync('glide'); // whatever the caller does next starts from a consistent table
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
  };
})(typeof window !== 'undefined' ? window : globalThis);
