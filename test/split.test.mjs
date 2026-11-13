// S3.8 Daten nach Gebiet (lib/pulse-split.js): die kleinen Dateien müssen dieselben Ergebnisse liefern wie die großen.
// Grundlage: Fixture (test/fixtures/web-data) und der Datenzweig, falls MP_DATA gesetzt ist (z. B. MP_DATA=/home/claude/mp-data).
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { eventsByState, hourTotals, totalsDoc, groupDaySums, dailySummary, opsSlice, cellsSlice, SUMMARY_FIELDS } from '../lib/pulse-split.js';
import { hourProfile, DAY_TYPES } from '../lib/pulse-econ.js';
import { decodeFleet, buildDemandModel, BANDS } from '../lib/pulse-ops.js';
import { haversineM } from '../lib/pulse-core.js';

let ok = 0, bad = 0;
const check = (c, m) => { if (c) { ok++; console.log(`ok: ${m}`); } else { bad++; console.log(`FEHLER ${m}`); } };
const rep = (_k, v) => (v instanceof Map ? { Map: [...v] } : v instanceof Set ? { Set: [...v] } : v);
const same = (a, b) => JSON.stringify(a, rep) === JSON.stringify(b, rep);
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const DIRS = [path.join(ROOT, 'test/fixtures/web-data'), ...(process.env.MP_DATA ? [process.env.MP_DATA] : [])];
const rd = async (f) => JSON.parse(await readFile(f, 'utf8'));

for (const DIR of DIRS) {
  const tag = path.basename(DIR);
  const latest = await rd(path.join(DIR, 'latest.json'));
  const stateOf = (ags) => latest.municipalities?.[ags]?.state;
  const days = (await readdir(path.join(DIR, 'events'))).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().map(f => f.slice(0, 10));
  const docs = await Promise.all(days.map(d => rd(path.join(DIR, 'events', `${d}.json`))));
  check(docs.length >= 2, `${tag}: ${docs.length} Ereignistage`);

  // Ereignisse je Land: alle Gruppen genau einmal, Kopf unverändert
  for (const doc of docs) {
    const parts = eventsByState(doc, stateOf);
    const keys = [...parts.values()].flatMap(p => Object.keys(p.groups)).sort();
    check(same(keys, Object.keys(doc.groups).sort()), `${tag} ${doc.day}: ${parts.size} Länder, jede Gruppe genau einmal`);
    const p0 = [...parts.values()][0], { groups: _g, state: _s, ...h0 } = p0, { groups: _G, ...H } = doc;
    check(same(h0, H), `${tag} ${doc.day}: Kopf (runs, hourMin, published …) gleich`);
    check([...parts].every(([st, p]) => Object.keys(p.groups).every(k => (stateOf(k.split('|')[0]) || 'XX') === st)), `${tag} ${doc.day}: Gruppen im richtigen Land`);
  }

  // Tagesgang-Profil aus hour-totals = aus den vollen Dateien (für jeden Tagtyp und ohne)
  const tot = docs.map(d => totalsDoc(d.day, JSON.parse(JSON.stringify(hourTotals(d))))); // über JSON wie aus der Datei
  for (const ty of [null, ...DAY_TYPES]) for (const land of [null, 'BW']) {
    const a = hourProfile(docs, { minDays: 1, dayType: ty, land }), b = hourProfile(tot, { minDays: 1, dayType: ty, land });
    check(same(a, b), `${tag}: Profil ${ty || 'alle'} ${land || 'DE'} gleich (${a.source})`);
  }

  // Tagessummen
  const byDay = Object.fromEntries(docs.map(d => [d.day, groupDaySums(d)]));
  const sum = dailySummary(byDay);
  check(same(sum.days, days) && same(sum.fields, SUMMARY_FIELDS), `${tag}: Tagessummen über ${sum.days.length} Tage`);
  const k0 = Object.keys(docs.at(-1).groups)[0], g0 = docs.at(-1).groups[k0];
  check(Math.abs(sum.groups[k0].at(-1)[0] - g0.start.reduce((a, x) => a + (x || 0), 0)) < 0.01, `${tag}: Σ start der Gruppe ${k0}`);

  // Disposition: Bestand und Zellen einer Gemeinde
  const opsFiles = (await readdir(path.join(DIR, 'ops'))).filter(f => /^[A-Z]{2}\.json$/.test(f));
  const ops = await rd(path.join(DIR, 'ops', opsFiles.includes('BW.json') ? 'BW.json' : opsFiles[0]));
  const full = decodeFleet(ops);
  const counts = {}; for (const v of full.vehicles) counts[v.ags] = (counts[v.ags] || 0) + 1;
  const ags = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const sl = opsSlice(ops, ags), part = decodeFleet(JSON.parse(JSON.stringify(sl)));
  check(same(part.vehicles, full.vehicles.filter(v => v.ags === ags)) && part.vehicles.length === counts[ags], `${tag}: Bestand ${ags} (${counts[ags]} Fahrzeuge) gleich`);
  check(same(part.stations, full.stations.filter(s => s.ags === ags)), `${tag}: Stationen ${ags} gleich (${part.stations.length})`);
  check(opsSlice(ops, '99999999') === null, `${tag}: unbekannte Gemeinde → null`);
  // mit Rahmen: alle Stationen bis 1 km um ein Fahrzeug der Gemeinde sind dabei (Einsammelliste sucht so weit, COLLECT.stationSearchM)
  {
    const lat = full.vehicles.filter(v => v.ags === ags).map(v => v.lat), lon = full.vehicles.filter(v => v.ags === ags).map(v => v.lon);
    const bbox = [Math.min(...lon), Math.min(...lat), Math.max(...lon), Math.max(...lat)];
    const raw = JSON.parse(JSON.stringify(opsSlice(ops, ags, { bbox }))), wide = decodeFleet(raw);
    const key = (s) => `${s.lat},${s.lon},${s.operator},${s.name}`, have = new Set(wide.stations.map(key));
    const inMuni = full.vehicles.filter(v => v.ags === ags), near = full.stations.filter(s => inMuni.some(v => Math.abs(v.lat - s.lat) < 0.009 && Math.abs(v.lon - s.lon) < 0.0135 && haversineM(v.lat, v.lon, s.lat, s.lon) <= 1000));
    check(near.every(s => have.has(key(s))) && same(wide.vehicles, part.vehicles) && raw.ops.length <= ops.ops.length && raw.munis.length <= ops.munis.length, `${tag}: mit Rahmen ${wide.stations.length} Stationen, alle ${near.length} Stationen bis 1 km um Fahrzeuge dabei, Listen gekürzt (${raw.ops.length}/${ops.ops.length} Anbieter, ${raw.munis.length}/${ops.munis.length} Gemeinden)`);
  }
  const st = ops.state, cdays = (await readdir(path.join(DIR, 'cells'))).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().slice(-14);
  const cdocs = (await Promise.all(cdays.map(d => rd(path.join(DIR, 'cells', d, `${st}.json`)).catch(() => null)))).filter(Boolean);
  const cs = JSON.parse(JSON.stringify(cellsSlice(cdocs, ags)));
  // Tag ohne Zellen der Gemeinde: bleibt mit leeren Zellen drin (Beobachtungsstunden zählen wie aus den Landesdateien)
  if (cdocs.length >= 2) {
    const gap = cdocs.map((d, i) => (i === 0 ? { ...d, munis: Object.fromEntries(Object.entries(d.munis).filter(([a]) => a !== ags)) } : d));
    const gs = JSON.parse(JSON.stringify(cellsSlice(gap, ags)));
    check(gs.length === gap.length && !Object.keys(gs[0].munis).length && same(buildDemandModel(gs, ags, 'day'), buildDemandModel(gap, ags, 'day')), `${tag}: Tag ohne Zellen der Gemeinde zählt mit (Modell gleich)`);
  }
  for (const band of /** @type {any[]} */ (['day', ...BANDS.map(b => b.id)])) { const m1 = buildDemandModel(cs, ags, band), m0 = buildDemandModel(cdocs, ags, band); check(same(m1, m0) && (band !== 'day' || m0.cells.size > 0), `${tag}: Nachfragemodell ${ags} Band ${band} gleich (${m0.cells.size} Zellen, ${m0.hours?.toFixed?.(1)} h)`); }
}
console.log(`${bad ? '✗' : '✓'} split: ${ok} ok, ${bad} fehlgeschlagen`);
process.exit(bad ? 1 : 0);
