// Mobility Pulse – S6.1 Zonen-Werkbank (F4): Prüfung der GBFS-Zonen eines Anbieters in einer Gemeinde und Export im Backend-Format.
// Prüfungen: Überlappungen gleicher Art, Lücken (Haarrisse unter 3 m) und Taschen (kleine eingeschlossene Flächen) zwischen Zonen gleicher Art,
// Spots in Verbotszonen, Verbotszonen ohne OSM-Grund, Änderungsverlauf (zones-log.json). Export je Kategorie: gleiche Art vereinigt, Löcher
// mit 1 cm Spalt aufgeschnitten (das Portal zeichnet Innenringe als Fächer), Außenring gegen den Uhrzeigersinn, nur die Felder der Positivliste.
// Grundlage sind die öffentlichen GBFS-Zonen (geofencing_zones) – die Datei entsteht im Browser und wird nicht im Repo abgelegt.
import pcLib from './vendor/polygon-clipping.js'; // gebündelt (MIT), damit lib/ ohne node_modules läuft
import { areaM2, bboxOf, boxHit, contains, edgeDist, id20, M_PER_DEG, polysOf, ringSigned, selfIntersects, touches, UPLOAD } from './pulse-zones-geo.js';
/** @type {any} */ const pc = pcLib; // Koordinaten als einfache Arrays (die Typen von polygon-clipping verlangen Tupel)

// maxExportM2: größere Flächen (Umkehrung des Betriebsgebiets: „Fahrverbot überall außer …“) gehören in den Geofence, nicht in die Zonendatei
export const AUDIT = Object.freeze({ overlapMinM2: 1, gapMaxM: 3, pocketMaxM2: 2500, reasonM: 30, smallOkM2: 500000, maxExportM2: 50e6 });
export const KINDS = Object.freeze(['no_ride', 'no_park', 'mandatory', 'allowed']);
/** Art einer GBFS-Zone aus ihren Regeln: Fahrverbot (Durchfahrt verboten), Abstellverbot, Pflicht-Abstellzone (station_parking), erlaubt */
export function gbfsKind(rules = []) {
  if (rules.some(r => r.rideThrough === false)) return 'no_ride';
  if (rules.some(r => r.parking === true)) return 'mandatory';
  if (rules.some(r => r.rideAllowed === false || r.endAllowed === false)) return 'no_park';
  if (rules.some(r => r.rideAllowed === true || r.endAllowed === true)) return 'allowed';
  return null;
}
const isBan = (k) => k === 'no_ride' || k === 'no_park';

/** Zonen eines Anbieters im Rahmen bbox aus zones/<Datei>.json (mehrere Quellen: gleiche Umrandung nur einmal) */
export function zonesFor(docs, { operator = null, bbox = null } = {}) {
  const out = [], seen = new Set();
  for (const d of (Array.isArray(docs) ? docs : [docs]).filter(Boolean)) {
    if (operator && d.operator && d.operator !== operator) continue;
    (d.features || []).forEach((f, i) => {
      if (!f?.geometry || !polysOf(f.geometry).length) return;
      const kind = gbfsKind(f.properties?.rules || []); if (!kind) return;
      const bb = bboxOf(f.geometry); if (bbox && !boxHit(bb, bbox)) return;
      const key = `${kind}|${bb.map(x => x.toFixed(6)).join(',')}|${Math.round(areaM2(f.geometry))}`; if (seen.has(key)) return; seen.add(key);
      out.push({ ref: `${d.sourceId || 'zones'}#${i}`, source: d.sourceId || null, operator: d.operator || null, name: f.properties?.name || null, kind, geometry: f.geometry, bbox: bb, area: areaM2(f.geometry), vehicleTypes: [...new Set((f.properties?.rules || []).flatMap(r => r.vehicle_type_ids || r.vehicleTypeIds || []))] });
    });
  }
  return out;
}
const pcGeom = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);
const centroidOf = (g) => { const b = bboxOf(g); return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; };
// Rechteck-Kandidaten gleicher Art (sortiert nach minLon)
function pairs(list, padDeg = 0) {
  const ix = list.map((_, k) => k).sort((a, b) => list[a].bbox[0] - list[b].bbox[0]), out = [];
  for (let u = 0; u < ix.length; u++) for (let v = u + 1; v < ix.length; v++) { const a = list[ix[u]], b = list[ix[v]]; if (b.bbox[0] > a.bbox[2] + padDeg) break; if (a.kind === b.kind && boxHit(a.bbox, b.bbox, padDeg)) out.push([a, b]); }
  return out;
}

/**
 * Prüfung. zones: zonesFor(...); spots: [{ lat, lon, name, src }] (Stationen des Anbieters, eigene Spots-CSV, Spots der Disposition);
 * reasons: [{ lat, lon, tag }] (OSM-Gründe aus osmReasonPoints, null = nicht geprüft); log: zones-log.json; sources: Quellen der Zonen.
 * Rückgabe { counts, overlaps, gaps, pockets, spotsInBan, banNoReason, history, byKind }
 */
export function auditZones(zones, { spots = [], reasons = null, log = null } = {}) {
  const lat0 = zones.length ? (zones[0].bbox[1] + zones[0].bbox[3]) / 2 : 50;
  const overlaps = [], gaps = [];
  for (const [a, b] of pairs(zones, AUDIT.gapMaxM / M_PER_DEG * 2)) {
    let inter = []; try { inter = pc.intersection(pcGeom(a.geometry), pcGeom(b.geometry)); } catch { inter = []; }
    const ar = inter.reduce((s, p) => s + areaM2(p, lat0), 0);
    if (ar >= AUDIT.overlapMinM2) { overlaps.push({ kind: a.kind, a: a.ref, b: b.ref, names: [a.name, b.name], areaM2: Math.round(ar), at: centroidOf({ type: 'MultiPolygon', coordinates: inter }), geometry: { type: 'MultiPolygon', coordinates: inter } }); continue; }
    if (ar > 0) continue;
    const d = edgeDist(a.geometry, b.geometry, AUDIT.gapMaxM);
    if (d.d > 0 && d.d < AUDIT.gapMaxM) gaps.push({ kind: a.kind, a: a.ref, b: b.ref, names: [a.name, b.name], gapM: +d.d.toFixed(2), at: d.at });
  }
  // Taschen: Löcher der Vereinigung je Art, klein und von keiner anderen Zone gefüllt (gewollte Ausnahmen wie ein Hub in der Verbotszone)
  const pockets = [], byKind = {};
  for (const kind of KINDS) {
    const list = zones.filter(z => z.kind === kind); byKind[kind] = { zones: list.length, areaM2: Math.round(list.reduce((s, z) => s + z.area, 0)) };
    if (kind === 'allowed' || list.length < 2) continue;
    let u = []; try { u = pc.union(...list.map(z => pcGeom(z.geometry))); } catch { u = []; }
    byKind[kind].unionM2 = Math.round(u.reduce((s, p) => s + areaM2(p, lat0), 0));
    for (const p of u) for (const h of p.slice(1)) {
      const ar = Math.abs(ringSigned(h)) * M_PER_DEG * M_PER_DEG * Math.cos(lat0 * Math.PI / 180); if (ar > AUDIT.pocketMaxM2) continue;
      const c = centroidOf([h]); if (zones.some(z => z.kind !== kind && contains(z.geometry, c[0], c[1]))) continue;
      pockets.push({ kind, areaM2: Math.round(ar), at: c, ring: h });
    }
  }
  // Spots in Verbotszonen: nicht, wenn eine kleinere erlaubte oder Pflicht-Abstellzone am Ort liegt (die genauere Zone gilt)
  const spotsInBan = [];
  for (const s of spots || []) {
    const at = zones.filter(z => boxHit(z.bbox, [s.lon, s.lat, s.lon, s.lat]) && contains(z.geometry, s.lon, s.lat));
    const ban = at.filter(z => isBan(z.kind)); if (!ban.length) continue;
    const minBan = Math.min(...ban.map(z => z.area)); if (at.some(z => !isBan(z.kind) && z.area < minBan)) continue;
    const z = ban.sort((x, y) => x.area - y.area)[0]; spotsInBan.push({ ...s, zone: z.ref, zoneName: z.name, kind: z.kind });
  }
  // Verbotszonen ohne OSM-Grund: kein Grund-Punkt in der Zone oder höchstens reasonM daneben
  let banNoReason = null;
  if (Array.isArray(reasons)) {
    const pad = AUDIT.reasonM / M_PER_DEG * 1.6, grid = new Map(), G = 0.002, key = (x, y) => `${Math.floor(x / G)}:${Math.floor(y / G)}`;
    for (const r of reasons) { const k = key(r.lon, r.lat); const l = grid.get(k); if (l) l.push(r); else grid.set(k, [r]); }
    const inBox = (b) => { const out = []; for (let x = Math.floor((b[0] - pad) / G); x <= Math.floor((b[2] + pad) / G); x++) for (let y = Math.floor((b[1] - pad) / G); y <= Math.floor((b[3] + pad) / G); y++) for (const r of grid.get(`${x}:${y}`) || []) out.push(r); return out; };
    banNoReason = [];
    for (const z of zones.filter(q => isBan(q.kind))) {
      if ((z.bbox[2] - z.bbox[0]) * (z.bbox[3] - z.bbox[1]) > 0.01) continue; // sehr große Flächen (Stadtteil): nicht sinnvoll prüfbar
      const cand = inBox(z.bbox); let hit = null;
      for (const r of cand) { if (contains(z.geometry, r.lon, r.lat)) { hit = r; break; } }
      if (!hit) for (const r of cand) { const sq = [[[r.lon, r.lat], [r.lon + 1e-7, r.lat], [r.lon, r.lat + 1e-7], [r.lon, r.lat]]]; if (edgeDist(sq, z.geometry, AUDIT.reasonM).d <= AUDIT.reasonM) { hit = r; break; } }
      if (!hit) banNoReason.push({ zone: z.ref, name: z.name, kind: z.kind, areaM2: Math.round(z.area), at: centroidOf(z.geometry) });
    }
  }
  const srcs = new Set(zones.map(z => z.source).filter(Boolean)), fi = Object.fromEntries((log?.fields || ['at', 'sourceId', 'operator', 'added', 'removed', 'count']).map((f, i) => [f, i]));
  const history = (log?.changes || []).filter(c => srcs.has(c[fi.sourceId])).map(c => ({ at: c[fi.at], source: c[fi.sourceId], added: c[fi.added], removed: c[fi.removed], count: c[fi.count] })).sort((a, b) => b.at - a.at);
  return { counts: { zones: zones.length, overlaps: overlaps.length, gaps: gaps.length, pockets: pockets.length, spots: (spots || []).length, spotsInBan: spotsInBan.length, banNoReason: banNoReason?.length ?? null, changes: history.length },
    byKind, overlaps, gaps, pockets, spotsInBan, banNoReason, history };
}

// ---------- OSM-Gründe für Verbotszonen ----------
// Gleiche Kategorien wie das Betriebsgebiet-Werkzeug (Gewässer, Bahn, Autobahn, Friedhof, Schule/Kita, Klinik, Parkhaus, Haltestellen, Spielplatz …)
export const REASON_TAGS = Object.freeze([
  ['natural', 'water'], ['waterway', 'river|canal|riverbank|stream'], ['landuse', 'railway|cemetery|military|construction'], ['railway', 'rail|tram|light_rail|subway|platform|station'],
  ['highway', 'motorway|trunk|steps|pedestrian|bus_stop'], ['amenity', 'grave_yard|school|kindergarten|hospital|parking|fountain|place_of_worship|townhall|bus_station'], ['building', 'train_station|parking'],
  ['leisure', 'playground|park|nature_reserve|stadium|sports_centre'], ['public_transport', 'platform|station'], ['historic', 'memorial|monument'], ['aeroway', '.*'], ['tourism', 'artwork|attraction|zoo'],
]);
/** Overpass-Abfrage der Gründe im Rahmen [minLon, minLat, maxLon, maxLat]; Wege mit Geometrie (ausgedünnt in osmReasonPoints) */
export function reasonQuery(bbox) {
  const bb = [bbox[1], bbox[0], bbox[3], bbox[2]].map(x => x.toFixed(4)).join(',');
  return `[out:json][timeout:120][bbox:${bb}];(${REASON_TAGS.map(([k, v]) => `nwr["${k}"~"^(${v})$"];`).join('')});out tags geom qt;`;
}
/** Overpass-Elemente → Punkte { lat, lon, tag } (Knoten, Stützpunkte von Wegen und Relationen höchstens alle ~20 m) */
export function osmReasonPoints(elements) {
  const out = [], tagOf = (t = {}) => { for (const [k] of REASON_TAGS) if (t[k]) return `${k}=${t[k]}`; return null; };
  for (const e of elements || []) {
    const tag = tagOf(e.tags); if (!tag) continue;
    if (e.type === 'node' && Number.isFinite(e.lat)) { out.push({ lat: e.lat, lon: e.lon, tag }); continue; }
    const geo = e.geometry || (e.members || []).flatMap(m => m.geometry || []);
    let last = null; for (const p of geo) { if (!p || !Number.isFinite(p.lat)) continue; if (last && Math.abs(p.lat - last.lat) < 0.00018 && Math.abs(p.lon - last.lon) < 0.00027) continue; out.push({ lat: p.lat, lon: p.lon, tag }); last = p; }
    if (e.center) out.push({ lat: e.center.lat, lon: e.center.lon, tag });
  }
  return out;
}

// ---------- Export im Backend-Format ----------
export const FLAGS = Object.freeze({
  no_ride: { isRidingForbidden: true, isParkingForbidden: true, isDesignatedParking: false, needsRelocation: true },
  no_park: { isParkingForbidden: true, isDesignatedParking: false, needsRelocation: true },
  mandatory: { isParkingForbidden: true, isDesignatedParking: false, mustParkInParkingLocation: true, needsRelocation: false },
  allowed: { isParkingForbidden: false, isDesignatedParking: true, mustParkInParkingLocation: false, needsRelocation: false },
});
export const EXPORT_FILES = Object.freeze({ no_ride: '00_no_riding', no_park: '01_no_parking', mandatory: '02_mandatory_parking', allowed: '03_parking_allowed' });
// Ring säubern: doppelte Folgepunkte weg, geschlossen (keine Rundung: gerundete Kanten können sich in dünnen Stücken überschneiden)
const clean = (r) => { const o = []; for (const p of r) { const l = o[o.length - 1]; if (!l || l[0] !== p[0] || l[1] !== p[1]) o.push([p[0], p[1]]); } if (o.length > 1 && o[0][0] === o[o.length - 1][0] && o[0][1] === o[o.length - 1][1]) return o; if (o.length) o.push([...o[0]]); return o; };
const ccw = (p) => [ringSigned(p[0]) > 0 ? p[0] : p[0].slice().reverse()];
// Löcher aufschneiden: senkrechter Streifen von gapM Breite durch den Mittelpunkt des ersten Lochs, bis kein Loch mehr da ist
function cutHoles(poly, gapM, lat0, depth = 0) {
  if (poly.length < 2 || depth > 40) return [poly];
  const h = poly[1], b = bboxOf([h]), cx = (b[0] + b[2]) / 2, half = gapM / (M_PER_DEG * Math.cos(lat0 * Math.PI / 180)) / 2, pb = bboxOf(poly);
  const L = [[[pb[0] - 1, pb[1] - 1], [cx - half, pb[1] - 1], [cx - half, pb[3] + 1], [pb[0] - 1, pb[3] + 1], [pb[0] - 1, pb[1] - 1]]];
  const R = [[[cx + half, pb[1] - 1], [pb[2] + 1, pb[1] - 1], [pb[2] + 1, pb[3] + 1], [cx + half, pb[3] + 1], [cx + half, pb[1] - 1]]];
  let parts = []; try { parts = [...pc.intersection(poly, L), ...pc.intersection(poly, R)]; } catch { return [poly]; }
  return parts.flatMap(p => cutHoles(p, gapM, lat0, depth + 1));
}
// Teile, die sich berühren oder näher als gapM kommen (die Vereinigung lässt sie getrennt): an der engsten Stelle ein Quadrat aus dem kleineren
// Teil schneiden (Kantenlänge 3 × gapM); je Runde alle Paare, bis alle den Spalt halten. Splitter (mittlere Breite unter 0,5 m) entfallen vorher.
const perimM = (p, lat0) => { const k = Math.cos(lat0 * Math.PI / 180); let s = 0; for (const r of p) for (let i = 1; i < r.length; i++) s += Math.hypot((r[i][0] - r[i - 1][0]) * k, r[i][1] - r[i - 1][1]) * M_PER_DEG; return s; };
const sliver = (p, lat0) => { const a = areaM2(p, lat0); return a < 2 || 2 * a / perimM(p, lat0) < 0.5; };
// Saum um die Ränder von q nahe dem Rechteck box: je Strecke ein Rechteck der Breite 2·g, je Stützpunkt ein Quadrat (Minkowski-Näherung)
function rim(q, box, g, lat0) {
  const kx = M_PER_DEG * Math.cos(lat0 * Math.PI / 180), gy = g / M_PER_DEG, gx = g / kx, out = [];
  for (const r of q) for (let i = 1; i < r.length; i++) {
    const a = r[i - 1], b = r[i];
    if (Math.max(a[0], b[0]) < box[0] - gx || Math.min(a[0], b[0]) > box[2] + gx || Math.max(a[1], b[1]) < box[1] - gy || Math.min(a[1], b[1]) > box[3] + gy) continue;
    const dx = (b[0] - a[0]) * kx, dy = (b[1] - a[1]) * M_PER_DEG, l = Math.hypot(dx, dy) || 1, nx = -dy / l * g / kx, ny = dx / l * g / M_PER_DEG;
    out.push([[[a[0] + nx, a[1] + ny], [a[0] - nx, a[1] - ny], [b[0] - nx, b[1] - ny], [b[0] + nx, b[1] + ny], [a[0] + nx, a[1] + ny]]]);
    out.push([[[a[0] - gx, a[1] - gy], [a[0] + gx, a[1] - gy], [a[0] + gx, a[1] + gy], [a[0] - gx, a[1] + gy], [a[0] - gx, a[1] - gy]]]);
  }
  return out;
}
function separate(pieces, gapM, lat0) {
  const pad = 2 * gapM / M_PER_DEG;
  pieces = pieces.filter(p => !sliver(p, lat0));
  for (let round = 0; round < 6; round++) {
    const bb = pieces.map(p => bboxOf(p)), cut = new Map();
    for (let i = 0; i < pieces.length; i++) for (let j = i + 1; j < pieces.length; j++) {
      if (!boxHit(bb[i], bb[j], pad)) continue;
      if (!(edgeDist(pieces[i], pieces[j], 0.05).d < gapM) && !touches(pieces[i], pieces[j])) continue;
      const [k, o] = areaM2(pieces[i], lat0) < areaM2(pieces[j], lat0) ? [i, j] : [j, i]; if (!cut.has(k)) cut.set(k, []); cut.get(k).push(o);
    }
    if (!cut.size) break;
    const next = [];
    pieces.forEach((p, k) => {
      if (!cut.has(k)) { next.push(p); return; }
      const saum = cut.get(k).flatMap(o => rim(pieces[o], bb[k], gapM * 1.2, lat0)); // der kleinere Teil weicht um den Saum des größeren zurück
      let rest = []; try { rest = saum.length ? pc.difference(p, ...saum) : [p]; } catch { next.push(p); return; }
      next.push(...rest.flatMap(q => cutHoles(q, gapM, lat0)).map(q => q.map(clean)).filter(q => q[0].length >= 4 && !sliver(q, lat0)).map(ccw));
    });
    pieces = next;
  }
  return pieces;
}
/**
 * Export einer Kategorie: Zonen der Art vereinigt, in Polygone ohne Löcher zerlegt (Stücke unter 1 m² entfallen), Außenring gegen den
 * Uhrzeigersinn. allowed: nur kleine erlaubte Zonen (Hubs, unter smallOkM2; das Betriebsgebiet selbst ist der Geofence, keine Zone).
 * vehicleTypes: Fahrzeugarten im features-Block (scooter, bicycle). Rückgabe FeatureCollection mit Hülle wie der Live-Export.
 */
export function exportKind(zones, kind, { prefix = '', vehicleTypes = ['scooter'], now = Date.now(), gapM = UPLOAD.gapM, names = null, clip = null } = {}) {
  const list = zones.filter(z => z.kind === kind && z.area <= AUDIT.maxExportM2 && (kind !== 'allowed' || z.area < AUDIT.smallOkM2));
  const lat0 = list.length ? (list[0].bbox[1] + list[0].bbox[3]) / 2 : 50;
  let u = []; try { u = list.length ? pc.union(...list.map(z => pcGeom(z.geometry))) : []; if (clip && u.length) u = pc.intersection(u, pcGeom(clip)); } catch { u = []; }
  let pieces = u.flatMap(p => cutHoles(p, gapM * 1.5, lat0)).map(p => p.map(clean)).filter(p => p[0].length >= 4 && areaM2(p, lat0) >= 1).map(ccw);
  pieces = separate(pieces, gapM * 1.5, lat0).filter(p => !selfIntersects(p)).sort((a, b) => bboxOf(a)[0] - bboxOf(b)[0] || bboxOf(a)[1] - bboxOf(b)[1]);
  const label = names?.[kind] || { no_ride: 'Fahrverbot', no_park: 'Abstellverbot', mandatory: 'Pflicht-Abstellzone', allowed: 'Abstellfläche' }[kind];
  const nameOf = (p) => { const c = [(bboxOf(p)[0] + bboxOf(p)[2]) / 2, (bboxOf(p)[1] + bboxOf(p)[3]) / 2]; const src = list.filter(z => contains(z.geometry, c[0], c[1]) && z.name).sort((a, b) => a.area - b.area)[0]; return src?.name || null; };
  const features = pieces.map((p, i) => { const b = bboxOf(p), key = `${prefix}|${kind}|${b.map(x => x.toFixed(5)).join(',')}`;
    const nm = nameOf(p); return { type: 'Feature', properties: { id: id20(key), name: `${prefix ? `${prefix} ` : ''}${label} ${i + 1}${nm ? ` (${nm})` : ''}`, features: Object.fromEntries(vehicleTypes.map(v => [v, { ...FLAGS[kind] }])), is: { enabled: true, visible: true } }, geometry: { type: 'Polygon', coordinates: p } }; });
  const d = new Date(now);
  return { timestampMs: now, timestampFormatted: `${d.getUTCDate()}.${d.getUTCMonth() + 1}.${d.getUTCFullYear()}, ${d.toISOString().slice(11, 19)} UTC`, type: 'FeatureCollection', features };
}
