/* OpenScene service worker — makes the editor installable and fully offline.

   Scope: the app shell only. Project files and imported media never go through
   here; they live in IndexedDB / the File System Access API, so nothing large is
   ever duplicated into the HTTP cache.

   Strategy: cache-first for same-origin shell assets (they are versioned by this
   cache name), network-first for navigations with an offline fallback to the
   cached document. Blob:/data: requests are passed straight through. */

const VERSION = 'openscene-shell-v3';

const CORE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'css/mobile.css',
  'js/util.js',
  'js/timebase.js',
  'js/model.js',
  'js/commands.js',
  'js/effects.js',
  'js/transitions.js',
  'js/titles.js',
  'js/renderer.js',
  'js/media.js',
  'js/player.js',
  'js/wav.js',
  'js/mp4muxer.js',
  'js/export.js',
  'js/zip.js',
  'js/timeline.js',
  'js/library.js',
  'js/bin.js',
  'js/properties.js',
  'js/scopes.js',
  'js/mobile.js',
  'js/dialogs.js',
  'js/shortcuts.js',
  'js/persist.js',
  'js/selftest.js',
  'js/app.js',
  'icons/icon.svg',
  'icons/favicon-16.png',
  'icons/favicon-32.png',
  'icons/apple-touch-icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'resources/logo.svg',
  'resources/logo-wordmark.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // One bad entry must not abort the whole install.
    await Promise.all(CORE.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.disable(); } catch (_) { /* optional */ }
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  // blob: (imported media, exports) and data: are none of our business
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(req);
      } catch (_) {
        const cache = await caches.open(VERSION);
        return (await cache.match('index.html')) || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req, { ignoreSearch: false });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res && (res.ok || res.type === 'opaque') && res.status !== 206) {
        cache.put(req, res.clone()).catch(() => {});
      }
      return res;
    } catch (err) {
      const fallback = await cache.match(req, { ignoreSearch: true });
      if (fallback) return fallback;
      throw err;
    }
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'openscene:skip-waiting') self.skipWaiting();
});
