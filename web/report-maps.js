// Mobility Pulse — Bericht (Ansicht) – Zellkarten, Druck, Obergrenzen-Bausteine (aus report.js geschnitten; report.js bleibt die Fassade für alle Importe).
import * as R from './pulse-report.js';
import { t, lang } from './i18n.js';
import { mapKeys } from './mapkeys.js';
import { calibLabel } from './ui-shared.js';
import { CAPSRC, artTxt, badge, badge0, cellSvgMarkup, dd, dm, download, emptyBox, hideTip, num, pctTxt, plural, safeLink, srcTxt, st, stamp, tile, tip, typeName } from './report-core.js';
import { DERIVED_TXT_DEF, capInfoTxt, overMark, rateCell, rateTxt, standTxt } from './report-more.js';
import { NEUTRAL, PRINT } from './tokens.js';

// ---------- Zellkarten auf OpenStreetMap (Leaflet) ----------
// Zwei Karten (Fahrtbeginne, Fahrtenden), gekoppelt: die zuletzt bediente Karte führt, die andere folgt ohne eigene Animation.
// Zellen als halbtransparente Rechtecke auf einem Canvas-Renderer in den Farben der Skala; Kacheln entsättigt (dunkles Thema: invertiert),
// damit die Skala lesbar bleibt. Tooltip je Zelle beim Überfahren oder Antippen; Werte für alle Zellen in der Tabelle.
const OSM_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTR_DEF = () => (t('rep.openstreetmapContributors'));
const CELL_FILL = 0.72; // Deckkraft der Zellen über der Karte
export const hasLeaflet = () => typeof window !== 'undefined' && !!window.L && typeof window.L.map === 'function';
export const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
// Skala als Zahlen (gleiche Anteile wie --rp-seq-0…8 im CSS): Akzentfarbe in OKLab mit der Fläche gemischt
const SEQ_P = [7, 16, 27, 38, 49, 60, 72, 85, 100];
const hexRgb = (h) => { const m = String(h || '').trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i); if (!m) return null; let s = m[1]; if (s.length === 3) s = [...s].map(c => c + c).join(''); return [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16) / 255); };
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4), unlin = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
function toOklab([r, g, b]) {
  [r, g, b] = [r, g, b].map(lin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function fromOklab([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return `#${rgb.map(c => Math.round(Math.max(0, Math.min(1, unlin(c))) * 255).toString(16).padStart(2, '0')).join('')}`;
}
function rampColors(accent, panel) {
  const A = hexRgb(accent), P = hexRgb(panel); if (!A || !P) return SEQ_P.map(() => accent || PRINT.accent);
  const a = toOklab(A), p = toOklab(P);
  return SEQ_P.map(q => fromOklab(a.map((x, i) => x * (q / 100) + p[i] * (1 - q / 100))));
}
const cssVar = (el, name, d) => (getComputedStyle(el).getPropertyValue(name) || '').trim() || d;
const PRINT_ACCENT = PRINT.accent, PRINT_PANEL = PRINT.panel; // helle Werte wie @media print in index.html
const cellBounds = (c) => [[c.lat - R.CELL_LAT / 2, c.lon - R.CELL_LON / 2], [c.lat + R.CELL_LAT / 2, c.lon + R.CELL_LON / 2]];
const cellClass = (c, key, max) => (R.suppressed(c[key]) ? 0 : R.heatClass(c[key], max));
export function unmountCellMaps(s) {
  if (s.cellMaps?.length && s.cellMapsAgs) { const v = s.cellMaps[0].map; try { if (v.getSize().x) s.cellView = { ags: s.cellMapsAgs, center: v.getCenter(), zoom: v.getZoom() }; } catch { /* Karte ohne Ansicht */ } }
  for (const m of s.cellMaps || []) { try { m.ro?.disconnect(); m.map.remove(); } catch { /* bereits entfernt */ } }
  s.cellMaps = [];
}
export function mountCellMaps(el, s) {
  unmountCellMaps(s);
  const boxes = [...el.querySelectorAll('.rp-report div.rp-cellmap[data-key]')]; const cs = s.rep?.cells;
  if (!boxes.length || !hasLeaflet() || !cs?.grid?.length) return;
  const L = window.L, still = reducedMotion(), { fmt } = s.ctx;
  const colors = rampColors(cssVar(el, '--accent', PRINT_ACCENT), cssVar(el, '--panel', PRINT_PANEL)), ink = cssVar(el, '--fg', NEUTRAL.ink);
  const idx = new Map(cs.grid.map((c, n) => [`${c.i}:${c.j}`, n]));
  const all = L.latLngBounds(cs.grid.flatMap(cellBounds));
  const maps = boxes.map(box => {
    const key = box.dataset.key;
    const map = L.map(box, { zoomControl: true, attributionControl: true, scrollWheelZoom: false, dragging: !L.Browser.mobile, tap: false, zoomSnap: 0.5, zoomDelta: 0.5,
      zoomAnimation: !still, fadeAnimation: !still, markerZoomAnimation: !still, inertia: !still, minZoom: 8, maxZoom: 18 });
    const tiles = L.tileLayer(OSM_URL, { maxZoom: 19, attribution: OSM_ATTR_DEF(), crossOrigin: 'anonymous' }).addTo(map);
    const renderer = L.canvas({ padding: 0.3 });
    for (const c of cs.grid) L.rectangle(cellBounds(c), { renderer, stroke: false, fillColor: colors[cellClass(c, key, cs.max)], fillOpacity: CELL_FILL, interactive: false }).addTo(map);
    const hi = L.rectangle(cellBounds(cs.grid[0]), { renderer, interactive: false, fill: false, color: ink, weight: 2, opacity: 0 }).addTo(map);
    return { map, key, box, tiles, hi };
  });
  const keep = s.cellView?.ags === s.rep.ags ? s.cellView : null;
  for (const m of maps) { if (keep) m.map.setView(keep.center, keep.zoom, { animate: false }); else m.map.fitBounds(all, { padding: [8, 8], animate: false }); }
  // Kopplung: die zuletzt bediente Karte gibt Mitte und Zoom vor
  let lead = maps[0];
  const follow = (src, center, zoom, anim) => { for (const m of maps) { if (m === src) continue; const c = m.map.getCenter(); if (m.map.getZoom() === zoom && Math.abs(c.lat - center.lat) < 1e-9 && Math.abs(c.lng - center.lng) < 1e-9) continue; m.map.setView(center, zoom, { animate: anim && !still }); } };
  for (const m of maps) {
    for (const ev of ['pointerdown', 'wheel', 'focusin', 'mouseenter', 'touchstart']) m.box.addEventListener(ev, () => { lead = m; }, { passive: true });
    m.map.on('move', () => { if (lead === m && !m.map._animatingZoom) follow(m, m.map.getCenter(), m.map.getZoom(), false); });
    m.map.on('zoomanim', (e) => { if (lead === m) follow(m, e.center, e.zoom, true); });
    m.map.on('zoomend moveend', () => { if (lead === m) follow(m, m.map.getCenter(), m.map.getZoom(), false); });
  }
  // Tooltip je Zelle (Überfahren, Antippen), Markierung derselben Zelle in beiden Karten
  const hide = () => { for (const m of maps) { m.hi.setStyle({ opacity: 0 }); const b = m.box.closest('.rp-chart'); if (b) hideTip(b); } };
  const show = (m, latlng) => {
    const n = idx.get(`${Math.round(latlng.lat / R.CELL_LAT)}:${Math.round(latlng.lng / R.CELL_LON)}`); const c = n == null ? null : cs.grid[n];
    if (!c) { hide(); return; }
    for (const x of maps) { x.hi.setBounds(cellBounds(c)); x.hi.setStyle({ opacity: 1 }); if (x !== m) { const b = x.box.closest('.rp-chart'); if (b) hideTip(b); } }
    const p = m.map.latLngToContainerPoint([c.lat + R.CELL_LAT / 2, c.lon]), tq = tipOf(m, c);
    showTipAt(m.box.closest('.rp-chart'), p.x, p.y, tq.value, tq.lines);
  };
  const tipOf = (m, c) => {
    const key = m.key, other = key === 'start' ? 'end' : 'start', v = (x) => (R.suppressed(x) ? `< ${R.MIN_COUNT}` : fmt(x));
    return { value: `${v(c[key])} ${key === 'start' ? t('rep.tripStarts') : t('rep.tripEnds')}`, lines: [t('rep.avgAvailablePerRun2', { v0: v(c[other]), v1: other === 'start' ? t('rep.tripStarts') : t('rep.tripEnds'), v2: c.presAvg == null ? '—' : fmt(c.presAvg, 1) }), t('rep.cell2', { v0: c.lat.toFixed(4), v1: c.lon.toFixed(4) })] };
  };
  // Tastatur (web/mapkeys.js): die Zellen sind nicht anklickbar (Canvas, interactive: false) – N/P geht über das Zellraster selbst,
  // markiert die Zelle in beiden Karten und zeigt denselben Tooltip wie beim Überfahren; ein gemeinsamer Hinweis unter beiden Karten
  const grid = el.querySelector('.rp-report [data-rp="cellmaps"]');
  for (const m of maps) mapKeys(m.map, { hintAfter: grid || m.box, items: () => cs.grid.map(c => ({ key: c, latlng: [c.lat, c.lon], ring: false, show: () => show(m, L.latLng(c.lat, c.lon)), hide, text: () => { const tq = tipOf(m, c); return [tq.value, ...tq.lines].join('\n'); } })) });
  for (const m of maps) {
    m.map.on('mousemove', (e) => show(m, e.latlng)); m.map.on('click', (e) => show(m, e.latlng));
    m.map.on('mouseout movestart zoomstart', hide);
    // Größe ändert sich (Fenster, Spaltenumbruch, Ansicht erst später sichtbar): Kartengröße nachziehen
    if (typeof ResizeObserver === 'function') { let w0 = m.box.clientWidth, h0 = m.box.clientHeight; m.ro = new ResizeObserver(() => { const w = m.box.clientWidth, h = m.box.clientHeight; if (w === w0 && h === h0) return; const was = !w0; w0 = w; h0 = h; m.map.invalidateSize({ animate: false }); if (was && w && !keep) m.map.fitBounds(all, { padding: [8, 8], animate: false }); }); m.ro.observe(m.box); }
  }
  s.cellMaps = maps; s.cellMapsAgs = s.rep.ags;
}
// Tooltip an einer Stelle im Diagrammkasten (Kartenpunkt), sonst wie showTip
function showTipAt(box, px, py, value, label) {
  if (!box) return;
  const tq = tip(box); tq.replaceChildren(); const b = document.createElement('b'); b.textContent = value; tq.append(b);
  for (const l of [].concat(label || [])) { const d = document.createElement('div'); d.textContent = l; tq.append(d); }
  tq.hidden = false;
  const w = box.getBoundingClientRect();
  const x = Math.max(tq.offsetWidth / 2 + 4, Math.min(w.width - tq.offsetWidth / 2 - 4, px));
  let y = py; if (y - tq.offsetHeight - 10 < 0) y = py + tq.offsetHeight + 24;
  tq.style.left = `${x}px`; tq.style.top = `${y}px`;
}
// Druck: Kacheln abwarten (höchstens ms), dann Karte + Zellen in hellen Druckfarben als Bild; ohne Freigabe der Kacheln (CORS) null
function tilesSettled(tiles, ms = 4000) {
  return new Promise(res => { if (!tiles?.isLoading?.()) { res(); return; } const done = () => { clearTimeout(tq); tiles.off('load', done); res(); }; const tq = setTimeout(done, ms); tiles.on('load', done); });
}
async function cellMapImage(m, cs) {
  const W = m.box.clientWidth, H = m.box.clientHeight; if (!W || !H) return null;
  await tilesSettled(m.tiles);
  const k = 2, cv = document.createElement('canvas'); cv.width = W * k; cv.height = H * k;
  const g = cv.getContext('2d'); if (!g) return null; g.scale(k, k);
  g.fillStyle = NEUTRAL.paperSoft; g.fillRect(0, 0, W, H);
  const br = m.box.getBoundingClientRect(); let tiles = 0;
  g.save(); if ('filter' in g) g.filter = 'grayscale(1) contrast(.92) brightness(1.04)';
  for (const img of m.box.querySelectorAll('.leaflet-tile-pane img.leaflet-tile-loaded')) { const r = img.getBoundingClientRect(); if (r.right < br.left || r.left > br.right || r.bottom < br.top || r.top > br.bottom) continue; try { g.drawImage(img, r.left - br.left, r.top - br.top, r.width, r.height); tiles++; } catch { /* Kachel nicht zeichenbar */ } }
  g.restore();
  const colors = rampColors(PRINT_ACCENT, PRINT_PANEL); g.globalAlpha = CELL_FILL;
  for (const c of cs.grid) { const [[s0, w0], [n0, e0]] = cellBounds(c); const a = m.map.latLngToContainerPoint([n0, w0]), b = m.map.latLngToContainerPoint([s0, e0]); if (b.x < 0 || a.x > W || b.y < 0 || a.y > H) continue; g.fillStyle = colors[cellClass(c, m.key, cs.max)]; g.fillRect(a.x, a.y, Math.max(0.5, b.x - a.x), Math.max(0.5, b.y - a.y)); }
  g.globalAlpha = 1;
  const note = t('rep.openstreetmapContributors2'); g.font = '10px system-ui, sans-serif'; const tw = g.measureText(note).width;
  g.fillStyle = 'rgba(255,255,255,.85)'; g.fillRect(W - tw - 10, H - 16, tw + 10, 16); g.fillStyle = NEUTRAL.inkSoft; g.fillText(note, W - tw - 5, H - 4.5);
  try { return tiles ? cv.toDataURL('image/png') : null; } catch { return null; } // Kacheln ohne CORS-Freigabe: Canvas gesperrt → Rückfall
}
export function reportCsv(el) {
  const s = st(el); if (!s.rep) return;
  const rows = R.reportCsvRows(s.rep, { name: s.meta.name, typeLabel: typeName, cal: s.meta.cal, calLabel: calibLabel(s.meta.calib?.k), period: s.meta.period , lang: lang() });
  const per = s.meta.period?.key ? `${s.meta.period.key}_` : '';
  download(`${t('file.report')}_${s.rep.ags}_${per}${s.rep.from}_${s.rep.to}.csv`, R.toCsv(rows, lang()));
}
/**
 * Nur den Bericht drucken: Kopie als oberstes Element, alles andere per @media print ausgeblendet; nach dem Druck aufräumen.
 * Zellkarten: Kacheln laden abwarten (höchstens 4 s) und Karte samt Zellen als Bild einsetzen (eine geklonte Leaflet-Karte druckt keine
 * Canvas-Zellen); sind die Kacheln nicht zeichenbar, druckt das Zellraster ohne Kartenhintergrund mit Hinweis.
 */
export async function printReport(el) {
  const art = el?.querySelector('.rp-report'); if (!art) return;
  const s = st(el); const btn = el.querySelector('button[data-rp="print"]');
  if (s.printing) return; s.printing = true;
  if (btn) { btn.setAttribute('aria-busy', 'true'); btn.dataset.label = btn.textContent; btn.textContent = t('rep.preparingMaps'); }
  let shots = [];
  try { shots = await Promise.all((s.cellMaps || []).map(m => cellMapImage(m, s.rep.cells).catch(() => null))); } catch { shots = []; }
  if (btn) { btn.removeAttribute('aria-busy'); btn.textContent = btn.dataset.label || t('rep.printPdf'); }
  s.printing = false;
  document.querySelectorAll('.rp-print-root').forEach(n => n.remove());
  const root = document.createElement('div'); root.className = 'rp-print-root rp-root';
  root.appendChild(art.cloneNode(true)); root.querySelectorAll('.rp-tip,.rp-noprint').forEach(n => n.remove());
  root.querySelectorAll('[id]').forEach(n => n.removeAttribute('id')); // keine doppelten IDs neben dem Original
  root.querySelectorAll('div.rp-cellmap[data-key]').forEach((box, i) => {
    const key = box.dataset.key, url = shots[i], fig = box.closest('.rp-fig'); const title = fig?.querySelector('figcaption')?.textContent || '';
    const host = box.closest('.rp-chart') || box;
    if (url) { const img = document.createElement('img'); img.className = 'rp-cellmap-img'; img.alt = t('rep.cellsOnOpenstreetmap', { title }); img.src = url; host.replaceChildren(img); }
    else if (s.rep?.cells) { host.innerHTML = cellSvgMarkup(s.rep.cells, key, title) + `<div class="small muted">${t('rep.mapBackgroundNotPrintable')}</div>`; }
  });
  document.body.appendChild(root); document.body.classList.add('rp-printing');
  const title = document.title; document.title = t('rep.municipalReport3', { v0: s.meta?.name || '', v1: s.rep?.from || '', v2: s.rep?.to && s.rep.to !== s.rep.from ? ` ${t('rep.to2', { to: s.rep.to })}` : '' }).trim();
  let done = false;
  const end = () => { if (done) return; done = true; document.body.classList.remove('rp-printing'); root.remove(); document.title = title; window.removeEventListener('afterprint', end); };
  window.addEventListener('afterprint', end);
  setTimeout(end, 120e3); // Browser ohne afterprint
  await Promise.all([...root.querySelectorAll('img')].map(i => (i.decode ? i.decode().catch(() => {}) : null)));
  window.print();
}

// ======================================================================
// 2. Obergrenzen-Wächter
// ======================================================================
function meter(ctx, value, limit, status) {
  const dom = Math.max(limit || 0, value || 0) || 1; const w = Math.min(100, ((value || 0) / dom) * 100);
  return `<div class="rp-meter ${status}" role="img" aria-label="${t('rep.of2', { value: ctx.fmt(value), limit: ctx.fmt(limit) })}"><i style="width:${w.toFixed(1)}%"></i>${value > limit ? `<b style="left:${((limit / dom) * 100).toFixed(1)}%" title="${t('rep.fleetCap')}"></b>` : ''}</div>`;
}
// Dauer als Text: „40 Min.“, „3,3 Std.“, „1,5 Tage“
const durTxt = (ctx, ms) => (!ms ? '–' : ms < 3600e3 ? t('rep.min', { v0: ctx.fmt(ms / 60e3) }) : ms < 48 * 3600e3 ? t('rep.h', { v0: ctx.fmt(ms / 3600e3, 1) }) : t('rep.days2', { v0: ctx.fmt(ms / 86400e3, 1) }));
// Verlauf: Tagesmaximum gesamt als schmale Balken, Obergrenze als gestrichelte Linie; Tooltip je Tag, Tabelle als Alternative
function capChart(ctx, v, c) {
  const pts = v.daily.filter(d => d.max != null); if (!pts.length) return '';
  const limit = c.limit || Math.max(...pts.map(d => d.limit || 0)) || null;
  const W = 900, H = 150, P = { l: 52, r: 12, t: 12, b: 26 };
  const first = Date.parse(`${pts[0].day}T12:00:00Z`), last = Date.parse(`${pts[pts.length - 1].day}T12:00:00Z`); const n = Math.max(30, Math.round((last - first) / 86400e3) + 1);
  const slot = (W - P.l - P.r) / n, bw = Math.max(3, Math.min(16, slot * 0.62));
  const ymax = Math.max(limit || 0, ...pts.map(d => d.max)) * 1.08 || 1;
  const Y = (x) => P.t + (1 - x / ymax) * (H - P.t - P.b);
  const xi = (d) => Math.round((Date.parse(`${d}T12:00:00Z`) - (last - (n - 1) * 86400e3)) / 86400e3);
  // Tage ohne Protokoll (vor dem ersten Tag und Lücken) schraffiert statt leer – leer läse sich wie 0
  const have = new Set(pts.map(d => xi(d.day))), pid = `rp-na-${String(v.ags).replace(/[^\w-]/g, '')}`;
  const gaps = [...Array(n).keys()].filter(i => !have.has(i)).map(i => `<rect class="gap" x="${(P.l + i * slot).toFixed(1)}" y="${P.t}" width="${slot.toFixed(1)}" height="${H - P.t - P.b}" fill="url(#${pid})"/>`).join('');
  const defs = gaps ? `<defs><pattern id="${pid}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="var(--muted)" stroke-opacity=".35" stroke-width="1.5"/></pattern></defs>` : '';
  const bars = pts.map((d, i) => { const x = P.l + xi(d.day) * slot + (slot - bw) / 2, y = Y(d.max), y0 = Y(0), r = Math.min(4, bw / 2, y0 - y);
    const path = y0 - y < 0.5 ? '' : `<path class="bar" d="M${x.toFixed(1)},${y0.toFixed(1)}V${(y + r).toFixed(1)}Q${x.toFixed(1)},${y.toFixed(1)} ${(x + r).toFixed(1)},${y.toFixed(1)}H${(x + bw - r).toFixed(1)}Q${(x + bw).toFixed(1)},${y.toFixed(1)} ${(x + bw).toFixed(1)},${(y + r).toFixed(1)}V${y0.toFixed(1)}Z"/>`;
    return `<g data-i="${i}"><rect class="hit" x="${(P.l + xi(d.day) * slot).toFixed(1)}" y="${P.t}" width="${slot.toFixed(1)}" height="${H - P.t - P.b}"/>${path}</g>`; }).join('');
  const lim = limit ? `<line class="lim" x1="${P.l}" x2="${W - P.r}" y1="${Y(limit).toFixed(1)}" y2="${Y(limit).toFixed(1)}"/><text x="${P.l - 6}" y="${(Y(limit) + 3.5).toFixed(1)}" text-anchor="end">${ctx.fmt(limit)}</text>` : '';
  const ax = `<line class="base" x1="${P.l}" x2="${W - P.r}" y1="${Y(0)}" y2="${Y(0)}"/><text x="${P.l - 6}" y="${Y(0) + 3.5}" text-anchor="end">0</text><text x="${P.l}" y="${H - 6}">${dm(new Date(last - (n - 1) * 86400e3).toISOString().slice(0, 10))}</text><text x="${W - P.r}" y="${H - 6}" text-anchor="end">${dm(pts[pts.length - 1].day)}</text>`;
  return `<div class="rp-chart" data-rp="capchart" data-ags="${ctx.esc(v.ags)}"><svg class="rp-line rp-bars" viewBox="0 0 ${W} ${H}" role="img" aria-label="${t('rep.dailyMaximumOfFleetOnDays', { length: pts.length, v1: limit ? ctx.fmt(limit) : '' })}">${defs}<g>${gaps}</g>${ax}${lim}<g>${bars}</g></svg></div>
    <div class="rp-legend"><span><i class="rp-sw" style="--rp-f:var(--accent)"></i>${t('rep.highestFleetPerDayAll')}</span>${limit ? `<span><i class="rp-key" style="--c:var(--fg-2)"></i>${t('rep.totalFleetCap', { limit: ctx.fmt(limit) })}</span>` : ''}${gaps ? `<span><i class="rp-sw" style="background:var(--rp-na)"></i>${t('rep.notMeasuredDays', { n: n - have.size })}</span>` : ''}</div>`;
}
function violationsBlock(ctx, c, v, s) {
  const { esc, fmt, opColor } = ctx;
  const h = `<h3 style="font-size:.875rem;margin:var(--s2) 0 var(--s1)">${t('rep.violationsInLast30Days')}</h3>`;
  if (v === undefined) return h + `<div class="muted small">${t('rep.noLogYetCapsLogJsonIsCreated', { v0: R.NEAR_CAP * 100 })}</div>`;
  if (!v) return h + `<div class="muted small">${t('rep.logContainsNoCheckForThis')}</div>`;
  const ops = v.ops.filter(o => o.overRuns || o.nearRuns);
  const name = (op) => (op === '*' ? t('rep.total2') : `<span class="op"><i style="background:${opColor(op)}"></i>${esc(op)}</span>`);
  const rows = ops.map(o => `<tr><td>${name(o.op)}</td><td class="n">${o.overRuns ? `${badge('over')} ${durTxt(ctx, o.overMs)}<div class="sub-line">${plural(o.overRuns, t('rep.run'), t('rep.runs'))}</div>` : '<span class="muted">–</span>'}</td><td class="n">${o.nearRuns ? `${durTxt(ctx, o.nearMs)}<div class="sub-line">${plural(o.nearRuns, t('rep.run'), t('rep.runs'))}</div>` : '<span class="muted">–</span>'}</td><td class="n"><b>${fmt(o.peak)}</b><div class="sub-line">${stamp(o.peakAt)}</div></td><td class="n">${fmt(o.limit)}</td><td class="n">${o.lastOverAt ? stamp(o.lastOverAt) : '–'}</td></tr>`).join('');
  const days = v.daily.length;
  const table = ops.length ? `<div class="tbl" tabindex="0" role="region" aria-label="${t('rep.violations', { ort: esc(v.ort) })}"><table><thead><tr><th>${t('rep.operator2')}</th><th class="n">${t('rep.overCap')}</th><th class="n">${t('rep.near', { v0: R.NEAR_CAP * 100 })}</th><th class="n">${t('rep.peakValue')}</th><th class="n">${t('rep.cap')}</th><th class="n">${t('rep.lastOver')}</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<div class="muted small">${t('rep.noExceedanceAndNoRunFromOf', { v0: R.NEAR_CAP * 100, v1: plural(days || 0, t('rep.loggedDay'), t('rep.loggedDays')) })}</div>`;
  const tbl = s.show[`cap:${v.ags}`];
  const btn = v.daily.length ? `<button type="button" class="rp-noprint" data-rp="captable" data-ags="${esc(v.ags)}" aria-expanded="${tbl ? 'true' : 'false'}">${tbl ? t('rep.asChart') : t('rep.historyAsTable')}</button>` : '';
  const hist = !v.daily.length ? '' : tbl ? `<div class="tbl" tabindex="0" role="region" aria-label="${t('rep.dailyMaximum', { ort: esc(v.ort) })}"><table><thead><tr><th>${t('rep.day')}</th><th class="n">${t('rep.highestFleet')}</th><th class="n">${t('rep.cap')}</th><th>Status</th></tr></thead><tbody>${v.daily.slice().reverse().map(d => `<tr><td>${dd(d.day)}</td><td class="n">${fmt(d.max)}</td><td class="n">${d.limit != null ? fmt(d.limit) : '—'}</td><td>${badge(R.capStatus(d.max, d.limit).status)}</td></tr>`).join('')}</tbody></table></div>` : capChart(ctx, v, c);
  return h + `<div class="sub small muted" style="margin-bottom:var(--s1)">${t('rep.durationSumOfFetchIntervals', { v0: plural(days, t('rep.day'), t('rep.days')), btn })}</div>` + table + hist;
}
// Teilgebiet mit vermuteter Abgrenzung (zone-watch.json): Statuszeile und je Anbieter Bestand gegen die Grenze
// Grenze eines Teilgebiets als Text: gesamt, je Anbieter, Anteil an der Flotte (anteilMax/anteilMin)
const zoneLimitTxt = (ctx, d) => [d.limit != null ? t('rep.total3', { limit: ctx.fmt(d.limit) }) : null, d.perOperator != null ? t('rep.perOperator', { perOperator: ctx.fmt(d.perOperator), v1: d.perOperatorDerived ? ` (${DERIVED_TXT_DEF()})` : '' }) : null,
  d.shareMax != null ? t('zv.shareMax', { p: pctTxt(ctx, d.shareMax, 0) }) : null, d.shareMin != null ? t('zv.shareMin', { p: pctTxt(ctx, d.shareMin, 0) }) : null].filter(Boolean).join(', ') || '—';
function zoneCheckRows(ctx, d) {
  const { fmt, esc, opColor } = ctx, k = d.check, shareCol = k.shareMax != null || k.shareMin != null;
  const badge = (s) => badge0(k.superset && s === 'hint' ? 'hintUpper' : s); // umfassender Umriss: Hinweis = Bestand ist Obergrenze
  const shareCell = (o) => (o.fleetShare == null ? '<span class="muted">–</span>' : `${pctTxt(ctx, o.fleetShare, 0)}<div class="sub-line">${t('zv.ofFleet', { n: fmt(o.now), f: fmt(o.fleet) })}</div>`);
  const rows = k.operators.map(o => `<tr><td><span class="op"><i style="background:${opColor(o.op)}"></i>${esc(o.op)}</span></td><td class="n">${fmt(o.now)}</td><td class="n">${o.limit != null ? fmt(o.limit) : '—'}</td><td style="min-width:120px">${o.limit != null ? meter(ctx, o.now, o.limit, ((s) => (s === 'hint' ? 'near' : s))(o.countStatus || o.status)) : '<span class="muted small">—</span>'}</td>${shareCol ? `<td class="n">${shareCell(o)}</td>` : ''}<td class="n">${o.todayMax != null ? fmt(o.todayMax) : '–'}</td><td class="n">${o.max30 != null ? fmt(o.max30) : '–'}</td><td class="n">${o.daysOver != null ? `${fmt(o.daysOver)} <span class="muted small">${t('rep.capZoneDaysOf', { n: fmt(o.daysLogged) })}</span>` : '–'}</td><td>${badge(o.status)}</td></tr>`).join('');
  const sub = `<div class="tbl" style="margin-top:var(--s1)"><table><thead><tr><th>${t('rep.operator2')}</th><th class="n">${t('rep.capZoneNow')}</th><th class="n">${t('rep.cap')}</th><th>${t('rep.utilisation')}</th>${shareCol ? `<th class="n">${t('zv.fleetShare')}</th>` : ''}<th class="n">${t('rep.capZoneTodayMax')}</th><th class="n">${t('rep.capZoneMax30')}</th><th class="n">${t('rep.capZoneDaysOver')}</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  return `<tr><td translate="no">${esc(d.label)}</td><td class="n">${zoneLimitTxt(ctx, d)}</td><td>${badge(d.status)}</td><td class="small muted">${t('rep.capZoneChecked', { m: fmt(k.accuracyM || 0), at: stamp(k.at) })}${k.rest ? `, ${t('zv.rest')}` : ''}${k.superset ? `, ${t('zv.superset')}` : ''}${k.live ? `, ${t('zv.live')}` : ''}${d.hinweis ? `, ${srcTxt(esc, d.hinweis)}` : ''}</td></tr><tr class="rp-zonesub"><td colspan="4">${sub}</td></tr>`;
}
export function capBlock(ctx, c, rep, pop, viol = undefined, s = { show: {} }) {
  const { fmt, esc, opColor } = ctx;
  const hasTotal = c.limit != null;
  const limTxt = hasTotal ? `${fmt(c.limit)}${c.limitDerived ? ` (${DERIVED_TXT_DEF()})` : ''}` : '—';
  const hist = c.previous != null ? t('rep.until', { v0: dd(new Date(Date.parse(`${c.since}T00:00:00Z`) - 86400e3).toISOString().slice(0, 10)), previous: fmt(c.previous) }) : c.next ? `${t('rep.fromDate', { v0: dd(c.next.from) })}: ${fmt(c.next.limit)}` : '';
  // Verfügbar ÷ erlaubt: buchbar ÷ Grenze je Anbieter; ohne Grenze je Anbieter Anteil an der Gesamtgrenze; ohne Zulassung laut Quelle: keine Rate
  const own = (o) => o.limit != null;
  const rate = (o, f) => (o.licensed === false ? null : own(o) ? o[f] : f === 'availShare' ? o.capShareAvail : o.capShare);
  const derivedOf = (o) => (own(o) ? o.derived : c.limitDerived);
  const shareNote = (o) => (o.licensed === false || own(o) ? '' : hasTotal ? `<div class="sub-line">${t('rep.shareOfTotalCap')}</div>` : '');
  const limCell = (o) => (o.licensed === false ? '—' : own(o) ? `${fmt(o.limit)}${o.derived ? `<div class="sub-line">${DERIVED_TXT_DEF()}</div>` : ''}<div class="sub-line">${t('rep.headroom', { n: fmt(Math.max(0, o.limit - o.total)) })}</div>` : '—');
  // Ausschöpfung (gemeldet ÷ erlaubt) direkt am Balken; ohne eigene Grenze der Anteil an der Gesamtgrenze als Text
  const shareLbl = (o) => { const v = rate(o, 'share'); return v == null ? '' : `<div class="sub-line"><b>${rateTxt(ctx, v)}</b>${overMark(v, derivedOf(o))}${own(o) ? '' : ` ${t('rep.shareOfTotalCap')}`}</div>`; };
  const meterCell = (o) => (o.licensed === false ? `<span class="muted small">${t('rep.notInSourceSOperatorList')}</span>` : own(o) ? meter(ctx, o.total, o.limit, o.status === 'hint' ? 'near' : o.status) + shareLbl(o) : `<span class="muted small">${t('rep.noCapPerOperator')}</span>${shareLbl(o)}`);
  const ops = c.operators.map(o => `<tr><td><span class="op"><i style="background:${opColor(o.op)}"></i>${esc(o.op)}</span></td><td class="n">${fmt(o.total)}</td><td class="n">${fmt(o.disabled)}</td><td class="n">${fmt(o.available)}</td><td class="n">${limCell(o)}</td><td style="min-width:120px">${meterCell(o)}</td><td class="n">${rateCell(ctx, rate(o, 'availShare'), false, derivedOf(o))}${shareNote(o)}</td><td>${badge(o.licensed === false ? 'unlicensed' : own(o) ? o.status : 'unknown')}</td></tr>`).join('');
  const zoneNum = (d) => zoneLimitTxt(ctx, d);
  const districts = c.districts.map(d => d.check ? zoneCheckRows(ctx, d) : `<tr><td translate="no">${esc(d.label)}</td><td class="n">${zoneNum(d)}</td><td>${badge('unchecked')}</td><td class="small muted">${d.watch ? `${t('zv.noRuns')}${d.hinweis ? `, ${srcTxt(esc, d.hinweis)}` : ''}` : t('rep.notCheckableWithoutArea', { v0: d.hinweis ? `${srcTxt(esc, d.hinweis)}, ` : '' })}</td></tr>`).join('');
  const per1000 = pop ? (c.total / pop) * 1000 : null;
  const pre = rep?.quality.prelim ? `, ${t('rep.preliminary')}` : '';
  const links = [safeLink(ctx, c.url, c.quelle || t('rep.source')), ...(c.links || []).map((l, i) => safeLink(ctx, l.url, l.quelle || t('rep.source2', { v0: i + 2 })))].join(', ');
  const listTxt = c.listed ? `, ${t('rep.operatorsAccordingToSource', { join: esc(c.listed.join(', ')), v1: c.listComplete ? '' : ` ${t('rep.listIncompleteNoLicenceCheck')}` })}` : '';
  const head = hasTotal
    ? `<div class="rp-cap-total"><div>${meter(ctx, c.total, c.limit, c.status === 'hint' ? 'near' : c.status)}</div><div><span class="big">${fmt(c.total)}</span> <span class="muted">${t('rep.of3', { limit: fmt(c.limit), v1: pctTxt(ctx, c.share, 0) })}</span></div></div>
    <div class="small">${t('rep.bookableOfCap', { available: fmt(c.available), limit: fmt(c.limit) })}${overMark(c.availShare, c.limitDerived)}, ${t('rep.headroomTotal', { n: fmt(Math.max(0, c.limit - c.total)) })}</div>`
    : `<div class="small">${t('rep.reported', { total: fmt(c.total), typeName: esc(typeName(c.type)), v2: c.perOperator != null ? t('rep.noTotalCapCapPerOperatorSee') : t('rep.noCityWideCap') })}</div>`;
  return `<div class="rp-cap"><div class="rp-cap-h"><h3>${esc(c.ort)} <span class="muted small">${esc(typeName(c.type))}${c.art ? `, ${artTxt(esc, c)}` : ''}</span></h3>${badge(c.status)}</div>
    ${head}
    <div class="small muted">${t('rep.totalFleetCapOfficialSource', { limTxt, v1: c.perOperator != null ? `, ${t('rep.perOperator', { perOperator: fmt(c.perOperator), v1: c.perOperatorDerived ? ` (${DERIVED_TXT_DEF()})` : '' })}` : '', v2: hist ? `, ${hist}` : '', v3: c.since && !c.previous ? `, ${t('rep.validSince', { standTxt: esc(standTxt(c.since)) })}` : '', v4: c.stand ? `, ${t('rep.asOf2', { standTxt: esc(standTxt(c.stand)) })}` : '', links, listTxt })}</div>
    ${c.hinweis ? `<div class="small muted">${`<span translate="no">${esc(c.hinweis)}</span>`}</div>` : ''}
    ${ops ? `<div class="tbl"><table><thead><tr><th>${t('rep.operator2')}</th><th class="n">${t('rep.fleet2')}</th><th class="n">${t('rep.ofWhichDisabled')}</th><th class="n">${t('rep.bookable')}</th><th class="n">${t('rep.cap')}</th><th title="${t('rep.reportedCap')}">${t('rep.utilisation')}</th><th class="n" title="${t('rep.bookableCap')}">${t('rep.availableAllowed')}</th><th>Status</th></tr></thead><tbody>${ops}</tbody></table></div>` : emptyBox(t('rep.noInFeed', { typeName: esc(typeName(c.type)) }), t('rep.noOpenFeedCurrentlyReports'))}
    ${districts ? `<div class="tbl"><table><thead><tr><th>${t('rep.subAreaWithItsOwnCap')}</th><th class="n">${t('rep.cap')}</th><th>Status</th><th>${t('rep.note')}</th></tr></thead><tbody>${districts}</tbody></table></div>` : ''}
    ${c.hasRate ? violationsBlock(ctx, c, viol, s) : ''}
    <div class="tiles">${tile(t('rep.per1000Residents', { typeName: esc(typeName(c.type)) }), num(ctx, per1000, 1), pop ? t('rep.vehiclesResidents', { total: fmt(c.total), pop: fmt(pop) }) : t('rep.populationMissing'))}${tile(t('rep.tripsPer1000ResidentsAndDayMeasured'), num(ctx, rep?.totals.per1000Rides, 1), rep ? t('rep.extrapolatedMeasured', { typeName: esc(typeName(c.type)), v1: plural(rep.days.length, t('rep.day'), t('rep.days')), pre }) : t('rep.noDailyFilesYet2'))}</div></div>`;
}
// Einträge ohne Prüfung (nicht amtlich, „keine“): kompakte Tabelle mit Zahl laut Quelle und heutigem Bestand zur Einordnung
export function capInfoTable(ctx, list, title) {
  const { esc, fmt } = ctx; if (!list.length) return '';
  const rows = list.map(c => `<tr><td><b>${esc(c.ort)}</b><div class="sub-line">${esc(typeName(c.type))}${c.art ? `, ${artTxt(esc, c)}` : ''}</div></td><td>${badge(c.status)}<div class="sub-line">${esc(CAPSRC[c.sourceStatus] || c.sourceStatus)}${c.statusText && c.statusText !== R.CAP_SOURCE_STATUS[c.sourceStatus] ? ` – ${srcTxt(esc, c.statusText)}` : ''}</div></td>
    <td class="small">${c.sourceStatus === 'keine' ? '—' : capInfoTxt(ctx, c) || '—'}</td><td class="n">${fmt(c.total)}</td><td class="small">${safeLink(ctx, c.url, c.quelle || t('rep.source'))}${c.stand ? `, ${esc(standTxt(c.stand))}` : ''}</td></tr>`).join('');
  return `<h3 style="font-size:.875rem;margin:var(--s4) 0 var(--s1)">${title}</h3><div class="tbl" tabindex="0" role="region" aria-label="${esc(title)}"><table><thead><tr><th>${t('rep.city')}</th><th>${t('rep.sourceStatus')}</th><th>${t('rep.figureAccordingToSource')}</th><th class="n">${t('rep.fleetToday')}</th><th>${t('rep.source')}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
