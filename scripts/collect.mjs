#!/usr/bin/env node
// Sammler: ruft alle Quellen ab, normalisiert, ordnet Gemeinden zu, dedupliziert, aggregiert.
// Schreibt data/latest.json, data/status.json, data/history/YYYY-MM-DD.json, data/snapshot/*.json, data/boundaries-active.json
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as C from '../lib/pulse-core.js';
import * as T from '../lib/pulse-track.js';
import * as OPS from '../lib/pulse-ops.js';
import * as E from '../lib/pulse-econ.js';
import * as R from '../lib/pulse-report.js';
import * as FE from '../lib/pulse-flowest.js';
import * as V from '../lib/pulse-coverage.js';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHmac, randomBytes } from 'node:crypto';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const now = Date.now();
const log = (...a) => console.error('[collect]', ...a);
const CONCURRENCY = +process.env.CONCURRENCY || 8;
const TIMEOUT = +process.env.FETCH_TIMEOUT || 20000;
const MAX_BYTES = +process.env.MAX_BYTES || 40e6; // Obergrenze je Antwort
const HISTORY_DAYS = +process.env.HISTORY_DAYS || 30;
const UA = 'mobility-pulse/1.0 (+https://github.com/fcou1005/mobility-pulse)';

// Verfolgungszustand: mit TRACK_DIR (privater Cache des Workflows) gesalzene HMAC-Schlüssel und kein out/track mehr;
// ohne TRACK_DIR wie bisher (out/track, nachrechenbarer Hash) – so läuft der alte Workflow unverändert weiter.
const TRACK_DIR = process.env.TRACK_DIR ? path.resolve(process.env.TRACK_DIR) : null;
if (TRACK_DIR && (TRACK_DIR + path.sep).startsWith(path.resolve(DATA) + path.sep)) { console.error('[collect] TRACK_DIR liegt im veröffentlichten Datenverzeichnis – Abbruch'); process.exit(2); }
let hmac = null, keyId = null;
if (TRACK_DIR) {
  await mkdir(TRACK_DIR, { recursive: true });
  const saltFile = path.join(TRACK_DIR, 'salt');
  let salt = existsSync(saltFile) ? (await readFile(saltFile, 'utf8')).trim() : '';
  if (!/^[0-9a-f]{64}$/.test(salt)) { salt = randomBytes(32).toString('hex'); await writeFile(saltFile, salt + '\n', { mode: 0o600 }); log('Track-Salt neu erzeugt'); }
  const key = Buffer.from(salt, 'hex');
  hmac = (s) => T.keyFromDigest(createHmac('sha256', key).update(s).digest());
  keyId = hmac('#mobility-pulse-key-check'); // passt der Zustand zum Salt? (sonst wären alle Kennungen „neu“ → Scheinfahrten)
}
const vkey = (operator, rawId) => T.vehicleKey(operator, rawId, hmac);

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
const authRules = []; // { host, path, headers }: Zugangsdaten nur an genau diesen Host (und Pfadpräfix)
const authFor = (url) => { let u; try { u = new URL(url); } catch { return null; } const r = authRules.find(a => a.host === u.host && (!a.path || u.pathname.startsWith(a.path))); return r ? r.headers : null; };
const corsByUrl = new Map(); // url → Access-Control-Allow-Origin
// Antwort mit Obergrenze lesen (C.readLimited); der Timeout-Timer läuft bis zum Ende des Lesens
async function fetchJson(url, { retry = 1 } = {}) {
  const t0 = Date.now();
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    try {
      let target = url, r;
      for (let hop = 0; ; hop++) {
        const auth = authFor(target);
        const headers = { 'user-agent': UA, accept: 'application/json', ...(auth || {}) };
        // mit Zugangsdaten Weiterleitungen selbst prüfen: nur zum selben Host folgen
        r = await fetch(target, { signal: ctrl.signal, headers, redirect: auth ? 'manual' : 'follow' });
        if (!auth || r.status < 300 || r.status >= 400) break;
        const loc = r.headers.get('location');
        if (!loc) break;
        await r.body?.cancel().catch(() => {});
        const next = new URL(loc, target);
        if (next.host !== new URL(target).host) throw Object.assign(new Error('Weiterleitung mit Zugangsdaten verweigert'), { final: true });
        if (hop >= 5) throw Object.assign(new Error('zu viele Weiterleitungen'), { final: true });
        target = next.href;
      }
      corsByUrl.set(url, r.headers.get('access-control-allow-origin'));
      let json = null, error = null;
      if (r.ok) { try { json = JSON.parse(await C.readLimited(r, MAX_BYTES)); } catch (e) { error = e.message === 'Antwort zu groß' ? e.message : e.name === 'AbortError' ? 'Timeout' : 'kein JSON'; } }
      else await r.body?.cancel().catch(() => {});
      clearTimeout(timer);
      return { ok: r.ok && !!json, status: r.status, json, error, latencyMs: Date.now() - t0 };
    } catch (e) {
      clearTimeout(timer);
      if (attempt < retry && !e.final) continue;
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
    const tr = await fetch(tokenUrl, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA }, redirect: 'error' }); // Geheimnis folgt keiner Weiterleitung
    const tok = await tr.json().catch(() => null);
    if (!tr.ok || !tok?.access_token) { log('MOBIDROM: Token fehlgeschlagen', tr.status); return; }
    authRules.push({ host: new URL(s.url).host, path: '/api/systemadapter', headers: { authorization: `Bearer ${tok.access_token}` } });
    log('MOBIDROM: Token erhalten');
  } catch (e) { log('MOBIDROM: ', e.message); }
}

// Header-Zugänge (z. B. DB API Marketplace) aus Umgebungsvariablen
for (const [key, cfg] of Object.entries(catalog.auth_sources || {})) {
  if (!cfg.env.every(e => process.env[e])) continue;
  authRules.push({ host: cfg.host, path: cfg.path || null, headers: Object.fromEntries(Object.entries(cfg.headers).map(([h, e]) => [h, process.env[e]])) });
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
let allVehicles = [], allStations = [], snapshots = [];
const sourceOut = [];
const ghostKeys = []; // verwaiste Einträge: aus dem Verfolgungszustand entfernen, ohne Ereignis
const munis = new Map(); // ags → {name,state,pop,bbox}
const muniInfo = new Map(); // ags → Eigenschaften aller zugeordneten Gemeinden (zum Neuaufbau nach der Quellen-Dublettenprüfung)
const centroids = new Map(boundaries ? boundaries.features.map(f => [f.properties.ags, C.geomCentroid(f.geometry)]) : []);
const areas = new Map(boundaries ? boundaries.features.map(f => [f.properties.ags, C.geomAreaKm2(f.geometry)]) : []); // km² (vereinfachte Grenzen, ca. ±1 %)
const typeOrder = C.VEHICLE_TYPES;
const chargeThreshold = 20, rangeThreshold = 5;

const operatorBySystem = Object.fromEntries(Object.entries(manual.operator_by_system || {}).filter(([k]) => !k.startsWith('_')));
for (const { src, sys, probe, error } of results) {
  if (operatorBySystem[src.id]) src.operator = operatorBySystem[src.id]; // Marke je System (DB Connect → RegioRad Stuttgart, StadtRAD …)
  const rec = { id: src.id, parent: src.parent || null, operator: src.operator, name: src.name, api: src.api, url: src.url, directories: src.directories, priority: src.priority ?? 2, candidate: !!src.candidate,
    status: 'error', httpStatus: probe?.status ?? sys?.httpStatus ?? null, latencyMs: probe?.latencyMs ?? sys?.latencyMs ?? null, errors: [], license: null, licenseId: null, licenseUrl: null, attribution: null, attributionUrl: null, checks: null, version: sys?.version || null,
    feedAgeMs: null, vehicleFeedAgeMs: null, stationFeedAgeMs: null, fingerprint: null, quality: null, counts: {}, municipalities: [], vehicleTypes: [], checkedAt: now };
  // „weg“: 404/410, bei Direktfeed-Kandidaten auch 400 (Stadt gibt es beim Betreiber nicht)
  const goneHttp = (st) => st === 404 || st === 410 || (src.candidate && st === 400);
  if (!sys) { rec.errors = [error || probe?.error || `HTTP ${probe?.status}`]; rec.status = goneHttp(probe?.status) ? 'gone' : probe?.status === 401 || probe?.status === 403 ? 'auth' : 'error'; sourceOut.push(rec); continue; }
  rec.errors = sys.errors;
  if (src.parent) { const guess = C.operatorFromName(`${sys.systemInfo?.operator || ''} ${sys.systemInfo?.name || ''} ${src.id.split(':').pop()}`, manual.operator_aliases); rec.operator = src.operator = guess || sys.systemInfo?.operator || sys.systemInfo?.name || src.operator; }
  rec.license = sys.systemInfo?.licenseId || sys.systemInfo?.licenseUrl || src.license || null;
  { const l = C.normalizeLicense(sys.systemInfo?.licenseId || src.license || sys.systemInfo?.licenseUrl, sys.systemInfo?.licenseUrl || null); rec.licenseId = l.id; rec.licenseUrl = l.url; }
  rec.attribution = sys.systemInfo?.attribution || null; // Namensnennung (GBFS attribution_organization_name)
  rec.attributionUrl = sys.systemInfo?.attributionUrl || null;
  rec.checks = sys.checks || null; // Basisprüfung (C.checkGbfs), nur GBFS
  rec.systemName = sys.systemInfo?.name || null; rec.systemOperator = sys.systemInfo?.operator || null; rec.timezone = sys.systemInfo?.timezone || null;
  rec.feeds = Object.keys(sys.feeds || {});
  if (goneHttp(sys.httpStatus)) rec.status = 'gone';
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

  for (const id of sys.ghostIds || []) if (id != null) ghostKeys.push(vkey(src.operator, id));
  const counts = { vehicles: sys.vehicles.length, stations: sys.stations.length, assigned: 0, unassigned: 0, outside: 0, missing: 0, repaired: 0, stationFallback: 0, posStale: 0, ghosts: sys.ghosts || 0 };
  // Reichweite je Quelle: Median und Fahrzeuge unter 25 % des 95. Perzentils (Energie-Alarm für Quellen ohne Ladestand)
  { const rg = sys.vehicles.map(v => v.rangeKm).filter(x => x != null).map(x => x * 1000).sort((a, b) => a - b); counts.rangeMedianM = rg.length ? Math.round(rg[Math.floor(rg.length / 2)]) : null; counts.lowRangeRel = rg.length ? rg.filter(x => x < 0.25 * rg[Math.floor(0.95 * (rg.length - 1))]).length : null; }
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
    if (!muniInfo.has(m.ags)) muniInfo.set(m.ags, { ags: m.ags, name: m.name, state: m.state, pop: m.pop });
    if (usable) allVehicles.push({ ...v, operator: src.operator, sourceId: src.id, priority: src.priority ?? 2, ags: m.ags, feedAgeMs: rec.vehicleFeedAgeMs });
  }
  for (const s of sys.stations) {
    if (!C.validLatLon(s.lat, s.lon)) continue;
    const m = index ? C.assignMunicipality(index, s.lat, s.lon) : null;
    if (!m) continue;
    agsSet.add(m.ags);
    if (!muniInfo.has(m.ags)) muniInfo.set(m.ags, { ags: m.ags, name: m.name, state: m.state, pop: m.pop });
    if (usable) allStations.push({ ...s, operator: src.operator, sourceId: src.id, priority: src.priority ?? 2, ags: m.ags, hasVehicleList: !!sys.vehicleListPresent, feedAgeMs: rec.stationFeedAgeMs });
  }
  rec.counts = counts; rec.municipalities = [...agsSet]; rec.countOnly = !sys.vehicleListPresent; // Stationen zählen Fahrzeuge (keine Fahrzeugliste)
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

// Seit über 14 Tagen „weg“ (404/410): eigener Status retired, zählt nicht mehr als Fehler (goneSince aus dem vorigen Stand)
for (const rec of sourceOut) {
  if (rec.status !== 'gone') continue;
  rec.goneSince = prevSources.get(rec.id)?.goneSince ?? now;
  if (now - rec.goneSince > C.RETIRED_MS) rec.status = 'retired';
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
      const cur = typeof pl.currency === 'string' && /^[A-Z]{3}$/.test(pl.currency) ? pl.currency : undefined; // nur ISO-4217-Kürzel, sonst weglassen (Schutz vor eingeschleustem Text)
      return { id: String(pl.plan_id ?? '').slice(0, 80), name: String(firstLang(pl.name) ?? '').slice(0, 120), currency: cur, unlock: C.num(pl.price), perMin, perKm, taxable: C.bool(pl.is_taxable), desc: String(firstLang(pl.description) || '').slice(0, 240), surge: C.bool(pl.surge_pricing) };
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
const prevPricing = existsSync(path.join(DATA, 'pricing.json')) ? JSON.parse(await readFile(path.join(DATA, 'pricing.json'), 'utf8')) : null;
for (const p of prevPricing?.plans || []) for (const x of p.plans || []) if (!/^[A-Z]{3}$/.test(String(x.currency ?? ''))) delete x.currency; // Altbestand ohne Prüfung
await writeFile(path.join(DATA, 'pricing.json'), JSON.stringify({ at: now, plans: pricing }));
// Preisänderungs-Log (180 Tage): je Quelle/Tarif Zeitpunkt, Feld, alt, neu
{
  const f = path.join(DATA, 'pricing-log.json');
  const log0 = existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : { changes: [] };
  const ch = prevPricing ? E.pricingChanges(prevPricing, { plans: pricing }, now) : [];
  const changes = [...(log0.changes || []), ...ch].filter(c => now - c[0] <= 180 * 86400e3);
  await writeFile(f, JSON.stringify({ updatedAt: now, days: 180, fields: ['at', 'sourceId', 'operator', 'planId', 'field', 'old', 'new'], changes }));
  if (ch.length) log(`Preisänderungen: ${ch.length}`);
}
await writeFile(zonesIdxFile, JSON.stringify({ at: now, zones: zonesIndex }));
log(`Preise: ${pricing.length} Quellen · Zonen: ${zonesIndex.length} Quellen`);
}
if (!existsSync(path.join(DATA, 'pricing-log.json'))) await writeFile(path.join(DATA, 'pricing-log.json'), JSON.stringify({ updatedAt: now, days: 180, fields: ['at', 'sourceId', 'operator', 'planId', 'field', 'old', 'new'], changes: [] }));

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

// ---------- Quellen-Dubletten: Zählquellen ohne Fahrzeugliste (CityBikes), deren Stationen ≤ 30 m neben gleichnamigen Stationen einer stärkeren Quelle liegen ----------
// z. B. CityBikes „stadtrad-stuttgart“ = RegioRad Stuttgart (MobiData BW). Die Kopie bleibt in sources sichtbar (status duplicate), zählt aber nirgends.
const dupOf = new Map(); // sourceId → Quelle, die stattdessen zählt
{
  const recOf = new Map(sourceOut.map(r => [r.id, r]));
  const cp = C.findSourceCopies(allStations, sourceOut.filter(r => r.status === 'live' || r.status === 'delayed').map(r => ({ id: r.id, priority: r.priority, directories: r.directories, countOnly: r.countOnly })));
  const root = (id) => { const seen = new Set(); while (cp.has(id) && !seen.has(id)) { seen.add(id); id = cp.get(id).of; } return id; };
  for (const [id, c] of cp) {
    const r = recOf.get(id), of = root(id), o = recOf.get(of);
    dupOf.set(id, of); r.feedStatus = r.status; r.status = 'duplicate'; r.duplicateOf = of; r.duplicateShare = c.share;
    if (o?.quality != null && r.quality != null && r.quality >= o.quality) r.quality = Math.max(0, o.quality - 1); // Kopie nie besser bewertet als das Original
  }
  if (dupOf.size) log(`Quellen-Dubletten: ${[...dupOf].map(([a, b]) => `${a} → ${b}`).join(', ')}`);
}
allVehicles = allVehicles.filter(v => !dupOf.has(v.sourceId));
allStations = allStations.filter(s => !dupOf.has(s.sourceId));
snapshots = snapshots.filter(s => !dupOf.has(s.id));
for (const x of [...allVehicles, ...allStations]) if (!munis.has(x.ags)) munis.set(x.ags, muniInfo.get(x.ags));

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
  muniOut[ags] = { ...m, c: centroids.get(ags) || null, areaKm2: areas.get(ags) ?? null, operators: ops }; // c = [lat, lon] Flächenschwerpunkt, areaKm2 aus den Grenzen
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
let runEv = null; // Ereignisse dieses Laufs (für runs.json)
for (const s of sourceOut) statusCounts[s.status] = (statusCounts[s.status] || 0) + 1;
// Fehler-Zähler: retired (> 14 Tage weg) und duplicate (Kopie einer anderen Quelle) sind keine Fehler
const FAILING = ['error', 'gone', 'auth', 'unknown'];
const failing = FAILING.reduce((a, k) => a + (statusCounts[k] || 0), 0);
// Fehler nach Ursache (Quellen mit Status error/gone/auth/unknown): timeout, http404, http429, noJson, tooLarge, tls, dns, connection, redirect, noFeeds, other
const errorCauses = {};
for (const r of sourceOut) { if (!FAILING.includes(r.status)) continue; r.errorCause = C.errorCause(r.errors, r.httpStatus); errorCauses[r.errorCause] = (errorCauses[r.errorCause] || 0) + 1; }
const latest = {
  at: now, generatedAt: new Date(now).toISOString(), runMs: Date.now() - now, catalogGeneratedAt: catalog.generatedAt,
  boundaries: boundaries ? { count: boundaries.features.length, attribution: boundaries.attribution, source: boundaries.source } : null,
  counts: { sources: sourceOut.length, byStatus: statusCounts, vehiclesRaw: allVehicles.length, vehicles: dv.vehicles.length, stationsRaw: allStations.length, stations: ds.stations.length, municipalities: munis.size, groups: groups.size, failing, errorCauses, retired: statusCounts.retired || 0, duplicates: statusCounts.duplicate || 0 },
  dedupe: { ...dv.stats, stationDuplicates: ds.duplicates, sourceDuplicates: dupOf.size },
  thresholds: { chargeThreshold, rangeThreshold },
  sources: sourceOut, municipalities: muniOut, groups: groupsOut, totals, gaps,
};
await mkdir(path.join(DATA, 'history'), { recursive: true });
await mkdir(path.join(DATA, 'snapshot'), { recursive: true });
await writeFile(path.join(DATA, 'latest.json'), JSON.stringify(latest));
await writeFile(path.join(DATA, 'status.json'), JSON.stringify({ at: now, generatedAt: latest.generatedAt, runMs: latest.runMs, counts: latest.counts, byStatus: statusCounts }));

// Obergrenzen je Lauf prüfen (Gemeinden mit Eintrag in reference.json → obergrenzen, liegt auf main im Checkout): Läufe ab 90 % der Grenze
// gesamt und je Anbieter, dazu je Tag das Maximum; 30 Tage (caps-log.json, Format in lib/pulse-report.js capsLogUpdate)
try {
  const refFile = process.env.REFERENCE_FILE || path.join(ROOT, 'data', 'reference.json');
  const ref = existsSync(refFile) ? JSON.parse(await readFile(refFile, 'utf8')) : null;
  if (ref?.obergrenzen?.length) {
    const f = path.join(DATA, 'caps-log.json');
    const prevLog = existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : null;
    const caps = R.capsCheck(ref, groupsOut, { ags: 'DE', asOf: now });
    const doc = R.capsLogUpdate(prevLog, caps, { at: now, dt: prev?.at ? now - prev.at : null, days: 30 });
    await writeFile(f, JSON.stringify(doc));
    const over = caps.flatMap(c => [c, ...c.operators].filter(x => x.status === 'over').map(x => `${c.ort}${x.op ? ` ${x.op}` : ''} ${x.total}/${x.limit}`));
    if (over.length) log(`Obergrenzen überschritten: ${over.join(', ')}`);
  }
} catch (e) { log(`Obergrenzen-Protokoll: ${e.message}`); }

// Zonen-Beobachtung: Umrisse privat aus dem Secret ZONE_WATCH (GeoJSON, nie veröffentlicht), Bestand je Zone × Anbieter × Art
// → zone-watch.json (Läufe 2 Tage, Tageswerte 30 Tage; Format in lib/pulse-report.js zoneLogUpdate)
if (process.env.ZONE_WATCH) {
  try {
    const zones = R.parseZoneWatch(process.env.ZONE_WATCH);
    // Gemeinde der Zone (falls nicht angegeben): die häufigste Gemeinde der Fahrzeuge darin
    for (const z of zones) if (!z.ags) { const n = new Map(); for (const v of dv.vehicles) if (v.ags && Number.isFinite(v.lat) && R.zoneContains(z, v.lon, v.lat)) n.set(v.ags, (n.get(v.ags) || 0) + 1); z.ags = [...n].sort((a, b) => b[1] - a[1])[0]?.[0] || null; }
    if (zones.length) {
      const f = path.join(DATA, 'zone-watch.json');
      const prevZ = existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : null;
      const counts = R.zoneCounts(zones, dv.vehicles);
      const agsOf = new Map(zones.map(z => [z.id, z.ags]));
      const doc = R.zoneLogUpdate(prevZ, zones, counts, { at: now, carryZero: (zone, op, ty) => (groupsOut[`${agsOf.get(zone)}|${op}|${ty}`]?.total || 0) > 0 });
      await writeFile(f, JSON.stringify(doc));
      log(`Zonen-Beobachtung: ${zones.map(z => `${z.name} ${[...counts].filter(([k]) => k.startsWith(`${z.id}|`)).reduce((s, [, c]) => s + c[0], 0)}`).join(', ')}`);
    } else log('Zonen-Beobachtung: ZONE_WATCH ohne gültige Umrisse');
  } catch (e) { log(`Zonen-Beobachtung: ${e.message}`); }
}

// Momentaufnahmen (nur Zugangs-Quellen)
for (const f of await readdir(path.join(DATA, 'snapshot')).catch(() => [])) if (f.endsWith('.json')) await rm(path.join(DATA, 'snapshot', f));
for (const snap of snapshots) await writeFile(path.join(DATA, 'snapshot', `${snap.id.replace(/[^\w.-]+/g, '_')}.json`), JSON.stringify(snap));

// ---------- Fahrzeug-Verfolgung: Zustand lesen (ggf. auf gesalzene Schlüssel umziehen) und Lauf auswerten ----------
// Vor dem Verlauf, damit die Tagesdatei das Lauf-Flag (Lücke) mitführt.
const readState = async (f) => { if (!existsSync(f)) return null; try { return JSON.parse(gunzipSync(await readFile(f)).toString('utf8')); } catch (e) { log('Track-Zustand unlesbar, Neustart:', e.message); return null; } };
const stateFile = TRACK_DIR ? path.join(TRACK_DIR, 'state.json.gz') : path.join(DATA, 'track', 'state.json.gz');
let prevState = await readState(stateFile);
// ungesalzener Zustand im Cache oder anderer Salt: wie fehlend behandeln (Umzug aus out/track bzw. Neustart)
if (TRACK_DIR && prevState && (!prevState.salted || prevState.keyId !== keyId)) { log('Track-Zustand passt nicht zum Salt – verworfen'); prevState = null; }
let migrated = false;
if (TRACK_DIR && !prevState) {
  const old = await readState(path.join(DATA, 'track', 'state.json.gz'));
  if (old?.v && !old.salted) { const mig = T.migrateState(old, dv.vehicles, (op, id) => T.vehicleKey(op, id), vkey); prevState = mig.state; migrated = true; log(`Track-Zustand umgezogen: ${mig.moved} Fahrzeuge übernommen, ${mig.dropped} verworfen (Lauf zählt keine Ereignisse)`); }
}
if (prevState?.v) for (const k of ghostKeys) delete prevState.v[k]; // verschwinden still, keine Abholung
// Umzugslauf zählt nichts: verworfene alte Einträge (ohne aktuelle Kennung nicht umschlüsselbar) würden sonst Fahrtenden ohne Beginn erzeugen
const tr = T.trackRun(prevState, { vehicles: dv.vehicles, stations: ds.stations, sourceRecs: sourceOut.map(r => ({ id: r.id, status: r.status, feedStatus: r.feedStatus || null, latencyMs: r.latencyMs })), now, hmac, noEvents: migrated });
if (keyId) tr.state.keyId = keyId;
if (tr.gap) log(migrated ? 'Umzugslauf – Ereignisse dieses Laufs zählen nicht' : `Lücke: ${Math.round(tr.dt / 60e3)} Min seit dem letzten Lauf – Ereignisse dieses Laufs zählen nicht`);

// Verlauf (spaltenweise je Tag); f je Lauf: 1 = zählt, 0 = Lauf nach Lücke (Vertrag 5/6), null = unbekannt (ältere Läufe)
const day = T.dayOf(now); // Tagesschnitt wie Ereignisse/Zellen in Europe/Berlin (bis 01.11.2026 in UTC)
const histFile = path.join(DATA, 'history', `${day}.json`);
const hist = existsSync(histFile) ? JSON.parse(await readFile(histFile, 'utf8')) : { day, t: [], series: {} };
const FIELDS = ['total', 'available', 'disabled', 'lowBattery', 'batteryKnown', 'stations', 'stationsEmpty', 'stationBookable', 'stationsEmptyDock'];
const n = hist.t.length;
hist.t.push(now);
hist.f = hist.f || new Array(n).fill(null); hist.f.push(tr.gap ? 0 : 1);
const serOf = (key) => { const ser = (hist.series[key] ??= {}); for (const f of FIELDS) ser[f] ??= new Array(n).fill(null); return ser; }; // neue Felder in alten Tagesdateien mit null auffüllen
for (const key of Object.keys(hist.series)) if (!groups.has(key) && !key.startsWith('DE||')) { const ser = serOf(key); for (const f of FIELDS) ser[f].push(null); }
for (const [key, st] of groups) { if (key.startsWith('DE||')) continue; const ser = serOf(key); for (const f of FIELDS) ser[f].push(st[f]); } // DE-Summen nur einmal (unten aus totals), sonst doppelt je Lauf
for (const key of Object.keys(hist.series)) if (key.startsWith('DE||') && !totals[key.slice(4)]) { const ser = serOf(key); for (const f of FIELDS) ser[f].push(null); }
for (const ty of Object.keys(totals)) { const ser = serOf(`DE||${ty}`); for (const f of FIELDS) ser[f].push(totals[ty][f]); }
hist.fields = FIELDS;
await writeFile(histFile, JSON.stringify(hist));
// alte Tage entfernen
const days = (await readdir(path.join(DATA, 'history'))).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
for (const f of days.slice(0, Math.max(0, days.length - HISTORY_DAYS))) await rm(path.join(DATA, 'history', f));
const histDays = (await readdir(path.join(DATA, 'history'))).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 10)).sort();
await writeFile(path.join(DATA, 'history', 'index.json'), JSON.stringify({ days: histDays, fields: FIELDS, updatedAt: now }));
// Tagesmittel über mehrere Tage (Vertrag 6): je Schlüssel und Tag [available, total, disabled, lowBattery, Läufe]; Läufe mit Flag 0 nicht im Mittel.
// Frühere Tage werden aus der vorhandenen daily.json übernommen, nur der aktuelle Tag (und fehlende) neu gerechnet.
{
  const DAILY = ['available', 'total', 'disabled', 'lowBattery', 'stations', 'stationsEmptyDock'];
  const dailyFile = path.join(DATA, 'history', 'daily.json');
  const prevDaily = existsSync(dailyFile) ? JSON.parse(await readFile(dailyFile, 'utf8')) : { days: [], series: {} };
  const useDays = histDays.slice(-30);
  const series = {};
  const dayRows = (h) => { // Map key → Zeile
    const flags = h.f || [], runs = h.t.length;
    let use = [...Array(runs).keys()].filter(i => flags[i] !== 0); if (!use.length) use = [...Array(runs).keys()]; // Tag nur mit Lücken-Läufen: alle
    const out = new Map();
    for (const [key, ser] of Object.entries(h.series)) {
      const idx = use.filter(i => ser.total?.[i] != null); if (!idx.length) continue;
      // Mittel je Feld über die Läufe mit Wert (stationsEmptyDock fehlt in älteren Tagen → null)
      out.set(key, [...DAILY.map(f => { const xs = idx.filter(i => ser[f]?.[i] != null); return xs.length ? +(xs.reduce((a, i) => a + ser[f][i], 0) / xs.length).toFixed(1) : null; }), idx.length]);
    }
    return out;
  };
  for (const d of useDays) {
    const reuse = d !== day && prevDaily.days.includes(d) && JSON.stringify(prevDaily.fields) === JSON.stringify([...DAILY, 'runs']); // nur bei gleichem Feldaufbau übernehmen
    if (reuse) { for (const [key, byDay] of Object.entries(prevDaily.series)) if (byDay[d]) (series[key] ??= {})[d] = byDay[d]; continue; }
    const h = d === day ? hist : JSON.parse(await readFile(path.join(DATA, 'history', `${d}.json`), 'utf8'));
    for (const [key, row] of dayRows(h)) (series[key] ??= {})[d] = row;
  }
  await writeFile(dailyFile, JSON.stringify({ days: useDays, fields: [...DAILY, 'runs'], updatedAt: now, series }));
}

// Abdeckung: Städte laut Anbieter-Website (data/operator-cities.json, liegt auf main im Checkout) gegen Feeds mit und ohne Fahrzeuge
// (coverage.json, Format in lib/pulse-coverage.js); „zuletzt aktiv“ aus daily.json und dem vorigen coverage.json
try {
  const claimsFile = process.env.OPERATOR_CITIES_FILE || path.join(ROOT, 'data', 'operator-cities.json');
  const claims = existsSync(claimsFile) ? JSON.parse(await readFile(claimsFile, 'utf8')) : null;
  const covFile = path.join(DATA, 'coverage.json');
  const prevCov = existsSync(covFile) ? JSON.parse(await readFile(covFile, 'utf8')) : null;
  const dailyFile = path.join(DATA, 'history', 'daily.json');
  const daily = existsSync(dailyFile) ? JSON.parse(await readFile(dailyFile, 'utf8')) : null;
  const cov = V.coverage({ claims, latest, features: boundaries?.features || [], prev: prevCov?.version === V.COVERAGE_VERSION ? prevCov : null, daily, now });
  await writeFile(covFile, JSON.stringify(cov));
  const lost = cov.unresolved.filter(u => u.grund === 'unbekannt').map(u => `${u.op}: ${u.ort}`);
  log(`Abdeckung: ${cov.rows.length} Zeilen, ${Object.entries(cov.totals).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ')}${lost.length ? `; ohne Gemeinde: ${lost.join(', ')}` : ''}`);
} catch (e) { log(`Abdeckung: ${e.message}`); }

// ---------- Fahrzeug-Verfolgung (Fahrten, Standzeiten, Tausch, Umsetzungen, Sperren, Zellen, Stationsquote, Zuverlässigkeit) ----------
{
  await mkdir(path.join(DATA, 'events'), { recursive: true });
  await mkdir(path.join(DATA, 'cells'), { recursive: true });
  if (TRACK_DIR) await rm(path.join(DATA, 'track'), { recursive: true, force: true }); // Zustand liegt privat im Cache, nicht mehr auf dem Datenzweig
  else await mkdir(path.join(DATA, 'track'), { recursive: true });
  await writeFile(stateFile, gzipSync(JSON.stringify(tr.state)));
  const evFile = path.join(DATA, 'events', `${tr.day}.json`);
  const evDoc = T.mergeHourly(existsSync(evFile) ? JSON.parse(await readFile(evFile, 'utf8')) : null, tr.hourly, { day: tr.day, at: now, dt: tr.dt, srcModes: tr.srcModes, gap: tr.gap });
  await writeFile(evFile, JSON.stringify(evDoc));
  // Gruppen-Ereignisse (≥ T.GROUP_MIN = 4 Fahrzeuge eines Anbieters zusammen ausgebracht/eingesammelt): dauerhaft je Monat in
  // groups/<JJJJ-MM>.json (Monat nach Europe/Berlin, nie gekürzt) mit Verzeichnis groups/index.json; groups.json (30 Tage) bleibt als
  // Rückfall für Briefing/Signale und ältere Seitenstände. Erster Lauf mit Monatsdateien übernimmt die Ereignisse aus groups.json.
  {
    const rows = (tr.groups || []).map(T.groupRow);
    const gf = path.join(DATA, 'groups.json');
    const gd = existsSync(gf) ? JSON.parse(await readFile(gf, 'utf8')) : { events: [] };
    gd.fields = T.GROUP_FIELDS;
    gd.events.push(...rows);
    gd.events = gd.events.filter(e => now - e[0] <= 30 * 86400e3);
    gd.updatedAt = now;
    await writeFile(gf, JSON.stringify(gd));
    const gDir = path.join(DATA, 'groups'), gIdxFile = path.join(gDir, 'index.json');
    await mkdir(gDir, { recursive: true });
    const gIdx = existsSync(gIdxFile) ? JSON.parse(await readFile(gIdxFile, 'utf8')) : null;
    const add = gIdx ? rows : gd.events; // Dubletten (gleicher Lauf, Art, Anbieter, Ort) fallen in mergeGroupMonths weg
    const touched = [...new Set(add.map(r => T.dayOf(r[0]).slice(0, 7)))];
    const prev = {}; for (const m of touched) { const f = path.join(gDir, `${m}.json`); prev[m] = existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : null; }
    const changed = T.mergeGroupMonths(prev, add, { at: now });
    for (const [m, doc] of Object.entries(changed)) await writeFile(path.join(gDir, `${m}.json`), JSON.stringify(doc));
    const months = (await readdir(gDir)).filter(f => /^\d{4}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 7)).sort();
    const counts = {}; let first = gIdx?.first ?? null, last = gIdx?.last ?? null;
    for (const m of months) {
      const doc = changed[m] || (gIdx?.counts?.[m] != null ? null : JSON.parse(await readFile(path.join(gDir, `${m}.json`), 'utf8')));
      counts[m] = doc ? doc.events.length : gIdx.counts[m];
      if (doc?.events.length) { first = Math.min(first ?? Infinity, doc.events[0][0]); last = Math.max(last ?? -Infinity, doc.events[doc.events.length - 1][0]); }
    }
    await writeFile(gIdxFile, JSON.stringify(T.groupIndex(months, counts, { at: now, first, last })));
    if (tr.groups?.length) log(`Gruppen: ${tr.groups.filter(g => g.kind === 'deploy').length} ausgebracht, ${tr.groups.filter(g => g.kind === 'collect').length} eingesammelt (groups/: ${months.length} Monat${months.length === 1 ? '' : 'e'}, ${Object.values(counts).reduce((a, b) => a + b, 0)} Ereignisse)`);
  }
  { const s = (a) => (a || []).reduce((x, y) => x + (y || 0), 0); runEv = { start: 0, end: 0, rot: 0 }; for (const h of tr.hourly.values()) { runEv.start += s(h.start); runEv.end += s(h.end); runEv.rot += s(h.rot); } }
  // Langzeit-Archiv: Tageswerte je Gemeinde|Anbieter|Art, eine Datei je Monat, wird nie gekürzt
  {
    const arDir = path.join(DATA, 'archive'); await mkdir(arDir, { recursive: true });
    const month = tr.day.slice(0, 7), arFile = path.join(arDir, `${month}.json`);
    const ar = existsSync(arFile) ? JSON.parse(await readFile(arFile, 'utf8')) : { month, days: {} };
    ar.fields = ['flotte_avg', 'fahrten', 'fahrtenden', 'kennungswechsel', 'umsetzungen', 'akkutausch', 'abholungen', 'sperren', 'beobachtet_min'];
    // gestörte Stunden (Lauf nach Lücke, auch Altbestand) zählen weder mit Ereignissen noch mit Beobachtungszeit
    const obsH = E.observedMinutes(evDoc.runs);
    const s = (a) => (a || []).reduce((x, y, h) => x + (obsH[h] > 0 ? (y || 0) : 0), 0);
    const obsMin = obsH.reduce((a, b) => a + b, 0);
    const vminOk = (evDoc.runs || []).every(r => r[1] == null || r[2] === 1 || r[2] === 0);
    const rows = {};
    for (const [k, g] of Object.entries(evDoc.groups || {})) {
      const hs = hist.series[k]?.total?.filter(x => x != null) || [];
      const fleet = vminOk && obsMin > 0 && s(g.vminTot) > 0 ? s(g.vminTot) / obsMin : hs.length ? hs.reduce((a, b) => a + b, 0) / hs.length : null;
      rows[k] = [fleet == null ? null : +fleet.toFixed(1), s(g.start), s(g.end), s(g.rot), s(g.reloc), s(g.swap), s(g.pickup), s(g.disOn), Math.round(obsMin)];
    }
    ar.days[tr.day] = rows; ar.updatedAt = now;
    await writeFile(arFile, JSON.stringify(ar));
    // Index mit Tagen und erstem Tag (Vertrag 7), damit das Dashboard nicht alle Monatsdateien laden muss
    const months = (await readdir(arDir)).filter(f => /^\d{4}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 7)).sort();
    const allDays = []; for (const m of months) { const d = m === month ? ar : JSON.parse(await readFile(path.join(arDir, `${m}.json`), 'utf8')); allDays.push(...Object.keys(d.days || {})); }
    allDays.sort();
    await writeFile(path.join(arDir, 'index.json'), JSON.stringify({ months, fields: ar.fields, days: allDays.length, firstDay: allDays[0] || null, updatedAt: now }));
  }
  const cellsDir = path.join(DATA, 'cells');
  const cellFile = path.join(cellsDir, `${tr.day}.json`);
  const cellDoc = T.mergeCells(existsSync(cellFile) ? JSON.parse(await readFile(cellFile, 'utf8')) : null, tr.cells, muniOut, tr.day, { dt: tr.dt, hour: tr.hour, gap: tr.gap });
  await writeFile(cellFile, JSON.stringify(cellDoc));
  // je Bundesland aufgeteilt (kleinere Downloads)
  await mkdir(path.join(cellsDir, tr.day), { recursive: true });
  for (const [st, doc] of Object.entries(cellDoc.states)) await writeFile(path.join(cellsDir, tr.day, `${st}.json`), JSON.stringify({ day: tr.day, state: st, bandMin: cellDoc.bandMin, bandRuns: cellDoc.bandRuns, fields: 'start,end,present,reloc,start×6,present×6,end×6', munis: doc }));
  // Start-Ziel-Ströme (nur stabile Kennungen; lib/pulse-track.js publishFlows): Tagessumme privat in TRACK_DIR, veröffentlicht wird ein Tag
  // erst nach Tagesende (flows/<Tag>.json, ≥ 2 Fahrten je Zeile, Top 300 je Gemeinde, 30 Tage) – ohne privates Verzeichnis keine Ströme
  if (TRACK_DIR) {
    const flDir = path.join(DATA, 'flows'), rawFile = path.join(TRACK_DIR, 'flows-raw.json.gz');
    await mkdir(flDir, { recursive: true });
    const raw0 = await readState(rawFile);
    if (raw0?.day && raw0.day < tr.day) { const pub = T.publishFlows(raw0, { at: now }); await writeFile(path.join(flDir, `${raw0.day}.json`), JSON.stringify(pub)); log(`Ströme ${raw0.day}: ${pub.flows.length} Zeilen (${pub.total.shown} Fahrten), ${pub.total.below} unter Mindestschwelle, ${pub.total.cut} außerhalb Top ${pub.top}`); }
    const raw = T.mergeFlows(raw0, tr.flows, { day: tr.day, gap: tr.gap, stable: T.stableOps(tr.srcModes, sourceOut) });
    await writeFile(rawFile, gzipSync(JSON.stringify(raw)));
    const flDays = (await readdir(flDir)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    for (const f of flDays.slice(0, -HISTORY_DAYS)) await rm(path.join(flDir, f));
    await writeFile(path.join(flDir, 'index.json'), JSON.stringify({ days: flDays.slice(-HISTORY_DAYS).map(f => f.slice(0, 10)), collecting: raw.day, min: T.FLOW_MIN, top: T.FLOW_TOP, fields: T.FLOW_FIELDS, updatedAt: now }));
    // Geschätzte Ströme für rotierende Kennungen (lib/pulse-flowest.js): je Lauf nur Zählungen je Zelle, privat in TRACK_DIR
    // (flows-est-raw.json.gz, keine Paare); Schätzung erst nach Tagesende → flows-est/<Tag>.json (estimated: true, ≥ 2 erwartete Fahrten,
    // Top 300 je Gemeinde, 500-m-Zellen, Gütekennzahl aus der Validierung an stabilen Kennungen) + flows-est/index.json, 30 Tage
    try {
      const eDir = path.join(DATA, 'flows-est'), eRawFile = path.join(TRACK_DIR, 'flows-est-raw.json.gz'), eIdxFile = path.join(eDir, 'index.json');
      await mkdir(eDir, { recursive: true });
      const er0 = await readState(eRawFile);
      const eIdx0 = existsSync(eIdxFile) ? JSON.parse(await readFile(eIdxFile, 'utf8')) : null;
      let method = eIdx0?.method ?? null, quality = eIdx0?.quality ?? null;
      if (er0?.day && er0.day < tr.day) try { // Fehler hier: Tag entfällt, die Zählung läuft weiter (kein Wiederholen in jedem Lauf)
        const refFile = process.env.REFERENCE_FILE || path.join(ROOT, 'data', 'reference.json');
        const reference = existsSync(refFile) ? JSON.parse(await readFile(refFile, 'utf8')) : null;
        const { doc, learn } = FE.publishEstimate(er0, raw0?.day === er0.day ? raw0 : null, { at: now, reference, factor: +process.env.FLOWS_EST_FACTOR || undefined });
        await writeFile(path.join(eDir, `${er0.day}.json`), JSON.stringify(doc)); er0.learn = learn; method = doc.method; quality = doc.quality;
        const q = doc.quality;
        log(`Ströme geschätzt ${er0.day}: ${doc.flows.length} Zeilen (${doc.total.shown} von ${doc.total.trips} erwarteten Fahrten), L ${JSON.stringify(doc.method.L_m)} m, ${(doc.runtimeMs.total / 1000).toFixed(1)} s (${doc.runtimeMs.perRun} ms je Lauf)${q ? ` · Validierung an stabilen Kennungen: CPC ${q.cpc} (ohne Distanzzerfall ${q.cpcBase}), r ${q.r}, Top-50 ${q.topShare}/${q.topOracle}, Ø ${q.meanKmEst}/${q.meanKmMeas} km` : ' · keine gemessenen Ströme zur Validierung'}`);
      } catch (e) { log(`Ströme geschätzt ${er0.day}: ${e.message}`); }
      const er = FE.mergeEstCounts(er0, tr.est, { day: tr.day, at: now, dt: tr.dt, gap: tr.gap, band: T.bandOf(tr.hour) });
      await writeFile(eRawFile, gzipSync(JSON.stringify(er)));
      const eDays = (await readdir(eDir)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
      for (const f of eDays.slice(0, -HISTORY_DAYS)) await rm(path.join(eDir, f));
      await writeFile(eIdxFile, JSON.stringify(FE.estIndex(eDays.slice(-HISTORY_DAYS).map(f => f.slice(0, 10)), { collecting: er.day, at: now, method, quality })));
    } catch (e) { log(`Ströme geschätzt: ${e.message}`); }
  }
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
      const e = tr.state.v[vkey(v.operator, v.rawId)];
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
  // Umgebung für die Disposition: ÖPNV-Haltepunkte und Abstellflächen aus OpenStreetMap, je Gemeinde.
  // Wenige Gemeinden je Lauf (größte Flotten zuerst), gültig 7 Tage – der Browser muss Overpass dann nicht selbst fragen.
  if (process.env.SKIP_CONTEXT !== '1') {
    const dir = path.join(DATA, 'context'); await mkdir(dir, { recursive: true });
    const idxFile = path.join(dir, 'index.json');
    const cidx = existsSync(idxFile) ? JSON.parse(await readFile(idxFile, 'utf8')) : { munis: {} };
    const byAgs = new Map(); for (const v of dv.vehicles) { if (!v.ags) continue; if (!byAgs.has(v.ags)) byAgs.set(v.ags, []); byAgs.get(v.ags).push(v); }
    const due = (a) => { const m = cidx.munis[a]; if (!m) return true; if (m.failedAt && now - m.failedAt < 6 * 3600e3) return false; return !m.at || now - m.at > 7 * 86400e3; };
    const todo = [...byAgs].filter(([a, l]) => l.length >= 30 && due(a)).sort((a, b) => b[1].length - a[1].length).slice(0, +process.env.CONTEXT_PER_RUN || 2);
    const t0 = Date.now(); const CATS = ['escooter', 'sharing', 'rad', 'official'];
    for (const [ags, list] of todo) {
      if (Date.now() - t0 > 120e3) break;
      const qt = (arr, p) => { const x = arr.slice().sort((a, b) => a - b); return x[Math.floor(p * (x.length - 1))]; };
      const la = list.map(v => v.lat), lo = list.map(v => v.lon);
      const bbox = [qt(la, 0.02) - 0.004, qt(lo, 0.02) - 0.006, qt(la, 0.98) + 0.004, qt(lo, 0.98) + 0.006].map(x => +x.toFixed(4));
      const q = `[out:json][timeout:110][bbox:${bbox.join(',')}];(nwr["amenity"~"^(kick-scooter_parking|small_vehicle_parking|small_electric_vehicle_parking|bicycle_rental|kick-scooter_rental|mobility_hub|bicycle_parking)$"];nwr["small_electric_vehicle"];node["highway"="bus_stop"];node["public_transport"="platform"];node["railway"~"^(tram_stop|station|halt)$"];);out center tags;`;
      let els = null, ep = null;
      for (const url of ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter']) {
        const ctrl = new AbortController(); const tm = setTimeout(() => ctrl.abort(), 120e3);
        try { const r = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: q }), headers: { 'User-Agent': UA }, signal: ctrl.signal }); if (r.ok) { const j = await r.json(); if (Array.isArray(j.elements) && !j.remark) { els = j.elements; ep = url; } } } catch { /* nächster Spiegel */ }
        clearTimeout(tm); if (els) break;
      }
      if (!els) { cidx.munis[ags] = { ...(cidx.munis[ags] || {}), failedAt: now }; log(`Umgebung ${ags}: Overpass ohne Antwort`); continue; }
      const parking = OPS.parkingFromOsm(els).map(p => [+p.lat.toFixed(5), +p.lon.toFixed(5), CATS.indexOf(p.cat), p.cat === 'rad' ? null : (p.name || null)]);
      const transit = OPS.transitFromOsm(els).map(p => [+p.lat.toFixed(5), +p.lon.toFixed(5)]);
      const doc = JSON.stringify({ at: now, ags, bbox, source: 'OpenStreetMap (ODbL) via Overpass', cats: CATS, parkingFields: 'lat,lon,kategorie,name', parking, transit });
      await writeFile(path.join(dir, `${ags}.json`), doc);
      cidx.munis[ags] = { at: now, parking: parking.length, transit: transit.length, bytes: doc.length };
      log(`Umgebung ${ags}: ${parking.length} Abstellflächen, ${transit.length} Haltepunkte (${(doc.length / 1e3).toFixed(0)} kB, ${new URL(ep).host})`);
    }
    await writeFile(idxFile, JSON.stringify(cidx));
  }
  await writeFile(path.join(DATA, 'idle.json'), JSON.stringify({ at: now, buckets: ['<2 h', '2–8 h', '8–24 h', '1–2 Tage', '>2 Tage'], groups: tr.idle }));
  // Lange Standzeiten: je Gemeinde max. 400 Punkte (gleichmäßig ausgedünnt)
  const byAgs = new Map(); for (const p of tr.idleLong) { if (!byAgs.has(p.ags)) byAgs.set(p.ags, []); byAgs.get(p.ags).push(p); }
  const longOut = []; for (const [, list] of byAgs) { list.sort((a, b) => b.hours - a.hours); const step = Math.max(1, Math.ceil(list.length / 400)); for (let i = 0; i < list.length; i += step) longOut.push(list[i]); }
  await writeFile(path.join(DATA, 'idle-long.json'), JSON.stringify({ at: now, total: tr.idleLong.length, points: longOut }));
  await writeFile(path.join(DATA, 'stations-quota.json'), JSON.stringify({ at: now, days: 7, fields: ['ags', 'operator', 'name', 'lat', 'lon', 'runs', 'emptyRuns', 'fullRuns', 'virtual'], stations: T.stationQuota(tr.state) }));
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
// Namensnennung und Lizenzen des Datenstands (DATA-LICENSE.md im Datenzweig)
{
  const md = (x) => String(x ?? '').replace(/[\r\n|]+/g, ' ').replace(/[<>]/g, '').replace(/([\[\]`*_\\])/g, '\\$1').trim(); // Text aus Feeds entschärfen (Markdown/HTML)
  const counted = sourceOut.filter(r => ['live', 'delayed', 'stale'].includes(r.status));
  const byLic = new Map();
  for (const r of counted) { const k = r.licenseId || r.licenseUrl || 'ohne Angabe'; if (!byLic.has(k)) byLic.set(k, []); byLic.get(k).push(r); }
  const lic = [...byLic].sort((a, b) => b[1].length - a[1].length);
  const sa = counted.filter(r => /^CC-BY-SA/.test(r.licenseId || ''));
  const lines = [
    '# Daten und Lizenzen', '',
    `Stand: ${new Date(now).toISOString()} · erzeugt vom Sammler (scripts/collect.mjs) bei jedem Lauf.`, '',
    'Dieser Datenzweig enthält aus offenen Quellen abgeleitete Daten: Bestände, Ereignisse (Fahrten, Umsetzungen, Akkutausch), Zellen, Archiv und Momentaufnahmen. Die Lizenzangaben stammen aus den Feeds (GBFS `system_information`: `license_id`, `license_url`, `attribution_organization_name`) bzw. aus den Verzeichnissen; maßgeblich sind die Bedingungen der jeweiligen Quelle. Je Quelle stehen sie auch in `latest.json` → `sources[]` (`licenseId`, `licenseUrl`, `attribution`, `attributionUrl`).', '',
    '## Grundlagen', '',
    `- Gemeindegrenzen: ${md(boundaries?.attribution || '© GeoBasis-DE / BKG, VG250')} – Lizenz Datenlizenz Deutschland – Namensnennung – Version 2.0 (dl-de/by-2-0, https://www.govdata.de/dl-de/by-2-0).`,
    '- Umgebung (`context/`: ÖPNV-Haltepunkte, Abstellflächen): © OpenStreetMap-Mitwirkende, Open Database License 1.0 (ODbL, https://opendatacommons.org/licenses/odbl/1-0/).',
    '- Verzeichnisse: MobilityData GBFS systems.csv, MobiData BW, MOBIDROM NRW, CityBikes, Betreiber-Direktfeeds.', '',
    '## Quellen nach Lizenz', '',
    `${counted.length} Quellen mit Daten in diesem Stand (Kopien anderer Quellen und nicht erreichbare Quellen ausgenommen).`, '',
    '| Lizenz | Quellen | Namensnennung / Anbieter |', '|---|---|---|',
    ...lic.map(([k, list]) => { const names = [...new Set(list.map(r => r.attribution || r.systemOperator || r.operator).filter(Boolean).map(md))]; const url = list.find(r => r.licenseUrl)?.licenseUrl; return `| ${md(k)}${url && url !== k ? ` (${md(url)})` : ''} | ${list.length} | ${names.slice(0, 25).join(', ')}${names.length > 25 ? ` u. a. (${names.length})` : ''} |`; }),
    '', '## Weitergabe unter gleichen Bedingungen', '',
    sa.length ? `${sa.length} Quellen stehen unter CC BY-SA (${[...new Set(sa.map(r => md(r.operator)))].join(', ')}). Daten, die aus diesen Quellen abgeleitet sind (Bestände, Ereignisse, Zellen, Archiv der betroffenen Gebiete und Anbieter), stehen unter CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/).` : 'In diesem Stand liefert keine Quelle Daten unter CC BY-SA.',
    'Aus OpenStreetMap abgeleitete Datenbankteile (`context/`) stehen unter der ODbL 1.0.',
    '', 'Quellen ohne Lizenzangabe sind oben als „ohne Angabe“ geführt; für sie gelten die Nutzungsbedingungen des jeweiligen Betreibers bzw. Verzeichnisses.', '',
  ];
  await writeFile(path.join(DATA, 'DATA-LICENSE.md'), lines.join('\n'));
}
// Sammler-Monitor: ein Eintrag je Lauf, 7 Tage (Lücken, Ausfälle, Zählungen)
{
  const f = path.join(DATA, 'runs.json');
  const doc = existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : { runs: [] };
  doc.fields = ['at', 'dauer_ms', 'quellen', 'aktuell', 'verzoegert', 'veraltet', 'fehler', 'fahrzeuge', 'stationen', 'fahrten', 'fahrtenden', 'kennungswechsel', 'ausloeser'];
  const st = statusCounts;
  doc.runs.push([now, Date.now() - now, sourceOut.length, st.live || 0, st.delayed || 0, st.stale || 0, failing, dv.vehicles.length, ds.stations.length, runEv?.start ?? null, runEv?.end ?? null, runEv?.rot ?? null, process.env.GITHUB_EVENT_NAME || 'lokal']);
  doc.runs = doc.runs.filter(r => now - r[0] <= 7 * 86400e3).slice(-600);
  await writeFile(f, JSON.stringify(doc));
}
log(`fertig in ${((Date.now() - now) / 1000).toFixed(1)} s · Status:`, JSON.stringify(statusCounts));
