import { spawn } from 'node:child_process';
import { rm, mkdir, readFile, writeFile, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { startExtra } from './fixtures/extra-server.mjs';
import * as T from '../lib/pulse-track.js';
const srv = spawn('node', ['test/server.mjs'], { stdio: 'inherit' });
await new Promise(r => setTimeout(r, 800));
await rm('test/out', { recursive: true, force: true }); await mkdir('test/out', { recursive: true });
const collect = (env = {}) => new Promise(r => spawn('node', ['scripts/collect.mjs'], { stdio: 'inherit', env: { ...process.env, DATA_DIR: 'test/out', SOURCES_FILE: 'test/sources.json', BOUNDARIES: 'test/boundaries.json', SKIP_CONTEXT: '1', CALENDAR_URL: '', WEATHER_URL: '', AUTOBAHN_URL: '', ...env } }).on('exit', r));
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
assert(idle.groups['08416041|Bolt|scooter']?.[6] === 1 && idle.version === 2 && idle.buckets.at(-1) === '> 72 h' && Number.isFinite(idle.trackStart) && idle.censored && Array.isArray(idle.unusable), 'Standzeiten aggregiert (6 Klassen mit > 72 h, Summe an Stelle 7, Mindestwerte je Klasse, Verfolgungsbeginn; Z5/Z6)');
assert(d.municipalities['08416041']?.c?.length === 2 && Math.abs(d.municipalities['08416041'].c[0] - 48.525) < 1e-6, 'Gemeinde-Mittelpunkt c = [lat, lon]');
assert(d.sources.find(s => s.id === 'bolt_test').checks?.label?.includes('Basisprüfung') && d.sources.find(s => s.id === 'bolt_test').licenseId === 'CC-BY-4.0', 'Quelle mit Basisprüfung und Lizenz-ID');
assert(!existsSync('test/out/calendar.json') && d.measure?.version === 1 && !d.eventChecks, 'Kalender offline abgeschaltet (CALENDAR_URL leer, keine calendar.json); Messbasis vorhanden, ohne vollständigen Tag keine Ampel');

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
// M-1: Spiegelpaar mit umgeschlüsselten Kennungen (direkt vs. Landesfeed als Manifest-Kind); M-6/M-2: Manifest mit Kind (Lime, Ladestand ≤ 35 %)
extra.push({ id: 'rk_direct', name: 'RK direkt', operator: 'nextbike', api: 'gbfs', url: `${ex.base}/rk/a/gbfs.json`, directories: ['mobilitydata'], priority: 2 },
  { id: 'rk_land:source-rk', parent: 'rk_land', name: 'RK Land', operator: 'nextbike', api: 'gbfs', url: `${ex.base}/rk/b/gbfs.json`, directories: ['mobidrom_nrw'], priority: 2 },
  { id: 'mf_test', name: 'Manifest Test', operator: 'Lime', api: 'gbfs', url: `${ex.base}/mf/manifest.json`, directories: ['mobidrom_nrw'], priority: 2 },
  { id: 'rl_test', name: 'Bird Test', operator: 'Bird', api: 'gbfs', url: `${ex.base}/rk/d/gbfs.json`, directories: ['mobilitydata'], priority: 2 }, // kleine Reichweiten-Skala (Schwelle der Quelle)
  { id: 'rf_test', name: 'Donkey Test', operator: 'Donkey', api: 'gbfs', url: `${ex.base}/rk/e/gbfs.json`, directories: ['mobilitydata'], priority: 2 }); // Platzhalter-Reichweite 1 km
const slow = [{ id: 'slow_test', name: 'Langsam', operator: 'Zeus', api: 'gbfs', url: `${ex.base}/slow/gbfs.json`, directories: ['mobilitydata'] }, { id: 'big_test', name: 'Groß', operator: 'Zeus', api: 'gbfs', url: `${ex.base}/big/gbfs.json`, directories: ['mobilitydata'] }];
const auth_sources = { t: { host: new URL(ex.base).host, headers: { 'x-api-key': 'MP_TEST_KEY' }, env: ['MP_TEST_KEY'] } };
await writeFile(path.join(tmp, 's3.json'), JSON.stringify({ ...cat, auth_sources, sources: [...cat.sources, ...extra, ...slow] }));
await writeFile(path.join(tmp, 's4.json'), JSON.stringify({ ...cat, auth_sources, sources: [...cat.sources, ...extra] }));
// nur Lauf 4: 250 neue E-Scooter (Zeus Stuttgart) → Standzeit unbrauchbar (Z5), Befund muss in die Ampel (eventChecks nach der Verfolgung)
await writeFile(path.join(tmp, 's4i.json'), JSON.stringify({ ...cat, auth_sources, sources: [...cat.sources, ...extra, { id: 'zi_test', name: 'Zeus Test', operator: 'Zeus', api: 'gbfs', url: `${ex.base}/rk/z/gbfs.json`, directories: ['mobilitydata'], priority: 2 }] }));
// Obergrenze für die Testgemeinde (Bolt-E-Scooter), damit der Sammler caps-log.json schreibt
await writeFile(path.join(tmp, 'ref.json'), JSON.stringify({ obergrenzen: [{ ags: '08416041', ort: 'Tübingen (Test)', type: 'scooter', gesamt: 1, jeAnbieter: 5, quelle: 'Test', url: 'https://example.org' }] }));
// Städte laut Anbieter (Abdeckung): Bolt nennt Tübingen und Stuttgart, Dott „Tubingen“ (englische Umschrift)
await writeFile(path.join(tmp, 'cities.json'), JSON.stringify({ erstellt: '2026-11-01', anbieter: [{ name: 'Bolt', quelle: 'https://example.org/bolt', staedte: [{ ort: 'Tübingen' }, { ort: 'Stuttgart' }] }, { name: 'Dott', quelle: 'https://example.org/dott', staedte: [{ ort: 'Tubingen' }] }] }));
const env3 = { TRACK_DIR, HEALTH_FILE: path.join(tmp, 'health.txt'), REFRESH_STATIC: '1', MP_TEST_KEY: 'geheim-123', FETCH_TIMEOUT: '1500', MAX_BYTES: '200000', REFERENCE_FILE: path.join(tmp, 'ref.json'), OPERATOR_CITIES_FILE: path.join(tmp, 'cities.json'), ZONES_FILE: '',
  ZONE_WATCH: JSON.stringify({ type: 'Feature', properties: { name: 'Testzone', limits: { scooter: { maximum: 777 } } }, geometry: { type: 'Polygon', coordinates: [[[8.9, 48.4], [9.3, 48.4], [9.3, 48.9], [8.9, 48.9], [8.9, 48.4]]] } }) };
const t3 = Date.now();
await collect({ ...env3, SOURCES_FILE: path.join(tmp, 's3.json') });
const l3 = JSON.parse(await readFile('test/out/latest.json', 'utf8'));
const S3 = (id) => l3.sources.find(s => s.id === id);
// mit TRACK_DIR liegt der laufende Tag privat (M-11); veröffentlicht wird er erst beim Stundenwechsel
const evWork = async () => JSON.parse(gunzipSync(await readFile(path.join(TRACK_DIR, 'events-work.json.gz'))).toString('utf8'));
const ev3 = await evWork();
{
  const pub3 = JSON.parse(await readFile(`test/out/events/${ev3.day}.json`, 'utf8'));
  assert(pub3.runs.length === ev3.runs.length - 1 && !existsSync(`test/out/cells/${ev3.day}.json`) && existsSync(path.join(TRACK_DIR, 'cells-work.json.gz')), 'M-11: Lauf dieser Stunde nur privat (events-work), öffentliche Tagesdatei der Zellen entfernt');
}
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
assert(dl.breaks && typeof dl.breaks === 'object' && !Array.isArray(dl.breaks) && Object.values(dl.breaks).every(d => /^\d{4}-\d{2}-\d{2}$/.test(d)), `history/daily.json: breaks (Bruchmarken je Reihe, Z2; ${Object.keys(dl.breaks || {}).length} Reihen)`);
const sq3 = JSON.parse(await readFile('test/out/stations-quota.json', 'utf8'));
assert(ai.days >= 1 && /^\d{4}-\d{2}-\d{2}$/.test(ai.firstDay) && dl.fields.join() === 'available,total,disabled,lowBattery,stations,stationsEmptyDock,runs' && dl.series['08416041|Bolt|scooter'], 'archive/index.json days/firstDay, history/daily.json');
assert(sq3.fields[8] === 'virtual' && sq3.stations.some(x => x[8] === 1), 'Stationsquote: Spalte virtual');
// Fläche je Gemeinde, Fehler nach Ursache, Minuten je Ortsstunde
assert(Math.abs(l3.municipalities['08111000'].areaKm2 - 0.25 * 0.17 * 111.2 * 111.2 * Math.cos(48.785 * Math.PI / 180)) < 2, 'areaKm2 je Gemeinde (Testrechteck Stuttgart ≈ 351 km²)');
assert(l3.counts.errorCauses.timeout === 1 && l3.counts.errorCauses.tooLarge === 1 && l3.counts.errorCauses.http404 === 1 && S3('slow_test').errorCause === 'timeout', 'Fehler nach Ursache in latest.json counts.errorCauses');
assert(ev3.hourMin?.length === 24 && ev3.hourMin.reduce((a, b) => a + b, 0) >= 1380, 'Tagesdokument mit hourMin');

// M-1: Landesfeed mit umgeschlüsselten Kennungen zählt nicht (30 statt 60 Räder), Quelle als Kopie geführt; M-2: Ladestand-Skala unplausibel
{
  const rkL = S3('rk_land:source-rk'), kid = S3('mf_test:mfkid');
  assert(rkL?.status === 'duplicate' && rkL.duplicateOf === 'rk_direct' && rkL.duplicateKind === 'rekeyed' && rkL.feedStatus === 'live' && l3.dedupe.mirrorDropped === 30 && l3.mirrors.some(m => m.of === 'rk_direct' && m.source === 'rk_land:source-rk' && m.seen === l3.at),
    `M-1: Spiegelquelle mit umgeschlüsselten Kennungen verworfen (${l3.dedupe.mirrorDropped} Fahrzeuge), Status duplicate (rekeyed), Paar in latest.json → mirrors`);
  const ops3 = JSON.parse(await readFile('test/out/ops/BW.json', 'utf8'));
  const nbRk = ops3.vehicles.filter(v => ops3.ops[v[2]] === 'nextbike' && Math.abs(v[1] - 9.10) < 1e-6).length;
  assert(nbRk === 30, `M-1: Disposition (ops/BW.json) mit 30 statt 60 Rädern (${nbRk})`);
  assert(kid?.parent === 'mf_test' && kid.batteryScale?.suspect && kid.batteryScale.p99 < 60 && kid.checks.items[0]?.msg?.startsWith('Ladestand-Skala unplausibel') && ops3.vehicles.filter(v => ops3.ops[v[2]] === 'Lime').every(v => v[5] === null),
    `M-2: Ladestand-Skala unplausibel (p99 ${kid?.batteryScale?.p99} %) → in der Feed-Prüfung, Ladestand nicht verwendet`);
  // Q-2: Energie je Gruppe in latest.json (Regel wie R.energyLow), Lime nur über die Reichweite; ready = buchbar und Energie ausreichend
  const R2 = await import('../lib/pulse-report.js');
  const eOps = R2.energyFromOps(ops3, { rangeOnly: (op) => l3.energy.rangeOnlyOps.includes(op) }), rOps = R2.readinessFromOps(ops3, { rangeOnly: (op) => l3.energy.rangeOnlyOps.includes(op) });
  const gk = Object.keys(l3.groups).filter(k => k.startsWith('08') && l3.groups[k].energyKnown != null);
  assert(l3.energy?.version === 1 && l3.energy.fields.join() === 'energyKnown,energyLow,energyRangeOnly,energyRangeOnlyLow,ready' && gk.length > 0 && gk.every(k => { const e = eOps.get(k); return !k.startsWith('08111000') || (e && e.known === l3.groups[k].energyKnown && e.low === l3.groups[k].energyLow); }),
    `Q-2: latest.json groups mit energyKnown/energyLow (gleich energyFromOps aus ops/BW.json, ${gk.length} Gruppen)`);
  const kidKey = Object.keys(l3.groups).find(k => k.includes('|Lime|scooter'));
  assert(kidKey && l3.groups[kidKey].energyKnown == null && S3('mf_test:mfkid').counts.batteryNative === 0, 'Q-2: Lime-Kind ohne verwendbaren Ladestand (Skala unplausibel, keine Reichweite) → keine Energieangabe; counts.batteryNative = 0');
  // Q-6: Grenzen je Land mit bbox
  const bIdx = JSON.parse(await readFile('test/out/boundaries/index.json', 'utf8')), bBW = JSON.parse(await readFile('test/out/boundaries/BW.json', 'utf8'));
  assert(bIdx.version === 1 && bIdx.states.BW.features === bBW.features.length && bBW.features.every(f => Array.isArray(f.bbox) && f.bbox.length === 4 && f.bbox[0] <= f.bbox[2]) && bBW.features.some(f => f.properties.ags === '08416041' && f.bbox.join() === '9,48.49,9.12,48.56') && existsSync('test/out/boundaries-active.json'),
    'Q-6: boundaries/<Land>.json mit bbox je Gemeinde, boundaries/index.json; boundaries-active.json bleibt');
  assert(ops3.vehicleFields.endsWith(',gemeinde,reichweiteAbgeleitet,reichweiteSchwelleKm,reichweiteKonstant,standzeitMindestens') && ops3.vehicleFieldsNote?.startsWith('Felder am Zeilenende ohne Wert entfallen') && ops3.vehicles.every(v => v.length >= 10 && v.length <= 13 && (v[9] === 0 || v[9] === 1) && v[v.length - 1] != null && (v.length < 13 || v[12] === 1)) && Number.isFinite(ops3.trackStart),
    'M-16: ops/<Land>.json Fahrzeugfeld 10 „reichweiteAbgeleitet“ (1/0), Feld 11 „reichweiteSchwelleKm“, Feld 12 „reichweiteKonstant“; keine Zeile endet mit null');
  {
    // Feld 13 standzeitMindestens (Z6) steht bei Fahrzeugen, die seit Beginn der Verfolgung unbewegt sind; die Länge davor wie bisher
    const core = (v) => { const r = v.slice(0, 12); while (r.length && r[r.length - 1] == null) r.pop(); return r.length; };
    const len = (op) => [...new Set(ops3.vehicles.filter(v => ops3.ops[v[2]] === op).map(core))].join();
    const plain = ops3.vehicles.filter(v => !['Bird', 'Donkey'].includes(ops3.ops[v[2]]));
    assert(plain.length > 0 && plain.every(v => core(v) === 10) && len('Bird') === '11' && len('Donkey') === '12', `Zeilenlänge: ohne Schwelle/Kennzeichen 10 Felder (Nullen am Ende entfallen), Bird 11 (Schwelle), Donkey 12 (explizites null vor dem Kennzeichen)`);
    assert(ops3.vehicles.some(v => v[12] === 1) && ops3.vehicles.every(v => v.length < 13 || (v[12] === 1 && v[7] != null)), `Z6: Feld 13 standzeitMindestens = 1 bei seit Verfolgungsbeginn unbewegten Fahrzeugen (${ops3.vehicles.filter(v => v[12] === 1).length} von ${ops3.vehicles.length}), nur mit Standzeit`);
    const O3 = await import('../lib/pulse-ops.js');
    const rf = S3('rf_test'), dv = ops3.vehicles.filter(v => ops3.ops[v[2]] === 'Donkey'), gk = Object.keys(l3.groups).find(k => k.startsWith('08111000|Donkey|')), gD = l3.groups[gk];
    const swapD = O3.decodeFleet(ops3).vehicles.filter(v => v.operator === 'Donkey' && O3.needsSwap(v)).length;
    assert(rf?.rangeFlat?.flat && rf.rangeFlat.modeKm === 1 && rf.batteryScale?.suspect && rf.checks.items.some(i => i.msg.startsWith('Reichweite konstant')) && dv.length === 60 && dv.every(v => v[5] === null && v[6] === 1 && v[10] === null && v[11] === 1)
      && gD?.energyKnown == null && gD.rangeKnown === 60 && gD.lowRange === 60 && swapD === 0 && l3.energy.rangeFlat?.maxModeShare === 0.95,
      `konstante Reichweite (Donkey-Muster): sources[].rangeFlat, Befund in der Feed-Prüfung, ops-Feld 12; Energie unbekannt statt niedrig (energyKnown ${gD?.energyKnown ?? 'fehlt'}, roh lowRange ${gD?.lowRange}), ${swapD} Tausch`);
  }
  // Reichweiten-Schwelle relativ zur Quelle: Bird-Test (kein Ladestand, Reichweite 0–11,8 km, p95 11,2 km) → 2,2 km statt 5 km
  {
    const O3 = await import('../lib/pulse-ops.js');
    const rl = S3('rl_test'), birdV = ops3.vehicles.filter(v => ops3.ops[v[2]] === 'Bird'), gB = l3.groups['08111000|Bird|scooter'];
    assert(rl?.rangeLimitKm === 2.2 && rl.rangeLimit?.p95Km === 11.2 && rl.rangeLimit.maxP95Km === 25 && rl.checks.items.some(i => i.msg.startsWith('Reichweite klein') && i.msg.includes('2,2 km')) && birdV.length === 60 && birdV.every(v => v[10] === 2.2) && ops3.vehicles.filter(v => ops3.ops[v[2]] !== 'Bird').every(v => v[10] == null),
      `Reichweiten-Schwelle: sources[].rangeLimitKm ${rl?.rangeLimitKm} km (p95 ${rl?.rangeLimit?.p95Km} km), Hinweis in der Feed-Prüfung, ops-Feld 11 je Fahrzeug (andere Quellen ohne Wert)`);
    const swapB = O3.decodeFleet(ops3).vehicles.filter(v => v.operator === 'Bird' && O3.needsSwap(v)).length;
    assert(gB?.energyKnown === 60 && gB.energyLow === 11 && gB.lowRange === 25 && swapB === 11 && l3.energy.rangeLimit?.share === 0.2,
      `Reichweiten-Schwelle: Energie niedrig in latest.json ${gB?.energyLow} (unter 2,2 km; unter 5 km wären es ${gB?.lowRange}), Disposition ${swapB} Tausch`);
  }
  assert(ops3.stationFields.endsWith(',physisch,virtuell') && ops3.stations.every(r => r.length === 12 && [0, 1, null].includes(r[11])) && ops3.stations.some(r => r[11] === 1), 'ops/<Land>.json: Stationsfeld 12 „virtuell“ (1/0/null)');
}
// Lauf 4: normaler Lauf mit TRACK_DIR (Flag 1, keine Scheinereignisse), Tarifänderung, Quelle seit > 14 Tagen weg; Manifest fällt aus (M-6)
ex.st.price = 1.5; ex.st.manifestUp = false;
l3.sources.find(s => s.id === 'gone_test').goneSince = Date.now() - 15 * 86400e3;
await writeFile('test/out/latest.json', JSON.stringify(l3));
// Messbasis/Ampel (Agent M): Vortag als vollständig veröffentlichte Ereignisdatei – Lime mit Abholungen im Takt der Fahrten (rot), Voi unauffällig;
// Kalender: alte Datei vorhanden, Dienst antwortet 404 → Datei bleibt, Lauf läuft weiter (CALENDAR_URL auf den Testserver)
const ydM = T.dayOf(Date.now() - 86400e3), m0 = Date.parse(`${ydM}T00:00:00Z`) - 3600e3, H24 = (f) => Array.from({ length: 24 }, (_, h) => f(h));
await writeFile(`test/out/events/${ydM}.json`, JSON.stringify({ day: ydM, version: 2, runs: Array.from({ length: 72 }, (_, i) => [m0 + (i + 1) * 20 * 60e3, 20 * 60e3, 1, `${T.METHOD_VERSION}@test`]), gapHours: [], hourMin: new Array(24).fill(60),
  groups: { '08111000|Lime|scooter': { start: H24(h => 10 + h), end: H24(h => 10 + h), pickup: H24(h => 5 + h), swap: H24(() => 1) }, '08111000|Voi|scooter': { start: H24(h => 10 + (h % 5)), end: H24(h => 10 + (h % 5)), pickup: H24(() => 0), swap: H24(() => 1) },
    '08111000|Zeus|scooter': { start: H24(() => 1), end: H24(() => 1), pickup: H24(() => 0), swap: H24(() => 0) } },
  published: { at: Date.now(), through: null, complete: true } }));
const calOld = JSON.stringify({ version: 1, generatedAt: '2026-01-01T00:00:00.000Z', source: 'OpenHolidays API (openholidaysapi.org, ODbL)', from: '2025-01-01', to: '2026-12-31', states: { BW: { '2026-11-02': 'F' } } });
await writeFile('test/out/calendar.json', calOld);
await collect({ ...env3, SOURCES_FILE: path.join(tmp, 's4i.json'), CALENDAR_URL: ex.base, WEATHER_URL: ex.base, AUTOBAHN_URL: `${ex.base}/autobahn`, FORECAST_EVERY_MIN: '0' });
const l4 = JSON.parse(await readFile('test/out/latest.json', 'utf8'));
{
  const wd = T.dayOf(Date.now()), wDay = (await readdir('test/out/weather').catch(() => [])).filter(n => n.endsWith('.json')).map(n => n.slice(0, -5)).sort(), wf = wDay.length ? JSON.parse(await readFile(`test/out/weather/${wDay[0]}.json`, 'utf8')) : null;
  const wc = wf && Object.values(wf.cells)[0];
  assert(wDay.length >= 1 && wf.version === 1 && wf.hours.length === 24 && wc && wc.t.length === 24 && wc.t[3] === null && wc.t[4] === 10 && wc.p[5] === 1.2 && Object.keys(wf.ags).length >= 1 && /DWD/.test(wf.source) && !JSON.stringify(wf).includes('999'),
    `Wetter-Cache: weather/<UTC-Tag>.json mit 24 Stunden je Rasterzelle (${wDay.join(', ')}), unplausibler Wert → null, Gemeinde → Zelle`);
  void wd;
  const tomorrow = new Date(Date.now() + 86400e3).toISOString().slice(0, 10);
  assert(wDay.includes(tomorrow), `Wetter-Cache: auch die Datei für morgen (${tomorrow}, Vorhersage) wird geschrieben`);
  const before = new Date(Date.now() - 2 * 86400e3).toISOString().slice(0, 10), wReq = ex.log.filter(x => x.path === '/weather');
  assert(wDay.includes(before) && wReq.length && wReq.every(x => x.q?.date === before), `Wetter nachgeholt: der UTC-Tag vor dem ältesten Ereignistag (${before}) fehlte und kommt im selben Abruf mit (date=${wReq[0]?.q?.date})`);
  const inc = await readFile(`test/out/incidents/${T.dayOf(Date.now())}.json`, 'utf8').then(JSON.parse).catch(() => null), incT = await readFile(`test/out/incidents/${T.dayOf(Date.now() + 86400e3)}.json`, 'utf8').then(JSON.parse).catch(() => null);
  const warnH = Object.values(inc?.ags || {}).flatMap(a => a.warn || []).filter(v => v === 3).length + Object.values(incT?.ags || {}).flatMap(a => a.warn || []).filter(v => v === 3).length, h = T.hourOf(Date.now());
  const road = Object.entries(inc?.ags || {}).filter(([, a]) => a.road?.[h] === 1).map(([k]) => k);
  assert(inc?.version === 1 && warnH >= 3 && !JSON.stringify(inc).includes('extreme') && inc.sources.warn?.cells >= 1, `Warnungen (DWD): incidents/<Tag>.json mit Stufe 3 für die kommenden Stunden (${warnH} Gemeinde-Stunden), Probewarnung ignoriert, keine Texte`);
  assert(road.length === 1 && inc.sources.road?.roads === 2 && inc.sources.road.fails === 2 && inc.sources.road.items === 2, `Autobahn: Sperrung + Stau → ${road.join(', ')} zur Stunde ${h}; Baustellenhinweis zählt nicht; Ausfall einer Autobahn bricht nicht ab`);
  const fl = await readFile('test/out/forecast/latest.json', 'utf8').then(JSON.parse).catch(() => null), fg = await readFile('test/out/forecast/log.json', 'utf8').then(JSON.parse).catch(() => null);
  assert(fl && fl.version === 1 && ['insufficient', 'learning', 'active'].includes(fl.status) && fg && fg.version === 1 && typeof fg.evals === 'object', `Prognose: forecast/latest.json und log.json vom Sammler geschrieben (Status ${fl?.status}, ${fl?.trainDays} Tage)`);
  const pr = l4.presence, mp = Object.values(l4.municipalities || {});
  assert(pr?.version === 1 && pr.days >= 1 && mp.length && mp.every(m => ['fest', 'aktiv', 'neu', 'vereinzelt'].includes(m.presence?.status)) && l4.counts.municipalitiesShown === mp.filter(m => m.presence.status !== 'vereinzelt').length,
    `Betriebsgebiete: jede Gemeinde eingestuft (${JSON.stringify(pr?.counts)}), gezeigt ${l4.counts?.municipalitiesShown} von ${mp.length}`);
  assert(fl.env?.sources?.days >= 1 && fl.env.sources.warnAt && fl.env.sources.roadAt && fg.memory?.v === 1, `Prognose kennt die Umgebung (${fl.env?.sources?.days} Tagesdateien, Ereignisliste ${fl.env?.sources?.curated} Einträge) und führt das Gedächtnis`);
}
{
  const E2 = await import('../lib/pulse-econ.js'), ecL = l4.eventChecks?.groups?.['08111000|Lime|scooter'], mY = l4.measure?.days?.[ydM];
  assert(l4.eventChecks?.day === ydM && ecL?.level === 'bad' && ecL.checks.flags.includes('pickup') && l4.eventChecks.groups['08111000|Voi|scooter']?.level === 'ok' && l4.eventChecks.rules?.pickupBad === E2.EVENT_CHECKS.pickupBad,
    `Ampel: latest.json → eventChecks des letzten vollständigen Tags (${l4.eventChecks?.day}), Lime rot (Abholung ${ecL?.checks?.pickupShare}, r ${ecL?.checks?.r}), Voi ok`);
  const zi = l4.sources.find(s => s.id === 'zi_test'), ecZ = l4.eventChecks?.groups?.['08111000|Zeus|scooter'];
  assert(zi?.idleUnusable === true && zi.idleCheck?.shortShare === 1 && ecZ?.level === 'warn' && ecZ.checks.flags.join() === 'idle' && ecZ.checks.idleUnusable === 1,
    `Ampel nach der Verfolgung: Standzeit unbrauchbar (Zeus, ${zi?.idleCheck?.n} Fahrzeuge) erscheint als gelber Befund idle (vorher nie, eventChecks vor idleUnusable)`);
  assert(l4.eventChecks.ruleNow === T.METHOD_VERSION && l4.eventChecks.ruleCurrent === true && l4.eventChecks.dayRules.join() === T.METHOD_VERSION, 'Ampel: Regelstand des ausgewerteten Tags = aktueller Regelstand → rot schließt aus');
  assert(mY?.full && mY.complete && mY.rules.join() === T.METHOD_VERSION && l4.measure.version === 1 && l4.measure.days[T.dayOf(Date.now())]?.obs?.length === 24 && !l4.measure.days[T.dayOf(Date.now())].complete,
    'Messbasis: latest.json → measure.days (Vortag voll und abgeschlossen, Regelstand vor „@“; laufender Tag offen)');
  assert(await readFile('test/out/calendar.json', 'utf8') === calOld && E2.dayType('2026-11-02', 'BW', JSON.parse(calOld)) === 'F' && E2.dayType('2026-11-01', 'BW', null) === 'H',
    'Kalender: Dienst ohne gültige Antwort → alte calendar.json bleibt; dayType mit Kalender bzw. lokaler Rückfall');
}
const ev4 = await evWork();
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
    && row('dott', '08416041')?.claimed === true && row('dott', '08416041').cat === (dottTue ? 'abgedeckt' : 'gesperrt') /* M-17: bekannte Lücke vor veralteter Quelle */ && row('bolt', '08416041').lastActive != null === !!boltTue,
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
{
  const kid4 = l4.sources.find(s => s.id === 'mf_test:mfkid');
  assert(kid4?.status === 'error' && kid4.errors[0] === 'Manifest ausgefallen' && kid4.parent === 'mf_test' && kid4.manifestMissingSince > 0 && l4.sources.find(s => s.id === 'mf_test')?.status === 'error', 'M-6: Kind eines ausgefallenen Manifests aus dem vorigen Stand mit Status error (keine Scheinfahrten, siehe runs.json oben)');
  const cellsDay = JSON.parse(await readFile(`test/out/cells/${T.dayOf(Date.now())}/BW.json`, 'utf8'));
  assert(cellsDay.taintChecked === T.CELLS_TAINT_VERSION && !(cellsDay.bandTainted || []).some(Boolean) && cellsDay.minCount === 3 && cellsDay.below, 'M-3/M-11: Zellendatei geprüft (taintChecked, kein Altlauf), kleine Zellen unterdrückt (minCount 3, below)');
}
assert(l4.sources.find(s => s.id === 'gone_test').status === 'retired' && !l4.counts.byStatus.gone && l4.counts.retired === 1 && l4.counts.failing === 2 && runs4.slice(-1)[0][6] === 2, 'über 14 Tage weg → retired, kein Fehler (latest.counts.failing, runs.json: nur Manifest und Kind aus M-6)');

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
  // ältere Tagesdatei mit Schwelle 2 (Stand bis 6.11.2026): der Sammler zieht sie auf T.FLOW_MIN nach
  const yd2 = T.dayOf(Date.now() - 2 * 86400e3); await mkdir('test/out/flows', { recursive: true });
  await writeFile(`test/out/flows/${yd2}.json`, JSON.stringify({ version: 1, day: yd2, min: 2, fields: T.FLOW_FIELDS, flows: [['08416041', '1:1', '2:2', 'Bolt', 'scooter', 1, 3, 600, 900], ['08416041', '3:3', '4:4', 'Bolt', 'scooter', 1, 6, 1200, 1800]],
    munis: { '08416041': { trips: 10, shown: 9, below: 1, cut: 0, ops: { Bolt: 10 } } }, total: { trips: 10, shown: 9, below: 1, cut: 0 } }));
  await collect({ ...env3, SOURCES_FILE: path.join(tmp, 's4.json'), REFRESH_STATIC: '0' });
  const fl = JSON.parse(await readFile('test/out/flows/index.json', 'utf8')), pub = JSON.parse(await readFile(`test/out/flows/${yd}.json`, 'utf8')), old2 = JSON.parse(await readFile(`test/out/flows/${yd2}.json`, 'utf8'));
  assert(old2.min === T.FLOW_MIN && old2.flows.length === 1 && old2.flows[0][6] === 6 && old2.munis['08416041'].shown === 6 && old2.munis['08416041'].below === 4 && old2.total.trips === 10, 'flows/<vorgestern>.json (Schwelle 2) auf ≥ 5 Fahrten je Zeile nachgezogen');
  const rawT = JSON.parse(gunzipSync(await readFile(path.join(TRACK_DIR, 'flows-raw.json.gz'))).toString('utf8'));
  const tripsT = Object.values(rawT.rows).reduce((a, r) => a + Object.values(r).reduce((x, v) => x + v[0], 0), 0);
  assert(fl.days.join() === `${yd2},${yd}` && fl.collecting === T.dayOf(Date.now()) && fl.min === T.FLOW_MIN && fl.fields.join() === T.FLOW_FIELDS.join(), 'flows/index.json: abgeschlossene Tage gelistet, heute in Sammlung, Schwelle 5');
  assert(pub.min === 5 && pub.flows.length === 0 && pub.munis['08416041'].below === 5 && pub.total.trips === 5 && pub.stable['08416041'][0] === 'Bolt', 'flows/<gestern>.json: Paar mit 3 Fahrten unter der Schwelle 5 → nur als Summe (below)');
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
const ev5 = await evWork();
const h5 = JSON.parse(await readFile(`test/out/history/${T.dayOf(Date.now())}.json`, 'utf8')); // Tagesschnitt Europe/Berlin
assert(ev5.runs.slice(-1)[0][2] === 0 && ev5.gapHours.length >= 1 && h5.f.slice(-1)[0] === 0, 'Lauf nach Lücke: runs-Flag 0, gapHours, history f = 0');
// M-11: Stundenwechsel → veröffentlicht wird der Stand vor diesem Lauf (nur abgeschlossene Stunden); Bandwechsel → Zellen; Tageswechsel → vollständig
{
  const gz = async (f) => JSON.parse(gunzipSync(await readFile(path.join(TRACK_DIR, f))).toString('utf8'));
  const put = async (f, d) => writeFile(path.join(TRACK_DIR, f), gzipSync(JSON.stringify(d)));
  const ew = await gz('events-work.json.gz'), cw = await gz('cells-work.json.gz');
  for (const r of ew.runs) r[0] -= 3600e3; cw.lastAt -= 6 * 3600e3; await put('events-work.json.gz', ew); await put('cells-work.json.gz', cw);
  await collect({ ...env3, SOURCES_FILE: path.join(tmp, 's4.json'), REFRESH_STATIC: '0' });
  const day = T.dayOf(Date.now());
  const pub = JSON.parse(await readFile(`test/out/events/${day}.json`, 'utf8')), ew2 = await gz('events-work.json.gz');
  assert(pub.runs.length === ew.runs.length && pub.published?.complete === false && pub.published.through === ew.runs.at(-1)[0] && ew2.runs.length === ew.runs.length + 1, 'M-11: Stundenwechsel – veröffentlicht sind nur die Läufe der abgeschlossenen Stunden, der neue Lauf bleibt privat');
  const cBW = JSON.parse(await readFile(`test/out/cells/${day}/BW.json`, 'utf8'));
  const tot = (d) => { let a = 0; for (const m of Object.values(d.munis)) for (const c of Object.values(m)) a += c[0] + c[1]; for (const b of Object.values(d.below || {})) a += b.reduce((x, y) => x + y, 0); return a; };
  const workTot = (() => { let a = 0; for (const m of Object.values(cw.states.BW || {})) for (const c of Object.values(m)) a += c[0] + c[1]; return a; })();
  assert(cBW.published?.complete === false && cBW.published.through === cw.lastAt && cBW.minCount === 3 && tot(cBW) === workTot && Object.values(cBW.munis).every(m => Object.values(m).every(c => [0, 1, 2, 3, 4, 5].every(b => !(c[4 + b] + c[16 + b]) || c[4 + b] + c[16 + b] >= 3))),
    `M-11: Bandwechsel – Zellen veröffentlicht, Zelle × Band unter 3 Ereignissen unterdrückt, Summe mit below = privater Stand (${workTot})`);
  // Tageswechsel: privater Stand von „gestern“ wird vollständig veröffentlicht, heute beginnt neu
  const yd = T.dayOf(Date.now() - 86400e3);
  const ew3 = await gz('events-work.json.gz'), cw3 = await gz('cells-work.json.gz'); ew3.day = yd; cw3.day = yd; await put('events-work.json.gz', ew3); await put('cells-work.json.gz', cw3);
  await collect({ ...env3, SOURCES_FILE: path.join(tmp, 's4.json'), REFRESH_STATIC: '0' });
  const pubY = JSON.parse(await readFile(`test/out/events/${yd}.json`, 'utf8')), cY = JSON.parse(await readFile(`test/out/cells/${yd}/BW.json`, 'utf8')), ew4 = await gz('events-work.json.gz');
  const arY = JSON.parse(await readFile(`test/out/archive/${yd.slice(0, 7)}.json`, 'utf8'));
  assert(pubY.published?.complete === true && pubY.runs.length === ew3.runs.length && cY.published?.complete === true && ew4.day === day && ew4.runs.length === 1 && arY.days[yd],
    'M-11: Tageswechsel – Vortag vollständig veröffentlicht (Ereignisse, Zellen, Archiv), heute neu begonnen');
}
{
  // Wetter-Cache: Dienst antwortet 500 → bereits vorhandene (veraltete) Datei bleibt unverändert
  const wDay = (await readdir('test/out/weather').catch(() => [])).filter(n => n.endsWith('.json')).map(n => n.slice(0, -5)).sort(), f = `test/out/weather/${wDay[wDay.length - 1]}.json`;
  await writeFile(f, (await readFile(f, 'utf8')).replace(/"generatedAt":"[^"]+"/, '"generatedAt":"2026-01-01T00:00:00.000Z"'));
  const stale = await readFile(f, 'utf8'); ex.st.weatherDown = true;
  await collect({ ...env3, SOURCES_FILE: path.join(tmp, 's4.json'), REFRESH_STATIC: '0', WEATHER_URL: ex.base });
  assert(wDay.length >= 1 && await readFile(f, 'utf8') === stale, 'Wetter-Cache: Dienst antwortet 500 → alte Datei bleibt unverändert'); ex.st.weatherDown = false;
}
// Veröffentlichungstest: was im Datenzweig landet, hält die Datenschutz-Regeln ein (kehrt mit einer neuen Funktion keine Lücke zurück)
{
  const files = async (d) => (await readdir(d).catch(() => [])).filter(n => n.endsWith('.json')).map(n => path.join(d, n));
  const isCls = (m) => m == null || m === 0 || m === 360 || (m > 0 && m % 1440 === 0);
  let veh = 0, badIdle = 0, badRange = 0;
  for (const f of await files('test/out/ops')) for (const r of JSON.parse(await readFile(f, 'utf8')).vehicles || []) { veh++; if (!isCls(r[7])) badIdle++; if (r[6] != null && r[10] == null && !Number.isInteger(r[6])) badRange++; }
  let snapV = 0; for (const f of await files('test/out/snapshot')) for (const r of JSON.parse(await readFile(f, 'utf8')).vehicles || []) { snapV++; if (r[5] != null && !Number.isInteger(r[5]) && r[5] !== +r[5].toFixed(1)) badRange++; }
  const il = existsSync('test/out/idle-long.json') ? JSON.parse(await readFile('test/out/idle-long.json', 'utf8')).points || [] : [];
  const badLong = il.filter(p => p.hours % 24 !== 0).length;
  let rows = 0, lowRows = 0; for (const f of (await files('test/out/flows')).filter(f => !f.endsWith('index.json'))) { const d = JSON.parse(await readFile(f, 'utf8')); for (const r of d.flows || []) { rows++; if (r[6] < T.FLOW_MIN) lowRows++; } }
  let cellDocs = 0, unsup = 0;
  for (const d of (await readdir('test/out/cells').catch(() => [])).filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n))) for (const f of await files(path.join('test/out/cells', d))) { cellDocs++; if (JSON.parse(await readFile(f, 'utf8')).suppress !== T.SUPPRESS_VERSION) unsup++; }
  assert(veh > 0 && badIdle === 0 && badRange === 0 && badLong === 0, `Veröffentlichung: Standzeit nur als Klasse, Reichweite ganze km (${veh} Fahrzeuge ops, ${snapV} Momentaufnahme, ${il.length} lange Standzeiten)`);
  assert(lowRows === 0 && cellDocs > 0 && unsup === 0, `Veröffentlichung: keine Stromzeile unter ${T.FLOW_MIN} (${rows} Zeilen), alle Zellendateien mit Sekundärunterdrückung (${cellDocs})`);
  const lic = await readFile('test/out/DATA-LICENSE.md', 'utf8');
  const hl = (await readFile(path.join(tmp, 'health.txt'), 'utf8')).split('\n');
  assert(['ok', 'fail'].includes(hl[0]) && /Quellen aktuell\/verzögert/.test(hl[1]), `Ausfall-Wächter: HEALTH_FILE mit Status und Grund (${hl.join(' | ').trim()})`);
  assert(!lic.includes('Einzelne Fahrzeuge oder Fahrten werden nicht veröffentlicht') && lic.includes('## Live-Bestand und Momentaufnahmen') && /nicht als gemeinfrei/.test(lic), 'DATA-LICENSE.md: Live-Bestand benannt, Quellen ohne Lizenz nicht als CC0');
}
ex.close(); srv.kill();
await rm(tmp, { recursive: true, force: true });
