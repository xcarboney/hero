/*
 * SOL.Game — the controller — and the bootstrap.
 *
 * The controller owns the engine state. Every player action goes: Game.<action>() -> SOL.Engine.apply() ->
 * SOL.Board.apply(state, record) (animation) -> save -> events. Nothing waits for an animation except the
 * deal and the win celebration (the only two things that lock input).
 *
 * PUBLIC API (contract section 10; extras are marked)
 *   Game.state                         the current engine state — read-only for everyone else (null before init)
 *   Game.init()                        restores the saved game (quick settle-in) or deals a new one. A corrupt
 *                                      save is discarded silently; a saved game that was already won is not
 *                                      restored (a new one is dealt).
 *   Game.newGame({ seed, drawCount } = {}) -> Promise<boolean>
 *                                      gathers the cards, shuffles, deals. drawCount defaults to the setting;
 *                                      without a seed the 'winnableOnly' setting asks SOL.Solver for a certified
 *                                      seed while the shuffle plays (hard limit Game.SOLVER_LIMIT_MS, then an
 *                                      uncertified random seed). Resolves true when the deal has landed, false
 *                                      when it was superseded (another newGame / loadState).
 *   Game.restartDeal() -> Promise<boolean>     same seed and drawCount, new game id
 *   Game.draw() -> boolean
 *   Game.move(cardId, toPile, { source } = {}) -> boolean     (extra) source: 'drag' for a drop from the hand
 *   Game.autoMove(cardId) -> boolean   to SOL.Engine.bestTarget
 *   Game.undo() -> boolean
 *   Game.hint() -> boolean             shows the best hint; false (and a gentle cue) when there is none
 *   Game.autoComplete() -> Promise<boolean>    plays the game out; true when it ended in a win
 *   Game.inspect(cardId) -> boolean    opens SOL.Inspector on a face-up card, passing { sourceEl, cards } where
 *                                      cards = every card that is face-up right now (so previous / next never
 *                                      shows a hidden card)
 *   Game.pause(reason) / Game.resume(reason)   reference-counted per reason; while any reason is held the clock
 *                                      is stopped and the table ignores input
 *   Game.isBusy() -> boolean           dealing / auto-completing / celebrating
 *   Game.loadState(stateOrString) -> boolean   testing hook: validates (SOL.Engine.deserialize), replaces the
 *                                      state, renders it instantly, emits 'game:new' { restored: true }
 *   Game.getStatus() -> { score, moves, elapsedMs, canUndo, canHint, canAutoComplete, stockCount, wasteCount,
 *                         drawCount, won, started, busy, seed }
 *   (extras) Game.isPaused(), Game.inputLocked() (paused or busy), Game.hurry() (a tap during the deal: the
 *   rest of it plays 3x faster), Game.getHints() (cached SOL.Engine.hints of the current position),
 *   Game.isStuck(), Game.save() (write the save now).
 *
 * EVENTS (SOL.Bus)
 *   'game:new'     { state, restored }       a new state is on the table (emitted when the deal STARTS)
 *   'game:change'  { state, record }         after every applied action, undo included
 *   'game:status'  getStatus()               whenever a field may have changed
 *   'game:tick'    { elapsedMs }             once a second while the clock runs
 *   'game:won'     { score, bonus, total, moves, elapsedMs, seed, drawCount, isBestScore, isBestTime }
 *                                            emitted at once. The celebration (SOL.Celebrate.play) starts as
 *                                            soon as the winning card has landed; Game.isBusy() is true from
 *                                            the win until the show is over or skipped. When the last 'modal'
 *                                            pause ends on a won table (the win screen's "Watch the cards"),
 *                                            the celebration plays an encore (at most twice per win).
 *   'game:stuck'   {}                        once per stuck episode, a moment after the move that caused it
 *   'game:busy'    { busy }
 *
 * RULES OF THE HOUSE
 *   - The clock starts with the first action of a session (also for a restored game) and stops on a win, while
 *     paused, while the page is hidden and during the deal.
 *   - The game is saved (SOL.Save) after every change — in the next task, so a burst of actions costs one
 *     write — and synchronously when the page is hidden.
 *   - Stats: recordStart on the first action of a game, recordWin on a win (best score uses score + time bonus).
 *   - Settings apply live: theme, card back, animation speed, reduced motion, sound / volume, effects quality,
 *     handedness, haptics. drawCount applies to the next deal.
 *
 * The bootstrap at the bottom starts the modules in order (settings -> Anim / FX / Audio -> Board -> Input ->
 * Inspector -> UI -> Game.init()); a missing or throwing module is logged and skipped, never fatal.
 */
(function (root) {
  'use strict';

  const SOL = (root.SOL = root.SOL || {});
  const doc = root.document;

  const SOLVER_LIMIT_MS = 2600; // hard wall-clock limit for the winnable-seed search
  const SOLVER_BUDGET_MS = 1600;
  const STUCK_DELAY_MS = 750; // let the last move land before the "no more moves" prompt
  const AUTO_GAP_START = 125;
  const AUTO_GAP_END = 42;
  const HURRY = 3;
  const ENCORE_DELAY_MS = 320;
  const LANDING_LIMIT_MS = 1200;

  let state = null;
  let version = 0; // bumped on every state change: cache key for hints / stuck
  let armed = false; // the player acted in this session (the clock may run)
  let hidden = false;
  const busy = new Set(); // 'deal' | 'auto' | 'celebrate'
  const pauses = new Map(); // reason -> count

  // clock
  let clockOn = false;
  let clockBase = 0; // elapsed ms at the moment the clock last started
  let clockStart = 0; // performance.now() at that moment
  let tickTimer = 0;

  let saveTimer = 0;
  let dealToken = 0;
  let autoToken = 0;
  let winToken = 0;
  let encoreTimer = 0;
  let encoresLeft = 0; // per win: closing dialogs on a won table must not turn into an endless party
  let hurried = false;

  const hintCache = { v: -1, list: [] };
  let stuck = false;
  let stuckAnnounced = false;
  let stuckTimer = 0;

  // ------------------------------------------------------------------ helpers
  function E() {
    return SOL.Engine;
  }
  function board() {
    return SOL.Board && SOL.Board.ready ? SOL.Board : null;
  }
  function emit(event, payload) {
    if (SOL.Bus) SOL.Bus.emit(event, payload);
  }
  function now() {
    return root.performance && root.performance.now ? root.performance.now() : Date.now();
  }
  function setting(key, fallback) {
    try {
      return SOL.Settings ? SOL.Settings.get(key) : fallback;
    } catch (err) {
      return fallback;
    }
  }
  function sfx(name, opts) {
    try {
      if (SOL.Audio) SOL.Audio.play(name, opts);
    } catch (err) {
      /* ignore */
    }
  }
  function log(what, err) {
    if (root.console && root.console.error) root.console.error('[SOL.Game] ' + what, err);
  }

  // ------------------------------------------------------------------ clock
  function elapsed() {
    if (!state) return 0;
    return clockOn ? clockBase + (now() - clockStart) : state.elapsedMs;
  }

  function scheduleTick() {
    if (tickTimer) root.clearTimeout(tickTimer);
    tickTimer = 0;
    if (!clockOn) return;
    // fire on whole seconds of game time, so the display never skips or stutters
    const ms = elapsed();
    tickTimer = root.setTimeout(onTick, Math.max(40, 1000 - (ms % 1000) + 4));
  }

  function onTick() {
    tickTimer = 0;
    if (!clockOn || !state) return;
    state.elapsedMs = elapsed();
    emit('game:tick', { elapsedMs: state.elapsedMs });
    scheduleTick();
  }

  /** Starts or stops the clock to match the situation. Call after anything that may change it. */
  function updateClock() {
    const want = !!state && armed && !state.won && !hidden && pauses.size === 0 && !busy.has('deal');
    if (want === clockOn) return;
    if (want) {
      clockBase = state.elapsedMs;
      clockStart = now();
      clockOn = true;
      scheduleTick();
    } else {
      if (state) state.elapsedMs = clockBase + (now() - clockStart);
      clockOn = false;
      if (tickTimer) root.clearTimeout(tickTimer);
      tickTimer = 0;
    }
  }

  // ------------------------------------------------------------------ save
  function saveNow() {
    if (saveTimer) {
      root.clearTimeout(saveTimer);
      saveTimer = 0;
    }
    if (!state || !SOL.Save) return;
    try {
      state.elapsedMs = elapsed();
      SOL.Save.write(E().serialize(state));
    } catch (err) {
      log('save failed', err);
    }
  }

  function scheduleSave() {
    if (saveTimer) return;
    // Next task: the action that triggered it has returned (and painted) first; a burst costs one write.
    saveTimer = root.setTimeout(function () {
      saveTimer = 0;
      saveNow();
    }, 0);
  }

  // ------------------------------------------------------------------ status, hints, stuck
  function hints() {
    if (!state) return [];
    if (hintCache.v !== version) {
      hintCache.v = version;
      try {
        hintCache.list = state.won ? [] : E().hints(state);
      } catch (err) {
        log('hints failed', err);
        hintCache.list = [];
      }
    }
    return hintCache.list;
  }

  function getStatus() {
    const isBusy = busy.size > 0;
    if (!state) {
      return {
        score: 0,
        moves: 0,
        elapsedMs: 0,
        canUndo: false,
        canHint: false,
        canAutoComplete: false,
        stockCount: 0,
        wasteCount: 0,
        drawCount: setting('drawCount', 1),
        won: false,
        started: false,
        busy: isBusy,
        seed: 0,
      };
    }
    const eng = E();
    return {
      score: state.score,
      moves: state.moves,
      elapsedMs: elapsed(),
      canUndo: !isBusy && eng.canUndo(state),
      canHint: !isBusy && !state.won && hints().length > 0,
      canAutoComplete: !isBusy && eng.canAutoComplete(state),
      stockCount: state.piles.stock.length,
      wasteCount: state.piles.waste.length,
      drawCount: state.drawCount,
      won: state.won,
      started: armed || state.moves > 0 || state.undos > 0,
      busy: isBusy,
      seed: state.seed,
    };
  }

  function emitStatus() {
    const b = board();
    if (b && state) {
      // the stock asks for a tap when drawing is the best thing left to do
      const h = hints();
      b.setStockInvite(busy.size === 0 && !state.won && h.length > 0 && h[0].action.type === 'draw' && h[0].priority >= 6);
    }
    emit('game:status', getStatus());
  }

  function setBusy(reason, on) {
    const before = busy.size > 0;
    if (on) busy.add(reason);
    else busy.delete(reason);
    const after = busy.size > 0;
    updateClock();
    if (before !== after) {
      emit('game:busy', { busy: after });
      emitStatus();
    }
  }

  /** Once per action. Announces a stuck position once per episode, a beat after the move that caused it. */
  function checkStuck() {
    if (!state || state.won) {
      stuck = false;
      stuckAnnounced = false;
      return;
    }
    try {
      stuck = E().isStuck(state);
    } catch (err) {
      log('isStuck failed', err);
      stuck = false;
    }
    if (!stuck) {
      stuckAnnounced = false;
      return;
    }
    if (stuckAnnounced) return;
    stuckAnnounced = true;
    const v = version;
    if (stuckTimer) root.clearTimeout(stuckTimer);
    stuckTimer = root.setTimeout(function () {
      stuckTimer = 0;
      if (v === version && state && !state.won && stuck) emit('game:stuck', {});
      else if (v !== version && stuck) stuckAnnounced = false; // the position changed meanwhile: re-check next action
    }, STUCK_DELAY_MS);
  }

  // ------------------------------------------------------------------ actions
  function locked() {
    return pauses.size > 0 || busy.size > 0;
  }

  /** Everything that follows a successful Engine.apply. */
  function afterAction(record, boardOpts) {
    version++;
    if (!armed) {
      armed = true;
      try {
        if (SOL.Stats) SOL.Stats.recordStart(state.id, state.drawCount);
      } catch (err) {
        log('stats failed', err);
      }
    }
    updateClock();
    const b = board();
    if (b) {
      try {
        b.apply(state, record, boardOpts);
      } catch (err) {
        // never leave the table out of step with the state
        log('board.apply failed', err);
        try {
          b.render(state);
        } catch (err2) {
          log('board.render failed', err2);
        }
      }
    }
    scheduleSave();
    emit('game:change', { state: state, record: record });
    if (record.won) onWin();
    else if (!busy.has('auto')) checkStuck();
    emitStatus();
  }

  function draw() {
    if (!state || locked()) return false;
    const record = E().apply(state, { type: 'draw' });
    if (!record) return false;
    afterAction(record);
    return true;
  }

  function move(cardId, toPile, opts) {
    if (!state || locked()) return false;
    const record = E().apply(state, { type: 'move', card: cardId, to: toPile });
    if (!record) return false;
    afterAction(record, opts && opts.source ? { source: opts.source } : undefined);
    return true;
  }

  function autoMove(cardId) {
    if (!state || locked()) return false;
    const to = E().bestTarget(state, cardId);
    if (!to) return false;
    return move(cardId, to, { source: 'tap' });
  }

  function undo() {
    if (!state || locked()) return false;
    const record = E().apply(state, { type: 'undo' });
    if (!record) return false;
    afterAction(record);
    return true;
  }

  function hint() {
    if (!state || locked() || state.won) return false;
    const list = hints();
    const b = board();
    if (list.length === 0) {
      if (b) b.nudgeStock();
      sfx('invalid', { volume: 0.45 });
      return false;
    }
    if (b) b.hint(list[0].action);
    return true;
  }

  function autoComplete() {
    if (!state || locked() || !E().canAutoComplete(state)) return Promise.resolve(false);
    const token = ++autoToken;
    const Anim = SOL.Anim;
    setBusy('auto', true);
    sfx('autocomplete');
    if (SOL.Input) SOL.Input.cancel();
    let step = 0;

    function finish() {
      if (token === autoToken) setBusy('auto', false);
      return !!(state && state.won);
    }

    function next() {
      if (token !== autoToken || !state || state.won) return finish();
      const action = E().nextAutoAction(state);
      if (!action) return finish();
      const record = E().apply(state, action, { auto: true });
      if (!record) return finish();
      afterAction(record, { auto: true, step: step });
      step++;
      if (record.won) return finish();
      // an accelerating cascade
      const gap = Math.max(AUTO_GAP_END, AUTO_GAP_START * Math.pow(0.93, step));
      return (Anim ? Anim.wait(gap) : Promise.resolve()).then(next);
    }

    return Promise.resolve()
      .then(next)
      .catch(function (err) {
        log('autoComplete failed', err);
        return finish();
      });
  }

  // ------------------------------------------------------------------ win
  function onWin() {
    updateClock(); // stops it (state.won) and writes the final time into the state
    const elapsedMs = Math.round(state.elapsedMs);
    const bonus = E().timeBonus(elapsedMs);
    const result = {
      score: state.score,
      bonus: bonus,
      total: state.score + bonus,
      moves: state.moves,
      elapsedMs: elapsedMs,
      seed: state.seed,
      drawCount: state.drawCount,
      isBestScore: false,
      isBestTime: false,
    };
    try {
      if (SOL.Stats) {
        const rec = SOL.Stats.recordWin(state.id, {
          drawCount: state.drawCount,
          score: result.total,
          elapsedMs: elapsedMs,
          moves: state.moves,
        });
        result.isBestScore = !!(rec && rec.isBestScore);
        result.isBestTime = !!(rec && rec.isBestTime);
      }
    } catch (err) {
      log('stats failed', err);
    }
    saveNow();

    encoresLeft = 2;
    celebrate(result);
    // Emitted right away: the UI lets the show run for a moment before it brings up the win screen.
    emit('game:won', result);
  }

  /** Resolves when no card is moving any more (or after `maxMs`): lets the last card land before the show. */
  function whenLanded(maxMs) {
    return new Promise(function (resolve) {
      const t0 = now();
      (function poll() {
        const b = board();
        if (!b || b.busyCount() === 0 || now() - t0 >= maxMs) resolve();
        else root.setTimeout(poll, 40); // waiting for a state, not sequencing an animation
      })();
    });
  }

  /**
   * Runs the win celebration (SOL.Celebrate) and keeps the table busy while it plays. Also used for the
   * encore when the player dismisses the win screen to look at the cards.
   */
  function celebrate(result) {
    if (!state || !state.won || busy.has('celebrate')) return false;
    if (!SOL.Celebrate || typeof SOL.Celebrate.play !== 'function') return false;
    const token = ++winToken;
    setBusy('celebrate', true);
    const done = function () {
      if (token !== winToken) return; // a new game / loadState took over meanwhile
      setBusy('celebrate', false);
    };
    // The winning card finishes its flight (and gets its landing burst) before the foundations erupt.
    whenLanded(LANDING_LIMIT_MS)
      .then(function () {
        if (token !== winToken || !state || !state.won) return null;
        return SOL.Celebrate.play(result);
      })
      .then(done, function (err) {
        log('celebration failed', err);
        done();
      });
    return true;
  }

  /** The last dialog closed on a won table ("Watch the cards"): the cards take another bow. */
  function scheduleEncore() {
    if (encoreTimer) root.clearTimeout(encoreTimer);
    // A beat later: "New game" on the win screen also closes the dialog first, and must not trigger a show.
    encoreTimer = root.setTimeout(function () {
      encoreTimer = 0;
      if (!state || !state.won || hidden || pauses.size > 0 || busy.size > 0 || encoresLeft <= 0) return;
      encoresLeft--;
      celebrate();
    }, ENCORE_DELAY_MS);
  }

  // ------------------------------------------------------------------ new game / restore
  function cancelRunning() {
    dealToken++;
    autoToken++;
    winToken++;
    if (encoreTimer) {
      root.clearTimeout(encoreTimer);
      encoreTimer = 0;
    }
    if (stuckTimer) {
      root.clearTimeout(stuckTimer);
      stuckTimer = 0;
    }
    if (SOL.Input) SOL.Input.cancel();
    try {
      if (SOL.Celebrate && SOL.Celebrate.isPlaying && SOL.Celebrate.isPlaying()) SOL.Celebrate.stop();
    } catch (err) {
      log('celebration stop failed', err);
    }
    busy.delete('auto');
    busy.delete('celebrate');
    endHurry();
  }

  function endHurry() {
    if (!hurried) return;
    hurried = false;
    if (SOL.Anim && SOL.Settings) SOL.Anim.setSpeed(SOL.Settings.speed());
  }

  /** A tap during the deal: the rest of it plays faster. */
  function hurry() {
    if (!busy.has('deal') || hurried || !SOL.Anim) return false;
    hurried = true;
    SOL.Anim.setSpeed((SOL.Settings ? SOL.Settings.speed() : 1) * HURRY);
    return true;
  }

  function resetForNewState() {
    version++;
    armed = false;
    stuck = false;
    stuckAnnounced = false;
    hintCache.v = -1;
    clockOn = false;
    if (tickTimer) root.clearTimeout(tickTimer);
    tickTimer = 0;
  }

  /** Picks the seed for a new deal: given, certified winnable (when asked for and possible), or random. */
  function pickSeed(opts, drawCount) {
    const RNG = SOL.RNG;
    const random = function () {
      return RNG ? RNG.randomSeed() : (Math.random() * 4294967296) >>> 0;
    };
    if (opts && opts.seed !== undefined && opts.seed !== null) return Promise.resolve(opts.seed);
    const solver = SOL.Solver;
    if (!setting('winnableOnly', false) || !solver || typeof solver.findWinnableSeedAsync !== 'function') {
      return Promise.resolve(random());
    }
    return new Promise(function (resolve) {
      let settled = false;
      const finish = function (seed) {
        if (settled) return;
        settled = true;
        root.clearTimeout(limit);
        resolve(seed);
      };
      // Hard limit in wall-clock time: whatever the solver does, the player gets a deal.
      const limit = root.setTimeout(function () {
        finish(random());
      }, SOLVER_LIMIT_MS);
      try {
        Promise.resolve(solver.findWinnableSeedAsync({ drawCount: drawCount, budgetMs: SOLVER_BUDGET_MS })).then(
          function (r) {
            finish(r && typeof r.seed === 'number' && isFinite(r.seed) ? r.seed : random());
          },
          function (err) {
            log('solver failed', err);
            finish(random());
          }
        );
      } catch (err) {
        log('solver failed', err);
        finish(random());
      }
    });
  }

  function newGame(opts) {
    opts = opts || {};
    const eng = E();
    if (!eng) return Promise.resolve(false);
    cancelRunning();
    const token = dealToken;
    const drawCount = opts.drawCount === 1 || opts.drawCount === 3 ? opts.drawCount : setting('drawCount', 1) === 3 ? 3 : 1;
    if (state && clockOn) state.elapsedMs = elapsed();
    clockOn = false;
    if (tickTimer) root.clearTimeout(tickTimer);
    tickTimer = 0;
    armed = false;
    setBusy('deal', true);
    busy.delete('celebrate');
    // The old game is over the moment the cards are swept up.
    if (SOL.Save) SOL.Save.clear();
    if (saveTimer) {
      root.clearTimeout(saveTimer);
      saveTimer = 0;
    }

    let seed = null;
    let seedReady = false;
    pickSeed(opts, drawCount).then(function (s) {
      seed = s;
      seedReady = true;
    });

    const b = board();
    const shuffleUntilSeed = function () {
      if (token !== dealToken) return null;
      return Promise.resolve(b ? b.shuffle() : null).then(function () {
        if (token !== dealToken) return null;
        if (seedReady) return null;
        if (!b) {
          // no board to animate: just wait for the seed
          return new Promise(function (resolve) {
            root.setTimeout(resolve, 30);
          }).then(shuffleUntilSeed);
        }
        return shuffleUntilSeed(); // the solver is still thinking: keep riffling
      });
    };

    return Promise.resolve(b ? b.gather() : null)
      .then(shuffleUntilSeed)
      .then(function () {
        if (token !== dealToken) return false;
        state = eng.newGame({ seed: seed, drawCount: drawCount });
        resetForNewState();
        emit('game:new', { state: state, restored: false });
        emitStatus();
        saveNow();
        return Promise.resolve(b ? b.deal(state) : null).then(function () {
          if (token !== dealToken) return false;
          endHurry();
          setBusy('deal', false);
          checkStuck();
          emitStatus();
          return true;
        });
      })
      .catch(function (err) {
        log('newGame failed', err);
        if (token === dealToken) {
          endHurry();
          if (!state) state = eng.newGame({ drawCount: drawCount });
          try {
            if (b) b.render(state);
          } catch (err2) {
            log('board.render failed', err2);
          }
          setBusy('deal', false);
          emitStatus();
        }
        return false;
      });
  }

  function restartDeal() {
    if (!state) return newGame();
    return newGame({ seed: state.seed, drawCount: state.drawCount });
  }

  function init() {
    const eng = E();
    if (!eng) {
      log('SOL.Engine is missing: no game', null);
      return;
    }
    let restored = null;
    try {
      const text = SOL.Save ? SOL.Save.load() : null;
      if (text) {
        restored = eng.deserialize(text);
        if (!restored && SOL.Save) SOL.Save.clear(); // corrupt: forget it quietly
      }
    } catch (err) {
      restored = null;
    }
    if (restored && !restored.won) {
      state = restored;
      resetForNewState();
      const b = board();
      if (b) b.restore(state);
      emit('game:new', { state: state, restored: true });
      checkStuck();
      emitStatus();
      return;
    }
    newGame();
  }

  function loadState(input) {
    const eng = E();
    if (!eng) return false;
    let next = null;
    try {
      next = eng.deserialize(typeof input === 'string' ? input : JSON.stringify(input));
    } catch (err) {
      next = null;
    }
    if (!next) return false;
    const wasBusy = busy.size > 0;
    cancelRunning();
    busy.clear();
    state = next;
    resetForNewState();
    const b = board();
    if (b) b.render(state);
    if (wasBusy) emit('game:busy', { busy: false });
    emit('game:new', { state: state, restored: true });
    stuck = false;
    saveNow();
    emitStatus();
    return true;
  }

  // ------------------------------------------------------------------ inspector, pause
  function inspect(cardId) {
    if (!state || !Number.isInteger(cardId) || cardId < 0 || cardId > 51) return false;
    if (!state.faceUp[cardId]) return false; // hidden cards stay hidden
    const insp = SOL.Inspector;
    if (!insp || typeof insp.open !== 'function') return false;
    const cards = [];
    for (let id = 0; id < 52; id++) if (state.faceUp[id]) cards.push(id);
    if (SOL.Input) SOL.Input.cancel();
    const b = board();
    if (b) b.clearHint();
    try {
      insp.open(cardId, { sourceEl: b ? b.cardEl(cardId) : null, cards: cards, back: setting('cardBack', undefined) });
    } catch (err) {
      log('inspector failed', err);
      return false;
    }
    return true;
  }

  function pause(reason) {
    const key = String(reason === undefined ? 'default' : reason);
    pauses.set(key, (pauses.get(key) || 0) + 1);
    if (SOL.Input) SOL.Input.cancel();
    updateClock();
  }

  function resume(reason) {
    const key = String(reason === undefined ? 'default' : reason);
    const n = pauses.get(key) || 0;
    if (n <= 1) pauses.delete(key);
    else pauses.set(key, n - 1);
    updateClock();
    if (key === 'modal' && pauses.size === 0 && state && state.won) scheduleEncore();
  }

  // ------------------------------------------------------------------ settings + lifecycle
  function applySetting(key) {
    const S = SOL.Settings;
    if (!S) return;
    try {
      if (key === 'animSpeed' || key === '*') {
        if (SOL.Anim) SOL.Anim.setSpeed(S.speed() * (hurried ? HURRY : 1));
      }
      if (key === 'reducedMotion' || key === '*') {
        if (SOL.Anim) SOL.Anim.setReducedMotion(S.reducedMotion());
      }
      if (key === 'effects' || key === '*') {
        if (SOL.FX) SOL.FX.setQuality(S.get('effects'));
      }
      if (key === 'theme' || key === 'effects' || key === 'reducedMotion' || key === '*') {
        if (SOL.FX && !hidden) SOL.FX.ambient(true, { theme: S.get('theme') });
      }
      if (key === 'sound' || key === '*') {
        if (SOL.Audio) SOL.Audio.setEnabled(!!S.get('sound'));
      }
      if (key === 'volume' || key === '*') {
        if (SOL.Audio) SOL.Audio.setVolume(S.get('volume'));
      }
      const b = board();
      if (b) {
        if (key === 'cardBack' || key === '*') b.setBack(S.get('cardBack'));
        if (key === 'leftHanded' || key === '*') b.setLeftHanded(!!S.get('leftHanded'));
      }
      // drawCount: next deal. tapToMove / haptics / showTimer are read where they are used.
    } catch (err) {
      log('applying setting "' + key + '" failed', err);
    }
  }

  function onVisibility() {
    const nowHidden = doc.visibilityState === 'hidden';
    if (nowHidden === hidden) return;
    hidden = nowHidden;
    if (hidden) {
      if (SOL.Input) SOL.Input.cancel();
      updateClock();
      saveNow();
      // Audio suspends itself (SOL.Audio listens too); the particle loop is told to wind down, and with it
      // the last frame subscriber: the shared animation loop sleeps while nobody is looking.
      try {
        if (SOL.FX) SOL.FX.ambient(false);
      } catch (err) {
        /* ignore */
      }
    } else {
      updateClock();
      try {
        if (SOL.FX) SOL.FX.ambient(true, { theme: setting('theme', 'emerald') });
      } catch (err) {
        /* ignore */
      }
      const b = board();
      if (b) b.relayout(); // the screen may have turned while we were away
      emitStatus();
    }
  }

  // ------------------------------------------------------------------ export
  const Game = {
    get state() {
      return state;
    },
    init: init,
    newGame: newGame,
    restartDeal: restartDeal,
    draw: draw,
    move: move,
    autoMove: autoMove,
    undo: undo,
    hint: hint,
    autoComplete: autoComplete,
    inspect: inspect,
    pause: pause,
    resume: resume,
    isBusy: function () {
      return busy.size > 0;
    },
    isPaused: function () {
      return pauses.size > 0;
    },
    inputLocked: locked,
    hurry: hurry,
    loadState: loadState,
    getStatus: getStatus,
    getHints: function () {
      return hints().slice();
    },
    isStuck: function () {
      return stuck;
    },
    save: saveNow,
    SOLVER_LIMIT_MS: SOLVER_LIMIT_MS,
  };
  SOL.Game = Game;

  // ------------------------------------------------------------------ bootstrap
  function step(name, fn) {
    try {
      fn();
    } catch (err) {
      if (root.console && root.console.error) root.console.error('[SOL] ' + name + ' failed to start', err);
    }
  }

  function missing(name) {
    if (root.console && root.console.info) root.console.info('[SOL] ' + name + ' is not loaded: skipped');
  }

  let booted = false;
  function boot() {
    if (booted || !doc) return;
    booted = true;
    hidden = doc.visibilityState === 'hidden';

    step('settings', function () {
      if (SOL.Settings) SOL.Settings.applyToDocument();
    });
    step('anim', function () {
      if (!SOL.Anim) return missing('SOL.Anim');
      if (SOL.Settings) {
        SOL.Anim.setSpeed(SOL.Settings.speed());
        SOL.Anim.setReducedMotion(SOL.Settings.reducedMotion());
      }
    });
    step('fx', function () {
      if (!SOL.FX) return missing('SOL.FX');
      SOL.FX.init({ back: doc.getElementById('fx-back'), front: doc.getElementById('fx-front') });
      SOL.FX.setQuality(setting('effects', 'high'));
      if (!hidden) SOL.FX.ambient(true, { theme: setting('theme', 'emerald') });
    });
    step('audio', function () {
      if (!SOL.Audio) return missing('SOL.Audio');
      SOL.Audio.init();
    });
    step('board', function () {
      if (!SOL.Board) return missing('SOL.Board');
      if (!SOL.Board.init()) throw new Error('SOL.Board.init() could not find its mount points or dependencies');
    });
    step('input', function () {
      if (!SOL.Input) return missing('SOL.Input');
      SOL.Input.init();
    });
    step('inspector', function () {
      if (!SOL.Inspector || typeof SOL.Inspector.init !== 'function') return missing('SOL.Inspector');
      SOL.Inspector.init({ root: doc.getElementById('inspector-root') });
    });
    step('ui', function () {
      if (!SOL.UI || typeof SOL.UI.init !== 'function') return missing('SOL.UI');
      SOL.UI.init();
    });
    step('lifecycle', function () {
      if (SOL.Bus) {
        SOL.Bus.on('settings:change', function (e) {
          if (e && e.key) applySetting(e.key);
        });
      }
      doc.addEventListener('visibilitychange', onVisibility);
      root.addEventListener('pagehide', saveNow);
      root.addEventListener('beforeunload', saveNow);
    });
    step('game', function () {
      Game.init();
    });
  }

  if (doc) {
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
})(typeof window !== 'undefined' ? window : globalThis);
