/*
 * Tests for SOL.RNG and SOL.Engine (js/core/rng.js, js/core/engine.js).
 *
 * Run with:   node --test "/home/user/hero/solitaire/tests/*.test.js"
 *        or:  cd /home/user/hero/solitaire && node --test
 * (Node 22 no longer accepts a bare directory: `node --test /home/user/hero/solitaire/tests/`
 *  tries to load the directory as a module and fails before any test runs.)
 *
 * What is covered: the RNG; the deal (shape, determinism, a pinned layout); every rule of draw,
 * recycle, move and undo with exact records; scoring; win; clone / serialize / deserialize
 * (round trips and some eighty kinds of corruption); bestTarget; every hint kind and the pointless
 * moves that must not be hinted; isStuck (hand-made positions plus an exhaustive cross-check on
 * real dead ends); auto-complete; and random playouts over many seeds that check every invariant
 * and every record after every action.
 *
 * The file has two parts. The first (14 suites) was written with the engine. The second, the
 * suite 'REVIEW (black box, from the contract alone)' at the end, was written afterwards by an
 * independent reviewer from the build contract only, with its own helpers and its own naive
 * statement of the rules; it is where to look for what the contract promises (the replay rule
 * for records, undo exactness on 640 playouts, auto-complete termination, isStuck checked by
 * brute force, hints never illegal / never missing / never circular, deserialize on garbage).
 * The whole file takes about 45 seconds.
 */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const RNG = require(path.join(__dirname, '..', 'js', 'core', 'rng.js'));
const Engine = require(path.join(__dirname, '..', 'js', 'core', 'engine.js'));

const { PILE_IDS, TABLEAU, FOUNDATIONS } = Engine;
const UNDO = { type: 'undo' };
const DRAW = { type: 'draw' };

// ------------------------------------------------------------------------------------- helpers
const SUIT_LETTERS = { S: 0, H: 1, C: 2, D: 3 };
const RANK_WORDS = { A: 1, J: 11, Q: 12, K: 13 };

/** 'AS', '10H', 'KD' -> card id */
function C(name) {
  const m = /^(A|[2-9]|10|J|Q|K)([SHCD])$/.exec(name);
  assert.ok(m, 'bad card name ' + name);
  const rank = RANK_WORDS[m[1]] || Number(m[1]);
  return SUIT_LETTERS[m[2]] * 13 + rank - 1;
}

const rankOf = (c) => (c % 13) + 1;
const suitOf = (c) => Math.floor(c / 13);
const isRed = (c) => suitOf(c) % 2 === 1;
const move = (card, to) => ({ type: 'move', card: typeof card === 'string' ? C(card) : card, to });

/**
 * Builds a hand-made position.
 *   f:      { S: n, H: n, C: n, D: n }  cards already on each foundation (ace upwards)
 *   t:      up to 7 arrays of card names, bottom -> top; a leading '-' means face-down
 *   waste:  card names, bottom -> top
 *   stock:  card names, bottom -> top (the last one is drawn first)
 *   rest:   where the cards not mentioned go: 'stock' (default: underneath the listed stock cards)
 *           or 't0'..'t6' (face-down at the bottom of that column)
 * The result must be a state the engine itself accepts (checked through deserialize).
 */
function build(spec) {
  const piles = {};
  for (const id of PILE_IDS) piles[id] = [];
  const faceUp = new Array(52).fill(false);
  const used = new Set();
  const take = (id) => {
    assert.ok(!used.has(id), 'card used twice: ' + id);
    used.add(id);
    return id;
  };
  const f = spec.f || {};
  Object.keys(SUIT_LETTERS).forEach((letter, s) => {
    for (let i = 0; i < (f[letter] || 0); i++) {
      piles['f' + s].push(take(s * 13 + i));
      faceUp[s * 13 + i] = true;
    }
  });
  (spec.t || []).forEach((col, i) => {
    for (const name of col) {
      const down = name[0] === '-';
      const id = take(C(down ? name.slice(1) : name));
      piles['t' + i].push(id);
      faceUp[id] = !down;
    }
  });
  for (const name of spec.waste || []) {
    const id = take(C(name));
    piles.waste.push(id);
    faceUp[id] = true;
  }
  const stockTop = (spec.stock || []).map((name) => take(C(name)));
  const rest = [];
  for (let id = 0; id < 52; id++) if (!used.has(id)) rest.push(id);
  const where = spec.rest || 'stock';
  if (where === 'stock') {
    piles.stock = rest.concat(stockTop);
  } else {
    piles.stock = stockTop;
    piles[where] = rest.concat(piles[where]);
  }
  const state = {
    v: 1,
    id: 'test-game',
    seed: 0,
    drawCount: spec.drawCount === 3 ? 3 : 1,
    piles,
    faceUp,
    score: spec.score || 0,
    moves: 0,
    undos: 0,
    recycles: spec.recycles || 0,
    elapsedMs: 0,
    won: false,
    history: [],
  };
  const checked = Engine.deserialize(Engine.serialize(state));
  assert.ok(checked, 'test position is not a valid state');
  return checked;
}

const snap = (state) => JSON.parse(JSON.stringify(state));

/** A cheap copy for before/after comparisons (history records are shared, not copied). */
function lite(state) {
  const piles = {};
  for (const id of PILE_IDS) piles[id] = state.piles[id].slice();
  return {
    piles,
    faceUp: state.faceUp.slice(),
    score: state.score,
    moves: state.moves,
    undos: state.undos,
    recycles: state.recycles,
    won: state.won,
    history: state.history.slice(),
  };
}

/** Everything about a state in one string, without walking the history records. */
function fingerprint(state) {
  return JSON.stringify([state.piles, state.faceUp, state.score, state.moves, state.undos, state.recycles, state.won, state.history.length, state.drawCount, state.seed, state.id, state.elapsedMs]);
}

/**
 * Everything the engine promises about a state. `playedByTheRules: false` skips what only holds
 * for positions reached by legal play from a deal (proper runs, moves === history.length).
 */
function checkInvariants(state, label, playedByTheRules = true) {
  const seen = new Set();
  let total = 0;
  for (const id of PILE_IDS) {
    for (const c of state.piles[id]) {
      assert.ok(Number.isInteger(c) && c >= 0 && c < 52, label + ': bad card');
      assert.ok(!seen.has(c), label + ': duplicate card ' + c);
      seen.add(c);
      total++;
    }
  }
  assert.equal(total, 52, label + ': 52 cards');
  assert.equal(Object.keys(state.piles).length, 13, label + ': 13 piles');
  assert.equal(state.faceUp.length, 52);
  for (const c of state.piles.stock) assert.equal(state.faceUp[c], false, label + ': stock card face-up');
  for (const c of state.piles.waste) assert.equal(state.faceUp[c], true, label + ': waste card face-down');
  FOUNDATIONS.forEach((id, s) => {
    state.piles[id].forEach((c, i) => {
      assert.equal(c, s * 13 + i, label + ': foundation out of order');
      assert.equal(state.faceUp[c], true, label + ': foundation card face-down');
    });
  });
  for (const id of TABLEAU) {
    const p = state.piles[id];
    let up = false;
    for (const c of p) {
      if (state.faceUp[c]) up = true;
      else assert.ok(!up, label + ': face-down card above a face-up one in ' + id);
    }
    if (p.length) assert.ok(state.faceUp[p[p.length - 1]], label + ': top of ' + id + ' is face-down');
    // the face-up part of a column is always a proper run
    for (let j = 1; j < p.length && playedByTheRules; j++) {
      if (!state.faceUp[p[j - 1]]) continue;
      assert.equal(rankOf(p[j]), rankOf(p[j - 1]) - 1, label + ': run rank in ' + id);
      assert.notEqual(isRed(p[j]), isRed(p[j - 1]), label + ': run colour in ' + id);
    }
  }
  assert.ok(Number.isInteger(state.score) && state.score >= 0, label + ': score');
  if (playedByTheRules) assert.equal(state.moves, state.history.length, label + ': moves === history.length');
  assert.equal(state.won, Engine.isWon(state), label + ': won flag');
  assert.equal(state.won, FOUNDATIONS.every((id) => state.piles[id].length === 13));
}

// ---- an independent, deliberately naive statement of the rules, to cross-check the fast paths ----
function refLocate(state, card) {
  for (const id of PILE_IDS) {
    const index = state.piles[id].indexOf(card);
    if (index >= 0) return { pile: id, index };
  }
  return null;
}

function refRun(state, card) {
  if (!Number.isInteger(card) || card < 0 || card > 51 || state.won) return [];
  const loc = refLocate(state, card);
  const pile = state.piles[loc.pile];
  if (loc.pile === 'stock') return [];
  if (loc.pile === 'waste' || loc.pile[0] === 'f') return loc.index === pile.length - 1 ? [card] : [];
  return state.faceUp[card] ? pile.slice(loc.index) : [];
}

function refCanDrop(state, card, to) {
  const run = refRun(state, card);
  if (!run.length || !PILE_IDS.includes(to)) return false;
  if (refLocate(state, card).pile === to) return false;
  const dest = state.piles[to];
  const top = dest[dest.length - 1];
  if (to[0] === 'f') {
    if (run.length !== 1 || to !== 'f' + suitOf(card)) return false;
    return dest.length === 0 ? rankOf(card) === 1 : suitOf(top) === suitOf(card) && rankOf(top) === rankOf(card) - 1;
  }
  if (to[0] === 't') {
    if (dest.length === 0) return rankOf(card) === 13;
    return state.faceUp[top] && isRed(top) !== isRed(card) && rankOf(top) === rankOf(card) + 1;
  }
  return false;
}

/** Every legal action of a state (through the public API). */
function legalActions(state) {
  const out = [];
  if (Engine.canDraw(state)) out.push(DRAW);
  for (let c = 0; c < 52; c++) {
    for (const to of Engine.legalTargets(state, c)) out.push({ type: 'move', card: c, to });
  }
  return out;
}

const hiddenCount = (state) => TABLEAU.reduce((n, id) => n + state.piles[id].filter((c) => !state.faceUp[c]).length, 0);
const looseCount = (state) => state.piles.stock.length + state.piles.waste.length;

/**
 * Checks a draw / recycle / move record against the state before and after it:
 * replaying the transfers on the old piles must give the new piles, the flips must be exactly
 * the face changes, and the counters must match.
 */
function checkRecord(before, after, record, label) {
  assert.ok(['draw', 'recycle', 'move'].includes(record.type), label + ': type');
  const piles = {};
  for (const id of PILE_IDS) piles[id] = before.piles[id].slice();
  assert.ok(record.transfers.length > 0, label + ': transfers');
  if (record.type === 'move') {
    const { from, to } = record.transfers[0];
    const n = record.transfers.length;
    const run = piles[from].splice(piles[from].length - n, n);
    assert.deepEqual(run, record.transfers.map((t) => t.card), label + ': run order bottom -> top');
    for (const t of record.transfers) assert.deepEqual([t.from, t.to], [from, to]);
    piles[to].push(...run);
  } else {
    for (const t of record.transfers) {
      assert.equal(piles[t.from].pop(), t.card, label + ': cards move one at a time from the top');
      piles[t.to].push(t.card);
    }
  }
  assert.deepEqual(piles, after.piles, label + ': transfers explain the new piles');

  const changed = [];
  for (let c = 0; c < 52; c++) if (before.faceUp[c] !== after.faceUp[c]) changed.push(c);
  assert.deepEqual(record.flips.map((f) => f.card).sort((a, b) => a - b), changed, label + ': flips list every face change');
  for (const f of record.flips) {
    assert.equal(f.faceUp, after.faceUp[f.card], label + ': flip direction');
    const isReveal = record.type === 'move' && f.faceUp === true;
    assert.equal(f.reveal === true, isReveal, label + ': reveal flag');
    if (!isReveal) assert.ok(!('reveal' in f));
  }

  assert.equal(record.scoreBefore, before.score);
  assert.equal(record.scoreAfter, after.score);
  assert.equal(record.movesBefore, before.moves);
  assert.equal(record.movesAfter, after.moves);
  assert.equal(record.movesAfter, record.movesBefore + 1);
  assert.equal(record.recyclesBefore, before.recycles);
  assert.equal(record.recyclesAfter, after.recycles);
  assert.equal(record.recyclesAfter, record.recyclesBefore + (record.type === 'recycle' ? 1 : 0));
  assert.equal(record.won, after.won);
  assert.equal(after.history[after.history.length - 1], record, label + ': record is on the history');
  assert.equal(after.undos, before.undos);
}

/** A random playout step: mostly random legal actions, sometimes a hint, sometimes an undo. */
function randomStep(state, rng) {
  const roll = rng.next();
  if (roll < 0.08 && Engine.canUndo(state)) return UNDO;
  if (roll < 0.45) {
    const h = Engine.hints(state);
    if (h.length) return h[0].action;
  }
  const actions = legalActions(state);
  if (!actions.length) return Engine.canUndo(state) ? UNDO : null;
  return actions[rng.int(actions.length)];
}

// ------------------------------------------------------------------------------------- RNG
describe('RNG', () => {
  test('create is deterministic, in range, and matches mulberry32', () => {
    const a = RNG.create(12345);
    const b = RNG.create(12345);
    assert.equal(a.seed, 12345);
    // reference implementation
    let s = 12345;
    const ref = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = 0; i < 2000; i++) {
      const v = a.next();
      assert.equal(v, b.next());
      assert.equal(v, ref());
      assert.ok(v >= 0 && v < 1);
    }
    assert.notEqual(RNG.create(1).next(), RNG.create(2).next());
  });

  test('int(n) stays in [0, n) and covers the range', () => {
    const r = RNG.create(7);
    const seen = new Set();
    for (let i = 0; i < 5000; i++) {
      const v = r.int(10);
      assert.ok(Number.isInteger(v) && v >= 0 && v < 10);
      seen.add(v);
    }
    assert.equal(seen.size, 10);
    assert.equal(r.int(1), 0);
    assert.equal(r.int(0), 0);
  });

  test('seeds are normalised to uint32', () => {
    assert.equal(RNG.create(-1).seed, 4294967295);
    assert.equal(RNG.create(4294967296 + 5).seed, 5);
    assert.equal(RNG.create(3.9).seed, 3);
    assert.equal(RNG.create(-1).next(), RNG.create(4294967295).next());
  });

  test('shuffle permutes in place, deterministically', () => {
    const base = Array.from({ length: 52 }, (_, i) => i);
    const a = base.slice();
    const out = RNG.shuffle(a, RNG.create(99));
    assert.equal(out, a);
    assert.deepEqual(a.slice().sort((x, y) => x - y), base);
    assert.notDeepEqual(a, base);
    assert.deepEqual(RNG.shuffle(base.slice(), RNG.create(99)), a);
    assert.notDeepEqual(RNG.shuffle(base.slice(), RNG.create(100)), a);
    assert.deepEqual(RNG.shuffle([], RNG.create(1)), []);
    assert.deepEqual(RNG.shuffle([5], RNG.create(1)), [5]);
  });

  test('shuffle is unbiased enough (every position sees every value)', () => {
    const counts = Array.from({ length: 5 }, () => new Array(5).fill(0));
    const rng = RNG.create(2024);
    for (let i = 0; i < 20000; i++) {
      RNG.shuffle([0, 1, 2, 3, 4], rng).forEach((v, pos) => counts[pos][v]++);
    }
    for (const row of counts) for (const n of row) assert.ok(n > 3600 && n < 4400, 'count ' + n);
  });

  test('randomSeed returns uint32 values', () => {
    const seen = new Set();
    for (let i = 0; i < 50; i++) {
      const s = RNG.randomSeed();
      assert.ok(Number.isInteger(s) && s >= 0 && s <= 0xffffffff);
      seen.add(s);
    }
    assert.ok(seen.size > 40);
  });
});

// ------------------------------------------------------------------------------------- constants
describe('constants and card helpers', () => {
  test('constants', () => {
    assert.deepEqual([...Engine.SUITS], ['spades', 'hearts', 'clubs', 'diamonds']);
    assert.deepEqual([...Engine.SUIT_SYMBOLS], ['♠', '♥', '♣', '♦']);
    assert.deepEqual([...Engine.RANK_LABELS], ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']);
    assert.deepEqual([...FOUNDATIONS], ['f0', 'f1', 'f2', 'f3']);
    assert.deepEqual([...TABLEAU], ['t0', 't1', 't2', 't3', 't4', 't5', 't6']);
    assert.deepEqual([...PILE_IDS], ['stock', 'waste', 'f0', 'f1', 'f2', 'f3', 't0', 't1', 't2', 't3', 't4', 't5', 't6']);
    assert.equal(Engine.SCORE.wasteToTableau, 5);
    assert.equal(Engine.SCORE.wasteToFoundation, 10);
    assert.equal(Engine.SCORE.tableauToFoundation, 10);
    assert.equal(Engine.SCORE.reveal, 5);
    assert.equal(Engine.SCORE.foundationToTableau, -15);
    assert.equal(Engine.SCORE.recycleDraw1, -100);
    assert.equal(Engine.SCORE.recycleDraw3, -20);
    assert.equal(Engine.SCORE.tableauToTableau, 0);
  });

  test('suitOf / rankOf / isRed / cardInfo / foundationFor / pileKind', () => {
    for (let id = 0; id < 52; id++) {
      assert.equal(Engine.suitOf(id), Math.floor(id / 13));
      assert.equal(Engine.rankOf(id), (id % 13) + 1);
      assert.equal(Engine.isRed(id), Math.floor(id / 13) % 2 === 1);
      assert.equal(Engine.foundationFor(id), 'f' + Math.floor(id / 13));
      const info = Engine.cardInfo(id);
      assert.equal(info.id, id);
      assert.equal(info.suit, Engine.suitOf(id));
      assert.equal(info.rank, Engine.rankOf(id));
      assert.equal(info.suitName, Engine.SUITS[info.suit]);
      assert.equal(info.symbol, Engine.SUIT_SYMBOLS[info.suit]);
      assert.equal(info.label, Engine.RANK_LABELS[info.rank - 1]);
      assert.equal(info.color, Engine.isRed(id) ? 'red' : 'black');
    }
    assert.deepEqual(Engine.cardInfo(0), { id: 0, suit: 0, rank: 1, suitName: 'spades', symbol: '♠', label: 'A', color: 'black', name: 'Ace of Spades' });
    assert.equal(Engine.cardInfo(C('QH')).name, 'Queen of Hearts');
    assert.equal(Engine.cardInfo(C('10C')).name, '10 of Clubs');
    assert.equal(Engine.cardInfo(C('JD')).name, 'Jack of Diamonds');
    assert.equal(Engine.cardInfo(C('KS')).name, 'King of Spades');
    assert.equal(Engine.cardInfo(C('7D')).color, 'red');
    // a fresh object every time: callers may decorate it
    Engine.cardInfo(3).extra = 1;
    assert.equal(Engine.cardInfo(3).extra, undefined);
    assert.equal(Engine.cardInfo(52), null);
    assert.equal(Engine.cardInfo(-1), null);

    assert.equal(Engine.pileKind('stock'), 'stock');
    assert.equal(Engine.pileKind('waste'), 'waste');
    assert.equal(Engine.pileKind('f3'), 'foundation');
    assert.equal(Engine.pileKind('t6'), 'tableau');
    assert.equal(Engine.pileKind('t7'), null);
    assert.equal(Engine.pileKind('toString'), null);
  });

  test('timeBonus', () => {
    assert.equal(Engine.timeBonus(0), 0);
    assert.equal(Engine.timeBonus(29999), 0);
    assert.equal(Engine.timeBonus(30000), Math.round(700000 / 30));
    assert.equal(Engine.timeBonus(120000), Math.round(700000 / 120));
    assert.equal(Engine.timeBonus(120999), Math.round(700000 / 120));
    assert.equal(Engine.timeBonus(3600000), 194);
    assert.equal(Engine.timeBonus(NaN), 0);
    assert.equal(Engine.timeBonus(-5), 0);
    assert.equal(Engine.timeBonus(Infinity), 0);
    assert.equal(Engine.timeBonus(undefined), 0);
  });
});

// ------------------------------------------------------------------------------------- deal
describe('newGame', () => {
  test('deal shape', () => {
    for (const seed of [0, 1, 2, 77, 4294967295]) {
      const s = Engine.newGame({ seed });
      assert.equal(s.v, 1);
      assert.equal(s.seed, seed);
      assert.equal(s.drawCount, 1);
      assert.deepEqual(Object.keys(s.piles), [...PILE_IDS]);
      TABLEAU.forEach((id, c) => {
        const p = s.piles[id];
        assert.equal(p.length, c + 1);
        p.forEach((card, j) => assert.equal(s.faceUp[card], j === c, 'only the top card is face-up'));
      });
      assert.equal(s.piles.stock.length, 24);
      assert.equal(s.piles.waste.length, 0);
      for (const id of FOUNDATIONS) assert.equal(s.piles[id].length, 0);
      assert.equal(s.faceUp.length, 52);
      assert.equal(s.faceUp.filter(Boolean).length, 7);
      assert.deepEqual([s.score, s.moves, s.undos, s.recycles, s.elapsedMs], [0, 0, 0, 0, 0]);
      assert.equal(s.won, false);
      assert.deepEqual(s.history, []);
      checkInvariants(s, 'deal ' + seed);
    }
  });

  test('deal follows the contract: shuffle 0..51 with the seed, deal row by row', () => {
    for (const seed of [1, 5, 123456789]) {
      const deck = RNG.shuffle(Array.from({ length: 52 }, (_, i) => i), RNG.create(seed));
      const expected = { stock: [], t: [[], [], [], [], [], [], []] };
      let top = 51; // cards leave the deck from its top (the end of the array)
      for (let r = 0; r < 7; r++) for (let c = r; c < 7; c++) expected.t[c].push(deck[top--]);
      expected.stock = deck.slice(0, 24);
      const s = Engine.newGame({ seed });
      TABLEAU.forEach((id, c) => assert.deepEqual(s.piles[id], expected.t[c]));
      assert.deepEqual(s.piles.stock, expected.stock);
    }
  });

  test('a pinned deal never changes (saved games and shared seeds depend on it)', () => {
    const s = Engine.newGame({ seed: 1 });
    assert.deepEqual(s.piles.t0, [32]);
    assert.deepEqual(s.piles.t1, [0, 51]);
    assert.deepEqual(s.piles.t2, [26, 18, 15]);
    assert.deepEqual(s.piles.t3, [48, 42, 9, 47]);
    assert.deepEqual(s.piles.t4, [46, 19, 39, 25, 1]);
    assert.deepEqual(s.piles.t5, [13, 20, 17, 37, 12, 21]);
    assert.deepEqual(s.piles.t6, [28, 5, 2, 36, 16, 7, 30]);
    assert.deepEqual(s.piles.stock, [24, 44, 23, 10, 43, 31, 50, 41, 6, 29, 35, 22, 40, 34, 11, 3, 49, 33, 8, 14, 4, 27, 45, 38]);
  });

  test('same seed => same deal, whatever the draw mode; different seeds differ', () => {
    const a = Engine.newGame({ seed: 4242, drawCount: 1 });
    const b = Engine.newGame({ seed: 4242, drawCount: 3 });
    assert.deepEqual(a.piles, b.piles);
    assert.deepEqual(a.faceUp, b.faceUp);
    assert.equal(b.drawCount, 3);
    assert.notDeepEqual(Engine.newGame({ seed: 4243 }).piles, a.piles);
  });

  test('options: drawCount, id, seed defaults', () => {
    assert.equal(Engine.newGame({ seed: 1, drawCount: 3 }).drawCount, 3);
    assert.equal(Engine.newGame({ seed: 1, drawCount: 2 }).drawCount, 1);
    assert.equal(Engine.newGame({ seed: 1, drawCount: '3' }).drawCount, 1);
    assert.equal(Engine.newGame({ seed: 1, id: 'abc' }).id, 'abc');
    const ids = new Set();
    for (let i = 0; i < 200; i++) {
      const s = Engine.newGame({ seed: 1 });
      assert.ok(typeof s.id === 'string' && s.id.length > 0);
      ids.add(s.id);
    }
    assert.equal(ids.size, 200, 'generated ids are unique');
    const r1 = Engine.newGame();
    const r2 = Engine.newGame({});
    assert.ok(Number.isInteger(r1.seed) && r1.seed >= 0 && r1.seed <= 0xffffffff);
    assert.notEqual(r1.seed, r2.seed);
    assert.equal(Engine.newGame({ seed: -1 }).seed, 4294967295);
    // replaying the reported seed reproduces the deal
    assert.deepEqual(Engine.newGame({ seed: r1.seed }).piles, r1.piles);
  });
});

// ------------------------------------------------------------------------------------- draw
describe('draw and recycle', () => {
  test('draw 1 moves the stock top to the waste, face-up', () => {
    const s = Engine.newGame({ seed: 3 });
    const before = snap(s);
    const top = s.piles.stock[23];
    const r = Engine.apply(s, DRAW);
    assert.equal(r.type, 'draw');
    assert.deepEqual(r.transfers, [{ card: top, from: 'stock', to: 'waste' }]);
    assert.deepEqual(r.flips, [{ card: top, faceUp: true }]);
    assert.deepEqual(s.piles.waste, [top]);
    assert.equal(s.piles.stock.length, 23);
    assert.equal(s.faceUp[top], true);
    assert.equal(s.score, 0);
    assert.equal(s.moves, 1);
    assert.equal(r.won, false);
    assert.ok(!('auto' in r));
    checkRecord(before, s, r, 'draw 1');
  });

  test('draw 3 moves three cards one at a time; the last drawn ends on top', () => {
    const s = Engine.newGame({ seed: 3, drawCount: 3 });
    const before = snap(s);
    const [c3, c2, c1] = s.piles.stock.slice(21); // c1 is the stock top
    const r = Engine.apply(s, DRAW);
    assert.deepEqual(r.transfers.map((t) => t.card), [c1, c2, c3]);
    assert.deepEqual(r.flips, [c1, c2, c3].map((card) => ({ card, faceUp: true })));
    assert.deepEqual(s.piles.waste, [c1, c2, c3]);
    assert.equal(Engine.topCard(s, 'waste'), c3);
    assert.equal(s.moves, 1);
    checkRecord(before, s, r, 'draw 3');
  });

  test('draw 3 with two cards, then one card, left in the stock', () => {
    for (const left of [2, 1]) {
      const s = Engine.newGame({ seed: 8, drawCount: 3 });
      // 24 cards: 7 full draws leave 3; shorten the stock by hand to leave `left`
      const removed = s.piles.stock.splice(0, 24 - left);
      s.piles.waste.push(...removed);
      for (const c of removed) s.faceUp[c] = true;
      const stock = s.piles.stock.slice();
      const before = snap(s);
      const r = Engine.apply(s, DRAW);
      assert.equal(r.type, 'draw');
      assert.equal(r.transfers.length, left);
      assert.deepEqual(r.transfers.map((t) => t.card), stock.slice().reverse());
      assert.equal(s.piles.stock.length, 0);
      assert.equal(Engine.topCard(s, 'waste'), stock[0]);
      checkRecord(before, s, r, 'short draw ' + left);
      // and it undoes exactly
      Engine.apply(s, UNDO);
      assert.deepEqual(s.piles, before.piles);
      assert.deepEqual(s.faceUp, before.faceUp);
    }
  });

  for (const drawCount of [1, 3]) {
    test('recycle turns the waste over: the cards come out again in the same order (draw ' + drawCount + ')', () => {
      const s = Engine.newGame({ seed: 11, drawCount });
      const firstPass = [];
      const firstTops = [];
      while (s.piles.stock.length) {
        const r = Engine.apply(s, DRAW);
        assert.equal(r.type, 'draw');
        firstPass.push(...r.transfers.map((t) => t.card));
        firstTops.push(Engine.topCard(s, 'waste'));
      }
      assert.equal(firstPass.length, 24);
      const wasteBefore = s.piles.waste.slice();
      const before = snap(s);
      const r = Engine.apply(s, DRAW);
      assert.equal(r.type, 'recycle');
      assert.equal(r.transfers.length, 24);
      assert.deepEqual(r.transfers.map((t) => t.card), wasteBefore.slice().reverse(), 'the waste top moves first');
      for (const t of r.transfers) assert.deepEqual([t.from, t.to], ['waste', 'stock']);
      assert.deepEqual(r.flips, r.transfers.map((t) => ({ card: t.card, faceUp: false })));
      assert.equal(s.piles.waste.length, 0);
      assert.deepEqual(s.piles.stock, wasteBefore.slice().reverse());
      assert.equal(s.recycles, 1);
      assert.equal(r.recyclesBefore, 0);
      assert.equal(r.recyclesAfter, 1);
      checkRecord(before, s, r, 'recycle');
      checkInvariants(s, 'after recycle');

      const secondPass = [];
      const secondTops = [];
      while (s.piles.stock.length) {
        secondPass.push(...Engine.apply(s, DRAW).transfers.map((t) => t.card));
        secondTops.push(Engine.topCard(s, 'waste'));
      }
      assert.deepEqual(secondPass, firstPass);
      assert.deepEqual(secondTops, firstTops);
    });
  }

  test('draw is illegal when stock and waste are both empty', () => {
    const s = build({ t: [[], ['AS']], rest: 't1' });
    assert.equal(looseCount(s), 0);
    assert.equal(Engine.canDraw(s), false);
    const before = snap(s);
    assert.equal(Engine.apply(s, DRAW), null);
    assert.equal(Engine.apply(s, DRAW, { auto: true }), null);
    assert.deepEqual(snap(s), before);
    // one card in the waste and none in the stock: drawing recycles it
    const one = build({ t: [[], ['AS']], waste: ['9D'], rest: 't1' });
    assert.equal(Engine.canDraw(one), true);
    assert.equal(Engine.apply(one, DRAW).type, 'recycle');
    assert.deepEqual(one.piles.stock, [C('9D')]);
    assert.equal(Engine.apply(one, DRAW).type, 'draw');
    assert.equal(Engine.topCard(one, 'waste'), C('9D'));
  });

  test('recycle scoring, draw 1: -100 each time, never below zero', () => {
    const s = build({ stock: ['2C'], rest: 't0', t: [['KS']], score: 250 });
    assert.equal(Engine.apply(s, DRAW).type, 'draw');
    let r = Engine.apply(s, DRAW);
    assert.equal(r.type, 'recycle');
    assert.deepEqual([r.scoreBefore, r.scoreAfter], [250, 150]);
    Engine.apply(s, DRAW);
    r = Engine.apply(s, DRAW);
    assert.deepEqual([r.scoreBefore, r.scoreAfter], [150, 50]);
    Engine.apply(s, DRAW);
    r = Engine.apply(s, DRAW);
    assert.deepEqual([r.scoreBefore, r.scoreAfter], [50, 0]);
    assert.equal(s.score, 0);
    assert.equal(s.recycles, 3);
    assert.equal(s.moves, 6);
  });

  test('recycle scoring, draw 3: free until the 4th pass, then -20', () => {
    const s = build({ drawCount: 3, stock: ['2C', '3C', '4C'], rest: 't0', t: [['KS']], score: 50 });
    const deltas = [];
    for (let pass = 0; pass < 5; pass++) {
      assert.equal(Engine.apply(s, DRAW).type, 'draw');
      const r = Engine.apply(s, DRAW);
      assert.equal(r.type, 'recycle');
      deltas.push(r.scoreAfter - r.scoreBefore);
    }
    // recycle n starts pass n + 1: passes 2 and 3 are free, passes 4, 5 and 6 cost 20 each
    assert.deepEqual(deltas, [0, 0, -20, -20, -10]);
    assert.equal(s.score, 0);
    assert.equal(s.recycles, 5);
  });

  test('opts.auto: a recycle costs nothing and records carry auto: true', () => {
    for (const drawCount of [1, 3]) {
      const s = build({ drawCount, stock: ['2C'], rest: 't0', t: [['KS']], score: 300, recycles: 7 });
      const d = Engine.apply(s, DRAW, { auto: true });
      assert.equal(d.auto, true);
      const r = Engine.apply(s, DRAW, { auto: true });
      assert.equal(r.type, 'recycle');
      assert.equal(r.auto, true);
      assert.deepEqual([r.scoreBefore, r.scoreAfter], [300, 300]);
      assert.equal(s.recycles, 8, 'the recycle is still counted');
      // without the flag it costs
      Engine.apply(s, DRAW);
      const paid = Engine.apply(s, DRAW);
      assert.ok(!('auto' in paid));
      assert.equal(paid.scoreAfter, drawCount === 1 ? 200 : 280);
      // auto must be exactly true
      Engine.apply(s, DRAW);
      assert.ok(!('auto' in Engine.apply(s, DRAW, { auto: 1 })));
    }
  });
});

// ------------------------------------------------------------------------------------- moves
describe('move rules', () => {
  test('tableau: opposite colour, exactly one rank higher', () => {
    const s = build({ t: [['8C'], ['7H'], ['7S'], ['6H'], ['9D'], ['8D']], rest: 'stock' });
    assert.equal(Engine.canDrop(s, C('7H'), 't0'), true); // red 7 on black 8
    assert.equal(Engine.canDrop(s, C('7S'), 't0'), false); // same colour
    assert.equal(Engine.canDrop(s, C('6H'), 't0'), false); // two ranks apart
    assert.equal(Engine.canDrop(s, C('8C'), 't1'), false); // higher on lower
    assert.equal(Engine.canDrop(s, C('8C'), 't4'), true); // black 8 on red 9
    assert.equal(Engine.canDrop(s, C('8D'), 't4'), false); // red on red
    assert.equal(Engine.canDrop(s, C('7S'), 't5'), true); // black 7 on red 8
    assert.deepEqual(Engine.legalTargets(s, C('7H')), ['t0']);
    assert.deepEqual(Engine.legalTargets(s, C('7S')), ['t5']);

    const before = snap(s);
    const r = Engine.apply(s, move('7H', 't0'));
    assert.deepEqual(r.transfers, [{ card: C('7H'), from: 't1', to: 't0' }]);
    assert.deepEqual(r.flips, []);
    assert.equal(r.scoreAfter - r.scoreBefore, 0);
    assert.deepEqual(s.piles.t0, [C('8C'), C('7H')]);
    assert.deepEqual(s.piles.t1, []);
    checkRecord(before, s, r, 'tableau move');
    for (const bad of [move('7S', 't0'), move('6H', 't0'), move('8C', 't1')]) {
      const b = snap(s);
      assert.equal(Engine.apply(s, bad), null);
      assert.deepEqual(snap(s), b);
    }
  });

  test('only a King (run) may go to an empty column', () => {
    const s = build({ t: [['-2D', 'KD', 'QS'], [], ['QH'], ['-3D', 'JH']], rest: 'stock' });
    assert.equal(Engine.canDrop(s, C('QH'), 't1'), false);
    assert.equal(Engine.canDrop(s, C('JH'), 't1'), false);
    assert.equal(Engine.canDrop(s, C('QS'), 't1'), false);
    assert.equal(Engine.canDrop(s, C('KD'), 't1'), true);
    const before = snap(s);
    const r = Engine.apply(s, move('KD', 't1'));
    assert.deepEqual(r.transfers, [
      { card: C('KD'), from: 't0', to: 't1' },
      { card: C('QS'), from: 't0', to: 't1' },
    ]);
    assert.deepEqual(r.flips, [{ card: C('2D'), faceUp: true, reveal: true }]);
    assert.equal(r.scoreAfter, 5);
    assert.deepEqual(s.piles.t1, [C('KD'), C('QS')]);
    assert.deepEqual(s.piles.t0, [C('2D')]);
    checkRecord(before, s, r, 'king run');
  });

  test('a run moves as a block, bottom card first in the record', () => {
    const s = build({ t: [['-AC', '9H', '8S', '7D', '6C'], ['10S'], ['8C']], rest: 'stock' });
    assert.deepEqual(Engine.getRun(s, C('9H')), [C('9H'), C('8S'), C('7D'), C('6C')]);
    assert.deepEqual(Engine.getRun(s, C('7D')), [C('7D'), C('6C')]);
    assert.deepEqual(Engine.getRun(s, C('6C')), [C('6C')]);
    assert.deepEqual(Engine.getRun(s, C('AC')), [], 'face-down cards cannot be picked up');
    assert.equal(Engine.canPickup(s, C('AC')), false);
    // part of the run onto the other black 8
    const mid = Engine.clone(s);
    const r1 = Engine.apply(mid, move('7D', 't2'));
    assert.deepEqual(r1.transfers.map((t) => t.card), [C('7D'), C('6C')]);
    assert.deepEqual(r1.flips, []);
    assert.deepEqual(mid.piles.t2, [C('8C'), C('7D'), C('6C')]);
    assert.deepEqual(mid.piles.t0, [C('AC'), C('9H'), C('8S')]);
    // the whole run, uncovering the ace
    const before = snap(s);
    const r2 = Engine.apply(s, move('9H', 't1'));
    assert.deepEqual(r2.transfers.map((t) => t.card), [C('9H'), C('8S'), C('7D'), C('6C')]);
    assert.deepEqual(r2.flips, [{ card: C('AC'), faceUp: true, reveal: true }]);
    assert.deepEqual(s.piles.t1, [C('10S'), C('9H'), C('8S'), C('7D'), C('6C')]);
    assert.equal(s.score, 5);
    checkRecord(before, s, r2, 'run');
  });

  test('foundations: ace on empty, then the same suit ascending, single cards only, own pile only', () => {
    const s = build({ f: { H: 1 }, t: [['AS'], ['2H'], ['2S'], ['3H'], ['4C', '3D']], waste: ['AC'], rest: 'stock' });
    assert.equal(Engine.canDrop(s, C('AS'), 'f0'), true);
    for (const wrong of ['f1', 'f2', 'f3']) assert.equal(Engine.canDrop(s, C('AS'), wrong), false, 'only its own foundation');
    assert.equal(Engine.canDrop(s, C('2S'), 'f0'), false, 'needs the ace first');
    assert.equal(Engine.canDrop(s, C('2H'), 'f1'), true);
    assert.equal(Engine.canDrop(s, C('3H'), 'f1'), false, 'no skipping');
    assert.equal(Engine.canDrop(s, C('AC'), 'f2'), true, 'from the waste');
    assert.deepEqual(Engine.legalTargets(s, C('AS')), ['f0', 't1'], 'its foundation first, then the red 2');
    assert.deepEqual(Engine.legalTargets(s, C('2H')), ['f1']);
    assert.deepEqual(Engine.legalTargets(s, C('2S')), ['t3', 't4'], 'not its foundation yet, but both red 3s');

    let before = snap(s);
    let r = Engine.apply(s, move('AS', 'f0'));
    assert.deepEqual(r.transfers, [{ card: C('AS'), from: 't0', to: 'f0' }]);
    assert.equal(r.scoreAfter, 10);
    checkRecord(before, s, r, 'ace');
    r = Engine.apply(s, move('2S', 'f0'));
    assert.equal(r.scoreAfter, 20);
    r = Engine.apply(s, move('2H', 'f1'));
    r = Engine.apply(s, move('3H', 'f1'));
    assert.equal(s.score, 40);
    before = snap(s);
    r = Engine.apply(s, move('AC', 'f2'));
    assert.equal(r.scoreAfter - r.scoreBefore, 10);
    checkRecord(before, s, r, 'waste to foundation');
    assert.deepEqual(s.piles.f0, [C('AS'), C('2S')]);
    assert.deepEqual(s.piles.f1, [C('AH'), C('2H'), C('3H')]);

    // a run of two can never go to a foundation, even when its first card fits
    const two = build({ f: { C: 3 }, t: [['4C', '3D']], rest: 'stock' });
    assert.equal(Engine.canDrop(two, C('4C'), 'f2'), false);
    assert.equal(Engine.apply(two, move('4C', 'f2')), null);
    assert.equal(Engine.canDrop(two, C('3D'), 'f3'), false);
  });

  test('what cannot be picked up or dropped', () => {
    const s = build({ f: { S: 3 }, t: [['-9C', '5H'], ['6S'], []], waste: ['7D', '8D'], rest: 'stock' });
    // buried waste / foundation cards, face-down cards, stock cards
    assert.equal(Engine.canPickup(s, C('7D')), false);
    assert.equal(Engine.canPickup(s, C('8D')), true);
    assert.equal(Engine.canPickup(s, C('2S')), false);
    assert.equal(Engine.canPickup(s, C('3S')), true);
    assert.equal(Engine.canPickup(s, C('9C')), false);
    assert.equal(Engine.canPickup(s, s.piles.stock[s.piles.stock.length - 1]), false);
    assert.deepEqual(Engine.getRun(s, C('7D')), []);
    assert.deepEqual(Engine.getRun(s, C('8D')), [C('8D')]);
    assert.deepEqual(Engine.getRun(s, C('3S')), [C('3S')]);
    assert.deepEqual(Engine.legalTargets(s, C('7D')), []);
    // same pile, stock, waste, unknown piles
    assert.equal(Engine.canDrop(s, C('5H'), 't0'), false);
    assert.equal(Engine.canDrop(s, C('5H'), 'stock'), false);
    assert.equal(Engine.canDrop(s, C('5H'), 'waste'), false);
    assert.equal(Engine.canDrop(s, C('5H'), 't7'), false);
    assert.equal(Engine.canDrop(s, C('5H'), 'constructor'), false);
    assert.equal(Engine.canDrop(s, C('5H'), undefined), false);
    assert.equal(Engine.canDrop(s, C('3S'), 'f0'), false, 'already on that foundation');
    assert.equal(Engine.canDrop(s, C('5H'), 't1'), true);

    const before = snap(s);
    const illegal = [
      move('7D', 't1'),
      move('9C', 't2'),
      move('2S', 't2'),
      move('5H', 't0'),
      move('5H', 'stock'),
      move('5H', 'waste'),
      move('5H', 't7'),
      move('5H', '__proto__'),
      { type: 'move', card: -1, to: 't1' },
      { type: 'move', card: 52, to: 't1' },
      { type: 'move', card: 1.5, to: 't1' },
      { type: 'move', card: String(C('5H')), to: 't1' },
      { type: 'move', card: null, to: 't1' },
      { type: 'move', card: NaN, to: 't1' },
      { type: 'move', to: 't1' },
      { type: 'move', card: C('5H') },
      { type: 'jump' },
      { type: 'undo' }, // nothing to undo yet
      {},
      null,
      undefined,
      'draw',
    ];
    for (const action of illegal) {
      assert.equal(Engine.apply(s, action), null, JSON.stringify(action));
      assert.deepEqual(snap(s), before, 'state untouched after ' + JSON.stringify(action));
    }
  });

  test('a foundation top card may come back to the tableau (-15, never below zero)', () => {
    const s = build({ f: { S: 2 }, t: [['3H'], ['3D']], rest: 'stock', score: 20 });
    assert.equal(Engine.canPickup(s, C('2S')), true);
    assert.equal(Engine.canPickup(s, C('AS')), false);
    assert.deepEqual(Engine.legalTargets(s, C('2S')), ['t0', 't1']);
    const before = snap(s);
    const r = Engine.apply(s, move('2S', 't1'));
    assert.deepEqual(r.transfers, [{ card: C('2S'), from: 'f0', to: 't1' }]);
    assert.deepEqual([r.scoreBefore, r.scoreAfter], [20, 5]);
    assert.deepEqual(s.piles.f0, [C('AS')]);
    assert.deepEqual(s.piles.t1, [C('3D'), C('2S')]);
    checkRecord(before, s, r, 'foundation to tableau');
    // back up (+10), down again: the floor is zero
    assert.equal(Engine.apply(s, move('2S', 'f0')).scoreAfter, 15);
    assert.equal(Engine.apply(s, move('2S', 't0')).scoreAfter, 0);
    assert.equal(Engine.apply(s, move('2S', 'f0')).scoreAfter, 10);
    assert.equal(Engine.apply(s, move('2S', 't0')).scoreAfter, 0);
    // undo restores the exact earlier score, not score + 15
    assert.equal(Engine.apply(s, UNDO).scoreAfter, 10);
  });

  test('scoring table', () => {
    const delta = (spec, action) => {
      const s = build(Object.assign({ score: 100, rest: 'stock' }, spec));
      const r = Engine.apply(s, action);
      assert.ok(r, 'legal');
      return r.scoreAfter - r.scoreBefore;
    };
    assert.equal(delta({ waste: ['9H'], t: [['10S']] }, move('9H', 't0')), 5, 'waste -> tableau');
    assert.equal(delta({ waste: ['KH'], t: [[]] }, move('KH', 't0')), 5, 'waste king -> empty column');
    assert.equal(delta({ waste: ['AS'] }, move('AS', 'f0')), 10, 'waste -> foundation');
    assert.equal(delta({ t: [['AS']] }, move('AS', 'f0')), 10, 'tableau -> foundation');
    assert.equal(delta({ t: [['-7C', 'AS']] }, move('AS', 'f0')), 15, 'tableau -> foundation + reveal');
    assert.equal(delta({ t: [['9H'], ['10S']] }, move('9H', 't1')), 0, 'tableau -> tableau');
    assert.equal(delta({ t: [['-7C', '9H'], ['10S']] }, move('9H', 't1')), 5, 'tableau -> tableau + reveal');
    assert.equal(delta({ f: { S: 2 }, t: [['3H']] }, move('2S', 't0')), -15, 'foundation -> tableau');
    assert.equal(delta({ stock: ['2C'] }, DRAW), 0, 'draw');
  });

  test('the reveal flip belongs to the move record and to its undo', () => {
    const s = build({ t: [['-5C', '9H'], ['10S']], rest: 'stock' });
    const start = snap(s);
    const r = Engine.apply(s, move('9H', 't1'));
    assert.deepEqual(r.flips, [{ card: C('5C'), faceUp: true, reveal: true }]);
    assert.equal(Engine.isFaceUp(s, C('5C')), true);
    assert.equal(s.score, 5);
    const u = Engine.apply(s, UNDO);
    assert.equal(u.type, 'undo');
    assert.equal(u.undone, r);
    assert.deepEqual(u.transfers, [{ card: C('9H'), from: 't1', to: 't0' }]);
    assert.deepEqual(u.flips, [{ card: C('5C'), faceUp: false, reveal: true }]);
    assert.deepEqual([u.scoreBefore, u.scoreAfter, u.movesBefore, u.movesAfter], [5, 0, 1, 0]);
    assert.equal(u.won, false);
    assert.equal(Engine.isFaceUp(s, C('5C')), false);
    assert.equal(s.undos, 1);
    assert.deepEqual(Object.assign(snap(s), { undos: 0 }), start);
  });

  test('a King run already at the bottom of a column: legal to move, never suggested', () => {
    const s = build({ t: [['KH', 'QS'], [], ['-2C', 'JD']], rest: 't2' });
    assert.equal(Engine.canDrop(s, C('KH'), 't1'), true, 'the rules allow it');
    assert.equal(Engine.bestTarget(s, C('KH')), null, 'a tap does not do it');
    for (const h of Engine.hints(s)) {
      assert.ok(!(h.action.type === 'move' && h.action.card === C('KH')), 'no hint hops the king');
    }
    // the same King lying on a hidden card is worth moving
    const s2 = build({ t: [['-2C', 'KH', 'QS'], []], rest: 't0' });
    assert.equal(Engine.bestTarget(s2, C('KH')), 't1');
    const h = Engine.hints(s2)[0];
    assert.deepEqual(h.action, move('KH', 't1'));
    assert.equal(h.priority, 3);
  });
});

// ------------------------------------------------------------------------------------- win
describe('winning', () => {
  function almostWon() {
    return build({ f: { S: 13, H: 13, C: 13, D: 11 }, t: [['KD'], ['QD']] });
  }

  test('the last card wins the game; nothing but undo is legal afterwards', () => {
    const s = almostWon();
    assert.equal(Engine.isWon(s), false);
    const r1 = Engine.apply(s, move('QD', 'f3'));
    assert.equal(r1.won, false);
    assert.equal(s.won, false);
    const r2 = Engine.apply(s, move('KD', 'f3'));
    assert.equal(r2.won, true);
    assert.equal(s.won, true);
    assert.equal(Engine.isWon(s), true);
    assert.equal(s.score, 20);
    checkInvariants(s, 'won');

    assert.equal(Engine.canDraw(s), false);
    assert.equal(Engine.canPickup(s, C('KD')), false);
    assert.deepEqual(Engine.getRun(s, C('KD')), []);
    assert.deepEqual(Engine.legalTargets(s, C('KD')), []);
    assert.equal(Engine.bestTarget(s, C('KD')), null);
    assert.deepEqual(Engine.hints(s), []);
    assert.equal(Engine.isStuck(s), false);
    assert.equal(Engine.canAutoComplete(s), false);
    assert.equal(Engine.nextAutoAction(s), null);
    const before = snap(s);
    assert.equal(Engine.apply(s, move('KD', 't0')), null);
    assert.equal(Engine.apply(s, DRAW), null);
    assert.deepEqual(snap(s), before);
  });

  test('undo after a win clears the flag, and the game can be won again', () => {
    const s = almostWon();
    Engine.apply(s, move('QD', 'f3'));
    Engine.apply(s, move('KD', 'f3'));
    assert.equal(Engine.canUndo(s), true);
    const u = Engine.apply(s, UNDO);
    assert.equal(u.won, false);
    assert.equal(u.undone.won, true);
    assert.equal(s.won, false);
    assert.equal(Engine.isWon(s), false);
    assert.equal(s.score, 10);
    assert.deepEqual(s.piles.t0, [C('KD')]);
    assert.equal(Engine.canPickup(s, C('KD')), true);
    const again = Engine.apply(s, move('KD', 'f3'));
    assert.equal(again.won, true);
    assert.equal(s.won, true);
    assert.equal(s.undos, 1);
  });
});

// ------------------------------------------------------------------------------------- undo
describe('undo', () => {
  test('illegal on an empty history', () => {
    const s = Engine.newGame({ seed: 5 });
    assert.equal(Engine.canUndo(s), false);
    const before = snap(s);
    assert.equal(Engine.apply(s, UNDO), null);
    assert.deepEqual(snap(s), before);
  });

  test('undo records are the exact inverse (draw 3, recycle, run with reveal)', () => {
    // draw 3
    const s = Engine.newGame({ seed: 21, drawCount: 3 });
    const d = Engine.apply(s, DRAW);
    const u = Engine.apply(s, UNDO);
    assert.equal(u.undone, d);
    assert.deepEqual(u.transfers, d.transfers.slice().reverse().map((t) => ({ card: t.card, from: 'waste', to: 'stock' })));
    assert.deepEqual(u.flips, d.flips.slice().reverse().map((f) => ({ card: f.card, faceUp: false })));
    assert.equal(s.history.length, 0, 'undo is not pushed on the history');
    assert.equal(s.moves, 0);
    assert.equal(s.undos, 1);

    // recycle (draw 1, with a score to restore)
    const r = build({ stock: ['2C', '3C'], rest: 't0', t: [['KS']], score: 130 });
    Engine.apply(r, DRAW);
    Engine.apply(r, DRAW);
    const beforeRecycle = snap(r);
    const rec = Engine.apply(r, DRAW);
    assert.equal(rec.type, 'recycle');
    assert.equal(r.score, 30);
    const ur = Engine.apply(r, UNDO);
    assert.deepEqual(ur.transfers, rec.transfers.slice().reverse().map((t) => ({ card: t.card, from: 'stock', to: 'waste' })));
    assert.deepEqual(ur.flips, rec.flips.slice().reverse().map((f) => ({ card: f.card, faceUp: true })));
    assert.deepEqual([ur.scoreBefore, ur.scoreAfter], [30, 130]);
    assert.deepEqual([ur.recyclesBefore, ur.recyclesAfter], [1, 0]);
    assert.deepEqual([ur.movesBefore, ur.movesAfter], [3, 2]);
    assert.deepEqual(Object.assign(snap(r), { undos: 0 }), beforeRecycle);

    // a run with a reveal
    const m = build({ t: [['-AC', '9H', '8S', '7D'], ['10S']], rest: 'stock' });
    const beforeMove = snap(m);
    const mv = Engine.apply(m, move('9H', 't1'));
    const um = Engine.apply(m, UNDO);
    // (reviewer) a run comes back as the block it left as, bottom -> top: replaying the undo's
    // transfers one by one must rebuild the column in its original order
    assert.deepEqual(um.transfers, [C('9H'), C('8S'), C('7D')].map((card) => ({ card, from: 't1', to: 't0' })));
    assert.deepEqual(um.flips, [{ card: C('AC'), faceUp: false, reveal: true }]);
    assert.equal(um.undone, mv);
    assert.deepEqual(Object.assign(snap(m), { undos: 0 }), beforeMove);
    assert.deepEqual(m.piles.t0, [C('AC'), C('9H'), C('8S'), C('7D')], 'the run is back in its original order');
  });

  test('N random legal actions, then N undos, give back the start exactly', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const drawCount = seed % 2 ? 1 : 3;
      const s = Engine.newGame({ seed, drawCount, id: 'undo-' + seed });
      const start = snap(s);
      const rng = RNG.create(seed * 7919);
      const snaps = [];
      let n = 0;
      for (let i = 0; i < 160; i++) {
        const actions = legalActions(s);
        if (!actions.length) break;
        snaps.push({ print: fingerprint(s), history: s.history.slice() });
        // bias towards hints so that games progress deep (foundations, recycles, reveals)
        const h = rng.next() < 0.6 ? Engine.hints(s) : [];
        const action = h.length ? h[0].action : actions[rng.int(actions.length)];
        assert.ok(Engine.apply(s, action), 'legal action applies');
        n++;
      }
      assert.equal(s.history.length, n);
      for (let i = n - 1; i >= 0; i--) {
        const u = Engine.apply(s, UNDO);
        assert.equal(u.type, 'undo');
        assert.equal(u.won, false);
        assert.equal(s.undos, n - i);
        s.undos = 0; // the only field an undo is allowed to leave different
        assert.equal(fingerprint(s), snaps[i].print, 'seed ' + seed + ' step ' + i);
        assert.equal(s.history.length, i);
        for (let k = 0; k < i; k++) assert.equal(s.history[k], snaps[i].history[k], 'history untouched');
        s.undos = n - i;
      }
      assert.equal(Engine.canUndo(s), false);
      assert.deepEqual(Object.assign(snap(s), { undos: 0 }), start);
      assert.equal(s.undos, n);
    }
  });
});

// ------------------------------------------------------------------------------------- clone / serialize
describe('clone, serialize, deserialize', () => {
  function midGame(seed, drawCount, steps) {
    const s = Engine.newGame({ seed, drawCount, id: 'mid-' + seed });
    const rng = RNG.create(seed + 1000);
    for (let i = 0; i < steps; i++) {
      const a = randomStep(s, rng);
      if (!a) break;
      Engine.apply(s, a);
    }
    s.elapsedMs = 1234.5;
    return s;
  }

  test('clone is equal and independent', () => {
    const s = midGame(31, 3, 80);
    const c = Engine.clone(s);
    assert.deepEqual(c, s);
    assert.notEqual(c, s);
    assert.notEqual(c.piles, s.piles);
    assert.notEqual(c.faceUp, s.faceUp);
    assert.notEqual(c.history, s.history);
    for (const id of PILE_IDS) assert.notEqual(c.piles[id], s.piles[id]);
    const frozen = snap(s);
    // play on in the clone (including undoing past the point of the copy): the original is untouched
    const rng = RNG.create(5);
    for (let i = 0; i < 60; i++) {
      const a = randomStep(c, rng);
      if (a) Engine.apply(c, a);
    }
    while (Engine.canUndo(c)) Engine.apply(c, UNDO);
    assert.deepEqual(snap(s), frozen);
    // and the other way round
    const c2 = Engine.clone(s);
    const frozen2 = snap(c2);
    for (let i = 0; i < 40; i++) {
      const a = randomStep(s, rng);
      if (a) Engine.apply(s, a);
    }
    assert.deepEqual(snap(c2), frozen2);
  });

  test('serialize / deserialize round trip, at every stage of many games', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const s = Engine.newGame({ seed, drawCount: seed % 2 ? 3 : 1 });
      const rng = RNG.create(seed);
      for (let i = 0; i < 150; i++) {
        if (i % 10 === 0) {
          s.elapsedMs = i * 1000.25;
          const text = Engine.serialize(s);
          assert.equal(typeof text, 'string');
          const back = Engine.deserialize(text);
          assert.ok(back, 'seed ' + seed + ' step ' + i);
          assert.deepEqual(back, snap(s));
          assert.notEqual(back, s);
          // the restored game is fully playable, including undo through its history
          const copy = Engine.clone(back);
          while (Engine.canUndo(copy)) assert.ok(Engine.apply(copy, UNDO));
          assert.deepEqual(copy.piles, Engine.newGame({ seed }).piles);
        }
        const a = randomStep(s, rng);
        if (!a) break;
        Engine.apply(s, a);
      }
    }
  });

  test('a won game round-trips', () => {
    const s = build({ f: { S: 13, H: 13, C: 13, D: 12 }, t: [['KD']] });
    Engine.apply(s, move('KD', 'f3'));
    const back = Engine.deserialize(Engine.serialize(s));
    assert.ok(back);
    assert.equal(back.won, true);
    assert.deepEqual(back, snap(s));
  });

  test('deserialize rejects everything that is not a consistent state', () => {
    const good = midGame(77, 1, 60);
    assert.ok(good.history.length > 10);
    assert.ok(Engine.deserialize(Engine.serialize(good)));

    const notStrings = [undefined, null, 0, 42, true, {}, [], good, () => {}];
    for (const v of notStrings) assert.equal(Engine.deserialize(v), null);
    const junk = ['', ' ', 'null', 'true', '42', '"text"', '[]', '{}', '{"v":1}', 'not json', '{"v":1,', Engine.serialize(good).slice(0, -1), Engine.serialize(good) + '}'];
    for (const v of junk) assert.equal(Engine.deserialize(v), null, 'junk: ' + v.slice(0, 20));

    // each mutation corrupts one aspect of an otherwise valid state
    const tableauWithHidden = TABLEAU.find((id) => good.piles[id].some((c) => !good.faceUp[c]) && good.piles[id].length > 1);
    assert.ok(tableauWithHidden && good.piles.stock.length > 1 && good.piles.waste.length > 0);
    const mutations = {
      'wrong version': (s) => (s.v = 2),
      'version as string': (s) => (s.v = '1'),
      'id missing': (s) => delete s.id,
      'id empty': (s) => (s.id = ''),
      'id not a string': (s) => (s.id = 7),
      'seed negative': (s) => (s.seed = -1),
      'seed fractional': (s) => (s.seed = 1.5),
      'seed too big': (s) => (s.seed = 4294967296),
      'seed string': (s) => (s.seed = '5'),
      'seed missing': (s) => delete s.seed,
      'drawCount 2': (s) => (s.drawCount = 2),
      'drawCount string': (s) => (s.drawCount = '1'),
      'drawCount missing': (s) => delete s.drawCount,
      'piles missing': (s) => delete s.piles,
      'piles array': (s) => (s.piles = []),
      'piles null': (s) => (s.piles = null),
      'pile missing': (s) => delete s.piles.t3,
      'pile renamed': (s) => {
        s.piles.t7 = s.piles.t6;
        delete s.piles.t6;
      },
      'extra pile': (s) => (s.piles.t7 = []),
      'pile not an array': (s) => (s.piles.waste = { 0: 1 }),
      'pile null': (s) => (s.piles.f0 = null),
      'card out of range': (s) => (s.piles.stock[0] = 52),
      'card negative': (s) => (s.piles.stock[0] = -1),
      'card fractional': (s) => (s.piles.stock[0] += 0.5),
      'card as string': (s) => (s.piles.stock[0] = String(s.piles.stock[0])),
      'card null': (s) => (s.piles.stock[0] = null),
      'duplicate card': (s) => (s.piles.stock[0] = s.piles.stock[1]),
      'card missing': (s) => s.piles.stock.shift(),
      'card extra': (s) => s.piles.stock.push(s.piles.stock[0]),
      'faceUp missing': (s) => delete s.faceUp,
      'faceUp too short': (s) => s.faceUp.pop(),
      'faceUp too long': (s) => s.faceUp.push(false),
      'faceUp not boolean': (s) => (s.faceUp[10] = 1),
      'faceUp null entry': (s) => (s.faceUp[10] = null),
      'stock card face-up': (s) => (s.faceUp[s.piles.stock[0]] = true),
      'waste card face-down': (s) => (s.faceUp[s.piles.waste[0]] = false),
      'tableau top face-down': (s) => {
        const p = s.piles[tableauWithHidden];
        s.faceUp[p[p.length - 1]] = false;
      },
      'face-down above face-up': (s) => {
        const p = s.piles[tableauWithHidden];
        s.faceUp[p[0]] = true;
        // p[1] must be face-down for this to bite; make sure of it
        s.faceUp[p[1]] = false;
        s.faceUp[p[p.length - 1]] = true;
        if (p.length === 2) s.faceUp[p[1]] = false;
      },
      'foundation with the wrong card': (s) => {
        // swap a stock card into an empty-or-not foundation
        s.piles.f2.push(s.piles.stock.pop());
        s.faceUp[s.piles.f2[s.piles.f2.length - 1]] = true;
        s.piles.f2.reverse();
      },
      'score negative': (s) => (s.score = -5),
      'score fractional': (s) => (s.score = 1.5),
      'score null (NaN / Infinity in JSON)': (s) => (s.score = null),
      'score string': (s) => (s.score = '10'),
      'moves negative': (s) => (s.moves = -1),
      'moves missing': (s) => delete s.moves,
      'undos string': (s) => (s.undos = 'x'),
      'recycles fractional': (s) => (s.recycles = 0.5),
      'elapsedMs negative': (s) => (s.elapsedMs = -1),
      'elapsedMs string': (s) => (s.elapsedMs = '12'),
      'elapsedMs null': (s) => (s.elapsedMs = null),
      'won not boolean': (s) => (s.won = 0),
      'won but not finished': (s) => (s.won = true),
      'history missing': (s) => delete s.history,
      'history not an array': (s) => (s.history = {}),
      'history entry null': (s) => (s.history[0] = null),
      'record type unknown': (s) => (s.history[0].type = 'undo'),
      'record transfers empty': (s) => (s.history[s.history.length - 1].transfers = []),
      'record transfers missing': (s) => delete s.history[2].transfers,
      'record transfer card invalid': (s) => (s.history[s.history.length - 1].transfers[0].card = 99),
      'record transfer pile unknown': (s) => (s.history[s.history.length - 1].transfers[0].to = 'x9'),
      'record transfer onto itself': (s) => {
        const t = s.history[s.history.length - 1].transfers[0];
        t.to = t.from;
      },
      'record flips missing': (s) => delete s.history[1].flips,
      'record flip malformed': (s) => s.history[1].flips.push({ card: 3, faceUp: 'yes' }),
      'record counter missing': (s) => delete s.history[1].scoreBefore,
      'record counter not a number': (s) => (s.history[1].movesAfter = 'x'),
      'record won not boolean': (s) => (s.history[1].won = 'no'),
      'record auto not true': (s) => (s.history[1].auto = false),
      'history that does not fit the piles (last record)': (s) => {
        const t = s.history[s.history.length - 1].transfers[0];
        t.card = (t.card + 1) % 52;
      },
      'history that does not fit the piles (deep record dropped)': (s) => s.history.splice(Math.floor(s.history.length / 2), 1),
      'history counters broken mid-chain': (s) => (s.history[3].scoreBefore += 5),
      'history move counter skips': (s) => (s.history[3].movesAfter += 1),
      'score not the one the history ends with': (s) => (s.score += 5),
      'moves not the count the history ends with': (s) => (s.moves += 1),
      'recycles not the count the history ends with': (s) => (s.recycles += 1),
      'history continues after a winning record': (s) => (s.history[2].won = true),
      'forged record: a flip of the wrong card': (s) => {
        // turn "the stock card was turned up" into "some other face-up card was turned up"
        const i = s.history.findIndex((r) => r.type === 'draw');
        const other = s.faceUp.findIndex((up, c) => up && c !== s.history[i].flips[0].card);
        s.history[i].flips[0].card = other;
      },
      'forged record: a score that the rules do not give': (s) => {
        for (let i = s.history.length - 1; i < s.history.length; i++) s.history[i].scoreAfter += 50;
        s.score += 50;
      },
      'forged record: a move the rules do not allow': (s) => {
        // rewrite the last tableau-to-tableau move so that it lands on another column
        for (let i = s.history.length - 1; i >= 0; i--) {
          const r = s.history[i];
          if (r.type !== 'move' || r.transfers[0].to[0] !== 't') continue;
          const other = TABLEAU.find((id) => id !== r.transfers[0].to && id !== r.transfers[0].from);
          const n = r.transfers.length;
          const moved = s.piles[r.transfers[0].to].splice(-n, n);
          s.piles[other].push(...moved);
          for (const t of r.transfers) t.to = other;
          // drop everything after it so that only this record is at fault
          s.history.length = i + 1;
          s.score = r.scoreAfter;
          s.moves = r.movesAfter;
          s.recycles = r.recyclesAfter;
          return;
        }
        s.v = 0; // (no such move in this game: fail the state some other way)
      },
      'history reordered': (s) => s.history.reverse(),
    };
    for (const [name, mutate] of Object.entries(mutations)) {
      const copy = snap(good);
      mutate(copy);
      let result;
      assert.doesNotThrow(() => (result = Engine.deserialize(JSON.stringify(copy))), name);
      assert.equal(result, null, name);
    }
  });

  test('deserialize keeps to the known fields and tolerates a trimmed history', () => {
    const good = midGame(78, 3, 50);
    const extra = snap(good);
    extra.surprise = { a: 1 };
    extra.piles.stock.extra = 1; // dropped by JSON anyway
    const back = Engine.deserialize(JSON.stringify(extra));
    assert.ok(back);
    assert.ok(!('surprise' in back));
    assert.deepEqual(back, snap(good));
    // dropping the OLDEST records leaves a state that still undoes consistently
    const trimmed = snap(good);
    trimmed.history = trimmed.history.slice(-5);
    const t = Engine.deserialize(JSON.stringify(trimmed));
    assert.ok(t);
    for (let i = 0; i < 5; i++) assert.ok(Engine.apply(t, UNDO));
    assert.equal(Engine.apply(t, UNDO), null);
  });

  test('deserialize never throws on randomly damaged text, and whatever it accepts is sound', () => {
    const text = Engine.serialize(midGame(79, 1, 70));
    const rng = RNG.create(4711);
    const alphabet = '0123456789[]{},:"truefalsn-. ';
    let accepted = 0;
    for (let i = 0; i < 3000; i++) {
      const chars = text.split('');
      const edits = 1 + rng.int(3);
      for (let e = 0; e < edits; e++) {
        const pos = rng.int(chars.length);
        const kind = rng.int(3);
        if (kind === 0) chars[pos] = alphabet[rng.int(alphabet.length)];
        else if (kind === 1) chars.splice(pos, 1 + rng.int(4));
        else chars.splice(pos, 0, alphabet[rng.int(alphabet.length)]);
      }
      let result;
      assert.doesNotThrow(() => (result = Engine.deserialize(chars.join(''))));
      if (result) {
        // Whatever slipped through is still a position the engine can stand behind: sound piles
        // and faces, and a history that undoes cleanly all the way, every step a sound position.
        accepted++;
        checkInvariants(result, 'accepted damaged text', false);
        assert.deepEqual(Engine.deserialize(Engine.serialize(result)), result);
        while (Engine.canUndo(result)) {
          assert.ok(Engine.apply(result, UNDO));
          checkInvariants(result, 'accepted damaged text, undone', false);
        }
      }
    }
    assert.ok(accepted < 1500, 'most damage is caught: ' + accepted + ' of 3000 accepted');
  });
});

// ------------------------------------------------------------------------------------- queries
describe('queries', () => {
  test('locate, topCard, isFaceUp', () => {
    const s = Engine.newGame({ seed: 9 });
    for (const id of PILE_IDS) {
      const p = s.piles[id];
      assert.equal(Engine.topCard(s, id), p.length ? p[p.length - 1] : null);
      p.forEach((c, index) => {
        assert.deepEqual(Engine.locate(s, c), { pile: id, index });
        assert.equal(Engine.isFaceUp(s, c), s.faceUp[c]);
      });
    }
    assert.equal(Engine.topCard(s, 'waste'), null);
    assert.equal(Engine.topCard(s, 'nowhere'), null);
    assert.equal(Engine.locate(s, 52), null);
    assert.equal(Engine.locate(s, -1), null);
    assert.equal(Engine.locate(s, '3'), null);
  });

  test('canPickup / getRun / canDrop / legalTargets agree with a naive reading of the rules, and with apply', () => {
    let checkedPairs = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const s = Engine.newGame({ seed, drawCount: seed % 3 ? 1 : 3 });
      const rng = RNG.create(seed * 31);
      for (let step = 0; step < 120; step++) {
        if (step % 6 === 0) {
          const print = fingerprint(s);
          for (let c = 0; c < 52; c++) {
            const run = refRun(s, c);
            assert.deepEqual(Engine.getRun(s, c), run);
            assert.equal(Engine.canPickup(s, c), run.length > 0);
            const targets = [];
            for (const to of PILE_IDS) {
              const expected = refCanDrop(s, c, to);
              assert.equal(Engine.canDrop(s, c, to), expected, 'canDrop ' + c + ' -> ' + to);
              if (expected) {
                targets.push(to);
                const trial = Engine.clone(s);
                assert.ok(Engine.apply(trial, { type: 'move', card: c, to }), 'apply agrees with canDrop');
              } else {
                assert.equal(Engine.apply(s, { type: 'move', card: c, to }), null, 'apply agrees with canDrop');
              }
              checkedPairs++;
            }
            assert.deepEqual(Engine.legalTargets(s, c), targets);
            const best = Engine.bestTarget(s, c);
            if (best !== null) assert.ok(targets.includes(best), 'bestTarget is a legal target');
          }
          assert.equal(Engine.canDraw(s), looseCount(s) > 0 && !s.won);
          assert.equal(Engine.canUndo(s), s.history.length > 0);
          assert.equal(fingerprint(s), print, 'queries and refused moves change nothing');
        }
        const a = randomStep(s, rng);
        if (!a) break;
        Engine.apply(s, a);
      }
    }
    assert.ok(checkedPairs > 100000);
  });
});

// ------------------------------------------------------------------------------------- bestTarget
describe('bestTarget', () => {
  test('a single card prefers its foundation', () => {
    const s = build({ f: { S: 1 }, t: [['2S'], ['3H'], ['3D']], rest: 'stock' });
    assert.deepEqual(Engine.legalTargets(s, C('2S')), ['f0', 't1', 't2']);
    assert.equal(Engine.bestTarget(s, C('2S')), 'f0');
  });

  test('a run goes to the leftmost legal non-empty column, even when a foundation would take its first card', () => {
    const s = build({ f: { H: 3 }, t: [['-9C', '4H', '3S'], [], ['5S'], [], ['5C']], rest: 'stock' });
    assert.equal(Engine.bestTarget(s, C('4H')), 't2');
    assert.equal(Engine.bestTarget(s, C('3S')), null, 'nowhere to go for the top card');
    // the same 4H alone goes up
    const alone = build({ f: { H: 3 }, t: [['-9C', '4H'], [], ['5S']], rest: 'stock' });
    assert.equal(Engine.bestTarget(alone, C('4H')), 'f1');
  });

  test('kings: leftmost empty column, but not from the bottom of a column', () => {
    const s = build({ t: [['-9C', 'KH'], ['KS', 'QD'], [], ['7C'], []], waste: ['KD'], rest: 'stock' });
    assert.equal(Engine.bestTarget(s, C('KH')), 't2');
    assert.equal(Engine.bestTarget(s, C('KD')), 't2', 'waste king');
    assert.equal(Engine.bestTarget(s, C('KS')), null, 'already at the bottom of its column');
    assert.equal(Engine.bestTarget(s, C('QD')), null);
    assert.equal(Engine.bestTarget(s, C('7C')), null);
    // no empty column: nowhere to go
    const full = build({ t: [['-9C', 'KH'], ['2C'], ['4C'], ['6C'], ['8C'], ['10C'], ['QC']], rest: 'stock' });
    assert.equal(Engine.bestTarget(full, C('KH')), null);
  });

  test('a non-empty column wins over an empty one; waste cards work too', () => {
    const s = build({ t: [[], ['10S'], ['10C']], waste: ['9H'], rest: 'stock' });
    assert.equal(Engine.bestTarget(s, C('9H')), 't1');
    const ace = build({ t: [[], ['2H']], waste: ['AS'], rest: 'stock' });
    assert.equal(Engine.bestTarget(ace, C('AS')), 'f0');
  });

  test('null for foundation cards and anything that cannot be picked up', () => {
    const s = build({ f: { S: 2 }, t: [['-9C', '3H']], waste: ['7D', '8D'], rest: 'stock' });
    assert.equal(Engine.canDrop(s, C('2S'), 't0'), true);
    assert.equal(Engine.bestTarget(s, C('2S')), null, 'taps on foundations do nothing');
    assert.equal(Engine.bestTarget(s, C('AS')), null);
    assert.equal(Engine.bestTarget(s, C('9C')), null, 'face-down');
    assert.equal(Engine.bestTarget(s, C('7D')), null, 'buried in the waste');
    assert.equal(Engine.bestTarget(s, s.piles.stock[0]), null, 'stock');
    assert.equal(Engine.bestTarget(s, 99), null);
  });
});

// ------------------------------------------------------------------------------------- hints
describe('hints', () => {
  const first = (state) => Engine.hints(state)[0];

  test('shape and order', () => {
    const s = Engine.newGame({ seed: 1 });
    const hints = Engine.hints(s);
    assert.ok(hints.length > 0);
    for (const h of hints) {
      assert.deepEqual(Object.keys(h).sort(), ['action', 'priority', 'reason']);
      assert.ok(typeof h.reason === 'string' && h.reason.length > 5);
      assert.ok(Number.isInteger(h.priority) && h.priority >= 1 && h.priority <= 8);
      assert.ok(h.action.type === 'draw' || h.action.type === 'move');
    }
    for (let i = 1; i < hints.length; i++) assert.ok(hints[i].priority >= hints[i - 1].priority, 'best first');
    // seed 1: the 2 of spades can go on the 3 of hearts, uncovering a card
    assert.deepEqual(hints[0], {
      action: { type: 'move', card: C('2S'), to: 't2' },
      priority: 2,
      reason: 'Move the 2 of Spades onto the 3 of Hearts to turn over a hidden card',
    });
    // asking for hints never changes the state
    const before = snap(s);
    Engine.hints(s);
    Engine.isStuck(s);
    assert.deepEqual(snap(s), before);
  });

  test('1: foundation moves come first (uncovering ones before the rest, low ranks first)', () => {
    const s = build({ f: { D: 1 }, t: [['AS'], ['-5C', '9H'], ['10S'], ['-7C', 'AC'], ['2D']], rest: 'stock' });
    const hints = Engine.hints(s);
    assert.deepEqual(hints[0].action, move('AC', 'f2'), 'uncovers a card as well');
    assert.equal(hints[0].priority, 1);
    assert.deepEqual(hints[1].action, move('AS', 'f0'));
    assert.deepEqual(hints[2].action, move('2D', 'f3'));
    assert.deepEqual(hints.slice(0, 3).map((h) => h.priority), [1, 1, 1]);
    assert.deepEqual(hints[3].action, move('9H', 't2'));
    assert.equal(hints[3].priority, 2);
  });

  test('2: uncovering moves, deepest column first', () => {
    const s = build({ t: [['-2C', '9H'], ['10S'], ['-3C', '-4C', '-6C', '9D'], ['10C'], [], [], ['2D']], rest: 't6' });
    const hints = Engine.hints(s);
    assert.deepEqual(hints.map((h) => h.action), [move('9D', 't1'), move('9H', 't1')]);
    assert.deepEqual(hints.map((h) => h.priority), [2, 2]);
  });

  test('3: a King to an empty column when that uncovers a card', () => {
    const s = build({ t: [['-5C', 'KH'], [], ['9S']], rest: 't0' });
    assert.deepEqual(Engine.hints(s), [
      { action: move('KH', 't1'), priority: 3, reason: 'Move the King of Hearts to the empty column to turn over a hidden card' },
    ]);
  });

  test('3: empty a column when a King is waiting for one — and only then', () => {
    const cols = [['-5C', 'KH'], ['9D'], ['10S'], ['2C'], ['4C'], ['6C'], ['JC']];
    const s = build({ t: cols, rest: 't0' });
    const h = first(s);
    assert.deepEqual(h.action, move('9D', 't2'));
    assert.equal(h.priority, 3);
    assert.match(h.reason, /free a column for a King/);
    Engine.apply(s, h.action);
    assert.deepEqual(first(s).action, move('KH', 't1'), 'then the King takes the column');
    assert.equal(first(s).priority, 3);

    // a King waiting in the stock counts as well
    const stockKing = build({ t: [['-5C', '8H'], ['9D'], ['10S'], ['2C'], ['4C'], ['6C'], ['JC']], stock: ['KH'], rest: 't0' });
    assert.deepEqual(first(stockKing).action, move('9D', 't2'));
    assert.equal(first(stockKing).priority, 3);

    // no King anywhere in reach: emptying a column achieves nothing
    const noKing = build({ t: [['-5C', '8H'], ['9D'], ['10S'], ['2C'], ['4C'], ['6C'], ['JC']], rest: 't0' });
    assert.deepEqual(Engine.hints(noKing), []);
    assert.equal(Engine.canDrop(noKing, C('9D'), 't2'), true, 'the move itself is legal');
    // and when a column is already free there is no need to empty another one
    const alreadyFree = build({ t: [['-5C', '8H'], ['9D'], ['10S'], ['2C'], ['4C'], ['6C'], []], stock: ['KH'], rest: 't0' });
    assert.ok(!Engine.hints(alreadyFree).some((x) => x.action.type === 'move' && x.action.card === C('9D')));
    assert.deepEqual(first(alreadyFree).action, DRAW);
  });

  test('4: waste to tableau', () => {
    const s = build({ t: [['-5C', '10S'], ['-6C', 'JC']], waste: ['9H'], rest: 't1' });
    assert.deepEqual(Engine.hints(s), [{ action: move('9H', 't0'), priority: 4, reason: 'Play the 9 of Hearts from the waste onto the 10 of Spades' }]);
    const king = build({ t: [['-5C', '10S'], []], waste: ['KD'], rest: 't0' });
    assert.deepEqual(first(king).action, move('KD', 't1'));
    assert.equal(first(king).priority, 4);
  });

  test('5: splitting a run only when it frees a card for its foundation', () => {
    const spec = { t: [['-9C', '6H', '5S', '4H'], ['-7D', '5C']], rest: 't1' };
    const ready = build(Object.assign({ f: { S: 4 } }, spec));
    assert.deepEqual(Engine.hints(ready), [
      { action: move('4H', 't1'), priority: 5, reason: 'Move the 4 of Hearts away to free the 5 of Spades for its foundation' },
    ]);
    Engine.apply(ready, move('4H', 't1'));
    assert.deepEqual(first(ready).action, move('5S', 'f0'));

    // same layout, but the 5 of spades has nowhere to go: moving the 4 between the two black 5s is a pointless shuffle
    const idle = build(Object.assign({ f: { S: 3 } }, spec));
    assert.equal(Engine.canDrop(idle, C('4H'), 't1'), true);
    assert.deepEqual(Engine.hints(idle), []);
    assert.equal(Engine.isStuck(idle), true);
  });

  test('6: draw when the stock or the waste can still produce something (draw 1)', () => {
    const s = build({ t: [['-5C', '10S']], stock: ['9H', '2C', '3C'], rest: 't0' });
    assert.deepEqual(Engine.hints(s), [{ action: DRAW, priority: 6, reason: 'Draw from the stock' }]);
    // the useful card is buried in the waste and the stock is empty: recycle
    const w = build({ t: [['-5C', '10S']], waste: ['9H', '2C', '3C'], rest: 't0' });
    assert.deepEqual(Engine.hints(w), [{ action: DRAW, priority: 6, reason: 'Turn the waste over and go through the stock again' }]);
    // nothing in the stock helps
    const dead = build({ t: [['-5C', '10S']], stock: ['2C', '3C'], rest: 't0' });
    assert.deepEqual(Engine.hints(dead), []);
  });

  test('6: draw 3 simulates which cards the cycle really exposes', () => {
    const table = { drawCount: 3, t: [['-5C', '10S']], rest: 't0' };
    // drawn as 3C, 2C, 9H: the 9 of hearts ends on top
    const exposed = build(Object.assign({ stock: ['9H', '2C', '3C'] }, table));
    assert.deepEqual(Engine.hints(exposed).map((h) => h.priority), [6]);
    assert.equal(Engine.isStuck(exposed), false);
    // drawn as 3C, 9H, 2C: the 9 never surfaces, in this pass or any later one
    const buried = build(Object.assign({ stock: ['2C', '9H', '3C'] }, table));
    assert.deepEqual(Engine.hints(buried), []);
    assert.equal(Engine.isStuck(buried), true);
    // a waste card shifts the next pass: 4C 3C 9H | 2C -> the 9 surfaces after a recycle
    const shifted = build(Object.assign({ stock: ['2C', '9H', '3C'], waste: ['4C'] }, table));
    assert.deepEqual(Engine.hints(shifted).map((h) => h.priority), [6]);
    assert.equal(Engine.isStuck(shifted), false);
    // 7 cards: the 3rd, the 6th and the last one surface (4C, 6C, 2D here: the 9 stays buried)
    const seven = build(Object.assign({ stock: ['2D', '6C', '2C', '3C', '4C', '9H', '7C'] }, table));
    assert.deepEqual(Engine.hints(seven), []);
    assert.equal(Engine.isStuck(seven), true);
    // ...the last, short draw counts
    const last = build(Object.assign({ stock: ['9H', '6C', '2C', '3C', '4C', '2D', '7C'] }, table));
    assert.deepEqual(Engine.hints(last).map((h) => h.priority), [6]);
    assert.equal(Engine.isStuck(last), false);
    // and the engine agrees with itself: draw through `seven` and watch the waste tops
    const tops = [];
    while (seven.piles.stock.length) {
      Engine.apply(seven, DRAW);
      tops.push(Engine.topCard(seven, 'waste'));
    }
    assert.deepEqual(tops, [C('4C'), C('6C'), C('2D')]);
  });

  test('a card that something can still be built on does not leave for its foundation first', () => {
    // the 9 of hearts wants the 10 of spades as its base (and that uncovers a card)
    const wanted = build({ f: { S: 9 }, t: [['-5C', '9H'], ['JD', '10S']], rest: 't0' });
    assert.deepEqual(
      Engine.hints(wanted).map((h) => [h.action, h.priority]),
      [
        [move('9H', 't1'), 2],
        [move('10S', 'f0'), 8],
      ]
    );
    // the same when the 9 of hearts is still in the stock
    const inStock = build({ f: { S: 9 }, t: [['-5C', '2D'], ['JD', '10S']], stock: ['9H'], rest: 't0' });
    assert.deepEqual(
      Engine.hints(inStock).map((h) => [h.action, h.priority]),
      [
        [DRAW, 6],
        [move('10S', 'f0'), 8],
      ]
    );
    Engine.apply(inStock, DRAW);
    assert.deepEqual(
      Engine.hints(inStock).map((h) => [h.action, h.priority]),
      [
        [move('9H', 't1'), 4],
        [move('10S', 'f0'), 8],
      ]
    );
    // with both red 9s home nothing can ever need the 10: it goes up first
    const safe = build({ f: { S: 9, H: 9, D: 9 }, t: [['-5C', '2C'], ['JD', '10S']], rest: 't0' });
    assert.deepEqual(first(safe).action, move('10S', 'f0'));
    assert.equal(first(safe).priority, 1);
  });

  test('foundation moves that are all that is left: plain when nothing else can happen, last when a rearrangement can', () => {
    // nothing can ever be uncovered here: the 10 simply goes up
    const plain = build({ f: { S: 9 }, t: [['-5C', '2D'], ['JD', '10S']], rest: 't0' });
    assert.deepEqual(Engine.hints(plain), [{ action: move('10S', 'f0'), priority: 1, reason: 'Move the 10 of Spades to its foundation' }]);
    assert.equal(Engine.isStuck(plain), false, 'a foundation move exists');
    Engine.apply(plain, move('10S', 'f0'));
    assert.deepEqual(Engine.hints(plain), []);
    assert.equal(Engine.isStuck(plain), true);

    // here the 9 of spades can come back down onto the 10 of hearts and take the 8 of diamonds:
    // that must happen before the 10 of spades buries it on the foundation
    const better = build({ f: { S: 9 }, t: [['-5C', '8D'], ['10H'], ['JD', '10S']], rest: 't0' });
    const hints = Engine.hints(better);
    assert.deepEqual(
      hints.map((h) => [h.action, h.priority]),
      [
        [move('9S', 't1'), 7],
        [move('10S', 'f0'), 8],
      ]
    );
    Engine.apply(better, hints[0].action);
    assert.deepEqual(first(better).action, move('8D', 't1'));
    assert.equal(first(better).priority, 2);
  });

  test('a card that can go home for good is not offered a tableau spot', () => {
    const s = build({ t: [['-7C', 'AC'], ['2D'], ['2H']], waste: ['AS'], rest: 't0' });
    assert.deepEqual(
      Engine.hints(s).map((h) => [h.action, h.priority]),
      [
        [move('AC', 'f2'), 1],
        [move('AS', 'f0'), 1],
      ]
    );
    assert.equal(Engine.canDrop(s, C('AC'), 't1'), true, 'legal all the same');
  });

  test('every hint is a legal action, in every reachable position (fuzz)', () => {
    let hintsSeen = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const s = Engine.newGame({ seed, drawCount: seed % 2 ? 1 : 3 });
      const rng = RNG.create(seed * 13);
      for (let step = 0; step < 200; step++) {
        const before = fingerprint(s);
        const hints = Engine.hints(s);
        Engine.isStuck(s);
        assert.equal(fingerprint(s), before, 'hints() and isStuck() do not mutate');
        for (let i = 0; i < hints.length; i++) {
          if (i > 0) assert.ok(hints[i].priority >= hints[i - 1].priority);
          const trial = Engine.clone(s);
          assert.ok(Engine.apply(trial, hints[i].action), 'hint is legal: ' + hints[i].reason);
          if (hints[i].action.type === 'move') {
            const loc = Engine.locate(s, hints[i].action.card);
            // never the pointless King hop
            assert.ok(!(rankOf(hints[i].action.card) === 13 && loc.index === 0 && loc.pile[0] === 't' && s.piles[hints[i].action.to].length === 0));
          }
          hintsSeen++;
        }
        const a = randomStep(s, rng);
        if (!a) break;
        Engine.apply(s, a);
      }
    }
    assert.ok(hintsSeen > 5000);
  });

  test('following the first hint always ends: in a win, or with no hint left (no going round in circles)', () => {
    let wins = 0;
    let dead = 0;
    let repeats = 0; // a position seen twice = two wasted moves; tolerated, but it must stay rare
    for (let seed = 1; seed <= 400; seed++) {
      for (const drawCount of [1, 3]) {
        const s = Engine.newGame({ seed, drawCount });
        const seen = new Map();
        let steps = 0;
        for (;;) {
          const hints = Engine.hints(s);
          if (!hints.length) break;
          const key = JSON.stringify([s.piles, s.faceUp]);
          const visits = (seen.get(key) || 0) + 1;
          seen.set(key, visits);
          if (visits > 1) repeats++;
          assert.ok(visits <= 2, 'going round in circles: seed ' + seed + ' draw ' + drawCount + ' step ' + steps);
          assert.ok(Engine.apply(s, hints[0].action));
          steps++;
          assert.ok(steps < 600, 'a hint-led game is short');
        }
        if (s.won) {
          wins++;
        } else {
          dead++;
          // with no hint left the game is stuck, or (rarely) too tangled for the search to tell
          assert.ok(hiddenCount(s) + looseCount(s) > 0);
        }
        checkInvariants(s, 'hint playout ' + seed);
      }
    }
    assert.ok(wins > 200, 'the hints are good enough to win a fair share of games: ' + wins);
    assert.ok(dead > 200);
    assert.ok(repeats <= 4, 'wasted hint pairs: ' + repeats);
  });
});

// ------------------------------------------------------------------------------------- isStuck
describe('isStuck', () => {
  const blocked = [['4S'], ['4C'], ['6S'], ['6C'], ['JS']];

  test('a dead position is stuck; a fresh deal is not', () => {
    const s = build({ t: [['-2H', 'KC'], ['-3H', '9S']].concat(blocked), rest: 't0' });
    assert.deepEqual(legalActions(s), []);
    assert.equal(Engine.isStuck(s), true);
    assert.deepEqual(Engine.hints(s), []);
    assert.equal(Engine.isStuck(Engine.newGame({ seed: 1 })), false);
  });

  test('not stuck while the stock holds a playable card; stuck when it does not', () => {
    const table = { t: [['-2H', 'KC'], ['-3H', '9S']].concat(blocked), rest: 't0' };
    const playable = build(Object.assign({ stock: ['5H', '2D'] }, table)); // 5H fits a black 6
    assert.equal(Engine.isStuck(playable), false);
    assert.deepEqual(Engine.hints(playable).map((h) => h.action), [DRAW]);
    const useless = build(Object.assign({ stock: ['2D', 'QC'] }, table));
    assert.equal(Engine.isStuck(useless), true);
    assert.deepEqual(Engine.hints(useless), []);
    // the same with the cards sitting in the waste
    const wasteOnly = build(Object.assign({ waste: ['2D', 'QC'] }, table));
    assert.equal(Engine.isStuck(wasteOnly), true);
    const wastePlayable = build(Object.assign({ waste: ['5H', 'QC'] }, table));
    assert.equal(Engine.isStuck(wastePlayable), false);
  });

  test('never stuck while a move that changes something useful exists', () => {
    // a foundation move
    assert.equal(Engine.isStuck(build({ t: [['-2H', 'KC'], ['-3H', 'AS']].concat(blocked.slice(0, 4), [['JD']]), rest: 't0' })), false);
    // an uncovering move
    assert.equal(Engine.isStuck(build({ t: [['-2H', 'KC'], ['-3H', '5D'], ['4S'], ['4C'], ['6S'], ['8C'], ['JS']], rest: 't0' })), false);
    // a King with an empty column
    assert.equal(Engine.isStuck(build({ t: [['-2H', 'KC'], ['-3H', '9S'], ['4S'], ['4C'], ['6S'], ['6C'], []], rest: 't0' })), false);
    // a waste card that fits
    assert.equal(Engine.isStuck(build({ t: [['-2H', 'KC'], ['-3H', '9S']].concat(blocked), waste: ['8D'], rest: 't0' })), false);
  });

  test('taking a card back from a foundation can reopen the game: not stuck, and hinted as a last resort', () => {
    // No ordinary move exists. But the 5 of spades can come down onto the 6 of hearts, and then
    // the 4 of diamonds can move onto it, uncovering the 2 of hearts.
    const s = build({ f: { S: 5 }, t: [['-QD', 'KC'], ['-2H', '4D'], ['6H'], ['9C'], ['9S'], ['JC'], ['JS']], rest: 't0' });
    assert.deepEqual(
      legalActions(s),
      [move('5S', 't2')],
      'the only legal move is the take-back'
    );
    assert.equal(Engine.isStuck(s), false);
    const hints = Engine.hints(s);
    assert.equal(hints.length, 1);
    assert.deepEqual(hints[0].action, move('5S', 't2'));
    assert.equal(hints[0].priority, 7);
    assert.match(hints[0].reason, /back from its foundation/);

    Engine.apply(s, hints[0].action);
    const next = Engine.hints(s);
    assert.deepEqual(next[0].action, move('4D', 't2'), 'the follow-up uncovers the card');
    assert.equal(next[0].priority, 2);
    // putting the 5 straight back is offered last, not first
    const back = next.find((h) => h.action.card === C('5S'));
    assert.ok(back && back.priority === 8 && next.indexOf(back) === next.length - 1);
    assert.match(back.reason, /^Return/);

    // without a card to gain, the same take-back is pointless: the position is stuck
    const dead = build({ f: { S: 5 }, t: [['-QD', 'KC'], ['-2H', '2D'], ['6H'], ['9C'], ['9S'], ['JC'], ['JS']], rest: 't0' });
    assert.deepEqual(legalActions(dead), [move('5S', 't2')]);
    assert.equal(Engine.isStuck(dead), true);
    assert.deepEqual(Engine.hints(dead), []);
  });

  test('a take-back that lets a stock card be played also counts', () => {
    // the 4 of diamonds in the stock fits on the 5 of spades once that comes down
    const s = build({ f: { S: 5 }, t: [['-QD', 'KC'], ['-2H', '2D'], ['6H'], ['9C'], ['9S'], ['JC'], ['JS']], stock: ['4D', '2C'], rest: 't0' });
    assert.equal(Engine.isStuck(s), false);
    let hints = Engine.hints(s);
    assert.deepEqual(hints.map((h) => [h.action.type, h.priority]), [['draw', 7]], 'first bring the card up');
    Engine.apply(s, DRAW);
    assert.deepEqual(Engine.hints(s).map((h) => [h.action.type, h.priority]), [['draw', 7]]);
    Engine.apply(s, DRAW);
    assert.equal(Engine.topCard(s, 'waste'), C('4D'));
    hints = Engine.hints(s);
    assert.deepEqual(hints[0].action, move('5S', 't2'));
    assert.equal(hints[0].priority, 7);
    Engine.apply(s, hints[0].action);
    assert.deepEqual(Engine.hints(s)[0].action, move('4D', 't2'));
    assert.equal(Engine.hints(s)[0].priority, 4);
  });

  test('never true when a foundation or uncovering move exists, and consistent with hints (fuzz)', () => {
    let stuckSeen = 0;
    let checked = 0;
    for (let seed = 1; seed <= 150; seed++) {
      const s = Engine.newGame({ seed, drawCount: seed % 2 ? 1 : 3 });
      const rng = RNG.create(seed * 17);
      for (let step = 0; step < 260; step++) {
        const stuck = Engine.isStuck(s);
        checked++;
        if (stuck) {
          stuckSeen++;
          assert.equal(s.won, false);
          assert.deepEqual(Engine.hints(s), [], 'a stuck game has no hints');
          // brute force: no legal move reaches a foundation or turns a card
          for (const a of legalActions(s)) {
            if (a.type !== 'move') continue;
            assert.notEqual(a.to[0], 'f', 'a foundation move exists in a "stuck" position');
            const trial = Engine.clone(s);
            const r = Engine.apply(trial, a);
            assert.equal(r.flips.length, 0, 'an uncovering move exists in a "stuck" position');
            assert.notEqual(r.transfers[0].from, 'waste', 'a waste card can be played in a "stuck" position');
          }
          assert.ok(!Engine.canAutoComplete(s));
        }
        const a = randomStep(s, rng);
        if (!a) break;
        Engine.apply(s, a);
      }
    }
    assert.ok(checked > 10000);
    assert.ok(stuckSeen > 20, 'the fuzz reaches stuck positions: ' + stuckSeen);
  });

  /**
   * Exhaustive check through the public API only: from `state`, can ANY sequence of legal actions
   * (draws included) ever uncover a card or play a card from the stock/waste?
   * true / false, or null when the space is larger than `cap` positions.
   */
  function progressReachable(state, cap) {
    const hidden = hiddenCount(state);
    const loose = looseCount(state);
    const start = Engine.clone(state);
    start.history = [];
    const key = (s) => JSON.stringify(s.piles);
    const seen = new Set([key(start)]);
    const stack = [start];
    while (stack.length) {
      if (seen.size > cap) return null;
      const s = stack.pop();
      for (const a of legalActions(s)) {
        const n = Engine.clone(s);
        assert.ok(Engine.apply(n, a));
        if (hiddenCount(n) < hidden || looseCount(n) < loose) return true;
        n.history = [];
        const k = key(n);
        if (!seen.has(k)) {
          seen.add(k);
          stack.push(n);
        }
      }
    }
    return false;
  }

  test('no false positives and no false leads: verified by exhaustive search on real dead ends', () => {
    let stuckVerified = 0;
    let deepVerified = 0;
    for (let seed = 1; seed <= 220 && (stuckVerified < 45 || deepVerified < 25); seed++) {
      for (const drawCount of [1, 3]) {
        const s = Engine.newGame({ seed, drawCount });
        for (let steps = 0; steps < 2000; steps++) {
          const hints = Engine.hints(s);
          if (!hints.length) break;
          if (hints[0].priority === 7 && deepVerified < 25) {
            // the last-resort hint claims real progress is reachable: it must be
            const reachable = progressReachable(s, 15000);
            assert.notEqual(reachable, false, 'last-resort hint leads nowhere: seed ' + seed + ' draw ' + drawCount);
            if (reachable) deepVerified++;
          }
          Engine.apply(s, hints[0].action);
        }
        if (!s.won && Engine.isStuck(s) && stuckVerified < 45) {
          const reachable = progressReachable(s, 15000);
          assert.notEqual(reachable, true, 'isStuck false positive: seed ' + seed + ' draw ' + drawCount);
          if (reachable === false) stuckVerified++;
        }
      }
    }
    assert.ok(stuckVerified >= 30, 'stuck positions verified: ' + stuckVerified);
    assert.ok(deepVerified >= 15, 'last-resort hints verified: ' + deepVerified);
  });
});

// ------------------------------------------------------------------------------------- auto-complete
describe('auto-complete', () => {
  test('canAutoComplete conditions', () => {
    // a face-down card in the tableau
    assert.equal(Engine.canAutoComplete(Engine.newGame({ seed: 1 })), false);
    const allUp = { f: { S: 13, H: 13, C: 10, D: 10 }, t: [['KC', 'QD', 'JC'], ['KD', 'QC', 'JD']] };
    // draw 1: fine with or without a stock
    assert.equal(Engine.canAutoComplete(build(allUp)), true);
    const withStock = { f: { S: 13, H: 13, C: 10, D: 9 }, t: [['KC', 'QD', 'JC'], ['KD', 'QC', 'JD']], stock: ['10D'] };
    assert.equal(Engine.canAutoComplete(build(withStock)), true);
    // once the game plays itself, hints are plain foundation moves again (no card is held back
    // for the 10 of diamonds that is still in the stock)
    assert.deepEqual(Engine.hints(build(withStock))[0], {
      action: move('JC', 'f2'),
      priority: 1,
      reason: 'Move the Jack of Clubs to its foundation',
    });
    assert.deepEqual(Engine.nextAutoAction(build(withStock)), move('JC', 'f2'));
    // draw 3: only with an empty stock and at most one waste card
    assert.equal(Engine.canAutoComplete(build(Object.assign({ drawCount: 3 }, allUp))), true);
    assert.equal(Engine.canAutoComplete(build(Object.assign({ drawCount: 3 }, withStock))), false);
    const oneWaste = { drawCount: 3, f: { S: 13, H: 13, C: 10, D: 9 }, t: [['KC', 'QD', 'JC'], ['KD', 'QC', 'JD']], waste: ['10D'] };
    assert.equal(Engine.canAutoComplete(build(oneWaste)), true);
    const twoWaste = { drawCount: 3, f: { S: 13, H: 13, C: 9, D: 9 }, t: [['KC', 'QD', 'JC'], ['KD', 'QC', 'JD']], waste: ['10D', '10C'] };
    assert.equal(Engine.canAutoComplete(build(twoWaste)), false);
    assert.equal(Engine.nextAutoAction(build(twoWaste)), null);
    // hidden card
    const hidden = build({ f: { S: 13, H: 13, C: 10, D: 10 }, t: [['-KC', 'QD', 'JC'], ['KD', 'QC', 'JD']] });
    assert.equal(Engine.canAutoComplete(hidden), false);
    assert.equal(Engine.nextAutoAction(hidden), null);
  });

  test('nextAutoAction plays the lowest available rank, draws when it must, and finishes', () => {
    const s = build({ f: { S: 13, H: 13, C: 2, D: 11 }, t: [['KD', 'QD'], ['KC', 'QC', 'JC', '10C', '9C', '8C', '7C', '6C', '5C', '4C', '3C']] });
    assert.deepEqual(Engine.nextAutoAction(s), move('3C', 'f2'), 'the 3 before the Queen');

    // needs draws and a recycle: QD on top of the waste hides the JD
    const g = build({ f: { S: 13, H: 13, C: 13, D: 10 }, t: [['KD']], waste: ['JD', 'QD'], score: 500 });
    assert.equal(Engine.canAutoComplete(g), true);
    const types = [];
    let guard = 0;
    for (let a = Engine.nextAutoAction(g); a; a = Engine.nextAutoAction(g)) {
      const r = Engine.apply(g, a, { auto: true });
      assert.ok(r);
      assert.equal(r.auto, true);
      assert.ok(r.scoreAfter >= r.scoreBefore, 'auto-complete never costs points');
      types.push(r.type);
      assert.ok(++guard < 50);
    }
    assert.deepEqual(types, ['recycle', 'draw', 'move', 'draw', 'move', 'move']);
    assert.equal(g.won, true);
    assert.equal(g.score, 530);
    assert.equal(g.history[0].auto, true);
  });

  test('repeatedly applying nextAutoAction always wins (fuzz over real games)', () => {
    let completed = 0;
    for (let seed = 1; seed <= 500 && completed < 60; seed++) {
      for (const drawCount of [1, 3]) {
        const s = Engine.newGame({ seed, drawCount });
        let steps = 0;
        while (!Engine.canAutoComplete(s) && steps < 2000) {
          const hints = Engine.hints(s);
          if (!hints.length) break;
          Engine.apply(s, hints[0].action);
          steps++;
        }
        if (!Engine.canAutoComplete(s)) {
          assert.equal(Engine.nextAutoAction(s), null);
          continue;
        }
        assert.equal(hiddenCount(s), 0);
        assert.equal(Engine.isStuck(s), false);
        const score = s.score;
        let guard = 0;
        for (let a = Engine.nextAutoAction(s); a; a = Engine.nextAutoAction(s)) {
          const r = Engine.apply(s, a, { auto: true });
          assert.ok(r, 'auto action is legal');
          assert.equal(r.auto, true);
          assert.ok(r.scoreAfter >= r.scoreBefore);
          assert.ok(++guard < 1500, 'auto-complete terminates');
        }
        assert.equal(s.won, true, 'seed ' + seed + ' draw ' + drawCount);
        assert.ok(s.score >= score);
        checkInvariants(s, 'auto-completed');
        completed++;
      }
    }
    assert.ok(completed >= 40, 'auto-completed games: ' + completed);
  });
});

// ------------------------------------------------------------------------------------- invariants
describe('random playouts', () => {
  test('invariants hold and records are exact after every action', () => {
    let actions = 0;
    let undos = 0;
    let recycles = 0;
    let reveals = 0;
    let wins = 0;
    for (let seed = 1; seed <= 90; seed++) {
      for (const drawCount of [1, 3]) {
        const s = Engine.newGame({ seed, drawCount, id: 'fuzz' });
        const rng = RNG.create(seed * 104729 + drawCount);
        checkInvariants(s, 'start');
        for (let step = 0; step < 300; step++) {
          const action = randomStep(s, rng);
          if (!action) break;
          const before = lite(s);
          const record = Engine.apply(s, action);
          assert.ok(record, 'a legal action applies');
          const label = 'seed ' + seed + ' draw ' + drawCount + ' step ' + step;
          if (record.type === 'undo') {
            undos++;
            assert.equal(s.undos, before.undos + 1);
            assert.equal(s.history.length, before.history.length - 1);
            assert.equal(record.undone, before.history[before.history.length - 1]);
            assert.equal(s.score, record.undone.scoreBefore);
            assert.equal(s.moves, record.undone.movesBefore);
            assert.equal(s.recycles, record.undone.recyclesBefore);
            assert.deepEqual([record.scoreBefore, record.scoreAfter], [before.score, s.score]);
            assert.deepEqual([record.movesBefore, record.movesAfter], [before.moves, s.moves]);
            // inverse transfers with the faces flipped back: draws and recycles in reverse order
            // (the cards went one at a time), a moved run bottom -> top again (it goes back as a block)
            const undoneOrder = record.undone.type === 'move' ? record.undone.transfers : record.undone.transfers.slice().reverse();
            assert.deepEqual(
              record.transfers,
              undoneOrder.map((t) => ({ card: t.card, from: t.to, to: t.from }))
            );
            assert.deepEqual(record.flips.map((f) => [f.card, f.faceUp]), record.undone.flips.slice().reverse().map((f) => [f.card, !f.faceUp]));
            for (const f of record.flips) assert.equal(s.faceUp[f.card], f.faceUp);
            assert.equal(record.won, false);
          } else {
            actions++;
            if (record.type === 'recycle') recycles++;
            reveals += record.flips.filter((f) => f.reveal).length;
            checkRecord(before, s, record, label);
            if (action.type === 'draw') assert.ok(record.type === 'draw' || record.type === 'recycle');
            else assert.equal(record.type, 'move');
          }
          checkInvariants(s, label);
          if (s.won) {
            wins++;
            break;
          }
        }
      }
    }
    assert.ok(actions > 20000, 'actions: ' + actions);
    assert.ok(undos > 1000, 'undos: ' + undos);
    assert.ok(recycles > 200, 'recycles: ' + recycles);
    assert.ok(reveals > 1000, 'reveals: ' + reveals);
    assert.ok(wins >= 0);
  });

  test('refused actions never mutate the state (random garbage against mid-game positions)', () => {
    const garbageTargets = ['stock', 'waste', 'f0', 'f1', 'f2', 'f3', 't0', 't1', 't2', 't3', 't4', 't5', 't6', 't9', '', null, 3];
    let refused = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const s = Engine.newGame({ seed, drawCount: seed % 2 ? 3 : 1 });
      const rng = RNG.create(seed + 555);
      for (let step = 0; step < 80; step++) {
        const before = fingerprint(s);
        const lastRecord = s.history[s.history.length - 1];
        for (let k = 0; k < 20; k++) {
          const action = { type: 'move', card: rng.int(56) - 2, to: garbageTargets[rng.int(garbageTargets.length)] };
          if (refCanDrop(s, action.card, action.to)) {
            assert.equal(Engine.canDrop(s, action.card, action.to), true);
            continue;
          }
          assert.equal(Engine.apply(s, action), null);
          assert.equal(Engine.apply(s, action, { auto: true }), null);
          refused++;
        }
        assert.equal(fingerprint(s), before, 'refused actions changed the state');
        assert.equal(s.history[s.history.length - 1], lastRecord);
        const a = randomStep(s, rng);
        if (!a) break;
        Engine.apply(s, a);
      }
    }
    assert.ok(refused > 20000);
  });
});

// =====================================================================================================
// REVIEWER'S BLACK-BOX SECTION
// Written by an independent reviewer from the build contract (sections 4 and 5) alone, without
// looking at how the engine works inside. Nothing here uses the helpers above: it has its own
// card notation, its own position builder (which does NOT go through deserialize) and its own
// naive statement of the rules, so that a mistake shared by the engine and the tests above
// cannot hide here.
// =====================================================================================================
describe('REVIEW (black box, from the contract alone)', () => {
  const E = Engine;
  const ALL = ['stock', 'waste', 'f0', 'f1', 'f2', 'f3', 't0', 't1', 't2', 't3', 't4', 't5', 't6'];
  const TAB = ALL.slice(6);
  const FND = ALL.slice(2, 6);
  const DRAW_A = { type: 'draw' };
  const UNDO_A = { type: 'undo' };
  const AUTO = { auto: true };

  // ---- cards: id('Q', 'H') or the short form c('QH') ----
  const SUIT_IX = { S: 0, H: 1, C: 2, D: 3 };
  const RANK_IX = { A: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10, J: 11, Q: 12, K: 13 };
  const c = (name) => {
    const suit = SUIT_IX[name[name.length - 1]];
    const rank = RANK_IX[name.slice(0, -1)];
    if (suit === undefined || rank === undefined) throw new Error('bad card ' + name);
    return suit * 13 + rank - 1;
  };
  const rk = (id) => (id % 13) + 1;
  const su = (id) => Math.floor(id / 13);
  const red = (id) => su(id) % 2 === 1;
  const mv = (card, to) => ({ type: 'move', card: typeof card === 'string' ? c(card) : card, to });

  /**
   * A hand-made position, straight from the contract's state shape (no engine call involved).
   *   t:     7 (or fewer) arrays of names bottom -> top; '?' in front = face-down
   *   f:     'S3 H1' style heights, e.g. { S: 3, H: 1 }
   *   waste, stock: names bottom -> top
   *   rest:  where every card not mentioned goes, face-down: 'stock' (under the listed ones, default)
   *          or a tableau pile id (under the listed ones)
   */
  function pos(spec) {
    const piles = {};
    for (const id of ALL) piles[id] = [];
    const faceUp = new Array(52).fill(false);
    const used = new Array(52).fill(false);
    const use = (id) => {
      if (used[id]) throw new Error('card listed twice: ' + id);
      used[id] = true;
      return id;
    };
    const f = spec.f || {};
    for (const letter of Object.keys(f)) {
      for (let r = 0; r < f[letter]; r++) {
        const id = use(SUIT_IX[letter] * 13 + r);
        piles['f' + SUIT_IX[letter]].push(id);
        faceUp[id] = true;
      }
    }
    (spec.t || []).forEach((col, i) => {
      for (const raw of col) {
        const down = raw[0] === '?';
        const id = use(c(down ? raw.slice(1) : raw));
        piles['t' + i].push(id);
        faceUp[id] = !down;
      }
    });
    for (const name of spec.waste || []) {
      const id = use(c(name));
      piles.waste.push(id);
      faceUp[id] = true;
    }
    const stock = (spec.stock || []).map((name) => use(c(name)));
    const rest = [];
    for (let id = 0; id < 52; id++) if (!used[id]) rest.push(id);
    const where = spec.rest || 'stock';
    if (where === 'stock') piles.stock = rest.concat(stock);
    else {
      piles.stock = stock;
      piles[where] = rest.concat(piles[where]);
    }
    return {
      v: 1,
      id: 'review',
      seed: 12345,
      drawCount: spec.drawCount || 1,
      piles,
      faceUp,
      score: spec.score || 0,
      moves: spec.moves || 0,
      undos: 0,
      recycles: spec.recycles || 0,
      elapsedMs: 0,
      won: false,
      history: [],
    };
  }

  const copy = (v) => JSON.parse(JSON.stringify(v));
  /** The whole observable state as one string (cheap to compare). */
  const print = (s) => JSON.stringify([s.v, s.id, s.seed, s.drawCount, s.piles, s.faceUp, s.score, s.moves, s.undos, s.recycles, s.elapsedMs, s.won, s.history]);
  /** ...without the history (records are compared separately where it matters). */
  const core = (s) => JSON.stringify([s.piles, s.faceUp, s.score, s.moves, s.recycles, s.won, s.history.length]);

  // ---- the rules, stated naively -----------------------------------------------------------------
  // D1 (engine decision the contract leaves open): once the game is won only undo is legal.
  function where(s, card) {
    for (const id of ALL) {
      const index = s.piles[id].indexOf(card);
      if (index >= 0) return { pile: id, index };
    }
    return null;
  }
  function runOf(s, card) {
    if (!Number.isInteger(card) || card < 0 || card > 51 || s.won) return [];
    const at = where(s, card);
    const pile = s.piles[at.pile];
    if (at.pile === 'stock') return [];
    if (at.pile === 'waste' || at.pile[0] === 'f') return at.index === pile.length - 1 ? [card] : [];
    return s.faceUp[card] === true ? pile.slice(at.index) : [];
  }
  function dropOk(s, card, to, run = runOf(s, card)) {
    if (run.length === 0 || !ALL.includes(to)) return false;
    if (s.piles[to].includes(card)) return false; // onto the pile it is already in
    const dest = s.piles[to];
    if (to[0] === 'f') {
      if (run.length !== 1 || to !== 'f' + su(card)) return false;
      return dest.length === 0 ? rk(card) === 1 : dest[dest.length - 1] === card - 1;
    }
    if (to[0] === 't') {
      if (dest.length === 0) return rk(card) === 13;
      const top = dest[dest.length - 1];
      return s.faceUp[top] === true && red(top) !== red(card) && rk(top) === rk(card) + 1;
    }
    return false; // stock, waste
  }
  /** Every legal move, enumerated source by source (the slow, obviously right dropOk() is the reference: see the query test). */
  function allMoves(s) {
    const out = [];
    if (s.won) return out;
    const sources = []; // [card, pile it is in, number of cards that move]
    const w = s.piles.waste;
    if (w.length) sources.push([w[w.length - 1], 'waste', 1]);
    for (const f of FND) {
      const p = s.piles[f];
      if (p.length) sources.push([p[p.length - 1], f, 1]);
    }
    for (const t of TAB) {
      const p = s.piles[t];
      for (let i = 0; i < p.length; i++) if (s.faceUp[p[i]] === true) sources.push([p[i], t, p.length - i]);
    }
    sources.sort((a, b) => a[0] - b[0]);
    for (const [card, from, n] of sources) {
      const home = 'f' + su(card);
      if (n === 1 && from !== home && s.piles[home].length === rk(card) - 1) out.push({ type: 'move', card, to: home });
      for (const t of TAB) {
        if (t === from) continue;
        const p = s.piles[t];
        if (p.length === 0) {
          if (rk(card) === 13) out.push({ type: 'move', card, to: t });
        } else {
          const top = p[p.length - 1];
          if (s.faceUp[top] === true && red(top) !== red(card) && rk(top) === rk(card) + 1) out.push({ type: 'move', card, to: t });
        }
      }
    }
    return out;
  }
  const drawOk = (s) => !s.won && (s.piles.stock.length > 0 || s.piles.waste.length > 0);

  /** The contract's invariants (section 5, last paragraph). */
  function sound(s, label) {
    const seen = new Set();
    for (const id of ALL) {
      assert.ok(Array.isArray(s.piles[id]), label + ': pile ' + id);
      for (const card of s.piles[id]) {
        assert.ok(Number.isInteger(card) && card >= 0 && card <= 51, label + ': card id');
        assert.ok(!seen.has(card), label + ': card ' + card + ' twice');
        seen.add(card);
      }
    }
    assert.equal(seen.size, 52, label + ': 52 unique cards');
    assert.deepEqual(Object.keys(s.piles).sort(), ALL.slice().sort(), label + ': pile ids');
    assert.equal(s.faceUp.length, 52, label);
    for (const card of s.piles.stock) assert.equal(s.faceUp[card], false, label + ': stock face-down');
    for (const card of s.piles.waste) assert.equal(s.faceUp[card], true, label + ': waste face-up');
    for (let k = 0; k < 4; k++) {
      s.piles['f' + k].forEach((card, i) => {
        assert.equal(card, k * 13 + i, label + ': foundation order');
        assert.equal(s.faceUp[card], true, label + ': foundation face-up');
      });
    }
    for (const id of TAB) {
      let up = false;
      for (const card of s.piles[id]) {
        if (s.faceUp[card]) up = true;
        else assert.ok(!up, label + ': face-down above face-up in ' + id);
      }
    }
    assert.ok(Number.isFinite(s.score) && s.score >= 0, label + ': score never below 0');
    assert.equal(s.won, FND.every((id) => s.piles[id].length === 13), label + ': won');
    assert.equal(E.isWon(s), s.won, label + ': isWon');
  }

  /**
   * THE REPLAY THE BOARD RELIES ON: starting from the piles and faces before an action, take each
   * transfer in order (remove the card from `from`, put it on top of `to`) and each flip
   * (faceUp[card] = flip.faceUp). The result must be exactly the piles and faces after it — for
   * draw, recycle and move records, and for undo records as well.
   */
  function replay(beforePiles, beforeFaces, record, label) {
    const piles = copy(beforePiles);
    const faces = beforeFaces.slice();
    for (const tr of record.transfers) {
      assert.deepEqual(Object.keys(tr).sort(), ['card', 'from', 'to'], label + ': transfer fields');
      const at = piles[tr.from].indexOf(tr.card);
      assert.ok(at >= 0, label + ': transfer of a card that is not in ' + tr.from);
      piles[tr.from].splice(at, 1);
      piles[tr.to].push(tr.card);
    }
    for (const fl of record.flips) {
      assert.notEqual(faces[fl.card], fl.faceUp, label + ': a flip that changes nothing');
      faces[fl.card] = fl.faceUp;
    }
    return { piles, faces };
  }
  function checkedApply(s, action, opts, label) {
    const beforePiles = copy(s.piles);
    const beforeFaces = s.faceUp.slice();
    const before = { score: s.score, moves: s.moves, recycles: s.recycles, undos: s.undos, history: s.history.length };
    const record = E.apply(s, action, opts);
    assert.ok(record, label + ': a legal action must apply: ' + JSON.stringify(action));
    const after = replay(beforePiles, beforeFaces, record, label);
    assert.deepEqual(after.piles, s.piles, label + ': transfers alone reproduce the piles (' + record.type + ')');
    assert.deepEqual(after.faces, s.faceUp, label + ': flips alone reproduce the faces (' + record.type + ')');
    assert.equal(record.scoreBefore, before.score, label + ': scoreBefore');
    assert.equal(record.scoreAfter, s.score, label + ': scoreAfter');
    assert.equal(record.movesBefore, before.moves, label + ': movesBefore');
    assert.equal(record.movesAfter, s.moves, label + ': movesAfter');
    assert.equal(record.won, s.won, label + ': record.won');
    if (record.type === 'undo') {
      assert.equal(s.undos, before.undos + 1, label + ': undo counts');
      assert.equal(s.history.length, before.history - 1, label + ': undo pops the history');
      assert.equal(record.won, false, label);
    } else {
      assert.equal(record.recyclesBefore, before.recycles, label + ': recyclesBefore');
      assert.equal(record.recyclesAfter, s.recycles, label + ': recyclesAfter');
      assert.equal(s.moves, before.moves + 1, label + ': every draw / recycle / move counts as one move');
      assert.equal(s.undos, before.undos, label);
      assert.equal(s.history.length, before.history + 1, label + ': pushed on the history');
      assert.deepEqual(s.history[s.history.length - 1], record, label + ': history stores the record');
    }
    return record;
  }

  /** Random legal action from the naive rules (and the engine must agree it is legal). */
  function randomAction(s, rng) {
    const moves = allMoves(s);
    const n = moves.length + (drawOk(s) ? 1 : 0);
    if (n === 0) return null;
    const pick = rng.int(n);
    return pick < moves.length ? moves[pick] : DRAW_A;
  }
  /**
   * A sensible player: mostly the engine's first hint, so that games go deep; sometimes random.
   * Once the hints have run dry for a game (a dead end) it plays on at random without asking
   * again: in a blocked game every question costs the engine a search.
   */
  const dry = new WeakSet();
  function smartAction(s, rng, randomness) {
    if (!dry.has(s) && rng.next() >= randomness) {
      const h = E.hints(s);
      if (h.length > 0) return h[0].action;
      dry.add(s);
    }
    return randomAction(s, rng);
  }

  // ================================================================================== RNG
  test('RNG: mulberry32 reference values, int range, shuffle', () => {
    const reference = (a) => () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (const seed of [0, 1, 2, 42, 123456789, 0xffffffff, 0x80000000]) {
      const want = reference(seed);
      const got = RNG.create(seed);
      assert.equal(got.seed, seed >>> 0);
      for (let i = 0; i < 200; i++) {
        const v = got.next();
        assert.equal(v, want(), 'seed ' + seed + ' value ' + i);
        assert.ok(v >= 0 && v < 1);
      }
    }
    // two published mulberry32 outputs (seed 1), so the reference itself cannot drift
    const one = RNG.create(1);
    assert.equal(Math.floor(one.next() * 4294967296), 2693262067);
    assert.equal(Math.floor(one.next() * 4294967296), 11749833);
    const r = RNG.create(99);
    const seenInt = new Set();
    for (let i = 0; i < 5000; i++) {
      const v = r.int(7);
      assert.ok(Number.isInteger(v) && v >= 0 && v < 7);
      seenInt.add(v);
    }
    assert.equal(seenInt.size, 7);
    assert.equal(RNG.create(5).int(1), 0);
    const a = Array.from({ length: 52 }, (_, i) => i);
    const b = a.slice();
    assert.equal(RNG.shuffle(a, RNG.create(7)), a, 'shuffles in place and returns the same array');
    RNG.shuffle(b, RNG.create(7));
    assert.deepEqual(a, b, 'deterministic');
    assert.deepEqual(a.slice().sort((x, y) => x - y), Array.from({ length: 52 }, (_, i) => i), 'a permutation');
    assert.notDeepEqual(a, Array.from({ length: 52 }, (_, i) => i));
    const other = RNG.shuffle(Array.from({ length: 52 }, (_, i) => i), RNG.create(8));
    assert.notDeepEqual(a, other);
    for (let i = 0; i < 50; i++) {
      const s = RNG.randomSeed();
      assert.ok(Number.isInteger(s) && s >= 0 && s <= 0xffffffff);
    }
  });

  // ================================================================================== card model
  test('card model, constants, helpers', () => {
    assert.deepEqual(Array.from(E.SUITS), ['spades', 'hearts', 'clubs', 'diamonds']);
    assert.deepEqual(Array.from(E.SUIT_SYMBOLS), ['♠', '♥', '♣', '♦']);
    assert.deepEqual(Array.from(E.RANK_LABELS), ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']);
    assert.deepEqual(Array.from(E.FOUNDATIONS), FND);
    assert.deepEqual(Array.from(E.TABLEAU), TAB);
    assert.deepEqual(Array.from(E.PILE_IDS).sort(), ALL.slice().sort());
    assert.equal(E.PILE_IDS.length, 13);
    for (let id = 0; id < 52; id++) {
      assert.equal(E.suitOf(id), Math.floor(id / 13));
      assert.equal(E.rankOf(id), (id % 13) + 1);
      assert.equal(E.isRed(id), Math.floor(id / 13) % 2 === 1);
      assert.equal(E.foundationFor(id), 'f' + Math.floor(id / 13));
      const info = E.cardInfo(id);
      assert.equal(info.id, id);
      assert.equal(info.suit, su(id));
      assert.equal(info.rank, rk(id));
      assert.equal(info.suitName, E.SUITS[su(id)]);
      assert.equal(info.symbol, E.SUIT_SYMBOLS[su(id)]);
      assert.equal(info.label, E.RANK_LABELS[rk(id) - 1]);
      assert.equal(info.color, red(id) ? 'red' : 'black');
    }
    assert.equal(E.cardInfo(0).name, 'Ace of Spades');
    assert.equal(E.cardInfo(c('QH')).name, 'Queen of Hearts');
    assert.equal(E.cardInfo(c('KD')).name, 'King of Diamonds');
    assert.equal(E.cardInfo(c('JC')).name, 'Jack of Clubs');
    assert.equal(E.cardInfo(c('10C')).name, '10 of Clubs');
    assert.equal(E.cardInfo(c('2S')).name, '2 of Spades');
    assert.equal(c('QH'), 24, 'the contract example: data-id 24 is the Queen of Hearts');
    assert.equal(E.pileKind('stock'), 'stock');
    assert.equal(E.pileKind('waste'), 'waste');
    for (const id of FND) assert.equal(E.pileKind(id), 'foundation');
    for (const id of TAB) assert.equal(E.pileKind(id), 'tableau');
    // the scoring table has exactly the contract's values (whatever the keys are called)
    const values = Object.values(E.SCORE);
    for (const v of [5, 10, -15, -100, -20, 0]) assert.ok(values.includes(v), 'SCORE holds ' + v);
  });

  test('timeBonus: 0 under 30 seconds, round(700000 / seconds) from there', () => {
    assert.equal(E.timeBonus(0), 0);
    assert.equal(E.timeBonus(29999), 0);
    assert.equal(E.timeBonus(30000), Math.round(700000 / 30));
    assert.equal(E.timeBonus(60000), Math.round(700000 / 60));
    assert.equal(E.timeBonus(100000), 7000);
    assert.equal(E.timeBonus(700000), 1000);
    assert.equal(E.timeBonus(3600000), Math.round(700000 / 3600));
    let last = Infinity;
    for (let ms = 30000; ms < 4000000; ms += 777) {
      const b = E.timeBonus(ms);
      assert.ok(Number.isInteger(b) && b >= 0 && b <= last, 'whole, never negative, never growing with time');
      last = b;
    }
  });

  // ================================================================================== deal
  test('deal: shape, faces, determinism, options', () => {
    for (let seed = 0; seed < 300; seed++) {
      const s = E.newGame({ seed, drawCount: seed % 2 ? 3 : 1 });
      sound(s, 'deal ' + seed);
      for (let col = 0; col < 7; col++) {
        const pile = s.piles['t' + col];
        assert.equal(pile.length, col + 1);
        pile.forEach((card, i) => assert.equal(s.faceUp[card], i === col, 'only the top card of a column is face-up'));
      }
      assert.equal(s.piles.stock.length, 24);
      assert.equal(s.piles.waste.length, 0);
      for (const id of FND) assert.equal(s.piles[id].length, 0);
      assert.deepEqual([s.v, s.seed, s.drawCount, s.score, s.moves, s.undos, s.recycles, s.elapsedMs, s.won], [1, seed, seed % 2 ? 3 : 1, 0, 0, 0, 0, 0, false]);
      assert.deepEqual(s.history, []);
      assert.deepEqual(Object.keys(s).sort(), ['drawCount', 'elapsedMs', 'faceUp', 'history', 'id', 'moves', 'piles', 'recycles', 'score', 'seed', 'undos', 'v', 'won']);
      assert.ok(typeof s.id === 'string' && s.id.length > 0);
      assert.deepEqual(copy(s), s, 'plain JSON');
    }
    const a = E.newGame({ seed: 77 });
    const b = E.newGame({ seed: 77, drawCount: 3 });
    assert.deepEqual(a.piles, b.piles, 'same seed, same deal, in both draw modes');
    assert.deepEqual(a.faceUp, b.faceUp);
    assert.notEqual(a.id, b.id, 'generated ids are unique');
    assert.notDeepEqual(E.newGame({ seed: 78 }).piles, a.piles);
    assert.equal(E.newGame({ seed: 1, id: 'mine' }).id, 'mine');
    assert.equal(E.newGame({ seed: 1 }).drawCount, 1, 'drawCount defaults to 1');
    const free = E.newGame({});
    assert.ok(Number.isInteger(free.seed) && free.seed >= 0 && free.seed <= 0xffffffff, 'a seed is chosen when none is given');
    assert.deepEqual(E.newGame({ seed: free.seed }).piles, free.piles, 'and the chosen seed reproduces the deal');
    // the deal comes from RNG.shuffle over 0..51 with RNG.create(seed): the multiset of cards per
    // "deal position" must be reproducible from the shuffled deck (either end first)
    const deck = RNG.shuffle(Array.from({ length: 52 }, (_, i) => i), RNG.create(77));
    const dealt = [];
    for (let r = 0; r < 7; r++) for (let col = r; col < 7; col++) dealt.push(a.piles['t' + col][r]);
    const fromEnd = deck.slice().reverse().slice(0, 28);
    const fromStart = deck.slice(0, 28);
    assert.ok(JSON.stringify(dealt) === JSON.stringify(fromEnd) || JSON.stringify(dealt) === JSON.stringify(fromStart), 'dealt row by row, one card per column, from the shuffled deck');
  });

  // ================================================================================== draw
  test('draw 1: one card, face-up, on top of the waste', () => {
    const s = E.newGame({ seed: 3 });
    const top = s.piles.stock[23];
    assert.equal(E.canDraw(s), true);
    const r = checkedApply(s, DRAW_A, undefined, 'draw');
    assert.equal(r.type, 'draw');
    assert.deepEqual(r.transfers, [{ card: top, from: 'stock', to: 'waste' }]);
    assert.deepEqual(r.flips, [{ card: top, faceUp: true }]);
    assert.deepEqual(s.piles.waste, [top]);
    assert.equal(s.piles.stock.length, 23);
    assert.equal(s.score, 0);
    assert.equal(r.auto, undefined);
    assert.equal(r.won, false);
  });

  test('draw 3: three cards one at a time; with 2 and with 1 card left it takes what is there', () => {
    const s = pos({ drawCount: 3, stock: ['2C', '3C', '4C', '5C', '6C', '7C', '8C', '9C'], rest: 't6', t: [['KS']] });
    assert.equal(s.piles.stock.length, 8);
    let r = checkedApply(s, DRAW_A, undefined, 'd3 a');
    assert.deepEqual(r.transfers.map((t) => t.card), [c('9C'), c('8C'), c('7C')], 'top of the stock first');
    assert.deepEqual(s.piles.waste, [c('9C'), c('8C'), c('7C')], 'the last card drawn ends on top');
    assert.deepEqual(r.flips, [c('9C'), c('8C'), c('7C')].map((card) => ({ card, faceUp: true })));
    r = checkedApply(s, DRAW_A, undefined, 'd3 b');
    assert.deepEqual(s.piles.waste.slice(-3), [c('6C'), c('5C'), c('4C')]);
    // two cards left
    r = checkedApply(s, DRAW_A, undefined, 'd3 c');
    assert.equal(r.type, 'draw');
    assert.deepEqual(r.transfers, [c('3C'), c('2C')].map((card) => ({ card, from: 'stock', to: 'waste' })));
    assert.deepEqual(r.flips, [c('3C'), c('2C')].map((card) => ({ card, faceUp: true })));
    assert.deepEqual(s.piles.stock, []);
    assert.equal(s.piles.waste[s.piles.waste.length - 1], c('2C'));
    assert.equal(s.moves, 3);

    // exactly one card left
    const one = pos({ drawCount: 3, stock: ['5H'], rest: 't6', t: [['KS']] });
    r = checkedApply(one, DRAW_A, undefined, 'd3 one');
    assert.deepEqual(r.transfers, [{ card: c('5H'), from: 'stock', to: 'waste' }]);
    assert.deepEqual(one.piles.waste, [c('5H')]);
    // and its undo puts exactly that back
    const u = checkedApply(one, UNDO_A, undefined, 'd3 one undo');
    assert.deepEqual(u.transfers, [{ card: c('5H'), from: 'waste', to: 'stock' }]);
    assert.deepEqual(one.piles.stock, [c('5H')]);
    assert.equal(one.faceUp[c('5H')], false);

    // undo of a 2-card draw
    const two = pos({ drawCount: 3, stock: ['5H', '6H'], rest: 't6', t: [['KS']] });
    const before = core(two);
    checkedApply(two, DRAW_A, undefined, 'd3 two');
    assert.deepEqual(two.piles.waste, [c('6H'), c('5H')]);
    checkedApply(two, UNDO_A, undefined, 'd3 two undo');
    assert.equal(core(two), before);
  });

  test('recycle: the waste goes back face-down, reversed, so the cards come out in the same order', () => {
    for (const drawCount of [1, 3]) {
      for (const n of [1, 2, 3, 4, 5, 7, 24]) {
        const names = ['AS', '2S', '3S', '4S', '5S', '6S', '7S', '8S', '9S', '10S', 'JS', 'QS', 'KS', 'AH', '2H', '3H', '4H', '5H', '6H', '7H', '8H', '9H', '10H', 'JH'].slice(0, n);
        const s = pos({ drawCount, stock: names, rest: 't6', t: [['KD']] });
        const firstPass = [];
        const firstRecords = [];
        while (s.piles.stock.length > 0) {
          const r = checkedApply(s, DRAW_A, undefined, 'pass 1');
          assert.equal(r.type, 'draw');
          firstRecords.push(r.transfers.map((t) => t.card));
          firstPass.push(s.piles.waste[s.piles.waste.length - 1]);
        }
        const wasteBefore = s.piles.waste.slice();
        const rec = checkedApply(s, DRAW_A, undefined, 'recycle');
        assert.equal(rec.type, 'recycle');
        assert.equal(rec.recyclesAfter, rec.recyclesBefore + 1);
        assert.equal(s.recycles, 1);
        assert.deepEqual(s.piles.waste, []);
        assert.deepEqual(s.piles.stock, wasteBefore.slice().reverse(), 'in reverse');
        assert.deepEqual(rec.transfers, wasteBefore.slice().reverse().map((card) => ({ card, from: 'waste', to: 'stock' })), 'top of the waste leaves first');
        assert.deepEqual(rec.flips.map((f) => f.card).sort((a, b) => a - b), wasteBefore.slice().sort((a, b) => a - b));
        for (const f of rec.flips) assert.deepEqual(f, { card: f.card, faceUp: false });
        const secondRecords = [];
        const secondPass = [];
        while (s.piles.stock.length > 0) {
          const r = checkedApply(s, DRAW_A, undefined, 'pass 2');
          secondRecords.push(r.transfers.map((t) => t.card));
          secondPass.push(s.piles.waste[s.piles.waste.length - 1]);
        }
        assert.deepEqual(secondRecords, firstRecords, 'the second pass draws exactly the same cards (' + drawCount + '/' + n + ')');
        assert.deepEqual(secondPass, firstPass);
        assert.deepEqual(s.piles.waste, wasteBefore);
      }
    }
    const empty = pos({ rest: 't6', t: [['KD']] });
    assert.equal(E.canDraw(empty), false);
    const before = print(empty);
    assert.equal(E.apply(empty, DRAW_A), null, 'stock and waste both empty: illegal');
    assert.equal(print(empty), before);
  });

  test('recycle scoring: draw 1 costs 100 every time; draw 3 costs 20 from the 4th pass; never below 0; free under auto', () => {
    const cycle = (s, opts) => {
      while (s.piles.stock.length > 0) checkedApply(s, DRAW_A, opts, 'cycle draw');
      return checkedApply(s, DRAW_A, opts, 'cycle recycle');
    };
    // draw 1
    let s = pos({ stock: ['2C', '3C', '4C'], rest: 't6', t: [['KD']], score: 250 });
    let r = cycle(s);
    assert.deepEqual([r.type, r.scoreBefore, r.scoreAfter, s.score, s.recycles], ['recycle', 250, 150, 150, 1]);
    r = cycle(s);
    assert.deepEqual([r.scoreBefore, r.scoreAfter, s.recycles], [150, 50, 2]);
    r = cycle(s);
    assert.deepEqual([r.scoreBefore, r.scoreAfter, s.score, s.recycles], [50, 0, 0, 3], 'clamped at 0');
    r = cycle(s);
    assert.deepEqual([r.scoreBefore, r.scoreAfter], [0, 0]);

    // draw 3: pass 1 is the deal's stock; recycle k starts pass k + 1
    s = pos({ drawCount: 3, stock: ['2C', '3C', '4C', '5C'], rest: 't6', t: [['KD']], score: 30 });
    r = cycle(s);
    assert.deepEqual([r.scoreAfter, s.recycles], [30, 1], 'starting pass 2 is free');
    r = cycle(s);
    assert.deepEqual([r.scoreAfter, s.recycles], [30, 2], 'starting pass 3 is free');
    r = cycle(s);
    assert.deepEqual([r.scoreBefore, r.scoreAfter, s.recycles], [30, 10, 3], 'starting pass 4 costs 20');
    r = cycle(s);
    assert.deepEqual([r.scoreBefore, r.scoreAfter, s.score, s.recycles], [10, 0, 0, 4], 'so does pass 5, clamped at 0');
    // the draws themselves never score
    s = pos({ drawCount: 3, stock: ['2C', '3C', '4C', '5C'], rest: 't6', t: [['KD']], score: 30 });
    checkedApply(s, DRAW_A, undefined, 'd');
    assert.equal(s.score, 30);

    // auto: free, flagged, still counted
    for (const drawCount of [1, 3]) {
      s = pos({ drawCount, stock: ['2C', '3C'], rest: 't6', t: [['KD']], score: 500, recycles: 7 });
      const d = checkedApply(s, DRAW_A, AUTO, 'auto draw');
      assert.equal(d.auto, true);
      r = cycle(s, AUTO);
      assert.equal(r.type, 'recycle');
      assert.equal(r.auto, true);
      assert.deepEqual([r.scoreBefore, r.scoreAfter, s.score], [500, 500, 500]);
      assert.equal(s.recycles, 8);
      // not auto: opts must be exactly { auto: true }
      const paid = cycle(s, { auto: 1 });
      assert.equal(paid.auto, undefined);
      assert.equal(s.score, drawCount === 1 ? 400 : 480);
    }
    // undo of a recycle gives the points and the pass back
    s = pos({ stock: ['2C', '3C'], rest: 't6', t: [['KD']], score: 130 });
    checkedApply(s, DRAW_A, undefined, 'x');
    checkedApply(s, DRAW_A, undefined, 'x');
    const before = core(s);
    r = checkedApply(s, DRAW_A, undefined, 'x');
    assert.equal(s.score, 30);
    const u = checkedApply(s, UNDO_A, undefined, 'undo recycle');
    assert.deepEqual([u.scoreBefore, u.scoreAfter, s.score, s.recycles, s.moves], [30, 130, 130, 0, 2]);
    assert.equal(u.undone, r);
    assert.equal(core(s), before);
  });

  // ================================================================================== move rules
  test('tableau rule: face-up top, opposite colour, exactly one rank higher', () => {
    const s = pos({
      t: [['8S'], ['7H'], ['7C'], ['9D'], ['6D'], ['?9H', '7D'], []],
      waste: ['6C'],
      rest: 'stock',
    });
    assert.equal(E.canDrop(s, c('7H'), 't0'), true, 'red 7 on black 8');
    assert.equal(E.canDrop(s, c('7D'), 't0'), true);
    assert.equal(E.canDrop(s, c('7C'), 't0'), false, 'same colour');
    assert.equal(E.canDrop(s, c('6D'), 't0'), false, 'two ranks lower');
    assert.equal(E.canDrop(s, c('9D'), 't0'), false, 'higher rank');
    assert.equal(E.canDrop(s, c('8S'), 't3'), true, 'black 8 on red 9');
    assert.equal(E.canDrop(s, c('8S'), 't0'), false, 'onto the pile it is already in');
    assert.equal(E.canDrop(s, c('6C'), 't1'), true, 'waste top onto red 7');
    assert.equal(E.canDrop(s, c('6C'), 't2'), false);
    assert.equal(E.canDrop(s, c('6C'), 't6'), false, 'only a King on an empty column');
    assert.deepEqual(E.legalTargets(s, c('6C')).slice().sort(), ['t1', 't5']);
    for (const bad of ['stock', 'waste']) {
      for (const card of [c('7H'), c('6C'), c('8S')]) assert.equal(E.canDrop(s, card, bad), false, 'nothing drops on ' + bad);
    }
    // a face-down top never takes a card (only possible in a hand-made position)
    const odd = pos({ t: [['?8S'], ['7H']], rest: 'stock' });
    assert.equal(E.canDrop(odd, c('7H'), 't0'), false);
    assert.equal(E.apply(odd, mv('7H', 't0')), null);
    // the move itself
    const r = checkedApply(s, mv('7H', 't0'), undefined, 'move');
    assert.equal(r.type, 'move');
    assert.deepEqual(r.transfers, [{ card: c('7H'), from: 't1', to: 't0' }]);
    assert.deepEqual(r.flips, []);
    assert.deepEqual(s.piles.t0, [c('8S'), c('7H')]);
    assert.deepEqual(s.piles.t1, []);
    assert.equal(s.score, 0, 'tableau -> tableau scores nothing');
  });

  test('runs: the card and everything above it move as one; only King runs go to an empty column', () => {
    const s = pos({
      t: [['?2C', '?3C', '9H', '8S', '7D', '6C'], ['10S'], [], ['KH', 'QS', 'JH'], ['?4C', 'KC'], ['10C']],
      rest: 'stock',
    });
    assert.deepEqual(E.getRun(s, c('9H')), [c('9H'), c('8S'), c('7D'), c('6C')]);
    assert.deepEqual(E.getRun(s, c('7D')), [c('7D'), c('6C')]);
    assert.deepEqual(E.getRun(s, c('6C')), [c('6C')]);
    assert.deepEqual(E.getRun(s, c('3C')), [], 'face-down: cannot be picked up');
    assert.equal(E.canPickup(s, c('3C')), false);
    assert.equal(E.canPickup(s, c('9H')), true);
    assert.equal(E.canDrop(s, c('9H'), 't2'), false, 'a 9 run cannot start an empty column');
    assert.equal(E.canDrop(s, c('8S'), 't2'), false);
    assert.equal(E.canDrop(s, c('KH'), 't2'), true, 'a King run can');
    assert.equal(E.canDrop(s, c('KC'), 't2'), true);
    assert.equal(E.canDrop(s, c('QS'), 't2'), false);
    assert.equal(E.canDrop(s, c('9H'), 't1'), true);
    assert.equal(E.canDrop(s, c('9H'), 't5'), true);
    assert.equal(E.canDrop(s, c('8S'), 't1'), false);
    assert.deepEqual(E.legalTargets(s, c('9H')).slice().sort(), ['t1', 't5']);
    const r = checkedApply(s, mv('9H', 't1'), undefined, 'run');
    assert.deepEqual(r.transfers, [c('9H'), c('8S'), c('7D'), c('6C')].map((card) => ({ card, from: 't0', to: 't1' })), 'bottom -> top');
    assert.deepEqual(s.piles.t1, [c('10S'), c('9H'), c('8S'), c('7D'), c('6C')]);
    assert.deepEqual(s.piles.t0, [c('2C'), c('3C')]);
    assert.deepEqual(r.flips, [{ card: c('3C'), faceUp: true, reveal: true }], 'the uncovered card turns in the same record');
    assert.equal(s.faceUp[c('3C')], true);
    assert.equal(s.faceUp[c('2C')], false, 'only the new top card turns');
    assert.equal(s.score, 5);
    // King run to the empty column, uncovering nothing (it leaves an empty column behind)
    const k = checkedApply(s, mv('KH', 't2'), undefined, 'king run');
    assert.deepEqual(k.transfers.map((t) => t.card), [c('KH'), c('QS'), c('JH')]);
    assert.deepEqual(k.flips, []);
    assert.deepEqual(s.piles.t3, []);
    assert.deepEqual(s.piles.t2, [c('KH'), c('QS'), c('JH')]);
    assert.equal(s.score, 5);
  });

  test('foundation rule: single cards, ace first, same suit ascending, own foundation only', () => {
    const s = pos({
      f: { S: 2, H: 0, C: 5 },
      t: [['3S'], ['AH'], ['4S'], ['6C', '5H'], ['2H'], ['6D', '3D'], ['4H']],
      waste: ['AD'],
      rest: 'stock',
    });
    assert.equal(E.canDrop(s, c('3S'), 'f0'), true);
    assert.equal(E.canDrop(s, c('4S'), 'f0'), false, 'skips a rank');
    assert.equal(E.canDrop(s, c('AH'), 'f1'), true, 'ace on its empty foundation');
    assert.equal(E.canDrop(s, c('2H'), 'f1'), false, 'no ace yet');
    assert.equal(E.canDrop(s, c('AD'), 'f3'), true, 'waste top');
    for (const other of ['f0', 'f1', 'f2']) assert.equal(E.canDrop(s, c('AD'), other), false, 'never on another suit\'s foundation: ' + other);
    for (const other of ['f1', 'f2', 'f3']) assert.equal(E.canDrop(s, c('3S'), other), false);
    assert.equal(E.canDrop(s, c('6C'), 'f2'), false, 'a card with cards on it is a run of two');
    assert.equal(E.canDrop(s, c('3D'), 'f3'), false);
    assert.deepEqual(E.legalTargets(s, c('3S')).slice().sort(), ['f0', 't6']);
    for (const bad of [mv('4S', 'f0'), mv('2H', 'f1'), mv('AD', 'f0'), mv('6C', 'f2'), mv('AH', 'f3')]) {
      const before = print(s);
      assert.equal(E.apply(s, bad), null);
      assert.equal(print(s), before);
    }
    let r = checkedApply(s, mv('3S', 'f0'), undefined, 't->f');
    assert.deepEqual(r.transfers, [{ card: c('3S'), from: 't0', to: 'f0' }]);
    assert.equal(s.score, 10);
    r = checkedApply(s, mv('4S', 'f0'), undefined, 't->f');
    assert.equal(s.score, 20);
    r = checkedApply(s, mv('AD', 'f3'), undefined, 'w->f');
    assert.deepEqual(r.transfers, [{ card: c('AD'), from: 'waste', to: 'f3' }]);
    assert.equal(s.score, 30);
    assert.deepEqual(s.piles.f0, [0, 1, 2, 3]);
    sound(s, 'after foundation moves');
  });

  test('what may be picked up: waste top, foundation top, face-up tableau cards — nothing else', () => {
    const s = pos({
      f: { S: 3 },
      t: [['?9D', '8C', '7H'], ['4H']],
      waste: ['JD', 'QD'],
      stock: ['5D', '6D'],
      rest: 't6',
    });
    assert.equal(E.canPickup(s, c('QD')), true, 'waste top');
    assert.equal(E.canPickup(s, c('JD')), false, 'buried in the waste');
    assert.equal(E.canPickup(s, c('6D')), false, 'stock');
    assert.equal(E.canPickup(s, c('3S')), true, 'foundation top');
    assert.equal(E.canPickup(s, c('2S')), false, 'buried in a foundation');
    assert.equal(E.canPickup(s, c('8C')), true);
    assert.equal(E.canPickup(s, c('7H')), true);
    assert.equal(E.canPickup(s, c('9D')), false, 'face-down');
    assert.deepEqual(E.getRun(s, c('QD')), [c('QD')]);
    assert.deepEqual(E.getRun(s, c('3S')), [c('3S')]);
    assert.deepEqual(E.getRun(s, c('JD')), []);
    assert.deepEqual(E.getRun(s, c('6D')), []);
    assert.deepEqual(E.getRun(s, c('2S')), []);
    assert.deepEqual(E.legalTargets(s, c('JD')), []);
    assert.equal(E.canDrop(s, c('JD'), 't1'), false);
    for (const junk of [-1, 52, 1.5, NaN, '3', null, undefined, {}, []]) {
      assert.equal(E.canPickup(s, junk), false);
      assert.deepEqual(E.getRun(s, junk), []);
      assert.deepEqual(E.legalTargets(s, junk), []);
      assert.equal(E.canDrop(s, junk, 't1'), false);
      assert.equal(E.bestTarget(s, junk), null);
    }
    assert.deepEqual(E.locate(s, c('7H')), { pile: 't0', index: 2 });
    assert.deepEqual(E.locate(s, c('9D')), { pile: 't0', index: 0 });
    assert.deepEqual(E.locate(s, c('QD')), { pile: 'waste', index: 1 });
    assert.deepEqual(E.locate(s, c('2S')), { pile: 'f0', index: 1 });
    assert.equal(E.topCard(s, 'waste'), c('QD'));
    assert.equal(E.topCard(s, 'stock'), c('6D'));
    assert.equal(E.topCard(s, 'f0'), c('3S'));
    assert.equal(E.topCard(s, 'f1'), null);
    assert.equal(E.topCard(s, 't0'), c('7H'));
    assert.equal(E.topCard(s, 't3'), null);
    assert.equal(E.isFaceUp(s, c('7H')), true);
    assert.equal(E.isFaceUp(s, c('9D')), false);
    assert.equal(E.canUndo(s), false);
    assert.equal(E.isWon(s), false);
  });

  test('a foundation top card may come back to the tableau', () => {
    const t = pos({ f: { S: 3, D: 13 }, t: [['4H'], ['5C'], [], ['KS']], rest: 'stock', score: 40 });
    assert.equal(E.canDrop(t, c('3S'), 't0'), true);
    assert.equal(E.canDrop(t, c('3S'), 't1'), false);
    assert.equal(E.canDrop(t, c('2S'), 't0'), false, 'only the top card');
    assert.equal(E.canDrop(t, c('KD'), 't2'), true, 'a King from a foundation may start an empty column');
    assert.equal(E.canDrop(t, c('KD'), 'f3'), false);
    assert.equal(E.canDrop(t, c('3S'), 'f0'), false, 'not onto the pile it is in');
    const r = checkedApply(t, mv('3S', 't0'), undefined, 'f->t');
    assert.deepEqual(r.transfers, [{ card: c('3S'), from: 'f0', to: 't0' }]);
    assert.deepEqual(r.flips, []);
    assert.deepEqual([r.scoreBefore, r.scoreAfter], [40, 25]);
    assert.deepEqual(t.piles.f0, [0, 1]);
    const again = checkedApply(t, mv('3S', 'f0'), undefined, 't->f');
    assert.equal(again.scoreAfter, 35);
    // clamped at 0
    const low = pos({ f: { S: 3 }, t: [['4H']], rest: 'stock', score: 10 });
    const lr = checkedApply(low, mv('3S', 't0'), undefined, 'f->t low');
    assert.deepEqual([lr.scoreBefore, lr.scoreAfter, low.score], [10, 0, 0]);
    const u = checkedApply(low, UNDO_A, undefined, 'undo f->t');
    assert.deepEqual([u.scoreBefore, u.scoreAfter, low.score], [0, 10, 10], 'undo restores the exact score, not score + 15');
  });

  test('scoring table, row by row', () => {
    const base = () =>
      pos({
        f: { S: 2, H: 1 },
        t: [['?9C', '3S'], ['?9D', '8C'], ['4D'], ['9H'], ['10S', '2H'], ['KC'], ['3D']],
        waste: ['QD', '3C'],
        rest: 'stock',
        score: 100,
      });
    const delta = (action, opts) => {
      const s = base();
      const r = checkedApply(s, action, opts, 'score');
      return [r.scoreAfter - r.scoreBefore, s.score - 100, r.flips.length];
    };
    assert.deepEqual(delta(mv('3C', 't2')), [5, 5, 0], 'waste -> tableau +5');
    const w = base();
    checkedApply(w, mv('3C', 't2'), undefined, 'w');
    checkedApply(w, mv('2H', 'f1'), undefined, 'w');
    assert.equal(w.score, 115, 'tableau -> foundation +10 (nothing uncovered: the 10 of spades was face-up)');
    assert.deepEqual(delta(mv('2H', 'f1')), [10, 10, 0], 'tableau -> foundation +10');
    assert.deepEqual(delta(mv('3S', 'f0')), [15, 15, 1], 'tableau -> foundation +10, and +5 for the card it uncovers');
    assert.deepEqual(delta(mv('8C', 't3')), [5, 5, 1], 'tableau -> tableau 0, +5 for the card it uncovers');
    assert.deepEqual(delta(mv('3S', 't2')), [5, 5, 1]);
    assert.deepEqual(delta(mv('2H', 't0')), [0, 0, 0], 'tableau -> tableau 0');
    assert.deepEqual(delta(mv('2S', 't6')), [-15, -15, 0], 'foundation -> tableau -15');
    const f = pos({ f: { S: 2, H: 1 }, waste: ['3S'], t: [['4H']], rest: 'stock', score: 7 });
    const r = checkedApply(f, mv('3S', 'f0'), undefined, 'w->f');
    assert.equal(r.scoreAfter - r.scoreBefore, 10, 'waste -> foundation +10');
    // every draw / recycle / move counts one move
    const m = base();
    checkedApply(m, mv('3C', 't2'), undefined, 'm');
    checkedApply(m, DRAW_A, undefined, 'm');
    checkedApply(m, mv('3S', 'f0'), undefined, 'm');
    assert.equal(m.moves, 3);
    assert.equal(m.history.length, 3);
  });

  test('reveal: the flip is part of the move record, and of its undo', () => {
    const s = pos({ t: [['?2C', '?3C', '9H', '8S'], ['10S'], ['?5D', 'AS']], rest: 'stock', score: 50 });
    const before = print(s);
    const r = checkedApply(s, mv('9H', 't1'), undefined, 'reveal');
    assert.deepEqual(r.flips, [{ card: c('3C'), faceUp: true, reveal: true }]);
    assert.equal(r.scoreAfter, 55);
    const u = checkedApply(s, UNDO_A, undefined, 'undo reveal');
    assert.equal(u.type, 'undo');
    assert.equal(u.undone, r);
    assert.equal(u.flips.length, 1);
    assert.equal(u.flips[0].card, c('3C'));
    assert.equal(u.flips[0].faceUp, false, 'the undo turns the card back down');
    assert.equal(s.faceUp[c('3C')], false);
    assert.deepEqual(s.piles.t0, [c('2C'), c('3C'), c('9H'), c('8S')], 'the run is back in its original order');
    assert.deepEqual(u.transfers.map((t) => [t.from, t.to]), [['t1', 't0'], ['t1', 't0']]);
    assert.deepEqual(u.transfers.map((t) => t.card).sort(), [c('9H'), c('8S')].sort());
    assert.deepEqual([u.scoreBefore, u.scoreAfter, u.movesBefore, u.movesAfter, u.won], [55, 50, 1, 0, false]);
    s.undos = 0;
    assert.equal(print(s), before);
    // a foundation move that uncovers
    const r2 = checkedApply(s, mv('AS', 'f0'), undefined, 'reveal 2');
    assert.deepEqual(r2.flips, [{ card: c('5D'), faceUp: true, reveal: true }]);
    assert.equal(r2.scoreAfter - r2.scoreBefore, 15);
    // moving the last card of a column, or uncovering a face-up card, flips nothing
    const t = pos({ t: [['9H', '8S'], ['10S'], ['9D']], rest: 'stock' });
    assert.deepEqual(checkedApply(t, mv('8S', 't2'), undefined, 'no reveal').flips, []);
    assert.deepEqual(checkedApply(t, mv('9H', 't1'), undefined, 'no reveal').flips, []);
  });

  test('winning, and undo after a win', () => {
    const s = pos({ f: { S: 13, H: 13, C: 13, D: 11 }, t: [['KD'], ['QD']], score: 300 });
    assert.equal(s.piles.stock.length, 0);
    assert.equal(E.isWon(s), false);
    let r = checkedApply(s, mv('QD', 'f3'), undefined, 'almost');
    assert.equal(r.won, false);
    assert.equal(s.won, false);
    r = checkedApply(s, mv('KD', 'f3'), undefined, 'win');
    assert.equal(r.won, true);
    assert.equal(s.won, true);
    assert.equal(E.isWon(s), true);
    assert.equal(E.isStuck(s), false, 'a won game is not stuck');
    assert.equal(E.canAutoComplete(s), false);
    assert.equal(E.nextAutoAction(s), null);
    assert.deepEqual(E.hints(s), []);
    assert.equal(E.canDraw(s), false);
    assert.equal(E.canUndo(s), true);
    const u = checkedApply(s, UNDO_A, undefined, 'undo win');
    assert.equal(u.won, false);
    assert.equal(s.won, false, 'undo clears won');
    assert.equal(E.isWon(s), false);
    assert.deepEqual(s.piles.t0, [c('KD')]);
    assert.equal(s.score, 310);
    r = checkedApply(s, mv('KD', 'f3'), undefined, 'win again');
    assert.equal(s.won, true);
    assert.equal(s.score, 320);
  });

  // ================================================================================== undo
  test('undo: illegal on an empty history; exact inverse of each kind of record', () => {
    const fresh = E.newGame({ seed: 9 });
    const before = print(fresh);
    assert.equal(E.apply(fresh, UNDO_A), null);
    assert.equal(print(fresh), before);

    // a run of three with a reveal, undone: the transfers of the undo alone must rebuild the column
    const s = pos({ t: [['?AC', '9H', '8S', '7D'], ['10S']], rest: 'stock' });
    const start = print(s);
    const m = checkedApply(s, mv('9H', 't1'), undefined, 'run');
    const u = checkedApply(s, UNDO_A, undefined, 'undo run');
    assert.deepEqual(Object.keys(u).sort().filter((k) => !/^recycles/.test(k)), ['flips', 'movesAfter', 'movesBefore', 'scoreAfter', 'scoreBefore', 'transfers', 'type', 'undone', 'won']);
    assert.equal(u.undone, m);
    assert.deepEqual(u.transfers, [c('9H'), c('8S'), c('7D')].map((card) => ({ card, from: 't1', to: 't0' })), 'the run comes back as a block, bottom -> top, so that replaying the transfers rebuilds the column');
    assert.deepEqual(u.flips, [{ card: c('AC'), faceUp: false, reveal: true }]);
    assert.equal(s.history.length, 0, 'an undo is not pushed on the history');
    assert.equal(s.undos, 1);
    assert.equal(E.canUndo(s), false);
    s.undos = 0;
    assert.equal(print(s), start);

    // draw 3 undone
    const d = E.newGame({ seed: 4, drawCount: 3 });
    const dStart = print(d);
    const dr = checkedApply(d, DRAW_A, undefined, 'draw3');
    const du = checkedApply(d, UNDO_A, undefined, 'undo draw3');
    assert.deepEqual(du.transfers, dr.transfers.slice().reverse().map((t) => ({ card: t.card, from: 'waste', to: 'stock' })), 'inverse, in reverse order');
    assert.deepEqual(du.flips.map((f) => [f.card, f.faceUp]).sort(), dr.flips.map((f) => [f.card, false]).sort());
    d.undos = 0;
    assert.equal(print(d), dStart);
  });

  test('undo exactness: long random playouts on 320 seeds in both draw modes, undone one step at a time', () => {
    let actions = 0;
    let kinds = { draw: 0, recycle: 0, move: 0 };
    for (let seed = 1000; seed < 1320; seed++) {
      for (const drawCount of [1, 3]) {
        const s = E.newGame({ seed, drawCount, id: 'u' + seed });
        const rng = RNG.create(seed * 31 + drawCount);
        const prints = [];
        const randomness = seed % 4 === 0 ? 1 : 0.35; // every 4th game is purely random
        const target = 100 + (seed % 5) * 50;
        for (let i = 0; i < target; i++) {
          const action = smartAction(s, rng, randomness);
          if (!action) break;
          prints.push(core(s));
          const r = E.apply(s, action);
          assert.ok(r, 'seed ' + seed + ': legal action refused ' + JSON.stringify(action));
          kinds[r.type]++;
          if (s.won) break;
        }
        const n = s.history.length;
        actions += n;
        assert.equal(s.moves, n);
        for (let i = n - 1; i >= 0; i--) {
          const u = E.apply(s, UNDO_A);
          assert.ok(u && u.type === 'undo', 'undo ' + i);
          assert.equal(core(s), prints[i], 'seed ' + seed + ' draw ' + drawCount + ' step ' + i);
          assert.equal(s.undos, n - i);
        }
        const fresh = E.newGame({ seed, drawCount, id: 'u' + seed });
        fresh.undos = n;
        assert.equal(print(s), print(fresh), 'back at the deal, minus undos');
        assert.equal(E.apply(s, UNDO_A), null);
      }
    }
    assert.ok(actions > 50000, 'enough actions were undone: ' + actions);
    assert.ok(kinds.recycle > 400 && kinds.move > 10000 && kinds.draw > 10000, JSON.stringify(kinds));
  });

  // ================================================================================== records
  test('record completeness: transfers + flips alone reproduce every state, undo included (playouts with interleaved undos)', () => {
    const stats = { draw: 0, recycle: 0, move: 0, undo: 0, runUndo: 0, reveals: 0, revealUndo: 0, wins: 0 };
    for (let seed = 1; seed <= 180; seed++) {
      const drawCount = seed % 2 ? 1 : 3;
      const s = E.newGame({ seed, drawCount });
      const rng = RNG.create(seed ^ 0x5bd1e995);
      for (let i = 0; i < 260 && !s.won; i++) {
        let action;
        if (s.history.length > 0 && rng.next() < 0.12) action = UNDO_A;
        else action = smartAction(s, rng, 0.3);
        if (!action) {
          if (!s.history.length) break;
          action = UNDO_A;
        }
        const r = checkedApply(s, action, undefined, 'seed ' + seed + ' step ' + i);
        stats[r.type]++;
        if (r.type === 'undo') {
          if (r.undone.type === 'move' && r.undone.transfers.length > 1) stats.runUndo++;
          if (r.flips.some((f) => f.reveal)) stats.revealUndo++;
          // the undo is the inverse of what it undoes: same cards, opposite direction, opposite faces
          assert.deepEqual(r.transfers.map((t) => t.card).sort(), r.undone.transfers.map((t) => t.card).sort());
          for (const t of r.transfers) assert.deepEqual([t.from, t.to], [r.undone.transfers[0].to, r.undone.transfers[0].from]);
          assert.deepEqual(r.flips.map((f) => [f.card, f.faceUp]).sort(), r.undone.flips.map((f) => [f.card, !f.faceUp]).sort());
          assert.equal(r.scoreAfter, r.undone.scoreBefore);
          assert.equal(r.movesAfter, r.undone.movesBefore);
          assert.equal(s.recycles, r.undone.recyclesBefore);
        } else {
          assert.ok(['draw', 'recycle', 'move'].includes(r.type));
          for (const f of r.flips) {
            if (f.reveal !== undefined) {
              assert.equal(f.reveal, true);
              assert.equal(r.type, 'move');
              assert.equal(f.faceUp, true);
              stats.reveals++;
            }
          }
          if (r.type === 'move') {
            assert.ok(r.flips.length <= 1);
            if (r.flips.length) assert.equal(r.flips[0].reveal, true, 'a move only ever flips the card it uncovers');
          }
          assert.equal(r.auto, undefined);
        }
        sound(s, 'seed ' + seed + ' step ' + i);
        if (s.won) stats.wins++;
      }
    }
    if (process.env.REVIEW_STATS) console.log(stats);
    for (const k of Object.keys(stats)) assert.ok(stats[k] > (k === 'wins' ? 5 : 100), k + ': ' + stats[k]);
  });

  // ================================================================================== illegal input
  test('apply returns null and changes nothing for anything illegal', () => {
    const positions = [];
    for (let seed = 1; seed <= 12; seed++) {
      const s = E.newGame({ seed, drawCount: seed % 2 ? 1 : 3 });
      const rng = RNG.create(seed);
      for (let i = 0; i < 25 * seed; i++) {
        const a = smartAction(s, rng, 0.4);
        if (!a) break;
        E.apply(s, a);
      }
      positions.push(s);
    }
    const junkActions = [
      null, undefined, 0, 1, 'draw', 'undo', [], {}, { type: null }, { type: 'DRAW' }, { type: 'recycle' }, { type: 'move' },
      { type: 'move', card: 0 }, { type: 'move', to: 't0' }, { type: 'move', card: '5', to: 't0' }, { type: 'move', card: -1, to: 't0' },
      { type: 'move', card: 52, to: 't0' }, { type: 'move', card: 2.5, to: 't0' }, { type: 'move', card: NaN, to: 't0' },
      { type: 'move', card: null, to: 't0' }, { type: 'move', card: [3], to: 't0' }, { type: 'move', card: {}, to: 't0' },
      { type: 'redo' }, { type: 'deal' }, { type: ['draw'] }, { type: 'move', card: 3, to: ['t0'] },
    ];
    const junkPiles = ['', 't7', 't-1', 'f4', 'T0', 't', 'f', 'tableau', 'foundation', 'stock', 'waste', 't00', ' t0', 't0 ', '__proto__', 'constructor', 'toString', 'hasOwnProperty', null, undefined, 0, 3, {}, [], true];
    let refused = 0;
    for (const s of positions) {
      const before = print(s);
      for (const a of junkActions) {
        assert.equal(E.apply(s, a), null, JSON.stringify(a));
        assert.equal(E.apply(s, a, AUTO), null);
        refused++;
      }
      for (let card = 0; card < 52; card++) {
        for (const to of junkPiles) {
          assert.equal(E.canDrop(s, card, to), false);
          assert.equal(E.apply(s, { type: 'move', card, to }), null, card + ' -> ' + String(to));
          refused++;
        }
        for (const to of ALL) {
          const legal = dropOk(s, card, to);
          assert.equal(E.canDrop(s, card, to), legal, 'canDrop ' + card + ' -> ' + to);
          if (!legal) {
            assert.equal(E.apply(s, { type: 'move', card, to }), null, 'illegal move ' + card + ' -> ' + to);
            refused++;
          }
        }
      }
      assert.equal(print(s), before, 'nothing changed');
      assert.equal(E.pileKind('t7'), E.pileKind('nope'));
    }
    assert.ok(refused > 5000);
    assert.equal(E.apply(null, DRAW_A), null);
    assert.equal(E.apply(undefined, DRAW_A), null);
  });

  // ================================================================================== queries vs rules
  test('canPickup / getRun / canDrop / legalTargets / canDraw / bestTarget agree with the naive rules in every position of 50 playouts', () => {
    let checked = 0;
    let best = { foundation: 0, tableau: 0, empty: 0, none: 0 };
    for (let seed = 1; seed <= 50; seed++) {
      const s = E.newGame({ seed: seed * 17, drawCount: seed % 3 ? 1 : 3 });
      const rng = RNG.create(seed + 4242);
      for (let i = 0; i < 180; i++) {
        const fast = allMoves(s).map((m) => m.card + '>' + m.to);
        const slow = [];
        for (let card = 0; card < 52; card++) {
          const run = runOf(s, card);
          assert.equal(E.canPickup(s, card), run.length > 0, 'canPickup ' + card);
          assert.deepEqual(E.getRun(s, card), run, 'getRun ' + card);
          const targets = ALL.filter((to) => dropOk(s, card, to, run));
          for (const to of targets) slow.push(card + '>' + to);
          assert.deepEqual(E.legalTargets(s, card).slice().sort(), targets.slice().sort(), 'legalTargets ' + card);
          for (const to of ALL) assert.equal(E.canDrop(s, card, to), targets.includes(to));
          assert.deepEqual(E.locate(s, card), where(s, card));
          assert.equal(E.isFaceUp(s, card), s.faceUp[card]);

          // bestTarget, restated from the contract
          let want = null;
          const at = where(s, card);
          if (run.length > 0 && at.pile[0] !== 'f') {
            const home = 'f' + su(card);
            if (run.length === 1 && targets.includes(home)) want = home;
            if (want === null) want = TAB.find((t) => s.piles[t].length > 0 && targets.includes(t)) || null;
            if (want === null && !(rk(card) === 13 && at.pile[0] === 't' && at.index === 0)) {
              want = TAB.find((t) => s.piles[t].length === 0 && targets.includes(t)) || null;
            }
          }
          const got = E.bestTarget(s, card);
          assert.equal(got, want, 'bestTarget of ' + card + ' at seed ' + seed + ' step ' + i);
          if (got !== null) {
            assert.ok(targets.includes(got), 'bestTarget must be legal');
            best[got[0] === 'f' ? 'foundation' : s.piles[got].length ? 'tableau' : 'empty']++;
          } else best.none++;
          checked++;
        }
        for (const id of ALL) {
          const pile = s.piles[id];
          assert.equal(E.topCard(s, id), pile.length ? pile[pile.length - 1] : null);
        }
        assert.deepEqual(fast.sort(), slow.sort(), 'the two naive move generators of this file agree');
        // legalMoves (an extra of this engine): exactly the legal moves, each once
        const listed = E.legalMoves(s);
        for (const m of listed) assert.deepEqual(Object.keys(m).sort(), ['card', 'to', 'type']);
        assert.deepEqual(listed.map((m) => m.type + m.card + '>' + m.to).sort(), slow.map((m) => 'move' + m).sort(), 'legalMoves');
        assert.equal(E.canDraw(s), drawOk(s));
        assert.equal(E.canUndo(s), s.history.length > 0);
        const a = smartAction(s, rng, 0.35);
        if (!a || s.won) break;
        assert.ok(E.apply(s, a));
      }
    }
    assert.ok(checked > 150000, String(checked));
    assert.ok(best.foundation > 300 && best.tableau > 300 && best.empty > 10, JSON.stringify(best));
  });

  test('bestTarget: the contract cases by hand', () => {
    const s = pos({
      f: { S: 1 },
      t: [['KH', 'QS'], [], ['3H'], ['?5C', 'KD'], ['3D', '2S'], ['?6C', 'KC', 'QH'], []],
      waste: ['2C'],
      rest: 'stock',
    });
    assert.equal(E.bestTarget(s, c('2S')), 'f0', 'alone and legal on its foundation');
    assert.equal(E.bestTarget(s, c('2C')), 't2', 'leftmost legal non-empty column');
    assert.equal(E.bestTarget(s, c('KD')), 't1', 'a King that is not at the bottom goes to the leftmost empty column');
    assert.equal(E.bestTarget(s, c('KH')), null, 'a King run already at index 0 does not hop');
    assert.equal(E.bestTarget(s, c('KC')), 't1');
    assert.equal(E.bestTarget(s, c('QS')), 't3', 'onto the red King');
    assert.equal(E.bestTarget(s, c('QH')), null, 'nowhere to go');
    assert.equal(E.bestTarget(s, c('AS')), null, 'a card on a foundation');
    assert.equal(E.bestTarget(s, c('5C')), null, 'face-down');
    assert.equal(E.bestTarget(s, c('3D')), null, 'a run of two never goes to a foundation, and no column takes a 3 here');
    const k = pos({ t: [[], ['QD']], waste: ['KS'], rest: 'stock' });
    assert.equal(E.bestTarget(k, c('KS')), 't0', 'a King from the waste takes the leftmost empty column');
    const run = pos({ f: { S: 1 }, t: [['2S', 'AH'], ['3D']], rest: 'stock' });
    assert.equal(E.bestTarget(run, c('2S')), 't1', 'not alone: the tableau, even though the foundation would take the card itself');
    assert.equal(E.bestTarget(run, c('AH')), 'f1');
  });

  // ================================================================================== clone / serialize
  test('clone is a deep copy', () => {
    const s = E.newGame({ seed: 11, drawCount: 3 });
    const rng = RNG.create(11);
    for (let i = 0; i < 80; i++) {
      const a = smartAction(s, rng, 0.3);
      if (!a) break;
      E.apply(s, a);
    }
    const before = print(s);
    const k = E.clone(s);
    assert.notEqual(k, s);
    assert.equal(print(k), before);
    assert.deepEqual(k, s);
    assert.notEqual(k.piles, s.piles);
    for (const id of ALL) assert.notEqual(k.piles[id], s.piles[id]);
    assert.notEqual(k.faceUp, s.faceUp);
    assert.notEqual(k.history, s.history);
    // wreck the copy in every way a caller could
    for (const id of ALL) k.piles[id].length = 0;
    k.faceUp.fill(true);
    k.score = -1;
    k.moves = -1;
    for (const r of k.history) {
      r.type = 'x';
      r.scoreBefore = -1;
      r.transfers.push({ card: 0, from: 'stock', to: 'waste' });
      r.transfers[0].card = 99;
      r.transfers[0].to = 'nowhere';
      r.flips.push({ card: 1, faceUp: true });
      if (r.flips.length > 1) r.flips[0].faceUp = 'x';
    }
    k.history.length = 1;
    assert.equal(print(s), before, 'the original is untouched, history records included');
    assert.ok(s.history.length > 20);
    // playing on a copy does not touch the original, and vice versa
    const k2 = E.clone(s);
    for (let i = 0; i < 40; i++) {
      const a = smartAction(k2, rng, 0.5);
      if (!a) break;
      E.apply(k2, a);
    }
    while (E.apply(k2, UNDO_A));
    assert.equal(print(s), before);
    const k3 = E.clone(s);
    while (E.apply(s, UNDO_A));
    s.undos = 0;
    assert.equal(print(s), print(E.newGame({ seed: 11, drawCount: 3, id: s.id })));
    assert.equal(print(k3), before, 'undoing the original does not touch the copy');
  });

  test('serialize / deserialize round trip (every 9th position of 40 playouts, and won games)', () => {
    let wins = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const s = E.newGame({ seed: seed * 101, drawCount: seed % 2 ? 3 : 1 });
      const rng = RNG.create(seed);
      for (let i = 0; i < 400 && !s.won; i++) {
        if (i % 9 === 0) {
          const text = E.serialize(s);
          assert.equal(typeof text, 'string');
          const back = E.deserialize(text);
          assert.ok(back, 'seed ' + seed + ' step ' + i + ' must load');
          assert.equal(E.serialize(back), text);
          if (i % 45 === 0) assert.deepEqual(back, copy(s));
          // and it plays on exactly like the original
          const a = smartAction(E.clone(s), RNG.create(i), 0.3);
          if (a) assert.deepEqual(E.apply(back, a), E.apply(E.clone(s), a));
          if (s.history.length) {
            const again = E.deserialize(text);
            assert.deepEqual(E.apply(again, UNDO_A), copy(E.apply(E.clone(s), UNDO_A)));
          }
        }
        const a = s.history.length && rng.next() < 0.05 ? UNDO_A : smartAction(s, rng, 0.15);
        if (!a) break;
        E.apply(s, a);
      }
      s.elapsedMs = 61234.5; // the controller owns it; the engine only carries it
      const back = E.deserialize(E.serialize(s));
      assert.deepEqual(back, copy(s));
      if (s.won) {
        wins++;
        assert.equal(back.won, true);
        assert.ok(E.apply(back, UNDO_A), 'a loaded won game can still be undone');
        assert.equal(back.won, false);
      }
    }
    assert.ok(wins >= 4, 'some won games were round-tripped: ' + wins);
  });

  test('deserialize: null (never a throw) on garbage of every kind', () => {
    const tryLoad = (v, label) => {
      let out;
      assert.doesNotThrow(() => {
        out = E.deserialize(v);
      }, label);
      return out;
    };
    // things that are not saved games at all
    const junk = [
      undefined, null, 0, 1, -1, 3.5, NaN, Infinity, true, false, '', ' ', 'null', 'undefined', '0', '42', '"text"', 'true', '[]', '{}', '[1,2,3]',
      '{"v":1}', '{"piles":{}}', 'not json', '{', '}', '[', '{"v":1,', '\u0000', '{"__proto__":{"v":1}}', {}, [], () => {}, Symbol('x'),
      new Date(), /re/, 12345678901234567890n, '{"v":1,"piles":null}', '{"v":1,"piles":[]}', '{"v":1,"piles":{"stock":null}}',
      '[' .repeat(5000) + ']'.repeat(5000), '{"a":'.repeat(3000) + '1' + '}'.repeat(3000),
    ];
    for (const v of junk) assert.equal(tryLoad(v, String(typeof v)), null, 'junk: ' + String(typeof v === 'string' ? v.slice(0, 40) : typeof v));

    const s = E.newGame({ seed: 2024, drawCount: 3 });
    const rng = RNG.create(1);
    for (let i = 0; i < 60; i++) E.apply(s, smartAction(s, rng, 0.3) || DRAW_A);
    const good = E.serialize(s);
    assert.ok(E.deserialize(good), 'the base save loads');
    // a state object instead of a string is not a string: null or a state, but never a throw
    tryLoad(s, 'state object');

    // every truncation of a real save
    for (let cut = 0; cut < good.length; cut++) {
      assert.equal(tryLoad(good.slice(0, cut), 'cut at ' + cut), null, 'truncated at ' + cut);
    }
    // text around it
    assert.equal(tryLoad(good + '}', 'trailing'), null);
    assert.equal(tryLoad('x' + good, 'leading'), null);
    assert.equal(tryLoad('[' + good + ']', 'wrapped'), null);
    assert.equal(tryLoad(JSON.stringify(good), 'double encoded'), null);

    // structured damage
    const damage = (fn, label) => {
      const o = JSON.parse(good);
      fn(o);
      assert.equal(tryLoad(JSON.stringify(o), label), null, label);
    };
    const fields = ['v', 'id', 'seed', 'drawCount', 'piles', 'faceUp', 'score', 'moves', 'undos', 'recycles', 'elapsedMs', 'won', 'history'];
    for (const f of fields) {
      damage((o) => delete o[f], 'missing ' + f);
      for (const bad of [null, 'x', -1, 1.5, [], {}, true, 1e400]) {
        const o = JSON.parse(good);
        if (JSON.stringify(o[f]) === JSON.stringify(bad)) continue;
        if (f === 'id' && bad === 'x') continue; // any non-empty string is an id
        if (f === 'won' && bad === true) continue; // covered below
        if (f === 'elapsedMs' && bad === 1.5) continue; // a legitimate time
        if (f === 'history' && Array.isArray(bad)) continue; // an empty history is a (trimmed) history
        if (f === 'drawCount' && bad === true) continue;
        o[f] = bad;
        const text = JSON.stringify(o);
        assert.equal(tryLoad(text, f + '=' + JSON.stringify(bad)), null, f + ' = ' + JSON.stringify(bad));
      }
    }
    damage((o) => (o.v = 2), 'other version');
    damage((o) => (o.drawCount = 2), 'drawCount 2');
    damage((o) => (o.drawCount = '3'), 'drawCount string');
    damage((o) => (o.won = true), 'won without 52 cards home');
    damage((o) => (o.seed = -5), 'negative seed');
    damage((o) => (o.seed = 2 ** 32), 'seed too large');
    damage((o) => (o.seed = 0.5), 'fractional seed');
    // cards
    damage((o) => o.piles.stock.push(o.piles.stock[0]), 'duplicated card (53 cards)');
    damage((o) => (o.piles.stock[0] = o.piles.stock[1]), 'duplicated card (52 ids, one twice)');
    damage((o) => (o.piles.t6[0] = o.piles.t5[0]), 'duplicate across piles');
    damage((o) => o.piles.stock.pop(), '51 cards');
    damage((o) => o.piles.t6.shift(), '51 cards');
    damage((o) => (o.piles.stock[0] = 52), 'card 52');
    damage((o) => (o.piles.stock[0] = -1), 'card -1');
    damage((o) => (o.piles.stock[0] = 1.5), 'card 1.5');
    damage((o) => (o.piles.stock[0] = String(o.piles.stock[0])), 'card as string');
    damage((o) => (o.piles.stock[0] = null), 'card null');
    damage((o) => (o.piles.stock[0] = [o.piles.stock[0]]), 'card as array');
    // piles
    for (const id of ALL) {
      damage((o) => delete o.piles[id], 'no ' + id);
      damage((o) => (o.piles[id] = null), id + ' null');
      damage((o) => (o.piles[id] = {}), id + ' object');
      damage((o) => (o.piles[id] = 'x'), id + ' string');
      damage((o) => (o.piles[id] = 7), id + ' number');
    }
    damage((o) => (o.piles.t7 = []), 'unknown pile t7');
    damage((o) => (o.piles.f4 = []), 'unknown pile f4');
    damage((o) => (o.piles.extra = []), 'unknown pile');
    damage((o) => {
      o.piles.t7 = o.piles.t6;
      delete o.piles.t6;
    }, 'renamed pile');
    // faces
    damage((o) => o.faceUp.pop(), 'faceUp length 51');
    damage((o) => o.faceUp.push(false), 'faceUp length 53');
    damage((o) => (o.faceUp = []), 'faceUp empty');
    damage((o) => (o.faceUp[5] = 1), 'faceUp number');
    damage((o) => (o.faceUp[5] = null), 'faceUp null');
    damage((o) => (o.faceUp[5] = 'true'), 'faceUp string');
    damage((o) => (o.faceUp = Object.assign({}, o.faceUp)), 'faceUp object');
    // numbers must be finite numbers
    for (const f of ['score', 'moves', 'undos', 'recycles', 'elapsedMs', 'seed']) {
      const o = JSON.parse(good);
      for (const raw of ['1e999', '-1e999', '"12"', 'null', '[1]', '{}']) {
        const text = JSON.stringify(o).replace(new RegExp('"' + f + '":[^,}]+'), '"' + f + '":' + raw);
        assert.notEqual(text, JSON.stringify(o));
        assert.equal(tryLoad(text, f + ' ' + raw), null, f + ' = ' + raw);
      }
    }
    // random byte damage: never a throw, and whatever loads is a sound state that still plays and undoes
    const dmg = RNG.create(77);
    let loaded = 0;
    for (let i = 0; i < 4000; i++) {
      const at = dmg.int(good.length);
      const n = 1 + dmg.int(3);
      const mode = dmg.int(3);
      const text = mode === 0 ? good.slice(0, at) + good.slice(at + n) : mode === 1 ? good.slice(0, at) + String.fromCharCode(32 + dmg.int(95)) + good.slice(at + 1) : good.slice(0, at) + good.slice(at, at + n) + good.slice(at);
      const out = tryLoad(text, 'damage ' + i);
      if (out) {
        loaded++;
        sound(out, 'damaged save ' + i);
        assert.ok([1, 3].includes(out.drawCount));
        const k = E.clone(out);
        let guard = 0;
        while (E.apply(k, UNDO_A)) {
          sound(k, 'damaged save undo');
          assert.ok(guard++ < 1000);
        }
        for (let j = 0; j < 30; j++) {
          const a = randomAction(out, dmg);
          if (!a) break;
          assert.ok(E.apply(out, a), 'a loaded state plays by the rules');
          sound(out, 'damaged save play');
        }
      }
    }
    assert.ok(loaded < 4000);
  });

  // ================================================================================== auto-complete
  test('canAutoComplete: the contract conditions', () => {
    const allUp = { f: { S: 9, H: 9, C: 9, D: 9 }, t: [['KS', 'QH', 'JS', '10H'], ['KH', 'QS', 'JH', '10S'], ['KC', 'QD', 'JC', '10D'], ['KD', 'QC', 'JD', '10C']] };
    assert.equal(E.canAutoComplete(pos(allUp)), true);
    assert.equal(E.canAutoComplete(pos(Object.assign({}, allUp, { drawCount: 3 }))), true);
    // a face-down tableau card
    const hidden = { f: { S: 9, H: 9, C: 9, D: 9 }, t: [['?KS', 'QH', 'JS', '10H'], ['KH', 'QS', 'JH', '10S'], ['KC', 'QD', 'JC', '10D'], ['KD', 'QC', 'JD', '10C']] };
    assert.equal(E.canAutoComplete(pos(hidden)), false);
    assert.equal(E.nextAutoAction(pos(hidden)), null);
    // stock / waste left
    const loose = (drawCount, stock, waste) =>
      pos({ drawCount, stock, waste, f: { S: 9, H: 9, C: 9, D: 9 }, t: [['KS', 'QH', 'JS'], ['KH', 'QS', 'JH'], ['KC', 'QD', 'JC'], ['KD', 'QC', 'JD']], rest: 'stock' });
    assert.equal(E.canAutoComplete(loose(1, ['10S', '10H'], ['10C', '10D'])), true, 'draw 1: stock and waste may hold cards');
    assert.equal(E.canAutoComplete(loose(3, [], ['10S'])), false, 'draw 3: three tens are still in the stock (rest)');
    const mk = (drawCount, stock, waste) =>
      pos({ drawCount, stock, waste, f: { S: 10, H: 10, C: 9, D: 9 }, t: [['KS', 'QH', 'JS'], ['KH', 'QS', 'JH'], ['KC', 'QD', 'JC'], ['KD', 'QC', 'JD']] });
    assert.equal(E.canAutoComplete(mk(3, [], ['10C', '10D'])), false, 'draw 3: two waste cards');
    assert.equal(E.canAutoComplete(mk(3, ['10C'], ['10D'])), false, 'draw 3: a stock card');
    assert.equal(E.canAutoComplete(mk(3, ['10C', '10D'], [])), false);
    assert.equal(E.canAutoComplete(mk(1, [], ['10C', '10D'])), true);
    assert.equal(E.canAutoComplete(mk(1, ['10C', '10D'], [])), true);
    const single = pos({ drawCount: 3, waste: ['10D'], f: { S: 10, H: 10, C: 10, D: 9 }, t: [['KS', 'QH', 'JS'], ['KH', 'QS', 'JH'], ['KC', 'QD', 'JC'], ['KD', 'QC', 'JD']] });
    assert.equal(E.canAutoComplete(single), true, 'draw 3: an empty stock and one waste card is fine');
    assert.equal(E.canAutoComplete(E.newGame({ seed: 1 })), false);
  });

  test('nextAutoAction: lowest rank first, draws when it must, records are auto, and it ends in a win', () => {
    const s = pos({
      stock: ['10C', '9S'],
      waste: ['9D', '10D'],
      f: { S: 8, H: 9, C: 9, D: 8 },
      t: [['KS', 'QH', 'JS', '10H'], ['KH', 'QS', 'JH', '10S'], ['KC', 'QD', 'JC'], ['KD', 'QC', 'JD']],
      score: 200,
    });
    assert.equal(E.canAutoComplete(s), true);
    assert.deepEqual(E.nextAutoAction(s), { type: 'move', card: c('10H'), to: 'f1' }, 'the only card that can go home');
    const low = pos({
      waste: ['9D'],
      f: { S: 8, H: 9, C: 9, D: 8 },
      t: [['KS', 'QH', 'JS', '10H'], ['KH', 'QS', 'JH', '10S', '9S'], ['KC', 'QD', 'JC', '10C'], ['KD', 'QC', 'JD', '10D']],
    });
    const first = E.nextAutoAction(low);
    assert.equal(first.type, 'move');
    assert.equal(rk(first.card), 9, 'a 9 before the 10s');
    let steps = 0;
    let recycles = 0;
    while (!s.won) {
      const a = E.nextAutoAction(s);
      assert.ok(a, 'never gives up before the win');
      assert.ok(a.type === 'draw' || a.to[0] === 'f', 'only draws and foundation moves');
      const r = checkedApply(s, a, AUTO, 'auto ' + steps);
      assert.equal(r.auto, true);
      if (r.type === 'recycle') {
        recycles++;
        assert.equal(r.scoreAfter, r.scoreBefore, 'a recycle is free under auto');
      }
      assert.ok(++steps < 500);
    }
    assert.ok(recycles >= 1, 'this position needs a second pass through the stock');
    assert.equal(E.nextAutoAction(s), null);
    assert.equal(s.score, 200 + 10 * 18);
  });

  test('auto-complete from the canAutoComplete positions met in 400 playouts always wins', () => {
    let reached = 0;
    let fromStates = 0;
    let withStock = 0;
    for (let seed = 1; seed <= 200; seed++) {
      for (const drawCount of [1, 3]) {
        const s = E.newGame({ seed: seed * 7 + 3, drawCount });
        const rng = RNG.create(seed * 13 + drawCount);
        let seen = false;
        let inGame = 0;
        for (let i = 0; i < 600 && !s.won; i++) {
          const can = E.canAutoComplete(s);
          // (run the whole completion from the first eight such positions of a game, then from every fourth)
          if (can && (++inGame <= 8 || inGame % 4 === 0)) {
            // the contract condition, restated
            assert.equal(TAB.every((id) => s.piles[id].every((card) => s.faceUp[card])), true);
            assert.ok(drawCount === 1 || (s.piles.stock.length === 0 && s.piles.waste.length <= 1));
            fromStates++;
            if (!seen) reached++;
            seen = true;
            if (s.piles.stock.length + s.piles.waste.length > 0) withStock++;
            const k = E.clone(s);
            const startScore = k.score;
            const home = FND.reduce((n, id) => n + k.piles[id].length, 0);
            let steps = 0;
            while (!k.won) {
              const a = E.nextAutoAction(k);
              assert.ok(a, 'seed ' + seed + ': nextAutoAction gave up before the win');
              const r = E.apply(k, a, AUTO);
              assert.ok(r, 'seed ' + seed + ': nextAutoAction proposed an illegal action');
              assert.equal(r.auto, true);
              assert.ok(r.type !== 'move' || r.transfers[0].to[0] === 'f');
              assert.ok(++steps < 2000, 'seed ' + seed + ': auto-complete does not terminate');
            }
            assert.equal(k.score, startScore + 10 * (52 - home), 'auto-complete scores 10 per card and pays nothing for recycles');
            sound(k, 'auto-completed');
            if (fromStates % 25 === 1) {
              const text = E.serialize(k);
              const back = E.deserialize(text);
              assert.ok(back, 'an auto-completed game loads again');
              assert.equal(E.serialize(back), text);
            }
          } else if (!can) {
            assert.equal(E.nextAutoAction(s), null, 'null unless canAutoComplete');
            const noHidden = TAB.every((id) => s.piles[id].every((card) => s.faceUp[card]));
            const reachable = drawCount === 1 || (s.piles.stock.length === 0 && s.piles.waste.length <= 1);
            assert.ok(!(noHidden && reachable), 'seed ' + seed + ': canAutoComplete is false although the contract condition holds');
          }
          const a = smartAction(s, rng, 0.1);
          if (!a) break;
          E.apply(s, a);
        }
      }
    }
    if (process.env.REVIEW_STATS) console.log({ reached, fromStates, withStock });
    assert.ok(reached >= 60, 'games that reached auto-complete: ' + reached);
    assert.ok(fromStates >= 400, String(fromStates));
    assert.ok(withStock >= 30, 'some with stock/waste cards left: ' + withStock);
  });

  // ================================================================================== hints
  /** Is this hinted action a King hopping from the bottom of a column to an empty column? */
  function pointlessKing(s, action) {
    if (action.type !== 'move' || rk(action.card) !== 13) return false;
    const at = where(s, action.card);
    return at.pile[0] === 't' && at.index === 0 && action.to[0] === 't' && s.piles[action.to].length === 0;
  }

  test('hints: shape, order, legality, and no pointless King shuffle, in every position of 200 playouts', () => {
    let total = 0;
    const byPriority = {};
    for (let seed = 1; seed <= 100; seed++) {
      for (const drawCount of [1, 3]) {
        const s = E.newGame({ seed: seed * 3 + 1, drawCount });
        const rng = RNG.create(seed * 29 + drawCount);
        let dead = 0;
        for (let i = 0; i < 300; i++) {
          const before = core(s);
          const hs = E.hints(s);
          assert.equal(core(s), before, 'hints never mutates');
          assert.ok(Array.isArray(hs));
          if (s.won) {
            assert.deepEqual(hs, []);
            break;
          }
          let last = -Infinity;
          const seenActions = new Set();
          for (const h of hs) {
            assert.deepEqual(Object.keys(h).sort(), ['action', 'priority', 'reason']);
            assert.ok(typeof h.priority === 'number' && h.priority >= 1);
            assert.ok(h.priority >= last, 'best first');
            last = h.priority;
            assert.ok(typeof h.reason === 'string' && h.reason.length > 0);
            const a = h.action;
            if (a.type === 'draw') {
              assert.deepEqual(a, { type: 'draw' });
              assert.ok(drawOk(s), 'a draw hint needs something to draw');
            } else {
              assert.deepEqual(Object.keys(a).sort(), ['card', 'to', 'type']);
              assert.equal(a.type, 'move');
              assert.ok(dropOk(s, a.card, a.to), 'seed ' + seed + ' step ' + i + ': illegal hint ' + JSON.stringify(h));
              assert.ok(!pointlessKing(s, a), 'seed ' + seed + ' step ' + i + ': pointless King hop hinted ' + JSON.stringify(h));
            }
            const key = JSON.stringify(a);
            assert.ok(!seenActions.has(key), 'the same action is not hinted twice');
            seenActions.add(key);
            byPriority[h.priority] = (byPriority[h.priority] || 0) + 1;
            total++;
            // every hinted action applies
            assert.ok(E.apply(E.clone(s), a), 'hinted action applies');
          }
          // the contract kinds: a legal foundation move, or a move that uncovers a card, is always worth a hint
          const moves = allMoves(s);
          const toFoundation = moves.filter((m) => m.to[0] === 'f');
          const uncovering = moves.filter((m) => {
            const at = where(s, m.card);
            return at.pile[0] === 't' && at.index > 0 && !s.faceUp[s.piles[at.pile][at.index - 1]];
          });
          if (toFoundation.length || uncovering.length) assert.ok(hs.length > 0, 'seed ' + seed + ' step ' + i + ': a useful move exists but there is no hint');
          for (const m of toFoundation) {
            assert.ok(hs.some((h) => h.action.type === 'move' && h.action.card === m.card && h.action.to === m.to), 'seed ' + seed + ' step ' + i + ': foundation move not hinted');
          }
          // a blocked game is only worth a few more looks (each costs the engine a search)
          if (hs.length === 0 && ++dead > 3) break;
          const a = smartAction(s, rng, 0.3);
          if (!a) break;
          E.apply(s, a);
        }
      }
    }
    if (process.env.REVIEW_STATS) console.log({ total, byPriority });
    assert.ok(total > 25000, String(total));
    for (const p of [1, 2, 3, 4, 5, 6]) assert.ok(byPriority[p] > 20, 'priority ' + p + ' seen: ' + byPriority[p]);
  });

  test('hints: the contract kinds by hand', () => {
    const first = (s) => E.hints(s)[0];
    // 1 foundation beats everything
    let s = pos({ f: { S: 1 }, t: [['?9C', '2S'], ['?8D', '7C'], ['8H']], waste: ['6D'], rest: 'stock' });
    assert.deepEqual(first(s).action, mv('2S', 'f0'));
    assert.equal(first(s).priority, 1);
    // 2 uncover a face-down card
    s = pos({ t: [['?9C', '7C'], ['8H'], ['?3D', 'KS']], rest: 'stock' });
    assert.deepEqual(first(s).action, mv('7C', 't1'));
    assert.equal(first(s).priority, 2);
    // 3 King to an empty column when that uncovers a card
    s = pos({ t: [['?9C', 'KH'], [], ['QD']], rest: 'stock' });
    assert.deepEqual(first(s).action, mv('KH', 't1'));
    assert.equal(first(s).priority, 3);
    // 3 empty a column when a King is waiting for one
    s = pos({ t: [['7C'], ['8H'], ['?3D', 'KS'], ['2C'], ['4C'], ['6C'], ['10C']], rest: 'stock' });
    const h3 = E.hints(s).find((h) => h.priority === 3);
    assert.deepEqual(h3 && h3.action, mv('7C', 't1'));
    // 4 waste to tableau
    s = pos({ t: [['8H'], ['KS']], waste: ['7C'], stock: [], rest: 't6' });
    assert.ok(E.hints(s).some((h) => h.priority === 4 && JSON.stringify(h.action) === JSON.stringify(mv('7C', 't0'))));
    // 6 draw when the stock holds something playable; not when it holds nothing useful
    s = pos({ t: [['8H'], ['KS']], stock: ['7C'], rest: 't6' });
    assert.deepEqual(E.hints(s).map((h) => h.action), [DRAW_A]);
    assert.equal(E.hints(s)[0].priority, 6);
    s = pos({ t: [['8H'], ['KS']], stock: ['2D'], rest: 't6' });
    assert.deepEqual(E.hints(s), []);
    // never: a King from the bottom of a column to another empty column
    s = pos({ t: [['KH', 'QS'], [], ['KD']], rest: 't6' });
    for (const h of E.hints(s)) assert.ok(!pointlessKing(s, h.action));
    assert.ok(!E.hints(s).some((h) => h.action.type === 'move' && (h.action.card === c('KH') || h.action.card === c('KD'))));
    // never: a run going back and forth between two equivalent columns
    s = pos({ t: [['9H', '8S'], ['9D']], rest: 't6' });
    assert.ok(!E.hints(s).some((h) => h.action.type === 'move' && h.action.card === c('8S')), 'moving the 8 from one red 9 to the other changes nothing');
    const a = E.clone(s);
    E.apply(a, mv('8S', 't1'));
    assert.ok(!E.hints(a).some((h) => h.action.type === 'move' && h.action.card === c('8S')));
  });

  test('hints: a card that was just taken back from its foundation can still be hinted home (regression)', () => {
    // Found by the playouts above: after the 2 of diamonds was taken back from its foundation, the
    // engine could not tell within its search budget whether that leads anywhere and returned no
    // hint at all — although a card could go to a foundation.
    const s = pos({
      drawCount: 3,
      f: { S: 3, H: 4, C: 2, D: 2 },
      t: [
        ['8C', '7D'],
        ['KC', 'QH', 'JS', '10D', '9C', '8H', '7C', '6D', '5S'],
        ['KH', 'QC', 'JH'],
        ['?KD', '?8D', '7S', '6H', '5C', '4D', '3C'],
        [],
        ['10C'],
        ['?4C', '?9S', '?KS', '?9H', '?5H', '?6C', 'JD', '10S', '9D', '8S', '7H', '6S', '5D', '4S', '3D'],
      ],
      waste: ['10H', 'QS'],
      stock: ['JC', 'QD'],
    });
    sound(s, 'regression position');
    assert.equal(s.piles.stock.length, 2, 'all 52 cards are placed by hand');
    checkedApply(s, mv('2D', 't3'), undefined, 'take back');
    assert.ok(dropOk(s, c('2D'), 'f3'));
    const hs = E.hints(s);
    assert.ok(hs.some((h) => h.action.type === 'move' && h.action.card === c('2D') && h.action.to === 'f3'), 'the foundation move is among the hints: ' + JSON.stringify(hs));
    assert.equal(E.isStuck(s), false);
  });

  test('hints: following the first hint never goes round in circles (600 games)', () => {
    let wins = 0;
    let dead = 0;
    for (let seed = 1; seed <= 300; seed++) {
      for (const drawCount of [1, 3]) {
        const s = E.newGame({ seed: seed + 50000, drawCount });
        const seen = new Map();
        let steps = 0;
        for (;;) {
          const hs = E.hints(s);
          if (!hs.length) break;
          assert.ok(E.apply(s, hs[0].action), 'first hint applies');
          const key = JSON.stringify([s.piles, s.faceUp]);
          const times = (seen.get(key) || 0) + 1;
          seen.set(key, times);
          assert.ok(times <= 3, 'seed ' + seed + ' draw ' + drawCount + ': the same position came up ' + times + ' times following hints');
          assert.ok(++steps < 3000, 'seed ' + seed + ': hints never run out');
        }
        if (s.won) wins++;
        else dead++;
      }
    }
    assert.ok(wins > 100, 'hint-led wins: ' + wins);
    assert.ok(dead > 100);
  });

  // ================================================================================== isStuck
  /** Cards that cycling the stock (draws and recycles only) ever brings to the top of the waste. */
  function cycleTops(s) {
    const k = E.clone(s);
    const tops = new Set();
    const total = k.piles.stock.length + k.piles.waste.length;
    if (k.piles.waste.length) tops.add(k.piles.waste[k.piles.waste.length - 1]);
    // finishing this pass plus two whole passes shows everything that can ever come up
    for (let i = 0; i < 3 * (total + 2); i++) {
      if (!E.apply(k, DRAW_A)) break;
      if (k.piles.waste.length) tops.add(k.piles.waste[k.piles.waste.length - 1]);
    }
    return tops;
  }
  /** Could a loose card (from the waste) be placed anywhere in this layout? */
  function placeable(s, card) {
    const f = s.piles['f' + su(card)];
    if (f.length === rk(card) - 1) return true;
    return TAB.some((t) => {
      const pile = s.piles[t];
      if (pile.length === 0) return rk(card) === 13;
      const top = pile[pile.length - 1];
      return s.faceUp[top] && red(top) !== red(card) && rk(top) === rk(card) + 1;
    });
  }
  /**
   * Brute force. From `s`, tries every legal non-draw move, breadth first, through every position
   * such moves can reach (up to `cap` positions). Returns what it found that would be progress:
   *   'foundation'  a legal move to a foundation in the position itself
   *   'reveal'      some reachable position has a move that turns over a face-down card
   *   'loose'       some reachable position lets a card from the stock cycle be placed
   *   null          nothing, and the search was complete
   *   'cap'         nothing found, but the search was cut off
   */
  function bruteProgress(s, cap) {
    const tops = Array.from(cycleTops(s));
    const root = E.clone(s);
    root.history = [];
    if (allMoves(root).some((m) => m.to[0] === 'f')) return 'foundation';
    // columns are interchangeable, and so are the piles a card came from: only the layout matters
    const key = (x) => TAB.map((t) => x.piles[t].join(',')).sort().join('|') + '#' + FND.map((f) => x.piles[f].length).join(',');
    const seen = new Set([key(root)]);
    let frontier = [root];
    while (frontier.length) {
      const next = [];
      for (const x of frontier) {
        if (tops.some((card) => placeable(x, card))) return 'loose';
        for (const m of allMoves(x)) {
          const r = E.apply(x, m);
          assert.ok(r, 'brute force: a legal move applies');
          if (r.flips.length > 0) return 'reveal';
          const k = key(x);
          if (!seen.has(k)) {
            if (seen.size >= cap) return 'cap';
            seen.add(k);
            const y = E.clone(x);
            y.history = [];
            next.push(y);
          }
          assert.ok(E.apply(x, UNDO_A));
        }
      }
      frontier = next;
    }
    return null;
  }

  test('isStuck: hand-made positions', () => {
    assert.equal(E.isStuck(E.newGame({ seed: 1 })), false);
    // nothing moves, nothing in the stock helps
    const dead = (over) => pos(Object.assign({ t: [['?JS', '8H'], ['8D'], ['8S'], ['8C'], ['6H'], ['6D'], ['6S']], stock: ['2D', '2C'], rest: 't0' }, over));
    let s = dead({});
    assert.equal(allMoves(s).length, 0);
    assert.equal(bruteProgress(s, 5000), null);
    assert.equal(E.isStuck(s), true);
    assert.deepEqual(E.hints(s), []);
    // ...but a playable stock card means not stuck
    s = dead({ stock: ['7C', '2C'] });
    assert.equal(E.isStuck(s), false);
    assert.deepEqual(E.hints(s).map((h) => h.action), [DRAW_A]);
    // a foundation move exists
    s = dead({ t: [['?JS', '8H'], ['8D'], ['8S'], ['8C'], ['6H'], ['6D'], ['AS']] });
    assert.equal(E.isStuck(s), false);
    // an uncovering move exists
    s = dead({ t: [['?JS', '7S'], ['8D'], ['8S'], ['8C'], ['6H'], ['6D'], ['6S']] });
    assert.equal(E.isStuck(s), false);
    // a move exists, but it only shuffles a card between two equivalent columns: still stuck
    s = dead({ t: [['?JS', '8H'], ['8D', '7S'], ['10S'], ['8C'], ['6H'], ['6D'], ['6S']] });
    assert.ok(allMoves(s).length > 0);
    assert.equal(bruteProgress(s, 5000), null);
    assert.equal(E.isStuck(s), true);
    // draw 3: the playable card is in the stock but the cycle never shows it
    s = dead({ drawCount: 3, stock: ['2C', '7C', '2D'] });
    assert.deepEqual(Array.from(cycleTops(s)), [c('2C')]);
    assert.equal(E.isStuck(s), true);
    // draw 3: ...and here it does
    s = dead({ drawCount: 3, stock: ['7C', '2C', '2D'] });
    assert.equal(E.isStuck(s), false);
    // draw 1 sees every stock card
    s = dead({ drawCount: 1, stock: ['2C', '7C', '2D'] });
    assert.equal(E.isStuck(s), false);
    // a waste card that plays
    s = dead({ stock: [], waste: ['2C', '7C'] });
    assert.equal(E.isStuck(s), false);
    // a waste card that does not, with an empty stock
    s = dead({ stock: [], waste: ['7C', '2C'] });
    assert.equal(E.isStuck(s), false, 'draw 1: the 7 of clubs comes up again after a recycle');
    s = dead({ drawCount: 3, stock: [], waste: ['7C', '2D', '2C'] });
    assert.equal(E.isStuck(s), true, 'draw 3: after the recycle the three cards come out together, the 2 of clubs on top');
  });

  test('isStuck has no false positives: every stuck verdict in 500 playouts is confirmed by brute force', () => {
    let verdicts = 0;
    let confirmed = 0;
    let capped = 0;
    let positions = 0;
    let unknown = 0;
    for (let seed = 1; seed <= 250; seed++) {
      for (const drawCount of [1, 3]) {
        const s = E.newGame({ seed: seed * 11 + 5, drawCount });
        const rng = RNG.create(seed * 97 + drawCount);
        // a third of the games are played half at random, which reaches odder dead ends (cards
        // taken back from the foundations, half-built runs)
        const randomness = seed % 3 === 0 ? 0.5 : 0.05;
        let noHint = 0;
        for (let i = 0; i < 400 && !s.won; i++) {
          positions++;
          const before = core(s);
          const stuck = E.isStuck(s);
          assert.equal(core(s), before, 'isStuck never mutates');
          const label = 'seed ' + seed + ' draw ' + drawCount + ' step ' + i;
          if (stuck) {
            verdicts++;
            // the cheap, exact part of the contract: no foundation move, no uncovering move, no
            // waste move, and nothing the stock cycle shows can be placed
            for (const m of allMoves(s)) {
              assert.notEqual(m.to[0], 'f', label + ': stuck although a foundation move exists');
              assert.notEqual(where(s, m.card).pile, 'waste', label + ': stuck although the waste card can be played');
              const r = E.apply(E.clone(s), m);
              assert.equal(r.flips.length, 0, label + ': stuck although a move uncovers a card');
            }
            for (const card of cycleTops(s)) assert.ok(!placeable(s, card), label + ': stuck although the stock brings up a playable card');
            assert.deepEqual(E.hints(s), [], label + ': stuck, yet there is a hint');
            // the expensive part: no sequence of non-draw moves changes that
            const found = bruteProgress(s, 800);
            if (found === 'cap') capped++;
            else {
              assert.equal(found, null, label + ': isStuck is true but brute force found: ' + found);
              confirmed++;
            }
            break; // a stuck game stays stuck: one verdict per game is enough
          }
          // no hint, yet not called stuck: allowed (the engine may be unsure), but it should be rare
          if (E.hints(s).length === 0) {
            unknown++;
            if (++noHint > 3) break; // each further look costs the engine another search
          }
          const a = smartAction(s, rng, randomness);
          if (!a) break;
          E.apply(s, a);
        }
      }
    }
    if (process.env.REVIEW_STATS) console.log({ verdicts, confirmed, capped, positions, unknown });
    assert.ok(verdicts >= 150, 'stuck verdicts: ' + verdicts);
    assert.ok(confirmed >= 140, 'confirmed by brute force: ' + confirmed + ' (too large to check: ' + capped + ')');
    assert.ok(positions > 25000, String(positions));
    assert.ok(unknown < positions / 20, 'positions without a hint that are not called stuck: ' + unknown);
  });
});
