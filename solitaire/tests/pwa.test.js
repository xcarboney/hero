/*
 * The PWA plumbing: manifest.webmanifest, sw.js, js/pwa.js and icons/.
 * Run with: node --test solitaire/tests/
 *
 * The game has no build step, so nothing generates the service worker's PRECACHE list. The first
 * block keeps it honest: every css/js file index.html loads and every manifest icon must be in
 * the list, and every listed file must exist.
 *
 * While the game is still being assembled (js/main.js does not exist yet) a listed file that is
 * not written yet is skipped, not failed. As soon as js/main.js exists the check is strict.
 *
 * sw.js and js/pwa.js are browser scripts without exports. They run here inside node:vm
 * sandboxes with small fakes of the browser objects they touch.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

/** Lets promise continuations and timers of the sandboxed scripts run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

// ------------------------------------------------------------------ sources under test
const manifest = JSON.parse(read('manifest.webmanifest'));

/** Local files index.html loads: href/src of its link, script and media tags, minus data:/http: URLs. */
function localReferences(html) {
  const refs = [];
  const tags = html.replace(/<!--[\s\S]*?-->/g, '').match(/<(?:link|script|img|source|audio|video)\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const attr = /\s(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    if (!attr) continue;
    const url = attr[1] !== undefined ? attr[1] : attr[2];
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url) || url === '') continue;
    refs.push(url.replace(/^\.\//, '').replace(/[?#].*$/, ''));
  }
  return refs;
}
const indexRefs = localReferences(read('index.html'));

// ------------------------------------------------------------------ sw.js in a sandbox
const SW_ORIGIN = 'https://play.example';
const SW_ROOT = SW_ORIGIN + '/hero/solitaire/';

function response(body, init = {}) {
  return {
    status: init.status === undefined ? 200 : init.status,
    statusText: 'OK',
    type: init.type || 'basic',
    redirected: !!init.redirected,
    headers: {},
    body: body,
    clone() {
      return this;
    },
  };
}

/** Cache Storage with just the calls sw.js makes. `stores` is name -> Map(url -> response). */
function fakeCaches(stores) {
  const open = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const map = stores.get(name);
    return {
      match: async (key) => map.get(String(key)),
      put: async (key, res) => void map.set(String(key), res),
    };
  };
  return {
    open: async (name) => open(name),
    keys: async () => Array.from(stores.keys()),
    delete: async (name) => stores.delete(name),
  };
}

/**
 * Runs sw.js with `network` as its fetch: (url, init) -> response | throws.
 * Returns its constants, the event handlers it registered, the cache stores and what it did.
 */
function loadServiceWorker(network, stores = new Map()) {
  const handlers = {};
  const did = { fetched: [], claimed: 0, skippedWaiting: 0 };
  const sandbox = {
    URL,
    self: {
      location: new URL('sw.js', SW_ROOT),
      addEventListener: (type, fn) => void (handlers[type] = fn),
      clients: { claim: async () => void did.claimed++ },
      skipWaiting: () => void did.skippedWaiting++,
    },
    caches: fakeCaches(stores),
    fetch: async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      did.fetched.push({ url: url, cache: init && init.cache });
      return network(url, init);
    },
    // Stands in for the browser's Response when sw.js copies a redirected one.
    Response: function (body, init) {
      return Object.assign(response(body, init), { rebuilt: true });
    },
  };
  const constants = vm.runInNewContext(read('sw.js') + '\n;({ PRECACHE, VERSION, CACHE, CACHE_PREFIX, APP_ROOT });', sandbox, {
    filename: 'sw.js',
  });
  return { ...constants, handlers, stores, did };
}

/** Dispatches an install/activate style event and waits for its waitUntil promises. */
async function lifecycle(sw, type) {
  const pending = [];
  sw.handlers[type]({ waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
}

/** Dispatches a fetch event. Resolves to { handled, response | error } once background work is done. */
async function fetchEvent(sw, url, init = {}) {
  const pending = [];
  let answer = null;
  sw.handlers.fetch({
    request: { url: url, method: init.method || 'GET', mode: init.mode || 'no-cors' },
    respondWith: (p) => void (answer = Promise.resolve(p)),
    waitUntil: (p) => pending.push(p),
  });
  if (!answer) return { handled: false };
  const out = { handled: true };
  try {
    out.response = await answer;
  } catch (err) {
    out.error = err;
  }
  await Promise.all(pending);
  return out;
}

const sw = loadServiceWorker(() => response('unused'));
const PRECACHE = Array.from(sw.PRECACHE);

// ------------------------------------------------------------------ PRECACHE honesty
test('PRECACHE holds relative same-origin paths, each once', () => {
  assert.ok(PRECACHE.length > 0);
  for (const entry of PRECACHE) {
    assert.strictEqual(typeof entry, 'string');
    assert.ok(!/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(entry), `"${entry}" must be relative (the app may live in a sub-folder)`);
    assert.ok(!entry.split('/').includes('..') && !/[?#]/.test(entry), `"${entry}" must be a plain path inside the app folder`);
    assert.ok(!/^(?:dev|tests)\//.test(entry) && entry !== 'sw.js', `"${entry}" is not part of the app shell`);
  }
  assert.deepStrictEqual(PRECACHE, Array.from(new Set(PRECACHE)), 'duplicate PRECACHE entries');
  assert.ok(PRECACHE.includes('index.html'), 'index.html is the offline fallback and must be precached');
  assert.ok(PRECACHE.includes('manifest.webmanifest'));
});

test('every css/js file index.html references is in PRECACHE', () => {
  assert.ok(indexRefs.some((ref) => ref.endsWith('.css')) && indexRefs.includes('js/pwa.js'), 'index.html was not parsed');
  const missing = indexRefs.filter((ref) => !PRECACHE.includes(ref));
  assert.deepStrictEqual(missing, [], 'add these files to PRECACHE in sw.js: the game would not start offline without them');
});

test('every manifest icon is in PRECACHE', () => {
  const missing = manifest.icons.map((icon) => icon.src).filter((src) => !PRECACHE.includes(src));
  assert.deepStrictEqual(missing, [], 'add these icons to PRECACHE in sw.js');
});

test('every PRECACHE entry exists on disk', async (t) => {
  // js/main.js is the last piece of the game: until it exists, files still being written by
  // others are tolerated. From then on a listed file that is missing fails this test.
  const assembled = exists('js/main.js');
  for (const entry of PRECACHE) {
    await t.test(entry, (st) => {
      if (exists(entry)) return;
      if (!assembled) {
        st.skip('not written yet (tolerated until js/main.js exists)');
        return;
      }
      assert.fail(`sw.js precaches "${entry}" but the file does not exist: add the file, or remove it from PRECACHE and index.html`);
    });
  }
});

// ------------------------------------------------------------------ manifest
test('manifest: identity, display and colours', () => {
  assert.strictEqual(manifest.name, 'Solitaire 3D');
  assert.strictEqual(manifest.short_name, 'Solitaire');
  assert.strictEqual(manifest.display, 'fullscreen');
  assert.deepStrictEqual(manifest.display_override, ['fullscreen', 'standalone']);
  assert.strictEqual(manifest.orientation, 'any');
  assert.deepStrictEqual(manifest.categories, ['games', 'card']);
  // The table felt at its darkest (css/base.css --felt-lo) and the page's theme-color meta.
  assert.strictEqual(manifest.background_color, '#05241b');
  assert.strictEqual(manifest.theme_color, '#0b3d2e');
  assert.match(read('css/base.css'), /--felt-lo:\s*#05241b/);
  assert.match(read('index.html'), /<meta name="theme-color" content="#0b3d2e">/);
});

test('manifest: every URL is relative, so the app works under a sub-path', () => {
  assert.strictEqual(manifest.start_url, './');
  assert.strictEqual(manifest.scope, './');
  // An "id" would resolve against the origin, not the folder, and clash with other apps there.
  assert.strictEqual(manifest.id, undefined);
  for (const icon of manifest.icons) {
    assert.ok(!/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(icon.src), `icon "${icon.src}" must be relative`);
  }
});

test('manifest: 192 and 512 PNG icons for "any" and for "maskable", plus an SVG', () => {
  const has = (purpose, sizes, type) =>
    manifest.icons.some((icon) => icon.purpose === purpose && icon.sizes === sizes && icon.type === type);
  for (const purpose of ['any', 'maskable']) {
    for (const sizes of ['192x192', '512x512']) {
      assert.ok(has(purpose, sizes, 'image/png'), `missing ${purpose} ${sizes} PNG`);
    }
  }
  assert.ok(has('any', 'any', 'image/svg+xml'), 'missing SVG icon');
});

// ------------------------------------------------------------------ icons
/** Decodes the PNGs icons/render.js writes (8-bit RGB or RGBA, not interlaced). */
function readPng(rel) {
  const buf = fs.readFileSync(path.join(ROOT, rel));
  assert.ok(buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `${rel} is not a PNG`);
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  for (let pos = 8; pos < buf.length; ) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      channels = { 2: 3, 6: 4 }[data[9]] || 0;
      assert.ok(data[8] === 8 && channels && data[12] === 0, `${rel}: unexpected PNG format, render it with icons/render.js`);
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    pos += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[y * stride + x - channels] : 0; // left
      const b = y > 0 ? px[(y - 1) * stride + x] : 0; // up
      const c = x >= channels && y > 0 ? px[(y - 1) * stride + x - channels] : 0; // up-left
      let predicted = 0;
      if (filter === 1) predicted = a;
      else if (filter === 2) predicted = b;
      else if (filter === 3) predicted = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = (raw[y * (stride + 1) + 1 + x] + predicted) & 255;
    }
  }
  return {
    width: width,
    height: height,
    /** [r, g, b, a] */
    at(x, y) {
      const i = y * stride + x * channels;
      return [px[i], px[i + 1], px[i + 2], channels === 4 ? px[i + 3] : 255];
    },
  };
}

/** The table felt of icon.svg: dark, green-dominant. The cards (ivory, gold, ink) are not. */
const isFelt = ([r, g, b, a]) => a === 255 && r <= 30 && g > r && g > b;

test('icons: PNGs have the sizes the manifest declares', () => {
  for (const icon of manifest.icons.filter((i) => i.type === 'image/png')) {
    const png = readPng(icon.src);
    assert.strictEqual(`${png.width}x${png.height}`, icon.sizes, icon.src);
  }
  const apple = readPng('icons/apple-touch-icon.png');
  assert.strictEqual(`${apple.width}x${apple.height}`, '180x180');
});

test('icons: maskable PNGs are opaque and keep the artwork inside the safe zone', () => {
  for (const icon of manifest.icons.filter((i) => i.purpose === 'maskable')) {
    const png = readPng(icon.src);
    const centre = png.width / 2;
    const safe = png.width * 0.4; // W3C maskable icons: a circle of 40% radius is never cropped
    let art = 0;
    for (let y = 0; y < png.height; y++) {
      for (let x = 0; x < png.width; x++) {
        const outside = Math.hypot(x + 0.5 - centre, y + 0.5 - centre) > safe;
        const felt = isFelt(png.at(x, y));
        if (outside) assert.ok(felt, `${icon.src}: pixel ${x},${y} outside the safe zone is not table felt`);
        else if (!felt) art++;
      }
    }
    assert.ok(art > png.width * png.height * 0.2, `${icon.src}: the cards should fill a good part of the safe zone`);
  }
});

test('icons: "any" PNGs are a plate with transparent corners; the iOS icon is opaque', () => {
  for (const icon of manifest.icons.filter((i) => i.purpose === 'any' && i.type === 'image/png')) {
    const png = readPng(icon.src);
    const last = png.width - 1;
    for (const [x, y] of [[0, 0], [last, 0], [0, last], [last, last]]) {
      assert.strictEqual(png.at(x, y)[3], 0, `${icon.src}: corner ${x},${y} should be transparent`);
    }
    assert.ok(isFelt(png.at(Math.round(png.width * 0.1), png.width >> 1)), `${icon.src}: the plate should be felt`);
  }
  const apple = readPng('icons/apple-touch-icon.png');
  assert.ok(isFelt(apple.at(0, 0)) && isFelt(apple.at(179, 179)), 'iOS draws transparent pixels black');
});

test('icons: icon.svg is the source and carries the #maskable variant', () => {
  const svg = read('icons/icon.svg');
  assert.match(svg, /viewBox="0 0 512 512"/);
  assert.match(svg, /id="maskable"/);
  assert.match(svg, /#maskable:target/);
  assert.match(svg, /#f3c969/i, 'the gold accent');
  assert.match(svg, /#05241b/i, 'the table colour');
});

// ------------------------------------------------------------------ sw.js behaviour
test('sw: the cache name carries the version and the deployment path', () => {
  assert.strictEqual(sw.APP_ROOT, SW_ROOT);
  assert.strictEqual(sw.CACHE, 'solitaire3d:/hero/solitaire/:' + sw.VERSION);
  assert.match(sw.VERSION, /^v\d+$/);
});

test('sw install: caches the shell file by file and survives missing and failing files', async () => {
  const gone = SW_ROOT + 'css/ui.css';
  const broken = SW_ROOT + 'js/main.js';
  const worker = loadServiceWorker((url) => {
    if (url === gone) return response('not found', { status: 404 });
    if (url === broken) throw new TypeError('Failed to fetch');
    return response('body of ' + url);
  });
  await lifecycle(worker, 'install'); // must not reject
  const cache = worker.stores.get(worker.CACHE);
  assert.strictEqual(cache.size, PRECACHE.length - 2);
  assert.ok(!cache.has(gone) && !cache.has(broken));
  assert.ok(cache.has(SW_ROOT + 'index.html'));
  // Bypasses the HTTP cache, so a new version never precaches stale copies.
  assert.ok(worker.did.fetched.every((f) => f.cache === 'reload'));
  assert.deepStrictEqual(worker.did.fetched.map((f) => f.url).sort(), PRECACHE.map((p) => SW_ROOT + p).sort());
});

test('sw install: a redirected response is stored without its redirect flag', async () => {
  const worker = loadServiceWorker((url) => response('x', { redirected: url.endsWith('index.html') }));
  await lifecycle(worker, 'install');
  const cache = worker.stores.get(worker.CACHE);
  assert.strictEqual(cache.get(SW_ROOT + 'index.html').redirected, false);
  assert.strictEqual(cache.get(SW_ROOT + 'index.html').rebuilt, true);
  assert.strictEqual(cache.get(SW_ROOT + 'js/pwa.js').rebuilt, undefined);
});

test('sw activate: deletes only this app\'s old caches, keeps files the new cache lacks, claims clients', async () => {
  const oldName = 'solitaire3d:/hero/solitaire/:v0';
  const otherDeployment = 'solitaire3d:/fork/solitaire/:v0';
  const stores = new Map([
    [oldName, new Map([[SW_ROOT + 'js/main.js', response('old main')], [SW_ROOT + 'index.html', response('old index')]])],
    [otherDeployment, new Map()],
    ['someone-elses-cache', new Map()],
  ]);
  const worker = loadServiceWorker((url) => {
    if (url === SW_ROOT + 'js/main.js') throw new TypeError('Failed to fetch');
    return response('new');
  }, stores);
  await lifecycle(worker, 'install');
  await lifecycle(worker, 'activate');
  assert.deepStrictEqual(Array.from(stores.keys()).sort(), [otherDeployment, 'solitaire3d:/hero/solitaire/:' + worker.VERSION, 'someone-elses-cache'].sort());
  const cache = stores.get(worker.CACHE);
  assert.strictEqual(cache.get(SW_ROOT + 'js/main.js').body, 'old main', 'carried over from the old cache');
  assert.strictEqual(cache.get(SW_ROOT + 'index.html').body, 'new', 'a fresh download wins over the old copy');
  assert.strictEqual(worker.did.claimed, 1);
});

test('sw fetch: leaves non-GET and cross-origin requests alone', async () => {
  const worker = loadServiceWorker(() => response('x'));
  assert.strictEqual((await fetchEvent(worker, SW_ROOT + 'index.html', { method: 'POST' })).handled, false);
  assert.strictEqual((await fetchEvent(worker, 'https://elsewhere.example/hero/solitaire/index.html')).handled, false);
  assert.strictEqual(worker.did.fetched.length, 0);
});

test('sw fetch: answers from the cache and refreshes it in the background', async () => {
  let deployed = 'v1 css';
  const worker = loadServiceWorker(() => response(deployed));
  await lifecycle(worker, 'install');
  deployed = 'v2 css';
  worker.did.fetched.length = 0;

  const first = await fetchEvent(worker, SW_ROOT + 'css/base.css');
  assert.strictEqual(first.response.body, 'v1 css', 'stale copy first');
  assert.deepStrictEqual(worker.did.fetched, [{ url: SW_ROOT + 'css/base.css', cache: 'no-cache' }], 'revalidated with the server');
  const second = await fetchEvent(worker, SW_ROOT + 'css/base.css?cachebust=1');
  assert.strictEqual(second.response.body, 'v2 css', 'refreshed copy on the next request');
});

test('sw fetch: a file that is not cached comes from the network and is stored', async () => {
  let online = true;
  const worker = loadServiceWorker((url) => {
    if (!online) throw new TypeError('Failed to fetch');
    return url.endsWith('missing.js') ? response('nope', { status: 404 }) : response('late file');
  });
  const url = SW_ROOT + 'js/view/late.js';
  assert.strictEqual((await fetchEvent(worker, url)).response.body, 'late file');
  assert.strictEqual((await fetchEvent(worker, SW_ROOT + 'js/missing.js')).response.status, 404);
  online = false;
  assert.strictEqual((await fetchEvent(worker, url)).response.body, 'late file', 'served offline afterwards');
  const miss = await fetchEvent(worker, SW_ROOT + 'js/missing.js');
  assert.ok(miss.error instanceof TypeError, 'an error page is never cached; offline it fails like the network');
});

test('sw fetch: offline navigations get the cached index.html', async () => {
  let online = true;
  const worker = loadServiceWorker((url) => {
    if (!online) throw new TypeError('Failed to fetch');
    return response('shell of ' + url);
  });
  await lifecycle(worker, 'install');
  online = false;
  const shell = 'shell of ' + SW_ROOT + 'index.html';
  for (const url of [SW_ROOT, SW_ROOT + '?source=pwa', SW_ROOT + 'index.html', SW_ROOT + 'unknown/page.html']) {
    const out = await fetchEvent(worker, url, { mode: 'navigate' });
    assert.strictEqual(out.response && out.response.body, shell, url);
  }
  // Only navigations fall back to the shell: a missing script must not receive HTML.
  const script = await fetchEvent(worker, SW_ROOT + 'js/unknown.js');
  assert.ok(script.error instanceof TypeError);
});

test('sw message: SKIP_WAITING activates a waiting worker, nothing else does', () => {
  const worker = loadServiceWorker(() => response('x'));
  worker.handlers.message({ data: { type: 'SOMETHING_ELSE' } });
  worker.handlers.message({ data: null });
  assert.strictEqual(worker.did.skippedWaiting, 0);
  worker.handlers.message({ data: { type: 'SKIP_WAITING' } });
  assert.strictEqual(worker.did.skippedWaiting, 1);
});

// ------------------------------------------------------------------ js/pwa.js in a sandbox
/**
 * A window with just what js/pwa.js touches. `href` is the page URL.
 * options: native (a SolitaireNative bridge), readyState, serviceWorker (false = unavailable),
 * waiting (a waiting worker in the registration), modes (display modes that match).
 */
function loadPwa(href, options = {}) {
  const page = new URL(href);
  const listeners = {}; // window + document listeners by type
  const on = (type, fn) => void (listeners[type] = listeners[type] || []).push(fn);
  const idle = [];
  const queries = {};
  const did = { head: [], registered: [], posted: [], console: [] };
  const record = (...args) => void did.console.push(args.join(' '));

  const head = {
    appendChild: (el) => void did.head.push(el),
    querySelector(selector) {
      const [, tag, name, value] = /^(\w+)\[(\w+)="([^"]+)"\]$/.exec(selector);
      return did.head.find((el) => el.tag === tag && el.attrs[name] === value) || null;
    },
  };
  const registration = { waiting: options.waiting ? { postMessage: (msg) => void did.posted.push(msg) } : null };
  const navigator = {};
  if (options.serviceWorker !== false) {
    navigator.serviceWorker = {
      register: (url, opts) => {
        did.registered.push({ url: url, scope: opts && opts.scope });
        return options.registerFails ? Promise.reject(new Error('SecurityError')) : Promise.resolve(registration);
      },
    };
  }

  const sandbox = {
    URL,
    setTimeout,
    console: { log: record, info: record, warn: record, error: record, debug: record },
    location: { protocol: page.protocol, hostname: page.hostname, href: page.href },
    navigator: navigator,
    document: {
      head: head,
      baseURI: page.href,
      readyState: options.readyState || 'complete',
      fullscreenElement: null,
      currentScript: { src: new URL('js/pwa.js', page).href },
      createElement: (tag) => ({ tag: tag, attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } }),
      addEventListener: on,
    },
    addEventListener: on,
    matchMedia: (media) => {
      const mode = /display-mode: ([\w-]+)/.exec(media)[1];
      queries[mode] = { media: media, matches: (options.modes || []).includes(mode), addEventListener: (type, fn) => void (queries[mode].change = fn) };
      return queries[mode];
    },
    requestIdleCallback: (fn) => void idle.push(fn),
  };
  if (options.native) sandbox.SolitaireNative = { haptic() {} };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('js/core/bus.js'), sandbox, { filename: 'bus.js' });
  vm.runInContext(read('js/pwa.js'), sandbox, { filename: 'pwa.js' });

  return {
    PWA: sandbox.SOL.PWA,
    Bus: sandbox.SOL.Bus,
    did: did,
    listeners: listeners,
    document: sandbox.document,
    fire(type, event = {}) {
      for (const fn of listeners[type] || []) fn(event);
    },
    /** Runs what was queued with requestIdleCallback and lets the registration promise settle. */
    async idle() {
      for (const fn of idle.splice(0)) fn();
      await settle();
    },
    setMode(mode, matches) {
      queries[mode].matches = matches;
      if (queries[mode].change) queries[mode].change();
    },
  };
}

const PAGE = 'https://user.github.io/hero/solitaire/index.html';
const APP = 'https://user.github.io/hero/solitaire/';

/** A browser install offer; `outcome` is the player's answer to the dialog. */
function installOffer(outcome) {
  const offer = {
    prevented: false,
    prompts: 0,
    preventDefault() {
      offer.prevented = true;
    },
    prompt() {
      offer.prompts++;
      return Promise.resolve({ outcome: outcome });
    },
  };
  return offer;
}

for (const [name, href, options] of [
  ['from file://', 'file:///home/user/hero/solitaire/index.html', {}],
  ['inside the Android app (SolitaireNative bridge)', PAGE, { native: true }],
  ['on the Android app\'s asset host', 'https://appassets.androidplatform.net/assets/solitaire/index.html', {}],
]) {
  test(`pwa: does nothing and logs nothing ${name}`, async () => {
    const page = loadPwa(href, { ...options, readyState: 'loading' });
    page.fire('load');
    await page.idle();
    assert.deepStrictEqual(page.did.head, [], 'no tags added to <head>');
    assert.deepStrictEqual(page.did.registered, [], 'no service worker registered');
    assert.deepStrictEqual(page.listeners, {}, 'no event listeners added');
    assert.deepStrictEqual(page.did.console, []);
    // The API is still there, inert, so the settings screen needs no guard.
    assert.strictEqual(page.PWA.supported, false);
    assert.strictEqual(page.PWA.canInstall, false);
    assert.strictEqual(page.PWA.installed, false);
    assert.strictEqual(await page.PWA.promptInstall(), false);
    assert.strictEqual(typeof page.PWA.onChange(() => {}), 'function');
  });
}

test('pwa: on the web it links the manifest and icon relative to the app folder', () => {
  const page = loadPwa(PAGE);
  const find = (tag, key, value) => page.did.head.find((el) => el.tag === tag && el.attrs[key] === value);
  assert.strictEqual(find('link', 'rel', 'manifest').attrs.href, APP + 'manifest.webmanifest');
  assert.strictEqual(find('link', 'rel', 'apple-touch-icon').attrs.href, APP + 'icons/apple-touch-icon.png');
  assert.ok(exists('icons/apple-touch-icon.png'));
  assert.strictEqual(find('meta', 'name', 'mobile-web-app-capable').attrs.content, 'yes');
  assert.strictEqual(find('meta', 'name', 'apple-mobile-web-app-capable').attrs.content, 'yes');
  assert.strictEqual(find('meta', 'name', 'apple-mobile-web-app-title').attrs.content, manifest.short_name);
  assert.strictEqual(find('meta', 'name', 'application-name').attrs.content, manifest.short_name);
  assert.strictEqual(page.PWA.supported, true);
  assert.deepStrictEqual(page.did.console, []);
});

test('pwa: registers sw.js for the app folder only after load, when the browser is idle', async () => {
  const page = loadPwa(PAGE, { readyState: 'loading' });
  await page.idle();
  assert.deepStrictEqual(page.did.registered, [], 'not before the window has loaded');
  page.fire('load');
  assert.deepStrictEqual(page.did.registered, [], 'not in the load handler itself');
  await page.idle();
  assert.deepStrictEqual(page.did.registered, [{ url: APP + 'sw.js', scope: APP }]);
  assert.deepStrictEqual(page.did.posted, [], 'nothing was waiting');
});

test('pwa: a worker that waited for this launch is told to take over; the page is not reloaded', async () => {
  const page = loadPwa(PAGE, { waiting: true });
  await page.idle();
  assert.deepStrictEqual(page.did.posted, [{ type: 'SKIP_WAITING' }]);
  assert.strictEqual(page.listeners.controllerchange, undefined, 'no reload-on-takeover hook');
  assert.doesNotMatch(read('js/pwa.js'), /location\.reload|\.skipWaiting\(/);
  assert.doesNotMatch(read('sw.js').replace(/self\.addEventListener\('message'[\s\S]*$/, ''), /skipWaiting/, 'sw.js must only skip waiting when asked');
});

test('pwa: stays quiet when service workers are unavailable or registration is refused', async () => {
  const insecure = loadPwa('http://192.168.1.20:8000/index.html', { serviceWorker: false });
  await insecure.idle();
  assert.strictEqual(insecure.PWA.supported, false);
  assert.deepStrictEqual(insecure.did.console, []);

  const refused = loadPwa(PAGE, { registerFails: true });
  await refused.idle();
  assert.strictEqual(refused.did.registered.length, 1);
  assert.deepStrictEqual(refused.did.console, []);
});

test('pwa: install offer -> canInstall -> promptInstall() -> installed, with change events', async () => {
  const page = loadPwa(PAGE);
  const seen = [];
  const onBus = [];
  const off = page.PWA.onChange((state) => seen.push(state));
  page.Bus.on('pwa:change', (state) => onBus.push(state));

  const offer = installOffer('accepted');
  page.fire('beforeinstallprompt', offer);
  assert.strictEqual(offer.prevented, true, 'the browser banner is kept off the table');
  assert.strictEqual(page.PWA.canInstall, true);

  assert.strictEqual(await page.PWA.promptInstall(), true);
  assert.strictEqual(offer.prompts, 1);
  assert.strictEqual(page.PWA.canInstall, false, 'an offer can be used once');
  assert.strictEqual(await page.PWA.promptInstall(), false);

  page.fire('appinstalled');
  assert.strictEqual(page.PWA.installed, true);

  const expected = [
    { canInstall: true, installed: false },
    { canInstall: false, installed: false },
    { canInstall: false, installed: true },
  ];
  assert.deepStrictEqual(JSON.parse(JSON.stringify(seen)), expected);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(onBus)), expected);

  off();
  page.fire('beforeinstallprompt', installOffer('accepted'));
  assert.strictEqual(seen.length, 3, 'off() unsubscribes');
  assert.strictEqual(onBus.length, 3, 'installed already: a late offer changes canInstall only');
});

test('pwa: promptInstall() resolves false when the player dismisses or the browser throws', async () => {
  const page = loadPwa(PAGE);
  page.fire('beforeinstallprompt', installOffer('dismissed'));
  assert.strictEqual(await page.PWA.promptInstall(), false);

  const broken = installOffer('accepted');
  broken.prompt = () => {
    throw new Error('NotAllowedError: needs a user gesture');
  };
  page.fire('beforeinstallprompt', broken);
  assert.strictEqual(await page.PWA.promptInstall(), false);

  // Older Chrome: prompt() resolves with nothing, the answer is in userChoice.
  const legacy = installOffer('accepted');
  legacy.prompt = () => Promise.resolve(undefined);
  legacy.userChoice = Promise.resolve({ outcome: 'accepted' });
  page.fire('beforeinstallprompt', legacy);
  assert.strictEqual(await page.PWA.promptInstall(), true);
  assert.deepStrictEqual(page.did.console, []);
});

test('pwa: installed reflects the display mode of an app window', () => {
  assert.strictEqual(loadPwa(PAGE, { modes: ['fullscreen'] }).PWA.installed, true, 'launched from the home screen');
  assert.strictEqual(loadPwa(PAGE, { modes: ['standalone'] }).PWA.installed, true, 'standalone fallback');
  assert.strictEqual(loadPwa(PAGE).PWA.installed, false, 'a browser tab');

  // Installing on desktop moves the tab into an app window while the page is open.
  const page = loadPwa(PAGE);
  const seen = [];
  page.PWA.onChange((state) => seen.push(state.installed));
  page.setMode('standalone', true);
  assert.strictEqual(page.PWA.installed, true);
  assert.deepStrictEqual(seen, [true]);

  // A tab that went full screen through the Fullscreen API is not an installed app.
  const tab = loadPwa(PAGE);
  tab.document.fullscreenElement = {};
  tab.setMode('fullscreen', true);
  assert.strictEqual(tab.PWA.installed, false);
  tab.document.fullscreenElement = null;
  tab.fire('fullscreenchange');
  tab.setMode('fullscreen', false);
  assert.strictEqual(tab.PWA.installed, false);
});

test('pwa: onChange rejects a non-function and survives a throwing listener', () => {
  const page = loadPwa(PAGE);
  assert.throws(() => page.PWA.onChange('nope'), /listener must be a function/);
  const seen = [];
  page.PWA.onChange(() => {
    throw new Error('boom');
  });
  page.PWA.onChange((state) => seen.push(state.canInstall));
  page.fire('beforeinstallprompt', installOffer('accepted'));
  assert.deepStrictEqual(seen, [true]);
  assert.strictEqual(page.did.console.length, 1, 'the failure is reported once, like SOL.Bus does');
});
