/*
 * SOL.Input — everything the player does on the table: pointer (touch, mouse, pen) and keyboard.
 *
 * Gestures (one pointer at a time: the first one that takes hold of a card the player can see, or of the
 * stock, owns the table until it lifts and further fingers are ignored. A finger on bare felt, on an empty
 * slot or on a card that shows its back holds nothing: it starts no gesture and blocks no other finger.)
 *   tap a card            auto-move (SOL.Game.autoMove) when the `tapToMove` setting is on; otherwise a
 *                         double-tap does it. A card that has nowhere to go shakes its head. A tap in the
 *                         same place within DOUBLE_TAP_MS of a tap that moved a card is swallowed if it would
 *                         act on that card again or on the card it uncovered (the second tap of a habitual
 *                         double tap must not play a card the player has not looked at yet).
 *   tap the stock         draw / recycle (also the empty stock slot)
 *   drag a card           picks up the card and everything on top of it once the pointer has moved past a
 *                         small slop (touch 10px, pen 6px, mouse 4px). The card is held by the spot where the
 *                         pointer went down on it. Released over a legal pile it moves (the board picks the
 *                         legal pile with the largest overlap, judged where the pointer is when it lifts);
 *                         anywhere else it returns.
 *   long-press a card     ~450ms without moving, face-up cards only: 'heavy' haptic + SOL.Game.inspect(card)
 *   right-click a card    the same, for mice
 *   tap during the deal   hurries the deal up; tap during auto-complete stops the cascade after the card in
 *                         the air; tap during the celebration skips it to the tidy end state
 *   hover (mouse / pen)   the top face-up card under the pointer leans towards it with a moving highlight
 *                         (SOL.Board.hoverAt) — decoration only, nothing depends on it
 * Keyboard: Space / D draw, U or Ctrl/Cmd+Z undo, H hint, N new game, A auto-complete, I inspect the card under
 * the pointer, Esc cancels a drag / stops auto-complete / skips the celebration (overlays close themselves).
 *
 * Hit-testing goes through the board's layout model (Board.cardAt / pileAt): no DOM reads. A card is hit
 * where it is drawn, also while it glides or flies, and a flying card at its landing place as well; an exact
 * hit always wins, and a finger that misses every card takes the nearest one within TAP_SLACK px.
 * A card is only ever played while the player can see its face. The game state turns a card face-up the
 * moment a move uncovers or draws it; the table turns it a little later. Until its back is out of sight (and
 * for the whole gesture, if the finger went down before that) it cannot be tapped, dragged or inspected.
 * A drag never survives anything unexpected: pointercancel, lost capture, window blur, the page being hidden,
 * a resize / rotation, the game being paused or locked — the cards go home and the state is clean.
 *
 * Public API
 *   Input.init({ table } = {}) -> boolean    wires the listeners (idempotent)
 *   Input.cancel()                           drops whatever gesture is in progress (cards return)
 *   Input.isActive() -> boolean              a pointer has hold of a card or of the stock
 *   Input.isDragging() -> boolean
 *   Input.pointer                            { x, y, type, inside } last known pointer position (client px) —
 *                                            for hover effects; read only
 *   Input.LONG_PRESS_MS, Input.SLOP          tunables
 *
 * Needs SOL.Board and SOL.Game at event time (both are looked up lazily); SOL.Settings, SOL.Haptics,
 * SOL.Celebrate and SOL.UI are optional.
 */
(function (root) {
  'use strict';

  const SOL = (root.SOL = root.SOL || {});
  const doc = root.document;

  const SLOP = { touch: 10, pen: 6, mouse: 4 };
  const TAP_SLACK = 7; // px of extra reach around a card for fingers
  const DOUBLE_TAP_MS = 380;
  const DOUBLE_TAP_PX = 28; // two taps closer together than this (and within DOUBLE_TAP_MS) are one double tap

  let inited = false;
  let tableEl = null;
  /**
   * The gesture in progress, or null:
   *   { id, type, t0, x0, y0, x, y, card, pile, phase: 'pending' | 'drag', timer }   (t0, x0, y0: pointer down)
   * A gesture that can no longer do anything (a drag that could not start, a long-press that fired) ends at
   * once — `active` goes back to null while the finger is still down, so the table is free for the next one.
   */
  let active = null;
  let lastTap = { card: -1, time: 0 };
  /**
   * The last tap that moved a card: when and where, the card, the card it uncovered, and the game state and
   * its move count right after (see isEcho).
   */
  let lastMove = { time: -1e9, x: 0, y: 0, card: -1, bared: -1, state: null, moves: -1 };
  const pointer = { x: -1, y: -1, type: '', inside: false };

  function B() {
    return SOL.Board;
  }
  function G() {
    return SOL.Game;
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
  function haptic(kind) {
    try {
      if (SOL.Haptics) SOL.Haptics.play(kind);
    } catch (err) {
      /* ignore */
    }
  }
  function locked() {
    const g = G();
    if (!g) return true;
    if (typeof g.inputLocked === 'function') return g.inputLocked();
    return !!(g.isBusy && g.isBusy());
  }
  function celebrating() {
    return !!(SOL.Celebrate && SOL.Celebrate.isPlaying && SOL.Celebrate.isPlaying());
  }

  // ------------------------------------------------------------------ mouse cursor
  // The cards do not receive pointer events themselves (hit-testing is model based), so the table shows the
  // cursor for whatever is under the mouse: a hand over a card that can be picked up, a pointer over the stock.
  let cursor = '';
  function setCursor(value) {
    if (value === cursor || !tableEl) return;
    cursor = value;
    tableEl.style.cursor = value;
  }

  function hoverCursor(x, y) {
    if (locked()) {
      setCursor('');
      return;
    }
    const h = hit(x, y, 'mouse');
    if (h.pile === 'stock') setCursor('pointer');
    else if (h.card >= 0 && canPickup(h.card)) setCursor('grab');
    else setCursor('');
  }

  /** A fine pointer moved over the table with no button down: cursor feedback and the idle tilt. */
  function hover(x, y, type) {
    if (type === 'mouse') hoverCursor(x, y);
    const board = B();
    if (!board || typeof board.hoverAt !== 'function') return;
    if (locked()) board.hoverEnd();
    else board.hoverAt(x, y);
  }

  // ------------------------------------------------------------------ gesture bookkeeping
  function clearTimer() {
    if (active && active.timer) {
      root.clearTimeout(active.timer);
      active.timer = 0;
    }
  }

  function releaseCapture(id) {
    try {
      if (tableEl && tableEl.hasPointerCapture && tableEl.hasPointerCapture(id)) tableEl.releasePointerCapture(id);
    } catch (err) {
      /* the pointer is already gone */
    }
  }

  /**
   * This pointer holds nothing any more (its drag could not start, its long-press fired): the gesture is over
   * although the finger may still be down, and the table is free for the next pointer.
   */
  function letGo(a) {
    if (active !== a) return;
    clearTimer();
    active = null;
    releaseCapture(a.id);
    if (a.type === 'mouse') setCursor('');
  }

  /** Ends the current gesture without any game action. Cards in the hand go home. */
  function cancel() {
    const a = active;
    if (B() && typeof B().hoverEnd === 'function') B().hoverEnd();
    if (!a) {
      // the board may still hold a run for us (e.g. it was told to drag by someone else)
      if (B() && B().isDragging()) B().dragCancel();
      return;
    }
    clearTimer();
    active = null;
    releaseCapture(a.id);
    setCursor('');
    if (B()) {
      if (a.phase === 'drag' || B().isDragging()) B().dragCancel();
      B().unpress();
    }
  }

  // ------------------------------------------------------------------ hit testing
  /** What is under the point: { card, pile } (card -1 / pile null when nothing). */
  function hit(x, y, type) {
    const board = B();
    const g = G();
    const out = { card: -1, pile: null };
    if (!board || !g || !g.state) return out;
    // (an exact hit wins; a finger that misses every card means the nearest one within its slack)
    let card = board.cardAt(x, y, type === 'mouse' ? 0 : TAP_SLACK);
    out.pile = board.pileAt(x, y, type === 'mouse' ? 0 : TAP_SLACK);
    if (card >= 0) {
      const sp = board.sprite(card);
      out.pile = sp ? sp.pile : out.pile;
      // the waste fan is one pile: touching any of its cards means its top card
      if (out.pile === 'waste') {
        const waste = g.state.piles.waste;
        if (waste.length) card = waste[waste.length - 1];
      }
    }
    out.card = card;
    return out;
  }

  function canPickup(card) {
    const g = G();
    try {
      return isFaceUp(card) && SOL.Engine.canPickup(g.state, card);
    } catch (err) {
      return false;
    }
  }

  /**
   * The player can see this card's face: the game says face-up AND the table has turned it that far. The
   * state changes the moment a move uncovers a card or a draw turns it; the card on the table follows a
   * little later (after the reveal delay, or in the middle of its flight from the stock). While its back is
   * still showing it must not be played.
   */
  function isFaceUp(card) {
    const g = G();
    if (!(card >= 0) || !g || !g.state || !g.state.faceUp[card]) return false;
    const board = B();
    const sp = board && typeof board.sprite === 'function' ? board.sprite(card) : null;
    return !sp || sp.flip < 90;
  }

  /** The card directly under `card` in its pile — the one a move of `card` uncovers — or -1. */
  function cardUnder(card) {
    try {
      const st = G().state;
      const at = SOL.Engine.locate(st, card);
      return at && at.index > 0 ? st.piles[at.pile][at.index - 1] : -1;
    } catch (err) {
      return -1;
    }
  }

  /**
   * The tail of a double tap: this tap comes right after, and in the same place as, a tap that moved a card,
   * and it would act on that card again (still drawn there as it leaves) or on the card that move uncovered.
   * Many players double-tap by habit; the second tap must not play a card they have not looked at yet.
   */
  function isEcho(a) {
    const m = lastMove;
    const st = G().state;
    return (
      a.t0 - m.time < DOUBLE_TAP_MS && // (counted to the moment the finger came down again)
      Math.hypot(a.x0 - m.x, a.y0 - m.y) < DOUBLE_TAP_PX &&
      (a.card === m.card || a.card === m.bared) &&
      st === m.state &&
      st.moves === m.moves // nothing has happened since that tap (no undo, no draw, no other move)
    );
  }

  // ------------------------------------------------------------------ pointer events
  function onPointerDown(e) {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.type = e.pointerType || 'mouse';
    pointer.inside = true;
    if (e.pointerType === 'mouse') {
      if (e.button !== 0) return; // right button: see onContextMenu
      e.preventDefault(); // no text selection / focus change / native drag
    }
    if (active) return; // one pointer at a time: the one that has hold of a card or of the stock
    const g = G();
    const board = B();
    if (!g || !board) return;

    if (celebrating()) {
      SOL.Celebrate.skip();
      return;
    }
    if (locked()) {
      // auto-complete: a tap stops the cascade; the deal: a tap plays the rest of it faster
      if (typeof g.isAutoCompleting === 'function' && g.isAutoCompleting()) g.cancelAuto();
      else if (typeof g.hurry === 'function') g.hurry();
      return;
    }

    const type = e.pointerType || 'mouse';
    const h = hit(e.clientX, e.clientY, type);
    // Only a pointer that takes hold of something owns the table: a card the player can see, or the stock.
    // A finger on bare felt, on an empty slot or on a card that shows its back (face-down, or uncovered a
    // moment ago and not turned yet) holds nothing: no tap, no drag and no long-press come of it — also not
    // when the card turns over while the finger rests on it — and it does not block the next finger either.
    const seen = isFaceUp(h.card);
    if (!seen && h.pile !== 'stock') return;
    active = {
      id: e.pointerId,
      type: type,
      t0: now(),
      x0: e.clientX,
      y0: e.clientY,
      x: e.clientX,
      y: e.clientY,
      card: h.card,
      pile: h.pile,
      phase: 'pending',
      timer: 0,
    };
    try {
      tableEl.setPointerCapture(e.pointerId);
    } catch (err) {
      /* synthetic or already-released pointer: events still reach the table while the pointer is over it */
    }
    if (seen) {
      if (canPickup(h.card)) board.press(h.card);
      const a = active;
      // Gesture timing, not animation: must not scale with the animation speed.
      a.timer = root.setTimeout(function () {
        if (active !== a || a.phase !== 'pending') return;
        a.timer = 0;
        longPress(a);
      }, Input.LONG_PRESS_MS);
    }
  }

  function longPress(a) {
    const g = G();
    if (B()) B().unpress();
    letGo(a);
    if (!g || locked() || !isFaceUp(a.card)) return;
    haptic('heavy');
    g.inspect(a.card);
  }

  function onPointerMove(e) {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.type = e.pointerType || 'mouse';
    pointer.inside = true;
    const a = active;
    if (!a) {
      // (no button down: a press that took hold of nothing is not a hover)
      if ((e.pointerType === 'mouse' || e.pointerType === 'pen') && !e.buttons) hover(e.clientX, e.clientY, e.pointerType);
      return;
    }
    if (e.pointerId !== a.id) return;
    a.x = e.clientX;
    a.y = e.clientY;
    const board = B();
    if (!board) return;

    if (a.phase === 'pending') {
      const slop = SLOP[a.type] || SLOP.mouse;
      if (Math.hypot(a.x - a.x0, a.y - a.y0) < slop) return;
      // it is a drag (or nothing): no tap, no long-press any more
      clearTimer();
      // The card is held by the spot where the finger went down on it (x0, y0) — not by where the pointer
      // is now that the slop is behind it: the board lets it catch up with the distance moved since.
      if (a.card >= 0 && !locked() && canPickup(a.card) && board.dragStart(a.card, a.x0, a.y0) > 0) {
        a.phase = 'drag';
        board.dragMove(a.x, a.y);
        if (a.type === 'mouse') setCursor('grabbing');
      } else {
        board.unpress();
        letGo(a);
      }
      return;
    }
    if (a.phase === 'drag') {
      if (!board.isDragging()) {
        // the board dropped the run on its own (resize, a state change): nothing left to steer
        letGo(a);
        return;
      }
      // coalesced events are not needed: the board samples the latest position once per frame
      board.dragMove(a.x, a.y);
    }
  }

  function onPointerUp(e) {
    const a = active;
    if (!a || e.pointerId !== a.id) return;
    clearTimer();
    active = null;
    releaseCapture(a.id);
    if (a.type === 'mouse') setCursor('');
    const board = B();
    const g = G();
    if (!board || !g) return;

    if (a.phase === 'drag') {
      // the drop is judged where the finger is as it lifts — it may have moved since the last move event
      if (board.isDragging()) board.dragMove(e.clientX, e.clientY);
      const r = board.isDragging() ? board.dragEnd() : null;
      if (!r) {
        if (board.isDragging()) board.dragCancel();
        return;
      }
      let moved = false;
      if (r.target && !locked()) moved = !!g.move(r.card, r.target, { source: 'drag' });
      if (!moved) board.dragCancel({ invalid: !!r.over && r.over !== r.from });
      return;
    }

    board.unpress();
    if (a.phase !== 'pending' || locked()) return;
    tap(a);
  }

  function tap(a) {
    const g = G();
    const board = B();
    const t = now();
    if (a.pile === 'stock') {
      lastTap.card = -1;
      g.draw();
      return;
    }
    if (a.card < 0) return;
    if (!isFaceUp(a.card)) return; // a face-down card: nothing to do
    const twice = lastTap.card === a.card && t - lastTap.time < DOUBLE_TAP_MS;
    lastTap.card = a.card;
    lastTap.time = t;
    if (!setting('tapToMove', true) && !twice) return;
    lastTap.card = -1;
    if (a.pile && a.pile.charAt(0) === 'f') return; // taps on foundations do nothing (drags still work)
    if (isEcho(a)) return; // the second tap of a double tap: swallowed
    const bared = cardUnder(a.card);
    if (g.autoMove(a.card)) {
      lastMove = { time: t, x: a.x0, y: a.y0, card: a.card, bared: bared, state: g.state, moves: g.state.moves };
    } else {
      board.shake(a.card);
      haptic('error');
      try {
        if (SOL.Audio) SOL.Audio.play('invalid', { volume: 0.5 });
      } catch (err) {
        /* ignore */
      }
    }
  }

  function onPointerCancel(e) {
    if (active && e.pointerId === active.id) cancel();
  }

  function onLostCapture(e) {
    // Capture goes away on pointerup too (handled there, `active` is already null by then).
    if (active && e.pointerId === active.id && active.phase === 'drag') cancel();
  }

  function onPointerLeave(e) {
    if (e.pointerType === 'mouse' || e.pointerType === 'pen') {
      pointer.inside = false;
      if (!active) setCursor('');
      if (B() && typeof B().hoverEnd === 'function') B().hoverEnd();
    }
  }

  function onContextMenu(e) {
    e.preventDefault(); // never a browser menu on the table (long-press opens the inspector instead)
    // Touch long-presses are handled by the timer; a real right-click (or a keyboard menu key) inspects.
    const type = e.pointerType || pointer.type || 'mouse';
    if (type !== 'mouse') return;
    if (active) cancel();
    const g = G();
    if (!g || locked()) return;
    const h = hit(e.clientX, e.clientY, 'mouse');
    if (h.card >= 0 && isFaceUp(h.card)) g.inspect(h.card);
  }

  function prevent(e) {
    // (not cancelable: another finger has started a browser gesture elsewhere on the page — asking anyway
    // only earns a console error per move)
    if (e.cancelable) e.preventDefault();
  }

  /**
   * A listener that does nothing, on purpose. Browsers "adjust" a touch to the nearest element that reacts to
   * clicks, and the table reacts to pointer events only: without a click listener of its own, a touch on its
   * lowest few pixels — pointerdown included — is handed to the toolbar button just below it. With one, a
   * touch whose centre is on the table stays on the table.
   */
  function claimClicks() {}

  // ------------------------------------------------------------------ keyboard
  function isTyping(target) {
    if (!target || !target.closest) return false;
    return !!target.closest('input, textarea, select, [contenteditable="true"]');
  }

  function isButtonLike(target) {
    if (!target || !target.closest) return false;
    return !!target.closest('button, a[href], [role="button"], [role="slider"], [role="tab"], summary');
  }

  function requestNewGame() {
    const g = G();
    if (!g) return;
    let status = null;
    try {
      status = g.getStatus();
    } catch (err) {
      status = null;
    }
    const ui = SOL.UI;
    // The UI owns the "abandon this game?" question; prefer its complete flow when it has one.
    if (ui && typeof ui.newGame === 'function') {
      try {
        ui.newGame();
        return;
      } catch (err) {
        /* fall through to the plain paths */
      }
    }
    if (status && status.started && !status.won && ui && typeof ui.confirm === 'function') {
      Promise.resolve(
        ui.confirm({
          title: 'Start a new game?',
          message: 'The game in progress will be abandoned and counts as a loss in your statistics.',
          confirmLabel: 'New game',
          cancelLabel: 'Keep playing',
        })
      ).then(
        function (ok) {
          if (ok) g.newGame();
        },
        function () {
          /* dialog failed: do nothing */
        }
      );
      return;
    }
    g.newGame();
  }

  function onKeyDown(e) {
    if (e.defaultPrevented || e.isComposing) return;
    const g = G();
    if (!g) return;
    const key = e.key;

    if (key === 'Escape') {
      if (active || (B() && B().isDragging())) {
        cancel();
        e.preventDefault();
      } else if (celebrating()) {
        SOL.Celebrate.skip();
        e.preventDefault();
      } else if (typeof g.isAutoCompleting === 'function' && g.isAutoCompleting()) {
        g.cancelAuto();
        e.preventDefault();
      }
      return; // overlays handle their own Esc
    }
    if (isTyping(e.target)) return;
    if (typeof g.isPaused === 'function' && g.isPaused()) return; // a modal / the inspector owns the keyboard

    const mod = e.ctrlKey || e.metaKey;
    if (mod) {
      if (!e.altKey && !e.shiftKey && (key === 'z' || key === 'Z')) {
        e.preventDefault();
        cancel();
        g.undo();
      }
      return;
    }
    if (e.altKey) return;

    let handled = true;
    switch (key) {
      case ' ':
      case 'Spacebar':
        if (isButtonLike(e.target)) return; // Space activates the focused button
        cancel();
        g.draw();
        break;
      case 'd':
      case 'D':
        cancel();
        g.draw();
        break;
      case 'u':
      case 'U':
        cancel();
        g.undo();
        break;
      case 'h':
      case 'H':
        g.hint();
        break;
      case 'n':
      case 'N':
        if (e.repeat) break;
        cancel();
        requestNewGame();
        break;
      case 'a':
      case 'A':
        if (e.repeat) break;
        cancel();
        g.autoComplete();
        break;
      case 'i':
      case 'I': {
        if (e.repeat || !pointer.inside || !B()) break;
        const h = hit(pointer.x, pointer.y, 'mouse');
        if (h.card >= 0 && isFaceUp(h.card) && !locked()) {
          cancel();
          g.inspect(h.card);
        }
        break;
      }
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  }

  // ------------------------------------------------------------------ init
  function init(opts) {
    if (inited) return true;
    if (!doc) return false;
    tableEl = (opts && opts.table) || doc.getElementById('table');
    if (!tableEl) return false;
    inited = true;

    tableEl.addEventListener('pointerdown', onPointerDown);
    tableEl.addEventListener('pointermove', onPointerMove);
    tableEl.addEventListener('pointerup', onPointerUp);
    tableEl.addEventListener('pointercancel', onPointerCancel);
    tableEl.addEventListener('lostpointercapture', onLostCapture);
    tableEl.addEventListener('pointerleave', onPointerLeave);
    tableEl.addEventListener('contextmenu', onContextMenu);
    tableEl.addEventListener('click', claimClicks);
    // no native drag images, selections, double-tap zoom or iOS gestures on the table
    tableEl.addEventListener('dragstart', prevent);
    tableEl.addEventListener('selectstart', prevent);
    tableEl.addEventListener('dblclick', prevent);
    tableEl.addEventListener('gesturestart', prevent);
    // Belt and braces for browsers that ignore touch-action on some gestures: a non-passive touchmove
    // listener keeps the page from scrolling / pulling to refresh while a finger is on the table.
    tableEl.addEventListener('touchmove', prevent, { passive: false });

    root.addEventListener('keydown', onKeyDown);
    root.addEventListener('blur', cancel);
    root.addEventListener('resize', cancel);
    root.addEventListener('orientationchange', cancel);
    doc.addEventListener('visibilitychange', function () {
      if (doc.visibilityState === 'hidden') cancel();
    });
    return true;
  }

  const Input = {
    init: init,
    cancel: cancel,
    isActive: function () {
      return !!active;
    },
    isDragging: function () {
      return !!(active && active.phase === 'drag');
    },
    pointer: pointer,
    LONG_PRESS_MS: 450,
    SLOP: SLOP,
  };

  SOL.Input = Input;
})(typeof window !== 'undefined' ? window : globalThis);
