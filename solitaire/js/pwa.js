/*
 * SOL.PWA — makes the web game installable from the browser ("Add to Home screen" in Chrome on
 * Android) and playable offline. This is the second route onto a phone, next to the APK.
 *
 * It is active only when the page is served over http(s) outside the Android app. From file://
 * and inside the app (window.SolitaireNative, or the app's asset host) it touches nothing and
 * logs nothing; SOL.PWA still exists there with supported === false, so callers need no guards.
 *
 * When active it
 *   - adds <link rel="manifest">, the apple-touch-icon and the web-app meta tags to <head>. They
 *     are added from script and not written in index.html because a manifest link is an error on
 *     file:// and a 404 inside the APK, which ships neither the manifest nor sw.js;
 *   - registers ../sw.js once the window has loaded and the browser is idle (never in the way of
 *     the opening deal);
 *   - tracks whether the app can be installed or is installed.
 *
 * API
 *   SOL.PWA.supported         boolean, fixed at load: the page can be installed and run offline
 *                             here (http(s), not the Android app, service workers available).
 *   SOL.PWA.installed         boolean: the page runs as the installed app (its own window, no
 *                             browser UI) or was installed during this visit.
 *   SOL.PWA.canInstall        boolean: the browser offered installation, so promptInstall() will
 *                             show its install dialog. Browsers without that offer (iOS Safari,
 *                             Firefox) stay false: there the player installs from the browser menu.
 *   SOL.PWA.promptInstall()   -> Promise<boolean>: shows the install dialog; true when the player
 *                             accepted. Call it from a tap/click handler. Resolves false when
 *                             nothing can be shown; never rejects.
 *   SOL.PWA.onChange(fn)      -> off(): fn({ canInstall, installed }) whenever either changes.
 *
 * Event on SOL.Bus
 *   'pwa:change' { canInstall, installed }   at the same moments as onChange listeners.
 *
 * Updates never interrupt a game: a new service worker installs in the background and waits. It
 * takes over when the game is launched the next time, and the page is never reloaded for it.
 */
(function (root) {
  'use strict';

  const SOL = (root.SOL = root.SOL || {});
  const doc = root.document;
  const nav = root.navigator || {};
  const loc = root.location || {};

  const APP_ASSET_HOST = 'appassets.androidplatform.net'; // WebViewAssetLoader, see /android
  const inNativeApp = root.SolitaireNative != null || loc.hostname === APP_ASSET_HOST;
  const active = !!doc && !inNativeApp && (loc.protocol === 'http:' || loc.protocol === 'https:');
  // Service workers exist only in secure contexts (https, localhost).
  const supported = active && 'serviceWorker' in nav;

  // ---------------------------------------------------------------- install state
  let promptEvent = null; // the BeforeInstallPromptEvent the browser offered, until it is used
  let installedHere = false; // 'appinstalled' fired during this visit
  let last = { canInstall: false, installed: false };
  const listeners = new Set();

  // Display modes of a page that runs as an installed app. The manifest asks for fullscreen and
  // falls back to standalone; the others are what browsers may substitute.
  const APP_DISPLAY_MODES = ['fullscreen', 'standalone', 'minimal-ui', 'window-controls-overlay'];
  const modeQueries = [];

  function inAppWindow() {
    if (nav.standalone === true) return true; // iOS home-screen web app
    for (const entry of modeQueries) {
      if (!entry.query.matches) continue;
      // A browser tab made full screen through the Fullscreen API matches too; not an install.
      if (entry.mode === 'fullscreen' && doc.fullscreenElement) continue;
      return true;
    }
    return false;
  }

  function snapshot() {
    const canInstall = promptEvent !== null;
    // A browser that offers installation is not showing the installed app (this also covers a
    // desktop browser window switched to full screen, which matches display-mode: fullscreen).
    return { canInstall: canInstall, installed: installedHere || (!canInstall && inAppWindow()) };
  }

  /** Recomputes the state and notifies when it changed. */
  function update() {
    const next = snapshot();
    if (next.canInstall === last.canInstall && next.installed === last.installed) return;
    last = next;
    for (const fn of Array.from(listeners)) {
      try {
        fn({ canInstall: next.canInstall, installed: next.installed });
      } catch (err) {
        if (root.console) root.console.error('[SOL.PWA] change listener threw', err);
      }
    }
    if (SOL.Bus) SOL.Bus.emit('pwa:change', { canInstall: next.canInstall, installed: next.installed });
  }

  const PWA = {
    supported: supported,

    get installed() {
      return last.installed;
    },

    get canInstall() {
      return last.canInstall;
    },

    promptInstall() {
      const event = promptEvent;
      if (!event) return Promise.resolve(false);
      promptEvent = null; // an install offer can be shown once; the browser sends a new one
      update();
      return Promise.resolve()
        .then(() => event.prompt())
        // Current Chrome resolves prompt() with the choice; older versions only set userChoice.
        .then((choice) => (choice && choice.outcome ? choice : event.userChoice))
        .then((choice) => !!choice && choice.outcome === 'accepted')
        .catch(() => false);
    },

    onChange(fn) {
      if (typeof fn !== 'function') throw new TypeError('SOL.PWA.onChange: listener must be a function');
      listeners.add(fn);
      return function off() {
        listeners.delete(fn);
      };
    },
  };

  SOL.PWA = PWA;
  if (!active) return;

  // ---------------------------------------------------------------- <head>
  // This file is js/pwa.js, one level below the app folder. Resolving against the script, not
  // the page, keeps the URLs right for pages in sub-folders too.
  const script = doc.currentScript;
  const appRoot = script && script.src ? new URL('../', script.src).href : new URL('./', doc.baseURI).href;

  function addToHead(tag, attrs, existing) {
    if (!doc.head || doc.head.querySelector(existing)) return;
    const el = doc.createElement(tag);
    for (const name of Object.keys(attrs)) el.setAttribute(name, attrs[name]);
    doc.head.appendChild(el);
  }

  addToHead('link', { rel: 'manifest', href: appRoot + 'manifest.webmanifest' }, 'link[rel="manifest"]');
  // iOS ignores the manifest icons: it wants an opaque square and rounds the corners itself.
  addToHead(
    'link',
    { rel: 'apple-touch-icon', sizes: '180x180', href: appRoot + 'icons/apple-touch-icon.png' },
    'link[rel="apple-touch-icon"]'
  );
  const metas = {
    'application-name': 'Solitaire',
    'mobile-web-app-capable': 'yes',
    'apple-mobile-web-app-capable': 'yes', // iOS before 17.4 only knows this name
    'apple-mobile-web-app-title': 'Solitaire',
    // Draw under the status bar; the layout already keeps clear of it (the safe-area tokens in base.css).
    'apple-mobile-web-app-status-bar-style': 'black-translucent',
  };
  for (const name of Object.keys(metas)) {
    addToHead('meta', { name: name, content: metas[name] }, 'meta[name="' + name + '"]');
  }

  // ---------------------------------------------------------------- install offer
  root.addEventListener('beforeinstallprompt', function (event) {
    // Keep the browser's own install banner off the table; the game offers its own button.
    event.preventDefault();
    promptEvent = event;
    update();
  });

  root.addEventListener('appinstalled', function () {
    promptEvent = null;
    installedHere = true;
    update();
  });

  if (typeof root.matchMedia === 'function') {
    for (const mode of APP_DISPLAY_MODES) {
      const query = root.matchMedia('(display-mode: ' + mode + ')');
      modeQueries.push({ mode: mode, query: query });
      // Installing on desktop moves the tab into an app window: the display mode changes live.
      if (query.addEventListener) query.addEventListener('change', update);
      else if (query.addListener) query.addListener(update);
    }
    doc.addEventListener('fullscreenchange', update);
  }
  last = snapshot(); // the state at load is the baseline, not a change

  // ---------------------------------------------------------------- service worker
  if (!supported) return;

  function register() {
    let registering;
    try {
      registering = nav.serviceWorker.register(appRoot + 'sw.js', { scope: appRoot });
    } catch (err) {
      return; // blocked by the browser (e.g. a sandboxed frame): the game simply stays online-only
    }
    registering
      .then(function (registration) {
        // A worker version that finished installing during an earlier visit has been waiting for
        // a launch: this is one. A version found from now on waits for the next launch. Either
        // way the page is not reloaded, so a game in progress is never interrupted.
        if (registration.waiting) registration.waiting.postMessage({ type: 'SKIP_WAITING' });
      })
      .catch(function () {
        /* registration refused (private mode, storage disabled): online-only, nothing to report */
      });
  }

  function whenIdle() {
    if (typeof root.requestIdleCallback === 'function') root.requestIdleCallback(register, { timeout: 4000 });
    else root.setTimeout(register, 1);
  }

  if (doc.readyState === 'complete') whenIdle();
  else root.addEventListener('load', whenIdle, { once: true });
})(typeof window !== 'undefined' ? window : globalThis);
