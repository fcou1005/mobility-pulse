#!/usr/bin/env node
// Alle Testdateien nacheinander (Audit OPS-13): test/*.test.mjs und der Fixture-Test test/run.mjs (Port 8765; mit --unit ohne ihn).
// Ausgabe je Datei: Exit-Code, Zahl der ok/FEHLER-Zeilen, Dauer; Exit 1, wenn eine Datei scheitert.
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const unitOnly = process.argv.includes('--unit');
const files = (await readdir(path.join(ROOT, 'test'))).filter(f => f.endsWith('.test.mjs')).sort().map(f => `test/${f}`);
if (!unitOnly) files.unshift('test/run.mjs');
const run = (f) => new Promise(res => {
  const t0 = Date.now(), p = spawn(process.execPath, [f], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }); let out = '';
  p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
  const kill = setTimeout(() => p.kill('SIGKILL'), 15 * 60e3);
  p.on('exit', (code) => { clearTimeout(kill); res({ f, code: code ?? 1, ok: (out.match(/^ok:/gm) || []).length, bad: (out.match(/^FEHLER/gm) || []).length, s: (Date.now() - t0) / 1000, out }); });
});
let failed = 0;
for (const f of files) {
  const r = await run(f);
  console.log(`${r.code === 0 && !r.bad ? '✓' : '✗'} ${f.padEnd(28)} ${String(r.ok).padStart(4)} ok ${r.bad ? `${r.bad} FEHLER ` : ''}${r.s.toFixed(1)} s`);
  if (r.code !== 0 || r.bad) { failed++; console.log(r.out.split('\n').filter(l => /FEHLER|Error|error/.test(l)).slice(0, 20).join('\n')); }
}
console.log(failed ? `${failed} von ${files.length} Testdateien gescheitert` : `alle ${files.length} Testdateien grün`);
process.exit(failed ? 1 : 0);
