// Hasr service worker: offline app shell, cached AI models/runtime, and the cross-origin
// isolation headers (COOP/COEP) that GitHub Pages cannot send, so the AI engine can use all CPU cores.
const VERSION = 'hasr-1.0.1';
const SHELL_CACHE = 'hasr-shell-' + VERSION;
const ASSET_CACHE = 'hasr-assets-v1'; // models and runtime: large, versioned by file name
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'files.json', 'css/app.css',
  'js/app.js', 'js/i18n.js', 'js/store.js', 'js/sources.js', 'js/detector.js', 'js/overlay.js', 'js/pipeline.js',
  'js/session.js', 'js/report.js', 'js/guide.js',
  'js/engine/tracker.js', 'js/engine/counter.js', 'js/engine/kalman.js', 'js/engine/hungarian.js',
  'fonts/readex-pro-arabic-400-normal.woff2', 'fonts/readex-pro-arabic-500-normal.woff2', 'fonts/readex-pro-arabic-700-normal.woff2',
  'fonts/readex-pro-latin-400-normal.woff2', 'fonts/readex-pro-latin-500-normal.woff2', 'fonts/readex-pro-latin-700-normal.woff2',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-180.png',
];
const BIG = /\/(models\/[^/]+|vendor\/ort\/[^/]+)$/;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('hasr-shell-') && k !== SHELL_CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

function isolate(res) {
  if (!res || res.status === 0 || res.type === 'opaque' || res.type === 'opaqueredirect') return res;
  const h = new Headers(res.headers);
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.headers.has('range')) return; // media range requests go straight to the network

  if (req.mode === 'navigate') {
    // network first so updates arrive, cached shell when offline
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) { const c = await caches.open(SHELL_CACHE); c.put('index.html', res.clone()); }
        return isolate(res);
      } catch {
        const c = await caches.open(SHELL_CACHE);
        return isolate((await c.match('index.html')) || (await c.match('./')));
      }
    })());
    return;
  }

  if (BIG.test(url.pathname)) {
    // models and the AI runtime: cache first (they are large and change only with a new file name)
    e.respondWith((async () => {
      const c = await caches.open(ASSET_CACHE);
      const hit = await c.match(req, { ignoreSearch: true });
      if (hit) return isolate(hit);
      const res = await fetch(req);
      if (res.ok) await c.put(req, res.clone());
      return isolate(res);
    })());
    return;
  }

  // app shell: serve from cache, refresh in the background
  e.respondWith((async () => {
    const c = await caches.open(SHELL_CACHE);
    const hit = await c.match(req, { ignoreSearch: true });
    const net = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => null);
    if (hit) { e.waitUntil(net); return isolate(hit); }
    const res = await net;
    return res ? isolate(res) : new Response('offline', { status: 503 });
  })());
});
