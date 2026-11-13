/*
 * js/core/store.js: SOL.Store with and without the Android shell's native key/value store, the
 * 'fullscreen' setting, and the unchanged public API of Store / Settings / Stats / Save.
 * Run with: node --test solitaire/tests/
 *
 * store.js keeps module-level state (the in-memory fallback, the cached settings and stats) and
 * looks at globalThis.SolitaireNative / globalThis.localStorage, so every scenario loads a fresh
 * copy of the modules after installing its own fakes. Loading again with the same fakes is what
 * "the app was closed and opened again" looks like from the page's side.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const CORE = path.join(__dirname, '..', 'js', 'core');

/**
 * What store.js leaves in the native store for a removed key (see its header): not JSON, so no
 * stored value can be equal to it.
 */
const REMOVED = '<removed>';

// ------------------------------------------------------------------ fakes

/** A Storage look-alike. `fail` makes the named methods throw, as a blocked or full storage does. */
function fakeLocalStorage(initial = {}, fail = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem(k) {
      if (fail.getItem) throw new Error('SecurityError');
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      if (fail.setItem) throw new Error('QuotaExceededError');
      map.set(k, String(v));
    },
    removeItem(k) {
      if (fail.removeItem) throw new Error('SecurityError');
      map.delete(k);
    },
  };
}

/**
 * The storage part of window.SolitaireNative as the shell implements it: storageGet has no
 * string for a missing key (the shell returns a Java null, which a WebView hands to the page as
 * undefined), storageSet answers false (and stores nothing) over the size limit.
 */
function fakeBridge(initial = {}, options = {}) {
  const map = new Map(Object.entries(initial));
  const calls = [];
  return {
    map,
    calls,
    haptic() {},
    storageGet(k) {
      calls.push(['get', k]);
      return map.has(k) ? map.get(k) : undefined;
    },
    storageSet(k, v) {
      calls.push(['set', k, v]);
      if (options.maxLength !== undefined && v.length > options.maxLength) return false;
      map.set(k, v);
      return true;
    },
    storageRemove(k) {
      calls.push(['remove', k]);
      map.delete(k);
      return true;
    },
    storageKeys() {
      return JSON.stringify(Array.from(map.keys()).sort());
    },
  };
}

function setGlobal(name, value) {
  if (value === undefined) delete globalThis[name];
  // defineProperty: newer Node versions ship their own accessor for localStorage.
  if (value !== undefined) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

/** Loads bus.js and store.js afresh against the given fakes. */
function load({ bridge, localStorage } = {}) {
  for (const id of Object.keys(require.cache)) {
    if (id.startsWith(CORE)) delete require.cache[id];
  }
  delete globalThis.SOL;
  setGlobal('SolitaireNative', bridge);
  setGlobal('localStorage', localStorage);
  const Bus = require(path.join(CORE, 'bus.js'));
  const store = require(path.join(CORE, 'store.js'));
  return { Bus, Store: store.Store, Settings: store.Settings, Stats: store.Stats, Save: store.Save };
}

test.afterEach(() => {
  delete globalThis.SOL;
  setGlobal('SolitaireNative', undefined);
  setGlobal('localStorage', undefined);
});

// ------------------------------------------------------------------ outside the app
test('outside the app: values go to localStorage under the sol. prefix', () => {
  const ls = fakeLocalStorage();
  const { Store } = load({ localStorage: ls });
  assert.strictEqual(Store.set('thing', { a: 1, list: [1, 2] }), true);
  assert.strictEqual(ls.map.get('sol.thing'), '{"a":1,"list":[1,2]}');
  assert.deepStrictEqual(Store.get('thing', null), { a: 1, list: [1, 2] });
  assert.strictEqual(Store.get('missing', 'fallback'), 'fallback');
  Store.remove('thing');
  assert.strictEqual(ls.map.has('sol.thing'), false);
  assert.strictEqual(Store.get('thing', 'gone'), 'gone');
});

test('outside the app: a new page load reads what the last one wrote', () => {
  const ls = fakeLocalStorage();
  load({ localStorage: ls }).Store.set('thing', 42);
  assert.strictEqual(load({ localStorage: ls }).Store.get('thing', null), 42);
});

test('outside the app: without localStorage the in-memory copy serves the session', () => {
  const { Store } = load({});
  assert.strictEqual(Store.set('thing', 'kept'), false, 'false: it did not reach persistent storage');
  assert.strictEqual(Store.get('thing', null), 'kept');
  Store.remove('thing');
  assert.strictEqual(Store.get('thing', null), null);
});

test('outside the app: a throwing localStorage never breaks get, set or remove', () => {
  const ls = fakeLocalStorage({}, { getItem: true, setItem: true, removeItem: true });
  const { Store } = load({ localStorage: ls });
  assert.strictEqual(Store.set('thing', 7), false);
  assert.strictEqual(Store.get('thing', null), 7);
  assert.doesNotThrow(() => Store.remove('thing'));
  assert.strictEqual(Store.get('thing', 'fallback'), 'fallback');
});

test('outside the app: unreadable JSON gives the fallback', () => {
  const ls = fakeLocalStorage({ 'sol.thing': '{"cut off' });
  const { Store } = load({ localStorage: ls });
  assert.strictEqual(Store.get('thing', 'fallback'), 'fallback');
});

test('a shell without the storage methods (older app) is treated like no shell', () => {
  const ls = fakeLocalStorage({ 'sol.old': '"from localStorage"' });
  const calls = [];
  const olderShell = { haptic: () => calls.push('haptic'), keepScreenOn: () => calls.push('keep') };
  const { Store } = load({ bridge: olderShell, localStorage: ls });
  assert.strictEqual(Store.get('old', null), 'from localStorage');
  assert.strictEqual(Store.set('new', 1), true);
  assert.strictEqual(ls.map.get('sol.new'), '1');
  Store.remove('old');
  assert.strictEqual(ls.map.has('sol.old'), false);
  assert.deepStrictEqual(calls, []);
});

test('a shell with only some of the storage methods is not used for storage at all', () => {
  const ls = fakeLocalStorage();
  const bridge = fakeBridge();
  delete bridge.storageRemove;
  const { Store } = load({ bridge, localStorage: ls });
  assert.strictEqual(Store.set('thing', 1), true);
  assert.strictEqual(Store.get('thing', null), 1);
  assert.deepStrictEqual(bridge.calls, []);
  assert.strictEqual(ls.map.get('sol.thing'), '1');
});

// ------------------------------------------------------------------ inside the app: reading
test('in the app: get prefers the native value over localStorage', () => {
  const bridge = fakeBridge({ 'sol.save.v1': '"native"' });
  const ls = fakeLocalStorage({ 'sol.save.v1': '"stale copy in localStorage"' });
  const { Store } = load({ bridge, localStorage: ls });
  assert.strictEqual(Store.get('save.v1', null), 'native');
  assert.strictEqual(ls.map.get('sol.save.v1'), '"stale copy in localStorage"', 'reading changes nothing');
  assert.deepStrictEqual(bridge.calls, [['get', 'sol.save.v1']]);
});

test('in the app: get falls back to localStorage and migrates the value on that first read', () => {
  const raw = '{"deck":[3,1,2],"note":"saved by an app version without the native store"}';
  const bridge = fakeBridge();
  const ls = fakeLocalStorage({ 'sol.save.v1': raw });
  const { Store } = load({ bridge, localStorage: ls });

  assert.deepStrictEqual(Store.get('save.v1', null), JSON.parse(raw));
  assert.strictEqual(bridge.map.get('sol.save.v1'), raw, 'copied byte for byte');
  assert.strictEqual(ls.map.get('sol.save.v1'), raw, 'localStorage keeps its copy');

  // From now on the native value is the one that is read.
  ls.map.set('sol.save.v1', '"changed behind the back"');
  assert.deepStrictEqual(Store.get('save.v1', null), JSON.parse(raw));
});

test('in the app: every key is migrated when it is first read, not before', () => {
  const bridge = fakeBridge();
  const ls = fakeLocalStorage({ 'sol.settings.v1': '{"theme":"slate"}', 'sol.stats.v1': '{"d1":{"played":3}}' });
  const { Store, Settings } = load({ bridge, localStorage: ls });
  assert.strictEqual(Settings.get('theme'), 'slate');
  assert.deepStrictEqual(Array.from(bridge.map.keys()), ['sol.settings.v1']);
  assert.deepStrictEqual(Store.get('stats.v1', null), { d1: { played: 3 } });
  assert.deepStrictEqual(Array.from(bridge.map.keys()).sort(), ['sol.settings.v1', 'sol.stats.v1']);
});

test('in the app: a key missing everywhere gives the fallback and stores nothing', () => {
  const bridge = fakeBridge();
  const ls = fakeLocalStorage();
  const { Store } = load({ bridge, localStorage: ls });
  bridge.calls.length = 0;
  assert.strictEqual(Store.get('nothing', 'fallback'), 'fallback');
  assert.deepStrictEqual(bridge.calls, [['get', 'sol.nothing']]);
  assert.strictEqual(bridge.map.size, 0);
});

test('in the app: an unreadable native value falls back to localStorage, which replaces it', () => {
  const bridge = fakeBridge({ 'sol.save.v1': '{"cut off' });
  const ls = fakeLocalStorage({ 'sol.save.v1': '"good copy"' });
  const { Store } = load({ bridge, localStorage: ls });
  assert.strictEqual(Store.get('save.v1', null), 'good copy');
  assert.strictEqual(bridge.map.get('sol.save.v1'), '"good copy"');
});

test('in the app: unreadable everywhere gives the fallback', () => {
  const bridge = fakeBridge({ 'sol.save.v1': '{"cut off' });
  const ls = fakeLocalStorage({ 'sol.save.v1': 'also not JSON' });
  const { Store } = load({ bridge, localStorage: ls });
  assert.strictEqual(Store.get('save.v1', 'fallback'), 'fallback');
});

test('in the app: anything but a string from storageGet counts as "no value"', () => {
  for (const answer of [null, undefined, 0, 42, true, {}, []]) {
    const bridge = fakeBridge();
    bridge.storageGet = () => answer;
    const ls = fakeLocalStorage({ 'sol.thing': '"from localStorage"' });
    const { Store } = load({ bridge, localStorage: ls });
    assert.strictEqual(Store.get('thing', null), 'from localStorage', String(answer));
  }
});

test('in the app: the native store alone is enough (no localStorage at all)', () => {
  const bridge = fakeBridge();
  const first = load({ bridge });
  assert.strictEqual(first.Store.set('thing', { n: 1 }), true, 'true: it reached persistent storage');
  const second = load({ bridge });
  assert.deepStrictEqual(second.Store.get('thing', null), { n: 1 });
});

// ------------------------------------------------------------------ inside the app: writing
test('in the app: set writes the native store and localStorage', () => {
  const bridge = fakeBridge();
  const ls = fakeLocalStorage();
  const { Store } = load({ bridge, localStorage: ls });
  assert.strictEqual(Store.set('save.v1', 'state after move 12'), true);
  assert.strictEqual(bridge.map.get('sol.save.v1'), '"state after move 12"');
  assert.strictEqual(ls.map.get('sol.save.v1'), '"state after move 12"');
});

test('in the app: a write survives localStorage losing it (the swiped-away case)', () => {
  const bridge = fakeBridge();
  const before = load({ bridge, localStorage: fakeLocalStorage() });
  before.Save.write('state after the last move');
  // The WebView never got to commit localStorage: the next start finds it empty.
  const after = load({ bridge, localStorage: fakeLocalStorage() });
  assert.strictEqual(after.Save.load(), 'state after the last move');
});

test('in the app: a write survives a full or blocked localStorage', () => {
  const bridge = fakeBridge();
  const ls = fakeLocalStorage({}, { setItem: true });
  const { Store } = load({ bridge, localStorage: ls });
  assert.strictEqual(Store.set('thing', 5), true, 'the native store took it');
  assert.strictEqual(load({ bridge, localStorage: ls }).Store.get('thing', null), 5);
});

test('in the app: remove hits both, and the value does not come back', () => {
  const bridge = fakeBridge({ 'sol.save.v1': '"a"' });
  const ls = fakeLocalStorage({ 'sol.save.v1': '"a"' });
  const { Store } = load({ bridge, localStorage: ls });
  Store.remove('save.v1');
  assert.strictEqual(bridge.map.get('sol.save.v1'), REMOVED, 'the native store holds the removal marker');
  assert.strictEqual(ls.map.has('sol.save.v1'), false);
  assert.strictEqual(Store.get('save.v1', null), null);
  assert.strictEqual(load({ bridge, localStorage: ls }).Store.get('save.v1', null), null);
});

test('in the app: a removal survives localStorage not having caught up (the swiped-away case)', () => {
  const old = '{"v":1,"id":"the game that was abandoned"}';
  const bridge = fakeBridge({ 'sol.save.v1': JSON.stringify(old) });
  const before = load({ bridge, localStorage: fakeLocalStorage({ 'sol.save.v1': JSON.stringify(old) }) });
  assert.strictEqual(before.Save.load(), old);
  before.Save.clear();

  // The WebView never committed the removeItem: the next start still finds the old value there.
  const stale = fakeLocalStorage({ 'sol.save.v1': JSON.stringify(old) });
  const after = load({ bridge, localStorage: stale });
  assert.strictEqual(after.Save.load(), null, 'the cleared game must not come back');
  assert.strictEqual(after.Store.get('save.v1', 'fallback'), 'fallback');
  assert.strictEqual(bridge.map.get('sol.save.v1'), REMOVED, 'and the stale copy is not migrated over the marker');
  assert.deepStrictEqual(bridge.calls.filter((c) => c[0] === 'set' && c[2] !== REMOVED), []);
});

test('in the app: a write after a removal replaces the marker', () => {
  const bridge = fakeBridge({ 'sol.save.v1': '"old"' });
  const ls = fakeLocalStorage({ 'sol.save.v1': '"old"' });
  const { Store, Save } = load({ bridge, localStorage: ls });
  Save.clear();
  Save.write('new game');
  assert.strictEqual(bridge.map.get('sol.save.v1'), '"new game"');
  assert.strictEqual(Save.load(), 'new game');
  assert.strictEqual(load({ bridge, localStorage: fakeLocalStorage() }).Save.load(), 'new game');
  Store.remove('save.v1');
  Store.remove('save.v1'); // removing twice is harmless
  assert.strictEqual(load({ bridge, localStorage: ls }).Save.load(), null);
});

test('in the app: removing a key that was never stored leaves nothing readable behind', () => {
  const bridge = fakeBridge();
  const ls = fakeLocalStorage();
  const { Store } = load({ bridge, localStorage: ls });
  Store.remove('never');
  assert.strictEqual(Store.get('never', 'fallback'), 'fallback');
  assert.strictEqual(ls.map.size, 0);
});

test('in the app: the removal marker is never handed out as a value', () => {
  const bridge = fakeBridge({ 'sol.thing': REMOVED });
  const { Store, Save, Settings, Stats } = load({ bridge, localStorage: fakeLocalStorage() });
  assert.strictEqual(Store.get('thing', undefined), undefined);
  assert.strictEqual(Store.get('thing', 7), 7);
  bridge.map.set('sol.save.v1', REMOVED);
  bridge.map.set('sol.settings.v1', REMOVED);
  bridge.map.set('sol.stats.v1', REMOVED);
  assert.strictEqual(Save.load(), null);
  assert.strictEqual(Settings.get('theme'), 'emerald');
  assert.strictEqual(Stats.summary(1).played, 0);
});

test('in the app: a shell that does not take the marker still has the key removed', () => {
  for (const refuse of ['false', 'throw']) {
    const bridge = fakeBridge({ 'sol.save.v1': '"a"' });
    const set = bridge.storageSet;
    bridge.storageSet = (k, v) => {
      if (v !== REMOVED) return set(k, v);
      if (refuse === 'throw') throw new Error('Java exception was raised during method invocation');
      return false;
    };
    const ls = fakeLocalStorage({ 'sol.save.v1': '"a"' });
    const { Store } = load({ bridge, localStorage: ls });
    assert.doesNotThrow(() => Store.remove('save.v1'), refuse);
    assert.strictEqual(bridge.map.has('sol.save.v1'), false, refuse);
    assert.strictEqual(ls.map.has('sol.save.v1'), false, refuse);
    assert.strictEqual(Store.get('save.v1', null), null, refuse);
  }
});

test('in the app: a write the shell could neither take nor clear still wins over an older marker', () => {
  // Removed in an earlier session; now the bridge fails for writes (but still answers reads).
  const bridge = fakeBridge({ 'sol.save.v1': REMOVED });
  const boom = () => {
    throw new Error('Java exception was raised during method invocation');
  };
  bridge.storageSet = boom;
  bridge.storageRemove = boom;
  const ls = fakeLocalStorage();
  const { Store } = load({ bridge, localStorage: ls });
  assert.strictEqual(Store.get('save.v1', null), null);
  assert.strictEqual(Store.set('save.v1', 'written after the marker'), true);
  assert.strictEqual(Store.get('save.v1', null), 'written after the marker');
  // The same without localStorage: the in-memory copy serves the session.
  const memoryOnly = load({ bridge }).Store;
  assert.strictEqual(memoryOnly.set('save.v1', 'memory'), false);
  assert.strictEqual(memoryOnly.get('save.v1', null), 'memory');
});

test('in the app: a value the shell refuses does not leave an older native value to be read', () => {
  const bridge = fakeBridge({}, { maxLength: 40 });
  const ls = fakeLocalStorage();
  const { Store } = load({ bridge, localStorage: ls });
  assert.strictEqual(Store.set('save.v1', 'short'), true);
  assert.strictEqual(bridge.map.get('sol.save.v1'), '"short"');

  const long = 'x'.repeat(100);
  assert.strictEqual(Store.set('save.v1', long), true, 'localStorage still took it');
  assert.strictEqual(bridge.map.has('sol.save.v1'), false, 'the older native value is gone');
  assert.strictEqual(ls.map.get('sol.save.v1'), JSON.stringify(long));
  assert.strictEqual(Store.get('save.v1', null), long);
  // After a restart too: the latest value wins, not the last one the shell accepted.
  assert.strictEqual(load({ bridge, localStorage: ls }).Store.get('save.v1', null), long);
});

test('in the app: refused by the shell and no localStorage means "not persisted"', () => {
  const bridge = fakeBridge({}, { maxLength: 10 });
  const { Store } = load({ bridge });
  assert.strictEqual(Store.set('thing', 'x'.repeat(50)), false);
  bridge.calls.length = 0;
  assert.strictEqual(Store.get('thing', null), 'x'.repeat(50), 'still served from memory this session');
  // Only a value found in localStorage is copied to the shell on a read: the in-memory copy
  // was already offered to it (and refused) when it was written.
  assert.deepStrictEqual(bridge.calls, [['get', 'sol.thing']]);
});

test('in the app: a shell whose storageSet answers nothing is taken at its word', () => {
  // Only an explicit false means "refused": a shell that returns nothing must not have its
  // value removed again right after it stored it.
  const bridge = fakeBridge();
  const set = bridge.storageSet;
  bridge.storageSet = (k, v) => {
    set(k, v);
  };
  const { Store } = load({ bridge });
  assert.strictEqual(Store.set('thing', { n: 1 }), true);
  assert.strictEqual(bridge.map.get('sol.thing'), '{"n":1}');
  assert.deepStrictEqual(bridge.calls.filter((c) => c[0] === 'remove'), []);
  assert.deepStrictEqual(load({ bridge }).Store.get('thing', null), { n: 1 });
});

test('in the app: a value JSON cannot express is not handed to the shell', () => {
  const bridge = fakeBridge({ 'sol.thing': '"older"' });
  const ls = fakeLocalStorage();
  const { Store } = load({ bridge, localStorage: ls });
  assert.doesNotThrow(() => Store.set('thing', undefined));
  assert.strictEqual(bridge.map.has('sol.thing'), false);
  assert.strictEqual(Store.get('thing', 'fallback'), 'fallback');
});

// ------------------------------------------------------------------ inside the app: a broken bridge
test('in the app: a bridge whose every method throws changes nothing and throws nothing', () => {
  const boom = () => {
    throw new Error('Java exception was raised during method invocation');
  };
  const bridge = { storageGet: boom, storageSet: boom, storageRemove: boom, storageKeys: boom };
  const ls = fakeLocalStorage({ 'sol.old': '"kept"' });
  const { Store, Settings, Save } = load({ bridge, localStorage: ls });

  assert.strictEqual(Store.get('old', null), 'kept');
  assert.strictEqual(Store.set('thing', [1, 2]), true);
  assert.strictEqual(ls.map.get('sol.thing'), '[1,2]');
  assert.deepStrictEqual(Store.get('thing', null), [1, 2]);
  assert.doesNotThrow(() => Store.remove('thing'));
  assert.strictEqual(ls.map.has('sol.thing'), false);

  assert.strictEqual(Settings.set('theme', 'midnight'), true);
  Save.write('state');
  assert.strictEqual(Save.load(), 'state');
  Save.clear();
  assert.strictEqual(Save.load(), null);
});

test('in the app: a throwing bridge and no localStorage still leaves a working session', () => {
  const boom = () => {
    throw new Error('bridge is gone');
  };
  const bridge = { storageGet: boom, storageSet: boom, storageRemove: boom };
  const { Store } = load({ bridge });
  assert.strictEqual(Store.set('thing', 'memory only'), false);
  assert.strictEqual(Store.get('thing', null), 'memory only');
});

test('in the app: a bridge that throws when it is merely looked at is treated as absent', () => {
  const bridge = new Proxy(
    {},
    {
      get() {
        throw new Error('no such member');
      },
    }
  );
  const ls = fakeLocalStorage();
  const { Store } = load({ bridge, localStorage: ls });
  assert.strictEqual(Store.set('thing', 1), true);
  assert.strictEqual(Store.get('thing', null), 1);
  assert.doesNotThrow(() => Store.remove('thing'));
});

// ------------------------------------------------------------------ Settings: 'fullscreen'
test("settings: 'fullscreen' exists and is on by default", () => {
  const { Settings } = load({ localStorage: fakeLocalStorage() });
  assert.strictEqual(Settings.get('fullscreen'), true);
  assert.strictEqual(Settings.defaults().fullscreen, true);
  assert.strictEqual(Settings.all().fullscreen, true);
});

test("settings: 'fullscreen' takes booleans and nothing else", () => {
  const { Settings } = load({ localStorage: fakeLocalStorage() });
  for (const bad of ['true', 'false', 1, 0, null, undefined, {}, [], 'on']) {
    assert.strictEqual(Settings.set('fullscreen', bad), false, JSON.stringify(bad));
    assert.strictEqual(Settings.get('fullscreen'), true);
  }
  assert.strictEqual(Settings.set('fullscreen', false), true);
  assert.strictEqual(Settings.get('fullscreen'), false);
  assert.strictEqual(Settings.set('fullscreen', true), true);
  assert.strictEqual(Settings.get('fullscreen'), true);
});

test("settings: 'fullscreen' is stored and read back on the next load", () => {
  const ls = fakeLocalStorage();
  load({ localStorage: ls }).Settings.set('fullscreen', false);
  assert.strictEqual(JSON.parse(ls.map.get('sol.settings.v1')).fullscreen, false);
  const { Settings } = load({ localStorage: ls });
  assert.strictEqual(Settings.get('fullscreen'), false);
  // The other settings keep their defaults next to it.
  assert.strictEqual(Settings.get('haptics'), true);
  assert.strictEqual(Settings.get('theme'), 'emerald');
});

test("settings: a stored 'fullscreen' that is not a boolean falls back to the default", () => {
  for (const stored of ['"yes"', '0', 'null', '{}']) {
    const ls = fakeLocalStorage({ 'sol.settings.v1': '{"fullscreen":' + stored + ',"theme":"slate"}' });
    const { Settings } = load({ localStorage: ls });
    assert.strictEqual(Settings.get('fullscreen'), true, stored);
    assert.strictEqual(Settings.get('theme'), 'slate', 'valid neighbours are kept');
  }
});

test("settings: settings saved before 'fullscreen' existed get the default", () => {
  const ls = fakeLocalStorage({ 'sol.settings.v1': '{"theme":"crimson","haptics":false}' });
  const { Settings } = load({ localStorage: ls });
  assert.strictEqual(Settings.get('fullscreen'), true);
  assert.strictEqual(Settings.get('theme'), 'crimson');
  assert.strictEqual(Settings.get('haptics'), false);
});

test("settings: changing 'fullscreen' announces itself on the bus, once per real change", () => {
  const { Settings, Bus } = load({ localStorage: fakeLocalStorage() });
  const events = [];
  Bus.on('settings:change', (e) => events.push(e));
  Settings.set('fullscreen', false);
  Settings.set('fullscreen', false); // no change, no event
  Settings.set('fullscreen', 'nonsense'); // rejected, no event
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].key, 'fullscreen');
  assert.strictEqual(events[0].value, false);
  assert.strictEqual(events[0].previous, true);
  assert.strictEqual(events[0].all.fullscreen, false);
  Settings.reset();
  assert.strictEqual(Settings.get('fullscreen'), true);
  assert.deepStrictEqual(events.map((e) => [e.key, e.value]), [['fullscreen', false], ['fullscreen', true]]);
});

test('settings: in the app they are stored natively and survive localStorage being lost', () => {
  const bridge = fakeBridge();
  load({ bridge, localStorage: fakeLocalStorage() }).Settings.set('fullscreen', false);
  assert.strictEqual(JSON.parse(bridge.map.get('sol.settings.v1')).fullscreen, false);
  const { Settings } = load({ bridge, localStorage: fakeLocalStorage() });
  assert.strictEqual(Settings.get('fullscreen'), false);
});

// ------------------------------------------------------------------ Stats and Save through the native store
test('stats and the saved game round-trip through the native store', () => {
  const bridge = fakeBridge();
  const first = load({ bridge, localStorage: fakeLocalStorage() });
  first.Stats.recordStart('game-1', 1);
  first.Stats.recordWin('game-1', { drawCount: 1, score: 500, elapsedMs: 90000, moves: 120 });
  first.Save.write('{"v":1,"id":"game-2"}');
  // Settings were never changed, so nothing was written for them.
  assert.deepStrictEqual(JSON.parse(bridge.storageKeys()), ['sol.save.v1', 'sol.stats.v1']);

  const second = load({ bridge, localStorage: fakeLocalStorage() });
  assert.strictEqual(second.Stats.summary(1).won, 1);
  assert.strictEqual(second.Stats.summary(1).bestScore, 500);
  assert.strictEqual(second.Save.load(), '{"v":1,"id":"game-2"}');
  second.Save.clear();
  assert.strictEqual(bridge.map.get('sol.save.v1'), REMOVED);
  assert.strictEqual(load({ bridge, localStorage: fakeLocalStorage() }).Save.load(), null);
});

test('a saved game of a few hundred KB goes through unchanged', () => {
  const bridge = fakeBridge();
  const big = JSON.stringify({ history: Array.from({ length: 20000 }, (_, i) => ({ t: 'move', c: i % 52, to: 't' + (i % 7) })) });
  assert.ok(big.length > 500000);
  load({ bridge, localStorage: fakeLocalStorage() }).Save.write(big);
  assert.strictEqual(load({ bridge, localStorage: fakeLocalStorage() }).Save.load(), big);
});

// ------------------------------------------------------------------ the public API did not change
test('the public API of Store, Settings, Stats and Save is what it was', () => {
  const { Store, Settings, Stats, Save } = load({ localStorage: fakeLocalStorage() });
  assert.deepStrictEqual(Object.keys(Store).sort(), ['get', 'remove', 'set']);
  assert.deepStrictEqual(
    Object.keys(Settings).sort(),
    ['SPEEDS', 'THEMES', 'all', 'applyToDocument', 'defaults', 'get', 'reducedMotion', 'reset', 'set', 'speed']
  );
  assert.deepStrictEqual(Object.keys(Stats).sort(), ['get', 'recordStart', 'recordWin', 'reset', 'summary']);
  assert.deepStrictEqual(Object.keys(Save).sort(), ['clear', 'load', 'write']);
  // Every setting that existed before is still there with its default.
  assert.deepStrictEqual(Settings.defaults(), {
    drawCount: 1,
    theme: 'emerald',
    cardBack: 'royal',
    sound: true,
    volume: 0.6,
    animSpeed: 'normal',
    reducedMotion: 'auto',
    tapToMove: true,
    winnableOnly: false,
    leftHanded: false,
    showTimer: true,
    effects: 'high',
    haptics: true,
    fullscreen: true,
  });
  assert.throws(() => Settings.get('noSuchSetting'), /Unknown setting/);
  assert.strictEqual(Settings.set('noSuchSetting', 1), false);
});
