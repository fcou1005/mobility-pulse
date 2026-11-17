// @ts-check
// Mobility Pulse — Reiter ÖPNV, Live-Karte: Fahrzeuge als Schildchen mit Liniennamen, Farbe nach Verspätung, Filter je Verkehrsmittel,
// Linienwege (Station → Station im Streckenverlauf aus wege/<AGS>.json, sonst Luftlinie) und Sharing-Fahrzeuge als zweite Ebene. Die Lage rechnet die
// Seite jede Sekunde aus den zuletzt gemeldeten Haltezeiten neu (lib/pulse-oepnv-wege.js positionAlong); jede Minute fragt sie nach einer neueren
// Meldung des Sammlers. Ausfälle (seit 17.11.2026) getrennt von Verspätungen: ausgefallene Halte (×), Fahrten mit ausgefallenen Halten (Ring),
// ganz ausgefallene Fahrten (gestrichelt) und Stationen mit Ausfällen in eigener Farbe (tokens.js PT_CANCEL).
import * as NZ from './pulse-oepnv-karte.js';
import * as WG from './pulse-oepnv-wege.js';
import { HIT, MODEL, seriesColor, moreColor, ptCancelColor } from './tokens.js';
import { t, dateFmt } from './i18n.js';

/** Zustand der Karte; web/oepnv.js setzt live und fleet vor setupMap */
export const M = { map: /** @type {any} */ (null), veh: /** @type {any} */ (null), share: /** @type {any} */ (null), paths: /** @type {any} */ (null), hi: /** @type {any} */ (null), timer: 0, live: /** @type {any} */ (null), fleet: /** @type {any[] | null} */ (null),
  hot: /** @type {any[]} */ ([]), showShare: false, showPaths: true, showCancel: true, off: /** @type {Set<string>} */ (new Set()), marks: /** @type {any[]} */ ([]), status: '',
  wege: /** @type {ReturnType<typeof WG.wegeLookup> | null} */ (null), cover: /** @type {{ hit: number, miss: number } | null} */ (null), skipShare: 0.15 };
const MODE_KEY = { bus: 'pt.artBus', tram: 'pt.artTram', ubahn: 'pt.artUbahn', sbahn: 'pt.artSbahn', regio: 'pt.artRegio', fern: 'pt.artFern', bahn: 'pt.artBahn', sonst: 'pt.artSonst' };
export const modeTxt = (/** @type {string} */ a) => t(MODE_KEY[/** @type {keyof typeof MODE_KEY} */ (a)] || 'pt.artSonst');
const MODE_ORDER = ['bus', 'tram', 'ubahn', 'sbahn', 'regio', 'fern', 'bahn', 'sonst'];
const modeColor = (/** @type {string} */ a) => { const i = MODE_ORDER.indexOf(a); return i >= 0 && i < 6 ? seriesColor(i) : moreColor(); };
const delayColor = (/** @type {number | null} */ d) => (d == null ? HIT.none : d >= 300 ? HIT.miss : d >= 120 ? MODEL.blend : HIT.ok);
const timeTxt = (/** @type {number} */ ms) => (ms ? dateFmt({ hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' }).format(new Date(ms)) : '–');
const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
export const KARTE_CSS = `.pt-veh{display:inline-block;transform:translate(-50%,-50%);white-space:nowrap;font-weight:600;font-size:.6875rem;line-height:1;padding:3px 5px;border-radius:9px;background:var(--panel);color:var(--fg);border:2px solid var(--c);box-shadow:0 1px 2px rgba(0,0,0,.25)}
.pt-veh.rail{border-radius:3px}
.pt-far .pt-veh{font-size:0;padding:0;width:10px;height:10px;border-radius:50%;background:var(--c);border-color:var(--panel)}
.pt-far .pt-veh.rail{border-radius:2px}
.pt-modes{display:flex;flex-wrap:wrap;gap:var(--s2) var(--s3);margin:var(--s2) 0;font-size:.875rem}
.pt-modes label{display:inline-flex;align-items:center;gap:6px}
.pt-modes i{display:inline-block;width:14px;height:3px;border-radius:2px}
.pt-veh.skip{box-shadow:0 0 0 2px var(--panel),0 0 0 4px var(--x)}
.pt-far .pt-veh.skip{box-shadow:0 0 0 2px var(--x)}
.pt-x{display:inline-block;transform:translate(-50%,-50%);font-weight:700;font-size:.875rem;line-height:1;color:var(--x);text-shadow:0 0 2px var(--panel),0 0 2px var(--panel)}
.pt-legend i.ring{background:transparent!important;border:2px solid var(--x)}
.pt-legend i.dash{width:16px;height:0;border-radius:0;border-top:2px dashed var(--x);background:transparent!important}
.pt-legend b.x{color:var(--x);margin-right:6px}`;

export function stopTimer() { if (M.timer) { clearInterval(M.timer); M.timer = 0; } }
/** Tafel der Karte: Schalter, Legende, Kasten, Statuszeile */
/** @param {any} ctx @param {string} name @param {any} live */
export function mapPanel(ctx, name, live) {
  if (!live) return `<div class="panel"><div class="panel-head"><div><h2>${t('pt.mapTitle', { name })}</h2><div class="sub">${t('pt.mapSub')}</div></div></div><div class="empty">${t('pt.mapEmpty')}</div></div>`;
  const cnt = /** @type {Record<string, number>} */ ({}); for (const r of live.trips || []) cnt[r[1]] = (cnt[r[1]] || 0) + 1;
  const modes = MODE_ORDER.filter(a => cnt[a]), cc = ptCancelColor();
  return `<div class="panel"><div class="panel-head"><div><h2>${t('pt.mapTitle', { name })}</h2><div class="sub">${t('pt.mapSub')}</div></div></div>
    <fieldset class="pt-modes" id="pt-modes"><legend class="small muted">${t('pt.modesLegend')}</legend>${modes.map(a => `<label><input type="checkbox" data-mode="${a}"${M.off.has(a) ? '' : ' checked'}><i style="background:${modeColor(a)}"></i>${modeTxt(a)} (${ctx.fmt(cnt[a])})</label>`).join('')}</fieldset>
    <div class="pt-bar"><label><input type="checkbox" id="pt-paths"${M.showPaths ? ' checked' : ''}> ${t('pt.pathsToggle')}</label><label><input type="checkbox" id="pt-cancel"${M.showCancel ? ' checked' : ''}> ${t('pt.cancelToggle')}</label><label><input type="checkbox" id="pt-share"${M.showShare ? ' checked' : ''}${M.fleet ? '' : ' disabled'}> ${t('pt.shareToggle')}</label></div>
    <div class="pt-legend" style="--x:${cc}"><span class="small muted">${t('pt.legDelay')}</span><span><i style="background:${HIT.ok}"></i>${t('pt.legOk')}</span><span><i style="background:${MODEL.blend}"></i>${t('pt.legLate2')}</span><span><i style="background:${HIT.miss}"></i>${t('pt.legLate5')}</span><span><i style="background:${HIT.none}"></i>${t('pt.legNone')}</span><span><i style="background:transparent;border:2px solid ${HIT.miss}"></i>${t('pt.legHotLate')}</span></div>
    <div class="pt-legend" style="--x:${cc};margin-top:var(--s2)"><span class="small muted">${t('pt.legCancelHead')}</span><span><b class="x" aria-hidden="true">×</b>${t('pt.legSkipStop')}</span><span><i class="ring"></i>${t('pt.legSkipVeh')}</span><span><i class="dash"></i>${t('pt.legCancel')}</span><span><i class="ring"></i>${t('pt.legHotSkip')}</span><span><i class="sq" style="background:${HIT.over}"></i>${t('pt.legShare')}</span></div>
    <div id="pt-map" class="pt-map" role="application" aria-label="${ctx.esc(t('pt.mapTitle', { name }))}"></div><p class="small" id="pt-map-status" aria-live="polite"></p>
    <p class="small" id="pt-cancel-sum">${cancelSummary(ctx, live)}</p>
    <p class="muted small" id="pt-paths-note">${pathsNote(ctx, name)}</p>
    <p class="muted small">${t('pt.mapNote', { min: live.aheadMin || 45 })}</p></div>`;
}
/** Satz zu den ganz ausgefallenen Fahrten (Live-Datei ausfall, gefiltert nach den gewählten Verkehrsmitteln) */
/** @param {any} ctx @param {any} live */
function cancelSummary(ctx, live) {
  const A = live?.ausfall; if (!A) return '';
  const lines = (A.lines || []).filter((/** @type {any[]} */ l) => !M.off.has(l[1])), rows = (A.rows || []).filter((/** @type {any[]} */ r) => !M.off.has(r[1]));
  const n = lines.reduce((x, l) => x + l[2], 0), nt = lines.reduce((x, l) => x + l[3], 0); if (!n) return t('pt.cancelNone');
  const list = lines.slice(0, 8).map((/** @type {any[]} */ l) => `${ctx.esc(l[0] || t('pt.noLine'))}${l[2] > 1 ? ` (${ctx.fmt(l[2])})` : ''}`).join(', ') + (lines.length > 8 ? `, ${t('pt.cancelMore', { n: ctx.fmt(lines.length - 8) })}` : '');
  return t('pt.cancelSum', { n: `<b>${ctx.fmt(n)}</b>`, list, w: ctx.fmt(rows.length), min: ctx.fmt(live.aheadMin || 45), nt: ctx.fmt(nt) });
}
/** Satz zu den Linienwegen: Anteil im Streckenverlauf (gezählt beim Zeichnen) oder Luftlinie */
/** @param {any} ctx @param {string} name */
function pathsNote(ctx, name) {
  if (!M.wege) return t('pt.pathsAir', { name });
  const c = M.cover; if (!c || !(c.hit + c.miss)) return t('pt.pathsGeo');
  return t('pt.pathsShare', { p: ctx.fmt(Math.round(100 * c.hit / (c.hit + c.miss))), n: ctx.fmt(c.hit + c.miss) });
}
/** Streckenverlauf je Abschnitt eines Wegs [lat, lon, dt, …] (Index i = Abschnitt von Station i−1 nach i) oder null */
/** @param {string} art @param {number[]} w */
function geomOf(art, w) {
  const n = w.length / 3, out = /** @type {Array<{ pts: number[][], cum: number[] } | null>} */ ([null]);
  for (let i = 1; i < n; i++) { const g = M.wege ? M.wege.get(art, w[3 * i - 3], w[3 * i - 2], w[3 * i], w[3 * i + 1]) : null; out.push(g ? { pts: g, cum: WG.cumLen(g) } : null); }
  return out;
}
/** Schildchen, Linienwege und Ausfälle aus M.live neu aufbauen (neue Meldung, Filter geändert) */
/** @param {any} ctx */
function rebuild(ctx) {
  if (!M.map) return; M.veh.clearLayers(); M.paths.clearLayers(); M.hi.clearLayers(); M.marks = [];
  const trips = (M.live?.trips || []).filter((/** @type {any[]} */ r) => !M.off.has(r[1])), cc = ptCancelColor();
  if (M.showPaths) {
    let hit = 0, miss = 0;
    for (const [art, segs] of NZ.segmentsOf(trips)) for (const s of segs) {
      const g = M.wege ? M.wege.get(art, s.a[0], s.a[1], s.b[0], s.b[1]) : null; if (g) hit++; else miss++;
      L.polyline(/** @type {any} */ (g || [s.a, s.b]), { color: modeColor(art), weight: art === 'bus' ? 1.5 : 2.5, opacity: 0.55, interactive: false }).addTo(M.paths);
    }
    M.cover = { hit, miss };
  }
  // gestörte Stationen der letzten Stunden: Kreis mit 300 m, Farbe nach Ursache (Ausfälle oder Verspätungen), kräftiger, wenn kein Sharing-Fahrzeug in der Nähe steht
  for (const h of M.hot || []) {
    const skip = h.n > 0 && h.skip >= M.skipShare * h.n, col = skip ? cc : HIT.miss;
    L.circle(/** @type {any} */ ([h.lat, h.lon]), { radius: 300, color: col, weight: h.level === 'none' ? 3 : 1.5, dashArray: h.level === 'none' ? undefined : '4 4', fillOpacity: h.level === 'none' ? 0.18 : 0.06 })
      .bindTooltip(`${ctx.esc(h.name)}: ${t(skip ? 'pt.nowTipSkip' : 'pt.nowTipLate', { skip: ctx.fmt(h.skip), late: ctx.fmt(h.late), n: ctx.fmt(h.n) })}`).addTo(M.paths);
  }
  // ganz ausgefallene Fahrten mit Zeit im Fenster: gestrichelt auf ihrem Weg
  if (M.showCancel) for (const [line, art, w] of (M.live?.ausfall?.rows || []).filter((/** @type {any[]} */ r) => !M.off.has(r[1]))) {
    if (!w || w.length < 6) continue; const geo = geomOf(art, w);
    L.polyline(/** @type {any} */ (WG.pathPoints(w, (i) => geo[i])), { color: cc, weight: 3, opacity: 0.85, dashArray: '6 6' }).bindTooltip(t('pt.cancelTip', { line: ctx.esc(line || t('pt.noLine')), art: modeTxt(art), time: timeTxt((M.live.at || 0) + w[2] * 1000) })).addTo(M.paths);
  }
  /** @type {Map<string, { p: number[], lines: Set<string> }>} */ const gone = new Map();
  for (const r of trips) {
    const [line, kind, delay, w, skipped] = r, rail = kind !== 'bus' && kind !== 'tram', ns = skipped ? skipped.length / 2 : 0;
    const tip = `${ctx.esc(line || t('pt.noLine'))} (${modeTxt(kind)})${delay == null ? `, ${t('pt.noDelay')}` : `, ${delay >= 60 ? t('pt.delayMin', { n: ctx.fmt(Math.round(delay / 60)) }) : t('pt.onTime')}`}${ns ? `, ${t('pt.skipTip', { n: ctx.fmt(ns) })}` : ''}`;
    const mk = L.marker(/** @type {any} */ ([w[0], w[1]]), { icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<span class="pt-veh${rail ? ' rail' : ''}${ns ? ' skip' : ''}" style="--c:${delayColor(delay)};--x:${cc}">${ctx.esc(line || '?')}</span>` }), keyboard: false, zIndexOffset: rail ? 200 : 0 }).bindTooltip(tip);
    const geo = geomOf(kind, w);
    // Klick: Weg dieses Fahrzeugs hervorheben (bis zu den gemeldeten nächsten Halten, im Streckenverlauf)
    mk.on('click', () => { M.hi.clearLayers(); L.polyline(/** @type {any} */ (WG.pathPoints(w, (i) => geo[i])), { color: delayColor(delay), weight: 5, opacity: 0.9, interactive: false }).addTo(M.hi); for (let i = 0; i + 2 < w.length; i += 3) L.circleMarker(/** @type {any} */ ([w[i], w[i + 1]]), { radius: 3, color: delayColor(delay), weight: 2, fillOpacity: 1, interactive: false }).addTo(M.hi); });
    M.marks.push({ mk, w, geo, delay, on: false });
    if (skipped) for (let i = 0; i + 1 < skipped.length; i += 2) { const k = `${skipped[i]},${skipped[i + 1]}`; let g = gone.get(k); if (!g) gone.set(k, g = { p: [skipped[i], skipped[i + 1]], lines: new Set() }); g.lines.add(line || t('pt.noLine')); }
  }
  // ausgefallene Halte fahrender Fahrten: × an der Station
  if (M.showCancel) for (const g of gone.values()) L.marker(/** @type {any} */ (g.p), { icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<span class="pt-x" style="--x:${cc}">×</span>` }), keyboard: false, zIndexOffset: 300 }).bindTooltip(t('pt.skipStopTip', { lines: ctx.esc([...g.lines].slice(0, 6).join(', ')) })).addTo(M.paths);
}
/** Lage aller Fahrzeuge zum jetzigen Zeitpunkt setzen; Statuszeile nur schreiben, wenn sich ihr Text ändert */
/** @param {any} ctx @param {HTMLElement} el */
export function tick(ctx, el) {
  const live = M.live, st = el.querySelector('#pt-map-status'); if (!M.map) return;
  const dt = live ? (Date.now() - live.at) / 1000 : Infinity, stale = !live || dt > (live.aheadMin || 45) * 60; let n = 0, late = 0;
  for (const x of M.marks) {
    const p = stale ? null : WG.positionAlong(x.w, dt, (i) => x.geo[i]);
    if (!p) { if (x.on) { M.veh.removeLayer(x.mk); x.on = false; } continue; }
    x.mk.setLatLng(p); if (!x.on) { x.mk.addTo(M.veh); x.on = true; } n++; if (x.delay != null && x.delay >= 300) late++;
  }
  const txt = !live ? t('pt.mapNone') : stale ? t('pt.mapStale', { time: timeTxt(live.at), min: live.aheadMin || 45 }) : t('pt.mapStatus2', { n: ctx.fmt(n), late: ctx.fmt(late), time: timeTxt(live.at), age: ctx.fmt(Math.max(0, Math.round(dt / 60))), share: M.showShare && M.fleet ? t('pt.mapShare', { n: ctx.fmt(M.fleet.length) }) : '' });
  if (st && txt !== M.status) { st.textContent = txt; M.status = txt; }
}
function drawShare() { if (!M.share) return; M.share.clearLayers(); if (M.showShare && M.fleet) for (const v of M.fleet) L.rectangle([[v.lat - 0.00006, v.lon - 0.00009], [v.lat + 0.00006, v.lon + 0.00009]], { color: HIT.over, weight: 1, fillOpacity: 0.7, interactive: false }).addTo(M.share); }
/** Karte anlegen und laufen lassen. reload(): lädt die Datei der Fahrzeugwege neu (Rückgabe Dokument oder null) */
/** @param {any} ctx @param {HTMLElement} el @param {any[][]} rows @param {() => Promise<any>} reload */
export function setupMap(ctx, el, rows, reload) {
  const box = /** @type {HTMLElement | null} */ (el.querySelector('#pt-map')); if (!box || typeof L === 'undefined') return;
  M.map?.remove(); M.map = null; M.status = '';
  const still = reduced();
  M.map = L.map(box, { zoomControl: false, zoomAnimation: !still, fadeAnimation: !still, markerZoomAnimation: !still, preferCanvas: true });
  L.control.zoom({ zoomInTitle: t('common.zoomIn'), zoomOutTitle: t('common.zoomOut') }).addTo(M.map);
  M.map.attributionControl?.setPrefix(`<a href="https://leafletjs.com" title="${t('common.leafletTitle')}" lang="en">Leaflet</a>`);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: `${t('app.openstreetmapContributors')}, ${ctx.esc(M.live?.attribution || NZ.NETZ_ATTRIBUTION)}` }).addTo(M.map);
  M.paths = L.layerGroup().addTo(M.map); M.share = L.layerGroup().addTo(M.map); M.hi = L.layerGroup().addTo(M.map); M.veh = L.layerGroup().addTo(M.map);
  const far = () => box.classList.toggle('pt-far', M.map.getZoom() < 13); M.map.on('zoomend', far);
  const pts = /** @type {any[]} */ ((rows || []).slice(0, 60).map(r => [r[2], r[3]]));
  if (pts.length) M.map.fitBounds(L.latLngBounds(pts).pad(0.05)); else M.map.setView([51.2, 10.4], 6);
  const notes = () => { const a = el.querySelector('#pt-cancel-sum'), b = el.querySelector('#pt-paths-note'), nm = ctx.muniName?.(ctx.state.scope) || ctx.state.scope; if (a) a.innerHTML = cancelSummary(ctx, M.live); if (b) b.textContent = pathsNote(ctx, nm); };
  far(); rebuild(ctx); notes(); drawShare(); tick(ctx, el); stopTimer();
  el.querySelector('#pt-share')?.addEventListener('change', (e) => { M.showShare = /** @type {HTMLInputElement} */ (e.target).checked; drawShare(); tick(ctx, el); });
  el.querySelector('#pt-paths')?.addEventListener('change', (e) => { M.showPaths = /** @type {HTMLInputElement} */ (e.target).checked; rebuild(ctx); tick(ctx, el); });
  el.querySelector('#pt-cancel')?.addEventListener('change', (e) => { M.showCancel = /** @type {HTMLInputElement} */ (e.target).checked; rebuild(ctx); tick(ctx, el); });
  for (const c of el.querySelectorAll('#pt-modes input')) c.addEventListener('change', () => { const a = /** @type {HTMLElement} */ (c).dataset.mode || ''; if (/** @type {HTMLInputElement} */ (c).checked) M.off.delete(a); else M.off.add(a); rebuild(ctx); notes(); tick(ctx, el); });
  // Lage jede Sekunde (ruhig gestellt: alle 15 s), neue Meldung jede Minute; endet, wenn die Ansicht den Kasten nicht mehr zeigt
  let ticks = 0, busy = false; const every = still ? 15000 : 1000, ags = ctx.state.scope;
  M.timer = window.setInterval(async () => {
    if (!document.body.contains(box) || ctx.state.scope !== ags) { stopTimer(); return; }
    if (box.offsetParent === null || document.hidden) return;
    if (++ticks % Math.round(60000 / every) === 0 && !busy) { busy = true; try { const nl = await reload(); if (nl?.at > (M.live?.at || 0)) { M.live = nl; rebuild(ctx); notes(); } } finally { busy = false; } }
    tick(ctx, el);
  }, every);
}
