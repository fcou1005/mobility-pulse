// Mobility Pulse – S8.2 Versorgungsgerechtigkeit (F13): Steht für die Einwohner ein Sharing-Fahrzeug in der Nähe?
// Je Lauf und Gemeinde: für jeden bewohnten 100-m-Mittelpunkt (Zensus 2022) der Abstand zum nächsten verfügbaren Fahrzeug (ohne Autos),
// gerechnet auf den privaten Positionen (nicht auf den 250-m-Zellen: Maße unter 250 m lassen sich aus Zellen nicht rechnen).
// Kennzahlen je Tag: Einwohneranteil mit Fahrzeug in 150/200/300 m (Mittel der Läufe 7–22 Uhr und je Tageszeit-Band), Einwohneranteil mit
// Fahrzeug in mindestens 50 % der Läufe 7–22 Uhr, Gini der Fahrzeuge je Einwohner über 1-km-Zellen, Zellwerte je 250-m-Zelle.
// Prüfung „jeder dritte Lauf“: dieselben Kennzahlen nur aus Läufen mit Laufnummer ≡ 0 (mod 3); veröffentlicht wird die Abweichung in Punkten.
import { BANDS, bandOf } from './pulse-track-rules.js';
import { G1K, cellOfGrid } from './pulse-geo-proj.js';

export const COVER = Object.freeze({ radii: [150, 200, 300], dayFrom: 7, dayTo: 22, minVehicles: 20, sub: 3, gridM: 100, types: ['scooter', 'bike', 'ebike', 'cargo', 'moped', 'other', 'unknown'] });
const NR = COVER.radii.length, M_LAT = 111320;

/** Vorbereitung je Gemeinde aus den Zensus-Punkten [[lat, lon, ew]] und den 250-m-Zellen [[Zelle, Einwohner]] */
export function prepareAgs(pts, cellOf) {
  const n = pts.length, lat = new Float64Array(n), lon = new Float64Array(n), ew = new Float64Array(n), cellIx = new Int32Array(n), k1Ix = new Int32Array(n);
  const cells = new Map(), k1 = new Map(); let pop = 0;
  for (let i = 0; i < n; i++) {
    lat[i] = pts[i][0]; lon[i] = pts[i][1]; ew[i] = pts[i][2]; pop += ew[i];
    const c = cellOf(lat[i], lon[i]); let ci = cells.get(c); if (ci == null) cells.set(c, ci = cells.size); cellIx[i] = ci;
    const k = cellOfGrid(G1K, lat[i], lon[i]); let ki = k1.get(k); if (ki == null) k1.set(k, ki = k1.size); k1Ix[i] = ki;
  }
  const cellPop = new Float64Array(cells.size); for (let i = 0; i < n; i++) cellPop[cellIx[i]] += ew[i];
  const k1Pop = new Float64Array(k1.size); for (let i = 0; i < n; i++) k1Pop[k1Ix[i]] += ew[i];
  return { n, lat, lon, ew, pop, cellIx, k1Ix, cells: [...cells.keys()], cellPop, k1: [...k1.keys()], k1Map: k1, k1Pop, mLon: M_LAT * Math.cos((n ? lat[0] : 50) * Math.PI / 180) };
}

/** leerer Tageszähler */
export function emptyAcc(prep, day) {
  const z = (k) => Array.from({ length: k }, () => new Array(NR).fill(0));
  return { day, runs: 0, runsDay: 0, runsDay3: 0, sum: z(BANDS.length), nBand: new Array(BANDS.length).fill(0), sum3: z(BANDS.length), nBand3: new Array(BANDS.length).fill(0),
    pt: Array.from({ length: NR }, () => new Uint16Array(prep.n)), pt3: Array.from({ length: NR }, () => new Uint16Array(prep.n)),
    cellCov: Array.from({ length: NR }, () => new Float64Array(prep.cells.length)), k1veh: new Float64Array(prep.k1.length), vehMean: 0 };
}

/**
 * ein Lauf: vehicles [[lat, lon]] (verfügbar, ohne Autos), hour (Ortsstunde), runIdx (fortlaufende Laufnummer). Verändert acc.
 * Rückgabe: Einwohneranteile je Radius in diesem Lauf
 */
export function coverRun(prep, acc, vehicles, { hour, runIdx }) {
  const g = COVER.gridM, dLat = g / M_LAT, dLon = g / prep.mLon, rMax = COVER.radii[NR - 1], reach = Math.ceil(rMax / g), r0sq = COVER.radii[0] ** 2;
  const grid = new Map(), key = (a, b) => a * 1048576 + b;
  for (const v of vehicles) { const k = key(Math.floor(v[0] / dLat), Math.floor(v[1] / dLon)); let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(v); }
  const band = bandOf(hour), day = hour >= COVER.dayFrom && hour < COVER.dayTo, sub = runIdx % COVER.sub === 0, cov = new Array(NR).fill(0);
  acc.runs++; if (day) { acc.runsDay++; if (sub) acc.runsDay3++; }
  for (let i = 0; i < prep.n; i++) {
    const la = prep.lat[i], lo = prep.lon[i], gi = Math.floor(la / dLat), gj = Math.floor(lo / dLon); let best = Infinity;
    for (let a = gi - reach; a <= gi + reach && best > r0sq; a++) for (let b = gj - reach; b <= gj + reach; b++) {
      const l = grid.get(key(a, b)); if (!l) continue;
      for (const v of l) { const dy = (v[0] - la) * M_LAT, dx = (v[1] - lo) * prep.mLon, d = dy * dy + dx * dx; if (d < best) best = d; }
    }
    best = Math.sqrt(best);
    for (let r = 0; r < NR; r++) if (best <= COVER.radii[r]) {
      cov[r] += prep.ew[i];
      if (day) { acc.pt[r][i]++; acc.cellCov[r][prep.cellIx[i]] += prep.ew[i]; if (sub) acc.pt3[r][i]++; }
    }
  }
  const share = cov.map(c => (prep.pop > 0 ? c / prep.pop : 0));
  for (let r = 0; r < NR; r++) { acc.sum[band][r] += share[r]; if (sub) acc.sum3[band][r] += share[r]; }
  acc.nBand[band]++; if (sub) acc.nBand3[band]++;
  if (day) { for (const v of vehicles) { const ki = prep.k1Map.get(cellOfGrid(G1K, v[0], v[1])); if (ki != null) acc.k1veh[ki]++; } acc.vehMean += vehicles.length; }
  return share;
}

/** Gini der Fahrzeuge je Einwohner über Zellen (Lorenzkurve, Zellen nach Fahrzeugen je Einwohner aufsteigend; 0 = gleich verteilt) */
export function gini(pop, veh) {
  const rows = []; let P = 0, V = 0;
  for (let i = 0; i < pop.length; i++) if (pop[i] > 0) { rows.push([pop[i], veh[i] || 0]); P += pop[i]; V += veh[i] || 0; }
  if (!(P > 0) || !(V > 0)) return null;
  rows.sort((a, b) => a[1] / a[0] - b[1] / b[0]);
  let x = 0, y = 0, area = 0;
  for (const [p, v] of rows) { const x1 = x + p / P, y1 = y + v / V; area += (x1 - x) * (y1 + y); x = x1; y = y1; }
  return 1 - area;
}

/** Tagesergebnis (nur Zählwerte und Anteile): Einwohneranteile 7–22 Uhr, je Band, mindestens 50 % der Zeit, Gini, „jeder dritte Lauf“ */
export function finalizeDay(prep, acc) {
  const dayBands = BANDS.filter(b => b.to > COVER.dayFrom && b.from < COVER.dayTo).map(b => b.id);
  const avg = (sum, n, r) => { let s = 0, k = 0; for (const b of dayBands) { s += sum[b][r]; k += n[b]; } return k ? s / k : null; };
  const time50 = (pt, runs, r) => { if (!runs) return null; let c = 0; for (let i = 0; i < prep.n; i++) if (pt[r][i] * 2 >= runs) c += prep.ew[i]; return prep.pop ? c / prep.pop : null; };
  const R = COVER.radii.map((_, r) => r), pp = (a, b) => (a == null || b == null ? null : Math.abs(a - b) * 100);
  const share = R.map(r => avg(acc.sum, acc.nBand, r)), share3 = R.map(r => avg(acc.sum3, acc.nBand3, r));
  const t50 = R.map(r => time50(acc.pt, acc.runsDay, r)), t503 = R.map(r => time50(acc.pt3, acc.runsDay3, r));
  const diff = Math.max(...R.flatMap(r => [pp(share[r], share3[r]), pp(t50[r], t503[r])]).filter(x => x != null), 0);
  const band = BANDS.map(b => (acc.nBand[b.id] ? R.map(r => acc.sum[b.id][r] / acc.nBand[b.id]) : null));
  const cells = prep.cells.map((c, i) => [c, Math.round(prep.cellPop[i]), ...R.map(r => (acc.runsDay && prep.cellPop[i] > 0 ? Math.round((acc.cellCov[r][i] / acc.runsDay / prep.cellPop[i]) * 1000) / 1000 : null))]);
  return { day: acc.day, runs: acc.runs, runsDay: acc.runsDay, runsDay3: acc.runsDay3, pop: Math.round(prep.pop), share, time50: t50, band, gini: gini(prep.k1Pop, acc.k1veh), vehicles: acc.runsDay ? acc.vehMean / acc.runsDay : null, sub: { share: share3, time50: t503 }, diffPP: diff, cells };
}

// ---------- Letzte Meile: Einwohner fern vom ÖPNV und ihr Sharing-Angebot ----------
// „Fern“ = weiter als stopM (Luftlinie) von jeder Haltestelle mit mindestens minDep Abfahrten am Stichtag. Für diese Einwohner zählt, in welchem
// Anteil der Läufe zwischen 7 und 22 Uhr ein verfügbares Sharing-Fahrzeug in 200 m stand (dieselben Zählfelder wie die Versorgung).
export const LASTMILE = Object.freeze({ stopM: 400, vehIx: 1, minDep: 20, top: 40 });
/** Maske je Zensus-Punkt: 1 = fern vom ÖPNV. bundles: [[lat, lon, Abfahrten]] (gtfs/<Land>.json) */
export function farMask(prep, bundles, L = LASTMILE) {
  const g = L.stopM, dLat = g / M_LAT, dLon = g / prep.mLon, r2 = L.stopM ** 2, grid = new Map(), key = (a, b) => a * 1048576 + b, far = new Uint8Array(prep.n);
  for (const b of bundles || []) { if (!(b[2] >= L.minDep)) continue; const k = key(Math.floor(b[0] / dLat), Math.floor(b[1] / dLon)); let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(b); }
  for (let i = 0; i < prep.n; i++) {
    const la = prep.lat[i], lo = prep.lon[i], gi = Math.floor(la / dLat), gj = Math.floor(lo / dLon); let near = false;
    for (let a = gi - 1; a <= gi + 1 && !near; a++) for (let b = gj - 1; b <= gj + 1 && !near; b++) { const l = grid.get(key(a, b)); if (!l) continue; for (const s of l) { const dy = (s[0] - la) * M_LAT, dx = (s[1] - lo) * prep.mLon; if (dy * dy + dx * dx <= r2) { near = true; break; } } }
    far[i] = near ? 0 : 1;
  }
  return far;
}
/**
 * Tageswert: Einwohner fern vom ÖPNV, Anteil davon mit Fahrzeug in 200 m (Mittel über die Läufe 7–22 Uhr), Einwohner ohne beides, dazu die
 * 250-m-Zellen mit den meisten unversorgten Einwohnern: [Zelle, Einwohner fern, Anteil mit Fahrzeug].
 */
export function lastMile(prep, acc, far, L = LASTMILE) {
  const runs = acc.runsDay, pt = acc.pt[L.vehIx], cf = new Float64Array(prep.cells.length), cs = new Float64Array(prep.cells.length); let farPop = 0, served = 0;
  for (let i = 0; i < prep.n; i++) { if (!far[i]) continue; const e = prep.ew[i], s = runs ? e * pt[i] / runs : 0; farPop += e; served += s; cf[prep.cellIx[i]] += e; cs[prep.cellIx[i]] += s; }
  const r3 = (x) => Math.round(x * 1000) / 1000, cells = [];
  for (let c = 0; c < cf.length; c++) if (cf[c] >= 1) cells.push([prep.cells[c], Math.round(cf[c]), runs ? r3(cs[c] / cf[c]) : null]);
  cells.sort((a, b) => b[1] * (1 - (b[2] ?? 0)) - a[1] * (1 - (a[2] ?? 0)) || (a[0] < b[0] ? -1 : 1));
  return { day: acc.day, stopM: L.stopM, vehM: COVER.radii[L.vehIx], minDep: L.minDep, runs, pop: Math.round(prep.pop), farPop: Math.round(farPop), farShare: prep.pop > 0 ? r3(farPop / prep.pop) : null,
    servedShare: runs && farPop > 0 ? r3(served / farPop) : null, gapPop: runs ? Math.round(farPop - served) : null, cells: { fields: ['zelle', 'einwohner_fern', 'anteil_mit_fahrzeug'], rows: cells.slice(0, L.top) } };
}

// ---------- Zustand (privat): Zählfelder als Base64 ----------
const b64 = (ta) => Buffer.from(ta.buffer, ta.byteOffset, ta.byteLength).toString('base64');
const unb = (s, T) => { const b = Buffer.from(s, 'base64'); return new T(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
export const accToJson = (a) => ({ ...a, pt: a.pt.map(b64), pt3: a.pt3.map(b64), cellCov: a.cellCov.map(b64), k1veh: b64(a.k1veh) });
export function accFromJson(j, prep) {
  if (!j || j.pt?.length !== NR) return null;
  const a = { ...j, pt: j.pt.map(s => unb(s, Uint16Array)), pt3: j.pt3.map(s => unb(s, Uint16Array)), cellCov: j.cellCov.map(s => unb(s, Float64Array)), k1veh: unb(j.k1veh, Float64Array) };
  return a.pt[0].length === prep.n && a.cellCov[0].length === prep.cells.length && a.k1veh.length === prep.k1.length ? a : null;
}

/** Anbieter mit Genehmigung (data/reference.json → obergrenzen[].anbieter) ohne offenen Feed in der Gemeinde: Versorgung dort unterschätzt */
export function missingOperators(refCaps, ags, seenOps) {
  const seen = [...(seenOps || [])].map(s => String(s).toLowerCase());
  const lic = new Set((refCaps || []).filter(c => c.ags === ags).flatMap(c => c.anbieter || []));
  const n = Math.max(0, ...(refCaps || []).filter(c => c.ags === ags).map(c => c.anbieterZahl || 0));
  const missing = [...lic].filter(o => { const k = String(o).toLowerCase().replace(/\s*\(.*\)\s*/g, ' ').trim(); return !seen.some(s => s.includes(k) || k.includes(s)); });
  return { licensed: [...lic], missing, countGap: n > 0 ? Math.max(0, n - seen.length) : null };
}
