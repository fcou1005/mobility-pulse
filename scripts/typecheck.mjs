#!/usr/bin/env node
// Typprüfung gegen einen gespeicherten Stand (S3.3): tsc --noEmit über lib/, web/, scripts/ und test/ (tsconfig.json, JSDoc, nicht strict).
// lib/ muss fehlerfrei sein; jede andere Datei darf höchstens so viele Fehler haben wie in typecheck-baseline.json. Sinkt die Zahl,
// mit --update den Stand nachziehen (er darf nur sinken; --init legt den ersten Stand an; --moved nach Umzug von Code in andere Dateien,
// solange die Gesamtzahl nicht steigt). Exit 1 bei mehr Fehlern. Braucht die devDependencies (npm ci).
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname), BASE = path.join(ROOT, 'typecheck-baseline.json');
const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
if (!existsSync(tsc)) { console.error('TypeScript fehlt: npm ci'); process.exit(2); }
const r = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json', '--pretty', 'false'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6 });
const now = {}; let total = 0;
for (const m of (r.stdout || '').matchAll(/^([^\s(]+)\(\d+,\d+\): error TS\d+/gm)) { now[m[1]] = (now[m[1]] || 0) + 1; total++; }
if (r.status !== 0 && !total) { console.error(r.stdout || r.stderr); process.exit(2); }
const base = existsSync(BASE) ? JSON.parse(await readFile(BASE, 'utf8')) : { files: {} };
const worse = [], better = [];
for (const [f, n] of Object.entries(now)) { const b = base.files?.[f] ?? 0; if (f.startsWith('lib/') || n > b) worse.push([f, n, b]); else if (n < b) better.push([f, n, b]); }
for (const [f, b] of Object.entries(base.files || {})) if (!now[f] && b) better.push([f, 0, b]);
for (const [f, n, b] of worse) console.log(`✗ ${f}: ${n} Fehler (Stand ${b}${f.startsWith('lib/') ? ', lib/ muss fehlerfrei sein' : ''})`);
for (const [f, n, b] of better) console.log(`↓ ${f}: ${n} statt ${b}`);
const init = process.argv.includes('--init') && !worse.some(([f]) => f.startsWith('lib/')); // erster Stand (lib/ trotzdem fehlerfrei)
// --moved: Code ist in andere Dateien umgezogen (S3.9 Module schneiden) – Stand je Datei neu, wenn die Gesamtzahl nicht steigt und lib/ fehlerfrei bleibt
const moved = process.argv.includes('--moved') && total <= (base.total ?? Infinity) && !worse.some(([f]) => f.startsWith('lib/'));
if (process.argv.includes('--update') || init || moved) {
  if (worse.length && !init && !moved) { console.error('Stand nicht nachgezogen: erst die neuen Fehler beheben'); process.exit(1); }
  await writeFile(BASE, `${JSON.stringify({ note: 'Fehler je Datei aus scripts/typecheck.mjs; darf nur sinken. lib/ fehlerfrei.', total, files: Object.fromEntries(Object.entries(now).sort()) }, null, 2)}\n`);
  console.log(`Stand gespeichert: ${total} Fehler in ${Object.keys(now).length} Dateien`);
}
const lib = Object.entries(now).filter(([f]) => f.startsWith('lib/')).reduce((s, [, n]) => s + n, 0);
console.log(`${worse.length ? '✗' : '✓'} Typprüfung: ${total} Fehler gesamt (Stand ${base.total ?? '–'}), lib/ ${lib}${better.length && !process.argv.includes('--update') ? ' · weniger als im Stand: mit --update nachziehen' : ''}`);
process.exit(worse.length && !init && !moved ? 1 : 0);
