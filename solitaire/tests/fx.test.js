/*
 * SOL.FX — how often it asks for frames. The effects themselves need a real canvas and are checked in a browser;
 * what can be pinned down here is the frame budget of a table at rest: the ambient layer, alone, must not keep
 * the shared 60 Hz loop running — it gets one frame every 50 ms from a timer of its own.
 *
 * FX runs against a fake canvas (every drawing call is a counted no-op), SOL.Anim against a hand-cranked frame
 * clock and FX's timer against node:test's mock timers.
 * Run with: node --test solitaire/tests/
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

// ------------------------------------------------------------------ a document that is just enough for FX
function fakeContext(calls) {
  return new Proxy(
    {},
    {
      get(target, key) {
        if (key in target) return target[key];
        if (key === 'measureText') return () => ({ width: 10 });
        if (key === 'createRadialGradient' || key === 'createLinearGradient') return () => ({ addColorStop() {} });
        return function () {
          if (calls) calls[key] = (calls[key] || 0) + 1;
        };
      },
      set(target, key, value) {
        target[key] = value;
        return true;
      },
    }
  );
}

function fakeCanvas(calls) {
  const ctx = fakeContext(calls);
  return {
    width: 0,
    height: 0,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 390, height: 844 }),
  };
}

globalThis.document = {
  createElement: () => fakeCanvas(null),
  documentElement: { getAttribute: () => 'emerald' },
};
if (typeof globalThis.addEventListener !== 'function') globalThis.addEventListener = function () {};

const Anim = require('../js/view/anim.js');
require('../js/view/fx.js');
const FX = globalThis.SOL.FX;

// ------------------------------------------------------------------ harness
function makeClock() {
  let t = 1000;
  let nextId = 1;
  const queue = new Map();
  return {
    requests: 0,
    now: () => t,
    request(fn) {
      const id = nextId++;
      this.requests++;
      queue.set(id, fn);
      return id;
    },
    cancel(id) {
      queue.delete(id);
    },
    get scheduled() {
      return queue.size;
    },
    /** Time passes without a frame (the loop is asleep, a timer is running). */
    pass(ms) {
      t += ms;
    },
    /** Runs one frame `ms` after the previous point in time. */
    frame(ms = 16) {
      t += ms;
      const fns = Array.from(queue.values());
      queue.clear();
      for (const fn of fns) fn(t);
    },
  };
}

let clock;
let back;
let front;

/** A fresh FX on fresh canvases, the ambient layer wanted, nothing drawn yet. */
function boot(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  Anim._reset();
  clock = makeClock();
  Anim._setClock(clock);
  back = {};
  front = {};
  FX.ambient(false);
  FX.setQuality('high');
  FX.init({ back: fakeCanvas(back), front: fakeCanvas(front) });
  FX.ambient(true, { theme: 'emerald' });
}

/**
 * Runs one test on a booted FX and puts FX to rest afterwards, inside the same mock-timer scope (a timer handle
 * that outlives its MockTimers instance must not be cleared in the next one).
 */
function fxTest(name, body) {
  test(name, (t) => {
    boot(t);
    try {
      body(t);
    } finally {
      FX.ambient(false);
      FX.init({ back: fakeCanvas(null), front: fakeCanvas(null) }); // drops every subscription and timer
      Anim._reset();
    }
  });
}

// The slow clock beats every 50 ms of frame time and asks for its frame 6 ms early: with frames that arrive
// exactly on the beat its timer is always 44 ms.
const BEAT = 50;
const TIMER = 44;

/** One turn of the slow clock: the timer runs out, the frame it asked for is delivered on the beat. */
function slowTurn(t) {
  t.mock.timers.tick(TIMER);
  clock.frame(BEAT);
}

// ------------------------------------------------------------------ tests
fxTest('the ambient layer alone hands the 60 Hz loop back after one frame', (t) => {
  assert.strictEqual(FX.stats().awake, true);
  assert.strictEqual(clock.scheduled, 1, 'it starts in the frame loop');
  clock.frame();
  const s = FX.stats();
  assert.strictEqual(s.idle, true, 'on its slow clock');
  assert.strictEqual(s.awake, true, 'still alive');
  assert.strictEqual(Anim._looping, false, 'the shared loop sleeps');
  assert.strictEqual(clock.scheduled, 0, 'no frame is asked for');
  assert.ok(back.drawImage > 0, 'the first frame painted the layer');
});

fxTest('at rest the ambient layer costs one frame per 50 ms beat: 20 a second, not 60', (t) => {
  clock.frame();
  const requests0 = clock.requests;
  let painted = 0;
  for (let i = 0; i < 20; i++) {
    // the timer has not run out yet: nothing happens, however much frame time passes elsewhere
    t.mock.timers.tick(TIMER - 1);
    assert.strictEqual(clock.scheduled, 0);
    t.mock.timers.tick(1);
    assert.strictEqual(clock.scheduled, 1, 'the timer asks for one frame');
    const before = back.drawImage;
    clock.frame(BEAT);
    if (back.drawImage > before) painted++;
    assert.strictEqual(Anim._looping, false, 'and the loop is asleep again right after it');
    assert.strictEqual(clock.scheduled, 0);
  }
  assert.strictEqual(clock.requests - requests0, 20, 'exactly one frame request per ambient frame');
  assert.strictEqual(painted, 20, 'every one of them repaints the layer');
  assert.ok(FX.stats().ambient > 0.9, 'and it has faded in meanwhile (900 ms)');
});

fxTest('a frame that arrives late does not slow the beat down: the next timer is that much shorter', (t) => {
  clock.frame();
  slowTurn(t);
  // this one is delivered 12 ms after its beat (a busy main thread, a slow timer)
  t.mock.timers.tick(TIMER);
  clock.frame(BEAT + 12);
  t.mock.timers.tick(TIMER - 12 - 1);
  assert.strictEqual(clock.scheduled, 0);
  t.mock.timers.tick(1);
  assert.strictEqual(clock.scheduled, 1, 'the timer made up for the 12 ms');
  clock.frame(BEAT - 12);
  // …and a frame that is hopelessly late starts a new beat instead of a burst of catch-up frames
  t.mock.timers.tick(TIMER);
  clock.frame(400);
  const requests0 = clock.requests;
  t.mock.timers.tick(7);
  assert.strictEqual(clock.scheduled, 0);
  t.mock.timers.tick(1);
  assert.strictEqual(clock.scheduled, 1);
  clock.frame(16);
  slowTurn(t);
  slowTurn(t);
  assert.strictEqual(clock.requests - requests0, 3, 'one frame per beat again');
});

fxTest('an effect brings the full-rate loop back in the same call; afterwards the slow clock returns', (t) => {
  clock.frame();
  slowTurn(t);
  assert.strictEqual(FX.stats().idle, true);
  FX.ring(100, 100, { duration: 200 });
  assert.strictEqual(FX.stats().idle, false);
  assert.strictEqual(Anim._looping, true, 'woken synchronously');
  assert.strictEqual(clock.scheduled, 1);
  // the timer of the slow clock is gone: it must not ask for frames of its own while the loop runs
  const requests0 = clock.requests;
  let frames = 0;
  while (FX.stats().rings > 0 && frames < 100) {
    clock.frame(16);
    frames++;
    t.mock.timers.tick(16);
  }
  assert.ok(frames >= 12 && frames <= 14, 'the ring got every frame of its 200 ms (' + frames + ')');
  // one more frame wipes what the ring left on the front canvas, then only the ambient layer is left
  for (let i = 0; i < 3 && !FX.stats().idle; i++) clock.frame(16);
  assert.strictEqual(FX.stats().idle, true);
  assert.strictEqual(Anim._looping, false);
  assert.ok(clock.requests - requests0 <= frames + 3, 'no extra frame requests while the loop ran');
  slowTurn(t);
  assert.strictEqual(FX.stats().idle, true, 'and the slow clock ticks on');
});

fxTest('ambient off: it fades out on the slow clock, then nothing runs at all', (t) => {
  clock.frame();
  for (let i = 0; i < 20; i++) slowTurn(t);
  assert.ok(FX.stats().ambient > 0.9);
  FX.ambient(false);
  clock.frame(16); // the wake-up frame: back to the slow clock for the fade
  for (let i = 0; i < 12; i++) slowTurn(t);
  const s = FX.stats();
  assert.strictEqual(s.ambient, 0, 'faded out (450 ms)');
  assert.strictEqual(s.awake, false);
  assert.strictEqual(s.idle, false);
  const requests0 = clock.requests;
  t.mock.timers.tick(5000);
  assert.strictEqual(clock.requests, requests0, 'no timer is left running');
  assert.strictEqual(Anim._looping, false);
});

fxTest('effects quality low and reduced motion both stop the slow clock', (t) => {
  clock.frame();
  for (let i = 0; i < 6; i++) slowTurn(t);
  FX.setQuality('low'); // no ambient layer in low quality: it fades out and FX goes to sleep
  clock.frame(16);
  for (let i = 0; i < 12 && FX.stats().awake; i++) slowTurn(t);
  assert.strictEqual(FX.stats().awake, false);

  FX.setQuality('high');
  clock.frame(16);
  for (let i = 0; i < 6; i++) slowTurn(t);
  assert.strictEqual(FX.stats().idle, true);
  Anim.setReducedMotion(true); // FX wipes its canvases on the next frame and sleeps
  clock.frame(16);
  assert.strictEqual(FX.stats().awake, false);
  assert.strictEqual(FX.stats().ambient, 0);
  const requests0 = clock.requests;
  t.mock.timers.tick(5000);
  clock.pass(5000);
  assert.strictEqual(clock.requests, requests0);
  Anim.setReducedMotion(false);
});
