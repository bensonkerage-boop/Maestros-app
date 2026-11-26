/* MASMS service worker (online-first, fast).
   - The app shell (page + hashed scripts/styles) is precached, so repeat opens are instant even on a slow or flaky connection.
   - The page is always asked from the live site first (a new deploy is picked up at once); if the network is slower than NAV_WAIT_MS
     the cached copy opens right away while the fresh one finishes downloading for next time.
   - /assets/*, /vendor/*, /icons/* are content-hashed or versioned: cache first.
   - The API and /version.json are never cached. A new build = a new sw.js (build id changes); scripts/app-update.js then reloads
     the app by itself when nobody is typing. */
const VERSION = '__BUILD_ID__';
const CACHE = 'masms-' + VERSION;
const SHELL = __PRECACHE__;
const NAV_WAIT_MS = 3500;
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => {})))));
});
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('masms-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
));
function navigate(e) {
  const net = fetch(e.request).then(r => { if (r && r.ok) { const c = r.clone(); caches.open(CACHE).then(x => x.put('/', c)); } return r; });
  e.waitUntil(net.catch(() => {}));
  return caches.match('/').then(cached => {
    if (!cached) return net.catch(() => caches.match('/offline.html'));
    return Promise.race([net.catch(() => cached), new Promise(res => setTimeout(() => res(cached), NAV_WAIT_MS))]);
  });
}
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url), p = url.pathname;
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (p.startsWith('/api/') || p === '/version.json' || p === '/sw.js') return;
  if (req.mode === 'navigate') {
    if (p !== '/' && p !== '/index.html') return;   // e.g. /landing.html: leave to the browser
    e.respondWith(navigate(e));
    return;
  }
  if (/^\/(assets|vendor|icons)\//.test(p)) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => { if (r.ok) { const c = r.clone(); caches.open(CACHE).then(x => x.put(req, c)); } return r; })));
    return;
  }
  e.respondWith(fetch(req).then(r => { if (r.ok) { const c = r.clone(); caches.open(CACHE).then(x => x.put(req, c)); } return r; }).catch(() => caches.match(req)));
});
