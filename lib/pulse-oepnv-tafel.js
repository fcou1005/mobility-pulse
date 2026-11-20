// @ts-check
// Mobility Pulse — Abfahrtstafel, Suche und Sharing entlang einer Linie (18.11.2026, F29/F35) aus der Live-Datei oepnv/live/<AGS>.json
// (Format 1.6: trips [linie, art, verspaetung_s, weg [lat, lon, dt …], ausgefallene_halte, ziel, halte (Index in names)], names, at).
// Reine Funktionen für Browser und Tests; die Zeiten im Weg enthalten die gemeldete Verspätung.

const M_LAT = 111320;
const distM = (/** @type {number} */ a, /** @type {number} */ b, /** @type {number} */ c, /** @type {number} */ d) => { const dy = (c - a) * M_LAT, dx = (d - b) * M_LAT * Math.cos(((a + c) / 2) * Math.PI / 180); return Math.sqrt(dx * dx + dy * dy); };
export const TAFEL = Object.freeze({ max: 12, backSec: 60, radiusM: 300, lowAt: 1 });

/**
 * Stationen und Linien der Live-Datei für die Suche: stations [{ name, lat, lon, n }] (n = Halte im Fenster), lines [{ name, art, n }] (n = Fahrten),
 * beide nach Häufigkeit absteigend.
 * @param {any} live
 */
export function searchIndex(live) {
  const names = live?.names || [], st = new Map(), ln = new Map();
  for (const r of live?.trips || []) {
    const w = r[3] || [], hix = r[6] || [];
    for (let i = 0; i < hix.length; i++) { const nm = names[hix[i]]; if (nm == null) continue; let e = st.get(nm); if (!e) st.set(nm, e = { name: nm, lat: w[3 * i], lon: w[3 * i + 1], n: 0 }); e.n++; }
    if (r[0]) { const k = `${r[0]}|${r[1]}`; let e = ln.get(k); if (!e) ln.set(k, e = { name: r[0], art: r[1], n: 0 }); e.n++; }
  }
  const by = (/** @type {any} */ a, /** @type {any} */ b) => b.n - a.n || String(a.name).localeCompare(String(b.name), 'de');
  return { stations: [...st.values()].sort(by), lines: [...ln.values()].sort(by) };
}

/**
 * Nächste Abfahrten an einer Station (Name wie in names): [{ at (ms), linie, art, ziel, verspaetung_s, endet, plan }], nach Zeit, höchstens max;
 * plan = Fahrt ohne Echtzeit, Zeit laut Fahrplan (Format 1.9).
 * Halte am Ende einer Fahrt (Ziel = Station) zählen als Ankunft (endet = true) und stehen hinten.
 * @param {any} live @param {string} station @param {number} now
 */
export function departures(live, station, now, { max = TAFEL.max, backSec = TAFEL.backSec } = {}) {
  const names = live?.names || [], at = live?.at || 0, out = [];
  for (const r of live?.trips || []) {
    const w = r[3] || [], hix = r[6] || [], n = w.length / 3;
    for (let i = 0; i < hix.length && i < n; i++) {
      if (names[hix[i]] !== station) continue;
      const t = at + w[3 * i + 2] * 1000; if (t < now - backSec * 1000) continue;
      out.push({ at: t, linie: r[0] || null, art: r[1], ziel: r[5] || null, verspaetung_s: r[2] ?? null, endet: i === n - 1, plan: r[7] === 'fahrplan' });
    }
  }
  return out.sort((a, b) => Number(a.endet) - Number(b.endet) || a.at - b.at).slice(0, max);
}

/**
 * Stationen entlang einer Linie (aus allen Fahrten dieser Linie im Fenster, in der Reihenfolge der längsten Fahrt) mit verfügbaren
 * Sharing-Fahrzeugen im Umkreis: [{ name, lat, lon, vehicles, low }]; low = höchstens lowAt Fahrzeuge (dort fehlt Ersatz, wenn die Linie ausfällt).
 * Ganz ausgefallene Fahrten (ausfall.rows: [linie, art, weg, ziel]) zählen mit, damit eine ausgefallene Linie ihre Stationen behält.
 * @param {any} live @param {string} line @param {Array<{ lat: number, lon: number }>} vehicles
 */
export function alongLine(live, line, vehicles, { radiusM = TAFEL.radiusM, lowAt = TAFEL.lowAt } = {}) {
  const names = live?.names || [], seq = /** @type {Array<{ name: string|null, lat: number, lon: number }>} */ ([]);
  /** @type {Array<Array<{ name: string|null, lat: number, lon: number }>>} */ const runs = [];
  for (const r of live?.trips || []) if (r[0] === line) { const w = r[3] || [], hix = r[6] || []; runs.push(Array.from({ length: w.length / 3 }, (_, i) => ({ name: names[hix[i]] ?? null, lat: w[3 * i], lon: w[3 * i + 1] }))); }
  for (const r of live?.ausfall?.rows || []) if (r[0] === line && r[2]) { const w = r[2]; runs.push(Array.from({ length: w.length / 3 }, (_, i) => ({ name: null, lat: w[3 * i], lon: w[3 * i + 1] }))); }
  runs.sort((a, b) => b.length - a.length);
  for (const run of runs) for (const p of run) if (!seq.some(q => distM(q.lat, q.lon, p.lat, p.lon) < 60)) seq.push(p);
  return seq.map(p => {
    const n = (vehicles || []).filter(v => Math.abs(v.lat - p.lat) < 0.004 && distM(p.lat, p.lon, v.lat, v.lon) <= radiusM).length;
    return { ...p, vehicles: n, low: n <= lowAt };
  });
}

/**
 * Linien der Gemeinde mit Ausfällen heute (Zeilen nach LINE_FIELDS aus oepnv/<AGS>.json): [{ linie, art, halte, share }], share = ausgefallen
 * heute ÷ Halte heute, ab minStops Halten, absteigend; für die Schnellwahl „Linie ausgefallen?“.
 * @param {any[][]} rows
 */
export function cancelledLines(rows, { minStops = 20, minShare = 0.1, top = 6 } = {}) {
  return (rows || []).map(r => ({ linie: r[0], art: r[1], halte: r[6] || 0, share: r[6] ? (r[7] || 0) / r[6] : 0 }))
    .filter(x => x.linie && x.halte >= minStops && x.share >= minShare).sort((a, b) => b.share - a.share || b.halte - a.halte).slice(0, top);
}

/**
 * Sharing-Fahrzeuge direkt an Haltestellen (F30, für Städte): je Station die verfügbaren Fahrzeuge bis radiusM um die Stationsmitte
 * (gebündelte Haltestelle aus dem Fahrplan; Bahnsteige liegen bei großen Stationen weiter auseinander, deshalb nur ein Hinweis).
 * stations [{ name, lat, lon }] (doppelte Namen am selben Ort zählen einmal); Rückgabe { rows: [{ name, lat, lon, n, ops: { Anbieter: n } }], total, stations }.
 * @param {Array<{ name: string, lat: number, lon: number }>} stations @param {Array<{ lat: number, lon: number, operator?: string, type?: string }>} vehicles
 */
export function atStops(stations, vehicles, { radiusM = 15, top = 15, types = ['scooter', 'ebike', 'bike', 'cargo', 'moped'] } = {}) {
  const seen = [], rows = []; let total = 0;
  const veh = (vehicles || []).filter(v => Number.isFinite(v.lat) && (!v.type || types.includes(v.type)));
  for (const s of stations || []) {
    if (!Number.isFinite(s.lat) || seen.some(q => q.name === s.name && distM(q.lat, q.lon, s.lat, s.lon) < 50)) continue; seen.push(s);
    const near = veh.filter(v => Math.abs(v.lat - s.lat) < 0.0005 && distM(s.lat, s.lon, v.lat, v.lon) <= radiusM); if (!near.length) continue;
    /** @type {Record<string, number>} */ const ops = {}; for (const v of near) ops[v.operator || '?'] = (ops[v.operator || '?'] || 0) + 1;
    rows.push({ name: s.name, lat: s.lat, lon: s.lon, n: near.length, ops }); total += near.length;
  }
  rows.sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'de'));
  return { rows: rows.slice(0, top), total, stations: rows.length };
}
