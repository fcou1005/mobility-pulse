#!/usr/bin/env node
// Kopiert Dashboard und Kernbibliothek nach docs/ (GitHub Pages: main, /docs)
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const out = path.join(ROOT, 'docs');
await mkdir(out, { recursive: true });
await copyFile(path.join(ROOT, 'web', 'index.html'), path.join(out, 'index.html'));
await copyFile(path.join(ROOT, 'web', 'app.js'), path.join(out, 'app.js'));
await copyFile(path.join(ROOT, 'lib', 'pulse-core.js'), path.join(out, 'pulse-core.js'));
await writeFile(path.join(out, '.nojekyll'), '');
console.error('[web] docs/ aktualisiert');
