// @ts-check
// Mobility Pulse – Reiter ÖPNV, Teil für den Browser (ohne die großen Sammler-Module): Kennwerte, Lage eines Fahrzeugs auf seinem Weg und
// Vorschläge für Sharing-Stationen. Der Sammler-Teil steht in lib/pulse-oepnv-netz.js und gibt alles von hier weiter.
import { distM } from './pulse-geo-proj.js';

export const NETZ = Object.freeze({ version: 2, blockH: 1, closeAfterH: 3, halfLifeDays: 7, top: 300, aheadMin: 70, maxTrips: 1500, maxPts: 24, waitSec: 120,
  minHourN: 20, minFlagDays: 3, fromHour: 6, toHour: 22, minForecast: 5, hubRadiusM: 150, hubNearM: 50, hubMinPerDay: 30, hubTop: 20, hubW: { pt: 0.4, stoer: 0.3, nachfrage: 0.3 } });
export const NETZ_LICENSE = 'CC BY-SA 4.0', NETZ_ATTRIBUTION = 'Echtzeit: gtfs.de (DELFI e. V. u. a.), CC BY-SA 4.0; Fahrplan und Haltestellen: gtfs.de, CC BY 4.0';

/** Art einer Linie aus dem GTFS-route_type (auch erweiterte Typen): 'bus' | 'tram' | 'bahn' | 'sonst' */
export function typeClass(/** @type {number | null | undefined} */ rt) {
  if (rt == null || !Number.isFinite(rt)) return 'sonst';
  if (rt === 3 || (rt >= 700 && rt < 800) || rt === 11 || (rt >= 200 && rt < 300)) return 'bus';
  if (rt === 0 || rt === 5 || (rt >= 900 && rt < 1000)) return 'tram';
  if (rt === 1 || rt === 2 || rt === 12 || (rt >= 100 && rt < 200) || (rt >= 400 && rt < 700)) return 'bahn';
  return 'sonst';
}

const r1 = (/** @type {number} */ x) => Math.round(x * 10) / 10, r3 = (/** @type {number} */ x) => Math.round(x * 1000) / 1000;

// ---------- geschätzte Fahrzeugwege ----------
export const LIVE_FIELDS = ['linie', 'art', 'verspaetung_s', 'weg', 'ausgefallene_halte', 'ziel', 'halte', 'quelle']; // ausgefallene_halte (Format 1.5), ziel und halte (Index in names je Punkt des Wegs, 1.6), quelle 'echtzeit' | 'fahrplan' (1.9)
export const MODES = ['bus', 'tram', 'ubahn', 'sbahn', 'regio', 'fern', 'sonst'];
/**
 * Verkehrsmittel aus route_type und Linienname (seit Format 1.2): 'bus' | 'tram' | 'ubahn' (U- und Stadtbahn) | 'sbahn' | 'regio' | 'fern' | 'sonst'.
 * Der Name entscheidet, wo route_type nur „Bahn“ sagt: ICE/IC/EC … = fern, S1 = sbahn, U6 = ubahn, RE/RB/MEX … = regio.
 */
/** @param {number | null | undefined} rt @param {string | null | undefined} [name] */
export function modeClass(rt, name) {
  const base = typeClass(rt), n = String(name || '').trim().toUpperCase();
  if (base === 'bus') return 'bus';
  if (rt === 101 || rt === 102 || /^(ICE|IC|EC|ECE|RJX?|TGV|NJ|EN|FLX|THA|EST)\s?\d/.test(n)) return 'fern';
  if (rt === 109 || /^S\s?\d/.test(n)) return 'sbahn';
  if (rt === 1 || (rt != null && rt >= 400 && rt < 500) || /^U\s?\d/.test(n)) return 'ubahn';
  if (base === 'tram') return 'tram';
  if (base === 'bahn') return 'regio';
  return /^(RE|RB|IRE|MEX|RS)\s?\d/.test(n) ? 'regio' : 'sonst';
}
/**
 * Linienwege aus den Fahrzeugwegen: jede Verbindung Station → Station einmal je Verkehrsmittel (Luftlinie), mit den Linien, die sie befahren.
 * trips: Zeilen [linie, art, verspaetung_s, [lat, lon, dt, …]]. Rückgabe Map art → [{ a: [lat, lon], b: [lat, lon], lines: string[] }]
 */
/** @param {any[][]} trips */
export function segmentsOf(trips) {
  /** @type {Map<string, Map<string, { a: number[], b: number[], lines: string[] }>>} */ const by = new Map();
  for (const [line, art, , w] of trips || []) {
    let m = by.get(art); if (!m) by.set(art, m = new Map());
    for (let i = 3; i + 2 < w.length; i += 3) {
      const a = [w[i - 3], w[i - 2]], b = [w[i], w[i + 1]]; if (a[0] === b[0] && a[1] === b[1]) continue;
      const fwd = a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]), k = fwd ? `${a}|${b}` : `${b}|${a}`; let s = m.get(k);
      if (!s) m.set(k, s = { a: fwd ? a : b, b: fwd ? b : a, lines: [] }); if (line && !s.lines.includes(line) && s.lines.length < 12) s.lines.push(line);
    }
  }
  return new Map([...by].map(([k, m]) => [k, [...m.values()]]));
}
/** Lage auf einem Weg [lat, lon, dt, …] zum Zeitpunkt dt Sekunden nach dem Stand: [lat, lon] oder null (noch nicht losgefahren, schon angekommen) */
/** @param {number[]} w @param {number} dt @param {number} [waitSec] */
export function positionAt(w, dt, waitSec = NETZ.waitSec) {
  const n = w.length / 3; if (n < 1) return null;
  if (dt < w[2]) return w[2] - dt <= waitSec ? [w[0], w[1]] : null;
  for (let i = 1; i < n; i++) { const t0 = w[3 * i - 1], t1 = w[3 * i + 2]; if (dt <= t1) { const f = t1 > t0 ? (dt - t0) / (t1 - t0) : 1; return [w[3 * i - 3] + (w[3 * i] - w[3 * i - 3]) * f, w[3 * i - 2] + (w[3 * i + 1] - w[3 * i - 2]) * f]; } }
  return null;
}

// ---------- Jetzt gestört: Sharing-Fahrzeuge im Umfeld ----------
/**
 * Gestörte Stationen (JETZT_FIELDS-Zeilen) mit den verfügbaren Sharing-Fahrzeugen im Umkreis: level 'none' (kein Fahrzeug), 'few' (1 bis few),
 * 'ok'. Sortiert: ohne Fahrzeug zuerst, dann nach gestörten Halten. vehicles: [{ lat, lon }] verfügbar jetzt, null = Bestand unbekannt.
 */
/** @param {any[][]} rows @param {Array<{ lat: number, lon: number }> | null} vehicles @param {any} [opts] */
export function hotspotHints(rows, vehicles, { radius = 300, few = 2, keep = null } = {}) {
  const out = (rows || []).map(r => {
    let veh = null; if (vehicles) { veh = 0; for (const v of vehicles) if (Math.abs(v.lat - r[2]) < 0.004 && distM(r[2], r[3], v.lat, v.lon) <= radius) veh++; }
    // außerhalb des Geschäftsgebiets (19.11.2026): Station bleibt in der Liste, ist aber kein Bedarf an Sharing-Fahrzeugen
    const out = keep && !keep(r[0]);
    return { id: r[0], name: r[1], lat: r[2], lon: r[3], n: r[4], skip: r[5], late: r[6], bad: r[5] + r[6], vehicles: veh, level: out ? 'out' : veh == null ? 'unknown' : veh === 0 ? 'none' : veh <= few ? 'few' : 'ok' };
  });
  const rank = { none: 0, few: 1, unknown: 2, ok: 3, out: 4 };
  return out.sort((a, b) => rank[/** @type {'none'} */ (a.level)] - rank[/** @type {'none'} */ (b.level)] || b.bad - a.bad || b.n - a.n);
}

// ---------- Vorschläge für Sharing-Stationen ----------
/**
 * Stationen (STATION_FIELDS-Zeilen) nach Eignung für eine Sharing-Station: viel ÖPNV (Halte je Tag), oft gestört (ausgefallen oder verspätet), Sharing
 * wird dort schon nachgefragt (Fahrtenden in radius). Stationen mit vorhandener Abstellfläche in nearM stehen als vorhanden in der Liste, zählen
 * aber nicht als Vorschlag. demand: [[lat, lon, n]] (50-m-Zellen), vehicles: [{ lat, lon }] verfügbar jetzt, existing: [[lat, lon, Halbmesser]].
 * Rückgabe { rows: [{ id, name, lat, lon, perDay, stoer, ends, vehicles, has, score, parts }], candidates, withArea }
 */
/** @param {any[][]} rows @param {any} [opts] */
export function hubCandidates(rows, { days = 1, demand = [], vehicles = [], existing = [], radius = NETZ.hubRadiusM, nearM = NETZ.hubNearM, minPerDay = NETZ.hubMinPerDay, top = NETZ.hubTop } = {}) {
  const list = [];
  for (const r of rows || []) {
    const perDay = r[4] / Math.max(0.25, days); if (!(perDay >= minPerDay)) continue;
    let ends = 0; for (const d of demand) if (Math.abs(d[0] - r[2]) < 0.003 && distM(r[2], r[3], d[0], d[1]) <= radius) ends += d[2];
    let veh = 0; for (const v of vehicles) if (Math.abs(v.lat - r[2]) < 0.003 && distM(r[2], r[3], v.lat, v.lon) <= radius) veh++;
    const has = existing.some((/** @type {number[]} */ e) => Math.abs(e[0] - r[2]) < 0.004 && distM(r[2], r[3], e[0], e[1]) <= nearM + (e[2] || 0));
    list.push({ id: r[0], name: r[1], lat: r[2], lon: r[3], perDay: r1(perDay), stoer: r[4] > 0 ? r3((r[5] + r[6]) / r[4]) : 0, ends, vehicles: veh, has, score: 0, parts: /** @type {any} */ (null) });
  }
  const z = (/** @type {number[]} */ v) => { const m = v.reduce((s, x) => s + x, 0) / (v.length || 1), sd = Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, v.length - 1)) || 1; return (/** @type {number} */ x) => (x - m) / sd; };
  const zp = z(list.map(x => Math.log(1 + x.perDay))), zs = z(list.map(x => x.stoer)), zn = z(list.map(x => Math.log(1 + x.ends))), W = NETZ.hubW;
  for (const x of list) { x.parts = { pt: r3(W.pt * zp(Math.log(1 + x.perDay))), stoer: r3(W.stoer * zs(x.stoer)), nachfrage: r3(W.nachfrage * zn(Math.log(1 + x.ends))) }; x.score = r3(x.parts.pt + x.parts.stoer + x.parts.nachfrage); }
  const cand = list.filter(x => !x.has).sort((a, b) => b.score - a.score || b.perDay - a.perDay);
  return { rows: cand.slice(0, top), candidates: cand.length, withArea: list.length - cand.length, stations: list.length };
}
