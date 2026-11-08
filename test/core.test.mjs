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
// 07.11.2026: Zeus über MobiData BW (Ludwigsburg leer, Renningen mit anderen Kennungen als Zeus direkt)
{
  const RC = C.rentalCode;
  assert(RC({ web: 'https://zeus.city/api/v1/applinks?vehicle=8148' }) === '8148' && RC({ android: 'https://ridezeus.app.link/sl2ab6', web: 'https://ridezeus.app.link/' }) === 'SL2AB6' && RC({ web: 'https://ridezeus.app.link/' }) === null && RC(null) === null,
    'Fahrzeugnummer aus Ausleih-Links (Abfrageparameter oder letzter Pfadteil), allgemeiner Link ohne Nummer');
  const fb = (bikes) => ({ 'https://m/gbfs.json': { data: { en: { feeds: [{ name: 'free_bike_status', url: 'https://m/fbs.json' }] } }, last_updated: fresh }, 'https://m/fbs.json': { last_updated: fresh, ttl: 60, data: { bikes } } });
  const rd = async (bikes) => C.readGbfsSystem({ id: 'm', url: 'https://m/gbfs.json', operator: 'Zeus' }, async (u) => ({ ok: true, status: 200, json: fb(bikes)[u] }), { now });
  const B = (id, uri) => ({ bike_id: id, lat: 48.77, lon: 8.93, is_disabled: false, is_reserved: false, rental_uris: { android: uri } });
  const s1 = await rd([B('a', 'https://x.app.link/101'), B('b', 'https://x.app.link/102')]), s2 = await rd([B('a', 'https://x.app.link/download'), B('b', 'https://x.app.link/download')]);
  assert(s1.vehicles.map(v => v.code).join() === '101,102' && s2.vehicles.every(v => v.code === undefined), 'Fahrzeugnummer nur, wenn je Quelle eindeutig (gleicher Link für alle = keine Nummer)');
  const Z = (src, id, code, lat, extra = {}) => ({ operator: 'Zeus', rawId: id, sourceId: src, code, lat, lon: 8.93, type: 'scooter', priority: src === 'md' ? 1 : 2, ...extra });
  const dd = C.dedupeVehicles([Z('md', 'ZEU:1', '5430', 48.7700), Z('md', 'ZEU:2', 'SL2AB6', 48.7710), Z('dir', 'f69', '5430', 48.77001, { reportedAt: now }), Z('dir', 'f70', '7777', 48.7800), Z('dir', 'f71', '9999', 48.7700), Z('md', 'ZEU:3', '9999', 48.7900)]);
  assert(dd.vehicles.length === 5 && dd.stats.codeDuplicates === 1 && dd.dropped[0].v.rawId === 'ZEU:1' && dd.dropped[0].of === 'dir' && dd.vehicles.some(v => v.rawId === 'ZEU:3'),
    'Gleiche Fahrzeugnummer aus zwei Quellen ≤ 300 m: eins bleibt (jüngste Meldung), gleiche Nummer 2 km entfernt bleibt doppelt');
  const empty = { 'https://md/gbfs.json': { data: { en: { feeds: [{ name: 'free_bike_status', url: 'https://md/fbs.json' }] } }, last_updated: fresh }, 'https://md/fbs.json': { last_updated: fresh, ttl: 60, data: { bikes: [] } } };
  const both = { ...empty, ...fb([B('a', 'https://x.app.link/101')]) }, fj = async (u) => ({ ok: !!both[u], status: both[u] ? 200 : 404, json: both[u] });
  const via = await C.readGbfsWithFallback({ id: 'zl', url: 'https://md/gbfs.json', altUrls: ['https://m/gbfs.json'], operator: 'Zeus' }, fj, { now });
  const keep = await C.readGbfsWithFallback({ id: 'zl', url: 'https://md/gbfs.json', altUrls: ['https://md/gbfs.json?v=3'], operator: 'Zeus' }, fj, { now });
  assert(via.vehicles.length === 1 && via.viaAlt?.url === 'https://m/gbfs.json' && via.viaAlt.from === 'https://md/gbfs.json' && keep.vehicles.length === 0 && !keep.viaAlt,
    'Leerer Hauptfeed: Ersatzfeed auf anderem Host zählt (viaAlt), gleicher Host nicht');
  // Kombinieren: nur Fahrzeuge, die im Hauptfeed fehlen (Kennung, Nummer, ≤ 10 m), nicht gesperrt, Meldung ≤ 72 h
  const P = (id, lat, extra = {}) => ({ bike_id: id, lat, lon: 9.93, is_disabled: false, is_reserved: false, last_reported: fresh, ...extra });
  const two = { 'https://md2/gbfs.json': { data: { en: { feeds: [{ name: 'free_bike_status', url: 'https://md2/fbs.json' }] } }, last_updated: fresh },
    'https://md2/fbs.json': { last_updated: fresh, ttl: 60, data: { bikes: [P('ZEU:1', 49.790, { rental_uris: { android: 'https://ridezeus.app.link/101' } }), P('ZEU:2', 49.795, { rental_uris: { android: 'https://ridezeus.app.link/SL2AB6' } })] } },
    'https://z/gbfs.json': { data: { en: { feeds: [{ name: 'free_bike_status', url: 'https://z/fbs.json' }] } }, last_updated: fresh },
    'https://z/fbs.json': { last_updated: fresh, ttl: 60, data: { bikes: [P('h101', 49.7901, { rental_uris: { web: 'https://zeus.city/api/v1/applinks?vehicle=101' } }), P('h200', 49.80, { rental_uris: { web: 'https://zeus.city/api/v1/applinks?vehicle=200' } }),
      P('h201', 49.81, { is_disabled: true, rental_uris: { web: 'https://zeus.city/api/v1/applinks?vehicle=201' } }), P('h202', 49.82, { last_reported: old, rental_uris: { web: 'https://zeus.city/api/v1/applinks?vehicle=202' } }),
      P('h203', 49.79503, { rental_uris: { web: 'https://zeus.city/api/v1/applinks?vehicle=203' } })] } } };
  const mg = await C.readGbfsWithFallback({ id: 'zw', url: 'https://md2/gbfs.json', altUrls: ['https://z/gbfs.json'], operator: 'Zeus' }, async (u) => ({ ok: !!two[u], status: two[u] ? 200 : 404, json: two[u] }), { now });
  assert(mg.vehicles.length === 3 && mg.merged?.added === 1 && mg.vehicles.find(v => v.fromAlt)?.rawId === 'h200' && mg.primaryVehicles.length === 2 && mg.altRead?.vehicles.length === 5,
    `Kombinieren: gleiche Nummer, ≤ 10 m, gesperrt und veraltet bleiben draußen, nur das fehlende Fahrzeug kommt dazu (${mg.vehicles.map(v => v.rawId).join()})`);
}
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
// ---------- Methodenprüfung 01.11.2026 ----------
// M-1: Spiegelquelle mit umgeschlüsselten Kennungen (MOBIDROM ↔ nextbike direkt): schwächere Quelle je Gemeinde ganz, sonst räumliche Zwillinge
{
  const N = (src, id, lat, lon, extra = {}) => ({ operator: 'nextbike', rawId: id, sourceId: src, ags: '05315000', type: 'bike', lat, lon, batteryPct: null, rangeKm: null, priority: 2, ...extra });
  const A = [...Array(30)].map((_, i) => N('nextbike_kg', 'k' + i, 50.90 + i * 0.001, 6.95));
  const B = [...Array(30)].map((_, i) => N('mobidrom_x:source-nextbike-kvb-rad', 'm' + i, 50.90 + i * 0.001, 6.95));
  const rank = (id) => [2, id.startsWith('mobidrom_') ? 1 : 0, 0]; // wie collect.mjs: Priorität, Manifest-Kind schwächer, CityBikes schwächer
  const pairs = [{ operator: 'nextbike', ags: '05315000', a: { sourceId: 'mobidrom_x:source-nextbike-kvb-rad', vehicles: 30 }, b: { sourceId: 'nextbike_kg', vehicles: 30 }, idsRekeyed: true, posMatch: 1, countDiff: 0 }];
  const dv = C.dedupeVehicles([...B, ...A]);
  assert(dv.vehicles.length === 60, 'Kennungs-Dubletten greifen bei umgeschlüsselten Kennungen nicht (60)');
  const r = C.dropMirrorVehicles(dv.vehicles, { pairs, rank });
  assert(r.vehicles.length === 30 && r.vehicles.every(v => v.sourceId === 'nextbike_kg') && r.dropped.length === 30 && r.dropped.every(d => d.why === 'whole' && d.of === 'nextbike_kg'), 'M-1: 30 Fahrzeuge an gleichen Positionen → 30, schwächere Quelle (MOBIDROM) fällt ganz');
  assert(r.known.length === 1 && r.known[0].winner === 'nextbike_kg' && r.known[0].loser === 'mobidrom_x:source-nextbike-kvb-rad', 'M-1: bekanntes Spiegelpaar mit Sieger/Verlierer');
  // kleine Nachbargemeinde (kein Paar unter 20 Fahrzeugen): bekanntes Paar → Zwillinge ≤ 10 m, eins zu eins (Station mit 5 bzw. 3 Rädern auf derselben Koordinate)
  const smallA = [...Array(5)].map((_, i) => N('nextbike_kg', 's' + i, 50.80, 6.90, { ags: '05362024' })), smallB = [...Array(3)].map((_, i) => N('mobidrom_x:source-nextbike-kvb-rad', 't' + i, 50.80003, 6.90, { ags: '05362024' }));
  const far = N('mobidrom_x:source-nextbike-kvb-rad', 'u0', 50.81, 6.91, { ags: '05362024' });
  const r2 = C.dropMirrorVehicles([...smallA, ...smallB, far], { pairs, rank });
  assert(r2.vehicles.length === 6 && r2.dropped.length === 3 && r2.dropped.every(d => d.why === 'twin') && r2.vehicles.includes(far), 'M-1: bekanntes Paar in kleiner Gemeinde: 3 Zwillinge eins zu eins verworfen, Einzelfahrzeug ohne Zwilling bleibt');
  // Paar aus dem vorigen Lauf (latest.json → mirrors) wirkt auch ohne aktuelles Paar
  const r3 = C.dropMirrorVehicles([...smallA, ...smallB], { pairs: [], rank, extra: [{ operator: 'nextbike', of: 'nextbike_kg', source: 'mobidrom_x:source-nextbike-kvb-rad' }] });
  assert(r3.vehicles.length === 5, 'M-1: bekanntes Paar aus dem vorigen Lauf');
  // unbekanntes Paar: nur ≤ 5 m mit gleichem Ladestand (unter 99 %) und gleicher Reichweite
  const Z = (src, id, lat, bat, rg, prio) => ({ operator: 'Zeus', rawId: id, sourceId: src, ags: '08226049', type: 'scooter', lat, lon: 8.69, batteryPct: bat, rangeKm: rg, priority: prio });
  const zs = [Z('zeus_leimen', 'a', 49.35, 63, 22.1, 1), Z('zeus_heidelberg', 'x', 49.35002, 63, 22.1, 2), // Zwilling
    Z('zeus_leimen', 'b', 49.36, 100, 35, 1), Z('zeus_heidelberg', 'y', 49.36001, 100, 35, 2), // voll geladen: nicht abgleichen
    Z('zeus_leimen', 'c', 49.37, 50, 17, 1), Z('zeus_heidelberg', 'z', 49.37002, 51, 17.4, 2)]; // anderer Ladestand
  const rz = C.dropMirrorVehicles(zs, { rank: (id) => [id === 'zeus_leimen' ? 1 : 2] });
  assert(rz.vehicles.length === 5 && rz.dropped.length === 1 && rz.dropped[0].v.rawId === 'x' && rz.dropped[0].of === 'zeus_leimen', 'M-1: unbekanntes Paar: nur Zwilling mit gleichem Ladestand/Reichweite ≤ 5 m, schwächere Quelle fällt');
  const cmp = C.compareSources(rank);
  assert(cmp('nextbike_kg', 'mobidrom_x:source-nextbike-kvb-rad') < 0 && cmp('b', 'a') > 0, 'Quellenstärke: direkte Quelle vor Manifest-Kind, sonst Kennung');
}
// M-2: Ladestand-Skala je Quelle – 0..1 nur, wenn die Quelle insgesamt keine Werte über 1 meldet; unplausible Skala → Ladestand null
{
  const n = Math.floor(now / 1000);
  const feed = (bikes) => ({ 'https://b/gbfs.json': { last_updated: n, ttl: 60, version: '2.3', data: { de: { feeds: [{ name: 'free_bike_status', url: 'https://b/fbs.json' }, { name: 'vehicle_types', url: 'https://b/vt.json' }] } } },
    'https://b/vt.json': { last_updated: n, ttl: 60, version: '2.3', data: { vehicle_types: [{ vehicle_type_id: 'sc', form_factor: 'scooter', propulsion_type: 'electric', max_range_meters: 40000 }] } },
    'https://b/fbs.json': { last_updated: n, ttl: 60, version: '2.3', data: { bikes } } });
  const read = (bikes) => C.readGbfsSystem({ id: 'b_t', url: 'https://b/gbfs.json', operator: 'Lime' }, async (u) => ({ ok: true, status: 200, json: feed(bikes)[u] }), { now });
  const B = (i, extra) => ({ bike_id: 'v' + i, lat: 48.7 + i * 0.001, lon: 9.1, is_reserved: false, is_disabled: false, vehicle_type_id: 'sc', last_reported: n, ...extra });
  // 0–100-Feed mit einem Fahrzeug bei 1 %: bleibt 1 % (vorher ×100 = 100 %)
  let s = await read([B(0, { current_fuel_percent: 1 }), B(1, { current_fuel_percent: 80 }), B(2, { current_fuel_percent: 0.5 })]);
  assert(s.vehicles[0].batteryPct === 1 && s.vehicles[1].batteryPct === 80 && s.vehicles[2].batteryPct === 0.5 && !s.batteryScale.fraction, 'M-2: 0–100-Feed: 1 % bleibt 1 %');
  s = await read([B(0, { current_fuel_percent: 0.12 }), B(1, { current_fuel_percent: 1 })]);
  assert(Math.abs(s.vehicles[0].batteryPct - 12) < 1e-9 && s.vehicles[1].batteryPct === 100 && s.batteryScale.fraction, 'M-2: 0..1-Feed (alle ≤ 1) ×100');
  // 100 Fahrzeuge mit Ladestand 0–37 % → Skala unplausibel: Ladestand null, Fingerabdruck bleibt, Befund in der Feed-Prüfung
  s = await read([...Array(100)].map((_, i) => B(i, { current_fuel_percent: Math.round(i * 0.37) })));
  assert(s.batteryScale.suspect && s.batteryScale.n === 100 && s.batteryScale.p99 === 36 && s.vehicles.every(v => v.batteryPct === null) && s.vehicles[10].batteryFp === 4, 'M-2: Ladestand 0–37 % (n = 100) → null, Fingerabdruck batteryFp');
  assert(s.checks.items.some(x => x.msg === C.BATTERY_SCALE_MSG && x.level === 'warning' && x.n === 100), 'M-2: Befund „Ladestand-Skala unplausibel“ in der Feed-Prüfung');
  // abgeleiteter Ladestand (Reichweite ÷ Maximalreichweite): gekennzeichnet; gleichverteilt 0–100 % bleibt
  s = await read([...Array(60)].map((_, i) => B(i, { current_range_meters: Math.round(i / 59 * 40000) })));
  assert(!s.batteryScale.suspect && s.batteryScale.derived === 60 && s.vehicles.every(v => v.batteryDerived && v.batteryPct != null), 'M-2: abgeleiteter Ladestand gekennzeichnet (batteryDerived), plausible Skala bleibt');
  assert(!C.batteryScaleCheck([...Array(49)].map(() => ({ batteryPct: 20 }))).suspect, 'M-2: unter 50 Fahrzeugen keine Skalenprüfung');
  assert(s.batteryFloor && s.batteryFloor.n === 0 && !s.batteryFloor.hides, 'Z4: readGbfsSystem liefert batteryFloor (abgeleiteter Ladestand zählt nicht)');
}
// Z4: Ausblenden bei niedrigem Akku – 0,5-Perzentil ≥ 10 % bei ≥ 500 Fahrzeugen und sauberem Boden (0,1-Perzentil ≥ p005 − 5)
{
  const F = (lo, n = 600, extra = []) => [...extra.map(b => ({ batteryPct: b })), ...[...Array(n - extra.length)].map((_, i) => ({ batteryPct: lo + (i * (100 - lo)) / n }))];
  const dott = C.batteryFloorCheck(F(14));
  assert(dott.hides && dott.p005 === 14 && dott.n === 600, 'Z4: Ladestand ab 14 % (Dott-Muster) = Ausblendung, Untergrenze 14');
  assert(!C.batteryFloorCheck(F(0)).hides && C.batteryFloorCheck(F(0)).p005 === 0, 'Z4: Ladestand ab 0 % (Voi/Bolt-Muster) = keine Ausblendung');
  assert(!C.batteryFloorCheck(F(11)).hides && C.batteryFloorCheck(F(12)).hides, 'Z4: Grenzfall p005 11 (Bolt Stuttgart, Dott Hannover) bleibt Fahrt, ab 12 % Ausblendung');
  const wup = C.batteryFloorCheck(F(14, 1100, [1, 1, 7, 7]));
  assert(wup.p005 >= 10 && !wup.hides, `Z4: einzelne 1–7 % (Voi Wuppertal) = Boden nicht sauber, keine Ausblendung (p005 ${wup.p005}, p001 ${wup.p001})`);
  assert(!C.batteryFloorCheck(F(14, 499)).hides && C.batteryFloorCheck(F(14, 499)).p005 === null, 'Z4: unter 500 Fahrzeugen keine Prüfung');
  assert(C.batteryFloorCheck([...F(14), ...[...Array(50)].map(() => ({ batteryPct: 2, batteryDerived: true }))]).hides, 'Z4: abgeleitete Ladestände zählen nicht');
  assert(!C.batteryFloorCheck([...F(14), ...[...Array(10)].map(() => ({ batteryPct: 2, disabled: true }))]).hides, 'Z4: leere Fahrzeuge als gesperrt gemeldet (Voi/Bolt-Muster) = keine Ausblendung');
}
// M-22: Regression auf dem echten Datenstand (.realdata): Ladestand-Skala je Quelle und umgeschlüsselte Spiegel (Köln nextbike)
{
  const { existsSync, readFileSync, readdirSync } = await import('node:fs');
  const D = new URL('../.realdata/', import.meta.url).pathname;
  if (existsSync(`${D}snapshot`) && existsSync(`${D}consistency.json`)) {
    const flagged = [], ok = [], none = new Set();
    for (const f of readdirSync(`${D}snapshot`)) { const sn = JSON.parse(readFileSync(`${D}snapshot/${f}`, 'utf8')); const bs = C.batteryScaleCheck(sn.vehicles.map(v => ({ batteryPct: v[4] }))); if (bs.n >= 50) (bs.suspect ? flagged : ok).push([sn.id, sn.operator, bs.p99]); else if (sn.vehicles.length >= 50 && bs.n === 0) none.add(sn.id); }
    // Seit dem Sammler mit M-2 steht in der Momentaufnahme kein Ladestand mehr, wo die Skala unplausibel ist (und seit 02.11.2026 auch keiner, der nur
    // aus der Reichweite abgeleitet ist): dann zählt „ohne Ladestand“ als erkannt
    const caught = (re) => flagged.some(x => re.test(x[0])) || [...none].some(id => re.test(id));
    assert(caught(/^lime_dresden$/) && caught(/lime-dortmund/) && ok.every(x => x[2] >= 60) && !flagged.some(x => x[1] === 'Voi' || x[1] === 'Bolt'),
      `M-22 echte Daten: Ladestand-Skala unplausibel bei ${flagged.length} Quellen (${[...new Set(flagged.map(x => x[1]))].join(', ')}), ohne Ladestand ${none.size}, alle übrigen mit p99 ≥ 60 %`);
    const l = JSON.parse(readFileSync(`${D}latest.json`, 'utf8')), cons = JSON.parse(readFileSync(`${D}consistency.json`, 'utf8'));
    const rec = new Map(l.sources.map(s => [s.id, s])), rank = (id) => { const r = rec.get(id) || {}; return [r.priority ?? 2, r.parent ? 1 : 0, (r.directories || []).includes('citybikes') ? 1 : 0]; };
    const { whole } = C.mirrorPairs(cons.pairs, C.compareSources(rank));
    const losers = [...whole].filter(([k]) => k.endsWith('|05315000')).map(([k, w]) => [k.slice(0, -9), w]);
    assert(losers.length >= 3 && losers.every(([src]) => src.startsWith('mobidrom_')) && losers.some(([, w]) => w === 'nextbike_kg'), `M-22 echte Daten: Köln nextbike – MOBIDROM-Kopien (${losers.length}) verlieren gegen die Direktfeeds`);
  } else console.log('ok: M-22 echte Daten übersprungen (.realdata fehlt)');
}
// M-16: Reichweite aus dem Ladestand gerechnet (Voi: Reichweite = Ladestand × 0,8 km) – je Fahrzeugtyp erkannt, andere Feeds bleiben
{
  const mk = (n, f, vtId = 'a', extra = {}) => [...Array(n)].map((_, i) => { const b = 20 + (i * 79) % 81; return { batteryPct: b, rangeKm: f(b, i), vtId, ...extra }; });
  const voi = C.rangeDerivedCheck([...mk(60, b => b * 0.8), ...mk(55, b => b * 1.0, 'b')]);
  assert(voi.derived && voi.derivedTypes.sort().join() === 'a,b' && voi.types.find(t => t.id === 'a').kmPer100 === 80 && voi.types.find(t => t.id === 'b').kmPer100 === 100, 'M-16: Voi-Muster (80 bzw. 100 km je 100 %, zwei Typen) → abgeleitet');
  const dott = C.rangeDerivedCheck(mk(80, (b, i) => b * 0.28 * (0.85 + (i % 7) * 0.05)));
  assert(!dott.derived && dott.types[0].spread > 0.03, 'M-16: Reichweite unabhängig vom Ladestand (Spanne > 3 %) → nicht abgeleitet');
  assert(!C.rangeDerivedCheck(mk(60, b => b * 0.4, 'a', { batteryDerived: true })).derived && !C.rangeDerivedCheck(mk(40, b => b * 0.8)).derived, 'M-16: Ladestand selbst aus der Reichweite abgeleitet (Lime) oder unter 50 Fahrzeugen → keine Erkennung');
  const pooled = C.rangeDerivedCheck([...mk(30, b => b * 0.35, 'x'), ...mk(30, b => b * 0.35, 'y')]);
  assert(pooled.derived && pooled.types.every(t => t.pooled), 'M-16: kleine Typen gemeinsam geprüft');
  // im Feed: Fahrzeuge der Quelle markiert, Befund in der Feed-Prüfung
  const n = Math.floor(now / 1000);
  const F = { 'https://r/gbfs.json': { last_updated: n, ttl: 60, version: '2.3', data: { de: { feeds: [{ name: 'free_bike_status', url: 'https://r/fbs.json' }, { name: 'vehicle_types', url: 'https://r/vt.json' }] } } },
    'https://r/vt.json': { last_updated: n, ttl: 60, version: '2.3', data: { vehicle_types: [{ vehicle_type_id: 'v', form_factor: 'scooter', propulsion_type: 'electric', max_range_meters: 80000 }] } },
    'https://r/fbs.json': { last_updated: n, ttl: 60, version: '2.3', data: { bikes: [...Array(60)].map((_, i) => { const b = 20 + i; return { bike_id: 'v' + i, lat: 48.7 + i * 0.001, lon: 9.1, is_reserved: false, is_disabled: false, vehicle_type_id: 'v', current_fuel_percent: b, current_range_meters: b * 800, last_reported: n }; }) } } };
  const sv = await C.readGbfsSystem({ id: 'voi_t', url: 'https://r/gbfs.json', operator: 'Voi' }, async (u) => ({ ok: true, status: 200, json: F[u] }), { now });
  assert(sv.rangeCheck.derived && sv.vehicles.every(v => v.rangeDerived) && sv.checks.items.some(x => x.msg === C.RANGE_DERIVED_MSG), 'M-16: readGbfsSystem markiert v.rangeDerived und meldet den Befund');
  assert(sv.rangeLimit.limitKm === null && sv.rangeLimit.p95Km >= 25 && sv.vehicles.every(v => v.rangeLimitKm === undefined) && !sv.checks.items.some(x => /^Reichweite klein/.test(x.msg)), 'Reichweiten-Schwelle: Voi-Muster (bis 63 km) → Standard, kein Hinweis');
}
// Reichweiten-Schwelle relativ zur Quelle (Nutzerwunsch 02.11.2026): 95. Perzentil < 25 km → 20 % davon, sonst Standard
{
  const R = (n, f) => [...Array(n)].map((_, i) => ({ rangeKm: f(i) }));
  const lime = C.rangeLimitCheck(R(100, i => i * 0.15)); // 0–14,85 km wie Lime über MobiData BW
  assert(lime.n === 100 && lime.p95Km === 14.1 && lime.limitKm === 2.8, `Lime-Muster (Reichweite ≤ 15 km): p95 ${lime.p95Km} km → Schwelle ${lime.limitKm} km (20 %)`);
  assert(C.rangeLimitCheck(R(100, i => i * 0.4)).limitKm === null && C.rangeLimitCheck(R(100, i => i * 0.4)).p95Km === 37.6, 'p95 ≥ 25 km (Bolt, Dott, Voi) → Standard (null)');
  assert(C.rangeLimitCheck(R(49, i => i * 0.15)).limitKm === null && C.rangeLimitCheck(R(100, () => 0)).limitKm === null && C.rangeLimitCheck([...R(60, i => i * 0.2), { rangeKm: null }, { rangeKm: NaN }]).n === 60,
    'unter 50 Fahrzeugen, p95 = 0 (nextbike ohne Motor) → Standard; fehlende Reichweiten zählen nicht');
  assert(C.RANGE_LIMIT.maxP95Km * C.RANGE_LIMIT.share === C.RANGE_LIMIT.stdKm && C.rangeLimitCheck(R(100, () => 24.9)).limitKm === 5, 'stetiger Übergang: 25 km × 20 % = 5 km (p95 knapp unter 25 km → ≈ 5 km)');
  const n = Math.floor(now / 1000);
  const F = { 'https://l/gbfs.json': { last_updated: n, ttl: 60, version: '2.3', data: { de: { feeds: [{ name: 'free_bike_status', url: 'https://l/fbs.json' }, { name: 'vehicle_types', url: 'https://l/vt.json' }] } } },
    'https://l/vt.json': { last_updated: n, ttl: 60, version: '2.3', data: { vehicle_types: [{ vehicle_type_id: 'l', form_factor: 'scooter', propulsion_type: 'electric' }] } },
    'https://l/fbs.json': { last_updated: n, ttl: 60, version: '2.3', data: { bikes: [...Array(60)].map((_, i) => ({ bike_id: 'l' + i, lat: 48.7 + i * 0.001, lon: 9.1, is_reserved: false, is_disabled: false, vehicle_type_id: 'l', current_range_meters: i * 250, last_reported: n })) } } };
  const sl = await C.readGbfsSystem({ id: 'lime_t', url: 'https://l/gbfs.json', operator: 'Lime' }, async (u) => ({ ok: true, status: 200, json: F[u] }), { now });
  const hint = sl.checks.items.find(x => /^Reichweite klein/.test(x.msg));
  assert(sl.rangeLimit.p95Km === 14 && sl.rangeLimit.limitKm === 2.8 && sl.vehicles.every(v => v.rangeLimitKm === 2.8) && hint?.msg === C.rangeLimitMsg(sl.rangeLimit) && hint.msg.includes('2,8 km') && hint.n === 60,
    `readGbfsSystem: v.rangeLimitKm je Fahrzeug, Hinweis in der Feed-Prüfung („${hint?.msg}“)`);
}
// Konstante Reichweite (Platzhalter): Donkey Bayern 1 km für alle, nextbike-E-Räder 0 km → für Energie und Akkutausch unbekannt
{
  const R = (n, f) => [...Array(n)].map((_, i) => ({ rangeKm: f(i) }));
  const donkey = C.rangeFlatCheck(R(197, () => 1)), nb = C.rangeFlatCheck(R(128, i => (i < 126 ? 0 : 44)));
  assert(donkey.flat && donkey.modeKm === 1 && donkey.modeShare === 1 && nb.flat && nb.modeKm === 0 && nb.modeShare > 0.95, `konstant: Donkey (197 × 1 km) und nextbike (126 von 128 × 0 km, ${Math.round(nb.modeShare * 100)} %) → flat`);
  assert(!C.rangeFlatCheck(R(100, i => i * 0.15)).flat && !C.rangeFlatCheck(R(100, i => (i < 90 ? 0 : 40))).flat && C.rangeFlatCheck(R(100, i => 12 + (i % 2) * 0.05)).flat && !C.rangeFlatCheck(R(49, () => 1)).flat,
    'nicht konstant: Lime-Muster, 90 % gleiche Werte mit großer Spanne; konstant: Spanne p5–p95 unter 0,1 km; unter 50 Fahrzeugen keine Prüfung');
  const vs = R(60, () => 1).map(v => ({ ...v, batteryPct: null }));
  const ac = C.applyRangeChecks(vs);
  assert(ac.rangeFlat.flat && vs.every(v => v.rangeFlat === true && v.rangeKm === 1 && v.rangeLimitKm === undefined && !v.rangeDerived) && ac.rangeLimit.limitKm === null && ac.rangeCheck.n === 0,
    'applyRangeChecks: konstante Quelle → v.rangeFlat (Rohwert bleibt), keine Schwelle und keine Ableitung aus dem Platzhalter');
  const n = Math.floor(now / 1000);
  const F = { 'https://d/gbfs.json': { last_updated: n, ttl: 60, version: '2.3', data: { de: { feeds: [{ name: 'free_bike_status', url: 'https://d/fbs.json' }, { name: 'vehicle_types', url: 'https://d/vt.json' }] } } },
    'https://d/vt.json': { last_updated: n, ttl: 60, version: '2.3', data: { vehicle_types: [{ vehicle_type_id: 'e', form_factor: 'bicycle', propulsion_type: 'electric_assist' }] } },
    'https://d/fbs.json': { last_updated: n, ttl: 60, version: '2.3', data: { bikes: [...Array(60)].map((_, i) => ({ bike_id: 'd' + i, lat: 49.0 + i * 0.001, lon: 12.1, is_reserved: false, is_disabled: false, vehicle_type_id: 'e', current_fuel_percent: i % 15, current_range_meters: 1000, last_reported: n })) } } };
  const sd = await C.readGbfsSystem({ id: 'donkey_t', url: 'https://d/gbfs.json', operator: 'Donkey' }, async (u) => ({ ok: true, status: 200, json: F[u] }), { now });
  assert(sd.rangeFlat.flat && sd.batteryScale.suspect && sd.vehicles.every(v => v.rangeFlat && v.rangeKm === 1 && v.batteryPct === null) && sd.checks.items.some(x => x.msg === C.RANGE_FLAT_MSG) && sd.rangeLimit.limitKm === null,
    'readGbfsSystem (Donkey-Muster: Ladestand 0–14 %, Reichweite 1 km): Ladestand verworfen, Reichweite konstant markiert, Befund in der Feed-Prüfung');
}

// ---------- Fahrzeugarten E-Roller und Carsharing (08.11.2026) ----------
{
  assert(C.VEHICLE_TYPES.slice(0, 6).join() === 'scooter,ebike,bike,cargo,other,unknown' && C.VEHICLE_TYPES.slice(6).join() === 'moped,car', 'neue Arten hinten angefügt (Index in ops/<Land>.json bleibt)');
  const K = C.classifyVehicleType;
  assert(K({ form_factor: 'car', propulsion_type: 'combustion' }) === 'car' && K({ form_factor: 'moped', propulsion_type: 'electric' }) === 'moped' && K({ form_factor: 'other' }) === 'other'
    && K({ form_factor: 'scooter_standing' }) === 'scooter' && K({ form_factor: 'bicycle', propulsion_type: 'electric_assist' }) === 'ebike', 'form_factor car → car, moped → moped, übrige unverändert');
  assert(K(null, 'stadtmobil Stadtmobil Stuttgart') === 'car' && K(null, 'Carsharing Radolfzell') === 'car' && K(null, 'teilAuto TeilAuto Biberach') === 'car' && K(null, 'stella Stella') === 'moped'
    && K(null, 'Dott Dott Stuttgart') === 'scooter' && K(null, 'nextbike nextbike Leipzig') === 'bike', 'ohne form_factor: Carsharing-/E-Roller-Namen vor den Rad-/Scooter-Wörtern');
  assert(C.familyOf('car') === 'car' && C.familyOf('moped') === 'moped' && ['scooter', 'ebike', 'bike', 'cargo', 'other', 'unknown'].every(t => C.familyOf(t) === 'micro') && C.FAMILIES.join() === 'micro,moped,car', 'Familien: micro, moped, car');
  const st = C.emptyStats();
  for (const v of [{ type: 'car', rangeKm: 30 }, { type: 'car', rangeKm: 80 }, { type: 'moped', rangeKm: 8 }, { type: 'scooter', rangeKm: 8 }, { type: 'scooter', rangeKm: 4 }]) C.addVehicle(st, v);
  assert(st.rangeKnown === 5 && st.lowRange === 3 && C.rangeLowKm('car') === 50 && C.rangeLowKm('moped') === 10 && C.rangeLowKm('scooter') === 5, 'Reichweite niedrig je Art: Auto < 50 km, E-Roller < 10 km, sonst < 5 km');
  // GBFS-System mit Carsharing an Stationen (roundtrip_station) und E-Rollern frei
  const feeds = {
    'https://cs.test/gbfs.json': { last_updated: 1793280000, ttl: 60, version: '2.3', data: { de: { feeds: ['system_information', 'vehicle_types', 'station_information', 'station_status', 'free_bike_status'].map(n => ({ name: n, url: `https://cs.test/${n}` })) } } },
    'https://cs.test/system_information': { last_updated: 1793280000, ttl: 60, version: '2.3', data: { system_id: 'cs', name: 'Test-Carsharing', operator: 'Test', timezone: 'Europe/Berlin', language: 'de' } },
    'https://cs.test/vehicle_types': { last_updated: 1793280000, ttl: 60, version: '2.3', data: { vehicle_types: [{ vehicle_type_id: 'kw', form_factor: 'car', propulsion_type: 'combustion', max_range_meters: 600000, name: 'Kleinwagen', return_constraint: 'roundtrip_station' }, { vehicle_type_id: 'er', form_factor: 'moped', propulsion_type: 'electric', max_range_meters: 100000, name: 'E-Roller' }] } },
    'https://cs.test/station_information': { last_updated: 1793280000, ttl: 60, version: '2.3', data: { stations: [{ station_id: 'S1', name: 'Marktplatz', lat: 48.78, lon: 9.18, capacity: 3 }] } },
    'https://cs.test/station_status': { last_updated: 1793280000, ttl: 60, version: '2.3', data: { stations: [{ station_id: 'S1', num_bikes_available: 2, num_docks_available: 1, is_installed: true, is_renting: true, is_returning: true, last_reported: 1793280000, vehicle_types_available: [{ vehicle_type_id: 'kw', count: 2 }] }] } },
    'https://cs.test/free_bike_status': { last_updated: 1793280000, ttl: 60, version: '2.3', data: { bikes: [{ bike_id: 'c1', station_id: 'S1', is_reserved: false, is_disabled: false, vehicle_type_id: 'kw', current_fuel_percent: 0.4, current_range_meters: 240000, last_reported: 1793280000 }, { bike_id: 'c2', station_id: 'S1', is_reserved: false, is_disabled: false, vehicle_type_id: 'kw', current_fuel_percent: 0.9, current_range_meters: 540000, last_reported: 1793280000 }, { bike_id: 'm1', lat: 48.781, lon: 9.181, is_reserved: false, is_disabled: false, vehicle_type_id: 'er', current_fuel_percent: 0.55, current_range_meters: 55000, last_reported: 1793280000 }] } },
  };
  const fj = async (u) => (feeds[u] ? { ok: true, status: 200, json: feeds[u], headers: {} } : { ok: false, status: 404 });
  const sys = await C.readGbfsSystem({ id: 'cs', operator: 'Test', url: 'https://cs.test/gbfs.json', api: 'gbfs' }, fj, { now: 1793280000e3 + 60e3 });
  const types = sys.vehicles.map(v => v.type).join(), c1 = sys.vehicles.find(v => v.rawId === 'c1');
  assert(types === 'car,car,moped' && c1.geoOrigin === 'station' && c1.lat === 48.78 && Math.round(c1.batteryPct) === 40 && c1.rangeKm === 240 && sys.stations[0].perType.car === 2, 'readGbfsSystem: Autos an der Station (Position der Station), E-Roller frei, Ladestand 0..1 → %');
}
