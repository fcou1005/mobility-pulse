#!/usr/bin/env node
// Baut das Dashboard nach docs/ (GitHub Pages: main, /docs). Seit S3.4/S3.5 (13.11.2026):
//  - esbuild bündelt web/app.js mit Code-Splitting: jede Ansicht (Disposition, Bericht, Prognose, Spots, Ströme, Vergleich, Abdeckung,
//    Status) ist ein eigener Teil, den app.js per import() nachlädt; lib/ wird mitgebündelt (web/ importiert ./pulse-*.js → lib/).
//  - Wörterbuch je Sprache und Bereich: docs/i18n/<de|en>/<Bereich>.json aus web/i18n-dict.js (Bereiche: web/i18n-areas.js; Schlüssel,
//    die Startmodule wörtlich benutzen, kommen nach core).
//  - Prognose-Engine unverändert nach docs/engine/ (Download „Algorithmus herunterladen“ in der Prognose).
//  - Bericht der Größen je Ansicht (gzip) mit Budget: node scripts/build-web.mjs --budget (Exit 1 bei Überschreitung).
import { mkdir, writeFile, readFile, readdir, rm, cp } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname), out = path.join(ROOT, 'docs');
const v = Date.now().toString(36);
const require = createRequire(import.meta.url);
let esbuild; try { esbuild = require('esbuild'); } catch { console.error('[web] esbuild fehlt: npm ci (devDependencies)'); process.exit(2); }

// 1. alte Ausgabe weg (nur, was der Build erzeugt; vendor/ bleibt)
await mkdir(out, { recursive: true });
for (const f of await readdir(out)) if (f.endsWith('.js') || f.endsWith('.js.map')) await rm(path.join(out, f));
for (const d of ['js', 'i18n', 'engine']) await rm(path.join(out, d), { recursive: true, force: true });

// 2. Bündeln mit Splitting; web/ importiert lib-Dateien als ./pulse-*.js (wie früher in docs/ nebeneinander)
const libResolve = { name: 'lib', setup(b) { b.onResolve({ filter: /^\.\/pulse-[\w-]+\.js$/ }, (a) => (a.importer.startsWith(path.join(ROOT, 'web')) ? { path: path.join(ROOT, 'lib', a.path.slice(2)) } : undefined)); } };
const res = await esbuild.build({
  entryPoints: [path.join(ROOT, 'web', 'app.js')], bundle: true, splitting: true, format: 'esm', minify: true, target: ['es2022'],
  outdir: out, entryNames: '[name]', chunkNames: 'js/[name]-[hash]', define: { __MP_BUILD__: JSON.stringify(v) }, plugins: [libResolve],
  legalComments: 'none', metafile: true, logLevel: 'warning',
});

// 3. index.html mit Versionsanhang für app.js (Teile tragen einen Inhalts-Hash im Namen)
const html = (await readFile(path.join(ROOT, 'web', 'index.html'), 'utf8')).replace('src="app.js"', `src="app.js?v=${v}"`);
await writeFile(path.join(out, 'index.html'), html);

// 4. Wörterbuch je Sprache und Bereich
const { DE, EN } = await import(path.join(ROOT, 'web', 'i18n-dict.js'));
const { AREAS, areaOfKey } = await import(path.join(ROOT, 'web', 'i18n-areas.js'));
// S3.9: app.js ist in app-*.js geschnitten; alle gehören zum Startpaket
const CORE_FILES = [...(await readdir(path.join(ROOT, 'web'))).filter(f => /^app(-[a-z]+)?\.js$/.test(f)).sort(), 'ui-shared.js', 'i18n.js', 'mapkeys.js', 'weather.js', 'index.html'];
const coreUse = new Set();
for (const f of CORE_FILES) {
  const src = await readFile(path.join(ROOT, 'web', f), 'utf8');
  for (const m of src.matchAll(/\bt(?:In)?\(\s*(?:[a-z]+\s*,\s*)?['"`]([a-zA-Z][\w$-]*(?:\.[\p{L}\w$-]+)+)['"`]/gu)) coreUse.add(m[1]);
  for (const m of src.matchAll(/data-i18n(?:-[a-z-]+)?=["']([^"']+)["']/g)) coreUse.add(m[1]);
}
const areaOf = (k) => (coreUse.has(k) ? 'core' : areaOfKey(k));
const sizes = {};
for (const [l, D] of [['de', DE], ['en', EN]]) {
  const by = Object.fromEntries(['core', ...Object.keys(AREAS)].map(a => [a, {}]));
  for (const [k, s] of Object.entries(D)) by[areaOf(k)][k] = s;
  await mkdir(path.join(out, 'i18n', l), { recursive: true });
  for (const [a, d] of Object.entries(by)) { const j = JSON.stringify(d); await writeFile(path.join(out, 'i18n', l, `${a}.json`), j); sizes[`i18n/${l}/${a}.json`] = gzipSync(j, { level: 9 }).length; }
}

// 5. Prognose-Engine unverändert (Download) und statische Teile
await mkdir(path.join(out, 'engine'), { recursive: true });
// Teile der geschnittenen Module (pulse-forecast-*.js usw.) kommen mit; die Datei selbst ist dann eine Fassade (export * from …)
const ENGINE = ['pulse-forecast', 'pulse-context', 'pulse-econ', 'pulse-track', 'pulse-core'], libFiles = await readdir(path.join(ROOT, 'lib'));
for (const f of libFiles.filter(f => ENGINE.some(e => f === `${e}.js` || (f.startsWith(`${e}-`) && f !== 'pulse-track-next.js')))) await writeFile(path.join(out, 'engine', f), await readFile(path.join(ROOT, 'lib', f), 'utf8'));
await cp(path.join(ROOT, 'web', 'vendor'), path.join(out, 'vendor'), { recursive: true, force: true }); // Schriften, Leaflet (DSGVO, CSP nur 'self')
for (const f of ['datenschutz.html']) await writeFile(path.join(out, f), await readFile(path.join(ROOT, 'web', f), 'utf8')); // ohne Skript (S0.5)
await writeFile(path.join(out, '.nojekyll'), '');

// 6. Größen je Ansicht: Start (app.js und seine statischen Teile + core) und je Modul (dazu sein Teil, dessen statische Teile, sein Bereich)
const outs = res.metafile.outputs, rel = (p) => path.relative(out, path.resolve(ROOT, p)), gz = new Map();
const gzOf = async (f) => { if (!gz.has(f)) gz.set(f, gzipSync(await readFile(path.join(out, f)), { level: 9 }).length); return gz.get(f); };
const closure = (f, seen = new Set()) => { if (seen.has(f)) return seen; seen.add(f); for (const im of outs[path.relative(ROOT, path.join(out, f))]?.imports || []) if (im.kind === 'import-statement') closure(rel(im.path), seen); return seen; };
const dyn = Object.fromEntries((outs[path.relative(ROOT, path.join(out, 'app.js'))]?.imports || []).filter(im => im.kind === 'dynamic-import').map(im => [rel(im.path), im.path]));
const entryOf = (name) => Object.keys(dyn).find(f => outs[path.relative(ROOT, path.join(out, f))]?.entryPoint?.endsWith(`web/${name}.js`));
const VIEW_MODS = { start: [null, null], ops: ['ops', 'ops'], bericht: ['report', 'report'], prognose: ['forecast', 'forecast'], spots: ['spots', 'spots'], usage: ['flows', 'flows'], vergleich: ['compare', 'compare'], status: ['status', 'status'], stadt: ['stadt', 'stadt'] };
const BUDGET = { start: 180, ops: 270 }; // KB gzip (S3.5)
const report = [];
const base = closure('app.js');
for (const [view, [m, area]] of Object.entries(VIEW_MODS)) {
  const files = new Set(base); if (m) { const e = entryOf(m); if (e) closure(e, files); }
  let js = 0; for (const f of files) js += await gzOf(f);
  const i18n = sizes['i18n/de/core.json'] + (area ? sizes[`i18n/de/${area}.json`] : 0);
  report.push([view, js, i18n, js + i18n, BUDGET[view]]);
}
const kb = (b) => (b / 1024).toFixed(0).padStart(4);
console.error(`[web] docs/ gebaut (${Object.keys(outs).filter(f => f.endsWith('.js')).length} JS-Dateien, Wörterbuch ${Object.keys(sizes).length} Teile)`);
let over = 0;
for (const [view, js, i18n, tot, b] of report) { const bad = b && tot / 1024 > b; if (bad) over++; if (process.argv.includes('--budget') || bad) console.error(`[web] ${view.padEnd(9)} JS ${kb(js)} KB + Texte ${kb(i18n)} KB = ${kb(tot)} KB gzip${b ? ` (Budget ${b} KB)` : ''}${bad ? ' ✗' : ''}`); }
if (over && process.argv.includes('--budget')) process.exit(1);
