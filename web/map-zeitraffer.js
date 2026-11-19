// @ts-check
// Mobility Pulse — Kartenebene „Zeitraffer“ (F33): verfügbare Fahrzeuge je Zelle in sechs Tagesbändern des letzten vollen Tages, Abspielen auf der
// Karte und als GIF zum Teilen (nur Zellen, keine Einzelfahrzeuge; lib/pulse-zeitraffer.js). Nachgeladen von app-map.js, sobald die Ebene gewählt ist.
import * as ZR from './pulse-zeitraffer.js';
import { t } from './i18n.js';
import { TIMELAPSE } from './tokens.js';

/* global L */
const { ramp: RAMP, ink: INK, muted: MUTED, line: LINE, bg: BG } = TIMELAPSE;
const PAL = [BG, ...RAMP, INK, MUTED, LINE].map(h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)));
const cls = (/** @type {number} */ v, /** @type {number} */ scale) => { const r = v / scale; return r < 0.15 ? 1 : r < 0.35 ? 2 : r < 0.6 ? 3 : r < 0.9 ? 4 : 5; };
let timer = 0;
export function stop() { if (timer) clearInterval(timer); timer = 0; }

/** @param {any} c Kontext aus app-map.js: state, $, fmt, tok, notice, clearNotice, loadUsageIndex, loadCells, scopeState, CELL_LAT, CELL_LON, cellCenterOf, muniName */
export async function renderTimelapse(c) {
  stop();
  const { state } = c, L_ = state.layers; L_.grid.clearLayers();
  const idx = await c.loadUsageIndex(), st = c.scopeState();
  if (state.scope === 'DE' || !st) { c.notice(() => t('app.servedCellsPleaseChoose'), '', 'flow'); return; }
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date()), all = idx?.cellDays || [];
  const day = [...all].reverse().find(d => d < today) || all.at(-1); if (!day) { c.notice(() => t('app.noCellDataYet'), '', 'flow'); return; }
  const D = ZR.bandDensity(await c.loadCells(day, st), state.scope);
  if (!D) { c.notice(() => t('app.noCellDataYet'), '', 'flow'); return; }
  c.clearNotice('flow');
  const col = c.tok('--accent'), rects = new Map();
  for (const cell of D.cells) { const [lat, lon] = c.cellCenterOf(cell); rects.set(cell, L.rectangle([[lat - c.CELL_LAT / 2, lon - c.CELL_LON / 2], [lat + c.CELL_LAT / 2, lon + c.CELL_LON / 2]], { weight: 0, fillColor: col, fillOpacity: 0 }).addTo(L_.grid)); }
  const have = D.bands.map((/** @type {any} */ m, /** @type {number} */ b) => (m ? b : -1)).filter((/** @type {number} */ b) => b >= 0);
  let band = have.find((/** @type {number} */ b) => b === 4) ?? have[0] ?? 0; // Start 15–19 Uhr, die Hauptzeit
  const dayTxt = day.split('-').reverse().join('.'), name = c.muniName(state.scope);
  const show = (/** @type {number} */ b) => {
    band = b; const m = D.bands[b];
    for (const [cell, r] of rects) { const v = m?.get(cell) || 0; r.setStyle({ fillOpacity: v ? 0.1 + 0.7 * Math.min(1, v / D.scale) : 0 }); r.bindPopup(t('app.tlCell', { v: c.fmt(v, 1), band: ZR.bandLabel(b) })); }
    const lab = c.$('#tl-label'), rng = /** @type {HTMLInputElement|null} */ (c.$('#tl-band')); if (lab) lab.textContent = m ? t('app.tlBand', { band: ZR.bandLabel(b) }) : t('app.tlNoBand', { band: ZR.bandLabel(b) }); if (rng) rng.value = String(b);
  };
  c.$('#map-legend').innerHTML = `<span><i class="dot" style="background:var(--accent)"></i>${t('app.tlLegend', { day: dayTxt, n: c.fmt(D.cells.length) })}</span>
    <button type="button" id="tl-play" aria-pressed="false">${t('app.tlPlay')}</button><input type="range" id="tl-band" min="0" max="${ZR.ZEIT.bands - 1}" step="1" value="${band}" aria-label="${t('app.tlRange')}"><b id="tl-label" aria-live="polite"></b>
    <button type="button" id="tl-gif">${t('app.tlGif')}</button>`;
  show(band);
  c.$('#tl-band').addEventListener('input', (/** @type {any} */ e) => { stop(); setPlay(false); show(+e.target.value); });
  const setPlay = (/** @type {boolean} */ on) => { const b = c.$('#tl-play'); if (b) { b.setAttribute('aria-pressed', String(on)); b.textContent = on ? t('app.tlPause') : t('app.tlPlay'); } };
  c.$('#tl-play').addEventListener('click', () => {
    if (timer) { stop(); setPlay(false); return; }
    setPlay(true); timer = /** @type {any} */ (setInterval(() => { if (!document.body.contains(c.$('#tl-play'))) { stop(); return; } const i = have.indexOf(band); show(have[(i + 1) % have.length]); }, ZR.ZEIT.delayCs * 10));
  });
  c.$('#tl-gif').addEventListener('click', () => {
    const gif = gifOf(D, have, `${name} · ${dayTxt}`), a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([/** @type {any} */ (gif)], { type: 'image/gif' })); a.download = `mobility-pulse_zeitraffer_${state.scope}_${day}.gif`;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  });
}

/** Bilder je Band auf einer Leinwand zeichnen und auf die feste Palette bringen (Schrift wird dabei hart, Zellen bleiben exakt) */
function gifOf(/** @type {any} */ D, /** @type {number[]} */ have, /** @type {string} */ title) {
  const ab = D.cells.map((/** @type {string} */ x) => x.split(':').map(Number)), a0 = Math.min(...ab.map((/** @type {number[]} */ p) => p[0])), a1 = Math.max(...ab.map((/** @type {number[]} */ p) => p[0]));
  const b0 = Math.min(...ab.map((/** @type {number[]} */ p) => p[1])), b1 = Math.max(...ab.map((/** @type {number[]} */ p) => p[1])), cols = b1 - b0 + 1, rows = a1 - a0 + 1;
  const px = Math.max(2, Math.min(14, Math.floor(560 / Math.max(cols, rows)))), pad = 16, top = 46, W = Math.max(620, cols * px + 2 * pad), H = top + rows * px + pad + 18;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = /** @type {CanvasRenderingContext2D} */ (cv.getContext('2d'));
  // Schrift nur auf Weiß, Dunkel, Grau und Linie abbilden (sonst färben Kantenpixel grün)
  const TXT = [0, 6, 7, 8], near = new Map(), idxOf = (/** @type {number} */ r, /** @type {number} */ gg, /** @type {number} */ b, /** @type {boolean} */ text) => {
    const k = ((r << 16) | (gg << 8) | b) * 2 + (text ? 1 : 0); let i = near.get(k);
    if (i == null) { let best = 1e9; (text ? TXT : PAL.map((_, j) => j)).forEach((j) => { const p = PAL[j], d = (p[0] - r) ** 2 + (p[1] - gg) ** 2 + (p[2] - b) ** 2; if (d < best) { best = d; i = j; } }); near.set(k, i); }
    return i; };
  const frames = have.map((b) => {
    g.fillStyle = BG; g.fillRect(0, 0, W, H);
    g.fillStyle = INK; g.font = '600 15px system-ui, sans-serif'; g.fillText(`${title} · ${t('app.tlBand', { band: ZR.bandLabel(b) })}`, pad, 22);
    g.fillStyle = MUTED; g.font = '11px system-ui, sans-serif'; g.fillText(t('app.tlGifSub'), pad, 38);
    g.strokeStyle = LINE; g.strokeRect(pad - 0.5, top - 0.5, cols * px + 1, rows * px + 1);
    for (const [cell, v] of D.bands[b]) { const [a, bb] = cell.split(':').map(Number); g.fillStyle = RAMP[cls(v, D.scale) - 1]; g.fillRect(pad + (bb - b0) * px, top + (a1 - a) * px, px, px); }
    g.fillStyle = MUTED; g.fillText('Mobility Pulse · offene GBFS-Feeds · fcou1005.github.io/mobility-pulse', pad, H - 6);
    const img = g.getImageData(0, 0, W, H).data, out = new Uint8Array(W * H);
    for (let i = 0; i < out.length; i++) { const y = Math.floor(i / W); out[i] = idxOf(img[i * 4], img[i * 4 + 1], img[i * 4 + 2], y < top - 1 || y > top + rows * px); }
    return { pixels: out };
  });
  return ZR.gifEncode(frames, W, H, PAL);
}
