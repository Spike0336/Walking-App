const CACHE_NAME = 'walkingpad-v4';
const ASSETS = [
  './index.html',
  './dashboard.html',
  './app.js',
  './protocol.js',
  './programmes.js',
  './manifest.webmanifest',
  './icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

// Network-first for the app shell, falling back to cache when offline.
// (Cache-first was the earlier approach, but it meant an updated app.js
// could sit unused on your phone until the cache name itself changed --
// this way a normal reload always picks up whatever's actually deployed,
// and you only ever fall back to the cached copy with no signal at all.)
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
