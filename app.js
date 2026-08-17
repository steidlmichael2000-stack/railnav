/* Railnav — Streckenkilometer auf der Karte
 *
 * Zwei Richtungen:
 *   Strecke + km  → Position   (OpenRailwayMap-API, dazwischen wird interpoliert)
 *   Klick/Karte   → Strecke + km (Projektion auf die geladenen Kilometersteine)
 *
 * Die API kennt nur die erste Richtung; die zweite rechnet der Browser aus den
 * bereits geladenen Steinen. Nur wenn weit weg von der geladenen Strecke geklickt
 * wird, muss Overpass sagen, welche Strecke dort überhaupt liegt.
 */

'use strict';

const API = 'https://api.openrailwaymap.org/v2';
const LIMIT = 200;           // Maximum der API je Abfrage
/* Bis zu welcher Lücke zwischen zwei Steinen wird interpoliert?
 *
 * Gemessen über 1869 Steintripel (ein Stein übersprungen, über die Lücke
 * interpoliert, mit seiner echten Lage verglichen) schlägt die Interpolation
 * die Anzeige des nächstgelegenen Steins über den ganzen Bereich:
 *
 *   Steinabstand   interpoliert   nächster Stein   interpoliert besser
 *   250– 700 m       22 m            176 m              99 %
 *   700–1200 m       33 m            206 m              98 %
 *  1200–2000 m       36 m            401 m              98 %
 *  2000–4000 m       49 m            836 m             100 %
 *  4000–7000 m      265 m           1617 m             100 %
 *
 * Eine engere Grenze verschenkt also nur Genauigkeit. Jenseits von 8 km ist
 * die Datenlage zu dünn, um es zu belegen — dort bleibt es beim nächsten Stein.
 */
const MAX_GAP_KM = 8;

/* Für die gezeichnete Linie und das Antippen der Karte gilt eine engere Grenze:
 * Eine Gerade über viele Kilometer unbekannten Verlaufs sieht auf der Karte
 * falsch aus und würde Klicks weit neben dem echten Gleis an sich ziehen. */
const MAX_DRAW_GAP_KM = 3;
const CLICK_TOL_PX = 34;     // Klicktoleranz quer zur Strecke
const STORE_KEY = 'railnav.v3';

/* Mehrere Instanzen, weil einzelne zeitweise ausfallen: Die Hauptinstanz war
 * zwischenzeitlich aus dem Testnetz gar nicht erreichbar (HTTP 406), kumi hat
 * bei der schweren Geometrieabfrage mit 504 abgebrochen. Der Reihe nach
 * durchprobieren, die erste brauchbare Antwort gewinnt. */
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];

/* ============================ Helfer ============================ */

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

/** "12+250" → 12.25, "12,5" → 12.5 */
function toKm(token) {
  const t = String(token).trim();
  const hm = /^(-?)(\d+)\+(\d{1,3})$/.exec(t);
  if (hm) {
    const frac = parseInt(hm[3].padEnd(3, '0'), 10) / 1000;
    return (hm[1] === '-' ? -1 : 1) * (parseInt(hm[2], 10) + frac);
  }
  return parseFloat(t.replace(',', '.'));
}

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

/* ============================ API ============================ */

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

/* Je Strecke werden alle geladenen Steine gesammelt. Die API antwortet im festen
 * Umkreis von 10 km um die angefragte Position, unsortiert und auf LIMIT gekappt. */
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

/** Sind zwei Steine plausibel benachbart?
 *
 *  Die Luftlinie zwischen zwei Punkten kann nie länger sein als die Strecke
 *  entlang des Gleises. Ist sie es doch, gehören die beiden nicht zusammen:
 *  Streckennummern tauchen in den Daten mehrfach auf, an Abzweigen und bei
 *  Nummernwechseln liegen gleiche Kilometerwerte an ganz anderen Orten.
 *  Ohne diese Prüfung würde quer durchs Land interpoliert.
 */
function segmentOk(a, b, maxGap = MAX_GAP_KM) {
  const dkm = b.km - a.km;
  if (dkm <= 0 || dkm > maxGap) return false;
  return haversine(a.lat, a.lon, b.lat, b.lon) <= dkm * 1000 * 1.25 + 50;
}

/** Warum ein Paar nicht taugt — für die Anzeige, damit dort kein falscher Grund steht. */
function rejectReason(a, b) {
  const dkm = b.km - a.km;
  if (dkm <= 0) return null;
  if (dkm > MAX_GAP_KM) return 'luecke';
  if (haversine(a.lat, a.lon, b.lat, b.lon) > dkm * 1000 * 1.25 + 50) return 'geometrie';
  return null;
}

function hasBracket(sorted, km) {
  const b = bracketOf(sorted, km);
  return !!(b.exact || (b.lower && b.upper && segmentOk(b.lower, b.upper)));
}

function storeFor(ref) {
  let e = lineCache.get(ref);
  if (!e) { e = { pts: new Map(), sorted: [], probes: [], lastCount: 0 }; lineCache.set(ref, e); }
  return e;
}

async function probe(ref, e, km) {
  const data = await getJson(`${API}/milestone?ref=${encodeURIComponent(ref)}&position=${km}&limit=${LIMIT}`);
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
    e.sorted = [...e.pts.values()].sort((a, b) => a.km - b.km);
  }
}

async function coverage(ref, km) {
  const e = storeFor(ref);
  const probedHere = e.probes.some(p => Math.abs(p - km) < 0.75);
  if (hasBracket(e.sorted, km) || probedHere) return e;

  await probe(ref, e, km);

  // Auf dicht erfassten Strecken (Steine alle 100 m) kann der passende Nachbar
  // durch das LIMIT abgeschnitten sein — dann das Fenster verschieben.
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
    return { lat: exact.lat, lon: exact.lon, quality: 'exakt', operator: exact.operator, lineRef: exact.ref };
  }

  // Ein Paar, das die Plausibilitätsprüfung nicht besteht, wird unten als Grund
  // ausgewiesen — sonst steht da nur „kein Stein erfasst" und niemand versteht,
  // warum trotz zweier Nachbarsteine nicht interpoliert wurde.
  let verworfen = null;

  if (lower && upper) {
    const span = upper.km - lower.km;
    const grund = rejectReason(lower, upper);
    if (grund) {
      verworfen = {
        grund, von: lower.km, bis: upper.km,
        luftlinie: haversine(lower.lat, lower.lon, upper.lat, upper.lon),
        entlang: span * 1000
      };
    }
    if (segmentOk(lower, upper)) {
      const t = (km - lower.km) / span;
      const geo = haversine(lower.lat, lower.lon, upper.lat, upper.lon);
      return {
        lat: lower.lat + t * (upper.lat - lower.lat),
        lon: lower.lon + t * (upper.lon - lower.lon),
        quality: 'interpoliert',
        between: [lower.km, upper.km],
        spanRatio: geo / (span * 1000),
        chord: geo,
        err: interpolationError(geo),
        operator: lower.operator || upper.operator,
        lineRef: lower.ref || upper.ref
      };
    }
  }

  const near = e.sorted.reduce((a, b) => Math.abs(b.km - km) < Math.abs(a.km - km) ? b : a);
  return {
    lat: near.lat, lon: near.lon, quality: 'naechster',
    delta: near.km - km, nearKm: near.km, verworfen,
    operator: near.operator, lineRef: near.ref
  };
}

async function searchFacility(query) {
  const data = await getJson(`${API}/facility?q=${encodeURIComponent(query)}&limit=8`);
  if (!Array.isArray(data)) return [];
  return data
    .filter(d => typeof d.latitude === 'number' && typeof d.longitude === 'number')
    .sort((a, b) => (b.rank || 0) - (a.rank || 0))
    .slice(0, 5)
    .map(d => ({
      lat: d.latitude, lon: d.longitude,
      name: d.name || d.short_name || query,
      kind: d.railway || '',
      ds100: d['railway:ref'] || '',
      uic: d.uic_ref || '',
      operator: d.operator || ''
    }));
}

/* ============================ Geometrie ============================ */

/* Wie weit liegt die geradlinige Interpolation zwischen zwei Steinen daneben?
 *
 * Gemessen statt gerechnet: auf vierzehn Strecken wurde über 1474 Steintripel
 * jeweils der mittlere Stein übersprungen, über die Lücke interpoliert und mit
 * seiner tatsächlichen Lage verglichen.
 *
 * Das überraschende Ergebnis: auf nahezu geraden Abschnitten (Bogenhalbmesser
 * über 4000 m), wo die Interpolation exakt sein müsste, wurden trotzdem 10–29 m
 * Abweichung gemessen — praktisch dasselbe wie in engen Bögen. Der Bogen ist
 * also nicht der begrenzende Faktor, sondern die Erfassungsgenauigkeit der
 * Steine in OpenStreetMap. Erst ab etwa 700 m Steinabstand schlägt die Krümmung
 * durch (Median 40 m im Bogen gegenüber 22 m auf der Geraden).
 *
 * Eine Formel über den Bogenhalbmesser hat deshalb nichts getaugt — sie hat
 * Rauschen gefittet. Hier stehen stattdessen die gemessenen Verteilungen.
 * Sie enthalten die Streuung der Steinerfassung mit, sind also eine Obergrenze
 * für den Fehler des Verfahrens selbst.
 */
const ERR_TABLE = [
  { upTo: 250, typical: 10, worst: 29 },
  { upTo: 700, typical: 22, worst: 46 },
  { upTo: 1200, typical: 33, worst: 81 },
  { upTo: 2000, typical: 36, worst: 95 },
  { upTo: 4000, typical: 49, worst: 263 },
  { upTo: Infinity, typical: 265, worst: 707 }
];

function interpolationError(chordM) {
  return ERR_TABLE.find(r => chordM < r.upTo);
}

/** Nächster Punkt auf dem Streckenzug der Kilometersteine — liefert auch den Kilometer dort. */
function projectOnLine(sorted, lat, lon) {
  if (!sorted || sorted.length < 2) return null;

  // Lokale ebene Näherung in Metern; auf diesen Entfernungen völlig ausreichend
  const ky = 110540, kx = Math.cos(lat * Math.PI / 180) * 111320;
  const px = lon * kx, py = lat * ky;
  let best = null;

  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1], b = sorted[i];
    if (!segmentOk(a, b, MAX_DRAW_GAP_KM)) continue;   // Lücken und Fehlpaare überspringen
    const dkm = b.km - a.km;

    const ax = a.lon * kx, ay = a.lat * ky;
    const dx = b.lon * kx - ax, dy = b.lat * ky - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));

    const cx = ax + t * dx, cy = ay + t * dy;
    const dist = Math.hypot(px - cx, py - cy);
    if (!best || dist < best.dist) {
      best = { dist, km: a.km + t * dkm, lat: cy / ky, lon: cx / kx, between: [a.km, b.km] };
    }
  }
  return best;
}

/* ============================ Feinrechnung entlang des Gleises ============================ */

/* Die geradlinige Interpolation schneidet Bögen ab. Wer den tatsächlichen
 * Gleisverlauf kennt, kann den Punkt exakt darauf setzen — gemessen an
 * Strecke 5321 km 99,0 waren das 375 m Unterschied.
 *
 * Das kostet allerdings eine Overpass-Abfrage (Sekunden, nicht offline) und
 * lohnt nur bei weit auseinanderliegenden Steinen: bei 200 m Abstand liegt die
 * Interpolation ohnehin nur 10 m daneben, und das ist die Erfassungsgenauigkeit
 * der Steine, gegen die kein Gleisverlauf hilft. Deshalb kein Automatismus,
 * sondern ein Knopf, der erst ab REFINE_MIN_CHORD auftaucht.
 */
const REFINE_MIN_CHORD = 700;

async function railGeometry(a, b) {
  const pad = 0.012;   // gut 1 km Rand, damit Bögen außerhalb der Sehne mitkommen
  const bbox = [
    Math.min(a.lat, b.lat) - pad, Math.min(a.lon, b.lon) - pad,
    Math.max(a.lat, b.lat) + pad, Math.max(a.lon, b.lon) + pad
  ].join(',');
  const q = `[out:json][timeout:60];way(${bbox})[railway~"^(rail|light_rail|narrow_gauge)$"];out geom;`;

  let data = null, lastErr = null;
  for (const ep of OVERPASS) {
    try { data = await tryFetch(ep + '?data=' + encodeURIComponent(q), 40000); break; }
    catch (err) { lastErr = err; }
  }
  if (!data) throw new Error('Overpass nicht erreichbar (' + (lastErr && lastErr.message) + ')');
  return (data.elements || []).filter(w => w.geometry && w.geometry.length > 1);
}

/* Eine Strecke besteht aus vielen Wegstücken, unsortiert und mit Abzweigen.
 * Statt sie zu sortieren wird ein Knotennetz gebaut und darin der kürzeste Weg
 * gesucht — das findet den Verlauf auch über Weichen und Wegegrenzen hinweg.
 * Zusammenhängende Wege teilen in OSM denselben Knoten, also dieselbe Koordinate. */
function buildGraph(ways) {
  const keyOf = p => p.lat.toFixed(7) + ',' + p.lon.toFixed(7);
  const nodes = new Map();

  const ensure = p => {
    const k = keyOf(p);
    if (!nodes.has(k)) nodes.set(k, { lat: p.lat, lon: p.lon, adj: [] });
    return k;
  };

  for (const w of ways) {
    for (let i = 1; i < w.geometry.length; i++) {
      const k1 = ensure(w.geometry[i - 1]);
      const k2 = ensure(w.geometry[i]);
      if (k1 === k2) continue;
      const n1 = nodes.get(k1), n2 = nodes.get(k2);
      const d = haversine(n1.lat, n1.lon, n2.lat, n2.lon);
      n1.adj.push([k2, d]);
      n2.adj.push([k1, d]);
    }
  }
  return nodes;
}

function nearestNode(nodes, lat, lon) {
  let key = null, dist = Infinity;
  for (const [k, n] of nodes) {
    const d = haversine(lat, lon, n.lat, n.lon);
    if (d < dist) { dist = d; key = k; }
  }
  return { key, dist };
}

/** Dijkstra über das Knotennetz. */
function shortestPath(nodes, startKey, endKey) {
  const dist = new Map([[startKey, 0]]);
  const prev = new Map();
  const done = new Set();

  for (;;) {
    let cur = null, curD = Infinity;
    for (const [k, d] of dist) {
      if (!done.has(k) && d < curD) { curD = d; cur = k; }
    }
    if (cur === null) return null;          // nicht verbunden
    if (cur === endKey) break;
    done.add(cur);
    for (const [nk, w] of nodes.get(cur).adj) {
      if (done.has(nk)) continue;
      const nd = curD + w;
      if (nd < (dist.has(nk) ? dist.get(nk) : Infinity)) { dist.set(nk, nd); prev.set(nk, cur); }
    }
  }

  const path = [];
  let k = endKey;
  while (k !== undefined) {
    const n = nodes.get(k);
    path.push([n.lat, n.lon]);
    if (k === startKey) break;
    k = prev.get(k);
  }
  return { path: path.reverse(), length: dist.get(endKey) };
}

/** Punkt in gegebener Entfernung entlang eines Streckenzugs. */
function pointAlong(path, target) {
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    const d = haversine(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
    if (acc + d >= target) {
      const t = d > 0 ? (target - acc) / d : 0;
      return {
        lat: path[i - 1][0] + t * (path[i][0] - path[i - 1][0]),
        lon: path[i - 1][1] + t * (path[i][1] - path[i - 1][1])
      };
    }
    acc += d;
  }
  const last = path[path.length - 1];
  return { lat: last[0], lon: last[1] };
}

async function refineOnTrack() {
  const p = view.point;
  if (!p || p.quality !== 'interpoliert' || view.busy) return;

  const store = lineCache.get(view.ref);
  const A = store && store.sorted.find(x => Math.abs(x.km - p.between[0]) < 1e-6);
  const B = store && store.sorted.find(x => Math.abs(x.km - p.between[1]) < 1e-6);
  if (!A || !B) { toast('Nachbarsteine nicht mehr im Speicher — bitte neu suchen.'); return; }

  setBusy(true);
  const zuvor = $('#bottom').innerHTML;
  showStatus('Hole den Gleisverlauf von Overpass — das dauert einige Sekunden …');

  try {
    const ways = await railGeometry(A, B);
    if (!ways.length) throw new Error('keine Gleisgeometrie im Ausschnitt');

    const nodes = buildGraph(ways);
    if (nodes.size > 60000) throw new Error('zu viele Gleise im Ausschnitt');

    const na = nearestNode(nodes, A.lat, A.lon);
    const nb = nearestNode(nodes, B.lat, B.lon);
    if (na.dist > 80 || nb.dist > 80) {
      throw new Error(`die Steine liegen bis ${nfM.format(Math.max(na.dist, nb.dist))} m vom nächsten Gleis entfernt`);
    }

    const sp = shortestPath(nodes, na.key, nb.key);
    if (!sp) throw new Error('kein durchgehender Gleisweg zwischen den beiden Steinen');

    const nominal = (B.km - A.km) * 1000;
    const ratio = sp.length / nominal;
    if (ratio < 0.8 || ratio > 1.3) {
      throw new Error(`der gefundene Gleisweg ist ${nfM.format(sp.length)} m lang, die Kilometerdifferenz aber ${nfM.format(nominal)} m`);
    }

    const t = (view.km - A.km) / (B.km - A.km);
    const pos = pointAlong(sp.path, t * sp.length);
    const korrektur = haversine(p.lat, p.lon, pos.lat, pos.lon);

    trackLayer.clearLayers();
    L.polyline(sp.path, { color: '#22c55e', weight: 4, opacity: 0.9, interactive: false }).addTo(trackLayer);

    view.point = {
      ...p, lat: pos.lat, lon: pos.lon, quality: 'gleis',
      korrektur, wegLaenge: sp.length, nominal
    };
    drawPoint();
    renderBottom();
    map.setView([pos.lat, pos.lon], Math.max(map.getZoom(), 16));
    toast(`Auf das Gleis gerechnet — ${nfM.format(korrektur)} m verschoben`);
  } catch (err) {
    $('#bottom').innerHTML = zuvor;
    bindBottom();
    updateBH();
    toast('Feinrechnung nicht möglich: ' + err.message);
  } finally {
    setBusy(false);
  }
}

/* ============================ Zustand ============================ */

const view = {
  ref: '',        // aktuell geladene Strecke
  km: null,
  point: null,    // {lat, lon, quality, …}
  busy: false
};

let prefs = {
  theme: 'auto', base: 'osm', orm: true,
  wms: { url: '', layers: '', opacity: 75, on: false }   // nur Adresse und Layer, nie Zugangsdaten
};
let recent = [];   // nicht "history" nennen — das ist window.history

/* ============================ Karte ============================ */

let map, baseOsm, baseSat, ormLayer, msLayer, trackLayer, pointLayer, meLayer;
let pointMarker = null;

function initMap() {
  map = L.map('map', { zoomControl: false, attributionControl: true, tap: true })
    .setView([51.1, 10.3], 6);

  baseOsm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  });
  baseSat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, maxNativeZoom: 18, attribution: 'Luftbild: Esri, Maxar'
  });
  ormLayer = L.tileLayer('https://{s}.tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png', {
    subdomains: 'abc', maxZoom: 19, maxNativeZoom: 19, opacity: 0.85,
    attribution: '<a href="https://www.openrailwaymap.org/">OpenRailwayMap</a>'
  });

  baseOsm.addTo(map);
  msLayer = L.layerGroup().addTo(map);
  trackLayer = L.layerGroup().addTo(map);
  pointLayer = L.layerGroup().addTo(map);
  meLayer = L.layerGroup().addTo(map);

  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);

  if (prefs.orm !== false) ormLayer.addTo(map);
  if (prefs.base === 'sat') setBase('sat');
  if (prefs.wms && prefs.wms.on) wmsApply(true);

  map.on('click', onMapClick);
  map.on('zoomend', drawMilestones);
  syncButtons();
}

function setBase(which) {
  prefs.base = which;
  const on = which === 'sat' ? baseSat : baseOsm;
  const off = which === 'sat' ? baseOsm : baseSat;
  if (map.hasLayer(off)) map.removeLayer(off);
  if (!map.hasLayer(on)) on.addTo(map);
  if (map.hasLayer(ormLayer)) ormLayer.bringToFront();
  saveStore();
  syncButtons();
}

function toggleOrm() {
  if (map.hasLayer(ormLayer)) { map.removeLayer(ormLayer); prefs.orm = false; }
  else { ormLayer.addTo(map); ormLayer.bringToFront(); prefs.orm = true; }
  saveStore();
  syncButtons();
}

/* -------- Eigener WMS-Layer -------- */

/* Geschützte Dienste liefern ihre Kacheln nur mit Anmeldung. Ein Eingabefeld in
 * der App hilft dabei nicht: Die Kacheln müssten dann per fetch mit
 * Authorization-Header geholt werden, und das verlangt CORS-Freigaben, die
 * solche Dienste praktisch nie senden — der Browser bricht schon beim Preflight
 * ab. Als Bild (<img>) geladen entfällt die CORS-Prüfung, und der Browser hängt
 * von sich aus die Zugangsdaten an, die er für die Domain gespeichert hat.
 * Deshalb: einmal über den Anmelden-Knopf im Browser anmelden, den Rest erledigt
 * dessen Passwortspeicher. Die App kennt die Zugangsdaten nie. */

let wmsLayer = null;
let wmsFehler = 0;

function wmsBuild() {
  const url = (prefs.wms.url || '').trim();
  const layers = (prefs.wms.layers || '').trim();
  if (!url || !layers) return null;

  const layer = L.tileLayer.wms(url, {
    layers, format: 'image/png', transparent: true, version: '1.3.0',
    opacity: (prefs.wms.opacity || 75) / 100,
    crossOrigin: false        // kein CORS anfordern, sonst scheitert der Abruf
  });

  wmsFehler = 0;
  layer.on('tileerror', () => {
    wmsFehler++;
    // Erst nach mehreren Fehlschlägen melden, einzelne Aussetzer sind normal
    if (wmsFehler === 4) {
      toast('WMS-Kacheln kommen nicht — Adresse, Layer-Name oder Anmeldung prüfen.');
    }
  });
  return layer;
}

function wmsApply(sichtbar) {
  if (wmsLayer) { map.removeLayer(wmsLayer); wmsLayer = null; }
  prefs.wms.on = !!sichtbar;
  if (sichtbar) {
    wmsLayer = wmsBuild();
    if (!wmsLayer) { prefs.wms.on = false; toast('Bitte Adresse und Layer-Namen eintragen.'); }
    else { wmsLayer.addTo(map); wmsLayer.bringToFront(); }
  }
  if (map.hasLayer(ormLayer)) ormLayer.bringToFront();
  saveStore();
  syncButtons();
}

/* GetCapabilities auswerten: Layer-Namen und Koordinatensysteme.
 * Namensräume ignorieren — WMS 1.3.0 setzt einen Default-Namespace, an dem
 * querySelector scheitert. */
function parseWmsCapabilities(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('kein gültiges XML');

  const layers = [];
  for (const el of doc.getElementsByTagNameNS('*', 'Layer')) {
    // Nur direkte Kinder ansehen, sonst erbt jede Gruppe den Namen ihrer Unterlayer
    let name = '', title = '';
    for (const c of el.children) {
      if (c.localName === 'Name' && !name) name = c.textContent.trim();
      if (c.localName === 'Title' && !title) title = c.textContent.trim();
    }
    if (name) layers.push({ name, title });
  }

  const crs = new Set();
  for (const tag of ['CRS', 'SRS']) {
    for (const el of doc.getElementsByTagNameNS('*', tag)) {
      const v = el.textContent.trim();
      if (v) crs.add(v);
    }
  }
  return { layers, crs: [...crs], webMercator: [...crs].some(c => /EPSG:(3857|900913)/i.test(c)) };
}

function wmsShowLayers(caps) {
  const box = $('#wmsList');
  if (!caps.layers.length) { box.innerHTML = '<p class="fine">Keine benannten Layer gefunden.</p>'; return; }

  const hinweis = caps.crs.length
    ? `<p class="fine">${caps.webMercator
        ? 'EPSG:3857 wird unterstützt — passt.'
        : 'Achtung: EPSG:3857 ist nicht dabei. Der Layer bleibt vermutlich leer.'}</p>`
    : '';

  box.innerHTML = hinweis + caps.layers.slice(0, 25).map((l, i) =>
    `<button class="fac-item" type="button" data-wl="${i}">${esc(l.name)}` +
    `${l.title && l.title !== l.name ? `<small>${esc(l.title)}</small>` : ''}</button>`).join('');

  box.querySelectorAll('[data-wl]').forEach(btn => btn.addEventListener('click', () => {
    const l = caps.layers[Number(btn.dataset.wl)];
    $('#wmsLayers').value = l.name;
    prefs.wms.layers = l.name;
    saveStore();
    wmsApply(true);
    toast('Layer „' + l.name + '" eingestellt.');
  }));
}

async function wmsLoadLayers() {
  const url = ($('#wmsUrl').value || '').trim();
  if (!url) { toast('Bitte zuerst die Adresse des Dienstes eintragen.'); return; }
  $('#wmsList').innerHTML = '<p class="fine">Frage den Dienst …</p>';
  const sep = url.includes('?') ? '&' : '?';
  try {
    const r = await fetch(url + sep + 'SERVICE=WMS&REQUEST=GetCapabilities');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    wmsShowLayers(parseWmsCapabilities(await r.text()));
    $('#wmsPaste').hidden = true;
  } catch (err) {
    // Typischer Fall bei geschützten Diensten: keine CORS-Freigabe
    $('#wmsList').innerHTML = `<p class="fine">Direktabfrage nicht möglich (${esc(err.message)}). ` +
      `Bitte über <em>Anmelden</em> öffnen, dort alles kopieren und unten einfügen.</p>`;
    $('#wmsPaste').hidden = false;
  }
}

function wmsLogin() {
  const url = (prefs.wms.url || '').trim();
  if (!url) { toast('Bitte zuerst die Adresse des Dienstes eintragen.'); return; }
  // GetCapabilities aufrufen: Der Browser fragt die Zugangsdaten ab und merkt sie
  // sich für die Domain. Nebenbei sieht man dort die verfügbaren Layer.
  const sep = url.includes('?') ? '&' : '?';
  window.open(url + sep + 'SERVICE=WMS&REQUEST=GetCapabilities', '_blank', 'noopener');
  toast('Im neuen Tab anmelden und speichern lassen, dann hierher zurück.');
}

/* -------- Kilometersteine zeichnen -------- */

/** Beschriftungsdichte nach Zoomstufe, damit die Karte nicht zuwächst. */
function labelStep(z) {
  if (z >= 16) return 0;      // alle
  if (z >= 15) return 0.2;
  if (z >= 14) return 0.5;
  if (z >= 13) return 1;
  if (z >= 11) return 5;
  return 10;
}

function drawMilestones() {
  msLayer.clearLayers();
  const e = view.ref && lineCache.get(view.ref);
  if (!e || !e.sorted.length) return;

  const z = map.getZoom();
  if (z < 9) return;

  const bounds = map.getBounds().pad(0.3);
  const step = labelStep(z);
  let lastLabelKm = -Infinity;

  // dünne Linie durch die Steine: macht sichtbar, welcher Strang gemeint ist
  const path = [];
  for (let i = 1; i < e.sorted.length; i++) {
    const a = e.sorted[i - 1], b = e.sorted[i];
    if (segmentOk(a, b, MAX_DRAW_GAP_KM)) path.push([[a.lat, a.lon], [b.lat, b.lon]]);
  }
  if (path.length) {
    L.polyline(path, { color: '#4b93e6', weight: 3, opacity: 0.45, interactive: false }).addTo(msLayer);
  }

  for (const p of e.sorted) {
    const inView = bounds.contains([p.lat, p.lon]);
    const label = step === 0 || p.km - lastLabelKm >= step - 1e-9;
    if (label) lastLabelKm = p.km;
    if (!inView) continue;

    L.circleMarker([p.lat, p.lon], {
      radius: label ? 4.5 : 3,
      color: '#fff', weight: label ? 1.6 : 1,
      fillColor: '#4b93e6', fillOpacity: 1,
      bubblingMouseEvents: false
    }).on('click', ev => {
      L.DomEvent.stopPropagation(ev);
      applyPoint(view.ref, p.km, {
        lat: p.lat, lon: p.lon, quality: 'exakt', operator: p.operator, lineRef: p.ref
      });
    }).addTo(msLayer);

    if (label) {
      L.marker([p.lat, p.lon], {
        interactive: false, keyboard: false,
        icon: L.divIcon({ className: '', html: `<span class="ms">${fmtKm(p.km)}</span>`, iconSize: null, iconAnchor: [-7, 7] })
      }).addTo(msLayer);
    }
  }
}

function drawPoint() {
  pointLayer.clearLayers();
  pointMarker = null;
  if (!view.point) return;

  const q = view.point.quality;
  const cls = q === 'naechster' ? 'bad' : q === 'karte' ? 'warn' : '';
  pointMarker = L.marker([view.point.lat, view.point.lon], {
    icon: L.divIcon({ className: '', html: `<div class="pin ${cls}"></div>`, iconSize: [26, 26], iconAnchor: [13, 24] }),
    zIndexOffset: 1000
  }).addTo(pointLayer);
}

/* ============================ Klick auf die Karte ============================ */

/** Wie viele Meter sind CLICK_TOL_PX auf der aktuellen Zoomstufe? */
function toleranceMeters(latlng) {
  const a = map.latLngToContainerPoint(latlng);
  const b = map.containerPointToLatLng(L.point(a.x + CLICK_TOL_PX, a.y));
  return Math.max(map.distance(latlng, b), 25);
}

async function onMapClick(ev) {
  if (view.busy) return;
  const { lat, lng } = ev.latlng;
  closeSuggest();

  const e = view.ref && lineCache.get(view.ref);
  const tol = toleranceMeters(ev.latlng);

  if (e && e.sorted.length > 1) {
    let hit = projectOnLine(e.sorted, lat, lng);

    // Am Rand der geladenen Daten weiterladen — aber nur, wenn der Klick
    // überhaupt in Reichweite der Strecke liegt. Sonst ist es eine andere Gegend.
    const nearest = e.sorted.reduce((a, b) =>
      haversine(lat, lng, b.lat, b.lon) < haversine(lat, lng, a.lat, a.lon) ? b : a);
    const gap = haversine(lat, lng, nearest.lat, nearest.lon);

    if ((!hit || hit.dist > tol) && gap < 25000) {
      const first = e.sorted[0], last = e.sorted[e.sorted.length - 1];
      const towardsEnd = Math.abs(nearest.km - last.km) < Math.abs(nearest.km - first.km);
      const nextKm = towardsEnd ? last.km + 15 : first.km - 15;
      if (!e.probes.some(p => Math.abs(p - nextKm) < 0.75)) {
        setBusy(true);
        try { await coverage(view.ref, nextKm); } catch { /* dann eben nicht */ }
        setBusy(false);
        hit = projectOnLine(lineCache.get(view.ref).sorted, lat, lng);
        drawMilestones();
      }
    }

    if (hit && hit.dist <= tol) {
      applyPoint(view.ref, hit.km, {
        lat: hit.lat, lon: hit.lon, quality: 'karte',
        between: hit.between, offset: hit.dist,
        operator: e.sorted[0].operator, lineRef: view.ref
      });
      coverage(view.ref, hit.km).then(drawMilestones).catch(() => { });
      return;
    }
  }

  await lookupByClick(lat, lng);
}

/** Kürzester Abstand eines Punktes zu einem Weg (Meter). */
function distToWay(lat, lon, geometry) {
  if (!geometry || geometry.length === 0) return Infinity;
  if (geometry.length === 1) return haversine(lat, lon, geometry[0].lat, geometry[0].lon);

  const ky = 110540, kx = Math.cos(lat * Math.PI / 180) * 111320;
  const px = lon * kx, py = lat * ky;
  let best = Infinity;

  for (let i = 1; i < geometry.length; i++) {
    const ax = geometry[i - 1].lon * kx, ay = geometry[i - 1].lat * ky;
    const dx = geometry[i].lon * kx - ax, dy = geometry[i].lat * ky - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
  }
  return best;
}

/** Welche Strecke liegt an dieser Stelle? Das kann nur Overpass beantworten.
 *  Die Kandidaten werden nach echtem Abstand zum Klick sortiert — an einem
 *  Bahnhof liegen sonst ein halbes Dutzend gleichrangiger Nummern nebeneinander. */
async function linesNear(lat, lon) {
  const q = `[out:json][timeout:25];` +
    `way(around:80,${lat},${lon})[railway~"^(rail|light_rail|narrow_gauge)$"][ref]->.w;` +
    `node(around:900,${lat},${lon})[railway=milestone]->.n;` +
    `.w out tags geom 40;` +
    `.n out body 80;`;      // body, nicht tags — sonst fehlen die Koordinaten der Knoten

  let data = null, lastErr = null;
  for (const ep of OVERPASS) {
    try { data = await tryFetch(ep + '?data=' + encodeURIComponent(q), 25000); break; }
    catch (err) { lastErr = err; }
  }
  if (!data) throw new Error('Overpass nicht erreichbar (' + (lastErr && lastErr.message) + ')');

  const els = data.elements || [];

  // je Streckennummer den geringsten Abstand behalten
  const byRef = new Map();
  for (const w of els) {
    if (w.type !== 'way' || !w.tags || !w.tags.ref) continue;
    const d = distToWay(lat, lon, w.geometry);
    for (const part of String(w.tags.ref).split(';')) {
      const r = part.trim();
      if (!r) continue;
      if (!byRef.has(r) || byRef.get(r) > d) byRef.set(r, d);
    }
  }
  const refs = [...byRef.entries()]
    .sort((a, b) => a[1] - b[1])
    .slice(0, 4)
    .map(([ref, dist]) => ({ ref, dist }));

  // Nächster Kilometerstein als Startwert — die ORM-API braucht eine Position,
  // um überhaupt etwas ausliefern zu können.
  const stones = els
    .filter(n => n.type === 'node' && n.tags && n.tags['railway:position'] != null)
    .map(n => ({ km: parseFloat(String(n.tags['railway:position']).replace(',', '.')), dist: haversine(lat, lon, n.lat, n.lon) }))
    .filter(s => isFinite(s.km))
    .sort((a, b) => a.dist - b.dist);

  return { refs, seed: stones[0] || null };
}

async function lookupByClick(lat, lon) {
  setBusy(true);
  showStatus('Suche, welche Strecke hier liegt …');
  try {
    const { refs, seed } = await linesNear(lat, lon);
    if (!refs.length) {
      showError('Hier ist keine nummerierte Strecke erfasst. Näher an ein Gleis tippen.');
      return;
    }
    if (!seed) {
      showError(`Strecke ${refs.map(r => r.ref).join(' / ')} liegt hier, aber im Umkreis von 900 m ist kein Kilometerstein erfasst — der Kilometer lässt sich nicht bestimmen.`);
      return;
    }
    if (refs.length === 1) {
      await useLineAt(refs[0].ref, seed.km, lat, lon);
    } else {
      showPicker(refs, seed.km, lat, lon);
    }
  } catch (err) {
    showError('Umkreissuche fehlgeschlagen: ' + err.message);
  } finally {
    setBusy(false);
  }
}

/** Strecke laden und den Klickpunkt darauf projizieren. */
async function useLineAt(ref, seedKm, lat, lon) {
  setBusy(true);
  showStatus(`Lade Strecke ${ref} …`);
  try {
    view.ref = ref;
    $('#ref').value = ref;
    await coverage(ref, seedKm);
    const e = lineCache.get(ref);
    drawMilestones();

    const hit = projectOnLine(e.sorted, lat, lon);
    if (!hit) {
      showError(`Für Strecke ${ref} sind hier zu wenige Kilometersteine erfasst.`);
      return;
    }
    if (hit.dist > 400) {
      showError(`Der Punkt liegt ${nfM.format(hit.dist)} m von den erfassten Steinen der Strecke ${ref} entfernt — das wäre zu ungenau.`);
      return;
    }
    applyPoint(ref, hit.km, {
      lat: hit.lat, lon: hit.lon, quality: 'karte',
      between: hit.between, offset: hit.dist,
      operator: e.sorted[0].operator, lineRef: ref
    });
  } catch (err) {
    showError('Konnte Strecke ' + ref + ' nicht laden: ' + err.message);
  } finally {
    setBusy(false);
  }
}

function showPicker(refs, seedKm, lat, lon) {
  const b = $('#bottom');
  b.hidden = false;
  b.innerHTML = `<p class="bb-title">Mehrere Strecken an dieser Stelle</p>
    <p class="bb-sub">Sortiert nach Abstand zum Tippen — die erste liegt am nächsten.</p>
    <div class="pick">${refs.map(r =>
      `<button type="button" data-pick="${esc(r.ref)}">${esc(r.ref)}<small>${nfM.format(r.dist)} m</small></button>`).join('')}</div>`;
  b.querySelectorAll('[data-pick]').forEach(btn =>
    btn.addEventListener('click', () => useLineAt(btn.dataset.pick, seedKm, lat, lon)));
  updateBH();
}

/* ============================ Punkt setzen & anzeigen ============================ */

function applyPoint(ref, km, result) {
  view.ref = ref;
  view.km = km;
  view.point = result;
  if (trackLayer) trackLayer.clearLayers();   // Gleis-Overlay gehört zum alten Punkt

  $('#ref').value = ref;
  $('#km').value = fmtKm(km);

  drawPoint();
  drawMilestones();
  renderBottom();
  pushRecent(ref, km);
  updateHash();
}

function qualityTag(p) {
  if (p.quality === 'exakt') return { cls: 'ok', text: 'Kilometerstein' };
  if (p.quality === 'gleis') return { cls: 'ok', text: 'auf dem Gleis' };
  if (p.quality === 'interpoliert') {
    // Schwelle bei 50 m: die beiden dichten Steinabstände bleiben grün,
    // orange wird es erst, wenn die Steine wirklich weit auseinanderstehen.
    return { cls: p.err.worst > 50 ? 'warn' : 'ok', text: `interpoliert ±${nfM.format(p.err.worst)} m` };
  }
  if (p.quality === 'karte') return { cls: 'warn', text: 'von der Karte' };
  if (p.quality === 'betriebsstelle') return { cls: 'ok', text: 'Betriebsstelle' };
  const d = Math.abs(p.delta || 0);
  return { cls: d > 1 ? 'bad' : 'warn', text: `${fmtKm(d)} km daneben` };
}

function renderBottom() {
  const b = $('#bottom');
  const p = view.point;
  if (!p) { b.hidden = true; updateBH(); return; }

  const tag = qualityTag(p);
  let title, sub;

  // Feinrechnung nur anbieten, wo sie etwas bringt
  const refine = (p.quality === 'interpoliert' && p.chord > REFINE_MIN_CHORD)
    ? `<button type="button" id="refineBtn" class="refine">Punkt auf das Gleis rechnen` +
      `<small>folgt dem echten Verlauf statt der Luftlinie · braucht Netz, dauert einige Sekunden</small></button>`
    : '';

  if (p.quality === 'betriebsstelle') {
    const kindDe = { station: 'Bahnhof', halt: 'Haltepunkt', yard: 'Bahnhofsteil', junction: 'Abzweigstelle', service_station: 'Betriebsbahnhof', crossover: 'Überleitstelle' }[p.kind] || 'Betriebsstelle';
    title = p.name;
    sub = [kindDe, p.ds100 && 'DS100 ' + p.ds100, p.uic && 'UIC ' + p.uic, p.operator].filter(Boolean).join(' · ');
  } else {
    title = `Strecke ${p.lineRef || view.ref} · km ${fmtKm(view.km)}`;
    sub = p.operator || 'Kilometrierung nach OpenStreetMap';
  }

  // Kritisches steht sichtbar, Erklärendes klappt auf — sonst frisst die
  // Leiste den halben Bildschirm
  let warn = '', detail = '';

  if (p.quality === 'exakt') {
    detail = `Direkt die Lage des erfassten Steins. Wie genau der in OpenStreetMap sitzt, ` +
      `lässt sich nicht nachprüfen — aus dem Vergleich benachbarter Steine auf geraden Abschnitten ` +
      `ergibt sich eine Streuung in der Größenordnung von 10 m.`;
  } else if (p.quality === 'gleis') {
    detail = `Entlang des tatsächlichen Gleisverlaufs gerechnet statt geradlinig: ` +
      `${nfM.format(p.wegLaenge)} m Gleisweg zwischen den Steinen bei km ${fmtKm(p.between[0])} und ` +
      `${fmtKm(p.between[1])}, laut Kilometrierung ${nfM.format(p.nominal)} m. Der Punkt liegt damit ` +
      `${nfM.format(p.korrektur)} m von der geradlinigen Schätzung entfernt. Bleibt als Unsicherheit die ` +
      `Erfassungsgenauigkeit der Steine, Größenordnung 10 m.`;
  } else if (p.quality === 'naechster') {
    warn = `<p class="bb-note">Bei km ${fmtKm(view.km)} ist kein Stein erfasst. Angezeigt wird der nächstgelegene bei km ${fmtKm(p.nearKm)} — ${fmtKm(Math.abs(p.delta))} km Unterschied.</p>`;
    if (p.verworfen && p.verworfen.grund === 'luecke') {
      warn += `<p class="bb-note">Die nächsten Steine stehen bei km ${fmtKm(p.verworfen.von)} und ${fmtKm(p.verworfen.bis)} — ` +
        `${fmtKm(p.verworfen.entlang / 1000)} km Lücke. Über so weite Strecken wird nicht mehr interpoliert, ` +
        `weil der Verlauf dazwischen unbekannt ist.</p>`;
    } else if (p.verworfen && p.verworfen.grund === 'geometrie') {
      const v = p.verworfen;
      warn += `<p class="bb-note">Die Steine bei km ${fmtKm(v.von)} und ${fmtKm(v.bis)} wären Nachbarn, liegen aber ` +
        `${nfM.format(v.luftlinie)} m Luftlinie auseinander — bei nur ${nfM.format(v.entlang)} m entlang der Strecke ` +
        `ist das geometrisch unmöglich. Die beiden gehören nicht zusammen.</p>`;
      detail = `Solche Widersprüche entstehen, wenn dieselbe Streckennummer in OpenStreetMap an mehreren Stellen vergeben ist oder Steine falsch erfasst wurden.`;
    }
  } else if (p.quality === 'karte') {
    detail = `Aus dem Kartentipp abgeleitet, zwischen den Steinen bei km ${fmtKm(p.between[0])} und ${fmtKm(p.between[1])}` +
      (p.offset > 15 ? `, ${nfM.format(p.offset)} m querab der Linie` : '') + `.`;
  } else if (p.quality === 'interpoliert') {
    // Der Steinabstand ist der eigentliche Genauigkeitsfaktor, nicht die Rechnung selbst
    detail = `Geradlinig gerechnet zwischen den Steinen bei km ${fmtKm(p.between[0])} und ${fmtKm(p.between[1])}, ` +
      `${nfM.format(p.chord)} m auseinander. Im Vergleich mit tatsächlich erfassten Zwischensteinen lag das ` +
      `typisch ${nfM.format(p.err.typical)} m daneben, im ungünstigen Zehntel ${nfM.format(p.err.worst)} m — ` +
      `darin steckt auch die Streuung der Steinerfassung selbst.`;
    if (p.err.worst > 60) {
      warn = `<p class="bb-note">Die Steine stehen ${nfM.format(p.chord)} m auseinander. In dieser Größenordnung schlägt die Streckenkrümmung durch — bis zu ${nfM.format(p.err.worst)} m Abweichung.</p>`;
    }
    if (p.spanRatio < 0.75) {
      warn += `<p class="bb-note">Luftlinie und Kilometerdifferenz passen nicht zusammen (${Math.round(p.spanRatio * 100)} %) — starker Bogen oder Kilometersprung.</p>`;
    }
  }

  b.hidden = false;
  b.innerHTML = `
    <div class="bb-head">
      <p class="bb-title">${esc(title)}</p>
      <span class="tag ${tag.cls}">${esc(tag.text)}</span>
    </div>
    <p class="bb-coord">${fmtCoord(p.lat, p.lon)}</p>
    ${warn}
    ${refine}
    <details class="bb-more">
      <summary>Herkunft &amp; Genauigkeit</summary>
      <p class="bb-note plain">${esc(sub)}${detail ? ' · ' + esc(detail) : ''}</p>
    </details>
    <div class="bb-actions">
      <a class="maps" href="${gmapsUrl(p.lat, p.lon)}" target="_blank" rel="noopener">In Google Maps öffnen</a>
      <a href="${gmapsRoute(p.lat, p.lon)}" target="_blank" rel="noopener">Route</a>
      <button type="button" id="copyBtn">Kopieren</button>
    </div>`;

  bindBottom();
  updateBH();
}

/** Ereignisse der unteren Leiste — separat, weil die Leiste neu gezeichnet wird. */
function bindBottom() {
  const copy = $('#copyBtn');
  if (copy) copy.addEventListener('click', async () => {
    const p = view.point;
    if (!p) return;
    toast(await copyText(fmtCoord(p.lat, p.lon)) ? 'Koordinaten kopiert' : 'Kopieren nicht möglich');
  });

  const refine = $('#refineBtn');
  if (refine) refine.addEventListener('click', refineOnTrack);

  const more = $('.bb-more');
  if (more) more.addEventListener('toggle', updateBH);
}

function showStatus(msg) {
  const b = $('#bottom');
  b.hidden = false;
  b.innerHTML = `<p class="bb-sub">${esc(msg)}</p>`;
  updateBH();
}

function showError(msg) {
  const b = $('#bottom');
  b.hidden = false;
  b.innerHTML = `<p class="bb-err">${esc(msg)}</p>`;
  updateBH();
}

/** Leaflet-Bedienelemente über der unteren Leiste halten */
function updateBH() {
  const b = $('#bottom');
  const h = b.hidden ? 0 : Math.round(b.getBoundingClientRect().height) + 18;
  document.documentElement.style.setProperty('--bh', h + 'px');
}

function setBusy(on) {
  view.busy = on;
  $('#progress').hidden = !on;
  $('#go').classList.toggle('busy', on);
}

/* ============================ Suche über die Felder ============================ */

async function search() {
  if (view.busy) return;
  closeSuggest();

  const ref = $('#ref').value.trim();
  const kmRaw = $('#km').value.trim();

  if (!ref) { toast('Bitte eine Streckennummer eingeben.'); $('#ref').focus(); return; }

  setBusy(true);
  try {
    if (!kmRaw) {
      // Nur Strecke: Anfang der Strecke zeigen, damit man sich orientieren kann
      view.ref = ref;
      await coverage(ref, 0);
      const e = lineCache.get(ref);
      if (!e.sorted.length) { showError(`Für Strecke ${ref} sind keine Kilometersteine erfasst — Nummer prüfen.`); return; }
      view.point = null;
      drawPoint();
      drawMilestones();
      fitLine(e);
      showStatus(`Strecke ${ref}: ${e.sorted.length} Kilometersteine geladen. Auf die Linie tippen setzt einen Punkt.`);
      return;
    }

    const km = toKm(kmRaw);
    if (!isFinite(km)) { toast('Kilometer nicht lesbar — z. B. 12,5 oder 14+250.'); return; }

    view.ref = ref;
    const res = await resolvePoint(ref, km);
    applyPoint(ref, km, res);
    map.setView([res.lat, res.lon], Math.max(map.getZoom(), 15));
  } catch (err) {
    showError(err.message || 'Abfrage fehlgeschlagen.');
  } finally {
    setBusy(false);
  }
}

function fitLine(e) {
  const pts = e.sorted.map(p => [p.lat, p.lon]);
  if (!pts.length) return;
  if (pts.length === 1) map.setView(pts[0], 15);
  else map.fitBounds(L.latLngBounds(pts), { paddingTopLeft: [30, 90], paddingBottomRight: [30, 130], maxZoom: 15 });
}

/* ============================ Betriebsstellen ============================ */

async function runFacility() {
  const q = $('#facQ').value.trim();
  const out = $('#facOut');
  if (!q) { out.innerHTML = ''; return; }
  out.innerHTML = '<p class="fine">Suche …</p>';
  try {
    const list = await searchFacility(q);
    if (!list.length) { out.innerHTML = `<p class="fine">Nichts zu „${esc(q)}" gefunden.</p>`; return; }
    out.innerHTML = list.map((f, i) => {
      const meta = [f.ds100 && 'DS100 ' + f.ds100, f.uic && 'UIC ' + f.uic, f.operator].filter(Boolean).join(' · ');
      return `<button class="fac-item" type="button" data-fac="${i}">${esc(f.name)}<small>${esc(meta || 'Betriebsstelle')}</small></button>`;
    }).join('');
    out.querySelectorAll('[data-fac]').forEach(btn => btn.addEventListener('click', () => {
      const f = list[Number(btn.dataset.fac)];
      view.km = null;
      view.point = { ...f, quality: 'betriebsstelle' };
      $('#km').value = '';
      drawPoint();
      renderBottom();
      map.setView([f.lat, f.lon], 16);
      closeSheet();
    }));
  } catch (err) {
    out.innerHTML = `<p class="fine">Suche fehlgeschlagen: ${esc(err.message)}</p>`;
  }
}

/* ============================ Standort ============================ */

function locate() {
  if (!navigator.geolocation) { toast('Standortbestimmung wird nicht unterstützt.'); return; }
  if (!window.isSecureContext) { toast('Standort geht nur über HTTPS.'); return; }
  closeSheet();
  toast('Standort wird ermittelt …');
  navigator.geolocation.getCurrentPosition(pos => {
    const { latitude: lat, longitude: lon, accuracy } = pos.coords;
    meLayer.clearLayers();
    L.marker([lat, lon], {
      icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [16, 16], iconAnchor: [8, 8] })
    }).addTo(meLayer);
    L.circle([lat, lon], { radius: Math.max(accuracy || 0, 5), color: '#2f81f7', weight: 1, fillOpacity: 0.12 }).addTo(meLayer);
    map.setView([lat, lon], 16);
    toast(`Standort auf ±${nfM.format(accuracy || 0)} m genau — auf die Strecke tippen für den Kilometer.`);
  }, err => {
    toast('Standort nicht verfügbar: ' + (err.message || 'unbekannt'));
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 });
}

/* ============================ Verlauf ============================ */

function loadStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    const wms = { ...prefs.wms, ...((raw.prefs && raw.prefs.wms) || {}) };
    prefs = { ...prefs, ...(raw.prefs || {}), wms };
    recent = Array.isArray(raw.recent) ? raw.recent : [];
  } catch { /* defekter Speicher — Standardwerte behalten */ }
}

function saveStore() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ prefs, recent })); } catch { /* voll oder gesperrt */ }
}

function pushRecent(ref, km) {
  const entry = { ref, km };
  recent = [entry, ...recent.filter(r => !(r.ref === ref && Math.abs(r.km - km) < 1e-6))].slice(0, 12);
  saveStore();
}

function openSuggest() {
  const box = $('#suggest');
  const typed = $('#ref').value.trim().toLowerCase();
  const list = recent.filter(r => !typed || String(r.ref).toLowerCase().startsWith(typed)).slice(0, 6);
  if (!list.length) { closeSuggest(); return; }

  box.innerHTML = list.map((r, i) =>
    `<button class="suggest-item" type="button" role="option" data-rec="${i}">
       <b>${esc(r.ref)}</b><span>km ${esc(fmtKm(r.km))}</span>
     </button>`).join('');
  box.querySelectorAll('[data-rec]').forEach(btn => btn.addEventListener('mousedown', ev => {
    ev.preventDefault();   // Blur des Feldes verhindern, sonst schließt die Liste zuerst
    const r = list[Number(btn.dataset.rec)];
    $('#ref').value = r.ref;
    $('#km').value = fmtKm(r.km);
    closeSuggest();
    search();
  }));
  box.hidden = false;
}

function closeSuggest() { $('#suggest').hidden = true; }

/* ============================ Menü, Einstellungen, Link ============================ */

function openSheet() {
  $('#sheet').hidden = false;
  $('#menuBtn').classList.add('is-on');
  $('#menuBtn').setAttribute('aria-expanded', 'true');
  closeSuggest();
}

function closeSheet() {
  $('#sheet').hidden = true;
  $('#menuBtn').classList.remove('is-on');
  $('#menuBtn').setAttribute('aria-expanded', 'false');
}

function applyTheme() {
  const el = document.documentElement;
  if (prefs.theme === 'auto') el.removeAttribute('data-theme');
  else el.setAttribute('data-theme', prefs.theme);
  syncButtons();
}

function syncButtons() {
  document.querySelectorAll('[data-base]').forEach(b =>
    b.classList.toggle('is-on', b.dataset.base === (prefs.base || 'osm')));
  document.querySelectorAll('[data-theme]').forEach(b =>
    b.classList.toggle('is-on', b.dataset.theme === (prefs.theme || 'auto')));
  const orm = $('#ormBtn');
  if (orm && map) orm.classList.toggle('is-on', map.hasLayer(ormLayer));

  const wt = $('#wmsToggle');
  if (wt) {
    wt.classList.toggle('is-on', !!(prefs.wms && prefs.wms.on));
    wt.textContent = prefs.wms && prefs.wms.on ? 'Ausblenden' : 'Anzeigen';
  }
}

function updateHash() {
  const p = new URLSearchParams();
  if (view.ref) p.set('r', view.ref);
  if (view.km != null) p.set('k', String(view.km));
  const hash = '#' + p.toString();
  try { window.history.replaceState(null, '', hash); } catch { location.hash = hash; }
}

function readHash() {
  const h = location.hash.replace(/^#/, '');
  if (!h) return false;
  const p = new URLSearchParams(h);
  const r = p.get('r');
  if (!r) return false;
  $('#ref').value = r;
  const k = p.get('k');
  if (k != null && k !== '') $('#km').value = fmtKm(toKm(k));
  return true;
}

async function share() {
  const url = location.origin + location.pathname + location.hash;
  const title = view.point && view.km != null
    ? `Strecke ${view.ref} km ${fmtKm(view.km)}`
    : 'Railnav';
  if (navigator.share) {
    try { await navigator.share({ title, text: title, url }); return; }
    catch { /* abgebrochen — dann kopieren */ }
  }
  toast(await copyText(url) ? 'Link kopiert' : 'Kopieren nicht möglich');
}

/* ============================ Start ============================ */

function bind() {
  $('#go').addEventListener('click', search);
  $('#menuBtn').addEventListener('click', () => $('#sheet').hidden ? openSheet() : closeSheet());

  $('#ref').addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); closeSuggest(); $('#km').focus(); }
    if (ev.key === 'Escape') closeSuggest();
  });
  $('#ref').addEventListener('focus', openSuggest);
  $('#ref').addEventListener('input', openSuggest);
  $('#ref').addEventListener('blur', () => setTimeout(closeSuggest, 120));

  $('#km').addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); search(); ev.target.blur(); }
  });
  $('#km').addEventListener('focus', closeSuggest);

  $('#facQ').addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); runFacility(); } });
  $('#facGo').addEventListener('click', runFacility);

  document.querySelectorAll('[data-base]').forEach(b => b.addEventListener('click', () => setBase(b.dataset.base)));
  $('#ormBtn').addEventListener('click', toggleOrm);
  document.querySelectorAll('[data-theme]').forEach(b => b.addEventListener('click', () => {
    prefs.theme = b.dataset.theme;
    applyTheme();
    saveStore();
  }));

  $('#locBtn').addEventListener('click', locate);
  $('#shareBtn').addEventListener('click', share);

  // WMS: Adresse und Layer merken, Zugangsdaten bleiben beim Browser
  $('#wmsUrl').value = prefs.wms.url || '';
  $('#wmsLayers').value = prefs.wms.layers || '';
  $('#wmsOpacity').value = prefs.wms.opacity || 75;

  const wmsSave = () => {
    prefs.wms.url = $('#wmsUrl').value.trim();
    prefs.wms.layers = $('#wmsLayers').value.trim();
    saveStore();
    if (prefs.wms.on) wmsApply(true);      // mit neuen Angaben neu aufbauen
  };
  $('#wmsUrl').addEventListener('change', wmsSave);
  $('#wmsLayers').addEventListener('change', wmsSave);

  $('#wmsOpacity').addEventListener('input', ev => {
    prefs.wms.opacity = Number(ev.target.value);
    if (wmsLayer) wmsLayer.setOpacity(prefs.wms.opacity / 100);
  });
  $('#wmsOpacity').addEventListener('change', saveStore);

  $('#wmsLogin').addEventListener('click', () => { wmsSave(); wmsLogin(); });
  $('#wmsToggle').addEventListener('click', () => { wmsSave(); wmsApply(!prefs.wms.on); });
  $('#wmsLoad').addEventListener('click', () => { wmsSave(); wmsLoadLayers(); });
  $('#wmsParse').addEventListener('click', () => {
    const xml = $('#wmsXml').value.trim();
    if (!xml) { toast('Bitte das XML einfügen.'); return; }
    try { wmsShowLayers(parseWmsCapabilities(xml)); }
    catch (err) { toast('XML nicht lesbar: ' + err.message); }
  });

  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { closeSheet(); closeSuggest(); }
  });

  window.addEventListener('resize', updateBH);
}

function boot() {
  loadStore();
  applyTheme();
  initMap();
  bind();

  if (readHash()) search();
  else if (recent[0]) $('#ref').value = recent[0].ref;

  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* Offlinebetrieb ist optional */ });
  }
}

document.addEventListener('DOMContentLoaded', boot);
