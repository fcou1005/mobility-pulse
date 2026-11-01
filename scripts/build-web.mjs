#!/usr/bin/env node
// Kopiert Dashboard und Kernbibliothek nach docs/ (GitHub Pages: main, /docs)
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const out = path.join(ROOT, 'docs');
await mkdir(out, { recursive: true });
import { readFile } from 'node:fs/promises';
const v = Date.now().toString(36);
const html = (await readFile(path.join(ROOT, 'web', 'index.html'), 'utf8')).replace('src="app.js"', `src="app.js?v=${v}"`);
await writeFile(path.join(out, 'index.html'), html);
// Alle Module mit Versionsanhang importieren, damit kein Browser-Cache alte Teile mischt
const bust = (src) => src.replace(/from '\.\/([\w-]+\.js)'/g, `from './$1?v=${v}'`);
for (const [dir, f] of [['web', 'app.js'], ['web', 'ops.js'], ['lib', 'pulse-core.js'], ['lib', 'pulse-track.js'], ['lib', 'pulse-ops.js'], ['lib', 'pulse-econ.js'], ['lib', 'pulse-calib.js'], ['web', 'report.js'], ['lib', 'pulse-report.js'], ['web', 'flows.js'], ['web', 'i18n.js'], ['web', 'coverage.js'], ['web', 'compare.js'], ['lib', 'pulse-compare.js']]) {
  await writeFile(path.join(out, f), bust(await readFile(path.join(ROOT, dir, f), 'utf8')));
}
await writeFile(path.join(out, '.nojekyll'), '');
console.error('[web] docs/ aktualisiert');
