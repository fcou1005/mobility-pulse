#!/usr/bin/env node
// Sammler: ruft alle Quellen ab, normalisiert, ordnet Gemeinden zu, dedupliziert, aggregiert.
// Schreibt data/latest.json, data/status.json, data/history/YYYY-MM-DD.json, data/snapshot/*.json, data/boundaries-active.json
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as C from '../lib/pulse-core.js';

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
  if (src.parent) { const guess = C.operatorFromName(`${sys.systemInfo?.operator || ''} ${sys.systemInfo?.name || ''} ${src.id.split(':').pop()}`, manual.operator_aliases); if (guess) { rec.operator = guess; src.operator = guess; } }
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
  if (src.auth && usable) {
    snapshots.push({ id: src.id, at: now, feedAgeMs: rec.feedAgeMs, operator: src.operator,
      vehicles: sys.vehicles.filter(v => v.geoStatus === 'ok').map(v => [+v.lat.toFixed(5), +v.lon.toFixed(5), v.type, (v.reserved ? 1 : 0) | (v.disabled ? 2 : 0), v.batteryPct != null ? Math.round(v.batteryPct) : null, v.rangeKm != null ? +v.rangeKm.toFixed(1) : null]),
      stations: sys.stations.filter(s => C.validLatLon(s.lat, s.lon)).map(s => [+s.lat.toFixed(5), +s.lon.toFixed(5), s.name, s.physicalAvailable, s.bookable, s.docksAvailable, s.renting ? 1 : 0, s.returning ? 1 : 0]) });
  }
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

// Aktive Gemeindegrenzen fürs Dashboard
if (boundaries) {
  const activeAgs = new Set(munis.keys());
  const feats = boundaries.features.filter(f => activeAgs.has(f.properties.ags));
  await writeFile(path.join(DATA, 'boundaries-active.json'), JSON.stringify({ type: 'FeatureCollection', attribution: boundaries.attribution, license: boundaries.license, generatedAt: latest.generatedAt, features: feats }));
  log(`Aktive Gemeinden: ${feats.length}`);
}
log(`fertig in ${((Date.now() - now) / 1000).toFixed(1)} s · Status:`, JSON.stringify(statusCounts));
