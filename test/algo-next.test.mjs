#!/usr/bin/env node
// Prüfstand für den Kandidaten der Fahrterkennung (lib/pulse-track-next.js, Schattenbetrieb P4): dieselben 19 Szenarien × 3 Kennungsarten wie
// test/algo-bench.test.mjs. Hart: Buchhaltung, Fahrzeugminuten ±1 %, keine Verschlechterung gegen die geltenden Regeln (test/bench/baseline.json),
// Abnahmen der Kandidaten-Regeln (S1.3, S1.4, S1.5, A23), < 60 s. Mit --table: Vergleich geltend → Kandidat als Markdown.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAll, targets, noWorse, assert, SLOW } from './bench/check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const t0 = Date.now();
const base = JSON.parse(await readFile(path.join(HERE, 'bench', 'baseline.json'), 'utf8'));
const { out, T } = await runAll('pulse-track-next.js');
targets(out, 'Kandidat');
// alles/*: die geschätzte Lücke (A22) holt Fahrten zurück, die bisher die Fehlalarme aus Umsetzung und Akkudienst ausglichen – die Zahl
// liegt dadurch weiter weg, Präzision und Trefferquote steigen (beide hart geprüft)
// station-wechsel/trip: geltend zählt jede Kennung als Fahrt (Präzision 16 %, Treffer 99 %) – dort prüft A2 unten
noWorse(out, base, 'Kandidat', { skipCount: new Set(['alles/stable', 'alles/trip', 'alles/run']), skip: new Set(['station-wechsel/trip']) });
const P = (x) => (100 * x).toFixed(1);
// S1.4: Räder ohne Akku, 10 % Kennungswechsel am Ort je Lauf → keine Scheinfahrten (geltend: Präzision 16 %, Fahrten × 6)
const rw = out['rad-wechsel/trip'];
assert(!rw.fpWhy['Kennungswechsel am Ort'] && rw.precision >= 0.97, `S1.4: rad-wechsel/trip ohne Scheinfahrten (Präzision ${P(rw.precision)} %, geltend ${P(base['rad-wechsel/trip'].precision)} %)`);
// S1.5: stabile Kennungen – Rückkehr nach Abholung/Ausblendung/Sperre ist kein Fahrtende → Beginne ÷ Enden 0,97–1,03
for (const sc of ['basis', 'akku', 'umsetzung', 'res-sperre', 'ausblendung', 'sommerzeit']) {
  const r = out[`${sc}/stable`].endRatio;
  assert(r >= 0.97 && r <= 1.03, `S1.5: ${sc}/stable Beginne ÷ Enden ${r.toFixed(3)} in 0,97–1,03 (geltend ${base[`${sc}/stable`].endRatio.toFixed(3)})`);
}
// S1.3: höchstens ein Moduswechsel je Fall (der erste von „unbekannt“ auf den Modus)
assert(Object.values(out).every(o => o.modeFlips <= 1), `S1.3: höchstens 1 Moduswechsel je Fall (geltend bis ${Math.max(...Object.entries(base).filter(([k]) => !k.startsWith('_')).map(([, o]) => o.modeFlips))})`);
// A23: kleine Flotten mit stabilen Kennungen zählen wie große (bisher −31,5 % bei 50, −40,6 % bei 25 Fahrzeugen)
for (const sc of ['klein50', 'klein25']) {
  const o = out[`${sc}/stable`], b = out['basis/stable'];
  assert(Math.abs(o.countErr) <= Math.abs(b.countErr) + 0.02 && o.modeFlips <= 1, `A23: ${sc}/stable Fahrtenzahl ${P(o.countErr)} % (Basisszenario ${P(b.countErr)} %, geltend ${P(base[`${sc}/stable`].countErr)} %)`);
}
// S1.9 Teilausfall: 25 % der Fahrzeuge fehlen in einem Lauf → keine Scheinfahrten (geltend +12 %, Präzision 85 %)
for (const m of ['stable', 'trip', 'run']) { const o = out[`teilausfall/${m}`], b = out[`basis/${m}`];
  assert(o.precision >= 0.97 && Math.abs(o.countErr) <= Math.abs(b.countErr) + 0.02, `S1.9: teilausfall/${m} Präzision ${P(o.precision)} %, Fahrtenzahl ${P(o.countErr)} % (geltend ${P(base[`teilausfall/${m}`].countErr)} %)`); }
// A2: Kennungswechsel an Stationen (Räder ohne Akku, 10 % je Lauf) ohne Fahrtenflut; normale Stationssysteme unverändert
{ const o = out['station-wechsel/trip'], n = out['stationen/trip'];
  assert(o.precision >= 0.9 && Math.abs(o.countErr) <= 0.2 && Math.abs(n.countErr) <= Math.abs(base['stationen/trip'].countErr) + 0.01, `A2: station-wechsel/trip Präzision ${P(o.precision)} %, Fahrten ${P(o.countErr)} % (geltend ${P(base['station-wechsel/trip'].countErr)} %); stationen/trip ${P(n.countErr)} %`); }
// A4/A21: Umsetzungen nachts als Gruppe erkannt (Rest: tagsüber verstreut eingesammelt, nur mit echten Rohständen P3 sicher trennbar)
for (const m of ['stable', 'trip', 'run']) { const o = out[`umsetzung/${m}`];
  assert(o.vanAsTrip <= base[`umsetzung/${m}`].vanAsTrip - 0.2 && o.recall >= base[`umsetzung/${m}`].recall - 0.005, `A4/A21: umsetzung/${m} Umsetzung als Fahrt ${P(o.vanAsTrip)} % (geltend ${P(base[`umsetzung/${m}`].vanAsTrip)} %)`); }
// A22: Lücken von 65 und 90 Min. kosten höchstens noch so viel wie der Grundfall (bisher −20 %)
for (const m of ['stable', 'trip', 'run']) { const o = out[`luecken/${m}`], b = out[`basis/${m}`];
  assert(Math.abs(o.countErr) <= Math.abs(b.countErr) + 0.01 && o.precision >= 0.99, `A22: luecken/${m} Fahrten ${P(o.countErr)} % (geltend ${P(base[`luecken/${m}`].countErr)} %)`); }
// A3: Fahrtdauer als Intervallschätzung (Lognormal-ML) statt Laufabstand – geltend misst +119 % (19 statt 8,7 Min.)
{ const SIM = await import('./bench/sim.mjs'), E = await import('../lib/pulse-econ.js'), TN = await import('../lib/pulse-track-next.js');
  for (const sc of ['basis', 'alles']) {
    const w = SIM.simulate({ ...SIM.SCENARIOS[sc], seed: 1 }); let st = null; const spans = {};
    for (let k = 0; k < w.runs.length; k++) { const at = w.runs[k].at, r = TN.trackRun(st, { vehicles: await SIM.vehiclesOf(SIM.freeBikeStatus(w, 'stable', k), at), stations: [], sourceRecs: SIM.sourceRecsOf(w, k), now: at }); st = r.state; if (r.day === w.cfg.day) for (const [kk, n] of Object.entries(r.durSpans?.scooter || {})) spans[kk] = (spans[kk] || 0) + n; }
    const est = E.durationFromSpans(spans), tr = w.truth.trips.filter(t => t.te >= w.dayStart && t.te < w.dayEnd), tm = tr.reduce((a, t) => a + t.durMin, 0) / tr.length;
    assert(est && est.mean >= 6 && est.mean <= 10 && Math.abs(est.mean - tm) <= 1.5, `A3: ${sc}/stable Ø Dauer geschätzt ${est?.mean.toFixed(1)} Min. (Wahrheit ${tm.toFixed(1)}, geltend ${(tm * (1 + base[`${sc}/stable`].durErr)).toFixed(1)})`);
  } }
if (process.argv.includes('--table')) {
  const ids = Object.keys(out), f = (x) => x == null ? '–' : `${x >= 0 ? '+' : '−'}${Math.abs(100 * x).toFixed(1)}`;
  console.log(['| Fall | Präz. geltend → Kandidat | Δ Fahrten geltend → Kandidat | Beginne/Enden | Wechsel |', '|---|---|---|---|---|',
    ...ids.map(id => `| ${id} | ${P(base[id].precision)} → ${P(out[id].precision)} | ${f(base[id].countErr)} → ${f(out[id].countErr)} | ${base[id].endRatio} → ${out[id].endRatio} | ${base[id].modeFlips} → ${out[id].modeFlips} |`)].join('\n'));
}
console.log(`Kandidat ${T.METHOD_VERSION}`);
const s = (Date.now() - t0) / 1000;
assert(s < 90 * SLOW, `Prüfstand-Laufzeit ${s.toFixed(1)} s < ${(90 * SLOW).toFixed(0)} s (19 Szenarien × 3 Kennungsarten; P1 sah 60 s für 9 vor)`);
