// Простий service worker: оболонка додатку з кешу, щоб відкривався миттєво.
// Дані завжди беруться з мережі (Supabase).
const CACHE = 'moi-liky-v10';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'config.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// ---- сповіщення ----
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Мої ліки', {
    body: d.body || '', tag: d.tag || 'moi-liky', renotify: true,
    icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { url: d.url || './' }
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || './', self.registration.scope).href;
  e.waitUntil((async () => {
    // запамʼятати, що треба відкрити (додаток перевірить це, коли стане видимим)
    try { const c = await caches.open('moi-liky-pending'); await c.put('pending-quick', new Response(url)); } catch (_) {}
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of cs) c.postMessage({ type: 'open-quick', url });
    // iOS надійніше відкриває додаток через openWindow, ніж через focus()
    try { const w = await self.clients.openWindow(url); if (w) return; } catch (_) {}
    for (const c of cs) { try { await c.focus(); return; } catch (_) {} }
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // stale-while-revalidate для файлів додатку
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const hit = await c.match(e.request);
    const net = fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});
