/*
 * SOL.RNG — small deterministic random number generator (mulberry32) + shuffle.
 *
 * Public API
 *   RNG.create(seed)        -> { next(), int(n), seed }
 *                              next()  float in [0, 1)
 *                              int(n)  integer in [0, n)   (0 when n < 1)
 *                              seed    the uint32 the generator was created with
 *                              Same seed => same sequence, on every engine (integer math only).
 *   RNG.shuffle(array, rng) -> the same array, shuffled in place (Fisher–Yates, from the end down).
 *                              `rng` is anything with next(); when omitted, a randomly seeded one is used.
 *   RNG.randomSeed()        -> uint32. The only non-deterministic function (crypto when available,
 *                              Math.random otherwise).
 *   RNG.normalizeSeed(seed) -> uint32 for any input (numbers are truncated to 32 bits, numeric strings
 *                              are parsed, anything else hashes to a stable uint32).
 *
 * Pure logic: no DOM, no timers. Loads in Node via require().
 */
(function (root) {
  'use strict';

  const SOL = (root.SOL = root.SOL || {});

  /** Coerce anything to a uint32 seed (stable for the same input). */
  function normalizeSeed(seed) {
    if (typeof seed === 'number' && isFinite(seed)) return seed >>> 0;
    if (typeof seed === 'string' && seed.length > 0) {
      const n = Number(seed);
      if (isFinite(n)) return n >>> 0;
      // FNV-1a so that text seeds ("daily-2026-01-01") still give a stable deal.
      let h = 0x811c9dc5;
      for (let i = 0; i < seed.length; i++) {
        h ^= seed.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
      }
      return h >>> 0;
    }
    return 0;
  }

  /** mulberry32: tiny, fast, good enough for shuffling a deck, and identical everywhere. */
  function create(seed) {
    const start = normalizeSeed(seed);
    let a = start;

    function next() {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    function int(n) {
      const max = Math.floor(n);
      if (!(max >= 1)) return 0;
      return Math.floor(next() * max);
    }

    return { next: next, int: int, seed: start };
  }

  /** In-place Fisher–Yates. Returns the array it was given. */
  function shuffle(array, rng) {
    const r = rng && typeof rng.next === 'function' ? rng : create(randomSeed());
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(r.next() * (i + 1));
      const tmp = array[i];
      array[i] = array[j];
      array[j] = tmp;
    }
    return array;
  }

  function randomSeed() {
    try {
      const c = root.crypto;
      if (c && typeof c.getRandomValues === 'function') {
        const buf = new Uint32Array(1);
        c.getRandomValues(buf);
        return buf[0] >>> 0;
      }
    } catch (err) {
      /* fall through to Math.random */
    }
    return Math.floor(Math.random() * 4294967296) >>> 0;
  }

  SOL.RNG = { create: create, shuffle: shuffle, randomSeed: randomSeed, normalizeSeed: normalizeSeed };

  if (typeof module !== 'undefined' && module.exports) module.exports = SOL.RNG;
})(typeof window !== 'undefined' ? window : globalThis);
