// @ts-check
// Mobility Pulse — Zonen-Werkbank (S6.1, F4): GBFS-Zonen eines Anbieters in der Gemeinde prüfen (Überlappungen, Lücken, Taschen, Spots im
// Verbot, Verbotszonen ohne OSM-Grund, Änderungsverlauf) und je Kategorie im Backend-Format exportieren (Upload-Prüfung vor dem Herunterladen).
// renderZonen(el, ctx), ctx = rpCtx(). Daten: zones/index.json, zones/<Datei>.json, zones-log.json, ops-input/fleet/<AGS>.json (Stationen),
// Gemeindegrenze aus boundaries/<Land>.json (Export auf die Gemeinde zugeschnitten). OSM-Gründe auf Knopfdruck über Overpass.
import * as Z from './pulse-zones.js';
import { decodeFleet } from './pulse-ops.js';
import { t, dateFmt } from './i18n.js';
import { clearAnswer, putAnswer } from './answer.js';

const cache = new Map(), S = { map: null, layers: null, run: 0, res: null, zones: null, spots: [], own: [], reasons: null, ags: null, op: null };
const load = (ctx, url, timeout = 60000) => { if (!cache.has(url)) cache.set(url, ctx.getJson(url, { timeout }).then(r => (r?.ok ? r.json : null)).catch(() => null)); return cache.get(url); };
const tok = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#888';
const KCOL = { no_ride: '--bad', no_park: '--warn', mandatory: '--info', allowed: '--ok' };
const KLBL = () => ({ no_ride: t('zw.kNoRide'), no_park: t('zw.kNoPark'), mandatory: t('zw.kMandatory'), allowed: t('zw.kAllowed') });
let cssDone = false;
function css() {
  if (cssDone) return; cssDone = true;
  const s = document.createElement('style'); s.textContent = `
.zw-grid{display:grid;grid-template-columns:minmax(0,7fr) minmax(0,5fr);gap:var(--s4)}@media (max-width:980px){.zw-grid{grid-template-columns:minmax(0,1fr)}}
#zw-map{height:520px;border-radius:var(--r-sm);border:1px solid var(--line);background:var(--bg-2)}.zw-list{max-height:520px;overflow:auto}
.zw-k{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:0}.zw-ex{display:grid;gap:var(--s2)}.zw-ex .row{display:flex;flex-wrap:wrap;gap:var(--s2);align-items:center}
.zw-ok{color:var(--ok)}.zw-bad{color:var(--bad)}`;
  document.head.appendChild(s);
}
const dayTxt = (ms) => dateFmt({ dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Berlin' }).format(new Date(ms));
const osmAt = (p) => `https://www.openstreetmap.org/?mlat=${p[1].toFixed(5)}&mlon=${p[0].toFixed(5)}#map=19/${p[1].toFixed(5)}/${p[0].toFixed(5)}`;

export async function renderZonen(el, ctx) {
  css();
  const ags = ctx.state.scope, run = ++S.run;
  if (!ags || ags === 'DE') { clearAnswer(el); el.innerHTML = `<div class="panel"><div class="empty">${t('zw.pickCity')}</div></div>`; return; }
  el.innerHTML = `<div class="panel"><p class="muted">${t('zw.loading')}</p></div>`;
  const idx = await load(ctx, `${ctx.CFG.DATA}zones/index.json`); if (run !== S.run) return;
  const mine = (idx?.zones || []).filter(z => (z.municipalities || []).includes(ags)), ops = [...new Set(mine.map(z => z.operator))].sort();
  if (!ops.length) {
    putAnswer(el, { id: 'zonen', sentence: t('zw.answerNone', { name: ctx.esc(ctx.muniName(ags)) }), kpis: [{ label: t('zw.kpiOverlaps'), value: '–' }, { label: t('zw.kpiGaps'), value: '–' }, { label: t('zw.kpiSpots'), value: '–' }], how: t('zw.how') });
    const withZones = [...new Set((idx?.zones || []).flatMap(z => z.municipalities || []))].filter(a => ctx.state.latest?.municipalities?.[a]).sort((a, b) => (ctx.state.latest.municipalities[b].available || 0) - (ctx.state.latest.municipalities[a].available || 0)).slice(0, 12);
    el.innerHTML = `<div class="panel"><div class="empty"><p>${t('zw.noZones', { name: ctx.esc(ctx.muniName(ags)) })}</p>${withZones.map(a => `<button type="button" class="chip" data-ags="${ctx.esc(a)}">${ctx.esc(ctx.muniName(a))}</button>`).join(' ')}</div></div>`;
    el.querySelectorAll('button[data-ags]').forEach(b => b.addEventListener('click', () => ctx.setScope?.(b.getAttribute('data-ags'))));
    return;
  }
  const want = new URLSearchParams(location.search).get('zop');
  const op = ops.includes(S.op) && S.ags === ags ? S.op : ops.includes(want) ? want : ops.sort((a, b) => mine.filter(z => z.operator === b).length - mine.filter(z => z.operator === a).length)[0];
  S.ags = ags; S.op = op;
  const st = ctx.state.latest?.municipalities?.[ags]?.state;
  const [docs, log, fleetDoc, bd] = await Promise.all([Promise.all(mine.filter(z => z.operator === op).map(z => load(ctx, `${ctx.CFG.DATA}zones/${z.file}`))), load(ctx, `${ctx.CFG.DATA}zones-log.json`), load(ctx, `${ctx.CFG.DATA}ops-input/fleet/${ags}.json`), st ? load(ctx, `${ctx.CFG.DATA}boundaries/${st}.json`, 90000) : null]);
  if (run !== S.run) return;
  const muni = bd?.features?.find(f => f.properties?.ags === ags)?.geometry || null, bbox = muni ? Z.bboxOf(muni) : null;
  const zones = Z.zonesFor(docs.filter(Boolean), { operator: op, bbox });
  S.zones = zones; S.muni = muni;
  S.spots = fleetDoc ? decodeFleet(fleetDoc).stations.filter(s => s.operator === op).map(s => ({ lat: s.lat, lon: s.lon, name: s.name || t('zw.station'), src: t('zw.srcStation') })) : [];
  if (S.reasonsFor !== `${ags}|${op}`) { S.reasons = null; S.reasonsFor = null; }
  el.innerHTML = `<div class="panel"><div class="panel-head"><div><h2>${t('zw.title', { op: ctx.esc(op), name: ctx.esc(ctx.muniName(ags)) })}</h2><div class="sub">${t('zw.sub', { n: ctx.fmt(zones.length), files: ctx.fmt(docs.filter(Boolean).length) })}</div></div>
      <form class="inline-form" id="zw-form" novalidate><label>${t('zw.operator')}<select id="zw-op">${ops.map(o => `<option${o === op ? ' selected' : ''}>${ctx.esc(o)}</option>`).join('')}</select></label>
      <label>${t('zw.ownSpots')}<input type="file" id="zw-csv" accept=".csv,text/csv"></label><button type="button" id="zw-osm">${t('zw.osmRun')}</button></form></div>
    <p class="muted small" id="zw-status" role="status"></p>
    <div class="zw-grid"><div id="zw-map" role="region" aria-label="${ctx.esc(t('zw.mapLabel'))}"></div><div class="zw-list"><div class="tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('zw.findings'))}"><table id="zw-find"><thead><tr><th>${t('zw.check')}</th><th>${t('zw.detail')}</th><th>${t('zw.where')}</th></tr></thead><tbody></tbody></table></div></div></div></div>
    <div class="panel"><div class="panel-head"><div><h2>${t('zw.exportTitle')}</h2><div class="sub">${t('zw.exportSub')}</div></div>
      <div class="inline-form"><label class="chk"><input type="checkbox" id="zw-bike"> ${t('zw.withBicycle')}</label></div></div><div class="zw-ex" id="zw-ex"></div></div>
    <div class="panel"><div class="panel-head"><div><h2>${t('zw.historyTitle')}</h2><div class="sub">${t('zw.historySub')}</div></div></div><div class="tbl"><table id="zw-hist"><thead><tr><th>${t('zw.when')}</th><th>${t('zw.source')}</th><th class="n">${t('zw.added')}</th><th class="n">${t('zw.removed')}</th><th class="n">${t('zw.count')}</th></tr></thead><tbody></tbody></table></div></div>`;
  el.querySelector('#zw-op').addEventListener('change', (e) => { S.op = /** @type {HTMLSelectElement} */ (e.target).value; renderZonen(el, ctx); });
  el.querySelector('#zw-csv').addEventListener('change', async (e) => { const f = /** @type {HTMLInputElement} */ (e.target).files?.[0]; if (!f) return; S.own = parseSpotsCsv(await f.text()); audit(el, ctx, log); });
  el.querySelector('#zw-osm').addEventListener('click', () => osmReasons(el, ctx, log));
  el.querySelector('#zw-bike').addEventListener('change', () => renderExport(el, ctx));
  el.querySelector('#zw-find').addEventListener('click', (e) => { const b = /** @type {HTMLElement} */ (e.target).closest('[data-fly]'); if (b && S.map) { const [x, y] = b.getAttribute('data-fly').split(',').map(Number); S.map.setView([y, x], 18); } });
  drawMap(el);
  await audit(el, ctx, log);
}

/** eigene Spots-CSV (Spalten lat und lng/lon, optional name; Komma oder Semikolon) */
export function parseSpotsCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter(l => l.trim()); if (lines.length < 2) return [];
  const sep = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ';' : ',', head = lines[0].split(sep).map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());
  const iLat = head.findIndex(h => h === 'lat' || h === 'latitude'), iLon = head.findIndex(h => h === 'lng' || h === 'lon' || h === 'longitude'), iName = head.findIndex(h => h === 'name');
  if (iLat < 0 || iLon < 0) return [];
  return lines.slice(1).map(l => l.split(sep).map(c => c.trim().replace(/^"|"$/g, ''))).map(c => ({ lat: +c[iLat], lon: +c[iLon], name: iName >= 0 ? c[iName] : '', src: 'CSV' })).filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lon) && Math.abs(s.lat) <= 90);
}

async function audit(el, ctx, log) {
  const status = el.querySelector('#zw-status'); status.textContent = t('zw.checking');
  await new Promise(r => setTimeout(r, 0));
  const spots = [...S.spots, ...S.own], res = Z.auditZones(S.zones, { spots, reasons: S.reasons, log });
  S.res = res; const f = ctx.fmt, c = res.counts;
  status.textContent = t('zw.status', { spots: f(spots.length), own: f(S.own.length), osm: S.reasons ? t('zw.osmDone', { n: f(S.reasons.length) }) : t('zw.osmNot') });
  putAnswer(el, { id: 'zonen', sentence: t('zw.answer', { op: ctx.esc(S.op), name: ctx.esc(ctx.muniName(S.ags)), n: f(c.zones), ov: f(c.overlaps), gaps: f(c.gaps + c.pockets), spots: f(c.spotsInBan) }),
    kpis: [{ label: t('zw.kpiOverlaps'), value: f(c.overlaps), tone: c.overlaps ? 'warn' : 'ok', cmp: t('zw.kpiOverlapsCmp') }, { label: t('zw.kpiGaps'), value: f(c.gaps + c.pockets), tone: c.gaps + c.pockets ? 'warn' : 'ok', cmp: t('zw.kpiGapsCmp', { g: f(c.gaps), p: f(c.pockets) }) },
      { label: t('zw.kpiSpots'), value: f(c.spotsInBan), tone: c.spotsInBan ? 'bad' : 'ok', cmp: t('zw.kpiSpotsCmp', { n: f(c.spots) }) }], how: t('zw.how'), asOf: null });
  const rows = [
    ...res.overlaps.map(o => [t('zw.fOverlap'), `${KLBL()[o.kind]}: ${ctx.esc(o.names.filter(Boolean).join(' / ') || '–')}, ${f(o.areaM2)} m²`, o.at]),
    ...res.gaps.map(o => [t('zw.fGap'), `${KLBL()[o.kind]}: ${f(o.gapM, 2)} m`, o.at]),
    ...res.pockets.map(o => [t('zw.fPocket'), `${KLBL()[o.kind]}: ${f(o.areaM2)} m²`, o.at]),
    ...res.spotsInBan.map(o => [t('zw.fSpot'), `${ctx.esc(o.name || '–')} (${ctx.esc(o.src || '')}) – ${KLBL()[o.kind]}${o.zoneName ? ` „${ctx.esc(o.zoneName)}“` : ''}`, [o.lon, o.lat]]),
    ...(res.banNoReason || []).map(o => [t('zw.fNoReason'), `${KLBL()[o.kind]}${o.name ? ` „${ctx.esc(o.name)}“` : ''}, ${f(o.areaM2)} m²`, o.at]),
  ];
  el.querySelector('#zw-find tbody').innerHTML = rows.length ? rows.slice(0, 400).map(([k, d, at]) => `<tr><td>${k}</td><td>${d}</td><td>${at ? `<button type="button" class="chip" data-fly="${at[0]},${at[1]}">${t('zw.onMap')}</button> <a href="${osmAt(at)}" target="_blank" rel="noopener">OSM ↗</a>` : ''}</td></tr>`).join('')
    : `<tr><td colspan="3" class="empty">${t('zw.noFindings')}</td></tr>`;
  el.querySelector('#zw-hist tbody').innerHTML = res.history.length ? res.history.slice(0, 60).map(h => `<tr><td>${dayTxt(h.at)}</td><td>${ctx.esc(h.source)}</td><td class="n">${f(h.added)}</td><td class="n">${f(h.removed)}</td><td class="n">${f(h.count)}</td></tr>`).join('') : `<tr><td colspan="5" class="empty">${t('zw.noHistory')}</td></tr>`;
  drawFindings(); renderExport(el, ctx);
}

function drawMap(el) {
  const box = el.querySelector('#zw-map'); if (!box || typeof L === 'undefined') return;
  S.map?.remove(); S.map = L.map(box, { preferCanvas: true });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: t('app.openstreetmapContributors') }).addTo(S.map);
  S.layers = { zones: L.layerGroup().addTo(S.map), find: L.layerGroup().addTo(S.map) };
  for (const z of S.zones) { if (z.area > Z.AUDIT.maxExportM2) continue; L.geoJSON(z.geometry, { style: { color: tok(KCOL[z.kind]), weight: 1, fillOpacity: z.kind === 'allowed' ? 0.05 : 0.22 } }).bindTooltip(`${KLBL()[z.kind]}${z.name ? `: ${z.name}` : ''}`).addTo(S.layers.zones); }
  const pts = S.zones.filter(z => z.area <= Z.AUDIT.maxExportM2).flatMap(z => [[z.bbox[1], z.bbox[0]], [z.bbox[3], z.bbox[2]]]);
  if (pts.length) S.map.fitBounds(pts, { padding: [16, 16] }); else S.map.setView([51.1, 10.4], 6);
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => S.map?.invalidateSize()).observe(box);
}
function drawFindings() {
  if (!S.layers) return; S.layers.find.clearLayers(); const r = S.res;
  const mk = (at, col, tip) => L.circleMarker([at[1], at[0]], { radius: 7, color: tok(col), weight: 3, fillOpacity: 0 }).bindTooltip(tip).addTo(S.layers.find);
  for (const o of r.overlaps) mk(o.at, '--bad', t('zw.fOverlap')); for (const o of r.gaps) mk(o.at, '--warn', t('zw.fGap')); for (const o of r.pockets) mk(o.at, '--warn', t('zw.fPocket'));
  for (const o of r.spotsInBan) mk([o.lon, o.lat], '--bad', t('zw.fSpot')); for (const o of r.banNoReason || []) mk(o.at, '--info', t('zw.fNoReason'));
}

function renderExport(el, ctx) {
  const box = el.querySelector('#zw-ex'); if (!box) return;
  const types = /** @type {HTMLInputElement} */ (el.querySelector('#zw-bike')).checked ? ['scooter', 'bicycle'] : ['scooter'];
  const prefix = `${ctx.muniName(S.ags)} ${S.op}`, ex = {};
  box.innerHTML = Z.KINDS.map(k => {
    const d = Z.exportKind(S.zones, k, { prefix, vehicleTypes: types, clip: S.muni }); ex[k] = d; const v = Z.validateUpload(d);
    if (!d.features.length) return `<div class="row"><span class="zw-k" style="background:${tok(KCOL[k])}"></span><b>${KLBL()[k]}</b> <span class="muted">${t('zw.exNone')}</span></div>`;
    return `<div class="row"><span class="zw-k" style="background:${tok(KCOL[k])}"></span><b>${KLBL()[k]}</b> ${t('zw.exCount', { n: ctx.fmt(d.features.length), pts: ctx.fmt(v.stats.points) })}
      ${v.ok ? `<span class="zw-ok">✓ ${t('zw.exValid')}</span>` : `<span class="zw-bad">✕ ${ctx.esc(v.errors.join('; '))}</span>`}
      <button type="button" class="chip" data-ex="${k}"${v.ok ? '' : ' disabled'}>${t('zw.exDownload', { file: `${Z.EXPORT_FILES[k]}.geojson` })}</button></div>`;
  }).join('') + `<p class="muted small">${t('zw.exNote')}</p>`;
  box.querySelectorAll('[data-ex]').forEach(b => b.addEventListener('click', () => {
    const k = b.getAttribute('data-ex'), a = document.createElement('a'), slug = `${ctx.muniName(S.ags)}_${S.op}`.normalize('NFKD').replace(/[^\w-]+/g, '-');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(ex[k])], { type: 'application/geo+json' })); a.download = `${Z.EXPORT_FILES[k]}_${slug}.geojson`; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }));
}

async function osmReasons(el, ctx, log) {
  const status = el.querySelector('#zw-status'), b = Z.bboxOf({ type: 'MultiPolygon', coordinates: S.zones.filter(z => z.kind === 'no_park' || z.kind === 'no_ride').filter(z => z.area <= Z.AUDIT.maxExportM2).flatMap(z => (z.geometry.type === 'Polygon' ? [z.geometry.coordinates] : z.geometry.coordinates)) });
  if (!Number.isFinite(b[0])) return;
  status.textContent = t('zw.osmLoading'); const q = Z.reasonQuery([b[0] - 0.002, b[1] - 0.002, b[2] + 0.002, b[3] + 0.002]);
  for (const ep of ctx.CFG.OVERPASS || []) {
    try {
      const ctrl = new AbortController(), tq = setTimeout(() => ctrl.abort(), 150000);
      const r = await fetch(ep, { method: 'POST', body: new URLSearchParams({ data: q }), signal: ctrl.signal }); clearTimeout(tq);
      if (!r.ok) continue; const j = await r.json(); if (!Array.isArray(j?.elements)) continue;
      S.reasons = Z.osmReasonPoints(j.elements); S.reasonsFor = `${S.ags}|${S.op}`; await audit(el, ctx, log); return;
    } catch { /* nächster Spiegel */ }
  }
  status.textContent = t('zw.osmFail');
}
