// @ts-check
// Mobility Pulse — geschätzte Start-Ziel-Ströme für Anbieter mit rotierenden Kennungen (Voi, Bolt, Dott …).
// Reine Funktionen, keine Abhängigkeiten außer pulse-track.js.
//
// Datenschutz (verbindlich): Fahrzeuge werden über die Kennungsrotation hinweg NICHT verknüpft – kein Fingerabdruck über Reichweite,
// Ladestand o. Ä., keine Einzelfahrten, keine Paare „verschwunden ↔ aufgetaucht“ (vgl. Das & Nicklas, PoPETs 2026). Gespeichert werden
// je Lauf nur Zählungen je Zelle (Fahrtbeginne, Fahrtenden), privat im TRACK_DIR. Die Schätzung läuft erst nach Tagesende im Speicher
// und liefert gebrochene Erwartungswerte je Zellenpaar; veröffentlicht werden nur Tagessummen ≥ 2 (wie bei den gemessenen Strömen).
//
// Methode: je Lauf, Anbieter und Fahrzeugart werden die Fahrtbeginne (Quellen) und Fahrtenden (Senken) durch entropieregularisierten
// optimalen Transport gekoppelt (Sinkhorn-Skalierung = doppelt beschränktes Gravitationsmodell, Distanzzerfall exp(−d/L)). Paare in
// derselben Zelle, unter 150 m oder über 24 km/h × möglicher Fahrtdauer sind ausgeschlossen. Gekoppelt wird innerhalb eines Laufs
// (seit 13.11.2026, A9: der Übertrag über die Laufgrenze – Anteile w0, w1, w2 nach Fahrtdauer τ – brachte an stabilen Kennungen an 11 von
// 12 Tagen keine bessere Überdeckung, CPC 0,000–0,009 schlechter; er bleibt als Option carry: true und wird in der Validierung mitgemessen). Je
// Zusammenhangskomponente wird min(Σ Beginne, Σ Enden) verteilt; der Rest (Ausbringung, Zu-/Abfluss über das Gebiet) bleibt unverteilt.
// L wird je Fahrzeugart nach Hyman so eingestellt, dass die mittlere geschätzte Luftlinie der belegten Fahrtlänge entspricht
// (data/reference.json → fahrt bzw. die gemessene Luftlinie stabiler Kennungen der letzten 7 Tage, siehe updateLearn). Validierung: dieselbe Schätzung blind auf den
// Zählungen der Quellen mit stabilen Kennungen, verglichen mit deren gemessenen Strömen (Common Part of Commuters, Top-50, Korrelation).
import { CELL_LAT, CELL_LON, publishFlows, FLOW_TOP, FLOW_FIELDS } from './pulse-track.js';

export const EST_VERSION = 1;
export const EST_METHOD = 'sinkhorn-gravity';
export const EST_DEFAULTS = Object.freeze({
  factor: 2,          // Zellen vergröbern: 2 = ≈ 500 m (bei 250 m erreicht kaum ein Paar 2 erwartete Fahrten am Tag), 1 = wie flows/
  vmaxKmh: 24,        // Plausibilität wie bei den gemessenen Strömen (Xu et al. 2020)
  dminM: 150,         // kürzeste Fahrt (wie MOVE_M), dazu: gleiche Zelle ausgeschlossen
  maxLag: 2,          // Fahrtbeginne gehen in die Enden von bis zu 2 Folgeläufen ein
  phi: 0.95,          // Sinkhorn-Exponent < 1: KL-gelockerte Ränder, konvergiert auch bei unzulässigem Träger
  iters: 300, tol: 1e-4,
  prune: 1e-3,        // Paare mit kleinerem Erwartungswert je Lauf entfallen (Masse geht an die übrigen Paare der Quelle)
  kL: 6,              // Kandidatenpaare höchstens max(6·L, 5 km) entfernt (Kern dort < e^−6)
  maxPairs: Infinity, // optional: je Quelle nur die nächsten K Senken (Top-K-Nachbarn)
  hymanEvals: 6, hymanTol: 0.02, Lmin: 100, Lmax: 20000,
  minLearn: 200,      // so viele gemessene Fahrten je Art braucht ein Tag, um Zielwert/Fahrtdauer nachzuführen
  learnRate: 0.3,     // gleitendes Mittel (log) für nachgeführte Parameter
  grid: [0.8, 1.25],  // Validierung: Zielwert × Faktor
});
// Rückfallwerte je Art (km Luftlinie, Min.); E-Scooter aus data/reference.json (targetsFromReference), Räder: eigene Messung stabiler
// Kennungen (DB Connect, 31.10./01.11.2026 ≈ 2,2 km) bzw. Annahme 15 Min. – beides wird an stabilen Quellen nachgeführt.
// E-Roller und Autos (seit 08.11.2026) als eigene Familien mit Annahmen (Luftlinie, Min.), nachgeführt wie die übrigen
export const TYPE_FALLBACK = Object.freeze({ scooter: { km: 1.97, min: 7.9 }, bike: { km: 2.2, min: 15 }, moped: { km: 3.5, min: 18 }, car: { km: 6, min: 180 } });
export const FLOW_FAMILIES = ['scooter', 'bike', 'moped', 'car'];
const BIKE_LIKE = new Set(['bike', 'ebike', 'cargo']);
const famOf = (ty) => (BIKE_LIKE.has(ty) ? 'bike' : ty === 'moped' || ty === 'car' ? ty : 'scooter');

/** Zielwerte je Fahrzeugfamilie aus reference.json → fahrt: Mittel der Städte (Stadt = Mittel ihrer Zeiträume), km und Min. */
export function targetsFromReference(ref) {
  const out = { scooter: { ...TYPE_FALLBACK.scooter, src: 'Rückfallwert' }, bike: { ...TYPE_FALLBACK.bike, src: 'Rückfallwert (eigene Messung stabiler Kennungen)' },
    moped: { ...TYPE_FALLBACK.moped, src: 'Annahme (E-Roller)' }, car: { ...TYPE_FALLBACK.car, src: 'Annahme (Carsharing)' } };
  for (const fam of ['scooter', 'bike']) {
    const by = new Map();
    for (const e of ref?.fahrt || []) {
      if (famOf(e.type) !== fam || (fam === 'scooter' && e.type !== 'scooter')) continue;
      const a = by.get(e.ags) || { km: [], min: [], ort: e.ort }; if (Number.isFinite(e.kmMittel)) a.km.push(e.kmMittel); if (Number.isFinite(e.minMittel)) a.min.push(e.minMittel); by.set(e.ags, a);
    }
    const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const km = [...by.values()].filter(a => a.km.length).map(a => mean(a.km)), mn = [...by.values()].filter(a => a.min.length).map(a => mean(a.min));
    if (km.length) out[fam] = { km: +mean(km).toFixed(3), min: mn.length ? +mean(mn).toFixed(2) : out[fam].min, src: `reference.json fahrt (${[...by.values()].map(a => a.ort.split(' (')[0]).join(', ')})` };
  }
  return out;
}

// ---------- Zellen und Distanzen ----------
const R = 6371000, RAD = Math.PI / 180;
const coarse = (cell, f) => { if (f === 1) return cell; const [a, b] = cell.split(':').map(Number); return `${Math.round(a / f)}:${Math.round(b / f)}`; };
const centerOf = (cell, f) => { const [a, b] = cell.split(':').map(Number); return [a * CELL_LAT * f, b * CELL_LON * f]; };
const distM = (la1, lo1, la2, lo2) => { const x = (lo2 - lo1) * RAD * Math.cos((la1 + la2) * RAD / 2), y = (la2 - la1) * RAD; return R * Math.sqrt(x * x + y * y); };
const splitOpTy = (k) => { const i = k.lastIndexOf('|'); return [k.slice(0, i), k.slice(i + 1)]; };
const splitNode = (k) => { const i = k.indexOf('|'); return [k.slice(0, i), k.slice(i + 1)]; };

/** Anteile w[m]: Fahrt beginnt gleichverteilt im Intervall (Länge dt) und endet m Läufe später; Dauer exponentiell mit Mittel tauMs. */
export function lagWeights(dtMs, tauMs, maxLag = 2) {
  if (!(dtMs > 0)) return [1];
  const x = dtMs / Math.max(1, tauMs), q = (1 - Math.exp(-x)) / x;
  const w = [1 - q]; for (let m = 1; m <= maxLag; m++) w.push(q * (1 - Math.exp(-x)) * Math.exp(-(m - 1) * x));
  const s = w.reduce((a, b) => a + b, 0); return w.map(v => v / s);
}
/** Umkehrung von w0: mittlere Dauer τ aus dem Anteil der Fahrten, die im selben Intervall enden (Bisektion) */
export function tauFromW0(w0, dtMs) {
  if (!(w0 > 0 && w0 < 1) || !(dtMs > 0)) return null;
  const f = (tau) => { const x = dtMs / tau; return 1 - (1 - Math.exp(-x)) / x; }; // fällt mit τ
  let lo = dtMs / 1000, hi = dtMs * 1000;
  for (let i = 0; i < 80; i++) { const mid = Math.sqrt(lo * hi); if (f(mid) > w0) lo = mid; else hi = mid; }
  return Math.sqrt(lo * hi);
}

/**
 * Kern: ein Lauf, ein Anbieter, eine Fahrzeugart. src: [{cell, lat, lon, m, dmax}], snk: [{cell, lat, lon, m}].
 * Rückgabe: Paare [i, j, T, d] (T = erwartete Fahrten, d = Luftlinie Zellmitte–Zellmitte in m) und Kennzahlen.
 */
let BUF = null; // wiederverwendete Puffer (Kandidatenpaare), wachsen bei Bedarf
const buf = (n) => { if (!BUF || BUF.n < n) { const m = Math.max(n, (BUF?.n || 0) * 2, 1 << 16); BUF = { n: m, I: new Int32Array(m), J: new Int32Array(m), K: new Float64Array(m), D: new Float32Array(m), T: new Float64Array(m) }; } return BUF; };
export function solveRun(src, snk, { L = 1000, dminM = EST_DEFAULTS.dminM, phi = EST_DEFAULTS.phi, iters = EST_DEFAULTS.iters, tol = EST_DEFAULTS.tol, prune = EST_DEFAULTS.prune, maxPairs = EST_DEFAULTS.maxPairs, kL = EST_DEFAULTS.kL } = {}) {
  const nS = src.length, nE = snk.length;
  if (!nS || !nE) return { pairs: [], matched: 0, iters: 0, P: 0 };
  // Reichweite je Quelle: vmax × mögliche Dauer, zusätzlich höchstens kL·L (dahinter trägt der Kern < e^−kL bei)
  const rcut = Number.isFinite(L) ? Math.max(kL * L, 5000) : Infinity;
  const rOf = (s) => Math.min(s.dmax, rcut);
  // Senken in ein Gitter (Kantenlänge = größte Reichweite), Kandidatenpaare je Quelle aus den 3×3 Nachbarfeldern
  const dmaxAll = src.reduce((a, s) => Math.max(a, rOf(s)), 0);
  const gLat = Math.max(dmaxAll, 1) / (R * RAD), lat0 = snk[0].lat, gLon = gLat / Math.max(0.2, Math.cos(lat0 * RAD));
  const grid = new Map(); const gk = (a, b) => a * 100003 + b;
  snk.forEach((e, j) => { const k = gk(Math.floor(e.lat / gLat), Math.floor(e.lon / gLon)); let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(j); });
  const inv = Number.isFinite(L) ? 1 / L : 0;
  let P = 0, B = buf(1 << 16);
  for (let i = 0; i < nS; i++) {
    const s = src[i], r = rOf(s); const ga = Math.floor(s.lat / gLat), gb = Math.floor(s.lon / gLon); const p0 = P;
    for (let da = -1; da <= 1; da++) for (let db = -1; db <= 1; db++) for (const j of grid.get(gk(ga + da, gb + db)) || []) {
      const e = snk[j]; if (e.cell === s.cell) continue;
      const d = distM(s.lat, s.lon, e.lat, e.lon); if (d < dminM || d > r) continue;
      if (P >= B.n) { const old = B; B = buf(P + 1); if (B !== old) { B.I.set(old.I.subarray(0, P)); B.J.set(old.J.subarray(0, P)); B.K.set(old.K.subarray(0, P)); B.D.set(old.D.subarray(0, P)); } }
      B.I[P] = i; B.J[P] = j; B.K[P] = Math.exp(-d * inv); B.D[P] = d; P++;
    }
    if (P - p0 > maxPairs) { // Top-K-Nachbarn: nur die nächsten maxPairs Senken dieser Quelle
      const idx = []; for (let p = p0; p < P; p++) idx.push(p); idx.sort((x, y) => B.D[x] - B.D[y]); const keep = idx.slice(0, maxPairs).sort((x, y) => x - y);
      const tmp = keep.map(p => [B.J[p], B.K[p], B.D[p]]); P = p0; for (const [j, k, d] of tmp) { B.I[P] = i; B.J[P] = j; B.K[P] = k; B.D[P] = d; P++; }
    }
  }
  if (!P) return { pairs: [], matched: 0, iters: 0, P: 0 };
  const I = B.I, J = B.J, K = B.K, D = B.D;
  // Zusammenhangskomponenten (Union-Find über Quellen und Senken); je Komponente M = min(Σ Beginne, Σ Enden)
  const par = new Int32Array(nS + nE).map((_, k) => k);
  const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  for (let p = 0; p < P; p++) { const a = find(I[p]), b = find(nS + J[p]); if (a !== b) par[a] = b; }
  const hasS = new Uint8Array(nS), hasE = new Uint8Array(nE); for (let p = 0; p < P; p++) { hasS[I[p]] = 1; hasE[J[p]] = 1; }
  const SA = new Map(), SB = new Map();
  for (let i = 0; i < nS; i++) if (hasS[i]) { const c = find(i); SA.set(c, (SA.get(c) || 0) + src[i].m); }
  for (let j = 0; j < nE; j++) if (hasE[j]) { const c = find(nS + j); SB.set(c, (SB.get(c) || 0) + snk[j].m); }
  const Mc = new Map(); for (const [c, a] of SA) Mc.set(c, Math.min(a, SB.get(c) || 0));
  const a = new Float64Array(nS), b = new Float64Array(nE);
  for (let i = 0; i < nS; i++) if (hasS[i]) { const c = find(i); a[i] = src[i].m * Mc.get(c) / SA.get(c); }
  for (let j = 0; j < nE; j++) if (hasE[j]) { const c = find(nS + j); b[j] = snk[j].m * Mc.get(c) / SB.get(c); }
  // Sinkhorn-Skalierung (u, v); phi < 1 = gelockerte Ränder, danach je Komponente auf M zurückskaliert
  const u = new Float64Array(nS).fill(1), v = new Float64Array(nE).fill(1), Kv = new Float64Array(nS), Ku = new Float64Array(nE);
  let it = 0;
  for (; it < iters; it++) {
    Kv.fill(0); for (let p = 0; p < P; p++) Kv[I[p]] += K[p] * v[J[p]];
    let ch = 0;
    for (let i = 0; i < nS; i++) { const nu = Kv[i] > 0 ? (a[i] / Kv[i]) ** phi : 0; if (u[i] > 0) ch = Math.max(ch, Math.abs(nu / u[i] - 1)); u[i] = nu; }
    Ku.fill(0); for (let p = 0; p < P; p++) Ku[J[p]] += K[p] * u[I[p]];
    for (let j = 0; j < nE; j++) v[j] = Ku[j] > 0 ? (b[j] / Ku[j]) ** phi : 0;
    if (ch < tol && it > 2) break;
  }
  const T = B.T, sumC = new Map();
  for (let p = 0; p < P; p++) { T[p] = u[I[p]] * K[p] * v[J[p]]; const c = find(I[p]); sumC.set(c, (sumC.get(c) || 0) + T[p]); }
  for (let p = 0; p < P; p++) { const c = find(I[p]), s = sumC.get(c); T[p] = s > 0 ? T[p] * Mc.get(c) / s : 0; }
  // kleine Erwartungswerte entfallen; ihre Masse geht anteilig an die übrigen Paare derselben Quelle (Zeilensumme bleibt)
  const row = new Float64Array(nS), kept = new Float64Array(nS);
  for (let p = 0; p < P; p++) { row[I[p]] += T[p]; if (T[p] >= prune) kept[I[p]] += T[p]; }
  const pairs = []; let matched = 0, lost = 0;
  for (let p = 0; p < P; p++) { const i = I[p]; if (T[p] < prune) { if (!(kept[i] > 0)) lost += T[p]; continue; } const t = T[p] * row[i] / kept[i]; pairs.push([i, J[p], t, D[p]]); matched += t; }
  return { pairs, matched, lost, iters: it + 1, P };
}

// ---------- Tagessumme der Zählungen (privat, TRACK_DIR) ----------
// raw = { version, day, runs: [{ at, dt, band, gap, s, e, vs, ve }], tail: [letzte 2 Läufe des Vortags], learn: {...}, vSame, vLate, lost }
// s/e: Fahrtbeginne/-enden rotierender (und noch unbestimmter) Quellen, vs/ve: dasselbe für stabile Kennungen (Validierung),
// je { 'Anbieter|Art': { 'Gemeinde|Zelle': Anzahl } }. Keine Paare, keine Kennungen.
const addTo = (obj, k1, k2, n = 1) => { const o = (obj[k1] ??= {}); o[k2] = (o[k2] || 0) + n; };
export function emptyEst() { return { s: {}, e: {}, vs: {}, ve: {}, vsLate: [] }; }
export function mergeEstCounts(raw, est, { day = undefined, at = undefined, dt = null, gap = false, band = 0 } = {}) {
  let doc = raw && raw.version === EST_VERSION && raw.day === day ? raw : null;
  if (!doc) {
    const prev = raw && raw.version === EST_VERSION && raw.day < day ? raw : null;
    const tail = prev ? [...(prev.tail || []), ...(prev.runs || [])].slice(-EST_DEFAULTS.maxLag).map(r => ({ at: r.at, dt: r.dt, gap: r.gap, band: r.band, s: r.s, vs: r.vs, e: {}, ve: {} })) : [];
    doc = { version: EST_VERSION, day, runs: [], tail, learn: raw?.learn || {}, vSame: {}, vLate: {}, lost: 0 };
  }
  const g = !!gap || !est;
  const run = { at, dt, band, gap: g ? 1 : 0, s: g ? {} : est.s || {}, e: g ? {} : est.e || {}, vs: g ? {} : est.vs || {}, ve: g ? {} : est.ve || {} };
  if (!g) {
    for (const [k, m] of Object.entries(run.vs)) { const ty = splitOpTy(k)[1]; doc.vSame[ty] = (doc.vSame[ty] || 0) + Object.values(m).reduce((x, y) => x + y, 0); }
    // stabile Rückkehrer: Fahrtbeginn gehört zum Lauf des Verschwindens (wie bei rotierenden Kennungen)
    const byAt = new Map([...doc.tail, ...doc.runs].map(r => [r.at, r]));
    for (const [k, node, startAt] of est.vsLate || []) {
      const r0 = byAt.get(startAt); if (!r0 || r0.gap) { doc.lost++; continue; }
      addTo(r0.vs, k, node); const ty = splitOpTy(k)[1]; doc.vLate[ty] = (doc.vLate[ty] || 0) + 1;
    }
  }
  doc.runs.push(run);
  return doc;
}

// ---------- Schätzung eines Tages ----------
/**
 * which: 'est' (s/e, rotierende Quellen) oder 'val' (vs/ve, stabile Quellen). Lmap/tauMap je Art (m bzw. Min.).
 * Rückgabe: rows wie flows-raw ({ 'ags|op|ty|band': { 'von>nach': [n, 0, luftlinieSumme] } }, Zellen in der Vergröberung factor),
 * meanM je Art, Kennzahlen. collect: true = rows (mit keep: nur Paare 'ags|von>nach' aus dem Set), false = nur Kennzahlen,
 * 'totals' = sparsam: totals (Map Paar-Nummer → Summe über Anbieter, Arten, Bänder; pairName(nr) → 'ags|von>nach') und munis je Gemeinde.
 */
export function estimateDay(raw, { which = 'est', Lmap = {}, tauMap = {}, factor = EST_DEFAULTS.factor, carry = false, runStep = 1, types = null, collect = /** @type {boolean | 'totals'} */ (true), keep = null, skip = null, opts = {} } = {}) {
  const o = /** @type {any} */ ({ ...EST_DEFAULTS, ...opts });
  const sKey = which === 'val' ? 'vs' : 's', eKey = which === 'val' ? 've' : 'e';
  const all = [...(raw?.tail || []), ...(raw?.runs || [])].sort((a, b) => a.at - b.at);
  const nTail = (raw?.tail || []).length;
  const rows = {}, dist = {}, stats = { runs: 0, solves: 0, pairs: 0, cand: 0, starts: 0, ends: 0, trips: 0, lost: 0, skipped: 0, ms: 0 };
  const totals = collect === 'totals' ? new Map() : null, munis = {}, nodeId = new Map(), nodeName = [], cellId = new Map(), cellName = [];
  const NID = (m, names, k) => { let i = m.get(k); if (i == null) { i = names.length; m.set(k, i); names.push(k); } return i; };
  const t0 = Date.now(); const cc = new Map(); const C = (cell) => { let c = cc.get(cell); if (!c) { const k = coarse(cell, factor); c = [k, ...centerOf(k, factor)]; cc.set(cell, c); } return c; };
  for (let k = nTail; k < all.length; k++) {
    if ((k - nTail) % runStep) continue;
    const run = all[k]; if (run.gap) continue; stats.runs++;
    // Vorläufe: lückenlose Kette (Abstand = dt des jüngeren Laufs), höchstens maxLag
    const lags = [run];
    for (let m = 1; carry && m <= o.maxLag; m++) { const younger = lags[m - 1], r0 = all[k - m]; if (!r0 || r0.gap || younger.dt == null || Math.abs(younger.at - younger.dt - r0.at) > 5000) break; lags.push(r0); }
    const keys = new Set(Object.keys(run[eKey] || {}));
    for (const opty of keys) {
      const [op, ty] = splitOpTy(opty); if (types && !types.includes(ty)) continue;
      const fam = famOf(ty), L = Lmap[ty] ?? Lmap[fam] ?? 1000, tau = (tauMap[ty] ?? tauMap[fam] ?? TYPE_FALLBACK[fam].min) * 60e3;
      // Quellen: Beginne aus Lauf k−m mit Anteil w[m] des Intervalls von k−m; Reichweite = vmax × (Zeit seit Beginn des Intervalls k−m)
      const src = [];
      for (let m = 0; m < lags.length; m++) {
        const r0 = lags[m], cnt = r0[sKey]?.[opty]; if (!cnt) continue;
        const wm = carry ? lagWeights(r0.dt ?? run.dt, tau, o.maxLag)[m] : 1; // fehlt ein Vorlauf (Lücke), entfällt dessen Anteil
        if (!(wm > 0)) continue;
        const span = run.at - r0.at + (r0.dt ?? run.dt ?? 0);
        for (const [node, n] of Object.entries(cnt)) { const [ags, cell] = splitNode(node); if (skip?.has(`${ags}|${op}`)) { if (!m) stats.skipped += n; continue; } const [cid, la, lo] = C(cell); src.push({ ags, cell: cid, lat: la, lon: lo, n, m: n * wm, dmax: o.vmaxKmh / 3.6 * span / 1000 }); }
      }
      const snk = []; for (const [node, n] of Object.entries(run[eKey][opty])) { const [ags, cell] = splitNode(node); if (skip?.has(`${ags}|${op}`)) continue; const [cid, la, lo] = C(cell); snk.push({ ags, cell: cid, lat: la, lon: lo, m: n }); }
      stats.ends += snk.reduce((a, x) => a + x.m, 0);
      if (!src.length) continue;
      const res = solveRun(src, snk, { L, dminM: o.dminM, phi: o.phi, iters: o.iters, tol: o.tol, prune: o.prune, maxPairs: o.maxPairs, kL: o.kL });
      stats.solves++; stats.cand += res.P; stats.pairs += res.pairs.length; stats.lost += res.lost || 0;
      const dd = (dist[ty] ??= [0, 0]), sup = collect === true ? new Map() : null; // A10: beitragende Fahrtbeginne je Zeile (jede Quelle einmal)
      for (const [i, j, t, d] of res.pairs) {
        dd[0] += t; dd[1] += t * d; stats.trips += t; if (!collect) continue;
        const s = src[i], e = snk[j];
        if (totals) { const mm = (munis[s.ags] ??= { trips: 0, ops: {} }); mm.trips += t; mm.ops[op] = (mm.ops[op] || 0) + t; const key = NID(nodeId, nodeName, `${s.ags}|${s.cell}`) * 2097152 + NID(cellId, cellName, e.cell); totals.set(key, (totals.get(key) || 0) + t); continue; }
        if (keep && !keep.has(`${s.ags}|${s.cell}>${e.cell}`)) continue;
        const rk = `${s.ags}|${op}|${ty}|${run.band}`, pk = `${s.cell}>${e.cell}`;
        const r = (rows[rk] ??= {}); const a = (r[pk] ??= [0, 0, 0, 0]); a[0] += t; a[2] += t * d;
        let ss = sup.get(a); if (!ss) sup.set(a, (ss = new Set())); if (!ss.has(i)) { ss.add(i); a[3] += s.n; }
      }
    }
    for (const opty of Object.keys(run[sKey] || {})) for (const n of Object.values(run[sKey][opty])) stats.starts += n;
  }
  stats.ms = Date.now() - t0;
  const meanM = {}; for (const [ty, [n, s]] of Object.entries(dist)) meanM[ty] = n > 0 ? s / n : null;
  const pairName = (key) => `${nodeName[Math.floor(key / 2097152)]}>${cellName[key % 2097152]}`;
  return { rows, meanM, stats, totals, munis, pairName };
}

/** Hyman-Kalibrierung: L je Art so, dass die mittlere geschätzte Luftlinie dem Zielwert (km) entspricht (Sekantenverfahren in log L). */
export function calibrateL(raw, { which = 'est', targetKm = {}, tauMap = {}, factor = EST_DEFAULTS.factor, carry = false, runStep = 1, skip = null, opts = {} } = {}) {
  const o = /** @type {any} */ ({ ...EST_DEFAULTS, ...opts });
  const tys = new Set(); for (const r of raw?.runs || []) for (const k of Object.keys(r[which === 'val' ? 've' : 'e'] || {})) tys.add(splitOpTy(k)[1]);
  const L = {}, hist = {}, T = {};
  for (const ty of tys) { T[ty] = (targetKm[ty] ?? targetKm[famOf(ty)] ?? TYPE_FALLBACK[famOf(ty)].km) * 1000; L[ty] = T[ty] / 2; hist[ty] = []; }
  let evals = 0, ms = 0;
  for (; evals < o.hymanEvals && tys.size; evals++) {
    const r = estimateDay(raw, { which, Lmap: L, tauMap, factor, carry, runStep, types: [...tys], collect: false, skip, opts }); ms += r.stats.ms;
    let done = true;
    for (const ty of tys) {
      const m = r.meanM[ty]; if (!(m > 0)) continue; hist[ty].push([Math.log(L[ty]), Math.log(m)]);
      if (Math.abs(m / T[ty] - 1) <= o.hymanTol) { tys.delete(ty); continue; }
      const h = hist[ty]; let g = 1;
      if (h.length >= 2) { const [x1, y1] = h[h.length - 2], [x2, y2] = h[h.length - 1]; if (Math.abs(x2 - x1) > 1e-9) g = Math.min(3, Math.max(0.1, (y2 - y1) / (x2 - x1))); }
      const step = Math.max(-Math.log(4), Math.min(Math.log(4), (Math.log(T[ty]) - Math.log(m)) / g));
      const nl = Math.min(o.Lmax, Math.max(o.Lmin, L[ty] * Math.exp(step)));
      if (nl === L[ty]) { tys.delete(ty); continue; } // an der Grenze (Geometrie erzwingt längere/kürzere Wege): nicht weiter rechnen
      L[ty] = nl; done = false;
    }
    if (done) { evals++; break; }
  }
  return { L, targetM: T, evals, ms };
}

// ---------- Validierung an stabilen Kennungen ----------
const coarsePairKey = (pk, f) => { const [a, b] = pk.split('>'); return `${coarse(a, f)}>${coarse(b, f)}`; };
/** Tagessummen je 'ags|op|ty|von>nach' (Bänder zusammengefasst); measured=true: Zellen auf factor vergröbert */
function dayPairs(rows, factor, measured) {
  const out = new Map();
  for (const [k, r] of Object.entries(rows || {})) {
    const [ags, op, ty] = k.split('|');
    for (const [pk, a] of Object.entries(r)) { if (!(a[0] > 0)) continue; const p = measured ? coarsePairKey(pk, factor) : pk; const [f, t] = p.split('>'); if (f === t) continue; const key = `${ags}|${op}|${ty}|${p}`; out.set(key, (out.get(key) || 0) + a[0]); }
  }
  return out;
}
const pairDist = (key, f) => { const p = key.slice(key.lastIndexOf('|') + 1); const [a, b] = p.split('>'); const [la1, lo1] = centerOf(a, f), [la2, lo2] = centerOf(b, f); return distM(la1, lo1, la2, lo2); };
/** Gütekennzahlen Schätzung (est) gegen Messung (meas), beide Map key → Fahrten */
export function compareFlows(est, meas, { factor = 1, top = 50 } = {}) {
  let se = 0, sm = 0, smin = 0, de = 0, dm = 0;
  const keys = new Set([...est.keys(), ...meas.keys()]);
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (const k of keys) {
    const e = est.get(k) || 0, m = meas.get(k) || 0; se += e; sm += m; smin += Math.min(e, m);
    const d = pairDist(k, factor); de += e * d; dm += m * d;
    n++; sx += e; sy += m; sxx += e * e; syy += m * m; sxy += e * m;
  }
  const cov = sxy - sx * sy / n, vx = sxx - sx * sx / n, vy = syy - sy * sy / n;
  // Top-N je Gemeinde: Anteil der gemessenen Fahrten in den N stärksten geschätzten Paaren, verglichen mit den N stärksten gemessenen
  const byAgs = new Map(); for (const k of keys) { const ags = k.slice(0, k.indexOf('|')); if (!byAgs.has(ags)) byAgs.set(ags, []); byAgs.get(ags).push(k); }
  let hit = 0, oracle = 0;
  for (const list of byAgs.values()) {
    hit += list.slice().sort((a, b) => (est.get(b) || 0) - (est.get(a) || 0)).slice(0, top).reduce((s, k) => s + (meas.get(k) || 0), 0);
    oracle += list.slice().sort((a, b) => (meas.get(b) || 0) - (meas.get(a) || 0)).slice(0, top).reduce((s, k) => s + (meas.get(k) || 0), 0);
  }
  const r3 = (x) => (Number.isFinite(x) ? +x.toFixed(3) : null);
  return { measured: +sm.toFixed(1), estimated: +se.toFixed(1), pairs: keys.size, cpc: se + sm > 0 ? r3(2 * smin / (se + sm)) : null,
    r: vx > 0 && vy > 0 ? r3(cov / Math.sqrt(vx * vy)) : null, top, topShare: sm > 0 ? r3(hit / sm) : null, topOracle: sm > 0 ? r3(oracle / sm) : null,
    topRatio: oracle > 0 ? r3(hit / oracle) : null, meanKmEst: se > 0 ? r3(de / se / 1000) : null, meanKmMeas: sm > 0 ? r3(dm / sm / 1000) : null,
    distDev: se > 0 && sm > 0 ? r3((de / se) / (dm / sm) - 1) : null };
}
/**
 * Blinde Validierung: Schätzung nur aus den Zählungen stabiler Quellen (vs/ve), L nach Hyman zum selben Zielwert wie die Schätzung;
 * Vergleich mit den gemessenen Strömen derselben Quellen (measuredRaw.rows, flows-raw). Dazu: ohne Distanzzerfall (Grundlinie),
 * mit Laufgrenzen-Übertrag (cpcCarry, seit A9 nicht mehr Standard), Zielwert × grid. Gibt auch die beobachteten Anteile w0 (selber Lauf) je Art zurück.
 */
export function validateDay(raw, measuredRaw, { targetKm = {}, tauMap = {}, factor = EST_DEFAULTS.factor, opts = {} } = {}) {
  const o = /** @type {any} */ ({ ...EST_DEFAULTS, ...opts });
  const meas = dayPairs(measuredRaw?.day === raw?.day ? measuredRaw.rows : {}, factor, true);
  if (!meas.size) return null;
  const run = (tk, extra = {}) => { const cal = calibrateL(raw, { which: 'val', targetKm: tk, tauMap, factor, opts, ...extra }); const r = estimateDay(raw, { which: 'val', Lmap: cal.L, tauMap, factor, opts, ...extra }); return { cal, r, cmp: compareFlows(dayPairs(r.rows, factor, false), meas, { factor }) }; };
  const main = run(targetKm);
  const base = estimateDay(raw, { which: 'val', Lmap: { scooter: Infinity, bike: Infinity, ...Object.fromEntries(Object.keys(main.cal.L).map(t => [t, Infinity])) }, tauMap, factor, opts });
  const withCarry = run(targetKm, { carry: true });
  const grid = o.grid.map(g => { const tk = {}; for (const [ty, m] of Object.entries(main.cal.targetM)) tk[ty] = m / 1000 * g; return { factor: g, cpc: run(tk).cmp.cpc, targetKm: tk }; });
  // je Art (für die Nachführung): gemessene Fahrten, beste Zielwert-Variante
  const byType = {};
  for (const ty of Object.keys(main.cal.L)) {
    const mt = new Map([...meas].filter(([k]) => k.split('|')[2] === ty)); if (!mt.size) continue;
    const pick = (rows) => new Map([...dayPairs(rows, factor, false)].filter(([k]) => k.split('|')[2] === ty));
    const c1 = compareFlows(pick(main.r.rows), mt, { factor }), variants = [{ g: 1, cpc: c1.cpc }];
    for (const g of o.grid) { const tk = { [ty]: main.cal.targetM[ty] / 1000 * g }; const cal = calibrateL(raw, { which: 'val', targetKm: { ...targetKm, ...tk }, tauMap, factor, opts }); variants.push({ g, cpc: compareFlows(pick(estimateDay(raw, { which: 'val', Lmap: cal.L, tauMap, factor, opts }).rows), mt, { factor }).cpc }); }
    const best = variants.reduce((a, b) => ((b.cpc ?? -1) > (a.cpc ?? -1) ? b : a));
    const vs = raw.vSame?.[ty] || 0, vl = raw.vLate?.[ty] || 0;
    byType[ty] = { measured: +[...mt.values()].reduce((a, b) => a + b, 0).toFixed(1), L: Math.round(main.cal.L[ty]), targetKm: +(main.cal.targetM[ty] / 1000).toFixed(3), cpc: variants[0].cpc, bestFactor: best.g, w0: vs + vl > 0 ? +(vs / (vs + vl)).toFixed(3) : null,
      meanKmMeas: c1.meanKmMeas, meanKmEst: c1.meanKmEst, distDev: c1.distDev }; // A9: gemessene Luftlinie (Anker) und Abweichung der Schätzung
  }
  return { ...main.cmp, cpcBase: compareFlows(dayPairs(base.rows, factor, false), meas, { factor }).cpc, cpcCarry: withCarry.cmp.cpc, grid: grid.map(g => ({ factor: g.factor, cpc: g.cpc })), byType, L: Object.fromEntries(Object.entries(main.cal.L).map(([k, v]) => [k, Math.round(v)])) };
}

// ---------- Veröffentlichung ----------
const median = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
/** Zielwerte und Fahrtdauern je Familie: nachgeführt (raw.learn) vor reference.json bzw. Rückfallwert */
export function paramsFor(raw, reference) {
  const ref = targetsFromReference(reference), targetKm = {}, tauMap = {}, src = {};
  for (const fam of FLOW_FAMILIES) {
    const l = raw?.learn?.[fam];
    targetKm[fam] = l?.km ?? ref[fam].km; tauMap[fam] = l?.min ?? ref[fam].min;
    src[fam] = { km: l?.km != null ? (l.kmDays?.length ? `gemessene Luftlinie stabiler Kennungen (${l.kmDays.length} Tag${l.kmDays.length === 1 ? '' : 'e'})` : `nachgeführt an stabilen Kennungen (${l.days} Tag${l.days === 1 ? '' : 'e'})`) : ref[fam].src, min: l?.min != null ? 'nachgeführt an stabilen Kennungen' : ref[fam].src };
  }
  return { targetKm, tauMap, src };
}
/**
 * Nachführung nach der Validierung (A9, seit 13.11.2026): Zielwert = gemessene Luftlinie der stabilen Kennungen (Mittel der letzten LEARN_DAYS Tage,
 * nach Fahrten gewichtet) – fest an der Messung verankert, ohne Übertrag des Vortagsziels. Bis dahin: Ziel × bester Gitterfaktor der Überdeckung,
 * gleitend fortgeschrieben – eine Ratsche, die das Ziel bei gleicher Luftlinie um 45 % kürzer zog (kürzere Ziele überdecken mehr Paare).
 * L folgt daraus je Tag nach Hyman; geprüft wird am Folgetag mit dem bis dahin gelernten Ziel (distDev in der Validierung, Abnahme ≤ 5 %).
 * Fahrtdauer aus w0 weiter gleitend (log). Nur mit genug gemessenen Fahrten (minLearn).
 */
export const LEARN_DAYS = 7;
export function updateLearn(learn, validation, { dtMs = 20 * 60e3, base = /** @type {any} */ ({}), day = null, opts = {} } = {}) {
  const o = /** @type {any} */ ({ ...EST_DEFAULTS, ...opts }); const out = JSON.parse(JSON.stringify(learn || {}));
  for (const fam of FLOW_FAMILIES) {
    const rows = Object.entries(validation?.byType || {}).filter(([ty]) => famOf(ty) === fam).map(([, v]) => v);
    const n = rows.reduce((a, v) => a + v.measured, 0); if (n < o.minLearn) continue;
    const cur = out[fam] || {}; const min0 = cur.min ?? base.tauMap?.[fam];
    const w0 = median(rows.map(v => v.w0));
    const ema = (x0, x1) => (x0 > 0 && x1 > 0 ? Math.exp((1 - o.learnRate) * Math.log(x0) + o.learnRate * Math.log(x1)) : x0);
    const tau = w0 != null ? tauFromW0(w0, dtMs) : null;
    const wk = rows.filter(v => v.meanKmMeas > 0), kmDay = wk.length ? wk.reduce((a, v) => a + v.meanKmMeas * v.measured, 0) / wk.reduce((a, v) => a + v.measured, 0) : null;
    const hist = [...(cur.kmDays || []).filter(x => x && x[0] !== day), ...(kmDay ? [[day, +kmDay.toFixed(3), Math.round(n)]] : [])].slice(-LEARN_DAYS);
    const km = hist.length ? hist.reduce((a, x) => a + x[1] * x[2], 0) / hist.reduce((a, x) => a + x[2], 0) : cur.km ?? base.targetKm?.[fam];
    out[fam] = { km: km ? +km.toFixed(3) : undefined, min: min0 && tau ? +ema(min0, tau / 60e3).toFixed(2) : min0 ?? undefined, days: (cur.days || 0) + 1, n: Math.round(n), kmDays: hist, anchor: 'gemessene Luftlinie' };
  }
  return out;
}
/**
 * Veröffentlichte Tagesdatei flows-est/<Tag>.json aus der Tagessumme der Zählungen (raw) und den gemessenen Strömen desselben Tages
 * (measuredRaw, nur für die Validierung und um Anbieter mit stabilen Kennungen nicht doppelt zu schätzen).
 * Zeilen nach FLOW_FIELDS wie flows/<Tag>.json, aber anzahl = erwartete Fahrten (1 Nachkommastelle), dauer_s = null.
 */
// Mindestschwelle der geschätzten Ströme: 2 erwartete Fahrten. Sie bleibt bei 2, als die gemessenen Ströme (FLOW_MIN) auf 5 stiegen: geschätzte
// Paare entstehen aus Zählungen je Zelle und Lauf (keine Fahrtpaare), auf 500-m-Zellen und als Erwartungswert.
export const EST_MIN = 2;
// A10 (13.11.2026): dazu mindestens 5 beitragende Fahrtbeginne je Zeile (Summe der Beginne der Quellzellen, die in die Zeile eingehen, je Lauf
// einmal). Eine Komponente aus einem Beginn und einem Ende ergibt sonst eine Zeile, die eine einzelne echte Fahrt wiedergibt.
export const EST_SUPPORT = 5;
export function publishEstimate(raw, measuredRaw, { at = null, reference = null, min = EST_MIN, minSupport = EST_SUPPORT, top = FLOW_TOP, factor = EST_DEFAULTS.factor, calStep = 2, opts = {} } = {}) {
  const t0 = Date.now();
  const prm = paramsFor(raw, reference);
  // Anbieter mit stabilen Kennungen in einer Gemeinde: dort gibt es gemessene Ströme (flows/), keine Schätzung
  const stable = measuredRaw?.day === raw?.day ? measuredRaw?.stable || {} : {};
  const skip = new Set(Object.entries(stable).flatMap(([ags, ops]) => ops.map(op => `${ags}|${op}`)));
  const base = { which: 'est', tauMap: prm.tauMap, factor, skip, opts };
  const cal = calibrateL(raw, { ...base, targetKm: prm.targetKm, runStep: calStep });
  // 1. sparsam: Summe je Zellenpaar über Anbieter, Arten, Bänder – nur Paare, die die Mindestschwelle erreichen können, im Einzelnen
  const tot = estimateDay(raw, { ...base, Lmap: cal.L, collect: 'totals' });
  const keep = new Set(); for (const [k, v] of tot.totals) if (v >= min) keep.add(tot.pairName(k));
  const est = keep.size ? estimateDay(raw, { ...base, Lmap: cal.L, collect: true, keep }) : { rows: {}, stats: { ms: 0 } };
  const runs = (raw?.runs || []).filter(r => !r.gap).length;
  const pub = publishFlows({ day: raw?.day ?? null, runs, rows: est.rows, stable: {} }, { min, top, at, minSupport });
  for (const [ags, m] of Object.entries(tot.munis)) { const p = (pub.munis[ags] ??= { trips: 0, shown: 0, below: 0, cut: 0, ops: {} }); p.below += Math.max(0, m.trips - p.trips); p.trips = m.trips; p.ops = { ...m.ops }; }
  const r1 = (x) => Math.round(x * 10) / 10;
  for (const row of pub.flows) { row[6] = r1(row[6]); row[7] = null; row[8] = Math.round(row[8]); }
  for (const m of Object.values(pub.munis)) { for (const f of ['trips', 'shown', 'below', 'cut']) m[f] = r1(m[f]); for (const op of Object.keys(m.ops)) m.ops[op] = r1(m.ops[op]); }
  pub.total = { trips: 0, shown: 0, below: 0, cut: 0 }; for (const m of Object.values(pub.munis)) for (const f of Object.keys(pub.total)) pub.total[f] += m[f];
  for (const f of Object.keys(pub.total)) pub.total[f] = r1(pub.total[f]);
  const t1 = Date.now();
  const validation = validateDay(raw, measuredRaw, { targetKm: prm.targetKm, tauMap: prm.tauMap, factor, opts });
  const dts = (raw?.runs || []).filter(r => !r.gap && r.dt > 0).map(r => r.dt);
  const learn = updateLearn(raw?.learn, validation, { dtMs: median(dts) ?? 20 * 60e3, base: prm, day: raw?.day ?? null, opts });
  delete pub.stable;
  const doc = { ...pub, estimated: true, cell: [CELL_LAT * factor, CELL_LON * factor], fields: FLOW_FIELDS,
    fieldNotes: { anzahl: 'erwartete Fahrten (Schätzwert, Tagessumme, 1 Nachkommastelle)', dauer_s: 'nicht geschätzt (null)', luftlinie_m: 'Summe erwartete Fahrten × Luftlinie Zellmitte–Zellmitte' },
    method: { name: EST_METHOD, version: EST_VERSION, decay: 'exp(-d/L)', L_m: Object.fromEntries(Object.entries(cal.L).map(([k, v]) => [k, Math.round(v)])), targetKm: prm.targetKm, tauMin: prm.tauMap, sources: prm.src,
      dminM: EST_DEFAULTS.dminM, vmaxKmh: EST_DEFAULTS.vmaxKmh, maxLag: 0, crossRun: false, minSupport, factor, sameCell: 'ausgeschlossen', unit: 'erwartete Fahrten je Zellenpaar und Tag',
      excluded: 'Anbieter mit stabilen Kennungen (gemessene Ströme in flows/), Lücken-Läufe, Abholungen (gesperrt/Akku < 15 %), Ausbringen/Einsammeln (≥ 4 Fahrzeuge ≤ 40 m), Quellen mit Massenwechsel' },
    stableSkipped: r1(tot.stats.skipped), starts: r1(tot.stats.starts), ends: r1(tot.stats.ends), quality: validation,
    runtimeMs: { total: Date.now() - t0, calibration: cal.ms, estimate: tot.stats.ms + (est.stats.ms || 0), validation: Date.now() - t1, perRun: tot.stats.runs ? Math.round(tot.stats.ms / tot.stats.runs) : null }, hymanEvals: cal.evals };
  return { doc, learn, stats: tot.stats };
}
/** flows-est/index.json */
export function estIndex(days, { collecting = null, at = null, method = null, quality = null, min = EST_MIN, top = FLOW_TOP } = {}) {
  return { estimated: true, days: [...new Set(days || [])].filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort(), collecting, min, top, fields: FLOW_FIELDS, method, quality, updatedAt: at };
}
