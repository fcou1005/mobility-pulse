// Mobility Pulse — Disposition: Nachfragemodell, Deploy-Spots, Rebalancing-, Swap- und Werkstatt-Touren.
// Reine Funktionen für Browser und Node. Entfernungen in Metern, Zeiten in Minuten.
import { haversineM } from './pulse-core.js?v=mvxtwqwd';
import { BANDS, bandOf, CELL_LAT, CELL_LON, cellOf, cellCenter } from './pulse-track.js?v=mvxtwqwd';

export { BANDS, bandOf };

// Gewichte aus AHP (Saaty-Skala, Paarvergleich Nachfrage 3× Unterversorgung, 5× ÖPNV, 5× Abstellfläche;
// Unterversorgung 3× ÖPNV, 3× Abstellfläche; ÖPNV = Abstellfläche). Konsistenzquote CR = 0,016.
export const AHP = {
  criteria: ['demand', 'underserved', 'transit', 'parking'],
  labels: { demand: 'Nachfrage', underserved: 'Unterversorgung', transit: 'ÖPNV-Nähe', parking: 'Abstellfläche' },
  matrix: [[1, 3, 5, 5], [1 / 3, 1, 3, 3], [1 / 5, 1 / 3, 1, 1], [1 / 5, 1 / 3, 1, 1]],
  weights: { demand: 0.5596, underserved: 0.2495, transit: 0.0955, parking: 0.0955 },
  cr: 0.0161,
};
export const DEFAULTS = {
  spotRadiusM: 150, minSpacingM: 220, topN: 25, minPerSpot: 2, maxPerSpot: 15, horizonH: 3,
  vanCapacity: 20, swapCapacity: 50, workshopCapacity: 12, maxRuns: 6, maxPickupM: 4000,
  detour: 1.35, speedKmh: 18, pickupMin: 1.5, dropMin: 1.0, swapMin: 2.5, workshopMin: 3,
  swapThreshold: 25, minBatteryForMove: 30, idleSurplusMin: 24 * 60,
  maxRunMin: 240, // Einsatz je Tour höchstens 4 h (Fahrt + vor Ort); was nicht passt, bildet weitere Touren oder bleibt „nicht eingeplant“
};

const sum = (a) => a.reduce((x, y) => x + y, 0);
const quantile = (arr, q) => { const v = arr.filter(Number.isFinite).sort((a, b) => a - b); if (!v.length) return null; const i = Math.min(v.length - 1, Math.max(0, Math.floor(q * (v.length - 1)))); return v[i]; };
export const dist = (a, b) => haversineM(a.lat, a.lon, b.lat, b.lon);

// ---------- Geometrie ----------
function ringContains(ring, lon, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function geomContains(geom, lat, lon) {
  if (!geom) return false;
  const poly = (c) => ringContains(c[0], lon, lat) && !c.slice(1).some(h => ringContains(h, lon, lat));
  if (geom.type === 'Polygon') return poly(geom.coordinates);
  if (geom.type === 'MultiPolygon') return geom.coordinates.some(poly);
  return false;
}
// Geometrien mit Begrenzungsrechteck: Punkt-in-Polygon nur, wenn der Punkt im Rechteck liegt (viele Zonen × viele Zellen)
function boxed(geoms) {
  return (geoms || []).map(g => { const b = [Infinity, Infinity, -Infinity, -Infinity]; const walk = (c) => { if (typeof c[0] === 'number') { if (c[0] < b[0]) b[0] = c[0]; if (c[0] > b[2]) b[2] = c[0]; if (c[1] < b[1]) b[1] = c[1]; if (c[1] > b[3]) b[3] = c[1]; } else c.forEach(walk); }; walk(g.coordinates || []); return { g, b }; });
}
const boxedContains = (list, lat, lon) => list.some(({ g, b }) => lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3] && geomContains(g, lat, lon));
// Rasterindex für Punktmengen (≈ 330 m Zellen): Nachbarn in maxM, ohne jeden Punkt zu prüfen
const GRID_LAT = 0.003, GRID_LON = 0.005;
function gridIndex(points) {
  const g = new Map();
  for (const p of points || []) { const k = `${Math.floor(p.lat / GRID_LAT)}:${Math.floor(p.lon / GRID_LON)}`; const l = g.get(k); if (l) l.push(p); else g.set(k, [p]); }
  return (p, maxM) => {
    const r = Math.ceil(maxM / 250), i0 = Math.floor(p.lat / GRID_LAT), j0 = Math.floor(p.lon / GRID_LON), out = [];
    for (let i = i0 - r; i <= i0 + r; i++) for (let j = j0 - r; j <= j0 + r; j++) for (const q of g.get(`${i}:${j}`) || []) if (haversineM(p.lat, p.lon, q.lat, q.lon) <= maxM) out.push(q);
    return out;
  };
}

// ---------- Kontextdaten ----------
// GBFS-Zonen (zones/*.json): Abstellen verboten, wenn Fahrtende, Fahren oder Durchfahrt verboten ist
export function zoneConstraints(fc) {
  // GBFS: station_parking = Fahrt darf nur an einer Station des Anbieters enden (Pflicht-Abstellzone, MPZ).
  // Sonst gilt Abstellverbot, wenn Fahrtende, Fahrtbeginn/-ende (2.x ride_allowed) oder Durchfahrt verboten ist.
  const noPark = [], mandatory = [];
  for (const f of fc?.features || []) {
    const r = f.properties?.rules || []; if (!f.geometry) continue;
    if (r.some(x => x.parking === true) && !r.some(x => x.rideThrough === false)) mandatory.push(f.geometry);
    else if (r.some(x => x.endAllowed === false || x.rideAllowed === false || x.rideThrough === false)) noPark.push(f.geometry);
  }
  return { noPark, mandatory };
}
export const noParkGeometries = (fc) => zoneConstraints(fc).noPark;
const elPos = (e) => e.type === 'node' ? { lat: e.lat, lon: e.lon } : e.center ? { lat: e.center.lat, lon: e.center.lon } : null;
// OSM: E-Scooter-Stellflächen und Sharing-/Mobilitätspunkte getrennt von Radabstellanlagen
export function parkingFromOsm(elements) {
  const out = [];
  for (const e of elements || []) {
    const t = e.tags || {}, p = elPos(e); if (!p) continue;
    let cat = null;
    if (/^(kick-scooter_parking|small_vehicle_parking|small_electric_vehicle_parking)$/.test(t.amenity || '') || /^(designated|yes)$/.test(t.small_electric_vehicle || '') || /^(designated|yes)$/.test(t['kick-scooter'] || '')) cat = 'escooter';
    else if (/^(bicycle_rental|kick-scooter_rental|mobility_hub)$/.test(t.amenity || '') || t.public_transport === 'mobility_hub' || /mobilit(ä|ae)tspunkt|mobilstation|jelbi|hub/i.test(t.name || '')) cat = 'sharing';
    else if (t.amenity === 'bicycle_parking') cat = 'rad';
    if (cat) out.push({ ...p, cat, name: t.name || null, osm: `${e.type}/${e.id}` });
  }
  return out;
}
export function transitFromOsm(elements) {
  return (elements || []).filter(e => { const t = e.tags || {}; return t.highway === 'bus_stop' || t.public_transport === 'platform' || t.public_transport === 'stop_position' || /^(tram_stop|station|halt|subway_entrance)$/.test(t.railway || ''); }).map(elPos).filter(Boolean);
}
// Amtliche Geodaten (WFS, Open-Data-Portal) in lon/lat bringen: WFS 2.0 liefert EPSG:4326 je nach Server als lat/lon.
// In Deutschland (lat 47–55, lon 5–16) ist die Reihenfolge eindeutig erkennbar; projizierte Koordinaten (> 180) werden gezählt, nicht geraten.
export function lonLatFc(fc) {
  let swapped = 0, projected = 0, n = 0;
  const fix = (c) => { if (!Array.isArray(c)) return c; if (typeof c[0] !== 'number') return c.map(fix); n++;
    if (Math.abs(c[0]) > 180 || Math.abs(c[1]) > 90) { projected++; return c; }
    if (c[0] > 46 && c[0] < 56 && c[1] > 4 && c[1] < 17) { swapped++; return [c[1], c[0], ...c.slice(2)]; }
    return c; };
  const features = (fc?.features || []).map(f => f?.geometry ? { ...f, geometry: { ...f.geometry, coordinates: fix(f.geometry.coordinates) } } : f);
  return { type: 'FeatureCollection', features, swapped, projected, n };
}
const ringCenter = (r) => { const q = r.length > 3 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r.slice(0, -1) : r; return [sum(q.map(p => p[0])) / q.length, sum(q.map(p => p[1])) / q.length]; };
const featName = (pr = {}) => pr.name || pr.bezeichnung || pr.standort || pr.titel || pr.typ || null;
// Amtliche Abstellflächen (Berlin WFS abstell_mikromob, München Abstellflächen): Punkte, Multipunkte oder Flächen (→ Mittelpunkt)
export function parkingFromWfs(fc, cat = 'official') {
  const out = [];
  for (const f of fc?.features || []) {
    const g = f.geometry; if (!g) continue;
    const pts = g.type === 'Point' ? [g.coordinates] : g.type === 'MultiPoint' ? g.coordinates : g.type === 'Polygon' ? [ringCenter(g.coordinates[0])] : g.type === 'MultiPolygon' ? g.coordinates.map(p => ringCenter(p[0])) : [];
    for (const [lon, lat] of pts) if (Number.isFinite(lat) && Number.isFinite(lon)) out.push({ lat, lon, cat, name: featName(f.properties) });
  }
  return out;
}
// Amtliche Abstellverbotszonen (Berlin parkverbot_mikromob, München Geofences um Abstellflächen): Flächen als Ausschluss
export const noParkFromFc = (fc) => (fc?.features || []).map(f => f.geometry).filter(g => g && (g.type === 'Polygon' || g.type === 'MultiPolygon'));
// WFS-GetFeature als GeoJSON in WGS84; typeNames Standard „<letzter Pfadteil>:<letzter Pfadteil>“ (Berliner GDI-Muster)
export function wfsGetFeatureUrl(base, typeNames) {
  const u = new URL(base); const seg = u.pathname.split('/').filter(Boolean).pop();
  const tn = typeNames || u.searchParams.get('typeNames') || u.searchParams.get('typeName') || `${seg}:${seg}`;
  for (const k of [...u.searchParams.keys()]) if (/^(service|version|request|typenames?|outputformat|srsname)$/i.test(k)) u.searchParams.delete(k);
  for (const [k, v] of Object.entries({ service: 'WFS', version: '2.0.0', request: 'GetFeature', typeNames: tn, outputFormat: 'application/json', srsName: 'EPSG:4326' })) u.searchParams.set(k, v);
  return u.toString();
}
// Open-Data-Portal (CKAN, z. B. opendata.muenchen.de): aus package_show die Ressource wählen – GeoJSON vor JSON vor WFS
export function pickCkanResource(pkg, typeNames = null) {
  const res = (pkg?.result || pkg)?.resources || [];
  const fmt = (r) => `${r.format || ''} ${r.mimetype || ''}`.toLowerCase(), url = (r) => String(r.url || '');
  const gj = res.find(r => /geo\+?json/.test(fmt(r)) || /\.geojson(\?|$)/i.test(url(r))) || res.find(r => /(^|\s)json\b/.test(fmt(r)) || /\.json(\?|$)/i.test(url(r)));
  if (gj) return { url: url(gj), type: 'geojson' };
  const wfs = res.find(r => /wfs/.test(fmt(r)) || /service=wfs|\/wfs\b/i.test(url(r)));
  if (wfs) { const tn = typeNames || new URL(url(wfs)).searchParams.get('typeName') || new URL(url(wfs)).searchParams.get('typeNames'); if (tn) return { url: wfsGetFeatureUrl(url(wfs), tn), type: 'wfs' }; }
  return null;
}

// ---------- Flotte ----------
// ops/<Land>.json → Fahrzeuge als Objekte
export function decodeFleet(doc) {
  const vehicles = (doc?.vehicles || []).map(([lat, lon, op, ty, flags, bat, range, idleMin, m]) => ({
    lat, lon, operator: doc.ops[op], type: doc.types[ty] ?? 'unknown', reserved: !!(flags & 1), disabled: !!(flags & 2), battery: bat, rangeKm: range, idleMin, ags: doc.munis[m],
  }));
  const stations = (doc?.stations || []).map(([lat, lon, op, name, bookable, docks, capacity, m, renting, returning, physical]) => ({
    lat, lon, operator: doc.ops[op], name, bookable, docks, capacity, ags: doc.munis[m], renting: !!renting, returning: !!returning, physical,
  }));
  return { at: doc?.at ?? null, vehicles, stations };
}
export const isAvailable = (v) => !v.disabled && !v.reserved;
export function operatorShare(fleet, ags, operator) {
  const inMuni = fleet.vehicles.filter(v => v.ags === ags && isAvailable(v));
  if (!inMuni.length) return null;
  return inMuni.filter(v => v.operator === operator).length / inMuni.length;
}

// ---------- Nachfrage ----------
/**
 * Nachfragemodell je Zelle aus den Tagesdateien cells/<Tag>/<Land>.json.
 * band = 0…5 oder 'day'. Starts/Ziele sind Marktgrößen (alle Anbieter), Präsenz = Ø verfügbare Fahrzeuge je Lauf.
 */
export function buildDemandModel(cellDocs, ags, band = 'day') {
  const bands = band === 'day' ? BANDS.map(b => b.id) : [band];
  let hours = 0, runs = 0, days = 0;
  const cells = new Map();
  for (const doc of cellDocs) {
    if (!doc) continue;
    const m = doc.munis?.[ags]; if (!m) continue;
    const h = sum(bands.map(b => doc.bandMin?.[b] || 0)) / 60, r = sum(bands.map(b => doc.bandRuns?.[b] || 0));
    if (h <= 0 && r <= 0) continue;
    hours += h; runs += r; days++;
    for (const [cell, c] of Object.entries(m)) {
      if (c.length < 22) continue;
      const e = cells.get(cell) || { cell, starts: 0, ends: 0, presence: 0, reloc: 0 };
      for (const b of bands) { e.starts += c[4 + b]; e.presence += c[10 + b]; e.ends += c[16 + b]; }
      e.reloc += c[3];
      cells.set(cell, e);
    }
  }
  for (const e of cells.values()) {
    const [lat, lon] = cellCenter(e.cell);
    e.lat = lat; e.lon = lon;
    e.startsPerHour = hours > 0 ? e.starts / hours : null;
    e.endsPerHour = hours > 0 ? e.ends / hours : null;
    e.supplyAvg = runs > 0 ? e.presence / runs : 0;
    e.netPerHour = hours > 0 ? (e.ends - e.starts) / hours : null;
  }
  return { ags, band, hours, runs, days, cells };
}

// ---------- Deploy-Spots (MCDA) ----------
function standardize(model) {
  const list = [...model.cells.values()].filter(c => (c.startsPerHour ?? 0) > 0 && (c.presence > 0 || c.ends > 0));
  const p95 = quantile(list.map(c => c.startsPerHour), 0.95) || 1;
  const ratios = list.map(c => c.startsPerHour / (c.supplyAvg + 0.5));
  const r95 = quantile(ratios, 0.95) || 1;
  for (const c of list) {
    c.f = { demand: Math.min(1, c.startsPerHour / p95), underserved: Math.min(1, (c.startsPerHour / (c.supplyAvg + 0.5)) / r95) };
  }
  return list;
}
function nearestWithin(points, p, maxM) {
  let best = null, bd = Infinity;
  for (const q of points) { const d = haversineM(p.lat, p.lon, q.lat, q.lon); if (d < bd && d <= maxM) { bd = d; best = q; } }
  return best ? { item: best, d: bd } : null;
}
const PARK_RANK = { station: 0, escooter: 0, sharing: 1, official: 0, rad: 2 };

function rank(cands, weights, topN, minSpacingM) {
  const active = Object.keys(weights).filter(k => weights[k] > 0);
  const wsum = sum(active.map(k => weights[k]));
  for (const c of cands) c.score = sum(active.map(k => (weights[k] / wsum) * (c.f[k] ?? 0)));
  const sorted = [...cands].filter(c => !c.excluded).sort((a, b) => b.score - a.score || b.startsPerHour - a.startsPerHour);
  const out = [];
  for (const c of sorted) { if (out.length >= topN) break; if (out.some(o => haversineM(o.lat, o.lon, c.loc.lat, c.loc.lon) < minSpacingM)) continue; out.push({ ...c, lat: c.loc.lat, lon: c.loc.lon }); }
  return out;
}

/**
 * Deploy-Spots für einen Anbieter.
 * ctx: { transit: [{lat,lon}] | null, parking: [{lat,lon,cat,name}] | null, noPark: [geometry], mandatory: [geometry], officialNoPark: [geometry],
 *        stations: [{lat,lon,name}], share, horizonH, topN, minSpacingM, weights }
 * officialNoPark (Abstellverbot laut Stadt) ist wie noPark ein Ausschluss, gilt aber nicht für einen Spot auf einer ausgewiesenen
 * Abstellfläche (amtlich oder E-Scooter-Stellfläche): dort ist Abstellen erlaubt (München: Verbot im Umkreis, Fläche frei).
 */
export function scoreSpots(model, ctx = {}) {
  const o = { ...DEFAULTS, ...ctx };
  const share = o.share ?? 1;
  const cands = standardize(model);
  const weights = { ...AHP.weights, ...(o.weights || {}) };
  if (!o.transit) weights.transit = 0;
  if (!o.parking && !o.mandatory?.length) weights.parking = 0;
  const parkNear = gridIndex(o.parking), transitNear = gridIndex(o.transit), noPark = boxed(o.noPark), mandatory = boxed(o.mandatory), offNo = boxed(o.officialNoPark);
  for (const c of cands) {
    // Standort: offizielle/ausgewiesene Fläche in der Zelle, sonst Zellmitte
    let loc = { lat: c.lat, lon: c.lon }, park = null;
    if (o.parking?.length) {
      const near = parkNear(c, 160).sort((a, b) => (PARK_RANK[a.cat] ?? 3) - (PARK_RANK[b.cat] ?? 3) || haversineM(c.lat, c.lon, a.lat, a.lon) - haversineM(c.lat, c.lon, b.lat, b.lon));
      const pick = near.find(p => p.cat !== 'rad') || near.find(p => haversineM(c.lat, c.lon, p.lat, p.lon) <= 80);
      if (pick) { loc = { lat: pick.lat, lon: pick.lon }; park = pick; }
    }
    c.excluded = null;
    // Pflicht-Abstellzone: Spot nur an einer Station des Anbieters (≤ 150 m), sonst ausgeschlossen
    if (mandatory.length && boxedContains(mandatory, c.lat, c.lon)) {
      const st = nearestWithin(o.stations || [], c, 150);
      if (st) { loc = { lat: st.item.lat, lon: st.item.lon }; park = { cat: 'station', name: st.item.name || null }; }
      else c.excluded = 'Pflicht-Abstellzone ohne Station in 150 m';
    }
    c.loc = loc; c.park = park;
    c.f.transit = o.transit ? Math.min(1, transitNear(loc, 200).length / 3) : 0;
    c.f.parking = o.parking || park?.cat === 'station' ? (park ? (PARK_RANK[park.cat] <= 1 ? 1 : 0.5) : 0) : 0;
    if (!c.excluded && boxedContains(noPark, loc.lat, loc.lon)) c.excluded = 'Abstellverbot laut Betreiber-Zonen';
    if (!c.excluded && offNo.length && !(park && (park.cat === 'official' || park.cat === 'escooter')) && boxedContains(offNo, loc.lat, loc.lon)) c.excluded = 'Abstellverbot laut Stadt';
  }
  const why = (r) => cands.filter(c => c.excluded === r).length;
  const top = rank(cands, weights, o.topN, o.minSpacingM);
  // Sensitivität: jedes aktive Gewicht ±20 %, neu normiert
  const active = Object.keys(weights).filter(k => weights[k] > 0);
  const variants = [];
  for (const k of active) for (const f of [0.8, 1.2]) variants.push({ ...weights, [k]: weights[k] * f });
  const hits = new Map(top.map(t => [t.cell, 0]));
  for (const w of variants) { const r = rank(cands, w, o.topN, o.minSpacingM); for (const t of r) if (hits.has(t.cell)) hits.set(t.cell, hits.get(t.cell) + 1); }
  return {
    weights, activeFactors: active, excluded: cands.filter(c => c.excluded).length, candidates: cands.length, perturbations: variants.length,
    excludedBy: { operator: why('Abstellverbot laut Betreiber-Zonen'), mandatory: why('Pflicht-Abstellzone ohne Station in 150 m'), official: why('Abstellverbot laut Stadt') },
    spots: top.map((t, i) => {
      const sphOp = t.startsPerHour * share;
      const target = Math.max(o.minPerSpot, Math.min(o.maxPerSpot, Math.ceil(sphOp * o.horizonH)));
      const stab = variants.length ? hits.get(t.cell) / variants.length : 1;
      return { rank: i + 1, cell: t.cell, lat: t.lat, lon: t.lon, score: +t.score.toFixed(3), factors: Object.fromEntries(Object.entries(t.f).map(([k, v]) => [k, +v.toFixed(2)])),
        startsPerHour: +t.startsPerHour.toFixed(2), startsPerHourOp: +sphOp.toFixed(2), supplyAvg: +t.supplyAvg.toFixed(1), target,
        stability: +stab.toFixed(2), stabilityLabel: stab >= 0.999 ? 'stabil' : stab >= 0.75 ? 'mittel' : 'unsicher', park: t.park ? { cat: t.park.cat, name: t.park.name || null } : null };
    }),
  };
}

// ---------- Touren ----------
export const EXACT_MAX = 12; // orderStops: bis zu so vielen Stopps exakt
export function makeCost(o = {}) { const detour = o.detour ?? DEFAULTS.detour; return (a, b) => dist(a, b) * detour; }
// Reihenfolge: Nächster Nachbar + 2-opt + Or-opt (wie im Routenplaner-Skill). start/end: Punkte oder null. starts/exact: Probe mit 1 Start, ohne exakt.
// Kostenmatrix einmal je Tour, jede Verbesserung nur über die betroffenen Kanten (Delta); cost(a, b) bleibt
// injizierbar und darf asymmetrisch sein (OSRM-Matrix): dann zählt bei 2-opt auch die Umkehr der inneren Kanten.
export function orderStops(stops, { start = null, end = null, cost = makeCost(), starts: maxStarts = 6, exact = true } = {}) {
  const n = stops.length; if (n <= 1) return stops.slice();
  const pts = stops.slice(); const S = start ? pts.push(start) - 1 : -1, E = end ? pts.push(end) - 1 : -1, N = pts.length;
  const M = pts.map(a => pts.map(b => a === b ? 0 : cost(a, b)));
  let sym = true; for (let i = 0; i < N && sym; i++) for (let j = i + 1; j < N; j++) if (Math.abs(M[i][j] - M[j][i]) > 1e-6 * Math.max(1, Math.abs(M[i][j]))) { sym = false; break; }
  const e = (a, b) => a < 0 || b < 0 ? 0 : M[a][b];
  const total = (t) => { let s = e(S, t[0]) + e(t[n - 1], E); for (let i = 0; i < n - 1; i++) s += M[t[i]][t[i + 1]]; return s; };
  // Bis 12 Stopps exakt (Held-Karp wie im Routenplaner-Skill): garantiert kürzeste Reihenfolge, nie länger als die Heuristik
  if (exact && n <= EXACT_MAX) {
    const F = 1 << n, dp = new Float64Array(F * n).fill(Infinity), par = new Int8Array(F * n).fill(-1);
    for (let j = 0; j < n; j++) dp[(1 << j) * n + j] = e(S, j);
    for (let m = 1; m < F; m++) for (let j = 0; j < n; j++) {
      const v = dp[m * n + j]; if (v === Infinity || !(m & (1 << j))) continue;
      for (let k = 0; k < n; k++) if (!(m & (1 << k))) { const T = m | (1 << k), c = v + M[j][k]; if (c < dp[T * n + k]) { dp[T * n + k] = c; par[T * n + k] = j; } }
    }
    let bj = 0, bv = Infinity; for (let j = 0; j < n; j++) { const c = dp[(F - 1) * n + j] + e(j, E); if (c < bv) { bv = c; bj = j; } }
    const seq = []; for (let m = F - 1, j = bj; j >= 0;) { seq.push(j); const pj = par[m * n + j]; m &= ~(1 << j); j = pj; }
    return seq.reverse().map(i => stops[i]);
  }
  let best = null, bc = Infinity;
  const starts = Math.min(maxStarts, n); // wie bisher 6 Starts: gleiche Züge, gleiches Ergebnis, nur schneller bewertet
  for (let s = 0; s < starts; s++) {
    const left = [...Array(n).keys()], t = [];
    let cur = S;
    if (cur < 0 || s > 0) { cur = left.splice(s === 0 ? 0 : (s * 7919) % left.length, 1)[0]; t.push(cur); }
    while (left.length) { let bi = 0, bv = Infinity; for (let i = 0; i < left.length; i++) { const c = M[cur][left[i]]; if (c < bv) { bv = c; bi = i; } } cur = left.splice(bi, 1)[0]; t.push(cur); }
    // Präfixsummen der Kanten vorwärts/rückwärts, nur bei asymmetrischen Kosten nötig
    const F = new Float64Array(n), B = new Float64Array(n);
    const prefix = () => { if (sym) return; for (let i = 1; i < n; i++) { F[i] = F[i - 1] + M[t[i - 1]][t[i]]; B[i] = B[i - 1] + M[t[i]][t[i - 1]]; } };
    prefix();
    let improved = true, guard = 0;
    while (improved && guard++ < 60) {
      improved = false;
      // 2-opt: Abschnitt t[i..k] umkehren, Delta aus den zwei äußeren Kanten (+ innere bei Asymmetrie)
      for (let i = 0; i < n - 1; i++) for (let k = i + 1; k < n; k++) {
        const a = i > 0 ? t[i - 1] : S, d = k < n - 1 ? t[k + 1] : E;
        let delta = e(a, t[k]) - e(a, t[i]) + e(t[i], d) - e(t[k], d);
        if (!sym) delta += (B[k] - B[i]) - (F[k] - F[i]);
        if (delta < -1e-6) { for (let x = i, y = k; x < y; x++, y--) { const h = t[x]; t[x] = t[y]; t[y] = h; } prefix(); improved = true; }
      }
      // Or-opt: Abschnitt (1–3 Stopps) ohne Umkehr an anderer Stelle einfügen, Delta aus drei Kanten
      for (let L = 1; L <= 3; L++) for (let i = 0; i + L <= n; i++) {
        const u = t[i], v = t[i + L - 1], pu = i > 0 ? t[i - 1] : S, nv = i + L < n ? t[i + L] : E;
        const rem = e(pu, nv) - e(pu, u) - e(v, nv), m = n - L, rest = (q) => q < i ? t[q] : t[q + L];
        for (let p = 0; p <= m; p++) {
          if (p === i) continue;
          const a = p > 0 ? rest(p - 1) : S, b = p < m ? rest(p) : E;
          if (rem + e(a, u) + e(v, b) - e(a, b) < -1e-6) { const seg = t.splice(i, L); t.splice(p, 0, ...seg); prefix(); improved = true; break; }
        }
      }
    }
    const c = total(t); if (c < bc) { bc = c; best = t; }
  }
  return best.map(i => stops[i]);
}
// Stopps in Läufe gleicher Kapazität bündeln: Sweep vom Depot aus (weitester zuerst), dann die dem Tour-Mittelpunkt nächsten auffüllen.
// fit(run) → { back, ok }: Einsatzzeit prüfen; ein zu langer Lauf behält nur einen Teil (in place), back geht in den Vorrat zurück,
// ok = false: schon der nächstgelegene Auftrag allein ist zu lang (nicht eingeplant).
const centerOf = (pts) => ({ lat: sum(pts.map(p => p.lat)) / pts.length, lon: sum(pts.map(p => p.lon)) / pts.length });
export function clusterRuns(items, capacity, depot, maxRuns = Infinity, weight = () => 1, fit = null) {
  const dd = new Map(items.map(x => [x, dist(depot, x)])), byDepot = (a, b) => dd.get(b) - dd.get(a);
  const left = items.slice().sort(byDepot), runs = [], tooLong = []; // einmal sortiert, Reihenfolge bleibt beim Entnehmen
  while (left.length && runs.length < maxRuns) {
    const seed = left.shift(); const run = [seed]; let load = weight(seed), sl = seed.lat, so = seed.lon;
    while (left.length && load < capacity) {
      const cx = { lat: sl / run.length, lon: so / run.length };
      let bi = -1, bd = Infinity; for (let i = 0; i < left.length; i++) { const x = left[i]; if (load + weight(x) > capacity) continue; const d = dist(cx, x); if (d < bd) { bd = d; bi = i; } }
      if (bi < 0) break; const x = left.splice(bi, 1)[0]; run.push(x); load += weight(x); sl += x.lat; so += x.lon;
    }
    if (fit) { const f = fit(run); if (f.back.length) { left.push(...f.back); left.sort(byDepot); } if (!f.ok) { tooLong.push(...run); continue; } }
    runs.push(run);
  }
  return { runs, unplanned: [...left, ...tooLong] };
}
// Einsatzzeit je Tour begrenzen (Fahrt + vor Ort ≤ maxMin): Aufträge nach Abstand zum Tour-Mittelpunkt ordnen und per
// Halbierung die meisten nahen behalten, die noch passen; die fernen gehen zurück in den Vorrat und bilden eigene Touren.
// spread(x, c): Abstand eines Auftrags zum Mittelpunkt (Umsetzen: weiterer von Abhol- und Zielort). memo: fertige Tour je Lauf.
function timeCap(build, maxMin, spread = (x, c) => dist(c, x)) {
  const memo = new Map();
  const fit = (run) => {
    const all = build(run);
    if (!(maxMin > 0) || all.totalMin <= maxMin) { memo.set(run, all); return { back: [], ok: true }; }
    const c = centerOf(run), ranked = run.map(x => [x, spread(x, c)]).sort((a, b) => a[1] - b[1]).map(a => a[0]);
    // größtes k < n, für das die k nächsten passen; Probe schnell mit einem Startpunkt, danach die kürzere von Probe und voller Rechnung
    let lo = 0, hi = ranked.length - 1, probe = null;
    while (lo < hi) { const k = (lo + hi + 1) >> 1, r = build(ranked.slice(0, k), true); if (r.totalMin <= maxMin) { lo = k; probe = r; } else hi = k - 1; }
    const k = Math.max(1, lo); run.length = 0; run.push(...ranked.slice(0, k));
    if (probe) { const r = build(run); memo.set(run, r.totalMin <= probe.totalMin ? r : probe); }
    return { back: ranked.slice(k), ok: !!probe };
  };
  return { fit, built: (run) => memo.get(run) || build(run) };
}
function routeSummary(seq, o, cost) {
  let m = 0; for (let i = 0; i < seq.length - 1; i++) m += cost(seq[i], seq[i + 1]);
  return { km: +(m / 1000).toFixed(1), driveMin: Math.round((m / 1000) / o.speedKmh * 60) };
}
// gleiche Position (≤ 30 m) zu einem Stopp zusammenfassen
function groupStops(points, keyFn = () => '', maxM = 30) {
  const out = [];
  for (const p of points) { const g = out.find(s => s.key === keyFn(p) && dist(s, p) <= maxM); if (g) { g.items.push(p); g.count++; } else out.push({ lat: p.lat, lon: p.lon, key: keyFn(p), items: [p], count: 1 }); }
  return out;
}

/**
 * Rebalancing: Fahrzeuge aus Überschuss (lange Standzeit, wenig Nachfrage) zu Deploy-Spots mit Bedarf.
 * vehicles: verfügbare Fahrzeuge des Anbieters in der Gemeinde. model: Nachfragemodell (Band oder Tag).
 */
export function planRebalance({ spots, vehicles, model, share = 1, depot, ...opts }) {
  const o = { ...DEFAULTS, ...opts };
  const cost = makeCost(o);
  const near = new Map(spots.map(s => [s.cell, vehicles.filter(v => dist(s, v) <= o.spotRadiusM)]));
  const needs = spots.map(s => ({ spot: s, have: near.get(s.cell).length, need: Math.max(0, s.target - near.get(s.cell).length) }));
  const atSpot = new Set(spots.flatMap(s => near.get(s.cell)));
  // überbelegte Spots geben ihre am längsten stehenden Fahrzeuge ab
  const spotExtra = [];
  for (const s of spots) { const list = near.get(s.cell).slice().sort((a, b) => (b.idleMin ?? 0) - (a.idleMin ?? 0)); for (const v of list.slice(0, Math.max(0, list.length - s.target))) spotExtra.push(v); }
  // Überschuss je Zelle: Fahrzeuge über dem erwarteten Bedarf der Zelle im Horizont
  const byCell = new Map();
  for (const v of vehicles) { if (atSpot.has(v)) continue; const c = cellOf(v.lat, v.lon); if (!byCell.has(c)) byCell.set(c, []); byCell.get(c).push(v); }
  const surplus = [];
  for (const [cell, list] of byCell) {
    const sph = (model.cells.get(cell)?.startsPerHour ?? 0) * share;
    const keep = Math.ceil(sph * o.horizonH);
    const movable = list.filter(v => v.battery == null || v.battery >= o.minBatteryForMove).sort((a, b) => (b.idleMin ?? 0) - (a.idleMin ?? 0));
    const longIdle = movable.filter(v => (v.idleMin ?? 0) >= o.idleSurplusMin);
    const extra = movable.slice(0, Math.max(0, movable.length - keep));
    for (const v of new Set([...longIdle, ...extra])) surplus.push({ ...v, cell, cellDemand: +sph.toFixed(2) });
  }
  // Zuordnung: Spots nach Score, je fehlendem Fahrzeug das nächste Überschussfahrzeug
  for (const v of spotExtra) if (v.battery == null || v.battery >= o.minBatteryForMove) surplus.push({ ...v, cell: cellOf(v.lat, v.lon), fromSpot: true });
  // je Spot die Kandidaten in Reichweite einmal nach Entfernung sortieren (statt je fehlendem Fahrzeug den ganzen Pool)
  const taken = new Set(); const moves = [];
  for (const n of needs.sort((a, b) => b.spot.score - a.spot.score)) {
    const cands = surplus.map(v => ({ v, d: dist(v, n.spot) })).filter(x => x.d <= o.maxPickupM && !(x.v.fromSpot && x.d <= o.spotRadiusM)).sort((a, b) => a.d - b.d);
    let k = 0;
    for (const { v, d } of cands) { if (k >= n.need) break; if (taken.has(v)) continue; taken.add(v); k++; moves.push({ lat: v.lat, lon: v.lon, vehicle: v, spot: n.spot, distM: Math.round(d) }); }
  }
  const missing = sum(needs.map(n => n.need)) - moves.length;
  // Touren nach dem Mittelpunkt aus Abhol- und Zielort bündeln: jede Tour bleibt in einem Stadtbereich; Lage = weiterer der beiden Orte
  const mids = moves.map(m => ({ lat: (m.lat + m.spot.lat) / 2, lon: (m.lon + m.spot.lon) / 2, m }));
  const spread = (x, c) => Math.max(dist(c, x.m), dist(c, x.m.spot));
  const build = (run, quick) => {
    const g = run.map(x => x.m), st = quick ? 1 : 6;
    const pickups = groupStops(g, () => 'p');
    const drops = groupStops(g.map(m => ({ ...m.spot, move: m })), s => s.cell, 5);
    const pOrd = orderStops(pickups, { start: depot, cost, starts: st, exact: !quick });
    const dOrd = orderStops(drops, { start: pOrd[pOrd.length - 1], end: depot, cost, starts: st, exact: !quick });
    const r = routeSummary([depot, ...pOrd, ...dOrd, depot], o, cost);
    const handle = g.length * (o.pickupMin + o.dropMin);
    return { kind: 'rebalance', vehicles: g.length, stops: [...pOrd.map(s => ({ type: 'pickup', lat: s.lat, lon: s.lon, count: s.count, idleMaxH: Math.round(Math.max(...s.items.map(x => x.vehicle.idleMin ?? 0)) / 60), battery: s.items.map(x => x.vehicle.battery).filter(b => b != null) })),
      ...dOrd.map(s => ({ type: 'drop', lat: s.lat, lon: s.lon, count: s.count, spotRank: s.items[0].rank, target: s.items[0].target }))], ...r, handleMin: Math.round(handle), totalMin: r.driveMin + Math.round(handle) };
  };
  const cap = timeCap(build, o.maxRunMin, spread), cl = clusterRuns(mids, o.vanCapacity, depot, o.maxRuns, undefined, cap.fit);
  const runs = cl.runs.map((g, i) => ({ id: `R${i + 1}`, ...cap.built(g) }));
  return { needs: needs.sort((a, b) => a.spot.rank - b.spot.rank).map(n => ({ rank: n.spot.rank, cell: n.spot.cell, target: n.spot.target, have: n.have, need: n.need })), surplus: surplus.length, moves: moves.length, missing, unplanned: cl.unplanned.length, limitMin: o.maxRunMin, runs };
}

/**
 * Akku-Tausch: Fahrzeuge unter der Schwelle, priorisiert nach Ladestand und Nachfrage am Standort.
 */
export const MAX_SWAP = 50; // höchstens 50 Akkus je Tour (Ladekapazität eines Tauschfahrzeugs)
export function planSwaps({ vehicles, model, depot, ...opts }) {
  const o = { ...DEFAULTS, ...opts }; o.swapCapacity = Math.max(1, Math.min(MAX_SWAP, o.swapCapacity));
  const cost = makeCost(o);
  const low = vehicles.filter(v => !v.disabled && v.battery != null && v.battery < o.swapThreshold).map(v => ({ ...v }));
  const sphMax = Math.max(0.01, ...[...model.cells.values()].map(c => c.startsPerHour ?? 0));
  for (const v of low) {
    const d = (model.cells.get(cellOf(v.lat, v.lon))?.startsPerHour ?? 0) / sphMax;
    v.priority = +(0.6 * (1 - v.battery / o.swapThreshold) + 0.4 * Math.min(1, d) + ((v.idleMin ?? 0) > 360 ? 0.05 : 0)).toFixed(3);
  }
  const chosen = low.sort((a, b) => b.priority - a.priority).slice(0, o.swapCapacity * o.maxRuns);
  const build = (g, quick) => {
    const st = quick ? 1 : 6;
    const stops = groupStops(g, () => 's', 25);
    const ord = orderStops(stops, { start: depot, end: depot, cost, starts: st, exact: !quick });
    const r = routeSummary([depot, ...ord, depot], o, cost);
    const handle = g.length * o.swapMin;
    return { kind: 'swap', vehicles: g.length, stops: ord.map(s => ({ type: 'swap', lat: s.lat, lon: s.lon, count: s.count, battery: s.items.map(x => x.battery), priority: Math.max(...s.items.map(x => x.priority)) })), ...r, handleMin: Math.round(handle), totalMin: r.driveMin + Math.round(handle) };
  };
  const cap = timeCap(build, o.maxRunMin), { runs: groups, unplanned } = clusterRuns(chosen, o.swapCapacity, depot, o.maxRuns, undefined, cap.fit);
  const runs = groups.map((g, i) => ({ id: `S${i + 1}`, ...cap.built(g) }));
  return { below: low.length, chosen: chosen.length, unplanned: unplanned.length + (low.length - chosen.length), limitMin: o.maxRunMin, runs };
}

/** Werkstatt: gesperrte Fahrzeuge einsammeln und zum Depot bringen. */
export function planWorkshop({ vehicles, depot, ...opts }) {
  const o = { ...DEFAULTS, ...opts };
  const cost = makeCost(o);
  const dis = vehicles.filter(v => v.disabled).sort((a, b) => (b.idleMin ?? 0) - (a.idleMin ?? 0));
  const build = (g, quick) => {
    const st = quick ? 1 : 6;
    const stops = groupStops(g, () => 'w', 25);
    const ord = orderStops(stops, { start: depot, end: depot, cost, starts: st, exact: !quick });
    const r = routeSummary([depot, ...ord, depot], o, cost);
    const handle = g.length * o.workshopMin;
    return { kind: 'workshop', vehicles: g.length, stops: ord.map(s => ({ type: 'pickup_disabled', lat: s.lat, lon: s.lon, count: s.count, idleMaxH: Math.round(Math.max(...s.items.map(x => x.idleMin ?? 0)) / 60) })), ...r, handleMin: Math.round(handle), totalMin: r.driveMin + Math.round(handle) };
  };
  const cap = timeCap(build, o.maxRunMin), { runs: groups, unplanned } = clusterRuns(dis, o.workshopCapacity, depot, o.maxRuns, undefined, cap.fit);
  const runs = groups.map((g, i) => ({ id: `W${i + 1}`, ...cap.built(g) }));
  return { disabled: dis.length, unplanned: unplanned.length, limitMin: o.maxRunMin, runs };
}

/**
 * Stationsausgleich (stationsbasiertes Bikesharing): fast leere Stationen aus fast vollen auffüllen.
 * Füllgrad = buchbar / Kapazität (Kapazität fehlt → buchbar + freie Plätze). Ziel ist `fill` (Standard 50 %).
 */
export function planStationBalance({ stations, depot, low = 0.2, high = 0.8, fill = 0.5, ...opts }) {
  const o = { ...DEFAULTS, ...opts };
  const cost = makeCost(o);
  const list = stations.map(s => ({ ...s, cap: s.capacity ?? (s.docks != null && s.bookable != null ? s.docks + s.bookable : null) })).filter(s => s.cap > 0 && s.bookable != null);
  const deficits = [], givers = [];
  for (const s of list) {
    const rate = s.bookable / s.cap, target = Math.max(1, Math.round(s.cap * fill));
    if (rate <= low && s.renting !== false && s.returning !== false) deficits.push({ s, need: target - s.bookable });
    else if (rate >= high) givers.push({ s, give: s.bookable - target });
  }
  const moves = [];
  for (const d of deficits.sort((a, b) => b.need - a.need)) {
    for (let k = 0; k < d.need; k++) {
      let bi = -1, bd = Infinity; givers.forEach((g, i) => { if (g.give <= 0) return; const x = dist(g.s, d.s); if (x < bd) { bd = x; bi = i; } });
      if (bi < 0 || bd > o.maxPickupM) break;
      givers[bi].give--; moves.push({ lat: givers[bi].s.lat, lon: givers[bi].s.lon, from: givers[bi].s, to: d.s });
    }
  }
  const mids = moves.map(m => ({ lat: (m.lat + m.to.lat) / 2, lon: (m.lon + m.to.lon) / 2, m }));
  const spread = (x, c) => Math.max(dist(c, x.m), dist(c, x.m.to));
  const build = (run, quick) => {
    const g = run.map(x => x.m), st = quick ? 1 : 6;
    const pickups = groupStops(g, m => m.from.name || '', 5);
    const drops = groupStops(g.map(m => ({ lat: m.to.lat, lon: m.to.lon, to: m.to })), x => x.to.name || '', 5);
    const pOrd = orderStops(pickups, { start: depot, cost, starts: st, exact: !quick });
    const dOrd = orderStops(drops, { start: pOrd[pOrd.length - 1], end: depot, cost, starts: st, exact: !quick });
    const r = routeSummary([depot, ...pOrd, ...dOrd, depot], o, cost);
    const handle = g.length * (o.pickupMin + o.dropMin) * 0.6; // an Stationen schneller als frei abgestellt
    return { kind: 'station', vehicles: g.length, stops: [...pOrd.map(s => ({ type: 'pickup', lat: s.lat, lon: s.lon, count: s.count, station: s.items[0].from.name, fill: `${s.items[0].from.bookable}/${s.items[0].from.cap}` })),
      ...dOrd.map(s => ({ type: 'drop', lat: s.lat, lon: s.lon, count: s.count, station: s.items[0].to.name, fill: `${s.items[0].to.bookable}/${s.items[0].to.cap}` }))], ...r, handleMin: Math.round(handle), totalMin: r.driveMin + Math.round(handle) };
  };
  const cap = timeCap(build, o.maxRunMin, spread), cl = clusterRuns(mids, o.vanCapacity, depot, o.maxRuns, undefined, cap.fit);
  const runs = cl.runs.map((g, i) => ({ id: `B${i + 1}`, ...cap.built(g) }));
  return { stations: list.length, empty: deficits.length, full: givers.length, moves: moves.length, missing: sum(deficits.map(d => d.need)) - moves.length, unplanned: cl.unplanned.length, limitMin: o.maxRunMin, runs };
}

/** Navigationslinks: Google Maps erlaubt bis zu 10 Punkte je Link (Start, 8 Zwischenziele, Ziel). */
export function mapsLinks(points) {
  const pts = points.map(p => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`);
  const links = [];
  for (let i = 0; i < pts.length - 1; i += 9) links.push('https://www.google.com/maps/dir/' + pts.slice(i, i + 10).join('/'));
  return links;
}

/** Kennzahlen der Flotte eines Anbieters in einer Gemeinde. */
export function fleetKpis(vehicles, { swapThreshold = DEFAULTS.swapThreshold } = {}) {
  const avail = vehicles.filter(isAvailable);
  const withBat = vehicles.filter(v => v.battery != null && !v.disabled);
  const idleKnown = avail.filter(v => v.idleMin != null);
  return {
    total: vehicles.length, available: avail.length, disabled: vehicles.filter(v => v.disabled).length, reserved: vehicles.filter(v => v.reserved).length,
    low: withBat.filter(v => v.battery < swapThreshold).length, batteryKnown: withBat.length,
    idle24: idleKnown.filter(v => v.idleMin >= 1440).length, idle6: idleKnown.filter(v => v.idleMin >= 360).length, idleKnown: idleKnown.length,
    idleMedianH: idleKnown.length ? +(quantile(idleKnown.map(v => v.idleMin), 0.5) / 60).toFixed(1) : null,
  };
}

/** Exporte */
export function spotsCsv(spots, { name = 'Spot', radius = 15 } = {}) {
  const head = ['name', 'lat', 'lng', 'deploymentStatus', 'parkingStatus', 'deploymentRadius', 'deploymentVehicles'];
  const rows = spots.map(s => [`${name} ${String(s.rank).padStart(2, '0')}`, s.lat.toFixed(6), s.lon.toFixed(6), 'enabled', 'disabled', radius, s.target]);
  return [head, ...rows].map(r => r.join(',')).join('\n');
}
export function spotsAnalysisCsv(spots) {
  const head = ['rang', 'lat', 'lng', 'ziel_fzg', 'starts_je_h_markt', 'starts_je_h_anbieter', 'bestand_avg', 'score', 'f_nachfrage', 'f_unterversorgung', 'f_oepnv', 'f_abstellflaeche', 'stabilitaet', 'abstellflaeche'];
  const rows = spots.map(s => [s.rank, s.lat.toFixed(6), s.lon.toFixed(6), s.target, s.startsPerHour, s.startsPerHourOp, s.supplyAvg, s.score, s.factors.demand, s.factors.underserved, s.factors.transit ?? '', s.factors.parking ?? '', s.stabilityLabel, s.park ? `${s.park.cat}${s.park.name ? ' ' + s.park.name.replace(/[,;\n]/g, ' ') : ''}` : '']);
  return [head, ...rows].map(r => r.join(';')).join('\n');
}
export function runsCsv(runs, depot) {
  const head = ['tour', 'art', 'stopp', 'typ', 'lat', 'lng', 'anzahl', 'info'];
  const rows = [];
  for (const r of runs) {
    rows.push([r.id, r.kind, 0, 'depot', depot.lat.toFixed(6), depot.lon.toFixed(6), '', `${r.km} km · ${r.totalMin} min`]);
    r.stops.forEach((s, i) => rows.push([r.id, r.kind, i + 1, s.type, s.lat.toFixed(6), s.lon.toFixed(6), s.count, s.type === 'drop' ? `Spot ${s.spotRank} (Ziel ${s.target})` : s.battery?.length ? `Akku ${s.battery.join('/')} %` : s.idleMaxH != null ? `steht ${s.idleMaxH} h` : '']));
  }
  return [head, ...rows].map(r => r.join(';')).join('\n');
}
export function planGeoJson(spots, runs, depot) {
  const f = [];
  for (const s of spots) f.push({ type: 'Feature', properties: { kind: 'spot', rank: s.rank, target: s.target, score: s.score, stability: s.stabilityLabel }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } });
  for (const r of runs) {
    f.push({ type: 'Feature', properties: { kind: 'run', id: r.id, run: r.kind, km: r.km, minutes: r.totalMin, vehicles: r.vehicles }, geometry: { type: 'LineString', coordinates: [[depot.lon, depot.lat], ...r.stops.map(s => [s.lon, s.lat]), [depot.lon, depot.lat]] } });
    r.stops.forEach((s, i) => f.push({ type: 'Feature', properties: { kind: 'stop', run: r.id, seq: i + 1, type: s.type, count: s.count }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } }));
  }
  f.push({ type: 'Feature', properties: { kind: 'depot' }, geometry: { type: 'Point', coordinates: [depot.lon, depot.lat] } });
  return { type: 'FeatureCollection', features: f };
}
export { cellOf, cellCenter, CELL_LAT, CELL_LON };
