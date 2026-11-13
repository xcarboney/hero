/*
 * SOL.Anim — the one animation clock. Every JS-driven motion in the game runs through it, so the
 * speed setting and reduced motion work everywhere.
 *
 * Public API
 * ----------
 *   Anim.setSpeed(multiplier)       default 1. Every duration / delay / wait / stagger gap is divided by it and
 *                                   springs are simulated that much faster. Applies to running animations too.
 *                                   Non-finite or <= 0 values are ignored; clamped to 0.05..20.
 *   Anim.setReducedMotion(bool)     true: tweens (delay included) jump to their end on the next frame, springs
 *                                   snap to their target on the next frame, waits resolve on the next frame and
 *                                   stagger gaps collapse (every item starts at once). Affects running animations.
 *   Anim.speed  /  Anim.reduced     getters.
 *   Anim.onChange(fn({ speed, reduced })) -> off()      (extra) called when either of the two changes.
 *
 *   Anim.tween({ duration = 300, delay = 0, ease = 'outCubic', from, to, update, done }) -> handle
 *       from/to omitted            update(easedT, rawT)
 *       numbers                    update(value, rawT)            (a missing `from` is 0, a missing `to` is 1)
 *       objects of numbers         update(obj, rawT)   obj has every numeric key of from/to (a key missing on one
 *                                  side stays constant). THE SAME OBJECT IS REUSED for every call: copy it if you
 *                                  need to keep it.
 *       `ease` is a function or a name in Anim.ease. rawT is 0..1 (time, delay excluded).
 *       update is never called synchronously from tween(): the first call is on the next frame, the last call
 *       always carries the exact final value, then done() runs. Nothing is called while the delay runs.
 *   Anim.spring({ from, to, velocity = 0, stiffness = 170, damping = 26, mass = 1, precision = 0.01, update, done }) -> handle
 *       numbers or objects of numbers; update(value, velocity) (objects: two reused objects). Units are per second.
 *       Integrated with a fixed 1ms sub-step using the exact solution of the damped spring, so the motion is
 *       identical at any frame rate and stable for any parameters.
 *       It comes to rest when it is within `precision` of the target and nearly still: the last update is exactly
 *       (to, 0), then done().
 *       handle.setTarget(to)       retarget mid-flight (objects may be partial). On a spring that already came to
 *                                  rest it starts a new run: `running` is true again, `finished` is a fresh promise
 *                                  and done() fires again at the next rest. No-op after cancel().
 *       handle.nudge(velocity)     (extra) adds velocity — a kick; also restarts a spring at rest.
 *       handle.value / handle.velocity / handle.target      (extra) current state (objects are reused: read only).
 *   handle: { cancel(), finish(), finished: Promise<boolean>, running: boolean }
 *       cancel()   stops where it is; update/done are not called; finished resolves false.
 *       finish()   jumps to the end now: update(final value), done(), finished resolves true.
 *       finished   resolves true when it ran to the end (or finish()), false when cancelled. Never rejects.
 *       Calling cancel()/finish() on any handle from inside any callback is safe; both are no-ops when not running.
 *
 *   Anim.wait(ms) -> Promise<true>             speed-scaled; always resolves from a frame (never synchronously).
 *                                              (extra) the promise has .cancel(): resolves it right away with false.
 *   Anim.frame(fn(dtMs, nowMs, scaledDtMs)) -> stop()
 *                                              subscribes to the shared rAF loop. dtMs is real time, clamped to
 *                                              50ms (tab switches, hitches); scaledDtMs = dtMs * speed. Called
 *                                              after the tweens and springs of that frame have been updated.
 *   Anim.nextFrame() -> Promise<nowMs>
 *   Anim.stagger(items, gapMs, fn(item, index) -> handle | Promise | array of those | void) -> Promise<results[]>
 *                                              item 0 starts synchronously, item i after i * gapMs (speed-scaled;
 *                                              tweens/springs created in fn are back-dated so sub-frame gaps stay
 *                                              evenly spaced). Resolves when every item has been started and
 *                                              everything they returned has finished. Never rejects.
 *                                              (extra) the promise has .cancel(): no further items are started.
 *   Anim.all(handlesOrPromises) -> Promise<results[]>    handles give true/false; never rejects (a rejected
 *                                              promise is logged and counts as false).
 *   Anim.ease = { linear, inQuad, outQuad, inOutQuad, inCubic, outCubic, inOutCubic, outQuart, outQuint,
 *                 outExpo, inOutSine, inBack, outBack, inOutBack, outElastic, outBounce }
 *   Anim.bezier(x1, y1, x2, y2) -> ease function         (same curve as CSS cubic-bezier())
 *   Anim.lerp(a, b, t)   Anim.clamp(v, min, max)
 *   Anim.mapRange(v, inMin, inMax, outMin, outMax, clampResult)
 *   Anim.arc(p0, p1, { lift, side }) -> path(t, out?) -> { x, y }
 *       A curved flight path (quadratic Bézier) from p0 to p1. `lift` (px, default 22% of the distance, max 140)
 *       is how far the middle of the path rises towards the top of the screen; `side` (px, default 0) bows it
 *       sideways, positive = to the right of the direction of travel. path(0) is exactly p0, path(1) exactly p1;
 *       t outside 0..1 extrapolates (so overshooting eases work). Without `out` the SAME object is returned on
 *       every call. path.angle(t) -> direction of travel in radians.
 *   Anim.activeCount() -> number    running tweens + springs, plus staggers that still have items to start
 *                                   (so "0" really means nothing more is about to move).
 *   Anim.idle() -> Promise          resolves when activeCount() is 0 at the start of a frame (immediately when
 *                                   nothing is running at all).
 *
 * Clock
 * -----
 * One requestAnimationFrame loop for everything; it stops when there is nothing left to run and restarts on
 * demand. Per frame, in this order: idle()/nextFrame() promises, waits and staggers, tweens and springs, frame
 * subscribers. Anything created during a frame first advances on the following frame. A callback that throws is
 * reported once per animation with console.error and never stops the loop or the animation it belongs to.
 * Time is accumulated from clamped frame deltas: after a hidden tab or a long hitch, motion continues from where
 * it was instead of jumping.
 *
 * Testing hooks (Node): Anim._setClock({ now(), request(fn) -> id, cancel(id) }) and Anim._reset().
 */
(function (root) {
  'use strict';

  const SOL = (root.SOL = root.SOL || {});

  // ------------------------------------------------------------------ constants
  const MAX_DT = 50; // ms: a frame never advances the clock by more than this (tab switch, GC pause…)
  const SPRING_STEP_MS = 1; // fixed integration step for springs
  const SPRING_MAX_MS = 20000; // a spring that has not settled after this much simulated time is put to rest
  const RUNNING = 0;
  const DONE = 1;
  const CANCELLED = 2;
  const PI = Math.PI;

  // ------------------------------------------------------------------ state
  let speed = 1;
  let reduced = false;

  const anims = []; // running tweens + springs
  const timers = []; // waits + staggers that still have items to start
  const subs = []; // frame subscribers
  let frameWaiters = []; // nextFrame() resolvers
  let frameWaitersSpare = [];
  let idleWaiters = [];
  const changeListeners = [];

  let live = 0; // tweens + springs in the RUNNING state
  let liveStaggers = 0; // staggers still dispatching
  let running = false; // is the rAF loop scheduled?
  let rafId = 0;
  let last = 0;
  // Back-dating for things created inside a stagger callback: the item was due `credit` (scaled) ms before the
  // frame that dispatches it, so its animations start that far in. Keeps 8ms gaps even on a 16ms frame clock.
  let credit = 0;

  function report(what, err) {
    if (root.console && typeof root.console.error === 'function') {
      root.console.error('[SOL.Anim] ' + what + ' threw', err);
    }
  }

  // ------------------------------------------------------------------ clock
  function defaultClock() {
    const perf = root.performance && typeof root.performance.now === 'function' ? root.performance : null;
    const now = perf
      ? function () {
          return perf.now();
        }
      : function () {
          return Date.now();
        };
    if (typeof root.requestAnimationFrame === 'function') {
      return {
        now: now,
        request: function (fn) {
          return root.requestAnimationFrame(fn);
        },
        cancel: function (id) {
          root.cancelAnimationFrame(id);
        },
      };
    }
    // No rAF (Node, exotic hosts): a 60Hz timer keeps everything working.
    return {
      now: now,
      request: function (fn) {
        return setTimeout(function () {
          fn(now());
        }, 16);
      },
      cancel: function (id) {
        clearTimeout(id);
      },
    };
  }

  let clock = defaultClock();

  function wake() {
    if (running) return;
    running = true;
    last = clock.now();
    rafId = clock.request(tick);
  }

  function tick(now) {
    if (!running) return;
    if (typeof now !== 'number' || now !== now) now = clock.now();
    let dt = now - last;
    last = now;
    if (!(dt > 0)) dt = 0;
    else if (dt > MAX_DT) dt = MAX_DT;

    // Ask for the next frame before running anything: whatever happens below, the loop survives.
    rafId = clock.request(tick);
    try {
      runFrame(dt, now);
    } catch (err) {
      report('frame', err);
    }
    if (
      anims.length === 0 &&
      timers.length === 0 &&
      subs.length === 0 &&
      frameWaiters.length === 0 &&
      idleWaiters.length === 0
    ) {
      clock.cancel(rafId);
      rafId = 0;
      running = false;
    }
  }

  function runFrame(dt, now) {
    const dts = dt * speed;
    const isReduced = reduced;
    let i;
    let n;
    let w;

    // 0. idle(): checked at the start of a frame, i.e. after every promise continuation of the previous frame
    //    had its chance to start a follow-up animation.
    if (idleWaiters.length !== 0 && live === 0 && liveStaggers === 0) {
      const list = idleWaiters;
      idleWaiters = [];
      for (i = 0; i < list.length; i++) list[i]();
    }

    // 1. nextFrame()
    if (frameWaiters.length !== 0) {
      const list = frameWaiters;
      frameWaiters = frameWaitersSpare;
      frameWaitersSpare = list;
      for (i = 0; i < list.length; i++) list[i](now);
      list.length = 0;
    }

    // Tweens/springs created from here on (stagger callbacks, update/done callbacks, subscribers) are appended
    // behind this mark and first advance on the next frame.
    const animMark = anims.length;

    // 2. waits + staggers
    n = timers.length;
    w = 0;
    for (i = 0; i < n; i++) {
      const t = timers[i];
      if (t.alive) t.step(dts, isReduced);
      if (t.alive) timers[w++] = t;
    }
    for (i = n; i < timers.length; i++) timers[w++] = timers[i];
    timers.length = w;

    // 3. tweens + springs
    w = 0;
    for (i = 0; i < animMark; i++) {
      const a = anims[i];
      if (a._state === RUNNING) a._step(dts, isReduced);
      if (a._state === RUNNING) anims[w++] = a;
      else a._listed = false;
    }
    for (i = animMark; i < anims.length; i++) anims[w++] = anims[i];
    anims.length = w;

    // 4. frame subscribers (they see this frame's animated values)
    n = subs.length;
    w = 0;
    for (i = 0; i < n; i++) {
      const s = subs[i];
      if (s.alive) {
        try {
          s.fn(dt, now, dts);
        } catch (err) {
          if (!s.errored) {
            s.errored = true;
            report('frame subscriber', err);
          }
        }
      }
      if (s.alive) subs[w++] = s;
    }
    for (i = n; i < subs.length; i++) subs[w++] = subs[i];
    subs.length = w;
  }

  // ------------------------------------------------------------------ helpers
  function isObj(v) {
    return v !== null && typeof v === 'object';
  }

  function isFn(v) {
    return typeof v === 'function';
  }

  /** A finite number >= 0, or the fallback when missing / not a number. */
  function nonNeg(v, fallback) {
    if (v === undefined || v === null) return fallback;
    v = +v;
    return v >= 0 && v < Infinity ? v : v === Infinity ? Infinity : 0;
  }

  /** A finite number > 0, or the fallback. */
  function positive(v, fallback) {
    v = +v;
    return v > 0 && v < Infinity ? v : fallback;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
  }

  function mapRange(v, inMin, inMax, outMin, outMax, clampResult) {
    const span = inMax - inMin;
    let t = span === 0 ? 0 : (v - inMin) / span;
    if (clampResult) t = t < 0 ? 0 : t > 1 ? 1 : t;
    return outMin + (outMax - outMin) * t;
  }

  // ------------------------------------------------------------------ easing
  const B1 = 1.70158;
  const B2 = B1 * 1.525;
  const B3 = B1 + 1;
  const E4 = (2 * PI) / 3;

  const ease = {
    linear: function (t) {
      return t;
    },
    inQuad: function (t) {
      return t * t;
    },
    outQuad: function (t) {
      return 1 - (1 - t) * (1 - t);
    },
    inOutQuad: function (t) {
      return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) * (-2 * t + 2) * 0.5;
    },
    inCubic: function (t) {
      return t * t * t;
    },
    outCubic: function (t) {
      const u = 1 - t;
      return 1 - u * u * u;
    },
    inOutCubic: function (t) {
      if (t < 0.5) return 4 * t * t * t;
      const u = -2 * t + 2;
      return 1 - u * u * u * 0.5;
    },
    outQuart: function (t) {
      const u = 1 - t;
      return 1 - u * u * u * u;
    },
    outQuint: function (t) {
      const u = 1 - t;
      return 1 - u * u * u * u * u;
    },
    outExpo: function (t) {
      return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
    },
    inOutSine: function (t) {
      return -(Math.cos(PI * t) - 1) * 0.5;
    },
    inBack: function (t) {
      return B3 * t * t * t - B1 * t * t;
    },
    outBack: function (t) {
      const u = t - 1;
      return 1 + B3 * u * u * u + B1 * u * u;
    },
    inOutBack: function (t) {
      if (t < 0.5) {
        const a = 2 * t;
        return a * a * ((B2 + 1) * a - B2) * 0.5;
      }
      const b = 2 * t - 2;
      return (b * b * ((B2 + 1) * b + B2) + 2) * 0.5;
    },
    outElastic: function (t) {
      if (t <= 0) return 0;
      if (t >= 1) return 1;
      return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * E4) + 1;
    },
    outBounce: function (t) {
      const n1 = 7.5625;
      const d1 = 2.75;
      if (t < 1 / d1) return n1 * t * t;
      if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
      if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
      return n1 * (t -= 2.625 / d1) * t + 0.984375;
    },
  };

  const warnedEases = {};

  function resolveEase(e) {
    if (isFn(e)) return e;
    if (e === undefined || e === null) return ease.outCubic;
    if (Object.prototype.hasOwnProperty.call(ease, e)) return ease[e];
    if (!warnedEases[e]) {
      warnedEases[e] = true;
      if (root.console && isFn(root.console.warn)) {
        root.console.warn('[SOL.Anim] unknown ease "' + e + '", using outCubic');
      }
    }
    return ease.outCubic;
  }

  /**
   * CSS-style cubic-bezier(x1, y1, x2, y2) as an ease function. x1/x2 are clamped to 0..1 (as in CSS) so the
   * curve stays a function of time. Newton–Raphson on a sample table, bisection where the slope is too flat.
   */
  function bezier(x1, y1, x2, y2) {
    x1 = clamp(+x1 || 0, 0, 1);
    x2 = clamp(+x2 || 0, 0, 1);
    y1 = +y1 || 0;
    y2 = +y2 || 0;
    if (x1 === y1 && x2 === y2) return ease.linear;

    const TABLE = 11;
    const STEP = 1 / (TABLE - 1);
    const ax = 1 - 3 * x2 + 3 * x1;
    const bx = 3 * x2 - 6 * x1;
    const cx = 3 * x1;
    const ay = 1 - 3 * y2 + 3 * y1;
    const by = 3 * y2 - 6 * y1;
    const cy = 3 * y1;
    const samples = new Float64Array(TABLE);
    for (let i = 0; i < TABLE; i++) {
      const s = i * STEP;
      samples[i] = ((ax * s + bx) * s + cx) * s;
    }

    function solve(x) {
      let start = 0;
      let i = 1;
      for (; i !== TABLE - 1 && samples[i] <= x; i++) start += STEP;
      i--;
      const dist = (x - samples[i]) / (samples[i + 1] - samples[i]);
      let t = start + dist * STEP;
      const slope = (3 * ax * t + 2 * bx) * t + cx;
      if (slope >= 0.001) {
        for (let k = 0; k < 4; k++) {
          const s = (3 * ax * t + 2 * bx) * t + cx;
          if (s === 0) break;
          t -= (((ax * t + bx) * t + cx) * t - x) / s;
        }
        return t;
      }
      if (slope === 0) return t;
      let lo = start;
      let hi = start + STEP;
      for (let k = 0; k < 12; k++) {
        t = lo + (hi - lo) * 0.5;
        const cur = ((ax * t + bx) * t + cx) * t - x;
        if (cur > 0) hi = t;
        else lo = t;
        if (Math.abs(cur) < 1e-7) break;
      }
      return t;
    }

    return function (x) {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      const t = solve(x);
      return ((ay * t + by) * t + cy) * t;
    };
  }

  // ------------------------------------------------------------------ handles (shared by Tween and Spring)
  /** Marks an animation finished/cancelled, runs done() and settles its promise. */
  function settle(a, state) {
    a._state = state;
    live--;
    if (state === DONE && a._done) {
      try {
        a._done();
      } catch (err) {
        report('done callback', err);
      }
    }
    const resolve = a._resolve;
    if (resolve) {
      a._resolve = null;
      resolve(state === DONE);
    }
  }

  function startAnim(a) {
    live++;
    a._listed = true;
    anims.push(a);
    wake();
  }

  function finishedPromise(a) {
    if (!a._promise) {
      if (a._state === RUNNING) {
        a._promise = new Promise(function (resolve) {
          a._resolve = resolve;
        });
      } else {
        a._promise = Promise.resolve(a._state === DONE);
      }
    }
    return a._promise;
  }

  function reportOnce(a, what, err) {
    if (a._errored) return;
    a._errored = true;
    report(what, err);
  }

  // ------------------------------------------------------------------ Tween
  class Tween {
    constructor(o) {
      this._state = RUNNING;
      this._listed = false;
      this._promise = null;
      this._resolve = null;
      this._errored = false;
      this._finishing = false;
      this._update = isFn(o.update) ? o.update : null;
      this._done = isFn(o.done) ? o.done : null;
      this._dur = nonNeg(o.duration, 300);
      this._time = credit - nonNeg(o.delay, 0); // < 0 while the delay runs
      this._ease = resolveEase(o.ease);

      // The value handed to the last update: ease(1), snapped to exactly 1 for every ease that ends there
      // (a "there and back" ease that ends at 0 keeps its own end value).
      let end = 1;
      try {
        end = +this._ease(1);
      } catch (err) {
        reportOnce(this, 'ease function', err);
        this._ease = ease.linear;
      }
      if (end !== end || Math.abs(end - 1) < 1e-6) end = 1;
      this._endE = end;

      const f = o.from;
      const t = o.to;
      this._keys = null;
      this._out = null;
      this._f = null;
      this._d = null;
      this._from = 0;
      this._to = 1;
      if (isObj(f) || isObj(t)) {
        // object mode: every numeric key of either side; a key missing on one side does not move
        this._mode = 2;
        const fo = isObj(f) ? f : {};
        const to = isObj(t) ? t : {};
        const keys = [];
        let k;
        for (k in to) if (typeof to[k] === 'number') keys.push(k);
        for (k in fo) if (typeof fo[k] === 'number' && keys.indexOf(k) === -1) keys.push(k);
        const n = keys.length;
        const fa = new Float64Array(n);
        const da = new Float64Array(n);
        const ta = new Float64Array(n);
        const out = {};
        for (let i = 0; i < n; i++) {
          k = keys[i];
          const tv = typeof to[k] === 'number' ? to[k] : fo[k];
          const fv = typeof fo[k] === 'number' ? fo[k] : tv;
          fa[i] = fv;
          ta[i] = tv;
          da[i] = tv - fv;
          out[k] = fv;
        }
        this._keys = keys;
        this._f = fa;
        this._d = da;
        this._t = ta;
        this._out = out;
      } else if (typeof f === 'number' || typeof t === 'number') {
        this._mode = 1;
        this._from = typeof f === 'number' ? f : 0;
        this._to = typeof t === 'number' ? t : 1;
      } else {
        this._mode = 0;
      }
    }

    get running() {
      return this._state === RUNNING;
    }

    get finished() {
      return finishedPromise(this);
    }

    cancel() {
      if (this._state === RUNNING) settle(this, CANCELLED);
    }

    finish() {
      // `_finishing`: the final update() is on the stack and called finish() again — it must not recurse.
      if (this._state !== RUNNING || this._finishing) return;
      this._apply(1);
      if (this._state === RUNNING) settle(this, DONE);
    }

    /** Advances by `dts` scaled ms. Called by the clock only. */
    _step(dts, isReduced) {
      let time = this._time + dts;
      const dur = this._dur;
      if (isReduced) time = dur; // reduced motion: straight to the end, delay included
      this._time = time;
      if (time < 0) return; // still waiting out the delay
      const raw = dur > 0 && time < dur ? time / dur : 1;
      this._apply(raw);
      // The callback may have cancelled or finished this very tween.
      if (raw >= 1 && this._state === RUNNING) settle(this, DONE);
    }

    _apply(raw) {
      const update = this._update;
      if (!update) return;
      const last = raw >= 1;
      if (last) this._finishing = true;
      try {
        const e = raw >= 1 ? this._endE : this._ease(raw);
        const mode = this._mode;
        if (mode === 1) {
          update(e === 1 ? this._to : this._from + (this._to - this._from) * e, raw);
        } else if (mode === 0) {
          update(e, raw);
        } else {
          const keys = this._keys;
          const out = this._out;
          const fa = this._f;
          if (e === 1) {
            const ta = this._t;
            for (let i = 0; i < keys.length; i++) out[keys[i]] = ta[i];
          } else {
            const da = this._d;
            for (let i = 0; i < keys.length; i++) out[keys[i]] = fa[i] + da[i] * e;
          }
          update(out, raw);
        }
      } catch (err) {
        reportOnce(this, 'tween update', err);
      }
      if (last) this._finishing = false;
    }
  }

  // ------------------------------------------------------------------ Spring
  /**
   * Exact state transition of  m·d'' + c·d' + k·d = 0  over `h` seconds, as [a11, a12, a21, a22] with
   *   d(h) = a11·d + a12·v      v(h) = a21·d + a22·v        (d = displacement from the target)
   * Returns null when the parameters are so extreme that the result is not finite.
   */
  function springStep(k, c, m, h) {
    const w0 = Math.sqrt(k / m);
    const zeta = c / (2 * Math.sqrt(k * m));
    let a11;
    let a12;
    let a21;
    let a22;
    if (zeta < 1 - 1e-7) {
      // under-damped: decaying oscillation
      const wd = w0 * Math.sqrt(1 - zeta * zeta);
      const sg = zeta * w0;
      const e = Math.exp(-sg * h);
      const cs = Math.cos(wd * h);
      const sn = Math.sin(wd * h);
      a11 = e * (cs + (sg / wd) * sn);
      a12 = (e * sn) / wd;
      a21 = (-e * w0 * w0 * sn) / wd;
      a22 = e * (cs - (sg / wd) * sn);
    } else if (zeta <= 1 + 1e-7) {
      // critically damped
      const e = Math.exp(-w0 * h);
      a11 = e * (1 + w0 * h);
      a12 = e * h;
      a21 = -e * w0 * w0 * h;
      a22 = e * (1 - w0 * h);
    } else {
      // over-damped: two real roots (the slow one written without cancellation)
      const s = Math.sqrt(zeta * zeta - 1);
      const r1 = -w0 / (zeta + s);
      const r2 = -w0 * (zeta + s);
      const e1 = Math.exp(r1 * h);
      const e2 = Math.exp(r2 * h);
      const inv = 1 / (r1 - r2);
      a11 = (r1 * e2 - r2 * e1) * inv;
      a12 = (e1 - e2) * inv;
      a21 = r1 * r2 * (e2 - e1) * inv;
      a22 = (r1 * e1 - r2 * e2) * inv;
    }
    if (!isFinite(a11) || !isFinite(a12) || !isFinite(a21) || !isFinite(a22)) return null;
    return [a11, a12, a21, a22];
  }

  class Spring {
    constructor(o) {
      this._state = RUNNING;
      this._listed = false;
      this._promise = null;
      this._resolve = null;
      this._errored = false;
      this._finishing = false;
      this._update = isFn(o.update) ? o.update : null;
      this._done = isFn(o.done) ? o.done : null;

      const k = positive(o.stiffness, 170);
      const m = positive(o.mass, 1);
      const c = nonNeg(o.damping, 26);
      const prec = positive(o.precision, 0.01);
      this._k = k;
      this._c = c === Infinity ? 1e9 : c;
      this._m = m;
      this._restE = k * prec * prec; // "energy" below which the spring can never leave the precision band again

      // Fixed 1ms sub-step with the exact propagator of the damped oscillator (see springStep): identical
      // motion at any frame rate, no integration error, and stable for any stiffness / damping / mass.
      const a = springStep(k, this._c, m, SPRING_STEP_MS * 0.001);
      this._snap = a === null; // parameters so extreme that the maths overflows: such a spring is instant
      this._a11 = a ? a[0] : 1;
      this._a12 = a ? a[1] : 0;
      this._a21 = a ? a[2] : 0;
      this._a22 = a ? a[3] : 1;
      // The part of a frame that does not fill a whole step is extrapolated (2nd order) when that is accurate.
      this._extrap = Math.sqrt(k / m) * SPRING_STEP_MS * 0.001 <= 0.1 && (this._c / m) * SPRING_STEP_MS * 0.001 <= 0.1;
      this._acc = credit; // ms not yet simulated
      this._age = 0;
      this._dirty = false;

      const f = o.from;
      const t = o.to;
      const v = o.velocity;
      let n = 1;
      this._keys = null;
      this._out = null;
      this._vout = null;
      if (isObj(f) || isObj(t)) {
        const fo = isObj(f) ? f : {};
        const to = isObj(t) ? t : {};
        const keys = [];
        let key;
        for (key in to) if (typeof to[key] === 'number') keys.push(key);
        for (key in fo) if (typeof fo[key] === 'number' && keys.indexOf(key) === -1) keys.push(key);
        n = keys.length;
        this._keys = keys;
        this._out = {};
        this._vout = {};
        this._x = new Float64Array(n);
        this._v = new Float64Array(n);
        this._t = new Float64Array(n);
        for (let i = 0; i < n; i++) {
          key = keys[i];
          const tv = typeof to[key] === 'number' ? to[key] : fo[key];
          const fv = typeof fo[key] === 'number' ? fo[key] : tv;
          this._x[i] = fv;
          this._t[i] = tv;
          this._v[i] = typeof v === 'number' ? v : isObj(v) && typeof v[key] === 'number' ? v[key] : 0;
          this._out[key] = fv;
          this._vout[key] = this._v[i];
        }
      } else {
        this._x = new Float64Array(1);
        this._v = new Float64Array(1);
        this._t = new Float64Array(1);
        this._x[0] = typeof f === 'number' ? f : 0;
        this._t[0] = typeof t === 'number' ? t : this._x[0];
        this._v[0] = typeof v === 'number' ? v : 0;
      }
    }

    get running() {
      return this._state === RUNNING;
    }

    get finished() {
      return finishedPromise(this);
    }

    /** Current value: a number, or (object springs) a reused object — read it, do not keep it. */
    get value() {
      const keys = this._keys;
      if (!keys) return this._x[0];
      for (let i = 0; i < keys.length; i++) this._out[keys[i]] = this._x[i];
      return this._out;
    }

    get velocity() {
      const keys = this._keys;
      if (!keys) return this._v[0];
      for (let i = 0; i < keys.length; i++) this._vout[keys[i]] = this._v[i];
      return this._vout;
    }

    get target() {
      const keys = this._keys;
      if (!keys) return this._t[0];
      const out = {};
      for (let i = 0; i < keys.length; i++) out[keys[i]] = this._t[i];
      return out;
    }

    cancel() {
      if (this._state === RUNNING) settle(this, CANCELLED);
    }

    finish() {
      if (this._state === RUNNING) this._rest();
    }

    /** Retargets (objects may be partial). Restarts a spring that had come to rest. */
    setTarget(to) {
      if (this._state === CANCELLED) return this;
      const keys = this._keys;
      const ts = this._t;
      let changed = false;
      if (!keys) {
        if (typeof to === 'number' && to === to && ts[0] !== to) {
          ts[0] = to;
          changed = true;
        }
      } else if (isObj(to)) {
        for (let i = 0; i < keys.length; i++) {
          const v = to[keys[i]];
          if (typeof v === 'number' && v === v && ts[i] !== v) {
            ts[i] = v;
            changed = true;
          }
        }
      }
      if (changed) this._revive();
      return this;
    }

    /** Adds velocity (number, or an object of per-key velocities). Restarts a spring that had come to rest. */
    nudge(velocity) {
      if (this._state === CANCELLED) return this;
      const keys = this._keys;
      const vs = this._v;
      let changed = false;
      if (typeof velocity === 'number' && velocity === velocity && velocity !== 0) {
        for (let i = 0; i < vs.length; i++) vs[i] += velocity;
        changed = true;
      } else if (keys && isObj(velocity)) {
        for (let i = 0; i < keys.length; i++) {
          const v = velocity[keys[i]];
          if (typeof v === 'number' && v === v && v !== 0) {
            vs[i] += v;
            changed = true;
          }
        }
      }
      if (changed) this._revive();
      return this;
    }

    _revive() {
      this._age = 0;
      this._dirty = true;
      if (this._state !== DONE) return;
      this._state = RUNNING;
      this._promise = null;
      this._resolve = null;
      this._acc = 0;
      live++;
      if (!this._listed) {
        this._listed = true;
        anims.push(this);
      }
      wake();
    }

    /** Advances by `dts` scaled ms. Called by the clock only. */
    _step(dts, isReduced) {
      if (isReduced || this._snap) {
        this._rest();
        return;
      }
      this._age += dts;
      if (this._age > SPRING_MAX_MS) {
        this._rest();
        return;
      }
      let acc = this._acc + dts;
      const steps = Math.floor(acc / SPRING_STEP_MS);
      acc -= steps * SPRING_STEP_MS;
      this._acc = acc;

      const a11 = this._a11;
      const a12 = this._a12;
      const a21 = this._a21;
      const a22 = this._a22;
      const k = this._k;
      const m = this._m;
      const restE = this._restE;
      const xs = this._x;
      const vs = this._v;
      const ts = this._t;
      let atRest = true;
      for (let i = 0; i < xs.length; i++) {
        let d = xs[i] - ts[i]; // displacement from the target
        let v = vs[i];
        for (let s = 0; s < steps; s++) {
          const nd = a11 * d + a12 * v;
          v = a21 * d + a22 * v;
          d = nd;
        }
        xs[i] = ts[i] + d;
        vs[i] = v;
        // NaN (nonsense input) fails this comparison too, so such a spring is put to rest instead of running on.
        if (!(k * d * d + m * v * v <= restE)) atRest = false;
      }
      if (atRest || !(xs[0] === xs[0])) this._rest();
      else this._emit(this._extrap ? acc * 0.001 : 0);
    }

    /** Snap onto the target, report (target, 0) and settle — unless the callback retargeted us. */
    _rest() {
      if (this._finishing) return; // the resting update() is on the stack and called finish()
      const xs = this._x;
      const vs = this._v;
      const ts = this._t;
      for (let i = 0; i < xs.length; i++) {
        xs[i] = ts[i];
        vs[i] = 0;
      }
      this._dirty = false;
      this._finishing = true;
      this._emit(0);
      this._finishing = false;
      if (this._state === RUNNING && !this._dirty) settle(this, DONE);
    }

    /** `ahead` (s): the part of the frame the fixed steps have not covered yet, extrapolated for smoothness. */
    _emit(ahead) {
      const update = this._update;
      if (!update) return;
      try {
        const keys = this._keys;
        const xs = this._x;
        const vs = this._v;
        const ts = this._t;
        const k = this._k;
        const c = this._c;
        const im = 1 / this._m;
        if (!keys) {
          const x = xs[0];
          const v = vs[0];
          if (ahead > 0) {
            const acc = (k * (ts[0] - x) - c * v) * im;
            update(x + (v + 0.5 * acc * ahead) * ahead, v + acc * ahead);
          } else {
            update(x, v);
          }
        } else {
          const out = this._out;
          const vout = this._vout;
          for (let i = 0; i < keys.length; i++) {
            const x = xs[i];
            const v = vs[i];
            if (ahead > 0) {
              const acc = (k * (ts[i] - x) - c * v) * im;
              out[keys[i]] = x + (v + 0.5 * acc * ahead) * ahead;
              vout[keys[i]] = v + acc * ahead;
            } else {
              out[keys[i]] = x;
              vout[keys[i]] = v;
            }
          }
          update(out, vout);
        }
      } catch (err) {
        reportOnce(this, 'spring update', err);
      }
    }
  }

  // ------------------------------------------------------------------ waits + staggers
  class Wait {
    constructor(ms) {
      this.alive = true;
      this.remaining = nonNeg(ms, 0) - credit;
      this.resolve = null;
    }

    step(dts, isReduced) {
      this.remaining -= dts;
      if (isReduced || this.remaining <= 0) this.end(true);
    }

    end(value) {
      if (!this.alive) return;
      this.alive = false;
      const resolve = this.resolve;
      this.resolve = null;
      resolve(value);
    }
  }

  /** Anything stagger/all accept -> a promise that never rejects (and this function never throws). */
  function toPromise(v) {
    if (v === null || v === undefined) return Promise.resolve(v);
    try {
      if (Array.isArray(v)) return all(v);
      if (isObj(v) || isFn(v)) {
        const fin = v.finished;
        if (fin && isFn(fin.then)) {
          // our own handles never reject; a foreign `finished` promise might
          return v instanceof Tween || v instanceof Spring ? fin : Promise.resolve(fin).then(null, swallow);
        }
        if (isFn(v.then)) return Promise.resolve(v).then(null, swallow);
      }
    } catch (err) {
      return Promise.resolve(swallow(err));
    }
    return Promise.resolve(v);
  }

  function swallow(err) {
    report('awaited promise', err);
    return false;
  }

  class Stagger {
    constructor(items, gap, fn) {
      this.alive = true; // true while items remain to be started
      this.items = items;
      this.gap = gap;
      this.fn = fn;
      this.index = 0;
      this.time = credit;
      this.pending = 0;
      this.results = new Array(items.length).fill(undefined);
      this.resolve = null;
    }

    step(dts, isReduced) {
      this.time += dts;
      this.dispatch(isReduced);
    }

    /** Starts every item that is due. */
    dispatch(all) {
      const items = this.items;
      const gap = this.gap;
      const prevCredit = credit;
      try {
        while (this.alive && this.index < items.length) {
          const due = this.index * gap;
          if (!all && this.time < due) break;
          credit = all ? prevCredit : Math.max(0, this.time - due);
          this.start(this.index++);
        }
      } finally {
        credit = prevCredit; // whatever happens, nothing created later may inherit the back-dating
      }
      if (this.alive && this.index >= items.length) this.close();
    }

    start(i) {
      const self = this;
      let result;
      try {
        result = this.fn(this.items[i], i);
      } catch (err) {
        report('stagger callback', err);
        result = false;
      }
      this.pending++;
      toPromise(result).then(function (value) {
        self.results[i] = value;
        self.pending--;
        self.maybeResolve();
      });
    }

    /** No more items will be started. */
    close() {
      if (!this.alive) return;
      this.alive = false;
      liveStaggers--;
      this.maybeResolve();
    }

    maybeResolve() {
      if (this.alive || this.pending !== 0 || !this.resolve) return;
      const resolve = this.resolve;
      this.resolve = null;
      resolve(this.results);
    }
  }

  // ------------------------------------------------------------------ public functions
  function tween(opts) {
    const t = new Tween(opts || {});
    startAnim(t);
    return t;
  }

  function spring(opts) {
    const s = new Spring(opts || {});
    startAnim(s);
    return s;
  }

  function wait(ms) {
    const w = new Wait(ms);
    const p = new Promise(function (resolve) {
      w.resolve = resolve;
    });
    p.cancel = function () {
      w.end(false);
    };
    timers.push(w);
    wake();
    return p;
  }

  function frame(fn) {
    if (!isFn(fn)) return function () {};
    const s = { fn: fn, alive: true, errored: false };
    subs.push(s);
    wake();
    return function stop() {
      s.alive = false;
    };
  }

  function nextFrame() {
    return new Promise(function (resolve) {
      frameWaiters.push(resolve);
      wake();
    });
  }

  function stagger(items, gapMs, fn) {
    const list = Array.isArray(items) ? items : items === null || items === undefined ? [] : Array.from(items);
    const s = new Stagger(list, nonNeg(gapMs, 0), isFn(fn) ? fn : function () {});
    const p = new Promise(function (resolve) {
      s.resolve = resolve;
    });
    p.cancel = function () {
      s.close();
    };
    liveStaggers++;
    // The first item never waits; with no gap (or reduced motion) none of them do.
    s.dispatch(reduced || s.gap <= 0);
    if (s.alive) {
      timers.push(s);
      wake();
    }
    return p;
  }

  function all(list) {
    const arr = Array.isArray(list) ? list : list === null || list === undefined ? [] : [list];
    return Promise.all(arr.map(toPromise));
  }

  /**
   * Curved flight path between two points (see the header). The control point of the quadratic sits twice as far
   * out as the requested apex, so `lift`/`side` are the real offsets of the path's midpoint from the chord.
   */
  function arc(p0, p1, opts) {
    const x0 = +(p0 && p0.x) || 0;
    const y0 = +(p0 && p0.y) || 0;
    const x1 = +(p1 && p1.x) || 0;
    const y1 = +(p1 && p1.y) || 0;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const lift = opts && typeof opts.lift === 'number' && opts.lift === opts.lift ? opts.lift : Math.min(140, dist * 0.22);
    const side = opts && typeof opts.side === 'number' && opts.side === opts.side ? opts.side : 0;
    // unit normal pointing to the right of the direction of travel (screen space, y down)
    const nx = dist > 1e-6 ? -dy / dist : 1;
    const ny = dist > 1e-6 ? dx / dist : 0;
    const cx = (x0 + x1) * 0.5 + nx * side * 2;
    const cy = (y0 + y1) * 0.5 + ny * side * 2 - lift * 2;
    const shared = { x: x0, y: y0 };

    function path(t, out) {
      const o = out || shared;
      const u = 1 - t;
      const a = u * u;
      const b = 2 * u * t;
      const c = t * t;
      o.x = a * x0 + b * cx + c * x1;
      o.y = a * y0 + b * cy + c * y1;
      return o;
    }

    path.angle = function (t) {
      const u = 1 - t;
      return Math.atan2(u * (cy - y0) + t * (y1 - cy), u * (cx - x0) + t * (x1 - cx));
    };
    return path;
  }

  function activeCount() {
    return live + liveStaggers;
  }

  function idle() {
    if (live === 0 && liveStaggers === 0 && !running) return Promise.resolve();
    return new Promise(function (resolve) {
      idleWaiters.push(resolve);
      wake();
    });
  }

  function notifyChange() {
    const info = { speed: speed, reduced: reduced };
    for (const fn of changeListeners.slice()) {
      try {
        fn(info);
      } catch (err) {
        report('onChange listener', err);
      }
    }
  }

  function setSpeed(multiplier) {
    const v = +multiplier;
    if (!(v > 0) || v === Infinity) return;
    const next = clamp(v, 0.05, 20);
    if (next === speed) return;
    speed = next;
    notifyChange();
  }

  function setReducedMotion(on) {
    const next = !!on;
    if (next === reduced) return;
    reduced = next;
    notifyChange();
  }

  function onChange(fn) {
    if (!isFn(fn)) return function () {};
    changeListeners.push(fn);
    return function off() {
      const i = changeListeners.indexOf(fn);
      if (i !== -1) changeListeners.splice(i, 1);
    };
  }

  // ------------------------------------------------------------------ testing hooks
  /** Replace the frame source: { now() -> ms, request(fn) -> id, cancel(id) }. Pass nothing to restore the default. */
  function setClock(c) {
    if (running) {
      clock.cancel(rafId);
      running = false;
      rafId = 0;
    }
    clock = c || defaultClock();
    if (anims.length || timers.length || subs.length || frameWaiters.length || idleWaiters.length) wake();
  }

  /** Cancels everything and restores speed 1 / reduced motion off. Pending waits resolve false. */
  function reset() {
    let i;
    for (i = 0; i < anims.length; i++) anims[i].cancel();
    for (i = 0; i < anims.length; i++) anims[i]._listed = false;
    anims.length = 0;
    for (i = 0; i < timers.length; i++) {
      const t = timers[i];
      if (t instanceof Wait) t.end(false);
      else t.close();
    }
    timers.length = 0;
    for (i = 0; i < subs.length; i++) subs[i].alive = false;
    subs.length = 0;
    const fw = frameWaiters;
    frameWaiters = [];
    for (i = 0; i < fw.length; i++) fw[i](clock.now());
    const iw = idleWaiters;
    idleWaiters = [];
    for (i = 0; i < iw.length; i++) iw[i]();
    live = 0;
    liveStaggers = 0;
    credit = 0;
    speed = 1;
    reduced = false;
    if (running) {
      clock.cancel(rafId);
      running = false;
      rafId = 0;
    }
  }

  SOL.Anim = {
    setSpeed: setSpeed,
    setReducedMotion: setReducedMotion,
    get speed() {
      return speed;
    },
    get reduced() {
      return reduced;
    },
    onChange: onChange,

    tween: tween,
    spring: spring,
    wait: wait,
    frame: frame,
    nextFrame: nextFrame,
    stagger: stagger,
    all: all,

    ease: ease,
    bezier: bezier,
    lerp: lerp,
    clamp: clamp,
    mapRange: mapRange,
    arc: arc,

    activeCount: activeCount,
    idle: idle,

    MAX_DT: MAX_DT,
    _setClock: setClock,
    _reset: reset,
    /** True while the shared rAF loop is scheduled (tests assert that it goes to sleep). */
    get _looping() {
      return running;
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = SOL.Anim;
})(typeof window !== 'undefined' ? window : globalThis);
