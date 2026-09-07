/* InnPass · service worker
   Precachea la app (index, css, js, catálogo, QR lib, iconos) para que funcione
   offline una vez abierta. Estrategia: red primero con tiempo límite y, si no
   hay red (o tarda), la copia en caché. Así en desarrollo siempre ves la última
   versión y en la farmacia sin cobertura la app sigue abriendo.
   Sube CACHE_VERSION cuando cambies ficheros para limpiar cachés antiguas. */

const CACHE_VERSION = 'innpass-v1';
const NETWORK_TIMEOUT_MS = 3000;
const PRECACHE = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './drugs.json',
  './manifest.webmanifest',
  './vendor/qrcode.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // p. ej. API QR de respaldo: red directa

  // Navegaciones (con o sin #hash) se guardan bajo la clave del index.
  const cacheKey = req.mode === 'navigate' ? new Request('./index.html') : req;
  event.respondWith(networkFirst(cacheKey, req));
});

function fetchWithTimeout(req, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(req).then((res) => { clearTimeout(timer); resolve(res); }, (err) => { clearTimeout(timer); reject(err); });
  });
}

async function networkFirst(cacheKey, networkReq) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const fresh = await fetchWithTimeout(networkReq, NETWORK_TIMEOUT_MS);
    if (fresh && fresh.ok) cache.put(cacheKey, fresh.clone());
    return fresh;
  } catch {
    const cached = await cache.match(cacheKey, { ignoreSearch: true });
    if (cached) return cached;
    return new Response('Sin conexión y sin copia en caché.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}
