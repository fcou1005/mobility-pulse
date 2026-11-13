// Dashboard: Live-Abruf der Feeds im Browser (S3.9: aus web/app.js geschnitten, Einstieg bleibt web/app.js).
import * as C from './pulse-core.js';
import { t } from './i18n.js';
import { $, CFG, DEMO, STATUS, cl, esc, fmt, state } from './app-core.js';
import { clearNotice, ensureFullLatest, getJson, loadBoundaries, notice } from './app-load.js';
import { sourcesForScope } from './app-scope.js';
import { currentView, renderAll } from './app-router.js';
import { populateOperators } from './app.js';

// ---------- Live-Abruf ----------
// Automatischer Live-Abruf nach Gebietswahl/Deep-Link nur in der Übersicht (dort sind Positionen zu sehen); in anderen Ansichten erst beim
// Öffnen der Übersicht – spart Grenzen (2,4 MB) und Feed-Abrufe, wenn z. B. direkt „Nutzung“ geöffnet wird. „Live abrufen“ wirkt sofort.
export let pendingLive = false;
export const setPendingLive = (v) => { pendingLive = v; }; // S3.9: Setzen aus Router und Steuerung
// Momentaufnahme des Sammlers (snapshot/<id>.json) gibt es nur für Zugangsquellen und Quellen ohne CORS-Freigabe, die beim Lauf aktuell oder
// verzögert waren (scripts/collect.mjs); für alle anderen nicht anfragen (sonst 404 je ausgefallenem Feed)
export const snapshotOf = (r, auth = false) => (r && (auth || r.auth || r.cors !== true) && (r.status == null || ['live', 'delayed'].includes(r.status))
  ? getJson(CFG.DATA + `snapshot/${r.id.replace(/[^\w.-]+/g, '_')}.json`) : Promise.resolve({ ok: false, status: 0, json: null }));
export function autoLive() {
  if (DEMO || !state.latest || state.scope === 'DE') return;
  if (currentView === 'live') { pendingLive = false; liveFetch(); } else pendingLive = true;
}
export async function liveFetch() {
  if (DEMO) return; // Demo-Stand bleibt eingefroren
  if (state.latest?.lite && !(await ensureFullLatest())) return; // Live-Abgleich braucht die vollen Quellen (S3.8 Rest)
  const cat = state.catalog?.sources || [];
  const recs = sourcesForScope();
  const idSet = new Set(recs.map(r => r.id));
  // Katalogquellen für den Scope; ohne Sammler-Stand: alles (mit Fortschritt)
  let targets = cat.filter(s => !s.disabled && (state.scope === 'DE' && !state.latest ? true : idSet.has(s.id) || idSet.has(`${s.id}`) || recs.some(r => r.parent === s.id)));
  if (state.scope !== 'DE' && !targets.length) targets = cat.filter(s => !s.disabled);
  const btn = $('#btn-live'); btn.disabled = true;
  const n = notice(() => `${t('app.liveFetch')} <span class="mono" id="live-prog" aria-live="off">0 / ${targets.length}</span> ${t('app.sources')} <div class="progress"><i></i></div>`, '', 'live');
  await loadBoundaries();
  const systems = new Map(), recsOut = new Map();
  let done = 0; const now = Date.now();
  const worker = async (src) => {
    try {
      const subs = recs.filter(r => r.parent === src.id);
      if (src.auth || subs.length) {
        // Zugangsquellen (MOBIDROM): Momentaufnahme des Sammlers
        for (const r of subs.length ? subs : [src]) {
          const snap = await snapshotOf(r, true);
          if (snap.ok) { systems.set(r.id, snapshotToSystem(snap.json, r)); recsOut.set(r.id, summarizeSnapshot(src, r, snap.json, now)); }
          else recsOut.set(r.id, { ...r, status: 'collector', checkedAt: r.checkedAt });
        }
        return;
      }
      const known = recs.find(x => x.id === src.id);
      if (known?.cors === false) {
        // Sammler hat festgestellt: kein CORS-Header → gar nicht erst im Browser versuchen
        const snap = await snapshotOf(known);
        if (snap.ok) { systems.set(src.id, snapshotToSystem(snap.json, src)); recsOut.set(src.id, summarizeSnapshot(src, known, snap.json, now)); return; }
        if (['live', 'delayed'].includes(known.status)) { recsOut.set(src.id, { ...known, status: 'collector', corsBlocked: true }); return; }
      }
      if (known?.candidate && !['live', 'delayed', 'stale', 'unknown'].includes(known.status)) { recsOut.set(src.id, known); return; }
      const sys = src.api === 'citybikes' ? await C.readCityBikesNetwork(src, getJson, { now }) : await C.readGbfsSystem(src, getJson, { now });
      if (sys.httpStatus === 0 && !sys.vehicles.length && !sys.stations.length) {
        // Browser darf die Quelle nicht lesen (kein CORS): Momentaufnahme des Sammlers
        const r = recs.find(x => x.id === src.id);
        const snap = await snapshotOf(r || src);
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
      const ags = m?.ags || t('app.unknown'); agsSet.add(ags);
      vehicles.push({ ...v, operator: rec.operator, sourceId: id, priority: src.priority ?? 2, ags, feedAgeMs: rec.vehicleFeedAgeMs });
    }
    for (const s of sys.stations) {
      if (!C.validLatLon(s.lat, s.lon)) continue;
      const m = state.bIndex ? C.assignMunicipality(state.bIndex, s.lat, s.lon) : null;
      const ags = m?.ags || t('app.unknown'); agsSet.add(ags);
      stations.push({ ...s, operator: rec.operator, sourceId: id, priority: src.priority ?? 2, ags, hasVehicleList: !!sys.vehicleListPresent, feedAgeMs: rec.stationFeedAgeMs });
    }
    rec.municipalities = [...agsSet];
  }
  vehicles.sort((a, b) => a.priority - b.priority);
  const dv = C.dedupeVehicles(vehicles), ds = C.dedupeStations(stations);
  // Spiegelquellen mit umgeschlüsselten Kennungen (z. B. MOBIDROM ↔ nextbike direkt): wie der Sammler die schwächere Quelle verwerfen;
  // bekannte Paare aus latest.mirrors, Paare der Konsistenzprüfung, falls geladen
  if (typeof C.dropMirrorVehicles === 'function') {
    const recOf = new Map((state.latest?.sources || []).map(r => [r.id, r]));
    const rank = (id) => { const r = recOf.get(id) || recsOut.get(id) || {}; return [r.priority ?? 2, r.parent ? 1 : 0, (r.directories || []).includes('citybikes') ? 1 : 0]; };
    const mr = C.dropMirrorVehicles(dv.vehicles, { pairs: state.usage.consistency?.pairs || [], rank, extra: state.latest?.mirrors || [] });
    dv.vehicles = mr.vehicles; dv.stats.mirrorDropped = mr.dropped.length;
  }
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
  // Kundenansicht: ohne „Sammler“ und Quellenzustände, nur wie viele Anbieter gerade keine aktuellen Daten haben
  if (failed.length) notice(() => cl(t('app.ofSourcesDeliveredNoUsable', { length: failed.length, size: recsOut.size, join: esc([...new Set(failed.map(r => STATUS[r.status] || r.status))].join(', ')) }), t('app.someOperatorsNoCurrentData', { n: fmt(new Set(failed.map(r => r.operator)).size) })), 'warn', 'livefail'); else clearNotice('livefail');
  if (!state.bIndex) notice(() => t('app.withoutMunicipalBoundaries'), 'warn', 'nob');
  state.mode = 'live'; $('#sel-mode').value = 'live';
  populateOperators(); // Live-Gruppen können Anbieter/Arten ergänzen
  renderAll();
}
export function summarize(src, sys, now) {
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
export function summarizeSnapshot(src, rec, snap, now) {
  const age = (now - snap.at) + (snap.feedAgeMs || 0);
  return { ...(rec || {}), id: src.id, operator: rec?.operator || snap.operator || src.operator, name: src.name || rec?.name, api: src.api, url: src.url, directories: src.directories || rec?.directories || [], priority: src.priority ?? 2,
    status: C.freshness(age), feedAgeMs: age, vehicleFeedAgeMs: age, stationFeedAgeMs: age, snapshot: true, snapshotAt: snap.at, errors: [], httpStatus: rec?.httpStatus ?? null, quality: rec?.quality ?? null, fingerprint: rec?.fingerprint ?? null, license: rec?.license ?? null, checkedAt: snap.at, counts: { vehicles: (snap.vehicles || []).length, stations: (snap.stations || []).length } };
}
export function snapshotToSystem(snap, rec) {
  const vehicles = (snap.vehicles || []).map(([lat, lon, type, flags, battery, range], i) => ({ rawId: `${rec.id}#${i}`, lat, lon, type, reserved: !!(flags & 1), disabled: !!(flags & 2), batteryPct: battery, rangeKm: range, geoStatus: 'ok', geoOrigin: 'vehicle', reportedAt: snap.at, positionAgeMs: Date.now() - snap.at }));
  // Reichweite wie C.readGbfsSystem für Live-Feeds (C.applyRangeChecks): konstant → unbekannt (v.rangeFlat), aus dem Ladestand gerechnet → nur der
  // Ladestand (v.rangeDerived, M-16), kleine Skala → Schwelle der Quelle (v.rangeLimitKm); der Ladestand im Schnappschuss ist schon skalengeprüft
  C.applyRangeChecks?.(vehicles);
  return {
    vehicles,
    stations: (snap.stations || []).map(([lat, lon, name, phys, bookable, docks, renting, returning], i) => ({ id: `${rec.id}#s${i}`, name, lat, lon, physicalAvailable: phys, bookable, docksAvailable: docks, renting: !!renting, returning: !!returning, installed: true, reportedAt: snap.at, typeHint: 'unknown' })),
    vehicleListPresent: (snap.vehicles || []).length > 0, feedAges: {}, errors: [], systemInfo: {},
  };
}
