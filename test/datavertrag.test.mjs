// S3.7 Datenverträge: lib/pulse-schema.js (Familien, Stempel, MAJOR-Prüfung) – ohne Abhängigkeiten, läuft in test-all.
// Die Prüfung der Dateien gegen schemas/*.schema.json (ajv) steht in test/schema.mjs.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { SCHEMA, familyOf, withSchema, checkMajor, majorOf } from '../lib/pulse-schema.js';

let ok = 0, bad = 0;
const eq = (a, b, m) => { const s = JSON.stringify(a) === JSON.stringify(b); if (s) { ok++; console.log(`ok: ${m}`); } else { bad++; console.log(`FEHLER ${m}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); } };
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);

eq(Object.keys(SCHEMA).sort(), ['boundaries', 'calib', 'cells', 'events', 'forecast', 'history', 'latest', 'ops', 'sources', 'status'], 'zehn Familien aus S3.7');
for (const [f, v] of Object.entries(SCHEMA)) {
  eq(/^\d+\.\d+$/.test(v), true, `${f}: MAJOR.MINOR`);
  const s = JSON.parse(await readFile(path.join(ROOT, 'schemas', `${f}.schema.json`), 'utf8'));
  eq(s['x-version'], v, `schemas/${f}.schema.json x-version`);
}
eq(SCHEMA.status, '2.0', 'status bleibt 2.0 (S3.2)');

eq(familyOf('status.json'), { family: 'status', def: null }, 'status');
eq(familyOf('latest.json?t=1794'), { family: 'latest', def: null }, 'Parameter abgeschnitten');
eq(familyOf('history/index.json'), { family: 'history', def: 'index' }, 'history index');
eq(familyOf('history/2026-11-13.json'), { family: 'history', def: 'day' }, 'history Tag');
eq(familyOf('events/2026-11-13.json'), { family: 'events', def: 'day' }, 'events Tag');
eq(familyOf('cells/2026-11-12/BW.json'), { family: 'cells', def: null }, 'cells Land');
eq(familyOf('cells/2026-11-12.json'), null, 'alte Tagesdatei der Zellen gehört nicht dazu');
eq(familyOf('ops/BW.json'), { family: 'ops', def: 'state' }, 'ops Land');
eq(familyOf('ops-input/08111000.json'), { family: 'ops', def: 'input' }, 'ops-input Gemeinde (S3.8)');
eq(familyOf('ops-input/index.json'), { family: 'ops', def: 'inputIndex' }, 'ops-input index');
eq(familyOf('ops-input/fleet/08111000.json'), { family: 'ops', def: 'state' }, 'ops-input Bestand je Gemeinde (1.2)');
eq(familyOf('ops-input/fleet/index.json'), { family: 'ops', def: 'fleetIndex' }, 'ops-input Bestand index');
eq(familyOf('events/2026-11-13/BW.json'), { family: 'events', def: 'day' }, 'events je Land (S3.8)');
eq(familyOf('events/hour-totals.json'), { family: 'events', def: 'hourTotals' }, 'events hour-totals');
eq(familyOf('events/daily-summary.json'), { family: 'events', def: 'summary' }, 'events daily-summary');
eq(familyOf('boundaries/index.json'), { family: 'boundaries', def: 'index' }, 'boundaries index');
eq(familyOf('boundaries/NW.json'), { family: 'boundaries', def: 'state' }, 'boundaries Land');
eq(familyOf('forecast/series.json'), { family: 'forecast', def: 'series' }, 'forecast series');
eq(familyOf('forecast/moped/log.json'), { family: 'forecast', def: 'log' }, 'forecast E-Roller log');
eq(familyOf('forecast/car/latest.json'), { family: 'forecast', def: 'latest' }, 'forecast Carsharing latest');
eq(familyOf('forecast/model.json'), null, 'Modell gehört nicht dazu');
eq(familyOf('flows/2026-11-12.json'), null, 'flows (noch) ohne Vertrag');

const st = withSchema('events', { schemaVersion: '0.9', day: '2026-11-13' });
eq(Object.keys(st)[0], 'schemaVersion', 'schemaVersion steht vorn');
eq(st.schemaVersion, SCHEMA.events, 'alter Stempel wird ersetzt');
eq(majorOf('2.0'), 2, 'majorOf'); eq(majorOf('x'), null, 'majorOf ungültig');

eq(checkMajor('status.json', { schemaVersion: '2.7' }), null, 'neuere MINOR passt');
eq(checkMajor('status.json', { schemaVersion: '3.0' }), { family: 'status', expected: '2.0', got: '3.0' }, 'andere MAJOR → Hinweis');
eq(checkMajor('latest.json', { at: 1 }), null, 'ohne schemaVersion: Übergang, kein Hinweis');
eq(checkMajor('flows/index.json', { schemaVersion: '9.0' }), null, 'fremde Familie: keine Prüfung');
eq(checkMajor('latest.json', null), null, 'kein Objekt');

console.log(`${bad ? '✗' : '✓'} datavertrag: ${ok} ok, ${bad} fehlgeschlagen`);
process.exit(bad ? 1 : 0);
