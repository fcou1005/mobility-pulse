#!/usr/bin/env node
// handbuch/datenformate.md aus schemas/*.schema.json und lib/pulse-schema.js erzeugen (S3.10). Keine Abhängigkeiten.
//   node scripts/schemas-doc.mjs          schreibt die Datei
//   node scripts/schemas-doc.mjs --check  Exit 1, wenn die Datei nicht zum Stand der Schemas passt (test/handbuch.test.mjs)
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SCHEMA } from '../lib/pulse-schema.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const OUT = path.join(ROOT, 'handbuch/datenformate.md');
const FILES = {
  status: ['status.json'], latest: ['latest.json'], sources: ['sources.json'],
  history: ['history/index.json', 'history/<Tag>.json'],
  events: ['events/index.json', 'events/<Tag>.json', 'events/<Tag>/<Land>.json', 'events/hour-totals.json', 'events/daily-summary.json'],
  cells: ['cells/<Tag>/<Land>.json'], ops: ['ops/<Land>.json', 'ops-input/<AGS>.json', 'ops-input/index.json', 'ops-input/fleet/<AGS>.json', 'ops-input/fleet/index.json'],
  boundaries: ['boundaries/index.json', 'boundaries/<Land>.json'], calib: ['calib.json'],
  forecast: ['forecast/latest.json', 'forecast/log.json', 'forecast/series.json', 'forecast/moped/…', 'forecast/car/…'],
  auflagen: ['auflagen/verfuegbarkeit-<Jahr>.json', 'auflagen/alarme.json'],
  markt: ['index/<JJJJ-MM>.json', 'index/laufend.json', 'index/index.json', 'markt/wirkung.json', 'markt/scout.json', 'grafik/index.json', 'offen/index.json'],
};

// Fließtext aus den Schemas: <Tag>, [i] außerhalb von `Code` maskieren (sonst HTML bzw. Verweis in Markdown)
const txt = (t) => String(t || '').split(/(`[^`]*`)/).map((part, i) => (i % 2 ? part : part.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([[\]])/g, '\\$1'))).join('');
const typeOf = (s) => {
  if (!s || typeof s !== 'object') return '';
  if (s.const !== undefined) return `\`${JSON.stringify(s.const)}\``;
  if (s.enum) return s.enum.map(x => `\`${JSON.stringify(x)}\``).join(' / ');
  if (s.anyOf) return s.anyOf.map(typeOf).join(' oder ');
  const t = Array.isArray(s.type) ? s.type.join(' / ') : s.type || '';
  const extra = s.pattern ? ` (Muster \`${s.pattern}\`)` : t === 'array' && s.items && !Array.isArray(s.items) ? ` von ${typeOf(s.items) || 'Werten'}` : '';
  return `${t}${extra}`;
};
function table(def) {
  const req = new Set(def.required || []), rows = Object.entries(def.properties || {});
  if (!rows.length) return '';
  return ['| Feld | Pflicht | Typ |', '| --- | --- | --- |', ...rows.map(([k, s]) => `| \`${k}\` | ${req.has(k) ? 'ja' : ''} | ${typeOf(s).replace(/\|/g, '\\|')}${s.description ? ` – ${txt(s.description).replace(/\|/g, '\\|')}` : ''} |`)].join('\n');
}

export async function render() {
  const out = ['# Datenformate', '',
    'Erzeugt aus `schemas/*.schema.json` mit `node scripts/schemas-doc.mjs` – nicht von Hand ändern. Jede Datei dieser Familien trägt vorn',
    '`schemaVersion` („MAJOR.MINOR“). Neue Felder erhöhen MINOR, ein weggefallenes Feld oder eine geänderte Bedeutung MAJOR; passt die',
    'MAJOR-Version nicht zur Seite, zeigt das Dashboard einen Hinweis. Geprüft wird mit `node test/schema.mjs` (Fixture) und',
    '`node test/schema.mjs <Checkout des Branches data>`. Felder, die hier nicht stehen, sind erlaubt, aber nicht zugesichert.', ''];
  out.push('| Familie | Version | Dateien |', '| --- | --- | --- |');
  for (const [fam, v] of Object.entries(SCHEMA)) out.push(`| [${fam}](#${fam}) | ${v} | ${FILES[fam].map(f => `\`${f}\``).join(', ')} |`);
  out.push('');
  for (const fam of Object.keys(SCHEMA)) {
    const s = JSON.parse(await readFile(path.join(ROOT, 'schemas', `${fam}.schema.json`), 'utf8'));
    out.push(`## ${fam}`, '', `${txt(s.title)}. ${txt(s.description)}`.trim(), '', `Version ${s['x-version']} · Schema: [schemas/${fam}.schema.json](../schemas/${fam}.schema.json)`, '');
    if (s.properties) out.push(table(s), '');
    for (const [name, def] of Object.entries(s.$defs || {})) {
      const t = table(def); if (!t) continue;
      out.push(`### ${fam} · ${name}`, '', ...(def.description ? [txt(def.description), ''] : []), t, '');
    }
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const md = await render();
  if (process.argv.includes('--check')) {
    const cur = await readFile(OUT, 'utf8').catch(() => '');
    if (cur !== md) { console.error('handbuch/datenformate.md passt nicht zu schemas/ – node scripts/schemas-doc.mjs ausführen'); process.exit(1); }
    console.log('handbuch/datenformate.md aktuell');
  } else { await writeFile(OUT, md); console.log(`handbuch/datenformate.md geschrieben (${(md.length / 1024).toFixed(1)} KB)`); }
}
