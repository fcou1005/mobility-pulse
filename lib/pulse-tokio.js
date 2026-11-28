// Mobility Pulse — Tokio im Reiter „Vergleich“ (28.11.2026): stationsgebundene Leihräder als Gegenbild zu den deutschen Städten.
// Quellen: die offenen GBFS-Feeds der ODPT (Public Transportation Open Data Center, api-public.odpt.org, ohne Schlüssel):
//   docomo bike share (System docomo-cycle-tokyo, Lizenz im Feed: CC BY 4.0) und HELLO CYCLING (ganz Japan, Lizenz wahlweise
//   CC BY 4.0, ODC-BY 1.0 oder ODbL 1.0; hier CC BY 4.0). LUUP (E-Scooter, frei abstellbar an Ports) veröffentlicht keinen offenen Feed.
// Reine Rechenlogik für den Sammler (scripts/collect/30-tokio.mjs) und die Seite (web/tokio.js); Zeiten in Ortszeit Tokio (JST, UTC+9, ohne Sommerzeit).
// Fahrten sind nicht im Feed: Abgänge/Zugänge sind die Summe der Bestandsänderungen je Port zwischen zwei Läufen (rund 20 Minuten),
// also eine Untergrenze (Ausleihe und Rückgabe am selben Port dazwischen heben sich auf; Umsetzungen der Betreiber zählen mit).

export const TOKIO = Object.freeze({
  version: 1,
  tz: 'Asia/Tokyo', offsetH: 9,
  base: 'https://api-public.odpt.org/api/v4/gbfs',
  infoEveryH: 20, // station_information neu lesen (HELLO CYCLING rund 8 MB)
  keepDays: 14, // Tagesdateien tokio/<Tag>.json
  maxGapMin: 40, // längere Lücke zwischen zwei Läufen: keine Abgänge/Zugänge zählen
  bbox: Object.freeze([35.48, 138.9, 35.92, 139.95]), // [Süd, West, Nord, Ost]: Festland der Präfektur Tokio, grob (Plausibilität der Koordinaten)
  systems: Object.freeze([
    Object.freeze({ id: 'docomo', feed: 'docomo-cycle-tokyo', name: 'docomo bike share', operator: 'Docomo Bike Share, Inc.', url: 'https://docomo-cycle.jp/', license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', tokyo: 'system' }),
    Object.freeze({ id: 'hello', feed: 'hellocycling', name: 'HELLO CYCLING', operator: 'OpenStreet Corp.', url: 'https://www.hellocycling.jp', license: 'CC BY 4.0', licenseUrl: 'https://d1yl7kw204zjxn.cloudfront.net/gbfs/v2/public/hellocycling_gbfs_licence.txt', tokyo: 'address' }),
  ]),
});
export const STATION_FIELDS = Object.freeze(['sys', 'id', 'lat', 'lon', 'plaetze', 'name']);
export const STAND_FIELDS = Object.freeze(['sys', 'id', 'raeder', 'frei', 'zustand']); // zustand: Bit 1 keine Ausleihe, Bit 2 keine Rückgabe
export const HOUR_FIELDS = Object.freeze(['stunde', 'laeufe', 'raeder', 'ports', 'leer', 'voll', 'ab', 'an', 'minuten']); // Summen über die Läufe der Stunde

const r5 = (/** @type {number} */ x) => Math.round(x * 1e5) / 1e5;
/** Ortszeit Tokio: Tag JJJJ-MM-TT @param {number} ms */
export const jstDay = (ms) => new Date(ms + TOKIO.offsetH * 3600e3).toISOString().slice(0, 10);
/** Ortszeit Tokio: Stunde 0–23 @param {number} ms */
export const jstHour = (ms) => new Date(ms + TOKIO.offsetH * 3600e3).getUTCHours();

/**
 * Ports eines Systems in Tokio aus station_information.data.stations
 * @param {{ tokyo: string }} sys @param {any[]} list
 * @returns {Array<[string, number, number, number|null, string]>} [id, lat, lon, Plätze, Name]
 */
export function tokyoStations(sys, list) {
  const [s, w, n, e] = TOKIO.bbox, out = [];
  for (const x of Array.isArray(list) ? list : []) {
    const id = x?.station_id == null ? '' : String(x.station_id), lat = +x?.lat, lon = +x?.lon;
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lon) || lat < s || lat > n || lon < w || lon > e) continue;
    if (sys.tokyo === 'address' && !/^\s*東京都/.test(String(x.address || ''))) continue; // HELLO CYCLING: ganz Japan, Adresse nennt die Präfektur
    const cap = Number.isFinite(+x.capacity) && +x.capacity > 0 ? +x.capacity : Number.isFinite(+x.vehicle_capacity) && +x.vehicle_capacity > 0 ? +x.vehicle_capacity : null;
    out.push(/** @type {[string, number, number, number|null, string]} */ ([id, r5(lat), r5(lon), cap, String(x.name || '').replace(/\s+/g, ' ').trim().slice(0, 60)]));
  }
  return out;
}

/**
 * Stand je Port aus station_status.data.stations, nur Ports aus known
 * @param {string} sysId @param {any[]} list @param {Set<string>} known
 * @returns {Array<[string, string, number, number, number]>} [sys, id, Räder, freie Plätze, Zustand]
 */
export function standRows(sysId, list, known) {
  const out = [];
  for (const x of Array.isArray(list) ? list : []) {
    const id = x?.station_id == null ? '' : String(x.station_id); if (!known.has(id)) continue;
    const b = Math.max(0, Math.round(+x.num_bikes_available || 0)), d = Math.max(0, Math.round(+x.num_docks_available || 0)), inst = x.is_installed !== false;
    const z = (inst && x.is_renting !== false ? 0 : 1) | (inst && x.is_returning !== false ? 0 : 2);
    out.push(/** @type {[string, string, number, number, number]} */ ([sysId, id, b, d, z]));
  }
  return out;
}

/**
 * Kennzahlen je System aus dem Stand: Ports, Räder, freie Plätze, leer (ausleihbar, kein Rad), voll (Rückgabe möglich, kein Platz), außer Betrieb
 * @param {Array<any[]>} rows STAND_FIELDS
 * @returns {Record<string, { ports: number, bikes: number, docks: number, empty: number, full: number, off: number }>}
 */
export function summarize(rows) {
  /** @type {Record<string, { ports: number, bikes: number, docks: number, empty: number, full: number, off: number }>} */
  const o = {};
  for (const [sys, , b, d, z] of rows || []) {
    const a = o[sys] || (o[sys] = { ports: 0, bikes: 0, docks: 0, empty: 0, full: 0, off: 0 });
    a.ports++; a.bikes += b; a.docks += d;
    if (z & 1) a.off++; else if (b === 0) a.empty++;
    if (!(z & 2) && d === 0) a.full++;
  }
  return o;
}

/**
 * Abgänge und Zugänge je System zwischen zwei Ständen (Summe der Änderungen je Port, der in beiden vorkommt)
 * @param {Array<any[]>} prev @param {Array<any[]>} cur
 * @returns {Record<string, { out: number, in: number, n: number }>}
 */
export function moves(prev, cur) {
  const p = new Map((prev || []).map(r => [`${r[0]}|${r[1]}`, +r[2]]));
  /** @type {Record<string, { out: number, in: number, n: number }>} */
  const o = {};
  for (const [sys, id, b] of cur || []) {
    const was = p.get(`${sys}|${id}`); if (was == null || !Number.isFinite(was)) continue;
    const a = o[sys] || (o[sys] = { out: 0, in: 0, n: 0 });
    a.n++; if (b < was) a.out += was - b; else a.in += b - was;
  }
  return o;
}

/**
 * Lauf in die Stunde eines Tages eintragen (Tagesdatei: sys → Zeilen HOUR_FIELDS, nach Stunde sortiert)
 * @param {{ sys: Record<string, number[][]> }} day @param {string} sysId @param {number} h
 * @param {{ bikes: number, ports: number, empty: number, full: number, out?: number, in?: number, min?: number }} v
 */
export function addHour(day, sysId, h, v) {
  const rows = day.sys[sysId] || (day.sys[sysId] = []);
  let r = rows.find(x => x[0] === h);
  if (!r) { r = [h, 0, 0, 0, 0, 0, 0, 0, 0]; rows.push(r); rows.sort((a, b) => a[0] - b[0]); }
  r[1]++; r[2] += v.bikes; r[3] += v.ports; r[4] += v.empty; r[5] += v.full; r[6] += v.out || 0; r[7] += v.in || 0; r[8] += v.min || 0;
  return day;
}

/**
 * Stunden eines Systems für Diagramm und Tabelle: Mittel der Räder, Anteil leerer/voller Ports, Abgänge je Stunde (hochgerechnet auf 60 Minuten)
 * @param {any} day Tagesdatei @param {string} sysId
 * @returns {Array<{ h: number, runs: number, bikes: number, empty: number, full: number, outH: number|null, out: number, in: number, min: number }>}
 */
export function hourly(day, sysId) {
  return (day?.sys?.[sysId] || []).filter((/** @type {number[]} */ r) => r[1] > 0).map((/** @type {number[]} */ r) => ({
    h: r[0], runs: r[1], bikes: r[2] / r[1], empty: r[3] ? r[4] / r[3] : 0, full: r[3] ? r[5] / r[3] : 0,
    outH: r[8] >= 10 ? r[6] / r[8] * 60 : null, out: r[6], in: r[7], min: r[8],
  }));
}

/** Summen eines Tages je System: Abgänge, Zugänge, Minuten mit Vergleich @param {any} day @param {string} sysId */
export function dayTotals(day, sysId) {
  let out = 0, inn = 0, min = 0;
  for (const r of day?.sys?.[sysId] || []) { out += r[6]; inn += r[7]; min += r[8]; }
  return { out, in: inn, min };
}
