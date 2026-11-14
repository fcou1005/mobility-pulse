#!/usr/bin/env node
// Sprint 8: synthetischer Geo-Datenstand für die Browser-Tests (test/fixtures/geo-synth), solange der Workflow „Geo“ noch keine echten
// Dateien geliefert hat. Erzeugt Zensus, Unfallatlas, Fahrplan und Fußwegenetz als Ersatzquellen für die Gemeinden des Fixtures, lässt
// scripts/geo.mjs dagegen laufen (Ersatz-Server auf 127.0.0.1:8794) und spielt danach einen Tag Sammler-Läufe (Phase geo) mit einer
// erfundenen Flotte ab. Die Zahlen sind ausgedacht und nur für Layout, Rechenwege und Textbausteine gedacht.
//   node scripts/geo-fixture.mjs [--out test/fixtures/geo-synth]
// make-fixture.mjs kopiert diese Dateien in das Fixture, wenn der Datenstand keine echten Geo-Dateien enthält.
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import * as P from '../lib/pulse-geo-proj.js';
import { muniLocator } from '../lib/pulse-geo-pop.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname), args = process.argv.slice(2);
const OUTF = path.resolve(ROOT, args.includes('--out') ? args[args.indexOf('--out') + 1] : 'test/fixtures/geo-synth');
const FIX = path.join(ROOT, 'test/fixtures/web-data'), PORT = 8794;
let seed = 8111; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const T = await mkdtemp(path.join(tmpdir(), 'geo-fix-')), DATA = path.join(T, 'data'), GEOB = path.join(T, 'geo'), SRV = path.join(T, 'srv'), TRACK = path.join(T, 'track');
for (const d of [path.join(DATA, 'boundaries'), SRV, TRACK]) await mkdir(d, { recursive: true });
const B = JSON.parse(await readFile(path.join(FIX, 'boundaries', 'BW.json'), 'utf8')), latest = JSON.parse(await readFile(path.join(FIX, 'latest.json'), 'utf8'));
await writeFile(path.join(DATA, 'boundaries', 'BW.json'), JSON.stringify(B));
await writeFile(path.join(DATA, 'boundaries', 'index.json'), await readFile(path.join(FIX, 'boundaries', 'index.json'), 'utf8'));
await writeFile(path.join(DATA, 'latest.json'), JSON.stringify(latest));
const loc = muniLocator(B.features);
const CENTRE = { '08111000': [48.7758, 9.1829], '08416041': [48.5216, 9.0576] };
const HOT = { '08111000': [[48.7840, 9.1820], [48.7765, 9.1855], [48.8000, 9.2160], [48.7726, 9.1665], [48.7270, 9.1080], [48.8330, 9.1480]], '08416041': [[48.5160, 9.0560], [48.5205, 9.0530]] };
/** @type {Record<string, Array<[string, number, number, number]>>} */
const STOPS = { '08111000': [['Hauptbahnhof', 48.7840, 9.1820, 900], ['Charlottenplatz', 48.7765, 9.1855, 600], ['Bad Cannstatt Bf', 48.8000, 9.2160, 400], ['Feuersee', 48.7726, 9.1665, 250], ['Vaihingen Bf', 48.7270, 9.1080, 300], ['Zuffenhausen', 48.8330, 9.1480, 200], ['Degerloch', 48.7480, 9.1690, 150], ['Untertürkheim', 48.7850, 9.2500, 120]],
  '08416041': [['Tübingen Hbf', 48.5160, 9.0560, 300], ['Europaplatz', 48.5165, 9.0590, 120], ['Wanne', 48.5330, 9.0670, 80], ['WHO', 48.5350, 9.0360, 70]] };
const UCODE = { '08111000': [8, 1, 11, 0], '08416041': [8, 4, 16, 41] };

// ---------- Zensus: 200-m-Raster in LAEA, Dichte nimmt zum Rand ab, Parks und Wald als Lücken ----------
const pts = { '08111000': [], '08416041': [] };
const censusLines = ['GITTER_ID_100m;x_mp_100m;y_mp_100m;Einwohner'];
for (const f of B.features) {
  const ags = f.properties.ags, ring = f.geometry.coordinates[0], ll = ring.map(([lo, la]) => P.toLaea(la, lo));
  const xs = ll.map(p => p[0]), ys = ll.map(p => p[1]), raw = [];
  for (let x = Math.floor(Math.min(...xs) / 200) * 200 + 50; x < Math.max(...xs); x += 200) for (let y = Math.floor(Math.min(...ys) / 200) * 200 + 50; y < Math.max(...ys); y += 200) {
    const [la, lo] = P.fromLaea(x, y); if (loc(la, lo) !== ags || rnd() < 0.28) continue;
    const d = P.distM(la, lo, ...CENTRE[ags]); raw.push([x, y, la, lo, Math.exp(-d / (ags === '08111000' ? 3800 : 2200)) * (0.5 + rnd())]);
  }
  const target = Math.round(f.properties.pop * 0.993), sum = raw.reduce((a, r) => a + r[4], 0);
  let left = target; raw.forEach((r, i) => { const ew = i === raw.length - 1 ? Math.max(3, left) : Math.max(3, Math.round(r[4] / sum * target)); left -= ew; r[4] = ew; });
  for (const [x, y, la, lo, ew] of raw) { censusLines.push(`CRS3035RES100mN${y - 50}E${x - 50};${x};${y};${ew}`); pts[ags].push([la, lo, ew]); }
}
const csvName = 'Zensus2022_Bevoelkerungszahl_100m-Gitter.csv';
await writeFile(path.join(SRV, csvName), censusLines.join('\n') + '\n'); execFileSync('zip', ['-qj', path.join(SRV, 'zensus.zip'), path.join(SRV, csvName)]);
const pickPt = (ags) => { const l = pts[ags], tot = l.reduce((a, p) => a + p[2], 0); let r = rnd() * tot; for (const p of l) if ((r -= p[2]) <= 0) return p; return l.at(-1); };

// ---------- Unfallatlas 2021–2024 ----------
const YEARS = [2021, 2022, 2023, 2024];
for (const y of YEARS) {
  const l = ['OBJECTID;UIDENTSTLAE;ULAND;UREGBEZ;UKREIS;UGEMEINDE;UJAHR;UMONAT;USTUNDE;UWOCHENTAG;UKATEGORIE;UART;UTYP1;ULICHTVERH;IstRad;IstPKW;IstFuss;IstKrad;IstGkfz;IstSonstige;LINREFX;LINREFY;XGCSWGS84;YGCSWGS84;STRZUSTAND'];
  let id = 1;
  const row = (ags, la, lo) => { const [L, R, K, G] = UCODE[ags], k = rnd(), kat = k < 0.01 ? 1 : k < 0.16 ? 2 : 3, fl = (p) => (rnd() < p ? 1 : 0);
    l.push(`${id++};x;${L};${R};${K};${G};${y};${1 + Math.floor(rnd() * 12)};${Math.floor(rnd() * 24)};${1 + Math.floor(rnd() * 7)};${kat};5;1;0;${fl(0.3)};1;${fl(0.15)};${fl(0.1)};0;${fl(0.08)};1;2;${lo.toFixed(6).replace('.', ',')};${la.toFixed(6).replace('.', ',')};0`); };
  for (const [ags, n] of Object.entries({ '08111000': 620, '08416041': 130 })) for (let i = 0; i < n; i++) {
    if (rnd() < 0.4) { const h = HOT[ags][Math.floor(rnd() * HOT[ags].length)]; row(ags, h[0] + gauss() * 0.0012, h[1] + gauss() * 0.0017); } else { const p = pickPt(ags); row(ags, p[0] + (rnd() - 0.5) * 0.0018, p[1] + (rnd() - 0.5) * 0.0027); }
  }
  await writeFile(path.join(SRV, `Unfallorte${y}_LinRef.csv`), l.join('\r\n') + '\r\n'); execFileSync('zip', ['-qj', path.join(SRV, `unfall-${y}.zip`), path.join(SRV, `Unfallorte${y}_LinRef.csv`)]);
}

// ---------- Fahrplan (GTFS) ----------
{
  const gd = path.join(SRV, 'g'); await mkdir(gd);
  const stops = ['stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station'], trips = ['route_id,service_id,trip_id'], st = ['trip_id,arrival_time,departure_time,stop_id,stop_sequence'];
  let tid = 0;
  for (const list of Object.values(STOPS)) for (const [name, la, lo, dep] of list) {
    const sid = `S${stops.length}`; stops.push(`${sid},"${name}",${la},${lo},0,`);
    for (let k = 0; k < dep; k++) { const t = `T${tid++}`, m = 300 + Math.floor((k / dep) * 1140), hh = String(Math.floor(m / 60)).padStart(2, '0'), mm = String(m % 60).padStart(2, '0'); trips.push(`r,wk,${t}`); st.push(`${t},${hh}:${mm}:00,${hh}:${mm}:00,${sid},1`); }
  }
  await writeFile(path.join(gd, 'calendar.txt'), 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nwk,1,1,1,1,1,0,0,20200101,20301231\n');
  await writeFile(path.join(gd, 'stops.txt'), stops.join('\n') + '\n'); await writeFile(path.join(gd, 'trips.txt'), trips.join('\n') + '\n'); await writeFile(path.join(gd, 'stop_times.txt'), st.join('\n') + '\n');
  execFileSync('zip', ['-qj', path.join(SRV, 'gtfs.zip'), ...['calendar.txt', 'trips.txt', 'stops.txt', 'stop_times.txt'].map(f => path.join(gd, f))]);
}

// ---------- Fußwegenetz: Raster über der Abfrage-Box, quer durch die Mitte ein „Fluss“ mit Brücken nur jede achte Spalte ----------
function gridFor(s, w, n, e) {
  const NI = Math.min(320, Math.max(30, Math.ceil(P.distM(s, w, n, w) / 70))), NJ = Math.min(320, Math.max(30, Math.ceil(P.distM(s, w, s, e) / 70)));
  const els = [], nid = (i, j) => i * 1000 + j + 1, mid = NI >> 1; let id = 1;
  for (let i = 0; i < NI; i++) for (let j = 0; j < NJ; j++) els.push({ type: 'node', id: nid(i, j), lat: s + (n - s) * i / (NI - 1), lon: w + (e - w) * j / (NJ - 1) });
  for (let i = 0; i < NI; i++) els.push({ type: 'way', id: 1e6 + id++, nodes: Array.from({ length: NJ }, (_, j) => nid(i, j)) });
  for (let j = 0; j < NJ; j++) {
    if (j % 8 === 0) els.push({ type: 'way', id: 1e6 + id++, nodes: Array.from({ length: NI }, (_, i) => nid(i, j)) });
    else { els.push({ type: 'way', id: 1e6 + id++, nodes: Array.from({ length: mid }, (_, i) => nid(i, j)) }); els.push({ type: 'way', id: 1e6 + id++, nodes: Array.from({ length: NI - mid - 1 }, (_, i) => nid(mid + 1 + i, j)) }); }
  }
  return { elements: els };
}
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/overpass') {
    let body = ''; for await (const c of req) body += c;
    const m = /\(([\d.]+),([\d.]+),([\d.]+),([\d.]+)\)/.exec(decodeURIComponent(body.replace(/\+/g, ' ')));
    res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(m ? gridFor(+m[1], +m[2], +m[3], +m[4]) : { elements: [] }));
  }
  if (u.pathname.startsWith('/route/')) {
    const m = /([\d.]+),([\d.]+);([\d.]+),([\d.]+)/.exec(u.pathname); res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ code: 'Ok', routes: [{ distance: P.distM(+m[2], +m[1], +m[4], +m[3]) * 1.32 }] }));
  }
  try { res.end(await readFile(path.join(SRV, u.pathname.slice(1)))); } catch { res.statusCode = 404; res.end(); }
});
await new Promise(r => server.listen(PORT, '127.0.0.1', () => r(null)));
const base = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, GEO_FORCE: '1', GEO_ZENSUS_URL: `${base}/zensus.zip`, GEO_UNFALL_URL: `${base}/unfall-{y}.zip`, GEO_GTFS_URL: `${base}/gtfs.zip`, GEO_OVERPASS: `${base}/overpass`, GEO_ROUTER: `${base}/route`, GEO_UMWEG_CITIES: '2', GEO_PAUSE_MS: '0', GEO_NOW: String(Date.parse('2026-11-12T05:00:00Z')) };
const res = await new Promise((ok) => { let s = ''; const p = spawn(process.execPath, [path.join(ROOT, 'scripts/geo.mjs'), DATA, GEOB], { env }); p.stdout.on('data', d => { s += d; }); p.stderr.on('data', d => { s += d; }); p.on('close', c => ok({ c, s })); });
server.close();
if (res.c) { console.error(res.s); process.exit(1); }
console.log(res.s.trim().split('\n').slice(-8).join('\n'));

// ---------- ein Tag Sammler-Läufe (12.11. 7:00–22:00 alle 30 Minuten, dazu zwei Läufe am 13.11.) ----------
process.env.GEO_BASE = GEOB;
const { run } = await import('./collect/29-geo.mjs');
const { snapFromVehicles } = await import('../lib/pulse-akku-learn.js');
/** @type {Record<string, Array<[string, string, number]>>} */
const OPS = { '08111000': [['Bolt', 'scooter', 260], ['Dott', 'scooter', 280], ['Lime', 'scooter', 340], ['Voi', 'scooter', 360], ['RegioRad Stuttgart', 'bike', 150]], '08416041': [['Bolt', 'scooter', 85], ['Voi', 'scooter', 95]] };
const vkey = (op, id) => `${op}:${id}`;
let idn = 0, fleet = [];
for (const [ags, ops] of Object.entries(OPS)) for (const [op, type, n] of ops) for (let i = 0; i < n; i++) {
  const p = rnd() < 0.15 ? HOT[ags][Math.floor(rnd() * HOT[ags].length)] : pickPt(ags);
  fleet.push({ operator: op, rawId: `x${idn++}`, lat: p[0] + (rnd() - 0.5) * 0.0016, lon: p[1] + (rnd() - 0.5) * 0.0024, batteryPct: 30 + Math.floor(rnd() * 70), type, ags, disabled: false, reserved: false });
}
const ends = (ags) => { if (rnd() < 0.45) { const s = STOPS[ags][Math.floor(rnd() * STOPS[ags].length)]; return [s[1] + (rnd() - 0.5) * 0.0018, s[2] + (rnd() - 0.5) * 0.0027]; } const p = pickPt(ags); return [p[0] + (rnd() - 0.5) * 0.001, p[1] + (rnd() - 0.5) * 0.0015]; };
const times = []; for (let m = 0; m <= 15 * 60; m += 30) times.push(Date.parse('2026-11-12T06:00:00Z') + m * 60e3);
times.push(Date.parse('2026-11-13T06:05:00Z'), Date.parse('2026-11-13T06:35:00Z'));
let prev = null, prevAt = null; const logs = [];
for (const [k, now] of times.entries()) {
  if (k) fleet = fleet.map(v => { if (rnd() >= 0.06) return v; const [la, lo] = ends(v.ags); return v.operator === 'RegioRad Stuttgart' ? { ...v, lat: la, lon: lo } : { ...v, rawId: `x${idn++}`, lat: la, lon: lo }; });
  await run({ DATA, TRACK_DIR: TRACK, now, log: (...m) => logs.push(m.join(' ')), dv: { vehicles: fleet }, vkey, sourceOut: [], akkuPrev: prev ? { snap: prev, at: prevAt } : null, latest });
  prev = snapFromVehicles(fleet, vkey); prevAt = now;
}
console.log(logs.filter(l => l.startsWith('Geo:')).slice(-2).join('\n'));

// ---------- ablegen ----------
await rm(OUTF, { recursive: true, force: true }); await mkdir(OUTF, { recursive: true });
for (const d of ['versorgung', 'zubringer', 'abstell', 'unfall', 'umweg', 'pop']) await cp(path.join(DATA, d), path.join(OUTF, d), { recursive: true }).catch(() => {});
await writeFile(path.join(OUTF, 'README.md'), '# Synthetischer Geo-Datenstand\n\nErzeugt von `scripts/geo-fixture.mjs` für die Browser-Tests der Ansicht Umfeld. Alle Zahlen sind ausgedacht (Raster-Einwohner, zufällige Unfälle, erfundene Flotte). `scripts/make-fixture.mjs` kopiert sie ins Fixture, solange der Datenstand keine echten Geo-Dateien hat.\n');
await rm(T, { recursive: true, force: true });
console.log(`geschrieben nach ${path.relative(ROOT, OUTF)}`);
