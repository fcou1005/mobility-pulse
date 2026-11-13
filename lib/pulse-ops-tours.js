// @ts-check
// Mobility Pulse — Disposition – Touren: Umsetzen, Akkutausch, Werkstatt, Stationen, Priorität und Reihenfolge (aus pulse-ops.js geschnitten; pulse-ops.js bleibt die Fassade für alle Importe).
import { cellOf } from './pulse-track.js';
import { idleClassText } from './pulse-idle.js';
import { DEFAULTS, dist, isAvailable, needOf, quantile, sum } from './pulse-ops-model.js';

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
// ---------- Priorität je Stopp ----------
// Skala: 0 = nicht dringend, 1 = dringend, bis 1,5 mit Zuschlag. Ein Stopp mit mehreren Fahrzeugen zählt mit dem dringendsten (Grund = dessen Werte).
// Begründung der Konstanten:
//  energyW 0,7 / idleW 0,3 – Akkutausch: ein fast leeres Fahrzeug fällt als Nächstes aus (kein Umsatz, Kunden stranden); die Standzeit zeigt
//    zusätzlich, dass es an der Stelle niemand nimmt. Energie-Lücke = 1 − Ladestand ÷ Tauschschwelle bzw. 1 − Reichweite ÷ Schwelle (die größere
//    von beiden; 0 an der Schwelle, 1 bei leer).
//  idleRefH 24 – Standzeit zählt linear bis 24 h voll (Einsammeln: Standzeit des Überschuss-Fahrzeugs; Werkstatt: Sperrdauer = Standzeit seit der
//    letzten Bewegung, der Feed meldet keinen Sperrbeginn).
//  longIdleBonus 0,5 ab longIdleH 24 h – länger als einen Tag ungenutzt bzw. gesperrt ist deutlich dringender (Beschwerden, Vandalismus, Auflagen).
//  needRef 6 – Ausbringen (Umsetzen, Stationsausgleich): Fehlmenge ÷ 6 Fahrzeuge, höchstens 1 (6 ≈ ein Drittel einer Transporterladung).
//  emptyBonus 0,5 – Spot ohne verfügbares Fahrzeug im Umkreis (150 m) bzw. leere Station: dort geht gerade jede Fahrt verloren.
//  fullStation 0,5 – Abholen an einer Station ohne freien Platz (keine Rückgabe möglich); sonst ist Abholen nicht dringend (0).
export const PRIO = { energyW: 0.7, idleW: 0.3, idleRefH: 24, longIdleH: 24, longIdleBonus: 0.5, needRef: 6, emptyBonus: 0.5, fullStation: 0.5 };
const r3 = (x) => Math.round(x * 1000) / 1000;
const idleH = (v) => Math.max(0, v.idleMin ?? 0) / 60;
const idlePart = (h) => Math.min(1, h / PRIO.idleRefH) + (h >= PRIO.longIdleH ? PRIO.longIdleBonus : 0);
/** Priorität eines Fahrzeugs für einen Stopp-Typ ('swap' | 'pickup' | 'pickup_disabled') mit Grund { battery, rangeKm, idleH }. */
export function vehiclePrio(type, v, opts = {}) {
  const o = { ...DEFAULTS, ...opts }, h = idleH(v), why = { idleH: v.idleMin == null ? null : Math.round(h) };
  if (type !== 'swap') return { prio: r3(idlePart(h)), why };
  const gaps = [v.battery != null ? 1 - v.battery / o.swapThreshold : null, rangeUsable(v) ? 1 - v.rangeKm / swapRangeOf(v, o.swapRangeKm) : null].filter(x => x != null);
  const gap = gaps.length ? Math.min(1, Math.max(0, ...gaps)) : 0;
  return { prio: r3(PRIO.energyW * gap + PRIO.idleW * Math.min(1, h / PRIO.idleRefH) + (h >= PRIO.longIdleH ? PRIO.longIdleBonus : 0)), why: { battery: v.battery ?? null, rangeKm: v.rangeKm ?? null, ...why } };
}
/** Priorität eines Ausbring-Stopps nach Fehlmenge (need) und Bestand im Umkreis (have; 0 = leer). */
export function dropPrio(need, have, target = null) {
  const n = Math.max(0, need || 0);
  return { prio: r3(Math.min(1, n / PRIO.needRef) + (have === 0 ? PRIO.emptyBonus : 0)), why: { need: n, have, target, empty: have === 0 } };
}
// dringendstes Fahrzeug eines Stopps
const maxPrio = (list) => list.reduce((b, x) => (x.prio > b.prio ? x : b), list[0]);

// ---------- Reihenfolge mit Priorität ----------
/**
 * Reihenfolge einer Tour aus Gruppen in fester Folge (Umsetzen: erst alle Abholungen, dann alle Ausbringungen) mit Priorität.
 * Ziel J = L + λ · Σ wᵢ·dᵢ ÷ Σ wᵢ
 *   L = Tourlänge (Start → Stopps → Ende), dᵢ = Strecke vom Start bis Stopp i, wᵢ = Priorität − kleinste Priorität der Tour (≥ 0).
 * Der zweite Term ist die nach Dringlichkeit gewichtete mittlere Anfahrstrecke in Metern (wie L): dringende Stopps kommen früh, wenn der Umweg
 * klein ist. λ = 0 oder gleiche Prioritäten (alle wᵢ = 0) ergeben die kürzeste Tour. Weil wᵢ ≥ 0, macht ein Umweg J nie kleiner.
 * Exakt (Held-Karp je Gruppe, Gruppen verkettet), solange jede Gruppe ≤ EXACT_MAX Stopps hat: jede Kante zählt für alle noch offenen Stopps,
 * der Aufschlag hängt also nur von der Menge der besuchten Stopps ab und die DP über (Menge, letzter Stopp) bleibt exakt. Darüber Heuristik:
 * Startlösungen (kürzeste Tour wie bisher, Nächster Nachbar mit Priorität, reine Prioritätsfolge, Nächster Nachbar ab anderen Stopps), dann
 * 2-opt und Or-opt innerhalb der Gruppen auf dem vollen Ziel. cost(a, b) darf asymmetrisch sein (OSRM-Matrix).
 * Rückgabe { stops, J, L, reach } (reach = Σ wᵢ·dᵢ ÷ Σ wᵢ oder null, Einheiten von cost).
 */
export function orderTour(groups, { start = null, end = null, cost = makeCost(), weight = null, lambda = 0, exact = true, starts: maxStarts = 6 } = {}) {
  const G0 = groups.filter(g => g?.length), stops = G0.flat(), n = stops.length;
  if (!n) return { stops: [], J: 0, L: 0, reach: null };
  const pts = stops.slice(); const S = start ? pts.push(start) - 1 : -1, E = end ? pts.push(end) - 1 : -1, N = pts.length;
  const M = new Float64Array(N * N); for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) M[i * N + j] = i === j ? 0 : cost(pts[i], pts[j]);
  const raw = stops.map(s => (weight ? +weight(s) || 0 : 0)), wmin = Math.min(...raw), w = Float64Array.from(raw, x => x - wmin);
  const W = w.reduce((a, b) => a + b, 0), lam = lambda > 0 && W > 1e-9 ? lambda / W : 0;
  const ranges = []; { let a = 0; for (const g of G0) { ranges.push([a, a + g.length]); a += g.length; } } // Stopps der Gruppe g = Indizes ranges[g]
  // Tourwerte einer Folge t (Stopp-Indizes): L, Σ w·d, J
  const evalT = (t) => { let R = W, J = 0, L = 0, wd = 0, d = 0, p = S;
    for (let i = 0; i < n; i++) { const x = t[i]; if (p >= 0) { const c = M[p * N + x]; L += c; d += c; J += c * (1 + lam * R); } wd += w[x] * d; R -= w[x]; p = x; }
    if (E >= 0) { const c = M[p * N + E]; L += c; J += c; }
    return { J, L, reach: W > 1e-9 ? wd / W : null }; };
  const done = (t) => { const v = evalT(t); return { stops: Array.from(t, i => stops[i]), J: v.J, L: v.L, reach: v.reach }; };
  const pix = new Map(); pts.forEach((p, i) => { if (!pix.has(p)) pix.set(p, i); });
  const mc = (a, b) => M[pix.get(a) * N + pix.get(b)], ix = new Map(stops.map((s, i) => [s, i]));
  // eine Gruppe ohne Priorität: bisherige Reihenfolge (Held-Karp bis 12, sonst Nächster Nachbar + 2-opt + Or-opt mit Delta-Bewertung)
  if (G0.length === 1 && lam === 0) return done(Int32Array.from(orderStops(stops, { start, end, cost: mc, starts: maxStarts, exact }), s => ix.get(s)));
  // ---- exakt: Held-Karp je Gruppe, verkettet über den letzten Stopp der vorigen Gruppe
  if (exact && ranges.every(([a, b]) => b - a <= EXACT_MAX)) {
    let prevNodes = [S], prevCost = [0], Wrest = W; const back = [];
    for (const [a, b] of ranges) {
      const m = b - a, F = 1 << m, Gn = Array.from({ length: m }, (_, j) => a + j);
      let Wg = 0; for (const x of Gn) Wg += w[x]; Wrest -= Wg;
      const Wm = new Float64Array(F); for (let mk = 1; mk < F; mk++) { const lb = mk & -mk; Wm[mk] = Wm[mk ^ lb] + w[Gn[31 - Math.clz32(lb)]]; }
      const dp = new Float64Array(F * m).fill(Infinity), par = new Int8Array(F * m).fill(-1), seed = new Int32Array(m);
      for (let j = 0; j < m; j++) for (let e = 0; e < prevNodes.length; e++) {
        const pe = prevNodes[e], c = prevCost[e] + (pe < 0 ? 0 : M[pe * N + Gn[j]] * (1 + lam * (Wg + Wrest)));
        if (c < dp[(1 << j) * m + j]) { dp[(1 << j) * m + j] = c; seed[j] = e; }
      }
      for (let mk = 1; mk < F; mk++) { const mult = 1 + lam * (Wg - Wm[mk] + Wrest);
        for (let j = 0; j < m; j++) { const v = dp[mk * m + j]; if (v === Infinity || !(mk & (1 << j))) continue;
          for (let k = 0; k < m; k++) if (!(mk & (1 << k))) { const T = mk | (1 << k), c = v + M[Gn[j] * N + Gn[k]] * mult; if (c < dp[T * m + k]) { dp[T * m + k] = c; par[T * m + k] = j; } } } }
      back.push({ Gn, m, F, par, seed }); prevNodes = Gn; prevCost = Gn.map((_, j) => dp[(F - 1) * m + j]);
    }
    let bj = 0, bv = Infinity; for (let j = 0; j < prevNodes.length; j++) { const c = prevCost[j] + (E >= 0 ? M[prevNodes[j] * N + E] : 0); if (c < bv) { bv = c; bj = j; } }
    const seq = []; let j = bj;
    for (let g = back.length - 1; g >= 0; g--) { const { Gn, m, F, par, seed } = back[g]; const part = []; let mk = F - 1, jj = j, first = j;
      while (jj >= 0) { part.push(Gn[jj]); first = jj; const pj = par[mk * m + jj]; mk &= ~(1 << jj); jj = pj; }
      seq.push(...part); j = seed[first]; }
    return done(Int32Array.from(seq.reverse()));
  }
  // ---- Heuristik
  // Nächster Nachbar über die Gruppen nacheinander; score(x) skaliert den Abstand (Priorität: dringende wirken näher), first = erster Stopp
  const nnFrom = (score, first = null) => { const t = []; let cur = S;
    for (const [a, b] of ranges) { const left = []; for (let x = a; x < b; x++) left.push(x);
      if (first != null && a === 0) { left.splice(left.indexOf(first), 1); t.push(first); cur = first; }
      while (left.length) { let bi = 0, bv = Infinity; for (let i = 0; i < left.length; i++) { const c = (cur < 0 ? 0 : M[cur * N + left[i]]) * score(left[i]); if (c < bv - 1e-12) { bv = c; bi = i; } } cur = left.splice(bi, 1)[0]; t.push(cur); } }
    return Int32Array.from(t); };
  const seeds = [];
  // 1) kürzeste Tour wie bisher: je Gruppe orderStops (Start = Ende der vorigen Gruppe, Ende nur bei der letzten) → nie länger als vorher
  { const t = []; let st = start;
    ranges.forEach(([a, b], g) => { const part = orderStops(stops.slice(a, b), { start: st, end: g === ranges.length - 1 ? end : null, cost: mc, starts: Math.min(maxStarts, 6), exact }); t.push(...part.map(s => ix.get(s))); st = part[part.length - 1]; });
    seeds.push(Int32Array.from(t)); }
  if (lam > 0) {
    const wMean = W / n;
    seeds.push(nnFrom(x => 1 / (1 + lambda * w[x] / wMean)));                                                     // 2) Nächster Nachbar mit Priorität
    if (maxStarts > 1) seeds.push(Int32Array.from(ranges.flatMap(([a, b]) => Array.from({ length: b - a }, (_, k) => a + k).sort((x, y) => w[y] - w[x] || x - y)))); // 3) reine Prioritätsfolge
  }
  for (let s = 1; seeds.length < maxStarts && s < n; s++) seeds.push(nnFrom(() => 1, (s * 7919) % (ranges[0][1] - ranges[0][0]))); // 4) andere erste Stopps
  // Lokale Suche. Jeder Zug ergibt eine Folge aus höchstens vier Blöcken der aktuellen Folge t (vorwärts oder rückwärts); mit Präfixsummen
  // der Kanten vorwärts (Fw) und rückwärts (Bw, für asymmetrische Kosten), der Gewichte (PW) und Gewicht × Strecke (PWF, PWB) kostet die
  // Bewertung eines Zugs O(1): je Block Länge, Gewicht und Σ w × Anfahrt innerhalb des Blocks.
  let t = null; const Fw = new Float64Array(n), Bw = new Float64Array(n), PW = new Float64Array(n + 1), PWF = new Float64Array(n + 1), PWB = new Float64Array(n + 1);
  const prefix = () => { for (let x = 1; x < n; x++) { Fw[x] = Fw[x - 1] + M[t[x - 1] * N + t[x]]; Bw[x] = Bw[x - 1] + M[t[x] * N + t[x - 1]]; }
    for (let x = 0; x < n; x++) { const wx = w[t[x]]; PW[x + 1] = PW[x] + wx; PWF[x + 1] = PWF[x] + wx * Fw[x]; PWB[x + 1] = PWB[x] + wx * Bw[x]; } };
  const bl = new Int32Array(12); let nb = 0; const blk = (s, e, rv) => { if (s <= e) { bl[3 * nb] = s; bl[3 * nb + 1] = e; bl[3 * nb + 2] = rv; nb++; } };
  const evalBl = () => { let D = 0, L = 0, WD = 0, prev = S;
    for (let k = 0; k < nb; k++) { const s = bl[3 * k], e = bl[3 * k + 1], rv = bl[3 * k + 2], Wb = PW[e + 1] - PW[s];
      if (prev >= 0) { const c = M[prev * N + (rv ? t[e] : t[s])]; D += c; L += c; }
      const len = rv ? Bw[e] - Bw[s] : Fw[e] - Fw[s];
      WD += Wb * D + (rv ? Bw[e] * Wb - (PWB[e + 1] - PWB[s]) : (PWF[e + 1] - PWF[s]) - Fw[s] * Wb); D += len; L += len; prev = rv ? t[s] : t[e]; }
    if (E >= 0) L += M[prev * N + E];
    return L + lam * WD; };
  const applyBl = () => { const u = new Int32Array(n); let q = 0; for (let k = 0; k < nb; k++) { const s = bl[3 * k], e = bl[3 * k + 1]; if (bl[3 * k + 2]) for (let x = e; x >= s; x--) u[q++] = t[x]; else for (let x = s; x <= e; x++) u[q++] = t[x]; } t = u; prefix(); };
  const improve = (t0) => { t = Int32Array.from(t0); prefix(); nb = 0; blk(0, n - 1, 0); let cur = evalBl(), improved = true, guard = 0;
    const tryMove = () => { const c = evalBl(); if (c < cur - 1e-6) { applyBl(); cur = c; return true; } return false; };
    while (improved && guard++ < 60) { improved = false;
      for (const [a, b] of ranges) {
        // 2-opt: t[i..k] umkehren
        for (let i = a; i < b - 1; i++) for (let k = i + 1; k < b; k++) { nb = 0; blk(0, i - 1, 0); blk(i, k, 1); blk(k + 1, n - 1, 0); if (tryMove()) improved = true; }
        // Or-opt: Abschnitt t[i..i+L−1] (vorwärts oder umgekehrt) an Stelle p der übrigen Folge einsetzen, innerhalb der Gruppe
        for (let L = 1; L <= 3; L++) for (let i = a; i + L <= b; i++) for (let p = a; p <= b - L; p++) {
          if (p === i) continue; let hit = false;
          for (let rv = 0; rv <= (L > 1 ? 1 : 0) && !hit; rv++) {
            nb = 0;
            if (p < i) { blk(0, p - 1, 0); blk(i, i + L - 1, rv); blk(p, i - 1, 0); blk(i + L, n - 1, 0); }
            else { blk(0, i - 1, 0); blk(i + L, p + L - 1, 0); blk(i, i + L - 1, rv); blk(p + L, n - 1, 0); }
            hit = tryMove();
          }
          if (hit) { improved = true; break; }
        }
      } }
    return { c: cur, t }; };
  let best = null, bc = Infinity;
  for (const s of seeds) { const r = improve(s); if (r.c < bc - 1e-9) { bc = r.c; best = r.t; } }
  return done(best);
}
/** Kostenfunktion aus einer übergebenen Matrix (Meter; Zeile/Spalte = Reihenfolge von points); fehlende Werte (null) → Luftlinie × Umwegfaktor. */
const ptKey = (p) => `${(+p.lat).toFixed(5)},${(+p.lon).toFixed(5)}`;
export function matrixCost(points, D, { detour = DEFAULTS.detour } = {}) {
  const idx = new Map(); points.forEach((p, i) => { if (!idx.has(p)) idx.set(p, i); const k = ptKey(p); if (!idx.has(k)) idx.set(k, i); });
  const at = (p) => idx.get(p) ?? idx.get(ptKey(p)), air = makeCost({ detour });
  return (a, b) => { const i = at(a), j = at(b), v = i != null && j != null ? D?.[i]?.[j] : null; return Number.isFinite(v) ? v : air(a, b); };
}
/**
 * S2.12: Tour nach dem Straßenrouting wieder unter die Einsatzgrenze bringen. Solange Fahrzeit (minOf(Depot, Stopps, Depot), Minuten) plus
 * Handhabung (je Fahrzeug wie geplant: handleMin ÷ vehicles) über limitMin liegt, fällt der Stopp mit der niedrigsten Priorität weg –
 * bei Umsetzen/Stationen eine Ausbringung samt gleich vielen Abholungen niedrigster Priorität –, dann wird neu geordnet (cost, lambda).
 * Rückgabe { stops, vehicles, removed, driveMin, handleMin, totalMin }; removed = Fahrzeuge, die nicht mehr eingeplant sind.
 */
export function trimRun(r, { depot = undefined, cost = makeCost(), minOf = undefined, limitMin = undefined, lambda = DEFAULTS.prioLambda } = {}) {
  const hv = r.vehicles > 0 ? r.handleMin / r.vehicles : 0, low = (a, b) => ((b.prio ?? 0) < (a.prio ?? 0) ? b : a);
  let stops = r.stops.slice(), veh = r.vehicles, removed = 0;
  const drive = (st) => minOf([depot, ...st, depot]);
  while (limitMin > 0 && stops.length > 1 && drive(stops) + hv * veh > limitMin) {
    const g = runGroups(stops);
    if (g.length === 2) {
      if (g[1].length <= 1) break; // letzte Ausbringung bleibt: sonst wäre die Tour leer
      const d = g[1].reduce(low); let c = d.count || 1; stops = stops.filter(x => x !== d); veh -= c; removed += c;
      for (const pk of g[0].slice().sort((a, b) => (a.prio ?? 0) - (b.prio ?? 0))) {
        if (c <= 0) break; const k = Math.min(c, pk.count || 1); c -= k;
        stops = k >= (pk.count || 1) ? stops.filter(x => x !== pk) : stops.map(x => (x === pk ? { ...x, count: x.count - k } : x));
      }
    } else { const x = stops.reduce(low), n = x.count || 1; stops = stops.filter(y => y !== x); veh -= n; removed += n; }
    stops = sequenceRun(runGroups(stops), { depot, cost, lambda }).stops;
  }
  const driveMin = Math.round(drive(stops)), handleMin = Math.round(hv * veh);
  return { stops, vehicles: veh, removed, driveMin, handleMin, totalMin: driveMin + handleMin };
}
/** Stopp-Gruppen einer fertigen Tour: Umsetzen/Stationen erst alle Abholungen, dann alle Ausbringungen; sonst eine Gruppe. */
export function runGroups(stops) {
  const pick = stops.filter(s => s.type === 'pickup'), drop = stops.filter(s => s.type === 'drop');
  return pick.length && drop.length && pick.length + drop.length === stops.length ? [pick, drop] : [stops.slice()];
}
/**
 * Reihenfolge und Kennzahlen einer Tour (Planung mit Luftlinie × Umwegfaktor; im Browser erneut mit der OSRM-Straßenmatrix als cost).
 * Jeder Stopp trägt prio (Priorität) und why (Grund). Rückgabe: stops in Fahrreihenfolge mit seq (Position), rank (Rang der Priorität in der
 * Tour, 1 = dringendster), atKm (Strecke vom Depot bis zum Stopp); km (gefahren), kmMin (kürzeste Tour ohne Priorität), kmNN (Nächster Nachbar
 * ohne Verbesserung), kmPrio (reine Prioritätsfolge), reachKm / reachKmMin (nach Priorität gewichtete mittlere Anfahrstrecke dieser bzw. der
 * kürzesten Tour), obj (Zielwert J in m), lambda. quick: schnelle Rechnung (Probe der Einsatzzeit: ein Start, ohne exakte Lösung).
 */
export function sequenceRun(groups, { depot = undefined, cost = makeCost(), lambda = DEFAULTS.prioLambda, quick = false } = {}) {
  const G = groups.filter(g => g?.length), opt = { start: depot, end: depot, cost, weight: s => s.prio ?? 0 };
  const res = orderTour(G, { ...opt, lambda, starts: quick ? 1 : 6, exact: !quick });
  const km = (m) => +(m / 1000).toFixed(1);
  const pv = res.stops.map(s => s.prio ?? 0), rankOf = (p) => 1 + pv.filter(x => x > p + 1e-9).length;
  let d = 0, prev = depot;
  const stops = res.stops.map((s, i) => { d += cost(prev, s); prev = s; return { ...s, seq: i + 1, rank: rankOf(s.prio ?? 0), atKm: km(d) }; });
  const out = { stops, L: res.L, obj: res.J, km: km(res.L), lambda, reachKm: res.reach == null ? null : km(res.reach) };
  // Vergleichswerte auch in der Probe (sie kann als Tour übernommen werden), dort mit der schnellen Rechnung
  let base = lambda > 0 && res.reach != null ? orderTour(G, { ...opt, lambda: 0, starts: quick ? 1 : 6, exact: !quick }) : res;
  if (res.L < base.L) base = res; // Heuristik: die Prioritätstour ist zufällig kürzer → sie ist die kürzeste bekannte
  const len = (seq) => { let m = 0, p = depot; for (const s of seq) { m += cost(p, s); p = s; } return m + cost(p, depot); };
  // Nächster Nachbar ohne Verbesserung (Gruppen nacheinander) und reine Prioritätsfolge (absteigend, Gleichstand in Planungsfolge)
  const nn = []; { let cur = depot; for (const g of G) { const left = g.slice(); while (left.length) { let bi = 0, bv = Infinity; left.forEach((x, i) => { const c = cost(cur, x); if (c < bv) { bv = c; bi = i; } }); cur = left.splice(bi, 1)[0]; nn.push(cur); } } }
  const byPrio = G.flatMap(g => g.map((s, i) => [s, i]).sort((a, b) => (b[0].prio ?? 0) - (a[0].prio ?? 0) || a[1] - b[1]).map(x => x[0]));
  return { ...out, kmMin: km(base.L), reachKmMin: base.reach == null ? null : km(base.reach), kmNN: km(len(nn)), kmPrio: km(len(byPrio)) };
}
// Fahrstrecke und -zeit einer Tour aus sequenceRun (Luftlinie × Umweg bei speedKmh); Kennzahlen der Reihenfolge für die Anzeige
const seqSummary = (sq, o) => ({ km: sq.km, driveMin: Math.round((sq.L / 1000) / o.speedKmh * 60), obj: sq.obj, lambda: sq.lambda, kmMin: sq.kmMin ?? null, kmNN: sq.kmNN ?? null, kmPrio: sq.kmPrio ?? null, reachKm: sq.reachKm, reachKmMin: sq.reachKmMin ?? null });

// Stopps in Läufe gleicher Kapazität bündeln: Sweep vom Depot aus (weitester zuerst), dann die dem Tour-Mittelpunkt nächsten auffüllen.
// fit(run) → { back, ok }: Einsatzzeit prüfen; ein zu langer Lauf behält nur einen Teil (in place), back geht in den Vorrat zurück,
// ok = false: schon der nächstgelegene Auftrag allein ist zu lang (nicht eingeplant).
const centerOf = (pts) => ({ lat: sum(pts.map(p => p.lat)) / pts.length, lon: sum(pts.map(p => p.lon)) / pts.length });
// order(a, b): optionale Vorrangregel für den Tour-Start (Umsetzen: größte Fehlmenge zuerst), bei Gleichstand weitester vom Depot
export function clusterRuns(items, capacity, depot, maxRuns = Infinity, weight = (..._a) => 1, fit = null, order = null) {
  const dd = new Map(items.map(x => [x, dist(depot, x)])), far = (a, b) => dd.get(b) - dd.get(a), byDepot = order ? (a, b) => order(a, b) || far(a, b) : far;
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
    // volle Rechnung, wenn sie die Grenze hält und im Ziel (Strecke + Priorität, ohne Priorität = Strecke) nicht schlechter ist als die Probe
    if (probe) { const r = build(run); memo.set(run, r.totalMin <= maxMin && r.obj <= probe.obj + 1e-6 ? r : probe); }
    return { back: ranked.slice(k), ok: !!probe };
  };
  return { fit, built: (run) => memo.get(run) || build(run) };
}
// gleiche Position (≤ 30 m) zu einem Stopp zusammenfassen
function groupStops(points, keyFn = (..._a) => '', maxM = 30) {
  const out = [];
  for (const p of points) { const g = out.find(s => s.key === keyFn(p) && dist(s, p) <= maxM); if (g) { g.items.push(p); g.count++; } else out.push({ lat: p.lat, lon: p.lon, key: keyFn(p), items: [p], count: 1 }); }
  return out;
}

/**
 * Rebalancing: Fahrzeuge aus Überschuss (lange Standzeit, Zellen mit Zufluss) zu Deploy-Spots mit Fehlmenge.
 * vehicles: verfügbare Fahrzeuge des Anbieters in der Gemeinde. model: Nachfragemodell (Band oder Tag).
 * Bestand = verfügbare Fahrzeuge des Anbieters im Umkreis spotRadiusM (150 m) um den Spot, Fehlmenge = Bedarf − Bestand.
 * Vorrang nach Fehlmenge: Spots mit der größten Fehlmenge bekommen zuerst Überschussfahrzeuge, eröffnen zuerst eine Tour, R1 deckt die größte.
 */
export function planRebalance({ spots, vehicles, model, share = 1, depot, ...opts }) {
  const o = /** @type {any} */ ({ ...DEFAULTS, ...opts });
  const cost = makeCost(o);
  // S2.11: jedes Fahrzeug zählt nur am nächsten Spot (Spots ≥ minSpacingM auseinander, Umkreis spotRadiusM: Kreise überlappen) – sonst zählt es als
  // Bestand zweier Spots und kann zweimal als Überschuss in die Umsetzungen
  const near = new Map(spots.map(s => [s.cell, []]));
  for (const v of vehicles) { let best = null, bd = Infinity; for (const s of spots) { const d = dist(s, v); if (d <= o.spotRadiusM && d < bd) { bd = d; best = s; } } if (best) near.get(best.cell).push(v); }
  const needs = spots.map(s => ({ spot: s, have: near.get(s.cell).length, need: Math.max(0, s.target - near.get(s.cell).length) }));
  const atSpot = new Set(spots.flatMap(s => near.get(s.cell)));
  // überbelegte Spots geben ihre am längsten stehenden Fahrzeuge ab
  const spotExtra = [];
  for (const s of spots) { const list = near.get(s.cell).slice().sort((a, b) => (b.idleMin ?? 0) - (a.idleMin ?? 0)); for (const v of list.slice(0, Math.max(0, list.length - s.target))) spotExtra.push(v); }
  // Überschuss je Zelle: Fahrzeuge über dem rechnerischen Bedarf der Zelle (gleiche Formel wie am Spot, ohne Mindest-/Höchstwert)
  const byCell = new Map();
  for (const v of vehicles) { if (atSpot.has(v)) continue; const c = cellOf(v.lat, v.lon); if (!byCell.has(c)) byCell.set(c, []); byCell.get(c).push(v); }
  const surplus = [];
  for (const [cell, list] of byCell) {
    const mc = model.cells.get(cell), nd = needOf(mc, share, o);
    const keep = Math.ceil(nd.raw - 1e-9);
    const movable = list.filter(v => v.battery == null || v.battery >= o.minBatteryForMove).sort((a, b) => (b.idleMin ?? 0) - (a.idleMin ?? 0));
    const longIdle = movable.filter(v => (v.idleMin ?? 0) >= o.idleSurplusMin);
    const extra = movable.slice(0, Math.max(0, movable.length - keep));
    for (const v of new Set([...longIdle, ...extra])) surplus.push({ ...v, cell, cellDemand: +nd.startsOp.toFixed(2), cellOut: +nd.outOp.toFixed(2) });
  }
  for (const v of spotExtra) if (v.battery == null || v.battery >= o.minBatteryForMove) surplus.push({ ...v, cell: cellOf(v.lat, v.lon), fromSpot: true });
  // Zuordnung: Spots nach Fehlmenge (dann Score), je fehlendem Fahrzeug das nächste Überschussfahrzeug;
  // je Spot die Kandidaten in Reichweite einmal nach Entfernung sortieren (statt je fehlendem Fahrzeug den ganzen Pool)
  const taken = new Set(); const moves = [];
  for (const n of needs.slice().sort((a, b) => b.need - a.need || b.spot.score - a.spot.score)) {
    const cands = surplus.map(v => ({ v, d: dist(v, n.spot) })).filter(x => x.d <= o.maxPickupM && !(x.v.fromSpot && x.d <= o.spotRadiusM)).sort((a, b) => a.d - b.d);
    let k = 0;
    for (const { v, d } of cands) { if (k >= n.need) break; if (taken.has(v)) continue; taken.add(v); k++; moves.push({ lat: v.lat, lon: v.lon, vehicle: v, spot: n.spot, need: n.need, have: n.have, distM: Math.round(d) }); }
  }
  const missing = sum(needs.map(n => n.need)) - moves.length;
  // Touren nach dem Mittelpunkt aus Abhol- und Zielort bündeln: jede Tour bleibt in einem Stadtbereich; Lage = weiterer der beiden Orte
  const mids = moves.map(m => ({ lat: (m.lat + m.spot.lat) / 2, lon: (m.lon + m.spot.lon) / 2, m }));
  const spread = (x, c) => Math.max(dist(c, x.m), dist(c, x.m.spot));
  // Reihenfolge: erst alle Abholungen, dann alle Ausbringungen, beide zusammen optimiert (sequenceRun); Priorität Abholen = Standzeit,
  // Ausbringen = Fehlmenge des Spots (leer im Umkreis = Zuschlag)
  const build = (run, quick) => {
    const g = run.map(x => x.m);
    const pickups = groupStops(g, () => 'p').map(s => ({ type: 'pickup', lat: s.lat, lon: s.lon, count: s.count, idleMaxH: Math.round(Math.max(...s.items.map(x => x.vehicle.idleMin ?? 0)) / 60), battery: s.items.map(x => x.vehicle.battery).filter(b => b != null), ...maxPrio(s.items.map(x => vehiclePrio('pickup', x.vehicle, o))) }));
    const drops = groupStops(g.map(m => ({ ...m.spot, move: m })), s => s.cell, 5).map(s => { const mv = s.items[0].move;
      return { type: 'drop', lat: s.lat, lon: s.lon, count: s.count, spotRank: s.items[0].rank, target: s.items[0].target, have: mv.have, need: mv.need, ...dropPrio(mv.need, mv.have, s.items[0].target) }; });
    const sq = sequenceRun([pickups, drops], { depot, cost, lambda: o.prioLambda, quick });
    const r = seqSummary(sq, o);
    const handle = g.length * (o.pickupMin + o.dropMin);
    return { kind: 'rebalance', vehicles: g.length, shortfall: sum(drops.map(d => d.need)), prio: Math.max(0, ...drops.map(d => d.need)), stops: sq.stops,
      ...r, handleMin: Math.round(handle), totalMin: r.driveMin + Math.round(handle) };
  };
  const cap = timeCap(build, o.maxRunMin, spread), cl = clusterRuns(mids, o.vanCapacity, depot, o.maxRuns, undefined, cap.fit, (a, b) => b.m.need - a.m.need);
  // R1 = Tour zum Spot mit der größten Fehlmenge, dann absteigend
  const runs = cl.runs.map(g => cap.built(g)).sort((a, b) => b.prio - a.prio || b.shortfall - a.shortfall || b.vehicles - a.vehicles).map((r, i) => ({ id: `R${i + 1}`, ...r }));
  return { needs: needs.sort((a, b) => a.spot.rank - b.spot.rank).map(n => ({ rank: n.spot.rank, cell: n.spot.cell, target: n.spot.target, have: n.have, need: n.need })), surplus: surplus.length, moves: moves.length, missing, unplanned: cl.unplanned.length, limitMin: o.maxRunMin, runs };
}

/**
 * Akku-Tausch: Fahrzeuge unter der Schwelle, priorisiert nach Ladestand und Nachfrage am Standort.
 */
export const MAX_SWAP = 50; // höchstens 50 Akkus je Tour (Ladekapazität eines Tauschfahrzeugs)
// Akkutausch nötig: Ladestand UND Reichweite unter der Schwelle (beides muss erfüllt sein). Meldet ein Feed nur eines
// von beiden, entscheidet dieses; ohne Energieangabe kein Tausch.
// Reichweiten-Schwelle je Fahrzeug = min(swapRangeKm, v.rangeLimitKm): v.rangeLimitKm ist die Schwelle der Quelle (20 % des 95. Perzentils der
// Reichweite, wenn dieses < 25 km; pulse-core rangeLimitCheck, Nutzerwunsch 02.11.2026), null = eingestellter Wert.
export const swapRangeOf = (v, swapRangeKm = DEFAULTS.swapRangeKm) => (v?.rangeLimitKm != null && Number.isFinite(v.rangeLimitKm) ? Math.min(swapRangeKm, v.rangeLimitKm) : swapRangeKm);
// Reichweite verwendbar: gemeldet und nicht konstant (v.rangeFlat = Platzhalter der Quelle, pulse-core rangeFlatCheck)
export const rangeUsable = (v) => v?.rangeKm != null && !v.rangeFlat;
export function needsSwap(v, { swapThreshold = DEFAULTS.swapThreshold, swapRangeKm = DEFAULTS.swapRangeKm } = {}) {
  if (v.disabled) return false;
  // Reichweite aus dem Ladestand gerechnet (v.rangeDerived, M-16): nur der Ladestand entscheidet; sonst UND-Regel (Nutzervorgabe)
  const bat = v.battery != null ? v.battery < swapThreshold : null, rng = rangeUsable(v) && !(v.rangeDerived && v.battery != null) ? v.rangeKm < swapRangeOf(v, swapRangeKm) : null;
  if (bat == null && rng == null) return false;
  return (bat ?? true) && (rng ?? true);
}
const energyGap = (v, o) => v.battery != null ? 1 - v.battery / o.swapThreshold : 1 - v.rangeKm / swapRangeOf(v, o.swapRangeKm);
// Gesperrt wegen Akku (Audit 11.11.2026, MET-10/UXP-02): Voi und Bolt nehmen leere Fahrzeuge per is_disabled aus dem Verleih (Voi Stuttgart:
// alle 56 gesperrten mit 2–8 km, verfügbare ab 5 km, 1-%-Quantil 14 km). Die Betriebsgrenze der Quelle = 1-%-Quantil der Energie der
// verfügbaren Fahrzeuge (mind. 20 mit Angabe, gedeckelt auf 35 % bzw. 25 km); ein gesperrtes Fahrzeug darunter ist ein Tauschfall, kein Werkstattfall.
export const DISABLE_FLOOR = { minAvail: 20, q: 0.01, maxBattery: 35, maxRangeKm: 25 };
export function disableFloor(vehicles) {
  const ok = vehicles.filter(v => !v.disabled && !v.reserved), bat = ok.map(v => v.battery).filter(x => x != null && Number.isFinite(x));
  const rng = ok.filter(v => v.battery == null && rangeUsable(v)).map(v => v.rangeKm);
  const q = (a, cap) => (a.length >= DISABLE_FLOOR.minAvail ? Math.min(cap, quantile(a, DISABLE_FLOOR.q)) : null);
  return { battery: q(bat, DISABLE_FLOOR.maxBattery), rangeKm: q(rng, DISABLE_FLOOR.maxRangeKm) };
}
export function lockedForEnergy(v, floor) {
  if (!v?.disabled || !floor) return false;
  if (v.battery != null) return floor.battery != null && v.battery < floor.battery;
  return rangeUsable(v) && floor.rangeKm != null && v.rangeKm < floor.rangeKm;
}
export function planSwaps({ vehicles, model, depot, ...opts }) {
  const o = /** @type {any} */ ({ ...DEFAULTS, ...opts }); o.swapCapacity = Math.max(1, Math.min(MAX_SWAP, o.swapCapacity));
  const cost = makeCost(o);
  const floor = disableFloor(vehicles);
  const low = vehicles.filter(v => needsSwap(v, o) || lockedForEnergy(v, floor)).map(v => ({ ...v, lockedLow: !!v.disabled }));
  const sphMax = Math.max(0.01, ...[...model.cells.values()].map(c => c.startsPerHour ?? 0));
  for (const v of low) {
    const d = (model.cells.get(cellOf(v.lat, v.lon))?.startsPerHour ?? 0) / sphMax;
    v.priority = +(0.6 * Math.max(0, energyGap(v, o)) + 0.4 * Math.min(1, d) + ((v.idleMin ?? 0) > 360 ? 0.05 : 0)).toFixed(3);
  }
  const chosen = low.sort((a, b) => b.priority - a.priority).slice(0, o.swapCapacity * o.maxRuns);
  // priority (Auswahl, wer überhaupt getauscht wird: Energie + Nachfrage am Ort) bleibt; die Reihenfolge nutzt prio (Energie + Standzeit, PRIO)
  const build = (g, quick) => {
    const stops = groupStops(g, () => 's', 25).map(s => ({ type: 'swap', lat: s.lat, lon: s.lon, count: s.count, battery: s.items.map(x => x.battery), priority: Math.max(...s.items.map(x => x.priority)), ...maxPrio(s.items.map(x => vehiclePrio('swap', x, o))) }));
    const sq = sequenceRun([stops], { depot, cost, lambda: o.prioLambda, quick });
    const r = seqSummary(sq, o);
    const handle = g.length * o.swapMin;
    return { kind: 'swap', vehicles: g.length, stops: sq.stops, ...r, handleMin: Math.round(handle), totalMin: r.driveMin + Math.round(handle) };
  };
  const cap = timeCap(build, o.maxRunMin), { runs: groups, unplanned } = clusterRuns(chosen, o.swapCapacity, depot, o.maxRuns, undefined, cap.fit);
  const runs = groups.map((g, i) => ({ id: `S${i + 1}`, ...cap.built(g) }));
  return { below: low.length, locked: low.filter(v => v.lockedLow).length, floor, chosen: chosen.length, unplanned: unplanned.length + (low.length - chosen.length), limitMin: o.maxRunMin, runs };
}

/** Werkstatt: gesperrte Fahrzeuge einsammeln und zum Depot bringen. */
export function planWorkshop({ vehicles, depot, ...opts }) {
  const o = /** @type {any} */ ({ ...DEFAULTS, ...opts });
  const cost = makeCost(o);
  const floor = disableFloor(vehicles); // gesperrt wegen leerem Akku → Akkutausch (planSwaps), nicht Werkstatt
  const dis = vehicles.filter(v => v.disabled && !lockedForEnergy(v, floor)).sort((a, b) => (b.idleMin ?? 0) - (a.idleMin ?? 0));
  // Priorität = Sperrdauer (Standzeit seit der letzten Bewegung), ab 24 h Zuschlag
  const build = (g, quick) => {
    const stops = groupStops(g, () => 'w', 25).map(s => ({ type: 'pickup_disabled', lat: s.lat, lon: s.lon, count: s.count, idleMaxH: Math.round(Math.max(...s.items.map(x => x.idleMin ?? 0)) / 60), ...maxPrio(s.items.map(x => vehiclePrio('pickup_disabled', x, o))) }));
    const sq = sequenceRun([stops], { depot, cost, lambda: o.prioLambda, quick });
    const r = seqSummary(sq, o);
    const handle = g.length * o.workshopMin;
    return { kind: 'workshop', vehicles: g.length, stops: sq.stops, ...r, handleMin: Math.round(handle), totalMin: r.driveMin + Math.round(handle) };
  };
  const cap = timeCap(build, o.maxRunMin), { runs: groups, unplanned } = clusterRuns(dis, o.workshopCapacity, depot, o.maxRuns, undefined, cap.fit);
  const runs = groups.map((g, i) => ({ id: `W${i + 1}`, ...cap.built(g) }));
  return { disabled: dis.length, lockedLow: vehicles.filter(v => lockedForEnergy(v, floor)).length, unplanned: unplanned.length, limitMin: o.maxRunMin, runs };
}

/**
 * Stationsausgleich (stationsbasiertes Bikesharing): fast leere Stationen aus fast vollen auffüllen.
 * Füllgrad = buchbar / Kapazität (Kapazität fehlt → buchbar + freie Plätze). Ziel ist `fill` (Standard 50 %).
 */
export function planStationBalance({ stations, depot, low = 0.2, high = 0.8, fill = 0.5, ...opts }) {
  const o = /** @type {any} */ ({ ...DEFAULTS, ...opts });
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
  // Priorität: Ausbringen nach Fehlmenge der Station (leer = Zuschlag), Abholen nur dringend, wenn die Station keinen freien Platz mehr hat
  const build = (run, quick) => {
    const g = run.map(x => x.m);
    const pickups = groupStops(g, m => m.from.name || '', 5).map(s => { const f = s.items[0].from, full = f.docks === 0 || f.bookable >= f.cap;
      return { type: 'pickup', lat: s.lat, lon: s.lon, count: s.count, station: f.name, fill: `${f.bookable}/${f.cap}`, prio: full ? PRIO.fullStation : 0, why: { fill: `${f.bookable}/${f.cap}`, full } }; });
    const drops = groupStops(g.map(m => ({ lat: m.to.lat, lon: m.to.lon, to: m.to })), x => x.to.name || '', 5).map(s => { const to = s.items[0].to, need = Math.max(0, Math.max(1, Math.round(to.cap * fill)) - to.bookable), dp = dropPrio(need, to.bookable);
      return { type: 'drop', lat: s.lat, lon: s.lon, count: s.count, station: to.name, fill: `${to.bookable}/${to.cap}`, prio: dp.prio, why: { ...dp.why, fill: `${to.bookable}/${to.cap}` } }; });
    const sq = sequenceRun([pickups, drops], { depot, cost, lambda: o.prioLambda, quick });
    const r = seqSummary(sq, o);
    const handle = g.length * (o.pickupMin + o.dropMin) * 0.6; // an Stationen schneller als frei abgestellt
    return { kind: 'station', vehicles: g.length, stops: sq.stops, ...r, handleMin: Math.round(handle), totalMin: r.driveMin + Math.round(handle) };
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
export function fleetKpis(vehicles, { swapThreshold = DEFAULTS.swapThreshold, swapRangeKm = DEFAULTS.swapRangeKm } = {}) {
  const avail = vehicles.filter(isAvailable);
  const withBat = vehicles.filter(v => (v.battery != null || rangeUsable(v)) && !v.disabled);
  const idleKnown = avail.filter(v => v.idleMin != null), floor = disableFloor(vehicles), locked = vehicles.filter(v => lockedForEnergy(v, floor)).length;
  return {
    total: vehicles.length, available: avail.length, disabled: vehicles.filter(v => v.disabled).length, reserved: vehicles.filter(v => v.reserved).length,
    // low = Tauschfälle insgesamt: verfügbare unter der Schwelle + gesperrte unter der Betriebsgrenze der Quelle (lockedLow)
    low: withBat.filter(v => needsSwap(v, { swapThreshold, swapRangeKm })).length + locked, lockedLow: locked, batteryKnown: withBat.length,
    chargeKnown: withBat.filter(v => v.battery != null).length,
    idle24: idleKnown.filter(v => v.idleMin >= 1440).length, idle6: idleKnown.filter(v => v.idleMin >= 360).length, idleKnown: idleKnown.length,
    idleMedianH: idleKnown.length ? +(quantile(idleKnown.map(v => v.idleMin), 0.5) / 60).toFixed(1) : null,
  };
}

/** Exporte */
// CSV-Zelle mit Formel-Schutz: Text, der mit = + - @ Tab oder Wagenrücklauf beginnt, bekommt ein führendes ' (Tabellenprogramme
// führen ihn sonst als Formel aus); Trennzeichen, Anführungszeichen und Zeilenumbrüche werden gequotet. Zahlen bleiben Zahlen.
// S2.13: Semikolon = deutsche Datei → Dezimalkomma (auch Zahlentext wie „48.123456“ aus toFixed), sonst liest deutsches Excel „1.5“ als 1. Mai.
export function csvCell(v, sep = ';') {
  if (v == null || (typeof v === 'number' && !Number.isFinite(v))) return '';
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') return sep === ';' ? String(v).replace('.', ',') : String(v);
  let t = String(v);
  if (sep === ';' && /^-?\d+\.\d+$/.test(t)) return t.replace('.', ',');
  if (/^[=+\-@\t\r]/.test(t) && !/^[+-]?\d+([.,]\d+)?$/.test(t)) t = `'${t}`; // reine Zahl als Text (z. B. -0.123456) bleibt
  return t.includes(sep) || /["\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}
export const csvRows = (rows, sep = ';') => rows.map(r => r.map(x => csvCell(x, sep)).join(sep)).join('\n');
// Disposition-CSV je Sprache: Deutsch (Standard) mit Semikolon, Englisch (lang 'en') mit Komma und englischen Spaltennamen/Texten.
// Die Spots-CSV im Backend-Format (spotsCsv) ist sprachunabhängig.
const OPS_CSV_EN = { rang: 'rank', starts_je_h_anbieter: 'starts_per_h_operator', enden_je_h_anbieter: 'ends_per_h_operator', netto_abfluss_je_h_anbieter: 'net_outflow_per_h_operator',
  netto_abfluss_fehler_je_h: 'net_outflow_error_per_h', netto_abfluss_untergrenze_je_h: 'net_outflow_lower_bound_per_h', ausgleich_k: 'balance_k', bootstrap_anteil: 'bootstrap_share', starts_markt: 'starts_market', enden_markt: 'ends_market', messstunden: 'measured_hours', horizont_h: 'horizon_h', grundbestand: 'base_stock',
  abfluss_im_horizont: 'outflow_in_horizon', bedarf_rechnerisch: 'need_calculated', bedarf_fzg: 'need_veh', bestand_umkreis: 'fleet_nearby', fehlmenge: 'shortfall', stroeme_ab: 'flows_out', stroeme_an: 'flows_in',
  f_netto_abfluss: 'f_net_outflow', f_nachfrage: 'f_demand', f_oepnv: 'f_transit', f_abstellflaeche: 'f_parking', stabilitaet: 'stability', abstellflaeche: 'parking_area',
  tour: 'run', art: 'type', stopp: 'stop', typ: 'kind', anzahl: 'count', info: 'info', prioritaet: 'priority', prio_rang: 'priority_rank', grund: 'reason', stabil: 'stable', mittel: 'medium', unsicher: 'uncertain',
  anbieter: 'operator', lage: 'location', fahrzeuge_summe: 'vehicles_total', fahrzeuge_mittel: 'vehicles_mean', fahrzeugarten: 'vehicle_types', erstmals: 'first', zuletzt: 'last', arten: 'types', naechster_spot: 'nearest_spot', abstand_m: 'distance_m' };
const opsCsvText = (v, lang) => (lang === 'en' && typeof v === 'string' ? OPS_CSV_EN[v] ?? v : v);
export const opsCsv = (rows, lang = 'de') => (lang === 'en' ? csvRows([rows[0].map(h => opsCsvText(h, lang)), ...rows.slice(1)], ',') : csvRows(rows));
export function spotsCsv(spots, { name = 'Spot', radius = 15 } = {}) {
  const head = ['name', 'lat', 'lng', 'deploymentStatus', 'parkingStatus', 'deploymentRadius', 'deploymentVehicles'];
  const rows = spots.map(s => [`${name} ${String(s.rank).padStart(2, '0')}`, s.lat.toFixed(6), s.lon.toFixed(6), 'enabled', 'disabled', radius, s.target]);
  return csvRows([head, ...rows], ',');
}
// needs: planRebalance(...).needs (Bestand im Umkreis und Fehlmenge je Spot); ohne needs bleiben die Spalten leer
// enden_je_h_anbieter und netto_abfluss_je_h_anbieter ausgeglichen (Enden × ausgleich_k, M-10); enden_markt = gezählte Enden;
// netto_abfluss_untergrenze_je_h = max(0, Abfluss − 2·Fehler) (Faktor der MCDA); bootstrap_anteil = Anteil der Ziehungen in den Top-N
export const SPOTS_ANALYSIS_FIELDS = ['rang', 'lat', 'lng', 'starts_je_h_anbieter', 'enden_je_h_anbieter', 'netto_abfluss_je_h_anbieter', 'netto_abfluss_fehler_je_h', 'netto_abfluss_untergrenze_je_h', 'ausgleich_k', 'starts_markt', 'enden_markt', 'messstunden',
  'horizont_h', 'grundbestand', 'abfluss_im_horizont', 'bedarf_rechnerisch', 'bedarf_fzg', 'bestand_umkreis', 'fehlmenge', 'stroeme_ab', 'stroeme_an',
  'score', 'f_netto_abfluss', 'f_nachfrage', 'f_oepnv', 'f_abstellflaeche', 'stabilitaet', 'bootstrap_anteil', 'abstellflaeche'];
export function spotsAnalysisCsv(spots, needs = null, { horizonH = DEFAULTS.horizonH, prelim = false, lang = 'de' } = {}) {
  const nb = new Map((needs || []).map(n => [n.cell, n]));
  const rows = spots.map(s => { const n = nb.get(s.cell); return [s.rank, s.lat.toFixed(6), s.lon.toFixed(6), s.startsPerHourOp, s.endsPerHourOp, s.outPerHourOp, s.outSeOp, s.outLowOp ?? null, s.balanceK ?? null, s.starts, s.ends, s.hours,
    horizonH, s.base, s.drain, s.needRaw, s.target, n?.have ?? null, n?.need ?? null, s.flow?.out ?? null, s.flow?.in ?? null,
    s.score, s.factors.outflow, s.factors.demand, s.factors.transit ?? null, s.factors.parking ?? null, prelim ? `${lang === 'en' ? 'preliminary' : 'vorläufig'} (${opsCsvText(s.stabilityLabel, lang)})` : opsCsvText(s.stabilityLabel, lang), s.bootShare ?? null, s.park ? `${s.park.cat}${s.park.name ? ' ' + s.park.name : ''}` : '']; });
  return opsCsv([SPOTS_ANALYSIS_FIELDS, ...rows], lang);
}
/** Grund eines Stopps als kurzer Text (wie die Stoppliste der Disposition): Akku/Reichweite, Standzeit, Fehlmenge, leer/voll */
export function stopReason(s, lang = 'de') {
  const w = s?.why || {}, en = lang === 'en', out = [];
  if (s.type === 'swap') { if (w.battery != null) out.push(en ? `battery ${w.battery} %` : `Akku ${w.battery} %`); else if (w.rangeKm != null) out.push(en ? `range ${w.rangeKm} km` : `Reichweite ${w.rangeKm} km`); }
  if (w.idleH != null && s.type !== 'drop' && !s.station) out.push(`${en ? 'idle' : 'steht'} ${idleClassText(w.idleH * 60, { en })}`);
  if (s.type === 'drop') { if (s.station) out.push(w.empty ? (en ? 'station empty' : 'Station leer') : (en ? `shortfall ${w.need}` : `Fehlmenge ${w.need}`)); else if (w.empty) out.push(en ? 'spot empty' : 'Spot leer'); else if (w.need) out.push(en ? `shortfall ${w.need}` : `Fehlmenge ${w.need}`); }
  if (s.type === 'pickup' && s.station && w.full) out.push(en ? 'station full' : 'Station voll');
  return out.join(', ');
}
/** Touren-CSV: je Stopp Reihenfolge, Typ, Lage, Anzahl, Info sowie Priorität (0–1+), Rang der Priorität in der Tour und Grund */
export function runsCsv(runs, depot, lang = 'de') {
  const head = ['tour', 'art', 'stopp', 'typ', 'lat', 'lng', 'anzahl', 'info', 'prioritaet', 'prio_rang', 'grund'];
  const rows = [];
  for (const r of runs) {
    rows.push([r.id, r.kind, 0, 'depot', depot.lat.toFixed(6), depot.lon.toFixed(6), '', `${r.km} km · ${r.totalMin} min`, '', '', '']);
    const en = lang === 'en';
    r.stops.forEach((s, i) => rows.push([r.id, r.kind, i + 1, s.type, s.lat.toFixed(6), s.lon.toFixed(6), s.count, s.type === 'drop' ? (en ? `Spot ${s.spotRank} (need ${s.target}${s.need != null ? `, fleet ${s.have}, shortfall ${s.need}` : ''})` : `Spot ${s.spotRank} (Bedarf ${s.target}${s.need != null ? `, Bestand ${s.have}, Fehlmenge ${s.need}` : ''})`) : s.battery?.length ? `${en ? 'Battery' : 'Akku'} ${s.battery.join('/')} %` : s.idleMaxH != null ? `${en ? 'idle' : 'steht'} ${idleClassText(s.idleMaxH * 60, { en })}` : '',
      s.prio ?? '', s.rank ?? '', stopReason(s, lang)]));
  }
  return opsCsv([head, ...rows], lang);
}
