/*
 * Tests for SOL.Solver (js/core/solver.js).
 *
 * Run with:   node --test "solitaire/tests/*.test.js"      (from the repository root)
 *
 * What is covered:
 *   - soundness: every solution solve() returns, on 2 x 150 fresh deals, on positions in the
 *     middle of a game (after draws, along a winning line, after random play) and on hand-made
 *     endgames, is replayed action by action through Engine.apply and must end in a won state;
 *   - small hand-made positions against a brute-force search over engine states;
 *   - solve() never mutates its input (also checked on deep-frozen states);
 *   - both limits: maxNodes is never exceeded, a tiny maxNodes or maxMs returns at once, bad
 *     limits mean the defaults; results are deterministic and do not depend on what ran before;
 *   - bad input never throws;
 *   - findWinnableSeed: certified seeds really are winnable, the seed sequence, the budget;
 *   - findWinnableSeedAsync: resolves, yields between slices, a search paused across slices
 *     gives exactly the result of the uninterrupted one, never rejects;
 *   - the file loads as a classic script (no require / module), as index.html loads it.
 *
 * Time. The suite must pass on a busy machine (other test files, a shared CI runner), where a
 * process can be kept waiting at any moment, also for longer than a whole maxMs or budgetMs. So
 * no test depends on how long something really took, beyond "at least its budget" and a very
 * loose upper bound (BUSY_MS), and no test on the real clock asserts how much a search got done
 * before its time ran out: a search that was kept waiting all that time has honestly done
 * nothing. Where the answer of a search is asserted, time is not what ends it (nodesOnly, or a
 * 20 s budget for a seed search). Where time is the subject (maxMs, budgetMs, sliceMs and their
 * defaults) the search runs on a test clock that only moves when the solver looks at it
 * (testClock): when it stops, how much it searched until then, how long a slice is and how many
 * slices fit in a budget are then exact numbers, the same on every machine and every run.
 *
 * The measurements quoted in the solver's header come from the last test. It is skipped unless
 * asked for:   SOLVER_BENCH=1 node --test "solitaire/tests/solver.test.js"
 * (SOLVER_BENCH=1000 sets the number of deals; the default is 400 per draw mode).
 */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const CORE = path.join(__dirname, '..', 'js', 'core');
const RNG = require(path.join(CORE, 'rng.js'));
const Engine = require(path.join(CORE, 'engine.js'));
const Solver = require(path.join(CORE, 'solver.js'));

// ------------------------------------------------------------------------------------- helpers
/** Limits under which only the node count decides: results are exactly reproducible. */
function nodesOnly(maxNodes) {
  return { maxNodes: maxNodes, maxMs: 600000 };
}

/**
 * The only upper bound these tests put on real time. They run next to other work (the other test
 * files, whatever else the machine or the CI runner is doing), and a process that is kept waiting
 * for the CPU must not fail a test. So on the real clock a search that time may end is asserted
 * only through what holds however long it was kept waiting (reason, certified, the seed that
 * belongs to `tried`, `ms` not below the limit); how much it searched is asserted on a test clock
 * (testClock below), where it is exact. Real time only has to stay below the limit plus this
 * much: a search that ignored its limit would run for minutes (the tests give it maxNodes 1e9).
 */
const BUSY_MS = 5000;

/**
 * A clock for the solver that only moves when it is looked at: every reading is `stepMs` later
 * than the one before, and advance(ms) lets time pass without a reading (a pause between two
 * slices). What a search does on it depends on its own accounting alone (how often it looks at
 * the clock, when it stops, when it yields), not on how fast or how busy the machine is, so the
 * numbers are exact and the same on every run.
 *
 * It works because the solver reads `performance.now()` through the global object at the moment
 * of every call. Use a `stepMs` that is a power of two (1/16, 1/32): every reading is then an
 * exact number and "the first reading at or after the deadline" is not a matter of rounding.
 * Always restore() in a finally block; `time` is the current time without a reading.
 */
function testClock(stepMs) {
  const own = Object.getOwnPropertyDescriptor(performance, 'now');
  const clock = {
    time: 0,
    reads: 0,
    advance: function (ms) {
      clock.time += ms;
    },
    restore: function () {
      if (own) Object.defineProperty(performance, 'now', own);
      else delete performance.now;
    },
  };
  performance.now = function () {
    clock.reads++;
    clock.time += stepMs;
    return clock.time;
  };
  return clock;
}

/**
 * fn() on a testClock(stepMs), for searches that return before they are done with the clock
 * (solve, findWinnableSeed; not the async one). Returns { r: what fn returned, reads: how often
 * the clock was looked at }.
 */
function onTestClock(stepMs, fn) {
  const clock = testClock(stepMs);
  try {
    const r = fn();
    return { r: r, reads: clock.reads };
  } finally {
    clock.restore();
  }
}

function deal(seed, drawCount) {
  return Engine.newGame({ seed: seed, drawCount: drawCount, id: 'test' });
}

/**
 * Replays `moves` on a fresh clone of `state` through the engine and insists on a win: every
 * action is a legal draw or move, and the game is won exactly at the last one.
 */
function assertWins(state, moves, label) {
  assert.ok(Array.isArray(moves), label + ': moves is an array');
  const copy = Engine.clone(state);
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    assert.ok(m && (m.type === 'draw' || m.type === 'move'), label + ': action ' + i + ' is a draw or a move');
    if (m.type === 'move') {
      assert.ok(Number.isInteger(m.card) && m.card >= 0 && m.card <= 51, label + ': action ' + i + ' has a card id');
      assert.ok(Engine.PILE_IDS.includes(m.to), label + ': action ' + i + ' has a pile id');
    }
    const record = Engine.apply(copy, m);
    assert.ok(record, label + ': action ' + i + ' ' + JSON.stringify(m) + ' is legal');
    assert.equal(record.won, i === moves.length - 1, label + ': the game is won by the last action only');
  }
  assert.equal(Engine.isWon(copy), true, label + ': the replay ends in a won state');
  if (moves.length > 0) assert.equal(copy.won, true, label + ': state.won is set');
  for (const f of Engine.FOUNDATIONS) assert.equal(copy.piles[f].length, 13, label + ': ' + f + ' is complete');
  return copy;
}

const REASONS = ['solved', 'nodes', 'time', 'exhausted', 'invalid'];

/** The shape every solve() result must have. */
function assertResultShape(r, maxNodes) {
  assert.equal(typeof r, 'object');
  assert.equal(typeof r.solved, 'boolean');
  assert.ok(Number.isInteger(r.nodes) && r.nodes >= 0, 'nodes is a count');
  assert.ok(r.nodes <= maxNodes, 'nodes ' + r.nodes + ' <= maxNodes ' + maxNodes);
  assert.ok(typeof r.ms === 'number' && r.ms >= 0 && isFinite(r.ms), 'ms is a duration');
  assert.ok(REASONS.includes(r.reason), 'reason ' + r.reason);
  assert.equal(r.solved, r.reason === 'solved');
  if (r.solved) assert.ok(Array.isArray(r.moves));
  else assert.equal('moves' in r, false, 'no moves without a solution');
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}

/** Plays up to `steps` random legal actions (draws included) on `state`. */
function randomPlay(state, rng, steps) {
  for (let i = 0; i < steps && !state.won; i++) {
    const ms = Engine.legalMoves(state);
    if (Engine.canDraw(state)) ms.push({ type: 'draw' }, { type: 'draw' });
    if (ms.length === 0) break;
    assert.ok(Engine.apply(state, ms[rng.int(ms.length)]));
  }
  return state;
}

const hardSeeds = {};
/** A deal that is neither solved nor exhausted within 200000 nodes: hundreds of ms of search. */
function hardSeed(drawCount) {
  if (!hardSeeds[drawCount]) {
    hardSeeds[drawCount] = findSeed(drawCount, 20000, (r, st) => r.reason === 'nodes' && Solver.solve(st, nodesOnly(200000)).reason === 'nodes');
  }
  return hardSeeds[drawCount];
}

/** First seed >= from whose deal satisfies pred(result, state) under the given node limit. */
function findSeed(drawCount, maxNodes, pred, from) {
  for (let seed = from || 1; seed < (from || 1) + 3000; seed++) {
    const st = deal(seed, drawCount);
    if (pred(Solver.solve(st, nodesOnly(maxNodes)), st)) return seed;
  }
  throw new Error('no seed found');
}

/** A hand-made engine state: `spec` gives the piles; everything not listed goes nowhere. */
function makeState(spec, drawCount) {
  const piles = { stock: [], waste: [], f0: [], f1: [], f2: [], f3: [], t0: [], t1: [], t2: [], t3: [], t4: [], t5: [], t6: [] };
  const faceUp = new Array(52).fill(false);
  for (const id of Object.keys(spec.piles)) piles[id] = spec.piles[id].slice();
  for (const c of spec.faceUp) faceUp[c] = true;
  return {
    v: 1,
    id: 'hand-made',
    seed: 0,
    drawCount: drawCount || 1,
    piles: piles,
    faceUp: faceUp,
    score: 0,
    moves: 0,
    undos: 0,
    recycles: 0,
    elapsedMs: 0,
    won: false,
    history: [],
  };
}

/** card id from suit (0 spades, 1 hearts, 2 clubs, 3 diamonds) and rank 1..13 */
function card(suit, rank) {
  return suit * 13 + rank - 1;
}

/**
 * Ground truth for small positions: exhaustive search over engine states, every legal move and
 * the draw (positions that differ only in the order of the columns count as one). true / false,
 * or null when the position is too big for it.
 */
function bruteForceWinnable(start, maxStates) {
  const s = Engine.clone(start);
  s.history = [];
  if (Engine.isWon(s)) return true;
  const key = function () {
    const p = s.piles;
    const cols = [];
    for (const t of Engine.TABLEAU) {
      const col = p[t];
      let d = 0;
      while (d < col.length && !s.faceUp[col[d]]) d++;
      cols.push(d + ':' + col.join(','));
    }
    return p.stock.join(',') + '|' + p.waste.join(',') + '|' + cols.sort().join('|');
  };
  const movesHere = function () {
    const ms = Engine.legalMoves(s);
    if (Engine.canDraw(s)) ms.push({ type: 'draw' });
    return ms;
  };
  const seen = new Set([key()]);
  const stack = [{ ms: movesHere(), i: 0 }];
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (top.i >= top.ms.length) {
      stack.pop();
      if (stack.length > 0) Engine.apply(s, { type: 'undo' });
      continue;
    }
    const record = Engine.apply(s, top.ms[top.i++]);
    if (record.won) return true;
    const k = key();
    if (seen.has(k)) {
      Engine.apply(s, { type: 'undo' });
      continue;
    }
    seen.add(k);
    if (seen.size > maxStates) return null;
    stack.push({ ms: movesHere(), i: 0 });
  }
  return false;
}

/**
 * A small position: every card up to `baseRank` is on its foundation, the rest is shuffled into
 * a stock and seven columns of random height with only the top card face-up.
 */
function miniDeal(seed, baseRank, drawCount) {
  const rng = RNG.create(seed);
  const piles = { stock: [], waste: [], f0: [], f1: [], f2: [], f3: [], t0: [], t1: [], t2: [], t3: [], t4: [], t5: [], t6: [] };
  const faceUp = [];
  const rest = [];
  for (let c = 0; c < 52; c++) {
    if ((c % 13) + 1 <= baseRank) piles['f' + Math.floor(c / 13)].push(c);
    else rest.push(c);
    faceUp.push((c % 13) + 1 <= baseRank);
  }
  RNG.shuffle(rest, rng);
  const nStock = Math.min(rest.length - 1, rng.int(Math.floor(rest.length / 2) + 1));
  for (let i = 0; i < nStock; i++) piles.stock.push(rest.pop());
  while (rest.length > 0) piles['t' + rng.int(7)].push(rest.pop());
  for (const t of Engine.TABLEAU) {
    const col = piles[t];
    if (col.length > 0) faceUp[col[col.length - 1]] = true;
  }
  const st = makeState({ piles: piles, faceUp: [] }, drawCount);
  st.faceUp = faceUp;
  return st;
}

// ------------------------------------------------------------------------------------- module
describe('module', () => {
  test('exposes the contract API on SOL.Solver', () => {
    assert.equal(typeof Solver.solve, 'function');
    assert.equal(typeof Solver.findWinnableSeed, 'function');
    assert.equal(typeof Solver.findWinnableSeedAsync, 'function');
    assert.equal(globalThis.SOL.Solver, Solver);
    assert.ok(Object.isFrozen(Solver.DEFAULTS));
    for (const k of ['maxNodes', 'maxMs', 'seedMaxNodes', 'budgetMs', 'asyncBudgetMs', 'sliceMs']) {
      assert.ok(Solver.DEFAULTS[k] > 0, k);
    }
    assert.equal(Solver.DEFAULTS.budgetMs, 250);
    assert.equal(Solver.DEFAULTS.asyncBudgetMs, 1500);
    assert.equal(Solver.DEFAULTS.sliceMs, 12);
  });

  test('loads as a classic script (no require, no module), like index.html loads it', () => {
    const ctx = vm.createContext({ console: console, performance: performance, setTimeout: setTimeout });
    vm.runInContext('var window = this;', ctx);
    for (const f of ['rng.js', 'engine.js', 'solver.js']) {
      vm.runInContext(fs.readFileSync(path.join(CORE, f), 'utf8'), ctx, { filename: f });
    }
    const S = ctx.SOL;
    assert.equal(typeof S.Solver.solve, 'function');
    // the same deal, the same answer as the require()d copy
    const here = Solver.solve(deal(12, 3), nodesOnly(5000));
    const there = S.Solver.solve(S.Engine.newGame({ seed: 12, drawCount: 3, id: 'x' }), { maxNodes: 5000, maxMs: 600000 });
    assert.equal(there.solved, here.solved);
    assert.equal(there.nodes, here.nodes);
    assert.equal(JSON.stringify(there.moves), JSON.stringify(here.moves));
    const found = S.Solver.findWinnableSeed({ drawCount: 1, startSeed: 1, budgetMs: 20000 });
    assert.equal(found.certified, true);
  });

  test('solver.js is pure logic: no DOM, and setTimeout is its only timer', () => {
    const src = fs.readFileSync(path.join(CORE, 'solver.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const word of ['document', 'requestAnimationFrame', 'setInterval', 'localStorage', 'fetch(', 'Worker', 'import ', 'export ']) {
      assert.equal(src.includes(word), false, 'solver.js must not use ' + word);
    }
  });
});

// ------------------------------------------------------------------------------------- soundness
describe('solve: every solution replays to a win through the engine', () => {
  for (const drawCount of [1, 3]) {
    test('150 fresh deals, draw ' + drawCount, () => {
      let solved = 0;
      let actions = 0;
      for (let seed = 1; seed <= 150; seed++) {
        const st = deal(seed, drawCount);
        const r = Solver.solve(st, nodesOnly(6000));
        assertResultShape(r, 6000);
        if (r.solved) {
          solved++;
          actions += r.moves.length;
          assert.ok(r.moves.length >= 52, 'a win takes at least 52 actions');
          assertWins(st, r.moves, 'seed ' + seed + ' draw ' + drawCount);
        }
      }
      // Regression guard on strength. Deterministic (fixed seeds, node limit only): today it is
      // 127 of these 150 draw-1 deals and 101 of the draw-3 deals (on random deals about 86% and
      // 75% at this limit; some 90% / 82% are winnable at all).
      assert.ok(solved >= (drawCount === 1 ? 120 : 95), 'certified ' + solved + ' of 150 draw-' + drawCount + ' deals');
      assert.ok(actions / solved < 260, 'solutions stay reasonably short');
    });
  }

  test('default limits, both draw modes', () => {
    for (let seed = 200; seed < 230; seed++) {
      for (const drawCount of [1, 3]) {
        const st = deal(seed, drawCount);
        const r = Solver.solve(st);
        assertResultShape(r, Solver.DEFAULTS.maxNodes);
        if (r.solved) assertWins(st, r.moves, 'seed ' + seed);
        const again = Solver.solve(st, {});
        assertResultShape(again, Solver.DEFAULTS.maxNodes);
      }
    }
  });

  test('a deal that takes a long search still replays', () => {
    for (const drawCount of [1, 3]) {
      const seed = findSeed(drawCount, 60000, (r) => r.solved && r.nodes > 15000);
      const st = deal(seed, drawCount);
      const r = Solver.solve(st, nodesOnly(60000));
      assert.equal(r.solved, true);
      assertWins(st, r.moves, 'long search, seed ' + seed);
    }
  });

  test('positions after draws: the waste is not empty and (draw 3) not on a multiple of three', () => {
    let solved = 0;
    let total = 0;
    for (const drawCount of [1, 3]) {
      for (let seed = 1; seed <= 12; seed++) {
        for (const draws of [1, 2, 5, 9, 13, 26]) {
          const st = deal(seed, drawCount);
          for (let i = 0; i < draws; i++) assert.ok(Engine.apply(st, { type: 'draw' }));
          total++;
          const r = Solver.solve(st, nodesOnly(6000));
          assertResultShape(r, 6000);
          if (r.solved) {
            solved++;
            assertWins(st, r.moves, 'seed ' + seed + ' after ' + draws + ' draws');
          }
        }
      }
    }
    assert.ok(solved / total > 0.6, solved + ' of ' + total + ' solved');
  });

  test('positions along a winning line stay solvable, with history on the state', () => {
    let solved = 0;
    let total = 0;
    for (const drawCount of [1, 3]) {
      let found = 0;
      for (let seed = 300; found < 12; seed++) {
        const st = deal(seed, drawCount);
        const line = Solver.solve(st, nodesOnly(6000));
        if (!line.solved) continue;
        found++;
        for (const fraction of [0.2, 0.5, 0.8, 0.97]) {
          const mid = Engine.clone(st);
          const k = Math.floor(line.moves.length * fraction);
          for (let i = 0; i < k; i++) assert.ok(Engine.apply(mid, line.moves[i]));
          assert.equal(mid.history.length, k);
          total++;
          const r = Solver.solve(mid, nodesOnly(20000));
          if (r.solved) {
            solved++;
            assertWins(mid, r.moves, 'seed ' + seed + ' at ' + fraction);
          }
        }
      }
    }
    // these positions are all winnable; the solver is not complete, but it should miss very few
    assert.ok(solved / total >= 0.9, solved + ' of ' + total + ' solved');
  });

  test('positions after random play (cards on foundations, runs, empty columns)', () => {
    let solved = 0;
    let total = 0;
    for (const drawCount of [1, 3]) {
      for (let seed = 1; seed <= 60; seed++) {
        const rng = RNG.create(seed * 977 + drawCount);
        const st = randomPlay(deal(seed, drawCount), rng, 10 + rng.int(120));
        if (st.won) continue;
        total++;
        const before = Engine.serialize(st);
        const r = Solver.solve(st, nodesOnly(4000));
        assertResultShape(r, 4000);
        assert.notEqual(r.reason, 'invalid', 'a state the engine produced is always readable');
        assert.equal(Engine.serialize(st), before);
        if (r.solved) {
          solved++;
          assertWins(st, r.moves, 'random play, seed ' + seed);
        }
      }
    }
    assert.ok(solved > 10, solved + ' of ' + total + ' solved');
  });

  test('an already won state: solved with no moves', () => {
    const st = deal(findSeed(1, 6000, (r) => r.solved), 1);
    const line = Solver.solve(st, nodesOnly(6000));
    const won = assertWins(st, line.moves, 'line');
    const r = Solver.solve(won);
    assert.equal(r.solved, true);
    assert.deepEqual(r.moves, []);
    assert.equal(r.nodes, 0);
    assert.equal(r.reason, 'solved');

    // one action before the end (the default node limit, but no time limit that a busy machine
    // could run into: the answer is asserted)
    const almost = Engine.clone(st);
    for (let i = 0; i < line.moves.length - 1; i++) Engine.apply(almost, line.moves[i]);
    const last = Solver.solve(almost, nodesOnly(Solver.DEFAULTS.maxNodes));
    assert.equal(last.solved, true);
    assert.equal(last.moves.length, 1);
    assertWins(almost, last.moves, 'last move');
  });

  test('hand-made endgames', () => {
    // Everything home but the four Kings, each alone in a column.
    const fu = [];
    const piles = { t1: [card(0, 13)], t2: [card(1, 13)], t4: [card(2, 13)], t6: [card(3, 13)] };
    for (let s = 0; s < 4; s++) {
      piles['f' + s] = [];
      for (let r = 1; r <= 12; r++) {
        piles['f' + s].push(card(s, r));
        fu.push(card(s, r));
      }
      fu.push(card(s, 13));
    }
    const kings = makeState({ piles: piles, faceUp: fu });
    const r = Solver.solve(kings, nodesOnly(Solver.DEFAULTS.maxNodes));
    assert.equal(r.solved, true);
    assert.equal(r.moves.length, 4);
    assertWins(kings, r.moves, 'four kings');

    // The last three spades are the stock, in the wrong order (Q on top, then K, then J): it
    // takes draws, a recycle and — in draw 3 — parking the King on an empty column.
    for (const drawCount of [1, 3]) {
      const p2 = { stock: [card(0, 11), card(0, 13), card(0, 12)] };
      const fu2 = [];
      for (let s = 0; s < 4; s++) {
        p2['f' + s] = [];
        for (let r2 = 1; r2 <= (s === 0 ? 10 : 13); r2++) {
          p2['f' + s].push(card(s, r2));
          fu2.push(card(s, r2));
        }
      }
      const buried = makeState({ piles: p2, faceUp: fu2 }, drawCount);
      const truth = bruteForceWinnable(buried, 100000);
      const r2 = Solver.solve(buried, nodesOnly(Solver.DEFAULTS.maxNodes));
      assert.equal(r2.solved, truth, 'draw ' + drawCount + ': solver and brute force agree');
      if (r2.solved) assertWins(buried, r2.moves, 'buried spades, draw ' + drawCount);
      else assert.equal(r2.reason, 'exhausted');
    }
  });

  test('small positions: agrees with a brute-force search over engine states', () => {
    // The solver prunes moves, so it is not complete by construction; on positions small enough
    // to search exhaustively it has to give the true answer all the same, wins and losses.
    let winnable = 0;
    let lost = 0;
    for (const drawCount of [1, 3]) {
      for (const baseRank of [8, 3]) {
        for (let seed = 1; seed <= 20; seed++) {
          const st = miniDeal(seed * 31 + baseRank, baseRank, drawCount);
          const truth = bruteForceWinnable(st, 5000);
          if (truth === null) continue; // too big to search exhaustively
          const label = 'mini deal ' + seed + ' base ' + baseRank + ' draw ' + drawCount;
          const r = Solver.solve(st, nodesOnly(500000));
          assertResultShape(r, 500000);
          if (truth) winnable++;
          else lost++;
          assert.equal(r.solved, truth, label + ': brute force says ' + truth + ', the solver says ' + r.reason);
          if (r.solved) assertWins(st, r.moves, label);
          else assert.equal(r.reason, 'exhausted', label);
        }
      }
    }
    // today: 53 winnable and 12 lost positions are compared (the others are too big for brute force)
    assert.ok(winnable >= 40, 'enough winnable positions were compared (' + winnable + ')');
    assert.ok(lost >= 8, 'enough lost positions were compared (' + lost + ')');
  });

  test('a dead position is reported as exhausted, not as solved', () => {
    // Seven black tops, no ace among them, nothing in the stock: no legal action at all.
    const tops = [card(0, 13), card(0, 12), card(0, 11), card(0, 10), card(0, 9), card(0, 8), card(0, 7)];
    const piles = {};
    const others = [];
    for (let c = 0; c < 52; c++) if (!tops.includes(c)) others.push(c);
    for (let t = 0; t < 7; t++) piles['t' + t] = others.splice(0, t === 6 ? others.length : 6).concat([tops[t]]);
    const dead = makeState({ piles: piles, faceUp: tops }, 3);
    assert.deepEqual(Engine.legalMoves(dead), []);
    assert.equal(Engine.canDraw(dead), false);
    const r = Solver.solve(dead, nodesOnly(Solver.DEFAULTS.maxNodes));
    assertResultShape(r, 0);
    assert.equal(r.solved, false);
    assert.equal(r.reason, 'exhausted');

    // and a real deal the solver searches to the end
    const seed = findSeed(3, 20000, (res) => res.reason === 'exhausted');
    const res = Solver.solve(deal(seed, 3), nodesOnly(20000));
    assertResultShape(res, 20000);
    assert.equal(res.solved, false);
    assert.ok(res.nodes > 0);
  });
});

// ------------------------------------------------------------------------------------- purity
describe('solve: never mutates its input', () => {
  test('fresh deals, mid-game states with history, solved or not', () => {
    for (const drawCount of [1, 3]) {
      for (let seed = 1; seed <= 25; seed++) {
        const st = deal(seed, drawCount);
        if (seed % 2 === 0) randomPlay(st, RNG.create(seed), 40);
        const text = Engine.serialize(st);
        const snapshot = structuredClone(st);
        const r = Solver.solve(st, nodesOnly(3000));
        assert.equal(Engine.serialize(st), text, 'seed ' + seed);
        assert.deepStrictEqual(st, snapshot);
        // the moves handed out are not tied to the state either
        if (r.solved) {
          r.moves.length = 0;
          assert.equal(Engine.serialize(st), text);
        }
      }
    }
  });

  test('works on a deep-frozen state (any write would throw)', () => {
    let solved = 0;
    for (const drawCount of [1, 3]) {
      for (let seed = 1; seed <= 20; seed++) {
        const st = deal(seed, drawCount);
        if (seed > 10) for (let i = 0; i < 4; i++) Engine.apply(st, { type: 'draw' });
        const expected = Solver.solve(st, nodesOnly(3000));
        const frozen = deepFreeze(Engine.clone(st));
        const r = Solver.solve(frozen, nodesOnly(3000));
        assert.equal(r.reason, expected.reason, 'seed ' + seed);
        assert.equal(r.nodes, expected.nodes);
        assert.deepEqual(r.moves, expected.moves);
        if (r.solved) solved++;
      }
    }
    assert.ok(solved >= 20, 'frozen states were really solved (' + solved + ')');
  });
});

// ------------------------------------------------------------------------------------- limits
describe('solve: limits', () => {
  test('a tiny maxNodes returns at once with solved: false', () => {
    for (const drawCount of [1, 3]) {
      for (const maxNodes of [0, 1, 2, 10, 51]) {
        for (let seed = 1; seed <= 20; seed++) {
          const t0 = performance.now();
          const r = Solver.solve(deal(seed, drawCount), nodesOnly(maxNodes));
          const took = performance.now() - t0;
          assertResultShape(r, maxNodes);
          assert.equal(r.solved, false, 'a win takes at least 52 nodes');
          assert.equal(r.reason, 'nodes');
          assert.equal(r.nodes, maxNodes); // it did exactly that much work and no more
          assert.ok(took < BUSY_MS, 'returned (' + took.toFixed(2) + ' ms)');
        }
      }
    }
  });

  test('maxNodes is never exceeded, and a larger limit only continues the same search', () => {
    for (const drawCount of [1, 3]) {
      for (let seed = 1; seed <= 30; seed++) {
        const st = deal(seed, drawCount);
        let previous = null;
        for (const maxNodes of [60, 150, 400, 1000, 3000]) {
          const r = Solver.solve(st, nodesOnly(maxNodes));
          assertResultShape(r, maxNodes);
          if (previous && previous.solved) {
            // already solved within fewer nodes: exactly the same answer
            assert.equal(r.solved, true);
            assert.equal(r.nodes, previous.nodes);
            assert.deepEqual(r.moves, previous.moves);
          } else if (previous && previous.reason === 'nodes') {
            assert.ok(r.nodes >= previous.nodes);
          }
          if (!r.solved && r.reason === 'nodes') assert.equal(r.nodes, maxNodes);
          previous = r;
        }
      }
    }
  });

  test('maxMs: 0 returns without searching', () => {
    for (const drawCount of [1, 3]) {
      const r = Solver.solve(deal(5, drawCount), { maxMs: 0, maxNodes: 1e9 });
      assertResultShape(r, 1e9);
      assert.equal(r.solved, false);
      assert.equal(r.reason, 'time');
      assert.equal(r.nodes, 0);
    }
  });

  test('a small maxMs stops a search that would take much longer', () => {
    for (const drawCount of [1, 3]) {
      const st = deal(hardSeed(drawCount), drawCount);
      for (const maxMs of [2, 10, 30]) {
        const t0 = performance.now();
        const r = Solver.solve(st, { maxNodes: 1e9, maxMs: maxMs });
        const took = performance.now() - t0;
        assert.equal(r.solved, false);
        assert.equal(r.reason, 'time');
        assert.ok(r.ms >= maxMs - 0.001, 'it used its time (' + r.ms.toFixed(2) + ' of ' + maxMs + ' ms)');
        // What it did in that time: a small part of the search. A busy machine only makes it
        // less, down to nothing at all when the process is kept waiting for the whole of maxMs
        // before the first look at the clock, so "it searched" is not asserted here.
        assert.ok(r.nodes < 200000, r.nodes + ' nodes');
        // How long that really took is only bounded loosely here (see BUSY_MS); the test below
        // puts the same search on a test clock, where "searched, and stopped at the limit" is exact.
        assert.ok(took < maxMs + BUSY_MS, 'stopped: ' + took.toFixed(1) + ' ms for maxMs ' + maxMs);
      }
    }
  });

  test('on a test clock: the search stops at its first look at the clock after maxMs', () => {
    const STEP = 1 / 16; // ms per look at the clock
    for (const drawCount of [1, 3]) {
      const st = deal(hardSeed(drawCount), drawCount);
      for (const maxMs of [2, 10, 30]) {
        const runs = [];
        for (let i = 0; i < 2; i++) {
          const clock = testClock(STEP);
          try {
            const r = Solver.solve(st, { maxNodes: 1e9, maxMs: maxMs });
            runs.push({ r: r, reads: clock.reads });
          } finally {
            clock.restore();
          }
        }
        const r = runs[0].r;
        const reads = runs[0].reads;
        assert.equal(r.solved, false);
        assert.equal(r.reason, 'time');
        // One reading at the start, one per look, one for `ms`: the look that found the time used
        // up was the first one at or after maxMs, so `ms` is maxMs plus that last reading.
        assert.equal(reads, maxMs / STEP + 2, 'looks at the clock for maxMs ' + maxMs);
        assert.equal(r.ms, maxMs + STEP);
        // It looks at the clock every 16 search steps (and once before the first).
        assert.ok(r.nodes > 0 && r.nodes <= 16 * (reads - 2), r.nodes + ' nodes in ' + reads + ' looks');
        // Nothing but the clock decided: the same again.
        assert.equal(runs[1].reads, reads);
        assert.deepEqual(runs[1].r, r);
      }
    }
  });

  test('the default limits bound a call without options', () => {
    const seed = findSeed(3, 20000, (r) => r.reason === 'nodes');
    const t0 = performance.now();
    const r = Solver.solve(deal(seed, 3));
    const took = performance.now() - t0;
    assertResultShape(r, Solver.DEFAULTS.maxNodes);
    assert.equal(r.solved, false);
    assert.ok(r.reason === 'nodes' || r.reason === 'time');
    if (r.reason === 'nodes') assert.equal(r.nodes, Solver.DEFAULTS.maxNodes);
    else assert.ok(r.ms >= Solver.DEFAULTS.maxMs - 0.001, r.ms.toFixed(2) + ' ms by its own clock');
    assert.ok(took < Solver.DEFAULTS.maxMs + BUSY_MS, took.toFixed(1) + ' ms');
  });

  test('limits that are not finite numbers mean the defaults; negative ones mean zero', () => {
    const seed = findSeed(1, 20000, (r) => r.reason === 'nodes');
    const st = deal(seed, 1);
    const hard = deal(hardSeed(1), 1);
    // Which default ended a search is asserted on a test clock, where it is exact: a fine one
    // (the default maxMs is then far away, the default maxNodes ends the search) and a coarse
    // one (the default maxMs ends a search that has no node limit to speak of).
    const FINE = 1 / 1024; // ms per look at the clock
    const COARSE = 1 / 16;
    for (const bad of [undefined, null, NaN, Infinity, -Infinity, '100', {}, true]) {
      const r = onTestClock(FINE, () => Solver.solve(st, { maxNodes: bad, maxMs: bad })).r;
      assertResultShape(r, Solver.DEFAULTS.maxNodes);
      assert.equal(r.solved, false);
      assert.equal(r.reason, 'nodes');
      assert.equal(r.nodes, Solver.DEFAULTS.maxNodes);
      const timed = onTestClock(COARSE, () => Solver.solve(hard, { maxNodes: 1e9, maxMs: bad }));
      assert.equal(timed.r.reason, 'time');
      assert.equal(timed.reads, Solver.DEFAULTS.maxMs / COARSE + 2, 'looks at the clock for the default maxMs');
      assert.equal(timed.r.ms, Solver.DEFAULTS.maxMs + COARSE);
      // one bad limit does not switch the other one off
      assert.equal(onTestClock(COARSE, () => Solver.solve(st, { maxNodes: 300, maxMs: bad })).r.nodes, 300);
      assert.equal(Solver.solve(st, { maxNodes: bad, maxMs: 0 }).reason, 'time');
    }
    // "no time left" (a deadline that has passed) must not start a search
    assert.deepEqual(
      [Solver.solve(st, { maxMs: -3 }).reason, Solver.solve(st, { maxMs: -3 }).nodes, Solver.solve(st, nodesOnly(-1)).reason, Solver.solve(st, nodesOnly(-1)).nodes],
      ['time', 0, 'nodes', 0]
    );
    for (const opts of [undefined, null, 5, 'x']) {
      assertResultShape(Solver.solve(st, opts), Solver.DEFAULTS.maxNodes);
    }
  });

  test('the same state and limits always give the same nodes and moves', () => {
    for (const drawCount of [1, 3]) {
      const first = [];
      for (let seed = 1; seed <= 40; seed++) first.push(Solver.solve(deal(seed, drawCount), nodesOnly(2500)));
      // again in reverse order, on states that went through serialize / deserialize, with
      // unrelated searches in between
      for (let seed = 40; seed >= 1; seed--) {
        Solver.solve(deal(seed + 1000, 4 - drawCount), nodesOnly(700));
        const st = Engine.deserialize(Engine.serialize(deal(seed, drawCount)));
        const r = Solver.solve(st, nodesOnly(2500));
        const f = first[seed - 1];
        assert.equal(r.solved, f.solved, 'seed ' + seed);
        assert.equal(r.nodes, f.nodes, 'seed ' + seed);
        assert.equal(r.reason, f.reason);
        assert.deepEqual(r.moves, f.moves);
      }
    }
  });
});

// ------------------------------------------------------------------------------------- bad input
describe('solve: bad input never throws', () => {
  test('things that are not states', () => {
    for (const bad of [undefined, null, 0, 42, 'state', [], {}, { piles: {} }, { piles: null, faceUp: [] }, () => {}]) {
      const r = Solver.solve(bad);
      assertResultShape(r, 0);
      assert.equal(r.solved, false);
      assert.equal(r.reason, 'invalid');
    }
  });

  test('broken states', () => {
    const variants = {
      'duplicate card': (s) => {
        s.piles.t0[0] = s.piles.t1[0];
      },
      'missing card': (s) => {
        s.piles.stock.pop();
      },
      'card id out of range': (s) => {
        s.piles.stock[0] = 52;
      },
      'negative card id': (s) => {
        s.piles.stock[0] = -1;
      },
      'fractional card id': (s) => {
        s.piles.stock[3] = 2.5;
      },
      'card id as text': (s) => {
        s.piles.stock[3] = String(s.piles.stock[3]);
      },
      'missing pile': (s) => {
        delete s.piles.t3;
      },
      'pile is not an array': (s) => {
        s.piles.waste = 'none';
      },
      'faceUp too short': (s) => {
        s.faceUp.length = 51;
      },
      'faceUp missing': (s) => {
        delete s.faceUp;
      },
      'a column that ends face-down': (s) => {
        s.faceUp[s.piles.t6[6]] = false;
      },
      'face-down above face-up': (s) => {
        s.faceUp[s.piles.t6[2]] = true;
      },
      'a foundation out of order': (s) => {
        s.piles.f0.push(s.piles.stock.pop() === 0 ? 1 : 5);
      },
    };
    for (const name of Object.keys(variants)) {
      const s = deal(3, 1);
      variants[name](s);
      const text = JSON.stringify(s);
      let r;
      assert.doesNotThrow(() => {
        r = Solver.solve(s);
      }, name);
      assert.equal(r.solved, false, name);
      assert.equal(r.reason, 'invalid', name);
      assert.equal(r.nodes, 0, name);
      assert.equal(JSON.stringify(s), text, name + ': input untouched');
    }
  });

  test('a state the engine refuses to play is never called solved', () => {
    // The piles say "one move from the end", but the state claims to be won already: the engine
    // accepts no action on it, so no line can be replayed to a win.
    const st = deal(findSeed(1, 6000, (r) => r.solved), 1);
    const line = Solver.solve(st, nodesOnly(6000));
    const almost = Engine.clone(st);
    for (let i = 0; i < line.moves.length - 1; i++) Engine.apply(almost, line.moves[i]);
    almost.won = true;
    const r = Solver.solve(almost);
    assert.equal(r.solved, false);
    assert.equal('moves' in r, false);
  });
});

// ------------------------------------------------------------------------------------- seeds
describe('findWinnableSeed', () => {
  function assertSeedResult(r, drawCount) {
    assert.ok(Number.isInteger(r.seed) && r.seed >= 0 && r.seed <= 0xffffffff, 'seed is a uint32');
    assert.equal(typeof r.certified, 'boolean');
    assert.ok(Number.isInteger(r.tried) && r.tried >= 0);
    if (r.certified) {
      assert.ok(r.tried >= 1);
      const st = Engine.newGame({ seed: r.seed, drawCount: drawCount });
      // the line that came with the seed wins the deal ...
      assertWins(st, r.moves, 'certified seed ' + r.seed);
      // ... and solve() certifies the same deal again on its own
      const again = Solver.solve(st, nodesOnly(Solver.DEFAULTS.seedMaxNodes));
      assert.equal(again.solved, true);
      assert.deepEqual(again.moves, r.moves);
    } else {
      assert.equal('moves' in r, false);
    }
  }

  test('returns certified seeds whose solutions replay (random seeds, both draw modes)', () => {
    for (const drawCount of [1, 3]) {
      for (let i = 0; i < 25; i++) {
        const r = Solver.findWinnableSeed({ drawCount: drawCount, budgetMs: 20000 });
        assert.equal(r.certified, true);
        assertSeedResult(r, drawCount);
      }
    }
  });

  test('default options: certified well within the default budget', () => {
    // On the real clock: a call without options comes back with a certified seed, or without
    // one only when its whole budget is used up (on a busy machine that can happen: the budget
    // is wall-clock time).
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      const r = Solver.findWinnableSeed();
      const took = performance.now() - t0;
      assertSeedResult(r, 1);
      if (!r.certified) assert.ok(took >= Solver.DEFAULTS.budgetMs - 1, 'gave up after ' + took.toFixed(1) + ' ms');
      assert.ok(took < Solver.DEFAULTS.budgetMs + BUSY_MS, took.toFixed(1) + ' ms');
    }
    // "Well within" is asserted on a test clock that runs about as fast as one desktop core
    // (1/64 ms per look at the clock, i.e. a million search steps a second). The default budget
    // is then 16000 looks; the longest of 3000 such calls took about 7600.
    const STEP = 1 / 64;
    let certified = 0;
    for (let i = 0; i < 20; i++) {
      const hunt = onTestClock(STEP, () => Solver.findWinnableSeed());
      assertSeedResult(hunt.r, 1);
      assert.ok(hunt.reads <= Solver.DEFAULTS.budgetMs / STEP + 2, hunt.reads + ' looks at the clock');
      if (hunt.r.certified) certified++;
    }
    assert.ok(certified >= 18, certified + ' of 20 certified');
    const r3 = Solver.findWinnableSeed({ drawCount: 3 });
    assertSeedResult(r3, 3);
  });

  test('startSeed: tried first, then a fixed walk; the same call gives the same answer', () => {
    for (const drawCount of [1, 3]) {
      // a start seed that is certified itself
      const good = findSeed(drawCount, Solver.DEFAULTS.seedMaxNodes, (r) => r.solved);
      const a = Solver.findWinnableSeed({ drawCount: drawCount, startSeed: good, budgetMs: 20000 });
      assert.deepEqual({ seed: a.seed, certified: a.certified, tried: a.tried }, { seed: good, certified: true, tried: 1 });
      assertSeedResult(a, drawCount);

      // a start seed that is not: the walk is startSeed + k * 0x9E3779B9
      const hard = findSeed(drawCount, Solver.DEFAULTS.seedMaxNodes, (r) => !r.solved);
      const b = Solver.findWinnableSeed({ drawCount: drawCount, startSeed: hard, budgetMs: 20000 });
      assert.equal(b.certified, true);
      assert.ok(b.tried >= 2);
      assert.equal(b.seed, (hard + (b.tried - 1) * 0x9e3779b9) >>> 0);
      assertSeedResult(b, drawCount);
      const c = Solver.findWinnableSeed({ drawCount: drawCount, startSeed: hard, budgetMs: 20000 });
      assert.deepEqual(c, b);
    }
    // any seed value the engine accepts is accepted here, and read the same way
    const text = Solver.findWinnableSeed({ startSeed: 'daily-2026-11-13', budgetMs: 0 });
    assert.equal(text.seed, RNG.normalizeSeed('daily-2026-11-13'));
    assert.equal(text.seed, Engine.newGame({ seed: 'daily-2026-11-13' }).seed);
  });

  test('rng: seeds come from rng.next()', () => {
    for (const drawCount of [1, 3]) {
      const calls = [];
      const inner = RNG.create(4242 + drawCount);
      const rng = {
        next: function () {
          const v = inner.next();
          calls.push(Math.floor(v * 4294967296) >>> 0);
          return v;
        },
      };
      const r = Solver.findWinnableSeed({ drawCount: drawCount, rng: rng, budgetMs: 20000 });
      assert.equal(r.certified, true);
      assert.equal(calls.length, r.tried);
      assert.equal(r.seed, calls[calls.length - 1]);
      assertSeedResult(r, drawCount);
      // startSeed + rng: the start seed first, the rng after it
      const hard = findSeed(drawCount, Solver.DEFAULTS.seedMaxNodes, (res) => !res.solved);
      const r2 = Solver.findWinnableSeed({ drawCount: drawCount, startSeed: hard, rng: RNG.create(99), budgetMs: 20000 });
      assert.equal(r2.certified, true);
      assert.ok(r2.tried >= 2);
      const sequence = RNG.create(99);
      let expected = hard;
      for (let i = 1; i < r2.tried; i++) expected = Math.floor(sequence.next() * 4294967296) >>> 0;
      assert.equal(r2.seed, expected);
      assertSeedResult(r2, drawCount);
    }
  });

  test('budgetMs: 0 tries nothing and still returns a seed', () => {
    const r = Solver.findWinnableSeed({ budgetMs: 0 });
    assertSeedResult(r, 1);
    assert.equal(r.certified, false);
    assert.equal(r.tried, 0);
    const s = Solver.findWinnableSeed({ budgetMs: 0, startSeed: 123456, drawCount: 3 });
    assert.deepEqual(s, { seed: 123456, certified: false, tried: 0 });
    assert.deepEqual(Solver.findWinnableSeed({ budgetMs: -5, startSeed: 7 }), { seed: 7, certified: false, tried: 0 });
    // a budget that is not a finite number means the default one
    const STEP = 1 / 4; // ms per look at the test clock
    for (const bad of [NaN, Infinity, '50', null]) {
      const t0 = performance.now();
      const r2 = Solver.findWinnableSeed({ budgetMs: bad, startSeed: 7, maxNodes: 10 });
      const took = performance.now() - t0;
      assert.equal(r2.certified, false);
      // 10 nodes certify nothing, so it searched until the budget was used up: the default one
      // (at least that long whatever the machine is doing; BUSY_MS for the other side)
      assert.equal(r2.seed, (7 + r2.tried * 0x9e3779b9) >>> 0, 'the seed after the last one examined');
      assert.ok(took >= Solver.DEFAULTS.budgetMs - 1 && took < Solver.DEFAULTS.budgetMs + BUSY_MS, took.toFixed(1) + ' ms');
      // The same on a test clock: deal after deal, and over at the first look at the clock at
      // or after the default budget (confirmed by one more when that look was inside a deal).
      const hunt = onTestClock(STEP, () => Solver.findWinnableSeed({ budgetMs: bad, startSeed: 7, maxNodes: 10 }));
      const expected = 1 + Solver.DEFAULTS.budgetMs / STEP;
      assert.ok(hunt.reads === expected || hunt.reads === expected + 1, hunt.reads + ' looks at the clock');
      assert.equal(hunt.r.certified, false);
      assert.ok(hunt.r.tried > 10 && hunt.r.tried <= hunt.reads / 2, hunt.r.tried + ' deals in ' + hunt.reads + ' looks');
    }
  });

  test('never throws', () => {
    const boom = {
      next: function () {
        throw new Error('boom');
      },
    };
    for (const opts of [undefined, null, 7, 'x', { rng: boom }, { drawCount: {}, startSeed: [], maxNodes: 'many', rng: 5 }]) {
      const r = Solver.findWinnableSeed(opts);
      assert.equal(typeof r.certified, 'boolean');
      assert.ok(Number.isInteger(r.seed) && r.seed >= 0 && r.seed <= 0xffffffff);
    }
    assert.equal(Solver.findWinnableSeed({ rng: boom }).certified, false);
  });

  test('when the budget runs out: certified false, on time, and the seed is one it has not examined', () => {
    for (const drawCount of [1, 3]) {
      // no deal can be certified with 10 nodes
      const t0 = performance.now();
      const r = Solver.findWinnableSeed({ drawCount: drawCount, budgetMs: 40, maxNodes: 10, startSeed: 1000 });
      const took = performance.now() - t0;
      assertSeedResult(r, drawCount);
      assert.equal(r.certified, false);
      // never early; how late is only bounded loosely here (BUSY_MS), and exactly in the next
      // test, which also counts the deals (how many there were in 40 ms of real time is up to
      // the machine: none at all when the process was kept waiting that long)
      assert.ok(took >= 39 && took < 40 + BUSY_MS, took.toFixed(1) + ' ms for a 40 ms budget');
      assert.equal(r.seed, (1000 + r.tried * 0x9e3779b9) >>> 0, 'the seed after the last one examined');

      // one deal that takes longer than the whole budget
      const hard = hardSeed(drawCount);
      const t1 = performance.now();
      const h = Solver.findWinnableSeed({ drawCount: drawCount, budgetMs: 25, maxNodes: 1e9, startSeed: hard });
      const took1 = performance.now() - t1;
      assert.equal(h.certified, false);
      // It did not get past that deal, and a deal the solver gave up on is not handed back. (The
      // start seed itself comes back only when it was never dealt: the process was kept waiting
      // for the whole budget before the first look at the clock. The next test rules that out.)
      assert.ok(h.tried <= 1, h.tried + ' deals');
      assert.equal(h.seed, (hard + h.tried * 0x9e3779b9) >>> 0, 'the seed after the last one examined');
      assert.ok(took1 >= 24 && took1 < 25 + BUSY_MS, took1.toFixed(1) + ' ms for a 25 ms budget');
    }
  });

  test('on a test clock: the budget ends the search at its first look at the clock after budgetMs', () => {
    const STEP = 1 / 32; // ms per look at the clock
    const hunt = function (opts) {
      const clock = testClock(STEP);
      try {
        const r = Solver.findWinnableSeed(opts);
        return { r: r, reads: clock.reads };
      } finally {
        clock.restore();
      }
    };
    for (const drawCount of [1, 3]) {
      // No deal can be certified with 10 nodes: deal after deal, until the budget is used up. The
      // first reading sets the deadline; the search is over at the first one at or after it, and
      // when that one was taken inside a deal the search confirms it with one more.
      const fast = hunt({ drawCount: drawCount, budgetMs: 40, maxNodes: 10, startSeed: 1000 });
      const expected = 1 + 40 / STEP;
      assert.ok(fast.reads === expected || fast.reads === expected + 1, fast.reads + ' looks at the clock for 40 ms');
      assert.equal(fast.r.certified, false);
      // every deal costs at least two looks (one before it is dealt, one when its search starts)
      assert.ok(fast.r.tried > 10 && fast.r.tried <= fast.reads / 2, fast.r.tried + ' deals in ' + fast.reads + ' looks');
      assert.equal(fast.r.seed, (1000 + fast.r.tried * 0x9e3779b9) >>> 0, 'the seed after the last one examined');
      assert.deepEqual(hunt({ drawCount: drawCount, budgetMs: 40, maxNodes: 10, startSeed: 1000 }), fast, 'the same again');

      // One deal that takes longer than the whole budget: the same deadline, one deal tried.
      const hard = hardSeed(drawCount);
      const slow = hunt({ drawCount: drawCount, budgetMs: 25, maxNodes: 1e9, startSeed: hard });
      assert.equal(slow.reads, 1 + 25 / STEP + 1);
      assert.deepEqual(slow.r, { seed: (hard + 0x9e3779b9) >>> 0, certified: false, tried: 1 });

      // A deal that is certified is found with the same nodes as without any time limit.
      const good = findSeed(drawCount, Solver.DEFAULTS.seedMaxNodes, (res) => res.solved);
      const won = hunt({ drawCount: drawCount, startSeed: good });
      assert.deepEqual({ seed: won.r.seed, certified: won.r.certified, tried: won.r.tried }, { seed: good, certified: true, tried: 1 });
      assert.deepEqual(won.r.moves, Solver.solve(deal(good, drawCount), nodesOnly(Solver.DEFAULTS.seedMaxNodes)).moves);
    }
  });

  test('drawCount: anything but 3 is draw 1, as in the engine', () => {
    for (const dc of [undefined, 1, 2, '3', null]) {
      const r = Solver.findWinnableSeed({ drawCount: dc, startSeed: 77, budgetMs: 20000 });
      assert.equal(r.certified, true);
      assertWins(Engine.newGame({ seed: r.seed, drawCount: 1 }), r.moves, 'draw 1');
    }
  });
});

// ------------------------------------------------------------------------------------- async
describe('findWinnableSeedAsync', () => {
  /**
   * Runs fn() with setTimeout wrapped: counts the zero-delay timers (the solver's yields) and
   * measures every slice (from a timer firing to the next yield, or to the result).
   *
   * @param clock  a testClock() to measure on, without reading it (default: the real clock)
   * @param pause  with a test clock: how much time passes between two slices
   */
  async function watchTimers(fn, clock, pause) {
    const real = globalThis.setTimeout;
    const time = clock ? () => clock.time : () => performance.now();
    const watch = { yields: 0, slices: [], sliceStart: -1 };
    globalThis.setTimeout = function (cb, ms, ...rest) {
      if (ms !== 0) return real(cb, ms, ...rest);
      if (watch.sliceStart >= 0) watch.slices.push(time() - watch.sliceStart);
      watch.sliceStart = -1;
      watch.yields++;
      return real(function () {
        if (clock && pause) clock.advance(pause);
        watch.sliceStart = time();
        cb();
      }, 0);
    };
    try {
      watch.result = await fn();
      if (watch.sliceStart >= 0) watch.slices.push(time() - watch.sliceStart);
    } finally {
      globalThis.setTimeout = real;
    }
    return watch;
  }

  test('returns a promise that resolves with a certified seed whose solution replays', async () => {
    for (const drawCount of [1, 3]) {
      for (let i = 0; i < 8; i++) {
        const p = Solver.findWinnableSeedAsync({ drawCount: drawCount, budgetMs: 20000 });
        assert.ok(p instanceof Promise);
        const r = await p;
        assert.equal(r.certified, true);
        assert.ok(Number.isInteger(r.seed) && r.seed >= 0 && r.seed <= 0xffffffff);
        assert.ok(r.tried >= 1);
        assertWins(Engine.newGame({ seed: r.seed, drawCount: drawCount }), r.moves, 'async seed ' + r.seed);
      }
    }
    const r = await Solver.findWinnableSeedAsync();
    assert.equal(typeof r.certified, 'boolean');
    assert.ok(Number.isInteger(r.seed));
  });

  test('gives the same answer as the synchronous search', async () => {
    for (const drawCount of [1, 3]) {
      for (const startSeed of [1, 500, 90210]) {
        const sync = Solver.findWinnableSeed({ drawCount: drawCount, startSeed: startSeed, budgetMs: 20000 });
        const async_ = await Solver.findWinnableSeedAsync({ drawCount: drawCount, startSeed: startSeed, budgetMs: 20000, sliceMs: 1 });
        assert.deepEqual(async_, sync);
      }
    }
  });

  test('does no work inside the call itself: the first slice runs from a timer', async () => {
    const realNewGame = Engine.newGame;
    let deals = 0;
    Engine.newGame = function (o) {
      deals++;
      return realNewGame.call(Engine, o);
    };
    try {
      const t0 = performance.now();
      const p = Solver.findWinnableSeedAsync({ drawCount: 3, budgetMs: 20000 });
      const took = performance.now() - t0;
      assert.equal(deals, 0, 'nothing dealt yet'); // which is what "the call returns at once" means
      assert.ok(took < BUSY_MS, 'the call returned (' + took.toFixed(2) + ' ms)');
      let settled = false;
      p.then(() => {
        settled = true;
      });
      await Promise.resolve();
      assert.equal(settled, false);
      const r = await p;
      assert.equal(deals, r.tried);
    } finally {
      Engine.newGame = realNewGame;
    }
  });

  test('a search paused across many slices gives exactly the uninterrupted result', async () => {
    for (const drawCount of [1, 3]) {
      // a deal that needs several thousand nodes: many 1 ms slices
      const seed = findSeed(drawCount, Solver.DEFAULTS.seedMaxNodes, (r) => r.solved && r.nodes > 7000);
      const expected = Solver.solve(deal(seed, drawCount), nodesOnly(Solver.DEFAULTS.seedMaxNodes));
      const watch = await watchTimers(() => Solver.findWinnableSeedAsync({ drawCount: drawCount, startSeed: seed, sliceMs: 1, budgetMs: 20000 }));
      const r = watch.result;
      assert.deepEqual({ seed: r.seed, certified: r.certified, tried: r.tried }, { seed: seed, certified: true, tried: 1 });
      assert.deepEqual(r.moves, expected.moves);
      assert.ok(watch.yields >= 3, 'it yielded while searching one deal (' + watch.yields + ' timers)');
      assertWins(deal(seed, drawCount), r.moves, 'sliced search');
    }
  });

  test('yields between slices: the event loop keeps turning while a long search runs', async () => {
    // One deal that would take much longer than the budget of 300 ms, in 5 ms slices. A search
    // that did not yield would be one single slice with no heartbeat between its timers. How
    // long a slice lasts in real time is not asserted here: on a busy machine the process is
    // kept waiting in the middle of one. The next test measures the slices on a test clock.
    const hard = hardSeed(3);
    let beats = 0;
    let lastBeat = performance.now();
    let longestGap = 0;
    let nextBeat = null;
    (function beat() {
      const t = performance.now();
      if (t - lastBeat > longestGap) longestGap = t - lastBeat;
      lastBeat = t;
      beats++;
      nextBeat = setImmediate(beat);
    })();
    const t0 = performance.now();
    const watch = await watchTimers(() => Solver.findWinnableSeedAsync({ drawCount: 3, startSeed: hard, budgetMs: 300, sliceMs: 5, maxNodes: 1e9 }));
    const took = performance.now() - t0;
    clearImmediate(nextBeat); // no beat may run on into the next test: it would read that test's clock
    const r = watch.result;
    assert.equal(r.certified, false);
    assert.equal(r.tried, 1);
    assert.notEqual(r.seed, hard);
    assert.ok(took >= 299 && took < 300 + BUSY_MS, 'resolved when the budget ran out (' + took.toFixed(1) + ' ms)');
    assert.ok(watch.yields >= 3, 'the search was cut into slices (' + watch.yields + ')');
    assert.equal(watch.slices.length, watch.yields);
    assert.ok(beats >= watch.yields, 'other work ran between the slices (' + beats + ' beats)');
    // the search never held the event loop for the whole of its budget, pauses and all
    assert.ok(longestGap < took, 'longest gap between two beats ' + longestGap.toFixed(2) + ' of ' + took.toFixed(1) + ' ms');
  });

  test('on a test clock: a slice ends sliceMs after it began, and the pauses count towards the budget', async () => {
    const STEP = 1 / 16; // ms per look at the clock
    const SLICE = 5;
    const PAUSE = 3; // between two slices
    const BUDGET = 300;
    const hard = hardSeed(3);
    const run = async function () {
      const clock = testClock(STEP);
      try {
        const watch = await watchTimers(
          () => Solver.findWinnableSeedAsync({ drawCount: 3, startSeed: hard, budgetMs: BUDGET, sliceMs: SLICE, maxNodes: 1e9 }),
          clock,
          PAUSE
        );
        watch.elapsed = clock.time - STEP; // since the reading that set the deadline: the very first
        return watch;
      } finally {
        clock.restore();
      }
    };
    const watch = await run();
    assert.deepEqual(watch.result, { seed: (hard + 0x9e3779b9) >>> 0, certified: false, tried: 1 });
    // A slice: the reading that starts it, the search until the first look at the clock at or
    // after sliceMs, one more reading to see that the budget is not used up. Never longer.
    const full = SLICE + 2 * STEP;
    assert.equal(watch.slices.length, watch.yields);
    watch.slices.forEach((ms, i) => {
      if (i < watch.slices.length - 1) assert.equal(ms, full, 'slice ' + i);
      else assert.ok(ms > 0 && ms <= full, 'the last slice is cut short by the budget (' + ms + ' ms)');
    });
    // The budget runs from the call and through the pauses: 300 ms of slice + pause, not 300 ms
    // of search (which would be 59 slices).
    assert.equal(watch.yields, Math.ceil((BUDGET - PAUSE) / (full + PAUSE)));
    assert.equal(watch.yields, 37);
    // It resolved at its first look at the clock after the deadline: at the latest one pause
    // and the two readings that begin a slice after it.
    assert.ok(watch.elapsed >= BUDGET && watch.elapsed <= BUDGET + PAUSE + 2 * STEP, watch.elapsed + ' ms on the test clock');

    // nothing but the clock decided: the same again
    const again = await run();
    assert.deepEqual(again.result, watch.result);
    assert.deepEqual(again.slices, watch.slices);
    assert.equal(again.elapsed, watch.elapsed);
  });

  test('the budget is wall-clock time; budgetMs: 0 resolves at the first slice', async () => {
    // deal after deal fails at once (10 nodes are never enough): the budget still ends the search
    const t0 = performance.now();
    const r = await Solver.findWinnableSeedAsync({ budgetMs: 60, maxNodes: 10, startSeed: 5, sliceMs: 4 });
    const took = performance.now() - t0;
    assert.equal(r.certified, false);
    assert.ok(r.tried > 10, r.tried + ' deals');
    assert.equal(r.seed, (5 + r.tried * 0x9e3779b9) >>> 0);
    assert.ok(took >= 59 && took < 60 + BUSY_MS, took.toFixed(1) + ' ms for a 60 ms budget');

    // The same on a test clock (2 ms pass between two slices): the slices end on time although
    // no single deal ever runs into the end of one, and the pauses are part of the 60 ms.
    const STEP = 1 / 32;
    const clock = testClock(STEP);
    let watch;
    try {
      watch = await watchTimers(() => Solver.findWinnableSeedAsync({ budgetMs: 60, maxNodes: 10, startSeed: 5, sliceMs: 4 }), clock, 2);
    } finally {
      clock.restore();
    }
    assert.equal(watch.result.certified, false);
    assert.ok(watch.result.tried > 10, watch.result.tried + ' deals');
    assert.equal(watch.result.seed, (5 + watch.result.tried * 0x9e3779b9) >>> 0);
    // The clock is looked at before every deal and when its search starts, so a slice ends at
    // the latest one reading after sliceMs (plus the reading that starts it and the one after).
    watch.slices.forEach((ms, i) => {
      if (i < watch.slices.length - 1) assert.ok(ms >= 4 + 2 * STEP && ms <= 4 + 3 * STEP, 'slice ' + i + ': ' + ms + ' ms');
      else assert.ok(ms > 0 && ms <= 4 + 3 * STEP, 'the last slice: ' + ms + ' ms');
    });
    assert.equal(watch.yields, 10, 'ten slices of 4 ms with 2 ms between them in 60 ms');

    const z = await Solver.findWinnableSeedAsync({ budgetMs: 0, startSeed: 31337 });
    assert.deepEqual(z, { seed: 31337, certified: false, tried: 0 });
  });

  test('never rejects, whatever the options', async () => {
    for (const opts of [undefined, null, 7, 'x', { drawCount: 'three', budgetMs: NaN, sliceMs: -4, startSeed: {}, rng: 5, maxNodes: 'many' }]) {
      const r = await Solver.findWinnableSeedAsync(opts);
      assert.equal(typeof r.certified, 'boolean');
      assert.ok(Number.isInteger(r.seed) && r.seed >= 0 && r.seed <= 0xffffffff);
    }
    // an rng that throws: resolved, not certified
    const r = await Solver.findWinnableSeedAsync({
      startSeed: findSeed(1, Solver.DEFAULTS.seedMaxNodes, (res) => !res.solved),
      rng: {
        next: function () {
          throw new Error('boom');
        },
      },
    });
    assert.equal(r.certified, false);
    assert.ok(Number.isInteger(r.seed));
  });

  test('searches running at the same time do not disturb each other', async () => {
    const hard = hardSeed(3);
    const seedA = findSeed(3, Solver.DEFAULTS.seedMaxNodes, (r) => r.solved && r.nodes > 7000);
    const seedB = findSeed(1, Solver.DEFAULTS.seedMaxNodes, (r) => r.solved && r.nodes > 7000);
    const expectedA = Solver.findWinnableSeed({ drawCount: 3, startSeed: seedA, budgetMs: 20000 });
    const expectedB = Solver.findWinnableSeed({ drawCount: 1, startSeed: seedB, budgetMs: 20000 });
    const expectedSolve = Solver.solve(deal(8, 3), nodesOnly(3000));

    const blocker = Solver.findWinnableSeedAsync({ drawCount: 3, startSeed: hard, budgetMs: 120, sliceMs: 1, maxNodes: 1e9 });
    const a = Solver.findWinnableSeedAsync({ drawCount: 3, startSeed: seedA, budgetMs: 20000, sliceMs: 1 });
    const b = Solver.findWinnableSeedAsync({ drawCount: 1, startSeed: seedB, budgetMs: 20000, sliceMs: 1 });
    // synchronous searches in between the slices of the three
    const between = [];
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      between.push(Solver.solve(deal(8, 3), nodesOnly(3000)));
      Solver.findWinnableSeed({ drawCount: 1, startSeed: 40 + i, budgetMs: 20000 });
    }
    assert.deepEqual(await a, expectedA);
    assert.deepEqual(await b, expectedB);
    for (const r of between) {
      assert.equal(r.nodes, expectedSolve.nodes);
      assert.deepEqual(r.moves, expectedSolve.moves);
    }
    const blocked = await blocker;
    assert.equal(blocked.certified, false);
    assert.equal(blocked.tried, 1);
  });
});

// ------------------------------------------------------------------------------------- measurements
describe('measurements (SOLVER_BENCH=1)', () => {
  const N = Number(process.env.SOLVER_BENCH) > 1 ? Number(process.env.SOLVER_BENCH) : 400;

  function summary(values) {
    const s = values.slice().sort((a, b) => a - b);
    return {
      mean: s.reduce((a, b) => a + b, 0) / s.length,
      median: s[Math.floor(s.length / 2)],
      p95: s[Math.floor(s.length * 0.95)],
      max: s[s.length - 1],
    };
  }

  test('certification rate and time per deal at the default limits', { skip: !process.env.SOLVER_BENCH }, async () => {
    for (let i = 0; i < 300; i++) Solver.solve(deal(i, (i & 1) === 0 ? 1 : 3)); // warm up the JIT
    const lines = ['', 'defaults ' + JSON.stringify(Solver.DEFAULTS)];
    for (const drawCount of [1, 3]) {
      const ms = [];
      let solved = 0;
      const reasons = {};
      for (let i = 0; i < N; i++) {
        const st = Engine.newGame({ seed: RNG.randomSeed(), drawCount: drawCount });
        const r = Solver.solve(st);
        ms.push(r.ms);
        reasons[r.reason] = (reasons[r.reason] || 0) + 1;
        if (r.solved) {
          solved++;
          assertWins(st, r.moves, 'bench');
        }
      }
      const t = summary(ms);
      lines.push(
        'solve() draw ' + drawCount + ': ' + N + ' random deals, certified ' + ((100 * solved) / N).toFixed(1) + '%, ms/deal mean ' +
          t.mean.toFixed(2) + ' median ' + t.median.toFixed(2) + ' p95 ' + t.p95.toFixed(2) + ' max ' + t.max.toFixed(2) + '  ' + JSON.stringify(reasons)
      );
    }
    for (const drawCount of [1, 3]) {
      const ms = [];
      let certified = 0;
      let tried = 0;
      for (let i = 0; i < N; i++) {
        const t0 = performance.now();
        const r = Solver.findWinnableSeed({ drawCount: drawCount });
        ms.push(performance.now() - t0);
        tried += r.tried;
        if (r.certified) certified++;
      }
      const t = summary(ms);
      lines.push(
        'findWinnableSeed draw ' + drawCount + ': ' + N + ' calls, certified ' + ((100 * certified) / N).toFixed(1) + '%, ms/call mean ' +
          t.mean.toFixed(2) + ' median ' + t.median.toFixed(2) + ' p95 ' + t.p95.toFixed(2) + ' max ' + t.max.toFixed(2) + ', deals tried mean ' + (tried / N).toFixed(2)
      );
    }
    for (const drawCount of [1, 3]) {
      const ms = [];
      let certified = 0;
      for (let i = 0; i < Math.min(N, 60); i++) {
        const t0 = performance.now();
        const r = await Solver.findWinnableSeedAsync({ drawCount: drawCount });
        ms.push(performance.now() - t0);
        if (r.certified) certified++;
      }
      const t = summary(ms);
      lines.push(
        'findWinnableSeedAsync draw ' + drawCount + ': ' + ms.length + ' calls, certified ' + certified + ', wall ms/call mean ' +
          t.mean.toFixed(2) + ' median ' + t.median.toFixed(2) + ' p95 ' + t.p95.toFixed(2) + ' max ' + t.max.toFixed(2)
      );
    }
    console.log(lines.join('\n'));
  });
});
