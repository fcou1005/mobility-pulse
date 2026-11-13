// @ts-check
// Mobility Pulse — Kern – Fremdtext, Abruf, Lizenzen, Geo, Kennungen, GBFS lesen (aus pulse-core.js geschnitten; pulse-core.js bleibt die Fassade für alle Importe).

// @ts-check
// Mobility Pulse — gemeinsame Kernbibliothek für Sammler (Node) und Dashboard (Browser).
// Keine Abhängigkeiten. ESM.

export const GHOST_MS = 7 * 86400e3; // gesperrt und so lange ohne Signal = verwaister Eintrag, kein Bestand
export const LIVE_MS = 5 * 60e3;      // ≤ 5 Min: aktuell (GBFS-Latenzvorgabe)
export const DELAYED_MS = 30 * 60e3;  // ≤ 30 Min: verzögert, darüber veraltet
export const DE_BBOX = { minLon: 5.8, minLat: 47.2, maxLon: 15.1, maxLat: 55.2 };

// ---------- Fremdtext entschärfen (S0.3) ----------
// Texte aus Feeds, Overpass, Nachrichten und dem Datenstand bilden kein HTML: „<“ vor einem Buchstaben, „/“, „!“ oder „?“ (nur so beginnt
// ein Tag) wird zum Vollbreiten-Zeichen „＜“, Steuerzeichen außer Tab und Zeilenumbruch fallen weg. „3 km < 25 km“ bleibt unverändert.
const UNSAFE_TEXT = /<(?=[A-Za-z/!?])|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const UNSAFE_TEXT_G = /<(?=[A-Za-z/!?])|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
export const safeText = (s) => (typeof s === 'string' && UNSAFE_TEXT.test(s) ? s.replace(UNSAFE_TEXT_G, (c) => (c === '<' ? '＜' : '')) : s);
// Schneller Vortest auf dem JSON-Text (auch <-Escapes); nur bei Treffer wird Feld für Feld (Werte und Schlüssel) entschärft
const UNSAFE_JSON = /<[A-Za-z/!?]|\\u003[cC]|\\u00[01][0-9a-fA-F]|\\u007[fF]/;
const safeKeys = (o) => {
  for (const k in o) if (UNSAFE_TEXT.test(k)) { const n = {}; for (const [k2, v] of Object.entries(o)) n[safeText(k2)] = v; return n; }
  return o;
};
export function parseJsonSafe(text) {
  if (!UNSAFE_JSON.test(text)) return JSON.parse(text);
  return JSON.parse(text, (k, v) => (typeof v === 'string' ? safeText(v) : v && typeof v === 'object' && !Array.isArray(v) ? safeKeys(v) : v));
}

export const num = (v) => (v == null || v === '' || typeof v === 'boolean' ? null : Number.isFinite(+v) ? +v : null);
export const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? true : v === false || v === 0 || v === '0' || v === 'false' ? false : null);

// GBFS-Zeitstempel: Sekunden (2.x), Millisekunden, RFC3339 (3.0)
export function toMs(t) {
  if (t == null || t === '') return null;
  if (typeof t === 'number' || /^\d+(\.\d+)?$/.test(String(t))) {
    const n = +t;
    if (n > 1e14) return null;        // Unsinn
    if (n > 1e11) return Math.round(n); // ms
    if (n > 1e8) return Math.round(n * 1000); // s
    return null;
  }
  let str = String(t).trim();
  let ms = Date.parse(str);
  if (!Number.isFinite(ms) && /[+-]\d\d:?\d\dZ$/.test(str)) ms = Date.parse(str.slice(0, -1)); // CityBikes: „+00:00Z“
  if (!Number.isFinite(ms) && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(str)) ms = Date.parse(str.replace(' ', 'T'));
  return Number.isFinite(ms) ? ms : null;
}

export function freshness(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs < -2 * 60e3) return 'unknown';
  if (ageMs <= LIVE_MS) return 'live';
  if (ageMs <= DELAYED_MS) return 'delayed';
  return 'stale';
}
export const FRESHNESS_LABEL = { live: 'Aktuell', delayed: 'Verzögert', stale: 'Veraltet', unknown: 'Zeit unklar', error: 'Fehler', gap: 'Datenlücke', auth: 'Zugang nötig', gone: 'Nicht erreichbar', empty: 'Leer', foreign: 'Außerhalb DE', duplicate: 'Dublette', retired: 'Länger weg' };
export const RETIRED_MS = 14 * 86400e3; // so lange „weg“ (404/410) → Status retired, zählt nicht mehr als Fehler

// ---------- Abruf mit Obergrenze ----------
// Antwort streamend lesen; über max Bytes → Abbruch mit 'Antwort zu groß'. Der Timeout des Aufrufers (AbortSignal) muss bis hierher laufen.
export async function readLimited(r, max = 40e6) {
  const len = +r.headers?.get?.('content-length');
  if (len > max) { await r.body?.cancel?.().catch(() => {}); throw new Error('Antwort zu groß'); }
  const reader = r.body?.getReader?.();
  if (!reader) { const t = await r.text(); if (t.length > max) throw new Error('Antwort zu groß'); return t; }
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { await reader.cancel().catch(() => {}); throw new Error('Antwort zu groß'); }
    chunks.push(value);
  }
  const all = new Uint8Array(size); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
  return new TextDecoder('utf-8').decode(all);
}
// Text abrufen: Timeout gilt für Verbindung UND Lesen (Timer erst nach dem Lesen gelöscht), Größe begrenzt
export async function fetchLimited(url, { timeout = 20000, max = 40e6, headers = {}, fetchImpl = fetch } = {}) {
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetchImpl(url, { signal: ctrl.signal, headers });
    if (!r.ok) { await r.body?.cancel?.().catch(() => {}); throw new Error(`HTTP ${r.status}`); }
    return await readLimited(r, max);
  } catch (e) { throw e.name === 'AbortError' ? new Error('Timeout') : e; }
  finally { clearTimeout(timer); }
}

// Fehlerursache einer Quelle (für Zähler nach Ursache): timeout, http<Status>, noJson, tooLarge, tls, dns, connection, redirect, noFeeds, other
export function errorCause(errors = [], httpStatus = null) {
  const t = (errors || []).join(' ');
  if (/Timeout|ETIMEDOUT|UND_ERR_(CONNECT|HEADERS|BODY)_TIMEOUT/i.test(t)) return 'timeout';
  if (/zu groß/.test(t)) return 'tooLarge';
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(t)) return 'tls';
  if (/ENOTFOUND|EAI_AGAIN/.test(t)) return 'dns';
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR_SOCKET|other side closed|fetch failed/i.test(t)) return 'connection';
  if (/Weiterleitung/.test(t)) return 'redirect';
  const m = t.match(/HTTP (\d{3})/); const st = m ? +m[1] : httpStatus;
  if (st >= 300) return `http${st}`;
  if (/kein JSON/.test(t)) return 'noJson';
  if (/keine Feeds/.test(t)) return 'noFeeds';
  return 'other';
}

// ---------- Lizenzen ----------
// Lizenzangaben der Feeds/Verzeichnisse vereinheitlichen (SPDX-nah); URL bekannter Lizenzen ergänzen
const LICENSE_URL = { 'CC0-1.0': 'https://creativecommons.org/publicdomain/zero/1.0/', 'ODbL-1.0': 'https://opendatacommons.org/licenses/odbl/1-0/', 'dl-de/by-2-0': 'https://www.govdata.de/dl-de/by-2-0', 'dl-de/zero-2-0': 'https://www.govdata.de/dl-de/zero-2-0' };
export function normalizeLicense(id, url = null) {
  const raw = String(id || '').trim(); const k = raw.toLowerCase().replace(/[\s_]+/g, '-');
  let n = null, m;
  if (/^cc0|publicdomain\/zero/.test(k)) n = 'CC0-1.0';
  else if ((m = k.match(/^cc-?by-sa-?(\d)|licenses\/by-sa\/(\d)/))) n = `CC-BY-SA-${m[1] || m[2]}.0`;
  else if ((m = k.match(/^cc-?by-?(\d)|licenses\/by\/(\d)/))) n = `CC-BY-${m[1] || m[2]}.0`;
  else if (/odbl/.test(k)) n = 'ODbL-1.0';
  else if (/dl-de-?\/?zero/.test(k)) n = 'dl-de/zero-2-0';
  else if (/dl-de-?\/?by/.test(k)) n = 'dl-de/by-2-0';
  const known = n && (LICENSE_URL[n] || (/^CC-BY/.test(n) ? `https://creativecommons.org/licenses/${n.includes('-SA-') ? 'by-sa' : 'by'}/${n.slice(-3)}/` : null));
  const isUrl = /^https?:\/\//i.test(raw);
  return { id: n || (raw && !isUrl ? raw : null), url: url || (isUrl ? raw : null) || known || null };
}

// Reihenfolge = Index in ops/<Land>.json (Feld type) und Snapshots: neue Arten nur hinten anfügen. moped (E-Roller, Sitzroller) und car
// (Carsharing, frei und stationsgebunden) seit 08.11.2026; vorher liefen beide unter other und Carsharing-Feeds waren ausgeschlossen.
export const VEHICLE_TYPES = ['scooter', 'ebike', 'bike', 'cargo', 'other', 'unknown', 'moped', 'car'];
export const VEHICLE_TYPE_LABEL = { scooter: 'E-Scooter', ebike: 'E-Bikes', bike: 'Normale Fahrräder', cargo: 'Lastenräder', other: 'Sonstige', unknown: 'Fahrzeugart ungeklärt', moped: 'E-Roller', car: 'Carsharing' };
// Fahrzeugfamilien: je Familie ein eigenes Prognosemodell (forecast/, forecast/moped/, forecast/car/) und eigene Verfolgungsregeln (pulse-track TYPE_RULES)
export const FAMILIES = ['micro', 'moped', 'car'];
export const familyOf = (ty) => (ty === 'car' ? 'car' : ty === 'moped' ? 'moped' : 'micro');
// „Reichweite niedrig“ je Art (km); übrige Arten: rangeThreshold des Sammlers (5 km)
export const TYPE_RANGE_LOW_KM = { moped: 10, car: 50 };
export const rangeLowKm = (ty, dflt = 5) => TYPE_RANGE_LOW_KM[ty] ?? dflt;

export function classifyVehicleType(vt, hint = '') {
  const ff = String(vt?.form_factor || '').toLowerCase();
  const prop = String(vt?.propulsion_type || '').toLowerCase();
  const h = String(hint).toLowerCase();
  if (ff === 'scooter' || ff === 'scooter_standing' || ff === 'scooter_seated') return 'scooter';
  if (ff === 'cargo_bicycle' || /lasten|cargo/.test(h)) return 'cargo';
  if (ff === 'bicycle') return /electric/.test(prop) ? 'ebike' : 'bike';
  if (ff === 'moped') return 'moped';
  if (ff === 'car') return 'car';
  if (ff === 'other') return 'other';
  // ohne form_factor: Carsharing- und E-Roller-Feeds am Namen (vor den Rad-/Scooter-Wörtern: „Carsharing Radolfzell“)
  if (/car.?sharing|stadtmobil|teilauto|flinkster|getaround|cambio|share.?now|\bmiles\b|\bdeer\b|\bauto\b|swu2go|conficars/.test(h)) return 'car';
  if (/moped|\bemmy\b|\bstella\b|schwalbe|sitzroller/.test(h)) return 'moped';
  if (/scooter|roller|zeus|voi|bolt|lime|bird|dott|tier/.test(h)) return 'scooter';
  if (/e-?bike|pedelec/.test(h)) return 'ebike';
  if (/bike|rad|velo|nextbike|donkey|callabike|regiorad|stadtrad/.test(h)) return 'bike';
  return 'unknown';
}

// ---------- Geo ----------
export function validLatLon(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
}
export const inGermanyBbox = (lat, lon) => lat >= DE_BBOX.minLat && lat <= DE_BBOX.maxLat && lon >= DE_BBOX.minLon && lon <= DE_BBOX.maxLon;

// Eindeutig vertauschte Koordinaten (lon im Lat-Bereich Deutschlands und umgekehrt) reparieren
export function repairLatLon(lat, lon) {
  if (validLatLon(lat, lon) && inGermanyBbox(lat, lon)) return { lat, lon, repaired: false };
  if (validLatLon(lon, lat) && inGermanyBbox(lon, lat)) return { lat: lon, lon: lat, repaired: true };
  return { lat, lon, repaired: false };
}

export function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function ringContains(ring, lon, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function polygonContains(coords, lon, lat) { // coords: [outer, hole, hole...]
  if (!ringContains(coords[0], lon, lat)) return false;
  for (let k = 1; k < coords.length; k++) if (ringContains(coords[k], lon, lat)) return false;
  return true;
}
function geomContains(geom, lon, lat) {
  if (!geom) return false;
  if (geom.type === 'Polygon') return polygonContains(geom.coordinates, lon, lat);
  if (geom.type === 'MultiPolygon') return geom.coordinates.some(p => polygonContains(p, lon, lat));
  return false;
}
function geomBbox(geom) {
  let minX = 180, minY = 90, maxX = -180, maxY = -90;
  const walk = (c) => { if (typeof c[0] === 'number') { if (c[0] < minX) minX = c[0]; if (c[0] > maxX) maxX = c[0]; if (c[1] < minY) minY = c[1]; if (c[1] > maxY) maxY = c[1]; } else c.forEach(walk); };
  walk(geom.coordinates);
  return [minX, minY, maxX, maxY];
}
/** Bounding-Box [minLon, minLat, maxLon, maxLat] einer (Multi-)Polygon-Geometrie, 5 Nachkommastellen; null ohne Koordinaten */
export function geomBounds(geom) {
  if (!geom?.coordinates?.length) return null;
  const b = geomBbox(geom); return b[0] > b[2] ? null : b.map(x => +x.toFixed(5));
}
// Flächenschwerpunkt [lat, lon] (Außenringe, flächengewichtet; Löcher vernachlässigt), 4 Nachkommastellen; Rückfall: Mitte der Bounding-Box
export function geomCentroid(geom) {
  const polys = geom?.type === 'Polygon' ? [geom.coordinates] : geom?.type === 'MultiPolygon' ? geom.coordinates : [];
  let W = 0, cx = 0, cy = 0;
  for (const p of polys) {
    const r = p[0]; let a = 0, x = 0, y = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const f = r[j][0] * r[i][1] - r[i][0] * r[j][1]; a += f; x += (r[j][0] + r[i][0]) * f; y += (r[j][1] + r[i][1]) * f; }
    if (Math.abs(a) < 1e-12) continue;
    const w = Math.abs(a) / 2; W += w; cx += (x / (3 * a)) * w; cy += (y / (3 * a)) * w;
  }
  if (!W) { if (!polys.length) return null; const b = geomBbox(geom); return [+((b[1] + b[3]) / 2).toFixed(4), +((b[0] + b[2]) / 2).toFixed(4)]; }
  return [+(cy / W).toFixed(4), +(cx / W).toFixed(4)];
}

// Fläche in km² auf der Kugel (WGS84-Äquatorradius, sphärischer Exzess wie geojson-area; Löcher abgezogen), 2 Nachkommastellen
function ringAreaM2(r) {
  const R = 6378137, t = Math.PI / 180; let a = 0;
  for (let i = 0; i < r.length; i++) { const p1 = r[i], p2 = r[(i + 1) % r.length]; a += (p2[0] - p1[0]) * t * (2 + Math.sin(p1[1] * t) + Math.sin(p2[1] * t)); }
  return Math.abs(a * R * R / 2);
}
export function geomAreaKm2(geom) {
  const polys = geom?.type === 'Polygon' ? [geom.coordinates] : geom?.type === 'MultiPolygon' ? geom.coordinates : [];
  if (!polys.length) return null;
  let m2 = 0; for (const p of polys) p.forEach((r, i) => { m2 += (i ? -1 : 1) * ringAreaM2(r); });
  return +(Math.max(0, m2) / 1e6).toFixed(2);
}

// Minuten je Ortsstunde eines Tages (Zeitumstellung: Ende Oktober hat Stunde 2 zweimal = 120 Min., Ende März fehlt sie = 0 Min.)
export function hourMinutes(day, tz = 'Europe/Berlin') {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  const out = new Array(24).fill(0); const t0 = Date.parse(`${day}T00:00:00Z`);
  for (let t = t0 - 14 * 3600e3; t < t0 + 38 * 3600e3; t += 15 * 60e3) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map(x => [x.type, x.value]));
    if (`${p.year}-${p.month}-${p.day}` === day) out[+p.hour % 24] += 15;
  }
  return out;
}

// Gemeinde-Index: Rasterzellen (0.1°) → Kandidaten
export function buildMunicipalityIndex(featureCollection, cell = 0.1) {
  const feats = featureCollection.features;
  const grid = new Map();
  const bboxes = feats.map(f => f.bbox || geomBbox(f.geometry));
  bboxes.forEach((b, i) => {
    for (let x = Math.floor(b[0] / cell); x <= Math.floor(b[2] / cell); x++)
      for (let y = Math.floor(b[1] / cell); y <= Math.floor(b[3] / cell); y++) {
        const k = `${x}:${y}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(i);
      }
  });
  return { feats, bboxes, grid, cell };
}
export function assignMunicipality(index, lat, lon) {
  if (!index || !validLatLon(lat, lon)) return null;
  const k = `${Math.floor(lon / index.cell)}:${Math.floor(lat / index.cell)}`;
  const cands = index.grid.get(k);
  if (!cands) return null;
  for (const i of cands) {
    const b = index.bboxes[i];
    if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
    if (geomContains(index.feats[i].geometry, lon, lat)) return index.feats[i].properties;
  }
  return null;
}

// ---------- Kennungen ----------
const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
export function normalizeId(raw) {
  const s = String(raw ?? '').trim();
  const u = s.match(UUID_RE);
  if (u) return u[1].toLowerCase();
  return s.toLowerCase().replace(/^(bike|vehicle|scooter|veh|v|b|id)[:_-]+/, '').replace(/^[a-z0-9_-]+?:(?=.)/, '');
}
export function hashStr(s) { // FNV-1a 32 bit
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

// ---------- GBFS lesen ----------
export function firstLang(obj) {
  if (!obj) return null;
  if (Array.isArray(obj)) return obj.find(x => x && (x.language === 'de' || x.language === 'en'))?.text ?? obj[0]?.text ?? null;
  if (typeof obj === 'object') return obj.de ?? obj.en ?? Object.values(obj)[0] ?? null;
  return obj;
}

// discovery → { version, feeds: {name: url}, lang }
export function parseDiscovery(doc) {
  const version = String(doc?.version || '');
  let feeds = null, lang = null;
  if (doc?.data?.feeds) { feeds = doc.data.feeds; lang = doc.data.language || null; }
  else if (doc?.data && typeof doc.data === 'object') {
    const langs = Object.keys(doc.data);
    const pick = langs.find(l => l === 'de') || langs.find(l => l === 'en') || langs[0];
    if (pick && doc.data[pick]?.feeds) { feeds = doc.data[pick].feeds; lang = pick; }
  }
  const map = {};
  for (const f of feeds || []) if (f?.name && f?.url) map[f.name] = f.url;
  return { version, feeds: map, lang };
}

/**
 * Liest ein GBFS-System. fetchJson(url) → { ok, status, json, latencyMs }.
 * Rückgabe: normalisiertes System (Fahrzeuge, Stationen, Metadaten, Fehler).
 */
/**
 * Öffentliche Fahrzeugnummer aus rental_uris (Zeus direkt: …/applinks?vehicle=8148, Zeus über MobiData BW: ridezeus.app.link/8148 bzw. …/SL2AB6).
 * Dient dem Abgleich zwischen Quellen eines Anbieters mit verschiedenen Kennungen (dedupeVehicles); null ohne erkennbare Nummer.
 */
export function rentalCode(uris) {
  if (!uris || typeof uris !== 'object') return null;
  for (const k of ['android', 'ios', 'web']) {
    const s = String(uris[k] || '').trim(), m = s.match(/[?&](?:vehicle|vehicle_id|vehicleid|scooter|bike|code)=([A-Za-z0-9-]{3,24})(?:&|#|$)/i) || s.match(/^https?:\/\/[^/]+\/([A-Za-z0-9]{3,12})\/?$/);
    if (m) return m[1].toUpperCase();
  }
  return null;
}
