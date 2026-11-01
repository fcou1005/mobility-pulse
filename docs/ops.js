// Mobility Pulse — Disposition: Deploy-Spots, Umsetz-, Akkutausch-, Werkstatt- und Stationstouren im Browser.
import * as O from './pulse-ops.js?v=mvy5xgdj';
import { t, tMap, lang, dateFmt, fmtLocale } from './i18n.js?v=mvy5xgdj';

let X; // Kontext aus app.js: state, CFG, getJson, esc, fmt, opColor, muniName, notice, clearNotice, loadBoundaries, loadUsageIndex, loadCells, loadOnce, loadGroups, TYPE
const $ = (s, el = document) => el.querySelector(s);
const S = { map: null, layers: {}, canvas: {}, spotMarkers: [], ops: {}, osm: {}, wfs: {}, zones: {}, depot: {}, pickDepot: false, plan: null, routed: {}, show: { demand: true, official: true, fleet: true, spots: true, groups: true, collect: false, rebalance: true, swap: false, workshop: false, station: true }, busy: false, retry: false, pending: null, again: false, rescore: null, stale: false, routing: null, op: null, focus: null,
  // Gruppen-Monatsdateien (groups/<JJJJ-MM>.json) und Ströme (flows/<Tag>.json): fertige Monate/Tage bleiben gecacht; index und laufender Monat werden bei neuem Stand neu geladen
  gidx: undefined, gdocs: {}, flowsIdx: undefined, flowDocs: {}, gf: null };
const RUN_COLOR = { rebalance: '#60a5fa', swap: '#34d399', workshop: '#ef6b6b', station: '#f59e0b' };
const RUN_KINDS = Object.keys(RUN_COLOR);
// Rechenschritte entkoppeln, damit Status gezeichnet wird und die Seite zwischen den Schritten reagiert
const tick = () => globalThis.scheduler?.yield ? scheduler.yield() : new Promise(r => setTimeout(r, 0));
const RUN_LABEL = { get rebalance() { return t('ops.rebalance'); }, get swap() { return t('ops.batterySwap'); }, get workshop() { return t('ops.workshop'); }, get station() { return t('ops.stationBalancing'); } };
const STOP_LABEL = { get pickup() { return t('ops.pickUp'); }, get drop() { return t('ops.dropOff'); }, get swap() { return t('ops.swapBattery'); }, get pickup_disabled() { return t('ops.pickUpDefective'); } };
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
const hhmm = () => new Date().toLocaleTimeString(fmtLocale(), { hour: '2-digit', minute: '2-digit' });
// Tageszeit-Bänder (lib/pulse-track.js BANDS, Kennung 0–5) und Stabilität (lib/pulse-ops.js stabilityLabel) in der Sprache der Seite
const bandLabel = (id) => t(`band.${id}`);
const STAB = tMap('stab', { stabil: 1, mittel: 1, unsicher: 1 });
const AHP_L = tMap('factor', O.AHP.labels);
// Faktor-Kürzel der Spot-Tabelle: intern Δ, N, Ö, A; angezeigt je Sprache (EN: Δ, D, T, P)
const FL = (l) => t(`factor.letter.${{ 'Δ': 'outflow', N: 'demand', Ö: 'transit', A: 'parking' }[l]}`);
function fillBands() {
  const sel = $('#ops-band'), v = sel.value;
  sel.innerHTML = `<option value="auto">${t('ops.now', { label: bandLabel(BAND_NOW()) })}</option>` + O.BANDS.map(b => `<option value="${b.id}">${t('ops.text', { label: bandLabel(b.id), from: b.from, to: b.to })}</option>`).join('') + `<option value="day">${t('ops.wholeDay')}</option>`;
  if (v && [...sel.options].some(o => o.value === v)) sel.value = v;
}

export function initOps(ctx) {
  X = ctx;
  fillBands();
  $('#ops-run').addEventListener('click', () => computePlan());
  $('#ops-op').addEventListener('change', (e) => { S.op = e.target.value; computePlan(); });
  ['#ops-type', '#ops-band', '#ops-days'].forEach(id => $(id).addEventListener('change', () => computePlan()));
  $('#ops-depot').addEventListener('click', () => { S.pickDepot = !S.pickDepot; $('#ops-depot').classList.toggle('primary', S.pickDepot); status(S.pickDepot ? t('ops.clickOnMapToSetDepot') : ''); });
  $('#ops-layers').addEventListener('click', (e) => {
    const j = e.target.closest('[data-jump]'); if (j) { const el = $(`#${j.dataset.jump}`)?.closest('.panel') || $(`#${j.dataset.jump}`); if (!el) return; el.tabIndex = -1; el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'start' }); return; }
    const b = e.target.closest('[data-l]'); if (!b || !S.plan) return; const k = b.dataset.l; S.show[k] = !S.show[k]; legend();
    if (RUN_COLOR[k]) drawRoutes(); else drawLayers([k]); // nur die umgeschaltete Ebene neu, alle anderen Marker bleiben stehen
  });
  // Klick auf Tourkarte oder „Auf Karte“: nur diese Tour zeichnen und einpassen; Links bleiben Links
  $('#ops-runs').addEventListener('click', (e) => { if (e.target.closest('a')) return; const c = e.target.closest('[data-run]'); if (c && S.plan) focusRun(c.dataset.run); });
  $('#ops-runs-all').addEventListener('click', () => { S.focus = null; markFocus(); drawRoutes(); fitAll(); });
  $('#ops-csv-spots').addEventListener('click', () => S.plan && download(`spots_${slug()}.csv`, O.spotsCsv(S.plan.spots.spots, { name: X.muniName(S.plan.ags) }), 'text/csv'));
  $('#ops-csv-analysis').addEventListener('click', () => S.plan && download(`${t('file.spotsAnalysis')}_${slug()}.csv`, '﻿' + O.spotsAnalysisCsv(S.plan.spots.spots, S.plan.rebalance.needs, { horizonH: S.plan.params.horizonH, prelim: S.plan.spots.prelim, lang: lang() }), 'text/csv'));
  $('#ops-csv-runs').addEventListener('click', () => S.plan && download(`${t('file.runs')}_${slug()}.csv`, '﻿' + O.runsCsv(allRuns(), S.plan.depot, lang()), 'text/csv'));
  $('#ops-geojson').addEventListener('click', () => S.plan && download(`plan_${slug()}.geojson`, JSON.stringify(O.planGeoJson(S.plan.spots.spots, allRuns(), S.plan.depot)), 'application/geo+json'));
  document.addEventListener('click', (e) => { const a = e.target.closest('.ops-pick'); if (!a) return; e.preventDefault(); $('#sel-scope').value = a.dataset.ags; $('#sel-scope').dispatchEvent(new Event('change')); setTimeout(() => { location.hash = '#ops'; renderOps(); }, 0); });
  // OSM erneut versuchen (nach Ausfall gilt sonst 10 Min. Pause)
  document.addEventListener('click', (e) => { if (!e.target.closest('#ops-osm-retry')) return; const ags = S.plan?.ags || X.state.scope; delete S.osm[ags]; $('#ops-warn').innerHTML = ''; computePlan(); });
  document.addEventListener('click', (e) => { if (e.target.closest('#ops-retry')) { S.retry = true; computePlan(); } });
  // Einsatzzeit je Tour: Feld in den Parametern ergänzen, solange index.html es nicht selbst führt
  if (!$('#ops-maxh')) { const l = document.createElement('label'); l.innerHTML = `${t('ops.timePerRunH')}<input type="number" id="ops-maxh" value="4" min="1" max="12" step="0.5">`; ($('#ops-maxruns')?.closest('label') || $('#ops-swapthr')?.closest('label'))?.after(l); }
  injectStyle(); $('#ops-spots thead').innerHTML = spotHead(); initGroupsUi();
  renderMethod();
}
// Stile für Spaltenfilter, sortierbare Köpfe und den Umschalter Ausbringen/Einsammeln (index.html bleibt unverändert)
function injectStyle() {
  if ($('#ops-style')) return;
  const st = document.createElement('style'); st.id = 'ops-style';
  st.textContent = `.ops-gfilter{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:var(--s3);align-items:end;margin:0 0 var(--s3);container-type:inline-size}
@container (min-width:360px){.ops-gfilter .rng.dates{grid-column:span 2}}
.ops-gfilter label,.ops-gfilter .rng{display:flex;flex-direction:column;gap:var(--s1);font-size:11px;font-weight:500;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);min-width:0;margin:0;padding:0;border:0}
.ops-gfilter .rng>span:last-child{display:flex;gap:var(--s1);align-items:center;text-transform:none;letter-spacing:0;color:var(--fg-2)}
.ops-gfilter .rng input{flex:1 1 0;min-width:0;width:auto}.ops-gfilter input[type=search],.ops-gfilter select{width:100%}
.ops-gfilter input[type=date]{height:var(--ctl);background:var(--panel-2);border:1px solid var(--line-2);border-radius:var(--r-sm);padding:0 6px;font:12px var(--mono);color:var(--fg);min-width:0;color-scheme:inherit}
.ops-gfilter .ops-actions{grid-column:1/-1;justify-content:space-between}
th .th-sort{all:unset;box-sizing:border-box;cursor:pointer;display:inline-flex;gap:4px;align-items:center;font:inherit;letter-spacing:inherit;text-transform:inherit;color:inherit;border-radius:4px;min-height:24px}
th .th-sort:hover,th[aria-sort] .th-sort{color:var(--fg)}th .th-sort:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
th .th-sort i{font-style:normal;font-family:var(--mono);min-width:1ch}
.ops-gkind{display:inline-flex;gap:2px}.ops-gkind button{min-height:28px}
@media (pointer:coarse){.ops-gfilter input[type=date],th .th-sort,.ops-gkind button{min-height:44px}}`;
  document.head.appendChild(st);
}

const ascii = (tq) => String(tq).replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue').replace(/ß/g, 'ss').normalize('NFKD').replace(/[^\w-]+/g, '-');
const slug = () => `${ascii(X.muniName(S.plan.ags))}_${ascii(S.plan.op)}_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`;
function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` })); a.download = name; a.style.display = 'none'; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000); }
function status(html) { $('#ops-status').innerHTML = html; }
const allRuns = () => S.plan ? [...S.plan.rebalance.runs, ...(S.plan.station?.runs || []), ...S.plan.swaps.runs, ...S.plan.workshop.runs] : [];

function ensureMap() {
  if (S.map) { setTimeout(() => S.map.invalidateSize(), 50); return; }
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  S.map = L.map('ops-map', { preferCanvas: true, zoomAnimation: !still, fadeAnimation: !still, markerZoomAnimation: !still }).setView([51.1, 10.4], 6);
  S.tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: t('ops.openstreetmapContributors') }).addTo(S.map);
  // Eigener Canvas je Ebene: Routen neu zeichnen zeichnet nicht die (bis > 5.000) Fahrzeugpunkte und Zellen mit
  for (const k of ['demand', 'fleet', 'runs']) S.canvas[k] = L.canvas({ padding: 0.5 });
  for (const k of ['demand', 'official', 'fleet', 'spots', 'groups', 'collect', ...RUN_KINDS, 'depot']) S.layers[k] = L.featureGroup().addTo(S.map);
  for (const k of ['demand', 'fleet']) S.layers[k].on('click', openShared); // Klicks der Canvas-Marker steigen zur Gruppe auf
  S.map.on('click', (e) => { if (!S.pickDepot || !S.plan) return; S.depot[S.plan.ags] = { lat: e.latlng.lat, lon: e.latlng.lng }; S.pickDepot = false; $('#ops-depot').classList.remove('primary'); computePlan(); });
}

export async function renderOps() {
  ensureMap();
  const st = X.state;
  if (st.scope === 'DE') { showPicker(); return; }
  $('#ops-pick').hidden = true;
  if (S.busy && S.pending === st.scope) return; // läuft schon für dieses Gebiet (Gebietswechsel ruft mehrfach)
  if (!S.plan || S.plan.ags !== st.scope || S.stale) await computePlan();
}
/** Sprachwechsel: nichts neu rechnen; Formular, Kacheln, Touren, Spots, Gruppen, Karte (Legende, Marker, Popups), Methode und Status neu
 *  beschriften. Die Kartennamensnennung (Leaflet) wird ausgetauscht. */
export function relabelOps() {
  fillBands(); $('#ops-spots thead').innerHTML = spotHead();
  if (S.map && S.tiles) { const prev = S.tiles.options.attribution, next = t('ops.openstreetmapContributors'); if (prev !== next) { S.tiles.options.attribution = next; S.map.attributionControl?.removeAttribution(prev).addAttribution(next); } }
  renderMethod();
  if (!S.map) return;
  if (X.state.scope === 'DE') { showPicker(); return; }
  const p = S.plan; if (!p || S.busy || p.ags !== X.state.scope) return;
  renderWarn(p.ags, p.osm, p.np, p.official); renderTiles(); renderRuns(); renderSpots(); renderGroups(); drawMap(false); status(planStatus(p));
}
/** Nach neuem Sammler-Stand (2-Minuten-Poll in app.js, vor renderAll aufrufen): Flotte und Sammler-Umgebung neu laden, der Plan gilt
 *  als veraltet und wird beim nächsten Anzeigen der Disposition neu gerechnet. Zonen werden nach Datei und Stand (zones/index.json → at)
 *  gecacht und nur bei neuem Stand neu geladen. Overpass-Ergebnisse, die 10-Min.-Pause nach einem Overpass-Ausfall und amtliche
 *  Flächen (WFS) bleiben: sie hängen nicht am Sammler-Lauf. Fehlschläge werden ohnehin nie gecacht. */
export function resetCaches() {
  S.ops = {};
  for (const k of Object.keys(S.osm)) if (S.osm[k]?.from === 'Sammler') delete S.osm[k];
  // Gruppen: Verzeichnis und laufender (letzter) Monat neu, abgeschlossene Monate bleiben; Ströme: Verzeichnis neu, fertige Tage bleiben
  const lastM = S.gidx?.months?.slice(-1)[0]; if (lastM) delete S.gdocs[lastM];
  S.gidx = undefined; S.flowsIdx = undefined;
  if (S.plan) S.stale = true;
}
function showPicker() {
  const munis = Object.values(X.state.latest?.municipalities || {}).map(m => ({ ...m, avail: Object.values(m.operators || {}).reduce((s, o) => s + (o.available ?? o.total ?? 0), 0) })).sort((a, b) => b.avail - a.avail).slice(0, 18);
  const el = $('#ops-pick'); el.hidden = false;
  el.innerHTML = `<h2>${t('ops.chooseMunicipality')}</h2><div class="sub">${t('ops.operationsPlansPer')}</div><div class="chips">${munis.map(m => `<a href="#ops" class="chip ops-pick" data-ags="${X.esc(m.ags)}">${X.esc(m.name)} <span class="muted">${X.fmt(m.avail)}</span></a>`).join('')}</div>`;
  for (const k in S.layers) S.layers[k].clearLayers();
  $('#ops-tiles').innerHTML = ''; $('#ops-runs').innerHTML = ''; $('#ops-warn').innerHTML = ''; $('#ops-spots-sub').textContent = ''; $('#ops-spots tbody').innerHTML = `<tr><td colspan="${SPOT_COLS}" class="empty">${t('ops.noPlanYetChooseMunicipality')}</td></tr>`; status('');
  $('#ops-groups-sub').textContent = ''; $('#ops-groups tbody').innerHTML = `<tr><td colspan="${GCOLS.length}" class="empty">${t('ops.noPlanYetChooseMunicipality')}</td></tr>`; $('#ops-runs-all').hidden = true; $('#ops-gf-count').textContent = '';
}

// ---------- Daten ----------
// Dateien des Datenstands über den gemeinsamen Cache von app.js (X.getJson). Ein Netz-/Serverfehler bleibt dort 30 s gemerkt;
// nach „Erneut versuchen“ (S.retry) wird an ihm vorbei neu geladen, damit ein Fehlschlag nie den nächsten Versuch blockiert.
async function dataJson(path, opt) {
  const r = await X.getJson(X.CFG.DATA + path, opt);
  return !r.ok && S.retry && (!r.status || r.status >= 500) ? X.getJson(X.CFG.DATA + path + `?retry=${Date.now()}`, opt) : r;
}
// Fehlschläge werden nicht gecacht: der nächste Plan versucht es erneut. status 404 = Datei gibt es (noch) nicht
async function loadOpsDoc(stCode) {
  if (!(stCode in S.ops)) { const r = await dataJson(`ops/${stCode}.json`, { timeout: 90000 }); if (!r.ok) return { fleet: null, status: r.status, error: r.error }; S.ops[stCode] = O.decodeFleet(r.json); }
  return { fleet: S.ops[stCode] };
}
async function loadCellDocs(stCode, days) {
  const idx = await X.loadUsageIndex();
  const list = (idx.cellDays || []).slice(-days);
  return (await Promise.all(list.map(d => X.loadCells(d, stCode)))).filter(Boolean);
}
// Gruppen-Ereignisse aller Monate (groups/index.json → groups/<JJJJ-MM>.json); ohne Verzeichnis (älterer Datenstand, 404) groups.json.
// Fehlgeschlagene Dateien werden nicht gecacht und als Warnung gemeldet.
async function loadGroupDocs() {
  if (S.gidx === undefined) { const r = await dataJson('groups/index.json', { timeout: 30000 }); S.gidx = r.ok && Array.isArray(r.json?.months) ? r.json : r.status === 404 ? null : undefined; if (S.gidx === undefined) { const d = await X.loadGroups(); return { docs: d ? [d] : [], source: 'groups.json', months: [], failed: ['groups/index.json'] }; } }
  if (!S.gidx) { const d = await X.loadGroups(); return { docs: d ? [d] : [], source: 'groups.json', months: [], failed: [] }; }
  const months = S.gidx.months, failed = [];
  await Promise.all(months.filter(m => !S.gdocs[m]).map(async m => { const r = await dataJson(`groups/${m}.json`, { timeout: 60000 }); if (r.ok && Array.isArray(r.json?.events)) S.gdocs[m] = r.json; else failed.push(`groups/${m}.json`); }));
  return { docs: months.map(m => S.gdocs[m]).filter(Boolean), source: 'groups', months, failed, index: S.gidx };
}
// Start-Ziel-Ströme der Nachfrage-Tage (flows/<Tag>.json erst nach Tagesende, ab 02.11.2026); fehlt das Verzeichnis, gibt es keinen Beleg
async function loadFlowDocs(days) {
  if (S.flowsIdx === undefined) { const r = await dataJson('flows/index.json', { timeout: 25000 }); S.flowsIdx = r.ok ? r.json : r.status === 404 ? null : undefined; }
  const have = new Set(S.flowsIdx?.days || []), want = days.filter(d => have.has(d));
  await Promise.all(want.filter(d => !S.flowDocs[d]).map(async d => { const r = await dataJson(`flows/${d}.json`, { timeout: 60000 }); if (r.ok && Array.isArray(r.json?.flows)) S.flowDocs[d] = r.json; }));
  return { docs: want.map(d => S.flowDocs[d]).filter(Boolean), indexed: !!S.flowsIdx, published: S.flowsIdx?.days?.length || 0 };
}
// Zonen je Datei mit Stand (at aus zones/index.json): neuer Stand → neu laden; Fehlschlag wird nicht gecacht, sondern gemeldet
async function loadNoPark(ags, op, bbox) {
  const idx = await X.loadOnce('zonesIndex', 'zones/index.json');
  const list = (idx?.zones || []).filter(z => z.operator === op && (z.municipalities || []).includes(ags));
  const geoms = [], mandatory = []; let failed = 0;
  for (const { file: f, at } of list) {
    if (S.zones[f]?.at !== at) { const r = await dataJson(`zones/${f}`, { timeout: 60000 }); if (!r.ok) { failed++; continue; } S.zones[f] = { at, ...O.zoneConstraints(r.json) }; }
    for (const g of S.zones[f].noPark) if (!bbox || overlaps(g, bbox)) geoms.push(g);
    for (const g of S.zones[f].mandatory) if (!bbox || overlaps(g, bbox)) mandatory.push(g);
  }
  return { geoms, mandatory, files: list.length, failed, indexFailed: !idx };
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
        const ctrl = new AbortController(); const tq = setTimeout(() => ctrl.abort(), 100000);
        const r = await fetch(ep, { method: 'POST', body: new URLSearchParams({ data: q }), signal: ctrl.signal }); clearTimeout(tq);
        if (!r.ok) continue; const j = await r.json(); if (!Array.isArray(j?.elements) || j.remark) continue;
        S.osm[ags] = { state: 'ok', from: new URL(ep).host, at: Date.now(), parking: O.parkingFromOsm(j.elements), transit: O.transitFromOsm(j.elements) };
        onDone(); return;
      } catch { /* nächster Spiegel */ }
    }
    S.osm[ags] = { state: 'fail', at: Date.now() }; onDone();
  })();
}
// Amtliche Daten der Stadt aus catalog.parking_reference (data/sources-manual.json → sources.json): je Eintrag ags, kind
// ('parking' = Abstellflächen, Standard; 'noPark' = Abstellverbotszonen), Quelle per wfs (+ typeNames), url (GeoJSON) oder
// ckan + dataset (Open-Data-Portal, Ressource GeoJSON/WFS), dazu name, license, source. Erfolg wird je Eintrag gecacht, Fehler nie.
async function fetchOfficial(ref) {
  let url = ref.wfs ? O.wfsGetFeatureUrl(ref.wfs, ref.typeNames) : ref.url || null;
  if (!url && ref.ckan && ref.dataset) {
    const r = await X.getJson(`${ref.ckan.replace(/\/$/, '')}/api/3/action/package_show?id=${encodeURIComponent(ref.dataset)}`, { timeout: 30000 });
    if (!r.ok) return { ok: false, error: r.status ? t('ops.portalHttp', { status: r.status }) : t('ops.portal', { error: r.error }) };
    const res = O.pickCkanResource(r.json, ref.typeNames); if (!res) return { ok: false, error: t('ops.datasetWithoutGeojsonWfs') };
    url = res.url;
  }
  if (!url) return { ok: false, error: t('ops.noAddressInCatalogue') };
  const r = await X.getJson(url, { timeout: 45000 });
  if (!r.ok) return { ok: false, error: r.status ? `HTTP ${r.status}` : r.error === t('common.netCors') ? t('ops.networkCorsServerDoesNot') : r.error };
  const fc = O.lonLatFc(r.json); if (fc.projected) return { ok: false, error: t('ops.coordinatesNotInWgs84Epsg') };
  return ref.kind === 'noPark' ? { ok: true, geoms: O.noParkFromFc(fc), n: fc.features.length } : { ok: true, points: O.parkingFromWfs(fc, 'official'), n: fc.features.length };
}
async function officialData(ags) {
  const refs = Object.entries(X.state.catalog?.parking_reference || {}).filter(([k, r]) => !k.startsWith('_') && r?.ags === ags);
  if (!refs.length) return null;
  const out = { points: [], noPark: [], sources: [], failed: [] };
  const got = await Promise.all(refs.map(async ([key, ref]) => { if (!S.wfs[key]) { const d = await fetchOfficial(ref); if (!d.ok) return [ref, d]; S.wfs[key] = d; } return [ref, S.wfs[key]]; }));
  for (const [ref, d] of got) {
    if (!d.ok) { out.failed.push({ ref, error: d.error }); continue; }
    if (ref.kind === 'noPark') out.noPark.push(...d.geoms); else out.points.push(...d.points);
    out.sources.push({ ref, n: ref.kind === 'noPark' ? d.geoms.length : d.points.length });
  }
  return out;
}
const refLabel = (ref) => ref.name || (ref.kind === 'noPark' ? t('ops.officialNoParkingZones') : t('ops.officialParkingAreas'));
const refCite = (ref) => `${ref.source ? `<a href="${X.esc(ref.source)}" target="_blank" rel="noopener">${X.esc(refLabel(ref))}</a>` : X.esc(refLabel(ref))}${ref.license ? ` (${X.esc(ref.license)}${ref.attribution ? `, ${X.esc(ref.attribution)}` : ''})` : ''}`;
// Sichtbare Warnungen zu fehlenden Kontextdaten (statt stillem Weiterrechnen)
function renderWarn(ags, osm, np, official, groupRes = S.plan?.groupSrc) {
  const w = [];
  if (groupRes?.failed?.length) w.push(`<div class="note warn" role="alert">${t('ops.groupEventsIncompleteNot', { v0: groupRes.failed.map(x => `<span class="mono">${X.esc(x)}</span>`).join(', '), v1: groupRes.source === 'groups.json' ? t('ops.onlyFromGroupsJson30Days') : t('ops.withoutTheseMonths') })} <button class="chip" id="ops-retry">${t('ops.tryAgain')}</button></div>`);
  if ($('#ops-osm').checked && !osm && S.osm[ags]?.state === 'fail') w.push(`<div class="note warn" role="alert">${t('ops.openstreetmapNotReachable')} <button class="chip" id="ops-osm-retry">${t('ops.tryAgain')}</button></div>`);
  if (np?.indexFailed) w.push(`<div class="note warn" role="alert">${t('ops.zoneDirectoryNotLoadedZones')} <button class="chip" id="ops-retry">${t('ops.tryAgain')}</button></div>`);
  else if (np?.failed) w.push(`<div class="note warn" role="alert">${t('ops.zonesNotLoadedOfZoneFeeds', { failed: X.fmt(np.failed), files: X.fmt(np.files) })} <button class="chip" id="ops-retry">${t('ops.tryAgain')}</button></div>`);
  for (const { ref, error } of official?.failed || []) w.push(`<div class="note warn" role="alert">${t('ops.notLoadedSpots', { refLabel: X.esc(refLabel(ref)), error: X.esc(error), v2: ref.kind === 'noPark' ? t('ops.withoutCitySNoParkingZones') : t('ops.withoutTheseParkingAreas') })} <button class="chip" id="ops-retry">${t('ops.tryAgain')}</button></div>`);
  $('#ops-warn').innerHTML = w.join('');
}

// ---------- Plan ----------
async function computePlan() {
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
    const [fleetRes, cellDocs] = await Promise.all([loadOpsDoc(stCode), loadCellDocs(stCode, +$('#ops-days').value || 3)]);
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
    $('#ops-op').innerHTML = ops.map(([o, n]) => `<option value="${X.esc(o)}"${o === op ? ' selected' : ''}>${X.esc(o)} · ${n ? t('ops.veh', { n: X.fmt(n) }) : t('ops.stations')}</option>`).join('');
    const vehicles = inMuni.filter(v => v.operator === op && (type === 'all' || v.type === type));
    const stations = stInMuni.filter(s => s.operator === op);
    const marketAvail = inMuni.filter(v => O.isAvailable(v) && (type === 'all' || v.type === type)).length;
    const opAvail = vehicles.filter(O.isAvailable).length;
    const share = marketAvail ? opAvail / marketAvail : 1;
    // Nachfrage
    const bandSel = $('#ops-band').value; let band = bandSel === 'auto' ? BAND_NOW() : bandSel === 'day' ? 'day' : +bandSel;
    let model = O.buildDemandModel(cellDocs, ags, band), bandNote = '';
    if (model.hours < 0.5 && band !== 'day') { const m2 = O.buildDemandModel(cellDocs, ags, 'day'); if (m2.hours > 0) { bandNote = t('ops.noMeasurementForYet', { label: bandLabel(band) }); model = m2; band = 'day'; } }
    if (!model.cells.size || model.hours <= 0) { status(t('ops.thereIsNoDemandMeasurement')); emptyPlan(t('ops.noDemandMeasurementForThis')); drawFleetOnly(vehicles, stations); return; }
    // Kontext
    const b = (await X.loadBoundaries(), st.boundaries?.features.find(f => f.properties.ags === ags)?.bbox) || null;
    const spacing = num('#ops-spacing', 220), topN = Math.min(60, num('#ops-n', 20)), horizonH = num('#ops-horizon', 3);
    status(t('ops.loadingZonesAndSurroundings'));
    const pre = O.scoreSpots(model, { topN: Math.min(80, topN * 3), minSpacingM: spacing * 0.6 });
    const useOsm = $('#ops-osm').checked;
    const [np, ctxDoc, official, groupRes, flowRes] = await Promise.all([
      loadNoPark(ags, op, b ? [b[0] - 0.02, b[1] - 0.02, b[2] + 0.02, b[3] + 0.02] : null),
      useOsm ? contextFor(ags) : Promise.resolve(null),
      officialData(ags),
      loadGroupDocs(),
      loadFlowDocs(cellDocs.map(d => d.day).filter(Boolean)),
    ]);
    if (stop()) return;
    O.attachFlows(model, flowRes.docs); // Ströme als Beleg für Abfluss/Zufluss je Zelle (cell.flow, model.flow)
    const osm = ctxDoc?.state === 'ok' ? ctxDoc : null;
    // Overpass im Hintergrund: danach nur Spots und Umsetzen neu (rescoreSpots), nicht der ganze Plan
    if (useOsm && !osm && pre.spots.length) overpassBackground(ags, pre.spots, () => rescoreSpots(ags));
    renderWarn(ags, osm, np, official, groupRes);
    const depot = S.depot[ags] || (b ? { lat: (b[1] + b[3]) / 2, lon: (b[0] + b[2]) / 2 } : centroid(vehicles));
    const params = { topN, spacing, share, horizonH, van: num('#ops-van', 20), common: { depot, maxRuns: num('#ops-maxruns', 6), horizonH, maxRunMin: Math.round(num('#ops-maxh', 4) * 60) }, swapCapacity: Math.min(50, num('#ops-swapcap', 50)), swapThreshold: num('#ops-swapthr', 20), swapRangeKm: num('#ops-swaprange', 5) };
    const plan = { ags, op, type, band, bandNote, model, share, depot, np, osm, official, params, groups: O.groupPlaces(groupRes.docs, { ags }), groupSrc: groupRes, flowSrc: flowRes, fleet: { vehicles, stations }, at: fleet.at, days: cellDocs.length };
    if (!S.gf || S.gf.forOp !== op || S.gf.forAgs !== ags) S.gf = { ...GF0(), kind: S.gf?.kind || 'deploy', sort: S.gf?.sort || 'count', dir: S.gf?.dir || 'desc', op, forOp: op, forAgs: ags };
    // Rechenschritte nacheinander mit Status, dazwischen die Seite freigeben
    const steps = [
      [t('ops.scoringSpots'), () => { plan.spots = scoreFor(plan, osm); }],
      [t('ops.runsRebalancing'), () => { plan.rebalance = rebalanceFor(plan); }],
      [t('ops.runsBatterySwap'), () => { plan.swaps = O.planSwaps({ vehicles: vehicles.filter(v => !v.reserved), model, swapCapacity: params.swapCapacity, swapThreshold: params.swapThreshold, swapRangeKm: params.swapRangeKm, ...params.common }); }],
      [t('ops.runsWorkshop'), () => { plan.workshop = O.planWorkshop({ vehicles, workshopCapacity: params.van, ...params.common }); }],
      [t('ops.runsStations'), () => { const sb = stations.length ? O.planStationBalance({ stations, vanCapacity: params.van, ...params.common }) : null; plan.station = sb?.stations ? sb : null; }],
    ];
    for (const [label, fn] of steps) { status(`${label} …`); await tick(); if (stop()) return; fn(); }
    plan.kpi = O.fleetKpis(vehicles, { swapThreshold: params.swapThreshold, swapRangeKm: params.swapRangeKm });
    S.plan = plan; S.routed = {}; S.focus = null; S.stale = false; plan.hhmm = hhmm();
    status(t('ops.mapAndTables')); await tick(); if (S.plan !== plan) return;
    renderTiles(); renderRuns(); renderSpots(); renderGroups(); await tick(); if (S.plan !== plan) return;
    drawMap(true);
    status(planStatus(plan));
    X.econFor(ags, op, type).then(e => { if (S.plan === plan) { plan.econ = e || false; renderTiles(); } }).catch(() => { plan.econ = false; });
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
  if (!p.fleet.vehicles.length) spots.spots = [];
  return spots;
}
const rebalanceFor = (p) => O.planRebalance({ spots: p.spots.spots, vehicles: p.fleet.vehicles.filter(O.isAvailable), model: p.model, share: p.share, vanCapacity: p.params.van, ...p.params.common });
function planStatus(p) {
  const osm = p.osm, loading = $('#ops-osm').checked && !osm && S.osm[p.ags]?.state === 'loading';
  const osmNote = !$('#ops-osm').checked ? '' : osm ? ` · ${t('ops.surroundingsOsm', { v0: osm.from === 'Sammler' ? t('ops.osmFromCollector', { v0: new Date(osm.at).toLocaleDateString(fmtLocale()) }) : X.esc(osm.from) })}` : loading ? ` · ${t('ops.publicTransportAndParking')}` : '';
  return t('ops.computedInFleetOfDemandFrom', { hhmm: p.hhmm, op: X.esc(p.op), muniName: X.esc(X.muniName(p.ags)), v3: new Date(p.at).toLocaleString(fmtLocale(), { dateStyle: 'short', timeStyle: 'short' }), days: p.model.days, v5: p.model.days === 1 ? t('ops.day') : t('ops.days'), hours: X.fmt(p.model.hours, 1), v7: p.bandNote ? ` · ${p.bandNote}` : '', osmNote });
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
  $('#ops-tiles').innerHTML = ''; $('#ops-layers').innerHTML = ''; $('#ops-legend').innerHTML = ''; $('#ops-warn').innerHTML = '';
  $('#ops-runs').innerHTML = `<div class="empty">${t('ops.noRuns', { why })}</div>`; $('#ops-runs-all').hidden = true;
  $('#ops-spots-sub').textContent = ''; $('#ops-spots tbody').innerHTML = row(SPOT_COLS);
  $('#ops-groups-sub').textContent = ''; $('#ops-groups tbody').innerHTML = row(GCOLS.length); $('#ops-gf-count').textContent = '';
  $('#ops-map-sub').textContent = X.muniName(X.state.scope);
}

// ---------- Ausgabe ----------
function tile(l, v, s, cls = '') { return `<div class="tile ${cls}"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`; }
function renderTiles() {
  const p = S.plan, k = p.kpi, f = X.fmt;
  const need = p.rebalance.needs.reduce((s, n) => s + n.need, 0), target = p.spots.spots.reduce((s, x) => s + x.target, 0);
  const runs = allRuns(); const km = runs.reduce((s, r) => s + r.km, 0), min = runs.reduce((s, r) => s + r.totalMin, 0);
  const cl = [...p.model.cells.values()], sph = cl.reduce((s, c) => s + (c.startsPerHour || 0), 0);
  const drainCells = cl.filter(c => (c.outPerHour ?? 0) > 0), drain = drainCells.reduce((s, c) => s + c.outPerHour, 0);
  const pr = X.state.usage?.profile; const prelim = !pr || pr.source === 'Standardkurve' || (pr.days ?? 0) < 3; const rv = (x) => x >= 100 ? f(sig2(x)) : f(x);
  $('#ops-tiles').innerHTML = [
    tile(t('ops.fleet'), `${f(k.available)} / ${f(k.total)}`, t('ops.availableReportedDisabled', { disabled: f(k.disabled), v1: f(p.share * 100) })),
    tile(t('ops.demand'), `${f(sph * p.share, 1)} /h`, t('ops.tripStartsMarketHNetOutflowH', { v0: p.band === 'day' ? t('ops.dailyMean') : bandLabel(p.band), sph: f(sph, 1), v2: f(drain * p.share, 1), length: f(drainCells.length), hours: f(p.model.hours, 1) })),
    tile(t('ops.spots'), `${f(p.spots.spots.length)}`, t('ops.needVehShortfall', { target: f(target), need: f(need), v2: p.spots.excluded ? ` · ${t('ops.cellsExcludedZones', { excluded: f(p.spots.excluded), v1: p.spots.excludedBy?.official ? t('ops.ofWhichNoParkingZonePerCity', { official: f(p.spots.excludedBy.official) }) : '' })}` : '' }), need > target * 0.5 ? 'warn' : ''),
    tile(t('ops.batteryIdleTime'), k.batteryKnown ? `${f(k.low)}` : 'k. A.', t('ops.notMovedForOver24HMedian', { v0: k.batteryKnown ? t('ops.belowAndKmOf', { v0: num('#ops-swapthr', 20), v1: num('#ops-swaprange', 5), batteryKnown: f(k.batteryKnown) }) : t('ops.noChargeLevelInFeed'), idle24: f(k.idle24), v2: k.idleMedianH == null ? '–' : f(k.idleMedianH, 1) + ' h' }), (k.batteryKnown && k.low / k.batteryKnown > 0.25) || (k.idleKnown && k.idle24 / k.idleKnown > 0.3) ? 'warn' : ''),
    tile(t('ops.revenueDay'), p.econ === undefined ? '…' : p.econ?.revDay != null && p.econ.plausible ? (prelim ? `${rv(p.econ.revDay * 0.7)}–${rv(p.econ.revDay * 1.3)} €` : `${f(p.econ.revDay)} €`) : '—', p.econ === undefined ? t('ops.loadingEstimate') : !p.econ ? t('ops.noTripDataForThisOperator') : t('ops.tripsVehDayUtilisationNet', { v0: prelim ? `${t('ops.preliminaryUnder3Measurement')} · ` : '', v1: p.econ.plausible ? '' : `${t('ops.tripCountImplausible')} · `, rvd: f(p.econ.rvd, 2), v3: p.econ.utilization == null ? '–' : f(p.econ.utilization * 100, 1) + ' %' }), `est${p.econ && !p.econ.plausible ? ' warn' : ''}`),
    tile(t('ops.runs'), `${f(runs.length)}`, t('ops.kmHOnDuty', { km: f(km, 1), v1: f(min / 60, 1), v2: Object.keys(S.routed).length ? t('ops.byRoad', { length: f(Object.keys(S.routed).length), length2: f(runs.length) }) : $('#ops-route')?.checked ? t('ops.roadRoutingInProgress') : t('ops.straightLine135') })),
  ].join('');
}
function legend() {
  const chip = (k, label, color) => `<button class="chip${S.show[k] ? ' on' : ''}" data-l="${k}" aria-pressed="${S.show[k]}"${color ? ` style="${S.show[k] ? `background:color-mix(in srgb, ${color} 24%, var(--panel));border-color:${color};color:var(--fg)` : `border-color:${color}`}"` : ''}>${label}</button>`;
  const opc = X.opColor(S.plan.op), gv = (k) => groupView(k), mixed = S.gf?.op === 'all';
  $('#ops-layers').innerHTML = `<button class="chip" data-jump="ops-runs" title="${t('ops.jumpToListOfRunsSkipMapAnd')}">${t('ops.toRuns')}</button>` + chip('demand', t('ops.netOutflow')) + chip('fleet', t('ops.fleet')) + chip('spots', t('ops.spots')) + chip('groups', t('ops.operatorSpots'), opc) + chip('collect', t('ops.pickupPlaces'), opc) + (S.plan.official?.noPark.length ? chip('official', t('ops.officialZones'), '#ef6b6b') : '') + chip('rebalance', t('ops.rebalance'), RUN_COLOR.rebalance) + (S.plan?.station ? chip('station', t('ops.stations'), RUN_COLOR.station) : '') + chip('swap', t('ops.batterySwap'), RUN_COLOR.swap) + chip('workshop', t('ops.workshop'), RUN_COLOR.workshop);
  $('#ops-legend').innerHTML = `<span><i class="sq" style="background:#49c7b0;border-color:#49c7b0"></i>${t('ops.netOutflowHStartsEnds250M', { v0: abbr(t('ops.cell'), t('ops.gridOfAbout250250MStartsEnds')) })}</span><span><i class="dot" style="background:#ef6b6b"></i>${t('ops.disabled')}</span><span><i class="dot" style="background:#e3b341"></i>${t('ops.batteryLow')}</span><span><i class="dot" style="background:#c084fc"></i>${t('ops.n24HNotMoved')}</span><span><b class="ops-spot-mini">1</b>${t('ops.spotDashedRankUncertain')}</span><span><b class="ops-spot-mini" style="background:var(--fg)">D</b>Depot</span>`
    + (S.show.groups && gv('deploy').length ? `<span>${t('ops.presumedOperatorSpot', { v0: groupSvg('deploy', opc, 12), v1: mixed ? t('ops.colourOperator') : '' })}</span>` : '')
    + (S.show.collect && gv('collect').length ? `<span>${t('ops.pickupPlaceObservation', { v0: groupSvg('collect', opc, 12), v1: mixed ? t('ops.colourOperator') : '' })}</span>` : '')
    + (S.show.official && S.plan.official?.noPark.length ? `<span><i class="sq" style="background:#ef6b6b33;border-color:#ef6b6b;border-style:dashed"></i>${t('ops.noParkingZonePerCity', { v0: S.plan.official.sources.filter(x => x.ref.kind === 'noPark').map(x => refCite(x.ref)).join(', ') })}</span>` : '')
    + (S.plan.official?.points.length ? `<span class="muted">${t('ops.parkingAreas', { v0: S.plan.official.sources.filter(x => x.ref.kind !== 'noPark').map(x => refCite(x.ref)).join(', ') })}</span>` : '');
}
// Raute = Ausbringung, gestricheltes Sechseck = Einsammeln; Umriss in der Anbieterfarbe
function groupSvg(kind, color, size, css = 'display:inline-block;vertical-align:-1px;margin-right:6px;') {
  const shape = kind === 'deploy' ? '12,1.5 22.5,12 12,22.5 1.5,12' : '6.5,2.5 17.5,2.5 23,12 17.5,21.5 6.5,21.5 1,12';
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" style="${css}overflow:visible"><polygon points="${shape}" fill="${color}" fill-opacity=".14" stroke="${color}" stroke-width="2.5" vector-effect="non-scaling-stroke"${kind === 'collect' ? ' stroke-dasharray="4 3"' : ''}/></svg>`;
}
const WHEN = { format: (ms) => dateFmt({ day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(ms) }, DAYMON = { format: (ms) => dateFmt({ day: '2-digit', month: '2-digit' }).format(ms) };
const whenText = (ms) => WHEN.format(ms); // feste Formatierer statt toLocaleString je Tabellenzeile
const avgText = (x) => X.fmt(x, Number.isInteger(x) ? 0 : 1);
const typesText = (tq) => Object.entries(tq || {}).sort((a, b) => b[1] - a[1]).map(([k]) => X.TYPE[k] || k).join(', ');
const groupPopup = (s, kind) => `${t('ops.firstLastAvgVehiclesInTotal', { v0: kind === 'deploy' ? t('ops.presumedDeploySpot') : t('ops.pickupPlace'), op: X.esc(s.op), count: X.fmt(s.count), v3: kind === 'deploy' ? t('ops.deployedLc') : t('ops.collectedLc'), v4: whenText(s.first), v5: whenText(s.last), v6: avgText(s.avg), vehicles: X.fmt(s.vehicles), v8: typesText(s.types) ? ` · ${X.esc(typesText(s.types))}` : '' })}<span style="color:var(--muted)">${t('ops.fromObservationNoOperator')}</span>`;
const sgn = (x, d = 2) => x == null || !Number.isFinite(x) ? '—' : `${x > 0 ? '+' : x < 0 ? '−' : ''}${X.fmt(Math.abs(x), d)}`;
// Spot-Beschriftung für Screenreader/Tooltip: „Spot 3: <Lage>“ (Adresse, sobald Nominatim sie geliefert hat)
const spotTitle = (s) => t('ops.spot', { rank: s.rank, v1: GEO.get(geoKey(s.lat, s.lon)) || (s.park ? parkLabel(s.park) : t('ops.cellCentre')) });
// Ein gemeinsames Popup für die Canvas-Ebenen Nachfrage und Flotte (bis > 5.000 Punkte): kein Popup-Objekt je Marker,
// der Inhalt entsteht erst beim Klick aus der Funktion in POP
const POP = new WeakMap();
const withPop = (layer, fn) => { POP.set(layer, fn); return layer; };
function openShared(e) { const fn = POP.get(e.layer); if (!fn) return; L.popup({ maxWidth: 300 }).setLatLng(e.layer.getLatLng ? e.layer.getLatLng() : e.latlng).setContent(fn()).openOn(S.map); }
const BASE_LAYERS = ['demand', 'official', 'fleet', 'spots', 'groups', 'collect', 'depot'];
// Ganze Karte: Grundebenen, Routen, optional einpassen
function drawMap(fit) {
  if (!S.plan) return;
  legend(); drawLayers(BASE_LAYERS); drawRoutes();
  if (fit) fitAll();
}
// Nur die genannten Grundebenen neu zeichnen (Ebenen-Chip, Neubewertung nach Overpass); Popups erst beim Öffnen. Routen: drawRoutes().
function drawLayers(keys) {
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
      withPop(L.rectangle([[c.lat - O.CELL_LAT / 2, c.lon - O.CELL_LON / 2], [c.lat + O.CELL_LAT / 2, c.lon + O.CELL_LON / 2]], { weight: 0, fillColor: '#49c7b0', fillOpacity: 0.08 + 0.5 * q(c.outPerHour), renderer: S.canvas.demand }),
        () => t('ops.cellMarketMeasuredHoursNet', { cell: esc(c.cell), hours: f(p.model.hours, 1), v2: sgn(c.outPerHour), outSe: f(c.outSe, 2), starts: f(c.starts), startsPerHour: f(c.startsPerHour, 2), ends: f(c.ends), endsPerHour: f(c.endsPerHour, 2), supplyAvg: f(c.supplyAvg, 1), v9: fl ? t('ops.flowsOutIn', { days: f(fl.days), v1: fl.days === 1 ? t('ops.day') : t('ops.days2'), v2: f(c.flow?.out || 0), v3: f(c.flow?.in || 0) }) : '' })).addTo(Lx.demand);
    }
  }
  // Abstellverbotszonen der Stadt (Ausschluss), gestrichelt unter der Flotte; nicht anklickbar, Quelle und Lizenz in der Legende
  if (on('official')) for (const g of p.official?.noPark || []) L.geoJSON(g, { interactive: false, style: { color: '#ef6b6b', weight: 1, dashArray: '4 3', fillColor: '#ef6b6b', fillOpacity: 0.12 }, renderer: S.canvas.demand }).addTo(Lx.official);
  if (on('fleet')) {
    const swapOpt = { swapThreshold: num('#ops-swapthr', 20), swapRangeKm: num('#ops-swaprange', 5) };
    for (const v of p.fleet.vehicles) {
      const opc = X.opColor(v.operator), col = v.disabled ? '#ef6b6b' : O.needsSwap(v, swapOpt) ? '#e3b341' : (v.idleMin ?? 0) >= 1440 ? '#c084fc' : opc;
      const plain = col === opc;
      withPop(L.circleMarker([v.lat, v.lon], { radius: plain ? 2.5 : 3.5, weight: 0, fillColor: col, fillOpacity: plain ? .4 : .95, renderer: S.canvas.fleet }),
        () => `<b>${esc(v.operator)}</b> · ${esc(X.TYPE[v.type] || v.type)}<br>${v.disabled ? `${t('ops.disabled')} · ` : v.reserved ? `${t('ops.reserved')} · ` : ''}${v.battery != null ? `${t('ops.battery', { battery: f(v.battery) })} · ` : ''}${v.idleMin != null ? t('ops.idleForH', { v0: f(v.idleMin / 60, 1) }) : ''}`).addTo(Lx.fleet);
    }
    for (const s of p.fleet.stations) withPop(L.circleMarker([s.lat, s.lon], { radius: 5, weight: 2, color: X.opColor(s.operator), fillColor: s.bookable ? X.opColor(s.operator) : 'transparent', fillOpacity: .6, renderer: S.canvas.fleet }),
      () => t('ops.bookable', { v0: esc(s.name || t('ops.station')), bookable: f(s.bookable), v2: s.docks != null ? t('ops.free', { docks: f(s.docks) }) : '', v3: s.capacity ? ` · ${t('ops.capacity', { capacity: f(s.capacity) })}` : '' })).addTo(Lx.fleet);
  }
  // Spot-, Gruppen- und Depot-Marker ohne Tab-Stopp (keyboard: false): dieselben Angaben stehen in den Tabellen unter der Karte,
  // so führt die Tastatur von den Ebenen-Chips ohne 20+ Zwischenschritte zur Tourenliste
  if (on('spots')) {
    const needBy = new Map(p.rebalance.needs.map(n => [n.cell, n]));
    for (const s of p.spots.spots) {
      const n = needBy.get(s.cell);
      L.circle([s.lat, s.lon], { radius: 150, weight: 1, color: '#49c7b0', fill: false, dashArray: s.stabilityLabel === 'stabil' ? null : '4 4', interactive: false }).addTo(Lx.spots);
      S.spotMarkers.push([s, L.marker([s.lat, s.lon], { icon: L.divIcon({ className: `ops-spot${s.stabilityLabel === 'stabil' ? '' : ' weak'}`, html: `${s.rank}`, iconSize: [24, 24] }), title: spotTitle(s), keyboard: false })
        .bindPopup(() => t('ops.spotNeedVehFleet150M', { rank: s.rank, v1: s.park ? ` · ${esc(parkLabel(s.park))}` : '', target: f(s.target), v3: f(n?.have), v4: f(n?.need), startsPerHourOp: f(s.startsPerHourOp, 2), endsPerHourOp: f(s.endsPerHourOp, 2), v7: sgn(s.outPerHourOp), hours: f(s.hours, 1), score: f(s.score, 2), v10: p.spots.prelim ? t('ops.preliminary') : (STAB[s.stabilityLabel] ?? s.stabilityLabel) })).addTo(Lx.spots)]);
    }
  }
  // Vermutete Anbieter-Spots und Einsammel-Orte (Gruppen-Ereignisse), Größe nach Anzahl, unter den eigenen Spots
  for (const [kind, l] of [['deploy', 'groups'], ['collect', 'collect']]) {
    if (!on(l)) continue;
    for (const s of groupView(kind)) { const z = Math.round(16 + 4 * Math.sqrt(Math.min(s.count, 25)));
      L.marker([s.lat, s.lon], { icon: L.divIcon({ className: 'ops-group', html: groupSvg(kind, X.opColor(s.op), z, ''), iconSize: [z, z] }), zIndexOffset: -500, keyboard: false, title: `${kind === 'deploy' ? t('ops.presumedDeploySpot') : t('ops.pickupPlace')} · ${s.op} · ${s.count}×` }).bindPopup(() => groupPopup(s, kind)).addTo(Lx[l]); }
  }
  if (keys.includes('depot')) L.marker([p.depot.lat, p.depot.lon], { icon: L.divIcon({ className: 'ops-spot depot', html: 'D', iconSize: [24, 24] }), title: 'Depot', keyboard: false }).bindPopup(t('ops.depotSetDepotAndClickOnMapTo')).addTo(Lx.depot);
}
// Nur die Touren-Ebenen neu zeichnen (nach jeder OSRM-Route, Fokus, Ebenen-Chip): Fahrzeug-, Spot- und Gruppen-Marker bleiben stehen
function drawRoutes() {
  const p = S.plan; if (!p) return;
  for (const k of RUN_KINDS) S.layers[k].clearLayers();
  for (const r of allRuns()) {
    if (!S.show[r.kind] || (S.focus && r.id !== S.focus)) continue;
    const geo = S.routed[r.id]?.coords || [[p.depot.lat, p.depot.lon], ...r.stops.map(s => [s.lat, s.lon]), [p.depot.lat, p.depot.lon]];
    L.polyline(geo, { color: RUN_COLOR[r.kind], weight: 3, opacity: .85, dashArray: S.routed[r.id] ? null : '6 5', renderer: S.canvas.runs }).bindPopup(() => runTitle(r)).addTo(S.layers[r.kind]);
    r.stops.forEach((s, i) => L.circleMarker([s.lat, s.lon], { radius: 5, weight: 2, color: RUN_COLOR[r.kind], fillColor: s.type === 'drop' ? RUN_COLOR[r.kind] : '#ffffff', fillOpacity: 1, renderer: S.canvas.runs })
      .bindTooltip(`${r.id}·${i + 1} ${STOP_LABEL[s.type]} ${s.count}`, { direction: 'top' }).addTo(S.layers[r.kind]));
  }
  $('#ops-map-sub').textContent = `${X.muniName(p.ags)} · ${p.op} · ${p.band === 'day' ? t('ops.wholeDay2') : bandLabel(p.band)}${S.focus ? ` · ${t('ops.onlyRun', { focus: S.focus })}` : ''}`;
}
function fitAll() {
  const p = S.plan; if (!p) return;
  const pts = p.spots.spots.length ? [...p.spots.spots.map(s => [s.lat, s.lon]), [p.depot.lat, p.depot.lon]] : p.fleet.vehicles.map(v => [v.lat, v.lon]);
  if (pts.length) S.map.fitBounds(L.latLngBounds(pts).pad(0.08));
}
// Tour-Fokus: nur eine Tour auf der Karte, Karte darauf eingepasst; „Alle Touren zeigen“ und neuer Plan heben ihn auf
function focusRun(id) {
  const r = allRuns().find(x => x.id === id); if (!r) return;
  S.focus = id; if (!S.show[r.kind]) { S.show[r.kind] = true; legend(); }
  markFocus(); drawRoutes();
  const pts = S.routed[r.id]?.coords || [[S.plan.depot.lat, S.plan.depot.lon], ...r.stops.map(s => [s.lat, s.lon])];
  S.map.fitBounds(L.latLngBounds(pts).pad(0.15));
}
function markFocus() {
  document.querySelectorAll('#ops-runs .ops-run').forEach(el => el.classList.toggle('focus', el.dataset.run === S.focus));
  $('#ops-runs-all').hidden = !S.focus;
}
const parkLabel = (pk) => ({ station: t('ops.operatorStationMandatory'), escooter: t('ops.eScooterParkingBay'), official: t('ops.officialParkingArea'), sharing: t('ops.sharingMobilityHub'), rad: t('ops.bikeRack') }[pk.cat] || pk.cat) + (pk.name ? ` „${pk.name}“` : '');
const runTitle = (r) => t('ops.vehKmMin', { id: r.id, v1: RUN_LABEL[r.kind], vehicles: X.fmt(r.vehicles), km: X.fmt(r.km, 1), totalMin: X.fmt(r.totalMin) });
function renderRuns() {
  const p = S.plan, f = X.fmt, esc = X.esc, box = $('#ops-runs');
  // Neu zeichnen nach jeder Straßenroute: offene Stopplisten und den Tastaturfokus erhalten
  const open = new Set([...box.querySelectorAll('details[open]')].map(d => d.closest('[data-run]')?.dataset.run));
  const act = box.contains(document.activeElement) ? document.activeElement : null, actRun = act?.closest('[data-run]')?.dataset.run;
  const actSel = act?.matches('[data-fit]') ? '[data-fit]' : act?.matches('summary') ? 'summary' : act?.matches('a') ? `a:nth-of-type(${[...act.parentElement.querySelectorAll('a')].indexOf(act) + 1})` : null;
  const limit = p.rebalance.limitMin, hText = limit ? `${f(limit / 60, limit % 60 ? 1 : 0)} h` : '';
  const left = (n) => n ? ` · <span class="warn-text">${t('ops.notScheduled', { n: f(n) })}</span> ${t('ops.numberOfRunsOrPerRun', { hText })}` : '';
  const block = (kind, plan, head) => {
    const runs = plan?.runs || [];
    if (!plan) return '';
    const body = runs.length ? runs.map(r => {
      const pts = [p.depot, ...r.stops, p.depot]; const links = O.mapsLinks(pts);
      return `<div class="card ops-run${S.focus === r.id ? ' focus' : ''}" data-run="${r.id}" title="${t('ops.showOnlyThisRunOnMap')}" style="border-left:3px solid ${RUN_COLOR[kind]}">${t('ops.vehStops', { id: r.id, vehicles: f(r.vehicles), length: f(r.stops.length), v3: r.kind === 'rebalance' && r.prio ? ` · ${t('ops.shortfallUpTo', { prio: f(r.prio) })}` : '' })}
        <p>${t('ops.kmMinDrivingMinOnSiteMin', { km: f(r.km, 1), driveMin: f(r.driveMin), handleMin: f(r.handleMin), totalMin: f(r.totalMin), v4: S.routed[r.id] ? ` · ${t('ops.road')}` : '', v5: limit && r.totalMin > limit ? ` · <span class="warn-text">${t('ops.byRoadOver', { hText })}</span>` : '' })}</p>
        <details${open.has(r.id) ? ' open' : ''}><summary>${t('ops.stopList')}</summary><ol class="small">${r.stops.map(s => `<li>${STOP_LABEL[s.type]} ${f(s.count)}${s.station ? ` · ${esc(s.station)} (${esc(s.fill)})` : ''}${s.spotRank ? ` · ${t('ops.spot2', { spotRank: s.spotRank, v1: s.need != null ? ` · ${t('ops.shortfallNeedFleet', { need: f(s.need), target: f(s.target), have: f(s.have) })}` : '' })}` : ''}${s.battery?.length ? ` · ${t('ops.battery2', { v0: s.battery.slice(0, 6).join('/') })}` : ''}${s.idleMaxH ? ` · ${t('ops.idleH', { idleMaxH: f(s.idleMaxH) })}` : ''}</li>`).join('')}</ol></details>
        <div class="foot"><button class="chip" data-fit="${r.id}">${t('ops.onMap')}</button> ${links.map((u, i) => `<a href="${u}" target="_blank" rel="noopener" title="${t('ops.googleMapsAllowsAtMost10')}">${links.length > 1 ? t('ops.routePartOf', { v0: i + 1, length: links.length }) : t('ops.route')} ↗</a>`).join(' · ')}</div></div>`;
    }).join('') : `<div class="muted small">${t('ops.noRunNeeded')}</div>`;
    return `<h3 style="margin-top:12px">${RUN_LABEL[kind]}</h3><div class="sub">${head}</div><div class="cards" style="grid-template-columns:1fr">${body}</div>`;
  };
  const rb = p.rebalance, sw = p.swaps, ws = p.workshop, sb = p.station;
  box.innerHTML =
    (S.plan.fleet.vehicles.length ? '' : `<div class="note">${t('ops.stationBasedFleetNoFree')}</div>`) +
    block('rebalance', rb, t('ops.rebalancingMovesFromSurplus', { moves: f(rb.moves), surplus: f(rb.surplus), v2: rb.missing > 0 ? ` · ${t('ops.placesRemainOpenNoSurplus', { missing: f(rb.missing), v1: f(O.DEFAULTS.maxPickupM / 1000) })}` : '', v3: left(rb.unplanned) })) +
    (sb ? block('station', sb, t('ops.nearlyEmptyNearlyFullOf', { empty: f(sb.empty), full: f(sb.full), stations: f(sb.stations), moves: f(sb.moves), v4: left(sb.unplanned) })) : '') +
    block('swap', sw, sw.below ? t('ops.vehiclesBelowChargeAndKm', { below: f(sw.below), v1: num('#ops-swapthr', 20), v2: num('#ops-swaprange', 5), v3: left(sw.unplanned) }) : t('ops.noVehicleBelowThresholdOrNo')) +
    block('workshop', ws, ws.disabled ? t('ops.disabledVehiclesLongest', { disabled: f(ws.disabled), v1: left(ws.unplanned) }) : t('ops.noDisabledVehicles'));
  $('#ops-runs-sub').textContent = t('ops.runsForBundledByCityAreaAt', { op: p.op, hText });
  markFocus();
  if (actRun && actSel) box.querySelector(`[data-run="${actRun}"] ${actSel}`)?.focus({ preventScroll: true });
}
// Spot-Tabelle: alle Zahlen der Bedarfsrechnung sichtbar (Kopf ersetzt den aus index.html)
const SPOT_COLS = 12;
function spotHead() {
  const th = (tq, tip, n = true) => `<th${n ? ' class="n"' : ''}><abbr title="${tip}">${tq}</abbr></th>`;
  return `<tr><th class="n">${t('ops.rank')}</th><th>${t('ops.location')}</th>${th(t('ops.startsPerH'), t('ops.tripStartsPerHourOperatorS'))}${th(t('ops.endsPerH'), t('ops.tripEndsPerHourOperatorS'))}${th(t('ops.netPerH'), t('ops.netOutflowStartsEndsPerHour'))}`
    + `${th(t('ops.measurement'), t('ops.measuredHoursInChosenTimeOf'))}${th(t('ops.need'), t('ops.needMax0NetHHorizonBaseStock'))}${th(t('ops.fleet2'), t('ops.operatorSAvailableVehicles'))}${th(t('ops.shortfall'), t('ops.shortfallNeedFleet2'))}`
    + `${th('Score', t('ops.weightedSumOfFactorsDTPAhp'))}${th(t('ops.factors'), t('ops.netOutflowDDemandStartsHT'), false)}${th(t('ops.stability'), t('ops.howSurelySpotStaysIn'), false)}</tr>`;
}
function renderSpots() {
  const p = S.plan, f = X.fmt, esc = X.esc, sp = p.spots, H = p.params.horizonH, D = O.DEFAULTS;
  const needBy = new Map(p.rebalance.needs.map(n => [n.cell, n]));
  const prelim = sp.prelim; // Netto-Abfluss und Sensitivität über wenige Messstunden sind nicht aussagekräftig
  // Ströme als Beleg: bei wie vielen Spots mit Netto-Abfluss zeigen auch die Ströme mehr Abfahrten als Ankünfte
  const fl = p.model.flow, withFlow = sp.spots.filter(s => s.outPerHourOp > 0 && s.flow && s.flow.out + s.flow.in >= 2), agree = withFlow.filter(s => s.flow.out > s.flow.in).length;
  const flowNote = fl ? ` · ${t('ops.flowsStableIdsTripsWithStart', { days: f(fl.days), v1: fl.days === 1 ? t('ops.day') : t('ops.days2'), trips: f(fl.trips), v3: fl.below ? t('ops.belowMinimumThreshold', { below: f(fl.below) }) : '', v4: withFlow.length ? ` ${t('ops.forOfSpotsWithNetOutflowAlso', { agree: f(agree), length: f(withFlow.length) })}` : '' })}`
    : p.flowSrc?.indexed ? ` · ${t('ops.flowsNoFileYetForTheseDemand')}` : ` · ${t('ops.flowsNoneYetFlowsAppears')}`;
  $('#ops-spots-sub').innerHTML = esc(t('ops.candidateCellsFactorsNeedMax', { candidates: sp.candidates, v1: sp.activeFactors.map(k => AHP_L[k]).join(', '), H: f(H), baseH: f(sp.baseH), v4: f(p.share * 100), hours: f(p.model.hours, 1), days: f(p.model.days), v7: p.model.days === 1 ? t('ops.day') : t('ops.days'), v8: sp.rho != null ? ` · ${t('ops.rankCorrelationDemandNet', { rho: f(sp.rho, 2) })}` : '', flowNote, length: p.np.geoms.length, v11: p.np.mandatory.length ? ` ${t('ops.andMandatoryParking', { length: p.np.mandatory.length })}` : '', files: p.np.files, v13: p.np.files === 1 ? t('ops.zoneFeed') : t('ops.zoneFeeds'), v14: sp.excludedBy?.operator ? ` ${t('ops.cellsExcluded', { operator: sp.excludedBy.operator })}` : '', v15: p.osm ? ` · ${t('ops.osmParkingAreasStopPoints', { length: f(p.osm.parking.length), length2: f(p.osm.transit.length) })}` : '' })) +
    // amtliche Daten mit Quelle und Lizenz: Abstellflächen (Spot rastet ein), Abstellverbotszonen (Ausschluss, kein Gewicht)
    (p.official?.sources || []).map(({ ref, n }) => ` · ${refCite(ref)}: ${ref.kind === 'noPark' ? t('ops.noParkingZonesCellsExcluded', { n: f(n), v1: f(sp.excludedBy?.official || 0) }) : t('ops.officialParkingAreas2', { n: f(n) })}`).join('') +
    (prelim ? `<br><span class="warn-text">${t('ops.preliminaryNetOutflowAnd', { prelimH: f(D.prelimH), hours: f(p.model.hours, 1) })}</span>` : '');
  const bar = (x) => `<span class="bar" style="display:inline-block;width:38px;vertical-align:middle"><i style="width:${Math.round((x ?? 0) * 100)}%"></i></span>`;
  const F = { 'Δ': t('ops.netOutflowStartsEndsPerH'), N: t('ops.demandStartsH'), Ö: t('ops.publicTransportProximityStop'), A: t('ops.parkingAreaNearby') };
  const fac = (x, l) => `${bar(x)} <abbr title="${F[l]}: ${f((x ?? 0) * 100)} %">${FL(l)}</abbr>`;
  const formula = (s) => (s.drain > 0 ? `${f(s.outPerHourOp, 2)} × ${f(H)} h + ${f(s.base, 1)}` : t('ops.baseStock', { base: f(s.base, 1) })) + (s.capped ? ` ${t('ops.max', { needRaw: f(s.needRaw, 1), maxPerSpot: f(D.maxPerSpot) })}` : s.target > Math.ceil(s.needRaw - 1e-9) ? t('ops.min', { minPerSpot: f(D.minPerSpot) }) : '');
  $('#ops-spots tbody').innerHTML = sp.spots.map(s => { const n = needBy.get(s.cell); const k = geoKey(s.lat, s.lon); const g = s.rank <= GEO_TOP ? GEO.get(k) : undefined;
    const osm = osmLink(s.lat, s.lon);
    const place = s.park ? esc(parkLabel(s.park)) : t('ops.cellCentre');
    const main = s.rank > GEO_TOP ? place : `<span class="geo-main" translate="no" data-geo="${k}" data-fallback="${place}">${g ? esc(g) : g === null ? place : `<span class="muted">${t('ops.lookingUpAddress')}</span>`}</span>`;
    return `<tr><td class="n">${s.rank}</td><td>${main}<div class="sub-line">${osm}${s.rank <= GEO_TOP ? ` · ${place}` : ''}</div></td>
    <td class="n">${f(s.startsPerHourOp, 2)}<div class="sub-line">${t('ops.market', { startsPerHour: f(s.startsPerHour, 2) })}</div></td><td class="n">${f(s.endsPerHourOp, 2)}<div class="sub-line">${t('ops.market2', { endsPerHour: f(s.endsPerHour, 2) })}</div></td>
    <td class="n"><b>${sgn(s.outPerHourOp)}</b><div class="sub-line">± ${f(s.outSeOp, 2)}${fl ? ` · ${t('ops.flowsOutIn2', { v0: f(s.flow?.out || 0), v1: f(s.flow?.in || 0) })}` : ''}</div></td>
    <td class="n">${f(s.hours, 1)} h<div class="sub-line">${t('ops.startsEnds', { starts: f(s.starts), ends: f(s.ends) })}</div></td>
    <td class="n"><b>${f(s.target)}</b><div class="sub-line">${formula(s)}</div></td><td class="n">${f(n?.have)}<div class="sub-line">${t('ops.avgMarket', { supplyAvg: f(s.supplyAvg, 1) })}</div></td><td class="n" style="color:var(--${n?.need ? 'warn' : 'muted'})"><b>${f(n?.need)}</b></td>
    <td class="n">${f(s.score, 2)}</td>
    <td class="small" style="white-space:nowrap">${fac(s.factors.outflow, 'Δ')} ${fac(s.factors.demand, 'N')}${sp.activeFactors.includes('transit') ? ` ${fac(s.factors.transit, 'Ö')}` : ''}${sp.activeFactors.includes('parking') ? ` ${fac(s.factors.parking, 'A')}` : ''}</td>
    <td>${prelim ? `<span class="pill prelim" title="${t('ops.meaningfulOnlyFromMeasured', { prelimH: f(D.prelimH) })}">${t('ops.preliminary')}</span>` : `<span class="pill ${s.stabilityLabel === 'stabil' ? 'live' : s.stabilityLabel === 'mittel' ? 'delayed' : 'stale'}">${STAB[s.stabilityLabel] ?? s.stabilityLabel}</span>`}<div class="sub-line">${t('ops.ofVariants', { v0: f(s.stability * 100) })}</div></td></tr>`; }).join('') || `<tr><td colspan="${SPOT_COLS}" class="empty">${t('ops.noSpotsTooLittleDemand')}</td></tr>`;
  queueGeo(sp.spots.slice(0, GEO_TOP));
}
const osmLink = (lat, lon) => `<a href="https://www.openstreetmap.org/?mlat=${lat.toFixed(5)}&mlon=${lon.toFixed(5)}#map=18/${lat.toFixed(5)}/${lon.toFixed(5)}" target="_blank" rel="noopener" class="mono" title="${t('ops.openInOpenstreetmap')}">${lat.toFixed(5)}, ${lon.toFixed(5)}</a>`;

// ---------- Vermutete Deploy-Spots und Einsammel-Orte (Gruppen-Ereignisse aller Monate, aus Beobachtung) ----------
// Orte je Anbieter und Art aus lib/pulse-ops.js groupPlaces (Ereignisse ≤ 60 m zusammengefasst). Tabelle mit Filter je Spalte (Lage, Anbieter,
// Anzahl, Ø Fahrzeuge, Zeitraum „zuletzt“), Sortierung per Spaltenkopf (Tastatur: Tab + Enter/Leertaste, aria-sort), CSV der gefilterten Zeilen.
// Die Kartenebenen „Anbieter-Spots“ und „Einsammel-Orte“ zeigen dieselbe Auswahl.
const GROUP_GEO_TOP = 10;
const GF0 = () => ({ kind: 'deploy', q: '', op: 'all', countMin: '', countMax: '', avgMin: '', avgMax: '', from: '', to: '', sort: 'count', dir: 'desc', forOp: null, forAgs: null });
const GCOLS = [
  { key: 'lage', label: () => t('ops.location'), n: false, dir: 'asc' },
  { key: 'op', label: () => t('ops.operator'), n: false, dir: 'asc' },
  { key: 'count', label: () => S.gf?.kind === 'collect' ? t('ops.pickups') : t('ops.deployments'), n: true, dir: 'desc' },
  { key: 'last', label: () => t('ops.lastCol'), n: true, dir: 'desc' },
  { key: 'avg', label: () => t('ops.avgVehicles'), n: true, dir: 'desc' },
  { key: 'near', label: () => t('ops.nearestPlanSpot'), n: true, dir: 'asc' },
];
const geoLabel = (s) => GEO.get(geoKey(s.lat, s.lon)) || '';
// nächster Spot des Plans je Ort, einmal je Plan gerechnet
const NEAR = new WeakMap();
function nearOf(s) {
  const p = S.plan; if (!p) return null;
  let m = NEAR.get(p); if (!m) NEAR.set(p, m = new Map()); if (m.has(s)) return m.get(s);
  let best = null, bd = Infinity; for (const o of p.spots.spots) { const d = O.dist(o, s); if (d < bd) { bd = d; best = o; } }
  const r = best ? { rank: best.rank, d: bd } : null; m.set(s, r); return r;
}
function groupView(kind) {
  const g = S.plan?.groups; if (!g || !S.gf) return [];
  return O.sortPlaces(O.filterPlaces(g[kind] || [], S.gf, geoLabel), S.gf.sort, S.gf.dir, { labelOf: geoLabel, nearOf });
}
function initGroupsUi() {
  const tbl = $('#ops-groups'); if (!tbl || $('#ops-gfilter')) return;
  const panel = tbl.closest('.panel'), head = panel.querySelector('.panel-head');
  head.insertAdjacentHTML('beforeend', `<div class="inline-form"><div class="ops-gkind" role="group" aria-label="${t('ops.typeOfPlaces')}" data-i18n-aria-label="ops.typeOfPlaces"><button type="button" data-gk="deploy" aria-pressed="true"><span data-i18n="ops.deployments">${t('ops.deployments')}</span></button><button type="button" data-gk="collect" aria-pressed="false"><span data-i18n="ops.pickupPlaces">${t('ops.pickupPlaces')}</span></button></div><button type="button" id="ops-gcsv" title="${t('ops.filteredRowsAsCsvSemicolon')}" data-i18n-title="ops.filteredRowsAsCsvSemicolon">↓ CSV</button></div>`);
  head.insertAdjacentHTML('afterend', `<form class="ops-gfilter" id="ops-gfilter" aria-label="${t('ops.filterColumns')}" data-i18n-aria-label="ops.filterColumns" novalidate>
    <label><span data-i18n="ops.location">${t('ops.location')}</span><input type="search" data-f="q" placeholder="${t('ops.streetPlaceOrLatLon')}" data-i18n-placeholder="ops.streetPlaceOrLatLon" autocomplete="off"></label>
    <label><span data-i18n="ops.operator">${t('ops.operator')}</span><select data-f="op"><option value="all" data-i18n="ops.allOperators"><span data-i18n="ops.allOperators">${t('ops.allOperators')}</span></option></select></label>
    <div class="rng" role="group" aria-labelledby="ops-gf-cl"><span id="ops-gf-cl"><span data-i18n="ops.deployments">${t('ops.deployments')}</span></span><span><input type="number" min="1" step="1" inputmode="numeric" data-f="countMin" placeholder="${t('ops.from')}" data-i18n-placeholder="ops.from" aria-label="${t('ops.deploymentsFrom')}" data-i18n-aria-label="ops.deploymentsFrom"> – <input type="number" min="1" step="1" inputmode="numeric" data-f="countMax" placeholder="${t('ops.to')}" data-i18n-placeholder="ops.to" aria-label="${t('ops.deploymentsTo')}" data-i18n-aria-label="ops.deploymentsTo"></span></div>
    <div class="rng" role="group" aria-labelledby="ops-gf-al"><span id="ops-gf-al"><span data-i18n="ops.avgVehicles">${t('ops.avgVehicles')}</span></span><span><input type="number" min="0" step="0.5" inputmode="decimal" data-f="avgMin" placeholder="${t('ops.from')}" data-i18n-placeholder="ops.from" aria-label="${t('ops.avgVehiclesFrom')}" data-i18n-aria-label="ops.avgVehiclesFrom"> – <input type="number" min="0" step="0.5" inputmode="decimal" data-f="avgMax" placeholder="${t('ops.to')}" data-i18n-placeholder="ops.to" aria-label="${t('ops.avgVehiclesTo')}" data-i18n-aria-label="ops.avgVehiclesTo"></span></div>
    <div class="rng dates" role="group" aria-labelledby="ops-gf-dl"><span id="ops-gf-dl"><span data-i18n="ops.lastPeriod">${t('ops.lastPeriod')}</span></span><span><input type="date" data-f="from" aria-label="${t('ops.lastFrom')}" data-i18n-aria-label="ops.lastFrom"> – <input type="date" data-f="to" aria-label="${t('ops.lastTo')}" data-i18n-aria-label="ops.lastTo"></span></div>
    <div class="ops-actions"><span class="small muted" id="ops-gf-count" role="status"></span><button type="button" id="ops-gf-reset"><span data-i18n="ops.resetFilters">${t('ops.resetFilters')}</span></button></div></form>`);
  const form = $('#ops-gfilter'); let tmr = null;
  // nur bei geänderter Eingabe neu zeichnen: „change“ beim Verlassen eines Felds darf die Tabelle nicht ersetzen (sonst verpufft ein Klick
  // auf „Filter zurücksetzen“ in der Leerzeile, weil der Knopf zwischen mousedown und mouseup neu entsteht)
  const apply = () => { clearTimeout(tmr); if (!S.gf || !S.plan) return; let changed = false; for (const el of form.querySelectorAll('[data-f]')) if (String(S.gf[el.dataset.f] ?? '') !== el.value) { S.gf[el.dataset.f] = el.value; changed = true; } if (!changed) return; renderGroups(); legend(); drawLayers(['groups', 'collect']); };
  form.addEventListener('input', (e) => { clearTimeout(tmr); tmr = setTimeout(apply, e.target.type === 'search' ? 200 : 120); });
  form.addEventListener('change', apply);
  form.addEventListener('submit', (e) => { e.preventDefault(); apply(); });
  const reset = () => { if (!S.gf || !S.plan) return; S.gf = { ...GF0(), kind: S.gf.kind, sort: S.gf.sort, dir: S.gf.dir, op: S.plan.op, forOp: S.plan.op, forAgs: S.plan.ags }; syncGf(true); renderGroups(); legend(); drawLayers(['groups', 'collect']); };
  $('#ops-gf-reset').addEventListener('click', reset);
  panel.addEventListener('click', (e) => {
    if (e.target.closest('#ops-gf-reset2')) { reset(); $('#ops-gf-reset')?.focus(); return; }
    const k = e.target.closest('[data-gk]'); if (k && S.gf && S.plan) { S.gf.kind = k.dataset.gk; const l = S.gf.kind === 'deploy' ? 'groups' : 'collect'; if (!S.show[l]) { S.show[l] = true; legend(); drawLayers([l]); } renderGroups(); return; }
    const b = e.target.closest('[data-sort]'); if (b && S.gf && S.plan) { const key = b.dataset.sort; S.gf.dir = S.gf.sort === key ? (S.gf.dir === 'asc' ? 'desc' : 'asc') : GCOLS.find(c => c.key === key).dir; S.gf.sort = key; renderGroups(); $(`#ops-groups [data-sort="${key}"]`)?.focus(); }
  });
  $('#ops-gcsv').addEventListener('click', () => { if (!S.plan || !S.gf) return; download(`${S.gf.kind === 'deploy' ? 'deploy-spots' : t('file.pickupPlaces')}_${slug()}.csv`, '﻿' + O.placesCsv(groupView(S.gf.kind), { labelOf: geoLabel, nearOf, lang: lang() }), 'text/csv'); });
  const note = panel.querySelector('.note');
  if (note) note.textContent = t('ops.derivedFromObservationNo', { GROUP_MIN: O.GROUP_MIN, GROUP_M: O.GROUP_M, GROUP_MERGE_M: O.GROUP_MERGE_M });
}
// Eingaben aus S.gf setzen; ein gerade bedientes Feld behält seine Eingabe (Cursor), außer nach „Zurücksetzen“
function syncGf(force = false) {
  for (const el of document.querySelectorAll('#ops-gfilter [data-f]')) { if (!force && el === document.activeElement) continue; const v = S.gf?.[el.dataset.f] ?? ''; if (el.value !== String(v)) el.value = v; }
}
function renderGroups() {
  const p = S.plan, f = X.fmt, esc = X.esc, g = p.groups, gf = S.gf, kind = gf.kind, deploy = kind === 'deploy', all = g?.[kind] || [];
  const tbl = $('#ops-groups'), panel = tbl.closest('.panel'), noun = deploy ? t('ops.deployments') : t('ops.pickups');
  panel.querySelector('h2').textContent = deploy ? t('ops.presumedDeploySpotsOf') : t('ops.pickupPlacesOfOperatorFrom');
  tbl.closest('.tbl')?.setAttribute('aria-label', deploy ? t('ops.presumedDeploySpotsOf2') : t('ops.pickupPlacesOfOperator'));
  panel.querySelectorAll('[data-gk]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.gk === kind)));
  $('#ops-gf-cl').textContent = noun;
  const [cMin, cMax] = panel.querySelectorAll('[data-f="countMin"],[data-f="countMax"]'); cMin.setAttribute('aria-label', t('ops.from2', { noun })); cMax.setAttribute('aria-label', t('ops.to2', { noun }));
  // Anbieter-Auswahl: alle mit Orten dieser Art, dazu der Plan-Anbieter
  const opsHere = new Map(); for (const s of all) opsHere.set(s.op, (opsHere.get(s.op) || 0) + 1);
  const opList = [...new Set([p.op, ...g.ops])].sort((a, b) => a.localeCompare(b, 'de'));
  const sel = panel.querySelector('[data-f="op"]');
  sel.innerHTML = `<option value="all">${t('ops.allOperators2', { length: f(all.length) })}</option>` + opList.map(o => `<option value="${esc(o)}">${esc(o)} (${f(opsHere.get(o) || 0)})</option>`).join('');
  if (gf.op !== 'all' && !opList.includes(gf.op)) gf.op = 'all';
  const days = all.map(s => s.last).sort((a, b) => a - b), dmin = days.length ? dayStr(days[0]) : '', dmax = days.length ? dayStr(days[days.length - 1]) : '';
  for (const el of panel.querySelectorAll('input[type=date]')) { el.min = dmin; el.max = dmax; }
  syncGf();
  // Kopf mit Sortier-Knöpfen
  tbl.querySelector('thead').innerHTML = `<tr>${GCOLS.map(c => { const on = gf.sort === c.key; return `<th${c.n ? ' class="n"' : ''}${on ? ` aria-sort="${gf.dir === 'asc' ? 'ascending' : 'descending'}"` : ''}><button type="button" class="th-sort" data-sort="${c.key}" title="${t('ops.sortBy', { v0: c.label(), v1: on ? ` ${t('ops.now2', { v0: gf.dir === 'asc' ? t('common.ascending') : t('common.descending') })}` : '' })}">${c.label()}<i aria-hidden="true">${on ? (gf.dir === 'asc' ? '↑' : '↓') : ''}</i></button></th>`; }).join('')}</tr>`;
  const rows = groupView(kind), scope = gf.op === 'all' ? all : all.filter(s => s.op === gf.op);
  const where = t('ops.in', { v0: gf.op === 'all' ? t('ops.allOperators3') : gf.op, v1: X.muniName(p.ags) }), ev = scope.reduce((a, s) => a + s.count, 0), first = scope.length ? Math.min(...scope.map(s => s.first)) : null;
  const src = p.groupSrc?.source === 'groups' ? `${f(p.groupSrc.months.length)} ${p.groupSrc.months.length === 1 ? t('ops.monthlyFile') : t('ops.monthlyFiles')}${p.groupSrc.months.length ? ` (${p.groupSrc.months[0]}${p.groupSrc.months.length > 1 ? ` ${t('ops.to3', { v0: p.groupSrc.months[p.groupSrc.months.length - 1] })}` : ''})` : ''}` : t('ops.groupsJson30Days');
  $('#ops-groups-sub').textContent = t('ops.data', { v0: scope.length ? `${t('ops.atSince', { ev: f(ev), noun, length: f(scope.length), v3: scope.length === 1 ? t('ops.place') : t('ops.places'), v4: new Date(first).toLocaleDateString(fmtLocale()) })} · ` : '', where, src });
  $('#ops-gf-count').textContent = t('ops.ofPlacesShown', { length: f(rows.length), length2: f(all.length) });
  const tb = tbl.querySelector('tbody'), muni = esc(X.muniName(p.ags));
  if (!rows.length) {
    const filtered = !!(gf.q || gf.countMin || gf.countMax || gf.avgMin || gf.avgMax || gf.from || gf.to);
    const msg = p.groupSrc?.failed?.length && !all.length ? t('ops.groupEventsNotFullyLoadedSee')
      : !g.events.deploy && !g.events.collect ? t('ops.noGroupsObservedForYetPlace', { muni, GROUP_MIN: O.GROUP_MIN })
      : filtered ? `${t('ops.noPlaceMatchesFilters')}<button type="button" class="chip" id="ops-gf-reset2">${t('ops.resetFilters')}</button>`
      : t('ops.noObservedForYetAppearsAs', { where: esc(where), noun, GROUP_MIN: O.GROUP_MIN, v3: deploy ? t('ops.appear') : t('ops.disappear'), v4: all.length ? ` ${t('ops.otherOperatorsSetOperator', { length: f(all.length), v1: all.length === 1 ? t('ops.place') : t('ops.places2') })}` : '' });
    tb.innerHTML = `<tr><td colspan="${GCOLS.length}" class="empty">${msg}</td></tr>`; return;
  }
  tb.innerHTML = rows.map((s, i) => {
    const n = nearOf(s), k = geoKey(s.lat, s.lon), geo = GEO.get(k), ty = typesText(s.types);
    const main = geo ? `<span class="geo-main" translate="no" data-geo="${k}">${esc(geo)}</span>` : i < GROUP_GEO_TOP ? `<span class="geo-main" translate="no" data-geo="${k}" data-fallback="${t('ops.addressNotFound')}">${geo === null ? t('ops.addressNotFound') : `<span class="muted">${t('ops.lookingUpAddress')}</span>`}</span>` : osmLink(s.lat, s.lon);
    return `<tr><td>${main}<div class="sub-line">${geo !== undefined || i < GROUP_GEO_TOP ? osmLink(s.lat, s.lon) : ''}${(geo !== undefined || i < GROUP_GEO_TOP) && ty ? ' · ' : ''}${esc(ty)}</div></td>
    <td><span class="op"><i style="background:${X.opColor(s.op)}"></i>${esc(s.op)}</span></td>
    <td class="n"><b>${f(s.count)}</b><div class="sub-line">${t('ops.vehInTotal', { vehicles: f(s.vehicles) })}</div></td><td class="n">${whenText(s.last)}${s.count > 1 ? `<div class="sub-line">${t('ops.first', { v0: DAYMON.format(s.first) })}</div>` : ''}</td>
    <td class="n">${avgText(s.avg)}</td>
    <td class="n">${n ? t('ops.spotM', { rank: n.rank, v1: f(Math.round(n.d / 10) * 10), v2: n.d <= O.DEFAULTS.spotRadiusM ? `<div class="sub-line">${t('ops.withinSpotRadius')}</div>` : '' }) : `<span class="muted">${t('ops.noSpot')}</span>`}</td></tr>`;
  }).join('');
  queueGeo(rows.slice(0, GROUP_GEO_TOP));
}
const dayStr = (ms) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(ms);
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
      document.querySelectorAll(`[data-geo="${q.k}"]`).forEach(el => { const tq = GEO.get(q.k); el.textContent = tq || el.dataset.fallback || t('ops.cellCentre'); });
      for (const [s, m] of S.spotMarkers) if (geoKey(s.lat, s.lon) === q.k) m.getElement()?.setAttribute('title', spotTitle(s));
      if (geoQueue.length) await new Promise(res => setTimeout(res, 1100)); // Nominatim-Nutzungsregel: höchstens 1 Anfrage je Sekunde
    }
  } finally { geoBusy = false; }
}
// Straßenrouting: Reihenfolge je Tour nach echter Fahrzeit (OSRM-Matrix), dann Strecke und km nach Straße.
// Demo-Server: höchstens eine Anfrage je Sekunde, bis 100 Punkte je Matrix.
const pause = () => new Promise(res => setTimeout(res, 1100));
async function roadOptimize(r, p) {
  if (r.stops.length + 1 > 99) return false;
  const W = r.stops.map((st, k) => ({ lat: st.lat, lon: st.lon, i: k + 1, st })), D0 = { lat: p.depot.lat, lon: p.depot.lon, i: 0 };
  const coords = [D0, ...W].map(x => `${x.lon.toFixed(5)},${x.lat.toFixed(5)}`).join(';');
  const tq = (await X.getJson(`https://router.project-osrm.org/table/v1/driving/${coords}?annotations=duration,distance`, { timeout: 30000 })).json;
  if (tq?.code !== 'Ok' || S.plan !== p) return false; // Plan inzwischen ersetzt: nichts mehr in die alte Tour schreiben
  // optimiert wird nach Fahrzeugkilometern (Straßendistanz), Fahrzeit nur als Ersatz
  const cost = (a, b) => tq.distances?.[a.i]?.[b.i] ?? (tq.durations[a.i][b.i] != null ? tq.durations[a.i][b.i] * 8 : 1e9);
  // Umsetzen/Stationen: erst alle Abholungen, dann ausbringen; sonst eine Rundtour
  const pick = W.filter(x => x.st.type === 'pickup'), drop = W.filter(x => x.st.type === 'drop');
  let order;
  if (pick.length && drop.length) { const a = O.orderStops(pick, { start: D0, cost }); order = [...a, ...O.orderStops(drop, { start: a[a.length - 1], end: D0, cost })]; }
  else order = O.orderStops(W, { start: D0, end: D0, cost });
  r.stops = order.map(x => x.st);
  await pause();
  const pts = [p.depot, ...r.stops, p.depot];
  const j = (await X.getJson(`https://router.project-osrm.org/route/v1/driving/${pts.map(x => `${x.lon.toFixed(5)},${x.lat.toFixed(5)}`).join(';')}?overview=simplified&geometries=geojson`, { timeout: 30000 })).json;
  if (j?.code !== 'Ok' || S.plan !== p) return false;
  const rt = j.routes[0];
  S.routed[r.id] = { coords: rt.geometry.coordinates.map(([lo, la]) => [la, lo]) };
  r.km = +(rt.distance / 1000).toFixed(1); r.driveMin = Math.round(rt.duration / 60); r.totalMin = r.driveMin + r.handleMin; r.road = true;
  return true;
}
async function routeRuns() {
  const p = S.plan; if (!p || S.routing === p) return;
  const prev = S.routing; S.routing = p; if (prev) await pause(); // Schleife des vorigen Plans läuft noch aus: Abstand zum Demo-Server halten
  if (S.plan !== p) return;
  // Reihenfolge: fokussierte Tour, dann sichtbare Arten, dann der Rest
  // Reihenfolge wird je Schritt neu bestimmt: eine während des Routings angeklickte Tour kommt als nächste dran
  const tried = new Set(), total = allRuns().filter(r => !S.routed[r.id]).length;
  const next = () => allRuns().filter(r => !S.routed[r.id] && !tried.has(r.id)).sort((a, b) => (b.id === S.focus) - (a.id === S.focus) || (S.show[b.kind] ? 1 : 0) - (S.show[a.kind] ? 1 : 0))[0];
  const base = () => $('#ops-status').textContent.split(` · ${t('ops.routingWord')}`)[0].split(' · Straßenrouting')[0]; // vorigen Routing-Stand abschneiden (Sprache der Seite)
  let n = 0, r;
  try {
    while ((r = next())) {
      if (S.plan !== p) return;
      tried.add(r.id);
      status(t('ops.roadRoutingOrderAndKmByRoad', { v0: base(), v1: ++n, total }));
      try { await roadOptimize(r, p); } catch { /* Tour bleibt bei Luftlinie */ }
      if (S.plan !== p) return;
      renderTiles(); renderRuns(); markFocus(); drawRoutes(); // nur Routen-Ebenen, nicht alle Marker
      await pause();
    }
    // Zähler über S.routed: nach einer Neubewertung (Overpass) behalten die übrigen Touren ihr Routing
    const done = allRuns().filter(x => S.routed[x.id]).length;
    if (S.plan === p) status(t('ops.roadRoutingOsrmOfRunsByRoad', { v0: base(), done, length: allRuns().length, v3: done < allRuns().length ? t('ops.restStraightLine135') : '' }));
  } finally { if (S.routing === p) S.routing = null; }
}
// Methode als aufklappbarer Block über die volle Breite (das Panel trägt .prose mit 76ch; Breite hier per Inline-Stil aufgehoben),
// innen Spalten mit lesbarer Zeilenlänge
function renderMethod() {
  const A = O.AHP, f = (x) => x < 1 ? `1/${Math.round(1 / x)}` : String(x), el = $('#ops-method'), D = O.DEFAULTS;
  el.style.maxWidth = 'none';
  el.innerHTML = `<details><summary style="cursor:pointer"><h2 style="display:inline;margin:0">${t('ops.method')}</h2> <span class="muted small">${t('ops.demandDeploySpotsAhpRuns')}</span></summary>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,44ch),1fr));gap:0 var(--s5);margin-top:var(--s2)">
  <section><h3>${t('ops.measuredDemandNetOutflow')}</h3><p>${t('ops.perCell250MAndTimeOfDayBand', { prelimH: D.prelimH })}</p>
  <h3>${t('ops.needFleetShortfall')}</h3><p>${t('ops.needMax0NetOutflowHHorizon', { horizonH: D.horizonH, baseH: D.baseH, minPerSpot: D.minPerSpot, maxPerSpot: D.maxPerSpot, spotRadiusM: D.spotRadiusM })}</p>
  <h3>${t('ops.deploySpotsMcda')}</h3><p>${t('ops.factorsStandardisedTo0195th')}</p></section>
  <section><h3>${t('ops.weightsAhp')}</h3><div class="tbl"><table><thead><tr><th>AHP</th>${A.criteria.map(c => `<th class="n">${AHP_L[c]}</th>`).join('')}<th class="n">${t('ops.weight')}</th></tr></thead><tbody>${A.criteria.map((c, i) => `<tr><td>${AHP_L[c]}</td>${A.matrix[i].map(x => `<td class="n mono">${f(x)}</td>`).join('')}<td class="n mono"><b>${A.weights[c].toFixed(3)}</b></td></tr>`).join('')}</tbody></table></div>
  <p class="small">${t('ops.saatyScale1EquallyImportant3', { lambdaMax: X.fmt(A.lambdaMax, 3), cr: X.fmt(A.cr, 4) })}</p></section>
  <section><h3>${t('ops.runs')}</h3><p>${t('ops.rebalanceSurplusMeans', { minBatteryForMove: D.minBatteryForMove, v1: D.maxPickupM / 1000, swapThreshold: f(D.swapThreshold), swapRangeKm: f(D.swapRangeKm) })}</p>
  <p>${t('ops.bundlingByAreaOpenJob', { v0: D.maxRunMin / 60 })}</p>
  <p>${t('ops.orderPerRunNearestNeighbour', { speedKmh: D.speedKmh })}</p></section>
  <section><h3>${t('ops.limits')}</h3><p>${t('ops.idleTimeCountsFromFirst')}</p></section>
  </div></details>`;
}
