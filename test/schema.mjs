#!/usr/bin/env node
// S3.7 Datenverträge: Dateien des Datenzweigs gegen schemas/<Familie>.schema.json prüfen (ajv, nur hier – der Sammler bleibt ohne
// Abhängigkeiten). Familien und Formatversion stehen in lib/pulse-schema.js; die Schemas tragen dieselbe Version als x-version.
//   node test/schema.mjs                      Fixture (test/fixtures/web-data)
//   node test/schema.mjs <Ordner> …           z. B. ein Checkout des Branches data
//   SCHEMA_LEGACY=1 node test/schema.mjs …    Dateien ohne schemaVersion zulassen (Übergang, nur Hinweis)
// Exit 1 bei Verstößen, Dateien ohne schemaVersion (außer SCHEMA_LEGACY) oder Schemas, deren Version nicht zu lib/pulse-schema.js passt.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { SCHEMA, familyOf, majorOf } from '../lib/pulse-schema.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const dirs = process.argv.slice(2).length ? process.argv.slice(2).map(d => path.resolve(d)) : [path.join(ROOT, 'test/fixtures/web-data')];
const LEGACY = !!process.env.SCHEMA_LEGACY;
const { default: Ajv2020 } = await import('ajv/dist/2020.js').catch(() => { console.error('ajv fehlt: npm ci (devDependencies)'); process.exit(2); });

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addKeyword('x-version');
let bad = 0;
const fail = (m) => { bad++; console.log(`✗ ${m}`); };
const schemas = {};
for (const fam of Object.keys(SCHEMA)) {
  const s = JSON.parse(await readFile(path.join(ROOT, 'schemas', `${fam}.schema.json`), 'utf8'));
  if (s['x-version'] !== SCHEMA[fam]) fail(`schemas/${fam}.schema.json: x-version ${s['x-version']} ≠ lib/pulse-schema.js ${SCHEMA[fam]}`);
  const pat = JSON.stringify(s).match(/"schemaVersion":\{"type":"string","pattern":"\^(\d+)\\\\\./g) || [];
  if (!pat.length || pat.some(p => +(/\^(\d+)/.exec(p) || [])[1] !== majorOf(SCHEMA[fam]))) fail(`schemas/${fam}.schema.json: Muster für schemaVersion passt nicht zu MAJOR ${majorOf(SCHEMA[fam])}`);
  ajv.addSchema(s); schemas[fam] = s;
}
const validator = (fam, def) => ajv.getSchema(def ? `${schemas[fam].$id}#/$defs/${def}` : schemas[fam].$id);

async function* walk(dir, rel = '') {
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) yield* walk(dir, r); else yield r;
  }
}

for (const dir of dirs) {
  const per = {}; let legacy = 0;
  for await (const rel of walk(dir)) {
    const fam = familyOf(rel); if (!fam) continue;
    let doc; try { doc = JSON.parse(await readFile(path.join(dir, rel), 'utf8')); } catch (e) { fail(`${rel}: kein JSON (${e.message})`); continue; }
    const p = per[fam.family] ||= { n: 0, bad: 0 }; p.n++;
    if (doc && typeof doc === 'object' && doc.schemaVersion == null) {
      if (!LEGACY) { p.bad++; fail(`${rel}: ohne schemaVersion (erwartet ${SCHEMA[fam.family]})`); continue; }
      legacy++; doc = { schemaVersion: SCHEMA[fam.family], ...doc };
    }
    const v = validator(fam.family, fam.def);
    if (!v) { fail(`${rel}: kein Teilschema ${fam.family}#${fam.def}`); continue; }
    if (!v(doc)) { p.bad++; fail(`${rel} (${fam.family}${fam.def ? `#${fam.def}` : ''}): ${v.errors.slice(0, 4).map(e => `${e.instancePath || '/'} ${e.message}${e.params?.allowedValues ? ` ${JSON.stringify(e.params.allowedValues)}` : ''}`).join('; ')}`); }
  }
  const fams = Object.keys(SCHEMA);
  const none = fams.filter(f => !per[f]);
  console.log(`${path.relative(ROOT, dir) || dir}: ${fams.filter(f => per[f]).map(f => `${f} ${per[f].n - per[f].bad}/${per[f].n}`).join(', ')}${none.length ? ` · nicht vorhanden: ${none.join(', ')}` : ''}${legacy ? ` · ${legacy} Dateien ohne schemaVersion (SCHEMA_LEGACY)` : ''}`);
}
console.log(bad ? `${bad} Befunde` : 'Datenverträge grün');
process.exit(bad ? 1 : 0);
