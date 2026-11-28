// Mobility Pulse — Tokio im Reiter „Vergleich“ (28.11.2026): stationsgebundene Leihräder (docomo bike share, HELLO CYCLING) als Gegenbild
// zu den deutschen Städten. Kennzahlen, Vergleich mit den drei deutschen Städten mit den meisten Leihrädern, Tageskurven (Ortszeit Tokio)
// und Karte der Ports nach Füllstand. Daten: tokio/*.json (Phase „tokio“ des Sammlers, lib/pulse-tokio.js). Werte aus Daten gehen durch ctx.esc.
// Eigenständig: renderTokio(el, ctx), ctx = { state, CFG, esc, fmt, getJson }; Leaflet (L) global.
import * as TK from './pulse-tokio.js';
import { t, dateFmt } from './i18n.js';
import { chartSpec, tableButton } from './charttip.js';
import { seriesColor, NEUTRAL, PRINT, RUN } from './tokens.js';

const S = new WeakMap();
const STYLE = `
.tk-sys{display:flex;flex-wrap:wrap;gap:6px;margin:var(--s2) 0}
.tk-sys button[aria-pressed="false"]{color:var(--fg-2);border-style:dashed;text-decoration:line-through}
.tk-days{display:flex;flex-wrap:wrap;gap:6px;margin:var(--s2) 0 var(--s3)}
.tk-charts{display:grid;gap:var(--s4);grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
.tk-map{height:460px;border-radius:var(--r-sm);border:1px solid var(--line);background:var(--bg-2);isolation:isolate;margin-top:var(--s2)}
.tk-legend{display:flex;flex-wrap:wrap;gap:var(--s1) var(--s4);align-items:center;font-size:.75rem;color:var(--fg-2);margin-top:var(--s2)}
.tk-keys{display:flex;flex-wrap:wrap;gap:var(--s1) var(--s4);font-size:.75rem;color:var(--fg-2);margin-top:var(--s2)}
.tk-keys i{display:inline-block;width:16px;height:0;border-top:2px solid var(--c);margin-right:5px;vertical-align:3px}.tk-keys i.d{border-top-style:dashed}
.tk-legend i{display:inline-block;width:11px;height:11px;border-radius:50%;margin-right:5px;vertical-align:-1px}
.leaflet-tooltip.tk-tip{background:var(--panel);color:var(--fg-2);border:1px solid var(--line-2);border-radius:var(--r-sm);box-shadow:var(--shadow);padding:6px 10px;font:.75rem/1.45 var(--sans);max-width:min(300px,70vw);white-space:normal}
.leaflet-tooltip.tk-tip b{color:var(--fg)}
@media (max-width:720px){.tk-map{height:340px}}
`;
let cssDone = false;
export const css = () => { if (cssDone || typeof document === 'undefined') return; cssDone = true; const s = document.createElement('style'); s.textContent = STYLE; document.head.appendChild(s); };
export const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const jst = (/** @type {number} */ ms) => (ms ? dateFmt({ dateStyle: 'medium', timeStyle: 'short', timeZone: TK.TOKIO.tz }).format(new Date(ms)) : '–');
const dayLabel = (/** @type {string} */ d) => dateFmt({ weekday: 'short', day: 'numeric', month: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`));
const cssVar = (/** @type {string} */ k, /** @type {string} */ fb) => (typeof document !== 'undefined' && getComputedStyle(document.documentElement).getPropertyValue(k).trim()) || fb;
const tile = (/** @type {string} */ l, /** @type {string} */ v, /** @type {string} */ s) => `<div class="tile"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
/** Farbe und Strich je System (Farbe nie allein: HELLO CYCLING gestrichelt) @param {number} i */
const look = (i) => ({ color: seriesColor(i), dash: i ? ' stroke-dasharray="6 4"' : '' });

/** @param {any} ctx @param {string} f */
const load = async (ctx, f) => { try { const r = await ctx.getJson(`${ctx.CFG.DATA}tokio/${f}`, { timeout: 60000 }); return r?.ok && r.json ? r.json : null; } catch { return null; } };

/** Die drei deutschen Städte mit den meisten Leihrädern (Räder und E-Räder aller Anbieter, letzter Lauf) @param {any} latest */
function germanTop(latest) {
  return Object.values(latest?.municipalities || {}).map((/** @type {any} */ m) => {
    let bikes = 0, ops = 0;
    for (const o of Object.values(m.operators || {})) { const n = (/** @type {any} */ (o).types?.bike || 0) + (/** @type {any} */ (o).types?.ebike || 0); bikes += n; if (n) ops++; }
    return { name: m.name, bikes, ops };
  }).filter(x => x.bikes > 0).sort((a, b) => b.bikes - a.bikes).slice(0, 3);
}

/** Liniendiagramm über die Stunden 0–23 (Ortszeit; auch für den Reiter Länder) @param {any} ctx @param {any[]} series [{ label, i, pts: [{ h, v }] }] @param {(v: number) => string} fv @param {string} aria @param {string} [tzLabel] */
export function hourChart(ctx, series, fv, aria, tzLabel = t('tk.jst')) {
  const all = series.flatMap(s => s.pts.map((/** @type {any} */ p) => p.v)).filter(v => v != null);
  if (!all.length) return `<div class="empty">${t('tk.noHours')}</div>`;
  const W = 520, H = 210, P = { l: 46, r: 10, t: 10, b: 24 }, ymax = Math.max(1, ...all) * 1.1;
  const x = (/** @type {number} */ h) => P.l + h / 23 * (W - P.l - P.r), y = (/** @type {number} */ v) => H - P.b - v / ymax * (H - P.t - P.b);
  const q = ymax / 4, p10 = Math.pow(10, Math.floor(Math.log10(q))), f = q / p10, step = p10 * (f > 5 ? 10 : f > 2 ? 5 : f > 1 ? 2 : 1);
  let g = '';
  for (let v = 0; v <= ymax + 1e-9; v += step) g += `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text x="${P.l - 4}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${ctx.esc(fv(v))}</text>`;
  for (const h of [0, 6, 12, 18, 23]) g += `<text x="${x(h).toFixed(1)}" y="${H - 6}" text-anchor="${h === 0 ? 'start' : h === 23 ? 'end' : 'middle'}">${h} h</text>`;
  const lines = series.map(s => { const lk = look(s.i); let d = '', prev = -9; for (const p of s.pts) { if (p.v == null) { prev = -9; continue; } d += `${p.h - prev === 1 ? 'L' : 'M'}${x(p.h).toFixed(1)},${y(p.v).toFixed(1)}`; prev = p.h; } return d ? `<path d="${d}" fill="none" stroke="${lk.color}" stroke-width="2"${lk.dash}/>` : ''; }).join('');
  const hours = [...new Set(series.flatMap(s => s.pts.filter((/** @type {any} */ p) => p.v != null).map((/** @type {any} */ p) => p.h)))].sort((a, b) => a - b);
  const val = (/** @type {any} */ s, /** @type {number} */ h) => s.pts.find((/** @type {any} */ p) => p.h === h)?.v ?? null;
  const sp = chartSpec({ n: hours.length, x: (i) => x(hours[i]), top: P.t, bottom: H - P.b, head: (i) => `${hours[i]}–${hours[i] + 1} h (${tzLabel})`, label: aria, colHead: t('tk.hour'), cols: series.map(s => s.label),
    cell: (i, k) => { const v = val(series[k], hours[i]); return v == null ? '–' : fv(v); },
    rows: (i) => series.map(s => ({ s, v: val(s, hours[i]) })).filter(r => r.v != null).map(r => ({ color: look(r.s.i).color, label: r.s.label, value: fv(r.v), sort: r.v })) });
  const key = `<div class="tk-keys">${series.map(s => `<span><i class="${s.i ? 'd' : ''}" style="--c:${look(s.i).color}"></i>${ctx.esc(s.label)}</span>`).join('')}</div>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" ${sp.attrs} aria-label="${ctx.esc(aria)}">${g}${lines}</svg>${tableButton(sp.id)}${key}`;
}

/** @param {any} ctx @param {any} s */
function drawDay(ctx, s) {
  const box = s.el.querySelector('[data-tk-day]'); if (!box) return;
  const ix = s.ix, sys = ix.systems.filter((/** @type {any} */ x) => s.on.has(x.id)), dd = s.dayDoc;
  if (!dd) { box.innerHTML = `<div class="empty">${t('tk.noHours')}</div>`; return; }
  const ser = (/** @type {(r: any) => number|null} */ f) => sys.map((/** @type {any} */ x) => ({ label: x.name, i: ix.systems.indexOf(x), pts: TK.hourly(dd, x.id).map(r => ({ h: r.h, v: f(r) })) }));
  const tot = sys.map((/** @type {any} */ x) => ({ x, d: TK.dayTotals(dd, x.id) }));
  box.innerHTML = `<div class="tk-charts"><div><h3>${t('tk.chartBikes')}</h3>${hourChart(ctx, ser(r => Math.round(r.bikes)), (v) => ctx.fmt(v), t('tk.chartBikes'))}</div>
    <div><h3>${t('tk.chartOut')}</h3>${hourChart(ctx, ser(r => (r.outH == null ? null : Math.round(r.outH))), (v) => ctx.fmt(v), t('tk.chartOut'))}</div>
    <div><h3>${t('tk.chartEmpty')}</h3>${hourChart(ctx, ser(r => Math.round(r.empty * 1000) / 10), (v) => `${ctx.fmt(v, v < 10 && v % 1 ? 1 : 0)} %`, t('tk.chartEmpty'))}</div></div>
    <p class="muted small">${tot.map(({ x, d }) => t('tk.dayTotal', { sys: ctx.esc(x.name), out: ctx.fmt(d.out), in: ctx.fmt(d.in), h: ctx.fmt(d.min / 60, 1) })).join(' ')} ${t('tk.outNote')}</p>`;
}

/** Füllstand eines Ports → Klasse (leer, wenig, mittel, viel, voll, aus) @param {any[]} r STAND_FIELDS */
const fillOf = (r) => (r[4] & 1 ? 'off' : r[2] === 0 ? 'empty' : r[3] === 0 ? 'full' : r[2] / (r[2] + r[3]) < 1 / 3 ? 'low' : r[2] / (r[2] + r[3]) < 2 / 3 ? 'mid' : 'high');
export const FILL = ['empty', 'low', 'mid', 'high', 'full', 'off'];
/** @param {string} k */
export const fillStyle = (k) => {
  const acc = cssVar('--accent', PRINT.accent), bad = cssVar('--bad', RUN.workshop.light), info = cssVar('--info', RUN.rebalance.light), off = cssVar('--muted', NEUTRAL.disabled);
  return k === 'empty' ? { color: bad, fillColor: bad, fillOpacity: 0, weight: 2, radius: 4.5 } : k === 'full' ? { color: info, fillColor: info, fillOpacity: 1, weight: 2, radius: 5 }
    : k === 'off' ? { color: off, fillColor: off, fillOpacity: 0.6, weight: 0, radius: 3 } : { color: acc, fillColor: acc, fillOpacity: k === 'low' ? 0.3 : k === 'mid' ? 0.6 : 1, weight: 1, radius: 4.5 };
};

/** Radius der Ports je Zoomstufe (weiter draußen kleiner) @param {number} z */
export const scaleOf = (z) => (z <= 10 ? 0.45 : z <= 11 ? 0.6 : z <= 12 ? 0.8 : 1);

/** @param {any} ctx @param {any} s */
function drawMap(ctx, s) {
  const box = s.el.querySelector('[data-tk-map]'), leg = s.el.querySelector('[data-tk-legend]');
  if (!box || typeof L === 'undefined' || !s.stations || !s.stand) return;
  if (!s.map || s.map.getContainer() !== box) {
    s.map?.remove(); const still = reduced();
    // Start: Mitte Tokios (23 Bezirke); die rund 6.000 Ports der ganzen Präfektur überdecken sich weiter draußen
    s.map = L.map(box, { zoomAnimation: !still, fadeAnimation: !still, markerZoomAnimation: !still, preferCanvas: true }).setView([35.685, 139.755], 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: t('app.openstreetmapContributors') }).addTo(s.map);
    s.layer = L.layerGroup().addTo(s.map);
    s.map.on('zoomend', () => { const f = scaleOf(s.map.getZoom()); for (const m of s.markers || []) m.setRadius(/** @type {any} */ (m.options).r0 * f); });
  }
  s.layer.clearLayers();
  const renderer = L.canvas({ padding: 0.3 }), at = new Map(s.stand.rows.map((/** @type {any[]} */ r) => [`${r[0]}|${r[1]}`, r])), names = Object.fromEntries(s.ix.systems.map((/** @type {any} */ x) => [x.id, x.name]));
  /** @type {Record<string, number>} */
  const n = {};
  const f0 = scaleOf(s.map.getZoom()); s.markers = [];
  for (const [sys, id, lat, lon, cap, name] of s.stations.rows) {
    if (!s.on.has(sys)) continue;
    const r = at.get(`${sys}|${id}`); if (!r) continue;
    const k = fillOf(r); n[k] = (n[k] || 0) + 1;
    const tip = `<b translate="no">${ctx.esc(name || id)}</b><div>${ctx.esc(names[sys] || sys)}</div><div>${t('tk.tipBikes', { b: ctx.fmt(r[2]), d: ctx.fmt(r[3]) })}${cap ? `, ${t('tk.tipCap', { n: ctx.fmt(cap) })}` : ''}</div><div>${t(`tk.fill.${k}`)}</div>`;
    const st = fillStyle(k), m = L.circleMarker([lat, lon], /** @type {any} */ ({ renderer, ...st, radius: st.radius * f0, r0: st.radius })); // r0: Radius ab Zoom 13
    m.bindTooltip(tip, { className: 'tk-tip', sticky: true }).addTo(s.layer); s.markers.push(m);
  }
  setTimeout(() => s.map?.invalidateSize(), 0);
  if (leg) leg.innerHTML = FILL.map(k => { const f = fillStyle(k); return `<span><i style="border:2px solid ${f.color};background:${f.fillOpacity ? `color-mix(in srgb,${f.fillColor} ${Math.round(f.fillOpacity * 100)}%,transparent)` : 'transparent'}"></i>${t(`tk.fill.${k}`)} (${ctx.fmt(n[k] || 0)})</span>`; }).join('');
}

/** @param {any} ctx @param {any} s */
function draw(ctx, s) {
  const ix = s.ix, T = ix.totals, esc = ctx.esc, pct = (/** @type {number} */ a, /** @type {number} */ b) => (b ? `${ctx.fmt(a / b * 100, 0)} %` : '–');
  const out = ix.systems.reduce((/** @type {number} */ a, /** @type {any} */ x) => a + (x.today?.out || 0), 0), hrs = Math.max(0, ...ix.systems.map((/** @type {any} */ x) => (x.today?.min || 0) / 60));
  const de = germanTop(ctx.state?.latest);
  const sysRows = ix.systems.map((/** @type {any} */ x) => `<tr><th scope="row"><a href="${esc(x.url)}" rel="noopener">${esc(x.name)}</a>${x.ok ? '' : ` <span class="muted">(${t(x.stale ? 'tk.stale' : 'tk.noData')})</span>`}</th><td class="n">${ctx.fmt(x.ports)}</td><td class="n">${ctx.fmt(x.bikes)}</td><td class="n">${ctx.fmt(x.docks)}</td><td class="n">${ctx.fmt(x.empty)} <span class="muted">(${pct(x.empty, x.ports)})</span></td><td class="n">${ctx.fmt(x.full)} <span class="muted">(${pct(x.full, x.ports)})</span></td><td class="n">${ctx.fmt(x.today?.out)}</td><td><a href="${esc(x.licenseUrl)}" rel="noopener">${esc(x.license)}</a></td></tr>`).join('');
  const deRows = de.map(c => `<tr><th scope="row">${esc(c.name)}</th><td class="n">${ctx.fmt(c.bikes)}</td><td class="n">${ctx.fmt(c.ops)}</td><td>${t('tk.principleDe')}</td></tr>`).join('');
  s.el.innerHTML = `<div class="panel-head"><div><h2>${t('tk.title')}</h2><div class="sub">${t('tk.sub', { at: jst(ix.at) })}</div></div></div>
    <p>${t('tk.lead', { bikes: ctx.fmt(T.bikes), ports: ctx.fmt(T.ports), empty: pct(T.empty, T.ports), full: pct(T.full, T.ports) })}</p>
    <div class="tiles">${tile(t('tk.tPorts'), ctx.fmt(T.ports), t('tk.tPortsS', { n: ctx.fmt(ix.systems.length) }))}${tile(t('tk.tBikes'), ctx.fmt(T.bikes), t('tk.tBikesS', { d: ctx.fmt(T.docks) }))}${tile(t('tk.tEmpty'), ctx.fmt(T.empty), t('tk.tEmptyS', { p: pct(T.empty, T.ports) }))}${tile(t('tk.tFull'), ctx.fmt(T.full), t('tk.tFullS', { p: pct(T.full, T.ports) }))}${tile(t('tk.tOut'), `≥ ${ctx.fmt(out)}`, t('tk.tOutS', { h: ctx.fmt(hrs, 1) }))}</div>
    <div class="tbl" tabindex="0" role="region" aria-label="${esc(t('tk.sysTable'))}"><table><thead><tr><th>${t('tk.colSys')}</th><th class="n">${t('tk.colPorts')}</th><th class="n">${t('tk.colBikes')}</th><th class="n">${t('tk.colDocks')}</th><th class="n">${t('tk.colEmpty')}</th><th class="n">${t('tk.colFull')}</th><th class="n">${t('tk.colOut')}</th><th>${t('tk.colLicense')}</th></tr></thead><tbody>${sysRows}</tbody></table></div>
    ${deRows ? `<h3 class="cmp-h3">${t('tk.vsTitle')}</h3><div class="tbl" tabindex="0" role="region" aria-label="${esc(t('tk.vsTitle'))}"><table><thead><tr><th>${t('tk.colCity')}</th><th class="n">${t('tk.colBikesAll')}</th><th class="n">${t('tk.colOps')}</th><th>${t('tk.colPrinciple')}</th></tr></thead><tbody><tr><th scope="row">${t('tk.tokyo')}</th><td class="n">${ctx.fmt(T.bikes)}</td><td class="n">${ctx.fmt(ix.systems.length)}</td><td>${t('tk.principleTk')}</td></tr>${deRows}</tbody></table></div><p class="muted small">${t('tk.vsNote')}</p>` : ''}
    <h3 class="cmp-h3">${t('tk.dayTitle')}</h3>
    <div class="tk-sys" role="group" aria-label="${esc(t('tk.sysPick'))}">${ix.systems.map((/** @type {any} */ x) => `<button type="button" class="chip" data-tk-sys="${esc(x.id)}" aria-pressed="${s.on.has(x.id)}">${esc(x.name)}</button>`).join('')}</div>
    <div class="tk-days" role="group" aria-label="${esc(t('tk.dayPick'))}">${ix.days.slice(-7).map((/** @type {string} */ d) => `<button type="button" class="chip" data-tk-dayp="${esc(d)}" aria-pressed="${d === s.day}">${esc(dayLabel(d))}</button>`).join('')}</div>
    <div data-tk-day></div>
    <h3 class="cmp-h3">${t('tk.mapTitle')}</h3><div class="tk-map" data-tk-map role="region" aria-label="${esc(t('tk.mapAria'))}"></div><div class="tk-legend" data-tk-legend></div>
    <p class="muted small">${t('tk.sources')}</p>`;
  s.map?.remove(); s.map = null;
  drawDay(ctx, s); drawMap(ctx, s);
}

/** Panel zeichnen (Ansicht „Vergleich“, unter dem Anbieter-Vergleich) @param {HTMLElement} el @param {any} ctx */
export async function renderTokio(el, ctx) {
  if (!el) return;
  css();
  let s = S.get(el); if (!s) { s = { el, tok: 0, on: new Set(TK.TOKIO.systems.map(x => x.id)), day: null }; S.set(el, s); }
  s.ctx = ctx; const tok = ++s.tok;
  if (!s.bound) {
    s.bound = true;
    el.addEventListener('click', async (/** @type {any} */ e) => {
      const b = e.target?.closest?.('button[data-tk-sys]'), d = e.target?.closest?.('button[data-tk-dayp]');
      if (b) { const id = b.dataset.tkSys; if (s.on.has(id) && s.on.size > 1) s.on.delete(id); else s.on.add(id); for (const x of el.querySelectorAll('button[data-tk-sys]')) x.setAttribute('aria-pressed', String(s.on.has(/** @type {HTMLElement} */ (x).dataset.tkSys))); drawDay(s.ctx, s); drawMap(s.ctx, s); return; }
      if (d && d.dataset.tkDayp !== s.day) { s.day = d.dataset.tkDayp; for (const x of el.querySelectorAll('button[data-tk-dayp]')) x.setAttribute('aria-pressed', String(/** @type {HTMLElement} */ (x).dataset.tkDayp === s.day)); s.dayDoc = await load(s.ctx, `${s.day}.json`); drawDay(s.ctx, s); }
    });
  }
  if (!s.ix) el.innerHTML = `<div class="panel-head"><div><h2>${t('tk.title')}</h2></div></div><div class="empty">${t('tk.loading')}</div>`;
  const ix = await load(ctx, 'index.json');
  if (tok !== s.tok) return;
  if (!ix?.systems?.length) { el.innerHTML = `<div class="panel-head"><div><h2>${t('tk.title')}</h2></div></div><div class="empty">${t('tk.none')}</div>`; return; }
  const first = !s.day || !ix.days.includes(s.day); s.ix = ix; if (first) s.day = ix.day;
  let [dayDoc, stations, stand] = await Promise.all([load(ctx, `${s.day}.json`), load(ctx, 'stationen.json'), load(ctx, 'stand.json')]);
  // früh am Tag (Ortszeit Tokio, abends in Deutschland): zuerst den Vortag zeigen, solange heute weniger als 6 Stunden da sind
  const prev = ix.days[ix.days.indexOf(s.day) - 1];
  if (first && prev && Math.max(0, ...ix.systems.map((/** @type {any} */ x) => TK.hourly(dayDoc, x.id).length)) < 6) { s.day = prev; dayDoc = await load(ctx, `${prev}.json`); }
  if (tok !== s.tok) return;
  Object.assign(s, { dayDoc, stations, stand });
  draw(ctx, s);
}
