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
  stations: [
    { lat: 48.7800, lon: 9.1800, operator: 'Voi', name: 'Marktplatz', bookable: 2, capacity: 10, ags: A, physical: 0 },
    { lat: 48.7803, lon: 9.1800, operator: 'Bolt', name: 'Marktplatz B', bookable: 0, capacity: 8, ags: A, physical: 0 },
    { lat: 48.7700, lon: 9.1500, operator: 'Voi', name: 'Allein', bookable: 0, capacity: 5, ags: A, physical: 1 },
    { lat: 48.7700, lon: 9.1500, operator: 'Voi', name: 'Allein 2', bookable: 1, capacity: 5, ags: A, physical: 0 },
    { lat: 48.7000, lon: 9.0000, operator: 'Dott', name: 'Andere Gemeinde', bookable: 1, capacity: 5, ags: '08115003', physical: 0 },
  ],
};
assert(near(P.distM({ lat: 48.78, lon: 9.18 }, { lat: 48.7801, lon: 9.18 }), 11.12, 0.05) && near(P.cellAreaKm2(48.78), 0.071, 0.002), 'Abstand ≈ 11 m je 0,0001°, Zelle ≈ 0,07 km² in Stuttgart');
const r = P.compareOperators(fleet, { ags: A, radiusM: 50 });
const row = (op) => r.rows.find(x => x.op === op);
assert(r.rows.map(x => x.op).join() === 'Voi,Bolt,RegioRad' && r.total.vehicles === 6 && r.total.stations === 4, 'nur die Gemeinde, ohne Fahrzeuge ohne Position; nach Bestand sortiert');
const voi = row('Voi'), bolt = row('Bolt');
assert(voi.vehicles === 3 && voi.available === 2 && voi.disabled === 1 && near(voi.lowEnergy, 1 / 3) && voi.idleMedian === 60 && voi.batteryMedian === 50, 'Voi: Bestand, verfügbar, gesperrt, Energie niedrig (Ladestand und Reichweite), Mediane');
assert(near(bolt.lowEnergy, 0) && row('RegioRad').lowEnergy === null, 'Energie niedrig nur, wenn beide gemeldeten Werte niedrig sind; ohne Angabe: keine Quote');
assert(voi.stations === 3 && voi.physical === 1 && voi.virtual === 2 && voi.emptyStations === 1 && voi.uniqueStations === 2 && voi.sharedStations === 1 && bolt.uniqueStations === 0 && bolt.sharedStations === 1,
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
assert(csv.length === 5 && csv[0][0] === 'Station' && csv.some(x => x[0] === 'Marktplatz' && x[2] === '48,78000' && x[7] === 'nein' && x[8] === 'Bolt' && x[9] === 33), 'CSV der Stationen mit Dezimalkomma, Lage und nächstem fremden Anbieter');
assert(P.compareOperators({ vehicles: [], stations: [] }, { ags: A }).rows.length === 0, 'leere Flotte: keine Zeilen');
