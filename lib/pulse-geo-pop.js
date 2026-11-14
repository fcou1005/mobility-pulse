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

/** Sammler für Punkte einer Zensus-Datei: add(row) mit Gemeinde, result() je Gemeinde { ew, pts: [[lat, lon, ew]], cells: Map } */
export function popAccumulator(locate) {
  const by = new Map(); let rows = 0, ewAll = 0, ewIn = 0;
  return {
    add(r) {
      rows++; ewAll += r.ew; const ags = locate(r.lat, r.lon); if (!ags) return;
      ewIn += r.ew; let a = by.get(ags); if (!a) by.set(ags, a = { ew: 0, pts: [], cells: new Map() }); a.ew += r.ew; a.pts.push([r.lat, r.lon, r.ew]);
      const [hLat, hLon] = half100(r.lat);
      for (const [c, w] of splitToCells(r.lat, r.lon, hLat, hLon)) a.cells.set(c, (a.cells.get(c) || 0) + r.ew * w);
    },
    result: () => ({ by, rows, ewAll, ewIn }),
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
export function popSummary(byAgs, features, { maxDev = ZENSUS.maxDev } = {}) {
  const rows = [];
  for (const f of features || []) {
    const ags = f.properties?.ags, vg = f.properties?.pop, z = byAgs.get(ags)?.ew ?? 0;
    if (!ags || !(vg > 0)) continue;
    rows.push({ ags, name: f.properties.name, vg250: vg, zensus: z, dev: z / vg - 1 });
  }
  rows.sort((a, b) => Math.abs(b.dev) - Math.abs(a.dev));
  const ok = rows.filter(r => Math.abs(r.dev) <= maxDev).length;
  return { n: rows.length, within: ok, share: rows.length ? ok / rows.length : null, maxDev, worst: rows.slice(0, 15), rows };
}
export { cell250 };
