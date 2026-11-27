// Einflüsse für Modelle ohne eigene Umgebung (Chronos, 27.11.2026): Faktor gegenüber den letzten Tagen derselben Gruppe und Stunde
import * as FC from '../lib/pulse-forecast.js';
let ok = 0, bad = 0;
const assert = (c, m) => { if (!c) { bad++; console.error('FEHLER:', m); } else { ok++; console.log('ok:', m); } };

const K = FC.CTX_KEYS, iW = K.indexOf('warn'), iB = K.indexOf('works'), NW = FC.NW;
// Training: Gruppe 0, 9 Uhr, Tage 0–9; Baustelle in allen Tagen der letzten Woche, Warnung nie
const n = 10, R = { g: new Int32Array(n), hr: new Int8Array(n).fill(9), day: Int32Array.from({ length: n }, (_, i) => i), c: K.map(() => new Int8Array(n)), w: Array.from({ length: NW }, () => new Float64Array(n)), hasW: new Int8Array(n) };
for (let i = 3; i < n; i++) R.c[iB][i] = 1;
const beta = new Float64Array(FC.P); beta[FC.I_CTX + iW] = Math.log(0.6); beta[FC.I_CTX + iB] = Math.log(0.8);
const m = { beta, ctx: [iW, iB], weather: false };
// Zukunft: Gruppe 0 mit Warnung und Baustelle, Gruppe 0 ohne beides, Gruppe 1 (ohne Vorgeschichte) mit Warnung
const F = { g: Int32Array.from([0, 0, 1]), hr: Int8Array.from([9, 9, 9]), c: K.map(() => new Int8Array(3)), w: Array.from({ length: NW }, () => new Float64Array(3)), hasW: new Int8Array(3) };
F.c[iW][0] = 1; F.c[iB][0] = 1; F.c[iW][2] = 1;
const all = Array.from({ length: n }, (_, i) => i), f = FC.envRelFactor(m, R, all, n, F, [0, 1, 2]);
assert(f && Math.abs(f[0] - 0.6) < 1e-9 && Math.abs(f[1] - 1.25) < 1e-9 && Math.abs(f[2] - 0.6) < 1e-9,
  `Warnung wirkt ×0,6; die Baustelle stand schon die ganze Woche (zählt nicht doppelt), ihr Ende hebt ×1,25; ohne Vorgeschichte voller Faktor (${f && [...f].map(x => x.toFixed(3))})`);
const big = FC.envRelFactor({ beta: Float64Array.from(beta, (x, k) => (k === FC.I_CTX + iW ? 3 : x)), ctx: [iW], weather: false }, R, all, n, F, [0]);
assert(big?.[0] === FC.ENV_REL.max && FC.envRelFactor({ beta, ctx: [], weather: false }, R, all, n, F, [0]) === null, `Faktor begrenzt auf ${FC.ENV_REL.min}–${FC.ENV_REL.max}; ohne eingeschaltete Einflüsse keiner`);

console.log(`\n${ok} ok, ${bad} Fehler`);
if (bad) process.exit(1);
