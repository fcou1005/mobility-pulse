#!/usr/bin/env node
// Sammler: ruft alle Quellen ab, normalisiert, ordnet Gemeinden zu, dedupliziert, aggregiert.
// Schreibt data/latest.json, data/status.json, data/history/YYYY-MM-DD.json, data/snapshot/*.json, data/boundaries-active.json
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as C from '../lib/pulse-core.js';
import * as T from '../lib/pulse-track.js';
import { gzipSync, gunzipSync } from 'node:zlib';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const now = Date.now();
const log = (...a) => console.error('[collect]', ...a);
const CONCURRENCY = +process.env.CONCURRENCY || 8;
const TIMEOUT = +process.env.FETCH_TIMEOUT || 20000;
const HISTORY_DAYS = +process.env.HISTORY_DAYS || 30;
const UA = 'mobility-pulse/1.0 (+https://github.com/fcou1005/mobility-pulse)';

const catalog = JSON.parse(await readFile(process.env.SOURCES_FILE || path.join(DATA, 'sources.json'), 'utf8'));
const manual = JSON.parse(await readFile(path.join(ROOT, 'data', 'sources-manual.json'), 'utf8'));
const boundariesPath = process.env.BOUNDARIES || path.join(DATA, 'boundaries.json');
let index = null, boundaries = null;
if (existsSync(boundariesPath)) {
  boundaries = JSON.parse(await readFile(boundariesPath, 'utf8'));
  index = C.buildMunicipalityIndex(boundaries);
  log(`Gemeindegrenzen: ${boundaries.features.length}`);
} else log('WARNUNG: keine Gemeindegrenzen – Ortszuordnung entfällt');
const prev = existsSync(path.join(DATA, 'latest.json')) ? JSON.parse(await readFile(path.join(DATA, 'latest.json'), 'utf8')) : null;
const prevSources = new Map((prev?.sources || []).map(s => [s.id, s]));

// ---------- HTTP ----------
const authHeaders = new Map(); // host → headers
const corsByUrl = new Map(); // url → Access-Control-Allow-Origin
async function fetchJson(url, { retry = 1 } = {}) {
  const t0 = Date.now();
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    try {
      const headers = { 'user-agent': UA, accept: 'application/json' };
      for (const [host, h] of authHeaders) if (url.includes(host)) Object.assign(headers, h);
      const r = await fetch(url, { signal: ctrl.signal, headers, redirect: 'follow' });
      clearTimeout(timer);
      corsByUrl.set(url, r.headers.get('access-control-allow-origin'));
      let json = null, error = null;
      if (r.ok) { try { json = await r.json(); } catch (e) { error = 'kein JSON'; } }
      return { ok: r.ok && !!json, status: r.status, json, error, latencyMs: Date.now() - t0 };
    } catch (e) {
      clearTimeout(timer);
      if (attempt < retry) continue;
      return { ok: false, status: 0, json: null, error: e.name === 'AbortError' ? 'Timeout' : (e.cause?.code || e.message), latencyMs: Date.now() - t0 };
    }
  }
}

// MOBIDROM: OAuth-Dienstzugang (Client-Credentials laut öffentlicher Datensatzbeschreibung)
async function setupMobidrom(sources) {
  const s = sources.find(x => x.auth?.type === 'oauth_client_credentials' && x.auth.datasetUrl);
  if (!s) return;
  try {
    const name = s.notesDataset;
    const r = await fetchJson(`https://www.mobilitaetsdaten.nrw/api/ckan/api/3/action/package_show?id=${encodeURIComponent(name)}`);
    const notes = r.json?.result?.notes || '';
    const secret = (notes.match(/Client Secret:\*\*\s*`?([^`\s<]+)/i) || notes.match(/client_secret[=:]\s*`?([^`\s<&'"]+)/i) || [])[1];
    const tokenUrl = s.auth.tokenUrl || (notes.match(/https:\/\/www\.mobilitaetsdaten\.nrw\/keycloak\/realms\/[^\s`'")]+token/) || [])[0];
    const clientId = s.auth.clientId || (notes.match(/Client ID:\*\*\s*`?([\w-]+)/i) || [])[1] || 'gbfs-api';
    if (!secret || !tokenUrl) { log('MOBIDROM: Zugangsdaten nicht in CKAN-Notes gefunden'); return; }
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret });
    const tr = await fetch(tokenUrl, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA } });
    const tok = await tr.json().catch(() => null);
    if (!tr.ok || !tok?.access_token) { log('MOBIDROM: Token fehlgeschlagen', tr.status); return; }
    authHeaders.set('mobilitaetsdaten.nrw/api/systemadapter', { authorization: `Bearer ${tok.access_token}` });
    log('MOBIDROM: Token erhalten');
  } catch (e) { log('MOBIDROM: ', e.message); }
}

// Header-Zugänge (z. B. DB API Marketplace) aus Umgebungsvariablen
for (const [key, cfg] of Object.entries(catalog.auth_sources || {})) {
  if (!cfg.env.every(e => process.env[e])) continue;
  authHeaders.set(cfg.host, Object.fromEntries(Object.entries(cfg.headers).map(([h, e]) => [h, process.env[e]])));
  log(`Zugang ${key}: aktiv`);
}

// Manifest / Sammelindex in Einzelsysteme auflösen
async function expandSource(src) {
  if (src.api !== 'gbfs') return [src];
  if (!/manifest\.json$|systems\.json$/.test(src.url)) return [src];
  const r = await fetchJson(src.url);
  if (!r.ok) return [{ ...src, _probe: r }];
  const d = r.json?.data;
  const out = [];
  const datasets = d?.datasets || d?.systems || (Array.isArray(r.json?.systems) ? r.json.systems : null) || (Array.isArray(r.json) ? r.json : null);
  if (!datasets) return [src];
  for (const ds of datasets) {
    const sysId = ds.system_id || ds.id || ds.system || ds.name;
    const url = ds.versions?.slice().sort((a, b) => String(b.version).localeCompare(String(a.version)))?.[0]?.url || ds.url || ds.gbfs_url || ds.auto_discovery_url;
    if (!url) continue;
    out.push({ ...src, id: `${src.id}:${sysId}`, name: `${src.name} · ${sysId}`, url, parent: src.id });
  }
  return out.length ? out : [src];
}

async function pool(items, worker, n = CONCURRENCY) {
  const results = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; results[k] = await worker(items[k], k); } }));
  return results;
}

// ---------- Abruf ----------
const active = catalog.sources.filter(s => !s.disabled);
await setupMobidrom(active);
const expanded = (await pool(active, expandSource, 6)).flat();
log(`Quellen: ${active.length} → ${expanded.length} Systeme`);

const results = await pool(expanded, async (src) => {
  try {
    if (src._probe) return { src, sys: null, probe: src._probe };
    const sys = src.api === 'citybikes' ? await C.readCityBikesNetwork(src, fetchJson, { now }) : await C.readGbfsSystem(src, fetchJson, { now });
    return { src, sys };
  } catch (e) { return { src, sys: null, error: e.message }; }
});

// ---------- Auswertung ----------
const allVehicles = [], allStations = [], sourceOut = [], snapshots = [];
const munis = new Map(); // ags → {name,state,pop,bbox}
const typeOrder = C.VEHICLE_TYPES;
const chargeThreshold = 20, rangeThreshold = 5;

for (const { src, sys, probe, error } of results) {
  const rec = { id: src.id, parent: src.parent || null, operator: src.operator, name: src.name, api: src.api, url: src.url, directories: src.directories, priority: src.priority ?? 2, candidate: !!src.candidate,
    status: 'error', httpStatus: probe?.status ?? sys?.httpStatus ?? null, latencyMs: probe?.latencyMs ?? sys?.latencyMs ?? null, errors: [], license: null, version: sys?.version || null,
    feedAgeMs: null, vehicleFeedAgeMs: null, stationFeedAgeMs: null, fingerprint: null, quality: null, counts: {}, municipalities: [], vehicleTypes: [], checkedAt: now };
  if (!sys) { rec.errors = [error || probe?.error || `HTTP ${probe?.status}`]; rec.status = probe?.status === 404 || probe?.status === 410 ? 'gone' : probe?.status === 401 || probe?.status === 403 ? 'auth' : 'error'; sourceOut.push(rec); continue; }
  rec.errors = sys.errors;
  if (src.parent) { const guess = C.operatorFromName(`${sys.systemInfo?.operator || ''} ${sys.systemInfo?.name || ''} ${src.id.split(':').pop()}`, manual.operator_aliases); rec.operator = src.operator = guess || sys.systemInfo?.operator || sys.systemInfo?.name || src.operator; }
  rec.license = sys.systemInfo?.licenseId || sys.systemInfo?.licenseUrl || src.license || null;
  rec.systemName = sys.systemInfo?.name || null; rec.systemOperator = sys.systemInfo?.operator || null; rec.timezone = sys.systemInfo?.timezone || null;
  rec.feeds = Object.keys(sys.feeds || {});
  if (sys.httpStatus === 404 || sys.httpStatus === 410) rec.status = 'gone';
  else if (sys.httpStatus === 401 || sys.httpStatus === 403) rec.status = 'auth';
  else if (!sys.vehicles.length && !sys.stations.length) rec.status = sys.errors.length ? 'error' : 'empty';
  else {
    const vAge = sys.feedAges.vehicle_status ?? sys.feedAges.free_bike_status ?? null;
    const sAge = sys.feedAges.station_status ?? null;
    const ages = [vAge, sAge].filter(a => a != null);
    rec.vehicleFeedAgeMs = vAge; rec.stationFeedAgeMs = sAge;
    rec.feedAgeMs = ages.length ? Math.max(...ages) : (sys.lastUpdated != null ? now - sys.lastUpdated : null);
    rec.status = C.freshness(rec.feedAgeMs);
  }
  rec.fingerprint = C.fingerprint(sys);
  const q = C.qualityScore(sys, now); rec.quality = q.score;
  const prevRec = prevSources.get(src.id);
  rec.sourceChanged = !!(prevRec?.fingerprint && prevRec.fingerprint !== rec.fingerprint);
  rec.vehicleTypes = [...new Set([...Object.values(sys.vehicleTypes).map(t => t.type), ...sys.vehicles.map(v => v.type)])];

  const counts = { vehicles: sys.vehicles.length, stations: sys.stations.length, assigned: 0, unassigned: 0, outside: 0, missing: 0, repaired: 0, stationFallback: 0, posStale: 0 };
  const agsSet = new Set();
  const usable = rec.status === 'live' || rec.status === 'delayed';
  for (const v of sys.vehicles) {
    if (v.geoRepaired) counts.repaired++;
    if (v.geoOrigin === 'station') counts.stationFallback++;
    if (v.positionAgeMs != null && v.positionAgeMs > C.DELAYED_MS) counts.posStale++;
    if (v.geoStatus === 'missing') { counts.missing++; continue; }
    if (v.geoStatus === 'outside') { counts.outside++; continue; }
    const m = index ? C.assignMunicipality(index, v.lat, v.lon) : null;
    if (!m) { counts.unassigned++; continue; }
    counts.assigned++; agsSet.add(m.ags);
    if (usable && !munis.has(m.ags)) munis.set(m.ags, { ags: m.ags, name: m.name, state: m.state, pop: m.pop });
    if (usable) allVehicles.push({ ...v, operator: src.operator, sourceId: src.id, priority: src.priority ?? 2, ags: m.ags, feedAgeMs: rec.vehicleFeedAgeMs });
  }
  for (const s of sys.stations) {
    if (!C.validLatLon(s.lat, s.lon)) continue;
    const m = index ? C.assignMunicipality(index, s.lat, s.lon) : null;
    if (!m) continue;
    agsSet.add(m.ags);
    if (usable && !munis.has(m.ags)) munis.set(m.ags, { ags: m.ags, name: m.name, state: m.state, pop: m.pop });
    if (usable) allStations.push({ ...s, operator: src.operator, sourceId: src.id, priority: src.priority ?? 2, ags: m.ags, hasVehicleList: !!sys.vehicleListPresent, feedAgeMs: rec.stationFeedAgeMs });
  }
  rec.counts = counts; rec.municipalities = [...agsSet];
  if (usable && !agsSet.size && (counts.outside || counts.unassigned)) rec.status = 'foreign';
  sourceOut.push(rec);

  // Momentaufnahme für Quellen, die der Browser nicht direkt lesen kann (Zugangsdaten), nur aktuelle/verzögerte
  const corsOk = (() => { const h = corsByUrl.get(src.url); return h === '*' || (h && h.length > 0); })();
  rec.cors = corsOk;
  if ((src.auth || !corsOk) && usable) {
    snapshots.push({ id: src.id, at: now, feedAgeMs: rec.feedAgeMs, operator: src.operator,
      vehicles: sys.vehicles.filter(v => v.geoStatus === 'ok').map(v => [+v.lat.toFixed(5), +v.lon.toFixed(5), v.type, (v.reserved ? 1 : 0) | (v.disabled ? 2 : 0), v.batteryPct != null ? Math.round(v.batteryPct) : null, v.rangeKm != null ? +v.rangeKm.toFixed(1) : null]),
      stations: sys.stations.filter(s => C.validLatLon(s.lat, s.lon)).map(s => [+s.lat.toFixed(5), +s.lon.toFixed(5), s.name, s.physicalAvailable, s.bookable, s.docksAvailable, s.renting ? 1 : 0, s.returning ? 1 : 0]) });
  }
}

// ---------- Preise und Betriebszonen (GBFS system_pricing_plans / geofencing_zones) ----------
const pricing = [], zonesIndex = [];
await mkdir(path.join(DATA, 'zones'), { recursive: true });
const zonesIdxFile = path.join(DATA, 'zones', 'index.json');
const prevZonesIdx = existsSync(zonesIdxFile) ? JSON.parse(await readFile(zonesIdxFile, 'utf8')) : null;
const refreshStatic = !prevZonesIdx || (now - (prevZonesIdx.at || 0)) > 23 * 3600e3 || process.env.REFRESH_STATIC === '1';
if (!refreshStatic) {
  log(`Preise/Zonen: Stand von ${new Date(prevZonesIdx.at).toISOString()} behalten (Aktualisierung täglich)`);
  for (const z of prevZonesIdx.zones || []) { const rec = sourceOut.find(x => x.id === z.sourceId); if (rec) rec.zones = { count: z.count, ...z.kinds }; }
} else {
for (const f of await readdir(path.join(DATA, 'zones')).catch(() => [])) if (f.endsWith('.json')) await rm(path.join(DATA, 'zones', f));
const firstLang = (o) => o == null ? null : Array.isArray(o) ? (o.find(x => x?.language === 'de') || o[0])?.text ?? null : typeof o === 'object' ? (o.de ?? o.en ?? Object.values(o)[0] ?? null) : o;
await pool(results.filter(r => r.sys && r.sys.feeds && ['live', 'delayed'].includes(sourceOut.find(x => x.id === r.src.id)?.status)), async ({ src, sys }) => { try {
  const rec = sourceOut.find(x => x.id === src.id);
  if (sys.feeds.system_pricing_plans) {
    const r = await fetchJson(sys.feeds.system_pricing_plans);
    const plans = r.json?.data?.plans || [];
    const out = plans.slice(0, 12).map(pl => {
      const perMin = (pl.per_min_pricing || []).map(x => ({ start: C.num(x.start), rate: C.num(x.rate), interval: C.num(x.interval), end: C.num(x.end) }));
      const perKm = (pl.per_km_pricing || []).map(x => ({ start: C.num(x.start), rate: C.num(x.rate), interval: C.num(x.interval), end: C.num(x.end) }));
      return { id: pl.plan_id, name: firstLang(pl.name), currency: pl.currency || null, unlock: C.num(pl.price), perMin, perKm, taxable: C.bool(pl.is_taxable), desc: String(firstLang(pl.description) || '').slice(0, 240), surge: C.bool(pl.surge_pricing) };
    });
    if (out.length) { pricing.push({ sourceId: src.id, operator: src.operator, municipalities: rec.municipalities, plans: out, at: now }); rec.pricingPlans = out.length; }
  }
  if (sys.feeds.geofencing_zones) {
    const r = await fetchJson(sys.feeds.geofencing_zones);
    const fc = r.json?.data?.geofencing_zones;
    if (fc?.features?.length) {
      const feats = fc.features.filter(f => f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon')).flatMap(f => { try { return [zoneFeature(f)]; } catch { return []; } });
      function zoneFeature(f) {
        const rules = (f.properties?.rules || []).map(ru => ({ rideAllowed: C.bool(ru.ride_allowed ?? ru.ride_start_allowed), rideThrough: C.bool(ru.ride_through_allowed), endAllowed: C.bool(ru.ride_end_allowed), maxSpeed: C.num(ru.maximum_speed_kph), parking: C.bool(ru.station_parking) }));
        const round = (c) => Array.isArray(c[0]) ? c.map(round) : [+(+c[0]).toFixed(5), +(+c[1]).toFixed(5)];
        const coords = round(f.geometry.coordinates);
        if (JSON.stringify(coords).includes('null')) throw new Error('ungültige Koordinaten');
        return { type: 'Feature', properties: { name: firstLang(f.properties?.name) || null, rules, start: f.properties?.start || null, end: f.properties?.end || null }, geometry: { type: f.geometry.type, coordinates: coords } };
      }
      const doc = JSON.stringify({ type: 'FeatureCollection', sourceId: src.id, operator: src.operator, at: now, globalRules: (r.json?.data?.global_rules || []).map(ru => ({ rideAllowed: C.bool(ru.ride_allowed ?? ru.ride_start_allowed), rideThrough: C.bool(ru.ride_through_allowed), maxSpeed: C.num(ru.maximum_speed_kph) })), features: feats });
      if (doc.length <= 3e6) {
        const file = `${src.id.replace(/[^\w.-]+/g, '_')}.json`;
        await writeFile(path.join(DATA, 'zones', file), doc);
        const kinds = { noRide: feats.filter(f => f.properties.rules.some(ru => ru.rideAllowed === false)).length, noThrough: feats.filter(f => f.properties.rules.some(ru => ru.rideThrough === false)).length, slow: feats.filter(f => f.properties.rules.some(ru => ru.maxSpeed != null)).length, noEnd: feats.filter(f => f.properties.rules.some(ru => ru.endAllowed === false)).length };
        zonesIndex.push({ sourceId: src.id, operator: src.operator, municipalities: rec.municipalities, file, count: feats.length, bytes: doc.length, kinds, at: now });
        rec.zones = { count: feats.length, ...kinds };
      } else rec.zones = { count: feats.length, tooLarge: true };
    }
  }
  } catch (e) { log(`Preise/Zonen ${src.id}: ${e.message}`); }
}, 6);
await writeFile(path.join(DATA, 'pricing.json'), JSON.stringify({ at: now, plans: pricing }));
await writeFile(zonesIdxFile, JSON.stringify({ at: now, zones: zonesIndex }));
log(`Preise: ${pricing.length} Quellen · Zonen: ${zonesIndex.length} Quellen`);
}

// ---------- Konsistenz: Alternativ-Feeds desselben Systems und mehrere Quellen je Anbieter × Gemeinde ----------
const consistency = { at: now, systems: [], pairs: [] };
{
  const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };
  // Positionsabgleich: Anteil der Fahrzeuge aus A, zu denen in B ein Fahrzeug innerhalb von 10 m steht (Kennungen können umgeschlüsselt sein)
  const posMatch = (A, B) => {
    const grid = new Map(); const k = (lat, lon) => `${Math.round(lat * 1000)}:${Math.round(lon * 1000)}`;
    for (const w of B.values()) { if (!C.validLatLon(w.lat, w.lon)) continue; const key = k(w.lat, w.lon); if (!grid.has(key)) grid.set(key, []); grid.get(key).push(w); }
    let n = 0, hit = 0;
    for (const v of A.values()) {
      if (!C.validLatLon(v.lat, v.lon)) continue; n++;
      const la = Math.round(v.lat * 1000), lo = Math.round(v.lon * 1000); let ok = false;
      for (let dx = -1; dx <= 1 && !ok; dx++) for (let dy = -1; dy <= 1 && !ok; dy++) for (const w of grid.get(`${la + dx}:${lo + dy}`) || []) if (C.haversineM(v.lat, v.lon, w.lat, w.lon) <= 10) { ok = true; break; }
      if (ok) hit++;
    }
    return n ? +(hit / n).toFixed(3) : null;
  };
  const judge = (countDiff, idOverlap, med, pm) => {
    const idsOk = idOverlap != null && idOverlap >= 0.9 && (med ?? 0) <= 25;
    const posOk = pm != null && pm >= 0.9;
    if (countDiff <= 0.05 && (idsOk || posOk)) return 'consistent';
    if (countDiff <= 0.15 && ((idOverlap ?? 0) >= 0.7 || (pm ?? 0) >= 0.7)) return 'minor';
    if ((idOverlap ?? 0) < 0.2 && (pm ?? 0) < 0.2 && countDiff > 0.3) return 'disjoint';
    return 'divergent';
  };

  const altTargets = results.filter(r => r.sys && r.src.altUrls?.length && ['live', 'delayed'].includes(sourceOut.find(x => x.id === r.src.id)?.status));
  await pool(altTargets, async ({ src, sys }) => {
    const altUrl = src.altUrls[0];
    try {
      const alt = await C.readGbfsSystem({ ...src, url: altUrl }, fetchJson, { now });
      const rec = sourceOut.find(x => x.id === src.id);
      const kind = hostOf(altUrl) === hostOf(src.url) ? 'version' : (/mobidata-bw|mobilitaetsdaten\.nrw/.test(hostOf(src.url)) ? 'land_vs_betreiber' : 'betreiber_vs_land');
      const entry = { sourceId: src.id, operator: src.operator, kind, primary: { url: src.url, version: sys.version, vehicles: sys.vehicles.length, available: sys.vehicles.filter(v => !v.disabled && !v.reserved).length, stations: sys.stations.length, feedAgeMs: rec?.feedAgeMs ?? null },
        alt: { url: altUrl, version: alt.version, httpStatus: alt.httpStatus, vehicles: alt.vehicles.length, available: alt.vehicles.filter(v => !v.disabled && !v.reserved).length, stations: alt.stations.length, feedAgeMs: (() => { const a = [alt.feedAges.vehicle_status ?? alt.feedAges.free_bike_status, alt.feedAges.station_status].filter(x => x != null); return a.length ? Math.max(...a) : null; })(), errors: alt.errors.slice(0, 2) } };
      if (!alt.vehicles.length && !alt.stations.length) { entry.verdict = 'alt_unreachable'; consistency.systems.push(entry); rec.consistency = entry.verdict; return; }
      const A = new Map(sys.vehicles.map(v => [C.normalizeId(v.rawId), v])), B = new Map(alt.vehicles.map(v => [C.normalizeId(v.rawId), v]));
      let common = 0; const dists = [];
      for (const [id, v] of A) { const w = B.get(id); if (!w) continue; common++; if (C.validLatLon(v.lat, v.lon) && C.validLatLon(w.lat, w.lon)) dists.push(C.haversineM(v.lat, v.lon, w.lat, w.lon)); }
      const union = A.size + B.size - common;
      dists.sort((a, b) => a - b);
      entry.idOverlap = union ? +(common / union).toFixed(3) : null;
      entry.medianDistM = dists.length ? Math.round(dists[Math.floor(dists.length / 2)]) : null;
      entry.p90DistM = dists.length ? Math.round(dists[Math.floor(dists.length * 0.9)]) : null;
      const n1 = entry.primary.vehicles, n2 = entry.alt.vehicles;
      const countDiff = Math.max(n1, n2) ? Math.abs(n1 - n2) / Math.max(n1, n2) : 0;
      entry.countDiff = +countDiff.toFixed(3);
      entry.posMatch = posMatch(A, B);
      entry.idsRekeyed = (entry.idOverlap ?? 0) < 0.2 && (entry.posMatch ?? 0) >= 0.7;
      if (!n1 && !n2) { // reine Stationssysteme: Stationszahl vergleichen
        const s1 = entry.primary.stations, s2 = entry.alt.stations; const sd = Math.max(s1, s2) ? Math.abs(s1 - s2) / Math.max(s1, s2) : 0;
        entry.countDiff = +sd.toFixed(3); entry.stationsOnly = true; entry.verdict = sd <= 0.05 ? 'consistent' : sd <= 0.15 ? 'minor' : 'divergent';
      } else entry.verdict = judge(countDiff, entry.idOverlap, entry.medianDistM, entry.posMatch);
      consistency.systems.push(entry); rec.consistency = entry.verdict;
    } catch (e) { consistency.systems.push({ sourceId: src.id, operator: src.operator, alt: { url: altUrl }, verdict: 'error', error: e.message }); }
  }, 6);
  // Mehrere Quellen je Anbieter × Gemeinde (vor der Dublettenbereinigung)
  const bySrc = new Map(); // `${op}|${ags}` → Map(sourceId → Set(ids))
  for (const v of allVehicles) { const k = `${v.operator}|${v.ags}`; if (!bySrc.has(k)) bySrc.set(k, new Map()); const m = bySrc.get(k); if (!m.has(v.sourceId)) m.set(v.sourceId, new Map()); m.get(v.sourceId).set(C.normalizeId(v.rawId), v); }
  for (const [k, m] of bySrc) {
    if (m.size < 2) continue;
    const [op, ags] = k.split('|');
    const srcs = [...m.entries()].filter(([, ids]) => ids.size >= 20).sort((a, b) => b[1].size - a[1].size);
    for (let i = 0; i < srcs.length; i++) for (let j = i + 1; j < srcs.length; j++) {
      const [idA, A] = srcs[i], [idB, B] = srcs[j];
      let common = 0; const dists = [];
      for (const [id, v] of A) { const w = B.get(id); if (!w) continue; common++; if (C.validLatLon(v.lat, v.lon) && C.validLatLon(w.lat, w.lon)) dists.push(C.haversineM(v.lat, v.lon, w.lat, w.lon)); }
      dists.sort((a, b) => a - b);
      const union = A.size + B.size - common;
      const pm = posMatch(A, B);
      consistency.pairs.push({ operator: op, ags, a: { sourceId: idA, vehicles: A.size }, b: { sourceId: idB, vehicles: B.size }, common, idOverlap: +(common / union).toFixed(3), posMatch: pm, idsRekeyed: common / union < 0.2 && (pm ?? 0) >= 0.7, medianDistM: dists.length ? Math.round(dists[Math.floor(dists.length / 2)]) : null, countDiff: +(Math.abs(A.size - B.size) / Math.max(A.size, B.size)).toFixed(3) });
    }
  }
  for (const pr of consistency.pairs) pr.verdict = judge(pr.countDiff, pr.idOverlap, pr.medianDistM, pr.posMatch);
  await writeFile(path.join(DATA, 'consistency.json'), JSON.stringify(consistency));
  const vc = {}; for (const e of consistency.systems) vc[e.verdict] = (vc[e.verdict] || 0) + 1;
  log(`Konsistenz: ${consistency.systems.length} Alternativ-Feeds ${JSON.stringify(vc)} · ${consistency.pairs.length} Quellenpaare je Anbieter×Gemeinde`);
}

// Dedupe über alle Quellen (je Anbieter)
allVehicles.sort((a, b) => a.priority - b.priority);
const dv = C.dedupeVehicles(allVehicles);
const ds = C.dedupeStations(allStations);
log(`Fahrzeuge ${allVehicles.length} → ${dv.vehicles.length} (Dubletten ${dv.stats.duplicates}, Kennungs-Wiederverwendung ${dv.stats.reusedIds}); Stationen ${allStations.length} → ${ds.stations.length}`);

// Aggregation: Gemeinde × Anbieter × Fahrzeugart
const groups = C.aggregateGroups(dv.vehicles, ds.stations, { chargeThreshold, rangeThreshold });
const groupsOut = {};
for (const [k, v] of groups) groupsOut[k] = v;

// Gemeinde-Zusammenfassung (Anbieter vor Ort, Bestand) und Totals
const muniOut = {};
for (const [ags, m] of munis) {
  const ops = {};
  for (const [k, st] of groups) { const [a, op, ty] = k.split('|'); if (a !== ags) continue; ops[op] ??= { total: 0, available: 0, types: {} }; ops[op].total += st.total; ops[op].available += st.available; ops[op].types[ty] = st.total; }
  muniOut[ags] = { ...m, operators: ops };
}
const totals = {};
for (const [k, st] of groups) { const ty = k.split('|')[2]; totals[ty] ??= C.emptyStats(); for (const f of Object.keys(st)) totals[ty][f] += st[f]; }

// Datenlücken (bekannte Betreiber ohne öffentliche Daten) prüfen
const gaps = [];
for (const gap of catalog.known_gaps || []) {
  const r = gap.probe_url ? await fetchJson(gap.probe_url) : null;
  gaps.push({ ...gap, probeStatus: r?.status ?? null, probeOk: !!r?.ok, checkedAt: now });
}

const statusCounts = {};
for (const s of sourceOut) statusCounts[s.status] = (statusCounts[s.status] || 0) + 1;
const latest = {
  at: now, generatedAt: new Date(now).toISOString(), runMs: Date.now() - now, catalogGeneratedAt: catalog.generatedAt,
  boundaries: boundaries ? { count: boundaries.features.length, attribution: boundaries.attribution, source: boundaries.source } : null,
  counts: { sources: sourceOut.length, byStatus: statusCounts, vehiclesRaw: allVehicles.length, vehicles: dv.vehicles.length, stationsRaw: allStations.length, stations: ds.stations.length, municipalities: munis.size, groups: groups.size },
  dedupe: { ...dv.stats, stationDuplicates: ds.duplicates },
  thresholds: { chargeThreshold, rangeThreshold },
  sources: sourceOut, municipalities: muniOut, groups: groupsOut, totals, gaps,
};
await mkdir(path.join(DATA, 'history'), { recursive: true });
await mkdir(path.join(DATA, 'snapshot'), { recursive: true });
await writeFile(path.join(DATA, 'latest.json'), JSON.stringify(latest));
await writeFile(path.join(DATA, 'status.json'), JSON.stringify({ at: now, generatedAt: latest.generatedAt, runMs: latest.runMs, counts: latest.counts, byStatus: statusCounts }));

// Momentaufnahmen (nur Zugangs-Quellen)
for (const f of await readdir(path.join(DATA, 'snapshot')).catch(() => [])) if (f.endsWith('.json')) await rm(path.join(DATA, 'snapshot', f));
for (const snap of snapshots) await writeFile(path.join(DATA, 'snapshot', `${snap.id.replace(/[^\w.-]+/g, '_')}.json`), JSON.stringify(snap));

// Verlauf (spaltenweise je Tag)
const day = new Date(now).toISOString().slice(0, 10);
const histFile = path.join(DATA, 'history', `${day}.json`);
const hist = existsSync(histFile) ? JSON.parse(await readFile(histFile, 'utf8')) : { day, t: [], series: {} };
const FIELDS = ['total', 'available', 'disabled', 'lowBattery', 'batteryKnown', 'stations', 'stationsEmpty', 'stationBookable'];
const n = hist.t.length;
hist.t.push(now);
for (const key of Object.keys(hist.series)) if (!groups.has(key)) for (const f of FIELDS) hist.series[key][f].push(null);
for (const [key, st] of groups) {
  if (!hist.series[key]) { hist.series[key] = {}; for (const f of FIELDS) hist.series[key][f] = new Array(n).fill(null); }
  for (const f of FIELDS) hist.series[key][f].push(st[f]);
}
for (const ty of Object.keys(totals)) { const key = `DE||${ty}`; if (!hist.series[key]) { hist.series[key] = {}; for (const f of FIELDS) hist.series[key][f] = new Array(n).fill(null); } for (const f of FIELDS) hist.series[key][f].push(totals[ty][f]); }
hist.fields = FIELDS;
await writeFile(histFile, JSON.stringify(hist));
// alte Tage entfernen
const days = (await readdir(path.join(DATA, 'history'))).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
for (const f of days.slice(0, Math.max(0, days.length - HISTORY_DAYS))) await rm(path.join(DATA, 'history', f));
await writeFile(path.join(DATA, 'history', 'index.json'), JSON.stringify({ days: (await readdir(path.join(DATA, 'history'))).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 10)).sort(), fields: FIELDS, updatedAt: now }));

// ---------- Fahrzeug-Verfolgung (Fahrten, Standzeiten, Tausch, Umsetzungen, Sperren, Zellen, Stationsquote, Zuverlässigkeit) ----------
{
  await mkdir(path.join(DATA, 'track'), { recursive: true });
  await mkdir(path.join(DATA, 'events'), { recursive: true });
  await mkdir(path.join(DATA, 'cells'), { recursive: true });
  const stateFile = path.join(DATA, 'track', 'state.json.gz');
  let prevState = null;
  if (existsSync(stateFile)) { try { prevState = JSON.parse(gunzipSync(await readFile(stateFile)).toString('utf8')); } catch (e) { log('Track-Zustand unlesbar, Neustart:', e.message); } }
  const tr = T.trackRun(prevState, { vehicles: dv.vehicles, stations: ds.stations, sourceRecs: sourceOut.map(r => ({ id: r.id, status: r.status, latencyMs: r.latencyMs })), now });
  await writeFile(stateFile, gzipSync(JSON.stringify(tr.state)));
  const evFile = path.join(DATA, 'events', `${tr.day}.json`);
  const evDoc = T.mergeHourly(existsSync(evFile) ? JSON.parse(await readFile(evFile, 'utf8')) : null, tr.hourly, { day: tr.day, at: now, dt: tr.dt, srcModes: tr.srcModes });
  await writeFile(evFile, JSON.stringify(evDoc));
  const cellsDir = path.join(DATA, 'cells');
  const cellFile = path.join(cellsDir, `${tr.day}.json`);
  const cellDoc = T.mergeCells(existsSync(cellFile) ? JSON.parse(await readFile(cellFile, 'utf8')) : null, tr.cells, muniOut, tr.day, { dt: tr.dt, hour: tr.hour });
  await writeFile(cellFile, JSON.stringify(cellDoc));
  // je Bundesland aufgeteilt (kleinere Downloads)
  await mkdir(path.join(cellsDir, tr.day), { recursive: true });
  for (const [st, doc] of Object.entries(cellDoc.states)) await writeFile(path.join(cellsDir, tr.day, `${st}.json`), JSON.stringify({ day: tr.day, state: st, bandMin: cellDoc.bandMin, bandRuns: cellDoc.bandRuns, fields: 'start,end,present,reloc,start×6,present×6,end×6', munis: doc }));
  // Flotte für die Disposition (Ops): alle deduplizierten Fahrzeuge und Stationen je Bundesland, mit Standzeit
  {
    await mkdir(path.join(DATA, 'ops'), { recursive: true });
    for (const f of await readdir(path.join(DATA, 'ops')).catch(() => [])) if (f.endsWith('.json')) await rm(path.join(DATA, 'ops', f));
    const TYPES = C.VEHICLE_TYPES;
    const byState = new Map();
    const S = (st) => { if (!byState.has(st)) byState.set(st, { ops: [], munis: [], vehicles: [], stations: [] }); return byState.get(st); };
    const idx = (arr, v) => { let i = arr.indexOf(v); if (i < 0) { i = arr.length; arr.push(v); } return i; };
    for (const v of dv.vehicles) {
      const st = muniOut[v.ags]?.state; if (!st) continue; const o = S(st);
      const e = tr.state.v[T.vehicleKey(v.operator, v.rawId)];
      const idleMin = e ? Math.round((now - e[8]) / 60e3) : null;
      o.vehicles.push([+v.lat.toFixed(5), +v.lon.toFixed(5), idx(o.ops, v.operator), TYPES.indexOf(v.type), (v.reserved ? 1 : 0) | (v.disabled ? 2 : 0), v.batteryPct != null ? Math.round(v.batteryPct) : null, v.rangeKm != null ? +v.rangeKm.toFixed(1) : null, idleMin, idx(o.munis, v.ags)]);
    }
    for (const s of ds.stations) {
      const st = muniOut[s.ags]?.state; if (!st) continue; const o = S(st);
      o.stations.push([+s.lat.toFixed(5), +s.lon.toFixed(5), idx(o.ops, s.operator), String(s.name || '').slice(0, 50), s.bookable ?? 0, s.docksAvailable ?? null, s.capacity ?? null, idx(o.munis, s.ags), s.renting === false ? 0 : 1, s.returning === false ? 0 : 1, s.physicalAvailable ?? 0]);
    }
    let bytes = 0;
    for (const [st, o] of byState) { const doc = JSON.stringify({ at: now, state: st, types: TYPES, vehicleFields: 'lat,lon,op,type,flags(1=reserviert,2=gesperrt),akku%,reichweiteKm,standzeitMin,gemeinde', stationFields: 'lat,lon,op,name,buchbar,freiePlaetze,kapazitaet,gemeinde,vermietend,rueckgabe,physisch', ...o }); bytes += doc.length; await writeFile(path.join(DATA, 'ops', `${st}.json`), doc); }
    log(`Ops-Flotte: ${byState.size} Länder, ${(bytes / 1e6).toFixed(1)} MB`);
  }
  await writeFile(path.join(DATA, 'idle.json'), JSON.stringify({ at: now, buckets: ['<2 h', '2–8 h', '8–24 h', '1–2 Tage', '>2 Tage'], groups: tr.idle }));
  // Lange Standzeiten: je Gemeinde max. 400 Punkte (gleichmäßig ausgedünnt)
  const byAgs = new Map(); for (const p of tr.idleLong) { if (!byAgs.has(p.ags)) byAgs.set(p.ags, []); byAgs.get(p.ags).push(p); }
  const longOut = []; for (const [, list] of byAgs) { list.sort((a, b) => b.hours - a.hours); const step = Math.max(1, Math.ceil(list.length / 400)); for (let i = 0; i < list.length; i += step) longOut.push(list[i]); }
  await writeFile(path.join(DATA, 'idle-long.json'), JSON.stringify({ at: now, total: tr.idleLong.length, points: longOut }));
  await writeFile(path.join(DATA, 'stations-quota.json'), JSON.stringify({ at: now, days: 7, fields: ['ags', 'operator', 'name', 'lat', 'lon', 'runs', 'emptyRuns', 'fullRuns'], stations: T.stationQuota(tr.state) }));
  await writeFile(path.join(DATA, 'reliability.json'), JSON.stringify({ at: now, days: 7, sources: T.reliability(tr.state) }));
  // Ereignis- und Zellendateien: 30 bzw. 14 Tage behalten
  for (const f of (await readdir(path.join(DATA, 'events'))).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(0, -HISTORY_DAYS)) await rm(path.join(DATA, 'events', f));
  const cellDays = (await readdir(cellsDir)).filter(f => /^\d{4}-\d{2}-\d{2}(\.json)?$/.test(f)).sort();
  for (const f of cellDays.filter(f => !f.endsWith('.json')).slice(0, -14)) await rm(path.join(cellsDir, f), { recursive: true, force: true });
  for (const f of cellDays.filter(f => f.endsWith('.json')).slice(0, -3)) await rm(path.join(cellsDir, f));
  await writeFile(path.join(DATA, 'events', 'index.json'), JSON.stringify({ days: (await readdir(path.join(DATA, 'events'))).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 10)).sort(), cellDays: (await readdir(cellsDir)).filter(f => /^\d{4}-\d{2}-\d{2}$/.test(f)).sort(), updatedAt: now, first: tr.first }));
  const ev = [...tr.hourly.values()].reduce((a, h) => { a.start += h.start.reduce((x, y) => x + y, 0); a.end += h.end.reduce((x, y) => x + y, 0); a.reloc += h.reloc.reduce((x, y) => x + y, 0); a.swap += h.swap.reduce((x, y) => x + y, 0); return a; }, { start: 0, end: 0, reloc: 0, swap: 0 });
  log(`Verfolgung: ${Object.keys(tr.state.v).length} Kennungen im Zustand${tr.first ? ' (erster Lauf)' : ` · Fahrten begonnen ${ev.start}, beendet ${ev.end}, Umsetzungen ${ev.reloc}, Akkutausch ${ev.swap}`} · lange Standzeiten ${tr.idleLong.length}`);
}

// Aktive Gemeindegrenzen fürs Dashboard
if (boundaries) {
  const activeAgs = new Set(munis.keys());
  const feats = boundaries.features.filter(f => activeAgs.has(f.properties.ags));
  await writeFile(path.join(DATA, 'boundaries-active.json'), JSON.stringify({ type: 'FeatureCollection', attribution: boundaries.attribution, license: boundaries.license, generatedAt: latest.generatedAt, features: feats }));
  log(`Aktive Gemeinden: ${feats.length}`);
}
log(`fertig in ${((Date.now() - now) / 1000).toFixed(1)} s · Status:`, JSON.stringify(statusCounts));
