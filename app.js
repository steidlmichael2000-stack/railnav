/* Railnav — Streckenkilometer auf der Karte
 *
 * Zwei Richtungen:
 *   Strecke + km  → Position   (OpenRailwayMap-API, dazwischen wird interpoliert)
 *   Klick/Karte   → Strecke + km (Projektion auf die geladenen Kilometersteine)
 *
 * Die API kennt nur die erste Richtung; die zweite rechnet der Browser aus den
 * bereits geladenen Steinen. Nur wenn weit weg von der geladenen Strecke geklickt
 * wird, muss Overpass sagen, welche Strecke dort überhaupt liegt.
 *
 * Copyright (C) 2026 Michael Steidl
 *
 * Dieses Programm ist freie Software: Sie können es unter den Bedingungen der
 * GNU General Public License, Version 3, weitergeben und/oder verändern.
 * Es wird ohne jede Gewährleistung bereitgestellt — siehe die Datei LICENSE
 * oder <https://www.gnu.org/licenses/>.
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

/* Und für die Rechnung entlang des echten Gleises noch einmal weiter.
 *
 * MAX_GAP_KM begrenzt die geradlinige Interpolation, weil dort jenseits von
 * 8 km die Datenlage zu dünn war, um sie zu belegen. Am Gleisverlauf entlang
 * gilt das nicht: An 1802 übersprungenen Zwischensteinen nachgemessen liegt
 * der Fehler bei 8–15 km Steinabstand im Median bei 16 m und im ungünstigen
 * Zehntel bei 52 m, bei 15–25 km bei 19 und 42 m — also nicht schlechter als
 * bei 3–8 km (25 und 106 m). Die Prüfung Gleisweg gegen Kilometerdifferenz
 * fängt die Fehlpaare ohnehin ab.
 *
 * Gemeldet an Strecke 5321 bei 49,520913 / 10,274394: Der Punkt liegt 15 m
 * vom Gleis, aber in einer Steinlücke von 9 km zwischen km 87,2 und 96,2 —
 * mit der alten Grenze wurde dieses Paar gar nicht erst gebildet. */
const MAX_GLEIS_GAP_KM = 25;
const CLICK_TOL_PX = 34;     // Klicktoleranz quer zur Strecke
/* Ab wie viel abgeschnittenem Weg lohnt es, den Kilometer entlang des Gleises
 * statt über die Sehne zu lesen? Gemessen an 553 Zwischensteinen — siehe
 * kartePunkt(). Nur wirksam, wo der Verlauf mitgeliefert ist. */
const UMWEG_GRENZE = 200;
/* Toleranz quer zur Strecke für einen gesetzten Punkt statt eines Fingertipps —
 * etwa aus einer KML-Datei. Dessen Koordinate steht fest und soll nicht je nach
 * Zoomstufe an eine andere Linie springen; 80 m ist derselbe Umkreis, mit dem
 * linesNear nach der Strecke unter dem Punkt sucht. */
const PUNKT_TOL = 80;
/* Wie weit wird nach einer Kilometerangabe gesucht, die der ORM-Abfrage als
 * Startwert dient? Der Wert muss nur grob stimmen — die API liefert danach die
 * Steine ringsum.
 *
 * Anfangs standen hier 4 km, mit der Begründung, weiter hinauszuschauen bringe
 * Angaben fremder Strecken ins Spiel. Gemeldet an Strecke 5321 bei 49,520913 /
 * 10,274394 lag der nächste Kilometerpunkt aber 4038 m entfernt — 38 m zu weit,
 * und die Suche fiel auf einen Notbehelf zurück, der die falsche Seite erwischte.
 * Aus den Kacheln lassen sich die Punkte ohnehin der Strecke zuordnen, auf der
 * sie stehen; damit ist der weite Radius unbedenklich. */
const SEED_RADIUS = 12000;
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

/* Ereignis und Wert nur setzen, wenn das Element existiert.
 * Passen HTML und Skript einmal nicht zusammen — etwa weil der Browser eine
 * ältere Seite aus dem Cache hält —, soll nicht die ganze App an einer
 * fehlenden Schaltfläche scheitern. */
const on = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, fn); return el; };
const setVal = (sel, v) => { const el = $(sel); if (el) el.value = v; };
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
  } catch (err) {
    /* Bricht der Abruf an der Zeitgrenze ab, meldet der Browser das als
     * "signal is aborted without reason" — das hilft niemandem weiter. */
    if (err.name === 'AbortError') throw new Error(`keine Antwort binnen ${Math.round(timeout / 1000)} s`);
    if (err.name === 'TypeError') throw new Error('keine Verbindung');
    throw err;
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
      throw new Error(err.message || 'Netzwerkfehler');
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

  // Jenseits des äußersten Steins: am Gleis entlang hinauslaufen statt aufgeben
  if (e.sorted.length > 1) {
    const hinaus = await extrapolieren(ref, km, e.sorted);
    if (hinaus) return hinaus;
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

/* Und in der anderen Richtung: Wie genau ist der Kilometer, der aus einem Tipp
 * auf die Karte gelesen wird? Nachgemessen an 2060 echten Steintripeln — den
 * mittleren Stein übersprungen, seine wahre Lage auf die Sehne der beiden
 * Nachbarn projiziert und den dort gelesenen Kilometer mit seinem echten
 * verglichen. Das ist genau dieser Fall, nur mit bekannter Wahrheit:
 *
 *   Steinabstand   Median   90. Perzentil
 *   unter 250 m      10 m       33 m
 *   250– 700 m       14 m       47 m
 *   700–1200 m       20 m       57 m
 *  1200–2000 m       19 m       56 m
 *  2000–3100 m       17 m       60 m
 *
 * Zwei Dinge fallen auf: Jenseits von 700 m wächst der Fehler nicht weiter, und
 * getrennt nach Krümmung liegen nahezu gerade Abschnitte bei 14/49 m, ausgeprägte
 * Bögen bei 19/71 m. Die Sehnennäherung ist hier also kaum schuld — beim Tippen
 * steht die Position ja fest, und entlang eines Kreisbogens ist die Projektion
 * auf die Sehne fast proportional zur Bogenlänge, weil sich die Abweichung zur
 * Mitte hin aufhebt. Übrig bleibt die Erfassungsgenauigkeit der Steine.
 *
 * Deshalb gibt es in dieser Richtung bewusst keine Feinrechnung entlang des
 * Gleises: Sie könnte nur diese wenigen Meter wegnehmen und kostet eine
 * Overpass-Abfrage von einigen Sekunden.
 *
 * Mehr als 3 km Steinabstand kommen hier nicht vor: Weiter auseinanderliegende
 * Steine werden fürs Zeichnen und Antippen gar nicht verbunden (MAX_DRAW_GAP_KM).
 */
const TAP_ERR = [
  { upTo: 250, typical: 10, worst: 33 },
  { upTo: 700, typical: 14, worst: 47 },
  { upTo: 1200, typical: 20, worst: 57 },
  { upTo: 2000, typical: 19, worst: 56 },
  { upTo: Infinity, typical: 17, worst: 60 }
];

function tapError(chordM) {
  return TAP_ERR.find(r => chordM < r.upTo);
}

/* Und der dritte Fall: Kilometer aus der Karte gelesen, wo überhaupt kein
 * brauchbares Steinpaar mehr da ist und stattdessen der echte Gleisverlauf
 * gemessen wird.
 *
 * Nachgemessen wie die beiden Tabellen darüber, an 13 übersprungenen
 * Zwischensteinen auf den Strecken 5321, 5500 und 5741 mit 3,0–6,8 km
 * Steinabstand. Das überraschende Ergebnis: Im Mittel nehmen sich Sehne und
 * Gleisweg nichts (22 m gegenüber 21 m). Der Unterschied steckt im Schwanz —
 * die Sehne lag in 3 der 13 Fälle über 100 m daneben, bis zu 186 m, der
 * Gleisweg in keinem einzigen. Und man sieht dem Ergebnis nicht an, in welchem
 * der beiden Fälle man gerade steckt.
 *
 * Deshalb wird hier gerechnet und nicht geschätzt, obwohl der Median dasselbe
 * sagt. Die Streuung des Vergleichssteins steckt in beiden Zahlen mit drin. */
const GLEIS_ERR = { typical: 21, worst: 88, sehne: 186, ueber100: 3, faelle: 13 };

/* Und jenseits des äußersten Steins, wo es gar kein Paar mehr gibt.
 *
 * Nachgemessen an 148 Außensteinen: den äußersten übersprungen, vom nächsten
 * aus am Gleis entlang hinausgelaufen und mit seiner wahren Lage verglichen.
 * Mit der Selbstprobe (siehe extrapolieren()) bleiben 127 Fälle übrig — Median
 * 35 m, ungünstiges Zehntel 93 m, schlechtester 746 m. Der nächstgelegene
 * Stein, den die App vorher zeigte, lag im Median 264 m daneben. Besser in 119
 * von 127 Fällen. */
const EXTRA_ERR = { typical: 35, worst: 93, stein: 264, faelle: 148 };

/** Nächster Punkt auf dem Streckenzug der Kilometersteine — liefert auch den Kilometer dort.
 *
 * maxGap steuert, wie weit zwei Steine auseinanderstehen dürfen, um noch
 * verbunden zu werden. Voreinstellung ist die enge Grenze fürs Zeichnen und
 * Antippen; die Feinrechnung entlang des Gleises sucht mit MAX_GAP_KM ein
 * Steinpaar auch über weite Lücken, weil sie danach ohnehin dem echten Verlauf
 * folgt und nicht der Sehne. */
function projectOnLine(sorted, lat, lon, maxGap = MAX_DRAW_GAP_KM) {
  if (!sorted || sorted.length < 2) return null;

  // Lokale ebene Näherung in Metern; auf diesen Entfernungen völlig ausreichend
  const ky = 110540, kx = Math.cos(lat * Math.PI / 180) * 111320;
  const px = lon * kx, py = lat * ky;
  let best = null;

  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1], b = sorted[i];
    if (!segmentOk(a, b, maxGap)) continue;   // Lücken und Fehlpaare überspringen
    const dkm = b.km - a.km;

    const ax = a.lon * kx, ay = a.lat * ky;
    const dx = b.lon * kx - ax, dy = b.lat * ky - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));

    const cx = ax + t * dx, cy = ay + t * dy;
    const dist = Math.hypot(px - cx, py - cy);
    if (!best || dist < best.dist) {
      // chord entscheidet, welche Zeile von TAP_ERR gilt; spanRatio verraet
      // Kilometerspruenge und falsch zusammengepaarte Steine.
      const chord = Math.sqrt(len2);
      best = { dist, km: a.km + t * dkm, lat: cy / ky, lon: cx / kx,
        between: [a.km, b.km], chord, a, b,
        spanRatio: dkm ? chord / (Math.abs(dkm) * 1000) : null };
    }
  }
  return best;
}

/* ============================ Mitgeliefertes Netz ============================ */

/* Zwei Fragen brauchten bisher zwingend Overpass: „welche Strecke liegt hier"
 * und „wie verläuft das Gleis zwischen diesen beiden Steinen". Beides ist der
 * unzuverlässigste Teil der App — beim Bau dieser Fassung antwortete Overpass
 * reihenweise mit 429 und 504 und brauchte bis zu 92 s, bis alle drei
 * Instanzen aufgegeben hatten, während die ORM-API jedes Mal unter einer
 * Sekunde lieferte.
 *
 * Deshalb liegen die Gleise jetzt als Kacheln bei, erzeugt von
 * werkzeug/netz-bauen.py aus OpenStreetMap. Overpass bleibt der Rückfall für
 * alles außerhalb des erzeugten Gebiets und für den Fall, dass die Kachel
 * keinen durchgehenden Weg hergibt.
 *
 * Warum nicht, wie zuerst überlegt, fertige Kilometerpunkte alle 100 m? Weil
 * das dieselbe Auskunft teurer schreibt: Die Stützpunkte aus OpenStreetMap
 * stehen gemessen im Mittel alle 46–55 m, kosten weniger Platz und häufen sich
 * dort, wo es krümmt, statt gleichmäßig über Geraden verteilt zu liegen. Und
 * ein Raster fester Punkte beantwortet die erste Frage nicht besser. */

const NETZ_PFAD = 'netz/';

/** Google-Polyline zurücklesen — dasselbe Format, das netz-bauen.py schreibt. */
function polylineDekodieren(s, faktor = 1e5) {
  const pts = [];
  let i = 0, lat = 0, lon = 0;
  while (i < s.length) {
    let wert, verschub, b;
    for (let achse = 0; achse < 2; achse++) {
      wert = 0; verschub = 0;
      do {
        b = s.charCodeAt(i++) - 63;
        wert |= (b & 0x1f) << verschub;
        verschub += 5;
      } while (b >= 0x20);
      const d = (wert & 1) ? ~(wert >> 1) : (wert >> 1);
      if (achse === 0) lat += d; else lon += d;
    }
    pts.push({ lat: lat / faktor, lon: lon / faktor });
  }
  return pts;
}

let netzIndexHolen = null;

/** Index einmal laden; false heißt „kein mitgeliefertes Netz vorhanden". */
function netzBereit() {
  if (!netzIndexHolen) {
    netzIndexHolen = (async () => {
      try {
        const r = await fetch(NETZ_PFAD + 'index.json');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const d = await r.json();
        const kacheln = d.kacheln || [];
        return {
          raster: d.raster || 0.5,
          stand: d.stand || '',
          mitInhalt: new Set(kacheln),
          da: new Set([...kacheln, ...(d.leer || [])])
        };
      } catch {
        return false;      // App läuft dann wie zuvor über Overpass
      }
    })();
  }
  return netzIndexHolen;
}

/* Entschlüsselte Kacheln bleiben liegen, aber nicht beliebig viele: Eine dichte
 * Kachel bringt einige zehntausend Stützpunkte mit, und wer quer durchs Land
 * fährt, sammelt sonst alles ein. Zwölf Kacheln sind rund 150 x 150 km um den
 * Arbeitsplatz herum — mehr braucht niemand gleichzeitig, und die Datei ist
 * über den Zwischenspeicher des Browsers sofort wieder da. */
const NETZ_KACHELN_MAX = 12;
const netzKacheln = new Map();     // Name → Versprechen auf {wege, punkte}

function netzKachel(name) {
  if (netzKacheln.has(name)) {
    // Wieder ans Ende der Map, damit die älteste zuerst weicht
    const p = netzKacheln.get(name);
    netzKacheln.delete(name);
    netzKacheln.set(name, p);
  } else {
    netzKacheln.set(name, (async () => {
      try {
        const r = await fetch(`${NETZ_PFAD}t_${name}.json`);
        if (!r.ok) return null;
        const d = await r.json();
        const wege = (d.w || []).map(w => {
          const geometry = polylineDekodieren(w.p);
          let s = 90, we = 180, n = -90, o = -180;
          for (const p of geometry) {
            if (p.lat < s) s = p.lat;
            if (p.lat > n) n = p.lat;
            if (p.lon < we) we = p.lon;
            if (p.lon > o) o = p.lon;
          }
          return { ref: w.r || '', geometry, bb: [s, we, n, o] };
        });
        const koord = d.p ? polylineDekodieren(d.p) : [];
        const punkte = koord.map((k, i) => ({ lat: k.lat, lon: k.lon, km: d.km[i] }));
        return { wege, punkte };
      } catch {
        return null;
      }
    })());
    while (netzKacheln.size > NETZ_KACHELN_MAX) {
      netzKacheln.delete(netzKacheln.keys().next().value);
    }
  }
  return netzKacheln.get(name);
}

/* Den angezeigten Punkt auf das wirklich erfasste Gleis setzen.
 *
 * Der Kilometer wird weiter aus der Sehne zwischen zwei Steinen gelesen — an
 * 234 uebersprungenen Zwischensteinen nachgemessen ist die Sehne dabei besser
 * als die Rechnung entlang des Gleises (Median 15 gegen 25 m), weil beim
 * Tippen die Position ja feststeht und sich die Bogenabweichung zur Mitte hin
 * aufhebt. Uebrig bleibt die Erfassungsgenauigkeit der Steine.
 *
 * Die angezeigte Lage ist eine andere Frage. Der Punkt auf der Sehne liegt in
 * denselben 234 Faellen im Median 16 m neben dem Gleis, im ungünstigen Zehntel
 * 87 m, im schlechtesten Fall 378 m — bei einem gemeldeten Punkt an Strecke
 * 5321 waren es 128 m. Diese Koordinate geht in „In Google Maps öffnen",
 * „Route", „Kopieren" und „Teilen": Sie muss auf der Schiene liegen und nicht
 * im Feld daneben. Solange der Verlauf mitgeliefert ist, kostet das nichts.
 */
async function aufGleisSetzen(ref, lat, lon, umkreis) {
  const d = umkreis / 110540;
  const dLon = umkreis / (111320 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
  const bereich = await netzBereich(lat - d, lon - dLon, lat + d, lon + dLon);
  if (!bereich) return null;

  const passt = w => w.ref && String(w.ref).split(';').some(t => t.trim() === String(ref));
  let best = null;
  for (const w of bereich.wege) {
    if (!passt(w)) continue;                 // nur das Gleis dieser Strecke
    const t = projectOnPath(w.geometry.map(p => [p.lat, p.lon]), lat, lon);
    if (t && (!best || t.dist < best.dist)) best = t;
  }
  return best && best.dist <= umkreis ? best : null;
}

/** Alles Mitgelieferte in einem Rechteck — oder null, wenn dort nichts erzeugt wurde. */
async function netzBereich(sued, west, nord, ost) {
  const ix = await netzBereit();
  if (!ix) return null;

  const namen = [];
  for (let y = Math.floor(sued / ix.raster); y <= Math.floor(nord / ix.raster); y++) {
    for (let x = Math.floor(west / ix.raster); x <= Math.floor(ost / ix.raster); x++) {
      namen.push(y + '_' + x);
    }
  }
  // Eine einzige nicht erzeugte Kachel macht die Auskunft unvollständig —
  // dann lieber ganz über Overpass, als stillschweigend Gleise zu verlieren.
  if (!namen.length || !namen.every(n => ix.da.has(n))) return null;

  const teile = await Promise.all(namen.filter(n => ix.mitInhalt.has(n)).map(netzKachel));
  if (teile.some(t => t === null)) return null;

  const wege = [], punkte = [];
  for (const t of teile) {
    // Eine Kachel deckt rund 55 km ab; für den Graphen zählt nur das Rechteck
    for (const w of t.wege) {
      if (w.bb[0] > nord || w.bb[2] < sued || w.bb[1] > ost || w.bb[3] < west) continue;
      wege.push(w);
    }
    for (const p of t.punkte) {
      if (p.lat >= sued && p.lat <= nord && p.lon >= west && p.lon <= ost) punkte.push(p);
    }
  }
  return { wege, punkte };
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

async function railGeometry(a, b, pad = 0.012) {
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
  if (!data) {
    throw new Error('kein Overpass-Server hat geantwortet (' + (lastErr && lastErr.message || 'unbekannt') + ')');
  }
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

/* Einen Punkt in das Knotennetz einhängen — auch mitten auf einer Kante.
 *
 * Der nächste Stützpunkt allein genügt seit den mitgelieferten Kacheln nicht
 * mehr: Die Vereinfachung auf 5 m lässt auf Geraden Punkte weg. Gemessen sind
 * 23 % der Kanten länger als 160 m, die längste 1579 m. Ein Stein, der exakt
 * auf dem Gleis steht, lag damit plötzlich 271 m vom nächsten Stützpunkt
 * entfernt, und die Wegsuche brach mit „die Steine liegen zu weit vom Gleis"
 * ab — gemeldet an Strecke 5321 zwischen km 87,2 und 96,2, wo die Steine in
 * Wahrheit 0 m und 2 m neben der Linie stehen.
 *
 * Deshalb wird auf die Kante projiziert und, wenn der Fuß mittendrin liegt,
 * ein Knoten eingefügt. Die ursprüngliche Kante bleibt daneben stehen; sie ist
 * genauso lang wie der Umweg über den neuen Knoten und stört deshalb nicht. */
/* Nächste Kante — je Zusammenhangskomponente in einem einzigen Durchgang.
 *
 * Zuerst stand hier eine Suche je Komponente, also O(Teile × Kanten). In einem
 * weiten Ausschnitt mit vielen Teilstücken war das der Grund, warum ein weit
 * abgesetzter Tipp wieder ewig lud. Eine Runde reicht: Zu jeder Kante ist die
 * Komponente bekannt, das Beste wird je Nummer gemerkt. */
function kantenJeTeil(nodes, teil, lat, lon) {
  const ky = 110540, kx = Math.cos(lat * Math.PI / 180) * 111320;
  const px = lon * kx, py = lat * ky;
  const best = new Map();

  for (const [k1, n1] of nodes) {
    const nr = teil ? teil.get(k1) : 0;
    const ax = n1.lon * kx, ay = n1.lat * ky;
    for (const [k2] of n1.adj) {
      const n2 = nodes.get(k2);
      const dx = n2.lon * kx - ax, dy = n2.lat * ky - ay;
      const len2 = dx * dx + dy * dy;
      let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const cx = ax + t * dx, cy = ay + t * dy;
      const dist = Math.hypot(px - cx, py - cy);
      const alt = best.get(nr);
      if (!alt || dist < alt.dist) {
        best.set(nr, { dist, t, von: k1, nach: k2, lat: cy / ky, lon: cx / kx });
      }
    }
  }
  return best;
}

/** Beide Punkte in dieselbe Komponente einhängen; null, wenn keine beide trägt. */
function paarEinhaengen(nodes, A, B, grenze = 80) {
  const teil = komponenten(nodes);
  const a = kantenJeTeil(nodes, teil, A.lat, A.lon);
  const b = kantenJeTeil(nodes, teil, B.lat, B.lon);
  let wahl = null;
  for (const [nr, ka] of a) {
    const kb = b.get(nr);
    if (!kb) continue;
    const schlechter = Math.max(ka.dist, kb.dist);
    if (!wahl || schlechter < wahl.schlechter) wahl = { a: ka, b: kb, schlechter };
  }
  if (!wahl) return null;
  wahl.na = einfuegen(nodes, wahl.a);
  wahl.nb = einfuegen(nodes, wahl.b);
  return wahl;
}

function naechsteKante(nodes, lat, lon) {
  return kantenJeTeil(nodes, null, lat, lon).get(0) || null;
}

/** Die gefundene Stelle wirklich als Knoten einsetzen. */
function einfuegen(nodes, best) {
  if (!best) return { key: null, dist: Infinity };
  if (best.t <= 1e-9) return { key: best.von, dist: best.dist };
  if (best.t >= 1 - 1e-9) return { key: best.nach, dist: best.dist };

  const key = best.lat.toFixed(7) + ',' + best.lon.toFixed(7);
  if (!nodes.has(key)) {
    const neu = { lat: best.lat, lon: best.lon, adj: [] };
    nodes.set(key, neu);
    for (const k of [best.von, best.nach]) {
      const n = nodes.get(k);
      if (!n) continue;
      const d = haversine(neu.lat, neu.lon, n.lat, n.lon);
      neu.adj.push([k, d]);
      n.adj.push([key, d]);
    }
  }
  return { key, dist: best.dist };
}

/** Zusammenhangskomponenten: Knotenschlüssel → Nummer. */
function komponenten(nodes) {
  const teil = new Map();
  let nr = 0;
  for (const start of nodes.keys()) {
    if (teil.has(start)) continue;
    const stapel = [start];
    teil.set(start, nr);
    while (stapel.length) {
      const k = stapel.pop();
      for (const [nk] of nodes.get(k).adj) {
        if (teil.has(nk)) continue;
        teil.set(nk, nr);
        stapel.push(nk);
      }
    }
    nr++;
  }
  return teil;
}

/** Kleinster Eintrag zuerst — ein Binärhaufen, damit Dijkstra nicht jedes Mal
 *  die ganze Entfernungstabelle durchsuchen muss. Bei einem Bahnhof mit
 *  zehntausenden Stützpunkten war genau das der Unterschied zwischen einer
 *  Sekunde und einer stehenden Seite. */
class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(prio, val) {
    const a = this.a;
    a.push([prio, val]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a, top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/** Dijkstra über das Knotennetz. */
function shortestPath(nodes, startKey, endKey) {
  const dist = new Map([[startKey, 0]]);
  const prev = new Map();
  const done = new Set();
  const offen = new MinHeap();
  offen.push(0, startKey);

  for (;;) {
    let cur = null, curD = 0;
    // Veraltete Einträge stehen doppelt im Haufen — den schon erledigten Knoten
    // einfach überspringen ist billiger, als im Haufen zu suchen.
    while (offen.size) {
      const [d, k] = offen.pop();
      if (!done.has(k)) { cur = k; curD = d; break; }
    }
    if (cur === null) return null;          // nicht verbunden
    if (cur === endKey) break;
    done.add(cur);
    for (const [nk, w] of nodes.get(cur).adj) {
      if (done.has(nk)) continue;
      const nd = curD + w;
      if (nd < (dist.has(nk) ? dist.get(nk) : Infinity)) {
        dist.set(nk, nd); prev.set(nk, cur); offen.push(nd, nk);
      }
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

/** Umgekehrt: nächster Punkt auf dem Streckenzug — mit der Weglänge bis dorthin.
 *  along und len kommen aus derselben ebenen Näherung, ihr Verhältnis ist also
 *  frei vom kleinen Maßstabsfehler dieser Näherung. */
function projectOnPath(path, lat, lon) {
  if (!path || path.length < 2) return null;

  const ky = 110540, kx = Math.cos(lat * Math.PI / 180) * 111320;
  const px = lon * kx, py = lat * ky;
  let acc = 0, best = null;

  for (let i = 1; i < path.length; i++) {
    const ax = path[i - 1][1] * kx, ay = path[i - 1][0] * ky;
    const dx = path[i][1] * kx - ax, dy = path[i][0] * ky - ay;
    const len2 = dx * dx + dy * dy, seg = Math.sqrt(len2);
    let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));

    const cx = ax + t * dx, cy = ay + t * dy;
    const dist = Math.hypot(px - cx, py - cy);
    if (!best || dist < best.dist) {
      best = { dist, along: acc + t * seg, lat: cy / ky, lon: cx / kx };
    }
    acc += seg;
  }
  if (best) best.len = acc;
  return best;
}

/** Den gefundenen Verlauf über die Karte legen — er belegt, worauf gerechnet wurde. */
function zeichneGleisweg(path) {
  trackLayer.clearLayers();
  L.polyline(path, { color: '#22c55e', weight: 4, opacity: 0.9, interactive: false }).addTo(trackLayer);
}

/* Der Gleisweg zwischen zwei Steinen — beide Richtungen brauchen genau das:
 * km → Position folgt ihm vorwärts, Position → km misst daran entlang.
 *
 * Zuerst aus den mitgelieferten Kacheln; nur wenn dort nichts liegt oder sich
 * kein brauchbarer Weg findet, muss Overpass ran. Der Rückfall ist wichtig:
 * Die Kacheln lassen Anschluss- und Rangiergleise weg, und an einer Stelle,
 * wo der Verlauf ausgerechnet darüber führt, käme sonst gar nichts heraus. */
/* Rand um die Sehne, damit Bögen mitkommen, die daneben ausschlagen. Fest
 * 0,012° (gut 1,3 km) reichten nur bei kurzen Abständen: Zwischen den Steinen
 * bei km 87,2 und 96,2 der Strecke 5321 lief das Gleis aus dem Ausschnitt
 * heraus, der Weg wurde nicht gefunden und die Suche fiel auf Overpass zurück.
 * Mit dem Abstand wachsen lassen, aber gedeckelt. */
const verlaufRand = (A, B) => Math.min(0.06, 0.012 + Math.abs(B.km - A.km) * 0.002);

/** Liegt der Verlauf zwischen diesen Steinen mitgeliefert vor? Nur für die
 *  Wortwahl der Statusmeldung — die Kachel ist danach im Speicher. */
async function netzHatVerlauf(A, B) {
  const pad = verlaufRand(A, B);
  const b = await netzBereich(
    Math.min(A.lat, B.lat) - pad, Math.min(A.lon, B.lon) - pad,
    Math.max(A.lat, B.lat) + pad, Math.max(A.lon, B.lon) + pad);
  return !!(b && b.wege.length);
}

async function gleisWegZwischen(A, B, nurLokal = false) {
  const pad = verlaufRand(A, B);
  const lokal = await netzBereich(
    Math.min(A.lat, B.lat) - pad, Math.min(A.lon, B.lon) - pad,
    Math.max(A.lat, B.lat) + pad, Math.max(A.lon, B.lon) + pad);

  if (lokal && lokal.wege.length) {
    try { return wegAusWegen(lokal.wege, A, B); } catch { /* dann eben über Overpass */ }
  }
  // nurLokal: für Rechnungen, die sich nur lohnen, solange sie nichts kosten
  if (nurLokal) return null;

  const ways = await railGeometry(A, B, pad);
  if (!ways.length) throw new Error('keine Gleisgeometrie im Ausschnitt');
  return wegAusWegen(ways, A, B);
}

/** Aus Wegstücken den Gleisweg zwischen zwei Steinen suchen und plausibilisieren. */
function wegAusWegen(ways, A, B) {
  const nodes = buildGraph(ways);
  if (nodes.size > 60000) throw new Error('zu viele Gleise im Ausschnitt');

  /* Beide Steine in dieselbe Zusammenhangskomponente einhängen.
   *
   * Die geometrisch nächste Kante genügt nicht: In den Kacheln zerfällt das
   * Gleisnetz an manchen Stellen in mehrere Teile, und ein Stein sitzt dann
   * womöglich einen Meter neben einem abgehängten Stummel, während das
   * durchgehende Gleis zwei Meter weiter liegt. Gemeldet an Strecke 5321
   * zwischen km 96,42 und 100,0: Beide Steine hingen sich auf 1 m ein, und
   * trotzdem gab es keinen Weg — sie hingen in verschiedenen Teilen. */
  const wahl = paarEinhaengen(nodes, A, B);
  if (!wahl) throw new Error('keine Gleisgeometrie im Ausschnitt');
  if (wahl.schlechter > 80) {
    throw new Error(`die Steine liegen bis ${nfM.format(wahl.schlechter)} m vom nächsten durchgehenden Gleis entfernt`);
  }

  const sp = shortestPath(nodes, wahl.na.key, wahl.nb.key);
  if (!sp) throw new Error('kein durchgehender Gleisweg zwischen den beiden Steinen');

  /* Der kürzeste Weg im Gleisnetz muss nicht die Strecke sein — an einem
   * Bahnhof führt er auch mal über ein Nachbargleis. Passt seine Länge nicht
   * zur Kilometerdifferenz, ist er der falsche Weg. */
  const nominal = (B.km - A.km) * 1000;
  const ratio = sp.length / nominal;
  if (ratio < 0.8 || ratio > 1.3) {
    throw new Error(`der gefundene Gleisweg ist ${nfM.format(sp.length)} m lang, die Kilometerdifferenz aber ${nfM.format(nominal)} m`);
  }
  return { path: sp.path, length: sp.length, nominal };
}

/* ============================ Über den letzten Stein hinaus ============================ */

/* Wo die Kilometrierung anfängt oder aufhört, gab es bisher gar nichts: Für
 * einen Kilometer jenseits des äußersten Steins fehlt das einschließende Paar,
 * und die App zeigte den nächstgelegenen Stein mit „1,0 km daneben".
 *
 * Mit dem mitgelieferten Verlauf lässt sich stattdessen vom äußersten Stein aus
 * am Gleis entlanglaufen. Dass die Trasse dabei über den Nullpunkt hinausgeht,
 * ist kein Widerspruch — die Kilometrierungslinie beginnt oft später als die
 * Achse.
 */
const EXTRA_MAX_M = 3000;      // so weit hinaus reichen die Messwerte
const EXTRA_PROBE_M = 100;     // so nah muss die Selbstprobe den Nachbarstein treffen

/** Richtung von a nach b in Grad. */
function peilung(a, b) {
  const lat = (a.lat + b.lat) / 2 * Math.PI / 180;
  return (Math.atan2((b.lon - a.lon) * Math.cos(lat), b.lat - a.lat) * 180 / Math.PI + 360) % 360;
}

/** Am Gleis entlanglaufen, an jeder Weiche geradeaus.
 *
 * Bewusst nicht Dijkstra: Der kürzeste Weg sucht sich an einer Verzweigung
 * irgendeinen Ast und landet auf dem Nachbargleis. Eine Strecke folgt aber dem
 * geraden Durchgang — an einer Weiche biegt das durchgehende Hauptgleis nicht ab.
 */
function entlangLaufen(nodes, startKey, wegVon, strecke) {
  const start = nodes.get(startKey);
  if (!start || !start.adj.length) return null;

  const abstand = k => haversine(nodes.get(k).lat, nodes.get(k).lon, wegVon.lat, wegVon.lon);
  let vorher = startKey;
  let jetzt = start.adj.map(([k]) => k).reduce((a, b) => abstand(b) > abstand(a) ? b : a);
  if (abstand(jetzt) < haversine(start.lat, start.lon, wegVon.lat, wegVon.lon)) return null;

  let gelaufen = haversine(start.lat, start.lon, nodes.get(jetzt).lat, nodes.get(jetzt).lon);
  const besucht = new Set([startKey, jetzt]);
  const pfad = [[start.lat, start.lon], [nodes.get(jetzt).lat, nodes.get(jetzt).lon]];

  while (gelaufen < strecke) {
    const ein = peilung(nodes.get(vorher), nodes.get(jetzt));
    const weiter = nodes.get(jetzt).adj
      .map(([k]) => k).filter(k => k !== vorher && !besucht.has(k));
    if (!weiter.length) break;

    const kurve = k => Math.abs(((peilung(nodes.get(jetzt), nodes.get(k)) - ein + 540) % 360) - 180);
    const naechst = weiter.reduce((a, b) => kurve(b) < kurve(a) ? b : a);
    if (kurve(naechst) > 75) break;                // das ist ein Abzweig, keine Fortsetzung

    const a = nodes.get(jetzt), b = nodes.get(naechst);
    const d = haversine(a.lat, a.lon, b.lat, b.lon);
    if (gelaufen + d >= strecke) {
      const t = d > 0 ? (strecke - gelaufen) / d : 0;
      const ziel = { lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon) };
      pfad.push([ziel.lat, ziel.lon]);
      return { lat: ziel.lat, lon: ziel.lon, pfad, gelaufen: strecke };
    }
    gelaufen += d;
    besucht.add(naechst);
    pfad.push([b.lat, b.lon]);
    vorher = jetzt;
    jetzt = naechst;
  }
  const z = nodes.get(jetzt);
  return { lat: z.lat, lon: z.lon, pfad, gelaufen };
}

/** Kilometer jenseits des äußersten Steins — nur aus den mitgelieferten Kacheln. */
async function extrapolieren(ref, km, sorted) {
  const erster = sorted[0], letzter = sorted[sorted.length - 1];
  const unten = km < erster.km;
  if (!unten && km <= letzter.km) return null;

  const A = unten ? erster : letzter;
  const B = unten ? sorted[1] : sorted[sorted.length - 2];
  if (!B || !segmentOk(unten ? A : B, unten ? B : A, MAX_GLEIS_GAP_KM)) return null;

  const hinaus = Math.abs(A.km - km) * 1000;
  if (hinaus > EXTRA_MAX_M) return null;

  const weite = (hinaus + haversine(A.lat, A.lon, B.lat, B.lon)) * 1.6;
  const dLat = Math.max(0.02, weite / 110540);
  const dLon = dLat / Math.max(0.2, Math.cos(A.lat * Math.PI / 180));
  const bereich = await netzBereich(A.lat - dLat, A.lon - dLon, A.lat + dLat, A.lon + dLon);
  if (!bereich) return null;

  const gleise = bereich.wege.filter(w =>
    w.ref && String(w.ref).split(';').some(t => t.trim() === String(ref)));
  if (!gleise.length) return null;

  const nodes = buildGraph(gleise);
  if (!nodes.size || nodes.size > 60000) return null;
  // Auch hier beide Steine in dieselbe Zusammenhangskomponente — sonst läuft
  // der Lauf auf einem abgehängten Stummel los.
  const wahl = paarEinhaengen(nodes, A, B);
  if (!wahl || wahl.schlechter > 80) return null;
  const na = wahl.na, nb = wahl.nb;

  const ziel = entlangLaufen(nodes, na.key, nodes.get(nb.key), hinaus);
  // Der Lauf bricht ab, wo das Gleis endet oder abzweigt — dann nicht raten
  if (!ziel || ziel.gelaufen < hinaus - 5) return null;

  /* Selbstprobe: mit demselben Verfahren die bekannte Strecke zum Nachbarstein
   * laufen. Trifft es dort nicht, hat der Lauf hier nichts zu suchen. An 148
   * Fällen nachgemessen fängt das genau die Ausreißer ab — ohne Probe bis zu
   * 4333 m daneben, mit Probe höchstens 746 m, und in 119 von 127 Fällen besser
   * als der nächstgelegene Stein. */
  const nachB = Math.abs(B.km - A.km) * 1000;
  const probe = entlangLaufen(nodes, na.key, ziel, nachB);
  if (!probe || probe.gelaufen < nachB - 5) return null;
  const treffer = haversine(B.lat, B.lon, probe.lat, probe.lon);
  if (treffer > EXTRA_PROBE_M) return null;

  return {
    lat: ziel.lat, lon: ziel.lon, quality: 'extrapoliert',
    hinaus, abStein: A.km, probe: treffer,
    operator: A.operator, lineRef: A.ref || ref
  };
}

/* Und dieselbe Sache in der Gegenrichtung: getippt jenseits des äußersten
 * Steins. Gemeldet an 49,447926 / 10,271642, wo Strecke 5251 weitergeht, die
 * Kilometrierung aber erst bei km 1,5 anfängt — die App meldete „1.015 m vom
 * Gleis entfernt", weil sie den Punkt auf das letzte Steinpaar projizierte.
 *
 * Gelaufen wird bis EXTRA_MAX_M hinaus, dann wird der Tipp auf diesen Weg
 * gelotet; die Weglänge bis zum Lot ist die Kilometerdifferenz. */
async function kmExtrapoliert(ref, lat, lon, sorted) {
  if (sorted.length < 2) return null;

  let best = null;
  for (const unten of [true, false]) {
    const A = unten ? sorted[0] : sorted[sorted.length - 1];
    const B = unten ? sorted[1] : sorted[sorted.length - 2];
    if (!B || A === B) continue;
    // Nur nach draußen: liegt der Tipp näher am Nachbarstein, ist es kein Fall dafür
    if (haversine(lat, lon, A.lat, A.lon) > haversine(lat, lon, B.lat, B.lon)) continue;
    if (!segmentOk(unten ? A : B, unten ? B : A, MAX_GLEIS_GAP_KM)) continue;

    const weite = (EXTRA_MAX_M + haversine(A.lat, A.lon, B.lat, B.lon)) * 1.3;
    const dLat = Math.max(0.02, weite / 110540);
    const dLon = dLat / Math.max(0.2, Math.cos(A.lat * Math.PI / 180));
    const bereich = await netzBereich(A.lat - dLat, A.lon - dLon, A.lat + dLat, A.lon + dLon);
    if (!bereich) continue;

    const gleise = bereich.wege.filter(w =>
      w.ref && String(w.ref).split(';').some(t => t.trim() === String(ref)));
    if (!gleise.length) continue;

    const nodes = buildGraph(gleise);
    if (!nodes.size || nodes.size > 60000) continue;
    const wahl = paarEinhaengen(nodes, A, B);
    if (!wahl || wahl.schlechter > 80) continue;

    const lauf = entlangLaufen(nodes, wahl.na.key, nodes.get(wahl.nb.key), EXTRA_MAX_M);
    if (!lauf || lauf.pfad.length < 2) continue;

    const t = projectOnPath(lauf.pfad, lat, lon);
    if (!t || t.along < 1) continue;               // liegt nicht draußen, sondern beim Stein

    const nachB = Math.abs(B.km - A.km) * 1000;
    const probe = entlangLaufen(nodes, wahl.na.key, lauf, nachB);
    if (!probe || probe.gelaufen < nachB - 5) continue;
    const treffer = haversine(B.lat, B.lon, probe.lat, probe.lon);
    if (treffer > EXTRA_PROBE_M) continue;

    const km = A.km + (unten ? -1 : 1) * (t.along / 1000);
    const kandidat = {
      km, lat: t.lat, lon: t.lon, quality: 'extrapoliert',
      hinaus: t.along, abStein: A.km, probe: treffer, offset: t.dist,
      operator: A.operator, lineRef: A.ref || ref
    };
    if (t.dist <= 400 && (!best || t.dist < best.offset)) best = kandidat;
  }
  return best;
}

/* Position → Kilometer entlang des echten Gleisverlaufs.
 *
 * Die Sehnenrechnung braucht zwei Steine, die nah genug beieinanderstehen —
 * jenseits von MAX_DRAW_GAP_KM wird gar nicht mehr verbunden, und dort endete
 * die Kilometersuche bisher mit einer Fehlermeldung. Der Ausweg ist derselbe
 * wie in der Gegenrichtung: den Verlauf holen und daran entlang messen.
 *
 * Wie genau das ist, steht bei GLEIS_ERR. Unterhalb von MAX_DRAW_GAP_KM wird
 * weiter die Sehne genommen: Dort ist sie gemessen genauso gut und kostet keine
 * Overpass-Abfrage von Sekunden. */
async function kmEntlangGleis(ref, lat, lon, nurLokal = false) {
  const e = lineCache.get(ref);
  if (!e || e.sorted.length < 2) return null;

  const grob = projectOnLine(e.sorted, lat, lon, MAX_GLEIS_GAP_KM);
  if (!grob) return null;

  const weg = await gleisWegZwischen(grob.a, grob.b, nurLokal);
  if (!weg) return null;
  const t = projectOnPath(weg.path, lat, lon);
  if (!t || !t.len) return null;

  const dkm = grob.b.km - grob.a.km;
  return {
    km: grob.a.km + (t.along / t.len) * dkm,
    lat: t.lat, lon: t.lon, quality: 'karte-gleis',
    between: [grob.a.km, grob.b.km], offset: t.dist,
    chord: grob.chord, wegLaenge: weg.length, nominal: weg.nominal,
    sehneKm: grob.km, pfad: weg.path,
    operator: grob.a.operator || grob.b.operator, lineRef: grob.a.ref || ref
  };
}

/* Geradlinig interpoliert, obwohl der Verlauf mitgeliefert ist? Dann gleich
 * darauf rechnen.
 *
 * Der Knopf „Punkt auf das Gleis rechnen" bleibt für alles, was über Overpass
 * geht — dort kostet es 15 bis 40 s und lohnt erst ab REFINE_MIN_CHORD. Aus der
 * Kachel dauert es 34 ms, und dann gibt es keinen Grund, dem Nutzer eine
 * Schätzung hinzulegen, die er erst wegdrücken muss: An Strecke 5321 km 99,0
 * lag die Gerade 375 m neben dem Gleis. */
async function gleisGenau(ref, km, res) {
  if (!res || res.quality !== 'interpoliert') return res;
  const store = lineCache.get(ref);
  const A = store && store.sorted.find(x => Math.abs(x.km - res.between[0]) < 1e-6);
  const B = store && store.sorted.find(x => Math.abs(x.km - res.between[1]) < 1e-6);
  if (!A || !B) return res;

  let weg = null;
  try { weg = await gleisWegZwischen(A, B, true); } catch { return res; }
  if (!weg) return res;

  const t = (km - A.km) / (B.km - A.km);
  const pos = pointAlong(weg.path, t * weg.length);
  return {
    ...res, lat: pos.lat, lon: pos.lon, quality: 'gleis',
    korrektur: haversine(res.lat, res.lon, pos.lat, pos.lon),
    wegLaenge: weg.length, nominal: weg.nominal, pfad: weg.path
  };
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
    const weg = await gleisWegZwischen(A, B);

    const t = (view.km - A.km) / (B.km - A.km);
    const pos = pointAlong(weg.path, t * weg.length);
    const korrektur = haversine(p.lat, p.lon, pos.lat, pos.lon);

    zeichneGleisweg(weg.path);

    view.point = {
      ...p, lat: pos.lat, lon: pos.lon, quality: 'gleis',
      korrektur, wegLaenge: weg.length, nominal: weg.nominal
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
  theme: 'auto', base: 'osm', orm: true, baseOpacity: 100,
  wms: { url: '', layers: '', opacity: 75, on: false }   // nur Adresse und Layer, nie Zugangsdaten
};
let recent = [];   // nicht "history" nennen — das ist window.history

/* ============================ Karte ============================ */

let map, baseOsm, baseSat, baseDop, baseRelief, ormLayer, parzLayer;
let msLayer, trackLayer, pointLayer, meLayer, merkLayer;
/* Hintergründe schließen sich aus, Auflagen nicht — als Verzeichnis gehalten,
 * damit ein weiterer Dienst nur ein Eintrag und ein Knopf ist. */
let baseLayers = {};
let overlayLayers = {};
let pointMarker = null;

function initMap() {
  map = L.map('map', {
    zoomControl: false, attributionControl: true, tap: true,
    // Drehung über leaflet-rotate; eigener Nordknopf statt des mitgelieferten
    rotate: true, rotateControl: false, touchRotate: true,
    bearing: 0
  }).setView([51.1, 10.3], 6);

  /* Eigene Ebene nur für Punktsymbole und Namen, und die hängt unter
   * norotatePane — dort, wo Leaflet selbst seine Marker führt. Eine Pane direkt
   * unter mapPane sah erst richtig aus und verschob sich dann beim Zoomen einer
   * gedrehten Karte (gemessen 36/-78 px), weil leaflet-rotate die Panes aufteilt.
   *
   * Linien und Flächen aus KML gehen bewusst in Leaflets normale Vektorebene
   * (overlayPane) und nicht in eine eigene: Für eine eigene Pane legt Leaflet
   * einen zweiten SVG-Renderer an, und genau den kennzeichnet leaflet-rotate im
   * eigenen Quelltext mit einem FIXME zum Verrutschen beim Zoomen. Die
   * Standardebene trägt seit Monaten die Steinlinie der App ohne Versatz. */
  map.createPane('kmlIconPane', map._norotatePane || undefined);
  map.getPane('kmlIconPane').style.zIndex = 620;    // über allen Markern, unter Sprechblasen

  /* maxZoom gegen maxNativeZoom: maxZoom heißt bei einer Kachelebene „darüber
   * gar nicht mehr zeichnen" — die Ebene verschwindet dann ganz. maxNativeZoom
   * heißt „ab hier die letzte vorhandene Kachel hochskalieren", sie bleibt also
   * sichtbar, nur unscharf. Vorher stand bei OSM und Bahn-Layer maxZoom 19:
   * Wer über einen WMS-Hintergrund (maxZoom 22) tiefer hineinzoomte und dann
   * zurück auf Karte oder Luftbild schaltete, saß auf weißem Grund. Dasselbe
   * hatten wir schon beim eigenen WMS-Layer. */
  baseOsm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 22, maxNativeZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  });
  baseSat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 22, maxNativeZoom: 18, attribution: 'Luftbild: Esri, Maxar'
  });

  /* Offene Dienste der Bayerischen Vermessungsverwaltung, alle CC BY 4.0 und mit
   * EPSG:3857, laufen also direkt in Leaflet. Als WMS haben sie keine natürliche
   * Zoomgrenze, deshalb maxZoom 22.
   *
   * JPEG statt PNG bei den Rasterbildern: gemessen 13 kB gegenüber 172 kB je
   * Kachel beim Orthophoto, ohne sichtbaren Unterschied. Außerhalb Bayerns
   * antworten die Dienste mit einem leeren Bild und Status 200 — kein Fehler,
   * den man abfangen könnte, sondern weißer Grund. */
  const BVV = 'DOP20/Relief/Parzellen: <a href="https://www.geodaten.bayern.de/">Bayerische Vermessungsverwaltung</a> (CC BY 4.0)';

  baseDop = L.tileLayer.wms('https://geoservices.bayern.de/od/wms/dop/v1/dop20', {
    layers: 'by_dop20c', format: 'image/jpeg', version: '1.3.0', maxZoom: 22, attribution: BVV
  });

  /* Schräglicht und nicht die kombinierte Darstellung: Das Schräglicht zeigt
   * Dämme, Einschnitte und alte Trassen plastisch, die kombinierte Fassung wäscht
   * genau diese kleinen Formen weg. */
  baseRelief = L.tileLayer.wms('https://geoservices.bayern.de/od/wms/dgm/v1/relief', {
    layers: 'by_relief_schraeglicht', format: 'image/jpeg', version: '1.3.0', maxZoom: 22, attribution: BVV
  });

  /* Parzellarkarte nur als Umring: Die Farbfassung bringt einen deckend weißen
   * Grund mit (gemessen 0 % durchsichtig) und würde alles darunter verdecken.
   * Der Dienst zeichnet erst unterhalb 1:5000, also etwa ab Zoomstufe 17. */
  parzLayer = L.tileLayer.wms('https://geoservices.bayern.de/od/wms/alkis/v1/parzellarkarte', {
    layers: 'by_alkis_parzellarkarte_umr_schwarz', format: 'image/png', transparent: true,
    version: '1.3.0', maxZoom: 22, attribution: BVV
  });

  baseLayers = { osm: baseOsm, sat: baseSat, dop: baseDop, relief: baseRelief };
  ormLayer = L.tileLayer('https://{s}.tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png', {
    subdomains: 'abc', maxZoom: 22, maxNativeZoom: 19, opacity: 0.85,
    attribution: '<a href="https://www.openrailwaymap.org/">OpenRailwayMap</a>'
  });

  baseOsm.addTo(map);
  msLayer = L.layerGroup().addTo(map);
  trackLayer = L.layerGroup().addTo(map);
  pointLayer = L.layerGroup().addTo(map);
  meLayer = L.layerGroup().addTo(map);
  merkLayer = L.layerGroup().addTo(map);

  /* Keine Zoomknöpfe: Am Rechner zoomt das Mausrad, am Gerät zwei Finger oder
   * ein Doppeltipp. Der Platz rechts unten gehört damit den eigenen Knöpfen. */
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);

  overlayLayers = { orm: ormLayer, parz: parzLayer };
  if (prefs.orm !== false) ormLayer.addTo(map);
  if (prefs.parz) { parzFarbeAnpassen(); parzLayer.addTo(map); }
  if (prefs.base && prefs.base !== 'osm') setBase(prefs.base);
  applyBaseOpacity();
  if (prefs.wms && prefs.wms.on) wmsApply(true);

  map.on('click', onMapClick);
  merkPunktBinden();
  map.on('zoom rotate', gesteBild);
  map.on('zoomend rotateend moveend', gesteEnde);
  map.on('move zoom rotate', messLiveZeichnen);
  map.on('moveend rotateend', liveLeiste);
  map.on('zoomend', drawMilestones);
  map.on('rotate rotateend', syncNorth);
  syncNorth();
  syncButtons();
}

/* ---- Vektoren während einer Zweifingergeste ----
 *
 * leaflet-rotate zieht die SVG-Vektorebene während einer laufenden Geste nicht
 * mit: Gemessen wandern Linien und Kreise mitten im Drehen und Zoomen um bis zu
 * 171 Pixel und springen am Ende zurück. Betroffen sind alle Vektoren gleich —
 * in Leaflets eigener Ebene genauso wie in einer selbst angelegten; Marker und
 * Symbole bleiben ruhig, weil die einzeln gesetzt werden. Deshalb sah es aus,
 * als sprängen „nur die Linien".
 *
 * Ein erzwungenes Neusetzen des Renderers je Bild hält alles auf 0 Pixel. Es
 * kostet aber Rechenzeit: gemessen 0,6 ms bei den üblichen Dateien (auch bei 23
 * Linien), 2 ms bei 200 Kreisen, aber 14 ms bei einer einzigen Linie mit 5000
 * Stützpunkten — das wäre bei 60 Bildern je Sekunde zu viel. Deshalb bis zu
 * einem Budget nachziehen und darüber die Vektorebene für die Dauer der Geste
 * ausblenden: Verschwundene Linien irritieren weniger als umherfliegende. */

const VEKTOR_BUDGET = 2500;      // Stützpunkte, bis zu denen je Bild nachgezogen wird

let gesteLaeuft = false;
let gesteModus = null;

function alleRenderer() {
  const raus = [];
  if (map._renderer) raus.push(map._renderer);
  for (const r of Object.values(map._paneRenderers || {})) if (r) raus.push(r);
  return raus;
}

function vektorLast() {
  let n = 0;
  for (const r of alleRenderer()) {
    for (const id in (r._layers || {})) {
      const l = r._layers[id];
      /* Die eigenen Stützpunkte zählen, nicht l._parts: Dort stehen nur die
       * zugeschnittenen Punkte des aktuellen Ausschnitts, und für eine gerade
       * hinzugefügte Linie ist das Feld leer — die Last wäre unterschätzt. */
      if (typeof l.getLatLngs === 'function') {
        const ll = l.getLatLngs();
        n += Array.isArray(ll[0]) ? ll.flat(2).length : ll.length;
      } else {
        n += 1;
      }
    }
  }
  return n;
}

function vektorenNachziehen() {
  for (const r of alleRenderer()) {
    try { r._reset(); } catch { /* ein Renderer ohne Karte — nichts zu tun */ }
  }
}

function gesteBild() {
  if (!gesteLaeuft) {
    gesteLaeuft = true;
    gesteModus = vektorLast() <= VEKTOR_BUDGET ? 'nachziehen' : 'ausblenden';
    if (gesteModus === 'ausblenden') map.getPane('overlayPane').style.opacity = '0';
  }
  if (gesteModus === 'nachziehen') vektorenNachziehen();
}

function gesteEnde() {
  if (!gesteLaeuft) return;
  gesteLaeuft = false;
  map.getPane('overlayPane').style.opacity = '';
  vektorenNachziehen();
}

/** Nordknopf nur zeigen, wenn die Karte tatsächlich gedreht ist. */
function syncNorth() {
  const btn = $('#northBtn');
  if (!btn || !map.getBearing) return;
  const b = map.getBearing() || 0;
  btn.hidden = Math.abs(((b % 360) + 360) % 360) < 0.5;

  /* Ohne Vorzeichen: Bei einer Kartendrehung von b Grad liegt Norden auf dem
   * Bildschirm ebenfalls bei b Grad im Uhrzeigersinn — nachgerechnet über zwei
   * Punkte desselben Meridians. Vorher stand hier -b, der Kompass zeigte also
   * um den doppelten Winkel daneben. */
  const scheibe = btn.querySelector('svg');
  if (scheibe) scheibe.style.transform = `rotate(${b}deg)`;
}

/** Ungefährer Rahmen um Bayern — nur um zu warnen, nicht um zu sperren. */
const BAYERN = { s: 47.2, w: 8.9, n: 50.6, o: 13.9 };

function ausserhalbBayerns() {
  const c = map.getCenter();
  return c.lat < BAYERN.s || c.lat > BAYERN.n || c.lng < BAYERN.w || c.lng > BAYERN.o;
}

/* Schwarze Umringe verschwinden auf dem Luftbild, gelbe auf der hellen Karte —
 * deshalb richtet sich die Farbe nach dem gewählten Hintergrund. */
function parzFarbeAnpassen() {
  if (!parzLayer) return;
  const wunsch = (prefs.base || 'osm') === 'osm'
    ? 'by_alkis_parzellarkarte_umr_schwarz'
    : 'by_alkis_parzellarkarte_umr_gelb';
  if (parzLayer.wmsParams.layers !== wunsch) parzLayer.setParams({ layers: wunsch });
}

/** Reihenfolge der Auflagen: eigener WMS unten, dann Parzellen, Bahn-Layer oben. */
function ordneAuflagen() {
  if (wmsLayer) wmsLayer.bringToFront();
  if (map.hasLayer(parzLayer)) parzLayer.bringToFront();
  if (map.hasLayer(ormLayer)) ormLayer.bringToFront();
}

function setBase(which) {
  if (!baseLayers[which]) which = 'osm';
  prefs.base = which;

  for (const [kennung, layer] of Object.entries(baseLayers)) {
    if (kennung !== which && map.hasLayer(layer)) map.removeLayer(layer);
  }
  if (!map.hasLayer(baseLayers[which])) baseLayers[which].addTo(map);

  if ((which === 'dop' || which === 'relief') && ausserhalbBayerns()) {
    toast('Dieser Dienst deckt nur Bayern ab — hier bleibt der Grund weiß.');
  }

  parzFarbeAnpassen();
  applyBaseOpacity();
  ordneAuflagen();
  saveStore();
  syncButtons();
}

/** Hintergrund verblassen, damit Bahn- oder WMS-Layer allein lesbar werden. */
function applyBaseOpacity() {
  const o = (prefs.baseOpacity == null ? 100 : prefs.baseOpacity) / 100;
  for (const layer of Object.values(baseLayers)) layer.setOpacity(o);

  // Sobald der Hintergrund durchscheinend wird, muss darunter Weiß liegen:
  // Bahn- und IVL-Pläne sind schwarze Strichzeichnungen und wären im
  // Dunkelmodus auf dunklem Grund praktisch unsichtbar.
  const flaeche = $('#map');
  if (flaeche) flaeche.style.background = o < 1 ? '#ffffff' : '';

  const val = $('#baseOpacityVal');
  if (val) val.textContent = Math.round(o * 100) + ' %';
}

function toggleOverlay(kennung) {
  const layer = overlayLayers[kennung];
  if (!layer) return;

  if (map.hasLayer(layer)) {
    map.removeLayer(layer);
    prefs[kennung] = false;
  } else {
    if (kennung === 'parz') {
      parzFarbeAnpassen();
      if (ausserhalbBayerns()) toast('Die Parzellarkarte deckt nur Bayern ab.');
      else if (map.getZoom() < 17) toast('Parzellen zeichnet der Dienst erst ab Zoomstufe 17 (1:5000).');
    }
    layer.addTo(map);
    prefs[kennung] = true;
  }
  ordneAuflagen();
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
    crossOrigin: false,       // kein CORS anfordern, sonst scheitert der Abruf
    // Leaflet setzt bei Kachel-Layern standardmäßig maxZoom 18 — der Layer
    // verschwände dann beim Hineinzoomen. Ein WMS rendert jeden Maßstab auf
    // Anfrage, es gibt also keine natürliche Obergrenze.
    maxZoom: 22
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
    let name = '', title = '', minScale = null, maxScale = null;
    for (const c of el.children) {
      if (c.localName === 'Name' && !name) name = c.textContent.trim();
      if (c.localName === 'Title' && !title) title = c.textContent.trim();
      // Maßstabsgrenzen erklären, warum ein Layer beim Zoomen verschwindet
      if (c.localName === 'MinScaleDenominator') minScale = parseFloat(c.textContent);
      if (c.localName === 'MaxScaleDenominator') maxScale = parseFloat(c.textContent);
      if (c.localName === 'ScaleHint') {              // WMS 1.1.1
        const mn = parseFloat(c.getAttribute('min')), mx = parseFloat(c.getAttribute('max'));
        if (isFinite(mn)) minScale = mn / 0.00028;
        if (isFinite(mx)) maxScale = mx / 0.00028;
      }
    }
    if (name) layers.push({ name, title, minScale, maxScale });
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

  box.innerHTML = hinweis + caps.layers.slice(0, 25).map((l, i) => {
    const grenzen = [];
    if (isFinite(l.minScale) && l.minScale) grenzen.push('nicht näher als 1:' + nfM.format(l.minScale));
    if (isFinite(l.maxScale) && l.maxScale) grenzen.push('nicht weiter als 1:' + nfM.format(l.maxScale));
    const unter = [l.title !== l.name ? l.title : '', grenzen.join(' · ')].filter(Boolean).join(' — ');
    return `<button class="fac-item" type="button" data-wl="${i}">${esc(l.name)}` +
      `${unter ? `<small>${esc(unter)}</small>` : ''}</button>`;
  }).join('');

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

/* -------- Eigene KML-Dateien -------- */

/* Warum IndexedDB und nicht localStorage: Ein KML mit einigen tausend Objekten
 * sprengt die rund 5 MB, die localStorage zugesteht. Abgelegt wird die schon
 * ausgewertete Geometrie statt des XML — beim Start ist dann nichts mehr zu
 * parsen. Kopfdaten und Geometrie liegen getrennt, damit das Ein- und
 * Ausschalten nur ein paar Byte schreibt und nicht die ganze Datei.
 *
 * Die Dateien bleiben auf dem Gerät, es wird nichts hochgeladen. */

const KML_DB = 'railnav-kml';
/* Reihum vergeben, damit sich mehrere Dateien ohne eigene Farbangabe
 * voneinander unterscheiden. */
const KML_FARBEN = ['#e6484b', '#f59e0b', '#22c55e', '#4b93e6', '#a855f7', '#14b8a6', '#ec4899', '#84cc16'];
const KML_VIEL = 4000;        // ab so vielen Objekten wird vor Trägheit gewarnt

/* Namen an die Punkte schreiben lohnt erst, wenn nicht alles übereinanderliegt,
 * und muss nach oben begrenzt sein — 1000 Beschriftungen sind auf einem Handy
 * nur noch ein grauer Teppich. */
const KML_LABEL_ZOOM = 16;
const KML_LABEL_MAX = 200;

/* Auswählbare Symbole. Zehn Formen, weil eine Datei durchaus zehn Merkmalswerte
 * mitbringt — die FP-Ausgabe eines Vermessungsprogramms hat neun Marker-Typen.
 * Der einheitliche Kreis läuft über L.circleMarker, weil das auch bei einigen
 * tausend Punkten flüssig bleibt; alle anderen Formen sind SVG in einem divIcon. */
const KML_FORMEN = {
  kreis:     { name: 'Kreis',            d: '<circle cx="8" cy="8" r="5"/>' },
  quadrat:   { name: 'Quadrat',          d: '<rect x="3" y="3" width="10" height="10"/>' },
  dreieck:   { name: 'Dreieck',          d: '<path d="M8 2.4 14 13.4H2z"/>' },
  dreieckAb: { name: 'Dreieck abwärts',  d: '<path d="M8 13.6 2 2.6h12z"/>' },
  raute:     { name: 'Raute',            d: '<path d="M8 2 14 8 8 14 2 8z"/>' },
  sechseck:  { name: 'Sechseck',         d: '<path d="M8 1.8 13.4 5v6L8 14.2 2.6 11V5z"/>' },
  stern:     { name: 'Stern',            d: '<path d="M8 1.6 9.9 6 14.6 6.4 11 9.5 12.1 14.1 8 11.6 3.9 14.1 5 9.5 1.4 6.4 6.1 6z"/>' },
  kreuz:     { name: 'Kreuz',            d: '<path d="M3.6 3.6 12.4 12.4M12.4 3.6 3.6 12.4"/>', strich: true },
  plus:      { name: 'Plus',             d: '<path d="M8 2.6V13.4M2.6 8H13.4"/>', strich: true },
  ring:      { name: 'Ring',             d: '<circle cx="8" cy="8" r="4.6"/>', strich: true }
};

function kmlSymbolSvg(form, farbe, gross) {
  const r = gross ? 16 : 14;
  // Steht die Form nicht fest, zwei verschiedene andeuten statt eine vorzutäuschen
  if (form === 'auto') {
    return `<svg viewBox="0 0 16 16" width="${r}" height="${r}" aria-hidden="true">` +
      `<g fill="${farbe}" stroke="#fff" stroke-width="1.6" paint-order="stroke">` +
      `<circle cx="5" cy="5" r="3.4"/><rect x="7.8" y="7.8" width="6.6" height="6.6"/></g></svg>`;
  }
  const f = KML_FORMEN[form] || KML_FORMEN.kreis;
  /* Weiß außen herum, damit die Form auf Luftbild und Bahnplan gleich gut sitzt.
   * Strichformen brauchen dafür zwei Durchgänge — bei ihnen ist die Farbe der
   * Strich und nicht die Füllung. */
  const koerper = f.strich
    ? `<g fill="none" stroke-linecap="round"><g stroke="#fff" stroke-width="4.4">${f.d}</g>` +
      `<g stroke="${farbe}" stroke-width="2.4">${f.d}</g></g>`
    : `<g fill="${farbe}" stroke="#fff" stroke-width="2" paint-order="stroke">${f.d}</g>`;
  return `<svg viewBox="0 0 16 16" width="${r}" height="${r}" aria-hidden="true">${koerper}</svg>`;
}

/* -------- Merkmale der Objekte -------- */

/** Wert eines Merkmals, etwa "Marker type" → "3". */
function kmlWert(o, feld) {
  for (const [k, v] of (o.daten || [])) if (k === feld) return v;
  return null;
}

/** Welche Merkmale tragen die Objekte dieser Datei, und wie viele Werte je Merkmal? */
function kmlFelder(akte) {
  const gefunden = new Map();
  for (const o of akte.objekte) {
    for (const [k] of (o.daten || [])) {
      if (!gefunden.has(k)) gefunden.set(k, new Set());
    }
  }
  for (const o of akte.objekte) {
    for (const [k, v] of (o.daten || [])) {
      const menge = gefunden.get(k);
      if (menge.size < 60) menge.add(v);
    }
  }
  return [...gefunden].map(([key, m]) => ({ key, werte: m.size }));
}

/* Welches Merkmal taugt zum Unterscheiden? Es braucht mindestens zwei und
 * höchstens so viele Werte, wie es Formen gibt.
 *
 * "Code" geht vor: Das ist in den Ausgaben der Vermessungsprogramme die
 * fachliche Einordnung des Punktes (GVPV, PS0 bis PS3), während "Marker type"
 * nur die Zeichensymbolnummer des erzeugenden Programms ist. Nach der Sache zu
 * unterscheiden ist nützlicher als nach dem Zeichensatz. */
function kmlAutoFeld(akte) {
  const formen = Object.keys(KML_FORMEN).length;
  const kandidaten = kmlFelder(akte).filter(f => f.werte >= 2 && f.werte <= formen);
  if (!kandidaten.length) return null;
  const rang = f => /code/i.test(f.key) ? 0
    : /art|kategor|klasse|gruppe/i.test(f.key) ? 1
    : /marker|typ|type|symbol/i.test(f.key) ? 2 : 3;
  kandidaten.sort((a, b) => rang(a) - rang(b) || a.werte - b.werte || a.key.localeCompare(b.key));
  return kandidaten[0].key;
}

/** Merkmalswert → Form. Zahlen numerisch sortiert, damit 2 vor 14 kommt. */
function kmlFormKarte(akte) {
  const feld = akte.autoFeld;
  if (!feld) return null;
  const werte = new Set();
  for (const o of akte.objekte) {
    const v = kmlWert(o, feld);
    if (v != null && v !== '') werte.add(v);
  }
  const formen = Object.keys(KML_FORMEN);
  const sortiert = [...werte].sort((a, b) => {
    const za = parseFloat(a), zb = parseFloat(b);
    if (isFinite(za) && isFinite(zb) && za !== zb) return za - zb;
    return String(a).localeCompare(String(b), 'de');
  });
  const karte = new Map();
  sortiert.forEach((v, i) => karte.set(v, formen[i % formen.length]));
  return karte;
}

/** Werte eines Merkmals mit ihrer Häufigkeit, numerisch sinnvoll sortiert. */
function kmlWerteMit(akte, feld) {
  if (!feld) return [];
  const zaehler = new Map();
  for (const o of akte.objekte) {
    const v = kmlWert(o, feld);
    if (v == null || v === '') continue;
    zaehler.set(v, (zaehler.get(v) || 0) + 1);
  }
  return [...zaehler].map(([wert, anzahl]) => ({ wert, anzahl })).sort((a, b) => {
    const za = parseFloat(a.wert), zb = parseFloat(b.wert);
    if (isFinite(za) && isFinite(zb) && za !== zb) return za - zb;
    return String(a.wert).localeCompare(String(b.wert), 'de');
  });
}

/* Soll dieses Objekt gezeichnet werden? Ausgeblendet wird nach Werten eines
 * Merkmals — etwa nur die Neubau-Querungen zeigen und die vorhandenen weglassen.
 * Gilt überall gleich: Zeichnen, Beschriftung, Fangen beim Messen und die Suche
 * nach dem nächsten Objekt. */
function kmlSichtbarObj(akte, o) {
  const aus = akte.ausWerte;
  if (!aus || !aus.length || !akte.autoFeld) return true;
  const v = kmlWert(o, akte.autoFeld);
  return !aus.includes(v == null ? '' : v);
}

/** Was auf der Karte neben dem Symbol steht. */
function kmlLabelText(akte, o) {
  const teile = [];
  for (const f of (akte.labelFelder || ['name'])) {
    const v = f === 'name' ? o.name : kmlWert(o, f);
    if (v) teile.push(v);
  }
  return teile.join(' · ');
}

let kmlAkten = [];                    // Kopfdaten samt Geometrie, in Ladereihenfolge
const kmlEbenen = new Map();          // id → Leaflet-Gruppe der sichtbaren Datei

/* -------- Speicher -------- */

let kmlOffen = null;
function kmlDb() {
  if (kmlOffen) return kmlOffen;
  kmlOffen = new Promise((ok, fehler) => {
    const rq = indexedDB.open(KML_DB, 1);
    rq.onupgradeneeded = () => {
      const db = rq.result;
      db.createObjectStore('akten', { keyPath: 'id' });   // klein: Name, Farbe, sichtbar
      db.createObjectStore('geo');                        // groß: die Objekte, id als Schlüssel
    };
    rq.onsuccess = () => ok(rq.result);
    rq.onerror = () => fehler(rq.error || new Error('kein lokaler Speicher verfügbar'));
  });
  return kmlOffen;
}

function kmlKopf(akte) {
  const kopf = { ...akte };
  delete kopf.objekte;
  return kopf;
}

async function kmlLaden() {
  const db = await kmlDb();
  return new Promise((ok, fehler) => {
    const tx = db.transaction(['akten', 'geo'], 'readonly');
    const rq = tx.objectStore('akten').getAll();
    const geo = new Map();
    tx.objectStore('geo').openCursor().onsuccess = ev => {
      const c = ev.target.result;
      if (!c) return;
      geo.set(c.key, c.value);
      c.continue();
    };
    tx.oncomplete = () => ok((rq.result || [])
      .map(a => ({ ...a, objekte: geo.get(a.id) || [] }))
      .sort((a, b) => (a.angelegt || 0) - (b.angelegt || 0)));
    tx.onerror = () => fehler(tx.error);
  });
}

async function kmlAblegen(akte) {
  const db = await kmlDb();
  return new Promise((ok, fehler) => {
    const tx = db.transaction(['akten', 'geo'], 'readwrite');
    tx.objectStore('akten').put(kmlKopf(akte));
    tx.objectStore('geo').put(akte.objekte, akte.id);
    tx.oncomplete = ok;
    tx.onerror = () => fehler(tx.error);
  });
}

/** Nur die Kopfdaten schreiben — beim Umschalten soll nicht die Geometrie neu durch. */
async function kmlKopfMerken(akte) {
  try {
    const db = await kmlDb();
    await new Promise((ok, fehler) => {
      const tx = db.transaction('akten', 'readwrite');
      tx.objectStore('akten').put(kmlKopf(akte));
      tx.oncomplete = ok;
      tx.onerror = () => fehler(tx.error);
    });
  } catch { /* dann gilt der Schalter nur für diese Sitzung */ }
}

async function kmlLoeschen(id) {
  const db = await kmlDb();
  return new Promise((ok, fehler) => {
    const tx = db.transaction(['akten', 'geo'], 'readwrite');
    tx.objectStore('akten').delete(id);
    tx.objectStore('geo').delete(id);
    tx.oncomplete = ok;
    tx.onerror = () => fehler(tx.error);
  });
}

/* -------- KML auswerten -------- */

/* Namensräume durchweg ignorieren: KML setzt einen Default-Namespace, an dem
 * querySelector scheitert, und gx:-Erweiterungen bringen einen zweiten mit. */
const kmlErst = (el, name) => el.getElementsByTagNameNS('*', name)[0] || null;
const kmlText = (el, name) => { const c = kmlErst(el, name); return c ? c.textContent.trim() : ''; };
const kmlKind = (el, name) => { for (const c of el.children) if (c.localName === name) return c; return null; };

/** KML-Farbe ist aabbggrr — umgedreht und mit der Deckkraft vorne. */
function kmlFarbe(roh) {
  const t = String(roh || '').trim().replace(/^#/, '');
  if (!/^[0-9a-f]{8}$/i.test(t)) return null;
  return {
    farbe: ('#' + t.slice(6, 8) + t.slice(4, 6) + t.slice(2, 4)).toLowerCase(),
    deckung: parseInt(t.slice(0, 2), 16) / 255
  };
}

function kmlStil(el) {
  const s = {};
  const linie = kmlErst(el, 'LineStyle');
  if (linie) {
    const f = kmlFarbe(kmlText(linie, 'color'));
    if (f) { s.color = f.farbe; s.opacity = f.deckung; }
    const w = parseFloat(kmlText(linie, 'width'));
    if (isFinite(w) && w > 0) s.weight = Math.min(w, 10);
  }
  const flaeche = kmlErst(el, 'PolyStyle');
  if (flaeche) {
    const f = kmlFarbe(kmlText(flaeche, 'color'));
    if (f) { s.fillColor = f.farbe; s.fillOpacity = Math.min(f.deckung, 0.5); }
    if (kmlText(flaeche, 'fill') === '0') s.fill = false;
  }
  const symbol = kmlErst(el, 'IconStyle');
  if (symbol) {
    const f = kmlFarbe(kmlText(symbol, 'color'));
    // Weiß ist in Google Earth der ungefärbte Standardstift, keine Absicht
    if (f && f.farbe !== '#ffffff') s.punkt = f.farbe;
  }
  return s;
}

/** "lon,lat,alt lon,lat,alt …" → [[lat, lon], …] */
function kmlKoord(roh) {
  const raus = [];
  for (const tupel of String(roh || '').trim().split(/\s+/)) {
    const t = tupel.split(',');
    const lon = parseFloat(t[0]), lat = parseFloat(t[1]);
    if (isFinite(lat) && isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) raus.push([lat, lon]);
  }
  return raus;
}

function kmlGeo(el, raus) {
  switch (el.localName) {
    case 'Point': {
      const c = kmlKoord(kmlText(el, 'coordinates'));
      if (c.length) raus.push({ art: 'p', koord: c[0] });
      break;
    }
    case 'LineString': case 'LinearRing': {
      const c = kmlKoord(kmlText(el, 'coordinates'));
      if (c.length > 1) raus.push({ art: 'l', koord: c });
      break;
    }
    case 'Polygon': {
      // Der äußere Ring steht in KML zuerst, danach folgen die Löcher
      const ringe = [];
      for (const r of el.getElementsByTagNameNS('*', 'LinearRing')) {
        const c = kmlKoord(kmlText(r, 'coordinates'));
        if (c.length > 2) ringe.push(c);
      }
      if (ringe.length) raus.push({ art: 'a', koord: ringe });
      break;
    }
    case 'Track': {           // gx:Track — Aufzeichnung, Koordinaten mit Leerzeichen getrennt
      const c = [];
      for (const g of el.getElementsByTagNameNS('*', 'coord')) {
        const t = g.textContent.trim().split(/\s+/);
        const lon = parseFloat(t[0]), lat = parseFloat(t[1]);
        if (isFinite(lat) && isFinite(lon)) c.push([lat, lon]);
      }
      if (c.length > 1) raus.push({ art: 'l', koord: c });
      break;
    }
    case 'MultiGeometry': case 'MultiTrack':
      for (const ch of el.children) kmlGeo(ch, raus);
      break;
  }
}

/* Beschreibungen enthalten oft ganze HTML-Tabellen. Übernommen wird nur der
 * Text — über DOMParser, damit nichts davon ausgeführt oder nachgeladen wird. */
function kmlKlartext(roh) {
  let t = String(roh || '').trim();
  // Manche Ausgabeprogramme schreiben die CDATA-Klammer selbst noch escaped in
  // den Text hinein; als HTML gelesen verschluckt sie sonst die erste Zeile.
  t = t.replace(/^<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim();
  if (!t) return '';
  if (!/[<&]/.test(t)) return t;

  /* Zeilenwechsel des HTML erhalten. textContent kennt kein <br>, sonst liefen
   * ganze Beschreibungsblöcke zu einer einzigen Zeile zusammen — unlesbar, und
   * die Merkmale "Schlüssel: Wert" darin wären nicht mehr zu erkennen. */
  t = t.replace(/<br\s*\/?>/gi, '\n')
       .replace(/<\/(p|div|tr|li|h[1-6])\s*>/gi, '\n');

  const d = new DOMParser().parseFromString(t, 'text/html');
  return (d.body.textContent || '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

/* Viele Ausgabeprogramme schreiben ihre Merkmale als Text in die Beschreibung,
 * etwa "Code: PS2, Marker type: 0". Solche Zeilen werden zu Merkmalen, damit man
 * danach Symbole und Beschriftung wählen kann. Bewusst streng: Nur wenn eine
 * Zeile vollständig aus "Schlüssel: Wert"-Stücken besteht, wird sie zerlegt —
 * sonst bliebe von einem Fließtext ein Trümmerfeld übrig. */
function kmlPaareAusText(text) {
  const paare = [], rest = [];
  for (const zeile of String(text || '').split('\n')) {
    if (!zeile.trim()) continue;
    // Am Komma nur trennen, wenn danach wieder ein Schlüssel mit Doppelpunkt folgt
    const stuecke = zeile.split(/,\s+(?=[^,:]{1,30}:\s)/);
    const gefunden = [];
    let vollstaendig = true;
    for (const st of stuecke) {
      const m = /^\s*([^:]{1,30}?)\s*:\s*(\S.*)$/.exec(st);
      if (m) gefunden.push([m[1].trim(), m[2].trim()]);
      else { vollstaendig = false; break; }
    }
    if (vollstaendig && gefunden.length) paare.push(...gefunden);
    else rest.push(zeile);
  }
  return { paare, rest: rest.join('\n').trim() };
}

function kmlDaten(pm) {
  const raus = [];
  const ext = kmlErst(pm, 'ExtendedData');
  if (!ext) return raus;
  for (const d of ext.getElementsByTagNameNS('*', 'Data')) {
    const k = (d.getAttribute('name') || '').trim(), v = kmlText(d, 'value');
    if (k || v) raus.push([k, v]);
  }
  for (const d of ext.getElementsByTagNameNS('*', 'SimpleData')) {
    const k = (d.getAttribute('name') || '').trim(), v = d.textContent.trim();
    if (k || v) raus.push([k, v]);
  }
  return raus.slice(0, 14);
}

/** Ordnerpfad des Objekts — hilft beim Zuordnen, wenn ein KML viele Gruppen hat. */
function kmlOrdner(pm) {
  const teile = [];
  for (let p = pm.parentElement; p; p = p.parentElement) {
    if (p.localName !== 'Folder') continue;
    const n = kmlKind(p, 'name');
    if (n) teile.unshift(n.textContent.trim());
  }
  return teile.join(' › ');
}

/* Merkmale aus ExtendedData und aus der Beschreibung zusammenlegen. Manche
 * Dateien führen dieselben Felder in beidem — dann steht sonst alles doppelt in
 * der Sprechblase. Bei gleichem Schlüssel gewinnt der längere Wert: In der
 * Beschreibung steht oft die ausführlichere Fassung. */
function kmlDatenVereinen(...listen) {
  const raus = new Map();
  for (const liste of listen) {
    for (const [k, v] of liste) {
      const alt = raus.get(k);
      if (alt == null || String(v).length > String(alt).length) raus.set(k, v);
    }
  }
  return [...raus].slice(0, 20);
}

function kmlParse(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('kein lesbares KML');

  /* Stile sammeln. Eine StyleMap zeigt auf einen Style; aufgelöst wird erst
   * hinterher, weil die Reihenfolge im Dokument beliebig ist. */
  const stile = new Map();
  for (const el of doc.getElementsByTagNameNS('*', 'Style')) {
    const id = el.getAttribute('id');
    if (id) stile.set('#' + id, kmlStil(el));
  }
  for (const el of doc.getElementsByTagNameNS('*', 'StyleMap')) {
    const id = el.getAttribute('id');
    if (!id) continue;
    for (const paar of el.getElementsByTagNameNS('*', 'Pair')) {
      if (kmlText(paar, 'key') === 'highlight') continue;   // nur der Zustand unter dem Zeiger
      const ziel = kmlText(paar, 'styleUrl');
      if (ziel) stile.set('#' + id, ziel);
    }
  }
  const stilFuer = url => {
    let v = stile.get(String(url || '').trim());
    for (let i = 0; i < 4 && typeof v === 'string'; i++) v = stile.get(v);
    // Absichtlich dasselbe Objekt für alle Objekte eines Stils — spart Speicher
    return v && typeof v === 'object' ? v : null;
  };

  const objekte = [];
  let sLat = 90, wLon = 180, nLat = -90, oLon = -180;
  const merken = k => {
    if (k[0] < sLat) sLat = k[0];
    if (k[0] > nLat) nLat = k[0];
    if (k[1] < wLon) wLon = k[1];
    if (k[1] > oLon) oLon = k[1];
  };

  for (const pm of doc.getElementsByTagNameNS('*', 'Placemark')) {
    const geo = [];
    for (const ch of pm.children) kmlGeo(ch, geo);
    if (!geo.length) continue;

    const eigen = kmlKind(pm, 'Style');
    const nEl = kmlKind(pm, 'name'), dEl = kmlKind(pm, 'description');
    const beschreibung = dEl ? kmlKlartext(dEl.textContent) : '';
    const zerlegt = kmlPaareAusText(beschreibung);
    // "none" schreiben manche Programme als Platzhalter fuer "keine Beschreibung"
    if (/^(none|n\/a|-{1,3})$/i.test(zerlegt.rest)) zerlegt.rest = '';
    const gemeinsam = {
      name: nEl ? nEl.textContent.trim() : '',
      text: zerlegt.rest.slice(0, 700),
      daten: kmlDatenVereinen(kmlDaten(pm), zerlegt.paare),
      ordner: kmlOrdner(pm),
      stil: eigen ? kmlStil(eigen) : stilFuer(kmlText(pm, 'styleUrl'))
    };

    for (const g of geo) {
      if (g.art === 'p') merken(g.koord);
      else if (g.art === 'l') g.koord.forEach(merken);
      else g.koord.forEach(r => r.forEach(merken));
      objekte.push({ ...g, ...gemeinsam });
    }
  }

  const doku = kmlErst(doc, 'Document');
  const titelEl = doku && kmlKind(doku, 'name');

  return {
    objekte,
    titel: titelEl ? titelEl.textContent.trim() : '',
    grenzen: objekte.length && nLat >= sLat ? [[sLat, wLon], [nLat, oLon]] : null
  };
}

/* -------- KMZ auspacken -------- */

/* Ein KMZ ist ein ZIP mit einer KML darin. Gelesen wird über das zentrale
 * Verzeichnis am Dateiende: Nur dort stehen die Größen verlässlich — bei
 * gestreamt geschriebenen ZIPs sind sie im lokalen Kopf null. Das Aufblasen
 * macht DecompressionStream, dafür braucht es keine Fremdbibliothek. */
function kmzEintraege(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0 && i > u8.length - 22 - 65536; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('kein lesbares KMZ');

  const anzahl = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const raus = [];
  for (let n = 0; n < anzahl && p + 46 <= u8.length && dv.getUint32(p, true) === 0x02014b50; n++) {
    const verfahren = dv.getUint16(p + 10, true);
    const gepackt = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const kommLen = dv.getUint16(p + 32, true);
    const lokal = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
    // Der Datenbeginn steht erst im lokalen Kopf, dessen Zusatzfeld abweichen darf
    const lNameLen = dv.getUint16(lokal + 26, true), lExtraLen = dv.getUint16(lokal + 28, true);
    const start = lokal + 30 + lNameLen + lExtraLen;
    raus.push({ name, verfahren, daten: u8.subarray(start, start + gepackt) });
    p += 46 + nameLen + extraLen + kommLen;
  }
  return raus;
}

async function kmzText(buf) {
  const eintraege = kmzEintraege(buf);
  const kml = eintraege.find(e => /^doc\.kml$/i.test(e.name)) ||
              eintraege.find(e => /\.kml$/i.test(e.name));
  if (!kml) throw new Error('im KMZ steckt keine KML-Datei');
  if (kml.verfahren === 0) return kmlDekodieren(kml.daten.slice().buffer);
  if (kml.verfahren !== 8) throw new Error('unbekannte Packmethode im KMZ');
  if (typeof DecompressionStream !== 'function') throw new Error('dieser Browser kann KMZ nicht entpacken');
  const strom = new Blob([kml.daten]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return kmlDekodieren(await new Response(strom).arrayBuffer());
}

/** Ältere KML kommen in ISO-8859-1 — sonst werden Umlaute zu Fragezeichen. */
function kmlDekodieren(buf) {
  const kopf = new TextDecoder('utf-8').decode(new Uint8Array(buf, 0, Math.min(200, buf.byteLength)));
  const m = /encoding=["']([\w-]+)["']/i.exec(kopf);
  const enc = (m ? m[1] : 'utf-8').toLowerCase();
  if (enc === 'utf-8' || enc === 'utf8') return new TextDecoder('utf-8').decode(buf);
  try { return new TextDecoder(enc).decode(buf); }
  catch { return new TextDecoder('utf-8').decode(buf); }
}

/* -------- Zeichnen -------- */

function kmlPopup(o, akte) {
  const zeilen = [];
  if (o.name) zeilen.push(`<b>${esc(o.name)}</b>`);
  if (o.text) zeilen.push(`<span>${esc(o.text)}</span>`);
  for (const [k, v] of (o.daten || [])) zeilen.push(`<span><i>${esc(k)}</i> ${esc(v)}</span>`);
  if (o.art === 'p') {
    zeilen.push(`<span>${fmtCoord(o.koord[0], o.koord[1])}</span>`);
    zeilen.push(`<a href="${gmapsUrl(o.koord[0], o.koord[1])}" target="_blank" rel="noopener">In Google Maps öffnen</a>`);
  }
  const herkunft = [akte.name, o.ordner].filter(Boolean).join(' › ');
  if (herkunft) zeilen.push(`<small>${esc(herkunft)}</small>`);

  /* Leer bleibt leer: Ein Objekt ohne Namen, Text und Merkmale bekam bisher
   * keine Sprechblase, und daran ändert der Knopf nichts. */
  if (!zeilen.length) return '';
  zeilen.push(`<button type="button" class="kml-km" data-kmlkm>Kilometer bestimmen` +
    `<small>rechnet die Stelle auf die Strecke — braucht Netz</small></button>`);
  return zeilen.join('');
}

function kmlEbene(akte) {
  const gruppe = L.featureGroup();
  const grund = akte.farbe || KML_FARBEN[0];
  const form = akte.symbol || 'kreis';
  const autoKarte = form === 'auto' ? kmlFormKarte(akte) : null;

  for (const o of akte.objekte) {
    if (!kmlSichtbarObj(akte, o)) continue;
    const s = o.stil || {};
    // Selbst gewählte Farbe schlägt die Angabe in der Datei — sonst hätte das
    // Auswählen bei Dateien mit eigenem Stil keine Wirkung
    const farbe = akte.farbeFest ? grund : (s.color || grund);
    const basis = {
      color: farbe,
      weight: s.weight || (o.art === 'a' ? 2 : 3),
      opacity: s.opacity == null ? 0.95 : s.opacity,
      // Ein Tipp auf ein KML-Objekt soll nicht zusätzlich die Kilometersuche auslösen
      bubblingMouseEvents: false
    };

    let l;
    if (o.art === 'p') {
      const punktFarbe = akte.farbeFest ? grund : (s.punkt || farbe);
      const punktForm = autoKarte ? (autoKarte.get(kmlWert(o, akte.autoFeld)) || 'kreis') : form;
      /* Auch der einfache Kreis läuft als Icon und nicht als circleMarker: So
       * liegen Punkt und Name in derselben Ebene ganz oben, und der Renderer,
       * der bei gedrehter Karte Ärger macht, ist für Punkte gar nicht im Spiel. */
      l = L.marker(o.koord, {
        pane: 'kmlIconPane', bubblingMouseEvents: false,
        icon: L.divIcon({ className: 'kml-sym', iconSize: [14, 14], iconAnchor: [7, 7],
          html: kmlSymbolSvg(punktForm, punktFarbe) })
      });
    } else if (o.art === 'l') {
      l = L.polyline(o.koord, basis);
    } else {
      l = L.polygon(o.koord, {
        ...basis,
        fill: s.fill !== false,
        fillColor: s.fillColor || farbe,
        fillOpacity: s.fillOpacity == null ? 0.18 : s.fillOpacity
      });
    }

    /* Sprechblase erst beim Tippen bauen: Das spart bei einer Datei mit tausend
     * Objekten tausend vorgefertigte Textbausteine, und vor allem lässt sich so
     * entscheiden, was ein Tipp bedeutet. Beim Messen ist ein KML-Objekt ein
     * Fangpunkt und keine Auskunft. */
    l.on('click', ev => {
      L.DomEvent.stopPropagation(ev);
      if (messModus) { messTipp(ev.latlng); return; }     // Fangen erledigt messTipp
      const html = kmlPopup(o, akte);
      if (!html) return;
      /* Bei einem Punkt gilt seine eigene Koordinate, sonst die angetippte
       * Stelle auf der Linie oder Fläche — und dieselbe Stelle hängt dann auch
       * am Knopf, damit Sprechblase und Kilometer vom selben Ort reden. */
      const wo = o.art === 'p' ? o.koord : [ev.latlng.lat, ev.latlng.lng];
      const blase = L.popup({
        className: 'kml-pop', maxWidth: 300,
        autoPanPaddingTopLeft: L.point(14, 86), autoPanPaddingBottomRight: L.point(14, 24)
      }).setLatLng(wo).setContent(html).openOn(map);

      const el = blase.getElement();
      const knopf = el && el.querySelector('[data-kmlkm]');
      if (knopf) knopf.addEventListener('click', () => {
        map.closePopup();          // ohne Argument, sonst behält Leaflet _popup gesetzt
        kmAnStelle(wo[0], wo[1], PUNKT_TOL);
      });
    });
    l.addTo(gruppe);
  }
  return gruppe;
}

/** Nächster Stützpunkt eines Objekts zu einem Tipp — beim Messen wird darauf gefangen. */
function kmlNaechsterKnoten(o, latlng) {
  if (o.art === 'p') return o.koord;
  const ringe = o.art === 'a' ? o.koord : [o.koord];
  let best = null, beste = Infinity;
  for (const ring of ringe) {
    for (const k of ring) {
      const d = haversine(latlng.lat, latlng.lng, k[0], k[1]);
      if (d < beste) { beste = d; best = k; }
    }
  }
  return best;
}

/** Wo die Beschriftung eines Objekts hängt. */
function kmlAnker(o) {
  if (o.art === 'p') return o.koord;
  if (o.art === 'l') return o.koord[Math.floor(o.koord.length / 2)];
  const ring = o.koord[0];
  return ring && ring[Math.floor(ring.length / 2)];
}

let kmlLabelLayer = null;

/* Namen erst ab KML_LABEL_ZOOM und nur, was im Bild liegt — sonst hängen bei
 * einer Datei mit tausend Punkten tausend Textknoten in der Karte. */
function kmlLabels() {
  if (!kmlLabelLayer) return;
  kmlLabelLayer.clearLayers();
  if (prefs.kmlNamen === false || map.getZoom() < KML_LABEL_ZOOM) return;

  const bild = map.getBounds().pad(0.08);
  let n = 0;
  for (const a of kmlAkten) {
    if (!a.sichtbar) continue;
    for (const o of a.objekte) {
      if (!kmlSichtbarObj(a, o)) continue;
      const txt = kmlLabelText(a, o);
      if (!txt) continue;
      const wo = kmlAnker(o);
      if (!wo || !bild.contains(wo)) continue;
      if (++n > KML_LABEL_MAX) return;      // Rest weglassen, statt alles zuzukleistern
      L.marker(wo, {
        pane: 'kmlIconPane', interactive: false, keyboard: false,
        icon: L.divIcon({ className: '', iconSize: null, iconAnchor: [-8, 7],
          html: `<span class="kml-lbl">${esc(txt)}</span>` })
      }).addTo(kmlLabelLayer);
    }
  }
}

function kmlZeigen(akte, sichtbar) {
  const alt = kmlEbenen.get(akte.id);
  if (alt) { map.removeLayer(alt); kmlEbenen.delete(akte.id); }
  akte.sichtbar = !!sichtbar;
  if (!sichtbar) return;
  const ebene = kmlEbene(akte);
  ebene.addTo(map);
  kmlEbenen.set(akte.id, ebene);
  kmlLabels();
}

/* -------- Liste im Menü -------- */

function kmlGroesse(b) {
  if (!b) return '';
  return b >= 950000
    ? (b / 1048576).toFixed(1).replace('.', ',') + ' MB'
    : Math.max(1, Math.round(b / 1024)) + ' KB';
}

let kmlOffeneKlappe = null;      // Index der Datei, deren Aussehen gerade offen steht

function kmlListe() {
  const box = $('#kmlList');
  if (!box) return;

  box.innerHTML = kmlAkten.map((a, i) => {
    const gezeigt = a.objekte.filter(o => kmlSichtbarObj(a, o)).length;
    const zahl = gezeigt === a.objekte.length
      ? nfM.format(a.objekte.length) + ' Objekte'
      : nfM.format(gezeigt) + ' von ' + nfM.format(a.objekte.length) + ' Objekten';
    const unter = [zahl, kmlGroesse(a.groesse), a.titel].filter(Boolean).join(' · ');
    const form = a.symbol || 'kreis';
    const felder = kmlFelder(a);
    const autoMoeglich = kmlAutoFeld(a) != null;
    const autoKarte = form === 'auto' ? kmlFormKarte(a) : null;
    const werte = kmlWerteMit(a, a.autoFeld);
    const labelFelder = a.labelFelder || ['name'];
    const zeigeSymbol = form === 'auto' ? (a.autoFeld ? 'auto' : 'kreis') : form;
    return `<div class="kml-zeile">
      <div class="kml-item">
        <button class="kml-dot" type="button" data-kstil="${i}" aria-label="Farbe und Symbol von ${esc(a.name)}">
          ${kmlSymbolSvg(zeigeSymbol, esc(a.farbe), true)}
        </button>
        <button class="kml-tog${a.sichtbar ? ' is-on' : ''}" type="button" data-ktog="${i}"
                aria-pressed="${a.sichtbar ? 'true' : 'false'}">
          <span class="kml-txt"><span class="kml-nm">${esc(a.name)}</span><small>${esc(unter)}</small></span>
        </button>
        <button class="kml-ic" type="button" data-kzoom="${i}" aria-label="Auf ${esc(a.name)} zoomen">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4H4v5M15 4h5v5M15 20h5v-5M9 20H4v-5"/></svg>
        </button>
        <button class="kml-ic del" type="button" data-kdel="${i}" aria-label="${esc(a.name)} entfernen">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <div class="kml-edit" data-kedit="${i}" hidden>
        <div class="kml-edit-kopf">
          <p class="kml-lab">Aussehen — ${esc(a.name)}</p>
          <button class="kml-zu" type="button" data-kzu="${i}">Fertig</button>
        </div>
        <p class="kml-lab">Farbe</p>
        <div class="kml-wahl">${KML_FARBEN.map(c =>
          `<button class="kml-farbe${c === a.farbe ? ' is-on' : ''}" type="button" data-kfarbe="${i}"
                   data-wert="${c}" style="background:${c}" aria-label="Farbe ${c}"></button>`).join('')}</div>

        <p class="kml-lab">Symbol</p>
        <div class="kml-wahl">
          ${autoMoeglich ? `<button class="kml-form kml-auto${form === 'auto' ? ' is-on' : ''}" type="button"
              data-kform="${i}" data-wert="auto">automatisch</button>` : ''}
          ${Object.entries(KML_FORMEN).map(([k, f]) =>
            `<button class="kml-form${k === form ? ' is-on' : ''}" type="button" data-kform="${i}"
                     data-wert="${k}" aria-label="${f.name}" title="${f.name}">${kmlSymbolSvg(k, esc(a.farbe), true)}</button>`).join('')}
        </div>
        ${felder.length ? `
        <p class="kml-lab">Merkmal</p>
        <div class="kml-wahl">${felder.filter(f => f.werte >= 2 && f.werte <= 30).map(f =>
          `<button class="kml-feld${f.key === a.autoFeld ? ' is-on' : ''}" type="button" data-kauto="${i}"
                   data-wert="${esc(f.key)}">${esc(f.key)} <small>${f.werte}</small></button>`).join('')}</div>` : ''}
        ${form === 'auto' && autoKarte ? `
        <div class="kml-legende">${[...autoKarte].map(([wert, k]) =>
          `<span>${kmlSymbolSvg(k, esc(a.farbe), false)}${esc(wert)}</span>`).join('')}</div>` : ''}
        ${werte.length > 1 ? `
        <p class="kml-lab">Sichtbar</p>
        <div class="kml-wahl">${werte.slice(0, 14).map(w =>
          `<button class="kml-feld${(a.ausWerte || []).includes(w.wert) ? '' : ' is-on'}" type="button"
                   data-kfilter="${i}" data-wert="${esc(w.wert)}">${esc(w.wert)} <small>${w.anzahl}</small></button>`).join('')}
          ${werte.length > 14 ? `<span class="kml-mehr">+${werte.length - 14} weitere</span>` : ''}</div>` : ''}

        <p class="kml-lab">Beschriftung</p>
        <div class="kml-wahl">
          <button class="kml-feld${labelFelder.includes('name') ? ' is-on' : ''}" type="button"
                  data-klabel="${i}" data-wert="name">Name</button>
          ${felder.map(f => `<button class="kml-feld${labelFelder.includes(f.key) ? ' is-on' : ''}" type="button"
                  data-klabel="${i}" data-wert="${esc(f.key)}">${esc(f.key)}</button>`).join('')}
        </div>
      </div>
    </div>`;
  }).join('');

  box.querySelectorAll('[data-kstil]').forEach(btn => btn.addEventListener('click', () => {
    const i = btn.dataset.kstil;
    const feld = box.querySelector(`[data-kedit="${i}"]`);
    if (!feld) return;
    feld.hidden = !feld.hidden;
    kmlOffeneKlappe = feld.hidden ? null : Number(i);
  }));

  box.querySelectorAll('[data-kzu]').forEach(btn => btn.addEventListener('click', () => {
    const feld = box.querySelector(`[data-kedit="${btn.dataset.kzu}"]`);
    if (feld) feld.hidden = true;
    kmlOffeneKlappe = null;
  }));

  // Nach dem Neuzeichnen die zuvor offene Klappe wieder aufmachen
  if (kmlOffeneKlappe != null) {
    const feld = box.querySelector(`[data-kedit="${kmlOffeneKlappe}"]`);
    if (feld) feld.hidden = false;
  }

  const stilGesetzt = (i, aenderung) => {
    const a = kmlAkten[i];
    if (!a) return;
    Object.assign(a, aenderung);
    kmlKopfMerken(a);
    if (a.sichtbar) kmlZeigen(a, true);      // mit neuem Aussehen neu aufbauen
    kmlLabels();
    kmlListe();
    kmlOffeneKlappe = i;                     // Klappe offen lassen, man probiert meist mehrere
    const feld = $('#kmlList').querySelector(`[data-kedit="${i}"]`);
    if (feld) feld.hidden = false;
  };

  box.querySelectorAll('[data-kfarbe]').forEach(btn => btn.addEventListener('click', () =>
    stilGesetzt(Number(btn.dataset.kfarbe), { farbe: btn.dataset.wert, farbeFest: true })));
  box.querySelectorAll('[data-kform]').forEach(btn => btn.addEventListener('click', () => {
    const i = Number(btn.dataset.kform), a = kmlAkten[i];
    const wahl = btn.dataset.wert;
    // Beim Umschalten auf automatisch ein Merkmal vorschlagen, falls noch keins steht
    stilGesetzt(i, wahl === 'auto' && a && !a.autoFeld
      ? { symbol: 'auto', autoFeld: kmlAutoFeld(a) }
      : { symbol: wahl });
  }));

  box.querySelectorAll('[data-kauto]').forEach(btn => btn.addEventListener('click', () =>
    // autoFeldFest: eine bewusste Wahl soll ein späterer Standardwechsel nicht umwerfen
    stilGesetzt(Number(btn.dataset.kauto), { autoFeld: btn.dataset.wert, autoFeldFest: true, ausWerte: [] })));

  box.querySelectorAll('[data-kfilter]').forEach(btn => btn.addEventListener('click', () => {
    const i = Number(btn.dataset.kfilter), a = kmlAkten[i];
    if (!a) return;
    const wert = btn.dataset.wert;
    const aus = a.ausWerte || [];
    stilGesetzt(i, { ausWerte: aus.includes(wert) ? aus.filter(x => x !== wert) : [...aus, wert] });
  }));

  box.querySelectorAll('[data-klabel]').forEach(btn => btn.addEventListener('click', () => {
    const i = Number(btn.dataset.klabel), a = kmlAkten[i];
    if (!a) return;
    const wahl = btn.dataset.wert;
    const jetzt = a.labelFelder || ['name'];
    stilGesetzt(i, { labelFelder: jetzt.includes(wahl) ? jetzt.filter(x => x !== wahl) : [...jetzt, wahl] });
  }));

  box.querySelectorAll('[data-ktog]').forEach(btn => btn.addEventListener('click', () => {
    const a = kmlAkten[Number(btn.dataset.ktog)];
    if (!a) return;
    kmlZeigen(a, !a.sichtbar);
    kmlKopfMerken(a);
    kmlLabels();
    kmlListe();
  }));

  box.querySelectorAll('[data-kzoom]').forEach(btn => btn.addEventListener('click', () => {
    const a = kmlAkten[Number(btn.dataset.kzoom)];
    if (!a) return;
    if (!a.sichtbar) { kmlZeigen(a, true); kmlKopfMerken(a); kmlListe(); }
    if (!a.grenzen) { toast('Zu dieser Datei ist keine Lage bekannt.'); return; }
    closeSheet();
    map.fitBounds(a.grenzen, { padding: [30, 30], maxZoom: 17 });
  }));

  box.querySelectorAll('[data-kdel]').forEach(btn => btn.addEventListener('click', async () => {
    const a = kmlAkten[Number(btn.dataset.kdel)];
    if (!a) return;
    if (!confirm(a.name + ' aus der Liste entfernen? Die Datei auf dem Gerät bleibt erhalten.')) return;
    kmlZeigen(a, false);
    kmlAkten = kmlAkten.filter(x => x.id !== a.id);
    kmlLabels();
    kmlListe();
    try { await kmlLoeschen(a.id); } catch { /* sonst ist sie nach dem Neuladen wieder da */ }
  }));
}

/* -------- Dateien öffnen -------- */

async function kmlOeffnen(dateien) {
  let letzte = null, zahl = 0;

  for (const datei of dateien) {
    try {
      const buf = await datei.arrayBuffer();
      const istZip = buf.byteLength > 4 && new DataView(buf).getUint32(0, false) === 0x504b0304;
      const roh = istZip ? await kmzText(buf) : kmlDekodieren(buf);
      const geparst = kmlParse(roh);
      if (!geparst.objekte.length) { toast(datei.name + ': keine Geometrie gefunden.'); continue; }

      const vorlaeufig = { objekte: geparst.objekte };
      const autoFeld = kmlAutoFeld(vorlaeufig);
      const akte = {
        id: 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: datei.name.replace(/\.(kml|kmz)$/i, '') || 'KML',
        /* Trägt die Datei ein Merkmal, das nach Typ aussieht, werden die Formen
         * gleich danach unterschieden — genau dafür steht es ja drin. */
        symbol: autoFeld ? 'auto' : 'kreis',
        autoFeld,
        labelFelder: ['name'],
        titel: geparst.titel && geparst.titel !== datei.name ? geparst.titel : '',
        farbe: KML_FARBEN[kmlAkten.length % KML_FARBEN.length],
        groesse: datei.size,
        anzahl: geparst.objekte.length,
        angelegt: Date.now(),
        sichtbar: true,
        grenzen: geparst.grenzen,
        objekte: geparst.objekte
      };

      try { await kmlAblegen(akte); }
      catch { toast('Speichern nicht möglich — die Datei ist nur bis zum Neuladen da.'); }

      kmlAkten.push(akte);
      kmlZeigen(akte, true);
      letzte = akte;
      zahl++;
    } catch (err) {
      toast(datei.name + ': ' + err.message);
    }
  }

  kmlListe();
  kmlLabels();
  if (!letzte) return;

  if (letzte.grenzen) map.fitBounds(letzte.grenzen, { padding: [30, 30], maxZoom: 17 });
  const viel = letzte.anzahl > KML_VIEL ? ' — bei so vielen kann die Karte träge werden' : '';
  toast(zahl > 1
    ? zahl + ' Dateien geladen.'
    : `${letzte.name}: ${nfM.format(letzte.anzahl)} Objekte${viel}.`);
}

async function kmlBoot() {
  kmlLabelLayer = L.layerGroup().addTo(map);
  map.on('moveend', kmlLabels);
  try { kmlAkten = await kmlLaden(); }
  catch { return; }        // privater Modus oder gesperrter Speicher

  /* Schon geladene Dateien auf den aktuellen Standard nachziehen — sonst würde
   * eine bereits abgelegte Datei ewig nach dem alten Merkmal unterscheiden. */
  for (const a of kmlAkten) {
    if (a.symbol !== 'auto' || a.autoFeldFest) continue;
    const feld = kmlAutoFeld(a);
    if (feld && feld !== a.autoFeld) { a.autoFeld = feld; kmlKopfMerken(a); }
  }

  for (const a of kmlAkten) if (a.sichtbar) kmlZeigen(a, true);
  kmlLabels();
  kmlListe();
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
      // Beim Messen ist ein Stein ein bequemer Fangpunkt, kein neues Suchergebnis
      if (messModus) { messTipp(ev.latlng || L.latLng(p.lat, p.lon)); return; }
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

/* ---- Punkt von Hand setzen ----
 *
 * Ein kurzer Tipp liest sofort den Kilometer ab. Das ist bequem, im Gelände
 * aber schnell versehentlich, und deshalb gibt es den Fadenkreuz-Knopf zum
 * Abschalten. Gewünscht war stattdessen ein bewusster Griff: lange drücken
 * (am Rechner die rechte Maustaste) setzt einen Punkt, und erst ein Knopf in
 * der Sprechblase rechnet ihn auf die Strecke — genau wie bei einem Punkt aus
 * einer KML-Datei. Von dort führt auch der Weg direkt zu Google Maps.
 */
const MERK_DAUER = 500;      // ms, ab wann ein Druck als „lang" gilt
const MERK_WACKEL = 12;      // px, so viel darf der Finger dabei wandern

function merkPunkt(lat, lon) {
  if (messModus) return;
  merkLayer.clearLayers();
  const wo = [lat, lon];

  L.marker(wo, {
    pane: 'kmlIconPane', keyboard: false,
    icon: L.divIcon({ className: '', html: '<div class="merk-pin"></div>',
      iconSize: [18, 18], iconAnchor: [9, 9] })
  }).addTo(merkLayer);

  const blase = L.popup({
    className: 'kml-pop', maxWidth: 300,
    autoPanPaddingTopLeft: L.point(14, 86), autoPanPaddingBottomRight: L.point(14, 24)
  }).setLatLng(wo).setContent(
    `<b>Gesetzter Punkt</b>` +
    `<span>${fmtCoord(lat, lon)}</span>` +
    `<a href="${gmapsUrl(lat, lon)}" target="_blank" rel="noopener">In Google Maps öffnen</a>` +
    `<a href="${gmapsRoute(lat, lon)}" target="_blank" rel="noopener" class="merk-zweit">Route dorthin</a>` +
    `<button type="button" class="kml-km" data-merkkm>Kilometer bestimmen` +
    `<small>rechnet die Stelle auf die Strecke</small></button>`
  ).openOn(map);

  /* Sprechblase zu heißt Punkt weg — über das ×, mit Escape oder durch einen
   * Griff daneben. Ein eigener Knopf „Punkt entfernen" wäre daneben nur eine
   * zweite Art, dasselbe zu tun. */
  const aufraeumen = ev => {
    if (ev.popup !== blase) return;
    merkLayer.clearLayers();
    map.off('popupclose', aufraeumen);
  };
  map.on('popupclose', aufraeumen);

  const el = blase.getElement();
  const knopf = el && el.querySelector('[data-merkkm]');
  if (knopf) knopf.addEventListener('click', () => {
    map.closePopup();
    kmAnStelle(lat, lon, PUNKT_TOL);
  });
}

function merkPunktBinden() {
  let zuletzt = 0;

  map.on('contextmenu', ev => {
    L.DomEvent.preventDefault(ev);
    // Auf dem Gerät schickt der Browser nach einem langen Druck oft noch ein
    // contextmenu hinterher — das wäre dann der zweite Auslöser für dieselbe Geste.
    if (Date.now() - zuletzt < 900) return;
    zuletzt = Date.now();
    merkPunkt(ev.latlng.lat, ev.latlng.lng);
  });

  const flaeche = map.getContainer();
  let uhr = null, start = null;

  const abbrechen = () => { clearTimeout(uhr); uhr = null; start = null; };

  flaeche.addEventListener('touchstart', ev => {
    if (ev.touches.length !== 1) { abbrechen(); return; }
    const t = ev.touches[0];
    start = { x: t.clientX, y: t.clientY };
    clearTimeout(uhr);
    uhr = setTimeout(() => {
      uhr = null;
      const k = flaeche.getBoundingClientRect();
      const p = map.containerPointToLatLng(L.point(start.x - k.left, start.y - k.top));
      zuletzt = Date.now();
      merkPunkt(p.lat, p.lng);
    }, MERK_DAUER);
  }, { passive: true });

  flaeche.addEventListener('touchmove', ev => {
    if (!start || !ev.touches.length) return;
    const t = ev.touches[0];
    if (Math.hypot(t.clientX - start.x, t.clientY - start.y) > MERK_WACKEL) abbrechen();
  }, { passive: true });

  flaeche.addEventListener('touchend', abbrechen, { passive: true });
  flaeche.addEventListener('touchcancel', abbrechen, { passive: true });
}

/* ============================ Messen ============================ */

/* Luftlinie zwischen angetippten Punkten, bewusst ohne Netzabfrage: Im Gelände
 * zählt zuerst, wie weit es geradeaus ist, und das rechnet der Browser selbst.
 * Liegen Anfang und Ende auf der geladenen Strecke, steht zusätzlich die
 * Differenz nach Kilometrierung dabei — die ist für die Arbeit oft die
 * eigentliche Antwort.
 *
 * Die Linie liegt in der normalen Vektorebene von Leaflet und nicht in einer
 * eigenen Pane: Eigene Panes rechnet leaflet-rotate falsch, siehe kmlPane. */
const MESS_FARBE = '#f59e0b';        // Amber, damit es sich von Steinen (blau) und Gleisweg (grün) abhebt
const MESS_TOL = 60;                 // bis zu so viel Abstand gilt ein Punkt als auf der Strecke

const MESS_FANG_PX = 26;             // Umkreis, in dem Fangpunkte angeboten werden
/* Von selbst gefangen wird nur innerhalb dieser Strecke. Der Umkreis in
 * Bildpunkten allein genügt nicht: Auf Zoomstufe 15 sind 26 px rund 125 m, und
 * bei einer dichten Punktdatei würde dann jeder Tipp still auf irgendeinen Punkt
 * springen — die Messung wäre um diese Strecke falsch, ohne dass man es sieht.
 * Weiter entfernte Punkte stehen weiter zur Auswahl, nur eben nicht automatisch.
 *
 * 20 m, weil genaues Arbeiten ohnehin nah herangezoomt stattfindet: Ab Zoomstufe
 * 18 sind 26 px selbst nur noch 15 m, dort bestimmt also der Bildabstand. Beim
 * groben Messen weiter außen bleibt der Punkt dagegen dort, wo getippt wurde. */
const MESS_FANG_MAX_M = 20;

let messModus = false;
let messPunkte = [];
let messLayer = null;
let messLiveLayer = null;            // nur die laufende Linie zum Standort
let messKandidaten = [];             // Auswahl für den zuletzt gesetzten Punkt
let messWahl = 0;
let messLetzterTipp = 0;             // Zeitpunkt des letzten angenommenen Tipps

const messText = m => m < 1000 ? nfM.format(m) + ' m' : fmtKm(m / 1000) + ' km';

function messLaenge() {
  let summe = 0;
  for (let i = 1; i < messPunkte.length; i++) {
    summe += haversine(messPunkte[i - 1][0], messPunkte[i - 1][1], messPunkte[i][0], messPunkte[i][1]);
  }
  return summe;
}

/** Kilometerdifferenz zwischen erstem und letztem Punkt, falls beide auf der Strecke liegen. */
function messKmDifferenz() {
  const e = view.ref && lineCache.get(view.ref);
  if (!e || e.sorted.length < 2 || messPunkte.length < 2) return null;
  const a = projectOnLine(e.sorted, messPunkte[0][0], messPunkte[0][1]);
  const b = projectOnLine(e.sorted, messPunkte[messPunkte.length - 1][0], messPunkte[messPunkte.length - 1][1]);
  if (!a || !b || a.dist > MESS_TOL || b.dist > MESS_TOL) return null;
  return { km: Math.abs(b.km - a.km), von: a.km, bis: b.km };
}

/* Was liegt nah genug am Tipp, um gefangen zu werden? Kilometersteine der
 * geladenen Strecke und Objekte aus sichtbaren KML-Dateien. Gefangen wird sofort
 * auf das Nächstliegende — die übrigen stehen zum Umschalten in der Leiste, denn
 * gerade bei Punktpaaren wenige Meter auseinander trifft der Finger nicht
 * unbedingt den gemeinten. */
function messKandidatenFinden(latlng) {
  const tol = Math.max(pixelInMeter(latlng, MESS_FANG_PX), 2);
  const raus = [];

  const e = view.ref && lineCache.get(view.ref);
  if (e) {
    for (const p of e.sorted) {
      const d = haversine(latlng.lat, latlng.lng, p.lat, p.lon);
      if (d <= tol) raus.push({ name: 'km ' + fmtKm(p.km), quelle: 'Stein ' + (p.ref || view.ref), koord: [p.lat, p.lon], dist: d });
    }
  }

  for (const a of kmlAkten) {
    if (!a.sichtbar) continue;
    for (const o of a.objekte) {
      if (!kmlSichtbarObj(a, o)) continue;
      const k = kmlNaechsterKnoten(o, latlng);
      if (!k) continue;
      const d = haversine(latlng.lat, latlng.lng, k[0], k[1]);
      if (d <= tol) raus.push({ name: o.name || '(ohne Namen)', quelle: a.name, koord: k, dist: d });
    }
  }

  raus.sort((x, y) => x.dist - y.dist);

  /* Dieselbe Stelle nicht mehrfach anbieten: Ist eine Datei zweimal geladen oder
   * liegen zwei Objekte auf derselben Koordinate, verdrängen die Doppelgänger
   * sonst die tatsächlich anderen Punkte aus der Auswahl. */
  const gesehen = new Set();
  const eindeutig = [];
  for (const k of raus) {
    const stelle = k.koord[0].toFixed(7) + ',' + k.koord[1].toFixed(7);
    if (gesehen.has(stelle)) continue;
    gesehen.add(stelle);
    eindeutig.push(k);
  }
  return eindeutig.slice(0, 4);
}

/* Livemessen: Steht ein Punkt, läuft die Strecke vom letzten Punkt zur
 * Kartenmitte mit — beim Schieben der Karte, bei jedem Bild. Damit bekommt man
 * eine Entfernung sofort, ohne erst einen zweiten Punkt zu setzen; „Mitte"
 * friert sie als Punkt ein.
 *
 * Die Linie wird dabei nicht neu gebaut, sondern nur umgesetzt, und die Zahl
 * steht am Fadenkreuz selbst — also immer an derselben Stelle des Bildschirms,
 * ruhig zu lesen, während sich die Karte bewegt. Ein Neuaufbau je Bild würde
 * flackern und wäre auf dem Handy zäh. */

let messLiveLinie = null;

function messLiveZeichnen() {
  const zahl = $('#mitteZahl');
  const zeile = $('#messLive');

  if (!messModus || !messPunkte.length) {
    if (messLiveLinie) { messLiveLinie.remove(); messLiveLinie = null; }
    if (zahl) zahl.textContent = '';
    if (zeile) zeile.textContent = '';
    return;
  }

  const von = messPunkte[messPunkte.length - 1];
  const mitte = map.getCenter();
  const d = haversine(von[0], von[1], mitte.lat, mitte.lng);

  if (!messLiveLinie) {
    messLiveLinie = L.polyline([von, [mitte.lat, mitte.lng]], {
      color: MESS_FARBE, weight: 2, opacity: 0.75, dashArray: '4 5', interactive: false
    }).addTo(messLiveLayer);
  } else {
    messLiveLinie.setLatLngs([von, [mitte.lat, mitte.lng]]);
  }

  if (zahl) zahl.textContent = messText(d);
  if (zeile) {
    zeile.textContent = messPunkte.length > 1
      ? `bis Kartenmitte ${messText(d)} · mit diesem Abschnitt ${messText(messLaenge() + d)}`
      : `bis Kartenmitte ${messText(d)}`;
  }
}

function messZeichnen() {
  if (!messLayer) return;
  messLayer.clearLayers();
  if (messLiveLayer) messLiveLayer.clearLayers();
  messLiveLinie = null;
  messLiveZeichnen();


  if (messPunkte.length > 1) {
    L.polyline(messPunkte, {
      color: MESS_FARBE, weight: 3, opacity: 0.95, dashArray: '7 5', interactive: false
    }).addTo(messLayer);
  }

  messPunkte.forEach((p, i) => {
    L.circleMarker(p, {
      radius: 5, color: '#fff', weight: 2, fillColor: MESS_FARBE, fillOpacity: 1, interactive: false
    }).addTo(messLayer);

    if (!i) return;
    const vor = messPunkte[i - 1];
    const d = haversine(vor[0], vor[1], p[0], p[1]);
    L.marker([(vor[0] + p[0]) / 2, (vor[1] + p[1]) / 2], {
      interactive: false, keyboard: false,
      icon: L.divIcon({ className: '', iconSize: null, iconAnchor: [-7, 7],
        html: `<span class="mess-lbl">${esc(messText(d))}</span>` })
    }).addTo(messLayer);
  });
}

function messLeiste() {
  const b = $('#bottom');
  b.hidden = false;

  const laenge = messLaenge();
  const kd = messKmDifferenz();
  const letzte = messPunkte.length > 1
    ? haversine(...messPunkte[messPunkte.length - 2], ...messPunkte[messPunkte.length - 1])
    : 0;

  const gewaehlt = messPunkte.length ? messKandidaten[messWahl] : null;
  const gefangen = gewaehlt && messWahl > 0 ? ` · gefangen auf ${gewaehlt.name}` : '';

  const zeilen = [];
  if (!messPunkte.length) zeilen.push('Auf die Karte tippen setzt den ersten Punkt.');
  else if (messPunkte.length === 1) zeilen.push('Erster Punkt steht — nächsten Punkt antippen' + gefangen + '.');
  else zeilen.push(`${messPunkte.length} Punkte · letzter Abschnitt ${messText(letzte)}${gefangen}`);

  /* Auswahl nur zeigen, wenn es überhaupt etwas zu wählen gibt: der Tippstelle
   * gegenüber mindestens ein Fangpunkt. */
  const wahl = messKandidaten.length > 1 && messPunkte.length
    ? `<div class="pick">${messKandidaten.map((k, i) =>
        `<button type="button" data-mw="${i}"${i === messWahl ? ' class="is-on"' : ''}>${esc(k.name)}` +
        `<small>${i ? esc(nfM.format(k.dist) + ' m · ' + k.quelle) : 'Tippstelle'}</small></button>`).join('')}</div>`
    : '';

  b.innerHTML = `
    <button type="button" id="bbClose" class="bb-close" aria-label="Messen beenden">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
    </button>
    <div class="bb-head">
      <p class="bb-title">Messen</p>
      <span class="tag warn">Luftlinie</span>
    </div>
    <p class="bb-coord">${messPunkte.length > 1 ? esc(messText(laenge)) : '—'}</p>
    <p class="bb-note plain">${esc(zeilen[0])}</p>
    <p class="bb-note plain" id="messLive"></p>
    ${wahl}
    ${kd ? `<p class="bb-note plain">Nach Kilometrierung ${esc(messText(kd.km * 1000))} — von km ${esc(fmtKm(kd.von))} bis km ${esc(fmtKm(kd.bis))} der Strecke ${esc(view.ref)}.</p>` : ''}
    <div class="bb-actions wrap">
      <button type="button" id="messMitte">Mitte</button>
      <button type="button" id="messHier"${ortAn() ? '' : ' disabled'}>Standort</button>
      <button type="button" id="messZurueck">Zurück</button>
      <button type="button" id="messLeer">Leeren</button>
      <button type="button" id="messFertig">Fertig</button>
    </div>`;

  const zu = $('#bbClose');
  if (zu) zu.addEventListener('click', messEnde);
  const zurueck = $('#messZurueck');
  if (zurueck) zurueck.addEventListener('click', () => {
    messPunkte.pop();
    messKandidaten = [];      // gehören zum entfernten Punkt
    messZeichnen();
    messLeiste();
  });
  const leer = $('#messLeer');
  if (leer) leer.addEventListener('click', () => {
    messPunkte = [];
    messKandidaten = [];
    messZeichnen();
    messLeiste();
  });

  /* Die Kartenmitte als Punkt: Auf dem Handy trifft der Finger keine 20 cm, die
   * Karte lässt sich aber beliebig genau unter das feste Kreuz schieben. */
  const mitte = $('#messMitte');
  if (mitte) mitte.addEventListener('click', () => messTipp(map.getCenter()));
  messLiveZeichnen();      // die laufende Zahl gehört sofort in die neue Leiste

  const hier = $('#messHier');
  if (hier) hier.addEventListener('click', () => {
    if (!ortLetzt) { toast('Erst den Standort verfolgen lassen.'); return; }
    messTipp(L.latLng(ortLetzt.lat, ortLetzt.lon));
  });

  // Umschalten zwischen Tippstelle und den Fangpunkten in der Nähe
  b.querySelectorAll('[data-mw]').forEach(btn => btn.addEventListener('click', () => {
    const i = Number(btn.dataset.mw);
    if (!messKandidaten[i] || !messPunkte.length) return;
    messWahl = i;
    messPunkte[messPunkte.length - 1] = messKandidaten[i].koord;
    messZeichnen();
    messLeiste();
    liveLeiste();
  }));
  const fertig = $('#messFertig');
  if (fertig) fertig.addEventListener('click', messEnde);

  updateBH();
}

function messStart() {
  messModus = true;
  messPunkte = [];
  messKandidaten = [];
  messLetzterTipp = 0;
  map.closePopup();          // eine offene KML-Auskunft stört beim Messen
  if (!messLayer) messLayer = L.layerGroup().addTo(map);
  if (!messLiveLayer) messLiveLayer = L.layerGroup().addTo(map);

  /* Doppeltipp-Zoom aus, solange gemessen wird. Zwei Punkte schnell
   * hintereinander gesetzt wertet Leaflet sonst als Doppeltipp: Es zoomt und
   * verschluckt den zweiten Tipp — die Messung fehlt dann einen Punkt. */
  if (map.doubleClickZoom) map.doubleClickZoom.disable();
  messZeichnen();
  messLeiste();
  liveLeiste();
  closeSheet();
  syncButtons();
  toast('Messen: auf die Karte tippen. Kilometersteine und KML-Punkte werden gefangen.');
}

function messEnde() {
  messModus = false;
  messPunkte = [];
  messKandidaten = [];
  if (messLayer) messLayer.clearLayers();
  if (messLiveLayer) messLiveLayer.clearLayers();
  messLiveLinie = null;
  messLiveZeichnen();
  if (map.doubleClickZoom) map.doubleClickZoom.enable();
  liveLeiste();
  syncButtons();
  renderBottom();      // zeigt wieder den vorherigen Punkt, falls es einen gibt
}

function messTipp(latlng) {
  latlng = L.latLng(latlng);

  /* Manche Geräte melden einen Tipp doppelt (nativ und über Leaflets
   * Tipperkennung). Zwei Meldungen dicht hintereinander an nahezu derselben
   * Stelle sind deshalb derselbe Tipp und nicht zwei Punkte. */
  const jetzt = Date.now();
  if (messPunkte.length && jetzt - messLetzterTipp < 350) {
    const vor = messPunkte[messPunkte.length - 1];
    const a = map.latLngToContainerPoint(latlng);
    const b = map.latLngToContainerPoint(L.latLng(vor[0], vor[1]));
    if (a.distanceTo(b) < 8) return;
  }
  messLetzterTipp = jetzt;

  const nah = messKandidatenFinden(latlng);
  messKandidaten = [{ name: 'Getippt', quelle: '', koord: [latlng.lat, latlng.lng], dist: 0 }, ...nah];
  // Nur fangen, wenn der Punkt auch in Metern nah liegt — sonst bleibt die Tippstelle
  messWahl = nah.length && nah[0].dist <= MESS_FANG_MAX_M ? 1 : 0;
  messPunkte.push(messKandidaten[messWahl].koord);
  messZeichnen();
  messLeiste();
}

/* ============================ Klick auf die Karte ============================ */

/** Wie viele Meter entsprechen an dieser Stelle einer Strecke von px Bildpunkten? */
function pixelInMeter(latlng, px) {
  const a = map.latLngToContainerPoint(latlng);
  const b = map.containerPointToLatLng(L.point(a.x + px, a.y));
  return map.distance(latlng, b);
}

/** Wie viele Meter sind CLICK_TOL_PX auf der aktuellen Zoomstufe? */
function toleranceMeters(latlng) {
  return Math.max(pixelInMeter(latlng, CLICK_TOL_PX), 25);
}

/* Ein kurzer Tipp liest bewusst nichts mehr ab.
 *
 * Früher las jeder Tipp sofort den Kilometer, und ein Fadenkreuz-Knopf schaltete
 * das ab, weil im Gelände ständig versehentlich getippt wird. Beides ist
 * überflüssig, seit ein langer Druck einen Punkt setzt: Der Griff ist dann
 * bewusst, und die Sprechblase fragt, was damit geschehen soll. Kilometersteine
 * und KML-Objekte bleiben antippbar — die trifft man nicht zufällig. */
function onMapClick(ev) {
  if (messModus) messTipp(ev.latlng);
}

/** Aus einem Sehnentreffer den anzuzeigenden Punkt bauen — nach Möglichkeit auf dem Gleis.
 *
 * Der Kilometer bleibt der aus der Sehne gelesene; verschoben wird nur, wo der
 * Punkt gezeichnet und weitergereicht wird. Angezeigt heißt das: „deine Stelle,
 * auf die Schiene gesetzt" und nicht „der Ort von Kilometer X". */
async function kartePunkt(ref, hit, lat, lon, operator) {
  /* Liegt der Verlauf mitgeliefert vor, entscheidet der Umweg, welcher
   * Kilometer gilt. Ein einzelner Bogen schadet der Sehne nicht — entlang
   * eines Kreisbogens hebt sich die Abweichung zur Mitte hin auf. Erst wenn
   * zwischen den Steinen mehrere Bögen und Geraden liegen, trägt dieses
   * Argument nicht mehr, und dann schneidet die Sehne spürbar ab.
   *
   * Gemessen an 553 übersprungenen Zwischensteinen ist der Steinabstand
   * allein der schlechtere Auslöser: unter 1,5 km ist die Sehne besser,
   * gleich ob es dort krümmt (Median 14 m gegen 22 m), über 1,5 km und krumm
   * dreht es sich um (34/115 m gegen 22/72 m). Was zählt, ist also nicht die
   * Länge und nicht die Krümmung, sondern wie viel Weg die Sehne abschneidet.
   * Ab 200 m Umweg zu wechseln räumt die Ausreißer weg: Fälle über 100 m
   * Fehler gehen von 7 auf 1, das 99. Perzentil von 144 auf 106 m, bei
   * unverändertem Median. */
  const weg = await kmEntlangGleis(ref, lat, lon, true);
  if (weg && weg.wegLaenge - weg.chord > UMWEG_GRENZE) {
    const { pfad, ...punkt } = weg;
    punkt.umweg = weg.wegLaenge - weg.chord;
    return punkt;
  }

  const p = {
    km: hit.km,
    lat: hit.lat, lon: hit.lon, quality: 'karte',
    between: hit.between, offset: hit.dist, chord: hit.chord, spanRatio: hit.spanRatio,
    operator, lineRef: ref
  };
  const gleis = await aufGleisSetzen(ref, lat, lon, Math.max(250, hit.dist + 200));
  if (gleis) {
    p.aufGleis = haversine(hit.lat, hit.lon, gleis.lat, gleis.lon);
    p.lat = gleis.lat;
    p.lon = gleis.lon;
    p.offset = gleis.dist;      // echter Abstand quer zum Gleis statt zur Sehne
  }
  return p;
}

/* Welcher Kilometer gilt an dieser Stelle?
 *
 * Zuerst die schon geladene Strecke — das geht ohne Netz und ohne Wartezeit.
 * Erst wenn der Punkt dort nicht hinpasst, muss Overpass sagen, welche Strecke
 * hier überhaupt liegt.
 *
 * tol ist die Toleranz quer zur Strecke: beim Tippen die Fingerbreite auf der
 * aktuellen Zoomstufe, bei einem gesetzten Punkt aus einer KML-Datei ein fester
 * Wert — dessen Koordinate steht ja fest und soll nicht je nach Zoomstufe an
 * eine andere Linie springen. */
async function kmAnStelle(lat, lng, tol) {
  if (view.busy) return;

  const e = view.ref && lineCache.get(view.ref);

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
      const punkt = await kartePunkt(view.ref, hit, lat, lng, e.sorted[0].operator);
      applyPoint(view.ref, punkt.km, punkt);
      coverage(view.ref, punkt.km).then(drawMilestones).catch(() => { });
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
/** Wie steht es an dieser Stelle um das mitgelieferte Netz?
 *  'aus' kein Index · 'draussen' außerhalb des erzeugten Gebiets ·
 *  'fehlt' erzeugt, aber nicht auf dem Gerät · 'da' vorhanden. */
async function netzLage(lat, lon) {
  const ix = await netzBereit();
  if (!ix) return 'aus';
  const name = Math.floor(lat / ix.raster) + '_' + Math.floor(lon / ix.raster);
  if (!ix.da.has(name)) return 'draussen';
  if (!ix.mitInhalt.has(name)) return 'da';        // erzeugt und nachweislich leer
  return (await netzKachel(name)) ? 'da' : 'fehlt';
}

/** Dieselbe Auskunft wie linesNear, nur aus den mitgelieferten Kacheln. */
async function netzLinesNear(lat, lon) {
  const dLat = SEED_RADIUS / 110540;
  const dLon = SEED_RADIUS / (111320 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
  const bereich = await netzBereich(lat - dLat, lon - dLon, lat + dLat, lon + dLon);
  if (!bereich) return null;

  const gehoertZu = (w, ref) => w.ref && String(w.ref).split(';').some(t => t.trim() === ref);

  const byRef = new Map();
  for (const w of bereich.wege) {
    if (!w.ref) continue;
    const d = distToWay(lat, lon, w.geometry);
    if (d > 80) continue;                       // derselbe Umkreis wie in der Overpass-Abfrage
    for (const part of String(w.ref).split(';')) {
      const r = part.trim();
      if (!r) continue;
      if (!byRef.has(r) || byRef.get(r) > d) byRef.set(r, d);
    }
  }

  return {
    refs: [...byRef.entries()].sort((a, b) => a[1] - b[1]).slice(0, 4).map(([ref, dist]) => {
      /* Kilometerpunkte tragen in der Kachel keine Streckennummer. Zugeordnet
       * werden sie über die Lage: Was auf dem Gleis dieser Strecke steht,
       * gehört zu ihr. Ohne diese Prüfung würde ein weiter Suchradius die
       * Punkte der Nachbarstrecke einsammeln. */
      const gleise = bereich.wege.filter(w => gehoertZu(w, ref));
      const eigene = bereich.punkte.filter(p => gleise.some(w => distToWay(p.lat, p.lon, w.geometry) < 25));
      return { ref, dist, seeds: startwerte(eigene.map(p => ({ km: p.km, dist: haversine(lat, lon, p.lat, p.lon) }))) };
    })
  };
}

/* Mehrere Startwerte statt nur des nächsten.
 *
 * Die ORM-Abfrage liefert die Steine im Umkreis der angefragten Position. Liegt
 * der nächste Kilometerpunkt weit weg, deckt eine einzige Abfrage womöglich nur
 * eine Seite ab. Gemeldet an Strecke 5321 bei 49,520913 / 10,274394: Der nächste
 * Punkt war km 96,2 in 4038 m, der übernächste km 87,2 in 4268 m — auf der
 * anderen Seite. Mit dem Startwert 96,2 fehlte der Stein bei 87,2, und damit gab
 * es kein Paar, das den Punkt einschließt.
 *
 * Deshalb nach Abstand sortiert bis zu vier deutlich verschiedene Kilometerwerte
 * anbieten; useLineAt probiert sie der Reihe nach. */
function startwerte(kandidaten) {
  const raus = [];
  for (const k of kandidaten.filter(k => k.dist <= SEED_RADIUS).sort((a, b) => a.dist - b.dist)) {
    if (raus.some(v => Math.abs(v.km - k.km) < 5)) continue;   // dieselbe Gegend, bringt nichts
    raus.push(k);
    if (raus.length >= 4) break;
  }
  return raus;
}

async function linesNear(lat, lon) {
  /* Erst das Mitgelieferte — das ist sofort da und hängt an keinem fremden Dienst.
   *
   * Auch ein leeres Ergebnis zählt: Die Kacheln führen jede nummerierte Strecke,
   * die Overpass hier fände. Der erste Durchgang holt alle Gleise ohne
   * service-Tag, der zweite alles, was trotz service-Tag eine Nummer trägt —
   * zusammen also jeden Weg mit ref. Sagt die Kachel „hier liegt keine
   * nummerierte Strecke", dann stimmt das, und danach noch Overpass zu fragen
   * kostet nur die Wartezeit. Gemeldet als „wenn man zu weit vom Gleis weg
   * drückt, braucht die Meldung ewig". */
  const lokal = await netzLinesNear(lat, lon);
  if (lokal) return lokal;

  /* Kilometerangaben hängen nicht nur an Steinen: Bahnübergänge, Signale und
   * Weichen tragen sie genauso, und zwar mal als railway:position, mal als
   * railway:position:exact. Am Meldepunkt bei Bischofswiesen stand der nächste
   * Stein 1138 m entfernt, ein Bahnübergang mit railway:position:exact aber
   * 596 m — mit der alten Abfrage (nur railway=milestone, nur 900 m) fiel genau
   * dieser weg und die Kilometersuche brach ab. Beides mitnehmen und weiter
   * hinausschauen; als Startwert für die ORM-Abfrage reicht ein grober Wert. */
  const q = `[out:json][timeout:25];` +
    `way(around:80,${lat},${lon})[railway~"^(rail|light_rail|narrow_gauge)$"][ref]->.w;` +
    `node(around:${SEED_RADIUS},${lat},${lon})[railway]["railway:position"]->.n1;` +
    `node(around:${SEED_RADIUS},${lat},${lon})[railway]["railway:position:exact"]->.n2;` +
    `.w out tags geom 40;` +
    `(.n1;.n2;)->.n;` +
    `.n out body 120;`;     // body, nicht tags — sonst fehlen die Koordinaten der Knoten

  let data = null, lastErr = null;
  for (const ep of OVERPASS) {
    try { data = await tryFetch(ep + '?data=' + encodeURIComponent(q), 25000); break; }
    catch (err) { lastErr = err; }
  }
  if (!data) {
    throw new Error('kein Overpass-Server hat geantwortet (' + (lastErr && lastErr.message || 'unbekannt') + ')');
  }

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

  // Kilometerangaben als Startwerte — die ORM-API braucht eine Position,
  // um überhaupt etwas ausliefern zu können.
  const stones = els
    .filter(n => n.type === 'node' && n.tags)
    .map(n => {
      const roh = n.tags['railway:position'] != null ? n.tags['railway:position'] : n.tags['railway:position:exact'];
      return { km: parseFloat(String(roh).replace(',', '.')), dist: haversine(lat, lon, n.lat, n.lon) };
    })
    .filter(s => isFinite(s.km));

  return { refs, seeds: startwerte(stones) };
}

async function lookupByClick(lat, lon) {
  setBusy(true);
  showStatus('Suche, welche Strecke hier liegt …');
  try {
    const { refs, seeds } = await linesNear(lat, lon);
    if (!refs.length) {
      showError('Hier ist keine nummerierte Strecke erfasst. Näher an ein Gleis tippen.');
      return;
    }
    /* Ohne Kilometerangabe in der Nähe geht es trotzdem weiter: den Startwert
     * holt sich useLineAt dann bei der Strecke selbst. */
    if (refs.length === 1) {
      await useLineAt(refs[0].ref, refs[0].seeds || seeds, lat, lon);
    } else {
      showPicker(refs, seeds, lat, lon);
    }
  } catch (err) {
    /* Die Meldung soll den wahren Grund nennen. Overpass ist nur noch der
     * Rückfall; wer im Gelände ohne Netz auf eine Stelle tippt, deren Kachel
     * noch nie geladen wurde, scheitert nicht an Overpass, sondern daran, dass
     * die Kachel fehlt — und genau das gehört dort hin. */
    const lage = await netzLage(lat, lon);
    showError(lage === 'fehlt'
      ? `Für diese Gegend ist das Gleisnetz noch nicht auf dem Gerät, und ohne Netz lässt es ` +
        `sich nicht holen (${err.message}). Kacheln kommen beim ersten Hinschauen mit Empfang ` +
        `aufs Gerät und bleiben dann da. Mit Streckennummer und Kilometer oben geht es auch so, ` +
        `sofern die Strecke schon einmal geladen war.`
      : lage === 'draussen'
      ? `Diese Stelle liegt außerhalb des mitgelieferten Gleisnetzes, und der Rückfall auf den ` +
        `fremden Dienst Overpass hat nicht geantwortet (${err.message}). Mit Streckennummer und ` +
        `Kilometer oben geht es ohne ihn.`
      : `Hier ließ sich nicht ermitteln, welche Strecke liegt: ${err.message}. Näher an ein Gleis ` +
        `tippen — oder mit Streckennummer und Kilometer oben suchen.`);
  } finally {
    setBusy(false);
  }
}

/* Kein Stein in Reichweite? Dann die Strecke selbst befragen.
 *
 * Die ORM-API braucht zwar eine Position, liefert dafür aber gleich alles, was
 * im Umkreis dieser Position erfasst ist — auf dünn belegten Strecken ist das
 * mit einer Abfrage der halbe Streckenverlauf. Ein paar Startwerte abklappern
 * genügt also, um überhaupt einen Anhaltspunkt zu bekommen. */
async function seedAusApi(ref, lat, lon) {
  const e = storeFor(ref);
  const naechster = () => e.sorted.length
    ? e.sorted.reduce((a, b) => haversine(lat, lon, b.lat, b.lon) < haversine(lat, lon, a.lat, a.lon) ? b : a)
    : null;

  for (const km of [0, 50, 100, 150]) {
    const nah = naechster();
    if (nah && haversine(lat, lon, nah.lat, nah.lon) < 6000) return nah.km;
    if (e.probes.some(p => Math.abs(p - km) < 0.75)) continue;
    try { await probe(ref, e, km); } catch { break; }
  }
  const nah = naechster();
  return nah ? nah.km : null;
}

/** Strecke laden und den Klickpunkt darauf projizieren. */
async function useLineAt(ref, seeds, lat, lon) {
  setBusy(true);
  showStatus(`Lade Strecke ${ref} …`);
  try {
    view.ref = ref;
    $('#ref').value = ref;

    const liste = Array.isArray(seeds) ? seeds.slice() : (seeds == null ? [] : [{ km: seeds }]);
    if (!liste.length) {
      showStatus(`Strecke ${ref}: keine Kilometerangabe in der Nähe — frage die Strecke ab …`);
      const km = await seedAusApi(ref, lat, lon);
      if (km == null) {
        showError(`Für Strecke ${ref} ist in OpenStreetMap kein einziger Kilometerpunkt erfasst — der Kilometer lässt sich nicht bestimmen.`);
        return;
      }
      liste.push({ km });
    }

    /* Der Reihe nach laden, bis der Punkt zwischen zwei Steinen liegt. Ein
     * einzelner Startwert deckt womöglich nur eine Seite ab — siehe startwerte(). */
    let e = null;
    for (const s of liste) {
      await coverage(ref, s.km);
      e = lineCache.get(ref);
      const p = projectOnLine(e.sorted, lat, lon, MAX_GLEIS_GAP_KM);
      if (p && p.dist <= 400) break;
    }
    drawMilestones();

    const hit = projectOnLine(e.sorted, lat, lon);
    if (hit && hit.dist <= 400) {
      const punkt = await kartePunkt(ref, hit, lat, lon, e.sorted[0].operator);
      applyPoint(ref, punkt.km, punkt);
      return;
    }

    /* Jenseits des äußersten Steins gibt es kein Paar, das den Punkt einschließt.
     * Dann am Gleis hinauslaufen statt den Punkt auf das letzte Steinpaar zu
     * loten und ihn als „zu weit weg" abzulehnen. */
    const raus = await kmExtrapoliert(ref, lat, lon, e.sorted);
    if (raus) {
      applyPoint(ref, raus.km, raus);
      return;
    }

    /* Sehne unbrauchbar — entweder stehen die nächsten Steine weiter als
     * MAX_DRAW_GAP_KM auseinander und werden gar nicht erst verbunden, oder die
     * Sehne schneidet einen Bogen so weit ab, dass der Punkt scheinbar
     * hunderte Meter danebenliegt. Beides löst der echte Verlauf. */
    const weit = projectOnLine(e.sorted, lat, lon, MAX_GLEIS_GAP_KM);
    if (weit) {
      /* Nur von Overpass reden, wenn es auch Overpass wird. Aus der Kachel ist
       * der Verlauf in rund einer Zehntelsekunde da; die Warnung vor
       * Wartezeiten stand hier noch aus der Zeit davor. */
      const daheim = await netzHatVerlauf(weit.a, weit.b);
      showStatus(`Die nächsten Kilometerangaben stehen bei km ${fmtKm(weit.between[0])} und ` +
        `${fmtKm(weit.between[1])} — ` + (daheim
          ? `rechne am mitgelieferten Gleisverlauf entlang …`
          : `hole den Gleisverlauf von Overpass. Das dauert einige Sekunden, ` +
            `bei überlastetem Overpass auch länger …`));
      try {
        const genau = await kmEntlangGleis(ref, lat, lon);
        if (genau && genau.offset <= 400) {
          const { pfad, ...punkt } = genau;      // der Verlauf gehört auf die Karte, nicht in den Zustand
          applyPoint(ref, punkt.km, punkt);
          zeichneGleisweg(pfad);
          return;
        }
        if (genau) {
          showError(`Der Punkt liegt ${nfM.format(genau.offset)} m vom Gleis der Strecke ${ref} entfernt — das wäre zu ungenau.`);
          return;
        }
      } catch (err) {
        /* Der Grund gehört dazu, sonst steht da nur „geht nicht": ohne Steinpaar
         * ist der Verlauf der einzige Weg, mit Steinpaar nur der genauere. */
        showError(hit
          ? `Der Punkt liegt ${nfM.format(hit.dist)} m von der Verbindungslinie der Steine bei km ` +
            `${fmtKm(hit.between[0])} und ${fmtKm(hit.between[1])} entfernt, und der Gleisverlauf ließ sich ` +
            `nicht holen: ${err.message}.`
          : `Zwischen km ${fmtKm(weit.between[0])} und ${fmtKm(weit.between[1])} ist kein Kilometerpunkt ` +
            `erfasst, und der Gleisverlauf ließ sich nicht holen: ${err.message}. Ohne ihn lässt sich der ` +
            `Kilometer hier nicht bestimmen.`);
        return;
      }
    }

    if (!hit) {
      showError(`Für Strecke ${ref} sind hier zu wenige Kilometerangaben erfasst.`);
      return;
    }
    showError(`Der Punkt liegt ${nfM.format(hit.dist)} m von den erfassten Steinen der Strecke ${ref} entfernt — das wäre zu ungenau.`);
  } catch (err) {
    showError('Konnte Strecke ' + ref + ' nicht laden: ' + err.message);
  } finally {
    setBusy(false);
  }
}

function showPicker(refs, seeds, lat, lon) {
  const b = $('#bottom');
  b.hidden = false;
  b.innerHTML = `<p class="bb-title">Mehrere Strecken an dieser Stelle</p>
    <p class="bb-sub">Sortiert nach Abstand zum Tippen — die erste liegt am nächsten.</p>
    <div class="pick">${refs.map(r =>
      `<button type="button" data-pick="${esc(r.ref)}">${esc(r.ref)}<small>${nfM.format(r.dist)} m</small></button>`).join('')}</div>`;
  b.querySelectorAll('[data-pick]').forEach(btn =>
    btn.addEventListener('click', () => {
      const r = refs.find(x => x.ref === btn.dataset.pick);
      useLineAt(btn.dataset.pick, (r && r.seeds) || seeds, lat, lon);
    }));
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
  /* Orange trotz der besseren Rechnung: Über so weite Steinabstände bleiben
   * gemessen bis zu 88 m Unsicherheit, und die kommt aus den Steinen selbst. */
  if (p.quality === 'karte-gleis') return { cls: 'warn', text: `entlang des Gleises ±${nfM.format(GLEIS_ERR.worst)} m` };
  if (p.quality === 'extrapoliert') return { cls: 'warn', text: `hinausgerechnet ±${nfM.format(EXTRA_ERR.worst)} m` };
  if (p.quality === 'interpoliert') {
    // Schwelle bei 50 m: die beiden dichten Steinabstände bleiben grün,
    // orange wird es erst, wenn die Steine wirklich weit auseinanderstehen.
    return { cls: p.err.worst > 50 ? 'warn' : 'ok', text: `interpoliert ±${nfM.format(p.err.worst)} m` };
  }
  // Beim Tippen kommt die Unsicherheit des eigenen Fingers hinzu — bleibt orange
  if (p.quality === 'karte') return { cls: 'warn', text: `von der Karte ±${nfM.format(tapError(p.chord || 0).worst)} m` };
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

  /* Feinrechnung nur anbieten, wo sie etwas bringt: in der Richtung km → Position.
   * Beim Kartentipp bringt sie nichts — siehe TAP_ERR. */
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
  } else if (p.quality === 'karte-gleis') {
    detail = `Zwischen den Kilometerangaben bei km ${fmtKm(p.between[0])} und ${fmtKm(p.between[1])} ist ` +
      `nichts weiter erfasst — ${nfM.format(p.chord)} m Luftlinie. Über so weite Lücken taugt die gerade ` +
      `Verbindung nicht mehr, deshalb wurde der tatsächliche Gleisverlauf geholt und daran entlang gemessen: ` +
      `${nfM.format(p.wegLaenge)} m Gleisweg, laut Kilometrierung ${nfM.format(p.nominal)} m. ` +
      `Geradlinig käme km ${fmtKm(p.sehneKm)} heraus, ${nfM.format(Math.abs(view.km - p.sehneKm) * 1000)} m ` +
      `daneben. An ${GLEIS_ERR.faelle} übersprungenen Zwischensteinen mit ähnlichem Abstand nachgemessen lag ` +
      `dieser Weg typisch ${nfM.format(GLEIS_ERR.typical)} m neben dem wahren Kilometer und höchstens ` +
      `${nfM.format(GLEIS_ERR.worst)} m; die geradlinige Ablesung traf im Mittel ebenso gut, lag aber in ` +
      `${GLEIS_ERR.ueber100} der ${GLEIS_ERR.faelle} Fälle über 100 m daneben, bis zu ${nfM.format(GLEIS_ERR.sehne)} m. ` +
      `Übrig bleibt die Erfassungsgenauigkeit der Steine, gegen die kein Gleisverlauf hilft.`;
    if (p.offset > 150) {
      warn = `<p class="bb-note">Der Punkt liegt ${nfM.format(p.offset)} m querab des Gleises. ` +
        `Abgelesen wird die Stelle, an der das Lot auf das Gleis trifft.</p>`;
    }
  } else if (p.quality === 'extrapoliert') {
    detail = `Bei km ${fmtKm(view.km)} ist kein Stein erfasst, und es gibt auch keinen davor — ` +
      `die Kilometrierung fängt hier erst an oder hört auf. Statt den nächstgelegenen Stein zu ` +
      `zeigen, wurde vom Stein bei km ${fmtKm(p.abStein)} aus ${nfM.format(p.hinaus)} m am Gleis ` +
      `entlang hinausgelaufen, an jeder Weiche geradeaus. Dass die Trasse dabei über den Nullpunkt ` +
      `hinausgeht, ist normal — die Kilometrierungslinie beginnt oft später als die Achse. ` +
      `Zur Probe wurde mit demselben Verfahren die bekannte Strecke zum Nachbarstein gelaufen und ` +
      `dieser auf ${nfM.format(p.probe)} m getroffen. An ${EXTRA_ERR.faelle} übersprungenen ` +
      `Außensteinen nachgemessen lag das Ergebnis typisch ${nfM.format(EXTRA_ERR.typical)} m neben ` +
      `dem wahren Ort, im ungünstigen Zehntel ${nfM.format(EXTRA_ERR.worst)} m — der nächstgelegene ` +
      `Stein lag dagegen ${nfM.format(EXTRA_ERR.stein)} m daneben.`;
    if (p.hinaus > 1500) {
      warn = `<p class="bb-note">${nfM.format(p.hinaus)} m über den letzten Stein hinausgerechnet. ` +
        `Je weiter hinaus, desto unsicherer.</p>`;
    }
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
    const err = tapError(p.chord || 0);
    detail = `Aus dem Kartentipp abgeleitet, zwischen den Steinen bei km ${fmtKm(p.between[0])} und ` +
      `${fmtKm(p.between[1])}, ${nfM.format(p.chord || 0)} m auseinander` +
      (p.offset > 15 ? `, ${nfM.format(p.offset)} m querab des Gleises` : '') + `. ` +
      (p.aufGleis > 5
        ? `Angezeigt wird die Stelle auf dem tatsächlich erfassten Gleis — die gerade Verbindung ` +
          `zwischen den beiden Steinen läuft hier ${nfM.format(p.aufGleis)} m daneben. Der Kilometer ` +
          `stammt weiter von dieser Verbindung: an 234 übersprungenen Zwischensteinen nachgemessen ` +
          `liest sie sich genauer als eine Rechnung entlang des Gleises (15 gegenüber 25 m im Median), ` +
          `weil beim Tippen die Position ja feststeht. `
        : '') +
      `An echten Zwischensteinen nachgemessen lag der so gelesene Kilometer typisch ` +
      `${nfM.format(err.typical)} m neben dem wahren, im ungünstigen Zehntel ${nfM.format(err.worst)} m. ` +
      `Das steckt fast ganz in der Erfassung der Steine, nicht in der Sehnennäherung.`;
    /* Die Ausnahme, in der die Spanne oben nicht mehr gilt: Passen Luftlinie und
     * Kilometerdifferenz der beiden Steine nicht zusammen, steckt dahinter ein
     * Kilometersprung oder ein falsch erfasster Stein. Über dieselben 2050
     * Testfälle lag das ungünstige Zehntel solcher Paare bei 183 m statt 49 m —
     * und diese Fälle liegen auf gerader Strecke, ein Gleisverlauf hilft nicht. */
    if (p.spanRatio != null && p.spanRatio < 0.75) {
      warn = `<p class="bb-note">Luftlinie und Kilometerdifferenz der beiden Steine passen nicht zusammen ` +
        `(${Math.round(p.spanRatio * 100)} %) — starker Bogen oder Kilometersprung. Im zweiten Fall liegt der ` +
        `Kilometer weit außerhalb der oben genannten Spanne; nachgemessen lag das ungünstige Zehntel solcher ` +
        `Stellen bei 183 m statt 49 m.</p>`;
    }
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
    <button type="button" id="bbClose" class="bb-close" aria-label="Anzeige schließen">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
    </button>
    <div class="bb-actions">
      <a class="maps" href="${gmapsUrl(p.lat, p.lon)}" target="_blank" rel="noopener">In Google Maps öffnen</a>
      <a href="${gmapsRoute(p.lat, p.lon)}" target="_blank" rel="noopener">Route</a>
      <button type="button" id="copyBtn">Kopieren</button>
      <button type="button" id="shareBtn">Teilen</button>
    </div>`;

  bindBottom();
  updateBH();
}

/** Ereignisse der unteren Leiste — separat, weil die Leiste neu gezeichnet wird. */
function bindBottom() {
  const zu = $('#bbClose');
  if (zu) zu.addEventListener('click', closeBottom);

  const copy = $('#copyBtn');
  if (copy) copy.addEventListener('click', async () => {
    const p = view.point;
    if (!p) return;
    toast(await copyText(fmtCoord(p.lat, p.lon)) ? 'Koordinaten kopiert' : 'Kopieren nicht möglich');
  });

  const teilen = $('#shareBtn');
  if (teilen) teilen.addEventListener('click', share);

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
  b.innerHTML = `<button type="button" id="bbClose" class="bb-close" aria-label="Anzeige schließen">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
    </button>
    <p class="bb-err">${esc(msg)}</p>`;
  bindBottom();
  updateBH();
}

/** Anzeige wegdrücken — vor allem für den versehentlichen Tipp auf die Karte. */
function closeBottom() {
  view.point = null;
  pointMarker = null;
  if (pointLayer) pointLayer.clearLayers();
  if (trackLayer) trackLayer.clearLayers();
  $('#bottom').hidden = true;
  $('#bottom').innerHTML = '';
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
    const res = await gleisGenau(ref, km, await resolvePoint(ref, km));
    applyPoint(ref, km, res);
    if (res.pfad) { const { pfad, ...rest } = res; view.point = rest; zeichneGleisweg(pfad); }
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

/* Der Standort wird dauerhaft verfolgt, nicht einmal abgefragt: Im Gelände geht
 * es darum, zu einem Punkt hinzulaufen, und dafür muss die Anzeige mitlaufen,
 * ohne dass man ständig den Knopf drückt. watchPosition liefert dabei jede neue
 * Messung des Geräts.
 *
 * Die Karte springt nur beim ersten Fix zum Standort. Danach wird nur
 * nachgeschoben, wenn der Punkt aus dem Bild läuft — sonst kämpft das Nachfahren
 * gegen jedes Verschieben von Hand. */

let ortWatch = null;
let ortLetzt = null;              // { lat, lon, genau }

const ortAn = () => ortWatch != null;

function locate() {
  if (ortAn()) {
    /* Die Karte fährt nur, wenn man es verlangt. Steht der Punkt schon in der
     * Mitte, war der Tipp als Abschalten gemeint — sonst holt er die Karte
     * zurück, ohne die Verfolgung zu beenden. */
    if (ortLetzt) {
      const wo = map.latLngToContainerPoint([ortLetzt.lat, ortLetzt.lon]);
      if (wo.distanceTo(map.getSize().divideBy(2)) > 40) {
        map.setView([ortLetzt.lat, ortLetzt.lon], Math.max(map.getZoom(), 17));
        toast('Karte auf den Standort gesetzt.');
        return;
      }
    }
    ortStop('Standort wird nicht mehr verfolgt.');
    return;
  }
  if (!navigator.geolocation) { toast('Standortbestimmung wird nicht unterstützt.'); return; }
  if (!window.isSecureContext) { toast('Standort geht nur über HTTPS.'); return; }

  closeSheet();
  const btn = $('#mapLocBtn');
  if (btn) btn.classList.add('busy');
  toast('Standort wird verfolgt — der Punkt bleibt von allein aktuell.');

  ortWatch = navigator.geolocation.watchPosition(ortNeu, ortFehler, {
    enableHighAccuracy: true, maximumAge: 2000, timeout: 25000
  });
  syncButtons();
}

function ortStop(nachricht) {
  if (ortWatch != null) navigator.geolocation.clearWatch(ortWatch);
  ortWatch = null;
  ortLetzt = null;
  if (meLayer) meLayer.clearLayers();
  const btn = $('#mapLocBtn');
  if (btn) btn.classList.remove('busy', 'is-on');
  if (nachricht) toast(nachricht);
  liveLeiste();
  syncButtons();
}

function ortFehler(err) {
  const btn = $('#mapLocBtn');
  if (btn) btn.classList.remove('busy');
  // Einzelne Aussetzer sind unterwegs normal — erst aufgeben, wenn es nie geklappt hat
  if (!ortLetzt) ortStop('Standort nicht verfügbar: ' + (err.message || 'unbekannt'));
}

function ortNeu(pos) {
  const { latitude: lat, longitude: lon, accuracy } = pos.coords;
  const erste = !ortLetzt;
  ortLetzt = { lat, lon, genau: accuracy || 0 };

  const btn = $('#mapLocBtn');
  if (btn) { btn.classList.remove('busy'); btn.classList.add('is-on'); }

  meLayer.clearLayers();
  L.marker([lat, lon], {
    icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [16, 16], iconAnchor: [8, 8] })
  }).addTo(meLayer);
  L.circle([lat, lon], {
    radius: Math.max(accuracy || 0, 5), color: '#2f81f7', weight: 1, fillOpacity: 0.12, interactive: false
  }).addTo(meLayer);

  /* Nur der erste Fix bewegt die Karte, und auch der nicht beim Messen. Jede
   * weitere Meldung setzt bloß den Punkt um. Vorher zog die Karte nach, sobald
   * der Standort aus dem Bild lief — beim Messen sprang damit die Bildmitte
   * gegen die eigene Zielbewegung, und auch sonst rutschte die Karte immer
   * wieder weg. Zurückholen tut der Standortknopf. */
  if (erste) {
    if (!messModus) map.setView([lat, lon], Math.max(map.getZoom(), 17));
    toast(`Standort auf ±${nfM.format(accuracy || 0)} m genau.`);
  }

  liveLeiste();
}

/** Rechtweisende Peilung von hier zu einem Ziel, in Grad. */
function ortPeilung(von, ziel) {
  const rad = Math.PI / 180;
  const dLon = (ziel[1] - von.lon) * rad;
  const y = Math.sin(dLon) * Math.cos(ziel[0] * rad);
  const x = Math.cos(von.lat * rad) * Math.sin(ziel[0] * rad) -
            Math.sin(von.lat * rad) * Math.cos(ziel[0] * rad) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/** Nächstes Objekt aus sichtbaren KML-Dateien — das Ziel beim Suchen im Gelände. */
function ortNaechstesObjekt() {
  if (!ortLetzt) return null;
  let best = null;
  for (const a of kmlAkten) {
    if (!a.sichtbar) continue;
    for (const o of a.objekte) {
      if (!kmlSichtbarObj(a, o)) continue;
      const k = kmlAnker(o);
      if (!k) continue;
      const d = haversine(ortLetzt.lat, ortLetzt.lon, k[0], k[1]);
      if (!best || d < best.d) best = { d, koord: k, name: o.name || '(ohne Namen)', datei: a.name };
    }
  }
  return best;
}

/* Schmale Zeile unter der Suchleiste, nur solange verfolgt wird: Genauigkeit,
 * Abstand zum letzten Messpunkt und das nächste KML-Objekt mit Richtungspfeil.
 * Der Pfeil rechnet die Kartendrehung heraus, zeigt also auf dem Schirm dorthin,
 * wo das Ziel wirklich liegt. */
function liveLeiste() {
  const el = $('#live');
  if (!el) return;
  if (!ortLetzt) { el.hidden = true; el.innerHTML = ''; updateBH(); return; }

  const stuecke = [`<span class="tag">±${nfM.format(ortLetzt.genau)} m</span>`];

  if (messModus && messPunkte.length) {
    const p = messPunkte[messPunkte.length - 1];
    stuecke.push(`<span class="live-teil"><b>${esc(messText(haversine(ortLetzt.lat, ortLetzt.lon, p[0], p[1])))}</b>` +
      `<small>vom letzten Messpunkt</small></span>`);
  }

  const nah = ortNaechstesObjekt();
  if (nah) {
    const dreh = ortPeilung(ortLetzt, nah.koord) - (map.getBearing ? map.getBearing() : 0);
    stuecke.push(`<span class="live-teil live-ziel">` +
      `<svg viewBox="0 0 24 24" aria-hidden="true" style="transform:rotate(${dreh.toFixed(1)}deg)">` +
      `<path d="M12 3l6 16-6-4-6 4z"/></svg>` +
      `<b>${esc(messText(nah.d))}</b><small>${esc(nah.name)}</small></span>`);
  }

  el.innerHTML = stuecke.join('');
  el.hidden = false;
  updateBH();
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
  if (map) {
    for (const [kennung, layer] of Object.entries(overlayLayers)) {
      const btn = $(kennung === 'orm' ? '#ormBtn' : '#parzBtn');
      if (btn) btn.classList.toggle('is-on', map.hasLayer(layer));
    }
  }

  const kreuz = $('#mitteKreuz');
  if (kreuz) kreuz.hidden = !messModus;

  const mb = $('#mapMessBtn');
  if (mb) {
    mb.classList.toggle('is-on', messModus);
    mb.setAttribute('aria-pressed', messModus ? 'true' : 'false');
  }

  const kn = $('#kmlNamenBtn');
  if (kn) kn.classList.toggle('is-on', prefs.kmlNamen !== false);

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
  on('#go', 'click', search);
  on('#menuBtn', 'click', () => $('#sheet').hidden ? openSheet() : closeSheet());

  on('#ref', 'keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); closeSuggest(); $('#km').focus(); }
    if (ev.key === 'Escape') closeSuggest();
  });
  on('#ref', 'focus', openSuggest);
  on('#ref', 'input', openSuggest);
  on('#ref', 'blur', () => setTimeout(closeSuggest, 120));

  on('#km', 'keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); search(); ev.target.blur(); }
  });
  on('#km', 'focus', closeSuggest);

  on('#facQ', 'keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); runFacility(); } });
  on('#facGo', 'click', runFacility);

  document.querySelectorAll('[data-base]').forEach(b => b.addEventListener('click', () => setBase(b.dataset.base)));
  on('#ormBtn', 'click', () => toggleOverlay('orm'));
  on('#parzBtn', 'click', () => toggleOverlay('parz'));
  document.querySelectorAll('[data-theme]').forEach(b => b.addEventListener('click', () => {
    prefs.theme = b.dataset.theme;
    applyTheme();
    saveStore();
  }));

  setVal('#baseOpacity', prefs.baseOpacity == null ? 100 : prefs.baseOpacity);
  on('#baseOpacity', 'input', ev => {
    prefs.baseOpacity = Number(ev.target.value);
    applyBaseOpacity();
  });
  on('#baseOpacity', 'change', saveStore);

  on('#northBtn', 'click', () => {
    if (map.setBearing) map.setBearing(0);
    syncNorth();
  });

  on('#mapLocBtn', 'click', locate);

  on('#mapMessBtn', 'click', () => { if (messModus) messEnde(); else messStart(); });

  on('#kmlNamenBtn', 'click', () => {
    prefs.kmlNamen = prefs.kmlNamen === false;
    saveStore();
    syncButtons();
    kmlLabels();
    if (prefs.kmlNamen !== false && map.getZoom() < KML_LABEL_ZOOM) {
      toast('Namen erscheinen ab Zoomstufe ' + KML_LABEL_ZOOM + ' — noch etwas näher heran.');
    }
  });

  // KML: Auswahl über den Knopf, am Rechner geht auch Hineinziehen
  on('#kmlAdd', 'click', () => { const f = $('#kmlFile'); if (f) f.click(); });
  on('#kmlFile', 'change', ev => {
    const dateien = [...ev.target.files];
    ev.target.value = '';        // dieselbe Datei soll erneut gewählt werden können
    if (dateien.length) kmlOeffnen(dateien);
  });
  // Nur bei Dateien eingreifen — markierter Text soll weiter in die Felder fallen können
  const zieht = ev => ev.dataTransfer && [...ev.dataTransfer.types].includes('Files');
  window.addEventListener('dragover', ev => { if (zieht(ev)) ev.preventDefault(); });
  window.addEventListener('drop', ev => {
    if (!zieht(ev)) return;
    ev.preventDefault();      // sonst öffnet der Browser die Datei und die App ist weg
    const dateien = [...ev.dataTransfer.files].filter(f => /\.(kml|kmz)$/i.test(f.name));
    if (dateien.length) kmlOeffnen(dateien);
    else toast('Nur KML- und KMZ-Dateien.');
  });

  // WMS: Adresse und Layer merken, Zugangsdaten bleiben beim Browser
  setVal('#wmsUrl', prefs.wms.url || '');
  setVal('#wmsLayers', prefs.wms.layers || '');
  setVal('#wmsOpacity', prefs.wms.opacity || 75);

  const wmsSave = () => {
    const u = $('#wmsUrl'), l = $('#wmsLayers');
    if (u) prefs.wms.url = u.value.trim();
    if (l) prefs.wms.layers = l.value.trim();
    saveStore();
    if (prefs.wms.on) wmsApply(true);      // mit neuen Angaben neu aufbauen
  };
  on('#wmsUrl', 'change', wmsSave);
  on('#wmsLayers', 'change', wmsSave);

  on('#wmsOpacity', 'input', ev => {
    prefs.wms.opacity = Number(ev.target.value);
    if (wmsLayer) wmsLayer.setOpacity(prefs.wms.opacity / 100);
  });
  on('#wmsOpacity', 'change', saveStore);

  on('#wmsLogin', 'click', () => { wmsSave(); wmsLogin(); });
  on('#wmsToggle', 'click', () => { wmsSave(); wmsApply(!prefs.wms.on); });
  on('#wmsLoad', 'click', () => { wmsSave(); wmsLoadLayers(); });
  on('#wmsParse', 'click', () => {
    const el = $('#wmsXml');
    const xml = el ? el.value.trim() : '';
    if (!xml) { toast('Bitte das XML einfügen.'); return; }
    try { wmsShowLayers(parseWmsCapabilities(xml)); }
    catch (err) { toast('XML nicht lesbar: ' + err.message); }
  });

  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { closeSheet(); closeSuggest(); }
  });

  bindSheetSections();
  window.addEventListener('resize', updateBH);
}

/* Welche Abschnitte des Menüs offen stehen, bleibt gemerkt — sonst schiebt man
 * sich jedes Mal wieder durch alles nach unten. */
function bindSheetSections() {
  const bloecke = [...document.querySelectorAll('#sheet [data-sec]')];
  const offen = Array.isArray(prefs.offen) ? prefs.offen : ['karte', 'kml'];
  for (const b of bloecke) b.open = offen.includes(b.dataset.sec);
  for (const b of bloecke) {
    b.addEventListener('toggle', () => {
      prefs.offen = bloecke.filter(x => x.open).map(x => x.dataset.sec);
      saveStore();
    });
  }
}

function boot() {
  loadStore();
  applyTheme();
  initMap();
  bind();
  kmlBoot();      // nebenher: die Karte soll nicht auf den Speicher warten

  if (readHash()) search();
  else if (recent[0]) $('#ref').value = recent[0].ref;

  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* Offlinebetrieb ist optional */ });
  }
}

document.addEventListener('DOMContentLoaded', boot);
