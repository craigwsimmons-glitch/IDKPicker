const CACHE = 'idkpicker-v4';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
];

// Install — cache core assets
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — network first for API calls, cache first for assets
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never cache API calls or the admin page
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin')) {
    return; // let the browser handle it normally
  }

  // Network first for the page itself, so site updates show up right away
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then(response => {
        if (response.ok && (url.pathname === '/' || url.pathname === '/index.html')) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put('/index.html', copy));
        }
        return response;
      }).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Cache first for static assets
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, copy));
        }
        return response;
      }).catch(() => caches.match('/index.html'));
    })
  );
});
