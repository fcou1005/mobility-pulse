import * as C from './pulse-core.js?v=mvww5n1y';
import { initOps, renderOps } from './ops.js?v=mvww5n1y';
import * as E from './pulse-econ.js?v=mvww5n1y';

const CFG = {
  DATA: (() => { const d = new URLSearchParams(location.search).get('data'); return d && /^(\/|https?:\/\/(localhost|127\.0\.0\.1)[:/])/.test(d) ? d : 'https://raw.githubusercontent.com/fcou1005/mobility-pulse/data/'; })(), // ?data=/pfad/ nur lokal, für Tests
  MAIN: 'https://raw.githubusercontent.com/fcou1005/mobility-pulse/main/data/',
  REPO: 'https://github.com/fcou1005/mobility-pulse',
  WFS: 'https://api.mobidata-bw.de/geoserver/MobiData-BW/ows',
  OVERPASS: ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'],
  OSRM_FOOT: 'https://routing.openstreetmap.de/routed-foot',
  VALHALLA: 'https://valhalla1.openstreetmap.de',
  MAX_POINTS: 6000,
};
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, d = 0) => n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('de-DE', { maximumFractionDigits: d, minimumFractionDigits: d });
const pctf = (a, b) => b ? `${fmt((a / b) * 100, a / b < 0.1 ? 1 : 0)} %` : 'k. A.';
const ageText = (ms) => ms == null ? '–' : ms < 90e3 ? 'gerade' : ms < 3600e3 ? `${Math.round(ms / 60e3)} Min.` : ms < 48 * 3600e3 ? `${(ms / 3600e3).toFixed(1).replace('.', ',')} Std.` : `${Math.round(ms / 86400e3)} Tg.`;
const timeText = (ms) => ms ? new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '–';
const TYPE = C.VEHICLE_TYPE_LABEL;
const STATUS = { ...C.FRESHNESS_LABEL, collector: 'Sammler-Stand' };
const DIRS = { mobilitydata: 'MobilityData / Betreiber', mobidata_bw: 'MobiData BW', mobidrom_nrw: 'MOBIDROM NRW', citybikes: 'CityBikes', dott_direct: 'Dott · Direktfeed', lime_direct: 'Lime · Direktfeed', zeus_direct: 'Zeus · Direktfeed', bird_direct: 'Bird · Direktfeed', db_api: 'DB API Marketplace' };
const OP_COLORS = { Bolt: '#34d399', Dott: '#60a5fa', Voi: '#f472b6', Lime: '#a3e635', nextbike: '#f59e0b', Zeus: '#c084fc', Donkey: '#fb923c', Bird: '#e879f9', 'DB Connect': '#ef4444', Yoio: '#22d3ee', sigo: '#fbbf24', StadtRAD: '#f87171' };
const opColor = (op) => OP_COLORS[op] || `hsl(${parseInt(C.hashStr(op), 36) % 360} 60% 60%)`;

const state = {
  latest: null, catalog: null, status: null, histIndex: null, hist: {}, boundaries: null, bIndex: null,
  scope: 'DE', operator: 'all', type: 'all', mode: 'collector',
  live: null, // {at, systems: Map(id→sys), groups, vehicles, stations, recs: Map}
  thresholds: { charge: 20, range: 5 },
  map: null, layers: {}, supply: null, histDay: null,
};

// ---------- Laden ----------
async function getJson(url, { timeout = 25000 } = {}) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeout);
  const t0 = performance.now();
  try {
    const r = await fetch(url, { signal: ctrl.signal, cache: 'no-cache' });
    clearTimeout(t);
    let json = null, error = null;
    if (r.ok) { try { json = await r.json(); } catch { error = 'kein JSON'; } }
    return { ok: r.ok && !!json, status: r.status, json, error, latencyMs: Math.round(performance.now() - t0) };
  } catch (e) { clearTimeout(t); return { ok: false, status: 0, json: null, error: e.name === 'AbortError' ? 'Timeout' : 'Netz/CORS', latencyMs: Math.round(performance.now() - t0) }; }
}
function notice(html, kind = '', id = null) {
  const box = $('#notice');
  const el = id && $(`#notice [data-id="${id}"]`) || document.createElement('div');
  el.className = `note ${kind}`; if (id) el.dataset.id = id; el.innerHTML = html; if (!el.parentNode) box.appendChild(el); return el;
}
const clearNotice = (id) => $(`#notice [data-id="${id}"]`)?.remove();

async function loadBase() {
  const [status, latest, sources, hist] = await Promise.all([getJson(CFG.DATA + 'status.json'), getJson(CFG.DATA + 'latest.json'), getJson(CFG.DATA + 'sources.json'), getJson(CFG.DATA + 'history/index.json')]);
  state.status = status.json; state.latest = latest.json; state.histIndex = hist.json;
  state.catalog = sources.json || (await getJson(CFG.MAIN + 'sources.json')).json;
  if (state.status?.at && Date.now() - state.status.at > 45 * 60e3) notice(`Der letzte Sammler-Lauf ist ${ageText(Date.now() - state.status.at)} alt (Plan: alle 20 Min.). Zahlen gelten für ${new Date(state.status.at).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}; <a href="${CFG.REPO}/actions">Läufe ansehen</a>.`, 'warn', 'stale');
  if (!state.latest) {
    notice(`Der Sammler hat noch keinen Datenstand veröffentlicht (<a href="${CFG.REPO}/actions">Actions</a>). Live-Abruf funktioniert trotzdem; Ortszuordnung erst nach dem ersten Lauf.`, 'warn', 'nolatest');
    state.mode = 'live'; $('#sel-mode').value = 'live';
  }
}
async function loadBoundaries() {
  if (state.bIndex) return state.bIndex;
  const r = await getJson(CFG.DATA + 'boundaries-active.json', { timeout: 60000 });
  if (!r.ok) return null;
  for (const f of r.json.features || []) if (!f.bbox) { const c = JSON.stringify(f.geometry?.coordinates || []).match(/-?\d+(\.\d+)?/g) || []; let x0 = 999, y0 = 999, x1 = -999, y1 = -999; for (let i = 0; i + 1 < c.length; i += 2) { const x = +c[i], y = +c[i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } f.bbox = [x0, y0, x1, y1]; }
  state.boundaries = r.json; state.bIndex = C.buildMunicipalityIndex(r.json);
  return state.bIndex;
}
async function loadHistory(day) {
  if (state.hist[day]) return state.hist[day];
  const r = await getJson(CFG.DATA + `history/${day}.json`, { timeout: 60000 });
  state.hist[day] = r.json || null; return state.hist[day];
}

// ---------- Scope ----------
const muniName = (ags) => state.latest?.municipalities?.[ags]?.name || state.boundaries?.features.find(f => f.properties.ags === ags)?.properties.name || ags;
const muniInfo = (ags) => state.latest?.municipalities?.[ags] || null;
function scopeLabel() { return state.scope === 'DE' ? 'Deutschlandweit' : `${muniName(state.scope)} (${muniInfo(state.scope)?.state || ''})`; }
function keyMatches(key) {
  const [ags, op, ty] = key.split('|');
  if (state.scope === 'DE' ? ags === 'DE' : ags !== state.scope) return false;
  if (state.operator !== 'all' && op !== state.operator) return false;
  if (state.type !== 'all' && ty !== state.type) return false;
  return true;
}
// Gruppen der aktuellen Datenbasis (Sammler oder Live) auf den Scope gefiltert
function scopeGroups() {
  const src = state.mode === 'live' && state.live ? state.live.groups : new Map(Object.entries(state.latest?.groups || {}));
  const out = new Map();
  for (const [k, st] of src) {
    const [ags, op, ty] = k.split('|');
    if (ags === 'DE') continue;
    if (state.scope !== 'DE' && ags !== state.scope) continue;
    if (state.operator !== 'all' && op !== state.operator) continue;
    if (state.type !== 'all' && ty !== state.type) continue;
    out.set(k, st);
  }
  return out;
}
function sourcesForScope() {
  const recs = state.latest?.sources || [];
  if (state.scope === 'DE') return recs;
  return recs.filter(r => (r.municipalities || []).includes(state.scope));
}
function liveRec(id) { return state.live?.recs.get(id) || null; }
// Anbieter-Übersicht für den Scope
function operatorRows() {
  const groups = scopeGroups();
  const byOp = new Map();
  for (const [k, st] of groups) { const op = k.split('|')[1]; if (!byOp.has(op)) byOp.set(op, []); byOp.get(op).push(st); }
  const recs = sourcesForScope();
  const rows = [];
  for (const [op, list] of byOp) {
    const st = C.sumStats(list);
    const ops = recs.filter(r => r.operator === op);
    const effective = ops.map(r => liveRec(r.id) || r);
    const usable = effective.filter(r => r.status === 'live' || r.status === 'delayed' || r.status === 'collector');
    const age = usable.length ? Math.max(...usable.map(r => r.feedAgeMs ?? 0)) : (effective[0]?.feedAgeMs ?? null);
    const status = usable.some(r => r.status === 'live') ? 'live' : usable.length ? 'delayed' : (effective[0]?.status || 'unknown');
    const ageAdj = effective.some(r => r.status === 'collector') && state.latest ? (Date.now() - state.latest.at) : 0;
    const dirs = [...new Set(effective.flatMap(r => r.directories || []))];
    const license = effective.map(r => r.license).find(Boolean) || null;
    const quality = usable.length ? Math.round(usable.reduce((a, r) => a + (r.quality || 0), 0) / usable.length) : null;
    const changed = effective.some(r => r.sourceChanged);
    rows.push({ op, st, sources: effective, status, age: age != null ? age + ageAdj : null, dirs, license, quality, changed, delta: deltaVsCollector(op) });
  }
  // Bekannte Lücken im Scope
  for (const g of state.latest?.gaps || []) {
    const ags = state.scope === 'DE' ? null : state.scope;
    if (ags && muniName(ags) !== g.city) continue;
    if (state.operator !== 'all' && g.operator !== state.operator) continue;
    if (byOp.has(g.operator) && ags) continue;
    rows.push({ op: g.operator, st: C.emptyStats(), sources: [], status: 'gap', age: null, dirs: [], license: null, quality: null, gap: g, delta: null });
  }
  rows.sort((a, b) => b.st.available - a.st.available || a.op.localeCompare(b.op));
  return rows;
}
// Δ gegenüber letztem Sammler-Punkt (nur sinnvoll im Live-Modus, gleicher Fingerabdruck)
function deltaVsCollector(op) {
  if (state.mode !== 'live' || !state.live || !state.latest) return null;
  const recs = sourcesForScope().filter(r => r.operator === op);
  if (!recs.length || recs.some(r => { const l = liveRec(r.id); return l && r.fingerprint && l.fingerprint && l.fingerprint !== r.fingerprint; })) return null;
  let a = 0, b = 0;
  for (const [k, st] of state.live.groups) if (keyMatchesOp(k, op)) a += st.available;
  for (const [k, st] of Object.entries(state.latest.groups)) if (keyMatchesOp(k, op)) b += st.available;
  return { diff: a - b, sinceMs: Date.now() - state.latest.at };
}
function keyMatchesOp(k, op) { const [ags, o, ty] = k.split('|'); if (ags === 'DE') return false; if (state.scope !== 'DE' && ags !== state.scope) return false; if (o !== op) return false; if (state.type !== 'all' && ty !== state.type) return false; return true; }

// ---------- Live-Abruf ----------
async function liveFetch() {
  const cat = state.catalog?.sources || [];
  const recs = sourcesForScope();
  const idSet = new Set(recs.map(r => r.id));
  // Katalogquellen für den Scope; ohne Sammler-Stand: alles (mit Fortschritt)
  let targets = cat.filter(s => !s.disabled && (state.scope === 'DE' && !state.latest ? true : idSet.has(s.id) || idSet.has(`${s.id}`) || recs.some(r => r.parent === s.id)));
  if (state.scope !== 'DE' && !targets.length) targets = cat.filter(s => !s.disabled);
  const btn = $('#btn-live'); btn.disabled = true;
  const n = notice(`Live-Abruf: <span class="mono" id="live-prog">0 / ${targets.length}</span> Quellen <div class="progress"><i></i></div>`, '', 'live');
  await loadBoundaries();
  const systems = new Map(), recsOut = new Map();
  let done = 0; const now = Date.now();
  const worker = async (src) => {
    try {
      const subs = recs.filter(r => r.parent === src.id);
      if (src.auth || subs.length) {
        // Zugangsquellen (MOBIDROM): Momentaufnahme des Sammlers
        for (const r of subs.length ? subs : [src]) {
          const snap = await getJson(CFG.DATA + `snapshot/${r.id.replace(/[^\w.-]+/g, '_')}.json`);
          if (snap.ok) { systems.set(r.id, snapshotToSystem(snap.json, r)); recsOut.set(r.id, summarizeSnapshot(src, r, snap.json, now)); }
          else recsOut.set(r.id, { ...r, status: 'collector', checkedAt: r.checkedAt });
        }
        return;
      }
      const known = recs.find(x => x.id === src.id);
      if (known?.cors === false) {
        // Sammler hat festgestellt: kein CORS-Header → gar nicht erst im Browser versuchen
        const snap = await getJson(CFG.DATA + `snapshot/${src.id.replace(/[^\w.-]+/g, '_')}.json`);
        if (snap.ok) { systems.set(src.id, snapshotToSystem(snap.json, src)); recsOut.set(src.id, summarizeSnapshot(src, known, snap.json, now)); return; }
        if (['live', 'delayed'].includes(known.status)) { recsOut.set(src.id, { ...known, status: 'collector', corsBlocked: true }); return; }
      }
      if (known?.candidate && !['live', 'delayed', 'stale', 'unknown'].includes(known.status)) { recsOut.set(src.id, known); return; }
      const sys = src.api === 'citybikes' ? await C.readCityBikesNetwork(src, getJson, { now }) : await C.readGbfsSystem(src, getJson, { now });
      if (sys.httpStatus === 0 && !sys.vehicles.length && !sys.stations.length) {
        // Browser darf die Quelle nicht lesen (kein CORS): Momentaufnahme des Sammlers
        const r = recs.find(x => x.id === src.id);
        const snap = await getJson(CFG.DATA + `snapshot/${src.id.replace(/[^\w.-]+/g, '_')}.json`);
        if (snap.ok) { systems.set(src.id, snapshotToSystem(snap.json, src)); recsOut.set(src.id, summarizeSnapshot(src, r, snap.json, now)); return; }
        if (r && ['live', 'delayed'].includes(r.status)) { recsOut.set(src.id, { ...r, status: 'collector', corsBlocked: true }); return; }
      }
      systems.set(src.id, sys);
      recsOut.set(src.id, summarize(src, sys, now));
    } finally { done++; const p = $('#live-prog'); if (p) p.textContent = `${done} / ${targets.length}`; const bar = $('#notice [data-id=live] .progress i'); if (bar) bar.style.width = `${(done / targets.length) * 100}%`; }
  };
  let i = 0; await Promise.all(Array.from({ length: 6 }, async () => { while (i < targets.length) await worker(targets[i++]); }));
  // Zusammenführen
  const vehicles = [], stations = [];
  for (const [id, sys] of systems) {
    const rec = recsOut.get(id); const usable = rec.status === 'live' || rec.status === 'delayed';
    if (!usable) continue;
    const src = cat.find(s => s.id === id) || recs.find(r => r.id === id) || {};
    const agsSet = new Set();
    for (const v of sys.vehicles) {
      if (v.geoStatus !== 'ok') continue;
      const m = state.bIndex ? C.assignMunicipality(state.bIndex, v.lat, v.lon) : null;
      const ags = m?.ags || 'unbekannt'; agsSet.add(ags);
      vehicles.push({ ...v, operator: rec.operator, sourceId: id, priority: src.priority ?? 2, ags, feedAgeMs: rec.vehicleFeedAgeMs });
    }
    for (const s of sys.stations) {
      if (!C.validLatLon(s.lat, s.lon)) continue;
      const m = state.bIndex ? C.assignMunicipality(state.bIndex, s.lat, s.lon) : null;
      const ags = m?.ags || 'unbekannt'; agsSet.add(ags);
      stations.push({ ...s, operator: rec.operator, sourceId: id, priority: src.priority ?? 2, ags, hasVehicleList: !!sys.vehicleListPresent, feedAgeMs: rec.stationFeedAgeMs });
    }
    rec.municipalities = [...agsSet];
  }
  vehicles.sort((a, b) => a.priority - b.priority);
  const dv = C.dedupeVehicles(vehicles), ds = C.dedupeStations(stations);
  const groups = C.aggregateGroups(dv.vehicles, ds.stations, { chargeThreshold: state.thresholds.charge, rangeThreshold: state.thresholds.range });
  // Quellen ohne Browserzugang und ohne Momentaufnahme: Sammler-Summen übernehmen
  const have = new Set([...groups.keys()].map(k => k.split('|').slice(0, 2).join('|')));
  for (const r of recsOut.values()) {
    if (r.status !== 'collector') continue;
    for (const ags of r.municipalities || []) { if (have.has(`${ags}|${r.operator}`)) continue; for (const [k, st] of Object.entries(state.latest?.groups || {})) if (k.startsWith(`${ags}|${r.operator}|`)) groups.set(k, { ...st }); }
  }
  state.live = { at: now, systems, groups, vehicles: dv.vehicles, stations: ds.stations, recs: recsOut, dedupe: { ...dv.stats, stationDuplicates: ds.duplicates }, targets: targets.length };
  clearNotice('live'); btn.disabled = false;
  const failed = [...recsOut.values()].filter(r => !['live', 'delayed', 'collector'].includes(r.status));
  if (failed.length) notice(`${failed.length} von ${recsOut.size} Quellen lieferten keine verwertbaren Live-Daten (${[...new Set(failed.map(r => STATUS[r.status] || r.status))].join(', ')}). Fehlende Anbieter bleiben aus dem Sammler-Stand sichtbar.`, 'warn', 'livefail'); else clearNotice('livefail');
  if (!state.bIndex) notice('Ohne Gemeindegrenzen (erster Sammler-Lauf fehlt) werden Live-Bestände nicht nach Ort getrennt.', 'warn', 'nob');
  state.mode = 'live'; $('#sel-mode').value = 'live';
  renderAll();
}
function summarize(src, sys, now) {
  const rec = { id: src.id, operator: src.operator, name: src.name, api: src.api, url: src.url, directories: src.directories, priority: src.priority ?? 2, status: 'error', httpStatus: sys.httpStatus, latencyMs: sys.latencyMs, errors: sys.errors, license: sys.systemInfo?.licenseId || sys.systemInfo?.licenseUrl || src.license || null, version: sys.version || null, feedAgeMs: null, vehicleFeedAgeMs: null, stationFeedAgeMs: null, fingerprint: null, quality: null, counts: { vehicles: sys.vehicles.length, stations: sys.stations.length }, municipalities: [], checkedAt: now };
  if (sys.httpStatus === 404 || sys.httpStatus === 410) rec.status = 'gone';
  else if (sys.httpStatus === 401 || sys.httpStatus === 403) rec.status = 'auth';
  else if (!sys.vehicles.length && !sys.stations.length) rec.status = sys.errors.length ? 'error' : 'empty';
  else {
    const vAge = sys.feedAges.vehicle_status ?? sys.feedAges.free_bike_status ?? null, sAge = sys.feedAges.station_status ?? null;
    const ages = [vAge, sAge].filter(a => a != null);
    rec.vehicleFeedAgeMs = vAge; rec.stationFeedAgeMs = sAge; rec.feedAgeMs = ages.length ? Math.max(...ages) : (sys.lastUpdated != null ? now - sys.lastUpdated : null);
    rec.status = C.freshness(rec.feedAgeMs);
  }
  rec.fingerprint = C.fingerprint(sys); rec.quality = C.qualityScore(sys, now).score;
  const prev = state.latest?.sources.find(r => r.id === src.id); rec.sourceChanged = !!(prev?.fingerprint && prev.fingerprint !== rec.fingerprint);
  return rec;
}
function summarizeSnapshot(src, rec, snap, now) {
  const age = (now - snap.at) + (snap.feedAgeMs || 0);
  return { ...(rec || {}), id: src.id, operator: rec?.operator || snap.operator || src.operator, name: src.name || rec?.name, api: src.api, url: src.url, directories: src.directories || rec?.directories || [], priority: src.priority ?? 2,
    status: C.freshness(age), feedAgeMs: age, vehicleFeedAgeMs: age, stationFeedAgeMs: age, snapshot: true, snapshotAt: snap.at, errors: [], httpStatus: rec?.httpStatus ?? null, quality: rec?.quality ?? null, fingerprint: rec?.fingerprint ?? null, license: rec?.license ?? null, checkedAt: snap.at, counts: { vehicles: (snap.vehicles || []).length, stations: (snap.stations || []).length } };
}
function snapshotToSystem(snap, rec) {
  return {
    vehicles: (snap.vehicles || []).map(([lat, lon, type, flags, battery, range], i) => ({ rawId: `${rec.id}#${i}`, lat, lon, type, reserved: !!(flags & 1), disabled: !!(flags & 2), batteryPct: battery, rangeKm: range, geoStatus: 'ok', geoOrigin: 'vehicle', reportedAt: snap.at, positionAgeMs: Date.now() - snap.at })),
    stations: (snap.stations || []).map(([lat, lon, name, phys, bookable, docks, renting, returning], i) => ({ id: `${rec.id}#s${i}`, name, lat, lon, physicalAvailable: phys, bookable, docksAvailable: docks, renting: !!renting, returning: !!returning, installed: true, reportedAt: snap.at, typeHint: 'unknown' })),
    vehicleListPresent: (snap.vehicles || []).length > 0, feedAges: {}, errors: [], systemInfo: {},
  };
}

// ---------- Rendering ----------
function setView(name) {
  const views = ['live', 'lab', 'usage', 'ops', 'signals', 'coverage', 'sources'];
  if (!views.includes(name)) name = 'live';
  $$('section.view').forEach(s => s.classList.toggle('active', s.id === `view-${name}`));
  $$('#nav a').forEach(a => a.classList.toggle('active', a.dataset.view === name));
  if (name === 'live') setTimeout(() => state.map?.invalidateSize(), 50);
  if (name === 'lab') { renderHistory(); renderPricing(); renderShareChart(); }
  if (name === 'usage') renderUsage();
  if (name === 'ops') renderOps();
}
function renderAll() {
  // Ein fehlerhaftes Panel darf die übrigen nicht mitreißen
  const safe = (f) => { try { const r = f(); if (r?.catch) r.catch(e => console.error(f.name, e)); } catch (e) { console.error(f.name, e); } };
  [renderHeader, renderLive, renderLab, renderSignals, renderCoverage, renderSources].forEach(safe);
  if ($('#view-usage').classList.contains('active')) safe(renderUsage);
  if ($('#view-ops').classList.contains('active')) safe(renderOps);
  if ($('#view-lab').classList.contains('active')) { safe(renderPricing); safe(renderShareChart); }
}
function renderHeader() {
  $('#crumb-scope').textContent = scopeLabel();
  const at = state.mode === 'live' && state.live ? state.live.at : state.latest?.at;
  const label = state.mode === 'live' && state.live ? `Live ${timeText(at)}` : `Sammler ${timeText(at)}`;
  $('#stand-pill').textContent = `Stand ${label}`;
  $('#side-stamp').textContent = state.latest ? `Sammler: ${new Date(state.latest.at).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })} · ${state.latest.counts.sources} Quellen` : 'Sammler: noch kein Lauf';
  const recs = sourcesForScope(); const eff = recs.map(r => liveRec(r.id) || r);
  const by = {}; for (const r of eff) by[r.status] = (by[r.status] || 0) + 1;
  $('#filter-count').textContent = `${eff.length} Quellen im Gebiet · ${Object.entries(by).map(([k, v]) => `${v} ${STATUS[k] || k}`).join(' · ')}${state.live ? ` · Live-Dubletten bereinigt: ${state.live.dedupe.duplicates}` : ''}`;
}
function tile(l, v, s, cls = '') { return `<div class="tile ${cls}"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`; }
function renderLive() {
  const groups = scopeGroups(); const st = C.sumStats([...groups.values()]);
  const rows = operatorRows();
  const recs = sourcesForScope().map(r => liveRec(r.id) || r);
  const usable = recs.filter(r => ['live', 'delayed', 'collector'].includes(r.status));
  const gaps = rows.filter(r => r.gap).length;
  const lowE = st.batteryKnown ? st.lowBattery / st.batteryKnown : null;
  $('#live-tiles').innerHTML = [
    tile('Verfügbar · buchbar', fmt(st.available), `${fmt(st.total)} gemeldet · ${fmt(st.reserved)} reserviert`),
    tile('Gesperrt', fmt(st.disabled), st.total ? `${pctf(st.disabled, st.total)} des Bestands` : 'keine Fahrzeugdaten', st.total && st.disabled / st.total > 0.15 ? 'warn' : ''),
    tile('Stationen mit Angebot', `${fmt(st.stationsRenting - st.stationsEmpty)} / ${fmt(st.stations)}`, `${fmt(st.stationsEmpty)} leer · ${fmt(st.stationsFull)} voll`),
    tile('Energie niedrig', lowE == null ? 'k. A.' : pctf(st.lowBattery, st.batteryKnown), lowE == null ? 'keine Ladestandsangabe' : `${fmt(st.lowBattery)} von ${fmt(st.batteryKnown)} mit Angabe`, lowE > 0.3 ? 'warn' : ''),
    tile('Quellen', `${fmt(usable.length)} / ${fmt(recs.length)}`, `${recs.filter(r => r.status === 'live').length} aktuell · ${recs.filter(r => r.status === 'delayed').length} verzögert${gaps ? ` · ${gaps} Datenlücke${gaps > 1 ? 'n' : ''}` : ''}`, recs.length && usable.length / recs.length < 0.7 ? 'warn' : ''),
  ].join('');
  // Tabelle
  $('#tbl-operators tbody').innerHTML = rows.map(r => {
    const s = r.st;
    const d = r.delta ? `<span class="${r.delta.diff > 0 ? 'ok' : r.delta.diff < 0 ? 'bad' : ''}" style="color:var(--${r.delta.diff > 0 ? 'ok' : r.delta.diff < 0 ? 'bad' : 'muted'})">${r.delta.diff > 0 ? '+' : ''}${fmt(r.delta.diff)}</span><div class="sub-line">${ageText(r.delta.sinceMs)}</div>` : '—';
    if (r.gap) return `<tr><td><span class="op"><i style="background:${opColor(r.op)}"></i>${esc(r.op)}</span><div class="sub-line">${esc(r.gap.city)} · seit ${esc(r.gap.since)}</div></td><td colspan="7" class="sub-line">${esc(r.gap.note)}</td><td><span class="pill gap">Datenlücke</span></td><td></td></tr>`;
    return `<tr><td><span class="op"><i style="background:${opColor(r.op)}"></i>${esc(r.op)}</span><div class="sub-line">${r.sources.length} Quelle${r.sources.length === 1 ? '' : 'n'}${r.changed ? ' · Quellenwechsel' : ''}${r.sources.some(x => x.snapshot) ? ' · Momentaufnahme Sammler' : ''}${r.sources.some(x => x.status === 'collector') ? ' · Sammler-Stand' : ''}</div></td>
      <td>${r.dirs.map(d => DIRS[d] || d).join(' · ') || '–'}<div class="sub-line">Qualität ${r.quality ?? '–'}/100</div></td>
      <td class="n">${fmt(s.available)}<div class="sub-line">${fmt(s.total)} gemeldet</div></td><td class="n">${fmt(s.disabled)}</td><td class="n">${d}</td>
      <td class="n">${s.batteryKnown ? pctf(s.lowBattery, s.batteryKnown) : 'k. A.'}<div class="sub-line">${s.batteryKnown ? `${fmt(s.batteryKnown)} mit Angabe` : ''}</div></td>
      <td class="n">${s.stations ? `${fmt(s.stationsEmpty)} / ${fmt(s.stations)}` : '—'}</td><td class="n">${ageText(r.age)}</td>
      <td><span class="pill ${r.status}">${STATUS[r.status] || r.status}</span></td><td class="small">${r.license ? (/^https?:/.test(r.license) ? `<a href="${esc(r.license)}" target="_blank" rel="noopener">Lizenz ↗</a>` : esc(r.license)) : '<span class="muted">k. A.</span>'}</td></tr>`;
  }).join('') || '<tr><td colspan="10" class="empty">Keine Daten im gewählten Filter.</td></tr>';
  renderBriefing(rows, st);
  renderMap();
}
function renderBriefing(rows, st) {
  const items = computeSignals().slice(0, 4);
  $('#briefing').innerHTML = items.length ? items.map(sigCard).join('') : '<div class="empty">Keine auffälligen Signale im Gebiet.</div>';
}

// ---------- Karte ----------
function initMap() {
  const map = L.map('map', { preferCanvas: true, zoomControl: true }).setView([51.1, 10.4], 6);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende' }).addTo(map);
  state.map = map;
  state.layers = { vehicles: L.layerGroup().addTo(map), stations: L.layerGroup().addTo(map), muni: L.layerGroup().addTo(map), wfs: L.layerGroup().addTo(map), supply: L.layerGroup().addTo(map), bubbles: L.layerGroup().addTo(map), grid: L.layerGroup().addTo(map), zones: L.layerGroup().addTo(map) };
  map.on('moveend', () => { if ($('#chk-wfs').checked) loadWfs(); });
}
function livePoints() {
  if (!state.live) return { vehicles: [], stations: [] };
  const f = (x) => (state.scope === 'DE' || x.ags === state.scope) && (state.operator === 'all' || x.operator === state.operator);
  return { vehicles: state.live.vehicles.filter(v => f(v) && (state.type === 'all' || v.type === state.type)), stations: state.live.stations.filter(f) };
}
function renderMap() {
  if (!state.map) return;
  const L_ = state.layers; Object.values(L_).forEach(l => l.clearLayers());
  const layerMode = $('#sel-layer').value;
  if (['flow', 'served', 'idle'].includes(layerMode)) {
    $('#map-title').textContent = `Karte ${scopeLabel()}`;
    $('#map-sub').textContent = layerMode === 'flow' ? 'Fahrtbeginne und -enden je Zelle (Sammler)' : layerMode === 'served' ? 'Zellen mit verfügbarem Fahrzeug, letzte 7 Tage' : 'Verfügbare Fahrzeuge, die seit über 2 Tagen unbewegt stehen';
    if ($('#chk-muni').checked && state.scope !== 'DE' && state.boundaries) { const f = state.boundaries.features.find(x => x.properties.ags === state.scope); if (f) L.geoJSON(f, { style: { color: '#6aa9ff', weight: 1.5, fillOpacity: .04 } }).addTo(L_.muni); }
    fitMap(); renderZonesLayer();
    (layerMode === 'flow' ? renderFlowLayer : layerMode === 'served' ? renderServedLayer : renderIdleLayer)();
    return;
  }
  clearNotice('flow');
  const { vehicles, stations } = livePoints();
  const legend = [];
  const inScope = state.scope !== 'DE';
  if (state.live && (vehicles.length || stations.length)) {
    $('#map-title').textContent = `Karte ${scopeLabel()}`;
    const step = Math.max(1, Math.ceil(vehicles.length / CFG.MAX_POINTS));
    let drawn = 0;
    if (layerMode === 'points') {
      if ($('#chk-vehicles').checked) for (let i = 0; i < vehicles.length; i += step) {
        const v = vehicles[i]; drawn++;
        const col = v.disabled ? '#ef6b6b' : opColor(v.operator);
        L.circleMarker([v.lat, v.lon], { radius: 4, weight: 1, color: col, fillColor: col, fillOpacity: v.disabled ? .5 : .85, opacity: .9 })
          .bindPopup(`<b>${esc(v.operator)}</b> · ${TYPE[v.type] || v.type}<br>${v.disabled ? 'gesperrt' : v.reserved ? 'reserviert' : 'verfügbar'}${v.batteryPct != null ? ` · Akku ${fmt(v.batteryPct)} %` : ''}${v.rangeKm != null ? ` · ${fmt(v.rangeKm, 1)} km` : ''}<br><span class="muted">Position ${ageText(v.positionAgeMs)} · ${v.geoOrigin === 'station' ? 'Stationsersatz' : 'GPS'}${v.reusedId ? ' · Kennung wiederverwendet' : ''}</span>`).addTo(L_.vehicles);
      }
      if ($('#chk-stations').checked) for (const s of stations) {
        const empty = s.renting !== false && (s.bookable ?? 0) === 0;
        L.rectangle([[s.lat - .00035, s.lon - .0005], [s.lat + .00035, s.lon + .0005]], { weight: 2, color: empty ? '#e3b341' : opColor(s.operator), fillOpacity: .2 })
          .bindPopup(`<b>${esc(s.name || 'Station')}</b> · ${esc(s.operator)}<br>physisch ${fmt(s.physicalAvailable)} · buchbar ${fmt(s.bookable)} · Plätze ${fmt(s.docksAvailable)}<br><span class="muted">${s.renting === false ? 'Ausleihe gesperrt' : 'vermietend'} · ${s.returning === false ? 'Rückgabe gesperrt' : 'Rückgabe möglich'}</span>`).addTo(L_.stations);
      }
      const ops = [...new Set(vehicles.map(v => v.operator))].slice(0, 12);
      legend.push(...ops.map(o => `<span><i class="dot" style="background:${opColor(o)}"></i>${esc(o)}</span>`), `<span><i class="dot" style="background:#ef6b6b"></i>gesperrt</span>`, `<span><i class="sq"></i>Station</span>`, `<span class="muted">${fmt(drawn)} / ${fmt(vehicles.length)} Fahrzeuge gezeichnet</span>`);
    } else {
      // Rasterzellen ca. 500 m
      const cells = new Map();
      for (const v of vehicles) { if (v.disabled) continue; const k = `${Math.round(v.lat / 0.0045)}:${Math.round(v.lon / 0.007)}`; const c = cells.get(k) || { lat: Math.round(v.lat / 0.0045) * 0.0045, lon: Math.round(v.lon / 0.007) * 0.007, n: 0, low: 0, known: 0 }; c.n++; if (v.batteryPct != null) { c.known++; if (v.batteryPct < state.thresholds.charge) c.low++; } cells.set(k, c); }
      const max = Math.max(1, ...[...cells.values()].map(c => layerMode === 'energy' ? c.low : c.n));
      for (const c of cells.values()) {
        const val = layerMode === 'energy' ? c.low : c.n; if (!val) continue;
        const a = 0.15 + 0.7 * (val / max);
        L.rectangle([[c.lat - .00225, c.lon - .0035], [c.lat + .00225, c.lon + .0035]], { weight: 0, fillColor: layerMode === 'energy' ? '#e3b341' : '#49c7b0', fillOpacity: a })
          .bindPopup(layerMode === 'energy' ? `${fmt(c.low)} Fahrzeuge unter ${state.thresholds.charge} % (von ${fmt(c.known)} mit Angabe)` : `${fmt(c.n)} verfügbare Fahrzeuge in dieser Zelle`).addTo(L_.grid);
      }
      legend.push(`<span>${layerMode === 'energy' ? 'Niedrige Energie' : 'Verfügbare Fahrzeuge'} je ~500-m-Zelle, dunkler = mehr (max ${fmt(max)})</span>`);
    }
  } else {
    // Sammler-Stand: Gemeinde-Blasen
    $('#map-title').textContent = state.scope === 'DE' ? 'Karte Deutschlandweit' : `Karte ${scopeLabel()}`;
    const munis = state.latest?.municipalities || {};
    const groups = scopeGroups();
    const perMuni = new Map();
    for (const [k, st] of groups) { const [ags, op] = k.split('|'); const m = perMuni.get(ags) || { ags, available: 0, total: 0, ops: {} }; m.available += st.available; m.total += st.total; m.ops[op] = (m.ops[op] || 0) + st.available; perMuni.set(ags, m); }
    const centers = muniCenters();
    const max = Math.max(1, ...[...perMuni.values()].map(m => m.available));
    for (const m of perMuni.values()) {
      const c = centers.get(m.ags); if (!c) continue;
      const top = Object.entries(m.ops).sort((a, b) => b[1] - a[1])[0]?.[0];
      L.circleMarker(c, { radius: 4 + Math.sqrt(m.available / max) * 26, weight: 1, color: opColor(top), fillColor: opColor(top), fillOpacity: .35 })
        .bindPopup(`<b>${esc(munis[m.ags]?.name || m.ags)}</b> (${esc(munis[m.ags]?.state || '')})<br>${fmt(m.available)} verfügbar · ${fmt(m.total)} gemeldet<br>${Object.entries(m.ops).sort((a, b) => b[1] - a[1]).map(([o, n]) => `${esc(o)} ${fmt(n)}`).join(' · ')}<br><a href="#live" data-ags="${m.ags}" class="pick-muni">Ort öffnen</a>`).addTo(L_.bubbles);
    }
    legend.push(`<span>Blase = verfügbare Fahrzeuge je Gemeinde (Sammler-Stand ${timeText(state.latest?.at)}), Farbe = größter Anbieter</span>`, `<span class="muted">Für Fahrzeugpositionen „Live abrufen“.</span>`);
  }
  if ($('#chk-muni').checked && inScope && state.boundaries) {
    const f = state.boundaries.features.find(x => x.properties.ags === state.scope);
    if (f) L.geoJSON(f, { style: { color: '#6aa9ff', weight: 1.5, fillOpacity: .04 } }).addTo(L_.muni);
  }
  $('#map-legend').innerHTML = legend.join('');
  $('#map-sub').textContent = state.live && (vehicles.length || stations.length) ? `${fmt(vehicles.length)} Fahrzeuge · ${fmt(stations.length)} Stationen · Live ${timeText(state.live.at)}` : 'Fahrzeuge und Stationen';
  fitMap();
  if ($('#chk-wfs').checked) loadWfs();
  renderZonesLayer();
  if (state.supply && $('#chk-supply-on')) renderSupplyLayer();
}
function muniCenters() {
  const out = new Map();
  if (state.boundaries) for (const f of state.boundaries.features) { const b = f.bbox; out.set(f.properties.ags, [(b[1] + b[3]) / 2, (b[0] + b[2]) / 2]); }
  return out;
}
let lastFitKey = null;
function fitMap(force = false) {
  const key = `${state.scope}|${state.mode}|${state.operator}`;
  if (!force && key === lastFitKey) return; lastFitKey = key;
  const map = state.map;
  if (state.scope !== 'DE') {
    const f = state.boundaries?.features.find(x => x.properties.ags === state.scope);
    if (f) { const b = f.bbox; map.fitBounds([[b[1], b[0]], [b[3], b[2]]], { padding: [10, 10] }); return; }
    const { vehicles } = livePoints(); if (vehicles.length) { map.fitBounds(L.latLngBounds(vehicles.slice(0, 2000).map(v => [v.lat, v.lon])), { padding: [10, 10] }); return; }
  }
  map.setView([51.1, 10.4], 6);
}
async function loadWfs() {
  const L_ = state.layers; L_.wfs.clearLayers();
  const map = state.map; if (map.getZoom() < 11) { notice('MobiData-Karte: ab Stadtzoom (Zoom ≥ 11) laden.', '', 'wfs'); return; }
  const b = map.getBounds();
  const url = `${CFG.WFS}?service=WFS&version=2.0.0&request=GetFeature&typeName=MobiData-BW:sharing_vehicles&outputFormat=application/json&srsName=EPSG:4326&count=4000&bbox=${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()},EPSG:4326`;
  const r = await getJson(url, { timeout: 30000 });
  if (!r.ok || !r.json?.features) { notice(`MobiData-Kartenquelle nicht erreichbar (${r.error || r.status}). <a href="https://www.mobidata-bw.de/karten/ipl/sharing/" target="_blank" rel="noopener">Originalkarte ↗</a>`, 'warn', 'wfs'); return; }
  clearNotice('wfs');
  const now = Date.now(); let n = 0, fresh = 0, old = 0, unk = 0;
  for (const f of r.json.features) {
    const [lon, lat] = f.geometry?.coordinates || []; if (!C.validLatLon(lat, lon)) continue;
    const p = f.properties || {};
    if (state.operator !== 'all' && !String(p.provider_name || p.operator || p.system_id || '').toLowerCase().includes(state.operator.toLowerCase())) continue;
    const ts = C.toMs(p.last_reported || p.last_updated || p.timestamp || p.updated_at);
    const age = ts != null ? now - ts : null;
    const cls = age == null ? 'unk' : age <= 30 * 60e3 ? 'fresh' : 'old';
    if (cls === 'fresh') fresh++; else if (cls === 'old') { old++; if (!$('#chk-wfs-old')?.checked) continue; } else unk++;
    n++;
    L.circleMarker([lat, lon], { radius: 3, weight: 1, color: cls === 'fresh' ? '#2dd4bf' : cls === 'old' ? '#8b949e' : '#e3b341', fillOpacity: .7 })
      .bindPopup(`<b>MobiData-Karte</b><br>${esc(p.provider_name || p.operator || p.system_id || '')} · ${esc(p.form_factor || p.vehicle_type || '')}<br><span class="muted">${age == null ? 'Aktualität ungeklärt' : `Meldung ${ageText(age)}`}</span>`).addTo(L_.wfs);
  }
  notice(`MobiData-Karte: ${fmt(n)} Punkte im Ausschnitt (${fresh} zeitlich bestätigt, ${unk} Aktualität ungeklärt, ${old} älter${r.json.features.length >= 4000 ? ', Antwort begrenzt' : ''}). Nicht in Kennzahlen enthalten.`, '', 'wfs');
}

// ---------- Performance Lab ----------
function renderLab() {
  const groups = scopeGroups(); const st = C.sumStats([...groups.values()]);
  $('#lab-tiles').innerHTML = [
    tile('Buchbare Fahrzeuge', fmt(st.available), `${pctf(st.available, st.total)} von ${fmt(st.total)} gemeldeten`),
    tile(`Ladestand unter ${state.mode === 'live' ? state.thresholds.charge : 20} %`, st.batteryKnown ? pctf(st.lowBattery, st.batteryKnown) : 'k. A.', st.batteryKnown ? `${fmt(st.lowBattery)} von ${fmt(st.batteryKnown)} mit Ladestand` : 'keine Ladestandsangabe'),
    tile(`Reichweite unter ${state.mode === 'live' ? state.thresholds.range : 5} km`, st.rangeKnown ? pctf(st.lowRange, st.rangeKnown) : 'k. A.', st.rangeKnown ? `${fmt(st.lowRange)} von ${fmt(st.rangeKnown)} mit Reichweite` : 'keine Reichweitenangabe'),
    tile('Stationen mit Angebot', st.stations ? `${fmt(st.stationsRenting - st.stationsEmpty)} / ${fmt(st.stations)}` : '—', st.stations ? `${fmt(st.stationBookable)} buchbar · ${fmt(st.stationDocks)} freie Plätze` : 'keine Stationen im Filter'),
  ].join('');
  // Fahrzeugarten
  const byType = new Map();
  for (const [k, s] of groups) { const ty = k.split('|')[2]; byType.set(ty, [...(byType.get(ty) || []), s]); }
  $('#tbl-types tbody').innerHTML = [...byType].map(([ty, list]) => { const s = C.sumStats(list); return `<tr><td>${TYPE[ty] || ty}</td><td class="n">${fmt(s.total)}</td><td class="n">${fmt(s.available)}<div class="sub-line">${pctf(s.available, s.total)}</div></td><td class="n">${fmt(s.disabled)}</td><td class="n">${s.batteryKnown ? pctf(s.lowBattery, s.batteryKnown) : 'k. A.'}<div class="sub-line">${s.batteryKnown ? `n = ${fmt(s.batteryKnown)}` : ''}</div></td><td class="n">${s.rangeKnown ? pctf(s.lowRange, s.rangeKnown) : 'k. A.'}</td></tr>`; }).sort().join('') || '<tr><td colspan="6" class="empty">Keine Daten.</td></tr>';
  // Stationen je Anbieter
  const byOp = new Map();
  for (const [k, s] of groups) { const op = k.split('|')[1]; byOp.set(op, [...(byOp.get(op) || []), s]); }
  $('#tbl-stations tbody').innerHTML = [...byOp].map(([op, list]) => C.sumStats(list)).map((s, i) => ({ s, op: [...byOp.keys()][i] })).filter(x => x.s.stations).map(({ op, s }) => `<tr><td><span class="op"><i style="background:${opColor(op)}"></i>${esc(op)}</span></td><td class="n">${fmt(s.stations)}</td><td class="n">${fmt(s.stationsRenting)}</td><td class="n">${fmt(s.stationsEmpty)}</td><td class="n">${fmt(s.stationsFull)}</td><td class="n">${fmt(s.stationPhysical)}</td><td class="n">${fmt(s.stationBookable)}</td><td class="n">${fmt(s.stationDocks)}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">Keine Stationsdaten im Filter.</td></tr>';
  // Scorecard
  const rows = operatorRows().filter(r => !r.gap);
  $('#tbl-score tbody').innerHTML = rows.map(r => { const s = r.st; const avail = s.total ? s.available / s.total : null; const dis = s.total ? s.disabled / s.total : null; const low = s.batteryKnown ? s.lowBattery / s.batteryKnown : null; const emp = s.stations ? s.stationsEmpty / s.stations : null;
    const parts = [avail != null ? avail * 100 : null, dis != null ? 100 - dis * 100 : null, low != null ? 100 - low * 100 : null, emp != null ? 100 - emp * 100 : null, r.quality].filter(x => x != null);
    const score = parts.length ? Math.round(parts.reduce((a, b) => a + b, 0) / parts.length) : null;
    return `<tr><td><span class="op"><i style="background:${opColor(r.op)}"></i>${esc(r.op)}</span></td><td class="n">${fmt(s.total)}</td><td class="n">${avail == null ? '—' : pctf(s.available, s.total)}</td><td class="n">${dis == null ? '—' : pctf(s.disabled, s.total)}</td><td class="n">${low == null ? 'k. A.' : pctf(s.lowBattery, s.batteryKnown)}</td><td class="n">${emp == null ? '—' : pctf(s.stationsEmpty, s.stations)}</td><td class="n">${r.quality ?? '—'}</td><td class="n"><b>${score ?? '—'}</b><div class="bar"><i style="width:${score ?? 0}%"></i></div></td></tr>`; }).join('') || '<tr><td colspan="8" class="empty">Keine Daten.</td></tr>';
  // Städtevergleich
  const munis = state.latest?.municipalities || {};
  const src = new Map(Object.entries(state.latest?.groups || {})); // Gebietsvergleich immer aus dem Sammler-Stand (vollständig)
  const per = new Map();
  for (const [k, s] of src) { const [ags, op, ty] = k.split('|'); if (ags === 'DE' || ags === 'unbekannt') continue; if (state.operator !== 'all' && op !== state.operator) continue; if (state.type !== 'all' && ty !== state.type) continue; const m = per.get(ags) || { ags, available: 0, ops: new Set(), scooter: 0, bikes: 0 }; m.available += s.available; m.ops.add(op); if (ty === 'scooter') m.scooter += s.available; else m.bikes += s.available; per.set(ags, m); }
  const list = [...per.values()].sort((a, b) => b.available - a.available).slice(0, 25);
  $('#cities-title').textContent = state.scope === 'DE' ? 'Stadt- und Gebietsvergleich' : `Gebietsvergleich · ${muniName(state.scope)} im Kontext`;
  if ($('#view-lab').classList.contains('active')) renderHistory();
  $('#tbl-cities tbody').innerHTML = list.map(m => { const mi = munis[m.ags]; const pop = mi?.pop; return `<tr${m.ags === state.scope ? ' style="font-weight:600"' : ''}><td><a href="#live" class="pick-muni" data-ags="${m.ags}">${esc(mi?.name || m.ags)}</a> <span class="muted">${esc(mi?.state || '')}</span></td><td class="n">${fmt(m.available)}</td><td class="n">${pop ? fmt((m.available / pop) * 1e4, 1) : '—'}</td><td class="n">${m.ops.size}</td><td class="n">${fmt(m.scooter)}</td><td class="n">${fmt(m.bikes)}</td></tr>`; }).join('') || '<tr><td colspan="6" class="empty">Keine Daten.</td></tr>';
}
async function renderHistory() {
  const idx = state.histIndex; const box = $('#chart-hist');
  if (!idx?.days?.length) { box.innerHTML = '<div class="empty">Noch keine Sammler-Punkte vorhanden.</div>'; return; }
  const day = state.histDay || idx.days[idx.days.length - 1];
  $('#hist-days').innerHTML = idx.days.slice(-7).map(d => `<button class="chip ${d === day ? 'on' : ''}" data-day="${d}">${d.slice(8)}.${d.slice(5, 7)}.</button>`).join('');
  const h = await loadHistory(day);
  if (!h) { box.innerHTML = '<div class="empty">Verlauf nicht ladbar.</div>'; return; }
  const fi = h.fields.indexOf('available');
  const byOp = new Map();
  for (const [k, ser] of Object.entries(h.series)) {
    const [ags, op, ty] = k.split('|');
    if (state.scope === 'DE' ? ags !== 'DE' : ags !== state.scope) continue;
    if (state.scope === 'DE' && state.operator !== 'all') continue; // DE-Totale je Art, kein Anbieter
    if (state.operator !== 'all' && op !== state.operator) continue;
    if (state.type !== 'all' && ty !== state.type) continue;
    const name = state.scope === 'DE' ? (TYPE[ty] || ty) : op;
    const arr = byOp.get(name) || new Array(h.t.length).fill(null);
    ser.available.forEach((v, i) => { if (v != null) arr[i] = (arr[i] || 0) + v; });
    byOp.set(name, arr);
  }
  const series = [...byOp].map(([name, values]) => ({ name, values, color: state.scope === 'DE' ? null : opColor(name) })).sort((a, b) => Math.max(...b.values.filter(x => x != null), 0) - Math.max(...a.values.filter(x => x != null), 0)).slice(0, 8);
  const changes = (state.latest?.sources || []).filter(r => r.sourceChanged && (state.scope === 'DE' || (r.municipalities || []).includes(state.scope)));
  $('#hist-sub').textContent = `${h.t.length} Sammler-Punkte am ${day.split('-').reverse().join('.')} · beobachtet ${timeText(h.t[0])}–${timeText(h.t[h.t.length - 1])}${changes.length ? ` · ${changes.length} Quellenwechsel (Vergleich unterbrochen)` : ''}`;
  box.innerHTML = lineChart(h.t, series);
  $('#chart-legend').innerHTML = series.map((s, i) => `<span><i class="dot" style="background:${s.color || palette(i)}"></i>${esc(s.name)} <span class="mono">${fmt(s.values.filter(x => x != null).pop())}</span></span>`).join('');
}
const palette = (i) => ['#49c7b0', '#6aa9ff', '#e3b341', '#f472b6', '#a3e635', '#c084fc', '#fb923c', '#ef6b6b'][i % 8];
function lineChart(t, series) {
  const W = 900, H = 260, P = { l: 48, r: 12, t: 12, b: 26 };
  const vals = series.flatMap(s => s.values).filter(x => x != null);
  if (!vals.length) return '<div class="empty">Keine Punkte für diesen Filter.</div>';
  const max = Math.max(...vals) * 1.08 || 1, min = 0;
  const x = (i) => P.l + (i / Math.max(1, t.length - 1)) * (W - P.l - P.r);
  const y = (v) => P.t + (1 - (v - min) / (max - min)) * (H - P.t - P.b);
  const ticks = 4; let g = '';
  for (let k = 0; k <= ticks; k++) { const v = min + ((max - min) * k) / ticks; g += `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${P.l - 6}" y="${y(v) + 3}" text-anchor="end">${fmt(Math.round(v))}</text>`; }
  const stepX = Math.max(1, Math.round(t.length / 6));
  for (let i = 0; i < t.length; i += stepX) g += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${timeText(t[i])}</text>`;
  const paths = series.map((s, i) => { let d = '', open = false; s.values.forEach((v, j) => { if (v == null) { open = false; return; } d += `${open ? 'L' : 'M'}${x(j).toFixed(1)} ${y(v).toFixed(1)} `; open = true; }); const last = s.values.map((v, j) => [v, j]).filter(([v]) => v != null).pop(); return `<path d="${d}" fill="none" stroke="${s.color || palette(i)}" stroke-width="2" stroke-linejoin="round"/>${last ? `<circle cx="${x(last[1])}" cy="${y(last[0])}" r="3.5" fill="${s.color || palette(i)}"/>` : ''}`; }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Verlauf verfügbarer Fahrzeuge">${g}${paths}</svg>`;
}

// ---------- Signale ----------
let sigFilter = 'all';
function computeSignals() {
  const groups = scopeGroups(); const munis = state.latest?.municipalities || {};
  const by = new Map();
  for (const [k, s] of groups) { const [ags, op] = k.split('|'); const key = `${ags}|${op}`; by.set(key, [...(by.get(key) || []), s]); }
  const out = [];
  const place = (ags) => state.scope === 'DE' ? ` · ${munis[ags]?.name || ags}` : '';
  for (const [key, list] of by) {
    const [ags, op] = key.split('|'); const s = C.sumStats(list);
    if (s.total >= 5 && s.disabled / s.total >= 0.25) out.push({ cat: 'disabled', sev: s.disabled / s.total >= 0.5 ? 'bad' : 'warn', w: s.disabled, title: `${op}${place(ags)}: ${fmt(s.disabled)} gesperrt (${pctf(s.disabled, s.total)})`, text: 'Der Feed markiert Fahrzeuge als nicht nutzbar. Ein konkreter Wartungsauftrag ist daraus nicht ableitbar.', foot: 'Gemeldetes is_disabled / Stationsfeld' });
    if (s.batteryKnown >= 5 && s.lowBattery / s.batteryKnown >= 0.3) out.push({ cat: 'energy', sev: s.lowBattery / s.batteryKnown >= 0.6 ? 'bad' : 'warn', w: s.lowBattery, title: `${op}${place(ags)}: ${pctf(s.lowBattery, s.batteryKnown)} niedrige Energie`, text: `${fmt(s.lowBattery)} von ${fmt(s.batteryKnown)} Fahrzeugen mit Energieangabe. Möglicher Ladebedarf.`, foot: 'Ladestand / Reichweite · Arbeitsauftrag nicht bestätigt' });
    if (s.stations >= 3 && s.stationsEmpty / s.stations >= 0.3) out.push({ cat: 'stations', sev: s.stationsEmpty / s.stations >= 0.6 ? 'bad' : 'warn', w: s.stationsEmpty, title: `${op}${place(ags)}: ${fmt(s.stationsEmpty)} leere Stationen (${pctf(s.stationsEmpty, s.stations)})`, text: `${fmt(s.stationsEmpty)} von ${fmt(s.stations)} gemeldeten Stationen bieten derzeit kein Fahrzeug.`, foot: 'Gemeldeter Stationsstatus' });
    if (s.stations >= 3 && s.stationsFull / s.stations >= 0.3) out.push({ cat: 'stations', sev: 'info', w: s.stationsFull, title: `${op}${place(ags)}: ${fmt(s.stationsFull)} volle Stationen`, text: 'Rückgabe an diesen Stationen ist nicht möglich (keine freien Plätze).', foot: 'num_docks_available = 0' });
    if (s.total >= 5 && s.geoStation / s.total >= 0.5) out.push({ cat: 'data', sev: 'info', w: s.geoStation, title: `${op}${place(ags)}: Positionen überwiegend Stationsersatz`, text: `${fmt(s.geoStation)} von ${fmt(s.total)} Fahrzeugen ohne eigene Koordinaten; Stationsposition wird als Ersatz gezeigt.`, foot: 'Geo-Prüfung' });
  }
  // Quellenzustand
  const recs = sourcesForScope().map(r => liveRec(r.id) || r);
  for (const r of recs) {
    if (['stale', 'gone', 'error', 'auth'].includes(r.status)) out.push({ cat: 'data', sev: r.status === 'stale' ? 'warn' : 'bad', w: 1, title: `${r.operator}: Quelle ${STATUS[r.status].toLowerCase()}`, text: `${r.name || r.id}${r.feedAgeMs != null ? ` · Feed ${ageText(r.feedAgeMs)} alt` : ''}${r.errors?.length ? ` · ${r.errors[0]}` : ''}`, foot: `${(r.directories || []).map(d => DIRS[d] || d).join(' · ')}` });
    if (r.sourceChanged) out.push({ cat: 'data', sev: 'info', w: 1, title: `${r.operator}: Quellenwechsel erkannt`, text: `${r.name || r.id}: Endpunkt, Version, Feeds oder Fahrzeugarten haben sich geändert. Zeitvergleiche beginnen neu.`, foot: 'Fingerabdruck' });
  }
  for (const e of state.usage?.consistency?.systems || []) { if (e.verdict !== 'divergent') continue; const r = (state.latest?.sources || []).find(x => x.id === e.sourceId); if (!r || (state.scope !== 'DE' && !(r.municipalities || []).includes(state.scope)) || (state.operator !== 'all' && e.operator !== state.operator)) continue; out.push({ cat: 'data', sev: 'warn', w: Math.abs((e.primary?.vehicles || 0) - (e.alt?.vehicles || 0)), title: `${e.operator}: Landes- und Betreiberfeed weichen ab`, text: `${e.sourceId}: ${fmt(e.primary?.vehicles)} vs. ${fmt(e.alt?.vehicles)} Fahrzeuge, ${e.idOverlap == null ? '' : pctf(e.idOverlap, 1) + ' gemeinsame Kennungen, '}Median-Abstand ${e.medianDistM == null ? '—' : fmt(e.medianDistM) + ' m'}.`, foot: 'Konsistenzprüfung' }); }
  for (const g of state.latest?.gaps || []) if (state.scope === 'DE' || muniName(state.scope) === g.city) out.push({ cat: 'data', sev: 'info', w: 1, title: `${g.operator} · ${g.city}: öffentliche Daten fehlen seit ${g.since.split('-').reverse().join('.')}`, text: g.note, foot: g.probeOk ? 'Feed wieder erreichbar' : `Feed geprüft: ${g.probeStatus ?? '–'}` });
  // Bestandssprung gegen Verlauf
  const h = state.histDay ? state.hist[state.histDay] : state.hist[state.histIndex?.days?.slice(-1)[0]];
  if (h && h.t.length >= 3) {
    const fi = h.fields.indexOf('available');
    for (const [key, list] of by) {
      const [ags, op] = key.split('|'); let prev = 0, cur = 0, n = 0;
      for (const [k, ser] of Object.entries(h.series)) { if (!k.startsWith(`${ags}|${op}|`)) continue; const a = ser.available; const lastIdx = a.length - 1; if (a[lastIdx] == null || a[lastIdx - 3] == null) continue; cur += a[lastIdx]; prev += a[lastIdx - 3]; n++; }
      if (n && prev >= 20 && Math.abs(cur - prev) / prev >= 0.3) out.push({ cat: 'jump', sev: 'warn', w: Math.abs(cur - prev), title: `${op}${place(ags)}: Bestand ${cur > prev ? '+' : ''}${fmt(cur - prev)} in einer Stunde`, text: `Verfügbar ${fmt(prev)} → ${fmt(cur)} über die letzten drei Sammler-Punkte. Ausleihen, Umverteilung oder ein Quellenproblem können dahinterstehen.`, foot: 'Sammler-Verlauf' });
    }
  }
  const sevW = { bad: 3, warn: 2, info: 1 };
  return out.sort((a, b) => sevW[b.sev] - sevW[a.sev] || b.w - a.w);
}
const CATS = { all: 'Alle', disabled: 'Gesperrt', energy: 'Energie', stations: 'Stationen', jump: 'Bestandssprung', data: 'Datenqualität' };
function sigCard(s) { return `<div class="card ${s.sev}"><div class="k">${CATS[s.cat] || s.cat} · ${s.sev === 'bad' ? 'kritisch' : s.sev === 'warn' ? 'auffällig' : 'hinweis'}</div><b>${esc(s.title)}</b><p>${esc(s.text)}</p><div class="foot">${esc(s.foot)}</div></div>`; }
function renderSignals() {
  const all = computeSignals();
  const counts = {}; for (const s of all) counts[s.cat] = (counts[s.cat] || 0) + 1;
  $('#sig-filter').innerHTML = Object.entries(CATS).map(([k, l]) => `<button class="chip ${sigFilter === k ? 'on' : ''}" data-cat="${k}">${l} <span class="mono">${k === 'all' ? all.length : counts[k] || 0}</span></button>`).join('');
  const list = (sigFilter === 'all' ? all : all.filter(s => s.cat === sigFilter)).slice(0, 60);
  $('#signals').innerHTML = list.length ? list.map(sigCard).join('') : '<div class="empty" style="grid-column:1/-1">Keine Signale im gewählten Filter.</div>';
  renderStability();
}
async function renderStability() {
  const day = state.histDay || state.histIndex?.days?.slice(-1)[0];
  const tb = $('#tbl-stability tbody');
  if (!day) { tb.innerHTML = '<tr><td colspan="7" class="empty">Noch kein Verlauf.</td></tr>'; return; }
  const h = await loadHistory(day); if (!h) { tb.innerHTML = '<tr><td colspan="7" class="empty">Verlauf nicht ladbar.</td></tr>'; return; }
  const byOp = new Map();
  for (const [k, ser] of Object.entries(h.series)) { const [ags, op, ty] = k.split('|'); if (state.scope === 'DE' ? ags !== 'DE' : ags !== state.scope) continue; if (state.operator !== 'all' && op !== state.operator) continue; if (state.type !== 'all' && ty !== state.type) continue; const name = state.scope === 'DE' ? (TYPE[ty] || ty) : op; const arr = byOp.get(name) || new Array(h.t.length).fill(null); ser.available.forEach((v, i) => { if (v != null) arr[i] = (arr[i] || 0) + v; }); byOp.set(name, arr); }
  tb.innerHTML = [...byOp].map(([name, arr]) => { const v = arr.filter(x => x != null); if (!v.length) return ''; const min = Math.min(...v), max = Math.max(...v), last = v[v.length - 1], first = v[0]; const d = last - first; const drop = max && (max - last) / max; return `<tr><td>${esc(name)}</td><td class="n">${v.length}</td><td class="n">${fmt(min)}</td><td class="n">${fmt(max)}</td><td class="n">${fmt(last)}</td><td class="n">${d > 0 ? '+' : ''}${fmt(d)}</td><td class="small">${drop >= 0.3 ? `<span class="pill stale">${pctf(max - last, max)} unter Tagesmaximum</span>` : v.length < 3 ? '<span class="muted">zu wenige Punkte</span>' : '<span class="muted">stabil</span>'}</td></tr>`; }).join('') || '<tr><td colspan="7" class="empty">Keine Punkte im Filter.</td></tr>';
}

// ---------- Abdeckung ----------
function renderCoverage() {
  const munis = state.latest?.municipalities || {}; const q = ($('#cov-search').value || '').toLowerCase(); const dir = $('#cov-dir').value;
  const recs = state.latest?.sources || [];
  const rows = [];
  for (const [ags, m] of Object.entries(munis)) {
    for (const [op, o] of Object.entries(m.operators || {})) {
      const srcs = recs.filter(r => r.operator === op && (r.municipalities || []).includes(ags));
      const dirs = [...new Set(srcs.flatMap(r => r.directories || []))];
      if (dir !== 'all' && !dirs.includes(dir)) continue;
      if (q && !`${m.name} ${op} ${m.state}`.toLowerCase().includes(q)) continue;
      const status = srcs.some(r => r.status === 'live') ? 'live' : srcs.some(r => r.status === 'delayed') ? 'delayed' : srcs[0]?.status || 'unknown';
      rows.push({ ags, m, op, o, srcs, dirs, status });
    }
  }
  rows.sort((a, b) => a.m.name.localeCompare(b.m.name, 'de') || a.op.localeCompare(b.op));
  const opsAll = new Set(rows.map(r => r.op)), places = new Set(rows.map(r => r.ags));
  $('#cov-tiles').innerHTML = [tile('Anbieter vor Ort', fmt(rows.length), 'Anbieter × Gemeinde mit bestätigter Zuordnung'), tile('Anbietergruppen', fmt(opsAll.size), 'über alle Quellen'), tile('Gemeinden', fmt(places.size), 'mit verfügbarem Angebot'), tile('Ohne Zuordnung', fmt(recs.filter(r => ['foreign', 'empty'].includes(r.status)).length), 'Quellen außerhalb DE oder ohne Bestand')].join('');
  $('#cov-sub').textContent = `${fmt(rows.length)} Zeilen · Sammler-Stand ${timeText(state.latest?.at)}`;
  const show = rows.slice(0, 400);
  $('#tbl-cov tbody').innerHTML = show.map(r => `<tr><td><span class="op"><i style="background:${opColor(r.op)}"></i>${esc(r.op)}</span><div class="sub-line">${Object.entries(r.o.types).filter(([, n]) => n).map(([t, n]) => `${TYPE[t] || t} ${fmt(n)}`).join(' · ')}</div></td><td>${esc(r.m.name)} <span class="muted">${esc(r.m.state)}</span></td><td class="n">${fmt(r.o.total)}</td><td class="n">${fmt(r.o.available)}</td><td class="small">${r.dirs.map(d => DIRS[d] || d).join(' · ')}<div class="sub-line">${r.srcs.length} Quelle${r.srcs.length === 1 ? '' : 'n'}</div></td><td><span class="pill ${r.status}">${STATUS[r.status] || r.status}</span></td><td><a href="#live" class="pick-muni" data-ags="${r.ags}">Ort öffnen ↗</a></td></tr>`).join('') || '<tr><td colspan="7" class="empty">Keine Treffer.</td></tr>';
  $('#cov-more').textContent = rows.length > show.length ? `${rows.length - show.length} weitere Zeilen – Suche eingrenzen.` : '';
  $('#gaps').innerHTML = (state.latest?.gaps || []).map(g => `<div class="card info"><div class="k">Datenlücke</div><b>${esc(g.operator)} · ${esc(g.city)}</b><p>${esc(g.note)}</p><div class="foot">seit ${esc(g.since)} · zuletzt geprüft ${timeText(g.checkedAt)} · Feed ${g.probeOk ? 'erreichbar' : `nicht erreichbar (${g.probeStatus ?? '–'})`}</div></div>`).join('') || '<div class="empty">Keine bekannten Lücken.</div>';
}

// ---------- Quellen ----------
function renderSources() {
  const recs = state.latest?.sources || []; const cat = state.catalog;
  const by = {}; for (const r of recs) by[r.status] = (by[r.status] || 0) + 1;
  $('#src-tiles').innerHTML = [tile('Quellen geprüft', fmt(recs.length), `Katalog ${cat?.count ?? '–'} Einträge · ${state.latest ? new Date(state.latest.at).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '–'}`), tile('Aktuell', fmt(by.live || 0), `${fmt(by.delayed || 0)} verzögert · ${fmt(by.stale || 0)} veraltet`, (by.live || 0) / Math.max(1, recs.length) < 0.6 ? 'warn' : 'ok'), tile('Nicht nutzbar', fmt((by.gone || 0) + (by.error || 0) + (by.auth || 0) + (by.empty || 0) + (by.unknown || 0)), `${fmt(by.gone || 0)} weg · ${fmt(by.error || 0)} Fehler · ${fmt(by.unknown || 0)} Zeit unklar · ${fmt(by.empty || 0)} leer`), tile('Dubletten bereinigt', fmt(state.latest?.dedupe?.duplicates), `${fmt(state.latest?.dedupe?.stationDuplicates)} Stationsdubletten · ${fmt(state.latest?.dedupe?.reusedIds)} Kennungen wiederverwendet`)].join('');
  const dirCount = {}; for (const r of recs) for (const d of r.directories || []) dirCount[d] = (dirCount[d] || 0) + 1;
  const dirInfo = {
    mobilitydata: ['angebunden', 'Alle als Deutschland gelisteten Systeme des GBFS-Katalogs (Bike, Lastenrad, E-Scooter). Carsharing wird ausgeschlossen, Erreichbarkeit je Lauf geprüft.', 'https://github.com/MobilityData/gbfs/blob/master/systems.csv'],
    mobidata_bw: ['angebunden · bevorzugt', 'Landesfeeds Baden-Württemberg; bei gleichem System vor dem Betreiberfeed verwendet. Die Kartenebene der offiziellen MobiData-Karte ist als Zusatzebene im Live-Modus verfügbar.', 'https://mobidata-bw.de/sk/dataset/bikesh'],
    mobidrom_nrw: ['angebunden · Dienstzugang', 'Konflationierte Landesfeeds NRW (E-Scooter, Bikesharing, Lastenräder). Der allgemeine OAuth-Dienstzugang aus der Datensatzbeschreibung wird zur Laufzeit gelesen; Positionen kommen über Momentaufnahmen des Sammlers in die Karte.', 'https://www.mobilitaetsdaten.nrw/api/ckan/organization/angemeldet'],
    citybikes: ['angebunden · Ergänzung', 'Stationszähler ohne Fahrzeugliste; nur mit belastbarem Zeitstempel. Dubletten zu GBFS-Stationen werden über Name und Position zusammengeführt.', 'https://api.citybik.es/v2/networks'],
    dott_direct: ['Kandidaten geprüft', 'Direktfeeds gbfs.api.ridedott.com je Stadt; Kandidaten ohne Feed bleiben als „nicht erreichbar“ sichtbar, Tübingen als Datenlücke.', 'https://gbfs.api.ridedott.com/public/v2/stuttgart/gbfs.json'],
  };
  $('#dirs').innerHTML = Object.entries(dirInfo).map(([k, [st, txt, url]]) => `<div class="card ok"><div class="k">${esc(st)}</div><b>${DIRS[k]}</b><p>${esc(txt)}</p><div class="foot">${fmt(dirCount[k] || 0)} Quellen · <a href="${url}" target="_blank" rel="noopener">Originalquelle ↗</a></div></div>`).join('') +
    `<div class="card info"><div class="k">Grundlage</div><b>Gemeindegrenzen · BKG</b><p>${esc(state.latest?.boundaries?.attribution || '© GeoBasis-DE / BKG, VG250')}, Lizenz dl-de/by-2-0. GPS entscheidet die Gemeinde; unklare Grenzfälle bleiben ohne Zuordnung.</p><div class="foot">${fmt(state.latest?.boundaries?.count)} Gemeinden · <a href="https://gdz.bkg.bund.de" target="_blank" rel="noopener">Originalquelle ↗</a></div></div>
     <div class="card warn"><div class="k">Nicht verwendet</div><b>DB API Marketplace · Voi Partner-API</b><p>Beide erfordern persönliche Zugangsdaten. Call-a-Bike-Daten kommen über MobiData BW und MOBIDROM NRW, Voi-Daten über beide Landesverzeichnisse.</p><div class="foot">kein Partnerzugang</div></div>`;
  loadOnce('reliability', 'reliability.json').then(() => renderSourceTable());
  renderConsistency();
  $('#method').innerHTML = METHOD;
}
function relCell(id) { const r = state.usage?.reliability?.sources?.[id]; if (!r || !r.runs) return '<span class="muted">–</span>'; const ok = (r.live + r.delayed) / r.runs; return `<span style="color:var(--${ok >= 0.95 ? 'ok' : ok >= 0.8 ? 'warn' : 'bad'})">${pctf(r.live + r.delayed, r.runs)}</span><div class="sub-line">${r.runs} Läufe · Ø ${fmt(r.latencyAvg)} ms</div>`; }
function renderSourceTable() {
  const q = ($('#src-search').value || '').toLowerCase(); const stf = $('#src-status').value;
  const all = (state.latest?.sources || []).filter(r => (stf === 'all' || r.status === stf) && (!q || `${r.id} ${r.name} ${r.operator} ${r.url}`.toLowerCase().includes(q)));
  const hidden = all.filter(r => r.candidate && !['live', 'delayed', 'stale', 'unknown', 'empty'].includes(r.status) && !q);
  const recs = all.filter(r => !hidden.includes(r));
  const munis = state.latest?.municipalities || {};
  const show = recs.slice(0, 300);
  $('#tbl-src tbody').innerHTML = show.map(r => `<tr><td><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name || r.id)}</a><div class="sub-line mono">${esc(r.id)}${r.sourceChanged ? ' · Quellenwechsel' : ''}</div></td><td>${esc(r.operator)}</td><td class="small">${(r.directories || []).map(d => DIRS[d] || d).join(' · ')}</td><td class="n">${esc(r.version || '–')}</td><td class="n">${fmt(r.counts?.vehicles)}<div class="sub-line">${r.counts?.outside ? `${fmt(r.counts.outside)} außerhalb` : ''}${r.counts?.missing ? ` ${fmt(r.counts.missing)} o. Koord.` : ''}</div></td><td class="n">${fmt(r.counts?.stations)}</td><td class="n" title="${(r.municipalities || []).slice(0, 12).map(a => munis[a]?.name || a).join(', ')}">${fmt((r.municipalities || []).length)}</td><td class="n">${ageText(r.feedAgeMs)}</td><td class="n">${r.quality ?? '–'}</td><td class="n">${relCell(r.id)}</td><td><span class="pill ${r.status}">${STATUS[r.status] || r.status}</span>${r.errors?.length ? `<div class="sub-line">${esc(r.errors[0]).slice(0, 60)}</div>` : ''}</td><td class="small">${r.license ? (/^https?:/.test(r.license) ? `<a href="${esc(r.license)}" target="_blank" rel="noopener">Lizenz ↗</a>` : esc(r.license)) : '<span class="muted">k. A.</span>'}</td></tr>`).join('') || '<tr><td colspan="12" class="empty">Keine Treffer.</td></tr>';
  $('#src-more').textContent = [recs.length > show.length ? `${recs.length - show.length} weitere Quellen – Suche eingrenzen.` : '', hidden.length ? `${hidden.length} geprüfte Direktfeed-Kandidaten ohne Daten ausgeblendet (Suche nach Anbieter zeigt sie).` : ''].filter(Boolean).join(' ');
}
// ---------- Nutzung & Bewegung ----------
state.usage = { index: null, day: null, docs: {}, cells: {}, idle: null, idleLong: null, quota: null, pricing: null, zonesIndex: null, zones: {}, reliability: null, consistency: null, weather: {} };
async function loadUsageIndex() { if (!state.usage.index) { const r = await getJson(CFG.DATA + 'events/index.json'); state.usage.index = r.json || { days: [], cellDays: [] }; } return state.usage.index; }
async function loadEvents(day) { if (!(day in state.usage.docs)) { const r = await getJson(CFG.DATA + `events/${day}.json`, { timeout: 60000 }); state.usage.docs[day] = r.json || null; } return state.usage.docs[day]; }
async function loadCells(day, st) { const k = `${day}/${st}`; if (!(k in state.usage.cells)) { const r = await getJson(CFG.DATA + `cells/${day}/${st}.json`, { timeout: 60000 }); state.usage.cells[k] = r.json || null; } return state.usage.cells[k]; }
async function loadOnce(name, file, timeout = 60000) { if (!state.usage[name]) { const r = await getJson(CFG.DATA + file, { timeout }); state.usage[name] = r.json || null; } return state.usage[name]; }
const scopeState = () => state.latest?.municipalities?.[state.scope]?.state || null;
const groupInScope = (k) => { const [ags, op, ty] = k.split('|'); if (ags === 'DE') return false; if (state.scope !== 'DE' && ags !== state.scope) return false; if (state.operator !== 'all' && op !== state.operator) return false; if (state.type !== 'all' && ty !== state.type) return false; return true; };
const sum = (a) => a.reduce((x, y) => x + y, 0);
const durText = (ms) => ms == null || !Number.isFinite(ms) ? '—' : ms < 3600e3 ? `${fmt(ms / 60e3)} Min.` : `${(ms / 3600e3).toFixed(1).replace('.', ',')} Std.`;

async function renderUsage() {
  const idx = await loadUsageIndex();
  const days = idx.days || [];
  const box = $('#usage-tiles');
  if (!days.length) { box.innerHTML = ''; $('#usage-note').textContent = 'Noch keine Ereignisdaten – der Sammler braucht zwei Läufe, bevor Bewegungen erkennbar sind.'; $('#chart-usage').innerHTML = ''; $('#tbl-usage tbody').innerHTML = '<tr><td colspan="13" class="empty">Noch keine Daten.</td></tr>'; return; }
  const day = state.usage.day && days.includes(state.usage.day) ? state.usage.day : days[days.length - 1];
  state.usage.day = day;
  $('#usage-days').innerHTML = days.slice(-7).map(d => `<button class="chip ${d === day ? 'on' : ''}" data-uday="${d}">${d.slice(8)}.${d.slice(5, 7)}.</button>`).join('');
  const doc = await loadEvents(day);
  if (!doc) { box.innerHTML = ''; $('#usage-note').textContent = 'Ereignisdatei nicht ladbar.'; return; }
  const runs = doc.runs || [];
  const observedMs = runs.filter(r => r[1] != null).reduce((a, r) => a + Math.min(r[1], 45 * 60e3), 0);
  $('#usage-note').textContent = `${runs.length} Sammler-Läufe · beobachtet ${durText(observedMs)} · ${timeText(runs[0]?.[0])}–${timeText(runs[runs.length - 1]?.[0])}`;
  // Gruppen im Scope aggregieren
  const byOp = new Map(); const tot = T_empty();
  for (const [k, g] of Object.entries(doc.groups || {})) {
    if (!groupInScope(k)) continue;
    const [, op, ty] = k.split('|'); const name = state.scope === 'DE' && state.operator === 'all' ? (TYPE[ty] || ty) : op;
    const a = byOp.get(name) || T_empty(); T_add(a, g); byOp.set(name, a); T_add(tot, g);
  }
  // Flotte für Umschlag: verfügbarer Bestand im Scope (Sammler-Stand)
  const fleet = new Map(); let fleetTot = 0;
  for (const [k, st] of Object.entries(state.latest?.groups || {})) { if (!groupInScope(k)) continue; const [, op, ty] = k.split('|'); const name = state.scope === 'DE' && state.operator === 'all' ? (TYPE[ty] || ty) : op; fleet.set(name, (fleet.get(name) || 0) + st.total); fleetTot += st.total; }
  const starts = sum(tot.start), ends = sum(tot.end), reloc = sum(tot.reloc), swaps = sum(tot.swap), pickups = sum(tot.pickup);
  box.innerHTML = [
    tile('Fahrten (geschätzt)', fmt(starts), `${fmt(ends)} Fahrtenden · ${durText(observedMs)} beobachtet`),
    tile('Umschlag', fleetTot ? fmt(starts / fleetTot, 2) : '—', 'Fahrten je gemeldetem Fahrzeug im Zeitraum'),
    tile('Umsetzungen', fmt(reloc), 'gleiche Kennung, > 150 m versetzt, nicht verschwunden'),
    tile('Akkutausch', fmt(swaps), tot.swapWaitN ? `Ø ${durText(tot.swapWaitSum / tot.swapWaitN)} unter 20 % bis zum Tausch` : 'Sprung von < 40 % auf ≥ 85 % am selben Ort'),
    tile('Abholungen', fmt(pickups), 'gesperrte oder fast leere Fahrzeuge verschwunden'),
    tile('Sperrdauer', tot.disDurN ? durText(tot.disDurSum / tot.disDurN) : '—', `${fmt(sum(tot.disOff))} Fahrzeuge wieder freigegeben`),
  ].join('');
  // Tagesgang
  const series = [...byOp].map(([name, a]) => ({ name, values: a.start, color: state.scope === 'DE' && state.operator === 'all' ? null : opColor(name) })).sort((x, y) => sum(y.values) - sum(x.values)).slice(0, 8);
  let weather = null;
  if ($('#chk-weather').checked) weather = await loadWeather(day);
  $('#chart-usage').innerHTML = hourChart(series, weather, runs);
  $('#usage-chart-sub').textContent = `Fahrtbeginne je Stunde${state.scope === 'DE' && state.operator === 'all' ? ' und Fahrzeugart' : ' und Anbieter'}${weather ? ` · Wetter ${weather.name}` : ''}`;
  $('#usage-legend').innerHTML = series.map((s, i) => `<span><i class="dot" style="background:${s.color || palette(i)}"></i>${esc(s.name)} <span class="mono">${fmt(sum(s.values))}</span></span>`).join('') + (weather ? `<span><i class="dot" style="background:#6aa9ff"></i>Niederschlag mm</span><span><i class="dot" style="background:#e3b341"></i>Temperatur °C</span>` : '');
  // Standzeiten
  const idle = await loadOnce('idle', 'idle.json');
  const ib = [0, 0, 0, 0, 0]; let in_ = 0;
  for (const [k, a] of Object.entries(idle?.groups || {})) { if (!groupInScope(k)) continue; for (let i = 0; i < 5; i++) ib[i] += a[i]; in_ += a[5]; }
  const labels = idle?.buckets || ['<2 h', '2–8 h', '8–24 h', '1–2 Tage', '>2 Tage'];
  const imax = Math.max(1, ...ib);
  $('#idle-bars').innerHTML = in_ ? labels.map((l, i) => `<div class="hbar"><span>${l}</span><div class="bar"><i style="width:${(ib[i] / imax) * 100}%;background:${i >= 3 ? 'var(--warn)' : 'var(--accent)'}"></i></div><span class="n mono">${pctf(ib[i], in_)}</span></div>`).join('') + `<div class="muted small" style="margin-top:6px">${fmt(in_)} verfügbare Fahrzeuge · Stand ${timeText(idle.at)} · Zeit seit letzter Bewegung, höchstens seit erstem Sammler-Kontakt (${days[0].split('-').reverse().join('.')})</div>` : '<div class="empty">Keine Standzeiten im Filter.</div>';
  // Tabelle je Anbieter
  $('#tbl-usage tbody').innerHTML = [...byOp].sort((a, b) => sum(b[1].start) - sum(a[1].start)).map(([name, a]) => { const fl = fleet.get(name) || 0; const modes = Object.entries(doc.srcModes || {}).filter(([id]) => (state.latest?.sources || []).some(r => r.id === id && r.operator === name && (state.scope === 'DE' || (r.municipalities || []).includes(state.scope)))).map(([, m]) => m); const mode = modes.includes('stable') ? 'stabil' : modes.includes('rotating') ? 'rotierend' : 'offen';
    return `<tr><td><span class="op"><i style="background:${opColor(name)}"></i>${esc(name)}</span></td><td class="n">${fmt(sum(a.start))}</td><td class="n">${fmt(sum(a.end))}</td><td class="n">${fl ? fmt(sum(a.start) / fl, 2) : '—'}</td><td class="n">${a.tripDurN ? durText(a.tripDurSum / a.tripDurN) : '—'}</td><td class="n">${a.tripDistN ? `${fmt(a.tripDistSum / a.tripDistN / 1000, 1)} km` : '—'}</td><td class="n">${fmt(sum(a.reloc))}</td><td class="n">${fmt(sum(a.swap))}</td><td class="n">${a.swapWaitN ? durText(a.swapWaitSum / a.swapWaitN) : '—'}</td><td class="n">${fmt(sum(a.pickup))}</td><td class="n">${fmt(sum(a.disOff))}</td><td class="n">${a.disDurN ? durText(a.disDurSum / a.disDurN) : '—'}</td><td class="small">${mode}<div class="sub-line">${mode === 'stabil' ? 'Dauer/Distanz messbar' : mode === 'rotierend' ? 'nur Start/Ziel-Zählung' : 'noch zu wenige Läufe'}</div></td></tr>`; }).join('') || '<tr><td colspan="13" class="empty">Keine Ereignisse im Filter.</td></tr>';
  renderCellsTable(day); renderQuota(); renderEcon(day, doc).catch(e => console.error('Umsatz', e));
}
// ---------- Umsatz & Kennzahlen ----------
function econOpts() {
  const m = +$('#econ-min')?.value;
  return { rideMin: Number.isFinite(m) && m > 0 ? m : null, realization: Math.min(1, Math.max(0.1, (+$('#econ-real')?.value || 85) / 100)), net: $('#econ-net') ? $('#econ-net').checked : true };
}
async function econProfile() {
  if (state.usage.profile) return state.usage.profile;
  const idx = await loadUsageIndex(); const days = (idx.days || []).slice(-8, -1); // abgeschlossene Tage
  state.usage.profile = E.hourProfile(await Promise.all(days.map(loadEvents)));
  return state.usage.profile;
}
// Kennzahlen je Gruppe (Gemeinde|Anbieter|Art) eines Tages; Ergebnis je Schlüssel
async function econGroups(day, keep) {
  const [doc, pricing, hist, prof] = await Promise.all([loadEvents(day), loadOnce('pricing', 'pricing.json'), loadHistory(day), econProfile()]);
  if (!doc) return null;
  const obsMin = E.observedMinutes(doc.runs); const o = econOpts();
  const planCache = new Map(); const out = new Map();
  for (const [k, g] of Object.entries(doc.groups || {})) {
    if (!keep(k)) continue;
    const [ags, op, ty] = k.split('|');
    const pk = `${op}|${ags}|${ty}`; if (!planCache.has(pk)) planCache.set(pk, E.planFor(pricing, op, ags, ty));
    const pl = planCache.get(pk);
    const series = hist?.series?.[k]?.total?.filter(x => x != null) || [];
    const fleetFallback = series.length ? series.reduce((a, b) => a + b, 0) / series.length : (state.latest?.groups?.[k]?.total ?? null);
    out.set(k, { ...E.kpis({ g, obsMin, profile: prof.profile, plan: pl?.plan || null, type: ty, fleetFallback, ride: o.rideMin ? { min: o.rideMin } : null, realization: o.realization, net: o.net }), plan: pl, op, ty, ags });
  }
  return { out, doc, obsMin, profile: prof };
}
// für die Disposition: Kennzahlen eines Anbieters in einer Gemeinde (letzter Tag)
async function econFor(ags, op, type) {
  const idx = await loadUsageIndex(); const day = (idx.days || []).slice(-1)[0]; if (!day) return null;
  const r = await econGroups(day, (k) => { const [a, o, t] = k.split('|'); return a === ags && o === op && (type === 'all' || t === type); });
  return r ? E.combine([...r.out.values()]) : null;
}
async function renderEcon(day) {
  const r = await econGroups(day, groupInScope);
  if (!r) { $('#econ-tiles').innerHTML = ''; $('#tbl-econ tbody').innerHTML = '<tr><td colspan="12" class="empty">Keine Daten.</td></tr>'; return; }
  const byName = new Map();
  for (const x of r.out.values()) { const name = `${x.op}|${x.ty}`; if (!byName.has(name)) byName.set(name, []); byName.get(name).push(x); }
  const rows = [...byName].map(([name, list]) => { const [op, ty] = name.split('|'); const c = E.combine(list); const plans = [...new Set(list.map(x => x.plan?.plan ? E.planLabel(x.plan.plan) : null).filter(Boolean))]; return { op, ty, c, list, plans, planScope: list.find(x => x.plan)?.plan?.scope }; }).filter(x => x.c && x.c.fleet > 0).sort((a, b) => (b.c.revDay || 0) - (a.c.revDay || 0) || b.c.rides - a.c.rides);
  const good = rows.filter(x => x.c.plausible);
  const tot = E.combine(good.map(x => x.c));
  const cov = Math.max(0, ...rows.map(x => x.c.coverage || 0));
  const o = econOpts(); const euro = (v, d = 0) => v == null ? '—' : `${fmt(v, d)} €`;
  $('#econ-tiles').innerHTML = tot ? [
    tile('Fahrten / Tag', fmt(tot.ridesDay), `hochgerechnet aus ${fmt(tot.rides)} gemessenen · ${fmt(cov * 100)} % des Tagesgangs beobachtet`),
    tile('Rides / Fzg. / Tag', fmt(tot.rvd, 2), `bezogen auf Ø ${fmt(tot.fleet)} Fahrzeuge auf der Straße`),
    tile('Auslastung', tot.utilization == null ? '—' : `${fmt(tot.utilization * 100, 1)} %`, `Zeit in Fahrt · Ø ${fmt(tot.avgMin, 1)} Min. je Fahrt`),
    tile(`Umsatz / Tag ${o.net ? 'netto' : 'brutto'}`, euro(tot.revDay), `Realisierung ${fmt(o.realization * 100)} % · Listenpreise der Feeds`),
    tile('Umsatz / Fzg. / Tag', euro(tot.revPerVehicleDay, 2), `${euro(tot.perRide, 2)} je Fahrt`),
    tile('Hochrechnung Monat', euro(tot.revDay != null ? tot.revDay * 30 : null), '30 Tage zum heutigen Niveau, ohne Saison'),
  ].join('') : '';
  $('#tbl-econ tbody').innerHTML = rows.map(x => { const c = x.c; const warn = !c.plausible;
    return `<tr${warn ? ' style="opacity:.6"' : ''}><td><span class="op"><i style="background:${opColor(x.op)}"></i>${esc(x.op)}</span><div class="sub-line">${TYPE[x.ty] || x.ty}${state.scope === 'DE' ? ` · ${x.list.length} Gemeinde${x.list.length === 1 ? '' : 'n'}` : ''}</div></td>
      <td class="n">${fmt(c.fleet)}</td><td class="n">${fmt(c.rides)}<div class="sub-line">${c.rot ? `${fmt(c.rot)} Kennungswechsel` : ''}</div></td><td class="n">${fmt(c.ridesDay)}</td>
      <td class="n"><b>${fmt(c.rvd, 2)}</b></td><td class="n">${c.utilization == null ? '—' : `${fmt(c.utilization * 100, 1)} %`}</td><td class="n">${fmt(c.avgMin, 1)} min</td>
      <td class="small">${x.plans.slice(0, 2).map(esc).join('<br>') || '<span class="muted">kein Tarif im Feed</span>'}${x.planScope === 'Anbieter' ? '<div class="sub-line">Tarif anderer Stadt</div>' : ''}</td>
      <td class="n">${euro(c.perRide, 2)}</td><td class="n"><b>${euro(c.revDay)}</b></td><td class="n">${euro(c.revPerVehicleDay, 2)}</td>
      <td class="small">${c.flags.length ? esc(c.flags[0]) : '<span class="muted">—</span>'}</td></tr>`; }).join('') || '<tr><td colspan="12" class="empty">Keine Daten im Filter.</td></tr>';
  const excludedN = rows.length - good.length;
  $('#econ-note').innerHTML = `Fahrten = verschwundene verfügbare Fahrzeuge (Kennungswechsel ≤ 40 m am selben Ort zählen nicht). Hochrechnung auf 24 h über den Tagesgang (${esc(r.profile.source)}). Flotte = Ø Fahrzeuge auf der Straße inkl. gesperrter. Ø Fahrtdauer: ${o.rideMin ? `Vorgabe ${fmt(o.rideMin)} Min.` : 'gemessen, wo Kennungen stabil sind (≥ 20 Fahrten), sonst Annahme (E-Scooter 12 Min., E-Bike 16, Rad 18, Lastenrad 40)'}. Umsatz zu Listenpreisen des Standardtarifs, ${o.net ? 'ohne 19 % MwSt., ' : ''}mal Realisierungsquote (Pässe, Rabatte, Freiminuten). Betreiber-Umsetzungen, die das Fahrzeug aus dem Feed nehmen, zählen als Fahrt.${excludedN ? ` ${excludedN} Zeile${excludedN === 1 ? '' : 'n'} mit unplausibler Fahrtenzahl sind ausgegraut und nicht in den Summen.` : ''}`;
}
function T_empty() { return { start: new Array(24).fill(0), end: new Array(24).fill(0), reloc: new Array(24).fill(0), swap: new Array(24).fill(0), pickup: new Array(24).fill(0), disOn: new Array(24).fill(0), disOff: new Array(24).fill(0), swapWaitSum: 0, swapWaitN: 0, disDurSum: 0, disDurN: 0, tripDurSum: 0, tripDurN: 0, tripDistSum: 0, tripDistN: 0 }; }
function T_add(a, g) { for (const f of ['start', 'end', 'reloc', 'swap', 'pickup', 'disOn', 'disOff']) for (let i = 0; i < 24; i++) a[f][i] += g[f]?.[i] || 0; for (const f of ['swapWaitSum', 'swapWaitN', 'disDurSum', 'disDurN', 'tripDurSum', 'tripDurN', 'tripDistSum', 'tripDistN']) a[f] += g[f] || 0; }
async function loadWeather(day) {
  const c = state.scope === 'DE' ? [51.16, 10.45] : muniCenters().get(state.scope); if (!c) return null;
  const key = `${day}|${c[0].toFixed(2)},${c[1].toFixed(2)}`;
  if (!(key in state.usage.weather)) {
    const r = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${c[0].toFixed(3)}&longitude=${c[1].toFixed(3)}&hourly=temperature_2m,precipitation&start_date=${day}&end_date=${day}&timezone=Europe%2FBerlin`, { timeout: 15000 });
    state.usage.weather[key] = r.ok ? { temp: r.json.hourly.temperature_2m, rain: r.json.hourly.precipitation, name: state.scope === 'DE' ? 'Deutschland-Mitte' : muniName(state.scope) } : null;
  }
  return state.usage.weather[key];
}
function hourChart(series, weather, runs) {
  const W = 900, H = 260, P = { l: 44, r: weather ? 44 : 12, t: 12, b: 26 };
  const vals = series.flatMap(s => s.values);
  const max = Math.max(1, ...vals) * 1.1;
  const x = (h) => P.l + ((h + 0.5) / 24) * (W - P.l - P.r);
  const y = (v) => P.t + (1 - v / max) * (H - P.t - P.b);
  let g = '';
  for (let k = 0; k <= 4; k++) { const v = (max * k) / 4; g += `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${P.l - 6}" y="${y(v) + 3}" text-anchor="end">${fmt(Math.round(v))}</text>`; }
  for (let h = 0; h < 24; h += 3) g += `<text x="${x(h)}" y="${H - 8}" text-anchor="middle">${h} Uhr</text>`;
  // beobachtete Stunden markieren
  if (runs?.length) { const hs = new Set(runs.map(r => new Date(r[0]).getHours())); for (let h = 0; h < 24; h++) if (!hs.has(h)) g += `<rect x="${x(h) - (W - P.l - P.r) / 48}" y="${P.t}" width="${(W - P.l - P.r) / 24}" height="${H - P.t - P.b}" fill="var(--line)" opacity=".35"/>`; }
  let wx = '';
  if (weather) {
    const rmax = Math.max(1, ...weather.rain.map(v => v || 0)); const tmin = Math.min(...weather.temp), tmax = Math.max(...weather.temp);
    const yr = (v) => P.t + (1 - (v || 0) / rmax) * (H - P.t - P.b);
    const yt = (v) => P.t + (1 - (v - tmin + 2) / (tmax - tmin + 4)) * (H - P.t - P.b);
    for (let h = 0; h < 24; h++) if (weather.rain[h] > 0) wx += `<rect x="${x(h) - 8}" y="${yr(weather.rain[h])}" width="16" height="${H - P.b - yr(weather.rain[h])}" fill="#6aa9ff" opacity=".3"/>`;
    wx += `<path d="${weather.temp.map((v, h) => `${h ? 'L' : 'M'}${x(h).toFixed(1)} ${yt(v).toFixed(1)}`).join(' ')}" fill="none" stroke="#e3b341" stroke-width="1.5" stroke-dasharray="4 3"/>`;
    wx += `<text x="${W - P.r + 6}" y="${yt(tmax) + 3}">${fmt(tmax)}°</text><text x="${W - P.r + 6}" y="${yt(tmin) + 3}">${fmt(tmin)}°</text><text x="${W - P.r + 6}" y="${yr(rmax) + 3}" fill="#6aa9ff">${fmt(rmax, 1)} mm</text>`;
  }
  const paths = series.map((s, i) => `<path d="${s.values.map((v, h) => `${h ? 'L' : 'M'}${x(h).toFixed(1)} ${y(v).toFixed(1)}`).join(' ')}" fill="none" stroke="${s.color || palette(i)}" stroke-width="2" stroke-linejoin="round"/>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Fahrtbeginne je Stunde">${g}${wx}${paths}</svg>`;
}
async function cellsForScope(day) {
  if (state.scope === 'DE') return null;
  const st = scopeState(); if (!st) return null;
  const doc = await loadCells(day, st); return doc?.munis?.[state.scope] || null;
}
async function renderCellsTable(day) {
  const tb = $('#tbl-cells tbody');
  const cells = await cellsForScope(day);
  if (!cells) { tb.innerHTML = `<tr><td colspan="6" class="empty">${state.scope === 'DE' ? 'Bitte eine Gemeinde wählen.' : 'Noch keine Zellen für diesen Tag.'}</td></tr>`; return; }
  const runs = (state.usage.docs[day]?.runs || []).length || 1;
  const rows = Object.entries(cells).map(([cell, v]) => ({ cell, start: v[0], end: v[1], present: v[2], reloc: v[3], net: v[1] - v[0] })).filter(r => r.start + r.end + r.reloc > 0).sort((a, b) => b.start - a.start).slice(0, 15);
  tb.innerHTML = rows.map(r => { const [lat, lon] = cellCenterOf(r.cell); return `<tr><td><a href="#live" class="pick-cell" data-lat="${lat}" data-lon="${lon}">${lat.toFixed(4)}, ${lon.toFixed(4)}</a></td><td class="n">${fmt(r.start)}</td><td class="n">${fmt(r.end)}</td><td class="n" style="color:var(--${r.net > 0 ? 'ok' : r.net < 0 ? 'bad' : 'muted'})">${r.net > 0 ? '+' : ''}${fmt(r.net)}</td><td class="n">${pctf(Math.min(r.present, runs), runs)}</td><td class="n">${fmt(r.reloc)}</td></tr>`; }).join('') || '<tr><td colspan="6" class="empty">Keine Bewegungen in diesem Gebiet.</td></tr>';
}
const CELL_LAT = 0.0025, CELL_LON = 0.0035;
function cellCenterOf(cell) { const [a, b] = cell.split(':').map(Number); return [a * CELL_LAT, b * CELL_LON]; }
async function renderQuota() {
  const q = await loadOnce('quota', 'stations-quota.json'); const tb = $('#tbl-quota tbody');
  if (!q) { tb.innerHTML = '<tr><td colspan="5" class="empty">Keine Stationsdaten.</td></tr>'; return; }
  let rows = q.stations.filter(s => (state.scope === 'DE' || s[0] === state.scope) && (state.operator === 'all' || s[1] === state.operator) && s[5] >= 3);
  rows.sort((a, b) => (b[6] / b[5]) - (a[6] / a[5]) || b[5] - a[5]);
  rows = rows.slice(0, 25);
  tb.innerHTML = rows.map(s => `<tr><td>${esc(s[2] || 'Station')}${state.scope === 'DE' ? `<div class="sub-line">${esc(muniName(s[0]))}</div>` : ''}</td><td>${esc(s[1])}</td><td class="n">${fmt(s[5])}</td><td class="n"><span style="color:var(--${s[6] / s[5] >= 0.5 ? 'bad' : s[6] / s[5] >= 0.25 ? 'warn' : 'fg'})">${pctf(s[6], s[5])}</span></td><td class="n">${pctf(s[7], s[5])}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">Keine Stationen mit genug Läufen im Filter.</td></tr>';
}

// ---------- Karten-Ebenen: Start/Ziel, bediente Zellen, lange Standzeiten, Betriebszonen ----------
async function renderFlowLayer() {
  const L_ = state.layers; L_.grid.clearLayers();
  const idx = await loadUsageIndex(); const day = state.usage.day || idx.days?.slice(-1)[0]; if (!day) { notice('Noch keine Ereignisdaten für die Start/Ziel-Ebene.', '', 'flow'); return; }
  const cells = await cellsForScope(day); if (!cells) { notice('Start/Ziel-Ebene: bitte eine Gemeinde wählen.', '', 'flow'); return; }
  clearNotice('flow');
  const list = Object.entries(cells).map(([cell, v]) => ({ cell, start: v[0], end: v[1], net: v[1] - v[0], reloc: v[3] })).filter(r => r.start + r.end > 0);
  const max = Math.max(1, ...list.map(r => Math.abs(r.net)), ...list.map(r => r.start));
  for (const r of list) {
    const [lat, lon] = cellCenterOf(r.cell);
    const col = r.net > 0 ? '#6aa9ff' : r.net < 0 ? '#ef6b6b' : '#8b949e';
    L.rectangle([[lat - CELL_LAT / 2, lon - CELL_LON / 2], [lat + CELL_LAT / 2, lon + CELL_LON / 2]], { weight: 0, fillColor: col, fillOpacity: 0.15 + 0.65 * (Math.max(Math.abs(r.net), r.start * 0.5) / max) })
      .bindPopup(`<b>Zelle</b><br>${fmt(r.start)} Fahrtbeginne · ${fmt(r.end)} Fahrtenden<br>Netto ${r.net > 0 ? '+' : ''}${fmt(r.net)} · ${fmt(r.reloc)} Umsetzungen`).addTo(L_.grid);
  }
  $('#map-legend').innerHTML = `<span><i class="dot" style="background:#ef6b6b"></i>Netto-Abfluss (mehr Starts)</span><span><i class="dot" style="background:#6aa9ff"></i>Netto-Zufluss (mehr Ziele)</span><span class="muted">${day.split('-').reverse().join('.')} · ${fmt(list.length)} Zellen mit Bewegung</span>`;
}
async function renderServedLayer() {
  const L_ = state.layers; L_.grid.clearLayers();
  const idx = await loadUsageIndex(); const st = scopeState();
  if (state.scope === 'DE' || !st) { notice('Bediente Zellen: bitte eine Gemeinde wählen.', '', 'flow'); return; }
  const days = (idx.cellDays || []).slice(-7); if (!days.length) { notice('Noch keine Zellen-Daten.', '', 'flow'); return; }
  clearNotice('flow');
  const agg = new Map();
  for (const d of days) { const doc = await loadCells(d, st); const cells = doc?.munis?.[state.scope]; if (!cells) continue; for (const [cell, v] of Object.entries(cells)) { if (!v[2]) continue; const a = agg.get(cell) || { present: 0, days: 0 }; a.present += v[2]; a.days++; agg.set(cell, a); } }
  const maxP = Math.max(1, ...[...agg.values()].map(a => a.present));
  for (const [cell, a] of agg) { const [lat, lon] = cellCenterOf(cell); L.rectangle([[lat - CELL_LAT / 2, lon - CELL_LON / 2], [lat + CELL_LAT / 2, lon + CELL_LON / 2]], { weight: 0, fillColor: '#49c7b0', fillOpacity: 0.12 + 0.6 * (a.present / maxP) }).bindPopup(`an ${a.days} von ${days.length} Tagen bedient · ${fmt(a.present)} Fahrzeug-Beobachtungen`).addTo(L_.grid); }
  $('#map-legend').innerHTML = `<span><i class="dot" style="background:#49c7b0"></i>Zelle mit verfügbarem Fahrzeug in den letzten ${days.length} Tagen, dunkler = häufiger</span><span class="muted">${fmt(agg.size)} Zellen ≈ ${fmt(agg.size * 0.07, 1)} km²</span>`;
}
async function renderIdleLayer() {
  const L_ = state.layers; L_.grid.clearLayers();
  const d = await loadOnce('idleLong', 'idle-long.json'); if (!d) return;
  const pts = d.points.filter(p => (state.scope === 'DE' || p.ags === state.scope) && (state.operator === 'all' || p.op === state.operator) && (state.type === 'all' || p.ty === state.type));
  for (const p of pts) L.circleMarker([p.lat, p.lon], { radius: 5, weight: 1, color: '#e3b341', fillColor: '#e3b341', fillOpacity: .7 }).bindPopup(`<b>${esc(p.op)}</b> · ${TYPE[p.ty] || p.ty}<br>steht seit ${fmt(p.hours)} h${p.bat != null ? ` · Akku ${fmt(p.bat)} %` : ''}`).addTo(L_.grid);
  $('#map-legend').innerHTML = `<span><i class="dot" style="background:#e3b341"></i>verfügbar, aber seit über 2 Tagen unbewegt</span><span class="muted">${fmt(pts.length)} gezeigt${d.total > d.points.length ? ` (je Gemeinde ausgedünnt, gesamt ${fmt(d.total)})` : ''} · Stand ${timeText(d.at)}</span>`;
}
async function renderZonesLayer() {
  const L_ = state.layers; L_.zones.clearLayers();
  if (!$('#chk-zones').checked) { clearNotice('zones'); return; }
  const idx = await loadOnce('zonesIndex', 'zones/index.json'); if (!idx?.zones?.length) { notice('Keine Betriebszonen in den Feeds gefunden.', '', 'zones'); return; }
  let list = idx.zones.filter(z => (state.scope === 'DE' || (z.municipalities || []).includes(state.scope)) && (state.operator === 'all' || z.operator === state.operator));
  if (state.scope === 'DE') { notice('Betriebszonen: bitte eine Gemeinde wählen (sonst zu viele Polygone).', '', 'zones'); return; }
  list = list.slice(0, 8);
  let n = 0;
  for (const z of list) {
    if (!(z.file in state.usage.zones)) { const r = await getJson(CFG.DATA + `zones/${z.file}`, { timeout: 60000 }); state.usage.zones[z.file] = r.json || null; }
    const fc = state.usage.zones[z.file]; if (!fc) continue;
    const b = state.boundaries?.features.find(x => x.properties.ags === state.scope)?.bbox;
    const inB = (f) => { if (!b) return true; const c = JSON.stringify(f.geometry.coordinates).match(/-?\d+\.\d+/g); if (!c) return true; let minX = 999, maxX = -999, minY = 999, maxY = -999; for (let i = 0; i + 1 < c.length; i += 2) { const x = +c[i], y = +c[i + 1]; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; } return !(maxX < b[0] - .05 || minX > b[2] + .05 || maxY < b[1] - .05 || minY > b[3] + .05); };
    for (const f of fc.features.filter(inB)) {
      const ru = f.properties.rules || [];
      // GBFS 2.x: ride_allowed = Fahrt darf hier beginnen/enden; ride_through_allowed = Durchfahrt; station_parking = nur an Stationen abstellen
      const mpz = ru.some(r => r.parking === true), noRide = ru.some(r => r.rideThrough === false), noEnd = !mpz && ru.some(r => r.endAllowed === false || r.rideAllowed === false), slow = ru.find(r => r.maxSpeed != null)?.maxSpeed;
      const col = noRide ? '#ef6b6b' : noEnd ? '#e3b341' : mpz ? '#60a5fa' : slow != null ? '#c084fc' : opColor(z.operator);
      L.geoJSON(f, { style: { color: col, weight: noRide ? 1 : 1.5, fillOpacity: noRide ? .05 : .07, dashArray: (noEnd || mpz) && !noRide ? '4 3' : null } })
        .bindPopup(`<b>${esc(z.operator)}</b> · ${esc(f.properties.name || 'Zone')}<br>${noRide ? 'Fahren verboten' : 'Fahren erlaubt'}${noEnd ? ' · Abstellen verboten' : ''}${mpz ? ' · Abstellen nur an Stationen' : ''}${slow != null ? ` · max. ${fmt(slow)} km/h` : ''}`).addTo(L_.zones);
      n++;
    }
  }
  notice(`Betriebszonen: ${fmt(n)} Polygone aus ${list.length} Feed${list.length === 1 ? '' : 's'} (${[...new Set(list.map(z => z.operator))].join(', ')}). Rot = Fahrverbot, gelb gestrichelt = Abstellverbot, blau gestrichelt = Abstellen nur an Stationen, violett = Tempolimit, Anbieterfarbe = Betriebsgebiet.`, '', 'zones');
}

// ---------- Preise, Marktanteile, Zuverlässigkeit ----------
async function renderPricing() {
  const p = await loadOnce('pricing', 'pricing.json'); const tb = $('#tbl-pricing tbody');
  if (!p?.plans?.length) { tb.innerHTML = '<tr><td colspan="6" class="empty">Noch keine Preisfeeds gelesen.</td></tr>'; return; }
  let list = p.plans.filter(x => (state.scope === 'DE' || (x.municipalities || []).includes(state.scope)) && (state.operator === 'all' || x.operator === state.operator));
  const seen = new Set(); const rows = [];
  for (const src of list) for (const pl of src.plans) { const key = `${src.operator}|${pl.name}|${pl.unlock}|${pl.perMin[0]?.rate}`; if (seen.has(key)) continue; seen.add(key); rows.push({ op: src.operator, pl, src }); }
  rows.sort((a, b) => a.op.localeCompare(b.op) || (a.pl.unlock ?? 0) - (b.pl.unlock ?? 0));
  const money = (v, cur) => v == null ? '—' : `${fmt(v, 2)} ${cur || '€'}`.replace(' EUR', ' €');
  tb.innerHTML = rows.slice(0, 60).map(({ op, pl, src }) => `<tr><td><span class="op"><i style="background:${opColor(op)}"></i>${esc(op)}</span>${state.scope === 'DE' ? `<div class="sub-line">${esc(src.sourceId)}</div>` : ''}</td><td>${esc(pl.name || pl.id)}</td><td class="n">${money(pl.unlock, pl.currency)}</td><td class="n">${pl.perMin.length ? pl.perMin.map(x => `${money(x.rate, pl.currency)}${x.interval && x.interval !== 1 ? ` je ${x.interval} Min.` : ''}${x.start ? ` ab Min. ${x.start}` : ''}`).join('<br>') : '—'}</td><td class="n">${pl.perKm.length ? pl.perKm.map(x => money(x.rate, pl.currency)).join('<br>') : '—'}</td><td class="small">${esc(pl.desc || '')}${pl.surge ? ' · dynamisch' : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">Keine Preisangaben für diesen Filter.</td></tr>';
  $('#pricing-note').textContent = rows.length > 60 ? `${rows.length - 60} weitere Tarife – Gebiet oder Anbieter wählen.` : `${rows.length} Tarife · Stand ${timeText(p.at)}`;
}
async function renderShareChart() {
  const idx = state.histIndex; const box = $('#chart-share');
  const days = (idx?.days || []).slice(-7);
  if (!days.length) { box.innerHTML = '<div class="empty">Noch kein Verlauf.</div>'; return; }
  const perDay = [];
  for (const d of days) { const h = await loadHistory(d); if (!h) { perDay.push(null); continue; } const byOp = new Map(); for (const [k, ser] of Object.entries(h.series)) { const [ags, op, ty] = k.split('|'); if (ags === 'DE') continue; if (state.scope !== 'DE' && ags !== state.scope) continue; if (state.type !== 'all' && ty !== state.type) continue; const v = ser.available.filter(x => x != null); if (!v.length) continue; byOp.set(op, (byOp.get(op) || 0) + v.reduce((a, b) => a + b, 0) / v.length); } perDay.push(byOp); }
  const ops = [...new Set(perDay.flatMap(m => m ? [...m.keys()] : []))];
  const totals = perDay.map(m => m ? [...m.values()].reduce((a, b) => a + b, 0) : 0);
  const series = ops.map(op => ({ name: op, color: opColor(op), values: perDay.map((m, i) => m && totals[i] ? ((m.get(op) || 0) / totals[i]) * 100 : null) })).sort((a, b) => (b.values.at(-1) || 0) - (a.values.at(-1) || 0)).slice(0, 8);
  const W = 900, H = 220, P = { l: 44, r: 12, t: 12, b: 26 };
  const x = (i) => P.l + (i / Math.max(1, days.length - 1)) * (W - P.l - P.r), y = (v) => P.t + (1 - v / 100) * (H - P.t - P.b);
  let g = ''; for (let k = 0; k <= 4; k++) g += `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y(k * 25)}" y2="${y(k * 25)}"/><text x="${P.l - 6}" y="${y(k * 25) + 3}" text-anchor="end">${k * 25} %</text>`;
  days.forEach((d, i) => { g += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${d.slice(8)}.${d.slice(5, 7)}.</text>`; });
  const paths = series.map(s => { let d = '', open = false; s.values.forEach((v, i) => { if (v == null) { open = false; return; } d += `${open ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `; open = true; }); return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2"/>` + s.values.map((v, i) => v == null ? '' : `<circle cx="${x(i)}" cy="${y(v)}" r="3" fill="${s.color}"/>`).join(''); }).join('');
  box.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Marktanteile">${g}${paths}</svg>`;
  $('#share-legend').innerHTML = series.map(s => `<span><i class="dot" style="background:${s.color}"></i>${esc(s.name)} <span class="mono">${s.values.at(-1) == null ? '—' : fmt(s.values.at(-1), 1) + ' %'}</span></span>`).join('');
}

// ---------- Konsistenz ----------
const CONS_LABEL = { consistent: ['Stimmig', 'ok'], minor: ['Kleine Abweichung', 'warn'], divergent: ['Abweichend', 'bad'], disjoint: ['Getrennte Flotten', 'info'], alt_unreachable: ['Alternative nicht erreichbar', 'muted'], error: ['Fehler', 'bad'] };
const CONS_KIND = { version: 'v2 ↔ v3 (gleicher Host)', land_vs_betreiber: 'Landesfeed ↔ Betreiber', betreiber_vs_land: 'Betreiber ↔ Landesfeed' };
const shortSrc = (id) => String(id).replace(/^mobidrom_[^:]+:source-/, 'NRW · ').replace(/^citybikes_/, 'CityBikes · ');
async function renderConsistency() {
  const c = await loadOnce('consistency', 'consistency.json'); const tb = $('#tbl-cons tbody');
  if (!c) { tb.innerHTML = '<tr><td colspan="9" class="empty">Noch keine Konsistenzprüfung.</td></tr>'; return; }
  const inScope = (ids, ags) => state.scope === 'DE' ? true : (ags ? ags === state.scope : ids.some(id => (state.latest?.sources || []).find(r => r.id === id)?.municipalities?.includes(state.scope)));
  const rows = [];
  for (const e of c.systems) { if (!inScope([e.sourceId]) || (state.operator !== 'all' && e.operator !== state.operator)) continue; rows.push({ kind: `${CONS_KIND[e.kind] || e.kind || 'Alternativ-Feed'}${e.idsRekeyed ? ' · Kennungen umgeschlüsselt' : ''}${e.stationsOnly ? ' · Stationen' : ''}<div class="sub-line mono">${esc(e.sourceId)}</div>`, op: e.operator, a: e.stationsOnly ? e.primary?.stations : e.primary?.vehicles, b: e.stationsOnly ? e.alt?.stations : e.alt?.vehicles, diff: e.countDiff, overlap: e.idOverlap, pm: e.posMatch, med: e.medianDistM, verdict: e.verdict, w: e.verdict === 'divergent' ? 3 : e.verdict === 'minor' ? 2 : e.verdict === 'alt_unreachable' ? 1 : 0 }); }
  for (const p of c.pairs) { if (!inScope([p.a.sourceId, p.b.sourceId], p.ags) || (state.operator !== 'all' && p.operator !== state.operator)) continue; rows.push({ kind: `Zwei Quellen · ${esc(muniName(p.ags))}${p.idsRekeyed ? ' · Kennungen umgeschlüsselt' : ''}<div class="sub-line mono">${esc(shortSrc(p.a.sourceId))} ↔ ${esc(shortSrc(p.b.sourceId))}</div>`, op: p.operator, a: p.a.vehicles, b: p.b.vehicles, diff: p.countDiff, overlap: p.idOverlap, pm: p.posMatch, med: p.medianDistM, verdict: p.verdict, w: p.verdict === 'divergent' ? 3 : p.verdict === 'minor' ? 2 : p.verdict === 'disjoint' ? 1.5 : 0 }); }
  rows.sort((x, y) => y.w - x.w || (y.a || 0) - (x.a || 0));
  const seenRow = new Set(); const uniq = rows.filter(r => { const k = r.kind.replace(/<[^>]+>/g, '') + '|' + r.op; if (seenRow.has(k)) return false; seenRow.add(k); return true; });
  rows.length = 0; rows.push(...uniq);
  const show = rows.slice(0, 80);
  tb.innerHTML = show.map(r => { const [label, cls] = CONS_LABEL[r.verdict] || [r.verdict, '']; return `<tr><td>${r.kind}</td><td><span class="op"><i style="background:${opColor(r.op)}"></i>${esc(r.op)}</span></td><td class="n">${fmt(r.a)}</td><td class="n">${fmt(r.b)}</td><td class="n">${r.diff == null ? '—' : pctf(r.diff, 1)}</td><td class="n">${r.overlap == null ? '—' : pctf(r.overlap, 1)}</td><td class="n">${r.pm == null ? '—' : pctf(r.pm, 1)}</td><td class="n">${r.med == null ? '—' : `${fmt(r.med)} m`}</td><td><span class="pill plain" style="color:var(--${cls === 'muted' ? 'muted' : cls})">${label}</span></td></tr>`; }).join('') || '<tr><td colspan="9" class="empty">Keine Vergleiche im Filter.</td></tr>';
  const vc = {}; for (const r of rows) vc[r.verdict] = (vc[r.verdict] || 0) + 1;
  $('#cons-note').textContent = `${rows.length} Vergleiche · ${Object.entries(vc).map(([k, v]) => `${v} ${(CONS_LABEL[k] || [k])[0].toLowerCase()}`).join(' · ')} · Stand ${timeText(c.at)}${rows.length > show.length ? ` · ${rows.length - show.length} weitere` : ''}`;
}

const METHOD = `
<h2>Die Auswertung im Detail</h2>
<h3>Zählweise</h3><p>Verfügbar heißt buchbar: nicht reserviert, nicht gesperrt. Bei Stationen werden physischer Bestand, buchbarer Bestand (<span class="mono">is_installed</span> und <span class="mono">is_renting</span>) und Rückgabeplätze getrennt geführt; eine geschlossene Station zählt ihre Fahrzeuge nicht als verfügbar. Stationäre Quellen werden nur dann als Fahrzeugbestand addiert, wenn die Quelle keine Fahrzeugliste liefert.</p>
<h3>Frische</h3><p>Quellen bis fünf Minuten Alter gelten als aktuell, bis 30 Minuten als verzögert, darüber als veraltet. Veraltete und zeitlich unklare Quellen fließen nicht in Kennzahlen ein, bleiben aber als Lücke sichtbar. Positionsalter (je Fahrzeug) und Quellenalter (je Feed) sind getrennte Merkmale.</p>
<h3>Geo-Prüfung und Ortszuordnung</h3><p>Zahlenformate werden normalisiert, eindeutig vertauschte Breiten- und Längengrade korrigiert. Fehlt ein Koordinatenpaar, dient eine referenzierte Stationsposition als gekennzeichneter Ersatz. Positionen außerhalb Deutschlands oder ohne Gemeinde bleiben außen vor. Die Gemeinde ergibt sich aus GPS und BKG-Gemeindegrenze (VG250, vereinfacht ca. 30 m); ein Sammelfeed kann mehrere Orte beliefern. Die Anbieterauswahl folgt der tatsächlichen GPS-Abdeckung des gewählten Orts.</p>
<h3>Dubletten und Quellenwechsel</h3><p>Fahrzeuge desselben Anbieters werden über alle Quellen zusammengeführt: UUIDs und Quellenpräfixe werden vereinheitlicht, der jüngste Stand gewinnt, bei Gleichstand die direkte Position vor dem Stationsersatz. Gleiche Kennungen an weit entfernten Positionen (über 300 m) bleiben als Prüffälle erhalten. Stationen gelten als gleich bei gleicher Kennung oder gleichem Namen innerhalb von 60 m. Ein Fingerabdruck aus Endpunkt, Version, Feeds und Fahrzeugarten erkennt Quellenwechsel; danach beginnen Zeitvergleiche neu.</p>
<h3>Energie</h3><p>Ladestand und Reichweite haben getrennte Nenner; gezählt werden nur Fahrzeuge mit der jeweiligen Angabe. Fehlt der Ladestand, wird er bei bekannter Maximalreichweite aus der Reichweite abgeleitet. Grenzen lassen sich im Performance Lab einstellen und gelten im Live-Abruf; der Sammler rechnet mit 20 % und 5 km.</p>
<h3>Verlauf</h3><p>Der Sammler läuft alle 20 Minuten unabhängig vom Browser (GitHub Actions) und speichert bereinigte Summen je Gemeinde, Anbieter und Fahrzeugart für 30 Tage. Individuelle Fahrzeugwege werden nicht archiviert. Der Live-Abruf im Browser liest die offenen Feeds direkt; Zugangsquellen (MOBIDROM NRW) kommen als Momentaufnahme des letzten Sammler-Laufs. Δ Sammler vergleicht den Live-Stand mit dem letzten Sammler-Punkt desselben Quellen-Fingerabdrucks.</p>
<h3>Qualität</h3><p>Der Qualitätswert einer Quelle beurteilt Frische (70 %) und vorhandene Merkmale wie Energie, Zeitstempel und Fahrzeugart (30 %). Er bewertet die Quelle, nicht den Betrieb des Unternehmens. Gesperrte Fahrzeuge, leere Stationen und Niedrigakku sind Hinweise aus dem Feed; was ein Betreiber gerade bearbeitet, ist ohne internen Zugang nicht bekannt.</p>
<h3>Nutzung und Bewegung</h3><p>Der Sammler merkt sich je Fahrzeug eine gehashte Kennung mit gerundeter Position, Ladestand und Sperrstatus. Verschwindet eine Kennung zwischen zwei Läufen, zählt das als Fahrtbeginn (bei gesperrtem oder fast leerem Fahrzeug als Abholung); eine neue Kennung zählt als Fahrtende. GBFS schreibt vor, Kennungen nach jeder Fahrt zu wechseln, deshalb sind das Zählungen ohne Zuordnung von Start zu Ziel. Bei Systemen mit stabilen Kennungen (etwa stationsbasierte Räder) kehrt die Kennung zurück; dann sind Dauer und Luftlinien-Distanz messbar und werden als Ø ausgewiesen. Gleiche Kennung, nie verschwunden, aber über 150 m versetzt: Umsetzung durch den Betreiber. Ladestand springt von unter 40 % auf mindestens 85 % am selben Ort: Akkutausch; die Wartezeit misst die Zeit unter 20 % bis zum Tausch. Standzeit ist die Zeit seit der letzten Positionsänderung über 50 m (höchstens seit dem ersten Sammler-Kontakt). Quellenausfälle erzeugen keine Fahrten. Alle Werte sind Schätzungen aus 20-Minuten-Momentaufnahmen und keine Betreiberzahlen.</p>
<h3>Zellen, Zonen, Preise</h3><p>Start- und Zielzellen sind etwa 250 m groß und werden je Gemeinde und Tag gezählt; „bedient“ ist eine Zelle, in der innerhalb von 7 Tagen ein verfügbares Fahrzeug stand. Betriebszonen stammen aus <span class="mono">geofencing_zones.json</span> der Anbieterfeeds, Preise aus <span class="mono">system_pricing_plans.json</span>; beides wird je Lauf neu gelesen. Wetter kommt stündlich von Open-Meteo für den Gemeindemittelpunkt. Stations-Verfügbarkeitsquoten zählen Läufe der letzten 7 Tage, in denen eine vermietende Station kein buchbares Fahrzeug bzw. keinen freien Platz hatte.</p>
<h3>Konsistenz und Fußwege</h3><p>Hat ein System im Katalog eine zweite Adresse (Landesfeed und Betreiberfeed oder zwei GBFS-Versionen), liest der Sammler beide und vergleicht Bestand, Kennungs-Überlappung (gemeinsame ÷ alle Kennungen) und den Median-Abstand gleicher Kennungen; schlüsselt ein Verzeichnis die Kennungen um (Landesfeeds tun das), zählt stattdessen der Anteil der Fahrzeuge, zu denen in der anderen Quelle ein Fahrzeug innerhalb von 10 m steht. Liefern zwei Quellen desselben Anbieters Fahrzeuge in derselben Gemeinde, werden sie paarweise genauso verglichen; „getrennte Flotten“ heißt, dass sich die Kennungen kaum überschneiden. Fußwege in der Haltestellen-Analyse kommen vom Fußgängerprofil der FOSSGIS-Routingdienste (Valhalla, bei Ausfall OSRM auf routing.openstreetmap.de); je Haltestelle werden die zwei nächsten Fahrzeuge geroutet, der Umweg-Faktor ist Fußweg ÷ Luftlinie.</p>
<h3>Grenzen</h3><p>Die angeschlossenen Daten bilden keine vollständigen Marktanteile ab. Die Nettobilanz über zehn Minuten misst Aufbau oder Rückgang des verfügbaren Bestands; Ausleihen, Rückgaben, Reservierungen und Umverteilung haben denselben Effekt, eine Tripzahl ist daraus nicht ableitbar. Versorgungsentfernungen sind Luftlinien, sofern das Fußweg-Routing nicht aktiviert ist. Basiskarte © OpenStreetMap-Mitwirkende; Haltestellen aus OpenStreetMap (ODbL).</p>`;

// ---------- Versorgung an Haltestellen ----------
async function checkSupply() {
  const box = $('#supply');
  if (state.scope === 'DE') { box.innerHTML = '<div class="empty">Bitte eine Gemeinde wählen.</div>'; return; }
  if (!state.live) { box.innerHTML = '<div class="empty">Zuerst „Live abrufen“, damit Fahrzeugpositionen vorliegen.</div>'; return; }
  await loadBoundaries();
  const f = state.boundaries?.features.find(x => x.properties.ags === state.scope); if (!f) { box.innerHTML = '<div class="empty">Gemeindegrenze fehlt.</div>'; return; }
  const b = f.bbox; const radius = +$('#sel-radius').value; const useWalk = $('#chk-walk').checked;
  box.innerHTML = '<div class="muted small">Haltestellen werden geladen …</div>';
  const q = `[out:json][timeout:25];(node["highway"="bus_stop"](${b[1]},${b[0]},${b[3]},${b[2]});node["railway"="tram_stop"](${b[1]},${b[0]},${b[3]},${b[2]});node["railway"="station"](${b[1]},${b[0]},${b[3]},${b[2]});node["railway"="halt"](${b[1]},${b[0]},${b[3]},${b[2]}););out body 800;`;
  let r = null;
  for (const ep of CFG.OVERPASS) { r = await getJson(`${ep}?data=${encodeURIComponent(q)}`, { timeout: 40000 }); if (r.ok && r.json?.elements) break; }
  if (!r?.ok || !r.json?.elements) { box.innerHTML = `<div class="empty">Overpass nicht erreichbar (${r?.error || r?.status}) – alle Spiegel versucht, bitte später erneut.</div>`; return; }
  const rawStops = (r.json.elements || []).filter(e => C.assignMunicipality(state.bIndex, e.lat, e.lon)?.ags === state.scope).map(e => ({ id: e.id, name: e.tags?.name || 'Haltestelle', lat: e.lat, lon: e.lon, kind: e.tags?.railway ? 'Bahn/Tram' : 'Bus' }));
  // Gegenüberliegende Haltepunkte gleichen Namens (innerhalb 80 m) zu einer Haltestelle zusammenfassen
  const stops = [];
  for (const st of rawStops) { const twin = stops.find(o => o.name === st.name && C.haversineM(o.lat, o.lon, st.lat, st.lon) <= 80); if (twin) { twin.n = (twin.n || 1) + 1; twin.lat = (twin.lat * (twin.n - 1) + st.lat) / twin.n; twin.lon = (twin.lon * (twin.n - 1) + st.lon) / twin.n; continue; } stops.push({ ...st, n: 1 }); }
  const { vehicles } = livePoints(); const avail = vehicles.filter(v => !v.disabled && !v.reserved);
  // Luftlinie: drei nächste Kandidaten je Haltestelle
  for (const s of stops) {
    const cands = [];
    for (const v of avail) { const d = C.haversineM(s.lat, s.lon, v.lat, v.lon); if (cands.length < 2 || d < cands[1].d) { cands.push({ d, v }); cands.sort((a, b) => a.d - b.d); if (cands.length > 2) cands.pop(); } }
    s.cands = cands; s.dist = cands.length ? Math.round(cands[0].d) : null; s.op = cands[0]?.v.operator || null; s.walk = null; s.walkMin = null; s.walkOp = null;
  }
  // Fußweg (OSRM, Fußgänger-Profil der FOSSGIS-Instanz): nur Haltestellen, die per Luftlinie überhaupt in Reichweite sein könnten
  let routed = 0, routeFail = 0;
  if (useWalk && stops.length) {
    const limit = Math.max(radius * 2, 1500);
    const todo = stops.filter(s => s.dist != null && s.dist <= limit).slice(0, 600);
    const batchSize = 6; // 6 Haltestellen × ≤ 12 Ziele = ein Valhalla-Aufruf (Quellen × Ziele ≤ 100)
    const batches = []; for (let i = 0; i < todo.length; i += batchSize) batches.push(todo.slice(i, i + batchSize));
    let done = 0;
    for (const batch of batches) {
      box.innerHTML = `<div class="muted small">Fußwege werden berechnet … ${done} / ${todo.length} Haltestellen (${state.walkProvider || 'Valhalla'})</div><div class="progress"><i style="width:${(done / todo.length) * 100}%"></i></div>`;
      const targets = [], targetIdx = new Map();
      batch.forEach(s => s.cands.forEach(c => { const k = `${c.v.lon.toFixed(5)},${c.v.lat.toFixed(5)}`; if (!targetIdx.has(k)) { targetIdx.set(k, targets.length); targets.push({ lat: c.v.lat, lon: c.v.lon }); } }));
      const m = await walkMatrix(batch, targets);
      if (!m) { routeFail += batch.length; done += batch.length; continue; }
      batch.forEach((s, i) => {
        let best = Infinity, bestSec = null, bestOp = null;
        for (const c of s.cands) { const j = targetIdx.get(`${c.v.lon.toFixed(5)},${c.v.lat.toFixed(5)}`); const d = m.dist?.[i]?.[j]; if (d != null && d < best) { best = d; bestSec = m.sec?.[i]?.[j]; bestOp = c.v.operator; } }
        if (Number.isFinite(best)) { s.walk = Math.round(best); s.walkMin = bestSec != null ? Math.round(bestSec / 60) : null; s.walkOp = bestOp; routed++; }
      });
      done += batch.length;
      await new Promise(res => setTimeout(res, 40));
    }
  }
  // Fußweg, sonst Luftlinie (nicht geroutet oder außerhalb des Routing-Limits)
  const eff = (s) => useWalk ? (s.walk ?? s.dist) : s.dist;
  stops.sort((a, b) => (eff(b) ?? 1e9) - (eff(a) ?? 1e9));
  const gaps = stops.filter(s => eff(s) == null || eff(s) > radius);
  state.supply = { stops, radius, useWalk, eff };
  const vals = stops.map(eff).filter(v => v != null).sort((a, b) => a - b);
  const med = vals.length ? vals[Math.floor(vals.length / 2)] : null;
  const ratio = (() => { const pairs = stops.filter(s => s.walk != null && s.dist); return pairs.length ? pairs.reduce((a, s) => a + s.walk / s.dist, 0) / pairs.length : null; })();
  box.innerHTML = `<div class="tiles" style="margin-bottom:10px">${tile('Haltestellen', fmt(stops.length), `OSM, innerhalb ${esc(muniName(state.scope))} · ${fmt(rawStops.length)} Haltepunkte zusammengefasst`)}${tile(`Ohne Fahrzeug in ${radius} m ${useWalk ? 'Fußweg' : 'Luftlinie'}`, fmt(gaps.length), pctf(gaps.length, stops.length) + ' der Haltestellen', gaps.length / Math.max(1, stops.length) > 0.4 ? 'warn' : '')}${tile(`Median ${useWalk ? 'Fußweg' : 'Luftlinie'}`, med == null ? '—' : `${fmt(med)} m`, 'zum nächsten verfügbaren Fahrzeug')}${useWalk ? tile('Umweg-Faktor', ratio == null ? '—' : fmt(ratio, 2), `${fmt(routed)} Haltestellen geroutet (${state.walkProvider || 'Valhalla'})${routeFail ? ` · ${fmt(routeFail)} ohne Route` : ''} · Fußweg ÷ Luftlinie`) : ''}</div>
  <div class="tbl"><table><thead><tr><th>Haltestelle</th><th>Art</th><th class="n">Luftlinie</th>${useWalk ? '<th class="n">Fußweg</th><th class="n">Gehzeit</th>' : ''}<th>Anbieter</th></tr></thead><tbody>${gaps.slice(0, 40).map(s => `<tr><td>${esc(s.name)}</td><td>${s.kind}</td><td class="n">${s.dist == null ? '—' : `${fmt(s.dist)} m`}</td>${useWalk ? `<td class="n">${s.walk == null ? `<span class="muted">${s.dist != null && s.dist > Math.max(radius * 2, 1500) ? 'außer Reichweite' : 'nicht geroutet'}</span>` : `${fmt(s.walk)} m`}</td><td class="n">${s.walkMin == null ? '—' : `${fmt(s.walkMin)} Min.`}</td>` : ''}<td>${esc((useWalk && s.walkOp) || s.op || '–')}</td></tr>`).join('')}</tbody></table></div>${gaps.length > 40 ? `<div class="muted small">${gaps.length - 40} weitere Haltestellen ohne Fahrzeug im Radius.</div>` : ''}<div class="muted small" style="margin-top:6px">${useWalk ? 'Fußwege über das Fußgängerprofil von valhalla1.openstreetmap.de, bei Ausfall routing.openstreetmap.de/OSRM (beide FOSSGIS); je Haltestelle die zwei nächsten Fahrzeuge geprüft. Haltestellen mit Luftlinie über ' + fmt(Math.max(radius * 2, 1500)) + ' m werden nicht geroutet.' : 'Luftlinie; Fußweg-Routing per Häkchen aktivierbar.'}</div>`;
}

// Fußweg-Matrix: OSRM (FOSSGIS, Fußgängerprofil), bei Ausfall Valhalla (FOSSGIS, pedestrian). Rückgabe {dist[i][j] m, sec[i][j]} oder null.
async function walkMatrix(sources, targets) {
  if (!targets.length) return null;
  const osrm = async () => {
    const coords = [...sources.map(s => `${s.lon.toFixed(6)},${s.lat.toFixed(6)}`), ...targets.map(t => `${t.lon.toFixed(6)},${t.lat.toFixed(6)}`)];
    const url = `${CFG.OSRM_FOOT}/table/v1/driving/${coords.join(';')}?sources=${sources.map((_, i) => i).join(';')}&destinations=${targets.map((_, j) => sources.length + j).join(';')}&annotations=distance,duration`;
    const r = await getJson(url, { timeout: 25000 });
    return r.ok && r.json?.code === 'Ok' ? { dist: r.json.distances, sec: r.json.durations } : null;
  };
  if (state.walkProvider === 'OSRM') return osrm();
  // Valhalla zuerst (schnelle Matrix, Quellen × Ziele ≤ 100 je Aufruf → Teilaufrufe); bei Ausfall OSRM
  const dist = [], sec = [];
  const per = Math.max(1, Math.floor(100 / targets.length));
  for (let i = 0; i < sources.length; i += per) {
    const part = sources.slice(i, i + per);
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 25000);
      const r = await fetch(CFG.VALHALLA + '/sources_to_targets', { method: 'POST', signal: ctrl.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sources: part.map(s => ({ lat: +s.lat.toFixed(6), lon: +s.lon.toFixed(6) })), targets: targets.map(t => ({ lat: +t.lat.toFixed(6), lon: +t.lon.toFixed(6) })), costing: 'pedestrian', units: 'kilometers' }) });
      clearTimeout(t);
      if (!r.ok) throw new Error(`Valhalla ${r.status}`);
      const j = await r.json();
      for (const row of j.sources_to_targets || []) { dist.push(row.map(c => c.distance == null ? null : c.distance * 1000)); sec.push(row.map(c => c.time ?? null)); }
    } catch { const m = await osrm(); if (m) state.walkProvider = 'OSRM'; return m; }
    if (i + per < sources.length) await new Promise(res => setTimeout(res, 60));
  }
  state.walkProvider = 'Valhalla';
  return { dist, sec };
}
function renderSupplyLayer() {
  const L_ = state.layers; L_.supply.clearLayers(); if (!state.supply) return;
  for (const s of state.supply.stops) { const d = state.supply.eff ? state.supply.eff(s) : s.dist; const gap = d == null || d > state.supply.radius; L.circleMarker([s.lat, s.lon], { radius: gap ? 6 : 4, weight: 2, color: gap ? '#ef6b6b' : '#6aa9ff', fillOpacity: .5 }).bindPopup(`<b>${esc(s.name)}</b> (${s.kind})<br>nächstes verfügbares Fahrzeug: ${s.dist == null ? '—' : `${fmt(s.dist)} m Luftlinie`}${s.walk != null ? ` · ${fmt(s.walk)} m Fußweg (${fmt(s.walkMin)} Min.)` : ''} ${esc(s.walkOp || s.op || '')}`).addTo(L_.supply); }
}

// ---------- Steuerung ----------
function populateScope() {
  const sel = $('#sel-scope'); const munis = state.latest?.municipalities || {};
  const byState = {};
  for (const m of Object.values(munis)) { (byState[m.state] ??= []).push(m); }
  const STATES = { BW: 'Baden-Württemberg', BY: 'Bayern', BE: 'Berlin', BB: 'Brandenburg', HB: 'Bremen', HH: 'Hamburg', HE: 'Hessen', MV: 'Mecklenburg-Vorpommern', NI: 'Niedersachsen', NW: 'Nordrhein-Westfalen', RP: 'Rheinland-Pfalz', SL: 'Saarland', SN: 'Sachsen', ST: 'Sachsen-Anhalt', SH: 'Schleswig-Holstein', TH: 'Thüringen' };
  sel.innerHTML = '<option value="DE">Deutschlandweit</option>' + Object.keys(byState).sort((a, b) => (STATES[a] || a).localeCompare(STATES[b] || b)).map(st => `<optgroup label="${STATES[st] || st}">${byState[st].sort((a, b) => a.name.localeCompare(b.name, 'de')).map(m => `<option value="${m.ags}">${esc(m.name)}</option>`).join('')}</optgroup>`).join('');
  sel.value = state.scope;
}
function populateOperators() {
  const sel = $('#sel-operator'); const prev = state.operator;
  let ops;
  if (state.scope === 'DE') ops = [...new Set((state.latest?.sources || []).filter(r => ['live', 'delayed'].includes(r.status)).map(r => r.operator))];
  else ops = Object.keys(muniInfo(state.scope)?.operators || {});
  if (state.live) for (const [k] of state.live.groups) { const [ags, op] = k.split('|'); if (state.scope === 'DE' || ags === state.scope) ops.push(op); }
  for (const g of state.latest?.gaps || []) if (state.scope === 'DE' || muniName(state.scope) === g.city) ops.push(g.operator);
  ops = [...new Set(ops)].sort((a, b) => a.localeCompare(b, 'de'));
  sel.innerHTML = '<option value="all">Alle Anbieter vor Ort</option>' + ops.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
  state.operator = ops.includes(prev) ? prev : 'all'; sel.value = state.operator;
}
function bind() {
  $('#sel-scope').addEventListener('change', async (e) => { state.scope = e.target.value; state.live = null; state.supply = null; if (state.mode === 'live') state.mode = 'collector', $('#sel-mode').value = 'collector'; populateOperators(); if (state.scope !== 'DE') loadBoundaries().then(() => renderMap()); renderAll(); if (state.scope !== 'DE' && state.latest) liveFetch(); });
  $('#sel-operator').addEventListener('change', (e) => { state.operator = e.target.value; renderAll(); });
  $('#sel-type').addEventListener('change', (e) => { state.type = e.target.value; renderAll(); });
  $('#sel-mode').addEventListener('change', (e) => { state.mode = e.target.value; if (state.mode === 'live' && !state.live) liveFetch(); else renderAll(); });
  $('#btn-live').addEventListener('click', () => liveFetch());
  $('#btn-fit').addEventListener('click', () => fitMap(true));
  ['chk-vehicles', 'chk-stations', 'chk-muni', 'sel-layer'].forEach(id => $(`#${id}`).addEventListener('change', () => renderMap()));
  $('#chk-wfs').addEventListener('change', (e) => e.target.checked ? loadWfs() : (state.layers.wfs.clearLayers(), clearNotice('wfs')));
  $('#chk-zones').addEventListener('change', () => renderZonesLayer());
  $('#chk-weather').addEventListener('change', () => renderUsage());
  ['econ-min', 'econ-real', 'econ-net'].forEach(id => $(`#${id}`).addEventListener('change', () => renderEcon(state.usage.day)));
  $('#usage-days').addEventListener('click', (e) => { const b = e.target.closest('[data-uday]'); if (!b) return; state.usage.day = b.dataset.uday; renderUsage(); });
  $('#btn-flow-map').addEventListener('click', () => { $('#sel-layer').value = 'flow'; location.hash = '#live'; renderMap(); window.scrollTo({ top: 0 }); });
  document.addEventListener('click', (e) => { const a = e.target.closest('.pick-cell'); if (!a) return; e.preventDefault(); $('#sel-layer').value = 'flow'; location.hash = '#live'; renderMap(); setTimeout(() => state.map.setView([+a.dataset.lat, +a.dataset.lon], 16), 300); });
  $('#in-charge').addEventListener('change', (e) => { state.thresholds.charge = +e.target.value || 20; if (state.live) recomputeLive(); renderAll(); });
  $('#in-range').addEventListener('change', (e) => { state.thresholds.range = +e.target.value || 5; if (state.live) recomputeLive(); renderAll(); });
  $('#hist-days').addEventListener('click', (e) => { const b = e.target.closest('[data-day]'); if (!b) return; state.histDay = b.dataset.day; renderHistory(); renderStability(); });
  $('#sig-filter').addEventListener('click', (e) => { const b = e.target.closest('[data-cat]'); if (!b) return; sigFilter = b.dataset.cat; renderSignals(); });
  $('#cov-search').addEventListener('input', renderCoverage); $('#cov-dir').addEventListener('change', renderCoverage);
  $('#src-search').addEventListener('input', renderSourceTable); $('#src-status').addEventListener('change', renderSourceTable);
  $('#btn-supply').addEventListener('click', checkSupply);
  $('#btn-supply-map').addEventListener('click', () => { renderSupplyLayer(); location.hash = '#live'; });
  $('#btn-csv').addEventListener('click', exportCsv);
  $('#btn-theme').addEventListener('click', () => { const cur = document.documentElement.dataset.theme; const next = cur === 'light' ? 'dark' : cur === 'dark' ? '' : 'light'; if (next) document.documentElement.dataset.theme = next; else delete document.documentElement.dataset.theme; try { localStorage.setItem('mp-theme', next); } catch {} });
  document.addEventListener('click', (e) => { const a = e.target.closest('.pick-muni'); if (!a) return; e.preventDefault(); $('#sel-scope').value = a.dataset.ags; $('#sel-scope').dispatchEvent(new Event('change')); location.hash = '#live'; window.scrollTo({ top: 0 }); });
  window.addEventListener('hashchange', () => setView(location.hash.slice(1)));
}
function recomputeLive() { if (!state.live) return; state.live.groups = C.aggregateGroups(state.live.vehicles, state.live.stations, { chargeThreshold: state.thresholds.charge, rangeThreshold: state.thresholds.range }); }
function exportCsv() {
  const rows = operatorRows(); const head = ['Anbieter', 'Gebiet', 'Verfuegbar', 'Gemeldet', 'Gesperrt', 'Reserviert', 'EnergieNiedrig', 'MitEnergieangabe', 'Stationen', 'LeereStationen', 'Status', 'Datenalter_min', 'Quellen', 'Lizenz'];
  const lines = rows.map(r => [r.op, scopeLabel(), r.st.available, r.st.total, r.st.disabled, r.st.reserved, r.st.lowBattery, r.st.batteryKnown, r.st.stations, r.st.stationsEmpty, STATUS[r.status] || r.status, r.age == null ? '' : Math.round(r.age / 60e3), r.dirs.map(d => DIRS[d] || d).join('|'), r.license || ''].map(v => `"${String(v).replace(/"/g, '""')}"`).join(';'));
  const blob = new Blob(['﻿' + [head.join(';'), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `mobility-pulse_${state.scope}_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function init() {
  try { const t = localStorage.getItem('mp-theme'); if (t) document.documentElement.dataset.theme = t; } catch {}
  initMap(); bind();
  initOps({ state, CFG, getJson, esc, fmt, opColor, muniName, notice, clearNotice, loadBoundaries, loadUsageIndex, loadCells, loadOnce, TYPE, econFor });
  setView(location.hash.slice(1) || 'live');
  await loadBase();
  populateScope(); populateOperators();
  renderAll();
  if (state.latest) loadBoundaries().then(() => renderMap());
  setInterval(async () => { const s = await getJson(CFG.DATA + 'status.json'); if (s.ok && s.json.at !== state.status?.at) { const l = await getJson(CFG.DATA + 'latest.json'); if (l.ok) { state.status = s.json; state.latest = l.json; state.hist = {}; populateScope(); populateOperators(); renderAll(); } } }, 5 * 60e3);
}
init();
