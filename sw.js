/* OpenScene service worker — makes the editor installable and fully offline.

   Scope: the app shell only. Project files and imported media never go through
   here; they live in IndexedDB / the File System Access API, so nothing large is
   ever duplicated into the HTTP cache.

   Strategy: network-first for same-origin shell assets, with the cache as the
   offline fallback. The cache exists so the editor works with no connection; it
   must never be allowed to shadow a newer file that is actually reachable.
   A cache-first shell means every edit to any file in CORE silently ships the
   previous version until someone remembers to bump VERSION, which is a bug
   waiting to bite on any release. Network-first removes that failure mode
   entirely: online users always get the current build, offline users get the
   last good one. Blob:/data: requests are passed straight through. */

/* Bump this on every release that changes any file listed in CORE, otherwise
   installed copies keep serving the previous version from cache indefinitely.
   v4: added js/customtrans.js and js/workspaces.js; transitions.js now exports
   its renderer table (FAMILY) so custom transitions can register into it. */
const VERSION = 'openscene-shell-v4';

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
  'js/customtrans.js',
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
  'js/workspaces.js',
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
    // One bad entry must not abort the whole install. `cache: 'reload'` bypasses
    // the HTTP disk cache so the shell is snapshotted from the server, not from a
    // possibly-stale local copy.
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
        /* 'no-cache' forces a revalidation with the server. Without it a reload
           can be answered from the HTTP disk cache and the document loads an
           out-of-date index.html that references an older shell. */
        return await fetch(req, { cache: 'no-cache' });
      } catch (_) {
        const cache = await caches.open(VERSION);
        return (await cache.match('index.html')) || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    try {
      /* no-cache revalidates with the server instead of trusting the HTTP disk
         cache, so a file edited on disk is picked up immediately. */
      const res = await fetch(req, { cache: 'no-cache' });
      if (res && (res.ok || res.type === 'opaque') && res.status !== 206) {
        cache.put(req, res.clone()).catch(() => {});
      }
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: false });
      if (hit) return hit;
      const loose = await cache.match(req, { ignoreSearch: true });
      if (loose) return loose;
      throw err;
    }
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'openscene:skip-waiting') self.skipWaiting();
});
