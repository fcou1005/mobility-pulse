import * as O from '../lib/pulse-ops.js';
import { cellOf, cellCenter } from '../lib/pulse-track.js';
const assert = (c, m) => { if (!c) { console.error('FEHLER:', m); process.exitCode = 1; } else console.log('ok:', m); };
// P6: Laufzeitgrenzen relativ zur Rechnerleistung (Referenzlast ≈ 20 ms auf dem Entwicklungsrechner, Faktor 1–4) und als bestes von 3 Messungen
const REF_MS = 20, refLoad = () => { const t = performance.now(); const a = new Float64Array(200000); for (let i = 0; i < a.length; i++) a[i] = Math.sin(i) * 1e6; a.sort(); const m = new Map(); for (let i = 0; i < 50000; i++) m.set('k' + (i % 5000), i); return performance.now() - t; };
const SLOW = Math.min(4, Math.max(1, Math.min(refLoad(), refLoad(), refLoad()) / REF_MS));
const best = (f, n = 3) => { let ms = Infinity, r; for (let i = 0; i < n; i++) { const t = performance.now(); r = f(); ms = Math.min(ms, performance.now() - t); } return [r, ms]; };
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
// Zentrum Band Mittag: 12 Starts, 10 Enden in 3 h, Anteil 0,5. Gemeinde: Σ Starts 132, Σ Enden 102 (jede Zelle Enden ≈ 0,8 × Starts) →
// Ausgleich k = 132 ÷ 102: der gleichmäßige Überschuss an Starts ist kein Abfluss der Zelle (M-10). Netto = (12 − 10k) ÷ 3 h × 0,5 < 0 → Bedarf = Grundbestand 2
{
  const s = sp.spots[0], k = 132 / 102;
  assert(s.starts === 12 && s.ends === 10 && s.hours === 3 && s.startsPerHourOp === 2 && s.balanceK === +k.toFixed(3) && s.outPerHourRaw === +(2 / 3).toFixed(2), `Spot 1: Starts/Enden gezählt (12/10 in 3 h), ohne Ausgleich Netto ${s.outPerHourRaw}/h (Markt), Ausgleich k = ${s.balanceK}`);
  assert(s.endsPerHourOp === +(10 * k / 3 * 0.5).toFixed(2) && s.outPerHourOp === +((12 - 10 * k) / 3 * 0.5).toFixed(2), `Spot 1 ausgeglichen (Anbieter): Enden ${s.endsPerHourOp}/h, Netto ${s.outPerHourOp}/h`);
  assert(s.base === 2 && s.drain === 0 && s.needRaw === 2 && s.target === 2, `Bedarf = Netto-Abfluss × Horizont + Grundbestand = ${s.drain} + ${s.base} = ${s.needRaw} → ${s.target}`);
  assert(Math.abs(s.outSeOp - Math.sqrt(12 + k * k * 10) / 3 * 0.5) < 0.006, `Standardfehler Netto ${s.outSeOp} = √(12 + k² · 10) ÷ 3 h × 0,5`);
  assert(s.outLowOp === 0 && s.factors.outflow === 0 && s.outLoOp < s.outPerHourOp && s.outHiOp > s.outPerHourOp, `Untergrenze max(0, Netto − 2·SE) = ${s.outLowOp}, Spanne ${s.outLoOp} … ${s.outHiOp}`);
}
assert(sp.activeFactors.join() === 'outflow,demand', 'ohne ÖPNV/Abstellflächen zwei Faktoren aktiv: Netto-Abfluss, Nachfrage');
assert(sp.perturbations === 4 && sp.prelim === true && sp.hours === 3, 'Sensitivität: 2 Faktoren × ±20 % = 4 Varianten; 3 Messstunden → vorläufig');
const wsum = sp.activeFactors.reduce((s, k) => s + sp.weights[k], 0);
assert(Math.abs(O.AHP.weights.outflow + O.AHP.weights.demand + O.AHP.weights.transit + O.AHP.weights.parking - 1) < 1e-3 && wsum > 0, 'AHP-Gewichte summieren auf 1');
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
  const big = inst(50); const [rb, ms] = best(() => O.orderStops(big, { start: D0, end: D0 }));
  assert(rb.length === 50 && ms < 100 * SLOW, `orderStops: 50 Stopps in ${ms.toFixed(1)} ms (< ${(100 * SLOW).toFixed(0)} ms)`);
  const huge = inst(100); const [, ms2] = best(() => O.orderStops(huge, { start: D0, end: D0 }));
  assert(ms2 < 300 * SLOW, `orderStops: 100 Stopps in ${ms2.toFixed(1)} ms (< ${(300 * SLOW).toFixed(0)} ms)`);
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

// --- Akkutausch nur, wenn Ladestand UND Reichweite unter der Schwelle (Nutzerregel 01.11.2026)
{
  const o = { swapThreshold: 20, swapRangeKm: 5 };
  assert(O.needsSwap({ battery: 15, rangeKm: 3 }, o) === true, 'Akkutausch: 15 % und 3 km → tauschen');
  assert(O.needsSwap({ battery: 15, rangeKm: 8 }, o) === false, 'Akkutausch: 15 % aber 8 km → nicht tauschen');
  assert(O.needsSwap({ battery: 25, rangeKm: 3 }, o) === false, 'Akkutausch: 25 % aber 3 km → nicht tauschen');
  assert(O.needsSwap({ battery: null, rangeKm: 3 }, o) === true, 'Akkutausch: nur Reichweite gemeldet (3 km) → tauschen');
  assert(O.needsSwap({ battery: 10, rangeKm: null }, o) === true, 'Akkutausch: nur Ladestand gemeldet (10 %) → tauschen');
  assert(O.needsSwap({ battery: null, rangeKm: null }, o) === false, 'Akkutausch: ohne Energieangabe → nicht tauschen');
  assert(O.needsSwap({ battery: 5, rangeKm: 1, disabled: true }, o) === false, 'Akkutausch: gesperrt → Werkstatt, nicht Tausch');
  const mix = [V(clat, clon, { battery: 15, rangeKm: 3 }), V(clat, clon + 0.001, { battery: 15, rangeKm: 9 }), V(clat, clon + 0.002, { battery: 30, rangeKm: 2 })];
  const swr = O.planSwaps({ vehicles: mix, model: m, depot, swapThreshold: 20, swapRangeKm: 5 });
  assert(swr.below === 1, 'Akkutausch-Plan: nur das Fahrzeug, das beide Schwellen unterschreitet');
}

// --- AHP neu: Netto-Abfluss, Nachfrage, ÖPNV, Abstellfläche (Nutzerwunsch 01.11.2026: Nachfrage mit Zahlen)
{
  const A = O.AHP;
  assert(A.criteria.join() === 'outflow,demand,transit,parking' && !('underserved' in A.weights), 'Kriterien: Netto-Abfluss ersetzt Unterversorgung');
  // Referenz: skills/mcda-suitability-analysis/scripts/ahp_weights.py (numpy-Eigenvektor) → 0,5183 / 0,2839 / 0,0989 / 0,0989, CR 0,0015
  assert(A.weights.outflow === 0.5183 && A.weights.demand === 0.2839 && A.weights.transit === 0.0989 && A.weights.parking === 0.0989, `AHP-Gewichte wie Referenz (${Object.values(A.weights).join(' / ')})`);
  assert(A.cr < 0.10 && Math.abs(A.cr - 0.0015) < 0.0002 && Math.abs(A.lambdaMax - 4.0042) < 0.0005, `Konsistenzquote CR = ${A.cr} < 0,10 (λmax = ${A.lambdaMax})`);
  const bad = O.ahpWeights([[1, 9, 1 / 9], [1 / 9, 1, 9], [9, 1 / 9, 1]]);
  assert(bad.cr >= 0.10, `zirkuläre Urteile (A > B > C > A): CR = ${bad.cr.toFixed(2)} ≥ 0,10 wird erkannt`);
  let threw = false; try { O.ahpWeights([[1, 3], [3, 1]]); } catch { threw = true; }
  assert(threw, 'nicht reziproke Matrix wird abgelehnt');
}
// --- Netto-Abfluss entscheidet: viele Starts ohne Rückkehr schlagen hohen, ausgeglichenen Umschlag
{
  const munis = { [AGS]: {} }, cA = cellAt(-3, -3), cB = cellAt(3, 3), cC = cellAt(0, 3);
  const put = (cell, st, en) => { const c = new Array(22).fill(0); c[4 + 2] = st; c[16 + 2] = en; c[10 + 2] = 4 * 9; c[0] = st; c[1] = en; munis[AGS][cell] = c; };
  put(cA, 60, 60); // 20 Starts/h, 20 Enden/h: ausgeglichen
  put(cB, 30, 0);  // 10 Starts/h, keine Rückkehr: Abfluss 10/h
  put(cC, 3, 15);  // Zufluss: 1 Start/h, 5 Enden/h
  put(cellAt(-3, 3), 0, 18); // Senke ohne Starts (kein Kandidat): Σ Starts = Σ Enden = 93 → Ausgleich k = 1
  const doc = { day: '2026-11-01', bandMin: [0, 0, 180, 0, 0, 0], bandRuns: [0, 0, 9, 0, 0, 0], munis };
  const md = O.buildDemandModel([doc], AGS, 2);
  assert(md.balance.k === 1 && md.cells.get(cA).outPerHour === 0 && md.cells.get(cB).outPerHour === 10 && md.cells.get(cC).outPerHour === -4 && md.dayHours['2026-11-01'] === 3, 'Netto-Abfluss je Zelle = (Starts − Enden) ÷ Messstunden (0 / 10 / −4 je h), Gemeinde ausgeglichen (k = 1)');
  const r = O.scoreSpots(md, { topN: 3, minSpacingM: 100, share: 1, horizonH: 2 });
  const byCell = Object.fromEntries(r.spots.map(s => [s.cell, s]));
  assert(byCell[cB].rank === 1 && byCell[cA].rank === 2, `Rang 1 = Zelle mit Abfluss (Score ${byCell[cB].score}) vor ausgeglichener Zelle mit doppelter Nachfrage (${byCell[cA].score})`);
  assert(byCell[cB].target === 15 && byCell[cB].needRaw === 30 && byCell[cB].capped === true, `Abfluss 10/h × 2 h + Grundbestand 10 = ${byCell[cB].needRaw} → auf 15 begrenzt`);
  assert(byCell[cA].drain === 0 && byCell[cA].target === 15 && byCell[cA].base === 20, 'ausgeglichene Zelle: nur Grundbestand (Starts einer Stunde)');
  assert(byCell[cC].drain === 0 && byCell[cC].factors.outflow === 0 && byCell[cC].target === 2, 'Zufluss: Faktor Netto-Abfluss 0, Bedarf = Grundbestand 1 → Mindestwert 2');
  assert(r.rho !== null && Math.abs(r.rho) <= 1, `Rangkorrelation Nachfrage/Netto-Abfluss berichtet (ρ = ${r.rho})`);
  // Sensitivität ±20 % bleibt: B bleibt in allen Varianten vorn
  assert(byCell[cB].stability === 1 && byCell[cB].stabilityLabel === 'stabil', 'Sensitivität ±20 %: Abfluss-Spot stabil');
  // needOf: Zelle ohne Messung → nichts
  const z = O.needOf(undefined, 1);
  assert(z.raw === 0 && z.target === 2, 'needOf ohne Zelle: rechnerisch 0, Mindestwert 2');
  // Spearman: perfekte und gegenläufige Ränge
  assert(O.spearman([1, 2, 3, 4], [10, 20, 30, 40]) === 1 && O.spearman([1, 2, 3, 4], [4, 3, 2, 1]) === -1, 'Spearman ±1');
}
// --- Ströme (flows/<Tag>.json) belegen Abfluss/Zufluss
{
  const cX = cellAt(0, 0), cY = cellAt(1, 1), cZ = cellAt(2, 2);
  const md = O.buildDemandModel([{ ...cellsDoc(), day: '2026-11-02' }], AGS, 3);
  const fdoc = { day: '2026-11-02', fields: ['gemeinde', 'von', 'nach', 'anbieter', 'art', 'band', 'anzahl', 'dauer_s', 'luftlinie_m'], munis: { [AGS]: { trips: 14, shown: 12, below: 2, cut: 0 } },
    flows: [[AGS, cX, cY, 'Bolt', 'scooter', 3, 5, 900, 3000], [AGS, cX, cZ, null, null, null, 4, 600, 2000], [AGS, cY, cX, 'Bolt', 'scooter', 3, 2, 300, 1000], [AGS, cX, cX, 'Bolt', 'scooter', 3, 9, 100, 200], ['09162000', cX, cY, 'Bolt', 'scooter', 3, 7, 1, 1]] };
  O.attachFlows(md, [fdoc, { day: '2026-11-03', munis: { [AGS]: {} }, flows: [] }]);
  const fx = md.cells.get(cX).flow, fy = md.cells.get(cY).flow;
  assert(fx.out === 5 && fx.in === 2 && fy.out === 2 && fy.in === 5, 'Ströme Band Mittag: X 5 ab / 2 an, Y 2 ab / 5 an (gleiche Zelle und andere Gemeinde zählen nicht)');
  assert(md.flow.days === 1 && md.flow.hours === 3 && md.flow.trips === 7 && md.flow.noBand === 4 && md.flow.below === 2, 'nur Tage mit Messstunden; Zeile ohne Band (4) nur ganztags; 2 Fahrten unter Mindestschwelle ausgewiesen');
  const mdDay = O.attachFlows(O.buildDemandModel([{ ...cellsDoc(), day: '2026-11-02' }], AGS, 'day'), [fdoc]);
  assert(mdDay.cells.get(cX).flow.out === 9 && mdDay.flow.noBand === 0, 'ganzer Tag: Zeile ohne Band zählt mit (9 ab)');
  const sx = O.scoreSpots(md, { topN: 3, minSpacingM: 100 }).spots.find(s => s.cell === cX);
  assert(sx.flow.out === 5 && sx.flow.in === 2, 'Spot trägt den Strom-Beleg');
}
// --- Umsetz-Touren nach Fehlmenge priorisiert
{
  const D2 = { lat: 48.50, lon: 9.00 };
  const spotsP = [{ rank: 1, cell: 'a', lat: 48.52, lon: 9.05, score: 0.9, target: 3 }, { rank: 2, cell: 'b', lat: 48.53, lon: 9.07, score: 0.5, target: 9 }];
  const cellsP = new Map();
  const pool = [...Array(4)].map((_, i) => V(48.525 + i * 1e-4, 9.06, { idleMin: 3000 })); // 4 Überschuss-Fahrzeuge zwischen beiden Spots
  const rp = O.planRebalance({ spots: spotsP, vehicles: pool, model: { cells: cellsP }, depot: D2, vanCapacity: 20 });
  const toB = rp.runs.flatMap(r => r.stops).filter(s => s.type === 'drop' && s.spotRank === 2).reduce((s, x) => s + x.count, 0);
  assert(rp.moves === 4 && toB === 4, `knapper Überschuss geht an den Spot mit der größten Fehlmenge (9 vor 3, trotz niedrigerem Score): ${toB} von 4`);
  const drop = rp.runs[0].stops.find(s => s.type === 'drop');
  assert(drop.need === 9 && drop.have === 0 && rp.runs[0].prio === 9, 'Ausbring-Stopp nennt Bedarf, Bestand und Fehlmenge');
  // zwei Touren mit Kapazität 2, nur eine erlaubt: die eine Tour bedient den Spot mit der größten Fehlmenge
  const far2 = [{ rank: 1, cell: 'c', lat: 48.60, lon: 9.20, score: 0.9, target: 2 }, { rank: 2, cell: 'd', lat: 48.40, lon: 8.80, score: 0.4, target: 6 }];
  const poolC = [V(48.6045, 9.20, { idleMin: 3000 }), V(48.6046, 9.20, { idleMin: 3000 }), V(48.4045, 8.80, { idleMin: 3000 }), V(48.4046, 8.80, { idleMin: 3000 })]; // je 500 m neben den Spots
  const one = O.planRebalance({ spots: far2, vehicles: poolC, model: { cells: new Map() }, depot: D2, vanCapacity: 2, maxRuns: 1 });
  assert(one.runs.length === 1 && one.runs[0].stops.filter(s => s.type === 'drop').every(s => s.spotRank === 2), 'nur eine Tour möglich: sie fährt zum Spot mit Fehlmenge 6 (nicht zum weiter entfernten mit 2)');
  const two = O.planRebalance({ spots: far2, vehicles: poolC, model: { cells: new Map() }, depot: D2, vanCapacity: 2, maxRuns: 2 });
  assert(two.runs[0].id === 'R1' && two.runs[0].prio === 6 && two.runs[1].prio === 2, 'R1 = Tour zur größten Fehlmenge');
  const rc = O.runsCsv(two.runs, D2);
  assert(/Spot 2 \(Bedarf 6, Bestand 0, Fehlmenge 6\)/.test(rc), 'Touren-CSV nennt Bedarf, Bestand, Fehlmenge');
  const rcEn = O.runsCsv(two.runs, D2, 'en');
  assert(rcEn.split('\n')[0] === 'run,type,stop,kind,lat,lng,count,info,priority,priority_rank,reason' && /Spot 2 \(need 6, fleet 0, shortfall 6\)/.test(rcEn) && rcEn.split('\n')[1].includes(',depot,'), 'Touren-CSV englisch: Spalten und Info-Text, Komma-Trennung');
  // Priorität, Rang und Grund je Stopp (wie die Stoppliste der Disposition), auch im GeoJSON
  const dropLine = rc.split('\n').find(l => l.includes('Fehlmenge 6)'));
  const st0 = two.runs[0].stops.find(s => s.type === 'drop');
  assert(rc.split('\n')[0].endsWith(';prioritaet;prio_rang;grund') && dropLine.endsWith(`;${st0.prio};${st0.rank};${O.stopReason(st0)}`) && /Fehlmenge 6|Spot leer/.test(O.stopReason(st0)), 'Touren-CSV: Priorität, Rang und Grund je Stopp');
  const gjr = O.planGeoJson([], two.runs, D2).features.find(f => f.properties.kind === 'stop' && f.properties.type === 'drop');
  assert(gjr.properties.priority === st0.prio && gjr.properties.priorityRank === st0.rank && gjr.properties.reason === O.stopReason(st0), 'GeoJSON: Priorität, Rang und Grund je Stopp');
  assert(O.stopReason({ type: 'swap', why: { battery: 12, idleH: 30 } }, 'en') === 'battery 12 %, idle 1–2 days' && O.stopReason({ type: 'pickup', station: 'X', why: { full: true } }) === 'Station voll', 'Grundtext: Akku und Standzeit, volle Station');
}
// --- Analyse-CSV mit allen Zahlen
{
  const csvA = O.spotsAnalysisCsv(sp.spots, plan.needs).split('\n');
  const head = csvA[0].split(';'), row = csvA[1].split(';'), at = (k) => row[head.indexOf(k)];
  assert(head.join() === O.SPOTS_ANALYSIS_FIELDS.join() && head.includes('netto_abfluss_je_h_anbieter') && head.includes('fehlmenge') && !head.includes('f_unterversorgung'), 'Analyse-CSV: Netto-Abfluss, Bedarf, Fehlmenge statt Unterversorgung');
  assert(at('starts_markt') === '12' && at('enden_markt') === '10' && at('messstunden') === '3' && at('bedarf_fzg') === '2' && at('grundbestand') === '2' && at('abfluss_im_horizont') === '0' && at('ausgleich_k') === String(sp.spots[0].balanceK) && at('netto_abfluss_untergrenze_je_h') === '0' && at('bootstrap_anteil') === String(sp.spots[0].bootShare), 'Analyse-CSV: Zahlen von Spot 1 (gezählte Enden, Ausgleich k, Untergrenze, Bootstrap-Anteil)');
  const en = O.spotsAnalysisCsv(sp.spots, plan.needs, { lang: 'en' }).split('\n'), hE = en[0].split(','), rE = en[1].split(','), atE = (k) => rE[hE.indexOf(k)];
  assert(hE.length === head.length && hE.includes('net_outflow_per_h_operator') && hE.includes('shortfall') && hE.includes('balance_k') && hE.includes('bootstrap_share') && atE('starts_market') === '12' && atE('need_veh') === '2' && ['stable', 'medium', 'uncertain'].includes(atE('stability')), 'Analyse-CSV englisch: Spaltennamen, gleiche Zahlen, Stabilität übersetzt');
}
// --- CSV-Formelschutz
{
  assert(O.csvCell('=HYPERLINK("x")') === `"'=HYPERLINK(""x"")"` && O.csvCell('@SUM(A1)') === "'@SUM(A1)" && O.csvCell('+1+2') === "'+1+2" && O.csvCell('-2+3') === "'-2+3", 'Formel-Schutz: = @ + - am Anfang bekommen ein führendes Hochkomma');
  assert(O.csvCell('-0.123456') === '-0.123456' && O.csvCell(-3) === '-3' && O.csvCell('a;b') === '"a;b"' && O.csvCell(null) === '' && O.csvCell('Zeile\nzwei') === '"Zeile\nzwei"', 'Zahlen bleiben, Trennzeichen/Zeilenumbruch gequotet');
  assert(O.spotsAnalysisCsv([{ ...sp.spots[0], park: { cat: 'escooter', name: '=cmd|calc' } }]).split('\n')[1].endsWith(";escooter =cmd|calc"), 'Abstellflächen-Name mitten im Feld bleibt Text');
}
// --- Vermutete Deploy-Spots: Orte aus Gruppen-Ereignissen (Monatsdateien), Filter, Sortierung, CSV
{
  const F = O.GROUP_FIELDS, t = Date.parse('2026-10-20T08:00:00Z'), dLat = (m) => m / 111320;
  const e = (dt, kind, op, lat, lon, n, ags = AGS) => [t + dt * 3600e3, kind, op, ags, lat, lon, n, { scooter: n }];
  const oct = { month: '2026-10', fields: F, events: [e(0, 'deploy', 'Dott', 48.5, 9.05, 6), e(24, 'deploy', 'Dott', 48.5 + dLat(40), 9.05, 4), e(48, 'deploy', 'Dott', 48.5 + dLat(200), 9.05, 8), e(1, 'collect', 'Dott', 48.5, 9.05, 5), e(2, 'deploy', 'Bolt', 48.5, 9.05, 4), e(3, 'deploy', 'Dott', 48.6, 9.1, 9, '08111000')] };
  const nov = { month: '2026-11', fields: F, events: [e(24 * 13, 'deploy', 'Dott', 48.5 + dLat(20), 9.05, 5)] };
  const g = O.groupPlaces([oct, nov, { fields: F, events: [oct.events[0]] }], { ags: AGS }); // groups.json-Kopie eines Ereignisses zählt nicht doppelt
  const dott = g.deploy.filter(p => p.op === 'Dott');
  assert(g.events.deploy === 5 && g.events.collect === 1 && g.ops.join() === 'Bolt,Dott', `Ereignisse der Gemeinde über Monate, Dublette einmal (${g.events.deploy} Ausbringungen, 1 Einsammeln)`);
  assert(dott.length === 2 && dott[0].count === 3 && dott[0].vehicles === 15 && Math.abs(dott[0].avg - 5) < 1e-9 && dott[1].count === 1, 'Ausbringungen ≤ 60 m zusammengefasst (3×, Ø 5 Fzg.), 200 m entfernt eigener Ort');
  assert(g.deploy.some(p => p.op === 'Bolt' && p.count === 1) && g.collect.length === 1, 'Anbieter und Art getrennt');
  assert(dott[0].first === t && dott[0].last === t + 24 * 13 * 3600e3, 'erstmals/zuletzt über Monatsgrenze');
  const label = (p) => p.op === 'Bolt' ? 'Am Anger' : p.count === 3 ? 'Marktplatz · Altstadt' : 'Bahnhofstraße';
  assert(O.filterPlaces(g.deploy, { q: 'marktpl' }, label).length === 1 && O.filterPlaces(g.deploy, { q: 'BAHNHOFSTRASSE' }, label).length === 1 && O.filterPlaces(g.deploy, { q: 'dott 48.50' }, label).length === 2, 'Textfilter Lage: Teilwort, ohne Groß-/Kleinschreibung, ß = ss');
  assert(O.filterPlaces(g.deploy, { op: 'Bolt' }).length === 1 && O.filterPlaces(g.deploy, { op: 'all' }).length === 3, 'Filter Anbieter');
  assert(O.filterPlaces(g.deploy, { countMin: 2 }).length === 1 && O.filterPlaces(g.deploy, { countMax: 1 }).length === 2 && O.filterPlaces(g.deploy, { avgMin: 5, avgMax: 5 }).length === 1 && O.filterPlaces(g.deploy, { avgMin: 8 }).length === 1, 'Bereichsfilter Ausbringungen und Ø Fahrzeuge');
  assert(O.filterPlaces(g.deploy, { from: '2026-11-01' }).length === 1 && O.filterPlaces(g.deploy, { to: '2026-10-20' }).length === 1 && O.filterPlaces(g.deploy, { from: '2026-10-22', to: '2026-10-22' }).length === 1, 'Zeitraum zuletzt (Tag, Grenzen einschließlich)');
  const near = (p) => ({ rank: 1, d: O.dist(p, { lat: 48.5, lon: 9.05 }) });
  assert(O.sortPlaces(g.deploy, 'count', 'asc')[0].count === 1 && O.sortPlaces(g.deploy, 'count', 'desc')[0].count === 3 && O.sortPlaces(g.deploy, 'near', 'desc', { nearOf: near })[0].count === 1 && O.sortPlaces(g.deploy, 'lage', 'asc', { labelOf: label })[0].op === 'Bolt', 'Sortierung je Spalte (Anzahl, Abstand, Lage)');
  const csv = O.placesCsv(O.sortPlaces(g.deploy, 'count'), { labelOf: (p) => p.op === 'Bolt' ? '=HYPERLINK("evil")' : 'Markt; Ecke', nearOf: near }).split('\n');
  assert(csv[0] === O.PLACES_FIELDS.join(';') && csv.length === 4 && csv[1].startsWith('Ausbringen;Dott;"Markt; Ecke";') && csv.some(l => l.includes(`"'=HYPERLINK(""evil"")"`)), 'CSV der gefilterten Zeilen mit Formel-Schutz und Quoting');
  const csvEn = O.placesCsv(O.sortPlaces(g.deploy, 'count'), { labelOf: (p) => p.op === 'Bolt' ? '=HYPERLINK("evil")' : 'Markt, Ecke', nearOf: near, lang: 'en' }).split('\n');
  assert(csvEn[0].startsWith('type,operator,location,lat,lon,count,vehicles_total,vehicles_mean,first,last,vehicle_types,nearest_spot') && csvEn[1].startsWith('Deployment,Dott,"Markt, Ecke",') && csvEn.some(l => l.includes(`"'=HYPERLINK(""evil"")"`) || l.includes("'=HYPERLINK")), 'Orte-CSV englisch: Spalten, Komma-Quoting, Formel-Schutz');
  assert(/;2026-10-20 10:00;2026-11-02 09:00;scooter 15;1;\d+$/.test(csv[1]), `CSV: erstmals/zuletzt in Ortszeit, Arten, nächster Spot (${csv[1].split(';').slice(-5).join(';')})`);
  // groups.json (Rückfall, ein Dokument) geht genauso
  assert(O.groupPlaces({ fields: F, events: oct.events }, { ags: AGS }).deploy.length === 3, 'groups.json als einzelnes Dokument');
  // Leistung: 20.000 Ereignisse über 2 km² in < 400 ms
  let seed = 3; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const big = { fields: F, events: [...Array(20000)].map((_, i) => e(i / 10, rnd() < 0.7 ? 'deploy' : 'collect', rnd() < 0.5 ? 'Dott' : 'Voi', 48.5 + rnd() * 0.012, 9.05 + rnd() * 0.017, 4 + Math.floor(rnd() * 6))) };
  const [gb, ms] = best(() => O.groupPlaces(big, { ags: AGS }));
  assert(gb.events.deploy + gb.events.collect === 20000 && ms < 400 * SLOW, `20.000 Ereignisse → ${gb.deploy.length + gb.collect.length} Orte in ${ms.toFixed(0)} ms (< ${(400 * SLOW).toFixed(0)} ms)`);
}
// --- Reihenfolge nach Kilometern und Priorität (Nutzerwunsch 01.11.2026: kilometeroptimiert, lange Standzeit / niedriger Akku früher)
{
  let seed = 41; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const LAT = 48.78, LON = 9.18, KX = 111320 * Math.cos(LAT * Math.PI / 180);
  const P = (x, y, extra = {}) => ({ lat: LAT + y / 111320, lon: LON + x / KX, ...extra }), XY = (p) => ({ x: (p.lon - LON) * KX, y: (p.lat - LAT) * 111320 });
  const D0 = P(0, 0);
  const perms = (a) => a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map(p => [x, ...p]));
  // Ziel wie in lib (unabhängig nachgerechnet): L + λ · Σ w·d ÷ Σ w, w = Priorität − kleinste Priorität
  const score = (seq, cost, lam) => { const mn = Math.min(...seq.map(s => s.prio)), W = seq.reduce((a, s) => a + s.prio - mn, 0); let L = 0, wd = 0, p = D0;
    for (const s of seq) { L += cost(p, s); wd += (s.prio - mn) * L; p = s; } L += cost(p, D0); return { L, J: L + (W > 1e-9 && lam > 0 ? lam * wd / W : 0) }; };
  const inst = (n) => [...Array(n)].map((_, i) => P((rnd() - 0.5) * 8000, (rnd() - 0.5) * 6000, { i, prio: +(rnd() < 0.3 ? 1 + rnd() * 0.5 : rnd() * 0.6).toFixed(3) }));
  const asym = (a, b) => O.dist(a, b) * (b.lat > a.lat ? 1.3 : 1);
  // 1) λ = 0: kürzeste Tour gegen Brute-Force über alle 5040 Reihenfolgen von 7 Punkten (exakt und Heuristik, symmetrisch und asymmetrisch)
  let okExact = true, okHeur = 0, okKm = true;
  for (let k = 0; k < 8; k++) {
    const st = inst(7), cost = k % 2 ? asym : O.makeCost(), best = Math.min(...perms(st).map(q => score(q, cost, 0).L));
    const ex = O.orderTour([st], { start: D0, end: D0, cost, weight: s => s.prio, lambda: 0 }), he = O.orderTour([st], { start: D0, end: D0, cost, weight: s => s.prio, lambda: 0, exact: false });
    if (Math.abs(score(ex.stops, cost, 0).L - best) > 1e-6 || Math.abs(ex.L - best) > 1e-6) okExact = false;
    if (Math.abs(score(he.stops, cost, 0).L - best) < 1e-6) okHeur++;
    if (O.sequenceRun([st], { depot: D0, cost, lambda: 0 }).km !== +(best / 1000).toFixed(1)) okKm = false;
  }
  assert(okExact && okKm, 'λ = 0: exakte Reihenfolge = kürzeste Tour laut Brute-Force (7 Punkte, 8 Instanzen, auch asymmetrisch), km stimmen');
  assert(okHeur >= 7, `λ = 0: Heuristik findet die kürzeste Tour in ${okHeur} von 8 Instanzen`);
  // 2) λ > 0: exakt (Held-Karp mit Prioritätsaufschlag) = Brute-Force des Ziels, auch mit Gruppen (3 Abholungen, dann 4 Ausbringungen)
  let okJ = true, okG = true, okHJ = 0, cnt = 0;
  for (let k = 0; k < 8; k++) {
    const st = inst(7), cost = k % 2 ? asym : O.makeCost(), lam = [0.5, 1, 2, 4][k % 4];
    const best = Math.min(...perms(st).map(q => score(q, cost, lam).J));
    const ex = O.orderTour([st], { start: D0, end: D0, cost, weight: s => s.prio, lambda: lam });
    if (Math.abs(score(ex.stops, cost, lam).J - best) > 1e-6 || Math.abs(ex.J - best) > 1e-6) okJ = false;
    const he = O.orderTour([st], { start: D0, end: D0, cost, weight: s => s.prio, lambda: lam, exact: false }); cnt++;
    if (score(he.stops, cost, lam).J <= best * 1.01 + 1e-6) okHJ++;
    const pk = st.slice(0, 3), dr = st.slice(3), bestG = Math.min(...perms(pk).flatMap(a => perms(dr).map(b => score([...a, ...b], cost, lam).J)));
    const g = O.orderTour([pk, dr], { start: D0, end: D0, cost, weight: s => s.prio, lambda: lam });
    if (Math.abs(g.J - bestG) > 1e-6 || !g.stops.slice(0, 3).every(s => pk.includes(s))) okG = false;
  }
  assert(okJ, 'λ > 0: exakte Reihenfolge = Minimum von Strecke + λ · gewichtete Anfahrt laut Brute-Force (7 Punkte, 8 Instanzen)');
  assert(okG, 'Gruppen (erst 3 Abholungen, dann 4 Ausbringungen): exakt = Brute-Force über 3! · 4! Reihenfolgen, Abholungen zuerst');
  assert(okHJ >= cnt - 1, `λ > 0: Heuristik höchstens 1 % über dem Optimum in ${okHJ} von ${cnt} Instanzen`);
  // 3) Regler: mit wachsendem λ nie kürzer, gewichtete Anfahrt der dringenden Stopps nie später (exakt, 10 Punkte)
  let mono = true; for (let k = 0; k < 6; k++) { const st = inst(10); let prev = null;
    for (const lam of O.PRIO_LEVELS) { const r = O.orderTour([st], { start: D0, end: D0, weight: s => s.prio, lambda: lam }); if (prev && (r.L < prev.L - 1e-6 || r.reach > prev.reach + 1e-6)) mono = false; prev = r; } }
  assert(mono && O.PRIO_LEVELS[0] === 0 && O.PRIO_LEVELS[O.PRIO_LEVEL_DEFAULT] === O.DEFAULTS.prioLambda, 'Regler Priorität ↔ Strecke: Stufe 0 = nur km; höhere Stufe → Strecke steigt nie, dringende Stopps kommen nie später');
  // 4) Ring mit 10 Stopps, Depot unten außerhalb; im Uhrzeigersinn 4 % günstiger (Einbahnstraßen). U = dringend (1,5), Rest 0,2
  const C = { x: 0, y: 2000 };
  const ring = (uAng) => [...Array(10)].map((_, i) => { const a = -90 + 36 * i, r = a * Math.PI / 180; return P(C.x + 1500 * Math.cos(r), C.y + 1500 * Math.sin(r), { i, prio: Math.abs(a - uAng) < 1 ? 1.5 : 0.2 }); });
  const cw = (a, b) => { const A = XY(a), B = XY(b), cr = (A.x - C.x) * (B.y - C.y) - (A.y - C.y) * (B.x - C.x); return O.dist(a, b) * (cr > 1e3 ? 1.04 : 1); };
  const at = (lam, uAng, exact = true) => { const r = O.orderTour([ring(uAng)], { start: D0, end: D0, cost: cw, weight: s => s.prio, lambda: lam, exact }); return { pos: r.stops.findIndex(s => s.prio === 1.5) + 1, L: r.L }; };
  const near0 = at(0, -54), near1 = at(1, -54), near1h = at(1, -54, false);
  assert(near0.pos >= 9 && near1.pos === 1 && near1h.pos === 1 && near1.L / near0.L < 1.05, `dringender Stopp nahe am Depot: ohne Priorität als ${near0.pos}. angefahren, mit λ = 1 als ${near1.pos}. (Umweg ${((near1.L / near0.L - 1) * 100).toFixed(1)} %, Heuristik ebenso)`);
  const far1 = at(1, 90), far4 = at(4, 90);
  assert(far1.pos === at(0, 90).pos && Math.abs(far1.L - at(0, 90).L) < 1e-6 && far4.pos < far1.pos && far4.L > far1.L * 1.2, `dringender Stopp gegenüber: großer Umweg → bei λ = 1 bleibt er an Stelle ${far1.pos}, erst bei λ = 4 an Stelle ${far4.pos} (+${((far4.L / far1.L - 1) * 100).toFixed(0)} % km)`);
  // gleiche Prioritäten: reine Kilometer-Optimierung unabhängig von λ
  const flat = inst(9).map(s => ({ ...s, prio: 0.7 })), f0 = O.orderTour([flat], { start: D0, end: D0, weight: s => s.prio, lambda: 0 }), f4 = O.orderTour([flat], { start: D0, end: D0, weight: s => s.prio, lambda: 4 });
  assert(Math.abs(f0.L - f4.L) < 1e-6 && f4.reach === null, 'gleiche Prioritäten: λ ändert nichts (kürzeste Tour)');
  // 5) Matrix statt Luftlinie: C–D liegen nah, aber durch einen Fluss getrennt (Straße 9 km); Matrix wird genutzt, fehlende Werte → Luftlinie × 1,35
  const A = P(1000, 0, { prio: 0, n: 'A' }), B = P(1000, 300, { prio: 0, n: 'B' }), Cc = P(2000, 0, { prio: 0, n: 'C' }), Dd = P(2000, 300, { prio: 0, n: 'D' });
  const pts = [D0, A, B, Cc, Dd], air = O.makeCost();
  const Dm = pts.map(p => pts.map(q => p === q ? 0 : air(p, q)));
  Dm[3][4] = Dm[4][3] = 9000; Dm[0][4] = null; // C–D nur über eine ferne Brücke; Depot → D fehlt in der Matrix
  const mcost = O.matrixCost(pts, Dm);
  const viaAir = O.sequenceRun([[A, B, Cc, Dd]], { depot: D0, cost: air, lambda: 0 }), viaRoad = O.sequenceRun([[A, B, Cc, Dd]], { depot: D0, cost: mcost, lambda: 0 });
  const adj = (r, x, y) => r.stops.some((s, i) => i > 0 && ((s.n === x.n && r.stops[i - 1].n === y.n) || (s.n === y.n && r.stops[i - 1].n === x.n)));
  const roadKm = (seq) => { let m = 0, p = D0; for (const s of seq) { m += mcost(p, s); p = s; } return m + mcost(p, D0); };
  assert(adj(viaAir, Cc, Dd) && !adj(viaRoad, Cc, Dd) && viaRoad.km === +(roadKm(viaRoad.stops) / 1000).toFixed(1), `Straßenmatrix statt Luftlinie: Reihenfolge meidet die Flussquerung (${viaRoad.km} km nach Matrix)`);
  assert(Math.abs(mcost(D0, Dd) - air(D0, Dd)) < 1e-9 && Math.abs(mcost(D0, Dd) / O.dist(D0, Dd) - 1.35) < 1e-9 && mcost({ ...Cc }, { ...Dd }) === 9000, 'Matrix: fehlender Wert → Luftlinie × 1,35; Punkte auch über Koordinaten gefunden');
  // 6) Prioritätswerte und Gründe
  const pv = O.vehiclePrio('swap', { battery: 8, rangeKm: 4, idleMin: 31 * 60 }, { swapThreshold: 20, swapRangeKm: 5 });
  assert(Math.abs(pv.prio - (0.7 * 0.6 + 0.3 + 0.5)) < 1e-9 && pv.why.battery === 8 && pv.why.idleH === 31, `Akkutausch: Akku 8 %, steht 31 h → Priorität ${pv.prio} (0,7 × Energie-Lücke 0,6 + 0,3 × Standzeit + 0,5 ab 24 h)`);
  const pr = O.vehiclePrio('swap', { battery: 18, rangeKm: 0.5, idleMin: 60 }, { swapThreshold: 20, swapRangeKm: 5 });
  assert(Math.abs(pr.prio - (0.7 * 0.9 + 0.3 / 24)) < 1e-3, 'Akkutausch: größere Lücke von Ladestand und Reichweite zählt (Reichweite 0,5 km)');
  const w23 = O.vehiclePrio('pickup_disabled', { idleMin: 23 * 60 }), w25 = O.vehiclePrio('pickup_disabled', { idleMin: 25 * 60 });
  assert(w25.prio - w23.prio > 0.5 && w23.prio < 1 && w25.why.idleH === 25, `Werkstatt: über 24 h gesperrt deutlich dringender (${w23.prio} → ${w25.prio})`);
  assert(O.dropPrio(6, 0).prio === 1.5 && O.dropPrio(3, 2).prio === 0.5 && O.dropPrio(3, 0).why.empty === true, 'Ausbringen: Fehlmenge ÷ 6, Spot leer im Umkreis +0,5');
  // 7) Nebenbedingungen bleiben mit starker Priorität (λ = 4): Abholungen vor Ausbringungen, Kapazität, Einsatz ≤ 4 h
  const D1 = { lat: 48.78, lon: 9.18 };
  const cells = new Map(); const spotsR = [];
  for (let i = 0; i < 24; i++) { const lat = D1.lat + (rnd() - 0.5) * 0.09, lon = D1.lon + (rnd() - 0.5) * 0.13, cell = O.cellOf(lat, lon); spotsR.push({ rank: i + 1, cell, lat, lon, score: 1 - i / 30, target: 6 }); cells.set(cell, { startsPerHour: 0 }); }
  const sur = [...Array(120)].map(() => V(D1.lat + (rnd() - 0.5) * 0.12, D1.lon + (rnd() - 0.5) * 0.17, { idleMin: Math.floor(rnd() * 3000) }));
  const rb4 = O.planRebalance({ spots: spotsR, vehicles: sur, model: { cells }, depot: D1, vanCapacity: 30, maxRuns: 8, prioLambda: 4 });
  const okOrder = rb4.runs.every(r => { const fd = r.stops.findIndex(s => s.type === 'drop'); return fd > 0 && r.stops.slice(fd).every(s => s.type === 'drop'); });
  assert(okOrder && rb4.runs.every(r => r.vehicles <= 30 && r.totalMin <= 240) && rb4.runs.reduce((s, r) => s + r.vehicles, 0) + rb4.unplanned === rb4.moves, 'Umsetzen mit λ = 4: erst einsammeln, dann ausbringen; Kapazität 30; jede Tour ≤ 4 h; eingeplant + nicht eingeplant = Umsetzungen');
  const spreadV = [...Array(200)].map(() => V(D1.lat + (rnd() - 0.5) * 0.11, D1.lon + (rnd() - 0.5) * 0.16, { battery: 2 + Math.floor(rnd() * 17), idleMin: Math.floor(rnd() * 4000) }));
  const sw4 = O.planSwaps({ vehicles: spreadV, model: m, depot: D1, swapThreshold: 20, maxRuns: 6, prioLambda: 4 }), sw0 = O.planSwaps({ vehicles: spreadV, model: m, depot: D1, swapThreshold: 20, maxRuns: 6, prioLambda: 0 });
  assert(sw4.runs.every(r => r.totalMin <= 240 && r.vehicles <= 50) && sw4.runs.reduce((s, r) => s + r.vehicles, 0) + sw4.unplanned === sw4.below, 'Akkutausch mit λ = 4: jede Tour ≤ 4 h, ≤ 50 Akkus, nichts verloren');
  const reach = (p) => p.runs.reduce((s, r) => s + (r.reachKm ?? 0), 0), kmOf = (p) => p.runs.reduce((s, r) => s + r.km, 0);
  assert(reach(sw4) < reach(sw0) && sw0.runs.every(r => r.km === r.kmMin), `Akkutausch: mit Priorität erreicht die Tour dringende Fahrzeuge früher (Σ gewichtete Anfahrt ${reach(sw4).toFixed(1)} statt ${reach(sw0).toFixed(1)} km, Strecke ${kmOf(sw4).toFixed(1)} statt ${kmOf(sw0).toFixed(1)} km); λ = 0 = kürzeste`);
  const r1 = sw4.runs[0], s1 = r1.stops[0];
  assert(r1.stops.every((s, i) => s.seq === i + 1 && s.rank >= 1 && s.why && Number.isFinite(s.prio)) && r1.kmNN >= r1.kmMin && r1.kmPrio >= r1.kmMin && s1.atKm > 0, `Tour nennt je Stopp Position, Rang, Priorität, Grund und Strecke bis dahin; Vergleich: kürzeste ${r1.kmMin} · Nächster Nachbar ${r1.kmNN} · reine Prioritätsfolge ${r1.kmPrio} km`);
  // Rechenzeit: 50 Stopps mit Priorität < 150 ms
  const big = inst(50); const [, ms] = best(() => O.orderTour([big], { start: D0, end: D0, weight: s => s.prio, lambda: 1 }));
  assert(ms < 150 * SLOW, `Reihenfolge mit Priorität: 50 Stopps in ${ms.toFixed(0)} ms (< ${(150 * SLOW).toFixed(0)} ms)`);
}
// --- M-10: Netto-Abfluss je Gemeinde ausgeglichen, vorsichtige Untergrenze in der MCDA, Poisson-Bootstrap für „stabil“
{
  const mk = (cells, { below = null, min = 180, band = 2, day = '2026-11-02' } = {}) => {
    const munis = { [AGS]: {} };
    for (const [cell, st, en] of cells) { const c = new Array(22).fill(0); c[4 + band] = st; c[16 + band] = en; c[10 + band] = 9; c[0] = st; c[1] = en; munis[AGS][cell] = c; }
    const bandMin = [0, 0, 0, 0, 0, 0], bandRuns = [0, 0, 0, 0, 0, 0]; bandMin[band] = min; bandRuns[band] = 9;
    return { day, bandMin, bandRuns, munis, ...(below ? { below: { [AGS]: below } } : {}) };
  };
  const cells = (m) => [...m.cells.values()];
  // 1) Ausgleich: 3 Zellen, Σ Enden = 1,2 × Σ Starts (Ausbringungen zählen als Enden) → Σ Netto = 0, Starts unverändert
  const c3 = [[cellAt(0, 0), 20, 30], [cellAt(0, 2), 30, 30], [cellAt(2, 0), 10, 12]]; // Σ Starts 60, Σ Enden 72
  const m3 = O.buildDemandModel([mk(c3)], AGS, 2);
  const net = cells(m3).reduce((s, c) => s + c.outPerHour, 0), raw = cells(m3).reduce((s, c) => s + c.outPerHourRaw, 0);
  assert(Math.abs(m3.balance.k - 60 / 72) < 1e-12 && Math.abs(net) < 1e-9 && Math.abs(raw + 4) < 1e-9 && m3.cells.get(cellAt(0, 0)).startsPerHour === 20 / 3,
    `Ausgleich: Σ Enden = 1,2 × Σ Starts → Enden × k = ${m3.balance.k.toFixed(3)}, Σ Netto ${net.toFixed(9)}/h (ohne Ausgleich ${raw}/h), Starts unverändert`);
  assert(m3.cells.get(cellAt(0, 2)).outPerHour > 0 && m3.cells.get(cellAt(0, 2)).outPerHourRaw === 0 && Math.abs(m3.cells.get(cellAt(0, 2)).endsPerHourBal - 30 * (60 / 72) / 3) < 1e-9,
    'Ausgleich: Zelle mit 30 Starts / 30 Enden fließt nach dem Ausgleich ab (Enden × k), gezählte Enden bleiben sichtbar');
  // 2) Unterdrückte Ereignisse (below) zählen in die Gemeindesumme, nicht in eine Zelle; andere Bänder zählen nicht
  const bl = new Array(14).fill(0); bl[2] = 12; bl[1] = 99; bl[7] = 99; // Band 2: 12 Starts; Band 1 nicht gewählt
  const mb = O.buildDemandModel([mk(c3, { below: bl })], AGS, 2);
  const cellStarts = cells(mb).reduce((s, c) => s + c.starts, 0);
  assert(mb.balance.belowStarts === 12 && mb.balance.belowEnds === 0 && mb.balance.totalStarts === 72 && mb.balance.k === 1 && mb.cells.size === 3 && cellStarts === 60,
    'below: 12 unterdrückte Starts in der Gemeindesumme (k = 72 ÷ 72 = 1), keiner Zelle zugeordnet; Band 1 zählt nicht');
  const netAll = cells(mb).reduce((s, c) => s + c.outPerHour, 0) + (mb.balance.belowStarts - mb.balance.k * mb.balance.belowEnds) / mb.hours;
  assert(Math.abs(netAll) < 1e-9 && Math.abs(cells(mb).reduce((s, c) => s + c.outPerHour, 0) + 4) < 1e-9, 'Σ Netto über Zellen + below = 0 (Zellen allein −4/h, below +4/h)');
  const only = O.buildDemandModel([mk(c3, { day: '2026-11-02' }), { day: '2026-11-03', bandMin: [0, 0, 180, 0, 0, 0], bandRuns: [0, 0, 9, 0, 0, 0], munis: {}, below: { [AGS]: bl } }], AGS, 2);
  assert(only.hours === 6 && only.days === 2 && only.balance.belowStarts === 12, 'Tag, an dem alle Zellen der Gemeinde unterdrückt sind: Messstunden und below zählen (Raten nicht überschätzt)');
  // 3) Untergrenze: 3 Starts und 1 Ende in 16 h → Netto 0,125/h ± 0,125 → Faktor 0; starker Abfluss (30/0) bleibt Faktor 1
  const X = cellAt(0, 0), Y = cellAt(0, 2), Z = cellAt(2, 0), W = cellAt(-2, 0);
  const m16 = O.buildDemandModel([mk([[X, 3, 1], [Y, 40, 42], [Z, 30, 0], [W, 0, 30]], { min: 960 })], AGS, 2); // Σ 73 / 73 → k = 1
  const s16 = O.scoreSpots(m16, { topN: 3, minSpacingM: 100 }), sx = s16.spots.find(s => s.cell === X), sz = s16.spots.find(s => s.cell === Z);
  assert(m16.balance.k === 1 && sx.outPerHour === 0.13 && sx.outSe === 0.13 && sx.outLow === 0 && sx.factors.outflow === 0 && sx.outLoOp < 0, `Untergrenze: 3 Starts / 1 Ende in 16 h → Netto ${sx.outPerHour} ± ${sx.outSe} /h, max(0, Netto − 2·SE) = 0 → Faktor 0 (ohne Untergrenze wäre er > 0)`);
  assert(sz.outLow > 1 && sz.factors.outflow === 1 && sz.rank === 1, `Untergrenze: 30 Starts ohne Rückkehr in 16 h → ${sz.outPerHour} − 2 · ${sz.outSe} = ${sz.outLow} /h, Faktor 1, Rang 1`);
  // 4) Poisson-Ziehung: Mittel und Varianz (Inversion λ < 10, PTRS λ ≥ 10)
  for (const lam of [3, 50, 400]) { const r = O.rng32(7); let s = 0, s2 = 0; const N = 20000; for (let i = 0; i < N; i++) { const x = O.poisson(lam, r); s += x; s2 += x * x; } const mu = s / N, va = s2 / N - mu * mu;
    assert(Math.abs(mu - lam) < 4 * Math.sqrt(lam / N) && Math.abs(va / lam - 1) < 0.05, `Poisson(${lam}): Mittel ${mu.toFixed(2)}, Varianz ${va.toFixed(1)}`); }
  // 5) Bootstrap: wenige, ähnliche Zählungen → Rang hängt am Zufall der Zählung. Gewichts-Sensitivität sagt „stabil“ (alle Abflüsse 0, Rang nur nach
  //    Nachfrage, ±20 % ändern die Reihenfolge nicht), der Bootstrap nicht. Eine Zelle mit 400 Starts bleibt in jeder Ziehung vorn.
  const flat = [[cellAt(-3, -3), 400, 400], ...[8, 7, 7, 6, 6, 6, 5, 5, 5, 5].map((n, i) => [cellAt(-3 + 2 * (i % 4), -1 + 2 * Math.floor(i / 4)), n, n])];
  const mf = O.buildDemandModel([mk(flat)], AGS, 2);
  const b1 = O.scoreSpots(mf, { topN: 3, minSpacingM: 100 }), b2 = O.scoreSpots(O.buildDemandModel([mk(flat)], AGS, 2), { topN: 3, minSpacingM: 100 });
  const weak = b1.spots.filter(s => s.bootShare < O.BOOT.minShare);
  assert(b1.boot.draws === 200 && b1.boot.seed === O.BOOT.seed && JSON.stringify(b1.spots.map(s => [s.cell, s.bootShare])) === JSON.stringify(b2.spots.map(s => [s.cell, s.bootShare])),
    `Bootstrap deterministisch (200 Ziehungen, fester Startwert): Anteile ${b1.spots.map(s => s.bootShare).join(' / ')} in beiden Läufen gleich`);
  assert(b1.spots[0].starts === 400 && b1.spots[0].bootShare === 1 && b1.spots[0].stabilityLabel === 'stabil', 'Bootstrap: Zelle mit 400 Starts in allen Ziehungen vorn → stabil');
  assert(weak.length >= 1 && weak.every(s => s.stabilityWeights === 1 && s.stabilityLabel === 'unsicher') && b1.uncertain === weak.length,
    `unsicherer Spot wird nicht „stabil“: ${weak.map(s => `Rang ${s.rank} (${s.starts} Starts) in ${Math.round(s.bootShare * 100)} % der Ziehungen`).join(', ')} → unsicher, obwohl ±20 % Gewichte stabil`);
  const nob = O.scoreSpots(mf, { topN: 3, minSpacingM: 100, bootDraws: 0 });
  assert(nob.boot === null && nob.spots.every(s => s.bootShare === null && s.stabilityLabel === 'stabil'), 'ohne Bootstrap (bootDraws 0, Vorauswahl im Browser) nur die Gewichts-Sensitivität');
  const other = O.scoreSpots(mf, { topN: 3, minSpacingM: 100, bootSeed: 1 });
  assert(other.spots.every((s, i) => Math.abs(s.bootShare - b1.spots[i].bootShare) < 0.15), 'anderer Startwert: Anteile im Rahmen der Ziehungsschwankung (±0,15)');
  // 6) Bedarf nutzt den ausgeglichenen Abfluss (Schätzwert), nicht die Untergrenze: X hat Abfluss > 0 → Bedarf mit Abfluss im Horizont
  assert(sx.drain > 0 && sx.drain === +(sx.outPerHourOp * 3).toFixed(1), `Bedarf: ausgeglichener Abfluss ${sx.outPerHourOp}/h × 3 h = ${sx.drain} (Untergrenze nur in der Rangfolge)`);
}
// --- Akkutausch: Reichweiten-Schwelle relativ zur Quelle (Nutzerwunsch 02.11.2026): min(eingestellte Schwelle, v.rangeLimitKm)
{
  const o = { swapThreshold: 20, swapRangeKm: 5 };
  // Lime über MobiData BW: Ladestand verworfen (Skala unplausibel), Reichweite höchstens ≈ 12–15 km → Schwelle der Quelle 2,4 km
  assert(O.needsSwap({ battery: null, rangeKm: 4 }, o) === true && O.needsSwap({ battery: null, rangeKm: 4, rangeLimitKm: 2.4 }, o) === false && O.needsSwap({ battery: null, rangeKm: 2, rangeLimitKm: 2.4 }, o) === true,
    'Schwelle der Quelle: 4 km bei Schwelle 2,4 km nicht tauschen (vorher < 5 km: tauschen), 2 km tauschen');
  assert(O.needsSwap({ battery: null, rangeKm: 2, rangeLimitKm: 2.4 }, { swapThreshold: 20, swapRangeKm: 1.5 }) === false && O.swapRangeOf({ rangeLimitKm: 2.4 }, 1.5) === 1.5 && O.swapRangeOf({ rangeLimitKm: 2.4 }, 5) === 2.4 && O.swapRangeOf({ rangeLimitKm: null }, 5) === 5,
    'eingestellter Wert kleiner als die Schwelle der Quelle: der kleinere gilt (min); ohne Schwelle der eingestellte Wert');
  assert(O.needsSwap({ battery: 15, rangeKm: 3, rangeLimitKm: 2.4 }, o) === false && O.needsSwap({ battery: 15, rangeKm: 2, rangeLimitKm: 2.4 }, o) === true && O.needsSwap({ battery: 15, rangeKm: 12, rangeDerived: true, rangeLimitKm: 2.4 }, o) === true,
    'UND-Regel und abgeleitete Reichweite (rangeDerived → nur Ladestand) bleiben');
  const doc = { at: 1, types: ['scooter'], ops: ['Lime'], munis: [AGS], vehicleFields: 'lat,lon,op,type,flags(1=reserviert,2=gesperrt),akku%,reichweiteKm,standzeitMin,gemeinde,reichweiteAbgeleitet,reichweiteSchwelleKm',
    vehicles: [[48.5, 9.05, 0, 0, 0, null, 4, 10, 0, 0, 2.4], [48.5, 9.051, 0, 0, 0, null, 2, 10, 0, 0, 2.4], [48.5, 9.052, 0, 0, 0, null, 4, 10, 0, 0, null], [48.5, 9.053, 0, 0, 0, null, 4, 10, 0, 0]] };
  const fl = O.decodeFleet(doc);
  assert(fl.vehicles[0].rangeLimitKm === 2.4 && fl.vehicles[2].rangeLimitKm === null && fl.vehicles[3].rangeLimitKm === null && fl.vehicles.filter(v => O.needsSwap(v)).length === 3 && O.fleetKpis(fl.vehicles).low === 3,
    'decodeFleet: Feld 11 „reichweiteSchwelleKm“ → v.rangeLimitKm (null und ältere Dateien = Standard); 3 von 4 tauschbedürftig');
  const fz = O.decodeFleet({ ...doc, trackStart: 5, vehicles: [[48.5, 9.05, 0, 0, 0, null, 4, 2179, 0, 0, null, null, 1], [48.5, 9.05, 0, 0, 0, null, 4, null, 0, 0], ...doc.vehicles.slice(0, 1)] });
  assert(fz.trackStart === 5 && fz.vehicles[0].idleCensored === true && fz.vehicles[0].idleMin === 2179 && fz.vehicles[1].idleMin === null && !fz.vehicles[1].idleCensored && !fz.vehicles[2].idleCensored && fl.trackStart === null,
    'decodeFleet: Feld 13 „standzeitMindestens“ → v.idleCensored (fehlt = nein), Standzeit null bleibt null, trackStart aus dem Kopf (ältere Dateien null)');
  const pv = O.vehiclePrio('swap', { battery: null, rangeKm: 1.2, rangeLimitKm: 2.4, idleMin: 0 }, o);
  assert(Math.abs(pv.prio - 0.7 * 0.5) < 1e-9, `Priorität: Energie-Lücke relativ zur Schwelle der Quelle (1 − 1,2 ÷ 2,4 = 0,5 → ${pv.prio})`);
  const swl = O.planSwaps({ vehicles: fl.vehicles, model: m, depot, swapThreshold: 20, swapRangeKm: 5 });
  assert(swl.below === 3, 'Akkutausch-Plan: Schwelle der Quelle angewandt (3 Fahrzeuge)');
}
// --- Konstante Reichweite der Quelle (v.rangeFlat): zählt für den Akkutausch nicht
{
  const o = { swapThreshold: 20, swapRangeKm: 5 };
  assert(O.needsSwap({ battery: null, rangeKm: 1, rangeFlat: true }, o) === false && O.needsSwap({ battery: 10, rangeKm: 1, rangeFlat: true }, o) === true && O.needsSwap({ battery: 30, rangeKm: 1, rangeFlat: true }, o) === false && O.needsSwap({ battery: null, rangeKm: 1 }, o) === true,
    'rangeFlat: ohne Ladestand kein Tausch (Platzhalter 1 km), mit Ladestand entscheidet er; ohne Kennzeichen wie bisher');
  const pv = O.vehiclePrio('swap', { battery: 10, rangeKm: 0, rangeFlat: true, idleMin: 0 }, o);
  assert(Math.abs(pv.prio - 0.7 * 0.5) < 1e-9 && O.rangeUsable({ rangeKm: 0, rangeFlat: true }) === false && O.rangeUsable({ rangeKm: 0 }) === true, 'Priorität: konstante Reichweite 0 km zählt nicht in die Energie-Lücke (nur Ladestand 10 % → 0,5)');
}
// --- Einsammelliste: Fahrzeuge im eigenen Abstellverbot (parkingViolations), Regeln im Format von zones/*.json (Sammler)
{
  const NP = [{ rideAllowed: false, rideThrough: true, endAllowed: null, maxSpeed: null, parking: null }], NR = [{ rideAllowed: false, rideThrough: false, endAllowed: null, parking: false }];
  const MPZ = [{ rideAllowed: false, rideThrough: true, endAllowed: null, parking: true }], OK = [{ rideAllowed: true, rideThrough: true, endAllowed: null, maxSpeed: 20, parking: null }];
  assert(O.zoneKind(NP) === 'ban' && O.zoneKind(NR) === 'ban' && O.zoneKind(MPZ) === 'mpz' && O.zoneKind(OK) === 'ok' && O.zoneKind([{ rideAllowed: true, endAllowed: false }]) === 'ban' && O.zoneKind([{ parking: true, rideThrough: false }]) === 'ban' && O.zoneKind([]) === null,
    'zoneKind: ride_allowed=false (GBFS 2.x) oder Fahrtende/Durchfahrt verboten = Verbot; station_parking = Pflicht-Abstellzone; erlaubt; ohne Regel keine Art');
  const [la, lo] = [48.52, 9.05], mLat = (x) => x / 111320, mLon = (x) => x / (111320 * Math.cos(la * Math.PI / 180));
  const at = (n, e) => [la + mLat(n), lo + mLon(e)]; // Meter nördlich/östlich der Mitte
  const rect = ([lat, lon], h) => [[lon - mLon(h), lat - mLat(h)], [lon + mLon(h), lat - mLat(h)], [lon + mLon(h), lat + mLat(h)], [lon - mLon(h), lat + mLat(h)], [lon - mLon(h), lat - mLat(h)]];
  const feat = (coordinates, rules, name) => ({ type: 'Feature', properties: { name, rules }, geometry: { type: 'Polygon', coordinates } });
  // Verbotszone 400 × 400 m mit Loch 10 × 10 m 110–120 m nördlich der Mitte; Betriebsgebiet (größer) hebt nichts auf, kleiner Hub schon
  // Pflicht-Abstellzone (Abstellen nur an Stationen) 600 × 600 m 2 km nördlich, darin ein kleiner Hub
  const mine = { operator: 'Bolt', sourceId: 'bolt_test', features: [feat([rect(at(0, 0), 5000)], OK, 'Betriebsgebiet'), feat([rect(at(0, 0), 200), rect(at(115, 0), 5)], NP, '=HYPERLINK("x")'),
    feat([rect(at(-100, -100), 10)], MPZ, 'MPZ'), feat([rect(at(-100, 100), 6)], OK, 'Hub'), feat([rect(at(0, 1000), 200)], NR, 'Fahrverbot'),
    feat([rect(at(2000, 0), 300)], MPZ, 'Nur Stationen'), feat([rect(at(1900, -100), 6)], OK, 'Hub 2')] };
  const other = { operator: 'Lime', sourceId: 'lime_test', features: [feat([rect(at(0, -1000), 200)], NP, 'fremd')] };
  const V = (name, [lat, lon], o = {}) => ({ name, lat, lon, operator: 'Bolt', type: 'scooter', reserved: false, disabled: false, battery: 50, rangeKm: 20, idleMin: 600, ags: AGS, ...o });
  const vehicles = [V('A', at(0, 0)), V('B', at(0, 180)), V('C', at(-100, -100)), V('D', at(-60, 60)), V('E', at(-60, -60), { idleMin: 1500, idleCensored: true }), V('F', at(-100, 100)),
    V('G', at(10, 10), { disabled: true }), V('H', at(10, -10), { reserved: true }), V('I', at(0, -1000)), V('J', at(100, 0)), V('K', at(0, 1000), { idleMin: null }), V('L', at(5, 5), { operator: 'Lime' }), V('M', at(0, 3000)),
    // N1 Mitte (Station 152 m), N2 20 m vor dem Rand, N3 Station 15 m, N4 Station 40 m (knapp daneben), N5 im Hub, N6 Station 70 m
    V('N1', at(2000, 0)), V('N2', at(2000, 280)), V('N3', at(2100, 100)), V('N4', at(1900, 100)), V('N5', at(1900, -100)), V('N6', at(2100, -100), { idleMin: 900 })];
  const st = (p, operator) => ({ lat: p[0], lon: p[1], operator });
  const stations = [st(at(-60, 70), 'Bolt'), st(at(-60, -50), 'Lime'), st(at(2100, 115), 'Bolt'), st(at(1900, 140), 'Bolt'), st(at(2170, -100), 'Bolt')];
  const r = O.parkingViolations({ vehicles, stations }, [mine, other, mine], { operator: 'Bolt' }), c = r.counts, cb = c.ban, cm = c.mpz;
  const names = (l) => l.map(x => vehicles.find(v => v.lat === x.lat && v.lon === x.lon).name).join(',');
  assert(c.available === 16 && cb.inZone === 8 && cb.mpz === 1 && cb.allowed === 1 && cb.station === 1 && cb.raw === 5, `Abstellverbot: 16 verfügbar (gesperrt, reserviert, fremder Anbieter fehlen), 8 in Verbotszone, je 1 in MPZ, Hub, ≤ 25 m eigene Station → roh 5 (${JSON.stringify(cb)})`);
  assert(cb.robust[15] === 4 && cb.robust[25] === 4 && cb.robust[50] === 4 && cb.listed === 3 && names(r.list.filter(x => x.kind === 'ban')) === 'E,A,K',
    `robust je Puffer 4/4/4, gelistet nur bei allen Puffern: B (20 m vor dem Rand) nur 15 m, J (Loch 15 m nördlich) nur 25/50 m → E, A, K`);
  assert(!names(r.list).includes('I') && r.zones.ban === 2 && r.zones.mpz === 2 && r.zones.ok === 3, 'fremde Zone zählt nicht (I), doppelt geladene eigene Datei zählt einmal (2 Verbots-, 2 Pflicht-, 3 erlaubte Zonen)');
  assert(O.COLLECT.mpzStationM === 50 && cm.inZone === 7 && cm.allowed === 1 && cm.station === 1 && cm.near === 1 && cm.raw === 4 && cm.robust[15] === 3 && cm.robust[25] === 2 && cm.robust[50] === 2 && cm.listed === 2,
    `Pflicht-Abstellzone ohne Station: 7 in Zone, Hub 1, Station ≤ 25 m 1, knapp neben Station 25–50 m 1 (nur gezählt), roh 4 (C, N1, N2, N6), robust 3/2/2 → gelistet N1, N6 (${JSON.stringify(cm)})`);
  assert(c.listed === 5 && names(r.list) === 'E,N6,A,N1,K' && r.list.map(x => x.kind).join() === 'ban,mpz,ban,mpz,ban', `eine Liste nach Standzeit, Art je Fahrzeug (${names(r.list)})`);
  const [e, n6, a, n1, k] = r.list;
  assert(e.idleCensored === true && e.idleMin === 1500 && a.idleCensored === null && k.idleMin === null && k.zone.noRide === true && a.zone.id === 'bolt_test#1' && a.zone.name === '=HYPERLINK("x")' && a.battery === 50 && a.rangeKm === 20,
    'Liste: Standzeit (≥ über idleCensored, fehlend = null), Zone (ID, Name, Fahrverbot), Ladestand und Reichweite');
  assert(n6.stationDistM === 70 && n1.stationDistM === 152 && n1.zone.name === 'Nur Stationen' && e.stationDistM === 130, `Abstand zur nächsten eigenen Station (fremde Station neben E zählt nicht): N6 ${n6.stationDistM} m, N1 ${n1.stationDistM} m, E ${e.stationDistM} m`);
  assert(O.parkingViolations({ vehicles, stations }, [mine], { operator: 'Bolt', mpzStationM: 30 }).counts.mpz.listed === 3, 'mpzStationM einstellbar: bei 30 m wird N4 (Station 40 m) gelistet');
  assert(r.zonesHit.length === 3 && r.zonesHit.find(z => z.id === 'bolt_test#1').n === 2 && r.zonesHit.find(z => z.noRide).n === 1 && r.zonesHit.find(z => z.kind === 'mpz').n === 2 && r.zonesHit[0].geometry?.type === 'Polygon', 'betroffene Zonen mit Art, Umriss und Anzahl (Kartenebene)');
  assert(O.parkingViolations({ vehicles, stations }, [], { operator: 'Bolt' }).features === 0 && O.parkingViolations({ vehicles, stations }, other, { operator: 'Bolt' }).features === 0, 'keine eigenen Zonen: features 0 („Anbieter veröffentlicht keine Zonen“)');
  const none = O.parkingViolations({ vehicles: [vehicles[12]], stations }, mine, { operator: 'Bolt' });
  assert(none.features === 7 && none.counts.listed === 0 && !none.list.length, 'Zonen vorhanden, kein Treffer („keine Fahrzeuge im Abstellverbot“)');
  const csv = O.violationsCsv(r).split('\n'), en = O.violationsCsv(r, { lang: 'en' }).split('\n');
  assert(csv[0] === O.COLLECT_CSV_FIELDS.join(';') && csv.length === 6 && csv[1].startsWith('1;Bolt;Abstellverbot;') && csv[1].includes(`;"'=HYPERLINK(""x"")";Abstellverbot;130;1500;1;50;20;scooter`) && csv[2].startsWith('2;Bolt;Pflicht-Abstellzone ohne Station;') && csv[2].includes(';Nur Stationen;Pflicht-Abstellzone;70;900;;50;'),
    'CSV: Spalte art, Formel-Schutz für Zonennamen aus dem Feed, Stationsabstand, Standzeit mindestens 1/leer');
  assert(en[0] === 'rank,operator,kind,lat,lon,zone_id,zone_name,zone_kind,station_distance_m,idle_from_min,idle_at_least,battery_pct,range_km,vehicle_type' && en[2].includes('mandatory parking zone without station') && en[5].includes('no-riding zone'), 'CSV englisch: Komma, englische Spalten, Art und Zonenart');
}
// Veröffentlichte Standzeit nur als Klasse, Reichweite in ganzen km (ops/<Land>.json, snapshot/, idle-long.json)
{
  const cls = [null, 0, 40, 359, 360, 1439, 1440, 2879, 2880, 8700].map(O.idleClassMin);
  assert(JSON.stringify(cls) === JSON.stringify([null, 0, 0, 0, 360, 360, 1440, 1440, 2880, 8640]), `Standzeit-Klassen: unter 6 h → 0, 6–24 h → 360, danach ganze Tage (${cls})`);
  assert(O.idleClassText(40) === 'unter 6 h' && O.idleClassText(400) === '6–24 h' && O.idleClassText(3000) === '2–3 Tage' && O.idleClassText(1500, { atLeast: true }) === '≥ 1 Tag' && O.idleClassText(3000, { en: true }) === '2–3 days' && O.idleClassText(null) === '–',
    'Standzeit-Klasse als Text (de/en, Mindestwert)');
  assert(O.rangePublic({ rangeKm: 23.46 }) === 23 && O.rangePublic({ rangeKm: 1.26, rangeLimitKm: 2.4 }) === 1.3 && O.rangePublic({ rangeKm: null }) === null && O.rangePublic({}) === null, 'Reichweite: ganze km, eigene Skala 0,1 km');
  const v = (idleMin) => ({ lat: 48.5, lon: 9.05, operator: 'Dott', type: 'scooter', battery: 80, idleMin: O.idleClassMin(idleMin) });
  assert(O.vehiclePrio('pickup', v(30 * 60)).prio === O.vehiclePrio('pickup', v(24 * 60)).prio && O.vehiclePrio('pickup', v(25 * 60)).prio > O.vehiclePrio('pickup', v(23 * 60)).prio, 'Disposition: 24-h-Grenze wirkt auch mit Klassen');
}

// Voreinstellungen je Fahrzeugart (08.11.2026)
assert(O.presetOf('car').van === 1 && O.presetOf('car').swapRangeKm === 50 && O.presetOf('moped').van === 8 && O.presetOf('scooter').van === O.DEFAULTS.vanCapacity && O.presetOf('all').swapRangeKm === O.DEFAULTS.swapRangeKm,
  'Disposition: Auto einzeln umgesetzt (1), Reichweite 50 km; E-Roller 8 je Transporter; übrige Standard');
assert(O.needsSwap({ battery: null, rangeKm: 30 }, { swapRangeKm: O.presetOf('car').swapRangeKm }) && !O.needsSwap({ battery: null, rangeKm: 30 }), 'needsSwap mit Auto-Schwelle: 30 km Reichweite → tanken/laden');

// ---------- Gesperrt wegen leerem Akku → Akkutausch statt Werkstatt (Audit 11.11.2026, MET-10/UXP-02)
{
  // Voi-artig: verfügbare ab 14 km, gesperrte 2–8 km (nur Reichweite, kein Ladestand); ein gesperrter mit 40 km = Schaden → Werkstatt
  const v = (i, km, dis) => ({ id: `v${i}`, lat: 48.52 + i * 1e-4, lon: 9.05, operator: 'Voi', type: 'scooter', rangeKm: km, battery: null, disabled: !!dis, reserved: false, idleMin: 60 });
  const fleet = [...Array.from({ length: 40 }, (_, i) => v(i, 14 + i)), v(100, 3, true), v(101, 6, true), v(102, 8, true), v(103, 40, true)];
  const floor = O.disableFloor(fleet), k = O.fleetKpis(fleet, { swapThreshold: 20, swapRangeKm: 5 });
  const model = { cells: new Map() };
  const sw = O.planSwaps({ vehicles: fleet, model, depot: { lat: 48.52, lon: 9.05 }, swapThreshold: 20, swapRangeKm: 5 });
  const ws = O.planWorkshop({ vehicles: fleet, depot: { lat: 48.52, lon: 9.05 } });
  assert(floor.rangeKm === 14 && floor.battery === null && k.low === 3 && k.lockedLow === 3 && sw.below === 3 && sw.locked === 3 && ws.disabled === 1 && ws.lockedLow === 3,
    `gesperrt unter der Betriebsgrenze (${floor.rangeKm} km) = Akkutausch (${sw.below}), gesperrt mit 40 km = Werkstatt (${ws.disabled})`);
  const few = O.disableFloor(fleet.slice(0, 10).concat(fleet.slice(40)));
  assert(few.rangeKm === null && !O.lockedForEnergy(fleet[40], few), 'unter 20 verfügbaren mit Angabe keine Betriebsgrenze: gesperrte bleiben Werkstatt');
}
