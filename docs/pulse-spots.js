// Mobility Pulse — Spot-Abgleich: Park- und Abstellflächen aus den offenen Feeds (GBFS station_information, meist virtuelle
// Stationen) je Anbieter gegeneinander, aus Sicht eines eigenen Anbieters: was bei mir fehlt, was nur ich habe, was gepflegt werden muss.
// Reine Rechenfunktionen ohne DOM (Browser und Node). Grundlagen: ops/<Land>.json (decodeFleet), stations-quota.json (Leerquote bis 7 Tage),
// optional das Nachfragemodell aus cells/<Tag>/<Land>.json (buildDemandModel) und die GBFS-Zonen des eigenen Anbieters (zones/*.json).
import { RADII, DEFAULT_RADIUS, distM, gridIndex, compareOperators } from './pulse-compare.js?v=mw67jj04';
import { cellOf, csvCell, needOf, operatorShare, geomContains, isAvailable, DEFAULTS, GROUP_MIN } from './pulse-ops.js?v=mw67jj04';
import { STATION_NEAR_M } from './pulse-core.js?v=mw67jj04';

export { RADII, DEFAULT_RADIUS, STATION_NEAR_M };
export const DUP_M = 25;          // eigene Spots näher als 25 m = Dublette
export const EMPTY_SHARE = 0.9;   // dauerhaft leer: mindestens 90 % der Sammler-Läufe leer …
export const MIN_RUNS = 36;       // … bei mindestens 36 Läufen (≈ 12 Std., Tag und Nacht)
export const QUOTA_MATCH_M = 15;  // Leerquote: Station der Quote ≤ 15 m (gleicher Anbieter, gleicher Name bevorzugt)
export const DEPLOY_RADIUS = 15;  // deploymentRadius im Backend-Export, wie die Spots-CSV der Disposition (lib/pulse-ops.js spotsCsv)
export const SPOTS_CSV_FIELDS = ['name', 'lat', 'lng', 'deploymentStatus', 'parkingStatus', 'deploymentRadius', 'deploymentVehicles'];
const QUOTA_FIELDS = ['ags', 'operator', 'name', 'lat', 'lon', 'runs', 'emptyRuns', 'fullRuns', 'virtual'];

const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))] : null);
const COORD_NAME = /^\s*-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+\s*$/;
/** Anzeigename: Steuerzeichen (Tab im Feed) und Mehrfach-Leerzeichen weg; reine Koordinaten zählen als „ohne Namen“ ('') */
export const cleanName = (n) => { const s = String(n ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim(); return !s || COORD_NAME.test(s) ? '' : s; };

/** stations-quota.json → Zeilen der Gemeinde ags als Objekte */
export function quotaRows(doc, ags) {
  const ix = Object.fromEntries((doc?.fields || QUOTA_FIELDS).map((f, i) => [f, i]));
  return (doc?.stations || []).filter(r => r[ix.ags] === ags && Number.isFinite(r[ix.lat]) && Number.isFinite(r[ix.lon]))
    .map(r => ({ operator: r[ix.operator], name: r[ix.name], lat: r[ix.lat], lon: r[ix.lon], runs: +r[ix.runs] || 0, emptyRuns: +r[ix.emptyRuns] || 0, fullRuns: +r[ix.fullRuns] || 0, virtual: r[ix.virtual] }));
}

/**
 * Spots der Gemeinde: Stationen aus ops/<Land>.json mit Leerquote (stations-quota.json, gleicher Anbieter ≤ 15 m, gleicher Name bevorzugt,
 * sonst nächste ≤ 5 m; jede Quote-Zeile höchstens einmal). virtuell laut Quote (is_virtual_station), sonst: ohne freie Plätze (Docks) = virtuell.
 * kind 'virtual' = nur virtuelle Stationen (Abstellflächen), 'all' = alle.
 */
export function spotsOf(fleet, { ags, quota = null, kind = 'virtual' } = {}) {
  const q = quota ? quotaRows(quota, ags) : [];
  const qIdx = gridIndex(q, QUOTA_MATCH_M), used = new Set();
  const all = (fleet?.stations || []).filter(s => s.ags === ags && s.operator && Number.isFinite(s.lat) && Number.isFinite(s.lon)).map((s, i) => {
    const cands = qIdx.within(s, r => r.operator === s.operator && !used.has(r));
    const m = (cands.find(c => c.p.name === s.name) || cands.find(c => c.d <= 5))?.p || null;
    if (m) used.add(m);
    const runs = m ? m.runs : 0;
    return { id: i, operator: s.operator, name: s.name ?? '', label: cleanName(s.name), lat: s.lat, lon: s.lon, bookable: s.bookable ?? null, capacity: s.capacity ?? null, docks: s.docks ?? null,
      renting: s.renting !== false, returning: s.returning !== false, virtual: m ? m.virtual === 1 : s.docks == null,
      runs, emptyRuns: m ? m.emptyRuns : 0, emptyShare: runs ? m.emptyRuns / runs : null };
  });
  return kind === 'all' ? all : all.filter(s => s.virtual);
}

// GBFS-Zonen des eigenen Anbieters: nur „Durchfahrt verboten“ (ride_through_allowed = false) ist sauber ein Befund – dort kann kein Fahrzeug
// den Spot erreichen. ride_allowed = false heißt in GBFS: freies Abstellen (undocked) verboten; ein Spot dort ist meist gerade die erlaubte
// Fläche (Stuttgart: 47 von 52 Bolt-Spots) und wird nur gezählt, nicht gemeldet.
function bbox(g) { const b = [Infinity, Infinity, -Infinity, -Infinity]; const walk = (c) => { if (typeof c[0] === 'number') { if (c[0] < b[0]) b[0] = c[0]; if (c[0] > b[2]) b[2] = c[0]; if (c[1] < b[1]) b[1] = c[1]; if (c[1] > b[3]) b[3] = c[1]; } else c.forEach(walk); }; walk(g.coordinates || []); return b; }
export function zoneClasses(fcs, operator) {
  const noThrough = [], noFree = []; let files = 0;
  for (const fc of fcs || []) {
    if (!fc || (operator && fc.operator && fc.operator !== operator)) continue; files++;
    for (const f of fc.features || []) {
      const g = f.geometry, r = f.properties?.rules || []; if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) continue;
      const z = { g, b: bbox(g), name: cleanName(f.properties?.name) || null };
      if (r.some(x => x.rideThrough === false)) noThrough.push(z);
      else if (r.some(x => x.rideAllowed === false || x.endAllowed === false) && !r.some(x => x.parking === true)) noFree.push(z);
    }
  }
  return { files, noThrough, noFree };
}
const hit = (list, p) => list.find(({ g, b }) => p.lon >= b[0] && p.lon <= b[2] && p.lat >= b[1] && p.lat <= b[3] && geomContains(g, p.lat, p.lon)) || null;

/** Nachfrage am Ort aus dem Modell (Fahrtbeginne aller Anbieter je ≈ 250-m-Zelle und Messstunde); null ohne Modell */
function demandStats(model) {
  if (!model || !(model.hours > 0)) return null;
  const sph = [...model.cells.values()].map(c => c.startsPerHour).filter(x => x > 0).sort((a, b) => a - b);
  return { model, hours: model.hours, days: model.days, cells: sph.length, sorted: sph, p50: quantile(sph, 0.5), p95: quantile(sph, 0.95) || 1 };
}
function demandAt(D, p) {
  if (!D) return null;
  const c = D.model.cells.get(cellOf(p.lat, p.lon)), v = c?.startsPerHour ?? 0;
  let lo = 0, hi = D.sorted.length; while (lo < hi) { const m = (lo + hi) >> 1; if (D.sorted[m] < v) lo = m + 1; else hi = m; } // Anteil der Zellen mit weniger Nachfrage
  return { cell: c || null, startsPerHour: v, starts: c?.starts ?? 0, factor: Math.min(1, v / D.p95), pct: D.sorted.length ? lo / D.sorted.length : null, high: D.p50 != null && v > 0 && v >= D.p50 };
}

/** eigene Spots < dupM: Gruppen (verkettet); je Gruppe bleibt der Spot mit der niedrigsten Leerquote (dann mit Namen, mehr buchbar, kleinere id) */
function duplicates(own, dupM) {
  const idx = gridIndex(own, dupM), parent = new Map(own.map(s => [s, s]));
  const find = (s) => { while (parent.get(s) !== s) { parent.set(s, parent.get(parent.get(s))); s = parent.get(s); } return s; };
  for (const s of own) for (const { p } of idx.within(s)) { const a = find(s), b = find(p); if (a !== b) parent.set(a, b); }
  const groups = new Map(); for (const s of own) { const r = find(s); (groups.get(r) || groups.set(r, []).get(r)).push(s); }
  const out = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => (a.emptyShare ?? 1) - (b.emptyShare ?? 1) || (b.label ? 1 : 0) - (a.label ? 1 : 0) || (b.bookable ?? 0) - (a.bookable ?? 0) || a.id - b.id);
    const keep = g[0];
    for (const s of g.slice(1)) out.push({ spot: s, keep, d: Math.round(distM(s, keep)) });
  }
  return out;
}

const nearestAny = (p, list) => { let best = null; for (const q of list) { if (q === p) continue; const d = distM(p, q); if (!best || d < best.d) best = { p: q, d }; } return best; };
const pick = (s) => ({ id: s.id, operator: s.operator, name: s.name, label: s.label, lat: s.lat, lon: s.lon, bookable: s.bookable, runs: s.runs, emptyShare: s.emptyShare, virtual: s.virtual });

/**
 * Abgleich in der Gemeinde ags aus Sicht des Anbieters own (Standard: meiste Spots), Umkreis radiusM (25/50/100 m).
 * rows: je Anbieter Spots (virtuell/physisch), je km² belegter Fläche und je 1.000 Fahrzeuge, Anteil der Fahrzeuge an einem eigenen Spot (≤ Umkreis),
 *   dauerhaft leer (≥ emptyShare der Läufe, ≥ minRuns), Dubletten (< dupM, überzählige Spots), Differenz zum eigenen Anbieter,
 *   matched/unmatched (andere: mit/ohne eigenen Spot im Umkreis; eigener: mit/ohne fremden Spot im Umkreis).
 * missing („Fehlt bei mir“): fremde Spots ohne eigenen im Umkreis, zu Orten gebündelt (Mittelpunkt ≤ Umkreis; dichteste Orte zuerst),
 *   Punkte = Anbieter dort (je 1) + Nachfrage (Fahrtbeginne/h der Zelle ÷ 95. Perzentil, ≤ 1) + eigene Fahrzeuge ohne Spot (÷ GROUP_MIN, ≤ 1).
 * onlyMine („Nur bei mir“): eigene Spots ohne fremden im Umkreis. care („Pflegebedarf“): Durchfahrt verboten (eigene Zone), Dublette, dauerhaft leer.
 * Jeder Eintrag trägt export = { deploymentStatus, parkingStatus, deploymentVehicles } für die Backend-CSV.
 */
export function analyzeSpots(fleet, { ags, own = null, radiusM = DEFAULT_RADIUS, kind = 'virtual', quota = null, demand = null, zones = null, dupM = DUP_M, emptyShare = EMPTY_SHARE, minRuns = MIN_RUNS } = {}) {
  const spots = spotsOf(fleet, { ags, quota, kind });
  const cmp = compareOperators(fleet, { ags, radiusM });
  const veh = cmp.vehicles;
  const nSpots = new Map(); for (const s of spots) nSpots.set(s.operator, (nSpots.get(s.operator) || 0) + 1);
  const nVeh = new Map(cmp.rows.filter(r => r.vehicles > 0).map(r => [r.op, r.vehicles])); // ohne Spots dieser Art und ohne Fahrzeuge: nicht dabei
  const operators = [...new Set([...nSpots.keys(), ...nVeh.keys()])].sort((a, b) => (nSpots.get(b) || 0) - (nSpots.get(a) || 0) || (nVeh.get(b) || 0) - (nVeh.get(a) || 0) || a.localeCompare(b, 'de'));
  if (!own || !operators.includes(own)) own = operators.find(o => nSpots.get(o)) ?? operators[0] ?? null;
  const D = demandStats(demand);
  const share = own ? operatorShare(fleet, ags, own) : null;
  const target = (p) => { const d = demandAt(D, p); return d?.cell && d.startsPerHour > 0 && share ? needOf(d.cell, share).target : 0; }; // ohne gemessene Fahrtbeginne kein Vorschlag
  const isPermEmpty = (s) => s.runs >= minRuns && s.emptyShare != null && s.emptyShare >= emptyShare;

  // Nachbarschaft: Spots untereinander, Fahrzeuge zu Spots
  const sIdx = gridIndex(spots, radiusM), vIdx = gridIndex(veh, radiusM);
  for (const s of spots) {
    s.ownNear = s.operator === own ? null : sIdx.near(s, q => q.operator === own);
    s.foreignNear = sIdx.near(s, q => q.operator !== s.operator);
    s.vehNow = vIdx.within(s, v => v.operator === s.operator && !v.disabled && !v.reserved).length; // jetzt verfügbare eigene Fahrzeuge im Umkreis
    s.permEmpty = isPermEmpty(s);
  }
  const atOwnSpot = (v) => !!sIdx.near(v, q => q.operator === v.operator);
  const ownSpots = spots.filter(s => s.operator === own);
  const dupsByOp = new Map(operators.map(o => [o, duplicates(spots.filter(s => s.operator === o), dupM)]));
  const ownCount = nSpots.get(own) || 0;
  const areaOf = new Map(cmp.rows.map(r => [r.op, r.areaKm2]));
  const rows = operators.map(op => {
    const ss = spots.filter(s => s.operator === op), vs = veh.filter(v => v.operator === op), isOwn = op === own;
    const matched = isOwn ? ss.filter(s => s.foreignNear).length : ss.filter(s => s.ownNear).length;
    const known = ss.filter(s => s.runs >= minRuns), area = areaOf.get(op) || null;
    return {
      op, own: isOwn, spots: ss.length, virtual: ss.filter(s => s.virtual).length, physical: ss.filter(s => !s.virtual).length, vehicles: vs.length, areaKm2: area,
      perKm2: area && ss.length ? ss.length / area : null, per1000: vs.length ? ss.length / vs.length * 1000 : null,
      atSpot: vs.length && ss.length ? vs.filter(atOwnSpot).length / vs.length : vs.length ? 0 : null,
      quotaKnown: known.length, permEmpty: known.filter(s => s.permEmpty).length, dupExtra: dupsByOp.get(op).length,
      diff: isOwn ? null : ss.length - ownCount, matched, unmatched: ss.length - matched,
    };
  });

  // a) Fehlt bei mir: fremde Spots ohne eigenen Spot im Umkreis → Orte
  const cand = spots.filter(s => s.operator !== own && !s.ownNear);
  const cIdx = gridIndex(cand, radiusM);
  const dens = new Map(cand.map(s => { const nb = cIdx.within(s); return [s, { ops: new Set([s.operator, ...nb.map(x => x.p.operator)]).size, n: nb.length }]; }));
  cand.sort((a, b) => dens.get(b).ops - dens.get(a).ops || dens.get(b).n - dens.get(a).n || a.lat - b.lat || a.lon - b.lon || a.operator.localeCompare(b.operator, 'de'));
  const dLat = radiusM / 111195, dLon = dLat / Math.max(0.2, Math.cos((cand[0]?.lat ?? 50) * Math.PI / 180)), grid = new Map();
  const gk = (p) => `${Math.floor(p.lat / dLat)}:${Math.floor(p.lon / dLon)}`;
  const put = (pl) => { pl.k = gk(pl); (grid.get(pl.k) || grid.set(pl.k, []).get(pl.k)).push(pl); }, drop = (pl) => { const l = grid.get(pl.k); l.splice(l.indexOf(pl), 1); };
  const places = [];
  for (const s of cand) {
    const i = Math.floor(s.lat / dLat), j = Math.floor(s.lon / dLon); let best = null, bd = Infinity;
    for (let a = i - 1; a <= i + 1; a++) for (let b = j - 1; b <= j + 1; b++) for (const pl of grid.get(`${a}:${b}`) || []) { const d = distM(pl, s); if (d <= radiusM && d < bd) { bd = d; best = pl; } }
    if (!best) { best = { lat: s.lat, lon: s.lon, members: [] }; places.push(best); put(best); }
    drop(best); best.members.push(s);
    best.lat = best.members.reduce((x, m) => x + m.lat, 0) / best.members.length; best.lon = best.members.reduce((x, m) => x + m.lon, 0) / best.members.length;
    put(best);
  }
  const ownVehNoSpot = (p) => vIdx.within(p, v => v.operator === own && !atOwnSpot(v)).length;
  const missing = places.map(pl => {
    const members = pl.members.slice().sort((a, b) => a.operator.localeCompare(b.operator, 'de') || a.id - b.id);
    const byOp = new Map(); for (const m of members) byOp.set(m.operator, (byOp.get(m.operator) || 0) + 1);
    const ops = [...byOp.keys()].sort((a, b) => byOp.get(b) - byOp.get(a) || a.localeCompare(b, 'de'));
    let spread = 0; for (const a of members) for (const b of members) spread = Math.max(spread, distM(a, b));
    const p = { lat: pl.lat, lon: pl.lon }, dem = demandAt(D, p), vehN = ownVehNoSpot(p), near = nearestAny(p, ownSpots);
    const qk = members.filter(m => m.runs >= minRuns), otherEmpty = qk.length ? qk.reduce((x, m) => x + m.emptyShare, 0) / qk.length : null;
    const score = ops.length + (dem?.factor ?? 0) + Math.min(1, vehN / GROUP_MIN);
    const reasons = [{ k: 'ops', ops, n: members.length, spread: Math.round(spread) }];
    if (dem) reasons.push(dem.startsPerHour > 0 ? { k: 'demand', v: dem.startsPerHour, pct: dem.pct } : { k: 'noDemand' });
    if (vehN) reasons.push({ k: 'veh', n: vehN });
    if (otherEmpty != null && otherEmpty >= emptyShare) reasons.push({ k: 'otherEmpty', share: otherEmpty });
    reasons.push(near ? { k: 'nearOwn', d: Math.round(near.d), name: near.p.label } : { k: 'noOwn' });
    return { lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6), label: members.map(m => m.label).find(Boolean) || '', ops, byOp: Object.fromEntries(byOp), nOps: ops.length, members: members.map(pick), spread: Math.round(spread),
      demand: dem ? { startsPerHour: dem.startsPerHour, starts: dem.starts, factor: dem.factor, pct: dem.pct } : null, ownVehicles: vehN, otherEmpty, nearestOwn: near ? { d: Math.round(near.d), label: near.p.label, id: near.p.id } : null,
      score: +score.toFixed(3), reasons, export: { deploymentStatus: 'disabled', parkingStatus: 'enabled', deploymentVehicles: target(p) } };
  }).sort((a, b) => b.score - a.score || b.members.length - a.members.length || a.lat - b.lat || a.lon - b.lon);
  missing.forEach((x, i) => { x.rank = i + 1; });

  // b) Nur bei mir
  const foreign = spots.filter(s => s.operator !== own);
  const onlyMine = ownSpots.filter(s => !s.foreignNear).map(s => {
    const n = nearestAny(s, foreign), dem = demandAt(D, s);
    return { ...pick(s), vehNow: s.vehNow, permEmpty: s.permEmpty, demand: dem ? { startsPerHour: dem.startsPerHour, factor: dem.factor, pct: dem.pct } : null,
      nearestOther: n ? { operator: n.p.operator, label: n.p.label, d: Math.round(n.d) } : null,
      export: { deploymentStatus: 'disabled', parkingStatus: s.returning ? 'enabled' : 'disabled', deploymentVehicles: target(s) } };
  }).sort((a, b) => (a.emptyShare ?? 2) - (b.emptyShare ?? 2) || b.vehNow - a.vehNow || (b.demand?.startsPerHour ?? 0) - (a.demand?.startsPerHour ?? 0) || a.id - b.id);
  onlyMine.forEach((x, i) => { x.rank = i + 1; });

  // c) Pflegebedarf
  const Z = zones ? zoneClasses(zones, own) : null;
  const dupOf = new Map(dupsByOp.get(own)?.map(d => [d.spot, d]) || []);
  let inNoFree = 0;
  const care = [];
  for (const s of ownSpots) {
    const issues = [];
    const z = Z ? hit(Z.noThrough, s) : null;
    if (Z && !z && hit(Z.noFree, s)) inNoFree++;
    if (z) issues.push({ k: 'zone', zone: z.name });
    const dp = dupOf.get(s); if (dp) issues.push({ k: 'dup', of: dp.keep.label, ofId: dp.keep.id, d: dp.d, lat: dp.keep.lat, lon: dp.keep.lon });
    const dem = demandAt(D, s);
    if (s.permEmpty) issues.push({ k: 'empty', share: s.emptyShare, runs: s.runs, vehNow: s.vehNow, demand: dem ? (dem.high ? 'high' : 'low') : null });
    if (!issues.length) continue;
    const remove = issues.some(i => i.k === 'zone' || i.k === 'dup'), deploy = !remove && issues.some(i => i.k === 'empty' && i.demand === 'high');
    care.push({ ...pick(s), vehNow: s.vehNow, issues, demand: dem ? { startsPerHour: dem.startsPerHour, factor: dem.factor, pct: dem.pct } : null,
      action: remove ? (issues.some(i => i.k === 'zone') ? 'move' : 'merge') : deploy ? 'deploy' : 'check',
      export: { deploymentStatus: deploy ? 'enabled' : 'disabled', parkingStatus: remove ? 'disabled' : s.returning ? 'enabled' : 'disabled', deploymentVehicles: remove ? 0 : deploy ? Math.max(DEFAULTS.minPerSpot, target(s)) : target(s) } });
  }
  const W = { zone: 3, dup: 2, empty: 1 };
  care.sort((a, b) => b.issues.reduce((x, i) => x + W[i.k], 0) - a.issues.reduce((x, i) => x + W[i.k], 0) || (b.emptyShare ?? 0) - (a.emptyShare ?? 0) || a.id - b.id);
  care.forEach((x, i) => { x.rank = i + 1; });

  const maxRuns = spots.reduce((m, s) => Math.max(m, s.runs), 0);
  return {
    ags, own, radiusM, kind, dupM, emptyShare, minRuns, at: fleet?.at ?? null, operators, rows, spots, vehicles: veh,
    total: { spots: spots.length, virtual: spots.filter(s => s.virtual).length, quotaMatched: spots.filter(s => s.runs > 0).length, maxRuns, share },
    demand: D ? { hours: D.hours, days: D.days, cells: D.cells, p50: D.p50, p95: D.p95 } : null,
    zones: Z ? { files: Z.files, noThrough: Z.noThrough.length, noFree: Z.noFree.length, inNoFree } : null,
    missing, onlyMine, care,
  };
}

// ---------- Spot-Bewertung mit Prognose (Prognose-Ansicht): Wichtigkeit, Soll, Ist, Fehlbestand je bekanntem Deploy- und Parkspot ----------
export const RATE = { classA: 0.5, classB: 0.2, linkM: 60 };
/**
 * Bekannte Spots eines Anbieters in einer Gemeinde bewerten. Spots: vermutete Deploy-Orte (groups = groupPlaces-Ergebnis, Art 'deploy') und Parkspots
 * (Stationen laut Feed, spotsOf). Orte beider Arten ≤ linkM (60 m) voneinander sind ein Ort („beides“).
 * Nachfrage am Ort: Zelle des Nachfragemodells (≈ 250 m, alle Anbieter). Anteil der Zelle an den Fahrtbeginnen der Gemeinde (cellShare); liegen mehrere
 * Orte in einer Zelle, teilen sie sich den Anteil gleich. Erwartung = cellShare × Prognose des Anbieters in der Gemeinde (fc.day24: erwartete Fahrtbeginne
 * je Stunde ab der nächsten vollen Stunde, aus forecast/latest.json) – Annahme: der Anbieter verteilt sich räumlich wie der Markt.
 * Soll = needOf (Grundbestand = Fahrtbeginne einer Stunde, dazu Netto-Abfluss × Horizont); targetFc ersetzt die gemessenen Fahrtbeginne durch die
 * Prognose der nächsten horizonH Stunden, der gemessene Netto-Abfluss bleibt. Ist = verfügbare Fahrzeuge des Anbieters ≤ radiusM (bzw. gemeldeter
 * Bestand an physischen Stationen). Fehlbestand = max(0, Soll − Ist). Wichtigkeit = Erwartung ÷ größte Erwartung der Liste (ohne Prognose: Fahrtbeginne/h).
 * Klassen: A ≥ 50 %, B ≥ 20 %, C darunter, D = ohne gemessene Nachfrage am Ort.
 */
export function rateSpots(fleet, { ags, op, demand = null, groups = null, quota = null, fc = null, horizonH = DEFAULTS.horizonH, radiusM = DEFAULTS.spotRadiusM, type = 'all' } = {}) {
  const D = demand && demand.hours > 0 && demand.cells?.size ? demand : null;
  const share = operatorShare(fleet, ags, op);
  const veh = (fleet?.vehicles || []).filter(v => v.ags === ags && v.operator === op && isAvailable(v) && (type === 'all' || v.type === type));
  const vIdx = gridIndex(veh, radiusM);
  const rates = D ? [...D.cells.values()].map(c => c.startsPerHour || 0).filter(x => x > 0).sort((a, b) => a - b) : [];
  const sumRate = rates.reduce((a, b) => a + b, 0);
  const day24 = Array.isArray(fc?.day24) ? fc.day24 : null, fcDay = day24 ? day24.reduce((a, b) => a + b, 0) : null, fcH = day24 ? day24.slice(0, horizonH).reduce((a, b) => a + b, 0) : null;
  // Orte zusammenführen
  const items = [];
  for (const g of (groups?.deploy || []).filter(g => g.op === op)) items.push({ kind: 'deploy', lat: g.lat, lon: g.lon, label: '', deploy: { count: g.count, vehicles: g.vehicles, avg: g.avg, last: g.last, first: g.first, rank: g.rank } });
  const parks = spotsOf(fleet, { ags, quota, kind: 'all' }).filter(x => x.operator === op);
  for (const x of parks) {
    const near = items.find(i => i.deploy && !i.park && distM(i, x) <= RATE.linkM);
    const park = { name: x.name, runs: x.runs, emptyShare: x.emptyShare, virtual: x.virtual, physical: fleet.stations.find(q => q.lat === x.lat && q.lon === x.lon && q.operator === op)?.physical ?? null };
    if (near) { near.kind = 'both'; near.park = park; near.label = x.label || near.label; near.parkLat = x.lat; near.parkLon = x.lon; } else items.push({ kind: 'park', lat: x.lat, lon: x.lon, label: x.label, park });
  }
  const perCell = new Map(); for (const it of items) { it.cell = cellOf(it.lat, it.lon); perCell.set(it.cell, (perCell.get(it.cell) || 0) + 1); }
  // Ist: jedes verfügbare Fahrzeug zählt am nächsten Ort im Umkreis (liegen Orte dichter als der Umkreis, würde es sonst mehrfach gezählt und die Summe wäre größer als der Bestand)
  const owner = new Map(); items.forEach((it, i) => { for (const { p: v, d } of vIdx.within(it)) { const cur = owner.get(v); if (!cur || d < cur.d) owner.set(v, { i, d }); } });
  const owned = new Array(items.length).fill(0); for (const o of owner.values()) owned[o.i]++;
  for (const [ix, it] of items.entries()) {
    const c = D?.cells.get(it.cell) || null, sph = c?.startsPerHour ?? 0, n = perCell.get(it.cell) || 1;
    it.demandPerH = sph; it.pct = sph > 0 && rates.length ? rates.filter(r => r < sph).length / rates.length : null;
    it.cellShare = sumRate > 0 ? sph / sumRate / n : 0; it.sharedWith = n - 1;
    it.expected24 = fcDay != null ? it.cellShare * fcDay : null; it.expectedH = fcH != null ? it.cellShare * fcH : null;
    const base = c && sph > 0 && share ? needOf(c, share) : null;
    it.target = base ? base.target : 0;
    it.targetFc = base ? (it.expectedH != null ? needOf({ startsPerHour: it.expectedH / horizonH, endsPerHourBal: it.expectedH / horizonH - base.outOp }, 1).target : base.target) : 0;
    const phys = it.park && it.park.virtual === false && it.park.physical != null ? it.park.physical : null;
    it.have = phys ?? owned[ix];
    it.missing = Math.max(0, it.targetFc - it.have); it.surplus = Math.max(0, it.have - it.targetFc);
    it.weight = it.expected24 ?? it.demandPerH;
  }
  const maxW = items.reduce((m, i) => Math.max(m, i.weight || 0), 0);
  for (const it of items) { it.importance = maxW > 0 ? it.weight / maxW : 0; it.cls = !(it.demandPerH > 0) ? 'D' : it.importance >= RATE.classA ? 'A' : it.importance >= RATE.classB ? 'B' : 'C'; }
  items.sort((a, b) => b.missing - a.missing || b.importance - a.importance || a.lat - b.lat || a.lon - b.lon).forEach((x, i) => { x.rank = i + 1; });
  const sum = (f) => items.reduce((a, x) => a + f(x), 0), byCls = Object.fromEntries(['A', 'B', 'C', 'D'].map(k => [k, items.filter(x => x.cls === k).length]));
  return {
    ags, op, type, share, horizonH, radiusM, items, fc: day24 ? { day24, total: fcDay, nextH: fcH } : null, prelim: D ? D.hours < DEFAULTS.prelimH : null, hours: D?.hours ?? 0, days: D?.days ?? 0,
    total: { spots: items.length, deploy: items.filter(x => x.deploy).length, park: items.filter(x => x.park).length, both: items.filter(x => x.kind === 'both').length, byCls, target: sum(x => x.targetFc), have: sum(x => x.have),
      missing: sum(x => x.missing), surplus: sum(x => x.surplus), spotsMissing: items.filter(x => x.missing > 0).length, importantMissing: items.filter(x => x.missing > 0 && (x.cls === 'A' || x.cls === 'B')).length, missingAB: sum(x => (x.cls === 'A' || x.cls === 'B') ? x.missing : 0) },
  };
}

// ---------- Exporte ----------
const exportName = (x, name = 'Spot') => (x.label || `${name} ${String(x.rank).padStart(2, '0')}`).slice(0, 60);
/** Backend-CSV (Komma, Spalten wie die Spots-CSV der Disposition); Zellen über csvCell (Formel-Schutz, Quoting). Ohne Namen: „<name> <Rang>“ */
export function spotsBackendCsv(items, { name = 'Spot' } = {}) {
  const rows = (items || []).map(x => [exportName(x, name), x.lat.toFixed(6), x.lon.toFixed(6), x.export.deploymentStatus, x.export.parkingStatus, DEPLOY_RADIUS, x.export.deploymentVehicles ?? 0]);
  return [SPOTS_CSV_FIELDS, ...rows].map(r => r.map(c => csvCell(c, ',')).join(',')).join('\n');
}
/** GeoJSON (Punkte, WGS84); reason(x) liefert die Begründung als Text der Oberfläche */
export function spotsGeoJson(items, { list, own, radiusM, at, reason = () => '' } = {}) {
  return {
    type: 'FeatureCollection', name: `spots-${list}`,
    meta: { list, own, radiusM, at: at ? new Date(at).toISOString() : null, source: 'GBFS station_information (laut Feed), Momentaufnahme; Leerquote stations-quota.json' },
    features: (items || []).map(x => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [+x.lon.toFixed(6), +x.lat.toFixed(6)] },
      properties: {
        list, rank: x.rank, name: exportName(x), ...(list === 'missing'
          ? { operators: x.ops, spots: x.members.length, score: x.score, startsPerHour: x.demand?.startsPerHour ?? null, ownVehiclesWithoutSpot: x.ownVehicles, nearestOwnM: x.nearestOwn?.d ?? null,
            members: x.members.map(m => ({ operator: m.operator, name: m.label || null, lat: m.lat, lon: m.lon, emptyShare: m.emptyShare })) }
          : { operator: x.operator, emptyShare: x.emptyShare, runs: x.runs, vehiclesNearNow: x.vehNow, startsPerHour: x.demand?.startsPerHour ?? null,
            ...(list === 'care' ? { issues: x.issues.map(i => i.k), action: x.action } : { nearestOtherM: x.nearestOther?.d ?? null, nearestOtherOperator: x.nearestOther?.operator ?? null }) }),
        reason: reason(x), deploymentStatus: x.export.deploymentStatus, parkingStatus: x.export.parkingStatus, deploymentRadius: DEPLOY_RADIUS, deploymentVehicles: x.export.deploymentVehicles ?? 0,
      },
    })),
  };
}
