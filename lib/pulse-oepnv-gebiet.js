// @ts-check
// Geschäftsgebiet der Sharing-Anbieter je Gemeinde (19.11.2026): Als Bedarf an Sharing-Fahrzeugen (Jetzt gestört, Stationsvorschläge, Ziele der
// Disposition) zählen nur Haltestellen, an denen Sharing angeboten wird (Tübingen: Kilchberg, Pfrondorf, Hirschau … liegen außerhalb); sichtbar
// bleiben alle. Gemessen statt behauptet:
// Zellen (≈ 280 × 250 m, cellOf), in denen in den letzten GEBIET.days Tagen ein verfügbares Fahrzeug stand (cells/<Tag>/<Land>.json, Feld present),
// plus GEBIET.ring Zellen Rand. Unter GEBIET.minCells bedienten Zellen gilt kein Gebiet (wenige Fahrzeuge, Zellen unter der Veröffentlichungsgrenze).
import { cellOf } from './pulse-track-rules.js';

export const GEBIET = Object.freeze({ days: 7, minCells: 10, ring: 1 });

/** Bediente Zellen je Gemeinde aus Tagesdateien der Zellen ({ fields, munis: { AGS: { zelle: [start, end, present, …] } } }) → Map AGS → Set(zelle) */
/** @param {any[]} docs */
export function servedFrom(docs) {
  /** @type {Map<string, Set<string>>} */ const out = new Map();
  for (const d of docs || []) {
    const ip = Math.max(0, String(d?.fields || 'start,end,present').split(',').indexOf('present'));
    for (const [ags, cells] of Object.entries(d?.munis || {})) {
      let s = out.get(ags);
      for (const [cell, v] of Object.entries(cells || {})) if (Array.isArray(v) && v[ip] > 0) { if (!s) out.set(ags, s = new Set()); s.add(cell); }
    }
  }
  return out;
}

/** Liegt der Punkt im Gebiet (eigene Zelle oder bis ring Zellen daneben bedient)? */
/** @param {number} lat @param {number} lon @param {Set<string>} served */
export function inGebiet(lat, lon, served, ring = GEBIET.ring) {
  const [a, b] = cellOf(lat, lon).split(':').map(Number);
  for (let i = -ring; i <= ring; i++) for (let j = -ring; j <= ring; j++) if (served.has(`${a + i}:${b + j}`)) return true;
  return false;
}

/**
 * Feld gebiet der Stadtdatei oepnv/<AGS>.json: { days, cells, ring, inside, outside: [Station-ID …], names: [Name …] (höchstens 12, meiste Halte zuerst) }
 * oder null (zu wenige bediente Zellen: dann filtert die Seite nicht). rows wie NZ.stationRows (ID, Name, lat, lon, Halte, …).
 * @param {any[][]} rows @param {Set<string> | undefined} served @param {number} days
 */
export function gebietOf(rows, served, days) {
  if (!served || served.size < GEBIET.minCells) return null;
  const out = (rows || []).filter(r => !inGebiet(r[2], r[3], served)).sort((x, y) => (y[4] || 0) - (x[4] || 0));
  return { days, cells: served.size, ring: GEBIET.ring, inside: (rows || []).length - out.length, outside: out.map(r => String(r[0])), names: out.slice(0, 12).map(r => String(r[1])) };
}

/** Für die Seite: Prüfung je Station-ID (Bedarf nur im Gebiet); ohne Gebiet gilt jede Station */
/** @param {any} doc oepnv/<AGS>.json */
export function gebietFilter(doc) {
  const g = doc?.gebiet; if (!g?.outside) return { on: false, keepId: () => true, g: null };
  const out = new Set(g.outside.map(String));
  return { on: true, g, keepId: (/** @type {any} */ id) => !out.has(String(id)) };
}
