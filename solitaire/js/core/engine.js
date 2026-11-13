/*
 * SOL.Engine — Klondike rules, scoring, undo, hints. Pure logic (no DOM, no timers); loads in Node.
 * Needs SOL.RNG (js/core/rng.js) loaded first (in Node it is require()d automatically).
 *
 * CARD MODEL
 *   card id 0..51; suit = floor(id / 13) (0 spades, 1 hearts, 2 clubs, 3 diamonds); rank = id % 13 + 1
 *   (1 ace .. 13 king); red when suit % 2 === 1.
 *   Pile ids: 'stock', 'waste', 'f0'..'f3' (foundation of suit n), 't0'..'t6' (tableau, left to right).
 *   Pile arrays run bottom -> top: the LAST element is the top card.
 *
 * STATE (plain JSON object — exactly these fields; clone/deserialize drop anything else)
 *   { v: 1, id, seed, drawCount: 1|3, piles: { stock, waste, f0..f3, t0..t6 }, faceUp: boolean[52],
 *     score, moves, undos, recycles, elapsedMs, won, history: record[] }
 *   Invariants the engine keeps: 52 unique cards; stock all face-down; waste and foundations all
 *   face-up; in a tableau pile face-down cards sit only below face-up ones and the top card is
 *   face-up; state.won === isWon(state); score >= 0; moves, score and recycles always equal the
 *   "after" values of the last history record. elapsedMs is the controller's: the engine only
 *   carries it.
 *
 * CONSTANTS
 *   SUITS, SUIT_SYMBOLS, RANK_LABELS, FOUNDATIONS, TABLEAU, PILE_IDS (frozen arrays)
 *   SCORE (frozen): { wasteToTableau: 5, wasteToFoundation: 10, tableauToFoundation: 10, reveal: 5,
 *                     foundationToTableau: -15, recycleDraw1: -100, recycleDraw3: -20,
 *                     recycleDraw3FreePasses: 3, tableauToTableau: 0,
 *                     timeBonusFactor: 700000, timeBonusMinMs: 30000 }
 *       The score never drops below 0. Draw 1: every recycle costs 100. Draw 3: a recycle costs 20
 *       when it starts the 4th pass through the stock or a later one (i.e. from the 3rd recycle).
 *
 * CARD / PILE HELPERS
 *   suitOf(id) -> 0..3      rankOf(id) -> 1..13      isRed(id) -> boolean
 *   cardInfo(id) -> { id, suit, rank, suitName, symbol, label, color: 'red'|'black', name } | null
 *                   e.g. { id: 24, suit: 1, rank: 12, suitName: 'hearts', symbol: '\u2665', label: 'Q',
 *                          color: 'red', name: 'Queen of Hearts' }   (a fresh object on every call)
 *   pileKind(pileId) -> 'stock' | 'waste' | 'foundation' | 'tableau' | null
 *   foundationFor(cardId) -> 'f0'..'f3'
 *
 * GAME LIFECYCLE
 *   newGame({ seed, drawCount = 1, id } = {}) -> state     seed omitted: random; same seed => same deal
 *       Deal: ids 0..51 shuffled with RNG.create(seed); cards are dealt from the END of the shuffled
 *       array, row by row (row r = 0..6, columns c = r..6); the 24 cards left (array indexes 0..23,
 *       in that order) are the stock. So the n-th card dealt is piles['t' + c][r], rows first.
 *   clone(state) -> deep copy: piles, faces and every history record are copied, nothing is shared.
 *       Its cost grows with the history (0.3 us + about 0.2 us per record): a search should clone
 *       ONCE and then walk the tree with apply() + apply({ type: 'undo' }) on that one copy.
 *   serialize(state) -> string
 *   deserialize(string) -> state | null     null (never a throw) unless the text is a fully
 *       consistent state: known fields with the right types, 52 unique cards over the 13 piles, the
 *       invariants above, and a history that is exactly what the engine itself would have recorded
 *       (it is rewound and replayed). A history trimmed from its OLD end is fine; a non-string
 *       argument is not.
 *
 * QUERIES (never mutate)
 *   locate(state, cardId) -> { pile, index } | null        index counted from the bottom
 *   topCard(state, pileId) -> cardId | null
 *   isFaceUp(state, cardId) -> boolean
 *   canPickup(state, cardId) -> boolean      waste top, foundation top, any face-up tableau card
 *   getRun(state, cardId) -> cardId[]        the card + everything above it; [] when it cannot be picked up
 *   canDrop(state, cardId, toPile) -> boolean              would moving getRun(card) onto toPile be legal?
 *   legalTargets(state, cardId) -> pileId[]  (its foundation first, then tableau left to right)
 *   legalMoves(state) -> [{ type: 'move', card, to }]      EXTRA (not in the contract), for the solver:
 *       every legal move of the position in one pass (about 1 us; legalTargets for all 52 cards
 *       costs 7). Order: the waste top, the face-up tableau cards column by column (bottom -> top),
 *       then the foundation tops; per card its foundation first, then the columns left to right.
 *       Draws are not included (see canDraw). Complete: a King hopping between empty columns and
 *       cards coming back from a foundation are in the list — prune what you do not want.
 *   bestTarget(state, cardId) -> pileId | null             where a tap sends the card: its foundation
 *       (single card), else the leftmost legal non-empty column, else the leftmost empty column
 *       (not for a King already at the bottom of a column). null for foundation cards.
 *   canDraw(state) -> boolean                canUndo(state) -> boolean
 *   hints(state) -> [{ action, priority, reason }]         best first; [] when nothing useful
 *       action: { type: 'move', card, to } | { type: 'draw' }; always legal. reason: a sentence.
 *       priority (= kind; the list is sorted by it):
 *         1 a card to its foundation          2 a tableau move that uncovers a face-down card
 *         3 emptying a column a King is waiting for / a King to an empty column uncovering a card
 *         4 waste -> tableau                  5 splitting a run to free a card for its foundation
 *         6 draw (the stock or waste can still bring up a playable card)
 *         7 last resort, found by a small search when nothing above exists: a rearrangement that
 *           reopens the game — typically taking a card back from a foundation (can be a draw)
 *         8 a foundation move better left for later: something is waiting to be built on the card,
 *           the player took it back on purpose, or a priority-7 rearrangement should come first
 *       Pointless moves are never suggested (a King hopping between empty columns, shuffling a run
 *       between equivalent columns, emptying a column no King can use). Following hints[0] until
 *       the list is empty never loops. The list is never empty while a card can go to a
 *       foundation, a move would uncover a card, or the waste card can be played: such a move is
 *       always in it (possibly last, at priority 8).
 *   isWon(state) -> boolean
 *   isStuck(state) -> boolean                not won, and provably nothing can ever again uncover a
 *       card or play a card from the stock/waste — not even after taking cards back from the
 *       foundations. No false positives: false whenever a foundation move or any other useful
 *       move exists, and false when the proof would exceed the search budget.
 *   canAutoComplete(state) -> boolean        not won, no face-down tableau card, and draw 1 (or draw 3
 *                                            with an empty stock and at most one waste card)
 *   nextAutoAction(state) -> action | null   lowest-rank available card to its foundation, else draw;
 *                                            applied repeatedly (opts.auto) it always ends in a win
 *   timeBonus(elapsedMs) -> number           elapsedMs >= 30000 ? round(700000 / whole seconds) : 0
 *
 * ACTIONS
 *   apply(state, action, opts) -> record | null      MUTATES state; null (and no mutation) when illegal
 *     { type: 'draw' }               stock -> waste (min(drawCount, stock.length) cards, one at a time),
 *                                    or, with an empty stock, recycle the waste (record.type 'recycle')
 *     { type: 'move', card, to }     moves getRun(card) onto pile `to`
 *     { type: 'undo' }               reverts the last history record
 *     opts.auto === true             record.auto = true, and a recycle costs no points
 *   Once the game is won, only 'undo' is legal (nothing can be picked up, drawn or dropped).
 *
 * RECORD (returned by apply and stored on state.history for draw / recycle / move — same object)
 *   { type: 'draw'|'recycle'|'move',
 *     transfers: [{ card, from, to }],      in movement order: a move lists its run bottom -> top
 *                                           (the run travels as a block); draws and recycles list the
 *                                           cards in the order they left the top of the source pile
 *     flips: [{ card, faceUp, reveal? }],   every face change; reveal: true = tableau card uncovered by a move
 *     scoreBefore, scoreAfter, movesBefore, movesAfter, recyclesBefore, recyclesAfter,
 *     won,                                  the state is won after this action
 *     auto?: true }
 *   Undo returns (and does not store):
 *   { type: 'undo', undone: <reverted record>, transfers: <inverse>, flips: <inverse, reverse order,
 *     reveal flag kept>, scoreBefore, scoreAfter, movesBefore, movesAfter, recyclesBefore,
 *     recyclesAfter, won: false }
 *     transfers of an undo: every transfer of the undone record with from/to swapped. An undone
 *     draw or recycle lists them in reverse order (the cards went over one at a time, the last one
 *     comes back first). An undone move lists its run bottom -> top again: the run goes back as
 *     the block it came as. (The contract says "in reverse order"; for a run that order would
 *     rebuild the column upside down when replayed, so it is deliberately not reversed.)
 *
 * REPLAYING A RECORD (what a view can rely on — it holds for draw, recycle, move AND undo records):
 *   start from the piles and faces before the action; for each transfer, in order, take `card` out
 *   of pile `from` and put it on top of pile `to`; for each flip set faceUp[card] = flip.faceUp.
 *   The result is exactly state.piles / state.faceUp after the action. Nothing else changes them.
 *   The record apply() returns for draw / recycle / move is the very object stored on
 *   state.history: treat records as read-only (copy one before changing it).
 *
 * COST (for the solver; measured on random and hint-led playouts, one desktop core):
 *   apply + undo       about 4.5 million operations per second (0.2 us each), no allocation but the record
 *   legalMoves         about 1 us for the whole position
 *   clone              0.3 us + 0.2 us per history record  -> clone once, then apply / undo
 *   hints, isStuck     2-3 us in open positions — but in a blocked position (no ordinary move left)
 *                      they run the last-resort search: usually well under 1 ms, up to about 20 ms.
 *                      Results are cached for the 64 most recent positions. Fine once per player
 *                      action; NEVER call them per search node or per frame.
 */
(function (root) {
  'use strict';

  const SOL = (root.SOL = root.SOL || {});

  let RNG = SOL.RNG;
  if (!RNG && typeof require === 'function') RNG = require('./rng.js');

  /** SOL.RNG, resolved late so that the script order cannot break dealing silently. */
  function rng() {
    if (!RNG) RNG = SOL.RNG;
    if (!RNG) throw new Error('SOL.Engine needs SOL.RNG: load js/core/rng.js before dealing');
    return RNG;
  }

  // ------------------------------------------------------------------ constants
  const SUITS = Object.freeze(['spades', 'hearts', 'clubs', 'diamonds']);
  const SUIT_SYMBOLS = Object.freeze(['\u2660', '\u2665', '\u2663', '\u2666']); // spade, heart, club, diamond (escaped: no encoding surprises)
  const RANK_LABELS = Object.freeze(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']);
  const RANK_NAMES = ['Ace', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'Jack', 'Queen', 'King'];
  const SUIT_TITLES = ['Spades', 'Hearts', 'Clubs', 'Diamonds'];
  const FOUNDATIONS = Object.freeze(['f0', 'f1', 'f2', 'f3']);
  const TABLEAU = Object.freeze(['t0', 't1', 't2', 't3', 't4', 't5', 't6']);
  const PILE_IDS = Object.freeze(['stock', 'waste'].concat(FOUNDATIONS, TABLEAU));

  const SCORE = Object.freeze({
    wasteToTableau: 5,
    wasteToFoundation: 10,
    tableauToFoundation: 10,
    reveal: 5, // a tableau card turned face-up
    foundationToTableau: -15,
    recycleDraw1: -100, // every recycle in draw 1
    recycleDraw3: -20, // draw 3: only recycles that start pass number > recycleDraw3FreePasses
    recycleDraw3FreePasses: 3,
    tableauToTableau: 0,
    timeBonusFactor: 700000,
    timeBonusMinMs: 30000,
  });

  const K_STOCK = 0;
  const K_WASTE = 1;
  const K_FOUNDATION = 2;
  const K_TABLEAU = 3;
  const KIND_NAMES = ['stock', 'waste', 'foundation', 'tableau'];

  // Prototype-less lookups: any value may be used as a key without hitting Object.prototype.
  const KIND_CODE = Object.create(null);
  KIND_CODE.stock = K_STOCK;
  KIND_CODE.waste = K_WASTE;
  for (let i = 0; i < 4; i++) KIND_CODE[FOUNDATIONS[i]] = K_FOUNDATION;
  for (let i = 0; i < 7; i++) KIND_CODE[TABLEAU[i]] = K_TABLEAU;

  const SUIT_OF = new Uint8Array(52);
  const RANK_OF = new Uint8Array(52);
  const IS_RED = new Uint8Array(52);
  const FOUNDATION_OF = new Array(52);
  const CARD_NAMES = new Array(52);
  for (let id = 0; id < 52; id++) {
    const suit = Math.floor(id / 13);
    SUIT_OF[id] = suit;
    RANK_OF[id] = (id % 13) + 1;
    IS_RED[id] = suit % 2;
    FOUNDATION_OF[id] = FOUNDATIONS[suit];
    CARD_NAMES[id] = RANK_NAMES[id % 13] + ' of ' + SUIT_TITLES[suit];
  }

  // Pile lookup by number: fixed property names keep these loads monomorphic (and inlined), which
  // matters because a solver calls apply() and the legality checks millions of times.
  function tableauPile(piles, t) {
    switch (t) {
      case 0:
        return piles.t0;
      case 1:
        return piles.t1;
      case 2:
        return piles.t2;
      case 3:
        return piles.t3;
      case 4:
        return piles.t4;
      case 5:
        return piles.t5;
      default:
        return piles.t6;
    }
  }

  function foundationPile(piles, suit) {
    switch (suit) {
      case 0:
        return piles.f0;
      case 1:
        return piles.f1;
      case 2:
        return piles.f2;
      default:
        return piles.f3;
    }
  }

  function isCardId(v) {
    return typeof v === 'number' && v >= 0 && v < 52 && (v | 0) === v;
  }

  // ------------------------------------------------------------------ card / pile helpers
  function suitOf(id) {
    return SUIT_OF[id];
  }

  function rankOf(id) {
    return RANK_OF[id];
  }

  function isRed(id) {
    return IS_RED[id] === 1;
  }

  /** Everything the views need to label a card. Returns a fresh object (null for a bad id). */
  function cardInfo(id) {
    if (!isCardId(id)) return null;
    const suit = SUIT_OF[id];
    return {
      id: id,
      suit: suit,
      rank: RANK_OF[id],
      suitName: SUITS[suit],
      symbol: SUIT_SYMBOLS[suit],
      label: RANK_LABELS[id % 13],
      color: IS_RED[id] ? 'red' : 'black',
      name: CARD_NAMES[id],
    };
  }

  function pileKind(pileId) {
    const code = KIND_CODE[pileId];
    return code === undefined ? null : KIND_NAMES[code];
  }

  function foundationFor(cardId) {
    return isCardId(cardId) ? FOUNDATION_OF[cardId] : null;
  }

  // ------------------------------------------------------------------ lifecycle
  let idCounter = 0;

  function makeGameId() {
    idCounter += 1;
    return 'g' + Date.now().toString(36) + '-' + idCounter.toString(36) + '-' + rng().randomSeed().toString(36);
  }

  /**
   * Deal a new game. `seed` (uint32) fixes the deal; omitted => random. `drawCount` is 3 only when
   * exactly 3 is passed. `id` identifies the game for the stats (generated when not given).
   */
  function newGame(options) {
    const o = options || {};
    const R = rng();
    const seed = o.seed === undefined || o.seed === null ? R.randomSeed() : R.normalizeSeed(o.seed);
    const drawCount = o.drawCount === 3 ? 3 : 1;
    const id = typeof o.id === 'string' && o.id.length > 0 ? o.id : makeGameId();

    // (arrays are built with push so that they stay densely packed: these are read in every hot path)
    const deck = [];
    const faceUp = [];
    for (let i = 0; i < 52; i++) {
      deck.push(i);
      faceUp.push(false);
    }
    R.shuffle(deck, R.create(seed));

    const t = [[], [], [], [], [], [], []];
    let next = 51; // dealing from the top of the deck = the end of the array
    for (let row = 0; row < 7; row++) {
      for (let col = row; col < 7; col++) t[col].push(deck[next--]);
    }
    for (let col = 0; col < 7; col++) faceUp[t[col][col]] = true;
    deck.length = 24; // what is left, in order, is the stock (its top is the next card to deal)

    return {
      v: 1,
      id: id,
      seed: seed,
      drawCount: drawCount,
      piles: {
        stock: deck,
        waste: [],
        f0: [],
        f1: [],
        f2: [],
        f3: [],
        t0: t[0],
        t1: t[1],
        t2: t[2],
        t3: t[3],
        t4: t[4],
        t5: t[5],
        t6: t[6],
      },
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

  /** A copy of one history record that shares nothing with the original. */
  function copyRecord(r) {
    const tr = r.transfers;
    const transfers = new Array(tr.length);
    for (let i = 0; i < tr.length; i++) transfers[i] = { card: tr[i].card, from: tr[i].from, to: tr[i].to };
    const fl = r.flips;
    const flips = new Array(fl.length);
    for (let i = 0; i < fl.length; i++) {
      flips[i] = fl[i].reveal === true ? { card: fl[i].card, faceUp: fl[i].faceUp, reveal: true } : { card: fl[i].card, faceUp: fl[i].faceUp };
    }
    const out = {
      type: r.type,
      transfers: transfers,
      flips: flips,
      scoreBefore: r.scoreBefore,
      scoreAfter: r.scoreAfter,
      movesBefore: r.movesBefore,
      movesAfter: r.movesAfter,
      recyclesBefore: r.recyclesBefore,
      recyclesAfter: r.recyclesAfter,
      won: r.won,
    };
    if (r.auto === true) out.auto = true;
    return out;
  }

  /**
   * Deep copy of a state: piles, faces, and every history record are copied, so nothing done to
   * the copy (or to its records) can reach the original. The cost grows with the length of the
   * history (about 0.3 us plus 0.1 us per record); a search should clone once and then use
   * apply() + apply({ type: 'undo' }) on that one copy, which is far cheaper than cloning per node.
   */
  function clone(state) {
    const p = state.piles;
    const h = state.history;
    const history = new Array(h.length);
    for (let i = 0; i < h.length; i++) history[i] = copyRecord(h[i]);
    return {
      v: state.v,
      id: state.id,
      seed: state.seed,
      drawCount: state.drawCount,
      piles: {
        stock: p.stock.slice(),
        waste: p.waste.slice(),
        f0: p.f0.slice(),
        f1: p.f1.slice(),
        f2: p.f2.slice(),
        f3: p.f3.slice(),
        t0: p.t0.slice(),
        t1: p.t1.slice(),
        t2: p.t2.slice(),
        t3: p.t3.slice(),
        t4: p.t4.slice(),
        t5: p.t5.slice(),
        t6: p.t6.slice(),
      },
      faceUp: state.faceUp.slice(),
      score: state.score,
      moves: state.moves,
      undos: state.undos,
      recycles: state.recycles,
      elapsedMs: state.elapsedMs,
      won: state.won,
      history: history,
    };
  }

  function serialize(state) {
    return JSON.stringify(state);
  }

  // ---- deserialize: everything is validated, nothing is trusted, nothing throws ----
  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function isCount(v) {
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
  }

  /** Structural check of one history record; returns a clean copy or null. */
  function readRecord(raw, drawCount) {
    if (!isPlainObject(raw)) return null;
    const type = raw.type;
    if (type !== 'draw' && type !== 'recycle' && type !== 'move') return null;

    const rt = raw.transfers;
    if (!Array.isArray(rt) || rt.length === 0 || rt.length > 52) return null;
    const first = rt[0];
    if (!isPlainObject(first)) return null;
    const from = first.from;
    const to = first.to;
    if (typeof from !== 'string' || typeof to !== 'string') return null;
    const fromKind = KIND_CODE[from];
    const toKind = KIND_CODE[to];
    if (fromKind === undefined || toKind === undefined || from === to) return null;
    if (type === 'draw') {
      if (fromKind !== K_STOCK || toKind !== K_WASTE || rt.length > drawCount) return null;
    } else if (type === 'recycle') {
      if (fromKind !== K_WASTE || toKind !== K_STOCK) return null;
    } else {
      if (fromKind === K_STOCK || (toKind !== K_FOUNDATION && toKind !== K_TABLEAU)) return null;
      if (fromKind === K_FOUNDATION && toKind === K_FOUNDATION) return null;
      if (fromKind !== K_TABLEAU && rt.length !== 1) return null;
      if (toKind === K_FOUNDATION && rt.length !== 1) return null;
    }
    const transfers = new Array(rt.length);
    for (let i = 0; i < rt.length; i++) {
      const tr = rt[i];
      // every transfer of one action shares the same source and destination
      if (!isPlainObject(tr) || !isCardId(tr.card) || tr.from !== from || tr.to !== to) return null;
      transfers[i] = { card: tr.card, from: from, to: to };
    }

    const rf = raw.flips;
    if (!Array.isArray(rf) || rf.length > 52) return null;
    const flips = new Array(rf.length);
    for (let i = 0; i < rf.length; i++) {
      const fl = rf[i];
      if (!isPlainObject(fl) || !isCardId(fl.card) || typeof fl.faceUp !== 'boolean') return null;
      if (fl.reveal !== undefined && fl.reveal !== true) return null;
      flips[i] = fl.reveal === true ? { card: fl.card, faceUp: fl.faceUp, reveal: true } : { card: fl.card, faceUp: fl.faceUp };
    }

    if (!isCount(raw.scoreBefore) || !isCount(raw.scoreAfter)) return null;
    if (!isCount(raw.movesBefore) || !isCount(raw.movesAfter)) return null;
    if (!isCount(raw.recyclesBefore) || !isCount(raw.recyclesAfter)) return null;
    if (typeof raw.won !== 'boolean') return null;
    if (raw.auto !== undefined && raw.auto !== true) return null;

    const record = {
      type: type,
      transfers: transfers,
      flips: flips,
      scoreBefore: raw.scoreBefore,
      scoreAfter: raw.scoreAfter,
      movesBefore: raw.movesBefore,
      movesAfter: raw.movesAfter,
      recyclesBefore: raw.recyclesBefore,
      recyclesAfter: raw.recyclesAfter,
      won: raw.won,
    };
    if (raw.auto === true) record.auto = true;
    return record;
  }

  /**
   * Can `record` be undone right now? `dest` is the pile its cards went to: they must still be
   * its top cards, in order, and every card the record turned must still show that face.
   */
  function recordFits(dest, faceUp, record) {
    const tr = record.transfers;
    const n = tr.length;
    const base = dest.length - n;
    if (base < 0) return false;
    for (let i = 0; i < n; i++) {
      if (dest[base + i] !== tr[i].card) return false;
    }
    const fl = record.flips;
    for (let i = 0; i < fl.length; i++) {
      if (faceUp[fl[i].card] !== fl[i].faceUp) return false;
    }
    return true;
  }

  /** Takes a record back: cards from `dest` to `src`, faces flipped back. Check recordFits first. */
  function rewindRecord(dest, src, faceUp, record) {
    const n = record.transfers.length;
    const base = dest.length - n;
    if (record.type === 'move') {
      // a run travels as a block: it goes back in the same bottom -> top order
      for (let i = 0; i < n; i++) src.push(dest[base + i]);
      dest.length = base;
    } else {
      // draws and recycles moved the cards one at a time: the last one moved goes back first
      for (let i = 0; i < n; i++) src.push(dest.pop());
    }
    const fl = record.flips;
    for (let i = fl.length - 1; i >= 0; i--) faceUp[fl[i].card] = !fl[i].faceUp;
  }

  /**
   * The face rules every position obeys: stock face-down; waste face-up; each foundation its own
   * suit from the ace up, face-up; in the tableau face-down cards only underneath face-up ones.
   * Returns the number of cards on the foundations, or -1 when a rule is broken.
   */
  function layoutSound(piles, faceUp) {
    for (let j = 0; j < piles.stock.length; j++) {
      if (faceUp[piles.stock[j]]) return -1;
    }
    for (let j = 0; j < piles.waste.length; j++) {
      if (!faceUp[piles.waste[j]]) return -1;
    }
    let onFoundations = 0;
    for (let s = 0; s < 4; s++) {
      const f = foundationPile(piles, s);
      for (let j = 0; j < f.length; j++) {
        if (f[j] !== s * 13 + j || !faceUp[f[j]]) return -1;
      }
      onFoundations += f.length;
    }
    for (let t = 0; t < 7; t++) {
      const p = tableauPile(piles, t);
      let up = false;
      for (let j = 0; j < p.length; j++) {
        if (faceUp[p[j]]) up = true;
        else if (up) return -1; // a face-down card above a face-up one
      }
      if (p.length > 0 && !up) return -1; // the top card of a column is always face-up
    }
    return onFoundations;
  }

  /** Are two records the same action with the same outcome? */
  function sameRecord(a, b) {
    if (a.type !== b.type || a.won !== b.won || (a.auto === true) !== (b.auto === true)) return false;
    if (a.scoreBefore !== b.scoreBefore || a.scoreAfter !== b.scoreAfter) return false;
    if (a.movesBefore !== b.movesBefore || a.movesAfter !== b.movesAfter) return false;
    if (a.recyclesBefore !== b.recyclesBefore || a.recyclesAfter !== b.recyclesAfter) return false;
    if (a.transfers.length !== b.transfers.length || a.flips.length !== b.flips.length) return false;
    for (let i = 0; i < a.transfers.length; i++) {
      const x = a.transfers[i];
      const y = b.transfers[i];
      if (x.card !== y.card || x.from !== y.from || x.to !== y.to) return false;
    }
    for (let i = 0; i < a.flips.length; i++) {
      const x = a.flips[i];
      const y = b.flips[i];
      if (x.card !== y.card || x.faceUp !== y.faceUp || (x.reveal === true) !== (y.reveal === true)) return false;
    }
    return true;
  }

  /** Validates a parsed JSON value and returns a normalised state, or null. */
  function readState(raw) {
    if (!isPlainObject(raw) || raw.v !== 1) return null;
    if (typeof raw.id !== 'string' || raw.id.length === 0 || raw.id.length > 200) return null;
    if (!isCount(raw.seed) || raw.seed > 0xffffffff) return null;
    if (raw.drawCount !== 1 && raw.drawCount !== 3) return null;

    // ---- piles: exactly the 13 known ids, 52 unique cards between them
    const rp = raw.piles;
    if (!isPlainObject(rp)) return null;
    const keys = Object.keys(rp);
    if (keys.length !== PILE_IDS.length) return null;
    for (let i = 0; i < keys.length; i++) {
      if (KIND_CODE[keys[i]] === undefined) return null;
    }
    const piles = {};
    const seen = new Uint8Array(52);
    let total = 0;
    for (let i = 0; i < PILE_IDS.length; i++) {
      const src = rp[PILE_IDS[i]];
      if (!Array.isArray(src) || src.length > 52) return null;
      const copy = [];
      for (let j = 0; j < src.length; j++) {
        const c = src[j];
        if (!isCardId(c) || seen[c]) return null;
        seen[c] = 1;
        copy.push(c);
      }
      total += src.length;
      piles[PILE_IDS[i]] = copy;
    }
    if (total !== 52) return null;

    // ---- faces
    const rf = raw.faceUp;
    if (!Array.isArray(rf) || rf.length !== 52) return null;
    const faceUp = [];
    for (let i = 0; i < 52; i++) {
      if (typeof rf[i] !== 'boolean') return null;
      faceUp.push(rf[i]);
    }
    const onFoundations = layoutSound(piles, faceUp);
    if (onFoundations < 0) return null;

    // ---- counters
    if (!isCount(raw.score) || !isCount(raw.moves) || !isCount(raw.undos) || !isCount(raw.recycles)) return null;
    if (typeof raw.elapsedMs !== 'number' || !isFinite(raw.elapsedMs) || raw.elapsedMs < 0) return null;
    if (typeof raw.won !== 'boolean' || raw.won !== (onFoundations === 52)) return null;

    // ---- history: each record well-formed, and the whole stack must really be undoable from here
    const rh = raw.history;
    if (!Array.isArray(rh) || rh.length > 100000) return null;
    const history = [];
    for (let i = 0; i < rh.length; i++) {
      const record = readRecord(rh[i], raw.drawCount);
      if (!record) return null;
      history.push(record);
    }
    if (history.length > 0) {
      // The history must be exactly what the engine itself would have recorded. Rewind it all
      // (newest first; every step must fit the piles and faces), then replay it through apply()
      // and compare record by record. A history trimmed from its OLD end still passes.
      const last = history[history.length - 1];
      if (last.scoreAfter !== raw.score || last.movesAfter !== raw.moves || last.recyclesAfter !== raw.recycles) return null;
      const scratchPiles = {};
      for (let i = 0; i < PILE_IDS.length; i++) scratchPiles[PILE_IDS[i]] = piles[PILE_IDS[i]].slice();
      const scratchFaces = faceUp.slice();
      for (let i = history.length - 1; i >= 0; i--) {
        const tr = history[i].transfers[0];
        if (!recordFits(scratchPiles[tr.to], scratchFaces, history[i])) return null;
        rewindRecord(scratchPiles[tr.to], scratchPiles[tr.from], scratchFaces, history[i]);
      }
      const startOnFoundations = layoutSound(scratchPiles, scratchFaces);
      if (startOnFoundations < 0 || startOnFoundations === 52) return null;
      const replay = {
        v: 1,
        id: raw.id,
        seed: raw.seed,
        drawCount: raw.drawCount,
        piles: scratchPiles,
        faceUp: scratchFaces,
        score: history[0].scoreBefore,
        moves: history[0].movesBefore,
        undos: 0,
        recycles: history[0].recyclesBefore,
        elapsedMs: 0,
        won: false,
        history: [],
      };
      const autoOpts = { auto: true };
      for (let i = 0; i < history.length; i++) {
        const r = history[i];
        const action = r.type === 'move' ? { type: 'move', card: r.transfers[0].card, to: r.transfers[0].to } : { type: 'draw' };
        const made = apply(replay, action, r.auto === true ? autoOpts : undefined);
        if (!made || !sameRecord(made, r)) return null;
      }
      if (replay.won !== raw.won) return null;
    }

    return {
      v: 1,
      id: raw.id,
      seed: raw.seed,
      drawCount: raw.drawCount,
      piles: {
        stock: piles.stock,
        waste: piles.waste,
        f0: piles.f0,
        f1: piles.f1,
        f2: piles.f2,
        f3: piles.f3,
        t0: piles.t0,
        t1: piles.t1,
        t2: piles.t2,
        t3: piles.t3,
        t4: piles.t4,
        t5: piles.t5,
        t6: piles.t6,
      },
      faceUp: faceUp,
      score: raw.score,
      moves: raw.moves,
      undos: raw.undos,
      recycles: raw.recycles,
      elapsedMs: raw.elapsedMs,
      won: raw.won,
      history: history,
    };
  }

  /** Parse a saved game. Returns null for anything that is not a fully consistent state. */
  function deserialize(text) {
    if (typeof text !== 'string' || text.length === 0) return null;
    try {
      return readState(JSON.parse(text));
    } catch (err) {
      return null;
    }
  }

  // ------------------------------------------------------------------ queries
  /** Where is the card? { pile, index } (index from the bottom), or null for a bad id. */
  function locate(state, cardId) {
    if (!isCardId(cardId)) return null;
    const piles = state.piles;
    for (let i = 0; i < PILE_IDS.length; i++) {
      const p = piles[PILE_IDS[i]];
      for (let j = p.length - 1; j >= 0; j--) {
        if (p[j] === cardId) return { pile: PILE_IDS[i], index: j };
      }
    }
    return null;
  }

  function topCard(state, pileId) {
    if (KIND_CODE[pileId] === undefined) return null;
    const p = state.piles[pileId];
    return p.length > 0 ? p[p.length - 1] : null;
  }

  function isFaceUp(state, cardId) {
    return state.faceUp[cardId] === true;
  }

  function isWon(state) {
    const p = state.piles;
    return p.f0.length + p.f1.length + p.f2.length + p.f3.length === 52;
  }

  // Result slots of findSource() and decodePile(): module-level so the hot path (apply) allocates
  // nothing. A pile is addressed as (kind, slot): slot = column 0..6 or suit 0..3.
  let srcKind = -1;
  let srcSlot = -1;
  let srcIndex = -1;
  let srcArr = null;
  let dstSlot = -1;

  /**
   * Finds a card that may be picked up and fills srcKind / srcSlot / srcIndex / srcArr. Returns
   * false when the card cannot be picked up (bad id, face-down, buried in the waste or a
   * foundation, game won).
   */
  function findSource(state, card) {
    if (!isCardId(card) || state.won || state.faceUp[card] !== true) return false;
    const piles = state.piles;

    const waste = piles.waste;
    let n = waste.length;
    if (n > 0 && waste[n - 1] === card) {
      srcKind = K_WASTE;
      srcSlot = 0;
      srcIndex = n - 1;
      srcArr = waste;
      return true;
    }

    const suit = SUIT_OF[card];
    const f = foundationPile(piles, suit);
    n = f.length;
    if (n > 0 && f[n - 1] === card) {
      srcKind = K_FOUNDATION;
      srcSlot = suit;
      srcIndex = n - 1;
      srcArr = f;
      return true;
    }

    const faceUp = state.faceUp;
    for (let t = 0; t < 7; t++) {
      const p = tableauPile(piles, t);
      // only the face-up part of a column can hold a card that may be picked up
      for (let j = p.length - 1; j >= 0; j--) {
        const c = p[j];
        if (c === card) {
          srcKind = K_TABLEAU;
          srcSlot = t;
          srcIndex = j;
          srcArr = p;
          return true;
        }
        if (faceUp[c] !== true) break;
      }
    }
    return false;
  }

  /** Pile id of the source found by findSource(). */
  function srcPileId() {
    return srcKind === K_TABLEAU ? TABLEAU[srcSlot] : srcKind === K_FOUNDATION ? FOUNDATIONS[srcSlot] : 'waste';
  }

  /**
   * Parses a pile id without a property lookup: returns its kind code (-1 when it is not a pile
   * id) and leaves the column / suit number in dstSlot.
   */
  function decodePile(pileId) {
    if (typeof pileId !== 'string') return -1;
    if (pileId.length === 2) {
      const slot = pileId.charCodeAt(1) - 48;
      const letter = pileId.charCodeAt(0);
      if (letter === 116 /* t */ && slot >= 0 && slot <= 6) {
        dstSlot = slot;
        return K_TABLEAU;
      }
      if (letter === 102 /* f */ && slot >= 0 && slot <= 3) {
        dstSlot = slot;
        return K_FOUNDATION;
      }
      return -1;
    }
    if (pileId === 'stock') return K_STOCK;
    if (pileId === 'waste') return K_WASTE;
    return -1;
  }

  /** Would its own foundation take this card right now? (single card assumed) */
  function foundationAccepts(state, card) {
    const f = foundationPile(state.piles, SUIT_OF[card]);
    const n = f.length;
    // the previous card of the same suit has id card - 1
    return RANK_OF[card] === 1 ? n === 0 : n > 0 && f[n - 1] === card - 1;
  }

  /** Would the tableau pile `dest` take a run starting with `card`? */
  function tableauAccepts(state, card, dest) {
    const n = dest.length;
    if (n === 0) return RANK_OF[card] === 13;
    const top = dest[n - 1];
    return state.faceUp[top] === true && IS_RED[top] !== IS_RED[card] && RANK_OF[top] === RANK_OF[card] + 1;
  }

  /**
   * Legality of dropping the run found by findSource() (starting with `card`) on the pile
   * (toKind, toSlot). Moving onto the pile the card is in, the stock or the waste is never legal.
   */
  function dropAllowed(state, card, toKind, toSlot) {
    if (toKind === K_TABLEAU) {
      if (srcKind === K_TABLEAU && srcSlot === toSlot) return false;
      return tableauAccepts(state, card, tableauPile(state.piles, toSlot));
    }
    if (toKind === K_FOUNDATION) {
      if (toSlot !== SUIT_OF[card] || srcKind === K_FOUNDATION) return false;
      if (srcKind === K_TABLEAU && srcIndex !== srcArr.length - 1) return false; // single cards only
      return foundationAccepts(state, card);
    }
    return false;
  }

  function canPickup(state, cardId) {
    return findSource(state, cardId);
  }

  function getRun(state, cardId) {
    if (!findSource(state, cardId)) return [];
    if (srcKind !== K_TABLEAU) return [cardId];
    return srcArr.slice(srcIndex);
  }

  function canDrop(state, cardId, toPile) {
    if (!findSource(state, cardId)) return false;
    const toKind = decodePile(toPile);
    return toKind >= 0 && dropAllowed(state, cardId, toKind, dstSlot);
  }

  function legalTargets(state, cardId) {
    const out = [];
    if (!findSource(state, cardId)) return out;
    const suit = SUIT_OF[cardId];
    if (dropAllowed(state, cardId, K_FOUNDATION, suit)) out.push(FOUNDATIONS[suit]);
    for (let t = 0; t < 7; t++) {
      if (dropAllowed(state, cardId, K_TABLEAU, t)) out.push(TABLEAU[t]);
    }
    return out;
  }

  /** legalMoves() helper: appends every legal target of one source card (or run) to `out`. */
  function addMoves(state, out, card, single, fromColumn) {
    // (fromColumn: the tableau column the card is in; -1 for the waste, -2 for a foundation)
    if (single && fromColumn !== -2 && foundationAccepts(state, card)) out.push({ type: 'move', card: card, to: FOUNDATION_OF[card] });
    const piles = state.piles;
    for (let t = 0; t < 7; t++) {
      if (t !== fromColumn && tableauAccepts(state, card, tableauPile(piles, t))) out.push({ type: 'move', card: card, to: TABLEAU[t] });
    }
  }

  /**
   * EXTRA (not in the contract): every legal { type: 'move', card, to } of the position, found in
   * one pass over the piles. Exactly the moves canDrop() accepts, in this order: the waste top, the
   * face-up tableau cards column by column (bottom -> top), the foundation tops; for each card its
   * foundation first, then the columns left to right. Draws are not included. [] once won.
   */
  function legalMoves(state) {
    const out = [];
    if (state.won) return out;
    const piles = state.piles;
    const faceUp = state.faceUp;
    const waste = piles.waste;
    if (waste.length > 0 && faceUp[waste[waste.length - 1]] === true) addMoves(state, out, waste[waste.length - 1], true, -1);
    for (let t = 0; t < 7; t++) {
      const p = tableauPile(piles, t);
      const len = p.length;
      let d = len; // index of the lowest card of the face-up part of the column
      while (d > 0 && faceUp[p[d - 1]] === true) d--;
      for (let j = d; j < len; j++) addMoves(state, out, p[j], j === len - 1, t);
    }
    for (let s = 0; s < 4; s++) {
      const f = foundationPile(piles, s);
      if (f.length > 0 && faceUp[f[f.length - 1]] === true) addMoves(state, out, f[f.length - 1], true, -2);
    }
    return out;
  }

  /**
   * Where a tap sends the card: its foundation when it is a single card and that is legal; else the
   * leftmost legal non-empty tableau pile; else the leftmost empty tableau pile — unless the card is
   * a King already resting at the bottom of its column (that hop would change nothing).
   * null for foundation cards and for anything that cannot be picked up.
   */
  function bestTarget(state, cardId) {
    if (!findSource(state, cardId) || srcKind === K_FOUNDATION) return null;
    const piles = state.piles;
    if (dropAllowed(state, cardId, K_FOUNDATION, SUIT_OF[cardId])) return FOUNDATION_OF[cardId];
    for (let t = 0; t < 7; t++) {
      if (tableauPile(piles, t).length > 0 && dropAllowed(state, cardId, K_TABLEAU, t)) return TABLEAU[t];
    }
    if (RANK_OF[cardId] === 13 && !(srcKind === K_TABLEAU && srcIndex === 0)) {
      for (let t = 0; t < 7; t++) {
        if (tableauPile(piles, t).length === 0) return TABLEAU[t];
      }
    }
    return null;
  }

  function canDraw(state) {
    return !state.won && (state.piles.stock.length > 0 || state.piles.waste.length > 0);
  }

  function canUndo(state) {
    return state.history.length > 0;
  }

  function timeBonus(elapsedMs) {
    if (typeof elapsedMs !== 'number' || !(elapsedMs >= SCORE.timeBonusMinMs) || !isFinite(elapsedMs)) return 0;
    return Math.round(SCORE.timeBonusFactor / Math.floor(elapsedMs / 1000));
  }

  // ------------------------------------------------------------------ apply
  /** Books the score/move counters, pushes the record on the history and returns it. */
  function commit(state, type, transfers, flips, delta, recyclesAfter, auto) {
    const scoreBefore = state.score;
    const movesBefore = state.moves;
    const recyclesBefore = state.recycles;
    let scoreAfter = scoreBefore + delta;
    if (scoreAfter < 0) scoreAfter = 0;
    const p = state.piles;
    const won = p.f0.length + p.f1.length + p.f2.length + p.f3.length === 52;

    state.score = scoreAfter;
    state.moves = movesBefore + 1;
    state.recycles = recyclesAfter;
    state.won = won;

    const record = {
      type: type,
      transfers: transfers,
      flips: flips,
      scoreBefore: scoreBefore,
      scoreAfter: scoreAfter,
      movesBefore: movesBefore,
      movesAfter: movesBefore + 1,
      recyclesBefore: recyclesBefore,
      recyclesAfter: recyclesAfter,
      won: won,
    };
    if (auto) record.auto = true;
    state.history.push(record);
    return record;
  }

  function applyDraw(state, auto) {
    if (state.won) return null;
    const piles = state.piles;
    const stock = piles.stock;
    const waste = piles.waste;
    const faceUp = state.faceUp;
    const transfers = [];
    const flips = [];

    if (stock.length > 0) {
      const n = Math.min(state.drawCount === 3 ? 3 : 1, stock.length);
      for (let i = 0; i < n; i++) {
        const c = stock.pop();
        waste.push(c);
        transfers.push({ card: c, from: 'stock', to: 'waste' });
        if (faceUp[c] !== true) {
          faceUp[c] = true;
          flips.push({ card: c, faceUp: true });
        }
      }
      return commit(state, 'draw', transfers, flips, 0, state.recycles, auto);
    }

    if (waste.length === 0) return null;

    // Recycle: the waste is turned over as a whole, i.e. its top card ends at the bottom of the
    // stock and its bottom card (the first one drawn) on top: the cards come out in the same order.
    while (waste.length > 0) {
      const c = waste.pop();
      stock.push(c);
      transfers.push({ card: c, from: 'waste', to: 'stock' });
      if (faceUp[c] !== false) {
        faceUp[c] = false;
        flips.push({ card: c, faceUp: false });
      }
    }
    const recyclesAfter = state.recycles + 1;
    let delta = 0;
    if (!auto) {
      if (state.drawCount === 3) {
        // this recycle starts pass number recyclesAfter + 1; the first few passes are free
        if (recyclesAfter >= SCORE.recycleDraw3FreePasses) delta = SCORE.recycleDraw3;
      } else {
        delta = SCORE.recycleDraw1;
      }
    }
    return commit(state, 'recycle', transfers, flips, delta, recyclesAfter, auto);
  }

  function applyMove(state, card, toPile, auto) {
    if (!findSource(state, card)) return null;
    const toKind = decodePile(toPile);
    if (toKind < 0) return null;
    const toSlot = dstSlot;
    if (!dropAllowed(state, card, toKind, toSlot)) return null;

    // ---- legal from here on: mutate
    const fromKind = srcKind;
    const index = srcIndex;
    const src = srcArr;
    const from = srcPileId();
    const to = toKind === K_TABLEAU ? TABLEAU[toSlot] : FOUNDATIONS[toSlot];
    const dest = toKind === K_TABLEAU ? tableauPile(state.piles, toSlot) : foundationPile(state.piles, toSlot);
    const n = fromKind === K_TABLEAU ? src.length - index : 1;
    let transfers;
    if (n === 1) {
      dest.push(src.pop());
      transfers = [{ card: card, from: from, to: to }];
    } else {
      transfers = new Array(n);
      for (let i = 0; i < n; i++) {
        const c = src[index + i];
        dest.push(c);
        transfers[i] = { card: c, from: from, to: to };
      }
      src.length = index;
    }

    let delta;
    if (toKind === K_FOUNDATION) {
      delta = fromKind === K_WASTE ? SCORE.wasteToFoundation : SCORE.tableauToFoundation;
    } else if (fromKind === K_WASTE) {
      delta = SCORE.wasteToTableau;
    } else if (fromKind === K_FOUNDATION) {
      delta = SCORE.foundationToTableau;
    } else {
      delta = SCORE.tableauToTableau;
    }

    // a face-down card left on top of the column the run came from is turned over as part of the move
    const flips = [];
    if (fromKind === K_TABLEAU && index > 0) {
      const exposed = src[index - 1];
      if (state.faceUp[exposed] !== true) {
        state.faceUp[exposed] = true;
        flips.push({ card: exposed, faceUp: true, reveal: true });
        delta += SCORE.reveal;
      }
    }

    return commit(state, 'move', transfers, flips, delta, state.recycles, auto);
  }

  /** The pile array for a pile id (null when it is not one). */
  function pileById(piles, pileId) {
    const kind = decodePile(pileId);
    if (kind === K_TABLEAU) return tableauPile(piles, dstSlot);
    if (kind === K_FOUNDATION) return foundationPile(piles, dstSlot);
    if (kind === K_WASTE) return piles.waste;
    if (kind === K_STOCK) return piles.stock;
    return null;
  }

  function applyUndo(state) {
    const history = state.history;
    const count = history.length;
    if (count === 0) return null;
    const record = history[count - 1];
    const tr = record.transfers;
    // Guard against a history that does not belong to these piles (only possible when a state was
    // assembled by hand): refuse rather than corrupt the game.
    if (!tr || tr.length === 0) return null;
    const from = tr[0].from;
    const to = tr[0].to;
    const dest = pileById(state.piles, to);
    const src = pileById(state.piles, from);
    if (!dest || !src || !recordFits(dest, state.faceUp, record)) return null;

    history.length = count - 1;
    rewindRecord(dest, src, state.faceUp, record);

    // The undo's transfers are listed so that they can be replayed one at a time ("take the card
    // out of `from`, put it on top of `to`") and give exactly the piles the undo leaves behind:
    // a run goes back the way it came, as a block, bottom -> top; the cards of a draw or a recycle
    // went over one by one, so they come back last-moved-first.
    const n = tr.length;
    const transfers = new Array(n);
    if (record.type === 'move') {
      for (let i = 0; i < n; i++) transfers[i] = { card: tr[i].card, from: to, to: from };
    } else {
      for (let i = 0; i < n; i++) transfers[i] = { card: tr[n - 1 - i].card, from: to, to: from };
    }
    const fl = record.flips;
    const m = fl.length;
    const flips = new Array(m);
    for (let i = 0; i < m; i++) {
      const f = fl[m - 1 - i];
      flips[i] = f.reveal === true ? { card: f.card, faceUp: !f.faceUp, reveal: true } : { card: f.card, faceUp: !f.faceUp };
    }

    const scoreBefore = state.score;
    const movesBefore = state.moves;
    const recyclesBefore = state.recycles;
    state.score = record.scoreBefore;
    state.moves = record.movesBefore;
    state.recycles = record.recyclesBefore;
    state.undos += 1;
    state.won = false; // no action is legal in a won state, so the state before any record is never won

    return {
      type: 'undo',
      undone: record,
      transfers: transfers,
      flips: flips,
      scoreBefore: scoreBefore,
      scoreAfter: state.score,
      movesBefore: movesBefore,
      movesAfter: state.moves,
      recyclesBefore: recyclesBefore,
      recyclesAfter: state.recycles,
      won: false,
    };
  }

  /**
   * Applies an action. Returns the record describing exactly what changed, or null when the action
   * is illegal — in which case the state is untouched.
   */
  function apply(state, action, opts) {
    if (!action || !state) return null;
    const auto = !!opts && opts.auto === true;
    switch (action.type) {
      case 'move':
        return applyMove(state, action.card, action.to, auto);
      case 'draw':
        return applyDraw(state, auto);
      case 'undo':
        return applyUndo(state);
      default:
        return null;
    }
  }

  // ------------------------------------------------------------------ auto-complete
  /**
   * True when the rest of the game plays itself: not won, every tableau card face-up, and every
   * stock/waste card reachable (draw 1, or draw 3 with an empty stock and at most one waste card).
   * Also requires every column to descend in rank (always true in a game played by the rules); that
   * is what guarantees nextAutoAction terminates, even on a hand-made state.
   */
  function canAutoComplete(state) {
    if (state.won || isWon(state)) return false;
    const piles = state.piles;
    if (state.drawCount !== 1 && (piles.stock.length > 0 || piles.waste.length > 1)) return false;
    const faceUp = state.faceUp;
    for (let t = 0; t < 7; t++) {
      const p = tableauPile(piles, t);
      for (let j = 0; j < p.length; j++) {
        if (faceUp[p[j]] !== true) return false;
        if (j > 0 && RANK_OF[p[j]] >= RANK_OF[p[j - 1]]) return false;
      }
    }
    return true;
  }

  /**
   * The next step of auto-complete: the lowest-rank available card (tableau tops, waste top) that
   * its foundation accepts; otherwise a draw; null when auto-complete does not apply.
   */
  function nextAutoAction(state) {
    if (!canAutoComplete(state)) return null;
    const piles = state.piles;
    let best = -1;
    const waste = piles.waste;
    if (waste.length > 0) {
      const c = waste[waste.length - 1];
      if (foundationAccepts(state, c)) best = c;
    }
    for (let t = 0; t < 7; t++) {
      const p = tableauPile(piles, t);
      if (p.length === 0) continue;
      const c = p[p.length - 1];
      if (foundationAccepts(state, c) && (best < 0 || RANK_OF[c] < RANK_OF[best])) best = c;
    }
    if (best >= 0) return { type: 'move', card: best, to: FOUNDATION_OF[best] };
    if (piles.stock.length > 0 || waste.length > 0) return { type: 'draw' };
    return null;
  }

  // ------------------------------------------------------------------ hints
  // Scratch buffers for the hint analysis (filled by scanTableau / listExposable, reused every call).
  const tLen = new Int8Array(7);
  const tDown = new Int8Array(7); // number of face-down cards at the bottom of each column
  const tTop = new Int8Array(7); // top card of each column, -1 when empty
  const expo = new Int8Array(52);
  const expoSeen = new Uint8Array(52);
  let expoCount = 0;
  let firstEmpty = -1;

  function scanTableau(state) {
    const piles = state.piles;
    const faceUp = state.faceUp;
    firstEmpty = -1;
    for (let t = 0; t < 7; t++) {
      const p = tableauPile(piles, t);
      const len = p.length;
      tLen[t] = len;
      tTop[t] = len > 0 ? p[len - 1] : -1;
      let d = 0;
      while (d < len && faceUp[p[d]] !== true) d++;
      tDown[t] = d;
      if (len === 0 && firstEmpty < 0) firstEmpty = t;
    }
  }

  /**
   * Fills expo[0..expoCount) with every card that drawing (and recycling) alone can still bring to
   * the top of the waste, the current waste top excluded. Draw 1: all of the stock and the waste.
   * Draw 3: the rest of the current pass, plus a fresh pass after a recycle (they can differ once
   * a card has been played from the waste mid-pass).
   */
  function listExposable(state) {
    const stock = state.piles.stock;
    const waste = state.piles.waste;
    const step = state.drawCount === 3 ? 3 : 1;
    const L = stock.length;
    const W = waste.length;
    const M = L + W;
    expoCount = 0;
    if (M === 0) return;
    expoSeen.fill(0);
    if (W > 0) expoSeen[waste[W - 1]] = 1;

    // the rest of this pass: each draw takes `step` cards off the top of the stock
    let k = L;
    while (k > 0) {
      k = k > step ? k - step : 0;
      const c = stock[k];
      if (!expoSeen[c]) {
        expoSeen[c] = 1;
        expo[expoCount++] = c;
      }
    }
    // a fresh pass: the cards come out waste bottom -> top, then the stock top -> bottom
    for (let i = step - 1; ; i += step) {
      if (i > M - 1) i = M - 1; // the last, short draw
      const c = i < W ? waste[i] : stock[L - 1 - (i - W)];
      if (!expoSeen[c]) {
        expoSeen[c] = 1;
        expo[expoCount++] = c;
      }
      if (i === M - 1) break;
    }
  }

  /** Leftmost non-empty column (other than `exclude`) whose top takes `card`; -1 when none. Needs scanTableau. */
  function nonEmptyTarget(state, card, exclude) {
    const want = RANK_OF[card] + 1;
    const red = IS_RED[card];
    const faceUp = state.faceUp;
    for (let k = 0; k < 7; k++) {
      if (k === exclude || tLen[k] === 0) continue;
      const top = tTop[k];
      if (RANK_OF[top] === want && IS_RED[top] !== red && faceUp[top] === true) return k;
    }
    return -1;
  }

  /** Can a card coming from the stock/waste be played anywhere? Needs scanTableau. */
  function loosePlayable(state, card) {
    if (foundationAccepts(state, card)) return true;
    if (RANK_OF[card] === 13) return firstEmpty >= 0;
    return nonEmptyTarget(state, card, -1) >= 0;
  }

  // hint kinds (= priorities)
  const H_FOUNDATION = 1;
  const H_UNCOVER = 2;
  const H_KING = 3;
  const H_WASTE = 4;
  const H_SPLIT = 5;
  const H_DRAW = 6;
  const H_DEEP = 7; // last resort: first step of a rearrangement found by deepSearch()
  const H_LATER = 8; // a foundation move better left for later

  /**
   * Can this card go home without ever being missed? True when nothing could still need to be
   * placed on it: both cards one rank lower in the other colour are on their foundations already.
   */
  function isSafeHome(state, card) {
    const r = RANK_OF[card];
    if (r <= 2) return true;
    const p = state.piles;
    return IS_RED[card] ? p.f0.length >= r - 1 && p.f2.length >= r - 1 : p.f1.length >= r - 1 && p.f3.length >= r - 1;
  }

  /**
   * The useful moves of kinds 1..6, unsorted, as { kind, sub, card, to, aux, from, ... }:
   *   sub   order within the kind (lower first)      from  kind of the pile the card comes from
   *   aux   the card the move lands on (kinds 2, 3, 4; -1 for an empty column), the card a split
   *         frees (kind 5), or 1 when a draw would be a recycle (kind 6)
   *   unc   (kind 1) the move also uncovers a face-down card
   *   tgt   (kind 5) the card the split-off run lands on: the twin of the card it frees
   * With firstOnly it stops at the first one (isStuck only needs to know whether any exists).
   *
   * What is deliberately NOT a hint, because it changes nothing useful:
   *  - a King (run) at the bottom of its column hopping to another empty column;
   *  - moving part of a run between two columns whose tops are "twins" (same rank and colour),
   *    unless the card it exposes can go straight to its foundation;
   *  - emptying a column when no King can use it.
   */
  function rawHints(state, firstOnly) {
    const out = [];
    if (state.won) return out;
    const piles = state.piles;
    scanTableau(state);

    const waste = piles.waste;
    const wasteTop = waste.length > 0 ? waste[waste.length - 1] : -1;

    // ---- 1: to a foundation
    // (order within the kind: moves that also uncover a card, then cards nothing will ever need
    // to be placed on, then the rest; low ranks first)
    if (wasteTop >= 0 && foundationAccepts(state, wasteTop)) {
      const sub = (isSafeHome(state, wasteTop) ? 100 : 200) + RANK_OF[wasteTop] * 2;
      out.push({ kind: H_FOUNDATION, sub: sub, card: wasteTop, to: FOUNDATION_OF[wasteTop], aux: -1, from: K_WASTE, unc: false });
      if (firstOnly) return out;
    }
    for (let t = 0; t < 7; t++) {
      if (tLen[t] === 0) continue;
      const c = tTop[t];
      if (!foundationAccepts(state, c)) continue;
      const uncovers = tDown[t] > 0 && tDown[t] === tLen[t] - 1;
      const sub = (uncovers ? 0 : isSafeHome(state, c) ? 100 : 200) + RANK_OF[c] * 2 + 1;
      out.push({ kind: H_FOUNDATION, sub: sub, card: c, to: FOUNDATION_OF[c], aux: -1, from: K_TABLEAU, unc: uncovers });
      if (firstOnly) return out;
    }

    // ---- 2, 3, 5: tableau -> tableau
    let kingWaiting = -1; // lazily computed: 1 when a King could make use of an empty column
    for (let t = 0; t < 7; t++) {
      const len = tLen[t];
      if (len === 0) continue;
      const d = tDown[t];
      const p = tableauPile(piles, t);
      for (let j = d; j < len; j++) {
        const c = p[j];
        const isKing = RANK_OF[c] === 13;
        if (j === d && d > 0) {
          // the whole face-up run leaves: the card below gets turned over
          // (a lone card that can go home for good is a foundation hint already, not a tableau one)
          if (j === len - 1 && foundationAccepts(state, c) && isSafeHome(state, c)) continue;
          const k = nonEmptyTarget(state, c, t);
          if (k >= 0) out.push({ kind: H_UNCOVER, sub: -d, card: c, to: TABLEAU[k], aux: tTop[k], from: K_TABLEAU });
          else if (isKing && firstEmpty >= 0) out.push({ kind: H_KING, sub: -d, card: c, to: TABLEAU[firstEmpty], aux: -1, from: K_TABLEAU });
          else continue;
          if (firstOnly) return out;
        } else if (j === d) {
          // the column would be emptied: only worth it when a King is waiting for a free column
          if (isKing || firstEmpty >= 0) continue;
          const k = nonEmptyTarget(state, c, t);
          if (k < 0) continue;
          if (kingWaiting < 0) kingWaiting = isKingWaiting(state, wasteTop) ? 1 : 0;
          if (kingWaiting === 0) continue;
          out.push({ kind: H_KING, sub: 100 + len, card: c, to: TABLEAU[k], aux: tTop[k], from: K_TABLEAU });
          if (firstOnly) return out;
        } else {
          // part of a run: useful only when the card it exposes can then go to its foundation
          const exposed = p[j - 1];
          if (!foundationAccepts(state, exposed)) continue;
          let k = nonEmptyTarget(state, c, t);
          if (k < 0 && isKing) k = firstEmpty;
          if (k < 0) continue;
          out.push({ kind: H_SPLIT, sub: RANK_OF[exposed], card: c, to: TABLEAU[k], aux: exposed, from: K_TABLEAU, tgt: tTop[k] });
          if (firstOnly) return out;
        }
      }
    }

    // ---- 4: waste -> tableau (unless the card can go home for good)
    if (wasteTop >= 0 && !(foundationAccepts(state, wasteTop) && isSafeHome(state, wasteTop))) {
      let k = nonEmptyTarget(state, wasteTop, -1);
      if (k < 0 && RANK_OF[wasteTop] === 13) k = firstEmpty;
      if (k >= 0) {
        out.push({ kind: H_WASTE, sub: 0, card: wasteTop, to: TABLEAU[k], aux: tTop[k], from: K_WASTE });
        if (firstOnly) return out;
      }
    }

    // ---- 6: draw, when going through the stock can still bring up a playable card
    listExposable(state);
    for (let i = 0; i < expoCount; i++) {
      if (loosePlayable(state, expo[i])) {
        out.push({ kind: H_DRAW, sub: 0, card: -1, to: '', aux: piles.stock.length > 0 ? 0 : 1, from: K_STOCK });
        break;
      }
    }
    return out;
  }

  /**
   * Is there a King that would use an empty column? Either a face-up King lying on face-down cards,
   * the waste top, or a King the stock can still bring up. Needs scanTableau.
   */
  function isKingWaiting(state, wasteTop) {
    const piles = state.piles;
    for (let t = 0; t < 7; t++) {
      const d = tDown[t];
      if (d > 0 && d < tLen[t] && RANK_OF[tableauPile(piles, t)[d]] === 13) return true;
    }
    if (wasteTop >= 0 && RANK_OF[wasteTop] === 13) return true;
    listExposable(state);
    for (let i = 0; i < expoCount; i++) {
      if (RANK_OF[expo[i]] === 13) return true;
    }
    return false;
  }

  // ---- last-resort search -------------------------------------------------------------------
  // When no ordinary hint exists the game may still not be dead: a card taken back from a
  // foundation, or a reshuffle of runs, can open a move that uncovers a card or plays a stock card.
  // Those two events are the only ones that can bring a blocked game forward, and both are one-way
  // (face-down cards and the stock only ever shrink). So a breadth-first search over the "quiet"
  // moves (tableau <-> tableau, tableau <-> foundation, none of which turns a card) decides exactly
  // whether one of them is still reachable. It runs in roughly one in five games, usually over a
  // few dozen positions; when it runs out of budget the answer is "unknown", i.e. not stuck.
  //
  // It runs on its own compact model instead of apply()/undo so that thousands of positions cost
  // a few milliseconds: a position is a "parent map" — for every card that can move, the card it
  // lies on (or P_FOUND: on its foundation, P_EMPTY: at the bottom of a column without hidden
  // cards). A move changes exactly one entry, so child positions are a 52-byte copy plus one write,
  // and the position hash updates with two XORs. Columns without hidden cards are interchangeable,
  // which the parent map folds together for free.
  const P_FOUND = 52;
  const P_EMPTY = 53;
  const P_NONE = 54; // stock, waste and face-down cards: they never move in this search
  const P_CODES = 55;
  const DEEP_MAX_NODES = 5000;

  // The two cards a card may be placed on in the tableau (-1 for Kings).
  const PARENT_A = new Int8Array(52);
  const PARENT_B = new Int8Array(52);
  for (let id = 0; id < 52; id++) {
    const r = RANK_OF[id];
    if (r === 13) {
      PARENT_A[id] = -1;
      PARENT_B[id] = -1;
    } else if (IS_RED[id]) {
      PARENT_A[id] = r; // spades, one rank up (index r = rank r + 1)
      PARENT_B[id] = 26 + r; // clubs
    } else {
      PARENT_A[id] = 13 + r; // hearts
      PARENT_B[id] = 39 + r; // diamonds
    }
  }

  // Results for the most recent positions (a player cycling through the stock in a blocked game
  // comes back to the same few dozen positions again and again).
  const DEEP_CACHE_SIZE = 64;
  const deepCache = new Map();
  let dsPool = null; // Int8Array: DEEP_MAX_NODES parent maps
  let dsFirst = null; // Int16Array: first move of the path to each node (card * 64 + new parent), -1 at the root
  let dsUp = null; // Int16Array: the node each node was reached from
  let dsVia = null; // Int16Array: the move (card * 64 + new parent) that led from dsUp[n] to node n
  let dsH1 = null;
  let dsH2 = null;
  let dsZ1 = null; // Zobrist keys per (card, parent)
  let dsZ2 = null;
  // visited set: open addressing on the 64-bit position hash (h1, h2); a slot is live when its
  // stamp equals the current search number, so nothing has to be cleared between searches
  const DS_TABLE = 16384; // power of two, > 2 * DEEP_MAX_NODES
  let dsTabA = null;
  let dsTabB = null;
  let dsTabStamp = null;
  let dsStamp = 0;
  const dsMobile = new Int8Array(52);
  const dsChild = new Int8Array(52);
  const dsHidden = new Uint8Array(52); // 1 for face-down tableau cards
  const dsRootPile = new Int8Array(52); // tableau column of each card in the position searched
  const dsFh = new Int8Array(4);

  function ensureDeepBuffers() {
    if (dsPool) return;
    dsPool = new Int8Array(DEEP_MAX_NODES * 52);
    dsFirst = new Int16Array(DEEP_MAX_NODES);
    dsUp = new Int16Array(DEEP_MAX_NODES);
    dsVia = new Int16Array(DEEP_MAX_NODES);
    dsH1 = new Int32Array(DEEP_MAX_NODES);
    dsH2 = new Int32Array(DEEP_MAX_NODES);
    dsZ1 = new Int32Array(52 * P_CODES);
    dsZ2 = new Int32Array(52 * P_CODES);
    dsTabA = new Int32Array(DS_TABLE);
    dsTabB = new Int32Array(DS_TABLE);
    dsTabStamp = new Uint32Array(DS_TABLE);
    const keys = rng().create(0x51ed270b);
    for (let i = 0; i < dsZ1.length; i++) {
      dsZ1[i] = (keys.next() * 4294967296) | 0;
      dsZ2[i] = (keys.next() * 4294967296) | 0;
    }
  }

  /** Identifies the foundations and the tableau of a position — everything but the stock and the waste. */
  function layoutKey(state) {
    const p = state.piles;
    const faceUp = state.faceUp;
    let s = 'L';
    for (let i = 2; i < PILE_IDS.length; i++) {
      // (PILE_IDS: stock, waste, then the foundations and the tableau)
      const pile = p[PILE_IDS[i]];
      s += '|';
      for (let j = 0; j < pile.length; j++) s += String.fromCharCode(48 + pile[j]);
    }
    s += '|';
    for (let t = 0; t < 7; t++) {
      const pile = p[TABLEAU[t]];
      let d = 0;
      while (d < pile.length && faceUp[pile[d]] !== true) d++;
      s += String.fromCharCode(48 + d);
    }
    return s;
  }

  /** Identifies a whole position (the search results are cached under it). `layout` = layoutKey(state). */
  function positionKey(state, layout) {
    const stock = state.piles.stock;
    const waste = state.piles.waste;
    let s = state.drawCount === 3 ? '3|' : '1|';
    for (let j = 0; j < stock.length; j++) s += String.fromCharCode(48 + stock[j]);
    s += '|';
    for (let j = 0; j < waste.length; j++) s += String.fromCharCode(48 + waste[j]);
    return s + (layout === undefined ? layoutKey(state) : layout);
  }

  /** Stores a search result under a position key, dropping the oldest entry when the cache is full. */
  function cacheResult(key, result) {
    deepCache.delete(key); // (re-inserting moves the key to the young end)
    if (deepCache.size >= DEEP_CACHE_SIZE) deepCache.delete(deepCache.keys().next().value);
    deepCache.set(key, result);
  }

  /** A search move (card * 64 + new parent) as an action in the position `state`; null when it does not fit. */
  function searchMoveToAction(state, code) {
    const card = code >> 6;
    const q = code & 63;
    if (q === P_FOUND) return { type: 'move', card: card, to: FOUNDATION_OF[card] };
    for (let t = 0; t < 7; t++) {
      const pile = tableauPile(state.piles, t);
      const n = pile.length;
      if (q === P_EMPTY ? n === 0 : n > 0 && pile[n - 1] === q) return { type: 'move', card: card, to: TABLEAU[t] };
    }
    return null;
  }

  /**
   * The search found a way forward that takes several moves (`codes`, first move first). Remember,
   * for every position along it, the move that continues it. Someone following the hints is then
   * led down that same path to its end, instead of depending on a fresh search from every position
   * on the way — which can run out of budget where the first one did not, and would leave them
   * with nothing better than "put the card back" (and hints going round in circles).
   */
  function cachePath(state, codes) {
    const p = state.piles;
    const work = {
      v: 1,
      id: '',
      seed: 0,
      drawCount: state.drawCount,
      piles: {
        stock: p.stock.slice(),
        waste: p.waste.slice(),
        f0: p.f0.slice(),
        f1: p.f1.slice(),
        f2: p.f2.slice(),
        f3: p.f3.slice(),
        t0: p.t0.slice(),
        t1: p.t1.slice(),
        t2: p.t2.slice(),
        t3: p.t3.slice(),
        t4: p.t4.slice(),
        t5: p.t5.slice(),
        t6: p.t6.slice(),
      },
      faceUp: state.faceUp.slice(),
      score: 0,
      moves: 0,
      undos: 0,
      recycles: 0,
      elapsedMs: 0,
      won: false,
      history: [],
    };
    for (let i = 0; i + 1 < codes.length; i++) {
      const step = searchMoveToAction(work, codes[i]);
      if (step === null || applyMove(work, step.card, step.to, false) === null) return;
      const next = searchMoveToAction(work, codes[i + 1]);
      if (next === null) return;
      cacheResult(positionKey(work), { status: 'found', action: next });
    }
  }

  /** Search helper: could stock/waste card `e` be played in the position at `base`? (dsChild / dsFh are current) */
  function deepPlayable(e, base, empties) {
    const r = RANK_OF[e];
    if (dsFh[SUIT_OF[e]] === r - 1) return true;
    if (r === 13) return empties > 0;
    const a = PARENT_A[e];
    const b = PARENT_B[e];
    const ap = dsPool[base + a];
    const bp = dsPool[base + b];
    // a tableau top: lies in the tableau (not on a foundation, not hidden/stock) with nothing on it
    return (ap !== P_FOUND && ap !== P_NONE && dsChild[a] < 0) || (bp !== P_FOUND && bp !== P_NONE && dsChild[b] < 0);
  }

  /**
   * -> { status: 'found' | 'none' | 'budget', action }
   *   'found'  a sequence of quiet moves leads to a move that uncovers a card, or makes a
   *            stock/waste card playable; `action` is the first step of the shortest such sequence
   *            ({ type: 'draw' } when the playable card still has to be drawn)
   *   'none'   the whole reachable space was searched: nothing can make progress ever again
   *   'budget' the search was cut short: unknown
   * Only worth calling when no ordinary progress move exists (the root position is not examined
   * for playable stock/waste cards: those are ordinary hints). Recent results are cached.
   */
  function deepSearch(state) {
    // Nothing hidden and nothing left to draw: there is no progress of that kind to look for.
    if (!hasUnseen(state)) return { status: 'none', action: null };
    const layout = layoutKey(state);
    const key = positionKey(state, layout);
    const cached = deepCache.get(key) || deepCache.get(layout);
    if (cached) return cached;
    ensureDeepBuffers();

    const pool = dsPool;
    const first = dsFirst;
    const h1s = dsH1;
    const h2s = dsH2;
    const z1 = dsZ1;
    const z2 = dsZ2;
    const mobile = dsMobile;
    const child = dsChild;
    const hidden = dsHidden;
    const fh = dsFh;
    const piles = state.piles;
    const faceUp = state.faceUp;

    // ---- the root position
    pool.fill(P_NONE, 0, 52);
    hidden.fill(0);
    let mobileCount = 0;
    let emptyCapable = 0; // columns without face-down cards: the only ones that can ever be empty
    let rootEmpty = -1;
    for (let t = 0; t < 7; t++) {
      const p = tableauPile(piles, t);
      const len = p.length;
      let d = 0;
      while (d < len && faceUp[p[d]] !== true) d++;
      if (d === 0) emptyCapable++;
      if (len === 0 && rootEmpty < 0) rootEmpty = t;
      for (let j = 0; j < d; j++) hidden[p[j]] = 1;
      for (let j = d; j < len; j++) {
        const c = p[j];
        pool[c] = j === 0 ? P_EMPTY : p[j - 1];
        mobile[mobileCount++] = c;
        dsRootPile[c] = t;
      }
    }
    for (let s = 0; s < 4; s++) {
      const f = foundationPile(piles, s);
      for (let j = 0; j < f.length; j++) {
        pool[f[j]] = P_FOUND;
        mobile[mobileCount++] = f[j];
      }
    }
    let rh1 = 0;
    let rh2 = 0;
    for (let i = 0; i < mobileCount; i++) {
      const z = mobile[i] * P_CODES + pool[mobile[i]];
      rh1 ^= z1[z];
      rh2 ^= z2[z];
    }
    h1s[0] = rh1;
    h2s[0] = rh2;
    first[0] = -1;

    const waste = piles.waste;
    const wasteTop = waste.length > 0 ? waste[waste.length - 1] : -1;
    listExposable(state);
    const others = expo.slice(0, expoCount);
    // Stock and waste cards that drawing can never bring up from here (draw 3 only). They are not
    // goals for this position, but they tell whether a "nothing" verdict would also hold for every
    // other order of the same stock and waste cards (see the end of this function).
    const unreachable = [];
    for (let i = 0; i < piles.stock.length; i++) {
      if (!expoSeen[piles.stock[i]]) unreachable.push(piles.stock[i]);
    }
    for (let i = 0; i < waste.length; i++) {
      if (!expoSeen[waste[i]]) unreachable.push(waste[i]);
    }
    let otherOrder = false; // one of those cards could be played somewhere in the space searched

    const tabA = dsTabA;
    const tabB = dsTabB;
    const tabStamp = dsTabStamp;
    const mask = DS_TABLE - 1;
    dsStamp = dsStamp >= 0xfffffff0 ? 1 : dsStamp + 1;
    if (dsStamp === 1) tabStamp.fill(0);
    const stamp = dsStamp;
    const rootAt = (rh1 ^ (rh2 >>> 9)) & mask;
    tabStamp[rootAt] = stamp;
    tabA[rootAt] = rh1;
    tabB[rootAt] = rh2;
    let count = 1;
    let head = 0;
    let found = -1; // encoded first move towards a goal the player can act on right now
    let goalNode = 0; // the node the goal was found at...
    let goalMove = -1; // ...and the uncovering move made there (-1: the goal is the position itself)
    let viaDraw = false; // a stock card becomes playable, but it has to be drawn first
    let stopAt = DEEP_MAX_NODES; // once drawing is known to work, only look a little further for better
    let budget = false;

    for (; head < count && found < 0 && head < stopAt; head++) {
      const base = head * 52;
      const firstMove = first[head];

      // rebuild what the parent map implies: who lies on whom, foundation heights, free columns
      child.fill(-1);
      let bottoms = 0;
      for (let i = 0; i < mobileCount; i++) {
        const c = mobile[i];
        const p = pool[base + c];
        if (p < 52) child[p] = c;
        else if (p === P_EMPTY) bottoms++;
      }
      const empties = emptyCapable - bottoms;
      for (let s = 0; s < 4; s++) {
        let h = 0;
        const s13 = s * 13;
        while (h < 13 && pool[base + s13 + h] === P_FOUND) h++;
        fh[s] = h;
      }

      for (let i = 0; !otherOrder && i < unreachable.length; i++) {
        if (deepPlayable(unreachable[i], base, empties)) otherOrder = true;
      }

      // goal: a card from the stock/waste can be played in this arrangement
      if (head > 0) {
        if (wasteTop >= 0 && deepPlayable(wasteTop, base, empties)) {
          found = firstMove;
          goalNode = head;
          break;
        }
        for (let i = 0; !viaDraw && i < others.length; i++) {
          if (deepPlayable(others[i], base, empties)) {
            viaDraw = true;
            stopAt = head * 2 + 64;
          }
        }
      }

      // expand: every quiet move of this position
      expand: for (let i = 0; i < mobileCount; i++) {
        const c = mobile[i];
        const p = pool[base + c];
        const r = RANK_OF[c];
        let uncovers = false;
        if (p === P_FOUND) {
          if (r !== fh[SUIT_OF[c]]) continue; // only the top card of a foundation can come back
        } else {
          uncovers = p < 52 && hidden[p] === 1;
        }

        // candidate new parents: foundation, the two tableau parents, an empty column
        for (let slot = 0; slot < 4; slot++) {
          let q;
          if (slot === 0) {
            if (p === P_FOUND || child[c] >= 0 || fh[SUIT_OF[c]] !== r - 1) continue;
            q = P_FOUND;
          } else if (slot === 3) {
            if (r !== 13 || empties === 0 || p === P_EMPTY) continue;
            q = P_EMPTY;
          } else {
            q = slot === 1 ? PARENT_A[c] : PARENT_B[c];
            if (q < 0) continue;
            const qp = pool[base + q];
            // q must be the top card of a tableau column...
            if (qp === P_FOUND || qp === P_NONE || child[q] >= 0) continue;
            // ...and not the top of the run being moved (impossible in a real game)
            let x = c;
            while (child[x] >= 0) x = child[x];
            if (x === q) continue;
          }

          const code = c * 64 + q;
          if (uncovers) {
            // goal: this move turns over a hidden card
            found = firstMove >= 0 ? firstMove : code;
            goalNode = head;
            goalMove = code;
            break expand;
          }
          const zc = c * P_CODES;
          const nh1 = h1s[head] ^ z1[zc + p] ^ z1[zc + q];
          const nh2 = h2s[head] ^ z2[zc + p] ^ z2[zc + q];
          let at = (nh1 ^ (nh2 >>> 9)) & mask;
          let seen = false;
          while (tabStamp[at] === stamp) {
            if (tabA[at] === nh1 && tabB[at] === nh2) {
              seen = true;
              break;
            }
            at = (at + 1) & mask;
          }
          if (seen) continue;
          if (count >= DEEP_MAX_NODES) {
            budget = true; // out of room: the answer can no longer be "nothing is reachable"
            continue;
          }
          tabStamp[at] = stamp;
          tabA[at] = nh1;
          tabB[at] = nh2;
          const nb = count * 52;
          pool.copyWithin(nb, base, base + 52);
          pool[nb + c] = q;
          h1s[count] = nh1;
          h2s[count] = nh2;
          first[count] = firstMove >= 0 ? firstMove : code;
          dsUp[count] = head;
          dsVia[count] = code;
          count++;
        }
      }
    }

    let result;
    if (found >= 0) {
      const card = found >> 6;
      const q = found & 63;
      const to = q === P_FOUND ? FOUNDATION_OF[card] : q === P_EMPTY ? TABLEAU[rootEmpty] : TABLEAU[dsRootPile[q]];
      result = { status: 'found', action: { type: 'move', card: card, to: to } };
      // a path of several moves: remember how it goes on from each position along it
      const codes = [];
      if (goalMove >= 0) codes.push(goalMove);
      for (let n = goalNode; n > 0; n = dsUp[n]) codes.push(dsVia[n]);
      if (codes.length > 1) cachePath(state, codes.reverse());
    } else if (viaDraw) {
      result = { status: 'found', action: { type: 'draw' } };
    } else if (budget) {
      result = { status: 'budget', action: null };
    } else {
      result = { status: 'none', action: null };
    }
    // A verdict of "nothing" (or "unknown") reached without any stock or waste card being playable
    // anywhere in the space searched does not depend on the order of those cards: it is remembered
    // for the layout. Someone going round and round the stock in a dead game then costs one
    // search, not one for every draw.
    cacheResult(found < 0 && !viaDraw && !otherOrder ? layout : key, result);
    return result;
  }

  /**
   * Is there anything left that could still come into play: a face-down tableau card, or a card in
   * the stock or the waste? When there is not, the rest of the game is plain foundation building.
   */
  function hasUnseen(state) {
    const piles = state.piles;
    if (piles.stock.length > 0 || piles.waste.length > 0) return true;
    for (let t = 0; t < 7; t++) {
      const p = tableauPile(piles, t);
      if (p.length > 0 && state.faceUp[p[0]] !== true) return true;
    }
    return false;
  }

  /**
   * Did the player take this card back from its foundation and leave it in the tableau since?
   * (Looks at the most recent time the card crossed a foundation.)
   */
  function wasTakenBack(state, card) {
    const history = state.history;
    for (let i = history.length - 1; i >= 0; i--) {
      const record = history[i];
      if (record.type !== 'move') continue;
      const tr = record.transfers[0];
      if (tr.card !== card) continue;
      if (KIND_CODE[tr.from] === K_FOUNDATION) return true;
      if (KIND_CODE[tr.to] === K_FOUNDATION) return false;
    }
    return false;
  }

  function the(card) {
    return 'the ' + CARD_NAMES[card];
  }

  function describeHint(h) {
    switch (h.kind) {
      case H_FOUNDATION:
        return (h.back ? 'Return ' : 'Move ') + the(h.card) + ' to its foundation';
      case H_UNCOVER:
        return 'Move ' + the(h.card) + ' onto ' + the(h.aux) + ' to turn over a hidden card';
      case H_KING:
        return h.aux < 0
          ? 'Move ' + the(h.card) + ' to the empty column to turn over a hidden card'
          : 'Move ' + the(h.card) + ' onto ' + the(h.aux) + ' to free a column for a King';
      case H_WASTE:
        return h.aux < 0
          ? 'Play ' + the(h.card) + ' from the waste to the empty column'
          : 'Play ' + the(h.card) + ' from the waste onto ' + the(h.aux);
      case H_SPLIT:
        return 'Move ' + the(h.card) + ' away to free ' + the(h.aux) + ' for its foundation';
      case H_DRAW:
        return h.aux === 1 ? 'Turn the waste over and go through the stock again' : 'Draw from the stock';
      default:
        return '';
    }
  }

  function describeDeep(state, action) {
    if (action.type === 'draw') {
      return state.piles.stock.length > 0
        ? 'Draw from the stock: a card there can be played after a rearrangement'
        : 'Turn the waste over: a card there can be played after a rearrangement';
    }
    const fromFoundation = state.piles[FOUNDATION_OF[action.card]].indexOf(action.card) >= 0;
    if (fromFoundation) return 'Take ' + the(action.card) + ' back from its foundation to open up a move';
    if (KIND_CODE[action.to] === K_FOUNDATION) return 'Move ' + the(action.card) + ' to its foundation to open up a move';
    return 'Move ' + the(action.card) + ' across to open up a move';
  }

  /**
   * Useful moves, best first: [{ action, priority, reason }]. See the header for the priorities.
   * Every action returned is legal. [] when the game is won or nothing useful is left.
   *
   * Some foundation moves are "soft": the card may still be wanted in the tableau (something could
   * be placed on it), or the player deliberately took it back from its foundation. While other
   * hints exist they are listed normally — except that a take-back, and a card something is
   * waiting to be built on, go to the end (priority 8). When soft moves are all that is left, the
   * last-resort search decides: if a rearrangement can still reopen the game it comes first
   * (priority 7) and the soft moves wait (priority 8); if nothing can, they are plain foundation
   * moves again. This is what keeps "follow the first hint" from going round in circles.
   */
  function hints(state) {
    const raw = rawHints(state, false);
    // Holding a card back from its foundation only makes sense while something can still be
    // uncovered or drawn that the rest of the game does not already take care of.
    const unseen = raw.length > 0 && hasUnseen(state) && !canAutoComplete(state);

    // ---- classify the foundation-bound hints (a split counts: its point is the card it frees)
    let live = 0;
    let listed = false;
    for (let i = 0; i < raw.length; i++) {
      const h = raw[i];
      h.prio = h.kind;
      h.soft = false; // the card may still be wanted in the tableau
      h.back = false; // the player took the card back from its foundation
      h.needed = false; // something is waiting to be built on the card right now
      const toHome = h.from === K_TABLEAU && ((h.kind === H_FOUNDATION && !h.unc) || h.kind === H_SPLIT);
      if (unseen && toHome) {
        const home = h.kind === H_SPLIT ? h.aux : h.card; // the card that would go to its foundation
        const twin = h.kind === H_SPLIT ? h.tgt : -1; // a split covers the twin: what builds there now needs `home` next
        h.back = wasTakenBack(state, home);
        h.soft = h.back || !isSafeHome(state, home);
        if (h.soft) {
          // another hint wants to build on it...
          for (let j = 0; j < raw.length && !h.needed; j++) {
            const o = raw[j];
            if (o.aux < 0 || (o.kind !== H_UNCOVER && o.kind !== H_KING && o.kind !== H_WASTE)) continue;
            h.needed = o.aux === home || o.aux === twin;
          }
          // ...or a card the stock can still bring up could be played on it
          if (!h.needed) {
            if (!listed) {
              listExposable(state);
              listed = true;
            }
            for (let j = 0; j < expoCount && !h.needed; j++) {
              const e = expo[j];
              h.needed = (PARENT_A[e] === home || PARENT_B[e] === home) && !(foundationAccepts(state, e) && isSafeHome(state, e));
            }
          }
        }
      }
      if (!h.soft) live++;
    }

    // ---- decide what the soft ones are worth
    let deepHint = null;
    let status = '';
    if (live > 0) {
      // there are better things to do first
      for (let i = 0; i < raw.length; i++) {
        if (raw[i].back || raw[i].needed) raw[i].prio = H_LATER;
      }
    } else if (hasUnseen(state) && !state.won && !canAutoComplete(state)) {
      // nothing else is left: only a search can tell whether these cards should stay down
      const deep = deepSearch(state);
      status = deep.status;
      if (status === 'found') {
        const a = deep.action;
        let covered = false; // the rearrangement starts with one of the soft moves: that one is the hint
        for (let i = 0; i < raw.length; i++) {
          const h = raw[i];
          if (a.type === 'move' && a.card === h.card && a.to === h.to) covered = true;
          else h.prio = H_LATER;
        }
        if (!covered) {
          deepHint = {
            action: a.type === 'draw' ? { type: 'draw' } : { type: 'move', card: a.card, to: a.to },
            priority: H_DEEP,
            reason: describeDeep(state, a),
          };
        }
      } else if (status === 'budget') {
        // unknown: at least do not send a card straight back that was taken down on purpose
        for (let i = 0; i < raw.length; i++) {
          if (raw[i].back) raw[i].prio = H_LATER;
        }
      }
      // 'none': nothing will ever be uncovered or drawn again, so they are plain foundation moves
    }
    raw.sort(function (a, b) {
      return a.prio - b.prio || a.kind - b.kind || a.sub - b.sub;
    });

    const out = [];
    for (let i = 0; i < raw.length; i++) {
      const h = raw[i];
      if (h.prio === H_LATER) {
        if (deepHint) {
          out.push(deepHint);
          deepHint = null;
        }
      }
      out.push({
        action: h.kind === H_DRAW ? { type: 'draw' } : { type: 'move', card: h.card, to: h.to },
        priority: h.prio,
        reason: describeHint(h),
      });
    }
    if (deepHint) out.push(deepHint);
    return out;
  }

  /**
   * True when the game is not won and nothing can make progress any more: no useful move (hint
   * kinds 1-5), no card the stock can still bring up has a legal target, and the last-resort
   * search proves that no rearrangement (including taking cards back from the foundations) can
   * ever uncover a card or play a stock/waste card again. Never true while a foundation move or
   * any other useful move exists; when the proof is too big for the search budget it is false.
   */
  function isStuck(state) {
    if (state.won || isWon(state)) return false;
    if (rawHints(state, true).length > 0) return false;
    // With every card face-up and none left to draw, a game played by the rules always finishes.
    if (!hasUnseen(state)) return false;
    return deepSearch(state).status === 'none';
  }

  // ------------------------------------------------------------------ export
  SOL.Engine = {
    SUITS: SUITS,
    SUIT_SYMBOLS: SUIT_SYMBOLS,
    RANK_LABELS: RANK_LABELS,
    FOUNDATIONS: FOUNDATIONS,
    TABLEAU: TABLEAU,
    PILE_IDS: PILE_IDS,
    SCORE: SCORE,

    suitOf: suitOf,
    rankOf: rankOf,
    isRed: isRed,
    cardInfo: cardInfo,
    pileKind: pileKind,
    foundationFor: foundationFor,

    newGame: newGame,
    clone: clone,
    serialize: serialize,
    deserialize: deserialize,

    locate: locate,
    topCard: topCard,
    isFaceUp: isFaceUp,
    canPickup: canPickup,
    getRun: getRun,
    canDrop: canDrop,
    legalTargets: legalTargets,
    legalMoves: legalMoves,
    bestTarget: bestTarget,
    canDraw: canDraw,
    canUndo: canUndo,
    hints: hints,
    isWon: isWon,
    isStuck: isStuck,
    canAutoComplete: canAutoComplete,
    nextAutoAction: nextAutoAction,
    timeBonus: timeBonus,

    apply: apply,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = SOL.Engine;
})(typeof window !== 'undefined' ? window : globalThis);
