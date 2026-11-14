// Mobility Pulse – Sprint 8 (Geo): Projektion und Raster.
// ETRS89-LAEA (EPSG:3035, Zensus-Gitter) ↔ WGS84 nach Snyder (Map Projections, 1987, S. 187–190), Ellipsoid GRS80; Abweichung ≪ 1 m.
// Raster: 250-m-Veröffentlichungszelle wie die Verfolgung (cellOf), 50-m-Raster für Abstellvorgänge (S8.4), 1-km-Raster für den Gini (S8.2).
import { CELL_LAT, CELL_LON } from './pulse-track-rules.js';

const A = 6378137, F = 1 / 298.257222101, E2 = 2 * F - F * F, E = Math.sqrt(E2);
const LAT0 = 52 * Math.PI / 180, LON0 = 10 * Math.PI / 180, FE = 4321000, FN = 3210000;
const q = (phi) => { const s = Math.sin(phi); return (1 - E2) * (s / (1 - E2 * s * s) - (1 / (2 * E)) * Math.log((1 - E * s) / (1 + E * s))); };
const QP = q(Math.PI / 2), B0 = Math.asin(q(LAT0) / QP), RQ = A * Math.sqrt(QP / 2);
const D = (A * Math.cos(LAT0)) / (Math.sqrt(1 - E2 * Math.sin(LAT0) ** 2) * RQ * Math.cos(B0));
const E4 = E2 * E2, E6 = E4 * E2;

/** WGS84 → EPSG:3035 [x (Ost), y (Nord)] in Metern */
export function toLaea(lat, lon) {
  const phi = lat * Math.PI / 180, lam = lon * Math.PI / 180, b = Math.asin(q(phi) / QP);
  const Bf = RQ * Math.sqrt(2 / (1 + Math.sin(B0) * Math.sin(b) + Math.cos(B0) * Math.cos(b) * Math.cos(lam - LON0)));
  return [FE + Bf * D * Math.cos(b) * Math.sin(lam - LON0), FN + (Bf / D) * (Math.cos(B0) * Math.sin(b) - Math.sin(B0) * Math.cos(b) * Math.cos(lam - LON0))];
}
/** EPSG:3035 → WGS84 [lat, lon] */
export function fromLaea(x, y) {
  const dx = x - FE, dy = y - FN, rho = Math.hypot(dx / D, D * dy);
  if (rho < 1e-9) return [LAT0 * 180 / Math.PI, LON0 * 180 / Math.PI];
  const C = 2 * Math.asin(rho / (2 * RQ));
  const b = Math.asin(Math.cos(C) * Math.sin(B0) + (D * dy * Math.sin(C) * Math.cos(B0)) / rho);
  const lam = LON0 + Math.atan2(dx * Math.sin(C), D * rho * Math.cos(B0) * Math.cos(C) - D * D * dy * Math.sin(B0) * Math.sin(C));
  const phi = b + (E2 / 3 + 31 * E4 / 180 + 517 * E6 / 5040) * Math.sin(2 * b) + (23 * E4 / 360 + 251 * E6 / 3780) * Math.sin(4 * b) + (761 * E6 / 45360) * Math.sin(6 * b);
  return [phi * 180 / Math.PI, lam * 180 / Math.PI];
}

// ---------- Raster ----------
/** 250-m-Zelle (wie pulse-track-rules cellOf) und ihre Grenzen */
export const cell250 = (lat, lon) => `${Math.round(lat / CELL_LAT)}:${Math.round(lon / CELL_LON)}`;
/** Fläche des Rechtecks [lat ± hLat, lon ± hLon] auf die 250-m-Zellen verteilt (Anteile, Summe 1): Zensus-Zelle ↔ Veröffentlichungszelle
 * @returns {Array<[string, number]>} */
export function splitToCells(lat, lon, hLat, hLon) {
  /** @type {Array<[string, number]>} */ const out = []; const i0 = Math.round((lat - hLat) / CELL_LAT), i1 = Math.round((lat + hLat) / CELL_LAT), j0 = Math.round((lon - hLon) / CELL_LON), j1 = Math.round((lon + hLon) / CELL_LON);
  const tot = 4 * hLat * hLon;
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
    const a = Math.max(0, Math.min(lat + hLat, (i + 0.5) * CELL_LAT) - Math.max(lat - hLat, (i - 0.5) * CELL_LAT));
    const b = Math.max(0, Math.min(lon + hLon, (j + 0.5) * CELL_LON) - Math.max(lon - hLon, (j - 0.5) * CELL_LON));
    if (a * b > 0) out.push([`${i}:${j}`, (a * b) / tot]);
  }
  return out;
}
/** halbe Kantenlänge einer 100-m-Zensuszelle in Grad am Ort (Drehung der LAEA-Zelle gegen das Gradnetz vernachlässigt: < 4° in Deutschland) */
export const half100 = (lat) => [50 / 111320, 50 / (111320 * Math.cos(lat * Math.PI / 180))];
/** 50-m-Raster (S8.4) und 1-km-Raster (S8.2 Gini) */
export const G50 = Object.freeze({ lat: 0.00045, lon: 0.00068 }), G1K = Object.freeze({ lat: 0.009, lon: 0.0135 });
export const cellOfGrid = (g, lat, lon) => `${Math.round(lat / g.lat)}:${Math.round(lon / g.lon)}`;
export const centerOfGrid = (g, cell) => { const i = cell.indexOf(':'); return [+cell.slice(0, i) * g.lat, +cell.slice(i + 1) * g.lon]; };

// ---------- Nachbarsuche ----------
const M_LAT = 111320;
/** Raster-Index für Punkte [lat, lon]: nearestWithin(lat, lon, r) → Abstand in m zum nächsten Punkt bis r (sonst Infinity) */
export function pointIndex(points, cellM = 300) {
  const lat0 = points.length ? points[0][0] : 50, mLon = M_LAT * Math.cos(lat0 * Math.PI / 180), dLat = cellM / M_LAT, dLon = cellM / mLon, grid = new Map();
  for (let i = 0; i < points.length; i++) { const k = `${Math.floor(points[i][0] / dLat)}:${Math.floor(points[i][1] / dLon)}`; let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(i); }
  return {
    size: points.length,
    nearestWithin(lat, lon, r) {
      const gi = Math.floor(lat / dLat), gj = Math.floor(lon / dLon), n = Math.ceil(r / cellM); let best = Infinity;
      for (let a = gi - n; a <= gi + n; a++) for (let b = gj - n; b <= gj + n; b++) {
        const ids = grid.get(`${a}:${b}`); if (!ids) continue;
        for (const id of ids) { const p = points[id], dy = (p[0] - lat) * M_LAT, dx = (p[1] - lon) * mLon, d = Math.hypot(dx, dy); if (d < best) best = d; }
      }
      return best <= r ? best : Infinity;
    },
    /** Indizes aller Punkte bis r Meter */
    within(lat, lon, r) {
      const gi = Math.floor(lat / dLat), gj = Math.floor(lon / dLon), n = Math.ceil(r / cellM), out = [];
      for (let a = gi - n; a <= gi + n; a++) for (let b = gj - n; b <= gj + n; b++) {
        const ids = grid.get(`${a}:${b}`); if (!ids) continue;
        for (const id of ids) { const p = points[id]; if (Math.hypot((p[0] - lat) * M_LAT, (p[1] - lon) * mLon) <= r) out.push(id); }
      }
      return out;
    },
  };
}
/** Abstand in Metern (Kugel, kurze Strecken) */
export const distM = (lat1, lon1, lat2, lon2) => Math.hypot((lat2 - lat1) * M_LAT, (lon2 - lon1) * M_LAT * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180));
