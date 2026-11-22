/*
 * SOL.Solver — certifies that a Klondike position is winnable, and finds winnable deals.
 * Pure logic on top of SOL.Engine and SOL.RNG (js/core/engine.js, js/core/rng.js: load them first;
 * in Node they are require()d automatically). No DOM. The only timer is the setTimeout(0) that
 * findWinnableSeedAsync uses to give the page its frames back.
 *
 * PUBLIC API
 *   Solver.solve(state, { maxNodes = 20000, maxMs = 100 } = {})
 *       -> { solved: boolean, moves?: action[], nodes: number, ms: number, reason: string }
 *     Searches for a way to win from `state` (any engine state: a fresh deal or a game in progress,
 *     draw 1 or draw 3). Never mutates `state`, never throws on a bad state.
 *       solved  true only when a winning line was found AND replaying it with Engine.apply on a
 *               clone of `state` ended in a won state. A `false` is not a proof that the deal is lost.
 *       moves   (only when solved) the engine actions to apply in order: { type: 'draw' } and
 *               { type: 'move', card, to }. [] when `state` is already won. Typically 110-200 actions.
 *       nodes   positions examined. Never more than maxNodes; the same state and maxNodes always
 *               give the same count and the same moves (unless maxMs cut the search short).
 *       ms      wall-clock time spent. The clock is read every 16 search steps (about 20 us), so
 *               the search stops within a fraction of a millisecond of maxMs.
 *       reason  (extra) 'solved' | 'nodes' (maxNodes reached) | 'time' (maxMs reached) |
 *               'exhausted' (nothing left to try: the solver believes the position is lost — it
 *               prunes moves, so this is a strong hint, not a proof) | 'invalid' (not a position
 *               the solver can read: see LIMITS).
 *     Both limits are always in force: a limit that is not a finite number means its default
 *     (a negative one means 0: nothing is searched).
 *
 *   Solver.findWinnableSeed({ drawCount = 1, budgetMs = 250, startSeed, rng, maxNodes = 12000 } = {})
 *       -> { seed: uint32, certified: boolean, tried: number, moves?: action[] }
 *     Deals seed after seed (Engine.newGame({ seed, drawCount })) and searches each with at most
 *     `maxNodes` nodes (extra option) until one is certified or `budgetMs` of wall-clock time is used up.
 *       certified true: `seed` is winnable and `moves` (extra) is a winning line for
 *                       Engine.newGame({ seed, drawCount }).
 *       certified false (budget used up): `seed` is the last seed taken from the sequence — one
 *                       the solver has NOT examined, i.e. an ordinary random deal. (A deal the
 *                       solver has just failed on is far less likely to be winnable than a fresh
 *                       one, so a failed seed is never handed back.)
 *       tried     deals examined (0 when budgetMs <= 0).
 *     Never throws (an rng that throws gives an uncertified random seed).
 *     Seed sequence: `startSeed` first when given; after that `rng.next()` values when an rng
 *     ({ next() -> [0,1) }, e.g. SOL.RNG.create(n)) is given, else startSeed + k * 0x9E3779B9
 *     (deterministic) when a startSeed was given, else SOL.RNG.randomSeed().
 *
 *   Solver.findWinnableSeedAsync({ drawCount = 1, budgetMs = 1500, sliceMs = 12, startSeed, rng, maxNodes } = {})
 *       -> Promise<{ seed, certified, tried, moves? }>      never rejects
 *     The same search cut into slices of at most `sliceMs` of work with a setTimeout(0) between
 *     them (the first slice also runs from a timer, so the call itself returns at once). A search
 *     in progress is paused and resumed across slices, so no slice overruns however slow the
 *     device is. `budgetMs` is wall-clock time from the call, pauses included.
 *
 *   Solver.DEFAULTS (frozen): { maxNodes, maxMs, seedMaxNodes, budgetMs, asyncBudgetMs, sliceMs }
 *
 * WHAT TO EXPECT (Node 22 on one desktop core, 4600 random deals per draw mode; to measure again:
 *                 SOLVER_BENCH=1 node --test tests/solver.test.js)
 *   About 82% of draw-3 deals and 90% of draw-1 deals are winnable at all. With the default
 *   limits solve() certifies 78% of random draw-3 deals and 88% of draw-1 deals; a deal takes
 *   about 3 ms on average (median 0.2 ms, 95th percentile about 20 ms). findWinnableSeed returns
 *   a certified seed in about 2 ms on average (95th percentile about 12 ms, 1.2 deals tried).
 *   In Chromium with the CPU throttled 4x (roughly a mid-range phone) findWinnableSeedAsync takes
 *   about 25 ms on average (95th percentile about 170 ms) and the page keeps drawing 60 frames a
 *   second meanwhile; a slice lasts sliceMs, give or take 2 ms.
 *
 * HOW IT WORKS
 *   - It searches its own compact copy of the position (typed arrays, incremental 64-bit hash),
 *     never engine states: about a million positions per second. Soundness does not rest on that
 *     model: a line is only reported after the real engine has replayed it to a win.
 *   - Stock and waste are one "talon": a move is "draw until card X is on the waste, play X", so
 *     drawing costs no search depth. Draw 1 reaches every talon card; draw 3 reaches every third
 *     one of this pass and of the pass after a recycle.
 *   - Pointless moves are pruned: a run moves whole (to uncover a card, or to empty a column when
 *     a King still needs one) or in part only when that frees a card for its foundation; a King
 *     resting at the bottom of a column stays there; only one empty column is tried; a foundation
 *     card comes back down only when it could still serve as a base.
 *   - A card that can go to its foundation and can never be needed as a base again is played at
 *     once and nothing else is tried there (the "always safe" moves).
 *   - Move order: foundation, uncover a card, King to an empty column, talon to foundation, talon
 *     to tableau, the rest; fewer draws first.
 *   - Depth-first search with restarts: every ATTEMPT_NODES nodes it goes back to the start and
 *     shuffles the move order (seeded by the position, so runs repeat exactly). Positions proven
 *     dead are remembered across restarts (Tarjan's SCC bookkeeping makes that exact even though
 *     moves can be taken back), so no dead end is searched twice.
 *
 * LIMITS
 *   - reason 'invalid': anything but 52 distinct cards over the 13 piles, a face-down card above a
 *     face-up one in a column, or a foundation that is not A..n of its suit in order. Every state
 *     the engine produces is valid.
 *   - Not complete: the pruning and the limits can miss a win. It never reports a false one.
 */
(function (root) {
  'use strict';

  const SOL = (root.SOL = root.SOL || {});

  let Engine = SOL.Engine;
  let RNG = SOL.RNG;
  if (typeof require === 'function') {
    if (!Engine) Engine = require('./engine.js');
    if (!RNG) RNG = require('./rng.js');
  }

  /** SOL.Engine, resolved late so that the script order cannot break the solver silently. */
  function E() {
    if (!Engine) Engine = SOL.Engine;
    if (!Engine) throw new Error('SOL.Solver needs SOL.Engine: load js/core/engine.js first');
    return Engine;
  }

  /** A uint32 seed from SOL.RNG; Math.random only when that module is missing. */
  function randomSeed() {
    if (!RNG) RNG = SOL.RNG;
    if (RNG && typeof RNG.randomSeed === 'function') return RNG.randomSeed() >>> 0;
    return Math.floor(Math.random() * 4294967296) >>> 0;
  }

  function normalizeSeed(seed) {
    if (!RNG) RNG = SOL.RNG;
    if (RNG && typeof RNG.normalizeSeed === 'function') return RNG.normalizeSeed(seed);
    return typeof seed === 'number' && isFinite(seed) ? seed >>> 0 : 0;
  }

  const perf = root.performance && typeof root.performance.now === 'function' ? root.performance : null;
  function now() {
    return perf ? perf.now() : Date.now();
  }

  // ------------------------------------------------------------------ defaults
  const DEFAULTS = Object.freeze({
    maxNodes: 20000, // solve(): positions examined
    maxMs: 100, // solve(): wall-clock limit — short enough that one call is a hitch, never a freeze
    seedMaxNodes: 12000, // findWinnableSeed*: nodes spent on one deal before moving on to the next
    budgetMs: 250, // findWinnableSeed
    asyncBudgetMs: 1500, // findWinnableSeedAsync
    sliceMs: 12, // findWinnableSeedAsync: work between two yields
  });

  // ------------------------------------------------------------------ card tables
  const SUIT = new Uint8Array(52);
  const RANK = new Uint8Array(52);
  const RED = new Uint8Array(52);
  // A card `c` may be placed on a column whose top card `t` has KEY[t] === WANT[c]
  // (one rank higher, other colour). Kings want a key no card has.
  const KEY = new Uint8Array(52);
  const WANT = new Uint8Array(52);
  for (let c = 0; c < 52; c++) {
    SUIT[c] = (c / 13) | 0;
    RANK[c] = (c % 13) + 1;
    RED[c] = SUIT[c] & 1;
    KEY[c] = RANK[c] * 2 + RED[c];
    WANT[c] = (RANK[c] + 1) * 2 + (1 - RED[c]);
  }
  const TPILE = ['t0', 't1', 't2', 't3', 't4', 't5', 't6'];
  const FPILE = ['f0', 'f1', 'f2', 'f3'];

  // ------------------------------------------------------------------ position hash (Zobrist)
  // Two independent 32-bit words. What is hashed:
  //   - every face-up tableau card together with the card it lies on (52 = the bottom of a column).
  //     Face-down cards never move, so this fixes the whole tableau — and it does not depend on
  //     which column is which: positions that differ only by swapping whole columns are the same.
  //   - every card still in the talon, and (draw 3 only) where the waste ends when that matters.
  // The foundations follow from the rest. A hash collision can only make the search skip a
  // position (lose a win), never invent one.
  const ZA = new Int32Array(52 * 53);
  const ZB = new Int32Array(52 * 53);
  const ZTA = new Int32Array(52);
  const ZTB = new Int32Array(52);
  const ZPA = new Int32Array(64);
  const ZPB = new Int32Array(64);
  (function () {
    let a = 0x5eed1234; // fixed: node counts must be the same on every run and every machine
    function next() {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (t ^ (t >>> 14)) | 0;
    }
    for (let i = 0; i < ZA.length; i++) {
      ZA[i] = next();
      ZB[i] = next();
    }
    for (let i = 0; i < 52; i++) {
      ZTA[i] = next();
      ZTB[i] = next();
    }
    for (let i = 1; i < 64; i++) {
      ZPA[i] = next();
      ZPB[i] = next();
    }
  })();

  // ------------------------------------------------------------------ search constants
  const MAX_DEPTH = 512; // moves on the current line (a win takes 100-150); deeper nodes are cut off
  const MAX_MOVES = 128; // candidate moves kept per node
  const STRIDE = 64; // slots per tableau column in the flat array (a column never exceeds 52)

  // Move = one int. bits 0-2 kind, 3-5 source column / suit, 6-8 target column,
  // 9-14 index of the run's first card (K_TT) or talon position q (talon moves),
  // 15-21 draw actions needed first (talon moves), 22-30 priority (so sorting ints sorts moves).
  const K_TF = 0; // tableau top -> foundation
  const K_TT = 1; // tableau run -> tableau
  const K_WF = 2; // talon -> foundation
  const K_WT = 3; // talon -> tableau
  const K_FT = 4; // foundation -> tableau

  // Priorities (higher = tried first). The gaps matter less than the order.
  const P_TF = 200; // to the foundation ...
  const P_TF_REVEAL = 230; // ... and it uncovers a face-down card
  const P_REVEAL = 180; // a run moves away from a face-down card
  const P_KING_REVEAL = 175; // the same, onto an empty column
  const P_WF = 170; // talon -> foundation
  const P_WT = 120; // talon -> tableau
  const P_WK = 115; // talon King -> empty column
  const P_PARTIAL = 110; // split a run to free a card for its foundation
  const P_EMPTY = 100; // empty a column for a King
  const P_FT = 20; // take a card back from a foundation
  // (one point less per draw action a talon move needs: nearer cards first, shorter solutions)

  // Restarts. The first attempt follows the priorities exactly; later ones add NOISE to every
  // priority, i.e. try the moves in a nearly random order. Measured on 2000 deals: within 5000
  // nodes this certifies 74% of draw-3 deals and 86% of draw-1 deals, against 65% and 77% for one
  // single attempt. Attempts of 100-400 nodes and noise of 100-250 all do about as well.
  const ATTEMPT_NODES = 200;
  const NOISE = 160;

  const ST_RUNNING = 0;
  const ST_SOLVED = 1;
  const ST_EXHAUSTED = 2;
  const ST_NODES = 3;
  const ST_TIME = 4;
  const ST_INVALID = 5;
  const REASONS = ['time', 'solved', 'exhausted', 'nodes', 'time', 'invalid'];

  const MAX_NODES = 1e9; // visit numbers are stored as int32
  // Transposition table: slots of 16 bytes, at most half full. It is sized for the node limit when
  // a search starts (20000 nodes: 1 MB) and doubles only if that was not enough.
  const MIN_CAP = 1 << 14;
  const MAX_CAP = 1 << 21; // 32 MB: beyond that the table stops taking new positions
  const KEEP_CAP = 1 << 16; // a larger table is given back after the search (memory on phones)

  /**
   * One resumable search with its own buffers. load(state) starts it; run(nodeLimit, deadline)
   * continues it and can be called again after ST_NODES / ST_TIME.
   */
  function createSearcher() {
    // ---- the position
    const tab = new Int8Array(7 * STRIDE); // column t: tab[t * STRIDE + i], bottom -> top
    const len = new Int32Array(7);
    const down = new Int32Array(7); // face-down cards at the bottom of each column
    const fnd = new Int32Array(4); // cards on each foundation (= rank of its top card)
    // Talon: the waste bottom -> top, then the stock top -> bottom. Drawing and recycling only move
    // the boundary `tp` (= waste size), so the order never changes: tal[q - 1] is the waste top after
    // drawing up to position q.
    const tal = new Int8Array(64);
    let tn = 0;
    let tp = 0;
    let dc = 1;
    let fsum = 0; // cards on the foundations
    let hA = 0;
    let hB = 0;

    // ---- the line being explored: node d is reached by path[d - 1]
    const mv = new Int32Array(MAX_DEPTH * MAX_MOVES);
    const mvCur = new Int32Array(MAX_DEPTH + 1);
    const mvEnd = new Int32Array(MAX_DEPTH + 1);
    const path = new Int32Array(MAX_DEPTH + 1);
    const uCard = new Int8Array(MAX_DEPTH + 1); // the card (first card of the run) path[d] moved
    const uFlip = new Uint8Array(MAX_DEPTH + 1); // it turned a card face-up
    const uCnt = new Uint8Array(MAX_DEPTH + 1); // cards in the run
    const uTp = new Int32Array(MAX_DEPTH + 1); // tp before it
    const uHA = new Int32Array(MAX_DEPTH + 1); // hash before it
    const uHB = new Int32Array(MAX_DEPTH + 1);
    let depth = 0;
    let nodes = 0;
    let status = ST_INVALID;

    // ---- restarts
    let attemptEnd = 0;
    let noise = 0;
    let rs = 1;

    // ---- transposition table (open addressing; kG === gen marks a slot of the current search)
    // kV: -1 = dead (no win below it, ever); otherwise the visit number the position got when it
    // was entered. A visit number older than `attemptStart` belongs to an abandoned attempt and
    // means nothing; a current one means "open or parked": being explored right now, or explored
    // but still depending on an open position (see closeNode).
    let cap = MIN_CAP;
    let mask = cap - 1;
    let used = 0;
    let gen = 0;
    let kA = new Int32Array(cap);
    let kB = new Int32Array(cap);
    let kG = new Uint32Array(cap);
    let kV = new Int32Array(cap);
    let vis = 0;
    let attemptStart = 0;
    const idx = new Int32Array(MAX_DEPTH + 2); // visit number of the node at depth d
    const low = new Int32Array(MAX_DEPTH + 2); // oldest open/parked position its subtree reaches
    const tsBase = new Int32Array(MAX_DEPTH + 2);
    let tsA = new Int32Array(1024); // parked positions (their hashes), in closing order
    let tsB = new Int32Array(1024);
    let ts = 0;

    // ---- scratch for generate()
    const acc = new Int32Array(32); // KEY of a column's top card -> bit mask of such columns
    const topKey = new Int32Array(7);

    function rnd() {
      rs = (rs + 0x6d2b79f5) | 0;
      let t = Math.imul(rs ^ (rs >>> 15), 1 | rs);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (t ^ (t >>> 14)) >>> 0;
    }

    function allocTable(n) {
      cap = n;
      mask = n - 1;
      kA = new Int32Array(n);
      kB = new Int32Array(n);
      kG = new Uint32Array(n);
      kV = new Int32Array(n);
    }

    /**
     * Forgets every position (a new generation instead of clearing megabytes) and makes room for
     * `expect` of them, so that the table does not have to grow — a pause of several ms once it
     * is large — in the middle of a search.
     */
    function resetTable(expect) {
      let want = MIN_CAP;
      while (want < MAX_CAP && want < expect * 2 + 2) want *= 2;
      if (cap < want || (cap > want && cap > KEEP_CAP)) {
        allocTable(want);
        gen = 0;
      }
      gen++;
      if (gen >= 0xfffffff0) {
        kG.fill(0);
        gen = 1;
      }
      used = 0;
    }

    function grow() {
      const oA = kA;
      const oB = kB;
      const oG = kG;
      const oV = kV;
      const oCap = cap;
      allocTable(oCap * 2);
      for (let i = 0; i < oCap; i++) {
        if (oG[i] !== gen) continue;
        let j = oA[i] & mask;
        while (kG[j] === gen) j = (j + 1) & mask;
        kG[j] = gen;
        kA[j] = oA[i];
        kB[j] = oB[i];
        kV[j] = oV[i];
      }
    }

    /**
     * Looks the current position up as a child of the node at depth d (d = -1: it is the root).
     * true = do not enter it: it is dead, or it is open/parked in this attempt (then the parent
     * learns how far back its subtree reaches). false = it is new, or left over from an abandoned
     * attempt, and now carries the visit number `vis`.
     */
    function seen(d) {
      let i = hA & mask;
      while (kG[i] === gen) {
        if (kA[i] === hA && kB[i] === hB) {
          const v = kV[i];
          if (v === -1) return true;
          if (v < attemptStart) {
            kV[i] = vis;
            return false;
          }
          if (v < low[d]) low[d] = v;
          return true;
        }
        i = (i + 1) & mask;
      }
      if (used * 2 >= cap) {
        if (cap >= MAX_CAP) {
          // Full. The position is searched without being remembered; a line that runs in circles
          // because of that ends at MAX_DEPTH, and maxNodes / maxMs bound the whole search anyway.
          if (used * 4 >= cap * 3) return false;
        } else {
          grow();
          i = hA & mask;
          while (kG[i] === gen) i = (i + 1) & mask;
        }
      }
      kG[i] = gen;
      kA[i] = hA;
      kB[i] = hB;
      kV[i] = vis;
      used++;
      return false;
    }

    function markDead(a, b) {
      let i = a & mask;
      while (kG[i] === gen) {
        if (kA[i] === a && kB[i] === b) {
          kV[i] = -1;
          return;
        }
        i = (i + 1) & mask;
      }
    }

    /**
     * The node at depth d (the current position) has no move left. Taking a move back can lead
     * to a position that is still open higher up the line, so "no win found below" is only final
     * when nothing below this node reaches an older open position (Tarjan: the node is the root
     * of its strongly connected component). Then it is dead, and so is everything parked since
     * it was entered. Otherwise it is parked until the position it depends on is resolved.
     */
    function closeNode(d) {
      const lo = low[d];
      if (lo === idx[d]) {
        markDead(hA, hB);
        let n = ts;
        const b = tsBase[d];
        while (n > b) {
          n--;
          markDead(tsA[n], tsB[n]);
        }
        ts = b;
      } else {
        if (ts === tsA.length) {
          const nA = new Int32Array(ts * 2);
          const nB = new Int32Array(ts * 2);
          nA.set(tsA);
          nB.set(tsB);
          tsA = nA;
          tsB = nB;
        }
        tsA[ts] = hA;
        tsB[ts] = hB;
        ts++;
        if (d > 0 && lo < low[d - 1]) low[d - 1] = lo;
      }
    }

    /**
     * The part of the waste boundary that changes what can be reached. Draw 1: nothing (every
     * talon card is reachable from anywhere). Draw 3: a boundary on a multiple of 3, or at the
     * end, reaches exactly what a freshly recycled stock reaches.
     */
    function pcode() {
      if (dc === 1) return 0;
      return tp % 3 === 0 || tp === tn ? 0 : tp;
    }

    /**
     * Reads an engine state and gets ready to search it for about `expectNodes` nodes.
     * false (status ST_INVALID) when it is not a position the solver models.
     */
    function load(state, expectNodes) {
      status = ST_INVALID;
      nodes = 0;
      depth = 0;
      if (!state || typeof state !== 'object') return false;
      const p = state.piles;
      const fu = state.faceUp;
      if (!p || typeof p !== 'object' || !Array.isArray(fu) || fu.length !== 52) return false;
      const taken = new Uint8Array(52);
      let total = 0;
      function take(c) {
        if (typeof c !== 'number' || c !== (c | 0) || c < 0 || c > 51 || taken[c] === 1) return false;
        taken[c] = 1;
        total++;
        return true;
      }

      fsum = 0;
      for (let s = 0; s < 4; s++) {
        const f = p[FPILE[s]];
        if (!Array.isArray(f) || f.length > 13) return false;
        for (let i = 0; i < f.length; i++) {
          if (f[i] !== s * 13 + i || !take(f[i])) return false; // A..n of its suit, in order
        }
        fnd[s] = f.length;
        fsum += f.length;
      }

      hA = 0;
      hB = 0;
      for (let t = 0; t < 7; t++) {
        const col = p[TPILE[t]];
        if (!Array.isArray(col) || col.length > 52) return false;
        let d = 0;
        for (let i = 0; i < col.length; i++) {
          const c = col[i];
          if (!take(c)) return false;
          tab[t * STRIDE + i] = c;
          if (fu[c] === true) {
            const z = c * 53 + (i > 0 ? col[i - 1] : 52);
            hA ^= ZA[z];
            hB ^= ZB[z];
          } else {
            if (d !== i) return false; // face-down above face-up
            d++;
          }
        }
        if (col.length > 0 && d === col.length) return false; // a column ends face-up
        len[t] = col.length;
        down[t] = d;
      }

      const waste = p.waste;
      const stock = p.stock;
      if (!Array.isArray(waste) || !Array.isArray(stock)) return false;
      tn = 0;
      for (let i = 0; i < waste.length; i++) {
        if (!take(waste[i])) return false;
        tal[tn++] = waste[i];
      }
      tp = tn;
      for (let i = stock.length - 1; i >= 0; i--) {
        if (!take(stock[i])) return false;
        tal[tn++] = stock[i];
      }
      if (total !== 52) return false;

      dc = state.drawCount === 3 ? 3 : 1; // as the engine reads it
      for (let i = 0; i < tn; i++) {
        hA ^= ZTA[tal[i]];
        hB ^= ZTB[tal[i]];
      }
      const pc = pcode();
      hA ^= ZPA[pc];
      hB ^= ZPB[pc];

      status = ST_RUNNING;
      attemptEnd = ATTEMPT_NODES;
      noise = 0;
      rs = hA ^ 0x2545f491; // the shuffled orders depend on the position only: runs repeat exactly
      resetTable(expectNodes);
      vis = 0;
      for (let i = 0; i < 7; i++) topKey[i] = 0;
      acc.fill(0);
      enterRoot();
      return true;
    }

    /** (Re)starts an attempt at the root: whatever the last attempt left open is stale from now on. */
    function enterRoot() {
      depth = 0;
      ts = 0;
      attemptStart = vis;
      seen(-1);
      idx[0] = vis;
      low[0] = vis;
      tsBase[0] = 0;
      vis++;
      generate(0);
    }

    /** Is there a King that could still use an empty column (in the talon, or not at the bottom of a column)? */
    function kingWaiting() {
      for (let i = 0; i < tn; i++) if (RANK[tal[i]] === 13) return true;
      for (let t = 0; t < 7; t++) {
        const o = t * STRIDE;
        for (let i = len[t] - 1; i > 0; i--) if (RANK[tab[o + i]] === 13) return true;
      }
      return false;
    }

    /**
     * A card of suit s and rank r that can go to its foundation: can it never be wanted in the
     * tableau again? Yes when the cards it could carry (other colour, one lower) are already home
     * or can go home without it.
     */
    function isSafe(s, r) {
      if (r <= 2) return true;
      const a = fnd[(s + 1) & 3];
      const b = fnd[(s + 3) & 3];
      const m = a < b ? a : b;
      return m >= r - 1 || (m >= r - 2 && fnd[(s + 2) & 3] >= r - 3);
    }

    /** Lists the moves of the current position for the node at depth d, best first. */
    function generate(d) {
      const base = d * MAX_MOVES;
      let cnt = 0;
      mvCur[d] = base;

      // ---- always-safe foundation moves: play the first one, try nothing else here
      for (let t = 0; t < 7; t++) {
        const n = len[t];
        if (n === 0) continue;
        const c = tab[t * STRIDE + n - 1];
        const r = RANK[c];
        if (fnd[SUIT[c]] === r - 1 && isSafe(SUIT[c], r)) {
          mv[base] = K_TF | (t << 3);
          mvEnd[d] = base + 1;
          return;
        }
      }
      if (dc === 1) {
        // (draw 3 is left out: taking a card out of the talon changes which cards come up)
        for (let i = 0; i < tn; i++) {
          const c = tal[i];
          const r = RANK[c];
          if (fnd[SUIT[c]] === r - 1 && isSafe(SUIT[c], r)) {
            const q = i + 1;
            mv[base] = K_WF | (q << 9) | ((q >= tp ? q - tp : tn - tp + 1 + q) << 15);
            mvEnd[d] = base + 1;
            return;
          }
        }
      }

      // ---- which column tops accept what
      let emptyCol = -1;
      for (let t = 0; t < 7; t++) acc[topKey[t]] = 0;
      for (let t = 0; t < 7; t++) {
        const n = len[t];
        if (n === 0) {
          topKey[t] = 0;
          if (emptyCol < 0) emptyCol = t;
        } else {
          const k = KEY[tab[t * STRIDE + n - 1]];
          topKey[t] = k;
          acc[k] |= 1 << t;
        }
      }

      let kw = -1; // kingWaiting(), computed when first needed

      // ---- tableau
      for (let s = 0; s < 7; s++) {
        const n = len[s];
        if (n === 0) continue;
        const so = s * STRIDE;
        const j0 = down[s];
        const top = tab[so + n - 1];
        if (fnd[SUIT[top]] === RANK[top] - 1) {
          const pr = n - 1 === j0 && j0 > 0 ? P_TF_REVEAL : P_TF;
          if (cnt < MAX_MOVES) mv[base + cnt++] = (pr << 22) | K_TF | (s << 3);
        }
        // the whole face-up run
        const b = tab[so + j0];
        let m = acc[WANT[b]] & ~(1 << s);
        if (m !== 0) {
          let pr = P_REVEAL;
          if (j0 === 0) {
            // it would only empty the column: worth it when a King can use the space
            if (kw < 0) kw = kingWaiting() ? 1 : 0;
            if (kw === 0) m = 0;
            pr = P_EMPTY;
          }
          while (m !== 0) {
            const t = 31 - Math.clz32(m);
            m ^= 1 << t;
            if (cnt < MAX_MOVES) mv[base + cnt++] = (pr << 22) | K_TT | (s << 3) | (t << 6) | (j0 << 9);
          }
        } else if (RANK[b] === 13 && j0 > 0 && emptyCol >= 0) {
          if (cnt < MAX_MOVES) mv[base + cnt++] = (P_KING_REVEAL << 22) | K_TT | (s << 3) | (emptyCol << 6) | (j0 << 9);
        }
        // part of the run: only to free the card below it for its foundation
        for (let j = j0 + 1; j < n; j++) {
          const e = tab[so + j - 1];
          if (fnd[SUIT[e]] !== RANK[e] - 1) continue;
          let pm = acc[WANT[tab[so + j]]] & ~(1 << s);
          while (pm !== 0) {
            const t = 31 - Math.clz32(pm);
            pm ^= 1 << t;
            if (cnt < MAX_MOVES) mv[base + cnt++] = (P_PARTIAL << 22) | K_TT | (s << 3) | (t << 6) | (j << 9);
          }
        }
      }

      // ---- talon: every card that can be brought to the top of the waste, with the draws it costs
      if (tn > 0) {
        if (dc === 1) {
          for (let q = 1; q <= tn; q++) cnt = addTalon(base, cnt, q, q >= tp ? q - tp : tn - tp + 1 + q, emptyCol);
        } else {
          let k = 0;
          let q = tp;
          if (q > 0) cnt = addTalon(base, cnt, q, 0, emptyCol);
          while (q < tn) {
            q = q + 3 < tn ? q + 3 : tn;
            k++;
            cnt = addTalon(base, cnt, q, k, emptyCol);
          }
          if (tp > 0) {
            k++; // the recycle
            q = 0;
            while (q < tn) {
              q = q + 3 < tn ? q + 3 : tn;
              k++;
              if (q >= tp && ((q - tp) % 3 === 0 || q === tn)) continue; // came up in this pass already
              cnt = addTalon(base, cnt, q, k, emptyCol);
            }
          }
        }
      }

      // ---- foundation -> tableau: the way out when a card went home too early
      for (let s = 0; s < 4; s++) {
        const r = fnd[s];
        if (r < 3 || isSafe(s, r)) continue; // the safe rule would send it straight back
        let m = acc[WANT[s * 13 + r - 1]];
        while (m !== 0) {
          const t = 31 - Math.clz32(m);
          m ^= 1 << t;
          if (cnt < MAX_MOVES) mv[base + cnt++] = (P_FT << 22) | K_FT | (s << 3) | (t << 6);
        }
      }

      if (noise > 0) {
        for (let i = 0; i < cnt; i++) mv[base + i] += (rnd() % noise) << 22;
      }
      // best first (insertion sort: a handful of moves)
      for (let i = 1; i < cnt; i++) {
        const m = mv[base + i];
        let j = i - 1;
        while (j >= 0 && mv[base + j] < m) {
          mv[base + j + 1] = mv[base + j];
          j--;
        }
        mv[base + j + 1] = m;
      }
      mvEnd[d] = base + cnt;
    }

    /** generate() helper: the moves of the talon card at position q, reached after k draw actions. */
    function addTalon(base, cnt, q, k, emptyCol) {
      const c = tal[q - 1];
      const r = RANK[c];
      const tail = (q << 9) | (k << 15);
      if (fnd[SUIT[c]] === r - 1) {
        if (cnt < MAX_MOVES) mv[base + cnt++] = ((P_WF - k) << 22) | K_WF | tail;
      }
      let m = acc[WANT[c]];
      while (m !== 0) {
        const t = 31 - Math.clz32(m);
        m ^= 1 << t;
        if (cnt < MAX_MOVES) mv[base + cnt++] = ((P_WT - k) << 22) | K_WT | (t << 6) | tail;
      }
      if (r === 13 && emptyCol >= 0) {
        if (cnt < MAX_MOVES) mv[base + cnt++] = ((P_WK - k) << 22) | K_WT | (emptyCol << 6) | tail;
      }
      return cnt;
    }

    /** Plays move m from the node at depth d (position and hash), remembering how to take it back. */
    function applyMove(m, d) {
      const kind = m & 7;
      uFlip[d] = 0;
      if (kind === K_TF) {
        const s = (m >> 3) & 7;
        const o = s * STRIDE;
        const n = len[s] - 1;
        const c = tab[o + n];
        uCard[d] = c;
        let z = c * 53 + (n > 0 ? tab[o + n - 1] : 52);
        hA ^= ZA[z];
        hB ^= ZB[z];
        len[s] = n;
        fnd[SUIT[c]]++;
        fsum++;
        if (n > 0 && down[s] === n) {
          down[s] = n - 1;
          uFlip[d] = 1;
          z = tab[o + n - 1] * 53 + (n > 1 ? tab[o + n - 2] : 52);
          hA ^= ZA[z];
          hB ^= ZB[z];
        }
      } else if (kind === K_TT) {
        const s = (m >> 3) & 7;
        const t = (m >> 6) & 7;
        const j = (m >> 9) & 63;
        const so = s * STRIDE;
        const to = t * STRIDE;
        const tl = len[t];
        const cnt = len[s] - j;
        const b = tab[so + j];
        uCard[d] = b;
        uCnt[d] = cnt;
        // only the run's first card changes what it lies on
        let z = b * 53 + (j > 0 ? tab[so + j - 1] : 52);
        hA ^= ZA[z];
        hB ^= ZB[z];
        z = b * 53 + (tl > 0 ? tab[to + tl - 1] : 52);
        hA ^= ZA[z];
        hB ^= ZB[z];
        for (let i = 0; i < cnt; i++) tab[to + tl + i] = tab[so + j + i];
        len[t] = tl + cnt;
        len[s] = j;
        if (j > 0 && down[s] === j) {
          down[s] = j - 1;
          uFlip[d] = 1;
          z = tab[so + j - 1] * 53 + (j > 1 ? tab[so + j - 2] : 52);
          hA ^= ZA[z];
          hB ^= ZB[z];
        }
      } else if (kind === K_FT) {
        const s = (m >> 3) & 7;
        const t = (m >> 6) & 7;
        const c = s * 13 + fnd[s] - 1;
        uCard[d] = c;
        fnd[s]--;
        fsum--;
        const to = t * STRIDE;
        const tl = len[t];
        const z = c * 53 + (tl > 0 ? tab[to + tl - 1] : 52);
        hA ^= ZA[z];
        hB ^= ZB[z];
        tab[to + tl] = c;
        len[t] = tl + 1;
      } else {
        // talon card q leaves; the waste now ends just below it
        const q = (m >> 9) & 63;
        const c = tal[q - 1];
        uCard[d] = c;
        uTp[d] = tp;
        let pc = pcode();
        hA ^= ZPA[pc] ^ ZTA[c];
        hB ^= ZPB[pc] ^ ZTB[c];
        for (let i = q; i < tn; i++) tal[i - 1] = tal[i];
        tn--;
        tp = q - 1;
        pc = pcode();
        hA ^= ZPA[pc];
        hB ^= ZPB[pc];
        if (kind === K_WF) {
          fnd[SUIT[c]]++;
          fsum++;
        } else {
          const t = (m >> 6) & 7;
          const to = t * STRIDE;
          const tl = len[t];
          const z = c * 53 + (tl > 0 ? tab[to + tl - 1] : 52);
          hA ^= ZA[z];
          hB ^= ZB[z];
          tab[to + tl] = c;
          len[t] = tl + 1;
        }
      }
    }

    function undoMove(m, d) {
      const kind = m & 7;
      const c = uCard[d];
      if (kind === K_TF) {
        const s = (m >> 3) & 7;
        const n = len[s];
        if (uFlip[d] === 1) down[s] = n;
        tab[s * STRIDE + n] = c;
        len[s] = n + 1;
        fnd[SUIT[c]]--;
        fsum--;
      } else if (kind === K_TT) {
        const s = (m >> 3) & 7;
        const t = (m >> 6) & 7;
        const j = (m >> 9) & 63;
        const cnt = uCnt[d];
        const so = s * STRIDE;
        const to = t * STRIDE;
        const tl = len[t] - cnt;
        if (uFlip[d] === 1) down[s] = j;
        for (let i = 0; i < cnt; i++) tab[so + j + i] = tab[to + tl + i];
        len[s] = j + cnt;
        len[t] = tl;
      } else if (kind === K_FT) {
        fnd[(m >> 3) & 7]++;
        fsum++;
        len[(m >> 6) & 7]--;
      } else {
        const q = (m >> 9) & 63;
        for (let i = tn; i >= q; i--) tal[i] = tal[i - 1];
        tal[q - 1] = c;
        tn++;
        tp = uTp[d];
        if (kind === K_WF) {
          fnd[SUIT[c]]--;
          fsum--;
        } else {
          len[(m >> 6) & 7]--;
        }
      }
      hA = uHA[d];
      hB = uHB[d];
    }

    /**
     * Continues the search until it is solved or exhausted, `nodeLimit` nodes have been examined
     * in total (ST_NODES), or the clock passes `deadline` (ST_TIME). Returns the status; after
     * ST_NODES / ST_TIME it can be called again to go on from the same point.
     */
    function run(nodeLimit, deadline) {
      if (status === ST_SOLVED || status === ST_EXHAUSTED || status === ST_INVALID) return status;
      if (now() >= deadline) return (status = ST_TIME);
      let ticks = 0;
      for (;;) {
        // (every 16 steps: about 20 us of search when the code is hot, well under 1 ms when it is not)
        if ((++ticks & 15) === 0 && now() >= deadline) return (status = ST_TIME);
        const d = depth;
        const cur = mvCur[d];
        if (cur < mvEnd[d]) {
          if (nodes >= nodeLimit) return (status = ST_NODES);
          if (nodes >= attemptEnd) {
            // Restart: back to the root with a shuffled move order. Dead positions stay dead.
            for (let x = d - 1; x >= 0; x--) undoMove(path[x], x);
            attemptEnd = nodes + ATTEMPT_NODES;
            noise = NOISE;
            enterRoot();
            continue;
          }
          mvCur[d] = cur + 1;
          const m = mv[cur];
          path[d] = m;
          uHA[d] = hA;
          uHB[d] = hB;
          applyMove(m, d);
          if (seen(d)) {
            undoMove(m, d);
            continue;
          }
          nodes++;
          depth = d + 1;
          if (fsum === 52) return (status = ST_SOLVED);
          idx[d + 1] = vis;
          tsBase[d + 1] = ts;
          if (d + 1 < MAX_DEPTH) {
            low[d + 1] = vis;
            generate(d + 1);
          } else {
            low[d + 1] = -2; // cut off unexplored: neither it nor anything above it may be called dead
            mvCur[d + 1] = mvEnd[d + 1] = 0;
          }
          vis++;
        } else {
          closeNode(d);
          if (d === 0) return (status = ST_EXHAUSTED);
          depth = d - 1;
          undoMove(path[d - 1], d - 1);
        }
      }
    }

    /** The engine actions of the line found (meaningful after run() returned ST_SOLVED). */
    function actions() {
      const out = [];
      for (let d = 0; d < depth; d++) {
        const m = path[d];
        const kind = m & 7;
        const c = uCard[d];
        if (kind === K_TF) {
          out.push({ type: 'move', card: c, to: FPILE[SUIT[c]] });
        } else if (kind === K_TT || kind === K_FT) {
          out.push({ type: 'move', card: c, to: TPILE[(m >> 6) & 7] });
        } else {
          const k = (m >> 15) & 127;
          for (let i = 0; i < k; i++) out.push({ type: 'draw' });
          out.push({ type: 'move', card: c, to: kind === K_WF ? FPILE[SUIT[c]] : TPILE[(m >> 6) & 7] });
        }
      }
      return out;
    }

    return {
      load: load,
      run: run,
      actions: actions,
      nodes: function () {
        return nodes;
      },
      /** Gives a large table back (called when the searcher goes to rest in the pool). */
      trim: function () {
        if (cap > KEEP_CAP) {
          allocTable(MIN_CAP);
          gen = 0;
        }
      },
    };
  }

  // Searchers are reused (their buffers are a few hundred kB). A search that is paused between
  // slices keeps its searcher, so a solve() in between simply takes another one.
  const pool = [];
  function acquire() {
    return pool.length > 0 ? pool.pop() : createSearcher();
  }
  function release(s) {
    s.trim();
    if (pool.length < 2) pool.push(s);
  }

  /**
   * A usable limit. Anything that is not a finite number means the default (so both limits are
   * always in force); a negative number means 0 — "no time left" must not turn into a full search.
   */
  function limit(v, dflt) {
    if (typeof v !== 'number' || !isFinite(v)) return dflt;
    return v > 0 ? v : 0;
  }

  /**
   * How many nodes a search with these limits can really get to: the node limit, or what the
   * time allows at 2 million nodes a second (twice the speed measured on a desktop). The
   * transposition table is sized for it, so "maxNodes: 1e9, maxMs: 30" does not allocate 32 MB.
   */
  function expectedNodes(maxNodes, ms) {
    const byTime = ms * 2000;
    return maxNodes < byTime ? maxNodes : byTime;
  }

  /** Replays `moves` on a clone of `state` through the engine: true only when that ends in a win. */
  function replayWins(state, moves) {
    const eng = E();
    const copy = eng.clone(state);
    for (let i = 0; i < moves.length; i++) {
      if (!eng.apply(copy, moves[i])) return false;
    }
    return eng.isWon(copy);
  }

  /**
   * Searches for a win from `state`. See the header for the result. Never mutates `state`.
   */
  function solve(state, opts) {
    const t0 = now();
    const o = opts || {};
    const maxNodes = Math.min(limit(o.maxNodes, DEFAULTS.maxNodes), MAX_NODES);
    const maxMs = limit(o.maxMs, DEFAULTS.maxMs);
    let solved = false;
    let moves;
    let nodes = 0;
    let reason = 'invalid';
    const s = acquire();
    try {
      if (s.load(state, expectedNodes(maxNodes, maxMs))) {
        const eng = E();
        if (eng.isWon(state)) {
          solved = true;
          moves = [];
          reason = 'solved';
        } else {
          const st = s.run(maxNodes, t0 + maxMs);
          nodes = s.nodes();
          reason = REASONS[st];
          if (st === ST_SOLVED) {
            moves = s.actions();
            // The one thing `solved` rests on: the real engine plays the line to a win.
            solved = replayWins(state, moves);
            if (!solved) reason = 'invalid';
          }
        }
      }
    } catch (err) {
      solved = false;
      reason = 'invalid';
    } finally {
      release(s);
    }
    const out = { solved: solved, nodes: nodes, ms: now() - t0, reason: reason };
    if (solved) out.moves = moves;
    return out;
  }

  // ------------------------------------------------------------------ winnable seeds
  /** The seeds to try, one per call (see the header for the order). */
  function seedSource(o) {
    const rng = o.rng && typeof o.rng.next === 'function' ? o.rng : null;
    const hasStart = o.startSeed !== undefined && o.startSeed !== null;
    let cur = hasStart ? normalizeSeed(o.startSeed) : 0;
    let first = hasStart;
    return function () {
      if (first) {
        first = false;
        return cur;
      }
      if (rng) return (cur = Math.floor(rng.next() * 4294967296) >>> 0);
      if (hasStart) return (cur = (cur + 0x9e3779b9) >>> 0);
      return randomSeed();
    };
  }

  /**
   * The seed search both findWinnableSeed variants run: advance(until) works until the clock
   * passes `until` (returns null: call again) or there is a result (returns it). The search of
   * a deal is paused and resumed across calls. done() must be called once when finished.
   */
  function createHunt(opts, defaultBudget) {
    const o = opts || {};
    const drawCount = o.drawCount === 3 ? 3 : 1;
    const maxNodes = Math.min(limit(o.maxNodes, DEFAULTS.seedMaxNodes), MAX_NODES);
    const budget = limit(o.budgetMs, defaultBudget);
    const expect = expectedNodes(maxNodes, budget);
    const deadline = now() + budget;
    const next = seedSource(o);
    let seed = next();
    let state = null; // the deal being searched (null: `seed` has not been touched yet)
    let tried = 0;
    let released = false;
    const s = acquire();

    function fail() {
      // Out of time. A seed whose search was started is not handed back (see the header).
      if (state !== null) seed = next();
      return { seed: seed, certified: false, tried: tried };
    }

    function advance(until) {
      const stop = until < deadline ? until : deadline;
      for (;;) {
        if (now() >= deadline) return fail();
        if (state === null) {
          state = E().newGame({ seed: seed, drawCount: drawCount, id: 'solver' });
          s.load(state, expect);
          tried++;
        }
        const st = s.run(maxNodes, stop);
        if (st === ST_SOLVED) {
          const moves = s.actions();
          if (replayWins(state, moves)) return { seed: seed, certified: true, tried: tried, moves: moves };
        } else if (st === ST_TIME) {
          if (now() >= deadline) return fail();
          return null; // the slice is over: this deal goes on in the next one
        }
        // this deal was not certified: the next one
        seed = next();
        state = null;
      }
    }

    function done() {
      if (!released) {
        released = true;
        release(s);
      }
    }

    return {
      advance: advance,
      done: done,
      deadline: deadline,
      // what to answer when something threw (an rng that fails, a missing engine): a random deal
      fallback: function () {
        return { seed: randomSeed(), certified: false, tried: tried };
      },
    };
  }

  /**
   * Tries seeds until one is certified winnable or `budgetMs` runs out. See the header.
   * Never throws: when the search itself fails the answer is an uncertified random seed.
   */
  function findWinnableSeed(opts) {
    let hunt = null;
    try {
      hunt = createHunt(opts, DEFAULTS.budgetMs);
      return hunt.advance(hunt.deadline) || hunt.fallback();
    } catch (err) {
      return hunt ? hunt.fallback() : { seed: randomSeed(), certified: false, tried: 0 };
    } finally {
      if (hunt) hunt.done();
    }
  }

  /**
   * findWinnableSeed in slices of `sliceMs` with a setTimeout(0) between them, so the page keeps
   * animating. Resolves with the same result object; never rejects.
   */
  function findWinnableSeedAsync(opts) {
    return new Promise(function (resolve) {
      let hunt;
      try {
        hunt = createHunt(opts, DEFAULTS.asyncBudgetMs);
      } catch (err) {
        resolve({ seed: randomSeed(), certified: false, tried: 0 });
        return;
      }
      const sliceMs = Math.max(1, limit(opts && opts.sliceMs, DEFAULTS.sliceMs));
      const later =
        typeof root.setTimeout === 'function'
          ? function (fn) {
              root.setTimeout(fn, 0);
            }
          : function (fn) {
              Promise.resolve().then(fn);
            };

      function finish(result) {
        hunt.done();
        resolve(result);
      }

      function slice() {
        let result;
        try {
          result = hunt.advance(now() + sliceMs);
        } catch (err) {
          finish(hunt.fallback());
          return;
        }
        if (result) finish(result);
        else later(slice);
      }

      later(slice);
    });
  }

  SOL.Solver = {
    solve: solve,
    findWinnableSeed: findWinnableSeed,
    findWinnableSeedAsync: findWinnableSeedAsync,
    DEFAULTS: DEFAULTS,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = SOL.Solver;
})(typeof window !== 'undefined' ? window : globalThis);
