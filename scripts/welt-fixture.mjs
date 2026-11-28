#!/usr/bin/env node
// Synthetischer Länder-Datenstand für die Browser-Tests (test/fixtures/welt-synth), solange der Datenstand des Fixtures keine echten Dateien
// unter welt/ enthält. Frankreich (frei abgestellt und Stationen) und Japan (nur Stationen) mit ausgedachten Systemen; nur für Layout und Texte.
//   node scripts/welt-fixture.mjs [--out test/fixtures/welt-synth]
// make-fixture.mjs kopiert diese Dateien in das Fixture, wenn der Datenstand keine echten Länder-Dateien enthält.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import * as W from '../lib/pulse-welt.js';
import { SCHEMA } from '../lib/pulse-schema.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname), args = process.argv.slice(2);
const OUT = path.resolve(ROOT, args.includes('--out') ? args[args.indexOf('--out') + 1] : 'test/fixtures/welt-synth');
const fx = JSON.parse(await readFile(path.join(ROOT, 'test/fixtures/web-data/FIXTURE.json'), 'utf8'));
let seed = 41; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const r5 = (/** @type {number} */ x) => Math.round(x * 1e5) / 1e5;
const put = async (/** @type {string} */ f, /** @type {any} */ v) => { const p = path.join(OUT, f); await mkdir(path.dirname(p), { recursive: true }); await writeFile(p, JSON.stringify({ schemaVersion: SCHEMA.welt, ...v })); };
const at = fx.at;
/** @type {Record<string, Array<{ id: string, name: string, city: string, op: string, ff: number, st: number, c: [number, number], lic: string|null }>>} */
const LANDS = {
  FR: [{ id: 'fr_lime_paris', name: 'Lime Paris', city: 'Paris', op: 'Lime', ff: 120, st: 0, c: [48.86, 2.35], lic: null }, { id: 'fr_velib', name: 'Vélib\' Métropole', city: 'Paris', op: 'Vélib\'', ff: 0, st: 40, c: [48.85, 2.34], lic: 'ODbL-1.0' },
    { id: 'fr_velov', name: 'Vélo\'v', city: 'Lyon', op: 'Cyclocity (JCDecaux)', ff: 0, st: 25, c: [45.76, 4.84], lic: 'ODbL-1.0' }, { id: 'fr_dott_lyon', name: 'Dott Lyon', city: 'Lyon', op: 'Dott', ff: 60, st: 0, c: [45.75, 4.85], lic: 'CC0-1.0' }],
  JP: [{ id: 'docomo-cycle-tokyo', name: 'docomo bike share service', city: 'Tokyo', op: 'docomo bike share', ff: 0, st: 50, c: [35.68, 139.76], lic: 'CC-BY-4.0' }],
};
/** @type {any[]} */
const countries = [];
for (const [cc, systems] of Object.entries(LANDS)) {
  const tz = W.COUNTRIES[cc], { day } = W.localDayHour(at, tz), nowH = W.localDayHour(at, tz).h;
  /** @type {any[][]} */
  const rows = [], stations = [];
  /** @type {Array<[number, number]>} */
  const free = [];
  const dayDoc = { version: W.WELT.version, land: cc, day, tz, fields: W.HOUR_FIELDS, sys: {} };
  // sieben Vortage (für Prognose und Selbstprüfung), der letzte davon ist „gestern“
  const past = Array.from({ length: 7 }, (_, i) => W.localDayHour(at - (7 - i) * 86400e3, tz).day).map(d => ({ version: W.WELT.version, land: cc, day: d, tz, fields: W.HOUR_FIELDS, sys: {} }));
  for (const s of systems) {
    let avail = s.ff, empty = 0, full = 0;
    for (let i = 0; i < s.ff; i++) free.push([r5(s.c[0] + (rnd() - 0.5) * 0.04), r5(s.c[1] + (rnd() - 0.5) * 0.06)]);
    for (let i = 0; i < s.st; i++) { const cap = 10 + Math.floor(rnd() * 15), b = rnd() < 0.15 ? 0 : rnd() > 0.9 ? cap : Math.floor(rnd() * cap); avail += b; if (b === 0) empty++; if (b === cap) full++; stations.push([s.id, r5(s.c[0] + (rnd() - 0.5) * 0.04), r5(s.c[1] + (rnd() - 0.5) * 0.06), b, cap - b, i === 3 ? 1 : 0]); }
    const types = s.ff ? { scooter: s.ff } : { bike: avail };
    rows.push([s.id, s.name, s.city, s.op, true, avail, Math.floor(avail / 30), s.st, empty, full, types, s.lic, s.lic ? 'https://example.org/lizenz' : null, at, null]);
    const curve = (/** @type {number} */ h) => 0.3 + Math.exp(-((h - 8) ** 2) / 3) + 0.8 * Math.exp(-((h - 18) ** 2) / 4);
    for (const [doc, hours] of /** @type {Array<[any, number]>} */ ([[dayDoc, nowH + 1], ...past.map(p => [p, 24])])) for (let h = 0; h < hours; h++) for (let r = 0; r < 3; r++) {
      const out = Math.round(curve(h) * avail * 0.03 * (0.8 + rnd() * 0.4));
      W.addHour(doc, s.id, h, { avail: Math.round(avail * (1.1 - curve(h) * 0.15)), stations: s.st, empty: Math.round(empty * (0.8 + curve(h) * 0.4)), full, out, in: Math.round(out * (0.9 + rnd() * 0.2)), min: 20 });
    }
  }
  rows.sort((a, b) => b[5] - a[5]);
  const totals = rows.reduce((t, r) => { t.avail += r[5]; t.disabled += r[6]; t.stations += r[7]; t.empty += r[8]; t.full += r[9]; for (const [k, n] of Object.entries(r[10])) t.types[k] = (t.types[k] || 0) + n; return t; }, { avail: 0, disabled: 0, stations: 0, empty: 0, full: 0, types: /** @type {Record<string, number>} */ ({}) });
  const today = { out: 0, in: 0, min: 0 }; for (const rs of Object.values(dayDoc.sys)) { let m = 0; for (const r of /** @type {number[][]} */ (rs)) { today.out += r[6]; today.in += r[7]; m += r[8]; } today.min = Math.max(today.min, m); }
  const cities = W.citiesOf(rows).map(c => [c.city, c.systems, c.avail, c.stations, c.ops, c.types]);
  const hist = [...past, dayDoc].map(d => ({ day: d.day, hours: W.hourly(d) })), tomorrow = W.localDayHour(at + 86400e3, tz).day;
  const targets = [...Array.from({ length: 23 - nowH }, (_, i) => ({ day, h: nowH + 1 + i })), ...Array.from({ length: 24 }, (_, i) => ({ day: tomorrow, h: i }))];
  const r1 = (/** @type {number|null} */ x) => (x == null ? null : Math.round(x * 10) / 10);
  const forecast = { method: W.FORECAST.method, basisDays: past.length, minDays: W.FORECAST.minDays, holidays: null, dayTypes: { [day]: W.dayTypeOf(day), [tomorrow]: W.dayTypeOf(tomorrow) },
    next: W.profileForecast(hist, targets, null).filter(f => f.avail != null).map(f => [f.day, f.h, r1(f.avail), r1(f.outH), f.n]), check: W.checkDay(hist, past[past.length - 1].day, null) };
  await put(`${cc}/latest.json`, { version: W.WELT.version, land: cc, region: W.regionOf(cc), tz, at, day, ms: 1200, systemsListed: rows.length + 1, ok: rows.length, failed: 1, skipped: 0, fields: W.SYS_FIELDS,
    systems: [...rows, [`${cc.toLowerCase()}_weg`, 'Ohne Daten', rows[0][2], 'Unbekannt', false, 0, 0, 0, 0, 0, {}, null, null, null, 'discovery: HTTP 404']], cityFields: ['stadt', 'systeme', 'fahrzeuge', 'stationen', 'anbieter', 'arten'], cities, totals, today, days: [...past.map(p => p.day), day], forecast });
  await put(`${cc}/${day}.json`, dayDoc); for (const p of past) await put(`${cc}/${p.day}.json`, p);
  await put(`${cc}/punkte.json`, { version: W.WELT.version, land: cc, at, stationFields: ['sys', 'lat', 'lon', 'raeder', 'frei', 'zustand'], stations, cellFields: ['lat', 'lon', 'fahrzeuge'], cells: W.cellsOf(free) });
  countries.push({ land: cc, region: W.regionOf(cc), tz, listed: rows.length + 1, ok: rows.length, failed: 1, skipped: 0, at, ms: 1200, avail: totals.avail, stations: totals.stations, cities: cities.length, ops: new Set(rows.map(r => r[3])).size, types: totals.types, today, ranNow: true });
}
await put('index.json', { version: W.WELT.version, at, source: W.WELT.csvUrl, ms: 1500, ran: countries.length, failedProcs: 0, countries });
console.error(`[welt-fixture] ${OUT}: ${countries.map(c => `${c.land} ${c.avail}`).join(', ')}`);
