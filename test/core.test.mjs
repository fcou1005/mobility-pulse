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
