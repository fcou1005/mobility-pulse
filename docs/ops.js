// Mobility Pulse — Disposition: Deploy-Spots, Umsetz-, Akkutausch-, Werkstatt- und Stationstouren im Browser.
import * as O from './pulse-ops.js?v=mvwxzft8';

let X; // Kontext aus app.js: state, CFG, getJson, esc, fmt, opColor, muniName, notice, clearNotice, loadBoundaries, loadUsageIndex, loadCells, loadOnce, TYPE
const $ = (s, el = document) => el.querySelector(s);
const S = { map: null, layers: {}, ops: {}, osm: {}, wfs: {}, zones: {}, depot: {}, pickDepot: false, plan: null, routed: {}, show: { demand: true, fleet: true, spots: true, rebalance: true, swap: false, workshop: false, station: true }, busy: false, op: null };
const RUN_COLOR = { rebalance: '#60a5fa', swap: '#34d399', workshop: '#ef6b6b', station: '#f59e0b' };
const RUN_LABEL = { rebalance: 'Umsetzen', swap: 'Akkutausch', workshop: 'Werkstatt', station: 'Stationsausgleich' };
const STOP_LABEL = { pickup: 'Abholen', drop: 'Ausbringen', swap: 'Akku tauschen', pickup_disabled: 'Defekt abholen' };
const BAND_NOW = () => O.bandOf(+new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Europe/Berlin' }).format(new Date()) % 24);
const num = (id, d) => { const v = +$(id)?.value; return Number.isFinite(v) && v > 0 ? v : d; };

// Deep-Links: aktuelle Flotte lesen, Parameter aus der URL setzen (Flotte wird beim Rechnen geprüft)
export const opsFleet = () => S.op;
export function applyOpsParams({ op, type } = {}) {
  if (op) S.op = op;
  const sel = $('#ops-type'); if (type && [...sel.options].some(o => o.value === type)) sel.value = type;
}
const abbr = (text, title) => `<abbr title="${X.esc(title)}">${text}</abbr>`;
const sig2 = (x) => { const p = 10 ** Math.max(0, Math.floor(Math.log10(Math.abs(x) || 1)) - 1); return Math.round(x / p) * p; };
const hhmm = () => new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

export function initOps(ctx) {
  X = ctx;
  $('#ops-band').innerHTML = `<option value="auto">Jetzt (${O.BANDS[BAND_NOW()].label})</option>` + O.BANDS.map(b => `<option value="${b.id}">${b.label} · ${b.from}–${b.to} Uhr</option>`).join('') + '<option value="day">Ganzer Tag</option>';
  $('#ops-run').addEventListener('click', () => computePlan());
  $('#ops-op').addEventListener('change', (e) => { S.op = e.target.value; computePlan(); });
  ['#ops-type', '#ops-band', '#ops-days'].forEach(id => $(id).addEventListener('change', () => computePlan()));
  $('#ops-depot').addEventListener('click', () => { S.pickDepot = !S.pickDepot; $('#ops-depot').classList.toggle('primary', S.pickDepot); status(S.pickDepot ? 'Klick auf die Karte setzt das Depot.' : ''); });
  $('#ops-layers').addEventListener('click', (e) => { const b = e.target.closest('[data-l]'); if (!b) return; S.show[b.dataset.l] = !S.show[b.dataset.l]; drawMap(false); });
  $('#ops-runs').addEventListener('click', (e) => { const b = e.target.closest('[data-fit]'); if (!b || !S.plan) return; const r = allRuns().find(x => x.id === b.dataset.fit); if (!r) return; S.show[r.kind] = true; drawMap(false); S.map.fitBounds(L.latLngBounds([[S.plan.depot.lat, S.plan.depot.lon], ...r.stops.map(s => [s.lat, s.lon])]).pad(0.15)); });
  $('#ops-csv-spots').addEventListener('click', () => S.plan && download(`spots_${slug()}.csv`, O.spotsCsv(S.plan.spots.spots, { name: X.muniName(S.plan.ags) }), 'text/csv'));
  $('#ops-csv-analysis').addEventListener('click', () => S.plan && download(`spots-analyse_${slug()}.csv`, '﻿' + O.spotsAnalysisCsv(S.plan.spots.spots), 'text/csv'));
  $('#ops-csv-runs').addEventListener('click', () => S.plan && download(`touren_${slug()}.csv`, '﻿' + O.runsCsv(allRuns(), S.plan.depot), 'text/csv'));
  $('#ops-geojson').addEventListener('click', () => S.plan && download(`plan_${slug()}.geojson`, JSON.stringify(O.planGeoJson(S.plan.spots.spots, allRuns(), S.plan.depot)), 'application/geo+json'));
  document.addEventListener('click', (e) => { const a = e.target.closest('.ops-pick'); if (!a) return; e.preventDefault(); $('#sel-scope').value = a.dataset.ags; $('#sel-scope').dispatchEvent(new Event('change')); setTimeout(() => { location.hash = '#ops'; renderOps(); }, 0); });
  // OSM erneut versuchen (nach Ausfall gilt sonst 10 Min. Pause)
  document.addEventListener('click', (e) => { if (!e.target.closest('#ops-osm-retry')) return; const ags = S.plan?.ags || X.state.scope; delete S.osm[ags]; $('#ops-warn').innerHTML = ''; computePlan(); });
  renderMethod();
}

const ascii = (t) => String(t).replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue').replace(/ß/g, 'ss').normalize('NFKD').replace(/[^\w-]+/g, '-');
const slug = () => `${ascii(X.muniName(S.plan.ags))}_${ascii(S.plan.op)}_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`;
function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` })); a.download = name; a.style.display = 'none'; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000); }
function status(html) { $('#ops-status').innerHTML = html; }
const allRuns = () => S.plan ? [...S.plan.rebalance.runs, ...(S.plan.station?.runs || []), ...S.plan.swaps.runs, ...S.plan.workshop.runs] : [];

function ensureMap() {
  if (S.map) { setTimeout(() => S.map.invalidateSize(), 50); return; }
  S.map = L.map('ops-map', { preferCanvas: true }).setView([51.1, 10.4], 6);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende' }).addTo(S.map);
  for (const k of ['demand', 'fleet', 'spots', 'rebalance', 'swap', 'workshop', 'station', 'depot']) S.layers[k] = L.layerGroup().addTo(S.map);
  S.map.on('click', (e) => { if (!S.pickDepot || !S.plan) return; S.depot[S.plan.ags] = { lat: e.latlng.lat, lon: e.latlng.lng }; S.pickDepot = false; $('#ops-depot').classList.remove('primary'); computePlan(); });
}

export async function renderOps() {
  ensureMap();
  const st = X.state;
  if (st.scope === 'DE') { showPicker(); return; }
  $('#ops-pick').hidden = true;
  if (!S.plan || S.plan.ags !== st.scope) await computePlan();
}
function showPicker() {
  const munis = Object.values(X.state.latest?.municipalities || {}).map(m => ({ ...m, avail: Object.values(m.operators || {}).reduce((s, o) => s + (o.available ?? o.total ?? 0), 0) })).sort((a, b) => b.avail - a.avail).slice(0, 18);
  const el = $('#ops-pick'); el.hidden = false;
  el.innerHTML = `<h2>Gemeinde wählen</h2><div class="sub">Die Disposition rechnet je Gemeinde und Anbieter. Oben im Filter ist jede Gemeinde wählbar; hier die größten Flotten.</div><div class="chips">${munis.map(m => `<a href="#ops" class="chip ops-pick" data-ags="${m.ags}">${X.esc(m.name)} <span class="muted">${X.fmt(m.avail)}</span></a>`).join('')}</div>`;
  for (const k in S.layers) S.layers[k].clearLayers();
  $('#ops-tiles').innerHTML = ''; $('#ops-runs').innerHTML = ''; $('#ops-warn').innerHTML = ''; $('#ops-spots-sub').textContent = ''; $('#ops-spots tbody').innerHTML = '<tr><td colspan="10" class="empty"><b>Noch kein Plan.</b>Oben eine Gemeinde wählen.</td></tr>'; status('');
}

// ---------- Daten ----------
async function loadOpsDoc(stCode) {
  if (!(stCode in S.ops)) { const r = await X.getJson(X.CFG.DATA + `ops/${stCode}.json`, { timeout: 90000 }); S.ops[stCode] = r.ok ? O.decodeFleet(r.json) : null; }
  return S.ops[stCode];
}
async function loadCellDocs(stCode, days) {
  const idx = await X.loadUsageIndex();
  const list = (idx.cellDays || []).slice(-days);
  return (await Promise.all(list.map(d => X.loadCells(d, stCode)))).filter(Boolean);
}
async function loadNoPark(ags, op, bbox) {
  const idx = await X.loadOnce('zonesIndex', 'zones/index.json');
  const files = (idx?.zones || []).filter(z => z.operator === op && (z.municipalities || []).includes(ags)).map(z => z.file);
  const geoms = [], mandatory = [];
  for (const f of files) {
    if (!(f in S.zones)) { const r = await X.getJson(X.CFG.DATA + `zones/${f}`, { timeout: 60000 }); S.zones[f] = r.ok ? O.zoneConstraints(r.json) : { noPark: [], mandatory: [] }; }
    for (const g of S.zones[f].noPark) if (!bbox || overlaps(g, bbox)) geoms.push(g);
    for (const g of S.zones[f].mandatory) if (!bbox || overlaps(g, bbox)) mandatory.push(g);
  }
  return { geoms, mandatory, files: files.length };
}
function overlaps(g, b) { const c = JSON.stringify(g.coordinates).match(/-?\d+\.\d+/g) || []; let x0 = 999, x1 = -999, y0 = 999, y1 = -999; for (let i = 0; i + 1 < c.length; i += 2) { const x = +c[i], y = +c[i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return !(x1 < b[0] || x0 > b[2] || y1 < b[1] || y0 > b[3]); }
// Umgebung (ÖPNV, Abstellflächen): erst die vom Sammler vorberechnete Datei, sonst Overpass im Hintergrund
const CTX_CATS = ['escooter', 'sharing', 'rad', 'official'];
async function contextFor(ags) {
  if (S.osm[ags]?.state === 'ok' || S.osm[ags]?.state === 'loading') return S.osm[ags];
  if (!S.osm[ags]) {
    const r = await X.getJson(X.CFG.DATA + `context/${ags}.json`, { timeout: 30000 });
    if (r.ok) { const d = r.json; return (S.osm[ags] = { state: 'ok', from: 'Sammler', at: d.at, parking: d.parking.map(([lat, lon, c, name]) => ({ lat, lon, cat: d.cats?.[c] || CTX_CATS[c], name })), transit: d.transit.map(([lat, lon]) => ({ lat, lon })) }); }
  }
  return S.osm[ags] || null;
}
function overpassBackground(ags, points, onDone) {
  if (S.osm[ags]?.state === 'loading' || S.osm[ags]?.state === 'ok') return;
  if (S.osm[ags]?.state === 'fail' && Date.now() - S.osm[ags].at < 10 * 60e3) return;
  S.osm[ags] = { state: 'loading', at: Date.now() };
  const la = points.map(p => p.lat), lo = points.map(p => p.lon);
  const bb = [Math.min(...la) - 0.003, Math.min(...lo) - 0.004, Math.max(...la) + 0.003, Math.max(...lo) + 0.004].map(x => x.toFixed(4)).join(',');
  // Eine bbox-Abfrage mit festen Schlüsseln ist auf Overpass viel schneller als viele around-Filter oder Schlüssel-Regex
  const q = `[out:json][timeout:90][bbox:${bb}];(nwr["amenity"~"^(kick-scooter_parking|small_vehicle_parking|small_electric_vehicle_parking|bicycle_rental|kick-scooter_rental|mobility_hub|bicycle_parking)$"];nwr["small_electric_vehicle"];node["highway"="bus_stop"];node["public_transport"="platform"];node["railway"~"^(tram_stop|station|halt)$"];);out center tags;`;
  (async () => {
    for (const ep of X.CFG.OVERPASS) {
      try {
        const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 100000);
        const r = await fetch(ep, { method: 'POST', body: new URLSearchParams({ data: q }), signal: ctrl.signal }); clearTimeout(t);
        if (!r.ok) continue; const j = await r.json(); if (!Array.isArray(j?.elements) || j.remark) continue;
        S.osm[ags] = { state: 'ok', from: new URL(ep).host, at: Date.now(), parking: O.parkingFromOsm(j.elements), transit: O.transitFromOsm(j.elements) };
        onDone(); return;
      } catch { /* nächster Spiegel */ }
    }
    S.osm[ags] = { state: 'fail', at: Date.now() }; onDone();
  })();
}
async function officialParking(ags) {
  const ref = Object.values(X.state.catalog?.parking_reference || {}).find(p => p.ags === ags);
  if (!ref) return null;
  if (!(ags in S.wfs)) {
    const u = new URL(ref.wfs); u.search = new URLSearchParams({ service: 'WFS', version: '2.0.0', request: 'GetFeature', typeNames: ref.typeNames || 'abstell_mikromob:abstell_mikromob', outputFormat: 'application/json', srsName: 'EPSG:4326' });
    const r = await X.getJson(u.toString(), { timeout: 45000 });
    S.wfs[ags] = r.ok ? { points: O.parkingFromWfs(r.json), ref } : null;
  }
  return S.wfs[ags];
}

// ---------- Plan ----------
async function computePlan() {
  if (S.busy) { S.again = true; return; } S.busy = true;
  const st = X.state, ags = st.scope;
  try {
    ensureMap();
    if (ags === 'DE') { showPicker(); return; }
    const info = st.latest?.municipalities?.[ags]; const stCode = info?.state;
    if (!stCode) { status('Gemeinde ist im Sammler-Stand nicht bekannt.'); return; }
    status('Lade Flotte und Nachfrage …');
    const [fleet, cellDocs] = await Promise.all([loadOpsDoc(stCode), loadCellDocs(stCode, +$('#ops-days').value || 3)]);
    if (!fleet) { status(`Noch keine Dispositionsdaten (<span class="mono">ops/${stCode}.json</span>). Sie entstehen mit dem nächsten Sammler-Lauf.`); return; }
    const inMuni = fleet.vehicles.filter(v => v.ags === ags), stInMuni = fleet.stations.filter(s => s.ags === ags);
    // Anbieter mit Fahrzeugen der gewählten Art zuerst; Stationsanbieter nur bei Rädern
    const type = $('#ops-type').value;
    const typeOk = (t) => type === 'all' || t === type;
    const counts = new Map(); for (const v of inMuni) if (typeOk(v.type)) counts.set(v.operator, (counts.get(v.operator) || 0) + 1);
    if (type === 'all' || type === 'bike' || type === 'ebike') for (const s of stInMuni) if (!counts.has(s.operator)) counts.set(s.operator, 0);
    const ops = [...counts].sort((a, b) => b[1] - a[1]);
    if (!ops.length) { status(`Keine ${type === 'all' ? 'Fahrzeuge oder Stationen' : X.TYPE[type] || type} in dieser Gemeinde im letzten Sammler-Lauf — andere Fahrzeugart wählen.`); for (const k in S.layers) S.layers[k].clearLayers(); $('#ops-op').innerHTML = ''; return; }
    const pick = (o) => o && counts.has(o) && (counts.get(o) > 0 || ops[0][1] === 0);
    let op = pick(S.op) ? S.op : pick(st.operator) ? st.operator : ops[0][0];
    S.op = op; X.syncUrl?.();
    $('#ops-op').innerHTML = ops.map(([o, n]) => `<option value="${X.esc(o)}"${o === op ? ' selected' : ''}>${X.esc(o)} · ${n ? `${X.fmt(n)} Fzg.` : 'Stationen'}</option>`).join('');
    const vehicles = inMuni.filter(v => v.operator === op && (type === 'all' || v.type === type));
    const stations = stInMuni.filter(s => s.operator === op);
    const marketAvail = inMuni.filter(v => O.isAvailable(v) && (type === 'all' || v.type === type)).length;
    const opAvail = vehicles.filter(O.isAvailable).length;
    const share = marketAvail ? opAvail / marketAvail : 1;
    // Nachfrage
    const bandSel = $('#ops-band').value; let band = bandSel === 'auto' ? BAND_NOW() : bandSel === 'day' ? 'day' : +bandSel;
    let model = O.buildDemandModel(cellDocs, ags, band), bandNote = '';
    if (model.hours < 0.5 && band !== 'day') { const m2 = O.buildDemandModel(cellDocs, ags, 'day'); if (m2.hours > 0) { bandNote = `Für „${O.BANDS[band].label}“ noch keine Messung, gerechnet mit dem ganzen Tag.`; model = m2; band = 'day'; } }
    if (!model.cells.size || model.hours <= 0) { status('Für diese Gemeinde gibt es noch keine Nachfrage-Messung (Zellen je Tageszeit werden seit dem 31.10.2026 gezählt).'); drawFleetOnly(vehicles, stations, ags); return; }
    // Kontext
    const b = (await X.loadBoundaries(), st.boundaries?.features.find(f => f.properties.ags === ags)?.bbox) || null;
    const spacing = num('#ops-spacing', 220), topN = Math.min(60, num('#ops-n', 20)), horizonH = num('#ops-horizon', 3);
    status('Lade Zonen und Umgebung …');
    const pre = O.scoreSpots(model, { topN: Math.min(80, topN * 3), minSpacingM: spacing * 0.6 });
    const useOsm = $('#ops-osm').checked;
    const [np, ctxDoc, wfs] = await Promise.all([
      loadNoPark(ags, op, b ? [b[0] - 0.02, b[1] - 0.02, b[2] + 0.02, b[3] + 0.02] : null),
      useOsm ? contextFor(ags) : Promise.resolve(null),
      officialParking(ags),
    ]);
    const osm = ctxDoc?.state === 'ok' ? ctxDoc : null;
    if (useOsm && !osm && pre.spots.length) overpassBackground(ags, pre.spots, () => { if (X.state.scope === ags) computePlan(); });
    const osmNote = !useOsm ? '' : osm ? ` · Umgebung: OSM (${osm.from === 'Sammler' ? `Sammler, ${new Date(osm.at).toLocaleDateString('de-DE')}` : osm.from})` : S.osm[ags]?.state === 'loading' ? ' · ÖPNV und Abstellflächen werden aus OSM geladen (bis 2 Min.), der Plan rechnet sich danach neu' : '';
    // OSM-Ausfall sichtbar als Warnung, nicht nur im Statustext
    $('#ops-warn').innerHTML = useOsm && !osm && S.osm[ags]?.state === 'fail' ? '<div class="note warn" role="alert"><b>OpenStreetMap nicht erreichbar.</b> Spots sind ohne ÖPNV-Nähe und Abstellflächen gerechnet (Faktoren Ö und A fehlen). <button class="chip" id="ops-osm-retry">Erneut versuchen</button></div>' : '';
    const parking = osm || wfs ? [...(wfs?.points || []), ...(osm?.parking || [])] : null;
    const spots = O.scoreSpots(model, { topN, minSpacingM: spacing, share, horizonH, noPark: np.geoms, mandatory: np.mandatory, stations, transit: osm?.transit || null, parking });
    const depot = S.depot[ags] || (b ? { lat: (b[1] + b[3]) / 2, lon: (b[0] + b[2]) / 2 } : centroid(vehicles));
    const common = { depot, maxRuns: num('#ops-maxruns', 6), horizonH };
    const van = num('#ops-van', 20);
    // Stationsbasierte Flotte ohne frei abgestellte Fahrzeuge: keine Deploy-Spots, nur Stationsausgleich
    const freeFloating = vehicles.length > 0;
    if (!freeFloating) spots.spots = [];
    const rebalance = O.planRebalance({ spots: spots.spots, vehicles: vehicles.filter(O.isAvailable), model, share, vanCapacity: van, ...common });
    const swaps = O.planSwaps({ vehicles: vehicles.filter(v => !v.reserved), model, swapCapacity: num('#ops-swapcap', 30), swapThreshold: num('#ops-swapthr', 25), ...common });
    const workshop = O.planWorkshop({ vehicles, workshopCapacity: van, ...common });
    const station = stations.length ? O.planStationBalance({ stations, vanCapacity: van, ...common }) : null;
    const kpi = O.fleetKpis(vehicles, { swapThreshold: num('#ops-swapthr', 25) });
    S.plan = { ags, op, type, band, bandNote, model, share, spots, rebalance, swaps, workshop, station, kpi, depot, np, osm, wfs, fleet: { vehicles, stations }, at: fleet.at, days: cellDocs.length };
    S.routed = {};
    status(`<b>Berechnet ${hhmm()}</b> · ${X.esc(op)} in ${X.esc(X.muniName(ags))} · Flotte vom ${new Date(fleet.at).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })} · Nachfrage aus ${model.days} Tag${model.days === 1 ? '' : 'en'} (${X.fmt(model.hours, 1)} Messstunden)${bandNote ? ` · ${bandNote}` : ''}${osmNote}`);
    renderTiles(); drawMap(true); renderRuns(); renderSpots();
    const plan = S.plan; X.econFor(ags, op, type).then(e => { if (S.plan === plan) { plan.econ = e || false; renderTiles(); } }).catch(() => { plan.econ = false; });
    if ($('#ops-route').checked) routeRuns();
  } catch (e) { console.error(e); status(`<span class="warn-text">Plan konnte nicht berechnet werden: ${X.esc(e.message)}.</span> Parameter prüfen und „Plan berechnen“ erneut drücken.`); }
  finally { S.busy = false; if (S.again) { S.again = false; setTimeout(computePlan, 0); } }
}
const centroid = (list) => list.length ? { lat: list.reduce((s, v) => s + v.lat, 0) / list.length, lon: list.reduce((s, v) => s + v.lon, 0) / list.length } : { lat: 51.1, lon: 10.4 };

function drawFleetOnly(vehicles, stations, ags) {
  for (const k in S.layers) S.layers[k].clearLayers();
  for (const v of vehicles) L.circleMarker([v.lat, v.lon], { radius: 3, weight: 0, fillColor: X.opColor(v.operator), fillOpacity: .8 }).addTo(S.layers.fleet);
  if (vehicles.length) S.map.fitBounds(L.latLngBounds(vehicles.map(v => [v.lat, v.lon])).pad(0.1));
}

// ---------- Ausgabe ----------
function tile(l, v, s, cls = '') { return `<div class="tile ${cls}"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`; }
function renderTiles() {
  const p = S.plan, k = p.kpi, f = X.fmt;
  const need = p.rebalance.needs.reduce((s, n) => s + n.need, 0), target = p.spots.spots.reduce((s, x) => s + x.target, 0);
  const runs = allRuns(); const km = runs.reduce((s, r) => s + r.km, 0), min = runs.reduce((s, r) => s + r.totalMin, 0);
  const sph = [...p.model.cells.values()].reduce((s, c) => s + (c.startsPerHour || 0), 0);
  const pr = X.state.usage?.profile; const prelim = !pr || pr.source === 'Standardkurve' || (pr.days ?? 0) < 3; const rv = (x) => x >= 100 ? f(sig2(x)) : f(x);
  $('#ops-tiles').innerHTML = [
    tile('Flotte', `${f(k.available)} / ${f(k.total)}`, `verfügbar / gemeldet · ${f(k.disabled)} gesperrt · Anteil an erfassten Fahrzeugen ${f(p.share * 100)} %`),
    tile('Nachfrage', `${f(sph * p.share, 1)} /h`, `Fahrtbeginne ${p.band === 'day' ? 'im Tagesmittel' : O.BANDS[p.band].label} · Markt ${f(sph, 1)} /h`),
    tile('Spots', `${f(p.spots.spots.length)}`, `Ziel ${f(target)} Fzg. · fehlen ${f(need)}${p.spots.excluded ? ` · ${f(p.spots.excluded)} Zellen durch Zonen ausgeschlossen` : ''}`, need > target * 0.5 ? 'warn' : ''),
    tile('Akku & Standzeit', k.batteryKnown ? `${f(k.low)}` : 'k. A.', `${k.batteryKnown ? `unter ${num('#ops-swapthr', 25)} % von ${f(k.batteryKnown)}` : 'kein Ladestand im Feed'} · ${f(k.idle24)} über 24 h unbewegt (Median ${k.idleMedianH == null ? '–' : f(k.idleMedianH, 1) + ' h'})`, (k.batteryKnown && k.low / k.batteryKnown > 0.25) || (k.idleKnown && k.idle24 / k.idleKnown > 0.3) ? 'warn' : ''),
    tile('Umsatz / Tag', p.econ === undefined ? '…' : p.econ?.revDay != null && p.econ.plausible ? (prelim ? `${rv(p.econ.revDay * 0.7)}–${rv(p.econ.revDay * 1.3)} €` : `${f(p.econ.revDay)} €`) : '—', p.econ === undefined ? 'Schätzung wird geladen' : !p.econ ? 'keine Fahrtdaten für diesen Anbieter' : `${prelim ? 'vorläufig (unter 3 Messtagen) · ' : ''}${p.econ.plausible ? '' : 'Fahrtenzahl unplausibel · '}${f(p.econ.rvd, 2)} Rides/Fzg./Tag · Auslastung ${p.econ.utilization == null ? '–' : f(p.econ.utilization * 100, 1) + ' %'} · netto`, `est${p.econ && !p.econ.plausible ? ' warn' : ''}`),
    tile('Touren', `${f(runs.length)}`, `${f(km, 1)} km · ${f(min / 60, 1)} h Einsatz${Object.keys(S.routed).length ? ' · Straßenrouting' : ' · Luftlinie × 1,35'}`),
  ].join('');
}
function legend() {
  const chip = (k, label, color) => `<button class="chip${S.show[k] ? ' on' : ''}" data-l="${k}"${color ? ` style="${S.show[k] ? `background:${color};color:#06121a` : `border-color:${color}`}"` : ''}>${label}</button>`;
  $('#ops-layers').innerHTML = chip('demand', 'Nachfrage') + chip('fleet', 'Flotte') + chip('spots', 'Spots') + chip('rebalance', 'Umsetzen', RUN_COLOR.rebalance) + (S.plan?.station ? chip('station', 'Stationen', RUN_COLOR.station) : '') + chip('swap', 'Akkutausch', RUN_COLOR.swap) + chip('workshop', 'Werkstatt', RUN_COLOR.workshop);
  $('#ops-legend').innerHTML = `<span><i class="sq" style="background:#49c7b0;border-color:#49c7b0"></i>Fahrtbeginne/h (${abbr('Zelle', 'Raster von etwa 250 × 250 m; Starts, Ziele und Bestand werden je Zelle gezählt')} ≈ 250 m)</span><span><i class="dot" style="background:#ef6b6b"></i>gesperrt</span><span><i class="dot" style="background:#e3b341"></i>Akku niedrig</span><span><i class="dot" style="background:#c084fc"></i>&gt; 24 h unbewegt</span><span><b class="ops-spot-mini">1</b>Spot (gestrichelt = Rang unsicher)</span><span><b class="ops-spot-mini" style="background:var(--fg)">D</b>Depot</span>`;
}
function drawMap(fit) {
  const p = S.plan; if (!p) return;
  legend();
  for (const k in S.layers) S.layers[k].clearLayers();
  const Lx = S.layers, f = X.fmt, esc = X.esc;
  if (S.show.demand) {
    const vals = [...p.model.cells.values()].map(c => c.startsPerHour || 0).filter(x => x > 0).sort((a, b) => a - b);
    const q = (x) => { let i = 0; while (i < vals.length && vals[i] < x) i++; return vals.length ? i / vals.length : 0; };
    for (const c of p.model.cells.values()) {
      if (!(c.startsPerHour > 0)) continue;
      const t = q(c.startsPerHour);
      L.rectangle([[c.lat - O.CELL_LAT / 2, c.lon - O.CELL_LON / 2], [c.lat + O.CELL_LAT / 2, c.lon + O.CELL_LON / 2]], { weight: 0, fillColor: '#49c7b0', fillOpacity: 0.06 + 0.5 * t })
        .bindPopup(`<b>Zelle ${esc(c.cell)}</b><br>${f(c.startsPerHour, 2)} Fahrtbeginne/h (Markt) · ${f(c.endsPerHour, 2)} Ziele/h<br>Ø ${f(c.supplyAvg, 1)} verfügbare Fahrzeuge`).addTo(Lx.demand);
    }
  }
  if (S.show.fleet) {
    for (const v of p.fleet.vehicles) {
      const col = v.disabled ? '#ef6b6b' : v.battery != null && v.battery < num('#ops-swapthr', 25) ? '#e3b341' : (v.idleMin ?? 0) >= 1440 ? '#c084fc' : X.opColor(v.operator);
      const plain = col === X.opColor(v.operator);
      L.circleMarker([v.lat, v.lon], { radius: plain ? 2.5 : 3.5, weight: 0, fillColor: col, fillOpacity: plain ? .4 : .95 }).bindPopup(`<b>${esc(v.operator)}</b> · ${esc(X.TYPE[v.type] || v.type)}<br>${v.disabled ? 'gesperrt · ' : v.reserved ? 'reserviert · ' : ''}${v.battery != null ? `Akku ${f(v.battery)} % · ` : ''}${v.idleMin != null ? `steht seit ${f(v.idleMin / 60, 1)} h` : ''}`).addTo(Lx.fleet);
    }
    for (const s of p.fleet.stations) L.circleMarker([s.lat, s.lon], { radius: 5, weight: 2, color: X.opColor(s.operator), fillColor: s.bookable ? X.opColor(s.operator) : 'transparent', fillOpacity: .6 }).bindPopup(`<b>${esc(s.name || 'Station')}</b><br>${f(s.bookable)} buchbar · ${s.docks != null ? `${f(s.docks)} frei` : ''}${s.capacity ? ` · Kapazität ${f(s.capacity)}` : ''}`).addTo(Lx.fleet);
  }
  if (S.show.spots) {
    const needBy = new Map(p.rebalance.needs.map(n => [n.cell, n]));
    for (const s of p.spots.spots) {
      const n = needBy.get(s.cell);
      L.circle([s.lat, s.lon], { radius: 150, weight: 1, color: '#49c7b0', fill: false, dashArray: s.stabilityLabel === 'stabil' ? null : '4 4' }).addTo(Lx.spots);
      L.marker([s.lat, s.lon], { icon: L.divIcon({ className: `ops-spot${s.stabilityLabel === 'stabil' ? '' : ' weak'}`, html: `${s.rank}`, iconSize: [24, 24] }) })
        .bindPopup(`<b>Spot ${s.rank}</b>${s.park ? ` · ${esc(parkLabel(s.park))}` : ''}<br>Ziel ${f(s.target)} Fzg. · vorhanden ${f(n?.have)} · fehlen ${f(n?.need)}<br>${f(s.startsPerHourOp, 2)} Fahrtbeginne/h (Anbieter) · Score ${f(s.score, 2)} · Stabilität ${p.model.hours < 24 ? 'vorläufig' : s.stabilityLabel}`).addTo(Lx.spots);
    }
  }
  for (const r of allRuns()) {
    if (!S.show[r.kind]) continue;
    const geo = S.routed[r.id]?.coords || [[p.depot.lat, p.depot.lon], ...r.stops.map(s => [s.lat, s.lon]), [p.depot.lat, p.depot.lon]];
    L.polyline(geo, { color: RUN_COLOR[r.kind], weight: 3, opacity: .85, dashArray: S.routed[r.id] ? null : '6 5' }).bindPopup(runTitle(r)).addTo(Lx[r.kind]);
    r.stops.forEach((s, i) => L.circleMarker([s.lat, s.lon], { radius: 5, weight: 2, color: RUN_COLOR[r.kind], fillColor: s.type === 'drop' ? RUN_COLOR[r.kind] : '#ffffff', fillOpacity: 1 })
      .bindTooltip(`${r.id}·${i + 1} ${STOP_LABEL[s.type]} ${s.count}`, { direction: 'top' }).addTo(Lx[r.kind]));
  }
  L.marker([p.depot.lat, p.depot.lon], { icon: L.divIcon({ className: 'ops-spot depot', html: 'D', iconSize: [24, 24] }) }).bindPopup('Depot · „Depot setzen“ und auf die Karte klicken, um es zu verschieben').addTo(Lx.depot);
  if (fit) {
    const pts = p.spots.spots.length ? [...p.spots.spots.map(s => [s.lat, s.lon]), [p.depot.lat, p.depot.lon]] : p.fleet.vehicles.map(v => [v.lat, v.lon]);
    if (pts.length) S.map.fitBounds(L.latLngBounds(pts).pad(0.08));
  }
  $('#ops-map-sub').textContent = `${X.muniName(p.ags)} · ${p.op} · ${p.band === 'day' ? 'ganzer Tag' : O.BANDS[p.band].label}`;
}
const parkLabel = (pk) => ({ station: 'Station des Anbieters (Pflicht-Abstellzone)', escooter: 'E-Scooter-Stellfläche', official: 'amtliche Abstellfläche', sharing: 'Sharing-/Mobilitätspunkt', rad: 'Radabstellanlage' }[pk.cat] || pk.cat) + (pk.name ? ` „${pk.name}“` : '');
const runTitle = (r) => `<b>${r.id} · ${RUN_LABEL[r.kind]}</b> · ${X.fmt(r.vehicles)} Fzg. · ${X.fmt(r.km, 1)} km · ${X.fmt(r.totalMin)} min`;
function renderRuns() {
  const p = S.plan, f = X.fmt, esc = X.esc;
  const block = (kind, plan, head) => {
    const runs = plan?.runs || [];
    if (!plan) return '';
    const body = runs.length ? runs.map(r => {
      const pts = [p.depot, ...r.stops, p.depot]; const links = O.mapsLinks(pts);
      return `<div class="card ops-run" style="border-left:3px solid ${RUN_COLOR[kind]}"><b>${r.id} · ${f(r.vehicles)} Fzg. · ${f(r.stops.length)} Stopps</b>
        <p>${f(r.km, 1)} km · ${f(r.driveMin)} min Fahrt + ${f(r.handleMin)} min vor Ort = <b>${f(r.totalMin)} min</b>${S.routed[r.id] ? ' · Straße' : ''}</p>
        <details><summary>Stoppliste</summary><ol class="small">${r.stops.map(s => `<li>${STOP_LABEL[s.type]} ${f(s.count)}${s.station ? ` · ${esc(s.station)} (${esc(s.fill)})` : ''}${s.spotRank ? ` · Spot ${s.spotRank}` : ''}${s.battery?.length ? ` · Akku ${s.battery.slice(0, 6).join('/')} %` : ''}${s.idleMaxH ? ` · steht ${f(s.idleMaxH)} h` : ''}</li>`).join('')}</ol></details>
        <div class="foot"><button class="chip" data-fit="${r.id}">Auf Karte</button> ${links.map((u, i) => `<a href="${u}" target="_blank" rel="noopener" title="Google Maps erlaubt höchstens 10 Punkte je Route">${links.length > 1 ? `Route Teil ${i + 1} von ${links.length}` : 'Route'} ↗</a>`).join(' · ')}</div></div>`;
    }).join('') : '<div class="muted small">Keine Tour nötig.</div>';
    return `<h3 style="margin-top:12px">${RUN_LABEL[kind]}</h3><div class="sub">${head}</div><div class="cards" style="grid-template-columns:1fr">${body}</div>`;
  };
  const rb = p.rebalance, sw = p.swaps, ws = p.workshop, sb = p.station;
  $('#ops-runs').innerHTML =
    (S.plan.fleet.vehicles.length ? '' : '<div class="note">Stationsbasierte Flotte: keine frei abgestellten Fahrzeuge, deshalb keine Deploy-Spots. Ausgleich zwischen Stationen unten.</div>') +
    block('rebalance', rb, `${f(rb.moves)} Umsetzungen aus ${f(rb.surplus)} Überschuss-Fahrzeugen${rb.missing > 0 ? ` · ${f(rb.missing)} Plätze bleiben offen (kein Überschuss in ${f(4)} km)` : ''}${rb.unplanned ? ` · ${f(rb.unplanned)} über Tourenlimit` : ''}`) +
    (sb ? block('station', sb, `${f(sb.empty)} fast leere, ${f(sb.full)} fast volle von ${f(sb.stations)} Stationen · ${f(sb.moves)} Räder umverteilen`) : '') +
    block('swap', sw, sw.below ? `${f(sw.below)} Fahrzeuge unter ${num('#ops-swapthr', 25)} % · priorisiert nach Ladestand und Nachfrage am Standort${sw.unplanned ? ` · ${f(sw.unplanned)} offen` : ''}` : 'Kein Fahrzeug unter der Schwelle oder kein Ladestand im Feed.') +
    block('workshop', ws, ws.disabled ? `${f(ws.disabled)} gesperrte Fahrzeuge, längste Sperre zuerst` : 'Keine gesperrten Fahrzeuge.');
}
function renderSpots() {
  const p = S.plan, f = X.fmt, esc = X.esc;
  const needBy = new Map(p.rebalance.needs.map(n => [n.cell, n]));
  const prelim = p.model.hours < 24; // Sensitivität über wenige Messstunden ist nicht aussagekräftig
  $('#ops-spots-sub').innerHTML = esc(`${p.spots.candidates} Kandidatenzellen · Faktoren ${p.spots.activeFactors.map(k => O.AHP.labels[k]).join(', ')} · ${p.np.geoms.length} Abstellverbots-${p.np.mandatory.length ? ` und ${p.np.mandatory.length} Pflicht-Abstell-` : ''}Polygone aus ${p.np.files} Zonenfeed${p.np.files === 1 ? '' : 's'}${p.wfs ? ` · ${f(p.wfs.points.length)} amtliche Abstellflächen` : ''}${p.osm ? ` · OSM: ${f(p.osm.parking.length)} Abstellflächen, ${f(p.osm.transit.length)} Haltepunkte` : ''}`) +
    (prelim ? `<br><span class="warn-text">Stabilität erst ab 24 Messstunden aussagekräftig (bisher ${f(p.model.hours, 1)} h).</span>` : '');
  const bar = (x) => `<span class="bar" style="display:inline-block;width:38px;vertical-align:middle"><i style="width:${Math.round((x ?? 0) * 100)}%"></i></span>`;
  const F = { N: 'Nachfrage (Starts/h)', U: 'Unterversorgung (Starts/h ÷ Bestand)', Ö: 'ÖPNV-Nähe (Haltepunkte ≤ 200 m)', A: 'Abstellfläche in der Nähe' };
  const fac = (x, l) => `${bar(x)} <abbr title="${F[l]}: ${f((x ?? 0) * 100)} %">${l}</abbr>`;
  $('#ops-spots tbody').innerHTML = p.spots.spots.map(s => { const n = needBy.get(s.cell); const k = geoKey(s.lat, s.lon); const g = s.rank <= GEO_TOP ? GEO.get(k) : undefined;
    const osm = `<a href="https://www.openstreetmap.org/?mlat=${s.lat.toFixed(5)}&mlon=${s.lon.toFixed(5)}#map=18/${s.lat.toFixed(5)}/${s.lon.toFixed(5)}" target="_blank" rel="noopener" class="mono" title="Auf OpenStreetMap öffnen">${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}</a>`;
    const place = s.park ? esc(parkLabel(s.park)) : 'Zellmitte';
    const main = s.rank > GEO_TOP ? place : `<span class="geo-main" data-geo="${k}" data-fallback="${place}">${g ? esc(g) : g === null ? place : '<span class="muted">Adresse wird gesucht …</span>'}</span>`;
    return `<tr><td class="n">${s.rank}</td><td>${main}<div class="sub-line">${osm}${s.rank <= GEO_TOP ? ` · ${place}` : ''}</div></td>
    <td class="n"><b>${f(s.target)}</b></td><td class="n">${f(n?.have)}</td><td class="n" style="color:var(--${n?.need ? 'warn' : 'muted'})">${f(n?.need)}</td>
    <td class="n">${f(s.startsPerHourOp, 2)}<div class="sub-line">Markt ${f(s.startsPerHour, 2)}</div></td><td class="n">${f(s.supplyAvg, 1)}</td><td class="n">${f(s.score, 2)}</td>
    <td class="small" style="white-space:nowrap">${fac(s.factors.demand, 'N')} ${fac(s.factors.underserved, 'U')}${p.spots.activeFactors.includes('transit') ? ` ${fac(s.factors.transit, 'Ö')}` : ''}${p.spots.activeFactors.includes('parking') ? ` ${fac(s.factors.parking, 'A')}` : ''}</td>
    <td>${prelim ? '<span class="pill prelim" title="Stabilität erst ab 24 Messstunden aussagekräftig">vorläufig</span>' : `<span class="pill ${s.stabilityLabel === 'stabil' ? 'live' : s.stabilityLabel === 'mittel' ? 'delayed' : 'stale'}">${s.stabilityLabel}</span>`}<div class="sub-line">${f(s.stability * 100)} % der Varianten</div></td></tr>`; }).join('') || '<tr><td colspan="10" class="empty"><b>Keine Spots: zu wenig Nachfrage gemessen.</b>Unter „Parameter“ einen längeren Zeitraum bei „Nachfrage aus“ wählen.</td></tr>';
  queueGeo(p.spots.spots.slice(0, GEO_TOP));
}
// Straße/Stadtteil für die Top-Spots per Nominatim (OSM): im Hintergrund, höchstens 1 Anfrage/s, Cache im Speicher
const GEO = new Map(), GEO_TOP = 20; const geoQueue = []; let geoBusy = false;
const geoKey = (lat, lon) => `${lat.toFixed(4)},${lon.toFixed(4)}`;
function geoText(j) {
  const a = j?.address || {};
  const street = a.road || a.pedestrian || a.footway || a.square || a.path || a.cycleway || a.place || j?.name || null;
  const area = a.suburb || a.city_district || a.quarter || a.neighbourhood || a.village || a.town || null;
  return [street, area].filter(Boolean).join(' · ') || null;
}
function queueGeo(spots) {
  for (const s of spots) { const k = geoKey(s.lat, s.lon); if (!GEO.has(k) && !geoQueue.some(q => q.k === k)) geoQueue.push({ k, lat: s.lat, lon: s.lon }); }
  pumpGeo();
}
async function pumpGeo() {
  if (geoBusy) return; geoBusy = true;
  try {
    while (geoQueue.length) {
      const q = geoQueue.shift(); if (GEO.has(q.k)) continue;
      const r = await X.getJson(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&lat=${q.lat.toFixed(6)}&lon=${q.lon.toFixed(6)}&accept-language=de`, { timeout: 15000 });
      GEO.set(q.k, r.ok ? geoText(r.json) : null);
      document.querySelectorAll(`[data-geo="${q.k}"]`).forEach(el => { const t = GEO.get(q.k); el.textContent = t || el.dataset.fallback || 'Zellmitte'; });
      if (geoQueue.length) await new Promise(res => setTimeout(res, 1100)); // Nominatim-Nutzungsregel: höchstens 1 Anfrage je Sekunde
    }
  } finally { geoBusy = false; }
}
async function routeRuns() {
  const p = S.plan; const runs = allRuns().filter(r => S.show[r.kind]);
  let n = 0;
  for (const r of runs) {
    if (S.plan !== p) return;
    const pts = [p.depot, ...r.stops, p.depot];
    if (pts.length > 90) continue;
    status(`${$('#ops-status').textContent.split(' · Straßenrouting')[0]} · Straßenrouting ${++n}/${runs.length} …`);
    const u = `https://router.project-osrm.org/route/v1/driving/${pts.map(x => `${x.lon.toFixed(5)},${x.lat.toFixed(5)}`).join(';')}?overview=simplified&geometries=geojson`;
    const j = (await X.getJson(u, { timeout: 30000 })).json;
    if (j?.code === 'Ok') { const rt = j.routes[0]; S.routed[r.id] = { coords: rt.geometry.coordinates.map(([lo, la]) => [la, lo]) }; r.km = +(rt.distance / 1000).toFixed(1); r.driveMin = Math.round(rt.duration / 60); r.totalMin = r.driveMin + r.handleMin; }
    await new Promise(res => setTimeout(res, 1100)); // Demo-Server: höchstens eine Anfrage je Sekunde
  }
  if (S.plan === p) { status($('#ops-status').textContent.split(' · Straßenrouting')[0] + ` · Straßenrouting OSRM für ${Object.keys(S.routed).length} Touren`); renderTiles(); renderRuns(); drawMap(false); }
}
function renderMethod() {
  const A = O.AHP, f = (x) => x < 1 ? `1/${Math.round(1 / x)}` : String(x);
  $('#ops-method').innerHTML = `<h2>Methode</h2>
  <h3>Nachfrage</h3><p>Fahrtbeginne je Zelle (≈ 250 m) und Tageszeit-Band aus dem Verschwinden verfügbarer Fahrzeuge zwischen zwei Sammler-Läufen, über alle Anbieter (Markt). Rate = Starts ÷ Messstunden im Band; Bestand = Ø verfügbare Fahrzeuge je Lauf. Der Anbieter bekommt seinen aktuellen Anteil am verfügbaren Bestand der Gemeinde. Zellen mischen Fahrzeugarten.</p>
  <h3>Deploy-Spots (MCDA)</h3><p>Faktoren auf 0–1 standardisiert (95. Perzentil als Obergrenze): <b>Nachfrage</b> (Starts/h), <b>Unterversorgung</b> (Starts/h ÷ (Bestand + 0,5)), <b>ÖPNV-Nähe</b> (Haltepunkte ≤ 200 m, 3 = voll), <b>Abstellfläche</b> (E-Scooter-Stellfläche, amtliche Fläche oder Sharing-Punkt ≤ 160 m = 1, Radabstellanlage ≤ 80 m = 0,5). Der Spot rastet auf die Fläche ein. Abstellverbote aus den GBFS-Zonen des Anbieters sind ein Ausschluss, kein Gewicht. In Pflicht-Abstellzonen (GBFS <span class="mono">station_parking</span>, z. B. Dott Leipzig) rastet der Spot auf die nächste Station des Anbieters (≤ 150 m) ein, ohne Station fällt die Zelle weg. Mindestabstand zwischen Spots, Ziel = Starts/h × Anteil × Horizont (2–15 Fzg.).</p>
  <div class="tbl"><table><thead><tr><th>AHP</th>${A.criteria.map(c => `<th class="n">${A.labels[c]}</th>`).join('')}<th class="n">Gewicht</th></tr></thead><tbody>${A.criteria.map((c, i) => `<tr><td>${A.labels[c]}</td>${A.matrix[i].map(x => `<td class="n mono">${f(x)}</td>`).join('')}<td class="n mono"><b>${A.weights[c].toFixed(3)}</b></td></tr>`).join('')}</tbody></table></div>
  <p class="small">Saaty-Skala, Eigenvektor-Gewichte, Konsistenzquote CR = ${A.cr.toFixed(3)} (&lt; 0,10). Fehlt ein Faktor (z. B. OSM nicht erreichbar), wird er ausgelassen und die übrigen Gewichte neu normiert. <b>Sensitivität:</b> jedes Gewicht ±20 %, neu normiert; „stabil“ = Spot bleibt in allen Varianten in der Auswahl, „mittel“ ≥ 75 %, sonst „unsicher“.</p>
  <h3>Touren</h3><p><b>Umsetzen:</b> Überschuss sind Fahrzeuge über dem erwarteten Bedarf ihrer Zelle im Horizont, Fahrzeuge über 24 h unbewegt und überzählige an Spots; Akku unter 30 % wird nicht umgesetzt, sondern getauscht. Zuordnung nach Spot-Rang zum nächsten Überschussfahrzeug (≤ 4 km), Bündelung nach Transporterkapazität, erst einsammeln, dann ausbringen. <b>Akkutausch:</b> Priorität = 0,6 × Ladestand-Lücke + 0,4 × Nachfrage am Standort. <b>Werkstatt:</b> gesperrte Fahrzeuge, längste Sperre zuerst. <b>Stationen:</b> Füllgrad ≤ 20 % aus Stationen ≥ 80 % auf 50 % auffüllen. Reihenfolge je Tour: Nächster Nachbar mit mehreren Starts, 2-opt, Or-opt. Fahrzeit ohne Straßenrouting: Luftlinie × 1,35 bei 18 km/h; mit „Straßenrouting“ OSRM (Demo-Server, ohne Verkehr). Vor-Ort-Zeiten: 1,5 min abholen, 1 min ausbringen, 2,5 min Akku, 3 min Werkstatt.</p>
  <h3>Grenzen</h3><p>Standzeit zählt ab der ersten Sichtung durch den Sammler. Anbieter mit wechselnden Kennungen erzeugen mehr Starts und Ziele als echte Fahrten; bei ihnen ist die Nachfrage relativ zu lesen. Unterdrückte Nachfrage (niemand findet ein Fahrzeug) wird nicht gemessen, die Unterversorgung fängt sie nur teilweise auf. Abstellflächen und Haltepunkte aus OpenStreetMap sind so vollständig wie die Karte.</p>`;
}
