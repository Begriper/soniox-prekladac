'use strict';
const CACHE = 'translator-shell-v3-2';
const SHELL = ['/', '/index.html', '/style.css', '/app.js', '/history.js', '/audio-capture-worklet.js', '/manifest.webmanifest', '/icon.svg', '/icon-180.png', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/fonts/Manrope-variable.ttf'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('translator-shell-') && k !== CACHE).map(k => caches.delete(k))))));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !SHELL.includes(url.pathname)) return;
  // Only public application assets. Never cache /api, text history or audio.
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) { const copy = response.clone(); event.waitUntil(caches.open(CACHE).then(c => c.put(event.request, copy))); }
    return response;
  }).catch(() => caches.match(event.request)));
});
