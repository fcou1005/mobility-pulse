// Sammler, Phase „auswertung“ (S3.9: aus scripts/collect.mjs geschnitten; Ablauf und Zeitmessung in scripts/collect.mjs).
// ctx trägt, was Phasen voneinander brauchen; let-Werte stehen nur in ctx, Konstanten und Funktionen werden hier ausgepackt.
import * as C from '../../lib/pulse-core.js';
import * as T from '../../lib/pulse-track.js';
import * as OPS from '../../lib/pulse-ops.js';

export async function run(ctx) {
  const { corsByUrl, manual, now, prev, prevSources, results, vkey } = ctx;
  // ---------- Auswertung ----------
  ctx.allVehicles = []; ctx.allStations = []; ctx.snapshots = [];
  const sourceOut = [];
  ctx.sourceOut = sourceOut;
  const ghostKeys = []; // verwaiste Einträge: aus dem Verfolgungszustand entfernen, ohne Ereignis
  ctx.ghostKeys = ghostKeys;
  const munis = new Map(); // ags → {name,state,pop,bbox}
  ctx.munis = munis;
  const muniInfo = new Map(); // ags → Eigenschaften aller zugeordneten Gemeinden (zum Neuaufbau nach der Quellen-Dublettenprüfung)
  ctx.muniInfo = muniInfo;
  const centroids = new Map(ctx.boundaries ? ctx.boundaries.features.map(f => [f.properties.ags, C.geomCentroid(f.geometry)]) : []);
  ctx.centroids = centroids;
  const areas = new Map(ctx.boundaries ? ctx.boundaries.features.map(f => [f.properties.ags, C.geomAreaKm2(f.geometry)]) : []); // km² (vereinfachte Grenzen, ca. ±1 %)
  ctx.areas = areas;
  const typeOrder = C.VEHICLE_TYPES;
  const chargeThreshold = 20, rangeThreshold = 5;
  ctx.chargeThreshold = chargeThreshold; ctx.rangeThreshold = rangeThreshold;
  const operatorBySystem = Object.fromEntries(Object.entries(manual.operator_by_system || {}).filter(([k]) => !k.startsWith('_')));
  // eigener Befund der Verfolgung in der Feed-Prüfung (sources[].checks wie C.checkGbfs: Fehler zuerst, höchstens 5 Befunde; Quellen ohne Prüfung bekommen eine)
  const addCheck = (rec, msg, n = null) => {
    const c = (rec.checks ??= { label: C.CHECKS_LABEL, errors: 0, warnings: 0, items: [] }); const items = c.items || [];
    const k = items.findIndex(x => x.level !== 'error'); items.splice(k < 0 ? items.length : k, 0, { level: 'warning', feed: (rec.feeds || []).includes('vehicle_status') ? 'vehicle_status' : 'free_bike_status', msg, ...(n != null ? { n } : {}) });
    c.items = items.slice(0, 5); c.warnings = (c.warnings || 0) + 1;
  };
  ctx.addCheck = addCheck;
  for (const { src, sys, probe, error, reuse } of results) {
    if (reuse) { sourceOut.push({ ...reuse, checkedAt: now, reused: true }); continue; }
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
    if (sys.viaAlt) { rec.url = sys.viaAlt.url; rec.primaryUrl = sys.viaAlt.from; rec.viaAlt = true; addCheck(rec, `Hauptfeed ohne Fahrzeuge (${new URL(sys.viaAlt.from).host}${sys.viaAlt.httpStatus !== 200 ? `, HTTP ${sys.viaAlt.httpStatus}` : ''}) – Ersatzfeed gezählt`); }
    if (sys.cbCachedAt != null) { rec.cbCachedAt = sys.cbCachedAt; addCheck(rec, `CityBikes ${sys.cbFailStatus ? `HTTP ${sys.cbFailStatus}` : 'nicht erreichbar'} – Stand des letzten guten Abrufs (${Math.round((now - sys.cbCachedAt) / 60e3)} Min. alt) verwendet`); }
    if (sys.merged) { rec.merged = sys.merged; addCheck(rec, `${sys.merged.added} Fahrzeuge nur im Ersatzfeed (${new URL(sys.merged.url).host}) – dazugezählt`, sys.merged.added); }
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
      const m = ctx.index ? C.assignMunicipality(ctx.index, v.lat, v.lon) : null;
      if (!m) { counts.unassigned++; continue; }
      counts.assigned++; agsSet.add(m.ags);
      if (!muniInfo.has(m.ags)) muniInfo.set(m.ags, { ags: m.ags, name: m.name, state: m.state, pop: m.pop });
      if (usable) ctx.allVehicles.push({ ...v, operator: src.operator, sourceId: src.id, priority: src.priority ?? 2, ags: m.ags, feedAgeMs: rec.vehicleFeedAgeMs });
    }
    for (const s of sys.stations) {
      if (!C.validLatLon(s.lat, s.lon)) continue;
      const m = ctx.index ? C.assignMunicipality(ctx.index, s.lat, s.lon) : null;
      if (!m) continue;
      agsSet.add(m.ags);
      if (!muniInfo.has(m.ags)) muniInfo.set(m.ags, { ags: m.ags, name: m.name, state: m.state, pop: m.pop });
      if (usable) ctx.allStations.push({ ...s, operator: src.operator, sourceId: src.id, priority: src.priority ?? 2, ags: m.ags, hasVehicleList: !!sys.vehicleListPresent, feedAgeMs: rec.stationFeedAgeMs });
    }
    rec.counts = counts; rec.municipalities = [...agsSet]; rec.countOnly = !sys.vehicleListPresent; // Stationen zählen Fahrzeuge (keine Fahrzeugliste)
    if (usable && !agsSet.size && (counts.outside || counts.unassigned)) rec.status = 'foreign';
    sourceOut.push(rec);

    // Momentaufnahme für Quellen, die der Browser nicht direkt lesen kann (Zugangsdaten), nur aktuelle/verzögerte
    const corsOk = (() => { const h = corsByUrl.get(src.url); return h === '*' || (h && h.length > 0); })();
    rec.cors = corsOk;
    if ((src.auth || !corsOk) && usable) {
      ctx.snapshots.push({ id: src.id, at: now, feedAgeMs: rec.feedAgeMs, operator: src.operator,
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
}
