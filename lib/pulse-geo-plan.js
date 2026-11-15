// Mobility Pulse – S8.4 Abstellflächen-Planer (F10): Vorschläge für E-Scooter-Abstellflächen dort, wo Fahrten enden.
// Nachfrage: Fahrtenden je 50-m-Raster und Monat (Sammler, privat gezählt, veröffentlicht erst ab 3). Kandidaten alle 25 m an Straßen mit
// Gehweg (sidewalk=both/left/right/yes/separate) und Fußgängerflächen aus OSM; ausgeschlossen: Abstellverbotszonen, 20 m um Haltestellen,
// 15 m um Kreuzungen. Auswahl per maximaler Abdeckung (gierig, jede Fahrt zählt einmal, 50 m Einzugsbereich, 50 m Mindestabstand).
// Prüfung: Anteil der Vorschläge mit vorhandener E-Scooter-Fläche oder Sharing-Punkt (OSM) oder Abstellinsel eines Anbieters in 50 m.
// Abstellinseln (seit 15.11.2026): kleine Zonen der Anbieter-Feeds mit erlaubtem oder vorgeschriebenem Abstellen. OSM kennt in Stuttgart 69 Flächen,
// die Feeds 552 Inseln; von den 20 stärksten Zellen liegen 13 an einer Insel (Köln 13, Karlsruhe 7), mit OSM allein lagen 2 von 20 Vorschlägen an einer Fläche.
import { distM, pointIndex, centerOfGrid, G50 } from './pulse-geo-proj.js';

export const PLAN = Object.freeze({ stepM: 25, coverM: 50, spacingM: 50, stopM: 20, crossM: 15, minCount: 3, maxBoxKm: 6, islandM2: 2000 });

/** Overpass für Kandidaten, Haltestellen, Kreuzungen und vorhandene Flächen in bbox [Süd, West, Nord, Ost] */
export const overpassPlan = (bb) => `[out:json][timeout:120];(
way["highway"~"^(pedestrian|living_street|footway)$"](${bb.join(',')});
way["highway"]["sidewalk"~"^(both|left|right|yes|separate)$"](${bb.join(',')});
way["highway"~"^(residential|tertiary|secondary|primary|unclassified|service)$"](${bb.join(',')});
node["highway"="bus_stop"](${bb.join(',')});node["public_transport"~"^(platform|stop_position)$"](${bb.join(',')});node["railway"="tram_stop"](${bb.join(',')});
nwr["amenity"~"^(kick-scooter_parking|bicycle_rental|mobility_hub|kick_scooter_parking)$"](${bb.join(',')});
nwr["amenity"="parking"]["parking"~"scooter|e_scooter|kick"](${bb.join(',')});
);out geom qt;`;

const SIDEWALK = /^(both|left|right|yes|separate)$/, WALK = /^(pedestrian|living_street|footway)$/;
/** OSM-Antwort zerlegen: Kandidatenwege, alle Straßen (für Kreuzungen), Haltestellen, vorhandene Flächen */
export function parseOsm(json) {
  const ways = [], roads = [], stops = [], existing = [];
  for (const e of json?.elements || []) {
    const t = e.tags || {};
    if (/^(kick-scooter_parking|kick_scooter_parking|bicycle_rental|mobility_hub)$/.test(t.amenity || '') || (t.amenity === 'parking' && /scooter|kick/.test(t.parking || ''))) {
      const c = e.type === 'node' ? [e.lat, e.lon] : e.geometry?.length ? [e.geometry.reduce((a, p) => a + p.lat, 0) / e.geometry.length, e.geometry.reduce((a, p) => a + p.lon, 0) / e.geometry.length] : e.center ? [e.center.lat, e.center.lon] : null;
      if (c) existing.push(c); continue;
    }
    if (e.type === 'node' && (t.highway === 'bus_stop' || /^(platform|stop_position)$/.test(t.public_transport || '') || t.railway === 'tram_stop')) { stops.push([e.lat, e.lon]); continue; }
    if (e.type === 'way' && t.highway && e.geometry?.length > 1) {
      const geom = e.geometry.map(p => [p.lat, p.lon]); roads.push({ id: e.id, nodes: e.nodes || [], geom });
      if (WALK.test(t.highway) || SIDEWALK.test(t.sidewalk || '') || SIDEWALK.test(t['sidewalk:both'] || '') || SIDEWALK.test(t['sidewalk:left'] || '') || SIDEWALK.test(t['sidewalk:right'] || '')) ways.push({ id: e.id, geom });
    }
  }
  return { ways, roads, stops, existing };
}
/** Kreuzungen: Knoten, die in mindestens zwei Straßen vorkommen (über die Knoten-IDs, sonst über gleiche Koordinaten) */
export function crossings(roads) {
  const seen = new Map(), out = [];
  for (const r of roads) {
    const keys = r.nodes?.length === r.geom.length ? r.nodes.map(String) : r.geom.map(p => `${p[0].toFixed(6)},${p[1].toFixed(6)}`);
    const uniq = new Set(keys);
    for (const k of uniq) { const n = (seen.get(k) || 0) + 1; seen.set(k, n); if (n === 2) { const i = keys.indexOf(k); out.push(r.geom[i]); } }
  }
  return out;
}
/** Punkte alle stepM entlang der Wege */
export function candidatesAlong(ways, stepM = PLAN.stepM) {
  const out = [];
  for (const w of ways) {
    let carry = 0;
    for (let i = 1; i < w.geom.length; i++) {
      const [a, b] = [w.geom[i - 1], w.geom[i]], d = distM(a[0], a[1], b[0], b[1]); let s = carry;
      while (s <= d) { const f = d ? s / d : 0; out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, w.id]); s += stepM; }
      carry = s - d;
    }
  }
  return out;
}
/**
 * Vorschläge: demand [[lat, lon, n]] (50-m-Zellen), Kandidaten, Ausschlüsse (noPark(lat, lon) → true = verboten, stops, cross), k Vorschläge.
 * Rückgabe { picks: [{ lat, lon, covered, near }], covered, total, excluded: { noPark, stop, cross } }
 */
export function planSpots(demand, cands, { k = 20, noPark = null, stops = [], cross = [], coverM = PLAN.coverM, spacingM = PLAN.spacingM, stopM = PLAN.stopM, crossM = PLAN.crossM } = {}) {
  const sIx = pointIndex(stops, 100), cIx = pointIndex(cross, 100), ex = { noPark: 0, stop: 0, cross: 0 };
  const ok = cands.filter(([la, lo]) => {
    if (noPark && noPark(la, lo)) { ex.noPark++; return false; }
    if (stops.length && sIx.nearestWithin(la, lo, stopM) <= stopM) { ex.stop++; return false; }
    if (cross.length && cIx.nearestWithin(la, lo, crossM) <= crossM) { ex.cross++; return false; }
    return true;
  });
  const dIx = pointIndex(demand.map(d => [d[0], d[1]]), 100), cover = ok.map(([la, lo]) => dIx.within(la, lo, coverM));
  const taken = new Uint8Array(demand.length), picks = [], total = demand.reduce((a, d) => a + d[2], 0); let covered = 0;
  const pIx = []; const farFromPicks = (la, lo) => pIx.every(p => distM(la, lo, p[0], p[1]) >= spacingM);
  for (let r = 0; r < k; r++) {
    let best = -1, bv = 0;
    for (let i = 0; i < ok.length; i++) { let v = 0; for (const j of cover[i]) if (!taken[j]) v += demand[j][2]; if (v > bv && farFromPicks(ok[i][0], ok[i][1])) { bv = v; best = i; } }
    if (best < 0) break;
    for (const j of cover[best]) taken[j] = 1; covered += bv; picks.push({ lat: ok[best][0], lon: ok[best][1], covered: bv, near: false }); pIx.push([ok[best][0], ok[best][1]]);
  }
  return { picks, covered, total, candidates: cands.length, usable: ok.length, excluded: ex };
}
/** Anteil der Vorschläge mit vorhandener Fläche in r Metern */
export function nearExisting(picks, existing, r = 50) {
  if (!picks.length) return null;
  return picks.filter(p => isNear(p, existing, r)).length / picks.length;
}
/** vorhandene Fläche [lat, lon, Halbmesser m (fehlt = Punkt)] höchstens r Meter vom Rand entfernt */
export const isNear = (p, existing, r = 50) => existing.some(e => distM(p.lat, p.lon, e[0], e[1]) <= r + (e[2] || 0));
/** Abstellinseln aus Anbieter-Zonen (zonesFor): erlaubtes oder vorgeschriebenes Abstellen auf unter maxM2 → [[lat, lon, Halbmesser m]] */
export const parkingIslands = (zones, maxM2 = PLAN.islandM2) => (zones || []).filter(z => (z.kind === 'allowed' || z.kind === 'mandatory') && z.area < maxM2 && z.bbox)
  .map(z => [(z.bbox[1] + z.bbox[3]) / 2, (z.bbox[0] + z.bbox[2]) / 2, Math.round(Math.sqrt(z.area) / 2)]);
/** 50-m-Zellen aus abstell/<AGS>.json → [[lat, lon, n]] */
export const demandFromDoc = (doc) => (doc?.cells?.rows || []).filter(r => r[1] >= PLAN.minCount).map(r => { const [la, lo] = centerOfGrid(G50, r[0]); return [la, lo, r[1]]; });
/** Suchrahmen um die Nachfrage, höchstens maxBoxKm × maxBoxKm um den Schwerpunkt der stärksten Zellen */
export function demandBox(demand, maxKm = PLAN.maxBoxKm) {
  if (!demand.length) return null;
  const top = [...demand].sort((a, b) => b[2] - a[2]).slice(0, 200), w = top.reduce((a, d) => a + d[2], 0);
  const la = top.reduce((a, d) => a + d[0] * d[2], 0) / w, lo = top.reduce((a, d) => a + d[1] * d[2], 0) / w, hLat = (maxKm / 2) / 111.32, hLon = hLat / Math.cos(la * Math.PI / 180);
  const inBox = demand.filter(d => Math.abs(d[0] - la) <= hLat && Math.abs(d[1] - lo) <= hLon);
  const s = Math.min(...inBox.map(d => d[0])) - 0.0005, n = Math.max(...inBox.map(d => d[0])) + 0.0005, wv = Math.min(...inBox.map(d => d[1])) - 0.0007, e = Math.max(...inBox.map(d => d[1])) + 0.0007;
  return [s, wv, n, e].map(x => Math.round(x * 1e5) / 1e5);
}
