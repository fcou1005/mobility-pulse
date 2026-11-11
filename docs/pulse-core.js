// Mobility Pulse — gemeinsame Kernbibliothek für Sammler (Node) und Dashboard (Browser).
// Keine Abhängigkeiten. ESM.

export const GHOST_MS = 7 * 86400e3; // gesperrt und so lange ohne Signal = verwaister Eintrag, kein Bestand
export const LIVE_MS = 5 * 60e3;      // ≤ 5 Min: aktuell (GBFS-Latenzvorgabe)
export const DELAYED_MS = 30 * 60e3;  // ≤ 30 Min: verzögert, darüber veraltet
export const DE_BBOX = { minLon: 5.8, minLat: 47.2, maxLon: 15.1, maxLat: 55.2 };

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
function firstLang(obj) {
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
// ---------- Landesfeed und Betreiberfeed kombinieren (07.11.2026) ----------
// Quellen mit altUrls auf anderem Host (MobiData BW ↔ Zeus direkt, Yoio ↔ MobiData BW …) werden beide gelesen:
// - Hauptfeed ohne Fahrzeuge und Stationen (leer oder Fehler): der Ersatz zählt (sys.viaAlt). zeus_ludwigsburg (MobiData BW) ist seit Beginn der
//   Sammlung leer, Zeus direkt hat rund 150 nicht gesperrte Fahrzeuge.
// - Sonst kommen Fahrzeuge dazu, die nur im Ersatz stehen (altOnlyVehicles, sys.merged): weder gleiche Kennung noch gleiche Fahrzeugnummer
//   (rentalCode) noch ein Fahrzeug des Hauptfeeds ≤ posM m, nicht gesperrt, Meldung höchstens staleH Stunden alt. Geprüft 07.11.2026: Zeus
//   Würzburg direkt 10 frische Fahrzeuge, die MobiData BW nicht führt; in Freiburg, Konstanz, Tuttlingen, Villingen-Schwenningen höchstens 1.
// Der Ersatz liegt in sys.altRead für den Konsistenzvergleich (kein zweiter Abruf), der unveränderte Hauptfeed in sys.primaryVehicles.
export const MERGE = { posM: 10, staleH: 72 };
/** Fahrzeuge aus alt ohne Gegenstück in prim (Kennung, Fahrzeugnummer, Position ≤ posM m), nicht gesperrt und frisch */
export function altOnlyVehicles(prim, alt, { now = Date.now(), opts = MERGE } = {}) {
  const ids = new Set(prim.map(v => normalizeId(v.rawId))), codes = new Set(prim.map(v => v.code).filter(Boolean)), grid = new Map(), cs = 0.001;
  for (const v of prim) if (validLatLon(v.lat, v.lon)) { const k = `${Math.floor(v.lat / cs)}:${Math.floor(v.lon / cs)}`; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(v); }
  const near = (v) => { const a = Math.floor(v.lat / cs), b = Math.floor(v.lon / cs); for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const w of grid.get(`${a + i}:${b + j}`) || []) if (haversineM(v.lat, v.lon, w.lat, w.lon) <= opts.posM) return true; return false; };
  return alt.filter(v => !v.disabled && validLatLon(v.lat, v.lon) && !(v.reportedAt != null && now - v.reportedAt > opts.staleH * 3600e3)
    && !ids.has(normalizeId(v.rawId)) && !(v.code && codes.has(v.code)) && !near(v));
}
export async function readGbfsWithFallback(source, fetchJson, opts = {}) {
  const sys = await readGbfsSystem(source, fetchJson, opts);
  const host = (u) => { try { return new URL(u).host; } catch { return ''; } };
  const alt = (source.altUrls || []).find(u => host(u) && host(u) !== host(source.url)); if (!alt) return sys;
  let s2; try { s2 = await readGbfsSystem({ ...source, url: alt }, fetchJson, opts); } catch { return sys; }
  if (!sys.vehicles.length && !sys.stations.length) { if (s2.vehicles.length || s2.stations.length) { s2.viaAlt = { url: alt, from: source.url, httpStatus: sys.httpStatus }; return s2; } sys.altRead = s2; return sys; }
  sys.altRead = s2; sys.primaryVehicles = sys.vehicles.slice();
  if (sys.vehicles.length && s2.vehicles.length) {
    const add = altOnlyVehicles(sys.vehicles, s2.vehicles, { now: opts.now ?? Date.now() });
    if (add.length) { sys.vehicles.push(...add.map(v => ({ ...v, fromAlt: true }))); sys.merged = { url: alt, added: add.length }; }
  }
  return sys;
}
export async function readGbfsSystem(source, fetchJson, { now = Date.now(), maxVehicles = Infinity } = {}) {
  const t0 = Date.now();
  const errors = [];
  const res = { sourceId: source.id, operator: source.operator, api: 'gbfs', url: source.url, errors, vehicles: [], stations: [], systemInfo: {}, vehicleTypes: {}, feedAges: {}, lastUpdated: null, ttl: null, httpStatus: null, latencyMs: null };
  const disc = await fetchJson(source.url);
  res.httpStatus = disc.status;
  if (!disc.ok || !disc.json) { errors.push(`discovery: HTTP ${disc.status}${disc.error ? ' ' + disc.error : ''}`); res.latencyMs = Date.now() - t0; return res; }
  const { version, feeds, lang } = parseDiscovery(disc.json);
  res.version = version || disc.json?.version || null; res.lang = lang;
  res.lastUpdated = toMs(disc.json.last_updated); res.ttl = num(disc.json.ttl);
  if (!Object.keys(feeds).length) { errors.push('discovery: keine Feeds'); res.latencyMs = Date.now() - t0; return res; }
  res.feeds = feeds;

  const get = async (name) => {
    if (!feeds[name]) return null;
    const r = await fetchJson(feeds[name]);
    if (!r.ok || !r.json) { errors.push(`${name}: HTTP ${r.status}${r.error ? ' ' + r.error : ''}`); return null; }
    const lu = toMs(r.json.last_updated);
    res.feedAges[name] = lu != null ? now - lu : null;
    return r.json;
  };

  const [sysInfo, vtypes, stInfo, stStatus, vehStatus, fbs] = await Promise.all([
    get('system_information'), get('vehicle_types'), get('station_information'), get('station_status'),
    get('vehicle_status'), feeds.vehicle_status ? Promise.resolve(null) : get('free_bike_status'),
  ]);
  const vehicleFeed = vehStatus || fbs;
  const vehicleFeedName = vehStatus ? 'vehicle_status' : 'free_bike_status';

  if (sysInfo?.data) {
    const d = sysInfo.data;
    res.systemInfo = {
      systemId: d.system_id || null, name: firstLang(d.name), operator: firstLang(d.operator), timezone: d.timezone || null,
      licenseId: d.license_id || null, licenseUrl: d.license_url || null, attribution: firstLang(d.attribution_organization_name) || null, attributionUrl: d.attribution_url || null,
      url: d.url || null, feedContact: d.feed_contact_email || null,
    };
  }
  const typeMap = {};
  for (const vt of vtypes?.data?.vehicle_types || []) {
    typeMap[vt.vehicle_type_id] = { type: classifyVehicleType(vt, vt.name ? firstLang(vt.name) : ''), propulsion: vt.propulsion_type || null, maxRangeM: num(vt.max_range_meters), formFactor: vt.form_factor || null };
  }
  res.vehicleTypes = typeMap;
  const hint = `${source.operator} ${source.name || ''} ${res.systemInfo.name || ''}`;
  const fallbackType = classifyVehicleType(null, hint);

  // Stationen
  const stMap = new Map();
  for (const s of stInfo?.data?.stations || []) {
    const lat = num(s.lat), lon = num(s.lon);
    stMap.set(String(s.station_id), { id: String(s.station_id), name: firstLang(s.name) || '', lat, lon, capacity: num(s.capacity), isVirtual: bool(s.is_virtual_station) });
  }
  const stAge = res.feedAges.station_status;
  for (const s of stStatus?.data?.stations || []) {
    const base = stMap.get(String(s.station_id)) || { id: String(s.station_id), name: '', lat: null, lon: null, capacity: null, missingInfo: true };
    const physical = num(s.num_vehicles_available ?? s.num_bikes_available);
    const disabled = num(s.num_vehicles_disabled ?? s.num_bikes_disabled);
    const installed = bool(s.is_installed) ?? true, renting = bool(s.is_renting) ?? true, returning = bool(s.is_returning) ?? true;
    const docks = num(s.num_docks_available);
    const perType = {};
    for (const t of s.vehicle_types_available || []) { const ty = typeMap[t.vehicle_type_id]?.type || fallbackType; perType[ty] = (perType[ty] || 0) + (num(t.count) || 0); }
    const reportedAt = toMs(s.last_reported) ?? (stStatus?.last_updated ? toMs(stStatus.last_updated) : null);
    // virtuell (Abstellzone): laut Feed (is_virtual_station); fehlt die Angabe, gilt eine Station ohne num_docks_available als virtuell
    // (GBFS: num_docks_available ist Pflicht außer bei unbegrenzter Rückgabekapazität, also virtuellen Stationen)
    const isVirtual = base.isVirtual ?? (docks == null);
    stMap.set(base.id, { ...base, isVirtual, physicalAvailable: physical, disabled, docksAvailable: docks, installed, renting, returning,
      bookable: installed && renting ? physical : 0, returnable: installed && returning ? (docks ?? null) : 0,
      perType: Object.keys(perType).length ? perType : null, typeHint: fallbackType, reportedAt, feedAgeMs: stAge });
  }
  res.stations = [...stMap.values()];

  // Fahrzeuge
  const vehAge = res.feedAges[vehicleFeedName];
  const list = vehicleFeed?.data?.vehicles || vehicleFeed?.data?.bikes || [];
  res.vehicleListPresent = !!vehicleFeed;
  // Ladestand-Skala je Quelle: 0..1 (GBFS 2.3) nur, wenn die Quelle insgesamt keine Werte über 1 meldet – sonst würde aus 1 % in einem 0–100-Feed 100 %
  const fuel = list.slice(0, maxVehicles).map(v => num(v.current_fuel_percent)).filter(x => x != null);
  const fuelFraction = fuel.length > 0 && fuel.every(x => x >= 0 && x <= 1);
  let idx = 0;
  for (const v of list) {
    if (idx++ >= maxVehicles) break;
    let lat = num(v.lat), lon = num(v.lon);
    let origin = 'vehicle', repaired = false, geoStatus = 'ok';
    const stationId = v.station_id != null ? String(v.station_id) : null;
    if (lat == null || lon == null) {
      const st = stationId ? stMap.get(stationId) : null;
      if (st && validLatLon(st.lat, st.lon)) { lat = st.lat; lon = st.lon; origin = 'station'; }
    }
    if (lat != null && lon != null) { const r = repairLatLon(lat, lon); lat = r.lat; lon = r.lon; repaired = r.repaired; }
    if (!validLatLon(lat, lon)) geoStatus = 'missing';
    else if (!inGermanyBbox(lat, lon)) geoStatus = 'outside';
    const vt = typeMap[v.vehicle_type_id];
    const type = vt?.type || fallbackType;
    const rangeM = num(v.current_range_meters);
    let battery = num(v.current_fuel_percent), batteryDerived = false;
    if (battery != null && fuelFraction) battery = battery * 100; // 2.3: 0..1
    if (battery == null && rangeM != null && vt?.maxRangeM) { battery = Math.min(100, Math.round((rangeM / vt.maxRangeM) * 100)); batteryDerived = true; } // abgeleitet aus Reichweite ÷ Maximalreichweite
    const reportedAt = toMs(v.last_reported);
    // Verwaiste Einträge: gesperrt und seit über 7 Tagen kein Signal (z. B. Zeus: Hälfte der Flotte seit Monaten stumm).
    // Sie zählen weder als Bestand noch als gesperrt; nur die Anzahl bleibt sichtbar.
    if (bool(v.is_disabled) && reportedAt != null && now - reportedAt > GHOST_MS) { res.ghosts = (res.ghosts || 0) + 1; (res.ghostIds ??= []).push(v.vehicle_id ?? v.bike_id); continue; }
    res.vehicles.push({
      rawId: v.vehicle_id ?? v.bike_id ?? `${source.id}#${idx}`, lat, lon, type, propulsion: vt?.propulsion || null,
      reserved: bool(v.is_reserved) ?? false, disabled: bool(v.is_disabled) ?? false, batteryPct: battery, ...(batteryDerived ? { batteryDerived: true } : {}), rangeKm: rangeM != null ? rangeM / 1000 : null,
      stationId, reportedAt, positionAgeMs: reportedAt != null ? now - reportedAt : null, geoOrigin: origin, geoRepaired: repaired, geoStatus,
      vtId: v.vehicle_type_id != null ? String(v.vehicle_type_id) : null, code: rentalCode(v.rental_uris),
    });
  }
  // Fahrzeugliste vorhanden, aber leer, während die Stationen Autos bzw. E-Roller melden (deer 08.11.2026: free_bike_status leer, 456 Autos an
  // 572 Stationen): dann zählen die Stationen den Bestand wie bei Quellen ohne Fahrzeugliste. Nur Carsharing/E-Roller, Mikromobilität unverändert.
  if (vehicleFeed && !list.length && res.stations.some(st => (st.physicalAvailable ?? 0) > 0)
    && res.stations.every(st => Object.keys(st.perType || { [st.typeHint]: 1 }).every(ty => ty === 'car' || ty === 'moped'))) { res.vehicleListPresent = false; res.vehicleListEmpty = true; }
  // Fahrzeugnummer aus den Ausleih-Links nur, wenn fast alle Fahrzeuge der Quelle eine haben und keine doppelt vorkommt (allgemeine Links zählen nicht)
  { const coded = res.vehicles.filter(x => x.code); if (!(coded.length >= 2 && coded.length >= 0.9 * res.vehicles.length && new Set(coded.map(x => x.code)).size === coded.length)) for (const x of res.vehicles) delete x.code; }
  // Skala unplausibel (z. B. Lime über MOBIDROM/MobiData BW/Dresden: kein Wert über 30–50 %): Ladestand nicht verwenden (Abholung, Akkutausch,
  // Energie) und in der Feed-Prüfung ausweisen; der Wert bleibt nur als Fingerabdruck für den Kennungswechsel-Abgleich (batteryFp). Keine Umrechnung.
  res.batteryScale = batteryScaleCheck(res.vehicles, { fraction: fuelFraction });
  if (res.batteryScale.suspect) for (const v of res.vehicles) { if (v.batteryPct != null) v.batteryFp = v.batteryPct; v.batteryPct = null; }
  res.batteryFloor = batteryFloorCheck(res.vehicles); // Ausblenden bei niedrigem Akku (Z4): sources[].batteryFloor, Verfolgung zählt hide statt Fahrtbeginn
  // Reichweite: konstant (Platzhalter) → v.rangeFlat; aus dem Ladestand gerechnet → v.rangeDerived; kleine Skala → v.rangeLimitKm (applyRangeChecks)
  Object.assign(res, applyRangeChecks(res.vehicles));
  res.checks = checkGbfs({ disc: disc.json, listed: Object.keys(feeds), now, battery: res.batteryScale, range: res.rangeCheck, rangeLimit: res.rangeLimit, rangeFlat: res.rangeFlat,
    docs: { system_information: sysInfo, vehicle_types: vtypes, station_information: stInfo, station_status: stStatus, ...(feeds.vehicle_status ? { vehicle_status: vehStatus } : { free_bike_status: fbs }) } });
  res.latencyMs = Date.now() - t0;
  return res;
}

/**
 * Basisprüfung eines GBFS-Systems (eigene Prüfung von Mobility Pulse, kein MobilityData-Validator): Kopf je Datei (ttl, last_updated,
 * version), Frische der Status-Dateien, Pflichtdateien, Pflichtfelder und gültige Koordinaten.
 * docs: { feedName: JSON | null (gelistet, aber nicht abrufbar) }, listed: Feednamen aus gbfs.json.
 * Rückgabe { label, errors, warnings, items: [{ level, feed, msg, n? }] (höchstens 5, Fehler zuerst) }.
 */
export const CHECKS_LABEL = 'Mobility Pulse Basisprüfung (GBFS-Pflichtfelder; kein MobilityData-Validator)';
// Ladestand-Skala: liegt bei ≥ minN Fahrzeugen mit Ladestand das 99. Perzentil unter maxP99 %, ist die Skala unplausibel (eine ganze Flotte
// unter 60 % gibt es nicht; Lime über MOBIDROM: höchstens 37 %). Rückgabe { n, p99, max, derived, fraction, suspect }.
export const BATTERY_SCALE = { minN: 50, maxP99: 60 };
export const BATTERY_SCALE_MSG = 'Ladestand-Skala unplausibel (99 % der Werte unter 60 %): Ladestand nicht verwendet';
export function batteryScaleCheck(vehicles, { minN = BATTERY_SCALE.minN, maxP99 = BATTERY_SCALE.maxP99, fraction = false } = {}) {
  const b = (vehicles || []).map(v => v.batteryPct).filter(x => x != null && Number.isFinite(x)).sort((x, y) => x - y);
  const n = b.length, p99 = n ? b[Math.floor(0.99 * (n - 1))] : null;
  return { n, p99: p99 != null ? Math.round(p99) : null, max: n ? Math.round(b[n - 1]) : null, derived: (vehicles || []).filter(v => v.batteryDerived).length, fraction: !!fraction, suspect: n >= minN && p99 < maxP99 };
}
// Ausblenden bei niedrigem Akku (Z4, Prüfung 02.11.2026): Manche Betreiber nehmen fast leere Fahrzeuge aus dem Feed, statt sie als gesperrt zu
// melden (Dott meldet nie gesperrte; Dott Stuttgart: 3 von 1.277 unter 15 %, Voi 67 von 1.450, Bolt 77 von 1.056). Ihr Verschwinden sähe aus wie
// eine Ausleihe. Je Quelle mit ≥ minN (500) Fahrzeugen mit absolutem Ladestand (Skala plausibel, nicht abgeleitet; gesperrte zählen mit – wer leere
// Fahrzeuge als gesperrt meldet, blendet nicht aus: ohne Gesperrte läge Voi Köln bei 17 %, Bolt Stuttgart bei 12 %): Untergrenze p005 =
// 0,5-Perzentil; ab minFloor (12 %) blendet die Quelle aus, wenn der Boden sauber ist (0,1-Perzentil p001 ≥ p005 − band): einzelne Fahrzeuge
// mit 1–7 % sprechen gegen eine Ausblendung (Voi Wuppertal 02.11.: p005 13, aber Werte 1, 1, 7, 7). Gemessen 02.11.2026 (ops, je Anbieter und
// Stadt): Dott Stuttgart p005 16 (Minimum 13), Köln 17, München 15, Berlin 14, Düsseldorf 10; nextbike-E-Räder München 23; Voi 2–9, Bolt 0–4.
// Erster Sammler-Lauf mit der Regel (02.11.2026 12:3x): Grenzfälle mit p005 10–11 (Bolt Stuttgart 11/10, Dott Düsseldorf 10, Münster 10,
// Hannover 11) – Bolt meldet leere Fahrzeuge als gesperrt, ein Verschwinden bei 11–16 % ist dort eher eine Ausleihe. Deshalb minFloor 12: nur
// klare Fälle (Dott Berlin 13, München/Stuttgart/Kaiserslautern 15, Köln 17, nextbike-E-Räder 23–25) werden umgedeutet, Grenzfälle bleiben Fahrt.
// Rückgabe { n, p005, p001, hides } (p005/p001 null unter minN).
export const BATTERY_FLOOR = { minN: 500, minFloor: 12, band: 5 };
export function batteryFloorCheck(vehicles, { minN = BATTERY_FLOOR.minN, minFloor = BATTERY_FLOOR.minFloor, band = BATTERY_FLOOR.band } = {}) {
  const b = (vehicles || []).filter(v => !v.batteryDerived).map(v => v.batteryPct).filter(x => x != null && Number.isFinite(x)).sort((x, y) => x - y);
  const n = b.length; if (n < minN) return { n, p005: null, p001: null, hides: false };
  const p005 = Math.round(b[Math.floor(0.005 * (n - 1))]), p001 = Math.round(b[Math.floor(0.001 * (n - 1))]);
  return { n, p005, p001, hides: p005 >= minFloor && p001 >= p005 - band };
}
// Reichweite aus dem Ladestand gerechnet (M-16): je Fahrzeugtyp (vehicle_type_id) mit ≥ minN Fahrzeugen mit eigenem Ladestand ≥ minBattery %
// (nicht aus der Reichweite abgeleitet, Skala plausibel) und Reichweite: Spanne p10–p90 von Reichweite ÷ Ladestand höchstens maxSpread (3 %) des
// Medians → abgeleitet. Gemessen 01.11.2026: Voi, Zeus, Yoio, swabi, Donkey Kiel 0–1 % (Voi 80 km je 100 %), Dott 11 %, Bolt 30–34 %.
// Typen unter minN werden gemeinsam geprüft. Rückgabe { n, derived, derivedTypes: [vtId], types: [{ id, n, kmPer100, spread, derived }] }.
export const RANGE_DERIVED = { minN: 50, minBattery: 20, maxSpread: 0.03 };
export const RANGE_DERIVED_MSG = 'Reichweite aus dem Ladestand gerechnet (Reichweite ÷ Ladestand konstant): für Energie und Akkutausch zählt nur der Ladestand';
export function rangeDerivedCheck(vehicles, { minN = RANGE_DERIVED.minN, minBattery = RANGE_DERIVED.minBattery, maxSpread = RANGE_DERIVED.maxSpread } = {}) {
  const by = new Map();
  for (const v of vehicles || []) {
    if (v.batteryPct == null || v.batteryDerived || v.rangeKm == null || !(v.batteryPct >= minBattery) || !Number.isFinite(v.rangeKm)) continue;
    const k = v.vtId ?? ''; if (!by.has(k)) by.set(k, []); by.get(k).push(v.rangeKm / v.batteryPct);
  }
  const stat = (xs) => { const a = xs.slice().sort((x, y) => x - y), q = (p) => a[Math.floor(p * (a.length - 1))]; const p50 = q(0.5); return { n: a.length, kmPer100: +(p50 * 100).toFixed(1), spread: p50 > 0 ? +((q(0.9) - q(0.1)) / p50).toFixed(4) : null }; };
  const types = [], small = [], smallIds = [];
  for (const [id, xs] of by) { if (xs.length >= minN) { const st = stat(xs); types.push({ id, ...st, derived: st.spread != null && st.spread <= maxSpread }); } else { small.push(...xs); smallIds.push(id); } }
  if (small.length >= minN) { const st = stat(small); const d = st.spread != null && st.spread <= maxSpread; for (const id of smallIds) types.push({ id, ...st, pooled: true, derived: d }); }
  const derivedTypes = types.filter(t => t.derived).map(t => t.id);
  return { n: [...by.values()].reduce((a, x) => a + x.length, 0), derived: derivedTypes.length > 0, derivedTypes, types };
}
// Reichweiten-Schwelle relativ zur Quelle (Nutzerwunsch 02.11.2026): Manche Feeds melden nur kleine Reichweiten (Lime über MobiData BW:
// höchstens ≈ 15 km). Mit der festen Schwelle „Reichweite < 5 km“ gälte dort ein Drittel der Skala als leer (Stuttgart: 601 Lime tauschbedürftig).
// Regel je Quelle: bei ≥ minN (50) Fahrzeugen mit Reichweite und 95. Perzentil p95 < maxP95Km (25 km) ist die Schwelle share (20 %) × p95,
// angewandt als min(eingestellte Schwelle, 20 % × p95); sonst null (Standard). Konstanten: 20 % entspricht bei voller Skala dem Ladestand-
// Grenzwert 20 %; 25 km = Standardschwelle 5 km ÷ 20 %, darüber wäre 20 % × p95 ≥ 5 km und änderte nichts (stetiger Übergang). Gemessen
// 01.11.2026 (.realdata, p95 je Quelle): Lime 11,9 (MobiData BW) bis 18,3 km (Wuppertal), Dott 24,9–26,4, Yoio 25,8, Bolt 29,5–30,2,
// Zeus 29,8–33,6 km, Voi 80 km je 100 %. 95. Perzentil statt Maximum, damit einzelne Ausreißer die Skala nicht bestimmen; p95 = 0 (nextbike:
// Reichweite 0 bei Rädern ohne Motor) bleibt Standard. Gerundet auf 0,1 km. Rückgabe { n, p95Km, limitKm }.
export const RANGE_LIMIT = { minN: 50, maxP95Km: 25, share: 0.2, stdKm: 5 };
const deNum = (x) => String(x).replace('.', ',');
export const rangeLimitMsg = ({ p95Km, limitKm }) => `Reichweite klein (95. Perzentil ${deNum(p95Km)} km < ${RANGE_LIMIT.maxP95Km} km): Reichweiten-Schwelle ${deNum(limitKm)} km (${Math.round(RANGE_LIMIT.share * 100)} % davon) statt ${RANGE_LIMIT.stdKm} km`;
export function rangeLimitCheck(vehicles, { minN = RANGE_LIMIT.minN, maxP95Km = RANGE_LIMIT.maxP95Km, share = RANGE_LIMIT.share } = {}) {
  const r = (vehicles || []).map(v => v.rangeKm).filter(x => x != null && Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  const n = r.length, p95 = n ? r[Math.floor(0.95 * (n - 1))] : null;
  const limitKm = n >= minN && p95 > 0 && p95 < maxP95Km ? Math.max(0.1, Math.round(share * p95 * 10) / 10) : null;
  return { n, p95Km: p95 != null ? Math.round(p95 * 10) / 10 : null, limitKm };
}
// Konstante Reichweite (Platzhalter, Nachtrag 02.11.2026): Donkey Bayern meldet für jedes Fahrzeug 1 km, nextbike-E-Räder (MOBIDROM, direkt)
// 0 km. Eine solche Reichweite sagt nichts über den Akku: bei ≥ minN (50) Fahrzeugen mit Reichweite und Spanne p5–p95 unter maxSpreadKm (0,1 km)
// oder mehr als maxModeShare (95 %) gleichen Werten (auf 0,1 km) gilt sie für Energie und Akkutausch als unbekannt (v.rangeFlat), wie die
// unplausible Ladestand-Skala. Der Rohwert bleibt (Anzeige, Fingerabdruck, Zähler lowRange). Rückgabe { n, p5Km, p95Km, modeKm, modeShare, flat }.
export const RANGE_FLAT = { minN: 50, maxSpreadKm: 0.1, maxModeShare: 0.95 };
export const RANGE_FLAT_MSG = 'Reichweite konstant (Platzhalter): für Energie und Akkutausch nicht verwendet';
export function rangeFlatCheck(vehicles, { minN = RANGE_FLAT.minN, maxSpreadKm = RANGE_FLAT.maxSpreadKm, maxModeShare = RANGE_FLAT.maxModeShare } = {}) {
  const r = (vehicles || []).map(v => v.rangeKm).filter(x => x != null && Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  const n = r.length; if (!n) return { n: 0, p5Km: null, p95Km: null, modeKm: null, modeShare: null, flat: false };
  const q = (p) => r[Math.floor(p * (n - 1))], cnt = new Map(); let mode = null, mc = 0;
  for (const x of r) { const k = Math.round(x * 10) / 10, c = (cnt.get(k) || 0) + 1; cnt.set(k, c); if (c > mc) { mc = c; mode = k; } }
  const p5 = q(0.05), p95 = q(0.95), share = mc / n, r1 = (x) => Math.round(x * 10) / 10;
  return { n, p5Km: r1(p5), p95Km: r1(p95), modeKm: mode, modeShare: +share.toFixed(3), flat: n >= minN && (p95 - p5 < maxSpreadKm || share > maxModeShare) };
}
/**
 * Reichweiten-Prüfungen einer Quelle in fester Reihenfolge (Live-Feed im Sammler und im Browser, Schnappschuss im Browser): konstant (rangeFlat,
 * dann keine weiteren Prüfungen), aus dem Ladestand gerechnet (rangeCheck), Schwelle der Quelle (rangeLimit). Markiert die Fahrzeuge
 * (v.rangeFlat, v.rangeDerived, v.rangeLimitKm). Erwartet den Ladestand nach batteryScaleCheck. Rückgabe { rangeFlat, rangeCheck, rangeLimit }.
 */
export function applyRangeChecks(vehicles) {
  const list = vehicles || [];
  const rangeFlat = rangeFlatCheck(list);
  if (rangeFlat.flat) for (const v of list) if (v.rangeKm != null) v.rangeFlat = true;
  const use = rangeFlat.flat ? [] : list;
  // Reichweite aus dem Ladestand gerechnet (M-16, z. B. Voi: Reichweite = Ladestand × 0,8 km): je Fahrzeugtyp konstantes Verhältnis →
  // v.rangeDerived; für Energie/Akkutausch zählt dann nur der Ladestand (lib/pulse-report.js energyLow, lib/pulse-ops.js needsSwap)
  const rangeCheck = rangeDerivedCheck(use);
  if (rangeCheck.derived) { const ty = new Set(rangeCheck.derivedTypes); for (const v of use) if (v.rangeKm != null && ty.has(v.vtId ?? '')) v.rangeDerived = true; }
  // Reichweiten-Schwelle relativ zur Quelle (Nutzerwunsch 02.11.2026): Feed meldet nur kleine Reichweiten (Lime über MobiData BW ≈ 14 km) →
  // v.rangeLimitKm = 20 % des 95. Perzentils; Energie und Akkutausch prüfen dann „Reichweite < min(Schwelle, v.rangeLimitKm)“
  const rangeLimit = rangeLimitCheck(use);
  if (rangeLimit.limitKm != null) for (const v of use) if (v.rangeKm != null) v.rangeLimitKm = rangeLimit.limitKm;
  return { rangeFlat, rangeCheck, rangeLimit };
}
export function checkGbfs({ disc, docs = {}, listed = [], now = Date.now(), battery = null, range = null, rangeLimit = null, rangeFlat = null }) {
  const all = [];
  const add = (level, feed, msg, n = null) => all.push(n != null ? { level, feed, msg, n } : { level, feed, msg });
  const has = (f) => listed.includes(f);
  const noVersion = [];
  const head = (feed, doc) => {
    if (!doc || typeof doc !== 'object') return;
    const ttl = num(doc.ttl), lu = toMs(doc.last_updated);
    if (ttl == null || ttl < 0) add('error', feed, 'ttl fehlt oder ungültig');
    if (lu == null) add('error', feed, 'last_updated fehlt oder ungültig');
    else if (lu - now > 2 * 60e3) add('error', feed, 'last_updated liegt in der Zukunft');
    else if (/status$/.test(feed) && now - lu > DELAYED_MS + (ttl || 0) * 1000) add('error', feed, `Stand ${Math.round((now - lu) / 60e3)} Min. alt`);
    else if (/status$/.test(feed) && now - lu > LIVE_MS + (ttl || 0) * 1000) add('warning', feed, `Stand ${Math.round((now - lu) / 60e3)} Min. alt (Vorgabe ≤ 5 Min. + ttl)`);
    if (!doc.version) noVersion.push(feed);
    if (!doc.data || typeof doc.data !== 'object') add('error', feed, 'data fehlt');
  };
  head('gbfs', disc);
  for (const [f, d] of Object.entries(docs)) { if (has(f) && d == null) add('error', f, 'gelistet, aber nicht abrufbar'); else head(f, d); }
  if (noVersion.length) add('warning', noVersion.join(', '), 'version fehlt (Pflicht ab GBFS 1.1)');
  // Pflichtdateien
  if (!has('system_information')) add('error', 'gbfs', 'system_information fehlt');
  if (has('station_information') !== has('station_status')) add('error', 'gbfs', 'station_information und station_status nur gemeinsam');
  if (!has('station_status') && !has('free_bike_status') && !has('vehicle_status')) add('error', 'gbfs', 'keine Status-Datei (station_status/vehicle_status)');
  // Pflichtfelder
  const si = docs.system_information?.data;
  if (si) { const miss = ['system_id', 'name', 'timezone'].filter(k => si[k] == null || si[k] === ''); if (miss.length) add('error', 'system_information', `Pflichtfelder fehlen: ${miss.join(', ')}`); }
  const types = new Set((docs.vehicle_types?.data?.vehicle_types || []).map(t => String(t.vehicle_type_id)));
  const count = (list, pred) => list.reduce((a, x) => a + (pred(x) ? 1 : 0), 0);
  const badLL = (x) => { const la = num(x.lat), lo = num(x.lon); return !validLatLon(la, lo); };
  const sInfo = docs.station_information?.data?.stations;
  if (Array.isArray(sInfo)) {
    let n = count(sInfo, s => s.station_id == null || s.name == null || s.lat == null || s.lon == null); if (n) add('error', 'station_information', 'Stationen ohne station_id/name/lat/lon', n);
    n = count(sInfo, s => s.lat != null && s.lon != null && badLL(s)); if (n) add('error', 'station_information', 'ungültige Koordinaten', n);
  }
  const virt = new Set((sInfo || []).filter(s => bool(s.is_virtual_station) === true).map(s => String(s.station_id)));
  const sStat = docs.station_status?.data?.stations;
  if (Array.isArray(sStat)) {
    let n = count(sStat, s => s.station_id == null || (s.num_bikes_available ?? s.num_vehicles_available) == null || s.is_installed == null || s.is_renting == null || s.is_returning == null || s.last_reported == null);
    if (n) add('error', 'station_status', 'Stationen ohne Pflichtfeld (Bestand, is_installed/renting/returning, last_reported)', n);
    n = count(sStat, s => s.num_docks_available == null && !virt.has(String(s.station_id))); if (n) add('warning', 'station_status', 'num_docks_available fehlt (als virtuelle Station gewertet)', n);
  }
  const vf = 'vehicle_status' in docs ? 'vehicle_status' : 'free_bike_status';
  const veh = docs[vf]?.data?.vehicles || docs[vf]?.data?.bikes;
  if (Array.isArray(veh)) {
    let n = count(veh, v => (v.vehicle_id ?? v.bike_id) == null || v.is_reserved == null || v.is_disabled == null); if (n) add('error', vf, 'Fahrzeuge ohne Kennung/is_reserved/is_disabled', n);
    n = count(veh, v => v.station_id == null && (v.lat == null || v.lon == null)); if (n) add('error', vf, 'Fahrzeuge ohne Position und ohne station_id', n);
    n = count(veh, v => v.lat != null && v.lon != null && badLL(v)); if (n) add('error', vf, 'ungültige Koordinaten', n);
    n = count(veh, v => { const la = num(v.lat), lo = num(v.lon); return validLatLon(la, lo) && !inGermanyBbox(la, lo) && inGermanyBbox(lo, la); }); if (n) add('error', vf, 'Koordinaten vertauscht (lat/lon)', n);
    if (vf === 'vehicle_status') { n = count(veh, v => v.last_reported == null); if (n) add('error', vf, 'last_reported fehlt (Pflicht in GBFS 3)', n); }
    n = count(veh, v => v.vehicle_type_id != null && !types.has(String(v.vehicle_type_id))); if (n) add(types.size ? 'warning' : 'error', vf, types.size ? 'vehicle_type_id nicht in vehicle_types' : 'vehicle_type_id ohne vehicle_types', n);
  }
  // Hinweis nur, wenn die Schwelle unter dem Standard liegt (p95 knapp unter 25 km ergibt ≈ 5 km und ändert nichts)
  if (rangeLimit?.limitKm != null && rangeLimit.limitKm < RANGE_LIMIT.stdKm) all.unshift({ level: 'warning', feed: vf, msg: rangeLimitMsg(rangeLimit), n: rangeLimit.n });
  if (rangeFlat?.flat) all.unshift({ level: 'warning', feed: vf, msg: RANGE_FLAT_MSG, n: rangeFlat.n });
  if (range?.derived) all.unshift({ level: 'warning', feed: vf, msg: RANGE_DERIVED_MSG, n: range.n });
  if (battery?.suspect) all.unshift({ level: 'warning', feed: vf, msg: BATTERY_SCALE_MSG, n: battery.n }); // vor den übrigen Warnungen (höchstens 5 Befunde)
  const errors = all.filter(x => x.level === 'error').length;
  return { label: CHECKS_LABEL, errors, warnings: all.length - errors, items: [...all.filter(x => x.level === 'error'), ...all.filter(x => x.level !== 'error')].slice(0, 5) };
}

// CityBikes-Netz lesen (nur Stationszähler, keine Fahrzeugliste)
export async function readCityBikesNetwork(source, fetchJson, { now = Date.now() } = {}) {
  const t0 = Date.now();
  const errors = [];
  const res = { sourceId: source.id, operator: source.operator, api: 'citybikes', url: source.url, errors, vehicles: [], stations: [], systemInfo: {}, vehicleTypes: {}, feedAges: {}, lastUpdated: null, httpStatus: null, latencyMs: null, vehicleListPresent: false };
  const r = await fetchJson(source.url);
  res.httpStatus = r.status;
  if (!r.ok || !r.json?.network) { errors.push(`citybikes: HTTP ${r.status}${r.error ? ' ' + r.error : ''}`); res.latencyMs = Date.now() - t0; return res; }
  const n = r.json.network;
  res.systemInfo = { name: n.name, operator: (n.company || []).join(', ') || null, licenseId: n.license?.name || null, licenseUrl: n.license?.url || null, source: n.source || null };
  const hint = `${source.operator} ${n.name} ${(n.company || []).join(' ')}`;
  const fallbackType = classifyVehicleType(null, hint);
  let newest = null;
  for (const s of n.stations || []) {
    const lat = num(s.latitude), lon = num(s.longitude);
    const ts = toMs(s.timestamp);
    if (ts != null && (newest == null || ts > newest)) newest = ts;
    const ex = s.extra || {};
    const physical = num(s.free_bikes), docks = num(s.empty_slots);
    const renting = bool(ex.renting) ?? true, returning = bool(ex.returning) ?? true, installed = bool(ex.online) ?? true;
    const perType = {};
    if (num(ex.ebikes) != null) perType.ebike = num(ex.ebikes);
    if (num(ex.normal_bikes) != null) perType.bike = num(ex.normal_bikes);
    if (num(ex.scooters) != null) perType.scooter = num(ex.scooters);
    res.stations.push({ id: String(ex.uid ?? s.id), name: s.name || '', lat, lon, capacity: num(ex.slots), physicalAvailable: physical, disabled: null, docksAvailable: docks,
      installed, renting, returning, bookable: installed && renting ? physical : 0, returnable: installed && returning ? docks : 0,
      perType: Object.keys(perType).length ? perType : { [fallbackType]: physical }, typeHint: fallbackType, reportedAt: ts, isVirtual: bool(ex.virtual) ?? (docks == null), feedAgeMs: ts != null ? now - ts : null });
  }
  res.lastUpdated = newest; res.feedAges.station_status = newest != null ? now - newest : null;
  res.latencyMs = Date.now() - t0;
  return res;
}

// ---------- Fingerabdruck & Qualität ----------
export function fingerprint(sys) {
  const feedNames = Object.keys(sys.feeds || {}).sort().join(',');
  const types = Object.values(sys.vehicleTypes || {}).map(t => t.type).sort().join(',');
  return hashStr([sys.url, sys.version, feedNames, types, sys.vehicleListPresent ? 'veh' : 'st'].join('|'));
}

// Frische nur aus den Status-Dateien (statische Dateien wie system_information haben lange ttl und alte last_updated);
// Energie nur über E-Fahrzeuge bewerten; reine Stationszähler (ohne Fahrzeugpositionen) bekommen 0 für Positionen.
const STATUS_FEEDS = ['vehicle_status', 'free_bike_status', 'station_status'];
export function qualityScore(sys, now = Date.now()) {
  const ages = STATUS_FEEDS.map(f => sys.feedAges?.[f]).filter(a => a != null);
  const age = ages.length ? Math.max(...ages) : (sys.lastUpdated != null ? now - sys.lastUpdated : null);
  let fresh = 0;
  if (age != null) fresh = age <= LIVE_MS ? 100 : age <= DELAYED_MS ? Math.round(100 - ((age - LIVE_MS) / (DELAYED_MS - LIVE_MS)) * 60) : Math.max(0, 40 - Math.round(age / 3600e3) * 10);
  const v = sys.vehicles || [], s = sys.stations || [];
  const n = v.length;
  const share = (list, f) => (list.length ? Math.round((list.filter(f).length / list.length) * 100) : 0);
  const electric = v.filter(x => x.type === 'scooter' || x.type === 'ebike' || /electric/.test(x.propulsion || ''));
  const fields = n
    ? [...(electric.length ? [share(electric, x => x.batteryPct != null || x.rangeKm != null)] : []), share(v, x => x.reportedAt != null), share(v, x => x.type !== 'unknown'), 100]
    : [s.some(x => x.renting != null) ? 100 : 0, s.some(x => x.reportedAt != null) ? 100 : 0, s.some(x => x.perType) ? 60 : 0, s.length ? 100 : 0, 0];
  const feat = Math.round(fields.reduce((a, b) => a + b, 0) / fields.length);
  return { score: Math.round(fresh * 0.7 + feat * 0.3), fresh, feat, ageMs: age };
}

// ---------- Dedupe ----------
// Fahrzeuge desselben Anbieters mit gleicher normalisierter Kennung: jüngster Stand gewinnt (bei Gleichstand direkte Position vor Stationsersatz).
// Gleiche Kennung an weit entfernter Position (> 300 m) bleibt als Prüffall erhalten.
export function dedupeVehicles(vehicles, { reuseDistanceM = 300 } = {}) {
  const groups = new Map();
  for (const v of vehicles) {
    const key = `${v.operator}|${normalizeId(v.rawId)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  }
  const out = [], stats = { duplicates: 0, prefixVariants: 0, reusedIds: 0 };
  for (const [, g] of groups) {
    if (g.length === 1) { out.push(g[0]); continue; }
    // jüngster Stand, dann direkte Position, dann Priorität und Quellenkennung (gleicher Stand mehrerer Spiegelkopien: fester Sieger)
    g.sort((a, b) => (b.reportedAt ?? 0) - (a.reportedAt ?? 0) || (a.geoOrigin === 'vehicle' ? 0 : 1) - (b.geoOrigin === 'vehicle' ? 0 : 1) || (a.priority ?? 2) - (b.priority ?? 2) || String(a.sourceId ?? '').localeCompare(String(b.sourceId ?? '')));
    const kept = [g[0]];
    for (let i = 1; i < g.length; i++) {
      const v = g[i];
      const near = kept.some(k => validLatLon(k.lat, k.lon) && validLatLon(v.lat, v.lon) ? haversineM(k.lat, k.lon, v.lat, v.lon) <= reuseDistanceM : true);
      if (near) { stats.duplicates++; if (String(v.rawId) !== String(g[0].rawId)) stats.prefixVariants++; }
      else { v.reusedId = true; stats.reusedIds++; kept.push(v); }
    }
    out.push(...kept);
  }
  // Zweite Stufe: gleiche Fahrzeugnummer (rentalCode) desselben Anbieters aus verschiedenen Quellen, höchstens reuseDistanceM auseinander
  // (Zeus Renningen: MobiData BW und Zeus direkt mit verschiedenen Kennungen, 15 Fahrzeuge in beiden). Sieger wie oben; Verlierer in dropped.
  const byCode = new Map(), dropped = [];
  for (const v of out) if (v.code) { const k = `${v.operator}|${v.code}`; if (!byCode.has(k)) byCode.set(k, []); byCode.get(k).push(v); }
  const lose = new Set();
  for (const [, g] of byCode) {
    if (g.length < 2 || new Set(g.map(v => v.sourceId)).size < 2) continue;
    g.sort((a, b) => (b.reportedAt ?? 0) - (a.reportedAt ?? 0) || (a.geoOrigin === 'vehicle' ? 0 : 1) - (b.geoOrigin === 'vehicle' ? 0 : 1) || (a.priority ?? 2) - (b.priority ?? 2) || String(a.sourceId ?? '').localeCompare(String(b.sourceId ?? '')));
    const w = g[0];
    for (const v of g.slice(1)) if (v.sourceId !== w.sourceId && (!validLatLon(w.lat, w.lon) || !validLatLon(v.lat, v.lon) || haversineM(w.lat, w.lon, v.lat, v.lon) <= reuseDistanceM)) { lose.add(v); dropped.push({ v, of: w.sourceId }); }
  }
  stats.codeDuplicates = dropped.length;
  return { vehicles: lose.size ? out.filter(v => !lose.has(v)) : out, stats, dropped };
}

// ---------- Spiegelquellen mit umgeschlüsselten Kennungen ----------
// MOBIDROM NRW ↔ nextbike direkt, Yoio (rideatom) ↔ MobiData BW, Zeus Heidelberg ↔ Zeus Leimen: dieselben Fahrzeuge unter anderen Kennungen.
// Die Kennungs-Dubletten (dedupeVehicles) greifen hier nicht; erkannt werden die Paare in collect.mjs (consistency.json → pairs: idsRekeyed).
export const MIRROR = { minPos: 0.9, maxDiff: 0.05, knownM: 10, twinM: 5, energyTol: 2, fullBattery: 99 };
/** Stärke zweier Quellen: rank(id) → Liste (kleiner = stärker), bei Gleichstand die Kennung; < 0: a stärker */
export function compareSources(rank) {
  return (a, b) => { const x = rank(a) || [], y = rank(b) || []; for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d; } return a < b ? -1 : a > b ? 1 : 0; };
}
/**
 * Spiegelpaare aus consistency.pairs ({ operator, ags, a: { sourceId }, b: { sourceId }, idsRekeyed, posMatch, countDiff }):
 * whole: `${Quelle}|${Gemeinde}` → stärkere Quelle (umgeschlüsselt, Positionen ≥ minPos gleich, Zahl ± maxDiff: die schwächere Quelle fällt
 * in dieser Gemeinde ganz weg); known: `${Anbieter}|${a}|${b}` (a < b) → { op, winner, loser } für den räumlichen Abgleich in allen Gemeinden.
 * extra: bekannte Paare aus dem vorigen Lauf ([{ operator, of, source }]), damit kleine Gemeinden ohne Paar nicht zwischen den Läufen flackern.
 */
export function mirrorPairs(pairs, cmp, { extra = [], opts = MIRROR } = {}) {
  const whole = new Map(), known = new Map();
  const add = (op, s1, s2) => { if (!op || !s1 || !s2 || s1 === s2) return null; const [winner, loser] = cmp(s1, s2) <= 0 ? [s1, s2] : [s2, s1]; const k = `${op}|${[s1, s2].sort().join('|')}`; if (!known.has(k)) known.set(k, { op, winner, loser }); return known.get(k); };
  for (const p of pairs || []) {
    if (!p?.idsRekeyed) continue;
    const m = add(p.operator, p.a?.sourceId, p.b?.sourceId); if (!m) continue;
    if ((p.posMatch ?? 0) >= opts.minPos && (p.countDiff ?? 1) <= opts.maxDiff && p.ags) whole.set(`${m.loser}|${p.ags}`, m.winner);
  }
  for (const e of extra || []) add(e?.operator, e?.of, e?.source);
  return { whole, known };
}
/**
 * Fahrzeuge aus Spiegelquellen verwerfen (nach dedupeVehicles): 1. ganze schwächere Quelle je Gemeinde (whole); 2. räumliche Zwillinge
 * (gleicher Anbieter, gleiche Art, verschiedene Quellen, eins zu eins, nächstes Paar zuerst): bekanntes Spiegelpaar ≤ knownM m (Ladestand,
 * wo beide ihn melden, ± energyTol), sonst ≤ twinM m mit gleichem Ladestand (beide gemeldet, unter fullBattery – volle Fahrzeuge stehen oft
 * zu mehreren an einem Ausbringort) und gleicher Reichweite (wo beide sie melden). Die schwächere Quelle (cmp) fällt.
 * Rückgabe { vehicles, dropped: [{ v, of, why: 'whole' | 'twin' }], known }.
 */
export function dropMirrorVehicles(vehicles, { pairs = [], rank = () => [], extra = [], opts = MIRROR } = {}) {
  const cmp = compareSources(rank);
  const { whole, known } = mirrorPairs(pairs, cmp, { extra, opts });
  const dropped = [], rest = [];
  for (const v of vehicles) { const w = whole.get(`${v.sourceId}|${v.ags}`); if (w) dropped.push({ v, of: w, why: 'whole' }); else rest.push(v); }
  const CL = 0.0001, CO = 0.00015; const grid = new Map(); // Zelle ≈ 11 m
  const gk = (v, i, j) => `${v.operator}|${v.type}|${i}:${j}`;
  for (const v of rest) { if (!validLatLon(v.lat, v.lon)) continue; const k = gk(v, Math.floor(v.lat / CL), Math.floor(v.lon / CO)); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(v); }
  const fin = (x) => x != null && Number.isFinite(+x);
  const cands = [];
  for (const v of rest) {
    if (!validLatLon(v.lat, v.lon)) continue;
    const i = Math.floor(v.lat / CL), j = Math.floor(v.lon / CO);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const w of grid.get(gk(v, i + di, j + dj)) || []) {
      if (w === v || !w.sourceId || !v.sourceId || w.sourceId === v.sourceId || cmp(v.sourceId, w.sourceId) > 0) continue; // jedes Paar einmal: v stärker
      const d = haversineM(v.lat, v.lon, w.lat, w.lon);
      const m = known.get(`${v.operator}|${[v.sourceId, w.sourceId].sort().join('|')}`);
      const bothBat = fin(v.batteryPct) && fin(w.batteryPct), bd = bothBat ? Math.abs(v.batteryPct - w.batteryPct) : null;
      let ok;
      if (m) ok = d <= opts.knownM && (bd == null || bd <= opts.energyTol);
      else ok = d <= opts.twinM && bothBat && Math.round(v.batteryPct) === Math.round(w.batteryPct) && v.batteryPct < opts.fullBattery && !(fin(v.rangeKm) && fin(w.rangeKm) && Math.abs(v.rangeKm - w.rangeKm) > 0.1);
      if (ok) cands.push([d + (bd || 0), v, w]);
    }
  }
  cands.sort((x, y) => x[0] - y[0]);
  const gone = new Set(), took = new Map(); // took: stärkeres Fahrzeug → Quellen, aus denen es schon einen Zwilling übernommen hat
  for (const [, v, w] of cands) {
    if (gone.has(w)) continue;
    const t = took.get(v) || new Set(); if (t.has(w.sourceId)) continue;
    t.add(w.sourceId); took.set(v, t); gone.add(w); dropped.push({ v: w, of: v.sourceId, why: 'twin' });
  }
  return { vehicles: rest.filter(v => !gone.has(v)), dropped, known: [...known.values()] };
}

const stationNameKey = (s) => String(s || '').toLowerCase().replace(/ß/g, 'ss').replace(/[äöü]/g, c => ({ ä: 'ae', ö: 'oe', ü: 'ue' }[c])).replace(/[^a-z0-9]+/g, ' ').trim();
// Stationen desselben Anbieters aus mehreren Quellen: gleiche Kennung oder gleicher Name innerhalb 60 m → höchste Quellenpriorität / jüngster Stand gewinnt.
// Namenskandidaten je Anbieter|Name gebündelt (in Ausgabereihenfolge, erster Treffer zählt); ein übernommener Datensatz kann den Namen ändern → umhängen.
export function dedupeStations(stations) {
  const byId = new Map(); const out = []; let dup = 0;
  const byName = new Map(); // `${operator}|${nameKey}` → Stationen aus out, in Ausgabereihenfolge
  const pos = new Map(); // Station → Index in out (für die Reihenfolge beim Umhängen)
  const nameOf = new Map(); // Station → aktueller nameKey
  const link = (s) => { const nk = stationNameKey(s.name); nameOf.set(s, nk); if (!nk) return; const k = `${s.operator}|${nk}`; let l = byName.get(k); if (!l) byName.set(k, l = []); const i = pos.get(s); let j = l.length; while (j > 0 && pos.get(l[j - 1]) > i) j--; l.splice(j, 0, s); };
  const unlink = (s) => { const nk = nameOf.get(s); if (!nk) return; const l = byName.get(`${s.operator}|${nk}`); const i = l ? l.indexOf(s) : -1; if (i >= 0) l.splice(i, 1); };
  const take = (o, s) => { unlink(o); Object.assign(o, s); link(o); }; // Anbieter bleibt gleich (Teil beider Schlüssel), Name/Position können wechseln
  for (const s of stations) {
    const key = `${s.operator}|${s.id}`;
    if (byId.has(key)) { dup++; const prev = byId.get(key); if ((s.priority ?? 2) < (prev.priority ?? 2) || ((s.reportedAt ?? 0) > (prev.reportedAt ?? 0) && (s.priority ?? 2) === (prev.priority ?? 2))) take(prev, s); continue; }
    const nameKey = stationNameKey(s.name);
    let twin = null;
    if (nameKey && validLatLon(s.lat, s.lon)) for (const o of byName.get(`${s.operator}|${nameKey}`) || []) if (validLatLon(o.lat, o.lon) && haversineM(o.lat, o.lon, s.lat, s.lon) <= 60) { twin = o; break; }
    if (twin) { dup++; if ((s.priority ?? 2) < (twin.priority ?? 2)) take(twin, s); continue; }
    byId.set(key, s); pos.set(s, out.length); out.push(s); link(s);
  }
  return { stations: out, duplicates: dup };
}

/**
 * Quellen-Kopien über Stationskoordinaten, unabhängig vom Anbieternamen (CityBikes „DB Connect“ = RegioRad Stuttgart aus MobiData BW):
 * Eine Zählquelle ohne Fahrzeugliste (countOnly) ist Kopie, wenn ≥ minShare ihrer Stationen ≤ radiusM neben Stationen stärkerer Quellen
 * liegen und davon ≥ minNamed (70 %) gleich heißen (Mobilitätsstationen mehrerer Anbieter liegen auch nebeneinander; in NRW heißen bis zu 50 % gleich).
 * Stärke: Quelle mit Fahrzeugliste > bessere Priorität > nicht CityBikes > mehr Stationen > Kennung. Schwächste zuerst; eine erkannte
 * Kopie scheidet für spätere Vergleiche aus. stations: [{ sourceId, lat, lon, name }], sources: [{ id, priority, directories, countOnly }]
 * Rückgabe Map(sourceId → { of, share, named, n }).
 */
export function findSourceCopies(stations, sources, { minStations = 5, radiusM = 30, minShare = 0.8, minNamed = 0.7 } = {}) {
  const bySrc = new Map(); for (const s of stations) { if (!validLatLon(s.lat, s.lon)) continue; if (!bySrc.has(s.sourceId)) bySrc.set(s.sourceId, []); bySrc.get(s.sourceId).push(s); }
  const info = new Map(sources.map(r => [r.id, r]));
  const rank = (id) => { const r = info.get(id) || {}; return [r.countOnly ? 1 : 0, r.priority ?? 2, r.directories?.includes('citybikes') ? 1 : 0, -(bySrc.get(id)?.length || 0)]; };
  const cmp = (a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return a < b ? -1 : a > b ? 1 : 0; }; // < 0: a stärker
  const CL = 0.0005, CO = 0.0008; const gk = (la, lo) => `${Math.floor(la / CL)}:${Math.floor(lo / CO)}`;
  const grid = new Map(); for (const [id, list] of bySrc) for (const s of list) { const k = gk(s.lat, s.lon); if (!grid.has(k)) grid.set(k, []); grid.get(k).push([id, s.lat, s.lon, stationNameKey(s.name)]); }
  const out = new Map();
  const cands = [...bySrc.keys()].filter(id => info.get(id)?.countOnly && bySrc.get(id).length >= minStations).sort((a, b) => cmp(b, a)); // schwächste zuerst
  for (const w of cands) {
    const list = bySrc.get(w); let matched = 0, named = 0; const per = new Map();
    for (const s of list) {
      const [gi, gj] = gk(s.lat, s.lon).split(':').map(Number); const nk = stationNameKey(s.name); let hit = null, same = false;
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const [oid, la, lo, onk] of grid.get(`${gi + di}:${gj + dj}`) || []) {
        if (oid === w || out.has(oid) || cmp(oid, w) >= 0 || haversineM(s.lat, s.lon, la, lo) > radiusM) continue;
        if (!hit) hit = oid; if (nk && onk === nk && !same) { same = true; hit = oid; }
      }
      if (!hit) continue;
      matched++; if (same) named++; per.set(hit, (per.get(hit) || 0) + 1);
    }
    const share = matched / list.length;
    if (share < minShare || !matched || named / matched < minNamed) continue;
    const of = [...per].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0][0];
    out.set(w, { of, share: +share.toFixed(3), named: +(named / matched).toFixed(3), n: list.length });
  }
  return out;
}

// ---------- Aggregation ----------
export function emptyStats() {
  return { total: 0, available: 0, reserved: 0, disabled: 0, batteryKnown: 0, lowBattery: 0, rangeKnown: 0, lowRange: 0, stationVehicles: 0, geoStation: 0, posStale: 0,
    stations: 0, stationsInstalled: 0, stationsRenting: 0, stationsEmpty: 0, stationsFull: 0, stationPhysical: 0, stationBookable: 0, stationDocks: 0,
    stationsEmptyReported: 0, stationsEmptyNearby: 0, stationsEmptyOtherNearby: 0,
    stationsVirtual: 0, stationsEmptyVirtual: 0, stationsEmptyDock: 0, stationDocksBad: 0 }; // virtuelle Stationen (Abstellzonen) getrennt: leer ohne Fahrzeug ≠ leere Dockstation
}
export function addVehicle(st, v, { chargeThreshold = 20, rangeThreshold = 5 } = {}) {
  st.total++;
  if (!v.reserved && !v.disabled) st.available++;
  if (v.reserved) st.reserved++;
  if (v.disabled) st.disabled++;
  if (v.batteryPct != null) { st.batteryKnown++; if (v.batteryPct < chargeThreshold) st.lowBattery++; }
  if (v.rangeKm != null) { st.rangeKnown++; if (v.rangeKm < rangeLowKm(v.type, rangeThreshold)) st.lowRange++; }
  if (v.geoOrigin === 'station') st.geoStation++;
  if (v.positionAgeMs != null && v.positionAgeMs > DELAYED_MS) st.posStale++;
}
export const DOCKS_MAX = 500; // mehr freie Plätze an einer Station gibt es nicht (größte Dockstationen ≈ 100)
export function addStation(st, s, countVehicles) {
  st.stations++;
  if (s.installed !== false) st.stationsInstalled++;
  if (s.installed !== false && s.renting !== false) st.stationsRenting++;
  const phys = s.physicalAvailable ?? 0;
  st.stationPhysical += phys; st.stationBookable += s.bookable ?? 0;
  // Audit UXM-13: Platzhalter wie 999.999 freie Plätze (unbegrenzte Rückgabe) nicht summieren; über der Kapazität oder > DOCKS_MAX = unplausibel
  const dk = s.docksAvailable; if (dk > 0 && (dk > DOCKS_MAX || (s.capacity > 0 && dk > s.capacity + 2))) st.stationDocksBad = (st.stationDocksBad || 0) + 1; else st.stationDocks += dk ?? 0;
  if (s.isVirtual === true) st.stationsVirtual++;
  if (s.installed !== false && s.renting !== false && (s.bookable ?? 0) === 0) {
    // als leer gemeldet – aber stehen frei abgestellte Fahrzeuge desselben Anbieters direkt daneben, ist die Station faktisch versorgt
    st.stationsEmptyReported++;
    if (s.nearbyVehicles > 0) st.stationsEmptyNearby++; else { st.stationsEmpty++; if (s.nearbyOther > 0) st.stationsEmptyOtherNearby++; if (s.isVirtual === true) st.stationsEmptyVirtual++; else st.stationsEmptyDock++; }
  }
  if (s.installed !== false && s.returning !== false && s.docksAvailable === 0) st.stationsFull++;
  if (countVehicles) { st.stationVehicles += phys; st.total += phys; st.available += s.bookable ?? 0; if (s.disabled) st.disabled += s.disabled; }
}
export const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

// Anbieter aus Namen/Kennungen ableiten (längster Alias gewinnt)
export function operatorFromName(text, aliases) {
  const hay = String(text || '').toLowerCase();
  const keys = Object.keys(aliases || {}).sort((a, b) => b.length - a.length);
  for (const k of keys) if (hay.includes(k)) return aliases[k];
  return null;
}

// Gemeinde × Anbieter × Fahrzeugart aggregieren (Fahrzeuge bereits dedupliziert, mit .ags/.operator/.type;
// Stationen mit .ags/.operator/.perType/.typeHint/.hasVehicleList)
export const STATION_NEAR_M = 50; // Umkreis, in dem frei abgestellte Fahrzeuge einer Station zugerechnet werden
/** Zählt je Station verfügbare Fahrzeuge desselben Anbieters im Umkreis (setzt station.nearbyVehicles). */
export function countNearbyVehicles(vehicles, stations, radiusM = STATION_NEAR_M) {
  // Raster ohne Anbieter: zählt eigene (nearbyVehicles) und fremde Fahrzeuge (nearbyOther, Marktsicht)
  const CL = 0.0005, CO = 0.0008; const grid = new Map();
  for (const v of vehicles) { if (v.disabled || v.reserved || !Number.isFinite(v.lat)) continue; const k = `${Math.floor(v.lat / CL)}|${Math.floor(v.lon / CO)}`; (grid.get(k) || grid.set(k, []).get(k)).push(v); }
  for (const s of stations) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
    const i = Math.floor(s.lat / CL), j = Math.floor(s.lon / CO); let own = 0, other = 0; const otherOps = new Set();
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const v of grid.get(`${i + di}|${j + dj}`) || []) {
      if (haversineM(s.lat, s.lon, v.lat, v.lon) > radiusM) continue;
      if (v.operator === s.operator) own++; else { other++; otherOps.add(v.operator); }
    }
    s.nearbyVehicles = own; s.nearbyOther = other; s.nearbyOtherOps = [...otherOps];
  }
  return stations;
}
export function aggregateGroups(vehicles, stations, { chargeThreshold = 20, rangeThreshold = 5 } = {}) {
  countNearbyVehicles(vehicles, stations);
  const groups = new Map();
  const g = (key) => { if (!groups.has(key)) groups.set(key, emptyStats()); return groups.get(key); };
  for (const v of vehicles) addVehicle(g(`${v.ags}|${v.operator}|${v.type}`), v, { chargeThreshold, rangeThreshold });
  for (const s of stations) {
    const types = s.perType ? Object.keys(s.perType) : [s.typeHint || 'unknown'];
    const countVehicles = !s.hasVehicleList;
    if (s.perType && countVehicles) {
      for (const [ty, n] of Object.entries(s.perType)) { const st = g(`${s.ags}|${s.operator}|${ty}`); st.total += n; st.available += s.renting !== false && s.installed !== false ? n : 0; st.stationVehicles += n; }
      const main = types.slice().sort((a, b) => s.perType[b] - s.perType[a])[0];
      addStation(g(`${s.ags}|${s.operator}|${main}`), s, false);
    } else addStation(g(`${s.ags}|${s.operator}|${types[0]}`), s, countVehicles);
  }
  return groups;
}
export function sumStats(list) {
  const out = emptyStats();
  for (const st of list) for (const f of Object.keys(out)) out[f] += st[f] || 0;
  return out;
}
