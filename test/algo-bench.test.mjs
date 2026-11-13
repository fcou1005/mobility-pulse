#!/usr/bin/env node
// Prüfstand der Fahrterkennung (P1, Tab „Algorithmen“): simulierte GBFS-Stände mit bekannter Wahrheit (test/bench/sim.mjs) durch die
// geltenden Regeln (lib/pulse-track.js, trackRun mit trace-Rückruf). 17 Szenarien × 3 Kennungsarten, Seed 1.
// Hart: trace ändert nichts, Buchhaltung, Lückenregel, Fahrzeugminuten ±1 %, keine Verschlechterung gegen test/bench/baseline.json, < 60 s.
// Weich (Hinweis): Zielgrenzen einer neuen Regelversion. Neue Basis nach einem bewussten Regelwechsel: node test/algo-bench.test.mjs --write-baseline
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAll, targets, noWorse, assert, note, table } from './bench/check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const baseFile = path.join(HERE, 'bench', 'baseline.json');
const t0 = Date.now();
const { out, rows, T } = await runAll('pulse-track.js');
const base = existsSync(baseFile) ? JSON.parse(await readFile(baseFile, 'utf8')) : null;

// Lückenregel: Läufe nach mehr als 45 Minuten Pause zählen nichts, 40 Minuten zählen
for (const m of ['stable', 'trip', 'run']) assert(out[`luecken/${m}`].gapRuns === 2 && !out[`luecken/${m}`].fnWhy.sonst, `luecken/${m}: genau 2 Lückenläufe (65 und 90 Min.) zählen nicht, der 40-Min.-Abstand zählt`);
targets(out, 'geltend');
if (base) {
  noWorse(out, base, 'geltend');
  note(base._regelstand === T.METHOD_VERSION, `Basis aus Regelstand ${base._regelstand}, geprüft wird ${T.METHOD_VERSION}: Unterschiede prüfen, dann --write-baseline`);
} else note(false, 'keine Basis (test/bench/baseline.json): node test/algo-bench.test.mjs --write-baseline');
if (process.argv.includes('--write-baseline')) {
  await writeFile(baseFile, JSON.stringify({ _regelstand: T.METHOD_VERSION, _seed: 1, ...out }, null, 1) + '\n');
  console.log('Basis geschrieben:', path.relative(process.cwd(), baseFile));
}
if (process.argv.includes('--table')) console.log(table(rows));
const s = (Date.now() - t0) / 1000;
assert(s < 60, `Prüfstand-Laufzeit ${s.toFixed(1)} s < 60 s`);
