// Mobility Pulse — Anbieter-Vergleich in einer Gemeinde: Bestand, Zustand, Stationen/Spots, belegte Zellen, einzigartig gegen geteilt.
// Reine Rechenfunktionen ohne DOM (Browser und Node). Grundlage: ops/<Land>.json, dekodiert mit pulse-ops.js decodeFleet
// ({ vehicles: [{ lat, lon, operator, type, reserved, disabled, battery, rangeKm, idleMin, ags }], stations: [{ lat, lon, operator, name, bookable, docks, capacity, ags, physical, virtual }] }).
// physical ist der physische Bestand an der Station (physicalAvailable, Fahrzeuge), kein Merkmal der Station; virtuell/physisch: isVirtualStation.
import { CELL_LAT, CELL_LON } from './pulse-track.js?v=mw7r00jn';
import { energyLow, RANGE_ONLY_OPS } from './pulse-report.js?v=mw7r00jn';

export const RADII = [25, 50, 100];          // Meter: Station gilt als geteilt, wenn eine Station eines anderen Anbieters so nah liegt
export const DEFAULT_RADIUS = 50;
export const LOW_BATTERY = 20, LOW_RANGE_KM = 5; // wie im Dashboard (Ladestand unter 20 % bzw. Reichweite unter 5 km)
const RANGE_ONLY = new Set(RANGE_ONLY_OPS);
/**
 * Energie niedrig je Fahrzeug, dieselbe Regel wie Dashboard und Disposition (lib/pulse-report.js energyLow): Ladestand < 20 % UND Reichweite
 * < 5 km, wo beides gemeldet ist; Reichweite aus dem Ladestand gerechnet (v.rangeDerived, ops-Feld „reichweiteAbgeleitet“, M-16) → nur der
 * Ladestand; Anbieter nur mit Reichweite (RANGE_ONLY_OPS) → nur die Reichweite. null = keine Energieangabe. Reichweiten-Schwelle der Quelle
 * (v.rangeLimitKm, ops-Feld „reichweiteSchwelleKm“) → Reichweite < min(5 km, v.rangeLimitKm); konstante Reichweite (v.rangeFlat) zählt nicht.
 */
export const vehicleEnergyLow = (v) => energyLow(v.battery, v.rangeKm, { charge: LOW_BATTERY, range: LOW_RANGE_KM, rangeOnly: RANGE_ONLY.has(v.operator) || !!v.batteryDerived, rangeDerived: !!v.rangeDerived, rangeLimit: v.rangeLimitKm ?? null, rangeFlat: !!v.rangeFlat });

const R_EARTH = 6371000, rad = Math.PI / 180;
/** Abstand in Metern (gleichwinklige Näherung, genau genug unter 1 km) */
export const distM = (a, b) => { const x = (b.lon - a.lon) * rad * Math.cos((a.lat + b.lat) / 2 * rad), y = (b.lat - a.lat) * rad; return Math.sqrt(x * x + y * y) * R_EARTH; };
const median = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export const cellOf = (p) => `${Math.floor(p.lat / CELL_LAT)}:${Math.floor(p.lon / CELL_LON)}`;
/** Fläche einer Zelle in km² bei Breite lat */
export const cellAreaKm2 = (lat) => (CELL_LAT * rad * R_EARTH) * (CELL_LON * rad * R_EARTH * Math.cos(lat * rad)) / 1e6;

/** Raster-Index für Nachbarsuche im Umkreis (Meter); auch von lib/pulse-spots.js genutzt */
export function gridIndex(points, radiusM) {
  const dLat = radiusM / (rad * R_EARTH), lat0 = points.length ? points[0].lat : 50, dLon = dLat / Math.max(0.2, Math.cos(lat0 * rad));
  const g = new Map(), key = (i, j) => `${i}:${j}`;
  for (const p of points) { const k = key(Math.floor(p.lat / dLat), Math.floor(p.lon / dLon)); (g.get(k) || g.set(k, []).get(k)).push(p); }
  const each = (p, pred, fn) => { const i = Math.floor(p.lat / dLat), j = Math.floor(p.lon / dLon);
    for (let a = i - 1; a <= i + 1; a++) for (let b = j - 1; b <= j + 1; b++) for (const q of g.get(key(a, b)) || []) { if (q === p || !pred(q)) continue; const d = distM(p, q); if (d <= radiusM) fn(q, d); } };
  return {
    near(p, pred) { let best = null; each(p, pred, (q, d) => { if (!best || d < best.d) best = { p: q, d }; }); return best; }, // nächster Punkt im Umkreis, der pred erfüllt → { p, d } | null
    within(p, pred = () => true) { const out = []; each(p, pred, (q, d) => out.push({ p: q, d })); return out.sort((x, y) => x.d - y.d); }, // alle im Umkreis, nach Abstand
  };
}

const QUOTA_FIELDS = ['ags', 'operator', 'name', 'lat', 'lon', 'runs', 'emptyRuns', 'fullRuns', 'virtual'];
const QUOTA_MATCH_M = 15;
/**
 * Station virtuell (Abstellfläche ohne Docks) oder physisch? Reihenfolge: Merkmal der Station aus ops/<Land>.json (s.virtual 1/0, Sammler-Feld
 * „virtuell“), sonst stations-quota.json (is_virtual_station) derselben Station, sonst Näherung: weder Kapazität noch freie Plätze gemeldet = virtuell.
 * Rückgabe true/false.
 */
export function isVirtualStation(s, quotaMatch = null) {
  if (s?.virtual === 1 || s?.virtual === true) return true;
  if (s?.virtual === 0 || s?.virtual === false) return false;
  if (quotaMatch && (quotaMatch.virtual === 1 || quotaMatch.virtual === 0 || typeof quotaMatch.virtual === 'boolean')) return !!quotaMatch.virtual;
  return s?.capacity == null && s?.docks == null;
}
/**
 * Zeilen aus stations-quota.json der Gemeinde ags den Stationen zuordnen: gleicher Anbieter und gleicher Name (bei mehreren der nächste ≤ 15 m),
 * sonst der nächste desselben Anbieters ≤ 5 m; jede Zeile höchstens einmal. Rückgabe Map(Station → Zeile).
 */
export function matchQuota(stations, quota, ags) {
  const out = new Map(); if (!quota?.stations?.length || !stations.length) return out;
  const ix = Object.fromEntries((quota.fields || QUOTA_FIELDS).map((f, i) => [f, i]));
  const rows = quota.stations.filter(r => r[ix.ags] === ags && Number.isFinite(r[ix.lat]) && Number.isFinite(r[ix.lon]))
    .map(r => ({ operator: r[ix.operator], name: r[ix.name], lat: r[ix.lat], lon: r[ix.lon], virtual: ix.virtual == null ? null : r[ix.virtual] }));
  const idx = gridIndex(rows, QUOTA_MATCH_M), used = new Set();
  const need = stations.filter(s => !(s.virtual === 0 || s.virtual === 1 || typeof s.virtual === 'boolean')); // Stationen mit eigenem Merkmal brauchen keine Quote
  // erst gleiche Namen, dann Lage: sonst nimmt eine Nachbarstation am selben Ort die Zeile der namensgleichen weg
  for (const pass of [0, 1]) for (const s of need) {
    if (out.has(s)) continue;
    const cands = idx.within(s, r => r.operator === s.operator && !used.has(r));
    const m = (pass === 0 ? cands.find(c => c.p.name === s.name) : cands.find(c => c.d <= 5))?.p || null;
    if (m) { used.add(m); out.set(s, m); }
  }
  return out;
}

/**
 * Vergleich je Anbieter in der Gemeinde ags (Fahrzeugart type oder 'all').
 * Je Anbieter: Bestand, verfügbar/gesperrt/reserviert, Energie niedrig, Mediane (Ladestand, Reichweite, Standzeit),
 * Stationen (physisch/virtuell, leer, einzigartig/geteilt im Umkreis radiusM), belegte ≈250-m-Zellen (einzigartig/geteilt),
 * Fläche und Dichte, Anteil der Fahrzeuge mit einem Fahrzeug eines anderen Anbieters im Umkreis.
 * overlap[A][B] = Anteil der Zellen von A, in denen auch B steht. stations: alle Stationen mit unique und nächster fremder Station.
 */
export function compareOperators(fleet, { ags, type = 'all', radiusM = DEFAULT_RADIUS, quota = null } = {}) {
  const veh = (fleet?.vehicles || []).filter(v => v.ags === ags && Number.isFinite(v.lat) && Number.isFinite(v.lon) && (type === 'all' || v.type === type));
  // Stationen: Fahrzeugart nur über den Anbieter eingrenzbar (Stationen tragen keine Art) → Anbieter mit Fahrzeugen dieser Art
  const typeOps = type === 'all' ? null : new Set(veh.map(v => v.operator));
  const sta0 = (fleet?.stations || []).filter(s => s.ags === ags && Number.isFinite(s.lat) && Number.isFinite(s.lon) && (!typeOps || typeOps.has(s.operator)));
  const qm = matchQuota(sta0, quota, ags);
  const sta = sta0.map(s => ({ ...s, virtual: isVirtualStation(s, qm.get(s)) }));
  const ops = [...new Set([...veh.map(v => v.operator), ...sta.map(s => s.operator)])].filter(Boolean);
  // Zellen je Anbieter (Fahrzeuge)
  const cellOps = new Map();
  for (const v of veh) { const c = cellOf(v); (cellOps.get(c) || cellOps.set(c, new Set()).get(c)).add(v.operator); }
  const cellsOf = new Map(ops.map(o => [o, new Set()]));
  for (const [c, set] of cellOps) for (const o of set) cellsOf.get(o).add(c);
  // Nachbarschaft
  const sIdx = gridIndex(sta, radiusM), vIdx = gridIndex(veh, radiusM);
  const stations = sta.map(s => { const n = sIdx.near(s, q => q.operator !== s.operator); return { ...s, unique: !n, nearestOther: n ? { operator: n.p.operator, name: n.p.name || null, d: Math.round(n.d) } : null }; });
  const lat0 = veh[0]?.lat ?? sta[0]?.lat ?? 50, cellKm2 = cellAreaKm2(lat0);
  const rows = ops.map(op => {
    const vs = veh.filter(v => v.operator === op), ss = stations.filter(s => s.operator === op), cells = cellsOf.get(op) || new Set();
    const uniqueCells = [...cells].filter(c => cellOps.get(c).size === 1).length;
    const withBat = vs.filter(v => Number.isFinite(v.battery)), withRange = vs.filter(v => Number.isFinite(v.rangeKm));
    const lows = vs.map(vehicleEnergyLow), low = lows.filter(x => x === true).length, energyKnown = lows.filter(x => x != null).length;
    const nearOther = vs.length ? vs.filter(v => vIdx.near(v, q => q.operator !== op)).length : 0;
    return {
      op, vehicles: vs.length, available: vs.filter(v => !v.disabled && !v.reserved).length, disabled: vs.filter(v => v.disabled).length, reserved: vs.filter(v => v.reserved).length,
      lowEnergy: energyKnown ? low / energyKnown : null, energyKnown, batteryMedian: median(withBat.map(v => v.battery)), rangeMedian: median(withRange.map(v => v.rangeKm)), idleMedian: median(vs.map(v => v.idleMin)),
      stations: ss.length, physical: ss.filter(s => !s.virtual).length, virtual: ss.filter(s => s.virtual).length, emptyStations: ss.filter(s => !(s.bookable > 0)).length,
      uniqueStations: ss.filter(s => s.unique).length, sharedStations: ss.filter(s => !s.unique).length,
      cells: cells.size, uniqueCells, sharedCells: cells.size - uniqueCells, areaKm2: +(cells.size * cellKm2).toFixed(2),
      density: cells.size ? +(vs.length / (cells.size * cellKm2)).toFixed(1) : null, nearOther: vs.length ? nearOther / vs.length : null,
      types: vs.reduce((m, v) => { m[v.type] = (m[v.type] || 0) + 1; return m; }, {}),
    };
  }).sort((a, b) => b.vehicles - a.vehicles || b.stations - a.stations || a.op.localeCompare(b.op, 'de'));
  const overlap = {};
  for (const a of ops) { overlap[a] = {}; const A = cellsOf.get(a); for (const b of ops) if (a !== b) overlap[a][b] = A.size ? [...A].filter(c => cellsOf.get(b).has(c)).length / A.size : null; }
  const total = { vehicles: veh.length, stations: sta.length, cells: cellOps.size, areaKm2: +(cellOps.size * cellKm2).toFixed(2) };
  return { ags, type, radiusM, cellKm2: +cellKm2.toFixed(4), total, rows, overlap, stations, vehicles: veh };
}

/** CSV-Zeilen der Stationen (Kopf + Daten) */
export function stationCsvRows(stations, { labels = {}, lang = 'de' } = {}) {
  const L = { name: 'Station', operator: 'Anbieter', lat: 'Breite', lon: 'Länge', kind: 'Art', bookable: 'buchbar', capacity: 'Kapazität', unique: 'einzigartig', other: 'nächster fremder Anbieter', d: 'Abstand (m)', yes: 'ja', no: 'nein', phys: 'physisch', virt: 'virtuell', ...labels };
  const num = (x, d = 5) => (x == null ? '' : lang === 'de' ? x.toFixed(d).replace('.', ',') : x.toFixed(d));
  return [[L.name, L.operator, L.lat, L.lon, L.kind, L.bookable, L.capacity, L.unique, L.other, L.d],
    ...stations.map(s => [s.name || '', s.operator, num(s.lat), num(s.lon), s.virtual ? L.virt : L.phys, s.bookable ?? '', s.capacity ?? '', s.unique ? L.yes : L.no, s.nearestOther?.operator || '', s.nearestOther?.d ?? ''])];
}
