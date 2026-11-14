// Mobility Pulse – S8.1 Zensus 2022 im 100-m-Gitter (Bevölkerungszahl, dl-de/by-2-0, © Statistisches Bundesamt (Destatis), 2024):
// Zeilen „GITTER_ID_100m;x_mp_100m;y_mp_100m;Einwohner“ (Mittelpunkt in EPSG:3035) → WGS84, Gemeinde per Punkt-in-Polygon (vereinfachte
// VG250-Grenzen aktiver Gemeinden), 250-m-Veröffentlichungszelle über die Schnittfläche (splitToCells). Ausgabe je Land Δ-kodiert.
import { bboxOf, contains } from './pulse-zones-geo.js';
import { cell250, fromLaea, half100, splitToCells } from './pulse-geo-proj.js';

export const ZENSUS = Object.freeze({
  url: 'https://www.destatis.de/static/DE/zensus/gitterdaten/Zensus2022_Bevoelkerungszahl.zip',
  member: /100m.*\.csv$/i,
  attribution: '© Statistisches Bundesamt (Destatis), Zensus 2022, Bevölkerungszahl im 100-m-Gitter',
  license: 'dl-de/by-2-0', maxDev: 0.03,
});

/** Kopfzeile → Spaltenindizes (Trennzeichen ; oder ,) */
export function censusHeader(line) {
  const sep = line.includes(';') ? ';' : ',', h = line.replace(/^﻿/, '').split(sep).map(s => s.trim().replace(/^"|"$/g, '').toLowerCase());
  const ix = { sep, x: h.findIndex(c => /^x_mp/.test(c)), y: h.findIndex(c => /^y_mp/.test(c)), ew: h.findIndex(c => /einwohner/.test(c)) };
  if (ix.x < 0 || ix.y < 0 || ix.ew < 0) throw new Error(`Zensus-Kopfzeile unbekannt: ${h.join(sep)}`);
  return ix;
}
/** eine Datenzeile → { lat, lon, ew } oder null (geheim „–“, leer, 0) */
export function censusRow(line, ix) {
  const c = line.split(ix.sep), ew = Number(String(c[ix.ew] ?? '').replace(',', '.').trim());
  if (!(ew > 0)) return null;
  const x = Number(c[ix.x]), y = Number(c[ix.y]); if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const [lat, lon] = fromLaea(x, y);
  return { lat, lon, ew };
}

/** Zuordnung zu Gemeinden: features (GeoJSON, properties.ags) → assign(lat, lon) = ags | null */
export function muniLocator(features) {
  const B = 0.1, grid = new Map(), items = (features || []).map(f => ({ ags: f.properties?.ags, g: f.geometry, bb: bboxOf(f.geometry) })).filter(x => x.ags && x.bb);
  for (const it of items) for (let a = Math.floor(it.bb[1] / B); a <= Math.floor(it.bb[3] / B); a++) for (let b = Math.floor(it.bb[0] / B); b <= Math.floor(it.bb[2] / B); b++) { const k = `${a}:${b}`; let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(it); }
  return (lat, lon) => {
    for (const it of grid.get(`${Math.floor(lat / B)}:${Math.floor(lon / B)}`) || []) if (lon >= it.bb[0] && lon <= it.bb[2] && lat >= it.bb[1] && lat <= it.bb[3] && contains(it.g, lon, lat)) return it.ags;
    return null;
  };
}

/** Sammler für Punkte einer Zensus-Datei: add(row) mit Gemeinde, result() je Gemeinde { ew, pts: [[lat, lon, ew]], cells: Map }.
 * Grenzzellen (eine Ecke in einer anderen Gemeinde als die Mitte) werden über 4 × 4 Teilpunkte anteilig verteilt; jeder Teil bekommt
 * den Schwerpunkt seiner Teilpunkte als Ort. Ohne das kippt eine ganze Zeilenreihe entlang der Grenze zur Nachbargemeinde. */
export function popAccumulator(locate) {
  const by = new Map(); let rows = 0, ewAll = 0, ewIn = 0, split = 0;
  const CORNERS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  return {
    add(r) {
      rows++; ewAll += r.ew;
      const [hLat, hLon] = half100(r.lat), c0 = locate(r.lat, r.lon);
      /** @type {Array<[string, number, number, number]>} */ let parts;
      if (CORNERS.every(([i, j]) => locate(r.lat + i * hLat * 0.9, r.lon + j * hLon * 0.9) === c0)) parts = c0 ? [[c0, r.lat, r.lon, 1]] : [];
      else {
        split++; const m = new Map();
        for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
          const la = r.lat + hLat * ((2 * i + 1) / 4 - 1), lo = r.lon + hLon * ((2 * j + 1) / 4 - 1), g = locate(la, lo); if (!g) continue;
          const e = m.get(g) || m.set(g, [0, 0, 0]).get(g); e[0]++; e[1] += la; e[2] += lo;
        }
        parts = [...m].map(([g, [n, sla, slo]]) => [g, sla / n, slo / n, n / 16]);
      }
      const cells = parts.length ? splitToCells(r.lat, r.lon, hLat, hLon) : [];
      for (const [ags, la, lo, w] of parts) {
        const ew = r.ew * w; ewIn += ew; let a = by.get(ags); if (!a) by.set(ags, a = { ew: 0, pts: [], cells: new Map() }); a.ew += ew;
        a.pts.push([la, lo, w === 1 ? ew : Math.round(ew * 10) / 10]);
        for (const [c, cw] of cells) a.cells.set(c, (a.cells.get(c) || 0) + ew * cw);
      }
    },
    result: () => ({ by, rows, ewAll, ewIn, split }),
  };
}

/** Δ-kodiert: Punkte nach lat, lon sortiert, 1e-5 Grad ganzzahlig; cells als [Zelle, Einwohner (0,1)] */
export function packAgs(a) {
  const pts = a.pts.map(([lat, lon, ew]) => [Math.round(lat * 1e5), Math.round(lon * 1e5), ew]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const flat = []; let pl = 0, pn = 0;
  for (const [la, lo, ew] of pts) { flat.push(la - pl, lo - pn, ew); pl = la; pn = lo; }
  return { ew: a.ew, n: pts.length, pts: flat, cells: [...a.cells].map(([c, v]) => [c, Math.round(v * 10) / 10]).filter(x => x[1] > 0).sort((x, y) => (x[0] < y[0] ? -1 : 1)) };
}
/** Umkehrung: [[lat, lon, ew]] */
export function unpackPts(flat) {
  const out = []; let la = 0, lo = 0;
  for (let i = 0; i < flat.length; i += 3) { la += flat[i]; lo += flat[i + 1]; out.push([la / 1e5, lo / 1e5, flat[i + 2]]); }
  return out;
}
/** Abgleich mit VG250-EW: Abweichung je Gemeinde und Anteil innerhalb ±maxDev */
/** Abgleich je Gemeinde. VG250-EW und Zensus haben verschiedene Stichtage; die Fortschreibung verschiebt ein ganzes Land gemeinsam.
 *  Darum zusätzlich `adj`: Abweichung nach Abzug des Landes-Medians von Zensus ÷ VG250-EW (landFactor) – sie zeigt Fehler der Zuordnung
 *  (Grenzzellen, fehlende Zellen), nicht den Stichtag. `dev`/`within` bleiben die rohe Abweichung. */
export function popSummary(byAgs, features, { maxDev = ZENSUS.maxDev } = {}) {
  const rows = [];
  for (const f of features || []) {
    const ags = f.properties?.ags, vg = f.properties?.pop, z = byAgs.get(ags)?.ew ?? 0;
    if (!ags || !(vg > 0)) continue;
    rows.push({ ags, name: f.properties.name, vg250: vg, zensus: z, dev: z / vg - 1, adj: 0 });
  }
  const byLand = new Map(); for (const r of rows) { const l = r.ags.slice(0, 2); (byLand.get(l) || byLand.set(l, []).get(l)).push(r.zensus / r.vg250); }
  const med = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const landFactor = Object.fromEntries([...byLand].map(([l, a]) => [l, Math.round(med(a) * 10000) / 10000]));
  for (const r of rows) r.adj = landFactor[r.ags.slice(0, 2)] > 0 ? r.zensus / r.vg250 / landFactor[r.ags.slice(0, 2)] - 1 : r.dev;
  rows.sort((a, b) => Math.abs(b.adj) - Math.abs(a.adj));
  const ok = rows.filter(r => Math.abs(r.dev) <= maxDev).length, okAdj = rows.filter(r => Math.abs(r.adj) <= maxDev).length;
  return { n: rows.length, within: ok, share: rows.length ? ok / rows.length : null, withinAdj: okAdj, shareAdj: rows.length ? okAdj / rows.length : null, landFactor, maxDev, worst: rows.slice(0, 15), rows };
}
export { cell250 };
