// Mobility Pulse — Disposition (Ansicht) – Plan rechnen und ausgeben (aus ops.js geschnitten; ops.js bleibt die Fassade für alle Importe).
import * as O from './pulse-ops.js';
import { t, lang, dateFmt, fmtLocale } from './i18n.js';
import { mbBadge, mbBase, stationName } from './ui-shared.js';
import { $, AHP_L, BAND_NOW, FL, IDLE_COL, RUN_COLOR, RUN_KINDS, RUN_LABEL, S, STAB, STOP_LABEL, X, abbr, allRuns, bandLabel, contextFor, ensureMap, hhmm, idleCls, idleHText, loadArea, loadCellDocs, loadFlowDocs, loadGroupDocs, loadNoPark, loadOpsDoc, num, officialData, overpassBackground, prioLambda, prioName, refCite, renderWarn, showPicker, sig2, status, tick, tok, urlDepot } from './ops-data.js';
import { GEO, GEO_TOP, GF0, collectFor, geoKey, groupView, groupsEmpty, osrmDown, queueGeo, renderCollect, renderGroups, routeRuns, violLegend, violToggle } from './ops-extra.js';
import { NEUTRAL } from './tokens.js';
import { setAnswer } from './answer.js';

// ---------- Plan ----------
export async function computePlan() {
  if (S.busy) { S.again = true; return; } S.busy = true;
  const st = X.state, ags = st.scope; S.pending = ags;
  // Nach jedem Entkoppeln prüfen: Gebiet gewechselt oder neuer Auftrag → abbrechen, finally startet den neuen Plan
  const stop = () => S.again || X.state.scope !== ags;
  try {
    ensureMap();
    if (ags === 'DE') { showPicker(); return; }
    const info = st.latest?.municipalities?.[ags]; const stCode = info?.state;
    if (!stCode) { status(t('ops.municipalityNotKnownIn')); emptyPlan(t('ops.municipalityNotKnownIn')); return; }
    status(t('ops.loadingFleetAndDemand'));
    S.input = null;
    const [fleetRes, cellDocs] = await Promise.all([loadOpsDoc(stCode, ags), loadCellDocs(stCode, +$('#ops-days').value || 7, ags)]);
    if (stop()) return;
    const fleet = fleetRes.fleet;
    if (!fleet) {
      const missingFile = fleetRes.status === 404;
      status(missingFile ? t('ops.noOperationsDataYetOpsJsonIt', { stCode: X.esc(stCode) })
        : `<span class="warn-text">${t('ops.fleetNotLoaded')}</span> ${t('ops.opsJson', { stCode: X.esc(stCode), v1: X.esc(fleetRes.error || `HTTP ${fleetRes.status}`) })} <button class="chip" id="ops-retry">${t('ops.tryAgain')}</button>`);
      emptyPlan(missingFile ? t('ops.noOperationsDataForThisState') : t('ops.fleetNotLoadedTryAgainAbove')); return;
    }
    const inMuni = fleet.vehicles.filter(v => v.ags === ags), stInMuni = fleet.stations.filter(s => s.ags === ags);
    // Anbieter mit Fahrzeugen der gewählten Art zuerst; Stationsanbieter nur bei Rädern
    const type = $('#ops-type').value;
    const typeOk = (tq) => type === 'all' || tq === type;
    const counts = new Map(); for (const v of inMuni) if (typeOk(v.type)) counts.set(v.operator, (counts.get(v.operator) || 0) + 1);
    if (type === 'all' || type === 'bike' || type === 'ebike') for (const s of stInMuni) if (!counts.has(s.operator)) counts.set(s.operator, 0);
    const ops = [...counts].sort((a, b) => b[1] - a[1]);
    if (!ops.length) { const why = t('ops.noInInLastCollectorRunChoose', { v0: type === 'all' ? t('ops.vehiclesOrStations') : X.esc(X.TYPE[type] || type), muniName: X.esc(X.muniName(ags)) }); status(why); $('#ops-op').innerHTML = ''; emptyPlan(why); return; }
    const pick = (o) => o && counts.has(o) && (counts.get(o) > 0 || ops[0][1] === 0);
    let op = pick(S.op) ? S.op : pick(st.operator) ? st.operator : ops[0][0];
    S.op = op; X.syncUrl?.();
    $('#ops-op').innerHTML = ops.map(([o, n]) => `<option value="${X.esc(o)}"${o === op ? ' selected' : ''}>${X.esc(o)} (${n ? t('ops.veh', { n: X.fmt(n) }) : t('ops.stations')})</option>`).join('');
    const vehicles = inMuni.filter(v => v.operator === op && (type === 'all' || v.type === type));
    // Carsharing und E-Roller haben kein Zellen-Nachfragemodell (die Zellen zählen Mikromobilität): keine Spots und keine Umsetzungen, nur
    // Energie und Werkstatt (Audit 11.11.2026, UXP-01; vorher z. B. 73 Auto-Umsetzungen für stationsgebundenes Carsharing)
    const noDemand = type === 'car' || type === 'moped' || (vehicles.length > 0 && vehicles.every(v => v.type === 'car' || v.type === 'moped'));
    const stations = stInMuni.filter(s => s.operator === op);
    const share = O.operatorShare(fleet, ags, op, { type }) ?? 1; // S2.10: derselbe Anteil wie Spot-Abgleich und Prognose-Spots (Markt ohne Autos)
    collectFor(ags, op, type, vehicles, fleet); // Einsammelliste (Abstellverbot): unabhängig von Nachfrage und Plan, im Hintergrund
    // Nachfrage
    const bandSel = $('#ops-band').value; let band = bandSel === 'auto' ? BAND_NOW() : bandSel === 'day' ? 'day' : +bandSel;
    let model = O.buildDemandModel(cellDocs, ags, band), bandNote = '';
    // Vorauswahl „Jetzt“ mit weniger Messstunden als eine Bandlänge (z. B. 1 Std. „Morgen“ am zweiten Messtag): ganzer Tag, wie die Nutzung
    // mit dem letzten vollen Tag startet; ein ausdrücklich gewähltes Band bleibt
    const bd = band === 'day' ? null : O.BANDS.find(b => b.id === band), thin = bandSel === 'auto' && bd && model.hours >= 0.5 && model.hours < bd.to - bd.from;
    if ((model.hours < 0.5 || thin) && band !== 'day') { const m2 = O.buildDemandModel(cellDocs, ags, 'day'); if (m2.hours > (thin ? model.hours : 0)) { bandNote = thin ? t('ops.autoBandFewHours', { label: bandLabel(band), h: X.fmt(model.hours, 1) }) : t('ops.noMeasurementForYet', { label: bandLabel(band) }); model = m2; band = 'day'; } }
    if (!model.cells.size || model.hours <= 0) { status(t('ops.thereIsNoDemandMeasurement')); emptyPlan(t('ops.noDemandMeasurementForThis')); drawFleetOnly(vehicles, stations); return; }
    // Kontext
    // Begrenzungsrahmen aus ops-input (S3.8), sonst aus den Gemeindegrenzen des Landes
    const b = (S.input?.ags === ags && S.input.bbox) || (await X.loadBoundaries(), st.boundaries?.features.find(f => f.properties.ags === ags)?.bbox) || null;
    const spacing = num('#ops-spacing', 220), topN = Math.min(60, num('#ops-n', 20)), horizonH = num('#ops-horizon', 3);
    status(t('ops.loadingZonesAndSurroundings'));
    const pre = O.scoreSpots(model, { topN: Math.min(80, topN * 3), minSpacingM: spacing * 0.6, bootDraws: 0 }); // Vorauswahl für Overpass: ohne Bootstrap
    const useOsm = $('#ops-osm').checked;
    const [np, ctxDoc, official, groupRes, flowRes] = await Promise.all([
      loadNoPark(ags, op, b ? [b[0] - 0.02, b[1] - 0.02, b[2] + 0.02, b[3] + 0.02] : null),
      useOsm ? contextFor(ags) : Promise.resolve(null),
      officialData(ags),
      loadGroupDocs(ags),
      loadFlowDocs(cellDocs.map(d => d.day).filter(Boolean)),
    ]);
    if (stop()) return;
    O.attachFlows(model, flowRes.docs); // Ströme als Beleg für Abfluss/Zufluss je Zelle (cell.flow, model.flow)
    const osm = ctxDoc?.state === 'ok' ? ctxDoc : null;
    // Overpass im Hintergrund: danach nur Spots und Umsetzen neu (rescoreSpots), nicht der ganze Plan
    if (useOsm && !osm && pre.spots.length) overpassBackground(ags, pre.spots, () => rescoreSpots(ags));
    renderWarn(ags, osm, np, official, groupRes);
    if (!S.depot[ags] && !S.depotUrlUsed) { const u = urlDepot(); S.depotUrlUsed = true; if (u && (!b || (u.lon >= b[0] - 0.2 && u.lon <= b[2] + 0.2 && u.lat >= b[1] - 0.2 && u.lat <= b[3] + 0.2))) S.depot[ags] = u; } // nur einmal, nur in der Nähe der Gemeinde
    const depot = S.depot[ags] || (b ? { lat: (b[1] + b[3]) / 2, lon: (b[0] + b[2]) / 2 } : centroid(vehicles));
    const params = { topN, spacing, share, horizonH, van: num('#ops-van', 20), common: { depot, maxRuns: num('#ops-maxruns', 6), horizonH, maxRunMin: Math.round(num('#ops-maxh', 4) * 60), prioLambda: prioLambda() }, swapCapacity: Math.min(50, num('#ops-swapcap', 50)), swapThreshold: num('#ops-swapthr', 20), swapRangeKm: num('#ops-swaprange', 5) };
    const plan = { ags, op, type, noDemand, band, bandNote, model, share, depot, np, osm, official, params, groups: O.groupPlaces(groupRes.docs, { ags }), groupSrc: groupRes, flowSrc: flowRes, fleet: { vehicles, stations }, at: fleet.at, trackStart: fleet.trackStart ?? null, days: cellDocs.length };
    if (!S.gf || S.gf.forOp !== op || S.gf.forAgs !== ags) S.gf = { ...GF0(), kind: S.gf?.kind || 'deploy', sort: S.gf?.sort || 'count', dir: S.gf?.dir || 'desc', op, forOp: op, forAgs: ags };
    // Rechenschritte nacheinander mit Status, dazwischen die Seite freigeben
    const steps = [
      [t('ops.scoringSpots'), () => { plan.spots = scoreFor(plan, osm); }],
      [t('ops.runsRebalancing'), () => { plan.rebalance = rebalanceFor(plan); }],
      [t('ops.runsBatterySwap'), () => { plan.swaps = swapsFor(plan); }],
      [t('ops.runsWorkshop'), () => { plan.workshop = workshopFor(plan); }],
      [t('ops.runsStations'), () => { plan.station = stationFor(plan); }],
    ];
    for (const [label, fn] of steps) { status(`${label} …`); await tick(); if (stop()) return; fn(); }
    plan.kpi = O.fleetKpis(vehicles, { swapThreshold: params.swapThreshold, swapRangeKm: params.swapRangeKm });
    S.plan = plan; S.routed = {}; S.focus = null; S.stale = false; plan.hhmm = hhmm();
    status(t('ops.mapAndTables')); await tick(); if (S.plan !== plan) return;
    renderTiles(); renderRuns(); renderSpots(); renderGroups(); await tick(); if (S.plan !== plan) return;
    drawMap(true);
    status(planStatus(plan));
    loadArea(ags).then(a => X.econFor(ags, op, type, a)).then(e => { if (S.plan === plan) { plan.econ = e || false; renderTiles(); } }).catch(() => { plan.econ = false; });
    if ($('#ops-route').checked) routeRuns();
  } catch (e) { console.error(e); status(`<span class="warn-text">${t('ops.planCouldNotBeCalculated', { message: X.esc(e.message) })}</span> ${t('ops.checkParametersAndPress')}`); }
  finally { S.busy = false; S.pending = null; if (!S.again) S.retry = false; if (S.again) { S.again = false; setTimeout(computePlan, 0); } else if (S.rescore) { const a = S.rescore; S.rescore = null; setTimeout(() => rescoreSpots(a), 0); } }
}
const centroid = (list) => list.length ? { lat: list.reduce((s, v) => s + v.lat, 0) / list.length, lon: list.reduce((s, v) => s + v.lon, 0) / list.length } : { lat: 51.1, lon: 10.4 };
// Spots (MCDA) mit der jeweils vorhandenen Umgebung; stationsbasierte Flotte ohne frei abgestellte Fahrzeuge: keine Deploy-Spots
function scoreFor(p, osm) {
  const { topN, spacing, share, horizonH } = p.params, off = p.official;
  const parking = osm || off?.points.length ? [...(off?.points || []), ...(osm?.parking || [])] : null;
  const spots = O.scoreSpots(p.model, { topN, minSpacingM: spacing, share, horizonH, noPark: p.np.geoms, mandatory: p.np.mandatory, officialNoPark: off?.noPark || [], stations: p.fleet.stations, transit: osm?.transit || null, parking });
  if (!p.fleet.vehicles.length || p.noDemand) spots.spots = [];
  return spots;
}
const rebalanceFor = (p) => O.planRebalance({ spots: p.noDemand ? [] : p.spots.spots, vehicles: p.fleet.vehicles.filter(O.isAvailable), model: p.model, share: p.share, vanCapacity: p.params.van, ...p.params.common });
const swapsFor = (p) => O.planSwaps({ vehicles: p.fleet.vehicles.filter(v => !v.reserved), model: p.model, swapCapacity: p.params.swapCapacity, swapThreshold: p.params.swapThreshold, swapRangeKm: p.params.swapRangeKm, ...p.params.common });
const workshopFor = (p) => O.planWorkshop({ vehicles: p.fleet.vehicles, workshopCapacity: p.params.van, ...p.params.common });
const stationFor = (p) => { const sb = p.fleet.stations.length ? O.planStationBalance({ stations: p.fleet.stations, vanCapacity: p.params.van, ...p.params.common }) : null; return sb?.stations ? sb : null; };
/** Regler „Priorität ↔ Strecke“ geändert: nur die Touren neu (Bündelung, Einsatzgrenze, Reihenfolge); Nachfrage, Spots und Kartenebenen
 *  bleiben, eine fokussierte Tour bleibt fokussiert, die Straßenmatrix kommt aus dem Cache. Läuft gerade ein Plan, rechnet er danach neu. */
export async function replanRuns() {
  const p = S.plan; if (!p) return;
  if (S.busy) { S.again = true; return; } S.busy = true;
  try {
    status(`${t('ops.reorderingRuns', { level: prioName() })} …`); await tick(); if (S.plan !== p || S.again) return;
    const next = { ...p, params: { ...p.params, common: { ...p.params.common, prioLambda: prioLambda() } }, hhmm: hhmm() };
    next.rebalance = rebalanceFor(next); next.swaps = swapsFor(next); next.workshop = workshopFor(next); next.station = stationFor(next);
    const keep = S.focus;
    S.plan = next; S.routed = {}; S.focus = keep && allRuns().some(r => r.id === keep) ? keep : null;
    renderTiles(); renderRuns(); drawRoutes(); status(planStatus(next));
    if ($('#ops-route').checked) routeRuns();
  } catch (e) { console.error(e); status(`<span class="warn-text">${t('ops.planCouldNotBeCalculated', { message: X.esc(e.message) })}</span>`); }
  finally { S.busy = false; if (S.again) { S.again = false; setTimeout(computePlan, 0); } }
}
export function planStatus(p) {
  const osm = p.osm, loading = $('#ops-osm').checked && !osm && S.osm[p.ags]?.state === 'loading';
  const osmNote = !$('#ops-osm').checked ? '' : osm ? `, ${t('ops.surroundingsOsm', { v0: osm.from === 'Sammler' ? t('ops.osmFromCollector', { v0: new Date(osm.at).toLocaleDateString(fmtLocale()) }) : X.esc(osm.from) })}` : loading ? `, ${t('ops.publicTransportAndParking')}` : '';
  return t('ops.computedInFleetOfDemandFrom', { hhmm: p.hhmm, op: X.esc(p.op), muniName: X.esc(X.muniName(p.ags)), v3: new Date(p.at).toLocaleString(fmtLocale(), { dateStyle: 'short', timeStyle: 'short' }), days: p.model.days, v5: p.model.days === 1 ? t('ops.day') : t('ops.days'), hours: X.fmt(p.model.hours, 1), v7: p.bandNote ? `, ${p.bandNote}` : '', osmNote });
}
/** Nach der Overpass-Antwort: nur Spots (ÖPNV, Abstellflächen) und das davon abhängige Umsetzen neu rechnen.
 *  Akkutausch, Werkstatt und Stationsausgleich hängen nicht von Spots ab und behalten Reihenfolge und Straßenrouting. */
async function rescoreSpots(ags) {
  const p = S.plan; if (!p || p.ags !== ags || X.state.scope !== ags) return;
  if (S.busy) { S.rescore = ags; return; } S.busy = true;
  try {
    const osm = S.osm[ags]?.state === 'ok' ? S.osm[ags] : null;
    renderWarn(ags, osm, p.np, p.official);
    if (!osm) { status(planStatus(p)); return; }
    status(t('ops.reScoringSpotsWithOsm', { p: planStatus(p) })); await tick();
    if (S.plan !== p || S.again) return;
    const next = { ...p, osm, hhmm: hhmm() };
    next.spots = scoreFor(next, osm); next.rebalance = rebalanceFor(next);
    for (const r of p.rebalance.runs) { delete S.routed[r.id]; if (S.focus === r.id) S.focus = null; } // Umsetz-Touren sind neu
    S.plan = next;
    status(planStatus(next)); renderTiles(); renderRuns(); renderSpots(); renderGroups();
    drawLayers(['spots']); drawRoutes(); // Nachfrage, Flotte, Gruppen und Depot bleiben unverändert stehen
    if ($('#ops-route').checked) routeRuns();
  } catch (e) { console.error(e); }
  finally { S.busy = false; if (S.again) { S.again = false; setTimeout(computePlan, 0); } }
}

function drawFleetOnly(vehicles, stations) {
  for (const v of vehicles) L.circleMarker([v.lat, v.lon], { radius: 3, weight: 0, fillColor: X.opColor(v.operator), fillOpacity: .8, renderer: S.canvas.fleet }).addTo(S.layers.fleet);
  for (const s of stations) L.circleMarker([s.lat, s.lon], { radius: 5, weight: 2, color: X.opColor(s.operator), fillColor: s.bookable ? X.opColor(s.operator) : 'transparent', fillOpacity: .6, renderer: S.canvas.fleet }).addTo(S.layers.fleet);
  const pts = [...vehicles, ...stations].map(v => [v.lat, v.lon]); if (pts.length) S.map.fitBounds(L.latLngBounds(pts).pad(0.1));
}
// Kein Plan möglich (keine Daten, keine Fahrzeuge der Art, keine Nachfrage): Kacheln, Touren und Tabellen nennen den Grund,
// statt leer zu bleiben („Wird geladen …“) oder den Plan der vorigen Gemeinde zu zeigen
function emptyPlan(why) {
  S.plan = null; S.focus = null; S.routed = {};
  for (const k in S.layers) S.layers[k].clearLayers();
  const row = (n) => `<tr><td colspan="${n}" class="empty">${t('ops.noPlan', { why })}</td></tr>`;
  $('#ops-tiles').innerHTML = ''; setAnswer($('#ops-answer'), { id: 'ops', sentence: t('ops.noPlan', { why }), kpis: [] }); $('#ops-layers').innerHTML = ''; $('#ops-legend').innerHTML = ''; $('#ops-warn').innerHTML = '';
  $('#ops-runs').innerHTML = `<div class="empty">${t('ops.noRuns', { why })}</div>`; $('#ops-runs-all').hidden = true;
  $('#ops-spots-sub').textContent = ''; $('#ops-spots tbody').innerHTML = row(SPOT_COLS);
  $('#ops-groups-sub').textContent = ''; $('#ops-groups tbody').innerHTML = ''; groupsEmpty($('#ops-groups'), t('ops.noPlan', { why })); $('#ops-gf-count').textContent = '';
  $('#ops-map-sub').textContent = X.muniName(X.state.scope);
  renderCollect(); // Einsammelliste zeigt nur, was zu Gebiet, Flotte und Art passt
}

// ---------- Ausgabe ----------
function tile(l, v, s, cls = '') { return `<div class="tile ${cls}"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`; }
// Reichweiten-Schwelle der Quelle (v.rangeLimitKm, lib/pulse-ops.js swapRangeOf): „5 (Quelle 2,4) km“, wenn eine Quelle der Flotte darunter liegt
function rangeText(vehicles, setting) {
  const lims = [...new Set((vehicles || []).map(v => v.rangeLimitKm).filter(x => x != null && x < setting))].sort((a, b) => a - b);
  if (!lims.length) return { v: X.fmt(setting, setting % 1 ? 1 : 0), limited: false };
  const l = lims.length > 1 ? `${X.fmt(lims[0], 1)}–${X.fmt(lims[lims.length - 1], 1)}` : X.fmt(lims[0], 1);
  return { v: t('ops.srcLimitParen', { v: X.fmt(setting, setting % 1 ? 1 : 0), limit: l }), limited: true };
}
export function renderTiles() {
  const p = S.plan, k = p.kpi, f = X.fmt;
  const need = p.rebalance.needs.reduce((s, n) => s + n.need, 0), target = p.spots.spots.reduce((s, x) => s + x.target, 0);
  const runs = allRuns(); const km = runs.reduce((s, r) => s + r.km, 0), min = runs.reduce((s, r) => s + r.totalMin, 0);
  const cl = [...p.model.cells.values()], sph = cl.reduce((s, c) => s + (c.startsPerHour || 0), 0);
  const drainCells = cl.filter(c => (c.outPerHour ?? 0) > 0), drain = drainCells.reduce((s, c) => s + c.outPerHour, 0);
  const pr = X.state.usage?.profile; const prelim = !pr || pr.source === 'Standardkurve' || (pr.days ?? 0) < 3; const rv = (x) => x >= 100 ? f(sig2(x)) : f(x);
  $('#ops-tiles').innerHTML = [
    tile(t('ops.fleet'), `${f(k.available)}<small> / ${f(k.total)}</small>`, t('ops.availableReportedDisabled', { disabled: f(k.disabled), v1: f(p.share * 100) })),
    p.noDemand ? tile(t('ops.demand'), '–', t('ops.noDemandModelForType')) : tile(t('ops.demand'), `${f(sph * p.share, 1)} /h`, t('ops.tripStartsMarketHNetOutflowH', { v0: p.band === 'day' ? t('ops.dailyMean') : bandLabel(p.band), sph: f(sph, 1), v2: f(drain * p.share, 1), length: f(drainCells.length), hours: f(p.model.hours, 1) })),
    tile(t('ops.spots'), `${f(p.spots.spots.length)}`, t('ops.needVehShortfall', { target: f(target), need: f(need), v2: p.spots.excluded ? `, ${t('ops.cellsExcludedZones', { excluded: f(p.spots.excluded), v1: p.spots.excludedBy?.official ? t('ops.ofWhichNoParkingZonePerCity', { official: f(p.spots.excludedBy.official) }) : '' })}` : '' }), need > target * 0.5 ? 'warn' : ''),
    // Akku und Standzeit getrennt: jede Kachel warnt nur wegen ihres eigenen Werts (vorher „0“ in Warnfarbe wegen der Standzeit)
    tile(t('ops.lowBatteryTile'), k.batteryKnown ? `${f(k.low)}` : t('common.na'), k.batteryKnown ? (() => { const rt = rangeText(p.fleet.vehicles, p.params.swapRangeKm ?? 5); return t(k.chargeKnown ? 'ops.lowBatterySub' : 'ops.lowRangeSub', { charge: p.params.swapThreshold ?? 20, range: rt.v, known: f(k.batteryKnown) }) + (k.lockedLow ? `, ${t('ops.lockedLow', { n: f(k.lockedLow) })}` : '') + (rt.limited ? `, ${t('ops.srcLimitRule', { share: Math.round(O.RANGE_LIMIT.share * 100), maxP95: O.RANGE_LIMIT.maxP95Km })}` : ''); })() : t('ops.noChargeLevelInFeed'), k.batteryKnown && k.low / k.batteryKnown > 0.25 ? 'warn' : ''),
    // Mindestwerte (Z6): seit Beginn der Verfolgung unbewegt; der Median ist „≥“, sobald er im Bereich der zensierten Werte liegt
    (() => { const cz = p.fleet.vehicles.filter(v => !v.disabled && !v.reserved && v.idleMin != null && v.idleCensored), czMin = cz.length ? Math.min(...cz.map(v => v.idleMin)) : null;
      const med = k.idleMedianH == null ? '–' : idleCls(k.idleMedianH * 60, czMin != null && k.idleMedianH * 60 >= czMin);
      const cs = cz.length && p.trackStart ? `, ${t('trk.opsIdleCensored', { share: `${f((cz.length / Math.max(1, k.idleKnown)) * 100)} %`, start: dateFmt({ day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' }).format(new Date(p.trackStart)) })}` : '';
      return tile(t('ops.idleTile'), k.idleKnown ? `${f(k.idle24)}` : t('common.na'), k.idleKnown ? t('ops.idleSub', { share: `${f((k.idle24 / k.idleKnown) * 100)} %`, median: med }) + cs : '', k.idleKnown && k.idle24 / k.idleKnown > 0.3 ? 'warn' : ''); })(),
    tile(t('ops.revenueDay'), p.econ === undefined ? '…' : p.econ?.revDay != null && p.econ.plausible ? (prelim ? `${rv(p.econ.revDay * 0.7)}<small>–${rv(p.econ.revDay * 1.3)} €</small>` : `${f(p.econ.revDay)} €`) : '—', p.econ === undefined ? t('ops.loadingEstimate') : !p.econ ? t('ops.noTripDataForThisOperator') : t('ops.tripsVehDayUtilisationNet', { v0: prelim ? `${t('ops.preliminaryUnder3Measurement')}, ` : '', v1: p.econ.plausible ? '' : `${t('ops.tripCountImplausible')}, `, rvd: f(p.econ.rvd, 2), v3: p.econ.utilization == null ? '–' : f(p.econ.utilization * 100, 1) + ' %' }), `est${p.econ && !p.econ.plausible ? ' warn' : ''}`),
    tile(t('ops.runs'), `${f(runs.length)}`, t('ops.kmHOnDuty', { km: f(km, 1), v1: f(min / 60, 1), v2: Object.keys(S.routed).length ? t('ops.byRoad', { length: f(Object.keys(S.routed).length), length2: f(runs.length) }) : $('#ops-route')?.checked && !osrmDown() ? t('ops.roadRoutingInProgress') : t('ops.straightLine135') })),
  ].join('');
  // S4.1: Antwort oben – was zu tun ist (Fehlbestand an Spots = Summe der Spalte „Fehlen“ in der Spot-Tabelle), Flotte, Touren
  setAnswer($('#ops-answer'), { id: 'ops',
    sentence: t(need > 0 ? 'ans.ops' : 'ans.opsNone', { need: `<strong>${f(need)}</strong>`, spots: f(p.rebalance.needs.filter(n => n.need > 0).length), op: `<b>${X.esc(p.op)}</b>`, muni: X.esc(X.muniName(p.ags)), runs: f(runs.length) }),
    kpis: [
      { label: t('ans.kNeed'), value: f(need), n: need, cmp: t('ans.kNeedCmp', { target: f(target), n: f(p.spots.spots.length) }), tone: need > 0 ? 'warn' : 'ok', eq: '#ops-spots tbody td.need', eqSum: true },
      { label: t('ops.fleet'), value: f(k.available), n: k.available, cmp: t('ans.kFleetCmp', { total: f(k.total), disabled: f(k.disabled) }) },
      { label: t('ops.runs'), value: f(runs.length), n: runs.length, cmp: t('ans.kRunsCmp', { km: f(km, 1), h: f(min / 60, 1) }) },
    ],
    how: t('ans.opsHow', { h: f(p.params.horizonH), share: f(p.share * 100) }), asOf: `${p.hhmm}, ${t('ans.dataFrom', { at: new Date(p.at).toLocaleString(fmtLocale(), { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Berlin' }) })}` });
  // Reifegrad an Nachfrage und Deploy-Spots: belastbar ab 2 Wochen voller Messtage gleichen Regelstands (Messbasis, web/report.js mbBadge)
  { const land = X.state.latest?.municipalities?.[X.state.scope]?.state || null, b = mbBadge(mbBase(X.state, { land }), 'weeks2');
    for (const el of $('#ops-tiles').querySelectorAll('.tile')) if ([t('ops.demand'), t('ops.spots')].includes(el.querySelector('.l')?.textContent)) el.querySelector('.s')?.insertAdjacentHTML('beforeend', `<div class="mb-line">${b}</div>`); }
}
// Ebenen wie auf der Übersicht: Checkbox-Leiste (an = Haken und Fläche), Farbpunkt nur als Zuordnung zur Karte. Die Leiste wird je Plan einmal
// gebaut; ein Umschalter ändert nur Karte und Legende, damit der Tastaturfokus auf der Checkbox bleibt.
function layerToggles() {
  const opc = X.opColor(S.plan.op);
  const tog = (k, label, color) => `<label class="tog"><input type="checkbox" data-l="${k}"${S.show[k] ? ' checked' : ''}> ${color ? `<i class="dot" style="background:${color};margin-right:0"></i>` : ''}<span>${label}</span></label>`;
  $('#ops-layers').innerHTML = tog('demand', t('ops.netOutflow'), 'var(--accent)') + tog('fleet', t('ops.fleet'), opc) + tog('spots', t('ops.spots'), 'var(--accent)') + '<span class="sep" aria-hidden="true"></span>'
    + tog('groups', t('ops.operatorSpots'), opc) + tog('collect', t('ops.pickupPlaces'), opc) + violToggle() + (S.plan.official?.noPark.length ? tog('official', t('ops.officialZones'), 'var(--bad)') : '') + '<span class="sep" aria-hidden="true"></span>'
    + tog('rebalance', t('ops.rebalance'), RUN_COLOR.rebalance) + (S.plan?.station ? tog('station', t('ops.stations'), RUN_COLOR.station) : '') + tog('swap', t('ops.batterySwap'), RUN_COLOR.swap) + tog('workshop', t('ops.workshop'), RUN_COLOR.workshop);
}
export function legend() {
  const opc = X.opColor(S.plan.op), gv = (k) => groupView(k), mixed = S.gf?.op === 'all';
  const lay = $('#ops-layers'); if (lay._plan !== S.plan || lay._lang !== lang() || !lay.querySelector('input[data-l]')) { layerToggles(); lay._plan = S.plan; lay._lang = lang(); }
  $('#ops-legend').innerHTML = `<span><i class="sq" style="background:var(--accent);border-color:var(--accent)"></i>${t('ops.netOutflowHStartsEnds250M', { v0: abbr(t('ops.cell'), t('ops.gridOfAbout250250MStartsEnds')) })}</span>${S.show.fleet ? `<span><b class="ops-glyph dis" aria-hidden="true">✕</b>${t('ops.disabled')}</span><span><b class="ops-glyph bat" aria-hidden="true">▲</b>${t('ops.batteryLow')}</span><span><b class="ops-glyph idle" aria-hidden="true">○</b>${t('ops.n24HNotMoved')}</span>` : ''}<span><b class="ops-spot-mini">1</b>${t('ops.spotDashedRankUncertain')}</span><span><b class="ops-spot-mini" style="background:var(--fg)">D</b>Depot</span>`
    + (S.show.groups && gv('deploy').length ? `<span>${t('ops.presumedOperatorSpot', { v0: groupSvg('deploy', opc, 12), v1: mixed ? t('ops.colourOperator') : '' })}</span>` : '')
    + (S.show.collect && gv('collect').length ? `<span>${t('ops.pickupPlaceObservation', { v0: groupSvg('collect', opc, 12), v1: mixed ? t('ops.colourOperator') : '' })}</span>` : '')
    + (S.show.official && S.plan.official?.noPark.length ? `<span><i class="sq ops-hatch-key" aria-hidden="true"></i>${t('ops.noParkingZonePerCity', { v0: S.plan.official.sources.filter(x => x.ref.kind === 'noPark').map(x => refCite(x.ref)).join(', ') })}</span>` : '')
    + RUN_KINDS.filter(k => S.show[k] && allRuns().some(r => r.kind === k)).map(k => `<span><svg width="26" height="8" aria-hidden="true" style="vertical-align:middle;margin-right:6px"><line x1="1" y1="4" x2="25" y2="4" stroke="${RUN_COLOR[k]}" stroke-width="3"${RUN_DASH[k] ? ` stroke-dasharray="${RUN_DASH[k]}"` : ''}/></svg>${RUN_LABEL[k]}</span>`).join('')
    + (S.plan.official?.points.length ? `<span class="muted">${t('ops.parkingAreas', { v0: S.plan.official.sources.filter(x => x.ref.kind !== 'noPark').map(x => refCite(x.ref)).join(', ') })}</span>` : '') + violLegend();
}
// Raute = Ausbringung, gestricheltes Sechseck = Einsammeln; Umriss in der Anbieterfarbe
function groupSvg(kind, color, size, css = 'display:inline-block;vertical-align:-1px;margin-right:6px;') {
  const shape = kind === 'deploy' ? '12,1.5 22.5,12 12,22.5 1.5,12' : '6.5,2.5 17.5,2.5 23,12 17.5,21.5 6.5,21.5 1,12';
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" style="${css}overflow:visible"><polygon points="${shape}" fill="${color}" fill-opacity=".14" stroke="${color}" stroke-width="2.5" vector-effect="non-scaling-stroke"${kind === 'collect' ? ' stroke-dasharray="4 3"' : ''}/></svg>`;
}
export const WHEN = { format: (ms) => dateFmt({ day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(ms) }, DAYMON = { format: (ms) => dateFmt({ day: '2-digit', month: '2-digit' }).format(ms) };
export const whenText = (ms) => WHEN.format(ms); // feste Formatierer statt toLocaleString je Tabellenzeile
export const avgText = (x) => X.fmt(x, Number.isInteger(x) ? 0 : 1);
export const typesText = (tq) => Object.entries(tq || {}).sort((a, b) => b[1] - a[1]).map(([k]) => X.TYPE[k] || k).join(', ');
const groupPopup = (s, kind) => `${t('ops.firstLastAvgVehiclesInTotal', { v0: kind === 'deploy' ? t('ops.presumedDeploySpot') : t('ops.pickupPlace'), op: X.esc(s.op), count: X.fmt(s.count), v3: kind === 'deploy' ? t('ops.deployedLc') : t('ops.collectedLc'), v4: whenText(s.first), v5: whenText(s.last), v6: avgText(s.avg), vehicles: X.fmt(s.vehicles), v8: typesText(s.types) ? `, ${X.esc(typesText(s.types))}` : '' })}<span style="color:var(--muted)">${t('ops.fromObservationNoOperator')}</span>`;
const sgn = (x, d = 2) => x == null || !Number.isFinite(x) ? '—' : `${x > 0 ? '+' : x < 0 ? '−' : ''}${X.fmt(Math.abs(x), d)}`;
// Spot-Beschriftung für Screenreader/Tooltip: „Spot 3: <Lage>“ (Adresse, sobald Nominatim sie geliefert hat)
export const spotTitle = (s) => t('ops.spot', { rank: s.rank, v1: GEO.get(geoKey(s.lat, s.lon)) || (s.park ? parkLabel(s.park) : t('ops.cellCentre')) });
// Ein gemeinsames Popup für die Canvas-Ebenen Nachfrage und Flotte (bis > 5.000 Punkte): kein Popup-Objekt je Marker,
// der Inhalt entsteht erst beim Klick aus der Funktion in POP
export const POP = new WeakMap();
const withPop = (layer, fn) => { POP.set(layer, fn); return layer; };
export function openShared(e) { const fn = POP.get(e.layer); if (!fn) return; L.popup({ maxWidth: 300 }).setLatLng(e.layer.getLatLng ? e.layer.getLatLng() : e.latlng).setContent(fn()).openOn(S.map); }
const BASE_LAYERS = ['demand', 'official', 'fleet', 'spots', 'groups', 'collect', 'depot'];
const GLYPH = { dis: '✕', bat: '▲', idle: '○' }; // S4.7: Fahrzeugzustand als Glyphe
// S4.7: Touren über den Linienstil (Farbe bleibt Zusatz): Umsetzen durchgezogen, Akkutausch gestrichelt, Werkstatt gepunktet, Stationen Strich-Punkt
export const RUN_DASH = { rebalance: null, swap: '9 5', workshop: '2 5', station: '12 4 2 4' };
// Ganze Karte: Grundebenen, Routen, optional einpassen
export function drawMap(fit) {
  if (!S.plan) return;
  legend(); drawLayers(BASE_LAYERS); drawRoutes();
  if (fit) fitAll();
}
// Nur die genannten Grundebenen neu zeichnen (Ebenen-Chip, Neubewertung nach Overpass); Popups erst beim Öffnen. Routen: drawRoutes().
export function drawLayers(keys) {
  const p = S.plan; if (!p) return;
  const Lx = S.layers, f = X.fmt, esc = X.esc, on = (k) => keys.includes(k) && S.show[k];
  for (const k of keys) Lx[k].clearLayers();
  if (keys.includes('spots')) S.spotMarkers = [];
  if (on('demand')) {
    // Netto-Abfluss je Zelle (Starts − Enden je h, Markt): eine Farbe, Deckkraft nach Rang; Zellen mit Zufluss bleiben leer
    const vals = [...p.model.cells.values()].map(c => c.outPerHour || 0).filter(x => x > 0).sort((a, b) => a - b);
    const q = (x) => { let lo = 0, hi = vals.length; while (lo < hi) { const m = (lo + hi) >> 1; if (vals[m] < x) lo = m + 1; else hi = m; } return vals.length ? lo / vals.length : 0; }; // Rang (binäre Suche)
    const fl = p.model.flow;
    for (const c of p.model.cells.values()) {
      if (!(c.outPerHour > 0)) continue;
      withPop(L.rectangle([[c.lat - O.CELL_LAT / 2, c.lon - O.CELL_LON / 2], [c.lat + O.CELL_LAT / 2, c.lon + O.CELL_LON / 2]], { weight: 0, fillColor: tok('--accent'), fillOpacity: 0.08 + 0.5 * q(c.outPerHour), renderer: S.canvas.demand }),
        () => t('ops.cellMarketMeasuredHoursNet', { cell: esc(c.cell), hours: f(p.model.hours, 1), v2: sgn(c.outPerHour), outSe: f(c.outSe, 2), starts: f(c.starts), startsPerHour: f(c.startsPerHour, 2), ends: f(c.ends), endsPerHour: f(c.endsPerHour, 2), supplyAvg: f(c.supplyAvg, 1), v9: t('ops.cellBalanceK', { k: f(p.model.balance?.k ?? 1, 3), endsBal: f(c.endsPerHourBal ?? c.endsPerHour, 2), low: f(c.outLow ?? 0, 2) }) + (fl ? t('ops.flowsOutIn', { days: f(fl.days), v1: fl.days === 1 ? t('ops.day') : t('ops.days2'), v2: f(c.flow?.out || 0), v3: f(c.flow?.in || 0) }) : '') })).addTo(Lx.demand);
    }
  }
  // Abstellverbotszonen der Stadt (Ausschluss), gestrichelt unter der Flotte; nicht anklickbar, Quelle und Lizenz in der Legende
  if (on('official')) for (const g of p.official?.noPark || []) L.geoJSON(g, { interactive: false, style: { color: tok('--bad'), weight: 1.5, fillOpacity: 1, className: 'ops-hatch' }, renderer: (S.svgHatch ||= L.svg({ padding: 0.3 })) }).addTo(Lx.official); // S4.7: Abstellverbot als Schraffur (SVG-Muster #mp-hatch)
  if (on('fleet')) {
    const swapOpt = { swapThreshold: num('#ops-swapthr', 20), swapRangeKm: num('#ops-swaprange', 5) };
    for (const v of p.fleet.vehicles) {
      // S4.7: Zustand über die Form (✕ gesperrt, ▲ Akku, ○ über 24 h unbewegt), im Graustufenbild unterscheidbar; übrige Fahrzeuge als kleiner Punkt
      const opc = X.opColor(v.operator), st = v.disabled ? 'dis' : O.needsSwap(v, swapOpt) ? 'bat' : (v.idleMin ?? 0) >= 1440 ? 'idle' : null;
      const mk = st ? L.marker([v.lat, v.lon], { icon: L.divIcon({ className: `ops-glyph ${st}`, html: GLYPH[st], iconSize: [14, 14] }), keyboard: false, interactive: true })
        : L.circleMarker([v.lat, v.lon], { radius: 2.5, weight: 0, fillColor: opc, fillOpacity: .45, renderer: S.canvas.fleet });
      withPop(mk,
        () => `<b>${esc(v.operator)}</b>, ${esc(X.TYPE[v.type] || v.type)}<br>${v.disabled ? `${t('ops.disabled')}, ` : v.reserved ? `${t('ops.reserved')}, ` : ''}${v.battery != null ? `${t('ops.battery', { battery: f(v.battery) })}, ` : ''}${v.idleMin != null ? (v.idleCensored ? t('trk.idleForAtLeast', { v0: idleCls(v.idleMin, true) }) : t('ops.idleForH', { v0: idleCls(v.idleMin) })) : ''}`).addTo(Lx.fleet);
    }
    for (const s of p.fleet.stations) withPop(L.circleMarker([s.lat, s.lon], { radius: 5, weight: 2, color: X.opColor(s.operator), fillColor: s.bookable ? X.opColor(s.operator) : 'transparent', fillOpacity: .6, renderer: S.canvas.fleet }),
      () => t('ops.bookable', { v0: esc(stationName(s.name) || t('ops.station')), bookable: f(s.bookable), v2: s.docks != null ? t('ops.free', { docks: f(s.docks) }) : '', v3: s.capacity ? `, ${t('ops.capacity', { capacity: f(s.capacity) })}` : '' })).addTo(Lx.fleet);
  }
  // Spot-, Gruppen- und Depot-Marker ohne Tab-Stopp (keyboard: false): dieselben Angaben stehen in den Tabellen unter der Karte,
  // so führt die Tastatur von den Ebenen-Chips ohne 20+ Zwischenschritte zur Tourenliste
  if (on('spots')) {
    const needBy = new Map(p.rebalance.needs.map(n => [n.cell, n]));
    for (const s of p.spots.spots) {
      const n = needBy.get(s.cell);
      L.circle([s.lat, s.lon], { radius: 150, weight: 1, color: tok('--accent'), fill: false, dashArray: s.stabilityLabel === 'stabil' ? null : '4 4', interactive: false }).addTo(Lx.spots);
      S.spotMarkers.push([s, L.marker([s.lat, s.lon], { icon: L.divIcon({ className: `ops-spot${s.stabilityLabel === 'stabil' ? '' : ' weak'}`, html: `${s.rank}`, iconSize: [24, 24] }), title: spotTitle(s), keyboard: false })
        .bindPopup(() => t('ops.spotNeedVehFleet150M', { rank: s.rank, v1: s.park ? `, ${esc(parkLabel(s.park))}` : '', target: f(s.target), v3: f(n?.have), v4: f(n?.need), startsPerHourOp: f(s.startsPerHourOp, 2), endsPerHourOp: f(s.endsPerHourOp, 2), v7: `${sgn(s.outPerHourOp)} ± ${f(s.outSeOp, 2)}`, hours: f(s.hours, 1), score: f(s.score, 2), v10: `${p.spots.prelim ? t('ops.preliminary') : (STAB[s.stabilityLabel] ?? s.stabilityLabel)}${s.bootShare != null ? ` (${t('ops.bootShare', { share: f(s.bootShare * 100) })})` : ''}` })).addTo(Lx.spots)]);
    }
  }
  // Vermutete Anbieter-Spots und Einsammel-Orte (Gruppen-Ereignisse), Größe nach Anzahl, unter den eigenen Spots
  for (const [kind, l] of [['deploy', 'groups'], ['collect', 'collect']]) {
    if (!on(l)) continue;
    for (const s of groupView(kind)) { const z = Math.round(16 + 4 * Math.sqrt(Math.min(s.count, 25)));
      L.marker([s.lat, s.lon], { icon: L.divIcon({ className: 'ops-group', html: groupSvg(kind, X.opColor(s.op), z, ''), iconSize: [z, z] }), zIndexOffset: -500, keyboard: false, title: `${kind === 'deploy' ? t('ops.presumedDeploySpot') : t('ops.pickupPlace')}, ${s.op}, ${s.count}×` }).bindPopup(() => groupPopup(s, kind)).addTo(Lx[l]); }
  }
  if (keys.includes('depot')) L.marker([p.depot.lat, p.depot.lon], { icon: L.divIcon({ className: 'ops-spot depot', html: 'D', iconSize: [24, 24] }), title: 'Depot', keyboard: false }).bindPopup(t('ops.depotSetDepotAndClickOnMapTo')).addTo(Lx.depot);
}
// Nur die Touren-Ebenen neu zeichnen (nach jeder OSRM-Route, Fokus, Ebenen-Chip): Fahrzeug-, Spot- und Gruppen-Marker bleiben stehen
export function drawRoutes() {
  const p = S.plan; if (!p) return;
  for (const k of RUN_KINDS) S.layers[k].clearLayers();
  for (const r of allRuns()) {
    if (!S.show[r.kind] || (S.focus && r.id !== S.focus)) continue;
    const geo = S.routed[r.id]?.coords || [[p.depot.lat, p.depot.lon], ...r.stops.map(s => [s.lat, s.lon]), [p.depot.lat, p.depot.lon]];
    L.polyline(geo, { color: RUN_COLOR[r.kind], weight: S.routed[r.id]?.coords ? 3.5 : 2.5, opacity: S.routed[r.id]?.coords ? .9 : .65, dashArray: RUN_DASH[r.kind], renderer: S.canvas.runs }) // Luftlinie dünner und blasser, nach Straße kräftig.bindPopup(() => runTitle(r)).addTo(S.layers[r.kind]);
    r.stops.forEach((s, i) => L.circleMarker([s.lat, s.lon], { radius: 5, weight: 2, color: RUN_COLOR[r.kind], fillColor: s.type === 'drop' ? RUN_COLOR[r.kind] : NEUTRAL.white, fillOpacity: 1, renderer: S.canvas.runs })
      .bindTooltip(`${r.id}·${i + 1} ${STOP_LABEL[s.type]} ${s.count}${s.prio != null ? `, ${t('ops.stopPrio', { prio: X.fmt(s.prio, 2), rank: s.rank, n: r.stops.length })}` : ''}${whyText(s) ? `, ${whyText(s)}` : ''}`, { direction: 'top' }).addTo(S.layers[r.kind]));
  }
  $('#ops-map-sub').textContent = `${X.muniName(p.ags)}, ${p.op}, ${p.band === 'day' ? t('ops.wholeDay2') : bandLabel(p.band)}${S.focus ? `, ${t('ops.onlyRun', { focus: S.focus })}` : ''}`;
}
export function fitAll() {
  const p = S.plan; if (!p) return;
  const pts = p.spots.spots.length ? [...p.spots.spots.map(s => [s.lat, s.lon]), [p.depot.lat, p.depot.lon]] : p.fleet.vehicles.map(v => [v.lat, v.lon]);
  if (pts.length) S.map.fitBounds(L.latLngBounds(pts).pad(0.08));
}
// Tour-Fokus: nur eine Tour auf der Karte, Karte darauf eingepasst; „Alle Touren zeigen“ und neuer Plan heben ihn auf
export function focusRun(id) {
  const r = allRuns().find(x => x.id === id); if (!r) return;
  S.focus = id; if (!S.show[r.kind]) { S.show[r.kind] = true; legend(); }
  markFocus(); drawRoutes();
  const pts = S.routed[r.id]?.coords || [[S.plan.depot.lat, S.plan.depot.lon], ...r.stops.map(s => [s.lat, s.lon])];
  S.map.fitBounds(L.latLngBounds(pts).pad(0.15));
}
export function markFocus() {
  document.querySelectorAll('#ops-runs .ops-run').forEach(el => el.classList.toggle('focus', el.dataset.run === S.focus));
  $('#ops-runs-all').hidden = !S.focus;
}
const parkLabel = (pk) => ({ station: t('ops.operatorStationMandatory'), escooter: t('ops.eScooterParkingBay'), official: t('ops.officialParkingArea'), sharing: t('ops.sharingMobilityHub'), rad: t('ops.bikeRack') }[pk.cat] || pk.cat) + (pk.name ? ` „${pk.name}“` : '');
const runTitle = (r) => t('ops.vehKmMin', { id: r.id, v1: RUN_LABEL[r.kind], vehicles: X.fmt(r.vehicles), km: X.fmt(r.km, 1), totalMin: X.fmt(r.totalMin) });
// Grund der Priorität eines Stopps (dringendstes Fahrzeug): „Akku 8 %, steht 31 h“, „Spot leer (150 m)“, „Station voll“
function whyText(s) {
  const w = s.why || {}, f = X.fmt, out = [];
  if (s.type === 'swap') { if (w.battery != null) out.push(t('ops.battery2', { v0: f(w.battery) })); else if (w.rangeKm != null) out.push(t('ops.whyRange', { v: f(w.rangeKm, 1) })); }
  if (w.idleH != null && s.type !== 'drop' && !s.station) out.push(idleHText(w.idleH));
  if (s.type === 'drop') { if (s.station) out.push(w.empty ? t('ops.whyStationEmpty') : t('ops.whyShortfall', { need: f(w.need) })); else if (w.empty) out.push(t('ops.whySpotEmpty')); }
  if (s.type === 'pickup' && s.station && w.full) out.push(t('ops.whyStationFull'));
  return out.join(', ');
}
// Stoppliste: Art, Anzahl, Spot/Station, Priorität mit Rang in der Tour, Grund, Strecke vom Depot bis hierher
function stopItem(s, r) {
  const f = X.fmt, esc = X.esc, why = whyText(s);
  const base = `${STOP_LABEL[s.type]} ${f(s.count)}${s.station ? `, ${esc(s.station)} (${esc(s.fill)})` : ''}${s.spotRank ? `, ${t('ops.spot2', { spotRank: s.spotRank, v1: s.need != null ? `, ${t('ops.shortfallNeedFleet', { need: f(s.need), target: f(s.target), have: f(s.have) })}` : '' })}` : ''}`;
  if (s.prio == null) return `<li>${base}${s.battery?.length ? `, ${t('ops.battery2', { v0: s.battery.slice(0, 6).join('/') })}` : ''}${s.idleMaxH ? `, ${idleHText(s.idleMaxH)}` : ''}</li>`;
  const all = s.count > 1 && s.battery?.length > 1 ? `, ${t('ops.battery2', { v0: s.battery.slice(0, 6).join('/') })}` : '';
  const pr = t('ops.stopPrio', { prio: f(s.prio, 2), rank: s.rank, n: r.stops.length });
  return `<li>${base}${all}, ${s.prio >= 1 ? `<b>${pr}</b>` : pr}${why ? `: ${why}` : ''}, <span class="muted">${t('ops.atKm', { km: f(s.atKm, 1) })}</span></li>`; // ab 1 = dringend: fett
}
// Reihenfolge der Tour: Grundlage der km, Vergleich mit reiner Prioritätsfolge und Nächstem Nachbarn (gleiche Stopps), Preis der Priorität
function seqLine(r) {
  if (r.kmPrio == null && r.kmNN == null) return '';
  const f = X.fmt, k = r.kmSeq ?? r.km, d = (x) => `${x > 0.05 ? '+' : x < -0.05 ? '−' : '±'}${f(Math.abs(x), 1)}`;
  const parts = [r.road ? t('ops.seqBasisRoad') : t('ops.straightLine135')];
  if (r.kmPrio != null) parts.push(t('ops.seqVsPrio', { d: d(k - r.kmPrio) }));
  if (r.kmNN != null) parts.push(t('ops.seqVsNN', { d: d(k - r.kmNN) }));
  if (!r.lambda) parts.push(t('ops.seqKmOnly'));
  else if (r.reachKm != null && r.reachKmMin != null) {
    const extra = k - r.kmMin, gain = r.reachKmMin - r.reachKm, v = { d: d(extra), reach: f(r.reachKm, 1), reachMin: f(r.reachKmMin, 1) };
    // gleich lang und gleich früh: die kürzeste Reihenfolge ist auch nach Priorität die beste (z. B. Umsetzen: jeder Umweg beim Einsammeln verzögert alle Ausbringungen)
    parts.push(Math.abs(extra) < 0.05 && Math.abs(gain) < 0.05 ? t('ops.seqPrioSame', v) : Math.abs(extra) < 0.05 ? t('ops.seqPrioFree', v) : t('ops.seqPrio', v));
  }
  return `<p class="small muted ops-seq" title="${X.esc(t('ops.seqTitle'))}">${parts.join(', ')}</p>`;
}
export function renderRuns() {
  const p = S.plan, f = X.fmt, esc = X.esc, box = $('#ops-runs');
  // Neu zeichnen nach jeder Straßenroute: offene Stopplisten und den Tastaturfokus erhalten
  const open = new Set([...box.querySelectorAll('details[open]')].map(d => d.closest('[data-run]')?.dataset.run));
  const act = box.contains(document.activeElement) ? document.activeElement : null, actRun = act?.closest('[data-run]')?.dataset.run;
  const actSel = act?.matches('[data-fit]') ? '[data-fit]' : act?.matches('summary') ? 'summary' : act?.matches('a') ? `a:nth-of-type(${[...act.parentElement.querySelectorAll('a')].indexOf(act) + 1})` : null;
  const limit = p.rebalance.limitMin, hText = limit ? `${f(limit / 60, limit % 60 ? 1 : 0)} h` : '';
  const left = (n) => n ? `, <span class="warn-text">${t('ops.notScheduled', { n: f(n) })}</span> ${t('ops.numberOfRunsOrPerRun', { hText })}` : '';
  const block = (kind, plan, head) => {
    const runs = plan?.runs || [];
    if (!plan) return '';
    const body = runs.length ? runs.map(r => {
      const pts = [p.depot, ...r.stops, p.depot]; const links = O.mapsLinks(pts);
      return `<div class="card ops-run${S.focus === r.id ? ' focus' : ''}" data-run="${r.id}" title="${t('ops.showOnlyThisRunOnMap')}" style="border-left:3px solid ${RUN_COLOR[kind]}">${t('ops.vehStops', { id: r.id, vehicles: f(r.vehicles), length: f(r.stops.length), v3: r.kind === 'rebalance' && r.prio ? `, ${t('ops.shortfallUpTo', { prio: f(r.prio) })}` : '' })}
        <p>${t('ops.kmMinDrivingMinOnSiteMin', { km: f(r.km, 1), driveMin: f(r.driveMin), handleMin: f(r.handleMin), totalMin: f(r.totalMin), v4: S.routed[r.id] ? `, ${t('ops.road')}` : '', v5: (limit && r.totalMin > limit ? `, <span class="warn-text">${t('ops.byRoadOver', { hText })}</span>` : '') + (r.trimmed ? `, <span class="warn-text">${t('ops.trimmedByLimit', { n: f(r.trimmed), hText })}</span>` : '') })}</p>
        ${seqLine(r)}
        <details${open.has(r.id) ? ' open' : ''}><summary>${t('ops.stopList')}</summary><ol class="small">${r.stops.map(s => stopItem(s, r)).join('')}</ol></details>
        <div class="foot"><button class="chip" data-fit="${r.id}">${t('ops.onMap')}</button> ${links.map((u, i) => `<a href="${u}" target="_blank" rel="noopener" title="${t('ops.googleMapsAllowsAtMost10')}">${links.length > 1 ? t('ops.routePartOf', { v0: i + 1, length: links.length }) : t('ops.route')} ↗</a>`).join(', ')}</div></div>`;
    }).join('') : `<div class="muted small">${t('ops.noRunNeeded')}</div>`;
    return `<h3 style="margin-top:12px">${RUN_LABEL[kind]}</h3><div class="sub">${head}</div><div class="cards" style="grid-template-columns:1fr">${body}</div>`;
  };
  const rb = p.rebalance, sw = p.swaps, ws = p.workshop, sb = p.station;
  box.innerHTML =
    (S.plan.fleet.vehicles.length ? '' : `<div class="note">${t('ops.stationBasedFleetNoFree')}</div>`) +
    block('rebalance', rb, t('ops.rebalancingMovesFromSurplus', { moves: f(rb.moves), surplus: f(rb.surplus), v2: rb.missing > 0 ? `, ${t('ops.placesRemainOpenNoSurplus', { missing: f(rb.missing), v1: f(O.DEFAULTS.maxPickupM / 1000) })}` : '', v3: left(rb.unplanned) })) +
    (sb ? block('station', sb, t('ops.nearlyEmptyNearlyFullOf', { empty: f(sb.empty), full: f(sb.full), stations: f(sb.stations), moves: f(sb.moves), v4: left(sb.unplanned) })) : '') +
    block('swap', sw, sw.below ? t('ops.vehiclesBelowChargeAndKm', { below: f(sw.below), v1: num('#ops-swapthr', 20), v2: rangeText(p.fleet.vehicles, num('#ops-swaprange', 5)).v, v3: left(sw.unplanned) }) : t('ops.noVehicleBelowThresholdOrNo')) +
    block('workshop', ws, ws.disabled ? t('ops.disabledVehiclesLongest', { disabled: f(ws.disabled), v1: left(ws.unplanned) }) : t('ops.noDisabledVehicles'));
  $('#ops-runs-sub').textContent = `${t('ops.runsForBundledByCityAreaAt', { op: p.op, hText })}, ${t('ops.orderBy', { level: prioName() })}`;
  markFocus();
  if (actRun && actSel) box.querySelector(`[data-run="${actRun}"] ${actSel}`)?.focus({ preventScroll: true });
}
// Spot-Tabelle: alle Zahlen der Bedarfsrechnung sichtbar (Kopf ersetzt den aus index.html)
// Lage steht vorn, der Rang als Präfix: am Telefon bleibt die erste (feste) Spalte die Lage statt einer schmalen Rangnummer
export const SPOT_COLS = 11;
export function spotHead() {
  const th = (tq, tip, n = true) => `<th${n ? ' class="n"' : ''}><abbr title="${tip}">${tq}</abbr></th>`;
  return `<tr><th>${t('ops.rank')}, ${t('ops.location')}</th>${th(t('ops.startsPerH'), t('ops.tripStartsPerHourOperatorS'))}${th(t('ops.endsPerH'), t('ops.tripEndsPerHourOperatorS'))}${th(t('ops.netPerH'), t('ops.netOutflowStartsEndsPerHour'))}`
    + `${th(t('ops.measurement'), t('ops.measuredHoursInChosenTimeOf'))}${th(t('ops.need'), t('ops.needMax0NetHHorizonBaseStock'))}${th(t('ops.fleet2'), t('ops.operatorSAvailableVehicles'))}${th(t('ops.shortfall'), t('ops.shortfallNeedFleet2'))}`
    + `${th('Score', t('ops.weightedSumOfFactorsDTPAhp'))}${th(t('ops.factors'), t('ops.netOutflowDDemandStartsHT'), false)}${th(t('ops.stability'), t('ops.howSurelySpotStaysIn'), false)}</tr>`;
}
export function renderSpots() {
  const p = S.plan, f = X.fmt, esc = X.esc, sp = p.spots, H = p.params.horizonH, D = O.DEFAULTS;
  const needBy = new Map(p.rebalance.needs.map(n => [n.cell, n]));
  const prelim = sp.prelim; // Netto-Abfluss und Sensitivität über wenige Messstunden sind nicht aussagekräftig
  // Ströme als Beleg: bei wie vielen Spots mit Netto-Abfluss zeigen auch die Ströme mehr Abfahrten als Ankünfte
  const fl = p.model.flow, withFlow = sp.spots.filter(s => s.outPerHourOp > 0 && s.flow && s.flow.out + s.flow.in >= 2), agree = withFlow.filter(s => s.flow.out > s.flow.in).length;
  const flowNote = fl ? `, ${t('ops.flowsStableIdsTripsWithStart', { days: f(fl.days), v1: fl.days === 1 ? t('ops.day') : t('ops.days2'), trips: f(fl.trips), v3: fl.below ? t('ops.belowMinimumThreshold', { below: f(fl.below) }) : '', v4: withFlow.length ? ` ${t('ops.forOfSpotsWithNetOutflowAlso', { agree: f(agree), length: f(withFlow.length) })}` : '' })}`
    : p.flowSrc?.indexed ? `, ${t('ops.flowsNoFileYetForTheseDemand')}` : `, ${t('ops.flowsNoneYetFlowsAppears')}`;
  $('#ops-spots-sub').innerHTML = esc(t('ops.candidateCellsFactorsNeedMax', { candidates: sp.candidates, v1: sp.activeFactors.map(k => AHP_L[k]).join(', '), H: f(H), baseH: f(sp.baseH), v4: f(p.share * 100), hours: f(p.model.hours, 1), days: f(p.model.days), v7: p.model.days === 1 ? t('ops.day') : t('ops.days'), v8: sp.rho != null ? `, ${t('ops.rankCorrelationDemandNet', { rho: f(sp.rho, 2) })}` : '', flowNote, length: p.np.geoms.length, v11: p.np.mandatory.length ? ` ${t('ops.andMandatoryParking', { length: p.np.mandatory.length })}` : '', files: p.np.files, v13: p.np.files === 1 ? t('ops.zoneFeed') : t('ops.zoneFeeds'), v14: sp.excludedBy?.operator ? ` ${t('ops.cellsExcluded', { operator: sp.excludedBy.operator })}` : '', v15: p.osm ? `, ${t('ops.osmParkingAreasStopPoints', { length: f(p.osm.parking.length), length2: f(p.osm.transit.length) })}` : '' })) +
    // amtliche Daten mit Quelle und Lizenz: Abstellflächen (Spot rastet ein), Abstellverbotszonen (Ausschluss, kein Gewicht)
    (p.official?.sources || []).map(({ ref, n }) => `, ${refCite(ref)}: ${ref.kind === 'noPark' ? t('ops.noParkingZonesCellsExcluded', { n: f(n), v1: f(sp.excludedBy?.official || 0) }) : t('ops.officialParkingAreas2', { n: f(n) })}`).join('') +
    // Ausgleich je Gemeinde (Σ Starts = Σ Enden, unterdrückte Ereignisse eingerechnet) und Bootstrap (M-10, lib/pulse-ops.js buildDemandModel, BOOT)
    (sp.balance ? `, ${esc(t('ops.balanceNote', { starts: f(sp.balance.totalStarts), belowStarts: f(sp.balance.belowStarts), ends: f(sp.balance.totalEnds), belowEnds: f(sp.balance.belowEnds), k: f(sp.balance.k, 3) }))}` : '') +
    (sp.boot ? `, ${esc(t('ops.bootNote', { stable: f(sp.stable), n: f(sp.spots.length), uncertain: f(sp.uncertain), draws: f(sp.boot.draws), share: f(sp.boot.minShare * 100) }))}` : '') +
    (prelim ? `<br><span class="warn-text">${t('ops.preliminaryNetOutflowAnd', { prelimH: f(D.prelimH), hours: f(p.model.hours, 1) })}</span>` : '');
  const bar = (x) => `<span class="bar" style="display:inline-block;width:38px;vertical-align:middle"><i style="width:${Math.round((x ?? 0) * 100)}%"></i></span>`;
  const F = { 'Δ': t('ops.netOutflowStartsEndsPerH'), N: t('ops.demandStartsH'), Ö: t('ops.publicTransportProximityStop'), A: t('ops.parkingAreaNearby') };
  const fac = (x, l) => `${bar(x)} <abbr title="${F[l]}: ${f((x ?? 0) * 100)} %">${FL(l)}</abbr>`;
  const formula = (s) => (s.drain > 0 ? `${f(s.outPerHourOp, 2)} × ${f(H)} h + ${f(s.base, 1)}` : t('ops.baseStock', { base: f(s.base, 1) })) + (s.capped ? ` ${t('ops.max', { needRaw: f(s.needRaw, 1), maxPerSpot: f(D.maxPerSpot) })}` : s.target > Math.ceil(s.needRaw - 1e-9) ? t('ops.min', { minPerSpot: f(D.minPerSpot) }) : '');
  $('#ops-spots tbody').innerHTML = sp.spots.map(s => { const n = needBy.get(s.cell); const k = geoKey(s.lat, s.lon); const g = s.rank <= GEO_TOP ? GEO.get(k) : undefined;
    const osm = osmLink(s.lat, s.lon);
    const place = s.park ? esc(parkLabel(s.park)) : t('ops.cellCentre');
    const main = s.rank > GEO_TOP ? place : `<span class="geo-main" translate="no" data-geo="${k}" data-fallback="${place}">${g ? esc(g) : g === null ? place : `<span class="muted">${t('ops.lookingUpAddress')}</span>`}</span>`;
    return `<tr><td><span class="mono muted">${s.rank}.</span> ${main}<div class="sub-line">${osm}${s.rank <= GEO_TOP ? `, ${place}` : ''}</div></td>
    <td class="n">${f(s.startsPerHourOp, 2)}<div class="sub-line">${t('ops.market', { startsPerHour: f(s.startsPerHour, 2) })}</div></td><td class="n">${f(s.endsPerHourOp, 2)}<div class="sub-line">${t('ops.endsCountedK', { counted: f(s.endsPerHour, 2), k: f(s.balanceK ?? 1, 2) })}</div></td>
    <td class="n"><b>${sgn(s.outPerHourOp)}</b><div class="sub-line">${t('ops.outRange', { se: f(s.outSeOp, 2), lo: sgn(s.outLoOp ?? 0), hi: sgn(s.outHiOp ?? 0), low: f(s.outLowOp ?? 0, 2) })}${fl ? `, ${t('ops.flowsOutIn2', { v0: f(s.flow?.out || 0), v1: f(s.flow?.in || 0) })}` : ''}</div></td>
    <td class="n">${f(s.hours, 1)} h<div class="sub-line">${t('ops.startsEnds', { starts: f(s.starts), ends: f(s.ends) })}</div></td>
    <td class="n"><b>${f(s.target)}</b><div class="sub-line">${formula(s)}</div></td><td class="n">${f(n?.have)}<div class="sub-line">${t('ops.avgMarket', { supplyAvg: f(s.supplyAvg, 1) })}</div></td><td class="n need" style="color:var(--${n?.need ? 'warn' : 'muted'})"><b>${f(n?.need)}</b></td>
    <td class="n">${f(s.score, 2)}</td>
    <td class="small" style="white-space:nowrap">${fac(s.factors.outflow, 'Δ')} ${fac(s.factors.demand, 'N')}${sp.activeFactors.includes('transit') ? ` ${fac(s.factors.transit, 'Ö')}` : ''}${sp.activeFactors.includes('parking') ? ` ${fac(s.factors.parking, 'A')}` : ''}</td>
    <td>${prelim ? `<span class="pill prelim" title="${t('ops.meaningfulOnlyFromMeasured', { prelimH: f(D.prelimH) })}">${t('ops.preliminary')}</span>` : `<span class="pill ${s.stabilityLabel === 'stabil' ? 'live' : s.stabilityLabel === 'mittel' ? 'delayed' : 'stale'}">${STAB[s.stabilityLabel] ?? s.stabilityLabel}</span>`}<div class="sub-line">${t('ops.ofVariants', { v0: f(s.stability * 100) })}</div>${s.bootShare != null ? `<div class="sub-line">${t('ops.bootShare', { share: f(s.bootShare * 100) })}</div>` : ''}</td></tr>`; }).join('') || `<tr><td colspan="${SPOT_COLS}" class="empty">${p.noDemand ? t('ops.noSpotsForType') : sp.excluded && sp.candidates && sp.excluded >= sp.candidates * 0.5 ? t('ops.noSpotsZones', { excluded: f(sp.excluded), candidates: f(sp.candidates) }) : t('ops.noSpotsTooLittleDemand')}</td></tr>`;
  queueGeo(sp.spots.slice(0, GEO_TOP));
}
export const osmLink = (lat, lon) => `<a href="https://www.openstreetmap.org/?mlat=${lat.toFixed(5)}&mlon=${lon.toFixed(5)}#map=18/${lat.toFixed(5)}/${lon.toFixed(5)}" target="_blank" rel="noopener" class="mono" title="${t('ops.openInOpenstreetmap')}">${lat.toFixed(5)}, ${lon.toFixed(5)}</a>`;
