// Mobility Pulse — Disposition (Ansicht) – Zustand, Steuerung und Daten laden (aus ops.js geschnitten; ops.js bleibt die Fassade für alle Importe).
import * as O from './pulse-ops.js';
import { cellsExpand, boxInside } from './pulse-split.js';
import { parseJsonSafe } from './pulse-core.js';
import { t, tMap, lang, fmtLocale } from './i18n.js';
import { mapKeys } from './mapkeys.js';
import { POP, SPOT_COLS, computePlan, drawLayers, drawMap, drawRoutes, fitAll, focusRun, legend, markFocus, openShared, planStatus, renderRuns, renderSpots, renderTiles, replanRuns, spotHead } from './ops-plan.js';
import { drawViol, groupsEmpty, initCollect, initGroupsUi, renderCollect, renderGroups, renderMethod, routeRuns } from './ops-extra.js';

export let X; // Kontext aus app.js: state, CFG, getJson, esc, fmt, opColor, muniName, notice, clearNotice, loadBoundaries, loadUsageIndex, loadCells, loadOnce, loadGroups, TYPE
export const $ = (s, el = document) => el.querySelector(s);
export const S = { map: null, layers: {}, canvas: {}, spotMarkers: [], ops: {}, fleetAgs: {}, osm: {}, wfs: {}, zones: {}, depot: {}, pickDepot: false, plan: null, routed: {}, show: { demand: true, official: true, fleet: true, spots: true, groups: true, collect: false, rebalance: true, swap: false, workshop: false, station: true }, busy: false, retry: false, pending: null, again: false, rescore: null, stale: false, routing: null, op: null, focus: null, prioLevel: urlPrio(),
  // Gruppen-Monatsdateien (groups/<JJJJ-MM>.json) und Ströme (flows/<Tag>.json): fertige Monate/Tage bleiben gecacht; index und laufender Monat werden bei neuem Stand neu geladen
  gidx: undefined, gdocs: {}, flowsIdx: undefined, flowDocs: {}, gf: null, area: {} };
// Farben je Thema: hell die dunkleren Stufen (≥ 3:1 auf Weiß und entsättigtem Kartengrund), dunkel die hellen; Ebenen aus den Themen-Tokens
const dk = () => document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
export const tok = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#888888';
export const RUN_COLOR = { get rebalance() { return dk() ? '#60a5fa' : '#2563eb'; }, get swap() { return dk() ? '#34d399' : '#047857'; }, get workshop() { return dk() ? '#ef6b6b' : '#c93c3c'; }, get station() { return dk() ? '#f59e0b' : '#b45309'; } };
export const IDLE_COL = () => (dk() ? '#c084fc' : '#7c3aed');
// Standzeit als Mindestwert (Z6, linkszensiert): Fahrzeuge tragen idleCensored (ops-Feld 13); Stopps nur die gerundete Stunde – sie gilt als „≥“,
// wenn sie bis auf einen Lauf (45 Min.) der Zeit seit Beginn der Verfolgung (ops trackStart) entspricht
const idleAtLeast = (h) => { const p = S.plan; return h != null && p?.trackStart != null && p.at != null && h >= (p.at - p.trackStart - 45 * 60e3) / 3600e3 - 0.5; };
// Standzeit kommt nur als Klasse (lib/pulse-ops.js idleClassMin): Text „unter 6 h“, „6–24 h“, „1–2 Tage“, als Mindestwert „≥ …“
export const idleCls = (min, atLeast = false) => O.idleClassText(min, { en: lang() === 'en', atLeast });
export const idleHText = (h) => (idleAtLeast(h) ? t('trk.idleHAtLeast', { idleMaxH: idleCls(h * 60, true) }) : t('ops.idleH', { idleMaxH: idleCls(h * 60) }));
export const RUN_KINDS = Object.keys(RUN_COLOR);
// Rechenschritte entkoppeln, damit Status gezeichnet wird und die Seite zwischen den Schritten reagiert
export const tick = () => globalThis.scheduler?.yield ? scheduler.yield() : new Promise(r => setTimeout(r, 0));
export const RUN_LABEL = { get rebalance() { return t('ops.rebalance'); }, get swap() { return t('ops.batterySwap'); }, get workshop() { return t('ops.workshop'); }, get station() { return t('ops.stationBalancing'); } };
export const STOP_LABEL = { get pickup() { return t('ops.pickUp'); }, get drop() { return t('ops.dropOff'); }, get swap() { return t('ops.swapBattery'); }, get pickup_disabled() { return t('ops.pickUpDefective'); } };
export const HOUR_BERLIN = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Europe/Berlin' }), DAY_BERLIN = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' });
export const BAND_NOW = () => O.bandOf(+HOUR_BERLIN.format(new Date()) % 24);
export const num = (id, d) => { const v = +$(id)?.value; return Number.isFinite(v) && v > 0 ? v : d; };
// Regler „Priorität ↔ Strecke“: Stufe 0–4 (O.PRIO_LEVELS → λ), in der URL als ?prio= (Standardstufe ohne Parameter; app.js syncUrl lässt ihn stehen)
// S2.12: Depot je Gemeinde in der URL (?depot=Breite,Länge), damit ein gesetztes Depot einen Neuladen übersteht und sich teilen lässt
export function urlDepot() { try { const m = /^(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)$/.exec(new URLSearchParams(location.search).get('depot') || ''); return m ? { lat: +m[1], lon: +m[2] } : null; } catch { return null; } }
function syncDepotUrl(d) {
  try { const q = new URLSearchParams(location.search); if (d) q.set('depot', `${d.lat.toFixed(5)},${d.lon.toFixed(5)}`); else q.delete('depot');
    const s = q.toString().replace(/%2F/g, '/').replace(/%2C/g, ','); history.replaceState(history.state, '', `${location.pathname}${s ? `?${s}` : ''}${location.hash}`); } catch { /* file:// o. Ä. */ }
}
function urlPrio() { try { const v = new URLSearchParams(location.search).get('prio'), n = v == null || v === '' ? NaN : +v; return Number.isInteger(n) && n >= 0 && n < O.PRIO_LEVELS.length ? n : O.PRIO_LEVEL_DEFAULT; } catch { return O.PRIO_LEVEL_DEFAULT; } }
function syncPrioUrl() {
  try { const q = new URLSearchParams(location.search); if (S.prioLevel === O.PRIO_LEVEL_DEFAULT) q.delete('prio'); else q.set('prio', String(S.prioLevel));
    const s = q.toString().replace(/%2F/g, '/'); history.replaceState(history.state, '', `${location.pathname}${s ? `?${s}` : ''}${location.hash}`); } catch { /* file:// o. Ä. */ }
}
export const prioLambda = () => O.PRIO_LEVELS[S.prioLevel] ?? O.DEFAULTS.prioLambda;
export const prioName = (lv = S.prioLevel) => t(`ops.prioLevel${lv}`);
function prioOut(lv = S.prioLevel) {
  const el = $('#ops-prio'), out = $('#ops-prio-val'); if (!el || !out) return; const l = O.PRIO_LEVELS[lv];
  out.textContent = `${prioName(lv)} (λ ${X.fmt(l, l % 1 ? 1 : 0)})`; el.setAttribute('aria-valuetext', out.textContent);
}

// Deep-Links: aktuelle Flotte lesen, Parameter aus der URL setzen (Flotte wird beim Rechnen geprüft)
export const opsFleet = () => S.op;
export function applyOpsParams({ op, type } = {}) {
  if (op) S.op = op;
  const sel = $('#ops-type'); if (type && [...sel.options].some(o => o.value === type) && sel.value !== type) { sel.value = type; applyTypePreset(); }
}
// Formular-Voreinstellung je Fahrzeugart (lib/pulse-ops.js TYPE_PRESETS): Transporter, Tausch-Kapazität und Energie-Schwellen; Hinweis für Autos/E-Roller
function applyTypePreset() {
  const ty = $('#ops-type').value, p = O.presetOf(ty);
  for (const [id, v] of [['#ops-van', p.van], ['#ops-swapcap', p.swapCapacity], ['#ops-swapthr', p.swapThreshold], ['#ops-swaprange', p.swapRangeKm]]) { const el = $(id); if (el) el.value = v; }
  const note = $('#ops-type-note'); if (note) { note.textContent = ty === 'car' ? t('ops.typeNoteCar') : ty === 'moped' ? t('ops.typeNoteMoped') : ''; note.hidden = !note.textContent; }
}
export const abbr = (text, title) => `<abbr title="${X.esc(title)}">${text}</abbr>`;
export const sig2 = (x) => { const p = 10 ** Math.max(0, Math.floor(Math.log10(Math.abs(x) || 1)) - 1); return Math.round(x / p) * p; };
export const hhmm = () => new Date().toLocaleTimeString(fmtLocale(), { hour: '2-digit', minute: '2-digit' });
// Tageszeit-Bänder (lib/pulse-track.js BANDS, Kennung 0–5) und Stabilität (lib/pulse-ops.js stabilityLabel) in der Sprache der Seite
export const bandLabel = (id) => t(`band.${id}`);
export const STAB = tMap('stab', { stabil: 1, mittel: 1, unsicher: 1 });
export const AHP_L = tMap('factor', O.AHP.labels);
// Faktor-Kürzel der Spot-Tabelle: intern Δ, N, Ö, A; angezeigt je Sprache (EN: Δ, D, T, P)
export const FL = (l) => t(`factor.letter.${{ 'Δ': 'outflow', N: 'demand', Ö: 'transit', A: 'parking' }[l]}`);
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
  $('#ops-type').addEventListener('change', () => { applyTypePreset(); computePlan(); });
  ['#ops-band', '#ops-days'].forEach(id => $(id).addEventListener('change', () => computePlan()));
  // S2.12: Straßenrouting (OSRM-Demo-Server) nur auf ausdrücklichen Wunsch: Seitenaufruf löst keine Anfrage aus
  $('#ops-route').addEventListener('change', (e) => { if (e.target.checked && S.plan) routeRuns(); else renderTiles(); });
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

export const ascii = (tq) => String(tq).replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue').replace(/ß/g, 'ss').normalize('NFKD').replace(/[^\w-]+/g, '-');
export const slug = () => `${ascii(X.muniName(S.plan.ags))}_${ascii(S.plan.op)}_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`;
export function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` })); a.download = name; a.style.display = 'none'; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000); }
export function status(html) { $('#ops-status').innerHTML = html; }
export const allRuns = () => S.plan ? [...S.plan.rebalance.runs, ...(S.plan.station?.runs || []), ...S.plan.swaps.runs, ...S.plan.workshop.runs] : [];

export function ensureMap() {
  if (S.map) { setTimeout(() => S.map.invalidateSize(), 50); return; }
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  S.map = L.map('ops-map', { preferCanvas: true, zoomAnimation: !still, fadeAnimation: !still, markerZoomAnimation: !still }).setView([51.1, 10.4], 6);
  S.tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: t('ops.openstreetmapContributors') }).addTo(S.map);
  // Eigener Canvas je Ebene: Routen neu zeichnen zeichnet nicht die (bis > 5.000) Fahrzeugpunkte und Zellen mit
  for (const k of ['demand', 'fleet', 'runs']) S.canvas[k] = L.canvas({ padding: 0.5 });
  for (const k of ['demand', 'official', 'fleet', 'spots', 'groups', 'collect', ...RUN_KINDS, 'depot']) S.layers[k] = L.featureGroup().addTo(S.map);
  for (const k of ['demand', 'fleet']) S.layers[k].on('click', openShared); // Klicks der Canvas-Marker steigen zur Gruppe auf
  S.map.on('click', (e) => { if (!S.pickDepot || !S.plan) return; S.depot[S.plan.ags] = { lat: e.latlng.lat, lon: e.latlng.lng }; syncDepotUrl(S.depot[S.plan.ags]); S.pickDepot = false; $('#ops-depot').classList.remove('primary'); computePlan(); });
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
  S.ops = {}; S.fleetAgs = {}; S.area = {}; for (const k of Object.keys(S.zones)) if (k.includes('#')) delete S.zones[k]; // Ausschnitte je Lauf (S3.8 Rest)
  for (const k of Object.keys(S.osm)) if (S.osm[k]?.from === 'Sammler') delete S.osm[k];
  // Gruppen: Verzeichnis und laufender (letzter) Monat neu, abgeschlossene Monate bleiben; Ströme: Verzeichnis neu, fertige Tage bleiben
  const lastM = S.gidx?.months?.slice(-1)[0]; if (lastM) delete S.gdocs[lastM];
  S.gidx = undefined; S.flowsIdx = undefined;
  if (S.plan) S.stale = true;
}
// Ohne Gemeinde („Deutschlandweit“) nur die Gemeindeauswahl zeigen, nicht das leere Gerüst aus Formular, Karte und Tabellen (wie der Vergleich)
const planUi = (on) => { for (const el of document.querySelectorAll('#view-ops > :not(.hero):not(#ops-pick)')) el.hidden = !on; if (on) S.map?.invalidateSize(); };
export function showPicker() {
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
export async function loadOpsDoc(stCode, ags = null) {
  // S3.8: Bestand nur der Gemeinde (ops-input/fleet/<AGS>.json, gleiches Format, Stationen bis 1,5 km um den Rahmen), wenn gelistet; sonst das Land
  if (ags) {
    const fi = await X.loadOnce('opsFleetIndex', 'ops-input/fleet/index.json', 25000);
    if (fi?.version === 1 && fi.ags?.includes(ags)) {
      const k = `${ags}|${fi.at}`;
      if (!(k in S.fleetAgs)) { const r = await dataJson(`ops-input/fleet/${ags}.json`, { timeout: 60000 }); S.fleetAgs[k] = r.ok && r.json?.ags === ags ? O.decodeFleet(r.json) : null; }
      if (S.fleetAgs[k]) return { fleet: S.fleetAgs[k] };
    }
  }
  if (!(stCode in S.ops)) { const r = await dataJson(`ops/${stCode}.json`, { timeout: 90000 }); if (!r.ok) return { fleet: null, status: r.status, error: r.error }; S.ops[stCode] = O.decodeFleet(r.json); }
  return { fleet: S.ops[stCode] };
}
// S3.8: bis 7 Tage aus ops-input/<AGS>.json (nur die Zellen der Gemeinde, gleiches Nachfragemodell wie aus den Landesdateien,
// test/split.test.mjs), wenn die Datei zum Datenstand passt; sonst und für 14 Tage die Landesdateien cells/<Tag>/<Land>.json
export async function loadCellDocs(stCode, days, ags = null) {
  const idx = await X.loadUsageIndex();
  const list = (idx.cellDays || []).slice(-days);
  const inp = ags ? await loadOpsInput(ags, idx) : null;
  if (inp && list.every(d => inp.cellDays.includes(d))) { S.input = inp; return inp.cells.filter(c => list.includes(c.day)); }
  return (await Promise.all(list.map(d => X.loadCells(d, stCode)))).filter(Boolean);
}
async function loadOpsInput(ags, idx) {
  const oi = await X.loadOnce('opsInputIndex', 'ops-input/index.json', 25000);
  const want = (idx.cellDays || []).slice(-(oi?.cellDays?.length || 0));
  if (oi?.version !== 1 || !oi.ags?.includes(ags) || JSON.stringify(oi.cellDays) !== JSON.stringify(want)) return null;
  // S3.8 Rest: spaltenweise Zellen mit den Strömen der Gemeinde (ops-input/cells/<AGS>.json), sonst die bisherige Datei
  if (oi.compact === 1) {
    const c = await dataJson(`ops-input/cells/${ags}.json`, { timeout: 60000 });
    if (c.ok && c.json?.version === 1 && c.json.ags === ags && Array.isArray(c.json.cells) && JSON.stringify(c.json.cellDays) === JSON.stringify(oi.cellDays)) return { ...c.json, cells: cellsExpand(c.json.cells) };
  }
  const r = await dataJson(`ops-input/${ags}.json`, { timeout: 60000 });
  return r.ok && r.json?.ags === ags && JSON.stringify(r.json.cellDays) === JSON.stringify(oi.cellDays) ? r.json : null;
}
// Gruppen-Ereignisse aller Monate (groups/index.json → groups/<JJJJ-MM>.json); ohne Verzeichnis (älterer Datenstand, 404) groups.json.
// Fehlgeschlagene Dateien werden nicht gecacht und als Warnung gemeldet.
export async function loadGroupDocs(ags = null) {
  if (S.gidx === undefined) { const r = await dataJson('groups/index.json', { timeout: 30000 }); S.gidx = r.ok && Array.isArray(r.json?.months) ? r.json : r.status === 404 ? null : undefined; if (S.gidx === undefined) { const d = await X.loadGroups(); return { docs: d ? [d] : [], source: 'groups.json', months: [], failed: ['groups/index.json'] }; } }
  if (!S.gidx) { const d = await X.loadGroups(); return { docs: d ? [d] : [], source: 'groups.json', months: [], failed: [] }; }
  const months = S.gidx.months, failed = [];
  // S3.8 Rest: nur die Ereignisse der Gemeinde aus ops-input/area (gleiche Monate wie groups/index.json)
  const ag = ags ? (await loadArea(ags))?.groups : null;
  if (ag && Array.isArray(ag.events) && JSON.stringify(ag.months) === JSON.stringify(months)) return { docs: [{ fields: ag.fields, events: ag.events }], source: 'groups', months, failed, index: S.gidx };
  await Promise.all(months.filter(m => !S.gdocs[m]).map(async m => { const r = await dataJson(`groups/${m}.json`, { timeout: 60000 }); if (r.ok && Array.isArray(r.json?.events)) S.gdocs[m] = r.json; else failed.push(`groups/${m}.json`); }));
  return { docs: months.map(m => S.gdocs[m]).filter(Boolean), source: 'groups', months, failed, index: S.gidx };
}
// Start-Ziel-Ströme der Nachfrage-Tage (flows/<Tag>.json erst nach Tagesende, ab 02.11.2026); fehlt das Verzeichnis, gibt es keinen Beleg
export async function loadFlowDocs(days) {
  // S3.8 Rest: Ströme der Gemeinde aus ops-input/cells (nur Tage mit Einträgen der Gemeinde; attachFlows überspringt die übrigen ohnehin)
  const fx = S.input?.flows;
  if (fx && Array.isArray(fx.days) && Array.isArray(fx.docs)) { const have = new Set(fx.days), want = days.filter(d => have.has(d)); return { docs: fx.docs.filter(d => want.includes(d.day)), indexed: !!fx.indexed, published: fx.days.length }; }
  if (S.flowsIdx === undefined) { const r = await dataJson('flows/index.json', { timeout: 25000 }); S.flowsIdx = r.ok ? r.json : r.status === 404 ? null : undefined; }
  const have = new Set(S.flowsIdx?.days || []), want = days.filter(d => have.has(d));
  await Promise.all(want.filter(d => !S.flowDocs[d]).map(async d => { const r = await dataJson(`flows/${d}.json`, { timeout: 60000 }); if (r.ok && Array.isArray(r.json?.flows)) S.flowDocs[d] = r.json; }));
  return { docs: want.map(d => S.flowDocs[d]).filter(Boolean), indexed: !!S.flowsIdx, published: S.flowsIdx?.days?.length || 0 };
}
// Zonen je Datei mit Stand (at aus zones/index.json): neuer Stand → neu laden; Fehlschlag wird nicht gecacht, sondern gemeldet
export async function loadNoPark(ags, op, bbox) {
  const src = await zoneSource(ags, op, bbox), idx = src ? null : await X.loadOnce('zonesIndex', 'zones/index.json');
  const list = src ? src.list : (idx?.zones || []).filter(z => z.operator === op && (z.municipalities || []).includes(ags));
  const geoms = [], mandatory = []; let failed = 0;
  for (const [i, { file: f, at }] of list.entries()) {
    const sd = src?.slice?.files?.[i]?.file === f ? src.slice.files[i].doc : null, key = sd ? `${src.path}#${f}` : f; // Ausschnitt nur für diese Gemeinde gemerkt
    if (S.zones[key]?.at !== at) { const doc = sd || await dataJson(`zones/${f}`, { timeout: 60000 }).then(r => (r.ok ? r.json : null)); if (!doc) { failed++; continue; } S.zones[key] = { at, ...O.zoneConstraints(doc) }; }
    for (const g of S.zones[key].noPark) if (!bbox || overlaps(g, bbox)) geoms.push(g);
    for (const g of S.zones[key].mandatory) if (!bbox || overlaps(g, bbox)) mandatory.push(g);
  }
  return { geoms, mandatory, files: list.length, failed, indexFailed: !src && !idx };
}
// S3.8 Rest: Ausschnitt der Gemeinde (ops-input/area/<AGS>.json, je Lauf neu): Umsatz-Eingabe, Gruppen-Ereignisse, Zonen-Dateien je Anbieter.
// Nur zum geladenen Datenstand passend (at); fehlt er, gelten die bisherigen Dateien.
export async function loadArea(ags) {
  const at = X.state.latest?.at, k = `${ags}|${at}`;
  if (!(k in S.area)) { const r = await dataJson(`ops-input/area/${ags}.json`, { timeout: 30000 }); S.area[k] = r.ok && r.json?.version === 1 && r.json.ags === ags && r.json.at === at ? r.json : null; }
  return S.area[k];
}
// Zonen-Dateien eines Anbieters in der Gemeinde aus dem Ausschnitt: { list: [{ file, at }], slice, path }; slice = ops-input/zones/<AGS>/<n>.json
// (Features außerhalb von cover sind null). need: Rahmen, der ganz im Ausschnitt liegen muss, false = ohne Prüfung. null → zones/index.json wie bisher.
export async function zoneSource(ags, op, need) {
  const z = (await loadArea(ags))?.zones; if (!z) return null;
  const e = z[op]; if (!e) return { list: [], slice: null, path: null };
  if (!e.path) return { list: e.files, slice: null, path: null };
  if (need !== false && !need) return null;
  const r = await dataJson(e.path, { timeout: 60000 }), sl = r.ok && r.json?.ags === ags && r.json.operator === op && Array.isArray(r.json.files) ? r.json : null;
  return sl && (need === false || boxInside(need, sl.cover)) ? { list: e.files, slice: sl, path: e.path } : null;
}
function overlaps(g, b) { const c = JSON.stringify(g.coordinates).match(/-?\d+\.\d+/g) || []; let x0 = 999, x1 = -999, y0 = 999, y1 = -999; for (let i = 0; i + 1 < c.length; i += 2) { const x = +c[i], y = +c[i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return !(x1 < b[0] || x0 > b[2] || y1 < b[1] || y0 > b[3]); }
// Umgebung (ÖPNV, Abstellflächen): erst die vom Sammler vorberechnete Datei, sonst Overpass im Hintergrund
const CTX_CATS = ['escooter', 'sharing', 'rad', 'official'];
export async function contextFor(ags) {
  if (S.osm[ags]?.state === 'ok' || S.osm[ags]?.state === 'loading') return S.osm[ags];
  if (!S.osm[ags]) {
    const r = await X.getJson(X.CFG.DATA + `context/${ags}.json`, { timeout: 30000 });
    if (r.ok) { const d = r.json; return (S.osm[ags] = { state: 'ok', from: 'Sammler', at: d.at, parking: d.parking.map(([lat, lon, c, name]) => ({ lat, lon, cat: d.cats?.[c] || CTX_CATS[c], name })), transit: d.transit.map(([lat, lon]) => ({ lat, lon })) }); }
  }
  return S.osm[ags] || null;
}
export function overpassBackground(ags, points, onDone) {
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
        if (!r.ok) continue; const j = parseJsonSafe(await r.text()); if (!Array.isArray(j?.elements) || j.remark) continue;
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
export async function officialData(ags) {
  // Katalog fehlt beim Start mit latest-core.json: Einträge der Gemeinde aus ops-input/area (S3.8 Rest, gleiche Reihenfolge)
  const pr = X.state.catalog ? X.state.catalog.parking_reference : (await loadArea(ags))?.parking ?? (await X.loadCatalog?.())?.parking_reference;
  const refs = Object.entries(pr || {}).filter(([k, r]) => !k.startsWith('_') && r?.ags === ags);
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
export const refCite = (ref) => `${/^https?:\/\//i.test(String(ref.source || '')) ? `<a href="${X.esc(ref.source)}" target="_blank" rel="noopener">${X.esc(refLabel(ref))}</a>` : X.esc(refLabel(ref))}${ref.license ? ` (${X.esc(ref.license)}${ref.attribution ? `, ${X.esc(ref.attribution)}` : ''})` : ''}`;
// Sichtbare Warnungen zu fehlenden Kontextdaten (statt stillem Weiterrechnen)
export function renderWarn(ags, osm, np, official, groupRes = S.plan?.groupSrc) {
  const w = [];
  if (groupRes?.failed?.length) w.push(`<div class="note warn" role="alert">${t('ops.groupEventsIncompleteNot', { v0: groupRes.failed.map(x => `<span class="mono">${X.esc(x)}</span>`).join(', '), v1: groupRes.source === 'groups.json' ? t('ops.onlyFromGroupsJson30Days') : t('ops.withoutTheseMonths') })} <button class="chip" id="ops-retry">${t('ops.tryAgain')}</button></div>`);
  if ($('#ops-osm').checked && !osm && S.osm[ags]?.state === 'fail') w.push(`<div class="note warn" role="alert">${t('ops.openstreetmapNotReachable')} <button class="chip" id="ops-osm-retry">${t('ops.tryAgain')}</button></div>`);
  if (np?.indexFailed) w.push(`<div class="note warn" role="alert">${t('ops.zoneDirectoryNotLoadedZones')} <button class="chip" id="ops-retry">${t('ops.tryAgain')}</button></div>`);
  else if (np?.failed) w.push(`<div class="note warn" role="alert">${t('ops.zonesNotLoadedOfZoneFeeds', { failed: X.fmt(np.failed), files: X.fmt(np.files) })} <button class="chip" id="ops-retry">${t('ops.tryAgain')}</button></div>`);
  for (const { ref, error } of official?.failed || []) w.push(`<div class="note warn" role="alert">${t('ops.notLoadedSpots', { refLabel: X.esc(refLabel(ref)), error: X.esc(error), v2: ref.kind === 'noPark' ? t('ops.withoutCitySNoParkingZones') : t('ops.withoutTheseParkingAreas') })} <button class="chip" id="ops-retry">${t('ops.tryAgain')}</button></div>`);
  $('#ops-warn').innerHTML = w.join('');
}
