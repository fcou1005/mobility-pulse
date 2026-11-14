// @ts-nocheck – Service-Worker-Typen (ExtendableEvent, FetchEvent) fehlen in der DOM-Bibliothek der Typprüfung
// Mobility Pulse – Service Worker des Fahrermodus (S6.2): hält fahrer.html und ihre Dateien, damit eine einmal geöffnete Tour im Flugmodus
// weiterläuft. Gilt nur für fahrer.html (Scope beim Registrieren), die übrige Seite bleibt ohne Service Worker. Kartenkacheln werden nicht gehalten.
const V = 'mp-fahrer-mwg4pgt3';
const CORE = ['fahrer.html', 'fahrer.js', 'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css', 'vendor/fonts.css', 'vendor/fonts/ibm-plex-sans-latin-400-normal.woff2', 'vendor/fonts/ibm-plex-sans-latin-500-normal.woff2', 'vendor/fonts/ibm-plex-sans-latin-600-normal.woff2', 'vendor/fonts/ibm-plex-mono-latin-400-normal.woff2', 'vendor/fonts/ibm-plex-mono-latin-500-normal.woff2'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(V).then(c => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('mp-fahrer-') && k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== self.location.origin) return; // Kacheln und Navi-Links gehen direkt ins Netz
  if (e.request.mode === 'navigate') { // Seite: erst Netz (neue Fassung), sonst aus dem Speicher
    e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(V).then(x => x.put('fahrer.html', c)); return r; }).catch(() => caches.match('fahrer.html')));
    return;
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request).then(r => { if (r.ok) { const c = r.clone(); caches.open(V).then(x => x.put(e.request, c)); } return r; })));
});
