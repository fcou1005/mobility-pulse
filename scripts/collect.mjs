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
import * as FC from '../lib/pulse-forecast.js';
import * as CX from '../lib/pulse-context.js';
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
const HEALTH = { minShare: 0.9 }; // Ausfall-Wächter: „fail“ unter 90 % der üblichen Zahl liefernder Quellen (HEALTH_FILE)
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
const RULE = `${T.METHOD_VERSION}@${String(process.env.GITHUB_SHA || 'lokal').slice(0, 7)}`; // Regelstand je Lauf (events runs[k][3], runs.json)

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
// eigener Befund der Verfolgung in der Feed-Prüfung (sources[].checks wie C.checkGbfs: Fehler zuerst, höchstens 5 Befunde; Quellen ohne Prüfung bekommen eine)
const addCheck = (rec, msg, n = null) => {
  const c = (rec.checks ??= { label: C.CHECKS_LABEL, errors: 0, warnings: 0, items: [] }); const items = c.items || [];
  const k = items.findIndex(x => x.level !== 'error'); items.splice(k < 0 ? items.length : k, 0, { level: 'warning', feed: (rec.feeds || []).includes('vehicle_status') ? 'vehicle_status' : 'free_bike_status', msg, ...(n != null ? { n } : {}) });
  c.items = items.slice(0, 5); c.warnings = (c.warnings || 0) + 1;
};
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
  // Ladestand-Skala (C.batteryScaleCheck): unplausibel → Ladestand dieser Quelle nicht verwendet (Abholung, Akkutausch, Energie), Befund in checks
  if (sys.batteryScale) rec.batteryScale = sys.batteryScale.suspect || sys.batteryScale.derived ? sys.batteryScale : { n: sys.batteryScale.n, p99: sys.batteryScale.p99, suspect: false };
  // Reichweite aus dem Ladestand gerechnet (C.rangeDerivedCheck, M-16): je Fahrzeugtyp km je 100 % und Spanne; derived → nur der Ladestand zählt
  if (sys.rangeCheck?.types?.length) rec.rangeCheck = sys.rangeCheck;
  // Reichweiten-Schwelle relativ zur Quelle (C.rangeLimitCheck): rangeLimitKm = 20 % des 95. Perzentils, wenn dieses < 25 km (null = Standard 5 km);
  // je Fahrzeug in ops/<Land>.json Feld 11 „reichweiteSchwelleKm“, Hinweis in der Feed-Prüfung (checks)
  // Reichweite konstant (C.rangeFlatCheck, Platzhalter wie Donkey Bayern 1 km): für Energie/Akkutausch unbekannt, Feld 12 „reichweiteKonstant“, Befund in checks
  if (sys.rangeFlat?.flat) rec.rangeFlat = sys.rangeFlat;
  if (sys.rangeLimit) { rec.rangeLimitKm = sys.rangeLimit.limitKm; if (sys.rangeLimit.n) rec.rangeLimit = { ...sys.rangeLimit, maxP95Km: C.RANGE_LIMIT.maxP95Km, share: C.RANGE_LIMIT.share }; }
  rec.systemName = sys.systemInfo?.name || null; rec.systemOperator = sys.systemInfo?.operator || null; rec.timezone = sys.systemInfo?.timezone || null;
  rec.feeds = Object.keys(sys.feeds || {});
  // Ausblenden bei niedrigem Akku (C.batteryFloorCheck, Z4): ab 500 Fahrzeugen 0,5-Perzentil p005; hides → Verfolgung zählt Verschwinden bis p005 + 5 als hide
  if (sys.batteryFloor?.p005 != null) { const f = sys.batteryFloor; rec.batteryFloor = { p005: f.p005, p001: f.p001, n: f.n, hides: f.hides }; if (f.hides) addCheck(rec, `Fahrzeuge unter ${f.p005} % Ladestand nicht im Feed (Ausblendung): Verschwinden bis ${f.p005 + T.HIDE_BAND} % zählt nicht als Fahrt`, f.n); }
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
  const counts = { vehicles: sys.vehicles.length, stations: sys.stations.length, assigned: 0, unassigned: 0, outside: 0, missing: 0, repaired: 0, stationFallback: 0, posStale: 0, ghosts: sys.ghosts || 0,
    batteryNative: sys.vehicles.filter(v => v.batteryPct != null && !v.batteryDerived).length }; // Ladestand aus dem Feed (nicht abgeleitet, Skala plausibel)
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
      vehicles: sys.vehicles.filter(v => v.geoStatus === 'ok').map(v => [+v.lat.toFixed(5), +v.lon.toFixed(5), v.type, (v.reserved ? 1 : 0) | (v.disabled ? 2 : 0), v.batteryPct != null && !v.batteryDerived ? Math.round(v.batteryPct) : null, OPS.rangePublic(v)]),
      stations: sys.stations.filter(s => C.validLatLon(s.lat, s.lon)).map(s => [+s.lat.toFixed(5), +s.lon.toFixed(5), s.name, s.physicalAvailable, s.bookable, s.docksAvailable, s.renting ? 1 : 0, s.returning ? 1 : 0]) });
  }
}

// Manifest ausgefallen: Kindquellen tauchen im Lauf gar nicht auf. Aus dem vorigen Stand mit Status error übernehmen (sichtbar, Zuverlässigkeit,
// Verfolgung: Quelle ausgefallen statt „alle Fahrzeuge verschwunden“), höchstens 14 Tage (manifestMissingSince)
{
  const have = new Set(sourceOut.map(r => r.id));
  const failed = new Map(results.filter(r => r.probe && !r.src.parent && /manifest\.json$|systems\.json$/.test(r.src.url || '')).map(r => [r.src.id, r.probe]));
  for (const p of prev?.sources || []) {
    if (!p?.parent || !failed.has(p.parent) || have.has(p.id)) continue;
    const since = p.manifestMissingSince ?? now; if (now - since > C.RETIRED_MS) continue;
    const pr = failed.get(p.parent);
    sourceOut.push({ ...p, status: 'error', feedStatus: undefined, duplicateOf: undefined, duplicateKind: undefined, mirror: undefined, errors: ['Manifest ausgefallen'], httpStatus: pr?.status ?? null, latencyMs: pr?.latencyMs ?? null,
      counts: { vehicles: 0, stations: 0 }, feedAgeMs: null, vehicleFeedAgeMs: null, stationFeedAgeMs: null, checkedAt: now, manifestMissingSince: since, sourceChanged: false });
    have.add(p.id);
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
// Spiegelquellen mit umgeschlüsselten Kennungen (consistency.pairs: idsRekeyed): schwächere Quelle je Gemeinde ganz bzw. räumliche Zwillinge
// verwerfen (lib/pulse-core.js dropMirrorVehicles). Stärke: Priorität, direkte Quelle vor Manifest-Kind (MOBIDROM fiel in 14 von 44 Läufen aus),
// nicht CityBikes, dann Kennung – bewusst ohne Fahrzeugzahl, damit der Sieger nicht von Lauf zu Lauf wechselt.
// Verworfene Kennungen verlassen den Verfolgungszustand still (ghostKeys), sonst zählten sie beim Umstieg als Fahrtbeginne.
let mirrorsOut = []; // bekannte Spiegelpaare für den nächsten Lauf (latest.json → mirrors)
const mirrorInfo = new Map(); // verlierende Quelle → { of: Map(Sieger → n), ags: Set, n, why: Set }
{
  const recOf = new Map(sourceOut.map(r => [r.id, r]));
  const rank = (id) => { const r = recOf.get(id) || {}; return [r.priority ?? 2, r.parent ? 1 : 0, (r.directories || []).includes('citybikes') ? 1 : 0]; };
  const extra = (prev?.mirrors || []).filter(m => recOf.has(m.of) && recOf.has(m.source) && now - (m.seen || 0) <= 7 * 86400e3); // bekannte Paare höchstens 7 Tage ohne neuen Beleg
  const mr = C.dropMirrorVehicles(dv.vehicles, { pairs: consistency.pairs, rank, extra });
  dv.vehicles = mr.vehicles;
  for (const { v, of, why } of mr.dropped) {
    const m = mirrorInfo.get(v.sourceId) || { of: new Map(), ags: new Set(), n: 0, why: new Set(), op: v.operator };
    m.n++; m.of.set(of, (m.of.get(of) || 0) + 1); m.ags.add(v.ags); m.why.add(why); mirrorInfo.set(v.sourceId, m);
    ghostKeys.push(vkey(v.operator, v.rawId));
  }
  dv.stats.mirrorDropped = mr.dropped.length; dv.stats.mirrorWhole = mr.dropped.filter(d => d.why === 'whole').length; dv.stats.mirrorTwins = mr.dropped.filter(d => d.why === 'twin').length;
  // Quelle ganz gespiegelt (kein Fahrzeug übrig): Status duplicate wie bei findSourceCopies (Feed-Status bleibt in feedStatus), sonst nur Angabe mirror
  const left = new Set(dv.vehicles.map(v => v.sourceId));
  for (const [id, m] of mirrorInfo) {
    const r = recOf.get(id); if (!r) continue;
    const of = [...m.of].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
    r.mirror = { of, ofAll: [...m.of.keys()].sort(), dropped: m.n, municipalities: [...m.ags].sort(), how: [...m.why].sort() };
    if (!left.has(id) && r.status !== 'duplicate') { r.feedStatus = r.status; r.status = 'duplicate'; r.duplicateOf = of; r.duplicateKind = 'rekeyed'; r.duplicateShare = null; dupOf.set(id, of); }
  }
  snapshots = snapshots.filter(s => !dupOf.has(s.id));
  const fresh = new Set([...C.mirrorPairs(consistency.pairs, C.compareSources(rank)).known.values()].map(k => `${k.op}|${k.winner}|${k.loser}`));
  mirrorsOut = mr.known.map(k => ({ operator: k.op, of: k.winner, source: k.loser, seen: fresh.has(`${k.op}|${k.winner}|${k.loser}`) ? now : extra.find(e => e.operator === k.op && [e.of, e.source].sort().join('|') === [k.winner, k.loser].sort().join('|'))?.seen ?? now }));
  if (mr.dropped.length) log(`Spiegelquellen (umgeschlüsselt): ${mr.dropped.length} Fahrzeuge verworfen (${dv.stats.mirrorWhole} ganze Quelle je Gemeinde, ${dv.stats.mirrorTwins} Zwillinge) aus ${mirrorInfo.size} Quellen`);
}
const ds = C.dedupeStations(allStations);
log(`Fahrzeuge ${allVehicles.length} → ${dv.vehicles.length} (Dubletten ${dv.stats.duplicates}, Kennungs-Wiederverwendung ${dv.stats.reusedIds}, Spiegel ${dv.stats.mirrorDropped}); Stationen ${allStations.length} → ${ds.stations.length}`);

// Aggregation: Gemeinde × Anbieter × Fahrzeugart
const groups = C.aggregateGroups(dv.vehicles, ds.stations, { chargeThreshold, rangeThreshold });
const groupsOut = {};
for (const [k, v] of groups) groupsOut[k] = v;
// Energie je Gruppe (Q-2): dieselbe Regel wie lib/pulse-report.js energyLow (Ladestand < 20 % UND Reichweite < 5 km, wo beides gemeldet; sonst die
// gemeldete Angabe; Anbieter nur mit Reichweite über die Reichweite), Ladestand unplausibler Skala ist schon verworfen (C.batteryScaleCheck).
// Reichweiten-Schwelle je Quelle: min(5 km, v.rangeLimitKm) (C.rangeLimitCheck: 20 % des 95. Perzentils, wenn dieses < 25 km); konstante Reichweite
// der Quelle (v.rangeFlat, C.rangeFlatCheck) zählt nicht – ohne verwendbaren Ladestand ist die Energie dann unbekannt, nicht niedrig.
// energyKnown = Fahrzeuge mit Energieangabe, energyLow = Energie niedrig, energyRangeOnly(Low) = davon nur über die Reichweite beurteilt,
// ready = einsatzbereit (nicht gesperrt, nicht reserviert, Energieangabe vorhanden und nicht niedrig; wie R.readinessFromOps). Gesperrte zählen bei Energie mit.
// Nur Reichweite: je Fahrzeug, wenn der Anbieter nirgends einen Ladestand meldet (R.rangeOnlyOperators) oder der Ladestand des Fahrzeugs nur aus
// Reichweite ÷ Maximalreichweite abgeleitet ist (batteryDerived); bis 02.11.2026 machte eine einzige Quelle ohne Ladestand den ganzen Anbieter dazu
const rangeOnlyOps = R.rangeOnlyOperators(sourceOut);
// Gruppen ohne Fahrzeug mit Energieangabe tragen die Felder nicht (latest.energy gesetzt = fehlendes Feld bedeutet 0)
for (const v of dv.vehicles) {
  const st = groups.get(`${v.ags}|${v.operator}|${v.type}`); if (!st) continue;
  const ro = rangeOnlyOps.has(v.operator) || !!v.batteryDerived, rd = !!v.rangeDerived && v.batteryPct != null, low = R.energyLow(v.batteryPct, v.rangeKm, { charge: chargeThreshold, range: rangeThreshold, rangeOnly: ro, rangeDerived: rd, rangeLimit: v.rangeLimitKm ?? null, rangeFlat: !!v.rangeFlat });
  if (low == null) continue;
  if (st.energyKnown == null) Object.assign(st, { energyKnown: 0, energyLow: 0, energyRangeOnly: 0, energyRangeOnlyLow: 0, ready: 0 });
  st.energyKnown++; if (low) st.energyLow++;
  if (!rd && (ro || v.batteryPct == null)) { st.energyRangeOnly++; if (low) st.energyRangeOnlyLow++; }
  if (!low && !v.disabled && !v.reserved) st.ready++;
}

// Gemeinde-Zusammenfassung (Anbieter vor Ort, Bestand) und Totals
const muniOut = {};
for (const [ags, m] of munis) {
  const ops = {};
  for (const [k, st] of groups) { const [a, op, ty] = k.split('|'); if (a !== ags) continue; ops[op] ??= { total: 0, available: 0, types: {} }; ops[op].total += st.total; ops[op].available += st.available; ops[op].types[ty] = st.total; }
  muniOut[ags] = { ...m, c: centroids.get(ags) || null, areaKm2: areas.get(ags) ?? null, operators: ops }; // c = [lat, lon] Flächenschwerpunkt, areaKm2 aus den Grenzen
}
// Betriebsgebiet-Erkennung (V.presenceOf): wo ein Anbieter wirklich fährt, aus den Tagesdateien der letzten 14 Tage und dem aktuellen Stand.
// Vereinzelte Orte (ein verirrtes Fahrzeug, sporadisch ein, zwei E-Scooter am Rand) bleiben in den Daten, erscheinen aber nicht als eigenes Gebiet.
let presence = null;
try {
  const evDir0 = path.join(DATA, 'events'), cur = {};
  const files = existsSync(evDir0) ? (await readdir(evDir0)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(-V.PRESENCE.windowDays) : [];
  const docs = []; for (const f of files) { try { docs.push(JSON.parse(await readFile(path.join(evDir0, f), 'utf8'))); } catch {} }
  for (const [k, st] of groups) { const [a, op] = k.split('|'); const c = (cur[`${a}|${op}`] ||= { vehicles: 0, stations: 0 }); c.vehicles += st.total || 0; c.stations += st.stations || 0; }
  presence = V.presenceOf(docs, cur);
  for (const [ags, m] of Object.entries(muniOut)) { const p = presence.byMuni[ags]; if (p) m.presence = { status: p.status, ops: p.ops }; }
  log(`Betriebsgebiete (${presence.days} Tage): ${Object.entries(presence.counts).map(([k, v]) => `${v} ${k}`).join(', ')}`);
} catch (e) { log(`Betriebsgebiete: ${e.message} – ohne Einstufung`); }
const totals = {};
for (const [k, st] of groups) { const ty = k.split('|')[2]; totals[ty] ??= C.emptyStats(); for (const f of Object.keys(st)) totals[ty][f] = (totals[ty][f] || 0) + st[f]; }

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
  counts: { sources: sourceOut.length, byStatus: statusCounts, vehiclesRaw: allVehicles.length, vehicles: dv.vehicles.length, stationsRaw: allStations.length, stations: ds.stations.length, municipalities: munis.size, municipalitiesShown: presence ? Object.values(muniOut).filter(V.muniShown).length : munis.size, groups: groups.size, failing, errorCauses, retired: statusCounts.retired || 0, duplicates: statusCounts.duplicate || 0 },
  dedupe: { ...dv.stats, stationDuplicates: ds.duplicates, sourceDuplicates: dupOf.size, mirrorSources: mirrorInfo.size },
  thresholds: { chargeThreshold, rangeThreshold },
  energy: { version: 1, fields: ['energyKnown', 'energyLow', 'energyRangeOnly', 'energyRangeOnlyLow', 'ready'], rangeOnlyOps: [...rangeOnlyOps].sort(), // Felder je groups-Eintrag (Q-2)
    rangeLimit: { ...C.RANGE_LIMIT, rule: 'Reichweite < min(rangeThreshold, sources[].rangeLimitKm); rangeLimitKm = share × 95. Perzentil der Reichweite der Quelle, wenn dieses < maxP95Km (ab minN Fahrzeugen), sonst null' },
    rangeFlat: { ...C.RANGE_FLAT, rule: 'Reichweite der Quelle konstant (Spanne p5–p95 < maxSpreadKm oder > maxModeShare gleiche Werte, ab minN Fahrzeugen): für Energie unbekannt (sources[].rangeFlat)' } },
  sources: sourceOut, municipalities: muniOut, groups: groupsOut, totals, gaps, mirrors: mirrorsOut,
  ...(presence ? { presence: { version: 1, days: presence.days, rules: V.PRESENCE, counts: Object.fromEntries(Object.keys(presence.counts).map(k => [k, Object.values(muniOut).filter(m => m.presence?.status === k).length])), strayVehicles: Object.values(muniOut).filter(m => m.presence?.status === 'vereinzelt').reduce((s0, m) => s0 + Object.values(m.operators || {}).reduce((x, o) => x + (o.total || 0), 0), 0) } } : {}),
};
// Messbasis und Ampel aus dem veröffentlichten Stand der Ereignisse (vom vorigen Lauf): latest.json → measure.days[Tag] (Messminuten je
// Stunde ohne Lücken, Läufe, Regelstände der gezählten Läufe, voller Tag; lib/pulse-econ.js measureDay; abgeschlossene Tage werden
// übernommen) und → eventChecks (Selbsttest der Ereignisregeln je Gemeinde|Anbieter|Art am letzten vollständigen Tag, E.eventChecks).
// eventChecks hier vorläufig; nach der Verfolgung neu (Quellenbefund idleUnusable steht erst dann fest, Regel idleUnusableWarn), mit dem
// aktuellen Regelstand ruleNow: rot schließt nur aus, wenn der ausgewertete Tag ihn trägt (sonst gelb „älterer Regelstand“).
let ecInput = null; // Tagesdokument des letzten vollständigen Tags
const ampel = () => { if (ecInput) latest.eventChecks = E.eventChecks(ecInput, sourceOut, E.EVENT_CHECKS, { ruleNow: T.METHOD_VERSION }); };
try {
  const evDir = path.join(DATA, 'events'), today = T.dayOf(now);
  const evDays = existsSync(evDir) ? (await readdir(evDir)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 10)).sort() : [];
  const prevM = prev?.measure?.version === 1 ? prev.measure.days || {} : {};
  const mDays = {}; let ecDoc = null;
  for (const d of evDays) {
    if (prevM[d]?.complete) { mDays[d] = prevM[d]; continue; }
    const doc = JSON.parse(await readFile(path.join(evDir, `${d}.json`), 'utf8'));
    const complete = d < today && doc.published?.complete !== false; // laufender Tag und noch nicht vollständig veröffentlichter Vortag: neu lesen
    mDays[d] = { ...E.measureDay(doc), ...(complete ? { complete: true } : {}) };
    if (complete) ecDoc = doc;
  }
  latest.measure = { version: 1, fullDay: E.FULL_DAY, fields: 'obs: Minuten je Ortsstunde 0–23 ohne Lücken-Stunden, runs, counted (gezählte Läufe), rules (METHOD_VERSION der gezählten Läufe, "" = ohne), full (≥ 20 h mit ≥ 50 Min.), complete', days: mDays };
  const ecDay = Object.keys(mDays).filter(d => mDays[d].complete).sort().at(-1);
  if (ecDay) { ecInput = ecDoc?.day === ecDay ? ecDoc : JSON.parse(await readFile(path.join(evDir, `${ecDay}.json`), 'utf8')); ampel(); }
} catch (e) { log(`Messbasis/Ampel: ${e.message}`); }
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

// Zonen-Beobachtung: vermutete Umrisse aus data/zonen-vermutet.json (ZONES_FILE, leer = keine) und optional privat aus ZONE_WATCH;
// Bestand je Zone × Anbieter × Art → zone-watch.json (Läufe 2 Tage, Tageswerte 30 Tage; Format in lib/pulse-report.js zoneLogUpdate)
const zonesFile = process.env.ZONES_FILE ?? path.join(ROOT, 'data', 'zonen-vermutet.json');
if ((zonesFile && existsSync(zonesFile)) || process.env.ZONE_WATCH) {
  try {
    const seen = new Set();
    const zones = [...(zonesFile && existsSync(zonesFile) ? R.parseZoneWatch(await readFile(zonesFile, 'utf8')) : []), ...R.parseZoneWatch(process.env.ZONE_WATCH || '')].filter(z => !seen.has(z.id) && seen.add(z.id));
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
    } else log('Zonen-Beobachtung: keine gültigen Umrisse');
  } catch (e) { log(`Zonen-Beobachtung: ${e.message}`); }
}

// Tagtyp-Kalender (calendar.json, Format in lib/pulse-econ.js calendarFromApi): gesetzliche Feiertage und Schulferien je Land aus der
// OpenHolidays API (ODbL), einmal je Berliner Kalendertag, Zeitraum heute −400 bis +400 Tage (eine Anfrage je Endpunkt; 800 Tage am
// 02.11.2026 geprüft). Ohne Netz, bei Fehler oder unplausibler Antwort bleibt die alte Datei. CALENDAR_URL leer = aus (Fixture-Test).
{
  const base = process.env.CALENDAR_URL ?? 'https://openholidaysapi.org', f = path.join(DATA, 'calendar.json'), today = T.dayOf(now);
  let old = null; try { old = existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : null; } catch { old = null; }
  if (base && !(old?.version === 1 && Number.isFinite(Date.parse(old.generatedAt)) && T.dayOf(Date.parse(old.generatedAt)) === today)) {
    const iso = (ms) => new Date(ms).toISOString().slice(0, 10), mid = Date.parse(`${today}T12:00:00Z`);
    const from = iso(mid - 400 * 86400e3), to = iso(mid + 400 * 86400e3), q = `countryIsoCode=DE&languageIsoCode=DE&validFrom=${from}&validTo=${to}`;
    try {
      const [p, s] = await Promise.all([fetchJson(`${base}/PublicHolidays?${q}`, { retry: 0 }), fetchJson(`${base}/SchoolHolidays?${q}`, { retry: 0 })]);
      const cal = p.ok && s.ok ? E.calendarFromApi(p.json, s.json, { from, to, at: now }) : null;
      if (cal) { await writeFile(f, JSON.stringify(cal)); log(`Kalender ${from}–${to}: ${Object.keys(cal.states).length} Länder, ${Object.values(cal.states).reduce((a, x) => a + Object.keys(x).length, 0)} Ausnahmetage`); }
      else log(`Kalender: keine gültige Antwort (Feiertage ${p.ok ? `${(p.json || []).length} Einträge` : p.error || `HTTP ${p.status}`}, Ferien ${s.ok ? `${(s.json || []).length} Einträge` : s.error || `HTTP ${s.status}`}) – ${old ? 'alte Datei bleibt' : 'keine Datei'}`);
    } catch (e) { log(`Kalender: ${e.message} – ${old ? 'alte Datei bleibt' : 'keine Datei'}`); }
  }
}

// Umgebungsereignisse (incidents/<Ortstag>.json, lib/pulse-context.js): vorhandene Dateien lesen, ergänzen, schreiben
const incidentDir = path.join(DATA, 'incidents');
async function incidentDocs(dayList) {
  const m = new Map();
  for (const d of new Set(dayList)) { const f = path.join(incidentDir, `${d}.json`); try { m.set(d, existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : CX.emptyIncidentDoc(d)); } catch { m.set(d, CX.emptyIncidentDoc(d)); } }
  return m;
}
async function writeIncidents(docs) { await mkdir(incidentDir, { recursive: true }); for (const [d, doc] of docs) { doc.updatedAt = new Date(now).toISOString(); await writeFile(path.join(incidentDir, `${d}.json`), JSON.stringify(doc)); } }

// Wetter-Cache (weather/<UTC-Tag>.json): stündlich Temperatur, Niederschlag, Wind, Sonnenschein je 0,5°-Rasterzelle über den Gemeinden mit
// Flotte (Schwerpunkt aus den Grenzen), DWD-Beobachtungen über Bright Sky. Zweck: eine Wetterreihe aufbauen, die später ein wetterbereinigtes
// Modell speist (je früher der Verlauf beginnt, desto früher trägt es). Höchstens einmal je 50 Minuten, gestern und heute (UTC) als Beobachtung, morgen als Vorhersage;
// bei Fehler bleibt die alte Datei. WEATHER_URL leer = aus (Fixture-Test). Werte außerhalb des plausiblen Bereichs werden null.
// Seit 6.11.2026: fehlende Tage im Fenster der Prognose (Ortstage der Ereignisdateien, höchstens 23 Tage zurück) werden im selben Abruf nachgeholt
// (die Reihe begann erst am 3.11., die Tage davor hatten kein Wetter und hielten das Wetter-Gate zu). Im selben Takt die DWD-Warnungen je Zelle
// (Bright Sky /alerts) → incidents/<Ortstag>.json (lib/pulse-context.js).
{
  const base = process.env.WEATHER_URL ?? 'https://api.brightsky.dev', dir = path.join(DATA, 'weather');
  const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10), days = [utcDay(now - 86400e3), utcDay(now)], wDays = [...days, utcDay(now + 86400e3)]; // morgen: DWD-Vorhersage (MOSMIX), wird am Folgetag durch Beobachtungen ersetzt
  const fileOf = (d) => path.join(dir, `${d}.json`);
  let stale = false;
  for (const d of days) { try { const o = existsSync(fileOf(d)) ? JSON.parse(await readFile(fileOf(d), 'utf8')) : null; if (!o || !(now - Date.parse(o.generatedAt) < 50 * 60e3)) stale = true; } catch { stale = true; } }
  const dayFiles = async (d) => (existsSync(d) ? (await readdir(d)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 10)) : []);
  const back = CX.weatherBackfillDays((await dayFiles(path.join(DATA, 'events'))).sort().slice(-21), await dayFiles(dir), utcDay(now));
  if (back.length) { stale = true; wDays.unshift(...back); }
  if (base && stale && boundaries) {
    const cellOf = (c) => `${(Math.round(c[0] * 2) / 2).toFixed(1)}|${(Math.round(c[1] * 2) / 2).toFixed(1)}`;
    const cells = new Map(), agsCell = {};
    for (const [ags, m] of Object.entries(muniOut)) if (m.c && Number.isFinite(m.c[0]) && Number.isFinite(m.c[1]) && Object.values(m.operators || {}).length) { const k = cellOf(m.c); agsCell[ags] = k; if (!cells.has(k)) cells.set(k, m.c); }
    const num = (x, lo, hi, d = 1) => (typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi ? Math.round(x * 10 ** d) / 10 ** d : null);
    try {
      await mkdir(dir, { recursive: true });
      const keys = [...cells.keys()], res = {}; let fails = 0;
      for (let i = 0; i < keys.length; i += 4) await Promise.all(keys.slice(i, i + 4).map(async (k) => {
        const [lat, lon] = cells.get(k).map(x => Math.round(x * 100) / 100); // Abfrage am Schwerpunkt der ersten Gemeinde der Zelle (Zelle nur zum Zusammenfassen)
        const r = await fetchJson(`${base}/weather?lat=${lat}&lon=${lon}&date=${back[0] ?? days[0]}&last_date=${utcDay(now + 2 * 86400e3)}&tz=UTC&units=dwd`, { retry: 0 });
        if (r.ok && Array.isArray(r.json?.weather)) res[k] = r.json.weather; else fails++;
      }));
      let wrote = 0;
      for (const d of wDays) {
        const hours = Array.from({ length: 24 }, (_, h) => `${d}T${String(h).padStart(2, '0')}:00:00Z`), out = {};
        for (const [k, rows] of Object.entries(res)) {
          const by = new Map(rows.map(w => [Date.parse(w.timestamp), w])), col = (f, lo, hi, dg) => hours.map(h => num(by.get(Date.parse(h))?.[f], lo, hi, dg));
          const t = col('temperature', -45, 55), p = col('precipitation', 0, 250), w = col('wind_speed', 0, 250), s = col('sunshine', 0, 60, 0);
          if ([t, p].some(a => a.some(x => x != null))) out[k] = { lat: cells.get(k)[0], lon: cells.get(k)[1], t, p, w, s };
        }
        if (Object.keys(out).length) { await writeFile(fileOf(d), JSON.stringify({ version: 1, day: d, generatedAt: new Date(now).toISOString(), source: 'DWD Open Data via Bright Sky', units: { t: '°C', p: 'mm/h', w: 'km/h', s: 'min/h' }, hours, cells: out, ags: agsCell })); wrote++; }
      }
      log(`Wetter: ${keys.length} Rasterzellen, ${wrote} Tagesdatei(en)${back.length ? ` (nachgeholt: ${back.join(', ')})` : ''}${fails ? `, ${fails} Abrufe ohne Antwort` : ''}`);
      // DWD-Warnungen je Zelle (Beginn/Ende → Ortsstunden, auch die kommenden); Fehler lassen die Dateien unverändert
      const alerts = {}; let afails = 0; const aUntil = Date.now() + 45e3; // höchstens 45 s, danach mit dem Stand weiter
      for (let i = 0; i < keys.length && Date.now() < aUntil; i += 4) await Promise.all(keys.slice(i, i + 4).map(async (k) => {
        const [lat, lon] = cells.get(k).map(x => Math.round(x * 100) / 100), r = await fetchJson(`${base}/alerts?lat=${lat}&lon=${lon}`, { retry: 0 });
        if (r.ok && Array.isArray(r.json?.alerts)) alerts[k] = r.json.alerts.map(a => ({ status: a.status, severity: a.severity, onset: a.onset, effective: a.effective, expires: a.expires })); else afails++;
      }));
      if (Object.keys(alerts).length) { const docs = await incidentDocs([T.dayOf(now - 3 * 3600e3), T.dayOf(now), T.dayOf(now + 86400e3), T.dayOf(now + 2 * 86400e3)]), n = CX.addAlerts(docs, alerts, agsCell, now);
        for (const d of docs.values()) d.sources.warn = { at: new Date(now).toISOString(), cells: Object.keys(alerts).length };
        await writeIncidents(docs); log(`Warnungen (DWD): ${Object.values(alerts).reduce((a, l) => a + l.length, 0)} aktiv in ${Object.keys(alerts).length} Zellen, ${n} Gemeinde-Stunden neu${afails ? `, ${afails} Abrufe ohne Antwort` : ''}`); }
    } catch (e) { log(`Wetter: ${e.message} – alte Dateien bleiben`); }
  }
}

// Autobahn (verkehr.autobahn.de, Autobahn GmbH des Bundes): Sperrungen und Staus mit Koordinate → Gemeinde, eingetragen zur aktuellen Ortsstunde
// in incidents/<Ortstag>.json (Merkmal „road“ der Prognose). Einmal je Ortsstunde (rund 220 Abrufe: Liste der Autobahnen, je Autobahn Sperrungen
// und Verkehrsmeldungen), damit keine Stunde ohne Beobachtung bleibt; nur frische Sperrungen und Staus (CX.ROAD_FRESH), keine Dauer-Baustellen.
// AUTOBAHN_URL leer = aus.
// Gespeichert werden nur Gemeinde und Stunde, keine Meldungstexte.
{
  const base = process.env.AUTOBAHN_URL ?? 'https://verkehr.autobahn.de/o/autobahn';
  if (base && index) {
    try {
      const docs = await incidentDocs([T.dayOf(now)]), doc = docs.get(T.dayOf(now)), last = Date.parse(doc.sources?.road?.at || 0);
      // Fassung 2 (6.11.2026 abends): Fassung 1 zählte auch monatelange Bauphasen – deren Kennzeichen des Tages einmal löschen
      if (doc.sources?.road && !(doc.sources.road.v >= 2)) { for (const a of Object.values(doc.ags)) delete a.road; doc.sources.road.v = 2; }
      if (!(now - last < 55 * 60e3) || !(Number.isFinite(last) && T.dayOf(last) === T.dayOf(now) && T.hourOf(last) === T.hourOf(now))) {
        const list = await fetchJson(`${base}/`, { retry: 0 }), roads = Array.isArray(list.json?.roads) ? list.json.roads.filter(r => /^A\d+$/.test(String(r).trim())).map(r => String(r).trim()) : [];
        if (!roads.length) log(`Autobahn: Liste nicht erreichbar${list.status ? ` (HTTP ${list.status})` : ''}`);
        else {
          const items = []; let fails = 0, done = 0; const until = Date.now() + 60e3; // höchstens 60 s je Lauf; Rest beim nächsten Mal
          const jobs = roads.flatMap(r => ['closure', 'warning'].map(sv => [r, sv]));
          for (let i = 0; i < jobs.length && Date.now() < until; i += 6) await Promise.all(jobs.slice(i, i + 6).map(async ([r, sv]) => {
            done++; const x = await fetchJson(`${base}/${encodeURIComponent(r)}/services/${sv}`, { retry: 0 }), arr = x.json?.[sv];
            if (!x.ok || !Array.isArray(arr)) { fails++; return; }
            for (const it of arr) { const v = CX.roadItem(it, sv, now); if (v) items.push(v); }
          }));
          const n = CX.addRoad(docs, items, (lat, lon) => C.assignMunicipality(index, lat, lon)?.ags ?? null, now);
          doc.sources.road = { v: 2, at: new Date(now).toISOString(), roads: roads.length, items: items.length, fails, ...(done < jobs.length ? { partial: +(done / jobs.length).toFixed(2) } : {}) };
          await writeIncidents(docs);
          log(`Autobahn: ${roads.length} Autobahnen, ${items.filter(x => x.kind === 'closure').length} Sperrungen, ${items.filter(x => x.kind === 'jam').length} Staus, ${n} Gemeinden betroffen${fails ? `, ${fails} Abrufe ohne Antwort` : ''}`);
        }
      }
    } catch (e) { log(`Autobahn: ${e.message} – übersprungen`); }
  }
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
const tr = T.trackRun(prevState, { vehicles: dv.vehicles, stations: ds.stations, sourceRecs: sourceOut.map(r => ({ id: r.id, status: r.status, feedStatus: r.feedStatus || null, latencyMs: r.latencyMs, batteryFloor: r.batteryFloor?.hides ? r.batteryFloor.p005 : null })), now, hmac, noEvents: migrated });
if (keyId) tr.state.keyId = keyId;
// Standzeit unbrauchbar (T.IDLE_CHECK, Z5: ≥ 200 Fahrzeuge, > 50 % unter einem Laufintervall – Kennung wechselt je Lauf): sources[].idleUnusable, Befund in
// der Feed-Prüfung, ops-Feld 8 null; latest.json ist vor der Verfolgung geschrieben und wird dann neu geschrieben
{
  let n = 0;
  for (const rec of sourceOut) { const u = tr.idleUnusable?.[rec.id]; if (!u) continue; rec.idleUnusable = true; rec.idleCheck = { n: u.n, shortShare: u.share }; addCheck(rec, `Standzeit unbrauchbar (${Math.round(u.share * 100)} % kürzer als ein Laufintervall): nicht ausgewiesen`, u.n); n++; }
  // Ampel erst jetzt mit dem Befund idleUnusable (bis 02.11.2026 vor der Verfolgung berechnet: Regel idleUnusableWarn griff nie); Fehler brechen den Lauf nicht ab
  let ec = false;
  try {
    if (ecInput) { ampel(); ec = true; const g = Object.values(latest.eventChecks?.groups || {});
      if (g.length) log(`Ampel ${latest.eventChecks.day} (Regelstand ${latest.eventChecks.dayRules.join(' + ') || 'ohne Angabe'}${latest.eventChecks.ruleCurrent ? '' : `, älter als ${T.METHOD_VERSION}: rot nur als Hinweis`}): ${g.filter(x => x.level === 'bad').length} rot, ${g.filter(x => x.level === 'warn').length} gelb von ${g.length} Gruppen`); }
  } catch (e) { log(`Ampel: ${e.message}`); }
  if (n || ec) await writeFile(path.join(DATA, 'latest.json'), JSON.stringify(latest));
  if (n) log(`Standzeit unbrauchbar: ${Object.keys(tr.idleUnusable).join(', ')}`);
}
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
  const series = {}, dayRuns = {}; // dayRuns: zählende Läufe je Tag (Präsenz einer Gruppe = Läufe mit Wert ÷ dayRuns, lib/pulse-report.js histStats)
  const dayRows = (h) => { // Map key → Zeile
    const flags = h.f || [], runs = h.t.length;
    let use = [...Array(runs).keys()].filter(i => flags[i] !== 0); if (!use.length) use = [...Array(runs).keys()]; // Tag nur mit Lücken-Läufen: alle
    const out = new Map(); out.runs = use.length;
    for (const [key, ser] of Object.entries(h.series)) {
      const idx = use.filter(i => ser.total?.[i] != null); if (!idx.length) continue;
      // Mittel je Feld über die Läufe mit Wert (stationsEmptyDock fehlt in älteren Tagen → null)
      out.set(key, [...DAILY.map(f => { const xs = idx.filter(i => ser[f]?.[i] != null); return xs.length ? +(xs.reduce((a, i) => a + ser[f][i], 0) / xs.length).toFixed(1) : null; }), idx.length]);
    }
    return out;
  };
  for (const d of useDays) {
    const reuse = d !== day && prevDaily.days.includes(d) && JSON.stringify(prevDaily.fields) === JSON.stringify([...DAILY, 'runs']); // nur bei gleichem Feldaufbau übernehmen
    if (reuse && (prevDaily.dayRuns?.[d] != null || !existsSync(path.join(DATA, 'history', `${d}.json`)))) { for (const [key, byDay] of Object.entries(prevDaily.series)) if (byDay[d]) (series[key] ??= {})[d] = byDay[d]; if (prevDaily.dayRuns?.[d] != null) dayRuns[d] = prevDaily.dayRuns[d]; continue; }
    const h = d === day ? hist : JSON.parse(await readFile(path.join(DATA, 'history', `${d}.json`), 'utf8'));
    const rows = dayRows(h); dayRuns[d] = rows.runs;
    for (const [key, row] of rows) (series[key] ??= {})[d] = row;
  }
  // Bruchmarken (Z2, lib/pulse-report.js ruleBreaks): breaks { 'Gemeinde|Anbieter|Art': erster Tag mit neuem Regelstand }, wenn der Bestand
  // beim ersten Lauf mit neuem Regelstand (Teil vor „@“, Läufe aus runs.json, dieser Lauf mit RULE) um ≥ 10 % und ≥ 5 Fahrzeuge springt.
  // Ohne breaks in der vorigen daily.json einmal rückwirkend über alle Läufe von runs.json, danach nur Wechsel seit deren updatedAt; Marken bleiben im 30-Tage-Fenster.
  const breaks = Object.fromEntries(Object.entries(prevDaily.breaks || {}).filter(([, d]) => d >= (useDays[0] || '')));
  try {
    const rf = path.join(DATA, 'runs.json');
    const rl = existsSync(rf) ? (JSON.parse(await readFile(rf, 'utf8')).runs || []).map(r => [r[0], r[14] ?? null]) : [];
    rl.push([now, RULE]); rl.sort((a, b) => a[0] - b[0]);
    const since = prevDaily.breaks ? prevDaily.updatedAt ?? null : null;
    const era = (r) => R.ruleEra([r[0], null, null, r[1]]), need = new Set();
    for (let i = 1; i < rl.length; i++) if (era(rl[i]) !== era(rl[i - 1]) && (since == null || rl[i][0] > since)) { need.add(T.dayOf(rl[i - 1][0])); need.add(T.dayOf(rl[i][0])); }
    const hs = []; for (const d of need) { if (d === day) hs.push(hist); else if (existsSync(path.join(DATA, 'history', `${d}.json`))) hs.push(JSON.parse(await readFile(path.join(DATA, 'history', `${d}.json`), 'utf8'))); }
    const found = hs.length ? R.ruleBreaks(rl, hs, { since }) : {};
    if (Object.keys(found).length) log(`Bruchmarken: ${Object.keys(found).length} Reihen (${[...new Set(Object.values(found))].join(', ')})`);
    Object.assign(breaks, found);
  } catch (e) { log('Bruchmarken:', e.message); }
  await writeFile(dailyFile, JSON.stringify({ days: useDays, fields: [...DAILY, 'runs'], updatedAt: now, series, dayRuns, breaks }));
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
  // Ereignisse je Stunde (M-11 Datenschutz): mit TRACK_DIR liegt der laufende Tag privat (events-work.json.gz) und wird beim Stundenwechsel
  // veröffentlicht – vor dem Einrechnen dieses Laufs, dann sind alle enthaltenen Stunden abgeschlossen –, nach Tagesende vollständig
  // (published.complete). Ohne TRACK_DIR wie bisher je Lauf.
  const evFile = path.join(DATA, 'events', `${tr.day}.json`);
  const evWorkFile = TRACK_DIR ? path.join(TRACK_DIR, 'events-work.json.gz') : null;
  const evPublish = async (doc, complete) => { const str = JSON.stringify({ ...doc, published: { at: now, through: doc.runs?.at(-1)?.[0] ?? null, complete } }); await writeFile(path.join(DATA, 'events', `${doc.day}.json`), str); return JSON.parse(str); }; // Kopie: der Arbeitsstand wird danach fortgeschrieben
  let evWork = null, evPub = null, evFinal = null; // evPub: veröffentlichter Stand des laufenden Tags, evFinal: in diesem Lauf abgeschlossener Vortag
  if (evWorkFile) {
    evWork = await readState(evWorkFile);
    if (!evWork && existsSync(evFile)) evWork = JSON.parse(await readFile(evFile, 'utf8')); // Umstieg: bisher je Lauf veröffentlicht
    if (evWork && evWork.day !== tr.day) { evFinal = await evPublish(evWork, true); evWork = null; }
    else if (evWork) { const last = evWork.runs?.at(-1)?.[0]; if (last != null && T.hourOf(last) !== tr.hour) evPub = await evPublish(evWork, false); }
  }
  const evDoc = T.mergeHourly(evWorkFile ? evWork : existsSync(evFile) ? JSON.parse(await readFile(evFile, 'utf8')) : null, tr.hourly, { day: tr.day, at: now, dt: tr.dt, srcModes: tr.srcModes, gap: tr.gap, rule: RULE });
  if (evWorkFile) await writeFile(evWorkFile, gzipSync(JSON.stringify(evDoc)));
  else { await writeFile(evFile, JSON.stringify(evDoc)); evPub = evDoc; }
  if (!evPub && existsSync(evFile)) evPub = JSON.parse(await readFile(evFile, 'utf8')); // in dieser Stunde schon veröffentlichter Stand
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
    await writeFile(gIdxFile, JSON.stringify(T.groupIndex(months, counts, { at: now, first, last, night: T.groupNight(gd.events) }))); // night30: Nachtanteil je Anbieter (30 Tage, Z7)
    if (tr.groups?.length) log(`Gruppen: ${tr.groups.filter(g => g.kind === 'deploy').length} ausgebracht, ${tr.groups.filter(g => g.kind === 'collect').length} eingesammelt (groups/: ${months.length} Monat${months.length === 1 ? '' : 'e'}, ${Object.values(counts).reduce((a, b) => a + b, 0)} Ereignisse)`);
  }
  { const s = (a) => (a || []).reduce((x, y) => x + (y || 0), 0); runEv = { start: 0, end: 0, rot: 0 }; for (const h of tr.hourly.values()) { runEv.start += s(h.start); runEv.end += s(h.end); runEv.rot += s(h.rot); } }
  // Langzeit-Archiv: Tageswerte je Gemeinde|Anbieter|Art, eine Datei je Monat, wird nie gekürzt. Grundlage ist der veröffentlichte Stand der
  // Ereignisse (M-11: laufender Tag nur abgeschlossene Stunden; abgeschlossener Vortag vollständig), sonst verrieten die Tageswerte je Lauf mehr.
  {
    const arDir = path.join(DATA, 'archive'); await mkdir(arDir, { recursive: true });
    const AR_FIELDS = ['flotte_avg', 'fahrten', 'fahrtenden', 'kennungswechsel', 'umsetzungen', 'akkutausch', 'abholungen', 'sperren', 'beobachtet_min'];
    const arRows = (doc, h) => {
      // gestörte Stunden (Lauf nach Lücke, auch Altbestand) zählen weder mit Ereignissen noch mit Beobachtungszeit
      const obsH = E.observedMinutes(doc.runs);
      const s = (a) => (a || []).reduce((x, y, hh) => x + (obsH[hh] > 0 ? (y || 0) : 0), 0);
      const obsMin = obsH.reduce((a, b) => a + b, 0);
      const vminOk = (doc.runs || []).every(r => r[1] == null || r[2] === 1 || r[2] === 0);
      const rows = {};
      for (const [k, g] of Object.entries(doc.groups || {})) {
        const hs = h?.series?.[k]?.total?.filter((x, i) => x != null && h.f?.[i] !== 0) || [];
        const countedRuns = h ? ((h.f || h.t).filter(x => x !== 0).length || h.t.length) : 0;
        // Mittel über die Läufe mit Wert nur bei ausreichender Präsenz (≥ 50 % der zählenden Läufe), sonst keine Tagesflotte (lib/pulse-report.js MIN_PRESENCE)
        const fleet = vminOk && obsMin > 0 && s(g.vminTot) > 0 ? s(g.vminTot) / obsMin : hs.length && hs.length >= R.MIN_PRESENCE * countedRuns ? hs.reduce((a, b) => a + b, 0) / hs.length : null;
        rows[k] = [fleet == null ? null : +fleet.toFixed(1), s(g.start), s(g.end), s(g.rot), s(g.reloc), s(g.swap), s(g.pickup), s(g.disOn), Math.round(obsMin)];
      }
      return rows;
    };
    const put = [];
    if (evFinal) { const hf = path.join(DATA, 'history', `${evFinal.day}.json`); put.push([evFinal.day, arRows(evFinal, existsSync(hf) ? JSON.parse(await readFile(hf, 'utf8')) : null)]); }
    if (evPub?.day === tr.day) put.push([tr.day, arRows(evPub, hist)]);
    let month = tr.day.slice(0, 7), ar = null;
    for (const [d, rows] of put) {
      const m = d.slice(0, 7), f = path.join(arDir, `${m}.json`);
      const doc = existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : { month: m, days: {} };
      doc.fields = AR_FIELDS; doc.days[d] = rows; doc.updatedAt = now;
      await writeFile(f, JSON.stringify(doc)); if (m === month) ar = doc;
    }
    if (!ar) { const f = path.join(arDir, `${month}.json`); ar = existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : { month, days: {}, fields: AR_FIELDS }; }
    // Index mit Tagen und erstem Tag (Vertrag 7), damit das Dashboard nicht alle Monatsdateien laden muss
    const months = (await readdir(arDir)).filter(f => /^\d{4}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 7)).sort();
    const allDays = []; for (const m of months) { const d = m === month ? ar : JSON.parse(await readFile(path.join(arDir, `${m}.json`), 'utf8')); allDays.push(...Object.keys(d.days || {})); }
    allDays.sort();
    await writeFile(path.join(arDir, 'index.json'), JSON.stringify({ months, fields: ar.fields, days: allDays.length, firstDay: allDays[0] || null, updatedAt: now }));
  }
  // Zellen (M-11 Datenschutz): mit TRACK_DIR liegt der laufende Tag privat (cells-work.json.gz) und wird je Bundesland beim Wechsel des
  // Tageszeit-Bands veröffentlicht (vor dem Einrechnen dieses Laufs: nur abgeschlossene Bänder), nach Tagesende vollständig. In jeder
  // veröffentlichten Landesdatei ist Zelle × Band unter T.CELL_MIN (3) Ereignissen unterdrückt, die Summen stehen je Gemeinde in below.
  // Ohne TRACK_DIR wie bisher je Lauf (Tagesdatei cells/<Tag>.json öffentlich), Landesdateien ebenfalls mit Unterdrückung.
  const cellsDir = path.join(DATA, 'cells');
  const cellFile = path.join(cellsDir, `${tr.day}.json`);
  const cellWorkFile = TRACK_DIR ? path.join(TRACK_DIR, 'cells-work.json.gz') : null;
  // je Bundesland aufgeteilt (kleinere Downloads); bandTainted/taintChecked: Altläufe repariert (lib/pulse-track.js repairCells)
  const cellMeta = (d) => ({ bandMin: d.bandMin, bandRuns: d.bandRuns, ...(d.bandTainted ? { bandTainted: d.bandTainted } : {}), ...(d.taintChecked ? { taintChecked: d.taintChecked } : {}), ...(d.relocUnrepaired ? { relocUnrepaired: true } : {}) });
  const CELL_FIELDS = 'start,end,present,reloc,start×6,present×6,end×6', BELOW_FIELDS = 'start×6,end×6,start_ohne_Band,end_ohne_Band';
  const publishCells = async (doc, complete) => {
    await mkdir(path.join(cellsDir, doc.day), { recursive: true });
    for (const [st, m] of Object.entries(doc.states || {})) {
      const sp = T.suppressCells(m);
      await writeFile(path.join(cellsDir, doc.day, `${st}.json`), JSON.stringify({ day: doc.day, state: st, ...cellMeta(doc), fields: CELL_FIELDS, munis: sp.munis, below: sp.below, belowFields: BELOW_FIELDS, minCount: T.CELL_MIN, suppress: T.SUPPRESS_VERSION, published: { at: now, through: doc.lastAt ?? null, complete } }));
    }
  };
  let cellWork = null;
  if (cellWorkFile) {
    cellWork = await readState(cellWorkFile);
    let migratedCells = false;
    if (!cellWork && existsSync(cellFile)) { cellWork = JSON.parse(await readFile(cellFile, 'utf8')); migratedCells = true; } // Umstieg: bisher öffentliche Tagesdatei
    if (cellWork && cellWork.day !== tr.day) { await publishCells(cellWork, true); cellWork = null; }
    else if (cellWork) {
      if (migratedCells) T.repairCells(cellWork, evDoc.runs, { exclude: now });
      const last = cellWork.lastAt;
      if (migratedCells || (last != null && T.bandOf(T.hourOf(last)) !== T.bandOf(tr.hour))) await publishCells(cellWork, false);
    }
  }
  const cellDoc = T.mergeCells(cellWorkFile ? cellWork : existsSync(cellFile) ? JSON.parse(await readFile(cellFile, 'utf8')) : null, tr.cells, muniOut, tr.day, { dt: tr.dt, hour: tr.hour, gap: tr.gap, runs: evDoc.runs, at: now });
  cellDoc.lastAt = now;
  if (cellWorkFile) {
    await writeFile(cellWorkFile, gzipSync(JSON.stringify(cellDoc)));
    for (const f of (await readdir(cellsDir)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))) await rm(path.join(cellsDir, f)); // Tagesdateien nicht mehr öffentlich
  } else { await writeFile(cellFile, JSON.stringify(cellDoc)); await publishCells(cellDoc, false); }
  // frühere Tage (14 Tage Landesdateien, 3 Tage Tagesdateien) einmalig reparieren: Bänder mit Altlauf laut events/<Tag>.json fallen aus
  try {
    for (const d of (await readdir(cellsDir)).filter(f => /^\d{4}-\d{2}-\d{2}(\.json)?$/.test(f))) {
      const dayD = d.slice(0, 10); if (dayD === tr.day) continue;
      const evF = path.join(DATA, 'events', `${dayD}.json`); if (!existsSync(evF)) continue;
      const files = d.endsWith('.json') ? [path.join(cellsDir, d)] : (await readdir(path.join(cellsDir, d))).filter(f => f.endsWith('.json')).map(f => path.join(cellsDir, d, f));
      let runsD = null;
      for (const f of files) {
        const doc = JSON.parse(await readFile(f, 'utf8')); const perState = !d.endsWith('.json');
        if (doc.taintChecked && (!perState || (doc.minCount && doc.suppress >= T.SUPPRESS_VERSION))) continue;
        if (!doc.taintChecked) {
          runsD ??= JSON.parse(await readFile(evF, 'utf8')).runs || [];
          const { bands } = T.repairCells(doc, runsD);
          if (bands.length && perState && f.endsWith('BE.json')) log(`Zellen ${dayD}: Altläufe neutralisiert (Bänder ${bands.map(b => T.BANDS[b].label).join(', ')})`);
        }
        // ältere Landesdateien: Unterdrückung kleiner Zellen nachträglich (M-11)
        if (perState && !doc.minCount) { const sp = T.suppressCells(doc.munis); doc.munis = sp.munis; doc.below = sp.below; doc.belowFields = BELOW_FIELDS; doc.minCount = T.CELL_MIN; }
        // Sekundärunterdrückung nachträglich (ab 6.11.2026): einzeln unterdrückte Zelle je Gemeinde × Band nicht aus below ablesbar
        else if (perState && !(doc.suppress >= T.SUPPRESS_VERSION)) T.secondarySuppress(doc.munis, doc.below || {}, { min: doc.minCount });
        if (perState) doc.suppress = T.SUPPRESS_VERSION;
        await writeFile(f, JSON.stringify(doc));
      }
    }
  } catch (e) { log(`Zellen-Reparatur: ${e.message}`); }
  // Start-Ziel-Ströme (nur stabile Kennungen; lib/pulse-track.js publishFlows): Tagessumme privat in TRACK_DIR, veröffentlicht wird ein Tag
  // erst nach Tagesende (flows/<Tag>.json, ≥ T.FLOW_MIN = 5 Fahrten je Zeile, Top 300 je Gemeinde, 30 Tage) – ohne privates Verzeichnis keine Ströme
  if (TRACK_DIR) {
    const flDir = path.join(DATA, 'flows'), rawFile = path.join(TRACK_DIR, 'flows-raw.json.gz');
    await mkdir(flDir, { recursive: true });
    const raw0 = await readState(rawFile);
    if (raw0?.day && raw0.day < tr.day) { const pub = T.publishFlows(raw0, { at: now }); await writeFile(path.join(flDir, `${raw0.day}.json`), JSON.stringify(pub)); log(`Ströme ${raw0.day}: ${pub.flows.length} Zeilen (${pub.total.shown} Fahrten), ${pub.total.below} unter Mindestschwelle, ${pub.total.cut} außerhalb Top ${pub.top}`); }
    const raw = T.mergeFlows(raw0, tr.flows, { day: tr.day, gap: tr.gap, stable: T.stableOps(tr.srcModes, sourceOut) });
    await writeFile(rawFile, gzipSync(JSON.stringify(raw)));
    const flDays = (await readdir(flDir)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    for (const f of flDays.slice(0, -HISTORY_DAYS)) await rm(path.join(flDir, f));
    // ältere Tagesdateien mit niedrigerer Schwelle (bis 6.11.2026: 2) einmalig nachziehen: Zeilen unter T.FLOW_MIN entfallen
    for (const f of flDays.slice(-HISTORY_DAYS)) { try { const fp = path.join(flDir, f), doc = JSON.parse(await readFile(fp, 'utf8')); if (T.tightenFlows(doc)) { await writeFile(fp, JSON.stringify(doc)); log(`Ströme ${f.slice(0, 10)}: auf ≥ ${T.FLOW_MIN} Fahrten je Zeile nachgezogen (${doc.flows.length} Zeilen)`); } } catch (e) { log(`Ströme ${f}: ${e.message}`); } }
    await writeFile(path.join(flDir, 'index.json'), JSON.stringify({ days: flDays.slice(-HISTORY_DAYS).map(f => f.slice(0, 10)), collecting: raw.day, min: T.FLOW_MIN, top: T.FLOW_TOP, fields: T.FLOW_FIELDS, updatedAt: now }));
    // Geschätzte Ströme für rotierende Kennungen (lib/pulse-flowest.js): je Lauf nur Zählungen je Zelle, privat in TRACK_DIR
    // (flows-est-raw.json.gz, keine Paare); Schätzung erst nach Tagesende → flows-est/<Tag>.json (estimated: true, ≥ FE.EST_MIN = 2 erwartete Fahrten,
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
      // Standzeit null, wenn sie für die Quelle unbrauchbar ist (Z5); Feld 13 standzeitMindestens 1 = seit Beginn der Verfolgung unbewegt (Mindestwert, Z6)
      // veröffentlicht wird nur die Klasse (OPS.idleClassMin: unter 6 h, 6–24 h, ganze Tage), nicht die Minute des letzten Fahrtendes
      const idleOk = e && !tr.idleUnusable?.[v.sourceId], idleMin = idleOk ? OPS.idleClassMin(Math.round((now - e[8]) / 60e3)) : null;
      const idleMinOnly = idleOk && T.isCensored(T.censorLimit(tr.state), e[8], e[7]) ? 1 : null;
      // Feld 11 reichweiteSchwelleKm (null = Standard), Feld 12 reichweiteKonstant (1 = Reichweite der Quelle konstant); Felder am Zeilenende ohne
      // Wert entfallen (Leser werten fehlende Felder als null), explizites null nur vor einem späteren Wert
      const row = [+v.lat.toFixed(5), +v.lon.toFixed(5), idx(o.ops, v.operator), TYPES.indexOf(v.type), (v.reserved ? 1 : 0) | (v.disabled ? 2 : 0), v.batteryPct != null && !v.batteryDerived ? Math.round(v.batteryPct) : null, OPS.rangePublic(v), idleMin, idx(o.munis, v.ags), v.rangeDerived ? 1 : 0, v.rangeLimitKm ?? null, v.rangeFlat ? 1 : null, idleMinOnly];
      while (row.length && row[row.length - 1] == null) row.pop();
      o.vehicles.push(row);
    }
    for (const s of ds.stations) {
      const st = muniOut[s.ags]?.state; if (!st) continue; const o = S(st);
      o.stations.push([+s.lat.toFixed(5), +s.lon.toFixed(5), idx(o.ops, s.operator), String(s.name || '').slice(0, 50), s.bookable ?? 0, s.docksAvailable ?? null, s.capacity ?? null, idx(o.munis, s.ags), s.renting === false ? 0 : 1, s.returning === false ? 0 : 1, s.physicalAvailable ?? 0, s.isVirtual === true ? 1 : s.isVirtual === false ? 0 : null]);
    }
    let bytes = 0;
    for (const [st, o] of byState) { const doc = JSON.stringify({ at: now, state: st, types: TYPES, trackStart: tr.state.trackStart ?? null, vehicleFields: 'lat,lon,op,type,flags(1=reserviert,2=gesperrt),akku%,reichweiteKm,standzeitKlasseMin,gemeinde,reichweiteAbgeleitet,reichweiteSchwelleKm,reichweiteKonstant,standzeitMindestens', vehicleFieldsNote: 'Felder am Zeilenende ohne Wert entfallen (fehlend = null): standzeitKlasseMin = Untergrenze der Standzeit-Klasse in Minuten (0 = unter 6 h, 360 = 6–24 h, ab 1440 ganze Tage; minutengenau wird nicht veröffentlicht, weil sie zeigt, wann an einer Adresse die letzte Fahrt endete), reichweiteKm ganze km (Quellen mit eigener Reichweiten-Skala, Feld reichweiteSchwelleKm gesetzt: 0,1 km), reichweiteSchwelleKm null = Standardschwelle, reichweiteKonstant 1 = Reichweite der Quelle konstant (für Energie und Akkutausch unbekannt), standzeitMindestens 1 = seit Beginn der Verfolgung (trackStart) unbewegt, die Klasse ist ein Mindestwert; standzeitKlasseMin null = unbekannt oder für die Quelle unbrauchbar (sources[].idleUnusable)', stationFields: 'lat,lon,op,name,buchbar,freiePlaetze,kapazitaet,gemeinde,vermietend,rueckgabe,physisch,virtuell', ...o }); bytes += doc.length; await writeFile(path.join(DATA, 'ops', `${st}.json`), doc); }
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
  // Standzeit-Klassen (T.IDLE_BUCKETS, ab 02.11.2026 mit „> 72 h“): groups[k] = [je Klasse, Summe], censored[k] = je Klasse Mindestwerte (seit
  // trackStart unbewegt, Z6); Quellen mit unbrauchbarer Standzeit (Z5) fehlen (unusable)
  await writeFile(path.join(DATA, 'idle.json'), JSON.stringify({ at: now, version: T.IDLE_VERSION, buckets: T.IDLE_LABELS, fields: 'groups: Anzahl je Klasse, dann Summe; censored: davon Mindestwerte je Klasse', trackStart: tr.state.trackStart ?? null, groups: tr.idle, censored: tr.idleCens, unusable: Object.keys(tr.idleUnusable || {}).sort() }));
  // Lange Standzeiten: je Gemeinde max. 400 Punkte (gleichmäßig ausgedünnt)
  const byAgs = new Map(); for (const p of tr.idleLong) { if (!byAgs.has(p.ags)) byAgs.set(p.ags, []); byAgs.get(p.ags).push(p); }
  // hours nur als ganze Tage (Klasse wie ops/<Land>.json: OPS.idleClassMin), nicht stundengenau
  const longOut = []; for (const [, list] of byAgs) { list.sort((a, b) => b.hours - a.hours); const step = Math.max(1, Math.ceil(list.length / 400)); for (let i = 0; i < list.length; i += step) longOut.push({ ...list[i], hours: OPS.idleClassMin(list[i].hours * 60) / 60 }); }
  await writeFile(path.join(DATA, 'idle-long.json'), JSON.stringify({ at: now, total: tr.idleLong.length, points: longOut }));
  await writeFile(path.join(DATA, 'stations-quota.json'), JSON.stringify({ at: now, days: 7, fields: ['ags', 'operator', 'name', 'lat', 'lon', 'runs', 'emptyRuns', 'fullRuns', 'virtual'], stations: T.stationQuota(tr.state) }));
  await writeFile(path.join(DATA, 'reliability.json'), JSON.stringify({ at: now, days: 7, sources: T.reliability(tr.state) }));
  // Ereignis- und Zellendateien: 30 bzw. 14 Tage behalten
  for (const f of (await readdir(path.join(DATA, 'events'))).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(0, -HISTORY_DAYS)) await rm(path.join(DATA, 'events', f));
  // Umgebungsereignisse wie Ereignisse (+ 2 Tage Vorschau: heute, morgen); was die Prognose daraus gelernt hat, steht im Langzeitgedächtnis
  if (existsSync(incidentDir)) for (const f of (await readdir(incidentDir)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(0, -(HISTORY_DAYS + 2))) await rm(path.join(incidentDir, f));
  const cellDays = (await readdir(cellsDir)).filter(f => /^\d{4}-\d{2}-\d{2}(\.json)?$/.test(f)).sort();
  for (const f of cellDays.filter(f => !f.endsWith('.json')).slice(0, -14)) await rm(path.join(cellsDir, f), { recursive: true, force: true });
  for (const f of cellDays.filter(f => f.endsWith('.json')).slice(0, -3)) await rm(path.join(cellsDir, f));
  await writeFile(path.join(DATA, 'events', 'index.json'), JSON.stringify({ days: (await readdir(path.join(DATA, 'events'))).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 10)).sort(), cellDays: (await readdir(cellsDir)).filter(f => /^\d{4}-\d{2}-\d{2}$/.test(f)).sort(), updatedAt: now, first: tr.first }));
  const ev = [...tr.hourly.values()].reduce((a, h) => { a.start += h.start.reduce((x, y) => x + y, 0); a.end += h.end.reduce((x, y) => x + y, 0); a.reloc += h.reloc.reduce((x, y) => x + y, 0); a.swap += h.swap.reduce((x, y) => x + y, 0); return a; }, { start: 0, end: 0, reloc: 0, swap: 0 });
  log(`Verfolgung: ${Object.keys(tr.state.v).length} Kennungen im Zustand${tr.first ? ' (erster Lauf)' : ` · Fahrten begonnen ${ev.start}, beendet ${ev.end}, Umsetzungen ${ev.reloc}, Akkutausch ${ev.swap}`} · lange Standzeiten ${tr.idleLong.length}`);
}

// Sport-Ereignisse (lib/pulse-context.js SPORT): Heimspiele 1.–3. Liga aus OpenLigaDB (ODbL), je Liga höchstens alle 6 h abgefragt; Spielorte aus
// data/sport-spielorte.json → sport.json (kompakte Spiele im Fenster, Einträge wie data/ereignisse.json, Vereine ohne Spielort). In die Prognose
// (Merkmal event) erst ab aktivAb – gesammelt wird vorher schon. Fällt OpenLigaDB aus, bleiben die zuletzt geholten Spiele. SPORT_URL leer = aus.
let sportCurated = [];
{
  const base = process.env.SPORT_URL ?? 'https://api.openligadb.de', sf = path.join(DATA, 'sport.json');
  try {
    const venues = JSON.parse(await readFile(process.env.SPORT_VENUES_FILE || path.join(ROOT, 'data', 'sport-spielorte.json'), 'utf8'));
    const prev = existsSync(sf) ? JSON.parse(await readFile(sf, 'utf8')) : null;
    let rows = Array.isArray(prev?.matches) ? prev.matches : []; const fetched = { ...(prev?.fetched || {}) };
    if (base) {
      const season = CX.sportSeason(now);
      for (const lg of CX.SPORT.leagues) {
        if (fetched[lg]?.at && now - fetched[lg].at < CX.SPORT.refreshH * 3600e3 && fetched[lg].season === season) continue;
        const ctrl = new AbortController(), tm = setTimeout(() => ctrl.abort(), 20e3);
        try {
          const r = await fetch(`${base}/getmatchdata/${lg}/${season}`, { headers: { 'User-Agent': UA, accept: 'application/json' }, signal: ctrl.signal });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const list = CX.compactMatches(await r.json(), lg);
          rows = [...rows.filter(x => x[1] !== lg), ...list]; fetched[lg] = { at: now, season, n: list.length };
        } catch (e) { fetched[lg] = { ...(fetched[lg] || {}), failedAt: now, error: String(e?.message || e).slice(0, 80) }; log(`Sport ${lg}: ${e?.message || e}`); } finally { clearTimeout(tm); }
      }
    }
    // nur das Fenster behalten, das die Prognose braucht (rückwärts Training und Gedächtnis, vorwärts Ansetzungen der nächsten Wochen)
    rows = rows.filter(x => x[2] >= now - CX.SPORT.pastDays * 86400e3 && x[2] <= now + CX.SPORT.keepAheadDays * 86400e3).sort((a, b) => a[2] - b[2] || String(a[0]).localeCompare(String(b[0])));
    const sp = CX.sportEntries(rows, venues, { now, resolve: CX.placeResolver(boundaries?.features), base: base || 'https://api.openligadb.de' });
    const activeFrom = Date.parse(venues.aktivAb ?? ''), active = !Number.isFinite(activeFrom) || now >= activeFrom;
    sportCurated = active ? CX.checkCurated({ ereignisse: sp.entries }).ok : [];
    await writeFile(sf, JSON.stringify({ version: 1, at: now, source: 'OpenLigaDB (https://www.openligadb.de), Open Database License (ODbL) 1.0', license: 'ODbL-1.0', leagues: CX.SPORT.leagues,
      window: { beforeMin: CX.SPORT.beforeMin, afterMin: CX.SPORT.afterMin, pastDays: CX.SPORT.pastDays, aheadDays: CX.SPORT.aheadDays }, activeFrom: venues.aktivAb ?? null, active, fetched,
      matchFields: ['id', 'liga', 'anstoss_utc_ms', 'heim', 'gast'], matches: rows, entries: sp.entries, unknown: sp.unknown, noAgs: sp.noAgs }));
    if (sp.unknown.length || sp.noAgs.length) log(`Sport: ohne Spielort ${sp.unknown.join(', ') || '–'} · ohne Gemeinde ${sp.noAgs.join(', ') || '–'}`);
    log(`Sport: ${rows.length} Spiele im Fenster, ${sp.entries.length} Heimspiele als Veranstaltung${active ? ' (in der Prognose)' : ` (in der Prognose ab ${venues.aktivAb})`}`);
  } catch (e) { log(`Sport: ${e.message}`); }
}

// Veranstaltungen an großen Orten (lib/pulse-context.js VENUES): Orte ab 5.000 Plätzen aus Wikidata (CC0, wöchentlich, Gemeinde über die Grenzen),
// Veranstaltungen dort aus der Ticketmaster Discovery API (kostenloser Schlüssel TICKETMASTER_KEY, Kontingent 5.000 Abrufe am Tag; nur Orte in Gemeinden
// mit Sharing-Daten, je Lauf höchstens VENUES.perRun Orte, jeder alle 6 h; 14 Tage voraus, 60 Tage zurück) → veranstaltungen.json (Liste mit Ort,
// Adresse, Plätzen, Kategorie). In die Prognose wie data/ereignisse.json erst ab veranstaltungenAb. WIKIDATA_URL leer = keine Orte; ohne Schlüssel nur Orte.
let venueCurated = [];
{
  const vf = path.join(DATA, 'veranstaltungen.json');
  try {
    const prev = existsSync(vf) ? JSON.parse(await readFile(vf, 'utf8')) : null;
    let venues = Array.isArray(prev?.venues) ? prev.venues : [], venuesAt = prev?.venuesAt ?? null, rows = Array.isArray(prev?.events) ? prev.events : [];
    const fetchedAt = { ...(prev?.fetchedAt || {}) }, V = CX.VENUES, wd = process.env.WIKIDATA_URL ?? 'https://query.wikidata.org/sparql';
    const get = async (url, ms) => { const ctrl = new AbortController(), tm = setTimeout(() => ctrl.abort(), ms); try { return await fetch(url, { headers: { 'User-Agent': UA, accept: 'application/json' }, signal: ctrl.signal }); } finally { clearTimeout(tm); } };
    if (wd && (!venuesAt || now - venuesAt > V.refreshDays * 86400e3)) {
      try {
        const r = await get(`${wd}?format=json&query=${encodeURIComponent(CX.wikidataVenueQuery())}`, 60e3); if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const list = CX.parseVenues(await r.json());
        if (list.length) { venues = list.map(v => ({ ...v, ags: index ? C.assignMunicipality(index, v.lat, v.lon)?.ags ?? null : null })); venuesAt = now; }
      } catch (e) { log(`Veranstaltungsorte (Wikidata): ${e?.message || e}`); }
    }
    const covered = venues.filter(v => v.ags && munis.has(v.ags)), key = process.env.TICKETMASTER_KEY, tm = process.env.TICKETMASTER_URL ?? 'https://app.ticketmaster.com/discovery/v2';
    if (key && tm && covered.length) {
      const due = covered.filter(v => !(now - (fetchedAt[v.id] || 0) < V.refreshH * 3600e3)).slice(0, V.perRun), iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const got = []; let ok = 0, fail = 0; const t0 = Date.now();
      for (const v of due) {
        if (Date.now() - t0 > 45e3) break;
        try {
          const r = await get(`${tm}/events.json?apikey=${encodeURIComponent(key)}&latlong=${v.lat},${v.lon}&radius=${V.radiusKm}&unit=km&startDateTime=${iso(now - 12 * 3600e3)}&endDateTime=${iso(now + V.aheadDays * 86400e3)}&size=200&sort=date,asc&locale=*`, 15e3);
          if (r.status === 429) { fail++; break; } if (!r.ok) throw new Error(`HTTP ${r.status}`);
          got.push(...CX.parseTmEvents(await r.json())); fetchedAt[v.id] = now; ok++;
        } catch { fail++; }
        await new Promise(res => setTimeout(res, 600)); // höchstens 2 Abrufe je Sekunde
      }
      // neu Abgerufenes ersetzt Gespeichertes desselben Orts im abgefragten Zeitraum (verschobene oder abgesagte Termine verschwinden)
      const doneIds = new Set(due.filter(v => fetchedAt[v.id] === now).map(v => v.id));
      rows = [...rows.filter(r => !(doneIds.has(r[3]) && r[2] >= now - 12 * 3600e3)), ...CX.matchEvents(got, venues)];
      log(`Veranstaltungen (Ticketmaster): ${ok} Orte abgefragt${fail ? `, ${fail} Fehler` : ''}, ${got.length} Termine`);
    }
    // Fenster, und je Ort und Beginn nur eine Zeile (Pakete, Logen)
    const seen = new Set(); rows = rows.filter(r => r[2] >= now - V.pastDays * 86400e3 && r[2] <= now + V.aheadDays * 86400e3).sort((a, b) => a[2] - b[2] || String(a[3]).localeCompare(String(b[3])) || a[1].length - b[1].length).filter(r => { const k = `${r[3]}|${r[2]}`; if (seen.has(k)) return false; seen.add(k); return true; });
    venueCurated = CX.checkCurated({ ereignisse: CX.venueEntries(rows, venues, { now }) }).ok;
    await writeFile(vf, JSON.stringify({ version: 1, at: now, sources: { orte: 'Wikidata (CC0 1.0): Bauwerke in Deutschland mit Kapazität (P1083) ab ' + V.minCap + ' Plätzen', veranstaltungen: key ? 'Ticketmaster Discovery API (Nutzungsbedingungen von Ticketmaster: nur nichtkommerziell, Speicherung begrenzt – hier 60 Tage)' : 'keine (TICKETMASTER_KEY fehlt)' },
      venuesAt, venueFields: 'id (Wikidata), name, cap (Plätze), lat, lon, web, addr, types, ags', venues, fetchedAt, eventFields: ['id', 'name', 'beginn_utc_ms', 'ort', 'kategorie', 'genre', 'url'], events: rows, entries: venueCurated.length }));
    log(`Veranstaltungsorte: ${venues.length} (${covered.length} in Gemeinden mit Sharing-Daten), ${rows.length} Termine, ${venueCurated.length} für die Prognose${key ? '' : ' · ohne TICKETMASTER_KEY keine Termine'}`);
  } catch (e) { log(`Veranstaltungen: ${e?.message || e}`); }
}

// Prognose-Engine (lib/pulse-forecast.js): ein gepooltes Modell über alle Anbieter und Gemeinden, Selbstprüfung per Rolling Origin (ein Tag voraus)
// und Live-Abgleich ausgegebener Prognosen mit der Realität → forecast/latest.json (nächste 24 Stunden) und forecast/log.json. Höchstens alle
// FORECAST_EVERY_MIN Minuten (Standard 60); FORECAST=0 = aus. Bei Fehler bleiben die alten Dateien.
// forecast/series.json: Stundenreihen fürs Dashboard (Plan heute eingefroren, Ist, Live-Prognose bis Ende morgen, je Anbieter, Art, Gemeinde und große Gruppe).
if (process.env.FORECAST !== '0') {
  try {
    const dir = path.join(DATA, 'forecast'), fLatest = path.join(dir, 'latest.json'), fLog = path.join(dir, 'log.json'), fSeries = path.join(dir, 'series.json');
    const rd = async (f) => (existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : null);
    const prevLatest = await rd(fLatest), every = (process.env.FORECAST_EVERY_MIN != null ? +process.env.FORECAST_EVERY_MIN : 60) * 60e3;
    if (!prevLatest || !(now - Date.parse(prevLatest.generatedAt) < every)) {
      const list = async (d, n) => (existsSync(d) ? (await readdir(d)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(-n).map(f => path.join(d, f)) : []);
      const docs = []; for (const f of await list(path.join(DATA, 'events'), 21)) docs.push(JSON.parse(await readFile(f, 'utf8')));
      const weather = []; for (const f of await list(path.join(DATA, 'weather'), 30)) weather.push(JSON.parse(await readFile(f, 'utf8')));
      const red = new Set(Object.entries(latest.eventChecks?.groups || {}).filter(([, g]) => g?.level === 'bad').map(([k]) => k)); // rote Ampel: nicht plausibel gezählt
      // Umgebung: Warnungen und Autobahn (incidents/), gepflegte Ereignisliste (data/ereignisse.json im Repo; fehlerhafte Einträge werden gemeldet und übersprungen)
      const incidents = []; for (const f of await list(path.join(DATA, 'incidents'), 25)) { try { incidents.push(JSON.parse(await readFile(f, 'utf8'))); } catch {} }
      const curDoc = await rd(path.join(ROOT, 'data', 'ereignisse.json')), cur = CX.checkCurated(curDoc); if (cur.bad.length) log(`Ereignisliste: ${cur.bad.length} Einträge übersprungen (${cur.bad.slice(0, 3).join('; ')})`);
      // Veranstaltungen (Konzerte, Feste) wie Sport erst ab veranstaltungenAb in die Prognose (Ende der Lernphase); Streiks sofort
      const evFrom = Date.parse(curDoc?.veranstaltungenAb ?? ''), evOn = !Number.isFinite(evFrom) || now >= evFrom;
      const curOk = evOn ? cur.ok : cur.ok.filter(e => e.art !== 'veranstaltung');
      if (curOk.length < cur.ok.length) log(`Ereignisliste: ${cur.ok.length - curOk.length} Veranstaltungen vorgemerkt, in der Prognose ab ${curDoc.veranstaltungenAb}`);
      const t0 = Date.now(), res = FC.runForecast({ docs, calendar: await rd(path.join(DATA, 'calendar.json')), weather, incidents, curated: [...curOk, ...sportCurated, ...(evOn ? venueCurated : [])], prevLog: await rd(fLog), prevSeries: await rd(fSeries), now, exclude: red });
      await mkdir(dir, { recursive: true });
      await writeFile(fLatest, JSON.stringify(res.latest)); await writeFile(fLog, JSON.stringify(res.log)); await writeFile(fSeries, JSON.stringify(res.series));
      const l = res.latest;
      log(`Prognose: ${l.status}${l.active ? ` (${l.active}${l.weather.used ? ', mit Wetter' : ''}${l.env?.active?.length ? `, mit ${l.env.active.join(', ')}` : ''})` : ''}, ${l.trainDays} Tage Training, ${l.evalDays} ausgewertet, ${Object.keys(l.groups).length} Gruppen, Gedächtnis ${l.memory?.days ?? 0} Tage, ${Date.now() - t0} ms`);
    }
  } catch (e) { log(`Prognose: ${e.message} – alte Dateien bleiben`); }
}

// Aktive Gemeindegrenzen fürs Dashboard
if (boundaries) {
  const activeAgs = new Set(munis.keys());
  const feats = boundaries.features.filter(f => activeAgs.has(f.properties.ags));
  await writeFile(path.join(DATA, 'boundaries-active.json'), JSON.stringify({ type: 'FeatureCollection', attribution: boundaries.attribution, license: boundaries.license, generatedAt: latest.generatedAt, features: feats }));
  // je Bundesland (Q-6): boundaries/<Land>.json mit bbox je Gemeinde [minLon, minLat, maxLon, maxLat], dazu boundaries/index.json; Altdatei bleibt
  try {
    const bDir = path.join(DATA, 'boundaries'); await mkdir(bDir, { recursive: true });
    const byState = new Map();
    for (const f of feats) { const st = f.properties?.state || 'XX'; if (!byState.has(st)) byState.set(st, []); byState.get(st).push({ ...f, bbox: C.geomBounds(f.geometry) }); }
    for (const f of await readdir(bDir)) if (/^[A-Z]{2}\.json$/.test(f) && !byState.has(f.slice(0, 2))) await rm(path.join(bDir, f));
    const states = {};
    for (const [st, list] of [...byState].sort((a, b) => a[0].localeCompare(b[0]))) {
      const doc = JSON.stringify({ type: 'FeatureCollection', state: st, attribution: boundaries.attribution, license: boundaries.license, generatedAt: latest.generatedAt, features: list });
      await writeFile(path.join(bDir, `${st}.json`), doc);
      const bb = list.map(f => f.bbox).filter(Boolean);
      states[st] = { features: list.length, bytes: doc.length, bbox: bb.length ? [Math.min(...bb.map(b => b[0])), Math.min(...bb.map(b => b[1])), Math.max(...bb.map(b => b[2])), Math.max(...bb.map(b => b[3]))] : null, ags: list.map(f => f.properties.ags) };
    }
    await writeFile(path.join(bDir, 'index.json'), JSON.stringify({ version: 1, generatedAt: latest.generatedAt, attribution: boundaries.attribution, license: boundaries.license, bboxFields: 'minLon,minLat,maxLon,maxLat', states }));
  } catch (e) { log(`Grenzen je Land: ${e.message}`); }
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
  const noLic = counted.filter(r => !r.licenseId && !r.licenseUrl), badLic = counted.filter(r => !r.licenseId && /privacy|datenschutz/i.test(r.licenseUrl || ''));
  const lines = [
    '# Daten und Lizenzen', '',
    `Stand: ${new Date(now).toISOString()} · erzeugt vom Sammler (scripts/collect.mjs) bei jedem Lauf.`, '',
    'Dieser Datenzweig enthält aus offenen Quellen abgeleitete Daten: Bestände, Ereignisse (Fahrten, Umsetzungen, Akkutausch), Zellen, Archiv und Momentaufnahmen. Die Lizenzangaben stammen aus den Feeds (GBFS `system_information`: `license_id`, `license_url`, `attribution_organization_name`) bzw. aus den Verzeichnissen; maßgeblich sind die Bedingungen der jeweiligen Quelle. Je Quelle stehen sie auch in `latest.json` → `sources[]` (`licenseId`, `licenseUrl`, `attribution`, `attributionUrl`).', '',
    '## Veröffentlichung von Ereignissen und Zellen', '',
    'Ereignisse (`events/<Tag>.json`) erscheinen für den laufenden Tag erst nach Stundenende und enthalten nur abgeschlossene Stunden. Zellen (`cells/<Tag>/<Land>.json`) erscheinen erst nach dem Ende eines Tageszeit-Bands und enthalten nur abgeschlossene Bänder. Nach Tagesende folgen beide vollständig (`published.complete`). In Zellendateien ist jede Zelle × Band mit weniger als 3 Ereignissen (Fahrtbeginne + Fahrtenden) unterdrückt; diese Summen stehen je Gemeinde in `below`. Läge dort weniger als 3 (also womöglich eine einzelne Zelle), fällt zusätzlich die kleinste veröffentlichte Zelle des Bands in `below` (`suppress: 2`). Start-Ziel-Ströme (`flows/<Tag>.json`) erscheinen erst nach Tagesende und nur für Zellenpaare mit mindestens ' + T.FLOW_MIN + ' Fahrten am Tag; geschätzte Ströme (`flows-est/`) ab ' + FE.EST_MIN + ' erwarteten Fahrten. Fahrzeugkennungen werden nicht veröffentlicht; sie bleiben privat (HMAC mit privatem Salt).', '',
    '## Live-Bestand und Momentaufnahmen', '',
    'Veröffentlicht wird der jeweils letzte Bestand ohne Kennung: `ops/<Land>.json` (je sichtbarem Fahrzeug Position, Anbieter, Art, Ladestand, Reichweite, Standzeit-Klasse) und `snapshot/<Quelle>.json` (Bestand von Quellen, die der Browser nicht selbst lesen kann). Reichweite in ganzen km (Quellen mit eigener Reichweiten-Skala: 0,1 km). Die Standzeit erscheint nur als Klasse: unter 6 h, 6–24 h, danach ganze Tage (auch `idle-long.json`). Eine minutengenaue Standzeit zeigte, wann an einer Adresse die letzte Fahrt endete. Frühere Bestände bleiben nicht im Datenzweig (ein Commit je Lauf ohne Vorgänger).', '',
    '## Grundlagen', '',
    `- Gemeindegrenzen: ${md(boundaries?.attribution || '© GeoBasis-DE / BKG, VG250')} – Lizenz Datenlizenz Deutschland – Namensnennung – Version 2.0 (dl-de/by-2-0, https://www.govdata.de/dl-de/by-2-0).`,
    '- Umgebung (`context/`: ÖPNV-Haltepunkte, Abstellflächen): © OpenStreetMap-Mitwirkende, Open Database License 1.0 (ODbL, https://opendatacommons.org/licenses/odbl/1-0/).',
    '- Wetter-Cache (`weather/<Tag>.json`): Beobachtungen und Vorhersage (MOSMIX) des Deutschen Wetterdienstes (DWD Open Data), abgerufen über Bright Sky (https://brightsky.dev). Quelle: Deutscher Wetterdienst; Nutzungsbedingungen des DWD gelten (Quellenvermerk-Wortlaut noch nicht amtlich geprüft).',
    '- Umgebungsereignisse (`incidents/<Tag>.json`, nur Kennzeichen je Gemeinde und Stunde, keine Meldungstexte): Wetterwarnungen des Deutschen Wetterdienstes (DWD Open Data, über Bright Sky); Sperrungen und Staus auf Autobahnen aus der Verkehrsinformation der Autobahn GmbH des Bundes (verkehr.autobahn.de; ausdrückliche Nutzungsbedingungen der Schnittstelle nicht gefunden, Quelle: Die Autobahn GmbH des Bundes). Streiks und Veranstaltungen aus der gepflegten Liste `data/ereignisse.json` im Code-Zweig (je Eintrag mit Quelle).',
    '- Veranstaltungsorte und Termine (`veranstaltungen.json`): Orte mit Kapazität aus Wikidata (CC0 1.0); Termine aus der Ticketmaster Discovery API (Nutzungsbedingungen von Ticketmaster, nur nichtkommerziell; Termine werden höchstens 60 Tage behalten, je Termin mit Link zu Ticketmaster).',
    '- Sport-Ereignisse (`sport.json`: Heimspiele 1.–3. Liga mit Anstoßzeit, daraus Veranstaltungen je Stadion-Gemeinde): Spielpläne aus OpenLigaDB (https://www.openligadb.de), Open Database License 1.0 (ODbL); `sport.json` steht unter der ODbL 1.0.',
    '- Prognose (`forecast/latest.json`, `forecast/log.json`, `forecast/series.json`): abgeleitet aus den Ereignissen dieses Datenstands, dem Tagtyp-Kalender, dem Wetter-Cache und den Umgebungsereignissen; statistisches Modell des Projekts, keine Betreiberdaten.',
    '- Tagtyp-Kalender (`calendar.json`: gesetzliche Feiertage und Schulferien je Land): OpenHolidays API (https://www.openholidaysapi.org), Open Database License 1.0 (ODbL); `calendar.json` steht unter der ODbL 1.0.',
    '- Verzeichnisse: MobilityData GBFS systems.csv, MobiData BW, MOBIDROM NRW, CityBikes, Betreiber-Direktfeeds.', '',
    '## Quellen nach Lizenz', '',
    `${counted.length} Quellen mit Daten in diesem Stand (Kopien anderer Quellen und nicht erreichbare Quellen ausgenommen).`, '',
    '| Lizenz | Quellen | Namensnennung / Anbieter |', '|---|---|---|',
    ...lic.map(([k, list]) => { const names = [...new Set(list.map(r => r.attribution || r.systemOperator || r.operator).filter(Boolean).map(md))]; const url = list.find(r => r.licenseUrl)?.licenseUrl; return `| ${md(k)}${url && url !== k ? ` (${md(url)})` : ''} | ${list.length} | ${names.slice(0, 25).join(', ')}${names.length > 25 ? ` u. a. (${names.length})` : ''} |`; }),
    '', '## Weitergabe unter gleichen Bedingungen', '',
    sa.length ? `${sa.length} Quellen stehen unter CC BY-SA (${[...new Set(sa.map(r => md(r.operator)))].join(', ')}). Daten, die aus diesen Quellen abgeleitet sind (Bestände, Ereignisse, Zellen, Archiv der betroffenen Gebiete und Anbieter), stehen unter CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/).` : 'In diesem Stand liefert keine Quelle Daten unter CC BY-SA.',
    'Aus OpenStreetMap abgeleitete Datenbankteile (`context/`) stehen unter der ODbL 1.0.',
    '', `Quellen ohne Lizenzangabe sind oben als „ohne Angabe“ geführt (${noLic.length}${noLic.length ? `: ${[...new Set(noLic.map(r => md(r.operator)))].join(', ')}` : ''}). Ihre Lizenz ist ungeklärt; sie gelten hier nicht als gemeinfrei (CC0). Maßgeblich sind die Nutzungsbedingungen des jeweiligen Betreibers bzw. Verzeichnisses.`,
    ...(badLic.length ? [`Bei ${badLic.length} Quelle${badLic.length === 1 ? '' : 'n'} (${[...new Set(badLic.map(r => md(r.operator)))].join(', ')}) führt der Lizenz-Link zu einer Datenschutzerklärung, nicht zu einer Lizenz: Lizenz ebenfalls ungeklärt.`] : []), '',
  ];
  await writeFile(path.join(DATA, 'DATA-LICENSE.md'), lines.join('\n'));
}
// Sammler-Monitor: ein Eintrag je Lauf, 7 Tage (Lücken, Ausfälle, Zählungen)
{
  const f = path.join(DATA, 'runs.json');
  const doc = existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : { runs: [] };
  doc.fields = ['at', 'dauer_ms', 'quellen', 'aktuell', 'verzoegert', 'veraltet', 'fehler', 'fahrzeuge', 'stationen', 'fahrten', 'fahrtenden', 'kennungswechsel', 'ausloeser', 'zaehlt', 'regelstand'];
  const st = statusCounts;
  // zaehlt: 1 = Lauf zählt Ereignisse, 0 = Lauf nach Lücke bzw. Umzugslauf (ohne Zählung); regelstand wie events/<Tag>.json → runs[k][3]
  doc.runs.push([now, Date.now() - now, sourceOut.length, st.live || 0, st.delayed || 0, st.stale || 0, failing, dv.vehicles.length, ds.stations.length, runEv?.start ?? null, runEv?.end ?? null, runEv?.rot ?? null, process.env.GITHUB_EVENT_NAME || 'lokal', tr.gap ? 0 : 1, RULE]);
  doc.runs = doc.runs.filter(r => now - r[0] <= 7 * 86400e3).slice(-600);
  await writeFile(f, JSON.stringify(doc));
  // Ausfall-Wächter (HEALTH_FILE, z. B. für Healthchecks.io im Workflow): Zeile 1 „ok“ oder „fail“, Zeile 2 Grund. „fail“, wenn weniger als
  // HEALTH.minShare der Quellen aktuell oder verzögert liefern als im Median der letzten 7 Tage (grüner Lauf mit Teilausfall)
  if (process.env.HEALTH_FILE) {
    const okOf = (r) => (r[3] || 0) + (r[4] || 0), prev = doc.runs.slice(0, -1).map(okOf).sort((a, b) => a - b);
    const med = prev.length >= 12 ? prev[Math.floor(prev.length / 2)] : null, cur = okOf(doc.runs[doc.runs.length - 1]);
    const fail = med != null && cur < HEALTH.minShare * med;
    await writeFile(process.env.HEALTH_FILE, `${fail ? 'fail' : 'ok'}\n${cur} Quellen aktuell/verzögert${med != null ? ` (Median 7 Tage ${med}, Schwelle ${Math.ceil(HEALTH.minShare * med)})` : ''} · ${dv.vehicles.length} Fahrzeuge · ${((Date.now() - now) / 1000).toFixed(0)} s\n`);
  }
}
log(`fertig in ${((Date.now() - now) / 1000).toFixed(1)} s · Status:`, JSON.stringify(statusCounts));
