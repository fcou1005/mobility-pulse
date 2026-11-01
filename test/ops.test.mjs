import * as O from '../lib/pulse-ops.js';
import { cellOf, cellCenter } from '../lib/pulse-track.js';
const assert = (c, m) => { if (!c) { console.error('FEHLER:', m); process.exitCode = 1; } else console.log('ok:', m); };
const AGS = '08416041';
const base = [48.52, 9.05];
// Zellen: Raster 6 × 6 um Tübingen, Nachfrage fällt vom Zentrum ab
const cellAt = (i, j) => cellOf(base[0] + i * 0.0025, base[1] + j * 0.0035);
function cellsDoc({ bands = [3, 4], demand = (i, j) => Math.max(0, 12 - 3 * (Math.abs(i) + Math.abs(j))), presence = () => 6 } = {}) {
  const munis = { [AGS]: {} };
  for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) {
    const c = new Array(22).fill(0); const d = demand(i, j);
    for (const b of bands) { c[4 + b] = d; c[10 + b] = presence(i, j) * 9; c[16 + b] = Math.round(d * 0.8); }
    c[0] = d * bands.length; c[1] = Math.round(d * 0.8) * bands.length; c[2] = presence(i, j) * 9 * bands.length;
    munis[AGS][cellAt(i, j)] = c;
  }
  const bandMin = [0, 0, 0, 0, 0, 0], bandRuns = [0, 0, 0, 0, 0, 0];
  for (const b of bands) { bandMin[b] = 180; bandRuns[b] = 9; } // 3 h, 9 Läufe je Band
  return { day: '2026-10-31', state: 'BW', bandMin, bandRuns, munis };
}
const docs = [cellsDoc()];

// --- Nachfragemodell
const m = O.buildDemandModel(docs, AGS, 3);
const center = m.cells.get(cellAt(0, 0));
assert(m.hours === 3 && m.runs === 9, 'Band Mittag: 3 h, 9 Läufe');
assert(Math.abs(center.startsPerHour - 4) < 1e-9, 'Zentrum: 12 Starts in 3 h = 4/h');
assert(Math.abs(center.supplyAvg - 6) < 1e-9, 'Zentrum: Ø 6 Fahrzeuge je Lauf');
const mDay = O.buildDemandModel(docs, AGS, 'day');
assert(mDay.hours === 6 && Math.abs(mDay.cells.get(cellAt(0, 0)).startsPerHour - 4) < 1e-9, 'Tag: 2 Bänder, 6 h, Rate gleich');
assert(O.buildDemandModel(docs, AGS, 0).hours === 0, 'Band ohne Läufe: keine Stunden');

// --- Deploy-Spots
const sp = O.scoreSpots(m, { topN: 5, minSpacingM: 400, share: 0.5 });
assert(sp.spots.length === 5, '5 Spots');
assert(sp.spots[0].cell === cellAt(0, 0), 'Rang 1 = Zelle mit höchster Nachfrage');
let minD = Infinity; for (let a = 0; a < sp.spots.length; a++) for (let b = a + 1; b < sp.spots.length; b++) minD = Math.min(minD, O.dist(sp.spots[a], sp.spots[b]));
assert(minD >= 400, `Mindestabstand eingehalten (${Math.round(minD)} m)`);
assert(sp.spots.every(s => s.stability >= 0 && s.stability <= 1), 'Stabilität 0…1');
assert(sp.spots[0].target === Math.max(2, Math.ceil(4 * 0.5 * 3)), 'Ziel = ceil(Starts/h × Anteil × 3 h)');
assert(sp.activeFactors.join() === 'demand,underserved', 'ohne ÖPNV/Abstellflächen nur zwei Faktoren aktiv');
const wsum = sp.activeFactors.reduce((s, k) => s + sp.weights[k], 0);
assert(Math.abs(O.AHP.weights.demand + O.AHP.weights.underserved + O.AHP.weights.transit + O.AHP.weights.parking - 1) < 1e-3 && wsum > 0, 'AHP-Gewichte summieren auf 1');
// Abstellverbot: Polygon um das Zentrum → Rang 1 darf dort nicht liegen
const [clat, clon] = cellCenter(cellAt(0, 0));
const sq = (lat, lon, d) => ({ type: 'Polygon', coordinates: [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]] });
const sp2 = O.scoreSpots(m, { topN: 5, minSpacingM: 400, noPark: [sq(clat, clon, 0.001)] });
assert(sp2.excluded === 1 && !sp2.spots.some(s => s.cell === cellAt(0, 0)), 'Abstellverbot schließt Zelle aus (Constraint, nicht Gewicht)');
// Loch im Polygon hebt das Verbot auf
const holed = { type: 'Polygon', coordinates: [sq(clat, clon, 0.003).coordinates[0], sq(clat, clon, 0.0005).coordinates[0]] };
assert(!O.geomContains(holed, clat, clon) && O.geomContains(holed, clat + 0.002, clon), 'Polygon mit Loch');
// Abstellfläche: Spot rastet auf E-Scooter-Fläche ein, Radabstellanlage zählt halb
const park = [{ lat: clat + 0.0005, lon: clon + 0.0004, cat: 'escooter', name: 'Stellfläche Markt' }, { lat: cellCenter(cellAt(1, 0))[0], lon: cellCenter(cellAt(1, 0))[1], cat: 'rad' }];
const sp3 = O.scoreSpots(m, { topN: 3, minSpacingM: 200, parking: park, transit: [{ lat: clat, lon: clon }] });
const s1 = sp3.spots.find(s => s.cell === cellAt(0, 0));
assert(s1 && Math.abs(s1.lat - park[0].lat) < 1e-9 && s1.park.cat === 'escooter' && s1.factors.parking === 1, 'Spot auf ausgewiesene Stellfläche gesetzt');
assert(sp3.activeFactors.length === 4, 'mit ÖPNV und Abstellflächen vier Faktoren aktiv');
// Rasterindex: Fläche 140 m entfernt (über Rasterzellen hinweg) wird gefunden, 175 m nicht; Haltepunkte ≤ 200 m gezählt
{
  const dLat = (m) => m / 111320;
  const s4 = O.scoreSpots(m, { topN: 1, minSpacingM: 200, parking: [{ lat: clat + dLat(140), lon: clon, cat: 'escooter' }], transit: [{ lat: clat + dLat(190), lon: clon }, { lat: clat, lon: clon + dLat(190) * 1.5 }, { lat: clat + dLat(230), lon: clon }] }).spots[0];
  assert(s4.park?.cat === 'escooter' && Math.abs(s4.lat - (clat + dLat(140))) < 1e-9, 'Rasterindex: Abstellfläche in 140 m gefunden');
  const s5 = O.scoreSpots(m, { topN: 5, minSpacingM: 100, parking: [{ lat: clat + dLat(175), lon: clon, cat: 'escooter' }] }).spots.find(s => s.cell === cellAt(0, 0));
  assert(s5 && !s5.park && s5.factors.parking === 0, 'Rasterindex: Abstellfläche in 175 m nicht genommen (> 160 m)');
  assert(s4.factors.transit === +(2 / 3).toFixed(2), `Rasterindex: 2 von 3 Haltepunkten ≤ 200 m (Faktor ${s4.factors.transit})`);
}

// --- Rebalancing
const depot = { lat: base[0] - 0.02, lon: base[1] - 0.02 };
const far = cellCenter(cellAt(3, 3)); // Nachfrage 0
const V = (lat, lon, extra = {}) => ({ lat, lon, operator: 'Dott', type: 'scooter', disabled: false, reserved: false, battery: 80, idleMin: 3000, ags: AGS, ...extra });
const fleet = [...Array(12)].map((_, i) => V(far[0] + i * 1e-5, far[1]));
const plan = O.planRebalance({ spots: sp.spots, vehicles: fleet, model: m, share: 0.5, depot, vanCapacity: 5 });
const need = sp.spots.reduce((s, x) => s + x.target, 0);
assert(plan.moves === Math.min(need, 12), `Umsetzungen = min(Bedarf ${need}, Überschuss 12)`);
assert(plan.runs.every(r => r.vehicles <= 5), 'Kapazität je Tour eingehalten');
assert(plan.runs.every(r => { const firstDrop = r.stops.findIndex(s => s.type === 'drop'); return r.stops.slice(firstDrop).every(s => s.type === 'drop'); }), 'erst einsammeln, dann ausbringen');
assert(plan.runs.every(r => r.km > 0 && r.totalMin > r.driveMin), 'Tour mit km und Handlingzeit');
// keine Umsetzung, wenn Spots schon voll sind
const full = sp.spots.flatMap(s => [...Array(s.target)].map(() => V(s.lat, s.lon, { idleMin: 10 })));
assert(O.planRebalance({ spots: sp.spots, vehicles: full, model: m, share: 0.5, depot }).moves === 0, 'volle Spots: keine Umsetzung');
// leere Akkus werden nicht umgesetzt
assert(O.planRebalance({ spots: sp.spots, vehicles: fleet.map(v => ({ ...v, battery: 10 })), model: m, share: 0.5, depot }).moves === 0, 'Akku unter 30 %: nicht umsetzen, sondern tauschen');

// --- Akkutausch
const sw = O.planSwaps({ vehicles: [...fleet.map((v, i) => ({ ...v, battery: i * 5 })), V(clat, clon, { battery: 10 })], model: m, depot, swapCapacity: 3, swapThreshold: 25 });
assert(sw.below === 6, '6 Fahrzeuge unter 25 %');
assert(sw.runs.every(r => r.vehicles <= 3), 'Swap-Kapazität je Tour');
assert(fleet.every(v => v.priority === undefined), 'Eingabe bleibt unverändert');
// höchstens 50 Akkus je Tour, auch wenn mehr eingestellt ist
const many = [...Array(130)].map((_, i) => V(clat + (i % 13) * 0.0004, clon + Math.floor(i / 13) * 0.0004, { battery: 5 }));
const sw50 = O.planSwaps({ vehicles: many, model: m, depot, swapCapacity: 80, swapThreshold: 25 });
assert(sw50.runs.length === 3 && sw50.runs.every(r => r.vehicles <= 50) && sw50.runs[0].vehicles === 50, 'Akkutausch: max. 50 Akkus je Tour');
const top = sw.runs.flatMap(r => r.stops).sort((a, b) => b.priority - a.priority)[0];
assert(top.battery.includes(0) || top.battery.includes(10), 'höchste Priorität: leerster Akku oder Nachfrage-Zentrum');

// --- Werkstatt
const ws = O.planWorkshop({ vehicles: [V(clat, clon, { disabled: true }), V(clat + 0.01, clon, { disabled: true }), V(clat, clon)], depot, workshopCapacity: 1 });
assert(ws.disabled === 2 && ws.runs.length === 2, 'gesperrte Fahrzeuge in Werkstatt-Touren');

// --- Reihenfolge
const line = [5, 1, 4, 2, 3, 0].map(k => ({ lat: 48.5, lon: 9 + k * 0.01, k }));
const ord = O.orderStops(line, { start: { lat: 48.5, lon: 8.99 } });
assert(ord.map(p => p.k).join() === '0,1,2,3,4,5', 'Punkte auf einer Linie in Reihenfolge');
// Delta-Bewertung muss zum vollen Tourpreis passen: Ergebnis ist Permutation und lokal optimal (kein 2-opt-/Or-opt-Zug verbessert
// die volle Tour mehr), auch bei asymmetrischen Kosten (wie OSRM); zufällige Instanzen mit Seed
{
  let seed = 11; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const inst = (n) => [...Array(n)].map((_, i) => ({ lat: 52.45 + rnd() * 0.1, lon: 13.3 + rnd() * 0.15, i }));
  const D0 = { lat: 52.5, lon: 13.4 };
  const full = (seq, cost) => { let s = 0; for (let i = 0; i < seq.length - 1; i++) s += cost(seq[i], seq[i + 1]); return s; };
  const locallyOptimal = (t, start, end, cost) => {
    const seq = (x) => [...(start ? [start] : []), ...x, ...(end ? [end] : [])]; const c0 = full(seq(t), cost);
    for (let i = 0; i < t.length - 1; i++) for (let k = i + 1; k < t.length; k++) if (full(seq(t.slice(0, i).concat(t.slice(i, k + 1).reverse(), t.slice(k + 1))), cost) < c0 - 1e-6) return false;
    for (let L = 1; L <= 3; L++) for (let i = 0; i + L <= t.length; i++) { const sg = t.slice(i, i + L), rest = t.slice(0, i).concat(t.slice(i + L)); for (let p = 0; p <= rest.length; p++) if (p !== i && full(seq(rest.slice(0, p).concat(sg, rest.slice(p))), cost) < c0 - 1e-6) return false; }
    return true;
  };
  const asym = (a, b) => O.dist(a, b) * (b.lat > a.lat ? 1.3 : 1); // nach Norden teurer
  let okPerm = true, okSym = true, okAsym = true, okStartEnd = true;
  for (let k = 0; k < 20; k++) {
    const n = 5 + Math.floor(rnd() * 30), stops = inst(n), start = k % 3 ? D0 : null, end = k % 2 ? D0 : null;
    const r = O.orderStops(stops, { start, end });
    if (r.length !== n || new Set(r.map(x => x.i)).size !== n) okPerm = false;
    if (!locallyOptimal(r, start, end, O.makeCost())) okSym = false;
    const ra = O.orderStops(stops, { start, end, cost: asym });
    if (!locallyOptimal(ra, start, end, asym)) okAsym = false;
    if (!stops.includes(r[0]) || !stops.includes(ra[n - 1])) okStartEnd = false;
  }
  assert(okPerm && okStartEnd, 'orderStops: Ergebnis ist Permutation der Stopps (ohne Start/Ende)');
  assert(okSym, 'orderStops: lokal optimal gegenüber vollem Tourpreis (symmetrisch, 20 Instanzen)');
  assert(okAsym, 'orderStops: lokal optimal auch bei asymmetrischen Kosten (20 Instanzen)');
  const big = inst(50); const t0 = performance.now(); const rb = O.orderStops(big, { start: D0, end: D0 }); const ms = performance.now() - t0;
  assert(rb.length === 50 && ms < 100, `orderStops: 50 Stopps in ${ms.toFixed(1)} ms (< 100 ms)`);
  const huge = inst(100); const t1 = performance.now(); O.orderStops(huge, { start: D0, end: D0 }); const ms2 = performance.now() - t1;
  assert(ms2 < 300, `orderStops: 100 Stopps in ${ms2.toFixed(1)} ms (< 300 ms)`);
  // Vergleich mit der bisherigen Fassung (volle Tour je Zug neu gerechnet, Stand vor der Delta-Bewertung): feste Daten (Seed),
  // mit/ohne Start und Ende, symmetrisch und asymmetrisch → Tourlänge nie länger als vorher
  const refOrder = (stops, { start = null, end = null, cost = O.makeCost() } = {}) => {
    if (stops.length <= 1) return stops.slice();
    const tourCost = (t) => { let s = 0; const seq = [...(start ? [start] : []), ...t, ...(end ? [end] : [])]; for (let i = 0; i < seq.length - 1; i++) s += cost(seq[i], seq[i + 1]); return s; };
    let best = null, bc = Infinity;
    for (let s = 0; s < Math.min(6, stops.length); s++) {
      const left = stops.slice(); const seq = []; let cur = start;
      if (!cur || s > 0) { const f = left.splice(s === 0 ? 0 : (s * 7919) % left.length, 1)[0]; seq.push(f); cur = f; }
      while (left.length) { let bi = 0, bv = Infinity; left.forEach((x, i) => { const c = cost(cur, x); if (c < bv) { bv = c; bi = i; } }); cur = left.splice(bi, 1)[0]; seq.push(cur); }
      let t = seq, improved = true, guard = 0;
      while (improved && guard++ < 60) {
        improved = false;
        for (let i = 0; i < t.length - 1; i++) for (let k = i + 1; k < t.length; k++) { const u = t.slice(0, i).concat(t.slice(i, k + 1).reverse(), t.slice(k + 1)); if (tourCost(u) < tourCost(t) - 1e-6) { t = u; improved = true; } }
        for (let L = 1; L <= 3; L++) for (let i = 0; i + L <= t.length; i++) { const sg = t.slice(i, i + L), rest = t.slice(0, i).concat(t.slice(i + L)); for (let p = 0; p <= rest.length; p++) { if (p === i) continue; const u = rest.slice(0, p).concat(sg, rest.slice(p)); if (tourCost(u) < tourCost(t) - 1e-6) { t = u; improved = true; break; } } }
      }
      const c = tourCost(t); if (c < bc) { bc = c; best = t; }
    }
    return best;
  };
  seed = 2026; let worse = 0, same = 0, cmp = 0, maxRatio = 0;
  for (let k = 0; k < 24; k++) {
    const n = 4 + Math.floor(rnd() * 27), stops = inst(n), start = k % 4 ? D0 : null, end = k % 3 ? D0 : null, cost = k % 2 ? asym : O.makeCost();
    const seq = (t) => [...(start ? [start] : []), ...t, ...(end ? [end] : [])];
    const a = full(seq(refOrder(stops, { start, end, cost })), cost), b = full(seq(O.orderStops(stops, { start, end, cost })), cost);
    cmp++; if (b > a + 1e-6) worse++; if (Math.abs(a - b) < 1e-6) same++; maxRatio = Math.max(maxRatio, b / a);
  }
  assert(worse === 0, `orderStops: nie länger als die bisherige Fassung (${cmp} feste Instanzen, ${same} gleich lang, max. neu/alt ${maxRatio.toFixed(4)})`);
}

// --- Einsatzzeit je Tour (≤ 4 h) und Bündelung nach Raum
{
  let seed = 5; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  // 260 Fahrzeuge mit leerem Akku über ~12 × 12 km verstreut, Depot in der Mitte
  const D1 = { lat: 48.78, lon: 9.18 };
  const spreadV = [...Array(260)].map(() => V(D1.lat + (rnd() - 0.5) * 0.11, D1.lon + (rnd() - 0.5) * 0.16, { battery: 5 + Math.floor(rnd() * 15) }));
  const open = O.planSwaps({ vehicles: spreadV, model: m, depot: D1, swapCapacity: 50, swapThreshold: 25, maxRuns: 6, maxRunMin: Infinity });
  const cap = O.planSwaps({ vehicles: spreadV, model: m, depot: D1, swapCapacity: 50, swapThreshold: 25, maxRuns: 6 });
  const veh = (p) => p.runs.reduce((s, r) => s + r.vehicles, 0);
  assert(open.runs.some(r => r.totalMin > 240), `ohne Grenze gibt es Touren über 4 h (längste ${Math.max(...open.runs.map(r => r.totalMin))} min)`);
  assert(cap.limitMin === 240 && cap.runs.every(r => r.totalMin <= 240), `Akkutausch: jede Tour ≤ 4 h (längste ${Math.max(...cap.runs.map(r => r.totalMin))} min)`);
  assert(veh(cap) + cap.unplanned === cap.below && cap.below === 260, `Akkutausch: eingeplant ${veh(cap)} + nicht eingeplant ${cap.unplanned} = ${cap.below}`);
  assert(cap.runs.length <= 6 && cap.unplanned > 0, `Akkutausch: höchstens 6 Touren, Rest (${cap.unplanned}) als nicht eingeplant`);
  // Kompaktheit: mittlerer Tour-Radius (weitester Stopp vom Tour-Mittelpunkt) sinkt
  const radius = (p) => p.runs.reduce((s, r) => { const c = { lat: r.stops.reduce((a, x) => a + x.lat, 0) / r.stops.length, lon: r.stops.reduce((a, x) => a + x.lon, 0) / r.stops.length }; return s + Math.max(...r.stops.map(x => O.dist(c, x))); }, 0) / p.runs.length;
  assert(radius(cap) < radius(open), `Akkutausch: kompaktere Touren, Ø Radius ${(radius(cap) / 1000).toFixed(1)} statt ${(radius(open) / 1000).toFixed(1)} km`);
  // einzelner Auftrag weiter weg als die Einsatzzeit erlaubt: nicht eingeplant, keine Endlosschleife
  const lone = O.planWorkshop({ vehicles: [V(D1.lat + 1.2, D1.lon, { disabled: true }), V(D1.lat + 0.001, D1.lon, { disabled: true })], depot: D1, maxRunMin: 240 });
  assert(lone.runs.length === 1 && lone.runs[0].vehicles === 1 && lone.unplanned === 1, 'Werkstatt: Auftrag 130 km entfernt ist allein zu lang → nicht eingeplant');
  // Umsetzen: viele Spots über die Stadt, Überschuss am Rand → Touren ≤ 4 h, Umsetzungen = eingeplant + nicht eingeplant
  const cells = new Map(); const spotsR = [];
  for (let i = 0; i < 24; i++) { const lat = D1.lat + (rnd() - 0.5) * 0.09, lon = D1.lon + (rnd() - 0.5) * 0.13, cell = O.cellOf(lat, lon); spotsR.push({ rank: i + 1, cell, lat, lon, score: 1 - i / 30, target: 6 }); cells.set(cell, { startsPerHour: 0 }); }
  const sur = [...Array(120)].map(() => V(D1.lat + (rnd() - 0.5) * 0.12, D1.lon + (rnd() - 0.5) * 0.17, { idleMin: 3000 }));
  const rbo = O.planRebalance({ spots: spotsR, vehicles: sur, model: { cells }, depot: D1, vanCapacity: 30, maxRuns: 8, maxRunMin: Infinity });
  const rbc = O.planRebalance({ spots: spotsR, vehicles: sur, model: { cells }, depot: D1, vanCapacity: 30, maxRuns: 8 });
  assert(rbo.runs.some(r => r.totalMin > 240) && rbc.runs.every(r => r.totalMin <= 240), `Umsetzen: ohne Grenze bis ${Math.max(...rbo.runs.map(r => r.totalMin))} min, mit Grenze ≤ 240 min`);
  assert(veh(rbc) + rbc.unplanned === rbc.moves && rbc.runs.every(r => r.vehicles <= 30), `Umsetzen: ${veh(rbc)} eingeplant + ${rbc.unplanned} nicht eingeplant = ${rbc.moves} Umsetzungen, Kapazität eingehalten`);
  assert(rbc.runs.every(r => { const fd = r.stops.findIndex(s => s.type === 'drop'); return fd > 0 && r.stops.slice(fd).every(s => s.type === 'drop'); }), 'Umsetzen mit Grenze: erst einsammeln, dann ausbringen');
}

// --- Links und Exporte
const pts = [...Array(19)].map((_, i) => ({ lat: 48 + i / 100, lon: 9 }));
const links = O.mapsLinks(pts);
assert(links.length === 2 && links[0].split('/').length - 5 === 10 && links[1].startsWith('https://www.google.com/maps/dir/48.09000,9.00000/'), 'Google-Maps-Links: höchstens 10 Punkte, Anschluss am letzten Punkt');
const csv = O.spotsCsv(sp.spots, { name: 'Tübingen' }).split('\n');
assert(csv[0] === 'name,lat,lng,deploymentStatus,parkingStatus,deploymentRadius,deploymentVehicles' && csv.length === 6 && csv[1].startsWith('Tübingen 01,'), 'Spots-CSV im Backend-Format');
const gj = O.planGeoJson(sp.spots, plan.runs, depot);
assert(gj.features.filter(f => f.properties.kind === 'spot').length === 5 && gj.features.some(f => f.properties.kind === 'depot'), 'GeoJSON mit Spots, Touren, Depot');
const k = O.fleetKpis([...fleet, V(clat, clon, { disabled: true }), V(clat, clon, { battery: 5, idleMin: 5 })]);
assert(k.total === 14 && k.disabled === 1 && k.low === 1 && k.idle24 === 12, 'Flotten-Kennzahlen');
// Flotte aus ops/<Land>.json
const doc = { at: 1, types: ['scooter', 'ebike'], ops: ['Dott'], munis: [AGS], vehicles: [[48.5, 9.05, 0, 0, 2, 40, 12, 90, 0]], stations: [[48.5, 9.05, 0, 'Markt', 3, 2, 10, 0, 1, 1, 4]] };
const fl = O.decodeFleet(doc);
assert(fl.vehicles[0].disabled && fl.vehicles[0].idleMin === 90 && fl.vehicles[0].ags === AGS && fl.stations[0].capacity === 10, 'Flotte dekodiert');
// Zonen: GBFS-Regeln → Abstellverbote
const fc = { features: [{ properties: { rules: [{ endAllowed: false }] }, geometry: sq(clat, clon, 0.001) }, { properties: { rules: [{ rideAllowed: true }] }, geometry: sq(clat, clon, 0.05) }] };
assert(O.noParkGeometries(fc).length === 1, 'nur Zonen mit Abstell- oder Fahrverbot sind Constraints');
// OSM-Abstellflächen klassifizieren
const els = [{ type: 'node', lat: 1, lon: 2, tags: { amenity: 'kick-scooter_parking' } }, { type: 'way', center: { lat: 1, lon: 2 }, tags: { amenity: 'bicycle_parking' } }, { type: 'node', lat: 1, lon: 2, tags: { amenity: 'bicycle_rental', name: 'Station' } }, { type: 'node', lat: 1, lon: 2, tags: { highway: 'bus_stop' } }];
const pk = O.parkingFromOsm(els), tr = O.transitFromOsm(els);
assert(pk.map(p => p.cat).join() === 'escooter,rad,sharing' && tr.length === 1, 'OSM: E-Scooter-Fläche, Radabstellanlage, Sharing getrennt; Haltestelle als ÖPNV');
// Stationsausgleich
const ST = (name, lat, bookable, cap, extra = {}) => ({ name, lat, lon: 9.05, bookable, docks: cap - bookable, capacity: cap, renting: true, returning: true, ...extra });
const sb = O.planStationBalance({ stations: [ST('Leer', 48.52, 0, 10), ST('Voll', 48.525, 10, 10), ST('Mitte', 48.53, 5, 10), ST('Halbleer', 48.535, 1, 10)], depot, vanCapacity: 20 });
assert(sb.empty === 2 && sb.full === 1, 'Stationen: 2 fast leer, 1 voll');
assert(sb.moves === 5 && sb.missing === 4, 'volle Station gibt 5 ab (bis 50 %), 4 fehlen');
assert(sb.runs[0].stops[0].type === 'pickup' && sb.runs[0].stops[0].station === 'Voll', 'Tour beginnt an der vollen Station');
// Pflicht-Abstellzone (station_parking): Spot rastet auf Station ein, ohne Station ausgeschlossen
const zc = O.zoneConstraints({ features: [{ properties: { rules: [{ rideAllowed: false, rideThrough: true, parking: true }] }, geometry: sq(clat, clon, 0.03) }] });
assert(zc.mandatory.length === 1 && zc.noPark.length === 0, 'station_parking-Zone ist Pflicht-Abstellzone, kein Verbot');
const stn = { lat: clat + 0.0006, lon: clon, name: 'Dott Hub Markt' };
const sp5 = O.scoreSpots(m, { topN: 5, minSpacingM: 200, mandatory: zc.mandatory, stations: [stn] });
assert(sp5.spots.length >= 1 && sp5.spots[0].lat === stn.lat && sp5.spots[0].park.cat === 'station', 'Spot auf Anbieter-Station gesetzt');
assert(sp5.excluded > 0 && sp5.spots.every(s => s.park?.cat === 'station'), 'Zellen ohne Station in der Pflichtzone ausgeschlossen');

// --- Amtliche Daten der Städte (Fixtures nach dem Muster Berlin-WFS bzw. München-Open-Data-Portal; die Hosts sind in der Sandbox nicht erreichbar)
{
  // Berlin parkverbot_mikromob als WFS-2.0-GeoJSON in lat/lon-Reihenfolge (EPSG:4326 nach URN-Achsen) → wird zu lon/lat gedreht
  const latLonPoly = (lat, lon, d) => ({ type: 'Polygon', coordinates: [[[lat - d, lon - d], [lat - d, lon + d], [lat + d, lon + d], [lat + d, lon - d], [lat - d, lon - d]]] });
  const wfsFc = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'Parkverbotszone Markt' }, geometry: latLonPoly(clat, clon, 0.001) }] };
  const fx = O.lonLatFc(wfsFc);
  assert(fx.swapped === 5 && fx.projected === 0 && Math.abs(fx.features[0].geometry.coordinates[0][0][0] - (clon - 0.001)) < 1e-12, 'amtliche Daten: lat/lon-Achsen erkannt und gedreht');
  assert(O.lonLatFc({ features: [{ geometry: { type: 'Point', coordinates: [389000, 5819000] } }] }).projected === 1, 'amtliche Daten: projizierte Koordinaten (UTM) erkannt, nicht geraten');
  const offNo = O.noParkFromFc(fx);
  assert(offNo.length === 1 && O.geomContains(offNo[0], clat, clon), 'Abstellverbotszone als Fläche übernommen');
  // Ausschluss wie GBFS-Verbot (Constraint, kein Gewicht) …
  const sv = O.scoreSpots(m, { topN: 5, minSpacingM: 400, officialNoPark: offNo });
  assert(sv.excludedBy.official === 1 && !sv.spots.some(s => s.cell === cellAt(0, 0)), 'Abstellverbot laut Stadt schließt die Zelle aus');
  // … außer der Spot liegt auf einer ausgewiesenen Abstellfläche (München: Verbot im Umkreis, Fläche selbst erlaubt)
  const abst = O.parkingFromWfs(O.lonLatFc({ features: [{ properties: { bezeichnung: 'Abstellfläche Markt' }, geometry: { type: 'Polygon', coordinates: [[[clon + 0.0002, clat + 0.0003], [clon + 0.0004, clat + 0.0003], [clon + 0.0004, clat + 0.0005], [clon + 0.0002, clat + 0.0005], [clon + 0.0002, clat + 0.0003]]] } }] }), 'official');
  assert(abst.length === 1 && Math.abs(abst[0].lat - (clat + 0.0004)) < 1e-9 && Math.abs(abst[0].lon - (clon + 0.0003)) < 1e-9 && abst[0].name === 'Abstellfläche Markt', 'Abstellfläche (Polygon) → Mittelpunkt als amtliche Fläche');
  const sa = O.scoreSpots(m, { topN: 5, minSpacingM: 400, officialNoPark: offNo, parking: abst });
  const top = sa.spots.find(s => s.cell === cellAt(0, 0));
  assert(sa.excludedBy.official === 0 && top && top.park.cat === 'official' && Math.abs(top.lat - abst[0].lat) < 1e-9, 'Spot auf amtlicher Abstellfläche in der Verbotszone bleibt erlaubt');
  // Radabstellanlage in der Verbotszone hebt das Verbot nicht auf
  const sr = O.scoreSpots(m, { topN: 5, minSpacingM: 400, officialNoPark: offNo, parking: [{ lat: clat + 0.0002, lon: clon, cat: 'rad' }] });
  assert(sr.excludedBy.official === 1, 'Radabstellanlage in der Verbotszone: weiter ausgeschlossen');
  // WFS-Adresse: GetFeature, GeoJSON, WGS84; typeNames nach Berliner Muster
  const wu = new URL(O.wfsGetFeatureUrl('https://gdi.berlin.de/services/wfs/parkverbot_mikromob'));
  assert(wu.searchParams.get('request') === 'GetFeature' && wu.searchParams.get('typeNames') === 'parkverbot_mikromob:parkverbot_mikromob' && wu.searchParams.get('outputFormat') === 'application/json' && wu.searchParams.get('srsName') === 'EPSG:4326', 'WFS-GetFeature-Adresse (Berlin-Muster)');
  // Open-Data-Portal München (CKAN package_show): GeoJSON-Ressource bevorzugt, sonst WFS mit typeName, sonst nichts
  const pkg = (resources) => ({ success: true, result: { name: 'opendata_ruhver_mim_geofence_poly', resources } });
  const wfsRes = { format: 'WFS', url: 'https://geoportal.muenchen.de/geoserver/gsm_wfs/ows?service=WFS&request=GetCapabilities&typeName=gsm_wfs:mim_geofence' };
  assert(O.pickCkanResource(pkg([wfsRes, { format: 'GeoJSON', url: 'https://opendata.muenchen.de/dataset/x/resource/y/download/geofence.geojson' }])).type === 'geojson', 'Portal: GeoJSON-Ressource vor WFS');
  const pw = O.pickCkanResource(pkg([{ format: 'PDF', url: 'https://x/beschreibung.pdf' }, wfsRes]));
  assert(pw?.type === 'wfs' && new URL(pw.url).searchParams.get('typeNames') === 'gsm_wfs:mim_geofence' && new URL(pw.url).searchParams.get('request') === 'GetFeature', 'Portal: WFS-Ressource → GetFeature mit typeName aus der Ressource');
  assert(O.pickCkanResource(pkg([{ format: 'PDF', url: 'https://x/a.pdf' }])) === null, 'Portal: ohne GeoJSON/WFS → null (Warnung statt stillem Ausfall)');
}
