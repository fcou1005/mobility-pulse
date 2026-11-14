#!/usr/bin/env node
// Fester Datenstand für die Browser-Tests (S3.1): schneidet aus einem Datenstand (Checkout des Branches data) wenige Gemeinden und die letzten
// Tage aus, damit test/browser.mjs ohne Netz und immer gegen dieselben Zahlen prüft. Ziel unter 3 MB.
//   node scripts/make-fixture.mjs <datenstand> [--out test/fixtures/web-data] [--ags 08111000,08416041] [--days 3]
// Regeln: Objekte, deren Schlüssel überwiegend Gemeindeschlüssel sind ('08111000', '08111000|Voi|scooter', 'ags:08111000'), behalten nur die
// gewählten Gemeinden; Zeilen, die mit einem Gemeindeschlüssel beginnen, ebenso; Listen von Objekten mit ags/municipalities/gebiet.ags behalten
// Einträge der Gemeinden (und solche ohne Gebiet). Datierte Dateien nur für die gewählten Tage, Verzeichnisse (index.json) passend gekürzt.
// Sonderfälle: ops/<Land> (Zeilen verweisen auf munis[]), boundaries/<Land> (Features), zone-watch (Zonen der Gemeinden), zones/ (Verzeichnis
// leer: keine Betreiber-Geometrien im Repo). Keine Abhängigkeiten.
import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { writeArea, writeCellsCompact } from './gebiet.mjs';

const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const SRC = path.resolve(args.find(a => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--')) || 'data-branch');
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const OUT = path.resolve(ROOT, opt('out', 'test/fixtures/web-data'));
const KEEP = new Set(opt('ags', '08111000,08416041').split(','));
const NDAYS = +opt('days', 3);
const AGSKEY = /^(?:ags:)?(\d{8})(?:\|.*)?$/;
const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

const rd = async (f) => JSON.parse(await readFile(path.join(SRC, f), 'utf8'));
const has = (f) => existsSync(path.join(SRC, f));
const written = [];
async function put(f, v) { const p = path.join(OUT, f); await mkdir(path.dirname(p), { recursive: true }); const s = JSON.stringify(v); await writeFile(p, s); written.push([f, s.length]); }

const keepAgs = (a) => (Array.isArray(a) ? a.some(x => KEEP.has(x)) : KEEP.has(a));
function keepObj(o) {
  if (typeof o.ags === 'string' || Array.isArray(o.ags)) return keepAgs(o.ags);
  if (Array.isArray(o.municipalities)) return !o.municipalities.length || keepAgs(o.municipalities);
  if (o.gebiet && Array.isArray(o.gebiet.ags)) return !o.gebiet.ags.length || keepAgs(o.gebiet.ags);
  return true;
}
/** generischer Zuschnitt (siehe Kopf) */
function trim(v) {
  if (Array.isArray(v)) {
    if (v.length && v.every(isDay)) return v.filter(d => d >= DAYS[0]); // Tageslisten: nichts vor dem ersten Tag des Fixtures (Zukunft bleibt)
    if (v.length && v.every(r => Array.isArray(r))) {
      // Zeilen: Spalte mit Gemeindeschlüssel (in den ersten vier) → nur die Gemeinden; Spalte 0 Tag oder Zeitstempel → nur die gewählten Tage
      const c = [0, 1, 2, 3].find(i => v.every(r => typeof r[i] === 'string' && /^\d{8}$/.test(r[i])));
      let rows = c == null ? v : v.filter(r => KEEP.has(r[c]));
      if (rows.every(r => isDay(r[0]))) rows = rows.filter(r => r[0] >= DAYS[0]);
      else if (rows.length && rows.every(r => Number.isFinite(r[0]) && r[0] > 1.6e12 && r[0] < 2.2e12)) rows = rows.filter(r => r[0] >= T0 - 86400e3);
      return rows;
    }
    if (v.length && v.every(o => o && typeof o === 'object' && !Array.isArray(o)) && v.some(o => 'ags' in o || 'municipalities' in o || o.gebiet)) return v.filter(keepObj).map(trim);
    return v.map(trim);
  }
  if (v && typeof v === 'object') {
    const ks = Object.keys(v), agsKs = ks.filter(k => AGSKEY.test(k));
    const out = {};
    const byAgs = agsKs.length >= 3;
    const byDay = ks.filter(isDay).length >= 3; // Tagesschlüssel (z. B. forecast/series.json → days): ab dem ersten gewählten Tag
    for (const k of ks) { const m = AGSKEY.exec(k); if (byAgs && m && !KEEP.has(m[1])) continue; if (byDay && isDay(k) && k < DAYS[0]) continue; out[k] = trim(v[k]); }
    return out;
  }
  return v;
}

if (!has('latest.json')) { console.error(`kein Datenstand unter ${SRC} (latest.json fehlt)`); process.exit(1); }
const latest = await rd('latest.json');
const states = new Set([...KEEP].map(a => latest.municipalities?.[a]?.state).filter(Boolean));
const evIdx = has('events/index.json') ? await rd('events/index.json') : { days: [] };
const DAYS = (evIdx.days || []).filter(isDay).sort().slice(-NDAYS), DSET = new Set(DAYS), T0 = Date.parse(`${DAYS[0]}T00:00:00Z`);
await rm(OUT, { recursive: true, force: true });

// 1. Einzeldateien mit generischem Zuschnitt
const SINGLE = ['latest.json', 'status.json', 'runs.json', 'sources.json', 'coverage.json', 'consistency.json', 'reliability.json', 'idle.json', 'idle-long.json',
  'stations-quota.json', 'pricing.json', 'pricing-log.json', 'caps-log.json', 'calib.json', 'calendar.json', 'eingriffe.json', 'ereignisse.json', 'veranstaltungen.json',
  'sport.json', 'streiks.json', 'groups.json', 'groups/index.json', 'history/daily.json', 'forecast/latest.json', 'forecast/log.json', 'forecast/series.json',
  'forecast/model.json', 'forecast/moped/latest.json', 'forecast/moped/series.json', 'forecast/car/latest.json', 'forecast/car/series.json', 'boundaries/index.json',
  'oepnv/index.json', 'shadow/index.json', 'auflagen/alarme.json', 'feeds/index.json'];
for (const f of SINGLE) if (has(f)) await put(f, trim(await rd(f)));
// S5.1: Jahresbuch der Feed-Verfügbarkeit (je Kalenderjahr eine Datei)
for (const f of (await readdir(path.join(SRC, 'auflagen')).catch(() => [])).filter(x => /^verfuegbarkeit-\d{4}\.json$/.test(x))) await put(`auflagen/${f}`, trim(await rd(`auflagen/${f}`)));
for (const f of (await readdir(path.join(SRC, 'groups')).catch(() => [])).filter(x => /^\d{4}-\d{2}\.json$/.test(x))) if (DAYS.some(d => d.startsWith(f.slice(0, 7)))) await put(`groups/${f}`, trim(await rd(`groups/${f}`)));

// 2. Tagesdateien und Verzeichnisse
for (const d of DAYS) {
  for (const dir of ['events', 'history', 'flows', 'flows-est', 'incidents']) if (has(`${dir}/${d}.json`)) await put(`${dir}/${d}.json`, trim(await rd(`${dir}/${d}.json`)));
  for (const st of states) if (has(`cells/${d}/${st}.json`)) await put(`cells/${d}/${st}.json`, trim(await rd(`cells/${d}/${st}.json`)));
  for (const st of states) if (has(`events/${d}/${st}.json`)) await put(`events/${d}/${st}.json`, trim(await rd(`events/${d}/${st}.json`))); // S3.8
}
const wxDays = (await readdir(path.join(SRC, 'weather')).catch(() => [])).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 10)).filter(d => d >= DAYS[0]);
for (const d of wxDays) await put(`weather/${d}.json`, trim(await rd(`weather/${d}.json`)));
const cut = (idx) => { const o = { ...idx }; for (const k of ['days', 'cellDays']) if (Array.isArray(o[k])) o[k] = o[k].filter(d => DSET.has(d)); return o; };
for (const dir of ['events', 'history', 'flows', 'flows-est', 'flows-week']) if (has(`${dir}/index.json`)) await put(`${dir}/index.json`, cut(await rd(`${dir}/index.json`)));
if (has('archive/index.json')) { const a = await rd('archive/index.json'); const months = new Set(DAYS.map(d => d.slice(0, 7))); a.months = (a.months || []).filter(m => months.has(m)); a.firstDay = DAYS[0]; a.days = DAYS.length; await put('archive/index.json', a);
  for (const m of a.months) if (has(`archive/${m}.json`)) await put(`archive/${m}.json`, trim(await rd(`archive/${m}.json`))); }

// 3. Sonderfälle
// S3.8: Stundensummen und Tagessummen nur für die Tage des Fixtures (Zeilen der Tagessummen passend zu days), ops-input der Gemeinden
if (has('events/hour-totals.json')) { const h = await rd('events/hour-totals.json'); await put('events/hour-totals.json', { ...h, days: Object.fromEntries(Object.entries(h.days || {}).filter(([d]) => DSET.has(d))) }); }
if (has('events/daily-summary.json')) { const ds = await rd('events/daily-summary.json'), ix = ds.days.map((d, i) => (DSET.has(d) ? i : -1)).filter(i => i >= 0);
  await put('events/daily-summary.json', { ...ds, days: ix.map(i => ds.days[i]), groups: Object.fromEntries(Object.entries(ds.groups || {}).filter(([k]) => KEEP.has(k.slice(0, 8))).map(([k, row]) => [k, ix.map(i => row[i])])) }); }
if (has('ops-input/index.json')) { const oi = await rd('ops-input/index.json'); await put('ops-input/index.json', { ...oi, cellDays: oi.cellDays.filter(d => DSET.has(d)), ags: oi.ags.filter(a => KEEP.has(a)) });
  for (const a of KEEP) if (has(`ops-input/${a}.json`)) { const o = await rd(`ops-input/${a}.json`); await put(`ops-input/${a}.json`, { ...o, cellDays: o.cellDays.filter(d => DSET.has(d)), cells: o.cells.filter(c => DSET.has(c.day)) }); } }
if (has('ops-input/fleet/index.json')) { const fi = await rd('ops-input/fleet/index.json'); await put('ops-input/fleet/index.json', { ...fi, ags: fi.ags.filter(x => KEEP.has(x)) });
  for (const a of KEEP) if (has(`ops-input/fleet/${a}.json`)) await put(`ops-input/fleet/${a}.json`, await rd(`ops-input/fleet/${a}.json`)); }
for (const st of states) {
  if (has(`ops/${st}.json`)) { const o = await rd(`ops/${st}.json`); const ok = (i) => KEEP.has(o.munis[i]);
    await put(`ops/${st}.json`, { ...o, vehicles: o.vehicles.filter(r => ok(r[8])), stations: o.stations.filter(r => ok(r[7])) }); }
  if (has(`boundaries/${st}.json`)) { const b = await rd(`boundaries/${st}.json`); await put(`boundaries/${st}.json`, { ...b, features: b.features.filter(f => KEEP.has(f.properties?.ags)) }); }
}
if (has('zone-watch.json')) { const z = await rd('zone-watch.json'); const ids = new Set(z.zones.filter(x => KEEP.has(x.ags)).map(x => x.id));
  await put('zone-watch.json', { ...z, zones: z.zones.filter(x => ids.has(x.id)), runs: z.runs.filter(r => ids.has(r[1]) && r[0] >= T0), daily: z.daily.filter(r => ids.has(r[1]) && DSET.has(r[0])) }); }
// Geofencing-Zonen der Anbieter kommen nicht ins Repo (CLAUDE.md: keine Betreiber-Geometrien auf main) – das Verzeichnis bleibt leer
if (has('zones/index.json')) { const zi = await rd('zones/index.json'); await put('zones/index.json', { ...zi, zones: [] }); }
for (const a of KEEP) if (has(`akku/${a}.json`)) await put(`akku/${a}.json`, await rd(`akku/${a}.json`)); // S6.5 Akku-Prognose
if (has('akku/bewertung.json')) await put('akku/bewertung.json', await rd('akku/bewertung.json'));
for (const a of KEEP) if (has(`context/${a}.json`)) await put(`context/${a}.json`, await rd(`context/${a}.json`));
if (has('context/index.json')) await put('context/index.json', trim(await rd('context/index.json')));

// S3.8 Rest: Dateien je Gemeinde für die Disposition aus dem geschnittenen Stand selbst ableiten, wie der Sammler (Phase „gebiet“)
await writeCellsCompact(OUT, { log: console.log }); await writeArea(OUT, { log: console.log });

const at = latest.at;
await put('FIXTURE.json', { at, generatedAt: latest.generatedAt, days: DAYS, ags: [...KEEP], states: [...states], source: 'scripts/make-fixture.mjs' });
const total = written.reduce((s, [, n]) => s + n, 0);
for (const [f, n] of written.sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`${(n / 1e3).toFixed(0).padStart(7)} KB  ${f}`);
console.log(`${written.length} Dateien, ${(total / 1e6).toFixed(2)} MB roh · Tage ${DAYS.join(', ')} · Gemeinden ${[...KEEP].join(', ')} → ${path.relative(ROOT, OUT)}/`);
