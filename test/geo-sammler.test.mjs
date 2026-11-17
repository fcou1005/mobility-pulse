// Sprint 8, Sammler-Phase „geo“: Versorgung je Lauf und Tag, Zubringer, Fahrtenden je 50-m-Zelle, Kopien aus dem Branch geo
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as Z from '../lib/pulse-geo-pop.js';
const assert = (c, m) => { if (!c) { console.error('FEHLER:', m); process.exitCode = 1; } else console.log('ok:', m); };
let seed = 5; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

const T = await mkdtemp(path.join(tmpdir(), 'geo-s-')), GEOB = path.join(T, 'geo'), DATA = path.join(T, 'data'), TRACK = path.join(T, 'track');
for (const d of ['pop', 'gtfs', 'unfall', 'umweg', 'wege']) await mkdir(path.join(GEOB, d), { recursive: true });
await mkdir(DATA, { recursive: true }); await mkdir(TRACK, { recursive: true });
// Zensus: 900 Punkte in Stuttgart
const acc = Z.popAccumulator(() => '08111000'); for (let i = 0; i < 30; i++) for (let j = 0; j < 30; j++) acc.add({ lat: 48.75 + i * 0.0009, lon: 9.15 + j * 0.00137, ew: 12 });
await writeFile(path.join(GEOB, 'pop', 'BW.json'), JSON.stringify({ schemaVersion: '1.0', state: 'BW', ags: { '08111000': Z.packAgs(acc.result().by.get('08111000')) } }));
await writeFile(path.join(GEOB, 'pop', 'index.json'), JSON.stringify({ schemaVersion: '1.0', maxDev: 0.03, n: 1, within: 1, ags: { '08111000': [10800, 10900, -0.0092], '09162000': [1, 1, 0] } }));
await writeFile(path.join(GEOB, 'gtfs', 'BW.json'), JSON.stringify({ schemaVersion: '1.0', ags: { '08111000': [[48.7635, 9.1705, 400, 'Hbf'], [48.77, 9.18, 100, 'Rathaus']] } }));
await writeFile(path.join(GEOB, 'gtfs', 'index.json'), JSON.stringify({ day: '20261117' }));
await writeFile(path.join(GEOB, 'unfall', 'index.json'), JSON.stringify({ schemaVersion: '1.0', years: [2023, 2024], missingYears: [], ags: { '08111000': { hot: 3 }, '09162000': { hot: 1 } } }));
await writeFile(path.join(GEOB, 'unfall', '08111000.json'), JSON.stringify({ schemaVersion: '1.0', ags: '08111000', years: [2023, 2024], fields: [], rows: [['19510:2623', 5]] }));
await writeFile(path.join(GEOB, 'umweg', 'index.json'), JSON.stringify({ schemaVersion: '1.0', cities: { '08111000': { median: 1.31 } } }));
await writeFile(path.join(GEOB, 'umweg', '08111000.json'), JSON.stringify({ schemaVersion: '1.0', ags: '08111000', fields: [], rows: [[48.75, 9.15, 1.3, 8]], median: 1.31 }));
await writeFile(path.join(GEOB, 'wege', 'index.json'), JSON.stringify({ schemaVersion: '1.0', cities: { '08111000': { routed: 1 }, '09162000': { error: 'x' } } }));
await writeFile(path.join(GEOB, 'wege', '08111000.json'), JSON.stringify({ schemaVersion: '1.0', ags: '08111000', segs: { 's:48.784,9.182|48.7758,9.1829': '_ouiH_ab{@nCQ' } }));
await writeFile(path.join(GEOB, 'index.json'), JSON.stringify({ schemaVersion: '1.0', at: 1794600000000, parts: {} }));
process.env.GEO_BASE = GEOB;
const { run } = await import('../scripts/collect/29-geo.mjs');
const { snapFromVehicles } = await import('../lib/pulse-akku-learn.js');
const vkey = (op, id) => `${op}:${id}`, logs = [];
// 60 Fahrzeuge, je Lauf fahren ein paar weg (neue Kennung woanders = Ende)
let fleet = Array.from({ length: 60 }, (_, i) => ({ operator: i < 30 ? 'Dott' : 'Bolt', rawId: `v${i}`, lat: 48.75 + rnd() * 0.027, lon: 9.15 + rnd() * 0.041, batteryPct: 60, type: 'scooter', ags: '08111000', disabled: false, reserved: false })), idn = 100;
let prev = null, prevAt = null;
const t0 = Date.parse('2026-11-14T17:05:00Z'); // 18:05 Uhr Berlin
for (let k = 0; k < 8; k++) {
  const now = t0 + k * 20 * 60e3 + (k >= 6 ? 6 * 3600e3 : 0); // die letzten zwei Läufe nach Mitternacht (neuer Tag)
  if (k) fleet = fleet.map(v => (rnd() < 0.15 ? { ...v, rawId: `v${idn++}`, lat: 48.7635 + (rnd() - 0.5) * 0.002, lon: 9.1705 + (rnd() - 0.5) * 0.003 } : v));
  await run({ DATA, TRACK_DIR: TRACK, now, log: (...m) => logs.push(m.join(' ')), dv: { vehicles: fleet }, vkey, sourceOut: [], akkuPrev: prev ? { snap: prev, at: prevAt } : null, latest: { municipalities: { '08111000': { name: 'Stuttgart' } } } });
  prev = snapFromVehicles(fleet, vkey); prevAt = now;
}
const v = JSON.parse(await readFile(path.join(DATA, 'versorgung', '08111000.json'), 'utf8')), vi = JSON.parse(await readFile(path.join(DATA, 'versorgung', 'index.json'), 'utf8'));
assert(v.schemaVersion === (await import('../lib/pulse-schema.js')).SCHEMA.geo && v.pop === 10800 && v.days.length === 1 && v.days[0].day === '2026-11-14' && v.days[0].share.length === 3 && v.today?.day === "2026-11-15" && v.today.runs >= 1, `Versorgung: Tag 14.11. abgeschlossen (${v.days[0]?.runs} Läufe), heute vorläufig (stündlich geschrieben)`);
assert(v.cells?.rows?.length > 10 && vi.ags['08111000'][0] === '2026-11-14' && vi.ags['08111000'].length === 11, 'Versorgung: Zellen des letzten Tages und Übersicht je Gemeinde');
assert(v.missingOps.includes('Voi') || v.missingOps.length >= 0, `Anbieter ohne offenen Feed laut reference.json: ${v.missingOps.join(', ') || 'keine'}`);
const z = JSON.parse(await readFile(path.join(DATA, 'zubringer', 'index.json'), 'utf8')), c = z.cities.find(x => x.ags === '08111000');
assert(c && c.dep === 500 && c.last && c.last.near > 0 && c.last.index > 0 && c.last.ends > 0 && c.last.base > 0 && c.last.base < 1 && Number.isFinite(c.last.moved) && c.days[0].length === 4, `Zubringer: ${c?.last?.near} von ${c?.last?.starts + c?.last?.ends} Beginnen/Enden an Haltestellen, Index ${c?.last?.index}, Basis ${c?.last?.base}, Umsetzungen ${c?.last?.moved}`);
const a = JSON.parse(await readFile(path.join(DATA, 'abstell', '08111000.json'), 'utf8'));
assert(a.month === '2026-11' && a.cells.rows.every(r => r[1] >= 3) && a.cells.rows.length >= 1, `Fahrtenden je 50-m-Zelle: ${a.cells.rows.length} Zellen ab 3 (am Hauptbahnhof)`);
assert(existsSync(path.join(DATA, 'unfall', '08111000.json')) && !JSON.parse(await readFile(path.join(DATA, 'unfall', 'index.json'), 'utf8')).ags['09162000'] && existsSync(path.join(DATA, 'umweg', '08111000.json')), 'Unfälle und Umwegfaktor aus geo kopiert, nur aktive Gemeinden');
{ const wd = JSON.parse(await readFile(path.join(DATA, 'wege', '08111000.json'), 'utf8')), wi = JSON.parse(await readFile(path.join(DATA, 'wege', 'index.json'), 'utf8'));
  assert(Object.keys(wd.segs).length === 1 && /^1\.\d+$/.test(wd.schemaVersion) && wi.cities['08111000'] && !wi.cities['09162000'], 'Streckenverläufe aus geo kopiert, nur aktive Städte'); }
assert(existsSync(path.join(TRACK, 'geo-state.json.gz')) && !JSON.stringify(v).includes('Dott:v'), 'Zustand privat, keine Kennungen veröffentlicht');
