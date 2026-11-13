/*
 * SOL.Audio — every sound in the game, synthesised with WebAudio. There are no audio files.
 *
 * Card sounds are short bursts of filtered noise with fast envelopes and a little low "body"
 * (paper on felt); accents are soft mallet / bell tones in D major pentatonic, so anything that
 * overlaps (a foundation cascade, the win fanfare) stays consonant. Every trigger is slightly
 * randomised (filter, level, micro-timing) so repeats never sound mechanical.
 *
 * Public API
 * ----------
 *   Audio.init() -> Audio            Safe to call any time, any number of times. Arms the gesture listeners: the
 *                                    AudioContext is created / resumed on the first real user gesture (autoplay
 *                                    policy) and re-resumed after an interruption (tab switch, iOS audio session).
 *                                    Also reads SOL.Settings 'sound' / 'volume' when present and follows
 *                                    'settings:change' on SOL.Bus, so the controller does not have to (calling
 *                                    setEnabled / setVolume as well is harmless).
 *   Audio.setEnabled(bool)           false: silences what is playing, play() becomes a no-op and the context is
 *                                    suspended (no context is ever created while disabled).
 *   Audio.setVolume(0..1)            Perceptual (gain = v^1.5). Default 0.6. Clamped; non-numbers are ignored.
 *   Audio.enabled                    boolean (get; assigning calls setEnabled).
 *   Audio.volume                     number 0..1 (get; assigning calls setVolume).
 *
 *   Audio.play(name, { pitch = 1, volume = 1, delay = 0, pan = 0, duration, rank } = {}) -> boolean
 *       names   'deal', 'flip', 'pick', 'place', 'slide', 'draw', 'recycle', 'foundation', 'invalid', 'hint',
 *               'undo', 'shuffle', 'click', 'open', 'close', 'autocomplete', 'win', 'tick', 'whoosh'
 *       pitch   multiplier on every filter / oscillator frequency (0.25..4).
 *       volume  linear gain on this trigger (0..2).
 *       delay   MILLISECONDS from now, like every other time in this code base. Scheduled on the AudioContext
 *               clock, so a staggered burst (28 x 'deal', delay: i * 45) is sample-accurate however janky the
 *               frame rate is. It is real time: NOT scaled by SOL.Anim.speed (divide by it yourself when you
 *               stagger alongside an animation). Capped at 30 s.
 *       pan     -1 (left) .. 1 (right). Equal-power; something subtle like +-0.4 across the table is plenty.
 *       duration (extra) milliseconds; only 'shuffle', 'recycle', 'slide' and 'whoosh' stretch to fit it.
 *       rank    (extra) 1..13, only for 'foundation' (see playFoundation).
 *     Returns true when the sound was scheduled, false when it was ignored: unknown name, disabled, no context
 *     yet (no user gesture so far), page hidden, WebAudio missing, or dropped by the polyphony limiter.
 *     NEVER throws, whatever it is given, whenever it is called (before init() included: that arms init()).
 *   Audio.playFoundation(rank, opts) -> boolean
 *       rank 1..13 walks up A3 B3 D4 E4 F#4 A4 B4 D5 E5 F#5 A5 B5 D6 — the scale starts on the dominant and the
 *       King lands on the tonic, with a small sparkle because the suit is complete. Same opts as play().
 *
 *   Extras (not in the original contract; used by the demo page and the tests):
 *   Audio.NAMES                      the 19 names, in contract order.
 *   Audio.supported                  false when the browser has no WebAudio (everything is then a no-op).
 *   Audio.state                      'unsupported' | 'idle' (no context yet) | 'suspended' | 'running' | 'closed'
 *                                    (or whatever AudioContext.state says, e.g. 'interrupted' on iOS).
 *   Audio.unlock() -> boolean        try to create / resume the context right now (call it from a gesture handler).
 *   Audio.stopAll()                  fade out everything that is sounding or scheduled.
 *   Audio.duration(name, opts) -> ms nominal length (upper bound) of a sound; 0 for unknown names.
 *   Audio.voices                     number of scheduled / sounding voices (get).
 *   Audio.context / Audio.output     the live AudioContext and its final GainNode, or null (meters, visualisers).
 *   Audio.debug                      set true to console.error swallowed exceptions (dev pages / tests only).
 *   Audio.createRig(ctx, { random, volume = 1, destination }) -> rig
 *       Builds the whole thing — noise buffers, reverb, master chain — on ANY BaseAudioContext (an
 *       OfflineAudioContext for instance). rig.play(name, opts) -> voice | null, rig.setVolume(v),
 *       rig.setMuted(bool), rig.stopAll(), rig.voices, rig.input (bus), rig.output (final GainNode).
 *   Audio.render(events, { sampleRate = 44100, seed, volume = 1, tail = 250, duration }) -> Promise<AudioBuffer | null>
 *       Renders through the exact production graph in an OfflineAudioContext. `events` is a name, or an array of
 *       names / [name, opts] / { name, opts }. `seed` makes the random variation reproducible. tail and duration
 *       are in ms. Resolves null when offline rendering is unavailable. Never rejects.
 *
 * Signal path
 * -----------
 *   voice (sources -> filters -> envelopes -> voice gain -> [pan]) --+--> bus -> compressor -> soft limiter -> volume -> out
 *                                                                    +--> reverb send -> small-room convolver -> bus
 *   The limiter is a tanh soft-clip that is transparent below 0.7 and can never exceed 0.97, so the output cannot
 *   clip no matter how many sounds pile up. On top of that at most MAX_VOICES sounds overlap, the same sound
 *   asked for twice in the same instant collapses to one, and a sound stacking on top of itself is turned down
 *   a little each time (so a fast foundation cascade stays gentle).
 */
(function (root) {
  'use strict';

  const SOL = (root.SOL = root.SOL || {});

  const NAMES = [
    'deal', 'flip', 'pick', 'place', 'slide', 'draw', 'recycle', 'foundation', 'invalid', 'hint',
    'undo', 'shuffle', 'click', 'open', 'close', 'autocomplete', 'win', 'tick', 'whoosh',
  ];

  // ------------------------------------------------------------------ tuning
  const LOOKAHEAD = 0.006; // s. Schedule a hair ahead so an attack is never truncated by "start time already passed".
  const MAX_VOICES = 12; // sounds allowed to overlap at any instant
  const MAX_PENDING = 96; // scheduled-but-unfinished voices (bounds the node count of long staggers)
  const MAX_DELAY = 30; // s
  const DUCK = 0.35; // how much a sound is turned down per copy of itself that is still ringing
  const WAKE_WINDOW = 600; // ms after resume() during which sounds are still scheduled on a not-yet-running context
  const FLOOR = 0.001; // -60 dB: where a decaying envelope ends
  const BP_REF = 2500; // Hz. Band-pass bursts are level-compensated as if their band were this wide.
  const DEFAULT_VOLUME = 0.6; // same default as SOL.Settings 'volume'
  const DEFAULT_RANK = 6; // plain play('foundation') sounds like a six: A4

  // Master bus. The compressor is deliberately gentle: it only glues dense passages together.
  const COMP = { threshold: -14, knee: 12, ratio: 3, attack: 0.005, release: 0.12 };
  // DynamicsCompressorNode applies an automatic make-up gain that is fixed by the spec for a given
  // threshold / knee / ratio. Measured for the values above; divided back out so quiet sounds pass at unity.
  const COMP_MAKEUP = 1.4462;
  const CLIP_KNEE = 0.7; // the limiter is exactly linear below this...
  const CLIP_CEIL = 0.97; // ...and approaches this asymptotically
  const CLIP_RANGE = 2; // input magnitude mapped onto the ends of the shaper curve

  // D major pentatonic, in semitones above A3. Thirteen steps: dominant (A3) up to the tonic (D6).
  const A3 = 220;
  const SCALE = [0, 2, 5, 7, 9, 12, 14, 17, 19, 21, 24, 26, 29];

  // ------------------------------------------------------------------ small helpers
  function noop() {}

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  /** `v` when it is a finite number, otherwise `fallback`. */
  function num(v, fallback) {
    return typeof v === 'number' && isFinite(v) ? v : fallback;
  }

  /** Frequency of a note `semis` semitones above A3. */
  function note(semis) {
    return A3 * Math.pow(2, semis / 12);
  }

  /** Deterministic PRNG for reproducible offline renders. */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Promises returned by resume()/suspend() may reject (or not exist at all on old WebKit): never let that surface. */
  function settle(p) {
    if (p && typeof p.then === 'function') p.then(noop, noop);
  }

  function report(where, err) {
    if (Audio.debug && root.console) root.console.error('[SOL.Audio] ' + where, err);
  }

  /** opts.duration (ms) -> seconds within [min, max]; `def` when not given. */
  function span(o, def, min, max) {
    const ms = num(o && o.duration, NaN);
    return ms > 0 ? clamp(ms / 1000, min, max) : def;
  }

  function rankOf(o) {
    return clamp(Math.round(num(o && o.rank, DEFAULT_RANK)), 1, 13);
  }

  // ------------------------------------------------------------------ shared buffers
  /**
   * Looping noise the card sounds are cut from. Filtering that never changes is baked in here so that a burst
   * needs only one biquad at run time.
   *   'soft'  : white noise with the fizz (> ~9 kHz) and the rumble taken off — taps, ticks, knocks.
   *   'grain' : darker, and amplitude-modulated by a fast random envelope: the faint crackle of paper fibres
   *             dragging over felt — slides, swishes, whooshes.
   * Both are normalised to the same RMS so a gain means the same thing for either.
   */
  function makeNoise(ctx, rnd, grainy) {
    const sr = ctx.sampleRate;
    const n = Math.floor(sr * 1.2);
    const buffer = ctx.createBuffer(1, n, sr);
    const d = buffer.getChannelData(0);
    const aLow = 1 - Math.exp((-2 * Math.PI * (grainy ? 6500 : 9000)) / sr);
    const aHigh = 1 - Math.exp((-2 * Math.PI * (grainy ? 260 : 180)) / sr);
    const hop = Math.max(1, Math.round(sr / 1900)); // grain rate
    let lp1 = 0;
    let lp2 = 0;
    let dc = 0;
    let env = 0;
    let target = 0;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      let x = rnd() * 2 - 1;
      if (grainy) {
        if (i % hop === 0) target = rnd() < 0.5 ? rnd() : rnd() * 0.12;
        env += (target - env) * 0.22;
        x *= 0.3 + 0.7 * env;
      }
      lp1 += aLow * (x - lp1);
      lp2 += aLow * (lp1 - lp2);
      const low = grainy ? lp2 : lp1; // the grain buffer gets the steeper roll-off
      dc += aHigh * (low - dc);
      const y = low - dc;
      d[i] = y;
      sum += y * y;
    }
    const scale = 0.35 / Math.sqrt(sum / n || 1);
    for (let i = 0; i < n; i++) d[i] *= scale;
    return buffer;
  }

  /**
   * Impulse response of a small, soft room: a few milliseconds of build-up, then noise that decays in about
   * half a second and gets darker as it goes. Only the tonal accents send a noticeable amount into it.
   */
  function makeImpulse(ctx, rnd) {
    const sr = ctx.sampleRate;
    const n = Math.floor(sr * 0.5);
    const buffer = ctx.createBuffer(2, n, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buffer.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const a = 0.5 - 0.36 * Math.min(1, t / 0.3);
        lp += a * (rnd() * 2 - 1 - lp);
        d[i] = lp * Math.exp(-t / 0.075) * Math.min(1, t / 0.004);
      }
    }
    return buffer;
  }

  /** Transfer curve of the soft limiter (see CLIP_*). Linear segments interpolate exactly, so below the knee it is transparent. */
  function makeClipCurve() {
    const n = 2049;
    const curve = new Float32Array(n);
    const room = CLIP_CEIL - CLIP_KNEE;
    for (let i = 0; i < n; i++) {
      const u = ((i / (n - 1)) * 2 - 1) * CLIP_RANGE;
      const a = Math.abs(u);
      const y = a <= CLIP_KNEE ? a : CLIP_KNEE + room * Math.tanh((a - CLIP_KNEE) / room);
      curve[i] = u < 0 ? -y : y;
    }
    return curve;
  }

  /** A smooth rise-and-fall (sin^2) that peaks `at` (0..1) of the way through. For setValueCurveAtTime. */
  function bellCurve(peak, at) {
    const n = 48;
    const curve = new Float32Array(n);
    const warp = Math.log(0.5) / Math.log(clamp(at, 0.05, 0.95));
    for (let i = 1; i < n - 1; i++) {
      const s = Math.sin(Math.PI * Math.pow(i / (n - 1), warp));
      curve[i] = peak * s * s;
    }
    return curve; // first and last points are exactly 0
  }

  /**
   * Writes an amplitude envelope on a gain AudioParam.
   *   'perc'  (default) linear attack (o.attack, default 2 ms) then an exponential decay reaching -60 dB at t + dur
   *   'swell' the same with a long attack (default 40% of dur)
   *   'rev'   backwards: an exponential build-up cut off by a short release (o.release) — the "undo" gesture
   *   'bell'  smooth rise and fall peaking at o.peak (0..1, default 0.4) of dur
   */
  function envelope(param, t, dur, level, o) {
    const shape = o.shape || 'perc';
    level = Math.max(level, 1e-5);
    if (shape === 'bell') {
      // Nothing else is scheduled on this param: browsers reject events that overlap a value curve.
      param.setValueCurveAtTime(bellCurve(level, o.peak || 0.4), t, dur);
    } else if (shape === 'rev') {
      const release = Math.min(o.release || 0.012, dur * 0.4);
      param.setValueAtTime(level * 0.03, t);
      param.exponentialRampToValueAtTime(level, t + dur - release);
      param.linearRampToValueAtTime(0, t + dur);
    } else {
      const attack = Math.min(o.attack || (shape === 'swell' ? dur * 0.4 : 0.002), dur * 0.6);
      param.setValueAtTime(0, t);
      param.linearRampToValueAtTime(level, t + attack);
      param.exponentialRampToValueAtTime(level * FLOOR, t + dur);
      param.setValueAtTime(0, t + dur);
    }
  }

  // ------------------------------------------------------------------ voice
  /**
   * One triggered sound: any number of sources mixed into one gain node (`out`), which is what gets panned,
   * levelled, sent to the reverb, faded when stolen and disconnected when everything in it has stopped.
   */
  function Voice(rig, name, prio, t0, pitch) {
    this.rig = rig;
    this.name = name;
    this.prio = prio;
    this.start = t0;
    this.end = t0;
    this.pitch = pitch;
    this.sources = [];
    this.last = null; // the source that stops last
    this.out = rig.ctx.createGain();
    this.panner = null;
    this.wet = null;
    this.dead = false;
  }

  Voice.prototype.track = function (source, stopAt) {
    this.sources.push(source);
    if (stopAt >= this.end) {
      this.end = stopAt;
      this.last = source;
    }
  };

  /**
   * A burst of filtered noise.
   *   at, dur     seconds (at is relative to the voice start)
   *   src         'soft' (default) | 'grain'
   *   gain        level; band-pass bursts are compensated for their bandwidth, so equal gains sound about equally loud
   *   f, q, type  biquad ('bandpass' by default). f2 [, f3]: the frequency glides to f2 over `sweep` seconds
   *               (default dur), or out to f2 and on to f3 with the turn at `turn` (0..1, default 0.5)
   *   shape, attack, release, peak   see envelope()
   *   to          destination node inside the voice (default: the voice output)
   */
  Voice.prototype.noise = function (o) {
    const rig = this.rig;
    const ctx = rig.ctx;
    const t = this.start + (o.at || 0);
    const dur = o.dur;
    const buffer = o.src === 'grain' ? rig.grain : rig.soft;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;

    const filter = ctx.createBiquadFilter();
    const q = o.q || 1;
    const f1 = rig.hz(o.f);
    let mean = f1;
    filter.type = o.type || 'bandpass';
    filter.Q.value = q;
    filter.frequency.setValueAtTime(f1, t);
    if (o.f2) {
      const f2 = rig.hz(o.f2);
      const sweep = Math.min(o.sweep || dur, dur);
      if (o.f3) {
        filter.frequency.exponentialRampToValueAtTime(f2, t + sweep * (o.turn || 0.5));
        filter.frequency.exponentialRampToValueAtTime(rig.hz(o.f3), t + sweep);
      } else {
        filter.frequency.exponentialRampToValueAtTime(f2, t + sweep);
      }
      mean = Math.sqrt(f1 * f2);
    }
    let level = o.gain;
    // Noise power through a band-pass grows with its bandwidth (f / Q): normalise it away.
    if (filter.type === 'bandpass') level *= clamp(Math.sqrt((BP_REF * q) / mean), 0.6, 4);

    const amp = ctx.createGain();
    envelope(amp.gain, t, dur, level, o);
    src.connect(filter);
    filter.connect(amp);
    amp.connect(o.to || this.out);

    const stopAt = t + dur + 0.005;
    src.start(t, rig.rnd() * (buffer.duration - 0.02));
    src.stop(stopAt);
    this.track(src, stopAt);
  };

  /**
   * An oscillator with an envelope.
   *   at, dur, gain, shape, attack     as for noise()
   *   f           Hz; f2: glides to it over `glide` seconds (default dur)
   *   wave        'sine' (default) | 'triangle'
   */
  Voice.prototype.tone = function (o) {
    const rig = this.rig;
    const ctx = rig.ctx;
    const t = this.start + (o.at || 0);
    const dur = o.dur;
    const osc = ctx.createOscillator();
    osc.type = o.wave || 'sine';
    osc.frequency.setValueAtTime(rig.hz(o.f), t);
    if (o.f2) osc.frequency.exponentialRampToValueAtTime(rig.hz(o.f2), t + Math.min(o.glide || dur, dur));
    const amp = ctx.createGain();
    envelope(amp.gain, t, dur, o.gain, o);
    osc.connect(amp);
    amp.connect(o.to || this.out);
    const stopAt = t + dur + 0.005;
    osc.start(t);
    osc.stop(stopAt);
    this.track(osc, stopAt);
  };

  /** A sub-mix placed left or right inside the voice (the two hands of a riffle). Falls back to the centre. */
  Voice.prototype.side = function (pan) {
    const ctx = this.rig.ctx;
    if (typeof ctx.createStereoPanner !== 'function') return this.out;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    p.connect(this.out);
    return p;
  };

  /** Fade out from `when` (context time). Used when a voice is stolen and by stopAll(). */
  Voice.prototype.kill = function (when) {
    if (this.dead) return;
    if (this.start > when) {
      // Not sounding yet: it never will.
      for (let i = 0; i < this.sources.length; i++) {
        try {
          this.sources[i].stop(0);
        } catch (err) {
          /* already stopped */
        }
      }
      this.release();
      return;
    }
    try {
      this.out.gain.setTargetAtTime(0, when, 0.006);
    } catch (err) {
      /* ignore */
    }
    const cut = when + 0.04;
    for (let i = 0; i < this.sources.length; i++) {
      try {
        this.sources[i].stop(cut);
      } catch (err) {
        /* already stopped */
      }
    }
    if (cut < this.end) this.end = cut;
  };

  /** Detach from the graph and from the rig's bookkeeping. Idempotent. */
  Voice.prototype.release = function () {
    if (this.dead) return;
    this.dead = true;
    const nodes = [this.out, this.panner, this.wet];
    for (let i = 0; i < nodes.length; i++) {
      if (!nodes[i]) continue;
      try {
        nodes[i].disconnect();
      } catch (err) {
        /* ignore */
      }
    }
    const list = this.rig.voices;
    const at = list.indexOf(this);
    if (at !== -1) list.splice(at, 1);
  };

  // ------------------------------------------------------------------ building blocks shared by several sounds
  /** A card landing: the paper tap, the knock of the felt-covered table under it, optionally a low thud. */
  function pat(v, at, k, gain, thud) {
    const j = v.rig.jit;
    v.noise({ at: at, dur: 0.075, gain: gain, f: 1900 * k * j(0.12), q: 0.9, attack: 0.0015 });
    v.noise({ at: at, dur: 0.11, gain: 0.7 * gain, f: 470 * k * j(0.15), q: 2, attack: 0.002 });
    if (thud) {
      v.tone({ at: at, f: 165 * k * j(0.1), f2: 98 * k, glide: 0.05, dur: 0.11, gain: 0.14 * gain * thud, attack: 0.003 });
    }
  }

  /** The lighter version: a card's edge snapping flat. */
  function snap(v, at, k, gain) {
    const j = v.rig.jit;
    v.noise({ at: at, dur: 0.055, gain: 0.7 * gain, f: 3200 * k * j(0.1), q: 1.2, attack: 0.001 });
    v.noise({ at: at, dur: 0.08, gain: 0.45 * gain, f: 540 * k * j(0.12), q: 2, attack: 0.002 });
  }

  /**
   * A soft mallet note (think marimba): the fundamental, the tuned 4th partial that gives the wooden attack,
   * and a little octave so low notes still speak on phone speakers.
   */
  function mallet(v, at, f, gain, ring) {
    const warm = clamp(600 / f, 0.15, 1); // high notes need fewer overtones
    v.tone({ at: at, f: f, dur: ring, gain: gain, attack: 0.004 });
    v.tone({ at: at, f: f * 2, dur: ring * 0.5, gain: gain * 0.16 * warm, attack: 0.004 });
    v.tone({ at: at, f: f * 4, dur: ring * 0.22, gain: gain * 0.2 * warm, attack: 0.002 });
  }

  /** A small glassy bell: fundamental plus two quiet, slightly detuned, faster-decaying partials. */
  function bell(v, at, f, gain, ring) {
    v.tone({ at: at, f: f, dur: ring, gain: gain, attack: 0.005 });
    v.tone({ at: at, f: f * 2.005, dur: ring * 0.6, gain: gain * 0.22, attack: 0.004 });
    v.tone({ at: at, f: f * 3.01, dur: ring * 0.3, gain: gain * 0.07, attack: 0.003 });
  }

  // ------------------------------------------------------------------ the sounds
  /*
   * name -> {
   *   level  overall gain (the calibration knob: see dev/audio-demo.html "Measure all")
   *   prio   who survives when the polyphony cap is hit (higher wins)
   *   gap    s. A second request for the same sound within this of an existing one is dropped
   *   wet    reverb send
   *   len(o) -> nominal length in seconds: an upper bound of what build() schedules
   *   build(v, o)  schedules the sources on voice v (v.start is the context time of the trigger)
   * }
   */
  const SOUNDS = {
    // A card leaving the deck — a bright, dry "fft" — and its edge flicking free.
    deal: {
      level: 2.35,
      prio: 1,
      gap: 0.012,
      wet: 0.04,
      len: function () {
        return 0.145;
      },
      build: function (v) {
        const j = v.rig.jit;
        const k = v.pitch * j(0.07);
        v.noise({ src: 'grain', dur: 0.07, gain: 0.8, f: 2900 * k, f2: 5200 * k, sweep: 0.055, q: 0.8, shape: 'bell', peak: 0.3 });
        snap(v, 0.05 * j(0.1), k * 1.1, 0.8);
      },
    },

    // Turning a card over: air under the card ("fwip"), then it lands ("tk").
    flip: {
      level: 1.76,
      prio: 1,
      gap: 0.02,
      wet: 0.05,
      len: function () {
        return 0.195;
      },
      build: function (v) {
        const j = v.rig.jit;
        const k = v.pitch * j(0.07);
        v.noise({ src: 'grain', dur: 0.112, gain: 0.75, f: 1500 * k, f2: 4300 * k, sweep: 0.09, q: 1.1, shape: 'swell', attack: 0.05 });
        snap(v, 0.096 * j(0.08), k * 0.95, 0.85);
      },
    },

    // Lifting a card off the pile: light, high, no body.
    pick: {
      level: 1.75,
      prio: 1,
      gap: 0.03,
      wet: 0.03,
      len: function () {
        return 0.07;
      },
      build: function (v) {
        const j = v.rig.jit;
        const k = v.pitch * j(0.07);
        v.noise({ src: 'grain', dur: 0.06, gain: 0.8, f: 3300 * k, f2: 5600 * k, sweep: 0.045, q: 1, shape: 'bell', peak: 0.3 });
        v.noise({ dur: 0.03, gain: 0.45, f: 4700 * k * j(0.1), q: 2, attack: 0.001 });
      },
    },

    // Setting a card down: the fullest of the card sounds, a soft "pat".
    place: {
      level: 3.5,
      prio: 2,
      gap: 0.02,
      wet: 0.05,
      len: function () {
        return 0.12;
      },
      build: function (v) {
        const j = v.rig.jit;
        const k = v.pitch * j(0.07);
        pat(v, 0, k, 1, 1);
        v.noise({ src: 'grain', dur: 0.03, gain: 0.3, f: 4300 * k * j(0.1), q: 1.5, attack: 0.001 });
      },
    },

    // A card dragged across the felt.
    slide: {
      level: 0.8,
      prio: 1,
      gap: 0.03,
      wet: 0.04,
      len: function (o) {
        return span(o, 0.19, 0.08, 1.2) + 0.01;
      },
      build: function (v, o) {
        const j = v.rig.jit;
        const k = v.pitch * j(0.08);
        const d = span(o, 0.19, 0.08, 1.2);
        v.noise({ src: 'grain', dur: d, gain: 0.8, f: 2000 * k, f2: 3100 * k, f3: 2300 * k, q: 0.7, shape: 'bell', peak: 0.35 });
        v.noise({ at: d * 0.05, dur: d * 0.85, gain: 0.3, f: 850 * k, q: 0.8, shape: 'bell', peak: 0.4 });
      },
    },

    // Stock to waste: slides off the stock, snaps down face-up.
    draw: {
      level: 1.85,
      prio: 1,
      gap: 0.02,
      wet: 0.05,
      len: function () {
        return 0.17;
      },
      build: function (v) {
        const j = v.rig.jit;
        const k = v.pitch * j(0.07);
        const at = 0.07 * j(0.1);
        v.noise({ src: 'grain', dur: 0.085, gain: 0.8, f: 2500 * k, f2: 4400 * k, sweep: 0.06, q: 0.8, shape: 'bell', peak: 0.35 });
        snap(v, at, k, 0.9);
        v.tone({ at: at, f: 150 * k, f2: 100 * k, glide: 0.04, dur: 0.08, gain: 0.08, attack: 0.003 });
      },
    },

    // The waste swept back onto the stock: a falling run of ticks over a swish, squared up with a pat.
    recycle: {
      level: 1.33,
      prio: 2,
      gap: 0.1,
      wet: 0.05,
      len: function (o) {
        return span(o, 0.42, 0.2, 1.5) + 0.12;
      },
      build: function (v, o) {
        const rig = v.rig;
        const j = rig.jit;
        const k = v.pitch * j(0.06);
        const d = span(o, 0.42, 0.2, 1.5);
        const n = clamp(Math.round(d / 0.042), 5, 16);
        for (let i = 0; i < n; i++) {
          const u = i / (n - 1);
          v.noise({
            at: d * 0.74 * Math.pow(u, 0.8) + rig.rnd() * 0.005,
            dur: 0.04,
            gain: 0.35 + 0.3 * u,
            f: (4300 - 1800 * u) * k * j(0.08),
            q: 2.2,
            attack: 0.001,
          });
        }
        v.noise({ src: 'grain', dur: d * 0.8, gain: 0.4, f: 2700 * k, f2: 1500 * k, q: 0.7, shape: 'bell', peak: 0.55 });
        pat(v, d * 0.8, k * 0.9, 0.9, 1);
      },
    },

    // A card reaching its foundation: a soft landing and a mallet note whose pitch is the card's rank.
    foundation: {
      level: 1.6,
      prio: 3,
      gap: 0.015,
      wet: 0.22,
      len: function (o) {
        return rankOf(o) === 13 ? 0.75 : 0.5;
      },
      build: function (v, o) {
        const j = v.rig.jit;
        const rank = rankOf(o);
        const u = (rank - 1) / 12;
        const f = note(SCALE[rank - 1]) * v.pitch;
        pat(v, 0, 1.1 * j(0.06), 0.8, 0);
        mallet(v, 0.004, f, 0.3 * j(0.08), 0.44 - 0.12 * u);
        if (rank === 13) {
          // The suit is complete: the tonic gets a little rising sparkle (F#6, A6, D7).
          bell(v, 0.075, note(33) * v.pitch, 0.13, 0.4);
          bell(v, 0.15, note(36) * v.pitch, 0.11, 0.45);
          bell(v, 0.225, note(41) * v.pitch, 0.07, 0.5);
        }
      },
    },

    // "No": a soft, low double knock. Dull rather than harsh — it is heard often.
    invalid: {
      level: 0.93,
      prio: 2,
      gap: 0.08,
      wet: 0.06,
      len: function () {
        return 0.26;
      },
      build: function (v) {
        const j = v.rig.jit;
        const k = v.pitch * j(0.04);
        for (let i = 0; i < 2; i++) {
          const at = i * 0.11;
          const drop = 1 - i * 0.16;
          const g = 1 - i * 0.18;
          // Pitched where phone speakers still reproduce it; the triangle an octave below adds weight elsewhere.
          v.tone({ at: at, f: 330 * k * drop, f2: 240 * k * drop, glide: 0.08, dur: 0.14, gain: 0.3 * g, attack: 0.005 });
          v.tone({ at: at, wave: 'triangle', f: 165 * k * drop, f2: 120 * k * drop, glide: 0.08, dur: 0.1, gain: 0.14 * g, attack: 0.005 });
          v.noise({ at: at, dur: 0.07, gain: 0.8 * g, f: 640 * k, q: 1.5, attack: 0.002 });
        }
      },
    },

    // "Look here": two small bells, a rising fourth (E5 -> A5).
    hint: {
      level: 0.9,
      prio: 2,
      gap: 0.1,
      wet: 0.28,
      len: function () {
        return 0.56;
      },
      build: function (v) {
        const g = v.rig.jit(0.08);
        bell(v, 0, note(19) * v.pitch, 0.2 * g, 0.34);
        bell(v, 0.115, note(24) * v.pitch, 0.22 * g, 0.43);
      },
    },

    // The last move sucked back: a swish played backwards, then the card settles.
    undo: {
      level: 1.1,
      prio: 1,
      gap: 0.03,
      wet: 0.04,
      len: function () {
        return 0.21;
      },
      build: function (v) {
        const j = v.rig.jit;
        const k = v.pitch * j(0.07);
        v.noise({ src: 'grain', dur: 0.125, gain: 0.8, f: 4000 * k, f2: 1500 * k, sweep: 0.115, q: 1, shape: 'rev', release: 0.014 });
        snap(v, 0.12, k * 0.75, 0.6);
      },
    },

    // A riffle: many tiny ticks falling faster and faster from two hands, the bridge, and the deck squared up.
    shuffle: {
      level: 1.48,
      prio: 2,
      gap: 0.2,
      wet: 0.06,
      len: function (o) {
        return span(o, 0.72, 0.4, 2.5) + 0.12;
      },
      build: function (v, o) {
        const rig = v.rig;
        const j = rig.jit;
        const k = v.pitch * j(0.05);
        const d = span(o, 0.72, 0.4, 2.5);
        const riffle = d * 0.64;
        const n = clamp(Math.round(riffle / 0.012), 18, 64);
        const hands = [v.side(-0.32), v.side(0.32)];
        for (let i = 0; i < n; i++) {
          const u = i / (n - 1);
          v.noise({
            to: hands[i & 1],
            at: riffle * Math.pow(u, 0.72) + rig.rnd() * 0.004,
            dur: 0.022 + rig.rnd() * 0.014,
            gain: (0.3 + 0.35 * rig.rnd()) * (0.65 + 0.35 * u),
            f: (2500 + 1700 * u) * k * j(0.16),
            q: 2.4,
            attack: 0.0006,
          });
        }
        v.noise({ src: 'grain', dur: riffle * 1.05, gain: 0.3, f: 1700 * k, f2: 3000 * k, q: 0.6, shape: 'bell', peak: 0.7 });
        v.noise({ src: 'grain', at: riffle + 0.03, dur: d * 0.2, gain: 0.55, f: 1900 * k, f2: 3500 * k, q: 0.8, shape: 'bell', peak: 0.4 });
        pat(v, d * 0.9, k * 0.95, 0.85, 1);
      },
    },

    // Buttons: a small wooden "tok".
    click: {
      level: 2.7,
      prio: 2,
      gap: 0.03,
      wet: 0.05,
      len: function () {
        return 0.06;
      },
      build: function (v) {
        const k = v.pitch * v.rig.jit(0.04);
        v.tone({ f: 1080 * k, f2: 760 * k, glide: 0.03, dur: 0.045, gain: 0.3, attack: 0.001 });
        v.noise({ dur: 0.014, gain: 0.5, f: 3200 * k, q: 1.5, attack: 0.0007 });
      },
    },

    // A panel opening: air moving up and a rising fifth (D5 -> A5).
    open: {
      level: 0.7,
      prio: 2,
      gap: 0.08,
      wet: 0.25,
      len: function () {
        return 0.4;
      },
      build: function (v) {
        const k = v.pitch * v.rig.jit(0.05);
        v.noise({ src: 'grain', dur: 0.2, gain: 0.45, f: 700 * k, f2: 2600 * k, sweep: 0.16, q: 1, shape: 'bell', peak: 0.45 });
        bell(v, 0.02, note(17) * v.pitch, 0.14, 0.2);
        bell(v, 0.09, note(24) * v.pitch, 0.16, 0.28);
      },
    },

    // ...and closing: the mirror image.
    close: {
      level: 0.76,
      prio: 2,
      gap: 0.08,
      wet: 0.25,
      len: function () {
        return 0.36;
      },
      build: function (v) {
        const k = v.pitch * v.rig.jit(0.05);
        v.noise({ src: 'grain', dur: 0.18, gain: 0.45, f: 2500 * k, f2: 700 * k, sweep: 0.15, q: 1, shape: 'bell', peak: 0.35 });
        bell(v, 0.01, note(24) * v.pitch, 0.14, 0.18);
        bell(v, 0.08, note(17) * v.pitch, 0.16, 0.26);
      },
    },

    // Auto-complete begins: a quick run up the scale (D5 .. D6) on a breath of air.
    autocomplete: {
      level: 1.13,
      prio: 3,
      gap: 0.2,
      wet: 0.3,
      len: function () {
        return 0.75;
      },
      build: function (v) {
        const run = [17, 19, 21, 24, 26, 29];
        for (let i = 0; i < run.length; i++) {
          bell(v, i * 0.052, note(run[i]) * v.pitch, 0.12 + 0.012 * i, i === run.length - 1 ? 0.42 : 0.24);
        }
        v.noise({ src: 'grain', dur: 0.36, gain: 0.35, f: 1200 * v.pitch, f2: 4800 * v.pitch, q: 0.9, shape: 'bell', peak: 0.6 });
      },
    },

    // The win: a short fanfare (A4 D5 F#5 A5 . F#5 A5 D6) resolving on a strummed D major chord with twinkles above.
    win: {
      level: 1.4,
      prio: 4,
      gap: 0.5,
      wet: 0.35,
      len: function () {
        return 2.4;
      },
      build: function (v) {
        const rig = v.rig;
        const p = v.pitch;
        const melody = [[0, 12, 0.8], [0.1, 17, 0.85], [0.2, 21, 0.9], [0.3, 24, 1.1], [0.52, 21, 0.85], [0.62, 24, 0.95], [0.76, 29, 1.25]];
        for (let i = 0; i < melody.length; i++) {
          const m = melody[i];
          mallet(v, m[0], note(m[1]) * p, 0.15 * m[2], i === melody.length - 1 ? 1.3 : 0.5);
        }
        const chord = [5, 12, 17, 21]; // D4 A4 D5 F#5
        for (let i = 0; i < chord.length; i++) {
          v.tone({ at: 0.76 + i * 0.02, f: note(chord[i]) * p, dur: 1.5, gain: 0.07, attack: 0.03 });
        }
        v.tone({ at: 0.76, f: note(-7) * p, dur: 1.2, gain: 0.1, attack: 0.02 }); // D3 underneath
        v.noise({ src: 'grain', at: 0.4, dur: 0.4, gain: 0.3, f: 900 * p, f2: 5200 * p, q: 0.9, shape: 'bell', peak: 0.8 });
        const twinkle = [36, 38, 41, 45]; // A6 B6 D7 F#7
        for (let i = 0; i < 6; i++) {
          bell(v, 0.92 + i * 0.12 + rig.rnd() * 0.04, note(twinkle[Math.floor(rig.rnd() * twinkle.length)]) * p, 0.035, 0.3);
        }
      },
    },

    // The smallest sound: counters rolling, the clock.
    tick: {
      level: 2.45,
      prio: 0,
      gap: 0.02,
      wet: 0.03,
      len: function () {
        return 0.04;
      },
      build: function (v) {
        const k = v.pitch * v.rig.jit(0.03);
        v.tone({ f: 1900 * k, f2: 1500 * k, glide: 0.015, dur: 0.028, gain: 0.25, attack: 0.001 });
        v.noise({ dur: 0.012, gain: 0.45, f: 5200 * k, q: 3, attack: 0.0006 });
      },
    },

    // Cards sweeping through the air (gathering the deck, the celebration).
    whoosh: {
      level: 0.46,
      prio: 1,
      gap: 0.05,
      wet: 0.08,
      len: function (o) {
        return span(o, 0.34, 0.12, 2) + 0.01;
      },
      build: function (v, o) {
        const j = v.rig.jit;
        const k = v.pitch * j(0.1);
        const d = span(o, 0.34, 0.12, 2);
        v.noise({ src: 'grain', dur: d, gain: 0.85, f: 520 * k, f2: 2300 * k, f3: 800 * k, turn: 0.45, q: 0.9, shape: 'bell', peak: 0.45 });
        v.noise({ dur: d, gain: 0.35, f: 240 * k, f2: 700 * k, f3: 300 * k, turn: 0.45, q: 0.7, shape: 'bell', peak: 0.45 });
      },
    },
  };

  function has(name) {
    return typeof name === 'string' && Object.prototype.hasOwnProperty.call(SOUNDS, name);
  }

  // ------------------------------------------------------------------ rig: the graph on one context
  /** The largest number of `voices` sounding at the same instant somewhere in [t0, t1]. */
  function concurrency(voices, t0, t1) {
    const marks = [];
    for (let i = 0; i < voices.length; i++) {
      const v = voices[i];
      if (v.start >= t1 || v.end <= t0) continue;
      marks.push([Math.max(v.start, t0), 1], [Math.min(v.end, t1), -1]);
    }
    marks.sort(function (a, b) {
      return a[0] - b[0] || a[1] - b[1]; // an end before a start at the same instant
    });
    let now = 0;
    let most = 0;
    for (let i = 0; i < marks.length; i++) {
      now += marks[i][1];
      if (now > most) most = now;
    }
    return most;
  }

  /**
   * Builds noise buffers, reverb and the master chain on `ctx` (any BaseAudioContext) and returns the object
   * that plays sounds on it. Throws only if the context lacks the basics (gain / buffer sources / biquads);
   * optional nodes (compressor, shaper, convolver, panner) are skipped when missing.
   */
  function createRig(ctx, options) {
    const opt = options || {};
    const rnd = typeof opt.random === 'function' ? opt.random : Math.random;
    const nyquist = ctx.sampleRate / 2;

    const rig = {
      ctx: ctx,
      voices: [],
      rnd: rnd,
      /** 1 +- amount, uniformly. */
      jit: function (amount) {
        return 1 + (rnd() * 2 - 1) * amount;
      },
      /** A frequency this context can represent. */
      hz: function (f) {
        return clamp(f, 20, nyquist * 0.92);
      },
      soft: makeNoise(ctx, rnd, false),
      grain: makeNoise(ctx, rnd, true),
      input: null,
      output: null,
      verb: null,
    };

    // ---- master chain: bus -> compressor -> (trim) -> soft limiter -> volume -> destination
    const bus = ctx.createGain();
    const master = ctx.createGain();
    let volume = clamp(num(opt.volume, 1), 0, 1);
    let muted = false;
    master.gain.value = Math.pow(volume, 1.5);

    let tail = bus;
    let makeup = 1;
    if (typeof ctx.createDynamicsCompressor === 'function') {
      try {
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = COMP.threshold;
        comp.knee.value = COMP.knee;
        comp.ratio.value = COMP.ratio;
        comp.attack.value = COMP.attack;
        comp.release.value = COMP.release;
        tail.connect(comp);
        tail = comp;
        makeup = COMP_MAKEUP;
      } catch (err) {
        report('compressor', err);
      }
    }
    let limited = false;
    if (typeof ctx.createWaveShaper === 'function') {
      try {
        const pre = ctx.createGain();
        const shaper = ctx.createWaveShaper();
        pre.gain.value = 1 / (makeup * CLIP_RANGE);
        shaper.curve = makeClipCurve();
        tail.connect(pre);
        pre.connect(shaper);
        tail = shaper;
        limited = true;
      } catch (err) {
        report('limiter', err);
      }
    }
    if (!limited && makeup !== 1) {
      const trim = ctx.createGain();
      trim.gain.value = 1 / makeup;
      tail.connect(trim);
      tail = trim;
    }
    tail.connect(master);
    master.connect(opt.destination || ctx.destination);
    rig.input = bus;
    rig.output = master;

    // ---- reverb return
    if (typeof ctx.createConvolver === 'function') {
      try {
        const verbIn = ctx.createGain();
        const conv = ctx.createConvolver();
        const verbOut = ctx.createGain();
        conv.buffer = makeImpulse(ctx, rnd);
        verbOut.gain.value = 0.55;
        verbIn.connect(conv);
        conv.connect(verbOut);
        verbOut.connect(bus);
        rig.verb = verbIn;
      } catch (err) {
        report('reverb', err);
      }
    }

    function applyVolume() {
      const g = muted ? 0 : Math.pow(volume, 1.5);
      try {
        master.gain.setTargetAtTime(g, ctx.currentTime, 0.012);
      } catch (err) {
        master.gain.value = g;
      }
    }

    rig.setVolume = function (v) {
      volume = clamp(num(v, volume), 0, 1);
      applyVolume();
    };

    rig.setMuted = function (m) {
      muted = !!m;
      applyVolume();
    };

    /** Fades out everything sounding and cancels everything scheduled. */
    rig.stopAll = function () {
      const now = ctx.currentTime;
      const list = rig.voices.slice();
      rig.voices.length = 0; // the faded voices detach themselves when their sources end
      for (let i = 0; i < list.length; i++) list[i].kill(now);
    };

    function prune(now) {
      for (let i = rig.voices.length - 1; i >= 0; i--) {
        if (rig.voices[i].end + 0.05 < now) rig.voices[i].release();
      }
    }

    /**
     * Schedules a sound. Returns the Voice, or null when it was not played (unknown name, zero volume, or
     * dropped by the limiter). Never throws.
     */
    rig.play = function (name, options) {
      if (!has(name)) return null;
      let voice = null;
      try {
        const def = SOUNDS[name];
        const o = options && typeof options === 'object' ? options : {};
        const pitch = clamp(num(o.pitch, 1), 0.25, 4);
        const volumeOpt = clamp(num(o.volume, 1), 0, 2);
        if (volumeOpt < 0.0005) return null;
        const pan = clamp(num(o.pan, 0), -1, 1);
        const now = ctx.currentTime;
        const t0 = now + LOOKAHEAD + clamp(num(o.delay, 0) / 1000, 0, MAX_DELAY);
        const t1 = t0 + def.len(o);

        prune(now);
        const voices = rig.voices;
        if (voices.length >= MAX_PENDING) return null;

        let stacked = 0; // copies of this sound still ringing at t0, weighted by how much of them is left
        let victim = null;
        for (let i = 0; i < voices.length; i++) {
          const other = voices[i];
          if (other.name === name) {
            if (Math.abs(other.start - t0) < def.gap) return null; // the same sound, the same instant: one is enough
            if (other.start <= t0 && other.end > t0) stacked += (other.end - t0) / (other.end - other.start);
          }
          if (other.start <= t0 && other.end > t0 && other.prio < def.prio) {
            if (!victim || other.prio < victim.prio || (other.prio === victim.prio && other.start < victim.start)) victim = other;
          }
        }
        if (concurrency(voices, t0, t1) >= MAX_VOICES) {
          if (!victim) return null; // nothing less important to push out
          victim.kill(t0);
        }

        voice = new Voice(rig, name, def.prio, t0, pitch);
        def.build(voice, o);

        // Without a panner the mono voice would reach both speakers at full level: match the centre of the
        // equal-power pan law so a sound does not jump in level when it starts to move.
        let level = def.level * volumeOpt * rig.jit(0.08) / Math.sqrt(1 + DUCK * stacked);
        let outlet = voice.out;
        if (pan !== 0 && typeof ctx.createStereoPanner === 'function') {
          voice.panner = ctx.createStereoPanner();
          voice.panner.pan.value = pan;
          voice.out.connect(voice.panner);
          outlet = voice.panner;
        } else {
          level *= Math.SQRT1_2;
        }
        voice.out.gain.value = level;
        outlet.connect(bus);
        if (rig.verb && def.wet > 0) {
          voice.wet = ctx.createGain();
          voice.wet.gain.value = def.wet;
          voice.out.connect(voice.wet);
          voice.wet.connect(rig.verb);
        }
        if (voice.last) {
          const done = voice;
          voice.last.onended = function () {
            done.release();
          };
        }
        voices.push(voice);
        return voice;
      } catch (err) {
        report('play("' + name + '")', err);
        if (voice) {
          // Half-built: make sure nothing of it can sound.
          try {
            voice.kill(-1);
            voice.release();
          } catch (err2) {
            /* ignore */
          }
        }
        return null;
      }
    };

    return rig;
  }

  // ------------------------------------------------------------------ the live context
  let enabled = true;
  let volume = DEFAULT_VOLUME;
  let inited = false;
  let ctx = null;
  let live = null; // rig on ctx
  let failures = 0; // contexts that could not be created
  let lastWake = -1e9; // wall-clock ms of the last resume() attempt

  function wallNow() {
    return root.performance && typeof root.performance.now === 'function' ? root.performance.now() : Date.now();
  }

  function ContextClass() {
    return root.AudioContext || root.webkitAudioContext || null;
  }

  function isHidden() {
    return !!(root.document && root.document.visibilityState === 'hidden');
  }

  /** 1: the page has been activated by the user, 0: it has not, -1: the browser cannot tell us. */
  function activation() {
    const ua = root.navigator && root.navigator.userActivation;
    if (!ua) return -1;
    return ua.isActive || ua.hasBeenActive ? 1 : 0;
  }

  /**
   * Creates the context if needed and resumes it. Only does so when the browser will allow it (inside or
   * after a user gesture), so no context is ever created just to sit there blocked by the autoplay policy.
   */
  function wake(fromGesture) {
    const AC = ContextClass();
    if (!AC || !enabled || failures >= 3) return false;
    const act = activation();
    // act === 0 inside a gesture handler: e.g. a touch pointerdown, which is not an activation in Chromium.
    // The pointerup / touchend that follows is, and brings us back here.
    if (act === 0 || (act === -1 && !fromGesture)) return false;
    try {
      if (!ctx) {
        let created = null;
        try {
          created = new AC({ latencyHint: 'interactive' });
        } catch (err) {
          created = new AC();
        }
        const rig = createRig(created, { volume: volume });
        ctx = created;
        live = rig;
        try {
          // The classic iOS unlock: start any source from inside the gesture.
          const blip = ctx.createBufferSource();
          blip.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
          blip.connect(ctx.destination);
          blip.start(0);
        } catch (err) {
          /* not needed elsewhere */
        }
      }
      if (ctx.state !== 'running' && !isHidden()) {
        const now = wallNow();
        // Anything scheduled during an earlier, failed wake-up is stale by now: it must not burst out late.
        if (now - lastWake > WAKE_WINDOW) live.stopAll();
        lastWake = now;
        settle(ctx.resume());
      }
      return true;
    } catch (err) {
      report('wake', err);
      if (!live) {
        failures++;
        ctx = null;
      }
      return false;
    }
  }

  function onGesture() {
    if (enabled && (!ctx || ctx.state !== 'running')) wake(true);
  }

  function onVisibility() {
    if (!ctx) return;
    try {
      if (isHidden()) {
        // Nobody is listening, and anything still queued would be out of date when the tab comes back.
        live.stopAll();
        if (ctx.state === 'running') settle(ctx.suspend());
      } else if (enabled) {
        wake(false);
      }
    } catch (err) {
      report('visibility', err);
    }
  }

  function syncSettings() {
    try {
      if (SOL.Settings && typeof SOL.Settings.get === 'function') {
        setEnabled(!!SOL.Settings.get('sound'));
        setVolume(SOL.Settings.get('volume'));
      }
      if (SOL.Bus && typeof SOL.Bus.on === 'function') {
        SOL.Bus.on('settings:change', function (e) {
          if (!e) return;
          if (e.key === 'sound') setEnabled(!!e.value);
          else if (e.key === 'volume') setVolume(e.value);
        });
      }
    } catch (err) {
      report('settings', err);
    }
  }

  function init() {
    if (!inited) {
      inited = true;
      try {
        if (typeof root.addEventListener === 'function') {
          // Capture phase on window: we run before the game's own handlers, so the very gesture that unlocks
          // audio can already make a sound. pointerup / touchend matter: on touch screens the *release* is the
          // activation, not the press.
          const types = ['pointerdown', 'pointerup', 'mousedown', 'touchend', 'keydown', 'click'];
          for (let i = 0; i < types.length; i++) root.addEventListener(types[i], onGesture, { capture: true, passive: true });
        }
        if (root.document && typeof root.document.addEventListener === 'function') {
          root.document.addEventListener('visibilitychange', onVisibility);
        }
      } catch (err) {
        report('init', err);
      }
      syncSettings();
    }
    // init() called late (or from inside a click handler): the page may already be allowed to make sound.
    if (enabled && activation() === 1) wake(false);
    return Audio;
  }

  function setEnabled(on) {
    on = !!on;
    if (on === enabled) return;
    enabled = on;
    try {
      if (on) {
        if (live) live.setMuted(false);
        wake(false);
      } else if (live) {
        live.stopAll();
        live.setMuted(true);
        // Give the fade a moment, then release the audio device (on phones a running context can hold the
        // audio session and costs battery).
        if (typeof root.setTimeout === 'function') {
          root.setTimeout(function () {
            if (!enabled && ctx && ctx.state === 'running') {
              try {
                settle(ctx.suspend());
              } catch (err) {
                /* ignore */
              }
            }
          }, 150);
        }
      }
    } catch (err) {
      report('setEnabled', err);
    }
  }

  function setVolume(v) {
    volume = clamp(num(v, volume), 0, 1);
    try {
      if (live) live.setVolume(volume);
    } catch (err) {
      report('setVolume', err);
    }
  }

  function play(name, opts) {
    try {
      if (!enabled || !has(name)) return false;
      if (!inited) init(); // forgiving: the sound is lost, but the listeners are armed for the next one
      if (isHidden()) return false;
      if (!live && !wake(false)) return false;
      if (ctx.state !== 'running') {
        if (wallNow() - lastWake > WAKE_WINDOW) {
          // Suspended and not about to start. Scheduling now would pile sounds up on a frozen clock and
          // release them all at once later, so drop this one — and try to get going again for the next.
          live.stopAll();
          wake(false);
          return false;
        }
        // else: resume() was just called from a gesture; the context starts within milliseconds and plays this.
      }
      return live.play(name, opts) !== null;
    } catch (err) {
      report('play', err);
      return false;
    }
  }

  function playFoundation(rank, opts) {
    const o = {};
    if (opts && typeof opts === 'object') {
      for (const key in opts) o[key] = opts[key];
    }
    o.rank = rank;
    return play('foundation', o);
  }

  function stopAll() {
    try {
      if (live) live.stopAll();
    } catch (err) {
      report('stopAll', err);
    }
  }

  function duration(name, opts) {
    try {
      return has(name) ? Math.round(SOUNDS[name].len(opts && typeof opts === 'object' ? opts : {}) * 1000) : 0;
    } catch (err) {
      return 0;
    }
  }

  // ------------------------------------------------------------------ offline rendering (tests, demo page)
  function render(events, options) {
    return new Promise(function (resolve) {
      try {
        const Offline = root.OfflineAudioContext || root.webkitOfflineAudioContext;
        if (!Offline) {
          resolve(null);
          return;
        }
        const opt = options || {};
        const list = [];
        const input = Array.isArray(events) ? events : [events];
        for (let i = 0; i < input.length; i++) {
          const e = input[i];
          if (typeof e === 'string') list.push([e, {}]);
          else if (Array.isArray(e)) list.push([e[0], e[1] || {}]);
          else if (e && typeof e === 'object') list.push([e.name, e.opts || {}]);
        }
        let seconds = 0;
        for (let i = 0; i < list.length; i++) {
          const o = list[i][1];
          const at = clamp(num(o.delay, 0) / 1000, 0, MAX_DELAY);
          seconds = Math.max(seconds, at + duration(list[i][0], o) / 1000);
        }
        seconds += LOOKAHEAD + 0.01 + num(opt.tail, 250) / 1000; // 0.01: the compressor's look-ahead delay
        if (num(opt.duration, 0) > 0) seconds = opt.duration / 1000;
        const sampleRate = num(opt.sampleRate, 44100);
        const offline = new Offline(2, Math.max(1, Math.ceil(seconds * sampleRate)), sampleRate);
        const rig = createRig(offline, {
          random: opt.seed === undefined || opt.seed === null ? Math.random : mulberry32(opt.seed),
          volume: num(opt.volume, 1),
        });
        for (let i = 0; i < list.length; i++) rig.play(list[i][0], list[i][1]);
        const fail = function (err) {
          report('render', err);
          resolve(null);
        };
        offline.oncomplete = function (e) {
          resolve(e.renderedBuffer); // old WebKit only has the event; elsewhere this resolves first, harmlessly
        };
        const p = offline.startRendering();
        if (p && typeof p.then === 'function') p.then(resolve, fail);
      } catch (err) {
        report('render', err);
        resolve(null);
      }
    });
  }

  // ------------------------------------------------------------------ public object
  const Audio = {
    NAMES: NAMES.slice(),
    debug: false,
    init: init,
    setEnabled: setEnabled,
    setVolume: setVolume,
    play: play,
    playFoundation: playFoundation,
    unlock: function () {
      if (!inited) init();
      return wake(true);
    },
    stopAll: stopAll,
    duration: duration,
    createRig: createRig,
    render: render,
  };

  Object.defineProperties(Audio, {
    enabled: {
      enumerable: true,
      get: function () {
        return enabled;
      },
      set: setEnabled,
    },
    volume: {
      enumerable: true,
      get: function () {
        return volume;
      },
      set: setVolume,
    },
    supported: {
      enumerable: true,
      get: function () {
        return !!ContextClass() && failures < 3;
      },
    },
    state: {
      enumerable: true,
      get: function () {
        if (!ContextClass() || failures >= 3) return 'unsupported';
        return ctx ? ctx.state : 'idle';
      },
    },
    voices: {
      enumerable: true,
      get: function () {
        return live ? live.voices.length : 0;
      },
    },
    context: {
      enumerable: true,
      get: function () {
        return ctx;
      },
    },
    output: {
      enumerable: true,
      get: function () {
        return live ? live.output : null;
      },
    },
  });

  SOL.Audio = Audio;
})(typeof window !== 'undefined' ? window : globalThis);
