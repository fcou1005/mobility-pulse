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

// Fortschritt bis „greift“ (27.11.2026): knapperer Teil der Schwelle, Datum aus dem Tempo seit Erfassungsbeginn
{ const P = FC.ctxProgress({ rows: 87, days: 1, memRows: 0, memDays: 0 }, 'ptOut', '2026-11-27'), done = FC.ctxProgress({ rows: 4652, days: 17, memRows: 0, memDays: 0 }, 'works', '2026-11-27');
  const none = FC.ctxProgress({ rows: 0, days: 0, memRows: 0, memDays: 0 }, 'strike', '2026-11-27'), later = FC.ctxProgress(null, 'ptRisk', '2026-11-27');
  const slow = FC.ctxProgress({ rows: 30, days: 3, memRows: 0, memDays: 0 }, 'warn', '2026-11-27', { windowDays: 21 });
  assert(Math.abs(P.share - 0.5) < 1e-9 && P.eta === '2026-11-28' && done.share === 1 && done.eta === '2026-11-27' && none.eta === null && later.from === '2026-11-30' && later.eta === '2026-12-01' && slow.eta === '2027-01-15',
    `ptOut 87/100 Stunden, 1/2 Tagen → 50 %, morgen; Baustellen fertig; Streik ohne Fall ohne Datum; ÖPNV-Prognose ab 30.11. (frühestens 1.12.); 30 Stunden in 21 Tagen → ${slow.eta}`); }
{ const W = FC.wxProgress({ ok: false, tempRangeK: 2.5, rainDays: 3, dryDays: 5, missingShare: 0.1 });
  assert(Math.abs(W.share - 0.5) < 1e-9 && FC.wxProgress({ ok: true }).share === 1 && FC.wxProgress(null) === null, 'Wetter: knappster Teil (Temperaturspanne 2,5 von 5 K) = 50 %'); }

// Semesterferien (semfrei, 27.11.2026): gepflegte Liste mit Beleg je Eintrag; erster Fall = Erfassungsbeginn in FEATURE_SINCE
{ const { readFileSync } = await import('node:fs'), CX = await import('../lib/pulse-context.js'), doc = JSON.parse(readFileSync(new URL('../data/vorlesungszeiten.json', import.meta.url), 'utf8'));
  const chk = CX.checkCurated(doc), first = chk.ok.map(e => e.von).sort()[0], L = CX.ctxLookup([], chk.ok), i = CX.CTX_KEYS.indexOf('semfrei');
  assert(chk.bad.length === 0 && chk.ok.length === doc.ereignisse.length && chk.ok.every(e => /^https:\/\//.test(e.quelle) && e.gebiet.ags.every(a => /^\d{8}$/.test(a))) && first === FC.FEATURE_SINCE.semfrei,
    `Vorlesungszeiten: ${chk.ok.length} Einträge mit Beleg, erster vorlesungsfreier Tag ${first} = FEATURE_SINCE.semfrei ${FC.FEATURE_SINCE.semfrei}`);
  assert(i >= 0 && FC.EFFECTS.includes('semfrei') && L('08416041', '2026-12-24', 10)[i] === 1 && L('08416041', '2026-12-01', 10)[i] === 0 && L('08416041', '2027-03-01', 9)[i] === 1 && L('08415000', '2026-12-24', 10)[i] === 0,
    'semfrei: Tübingen in der Weihnachtspause und den Semesterferien, nicht im Semester, nicht im Nachbarort');
  const P = FC.ctxProgress(null, 'semfrei', '2026-11-27');
  assert(P.share === 0 && P.from === '2026-12-19' && P.eta === '2026-12-20', `Fortschritt semfrei: ab ${P.from}, frühestens ${P.eta}`); }

console.log(`\n${ok} ok, ${bad} Fehler`);
if (bad) process.exit(1);
