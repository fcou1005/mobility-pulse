// Mobility Pulse — Disposition: Nachfragemodell, Deploy-Spots, Rebalancing-, Swap- und Werkstatt-Touren.
// Reine Funktionen für Browser und Node. Entfernungen in Metern, Zeiten in Minuten.
import { haversineM } from './pulse-core.js?v=mvwvi5il';
import { BANDS, bandOf, CELL_LAT, CELL_LON, cellOf, cellCenter } from './pulse-track.js?v=mvwvi5il';

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
  vanCapacity: 20, swapCapacity: 30, workshopCapacity: 12, maxRuns: 6, maxPickupM: 4000,
  detour: 1.35, speedKmh: 18, pickupMin: 1.5, dropMin: 1.0, swapMin: 2.5, workshopMin: 3,
  swapThreshold: 25, minBatteryForMove: 30, idleSurplusMin: 24 * 60,
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

// ---------- Kontextdaten ----------
// GBFS-Zonen (zones/*.json): Abstellen verboten, wenn Fahrtende, Fahren oder Durchfahrt verboten ist
export function noParkGeometries(fc) {
  return (fc?.features || []).filter(f => (f.properties?.rules || []).some(r => r.endAllowed === false || r.rideAllowed === false || r.rideThrough === false)).map(f => f.geometry).filter(Boolean);
}
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
// Amtliche Abstellflächen (z. B. Berlin, WFS abstell_mikromob): Punkte oder Multipunkte
export function parkingFromWfs(fc, cat = 'official') {
  const out = [];
  for (const f of fc?.features || []) {
    const g = f.geometry; if (!g) continue;
    const pts = g.type === 'Point' ? [g.coordinates] : g.type === 'MultiPoint' ? g.coordinates : [];
    for (const [lon, lat] of pts) out.push({ lat, lon, cat, name: f.properties?.name || f.properties?.typ || null });
  }
  return out;
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
function countWithin(points, p, maxM) { let n = 0; for (const q of points) if (haversineM(p.lat, p.lon, q.lat, q.lon) <= maxM) n++; return n; }
const PARK_RANK = { escooter: 0, sharing: 1, official: 0, rad: 2 };

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
 * ctx: { transit: [{lat,lon}] | null, parking: [{lat,lon,cat,name}] | null, noPark: [geometry] , share, horizonH, topN, minSpacingM, weights }
 */
export function scoreSpots(model, ctx = {}) {
  const o = { ...DEFAULTS, ...ctx };
  const share = o.share ?? 1;
  const cands = standardize(model);
  const weights = { ...AHP.weights, ...(o.weights || {}) };
  if (!o.transit) weights.transit = 0;
  if (!o.parking) weights.parking = 0;
  for (const c of cands) {
    // Standort: offizielle/ausgewiesene Fläche in der Zelle, sonst Zellmitte
    let loc = { lat: c.lat, lon: c.lon }, park = null;
    if (o.parking?.length) {
      const near = o.parking.filter(p => haversineM(c.lat, c.lon, p.lat, p.lon) <= 160).sort((a, b) => (PARK_RANK[a.cat] ?? 3) - (PARK_RANK[b.cat] ?? 3) || haversineM(c.lat, c.lon, a.lat, a.lon) - haversineM(c.lat, c.lon, b.lat, b.lon));
      const pick = near.find(p => p.cat !== 'rad') || near.find(p => haversineM(c.lat, c.lon, p.lat, p.lon) <= 80);
      if (pick) { loc = { lat: pick.lat, lon: pick.lon }; park = pick; }
    }
    c.loc = loc; c.park = park;
    c.f.transit = o.transit ? Math.min(1, countWithin(o.transit, loc, 200) / 3) : 0;
    c.f.parking = o.parking ? (park ? (PARK_RANK[park.cat] <= 1 ? 1 : 0.5) : 0) : 0;
    c.excluded = (o.noPark || []).some(g => geomContains(g, loc.lat, loc.lon)) ? 'Abstellverbot laut Betreiber-Zonen' : null;
  }
  const top = rank(cands, weights, o.topN, o.minSpacingM);
  // Sensitivität: jedes aktive Gewicht ±20 %, neu normiert
  const active = Object.keys(weights).filter(k => weights[k] > 0);
  const variants = [];
  for (const k of active) for (const f of [0.8, 1.2]) variants.push({ ...weights, [k]: weights[k] * f });
  const hits = new Map(top.map(t => [t.cell, 0]));
  for (const w of variants) { const r = rank(cands, w, o.topN, o.minSpacingM); for (const t of r) if (hits.has(t.cell)) hits.set(t.cell, hits.get(t.cell) + 1); }
  return {
    weights, activeFactors: active, excluded: cands.filter(c => c.excluded).length, candidates: cands.length, perturbations: variants.length,
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
export function makeCost(o = {}) { const detour = o.detour ?? DEFAULTS.detour; return (a, b) => dist(a, b) * detour; }
// Reihenfolge: Nächster Nachbar + 2-opt + Or-opt (wie im Routenplaner-Skill). start/end: Punkte oder null.
export function orderStops(stops, { start = null, end = null, cost = makeCost() } = {}) {
  if (stops.length <= 1) return stops.slice();
  const tourCost = (t) => { let s = 0; const seq = [...(start ? [start] : []), ...t, ...(end ? [end] : [])]; for (let i = 0; i < seq.length - 1; i++) s += cost(seq[i], seq[i + 1]); return s; };
  let best = null, bc = Infinity;
  const starts = Math.min(6, stops.length);
  for (let s = 0; s < starts; s++) {
    const left = stops.slice(); const seq = [];
    let cur = start;
    if (!cur || s > 0) { const f = left.splice(s === 0 ? 0 : (s * 7919) % left.length, 1)[0]; seq.push(f); cur = f; }
    while (left.length) { let bi = 0, bv = Infinity; left.forEach((x, i) => { const c = cost(cur, x); if (c < bv) { bv = c; bi = i; } }); cur = left.splice(bi, 1)[0]; seq.push(cur); }
    let t = seq, improved = true, guard = 0;
    while (improved && guard++ < 60) {
      improved = false;
      for (let i = 0; i < t.length - 1; i++) for (let k = i + 1; k < t.length; k++) { const u = t.slice(0, i).concat(t.slice(i, k + 1).reverse(), t.slice(k + 1)); if (tourCost(u) < tourCost(t) - 1e-6) { t = u; improved = true; } }
      for (let L = 1; L <= 3; L++) for (let i = 0; i + L <= t.length; i++) { const seg = t.slice(i, i + L), rest = t.slice(0, i).concat(t.slice(i + L)); for (let p = 0; p <= rest.length; p++) { if (p === i) continue; const u = rest.slice(0, p).concat(seg, rest.slice(p)); if (tourCost(u) < tourCost(t) - 1e-6) { t = u; improved = true; break; } } }
    }
    const c = tourCost(t); if (c < bc) { bc = c; best = t; }
  }
  return best;
}
// Stopps in Läufe gleicher Kapazität bündeln: Sweep vom Depot aus, dann nächstgelegene auffüllen
export function clusterRuns(items, capacity, depot, maxRuns = Infinity, weight = () => 1) {
  const left = items.slice(); const runs = [];
  while (left.length && runs.length < maxRuns) {
    left.sort((a, b) => dist(depot, b) - dist(depot, a));
    const seed = left.shift(); const run = [seed]; let load = weight(seed);
    while (left.length && load < capacity) {
      const cx = { lat: sum(run.map(r => r.lat)) / run.length, lon: sum(run.map(r => r.lon)) / run.length };
      let bi = -1, bd = Infinity; left.forEach((x, i) => { if (load + weight(x) > capacity) return; const d = dist(cx, x); if (d < bd) { bd = d; bi = i; } });
      if (bi < 0) break; const x = left.splice(bi, 1)[0]; run.push(x); load += weight(x);
    }
    runs.push(run);
  }
  return { runs, unplanned: left };
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
  const pool = surplus.slice(); const moves = [];
  for (const n of needs.sort((a, b) => b.spot.score - a.spot.score)) {
    for (let k = 0; k < n.need && pool.length; k++) {
      let bi = -1, bd = Infinity; pool.forEach((v, i) => { if (v.fromSpot && dist(v, n.spot) <= o.spotRadiusM) return; const d = dist(v, n.spot); if (d < bd) { bd = d; bi = i; } });
      if (bi < 0 || bd > o.maxPickupM) break;
      const v = pool.splice(bi, 1)[0]; moves.push({ lat: v.lat, lon: v.lon, vehicle: v, spot: n.spot, distM: Math.round(bd) });
    }
  }
  const missing = sum(needs.map(n => n.need)) - moves.length;
  // Touren nach dem Mittelpunkt aus Abhol- und Zielort bündeln: jede Tour bleibt in einem Stadtbereich
  const mids = moves.map(m => ({ lat: (m.lat + m.spot.lat) / 2, lon: (m.lon + m.spot.lon) / 2, m }));
  const cl = clusterRuns(mids, o.vanCapacity, depot, o.maxRuns);
  const groups = cl.runs.map(g => g.map(x => x.m)), unplanned = cl.unplanned;
  const runs = groups.map((g, i) => {
    const pickups = groupStops(g, () => 'p');
    const drops = groupStops(g.map(m => ({ ...m.spot, move: m })), s => s.cell, 5);
    const pOrd = orderStops(pickups, { start: depot, cost });
    const dOrd = orderStops(drops, { start: pOrd[pOrd.length - 1], end: depot, cost });
    const seq = [depot, ...pOrd, ...dOrd, depot];
    const r = routeSummary(seq, o, cost);
    const handle = g.length * (o.pickupMin + o.dropMin);
    return { id: `R${i + 1}`, kind: 'rebalance', vehicles: g.length, stops: [...pOrd.map(s => ({ type: 'pickup', lat: s.lat, lon: s.lon, count: s.count, idleMaxH: Math.round(Math.max(...s.items.map(x => x.vehicle.idleMin ?? 0)) / 60), battery: s.items.map(x => x.vehicle.battery).filter(b => b != null) })),
      ...dOrd.map(s => ({ type: 'drop', lat: s.lat, lon: s.lon, count: s.count, spotRank: s.items[0].rank, target: s.items[0].target }))], ...r, handleMin: Math.round(handle), totalMin: r.driveMin + Math.round(handle) };
  });
  return { needs: needs.sort((a, b) => a.spot.rank - b.spot.rank).map(n => ({ rank: n.spot.rank, cell: n.spot.cell, target: n.spot.target, have: n.have, need: n.need })), surplus: surplus.length, moves: moves.length, missing, unplanned: unplanned.length, runs };
}

/**
 * Akku-Tausch: Fahrzeuge unter der Schwelle, priorisiert nach Ladestand und Nachfrage am Standort.
 */
export function planSwaps({ vehicles, model, depot, ...opts }) {
  const o = { ...DEFAULTS, ...opts };
  const cost = makeCost(o);
  const low = vehicles.filter(v => !v.disabled && v.battery != null && v.battery < o.swapThreshold).map(v => ({ ...v }));
  const sphMax = Math.max(0.01, ...[...model.cells.values()].map(c => c.startsPerHour ?? 0));
  for (const v of low) {
    const d = (model.cells.get(cellOf(v.lat, v.lon))?.startsPerHour ?? 0) / sphMax;
    v.priority = +(0.6 * (1 - v.battery / o.swapThreshold) + 0.4 * Math.min(1, d) + ((v.idleMin ?? 0) > 360 ? 0.05 : 0)).toFixed(3);
  }
  const chosen = low.sort((a, b) => b.priority - a.priority).slice(0, o.swapCapacity * o.maxRuns);
  const { runs: groups, unplanned } = clusterRuns(chosen, o.swapCapacity, depot, o.maxRuns);
  const runs = groups.map((g, i) => {
    const stops = groupStops(g, () => 's', 25);
    const ord = orderStops(stops, { start: depot, end: depot, cost });
    const r = routeSummary([depot, ...ord, depot], o, cost);
    const handle = g.length * o.swapMin;
    return { id: `S${i + 1}`, kind: 'swap', vehicles: g.length, stops: ord.map(s => ({ type: 'swap', lat: s.lat, lon: s.lon, count: s.count, battery: s.items.map(x => x.battery), priority: Math.max(...s.items.map(x => x.priority)) })), ...r, handleMin: Math.round(handle), totalMin: r.driveMin + Math.round(handle) };
  });
  return { below: low.length, chosen: chosen.length, unplanned: unplanned.length + (low.length - chosen.length), runs };
}

/** Werkstatt: gesperrte Fahrzeuge einsammeln und zum Depot bringen. */
export function planWorkshop({ vehicles, depot, ...opts }) {
  const o = { ...DEFAULTS, ...opts };
  const cost = makeCost(o);
  const dis = vehicles.filter(v => v.disabled).sort((a, b) => (b.idleMin ?? 0) - (a.idleMin ?? 0));
  const { runs: groups, unplanned } = clusterRuns(dis, o.workshopCapacity, depot, o.maxRuns);
  const runs = groups.map((g, i) => {
    const stops = groupStops(g, () => 'w', 25);
    const ord = orderStops(stops, { start: depot, end: depot, cost });
    const r = routeSummary([depot, ...ord, depot], o, cost);
    const handle = g.length * o.workshopMin;
    return { id: `W${i + 1}`, kind: 'workshop', vehicles: g.length, stops: ord.map(s => ({ type: 'pickup_disabled', lat: s.lat, lon: s.lon, count: s.count, idleMaxH: Math.round(Math.max(...s.items.map(x => x.idleMin ?? 0)) / 60) })), ...r, handleMin: Math.round(handle), totalMin: r.driveMin + Math.round(handle) };
  });
  return { disabled: dis.length, unplanned: unplanned.length, runs };
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
  const cl = clusterRuns(mids, o.vanCapacity, depot, o.maxRuns);
  const groups = cl.runs.map(g => g.map(x => x.m)), unplanned = cl.unplanned;
  const runs = groups.map((g, i) => {
    const pickups = groupStops(g, m => m.from.name || '', 5);
    const drops = groupStops(g.map(m => ({ lat: m.to.lat, lon: m.to.lon, to: m.to })), x => x.to.name || '', 5);
    const pOrd = orderStops(pickups, { start: depot, cost });
    const dOrd = orderStops(drops, { start: pOrd[pOrd.length - 1], end: depot, cost });
    const r = routeSummary([depot, ...pOrd, ...dOrd, depot], o, cost);
    const handle = g.length * (o.pickupMin + o.dropMin) * 0.6; // an Stationen schneller als frei abgestellt
    return { id: `B${i + 1}`, kind: 'station', vehicles: g.length, stops: [...pOrd.map(s => ({ type: 'pickup', lat: s.lat, lon: s.lon, count: s.count, station: s.items[0].from.name, fill: `${s.items[0].from.bookable}/${s.items[0].from.cap}` })),
      ...dOrd.map(s => ({ type: 'drop', lat: s.lat, lon: s.lon, count: s.count, station: s.items[0].to.name, fill: `${s.items[0].to.bookable}/${s.items[0].to.cap}` }))], ...r, handleMin: Math.round(handle), totalMin: r.driveMin + Math.round(handle) };
  });
  return { stations: list.length, empty: deficits.length, full: givers.length, moves: moves.length, missing: sum(deficits.map(d => d.need)) - moves.length, unplanned: unplanned.length, runs };
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
