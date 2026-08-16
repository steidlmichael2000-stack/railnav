/* Railnav — Streckenkilometer verorten
 *
 * Datenquelle: OpenRailwayMap-API v2 (/milestone, /facility). Die API liefert
 * die in OpenStreetMap erfassten Kilometersteine einer Strecke im Umkreis von
 * maximal 10 km um die angefragte Position — sortiert nach Abstand zur Anfrage.
 * Daraus wird hier interpoliert, statt nur den nächstgelegenen Stein zu zeigen.
 */

'use strict';

const API = 'https://api.openrailwaymap.org/v2';
const MAX_ENTRIES = 50;      // Obergrenze pro Durchlauf, damit die API nicht geflutet wird
const MAX_GAP_KM = 3;        // größere Lücken zwischen zwei Steinen werden nicht interpoliert
const CONCURRENCY = 3;       // parallele Abfragen
const LIMIT = 200;           // Maximum der API je Abfrage
const STORE_KEY = 'railnav.v2';

/* ============================ Kleine Helfer ============================ */

const $ = sel => document.querySelector(sel);
const nfKm = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 3 });
const nfM = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });

const fmtKm = v => nfKm.format(v);
const fmtCoord = (lat, lon) => `${lat.toFixed(6)}, ${lon.toFixed(6)}`;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function haversine(aLat, aLon, bLat, bLon) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad, dLon = (bLon - aLon) * rad;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const gmapsUrl = (lat, lon) => `https://www.google.com/maps?q=${lat.toFixed(6)},${lon.toFixed(6)}`;
const gmapsRoute = (lat, lon) => `https://www.google.com/maps/dir/?api=1&destination=${lat.toFixed(6)},${lon.toFixed(6)}`;
const ormUrl = (lat, lon) => `https://www.openrailwaymap.org/?style=standard&lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}&zoom=17`;

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback für Browser ohne Clipboard-API bzw. ohne HTTPS
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

function download(name, mime, text) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ============================ Eingabe-Parser ============================ */

const NUM = String.raw`\d+(?:\+\d{1,3}|[.,]\d+)?`;
const LINE_RE = new RegExp(
  '^\\s*' +
  // Streckennummer nur, wenn danach noch ein Kilometerwert folgt und das Token eine Ziffer enthält
  '(?:(?<ref>(?=[A-Za-z0-9._-]*\\d)[A-Za-z0-9][A-Za-z0-9._-]{1,9})[\\s;/]+)?' +
  '(?<km1>-?' + NUM + ')' +
  '(?:\\s*(?:\\.{2,3}|--|[-–—]|bis)\\s*(?<km2>' + NUM + '))?' +
  '\\s*(?<rest>.*)$', 'i');

// Füllwörter, die eine Zeile lesbarer machen, für die Auswertung aber egal sind
const NOISE_RE = /\b(?:strecke|str|vzg|nr|km|bei|abschnitt|kilometer)\.?\b/gi;

/** "12+250" → 12.25, "12,5" → 12.5 */
function toKm(token) {
  const hm = /^(-?)(\d+)\+(\d{1,3})$/.exec(token.trim());
  if (hm) {
    const frac = parseInt(hm[3].padEnd(3, '0'), 10) / 1000;
    return (hm[1] === '-' ? -1 : 1) * (parseInt(hm[2], 10) + frac);
  }
  return parseFloat(token.trim().replace(',', '.'));
}

/** Eine Zeile → Eintrag oder null (Kommentar/leer) bzw. Eintrag mit .error */
function parseLine(raw, defaultRef, index) {
  const line = raw.trim();
  if (!line || line.startsWith('#') || line.startsWith('//')) return null;

  const base = { index, raw: line, label: '', status: 'pending' };

  // Betriebsstelle: @Name, @DS100 oder @UIC
  if (line.startsWith('@')) {
    const q = line.slice(1).trim();
    if (!q) return { ...base, kind: 'error', error: 'Nach dem @ fehlt der Suchbegriff.' };
    return { ...base, kind: 'facility', query: q };
  }

  // Eigene Bezeichnung nach dem senkrechten Strich
  let expr = line, label = '';
  const bar = line.indexOf('|');
  if (bar >= 0) {
    expr = line.slice(0, bar);
    label = line.slice(bar + 1).trim();
  }

  // "5100, 12,5" — Komma mit folgendem Leerzeichen trennt, Komma zwischen Ziffern ist Dezimalzeichen
  expr = expr.replace(/,(\s)/g, '$1').trim();

  let m = LINE_RE.exec(expr);
  let cleaned = false;
  if (!m) {
    m = LINE_RE.exec(expr.replace(NOISE_RE, ' ').replace(/\s+/g, ' ').trim());
    cleaned = true;
  }
  if (!m) {
    return { ...base, kind: 'error', label, error: 'Zeile nicht verstanden. Erwartet wird z. B. „5100 12,5" oder „12,5".' };
  }

  const ref = (m.groups.ref || defaultRef || '').trim();
  const km1 = toKm(m.groups.km1);
  const km2 = m.groups.km2 != null ? toKm(m.groups.km2) : null;

  // Ein Rest ohne senkrechten Strich gilt als Bezeichnung — nur wenn die Zeile roh gelesen wurde,
  // sonst hätten die entfernten Füllwörter den Text verstümmelt.
  if (!label && !cleaned) label = (m.groups.rest || '').replace(/^[\s,;:/–—-]+/, '').trim();

  if (!ref) {
    return { ...base, kind: 'error', label, error: 'Keine Streckennummer — oben eintragen oder in die Zeile schreiben („5100 12,5").' };
  }
  if (!isFinite(km1) || (km2 != null && !isFinite(km2))) {
    return { ...base, kind: 'error', label, error: 'Kilometerwert nicht lesbar.' };
  }

  const entry = km2 != null
    ? { ...base, kind: 'range', ref, from: Math.min(km1, km2), to: Math.max(km1, km2), label }
    : { ...base, kind: 'point', ref, km: km1, label };

  // Plausibilitätshinweis: keine deutsche Strecke ist vierstellig lang
  if (km1 > 1000) entry.warnInput = `km ${fmtKm(km1)} wirkt eher wie eine Streckennummer.`;
  return entry;
}

function parseAll(text, defaultRef) {
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const e = parseLine(line, defaultRef, out.length + 1);
    if (e) out.push(e);
  });
  return out;
}

/* ============================ API-Zugriff ============================ */

async function tryFetch(url, timeout) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Direktabruf; nur falls der blockiert wird, einmalig über einen öffentlichen CORS-Proxy. */
async function getJson(url) {
  try {
    return await tryFetch(url, 15000);
  } catch (err) {
    try {
      return await tryFetch('https://api.allorigins.win/raw?url=' + encodeURIComponent(url), 20000);
    } catch {
      throw new Error(err.name === 'AbortError' ? 'Zeitüberschreitung' : err.message || 'Netzwerkfehler');
    }
  }
}

/* Pro Strecke werden alle bereits geladenen Steine gesammelt, damit mehrere
 * Kilometerangaben derselben Strecke nur eine Abfrage kosten. */
const lineCache = new Map();

function bracketOf(sorted, km) {
  let lower = null, upper = null, exact = null;
  for (const p of sorted) {
    if (Math.abs(p.km - km) < 5e-4) { exact = p; break; }
    if (p.km < km) lower = p;
    else if (upper === null) { upper = p; break; }
  }
  return { lower, upper, exact };
}

/** Liegt der Kilometer auf oder zwischen zwei nah beieinander liegenden Steinen? */
function hasBracket(sorted, km) {
  const b = bracketOf(sorted, km);
  return !!(b.exact || (b.lower && b.upper && b.upper.km - b.lower.km <= MAX_GAP_KM));
}

/** Eine Abfrage an die API, Ergebnis in den Streckenspeicher mischen. */
async function probe(ref, e, km) {
  const url = `${API}/milestone?ref=${encodeURIComponent(ref)}&position=${km}&limit=${LIMIT}`;
  const data = await getJson(url);
  // Erst nach erfolgreicher Antwort merken — sonst würde ein Netzfehler die
  // Strecke dauerhaft als „schon abgefragt" markieren.
  e.probes.push(km);
  e.lastCount = Array.isArray(data) ? data.length : 0;
  if (Array.isArray(data)) {
    for (const d of data) {
      if (typeof d.latitude !== 'number' || typeof d.longitude !== 'number' || d.position == null) continue;
      e.pts.set(d.osm_id, {
        id: d.osm_id, km: Number(d.position),
        lat: d.latitude, lon: d.longitude,
        operator: d.operator || '', ref: d.ref || ref
      });
    }
    e.sorted = [...e.pts.values()].sort((a, b2) => a.km - b2.km);
  }
}

async function coverage(ref, km) {
  let e = lineCache.get(ref);
  if (!e) { e = { pts: new Map(), sorted: [], probes: [], lastCount: 0 }; lineCache.set(ref, e); }

  const probedHere = e.probes.some(p => Math.abs(p - km) < 0.75);
  if (hasBracket(e.sorted, km) || probedHere) return e;

  await probe(ref, e, km);

  // Die API antwortet im festen Umkreis von 10 km, unsortiert und höchstens
  // LIMIT Einträge lang. Auf dicht erfassten Strecken (Steine alle 100 m) kann
  // der passende Nachbar deshalb abgeschnitten sein — dann das Fenster
  // verschieben und noch einmal nachfragen.
  if (e.lastCount >= LIMIT && !hasBracket(e.sorted, km)) {
    for (const shift of [-6, 6]) {
      if (e.probes.some(p => Math.abs(p - (km + shift)) < 0.75)) continue;
      await probe(ref, e, km + shift);
      if (hasBracket(e.sorted, km)) break;
    }
  }

  return e;
}

/* ============================ Auflösung ============================ */

async function resolvePoint(ref, km) {
  const e = await coverage(ref, km);
  if (!e.sorted.length) {
    throw new Error(`Für Strecke ${ref} sind keine Kilometersteine erfasst — Nummer prüfen.`);
  }

  const { lower, upper, exact } = bracketOf(e.sorted, km);

  if (exact) {
    return {
      lat: exact.lat, lon: exact.lon, quality: 'exakt', delta: 0,
      operator: exact.operator, lineRef: exact.ref
    };
  }

  if (lower && upper) {
    const span = upper.km - lower.km;
    if (span > 0 && span <= MAX_GAP_KM) {
      const t = (km - lower.km) / span;
      const lat = lower.lat + t * (upper.lat - lower.lat);
      const lon = lower.lon + t * (upper.lon - lower.lon);
      const geo = haversine(lower.lat, lower.lon, upper.lat, upper.lon);
      return {
        lat, lon, quality: 'interpoliert', delta: 0,
        between: [lower.km, upper.km],
        spanRatio: geo / (span * 1000),
        operator: lower.operator || upper.operator,
        lineRef: lower.ref || upper.ref
      };
    }
  }

  // Kein brauchbares Paar: nächstgelegener erfasster Stein, Abweichung wird ausgewiesen
  const near = e.sorted.reduce((a, b2) => Math.abs(b2.km - km) < Math.abs(a.km - km) ? b2 : a);
  return {
    lat: near.lat, lon: near.lon, quality: 'naechster', delta: near.km - km,
    nearKm: near.km, operator: near.operator, lineRef: near.ref
  };
}

async function resolveRange(ref, from, to) {
  // Die API deckt je Abfrage ±10 km ab — längere Abschnitte in Schritten anfragen
  for (let p = from; p < to; p += 12) await coverage(ref, p);
  await coverage(ref, to);

  const start = await resolvePoint(ref, from);
  const end = await resolvePoint(ref, to);
  const e = lineCache.get(ref);
  const mid = e.sorted.filter(p => p.km > from && p.km < to);

  const path = [[start.lat, start.lon], ...mid.map(p => [p.lat, p.lon]), [end.lat, end.lon]];
  let len = 0;
  for (let i = 1; i < path.length; i++) {
    len += haversine(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
  }

  return { start, end, path, len, steps: mid.length, operator: start.operator || end.operator };
}

async function resolveFacility(query) {
  const data = await getJson(`${API}/facility?q=${encodeURIComponent(query)}&limit=8`);
  if (!Array.isArray(data) || !data.length) {
    throw new Error(`Keine Betriebsstelle zu „${query}" gefunden.`);
  }
  const sorted = [...data].sort((a, b) => (b.rank || 0) - (a.rank || 0));
  const best = sorted.find(d => typeof d.latitude === 'number');
  if (!best) throw new Error(`Treffer zu „${query}" ohne Koordinaten.`);
  return {
    lat: best.latitude, lon: best.longitude,
    name: best.name || best.short_name || query,
    kind: best.railway || '',
    ds100: best['railway:ref'] || '',
    uic: best.uic_ref || '',
    operator: best.operator || '',
    others: sorted.length - 1
  };
}

/* ============================ Zustand ============================ */

const state = {
  items: [],
  activeId: null,
  fitted: false,
  running: false
};

function statusOf(item) {
  if (item.kind === 'error' || item.error) return 'bad';
  if (!item.result) return 'pending';
  const r = item.result;
  if (item.kind === 'facility') return 'ok';
  const d = Math.abs(item.kind === 'range' ? Math.max(Math.abs(r.start.delta || 0), Math.abs(r.end.delta || 0)) : (r.delta || 0));
  if (d <= 0.15) return 'ok';
  if (d <= 1) return 'warn';
  return 'bad';
}

function pointsOf(item) {
  const r = item.result;
  if (!r) return [];
  if (item.kind === 'range') return [{ lat: r.start.lat, lon: r.start.lon }, { lat: r.end.lat, lon: r.end.lon }];
  return [{ lat: r.lat, lon: r.lon }];
}

function titleOf(item) {
  if (item.kind === 'facility') return item.result ? item.result.name : item.query;
  if (item.kind === 'range') return `Strecke ${item.ref} · km ${fmtKm(item.from)} – ${fmtKm(item.to)}`;
  if (item.kind === 'point') return `Strecke ${item.ref} · km ${fmtKm(item.km)}`;
  return item.raw;
}

/* ============================ Karte ============================ */

let map, baseOsm, baseSat, ormLayer, itemLayer, meLayer;
const markers = new Map();   // item.index → Leaflet-Marker

function initMap() {
  map = L.map('map', { zoomControl: true, attributionControl: true })
    .setView([51.1, 10.3], 5);

  baseOsm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  });
  baseSat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, maxNativeZoom: 18, attribution: 'Luftbild: Esri, Maxar, Earthstar Geographics'
  });
  ormLayer = L.tileLayer('https://{s}.tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png', {
    subdomains: 'abc', maxZoom: 19, maxNativeZoom: 19, opacity: 0.85,
    attribution: 'Bahn: <a href="https://www.openrailwaymap.org/">OpenRailwayMap</a> (CC-BY-SA 2.0)'
  });

  baseOsm.addTo(map);
  itemLayer = L.layerGroup().addTo(map);
  meLayer = L.layerGroup().addTo(map);
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);

  if (prefs.orm !== false) ormLayer.addTo(map);
  if (prefs.base === 'sat') setBase('sat');
  syncMapButtons();
}

function setBase(which) {
  prefs.base = which;
  const on = which === 'sat' ? baseSat : baseOsm;
  const off = which === 'sat' ? baseOsm : baseSat;
  if (map.hasLayer(off)) map.removeLayer(off);
  if (!map.hasLayer(on)) on.addTo(map);
  // Bahn-Layer immer oben halten
  if (map.hasLayer(ormLayer)) ormLayer.bringToFront();
  savePrefs();
  syncMapButtons();
}

function toggleOrm() {
  if (map.hasLayer(ormLayer)) { map.removeLayer(ormLayer); prefs.orm = false; }
  else { ormLayer.addTo(map); ormLayer.bringToFront(); prefs.orm = true; }
  savePrefs();
  syncMapButtons();
}

function syncMapButtons() {
  document.querySelectorAll('[data-base]').forEach(b =>
    b.classList.toggle('is-on', b.dataset.base === (prefs.base || 'osm')));
  $('#ormBtn').classList.toggle('is-on', !!map && map.hasLayer(ormLayer));
  $('.map-panel').classList.toggle('is-big', !!prefs.big);
  $('#bigBtn').classList.toggle('is-on', !!prefs.big);
}

function pinIcon(n, status, kind) {
  const cls = ['pin', status, kind === 'facility' ? 'facility' : ''].filter(Boolean).join(' ');
  return L.divIcon({
    className: '', html: `<div class="${cls}"><span>${n}</span></div>`,
    iconSize: [28, 28], iconAnchor: [14, 26], popupAnchor: [0, -24]
  });
}

function popupHtml(item, lat, lon, heading) {
  return `<b>${esc(heading)}</b>` +
    (item.label ? `<div>${esc(item.label)}</div>` : '') +
    `<div class="pop-coord">${fmtCoord(lat, lon)}</div>` +
    `<div class="pop-links">` +
    `<a class="pop-link" href="${gmapsUrl(lat, lon)}" target="_blank" rel="noopener">Google Maps</a>` +
    `<a class="pop-link alt" href="${ormUrl(lat, lon)}" target="_blank" rel="noopener">ORM</a>` +
    `</div>`;
}

function drawMap() {
  if (!map) return;
  itemLayer.clearLayers();
  markers.clear();

  for (const item of state.items) {
    if (!item.result) continue;
    const status = statusOf(item);
    const r = item.result;

    if (item.kind === 'range') {
      L.polyline(r.path, { color: '#3b82f6', weight: 5, opacity: 0.85 }).addTo(itemLayer);
      const a = L.marker([r.start.lat, r.start.lon], { icon: pinIcon(item.index, status) })
        .bindPopup(popupHtml(item, r.start.lat, r.start.lon, `${titleOf(item)} — Anfang`))
        .addTo(itemLayer);
      L.marker([r.end.lat, r.end.lon], { icon: pinIcon(item.index, status) })
        .bindPopup(popupHtml(item, r.end.lat, r.end.lon, `${titleOf(item)} — Ende`))
        .addTo(itemLayer);
      markers.set(item.index, a);
    } else {
      const m = L.marker([r.lat, r.lon], { icon: pinIcon(item.index, status, item.kind) })
        .bindPopup(popupHtml(item, r.lat, r.lon, titleOf(item)))
        .addTo(itemLayer);
      markers.set(item.index, m);
    }
  }
}

function fitMap(force) {
  const all = state.items.flatMap(pointsOf).map(p => [p.lat, p.lon]);
  if (!all.length) return;
  if (state.fitted && !force) return;
  if (all.length === 1) map.setView(all[0], 16);
  else map.fitBounds(L.latLngBounds(all), { padding: [40, 40], maxZoom: 16 });
  state.fitted = true;
}

function focusItem(index) {
  const m = markers.get(index);
  if (!m) return;
  state.activeId = index;
  document.querySelectorAll('.pin.is-active').forEach(el => el.classList.remove('is-active'));
  const el = m.getElement() && m.getElement().querySelector('.pin');
  if (el) el.classList.add('is-active');
  map.setView(m.getLatLng(), Math.max(map.getZoom(), 16), { animate: true });
  m.openPopup();
  document.querySelector('.map-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* -------- eigener Standort -------- */

let meMarker = null;
function locate() {
  if (!navigator.geolocation) { toast('Standortbestimmung wird nicht unterstützt.'); return; }
  if (!window.isSecureContext) { toast('Standort geht nur über HTTPS.'); return; }
  toast('Standort wird ermittelt …');
  navigator.geolocation.getCurrentPosition(pos => {
    const { latitude: lat, longitude: lon, accuracy } = pos.coords;
    meLayer.clearLayers();
    meMarker = L.marker([lat, lon], {
      icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [16, 16], iconAnchor: [8, 8] })
    }).addTo(meLayer);
    L.circle([lat, lon], { radius: Math.max(accuracy || 0, 5), color: '#2f81f7', weight: 1, fillOpacity: 0.12 }).addTo(meLayer);
    meMarker.bindPopup(
      `<b>Mein Standort</b><div class="pop-coord">${fmtCoord(lat, lon)} · ±${nfM.format(accuracy || 0)} m</div>` +
      `<div class="pop-links">` +
      `<a class="pop-link" href="${gmapsUrl(lat, lon)}" target="_blank" rel="noopener">Google Maps</a>` +
      `<a class="pop-link alt" href="#" data-here="1">Strecke hier</a></div>`
    ).openPopup();
    map.setView([lat, lon], 16);
    state.fitted = true;
  }, err => {
    toast('Standort nicht verfügbar: ' + (err.message || 'unbekannt'));
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 });
}

/* Rückwärts-Suche über Overpass: welcher Kilometerstein liegt in der Nähe?
 * Bewusst als Zusatz gebaut — schlägt die Abfrage fehl, bleibt der Rest nutzbar. */
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];

async function whereAmI(lat, lon) {
  const q = `[out:json][timeout:25];(node(around:400,${lat},${lon})[railway=milestone];` +
    `way(around:150,${lat},${lon})[railway~"^(rail|light_rail|narrow_gauge|subway)$"][ref];);out tags center 60;`;
  let data = null, lastErr = null;
  for (const ep of OVERPASS) {
    try { data = await tryFetch(ep + '?data=' + encodeURIComponent(q), 25000); break; }
    catch (e) { lastErr = e; }
  }
  if (!data) throw new Error('Overpass nicht erreichbar (' + (lastErr && lastErr.message) + ')');

  const els = data.elements || [];
  const stones = els.filter(e => e.type === 'node' && e.tags && e.tags['railway:position'] != null)
    .map(e => ({
      km: parseFloat(String(e.tags['railway:position']).replace(',', '.')),
      ref: e.tags['railway:ref'] || e.tags.ref || '',
      dist: haversine(lat, lon, e.lat, e.lon)
    }))
    .filter(s => isFinite(s.km))
    .sort((a, b) => a.dist - b.dist);

  const lines = [...new Set(els.filter(e => e.type === 'way' && e.tags && e.tags.ref)
    .map(e => e.tags.ref))].slice(0, 3);

  return { stone: stones[0] || null, lines };
}

/* ============================ Ausgabe ============================ */

function cardHtml(item) {
  const status = statusOf(item);
  const num = `<div class="num">${item.index}</div>`;

  if (item.kind === 'error' || item.error) {
    return `<article class="card bad" data-index="${item.index}">
      <div class="card-head">${num}<div class="card-title">
        <p class="title">${esc(item.kind === 'error' ? item.raw : titleOf(item))}</p>
        <p class="err">${esc(item.error)}</p>
      </div></div></article>`;
  }

  if (!item.result) {
    return `<article class="card pending" data-index="${item.index}">
      <div class="card-head">${num}<div class="card-title">
        <p class="title">${esc(titleOf(item))}</p>
        <p class="subtitle">wird gesucht …</p>
      </div></div></article>`;
  }

  const r = item.result;
  const lat = item.kind === 'range' ? r.start.lat : r.lat;
  const lon = item.kind === 'range' ? r.start.lon : r.lon;

  let badges = '', hints = '';

  if (item.kind === 'facility') {
    const kindDe = { station: 'Bahnhof', halt: 'Haltepunkt', yard: 'Bahnhofsteil/Gruppe', junction: 'Abzweigstelle', service_station: 'Betriebsbahnhof', crossover: 'Überleitstelle' }[r.kind] || r.kind || 'Betriebsstelle';
    badges = `<span class="badge ok">${esc(kindDe)}</span>` +
      (r.ds100 ? `<span class="badge">DS100 ${esc(r.ds100)}</span>` : '') +
      (r.uic ? `<span class="badge">UIC ${esc(r.uic)}</span>` : '');
    if (r.others > 0) hints += `<p class="hint-row">${r.others} weitere Treffer — Suchbegriff genauer fassen, falls es der falsche ist.</p>`;
  } else if (item.kind === 'range') {
    badges = `<span class="badge ok">Abschnitt</span>` +
      `<span class="badge">${nfKm.format(r.len / 1000)} km Luftlinie über ${r.steps} Steine</span>`;
    for (const [nameDe, part] of [['Anfang', r.start], ['Ende', r.end]]) {
      if (part.quality === 'naechster') {
        hints += `<p class="hint-row strong">${nameDe}: kein Stein bei km ${fmtKm(nameDe === 'Anfang' ? item.from : item.to)} — genommen wurde km ${fmtKm(part.nearKm)} (${fmtKm(Math.abs(part.delta))} km daneben).</p>`;
      }
    }
  } else {
    if (r.quality === 'exakt') {
      badges = `<span class="badge ok">Kilometerstein vorhanden</span>`;
    } else if (r.quality === 'interpoliert') {
      badges = `<span class="badge ok">interpoliert</span>` +
        `<span class="badge">zwischen km ${fmtKm(r.between[0])} und ${fmtKm(r.between[1])}</span>`;
      if (r.spanRatio < 0.75 || r.spanRatio > 1.35) {
        hints += `<p class="hint-row">Der Abstand der beiden Steine passt nicht zur Kilometerdifferenz ` +
          `(${Math.round(r.spanRatio * 100)} %). Möglich sind ein Kilometersprung oder ein enger Bogen — Position mit Vorsicht nutzen.</p>`;
      }
    } else {
      const d = Math.abs(r.delta);
      badges = `<span class="badge ${status}">${fmtKm(d)} km daneben</span>` +
        `<span class="badge">nächster Stein: km ${fmtKm(r.nearKm)}</span>`;
      hints += `<p class="hint-row strong">Bei km ${fmtKm(item.km)} ist kein Stein erfasst. Angezeigt wird der nächstgelegene ` +
        `bei km ${fmtKm(r.nearKm)} — das sind ${fmtKm(d)} km Unterschied.</p>`;
    }
  }

  if (item.warnInput) hints += `<p class="hint-row">${esc(item.warnInput)}</p>`;

  const sub = item.kind === 'facility'
    ? [r.operator, 'gefunden über Namenssuche'].filter(Boolean).join(' · ')
    : [`Strecke ${esc(r.lineRef || item.ref)}`, r.operator].filter(Boolean).join(' · ');

  return `<article class="card ${status}" data-index="${item.index}">
    <div class="card-head">${num}<div class="card-title">
      <p class="title">${esc(titleOf(item))}</p>
      <p class="subtitle">${esc(sub)}</p>
    </div></div>
    ${item.label ? `<p class="card-label">${esc(item.label)}</p>` : ''}
    <p class="coord">${fmtCoord(lat, lon)}</p>
    <div>${badges}</div>
    ${hints}
    <div class="card-actions">
      <a class="maps" href="${gmapsUrl(lat, lon)}" target="_blank" rel="noopener">In Google Maps öffnen</a>
      <button type="button" data-act="show">Auf Karte</button>
      <button type="button" data-act="copy">Kopieren</button>
      <a href="${gmapsRoute(lat, lon)}" target="_blank" rel="noopener">Route</a>
    </div>
  </article>`;
}

function render() {
  const box = $('#results');
  const done = state.items.filter(i => i.result).length;
  const failed = state.items.filter(i => i.error || i.kind === 'error').length;

  const summary = state.items.length
    ? `<p class="summary-line">${state.items.length} Eingabe${state.items.length === 1 ? '' : 'n'} · ` +
      `${done} verortet${failed ? ` · ${failed} ohne Ergebnis` : ''}${state.running ? ' · läuft …' : ''}</p>`
    : '';

  box.innerHTML = summary + state.items.map(cardHtml).join('');
  $('#exportPanel').hidden = done === 0;
  drawMap();
}

/* ============================ Ablauf ============================ */

async function pool(items, limit, worker) {
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

async function run() {
  if (state.running) return;

  const ref = $('#ref').value.trim();
  const text = $('#entries').value;
  let items = parseAll(text, ref);

  if (!items.length) {
    toast('Bitte mindestens eine Kilometerangabe eintragen.');
    return;
  }

  let capped = 0;
  if (items.length > MAX_ENTRIES) {
    capped = items.length - MAX_ENTRIES;
    items = items.slice(0, MAX_ENTRIES);
  }

  state.items = items;
  state.fitted = false;
  state.running = true;
  $('#go').disabled = true;
  render();

  await pool(items.filter(i => i.kind !== 'error'), CONCURRENCY, async item => {
    try {
      if (item.kind === 'facility') item.result = await resolveFacility(item.query);
      else if (item.kind === 'range') item.result = await resolveRange(item.ref, item.from, item.to);
      else item.result = await resolvePoint(item.ref, item.km);
    } catch (e) {
      item.error = e.message || 'Abfrage fehlgeschlagen.';
    }
    render();
    if (!state.fitted) fitMap();
  });

  state.running = false;
  $('#go').disabled = false;
  state.fitted = false;
  render();
  fitMap(true);

  if (capped) toast(`Nur die ersten ${MAX_ENTRIES} Zeilen abgefragt (${capped} übersprungen).`);
  pushHistory(ref, text);
  updateHash(ref, text);
}

/* ============================ Export ============================ */

function exportRows() {
  const rows = [];
  for (const item of state.items) {
    if (!item.result) continue;
    const r = item.result;
    const push = (bez, lat, lon, info) => rows.push({
      bez, lat, lon, info, label: item.label || '',
      ref: item.kind === 'facility' ? (r.ds100 || '') : (r.lineRef || item.ref || '')
    });

    if (item.kind === 'range') {
      push(`${titleOf(item)} — Anfang`, r.start.lat, r.start.lon, qualityText(r.start));
      push(`${titleOf(item)} — Ende`, r.end.lat, r.end.lon, qualityText(r.end));
    } else {
      push(titleOf(item), r.lat, r.lon, item.kind === 'facility' ? 'Betriebsstelle' : qualityText(r));
    }
  }
  return rows;
}

function qualityText(r) {
  if (r.quality === 'exakt') return 'Kilometerstein vorhanden';
  if (r.quality === 'interpoliert') return `interpoliert zwischen km ${fmtKm(r.between[0])} und ${fmtKm(r.between[1])}`;
  return `nächster Stein km ${fmtKm(r.nearKm)} (${fmtKm(Math.abs(r.delta))} km Abweichung)`;
}

function asText() {
  return exportRows().map(r =>
    `${r.bez}${r.label ? ` (${r.label})` : ''}\n  ${r.lat.toFixed(6)}, ${r.lon.toFixed(6)}  [${r.info}]\n  ${gmapsUrl(r.lat, r.lon)}`
  ).join('\n\n');
}

function asCsv() {
  const head = 'Bezeichnung;Strecke;Breite;Laenge;Qualitaet;Bemerkung;GoogleMaps';
  const body = exportRows().map(r => [
    r.bez, r.ref, r.lat.toFixed(6).replace('.', ','), r.lon.toFixed(6).replace('.', ','),
    r.info, r.label, gmapsUrl(r.lat, r.lon)
  ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(';'));
  const bom = String.fromCharCode(0xFEFF);      // damit Excel die Umlaute erkennt
  return bom + [head, ...body].join('\r\n');
}

function asGpx() {
  const x = s => esc(s);
  const wpts = exportRows().map(r =>
    `  <wpt lat="${r.lat.toFixed(6)}" lon="${r.lon.toFixed(6)}">\n` +
    `    <name>${x(r.bez)}</name>\n    <desc>${x([r.info, r.label].filter(Boolean).join(' — '))}</desc>\n  </wpt>`
  );
  const trks = state.items.filter(i => i.kind === 'range' && i.result).map(i =>
    `  <trk><name>${x(titleOf(i))}</name><trkseg>\n` +
    i.result.path.map(p => `    <trkpt lat="${p[0].toFixed(6)}" lon="${p[1].toFixed(6)}"/>`).join('\n') +
    `\n  </trkseg></trk>`
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx version="1.1" creator="Railnav" xmlns="http://www.topografix.com/GPX/1/1">\n` +
    `  <metadata><name>Railnav-Export</name></metadata>\n` +
    [...wpts, ...trks].join('\n') + `\n</gpx>\n`;
}

function permalink(ref, text) {
  const p = new URLSearchParams();
  if (ref) p.set('r', ref);
  p.set('q', text);
  return location.origin + location.pathname + '#' + p.toString();
}

async function doExport(kind) {
  const rows = exportRows();
  if (!rows.length && kind !== 'link') { toast('Noch keine Ergebnisse.'); return; }
  const stamp = new Date().toISOString().slice(0, 10);

  if (kind === 'copy') {
    toast(await copyText(asText()) ? 'Liste kopiert' : 'Kopieren nicht möglich');
  } else if (kind === 'csv') {
    download(`railnav-${stamp}.csv`, 'text/csv;charset=utf-8', asCsv());
  } else if (kind === 'gpx') {
    download(`railnav-${stamp}.gpx`, 'application/gpx+xml', asGpx());
  } else if (kind === 'link') {
    const url = permalink($('#ref').value.trim(), $('#entries').value);
    if (navigator.share) {
      try { await navigator.share({ title: 'Railnav', text: 'Positionen', url }); return; }
      catch { /* abgebrochen — dann kopieren */ }
    }
    toast(await copyText(url) ? 'Link kopiert' : 'Kopieren nicht möglich');
  }
}

/* ============================ Verlauf & Einstellungen ============================ */

let prefs = { theme: 'auto', base: 'osm', orm: true, big: false };
let recent = [];   // nicht "history" nennen — das ist window.history

function loadStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    prefs = { ...prefs, ...(raw.prefs || {}) };
    recent = Array.isArray(raw.history) ? raw.history : [];
  } catch { /* defekter Speicher — Standardwerte behalten */ }
}

function saveStore() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ prefs, history: recent })); } catch { /* voll oder gesperrt */ }
}
const savePrefs = saveStore;

function pushHistory(ref, text) {
  const entry = { ref, text, n: state.items.length };
  recent = [entry, ...recent.filter(h => !(h.ref === ref && h.text === text))].slice(0, 10);
  saveStore();
  renderHistory();
}

function renderHistory() {
  const wrap = $('#historyPanel');
  wrap.hidden = recent.length === 0;
  $('#history').innerHTML = recent.map((h, i) => {
    const first = h.text.split(/\r?\n/).find(l => l.trim()) || '';
    const more = h.n > 1 ? ` +${h.n - 1}` : '';
    return `<button class="chip" type="button" data-hist="${i}">${h.ref ? `<b>${esc(h.ref)}</b> · ` : ''}${esc(first.slice(0, 28))}${esc(more)}</button>`;
  }).join('');
}

function applyTheme() {
  const el = document.documentElement;
  if (prefs.theme === 'auto') el.removeAttribute('data-theme');
  else el.setAttribute('data-theme', prefs.theme);
}

function updateHash(ref, text) {
  const p = new URLSearchParams();
  if (ref) p.set('r', ref);
  p.set('q', text);
  const hash = '#' + p.toString();
  try { window.history.replaceState(null, '', hash); } catch { location.hash = hash; }
}

function readHash() {
  const h = location.hash.replace(/^#/, '');
  if (!h) return false;
  const p = new URLSearchParams(h);
  const q = p.get('q');
  if (!q) return false;
  $('#ref').value = p.get('r') || '';
  $('#entries').value = q;
  return true;
}

/* ============================ Start ============================ */

function bind() {
  $('#go').addEventListener('click', run);
  $('#clearBtn').addEventListener('click', () => {
    $('#entries').value = '';
    state.items = [];
    render();
    $('#entries').focus();
  });
  $('#locBtn').addEventListener('click', locate);

  $('#ref').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); $('#entries').focus(); }
  });
  $('#entries').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); }
  });

  $('#results').addEventListener('click', e => {
    const card = e.target.closest('.card');
    if (!card) return;
    const index = Number(card.dataset.index);
    const act = e.target.dataset.act;
    if (act === 'show') focusItem(index);
    else if (act === 'copy') {
      const item = state.items.find(i => i.index === index);
      const r = item && item.result;
      if (!r) return;
      const lat = item.kind === 'range' ? r.start.lat : r.lat;
      const lon = item.kind === 'range' ? r.start.lon : r.lon;
      copyText(fmtCoord(lat, lon)).then(ok => toast(ok ? 'Koordinaten kopiert' : 'Kopieren nicht möglich'));
    }
  });

  document.querySelectorAll('[data-export]').forEach(b =>
    b.addEventListener('click', () => doExport(b.dataset.export)));

  document.querySelectorAll('[data-base]').forEach(b =>
    b.addEventListener('click', () => setBase(b.dataset.base)));
  $('#ormBtn').addEventListener('click', toggleOrm);
  $('#bigBtn').addEventListener('click', () => {
    prefs.big = !prefs.big;
    savePrefs();
    syncMapButtons();
    setTimeout(() => map.invalidateSize(), 210);
  });

  $('#themeBtn').addEventListener('click', () => {
    prefs.theme = prefs.theme === 'auto' ? 'light' : prefs.theme === 'light' ? 'dark' : 'auto';
    applyTheme();
    savePrefs();
    toast('Ansicht: ' + { auto: 'automatisch', light: 'hell', dark: 'dunkel' }[prefs.theme]);
  });

  $('#history').addEventListener('click', e => {
    const b = e.target.closest('[data-hist]');
    if (!b) return;
    const h = history[Number(b.dataset.hist)];
    if (!h) return;
    $('#ref').value = h.ref || '';
    $('#entries').value = h.text;
    run();
  });
  $('#histClear').addEventListener('click', () => {
    history = [];
    saveStore();
    renderHistory();
  });

  // "Strecke hier" im Standort-Popup
  document.addEventListener('click', async e => {
    const link = e.target.closest('[data-here]');
    if (!link || !meMarker) return;
    e.preventDefault();
    const { lat, lng } = meMarker.getLatLng();
    toast('Suche Kilometerstein in der Nähe …');
    try {
      const res = await whereAmI(lat, lng);
      if (!res.stone && !res.lines.length) { toast('Nichts Bahnrelevantes im Umkreis gefunden.'); return; }
      const parts = [];
      if (res.stone) parts.push(`km ${fmtKm(res.stone.km)} (${nfM.format(res.stone.dist)} m entfernt)`);
      if (res.lines.length) parts.push(`Strecke ${res.lines.join(' / ')}`);
      toast(parts.join(' · '));
    } catch (err) {
      toast('Umkreissuche fehlgeschlagen: ' + err.message);
    }
  });
}

function boot() {
  loadStore();
  applyTheme();
  initMap();
  bind();
  renderHistory();

  if (readHash()) run();
  else if (history[0]) $('#ref').value = history[0].ref || '';

  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline-Betrieb ist optional */ });
  }
}

document.addEventListener('DOMContentLoaded', boot);
