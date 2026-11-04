// Tests für lib/pulse-spots.js: Spots mit Leerquote, Übersicht je Anbieter, Bündelung „Fehlt bei mir“, „Nur bei mir“, Dubletten,
// dauerhaft leer, Zonen (nur Durchfahrt verboten ist ein Befund), Backend-CSV mit Formel-Schutz, GeoJSON
import * as S from '../lib/pulse-spots.js';
import { cellOf } from '../lib/pulse-ops.js';
const assert = (c, m) => { if (!c) { console.error('FEHLER:', m); process.exitCode = 1; } else console.log('ok:', m); };

const A = '08111000';
// Abstand: 0,0001° Breite ≈ 11 m
const st = (operator, name, lat, lon, o = {}) => ({ lat, lon, operator, name, bookable: 0, docks: null, capacity: null, ags: A, renting: true, returning: true, physical: 0, ...o });
const vh = (operator, lat, lon, o = {}) => ({ lat, lon, operator, ags: A, type: 'scooter', reserved: false, disabled: false, battery: 60, rangeKm: 20, idleMin: 30, ...o });
const fleet = {
  at: Date.UTC(2026, 10, 1, 12),
  stations: [
    st('Voi', 'Marktplatz', 48.7800, 9.1800),                 // V1
    st('Voi', 'Marktplatz 2', 48.7801, 9.1800),               // V2: 11 m neben V1 → Dublette
    st('Voi', 'Schlossplatz', 48.7850, 9.1800),               // V3: nur bei Voi, in Zone ohne freies Abstellen (kein Befund)
    st('Voi', 'Leer', 48.7700, 9.1700),                       // V4: dauerhaft leer
    st('Voi', '48.76000,9.16000', 48.7600, 9.1600),           // V5: Name nur Koordinaten, in Zone „Durchfahrt verboten“
    st('Bolt', 'Marktplatz B', 48.7804, 9.1800),              // B1: 33 m von V2, 44 m von V1
    st('Bolt', 'Bahnhof', 48.7900, 9.2000),                   // B2
    st('Bolt', 'Uni', 48.7600, 9.1000),                       // B3
    st('Dott', '\tBahnhof (Hub)', 48.7901, 9.2001),           // D1: 13 m von B2 → selber Ort
    st('Dott', '=cmd|" /c calc"!A0, x', 48.7950, 9.2100),     // D2: Formel im Namen
    st('RegioRad', 'Uni Station', 48.7600, 9.1001, { docks: 10, capacity: 20 }), // R1: physisch (Docks), 7 m von B3
    { ...st('Voi', 'Anderswo', 48.7000, 9.0000), ags: '08115003' },
  ],
  vehicles: [
    vh('Voi', 48.78002, 9.18), vh('Voi', 48.76002, 9.10002), vh('Voi', 48.76003, 9.09998), vh('Voi', 48.75998, 9.10001, { disabled: true }),
    vh('Bolt', 48.7900, 9.20002), vh('Bolt', 48.7500, 9.1500), vh('Lime', 48.7700, 9.1700), vh('Lime', 48.7800, 9.1802),
  ],
};
const quota = { at: 1, days: 7, fields: ['ags', 'operator', 'name', 'lat', 'lon', 'runs', 'emptyRuns', 'fullRuns', 'virtual'], stations: [
  [A, 'Voi', 'Marktplatz', 48.78, 9.18, 50, 5, 0, 1], [A, 'Voi', 'Marktplatz 2', 48.7801, 9.18, 50, 40, 0, 1], [A, 'Voi', 'Schlossplatz', 48.785, 9.18, 20, 20, 0, 1],
  [A, 'Voi', 'Leer (alt)', 48.77002, 9.17, 50, 48, 0, 1],      // anderer Name, 2 m daneben → zugeordnet
  [A, 'Bolt', 'Leer', 48.77, 9.17, 50, 0, 0, 1],               // anderer Anbieter am selben Ort → nicht zugeordnet
  [A, 'Bolt', 'Bahnhof', 48.79, 9.2, 50, 50, 0, 1], [A, 'Dott', '\tBahnhof (Hub)', 48.7901, 9.2001, 50, 46, 0, 1],
  [A, 'RegioRad', 'Uni Station', 48.76, 9.1001, 50, 0, 0, 0], ['08115003', 'Voi', 'Anderswo', 48.7, 9.0, 50, 50, 0, 1],
] };
// Nachfrage: Zellen mit Fahrtbeginnen je Stunde (95. Perzentil der vier Zellen = 1,0)
const cell = (lat, lon, sph) => [cellOf(lat, lon), { cell: cellOf(lat, lon), startsPerHour: sph, endsPerHour: sph / 2, starts: sph * 10, ends: sph * 5 }];
const demand = { hours: 10, days: 1, cells: new Map([cell(48.79005, 9.20005, 2.0), cell(48.76, 9.10005, 0.2), cell(48.7, 9.3, 0.5), cell(48.71, 9.31, 1.0)]) };
const zones = [
  { operator: 'Voi', features: [
    { properties: { name: 'Fußgängerzone', rules: [{ rideAllowed: false, rideThrough: false }] }, geometry: { type: 'Polygon', coordinates: [[[9.159, 48.759], [9.161, 48.759], [9.161, 48.761], [9.159, 48.761], [9.159, 48.759]]] } },
    { properties: { name: 'Innenstadt', rules: [{ rideAllowed: false, rideThrough: true }] }, geometry: { type: 'Polygon', coordinates: [[[9.179, 48.784], [9.181, 48.784], [9.181, 48.786], [9.179, 48.786], [9.179, 48.784]]] } },
  ] },
  { operator: 'Bolt', features: [{ properties: { rules: [{ rideThrough: false }] }, geometry: { type: 'Polygon', coordinates: [[[9.169, 48.769], [9.171, 48.769], [9.171, 48.771], [9.169, 48.771], [9.169, 48.769]]] } }] },
];

// ---------- Spots, Namen, Leerquote ----------
assert(S.cleanName('\tDigitale  Abstellfläche ') === 'Digitale Abstellfläche' && S.cleanName('48.80068,9.21745') === '' && S.cleanName(null) === '', 'Namen: Tab und Mehrfach-Leerzeichen weg, reine Koordinaten = ohne Namen');
const sp = S.spotsOf(fleet, { ags: A, quota });
const byName = (list, n) => list.find(s => s.name === n);
assert(sp.length === 10 && !sp.some(s => s.operator === 'RegioRad') && S.spotsOf(fleet, { ags: A, quota, kind: 'all' }).length === 11, 'virtuell: ohne Dock-Station (RegioRad), alle Stationen: 11; nur die Gemeinde');
const leer = byName(sp, 'Leer');
assert(leer.runs === 50 && Math.abs(leer.emptyShare - 0.96) < 1e-9, 'Leerquote: Voi-Station „Leer“ bekommt die Voi-Zeile 2 m daneben (anderer Name), nicht die Bolt-Zeile am selben Punkt');
assert(byName(sp, 'Marktplatz').emptyShare === 0.1 && byName(sp, '48.76000,9.16000').emptyShare === null && byName(sp, '48.76000,9.16000').label === '', 'Leerquote je Spot; ohne Quote-Zeile: keine Quote');

// ---------- Übersicht je Anbieter ----------
const r = S.analyzeSpots(fleet, { ags: A, radiusM: 50, quota, demand, zones });
const row = (op) => r.rows.find(x => x.op === op);
assert(r.own === 'Voi' && r.operators.join() === 'Voi,Bolt,Dott,Lime', 'Standard-Perspektive: Anbieter mit den meisten Spots (Voi); Lime ohne Spots wählbar');
const voi = row('Voi'), bolt = row('Bolt');
assert(voi.spots === 5 && voi.virtual === 5 && voi.physical === 0 && voi.diff === null && bolt.diff === -2 && row('Dott').diff === -3, 'Spots je Anbieter und Differenz zum eigenen');
assert(voi.dupExtra === 1 && voi.quotaKnown === 3 && voi.permEmpty === 1, 'Dubletten (überzählig) und dauerhaft leer (≥ 90 % bei ≥ 36 Läufen; Schlossplatz mit 20 Läufen zählt nicht)');
assert(Math.abs(voi.atSpot - 0.25) < 1e-9 && voi.per1000 === 1250 && bolt.matched === 1 && bolt.unmatched === 2 && voi.matched === 2 && voi.unmatched === 3,
  'Fahrzeuge am eigenen Spot (1 von 4), Spots je 1.000 Fahrzeuge, mit/ohne Gegenstück im Umkreis');

// ---------- a) Fehlt bei mir ----------
const m = r.missing;
assert(m.length === 3 && m.every(x => x.members.every(y => y.operator !== 'Voi')), 'Fehlt bei mir: 3 Orte, nur fremde Spots ohne eigenen im Umkreis (Marktplatz B hat Voi in 44 m)');
const bf = m[0];
assert(bf.rank === 1 && bf.nOps === 2 && bf.ops.join() === 'Bolt,Dott' && bf.members.length === 2 && bf.spread === 13 && bf.label === 'Bahnhof', 'Bündelung: Bolt „Bahnhof“ und Dott „Bahnhof (Hub)“ 13 m auseinander = ein Ort mit 2 Anbietern, Rang 1');
assert(Math.abs(bf.score - 3) < 1e-9 && bf.reasons.some(x => x.k === 'demand' && x.v === 2) && bf.reasons.some(x => x.k === 'otherEmpty') && bf.export.deploymentVehicles >= 2,
  'Punkte = 2 Anbieter + Nachfrage 1 (2,0 Starts/h über dem 95. Perzentil); fremde Spots dort meist leer; Vorschlag Fahrzeuge aus der Nachfrage');
const uni = m[1];
assert(uni.label === 'Uni' && uni.ownVehicles === 3 && Math.abs(uni.score - (1 + 0.2 + 0.75)) < 1e-9 && uni.reasons.some(x => x.k === 'veh' && x.n === 3), 'Rang 2: ein Anbieter, wenig Nachfrage, 3 eigene Fahrzeuge ohne Spot (auch gesperrte zählen)');
assert(m[2].reasons.some(x => x.k === 'noDemand') && m[2].export.deploymentVehicles === 0 && m[2].nearestOwn.d > 1000, 'Rang 3: ohne Nachfrage in der Zelle; nächster eigener Spot mit Abstand');
const r25 = S.analyzeSpots(fleet, { ags: A, radiusM: 25, quota, demand });
assert(r25.missing.some(x => x.label === 'Marktplatz B') && r25.missing.length === 4, 'Umkreis 25 m: Marktplatz B (33 m zum nächsten Voi-Spot) fehlt jetzt bei Voi');
const rAll = S.analyzeSpots(fleet, { ags: A, radiusM: 50, quota, demand, kind: 'all' });
assert(rAll.missing.find(x => x.label === 'Uni').ops.join() === 'Bolt,RegioRad' && rAll.rows.find(x => x.op === 'RegioRad').physical === 1, 'alle Stationen: Dock-Station RegioRad bündelt mit Bolt „Uni“');
const rb = S.analyzeSpots(fleet, { ags: A, own: 'Bolt', radiusM: 50, quota });
assert(rb.own === 'Bolt' && !rb.missing.some(x => x.members.some(y => y.label === 'Bahnhof (Hub)')) && rb.missing.some(x => x.label === 'Schlossplatz') && rb.demand === null && rb.missing.every(x => !x.reasons.some(y => y.k === 'demand' || y.k === 'noDemand')),
  'Perspektive Bolt: Dott-Hub neben dem eigenen Bahnhof fehlt nicht; ohne Tagesdateien keine Nachfrage-Begründung');
const rl = S.analyzeSpots(fleet, { ags: A, own: 'Lime', radiusM: 50, quota });
assert(rl.own === 'Lime' && rl.onlyMine.length === 0 && rl.missing.reduce((x, p) => x + p.members.length, 0) === 10, 'Perspektive Lime (keine Spots): alle 10 Spots fehlen, gebündelt');

// ---------- b) Nur bei mir ----------
assert(r.onlyMine.map(x => x.name).join('|') === 'Leer|Schlossplatz|48.76000,9.16000' && r.onlyMine[0].nearestOther.operator === 'Bolt' && r.onlyMine[1].export.parkingStatus === 'enabled',
  'Nur bei mir: Spots ohne fremden Spot im Umkreis, nach Leerquote; nächster fremder Spot; parkingStatus aus is_returning');

// ---------- c) Pflegebedarf ----------
const care = (n) => r.care.find(x => x.name === n);
const dup = care('Marktplatz 2'), z = care('48.76000,9.16000'), e = care('Leer');
assert(dup && dup.issues[0].k === 'dup' && dup.issues[0].of === 'Marktplatz' && dup.issues[0].d === 11 && dup.action === 'merge' && dup.export.parkingStatus === 'disabled' && !care('Marktplatz'),
  'Dublette: der Spot mit höherer Leerquote wird zum Zusammenlegen vorgeschlagen (parkingStatus disabled), der andere bleibt');
assert(z && z.issues[0].k === 'zone' && z.issues[0].zone === 'Fußgängerzone' && z.action === 'move' && r.care[0] === z, 'Zone: eigener Spot in eigener Zone „Durchfahrt verboten“ steht oben');
assert(!care('Schlossplatz') && r.zones.inNoFree === 1 && r.zones.files === 1 && r.zones.noThrough === 1, 'Zone ohne freies Abstellen (ride_allowed = false) ist kein Befund, nur gezählt; Bolt-Zonen gelten nicht für Voi');
assert(e && e.issues[0].k === 'empty' && Math.abs(e.issues[0].share - 0.96) < 1e-9 && e.issues[0].demand === 'low' && e.action === 'check' && r.care.length === 3, 'dauerhaft leer mit wenig Nachfrage: prüfen');
assert(S.analyzeSpots(fleet, { ags: A, quota }).zones === null && !S.analyzeSpots(fleet, { ags: A, quota }).care.some(x => x.issues.some(i => i.k === 'zone')), 'ohne Zonendateien: keine Zonenbefunde (zones = null)');

// ---------- Exporte ----------
const csv = S.spotsBackendCsv(r.missing).split('\n');
assert(csv[0] === 'name,lat,lng,deploymentStatus,parkingStatus,deploymentRadius,deploymentVehicles' && csv.length === 4, 'Backend-CSV: Kopf wie die Spots-CSV der Disposition, eine Zeile je Ort');
assert(csv[1].startsWith('Bahnhof,48.790050,9.200050,disabled,enabled,15,'), 'Zeile: Name, Mittelpunkt mit 6 Stellen, deploymentStatus disabled, parkingStatus enabled, Radius 15');
assert(csv.some(l => l.startsWith('"\'=cmd|"" /c calc""!A0, x",')), 'Formel-Schutz: führendes \' vor =, Anführungszeichen verdoppelt, Komma gequotet');
const csvCare = S.spotsBackendCsv(r.care);
assert(/^Fußgängerzone|^Spot 01,48\.760000,9\.160000,disabled,disabled,15,0$/m.test(csvCare) && /^Marktplatz 2,48\.780100,9\.180000,disabled,disabled,15,0$/m.test(csvCare), 'Pflegebedarf-CSV: Spot ohne Namen heißt „Spot 01“; Zone/Dublette mit parkingStatus disabled');
const gj = S.spotsGeoJson(r.missing, { list: 'missing', own: r.own, radiusM: 50, at: fleet.at, reason: (x) => `Rang ${x.rank}` });
const f0 = gj.features[0];
assert(gj.type === 'FeatureCollection' && gj.features.length === 3 && f0.geometry.coordinates[0] === 9.20005 && f0.properties.operators.join() === 'Bolt,Dott' && f0.properties.members.length === 2 && f0.properties.reason === 'Rang 1' && gj.meta.at === '2026-11-01T12:00:00.000Z',
  'GeoJSON: Punkte [lon, lat], Anbieter, Mitglieder, Begründung, Stand');
assert(S.analyzeSpots({ vehicles: [], stations: [] }, { ags: A }).rows.length === 0 && S.analyzeSpots({ vehicles: [], stations: [] }, { ags: A }).own === null, 'leere Flotte: keine Zeilen, kein eigener Anbieter');


// ---------- Spot-Bewertung mit Prognose (rateSpots) ----------
{
  const grp = { deploy: [
    { op: 'Voi', lat: 48.79005, lon: 9.20005, count: 12, vehicles: 90, avg: 7.5, last: Date.UTC(2026, 10, 3, 6), first: Date.UTC(2026, 10, 1, 6), rank: 1 },   // in der Zelle mit 2,0 Fahrtbeginnen/h, kein Parkspot dabei
    { op: 'Voi', lat: 48.7800, lon: 9.1800, count: 3, vehicles: 12, avg: 4, last: Date.UTC(2026, 10, 2, 6), first: Date.UTC(2026, 10, 1, 6), rank: 2 },        // ≤ 60 m neben Parkspot „Marktplatz“ → ein Ort („beides“)
    { op: 'Bolt', lat: 48.79, lon: 9.2, count: 5, vehicles: 30, avg: 6, last: 1, first: 1, rank: 1 },                                                              // anderer Anbieter: zählt nicht
  ] };
  const fc = { day24: Array.from({ length: 24 }, (_, h) => (h < 12 ? 40 : 20)) }; // 720 Fahrtbeginne in den nächsten 24 Stunden, 40/h in den nächsten 3
  const r = S.rateSpots(fleet, { ags: A, op: 'Voi', demand, groups: grp, quota, fc });
  const byLabel = (l) => r.items.find(x => x.label === l);
  const hub = r.items.find(x => x.deploy?.count === 12), market = r.items.find(x => x.kind === 'both');
  assert(r.items.length === r.total.spots && r.total.deploy === 2 && r.total.both === 1 && !r.items.some(x => x.deploy?.count === 5), `Spot-Bewertung: ${r.items.length} Orte (2 Deploy-Orte, einer davon mit Parkspot verbunden, fremder Anbieter fehlt)`);
  assert(hub && hub.demandPerH === 2 && hub.importance === 1 && hub.cls === 'A', 'Wichtigkeit: der Ort mit der größten Nachfrage hat 100 % (Klasse A)');
  const share = 2.0 + 0.2 + 0.5 + 1.0; // Σ Fahrtbeginne/h der vier Zellen
  assert(Math.abs(hub.cellShare - 2 / share) < 1e-9 && Math.abs(hub.expected24 - 720 * 2 / share) < 1e-6 && Math.abs(hub.expectedH - 120 * 2 / share) < 1e-6, 'Erwartung: Zellenanteil × Prognose des Anbieters (24 h und nächste 3 h)');
  assert(market.cls === 'D' && market.target === 0 && market.missing === 0, 'Ort ohne gemessene Nachfrage: Klasse D, kein Soll, kein Fehlbestand');
  assert(hub.have === 0 && hub.missing === hub.targetFc && hub.targetFc >= 2, `Ist/Soll: ohne Fahrzeuge am Ort fehlt das ganze Soll (${hub.targetFc})`);
  assert(r.total.missing === r.items.reduce((a, x) => a + x.missing, 0) && r.items[0].missing >= r.items.at(-1).missing && r.items[0].rank === 1, 'Rangfolge: größter Fehlbestand zuerst, Summen stimmen');
  // Prognose höher → Soll nicht niedriger; ohne Prognose gilt das gemessene Soll
  const hi = S.rateSpots(fleet, { ags: A, op: 'Voi', demand, groups: grp, quota, fc: { day24: fc.day24.map(x => x * 4) } }), none = S.rateSpots(fleet, { ags: A, op: 'Voi', demand, groups: grp, quota, fc: null });
  assert(hi.items.find(x => x.deploy?.count === 12).targetFc >= hub.targetFc && none.fc === null && none.items.find(x => x.deploy?.count === 12).targetFc === none.items.find(x => x.deploy?.count === 12).target && none.items.find(x => x.deploy?.count === 12).expected24 === null, 'Soll steigt mit der Prognose; ohne Prognose bleibt das gemessene Soll');
  // ohne Nachfragemodell: keine Klassen außer D, kein Fehler
  const nd = S.rateSpots(fleet, { ags: A, op: 'Voi', demand: null, groups: grp, quota, fc });
  assert(nd.items.length > 0 && nd.items.every(x => x.cls === 'D' && x.missing === 0) && nd.hours === 0, 'Ohne Nachfragemodell: alle Orte Klasse D, kein Fehler');
  // mehrere Orte in einer Zelle teilen sich den Zellenanteil
  const two = S.rateSpots({ ...fleet, stations: [] }, { ags: A, op: 'Voi', demand, groups: { deploy: [grp.deploy[0], { ...grp.deploy[0], lat: 48.79008, lon: 9.20008, rank: 2 }] }, quota: null, fc });
  assert(two.items.length === 2 && Math.abs(two.items[0].cellShare - 1 / share) < 1e-9, 'Zwei Orte in einer Zelle teilen sich deren Anteil');
  // Ist: ein Fahrzeug zählt nur am nächsten Ort im Umkreis (zwei Orte dicht beieinander zählen es nicht doppelt)
  const veh0 = fleet.vehicles.find(v => v.operator === 'Voi' && v.ags === A);
  const near2 = { ...fleet, stations: [], vehicles: [{ ...veh0, lat: 48.79006, lon: 9.20006, disabled: false, reserved: false }, { ...veh0, lat: 48.79007, lon: 9.20007, disabled: false, reserved: false }] };
  const dup = S.rateSpots(near2, { ags: A, op: 'Voi', demand, groups: { deploy: [grp.deploy[0], { ...grp.deploy[0], lat: 48.79008, lon: 9.20008, rank: 2 }] }, quota: null, fc });
  assert(dup.items.length === 2 && dup.total.have === 2, `Ist: zwei Fahrzeuge zwischen zwei nahen Orten werden einmal gezählt (${dup.total.have})`);
  assert(byLabel('Marktplatz')?.park?.name === 'Marktplatz' || market.park.name === 'Marktplatz', 'Verbundener Ort trägt die Angaben des Parkspots (Name, Leerquote)');
}
