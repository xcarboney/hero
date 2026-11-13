/*
 * SOL.Anim — semantics, driven by a hand-cranked frame clock (Anim._setClock), so every assertion is exact.
 * Run with: node --test solitaire/tests/
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Anim = require('../js/view/anim.js');

// ------------------------------------------------------------------ harness
function makeClock() {
  let t = 1000;
  let nextId = 1;
  const queue = new Map();
  return {
    now: () => t,
    request(fn) {
      const id = nextId++;
      queue.set(id, fn);
      return id;
    },
    cancel(id) {
      queue.delete(id);
    },
    get scheduled() {
      return queue.size;
    },
    /** Runs one frame `ms` after the previous one. */
    frame(ms = 16) {
      t += ms;
      const fns = Array.from(queue.values());
      queue.clear();
      for (const fn of fns) fn(t);
    },
  };
}

/** Lets promise continuations run (several hops deep). */
async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

let clock;

/** Advances `ms` of frame time in `step` ms frames, flushing microtasks after every frame. */
async function advance(ms, step = 10) {
  let left = ms;
  while (left > 1e-9) {
    const d = Math.min(step, left);
    clock.frame(d);
    left -= d;
    await flush();
  }
}

function near(actual, expected, tol, msg) {
  assert.ok(Math.abs(actual - expected) <= tol, `${msg || 'value'}: ${actual} not within ${tol} of ${expected}`);
}

let errors;
const realError = console.error;
const realWarn = console.warn;

test.beforeEach(() => {
  Anim._reset();
  clock = makeClock();
  Anim._setClock(clock);
  errors = [];
  console.error = (...args) => errors.push(args);
  console.warn = () => {};
});

test.afterEach(() => {
  console.error = realError;
  console.warn = realWarn;
  Anim._reset();
});

// ------------------------------------------------------------------ tweens
test('tween: numbers interpolate, last call is the exact final value, done + finished(true)', async () => {
  const values = [];
  let done = 0;
  const h = Anim.tween({ from: 10, to: 110, duration: 100, ease: 'linear', update: (v, t) => values.push([v, t]), done: () => done++ });
  assert.strictEqual(values.length, 0, 'update must not be called synchronously');
  assert.strictEqual(h.running, true);
  assert.strictEqual(Anim.activeCount(), 1);

  let result = null;
  h.finished.then((v) => (result = v));
  await advance(50);
  assert.strictEqual(values.length, 5);
  near(values[4][0], 60, 1e-9);
  near(values[4][1], 0.5, 1e-9);
  assert.strictEqual(result, null);
  await advance(50);
  assert.deepStrictEqual(values[values.length - 1], [110, 1]);
  assert.strictEqual(done, 1);
  assert.strictEqual(result, true);
  assert.strictEqual(h.running, false);
  assert.strictEqual(Anim.activeCount(), 0);
  const n = values.length;
  await advance(50);
  assert.strictEqual(values.length, n, 'no update after the end');
  assert.strictEqual(await h.finished, true, 'finished stays readable after the end');
});

test('tween: without from/to update receives (easedT, rawT); default ease is outCubic, default duration 300', async () => {
  const seen = [];
  Anim.tween({ update: (e, t) => seen.push([e, t]) });
  await advance(150);
  const [e, t] = seen[seen.length - 1];
  near(t, 0.5, 1e-9);
  near(e, Anim.ease.outCubic(0.5), 1e-9);
  await advance(140);
  assert.ok(seen[seen.length - 1][1] < 1);
  await advance(10);
  assert.deepStrictEqual(seen[seen.length - 1], [1, 1]);
});

test('tween: a missing from is 0 and a missing to is 1', async () => {
  let a;
  let b;
  Anim.tween({ to: 8, duration: 10, update: (v) => (a = v) });
  Anim.tween({ from: 5, duration: 100, ease: 'linear', update: (v) => (b = v) });
  await advance(50);
  assert.strictEqual(a, 8);
  near(b, 3, 1e-9);
});

test('tween: objects of numbers — one reused output object, union of keys, exact end', async () => {
  const objs = new Set();
  let lastCopy;
  Anim.tween({
    from: { x: 0, y: 100, keep: 7 },
    to: { x: 200, y: 0, extra: 3 },
    duration: 100,
    ease: 'linear',
    update: (o) => {
      objs.add(o);
      lastCopy = Object.assign({}, o);
    },
  });
  await advance(30);
  near(lastCopy.x, 60, 1e-9);
  near(lastCopy.y, 70, 1e-9);
  assert.strictEqual(lastCopy.keep, 7);
  assert.strictEqual(lastCopy.extra, 3);
  await advance(70);
  assert.deepStrictEqual(lastCopy, { x: 200, y: 0, extra: 3, keep: 7 });
  assert.strictEqual(objs.size, 1, 'the same object must be handed to every update');
});

test('tween: delay — nothing is called while it runs, then the full duration follows', async () => {
  const seen = [];
  Anim.tween({ delay: 100, duration: 100, ease: 'linear', from: 0, to: 1, update: (v) => seen.push(v) });
  await advance(90);
  assert.strictEqual(seen.length, 0);
  await advance(60); // 150 total -> 50 into the tween
  near(seen[seen.length - 1], 0.5, 1e-9);
  await advance(50);
  assert.strictEqual(seen[seen.length - 1], 1);
});

test('tween: duration 0 completes on the next frame, not synchronously', async () => {
  const seen = [];
  const h = Anim.tween({ duration: 0, from: 1, to: 2, update: (v) => seen.push(v) });
  assert.strictEqual(seen.length, 0);
  await advance(1);
  assert.deepStrictEqual(seen, [2]);
  assert.strictEqual(await h.finished, true);
});

test('tween: an ease that does not end at 1 keeps its own end value; unknown names fall back to outCubic', async () => {
  let v;
  Anim.tween({ from: 0, to: 10, duration: 20, ease: (t) => Math.sin(Math.PI * t), update: (x) => (v = x) });
  await advance(10);
  near(v, 10, 1e-9);
  await advance(10);
  near(v, 0, 1e-9, 'there-and-back ease returns to the start');

  let w;
  Anim.tween({ from: 0, to: 1, duration: 100, ease: 'nope', update: (x) => (w = x) });
  await advance(50);
  near(w, Anim.ease.outCubic(0.5), 1e-9);
});

test('setSpeed: 2 halves durations, delays and waits; 0.5 doubles them; changes apply mid-flight', async () => {
  Anim.setSpeed(2);
  assert.strictEqual(Anim.speed, 2);
  let done = false;
  let waited = false;
  Anim.tween({ delay: 100, duration: 300, done: () => (done = true) });
  Anim.wait(400).then(() => (waited = true));
  await advance(190);
  assert.strictEqual(done, false);
  assert.strictEqual(waited, false);
  await advance(10);
  assert.strictEqual(done, true, '400ms of tween at speed 2 = 200ms');
  assert.strictEqual(waited, true);

  Anim.setSpeed(0.5);
  done = false;
  Anim.tween({ duration: 100, done: () => (done = true) });
  await advance(190);
  assert.strictEqual(done, false);
  await advance(10);
  assert.strictEqual(done, true);

  // mid-flight: 100ms at speed 1 (half way), then speed 4 -> the remaining 100ms take 25ms
  Anim.setSpeed(1);
  done = false;
  Anim.tween({ duration: 200, done: () => (done = true) });
  await advance(100);
  Anim.setSpeed(4);
  await advance(20, 5);
  assert.strictEqual(done, false);
  await advance(5, 5);
  assert.strictEqual(done, true);
});

test('setSpeed: ignores nonsense, clamps the range, notifies onChange', () => {
  const seen = [];
  const off = Anim.onChange((s) => seen.push(s));
  Anim.setSpeed(0);
  Anim.setSpeed(-3);
  Anim.setSpeed(NaN);
  Anim.setSpeed('x');
  assert.strictEqual(Anim.speed, 1);
  Anim.setSpeed(1.8);
  assert.strictEqual(Anim.speed, 1.8);
  Anim.setSpeed(1000);
  assert.strictEqual(Anim.speed, 20);
  Anim.setReducedMotion(true);
  Anim.setReducedMotion(true);
  assert.deepStrictEqual(seen, [
    { speed: 1.8, reduced: false },
    { speed: 20, reduced: false },
    { speed: 20, reduced: true },
  ]);
  off();
  Anim.setReducedMotion(false);
  assert.strictEqual(seen.length, 3);
});

test('cancel: stops without update/done, finished resolves false', async () => {
  const seen = [];
  let done = 0;
  const h = Anim.tween({ from: 0, to: 1, duration: 100, update: (v) => seen.push(v), done: () => done++ });
  await advance(30);
  const n = seen.length;
  h.cancel();
  assert.strictEqual(h.running, false);
  assert.strictEqual(Anim.activeCount(), 0);
  h.cancel(); // idempotent
  h.finish(); // no-op after cancel
  await advance(200);
  assert.strictEqual(seen.length, n);
  assert.strictEqual(done, 0);
  assert.strictEqual(await h.finished, false);
});

test('finish: jumps to the end synchronously, done runs, finished resolves true (also during the delay)', async () => {
  const seen = [];
  let done = 0;
  const h = Anim.tween({ from: 0, to: 5, delay: 500, duration: 100, update: (v) => seen.push(v), done: () => done++ });
  await advance(30);
  h.finish();
  assert.deepStrictEqual(seen, [5]);
  assert.strictEqual(done, 1);
  assert.strictEqual(h.running, false);
  h.finish();
  h.cancel();
  assert.strictEqual(done, 1);
  assert.strictEqual(await h.finished, true);
  await advance(700);
  assert.deepStrictEqual(seen, [5]);
});

test('callbacks may cancel/finish themselves and each other; new animations may be started from callbacks', async () => {
  const log = [];
  let other;
  const self = Anim.tween({
    from: 0,
    to: 1,
    duration: 100,
    update: (v) => {
      log.push('self ' + v.toFixed(1));
      if (v > 0.25) {
        self.cancel();
        other.finish();
      }
    },
    done: () => log.push('self done'),
  });
  other = Anim.tween({
    from: 0,
    to: 9,
    duration: 1000,
    ease: 'linear',
    update: (v) => log.push('other ' + v.toFixed(2)),
    done: () => {
      log.push('other done');
      // start a follow-up from inside a done callback
      Anim.tween({ duration: 20, done: () => log.push('follow-up done') });
    },
  });
  const third = Anim.tween({
    duration: 50,
    update: () => {
      third.finish(); // re-entrant finish from its own update
    },
    done: () => log.push('third done'),
  });
  await advance(200);
  assert.strictEqual(await self.finished, false);
  assert.strictEqual(await other.finished, true);
  assert.strictEqual(await third.finished, true);
  assert.ok(log.includes('other 9.00'));
  assert.strictEqual(log.filter((l) => l === 'other done').length, 1);
  assert.strictEqual(log.filter((l) => l === 'third done').length, 1);
  assert.ok(!log.includes('self done'));
  assert.ok(log.includes('follow-up done'));
  assert.strictEqual(Anim.activeCount(), 0);
  assert.strictEqual(errors.length, 0);
});

test('a throwing update/done/ease never kills the loop: others keep running, the tween still completes', async () => {
  let good = 0;
  let after = false;
  const bad = Anim.tween({
    duration: 100,
    update: () => {
      throw new Error('boom');
    },
    done: () => {
      throw new Error('done boom');
    },
  });
  const badEase = Anim.tween({
    duration: 100,
    ease: (t) => {
      if (t > 0.3 && t < 1) throw new Error('ease boom');
      return t;
    },
    update: () => {},
  });
  Anim.tween({ duration: 100, update: () => good++, done: () => (after = true) });
  const stop = Anim.frame(() => {
    throw new Error('subscriber boom');
  });
  await advance(120);
  stop();
  assert.strictEqual(good, 10);
  assert.strictEqual(after, true);
  assert.strictEqual(await bad.finished, true);
  assert.strictEqual(await badEase.finished, true);
  // one report per animation / subscriber, not one per frame
  assert.strictEqual(errors.length, 4, 'update, done, ease and subscriber are each reported once');
  await advance(30);
  assert.strictEqual(Anim._looping, false);
});

// ------------------------------------------------------------------ reduced motion
test('reduced motion: tweens end on the next frame (delay included), springs snap, waits resolve, staggers collapse', async () => {
  Anim.setReducedMotion(true);
  assert.strictEqual(Anim.reduced, true);
  const seen = [];
  let springLast;
  let waited = false;
  const started = [];
  const t = Anim.tween({ from: 0, to: 42, delay: 5000, duration: 5000, update: (v) => seen.push(v) });
  const s = Anim.spring({ from: 0, to: 300, update: (v, vel) => (springLast = [v, vel]) });
  Anim.wait(10000).then((v) => (waited = v));
  const st = Anim.stagger([1, 2, 3, 4], 1000, (item) => {
    started.push(item);
    return Anim.tween({ duration: 3000 });
  });
  assert.deepStrictEqual(started, [1, 2, 3, 4], 'stagger gaps collapse: every item starts at once');
  assert.strictEqual(seen.length, 0, 'still asynchronous');
  await advance(16, 16);
  assert.deepStrictEqual(seen, [42]);
  assert.deepStrictEqual(springLast, [300, 0]);
  assert.strictEqual(waited, true);
  assert.strictEqual(await t.finished, true);
  assert.strictEqual(await s.finished, true);
  assert.deepStrictEqual(await st, [true, true, true, true]);
  assert.strictEqual(Anim.activeCount(), 0);
});

test('reduced motion switched on mid-flight ends running animations on the next frame', async () => {
  let v;
  let x;
  const t = Anim.tween({ from: 0, to: 1, duration: 1000, update: (val) => (v = val) });
  const s = Anim.spring({ from: 0, to: 50, update: (val) => (x = val) });
  await advance(100);
  assert.ok(v > 0 && v < 1);
  Anim.setReducedMotion(true);
  await advance(16, 16);
  assert.strictEqual(v, 1);
  assert.strictEqual(x, 50);
  assert.strictEqual(t.running, false);
  assert.strictEqual(s.running, false);
});

// ------------------------------------------------------------------ the loop
test('the loop sleeps when nothing is running and wakes on demand', async () => {
  assert.strictEqual(Anim._looping, false);
  assert.strictEqual(clock.scheduled, 0);
  const h = Anim.tween({ duration: 40 });
  assert.strictEqual(Anim._looping, true);
  assert.strictEqual(clock.scheduled, 1);
  await advance(40);
  assert.strictEqual(h.running, false);
  assert.strictEqual(Anim._looping, false, 'stops in the very frame the last animation ends');
  assert.strictEqual(clock.scheduled, 0);

  const stop = Anim.frame(() => {});
  assert.strictEqual(clock.scheduled, 1);
  await advance(100);
  assert.strictEqual(clock.scheduled, 1, 'a subscriber keeps it alive');
  stop();
  await advance(10);
  assert.strictEqual(clock.scheduled, 0);

  // a cancelled animation does not keep the loop alive for more than one frame
  Anim.tween({ duration: 5000 }).cancel();
  await advance(10);
  assert.strictEqual(clock.scheduled, 0);
});

test('dt is clamped: a long gap (hidden tab) advances the clock by at most 50ms', async () => {
  const dts = [];
  let v;
  const stop = Anim.frame((dt, now, scaled) => dts.push([dt, scaled]));
  Anim.tween({ from: 0, to: 1000, duration: 1000, ease: 'linear', update: (val) => (v = val) });
  await advance(100);
  near(v, 100, 1e-9);
  clock.frame(60000); // the tab was hidden for a minute
  await flush();
  near(v, 150, 1e-9, 'continues from where it was');
  assert.deepStrictEqual(dts[dts.length - 1], [50, 50]);
  Anim.setSpeed(2);
  clock.frame(20);
  assert.deepStrictEqual(dts[dts.length - 1], [20, 40], 'subscribers get the real dt and the speed-scaled dt');
  stop();
});

test('frame(): gets (dt, now), can stop itself from inside the callback', async () => {
  const calls = [];
  const stop = Anim.frame((dt, now) => {
    calls.push([dt, now]);
    if (calls.length === 3) stop();
  });
  await advance(100);
  assert.strictEqual(calls.length, 3);
  assert.deepStrictEqual(calls[0], [10, 1010]);
  assert.deepStrictEqual(calls[2], [10, 1030]);
  assert.strictEqual(Anim._looping, false);
  assert.strictEqual(typeof Anim.frame('nope'), 'function');
});

test('frame subscribers run after the tweens of the same frame', async () => {
  let value = -1;
  const seen = [];
  Anim.tween({ from: 0, to: 100, duration: 100, ease: 'linear', update: (v) => (value = v) });
  const stop = Anim.frame(() => seen.push(value));
  await advance(30);
  stop();
  assert.deepStrictEqual(seen, [10, 20, 30]);
});

test('nextFrame() and wait(): resolve from a frame, wait is cancellable', async () => {
  let frames = 0;
  Anim.nextFrame().then(() => frames++);
  await flush();
  assert.strictEqual(frames, 0);
  await advance(10);
  assert.strictEqual(frames, 1);

  let w0 = false;
  Anim.wait(0).then(() => (w0 = true));
  await flush();
  assert.strictEqual(w0, false, 'wait(0) still waits for a frame');
  await advance(10);
  assert.strictEqual(w0, true);

  let r = 'pending';
  const w = Anim.wait(1000);
  w.then((v) => (r = v));
  await advance(100);
  w.cancel();
  await flush();
  assert.strictEqual(r, false);
  await advance(20);
  assert.strictEqual(Anim._looping, false);

  let ok;
  Anim.wait(50).then((v) => (ok = v));
  await advance(40);
  assert.strictEqual(ok, undefined);
  await advance(10);
  assert.strictEqual(ok, true);
});

// ------------------------------------------------------------------ springs
/** Closed-form position of a spring from 0 to 1 starting at rest. */
function analytic(t, k, c, m) {
  const w0 = Math.sqrt(k / m);
  const z = c / (2 * Math.sqrt(k * m));
  if (z < 1) {
    const wd = w0 * Math.sqrt(1 - z * z);
    return 1 - Math.exp(-z * w0 * t) * (Math.cos(wd * t) + ((z * w0) / wd) * Math.sin(wd * t));
  }
  if (z === 1) return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  const s = Math.sqrt(z * z - 1);
  const r1 = -w0 * (z - s);
  const r2 = -w0 * (z + s);
  return 1 - (r2 * Math.exp(r1 * t) - r1 * Math.exp(r2 * t)) / (r2 - r1);
}

test('spring: follows the closed-form solution (under-, critically and over-damped)', async () => {
  const cases = [
    { stiffness: 170, damping: 26, mass: 1 },
    { stiffness: 170, damping: 12, mass: 1 },
    { stiffness: 400, damping: 40, mass: 1 }, // critical
    { stiffness: 120, damping: 60, mass: 2 },
    { stiffness: 900, damping: 30, mass: 0.5 },
  ];
  for (const p of cases) {
    Anim._reset();
    clock = makeClock();
    Anim._setClock(clock);
    let x = 0;
    Anim.spring(Object.assign({ from: 0, to: 1, precision: 1e-5, update: (v) => (x = v) }, p));
    let worst = 0;
    for (let ms = 16; ms <= 640; ms += 16) {
      clock.frame(16);
      worst = Math.max(worst, Math.abs(x - analytic(ms / 1000, p.stiffness, p.damping, p.mass)));
    }
    assert.ok(worst < 1e-5, `k=${p.stiffness} c=${p.damping} m=${p.mass}: max error ${worst}`);
  }
});

test('spring: frame-rate independent — 240Hz, 60Hz, 30Hz and jittery frames give the same motion', async () => {
  function sample(frames) {
    Anim._reset();
    const c = makeClock();
    Anim._setClock(c);
    let x = 0;
    let v = 0;
    Anim.spring({ from: 0, to: 500, stiffness: 210, damping: 18, update: (val, vel) => ((x = val), (v = vel)) });
    const out = [];
    let t = 0;
    for (const d of frames) {
      c.frame(d);
      t += d;
      if (Math.abs(t % 100) < 1e-6 || Math.abs((t % 100) - 100) < 1e-6) out.push(x);
    }
    return out;
  }
  const hz240 = sample(new Array(144).fill(600 / 144));
  const hz60 = sample(new Array(36).fill(600 / 36));
  const hz30 = sample(new Array(18).fill(600 / 18));
  const jitter = [];
  for (let i = 0; i < 20; i++) jitter.push(7, 23, 12, 31, 27); // 100ms per group
  const jit = sample(jitter.slice(0, 30));
  assert.strictEqual(hz240.length, 6);
  for (let i = 0; i < 6; i++) {
    near(hz60[i], hz240[i], 0.001, `60Hz vs 240Hz at ${(i + 1) * 100}ms`);
    near(hz30[i], hz240[i], 0.001, `30Hz vs 240Hz at ${(i + 1) * 100}ms`);
    near(jit[i], hz240[i], 0.001, `jittery vs 240Hz at ${(i + 1) * 100}ms`);
  }
});

test('spring: comes to rest exactly on the target with velocity 0, then done + finished(true)', async () => {
  const seen = [];
  let done = 0;
  const s = Anim.spring({ from: 0, to: 120, update: (v, vel) => seen.push([v, vel]), done: () => done++ });
  await advance(3000, 16);
  assert.deepStrictEqual(seen[seen.length - 1], [120, 0]);
  assert.strictEqual(done, 1);
  assert.strictEqual(s.running, false);
  assert.strictEqual(await s.finished, true);
  assert.strictEqual(s.value, 120);
  assert.strictEqual(s.velocity, 0);
  assert.ok(seen.length < 120, `default spring settles in under 2s (took ${seen.length} frames)`);
  const overshoot = Math.max(...seen.map((p) => p[0]));
  assert.ok(overshoot <= 120.6, 'default spring barely overshoots');
  assert.strictEqual(Anim._looping, false);
});

test('spring: an underdamped spring overshoots; initial velocity is honoured', async () => {
  let max = 0;
  Anim.spring({ from: 0, to: 100, stiffness: 300, damping: 10, update: (v) => (max = Math.max(max, v)) });
  await advance(2000, 16);
  assert.ok(max > 120, 'overshoot expected, max ' + max);

  let min = 0;
  const s = Anim.spring({ from: 0, to: 0, velocity: -800, update: (v) => (min = Math.min(min, v)) });
  await advance(3000, 16);
  assert.ok(min < -20, 'kicked away from the target, min ' + min);
  assert.strictEqual(s.value, 0);
});

test('spring: setTarget retargets mid-flight without a jump in value or velocity', async () => {
  const seen = [];
  const s = Anim.spring({ from: 0, to: 100, update: (v, vel) => seen.push([v, vel]) });
  await advance(96, 16);
  const [x0, v0] = seen[seen.length - 1];
  assert.ok(x0 > 5 && x0 < 100 && v0 > 0);
  assert.strictEqual(s.setTarget(-50), s, 'chainable');
  assert.strictEqual(s.target, -50);
  clock.frame(16);
  const [x1, v1] = seen[seen.length - 1];
  assert.ok(Math.abs(x1 - x0) < Math.abs(v0) * 0.016 * 1.5 + 1, 'position continues smoothly');
  assert.ok(v1 < v0 && v1 > v0 - 600, 'velocity bends instead of resetting');
  await advance(3000, 16);
  assert.deepStrictEqual(seen[seen.length - 1], [-50, 0]);
  assert.strictEqual(await s.finished, true);
});

test('spring: setTarget on a spring at rest starts a new run (fresh finished promise, done again)', async () => {
  let done = 0;
  let x;
  const s = Anim.spring({ from: 0, to: 10, update: (v) => (x = v), done: () => done++ });
  await advance(2000, 16);
  const first = s.finished;
  assert.strictEqual(await first, true);
  assert.strictEqual(done, 1);
  assert.strictEqual(Anim.activeCount(), 0);

  s.setTarget(10); // unchanged target: stays at rest
  assert.strictEqual(s.running, false);

  s.setTarget(80);
  assert.strictEqual(s.running, true);
  assert.strictEqual(Anim.activeCount(), 1);
  const second = s.finished;
  assert.notStrictEqual(second, first);
  await advance(48, 16);
  assert.ok(x > 10 && x < 80);
  await advance(2000, 16);
  assert.strictEqual(x, 80);
  assert.strictEqual(done, 2);
  assert.strictEqual(await second, true);

  // retarget from inside done(): keeps going
  let hops = 0;
  const p = Anim.spring({
    from: 0,
    to: 5,
    done: () => {
      if (++hops < 3) p.setTarget(hops * 20);
    },
  });
  await advance(6000, 16);
  assert.strictEqual(hops, 3);
  assert.strictEqual(p.value, 40);
  assert.strictEqual(Anim.activeCount(), 0);

  // after cancel() a spring is dead for good
  const dead = Anim.spring({ from: 0, to: 1 });
  dead.cancel();
  dead.setTarget(5);
  dead.nudge(100);
  assert.strictEqual(dead.running, false);
  assert.strictEqual(await dead.finished, false);
});

test('spring: objects of numbers, partial retarget, reused output objects', async () => {
  const outs = new Set();
  let last;
  let lastVel;
  const s = Anim.spring({
    from: { x: 0, y: 0, r: 10 },
    to: { x: 100, y: -40 },
    velocity: { x: 500 },
    update: (o, vel) => {
      outs.add(o);
      last = Object.assign({}, o);
      lastVel = Object.assign({}, vel);
    },
  });
  await advance(64, 16);
  assert.ok(last.x > 0 && last.y < 0);
  assert.strictEqual(last.r, 10, 'a key without a target stays put');
  assert.ok(lastVel.x > 0);
  s.setTarget({ y: 200 });
  assert.deepStrictEqual(s.target, { x: 100, y: 200, r: 10 });
  await advance(3000, 16);
  assert.deepStrictEqual(last, { x: 100, y: 200, r: 10 });
  assert.deepStrictEqual(lastVel, { x: 0, y: 0, r: 0 });
  assert.strictEqual(outs.size, 1);
  assert.deepStrictEqual(Object.assign({}, s.value), { x: 100, y: 200, r: 10 });
});

test('spring: nudge kicks a resting spring; finish() snaps; cancel() freezes', async () => {
  let x = 0;
  let peak = 0;
  const s = Anim.spring({ from: 0, to: 0, update: (v) => ((x = v), (peak = Math.max(peak, Math.abs(v)))) });
  await advance(32, 16);
  assert.strictEqual(s.running, false);
  s.nudge(600);
  assert.strictEqual(s.running, true);
  await advance(3000, 16);
  assert.ok(peak > 10, 'the kick moved it, peak ' + peak);
  assert.strictEqual(x, 0);

  const seen = [];
  const f = Anim.spring({ from: 0, to: 77, update: (v, vel) => seen.push([v, vel]) });
  await advance(32, 16);
  f.finish();
  assert.deepStrictEqual(seen[seen.length - 1], [77, 0]);
  assert.strictEqual(await f.finished, true);

  let y;
  const c = Anim.spring({ from: 0, to: 77, update: (v) => (y = v) });
  await advance(48, 16);
  const frozen = y;
  c.cancel();
  await advance(500, 16);
  assert.strictEqual(y, frozen);
  assert.strictEqual(await c.finished, false);
});

test('spring: extreme parameters stay finite and terminate', async () => {
  const configs = [
    { stiffness: 50000, damping: 5 },
    { stiffness: 20, damping: 4000 },
    { stiffness: 1e14, damping: 1 },
    { stiffness: 170, damping: 0 }, // never loses energy: put to rest by the safety net
    { stiffness: -5, damping: -5, mass: 0, precision: -1 }, // nonsense falls back to defaults
    { stiffness: 170, damping: 26, mass: 1e-6 },
  ];
  const springs = configs.map((cfg) => {
    const state = { ok: true, last: null };
    state.handle = Anim.spring(
      Object.assign({ from: 0, to: 100, update: (v) => ((state.last = v), (state.ok = state.ok && Number.isFinite(v))) }, cfg)
    );
    return state;
  });
  await advance(25000, 50);
  for (const [i, s] of springs.entries()) {
    assert.ok(s.ok, `config ${i} produced a non-finite value`);
    assert.strictEqual(s.last, 100, `config ${i} ended on the target`);
    assert.strictEqual(s.handle.running, false, `config ${i} terminated`);
  }
  assert.strictEqual(Anim.activeCount(), 0);
});

test('spring: speed scales the simulation', async () => {
  function settleTime(speed) {
    Anim._reset();
    const c = makeClock();
    Anim._setClock(c);
    Anim.setSpeed(speed);
    const s = Anim.spring({ from: 0, to: 100 });
    let ms = 0;
    while (s.running && ms < 20000) {
      c.frame(4);
      ms += 4;
    }
    return ms;
  }
  const t1 = settleTime(1);
  const t2 = settleTime(2);
  near(t2, t1 / 2, 8, 'speed 2 settles in half the time');
});

// ------------------------------------------------------------------ stagger / all / idle
test('stagger: first item now, then one every gap; resolves when everything returned has finished', async () => {
  const starts = [];
  let resolved = null;
  const p = Anim.stagger(['a', 'b', 'c', 'd'], 50, (item, i) => {
    starts.push([item, i, clock.now() - 1000]);
    return Anim.tween({ duration: 100 });
  });
  p.then((r) => (resolved = r));
  assert.deepStrictEqual(starts, [['a', 0, 0]], 'item 0 starts synchronously');
  assert.strictEqual(Anim.activeCount(), 2, 'one tween + the stagger itself');
  await advance(149);
  assert.deepStrictEqual(
    starts.map((s) => s[2]),
    [0, 50, 100]
  );
  assert.ok(Anim.activeCount() >= 1);
  await advance(1);
  assert.strictEqual(starts.length, 4);
  assert.strictEqual(resolved, null);
  await advance(99);
  assert.strictEqual(resolved, null, 'the last tween is still running');
  await advance(1);
  assert.deepStrictEqual(resolved, [true, true, true, true]);
  assert.strictEqual(Anim.activeCount(), 0);
});

test('stagger: sub-frame gaps stay evenly spaced (animations are back-dated)', async () => {
  const progress = [];
  Anim.stagger([0, 1, 2, 3, 4, 5, 6, 7], 8, (item) =>
    Anim.tween({ from: 0, to: 1000, duration: 1000, ease: 'linear', update: (v) => (progress[item] = v) })
  );
  await advance(160, 16);
  for (let i = 1; i < 8; i++) {
    near(progress[i - 1] - progress[i], 8, 1e-6, `gap between item ${i - 1} and ${i}`);
  }
  near(progress[0], 160, 1e-6);
});

test('stagger: speed-scaled gaps, mixed return values, throwing callbacks, empty lists, cancel', async () => {
  Anim.setSpeed(2);
  const starts = [];
  const p = Anim.stagger(new Set([1, 2, 3]), 100, (item) => {
    starts.push(clock.now() - 1000);
    if (item === 1) return Anim.wait(10).then(() => 'waited');
    if (item === 2) throw new Error('stagger boom');
    return [Anim.tween({ duration: 10 }), Promise.reject(new Error('rejected'))];
  });
  await advance(120);
  assert.deepStrictEqual(starts, [0, 50, 100]);
  assert.deepStrictEqual(await p, ['waited', false, [true, false]]);
  assert.strictEqual(errors.length, 2, 'the throw and the rejection are reported');
  Anim.setSpeed(1);

  assert.deepStrictEqual(await Anim.stagger([], 100, () => {}), []);
  assert.deepStrictEqual(await Anim.stagger(null, 100, () => {}), []);
  let all = 0;
  await Anim.stagger([1, 2, 3], 0, () => {
    all++;
  });
  assert.strictEqual(all, 3);

  const fired = [];
  const c = Anim.stagger([1, 2, 3, 4, 5], 40, (item) => {
    fired.push(item);
  });
  await advance(50);
  c.cancel();
  await advance(400);
  assert.deepStrictEqual(fired, [1, 2]);
  assert.deepStrictEqual(await c, [undefined, undefined, undefined, undefined, undefined]);
  assert.strictEqual(Anim.activeCount(), 0);
  assert.strictEqual(Anim._looping, false);
});

test('all(): waits for handles and promises, never rejects', async () => {
  const a = Anim.tween({ duration: 30 });
  const b = Anim.tween({ duration: 60 });
  const c = Anim.spring({ from: 0, to: 1 });
  c.cancel();
  let result = null;
  Anim.all([a, b, c, Anim.wait(20), Promise.reject(new Error('nope')), 7, null]).then((r) => (result = r));
  await advance(50);
  assert.strictEqual(result, null);
  await advance(10);
  assert.deepStrictEqual(result, [true, true, false, true, false, 7, null]);
  assert.deepStrictEqual(await Anim.all([]), []);
  assert.deepStrictEqual(await Anim.all(null), []);
  const single = Anim.all(Anim.tween({ duration: 0 })); // a single handle instead of a list
  await advance(10);
  assert.deepStrictEqual(await single, [true]);
});

test('activeCount() and idle()', async () => {
  assert.strictEqual(Anim.activeCount(), 0);
  let idle = false;
  await Anim.idle(); // nothing running: resolves immediately, without needing a frame
  assert.strictEqual(clock.scheduled, 0);

  Anim.tween({ duration: 40 });
  Anim.spring({ from: 0, to: 30 });
  assert.strictEqual(Anim.activeCount(), 2);
  Anim.idle().then(() => (idle = true));
  await advance(40);
  assert.strictEqual(Anim.activeCount(), 1);
  assert.strictEqual(idle, false);
  await advance(3000, 16);
  assert.strictEqual(Anim.activeCount(), 0);
  assert.strictEqual(idle, true);
  assert.strictEqual(Anim._looping, false);

  // a chain started from a promise continuation keeps idle() pending until the whole chain is done
  idle = false;
  let chained = false;
  Anim.tween({ duration: 20 }).finished.then(() => Anim.tween({ duration: 20, done: () => (chained = true) }));
  Anim.idle().then(() => (idle = true));
  await advance(30);
  assert.strictEqual(idle, false, 'the follow-up tween is running');
  await advance(30);
  assert.strictEqual(chained, true);
  assert.strictEqual(idle, true);

  // a stagger with gaps longer than its animations still counts as active between items
  idle = false;
  Anim.stagger([1, 2, 3], 100, () => Anim.tween({ duration: 10 }));
  Anim.idle().then(() => (idle = true));
  await advance(60);
  assert.strictEqual(Anim.activeCount(), 1, 'no tween is running but the stagger is not done');
  assert.strictEqual(idle, false);
  await advance(200);
  assert.strictEqual(idle, true);
});

test('garbage in never throws, never hangs the clock', async () => {
  const junk = [undefined, null, NaN, Infinity, -1, 0, '', 'abc', {}, [], () => {}, { x: 'y' }, true];
  const handles = [];
  for (const a of junk) {
    for (const b of junk) {
      assert.doesNotThrow(() => {
        handles.push(Anim.tween({ duration: a, delay: b === Infinity ? 0 : b, from: a, to: b, ease: a, update: b, done: a }));
        handles.push(Anim.spring({ from: a, to: b, velocity: a, stiffness: b, damping: a, mass: b, precision: a, update: b, done: a }));
        Anim.arc(a, b, a)(0.5);
        Anim.arc(a, b, { lift: a, side: b })(0.5);
        Anim.bezier(a, b, a, b)(0.5);
        Anim.lerp(a, b, 0.5);
        Anim.clamp(a, b, a);
        Anim.mapRange(a, b, a, b, a, b);
        Anim.setSpeed(a);
        Anim.setReducedMotion(false);
      });
    }
    assert.doesNotThrow(() => {
      Anim.tween(a);
      Anim.spring(a);
      Anim.frame(a)();
      Anim.onChange(a)();
      Anim.all(a);
      Anim.stagger(a === Infinity || typeof a === 'number' || typeof a === 'boolean' || typeof a === 'function' ? null : a, a, a);
      const w = Anim.wait(a === Infinity ? 0 : a);
      w.cancel();
    });
  }
  for (const h of handles) {
    assert.doesNotThrow(() => {
      h.setTarget && h.setTarget(NaN);
      h.setTarget && h.setTarget({ nope: 1 });
      h.nudge && h.nudge('x');
    });
  }
  Anim.setSpeed(1);
  await advance(400, 16);
  // whatever is still running (endless durations) can be stopped and the loop goes back to sleep
  for (const h of handles) {
    h.finish();
    h.cancel();
  }
  await advance(64, 16);
  assert.strictEqual(Anim.activeCount(), 0);
  assert.strictEqual(Anim._looping, false);
  assert.strictEqual(Anim.speed, 1);
});

test('finish()/cancel() called from inside the final or the resting update do not recurse', async () => {
  let calls = 0;
  const t = Anim.tween({
    duration: 30,
    update: (e, raw) => {
      calls++;
      if (raw === 1) {
        t.finish();
        t.finish();
      }
    },
  });
  await advance(40);
  assert.strictEqual(await t.finished, true);
  assert.strictEqual(calls, 3, 'two in-flight frames + exactly one final call');

  let rests = 0;
  const s = Anim.spring({
    from: 0,
    to: 1,
    update: (v, vel) => {
      if (v === 1 && vel === 0) {
        rests++;
        s.finish();
      }
    },
  });
  await advance(3000, 16);
  assert.strictEqual(rests, 1);
  assert.strictEqual(await s.finished, true);

  // cancelling inside the final update: the value was delivered, but the handle reports "cancelled"
  let last;
  const c = Anim.tween({ from: 0, to: 5, duration: 20, update: (v, raw) => { last = v; if (raw === 1) c.cancel(); } });
  await advance(30);
  assert.strictEqual(last, 5);
  assert.strictEqual(await c.finished, false);
  assert.strictEqual(errors.length, 0);
});

// ------------------------------------------------------------------ pure helpers
test('ease: every curve starts at 0 and ends at 1; shapes are sane', () => {
  const names = [
    'linear', 'inQuad', 'outQuad', 'inOutQuad', 'inCubic', 'outCubic', 'inOutCubic', 'outQuart', 'outQuint',
    'outExpo', 'inOutSine', 'inBack', 'outBack', 'inOutBack', 'outElastic', 'outBounce',
  ];
  assert.deepStrictEqual(Object.keys(Anim.ease).sort(), names.slice().sort());
  for (const name of names) {
    const fn = Anim.ease[name];
    near(fn(0), 0, 1e-9, name + '(0)');
    near(fn(1), 1, 1e-9, name + '(1)');
    for (let t = 0; t <= 1; t += 0.01) assert.ok(Number.isFinite(fn(t)), `${name}(${t}) is finite`);
  }
  // monotonic curves
  for (const name of ['linear', 'inQuad', 'outQuad', 'inOutQuad', 'inCubic', 'outCubic', 'inOutCubic', 'outQuart', 'outQuint', 'outExpo', 'inOutSine']) {
    let prev = -1;
    for (let t = 0; t <= 1.0001; t += 0.02) {
      const v = Anim.ease[name](Math.min(t, 1));
      assert.ok(v >= prev - 1e-12, name + ' is monotonic');
      prev = v;
    }
  }
  assert.ok(Anim.ease.outCubic(0.5) > 0.5 && Anim.ease.inCubic(0.5) < 0.5);
  near(Anim.ease.inOutCubic(0.5), 0.5, 1e-12);
  near(Anim.ease.inOutBack(0.5), 0.5, 1e-12);
  assert.ok(Anim.ease.inBack(0.3) < 0, 'inBack dips below 0');
  let maxBack = 0;
  let maxElastic = 0;
  for (let t = 0; t <= 1; t += 0.01) {
    maxBack = Math.max(maxBack, Anim.ease.outBack(t));
    maxElastic = Math.max(maxElastic, Anim.ease.outElastic(t));
  }
  assert.ok(maxBack > 1.05 && maxBack < 1.15, 'outBack overshoots by about 10%');
  assert.ok(maxElastic > 1.2);
  assert.ok(Anim.ease.outBounce(0.5) > 0.7 && Anim.ease.outBounce(0.5) < 0.8);
});

test('bezier(): matches the CSS timing functions', () => {
  const cssEase = Anim.bezier(0.25, 0.1, 0.25, 1);
  near(cssEase(0), 0, 0);
  near(cssEase(1), 1, 0);
  near(cssEase(0.5), 0.8024, 0.0005);
  near(cssEase(0.25), 0.4085, 0.0005);
  const inOut = Anim.bezier(0.42, 0, 0.58, 1);
  near(inOut(0.5), 0.5, 1e-6);
  near(inOut(0.25), 0.1291, 0.0005);
  const back = Anim.bezier(0.34, 1.56, 0.64, 1);
  let max = 0;
  for (let t = 0; t <= 1; t += 0.01) max = Math.max(max, back(t));
  assert.ok(max > 1.05, 'y may leave 0..1');
  assert.strictEqual(Anim.bezier(0.3, 0.3, 0.7, 0.7), Anim.ease.linear);
  // brute-force check of the solver on an awkward curve
  const steep = Anim.bezier(0.9, 0.05, 0.1, 0.95);
  for (let x = 0.05; x < 1; x += 0.05) {
    // find t with bisection on x(t), compare y
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      const u = 1 - mid;
      const bx = 3 * u * u * mid * 0.9 + 3 * u * mid * mid * 0.1 + mid * mid * mid;
      if (bx < x) lo = mid;
      else hi = mid;
    }
    const u = 1 - lo;
    const y = 3 * u * u * lo * 0.05 + 3 * u * lo * lo * 0.95 + lo * lo * lo;
    near(steep(x), y, 1e-4, `steep(${x.toFixed(2)})`);
  }
  // usable as a tween ease
  assert.strictEqual(typeof Anim.tween({ ease: cssEase }).cancel, 'function');
});

test('lerp / clamp / mapRange', () => {
  assert.strictEqual(Anim.lerp(10, 20, 0.25), 12.5);
  assert.strictEqual(Anim.lerp(10, 20, 1.5), 25);
  assert.strictEqual(Anim.clamp(5, 0, 3), 3);
  assert.strictEqual(Anim.clamp(-5, 0, 3), 0);
  assert.strictEqual(Anim.clamp(2, 0, 3), 2);
  assert.strictEqual(Anim.mapRange(5, 0, 10, 100, 200), 150);
  assert.strictEqual(Anim.mapRange(15, 0, 10, 100, 200), 250);
  assert.strictEqual(Anim.mapRange(15, 0, 10, 100, 200, true), 200);
  assert.strictEqual(Anim.mapRange(-5, 0, 10, 100, 200, true), 100);
  assert.strictEqual(Anim.mapRange(2, 0, 10, 1, 0), 0.8);
  assert.strictEqual(Anim.mapRange(3, 4, 4, 7, 9), 7, 'an empty input range does not divide by zero');
});

test('arc(): exact end points, lift raises the middle, side bows it sideways, shared output object', () => {
  const path = Anim.arc({ x: 100, y: 400 }, { x: 500, y: 400 }, { lift: 80 });
  assert.deepStrictEqual(Object.assign({}, path(0)), { x: 100, y: 400 });
  assert.deepStrictEqual(Object.assign({}, path(1)), { x: 500, y: 400 });
  const mid = path(0.5);
  near(mid.x, 300, 1e-9);
  near(mid.y, 320, 1e-9, 'the midpoint is lifted by exactly `lift`');
  assert.strictEqual(path(0.2), path(0.8), 'one shared object by default');
  const own = {};
  assert.strictEqual(path(0.3, own), own);
  assert.notStrictEqual(own, path(0.3));

  // side: travelling right, positive side bows towards the bottom of the screen (the traveller's right)
  const sideways = Anim.arc({ x: 0, y: 0 }, { x: 200, y: 0 }, { lift: 0, side: 30 });
  near(sideways(0.5).y, 30, 1e-9);
  // travelling down, positive side bows towards the left of the screen
  const down = Anim.arc({ x: 0, y: 0 }, { x: 0, y: 200 }, { lift: 0, side: 30 });
  near(down(0.5).x, -30, 1e-9);
  near(down(0.5).y, 100, 1e-9);

  // default lift: 22% of the distance, capped at 140
  near(Anim.arc({ x: 0, y: 0 }, { x: 100, y: 0 })(0.5).y, -22, 1e-9);
  near(Anim.arc({ x: 0, y: 0 }, { x: 5000, y: 0 })(0.5).y, -140, 1e-9);
  // zero-length paths and overshoot are fine
  const still = Anim.arc({ x: 7, y: 9 }, { x: 7, y: 9 });
  assert.deepStrictEqual(Object.assign({}, still(0.5)), { x: 7, y: 9 });
  const over = path(1.1);
  assert.ok(over.x > 500 && Number.isFinite(over.y));
  // direction of travel
  near(Anim.arc({ x: 0, y: 0 }, { x: 100, y: 0 }, { lift: 0 }).angle(0.5), 0, 1e-9);
  assert.ok(path.angle(0) < 0, 'starts by heading up');
  assert.ok(path.angle(1) > 0, 'ends heading down');
  // missing points do not throw
  assert.doesNotThrow(() => Anim.arc()(0.5));
});
