/*
 * SOL.Bus — tiny synchronous pub/sub used to decouple the modules.
 *
 *   const off = SOL.Bus.on('game:change', ({ state, record }) => { ... });
 *   SOL.Bus.emit('game:change', { state, record });
 *   off();
 *
 * A throwing listener never prevents the remaining listeners from running.
 */
(function (root) {
  'use strict';

  const SOL = (root.SOL = root.SOL || {});
  const listeners = new Map();

  function on(event, fn) {
    if (typeof fn !== 'function') throw new TypeError('SOL.Bus.on: listener must be a function');
    let set = listeners.get(event);
    if (!set) listeners.set(event, (set = new Set()));
    set.add(fn);
    return function off() {
      set.delete(fn);
    };
  }

  function once(event, fn) {
    const off = on(event, function (payload) {
      off();
      fn(payload);
    });
    return off;
  }

  function off(event, fn) {
    const set = listeners.get(event);
    if (set) set.delete(fn);
  }

  function emit(event, payload) {
    const set = listeners.get(event);
    if (!set || set.size === 0) return;
    // Copy so listeners can unsubscribe (or subscribe) while we iterate.
    for (const fn of Array.from(set)) {
      try {
        fn(payload);
      } catch (err) {
        if (root.console) root.console.error('[SOL.Bus] listener for "' + event + '" threw', err);
      }
    }
  }

  SOL.Bus = { on: on, once: once, off: off, emit: emit };

  if (typeof module !== 'undefined' && module.exports) module.exports = SOL.Bus;
})(typeof window !== 'undefined' ? window : globalThis);
