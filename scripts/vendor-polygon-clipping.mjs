// Bündelt polygon-clipping samt splaytree und robust-predicates in lib/vendor/polygon-clipping.js.
// Grund: lib/ muss ohne node_modules laufen (Testjob „unit“ ohne npm ci). Lizenzkopf bleibt erhalten.
// Aufruf nach einem Versionswechsel in package.json: node scripts/vendor-polygon-clipping.mjs
import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'lib', 'vendor', 'polygon-clipping.js');
const old = await readFile(OUT, 'utf8');
const end = old.indexOf('*/\n');
if (end < 0) throw new Error('Lizenzkopf in lib/vendor/polygon-clipping.js nicht gefunden');
const head = old.slice(0, end + 3);
const res = await build({
  stdin: { contents: "export { default } from 'polygon-clipping';", resolveDir: ROOT, loader: 'js' },
  bundle: true, format: 'esm', platform: 'neutral', mainFields: ['module', 'main'],
  minify: true, legalComments: 'none', write: false,
});
await writeFile(OUT, head + res.outputFiles[0].text);
console.log(`lib/vendor/polygon-clipping.js: ${(res.outputFiles[0].text.length / 1024).toFixed(1)} KB`);
