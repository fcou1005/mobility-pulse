import { spawn } from 'node:child_process';
import { rm, mkdir, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { startExtra } from './fixtures/extra-server.mjs';
import * as T from '../lib/pulse-track.js';
const srv = spawn('node', ['test/server.mjs'], { stdio: 'inherit' });
await new Promise(r => setTimeout(r, 800));
await rm('test/out', { recursive: true, force: true }); await mkdir('test/out', { recursive: true });
const collect = (env = {}) => new Promise(r => spawn('node', ['scripts/collect.mjs'], { stdio: 'inherit', env: { ...process.env, DATA_DIR: 'test/out', SOURCES_FILE: 'test/sources.json', BOUNDARIES: 'test/boundaries.json', SKIP_CONTEXT: '1', ...env } }).on('exit', r));
for (let i = 0; i < 2; i++) await collect({ TRACK_DIR: '' });
const d = JSON.parse(await readFile('test/out/latest.json', 'utf8'));
const assert = (c, m) => { if (!c) { console.error('FEHLER:', m); process.exitCode = 1; } else console.log('ok:', m); };
assert(d.counts.vehicles === 3, 'Dubletten/Geo-Ausschluss → 3 Fahrzeuge');
assert(d.groups['08416041|Bolt|scooter']?.lowBattery === 1, 'Niedrigakku erkannt');
assert(d.sources.find(s => s.id === 'gone_test')?.status === 'gone', '404 → gone');
assert(d.sources.find(s => s.id === 'dott_test')?.status === 'stale', '40 Min alter Feed → stale');
assert(!d.municipalities['08111000'], 'veraltete Quelle liefert keine Ortszuordnung');
assert(d.groups['08416041|nextbike|bike']?.stationsEmpty === 1, 'leere Station erkannt');
const { existsSync } = await import('node:fs');
assert(existsSync('test/out/track/state.json.gz'), 'Track-Zustand geschrieben');
const pr = JSON.parse(await readFile('test/out/pricing.json', 'utf8'));
assert(pr.plans.length >= 1 && pr.plans[0].plans[0].perMin[0].rate === 0.22, 'Preisplan gelesen');
const zi = JSON.parse(await readFile('test/out/zones/index.json', 'utf8'));
assert(zi.zones.length >= 1 && zi.zones[0].kinds.slow === 1, 'Zonen gelesen (1 Langsamzone)');
const evIdx = JSON.parse(await readFile('test/out/events/index.json', 'utf8'));
assert(evIdx.days.length === 1 && evIdx.first === false, 'Ereignisdatei nach zweitem Lauf');
const sq = JSON.parse(await readFile('test/out/stations-quota.json', 'utf8'));
assert(sq.stations.length === 4 && sq.stations.every(x => x[5] === 2), 'Stationsquote über 2 Läufe');
const rel = JSON.parse(await readFile('test/out/reliability.json', 'utf8'));
assert(rel.sources.bolt_test.runs === 2 && rel.sources.gone_test.err === 2, 'Zuverlässigkeit je Quelle');
const cons = JSON.parse(await readFile('test/out/consistency.json', 'utf8'));
assert(cons.systems.length === 1 && cons.systems[0].verdict === 'consistent' && cons.systems[0].idOverlap === 1, 'Konsistenz: identischer Alternativ-Feed = consistent');
assert(Array.isArray(cons.pairs), 'Quellenpaare vorhanden (Fixture zu klein für Paare)');
const idle = JSON.parse(await readFile('test/out/idle.json', 'utf8'));
assert(idle.groups['08416041|Bolt|scooter']?.[5] === 1, 'Standzeiten aggregiert');
assert(d.municipalities['08416041']?.c?.length === 2 && Math.abs(d.municipalities['08416041'].c[0] - 48.525) < 1e-6, 'Gemeinde-Mittelpunkt c = [lat, lon]');
assert(d.sources.find(s => s.id === 'bolt_test').checks?.label?.includes('Basisprüfung') && d.sources.find(s => s.id === 'bolt_test').licenseId === 'CC-BY-4.0', 'Quelle mit Basisprüfung und Lizenz-ID');

// ---------- Läufe 3–5: privater Track-Zustand (TRACK_DIR), Zusatzquellen ----------
const ex = await startExtra();
const tmp = await mkdtemp(path.join(tmpdir(), 'mp-test-'));
const TRACK_DIR = path.join(tmp, 'track');
const cat = JSON.parse(await readFile('test/sources.json', 'utf8'));
const extra = [
  { id: 'p_test', name: 'Rad Test', operator: 'RegioRad Stuttgart', api: 'gbfs', url: `${ex.base}/p/gbfs.json`, directories: ['mobidata_bw'], priority: 1 },
  { id: 'citybikes_stadtrad-stuttgart', name: 'RegioRadStuttgart', operator: 'DB Connect', api: 'citybikes', url: `${ex.base}/cb/x`, directories: ['citybikes'], priority: 3 },
  { id: 'auth_test', name: 'Auth', operator: 'Bolt', api: 'gbfs', url: `${ex.base}/auth/gbfs.json`, directories: ['db_api'], auth: { type: 'header', provider: 't' } },
];
const slow = [{ id: 'slow_test', name: 'Langsam', operator: 'Zeus', api: 'gbfs', url: `${ex.base}/slow/gbfs.json`, directories: ['mobilitydata'] }, { id: 'big_test', name: 'Groß', operator: 'Zeus', api: 'gbfs', url: `${ex.base}/big/gbfs.json`, directories: ['mobilitydata'] }];
const auth_sources = { t: { host: new URL(ex.base).host, headers: { 'x-api-key': 'MP_TEST_KEY' }, env: ['MP_TEST_KEY'] } };
await writeFile(path.join(tmp, 's3.json'), JSON.stringify({ ...cat, auth_sources, sources: [...cat.sources, ...extra, ...slow] }));
await writeFile(path.join(tmp, 's4.json'), JSON.stringify({ ...cat, auth_sources, sources: [...cat.sources, ...extra] }));
// Obergrenze für die Testgemeinde (Bolt-E-Scooter), damit der Sammler caps-log.json schreibt
await writeFile(path.join(tmp, 'ref.json'), JSON.stringify({ obergrenzen: [{ ags: '08416041', ort: 'Tübingen (Test)', type: 'scooter', gesamt: 1, jeAnbieter: 5, quelle: 'Test', url: 'https://example.org' }] }));
// Städte laut Anbieter (Abdeckung): Bolt nennt Tübingen und Stuttgart, Dott „Tubingen“ (englische Umschrift)
await writeFile(path.join(tmp, 'cities.json'), JSON.stringify({ erstellt: '2026-11-01', anbieter: [{ name: 'Bolt', quelle: 'https://example.org/bolt', staedte: [{ ort: 'Tübingen' }, { ort: 'Stuttgart' }] }, { name: 'Dott', quelle: 'https://example.org/dott', staedte: [{ ort: 'Tubingen' }] }] }));
const env3 = { TRACK_DIR, REFRESH_STATIC: '1', MP_TEST_KEY: 'geheim-123', FETCH_TIMEOUT: '1500', MAX_BYTES: '200000', REFERENCE_FILE: path.join(tmp, 'ref.json'), OPERATOR_CITIES_FILE: path.join(tmp, 'cities.json'),
  ZONE_WATCH: JSON.stringify({ type: 'Feature', properties: { name: 'Testzone', limits: { scooter: { maximum: 777 } } }, geometry: { type: 'Polygon', coordinates: [[[8.9, 48.4], [9.3, 48.4], [9.3, 48.9], [8.9, 48.9], [8.9, 48.4]]] } }) };
const t3 = Date.now();
await collect({ ...env3, SOURCES_FILE: path.join(tmp, 's3.json') });
const l3 = JSON.parse(await readFile('test/out/latest.json', 'utf8'));
const S3 = (id) => l3.sources.find(s => s.id === id);
const ev3 = JSON.parse(await readFile(`test/out/events/${JSON.parse(await readFile('test/out/events/index.json', 'utf8')).days.slice(-1)[0]}.json`, 'utf8'));
const st3 = JSON.parse(gunzipSync(await readFile(path.join(TRACK_DIR, 'state.json.gz'))).toString('utf8'));
const runs3 = JSON.parse(await readFile('test/out/runs.json', 'utf8')).runs;
// M10: Umzug auf gesalzene Schlüssel – privater Zustand, kein out/track, Umzugslauf zählt nichts
assert(!existsSync('test/out/track') && existsSync(path.join(TRACK_DIR, 'salt')) && st3.salted === true && typeof st3.keyId === 'string', 'TRACK_DIR: Zustand gesalzen im privaten Verzeichnis, out/track entfernt');
assert(ev3.runs.slice(-1)[0][2] === 0 && runs3.slice(-1)[0][9] === 0 && runs3.slice(-1)[0][10] === 0, 'Umzugslauf: Flag 0, keine Fahrten/Fahrtenden (neue Zusatzquellen erzeugen keine Scheinereignisse)');
// M3: CityBikes-Kopie unter anderem Namen zählt nicht (Stuttgart: RegioRad nur einmal)
const cb3 = S3('citybikes_stadtrad-stuttgart'), p3 = S3('p_test');
assert(cb3.status === 'duplicate' && cb3.duplicateOf === 'p_test' && cb3.feedStatus === 'live' && cb3.operator === 'RegioRad Stuttgart', 'CityBikes-Kopie erkannt (status duplicate, Marke aus operator_by_system)');
assert(l3.groups['08111000|RegioRad Stuttgart|bike']?.total === 3 && !Object.keys(l3.groups).some(k => k.startsWith('08111000|DB Connect')) && cb3.quality < p3.quality, 'Stuttgart zählt die Räder einmal; Kopie schlechter bewertet als das Original');
// M9: virtuelle Stationen ohne num_docks_available
const g3 = l3.groups['08111000|RegioRad Stuttgart|bike'];
assert(g3.stationsVirtual === 3 && g3.stationsEmptyVirtual === 3 && g3.stationsEmptyDock === 1, 'Abstellzonen getrennt: 3 virtuell leer, 1 Dock leer');
// M11: Namensnennung/Lizenz, DATA-LICENSE.md
const lic = await readFile('test/out/DATA-LICENSE.md', 'utf8');
assert(p3.licenseId === 'CC-BY-SA-4.0' && p3.licenseUrl === 'https://creativecommons.org/licenses/by-sa/4.0/' && p3.attribution === 'Teststadt Mobil GmbH' && p3.attributionUrl === 'https://example.org', 'Lizenz-ID/URL und Namensnennung je Quelle');
assert(/dl-de\/by-2-0/.test(lic) && /ODbL/.test(lic) && /CC BY-SA 4\.0/.test(lic) && /Teststadt Mobil GmbH/.test(lic), 'DATA-LICENSE.md: BKG, OSM, CC BY-SA, Namensnennung');
// M4: Tarifwährung nur ISO-Kürzel
const pr3 = JSON.parse(await readFile('test/out/pricing.json', 'utf8')).plans.find(x => x.sourceId === 'p_test');
assert(pr3 && !('currency' in pr3.plans.find(x => x.id === 'std')) && pr3.plans.find(x => x.id === 'eur').currency === 'EUR' && !JSON.stringify(l3).includes('onerror'), 'Währung: eingeschleuster Text verworfen, EUR übernommen');
// M5: Zugangsdaten nur an den exakten Host, keine Weiterleitung auf fremde Hosts
const leak = ex.log.filter(x => x.path.startsWith('/leak/'));
assert(ex.log.some(x => x.path === '/auth/system_information.json' && x.key === 'geheim-123') && leak.some(x => x.path === '/leak/free_bike_status.json') && leak.every(x => !x.key), 'Zugangsdaten: exakter Host ja, anderer Host (auch mit Host-Namen in der URL) nein');
assert(!leak.some(x => x.path === '/leak/vehicle_types.json') && S3('auth_test').errors.some(e => /Weiterleitung/.test(e)), 'Weiterleitung mit Zugangsdaten auf anderen Host verweigert');
// M6: Timeout bis zum Ende des Lesens, Größenlimit
assert(/Timeout/.test(S3('slow_test').errors.join(' ')) && /zu groß/.test(S3('big_test').errors.join(' ')) && Date.now() - t3 < 30000, 'langsamer Body → Timeout, großer Body → zu groß');
// M17b: Feed-Prüfung je Quelle
assert(p3.checks && p3.checks.items.length <= 5 && Number.isInteger(p3.checks.errors) && Number.isInteger(p3.checks.warnings) && p3.checks.items.some(i => /num_docks_available/.test(i.msg)), 'Basisprüfung in latest.json sources[].checks');
// M8/M18: Archiv-Index mit Tagen, Tagesmittel, Stationsquote mit Spalte virtual
const ai = JSON.parse(await readFile('test/out/archive/index.json', 'utf8'));
const dl = JSON.parse(await readFile('test/out/history/daily.json', 'utf8'));
const sq3 = JSON.parse(await readFile('test/out/stations-quota.json', 'utf8'));
assert(ai.days >= 1 && /^\d{4}-\d{2}-\d{2}$/.test(ai.firstDay) && dl.fields.join() === 'available,total,disabled,lowBattery,stations,stationsEmptyDock,runs' && dl.series['08416041|Bolt|scooter'], 'archive/index.json days/firstDay, history/daily.json');
assert(sq3.fields[8] === 'virtual' && sq3.stations.some(x => x[8] === 1), 'Stationsquote: Spalte virtual');
// Fläche je Gemeinde, Fehler nach Ursache, Minuten je Ortsstunde
assert(Math.abs(l3.municipalities['08111000'].areaKm2 - 0.25 * 0.17 * 111.2 * 111.2 * Math.cos(48.785 * Math.PI / 180)) < 2, 'areaKm2 je Gemeinde (Testrechteck Stuttgart ≈ 351 km²)');
assert(l3.counts.errorCauses.timeout === 1 && l3.counts.errorCauses.tooLarge === 1 && l3.counts.errorCauses.http404 === 1 && S3('slow_test').errorCause === 'timeout', 'Fehler nach Ursache in latest.json counts.errorCauses');
assert(ev3.hourMin?.length === 24 && ev3.hourMin.reduce((a, b) => a + b, 0) >= 1380, 'Tagesdokument mit hourMin');

// Lauf 4: normaler Lauf mit TRACK_DIR (Flag 1, keine Scheinereignisse), Tarifänderung, Quelle seit > 14 Tagen weg
ex.st.price = 1.5;
l3.sources.find(s => s.id === 'gone_test').goneSince = Date.now() - 15 * 86400e3;
await writeFile('test/out/latest.json', JSON.stringify(l3));
await collect({ ...env3, SOURCES_FILE: path.join(tmp, 's4.json') });
const l4 = JSON.parse(await readFile('test/out/latest.json', 'utf8'));
const ev4 = JSON.parse(await readFile(`test/out/events/${JSON.parse(await readFile('test/out/events/index.json', 'utf8')).days.slice(-1)[0]}.json`, 'utf8'));
const runs4 = JSON.parse(await readFile('test/out/runs.json', 'utf8')).runs;
assert(!existsSync('test/out/track') && ev4.runs.slice(-1)[0][2] === 1 && runs4.slice(-1)[0][9] === 0 && runs4.slice(-1)[0][10] === 0 && runs4.slice(-1)[0][11] === 0, 'Lauf mit gesalzenem Zustand: Flag 1, keine Scheinereignisse');
const clog = JSON.parse(await readFile('test/out/caps-log.json', 'utf8'));
const bolt4 = l4.groups['08416041|Bolt|scooter']?.total || 0;
assert(clog.fields.join() === 'at,ags,operator,count,limit,dtMs' && clog.rules.length === 1 && clog.rules[0].limit === 1 && clog.checks.some(c => c[0] === l4.at && c[1] === '08416041' && c[2] === '*' && c[3] === bolt4 && c[4] === 1 && c[5] > 0) && !clog.checks.some(c => c[2] === 'Bolt') && clog.daily.some(d => d[1] === '08416041' && d[2] === 'Bolt' && d[3] === bolt4 && d[4] === 5), `caps-log.json: Überschreitung gesamt (${bolt4} > 1) je Lauf mit Fenster, Bolt unter 90 % nur als Tagesmaximum`);
{
  const cov = JSON.parse(await readFile('test/out/coverage.json', 'utf8'));
  const row = (k, a) => cov.rows.find(r => r.opKey === k && r.ags === a);
  const boltTue = l4.municipalities['08416041']?.operators?.Bolt?.total || 0, boltStr = l4.municipalities['08111000']?.operators?.Bolt?.total || 0, dottTue = l4.municipalities['08416041']?.operators?.Dott?.total || 0;
  assert(cov.version === 1 && row('bolt', '08416041')?.cat === (boltTue ? 'abgedeckt' : 'feed-still') && row('bolt', '08111000')?.cat === (boltStr ? 'abgedeckt' : row('bolt', '08111000')?.src ? 'feed-still' : 'kein-feed')
    && row('dott', '08416041')?.claimed === true && row('dott', '08416041').cat === (dottTue ? 'abgedeckt' : 'feed-still') && row('bolt', '08416041').lastActive != null === !!boltTue,
    `coverage.json: Bolt Tübingen ${row('bolt', '08416041')?.cat}, Bolt Stuttgart ${row('bolt', '08111000')?.cat}, Dott „Tubingen“ ${row('dott', '08416041')?.cat}`);
}
{
  const zw = JSON.parse(await readFile('test/out/zone-watch.json', 'utf8')), raw = JSON.stringify(zw);
  const inZone = zw.runs.filter(r => r[0] === l4.at).reduce((s, r) => s + r[4], 0);
  assert(zw.zones.length === 1 && zw.zones[0].id === 'testzone' && zw.zones[0].ags && inZone > 0 && zw.daily.length > 0 && !raw.includes('8.9') && !raw.includes('777') && !raw.includes('coordinates'),
    `zone-watch.json: ${inZone} Fahrzeuge in der Testzone im letzten Lauf, Gemeinde ${zw.zones[0].ags}, keine Umrisse und keine Limits veröffentlicht`);
}
const plog = JSON.parse(await readFile('test/out/pricing-log.json', 'utf8'));
assert(plog.fields.join() === 'at,sourceId,operator,planId,field,old,new' && plog.changes.some(c => c[1] === 'p_test' && c[3] === 'std' && c[4] === 'unlock' && c[5] === 1 && c[6] === 1.5), 'pricing-log.json: Entsperrpreis 1 → 1,5');
assert(l4.sources.find(s => s.id === 'gone_test').status === 'retired' && !l4.counts.byStatus.gone && l4.counts.retired === 1 && l4.counts.failing === 0 && runs4.slice(-1)[0][6] === 0, 'über 14 Tage weg → retired, kein Fehler (latest.counts.failing, runs.json)');

// Lauf 4b: Start-Ziel-Ströme. Zustand: alle Quellen stabil, Positionen 1,45 km südlich, 20 Min. alt → Versätze = Fahrten (Tagessumme privat).
// Tagessumme von gestern untergeschoben → dieser Lauf veröffentlicht gestern mit Mindestschwelle; heute bleibt bis Tagesende privat.
{
  const fl0 = JSON.parse(await readFile('test/out/flows/index.json', 'utf8'));
  assert(fl0.days.length === 0 && fl0.collecting === T.dayOf(Date.now()) && !existsSync(`test/out/flows/${fl0.collecting}.json`) && existsSync(path.join(TRACK_DIR, 'flows-raw.json.gz')), 'flows: laufender Tag nur privat (TRACK_DIR), nicht veröffentlicht');
  const f = path.join(TRACK_DIR, 'state.json.gz'); const s = JSON.parse(gunzipSync(await readFile(f)).toString('utf8'));
  s.at -= 20 * 60e3; for (const id of Object.keys(s.srcStats)) s.srcStats[id] = { runs: 10, present: 500, gone: 20, moved: 40, newc: 30, returned: 30 };
  for (const e of Object.values(s.v)) e[0] -= 1300; await writeFile(f, gzipSync(JSON.stringify(s)));
  const yd = T.dayOf(Date.now() - 86400e3);
  await writeFile(path.join(TRACK_DIR, 'flows-raw.json.gz'), gzipSync(JSON.stringify({ version: 1, day: yd, runs: 3, stable: { '08416041': ['Bolt'] }, rows: {
    '08416041|Bolt|scooter|1': { '19408:2586>19412:2590': [3, 900e3, 3000], '19408:2586>19409:2587': [1, 300e3, 400] }, '08416041|Lime|scooter|1': { '19408:2586>19412:2590': [1, 200e3, 900] } } })));
  // geschätzte Ströme: gestrige Zählungen (privat) – Voi rotierend (s/e), Bolt in Tübingen stabil (vs/ve = Validierung; s/e dort nicht geschätzt)
  const eIdx0 = JSON.parse(await readFile('test/out/flows-est/index.json', 'utf8'));
  assert(eIdx0.estimated === true && eIdx0.days.length === 0 && eIdx0.collecting === T.dayOf(Date.now()) && existsSync(path.join(TRACK_DIR, 'flows-est-raw.json.gz')) && !existsSync('test/out/flows-est-raw.json.gz'), 'flows-est: Zählungen des laufenden Tages nur privat (TRACK_DIR)');
  const ydAt = Date.parse(`${yd}T09:00:00Z`), estRun = (at, dt, c) => ({ at, dt, band: 2, gap: 0, s: {}, e: {}, vs: {}, ve: {}, ...c });
  await writeFile(path.join(TRACK_DIR, 'flows-est-raw.json.gz'), gzipSync(JSON.stringify({ version: 1, day: yd, tail: [], learn: {}, vSame: { scooter: 4 }, vLate: {}, lost: 0, runs: [estRun(ydAt - 20 * 60e3, null, { gap: 1 }),
    estRun(ydAt, 20 * 60e3, { s: { 'Voi|scooter': { '08416041|19408:2586': 6 }, 'Bolt|scooter': { '08416041|19408:2586': 5 } }, e: { 'Voi|scooter': { '08416041|19412:2590': 5 }, 'Bolt|scooter': { '08416041|19412:2590': 5 } },
      vs: { 'Bolt|scooter': { '08416041|19408:2586': 4 } }, ve: { 'Bolt|scooter': { '08416041|19412:2590': 3, '08416041|19409:2587': 1 } } })] })));
  await collect({ ...env3, SOURCES_FILE: path.join(tmp, 's4.json'), REFRESH_STATIC: '0' });
  const fl = JSON.parse(await readFile('test/out/flows/index.json', 'utf8')), pub = JSON.parse(await readFile(`test/out/flows/${yd}.json`, 'utf8'));
  const rawT = JSON.parse(gunzipSync(await readFile(path.join(TRACK_DIR, 'flows-raw.json.gz'))).toString('utf8'));
  const tripsT = Object.values(rawT.rows).reduce((a, r) => a + Object.values(r).reduce((x, v) => x + v[0], 0), 0);
  assert(fl.days.join() === yd && fl.collecting === T.dayOf(Date.now()) && fl.min === 2 && fl.fields.join() === T.FLOW_FIELDS.join(), 'flows/index.json: abgeschlossener Tag gelistet, heute in Sammlung');
  assert(JSON.stringify(pub.flows) === JSON.stringify([['08416041', '19408:2586', '19412:2590', 'Bolt', 'scooter', 1, 3, 900, 3000]]) && pub.munis['08416041'].below === 2 && pub.total.trips === 5 && pub.stable['08416041'][0] === 'Bolt', 'flows/<gestern>.json: nur Zeilen ≥ 2 Fahrten, Einzelfahrten als Summe unter Mindestschwelle');
  const run4b = JSON.parse(await readFile('test/out/runs.json', 'utf8')).runs.slice(-1)[0];
  assert(rawT.day === T.dayOf(Date.now()) && tripsT >= 4 && tripsT === run4b[9] && Object.keys(rawT.rows).every(k => /^\d{8}\|.+\|.+\|[0-5]$/.test(k)) && !existsSync('test/out/flows-raw.json.gz') && !existsSync('test/out/track'), `Tagessumme heute privat: ${tripsT} Fahrten mit Start und Ziel = gezählte Fahrten des Laufs (gesperrtes a2 nicht), nichts davon im Datenzweig`);
  const eIdx = JSON.parse(await readFile('test/out/flows-est/index.json', 'utf8')), est = JSON.parse(await readFile(`test/out/flows-est/${yd}.json`, 'utf8'));
  assert(eIdx.days.join() === yd && eIdx.collecting === T.dayOf(Date.now()) && eIdx.method?.name === 'sinkhorn-gravity' && eIdx.quality?.measured > 0, 'flows-est/index.json: gestern veröffentlicht, Methode und Güte im Verzeichnis');
  assert(est.estimated === true && est.flows.length === 1 && est.flows[0][3] === 'Voi' && est.flows[0][6] === 3.8 && est.flows[0][7] === null && est.flows.every(r => r[6] >= 2) && est.stableSkipped === 5 && est.cell[0] === 2 * T.CELL_LAT, `flows-est/<gestern>.json: Voi geschätzt (${est.flows[0]?.[6]} erwartete Fahrten = 6 Beginne × w0 0,64, 500-m-Zellen), Bolt (stabil in der Gemeinde) nicht doppelt`);
  assert(est.quality.cpc > 0 && est.quality.measured === 5 && est.quality.grid.length === 2 && Number.isFinite(est.runtimeMs.total), `Validierung an stabilen Kennungen in der Datei (CPC ${est.quality.cpc}, ${est.quality.measured} gemessene Fahrten)`);
  const eRaw = JSON.parse(gunzipSync(await readFile(path.join(TRACK_DIR, 'flows-est-raw.json.gz'))).toString('utf8'));
  const veT = Object.values(eRaw.runs.at(-1).ve).reduce((a, m) => a + Object.values(m).reduce((x, y) => x + y, 0), 0);
  const keysOf = (o, out = []) => { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { out.push(k); keysOf(v, out); } return out; };
  assert(eRaw.day === T.dayOf(Date.now()) && eRaw.tail.length === 2 && veT === tripsT && keysOf(eRaw).every(k => !k.includes('>')) && !existsSync('test/out/flows-est-raw.json.gz'), `Zählungen heute privat: ${veT} Validierungs-Enden = gemessene Fahrten, Vortag als tail, keine Zellenpaare`);
}
// Lauf 5: Lücke (Zustand 2 h alt) → Flag 0, gestörte Stunde im Tagesdokument, Verlauf-Flag 0
{
  const f = path.join(TRACK_DIR, 'state.json.gz'); const s5 = JSON.parse(gunzipSync(await readFile(f)).toString('utf8'));
  s5.at -= 2 * 3600e3; await writeFile(f, gzipSync(JSON.stringify(s5)));
}
await collect({ ...env3, SOURCES_FILE: path.join(tmp, 's4.json'), REFRESH_STATIC: '0' });
const ev5 = JSON.parse(await readFile(`test/out/events/${JSON.parse(await readFile('test/out/events/index.json', 'utf8')).days.slice(-1)[0]}.json`, 'utf8'));
const h5 = JSON.parse(await readFile(`test/out/history/${T.dayOf(Date.now())}.json`, 'utf8')); // Tagesschnitt Europe/Berlin
assert(ev5.runs.slice(-1)[0][2] === 0 && ev5.gapHours.length >= 1 && h5.f.slice(-1)[0] === 0, 'Lauf nach Lücke: runs-Flag 0, gapHours, history f = 0');
ex.close(); srv.kill();
await rm(tmp, { recursive: true, force: true });
