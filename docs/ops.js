// Mobility Pulse — Disposition: Deploy-Spots, Umsetz-, Akkutausch-, Werkstatt- und Stationstouren im Browser.
import * as O from './pulse-ops.js?v=mvxyn4sh';

let X; // Kontext aus app.js: state, CFG, getJson, esc, fmt, opColor, muniName, notice, clearNotice, loadBoundaries, loadUsageIndex, loadCells, loadOnce, loadGroups, TYPE
const $ = (s, el = document) => el.querySelector(s);
const S = { map: null, layers: {}, canvas: {}, spotMarkers: [], ops: {}, osm: {}, wfs: {}, zones: {}, depot: {}, pickDepot: false, plan: null, routed: {}, show: { demand: true, official: true, fleet: true, spots: true, groups: true, collect: false, rebalance: true, swap: false, workshop: false, station: true }, busy: false, retry: false, pending: null, again: false, rescore: null, stale: false, routing: null, op: null, focus: null,
  // Gruppen-Monatsdateien (groups/<JJJJ-MM>.json) und Ströme (flows/<Tag>.json): fertige Monate/Tage bleiben gecacht; index und laufender Monat werden bei neuem Stand neu geladen
  gidx: undefined, gdocs: {}, flowsIdx: undefined, flowDocs: {}, gf: null };
const RUN_COLOR = { rebalance: '#60a5fa', swap: '#34d399', workshop: '#ef6b6b', station: '#f59e0b' };
const RUN_KINDS = Object.keys(RUN_COLOR);
// Rechenschritte entkoppeln, damit Status gezeichnet wird und die Seite zwischen den Schritten reagiert
const tick = () => globalThis.scheduler?.yield ? scheduler.yield() : new Promise(r => setTimeout(r, 0));
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
  $('#ops-layers').addEventListener('click', (e) => {
    const j = e.target.closest('[data-jump]'); if (j) { const el = $(`#${j.dataset.jump}`)?.closest('.panel') || $(`#${j.dataset.jump}`); if (!el) return; el.tabIndex = -1; el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'start' }); return; }
    const b = e.target.closest('[data-l]'); if (!b || !S.plan) return; const k = b.dataset.l; S.show[k] = !S.show[k]; legend();
    if (RUN_COLOR[k]) drawRoutes(); else drawLayers([k]); // nur die umgeschaltete Ebene neu, alle anderen Marker bleiben stehen
  });
  // Klick auf Tourkarte oder „Auf Karte“: nur diese Tour zeichnen und einpassen; Links bleiben Links
  $('#ops-runs').addEventListener('click', (e) => { if (e.target.closest('a')) return; const c = e.target.closest('[data-run]'); if (c && S.plan) focusRun(c.dataset.run); });
  $('#ops-runs-all').addEventListener('click', () => { S.focus = null; markFocus(); drawRoutes(); fitAll(); });
  $('#ops-csv-spots').addEventListener('click', () => S.plan && download(`spots_${slug()}.csv`, O.spotsCsv(S.plan.spots.spots, { name: X.muniName(S.plan.ags) }), 'text/csv'));
  $('#ops-csv-analysis').addEventListener('click', () => S.plan && download(`spots-analyse_${slug()}.csv`, '﻿' + O.spotsAnalysisCsv(S.plan.spots.spots, S.plan.rebalance.needs, { horizonH: S.plan.params.horizonH, prelim: S.plan.spots.prelim }), 'text/csv'));
  $('#ops-csv-runs').addEventListener('click', () => S.plan && download(`touren_${slug()}.csv`, '﻿' + O.runsCsv(allRuns(), S.plan.depot), 'text/csv'));
  $('#ops-geojson').addEventListener('click', () => S.plan && download(`plan_${slug()}.geojson`, JSON.stringify(O.planGeoJson(S.plan.spots.spots, allRuns(), S.plan.depot)), 'application/geo+json'));
  document.addEventListener('click', (e) => { const a = e.target.closest('.ops-pick'); if (!a) return; e.preventDefault(); $('#sel-scope').value = a.dataset.ags; $('#sel-scope').dispatchEvent(new Event('change')); setTimeout(() => { location.hash = '#ops'; renderOps(); }, 0); });
  // OSM erneut versuchen (nach Ausfall gilt sonst 10 Min. Pause)
  document.addEventListener('click', (e) => { if (!e.target.closest('#ops-osm-retry')) return; const ags = S.plan?.ags || X.state.scope; delete S.osm[ags]; $('#ops-warn').innerHTML = ''; computePlan(); });
  document.addEventListener('click', (e) => { if (e.target.closest('#ops-retry')) { S.retry = true; computePlan(); } });
  // Einsatzzeit je Tour: Feld in den Parametern ergänzen, solange index.html es nicht selbst führt
  if (!$('#ops-maxh')) { const l = document.createElement('label'); l.innerHTML = 'Einsatz je Tour (h)<input type="number" id="ops-maxh" value="4" min="1" max="12" step="0.5">'; ($('#ops-maxruns')?.closest('label') || $('#ops-swapthr')?.closest('label'))?.after(l); }
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

const ascii = (t) => String(t).replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue').replace(/ß/g, 'ss').normalize('NFKD').replace(/[^\w-]+/g, '-');
const slug = () => `${ascii(X.muniName(S.plan.ags))}_${ascii(S.plan.op)}_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`;
function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` })); a.download = name; a.style.display = 'none'; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000); }
function status(html) { $('#ops-status').innerHTML = html; }
const allRuns = () => S.plan ? [...S.plan.rebalance.runs, ...(S.plan.station?.runs || []), ...S.plan.swaps.runs, ...S.plan.workshop.runs] : [];

function ensureMap() {
  if (S.map) { setTimeout(() => S.map.invalidateSize(), 50); return; }
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  S.map = L.map('ops-map', { preferCanvas: true, zoomAnimation: !still, fadeAnimation: !still, markerZoomAnimation: !still }).setView([51.1, 10.4], 6);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende' }).addTo(S.map);
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
  el.innerHTML = `<h2>Gemeinde wählen</h2><div class="sub">Die Disposition rechnet je Gemeinde und Anbieter. Oben im Filter ist jede Gemeinde wählbar; hier die größten Flotten.</div><div class="chips">${munis.map(m => `<a href="#ops" class="chip ops-pick" data-ags="${X.esc(m.ags)}">${X.esc(m.name)} <span class="muted">${X.fmt(m.avail)}</span></a>`).join('')}</div>`;
  for (const k in S.layers) S.layers[k].clearLayers();
  $('#ops-tiles').innerHTML = ''; $('#ops-runs').innerHTML = ''; $('#ops-warn').innerHTML = ''; $('#ops-spots-sub').textContent = ''; $('#ops-spots tbody').innerHTML = `<tr><td colspan="${SPOT_COLS}" class="empty"><b>Noch kein Plan.</b>Oben eine Gemeinde wählen.</td></tr>`; status('');
  $('#ops-groups-sub').textContent = ''; $('#ops-groups tbody').innerHTML = `<tr><td colspan="${GCOLS.length}" class="empty"><b>Noch kein Plan.</b>Oben eine Gemeinde wählen.</td></tr>`; $('#ops-runs-all').hidden = true; $('#ops-gf-count').textContent = '';
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
// Amtliche Daten der Stadt aus catalog.parking_reference (data/sources-manual.json → sources.json): je Eintrag ags, kind
// ('parking' = Abstellflächen, Standard; 'noPark' = Abstellverbotszonen), Quelle per wfs (+ typeNames), url (GeoJSON) oder
// ckan + dataset (Open-Data-Portal, Ressource GeoJSON/WFS), dazu name, license, source. Erfolg wird je Eintrag gecacht, Fehler nie.
async function fetchOfficial(ref) {
  let url = ref.wfs ? O.wfsGetFeatureUrl(ref.wfs, ref.typeNames) : ref.url || null;
  if (!url && ref.ckan && ref.dataset) {
    const r = await X.getJson(`${ref.ckan.replace(/\/$/, '')}/api/3/action/package_show?id=${encodeURIComponent(ref.dataset)}`, { timeout: 30000 });
    if (!r.ok) return { ok: false, error: r.status ? `Portal HTTP ${r.status}` : `Portal ${r.error}` };
    const res = O.pickCkanResource(r.json, ref.typeNames); if (!res) return { ok: false, error: 'Datensatz ohne GeoJSON-/WFS-Ressource' };
    url = res.url;
  }
  if (!url) return { ok: false, error: 'keine Adresse im Katalog' };
  const r = await X.getJson(url, { timeout: 45000 });
  if (!r.ok) return { ok: false, error: r.status ? `HTTP ${r.status}` : r.error === 'Netz/CORS' ? 'Netz/CORS (Server erlaubt keinen Abruf aus dem Browser oder ist nicht erreichbar)' : r.error };
  const fc = O.lonLatFc(r.json); if (fc.projected) return { ok: false, error: 'Koordinaten nicht in WGS84 (EPSG:4326)' };
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
const refLabel = (ref) => ref.name || (ref.kind === 'noPark' ? 'Amtliche Abstellverbotszonen' : 'Amtliche Abstellflächen');
const refCite = (ref) => `${ref.source ? `<a href="${X.esc(ref.source)}" target="_blank" rel="noopener">${X.esc(refLabel(ref))}</a>` : X.esc(refLabel(ref))}${ref.license ? ` (${X.esc(ref.license)}${ref.attribution ? `, ${X.esc(ref.attribution)}` : ''})` : ''}`;
// Sichtbare Warnungen zu fehlenden Kontextdaten (statt stillem Weiterrechnen)
function renderWarn(ags, osm, np, official, groupRes = S.plan?.groupSrc) {
  const w = [];
  if (groupRes?.failed?.length) w.push(`<div class="note warn" role="alert"><b>Gruppen-Ereignisse unvollständig</b> (${groupRes.failed.map(x => `<span class="mono">${X.esc(x)}</span>`).join(', ')} nicht geladen) – vermutete Deploy-Spots und Einsammel-Orte ${groupRes.source === 'groups.json' ? 'nur aus groups.json (30 Tage)' : 'ohne diese Monate'}. <button class="chip" id="ops-retry">Erneut versuchen</button></div>`);
  if ($('#ops-osm').checked && !osm && S.osm[ags]?.state === 'fail') w.push('<div class="note warn" role="alert"><b>OpenStreetMap nicht erreichbar.</b> Spots sind ohne ÖPNV-Nähe und Abstellflächen gerechnet (Faktoren Ö und A fehlen). <button class="chip" id="ops-osm-retry">Erneut versuchen</button></div>');
  if (np?.indexFailed) w.push('<div class="note warn" role="alert"><b>Zonenverzeichnis nicht geladen</b> (<span class="mono">zones/index.json</span>) – Spots ohne Abstellverbote und Pflicht-Abstellzonen. <button class="chip" id="ops-retry">Erneut versuchen</button></div>');
  else if (np?.failed) w.push(`<div class="note warn" role="alert"><b>Zonen nicht geladen</b> (${X.fmt(np.failed)} von ${X.fmt(np.files)} Zonenfeeds) – Spots ohne Abstellverbote. <button class="chip" id="ops-retry">Erneut versuchen</button></div>`);
  for (const { ref, error } of official?.failed || []) w.push(`<div class="note warn" role="alert"><b>${X.esc(refLabel(ref))} nicht geladen</b> (${X.esc(error)}) – Spots ${ref.kind === 'noPark' ? 'ohne diese Abstellverbote der Stadt' : 'ohne diese Abstellflächen'}. <button class="chip" id="ops-retry">Erneut versuchen</button></div>`);
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
    if (!stCode) { status('Gemeinde ist im Sammler-Stand nicht bekannt.'); emptyPlan('Gemeinde ist im Sammler-Stand nicht bekannt.'); return; }
    status('Lade Flotte und Nachfrage …');
    const [fleetRes, cellDocs] = await Promise.all([loadOpsDoc(stCode), loadCellDocs(stCode, +$('#ops-days').value || 3)]);
    if (stop()) return;
    const fleet = fleetRes.fleet;
    if (!fleet) {
      const missingFile = fleetRes.status === 404;
      status(missingFile ? `Noch keine Dispositionsdaten (<span class="mono">ops/${X.esc(stCode)}.json</span>). Sie entstehen mit dem nächsten Sammler-Lauf.`
        : `<span class="warn-text">Flotte nicht geladen</span> (<span class="mono">ops/${X.esc(stCode)}.json</span>: ${X.esc(fleetRes.error || `HTTP ${fleetRes.status}`)}). <button class="chip" id="ops-retry">Erneut versuchen</button>`);
      emptyPlan(missingFile ? 'Noch keine Dispositionsdaten für dieses Bundesland.' : 'Flotte nicht geladen – oben „Erneut versuchen“.'); return;
    }
    const inMuni = fleet.vehicles.filter(v => v.ags === ags), stInMuni = fleet.stations.filter(s => s.ags === ags);
    // Anbieter mit Fahrzeugen der gewählten Art zuerst; Stationsanbieter nur bei Rädern
    const type = $('#ops-type').value;
    const typeOk = (t) => type === 'all' || t === type;
    const counts = new Map(); for (const v of inMuni) if (typeOk(v.type)) counts.set(v.operator, (counts.get(v.operator) || 0) + 1);
    if (type === 'all' || type === 'bike' || type === 'ebike') for (const s of stInMuni) if (!counts.has(s.operator)) counts.set(s.operator, 0);
    const ops = [...counts].sort((a, b) => b[1] - a[1]);
    if (!ops.length) { const why = `Keine ${type === 'all' ? 'Fahrzeuge oder Stationen' : X.esc(X.TYPE[type] || type)} in ${X.esc(X.muniName(ags))} im letzten Sammler-Lauf – andere Fahrzeugart oder Gemeinde wählen.`; status(why); $('#ops-op').innerHTML = ''; emptyPlan(why); return; }
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
    if (!model.cells.size || model.hours <= 0) { status('Für diese Gemeinde gibt es noch keine Nachfrage-Messung (Zellen je Tageszeit werden seit dem 31.10.2026 gezählt).'); emptyPlan('Noch keine Nachfrage-Messung für diese Gemeinde – ohne Nachfrage keine Spots und Touren. Die Karte zeigt die Flotte.'); drawFleetOnly(vehicles, stations); return; }
    // Kontext
    const b = (await X.loadBoundaries(), st.boundaries?.features.find(f => f.properties.ags === ags)?.bbox) || null;
    const spacing = num('#ops-spacing', 220), topN = Math.min(60, num('#ops-n', 20)), horizonH = num('#ops-horizon', 3);
    status('Lade Zonen und Umgebung …');
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
      ['Spots bewerten', () => { plan.spots = scoreFor(plan, osm); }],
      ['Touren: Umsetzen', () => { plan.rebalance = rebalanceFor(plan); }],
      ['Touren: Akkutausch', () => { plan.swaps = O.planSwaps({ vehicles: vehicles.filter(v => !v.reserved), model, swapCapacity: params.swapCapacity, swapThreshold: params.swapThreshold, swapRangeKm: params.swapRangeKm, ...params.common }); }],
      ['Touren: Werkstatt', () => { plan.workshop = O.planWorkshop({ vehicles, workshopCapacity: params.van, ...params.common }); }],
      ['Touren: Stationen', () => { const sb = stations.length ? O.planStationBalance({ stations, vanCapacity: params.van, ...params.common }) : null; plan.station = sb?.stations ? sb : null; }],
    ];
    for (const [label, fn] of steps) { status(`${label} …`); await tick(); if (stop()) return; fn(); }
    plan.kpi = O.fleetKpis(vehicles, { swapThreshold: params.swapThreshold, swapRangeKm: params.swapRangeKm });
    S.plan = plan; S.routed = {}; S.focus = null; S.stale = false; plan.hhmm = hhmm();
    status('Karte und Tabellen …'); await tick(); if (S.plan !== plan) return;
    renderTiles(); renderRuns(); renderSpots(); renderGroups(); await tick(); if (S.plan !== plan) return;
    drawMap(true);
    status(planStatus(plan));
    X.econFor(ags, op, type).then(e => { if (S.plan === plan) { plan.econ = e || false; renderTiles(); } }).catch(() => { plan.econ = false; });
    if ($('#ops-route').checked) routeRuns();
  } catch (e) { console.error(e); status(`<span class="warn-text">Plan konnte nicht berechnet werden: ${X.esc(e.message)}.</span> Parameter prüfen und „Plan berechnen“ erneut drücken.`); }
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
  const osmNote = !$('#ops-osm').checked ? '' : osm ? ` · Umgebung: OSM (${osm.from === 'Sammler' ? `Sammler, ${new Date(osm.at).toLocaleDateString('de-DE')}` : X.esc(osm.from)})` : loading ? ' · ÖPNV und Abstellflächen werden aus OSM geladen (bis 2 Min.), Spots und Umsetzen rechnen sich danach neu' : '';
  return `<b>Berechnet ${p.hhmm}</b> · ${X.esc(p.op)} in ${X.esc(X.muniName(p.ags))} · Flotte vom ${new Date(p.at).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })} · Nachfrage aus ${p.model.days} Tag${p.model.days === 1 ? '' : 'en'} (${X.fmt(p.model.hours, 1)} Messstunden)${p.bandNote ? ` · ${p.bandNote}` : ''}${osmNote}`;
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
    status(`${planStatus(p)} · Spots mit OSM-Umgebung neu bewerten …`); await tick();
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
  const row = (n) => `<tr><td colspan="${n}" class="empty"><b>Kein Plan.</b>${why}</td></tr>`;
  $('#ops-tiles').innerHTML = ''; $('#ops-layers').innerHTML = ''; $('#ops-legend').innerHTML = ''; $('#ops-warn').innerHTML = '';
  $('#ops-runs').innerHTML = `<div class="empty"><b>Keine Touren.</b>${why}</div>`; $('#ops-runs-all').hidden = true;
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
    tile('Flotte', `${f(k.available)} / ${f(k.total)}`, `verfügbar / gemeldet · ${f(k.disabled)} gesperrt · Anteil an erfassten Fahrzeugen ${f(p.share * 100)} %`),
    tile('Nachfrage', `${f(sph * p.share, 1)} /h`, `Fahrtbeginne ${p.band === 'day' ? 'im Tagesmittel' : O.BANDS[p.band].label} · Markt ${f(sph, 1)} /h · Netto-Abfluss ${f(drain * p.share, 1)} /h aus ${f(drainCells.length)} Zellen · ${f(p.model.hours, 1)} Messstunden`),
    tile('Spots', `${f(p.spots.spots.length)}`, `Bedarf ${f(target)} Fzg. · Fehlmenge ${f(need)}${p.spots.excluded ? ` · ${f(p.spots.excluded)} Zellen ausgeschlossen (Zonen${p.spots.excludedBy?.official ? `, davon ${f(p.spots.excludedBy.official)} Abstellverbot laut Stadt` : ''})` : ''}`, need > target * 0.5 ? 'warn' : ''),
    tile('Akku & Standzeit', k.batteryKnown ? `${f(k.low)}` : 'k. A.', `${k.batteryKnown ? `unter ${num('#ops-swapthr', 20)} % und ${num('#ops-swaprange', 5)} km von ${f(k.batteryKnown)}` : 'kein Ladestand im Feed'} · ${f(k.idle24)} über 24 h unbewegt (Median ${k.idleMedianH == null ? '–' : f(k.idleMedianH, 1) + ' h'})`, (k.batteryKnown && k.low / k.batteryKnown > 0.25) || (k.idleKnown && k.idle24 / k.idleKnown > 0.3) ? 'warn' : ''),
    tile('Umsatz / Tag', p.econ === undefined ? '…' : p.econ?.revDay != null && p.econ.plausible ? (prelim ? `${rv(p.econ.revDay * 0.7)}–${rv(p.econ.revDay * 1.3)} €` : `${f(p.econ.revDay)} €`) : '—', p.econ === undefined ? 'Schätzung wird geladen' : !p.econ ? 'keine Fahrtdaten für diesen Anbieter' : `${prelim ? 'vorläufig (unter 3 Messtagen) · ' : ''}${p.econ.plausible ? '' : 'Fahrtenzahl unplausibel · '}${f(p.econ.rvd, 2)} Rides/Fzg./Tag · Auslastung ${p.econ.utilization == null ? '–' : f(p.econ.utilization * 100, 1) + ' %'} · netto`, `est${p.econ && !p.econ.plausible ? ' warn' : ''}`),
    tile('Touren', `${f(runs.length)}`, `${f(km, 1)} km · ${f(min / 60, 1)} h Einsatz · ${Object.keys(S.routed).length ? `${f(Object.keys(S.routed).length)}/${f(runs.length)} nach Straße` : $('#ops-route')?.checked ? 'Straßenrouting läuft …' : 'Luftlinie × 1,35'}`),
  ].join('');
}
function legend() {
  const chip = (k, label, color) => `<button class="chip${S.show[k] ? ' on' : ''}" data-l="${k}" aria-pressed="${S.show[k]}"${color ? ` style="${S.show[k] ? `background:color-mix(in srgb, ${color} 24%, var(--panel));border-color:${color};color:var(--fg)` : `border-color:${color}`}"` : ''}>${label}</button>`;
  const opc = X.opColor(S.plan.op), gv = (k) => groupView(k), mixed = S.gf?.op === 'all';
  $('#ops-layers').innerHTML = '<button class="chip" data-jump="ops-runs" title="Zur Liste der Touren springen (Karte und Marker überspringen)">Zu den Touren ↓</button>' + chip('demand', 'Netto-Abfluss') + chip('fleet', 'Flotte') + chip('spots', 'Spots') + chip('groups', 'Anbieter-Spots', opc) + chip('collect', 'Einsammel-Orte', opc) + (S.plan.official?.noPark.length ? chip('official', 'Amtliche Zonen', '#ef6b6b') : '') + chip('rebalance', 'Umsetzen', RUN_COLOR.rebalance) + (S.plan?.station ? chip('station', 'Stationen', RUN_COLOR.station) : '') + chip('swap', 'Akkutausch', RUN_COLOR.swap) + chip('workshop', 'Werkstatt', RUN_COLOR.workshop);
  $('#ops-legend').innerHTML = `<span><i class="sq" style="background:#49c7b0;border-color:#49c7b0"></i>Netto-Abfluss/h = Starts − Enden (${abbr('Zelle', 'Raster von etwa 250 × 250 m; Starts, Enden und Bestand werden je Zelle gezählt')} ≈ 250 m; kräftiger = mehr Abfluss, Zellen mit Zufluss ohne Fläche)</span><span><i class="dot" style="background:#ef6b6b"></i>gesperrt</span><span><i class="dot" style="background:#e3b341"></i>Akku niedrig</span><span><i class="dot" style="background:#c084fc"></i>&gt; 24 h unbewegt</span><span><b class="ops-spot-mini">1</b>Spot (gestrichelt = Rang unsicher)</span><span><b class="ops-spot-mini" style="background:var(--fg)">D</b>Depot</span>`
    + (S.show.groups && gv('deploy').length ? `<span>${groupSvg('deploy', opc, 12)}vermuteter Anbieter-Spot (Beobachtung, Größe = Ausbringungen${mixed ? ', Farbe = Anbieter' : ''}; Filter der Tabelle gelten)</span>` : '')
    + (S.show.collect && gv('collect').length ? `<span>${groupSvg('collect', opc, 12)}Einsammel-Ort (Beobachtung${mixed ? ', Farbe = Anbieter' : ''})</span>` : '')
    + (S.show.official && S.plan.official?.noPark.length ? `<span><i class="sq" style="background:#ef6b6b33;border-color:#ef6b6b;border-style:dashed"></i>Abstellverbot laut Stadt: ${S.plan.official.sources.filter(x => x.ref.kind === 'noPark').map(x => refCite(x.ref)).join(', ')}</span>` : '')
    + (S.plan.official?.points.length ? `<span class="muted">Abstellflächen: ${S.plan.official.sources.filter(x => x.ref.kind !== 'noPark').map(x => refCite(x.ref)).join(', ')}</span>` : '');
}
// Raute = Ausbringung, gestricheltes Sechseck = Einsammeln; Umriss in der Anbieterfarbe
function groupSvg(kind, color, size, css = 'display:inline-block;vertical-align:-1px;margin-right:6px;') {
  const shape = kind === 'deploy' ? '12,1.5 22.5,12 12,22.5 1.5,12' : '6.5,2.5 17.5,2.5 23,12 17.5,21.5 6.5,21.5 1,12';
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" style="${css}overflow:visible"><polygon points="${shape}" fill="${color}" fill-opacity=".14" stroke="${color}" stroke-width="2.5" vector-effect="non-scaling-stroke"${kind === 'collect' ? ' stroke-dasharray="4 3"' : ''}/></svg>`;
}
const WHEN = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }), DAYMON = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit' });
const whenText = (ms) => WHEN.format(ms); // feste Formatierer statt toLocaleString je Tabellenzeile
const avgText = (x) => X.fmt(x, Number.isInteger(x) ? 0 : 1);
const typesText = (t) => Object.entries(t || {}).sort((a, b) => b[1] - a[1]).map(([k]) => X.TYPE[k] || k).join(', ');
const groupPopup = (s, kind) => `<b>${kind === 'deploy' ? 'Vermuteter Deploy-Spot' : 'Einsammel-Ort'}</b> · ${X.esc(s.op)}<br>${X.fmt(s.count)}× ${kind === 'deploy' ? 'ausgebracht' : 'eingesammelt'} · erstmals ${whenText(s.first)} · zuletzt ${whenText(s.last)}<br>Ø ${avgText(s.avg)} Fahrzeuge (${X.fmt(s.vehicles)} gesamt)${typesText(s.types) ? ` · ${X.esc(typesText(s.types))}` : ''}<br><span style="color:var(--muted)">aus Beobachtung, keine Anbieterdaten</span>`;
const sgn = (x, d = 2) => x == null || !Number.isFinite(x) ? '—' : `${x > 0 ? '+' : x < 0 ? '−' : ''}${X.fmt(Math.abs(x), d)}`;
// Spot-Beschriftung für Screenreader/Tooltip: „Spot 3: <Lage>“ (Adresse, sobald Nominatim sie geliefert hat)
const spotTitle = (s) => `Spot ${s.rank}: ${GEO.get(geoKey(s.lat, s.lon)) || (s.park ? parkLabel(s.park) : 'Zellmitte')}`;
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
        () => `<b>Zelle ${esc(c.cell)}</b> · Markt, ${f(p.model.hours, 1)} Messstunden<br>Netto-Abfluss ${sgn(c.outPerHour)} /h (± ${f(c.outSe, 2)})<br>${f(c.starts)} Starts (${f(c.startsPerHour, 2)} /h) · ${f(c.ends)} Enden (${f(c.endsPerHour, 2)} /h)<br>Ø ${f(c.supplyAvg, 1)} verfügbare Fahrzeuge je Lauf${fl ? `<br>Ströme (${f(fl.days)} Tag${fl.days === 1 ? '' : 'e'}): ${f(c.flow?.out || 0)} ab · ${f(c.flow?.in || 0)} an` : ''}`).addTo(Lx.demand);
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
        () => `<b>${esc(v.operator)}</b> · ${esc(X.TYPE[v.type] || v.type)}<br>${v.disabled ? 'gesperrt · ' : v.reserved ? 'reserviert · ' : ''}${v.battery != null ? `Akku ${f(v.battery)} % · ` : ''}${v.idleMin != null ? `steht seit ${f(v.idleMin / 60, 1)} h` : ''}`).addTo(Lx.fleet);
    }
    for (const s of p.fleet.stations) withPop(L.circleMarker([s.lat, s.lon], { radius: 5, weight: 2, color: X.opColor(s.operator), fillColor: s.bookable ? X.opColor(s.operator) : 'transparent', fillOpacity: .6, renderer: S.canvas.fleet }),
      () => `<b>${esc(s.name || 'Station')}</b><br>${f(s.bookable)} buchbar · ${s.docks != null ? `${f(s.docks)} frei` : ''}${s.capacity ? ` · Kapazität ${f(s.capacity)}` : ''}`).addTo(Lx.fleet);
  }
  // Spot-, Gruppen- und Depot-Marker ohne Tab-Stopp (keyboard: false): dieselben Angaben stehen in den Tabellen unter der Karte,
  // so führt die Tastatur von den Ebenen-Chips ohne 20+ Zwischenschritte zur Tourenliste
  if (on('spots')) {
    const needBy = new Map(p.rebalance.needs.map(n => [n.cell, n]));
    for (const s of p.spots.spots) {
      const n = needBy.get(s.cell);
      L.circle([s.lat, s.lon], { radius: 150, weight: 1, color: '#49c7b0', fill: false, dashArray: s.stabilityLabel === 'stabil' ? null : '4 4', interactive: false }).addTo(Lx.spots);
      S.spotMarkers.push([s, L.marker([s.lat, s.lon], { icon: L.divIcon({ className: `ops-spot${s.stabilityLabel === 'stabil' ? '' : ' weak'}`, html: `${s.rank}`, iconSize: [24, 24] }), title: spotTitle(s), keyboard: false })
        .bindPopup(() => `<b>Spot ${s.rank}</b>${s.park ? ` · ${esc(parkLabel(s.park))}` : ''}<br>Bedarf ${f(s.target)} Fzg. · Bestand ${f(n?.have)} (150 m) · Fehlmenge ${f(n?.need)}<br>${f(s.startsPerHourOp, 2)} Starts/h − ${f(s.endsPerHourOp, 2)} Enden/h = Netto ${sgn(s.outPerHourOp)} /h (Anbieter, ${f(s.hours, 1)} Messstunden)<br>Score ${f(s.score, 2)} · Stabilität ${p.spots.prelim ? 'vorläufig' : s.stabilityLabel}`).addTo(Lx.spots)]);
    }
  }
  // Vermutete Anbieter-Spots und Einsammel-Orte (Gruppen-Ereignisse), Größe nach Anzahl, unter den eigenen Spots
  for (const [kind, l] of [['deploy', 'groups'], ['collect', 'collect']]) {
    if (!on(l)) continue;
    for (const s of groupView(kind)) { const z = Math.round(16 + 4 * Math.sqrt(Math.min(s.count, 25)));
      L.marker([s.lat, s.lon], { icon: L.divIcon({ className: 'ops-group', html: groupSvg(kind, X.opColor(s.op), z, ''), iconSize: [z, z] }), zIndexOffset: -500, keyboard: false, title: `${kind === 'deploy' ? 'Vermuteter Deploy-Spot' : 'Einsammel-Ort'} · ${s.op} · ${s.count}×` }).bindPopup(() => groupPopup(s, kind)).addTo(Lx[l]); }
  }
  if (keys.includes('depot')) L.marker([p.depot.lat, p.depot.lon], { icon: L.divIcon({ className: 'ops-spot depot', html: 'D', iconSize: [24, 24] }), title: 'Depot', keyboard: false }).bindPopup('Depot · „Depot setzen“ und auf die Karte klicken, um es zu verschieben').addTo(Lx.depot);
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
  $('#ops-map-sub').textContent = `${X.muniName(p.ags)} · ${p.op} · ${p.band === 'day' ? 'ganzer Tag' : O.BANDS[p.band].label}${S.focus ? ` · nur Tour ${S.focus}` : ''}`;
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
const parkLabel = (pk) => ({ station: 'Station des Anbieters (Pflicht-Abstellzone)', escooter: 'E-Scooter-Stellfläche', official: 'amtliche Abstellfläche', sharing: 'Sharing-/Mobilitätspunkt', rad: 'Radabstellanlage' }[pk.cat] || pk.cat) + (pk.name ? ` „${pk.name}“` : '');
const runTitle = (r) => `<b>${r.id} · ${RUN_LABEL[r.kind]}</b> · ${X.fmt(r.vehicles)} Fzg. · ${X.fmt(r.km, 1)} km · ${X.fmt(r.totalMin)} min`;
function renderRuns() {
  const p = S.plan, f = X.fmt, esc = X.esc, box = $('#ops-runs');
  // Neu zeichnen nach jeder Straßenroute: offene Stopplisten und den Tastaturfokus erhalten
  const open = new Set([...box.querySelectorAll('details[open]')].map(d => d.closest('[data-run]')?.dataset.run));
  const act = box.contains(document.activeElement) ? document.activeElement : null, actRun = act?.closest('[data-run]')?.dataset.run;
  const actSel = act?.matches('[data-fit]') ? '[data-fit]' : act?.matches('summary') ? 'summary' : act?.matches('a') ? `a:nth-of-type(${[...act.parentElement.querySelectorAll('a')].indexOf(act) + 1})` : null;
  const limit = p.rebalance.limitMin, hText = limit ? `${f(limit / 60, limit % 60 ? 1 : 0)} h` : '';
  const left = (n) => n ? ` · <span class="warn-text">${f(n)} nicht eingeplant</span> (Tourenzahl oder ${hText} Einsatz je Tour)` : '';
  const block = (kind, plan, head) => {
    const runs = plan?.runs || [];
    if (!plan) return '';
    const body = runs.length ? runs.map(r => {
      const pts = [p.depot, ...r.stops, p.depot]; const links = O.mapsLinks(pts);
      return `<div class="card ops-run${S.focus === r.id ? ' focus' : ''}" data-run="${r.id}" title="Nur diese Tour auf der Karte zeigen" style="border-left:3px solid ${RUN_COLOR[kind]}"><b>${r.id} · ${f(r.vehicles)} Fzg. · ${f(r.stops.length)} Stopps${r.kind === 'rebalance' && r.prio ? ` · Fehlmenge bis ${f(r.prio)}` : ''}</b>
        <p>${f(r.km, 1)} km · ${f(r.driveMin)} min Fahrt + ${f(r.handleMin)} min vor Ort = <b>${f(r.totalMin)} min</b>${S.routed[r.id] ? ' · Straße' : ''}${limit && r.totalMin > limit ? ` · <span class="warn-text">nach Straße über ${hText}</span>` : ''}</p>
        <details${open.has(r.id) ? ' open' : ''}><summary>Stoppliste</summary><ol class="small">${r.stops.map(s => `<li>${STOP_LABEL[s.type]} ${f(s.count)}${s.station ? ` · ${esc(s.station)} (${esc(s.fill)})` : ''}${s.spotRank ? ` · Spot ${s.spotRank}${s.need != null ? ` · Fehlmenge ${f(s.need)} (Bedarf ${f(s.target)}, Bestand ${f(s.have)})` : ''}` : ''}${s.battery?.length ? ` · Akku ${s.battery.slice(0, 6).join('/')} %` : ''}${s.idleMaxH ? ` · steht ${f(s.idleMaxH)} h` : ''}</li>`).join('')}</ol></details>
        <div class="foot"><button class="chip" data-fit="${r.id}">Auf Karte</button> ${links.map((u, i) => `<a href="${u}" target="_blank" rel="noopener" title="Google Maps erlaubt höchstens 10 Punkte je Route">${links.length > 1 ? `Route Teil ${i + 1} von ${links.length}` : 'Route'} ↗</a>`).join(' · ')}</div></div>`;
    }).join('') : '<div class="muted small">Keine Tour nötig.</div>';
    return `<h3 style="margin-top:12px">${RUN_LABEL[kind]}</h3><div class="sub">${head}</div><div class="cards" style="grid-template-columns:1fr">${body}</div>`;
  };
  const rb = p.rebalance, sw = p.swaps, ws = p.workshop, sb = p.station;
  box.innerHTML =
    (S.plan.fleet.vehicles.length ? '' : '<div class="note">Stationsbasierte Flotte: keine frei abgestellten Fahrzeuge, deshalb keine Deploy-Spots. Ausgleich zwischen Stationen unten.</div>') +
    block('rebalance', rb, `${f(rb.moves)} Umsetzungen aus ${f(rb.surplus)} Überschuss-Fahrzeugen · größte Fehlmenge zuerst (R1)${rb.missing > 0 ? ` · ${f(rb.missing)} Plätze bleiben offen (kein Überschuss in ${f(O.DEFAULTS.maxPickupM / 1000)} km)` : ''}${left(rb.unplanned)}`) +
    (sb ? block('station', sb, `${f(sb.empty)} fast leere, ${f(sb.full)} fast volle von ${f(sb.stations)} Stationen · ${f(sb.moves)} Räder umverteilen${left(sb.unplanned)}`) : '') +
    block('swap', sw, sw.below ? `${f(sw.below)} Fahrzeuge unter ${num('#ops-swapthr', 20)} % Ladestand und ${num('#ops-swaprange', 5)} km Reichweite · priorisiert nach Ladestand und Nachfrage am Standort${left(sw.unplanned)}` : 'Kein Fahrzeug unter der Schwelle oder kein Ladestand im Feed.') +
    block('workshop', ws, ws.disabled ? `${f(ws.disabled)} gesperrte Fahrzeuge, längste Sperre zuerst${left(ws.unplanned)}` : 'Keine gesperrten Fahrzeuge.');
  $('#ops-runs-sub').textContent = `Touren für ${p.op} · nach Stadtbereich gebündelt, höchstens ${hText} Einsatz je Tour · Google-Maps-Links mit höchstens 10 Punkten`;
  markFocus();
  if (actRun && actSel) box.querySelector(`[data-run="${actRun}"] ${actSel}`)?.focus({ preventScroll: true });
}
// Spot-Tabelle: alle Zahlen der Bedarfsrechnung sichtbar (Kopf ersetzt den aus index.html)
const SPOT_COLS = 12;
function spotHead() {
  const th = (t, tip, n = true) => `<th${n ? ' class="n"' : ''}><abbr title="${tip}">${t}</abbr></th>`;
  return `<tr><th class="n">Rang</th><th>Lage</th>${th('Starts/h', 'Fahrtbeginne je Stunde, Anteil des Anbieters; darunter Markt (alle Anbieter)')}${th('Enden/h', 'Fahrtenden je Stunde, Anteil des Anbieters; darunter Markt')}${th('Netto/h', 'Netto-Abfluss = Starts − Enden je Stunde (Anbieter-Anteil): + Fahrzeuge fließen ab, − sammeln sich an; ± Standardfehler √(Starts + Enden) ÷ Messstunden; Ströme = Fahrten mit bekanntem Start und Ziel (stabile Kennungen)')}`
    + `${th('Messung', 'Messstunden im gewählten Tageszeit-Band; darunter gezählte Starts und Enden der Zelle (Markt)')}${th('Bedarf', 'Bedarf = max(0, Netto/h) × Horizont + Grundbestand (Starts einer Stunde), aufgerundet, mindestens 2, höchstens 15 Fahrzeuge')}${th('Bestand', 'Verfügbare Fahrzeuge des Anbieters jetzt im Umkreis von 150 m (Umfeld, nicht nur die Koordinate); darunter Ø Markt-Bestand der Zelle je Lauf')}${th('Fehlmenge', 'Fehlmenge = Bedarf − Bestand; Umsetz-Touren bedienen die größte Fehlmenge zuerst')}`
    + `${th('Score', 'Gewichtete Summe der Faktoren Δ, N, Ö, A (AHP-Gewichte, 0–1)')}${th('Faktoren', 'Δ = Netto-Abfluss, N = Nachfrage (Starts/h), Ö = ÖPNV-Nähe, A = Abstellfläche; Balken 0–1', false)}${th('Stabilität', 'Wie sicher der Spot bei ±20 % Gewichtsänderung in der Auswahl bleibt; erst ab 24 Messstunden aussagekräftig', false)}</tr>`;
}
function renderSpots() {
  const p = S.plan, f = X.fmt, esc = X.esc, sp = p.spots, H = p.params.horizonH, D = O.DEFAULTS;
  const needBy = new Map(p.rebalance.needs.map(n => [n.cell, n]));
  const prelim = sp.prelim; // Netto-Abfluss und Sensitivität über wenige Messstunden sind nicht aussagekräftig
  // Ströme als Beleg: bei wie vielen Spots mit Netto-Abfluss zeigen auch die Ströme mehr Abfahrten als Ankünfte
  const fl = p.model.flow, withFlow = sp.spots.filter(s => s.outPerHourOp > 0 && s.flow && s.flow.out + s.flow.in >= 2), agree = withFlow.filter(s => s.flow.out > s.flow.in).length;
  const flowNote = fl ? ` · Ströme (stabile Kennungen, ${f(fl.days)} Tag${fl.days === 1 ? '' : 'e'}): ${f(fl.trips)} Fahrten mit Start und Ziel${fl.below ? `, ${f(fl.below)} unter Mindestschwelle` : ''}${withFlow.length ? ` – bei ${f(agree)} von ${f(withFlow.length)} Spots mit Netto-Abfluss auch mehr Abfahrten als Ankünfte` : ''}`
    : p.flowSrc?.indexed ? ' · Ströme: für diese Nachfrage-Tage noch keine Datei' : ' · Ströme: noch keine (flows/ erscheint nach dem ersten vollen Sammeltag)';
  $('#ops-spots-sub').innerHTML = esc(`${sp.candidates} Kandidatenzellen · Faktoren ${sp.activeFactors.map(k => O.AHP.labels[k]).join(', ')} · Bedarf = max(0, Netto/h) × ${f(H)} h + Starts/h × ${f(sp.baseH)} h, Anbieter-Anteil ${f(p.share * 100)} % · ${f(p.model.hours, 1)} Messstunden aus ${f(p.model.days)} Tag${p.model.days === 1 ? '' : 'en'}${sp.rho != null ? ` · Rangkorrelation Nachfrage/Netto-Abfluss ρ = ${f(sp.rho, 2)}` : ''}${flowNote} · ${p.np.geoms.length} Abstellverbots-${p.np.mandatory.length ? ` und ${p.np.mandatory.length} Pflicht-Abstell-` : ''}Polygone aus ${p.np.files} Zonenfeed${p.np.files === 1 ? '' : 's'} des Anbieters${sp.excludedBy?.operator ? ` (${sp.excludedBy.operator} Zellen ausgeschlossen)` : ''}${p.osm ? ` · OSM: ${f(p.osm.parking.length)} Abstellflächen, ${f(p.osm.transit.length)} Haltepunkte` : ''}`) +
    // amtliche Daten mit Quelle und Lizenz: Abstellflächen (Spot rastet ein), Abstellverbotszonen (Ausschluss, kein Gewicht)
    (p.official?.sources || []).map(({ ref, n }) => ` · ${refCite(ref)}: ${ref.kind === 'noPark' ? `${f(n)} Abstellverbotszonen, ${f(sp.excludedBy?.official || 0)} Zellen ausgeschlossen` : `${f(n)} amtliche Abstellflächen`}`).join('') +
    (prelim ? `<br><span class="warn-text">Vorläufig: Netto-Abfluss und Stabilität erst ab ${f(D.prelimH)} Messstunden aussagekräftig (bisher ${f(p.model.hours, 1)} h).</span>` : '');
  const bar = (x) => `<span class="bar" style="display:inline-block;width:38px;vertical-align:middle"><i style="width:${Math.round((x ?? 0) * 100)}%"></i></span>`;
  const F = { 'Δ': 'Netto-Abfluss (Starts − Enden je h)', N: 'Nachfrage (Starts/h)', Ö: 'ÖPNV-Nähe (Haltepunkte ≤ 200 m)', A: 'Abstellfläche in der Nähe' };
  const fac = (x, l) => `${bar(x)} <abbr title="${F[l]}: ${f((x ?? 0) * 100)} %">${l}</abbr>`;
  const formula = (s) => (s.drain > 0 ? `${f(s.outPerHourOp, 2)} × ${f(H)} h + ${f(s.base, 1)}` : `Grundbestand ${f(s.base, 1)}`) + (s.capped ? ` = ${f(s.needRaw, 1)}, max. ${f(D.maxPerSpot)}` : s.target > Math.ceil(s.needRaw - 1e-9) ? `, mind. ${f(D.minPerSpot)}` : '');
  $('#ops-spots tbody').innerHTML = sp.spots.map(s => { const n = needBy.get(s.cell); const k = geoKey(s.lat, s.lon); const g = s.rank <= GEO_TOP ? GEO.get(k) : undefined;
    const osm = osmLink(s.lat, s.lon);
    const place = s.park ? esc(parkLabel(s.park)) : 'Zellmitte';
    const main = s.rank > GEO_TOP ? place : `<span class="geo-main" data-geo="${k}" data-fallback="${place}">${g ? esc(g) : g === null ? place : '<span class="muted">Adresse wird gesucht …</span>'}</span>`;
    return `<tr><td class="n">${s.rank}</td><td>${main}<div class="sub-line">${osm}${s.rank <= GEO_TOP ? ` · ${place}` : ''}</div></td>
    <td class="n">${f(s.startsPerHourOp, 2)}<div class="sub-line">Markt ${f(s.startsPerHour, 2)}</div></td><td class="n">${f(s.endsPerHourOp, 2)}<div class="sub-line">Markt ${f(s.endsPerHour, 2)}</div></td>
    <td class="n"><b>${sgn(s.outPerHourOp)}</b><div class="sub-line">± ${f(s.outSeOp, 2)}${fl ? ` · Ströme ${f(s.flow?.out || 0)} ab / ${f(s.flow?.in || 0)} an` : ''}</div></td>
    <td class="n">${f(s.hours, 1)} h<div class="sub-line">${f(s.starts)} Starts · ${f(s.ends)} Enden</div></td>
    <td class="n"><b>${f(s.target)}</b><div class="sub-line">${formula(s)}</div></td><td class="n">${f(n?.have)}<div class="sub-line">Ø ${f(s.supplyAvg, 1)} Markt</div></td><td class="n" style="color:var(--${n?.need ? 'warn' : 'muted'})"><b>${f(n?.need)}</b></td>
    <td class="n">${f(s.score, 2)}</td>
    <td class="small" style="white-space:nowrap">${fac(s.factors.outflow, 'Δ')} ${fac(s.factors.demand, 'N')}${sp.activeFactors.includes('transit') ? ` ${fac(s.factors.transit, 'Ö')}` : ''}${sp.activeFactors.includes('parking') ? ` ${fac(s.factors.parking, 'A')}` : ''}</td>
    <td>${prelim ? `<span class="pill prelim" title="Erst ab ${f(D.prelimH)} Messstunden aussagekräftig">vorläufig</span>` : `<span class="pill ${s.stabilityLabel === 'stabil' ? 'live' : s.stabilityLabel === 'mittel' ? 'delayed' : 'stale'}">${s.stabilityLabel}</span>`}<div class="sub-line">${f(s.stability * 100)} % der Varianten</div></td></tr>`; }).join('') || `<tr><td colspan="${SPOT_COLS}" class="empty"><b>Keine Spots: zu wenig Nachfrage gemessen.</b>Unter „Parameter“ einen längeren Zeitraum bei „Nachfrage aus“ wählen.</td></tr>`;
  queueGeo(sp.spots.slice(0, GEO_TOP));
}
const osmLink = (lat, lon) => `<a href="https://www.openstreetmap.org/?mlat=${lat.toFixed(5)}&mlon=${lon.toFixed(5)}#map=18/${lat.toFixed(5)}/${lon.toFixed(5)}" target="_blank" rel="noopener" class="mono" title="Auf OpenStreetMap öffnen">${lat.toFixed(5)}, ${lon.toFixed(5)}</a>`;

// ---------- Vermutete Deploy-Spots und Einsammel-Orte (Gruppen-Ereignisse aller Monate, aus Beobachtung) ----------
// Orte je Anbieter und Art aus lib/pulse-ops.js groupPlaces (Ereignisse ≤ 60 m zusammengefasst). Tabelle mit Filter je Spalte (Lage, Anbieter,
// Anzahl, Ø Fahrzeuge, Zeitraum „zuletzt“), Sortierung per Spaltenkopf (Tastatur: Tab + Enter/Leertaste, aria-sort), CSV der gefilterten Zeilen.
// Die Kartenebenen „Anbieter-Spots“ und „Einsammel-Orte“ zeigen dieselbe Auswahl.
const GROUP_GEO_TOP = 10;
const GF0 = () => ({ kind: 'deploy', q: '', op: 'all', countMin: '', countMax: '', avgMin: '', avgMax: '', from: '', to: '', sort: 'count', dir: 'desc', forOp: null, forAgs: null });
const GCOLS = [
  { key: 'lage', label: () => 'Lage', n: false, dir: 'asc' },
  { key: 'op', label: () => 'Anbieter', n: false, dir: 'asc' },
  { key: 'count', label: () => S.gf?.kind === 'collect' ? 'Einsammlungen' : 'Ausbringungen', n: true, dir: 'desc' },
  { key: 'last', label: () => 'zuletzt', n: true, dir: 'desc' },
  { key: 'avg', label: () => 'Ø Fahrzeuge', n: true, dir: 'desc' },
  { key: 'near', label: () => 'nächster Plan-Spot', n: true, dir: 'asc' },
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
  head.insertAdjacentHTML('beforeend', '<div class="inline-form"><div class="ops-gkind" role="group" aria-label="Art der Orte"><button type="button" data-gk="deploy" aria-pressed="true">Ausbringungen</button><button type="button" data-gk="collect" aria-pressed="false">Einsammel-Orte</button></div><button type="button" id="ops-gcsv" title="Gefilterte Zeilen als CSV (Semikolon, UTF-8)">↓ CSV</button></div>');
  head.insertAdjacentHTML('afterend', `<form class="ops-gfilter" id="ops-gfilter" aria-label="Spalten filtern" novalidate>
    <label>Lage<input type="search" data-f="q" placeholder="Straße, Ort oder lat, lon" autocomplete="off"></label>
    <label>Anbieter<select data-f="op"><option value="all">Alle Anbieter</option></select></label>
    <div class="rng" role="group" aria-labelledby="ops-gf-cl"><span id="ops-gf-cl">Ausbringungen</span><span><input type="number" min="1" step="1" inputmode="numeric" data-f="countMin" placeholder="von" aria-label="Ausbringungen von"> – <input type="number" min="1" step="1" inputmode="numeric" data-f="countMax" placeholder="bis" aria-label="Ausbringungen bis"></span></div>
    <div class="rng" role="group" aria-labelledby="ops-gf-al"><span id="ops-gf-al">Ø Fahrzeuge</span><span><input type="number" min="0" step="0.5" inputmode="decimal" data-f="avgMin" placeholder="von" aria-label="Ø Fahrzeuge von"> – <input type="number" min="0" step="0.5" inputmode="decimal" data-f="avgMax" placeholder="bis" aria-label="Ø Fahrzeuge bis"></span></div>
    <div class="rng dates" role="group" aria-labelledby="ops-gf-dl"><span id="ops-gf-dl">Zuletzt (Zeitraum)</span><span><input type="date" data-f="from" aria-label="zuletzt ab"> – <input type="date" data-f="to" aria-label="zuletzt bis"></span></div>
    <div class="ops-actions"><span class="small muted" id="ops-gf-count" role="status"></span><button type="button" id="ops-gf-reset">Filter zurücksetzen</button></div></form>`);
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
  $('#ops-gcsv').addEventListener('click', () => { if (!S.plan || !S.gf) return; download(`${S.gf.kind === 'deploy' ? 'deploy-spots' : 'einsammel-orte'}_${slug()}.csv`, '﻿' + O.placesCsv(groupView(S.gf.kind), { labelOf: geoLabel, nearOf }), 'text/csv'); });
  const note = panel.querySelector('.note');
  if (note) note.textContent = `Abgeleitet aus Beobachtung, keine Anbieterdaten: Ein Ereignis entsteht, wenn mindestens ${O.GROUP_MIN} Fahrzeuge eines Anbieters in einem Sammler-Lauf gemeinsam innerhalb von ${O.GROUP_M} m auftauchen (Ausbringung) bzw. verschwinden (Einsammeln). Ereignisse bis ${O.GROUP_MERGE_M} m Abstand sind zu einem Ort zusammengefasst. Gespeichert dauerhaft je Monat (groups/JJJJ-MM.json), nichts wird gelöscht.`;
}
// Eingaben aus S.gf setzen; ein gerade bedientes Feld behält seine Eingabe (Cursor), außer nach „Zurücksetzen“
function syncGf(force = false) {
  for (const el of document.querySelectorAll('#ops-gfilter [data-f]')) { if (!force && el === document.activeElement) continue; const v = S.gf?.[el.dataset.f] ?? ''; if (el.value !== String(v)) el.value = v; }
}
function renderGroups() {
  const p = S.plan, f = X.fmt, esc = X.esc, g = p.groups, gf = S.gf, kind = gf.kind, deploy = kind === 'deploy', all = g?.[kind] || [];
  const tbl = $('#ops-groups'), panel = tbl.closest('.panel'), noun = deploy ? 'Ausbringungen' : 'Einsammlungen';
  panel.querySelector('h2').textContent = deploy ? 'Vermutete Deploy-Spots des Anbieters (aus Beobachtung)' : 'Einsammel-Orte des Anbieters (aus Beobachtung)';
  tbl.closest('.tbl')?.setAttribute('aria-label', deploy ? 'Vermutete Deploy-Spots des Anbieters' : 'Einsammel-Orte des Anbieters');
  panel.querySelectorAll('[data-gk]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.gk === kind)));
  $('#ops-gf-cl').textContent = noun;
  const [cMin, cMax] = panel.querySelectorAll('[data-f="countMin"],[data-f="countMax"]'); cMin.setAttribute('aria-label', `${noun} von`); cMax.setAttribute('aria-label', `${noun} bis`);
  // Anbieter-Auswahl: alle mit Orten dieser Art, dazu der Plan-Anbieter
  const opsHere = new Map(); for (const s of all) opsHere.set(s.op, (opsHere.get(s.op) || 0) + 1);
  const opList = [...new Set([p.op, ...g.ops])].sort((a, b) => a.localeCompare(b, 'de'));
  const sel = panel.querySelector('[data-f="op"]');
  sel.innerHTML = `<option value="all">Alle Anbieter (${f(all.length)})</option>` + opList.map(o => `<option value="${esc(o)}">${esc(o)} (${f(opsHere.get(o) || 0)})</option>`).join('');
  if (gf.op !== 'all' && !opList.includes(gf.op)) gf.op = 'all';
  const days = all.map(s => s.last).sort((a, b) => a - b), dmin = days.length ? dayStr(days[0]) : '', dmax = days.length ? dayStr(days[days.length - 1]) : '';
  for (const el of panel.querySelectorAll('input[type=date]')) { el.min = dmin; el.max = dmax; }
  syncGf();
  // Kopf mit Sortier-Knöpfen
  tbl.querySelector('thead').innerHTML = `<tr>${GCOLS.map(c => { const on = gf.sort === c.key; return `<th${c.n ? ' class="n"' : ''}${on ? ` aria-sort="${gf.dir === 'asc' ? 'ascending' : 'descending'}"` : ''}><button type="button" class="th-sort" data-sort="${c.key}" title="Nach „${c.label()}“ sortieren${on ? ` (jetzt ${gf.dir === 'asc' ? 'aufsteigend' : 'absteigend'})` : ''}">${c.label()}<i aria-hidden="true">${on ? (gf.dir === 'asc' ? '↑' : '↓') : ''}</i></button></th>`; }).join('')}</tr>`;
  const rows = groupView(kind), scope = gf.op === 'all' ? all : all.filter(s => s.op === gf.op);
  const where = `${gf.op === 'all' ? 'alle Anbieter' : gf.op} in ${X.muniName(p.ags)}`, ev = scope.reduce((a, s) => a + s.count, 0), first = scope.length ? Math.min(...scope.map(s => s.first)) : null;
  const src = p.groupSrc?.source === 'groups' ? `${f(p.groupSrc.months.length)} Monatsdatei${p.groupSrc.months.length === 1 ? '' : 'en'}${p.groupSrc.months.length ? ` (${p.groupSrc.months[0]}${p.groupSrc.months.length > 1 ? ` bis ${p.groupSrc.months[p.groupSrc.months.length - 1]}` : ''})` : ''}` : 'groups.json (30 Tage)';
  $('#ops-groups-sub').textContent = `${scope.length ? `${f(ev)} ${noun} an ${f(scope.length)} Ort${scope.length === 1 ? '' : 'en'} seit ${new Date(first).toLocaleDateString('de-DE')} · ` : ''}${where} · Daten: ${src}`;
  $('#ops-gf-count').textContent = `${f(rows.length)} von ${f(all.length)} Orten angezeigt`;
  const tb = tbl.querySelector('tbody'), muni = esc(X.muniName(p.ags));
  if (!rows.length) {
    const filtered = !!(gf.q || gf.countMin || gf.countMax || gf.avgMin || gf.avgMax || gf.from || gf.to);
    const msg = p.groupSrc?.failed?.length && !all.length ? `<b>Gruppen-Ereignisse nicht vollständig geladen.</b>Siehe Hinweis oben („Erneut versuchen“).`
      : !g.events.deploy && !g.events.collect ? `Für ${muni} noch keine Gruppen beobachtet – ein Ort entsteht, sobald mindestens ${O.GROUP_MIN} Fahrzeuge eines Anbieters in einem Sammler-Lauf zusammen auftauchen (Ausbringen) bzw. verschwinden (Einsammeln).`
      : filtered ? `<b>Kein Ort passt zu den Filtern.</b><button type="button" class="chip" id="ops-gf-reset2">Filter zurücksetzen</button>`
      : `Für ${esc(where)} noch keine ${noun} beobachtet – entsteht, sobald mindestens ${O.GROUP_MIN} Fahrzeuge des Anbieters zusammen ${deploy ? 'auftauchen' : 'verschwinden'}.${all.length ? ` Andere Anbieter: ${f(all.length)} Ort${all.length === 1 ? '' : 'e'} (Filter „Anbieter“ auf „Alle Anbieter“).` : ''}`;
    tb.innerHTML = `<tr><td colspan="${GCOLS.length}" class="empty">${msg}</td></tr>`; return;
  }
  tb.innerHTML = rows.map((s, i) => {
    const n = nearOf(s), k = geoKey(s.lat, s.lon), geo = GEO.get(k), ty = typesText(s.types);
    const main = geo ? `<span class="geo-main" data-geo="${k}">${esc(geo)}</span>` : i < GROUP_GEO_TOP ? `<span class="geo-main" data-geo="${k}" data-fallback="Adresse nicht gefunden">${geo === null ? 'Adresse nicht gefunden' : '<span class="muted">Adresse wird gesucht …</span>'}</span>` : osmLink(s.lat, s.lon);
    return `<tr><td>${main}<div class="sub-line">${geo !== undefined || i < GROUP_GEO_TOP ? osmLink(s.lat, s.lon) : ''}${(geo !== undefined || i < GROUP_GEO_TOP) && ty ? ' · ' : ''}${esc(ty)}</div></td>
    <td><span class="op"><i style="background:${X.opColor(s.op)}"></i>${esc(s.op)}</span></td>
    <td class="n"><b>${f(s.count)}</b><div class="sub-line">${f(s.vehicles)} Fzg. gesamt</div></td><td class="n">${whenText(s.last)}${s.count > 1 ? `<div class="sub-line">erstmals ${DAYMON.format(s.first)}</div>` : ''}</td>
    <td class="n">${avgText(s.avg)}</td>
    <td class="n">${n ? `Spot ${n.rank} · ${f(Math.round(n.d / 10) * 10)} m${n.d <= O.DEFAULTS.spotRadiusM ? '<div class="sub-line">im Spot-Radius</div>' : ''}` : '<span class="muted">kein Spot</span>'}</td></tr>`;
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
      document.querySelectorAll(`[data-geo="${q.k}"]`).forEach(el => { const t = GEO.get(q.k); el.textContent = t || el.dataset.fallback || 'Zellmitte'; });
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
  const t = (await X.getJson(`https://router.project-osrm.org/table/v1/driving/${coords}?annotations=duration,distance`, { timeout: 30000 })).json;
  if (t?.code !== 'Ok' || S.plan !== p) return false; // Plan inzwischen ersetzt: nichts mehr in die alte Tour schreiben
  // optimiert wird nach Fahrzeugkilometern (Straßendistanz), Fahrzeit nur als Ersatz
  const cost = (a, b) => t.distances?.[a.i]?.[b.i] ?? (t.durations[a.i][b.i] != null ? t.durations[a.i][b.i] * 8 : 1e9);
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
  const base = () => $('#ops-status').textContent.split(' · Straßenrouting')[0];
  let n = 0, r;
  try {
    while ((r = next())) {
      if (S.plan !== p) return;
      tried.add(r.id);
      status(`${base()} · Straßenrouting ${++n}/${total} (Reihenfolge und km nach Straße) …`);
      try { await roadOptimize(r, p); } catch { /* Tour bleibt bei Luftlinie */ }
      if (S.plan !== p) return;
      renderTiles(); renderRuns(); markFocus(); drawRoutes(); // nur Routen-Ebenen, nicht alle Marker
      await pause();
    }
    // Zähler über S.routed: nach einer Neubewertung (Overpass) behalten die übrigen Touren ihr Routing
    const done = allRuns().filter(x => S.routed[x.id]).length;
    if (S.plan === p) status(`${base()} · Straßenrouting OSRM: ${done} von ${allRuns().length} Touren nach Straße${done < allRuns().length ? ', Rest Luftlinie × 1,35' : ''}`);
  } finally { if (S.routing === p) S.routing = null; }
}
// Methode als aufklappbarer Block über die volle Breite (das Panel trägt .prose mit 76ch; Breite hier per Inline-Stil aufgehoben),
// innen Spalten mit lesbarer Zeilenlänge
function renderMethod() {
  const A = O.AHP, f = (x) => x < 1 ? `1/${Math.round(1 / x)}` : String(x), el = $('#ops-method'), D = O.DEFAULTS;
  el.style.maxWidth = 'none';
  el.innerHTML = `<details><summary style="cursor:pointer"><h2 style="display:inline;margin:0">Methode</h2> <span class="muted small">Nachfrage, Deploy-Spots (AHP), Touren, Grenzen</span></summary>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,44ch),1fr));gap:0 var(--s5);margin-top:var(--s2)">
  <section><h3>Nachfrage gemessen: Netto-Abfluss</h3><p>Je Zelle (≈ 250 m) und Tageszeit-Band zählt der Sammler alle 20 Minuten Fahrtbeginne (verfügbares Fahrzeug verschwindet bzw. stabile Kennung fährt los) und Fahrtenden (Fahrzeug taucht auf bzw. kommt an), über alle Anbieter (Markt); Läufe nach einer Lücke über 45 Minuten zählen nicht. <b>Netto-Abfluss</b> = (Starts − Enden) ÷ Messstunden: positiv heißt, aus der Zelle fahren mehr Fahrzeuge weg als ankommen, sie braucht Nachschub; negativ heißt, Fahrzeuge sammeln sich an (Quelle für Umsetzungen). Der Standardfehler √(Starts + Enden) ÷ Messstunden steht unter jedem Wert. Der Anbieter bekommt seinen aktuellen Anteil am verfügbaren Bestand der Gemeinde. Ab dem 02.11.2026 belegen Start-Ziel-Ströme (flows/&lt;Tag&gt;.json, nur Anbieter mit stabilen Kennungen, Zeilen ab 2 Fahrten) Abfluss und Zufluss je Zelle zusätzlich: angezeigt wird, bei wie vielen Spots mit Netto-Abfluss auch die Ströme mehr Abfahrten als Ankünfte zeigen. Unter ${D.prelimH} Messstunden gelten Netto-Abfluss und Stabilität als vorläufig.</p>
  <h3>Bedarf, Bestand, Fehlmenge</h3><p><b>Bedarf</b> = max(0, Netto-Abfluss/h) × Horizont (Standard ${D.horizonH} h) + Grundbestand; Grundbestand = Fahrtbeginne/h × ${D.baseH} h, weil Starts und Enden nicht gleichzeitig kommen. Aufgerundet, mindestens ${D.minPerSpot}, höchstens ${D.maxPerSpot} Fahrzeuge je Spot. <b>Bestand</b> = verfügbare Fahrzeuge des Anbieters jetzt im Umkreis von ${D.spotRadiusM} m (das Umfeld zählt, nicht nur die Koordinate). <b>Fehlmenge</b> = Bedarf − Bestand. Beispiel: 2,0 Starts/h und 1,2 Enden/h → Netto 0,8/h × 3 h + 2,0 = 4,4 → Bedarf 5; 2 Fahrzeuge im Umkreis → Fehlmenge 3.</p>
  <h3>Deploy-Spots (MCDA)</h3><p>Faktoren auf 0–1 standardisiert (95. Perzentil als Obergrenze, Richtung: mehr = besser): <b>Netto-Abfluss</b> (nur positive Werte; Zufluss = 0), <b>Nachfrage</b> (Starts/h), <b>ÖPNV-Nähe</b> (Haltepunkte ≤ 200 m, 3 = voll), <b>Abstellfläche</b> (E-Scooter-Stellfläche, amtliche Fläche oder Sharing-Punkt ≤ 160 m = 1, Radabstellanlage ≤ 80 m = 0,5). Netto-Abfluss ersetzt die frühere „Unterversorgung“ (Starts ÷ Bestand), die nur abgeleitet war. Ob Nachfrage und Netto-Abfluss dasselbe messen, zeigt die Rangkorrelation ρ über die Kandidatenzellen über der Spot-Tabelle (ganzer Tag, Stand 01.11.2026: Stuttgart 0,13, Berlin 0,24, Duisburg 0,21 – die beiden Faktoren messen Verschiedenes, keine Doppelzählung). Der Spot rastet auf die Fläche ein. Abstellverbote aus den GBFS-Zonen des Anbieters sind ein Ausschluss, kein Gewicht; ebenso amtliche Abstellverbotszonen der Stadt (Berlin: Parkverbotszonen Mikromobilität, München: Geofences im Umkreis von 100 m um die Abstellflächen), außer der Spot liegt auf einer ausgewiesenen Abstellfläche. Amtliche Abstellflächen (Berlin, München) zählen wie E-Scooter-Stellflächen; Quelle und Lizenz stehen über der Spot-Tabelle und in der Legende. In Pflicht-Abstellzonen (GBFS <span class="mono">station_parking</span>, z. B. Dott Leipzig) rastet der Spot auf die nächste Station des Anbieters (≤ 150 m) ein, ohne Station fällt die Zelle weg. Mindestabstand zwischen Spots.</p></section>
  <section><h3>Gewichte (AHP)</h3><div class="tbl"><table><thead><tr><th>AHP</th>${A.criteria.map(c => `<th class="n">${A.labels[c]}</th>`).join('')}<th class="n">Gewicht</th></tr></thead><tbody>${A.criteria.map((c, i) => `<tr><td>${A.labels[c]}</td>${A.matrix[i].map(x => `<td class="n mono">${f(x)}</td>`).join('')}<td class="n mono"><b>${A.weights[c].toFixed(3)}</b></td></tr>`).join('')}</tbody></table></div>
  <p class="small">Saaty-Skala (1 = gleich wichtig, 3 = etwas wichtiger, 5 = deutlich wichtiger; Zeile gegen Spalte). Netto-Abfluss 2× Nachfrage: der Abfluss ist der direkte Grund nachzufüllen, die Nachfrage sichert, dass der Spot genutzt wird. Gewichte = Haupteigenvektor, λ<sub>max</sub> = ${X.fmt(A.lambdaMax, 3)}, Konsistenzquote CR = ${X.fmt(A.cr, 4)} (&lt; 0,10; nachgerechnet mit numpy). Fehlt ein Faktor (z. B. OSM nicht erreichbar), wird er ausgelassen und die übrigen Gewichte neu normiert. <b>Sensitivität:</b> jedes Gewicht ±20 %, neu normiert; „stabil“ = Spot bleibt in allen Varianten in der Auswahl, „mittel“ ≥ 75 %, sonst „unsicher“.</p></section>
  <section><h3>Touren</h3><p><b>Umsetzen:</b> Überschuss sind Fahrzeuge über dem Bedarf ihrer Zelle, Fahrzeuge über 24 h unbewegt und überzählige an Spots; Akku unter ${D.minBatteryForMove} % wird nicht umgesetzt, sondern getauscht. Überschuss je Zelle nach derselben Bedarfsformel. <b>Vorrang nach Fehlmenge:</b> der Spot mit der größten Fehlmenge bekommt zuerst die nächsten Überschussfahrzeuge (≤ ${D.maxPickupM / 1000} km) und eröffnet zuerst eine Tour; R1 deckt die größte Fehlmenge. Erst einsammeln, dann ausbringen. <b>Akkutausch:</b> nur, wenn Ladestand unter ${f(D.swapThreshold)} % <b>und</b> Reichweite unter ${f(D.swapRangeKm)} km liegen (Werte im Formular; meldet ein Feed nur eines von beiden, entscheidet dieses). Priorität = 0,6 × Energielücke + 0,4 × Nachfrage am Standort, höchstens 50 Akkus je Tour. <b>Werkstatt:</b> gesperrte Fahrzeuge, längste Sperre zuerst. <b>Stationen:</b> Füllgrad ≤ 20 % aus Stationen ≥ 80 % auf 50 % auffüllen.</p>
  <p><b>Bündelung nach Raum:</b> der vom Depot entfernteste offene Auftrag eröffnet eine Tour (Umsetzen: der Auftrag zum Spot mit der größten Fehlmenge, bei Gleichstand der entfernteste), dann kommen die dem Tour-Mittelpunkt nächsten hinzu, bis die Kapazität erreicht ist (Umsetzen: Mittelpunkt aus Abhol- und Zielort). Dauert die Tour länger als der eingestellte Einsatz (Standard ${D.maxRunMin / 60} h, Fahrt + vor Ort), behält sie die meisten nahen Aufträge, die noch hineinpassen; die fernen gehen zurück und bilden eigene Touren. Was über die Tourenzahl je Art hinausgeht, steht als „nicht eingeplant“ an der Tourenliste.</p>
  <p><b>Reihenfolge je Tour:</b> Nächster Nachbar aus sechs Startpunkten, dann 2-opt und Or-opt auf einer Distanzmatrix der Tour; jeder Zug wird über die geänderten Kanten bewertet (bei asymmetrischen Straßenkosten mit Vor- und Rückwärtssummen), das Ergebnis ist dasselbe wie mit der vollen Tourberechnung. Mit „Straßenrouting“ (Standard) wird die Reihenfolge nach Fahrzeugkilometern auf der Straße optimiert (OSRM-Distanzmatrix), km und Fahrzeit kommen aus der gefahrenen Route (OSRM-Demo-Server, ohne Verkehr); die Einsatzgrenze gilt für die Planung, nach Straße kann eine Tour sie leicht überschreiten (markiert). Ohne Straßenrouting oder bei Ausfall: Luftlinie × 1,35 bei ${D.speedKmh} km/h. Vor-Ort-Zeiten: 1,5 min abholen, 1 min ausbringen, 2,5 min Akku, 3 min Werkstatt.</p></section>
  <section><h3>Grenzen</h3><p>Standzeit zählt ab der ersten Sichtung durch den Sammler. Anbieter mit wechselnden Kennungen erzeugen mehr Starts und Ziele als echte Fahrten; bei ihnen ist die Nachfrage relativ zu lesen. Unterdrückte Nachfrage (niemand findet ein Fahrzeug) wird nicht gemessen. Ausbringungen des Anbieters mit neuen Kennungen zählen als Fahrtende: an seinen eigenen Deploy-Orten ist der Netto-Abfluss deshalb eine Untergrenze. Abstellflächen und Haltepunkte aus OpenStreetMap sind so vollständig wie die Karte. Bei neuem Sammler-Stand rechnet die Disposition mit der neuen Flotte neu, sobald sie angezeigt wird.</p></section>
  </div></details>`;
}
