// Dashboard: Karte und Karten-Ebenen (S3.9: aus web/app.js geschnitten, Einstieg bleibt web/app.js).
import * as C from './pulse-core.js';
import * as R from './pulse-report.js';
import { mapKeys } from './mapkeys.js';
import { t, lang } from './i18n.js';
import { idleClassText } from './pulse-idle.js';
import { $, CFG, DISABLED_COL, TYPE, ageText, bgColor, cl, esc, fmt, isClient, isDark, opColor, state, timeText, tok } from './app-core.js';
import { boundariesReq, cached, clearNotice, getJson, hasCenters, loadBoundaries, notice } from './app-load.js';
import { scopeGroups, scopeLabel } from './app-scope.js';
import { currentView, dirty } from './app-router.js';
import { rangeOnly } from './app-energy.js';
import { renderSupplyLayer } from './app-sources.js';
import { groupInScope, loadCells, loadOnce, loadUsageIndex, scopeState } from './app-usage.js';
import { CELL_LAT, CELL_LON, cellCenterOf, cellsForScope } from './app-calib.js';

// ---------- Karte ----------
export const REDUCED = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export function initMap() {
  const map = L.map('map', { preferCanvas: true, zoomControl: true, zoomAnimation: !REDUCED(), fadeAnimation: !REDUCED(), markerZoomAnimation: !REDUCED() }).setView([51.1, 10.4], 6);
  state.tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: t('app.openstreetmapContributors') }).addTo(map);
  state.map = map; mapKeys(map); // Tastatur: N/P durch die Objekte im Ausschnitt, Enter wie Klick (web/mapkeys.js)
  state.layers = { vehicles: L.layerGroup().addTo(map), stations: L.layerGroup().addTo(map), muni: L.layerGroup().addTo(map), wfs: L.layerGroup().addTo(map), supply: L.layerGroup().addTo(map), bubbles: L.layerGroup().addTo(map), grid: L.layerGroup().addTo(map), zones: L.layerGroup().addTo(map) };
  map.on('moveend', () => { if ($('#chk-wfs').checked) loadWfs(); });
}
export function livePoints() {
  if (!state.live) return { vehicles: [], stations: [] };
  const f = (x) => (state.scope === 'DE' || x.ags === state.scope) && (state.operator === 'all' || x.operator === state.operator);
  return { vehicles: state.live.vehicles.filter(v => f(v) && (state.type === 'all' || v.type === state.type)), stations: state.live.stations.filter(f) };
}
// Fahrzeugpositionen aus dem Sammler-Stand (ops/<Land>.json, 1–6 MB je Land, einmal je Datenstand): bei gewählter Gemeinde statt der einen Blase.
// Rückgabe null, solange die Datei noch lädt (die Karte zeichnet sich danach neu) oder wenn sie fehlt.
state.fleet = new Map();
export function decodeFleetDoc(doc) {
  const at = doc?.at ?? null, pos = Date.now() - (at || Date.now());
  // Felder 10–13 wie lib/pulse-ops.js decodeFleet: reichweiteAbgeleitet, reichweiteSchwelleKm, reichweiteKonstant, standzeitMindestens (fehlend am Zeilenende = null)
  const vehicles = (doc?.vehicles || []).map(([lat, lon, op, ty, flags, bat, range, idle, m, rd, rl, rf, ic]) => ({ lat, lon, operator: doc.ops?.[op], type: doc.types?.[ty] ?? 'unknown', reserved: !!(flags & 1), disabled: !!(flags & 2), batteryPct: bat ?? null, rangeKm: range ?? null, idleMin: idle, idleCensored: ic === 1, ags: doc.munis?.[m], positionAgeMs: pos, geoOrigin: 'vehicle', rangeDerived: rd === 1, rangeLimitKm: Number.isFinite(rl) ? rl : null, rangeFlat: rf === 1 })).filter(v => C.validLatLon(v.lat, v.lon));
  const stations = (doc?.stations || []).map(([lat, lon, op, name, bookable, docks, capacity, m, renting, returning, physical]) => ({ lat, lon, operator: doc.ops?.[op], name, bookable, docksAvailable: docks, capacity, ags: doc.munis?.[m], renting: !!renting, returning: !!returning, physicalAvailable: physical })).filter(s => C.validLatLon(s.lat, s.lon));
  return { at, vehicles, stations };
}
export function collectorPoints() {
  if (state.scope === 'DE' || !state.latest) return null;
  const stCode = scopeState(); if (!stCode) return null;
  if (!state.fleet.has(stCode)) {
    state.fleet.set(stCode, 'loading');
    cached(`ops/${stCode}.json`, 90000).then(r => { const d = r.ok ? decodeFleetDoc(r.json) : null; state.fleet.set(stCode, d); if (d && !state.live?.vehicles.some(v => v.ags === state.scope) && scopeState() === stCode) renderMap(); });
    return null;
  }
  const doc = state.fleet.get(stCode); if (!doc || doc === 'loading') return null;
  const f = (x) => x.ags === state.scope && (state.operator === 'all' || x.operator === state.operator);
  return { at: doc.at, vehicles: doc.vehicles.filter(v => f(v) && (state.type === 'all' || v.type === state.type)), stations: doc.stations.filter(f) };
}
export function renderMap() {
  if (!state.map) return;
  if (currentView !== 'live') { dirty.add('live'); return; } // verdeckte Karte nicht zeichnen (Größe 0); beim Öffnen der Übersicht nachziehen
  const L_ = state.layers; Object.values(L_).forEach(l => l.clearLayers());
  const layerMode = $('#sel-layer').value;
  const bg = bgColor(); // Punktrand in der Hintergrundfarbe
  if (['flow', 'served', 'idle'].includes(layerMode)) {
    $('#map-title').textContent = t('app.map', { v0: scopeLabel() });
    $('#map-sub').textContent = layerMode === 'flow' ? t('app.tripStartsAndEndsPerCell') : layerMode === 'served' ? t('app.cellsWithAvailableVehicle') : t('app.availableVehiclesThatHaveNot');
    renderMuniLayer();
    fitMap(); renderZonesLayer();
    (layerMode === 'flow' ? renderFlowLayer : layerMode === 'served' ? renderServedLayer : renderIdleLayer)();
    renderOpLegend([]);
    return;
  }
  clearNotice('flow');
  const live = state.live ? livePoints() : null;
  const coll = !(live && (live.vehicles.length || live.stations.length)) ? collectorPoints() : null; // Live-Abruf ohne Positionen (kein CORS, keine Momentaufnahme): Sammler-Positionen
  const src = live && (live.vehicles.length || live.stations.length) ? live : coll && (coll.vehicles.length || coll.stations.length) ? coll : null;
  const { vehicles, stations } = src || { vehicles: [], stations: [] };
  const legend = [];
  const inScope = state.scope !== 'DE';
  if (src) {
    $('#map-title').textContent = t('app.map', { v0: scopeLabel() });
    const step = Math.max(1, Math.ceil(vehicles.length / CFG.MAX_POINTS));
    let drawn = 0;
    if (layerMode === 'points') {
      if ($('#chk-vehicles').checked) for (let i = 0; i < vehicles.length; i += step) {
        const v = vehicles[i]; drawn++;
        const col = v.disabled ? DISABLED_COL : opColor(v.operator), dim = state.mapFocus && state.mapFocus !== v.operator; // Legende: ein Anbieter hervorgehoben
        L.circleMarker([v.lat, v.lon], { radius: 4.5, weight: 2, color: bg, fillColor: col, fillOpacity: dim ? .12 : v.disabled ? .7 : .95, opacity: dim ? .2 : 1 })
          .bindPopup(`<b>${esc(v.operator)}</b> · ${esc(TYPE[v.type] || v.type)}<br>${v.disabled ? t('app.disabled3') : v.reserved ? t('common.reservedLc') : t('app.available')}${v.batteryPct != null ? ` · ${t('app.battery', { batteryPct: fmt(v.batteryPct) })}` : ''}${v.rangeKm != null ? ` · ${fmt(v.rangeKm, 1)} km` : ''}${v.idleMin != null ? ` · ${t(v.idleCensored ? 'trk.idleForAtLeast' : 'app.idleFor', { v0: idleClassText(v.idleMin, { en: lang() === 'en', atLeast: v.idleCensored }) })}` : ''}<br><span class="muted">${t('app.position', { v0: ageText(v.positionAgeMs), v1: isClient() ? '' : ` · ${v.geoOrigin === 'station' ? t('app.stationPositionAsFallback') : 'GPS'}${v.reusedId ? ` · ${t('app.idReused')}` : ''}${src === coll ? ` · ${t('app.collectorSnapshot')}` : ''}` })}</span>`).addTo(L_.vehicles);
      }
      if ($('#chk-stations').checked) for (const s of stations) {
        // gemeldet leer, aber Fahrzeuge desselben Anbieters ≤ 50 m daneben: faktisch versorgt. Leer = gestrichelter Rand ohne Füllung (Form statt
        // eigener Farbe: die Anbieterfarbe bleibt die Identität, die Warnfarbe kollidierte mit Dott)
        const near = s.nearbyVehicles || 0, empty = s.renting !== false && (s.bookable ?? 0) === 0 && !near, dim = state.mapFocus && state.mapFocus !== s.operator;
        L.rectangle([[s.lat - .00035, s.lon - .0005], [s.lat + .00035, s.lon + .0005]], { weight: 2, color: opColor(s.operator), opacity: dim ? .2 : 1, dashArray: empty ? '3 3' : null, fillOpacity: empty || dim ? 0 : .25 })
          .bindPopup(`${t('app.physicalBookableDocks', { v0: esc(s.name || t('app.station')), operator: esc(s.operator), physicalAvailable: fmt(s.physicalAvailable), bookable: fmt(s.bookable), docksAvailable: fmt(s.docksAvailable), v5: near ? t('app.withinM', { near: fmt(near), v1: near === 1 ? t('app.vehicle') : t('app.vehicles'), v2: C.STATION_NEAR_M ?? 50 }) : '', v6: s.nearbyOther ? `<br><span class="muted">${t('app.plusFromOtherOperators', { nearbyOther: fmt(s.nearbyOther), join: esc((s.nearbyOtherOps || []).join(', ')) })}</span>` : '' })}<span class="muted">${s.renting === false ? t('app.rentalDisabled') : t('app.renting')} · ${s.returning === false ? t('app.returnDisabled') : t('app.returnPossible')}</span>`).addTo(L_.stations);
      }
      // Anbieterfarben stehen einmal, nach Bestand sortiert, in #map-legend-ops (renderOpLegend); hier nur Zustände und Formen
      legend.push(`<span><i class="dot" style="background:${DISABLED_COL}"></i>${t('app.disabled3')}</span>`, `<span><i class="sq"></i>${t('app.station')}</span>`, `<span><i class="sq" style="border-style:dashed;background:transparent"></i>${t('app.stationEmptyNoVehicleM', { v0: C.STATION_NEAR_M ?? 50 })}</span>`, `<span class="muted">${t('app.vehiclesDrawn', { drawn: fmt(drawn), length: fmt(vehicles.length), v2: step > 1 ? ` ${t('app.thinnedOut')}` : '' })}</span>`);
    } else {
      // grobes Raster 0,0045° × 0,007° ≈ 500 × 500 m (Text: i18n FIXED.CELL500)
      const cells = new Map();
      // Energie niedrig wie überall (energyLow): Grenzen des Live-Abrufs bzw. des Sammlers, je nachdem woher die Positionen stammen
      const lim = src === coll ? { charge: state.latest?.thresholds?.chargeThreshold ?? R.ENERGY_CHARGE, range: state.latest?.thresholds?.rangeThreshold ?? R.ENERGY_RANGE_KM } : { charge: state.thresholds.charge, range: state.thresholds.range };
      for (const v of vehicles) { if (v.disabled) continue; const k = `${Math.round(v.lat / 0.0045)}:${Math.round(v.lon / 0.007)}`; const c = cells.get(k) || { lat: Math.round(v.lat / 0.0045) * 0.0045, lon: Math.round(v.lon / 0.007) * 0.007, n: 0, low: 0, known: 0 }; c.n++; const lw = R.energyLow(v.batteryPct, v.rangeKm, { ...lim, rangeOnly: rangeOnly(v.operator) || !!v.batteryDerived, rangeDerived: !!v.rangeDerived, rangeLimit: v.rangeLimitKm ?? null, rangeFlat: !!v.rangeFlat, type: v.type }); if (lw != null) { c.known++; if (lw) c.low++; } cells.set(k, c); }
      const max = Math.max(1, ...[...cells.values()].map(c => layerMode === 'energy' ? c.low : c.n));
      for (const c of cells.values()) {
        const val = layerMode === 'energy' ? c.low : c.n; if (!val) continue;
        const a = 0.15 + 0.7 * (val / max);
        L.rectangle([[c.lat - .00225, c.lon - .0035], [c.lat + .00225, c.lon + .0035]], { weight: 0, fillColor: layerMode === 'energy' ? tok('--warn') : tok('--accent'), fillOpacity: a })
          .bindPopup(layerMode === 'energy' ? t('app.vehiclesWithLowEnergyCharge', { low: fmt(c.low), charge: fmt(lim.charge), range: fmt(lim.range), known: fmt(c.known) }) : t('app.availableVehiclesInThisCell', { n: fmt(c.n) })).addTo(L_.grid);
      }
      legend.push(`<span>${t('app.perDarkerMoreMax', { v0: layerMode === 'energy' ? t('app.lowEnergyChargeAndRangeKm', { charge: fmt(lim.charge), range: fmt(lim.range) }) : t('app.availableVehicles'), v1: cl(t('app.cellCoarse'), t('app.areaOfAbout500500M')), max: fmt(max) })}</span>`);
    }
    if (src === coll) legend.push(`<span class="muted">${cl(t('app.collectorSnapshotFetchLive', { v0: timeText(coll.at) }), t('app.asOf3', { v0: timeText(coll.at) }))}</span>`);
  } else {
    // Sammler-Stand ohne Positionen: Gemeinde-Blasen (Mittelpunkte aus latest.json, sonst aus den Grenzen)
    $('#map-title').textContent = state.scope === 'DE' ? t('app.mapOfGermany') : t('app.map', { v0: scopeLabel() });
    const munis = state.latest?.municipalities || {};
    const groups = scopeGroups();
    const perMuni = new Map();
    for (const [k, st] of groups) { const [ags, op] = k.split('|'); const m = perMuni.get(ags) || { ags, available: 0, total: 0, ops: {} }; m.available += st.available; m.total += st.total; m.ops[op] = (m.ops[op] || 0) + st.available; perMuni.set(ags, m); }
    const centers = muniCenters();
    if (!centers.size && perMuni.size && !hasCenters() && !boundariesReq) loadBoundaries().then(() => renderMap()); // alter Datenstand ohne Mittelpunkte
    const max = Math.max(1, ...[...perMuni.values()].map(m => m.available));
    for (const m of perMuni.values()) {
      const c = centers.get(m.ags); if (!c) continue;
      const top = Object.entries(m.ops).sort((a, b) => b[1] - a[1])[0]?.[0];
      L.circleMarker(c, { radius: 4 + Math.sqrt(m.available / max) * 26, weight: 1.5, color: bg, fillColor: opColor(top), fillOpacity: .5 })
        .bindPopup(`${t('app.availableReported', { v0: esc(munis[m.ags]?.name || m.ags), v1: esc(munis[m.ags]?.state || ''), available: fmt(m.available), total: fmt(m.total), v4: Object.entries(m.ops).sort((a, b) => b[1] - a[1]).map(([o, n]) => `${esc(o)} ${fmt(n)}`).join(' · ') })}<a href="#live" data-ags="${esc(m.ags)}" class="pick-muni">${t('app.openPlace')}</a>`).addTo(L_.bubbles);
    }
    const loading = state.scope !== 'DE' && state.fleet.get(scopeState()) === 'loading';
    legend.push(`<span>${t('app.bubbleAvailableVehiclesPer', { v0: cl(t('app.collectorSnapshot'), t('app.asOf2')), v1: timeText(state.latest?.at) })}</span>`, `<span class="muted">${loading ? t('app.loadingVehiclePositions') : state.scope === 'DE' ? t('app.chooseMunicipalityForVehicle') : cl(t('app.fetchLiveForVehiclePositions'), '')}</span>`);
  }
  renderMuniLayer();
  $('#map-legend').innerHTML = legend.join('');
  renderOpLegend(vehicles);
  $('#map-sub').textContent = src ? t('app.vehiclesStations', { length: fmt(vehicles.length), length2: fmt(stations.length), v2: src === live ? `Live ${timeText(state.live.at)}` : `${cl(t('app.collectorSnapshot'), t('app.asOf2'))} ${timeText(coll.at)}` }) : t('app.vehiclesAndStations');
  fitMap();
  if ($('#chk-wfs').checked) loadWfs();
  renderZonesLayer();
  if (state.supply && $('#chk-supply-on')) renderSupplyLayer();
}
// Gemeindegrenze nur auf Wunsch (lädt die 2,5-MB-Datei erst dann)
export function renderMuniLayer() {
  const L_ = state.layers; L_.muni.clearLayers();
  if (!$('#chk-muni').checked || state.scope === 'DE') return;
  const f = state.boundaries?.features.find(x => x.properties.ags === state.scope);
  if (!f) { const sc = state.scope; if (!renderMuniLayer.tried?.has(sc)) { (renderMuniLayer.tried ??= new Set()).add(sc); loadBoundaries().then(b => { if (b && $('#chk-muni').checked && state.scope === sc) renderMuniLayer(); }); } return; }
  if (f) L.geoJSON(f, { style: { color: tok('--info'), weight: 1.5, fillOpacity: .04 } }).addTo(L_.muni);
}
// Mittelpunkte: aus latest.json (municipalities[].c, Vertrag 1), sonst aus den Grenzen
export function muniCenters() {
  const out = new Map();
  for (const [ags, m] of Object.entries(state.latest?.municipalities || {})) if (Array.isArray(m.c) && C.validLatLon(m.c[0], m.c[1])) out.set(ags, [m.c[0], m.c[1]]);
  if (state.boundaries) for (const f of state.boundaries.features) if (!out.has(f.properties.ags)) { const b = f.bbox; out.set(f.properties.ags, [(b[1] + b[3]) / 2, (b[0] + b[2]) / 2]); }
  return out;
}
export let lastFitKey = null;
// Einpassen: Gemeindegrenze, sonst Fahrzeugpunkte (Live oder Sammler), sonst Mittelpunkt; Grundlage steckt im Schlüssel, damit ein späterer Nachlader neu einpasst
export function fitMap(force = false) {
  const map = state.map;
  let basis = 'n', bounds = null, center = null;
  if (state.scope !== 'DE') {
    const f = state.boundaries?.features.find(x => x.properties.ags === state.scope);
    const lp = state.live ? livePoints() : null;
    const pts = (lp?.vehicles.length ? lp : collectorPoints())?.vehicles || [];
    if (f) { const b = f.bbox; basis = 'b'; bounds = [[b[1], b[0]], [b[3], b[2]]]; }
    else if (pts.length) { basis = 'p'; bounds = L.latLngBounds(pts.slice(0, 2000).map(v => [v.lat, v.lon])); }
    else { const c = muniCenters().get(state.scope); if (c) { basis = 'c'; center = c; } }
  }
  const key = `${state.scope}|${state.mode}|${state.operator}|${basis}`;
  if (!force && key === lastFitKey) return; lastFitKey = key;
  if (bounds) map.fitBounds(bounds, { padding: [10, 10] });
  else if (center) map.setView(center, 12);
  else map.setView([51.1, 10.4], 6);
}
export async function loadWfs() {
  const L_ = state.layers; L_.wfs.clearLayers();
  const map = state.map; if (map.getZoom() < 11) { notice(() => t('app.mobidataMapLoadsFromCityZoom'), '', 'wfs'); return; }
  const b = map.getBounds();
  const url = `${CFG.WFS}?service=WFS&version=2.0.0&request=GetFeature&typeName=MobiData-BW:sharing_vehicles&outputFormat=application/json&srsName=EPSG:4326&count=4000&bbox=${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()},EPSG:4326`;
  const r = await getJson(url, { timeout: 30000 });
  if (!r.ok || !r.json?.features) { notice(() => t('app.mobidataMapSourceNot', { v0: r.error || r.status }), 'warn', 'wfs'); return; }
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
    L.circleMarker([lat, lon], { radius: 3, weight: 1, color: cls === 'fresh' ? tok('--accent') : cls === 'old' ? DISABLED_COL : tok('--warn'), fillOpacity: .7 })
      .bindPopup(`${t('app.mobidataMap', { v0: esc(p.provider_name || p.operator || p.system_id || ''), v1: esc(p.form_factor || p.vehicle_type || '') })}<span class="muted">${age == null ? t('app.freshnessUnclear') : t('app.reported2', { age: ageText(age) })}</span>`).addTo(L_.wfs);
  }
  notice(() => t('app.mobidataMapPointsInView', { n: fmt(n), fresh, unk, old, v4: r.json.features.length >= 4000 ? t('app.responseCapped') : '' }), '', 'wfs');
}

// ---------- Karten-Ebenen: Start/Ziel, bediente Zellen, lange Standzeiten, Betriebszonen ----------
export async function renderFlowLayer() {
  const L_ = state.layers; L_.grid.clearLayers();
  const idx = await loadUsageIndex(); const day = state.usage.day || idx.days?.slice(-1)[0]; if (!day) { notice(() => t('app.noEventDataForStart'), '', 'flow'); return; }
  const cells = await cellsForScope(day); if (!cells) { notice(() => t('app.startDestinationLayerPlease'), '', 'flow'); return; }
  clearNotice('flow');
  const list = Object.entries(cells).map(([cell, v]) => ({ cell, start: v[0], end: v[1], net: v[1] - v[0], reloc: v[3] })).filter(r => r.start + r.end > 0);
  const max = Math.max(1, ...list.map(r => Math.abs(r.net)), ...list.map(r => r.start));
  const flowIn = tok('--info'), flowOut = tok('--bad'); // Farben aus den Themen-Tokens (hell/dunkel), divergierend Blau ↔ Rot
  for (const r of list) {
    const [lat, lon] = cellCenterOf(r.cell);
    const col = r.net > 0 ? flowIn : r.net < 0 ? flowOut : DISABLED_COL;
    L.rectangle([[lat - CELL_LAT / 2, lon - CELL_LON / 2], [lat + CELL_LAT / 2, lon + CELL_LON / 2]], { weight: 0, fillColor: col, fillOpacity: 0.15 + 0.65 * (Math.max(Math.abs(r.net), r.start * 0.5) / max) })
      .bindPopup(t('app.cellTripStartsTripEndsNet', { start: fmt(r.start), end: fmt(r.end), v2: r.net > 0 ? '+' : '', net: fmt(r.net), reloc: fmt(r.reloc) })).addTo(L_.grid);
  }
  $('#map-legend').innerHTML = `<span><i class="dot" style="background:var(--bad)"></i>${t('app.netOutflowMoreStarts')}</span><span><i class="dot" style="background:var(--info)"></i>${t('app.netInflowMoreDestinations')}</span><span class="muted">${t('app.cellsWithMovement', { v0: day.split('-').reverse().join('.'), length: fmt(list.length) })}</span>`;
}
export async function renderServedLayer() {
  const L_ = state.layers; L_.grid.clearLayers();
  const idx = await loadUsageIndex(); const st = scopeState();
  if (state.scope === 'DE' || !st) { notice(() => t('app.servedCellsPleaseChoose'), '', 'flow'); return; }
  const days = (idx.cellDays || []).slice(-7); if (!days.length) { notice(() => t('app.noCellDataYet'), '', 'flow'); return; }
  clearNotice('flow');
  const agg = new Map();
  for (const d of days) { const doc = await loadCells(d, st); const cells = doc?.munis?.[state.scope]; if (!cells) continue; for (const [cell, v] of Object.entries(cells)) { if (!v[2]) continue; const a = agg.get(cell) || { present: 0, days: 0 }; a.present += v[2]; a.days++; agg.set(cell, a); } }
  const maxP = Math.max(1, ...[...agg.values()].map(a => a.present));
  for (const [cell, a] of agg) { const [lat, lon] = cellCenterOf(cell); L.rectangle([[lat - CELL_LAT / 2, lon - CELL_LON / 2], [lat + CELL_LAT / 2, lon + CELL_LON / 2]], { weight: 0, fillColor: tok('--accent'), fillOpacity: 0.12 + 0.6 * (a.present / maxP) }).bindPopup(t('app.servedOnOfDaysVehicle', { days: a.days, length: days.length, present: fmt(a.present) })).addTo(L_.grid); }
  $('#map-legend').innerHTML = `<span><i class="dot" style="background:var(--accent)"></i>${t('app.cellWithAvailableVehicleIn', { length: days.length })}</span><span class="muted">${t('app.cellsKm2', { size: fmt(agg.size), v1: fmt(agg.size * 0.07, 1) })}</span>`;
}
export async function renderIdleLayer() {
  const L_ = state.layers; L_.grid.clearLayers();
  const d = await loadOnce('idleLong', 'idle-long.json'); if (!d) return;
  const pts = d.points.filter(p => (state.scope === 'DE' || p.ags === state.scope) && (state.operator === 'all' || p.op === state.operator) && (state.type === 'all' || p.ty === state.type));
  for (const p of pts) L.circleMarker([p.lat, p.lon], { radius: 5, weight: 2, color: bgColor(), fillColor: tok('--warn'), fillOpacity: .85 }).bindPopup(t('app.idleForH', { op: esc(p.op), v1: esc(TYPE[p.ty] || p.ty), hours: idleClassText(p.hours * 60, { en: lang() === 'en', atLeast: !!p.censored }), v3: (p.bat != null ? ` · ${t('app.battery2', { bat: fmt(p.bat) })}` : '') + (p.censored ? ` · ${t('trk.sinceTrackStart')}` : '') })).addTo(L_.grid);
  $('#map-legend').innerHTML = `<span><i class="dot" style="background:var(--warn)"></i>${t('app.availableButNotMovedForMore')}</span><span class="muted">${t('app.shownAsOf', { length: fmt(pts.length), v1: d.total > d.points.length ? ` ${t('app.thinnedOutPerMunicipality', { total: fmt(d.total) })}` : '', v2: timeText(d.at) })}</span>`;
}
// Welche Farbe gehört zu welchem Anbieter: immer unter der Karte, sortiert nach verfügbaren Fahrzeugen im Gebiet
export function renderOpLegend(vehicles) {
  const n = new Map();
  if (vehicles?.length) for (const v of vehicles) { if (!v.disabled) n.set(v.operator, (n.get(v.operator) || 0) + 1); }
  if (!n.size) for (const [k, st] of Object.entries(state.latest?.groups || {})) { if (!groupInScope(k)) continue; const op = k.split('|')[1]; n.set(op, (n.get(op) || 0) + st.available); }
  const ops = [...n].sort((a, b) => b[1] - a[1]);
  if (state.mapFocus && !n.has(state.mapFocus)) state.mapFocus = null;
  // Einträge sind Knöpfe: ein Klick hebt den Anbieter auf der Karte hervor und blendet die übrigen ab (zweite Kodierung neben der Farbe)
  $('#map-legend-ops').innerHTML = ops.length ? `<span class="muted">${t('app.operator')}</span>${ops.slice(0, 14).map(([o, c]) => `<button type="button" class="leg-hl" data-map-hl="${esc(o)}" aria-pressed="${state.mapFocus === o}" title="${esc(t('cmp.highlightTip', { op: o }))}"><i class="dot" style="background:${opColor(o)}"></i>${esc(o)} <span class="muted mono">${fmt(c)}</span></button>`).join('')}${ops.length > 14 ? `<span class="muted">${t('app.more2', { v0: ops.length - 14 })}</span>` : ''}` : '';
}
export async function renderZonesLayer() {
  const L_ = state.layers; L_.zones.clearLayers();
  if (!$('#chk-zones').checked) { clearNotice('zones'); $('#map-legend-zones').innerHTML = ''; return; }
  const idx = await loadOnce('zonesIndex', 'zones/index.json'); if (!idx?.zones?.length) { notice(() => t('app.noOperatingZonesFoundInFeeds'), '', 'zones'); return; }
  let list = idx.zones.filter(z => (state.scope === 'DE' || (z.municipalities || []).includes(state.scope)) && (state.operator === 'all' || z.operator === state.operator));
  if (state.scope === 'DE') { notice(() => t('app.operatingZonesPleaseChoose'), '', 'zones'); return; }
  list = list.slice(0, 8);
  let n = 0;
  // Zonenarten aus den Themen-Tokens (hell ≥ 4,5:1 auf Weiß, dunkel die hellen Stufen); Tempolimit Violett je Thema
  const zc = { noRide: tok('--bad'), noEnd: tok('--warn'), mpz: tok('--info'), slow: isDark() ? '#c084fc' : '#7c3aed' };
  for (const z of list) {
    if (!(z.file in state.usage.zones)) { const r = await cached(`zones/${z.file}`, 60000); state.usage.zones[z.file] = r.json || null; }
    const fc = state.usage.zones[z.file]; if (!fc) continue;
    const b = state.boundaries?.features.find(x => x.properties.ags === state.scope)?.bbox;
    const inB = (f) => { if (!b) return true; const c = JSON.stringify(f.geometry.coordinates).match(/-?\d+\.\d+/g); if (!c) return true; let minX = 999, maxX = -999, minY = 999, maxY = -999; for (let i = 0; i + 1 < c.length; i += 2) { const x = +c[i], y = +c[i + 1]; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; } return !(maxX < b[0] - .05 || minX > b[2] + .05 || maxY < b[1] - .05 || minY > b[3] + .05); };
    for (const f of fc.features.filter(inB)) {
      const ru = f.properties.rules || [];
      // GBFS 2.x: ride_allowed = Fahrt darf hier beginnen/enden; ride_through_allowed = Durchfahrt; station_parking = nur an Stationen abstellen
      const mpz = ru.some(r => r.parking === true), noRide = ru.some(r => r.rideThrough === false), noEnd = !mpz && ru.some(r => r.endAllowed === false || r.rideAllowed === false), slow = ru.find(r => r.maxSpeed != null)?.maxSpeed;
      const col = noRide ? zc.noRide : noEnd ? zc.noEnd : mpz ? zc.mpz : slow != null ? zc.slow : opColor(z.operator);
      L.geoJSON(f, { style: { color: opColor(z.operator), weight: 1.5, opacity: .9, fillColor: col, fillOpacity: noRide ? .16 : .1, dashArray: (noEnd || mpz) && !noRide ? '4 3' : null } })
        .bindPopup(`<b>${esc(z.operator)}</b> · ${esc(f.properties.name || t('app.zone'))}<br>${noRide ? t('app.ridingProhibited') : t('app.ridingAllowed')}${noEnd ? ` · ${t('app.parkingProhibited')}` : ''}${mpz ? ` · ${t('app.parkingOnlyAtStations')}` : ''}${slow != null ? ` · ${t('app.maxKmH', { slow: fmt(slow) })}` : ''}`).addTo(L_.zones);
      n++;
    }
  }
  clearNotice('zones');
  const zops = [...new Set(list.map(z => z.operator))];
  $('#map-legend-zones').innerHTML = `<span class="muted">${t('app.zones', { n: fmt(n) })}</span><span><i class="sq" style="background:color-mix(in srgb,${zc.noRide} 33%,transparent);border-color:${zc.noRide}"></i>${t('app.noRidingZone')}</span><span><i class="sq" style="background:color-mix(in srgb,${zc.noEnd} 20%,transparent);border-color:${zc.noEnd};border-style:dashed"></i>${t('app.noParkingZone')}</span><span><i class="sq" style="background:color-mix(in srgb,${zc.mpz} 20%,transparent);border-color:${zc.mpz};border-style:dashed"></i>${t('app.parkOnlyAtStations')}</span><span><i class="sq" style="background:color-mix(in srgb,${zc.slow} 20%,transparent);border-color:${zc.slow}"></i>${t('app.speedLimit')}</span><span class="muted">${t('app.outlineOperator')}</span>${zops.map(o => `<span><i class="sq" style="background:transparent;border-color:${opColor(o)}"></i>${esc(o)}</span>`).join('')}`;
}
