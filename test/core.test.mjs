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
