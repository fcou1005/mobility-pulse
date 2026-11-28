// @ts-check
// Mobility Pulse — Prognose – Kombination aller Modelle (Kandidat „ens“, 21.11.2026). Gewünscht: ein Modell, das alle anderen zusammenführt.
// Fünf Basismodelle (ENS.bases) gehen mit Gewichten je Gruppe (Gemeinde|Anbieter|Art) in eine Mischung; die Gewichte sind nicht negativ und summieren
// sich zu 1, die Mischung liegt also immer zwischen den Basismodellen und kann nie weiter danebenliegen als das schlechteste.
// Gelernt wird wie bei adaptive und blend aus der Selbstprüfung (Rolling Origin, erst bewertet, dann übernommen, Halbwertszeit 7 Tage), aber nicht
// nach dem Fehler jedes Modells einzeln (Bates–Granger), sondern als beste Mischung über die Quadratsumme der Fehler (Stacking unter Nebenbedingung).
// Darin steckt die Ähnlichkeit der Modelle: Profil, gepoolt, gepoolt mit Wetter und Hybrid liegen oft gemeinsam daneben; einzeln gewichtet bekämen sie
// zusammen zu viel Gewicht, in der Mischung teilen sie es sich, und ein Modell, das anders danebenliegt (Chronos-2), bekommt den Anteil, der die Fehler
// am meisten ausgleicht. Wenig eigene Erfahrung einer Gruppe → Gewichte ihrer Fahrzeugart, wenig Erfahrung der Art → Gewichte aller Gruppen
// (Schrumpfung über kGroup bzw. kType Pseudo-Fahrtbeginne). Je Gruppe gespeichert sind nur Starts, Fehler-Quadratsumme, Produkt mit dem Ist und die
// Quadratsummen je Modell; die Zusammenhänge zwischen den Modellen kommen aus ihrer Fahrzeugart (dort genug Daten, log.json bleibt klein).
// Rückblick auf die echten Tage 12.–20.11.2026 (Selbstprüfung, je Gruppe und Stunde): eigene Gewichte je Gruppe lagen schlechter als die ihrer Fahrzeugart
// (kGroup 50: 16,0 %, 2.000: 15,8 %, 10.000: 15,7 %; je Gemeinde und Art 15,8 %, je Art und Tageszeit 15,8 %, „wie gestern“ als sechstes Modell bekam
// kein Gewicht). Darum zählen eigene Gewichte erst für Gruppen mit sehr viel Erfahrung (kGroup 10.000 Starts), Gruppen unter minGroupY Starts im
// Lernstand werden nicht aufgehoben. Seit v 2 lernt sie Zeilen ohne Chronos getrennt (siehe ensBases): 15,5 %; Halbwertszeit 4, 14 oder 30 statt 7 Tage
// ohne Unterschied. Zum Vergleich: adaptive 16,4 %, blend 16,2 %, Chronos 15,9 %, mittel 16,5 %.
// Zur Kontrolle läuft „mittel“ mit (alle fünf gleich gewichtet, nie wählbar): schlägt die gelernte Mischung das einfache Mittel nicht, lernt sie nichts.
// Wählbar erst ab ENS.activeFrom (Ende der Lernphase) und dann wie Chronos und blend nur mit geprüftem Vorsprung (DM-Test, siehe DM).
export const ENS = Object.freeze({ v: 2, bases: ['profile', 'pooled', 'pooledWx', 'hybrid', 'chronos'], halfLifeDays: 7, kGroup: 10000, kType: 500, minGroupY: 300, ridge: 1e-4, activeFrom: Date.parse('2026-11-28T10:00:00+01:00') });
/** Kandidaten der Kombination: ens (gelernt, ab activeFrom wählbar) und mittel (gleich gewichtet, nur Vergleich) */
export const ENSEMBLE = ['ens', 'mittel', 'klassik'];
const K = ENS.bases.length, NA = (K * (K + 1)) / 2, NF = 2 + K + NA, NG = 2 + 2 * K, FULL = (1 << K) - 1, CHR = 1 << (K - 1), REST = FULL & ~CHR;
/** Gleiche Gewichte über die erlaubten Modelle (Bit k = ENS.bases[k]) */
const equalW = (/** @type {number} */ allow) => { let m = 0; for (let i = 0; i < K; i++) if (allow & (1 << i)) m++; return Array.from({ length: K }, (_, i) => (allow & (1 << i) ? 1 / m : 0)); };
/** Stelle von A[i][j] im oberen Dreieck */
const ai = (/** @type {number} */ i, /** @type {number} */ j) => { const a = Math.min(i, j), b = Math.max(i, j); return a * K - (a * (a - 1)) / 2 + (b - a); };
const typeOf = (/** @type {string} */ key) => String(key).split('|')[2] || 'other';
const dayGap = (/** @type {string} */ a, /** @type {string} */ b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400e3);

/** Leerer Lernstand: all/types[Art] = [Starts, Σ y², Σ x_k·y (K), Σ x_i·x_j (oberes Dreieck)], groups[key] = [Starts, Σ y², Σ x_k·y (K), Σ x_k² (K)];
 *  allR/typesR wie all/types aus Zeilen, in denen nur Chronos fehlt (Chronos-Stellen bleiben 0) – Gewichte ohne Chronos lernen so aus allen Zeilen */
export const emptyEns = () => ({ v: ENS.v, upto: /** @type {string | null} */ (null), days: 0, all: new Array(NF).fill(0), types: /** @type {Record<string, number[]>} */ ({}), groups: /** @type {Record<string, number[]>} */ ({}),
  allR: new Array(NF).fill(0), typesR: /** @type {Record<string, number[]>} */ ({}) });
/** Lernstand aus log.json übernehmen (Kopie) oder null, wenn er fehlt oder eine andere Fassung hat */
export function loadEns(/** @type {any} */ p) {
  if (p?.v !== ENS.v || !Array.isArray(p.all) || p.all.length !== NF) return null;
  const cp = (/** @type {Record<string, number[]>} */ o) => Object.fromEntries(Object.entries(o || {}).map(([k, s]) => [k, [...s]]));
  return { v: ENS.v, upto: p.upto ?? null, days: p.days || 0, all: [...p.all], types: cp(p.types), groups: cp(p.groups), allR: p.allR?.length === NF ? [...p.allR] : new Array(NF).fill(0), typesR: cp(p.typesR) };
}
/** Lernstand für log.json: auf 0,1 gerundet */
export const compactEns = (/** @type {ReturnType<typeof emptyEns>} */ st) => {
  const r = (/** @type {number[]} */ s) => s.map(x => Math.round(x * 10) / 10);
  const ro = (/** @type {Record<string, number[]>} */ o) => Object.fromEntries(Object.entries(o).map(([k, s]) => [k, r(s)]));
  return { v: st.v, upto: st.upto, days: +st.days.toFixed(2), all: r(st.all), types: ro(st.types), groups: ro(st.groups), allR: r(st.allR), typesR: ro(st.typesR) };
};

/**
 * Basismodelle als Spalten (Reihenfolge ENS.bases) mit Ersatz, wo eines fehlt: Profil ohne eigene Historie → gepoolt mit Umgebung, gepoolt mit
 * Umgebung ohne Umgebung → gepoolt, Chronos ohne Wert → Hybrid. Dazu ok[j]: welche Modelle in Zeile j echte Werte haben (Bit k = ENS.bases[k]).
 * Der Ersatz bekommt nie unter fremdem Namen Gewicht: fehlt ein Modell, mischt die Zeile nur die vorhandenen (eigene Lösung ohne das fehlende).
 * Rückblick: ein Tag ohne Chronos-Rückschau, als Hybrid gelernt, kostete 0,4 Punkte.
 * @param {{ muP: ArrayLike<number>, mu1: ArrayLike<number>, muQ?: ArrayLike<number> | null, muH: ArrayLike<number>, muC?: ArrayLike<number> | null }} m
 * @returns {Float64Array[] & { ok: Uint8Array }}
 */
export function ensBases({ muP, mu1, muQ = null, muH, muC = null }) {
  const n = mu1.length, q = muQ || mu1, fin = (/** @type {number} */ x) => Number.isFinite(x), ok = new Uint8Array(n);
  for (let j = 0; j < n; j++) ok[j] = (fin(muP[j]) ? 1 : 0) | 2 | (muQ ? 4 : 0) | 8 | (muC && fin(muC[j]) ? 16 : 0); // Reihenfolge wie ENS.bases
  return Object.assign([Float64Array.from({ length: n }, (_, j) => (fin(muP[j]) ? muP[j] : q[j])), Float64Array.from(mu1), Float64Array.from(q), Float64Array.from(muH),
    Float64Array.from({ length: n }, (_, j) => (muC && fin(muC[j]) ? muC[j] : muH[j]))], { ok });
}

/**
 * Lernstand um einen bewerteten Tag fortschreiben: erst altern (Halbwertszeit), dann je Zeile j (Gruppe keyOf(j), Ist y[j], Spalten X) aufsummieren.
 * Zeilen mit allen Modellen gehen in all/types/groups, Zeilen, in denen nur Chronos fehlt, in allR/typesR (ohne Chronos-Stellen); übrige nicht.
 * @param {ReturnType<typeof emptyEns>} st @param {string} day @param {(j: number) => string} keyOf @param {ArrayLike<number>} y @param {Float64Array[] & { ok?: Uint8Array }} X
 */
export function ensUpdate(st, day, keyOf, y, X) {
  if (st.upto) {
    const f = 0.5 ** (Math.max(0, dayGap(st.upto, day)) / ENS.halfLifeDays); st.days *= f;
    for (let i = 0; i < NF; i++) st.all[i] *= f;
    for (const s of Object.values(st.types)) for (let i = 0; i < s.length; i++) s[i] *= f;
    for (const s of Object.values(st.groups)) for (let i = 0; i < s.length; i++) s[i] *= f;
    for (let i = 0; i < NF; i++) st.allR[i] *= f;
    for (const s of Object.values(st.typesR)) for (let i = 0; i < s.length; i++) s[i] *= f;
  }
  const add = (/** @type {number[]} */ F, /** @type {number} */ j, /** @type {number} */ yy, kk = K) => { F[0] += yy; F[1] += yy * yy; for (let a = 0; a < kk; a++) { F[2 + a] += X[a][j] * yy; for (let b = a; b < kk; b++) F[2 + K + ai(a, b)] += X[a][j] * X[b][j]; } };
  let added = 0;
  for (let j = 0; j < y.length; j++) {
    const yy = y[j], ok = X.ok ? X.ok[j] : FULL; if (!Number.isFinite(yy) || (ok !== FULL && ok !== REST) || X.some(c => !Number.isFinite(c[j]))) continue;
    const key = keyOf(j), ty = typeOf(key); added++;
    if (ok === REST) { add(st.allR, j, yy, K - 1); add(st.typesR[ty] ||= new Array(NF).fill(0), j, yy, K - 1); continue; }
    add(st.all, j, yy); add(st.types[ty] ||= new Array(NF).fill(0), j, yy);
    const g = (st.groups[key] ||= new Array(NG).fill(0)); g[0] += yy; g[1] += yy * yy; for (let a = 0; a < K; a++) { g[2 + a] += X[a][j] * yy; g[2 + K + a] += X[a][j] * X[a][j]; }
  }
  // kleine Gruppen nicht aufheben: ihre eigenen Gewichte zählten neben kGroup kaum (unter minGroupY ÷ (minGroupY + kGroup)), log.json bleibt klein
  for (const [k, g] of Object.entries(st.groups)) if (g[0] < ENS.minGroupY) delete st.groups[k];
  st.upto = day; if (added) st.days += 1;
  return st;
}

/** F + c · G (gleich lange Statistiken) */
const plus = (/** @type {number[]} */ F, /** @type {number[]} */ G, /** @type {number} */ c) => F.map((x, i) => x + c * (G[i] || 0));
/** Gruppen-Statistik (nur Quadratsummen je Modell) zur vollen: Zusammenhänge zwischen den Modellen aus der Fahrzeugart T */
function fullOf(/** @type {number[]} */ g, /** @type {number[]} */ T) {
  const F = new Array(NF).fill(0); F[0] = g[0]; F[1] = g[1]; for (let a = 0; a < K; a++) F[2 + a] = g[2 + a];
  for (let a = 0; a < K; a++) for (let b = a; b < K; b++) {
    const ta = T[2 + K + ai(a, a)], tb = T[2 + K + ai(b, b)], c = a === b ? 1 : ta > 0 && tb > 0 ? T[2 + K + ai(a, b)] / Math.sqrt(ta * tb) : 0;
    F[2 + K + ai(a, b)] = c * Math.sqrt(g[2 + K + a] * g[2 + K + b]);
  }
  return F;
}
/** Lineares Gleichungssystem (Gauß mit Spaltenpivot), null bei Singularität */
function solveLin(/** @type {number[][]} */ M, /** @type {number[]} */ v) {
  const n = v.length, A = M.map((r, i) => [...r, v[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (!(Math.abs(A[p][c]) > 1e-12)) return null; [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < n; r++) { if (r === c) continue; const f = A[r][c] / A[c][c]; if (f) for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k]; }
  }
  return A.map((r, i) => r[n] / r[i]);
}
/**
 * Beste Mischung zu einer Statistik F: minimiert Σ (y − Σ w_k x_k)² unter w ≥ 0, Σ w = 1 (alle Teilmengen der erlaubten Modelle durchprobiert, je
 * Teilmenge Lagrange mit Gleichung Σ w = 1; kleine Ridge auf der Diagonale gegen gleiche Spalten). Ohne Daten: alle erlaubten gleich.
 * @param {number[]} F @param {number} [allow] erlaubte Modelle (Bitmaske, Standard alle) @returns {number[]}
 */
export function solveSimplex(F, allow = FULL) {
  if (!(allow & FULL)) allow = FULL;
  if (!(F[0] > 0)) return equalW(allow);
  const A = Array.from({ length: K }, (_, a) => Array.from({ length: K }, (_, b) => F[2 + K + ai(a, b)])), b = F.slice(2, 2 + K);
  const tr = A.reduce((s, r, i) => s + r[i], 0) / K; for (let i = 0; i < K; i++) A[i][i] += ENS.ridge * tr + 1e-9;
  const obj = (/** @type {number[]} */ w) => { let s = 0; for (let i = 0; i < K; i++) { s -= 2 * b[i] * w[i]; for (let j = 0; j < K; j++) s += w[i] * A[i][j] * w[j]; } return s; };
  let best = null, bestF = Infinity;
  for (let mask = 1; mask < 1 << K; mask++) {
    if (mask & ~allow) continue; const S = []; for (let i = 0; i < K; i++) if (mask & (1 << i)) S.push(i);
    const m = S.length, M = Array.from({ length: m + 1 }, (_, r) => Array.from({ length: m + 1 }, (_, c) => (r < m && c < m ? 2 * A[S[r]][S[c]] : r === m && c === m ? 0 : 1)));
    const x = solveLin(M, [...S.map(i => 2 * b[i]), 1]); if (!x || x.slice(0, m).some(v => v < -1e-9)) continue;
    const w = new Array(K).fill(0); S.forEach((i, r) => { w[i] = Math.max(0, x[r]); }); const t = w.reduce((s, v) => s + v, 0); if (!(t > 0)) continue; for (let i = 0; i < K; i++) w[i] /= t;
    const f = obj(w); if (f < bestF - 1e-12) { bestF = f; best = w; }
  }
  return best || equalW(allow);
}
/**
 * Gewichte aus dem Lernstand: of(key, allow) → Gewichte (Reihenfolge ENS.bases, nur über die erlaubten Modelle); Gruppe zur Fahrzeugart, Fahrzeugart
 * zu allen geschrumpft. Ohne Chronos zählen auch die Zeilen, in denen nur Chronos fehlte (allR/typesR). Mit Zwischenspeicher.
 * @param {ReturnType<typeof emptyEns> | null} st
 */
export function ensWeights(st) {
  const allF = st?.all || new Array(NF).fill(0), allC = st?.allR ? plus(allF, st.allR, 1) : allF, cache = new Map();
  /** @type {Map<string, { F: number[], sub: Map<number, number[]> }>} */ const T = new Map();
  const typeStat = (/** @type {string} */ ty, /** @type {boolean} */ r) => {
    const tk = r ? `${ty}#r` : ty, hit = T.get(tk); if (hit) return hit;
    const all = r ? allC : allF, s0 = st?.types?.[ty], sR = r ? st?.typesR?.[ty] : null, s = sR ? (s0 ? plus(s0, sR, 1) : sR) : s0;
    const t = { F: s && all[0] > 0 ? plus(s, all, ENS.kType / all[0]) : s || all, sub: new Map() }; T.set(tk, t); return t;
  };
  const typeW = (/** @type {ReturnType<typeof typeStat>} */ t, /** @type {number} */ allow) => { let w = t.sub.get(allow); if (!w) t.sub.set(allow, w = solveSimplex(t.F, allow)); return w; };
  return { all: solveSimplex(allF), allNoC: solveSimplex(allC, REST), type: (/** @type {string} */ ty, allow = FULL) => typeW(typeStat(ty, !(allow & CHR)), allow),
    of(/** @type {string} */ key, allow = FULL) {
      const ck = allow === FULL ? key : `${key}#${allow}`; let w = cache.get(ck); if (w) return w;
      const t = typeStat(typeOf(key), !(allow & CHR)), g = st?.groups?.[key];
      w = g && g[0] > 0 && t.F[0] > 0 ? solveSimplex(plus(fullOf(g, t.F), t.F, ENS.kGroup / t.F[0]), allow) : typeW(t, allow); cache.set(ck, w); return w;
    } };
}
/** Mischung je Zeile: Σ w_k · X_k (Gewichte der Gruppe keyOf(j), nur über die Modelle mit echtem Wert X.ok[j]) */
export function predictEns(/** @type {Float64Array[] & { ok?: Uint8Array }} */ X, /** @type {(j: number) => string} */ keyOf, /** @type {ReturnType<typeof ensWeights>} */ W) {
  return Float64Array.from(X[0], (_, j) => { const w = W.of(keyOf(j), X.ok ? X.ok[j] : FULL); let s = 0; for (let k = 0; k < K; k++) s += w[k] * X[k][j]; return s; });
}
/**
 * Kombination ohne KI „klassik“ (28.11.2026, Felix: die Prognose soll auch ohne KI-Schnittstelle so gut wie möglich laufen): dieselben gelernten
 * Gewichte wie ens, aber nur über die vier klassischen Modelle (Chronos nie, Gewichte wie für Zeilen ohne Chronos), dazu das Niveau des Vortags je
 * Fahrzeugart: × ((Starts + k) ÷ (erwartet + k))^beta aus der Wertung der Kombination ohne Niveau („ensK“) am Vortag. Rückblick 21.–27.11.2026
 * (Selbstprüfung offline, Mittel aus Gruppe-Tag und Gruppe-Stunde): ohne KI 15,90 → mit Niveau 15,22; ens mit Chronos 13,73, Chronos allein 13,89.
 * Niveau je Stadt 15,27, je Gruppe 15,30, global 15,27; beta 1 oder 2–3 Vortage nicht besser. Bei Chronos und ens schadet das Niveau
 * (Chronos 13,63 → 14,04): Chronos kennt die letzten Tage schon. Vorwoche und „wie gestern“ als weitere Basismodelle: 15,74, nicht genommen.
 */
export const KLASSIK = Object.freeze({ beta: 0.5, k: 50 });
/** Basismodelle ohne Chronos (Bit für Chronos gelöscht: Gewichte wie für Zeilen ohne Chronos) */
export const ensRest = (/** @type {Float64Array[] & { ok?: Uint8Array }} */ X) => Object.assign([...X], { ok: Uint8Array.from(X.ok || new Uint8Array(X[0].length).fill(FULL), (o) => o & ~CHR) });
/** Niveau je Fahrzeugart aus scoreDay byType des Vortags ([Gruppe-Tag, Gruppe-Stunde, Starts, erwartet]) */
export function klassikLevel(/** @type {Record<string, number[]> | null | undefined} */ byType, o = KLASSIK) {
  const m = new Map(); for (const [ty, a] of Object.entries(byType || {})) if (Array.isArray(a) && a[2] >= 0 && a[3] >= 0) m.set(ty, ((a[2] + o.k) / (a[3] + o.k)) ** o.beta);
  return m;
}
/** Mischung × Niveau der Fahrzeugart der Zeile (ohne Eintrag 1) */
export const applyLevel = (/** @type {ArrayLike<number>} */ mu, /** @type {(j: number) => string} */ keyOf, /** @type {Map<string, number> | null} */ lv) => Float64Array.from(mu, (x, j) => x * (lv?.get(typeOf(keyOf(j))) ?? 1));
/** Kontrolle: alle Basismodelle mit echtem Wert gleich gewichtet */
export const predictMean = (/** @type {Float64Array[] & { ok?: Uint8Array }} */ X) => Float64Array.from(X[0], (_, j) => { const w = equalW(X.ok ? X.ok[j] : FULL); let s = 0; for (let k = 0; k < K; k++) s += w[k] * X[k][j]; return s; });

/** Was die Kombination gelernt hat (Anzeige): Gewichte aller Gruppen und je Art, Anteil der Starts in Gruppen mit eigenen Gewichten (ab 30 Starts) */
export function ensSummary(/** @type {ReturnType<typeof emptyEns> | null} */ st) {
  if (!st?.upto) return null;
  // ohne Zeilen mit Chronos (Familie ohne Chronos, Ausfall): die Gewichte, die dann gelten (ohne Chronos)
  const W = ensWeights(st), named = (/** @type {number[]} */ w) => Object.fromEntries(ENS.bases.map((b, i) => [b, +w[i].toFixed(3)])), noC = !(st.all[0] > 0);
  const G = Object.entries(st.groups), Y = G.reduce((s, [, g]) => s + g[0], 0), own = G.filter(([, g]) => g[0] >= 30);
  // wie weit die Gruppen von den Gewichten aller abweichen: mittlere absolute Abweichung, nach Starts gewichtet
  const dev = own.length ? own.reduce((s, [k, g]) => { const w = W.of(k); return s + g[0] * w.reduce((a, x, i) => a + Math.abs(x - W.all[i]), 0) / 2; }, 0) / own.reduce((s, [, g]) => s + g[0], 0) : null;
  return { upto: st.upto, days: +st.days.toFixed(1), bases: ENS.bases, all: named(noC ? W.allNoC : W.all), ...(noC ? { withoutChronos: true } : {}),
    types: Object.fromEntries([...new Set([...Object.keys(st.types), ...Object.keys(st.typesR)])].sort().map(t => [t, named(W.type(t, st.types[t]?.[0] > 0 ? FULL : REST))])),
    groups: G.length, own: own.length, ownShare: Y > 0 ? +(own.reduce((s, [, g]) => s + g[0], 0) / Y).toFixed(3) : 0, spread: dev == null ? null : +dev.toFixed(3), activeFrom: new Date(ENS.activeFrom).toISOString() };
}
