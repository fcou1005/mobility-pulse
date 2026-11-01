import * as O from '../lib/pulse-ops.js';
import { cellOf, cellCenter } from '../lib/pulse-track.js';
const assert = (c, m) => { if (!c) { console.error('FEHLER:', m); process.exitCode = 1; } else console.log('ok:', m); };
const AGS = '08416041';
const base = [48.52, 9.05];
// Zellen: Raster 6 × 6 um Tübingen, Nachfrage fällt vom Zentrum ab
const cellAt = (i, j) => cellOf(base[0] + i * 0.0025, base[1] + j * 0.0035);
function cellsDoc({ bands = [3, 4], demand = (i, j) => Math.max(0, 12 - 3 * (Math.abs(i) + Math.abs(j))), presence = () => 6 } = {}) {
  const munis = { [AGS]: {} };
  for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) {
    const c = new Array(22).fill(0); const d = demand(i, j);
    for (const b of bands) { c[4 + b] = d; c[10 + b] = presence(i, j) * 9; c[16 + b] = Math.round(d * 0.8); }
    c[0] = d * bands.length; c[1] = Math.round(d * 0.8) * bands.length; c[2] = presence(i, j) * 9 * bands.length;
    munis[AGS][cellAt(i, j)] = c;
  }
  const bandMin = [0, 0, 0, 0, 0, 0], bandRuns = [0, 0, 0, 0, 0, 0];
  for (const b of bands) { bandMin[b] = 180; bandRuns[b] = 9; } // 3 h, 9 Läufe je Band
  return { day: '2026-10-31', state: 'BW', bandMin, bandRuns, munis };
}
const docs = [cellsDoc()];

// --- Nachfragemodell
const m = O.buildDemandModel(docs, AGS, 3);
const center = m.cells.get(cellAt(0, 0));
assert(m.hours === 3 && m.runs === 9, 'Band Mittag: 3 h, 9 Läufe');
assert(Math.abs(center.startsPerHour - 4) < 1e-9, 'Zentrum: 12 Starts in 3 h = 4/h');
assert(Math.abs(center.supplyAvg - 6) < 1e-9, 'Zentrum: Ø 6 Fahrzeuge je Lauf');
const mDay = O.buildDemandModel(docs, AGS, 'day');
assert(mDay.hours === 6 && Math.abs(mDay.cells.get(cellAt(0, 0)).startsPerHour - 4) < 1e-9, 'Tag: 2 Bänder, 6 h, Rate gleich');
assert(O.buildDemandModel(docs, AGS, 0).hours === 0, 'Band ohne Läufe: keine Stunden');

// --- Deploy-Spots
const sp = O.scoreSpots(m, { topN: 5, minSpacingM: 400, share: 0.5 });
assert(sp.spots.length === 5, '5 Spots');
assert(sp.spots[0].cell === cellAt(0, 0), 'Rang 1 = Zelle mit höchster Nachfrage');
let minD = Infinity; for (let a = 0; a < sp.spots.length; a++) for (let b = a + 1; b < sp.spots.length; b++) minD = Math.min(minD, O.dist(sp.spots[a], sp.spots[b]));
assert(minD >= 400, `Mindestabstand eingehalten (${Math.round(minD)} m)`);
assert(sp.spots.every(s => s.stability >= 0 && s.stability <= 1), 'Stabilität 0…1');
assert(sp.spots[0].target === Math.max(2, Math.ceil(4 * 0.5 * 3)), 'Ziel = ceil(Starts/h × Anteil × 3 h)');
assert(sp.activeFactors.join() === 'demand,underserved', 'ohne ÖPNV/Abstellflächen nur zwei Faktoren aktiv');
const wsum = sp.activeFactors.reduce((s, k) => s + sp.weights[k], 0);
assert(Math.abs(O.AHP.weights.demand + O.AHP.weights.underserved + O.AHP.weights.transit + O.AHP.weights.parking - 1) < 1e-3 && wsum > 0, 'AHP-Gewichte summieren auf 1');
// Abstellverbot: Polygon um das Zentrum → Rang 1 darf dort nicht liegen
const [clat, clon] = cellCenter(cellAt(0, 0));
const sq = (lat, lon, d) => ({ type: 'Polygon', coordinates: [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]] });
const sp2 = O.scoreSpots(m, { topN: 5, minSpacingM: 400, noPark: [sq(clat, clon, 0.001)] });
assert(sp2.excluded === 1 && !sp2.spots.some(s => s.cell === cellAt(0, 0)), 'Abstellverbot schließt Zelle aus (Constraint, nicht Gewicht)');
// Loch im Polygon hebt das Verbot auf
const holed = { type: 'Polygon', coordinates: [sq(clat, clon, 0.003).coordinates[0], sq(clat, clon, 0.0005).coordinates[0]] };
assert(!O.geomContains(holed, clat, clon) && O.geomContains(holed, clat + 0.002, clon), 'Polygon mit Loch');
// Abstellfläche: Spot rastet auf E-Scooter-Fläche ein, Radabstellanlage zählt halb
const park = [{ lat: clat + 0.0005, lon: clon + 0.0004, cat: 'escooter', name: 'Stellfläche Markt' }, { lat: cellCenter(cellAt(1, 0))[0], lon: cellCenter(cellAt(1, 0))[1], cat: 'rad' }];
const sp3 = O.scoreSpots(m, { topN: 3, minSpacingM: 200, parking: park, transit: [{ lat: clat, lon: clon }] });
const s1 = sp3.spots.find(s => s.cell === cellAt(0, 0));
assert(s1 && Math.abs(s1.lat - park[0].lat) < 1e-9 && s1.park.cat === 'escooter' && s1.factors.parking === 1, 'Spot auf ausgewiesene Stellfläche gesetzt');
assert(sp3.activeFactors.length === 4, 'mit ÖPNV und Abstellflächen vier Faktoren aktiv');

// --- Rebalancing
const depot = { lat: base[0] - 0.02, lon: base[1] - 0.02 };
const far = cellCenter(cellAt(3, 3)); // Nachfrage 0
const V = (lat, lon, extra = {}) => ({ lat, lon, operator: 'Dott', type: 'scooter', disabled: false, reserved: false, battery: 80, idleMin: 3000, ags: AGS, ...extra });
const fleet = [...Array(12)].map((_, i) => V(far[0] + i * 1e-5, far[1]));
const plan = O.planRebalance({ spots: sp.spots, vehicles: fleet, model: m, share: 0.5, depot, vanCapacity: 5 });
const need = sp.spots.reduce((s, x) => s + x.target, 0);
assert(plan.moves === Math.min(need, 12), `Umsetzungen = min(Bedarf ${need}, Überschuss 12)`);
assert(plan.runs.every(r => r.vehicles <= 5), 'Kapazität je Tour eingehalten');
assert(plan.runs.every(r => { const firstDrop = r.stops.findIndex(s => s.type === 'drop'); return r.stops.slice(firstDrop).every(s => s.type === 'drop'); }), 'erst einsammeln, dann ausbringen');
assert(plan.runs.every(r => r.km > 0 && r.totalMin > r.driveMin), 'Tour mit km und Handlingzeit');
// keine Umsetzung, wenn Spots schon voll sind
const full = sp.spots.flatMap(s => [...Array(s.target)].map(() => V(s.lat, s.lon, { idleMin: 10 })));
assert(O.planRebalance({ spots: sp.spots, vehicles: full, model: m, share: 0.5, depot }).moves === 0, 'volle Spots: keine Umsetzung');
// leere Akkus werden nicht umgesetzt
assert(O.planRebalance({ spots: sp.spots, vehicles: fleet.map(v => ({ ...v, battery: 10 })), model: m, share: 0.5, depot }).moves === 0, 'Akku unter 30 %: nicht umsetzen, sondern tauschen');

// --- Akkutausch
const sw = O.planSwaps({ vehicles: [...fleet.map((v, i) => ({ ...v, battery: i * 5 })), V(clat, clon, { battery: 10 })], model: m, depot, swapCapacity: 3, swapThreshold: 25 });
assert(sw.below === 6, '6 Fahrzeuge unter 25 %');
assert(sw.runs.every(r => r.vehicles <= 3), 'Swap-Kapazität je Tour');
assert(fleet.every(v => v.priority === undefined), 'Eingabe bleibt unverändert');
// höchstens 50 Akkus je Tour, auch wenn mehr eingestellt ist
const many = [...Array(130)].map((_, i) => V(clat + (i % 13) * 0.0004, clon + Math.floor(i / 13) * 0.0004, { battery: 5 }));
const sw50 = O.planSwaps({ vehicles: many, model: m, depot, swapCapacity: 80, swapThreshold: 25 });
assert(sw50.runs.length === 3 && sw50.runs.every(r => r.vehicles <= 50) && sw50.runs[0].vehicles === 50, 'Akkutausch: max. 50 Akkus je Tour');
const top = sw.runs.flatMap(r => r.stops).sort((a, b) => b.priority - a.priority)[0];
assert(top.battery.includes(0) || top.battery.includes(10), 'höchste Priorität: leerster Akku oder Nachfrage-Zentrum');

// --- Werkstatt
const ws = O.planWorkshop({ vehicles: [V(clat, clon, { disabled: true }), V(clat + 0.01, clon, { disabled: true }), V(clat, clon)], depot, workshopCapacity: 1 });
assert(ws.disabled === 2 && ws.runs.length === 2, 'gesperrte Fahrzeuge in Werkstatt-Touren');

// --- Reihenfolge
const line = [5, 1, 4, 2, 3, 0].map(k => ({ lat: 48.5, lon: 9 + k * 0.01, k }));
const ord = O.orderStops(line, { start: { lat: 48.5, lon: 8.99 } });
assert(ord.map(p => p.k).join() === '0,1,2,3,4,5', 'Punkte auf einer Linie in Reihenfolge');

// --- Links und Exporte
const pts = [...Array(19)].map((_, i) => ({ lat: 48 + i / 100, lon: 9 }));
const links = O.mapsLinks(pts);
assert(links.length === 2 && links[0].split('/').length - 5 === 10 && links[1].startsWith('https://www.google.com/maps/dir/48.09000,9.00000/'), 'Google-Maps-Links: höchstens 10 Punkte, Anschluss am letzten Punkt');
const csv = O.spotsCsv(sp.spots, { name: 'Tübingen' }).split('\n');
assert(csv[0] === 'name,lat,lng,deploymentStatus,parkingStatus,deploymentRadius,deploymentVehicles' && csv.length === 6 && csv[1].startsWith('Tübingen 01,'), 'Spots-CSV im Backend-Format');
const gj = O.planGeoJson(sp.spots, plan.runs, depot);
assert(gj.features.filter(f => f.properties.kind === 'spot').length === 5 && gj.features.some(f => f.properties.kind === 'depot'), 'GeoJSON mit Spots, Touren, Depot');
const k = O.fleetKpis([...fleet, V(clat, clon, { disabled: true }), V(clat, clon, { battery: 5, idleMin: 5 })]);
assert(k.total === 14 && k.disabled === 1 && k.low === 1 && k.idle24 === 12, 'Flotten-Kennzahlen');
// Flotte aus ops/<Land>.json
const doc = { at: 1, types: ['scooter', 'ebike'], ops: ['Dott'], munis: [AGS], vehicles: [[48.5, 9.05, 0, 0, 2, 40, 12, 90, 0]], stations: [[48.5, 9.05, 0, 'Markt', 3, 2, 10, 0, 1, 1, 4]] };
const fl = O.decodeFleet(doc);
assert(fl.vehicles[0].disabled && fl.vehicles[0].idleMin === 90 && fl.vehicles[0].ags === AGS && fl.stations[0].capacity === 10, 'Flotte dekodiert');
// Zonen: GBFS-Regeln → Abstellverbote
const fc = { features: [{ properties: { rules: [{ endAllowed: false }] }, geometry: sq(clat, clon, 0.001) }, { properties: { rules: [{ rideAllowed: true }] }, geometry: sq(clat, clon, 0.05) }] };
assert(O.noParkGeometries(fc).length === 1, 'nur Zonen mit Abstell- oder Fahrverbot sind Constraints');
// OSM-Abstellflächen klassifizieren
const els = [{ type: 'node', lat: 1, lon: 2, tags: { amenity: 'kick-scooter_parking' } }, { type: 'way', center: { lat: 1, lon: 2 }, tags: { amenity: 'bicycle_parking' } }, { type: 'node', lat: 1, lon: 2, tags: { amenity: 'bicycle_rental', name: 'Station' } }, { type: 'node', lat: 1, lon: 2, tags: { highway: 'bus_stop' } }];
const pk = O.parkingFromOsm(els), tr = O.transitFromOsm(els);
assert(pk.map(p => p.cat).join() === 'escooter,rad,sharing' && tr.length === 1, 'OSM: E-Scooter-Fläche, Radabstellanlage, Sharing getrennt; Haltestelle als ÖPNV');
// Stationsausgleich
const ST = (name, lat, bookable, cap, extra = {}) => ({ name, lat, lon: 9.05, bookable, docks: cap - bookable, capacity: cap, renting: true, returning: true, ...extra });
const sb = O.planStationBalance({ stations: [ST('Leer', 48.52, 0, 10), ST('Voll', 48.525, 10, 10), ST('Mitte', 48.53, 5, 10), ST('Halbleer', 48.535, 1, 10)], depot, vanCapacity: 20 });
assert(sb.empty === 2 && sb.full === 1, 'Stationen: 2 fast leer, 1 voll');
assert(sb.moves === 5 && sb.missing === 4, 'volle Station gibt 5 ab (bis 50 %), 4 fehlen');
assert(sb.runs[0].stops[0].type === 'pickup' && sb.runs[0].stops[0].station === 'Voll', 'Tour beginnt an der vollen Station');
// Pflicht-Abstellzone (station_parking): Spot rastet auf Station ein, ohne Station ausgeschlossen
const zc = O.zoneConstraints({ features: [{ properties: { rules: [{ rideAllowed: false, rideThrough: true, parking: true }] }, geometry: sq(clat, clon, 0.03) }] });
assert(zc.mandatory.length === 1 && zc.noPark.length === 0, 'station_parking-Zone ist Pflicht-Abstellzone, kein Verbot');
const stn = { lat: clat + 0.0006, lon: clon, name: 'Dott Hub Markt' };
const sp5 = O.scoreSpots(m, { topN: 5, minSpacingM: 200, mandatory: zc.mandatory, stations: [stn] });
assert(sp5.spots.length >= 1 && sp5.spots[0].lat === stn.lat && sp5.spots[0].park.cat === 'station', 'Spot auf Anbieter-Station gesetzt');
assert(sp5.excluded > 0 && sp5.spots.every(s => s.park?.cat === 'station'), 'Zellen ohne Station in der Pflichtzone ausgeschlossen');
