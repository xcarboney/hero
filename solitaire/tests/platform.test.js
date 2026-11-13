/*
 * js/core/platform.js: the page's side of the contract with the Android shell.
 * Run with: node --test solitaire/tests/
 *
 * Covered here: the 'fullscreen' setting reaching SolitaireNative.setFullscreen (on load and on
 * change, only inside the app), the gesture exclusion strips along #table, an older shell that
 * lacks the newer bridge methods, a bridge that throws, and the API that existed before.
 *
 * platform.js reads globalThis.SolitaireNative when it loads and keeps module-level state, so
 * every scenario installs its fakes and then loads fresh copies of bus.js, store.js and
 * platform.js. Where the page's DOM matters, a small fake document and window are installed on
 * globalThis (in Node, globalThis is the `root` the modules attach to).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const CORE = path.join(__dirname, '..', 'js', 'core');

/** Longer than the debounce in platform.js (80 ms). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 160));

// ------------------------------------------------------------------ fakes

/** A shell with every bridge method; records what the page calls. */
function fakeBridge(stored = {}) {
  const map = new Map(Object.entries(stored));
  const calls = [];
  return {
    calls,
    map,
    /** Arguments of every call to `name`, in order. */
    args(name) {
      return calls.filter((c) => c[0] === name).map((c) => c[1]);
    },
    haptic(kind) {
      calls.push(['haptic', kind]);
    },
    keepScreenOn(on) {
      calls.push(['keepScreenOn', on]);
    },
    setFullscreen(on) {
      calls.push(['setFullscreen', on]);
    },
    setGestureExclusion(json) {
      calls.push(['setGestureExclusion', json]);
    },
    exit() {
      calls.push(['exit']);
    },
    safeAreaInsets() {
      return '';
    },
    storageGet(k) {
      return map.has(k) ? map.get(k) : undefined; // a Java null arrives as undefined
    },
    storageSet(k, v) {
      map.set(k, v);
      return true;
    },
    storageRemove(k) {
      map.delete(k);
      return true;
    },
    storageKeys() {
      return JSON.stringify(Array.from(map.keys()).sort());
    },
  };
}

/** The first version of the shell: haptics, keep-screen-on, exit, and nothing else. */
function olderShell() {
  const calls = [];
  return {
    calls,
    haptic(kind) {
      calls.push(['haptic', kind]);
    },
    keepScreenOn(on) {
      calls.push(['keepScreenOn', on]);
    },
    exit() {
      calls.push(['exit']);
    },
  };
}

/**
 * Just enough of window + document for platform.js and store.js: <html> attributes and style,
 * #table with a bounding rect, event listeners, ResizeObserver.
 */
function fakeDom({ table = { left: 0, top: 96, right: 390, bottom: 708 }, readyState = 'complete' } = {}) {
  const windowListeners = {};
  const documentListeners = {};
  const observers = [];
  const dom = {
    windowListeners,
    documentListeners,
    observers,
    /** The rect getBoundingClientRect answers with; null means there is no #table. */
    table,
    fire(type) {
      for (const fn of windowListeners[type] || []) fn({ type });
    },
    fireDocument(type) {
      for (const fn of documentListeners[type] || []) fn({ type });
    },
  };
  const tableElement = {
    getBoundingClientRect() {
      const r = dom.table;
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.right - r.left, height: r.bottom - r.top };
    },
  };
  dom.document = {
    readyState,
    documentElement: {
      attributes: {},
      setAttribute(name, value) {
        this.attributes[name] = String(value);
      },
      style: {
        properties: {},
        setProperty(name, value) {
          this.properties[name] = value;
        },
      },
    },
    getElementById(id) {
      return id === 'table' && dom.table ? tableElement : null;
    },
    addEventListener(type, fn) {
      (documentListeners[type] = documentListeners[type] || []).push(fn);
    },
  };
  dom.addEventListener = (type, fn) => {
    (windowListeners[type] = windowListeners[type] || []).push(fn);
  };
  dom.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.observed = [];
      observers.push(this);
    }
    observe(element) {
      this.observed.push(element);
    }
  };
  return dom;
}

const GLOBALS = ['SolitaireNative', 'localStorage', 'document', 'addEventListener', 'ResizeObserver'];

function setGlobal(name, value) {
  if (value === undefined) delete globalThis[name];
  if (value !== undefined) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

/**
 * Loads the modules afresh. `modules` picks which ones, in index.html's order; the default is
 * the page's: bus.js, store.js, platform.js.
 */
function load({ bridge, dom, modules = ['bus', 'store', 'platform'] } = {}) {
  for (const id of Object.keys(require.cache)) {
    if (id.startsWith(CORE)) delete require.cache[id];
  }
  delete globalThis.SOL;
  setGlobal('SolitaireNative', bridge);
  setGlobal('localStorage', undefined);
  setGlobal('document', dom ? dom.document : undefined);
  setGlobal('addEventListener', dom ? dom.addEventListener : undefined);
  setGlobal('ResizeObserver', dom ? dom.ResizeObserver : undefined);
  for (const name of modules) require(path.join(CORE, name + '.js'));
  return globalThis.SOL;
}

/** Collects console.error output while `fn` runs: a contained failure must not be logged either. */
function withConsoleErrors(fn) {
  const original = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  try {
    fn();
  } finally {
    console.error = original;
  }
  return errors;
}

test.afterEach(async () => {
  await settle(); // let a pending debounce timer of the scenario run out before the next one
  delete globalThis.SOL;
  for (const name of GLOBALS) setGlobal(name, undefined);
});

function strips(json) {
  return JSON.parse(json);
}

// ------------------------------------------------------------------ outside the app
test('outside the app: nothing is called, registered or thrown', async () => {
  const dom = fakeDom();
  const SOL = load({ dom });
  assert.strictEqual(SOL.Platform.isNativeApp, false);
  assert.strictEqual(dom.document.documentElement.attributes['data-platform'], 'web');

  assert.strictEqual(SOL.App.setFullscreen(true), false);
  assert.strictEqual(SOL.App.setGestureExclusion([{ x: 0, y: 0, w: 40, h: 200 }]), false);
  assert.strictEqual(SOL.Settings.set('fullscreen', false), true);
  const remove = SOL.App.addBackHandler(() => true);
  remove();
  SOL.App.setInsets({ top: 24, right: 0, bottom: 16, left: 0 });
  dom.fire('resize');
  await settle();

  assert.deepStrictEqual(dom.windowListeners, {}, 'no window listeners');
  assert.deepStrictEqual(dom.documentListeners, {}, 'no document listeners');
  assert.deepStrictEqual(dom.observers, [], 'no ResizeObserver');
});

test('outside the app: the new App methods exist and are harmless without a document too', () => {
  const SOL = load({});
  assert.strictEqual(typeof SOL.App.setFullscreen, 'function');
  assert.strictEqual(typeof SOL.App.setGestureExclusion, 'function');
  assert.strictEqual(SOL.App.setFullscreen(false), false);
  assert.strictEqual(SOL.App.setGestureExclusion([]), false);
});

// ------------------------------------------------------------------ full screen
test('in the app: the fullscreen setting is sent on load (default: on)', () => {
  const bridge = fakeBridge();
  const SOL = load({ bridge });
  assert.strictEqual(SOL.Platform.isNativeApp, true);
  assert.deepStrictEqual(bridge.args('setFullscreen'), [true]);
});

test('in the app: a stored "off" is sent on load', () => {
  const bridge = fakeBridge({ 'sol.settings.v1': JSON.stringify({ fullscreen: false }) });
  load({ bridge });
  assert.deepStrictEqual(bridge.args('setFullscreen'), [false]);
});

test('in the app: every change of the setting is sent, as a real boolean', () => {
  const bridge = fakeBridge();
  const SOL = load({ bridge });
  SOL.Settings.set('fullscreen', false);
  SOL.Settings.set('fullscreen', true);
  SOL.Settings.set('fullscreen', false);
  assert.deepStrictEqual(bridge.args('setFullscreen'), [true, false, true, false]);
  for (const value of bridge.args('setFullscreen')) assert.strictEqual(typeof value, 'boolean');
});

test('in the app: only a change of that one setting is sent', () => {
  const bridge = fakeBridge();
  const SOL = load({ bridge });
  SOL.Settings.set('fullscreen', true); // already on: no change, no event
  SOL.Settings.set('fullscreen', 'yes'); // rejected
  SOL.Settings.set('haptics', false);
  SOL.Settings.set('theme', 'midnight');
  SOL.Bus.emit('settings:change', { key: 'reducedMotion', value: 'auto', previous: 'auto', all: {} });
  SOL.Bus.emit('settings:change', undefined);
  assert.deepStrictEqual(bridge.args('setFullscreen'), [true]);
});

test('in the app: resetting the settings turns full screen back on', () => {
  const bridge = fakeBridge({ 'sol.settings.v1': JSON.stringify({ fullscreen: false }) });
  const SOL = load({ bridge });
  SOL.Settings.reset();
  assert.deepStrictEqual(bridge.args('setFullscreen'), [false, true]);
});

test('in the app: SOL.App.setFullscreen passes a boolean and reports that the shell was told', () => {
  const bridge = fakeBridge();
  const SOL = load({ bridge });
  bridge.calls.length = 0;
  assert.strictEqual(SOL.App.setFullscreen(1), true);
  assert.strictEqual(SOL.App.setFullscreen(''), true);
  assert.deepStrictEqual(bridge.args('setFullscreen'), [true, false]);
});

test('in the app: without store.js nothing is sent on load and nothing throws', () => {
  const bridge = fakeBridge();
  const SOL = load({ bridge, modules: ['platform'] });
  assert.deepStrictEqual(bridge.args('setFullscreen'), []);
  assert.strictEqual(SOL.App.setFullscreen(true), true);
});

// ------------------------------------------------------------------ an older shell, a failing shell
test('an older shell without the new methods: nothing throws, on load or later', async () => {
  const bridge = olderShell();
  const dom = fakeDom();
  let SOL;
  const errors = withConsoleErrors(() => {
    SOL = load({ bridge, dom });
    assert.strictEqual(SOL.Platform.isNativeApp, true);
    assert.strictEqual(SOL.Settings.set('fullscreen', false), true);
    assert.strictEqual(SOL.Settings.set('fullscreen', true), true);
    assert.strictEqual(SOL.App.setFullscreen(true), false);
    assert.strictEqual(SOL.App.setGestureExclusion([{ x: 0, y: 0, w: 40, h: 100 }]), false);
    const remove = SOL.App.addBackHandler(() => true);
    remove();
    SOL.App.setInsets({ top: 24, right: 0, bottom: 16, left: 0 });
    SOL.App.keepScreenOn(true);
    assert.strictEqual(SOL.Haptics.play('win'), true);
  });
  dom.fire('resize');
  await settle();
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(bridge.calls, [['keepScreenOn', true], ['haptic', 'win']]);
  assert.deepStrictEqual(dom.windowListeners, {}, 'no exclusion watching without the bridge method');
});

test('a shell with setFullscreen but no setGestureExclusion (and the reverse) gets what it has', async () => {
  const onlyFullscreen = fakeBridge();
  delete onlyFullscreen.setGestureExclusion;
  const dom1 = fakeDom();
  load({ bridge: onlyFullscreen, dom: dom1 });
  await settle();
  assert.deepStrictEqual(onlyFullscreen.args('setFullscreen'), [true]);
  assert.deepStrictEqual(dom1.windowListeners, {});

  const onlyExclusion = fakeBridge();
  delete onlyExclusion.setFullscreen;
  const dom2 = fakeDom();
  const SOL = load({ bridge: onlyExclusion, dom: dom2 });
  await settle();
  assert.strictEqual(onlyExclusion.args('setGestureExclusion').length, 1);
  assert.doesNotThrow(() => SOL.Settings.set('fullscreen', false));
});

test('a bridge whose methods throw: nothing escapes and nothing is logged', async () => {
  const boom = () => {
    throw new Error('Java exception was raised during method invocation');
  };
  const bridge = fakeBridge();
  bridge.setFullscreen = boom;
  bridge.setGestureExclusion = boom;
  bridge.keepScreenOn = boom;
  bridge.haptic = boom;
  const dom = fakeDom();
  let SOL;
  const errors = withConsoleErrors(() => {
    SOL = load({ bridge, dom });
    assert.strictEqual(SOL.Settings.set('fullscreen', false), true);
    assert.strictEqual(SOL.App.setFullscreen(true), false);
    assert.strictEqual(SOL.App.setGestureExclusion([{ x: 0, y: 0, w: 40, h: 100 }]), false);
    SOL.App.keepScreenOn(true);
    assert.strictEqual(SOL.Haptics.play('win'), false);
  });
  dom.fire('resize');
  const later = [];
  const original = console.error;
  console.error = (...args) => later.push(args);
  try {
    await settle();
  } finally {
    console.error = original;
  }
  assert.deepStrictEqual(errors.concat(later), []);
});

// ------------------------------------------------------------------ gesture exclusion
test('exclusion: two strips along the left and right edges of #table, full height in full screen', async () => {
  const bridge = fakeBridge();
  const dom = fakeDom({ table: { left: 0, top: 96, right: 390, bottom: 708 } });
  load({ bridge, dom });
  assert.deepStrictEqual(bridge.args('setGestureExclusion'), [], 'debounced, not sent synchronously');
  await settle();
  assert.strictEqual(bridge.args('setGestureExclusion').length, 1);
  assert.deepStrictEqual(strips(bridge.args('setGestureExclusion')[0]), [
    { x: 0, y: 96, w: 40, h: 612 },
    { x: 350, y: 96, w: 40, h: 612 },
  ]);
});

test('exclusion: with full screen off the strips cover the lowest 200 px of #table', async () => {
  const bridge = fakeBridge({ 'sol.settings.v1': JSON.stringify({ fullscreen: false }) });
  const dom = fakeDom({ table: { left: 0, top: 120, right: 412, bottom: 780 } });
  load({ bridge, dom });
  await settle();
  assert.deepStrictEqual(strips(bridge.args('setGestureExclusion')[0]), [
    { x: 0, y: 580, w: 40, h: 200 },
    { x: 372, y: 580, w: 40, h: 200 },
  ]);
});

test('exclusion: a table shorter than the limit is covered whole in either mode', async () => {
  const bridge = fakeBridge({ 'sol.settings.v1': JSON.stringify({ fullscreen: false }) });
  const dom = fakeDom({ table: { left: 0, top: 60, right: 800, bottom: 240 } });
  load({ bridge, dom });
  await settle();
  assert.deepStrictEqual(strips(bridge.args('setGestureExclusion')[0]), [
    { x: 0, y: 60, w: 40, h: 180 },
    { x: 760, y: 60, w: 40, h: 180 },
  ]);
});

test('exclusion: switching the fullscreen setting re-measures for the other mode', async () => {
  const bridge = fakeBridge();
  const dom = fakeDom({ table: { left: 0, top: 96, right: 390, bottom: 708 } });
  const SOL = load({ bridge, dom });
  await settle();
  SOL.Settings.set('fullscreen', false);
  await settle();
  SOL.Settings.set('fullscreen', true);
  await settle();
  assert.deepStrictEqual(bridge.args('setGestureExclusion').map(strips), [
    [{ x: 0, y: 96, w: 40, h: 612 }, { x: 350, y: 96, w: 40, h: 612 }],
    [{ x: 0, y: 508, w: 40, h: 200 }, { x: 350, y: 508, w: 40, h: 200 }],
    [{ x: 0, y: 96, w: 40, h: 612 }, { x: 350, y: 96, w: 40, h: 612 }],
  ]);
});

test('exclusion: a burst of resize events is answered once, with the final layout', async () => {
  const bridge = fakeBridge();
  const dom = fakeDom({ table: { left: 0, top: 96, right: 390, bottom: 708 } });
  load({ bridge, dom });
  await settle();
  // Rotation: many resize events while the layout changes.
  dom.table = { left: 0, top: 80, right: 600, bottom: 500 };
  dom.fire('resize');
  dom.table = { left: 0, top: 70, right: 800, bottom: 390 };
  dom.fire('resize');
  dom.fire('orientationchange');
  dom.table = { left: 0, top: 56, right: 844, bottom: 334 };
  dom.fire('resize');
  await settle();
  assert.strictEqual(bridge.args('setGestureExclusion').length, 2);
  assert.deepStrictEqual(strips(bridge.args('setGestureExclusion')[1]), [
    { x: 0, y: 56, w: 40, h: 278 },
    { x: 804, y: 56, w: 40, h: 278 },
  ]);
});

test('exclusion: each trigger on its own leads to a new measurement', async () => {
  const bridge = fakeBridge();
  const dom = fakeDom({ table: { left: 0, top: 96, right: 390, bottom: 708 } });
  load({ bridge, dom });
  await settle();
  let bottom = 708;
  for (const type of ['resize', 'orientationchange', 'load']) {
    const before = bridge.args('setGestureExclusion').length;
    bottom -= 10;
    dom.table = { left: 0, top: 96, right: 390, bottom };
    dom.fire(type);
    await settle();
    const sent = bridge.args('setGestureExclusion');
    assert.strictEqual(sent.length, before + 1, type);
    assert.strictEqual(strips(sent[sent.length - 1])[0].h, bottom - 96, type);
  }
});

test('exclusion: events that keep coming postpone the measurement until they stop', (t) => {
  // Deterministic clock: the debounce must be restarted by every event, not just started once.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const bridge = fakeBridge();
  const dom = fakeDom({ table: { left: 0, top: 96, right: 390, bottom: 708 } });
  load({ bridge, dom });
  t.mock.timers.tick(80);
  assert.strictEqual(bridge.args('setGestureExclusion').length, 1);

  // A rotation animates for longer than the debounce: an event every 50 ms for 250 ms.
  for (let step = 1; step <= 5; step++) {
    dom.table = { left: 0, top: 96, right: 390 + step * 90, bottom: 708 - step * 60 };
    dom.fire('resize');
    t.mock.timers.tick(50);
  }
  assert.strictEqual(bridge.args('setGestureExclusion').length, 1, 'nothing while the layout is still moving');
  t.mock.timers.tick(29);
  assert.strictEqual(bridge.args('setGestureExclusion').length, 1, '79 ms after the last event: not yet');
  t.mock.timers.tick(1);
  assert.deepStrictEqual(bridge.args('setGestureExclusion').slice(1).map(strips), [
    [{ x: 0, y: 96, w: 40, h: 312 }, { x: 800, y: 96, w: 40, h: 312 }],
  ]);
  t.mock.timers.tick(1000);
  assert.strictEqual(bridge.args('setGestureExclusion').length, 2, 'and no timer is left behind');
  t.mock.timers.reset();
});

test('exclusion: a list the shell failed to take is sent again at the next opportunity', async () => {
  const bridge = fakeBridge();
  let failures = 1;
  const record = bridge.setGestureExclusion;
  bridge.setGestureExclusion = (json) => {
    if (failures-- > 0) throw new Error('Java exception was raised during method invocation');
    record(json);
  };
  const dom = fakeDom({ table: { left: 0, top: 96, right: 390, bottom: 708 } });
  const SOL = load({ bridge, dom });
  await settle(); // the first attempt fails
  assert.deepStrictEqual(bridge.args('setGestureExclusion'), []);
  dom.fire('resize'); // same layout, but the shell never got it
  await settle();
  assert.strictEqual(bridge.args('setGestureExclusion').length, 1);
  assert.strictEqual(SOL.App.setGestureExclusion([]), true);
});

test('exclusion: an unchanged layout is not sent again', async () => {
  const bridge = fakeBridge();
  const dom = fakeDom();
  const SOL = load({ bridge, dom });
  await settle();
  dom.fire('resize');
  dom.fire('load');
  SOL.App.setInsets({ top: 24, right: 0, bottom: 16, left: 0 });
  await settle();
  assert.strictEqual(bridge.args('setGestureExclusion').length, 1);
});

test('exclusion: new insets from the shell trigger a new measurement', async () => {
  const bridge = fakeBridge();
  const dom = fakeDom({ table: { left: 0, top: 96, right: 390, bottom: 708 } });
  const SOL = load({ bridge, dom });
  await settle();
  // The bars went away: the HUD and the toolbar lose their padding and #table grows.
  dom.table = { left: 0, top: 72, right: 390, bottom: 760 };
  SOL.App.setInsets({ top: 0, right: 0, bottom: 0, left: 0 });
  await settle();
  assert.deepStrictEqual(strips(bridge.args('setGestureExclusion')[1]), [
    { x: 0, y: 72, w: 40, h: 688 },
    { x: 350, y: 72, w: 40, h: 688 },
  ]);
});

test('exclusion: #table is watched for size changes that come without a window resize', async () => {
  const bridge = fakeBridge();
  const dom = fakeDom({ table: { left: 0, top: 0, right: 390, bottom: 844 } });
  load({ bridge, dom });
  await settle();
  assert.strictEqual(dom.observers.length, 1);
  assert.strictEqual(dom.observers[0].observed.length, 1);
  // The HUD and the toolbar are built: #table shrinks, no resize event is fired.
  dom.table = { left: 0, top: 96, right: 390, bottom: 708 };
  dom.observers[0].callback([]);
  await settle();
  assert.deepStrictEqual(strips(bridge.args('setGestureExclusion')[1]), [
    { x: 0, y: 96, w: 40, h: 612 },
    { x: 350, y: 96, w: 40, h: 612 },
  ]);
});

test('exclusion: while an overlay is open (a back handler is registered) the edges are free', async () => {
  const bridge = fakeBridge();
  const dom = fakeDom({ table: { left: 0, top: 96, right: 390, bottom: 708 } });
  const SOL = load({ bridge, dom });
  await settle();
  const closeSettings = SOL.App.addBackHandler(() => true);
  const closeDialog = SOL.App.addBackHandler(() => true);
  await settle();
  assert.strictEqual(bridge.args('setGestureExclusion')[1], '[]');
  closeDialog();
  await settle();
  assert.strictEqual(bridge.args('setGestureExclusion').length, 2, 'one overlay is still open');
  closeSettings();
  closeSettings(); // removing twice is harmless
  await settle();
  assert.strictEqual(bridge.args('setGestureExclusion').length, 3);
  assert.deepStrictEqual(strips(bridge.args('setGestureExclusion')[2]), [
    { x: 0, y: 96, w: 40, h: 612 },
    { x: 350, y: 96, w: 40, h: 612 },
  ]);
});

test('exclusion: an overlay that opens and closes within the debounce sends nothing', async () => {
  const bridge = fakeBridge();
  const dom = fakeDom();
  const SOL = load({ bridge, dom });
  await settle();
  SOL.App.addBackHandler(() => true)();
  await settle();
  assert.strictEqual(bridge.args('setGestureExclusion').length, 1);
});

test('exclusion: without #table nothing is ever sent', async () => {
  const bridge = fakeBridge();
  const dom = fakeDom({ table: null });
  const SOL = load({ bridge, dom });
  dom.fire('resize');
  SOL.App.addBackHandler(() => true);
  SOL.Settings.set('fullscreen', false);
  await settle();
  assert.deepStrictEqual(bridge.args('setGestureExclusion'), []);
  assert.deepStrictEqual(dom.observers, []);
});

test('exclusion: #table that only exists once the DOM is ready is picked up then', async () => {
  const bridge = fakeBridge();
  const dom = fakeDom({ table: null, readyState: 'loading' });
  load({ bridge, dom });
  await settle();
  assert.deepStrictEqual(bridge.args('setGestureExclusion'), []);
  dom.table = { left: 0, top: 96, right: 390, bottom: 708 };
  dom.fireDocument('DOMContentLoaded');
  await settle();
  assert.strictEqual(bridge.args('setGestureExclusion').length, 1);
  assert.strictEqual(dom.observers.length, 1);
});

test('exclusion: fractional layouts are rounded outwards and narrow tables get narrower strips', async () => {
  const bridge = fakeBridge();
  // 1080 px wide at density 2.625: 411.43 CSS px.
  const dom = fakeDom({ table: { left: 0, top: 64.5, right: 411.4285583496094, bottom: 700.25 } });
  load({ bridge, dom });
  await settle();
  assert.deepStrictEqual(strips(bridge.args('setGestureExclusion')[0]), [
    { x: 0, y: 64, w: 40, h: 637 },
    { x: 371, y: 64, w: 41, h: 637 },
  ]);

  const narrowBridge = fakeBridge();
  const narrow = fakeDom({ table: { left: 10, top: 0, right: 70, bottom: 100 } });
  load({ bridge: narrowBridge, dom: narrow });
  await settle();
  assert.deepStrictEqual(strips(narrowBridge.args('setGestureExclusion')[0]), [
    { x: 10, y: 0, w: 30, h: 100 },
    { x: 40, y: 0, w: 30, h: 100 },
  ]);
});

test('exclusion: a collapsed #table clears the strips', async () => {
  const bridge = fakeBridge();
  const dom = fakeDom({ table: { left: 0, top: 96, right: 390, bottom: 96 } });
  load({ bridge, dom });
  await settle();
  assert.deepStrictEqual(bridge.args('setGestureExclusion'), ['[]']);
});

test('exclusion: SOL.App.setGestureExclusion drops what is not a rectangle and caps the list', () => {
  const bridge = fakeBridge();
  const SOL = load({ bridge });
  assert.strictEqual(
    SOL.App.setGestureExclusion([
      { x: 1.5, y: 2.5, w: 10, h: 20 },
      null,
      'nonsense',
      { x: 0, y: 0, w: 0, h: 10 },
      { x: 0, y: 0, w: 10, h: -1 },
      { x: NaN, y: 0, w: 10, h: 10 },
      { x: 0, y: Infinity, w: 10, h: 10 },
      { x: '5', y: '6', w: '7', h: '8' },
    ]),
    true
  );
  assert.deepStrictEqual(strips(bridge.args('setGestureExclusion')[0]), [
    { x: 1, y: 2, w: 11, h: 21 },
    { x: 5, y: 6, w: 7, h: 8 },
  ]);

  const many = Array.from({ length: 20 }, (_, i) => ({ x: i, y: 0, w: 1, h: 1 }));
  assert.strictEqual(SOL.App.setGestureExclusion(many), true);
  assert.strictEqual(strips(bridge.args('setGestureExclusion')[1]).length, 8);

  assert.strictEqual(SOL.App.setGestureExclusion('not an array'), true);
  assert.strictEqual(bridge.args('setGestureExclusion')[2], '[]');
  assert.strictEqual(SOL.App.setGestureExclusion([]), true);
  assert.strictEqual(bridge.args('setGestureExclusion').length, 3, 'the same list is not sent twice');
});

// ------------------------------------------------------------------ what was there before still works
test('the existing contract is intact: platform flags, haptics, back handlers, insets, keep-screen-on', () => {
  const bridge = fakeBridge();
  const dom = fakeDom();
  const SOL = load({ bridge, dom });
  assert.strictEqual(dom.document.documentElement.attributes['data-platform'], 'android-app');
  assert.deepStrictEqual(Object.keys(SOL.Platform).sort(), ['canHover', 'isAndroid', 'isNativeApp', 'isTouch']);
  assert.strictEqual(SOL.Haptics.supported, true);

  // Haptics go to the shell and honour the setting.
  assert.strictEqual(SOL.Haptics.play('success'), true);
  assert.strictEqual(SOL.Haptics.play('no-such-kind'), false);
  SOL.Settings.set('haptics', false);
  assert.strictEqual(SOL.Haptics.play('win'), false);
  assert.deepStrictEqual(bridge.args('haptic'), ['success']);

  // Back handlers: last in, first asked; false declines; a throwing handler declines.
  const order = [];
  assert.strictEqual(SOL.App.onBack(), false);
  const removeFirst = SOL.App.addBackHandler(() => {
    order.push('first');
    return true;
  });
  const removeSecond = SOL.App.addBackHandler(() => {
    order.push('second');
    return false;
  });
  const errors = withConsoleErrors(() => {
    SOL.App.addBackHandler(() => {
      order.push('third');
      throw new Error('handler bug');
    });
    assert.strictEqual(SOL.App.onBack(), true);
  });
  assert.strictEqual(errors.length, 1);
  assert.deepStrictEqual(order, ['third', 'second', 'first']);
  removeFirst();
  removeSecond();
  assert.throws(() => SOL.App.addBackHandler('not a function'), TypeError);

  // Insets become CSS variables and an event.
  const seen = [];
  SOL.Bus.on('app:insets', (insets) => seen.push(insets));
  SOL.App.setInsets({ top: 24, right: 0, bottom: 16.5, left: -3 });
  assert.deepStrictEqual(dom.document.documentElement.style.properties, {
    '--safe-t': '24px',
    '--safe-r': '0px',
    '--safe-b': '16.5px',
  });
  assert.strictEqual(seen.length, 1);

  SOL.App.keepScreenOn(1);
  SOL.App.keepScreenOn(0);
  assert.deepStrictEqual(bridge.args('keepScreenOn'), [true, false]);
  assert.deepStrictEqual(bridge.args('exit'), [], 'the page never leaves the app on its own here');
});

test('the App API has the old methods plus the two new ones', () => {
  const SOL = load({});
  assert.deepStrictEqual(Object.keys(SOL.App).sort(), [
    'addBackHandler',
    'keepScreenOn',
    'onBack',
    'setFullscreen',
    'setGestureExclusion',
    'setInsets',
  ]);
  assert.deepStrictEqual(Object.keys(SOL.Haptics).sort(), ['play', 'supported']);
});

// ------------------------------------------------------------------ haptics before the first gesture
/**
 * Runs `fn` with a fake browser `navigator` in place (platform.js reads it when it loads). Node's own
 * navigator is put back afterwards.
 */
function withNavigator(fake, fn) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: fake, configurable: true, writable: true });
  try {
    fn();
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete globalThis.navigator;
  }
}

function fakeBrowserNavigator(activation) {
  const vibrations = [];
  const nav = {
    userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile',
    vibrations,
    vibrate(pattern) {
      vibrations.push(pattern);
      return true;
    },
  };
  if (activation) nav.userActivation = activation;
  return nav;
}

test('haptics in a browser: nothing is attempted before the first user gesture', () => {
  // (the opening deal runs before any gesture; Chrome logs an intervention for every such vibrate call)
  const activation = { hasBeenActive: false, isActive: false };
  const nav = fakeBrowserNavigator(activation);
  withNavigator(nav, () => {
    const SOL = load({});
    assert.strictEqual(SOL.Platform.isNativeApp, false);
    assert.strictEqual(SOL.Haptics.supported, true);
    for (const kind of ['tick', 'thud', 'success', 'heavy', 'win']) {
      assert.strictEqual(SOL.Haptics.play(kind), false, kind + ' is held back');
    }
    assert.deepStrictEqual(nav.vibrations, [], 'navigator.vibrate was not called');

    // the first tap: from now on the browser allows it
    activation.hasBeenActive = true;
    assert.strictEqual(SOL.Haptics.play('heavy'), true);
    assert.strictEqual(SOL.Haptics.play('success'), true);
    assert.deepStrictEqual(nav.vibrations, [30, [10, 36, 16]]);
  });
});

test('haptics in a browser that cannot tell whether there was a gesture: tried as before', () => {
  const nav = fakeBrowserNavigator(null); // no navigator.userActivation (older WebViews, Firefox)
  withNavigator(nav, () => {
    const SOL = load({});
    assert.strictEqual(SOL.Haptics.play('heavy'), true);
    assert.deepStrictEqual(nav.vibrations, [30]);
  });
});

test('haptics in the app: the bridge is used and needs no user gesture', () => {
  const nav = fakeBrowserNavigator({ hasBeenActive: false, isActive: false });
  withNavigator(nav, () => {
    const bridge = fakeBridge();
    const SOL = load({ bridge });
    assert.strictEqual(SOL.Platform.isNativeApp, true);
    assert.strictEqual(SOL.Haptics.play('thud'), true);
    assert.strictEqual(SOL.Haptics.play('win'), true);
    assert.deepStrictEqual(bridge.args('haptic'), ['thud', 'win']);
    assert.deepStrictEqual(nav.vibrations, [], 'navigator.vibrate is not used inside the app');
  });
});
