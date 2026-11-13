/*
 * SOL.Audio — logic tests that do not need a browser.
 *
 * The sound itself is verified in Chromium (dev/audio-demo.html renders every sound through an
 * OfflineAudioContext and measures it). What can be checked here, against a strict fake of the
 * WebAudio API that throws exactly where real browsers throw, is everything around it:
 * robustness, scheduling on the context clock, the polyphony limiter, the foundation scale and
 * the autoplay / suspend state machine.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------- a strict fake of WebAudio
const SAMPLE_RATE = 48000;

function finite(v, what) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(what + ' must be a finite number, got ' + v);
}

class FakeParam {
  constructor(value) {
    this._value = value;
    this.events = [];
    this.curves = [];
  }
  get value() {
    return this._value;
  }
  set value(v) {
    finite(v, 'AudioParam.value');
    this._value = v;
  }
  _add(kind, v, t) {
    finite(v, kind + ' value');
    finite(t, kind + ' time');
    if (t < 0) throw new RangeError(kind + ': negative time');
    for (const c of this.curves) {
      if (t > c[0] && t < c[1]) throw new Error('NotSupportedError: ' + kind + ' overlaps a value curve');
    }
    this.events.push({ kind: kind, value: v, time: t });
    return this;
  }
  setValueAtTime(v, t) {
    return this._add('setValueAtTime', v, t);
  }
  linearRampToValueAtTime(v, t) {
    return this._add('linearRampToValueAtTime', v, t);
  }
  exponentialRampToValueAtTime(v, t) {
    if (!(v > 0)) throw new RangeError('exponentialRampToValueAtTime: value must be > 0, got ' + v);
    const prev = this.events[this.events.length - 1];
    if (prev && !(prev.value > 0)) throw new RangeError('exponentialRampToValueAtTime: ramp from a non-positive value');
    return this._add('exponentialRampToValueAtTime', v, t);
  }
  setTargetAtTime(v, t, tc) {
    finite(tc, 'timeConstant');
    if (tc < 0) throw new RangeError('setTargetAtTime: negative time constant');
    return this._add('setTargetAtTime', v, t);
  }
  setValueCurveAtTime(curve, t, d) {
    finite(t, 'curve time');
    finite(d, 'curve duration');
    if (!(d > 0)) throw new RangeError('setValueCurveAtTime: duration must be > 0');
    if (!curve || curve.length < 2) throw new Error('InvalidStateError: curve needs at least 2 points');
    for (let i = 0; i < curve.length; i++) finite(curve[i], 'curve point');
    for (const e of this.events) {
      if (e.time >= t && e.time < t + d) throw new Error('NotSupportedError: value curve overlaps an event');
    }
    this.curves.push([t, t + d]);
    return this;
  }
}

class FakeNode {
  constructor(ctx, kind, params) {
    this.ctx = ctx;
    this.kind = kind;
    this.outs = [];
    this.disconnected = false;
    for (const name of Object.keys(params || {})) this[name] = new FakeParam(params[name]);
    ctx.nodes.push(this);
  }
  connect(dest) {
    if (!(dest instanceof FakeNode)) throw new TypeError('connect: not an AudioNode');
    this.outs.push(dest);
    return dest;
  }
  disconnect() {
    this.outs.length = 0;
    this.disconnected = true;
  }
}

class FakeSource extends FakeNode {
  constructor(ctx, kind, params) {
    super(ctx, kind, params);
    this.startTime = null;
    this.stopTime = null;
    this.offset = 0;
    this.onended = null;
  }
  start(when, offset) {
    if (this.startTime !== null) throw new Error('InvalidStateError: start called twice');
    if (when !== undefined) {
      finite(when, 'start time');
      if (when < 0) throw new RangeError('start: negative time');
    }
    if (offset !== undefined) {
      finite(offset, 'start offset');
      if (offset < 0) throw new RangeError('start: negative offset');
    }
    if (this.kind === 'buffer' && !this.buffer) throw new Error('start: no buffer');
    this.startTime = when || 0;
    this.offset = offset || 0;
  }
  stop(when) {
    if (this.startTime === null) throw new Error('InvalidStateError: stop before start');
    if (when !== undefined) {
      finite(when, 'stop time');
      if (when < 0) throw new RangeError('stop: negative time');
    }
    this.stopTime = when || 0;
  }
}

class FakeBuffer {
  constructor(channels, length, sampleRate) {
    if (!(channels >= 1) || !(length >= 1)) throw new Error('NotSupportedError: bad buffer shape');
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this._data = [];
    for (let c = 0; c < channels; c++) this._data.push(new Float32Array(length));
  }
  getChannelData(c) {
    return this._data[c];
  }
}

class FakeContext {
  constructor() {
    this.sampleRate = SAMPLE_RATE;
    this.currentTime = 0;
    this.state = 'suspended';
    this.nodes = [];
    this.resumes = 0;
    this.suspends = 0;
    this.blocked = false; // true: resume() never succeeds (autoplay policy)
    this.destination = new FakeNode(this, 'destination');
    FakeContext.instances.push(this);
  }
  createGain() {
    return new FakeNode(this, 'gain', { gain: 1 });
  }
  createBiquadFilter() {
    const n = new FakeNode(this, 'biquad', { frequency: 350, Q: 1, gain: 0, detune: 0 });
    n.type = 'lowpass';
    return n;
  }
  createOscillator() {
    const n = new FakeSource(this, 'oscillator', { frequency: 440, detune: 0 });
    n.type = 'sine';
    return n;
  }
  createBufferSource() {
    const n = new FakeSource(this, 'buffer', { playbackRate: 1, detune: 0 });
    n.buffer = null;
    n.loop = false;
    return n;
  }
  createDynamicsCompressor() {
    return new FakeNode(this, 'compressor', { threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 });
  }
  createWaveShaper() {
    const n = new FakeNode(this, 'shaper');
    n.curve = null;
    return n;
  }
  createConvolver() {
    const n = new FakeNode(this, 'convolver');
    n.buffer = null;
    return n;
  }
  createStereoPanner() {
    return new FakeNode(this, 'panner', { pan: 0 });
  }
  createBuffer(channels, length, sampleRate) {
    return new FakeBuffer(channels, length, sampleRate);
  }
  resume() {
    this.resumes++;
    if (this.blocked) return Promise.reject(new Error('NotAllowedError'));
    this.state = 'running';
    return Promise.resolve();
  }
  suspend() {
    this.suspends++;
    this.state = 'suspended';
    return Promise.resolve();
  }
}
FakeContext.instances = [];

// ---------------------------------------------------------------- a minimal window
const listeners = {};
globalThis.addEventListener = function (type, fn) {
  (listeners[type] = listeners[type] || []).push(fn);
};
function gesture(type) {
  for (const fn of listeners[type] || []) fn({ type: type });
}

const logged = [];
const realError = console.error;
console.error = function () {
  logged.push(Array.prototype.slice.call(arguments).map(String).join(' '));
};
test.after(() => {
  console.error = realError;
});

require('../js/view/audio.js');
const Audio = globalThis.SOL.Audio;
Audio.debug = true; // anything the module swallows lands in `logged`

const NAMES = [
  'deal', 'flip', 'pick', 'place', 'slide', 'draw', 'recycle', 'foundation', 'invalid', 'hint',
  'undo', 'shuffle', 'click', 'open', 'close', 'autocomplete', 'win', 'tick', 'whoosh',
];

function newRig(random) {
  const ctx = new FakeContext();
  ctx.state = 'running';
  return { ctx: ctx, rig: Audio.createRig(ctx, random ? { random: random } : {}) };
}

function sourcesOf(voice) {
  return voice.sources;
}

/** Waits until cond() holds (polling), at most timeoutMs. Timers can be late on a busy machine; a fixed sleep would be flaky. */
async function until(cond, timeoutMs) {
  const end = Date.now() + (timeoutMs || 2000);
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  return cond();
}

function seeded(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- tests (they share module state: order matters)
test('exposes the contract', () => {
  assert.deepEqual(Audio.NAMES, NAMES);
  for (const fn of ['init', 'setEnabled', 'setVolume', 'play', 'playFoundation']) assert.equal(typeof Audio[fn], 'function');
  assert.equal(Audio.enabled, true);
  assert.equal(Audio.volume, 0.6);
});

test('without WebAudio every call is a silent no-op, before and after init()', async () => {
  assert.equal(Audio.supported, false);
  assert.equal(Audio.state, 'unsupported');
  for (const name of NAMES.concat(['nope', '', null, undefined, 7, {}])) {
    assert.equal(Audio.play(name, { delay: 10, pan: 0.5 }), false);
  }
  assert.equal(Audio.playFoundation(4), false);
  assert.equal(Audio.init(), Audio);
  assert.equal(Audio.init(), Audio);
  gesture('pointerdown');
  gesture('keydown');
  assert.equal(Audio.unlock(), false);
  assert.equal(Audio.play('deal'), false);
  Audio.stopAll();
  Audio.setVolume(0.3);
  Audio.setVolume('loud');
  Audio.setVolume(NaN);
  assert.equal(Audio.volume, 0.3);
  Audio.setVolume(7);
  assert.equal(Audio.volume, 1);
  Audio.setVolume(0.6);
  assert.equal(await Audio.render('deal'), null);
  assert.equal(Audio.context, null);
  assert.equal(Audio.output, null);
  assert.equal(Audio.voices, 0);
  assert.deepEqual(logged, []);
});

test('duration() gives a nominal length for every sound and 0 for unknown names', () => {
  for (const name of NAMES) {
    const ms = Audio.duration(name);
    assert.ok(ms >= 30 && ms <= 2500, name + ' ' + ms);
  }
  assert.equal(Audio.duration('nope'), 0);
  assert.equal(Audio.duration(null), 0);
  assert.ok(Audio.duration('shuffle', { duration: 1500 }) > Audio.duration('shuffle'));
  assert.ok(Audio.duration('foundation', { rank: 13 }) > Audio.duration('foundation', { rank: 5 }));
});

test('every sound builds a valid graph on any context', () => {
  const { ctx, rig } = newRig();
  assert.ok(rig.input instanceof FakeNode && rig.output instanceof FakeNode);
  assert.ok(ctx.nodes.some((n) => n.kind === 'compressor'), 'master compressor');
  assert.ok(ctx.nodes.some((n) => n.kind === 'shaper' && n.curve && n.curve.length > 100), 'soft limiter');
  assert.ok(rig.output.outs.includes(ctx.destination), 'master gain feeds the destination');
  for (const name of NAMES) {
    rig.stopAll();
    const before = ctx.nodes.length;
    const voice = rig.play(name);
    assert.ok(voice, name + ' was scheduled');
    const sources = sourcesOf(voice);
    assert.ok(sources.length >= 2, name + ' has several layers');
    assert.ok(ctx.nodes.length - before < 260, name + ' node count ' + (ctx.nodes.length - before));
    for (const s of sources) {
      assert.ok(s.startTime >= voice.start - 1e-9, name + ' source starts at or after the trigger');
      assert.ok(s.stopTime > s.startTime, name + ' source has a stop time');
      assert.ok(s.stopTime <= voice.start + Audio.duration(name) / 1000 + 1e-9, name + ' ends within its nominal duration');
      assert.equal(s.kind === 'buffer' ? s.buffer !== null : true, true);
    }
    assert.ok(voice.end - voice.start <= Audio.duration(name) / 1000 + 1e-9);
    assert.ok(voice.out.outs.length >= 1, name + ' reaches the bus');
  }
  assert.deepEqual(logged, []);
});

test('every envelope ends in silence and never holds a gain open', () => {
  const { ctx, rig } = newRig();
  for (const name of NAMES) {
    const before = ctx.nodes.length;
    const voice = rig.play(name, { delay: 5 });
    assert.ok(voice);
    for (const n of ctx.nodes.slice(before)) {
      if (n.kind !== 'gain' || n === voice.out || n === voice.wet) continue;
      const g = n.gain;
      if (g.curves.length) continue; // bell-shaped: the curve itself starts and ends at 0
      const last = g.events[g.events.length - 1];
      assert.ok(last, name + ': envelope has events');
      assert.equal(last.value, 0, name + ': envelope ends at 0');
    }
    rig.stopAll();
  }
});

test('junk names and options never throw and never schedule garbage', () => {
  const { ctx, rig } = newRig(seeded(42));
  const before = ctx.nodes.length;
  for (const name of ['nope', '', 'constructor', '__proto__', 'hasOwnProperty', null, undefined, 3, {}, []]) {
    assert.equal(rig.play(name, { delay: 5 }), null);
  }
  assert.equal(ctx.nodes.length, before, 'unknown names create no nodes');
  const junk = [
    null, undefined, 'x', 7, [], { pitch: Infinity }, { pitch: -1 }, { pitch: 'high' }, { volume: NaN }, { volume: 1e9 }, { volume: -3 },
    { delay: -500 }, { delay: 1e15 }, { delay: 'soon' }, { pan: 40 }, { pan: NaN }, { duration: -1 }, { duration: 1e9 }, { duration: null },
    { rank: 1e9 }, { rank: -4 }, { rank: 'K' }, { rank: {} }, { pitch: 0, volume: 2, delay: 0, pan: -1, duration: 1, rank: 0 },
  ];
  for (const name of NAMES) {
    for (const o of junk) {
      rig.stopAll();
      assert.doesNotThrow(() => rig.play(name, o));
    }
  }
  assert.equal(rig.play('place', { volume: 0 }), null, 'zero volume schedules nothing');
  assert.deepEqual(logged, []);
});

test('fuzz: random valid triggers only ever use valid automation', () => {
  const rnd = seeded(7);
  const { ctx, rig } = newRig(seeded(99));
  let played = 0;
  for (let i = 0; i < 1500; i++) {
    ctx.currentTime += rnd() * 0.08;
    const name = NAMES[Math.floor(rnd() * NAMES.length)];
    const v = rig.play(name, {
      pitch: 0.25 + rnd() * 3.75,
      volume: rnd() * 2,
      delay: rnd() < 0.5 ? 0 : rnd() * 2000,
      pan: rnd() * 2 - 1,
      duration: rnd() < 0.3 ? rnd() * 3000 : undefined,
      rank: 1 + Math.floor(rnd() * 13),
    });
    if (v) played++;
  }
  assert.ok(played > 500, 'most were played: ' + played);
  assert.deepEqual(logged, []);
  for (const n of ctx.nodes) {
    if (n.kind === 'biquad') assert.ok(n.frequency.value >= 20 && n.frequency.value <= SAMPLE_RATE / 2, 'filter frequency in range');
    if (n.kind === 'oscillator') assert.ok(n.frequency.value >= 20 && n.frequency.value <= SAMPLE_RATE / 2, 'oscillator frequency in range');
    if (n.kind === 'panner') assert.ok(Math.abs(n.pan.value) <= 1);
  }
});

test('delay is in milliseconds on the context clock, snapped to the sample grid', () => {
  const { ctx, rig } = newRig();
  ctx.currentTime = 12.3456;
  const starts = [];
  for (let i = 0; i < 28; i++) {
    const v = rig.play('deal', { delay: i * 45 });
    assert.ok(v, 'deal ' + i + ' admitted');
    starts.push(v.start);
  }
  assert.ok(starts[0] > ctx.currentTime && starts[0] < ctx.currentTime + 0.02, 'the first one is (almost) immediate');
  for (let i = 0; i < 28; i++) {
    assert.ok(Math.abs(starts[i] - starts[0] - i * 0.045) <= 0.5 / SAMPLE_RATE + 1e-12, 'deal ' + i + ' is i * 45 ms after the first');
    const frames = starts[i] * SAMPLE_RATE;
    assert.ok(Math.abs(frames - Math.round(frames)) < 0.01, 'on the sample grid');
  }
  assert.equal(rig.voices.length, 28);
  const far = rig.play('win', { delay: 1e9 });
  assert.ok(far.start - ctx.currentTime <= 30.01, 'delay is capped at 30 s');
});

test('pitch scales frequencies; pan uses a panner only when asked', () => {
  const lowest = (ctx, from) => Math.min.apply(null, ctx.nodes.slice(from).filter((n) => n.kind === 'oscillator').map((n) => n.frequency.value));
  const a = newRig(() => 0.5);
  let from = a.ctx.nodes.length;
  a.rig.play('hint');
  const f1 = lowest(a.ctx, from);
  a.rig.stopAll();
  from = a.ctx.nodes.length;
  a.rig.play('hint', { pitch: 2 });
  assert.ok(Math.abs(lowest(a.ctx, from) / f1 - 2) < 1e-9);

  const b = newRig(() => 0.5);
  const centre = b.rig.play('place');
  assert.equal(centre.panner, null);
  b.rig.stopAll();
  const right = b.rig.play('place', { pan: 0.4 });
  assert.ok(right.panner && right.panner.pan.value === 0.4);
  // equal-power law: a centred mono voice is 3 dB down, exactly what the panner does at 0
  assert.ok(Math.abs(centre.out.gain.value / right.out.gain.value - Math.SQRT1_2) < 1e-9);
});

test('playFoundation climbs D major pentatonic from A3 to D6', () => {
  FakeContext.instances.length = 0;
  const { ctx, rig } = newRig(() => 0.5);
  const expected = [0, 2, 5, 7, 9, 12, 14, 17, 19, 21, 24, 26, 29].map((n) => 220 * Math.pow(2, n / 12));
  const freqs = [];
  for (let rank = 1; rank <= 13; rank++) {
    rig.stopAll();
    const from = ctx.nodes.length;
    assert.ok(rig.play('foundation', { rank: rank }));
    const osc = ctx.nodes.slice(from).filter((n) => n.kind === 'oscillator').map((n) => n.frequency.value);
    freqs.push(Math.min.apply(null, osc));
  }
  for (let i = 0; i < 13; i++) {
    assert.ok(Math.abs(freqs[i] - expected[i]) < 1e-6, 'rank ' + (i + 1) + ' = ' + freqs[i]);
    if (i > 0) assert.ok(freqs[i] > freqs[i - 1], 'ascending');
  }
  assert.ok(Math.abs(freqs[12] / freqs[0] - Math.pow(2, 29 / 12)) < 1e-9);
  // out-of-range and missing ranks are clamped / defaulted, never thrown on
  const probe = (o) => {
    rig.stopAll();
    const from = ctx.nodes.length;
    rig.play('foundation', o);
    return Math.min.apply(null, ctx.nodes.slice(from).filter((n) => n.kind === 'oscillator').map((n) => n.frequency.value));
  };
  assert.ok(Math.abs(probe({ rank: 99 }) - expected[12]) < 1e-6);
  assert.ok(Math.abs(probe({ rank: -3 }) - expected[0]) < 1e-6);
  assert.ok(Math.abs(probe({}) - expected[5]) < 1e-6, 'no rank: a six');
  assert.ok(Math.abs(probe({ rank: 'Q' }) - expected[5]) < 1e-6);
});

test('polyphony: duplicates collapse, overlap is capped, the schedule is bounded', () => {
  const overlap = (rig) => {
    const marks = [];
    for (const v of rig.voices) if (!v.faded) marks.push([v.start, 1], [v.end, -1]);
    marks.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let now = 0;
    let most = 0;
    for (const m of marks) {
      now += m[1];
      most = Math.max(most, now);
    }
    return most;
  };

  let { rig } = newRig();
  let admitted = 0;
  for (let i = 0; i < 200; i++) if (rig.play('place')) admitted++;
  assert.equal(admitted, 1, '200 x the same sound in the same instant is one sound');

  ({ rig } = newRig());
  for (let i = 0; i < 200; i++) rig.play(NAMES[i % NAMES.length], { pan: Math.sin(i) });
  assert.ok(overlap(rig) <= 12, 'at most 12 voices at once, got ' + overlap(rig));
  assert.ok(rig.voices.some((v) => v.name === 'win' && !v.faded), 'the important sound survived');
  assert.ok(!rig.voices.some((v) => v.name === 'tick' && !v.faded), 'the least important one made room');

  ({ rig } = newRig());
  for (let i = 0; i < 1000; i++) rig.play(NAMES[(i * 7) % NAMES.length], { delay: i * 7 });
  assert.ok(overlap(rig) <= 12, 'dense stream stays capped, got ' + overlap(rig));
  assert.ok(rig.voices.length <= 96, 'pending schedule is bounded, got ' + rig.voices.length);

  // a sound stacking on itself is turned down
  ({ rig } = newRig(() => 0.5));
  const first = rig.play('foundation', { rank: 3 });
  const second = rig.play('foundation', { rank: 3, delay: 40 });
  const third = rig.play('foundation', { rank: 3, delay: 80 });
  assert.ok(second.out.gain.value < first.out.gain.value && third.out.gain.value < second.out.gain.value);
});

test('finished voices are released; stopAll() cancels what has not started', () => {
  const { ctx, rig } = newRig();
  const now = rig.play('place');
  const later = rig.play('win', { delay: 800 });
  assert.equal(rig.voices.length, 2);
  ctx.currentTime += 0.03; // 'place' is sounding, 'win' is still in the future
  rig.stopAll();
  assert.equal(rig.voices.length, 0);
  assert.equal(later.dead, true, 'a voice that had not started is torn down at once');
  assert.ok(later.out.disconnected);
  for (const s of sourcesOf(later)) assert.ok(s.stopTime <= later.start, 'its sources can never sound');
  assert.ok(now.out.gain.events.some((e) => e.kind === 'setTargetAtTime' && e.value === 0), 'a sounding voice is faded');

  const v = rig.play('click');
  assert.equal(typeof v.last.onended, 'function');
  v.last.onended();
  assert.equal(rig.voices.length, 0);
  assert.ok(v.out.disconnected, 'ended voices are disconnected');

  rig.play('tick');
  ctx.currentTime += 5;
  rig.play('click');
  assert.equal(rig.voices.length, 1, 'stale voices are pruned even if "ended" never fired');
});

test('works on a context without compressor, shaper, convolver or panner', () => {
  const ctx = new FakeContext();
  ctx.state = 'running';
  ctx.createDynamicsCompressor = undefined;
  ctx.createWaveShaper = undefined;
  ctx.createConvolver = undefined;
  ctx.createStereoPanner = undefined;
  const rig = Audio.createRig(ctx);
  for (const name of NAMES) {
    rig.stopAll();
    const v = rig.play(name, { pan: 0.7 });
    assert.ok(v, name);
    assert.equal(v.panner, null);
  }
  assert.ok(rig.output.outs.includes(ctx.destination));
  assert.deepEqual(logged, []);
});

test('deferred rig: far-ahead triggers get their start time at once and their nodes just in time', async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ctx = new FakeContext();
  ctx.state = 'running';
  ctx.currentTime = 3;
  const rig = Audio.createRig(ctx, { defer: true });
  const nodesBefore = ctx.nodes.length;
  const results = [];
  for (let i = 0; i < 28; i++) results.push(rig.play('deal', { delay: i * 45, pan: 0.2 }));
  assert.ok(results.every((r) => r !== null), 'all 28 accepted');
  const immediate = results.filter((r) => !r.queued);
  assert.ok(immediate.length >= 8 && immediate.length <= 10, 'only the first few are built now: ' + immediate.length);
  assert.equal(rig.voices.length, immediate.length);
  assert.equal(rig.pending(), 28);
  assert.ok(ctx.nodes.length - nodesBefore < 28 * 5, 'most nodes are not built yet');
  const first = immediate[0].start;

  // Let the clock run. Whatever the pump builds must still lie in the future when it is built.
  const seen = new Map();
  for (const v of immediate) seen.set(v, v.start - ctx.currentTime);
  for (let step = 0; step < 60 && seen.size < 28; step++) {
    ctx.currentTime += 0.04;
    const queuedBefore = rig.pending() - rig.voices.length;
    await sleep(45);
    // (on a busy machine the pump's timer may be late: give it a moment before the clock moves on)
    await until(() => rig.pending() - rig.voices.length < queuedBefore || queuedBefore === 0 || step < 2, 300);
    for (const v of rig.voices) if (!seen.has(v)) seen.set(v, v.start - ctx.currentTime);
  }
  assert.equal(seen.size, 28, 'every queued deal was built');
  const starts = Array.from(seen.keys()).map((v) => v.start).sort((a, b) => a - b);
  for (let i = 0; i < 28; i++) {
    assert.ok(Math.abs(starts[i] - first - i * 0.045) <= 0.5 / SAMPLE_RATE + 1e-12, 'deal ' + i + ' sounds exactly i * 45 ms after the first');
  }
  for (const lead of seen.values()) assert.ok(lead > 0, 'built before it sounds (lead ' + lead.toFixed(3) + ' s)');
  assert.equal(rig.pending(), rig.voices.length, 'queue is empty');

  // the same sound queued twice for the same instant is one sound; stopAll() empties the queue
  rig.stopAll();
  let accepted = 0;
  for (let i = 0; i < 100; i++) if (rig.play('place', { delay: 900 })) accepted++;
  assert.equal(accepted, 1);
  assert.equal(rig.pending(), 1);
  rig.play('win', { delay: 2000 });
  rig.play('hint', { delay: 1500 });
  assert.equal(rig.pending(), 3);
  rig.stopAll();
  assert.equal(rig.pending(), 0);
  ctx.currentTime += 3;
  await sleep(150);
  assert.equal(rig.voices.length, 0, 'nothing that was cancelled gets built later');

  // a trigger the pump finds slightly late is played at once; one found far too late is dropped
  rig.play('flip', { delay: 500 });
  ctx.currentTime += 0.55;
  await until(() => rig.voices.length === 1);
  assert.equal(rig.voices.length, 1);
  assert.ok(rig.voices[0].start >= ctx.currentTime, 'a little late: starts now, not in the past');
  rig.stopAll();
  rig.play('flip', { delay: 500 });
  ctx.currentTime += 5;
  await until(() => rig.pending() === 0);
  assert.equal(rig.pending(), 0, 'far too late: dropped');
  assert.equal(rig.voices.length, 0);

  // the queue is bounded
  let queued = 0;
  for (let i = 0; i < 1000; i++) if (rig.play(NAMES[i % NAMES.length], { delay: 1000 + i * 30 })) queued++;
  assert.ok(queued <= 256 && queued >= 200, 'bounded queue: ' + queued);
  rig.stopAll();
  assert.deepEqual(logged, []);
});

test('lazy rig: sounds play before the reverb exists, and use it once warm() has run', () => {
  const ctx = new FakeContext();
  ctx.state = 'running';
  const rig = Audio.createRig(ctx, { lazy: true });
  assert.ok(!ctx.nodes.some((n) => n.kind === 'convolver'), 'no convolver yet');
  const dry = rig.play('hint');
  assert.ok(dry && dry.wet === null);
  rig.warm();
  rig.warm();
  assert.equal(ctx.nodes.filter((n) => n.kind === 'convolver').length, 1, 'built once');
  rig.stopAll();
  const wet = rig.play('hint');
  assert.ok(wet.wet, 'tonal accents send to the reverb');
  rig.stopAll();
  assert.equal(rig.play('deal').wet, null, 'dry card sounds do not');
});

// ---------------------------------------------------------------- the live state machine
test('no context is created before a user gesture', () => {
  FakeContext.instances.length = 0;
  globalThis.AudioContext = FakeContext;
  assert.equal(Audio.supported, true);
  assert.equal(Audio.state, 'idle');
  for (const name of NAMES) assert.equal(Audio.play(name), false);
  assert.equal(Audio.playFoundation(13), false);
  Audio.init();
  assert.equal(FakeContext.instances.length, 0);
  assert.equal(Audio.context, null);
});

test('the first gesture creates and resumes the context; the same gesture can already play', () => {
  gesture('pointerdown');
  assert.equal(FakeContext.instances.length, 1);
  const ctx = Audio.context;
  assert.equal(ctx, FakeContext.instances[0]);
  assert.equal(ctx.resumes, 1);
  assert.equal(Audio.state, 'running');
  for (const name of NAMES) {
    assert.equal(Audio.play(name), true, name);
    assert.equal(Audio.voices, 1);
    Audio.stopAll();
  }
  let together = 0;
  for (const name of NAMES) if (Audio.play(name)) together++;
  assert.ok(together >= 12 && together < NAMES.length, 'all 19 in the same instant: the limiter drops the least important');
  assert.equal(Audio.play('nope'), false);
  Audio.stopAll();
  assert.equal(Audio.voices, 0);
  assert.equal(Audio.playFoundation(1), true);
  assert.equal(Audio.playFoundation(13, { delay: 100, pan: -0.3 }), true);
  gesture('keydown');
  gesture('click');
  assert.equal(FakeContext.instances.length, 1, 'later gestures reuse the context');
  assert.equal(ctx.resumes, 1, 'and do not resume a running context');
  assert.ok(Audio.output, 'output node exposed');
  assert.deepEqual(logged, []);
});

test('a context that is still starting up plays the sounds of the gesture that woke it', () => {
  const ctx = Audio.context;
  Audio.stopAll();
  ctx.state = 'suspended';
  const realResume = ctx.resume;
  ctx.resume = function () {
    ctx.resumes++;
    return Promise.resolve(); // resolves later: state stays 'suspended' for now, as in real browsers
  };
  gesture('pointerup');
  assert.equal(ctx.state, 'suspended');
  assert.equal(Audio.play('pick'), true, 'scheduled on the frozen clock: it sounds as soon as the context runs');
  ctx.resume = realResume;
  ctx.state = 'running';
  Audio.stopAll();
});

test('a suspended context that will not start drops sounds instead of queueing them', async () => {
  const ctx = Audio.context;
  ctx.state = 'suspended';
  ctx.blocked = true;
  await new Promise((r) => setTimeout(r, 650)); // let the wake-up window of the last gesture expire
  const before = ctx.resumes;
  for (let i = 0; i < 50; i++) assert.equal(Audio.play(NAMES[i % NAMES.length], { delay: 20 }), false);
  assert.equal(Audio.voices, 0, 'nothing piles up on the frozen clock');
  assert.ok(ctx.resumes - before >= 1 && ctx.resumes - before <= 2, 'it nudges the context, but does not hammer it');
  assert.equal(Audio.state, 'suspended');
  ctx.blocked = false;
  gesture('touchend');
  assert.equal(Audio.state, 'running');
  assert.equal(Audio.play('draw'), true);
  Audio.stopAll();
  assert.deepEqual(logged, []);
});

test('setEnabled(false) silences, blocks play() and releases the context; true brings it back', async () => {
  const ctx = Audio.context;
  assert.equal(Audio.play('win'), true);
  Audio.setEnabled(false);
  assert.equal(Audio.enabled, false);
  assert.equal(Audio.voices, 0);
  assert.equal(Audio.play('place'), false);
  assert.equal(Audio.playFoundation(2), false);
  const muted = Audio.output.gain.events[Audio.output.gain.events.length - 1];
  assert.equal(muted.value, 0, 'master gain faded to 0');
  await until(() => ctx.state === 'suspended');
  assert.equal(ctx.state, 'suspended');
  gesture('pointerdown');
  assert.equal(ctx.state, 'suspended', 'gestures do not wake a disabled Audio');

  Audio.enabled = true; // the setter form
  assert.equal(Audio.enabled, true);
  gesture('pointerdown');
  assert.equal(ctx.state, 'running');
  assert.equal(Audio.play('place'), true);
  const open = Audio.output.gain.events[Audio.output.gain.events.length - 1];
  assert.ok(open.value > 0, 'master gain restored');
  Audio.stopAll();
});

test('setVolume is perceptual, clamped and applied to the master gain', () => {
  Audio.setVolume(1);
  let e = Audio.output.gain.events[Audio.output.gain.events.length - 1];
  assert.equal(e.value, 1);
  Audio.setVolume(0.25);
  e = Audio.output.gain.events[Audio.output.gain.events.length - 1];
  assert.ok(Math.abs(e.value - Math.pow(0.25, 1.5)) < 1e-12);
  Audio.setVolume(-2);
  assert.equal(Audio.volume, 0);
  Audio.volume = 0.6;
  assert.equal(Audio.volume, 0.6);
  assert.deepEqual(logged, []);
});

test('a context that cannot be constructed is given up on quietly', () => {
  // A fresh copy of the module, in a world where `new AudioContext()` always throws.
  const path = require.resolve('../js/view/audio.js');
  delete require.cache[path];
  const saved = globalThis.SOL;
  let attempts = 0;
  globalThis.SOL = {};
  globalThis.AudioContext = function () {
    attempts++;
    throw new Error('no audio device');
  };
  try {
    require('../js/view/audio.js');
    const A = globalThis.SOL.Audio;
    A.init();
    for (let i = 0; i < 10; i++) {
      gesture('pointerdown');
      assert.equal(A.play('deal'), false);
    }
    assert.ok(attempts >= 3 && attempts <= 6, 'a few attempts, then no more: ' + attempts);
    assert.equal(A.supported, false);
    assert.equal(A.state, 'unsupported');
  } finally {
    globalThis.SOL = saved;
    globalThis.AudioContext = FakeContext;
  }
});
