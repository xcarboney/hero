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
    assert.deepEqual(um.transfers, [C('7D'), C('8S'), C('9H')].map((card) => ({ card, from: 't1', to: 't0' })));
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
            // inverse transfers, in reverse order, with the faces flipped back
            assert.deepEqual(
              record.transfers,
              record.undone.transfers.slice().reverse().map((t) => ({ card: t.card, from: t.to, to: t.from }))
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
