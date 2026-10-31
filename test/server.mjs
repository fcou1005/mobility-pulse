// Lokaler Fixture-Server für GBFS 2.3, 3.0 und CityBikes
import http from 'node:http';
const now = Math.floor(Date.now()/1000);
const base = () => `http://127.0.0.1:${PORT}`;
const PORT = +process.env.PORT || 8765;
const v23 = {
  'gbfs.json': () => ({ last_updated: now, ttl: 60, version: '2.3', data: { de: { feeds: ['system_information','vehicle_types','station_information','station_status','free_bike_status'].map(n => ({ name: n, url: `${base()}/v23/${n}.json` })) } } }),
  'system_information.json': () => ({ last_updated: now, ttl: 60, version: '2.3', data: { system_id: 'bolt_test', name: 'Bolt Test', operator: 'Bolt', timezone: 'Europe/Berlin', license_url: 'https://creativecommons.org/licenses/by/4.0/' } }),
  'vehicle_types.json': () => ({ last_updated: now, ttl: 60, version: '2.3', data: { vehicle_types: [{ vehicle_type_id: 'sc', form_factor: 'scooter', propulsion_type: 'electric', max_range_meters: 40000 }, { vehicle_type_id: 'eb', form_factor: 'bicycle', propulsion_type: 'electric_assist', max_range_meters: 60000 }] } }),
  'station_information.json': () => ({ last_updated: now, ttl: 60, version: '2.3', data: { stations: [{ station_id: 's1', name: 'Hauptbahnhof', lat: 48.5157, lon: 9.0552, capacity: 10 }, { station_id: 's2', name: 'Geschlossen', lat: 48.52, lon: 9.06, capacity: 5 }] } }),
  'station_status.json': () => ({ last_updated: now, ttl: 60, version: '2.3', data: { stations: [{ station_id: 's1', num_bikes_available: 3, num_docks_available: 7, is_installed: true, is_renting: true, is_returning: true, last_reported: now }, { station_id: 's2', num_bikes_available: 6, num_docks_available: 0, is_installed: true, is_renting: false, is_returning: false, last_reported: now }] } }),
  'free_bike_status.json': () => ({ last_updated: now - 120, ttl: 60, version: '2.3', data: { bikes: [
    { bike_id: 'a1', lat: 48.52, lon: 9.05, is_reserved: false, is_disabled: false, vehicle_type_id: 'sc', current_range_meters: 5000, current_fuel_percent: 0.12, last_reported: now - 60 },
    { bike_id: 'a2', lat: 9.055, lon: 48.515, is_reserved: false, is_disabled: true, vehicle_type_id: 'sc', current_range_meters: 30000, last_reported: now - 60 }, // vertauscht
    { bike_id: 'a3', is_reserved: true, is_disabled: false, vehicle_type_id: 'eb', station_id: 's1', current_range_meters: 20000 }, // Stationsersatz
    { bike_id: 'bike:a1', lat: 48.5201, lon: 9.0501, is_reserved: false, is_disabled: false, vehicle_type_id: 'sc', current_fuel_percent: 0.12, last_reported: now - 300 }, // Dublette
    { bike_id: 'a4', lat: 55.9, lon: 12.0, vehicle_type_id: 'sc' }, // Dänemark
    { bike_id: 'a5', lat: 0, lon: 0, vehicle_type_id: 'sc' }, // fehlt
  ] } }),
};
const v30 = {
  'gbfs.json': () => ({ last_updated: new Date().toISOString(), ttl: 60, version: '3.0', data: { feeds: ['system_information','vehicle_types','vehicle_status'].map(n => ({ name: n, url: `${base()}/v30/${n}.json` })) } }),
  'system_information.json': () => ({ last_updated: new Date().toISOString(), ttl: 60, version: '3.0', data: { system_id: 'dott_test', name: [{ text: 'Dott Test', language: 'de' }], operator: [{ text: 'Dott', language: 'de' }], timezone: 'Europe/Berlin', license_id: 'CC-BY-4.0' } }),
  'vehicle_types.json': () => ({ last_updated: new Date().toISOString(), ttl: 60, version: '3.0', data: { vehicle_types: [{ vehicle_type_id: 'sc', form_factor: 'scooter_standing', propulsion_type: 'electric', max_range_meters: 50000, name: [{ text: 'Scooter', language: 'en' }] }] } }),
  'vehicle_status.json': () => ({ last_updated: new Date(Date.now() - 40*60e3).toISOString(), ttl: 60, version: '3.0', data: { vehicles: [
    { vehicle_id: '0f1e2d3c-1111-4222-8333-444455556666', lat: 48.78, lon: 9.18, is_reserved: false, is_disabled: false, vehicle_type_id: 'sc', current_range_meters: 12000, current_fuel_percent: 0.3, last_reported: new Date().toISOString() },
  ] } }),
};
const citybikes = () => ({ network: { id: 'test-net', name: 'nextbike Test', company: ['nextbike GmbH'], location: { city: 'Tübingen', country: 'DE', latitude: 48.52, longitude: 9.05 }, stations: [
  { id: 'x1', name: 'Hauptbahnhof', latitude: 48.5157, longitude: 9.0552, free_bikes: 4, empty_slots: 6, timestamp: new Date().toISOString(), extra: { uid: '77', renting: 1, returning: 1, ebikes: 1, normal_bikes: 3 } },
  { id: 'x2', name: 'Lustnau', latitude: 48.53, longitude: 9.08, free_bikes: 0, empty_slots: 10, timestamp: new Date().toISOString(), extra: { uid: '78', renting: 1, returning: 1 } },
] } });
http.createServer((req, res) => {
  const [, kind, file] = req.url.split('/');
  let body = null;
  if (kind === 'v23' && v23[file]) body = v23[file]();
  else if (kind === 'v30' && v30[file]) body = v30[file]();
  else if (kind === 'citybikes') body = citybikes();
  else if (kind === 'gone') { res.writeHead(404); return res.end('{}'); }
  if (!body) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
}).listen(PORT, '127.0.0.1', () => console.log('fixture server on', PORT));
