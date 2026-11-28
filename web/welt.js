// Mobility Pulse — Reiter „Länder“ (Auswerten › Länder, Stufe 1, 28.11.2026): Sharing in Europa und Japan neben Deutschland.
// Überblick aller Länder (Deutschland aus latest.json), Auswahl eines Landes mit Kennzahlen, Städten, Anbietern, Systemen, Stundenkurven in Ortszeit
// und Karte (Stationen nach Füllstand, frei abgestellte Fahrzeuge je Zelle); bei Japan zusätzlich Tokio im Detail (web/tokio.js).
// Daten: welt/index.json und welt/<Land>/*.json (Phase „welt“ des Sammlers, scripts/welt.mjs, lib/pulse-welt.js). Werte aus Daten gehen durch ctx.esc.
// Eigenständig: renderWelt(el, ctx), ctx = { state, CFG, esc, fmt, getJson }; Leaflet (L) global.
import * as WL from './pulse-welt.js';
import { VEHICLE_TYPE_LABEL } from './pulse-core.js';
import { t, tMap, lang, dateFmt } from './i18n.js';
import { css as tkCss, reduced, hourChart, fillStyle, FILL, scaleOf, renderTokio } from './tokio.js';
import { seriesColor } from './tokens.js';

const TYPE = tMap('type', VEHICLE_TYPE_LABEL);
const S = new WeakMap();
const STYLE = `
.wl-pick{display:flex;flex-wrap:wrap;gap:var(--s2) var(--s3);align-items:center;margin:0 0 var(--s3)}
.wl-pick label{font-size:.75rem;color:var(--fg-2);display:inline-flex;gap:6px;align-items:center}
.wl-ov tbody tr.on th,.wl-ov tbody tr.on td{background:color-mix(in srgb,var(--accent) 9%,transparent)}
.wl-ov button.wl-land{all:unset;cursor:pointer;font-weight:500;color:var(--fg);border-radius:4px}.wl-ov button.wl-land:hover{text-decoration:underline}.wl-ov button.wl-land:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.wl-sec{margin-top:var(--s5)}
.wl-days{display:flex;flex-wrap:wrap;gap:6px;margin:var(--s2) 0 var(--s3)}
.wl-err{color:var(--muted);font-size:.75rem}
`;
let cssDone = false;
const css = () => { tkCss(); if (cssDone || typeof document === 'undefined') return; cssDone = true; const s = document.createElement('style'); s.textContent = STYLE; document.head.appendChild(s); };
const cname = (/** @type {string} */ cc) => { try { return new Intl.DisplayNames([lang()], { type: 'region' }).of(cc) || cc; } catch { return cc; } };
const at = (/** @type {number} */ ms, /** @type {string} */ tz) => (ms ? dateFmt({ dateStyle: 'medium', timeStyle: 'short', timeZone: tz || 'Europe/Berlin' }).format(new Date(ms)) : '–');
const dayLabel = (/** @type {string} */ d) => dateFmt({ weekday: 'short', day: 'numeric', month: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`));
const tile = (/** @type {string} */ l, /** @type {string} */ v, /** @type {string} */ s) => `<div class="tile"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
/** @param {any} ctx @param {string} f */
const load = async (ctx, f) => { try { const r = await ctx.getJson(`${ctx.CFG.DATA}welt/${f}`, { timeout: 90000 }); return r?.ok && r.json ? r.json : null; } catch { return null; } };
const typesText = (/** @type {any} */ ctx, /** @type {Record<string, number>} */ ty) => Object.entries(ty || {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${TYPE[k] || k} ${ctx.fmt(n)}`).join(', ') || '–';

/** Deutschland aus latest.json (eigener Sammler) für den Überblick @param {any} latest */
function germany(latest) {
  if (!latest?.totals) return null;
  let avail = 0; /** @type {Record<string, number>} */ const types = {};
  for (const [ty, v] of Object.entries(latest.totals)) { const n = /** @type {any} */ (v)?.available; if (Number.isFinite(n)) { avail += n; types[ty] = n; } }
  const ops = new Set(), munis = Object.values(latest.municipalities || {});
  for (const m of munis) for (const o of Object.keys(/** @type {any} */ (m).operators || {})) ops.add(o);
  return { land: 'DE', avail, types, cities: munis.filter((/** @type {any} */ m) => Object.keys(m.operators || {}).length).length, ops: ops.size, at: latest.at || Date.parse(latest.generatedAt || '') || null, tz: 'Europe/Berlin' };
}

/** @param {any} ctx @param {any} s */
function overview(ctx, s) {
  const esc = ctx.esc, de = germany(ctx.state?.latest);
  const rows = [...(de ? [de] : []), ...s.ix.countries.filter((/** @type {any} */ c) => c.at)].sort((a, b) => (b.avail || 0) - (a.avail || 0));
  const tr = (/** @type {any} */ c) => `<tr class="${c.land === s.land ? 'on' : ''}"><th scope="row"><button type="button" class="wl-land" data-wl-land="${esc(c.land)}" aria-pressed="${c.land === s.land}">${esc(cname(c.land))}</button></th><td class="n">${ctx.fmt(c.avail)}</td><td>${esc(typesText(ctx, c.types))}</td><td class="n">${ctx.fmt(c.cities)}</td><td class="n">${ctx.fmt(c.ops)}</td><td class="n">${c.land === 'DE' ? '–' : `${ctx.fmt(c.ok)} / ${ctx.fmt(c.listed)}`}</td><td class="n">${c.land === 'DE' ? '–' : `≥ ${ctx.fmt(c.today?.out || 0)}`}</td><td>${esc(at(c.at, c.tz))}</td></tr>`;
  return `<h3 class="cmp-h3">${t('wl.ovTitle')}</h3><div class="tbl wl-ov" tabindex="0" role="region" aria-label="${esc(t('wl.ovTitle'))}"><table><thead><tr><th>${t('wl.colLand')}</th><th class="n">${t('wl.colAvail')}</th><th>${t('wl.colTypes')}</th><th class="n">${t('wl.colCities')}</th><th class="n">${t('wl.colOps')}</th><th class="n">${t('wl.colSystems')}</th><th class="n">${t('wl.colOut')}</th><th>${t('wl.colAt')}</th></tr></thead><tbody>${rows.map(tr).join('')}</tbody></table></div><p class="muted small">${t('wl.ovNote')}</p>`;
}

/** Anbieter eines Landes aus den Systemen @param {any[][]} systems */
function operators(systems) {
  /** @type {Map<string, any>} */
  const m = new Map();
  for (const r of systems) {
    let o = m.get(r[3]); if (!o) m.set(r[3], o = { op: r[3], systems: 0, ok: 0, avail: 0, stations: 0, cities: new Set(), types: {}, lic: new Set() });
    o.systems++; if (r[4]) o.ok++; o.avail += r[5] || 0; o.stations += r[7] || 0; if (r[2]) o.cities.add(r[2]); if (r[11]) o.lic.add(r[11]);
    for (const [k, n] of Object.entries(r[10] || {})) o.types[k] = (o.types[k] || 0) + /** @type {number} */ (n);
  }
  return [...m.values()].sort((a, b) => b.avail - a.avail);
}

/** @param {any} ctx @param {any} s */
function detail(ctx, s) {
  const esc = ctx.esc, d = s.doc, T = d.totals, name = cname(d.land), pct = (/** @type {number} */ a, /** @type {number} */ b) => (b ? `${ctx.fmt(a / b * 100, 0)} %` : '–');
  const ops = operators(d.systems), cities = d.cities || [];
  const lead = t('wl.lead', { land: esc(name), avail: ctx.fmt(T.avail), cities: ctx.fmt(cities.filter((/** @type {any[]} */ c) => c[2] > 0).length), ops: ctx.fmt(ops.filter(o => o.avail > 0).length), stations: ctx.fmt(T.stations), empty: pct(T.empty, T.stations) });
  const tiles = tile(t('wl.tAvail'), ctx.fmt(T.avail), esc(typesText(ctx, T.types))) + tile(t('wl.tCities'), ctx.fmt(cities.filter((/** @type {any[]} */ c) => c[2] > 0).length), t('wl.tCitiesS', { ops: ctx.fmt(ops.length) }))
    + tile(t('wl.tStations'), ctx.fmt(T.stations), t('wl.tStationsS', { e: pct(T.empty, T.stations), f: pct(T.full, T.stations) })) + tile(t('wl.tOut'), `≥ ${ctx.fmt(d.today?.out || 0)}`, t('wl.tOutS', { h: ctx.fmt((d.today?.min || 0) / 60, 1) }))
    + tile(t('wl.tSystems'), `${ctx.fmt(d.ok)} <small>/ ${ctx.fmt(d.systemsListed)}</small>`, t('wl.tSystemsS', { f: ctx.fmt(d.failed), s: ctx.fmt(d.skipped || 0) }));
  const cityRows = cities.slice(0, s.allCities ? Infinity : 25).map((/** @type {any[]} */ c) => `<tr><th scope="row">${esc(c[0])}</th><td class="n">${ctx.fmt(c[2])}</td><td>${esc(typesText(ctx, c[5]))}</td><td class="n">${ctx.fmt(c[3])}</td><td>${esc((c[4] || []).join(', '))}</td></tr>`).join('');
  const opRows = ops.map(o => `<tr><th scope="row">${esc(o.op)}</th><td class="n">${ctx.fmt(o.avail)}</td><td>${esc(typesText(ctx, o.types))}</td><td class="n">${ctx.fmt(o.stations)}</td><td class="n">${ctx.fmt(o.cities.size)}</td><td class="n">${ctx.fmt(o.ok)} / ${ctx.fmt(o.systems)}</td><td>${esc([...o.lic].join(', ') || t('wl.noLicense'))}</td></tr>`).join('');
  const sysRows = d.systems.map((/** @type {any[]} */ r) => `<tr><th scope="row">${esc(r[1])}</th><td>${esc(r[2])}</td><td>${esc(r[3])}</td><td class="n">${ctx.fmt(r[5])}</td><td class="n">${ctx.fmt(r[7])}</td><td>${r[12] ? `<a href="${esc(r[12])}" rel="noopener">${esc(r[11] || t('wl.license'))}</a>` : esc(r[11] || '–')}</td><td>${r[4] ? t('wl.sysOk') : `<span class="wl-err">${esc(r[14] || t('wl.sysFail'))}</span>`}</td></tr>`).join('');
  return `<div class="panel-head"><div><h2>${t('wl.title', { land: esc(name) })}</h2><div class="sub">${t('wl.sub', { at: esc(at(d.at, d.tz)), tz: esc(d.tz) })}</div></div></div>
    <p>${lead}</p><div class="tiles">${tiles}</div>
    <div class="wl-sec"><h3 class="cmp-h3">${t('wl.citiesTitle')}</h3><div class="tbl" tabindex="0" role="region" aria-label="${esc(t('wl.citiesTitle'))}"><table><thead><tr><th>${t('wl.colCity')}</th><th class="n">${t('wl.colAvail')}</th><th>${t('wl.colTypes')}</th><th class="n">${t('wl.colStations')}</th><th>${t('wl.colOps')}</th></tr></thead><tbody>${cityRows}</tbody></table></div>
    ${cities.length > 25 && !s.allCities ? `<button type="button" class="chip" data-wl-act="cities">${t('wl.allCities', { n: ctx.fmt(cities.length) })}</button>` : ''}</div>
    <div class="wl-sec"><h3 class="cmp-h3">${t('wl.opsTitle')}</h3><div class="tbl" tabindex="0" role="region" aria-label="${esc(t('wl.opsTitle'))}"><table><thead><tr><th>${t('wl.colOp')}</th><th class="n">${t('wl.colAvail')}</th><th>${t('wl.colTypes')}</th><th class="n">${t('wl.colStations')}</th><th class="n">${t('wl.colCities')}</th><th class="n">${t('wl.colSystems')}</th><th>${t('wl.colLicense')}</th></tr></thead><tbody>${opRows}</tbody></table></div></div>
    <div class="wl-sec"><h3 class="cmp-h3">${t('wl.dayTitle')}</h3><div class="wl-days" role="group" aria-label="${esc(t('wl.dayPick'))}">${(d.days || []).slice(-7).map((/** @type {string} */ x) => `<button type="button" class="chip" data-wl-day="${esc(x)}" aria-pressed="${x === s.day}">${esc(dayLabel(x))}</button>`).join('')}</div><div data-wl-chart></div></div>
    <div class="wl-sec"><h3 class="cmp-h3">${t('wl.mapTitle')}</h3><div class="tk-map" data-wl-map role="region" aria-label="${esc(t('wl.mapAria', { land: name }))}"></div><div class="tk-legend" data-wl-legend></div></div>
    <details class="more wl-sec"><summary>${t('wl.sysTitle', { n: ctx.fmt(d.systems.length) })}</summary><div class="tbl" tabindex="0" role="region" aria-label="${esc(t('wl.sysTitle', { n: d.systems.length }))}"><table><thead><tr><th>${t('wl.colSystem')}</th><th>${t('wl.colCity')}</th><th>${t('wl.colOp')}</th><th class="n">${t('wl.colAvail')}</th><th class="n">${t('wl.colStations')}</th><th>${t('wl.colLicense')}</th><th>${t('wl.colState')}</th></tr></thead><tbody>${sysRows}</tbody></table></div></details>
    ${d.land === 'JP' ? '<div class="wl-sec panel-2" data-wl-tokio></div>' : ''}
    <p class="muted small">${t('wl.sources')}</p>`;
}

/** @param {any} ctx @param {any} s */
function drawChart(ctx, s) {
  const box = s.el.querySelector('[data-wl-chart]'); if (!box) return;
  const hs = WL.hourly(s.dayDoc), tz = s.doc?.tz || '';
  if (!hs.length) { box.innerHTML = `<div class="empty">${t('tk.noHours')}</div>`; return; }
  const one = (/** @type {(r: any) => number|null} */ f) => [{ label: cname(s.land), i: 0, pts: hs.map(r => ({ h: r.h, v: f(r) })) }];
  box.innerHTML = `<div class="tk-charts"><div><h3>${t('wl.chartAvail')}</h3>${hourChart(ctx, one(r => Math.round(r.avail)), (v) => ctx.fmt(v), t('wl.chartAvail'), t('wl.localTime', { tz }))}</div>
    <div><h3>${t('wl.chartOut')}</h3>${hourChart(ctx, one(r => (r.outH == null ? null : Math.round(r.outH))), (v) => ctx.fmt(v), t('wl.chartOut'), t('wl.localTime', { tz }))}</div></div><p class="muted small">${t('wl.outNote')}</p>`;
}

/** @param {any} ctx @param {any} s */
function drawMap(ctx, s) {
  const box = s.el.querySelector('[data-wl-map]'), leg = s.el.querySelector('[data-wl-legend]'), P = s.pts;
  if (!box || typeof L === 'undefined' || !P) return;
  s.map?.remove(); const still = reduced();
  s.map = L.map(box, { zoomAnimation: !still, fadeAnimation: !still, markerZoomAnimation: !still, preferCanvas: true });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: t('app.openstreetmapContributors') }).addTo(s.map);
  const renderer = L.canvas({ padding: 0.3 }), layer = L.layerGroup().addTo(s.map), ff = seriesColor(1);
  /** @type {any[]} */
  const marks = [];
  /** @type {Array<[number, number]>} */
  const pts = [];
  /** @type {Record<string, number>} */
  const n = {};
  for (const [lat, lon, c] of P.cells || []) {
    const r0 = Math.min(9, 2.5 + Math.sqrt(c)), m = L.circleMarker([lat, lon], /** @type {any} */ ({ renderer, radius: r0, r0, color: ff, weight: 0, fillColor: ff, fillOpacity: 0.55 }));
    m.bindTooltip(t('wl.cellTip', { n: ctx.fmt(c) }), { className: 'tk-tip', sticky: true }).addTo(layer); marks.push(m); pts.push([lat, lon]);
  }
  for (const [, lat, lon, b, d, z] of P.stations || []) {
    const k = z & 1 ? 'off' : b === 0 ? 'empty' : d === 0 ? 'full' : d < 0 ? 'mid' : b / (b + d) < 1 / 3 ? 'low' : b / (b + d) < 2 / 3 ? 'mid' : 'high'; n[k] = (n[k] || 0) + 1;
    const st = fillStyle(k), m = L.circleMarker([lat, lon], /** @type {any} */ ({ renderer, ...st, r0: st.radius }));
    m.bindTooltip(`${t('wl.tipStation', { b: ctx.fmt(b), d: d < 0 ? '–' : ctx.fmt(d) })}<div>${t(`tk.fill.${k}`)}</div>`, { className: 'tk-tip', sticky: true }).addTo(layer); marks.push(m); pts.push([lat, lon]);
  }
  const rescale = () => { const f = scaleOf(s.map.getZoom()); for (const m of marks) m.setRadius(m.options.r0 * f); };
  s.map.on('zoomend', rescale);
  if (pts.length) s.map.fitBounds(L.latLngBounds(pts), { padding: [20, 20], maxZoom: 13, animate: false }); else s.map.setView([50, 10], 4);
  rescale(); setTimeout(() => s.map?.invalidateSize(), 0);
  const nCells = (P.cells || []).reduce((/** @type {number} */ a, /** @type {number[]} */ c) => a + c[2], 0);
  if (leg) leg.innerHTML = (nCells ? `<span><i style="background:color-mix(in srgb,${ff} 55%,transparent);border:0"></i>${t('wl.legendCells', { n: ctx.fmt(nCells) })}</span>` : '')
    + FILL.filter(k => n[k]).map(k => { const f = fillStyle(k); return `<span><i style="border:2px solid ${f.color};background:${f.fillOpacity ? `color-mix(in srgb,${f.fillColor} ${Math.round(f.fillOpacity * 100)}%,transparent)` : 'transparent'}"></i>${t('wl.legendStations', { k: t(`tk.fill.${k}`) })} (${ctx.fmt(n[k])})</span>`; }).join('');
}

/** Land wählen und zeichnen @param {any} ctx @param {any} s @param {string} cc */
async function pick(ctx, s, cc) {
  s.land = cc; try { localStorage.setItem('mp-land', cc); } catch { /* ohne Speicher */ }
  const tok = ++s.tok, box = s.el.querySelector('[data-wl-detail]');
  for (const b of s.el.querySelectorAll('button[data-wl-land]')) { const on = /** @type {HTMLElement} */ (b).dataset.wlLand === cc; b.setAttribute('aria-pressed', String(on)); b.closest('tr')?.classList.toggle('on', on); }
  const sel = /** @type {HTMLSelectElement|null} */ (s.el.querySelector('select[data-wl-sel]')); if (sel) sel.value = cc;
  if (cc === 'DE') { s.map?.remove(); s.map = null; box.innerHTML = `<div class="panel-head"><div><h2>${t('wl.deTitle')}</h2></div></div><p>${t('wl.deText')}</p><p><a href="#live">${t('wl.deLive')}</a> · <a href="#vergleich">${t('wl.deCompare')}</a> · <a href="#prognose">${t('wl.deForecast')}</a> · <a href="#oepnv">${t('wl.deOepnv')}</a></p>`; return; }
  box.innerHTML = `<div class="empty">${t('wl.loading')}</div>`;
  const doc = await load(ctx, `${cc}/latest.json`); if (tok !== s.tok) return;
  if (!doc) { box.innerHTML = `<div class="empty">${t('wl.noLand')}</div>`; return; }
  s.doc = doc; s.allCities = false;
  s.day = doc.days?.includes(doc.day) ? doc.day : doc.days?.[doc.days.length - 1] || doc.day;
  const [dayDoc, pts] = await Promise.all([load(ctx, `${cc}/${s.day}.json`), load(ctx, `${cc}/punkte.json`)]); if (tok !== s.tok) return;
  // früh am Tag (Ortszeit): zuerst der Vortag, solange heute weniger als 6 Stunden da sind
  const prev = doc.days?.[doc.days.indexOf(s.day) - 1];
  Object.assign(s, { dayDoc, pts });
  if (prev && WL.hourly(dayDoc).length < 6) { s.day = prev; s.dayDoc = await load(ctx, `${cc}/${prev}.json`); if (tok !== s.tok) return; }
  s.map?.remove(); s.map = null;
  box.innerHTML = detail(ctx, s);
  drawChart(ctx, s); drawMap(ctx, s);
  const tk = box.querySelector('[data-wl-tokio]'); if (tk) renderTokio(/** @type {HTMLElement} */ (tk), ctx);
}

/** Panel zeichnen (Ansicht „Länder“) @param {HTMLElement} el @param {any} ctx */
export async function renderWelt(el, ctx) {
  if (!el) return;
  css();
  let s = S.get(el); if (!s) { s = { el, tok: 0 }; S.set(el, s); }
  s.ctx = ctx;
  if (!s.bound) {
    s.bound = true;
    el.addEventListener('click', async (/** @type {any} */ e) => {
      const b = e.target?.closest?.('button[data-wl-land]'); if (b) { pick(s.ctx, s, b.dataset.wlLand); return; }
      const a = e.target?.closest?.('button[data-wl-act]'); if (a?.dataset.wlAct === 'cities') { s.allCities = true; const y = window.scrollY; const box = el.querySelector('[data-wl-detail]'); s.map?.remove(); s.map = null; box.innerHTML = detail(s.ctx, s); drawChart(s.ctx, s); drawMap(s.ctx, s); const tk = box.querySelector('[data-wl-tokio]'); if (tk) renderTokio(/** @type {HTMLElement} */ (tk), s.ctx); window.scrollTo(0, y); return; }
      const d = e.target?.closest?.('button[data-wl-day]');
      if (d && d.dataset.wlDay !== s.day) { s.day = d.dataset.wlDay; for (const x of el.querySelectorAll('button[data-wl-day]')) x.setAttribute('aria-pressed', String(/** @type {HTMLElement} */ (x).dataset.wlDay === s.day)); s.dayDoc = await load(s.ctx, `${s.land}/${s.day}.json`); drawChart(s.ctx, s); }
    });
    el.addEventListener('change', (/** @type {any} */ e) => { if (e.target?.matches?.('select[data-wl-sel]')) pick(s.ctx, s, e.target.value); });
  }
  if (!s.ix) el.innerHTML = `<div class="empty">${t('wl.loading')}</div>`;
  const ix = await load(ctx, 'index.json');
  if (!ix?.countries?.length) { el.innerHTML = `<div class="panel"><div class="panel-head"><div><h2>${t('wl.ovTitle')}</h2></div></div><div class="empty">${t('wl.none')}</div></div>`; return; }
  s.ix = ix;
  const have = ix.countries.filter((/** @type {any} */ c) => c.at).map((/** @type {any} */ c) => c.land);
  let want = null; try { want = new URLSearchParams(location.search).get('land')?.toUpperCase() || localStorage.getItem('mp-land'); } catch { want = null; }
  if (!want || !(want === 'DE' || have.includes(want))) want = [...ix.countries].filter((/** @type {any} */ c) => c.at).sort((a, b) => (b.avail || 0) - (a.avail || 0))[0]?.land || 'DE';
  const opts = [['eu', t('wl.europe')], ['jp', t('wl.japan')]].map(([r, lbl]) => `<optgroup label="${ctx.esc(lbl)}">${[...(r === 'eu' ? ['DE'] : []), ...have.filter((/** @type {string} */ c) => WL.regionOf(c) === r)].sort((a, b) => cname(a).localeCompare(cname(b), lang())).map(c => `<option value="${ctx.esc(c)}">${ctx.esc(cname(c))}</option>`).join('')}</optgroup>`).join('');
  el.innerHTML = `<div class="panel"><div class="wl-pick"><label>${t('wl.pick')} <select data-wl-sel>${opts}</select></label><span class="muted small">${t('wl.pickNote', { n: ctx.fmt(have.length + 1) })}</span></div>${overview(ctx, s)}</div><div class="panel wl-sec" data-wl-detail></div>`;
  await pick(ctx, s, want);
}
