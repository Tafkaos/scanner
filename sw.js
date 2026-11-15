/* Offline-Cache: App-Dateien und OpenCV werden lokal vorgehalten. Dropbox-Anfragen (andere Hosts) bleiben unberührt. */
const CACHE = 'scanner-v1';
const FILES = ['./', 'index.html', 'app.js', 'scanner-core.js', 'opencv.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.endsWith('opencv.js')) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
    return;
  }
  // übrige Dateien: erst Netz (damit Updates ankommen), sonst Cache
  e.respondWith(
    fetch(req).then((res) => {
      const copy = res.clone();
      if (res.ok) caches.open(CACHE).then((c) => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('index.html')))
  );
});
