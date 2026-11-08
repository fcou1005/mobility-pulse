// Mobility Pulse — Vermutete Fahrtrouten (Nutzung): Start-Ziel-Ströme zwischen ≈ 250-m-Zellen aus flows/<Tag>.json (Sammler, lib/pulse-track.js publishFlows).
// Linie je Strom = wahrscheinlichster Radweg zwischen den Zellmitten (FOSSGIS-OSRM, Fahrradprofil), nicht gemessen; Rückfall Luftlinie (gestrichelt).
// Gemessen: nur Anbieter mit stabilen Kennungen (flows/). Geschätzt: Anbieter mit rotierenden Kennungen, erwartete Fahrten je ≈ 500-m-Zellenpaar
// (flows-est/, lib/pulse-flowest.js, keine Einzelverknüpfung). Nur Zellenpaare mit ≥ 2 Fahrten am Tag; ein Tag erscheint erst nach Tagesende.
// Eigenständig: renderFlows(el, ctx), ctx = { state, CFG, esc, fmt, getJson, opColor, muniName, loadUsageIndex }; Leaflet (L) global.
import { VEHICLE_TYPE_LABEL } from './pulse-core.js?v=mw7k541t';
import { t, tMap, lang, dateFmt, decimalSep } from './i18n.js?v=mw7k541t';
import { mapKeys } from './mapkeys.js?v=mw7k541t';

const OSRM_BIKE = 'https://routing.openstreetmap.de/routed-bike/route/v1/bike/';
const SHOW = 40;            // Ströme auf Karte, in der Tabelle und mit Routing (Top nach Anzahl)
const REQ_GAP_MS = 1050;    // höchstens eine Routing-Anfrage je Sekunde (alle Panels zusammen; 50 ms Reserve für Zeitgeber-Schwankung)
const REQ_TIMEOUT_MS = 15000;
const LS_KEY = 'mp-fl-routes-v1', LS_MAX = 300, LS_VIEW = 'mp-fl-view';
const CELL_FALLBACK = [0.0025, 0.0035]; // lib/pulse-track.js CELL_LAT/CELL_LON, falls die Datei kein Zellmaß nennt
const BANDS_FALLBACK_DEF = () => ([[t('flows.night'), 0, 6], [t('flows.morning'), 6, 9], [t('flows.lateMorning'), 9, 12], [t('flows.midday'), 12, 15], [t('flows.afternoon'), 15, 19], [t('flows.evening'), 19, 24]].map(([label, from, to]) => ({ label, from, to })));
const NEUTRAL = '#3d4a5c';  // mehrere Anbieter: Schiefergrau außerhalb der Anbieterpalette, auf den hellen OSM-Kacheln ≥ 7:1
const TILE_BG = '#f2efe9';  // Grundton der OSM-Kacheln: Legende zeigt die Linie wie auf der Karte
const CELL_RE = /^-?\d{1,6}:-?\d{1,6}$/;

const STYLE = `
.fl-root{display:flex;flex-direction:column;gap:var(--s3)}
.fl-root .panel-head{margin-bottom:0}
.fl-root [hidden]{display:none!important}
.fl-ctl select{max-width:240px}
.fl-note{font-size:12.5px;line-height:1.5}
.fl-note b{color:var(--fg);font-weight:600}
.fl-sum{display:flex;flex-wrap:wrap;gap:var(--s1) var(--s4);font-size:12.5px;color:var(--fg-2)}
.fl-sum b{font-family:var(--mono);font-weight:600;color:var(--fg);font-variant-numeric:tabular-nums}
.fl-bar{display:flex;flex-wrap:wrap;gap:var(--s2) var(--s3);align-items:center;justify-content:space-between}
.fl-tog{display:inline-flex;gap:2px;padding:3px;border-radius:10px;background:var(--bg-2);border:1px solid var(--line)}
.fl-tog button{min-height:26px;border:0;background:transparent;color:var(--fg-2);padding:0 12px;border-radius:7px}
.fl-tog button:hover{color:var(--fg)}
.fl-tog button[aria-pressed="true"]{background:var(--thumb);color:var(--fg);box-shadow:inset 0 0 0 1px var(--line-2)}
.fl-map{height:460px;border-radius:var(--r-sm);border:1px solid var(--line);background:var(--bg-2);isolation:isolate}
.fl-legend{display:flex;flex-wrap:wrap;gap:var(--s1) var(--s4);align-items:center;font-size:12px;color:var(--fg-2)}
.fl-legend .mono{font-family:var(--mono);color:var(--fg)}
.fl-sw{display:inline-block;width:26px;height:12px;margin-right:6px;vertical-align:-2px;border-radius:3px;border:1px solid var(--line-2);background:linear-gradient(var(--fl-c),var(--fl-c)) center/18px var(--fl-w,3px) no-repeat,${TILE_BG}}
.fl-sw.dash{background:repeating-linear-gradient(90deg,var(--fl-c) 0 5px,transparent 5px 9px) center/18px 3px no-repeat,${TILE_BG}}
.fl-pt{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:4px;vertical-align:-1px;border:2px solid var(--fg-2)}
.fl-pt.end{background:var(--fg-2);border-color:var(--fg-2)}
.fl-status{font-size:12px;color:var(--muted)}
.fl-cell{font-family:var(--mono);font-size:12px;white-space:nowrap}
.fl-root .tbl{max-height:min(62vh,560px)}
.fl-root td .op{font-weight:500}
.leaflet-tooltip.fl-tip{background:var(--panel);color:var(--fg-2);border:1px solid var(--line-2);border-radius:var(--r-sm);box-shadow:var(--shadow);padding:6px 10px;font:12px/1.45 var(--sans);width:max-content;max-width:min(300px,70vw);white-space:normal}
.leaflet-tooltip.fl-tip b{display:block;font-family:var(--mono);font-size:14px;font-weight:600;color:var(--fg)}
.leaflet-tooltip-left.fl-tip::before{border-left-color:var(--line-2)}.leaflet-tooltip-right.fl-tip::before{border-right-color:var(--line-2)}
@media (max-width:720px){.fl-map{height:340px}.fl-ctl{width:100%;display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:var(--s2)}.fl-ctl label{display:flex;flex-direction:column;align-items:stretch;gap:2px;font-size:12px}.fl-ctl select{max-width:none;width:100%}}
`;
function injectStyle() {
  if (document.getElementById('fl-style')) return;
  const s = document.createElement('style'); s.id = 'fl-style'; s.textContent = STYLE; document.head.appendChild(s);
}

// ---------- Zustand je Panel ----------
const STATES = new WeakMap(), ACTIVE = new Set();
const st = (el) => { let s = STATES.get(el); if (!s) { s = { el, gen: 0, docs: new Map(), sel: null, queue: [], drawn: new Map(), fails: 0, src: 'measured' }; STATES.set(el, s); } return s; };
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const shown = (S) => S.el.isConnected && S.el.offsetParent !== null && document.visibilityState !== 'hidden';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- Routen-Cache: Speicher + localStorage (fehlertolerant, begrenzt) ----------
const MEM = new Map(); // 'von>nach' → { d: Meter, s: Sekunden, c: [[lat, lon], …] } | { fail: true }
let LS = null;
const lsRead = () => { try { const o = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; } };
const encode = (c) => c.flatMap(([a, b]) => [Math.round(a * 1e5), Math.round(b * 1e5)]);
function decode(arr) {
  if (!Array.isArray(arr) || arr.length < 4 || arr.length % 2) return null;
  const out = []; for (let i = 0; i < arr.length; i += 2) { const a = arr[i] / 1e5, b = arr[i + 1] / 1e5; if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 90 || Math.abs(b) > 180) return null; out.push([a, b]); }
  return out;
}
function cacheGet(k) {
  if (MEM.has(k)) return MEM.get(k);
  LS ??= lsRead();
  const v = LS[k]; const c = v && decode(v.c);
  if (c && Number.isFinite(v.d)) { const r = { d: v.d, s: Number.isFinite(v.s) ? v.s : null, c }; MEM.set(k, r); return r; }
  return null;
}
function cachePut(k, r) {
  MEM.set(k, r);
  try {
    LS = lsRead(); LS[k] = { d: Math.round(r.d), s: r.s == null ? null : Math.round(r.s), c: encode(r.c), t: Date.now() };
    const keys = Object.keys(LS);
    if (keys.length > LS_MAX) { keys.sort((a, b) => (LS[a]?.t || 0) - (LS[b]?.t || 0)); for (const x of keys.slice(0, keys.length - LS_MAX)) delete LS[x]; }
    localStorage.setItem(LS_KEY, JSON.stringify(LS));
  } catch { /* privates Fenster oder Speicher voll: Route gilt nur in dieser Sitzung */ }
}
const viewPref = () => { try { return localStorage.getItem(LS_VIEW) === 'table' ? 'table' : 'map'; } catch { return 'map'; } };
const setViewPref = (v) => { try { localStorage.setItem(LS_VIEW, v); } catch { /* egal */ } };

// ---------- Hilfen ----------
function cellCenter(S, cell) { const [a, b] = cell.split(':').map(Number); return [a * S.cellDim[0], b * S.cellDim[1]]; }
// Datum 'JJJJ-MM-TT' im Format der Sprache (de 01.11.2026, en 01/11/2026); Fahrzeugart und Tageszeit-Band in der Sprache der Seite
const TYPE = tMap('type', VEHICLE_TYPE_LABEL);
const ymd = (d) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10), 12));
const dmy = (d) => (d ? dateFmt({ day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(ymd(d)) : '–');
const dm = (d) => (d ? dateFmt({ day: '2-digit', month: '2-digit', timeZone: 'UTC' }).format(ymd(d)) : '–');
const typeLabel = (tq) => (tq == null ? t('flows.severalTypes') : TYPE[tq] || tq);
const bandLabel = (S, b) => { const x = S.bands[b]; return x ? t('flows.bandRange', { label: t(`band.${b}`), from: x.from, to: x.to }) : String(b); };
function durText(ctx, sec) { if (sec == null || !Number.isFinite(sec)) return '—'; return sec < 3600 ? t('flows.min', { v0: ctx.fmt(sec / 60) }) : t('flows.h', { v0: ctx.fmt(sec / 3600, 1) }); }
const kmText = (ctx, m) => (m == null || !Number.isFinite(m) ? '—' : `${ctx.fmt(m / 1000, 1)} km`);
const plural = (ctx, n, one, many) => `${ctx.fmt(n, Number.isInteger(n) ? 0 : 1)} ${n === 1 ? one : many}`;
const nf = (S, n) => S.ctx.fmt(n, S.est && !Number.isInteger(n) ? 1 : 0); // geschätzte Ströme: erwartete Fahrten mit einer Nachkommastelle
const avgDur = (f) => (f.dur == null ? null : f.dur / f.n);
/** Güte der Schätzung (blind an Quellen mit stabilen Kennungen geprüft, lib/pulse-flowest.js validateDay) */
function qualityText(S, q) {
  const n2 = (x) => S.ctx.fmt(x, 2);
  if (!q || !Number.isFinite(q.cpc)) return t('flows.estQualityNone');
  return t('flows.estQuality', { cpc: n2(q.cpc), base: Number.isFinite(q.cpcBase) ? n2(q.cpcBase) : '–', r: Number.isFinite(q.r) ? n2(q.r) : '–', top: Number.isFinite(q.topRatio) ? S.ctx.fmt(q.topRatio * 100) : '–' });
}
/** CSV-Zelle: Deutsch mit Semikolon und Dezimalkomma, Englisch mit Komma und Dezimalpunkt; Text mit = + - @ Tab/CR am Anfang bekommt ' davor (Formel-Injection) */
const csvSep = () => (decimalSep() === ',' ? ';' : ',');
function csvCell(v, digits = null) {
  if (v == null || (typeof v === 'number' && !Number.isFinite(v))) return '';
  let s;
  if (typeof v === 'number') s = (digits == null ? String(+v.toFixed(5)) : v.toFixed(digits)).replace('.', decimalSep());
  else { s = String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; }
  return s.includes(csvSep()) || /["\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}
const toCsv = (rows) => rows.map(r => r.map(c => (Array.isArray(c) ? csvCell(c[0], c[1]) : csvCell(c))).join(csvSep())).join('\r\n');
function download(name, text) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' })); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
// Zeilen der Datei prüfen (Datenzweig ist öffentlich beschreibbar nur durch den Sammler, trotzdem nichts ungeprüft zeichnen)
function validRows(doc) {
  return (Array.isArray(doc?.flows) ? doc.flows : []).filter(r => Array.isArray(r) && r.length >= 9 && typeof r[0] === 'string' && CELL_RE.test(r[1]) && CELL_RE.test(r[2]) && Number.isFinite(r[6]) && r[6] > 0 && (Number.isFinite(r[7]) || (doc.estimated === true && r[7] === null)) && Number.isFinite(r[8])
    && (r[3] == null || typeof r[3] === 'string') && (r[4] == null || typeof r[4] === 'string') && (r[5] == null || (Number.isInteger(r[5]) && r[5] >= 0 && r[5] < 12)));
}

// ---------- Aufbau ----------
function skeleton(S) {
  const { el } = S;
  el.classList.add('fl-root');
  el.innerHTML = `<div class="panel-head"><div><h2>${t('flows.presumedTripRoutes')}</h2><div class="sub" data-fl="sub">${t('flows.originDestinationFlows')}</div></div>
    <div class="inline-form fl-ctl">
      <div class="fl-tog" role="group" aria-label="${t('flows.source')}" data-fl="srcbox"><button type="button" data-fl-src="measured" aria-pressed="true" title="${t('flows.measuredTip')}">${t('flows.measured')}</button><button type="button" data-fl-src="est" aria-pressed="false" title="${t('flows.estimatedTip')}">${t('flows.estimated')}</button></div>
      <label data-fl="ags-l" hidden>${t('flows.municipality')} <select data-fl="ags" title="${t('flows.municipalitiesWithPublished')}"></select></label>
      <label>${t('flows.day')} <select data-fl="day"></select></label>
      <label>${t('flows.operator')} <select data-fl="op"></select></label>
      <label>${t('flows.vehicleType')} <select data-fl="type"></select></label>
      <label>${t('flows.timeOfDay')} <select data-fl="band"></select></label>
    </div></div>
  <div class="note fl-note" data-fl="note"></div>
  <div class="fl-sum" data-fl="sum" aria-live="polite"></div>
  <div class="fl-bar" data-fl="bar"><div class="fl-tog" role="group" aria-label="${t('flows.display')}"><button type="button" data-fl-view="map" aria-pressed="true">${t('flows.map')}</button><button type="button" data-fl-view="table" aria-pressed="false">${t('flows.table')}</button></div>
    <span class="fl-status" data-fl="status" aria-live="polite"></span><button type="button" data-fl="csv" title="${t('flows.allFlowsOfSelectionNotOnly', { SHOW })}">↓ CSV</button></div>
  <div data-fl="mapbox"><div class="fl-map" data-fl="map" role="region" aria-label="${t('flows.mapOfPresumedTripRoutesSame')}"></div><div class="fl-legend" data-fl="legend"></div></div>
  <div class="tbl" tabindex="0" role="region" aria-label="${t('flows.topFlowsAsTable')}" data-fl="tblbox" hidden><table><thead><tr><th class="n">#</th><th>${t('flows.startCellCentre')}</th><th>${t('flows.destinationCellCentre')}</th><th>${t('flows.operator')}</th><th class="n">${t('flows.trips')}</th><th class="n">${t('flows.avgDuration')}</th><th class="n">${t('flows.avgStraightLine')}</th><th class="n">${t('flows.bikeRoute')}</th></tr></thead><tbody data-fl="tbody"></tbody></table></div>
  <div data-fl="empty" hidden></div>`;
  const q = (k) => el.querySelector(`[data-fl="${k}"]`);
  S.q = q;
  for (const k of ['ags', 'day', 'op', 'type', 'band']) q(k).addEventListener('change', () => { S.sel[k] = q(k).value; update(S).catch(e => console.error('Ströme', e)); });
  el.querySelectorAll('[data-fl-view]').forEach(b => b.addEventListener('click', () => { S.view = b.dataset.flView; setViewPref(S.view); applyView(S); }));
  el.addEventListener('click', (e) => { const b = e.target.closest('[data-fl-src]'); if (!b || b.dataset.flSrc === S.src) return; S.src = b.dataset.flSrc; S.sel.day = null; update(S).catch(err => console.error('Ströme', err)); });
  q('csv').addEventListener('click', () => exportCsv(S));
  S.view = viewPref();
  if (typeof IntersectionObserver === 'function') {
    S.io = new IntersectionObserver((ents) => {
      if (ents.some(e => e.isIntersecting)) { if (S.map) { S.map.invalidateSize(); if (S.needFit) fit(S); } if (S.queue.length && !S.pumpTok) startPump(S); }
      else if (!shown(S)) stopRouting(S); // Ansicht gewechselt: laufende Anfrage abbrechen, Warteschlange bleibt
    }, { rootMargin: '4000px 0px' });
    S.io.observe(el);
  }
  ACTIVE.add(S);
  S.built = true;
}
function applyView(S) {
  const m = S.view !== 'table';
  S.el.querySelectorAll('[data-fl-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.flView === S.view)));
  S.q('mapbox').hidden = !m || !S.hasMap; S.q('tblbox').hidden = m && S.hasMap; S.el.querySelector('.fl-tog').hidden = !S.hasMap;
  if (m && S.map) setTimeout(() => { S.map.invalidateSize(); if (S.needFit) fit(S); }, 0);
}
function ensureMap(S) {
  if (S.map || typeof L === 'undefined') { S.hasMap = !!S.map; return; }
  const still = reduced();
  S.map = L.map(S.q('map'), { zoomControl: true, zoomAnimation: !still, fadeAnimation: !still, markerZoomAnimation: !still, inertia: !still }).setView([51.1, 10.4], 6);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: t('flows.openstreetmapContributors') }).addTo(S.map);
  S.layer = L.layerGroup().addTo(S.map);
  mapKeys(S.map); // Tastatur: N/P durch die Ströme im Ausschnitt, Hervorhebung wie beim Überfahren (web/mapkeys.js)
  S.hasMap = true;
}

// ---------- Rendern ----------
export async function renderFlows(el, ctx) {
  injectStyle();
  const S = st(el); S.ctx = ctx;
  if (!S.built) skeleton(S);
  const key = `${ctx.state.scope}|${ctx.state.operator}|${ctx.state.type}`;
  if (!S.sel || S.sel.key !== key) S.sel = { key, ags: ctx.state.scope !== 'DE' ? ctx.state.scope : null, day: null, op: ctx.state.operator || 'all', type: ctx.state.type || 'all', band: 'all', fromUsage: ctx.state.usage?.day || null };
  else if (ctx.state.usage?.day && ctx.state.usage.day !== S.sel.fromUsage) { S.sel.fromUsage = ctx.state.usage.day; S.sel.day = null; } // Tag im Nutzungs-Tab gewechselt
  return update(S);
}
/** Laufendes Routing anhalten (z. B. beim Verlassen der Ansicht); renderFlows bzw. Sichtbarkeit setzt es fort */
export function abortFlows(el) { const S = STATES.get(el); if (S) stopRouting(S); }
/** Sprachwechsel: Gerüst (Beschriftungen, Karte samt Namensnennung) beim nächsten renderFlows neu aufbauen; Auswahl, Dateien und Routen-Cache bleiben */
export function relabelFlows() {
  for (const S of [...ACTIVE]) { stopRouting(S); S.io?.disconnect(); S.io = null; S.map?.remove(); S.map = null; S.layer = null; S.hasMap = false; S.built = false; S.drawn.clear(); ACTIVE.delete(S); }
}

async function update(S) {
  const gen = ++S.gen; stopRouting(S);
  const { ctx, sel, q } = S;
  const esc = ctx.esc;
  S.est = S.src === 'est';
  const dir = S.est ? 'flows-est/' : 'flows/';
  S.el.querySelectorAll('[data-fl-src]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.flSrc === S.src)));
  const idxR = await ctx.getJson(`${ctx.CFG.DATA}${dir}index.json`, { timeout: 25000 });
  if (gen !== S.gen) return;
  const idx = idxR?.ok ? idxR.json : null;
  const days = (Array.isArray(idx?.days) ? idx.days : []).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  // Tag: Wahl im Panel, sonst der Tag des Nutzungs-Tabs (wenn veröffentlicht), sonst der letzte abgeschlossene
  if (!sel.day || !days.includes(sel.day)) sel.day = days.includes(sel.fromUsage) ? sel.fromUsage : days[days.length - 1] || null;
  q('day').innerHTML = days.length ? [...days].reverse().map(d => `<option value="${esc(d)}">${esc(dmy(d))}</option>`).join('') : '<option value="">–</option>';
  q('day').value = sel.day || '';
  const collecting = typeof idx?.collecting === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(idx.collecting) ? idx.collecting : null;
  const minN = Number.isFinite(idx?.min) ? idx.min : S.est ? 2 : 5; // Mindestschwelle je Zeile (gemessen 5, geschätzt 2 erwartete Fahrten)
  const howNote = S.est ? `${t('flows.estHow')} ${qualityText(S, idx?.quality)}` : t('flows.routeMostLikelyCycleRoute', { min: minN });
  const privacy = S.est ? t('flows.estPrivacy', { min: minN }) : t('flows.mobilityPulseLinksStartAnd', { min: minN });
  if (!days.length) {
    if (S.est) return empty(S, idxR?.status === 404 || !idx ? t('flows.estNoFiles') : t('flows.estNoDay'), `${collecting ? `${t('flows.collectorIsCurrently', { dmy: esc(dmy(collecting)) })} ` : ''}${privacy}`, howNote);
    return empty(S, idxR?.status === 404 || !idx ? t('flows.noFlowFilesInDataSnapshotYet') : t('flows.noCompletedDayWithFlowsYet'),
      `${collecting ? `${t('flows.collectorIsCurrently', { dmy: esc(dmy(collecting)) })} ` : ''}${privacy}`, howNote);
  }
  const dk = `${S.src}|${sel.day}`;
  let doc = S.docs.get(dk);
  if (doc === undefined) {
    q('sum').textContent = t('flows.loadingFlows');
    const r = await ctx.getJson(`${ctx.CFG.DATA}${dir}${sel.day}.json`, { timeout: 60000 });
    if (gen !== S.gen) return;
    doc = r?.ok && r.json && Array.isArray(r.json.flows) ? r.json : null; S.docs.set(dk, doc);
  }
  if (!doc) return empty(S, t('flows.flowFileForNotLoadable', { dmy: esc(dmy(sel.day)) }), t('flows.chooseAnotherDayOrReload'), howNote);
  S.cellDim = Array.isArray(doc.cell) && doc.cell.length === 2 && doc.cell.every(x => Number.isFinite(x) && x > 0 && x < 0.1) ? doc.cell : CELL_FALLBACK;
  S.bands = Array.isArray(doc.bands) && doc.bands.length === 6 && doc.bands.every(b => b && typeof b.label === 'string') ? doc.bands : BANDS_FALLBACK_DEF();
  S.doc = doc; S.rows = validRows(doc);
  const munis = doc.munis && typeof doc.munis === 'object' ? doc.munis : {};
  const name = (a) => ctx.muniName(a);
  const withFlows = Object.entries(munis).filter(([, m]) => m?.shown > 0).sort((a, b) => b[1].shown - a[1].shown || name(a[0]).localeCompare(name(b[0]), 'de'));
  // Gemeinde: Gebiet oben, deutschlandweit Auswahl unter den Gemeinden mit Strömen
  const de = ctx.state.scope === 'DE';
  if (de) { if (!sel.ags || !withFlows.some(([a]) => a === sel.ags)) sel.ags = withFlows[0]?.[0] || null; } else sel.ags = ctx.state.scope;
  q('ags-l').hidden = !de;
  if (de) { q('ags').innerHTML = withFlows.map(([a, m]) => `<option value="${esc(a)}">${esc(name(a))} (${esc(nf(S, m.shown))})</option>`).join('') || '<option value="">–</option>'; q('ags').value = sel.ags || ''; }
  const others = withFlows.filter(([a]) => a !== sel.ags).slice(0, 6).map(([a, m]) => `${esc(name(a))} (${esc(nf(S, m.shown))})`).join(', ');
  const m = sel.ags ? munis[sel.ags] : null, stable = (sel.ags && Array.isArray(doc.stable?.[sel.ags]) ? doc.stable[sel.ags] : []).filter(x => typeof x === 'string');
  q('sub').textContent = t(S.est ? 'flows.originDestinationFlowsEst' : 'flows.originDestinationFlows2', { v0: sel.ags ? name(sel.ags) : t('flows.germany'), v1: dmy(sel.day) });
  if (!sel.ags || !(m?.shown > 0)) {
    const place = sel.ags ? esc(name(sel.ags)) : t('flows.germany');
    if (S.est) return empty(S, !sel.ags ? t('flows.noPublishedFlowsOn', { dmy: esc(dmy(sel.day)) }) : t('flows.estNoPair', { place: sel.ags ? esc(name(sel.ags)) : t('flows.germany'), dmy: esc(dmy(sel.day)) }),
      `${others ? `${t('flows.onThisDayThereAreFlowsIn', { others })} ` : ''}${privacy}`, howNote);
    const head = !sel.ags ? t('flows.noPublishedFlowsOn', { dmy: esc(dmy(sel.day)) }) : !stable.length && !(m?.trips > 0) ? t('flows.inNoOperatorReportsStable', { place, dmy: esc(dmy(sel.day)) }) : t('flows.noCellPairWithAtLeast2Trips', { place, dmy: esc(dmy(sel.day)), min: Number.isFinite(doc.min) ? doc.min : minN });
    const detail = sel.ags && (stable.length || m?.trips) ? t('flows.operatorsWithStableIds', { v0: esc(stable.join(', ') || Object.keys(m?.ops || {}).join(', ')), v1: m?.trips ? `${t('flows.withStartAndDestinationAll', { v0: plural(ctx, m.trips, t('flows.trip'), t('flows.trips2')) })} ` : '' }) : '';
    return empty(S, head, `${detail}${others ? `${t('flows.onThisDayThereAreFlowsIn', { others })} ` : ''}${privacy}`, howNote);
  }
  // Auswahl Anbieter/Art/Tageszeit: Optionen aus den Zeilen der Gemeinde; Vorgabe aus dem Filter oben bleibt sichtbar, auch wenn leer
  const rowsA = S.rows.filter(r => r[0] === sel.ags);
  fillSelects(S, rowsA);
  // Hinweis: Methode, beitragende Anbieter
  const contrib = Object.entries(m.ops || {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([o, n]) => `${esc(o)} (${esc(nf(S, n))})`).join(', ');
  q('note').innerHTML = t('flows.contributingOperatorsIn', { howNote: S.est ? `${t('flows.estHow')} ${qualityText(S, doc.quality)}` : howNote, name: esc(name(sel.ags)), v2: contrib || '–', v3: stable.length ? ` · ${t('flows.stableIdsInArea', { join: esc(stable.join(', ')) })}` : '' });
  // Filtern und je Zellenpaar zusammenfassen
  const band = sel.band === 'all' ? null : +sel.band;
  const rows = rowsA.filter(r => (sel.op === 'all' || r[3] === sel.op) && (sel.type === 'all' || r[4] === sel.type) && (band == null || r[5] === band));
  S.filtered = rows;
  const by = new Map();
  for (const r of rows) {
    const k = `${r[1]}>${r[2]}`; let f = by.get(k);
    if (!f) by.set(k, f = { key: (S.est ? 'e' : '') + k, from: r[1], to: r[2], n: 0, dur: 0, dist: 0, ops: new Map(), types: new Set(), bands: new Set() }); // Routen-Cache: 500-m-Zellen getrennt
    f.n += r[6]; f.dur = r[7] == null || f.dur == null ? null : f.dur + r[7]; f.dist += r[8]; f.ops.set(r[3], (f.ops.get(r[3]) || 0) + r[6]); f.types.add(r[4]); f.bands.add(r[5]);
  }
  const flows = [...by.values()].sort((a, b) => b.n - a.n || b.dist - a.dist || a.key.localeCompare(b.key));
  S.flows = flows.slice(0, SHOW);
  const inSel = rows.reduce((s, r) => s + r[6], 0);
  const merged = sel.op !== 'all' || sel.type !== 'all' || band != null ? rowsA.filter(r => (sel.op !== 'all' && r[3] == null) || (sel.type !== 'all' && r[4] == null) || (band != null && r[5] == null)).reduce((s, r) => s + r[6], 0) : 0;
  q('sum').innerHTML = [`<span>${t('flows.tripsInSelection', { fmt: esc(ctx.fmt(flows.length)), v1: flows.length === 1 ? t('flows.flow') : t('flows.flows'), fmt2: esc(nf(S, inSel)), v3: flows.length > SHOW ? ` · ${t('flows.mapAndTableTop', { SHOW })}` : '' })}</span>`,
    `<span>${t('flows.wholeDayTripsWithStartAnd', { fmt: esc(nf(S, m.trips)), fmt2: esc(nf(S, m.shown)), fmt3: esc(nf(S, m.below || 0)), v3: m.cut ? ` · ${t('flows.outsideTop', { fmt: esc(nf(S, m.cut)), fmt2: esc(ctx.fmt(doc.top || 300)) })}` : '' })}</span>`,
    merged ? `<span>${t('flows.tripsInMergedFlowsSeveral', { fmt: esc(nf(S, merged)) })}</span>` : ''].filter(Boolean).join('');
  q('empty').hidden = true; q('bar').hidden = false;
  if (!flows.length) {
    const noStable = !S.est && sel.op !== 'all' && !stable.includes(sel.op) && !(m.ops || {})[sel.op];
    q('empty').hidden = false; q('empty').innerHTML = noStable ? `<div class="empty">${t('flows.reportsNoStableVehicleIdsIn', { op: esc(sel.op), name: esc(name(sel.ags)) })}</div>`
      : `<div class="empty">${t('flows.noFlowsForThisSelectionSet')}</div>`;
    if (S.layer) S.layer.clearLayers(); S.flows = []; q('tbody').innerHTML = ''; q('legend').innerHTML = ''; q('status').textContent = '';
    q('mapbox').hidden = true; q('tblbox').hidden = true; q('bar').hidden = true; S.queue = []; return;
  }
  ensureMap(S); applyView(S);
  // Routing-Warteschlange: Top-Ströme ohne Route im Cache, größte zuerst
  S.queue = S.flows.filter(f => f.from !== f.to && !cacheGet(f.key));
  S.fails = 0; S.offline = false;
  draw(S, true); table(S);
  if (S.queue.length && shown(S)) startPump(S);
  status(S);
}
function fillSelects(S, rowsA) {
  const { q, sel } = S, esc = S.ctx.esc;
  const ops = [...new Set(rowsA.map(r => r[3]).filter(x => x != null))].sort((a, b) => a.localeCompare(b, 'de'));
  const types = [...new Set(rowsA.map(r => r[4]).filter(x => x != null))];
  if (sel.op !== 'all' && !ops.includes(sel.op)) ops.push(sel.op);
  if (sel.type !== 'all' && !types.includes(sel.type)) types.push(sel.type);
  const order = Object.keys(TYPE), rank = (tq) => (order.includes(tq) ? order.indexOf(tq) : 99);
  q('op').innerHTML = `<option value="all">${t('flows.all')}</option>` + ops.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
  q('type').innerHTML = `<option value="all">${t('flows.all')}</option>` + types.sort((a, b) => rank(a) - rank(b)).map(tq => `<option value="${esc(tq)}">${esc(typeLabel(tq))}</option>`).join('');
  q('band').innerHTML = `<option value="all">${t('flows.wholeDay')}</option>` + (S.bands || BANDS_FALLBACK_DEF()).map((b, i) => `<option value="${i}">${esc(bandLabel({ bands: S.bands || BANDS_FALLBACK_DEF() }, i))}</option>`).join('');
  q('op').value = sel.op; q('type').value = sel.type; q('band').value = String(sel.band);
}
function empty(S, head, text, note) {
  const { q } = S;
  q('note').innerHTML = note; q('sum').textContent = '';
  q('empty').hidden = false; q('empty').innerHTML = `<div class="empty"><b>${head}</b>${text}</div>`;
  q('mapbox').hidden = true; q('tblbox').hidden = true; q('bar').hidden = true;
  fillSelects(S, []);
  q('ags-l').hidden = S.ctx.state.scope !== 'DE' || !q('ags').options.length;
  S.queue = []; S.flows = []; S.filtered = [];
  if (S.layer) S.layer.clearLayers();
  q('tbody').innerHTML = ''; q('legend').innerHTML = ''; q('status').textContent = '';
}

// ---------- Karte ----------
const colorOf = (S, f) => { const ops = [...f.ops.keys()]; return ops.length === 1 && ops[0] != null ? S.ctx.opColor(ops[0]) : NEUTRAL; };
const widthOf = (S, n) => 2 + 6 * Math.sqrt(n / Math.max(1, S.maxN));
function opsText(S, f) {
  const e = [...f.ops].sort((a, b) => b[1] - a[1]);
  if (e.length === 1) return e[0][0] == null ? t('flows.severalOperatorsLc') : e[0][0];
  return t('flows.severalOperators', { v0: e.map(([o, n]) => `${o == null ? t('flows.merged') : o} ${nf(S, n)}`).join(' · ') });
}
function tipHtml(S, f) {
  const { ctx } = S, esc = ctx.esc, r = cacheGet(f.key);
  const ty = f.types.size === 1 ? typeLabel([...f.types][0]) : t('flows.severalTypes');
  const bd = f.bands.size === 1 ? ([...f.bands][0] == null ? t('flows.timesOfDayMerged') : bandLabel(S, [...f.bands][0])) : t('flows.severalTimesOfDay');
  const route = f.from === f.to ? t('flows.startAndDestinationInSame') : r && !r.fail ? t('flows.routeCycleRouteOsrm', { v0: kmText(ctx, r.d) }) : r?.fail || S.offline ? t('flows.straightLineNoRouteFound') : t('flows.calculatingRoute');
  return `<b>${esc(plural(ctx, f.n, t('flows.trip'), t('flows.trips2')))}</b><div>${esc(opsText(S, f))} · ${esc(ty)} · ${esc(bd)}</div><div>${t('flows.avgAvgStraightLine', { durText: esc(durText(ctx, avgDur(f))), kmText: esc(kmText(ctx, f.dist / f.n)) })}</div><div>${esc(route)}</div>`;
}
function draw(S, refit = false) {
  if (!S.map) return;
  S.layer.clearLayers(); S.drawn.clear();
  const list = S.flows || [];
  S.maxN = Math.max(1, ...list.map(f => f.n));
  for (const f of [...list].reverse()) { // größte zuletzt = oben
    const col = colorOf(S, f), w = widthOf(S, f.n);
    const a = cellCenter(S, f.from), b = cellCenter(S, f.to);
    if (f.from === f.to) {
      const c = L.circleMarker(a, { radius: 5 + 7 * Math.sqrt(f.n / S.maxN), color: col, weight: 2.5, fillColor: col, fillOpacity: 0.25 }).bindTooltip(tipHtml(S, f), { sticky: true, className: 'fl-tip', direction: 'auto', offset: [14, 0] }).addTo(S.layer);
      S.drawn.set(f.key, { f, hit: c });
      continue;
    }
    const r = cacheGet(f.key), routed = r && !r.fail, coords = routed ? r.c : [a, b];
    const dash = routed ? null : '6 7';
    const casing = L.polyline(coords, { color: '#ffffff', weight: w + 3, opacity: 0.85, lineCap: 'round', lineJoin: 'round', interactive: false, dashArray: dash }).addTo(S.layer);
    const line = L.polyline(coords, { color: col, weight: w, opacity: routed ? 0.95 : 0.8, lineCap: 'round', lineJoin: 'round', interactive: false, dashArray: dash }).addTo(S.layer);
    const ends = [L.circleMarker(a, { radius: 4, color: col, weight: 2, fillColor: '#ffffff', fillOpacity: 1, interactive: false }).addTo(S.layer), L.circleMarker(b, { radius: 4, color: '#ffffff', weight: 1.5, fillColor: col, fillOpacity: 1, interactive: false }).addTo(S.layer)];
    const hit = L.polyline(coords, { color: '#000000', weight: Math.max(16, w + 12), opacity: 0, lineCap: 'round' }).bindTooltip(tipHtml(S, f), { sticky: true, className: 'fl-tip', direction: 'auto', offset: [14, 0] }).addTo(S.layer);
    hit.on('mouseover', () => { line.setStyle({ weight: w + 2 }); casing.setStyle({ weight: w + 5 }); casing.bringToFront(); line.bringToFront(); ends.forEach(e => e.bringToFront()); }); // nie hit.bringToFront(): das setzt den überfahrenen Pfad im DOM um, der Browser meldet dann kein mouseout und die Info-Box bleibt offen
    hit.on('mouseout', () => { line.setStyle({ weight: w }); casing.setStyle({ weight: w + 3 }); });
    S.drawn.set(f.key, { f, casing, line, hit, w });
  }
  legend(S);
  if (refit) { S.needFit = true; fit(S); }
}
function fit(S) {
  if (!S.map || !S.flows?.length) return;
  const el = S.q('map'); if (!el.offsetWidth) return; // verdeckt: beim Einblenden nachholen
  const pts = S.flows.flatMap(f => [cellCenter(S, f.from), cellCenter(S, f.to)]);
  S.map.fitBounds(L.latLngBounds(pts), { padding: [28, 28], maxZoom: 15, animate: !reduced() });
  S.needFit = false;
}
function onRoute(S, f) {
  const d = S.drawn.get(f.key), r = cacheGet(f.key);
  if (d?.line && r && !r.fail) { for (const p of [d.casing, d.line, d.hit]) p.setLatLngs(r.c); d.casing.setStyle({ dashArray: null }); d.line.setStyle({ dashArray: null, opacity: 0.95 }); }
  if (d?.hit) d.hit.setTooltipContent(tipHtml(S, d.f));
  const td = S.el.querySelector(`[data-fl-route="${CSS.escape(f.key)}"]`); if (td) td.textContent = routeCell(S, f);
  status(S);
}
function legend(S) {
  const { ctx } = S, esc = ctx.esc, list = S.flows || [];
  const byOp = new Map(); let multi = 0;
  for (const f of list) { const ops = [...f.ops.keys()]; if (ops.length === 1 && ops[0] != null) byOp.set(ops[0], (byOp.get(ops[0]) || 0) + f.n); else multi += f.n; }
  const items = [...byOp].sort((a, b) => b[1] - a[1]).map(([o, n]) => `<span><i class="fl-sw" style="--fl-c:${esc(ctx.opColor(o))}"></i>${esc(o)} <span class="mono">${esc(nf(S, n))}</span></span>`);
  if (multi) items.push(`<span><i class="fl-sw" style="--fl-c:${NEUTRAL}"></i>${t('flows.severalOperators2', { fmt: esc(nf(S, multi)) })}</span>`);
  const lo = Math.min(...list.map(f => f.n)), hi = S.maxN;
  items.push(`<span><i class="fl-sw" style="--fl-c:${NEUTRAL};--fl-w:2px"></i><i class="fl-sw" style="--fl-c:${NEUTRAL};--fl-w:7px"></i>${t('flows.lineWidthTrips', { fmt: esc(nf(S, lo)), fmt2: esc(nf(S, hi)) })}</span>`,
    `<span><i class="fl-pt" aria-hidden="true"></i>${t('flows.start')} · <i class="fl-pt end" aria-hidden="true"></i>${t('flows.destination')}</span>`, `<span><i class="fl-sw dash" style="--fl-c:${NEUTRAL}"></i>${t('flows.straightLineRouteMissingOr')}</span>`);
  S.q('legend').innerHTML = items.join('');
}
function status(S) {
  const el = S.q('status'); if (!el) return;
  const list = (S.flows || []).filter(f => f.from !== f.to); if (!list.length) { el.textContent = ''; return; }
  const ok = list.filter(f => { const r = cacheGet(f.key); return r && !r.fail; }).length, bad = list.filter(f => cacheGet(f.key)?.fail).length;
  const left = list.length - ok - bad;
  el.textContent = S.offline ? t('flows.routingNotReachableOfRoutes', { ok, length: list.length }) : left ? t('flows.routesOfCalculated1PerSecond', { ok, length: list.length, v2: S.pumpTok ? '' : ` · ${t('flows.paused')}` }) : t('flows.routesOf', { ok, length: list.length, v2: bad ? ` · ${t('flows.asStraightLines', { bad })}` : '' });
}

// ---------- Routing (FOSSGIS-OSRM, Fahrradprofil) ----------
let lastReq = 0;
function stopRouting(S) { S.pumpTok = null; if (S.ctrl) { S.ctrl.abort(); S.ctrl = null; } if (S.q) status(S); }
function startPump(S) { const tok = {}; S.pumpTok = tok; pump(S, tok).catch(e => console.error('Routing', e)); }
async function fetchRoute(S, f, signal) {
  const [la, lo] = cellCenter(S, f.from), [lb, lob] = cellCenter(S, f.to);
  const url = `${OSRM_BIKE}${lo.toFixed(5)},${la.toFixed(5)};${lob.toFixed(5)},${lb.toFixed(5)}?overview=simplified&geometries=geojson`;
  const r = await fetch(url, { signal, credentials: 'omit', referrerPolicy: 'strict-origin-when-cross-origin' });
  if (!r.ok) return { fail: true, http: r.status };
  const j = await r.json().catch(() => null), rt = j?.code === 'Ok' ? j.routes?.[0] : null;
  const c = rt?.geometry?.type === 'LineString' && Array.isArray(rt.geometry.coordinates) ? rt.geometry.coordinates.filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[1]) <= 90 && Math.abs(p[0]) <= 180).slice(0, 2000).map(([x, y]) => [y, x]) : [];
  if (c.length < 2 || !Number.isFinite(rt.distance)) return { fail: true };
  return { d: rt.distance, s: Number.isFinite(rt.duration) ? rt.duration : null, c };
}
async function pump(S, tok) {
  while (S.pumpTok === tok && S.queue.length) {
    if (!shown(S)) { stopRouting(S); break; } // verdeckt: anhalten, Sichtbarkeit setzt fort
    const wait = lastReq + REQ_GAP_MS - Date.now(); if (wait > 0) { await sleep(wait); continue; }
    const f = S.queue[0];
    if (cacheGet(f.key)) { S.queue.shift(); onRoute(S, f); continue; }
    lastReq = Date.now();
    const ctrl = new AbortController(); S.ctrl = ctrl; let timedOut = false;
    const tm = setTimeout(() => { timedOut = true; ctrl.abort(); }, REQ_TIMEOUT_MS);
    let res;
    try { res = await fetchRoute(S, f, ctrl.signal); } catch { res = S.pumpTok === tok || timedOut ? { fail: true } : null; } // Netzfehler/Zeitüberschreitung = Luftlinie; von uns abgebrochen = null
    clearTimeout(tm); if (S.ctrl === ctrl) S.ctrl = null;
    if (S.pumpTok !== tok || !res) break; // abgebrochen (Auswahl/Ansicht gewechselt): Strom bleibt in der Warteschlange
    S.queue.shift();
    if (res.fail) { MEM.set(f.key, { fail: true }); S.fails++; } else { cachePut(f.key, res); S.fails = 0; }
    if (res.http === 429 || S.fails >= 3) { S.offline = true; S.queue = []; } // Dienst überlastet oder nicht erreichbar: Rest bleibt Luftlinie
    onRoute(S, f);
    if (S.offline) for (const d of S.drawn.values()) d.hit?.setTooltipContent(tipHtml(S, d.f));
  }
  if (S.pumpTok === tok && !S.queue.length) S.pumpTok = null;
  status(S);
}
// Tab im Hintergrund: anhalten; zurück: fortsetzen. Farbschema gewechselt: Linienfarben neu (Anbieterfarben je Schema).
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { for (const S of ACTIVE) { if (!S.el.isConnected) { ACTIVE.delete(S); continue; } if (document.visibilityState === 'hidden') stopRouting(S); else if (S.queue.length && !S.pumpTok && shown(S)) startPump(S); } });
  const recolor = () => { for (const S of ACTIVE) if (S.el.isConnected && S.flows?.length) { draw(S); table(S); } };
  try { new MutationObserver(recolor).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] }); } catch { /* alt */ }
  try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', recolor); } catch { /* alt */ }
}

// ---------- Tabelle und CSV ----------
const coordText = (S, cell) => { const [a, b] = cellCenter(S, cell); return `${S.ctx.fmt(a, 4)}, ${S.ctx.fmt(b, 4)}`; };
function routeCell(S, f) { if (f.from === f.to) return t('flows.sameCell'); const r = cacheGet(f.key); return r && !r.fail ? kmText(S.ctx, r.d) : r?.fail || S.offline ? t('flows.straightLine') : '…'; }
function table(S) {
  const { ctx } = S, esc = ctx.esc;
  S.q('tbody').innerHTML = (S.flows || []).map((f, i) => {
    const ops = [...f.ops.keys()], one = ops.length === 1 && ops[0] != null;
    const opCell = one ? `<span class="op"><i style="background:${esc(ctx.opColor(ops[0]))}"></i>${esc(ops[0])}</span>` : `<span class="op"><i style="background:${NEUTRAL}"></i>${t('flows.several')}</span><div class="sub-line">${esc(opsText(S, f).replace(new RegExp(`^${t('flows.severalOperators', { v0: '' }).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').trim()} ?`), ''))}</div>`;
    return `<tr><td class="n">${i + 1}</td><td><span class="fl-cell" title="${t('flows.cell', { from: esc(f.from) })}">${esc(coordText(S, f.from))}</span></td><td><span class="fl-cell" title="${t('flows.cell2', { to: esc(f.to) })}">${esc(coordText(S, f.to))}</span></td><td>${opCell}</td><td class="n">${esc(nf(S, f.n))}</td><td class="n">${esc(durText(ctx, avgDur(f)))}</td><td class="n">${esc(kmText(ctx, f.dist / f.n))}</td><td class="n" data-fl-route="${esc(f.key)}">${esc(routeCell(S, f))}</td></tr>`;
  }).join('');
}
function exportCsv(S) {
  const { ctx, sel } = S; if (!S.filtered?.length) return;
  const head = [t('flows.day'), t('flows.municipalityKey'), t('flows.municipality'), t('flows.startCell'), t('flows.startLatitude'), t('flows.startLongitude'), t('flows.destinationCell'), t('flows.destinationLatitude'), t('flows.destinationLongitude'), t('flows.operator'), t('flows.vehicleType'), t('flows.timeOfDay'), t('flows.trips'), t('flows.avgDurationMin'), t('flows.avgStraightLineKm'), t('flows.bikeRouteKmOsrmNotMeasured')];
  const rows = [...S.filtered].sort((a, b) => b[6] - a[6]).map(r => {
    const [a1, o1] = cellCenter(S, r[1]), [a2, o2] = cellCenter(S, r[2]), rt = r[1] !== r[2] ? cacheGet(`${S.est ? 'e' : ''}${r[1]}>${r[2]}`) : null;
    return [S.doc.day || sel.day, r[0], ctx.muniName(r[0]), r[1], [a1, 5], [o1, 5], r[2], [a2, 5], [o2, 5], r[3] ?? t('flows.merged'), r[4] == null ? t('flows.merged') : typeLabel(r[4]), r[5] == null ? t('flows.merged') : bandLabel(S, r[5]), r[6], r[7] == null ? null : [r[7] / r[6] / 60, 1], [r[8] / r[6] / 1000, 2], rt && !rt.fail ? [rt.d / 1000, 2] : null];
  });
  download(`${t('file.flows')}_${String(sel.ags).replace(/[^\w-]/g, '')}_${String(S.doc.day || sel.day).replace(/[^\d-]/g, '')}.csv`, toCsv([head, ...rows]));
}
