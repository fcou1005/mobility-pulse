// Geschätzte Start-Ziel-Ströme (lib/pulse-flowest.js): Kern, Zeitmodell, Grenzfälle, Datenschutz, Validierung, Laufzeit
import { readFileSync } from 'node:fs';
import * as T from '../lib/pulse-track.js';
import * as FE from '../lib/pulse-flowest.js';
const assert = (c, m) => { if (!c) { console.error('FEHLER:', m); process.exitCode = 1; } else console.log('ok:', m); };
let seed = 42; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const poisson = (l) => { if (l > 30) return Math.max(0, Math.round(l + Math.sqrt(l) * Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd()))); let k = 0, p = 1; const L = Math.exp(-l); do { k++; p *= rnd(); } while (p > L); return k - 1; };
const A0 = 19400, B0 = 2586; // Zellen um 48,50 N / 9,05 O (Tübingen)
const cellC = (a, b) => `${A0 + a}:${B0 + b}`;
const ctr = (cell) => T.cellCenter(cell);
const dist = (c1, c2) => { const [a, b] = ctr(c1), [c, d] = ctr(c2); return Math.hypot((c - a) * 111195, (d - b) * 111195 * Math.cos(a * Math.PI / 180)); };
const AGS = '08416041';
const keysDeep = (o, out = []) => { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { out.push(k); keysDeep(v, out); } return out; };
const leaves = (o, out = []) => { if (o && typeof o === 'object') for (const v of Object.values(o)) leaves(v, out); else out.push(o); return out; };

// ---------- Zeitmodell ----------
{
  const w = FE.lagWeights(20 * 60e3, 8 * 60e3, 2);
  assert(Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-12 && Math.abs(w[0] - 0.6328) < 0.002 && w[1] > w[2], `Anteile w0..w2 (dt 20, τ 8 Min.): ${w.map(x => x.toFixed(3)).join(' / ')}`);
  const w0 = 1 - (1 - Math.exp(-20 / 8)) / (20 / 8); // Anteil im selben Intervall, ungekürzt
  assert(Math.abs(FE.tauFromW0(w0, 20 * 60e3) / 60e3 - 8) < 0.01, 'tauFromW0 kehrt w0 um (8 Min.)');
  assert(FE.lagWeights(null, 8 * 60e3)[0] === 1 && FE.tauFromW0(1, 20 * 60e3) === null, 'ohne Intervall: alles im selben Lauf; w0 = 1 nicht umkehrbar');
}
// ---------- Kern: bekannte Gravitationsmatrix wird aus den Rändern wiedergewonnen ----------
{
  const src = [], snk = [];
  for (let k = 0; k < 14; k++) { const c = cellC(Math.floor(rnd() * 16), Math.floor(rnd() * 16)); if (!src.some(s => s.cell === c)) src.push({ cell: c }); }
  for (let k = 0; k < 14; k++) { const c = cellC(Math.floor(rnd() * 16), Math.floor(rnd() * 16)); if (!snk.some(s => s.cell === c)) snk.push({ cell: c }); }
  for (const x of [...src, ...snk]) { [x.lat, x.lon] = ctr(x.cell); }
  const L0 = 700, xs = src.map(() => 0.5 + rnd() * 3), ys = snk.map(() => 0.5 + rnd() * 3);
  const truth = new Map(); src.forEach((s, i) => snk.forEach((e, j) => { if (s.cell === e.cell) return; const d = dist(s.cell, e.cell); if (d < 150 || d > 8000) return; truth.set(`${i}>${j}`, xs[i] * ys[j] * Math.exp(-d / L0)); }));
  src.forEach((s, i) => { s.m = [...truth].filter(([k]) => +k.split('>')[0] === i).reduce((a, [, v]) => a + v, 0); s.dmax = 8000; });
  snk.forEach((e, j) => { e.m = [...truth].filter(([k]) => +k.split('>')[1] === j).reduce((a, [, v]) => a + v, 0); });
  const tot = [...truth.values()].reduce((a, b) => a + b, 0);
  const res = FE.solveRun(src, snk, { L: L0, phi: 1, iters: 3000, tol: 1e-9, prune: 0 });
  const est = new Map(res.pairs.map(([i, j, t]) => [`${i}>${j}`, t]));
  const cpc = 2 * [...truth].reduce((a, [k, v]) => a + Math.min(v, est.get(k) || 0), 0) / (tot + res.matched);
  assert(cpc > 0.99 && Math.abs(res.matched / tot - 1) < 1e-6, `bekannte Matrix a·b·exp(−d/L) aus den Rändern wiedergewonnen (CPC ${cpc.toFixed(4)})`);
  const res2 = FE.solveRun(src, snk, { L: L0 });
  const est2 = new Map(res2.pairs.map(([i, j, t]) => [`${i}>${j}`, t]));
  const cpc2 = 2 * [...truth].reduce((a, [k, v]) => a + Math.min(v, est2.get(k) || 0), 0) / (tot + res2.matched);
  assert(cpc2 > 0.97 && Math.abs(res2.matched / tot - 1) < 1e-6, `Standard (phi 0,95, Rückskalierung, Kappung 0,001): CPC ${cpc2.toFixed(3)}, Summe erhalten`);
  assert(res2.pairs.every(([i, j]) => src[i].cell !== snk[j].cell), 'gleiche Zelle nie als Paar');
}
// ---------- Grenzfälle des Kerns ----------
{
  const P = (cell, m, dmax = 8000) => { const [lat, lon] = ctr(cell); return { cell, lat, lon, m, dmax }; };
  assert(FE.solveRun([P(cellC(0, 0), 3)], []).pairs.length === 0 && FE.solveRun([], [P(cellC(1, 1), 2)]).pairs.length === 0, 'keine Enden bzw. keine Beginne: keine Paare');
  assert(FE.solveRun([P(cellC(0, 0), 2)], [P(cellC(0, 0), 2)]).pairs.length === 0, 'Beginn und Ende in derselben Zelle: ausgeschlossen');
  const near = { cell: 'x1', lat: 48.5, lon: 9.05, m: 1, dmax: 8000 }, near2 = { cell: 'x2', lat: 48.5009, lon: 9.05, m: 1 };
  assert(FE.solveRun([near], [near2]).pairs.length === 0 && FE.solveRun([near], [near2], { dminM: 50 }).pairs.length === 1, 'unter 150 m: ausgeschlossen');
  assert(FE.solveRun([P(cellC(0, 0), 1, 3000)], [P(cellC(0, 20), 1)]).pairs.length === 0, 'weiter als vmax × Dauer: ausgeschlossen');
  const u = FE.solveRun([P(cellC(0, 0), 3), P(cellC(10, 0), 1)], [P(cellC(0, 5), 1)], { L: 800 });
  assert(Math.abs(u.matched - 1) < 1e-9 && u.pairs.find(p => p[0] === 0)[2] > 0.7, `unausgeglichen (4 Beginne, 1 Ende): 1 Fahrt verteilt, nähere Quelle bevorzugt (${u.pairs.map(p => p[2].toFixed(2)).join(' / ')})`);
  const two = FE.solveRun([P(cellC(0, 0), 2), P(cellC(400, 0), 1)], [P(cellC(0, 6), 1), P(cellC(400, 6), 5)], { L: 800 });
  assert(Math.abs(two.matched - 2) < 1e-9, 'getrennte Komponenten: je min(Σ Beginne, Σ Enden) = 1 + 1');
}
// ---------- Tagesschätzung auf synthetischen Läufen: bekannte Matrix → Zählungen → Schätzung nahe dran ----------
const city = (() => { // Gitterstadt 14 × 14 Zellen, Anziehung mit Zentrum und zwei Hotspots
  const cells = []; for (let a = 0; a < 14; a++) for (let b = 0; b < 14; b++) { const r = Math.hypot(a - 7, b - 7); cells.push({ cell: cellC(a, b), w: Math.exp(-r / 5) * ((a === 3 && b === 10) || (a === 11 && b === 4) ? 6 : 1) }); }
  return cells;
})();
function synthDay({ L0 = 700, perRun = 12, nRuns = 60, dt = 20 * 60e3, tauMin = 0, op = 'Bolt', ty = 'scooter', which = 'est' } = {}) {
  const P = []; for (const o of city) for (const d of city) { if (o.cell === d.cell) continue; const dd = dist(o.cell, d.cell); if (dd < 150) continue; P.push([o.cell, d.cell, o.w * d.w * Math.exp(-dd / L0), dd]); }
  const s = P.reduce((a, p) => a + p[2], 0); for (const p of P) p[2] *= perRun / s;
  const t0 = Date.parse('2026-11-03T05:00:00Z'); let raw = null; const truth = new Map(), expected = new Map(); let n = 0, dsum = 0;
  const runs = [...Array(nRuns + 1)].map((_, k) => ({ at: t0 + k * dt, est: FE.emptyEst() }));
  const opty = `${op}|${ty}`, add = (o, node) => { const m = (o[opty] ??= {}); m[node] = (m[node] || 0) + 1; };
  const w1 = tauMin ? 1 - FE.lagWeights(dt, tauMin * 60e3, 1)[0] : 0;
  for (let k = 1; k <= nRuns; k++) for (const [o, d, lam, dd] of P) {
    if (k === 1) { const key = `${AGS}|${op}|${ty}|${o}>${d}`; expected.set(key, lam * nRuns); }
    const c = poisson(lam);
    for (let x = 0; x < c; x++) {
      const ke = rnd() < w1 ? k + 1 : k; if (ke > nRuns) continue;
      // wie trackRun: rotierend Beginn/Ende je Lauf; stabil Ende im Lauf der Rückkehr, Beginn als vsLate mit Lauf des Verschwindens
      if (which === 'val') { add(runs[ke].est.ve, `${AGS}|${d}`); if (ke === k) add(runs[k].est.vs, `${AGS}|${o}`); else runs[ke].est.vsLate.push([opty, `${AGS}|${o}`, runs[k].at]); }
      else { add(runs[k].est.s, `${AGS}|${o}`); add(runs[ke].est.e, `${AGS}|${d}`); }
      const key = `${AGS}|${op}|${ty}|${o}>${d}`; truth.set(key, (truth.get(key) || 0) + 1); n++; dsum += dd;
    }
  }
  for (let k = 0; k <= nRuns; k++) raw = FE.mergeEstCounts(raw, runs[k].est, { day: '2026-11-03', at: runs[k].at, dt: k ? dt : null, gap: k === 0, band: 2 });
  return { raw, truth, expected, meanKm: dsum / n / 1000, n };
}
const pairsOf = (rows) => { const m = new Map(); for (const [k, r] of Object.entries(rows)) { const [ags, op, ty] = k.split('|'); for (const [p, a] of Object.entries(r)) { const kk = `${ags}|${op}|${ty}|${p}`; m.set(kk, (m.get(kk) || 0) + a[0]); } } return m; };
{
  // bekannte Erwartungsmatrix (Gravitation, L 700 m, Anziehung mit Hotspots), daraus Poisson-gezogene Fahrten je Lauf → nur Zählungen
  const { raw, truth, expected, meanKm, n } = synthDay({ perRun: 60 });
  const cal = FE.calibrateL(raw, { targetKm: { scooter: meanKm }, factor: 1, carry: false });
  const r = FE.estimateDay(raw, { Lmap: cal.L, factor: 1, carry: false });
  const ce = FE.compareFlows(pairsOf(r.rows), expected, { factor: 1 }), ct = FE.compareFlows(pairsOf(r.rows), truth, { factor: 1 });
  const base = pairsOf(FE.estimateDay(raw, { Lmap: { scooter: Infinity }, factor: 1, carry: false }).rows);
  const be = FE.compareFlows(base, expected, { factor: 1 });
  const noise = FE.compareFlows(truth, expected, { factor: 1 }); // gezogene Fahrten selbst gegen die Erwartung (Rauschgrenze)
  assert(Math.abs(cal.L.scooter / 700 - 1) < 0.2, `Hyman: L aus mittlerer Fahrtlänge ${meanKm.toFixed(2)} km wiedergewonnen (${Math.round(cal.L.scooter)} m, wahr 700 m)`);
  assert(ce.cpc > 0.75 && ce.cpc > be.cpc + 0.12 && ce.r > 0.85 && Math.abs(ce.distDev) < 0.05, `${n} gezogene Fahrten: Schätzung gegen bekannte Matrix CPC ${ce.cpc}, r ${ce.r} (ohne Distanzzerfall ${be.cpc}; die gezogenen Fahrten selbst ${noise.cpc})`);
  assert(ct.cpc > FE.compareFlows(base, truth, { factor: 1 }).cpc && ct.topRatio > 0.6, `gegen die gezogenen Fahrten: CPC ${ct.cpc}, Top-50 ${ct.topShare}/${ct.topOracle}`);
  const c2 = FE.estimateDay(raw, { Lmap: cal.L, factor: 2, carry: false });
  assert(Math.abs(c2.stats.trips - r.stats.trips) / r.stats.trips < 0.1, 'Vergröberung 500 m: gleiche Fahrtensumme (bis auf Paare in derselben groben Zelle)');
}
// ---------- Fahrten über eine Laufgrenze: Übertrag aus dem Vorlauf ----------
{
  const mk = (runs) => { let raw = null; for (const r of runs) raw = FE.mergeEstCounts(raw, { ...FE.emptyEst(), s: r.s || {}, e: r.e || {} }, { day: '2026-11-03', at: r.at, dt: r.dt, gap: !!r.gap, band: 1 }); return raw; };
  const t = Date.parse('2026-11-03T06:00:00Z'), m20 = 20 * 60e3, X = `${AGS}|${cellC(0, 0)}`, Y = `${AGS}|${cellC(0, 6)}`;
  const raw = mk([{ at: t, dt: m20, s: { 'Bolt|scooter': { [X]: 1 } } }, { at: t + m20, dt: m20, e: { 'Bolt|scooter': { [Y]: 1 } } }]);
  const w = FE.lagWeights(m20, 7.9 * 60e3, 2);
  const withC = FE.estimateDay(raw, { Lmap: { scooter: 900 }, tauMap: { scooter: 7.9 }, factor: 1, carry: true }), noC = FE.estimateDay(raw, { Lmap: { scooter: 900 }, factor: 1, carry: false });
  const v = Object.values(withC.rows)[0]?.[`${cellC(0, 0)}>${cellC(0, 6)}`]?.[0];
  assert(Math.abs(v - w[1]) < 1e-9 && !Object.keys(noC.rows).length, `Beginn in Lauf k, Ende in Lauf k+1: erwartet w1 = ${w[1].toFixed(3)} mit Übertrag, ohne Übertrag nichts`);
  const gapRaw = mk([{ at: t, dt: m20, s: { 'Bolt|scooter': { [X]: 1 } } }, { at: t + 3 * 3600e3, dt: 3 * 3600e3, gap: true }, { at: t + 3 * 3600e3 + m20, dt: m20, e: { 'Bolt|scooter': { [Y]: 1 } } }]);
  assert(!Object.keys(FE.estimateDay(gapRaw, { Lmap: { scooter: 900 }, factor: 1, carry: true }).rows).length, 'Lücke dazwischen: kein Übertrag über die Lücke');
  const holeRaw = mk([{ at: t, dt: m20, s: { 'Bolt|scooter': { [X]: 1 } } }, { at: t + 2 * m20, dt: m20, e: { 'Bolt|scooter': { [Y]: 1 } } }]);
  assert(!Object.keys(FE.estimateDay(holeRaw, { Lmap: { scooter: 900 }, factor: 1, carry: true }).rows).length, 'Lauf fehlt in der Tagessumme (Abstand ≠ dt): Kette unterbrochen');
  const longRaw = mk([{ at: t, dt: m20, s: { 'Bolt|scooter': { [X]: 1 } } }, { at: t + 2 * m20, dt: 2 * m20, e: { 'Bolt|scooter': { [Y]: 1 } } }]);
  assert(Object.keys(FE.estimateDay(longRaw, { Lmap: { scooter: 900 }, factor: 1, carry: true }).rows).length === 1, 'längeres Intervall (dt 40 Min.): Kette bleibt');
  const lag2 = mk([{ at: t, dt: m20, s: { 'Bolt|scooter': { [X]: 1 } } }, { at: t + m20, dt: m20 }, { at: t + 2 * m20, dt: m20, e: { 'Bolt|scooter': { [Y]: 1 } } }]);
  const v2 = Object.values(FE.estimateDay(lag2, { Lmap: { scooter: 900 }, tauMap: { scooter: 7.9 }, factor: 1, carry: true }).rows)[0]?.[`${cellC(0, 0)}>${cellC(0, 6)}`]?.[0];
  assert(Math.abs(v2 - w[2]) < 1e-9, `zwei Läufe später: Anteil w2 = ${w[2].toFixed(3)}`);
  // Tageswechsel: letzte Läufe des Vortags als tail (nur Beginne), Lernwerte bleiben
  const d1 = mk([{ at: Date.parse('2026-11-03T22:40:00Z'), dt: m20, s: { 'Bolt|scooter': { [X]: 2 } } }]); d1.learn = { scooter: { km: 1.8, min: 8, days: 1 } };
  const d2 = FE.mergeEstCounts(d1, { ...FE.emptyEst(), e: { 'Bolt|scooter': { [Y]: 1 } } }, { day: '2026-11-04', at: Date.parse('2026-11-03T23:00:00Z'), dt: m20, band: 0 });
  assert(d2.day === '2026-11-04' && d2.tail.length === 1 && d2.runs.length === 1 && d2.learn.scooter.km === 1.8 && !Object.keys(d2.tail[0].e).length, 'Tageswechsel: Vortag als tail (Beginne), Lernwerte übernommen');
  assert(Object.keys(FE.estimateDay(d2, { Lmap: { scooter: 900 }, factor: 1, carry: true }).rows).length === 1, 'Fahrt über Mitternacht: Beginn aus dem Vortag, Ende heute');
}
{
  // Zeitmodell auf gezogenen Läufen: ≈ 35 % der Fahrten enden einen Lauf später (τ 8 Min.) – mit Übertrag näher an der bekannten Matrix
  const { raw, expected, meanKm } = synthDay({ tauMin: 8, perRun: 60 });
  const L = FE.calibrateL(raw, { targetKm: { scooter: meanKm }, tauMap: { scooter: 8 }, factor: 1, carry: true }).L;
  const c = FE.compareFlows(pairsOf(FE.estimateDay(raw, { Lmap: L, tauMap: { scooter: 8 }, factor: 1, carry: true }).rows), expected, { factor: 1, carry: true });
  const Ln = FE.calibrateL(raw, { targetKm: { scooter: meanKm }, factor: 1, carry: false }).L;
  const cn = FE.compareFlows(pairsOf(FE.estimateDay(raw, { Lmap: Ln, factor: 1, carry: false }).rows), expected, { factor: 1 });
  assert(c.cpc > cn.cpc && c.r > cn.r, `Fahrten über Laufgrenzen: mit Übertrag CPC ${c.cpc} / r ${c.r}, ohne ${cn.cpc} / ${cn.r} (gegen die bekannte Matrix)`);
}
// ---------- A10: keine Zeile aus einzelnen 1×1-Komponenten (≥ 5 beitragende Fahrtbeginne) ----------
{
  const t = Date.parse('2026-11-03T06:00:00Z'), m20 = 20 * 60e3, X = `${AGS}|${cellC(0, 0)}`, Y = `${AGS}|${cellC(0, 8)}`;
  const day = (k) => { let raw = null; for (let i = 0; i < k; i++) raw = FE.mergeEstCounts(raw, { ...FE.emptyEst(), s: { 'Bolt|scooter': { [X]: 1 } }, e: { 'Bolt|scooter': { [Y]: 1 } } }, { day: '2026-11-03', at: t + i * 3 * m20, dt: m20, band: 2 }); return raw; };
  const p3 = FE.publishEstimate(day(3), null, { reference: { fahrt: [] } }).doc, p6 = FE.publishEstimate(day(6), null, { reference: { fahrt: [] } }).doc;
  assert(p3.flows.length === 0 && p3.total.below === 3 && p6.flows.length === 1 && p6.flows[0][6] === 6 && p6.method.minSupport === 5, `drei einzelne Fahrten X→Y (je Lauf 1 Beginn, 1 Ende): keine Zeile (${p3.flows.length}, ${p3.total.below} unter Schwelle); sechs: eine Zeile mit ${p6.flows[0]?.[6]}`);
  const p0 = FE.publishEstimate(day(3), null, { reference: { fahrt: [] }, minSupport: 0 }).doc;
  assert(p0.flows.length === 1 && p0.flows[0][6] === 3, 'ohne Mindestzahl Beginne (minSupport 0): die drei Fahrten erschienen als Zeile (vorher)');
}
// ---------- trackRun liefert nur Zählungen: rotierend → s/e, stabil → vs/ve, Gruppen und Abholungen nicht ----------
{
  const V = (id, lat, lon, extra = {}) => ({ operator: 'Bolt', rawId: id, lat, lon, batteryPct: 50, disabled: false, reserved: false, type: 'scooter', ags: AGS, sourceId: 'bolt', ...extra });
  const Lm = (id, lat, lon, extra = {}) => V(id, lat, lon, { operator: 'Lime', sourceId: 'lime', ...extra });
  const recs = [{ id: 'bolt', status: 'live' }, { id: 'lime', status: 'live' }];
  const u0 = Date.parse('2026-11-03T08:00:00Z'), m20 = 20 * 60e3;
  const base = [...Array(30)].map((_, i) => V('b' + i, 48.40 + i * 0.003, 9.00));
  const lime = [Lm('l1', 48.50, 9.00), Lm('l2', 48.50, 9.02), Lm('l3', 48.50, 9.04)];
  let q = T.trackRun(null, { vehicles: [...base, ...lime, V('x', 48.45, 9.10), V('p', 48.46, 9.10, { batteryPct: 10 })], stations: [], sourceRecs: recs, now: u0 });
  q = T.trackRun(q.state, { vehicles: [...base, ...lime, V('x', 48.45, 9.10), V('p', 48.46, 9.10, { batteryPct: 10 })], stations: [], sourceRecs: recs, now: u0 + m20 });
  q.state.srcStats.lime = { runs: 10, present: 500, gone: 20, moved: 40, newc: 30, returned: 30 };
  q.state.srcStats.bolt = { runs: 10, present: 500, gone: 200, moved: 2, newc: 190, returned: 0 };
  // x verschwindet (Fahrtbeginn), p verschwindet mit Akku 10 (Abholung), y neu 1,2 km weiter (Fahrtende), 5 neue an einem Punkt (Ausbringen);
  // l1 2,2 km versetzt (gemessene Fahrt), l2 verschwindet (Beginn, stabil)
  const drop = [...Array(5)].map((_, i) => V('d' + i, 48.70 + i * 0.00005, 9.20, { batteryPct: 95 })); // tagsüber zählt eine Ausbringung nur aus vollen Fahrzeugen (Z7)
  const t2 = u0 + 2 * m20;
  q = T.trackRun(q.state, { vehicles: [...base, Lm('l1', 48.52, 9.00, { batteryPct: 46 }), lime[2], V('y', 48.461, 9.10), ...drop], stations: [], sourceRecs: recs, now: t2 });
  const e = q.est;
  assert(e.s['Bolt|scooter']?.[`${AGS}|${T.cellOf(48.45, 9.10)}`] === 1 && Object.values(e.s['Bolt|scooter']).reduce((a, b) => a + b, 0) === 1, 'rotierend: Fahrtbeginn x gezählt, Abholung p nicht');
  assert(e.e['Bolt|scooter']?.[`${AGS}|${T.cellOf(48.461, 9.10)}`] === 1 && Object.values(e.e['Bolt|scooter']).reduce((a, b) => a + b, 0) === 1, 'rotierend: Fahrtende y gezählt, Ausbringen (5 Fahrzeuge ≤ 40 m) nicht');
  assert(q.groups.some(g => g.kind === 'deploy' && g.n === 5) && !e.s['Lime|scooter'] && !e.e['Lime|scooter'], 'Gruppe erkannt; stabile Quelle nicht in s/e (nicht doppelt geschätzt)');
  assert(e.vs['Lime|scooter']?.[`${AGS}|${T.cellOf(48.50, 9.00)}`] === 1 && e.ve['Lime|scooter']?.[`${AGS}|${T.cellOf(48.52, 9.00)}`] === 1, 'stabil: gemessene Fahrt als Validierungszählung (Beginn/Ende getrennt)');
  // l2 kehrt 1,1 km weiter zurück: Beginn gehört in den Lauf des Verschwindens (vsLate)
  const t3 = t2 + m20;
  q = T.trackRun(q.state, { vehicles: [...base, Lm('l1', 48.52, 9.00, { batteryPct: 46 }), Lm('l2', 48.51, 9.02, { batteryPct: 44 }), lime[2], V('y', 48.461, 9.10), ...drop], stations: [], sourceRecs: recs, now: t3 });
  assert(q.est.vsLate.length === 1 && q.est.vsLate[0][2] === t2 && q.est.vsLate[0][1] === `${AGS}|${T.cellOf(48.50, 9.02)}` && q.est.ve['Lime|scooter'], 'stabiler Rückkehrer: Beginn mit Zeitpunkt des Verschwindens (vsLate)');
  const allKeys = keysDeep({ s: e.s, e: e.e, vs: e.vs, ve: e.ve });
  assert(allKeys.every(k => !k.includes('>')) && leaves({ s: e.s, e: e.e, vs: e.vs, ve: e.ve }).every(x => Number.isInteger(x)) && !JSON.stringify(e).includes(T.vehicleKey('Bolt', 'x')), 'Datenschutz: nur Zählungen je Zelle, keine Paare, keine Kennungen');
  assert(!JSON.stringify(q.state).includes('vsLate') && !('est' in q.state), 'Datenschutz: Verfolgungszustand enthält keine Schätz-Zählungen');
  // Tagessumme: vsLate landet im Lauf des Verschwindens
  let raw = FE.mergeEstCounts(null, { ...FE.emptyEst(), vs: { 'Lime|scooter': { [`${AGS}|1:1`]: 1 } } }, { day: '2026-11-03', at: t2, dt: m20, band: 2 });
  raw = FE.mergeEstCounts(raw, q.est, { day: '2026-11-03', at: t3, dt: m20, band: 2 });
  assert(raw.runs[0].vs['Lime|scooter'][`${AGS}|${T.cellOf(48.50, 9.02)}`] === 1 && raw.vLate.scooter === 1 && raw.lost === 0, 'mergeEstCounts: später Beginn im richtigen Lauf');
  assert(keysDeep(raw).every(k => !k.includes('>')), 'Datenschutz: private Tagessumme ohne Zellenpaare');
  const g = FE.mergeEstCounts(raw, q.est, { day: '2026-11-03', at: t3 + 3 * 3600e3, dt: 3 * 3600e3, gap: true, band: 4 });
  assert(g.runs.at(-1).gap === 1 && !Object.keys(g.runs.at(-1).s).length && !Object.keys(g.runs.at(-1).ve).length, 'Lücken-Lauf: keine Zählungen');
}
// ---------- Validierung an stabilen Kennungen, Nachführung, Veröffentlichung ----------
{
  const ref = JSON.parse(readFileSync(new URL('../data/reference.json', import.meta.url), 'utf8'));
  const tg = FE.targetsFromReference(ref);
  assert(Math.abs(tg.scooter.km - (1.54 + 2.4) / 2) < 0.01 && Math.abs(tg.scooter.min - (7.12 + 8.7) / 2) < 0.02 && tg.bike.km === 2.2, `Zielwerte aus reference.json: E-Scooter ${tg.scooter.km} km / ${tg.scooter.min} Min. (Berlin, Heilbronn), Räder Rückfallwert ${tg.bike.km} km`);
  // stabile Quelle (Lime): Zählungen als vs/ve, gemessene Ströme als flows-raw; rotierende Quelle (Bolt) als s/e
  const val = synthDay({ op: 'Lime', which: 'val', tauMin: 8, perRun: 20 });
  const rot = synthDay({ op: 'Bolt', perRun: 30, tauMin: 8 });
  const raw = val.raw; for (let k = 0; k < raw.runs.length; k++) { raw.runs[k].s = rot.raw.runs[k].s; raw.runs[k].e = rot.raw.runs[k].e; }
  raw.learn = {};
  const measured = { version: 1, day: '2026-11-03', runs: 60, rows: {}, stable: { [AGS]: ['Lime'] } };
  for (const [k, n] of val.truth) { const i = k.lastIndexOf('|'); const [ags, op, ty] = k.slice(0, i).split('|'); ((measured.rows[`${ags}|${op}|${ty}|2`] ??= {})[k.slice(i + 1)] = [n, n * 600e3, n * 1500]); }
  const v = FE.validateDay(raw, measured, { targetKm: { scooter: val.meanKm }, tauMap: { scooter: 8 } });
  assert(v && v.cpc > v.cpcBase && v.r > 0.3 && v.topRatio > 0.5 && v.grid.length === 2 && v.byType.scooter.measured > 200 && v.byType.scooter.w0 > 0.5 && v.byType.scooter.w0 < 0.75, `Validierung blind an stabiler Quelle: CPC ${v.cpc} (ohne Zerfall ${v.cpcBase}, mit Übertrag ${v.cpcCarry}), r ${v.r}, Top-50 ${v.topShare}/${v.topOracle}, Ø km ${v.meanKmEst}/${v.meanKmMeas}, w0 ${v.byType.scooter.w0}`);
  const learn = FE.updateLearn({}, v, { dtMs: 20 * 60e3, base: FE.paramsFor({}, ref) });
  assert(learn.scooter?.days === 1 && learn.scooter.km > 0 && Math.abs(learn.scooter.min - 8) < 2, `Nachführung: Zielwert ${learn.scooter.km} km, Dauer ${learn.scooter.min} Min. (wahr 8) aus der Validierung`);
  assert(FE.updateLearn({}, { byType: { scooter: { measured: 50, bestFactor: 1.25, w0: 0.6 } } }, {}).scooter === undefined, 'Nachführung erst ab 200 gemessenen Fahrten je Art');
  // A9: Zielwert = gemessene Luftlinie (nach Fahrten gewichtet, 7 Tage), keine Ratsche über bestFactor
  {
    const vd = (km, n, g = 0.8) => ({ byType: { scooter: { measured: n, bestFactor: g, w0: 0.6, meanKmMeas: km } } });
    let l = {}; for (let d = 1; d <= 10; d++) l = FE.updateLearn(l, vd(1.5, 1000), { day: `2026-11-${String(d).padStart(2, '0')}` });
    assert(l.scooter.km === 1.5 && l.scooter.kmDays.length === FE.LEARN_DAYS, `keine Ratsche: 10 Tage mit bestem Gitterfaktor 0,8 und Luftlinie 1,5 km → Ziel ${l.scooter.km} km (vorher 1,5 × 0,8^… ≈ ${(1.5 * Math.pow(0.8, 0.3 * 10)).toFixed(2)} km)`);
    const l2 = FE.updateLearn(FE.updateLearn({}, vd(1.4, 1000), { day: 'a' }), vd(1.7, 3000), { day: 'b' });
    const l3 = FE.updateLearn(l2, vd(1.7, 3000), { day: 'b' });
    assert(Math.abs(l2.scooter.km - 1.625) < 1e-9 && l3.scooter.kmDays.length === 2, `gewichtet nach Fahrten (1,4 km × 1000, 1,7 km × 3000 → ${l2.scooter.km}), derselbe Tag ersetzt statt doppelt`);
    const v1 = FE.validateDay(raw, measured, { targetKm: { scooter: FE.updateLearn({}, v, { day: 'x' }).scooter.km }, tauMap: { scooter: 8 } });
    assert(Math.abs(v1.byType.scooter.distDev) <= 0.05, `Abnahme A9: mit gelerntem Ziel ${v1.byType.scooter.targetKm} km weicht die geschätzte Luftlinie ${v1.byType.scooter.meanKmEst} km um ${(v1.byType.scooter.distDev * 100).toFixed(1)} % von der gemessenen ${v1.byType.scooter.meanKmMeas} km ab (≤ 5 %)`);
  }
  const { doc, learn: l2 } = FE.publishEstimate(raw, measured, { at: 1, reference: ref });
  assert(doc.estimated === true && doc.method.name === 'sinkhorn-gravity' && doc.method.factor === 2 && Math.abs(doc.cell[0] - 2 * T.CELL_LAT) < 1e-12 && doc.fields.join() === T.FLOW_FIELDS.join(), 'flows-est: estimated, Methode, Zellmaß 500 m, Felder wie flows/');
  assert(doc.flows.length > 0 && doc.flows.every(r => r[6] >= 2 && r[7] === null && Number.isInteger(r[8]) && r[3] !== 'Lime'), `nur Zeilen ≥ 2 erwartete Fahrten (${doc.flows.length}), dauer_s null, keine Zeile für die stabile Quelle`);
  const m = doc.munis[AGS];
  assert(Math.abs(m.trips - (m.shown + m.below + m.cut)) < 0.2 && !m.ops.Lime && m.ops.Bolt > 0 && doc.quality.cpc != null && doc.runtimeMs.total >= 0 && l2.scooter?.days === 1, `Gemeinde: trips = shown + below + cut (${m.trips} = ${m.shown} + ${m.below} + ${m.cut}), Güte und Laufzeit in der Datei`);
  const skipRaw = JSON.parse(JSON.stringify(raw)); for (const r of skipRaw.runs) { r.s = { 'Lime|scooter': r.vs['Lime|scooter'] || {} }; r.e = { 'Lime|scooter': r.ve['Lime|scooter'] || {} }; }
  const sk = FE.publishEstimate(skipRaw, measured, { reference: ref }).doc;
  assert(!sk.flows.length && sk.stableSkipped > 0 && !Object.keys(sk.munis).length, 'Anbieter mit stabilen Kennungen in der Gemeinde: nicht doppelt geschätzt');
  const empty = FE.publishEstimate({ version: 1, day: '2026-11-03', runs: [{ at: 1, dt: 1200e3, band: 0, gap: 0, s: { 'Bolt|scooter': { [`${AGS}|1:1`]: 3 } }, e: {}, vs: {}, ve: {} }], tail: [] }, null, { reference: ref }).doc;
  assert(!empty.flows.length && empty.total.trips === 0 && empty.quality === null, 'keine Fahrtenden: keine Ströme, keine Validierung ohne gemessene Ströme');
  const ix = FE.estIndex(['2026-11-03', 'x', '2026-11-02'], { collecting: '2026-11-04', at: 5, quality: doc.quality });
  assert(ix.estimated && ix.days.join() === '2026-11-02,2026-11-03' && ix.min === 2 && ix.collecting === '2026-11-04', 'flows-est/index.json');
}
// ---------- Laufzeit: 40 Städte × 3 Anbieter, ≈ 1 500 Fahrtbeginne je Lauf ----------
{
  let raw = null; const t0 = Date.parse('2026-11-03T06:00:00Z'), m20 = 20 * 60e3;
  const cities = [...Array(40)].map((_, i) => [Math.floor(rnd() * 3000) - 1500, Math.floor(rnd() * 3000) - 1500, 10 + Math.floor(rnd() * 40)]);
  for (let k = 0; k < 8; k++) {
    const s = {}, e = {};
    for (const [ca, cb, size] of cities) for (const op of ['Bolt', 'Voi', 'Dott']) for (let x = 0; x < size * 0.4; x++) {
      const c1 = `${A0 + ca + Math.floor(rnd() * size)}:${B0 + cb + Math.floor(rnd() * size)}`, c2 = `${A0 + ca + Math.floor(rnd() * size)}:${B0 + cb + Math.floor(rnd() * size)}`;
      const ss = (s[`${op}|scooter`] ??= {}), ee = (e[`${op}|scooter`] ??= {}); ss[`A${ca}|${c1}`] = (ss[`A${ca}|${c1}`] || 0) + 1; ee[`A${ca}|${c2}`] = (ee[`A${ca}|${c2}`] || 0) + 1;
    }
    raw = FE.mergeEstCounts(raw, { ...FE.emptyEst(), s, e }, { day: '2026-11-03', at: t0 + k * m20, dt: k ? m20 : null, gap: k === 0, band: 1 });
  }
  const starts = Object.values(raw.runs[3].s).reduce((a, m) => a + Object.values(m).reduce((x, y) => x + y, 0), 0);
  const r = FE.estimateDay(raw, { Lmap: { scooter: 950 } });
  const per = r.stats.ms / r.stats.runs;
  assert(per < 3000 && r.stats.trips > 0, `Laufzeit: ${per.toFixed(0)} ms je Lauf bei ${starts} Fahrtbeginnen (${r.stats.solves} Lösungen, ${r.stats.cand} Kandidatenpaare)`);
}

// Familien E-Roller und Carsharing (08.11.2026): eigene Zielwerte, nicht die der E-Scooter
{
  const p = FE.paramsFor(null, null);
  assert(p.targetKm.car === FE.TYPE_FALLBACK.car.km && p.tauMap.car === FE.TYPE_FALLBACK.car.min && p.targetKm.moped === FE.TYPE_FALLBACK.moped.km && p.targetKm.scooter === FE.TYPE_FALLBACK.scooter.km && FE.FLOW_FAMILIES.join() === 'scooter,bike,moped,car',
    'paramsFor: Zielwert und Dauer je Familie (Auto 6 km/180 Min., E-Roller 3,5 km/18 Min.)');
}
