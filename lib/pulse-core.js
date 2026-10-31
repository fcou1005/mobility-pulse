// Mobility Pulse — gemeinsame Kernbibliothek für Sammler (Node) und Dashboard (Browser).
// Keine Abhängigkeiten. ESM.

export const LIVE_MS = 5 * 60e3;      // ≤ 5 Min: aktuell (GBFS-Latenzvorgabe)
export const DELAYED_MS = 30 * 60e3;  // ≤ 30 Min: verzögert, darüber veraltet
export const DE_BBOX = { minLon: 5.8, minLat: 47.2, maxLon: 15.1, maxLat: 55.2 };

export const num = (v) => (v == null || v === '' || typeof v === 'boolean' ? null : Number.isFinite(+v) ? +v : null);
export const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? true : v === false || v === 0 || v === '0' || v === 'false' ? false : null);

// GBFS-Zeitstempel: Sekunden (2.x), Millisekunden, RFC3339 (3.0)
export function toMs(t) {
  if (t == null || t === '') return null;
  if (typeof t === 'number' || /^\d+(\.\d+)?$/.test(String(t))) {
    const n = +t;
    if (n > 1e14) return null;        // Unsinn
    if (n > 1e11) return Math.round(n); // ms
    if (n > 1e8) return Math.round(n * 1000); // s
    return null;
  }
  let str = String(t).trim();
  let ms = Date.parse(str);
  if (!Number.isFinite(ms) && /[+-]\d\d:?\d\dZ$/.test(str)) ms = Date.parse(str.slice(0, -1)); // CityBikes: „+00:00Z“
  if (!Number.isFinite(ms) && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(str)) ms = Date.parse(str.replace(' ', 'T'));
  return Number.isFinite(ms) ? ms : null;
}

export function freshness(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs < -2 * 60e3) return 'unknown';
  if (ageMs <= LIVE_MS) return 'live';
  if (ageMs <= DELAYED_MS) return 'delayed';
  return 'stale';
}
export const FRESHNESS_LABEL = { live: 'Aktuell', delayed: 'Verzögert', stale: 'Veraltet', unknown: 'Zeit unklar', error: 'Fehler', gap: 'Datenlücke', auth: 'Zugang nötig', gone: 'Nicht erreichbar' };

export const VEHICLE_TYPES = ['scooter', 'ebike', 'bike', 'cargo', 'other', 'unknown'];
export const VEHICLE_TYPE_LABEL = { scooter: 'E-Scooter', ebike: 'E-Bikes', bike: 'Normale Fahrräder', cargo: 'Lastenräder', other: 'Sonstige', unknown: 'Fahrzeugart ungeklärt' };

export function classifyVehicleType(vt, hint = '') {
  const ff = String(vt?.form_factor || '').toLowerCase();
  const prop = String(vt?.propulsion_type || '').toLowerCase();
  const h = String(hint).toLowerCase();
  if (ff === 'scooter' || ff === 'scooter_standing' || ff === 'scooter_seated') return 'scooter';
  if (ff === 'cargo_bicycle' || /lasten|cargo/.test(h)) return 'cargo';
  if (ff === 'bicycle') return /electric/.test(prop) ? 'ebike' : 'bike';
  if (ff === 'moped' || ff === 'car' || ff === 'other') return 'other';
  if (/scooter|roller|zeus|voi|bolt|lime|bird|dott|tier/.test(h)) return 'scooter';
  if (/e-?bike|pedelec/.test(h)) return 'ebike';
  if (/bike|rad|velo|nextbike|donkey|callabike|regiorad|stadtrad/.test(h)) return 'bike';
  return 'unknown';
}

// ---------- Geo ----------
export function validLatLon(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
}
export const inGermanyBbox = (lat, lon) => lat >= DE_BBOX.minLat && lat <= DE_BBOX.maxLat && lon >= DE_BBOX.minLon && lon <= DE_BBOX.maxLon;

// Eindeutig vertauschte Koordinaten (lon im Lat-Bereich Deutschlands und umgekehrt) reparieren
export function repairLatLon(lat, lon) {
  if (validLatLon(lat, lon) && inGermanyBbox(lat, lon)) return { lat, lon, repaired: false };
  if (validLatLon(lon, lat) && inGermanyBbox(lon, lat)) return { lat: lon, lon: lat, repaired: true };
  return { lat, lon, repaired: false };
}

export function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function ringContains(ring, lon, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function polygonContains(coords, lon, lat) { // coords: [outer, hole, hole...]
  if (!ringContains(coords[0], lon, lat)) return false;
  for (let k = 1; k < coords.length; k++) if (ringContains(coords[k], lon, lat)) return false;
  return true;
}
function geomContains(geom, lon, lat) {
  if (!geom) return false;
  if (geom.type === 'Polygon') return polygonContains(geom.coordinates, lon, lat);
  if (geom.type === 'MultiPolygon') return geom.coordinates.some(p => polygonContains(p, lon, lat));
  return false;
}
function geomBbox(geom) {
  let minX = 180, minY = 90, maxX = -180, maxY = -90;
  const walk = (c) => { if (typeof c[0] === 'number') { if (c[0] < minX) minX = c[0]; if (c[0] > maxX) maxX = c[0]; if (c[1] < minY) minY = c[1]; if (c[1] > maxY) maxY = c[1]; } else c.forEach(walk); };
  walk(geom.coordinates);
  return [minX, minY, maxX, maxY];
}

// Gemeinde-Index: Rasterzellen (0.1°) → Kandidaten
export function buildMunicipalityIndex(featureCollection, cell = 0.1) {
  const feats = featureCollection.features;
  const grid = new Map();
  const bboxes = feats.map(f => f.bbox || geomBbox(f.geometry));
  bboxes.forEach((b, i) => {
    for (let x = Math.floor(b[0] / cell); x <= Math.floor(b[2] / cell); x++)
      for (let y = Math.floor(b[1] / cell); y <= Math.floor(b[3] / cell); y++) {
        const k = `${x}:${y}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(i);
      }
  });
  return { feats, bboxes, grid, cell };
}
export function assignMunicipality(index, lat, lon) {
  if (!index || !validLatLon(lat, lon)) return null;
  const k = `${Math.floor(lon / index.cell)}:${Math.floor(lat / index.cell)}`;
  const cands = index.grid.get(k);
  if (!cands) return null;
  for (const i of cands) {
    const b = index.bboxes[i];
    if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
    if (geomContains(index.feats[i].geometry, lon, lat)) return index.feats[i].properties;
  }
  return null;
}

// ---------- Kennungen ----------
const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
export function normalizeId(raw) {
  const s = String(raw ?? '').trim();
  const u = s.match(UUID_RE);
  if (u) return u[1].toLowerCase();
  return s.toLowerCase().replace(/^(bike|vehicle|scooter|veh|v|b|id)[:_-]+/, '').replace(/^[a-z0-9_-]+?:(?=.)/, '');
}
export function hashStr(s) { // FNV-1a 32 bit
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

// ---------- GBFS lesen ----------
function firstLang(obj) {
  if (!obj) return null;
  if (Array.isArray(obj)) return obj.find(x => x && (x.language === 'de' || x.language === 'en'))?.text ?? obj[0]?.text ?? null;
  if (typeof obj === 'object') return obj.de ?? obj.en ?? Object.values(obj)[0] ?? null;
  return obj;
}

// discovery → { version, feeds: {name: url}, lang }
export function parseDiscovery(doc) {
  const version = String(doc?.version || '');
  let feeds = null, lang = null;
  if (doc?.data?.feeds) { feeds = doc.data.feeds; lang = doc.data.language || null; }
  else if (doc?.data && typeof doc.data === 'object') {
    const langs = Object.keys(doc.data);
    const pick = langs.find(l => l === 'de') || langs.find(l => l === 'en') || langs[0];
    if (pick && doc.data[pick]?.feeds) { feeds = doc.data[pick].feeds; lang = pick; }
  }
  const map = {};
  for (const f of feeds || []) if (f?.name && f?.url) map[f.name] = f.url;
  return { version, feeds: map, lang };
}

/**
 * Liest ein GBFS-System. fetchJson(url) → { ok, status, json, latencyMs }.
 * Rückgabe: normalisiertes System (Fahrzeuge, Stationen, Metadaten, Fehler).
 */
export async function readGbfsSystem(source, fetchJson, { now = Date.now(), maxVehicles = Infinity } = {}) {
  const t0 = Date.now();
  const errors = [];
  const res = { sourceId: source.id, operator: source.operator, api: 'gbfs', url: source.url, errors, vehicles: [], stations: [], systemInfo: {}, vehicleTypes: {}, feedAges: {}, lastUpdated: null, ttl: null, httpStatus: null, latencyMs: null };
  const disc = await fetchJson(source.url);
  res.httpStatus = disc.status;
  if (!disc.ok || !disc.json) { errors.push(`discovery: HTTP ${disc.status}${disc.error ? ' ' + disc.error : ''}`); res.latencyMs = Date.now() - t0; return res; }
  const { version, feeds, lang } = parseDiscovery(disc.json);
  res.version = version || disc.json?.version || null; res.lang = lang;
  res.lastUpdated = toMs(disc.json.last_updated); res.ttl = num(disc.json.ttl);
  if (!Object.keys(feeds).length) { errors.push('discovery: keine Feeds'); res.latencyMs = Date.now() - t0; return res; }
  res.feeds = feeds;

  const get = async (name) => {
    if (!feeds[name]) return null;
    const r = await fetchJson(feeds[name]);
    if (!r.ok || !r.json) { errors.push(`${name}: HTTP ${r.status}${r.error ? ' ' + r.error : ''}`); return null; }
    const lu = toMs(r.json.last_updated);
    res.feedAges[name] = lu != null ? now - lu : null;
    return r.json;
  };

  const [sysInfo, vtypes, stInfo, stStatus, vehStatus, fbs] = await Promise.all([
    get('system_information'), get('vehicle_types'), get('station_information'), get('station_status'),
    get('vehicle_status'), feeds.vehicle_status ? Promise.resolve(null) : get('free_bike_status'),
  ]);
  const vehicleFeed = vehStatus || fbs;
  const vehicleFeedName = vehStatus ? 'vehicle_status' : 'free_bike_status';

  if (sysInfo?.data) {
    const d = sysInfo.data;
    res.systemInfo = {
      systemId: d.system_id || null, name: firstLang(d.name), operator: firstLang(d.operator), timezone: d.timezone || null,
      licenseId: d.license_id || null, licenseUrl: d.license_url || null, attribution: firstLang(d.attribution_organization_name) || null,
      url: d.url || null, feedContact: d.feed_contact_email || null,
    };
  }
  const typeMap = {};
  for (const vt of vtypes?.data?.vehicle_types || []) {
    typeMap[vt.vehicle_type_id] = { type: classifyVehicleType(vt, vt.name ? firstLang(vt.name) : ''), propulsion: vt.propulsion_type || null, maxRangeM: num(vt.max_range_meters), formFactor: vt.form_factor || null };
  }
  res.vehicleTypes = typeMap;
  const hint = `${source.operator} ${source.name || ''} ${res.systemInfo.name || ''}`;
  const fallbackType = classifyVehicleType(null, hint);

  // Stationen
  const stMap = new Map();
  for (const s of stInfo?.data?.stations || []) {
    const lat = num(s.lat), lon = num(s.lon);
    stMap.set(String(s.station_id), { id: String(s.station_id), name: firstLang(s.name) || '', lat, lon, capacity: num(s.capacity), isVirtual: bool(s.is_virtual_station) });
  }
  const stAge = res.feedAges.station_status;
  for (const s of stStatus?.data?.stations || []) {
    const base = stMap.get(String(s.station_id)) || { id: String(s.station_id), name: '', lat: null, lon: null, capacity: null, missingInfo: true };
    const physical = num(s.num_vehicles_available ?? s.num_bikes_available);
    const disabled = num(s.num_vehicles_disabled ?? s.num_bikes_disabled);
    const installed = bool(s.is_installed) ?? true, renting = bool(s.is_renting) ?? true, returning = bool(s.is_returning) ?? true;
    const docks = num(s.num_docks_available);
    const perType = {};
    for (const t of s.vehicle_types_available || []) { const ty = typeMap[t.vehicle_type_id]?.type || fallbackType; perType[ty] = (perType[ty] || 0) + (num(t.count) || 0); }
    const reportedAt = toMs(s.last_reported) ?? (stStatus?.last_updated ? toMs(stStatus.last_updated) : null);
    stMap.set(base.id, { ...base, physicalAvailable: physical, disabled, docksAvailable: docks, installed, renting, returning,
      bookable: installed && renting ? physical : 0, returnable: installed && returning ? (docks ?? null) : 0,
      perType: Object.keys(perType).length ? perType : null, typeHint: fallbackType, reportedAt, feedAgeMs: stAge });
  }
  res.stations = [...stMap.values()];

  // Fahrzeuge
  const vehAge = res.feedAges[vehicleFeedName];
  const list = vehicleFeed?.data?.vehicles || vehicleFeed?.data?.bikes || [];
  res.vehicleListPresent = !!vehicleFeed;
  let idx = 0;
  for (const v of list) {
    if (idx++ >= maxVehicles) break;
    let lat = num(v.lat), lon = num(v.lon);
    let origin = 'vehicle', repaired = false, geoStatus = 'ok';
    const stationId = v.station_id != null ? String(v.station_id) : null;
    if (lat == null || lon == null) {
      const st = stationId ? stMap.get(stationId) : null;
      if (st && validLatLon(st.lat, st.lon)) { lat = st.lat; lon = st.lon; origin = 'station'; }
    }
    if (lat != null && lon != null) { const r = repairLatLon(lat, lon); lat = r.lat; lon = r.lon; repaired = r.repaired; }
    if (!validLatLon(lat, lon)) geoStatus = 'missing';
    else if (!inGermanyBbox(lat, lon)) geoStatus = 'outside';
    const vt = typeMap[v.vehicle_type_id];
    const type = vt?.type || fallbackType;
    const rangeM = num(v.current_range_meters);
    let battery = num(v.current_fuel_percent);
    if (battery != null && battery <= 1 && battery >= 0) battery = battery * 100; // 2.3: 0..1
    if (battery == null && rangeM != null && vt?.maxRangeM) battery = Math.min(100, Math.round((rangeM / vt.maxRangeM) * 100));
    const reportedAt = toMs(v.last_reported);
    res.vehicles.push({
      rawId: v.vehicle_id ?? v.bike_id ?? `${source.id}#${idx}`, lat, lon, type, propulsion: vt?.propulsion || null,
      reserved: bool(v.is_reserved) ?? false, disabled: bool(v.is_disabled) ?? false, batteryPct: battery, rangeKm: rangeM != null ? rangeM / 1000 : null,
      stationId, reportedAt, positionAgeMs: reportedAt != null ? now - reportedAt : null, geoOrigin: origin, geoRepaired: repaired, geoStatus,
    });
  }
  res.latencyMs = Date.now() - t0;
  return res;
}

// CityBikes-Netz lesen (nur Stationszähler, keine Fahrzeugliste)
export async function readCityBikesNetwork(source, fetchJson, { now = Date.now() } = {}) {
  const t0 = Date.now();
  const errors = [];
  const res = { sourceId: source.id, operator: source.operator, api: 'citybikes', url: source.url, errors, vehicles: [], stations: [], systemInfo: {}, vehicleTypes: {}, feedAges: {}, lastUpdated: null, httpStatus: null, latencyMs: null, vehicleListPresent: false };
  const r = await fetchJson(source.url);
  res.httpStatus = r.status;
  if (!r.ok || !r.json?.network) { errors.push(`citybikes: HTTP ${r.status}${r.error ? ' ' + r.error : ''}`); res.latencyMs = Date.now() - t0; return res; }
  const n = r.json.network;
  res.systemInfo = { name: n.name, operator: (n.company || []).join(', ') || null, licenseId: n.license?.name || null, licenseUrl: n.license?.url || null, source: n.source || null };
  const hint = `${source.operator} ${n.name} ${(n.company || []).join(' ')}`;
  const fallbackType = classifyVehicleType(null, hint);
  let newest = null;
  for (const s of n.stations || []) {
    const lat = num(s.latitude), lon = num(s.longitude);
    const ts = toMs(s.timestamp);
    if (ts != null && (newest == null || ts > newest)) newest = ts;
    const ex = s.extra || {};
    const physical = num(s.free_bikes), docks = num(s.empty_slots);
    const renting = bool(ex.renting) ?? true, returning = bool(ex.returning) ?? true, installed = bool(ex.online) ?? true;
    const perType = {};
    if (num(ex.ebikes) != null) perType.ebike = num(ex.ebikes);
    if (num(ex.normal_bikes) != null) perType.bike = num(ex.normal_bikes);
    if (num(ex.scooters) != null) perType.scooter = num(ex.scooters);
    res.stations.push({ id: String(ex.uid ?? s.id), name: s.name || '', lat, lon, capacity: num(ex.slots), physicalAvailable: physical, disabled: null, docksAvailable: docks,
      installed, renting, returning, bookable: installed && renting ? physical : 0, returnable: installed && returning ? docks : 0,
      perType: Object.keys(perType).length ? perType : { [fallbackType]: physical }, typeHint: fallbackType, reportedAt: ts, isVirtual: bool(ex.virtual), feedAgeMs: ts != null ? now - ts : null });
  }
  res.lastUpdated = newest; res.feedAges.station_status = newest != null ? now - newest : null;
  res.latencyMs = Date.now() - t0;
  return res;
}

// ---------- Fingerabdruck & Qualität ----------
export function fingerprint(sys) {
  const feedNames = Object.keys(sys.feeds || {}).sort().join(',');
  const types = Object.values(sys.vehicleTypes || {}).map(t => t.type).sort().join(',');
  return hashStr([sys.url, sys.version, feedNames, types, sys.vehicleListPresent ? 'veh' : 'st'].join('|'));
}

export function qualityScore(sys, now = Date.now()) {
  const ages = Object.values(sys.feedAges || {}).filter(a => a != null);
  const age = ages.length ? Math.max(...ages) : (sys.lastUpdated != null ? now - sys.lastUpdated : null);
  let fresh = 0;
  if (age != null) fresh = age <= LIVE_MS ? 100 : age <= DELAYED_MS ? Math.round(100 - ((age - LIVE_MS) / (DELAYED_MS - LIVE_MS)) * 60) : Math.max(0, 40 - Math.round(age / 3600e3) * 10);
  const v = sys.vehicles || [], s = sys.stations || [];
  const n = v.length;
  const field = (f) => (n ? Math.round((v.filter(f).length / n) * 100) : 0);
  const fields = n
    ? [field(x => x.batteryPct != null || x.rangeKm != null), field(x => x.reportedAt != null), field(x => x.type !== 'unknown'), 100]
    : [s.some(x => x.renting != null) ? 100 : 0, s.some(x => x.reportedAt != null) ? 100 : 0, s.some(x => x.perType) ? 60 : 0, s.length ? 100 : 0];
  const feat = Math.round(fields.reduce((a, b) => a + b, 0) / fields.length);
  return { score: Math.round(fresh * 0.7 + feat * 0.3), fresh, feat, ageMs: age };
}

// ---------- Dedupe ----------
// Fahrzeuge desselben Anbieters mit gleicher normalisierter Kennung: jüngster Stand gewinnt (bei Gleichstand direkte Position vor Stationsersatz).
// Gleiche Kennung an weit entfernter Position (> 300 m) bleibt als Prüffall erhalten.
export function dedupeVehicles(vehicles, { reuseDistanceM = 300 } = {}) {
  const groups = new Map();
  for (const v of vehicles) {
    const key = `${v.operator}|${normalizeId(v.rawId)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  }
  const out = [], stats = { duplicates: 0, prefixVariants: 0, reusedIds: 0 };
  for (const [, g] of groups) {
    if (g.length === 1) { out.push(g[0]); continue; }
    g.sort((a, b) => (b.reportedAt ?? 0) - (a.reportedAt ?? 0) || (a.geoOrigin === 'vehicle' ? -1 : 1));
    const kept = [g[0]];
    for (let i = 1; i < g.length; i++) {
      const v = g[i];
      const near = kept.some(k => validLatLon(k.lat, k.lon) && validLatLon(v.lat, v.lon) ? haversineM(k.lat, k.lon, v.lat, v.lon) <= reuseDistanceM : true);
      if (near) { stats.duplicates++; if (String(v.rawId) !== String(g[0].rawId)) stats.prefixVariants++; }
      else { v.reusedId = true; stats.reusedIds++; kept.push(v); }
    }
    out.push(...kept);
  }
  return { vehicles: out, stats };
}

const stationNameKey = (s) => String(s || '').toLowerCase().replace(/ß/g, 'ss').replace(/[äöü]/g, c => ({ ä: 'ae', ö: 'oe', ü: 'ue' }[c])).replace(/[^a-z0-9]+/g, ' ').trim();
// Stationen desselben Anbieters aus mehreren Quellen: gleiche Kennung oder gleicher Name innerhalb 60 m → höchste Quellenpriorität / jüngster Stand gewinnt
export function dedupeStations(stations) {
  const byId = new Map(); const out = []; let dup = 0;
  for (const s of stations) {
    const key = `${s.operator}|${s.id}`;
    if (byId.has(key)) { dup++; const prev = byId.get(key); if ((s.priority ?? 2) < (prev.priority ?? 2) || ((s.reportedAt ?? 0) > (prev.reportedAt ?? 0) && (s.priority ?? 2) === (prev.priority ?? 2))) Object.assign(prev, s); continue; }
    const nameKey = stationNameKey(s.name);
    const twin = nameKey && out.find(o => o.operator === s.operator && stationNameKey(o.name) === nameKey && validLatLon(o.lat, o.lon) && validLatLon(s.lat, s.lon) && haversineM(o.lat, o.lon, s.lat, s.lon) <= 60);
    if (twin) { dup++; if ((s.priority ?? 2) < (twin.priority ?? 2)) Object.assign(twin, s); continue; }
    byId.set(key, s); out.push(s);
  }
  return { stations: out, duplicates: dup };
}

// ---------- Aggregation ----------
export function emptyStats() {
  return { total: 0, available: 0, reserved: 0, disabled: 0, batteryKnown: 0, lowBattery: 0, rangeKnown: 0, lowRange: 0, stationVehicles: 0, geoStation: 0, posStale: 0,
    stations: 0, stationsInstalled: 0, stationsRenting: 0, stationsEmpty: 0, stationsFull: 0, stationPhysical: 0, stationBookable: 0, stationDocks: 0 };
}
export function addVehicle(st, v, { chargeThreshold = 20, rangeThreshold = 5 } = {}) {
  st.total++;
  if (!v.reserved && !v.disabled) st.available++;
  if (v.reserved) st.reserved++;
  if (v.disabled) st.disabled++;
  if (v.batteryPct != null) { st.batteryKnown++; if (v.batteryPct < chargeThreshold) st.lowBattery++; }
  if (v.rangeKm != null) { st.rangeKnown++; if (v.rangeKm < rangeThreshold) st.lowRange++; }
  if (v.geoOrigin === 'station') st.geoStation++;
  if (v.positionAgeMs != null && v.positionAgeMs > DELAYED_MS) st.posStale++;
}
export function addStation(st, s, countVehicles) {
  st.stations++;
  if (s.installed !== false) st.stationsInstalled++;
  if (s.installed !== false && s.renting !== false) st.stationsRenting++;
  const phys = s.physicalAvailable ?? 0;
  st.stationPhysical += phys; st.stationBookable += s.bookable ?? 0; st.stationDocks += s.docksAvailable ?? 0;
  if (s.installed !== false && s.renting !== false && (s.bookable ?? 0) === 0) st.stationsEmpty++;
  if (s.installed !== false && s.returning !== false && s.docksAvailable === 0) st.stationsFull++;
  if (countVehicles) { st.stationVehicles += phys; st.total += phys; st.available += s.bookable ?? 0; if (s.disabled) st.disabled += s.disabled; }
}
export const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
