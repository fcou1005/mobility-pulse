// Tests für lib/pulse-compare.js: Kennzahlen je Anbieter, Stationen und Zellen einzigartig/geteilt, Überschneidung, CSV
import * as P from '../lib/pulse-compare.js';
const assert = (c, m) => { if (!c) { console.error('FEHLER:', m); process.exitCode = 1; } else console.log('ok:', m); };
const near = (a, b, eps = 1e-6) => a != null && Math.abs(a - b) <= eps;

const A = '08111000';
const at = (lat, lon, o = {}) => ({ lat, lon, ags: A, type: 'scooter', reserved: false, disabled: false, battery: 50, rangeKm: 20, idleMin: 60, ...o });
// Abstand: 0,0001° Breite ≈ 11 m
const fleet = {
  at: 1,
  vehicles: [
    at(48.7800, 9.1800, { operator: 'Voi' }), at(48.7801, 9.1800, { operator: 'Voi', battery: 10, rangeKm: 2 }), at(48.7900, 9.2000, { operator: 'Voi', disabled: true, idleMin: 600 }),
    at(48.7802, 9.1800, { operator: 'Bolt' }), at(48.7500, 9.1000, { operator: 'Bolt', battery: 15, rangeKm: 8 }),
    at(48.7000, 9.0000, { operator: 'Dott', ags: '08115003' }), at(48.7800, 9.1800, { operator: 'RegioRad', type: 'bike', battery: null, rangeKm: null }),
    at(null, 9.18, { operator: 'Voi' }),
  ],
  // physical = physischer Bestand (Fahrzeuge an der Station), kein Merkmal; virtuell/physisch: Merkmal virtual, sonst Quote, sonst ohne Kapazität und Docks
  stations: [
    { lat: 48.7800, lon: 9.1800, operator: 'Voi', name: 'Marktplatz', bookable: 2, docks: 8, capacity: 10, ags: A, physical: 2, virtual: 0 },
    { lat: 48.7803, lon: 9.1800, operator: 'Bolt', name: 'Marktplatz B', bookable: 0, docks: null, capacity: null, ags: A, physical: 1 },
    { lat: 48.7700, lon: 9.1500, operator: 'Voi', name: 'Allein', bookable: 0, docks: null, capacity: 5, ags: A, physical: 1, virtual: 1 },
    { lat: 48.7700, lon: 9.1500, operator: 'Voi', name: 'Allein 2', bookable: 1, docks: null, capacity: 5, ags: A, physical: 0 },
    { lat: 48.7000, lon: 9.0000, operator: 'Dott', name: 'Andere Gemeinde', bookable: 1, capacity: 5, ags: '08115003', physical: 0 },
  ],
};
// stations-quota.json: „Allein 2“ ist laut Quote virtuell (Feld virtual = 1); die Station trägt selbst kein Merkmal
const quota = { fields: ['ags', 'operator', 'name', 'lat', 'lon', 'runs', 'emptyRuns', 'fullRuns', 'virtual'], stations: [[A, 'Voi', 'Allein 2', 48.77001, 9.15, 50, 10, 0, 1], [A, 'Voi', 'Marktplatz', 48.78, 9.18, 50, 0, 0, 1]] };
assert(near(P.distM({ lat: 48.78, lon: 9.18 }, { lat: 48.7801, lon: 9.18 }), 11.12, 0.05) && near(P.cellAreaKm2(48.78), 0.071, 0.002), 'Abstand ≈ 11 m je 0,0001°, Zelle ≈ 0,07 km² in Stuttgart');
const r = P.compareOperators(fleet, { ags: A, radiusM: 50 });
const row = (op) => r.rows.find(x => x.op === op);
assert(r.rows.map(x => x.op).join() === 'Voi,Bolt,RegioRad' && r.total.vehicles === 6 && r.total.stations === 4, 'nur die Gemeinde, ohne Fahrzeuge ohne Position; nach Bestand sortiert');
const voi = row('Voi'), bolt = row('Bolt');
assert(voi.vehicles === 3 && voi.available === 2 && voi.disabled === 1 && near(voi.lowEnergy, 1 / 3) && voi.idleMedian === 60 && voi.batteryMedian === 50, 'Voi: Bestand, verfügbar, gesperrt, Energie niedrig (Ladestand und Reichweite), Mediane');
assert(near(bolt.lowEnergy, 0) && row('RegioRad').lowEnergy === null, 'Energie niedrig nur, wenn beide gemeldeten Werte niedrig sind; ohne Angabe: keine Quote');
// M-16: Reichweite aus dem Ladestand gerechnet → nur der Ladestand (15 % bei 12 km zählt niedrig, 30 % bei 3 km nicht); sonst UND-Regel
assert(P.vehicleEnergyLow({ operator: 'Voi', battery: 15, rangeKm: 12, rangeDerived: true }) === true && P.vehicleEnergyLow({ operator: 'Voi', battery: 30, rangeKm: 3, rangeDerived: true }) === false
  && P.vehicleEnergyLow({ operator: 'Voi', battery: 15, rangeKm: 12 }) === false && P.vehicleEnergyLow({ operator: 'Voi', battery: null, rangeKm: 3, rangeDerived: true }) === true
  && P.vehicleEnergyLow({ operator: 'Voi', battery: null, rangeKm: null }) === null && P.vehicleEnergyLow({ operator: 'Lime', battery: 10, rangeKm: 12 }) === false,
  'Energie niedrig wie energyLow: rangeDerived → nur Ladestand (ohne Ladestand Reichweite), sonst UND; Lime nur über die Reichweite');
const rdv = P.compareOperators({ at: 1, vehicles: [at(48.78, 9.18, { operator: 'Voi', battery: 15, rangeKm: 12, rangeDerived: true }), at(48.7801, 9.18, { operator: 'Voi', battery: 15, rangeKm: 12 })], stations: [] }, { ags: A });
assert(near(rdv.rows[0].lowEnergy, 0.5) && rdv.rows[0].energyKnown === 2, 'Vergleich: abgeleitete Reichweite zählt nur über den Ladestand (1 von 2 niedrig)');
assert(P.isVirtualStation({ virtual: 1, capacity: 5 }) && !P.isVirtualStation({ virtual: 0 }) && P.isVirtualStation({ capacity: 5, docks: 2 }, { virtual: 1 }) && !P.isVirtualStation({ capacity: null, docks: null }, { virtual: 0 })
  && P.isVirtualStation({ capacity: null, docks: null }) && !P.isVirtualStation({ capacity: 4, docks: null }) && !P.isVirtualStation({ physical: 1, capacity: 3 }),
  'virtuell: Merkmal der Station vor Quote vor Näherung (weder Kapazität noch Docks); physical (Fahrzeuge an der Station) zählt nicht');
assert(voi.stations === 3 && voi.physical === 2 && voi.virtual === 1 && row('Bolt').virtual === 1 && row('Bolt').physical === 0, 'ohne Quote: Marktplatz (virtual 0) und Allein 2 (Kapazität) physisch, Allein (virtual 1) virtuell; Bolt ohne Kapazität und Docks virtuell');
const rq = P.compareOperators(fleet, { ags: A, radiusM: 50, quota });
assert(rq.rows.find(x => x.op === 'Voi').virtual === 2 && rq.stations.find(s => s.name === 'Allein 2').virtual === true && rq.stations.find(s => s.name === 'Marktplatz').virtual === false,
  'mit Quote: Allein 2 virtuell (Quote, gleicher Name ≤ 15 m); Marktplatz bleibt physisch, weil das Merkmal der Station vor der Quote gilt');
assert(voi.stations === 3 && voi.emptyStations === 1 && voi.uniqueStations === 2 && voi.sharedStations === 1 && bolt.uniqueStations === 0 && bolt.sharedStations === 1,
  'Stationen: Marktplatz geteilt (Bolt 33 m entfernt), die eigene zweite Station am selben Ort macht nicht geteilt');
const mk = r.stations.find(s => s.name === 'Marktplatz');
assert(mk.unique === false && mk.nearestOther.operator === 'Bolt' && mk.nearestOther.d === 33, 'nächste fremde Station mit Abstand in Metern');
assert(P.compareOperators(fleet, { ags: A, radiusM: 25 }).stations.find(s => s.name === 'Marktplatz').unique === true, 'kleinerer Umkreis (25 m): Marktplatz einzigartig');
assert(voi.cells === 2 && voi.uniqueCells === 1 && voi.sharedCells === 1 && bolt.cells === 2 && bolt.uniqueCells === 1 && near(r.overlap.Voi.Bolt, 0.5) && near(r.overlap.RegioRad.Voi, 1),
  'Zellen: Voi in 2 Zellen, eine davon nur Voi; Überschneidung Voi→Bolt 50 %, RegioRad→Voi 100 %');
assert(near(voi.nearOther, 2 / 3) && near(row('RegioRad').nearOther, 1), 'Anteil der Fahrzeuge mit fremdem Fahrzeug im Umkreis');
assert(voi.areaKm2 > 0.13 && voi.areaKm2 < 0.15 && voi.density > 20, 'Fläche = belegte Zellen × Zellfläche, Dichte Fahrzeuge je km²');
const sc = P.compareOperators(fleet, { ags: A, type: 'bike' });
assert(sc.rows.length === 1 && sc.rows[0].op === 'RegioRad' && sc.total.stations === 0, 'Fahrzeugart Rad: nur RegioRad; Stationen über die Anbieter mit dieser Art');
const csv = P.stationCsvRows(r.stations, { lang: 'de' });
assert(csv.length === 5 && csv[0][0] === 'Station' && csv.some(x => x[0] === 'Marktplatz' && x[2] === '48,78000' && x[4] === 'physisch' && x[7] === 'nein' && x[8] === 'Bolt' && x[9] === 33) && csv.some(x => x[0] === 'Allein' && x[4] === 'virtuell'), 'CSV der Stationen mit Dezimalkomma, Lage und nächstem fremden Anbieter');
assert(P.compareOperators({ vehicles: [], stations: [] }, { ags: A }).rows.length === 0, 'leere Flotte: keine Zeilen');
// ops/<Land>.json: Feld 12 „virtuell“ wird zu s.virtual (1/0), ältere Dateien mit 11 Feldern → null (dann Quote bzw. Näherung)
const { decodeFleet } = await import('../lib/pulse-ops.js');
const doc = { at: 1, ops: ['Voi'], types: ['scooter'], munis: [A], vehicles: [], stations: [[48.78, 9.18, 0, 'Neu', 1, null, 5, 0, 1, 1, 1, 1], [48.79, 9.18, 0, 'Alt', 0, 3, 8, 0, 1, 1, 2]] };
const dec = decodeFleet(doc);
assert(dec.stations[0].virtual === 1 && dec.stations[0].physical === 1 && dec.stations[1].virtual === null && dec.stations[1].physical === 2, 'decodeFleet: virtual aus Feld 12, physical bleibt der physische Bestand');
const rd = P.compareOperators(dec, { ags: A });
assert(rd.rows[0].virtual === 1 && rd.rows[0].physical === 1, 'Vergleich: „Neu“ virtuell laut Merkmal, „Alt“ physisch (Kapazität und Docks gemeldet)');
// Ladestand nur abgeleitet (Reichweite ÷ Maximalreichweite, v.batteryDerived) → nur die Reichweite zählt
assert(P.vehicleEnergyLow({ operator: 'Voi', battery: 30, rangeKm: 3, batteryDerived: true }) === true && P.vehicleEnergyLow({ operator: 'Voi', battery: 10, rangeKm: 12, batteryDerived: true }) === false,
  'abgeleiteter Ladestand: nur Reichweite (30 % / 3 km niedrig, 10 % / 12 km nicht)');
