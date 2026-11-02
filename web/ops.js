// Mobility Pulse — Disposition: Deploy-Spots, Umsetz-, Akkutausch-, Werkstatt- und Stationstouren im Browser.
import * as O from './pulse-ops.js';
import { t, tMap, lang, dateFmt, fmtLocale } from './i18n.js';
import { mapKeys } from './mapkeys.js';
import { mbBadge, mbBase } from './report.js';

let X; // Kontext aus app.js: state, CFG, getJson, esc, fmt, opColor, muniName, notice, clearNotice, loadBoundaries, loadUsageIndex, loadCells, loadOnce, loadGroups, TYPE
const $ = (s, el = document) => el.querySelector(s);
const S = { map: null, layers: {}, canvas: {}, spotMarkers: [], ops: {}, osm: {}, wfs: {}, zones: {}, depot: {}, pickDepot: false, plan: null, routed: {}, show: { demand: true, official: true, fleet: true, spots: true, groups: true, collect: false, rebalance: true, swap: false, workshop: false, station: true }, busy: false, retry: false, pending: null, again: false, rescore: null, stale: false, routing: null, op: null, focus: null, prioLevel: urlPrio(),
  // Gruppen-Monatsdateien (groups/<JJJJ-MM>.json) und Ströme (flows/<Tag>.json): fertige Monate/Tage bleiben gecacht; index und laufender Monat werden bei neuem Stand neu geladen
  gidx: undefined, gdocs: {}, flowsIdx: undefined, flowDocs: {}, gf: null };
// Farben je Thema: hell die dunkleren Stufen (≥ 3:1 auf Weiß und entsättigtem Kartengrund), dunkel die hellen; Ebenen aus den Themen-Tokens
const dk = () => document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
const tok = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#888888';
const RUN_COLOR = { get rebalance() { return dk() ? '#60a5fa' : '#2563eb'; }, get swap() { return dk() ? '#34d399' : '#047857'; }, get workshop() { return dk() ? '#ef6b6b' : '#c93c3c'; }, get station() { return dk() ? '#f59e0b' : '#b45309'; } };
const IDLE_COL = () => (dk() ? '#c084fc' : '#7c3aed');
// Standzeit als Mindestwert (Z6, linkszensiert): Fahrzeuge tragen idleCensored (ops-Feld 13); Stopps nur die gerundete Stunde – sie gilt als „≥“,
// wenn sie bis auf einen Lauf (45 Min.) der Zeit seit Beginn der Verfolgung (ops trackStart) entspricht
const idleAtLeast = (h) => { const p = S.plan; return h != null && p?.trackStart != null && p.at != null && h >= (p.at - p.trackStart - 45 * 60e3) / 3600e3 - 0.5; };
const idleHText = (h) => (idleAtLeast(h) ? t('trk.idleHAtLeast', { idleMaxH: X.fmt(h) }) : t('ops.idleH', { idleMaxH: X.fmt(h) }));
const RUN_KINDS = Object.keys(RUN_COLOR);
// Rechenschritte entkoppeln, damit Status gezeichnet wird und die Seite zwischen den Schritten reagiert
const tick = () => globalThis.scheduler?.yield ? scheduler.yield() : new Promise(r => setTimeout(r, 0));
const RUN_LABEL = { get rebalance() { return t('ops.rebalance'); }, get swap() { return t('ops.batterySwap'); }, get workshop() { return t('ops.workshop'); }, get station() { return t('ops.stationBalancing'); } };
const STOP_LABEL = { get pickup() { return t('ops.pickUp'); }, get drop() { return t('ops.dropOff'); }, get swap() { return t('ops.swapBattery'); }, get pickup_disabled() { return t('ops.pickUpDefective'); } };
const BAND_NOW = () => O.bandOf(+new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Europe/Berlin' }).format(new Date()) % 24);
const num = (id, d) => { const v = +$(id)?.value; return Number.isFinite(v) && v > 0 ? v : d; };
// Regler „Priorität ↔ Strecke“: Stufe 0–4 (O.PRIO_LEVELS → λ), in der URL als ?prio= (Standardstufe ohne Parameter; app.js syncUrl lässt ihn stehen)
function urlPrio() { try { const v = new URLSearchParams(location.search).get('prio'), n = v == null || v === '' ? NaN : +v; return Number.isInteger(n) && n >= 0 && n < O.PRIO_LEVELS.length ? n : O.PRIO_LEVEL_DEFAULT; } catch { return O.PRIO_LEVEL_DEFAULT; } }
function syncPrioUrl() {
  try { const q = new URLSearchParams(location.search); if (S.prioLevel === O.PRIO_LEVEL_DEFAULT) q.delete('prio'); else q.set('prio', String(S.prioLevel));
    const s = q.toString().replace(/%2F/g, '/'); history.replaceState(history.state, '', `${location.pathname}${s ? `?${s}` : ''}${location.hash}`); } catch { /* file:// o. Ä. */ }
}
const prioLambda = () => O.PRIO_LEVELS[S.prioLevel] ?? O.DEFAULTS.prioLambda;
const prioName = (lv = S.prioLevel) => t(`ops.prioLevel${lv}`);
function prioOut(lv = S.prioLevel) {
  const el = $('#ops-prio'), out = $('#ops-prio-val'); if (!el || !out) return; const l = O.PRIO_LEVELS[lv];
  out.textContent = `${prioName(lv)} (λ ${X.fmt(l, l % 1 ? 1 : 0)})`; el.setAttribute('aria-valuetext', out.textContent);
}

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
  // „Zu den Touren“: Textlink im Kopf der Plan-Karte (springt zur Tourliste, ohne die Ansicht zu wechseln)
  document.addEventListener('click', (e) => { const j = e.target.closest('[data-ops-jump]'); if (!j) return; e.preventDefault(); const el = $(`#${j.dataset.opsJump}`)?.closest('.panel') || $(`#${j.dataset.opsJump}`); if (!el) return; el.tabIndex = -1; el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'start' }); });
  $('#ops-layers').addEventListener('change', (e) => {
    const b = e.target.closest('input[data-l]'); if (!b || !S.plan) return; const k = b.dataset.l; S.show[k] = b.checked; legend();
    if (k === 'viol') drawViol(); else if (RUN_COLOR[k]) drawRoutes(); else drawLayers([k]); // nur die umgeschaltete Ebene neu, alle anderen Marker bleiben stehen
  });
  // Klick auf Tourkarte oder „Auf Karte“: nur diese Tour zeichnen und einpassen; Links bleiben Links
  $('#ops-runs').addEventListener('click', (e) => { if (e.target.closest('a')) return; const c = e.target.closest('[data-run]'); if (c && S.plan) focusRun(c.dataset.run); });
  $('#ops-runs-all').addEventListener('click', () => { S.focus = null; markFocus(); drawRoutes(); fitAll(); });
  $('#ops-csv-spots').addEventListener('click', () => S.plan && download(`spots_${slug()}.csv`, O.spotsCsv(S.plan.spots.spots, { name: X.muniName(S.plan.ags) }), 'text/csv'));
  $('#ops-csv-analysis').addEventListener('click', () => S.plan && download(`${t('file.spotsAnalysis')}_${slug()}.csv`, '﻿' + O.spotsAnalysisCsv(S.plan.spots.spots, S.plan.rebalance.needs, { horizonH: S.plan.params.horizonH, prelim: S.plan.spots.prelim, lang: lang() }), 'text/csv'));
  $('#ops-csv-runs').addEventListener('click', () => S.plan && download(`${t('file.runs')}_${slug()}.csv`, '﻿' + O.runsCsv(allRuns().map(r => ({ ...r, stops: r.stops.map(s => idleAtLeast(s.idleMaxH) ? { ...s, idleMaxH: `≥ ${s.idleMaxH}` } : s) })), S.plan.depot, lang()), 'text/csv')); // Mindestwerte „≥“ (Z6)
  $('#ops-geojson').addEventListener('click', () => S.plan && download(`plan_${slug()}.geojson`, JSON.stringify(O.planGeoJson(S.plan.spots.spots, allRuns(), S.plan.depot)), 'application/geo+json'));
  document.addEventListener('click', (e) => { const a = e.target.closest('.ops-pick'); if (!a) return; e.preventDefault(); $('#sel-scope').value = a.dataset.ags; $('#sel-scope').dispatchEvent(new Event('change')); setTimeout(() => { location.hash = '#ops'; renderOps(); }, 0); });
  // OSM erneut versuchen (nach Ausfall gilt sonst 10 Min. Pause)
  document.addEventListener('click', (e) => { if (!e.target.closest('#ops-osm-retry')) return; const ags = S.plan?.ags || X.state.scope; delete S.osm[ags]; $('#ops-warn').innerHTML = ''; computePlan(); });
  document.addEventListener('click', (e) => { if (e.target.closest('#ops-retry')) { S.retry = true; computePlan(); } });
  // Einsatzzeit je Tour: Feld in den Parametern ergänzen, solange index.html es nicht selbst führt
  if (!$('#ops-maxh')) { const l = document.createElement('label'); l.innerHTML = `${t('ops.timePerRunH')}<input type="number" id="ops-maxh" value="4" min="1" max="12" step="0.5">`; ($('#ops-maxruns')?.closest('label') || $('#ops-swapthr')?.closest('label'))?.after(l); }
  // Regler „Priorität ↔ Strecke“ in der Hauptzeile vor „Plan berechnen“ (Texte über data-i18n, damit der Sprachwechsel sie mitnimmt)
  if (!$('#ops-prio')) {
    const main = $('#ops-run')?.closest('.ops-form'), act = main?.querySelector('.ops-actions'), l = document.createElement('label');
    l.className = 'ops-prio'; l.dataset.i18nTitle = 'ops.prioSliderTitle'; l.title = t('ops.prioSliderTitle');
    l.innerHTML = `<span data-i18n="ops.prioVsDistance">${t('ops.prioVsDistance')}</span><input type="range" id="ops-prio" min="0" max="${O.PRIO_LEVELS.length - 1}" step="1" value="${S.prioLevel}"><span class="ops-prio-scale"><span data-i18n="ops.prioOnlyKm">${t('ops.prioOnlyKm')}</span><output id="ops-prio-val" for="ops-prio"></output><span data-i18n="ops.prioMax">${t('ops.prioMax')}</span></span>`;
    if (act) main.insertBefore(l, act); else main?.appendChild(l);
  }
  const prio = $('#ops-prio'); prio.value = S.prioLevel; prioOut();
  prio.addEventListener('input', () => prioOut(+prio.value));
  prio.addEventListener('change', () => { S.prioLevel = +prio.value; syncPrioUrl(); prioOut(); replanRuns(); });
  injectStyle(); $('#ops-spots thead').innerHTML = spotHead(); initGroupsUi(); initCollect();
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
.ops-form label.ops-prio{min-width:0}.ops-prio input[type=range]{width:100%;margin:0;min-height:var(--ctl);accent-color:var(--accent);cursor:pointer}
.ops-prio .ops-prio-scale{display:flex;justify-content:space-between;align-items:baseline;gap:var(--s2);text-transform:none;letter-spacing:0;font-size:11px;font-weight:400;color:var(--muted)}
.ops-prio output{color:var(--fg);font-weight:600;text-align:center}.ops-seq{margin:2px 0 0}.ops-run ol li{margin:2px 0}
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
  // Tastatur (web/mapkeys.js): N/P zeigt auch das gemeinsame Popup der Canvas-Ebenen; im Depot-Modus setzt Enter das Depot in die Kartenmitte
  mapKeys(S.map, { open: (l, ll) => (POP.has(l) ? (openShared({ layer: l, latlng: ll }), true) : false), centerClick: () => (S.pickDepot && S.plan ? t('maps.depotPlaced') : null), hintExtra: () => t('maps.hintDepot') });
}

export async function renderOps() {
  ensureMap();
  const st = X.state;
  if (st.scope === 'DE') { showPicker(); return; }
  $('#ops-pick').hidden = true; planUi(true);
  if (S.busy && S.pending === st.scope) return; // läuft schon für dieses Gebiet (Gebietswechsel ruft mehrfach)
  if (!S.plan || S.plan.ags !== st.scope || S.stale) await computePlan();
}
/** Sprachwechsel: nichts neu rechnen; Formular, Kacheln, Touren, Spots, Gruppen, Karte (Legende, Marker, Popups), Methode und Status neu
 *  beschriften. Die Kartennamensnennung (Leaflet) wird ausgetauscht. */
export function relabelOps() {
  fillBands(); $('#ops-spots thead').innerHTML = spotHead(); prioOut();
  if (S.map && S.tiles) { const prev = S.tiles.options.attribution, next = t('ops.openstreetmapContributors'); if (prev !== next) { S.tiles.options.attribution = next; S.map.attributionControl?.removeAttribution(prev).addAttribution(next); } }
  renderMethod(); renderCollect();
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
// Ohne Gemeinde („Deutschlandweit“) nur die Gemeindeauswahl zeigen, nicht das leere Gerüst aus Formular, Karte und Tabellen (wie der Vergleich)
const planUi = (on) => { for (const el of document.querySelectorAll('#view-ops > :not(.hero):not(#ops-pick)')) el.hidden = !on; if (on) S.map?.invalidateSize(); };
function showPicker() {
  planUi(false);
  const munis = Object.values(X.state.latest?.municipalities || {}).map(m => ({ ...m, avail: Object.values(m.operators || {}).reduce((s, o) => s + (o.available ?? o.total ?? 0), 0) })).sort((a, b) => b.avail - a.avail).slice(0, 18);
  const el = $('#ops-pick'); el.hidden = false;
  el.innerHTML = `<h2>${t('ops.chooseMunicipality')}</h2><div class="sub">${t('ops.operationsPlansPer')}</div><div class="chips">${munis.map(m => `<a href="#ops" class="chip ops-pick" data-ags="${X.esc(m.ags)}">${X.esc(m.name)} <span class="muted">${X.fmt(m.avail)}</span></a>`).join('')}</div>`;
  for (const k in S.layers) S.layers[k].clearLayers();
  $('#ops-tiles').innerHTML = ''; $('#ops-runs').innerHTML = ''; $('#ops-warn').innerHTML = ''; $('#ops-spots-sub').textContent = ''; $('#ops-spots tbody').innerHTML = `<tr><td colspan="${SPOT_COLS}" class="empty">${t('ops.noPlanYetChooseMunicipality')}</td></tr>`; status('');
  $('#ops-groups-sub').textContent = ''; $('#ops-groups tbody').innerHTML = ''; groupsEmpty($('#ops-groups'), t('ops.noPlanYetChooseMunicipality')); $('#ops-runs-all').hidden = true; $('#ops-gf-count').textContent = '';
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
const refCite = (ref) => `${/^https?:\/\//i.test(String(ref.source || '')) ? `<a href="${X.esc(ref.source)}" target="_blank" rel="noopener">${X.esc(refLabel(ref))}</a>` : X.esc(refLabel(ref))}${ref.license ? ` (${X.esc(ref.license)}${ref.attribution ? `, ${X.esc(ref.attribution)}` : ''})` : ''}`;
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
    const b = (await X.loadBoundaries(), st.boundaries?.features.find(f => f.properties.ags === ags)?.bbox) || null;
    const spacing = num('#ops-spacing', 220), topN = Math.min(60, num('#ops-n', 20)), horizonH = num('#ops-horizon', 3);
    status(t('ops.loadingZonesAndSurroundings'));
    const pre = O.scoreSpots(model, { topN: Math.min(80, topN * 3), minSpacingM: spacing * 0.6, bootDraws: 0 }); // Vorauswahl für Overpass: ohne Bootstrap
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
    const params = { topN, spacing, share, horizonH, van: num('#ops-van', 20), common: { depot, maxRuns: num('#ops-maxruns', 6), horizonH, maxRunMin: Math.round(num('#ops-maxh', 4) * 60), prioLambda: prioLambda() }, swapCapacity: Math.min(50, num('#ops-swapcap', 50)), swapThreshold: num('#ops-swapthr', 20), swapRangeKm: num('#ops-swaprange', 5) };
    const plan = { ags, op, type, band, bandNote, model, share, depot, np, osm, official, params, groups: O.groupPlaces(groupRes.docs, { ags }), groupSrc: groupRes, flowSrc: flowRes, fleet: { vehicles, stations }, at: fleet.at, trackStart: fleet.trackStart ?? null, days: cellDocs.length };
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
const swapsFor = (p) => O.planSwaps({ vehicles: p.fleet.vehicles.filter(v => !v.reserved), model: p.model, swapCapacity: p.params.swapCapacity, swapThreshold: p.params.swapThreshold, swapRangeKm: p.params.swapRangeKm, ...p.params.common });
const workshopFor = (p) => O.planWorkshop({ vehicles: p.fleet.vehicles, workshopCapacity: p.params.van, ...p.params.common });
const stationFor = (p) => { const sb = p.fleet.stations.length ? O.planStationBalance({ stations: p.fleet.stations, vanCapacity: p.params.van, ...p.params.common }) : null; return sb?.stations ? sb : null; };
/** Regler „Priorität ↔ Strecke“ geändert: nur die Touren neu (Bündelung, Einsatzgrenze, Reihenfolge); Nachfrage, Spots und Kartenebenen
 *  bleiben, eine fokussierte Tour bleibt fokussiert, die Straßenmatrix kommt aus dem Cache. Läuft gerade ein Plan, rechnet er danach neu. */
async function replanRuns() {
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
function renderTiles() {
  const p = S.plan, k = p.kpi, f = X.fmt;
  const need = p.rebalance.needs.reduce((s, n) => s + n.need, 0), target = p.spots.spots.reduce((s, x) => s + x.target, 0);
  const runs = allRuns(); const km = runs.reduce((s, r) => s + r.km, 0), min = runs.reduce((s, r) => s + r.totalMin, 0);
  const cl = [...p.model.cells.values()], sph = cl.reduce((s, c) => s + (c.startsPerHour || 0), 0);
  const drainCells = cl.filter(c => (c.outPerHour ?? 0) > 0), drain = drainCells.reduce((s, c) => s + c.outPerHour, 0);
  const pr = X.state.usage?.profile; const prelim = !pr || pr.source === 'Standardkurve' || (pr.days ?? 0) < 3; const rv = (x) => x >= 100 ? f(sig2(x)) : f(x);
  $('#ops-tiles').innerHTML = [
    tile(t('ops.fleet'), `${f(k.available)}<small> / ${f(k.total)}</small>`, t('ops.availableReportedDisabled', { disabled: f(k.disabled), v1: f(p.share * 100) })),
    tile(t('ops.demand'), `${f(sph * p.share, 1)} /h`, t('ops.tripStartsMarketHNetOutflowH', { v0: p.band === 'day' ? t('ops.dailyMean') : bandLabel(p.band), sph: f(sph, 1), v2: f(drain * p.share, 1), length: f(drainCells.length), hours: f(p.model.hours, 1) })),
    tile(t('ops.spots'), `${f(p.spots.spots.length)}`, t('ops.needVehShortfall', { target: f(target), need: f(need), v2: p.spots.excluded ? ` · ${t('ops.cellsExcludedZones', { excluded: f(p.spots.excluded), v1: p.spots.excludedBy?.official ? t('ops.ofWhichNoParkingZonePerCity', { official: f(p.spots.excludedBy.official) }) : '' })}` : '' }), need > target * 0.5 ? 'warn' : ''),
    // Akku und Standzeit getrennt: jede Kachel warnt nur wegen ihres eigenen Werts (vorher „0“ in Warnfarbe wegen der Standzeit)
    tile(t('ops.lowBatteryTile'), k.batteryKnown ? `${f(k.low)}` : t('common.na'), k.batteryKnown ? (() => { const rt = rangeText(p.fleet.vehicles, num('#ops-swaprange', 5)); return t('ops.lowBatterySub', { charge: num('#ops-swapthr', 20), range: rt.v, known: f(k.batteryKnown) }) + (rt.limited ? ` · ${t('ops.srcLimitRule', { share: Math.round(O.RANGE_LIMIT.share * 100), maxP95: O.RANGE_LIMIT.maxP95Km })}` : ''); })() : t('ops.noChargeLevelInFeed'), k.batteryKnown && k.low / k.batteryKnown > 0.25 ? 'warn' : ''),
    // Mindestwerte (Z6): seit Beginn der Verfolgung unbewegt; der Median ist „≥“, sobald er im Bereich der zensierten Werte liegt
    (() => { const cz = p.fleet.vehicles.filter(v => !v.disabled && !v.reserved && v.idleMin != null && v.idleCensored), czMin = cz.length ? Math.min(...cz.map(v => v.idleMin)) : null;
      const med = k.idleMedianH == null ? '–' : `${czMin != null && k.idleMedianH * 60 >= czMin ? '≥ ' : ''}${f(k.idleMedianH, 1)} h`;
      const cs = cz.length && p.trackStart ? ` · ${t('trk.opsIdleCensored', { share: `${f((cz.length / Math.max(1, k.idleKnown)) * 100)} %`, start: dateFmt({ day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' }).format(new Date(p.trackStart)) })}` : '';
      return tile(t('ops.idleTile'), k.idleKnown ? `${f(k.idle24)}` : t('common.na'), k.idleKnown ? t('ops.idleSub', { share: `${f((k.idle24 / k.idleKnown) * 100)} %`, median: med }) + cs : '', k.idleKnown && k.idle24 / k.idleKnown > 0.3 ? 'warn' : ''); })(),
    tile(t('ops.revenueDay'), p.econ === undefined ? '…' : p.econ?.revDay != null && p.econ.plausible ? (prelim ? `${rv(p.econ.revDay * 0.7)}<small>–${rv(p.econ.revDay * 1.3)} €</small>` : `${f(p.econ.revDay)} €`) : '—', p.econ === undefined ? t('ops.loadingEstimate') : !p.econ ? t('ops.noTripDataForThisOperator') : t('ops.tripsVehDayUtilisationNet', { v0: prelim ? `${t('ops.preliminaryUnder3Measurement')} · ` : '', v1: p.econ.plausible ? '' : `${t('ops.tripCountImplausible')} · `, rvd: f(p.econ.rvd, 2), v3: p.econ.utilization == null ? '–' : f(p.econ.utilization * 100, 1) + ' %' }), `est${p.econ && !p.econ.plausible ? ' warn' : ''}`),
    tile(t('ops.runs'), `${f(runs.length)}`, t('ops.kmHOnDuty', { km: f(km, 1), v1: f(min / 60, 1), v2: Object.keys(S.routed).length ? t('ops.byRoad', { length: f(Object.keys(S.routed).length), length2: f(runs.length) }) : $('#ops-route')?.checked && !osrmDown() ? t('ops.roadRoutingInProgress') : t('ops.straightLine135') })),
  ].join('');
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
function legend() {
  const opc = X.opColor(S.plan.op), gv = (k) => groupView(k), mixed = S.gf?.op === 'all';
  const lay = $('#ops-layers'); if (lay._plan !== S.plan || lay._lang !== lang() || !lay.querySelector('input[data-l]')) { layerToggles(); lay._plan = S.plan; lay._lang = lang(); }
  $('#ops-legend').innerHTML = `<span><i class="sq" style="background:var(--accent);border-color:var(--accent)"></i>${t('ops.netOutflowHStartsEnds250M', { v0: abbr(t('ops.cell'), t('ops.gridOfAbout250250MStartsEnds')) })}</span><span><i class="dot" style="background:var(--bad)"></i>${t('ops.disabled')}</span><span><i class="dot" style="background:var(--warn)"></i>${t('ops.batteryLow')}</span><span><i class="dot" style="background:${IDLE_COL()}"></i>${t('ops.n24HNotMoved')}</span><span><b class="ops-spot-mini">1</b>${t('ops.spotDashedRankUncertain')}</span><span><b class="ops-spot-mini" style="background:var(--fg)">D</b>Depot</span>`
    + (S.show.groups && gv('deploy').length ? `<span>${t('ops.presumedOperatorSpot', { v0: groupSvg('deploy', opc, 12), v1: mixed ? t('ops.colourOperator') : '' })}</span>` : '')
    + (S.show.collect && gv('collect').length ? `<span>${t('ops.pickupPlaceObservation', { v0: groupSvg('collect', opc, 12), v1: mixed ? t('ops.colourOperator') : '' })}</span>` : '')
    + (S.show.official && S.plan.official?.noPark.length ? `<span><i class="sq" style="background:color-mix(in srgb,var(--bad) 20%,transparent);border-color:var(--bad);border-style:dashed"></i>${t('ops.noParkingZonePerCity', { v0: S.plan.official.sources.filter(x => x.ref.kind === 'noPark').map(x => refCite(x.ref)).join(', ') })}</span>` : '')
    + (S.plan.official?.points.length ? `<span class="muted">${t('ops.parkingAreas', { v0: S.plan.official.sources.filter(x => x.ref.kind !== 'noPark').map(x => refCite(x.ref)).join(', ') })}</span>` : '') + violLegend();
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
      withPop(L.rectangle([[c.lat - O.CELL_LAT / 2, c.lon - O.CELL_LON / 2], [c.lat + O.CELL_LAT / 2, c.lon + O.CELL_LON / 2]], { weight: 0, fillColor: tok('--accent'), fillOpacity: 0.08 + 0.5 * q(c.outPerHour), renderer: S.canvas.demand }),
        () => t('ops.cellMarketMeasuredHoursNet', { cell: esc(c.cell), hours: f(p.model.hours, 1), v2: sgn(c.outPerHour), outSe: f(c.outSe, 2), starts: f(c.starts), startsPerHour: f(c.startsPerHour, 2), ends: f(c.ends), endsPerHour: f(c.endsPerHour, 2), supplyAvg: f(c.supplyAvg, 1), v9: t('ops.cellBalanceK', { k: f(p.model.balance?.k ?? 1, 3), endsBal: f(c.endsPerHourBal ?? c.endsPerHour, 2), low: f(c.outLow ?? 0, 2) }) + (fl ? t('ops.flowsOutIn', { days: f(fl.days), v1: fl.days === 1 ? t('ops.day') : t('ops.days2'), v2: f(c.flow?.out || 0), v3: f(c.flow?.in || 0) }) : '') })).addTo(Lx.demand);
    }
  }
  // Abstellverbotszonen der Stadt (Ausschluss), gestrichelt unter der Flotte; nicht anklickbar, Quelle und Lizenz in der Legende
  if (on('official')) for (const g of p.official?.noPark || []) L.geoJSON(g, { interactive: false, style: { color: tok('--bad'), weight: 1, dashArray: '4 3', fillColor: tok('--bad'), fillOpacity: 0.12 }, renderer: S.canvas.demand }).addTo(Lx.official);
  if (on('fleet')) {
    const swapOpt = { swapThreshold: num('#ops-swapthr', 20), swapRangeKm: num('#ops-swaprange', 5) };
    for (const v of p.fleet.vehicles) {
      const opc = X.opColor(v.operator), col = v.disabled ? tok('--bad') : O.needsSwap(v, swapOpt) ? tok('--warn') : (v.idleMin ?? 0) >= 1440 ? IDLE_COL() : opc;
      const plain = col === opc;
      withPop(L.circleMarker([v.lat, v.lon], { radius: plain ? 2.5 : 3.5, weight: 0, fillColor: col, fillOpacity: plain ? .4 : .95, renderer: S.canvas.fleet }),
        () => `<b>${esc(v.operator)}</b> · ${esc(X.TYPE[v.type] || v.type)}<br>${v.disabled ? `${t('ops.disabled')} · ` : v.reserved ? `${t('ops.reserved')} · ` : ''}${v.battery != null ? `${t('ops.battery', { battery: f(v.battery) })} · ` : ''}${v.idleMin != null ? (v.idleCensored ? t('trk.idleForAtLeast', { v0: `${f(v.idleMin / 60, 1)} h` }) : t('ops.idleForH', { v0: f(v.idleMin / 60, 1) })) : ''}`).addTo(Lx.fleet);
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
      L.circle([s.lat, s.lon], { radius: 150, weight: 1, color: tok('--accent'), fill: false, dashArray: s.stabilityLabel === 'stabil' ? null : '4 4', interactive: false }).addTo(Lx.spots);
      S.spotMarkers.push([s, L.marker([s.lat, s.lon], { icon: L.divIcon({ className: `ops-spot${s.stabilityLabel === 'stabil' ? '' : ' weak'}`, html: `${s.rank}`, iconSize: [24, 24] }), title: spotTitle(s), keyboard: false })
        .bindPopup(() => t('ops.spotNeedVehFleet150M', { rank: s.rank, v1: s.park ? ` · ${esc(parkLabel(s.park))}` : '', target: f(s.target), v3: f(n?.have), v4: f(n?.need), startsPerHourOp: f(s.startsPerHourOp, 2), endsPerHourOp: f(s.endsPerHourOp, 2), v7: `${sgn(s.outPerHourOp)} ± ${f(s.outSeOp, 2)}`, hours: f(s.hours, 1), score: f(s.score, 2), v10: `${p.spots.prelim ? t('ops.preliminary') : (STAB[s.stabilityLabel] ?? s.stabilityLabel)}${s.bootShare != null ? ` (${t('ops.bootShare', { share: f(s.bootShare * 100) })})` : ''}` })).addTo(Lx.spots)]);
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
    L.polyline(geo, { color: RUN_COLOR[r.kind], weight: 3, opacity: .85, dashArray: S.routed[r.id]?.coords ? null : '6 5', renderer: S.canvas.runs }).bindPopup(() => runTitle(r)).addTo(S.layers[r.kind]);
    r.stops.forEach((s, i) => L.circleMarker([s.lat, s.lon], { radius: 5, weight: 2, color: RUN_COLOR[r.kind], fillColor: s.type === 'drop' ? RUN_COLOR[r.kind] : '#ffffff', fillOpacity: 1, renderer: S.canvas.runs })
      .bindTooltip(`${r.id}·${i + 1} ${STOP_LABEL[s.type]} ${s.count}${s.prio != null ? ` · ${t('ops.stopPrio', { prio: X.fmt(s.prio, 2), rank: s.rank, n: r.stops.length })}` : ''}${whyText(s) ? ` · ${whyText(s)}` : ''}`, { direction: 'top' }).addTo(S.layers[r.kind]));
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
  const base = `${STOP_LABEL[s.type]} ${f(s.count)}${s.station ? ` · ${esc(s.station)} (${esc(s.fill)})` : ''}${s.spotRank ? ` · ${t('ops.spot2', { spotRank: s.spotRank, v1: s.need != null ? ` · ${t('ops.shortfallNeedFleet', { need: f(s.need), target: f(s.target), have: f(s.have) })}` : '' })}` : ''}`;
  if (s.prio == null) return `<li>${base}${s.battery?.length ? ` · ${t('ops.battery2', { v0: s.battery.slice(0, 6).join('/') })}` : ''}${s.idleMaxH ? ` · ${idleHText(s.idleMaxH)}` : ''}</li>`;
  const all = s.count > 1 && s.battery?.length > 1 ? ` · ${t('ops.battery2', { v0: s.battery.slice(0, 6).join('/') })}` : '';
  const pr = t('ops.stopPrio', { prio: f(s.prio, 2), rank: s.rank, n: r.stops.length });
  return `<li>${base}${all} · ${s.prio >= 1 ? `<b>${pr}</b>` : pr}${why ? `: ${why}` : ''} <span class="muted">· ${t('ops.atKm', { km: f(s.atKm, 1) })}</span></li>`; // ab 1 = dringend: fett
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
  return `<p class="small muted ops-seq" title="${X.esc(t('ops.seqTitle'))}">${parts.join(' · ')}</p>`;
}
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
        ${seqLine(r)}
        <details${open.has(r.id) ? ' open' : ''}><summary>${t('ops.stopList')}</summary><ol class="small">${r.stops.map(s => stopItem(s, r)).join('')}</ol></details>
        <div class="foot"><button class="chip" data-fit="${r.id}">${t('ops.onMap')}</button> ${links.map((u, i) => `<a href="${u}" target="_blank" rel="noopener" title="${t('ops.googleMapsAllowsAtMost10')}">${links.length > 1 ? t('ops.routePartOf', { v0: i + 1, length: links.length }) : t('ops.route')} ↗</a>`).join(' · ')}</div></div>`;
    }).join('') : `<div class="muted small">${t('ops.noRunNeeded')}</div>`;
    return `<h3 style="margin-top:12px">${RUN_LABEL[kind]}</h3><div class="sub">${head}</div><div class="cards" style="grid-template-columns:1fr">${body}</div>`;
  };
  const rb = p.rebalance, sw = p.swaps, ws = p.workshop, sb = p.station;
  box.innerHTML =
    (S.plan.fleet.vehicles.length ? '' : `<div class="note">${t('ops.stationBasedFleetNoFree')}</div>`) +
    block('rebalance', rb, t('ops.rebalancingMovesFromSurplus', { moves: f(rb.moves), surplus: f(rb.surplus), v2: rb.missing > 0 ? ` · ${t('ops.placesRemainOpenNoSurplus', { missing: f(rb.missing), v1: f(O.DEFAULTS.maxPickupM / 1000) })}` : '', v3: left(rb.unplanned) })) +
    (sb ? block('station', sb, t('ops.nearlyEmptyNearlyFullOf', { empty: f(sb.empty), full: f(sb.full), stations: f(sb.stations), moves: f(sb.moves), v4: left(sb.unplanned) })) : '') +
    block('swap', sw, sw.below ? t('ops.vehiclesBelowChargeAndKm', { below: f(sw.below), v1: num('#ops-swapthr', 20), v2: rangeText(p.fleet.vehicles, num('#ops-swaprange', 5)).v, v3: left(sw.unplanned) }) : t('ops.noVehicleBelowThresholdOrNo')) +
    block('workshop', ws, ws.disabled ? t('ops.disabledVehiclesLongest', { disabled: f(ws.disabled), v1: left(ws.unplanned) }) : t('ops.noDisabledVehicles'));
  $('#ops-runs-sub').textContent = `${t('ops.runsForBundledByCityAreaAt', { op: p.op, hText })} · ${t('ops.orderBy', { level: prioName() })}`;
  markFocus();
  if (actRun && actSel) box.querySelector(`[data-run="${actRun}"] ${actSel}`)?.focus({ preventScroll: true });
}
// Spot-Tabelle: alle Zahlen der Bedarfsrechnung sichtbar (Kopf ersetzt den aus index.html)
// Lage steht vorn, der Rang als Präfix: am Telefon bleibt die erste (feste) Spalte die Lage statt einer schmalen Rangnummer
const SPOT_COLS = 11;
function spotHead() {
  const th = (tq, tip, n = true) => `<th${n ? ' class="n"' : ''}><abbr title="${tip}">${tq}</abbr></th>`;
  return `<tr><th>${t('ops.rank')} · ${t('ops.location')}</th>${th(t('ops.startsPerH'), t('ops.tripStartsPerHourOperatorS'))}${th(t('ops.endsPerH'), t('ops.tripEndsPerHourOperatorS'))}${th(t('ops.netPerH'), t('ops.netOutflowStartsEndsPerHour'))}`
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
    // Ausgleich je Gemeinde (Σ Starts = Σ Enden, unterdrückte Ereignisse eingerechnet) und Bootstrap (M-10, lib/pulse-ops.js buildDemandModel, BOOT)
    (sp.balance ? ` · ${esc(t('ops.balanceNote', { starts: f(sp.balance.totalStarts), belowStarts: f(sp.balance.belowStarts), ends: f(sp.balance.totalEnds), belowEnds: f(sp.balance.belowEnds), k: f(sp.balance.k, 3) }))}` : '') +
    (sp.boot ? ` · ${esc(t('ops.bootNote', { stable: f(sp.stable), n: f(sp.spots.length), uncertain: f(sp.uncertain), draws: f(sp.boot.draws), share: f(sp.boot.minShare * 100) }))}` : '') +
    (prelim ? `<br><span class="warn-text">${t('ops.preliminaryNetOutflowAnd', { prelimH: f(D.prelimH), hours: f(p.model.hours, 1) })}</span>` : '');
  const bar = (x) => `<span class="bar" style="display:inline-block;width:38px;vertical-align:middle"><i style="width:${Math.round((x ?? 0) * 100)}%"></i></span>`;
  const F = { 'Δ': t('ops.netOutflowStartsEndsPerH'), N: t('ops.demandStartsH'), Ö: t('ops.publicTransportProximityStop'), A: t('ops.parkingAreaNearby') };
  const fac = (x, l) => `${bar(x)} <abbr title="${F[l]}: ${f((x ?? 0) * 100)} %">${FL(l)}</abbr>`;
  const formula = (s) => (s.drain > 0 ? `${f(s.outPerHourOp, 2)} × ${f(H)} h + ${f(s.base, 1)}` : t('ops.baseStock', { base: f(s.base, 1) })) + (s.capped ? ` ${t('ops.max', { needRaw: f(s.needRaw, 1), maxPerSpot: f(D.maxPerSpot) })}` : s.target > Math.ceil(s.needRaw - 1e-9) ? t('ops.min', { minPerSpot: f(D.minPerSpot) }) : '');
  $('#ops-spots tbody').innerHTML = sp.spots.map(s => { const n = needBy.get(s.cell); const k = geoKey(s.lat, s.lon); const g = s.rank <= GEO_TOP ? GEO.get(k) : undefined;
    const osm = osmLink(s.lat, s.lon);
    const place = s.park ? esc(parkLabel(s.park)) : t('ops.cellCentre');
    const main = s.rank > GEO_TOP ? place : `<span class="geo-main" translate="no" data-geo="${k}" data-fallback="${place}">${g ? esc(g) : g === null ? place : `<span class="muted">${t('ops.lookingUpAddress')}</span>`}</span>`;
    return `<tr><td><span class="mono muted">${s.rank} ·</span> ${main}<div class="sub-line">${osm}${s.rank <= GEO_TOP ? ` · ${place}` : ''}</div></td>
    <td class="n">${f(s.startsPerHourOp, 2)}<div class="sub-line">${t('ops.market', { startsPerHour: f(s.startsPerHour, 2) })}</div></td><td class="n">${f(s.endsPerHourOp, 2)}<div class="sub-line">${t('ops.endsCountedK', { counted: f(s.endsPerHour, 2), k: f(s.balanceK ?? 1, 2) })}</div></td>
    <td class="n"><b>${sgn(s.outPerHourOp)}</b><div class="sub-line">${t('ops.outRange', { se: f(s.outSeOp, 2), lo: sgn(s.outLoOp ?? 0), hi: sgn(s.outHiOp ?? 0), low: f(s.outLowOp ?? 0, 2) })}${fl ? ` · ${t('ops.flowsOutIn2', { v0: f(s.flow?.out || 0), v1: f(s.flow?.in || 0) })}` : ''}</div></td>
    <td class="n">${f(s.hours, 1)} h<div class="sub-line">${t('ops.startsEnds', { starts: f(s.starts), ends: f(s.ends) })}</div></td>
    <td class="n"><b>${f(s.target)}</b><div class="sub-line">${formula(s)}</div></td><td class="n">${f(n?.have)}<div class="sub-line">${t('ops.avgMarket', { supplyAvg: f(s.supplyAvg, 1) })}</div></td><td class="n" style="color:var(--${n?.need ? 'warn' : 'muted'})"><b>${f(n?.need)}</b></td>
    <td class="n">${f(s.score, 2)}</td>
    <td class="small" style="white-space:nowrap">${fac(s.factors.outflow, 'Δ')} ${fac(s.factors.demand, 'N')}${sp.activeFactors.includes('transit') ? ` ${fac(s.factors.transit, 'Ö')}` : ''}${sp.activeFactors.includes('parking') ? ` ${fac(s.factors.parking, 'A')}` : ''}</td>
    <td>${prelim ? `<span class="pill prelim" title="${t('ops.meaningfulOnlyFromMeasured', { prelimH: f(D.prelimH) })}">${t('ops.preliminary')}</span>` : `<span class="pill ${s.stabilityLabel === 'stabil' ? 'live' : s.stabilityLabel === 'mittel' ? 'delayed' : 'stale'}">${STAB[s.stabilityLabel] ?? s.stabilityLabel}</span>`}<div class="sub-line">${t('ops.ofVariants', { v0: f(s.stability * 100) })}</div>${s.bootShare != null ? `<div class="sub-line">${t('ops.bootShare', { share: f(s.bootShare * 100) })}</div>` : ''}</td></tr>`; }).join('') || `<tr><td colspan="${SPOT_COLS}" class="empty">${t('ops.noSpotsTooLittleDemand')}</td></tr>`;
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
// Leerzustand der Gruppentabelle als eigener Block unter der Tabelle; die Tabelle selbst ist dann ausgeblendet
function groupsEmpty(tbl, msg) {
  const wrap = tbl.closest('.tbl'); if (!wrap) return;
  let box = wrap.nextElementSibling?.classList.contains('ops-groups-empty') ? wrap.nextElementSibling : null;
  if (!box) { box = document.createElement('div'); box.className = 'empty ops-groups-empty'; wrap.after(box); }
  wrap.hidden = !!msg; box.hidden = !msg; box.innerHTML = msg || '';
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
    // Leerzustand außerhalb der scrollenden Tabelle (am Telefon sonst rechts abgeschnitten)
    tb.innerHTML = ''; groupsEmpty(tbl, msg); return;
  }
  groupsEmpty(tbl, null);
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
// ---------- Straßenkilometer (OSRM-Demo-Server) ----------
// Matrix je Tour über /table (Strecke und Fahrzeit; bis OSRM_MAX Punkte je Anfrage, größere Touren in Blöcken zu je OSRM_MAX/2 Punkten),
// Linie und Fahrzeit über /route. Höflich: alle Anfragen nacheinander mit ≥ 1,2 s Abstand; Ergebnisse je Punktpaar bzw. Punktfolge im
// Speicher gecacht (über Pläne und Reglerstellungen hinweg), nach Ausfall/429/5xx 2 Minuten Pause. Fehlt die Matrix, bleibt die Planung
// aus lib (Luftlinie × 1,35); einzelne fehlende Paare ersetzt O.matrixCost ebenso.
const OSRM = 'https://router.project-osrm.org', OSRM_MAX = 90, OSRM_GAP_MS = 1200, OSRM_PAUSE_MS = 120e3;
const MX = new Map(), ROUTES = new Map(), OSRM_S = { last: 0, chain: Promise.resolve(), downUntil: 0 };
const okey = (p) => `${(+p.lon).toFixed(5)},${(+p.lat).toFixed(5)}`;
const osrmDown = () => Date.now() < OSRM_S.downUntil;
function osrmGet(path) {
  const run = async () => {
    if (osrmDown()) return null;
    const wait = OSRM_S.last + OSRM_GAP_MS - Date.now(); if (wait > 0) await new Promise(res => setTimeout(res, wait));
    OSRM_S.last = Date.now();
    const r = await X.getJson(OSRM + path, { timeout: 30000 });
    if (!r.ok) { if (!r.status || r.status === 429 || r.status >= 500) OSRM_S.downUntil = Date.now() + OSRM_PAUSE_MS; return null; }
    return r.json?.code === 'Ok' ? r.json : null;
  };
  const q = OSRM_S.chain.then(run, run); OSRM_S.chain = q.catch(() => null); return q;
}
// Straßenmatrix (Meter) für points; null, wenn kein einziges Paar bekannt ist
async function roadMatrix(points) {
  const keys = points.map(okey), uniq = [...new Set(keys)], h = uniq.length <= OSRM_MAX ? uniq.length : Math.floor(OSRM_MAX / 2), blocks = [];
  for (let i = 0; i < uniq.length; i += h) blocks.push(uniq.slice(i, i + h));
  const miss = (a, b) => a !== b && !MX.has(`${a}>${b}`);
  outer: for (let a = 0; a < blocks.length; a++) for (let b = a; b < blocks.length; b++) {
    const set = a === b ? blocks[a] : [...blocks[a], ...blocks[b]];
    if (!set.some(x => set.some(y => miss(x, y)))) continue;
    const j = await osrmGet(`/table/v1/driving/${set.join(';')}?annotations=distance,duration`);
    if (!j?.distances) break outer;
    set.forEach((x, i) => set.forEach((y, k) => { const d = j.distances[i]?.[k]; if (i !== k && d != null) MX.set(`${x}>${y}`, { d, t: j.durations?.[i]?.[k] ?? null }); }));
  }
  let known = 0; const D = keys.map(a => keys.map(b => { if (a === b) return 0; const v = MX.get(`${a}>${b}`); if (v) known++; return v ? v.d : null; }));
  return known ? { D, missing: keys.length * (keys.length - 1) - known } : null;
}
const roadDur = (seq) => { let s = 0; for (let i = 0; i < seq.length - 1; i++) { const a = okey(seq[i]), b = okey(seq[i + 1]); if (a === b) continue; const v = MX.get(`${a}>${b}`); if (v?.t == null) return null; s += v.t; } return s; };
async function roadRoute(seq) {
  const key = seq.map(okey).join(';'); if (ROUTES.has(key)) return ROUTES.get(key);
  if (seq.length > 100) return null; // Wegpunkte je Route begrenzt: dann nur km aus der Matrix, Linie gerade
  const rt = (await osrmGet(`/route/v1/driving/${key}?overview=simplified&geometries=geojson`))?.routes?.[0]; if (!rt) return null;
  const v = { coords: rt.geometry.coordinates.map(([lo, la]) => [la, lo]), km: +(rt.distance / 1000).toFixed(1), min: Math.round(rt.duration / 60) };
  ROUTES.set(key, v); return v;
}
// Tour nach Straße: Reihenfolge mit der Straßenmatrix neu (gleiches Ziel wie in lib: Strecke + λ · gewichtete Anfahrt, Gruppen bleiben),
// Vergleichswerte aus der Matrix, km und Fahrzeit aus der gefahrenen Route
async function roadOptimize(r, p) {
  const mx = await roadMatrix([p.depot, ...r.stops]); if (!mx || S.plan !== p) return false; // Plan inzwischen ersetzt: nichts in die alte Tour schreiben
  const sq = O.sequenceRun(O.runGroups(r.stops), { depot: p.depot, cost: O.matrixCost([p.depot, ...r.stops], mx.D), lambda: p.params.common.prioLambda });
  Object.assign(r, { stops: sq.stops, km: sq.km, kmSeq: sq.km, kmMin: sq.kmMin, kmNN: sq.kmNN, kmPrio: sq.kmPrio, reachKm: sq.reachKm, reachKmMin: sq.reachKmMin, obj: sq.obj, road: true, roadMissing: mx.missing });
  const seq = [p.depot, ...r.stops, p.depot], dur = roadDur(seq); if (dur != null) r.driveMin = Math.round(dur / 60);
  const rt = await roadRoute(seq); if (S.plan !== p) return false;
  if (rt) { r.km = rt.km; r.driveMin = rt.min; }
  S.routed[r.id] = { coords: rt?.coords || null }; r.totalMin = r.driveMin + r.handleMin;
  return true;
}
async function routeRuns() {
  const p = S.plan; if (!p || S.routing === p) return;
  S.routing = p; // eine noch laufende Schleife des vorigen Plans bricht ab; den Abstand zum Server hält osrmGet
  if (osrmDown()) { status(`${planStatus(p)} · ${t('ops.osrmUnreachable')}`); renderTiles(); S.routing = null; return; }
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
      await tick();
      if (osrmDown()) break; // Server nicht erreichbar: übrige Touren bleiben bei Luftlinie, kein Nachfeuern
    }
    // Zähler über S.routed: nach einer Neubewertung (Overpass) behalten die übrigen Touren ihr Routing
    const done = allRuns().filter(x => S.routed[x.id]).length;
    if (S.plan === p) { status(t('ops.roadRoutingOsrmOfRunsByRoad', { v0: base(), done, length: allRuns().length, v3: done < allRuns().length ? t('ops.restStraightLine135') : '' }) + (osrmDown() ? ` · ${t('ops.osrmUnreachable')}` : '')); renderTiles(); }
  } finally { if (S.routing === p) S.routing = null; }
}
// ---------- Einsammelliste: im eigenen Abstellverbot oder ohne Station in einer Pflicht-Abstellzone (lib/pulse-ops.js parkingViolations) ----------
// Zwei Arten je Fahrzeug (kind 'ban' | 'mpz'), getrennt ausgewiesen: Kopfzeile, Spalte „Art · Zone“, Marker (Schrägstrich bzw. „P“), CSV-Spalte art.
// Intern für die Flotte der Disposition (Anbieter und Fahrzeugart wie der Plan), kein Anbieter-Vergleich, im Kunden-Modus ausgeblendet (.internal).
// Zonen: die GBFS-Geofencing-Dateien des Datenstands (zones/<Datei>.json, nur Dateien mit dieser Gemeinde laut zones/index.json) über den
// gemeinsamen Cache (X.getJson, dieselben Downloads wie Übersichtskarte und Abstellverbote der Spots); nichts davon wird gespeichert.
// Gerechnet im Browser, unabhängig von Nachfrage und Plan. Eigene Kartenebenen außerhalb von S.layers (emptyPlan/showPicker räumen sie nicht ab),
// Schalter in der Ebenen-Leiste; die Marker haben Popups und sind so per Tastatur (web/mapkeys.js, N/P/Enter) erreichbar.
const COL_GEO_TOP = 10;
const isClient = () => document.body.classList.contains('mode-client');
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const colValid = () => { const c = S.col; return c && c.ags === X.state.scope && c.op === S.op && c.type === $('#ops-type')?.value ? c : null; };
const idleText = (v) => v.idleMin == null ? '–' : `${v.idleCensored ? '≥ ' : ''}${X.fmt(v.idleMin / 60, 1)} h`;
const zoneLabel = (z) => z.name || t('col.zoneId', { id: z.id });
// Art je Fahrzeug bzw. betroffener Zone: Pflicht-Abstellzone ohne Station (Blau wie „Abstellen nur an Stationen“ der Übersichtskarte), Fahrverbot (Rot), Abstellverbot
const colKind = (x) => (x.kind === 'mpz' ? 'mpz' : x.noRide ?? x.zone?.noRide ? 'noRide' : 'noPark');
const kindText = (x) => t({ mpz: 'col.kindMpz', noRide: 'col.kindNoRide', noPark: 'col.kindNoPark' }[colKind(x)]);
const kindColor = (x) => tok({ mpz: '--info', noRide: '--bad', noPark: '--warn' }[colKind(x)]);
// Marker: Kreis mit Schrägstrich (Verbot) bzw. mit „P“ (Pflicht-Abstellzone ohne Station); Form trägt die Art auch ohne Farbe
const violSvg = (c, bg, size = 20, css = '', mpz = false) => `<svg viewBox="0 0 20 20" width="${size}" height="${size}" aria-hidden="true" style="${css}overflow:visible"><circle cx="10" cy="10" r="7.5" fill="${bg}" stroke="${c}" stroke-width="3"/>${mpz ? `<text x="10" y="14" text-anchor="middle" font-size="11" font-weight="700" font-family="sans-serif" fill="${c}">P</text>` : `<path d="M4.7 4.7 15.3 15.3" stroke="${c}" stroke-width="3"/>`}</svg>`;
const stationText = (v) => (v.stationDistM != null ? t('col.stationDist', { m: X.fmt(v.stationDistM) }) : t('col.stationNone', { km: X.fmt(O.COLLECT.stationSearchM / 1000) }));
function initCollect() {
  if ($('#ops-col-panel')) return;
  if (S.show.viol == null) S.show.viol = true;
  const st = document.createElement('style'); st.id = 'ops-col-style';
  st.textContent = '.ops-col-head{margin:0 0 var(--s2);color:var(--fg-2)}.ops-col-head b{font-size:18px;color:var(--fg)}.ops-col-mk{background:none;border:0}.ops-col-mk svg{display:block}';
  document.head.appendChild(st);
  const anchor = $('#ops-spots')?.closest('.panel'); if (!anchor) return;
  anchor.insertAdjacentHTML('beforebegin', `<div class="panel c12 internal" id="ops-col-panel"><div class="panel-head"><div><h2 id="ops-col-h">${t('col.title')}</h2><div class="sub" id="ops-col-sub"></div></div><div class="inline-form"><button type="button" id="ops-col-csv" title="${t('col.csvTitle')}">↓ CSV</button></div></div>
    <p class="ops-col-head" id="ops-col-head"></p><div class="tbl" tabindex="0" role="region" aria-labelledby="ops-col-h"><table id="ops-col"><thead></thead><tbody></tbody></table></div><div class="empty" id="ops-col-empty" hidden></div>
    <p class="small muted" id="ops-col-note" style="margin:var(--s3) 0 0"></p></div>`);
  $('#ops-col-csv').addEventListener('click', () => { const c = colValid(); if (c?.res?.list.length) download(`${t('col.file')}_${ascii(X.muniName(c.ags))}_${ascii(c.op)}_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`, '﻿' + O.violationsCsv(c.res, { lang: lang() }), 'text/csv'); });
  $('#ops-col-panel').addEventListener('click', (e) => {
    const f = e.target.closest('[data-col-fly]'); if (f) { flyViol(+f.dataset.colFly); return; }
    if (e.target.closest('[data-col-retry]')) { S.col = null; S.retry = true; computePlan(); }
  });
  renderCollect();
}
// Zonen-Datei über den gemeinsamen Cache; nach „Erneut versuchen“ an einem gemerkten Fehlschlag vorbei (wie dataJson, Wunsch beim Start gemerkt)
async function zoneJson(file, retry) {
  const r = await X.getJson(X.CFG.DATA + `zones/${file}`, { timeout: 60000 });
  return !r.ok && retry && (!r.status || r.status >= 500) ? X.getJson(X.CFG.DATA + `zones/${file}?retry=${Date.now()}`, { timeout: 60000 }) : r;
}
// Gleiche Gemeinde, Flotte, Art und gleicher Sammler-Stand: Ergebnis bleibt (Tageszeit, Tage, Prioritätsregler rechnen nicht neu)
async function collectFor(ags, op, type, vehicles, fleet) {
  const key = `${ags}|${op}|${type}|${fleet.at}`;
  if (S.col?.key === key && S.col.state !== 'fail') { renderCollect(); return; }
  const job = S.col = { key, ags, op, type, at: fleet.at, state: 'loading', retry: S.retry };
  renderCollect();
  try {
    const idx = await X.loadOnce('zonesIndex', 'zones/index.json');
    const list = (idx?.zones || []).filter(z => z.operator === op && (z.municipalities || []).includes(ags));
    const got = await Promise.all(list.map(z => zoneJson(z.file, job.retry)));
    if (S.col !== job) return;
    const docs = got.filter(r => r.ok && Array.isArray(r.json?.features)).map(r => r.json);
    job.files = list.length; job.failed = list.length - docs.length;
    if (!idx || (list.length && !docs.length)) job.state = 'fail';
    else { await tick(); if (S.col !== job) return; job.res = O.parkingViolations({ vehicles, stations: fleet.stations }, docs, { operator: op }); job.state = 'ok'; }
  } catch (e) { console.error(e); job.state = 'fail'; }
  if (S.col === job) renderCollect();
}
function renderCollect() {
  const panel = $('#ops-col-panel'); if (!panel) return;
  const c = colValid(), f = X.fmt, esc = X.esc, B = O.COLLECT.buffers;
  const head = $('#ops-col-head'), sub = $('#ops-col-sub'), tbl = panel.querySelector('.tbl'), empty = $('#ops-col-empty');
  const show = (msg) => { tbl.hidden = !!msg; empty.hidden = !msg; empty.innerHTML = msg || ''; if (msg) panel.querySelector('tbody').innerHTML = ''; };
  $('#ops-col-h').textContent = t('col.title'); $('#ops-col-csv').title = t('col.csvTitle');
  $('#ops-col-note').textContent = t('col.method', { buffers: B.join('/'), stationM: O.COLLECT.stationM, mpzStationM: O.COLLECT.mpzStationM });
  $('#ops-col-csv').disabled = !(c?.state === 'ok' && c.res.list.length);
  syncViolToggle(); drawViol();
  if (S.plan && c && S.plan.ags === c.ags && S.plan.op === c.op) legend();
  head.innerHTML = ''; sub.textContent = c ? t('col.sub', { op: c.op, muni: X.muniName(c.ags), at: new Date(c.at).toLocaleString(fmtLocale(), { dateStyle: 'short', timeStyle: 'short' }) }) : '';
  if (!c) { show(t('col.noFleet')); return; }
  if (c.state === 'loading') { show(t('col.loading')); return; }
  if (c.state === 'fail') { show(`${t('col.failed')} <button type="button" class="chip" data-col-retry>${t('ops.tryAgain')}</button>`); return; }
  const r = c.res, k = r.counts;
  if (!r.features) { show(esc(t('col.noZones', { op: c.op }))); return; }
  // Kopfzeile: Summe und je Art (roh, robust gelistet); darunter die Zählung je Art zur Transparenz
  const kb = k.ban, km = k.mpz, rob = (x) => B.map(b => `${b} m ${f(x.robust[b])}`).join(', '), st = { stationM: r.stationM, mpzStationM: r.mpzStationM };
  head.innerHTML = `${t(k.listed === 1 ? 'col.headOne' : 'col.head', { n: `<b>${f(k.listed)}</b>`, buffers: B.join('/'), ban: f(kb.listed), raw: f(kb.raw), mpz: f(km.listed), mraw: f(km.raw), near: f(km.near), ...st })}`
    + `<br><span class="small muted">${esc(t('col.counts', { available: f(k.available), inZone: f(kb.inZone), mpz: f(kb.mpz), allowed: f(kb.allowed), station: f(kb.station), raw: f(kb.raw), robust: rob(kb), ...st }))}</span>`
    + (r.zones.mpz ? `<br><span class="small muted">${esc(t('col.countsMpz', { inZone: f(km.inZone), allowed: f(km.allowed), station: f(km.station), near: f(km.near), raw: f(km.raw), robust: rob(km), ...st }))}</span>` : '')
    + `<br><span class="small muted">${esc(t('col.zonesLine', { ban: f(r.zones.ban), mpzZones: f(r.zones.mpz), files: f(c.files) }))}</span>${c.failed ? `<br><span class="warn-text small">${esc(t('col.partial', { failed: f(c.failed), files: f(c.files) }))}</span>` : ''}`;
  if (!k.listed) { show(esc(t('col.none')) + (r.zones.ban + r.zones.mpz ? '' : ` ${esc(t('col.noBanZones'))}`)); return; }
  show(null);
  // 5 Spalten (am Telefon schmal): Rang · Standzeit, Lage, Art · Zone (mit Fahrzeugart, bei Pflicht-Abstellzone nächste Station), Ladestand · Reichweite, Karte
  tbl.querySelector('thead').innerHTML = `<tr><th class="n"># · ${t('col.idle')}</th><th>${t('ops.location')}</th><th>${t('col.kindZone')}</th><th class="n">${t('col.battery')} · ${t('col.range')}</th><th>${t('col.map')}</th></tr>`;
  tbl.querySelector('tbody').innerHTML = r.list.map((v, i) => {
    const g = geoKey(v.lat, v.lon), geo = GEO.get(g);
    const main = i < COL_GEO_TOP ? `<span class="geo-main" translate="no" data-geo="${g}" data-fallback="${esc(t('ops.addressNotFound'))}">${geo ? esc(geo) : geo === null ? t('ops.addressNotFound') : `<span class="muted">${t('ops.lookingUpAddress')}</span>`}</span><div class="sub-line">${osmLink(v.lat, v.lon)}</div>` : osmLink(v.lat, v.lon);
    const energy = [v.battery != null ? `${f(v.battery)} %` : null, v.rangeKm != null ? `${f(v.rangeKm, 1)} km` : null].filter(Boolean).join(' · ') || '–';
    return `<tr><td class="n"><span class="mono muted">${i + 1} ·</span> <b>${idleText(v)}</b>${v.idleMin != null ? `<div class="sub-line">${f(v.idleMin)} min</div>` : ''}</td><td>${main}</td><td>${violSvg(kindColor(v), tok('--panel'), 14, 'display:inline-block;vertical-align:-2px;margin-right:4px;', v.kind === 'mpz')}<b>${kindText(v)}</b><div class="sub-line">${esc(zoneLabel(v.zone))} · ${esc(X.TYPE[v.type] || v.type)}${v.kind === 'mpz' ? ` · ${stationText(v)}` : ''}</div></td>
      <td class="n">${energy}</td><td><button type="button" class="chip" data-col-fly="${i}">${t('ops.onMap')}</button></td></tr>`;
  }).join('');
  queueGeo(r.list.slice(0, COL_GEO_TOP));
}
// Kartenebene: Marker (Kreis mit Schrägstrich) je Fahrzeug, gestrichelte Umrisse der betroffenen Zonen (nicht anklickbar)
function drawViol() {
  if (!S.map) return;
  if (!S.vl) S.vl = { zones: L.featureGroup().addTo(S.map), pts: L.featureGroup().addTo(S.map) };
  S.vl.zones.clearLayers(); S.vl.pts.clearLayers(); S.violMk = [];
  const c = colValid(); if (!c || c.state !== 'ok' || !S.show.viol || isClient()) return;
  const bg = tok('--panel');
  for (const z of c.res.zonesHit) { const col = kindColor(z); L.geoJSON(z.geometry, { interactive: false, style: { color: col, weight: 1.5, dashArray: '5 4', fillColor: col, fillOpacity: 0.07 } }).addTo(S.vl.zones); }
  c.res.list.forEach((v, i) => {
    S.violMk[i] = L.marker([v.lat, v.lon], { icon: L.divIcon({ className: 'ops-col-mk', html: violSvg(kindColor(v), bg, 20, '', v.kind === 'mpz'), iconSize: [20, 20] }), keyboard: false, zIndexOffset: 400, title: t('col.markerTitle', { i: i + 1, kind: kindText(v), idle: idleText(v) }) })
      .bindPopup(() => `<b>${t('col.popupTitle', { i: i + 1, kind: kindText(v) })}</b><br>${X.esc(c.op)} · ${X.esc(X.TYPE[v.type] || v.type)} · ${X.esc(zoneLabel(v.zone))}${v.kind === 'mpz' ? ` · ${stationText(v)}` : ''}<br>${t('col.popupIdle', { idle: idleText(v) })}${v.battery != null ? ` · ${t('ops.battery', { battery: X.fmt(v.battery) })}` : ''}${v.rangeKm != null ? ` · ${X.fmt(v.rangeKm, 1)} km` : ''}<br><span style="color:var(--muted)">${t('col.popupNote', { buffers: O.COLLECT.buffers.join('/') })}</span>`).addTo(S.vl.pts);
  });
}
const violCount = () => { const c = colValid(); return c?.state === 'ok' ? c.res.list.length : 0; };
function violToggle() { return `<label class="tog internal"${violCount() ? '' : ' hidden'}><input type="checkbox" data-l="viol"${S.show.viol ? ' checked' : ''}> ${violSvg(tok('--warn'), tok('--panel'), 12, 'display:inline-block;vertical-align:-1px;')}<span>${t('col.layer')}</span></label>`; }
function syncViolToggle() { const i = $('#ops-layers input[data-l="viol"]'); if (!i) return; i.checked = !!S.show.viol; i.closest('label').hidden = !violCount(); }
// Legende: je vorkommender Art Zeichen und Anzahl, dazu der Hinweis auf die gestrichelten Zonen
function violLegend() {
  if (!S.show.viol || !violCount()) return '';
  const n = {}; for (const v of colValid().res.list) n[colKind(v)] = (n[colKind(v)] || 0) + 1;
  const item = (k, x) => `<span class="internal">${violSvg(kindColor(x), tok('--panel'), 12, 'display:inline-block;vertical-align:-1px;margin-right:6px;', k === 'mpz')}${kindText(x)} (${X.fmt(n[k])})</span>`;
  return [['noPark', { zone: {} }], ['noRide', { zone: { noRide: true } }], ['mpz', { kind: 'mpz' }]].filter(([k]) => n[k]).map(([k, x]) => item(k, x)).join('') + `<span class="internal muted">${t('col.legendZones')}</span>`;
}
// „Auf Karte“: Ebene einschalten, Karte auf das Fahrzeug, Popup öffnen, Fokus auf die Karte (dort weiter mit N/P, Esc)
function flyViol(i) {
  const c = colValid(), v = c?.res?.list[i]; if (!v || !S.map) return;
  if (!S.show.viol) { S.show.viol = true; syncViolToggle(); if (S.plan) legend(); }
  drawViol();
  const box = $('#ops-map'); box.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' });
  S.map.setView([v.lat, v.lon], Math.max(17, S.map.getZoom()), { animate: !reduced() });
  S.violMk[i]?.openPopup(); box.focus({ preventScroll: true });
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
  <h3>${t('ops.deploySpotsMcda')}</h3><p>${t('ops.factorsStandardisedTo0195th')}</p>
  <h3>${t('ops.uncertaintyH')}</h3><p>${t('ops.uncertaintyText', { z: O.BOOT.z, draws: O.BOOT.draws, minShare: O.BOOT.minShare * 100 })}</p></section>
  <section><h3>${t('ops.weightsAhp')}</h3><div class="tbl"><table><thead><tr><th>AHP</th>${A.criteria.map(c => `<th class="n">${AHP_L[c]}</th>`).join('')}<th class="n">${t('ops.weight')}</th></tr></thead><tbody>${A.criteria.map((c, i) => `<tr><td>${AHP_L[c]}</td>${A.matrix[i].map(x => `<td class="n mono">${f(x)}</td>`).join('')}<td class="n mono"><b>${A.weights[c].toFixed(3)}</b></td></tr>`).join('')}</tbody></table></div>
  <p class="small">${t('ops.saatyScale1EquallyImportant3', { lambdaMax: X.fmt(A.lambdaMax, 3), cr: X.fmt(A.cr, 4) })}</p></section>
  <section><h3>${t('ops.runs')}</h3><p>${t('ops.rebalanceSurplusMeans', { minBatteryForMove: D.minBatteryForMove, v1: D.maxPickupM / 1000, swapThreshold: f(D.swapThreshold), swapRangeKm: f(D.swapRangeKm) })}</p>
  <p>${t('ops.swapRangeRule', { share: Math.round(O.RANGE_LIMIT.share * 100), maxP95: O.RANGE_LIMIT.maxP95Km, minN: O.RANGE_LIMIT.minN, std: f(D.swapRangeKm) })}</p>
  <p>${t('ops.bundlingByAreaOpenJob', { v0: D.maxRunMin / 60 })}</p>
  <p>${t('ops.orderPerRunPrio', { levels: O.PRIO_LEVELS.map((l, i) => `${i} = λ ${X.fmt(l, l % 1 ? 1 : 0)}`).join(', '), exactMax: O.EXACT_MAX, osrmMax: OSRM_MAX, detour: X.fmt(D.detour, 2), speedKmh: D.speedKmh })}</p>
  <p>${t('ops.prioValues', { energyW: X.fmt(O.PRIO.energyW, 1), idleW: X.fmt(O.PRIO.idleW, 1), idleRefH: O.PRIO.idleRefH, longIdleH: O.PRIO.longIdleH, longIdleBonus: X.fmt(O.PRIO.longIdleBonus, 1), needRef: O.PRIO.needRef, emptyBonus: X.fmt(O.PRIO.emptyBonus, 1), fullStation: X.fmt(O.PRIO.fullStation, 1) })}</p></section>
  <section><h3>${t('ops.limits')}</h3><p>${t('ops.idleTimeCountsFromFirst')}</p></section>
  </div></details>`;
}
