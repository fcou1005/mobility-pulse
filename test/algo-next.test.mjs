#!/usr/bin/env node
// Prüfstand für den Kandidaten der Fahrterkennung (lib/pulse-track-next.js, Schattenbetrieb P4): dieselben 17 Szenarien × 3 Kennungsarten wie
// test/algo-bench.test.mjs. Hart: Buchhaltung, Fahrzeugminuten ±1 %, keine Verschlechterung gegen die geltenden Regeln (test/bench/baseline.json),
// Abnahmen der Kandidaten-Regeln (S1.3, S1.4, S1.5, A23), < 60 s. Mit --table: Vergleich geltend → Kandidat als Markdown.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAll, targets, noWorse, assert } from './bench/check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const t0 = Date.now();
const base = JSON.parse(await readFile(path.join(HERE, 'bench', 'baseline.json'), 'utf8'));
const { out, T } = await runAll('pulse-track-next.js');
targets(out, 'Kandidat');
noWorse(out, base, 'Kandidat');
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
if (process.argv.includes('--table')) {
  const ids = Object.keys(out), f = (x) => x == null ? '–' : `${x >= 0 ? '+' : '−'}${Math.abs(100 * x).toFixed(1)}`;
  console.log(['| Fall | Präz. geltend → Kandidat | Δ Fahrten geltend → Kandidat | Beginne/Enden | Wechsel |', '|---|---|---|---|---|',
    ...ids.map(id => `| ${id} | ${P(base[id].precision)} → ${P(out[id].precision)} | ${f(base[id].countErr)} → ${f(out[id].countErr)} | ${base[id].endRatio} → ${out[id].endRatio} | ${base[id].modeFlips} → ${out[id].modeFlips} |`)].join('\n'));
}
console.log(`Kandidat ${T.METHOD_VERSION}`);
const s = (Date.now() - t0) / 1000;
assert(s < 60, `Prüfstand-Laufzeit ${s.toFixed(1)} s < 60 s`);
