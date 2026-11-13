/*
 * Service worker of the Solitaire 3D web app: makes the game start and play without a network
 * once it has been opened online. js/pwa.js registers it; the Android app (/android) never does
 * and does not ship this file.
 *
 * How it behaves
 *   install    Fetches every file in PRECACHE into the cache of this VERSION, one by one. A file
 *              that is missing or fails to download is skipped (the fetch handler stores it the
 *              first time the page loads it), so install itself cannot fail.
 *   activate   Deletes this app's caches of other versions (after keeping any precache file the
 *              new cache is missing) and takes control of the open pages.
 *   fetch      Same-origin GET only; everything else goes to the network untouched.
 *              Stale-while-revalidate: answer from the cache at once and refresh that entry from
 *              the network in the background, so a deployed change shows on the launch after
 *              next. A file that is not cached yet is fetched and stored. A navigation that can
 *              reach neither the cache nor the network gets the cached index.html.
 *
 * Updating
 *   The game's files refresh themselves (see fetch), so editing a css/js file needs nothing here.
 *   Add every new runtime file to PRECACHE: tests/pwa.test.js fails when index.html or the
 *   manifest references a file that is not listed, or when a listed file does not exist.
 *   Bump VERSION to start from an empty cache, e.g. after files were renamed or removed.
 *   Any change to this file makes the browser install it as a new worker. That worker waits until
 *   the game is launched again (js/pwa.js sends SKIP_WAITING at launch, never during a game) and
 *   no page is ever reloaded for it.
 */
'use strict';

const VERSION = 'v1';

/* The app shell: same-origin URLs relative to this file. One entry per line, load order. */
const PRECACHE = [
  'index.html',
  'manifest.webmanifest',
  'css/base.css',
  'css/cards.css',
  'css/board.css',
  'css/ui.css',
  'css/inspector.css',
  'js/core/bus.js',
  'js/core/store.js',
  'js/core/platform.js',
  'js/core/rng.js',
  'js/core/engine.js',
  'js/core/solver.js',
  'js/view/anim.js',
  'js/view/fx.js',
  'js/view/audio.js',
  'js/view/cards.js',
  'js/view/board.js',
  'js/view/celebrate.js',
  'js/view/input.js',
  'js/view/inspector.js',
  'js/view/ui.js',
  'js/main.js',
  'js/pwa.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-192.png',
  'icons/icon-maskable-512.png',
];

/* The folder this file is served from, e.g. https://user.github.io/hero/solitaire/ */
const APP_ROOT = new URL('./', self.location.href).href;
const INDEX_URL = new URL('index.html', APP_ROOT).href;

/*
 * Cache Storage is shared by everything on the origin (on GitHub Pages: every project of the
 * account). The names carry this deployment's path and only names with that prefix are deleted.
 */
const CACHE_PREFIX = 'solitaire3d:' + new URL(APP_ROOT).pathname + ':';
const CACHE = CACHE_PREFIX + VERSION;

/** Only complete, same-origin, successful responses are stored (no 404 pages, no partial content). */
function cacheable(response) {
  return !!response && response.status === 200 && response.type === 'basic';
}

/**
 * A response that was reached through a redirect (some hosts redirect index.html to ./) may not
 * answer a navigation; a copy without the redirect flag may.
 */
function unredirected(response) {
  if (!response.redirected) return response;
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * The cache key of a request URL. The game is static files, so query strings and fragments are
 * dropped, and the app folder itself is index.html.
 */
function cacheKey(url) {
  const key = url.origin + url.pathname;
  return key === APP_ROOT ? INDEX_URL : key;
}

/** Fetches `key` and stores it. Never rejects: a failed refresh leaves the cached copy alone. */
function store(cache, key, cacheMode) {
  return fetch(key, { cache: cacheMode })
    .then((response) => (cacheable(response) ? cache.put(key, unredirected(response)) : undefined))
    .catch(() => undefined);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) =>
        // 'reload' bypasses the HTTP cache: a new worker must not precache stale copies.
        Promise.all(PRECACHE.map((path) => store(cache, new URL(path, APP_ROOT).href, 'reload')))
      )
      .catch(() => undefined) // Cache Storage refused: install anyway, as a pass-through
  );
});

/** Copies precache files the new cache lacks (they failed to download) from the old caches. */
async function keepFromOldCaches(oldNames) {
  const cache = await caches.open(CACHE);
  for (const path of PRECACHE) {
    const key = new URL(path, APP_ROOT).href;
    if (await cache.match(key)) continue;
    for (const name of oldNames) {
      const old = await (await caches.open(name)).match(key);
      if (old) {
        await cache.put(key, old);
        break;
      }
    }
  }
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const names = await caches.keys();
        const old = names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE);
        if (old.length) {
          await keepFromOldCaches(old);
          await Promise.all(old.map((name) => caches.delete(name)));
        }
      } catch (err) {
        /* Cache Storage refused (quota, private mode): the worker still works from the network. */
      }
      // Control the page that registered us without waiting for a reload, so the very first
      // visit already fills the cache and can go offline.
      await self.clients.claim();
    })()
  );
});

async function respond(event) {
  const request = event.request;
  const key = cacheKey(new URL(request.url));

  let cache;
  try {
    cache = await caches.open(CACHE);
  } catch (err) {
    return fetch(request); // Cache Storage refused: be a plain pass-through
  }

  const cached = await cache.match(key, { ignoreVary: true }).catch(() => undefined);
  if (cached) {
    // 'no-cache' makes the browser ask the server (a cheap 304 when nothing changed) instead of
    // trusting its HTTP cache, so the refreshed entry really is the deployed file.
    event.waitUntil(store(cache, key, 'no-cache'));
    return cached;
  }

  try {
    const response = await fetch(request);
    if (cacheable(response)) {
      const copy = unredirected(response.clone());
      event.waitUntil(cache.put(key, copy).catch(() => undefined));
    }
    return response;
  } catch (err) {
    if (request.mode === 'navigate') {
      const shell = await cache.match(INDEX_URL, { ignoreVary: true }).catch(() => undefined);
      if (shell) return shell;
    }
    throw err; // the page sees the same network error it would see without a service worker
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(respond(event));
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
