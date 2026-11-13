// Mobility Pulse — Bericht (Ansicht) – Filter, Städte-Rangliste und Verfügbarkeit (aus report.js geschnitten; report.js bleibt die Fassade für alle Importe).
import * as R from './pulse-report.js';
import { t } from './i18n.js';
import { S, WD, bindOnce, dd, emptyBox, fetchJson, head, hhmm, hideTip, histDoc, histIndex, lastOf, prep, reference, st, stamp, tip, typeName } from './report-core.js';
import { TYPE_ORDER } from './report-watch.js';
import { EXTRA_CSS_2, availCsv, capCsv, capLink } from './report-more.js';

// verknüpft (11.11.2026): Anbieter nur mit Fahrzeugen der gewählten Art, Arten nur des gewählten Anbieters; die aktuelle Wahl bleibt wählbar
export function groupOptions(latest, s = null) {
  const ops = new Set(), types = new Set();
  for (const [k, g] of Object.entries(latest?.groups || {})) {
    const [a, op, ty] = k.split('|'); if (!a || a === 'DE' || !((g?.total || 0) + (g?.stations || 0) > 0)) continue;
    if (!s?.type || s.type === 'all' || ty === s.type) ops.add(op);
    if (!s?.op || s.op === 'all' || op === s.op) types.add(ty);
  }
  if (s?.op && s.op !== 'all') ops.add(s.op); if (s?.type && s.type !== 'all') types.add(s.type);
  return { ops: [...ops].sort((a, b) => a.localeCompare(b, 'de')), types: [...types].sort((a, b) => TYPE_ORDER.indexOf(a) - TYPE_ORDER.indexOf(b)) };
}
export function filterCtl(ctx, s, { op = true, min = true, typeAll = true, minLabel = t('rep.minimumFleet') } = {}) {
  const { ops, types } = groupOptions(ctx.state.latest, op ? s : { type: s.type }); const esc = ctx.esc;
  const opt = (v, l, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`;
  return `<div class="rp-ctl rp-noprint">${op ? `<label>${t('rep.operator2')} <select data-f="op">${opt('all', t('rep.allOperators2'), s.op)}${ops.map(o => opt(o, o, s.op)).join('')}</select></label>` : ''}
    <label>${t('rep.vehicleType')} <select data-f="type">${typeAll ? opt('all', t('rep.allTypes'), s.type) : ''}${types.map(tq => opt(tq, typeName(tq), s.type)).join('')}</select></label>
    ${min ? `<label>${minLabel} <input type="number" data-f="min" min="0" step="10" value="${s.min}" style="width:6em" aria-label="${t('rep.vehicles2', { minLabel })}"> ${t('rep.veh')}</label>` : ''}</div>`;
}
export function initFilters(s, ctx, { type = null } = {}) {
  if (s.init) return; s.init = true;
  const { ops, types } = groupOptions(ctx.state.latest);
  s.op = ops.includes(ctx.state.operator) ? ctx.state.operator : 'all';
  s.type = type ?? (types.includes(ctx.state.type) ? ctx.state.type : 'all');
  s.min = R.MIN_FLEET; s.limit = 100;
}
export function bindFilters(el, s, rerender) {
  el.addEventListener('change', (e) => {
    const f = e.target.dataset?.f; if (!f || f === 'day') return;
    if (f === 'min') { const v = parseInt(e.target.value, 10); s.min = Number.isFinite(v) && v >= 0 ? v : R.MIN_FLEET; } else s[f] = e.target.value;
    s.limit = 100; rerender();
  });
}
// Kopfzeile mit Sortierknöpfen; cols: [key, label, numeric, defaultDir, title?]
export function sortHead(cols, sort) {
  return `<thead><tr>${cols.map(([k, l, n, , title]) => { if (!k) return `<th${n ? ' class="n"' : ''}>${l}</th>`; const on = sort.key === k; return `<th class="${n ? 'n' : ''}" aria-sort="${on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}"><button type="button" class="rp-sort${on ? ' on' : ''}" data-sort="${k}"${title ? ` title="${title}"` : ''}>${l}<span aria-hidden="true">${on ? (sort.dir === 'asc' ? '▲' : '▼') : ''}</span></button></th>`; }).join('')}</tr></thead>`;
}
export function bindSort(el, s, cols, rerender) {
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button.rp-sort'); if (b) { const k = b.dataset.sort; const def = cols.find(c => c[0] === k)?.[3] || 'asc'; s.sort = s.sort.key === k ? { key: k, dir: s.sort.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: def }; rerender(); el.querySelector(`button.rp-sort[data-sort="${k}"]`)?.focus(); return; }
    if (e.target.closest('button[data-rp="more"]')) { s.limit += 100; rerender(); }
  });
}
export const moreBtn = (shown, total) => (total > shown ? `<div class="rp-ctl rp-noprint" style="margin-top:var(--s2)"><button type="button" data-rp="more">${t('rep.showMoreOfMore', { v0: Math.min(100, total - shown), v1: total - shown })}</button></div>` : '');
// Stadt: mit ctx.setScope als Knopf, sonst Link mit ?scope=
export function cityCell(ctx, ags, name, land) {
  const label = `${ctx.esc(name)}${land ? ` <span class="muted">(${ctx.esc(land)})</span>` : ''}`;
  if (typeof ctx.setScope === 'function') return `<button type="button" class="rp-city" data-ags="${ctx.esc(ags)}" title="${t('rep.chooseAsArea')}">${label}</button>`;
  return `<a class="rp-city" href="?scope=${encodeURIComponent(ags)}${ctx.esc(location.hash || '')}" title="${t('rep.chooseAsArea')}">${label}</a>`;
}
export function bindCity(el, ctx) { el.addEventListener('click', (e) => { const b = e.target.closest('button.rp-city'); if (b && typeof S.get(el)?.ctx?.setScope === 'function') S.get(el).ctx.setScope(b.dataset.ags); }); }
// Anteil ohne Rundungsübertreibung: knapp unter 100 % nicht als „100,0 %“, knapp über 0 nicht als „0,0 %“
export const pctFine = (ctx, v, d = 1) => { const lim = 0.5 * 10 ** -d / 100; return v < 1 && v >= 1 - lim ? `> ${ctx.fmt(100 - 10 ** -d, d)} %` : v > 0 && v < lim ? `< ${ctx.fmt(10 ** -d, d)} %` : `${ctx.fmt(v * 100, d)} %`; };
const pctCell = (ctx, v, d = 1) => (v == null ? '<span class="muted">k. A.</span>' : pctFine(ctx, v, d));
export const miniBar = (v) => (v == null ? '' : `<span class="rp-mini" aria-hidden="true"><i style="width:${Math.max(0, Math.min(100, v * 100)).toFixed(1)}%"></i></span>`);
const EXTRA_CSS = `
.rp-sort{all:unset;cursor:pointer;display:inline-flex;gap:4px;align-items:center;font:inherit;letter-spacing:inherit;text-transform:inherit;color:inherit;border-radius:4px}
.rp-sort:hover,.rp-sort.on{color:var(--fg)}.rp-sort:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.rp-sort span{font-size:9px;min-width:8px}
.rp-city{all:unset;cursor:pointer;font-weight:500;color:var(--fg);text-decoration:underline;text-decoration-color:var(--line-2);text-underline-offset:2px}
a.rp-city{text-decoration:underline}.rp-city:hover{text-decoration-color:var(--accent)}.rp-city:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:3px}
tr.rp-sel td{background:color-mix(in srgb,var(--accent) 11%,transparent)}tr.rp-sel .muted{color:var(--fg)}tr.rp-sel .sub-line{color:var(--fg-2)}tr.rp-sel td:first-child{box-shadow:inset 3px 0 0 var(--accent)}
.rp-mini{display:inline-block;width:44px;height:4px;border-radius:2px;background:color-mix(in srgb,var(--accent) 18%,var(--panel-2));vertical-align:middle;margin-left:6px;overflow:hidden}.rp-mini>i{display:block;height:100%;background:var(--accent)}
.rp-defs{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:var(--s2) var(--s4);margin:0 0 var(--s3)}
.rp-defs div{font-size:12.5px;color:var(--fg-2)}.rp-defs b{color:var(--fg);font-weight:600}
.rp-keys{display:flex;flex-wrap:wrap;gap:var(--s1) var(--s4);font-size:12px;color:var(--fg-2);margin:0 0 var(--s2)}
.rp-key{display:inline-block;width:14px;height:2px;border-radius:1px;vertical-align:middle;margin-right:6px;background:var(--c)}
svg.rp-line{display:block;width:100%;height:auto;overflow:visible;touch-action:pan-y}
svg.rp-line text{font-family:var(--mono);font-size:10.5px;fill:var(--muted)}svg.rp-line text.lab{font-family:var(--sans);font-size:11.5px;fill:var(--fg-2)}
svg.rp-line .grid{stroke:var(--line);stroke-width:1}svg.rp-line .base{stroke:var(--line-2);stroke-width:1}
svg.rp-line .xh{stroke:var(--fg-2);stroke-width:1}svg.rp-line:focus-visible{outline:2px solid var(--accent);outline-offset:4px;border-radius:4px}
svg.rp-line circle.end{stroke:var(--panel);stroke-width:2}svg.rp-line circle.sel{fill:none;stroke:var(--fg);stroke-width:2}
.rp-tip .row{display:flex;gap:8px;align-items:center;white-space:nowrap}.rp-tip .row b{display:inline;font-size:13px;min-width:56px;text-align:right}.rp-tip .row i{width:12px;height:2px;border-radius:1px;flex:none}
.rp-tip .hd{color:var(--muted);font-size:11px;margin-bottom:2px}
.rp-captable tbody th{position:static;text-transform:none;letter-spacing:0;font-size:13px;font-weight:500;color:var(--fg);vertical-align:top;background:transparent;border-bottom:1px solid var(--line);min-width:150px}
.rp-captable tbody th .sub-line{font-weight:400;color:var(--muted)}
.rp-captable tbody+tbody tr:first-child>*{border-top:1px solid var(--line-2)}
.rp-captable td.n .sub-line{font-family:var(--sans);white-space:normal;min-width:7em}
.rp-captable tr.rp-sum td{font-weight:600;background:color-mix(in srgb,var(--fg) 3%,transparent)}
.rp-h3{font-size:14px;font-weight:600;margin:var(--s4) 0 var(--s2)}.rp-h3:first-of-type{margin-top:var(--s2)}
.rp-root tr.rp-sum td{font-weight:600}.rp-zonemap{height:300px;border-radius:var(--r-sm);border:1px solid var(--line);background:var(--bg-2);margin-bottom:var(--s3);isolation:isolate}.rp-root tr.rp-zonesub>td{padding-top:0;border-top:0}.rp-spark{display:block;overflow:visible}
.rp-captable tbody.rp-selg>tr>*{background:color-mix(in srgb,var(--accent) 11%,transparent)}.rp-captable tbody.rp-selg th{box-shadow:inset 3px 0 0 var(--accent)}.rp-captable tbody.rp-selg .muted,.rp-captable tbody.rp-selg .sub-line{color:var(--fg-2)}
.rp-over{font-size:11.5px;margin-left:4px;vertical-align:1px}.rp-over i{width:14px;height:14px;font-size:9px}
.rp-prof{display:grid;gap:var(--s3);grid-template-columns:repeat(auto-fill,minmax(min(100%,340px),1fr))}
.rp-prof .card dl{margin:0;display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px var(--s3);font-size:12.5px}
.rp-prof .card dt{color:var(--muted)}.rp-prof .card dd{margin:0;color:var(--fg)}
details.rp-defs-d{margin:0 0 var(--s3)}details.rp-defs-d .rp-defs{margin:0}
.rp-caplink{display:flex;flex-wrap:wrap;gap:var(--s2) var(--s3);align-items:center;margin:var(--s4) 0 0}.rp-caplink>span{flex:1 1 44ch;min-width:0}.rp-caplink a{font-weight:500}
a[data-rp-jump]{display:inline-flex;align-items:center;min-height:24px}
`;
function injectExtra() { if (document.getElementById('rp-style-2')) return; const s = document.createElement('style'); s.id = 'rp-style-2'; s.textContent = EXTRA_CSS + EXTRA_CSS_2; document.head.appendChild(s); }
export function prep2(el, ctx) { const s = prep(el, ctx); injectExtra(); return s; }
const opsDoc = (ctx, land) => fetchJson(ctx, `ops/${land}.json`); // ohne Laufstempel: derselbe Download wie Übersicht (Energie) und Karte
async function latestHist(ctx, day = null) { const hidx = await histIndex(ctx); const days = (hidx.days || []).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)); const d = day && days.includes(day) ? day : lastOf(days); return { days, day: d || null, hist: d ? await histDoc(ctx, hidx, d) : null }; }

// ======================================================================
// 7. Verfügbarkeit je Stadt
// ======================================================================
const AV_COLS_DEF = () => ([['name', t('rep.cityState'), false, 'asc'], ['total', t('rep.reported2'), true, 'desc'], ['available', t('rep.bookable'), true, 'desc'], ['avail', t('rep.availability'), true, 'asc', t('rep.bookableReported')], ['ready', t('rep.readyToRide'), true, 'asc', t('rep.bookableAndEnoughEnergy')],
  ['disabledShare', t('rep.disabled'), true, 'desc'], ['reserved', t('rep.reserved'), true, 'desc'], ['opCount', t('rep.operator2'), true, 'desc'], ['dayMean', t('rep.dailyMean'), true, 'asc', t('rep.meanAvailabilityOver')], ['dayMin', t('rep.dailyMinimum'), true, 'asc']]);
function availData(ctx, s) {
  const { state } = ctx; const scope = state.scope && state.scope !== 'DE' ? state.scope : null;
  const rows = R.availabilityRows(state.latest, { operator: s.op, type: s.type, minTotal: s.min, keepAgs: scope });
  const th = state.latest?.thresholds || {};
  const roSet = R.rangeOnlyOperators(state.latest?.sources), rangeOnly = (op) => roSet.has(op); // wie Sammler und app.js
  // Einsatzbereit: aus den Zählern je Gruppe in latest.json (energyKnown, ready; Sammler seit latest.energy), sonst je Land aus ops/<Land>.json
  const fromGroups = (k) => { if (!s.readyCache.has(k)) { const m = new Map(); for (const [key, g] of Object.entries(state.latest.groups || {})) { const [ags, op, ty] = key.split('|'); if (ags === 'DE' || (s.op !== 'all' && op !== s.op) || (s.type !== 'all' && ty !== s.type)) continue; const o = m.get(ags) || { total: 0, known: 0, ready: 0 }; o.total += g.total || 0; o.known += g.energyKnown || 0; o.ready += g.ready || 0; m.set(ags, o); } s.readyCache.set(k, m); } return s.readyCache.get(k); };
  const readyFor = (land) => { if (state.latest?.energy) return fromGroups(`groups|${s.op}|${s.type}`); const k = `${land}|${s.op}|${s.type}`; if (!s.readyCache.has(k) && s.ops.has(land)) s.readyCache.set(k, R.readinessFromOps(s.ops.get(land), { operator: s.op, type: s.type, charge: th.chargeThreshold ?? 20, range: th.rangeThreshold ?? 5, rangeOnly })); return s.readyCache.get(k) || null; };
  const ha = s.hist ? R.histAvailability(s.hist, { operator: s.op, type: s.type }) : null;
  for (const r of rows) {
    const rd = r.state ? readyFor(r.state) : null; const o = rd?.get(r.ags);
    r.readyKnown = o ? o.known : null; r.ready = o && o.known ? o.ready / o.known : null; r.readyPending = !rd && r.state && !s.opsFailed.has(r.state);
    const h = ha?.byAgs.get(r.ags); r.dayMean = h ? h.mean : null; r.dayMin = h ? h.min : null; r.dayMinAt = h ? h.minAt : null; r.dayN = h ? h.n : null;
  }
  return { rows: R.sortRows(rows, s.sort.key, s.sort.dir), scope, ha };
}
function availTable(ctx, s, d) {
  const { esc, fmt } = ctx; const show = d.rows.slice(0, s.limit);
  const body = show.map(r => `<tr${r.ags === d.scope ? ' class="rp-sel" aria-current="true"' : ''}><td>${cityCell(ctx, r.ags, r.name, r.state)}${r.below ? `<div class="sub-line">${t('rep.belowMinimumFleetSelected')}</div>` : ''}</td>
    <td class="n">${fmt(r.total)}</td><td class="n">${fmt(r.available)}</td><td class="n"><b>${pctCell(ctx, r.avail)}</b>${miniBar(r.avail)}</td>
    <td class="n">${r.readyPending ? '<span class="muted">…</span>' : pctCell(ctx, r.ready)}${r.readyKnown != null && r.readyKnown < r.total ? `<div class="sub-line">${r.readyKnown ? t('rep.nWithEnergyData', { readyKnown: fmt(r.readyKnown) }) : t('rep.noEnergyData')}</div>` : ''}</td>
    <td class="n">${pctCell(ctx, r.disabledShare)}</td><td class="n">${fmt(r.reserved)}</td><td class="n" title="${esc(r.operators.join(', '))}">${r.opCount}</td>
    <td class="n">${pctCell(ctx, r.dayMean)}</td><td class="n">${pctCell(ctx, r.dayMin)}${r.dayMinAt ? `<div class="sub-line">${hhmm(r.dayMinAt)}</div>` : ''}</td></tr>`).join('');
  return `<div class="tbl"><table>${sortHead(AV_COLS_DEF(), s.sort)}<tbody>${body || `<tr><td colspan="${AV_COLS_DEF().length}" class="empty">${t('rep.noCityInFilterLowerMinimum')}</td></tr>`}</tbody></table></div>${moreBtn(show.length, d.rows.length)}`;
}
// Liniendiagramm: eine Achse bis 100 %, Farbe je Anbieter, Lücken > 45 Min. als Unterbrechung, Direktbeschriftung am Ende.
// y-Achse auf den Datenbereich (Linie, kein Balken: Untergrenze darf über 0 liegen): 5 Punkte unter dem kleinsten Wert, auf die Teilung
// abgerundet (Werte 97–100 % → Achse 90–100 %); Achsentitel nennt die Größe, die unterste Marke den Beginn
function lineChart(ctx, tq, series, { W = 900, H = 280 } = {}) {
  const P = { l: 46, r: 132, t: 22, b: 30 };
  const HOUR = 3600e3; const t0 = Math.floor(tq[0] / HOUR) * HOUR, t1 = Math.max(t0 + HOUR, Math.ceil(tq[tq.length - 1] / HOUR) * HOUR);
  const vals = series.flatMap(s => s.values.filter(v => v != null)), lo0 = vals.length ? Math.max(0, Math.min(...vals) - 0.05) : 0;
  const yStep = [0.01, 0.02, 0.05, 0.1, 0.25].find(s => (1 - lo0) / s <= 4) || 0.25, lo = Math.floor(lo0 / yStep + 1e-9) * yStep;
  const x = (v) => P.l + ((v - t0) / (t1 - t0)) * (W - P.l - P.r), y = (v) => P.t + (1 - (v - lo) / (1 - lo)) * (H - P.t - P.b);
  let g = `<text x="2" y="${P.t - 10}">${t('rep.availAxis')}</text>`;
  for (let k = 0, v = lo; v <= 1 + 1e-9; k++, v = lo + k * yStep) g += `<line class="${k === 0 ? 'base' : 'grid'}" x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${P.l - 6}" y="${y(v) + 3.5}" text-anchor="end">${ctx.fmt(v * 100, Math.abs(v * 100 - Math.round(v * 100)) > 1e-6 ? 1 : 0)} %</text>`;
  const span = (t1 - t0) / HOUR; const step = [1, 2, 3, 4, 6, 12].find(s => span / s <= 8) || 24;
  for (let tt = t0; tt <= t1; tt += step * HOUR) g += `<text x="${x(tt)}" y="${H - 8}" text-anchor="middle">${hhmm(tt)}</text>`;
  const lines = series.map((s) => {
    const segs = R.lineSegments(tq, s.values); const c = ctx.opColor(s.op);
    return segs.map(seg => seg.length === 1 ? `<circle cx="${x(tq[seg[0]]).toFixed(1)}" cy="${y(s.values[seg[0]]).toFixed(1)}" r="3" fill="${c}"/>` : `<path d="${seg.map((i, j) => `${j ? 'L' : 'M'}${x(tq[i]).toFixed(1)} ${y(s.values[i]).toFixed(1)}`).join(' ')}" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`).join('');
  }).join('');
  // Endpunkte und Direktbeschriftung; kollidierende Beschriftungen entfallen (Legende und Tooltip tragen sie)
  const ends = series.map(s => { let i = s.values.length - 1; while (i >= 0 && s.values[i] == null) i--; return i >= 0 ? { s, i, ty: y(s.values[i]) } : null; }).filter(Boolean).sort((a, b) => a.ty - b.ty);
  let lastY = -Infinity; let labels = '';
  const dots = ends.map(e => `<circle class="end" cx="${x(tq[e.i]).toFixed(1)}" cy="${e.ty.toFixed(1)}" r="4" fill="${ctx.opColor(e.s.op)}"/>`).join('');
  for (const e of ends) { if (e.ty - lastY < 13) continue; lastY = e.ty; labels += `<text class="lab" x="${(x(tq[e.i]) + 9).toFixed(1)}" y="${(e.ty + 4).toFixed(1)}">${ctx.esc(e.s.op)} ${ctx.fmt(e.s.values[e.i] * 100, 0)} %</text>`; }
  return { svg: `<svg class="rp-line" viewBox="0 0 ${W} ${H}" role="img" tabindex="0" aria-label="${t('rep.availabilityPerOperatorOver')}">${g}${lines}${dots}${labels}<line class="xh" x1="0" x2="0" y1="${P.t}" y2="${H - P.b}" visibility="hidden"/><rect class="hit" x="${P.l}" y="${P.t}" width="${W - P.l - P.r}" height="${H - P.t - P.b}" fill="transparent"/></svg>`, x, W, P };
}
export function showRowsTip(box, anchor, px, py, head, rows) {
  const tq = tip(box); tq.replaceChildren();
  const hd = document.createElement('div'); hd.className = 'hd'; hd.textContent = head; tq.append(hd);
  for (const r of rows) { const d = document.createElement('div'); d.className = 'row'; const i = document.createElement('i'); i.style.background = r.color; const b = document.createElement('b'); b.textContent = r.value; const s = document.createElement('span'); s.textContent = r.label; d.append(i, b, s); tq.append(d); }
  tq.hidden = false; const w = box.getBoundingClientRect();
  const xx = Math.max(tq.offsetWidth / 2 + 4, Math.min(w.width - tq.offsetWidth / 2 - 4, px - w.left)); let yy = py - w.top; if (yy - tq.offsetHeight - 10 < 0) yy = yy + tq.offsetHeight + 24;
  tq.style.left = `${xx}px`; tq.style.top = `${yy}px`;
}
function bindLine(el, getChart) {
  const move = (svg, i) => {
    const c = getChart(); if (!c || i == null) return; const box = svg.closest('.rp-chart');
    const xh = svg.querySelector('line.xh'); const xv = c.x(c.t[i]); xh.setAttribute('x1', xv); xh.setAttribute('x2', xv); xh.setAttribute('visibility', 'visible');
    const r = svg.getBoundingClientRect(); const k = r.width / c.W;
    const rows = c.series.map(s => ({ color: c.color(s.op), value: s.values[i] == null ? '–' : c.pct(s.values[i]), label: s.op, v: s.values[i] ?? -1 })).sort((a, b) => b.v - a.v);
    showRowsTip(box, svg, r.left + xv * k, r.top + c.P.t * k, t('rep.collectorPoint', { v0: hhmm(c.t[i]) }), rows); c.i = i;
  };
  const nearest = (svg, clientX) => { const c = getChart(); if (!c) return null; const r = svg.getBoundingClientRect(); const xv = (clientX - r.left) * (c.W / r.width); let best = null, bd = Infinity; c.t.forEach((tt, i) => { const d = Math.abs(c.x(tt) - xv); if (d < bd) { bd = d; best = i; } }); return best; };
  const hide = (svg) => { svg?.querySelector('line.xh')?.setAttribute('visibility', 'hidden'); const box = svg?.closest('.rp-chart'); if (box) hideTip(box); };
  el.addEventListener('pointermove', (e) => { const svg = e.target.closest?.('svg.rp-line'); if (svg) move(svg, nearest(svg, e.clientX)); });
  el.addEventListener('pointerout', (e) => { const svg = e.target.closest?.('svg.rp-line'); if (svg && !svg.contains(e.relatedTarget)) hide(svg); });
  el.addEventListener('focusin', (e) => { if (e.target.matches?.('svg.rp-line')) { const c = getChart(); move(e.target, c?.i ?? (c ? c.t.length - 1 : null)); } });
  el.addEventListener('focusout', (e) => { if (e.target.matches?.('svg.rp-line')) hide(e.target); });
  el.addEventListener('keydown', (e) => { if (!e.target.matches?.('svg.rp-line')) return; const c = getChart(); if (!c) return; const d = { ArrowRight: 1, ArrowLeft: -1, Home: -1e9, End: 1e9 }[e.key]; if (d == null) return; e.preventDefault(); move(e.target, Math.max(0, Math.min(c.t.length - 1, (c.i ?? c.t.length - 1) + d))); });
}
function availChart(ctx, s) {
  const { state, esc, fmt } = ctx; const scope = state.scope;
  if (!scope || scope === 'DE') return '';
  const name = state.latest?.municipalities?.[scope]?.name || scope;
  const daySel = s.histDays.length > 1 ? `<label>${t('rep.day')} <select data-f="day">${[...s.histDays].reverse().map(d => `<option value="${esc(d)}"${d === s.day ? ' selected' : ''}>${WD()[R.weekdayOf(d)]}, ${dd(d)}</option>`).join('')}</select></label>` : '';
  const btn = `<button type="button" data-rp="avtable" aria-expanded="${s.showTable ? 'true' : 'false'}">${s.showTable ? t('rep.asChart') : t('rep.asTable')}</button>`;
  const headH = `<div class="panel-head" style="margin-top:var(--s5)"><div><h3 style="margin:0;font-size:14px">${t('rep.historyIn', { name: esc(name) })}</h3><div class="sub">${t('rep.availabilityPerOperatorFrom', { v0: s.hist?.t?.length ? ` · ${t('rep.points', { length: s.hist.t.length, v1: hhmm(s.hist.t[0]), v2: hhmm(lastOf(s.hist.t)) })}` : '' })}</div></div><div class="rp-ctl rp-noprint">${daySel}${btn}</div></div>`;
  if (!s.hist) return headH + emptyBox(s.histLoading ? t('rep.loadingHistory') : t('rep.noHistoryForThisDay'), s.histLoading ? '' : 'history/<Tag>.json fehlt.');
  const ser = R.availabilitySeries(s.hist, scope, { operator: s.op, type: s.type });
  s.chart = null;
  if (!ser.series.length) return headH + emptyBox(t('rep.noCollectorPointsInFilter'), t('rep.setOperatorOrVehicleTypeTo'));
  const series = ser.series.slice(0, 8); const more = ser.series.length - series.length;
  if (s.showTable) {
    const rows = ser.t.map((tt, i) => `<tr><td class="n">${hhmm(tt)}</td>${series.map(x => `<td class="n">${x.values[i] == null ? '–' : pctFine(ctx, x.values[i], 1)}</td>`).join('')}</tr>`).join('');
    return headH + `<div class="tbl"><table><thead><tr><th class="n">${t('rep.time')}</th>${series.map(x => `<th class="n">${esc(x.op)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  const ch = lineChart(ctx, ser.t, series);
  s.chart = { t: ser.t, series, x: ch.x, W: ch.W, P: ch.P, color: ctx.opColor, fmt, pct: (v) => pctFine(ctx, v, 1), i: null };
  const keys = `<div class="rp-keys" aria-label="${t('rep.legend')}">${series.map(x => `<span><i class="rp-key" style="--c:${ctx.opColor(x.op)}"></i>${esc(x.op)} <span class="muted mono">${t('rep.avgVeh', { total: fmt(x.total) })}</span></span>`).join('')}${more ? `<span class="muted">${t('rep.moreByFleet', { more })}</span>` : ''}</div>`;
  return headH + keys + `<div class="rp-chart">${ch.svg}</div>`;
}
/**
 * Verfügbarkeit je Stadt (ganz Deutschland) mit eigenen Auswahlfeldern Anbieter, Art und Mindestbestand; Verlauf für die gewählte Gemeinde.
 * Daten: latest.json groups (gemeldet, buchbar, gesperrt, reserviert), ops/<Land>.json (Einsatzbereitschaft je Fahrzeug),
 * history/index.json + history/<Tag>.json (Tagesmittel/-minimum, Verlauf). Optional ctx.setScope(ags).
 */
export async function renderAvailability(el, ctx) {
  if (!el) return;
  const s = prep2(el, ctx); const { state } = ctx;
  if (!s.sort) { s.sort = { key: 'avail', dir: 'asc' }; s.ops = new Map(); s.opsFailed = new Set(); s.readyCache = new Map(); s.histDays = []; }
  if (state.latest) initFilters(s, ctx);
  const draw = () => drawAvailability(el);
  bindOnce(el, 'avail', () => {
    bindFilters(el, s, draw);
    el.addEventListener('change', async (e) => { if (e.target.dataset?.f === 'day') { s.day = e.target.value; s.histLoading = true; draw(); const h = await latestHist(s.ctx, s.day); s.hist = h.hist; s.histLoading = false; draw(); } });
    bindSort(el, s, AV_COLS_DEF(), draw); bindCity(el, ctx); bindLine(el, () => s.chart);
    el.addEventListener('click', (e) => { if (e.target.closest('button[data-rp="avtable"]')) { s.showTable = !s.showTable; draw(); } else if (e.target.closest('button[data-rp="avcsv"]')) availCsv(el); else if (e.target.closest('button[data-rp="capcsv"]')) capCsv(el); });
    el.addEventListener('toggle', (e) => { if (e.target.matches?.('details.rp-defs-d')) s.defsOpen = e.target.open; }, true); // toggle steigt nicht auf
  });
  if (!state.latest) { el.innerHTML = head(t('rep.availabilityPerCity'), '') + emptyBox(t('rep.noDataSnapshotYet'), t('rep.tableAppearsAsSoonAs')); return; }
  const tok = ++s.tok;
  draw();
  try {
    if (!s.hist || s.histAt !== state.latest.at) { s.histLoading = true; const h = await latestHist(ctx, s.day); if (tok !== s.tok) return; s.hist = h.hist; s.histDays = h.days; s.day = h.day; s.histAt = state.latest.at; s.histLoading = false; draw(); }
    if (s.ref === undefined) { s.ref = await reference(ctx); if (tok !== s.tok) return; draw(); } // Obergrenzen (reference.json) für Verfügbar ÷ erlaubt
    // Einsatzbereitschaft: ops/<Land>.json der Länder in der Tabelle (und der gewählten Gemeinde) nachladen
    if (s.opsAt !== state.latest.at) { s.ops.clear(); s.readyCache.clear(); s.opsFailed.clear(); s.opsAt = state.latest.at; }
    // mit Energie-Zählern je Gruppe (latest.energy) keine Flottendateien laden (vorher alle 15 Länder, 6,3 MB)
    const lands = state.latest.energy ? [] : [...new Set(Object.values(state.latest.municipalities || {}).map(m => m.state).filter(Boolean))].filter(l => !s.ops.has(l) && !s.opsFailed.has(l));
    await Promise.all(lands.map(async (l) => { const d = await opsDoc(ctx, l); if (tok !== s.tok) return; if (d?.vehicles) { s.ops.set(l, d); if (d.at && d.at !== state.latest.at) s.opsStamp = d.at; } else s.opsFailed.add(l); }));
    if (tok === s.tok) draw();
  } catch (e) { console.error('Verfügbarkeit', e); }
}
function drawAvailability(el) {
  const s = st(el); const ctx = s.ctx; const { esc } = ctx; if (!ctx.state.latest) return;
  const d = availData(ctx, s); s.rows = d.rows;
  const th = ctx.state.latest.thresholds || {};
  // Definitionen eingeklappt wie „Methode“ in der Disposition (UI-25); offen bleibt, was der Nutzer geöffnet hat
  const defs = `<details class="more rp-defs-d"${s.defsOpen ? ' open' : ''}><summary data-f="defs">${t('rep.definitions')}</summary><div class="rp-defs"><div>${t('rep.availabilityBookableReported')}</div>
    <div>${t('rep.readyToRideBookableAndEnergy', { v0: th.chargeThreshold ?? 20, v1: th.rangeThreshold ?? 5, join: esc(R.RANGE_ONLY_OPS.join(', ')), v3: s.opsStamp ? ` ${t('rep.energyAsOf', { v0: stamp(s.opsStamp) })}` : '' })}</div>
    <div>${t('rep.dailyMeanMinimumAvailability', { v0: s.hist?.t?.length ? ` ${t('rep.pointsTimeRange', { n: s.hist.t.length, from: hhmm(s.hist.t[0]), to: hhmm(lastOf(s.hist.t)) })}` : '', v1: stamp(ctx.state.latest.at) })}</div></div></details>`;
  const right = `<div class="rp-ctl rp-noprint"><button type="button" data-rp="avcsv" title="${t('rep.allRowsInFilter')}">↓ CSV</button></div>`;
  const focus = document.activeElement && el.contains(document.activeElement) ? (document.activeElement.dataset?.f || null) : null;
  el.innerHTML = head(t('rep.availabilityPerCity'), t('rep.bookableAndReadyToRide', { length: d.rows.length }), right)
    + filterCtl(ctx, s) + defs + availTable(ctx, s, d) + capLink(ctx, s) + availChart(ctx, s);
  if (focus) el.querySelector(`[data-f="${focus}"]`)?.focus();
}
