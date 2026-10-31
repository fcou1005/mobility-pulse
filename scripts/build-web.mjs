#!/usr/bin/env node
// Kopiert Dashboard und Kernbibliothek nach docs/ (GitHub Pages: main, /docs)
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const out = path.join(ROOT, 'docs');
await mkdir(out, { recursive: true });
import { readFile } from 'node:fs/promises';
const v = Date.now().toString(36);
const html = (await readFile(path.join(ROOT, 'web', 'index.html'), 'utf8')).replace('src="app.js"', `src="app.js?v=${v}"`);
await writeFile(path.join(out, 'index.html'), html);
const app = (await readFile(path.join(ROOT, 'web', 'app.js'), 'utf8')).replace("from './pulse-core.js'", `from './pulse-core.js?v=${v}'`);
await writeFile(path.join(out, 'app.js'), app);
await copyFile(path.join(ROOT, 'lib', 'pulse-core.js'), path.join(out, 'pulse-core.js'));
await writeFile(path.join(out, '.nojekyll'), '');
console.error('[web] docs/ aktualisiert');
