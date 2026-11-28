#!/usr/bin/env node
// Synthetischer Tokio-Datenstand für die Browser-Tests (test/fixtures/tokio-synth), solange der Datenstand des Fixtures keine echten Dateien
// unter tokio/ enthält. Ports, Stand und Stunden sind ausgedacht (Mitte Tokios, zwei Systeme) und nur für Layout und Textbausteine gedacht.
//   node scripts/tokio-fixture.mjs [--out test/fixtures/tokio-synth]
// make-fixture.mjs kopiert diese Dateien in das Fixture, wenn der Datenstand keine echten Tokio-Dateien enthält.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import * as TK from '../lib/pulse-tokio.js';
import { SCHEMA } from '../lib/pulse-schema.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname), args = process.argv.slice(2);
const OUT = path.resolve(ROOT, args.includes('--out') ? args[args.indexOf('--out') + 1] : 'test/fixtures/tokio-synth');
const fx = JSON.parse(await readFile(path.join(ROOT, 'test/fixtures/web-data/FIXTURE.json'), 'utf8'));
let seed = 29; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const r5 = (/** @type {number} */ x) => Math.round(x * 1e5) / 1e5, sv = SCHEMA.tokio;
const put = async (/** @type {string} */ f, /** @type {any} */ v) => { const p = path.join(OUT, f); await mkdir(path.dirname(p), { recursive: true }); await writeFile(p, JSON.stringify({ schemaVersion: sv, ...v })); };

const at = fx.at, day = TK.jstDay(at), prevDay = TK.jstDay(at - 86400e3), nowH = TK.jstHour(at);
const N = { docomo: 40, hello: 30 }, stations = [], stand = [];
for (const sys of TK.TOKIO.systems) for (let i = 0; i < N[sys.id]; i++) {
  const id = `${sys.id === 'docomo' ? 'D' : 'H'}${100 + i}`, cap = 5 + Math.floor(rnd() * 16), lat = r5(35.66 + rnd() * 0.05), lon = r5(139.73 + rnd() * 0.06);
  const k = rnd(), b = k < 0.15 ? 0 : k > 0.9 ? cap : Math.floor(rnd() * cap), z = i === 7 ? 1 : 0;
  stations.push([sys.id, id, lat, lon, cap, `${sys.id === 'docomo' ? 'Port' : 'Station'} ${i + 1}`]); stand.push([sys.id, id, b, cap - b, z]);
}
const sum = TK.summarize(stand);
// Tagesverlauf: Pendlerspitzen um 8 und 18 Uhr (Ortszeit), je Stunde drei Läufe
const curve = (/** @type {number} */ h) => 0.3 + Math.exp(-((h - 8) ** 2) / 3) + 0.8 * Math.exp(-((h - 18) ** 2) / 4);
/** @param {string} d @param {number} hours */
const dayDoc = (d, hours) => {
  const doc = { version: TK.TOKIO.version, day: d, tz: TK.TOKIO.tz, fields: TK.HOUR_FIELDS, sys: {} };
  for (const sys of TK.TOKIO.systems) {
    const s = sum[sys.id];
    for (let h = 0; h < hours; h++) for (let r = 0; r < 3; r++) {
      const c = curve(h), out = Math.round(c * s.ports * 0.4 * (0.8 + rnd() * 0.4));
      TK.addHour(doc, sys.id, h, { bikes: Math.round(s.bikes * (1.1 - c * 0.15)), ports: s.ports, empty: Math.round(s.empty * (0.8 + c * 0.4)), full: s.full, out, in: Math.round(out * (0.9 + rnd() * 0.2)), min: 20 });
    }
  }
  return doc;
};
const today = dayDoc(day, nowH + 1), yday = dayDoc(prevDay, 24);
const systems = TK.TOKIO.systems.map(sys => ({ id: sys.id, name: sys.name, operator: sys.operator, url: sys.url, license: sys.license, licenseUrl: sys.licenseUrl, feed: `${TK.TOKIO.base}/${sys.feed}/gbfs.json`, ok: true, error: null, ...sum[sys.id], at, today: TK.dayTotals(today, sys.id) }));
const totals = Object.values(sum).reduce((a, s) => { for (const k of Object.keys(a)) a[k] += s[k]; return a; }, { ports: 0, bikes: 0, docks: 0, empty: 0, full: 0, off: 0 });
const sAt = Object.fromEntries(TK.TOKIO.systems.map(s => [s.id, at]));
await put('index.json', { version: TK.TOKIO.version, at, tz: TK.TOKIO.tz, day, systems, totals, days: [prevDay, day], stationsAt: sAt, firstDay: prevDay });
await put('stationen.json', { version: TK.TOKIO.version, at: sAt, tz: TK.TOKIO.tz, fields: TK.STATION_FIELDS, rows: stations });
await put('stand.json', { version: TK.TOKIO.version, at: sAt, fields: TK.STAND_FIELDS, rows: stand });
await put(`${day}.json`, today); await put(`${prevDay}.json`, yday);
console.error(`[tokio-fixture] ${OUT}: ${stations.length} Ports, Tage ${prevDay} und ${day}`);
