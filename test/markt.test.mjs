// Sprint 7 (Markt): Deutschland-Index (S7.1), Ereignis-Wirkung (S7.2), Preis-Wirkung (S7.3), Expansions-Scout (S7.4), Pakete und Grafik (S7.5)
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as K from '../lib/pulse-markt.js';
const assert = (c, m) => { if (!c) { console.error('FEHLER:', m); process.exitCode = 1; } else console.log('ok:', m); };
const FIELDS = ['flotte_avg', 'fahrten', 'fahrtenden', 'kennungswechsel', 'umsetzungen', 'akkutausch', 'abholungen', 'sperren', 'beobachtet_min', 'flotte_verf', 'stunden_voll'];
const row = (fleet, trips, full = 24) => [fleet, trips, trips, 0, 5, 2, 0, 0, full * 60, fleet * 0.9, full];
const days = (month, n) => [...Array(n)].map((_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
// Oktober und November: Stuttgart (zwei Anbieter E-Scooter), Tübingen (ein Anbieter, Räder), Kleinstadt unter 10 Fahrzeugen
function archive(month, n, f = 1) {
  const a = { fields: FIELDS, days: {} };
  days(month, n).forEach((d, i) => { a.days[d] = { '08111000|Voi|scooter': row(1000, 1500 * f), '08111000|Bolt|scooter': row(800, 1000 * f, i === 3 ? 12 : 24), '08416041|nextbike|bike': row(200, 300 * f), '08888888|X|scooter': row(5, 9) }; });
  return a;
}
const names = { '08111000': 'Stuttgart', '08416041': 'Tübingen', '08888888': 'Klein' };
// ---------- S7.1 ----------
{
  const okt = K.monthIndex(archive('2026-10', 31), { month: '2026-10', names });
  const nov = K.monthIndex(archive('2026-11', 30, 1.1), { month: '2026-11', names, prev: okt });
  const s = nov.rows.find(r => r.ags === '08111000' && r.type === 'scooter');
  assert(nov.rows.length === 2 && !nov.rows.some(r => r.ags === '08888888'), 'S7.1: Städte unter 10 Fahrzeugen fehlen');
  assert(s && s.days === 30 && Math.abs(s.tripsDay - (2500 * 1.1 - 1100 / 30)) < 1 && s.operators === 2 && s.series[3] === 1650, `S7.1: Fahrten je Tag über volle Messtage je Anbieter (Tag 4 nur Voi: ${s?.series[3]})`);
  assert(Math.abs(s.change.trips - (s.tripsDay / okt.rows[0].tripsDay - 1)) < 1e-3 && s.change.trips > 0.09, `S7.1: Veränderung zum Vormonat (${(s.change.trips * 100).toFixed(1)} %)`);
  assert(nov.de.scooter.cities === 1 && nov.de.bike.tripsDay === 330 && nov.operatorLevel === false && !JSON.stringify(nov).includes('Voi'), 'S7.1: Deutschland je Art, keine Anbieter-Ebene im Index');
  const old = { fields: FIELDS.slice(0, 9), days: { '2026-10-30': { '08111000|Voi|scooter': [1000, 1500, 1500, 0, 0, 0, 0, 0, 1300] }, '2026-10-31': { '08111000|Voi|scooter': [1000, 900, 900, 0, 0, 0, 0, 0, 800] } } };
  const o = K.monthIndex(old, { month: '2026-10', names });
  assert(o.rows[0].days === 1 && o.rows[0].tripsDay === 1500, 'S7.1: ältere Zeilen ohne stunden_voll: voller Tag ab 1.200 beobachteten Minuten');
  const svg = K.indexSvg(nov, { type: 'scooter' }), city = K.citySvg(nov, s);
  assert(svg.startsWith('<svg') && svg.includes('Stuttgart') && svg.includes('November 2026') && !svg.includes('<script') && city.includes('Fahrten je Tag') && (city.match(/<rect /g) || []).length === 31, 'S7.1: Grafik des Monats und je Stadt (SVG, 30 Säulen)');
}
// ---------- S7.5 ----------
{
  assert(K.isoWeek('2026-11-14') === '2026-W46' && K.isoWeek('2027-01-01') === '2026-W53' && K.isoWeek('2026-01-01') === '2026-W01' && K.isoWeek('2026-12-28') === '2026-W53', 'S7.5: Kalenderwoche nach ISO 8601');
  assert(K.weekDays('2026-W46').join() === days('2026-11', 15).slice(8).join() && K.weekDays('2026-W01')[0] === '2025-12-29', 'S7.5: Tage einer Kalenderwoche');
  const a = archive('2026-11', 30); const g46 = K.weekGraphic(a, '2026-W46', { names }), g45 = K.weekGraphic(a, '2026-W45', { names });
  assert(g46.theme === 'staedte' && g46.svg.includes('Stuttgart') && g45.theme === 'arten' && g45.svg.includes('E-Scooter') && g45.svg.includes('Fahrräder'), 'S7.5: Grafik der Woche, Thema wechselt wöchentlich');
  const idx = K.monthIndex(a, { month: '2026-11', names }), pk = K.openPackage(a, idx, { names, at: Date.parse('2026-12-01T06:00:00Z') });
  const dp = JSON.parse(pk.files['datapackage.json']), tage = pk.files['tage.csv'].trim().split('\n');
  assert(Object.keys(pk.files).join() === 'tage.csv,monat.csv,datapackage.json,README.md' && dp.resources.length === 2 && dp.resources[0].schema.fields.map(f => f.name).join() === tage[0].split(';').join() && tage.length === 1 + 30 + 30 + 30, `S7.5: Monatspaket mit Datenbeschreibung (${tage.length - 1} Tageszeilen, Spalten = Schema)`);
  assert(!pk.files['tage.csv'].includes('Voi') && pk.files['README.md'].includes('## Dateien') && pk.files['README.md'].includes('fahrten_je_tag'), 'S7.5: Paket ohne Anbieter-Ebene, README beschreibt jede Spalte');
}
// ---------- S7.2 ----------
{
  const flat = [...Array(24)].map((_, h) => (h >= 7 && h < 23 ? 100 : 10)), mul = (f, from = 0, to = 24) => flat.map((v, h) => (h >= from && h < to ? Math.round(v * f) : v));
  const ser = { days: {} };
  const fs = [1.03, 0.97, 1.05, 0.95, 1.0, 1.02, 0.98];
  days('2026-11', 7).forEach((d, i) => { ser.days[d] = { 'ags:08111000': { p: flat, a: mul(fs[i]) }, 'ags:08416041': { p: flat, a: mul(fs[i]) } }; });
  ser.days['2026-11-08'] = { 'ags:08111000': { p: flat, a: mul(1.4, 18, 23) }, 'ags:08416041': { p: flat, a: mul(1.01, 10, 22).map((v, h) => (h === 12 ? null : v)) } };
  const ev = [{ id: 'k', art: 'veranstaltung', von: '2026-11-08T18:00', bis: '2026-11-08T22:00', gebiet: { ags: ['08111000'] }, titel: 'Konzert', quelle: 'https://example.org/k' },
    { id: 'm', art: 'veranstaltung', von: '2026-11-08', bis: '2026-11-08', ohneUhrzeit: true, gebiet: { ags: ['08416041'] }, titel: 'Markt' },
    { id: 's', art: 'streik-oepnv', von: '2026-11-09', bis: '2026-11-09', tage: ['2026-11-09'], gebiet: { ags: ['08111000'] }, titel: 'Streik (nach dem Stand)' }];
  const ef = K.eventEffects(ser, ev, { today: '2026-11-09' }), k = ef.find(e => e.id === 'k'), m = ef.find(e => e.id === 'm');
  assert(ef.length === 2 && !ef.some(e => e.id === 's'), 'S7.2: nur abgeschlossene Tage mit Prognose (Streik am laufenden Tag fehlt)');
  assert(k && k.window.join() === '18,23' && k.effect === 200 && k.verdict === 'mehr' && k.band[0] > 0 && k.n === 7, `S7.2: Konzert +40 % im Fenster 18–23 Uhr: Wirkung ${k?.effect}, Band ${k?.band}, „mehr“`);
  assert(m && m.window.join() === '10,22' && m.hours === 11 && m.verdict === 'nicht unterscheidbar' && m.band[0] < 0 && m.band[1] > 0, `S7.2: Markt +1 % (Lücke in Stunde 12): Band enthält die Null → „nicht unterscheidbar“`);
  assert(K.eventEffects(ser, ev, { today: '2026-11-09', minDays: 8 }).length === 0, 'S7.2: zu wenige Vergleichstage → keine Schätzung');
}
// ---------- S7.3 ----------
{
  const log = { fields: ['at', 'sourceId', 'operator', 'planId', 'field', 'old', 'new'], changes: [
    [Date.parse('2026-11-11T09:00:00Z'), 'voi_de', 'Voi', 'p1', 'unlock', 1, 1.5],
    [Date.parse('2026-11-05T09:00:00Z'), 'sigo_x', 'sigo', 'p2', 'perMin', [{ start: 0, rate: 0, interval: 0 }], [{ start: 0, rate: 0, interval: 1 }]],
    [Date.parse('2026-11-05T09:00:00Z'), 'voi_de', 'Voi', 'p3', '+plan', null, 'x']] };
  const ch = K.priceChanges(log);
  assert(ch.length === 1 && ch[0].day === '2026-11-11' && ch[0].fields.join() === 'unlock', 'S7.3: nur echte Preisänderungen (Form-Änderung und neuer Tarif zählen nicht)');
  const a = { fields: FIELDS, days: {} }, noise = [0.02, -0.03, 0.01, 0.04, -0.02, 0.0, -0.01, 0.03, -0.04, 0.02, 0.01, -0.02, 0.0, 0.03, -0.01, 0.02, -0.03];
  days('2026-11', 18).forEach((d, i) => { const after = d > '2026-11-11', e = Math.exp(noise[i % noise.length]); a.days[d] = { '08111000|Voi|scooter': row(1000, Math.round(1000 * e * (after ? 0.8 : 1))), '08111000|Bolt|scooter': row(900, Math.round(900 * Math.exp(-noise[(i + 5) % noise.length]))), '08416041|Voi|scooter': row(100, 100) }; });
  const pe = K.priceEffects(ch, a, { srcMunis: { voi_de: ['08111000', '08416041'] }, today: '2026-11-19' }), s = pe.find(p => p.ags === '08111000'), tu = pe.find(p => p.ags === '08416041');
  assert(s?.status === 'ok' && s.before === 7 && s.after === 7 && Math.abs(s.effect + 0.2) < 0.05 && s.ci[0] < s.effect && s.ci[1] > s.effect && s.ci[1] < 0 && s.verdict === 'weniger', `S7.3: Entsperrpreis +50 %: Wirkung ${(s?.effect * 100).toFixed(1)} % [${s?.ci?.map(x => (x * 100).toFixed(1)).join('; ')}]`);
  assert(tu?.status === 'ohne Vergleich', 'S7.3: Gemeinde ohne anderen Anbieter: keine Schätzung');
  const w = K.priceEffects(ch, a, { srcMunis: { voi_de: ['08111000'] }, today: '2026-11-15' });
  assert(w[0].status === 'wartet' && w[0].readyOn === '2026-11-19', 'S7.3: vor dem 7. Tag danach „wartet“ (ab 19.11.)');
}
// ---------- S7.4 ----------
{
  const sq = (lon, lat, d = 0.05) => ({ type: 'Polygon', coordinates: [[[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]]] });
  const F = (ags, name, pop, lon, lat, d) => ({ properties: { ags, name, pop, state: 'BW' }, geometry: sq(lon, lat, d) });
  const feats = [F('1', 'Groß ohne', 150000, 9.0, 48.0, 0.15), F('2', 'Mittel nah', 40000, 9.3, 48.0, 0.05), F('3', 'Klein', 15000, 9.6, 48.0), F('4', 'Sharing-Stadt', 300000, 9.4, 48.05, 0.15), F('5', 'Fern', 25000, 12.0, 52.0, 0.2)];
  const sc = K.scout(feats, { 4: 3000 });
  assert(sc.candidates === 3 && sc.rows.length === 3 && !sc.rows.some(r => r.name === 'Klein' || r.name === 'Sharing-Stadt'), 'S7.4: nur Gemeinden ab 20.000 Einwohnern ohne Sharing');
  assert(sc.rows[2].name === 'Fern' && sc.rows.every(r => r.reason.startsWith(`Rang ${r.rank}:`) && r.nearest?.name === 'Sharing-Stadt' && Number.isFinite(r.pop) && Number.isFinite(r.densityKm2)), `S7.4: Rangliste mit Werten je Merkmal und Begründung (${sc.rows.map(r => r.name).join(', ')})`);
  assert(sc.rows.find(r => r.name === 'Mittel nah').sharingNear === 1 && sc.rows.find(r => r.name === 'Mittel nah').fleetNear === 3000, 'S7.4: Sharing-Flotte im Umkreis von 15 km');
}
// ---------- Sammler-Phase: Index am 1. für den Vormonat, danach unverändert ----------
{
  const DATA = await mkdtemp(path.join(tmpdir(), 'mp-markt-')); await mkdir(path.join(DATA, 'archive'), { recursive: true });
  await writeFile(path.join(DATA, 'archive', '2026-11.json'), JSON.stringify(archive('2026-11', 30)));
  await writeFile(path.join(DATA, 'archive', '2026-12.json'), JSON.stringify({ fields: FIELDS, days: { '2026-12-01': { '08111000|Voi|scooter': row(1000, 50, 3) } } }));
  const { run } = await import('../scripts/collect/27-markt.mjs'), logs = [];
  const latest = { municipalities: { '08111000': { name: 'Stuttgart' }, '08416041': { name: 'Tübingen' } }, groups: {}, sources: [] };
  const at = Date.parse('2026-12-01T05:10:00Z');
  await run({ DATA, latest, now: at, log: (m) => logs.push(m) });
  const files = (await readdir(path.join(DATA, 'index'))).sort(), off = (await readdir(path.join(DATA, 'offen', '2026-11'))).sort(), list = JSON.parse(await readFile(path.join(DATA, 'index', 'index.json'), 'utf8'));
  assert(files.includes('2026-11.json') && files.includes('2026-11-scooter.svg') && off.join() === 'README.md,datapackage.json,monat.csv,tage.csv' && list.months.some(m => m.month === '2026-11' && m.complete), `S7.1/S7.5: am 1. Index, Grafik und Paket des Vormonats (${files.join(', ')})`);
  const m0 = (await stat(path.join(DATA, 'index', '2026-11.json'))).mtimeMs;
  await run({ DATA, latest, now: at + 18 * 60e3, log: (m) => logs.push(m) });
  assert((await stat(path.join(DATA, 'index', '2026-11.json'))).mtimeMs === m0 && logs.filter(l => /Index und Daten-Paket 2026-11/.test(l)).length === 1, 'S7.1: späterer Lauf schreibt den Monat nicht erneut');
  const g = JSON.parse(await readFile(path.join(DATA, 'grafik', 'index.json'), 'utf8'));
  assert(g.weeks[0].week === '2026-W48' && g.schemaVersion === '1.0', `S7.5: Grafik der Woche entsteht von selbst (${g.weeks[0].week})`);
}
