// Mobility Pulse — Anbieter-Vergleich (Marktbild › Vergleich): Kennzahlen je Anbieter nebeneinander, Stationen/Spots und belegte Zellen
// einzigartig gegen geteilt, Überschneidung der Zellen, Karte mit Filter, Stationsliste mit CSV.
// Eigenständig: renderCompare(el, ctx), ctx = { state, CFG, esc, fmt, getJson, opColor, muniName, setScope }; Leaflet (L) global.
// Daten: ops/<Land>.json (letzter Sammler-Lauf), Rechenlogik in lib/pulse-compare.js. Werte aus Daten gehen durch ctx.esc.
import * as P from './pulse-compare.js?v=mw5h654v';
import { decodeFleet, idleClassText } from './pulse-ops.js?v=mw5h654v';
import { VEHICLE_TYPE_LABEL } from './pulse-core.js?v=mw5h654v';
import { t, tMap, lang, dateFmt, decimalSep } from './i18n.js?v=mw5h654v';
import { mapKeys } from './mapkeys.js?v=mw5h654v';

const TYPE = tMap('type', VEHICLE_TYPE_LABEL);
const CACHE = new Map();
const S = new WeakMap();
// grp: sichtbare Spaltengruppe der Kennzahlen (fleet | stations | area | all); alle 16 Spalten passen auch bei 1440 px nicht in das Panel
const st = (el) => { let s = S.get(el); if (!s) { s = { tok: 0, type: 'all', radius: P.DEFAULT_RADIUS, hide: new Set(), mode: 'stations', show: 'all', grp: 'fleet', sort: { key: 'vehicles', dir: 'desc' }, ssort: { key: 'operator', dir: 'asc' }, limit: 100 }; S.set(el, s); } return s; };
/** Zwischenspeicher leeren (neuer Sammler-Lauf) */
export function resetCompareCache() { CACHE.clear(); }

const STYLE = `
.rp-sort{all:unset;cursor:pointer;display:inline-flex;gap:4px;align-items:center;font:inherit;letter-spacing:inherit;text-transform:inherit;color:inherit;border-radius:4px}
.rp-sort:hover,.rp-sort.on{color:var(--fg)}.rp-sort:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.rp-sort span{font-size:9px;min-width:8px}
.rp-status{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:500;color:var(--fg);white-space:nowrap}
.rp-status i{display:inline-grid;place-items:center;width:16px;height:16px;border-radius:50%;font:700 10px/1 var(--sans);font-style:normal;color:var(--panel);background:var(--muted);flex:none}
.rp-status.ok i{background:var(--ok)}.rp-status.none i{background:transparent;color:var(--fg-2);box-shadow:inset 0 0 0 1.5px var(--fg-2)}
.rp-ctl{display:flex;flex-wrap:wrap;gap:var(--s2) var(--s3);align-items:center}
.cmp-mx tbody th{text-transform:none;letter-spacing:0;font-size:inherit;font-weight:500;color:var(--fg);text-align:left}
.cmp-ctl{display:flex;flex-wrap:wrap;gap:var(--s2) var(--s3);align-items:center;margin:var(--s2) 0 var(--s3)}
.cmp-ctl label{display:inline-flex;gap:6px;align-items:center;font-size:12.5px;color:var(--fg-2)}
.cmp-chips{display:flex;flex-wrap:wrap;gap:6px}
.cmp-chips .chip i{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--c)}
.cmp-chips .chip[aria-pressed="false"]{color:var(--fg-2);border-style:dashed;text-decoration:line-through}.cmp-chips .chip[aria-pressed="false"] i{background:transparent;box-shadow:inset 0 0 0 1.5px var(--c)}
.cmp-tog{display:inline-flex;gap:2px;padding:3px;border-radius:10px;background:var(--bg-2);border:1px solid var(--line)}
.cmp-tog button{min-height:26px;border:0;background:transparent;color:var(--fg-2);padding:0 12px;border-radius:7px}
.cmp-tog button[aria-pressed="true"]{background:var(--thumb,var(--panel));color:var(--fg);box-shadow:inset 0 0 0 1px var(--line-2)}
.cmp-map{height:480px;border-radius:var(--r-sm);border:1px solid var(--line);background:var(--bg-2);isolation:isolate}
.cmp-legend{display:flex;flex-wrap:wrap;gap:var(--s1) var(--s4);align-items:center;font-size:12px;color:var(--fg-2);margin-top:var(--s2)}
.cmp-legend i{display:inline-block;width:11px;height:11px;border-radius:50%;margin-right:5px;vertical-align:-1px;border:2px solid var(--fg-2)}
.cmp-legend i.fill{background:var(--fg-2)}.cmp-legend .cmp-op i{border:0;width:9px;height:9px;margin:0;background:var(--c)}
.cmp-legend button.cmp-hl{all:unset;cursor:pointer;border-radius:4px;padding:0 2px}.cmp-legend button.cmp-hl:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.cmp-legend button.cmp-hl[aria-pressed="true"] .cmp-op{text-decoration:underline;text-underline-offset:3px}
.panel .cmp-h3{font-size:14px;font-weight:600;margin:var(--s5) 0 var(--s2)}
.cmp-kpi[data-grp="fleet"] :is(.g-st,.g-area),.cmp-kpi[data-grp="stations"] :is(.g-fleet,.g-area),.cmp-kpi[data-grp="area"] :is(.g-fleet,.g-st),.cmp-kpi:not([data-grp="all"]) .cmp-grp{display:none}
@media print{.cmp-kpi :is(.g-fleet,.g-st,.g-area){display:table-cell!important}.cmp-kpi .cmp-grp{display:table-row!important}}
.cmp-op{display:inline-flex;align-items:center;gap:6px;font-weight:500;white-space:nowrap}.cmp-op i{width:9px;height:9px;border-radius:50%;background:var(--c);flex:none}
.cmp-mx td.v{text-align:right;font-variant-numeric:tabular-nums;background:color-mix(in srgb,var(--accent) var(--a),transparent)}
.cmp-mx td.self{color:var(--muted);text-align:center}
.cmp-root tr.cmp-sum td{font-weight:600}
.cmp-grp th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);border-bottom:0}
.leaflet-tooltip.cmp-tip{background:var(--panel);color:var(--fg-2);border:1px solid var(--line-2);border-radius:var(--r-sm);box-shadow:var(--shadow);padding:6px 10px;font:12px/1.45 var(--sans);max-width:min(300px,70vw);white-space:normal}
.leaflet-tooltip.cmp-tip b{color:var(--fg)}
@media (max-width:720px){.cmp-map{height:360px}}
`;
let cssDone = false;
const css = () => { if (cssDone || typeof document === 'undefined') return; cssDone = true; const s = document.createElement('style'); s.textContent = STYLE; document.head.appendChild(s); };
const stamp = (ms) => (ms ? dateFmt({ dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Berlin' }).format(new Date(ms)) : '–');
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// ops/<Land>.json und stations-quota.json ohne Anhang laden: dann teilt ctx.getJson den Download mit Karte und Disposition (gleicher Cache, je Lauf neu)
function load(ctx, land) {
  const key = `${ctx.state?.latest?.at || ''}|${land}`;
  if (!CACHE.has(key)) CACHE.set(key, Promise.resolve(ctx.getJson(`${ctx.CFG.DATA}ops/${land}.json`, { timeout: 90000 })).then((r) => (r?.ok && r.json ? decodeFleet(r.json) : null), () => null));
  return CACHE.get(key);
}
function loadQuota(ctx) {
  const key = `${ctx.state?.latest?.at || ''}|quota`;
  if (!CACHE.has(key)) CACHE.set(key, Promise.resolve(ctx.getJson(`${ctx.CFG.DATA}stations-quota.json`, { timeout: 60000 })).then((r) => (r?.ok && r.json?.stations ? r.json : null), () => null));
  return CACHE.get(key);
}
/** Text für „weitere Zeilen“: bis 100 alle auf einmal, sonst 100 und der Rest */
const moreText = (rest, fmt) => (rest <= 100 ? t('common.showAllMore', { n: fmt(rest) }) : t('common.show100More', { n: fmt(rest - 100) }));
/** Leaflet-Bedienelemente in der Sprache der Seite */
function langControls(map) {
  L.control.zoom({ zoomInTitle: t('common.zoomIn'), zoomOutTitle: t('common.zoomOut') }).addTo(map);
  map.attributionControl?.setPrefix(`<a href="https://leafletjs.com" title="${t('common.leafletTitle')}" lang="en">Leaflet</a>`);
}

// ---------- Bausteine ----------
const pct = (ctx, x) => (x == null ? '–' : `${ctx.fmt(x * 100)} %`);
const num = (ctx, x, d = 0) => (x == null ? '–' : ctx.fmt(x, d));
// Standzeit liegt nur als Klasse vor (ops/<Land>.json, lib/pulse-ops.js idleClassMin): Median als Klasse
const hours = (ctx, min) => (min == null ? '–' : idleClassText(min, { en: lang() === 'en' }));
const opCell = (ctx, op) => `<span class="cmp-op" style="--c:${ctx.esc(ctx.opColor(op))}"><i></i>${ctx.esc(op)}</span>`;
function sortHead(cols, sort, attr) {
  return cols.map(([k, l, n, title, g = '']) => { if (!k) return `<th${n ? ' class="n"' : ''}>${l}</th>`; const on = sort.key === k; return `<th class="${[n ? 'n' : '', g].filter(Boolean).join(' ')}" aria-sort="${on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}"><button type="button" class="rp-sort${on ? ' on' : ''}" data-${attr}="${k}"${title ? ` title="${title}"` : ''}>${l}<span aria-hidden="true">${on ? (sort.dir === 'asc' ? '▲' : '▼') : ''}</span></button></th>`; }).join('');
}
const cmpBy = (key, dir) => (a, b) => { const x = a[key], y = b[key]; const r = typeof x === 'string' || typeof y === 'string' ? String(x ?? '').localeCompare(String(y ?? ''), 'de') : (x ?? -Infinity) - (y ?? -Infinity); return dir === 'asc' ? r : -r; };

function kpiTable(ctx, res, s) {
  const rows = res.rows.filter(r => !s.hide.has(r.op)).map(r => ({ ...r, disabledShare: r.vehicles ? r.disabled / r.vehicles : null, share: res.total.vehicles ? r.vehicles / res.total.vehicles : null, uniqueCellShare: r.cells ? r.uniqueCells / r.cells : null }));
  rows.sort(cmpBy(s.sort.key, s.sort.dir));
  // Spalte 5: Gruppe (g-fleet, g-st, g-area); Anbieter und Bestand stehen immer
  const cols = [['op', t('cmp.operator')], ['vehicles', t('cmp.vehicles'), true], ['share', t('cmp.share'), true, t('cmp.shareTip'), 'g-fleet'], ['available', t('cmp.available'), true, '', 'g-fleet'], ['disabledShare', t('cmp.disabled'), true, '', 'g-fleet'],
    ['lowEnergy', t('cmp.lowEnergy'), true, t('cmp.lowEnergyTip'), 'g-fleet'], ['idleMedian', t('cmp.idle'), true, t('cmp.idleTip'), 'g-fleet'],
    ['stations', t('cmp.stations'), true, t('cmp.stationsTip'), 'g-st'], ['emptyStations', t('cmp.empty'), true, '', 'g-st'], ['uniqueStations', t('cmp.uniqueSt'), true, t('cmp.uniqueStTip', { r: s.radius }), 'g-st'], ['sharedStations', t('cmp.sharedSt'), true, '', 'g-st'],
    ['cells', t('cmp.cells'), true, t('cmp.cellsTip'), 'g-area'], ['uniqueCellShare', t('cmp.uniqueCells'), true, t('cmp.uniqueCellsTip'), 'g-area'], ['areaKm2', t('cmp.area'), true, '', 'g-area'], ['density', t('cmp.density'), true, t('cmp.densityTip'), 'g-area'], ['nearOther', t('cmp.nearOther'), true, t('cmp.nearOtherTip', { r: s.radius }), 'g-area']];
  const c = (g, v) => `<td class="n ${g}">${v}</td>`;
  const body = rows.map(r => `<tr><td>${opCell(ctx, r.op)}<div class="sub-line">${ctx.esc(Object.entries(r.types).sort((a, b) => b[1] - a[1]).map(([ty, n]) => `${TYPE[ty] || ty} ${ctx.fmt(n)}`).join(' · '))}</div></td>
    <td class="n">${num(ctx, r.vehicles)}</td>${c('g-fleet', pct(ctx, r.share))}${c('g-fleet', num(ctx, r.available))}${c('g-fleet', pct(ctx, r.disabledShare))}${c('g-fleet', pct(ctx, r.lowEnergy))}${c('g-fleet', hours(ctx, r.idleMedian))}
    ${c('g-st', `${num(ctx, r.stations)}${r.stations ? `<div class="sub-line">${t('cmp.physVirt', { p: ctx.fmt(r.physical), v: ctx.fmt(r.virtual) })}</div>` : ''}`)}${c('g-st', r.stations ? num(ctx, r.emptyStations) : '–')}${c('g-st', r.stations ? num(ctx, r.uniqueStations) : '–')}${c('g-st', r.stations ? num(ctx, r.sharedStations) : '–')}
    ${c('g-area', num(ctx, r.cells))}${c('g-area', `${pct(ctx, r.uniqueCellShare)}<div class="sub-line">${t('cmp.ofCells', { n: ctx.fmt(r.uniqueCells) })}</div>`)}${c('g-area', num(ctx, r.areaKm2, 1))}${c('g-area', num(ctx, r.density))}${c('g-area', pct(ctx, r.nearOther))}</tr>`).join('');
  const T = res.total, e = (g, n = 1) => Array.from({ length: n }, () => `<td class="${g}"></td>`).join('');
  const sum = `<tr class="cmp-sum"><td>${t('cmp.all')}</td><td class="n">${num(ctx, T.vehicles)}</td>${c('g-fleet', '100 %')}${e('g-fleet', 4)}${c('g-st', num(ctx, T.stations))}${e('g-st', 3)}${c('g-area', num(ctx, T.cells))}${e('g-area')}${c('g-area', num(ctx, T.areaKm2, 1))}${e('g-area', 2)}</tr>`;
  const grp = `<tr class="cmp-grp"><td></td><td></td><th colspan="5">${t('cmp.grpFleet')}</th><th colspan="4">${t('cmp.grpStations')}</th><th colspan="5">${t('cmp.grpArea')}</th></tr>`;
  const tog = `<div class="cmp-ctl rp-noprint"><div class="cmp-tog" role="group" aria-label="${t('cmp.colGroup')}">${[['fleet', t('cmp.grpFleet')], ['stations', t('cmp.grpStations')], ['area', t('cmp.grpArea')], ['all', t('cmp.grpAll')]].map(([k, l]) => `<button type="button" data-cmp-grp="${k}" aria-pressed="${s.grp === k}">${l}</button>`).join('')}</div></div>`;
  return `${tog}<div class="tbl cmp-kpi" data-grp="${s.grp}" tabindex="0" role="region" aria-label="${t('cmp.kpiAria')}"><table><thead>${grp}<tr>${sortHead(cols, s.sort, 'cmp-sort')}</tr></thead><tbody>${body}${sum}</tbody></table></div>`;
}
function overlapTable(ctx, res, s) {
  const ops = res.rows.filter(r => !s.hide.has(r.op) && r.cells).map(r => r.op);
  if (ops.length < 2) return '';
  const head = `<tr><th>${t('cmp.mxRowsCols')}</th>${ops.map(o => `<th class="n">${opCell(ctx, o)}</th>`).join('')}</tr>`;
  const body = ops.map(a => `<tr><th scope="row">${opCell(ctx, a)}</th>${ops.map(b => { if (a === b) return '<td class="self">—</td>'; const v = res.overlap[a]?.[b]; return v == null ? '<td class="v">–</td>' : `<td class="v" style="--a:${Math.round(v * 45)}%" title="${ctx.esc(t('cmp.mxTip', { a, b, v: ctx.fmt(v * 100) }))}">${ctx.fmt(v * 100)} %</td>`; }).join('')}</tr>`).join('');
  return `<h3 class="cmp-h3">${t('cmp.mxTitle')}</h3><p class="muted small" style="margin:0 0 var(--s2)">${t('cmp.mxSub')}</p><div class="tbl cmp-mx" tabindex="0" role="region" aria-label="${ctx.esc(t('cmp.mxTitle'))}"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}
function stationRows(res, s) {
  return res.stations.filter(x => !s.hide.has(x.operator) && (s.show === 'all' || (s.show === 'unique' ? x.unique : !x.unique)));
}
function stationTable(ctx, res, s) {
  const list = stationRows(res, s).map(x => ({ ...x, other: x.nearestOther?.operator || '', d: x.nearestOther?.d ?? null, kind: x.virtual ? 0 : 1 }));
  list.sort(cmpBy(s.ssort.key, s.ssort.dir));
  const cols = [['name', t('cmp.station')], ['operator', t('cmp.operator')], ['kind', t('cmp.kind')], ['bookable', t('cmp.bookable'), true], ['capacity', t('cmp.capacity'), true], ['unique', t('cmp.status')], ['other', t('cmp.nearestOther')], ['d', t('cmp.distance'), true]];
  const body = list.slice(0, s.limit).map(x => `<tr><td translate="no">${ctx.esc(x.name || '–')}</td><td>${opCell(ctx, x.operator)}</td><td>${x.virtual ? t('cmp.virtual') : t('cmp.physical')}</td><td class="n">${num(ctx, x.bookable)}</td><td class="n">${num(ctx, x.capacity)}</td>
    <td>${x.unique ? `<span class="rp-status ok"><i aria-hidden="true">●</i>${t('cmp.unique')}</span>` : `<span class="rp-status none"><i aria-hidden="true">○</i>${t('cmp.shared')}</span>`}</td><td>${x.other ? opCell(ctx, x.other) : '–'}</td><td class="n">${x.d == null ? '–' : `${ctx.fmt(x.d)} m`}</td></tr>`).join('');
  const more = list.length > s.limit ? `<div class="rp-ctl rp-noprint" style="margin-top:var(--s2)"><button type="button" data-cmp-act="more">${moreText(list.length - s.limit, ctx.fmt)}</button></div>` : '';
  return `<h3 class="cmp-h3">${t('cmp.stTitle', { n: ctx.fmt(list.length) })}</h3>${list.length ? `<div class="tbl" tabindex="0" role="region" aria-label="${t('cmp.stTitle', { n: list.length })}"><table><thead><tr>${sortHead(cols, s.ssort, 'cmp-ssort')}</tr></thead><tbody>${body}</tbody></table></div>${more}` : `<div class="empty">${t('cmp.noStations')}</div>`}`;
}
function controls(ctx, res, s, types) {
  const esc = ctx.esc, opt = (v, l, cur) => `<option value="${esc(v)}"${String(v) === String(cur) ? ' selected' : ''}>${esc(l)}</option>`;
  const chips = res.rows.map(r => `<button type="button" class="chip" data-cmp-op="${esc(r.op)}" aria-pressed="${!s.hide.has(r.op)}" style="--c:${esc(ctx.opColor(r.op))}"><i></i>${esc(r.op)}</button>`).join('');
  return `<div class="cmp-ctl rp-noprint"><label>${t('cmp.type')} <select data-cmp="type">${opt('all', t('cmp.allTypes'), s.type)}${types.map(ty => opt(ty, TYPE[ty] || ty, s.type)).join('')}</select></label>
    <label>${t('cmp.radius')} <select data-cmp="radius">${P.RADII.map(r => opt(r, `${r} m`, s.radius)).join('')}</select></label>
    <div class="cmp-chips" role="group" aria-label="${t('cmp.operators')}">${chips}</div></div>`;
}
function mapTools(s) {
  return `<h3 class="cmp-h3">${t('cmp.mapTitle')}</h3><div class="cmp-ctl rp-noprint">
    <div class="cmp-tog" role="group" aria-label="${t('cmp.layer')}"><button type="button" data-cmp-mode="stations" aria-pressed="${s.mode === 'stations'}">${t('cmp.stationsLayer')}</button><button type="button" data-cmp-mode="vehicles" aria-pressed="${s.mode === 'vehicles'}">${t('cmp.vehiclesLayer')}</button></div>
    <div class="cmp-tog" role="group" aria-label="${t('cmp.filter')}"><button type="button" data-cmp-show="all" aria-pressed="${s.show === 'all'}">${t('cmp.showAll')}</button><button type="button" data-cmp-show="unique" aria-pressed="${s.show === 'unique'}">${t('cmp.showUnique')}</button><button type="button" data-cmp-show="shared" aria-pressed="${s.show === 'shared'}">${t('cmp.showShared')}</button></div>
    <button type="button" data-cmp-act="csv">↓ CSV</button></div>`;
}

// ---------- Karte ----------
function drawMap(el, ctx, res, s) {
  const box = el.querySelector('[data-cmp-map]');
  if (!box || typeof L === 'undefined') return;
  if (!s.map || s.map.getContainer() !== box) {
    s.map?.remove();
    const still = reduced();
    s.map = L.map(box, { zoomControl: false, zoomAnimation: !still, fadeAnimation: !still, markerZoomAnimation: !still, preferCanvas: true });
    langControls(s.map);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: t('app.openstreetmapContributors') }).addTo(s.map);
    s.layer = L.layerGroup().addTo(s.map); s.fitKey = null;
    mapKeys(s.map); // Tastatur: N/P durch die Stationen im Ausschnitt (web/mapkeys.js)
  }
  s.layer.clearLayers();
  const renderer = L.canvas({ padding: 0.3 });
  const pts = [];
  const esc = ctx.esc;
  if (s.mode === 'stations') {
    for (const x of stationRows(res, s)) {
      const c = ctx.opColor(x.operator), dim = s.focus && s.focus !== x.operator;
      const tip = `<b translate="no">${esc(x.name || t('cmp.station'))}</b><div>${esc(x.operator)} · ${x.virtual ? t('cmp.virtual') : t('cmp.physical')} · ${t('cmp.bookableN', { n: ctx.fmt(x.bookable ?? 0) })}</div><div>${x.unique ? t('cmp.uniqueTip', { r: s.radius }) : t('cmp.sharedTip', { op: esc(x.nearestOther.operator), d: ctx.fmt(x.nearestOther.d) })}</div>`;
      L.circleMarker([x.lat, x.lon], { renderer, radius: x.unique ? 6 : 5, color: c, weight: 2.5, opacity: dim ? 0.2 : 1, fillColor: x.unique ? c : '#ffffff', fillOpacity: dim ? 0.1 : x.unique ? 0.9 : 1 }).bindTooltip(tip, { className: 'cmp-tip', sticky: true }).addTo(s.layer);
      pts.push([x.lat, x.lon]);
    }
  } else {
    for (const v of res.vehicles) {
      if (s.hide.has(v.operator)) continue;
      L.circleMarker([v.lat, v.lon], { renderer, radius: 2.5, color: ctx.opColor(v.operator), weight: 0, fillColor: ctx.opColor(v.operator), fillOpacity: s.focus && s.focus !== v.operator ? 0.12 : 0.8, interactive: false }).addTo(s.layer);
      pts.push([v.lat, v.lon]);
    }
  }
  const key = `${res.ags}|${s.mode}`;
  if (pts.length && s.fitKey !== key) { s.map.fitBounds(L.latLngBounds(pts), { padding: [24, 24], maxZoom: 15, animate: false }); s.fitKey = key; }
  setTimeout(() => s.map?.invalidateSize(), 0);
  const ops = res.rows.filter(r => !s.hide.has(r.op) && (s.mode === 'vehicles' ? r.vehicles : r.stations));
  // Legende: Klick hebt einen Anbieter hervor und blendet die übrigen ab (zweite Kodierung neben der Farbe)
  if (s.focus && !ops.some(r => r.op === s.focus)) s.focus = null;
  el.querySelector('[data-cmp-legend]').innerHTML = ops.map(r => `<button type="button" class="cmp-hl" data-cmp-hl="${ctx.esc(r.op)}" aria-pressed="${s.focus === r.op}" title="${ctx.esc(t('cmp.highlightTip', { op: r.op }))}">${opCell(ctx, r.op)}</button>`).join('')
    + (s.mode === 'stations' ? `<span><i class="fill"></i>${t('cmp.legendUnique', { r: s.radius })}</span><span><i></i>${t('cmp.legendShared')}</span>` : `<span>${t('cmp.legendVehicles')}</span>`);
}

function download(name, text) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' })); a.download = name; a.style.display = 'none';
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
function csv(res, s) {
  const sep = decimalSep() === ',' ? ';' : ',';
  const rows = P.stationCsvRows(stationRows(res, s), { lang: lang(), labels: { name: t('cmp.station'), operator: t('cmp.operator'), lat: t('cmp.lat'), lon: t('cmp.lon'), kind: t('cmp.kind'), bookable: t('cmp.bookable'), capacity: t('cmp.capacity'), unique: t('cmp.unique'), other: t('cmp.nearestOther'), d: t('cmp.distanceM'), yes: t('cmp.yes'), no: t('cmp.no'), phys: t('cmp.physical'), virt: t('cmp.virtual') } });
  return rows.map(r => r.map(c => { let x = String(c ?? ''); if (/^[=+\-@\t\r]/.test(x)) x = `'${x}`; return /[";,\n\r]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; }).join(sep)).join('\r\n');
}

// ---------- Ansicht ----------
function pickMunicipality(el, ctx) {
  const m = Object.values(ctx.state.latest?.municipalities || {}).map(x => ({ ...x, n: Object.keys(x.operators || {}).length, v: Object.values(x.operators || {}).reduce((s, o) => s + (o.total || 0), 0) }))
    .filter(x => x.n >= 2).sort((a, b) => b.v - a.v).slice(0, 24);
  el.innerHTML = `<div class="panel-head"><div><h2>${t('cmp.title')}</h2><div class="sub">${t('cmp.pickSub')}</div></div></div><div class="cmp-chips">${m.map(x => `<button type="button" class="chip" data-ags="${ctx.esc(x.ags)}">${ctx.esc(x.name)} <span class="muted">${ctx.esc(ctx.fmt(x.n))} · ${ctx.esc(ctx.fmt(x.v))}</span></button>`).join('')}</div>`;
}
function draw(el, ctx, s) {
  const { fleet, ags } = s;
  const res = s.res = P.compareOperators(fleet, { ags, type: s.type, radiusM: s.radius, quota: s.quota });
  const types = [...new Set(fleet.vehicles.filter(v => v.ags === ags).map(v => v.type))].sort();
  const name = ctx.muniName?.(ags) || ags;
  if (!res.rows.length) { el.innerHTML = `<div class="panel-head"><div><h2>${t('cmp.title')} · ${ctx.esc(name)}</h2></div></div>${controls(ctx, res, s, types)}<div class="empty">${t('cmp.none')}</div>`; return; }
  const top = `<div class="panel-head"><div><h2>${t('cmp.title')} · ${ctx.esc(name)}</h2><div class="sub">${t('cmp.sub', { at: stamp(fleet.at) })}</div></div></div>${controls(ctx, res, s, types)}${kpiTable(ctx, res, s)}
    <p class="muted small" style="margin:var(--s2) 0 0">${t('cmp.note', { r: s.radius, km2: ctx.fmt(res.cellKm2, 3) })}</p>${overlapTable(ctx, res, s)}`;
  if (!el.querySelector('[data-cmp-map]')) {
    s.map?.remove(); s.map = null;
    el.innerHTML = `<div data-cmp-top></div><div data-cmp-tools></div><div class="cmp-map" data-cmp-map role="region" aria-label="${t('cmp.mapAria')}"></div><div class="cmp-legend" data-cmp-legend></div><div data-cmp-st></div>`;
  }
  el.querySelector('[data-cmp-top]').innerHTML = top;
  el.querySelector('[data-cmp-tools]').innerHTML = mapTools(s);
  el.querySelector('[data-cmp-st]').innerHTML = stationTable(ctx, res, s);
  drawMap(el, ctx, res, s);
}

/** Panel zeichnen (Ansicht „Vergleich“); braucht eine Gemeinde oben im Gebiet */
export async function renderCompare(el, ctx) {
  if (!el) return;
  css(); el.classList.add('cmp-root');
  const s = st(el); s.ctx = ctx; const tok = ++s.tok;
  const ags = ctx.state.scope && ctx.state.scope !== 'DE' ? ctx.state.scope : null;
  if (!s.bound) {
    s.bound = true;
    el.addEventListener('change', (e) => { const k = e.target.dataset?.cmp; if (!k || !s.fleet) return; s[k] = k === 'radius' ? +e.target.value : e.target.value; s.limit = 100; draw(el, s.ctx, s); });
    el.addEventListener('click', (e) => {
      const ch = e.target.closest('button[data-ags]'); if (ch && !s.fleet) { s.ctx.setScope?.(ch.dataset.ags); return; }
      if (!s.fleet) return;
      const so = e.target.closest('button[data-cmp-sort]'), ss = e.target.closest('button[data-cmp-ssort]');
      if (so || ss) { const which = so ? 'sort' : 'ssort', k = (so || ss).dataset[so ? 'cmpSort' : 'cmpSsort']; s[which] = s[which].key === k ? { key: k, dir: s[which].dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: ['op', 'name', 'operator', 'other', 'kind'].includes(k) ? 'asc' : 'desc' }; draw(el, s.ctx, s); el.querySelector(`button[data-cmp-${so ? 'sort' : 'ssort'}="${k}"]`)?.focus(); return; }
      const op = e.target.closest('button[data-cmp-op]'); if (op) { const o = op.dataset.cmpOp; if (s.hide.has(o)) s.hide.delete(o); else s.hide.add(o); draw(el, s.ctx, s); el.querySelector(`button[data-cmp-op="${CSS.escape(o)}"]`)?.focus(); return; }
      const gr = e.target.closest('button[data-cmp-grp]'); if (gr) { s.grp = gr.dataset.cmpGrp; const k = el.querySelector('.cmp-kpi'); if (k) k.dataset.grp = s.grp; for (const b of el.querySelectorAll('button[data-cmp-grp]')) b.setAttribute('aria-pressed', String(b.dataset.cmpGrp === s.grp)); return; }
      const hl = e.target.closest('button[data-cmp-hl]'); if (hl) { const o = hl.dataset.cmpHl; s.focus = s.focus === o ? null : o; drawMap(el, s.ctx, s.res, s); el.querySelector(`button[data-cmp-hl="${CSS.escape(o)}"]`)?.focus(); return; }
      const md = e.target.closest('button[data-cmp-mode]'); if (md) { s.mode = md.dataset.cmpMode; draw(el, s.ctx, s); el.querySelector(`button[data-cmp-mode="${s.mode}"]`)?.focus(); return; }
      const sh = e.target.closest('button[data-cmp-show]'); if (sh) { s.show = sh.dataset.cmpShow; s.limit = 100; draw(el, s.ctx, s); el.querySelector(`button[data-cmp-show="${s.show}"]`)?.focus(); return; }
      const a = e.target.closest('button[data-cmp-act]');
      // weitere Zeilen: bis 100 Rest alle auf einmal; Fokus auf die erste neue Zeile, damit die Tastatur nicht oben neu beginnt
      if (a?.dataset.cmpAct === 'more') { const n = s.limit; s.limit = stationRows(s.res, s).length - n <= 100 ? Infinity : n + 100; draw(el, s.ctx, s); const td = el.querySelectorAll('[data-cmp-st] tbody tr')[n]?.querySelector('td'); if (td) { td.tabIndex = -1; td.focus(); } }
      if (a?.dataset.cmpAct === 'csv') download(`${t('cmp.file')}_${s.ags}_${new Date(s.fleet.at || Date.now()).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`, csv(s.res, s));
    });
  }
  if (!ags) { s.fleet = null; s.map?.remove(); s.map = null; pickMunicipality(el, ctx); return; }
  const land = ctx.state.latest?.municipalities?.[ags]?.state;
  if (!land) { s.fleet = null; el.innerHTML = `<div class="panel-head"><div><h2>${t('cmp.title')}</h2></div></div><div class="empty">${t('cmp.none')}</div>`; return; }
  if (s.ags !== ags) { s.hide.clear(); s.fitKey = null; }
  if (!s.fleet || s.ags !== ags) { s.map?.remove(); s.map = null; el.innerHTML = `<div class="panel-head"><div><h2>${t('cmp.title')}</h2></div></div><div class="empty">${t('cmp.loading')}</div>`; }
  const [fleet, quota] = await Promise.all([load(ctx, land), loadQuota(ctx)]);
  if (tok !== s.tok) return;
  s.quota = quota; // virtuell/physisch, wenn die Station selbst kein Merkmal trägt (lib/pulse-compare.js isVirtualStation)
  if (!fleet) { s.fleet = null; el.innerHTML = `<div class="panel-head"><div><h2>${t('cmp.title')}</h2></div></div><div class="empty">${t('cmp.loadError')}</div>`; return; }
  s.fleet = fleet; s.ags = ags;
  if (s.map && !el.querySelector('[data-cmp-map]')) { s.map.remove(); s.map = null; }
  draw(el, ctx, s);
}
/** Sprachwechsel: Karte samt Namensnennung neu aufbauen */
export function relabelCompare(el) { const s = S.get(el); if (s?.map) { s.map.remove(); s.map = null; } }
