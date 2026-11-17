#!/usr/bin/env node
// Synthetischer ÖPNV-Datenstand für die Browser-Tests (test/fixtures/oepnv-synth), solange der Datenstand des Fixtures keine echten Dateien
// unter oepnv/ enthält. Stationen, Stunden, Fahrzeugwege und Wirkung sind ausgedacht und nur für Layout, Rechenwege und Textbausteine gedacht.
//   node scripts/oepnv-fixture.mjs [--out test/fixtures/oepnv-synth]
// make-fixture.mjs kopiert diese Dateien in das Fixture, wenn der Datenstand keine echten ÖPNV-Dateien enthält.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { NETZ, NETZ_LICENSE, NETZ_ATTRIBUTION, LIVE_FIELDS, STATION_FIELDS } from '../lib/pulse-oepnv-netz.js';
import { SCHEMA } from '../lib/pulse-schema.js';
import { LINE_FIELDS, JETZT, JETZT_FIELDS } from '../lib/pulse-oepnv-linien.js';
import { encodePolyline, segKey, netOf } from '../lib/pulse-oepnv-wege.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname), args = process.argv.slice(2);
const OUT = path.resolve(ROOT, args.includes('--out') ? args[args.indexOf('--out') + 1] : 'test/fixtures/oepnv-synth');
const fx = JSON.parse(await readFile(path.join(ROOT, 'test/fixtures/web-data/FIXTURE.json'), 'utf8'));
let seed = 13; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const r5 = (/** @type {number} */ x) => Math.round(x * 1e5) / 1e5, sv = SCHEMA.oepnv, head = { license: NETZ_LICENSE, attribution: NETZ_ATTRIBUTION };
const put = async (/** @type {string} */ f, /** @type {any} */ v) => { const p = path.join(OUT, f); await mkdir(path.dirname(p), { recursive: true }); await writeFile(p, JSON.stringify(v)); };

const NAMES = ['Hauptbahnhof', 'Schlossplatz', 'Charlottenplatz', 'Rotebühlplatz', 'Berliner Platz', 'Feuersee', 'Schwabstraße', 'Marienplatz', 'Olgaeck', 'Staatsgalerie', 'Neckartor', 'Stöckach',
  'Pragsattel', 'Wilhelma', 'Bad Cannstatt', 'Mercedesstraße', 'Vaihingen', 'Universität', 'Österfeld', 'Degerloch', 'Möhringen', 'Feuerbach', 'Zuffenhausen', 'Killesberg'];
const C = { '08111000': [48.7758, 9.1829], '08416041': [48.5216, 9.0576] };
const cities = /** @type {Record<string, number[]>} */ ({}), wirk = [];
for (const ags of fx.ags) {
  const [la0, lo0] = C[ags] || C['08111000'], nSt = ags === '08111000' ? 24 : 8, days = 2.6;
  const st = Array.from({ length: nSt }, (_, i) => { const a = i * 2.4, r = 0.004 + 0.0022 * i; return { id: `syn:${ags}:${i}`, name: `${ags === '08111000' ? NAMES[i] : `Haltestelle ${i + 1}`} (synthetisch)`, lat: r5(la0 + r * Math.cos(a) * 0.7), lon: r5(lo0 + r * Math.sin(a)) }; });
  const rows = st.map((s, i) => {
    const halte = Math.round((900 - 30 * i) * (0.7 + rnd() * 0.6)), q = 0.02 + 0.2 * rnd() * (i % 5 === 0 ? 1.6 : 0.6), aus = Math.round(halte * q * 0.3), spaet = Math.round(halte * q * 0.7);
    const ht = Math.round(halte / days * 0.7); return [s.id, s.name, s.lat, s.lon, halte, aus, spaet, Math.round((1 + 5 * q * 4) * 10) / 10, ht, Math.round(ht * q * 0.3), Math.round(ht * q * 0.7)];
  }).sort((a, b) => +b[4] - +a[4]);
  const H = { days: fx.days, n: /** @type {number[][]} */ ([]), skip: /** @type {number[][]} */ ([]), late: /** @type {number[][]} */ ([]), flag: /** @type {number[][]} */ ([]), cancel: /** @type {number[]} */ ([]) };
  const lastHour = new Date(fx.at).getUTCHours() + 1; // Ortsstunde (MEZ) des Fixture-Stands
  fx.days.forEach((/** @type {string} */ _d, /** @type {number} */ di) => {
    const n = [], sk = [], la = [], fl = [];
    for (let h = 0; h < 24; h++) {
      const on = h >= 5 && (di < fx.days.length - 1 || h <= lastHour), v = on ? Math.round((nSt * 14) * (h >= 7 && h <= 9 || h >= 16 && h <= 18 ? 1.5 : 1) * (0.9 + 0.2 * rnd())) : 0;
      const bad = on && ((di === 1 && h >= 7 && h <= 9) || (di === fx.days.length - 1 && h === 16)), s = Math.round(v * (bad ? 0.18 : 0.012)), l = Math.round(v * (bad ? 0.22 : 0.06));
      n.push(v); sk.push(s); la.push(l); fl.push(v >= NETZ.minHourN && (s / v >= 0.15 || l / v >= 0.3) ? 1 : 0);
    }
    H.n.push(n); H.skip.push(sk); H.late.push(la); H.flag.push(fl); H.cancel.push(di === 1 ? 31 : 6);
  });
  const lines = Array.from({ length: ags === '08111000' ? 18 : 4 }, (_, i) => { const art = ['bus', 'tram', 'sbahn'][i % 3], h = Math.round((1400 - 60 * i) * (0.8 + 0.4 * rnd())), q = 0.03 + 0.25 * rnd() * (i % 4 === 0 ? 1.5 : 0.5); return [`${art === 'sbahn' ? 'S' : art === 'tram' ? 'U' : ''}${i + 1}${art === 'bus' ? 0 : ''}`, art, h, Math.round(h * q * 0.3), Math.round(h * q * 0.7), Math.round((1 + 18 * q) * 10) / 10, Math.round(h / days * 0.7), 0, 0]; });
  const pPt = Array.from({ length: 24 }, (_, h) => (h >= 5 ? Math.round(nSt * 14 * (h >= 7 && h <= 9 || h >= 16 && h <= 18 ? 1.5 : 1) * (h >= 22 ? 0.3 : 1)) : h === 0 ? Math.round(nSt * 2.5) : 0)), pSh = Array.from({ length: 24 }, (_, h) => Math.round((ags === '08111000' ? 60 : 8) * (h < 5 ? 0.25 : h >= 22 ? 0.6 : 0.5 + 0.5 * Math.sin((h - 5) / 17 * Math.PI)) * 10) / 10);
  const pk = Math.max(...pPt), profile = { days: 2, pt: pPt, sharing: pSh, gap: pPt.map((x, h) => (x < 0.25 * pk && pSh[h] >= 3 ? h : -1)).filter(h => h >= 0), gapShare: 0.25, minSharing: 3 };
  await put(`${ags}.json`, { schemaVersion: sv, ags, at: fx.at, feedAt: fx.at - 40e3, ...head, halfLifeDays: NETZ.halfLifeDays, days, stations: nSt + 40, fields: STATION_FIELDS, rows, hours: H, lines: { fields: LINE_FIELDS, rows: lines }, profile, jetzt: { windowH: JETZT.windowH, minN: JETZT.minN, fields: JETZT_FIELDS, rows: st.filter((_, i) => i % 4 === 1).slice(0, 5).map((s, i) => [s.id, s.name, s.lat, s.lon, 40 - 4 * i, 6 - i, 9 - i]) } });
  // Fahrzeugwege: je Fahrt 5 bis 8 Stationen in Folge, Start bis 10 Minuten vor dem Stand, Halte alle 2 bis 4 Minuten
  const trips = [], ARTEN = ['bus', 'bus', 'ubahn', 'sbahn', 'bus', 'regio', 'tram', 'fern'];
  for (let k = 0; k < (ags === '08111000' ? 60 : 12); k++) {
    const len = 5 + Math.floor(rnd() * 4), from = Math.floor(rnd() * nSt), step = 1 + Math.floor(rnd() * 3), w = [], qs = []; let dt = -Math.round(rnd() * 600);
    for (let j = 0; j < len; j++) { const s = st[(from + j * step) % nSt]; qs.push((from + j * step) % nSt); w.push(s.lat, s.lon, dt); dt += 120 + Math.round(rnd() * 120); }
    const art = ARTEN[k % 8], dl = k % 9 === 0 ? null : k % 5 === 0 ? 300 + Math.round(rnd() * 400) : k % 3 === 0 ? 130 + Math.round(rnd() * 100) : Math.round(rnd() * 60);
    // seit Format 1.5: jede siebte Fahrt mit einem ausgefallenen Halt (Station zwischen erstem und letztem Punkt; ohne Zufallszahl, damit der übrige Stand gleich bleibt)
    const gone = k % 7 === 3 ? [[st[(from + 1) % nSt].lat, st[(from + 1) % nSt].lon]].flat() : null;
    // seit 1.6: Ziel (jede sechste ohne) und je Punkt die Station als Index in names (hier: alle Stationen der Stadt)
    trips.push([k % 11 === 0 ? null : `${{ sbahn: 'S', ubahn: 'U', regio: 'RE', fern: 'IC' }[art] || ''}${1 + (k % 14)}${art === 'bus' ? 0 + (k % 3) : ''}`, art, dl, w, gone, k % 6 === 5 ? null : st[qs[qs.length - 1]].name, qs]);
  }
  // ganz ausgefallene Fahrten: zwei mit Zeit im Fenster (gestrichelt), drei ohne Uhrzeit im Strom
  const cw = (/** @type {number} */ from, /** @type {number} */ dt0) => st.slice(from, from + 4).flatMap((s, j) => [s.lat, s.lon, dt0 + j * 180]);
  const ausfall = ags === '08111000' ? { fields: ['linie', 'art', 'weg', 'ziel'], rows: [['U5', 'ubahn', cw(2, 240), st[5].name], ['S3', 'sbahn', cw(10, -300), null]], lineFields: ['linie', 'art', 'fahrten', 'ohne_zeit'], lines: [['U5', 'ubahn', 2, 1], ['42', 'bus', 2, 2], ['S3', 'sbahn', 1, 0]] } : null;
  await put(`live/${ags}.json`, { schemaVersion: sv, ags, at: fx.at, feedAt: fx.at - 40e3, aheadMin: NETZ.aheadMin, ...head, fields: LIVE_FIELDS, trips, names: st.map(x => x.name), ausfall });
  // Streckenverläufe (wege/, Geo-Lauf): je Abschnitt ein Bogen über einen versetzten Mittelpunkt, jeder fünfte Abschnitt fehlt (dann Luftlinie)
  if (ags === '08111000') {
    const segs = /** @type {Record<string, string>} */ ({}); let m = 0;
    for (const row of [...trips, ...ausfall.rows.map(r => [r[0], r[1], null, r[2]])]) { const art = /** @type {string} */ (row[1]), w = /** @type {number[]} */ (row[3]); for (let i = 3; i + 2 < w.length; i += 3) {
      const a = [w[i - 3], w[i - 2]], b = [w[i], w[i + 1]], key = segKey(netOf(art) || 'r', a[0], a[1], b[0], b[1]); if (segs[key] || (m++ % 5) === 4) continue;
      const mid = [r5((a[0] + b[0]) / 2 + (b[1] - a[1]) * 0.25), r5((a[1] + b[1]) / 2 - (b[0] - a[0]) * 0.25)]; segs[key] = encodePolyline([a, mid, b]);
    } }
    await put(`wege/${ags}.json`, { schemaVersion: SCHEMA.geo, ags, at: fx.at, day: '20261117', attribution: '© OpenStreetMap-Mitwirkende (ODbL); Fahrplan: gtfs.de (DELFI e. V. u. a.), CC BY 4.0 (synthetisch)', license: 'ODbL 1.0', stats: { pairs: Object.keys(segs).length, routed: Object.keys(segs).length }, segs });
  }
  const today = fx.days.length - 1, sum = (/** @type {number[]} */ a) => a.reduce((s, x) => s + x, 0);
  cities[ags] = [nSt + 40, sum(H.n[today]), sum(H.skip[today]), sum(H.late[today]), trips.length];
  wirk.push(ags === '08111000' ? { ags, days: 4, hours: 9, effect: 0.137, ci: [0.021, 0.253], verdict: 'mehr' } : { ags, days: 1, hours: 2, effect: 0.06, verdict: 'zu wenig Tage' });
}
await put('wirkung.json', { schemaVersion: sv, at: fx.at, days: fx.days, rule: 'synthetisch', pooled: { effect: 0.112, ci: [0.018, 0.206], cityDays: 5, hours: 11, cities: wirk.length, verdict: 'mehr' }, cities: wirk,
  learn: { since: fx.days.at(-1), until: '2026-11-20', k: 5, pooled: { effect: 0.09, cityDays: 5 }, fields: ['tage', 'wirkung', 'mittel_stadt'], cities: { '08111000': [4, 0.116, 0.137], '08416041': [1, 0.085, 0.06] } } });
await put('index.json', { schemaVersion: sv, at: fx.at, feedAt: fx.at - 40e3, ...head, aheadMin: NETZ.aheadMin, days: 2.6, fields: ['stationen', 'halte_heute', 'ausgefallen_heute', 'verspaetet_heute', 'fahrzeuge'], cities, trips: Object.values(cities).reduce((s, r) => s + r[4], 0), withRoute: Object.values(cities).reduce((s, r) => s + r[4], 0) - 7 });
await writeFile(path.join(OUT, 'README.md'), '# Synthetischer ÖPNV-Stand\n\nErzeugt von `scripts/oepnv-fixture.mjs`. Stationen, Stunden, Fahrzeugwege und Wirkung sind ausgedacht; nur für die Browser-Tests.\n');
console.log(`ÖPNV-Fixture: ${Object.keys(cities).length} Gemeinden → ${path.relative(ROOT, OUT)}/`);
