/* Railnav — Service Worker
 *
 * Ziel: Die App startet auch ohne Netz, und bereits angesehene Kartenkacheln
 * bleiben sichtbar. Für alles Eigene gilt "erst Netz, dann Cache", damit eine
 * neue Version sofort ankommt statt hinter einem alten Cache zu hängen.
 */

const VERSION = 'v14';
const SHELL = `railnav-shell-${VERSION}`;
const TILES = `railnav-tiles-${VERSION}`;
const DATA = `railnav-data-${VERSION}`;
const NETZ = `railnav-netz-${VERSION}`;
const KEEP = [SHELL, TILES, DATA, NETZ];

const SHELL_FILES = [
  './', 'index.html', 'style.css', 'app.js',
  'vendor/leaflet.js', 'vendor/leaflet.css', 'vendor/leaflet-rotate.js',
  'manifest.webmanifest', 'icon.svg'
];

const TILE_HOSTS = ['tile.openstreetmap.org', 'tiles.openrailwaymap.org', 'server.arcgisonline.com',
  'geoservices.bayern.de'];
const MAX_TILES = 600;

/* Die Netzkacheln unter netz/ ändern sich nur, wenn werkzeug/netz-bauen.py neu
 * läuft — und dann wird hier ohnehin VERSION hochgezählt. Deshalb "erst Cache":
 * Für die übrigen eigenen Dateien gilt bewusst das Gegenteil, aber bei 300
 * Kacheln wäre eine Netzabfrage je Kachel nur Wartezeit ohne Gewinn. */
const MAX_NETZ = 500;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // Einzeln ablegen: eine fehlende Datei soll nicht die ganze Installation kippen
    await Promise.allSettled(SHELL_FILES.map(f => cache.add(f)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n.startsWith('railnav-') && !KEEP.includes(n)).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= max) return;
  await Promise.all(keys.slice(0, keys.length - max).map(k => cache.delete(k)));
}

async function networkFirst(request, cacheName, frisch) {
  const cache = await caches.open(cacheName);
  try {
    /* Eigene Dateien bewusst ohne HTTP-Cache holen. GitHub Pages setzt
     * Cache-Control max-age=600, dadurch kam eine neue Fassung auf dem Gerät bis
     * zu zehn Minuten später an — beim Entfernen der Zoomknöpfe fiel genau das
     * auf. Der Cache hier bleibt davon unberührt und dient weiter als
     * Offlinevorrat. */
    const res = frisch && request.method === 'GET'
      ? await fetch(request.url, { cache: 'reload', credentials: 'same-origin' })
      : await fetch(request);
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(request);
    if (hit) return hit;
    if (request.mode === 'navigate') {
      const shell = await caches.open(SHELL);
      const page = await shell.match('index.html') || await shell.match('./');
      if (page) return page;
    }
    throw err;
  }
}

async function cacheFirst(request, cacheName, max) {
  try {
    const cache = await caches.open(cacheName);
    const hit = await cache.match(request);
    if (hit) return hit;
    const res = await fetch(request);
    // Kacheln kommen ohne CORS zurück (opaque) — trotzdem brauchbar für <img>
    if (res && (res.ok || res.type === 'opaque')) {
      cache.put(request, res.clone());
      trim(cacheName, max);
    }
    return res;
  } catch (err) {
    /* Scheitert irgendein Schritt des Zwischenspeichers, darf das die Kachel
     * nicht kosten: dann eben unverändert durchreichen. */
    return fetch(request);
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch { return; }
  if (!/^https?:$/.test(url.protocol)) return;

  if (url.origin === self.location.origin) {
    event.respondWith(url.pathname.includes('/netz/')
      ? cacheFirst(request, NETZ, MAX_NETZ)
      : networkFirst(request, SHELL, true));
  } else if (TILE_HOSTS.some(h => url.hostname === h || url.hostname.endsWith('.' + h))) {
    event.respondWith(cacheFirst(request, TILES, MAX_TILES));
  } else if (url.hostname === 'api.openrailwaymap.org') {
    event.respondWith(networkFirst(request, DATA, false));
  }
});
