import * as C from '../lib/pulse-core.js';
const assert = (c, m) => { if (!c) { console.error('FEHLER:', m); process.exitCode = 1; } else console.log('ok:', m); };
// Dott-Station ohne zugeordnete Fahrzeuge, aber Scooter frei daneben → nicht leer
const V = (lat, lon, extra = {}) => ({ operator: 'Dott', type: 'scooter', ags: '11000000', lat, lon, disabled: false, reserved: false, ...extra });
const S = (id, lat, lon, extra = {}) => ({ id, operator: 'Dott', ags: '11000000', lat, lon, installed: true, renting: true, returning: true, bookable: 0, physicalAvailable: 0, docksAvailable: null, hasVehicleList: true, typeHint: 'scooter', ...extra });
const vehicles = [V(52.52, 13.40), V(52.52025, 13.40), V(52.53, 13.41, { disabled: true }), V(52.52, 13.40, { operator: 'Bolt' })];
const stations = [S('a', 52.5201, 13.4001), S('b', 52.53, 13.41), S('c', 52.54, 13.42, { bookable: 3, physicalAvailable: 3 })];
const g = C.aggregateGroups(vehicles, stations).get('11000000|Dott|scooter');
assert(stations[0].nearbyVehicles === 2 && stations[1].nearbyVehicles === 0, 'Fahrzeuge im Umkreis 50 m: nur verfügbare desselben Anbieters');
assert(g.stationsEmptyReported === 2 && g.stationsEmpty === 1 && g.stationsEmptyNearby === 1, 'als leer gemeldet 2, davon 1 mit Fahrzeugen daneben → faktisch leer 1');
// fremde Anbieter im Umkreis (Marktsicht)
const st2 = [S('x', 52.52, 13.40)];
C.aggregateGroups([V(52.52, 13.40, { operator: 'Bolt' })], st2);
assert(st2[0].nearbyVehicles === 0 && st2[0].nearbyOther === 1 && st2[0].nearbyOtherOps[0] === 'Bolt', 'fremde Fahrzeuge im Umkreis getrennt gezählt');
// verwaiste Einträge: gesperrt und > 7 Tage ohne Signal
const now = Date.parse('2026-11-01T08:00:00Z'), old = Math.round((now - 40 * 86400e3) / 1000), fresh = Math.round((now - 60e3) / 1000);
const feeds = { 'https://x/gbfs.json': { data: { en: { feeds: [{ name: 'free_bike_status', url: 'https://x/fbs.json' }] } }, last_updated: fresh },
  'https://x/fbs.json': { last_updated: fresh, ttl: 60, data: { bikes: [
    { bike_id: 'a', lat: 49.0, lon: 12.1, is_disabled: true, is_reserved: false, last_reported: old },
    { bike_id: 'b', lat: 49.0, lon: 12.1, is_disabled: true, is_reserved: false, last_reported: fresh },
    { bike_id: 'c', lat: 49.0, lon: 12.1, is_disabled: false, is_reserved: false, last_reported: old } ] } } };
const sys = await C.readGbfsSystem({ id: 'zeus_t', url: 'https://x/gbfs.json', operator: 'Zeus' }, async (u) => ({ ok: true, status: 200, json: feeds[u] }), { now });
assert(sys.ghosts === 1 && sys.vehicles.length === 2 && sys.vehicles.some(v => v.rawId === 'c'), 'gesperrt + 40 Tage stumm = verwaist; frei + alt bleibt (Bikes ohne Statusmeldung)');
// M9: virtuelle Stationen getrennt zählen (leere Abstellzone ≠ leere Dockstation)
{
  const st3 = [S('v1', 52.60, 13.50, { isVirtual: true }), S('v2', 52.61, 13.51, { isVirtual: true, bookable: 2, physicalAvailable: 2 }), S('d1', 52.62, 13.52, { isVirtual: false }), S('d2', 52.63, 13.53)];
  const g3 = C.aggregateGroups([], st3).get('11000000|Dott|scooter');
  assert(g3.stationsVirtual === 2 && g3.stationsEmpty === 3 && g3.stationsEmptyVirtual === 1 && g3.stationsEmptyDock === 2, 'virtuell 2, leer 3 = 1 virtuell + 2 Dock');
  assert(Object.keys(C.emptyStats()).includes('stationsEmptyDock') && C.sumStats([g3, g3]).stationsEmptyDock === 4, 'neue Felder in emptyStats/sumStats');
}
// M9: Gemeinde-Schwerpunkt aus den Grenzen
{
  const sq = { type: 'Polygon', coordinates: [[[9.0, 48.0], [9.2, 48.0], [9.2, 48.4], [9.0, 48.4], [9.0, 48.0]]] };
  assert(JSON.stringify(C.geomCentroid(sq)) === '[48.2,9.1]', 'Schwerpunkt Rechteck');
  const mp = { type: 'MultiPolygon', coordinates: [sq.coordinates, [[[10.0, 50.0], [10.02, 50.0], [10.02, 50.02], [10.0, 50.02], [10.0, 50.0]]]] };
  const c = C.geomCentroid(mp); assert(c[0] > 48.2 && c[0] < 48.22 && c[1] > 9.1 && c[1] < 9.12, 'MultiPolygon: flächengewichtet (kleine Exklave zieht kaum)');
  assert(C.geomCentroid(null) === null && JSON.stringify(C.geomCentroid({ type: 'Polygon', coordinates: [[[9, 48], [9, 48], [9, 48]]] })) === '[48,9]', 'Rückfall ohne Fläche: Bounding-Box-Mitte');
}
// M18c: dedupeStations – gleiche Kennung, gleicher Name ≤ 60 m, Übernahme ändert Name (Umhängen), Ergebnis in Eingabereihenfolge
{
  const N = (id, name, lat, lon, extra = {}) => ({ operator: 'nextbike', id, name, lat, lon, priority: 2, reportedAt: 100, ...extra });
  const inp = [
    N('1', 'Hauptbahnhof', 48.5, 9.0), N('2', 'Hauptbahnhof', 48.5003, 9.0), // gleicher Name, 33 m → Dublette von 1
    N('1', 'Hbf Nord', 48.5, 9.0, { priority: 1 }), // gleiche Kennung, bessere Priorität → übernimmt, Name wird „Hbf Nord“
    N('3', 'Hbf Nord', 48.5002, 9.0), // trifft nun 1 über den neuen Namen → Dublette
    N('4', 'Hauptbahnhof', 48.5001, 9.0), // alter Name von 1 gilt nicht mehr → eigene Station
    N('5', 'Rathaus', 48.6, 9.1), N('5', 'Rathaus', 48.6, 9.1, { reportedAt: 200 }), // gleiche Kennung, jünger → übernimmt
    N('6', 'Rathaus', 48.6, 9.1, { operator: 'Bolt' }), // anderer Anbieter → eigene Station
    N('7', '', 48.7, 9.2), N('8', '', 48.7, 9.2), // ohne Name: nur Kennung zählt
    N('9', 'Markt', null, null), N('10', 'Markt', 48.8, 9.3), // ohne Koordinaten: kein Namensabgleich
  ];
  const r = C.dedupeStations(inp.map(s => ({ ...s })));
  assert(r.duplicates === 4 && r.stations.map(s => s.id).join(',') === '1,4,5,6,7,8,9,10', 'Dubletten 4, Reihenfolge und Übernahme (1 ← Hbf Nord, 3 hängt an neuem Namen)');
  assert(r.stations[0].name === 'Hbf Nord' && r.stations[0].priority === 1 && r.stations[2].reportedAt === 200, 'Übernahme: bessere Priorität bzw. jüngerer Stand');
}
// M9: GBFS-Stationen ohne is_virtual_station: ohne num_docks_available = virtuell (Voi/Bolt-Abstellzonen), mit Docks = Dockstation
{
  const n = Math.floor(now / 1000);
  const F = { 'https://v/gbfs.json': { last_updated: n, ttl: 60, version: '2.3', data: { de: { feeds: ['system_information', 'station_information', 'station_status', 'free_bike_status', 'vehicle_types'].map(f => ({ name: f, url: `https://v/${f}.json` })) } } },
    'https://v/system_information.json': { last_updated: n, ttl: 60, version: '2.3', data: { system_id: 'voi_t', name: 'Voi', timezone: 'Europe/Berlin', attribution_organization_name: 'Voi Technology', attribution_url: 'https://voi.com', license_id: 'CC0-1.0' } },
    'https://v/vehicle_types.json': { last_updated: n, ttl: 60, version: '2.3', data: { vehicle_types: [{ vehicle_type_id: 'sc', form_factor: 'scooter', propulsion_type: 'electric', max_range_meters: 50000 }] } },
    'https://v/station_information.json': { last_updated: n, ttl: 60, version: '2.3', data: { stations: [{ station_id: 'z1', name: 'Zone Markt', lat: 48.78, lon: 9.18 }, { station_id: 'd1', name: 'Dock Hbf', lat: 48.785, lon: 9.18, capacity: 10 }, { station_id: 'z2', name: 'Zone Nord', lat: 48.79, lon: 9.18, is_virtual_station: true }] } },
    'https://v/station_status.json': { last_updated: n, ttl: 60, version: '2.3', data: { stations: [
      { station_id: 'z1', num_bikes_available: 0, is_installed: true, is_renting: true, is_returning: true, last_reported: n },
      { station_id: 'd1', num_bikes_available: 0, num_docks_available: 10, is_installed: true, is_renting: true, is_returning: true, last_reported: n },
      { station_id: 'z2', num_bikes_available: 0, is_installed: true, is_renting: true, is_returning: true, last_reported: n }] } },
    'https://v/free_bike_status.json': { last_updated: n - 900, ttl: 60, data: { bikes: [{ bike_id: 'b1', lat: 48.7, lon: 9.1, is_reserved: false, is_disabled: false, vehicle_type_id: 'sc', current_fuel_percent: 0.5 },
      { bike_id: 'b2', lat: 9.1, lon: 48.7, is_reserved: false, is_disabled: false, vehicle_type_id: 'xx' }, { bike_id: 'b3', is_reserved: false } ] } } };
  const sv = await C.readGbfsSystem({ id: 'voi_t', url: 'https://v/gbfs.json', operator: 'Voi' }, async (u) => ({ ok: true, status: 200, json: F[u] }), { now });
  const by = Object.fromEntries(sv.stations.map(s => [s.id, s.isVirtual]));
  assert(by.z1 === true && by.d1 === false && by.z2 === true, 'virtuell: ohne num_docks_available (Heuristik) bzw. laut Feed; Dock mit num_docks_available');
  const g4 = C.aggregateGroups([], sv.stations.map(s => ({ ...s, operator: 'Voi', ags: '08111000', hasVehicleList: true }))).get('08111000|Voi|scooter');
  assert(g4.stationsEmpty === 3 && g4.stationsEmptyVirtual === 2 && g4.stationsEmptyDock === 1, 'leere Abstellzonen getrennt: 2 virtuell, 1 Dock');
  assert(sv.systemInfo.attribution === 'Voi Technology' && sv.systemInfo.attributionUrl === 'https://voi.com', 'Namensnennung aus system_information');
  // M17b: Basisprüfung
  const ck = sv.checks; const msgs = ck.items.map(i => `${i.level}:${i.feed}:${i.msg}`).join(' | ');
  assert(ck.label.includes('kein MobilityData') && ck.errors >= 3 && ck.items.length <= 5 && ck.items[0].level === 'error', 'Prüfung benannt, höchstens 5 Punkte, Fehler zuerst');
  assert(/vertauscht/.test(msgs) && /ohne Position/.test(msgs) && /Stand 15 Min/.test(msgs), 'Prüfung: vertauschte Koordinaten, Fahrzeug ohne Position, veralteter Status-Feed');
  const all = C.checkGbfs({ disc: F['https://v/gbfs.json'], listed: ['system_information', 'station_status'], now, docs: { system_information: { last_updated: n, data: { name: 'x' } }, station_status: null } });
  const am = all.items.map(i => i.msg).join(' | ');
  assert(/ttl fehlt/.test(am) && /nicht abrufbar/.test(am) && /nur gemeinsam/.test(am) && /system_id, timezone/.test(am), 'Prüfung: ttl, Abruf, Dateipaare, Pflichtfelder system_information');
}
// Qualität: Frische nur aus Status-Dateien; Stationszähler ohne Fahrzeugpositionen schlechter
{
  const base = { feedAges: { system_information: 5 * 86400e3, station_status: 60e3, free_bike_status: 60e3 }, stations: [], vehicles: [{ batteryPct: 50, reportedAt: 1, type: 'scooter' }] };
  assert(C.qualityScore(base, now).score === 100, 'alte system_information drückt die Frische nicht (vorher 30)');
  const cb = { feedAges: { station_status: 60e3 }, vehicles: [], stations: [{ renting: true, reportedAt: 1, perType: { bike: 1 } }] };
  const gb = { feedAges: { station_status: 60e3, free_bike_status: 60e3 }, stations: [], vehicles: [{ type: 'bike', reportedAt: 1 }] };
  assert(C.qualityScore(cb, now).score < C.qualityScore(gb, now).score, 'Stationszähler < Feed mit Fahrzeugpositionen; Energie zählt bei Rädern ohne Motor nicht');
}
// Lizenzen vereinheitlichen
{
  const L = (a, b) => JSON.stringify(C.normalizeLicense(a, b));
  assert(L('cc-by-sa-40') === JSON.stringify({ id: 'CC-BY-SA-4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' }) && C.normalizeLicense('cc0-10').id === 'CC0-1.0' && C.normalizeLicense('cc-by-40').id === 'CC-BY-4.0', 'CKAN-Kennungen (MOBIDROM) → SPDX');
  assert(C.normalizeLicense('dl-de-by-20-1').id === 'dl-de/by-2-0' && C.normalizeLicense('https://creativecommons.org/licenses/by/4.0/').id === 'CC-BY-4.0' && C.normalizeLicense('https://www.li.me/gbfs-terms').id === null && C.normalizeLicense('https://www.li.me/gbfs-terms').url === 'https://www.li.me/gbfs-terms' && C.normalizeLicense(null).id === null, 'Datenlizenz DE, URL, Betreiberbedingungen, ohne Angabe');
}
// M3: Quellen-Kopien über Stationskoordinaten (CityBikes „DB Connect“ = RegioRad Stuttgart), Mobilitätsstationen anderer Anbieter bleiben
{
  const pts = [...Array(20)].map((_, i) => [48.70 + i * 0.003, 9.10 + (i % 4) * 0.004]);
  const st = [
    ...pts.map(([la, lo], i) => ({ sourceId: 'regiorad', lat: la, lon: lo, name: `Station ${i}` })),
    ...pts.map(([la, lo], i) => ({ sourceId: 'cb_stuttgart', lat: la + 0.0001, lon: lo, name: `Station ${i}` })), // 11 m daneben, gleiche Namen
    ...pts.slice(0, 18).map(([la, lo], i) => ({ sourceId: 'cb_hub', lat: la, lon: lo + 0.0001, name: `Jelbi ${i}` })), // gleiche Orte, andere Namen
    ...pts.map(([la, lo], i) => ({ sourceId: 'cb_copy2', lat: la, lon: lo - 0.0001, name: `Station ${i}` })), // zweite Kopie
  ];
  const srcs = [{ id: 'regiorad', priority: 1, directories: ['mobidata_bw'], countOnly: false }, { id: 'cb_stuttgart', priority: 3, directories: ['citybikes'], countOnly: true },
    { id: 'cb_hub', priority: 3, directories: ['citybikes'], countOnly: true }, { id: 'cb_copy2', priority: 3, directories: ['citybikes'], countOnly: true }];
  const cp = C.findSourceCopies(st, srcs);
  assert(cp.get('cb_stuttgart')?.of === 'regiorad' && cp.get('cb_copy2') && cp.get('cb_stuttgart').share === 1, 'CityBikes-Kopien unter anderem Namen erkannt');
  assert(!cp.has('cb_hub') && !cp.has('regiorad'), 'andere Anbieter am selben Ort (andere Namen) und Original bleiben');
  // zwei Kopien ohne Original: die schwächere fällt, eine bleibt
  const cp2 = C.findSourceCopies(st.filter(s => s.sourceId !== 'regiorad'), srcs);
  assert(cp2.size === 1, 'zwei Kopien ohne Original: genau eine wird als Kopie erkannt');
}
// M6: Abruf mit Timeout bis zum Ende des Lesens und Größenlimit
{
  const http = await import('node:http');
  const srv = http.createServer((req, res) => {
    if (req.url === '/slow') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"a":'); setTimeout(() => { try { res.end('1}'); } catch {} }, 3000); return; }
    if (req.url === '/big') { res.writeHead(200); res.end('x'.repeat(5000)); return; }
    res.writeHead(200); res.end('{"ok":true}');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${srv.address().port}`;
  const t0 = Date.now(); let err = null; try { await C.fetchLimited(`${base}/slow`, { timeout: 400 }); } catch (e) { err = e.message; }
  assert(err === 'Timeout' && Date.now() - t0 < 2000, 'Timeout greift auch während des Lesens');
  err = null; try { await C.fetchLimited(`${base}/big`, { max: 1000 }); } catch (e) { err = e.message; }
  assert(err === 'Antwort zu groß', 'Größenlimit');
  assert(JSON.parse(await C.fetchLimited(`${base}/ok`)).ok === true, 'normale Antwort');
  srv.closeAllConnections?.(); srv.close();
}
// Fläche je Gemeinde (km²), Minuten je Ortsstunde, Fehlerursachen
{
  const sq = { type: 'Polygon', coordinates: [[[9, 48], [9.1, 48], [9.1, 48.1], [9, 48.1], [9, 48]]] };
  const holed = { type: 'Polygon', coordinates: [sq.coordinates[0], [[9.02, 48.02], [9.04, 48.02], [9.04, 48.04], [9.02, 48.04], [9.02, 48.02]]] };
  assert(Math.abs(C.geomAreaKm2(sq) - 82.8) < 0.5 && C.geomAreaKm2(holed) < C.geomAreaKm2(sq) - 3 && C.geomAreaKm2(null) === null, 'Fläche 0,1° × 0,1° bei 48° ≈ 82,8 km², Loch abgezogen');
  assert(C.hourMinutes('2026-10-25')[2] === 120 && C.hourMinutes('2026-03-29')[2] === 0 && C.hourMinutes('2026-11-01').every(x => x === 60), 'Minuten je Ortsstunde: Zeitumstellung Okt./März, normaler Tag');
  const E = (e, s) => C.errorCause(e, s);
  assert(E(['discovery: HTTP 0 Timeout']) === 'timeout' && E(['citybikes: HTTP 429']) === 'http429' && E(['discovery: HTTP 404']) === 'http404' && E(['discovery: HTTP 0 CERT_HAS_EXPIRED']) === 'tls' && E(['discovery: HTTP 0 ENOTFOUND']) === 'dns' && E(['discovery: HTTP 200 kein JSON'], 200) === 'noJson' && E(['discovery: HTTP 200 Antwort zu groß']) === 'tooLarge' && E(['x']) === 'other', 'Fehlerursachen');
}
