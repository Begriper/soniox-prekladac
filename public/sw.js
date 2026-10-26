'use strict';
const CACHE = 'translator-shell-3.2.1';
const SHELL = [
  '/', '/index.html',
  '/style.css?v=3.2.1', '/app.js?v=3.2.1', '/history.js?v=3.2.1',
  '/audio-capture-worklet.js?v=3.2.1', '/manifest.webmanifest?v=3.2.1',
  '/icon.svg?v=3.2.1', '/icon-180.png?v=3.2.1', '/icon-192.png?v=3.2.1',
  '/icon-512.png?v=3.2.1', '/icon-maskable-512.png?v=3.2.1',
  '/fonts/Manrope-variable.ttf'
];
self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  await cache.addAll(SHELL);
  await self.skipWaiting();
})()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter(k => k.startsWith('translator-shell-') && k !== CACHE).map(k => caches.delete(k)));
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const navigation = event.request.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html');
  // Only public application assets. Never cache /api, text history or audio.
  if (!navigation && (!SHELL.includes(url.pathname + url.search) || url.pathname === '/' || url.pathname === '/index.html')) return;
  // A failed cache write (for example a full storage quota) must never discard a good network response.
  const store = (cache, key, response) => event.waitUntil(cache.put(key, response).catch(() => {}));
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (navigation) {
      let response;
      try { response = await fetch(event.request); }
      catch { return await cache.match('/index.html') || Response.error(); }
      if (!response.ok) return await cache.match('/index.html') || response;
      store(cache, '/index.html', response.clone());
      return response;
    }
    // Exact versioned URLs are immutable; never fall back to another cache or URL.
    const cached = await cache.match(event.request);
    if (cached) return cached;
    const response = await fetch(event.request);
    if (response.ok) store(cache, event.request, response.clone());
    return response;
  })());
});
