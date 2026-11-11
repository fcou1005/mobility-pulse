// Wetter in den Diagrammen: Stundenwerte (Temperatur, Niederschlag) aus dem Wetter-Cache des Sammlers (weather/<UTC-Tag>.json, DWD über Bright Sky),
// derselbe Stand, mit dem die Prognose rechnet. Gemeinde: ihre Wetterzelle; ganz Deutschland: Mittel über alle Zellen.
import { t, numFmt } from './i18n.js?v=mwcnh5v3';

const TZ = 'Europe/Berlin';
const HOUR_B = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: TZ }), DAY_B = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const hourOfB = (ms) => +HOUR_B.format(new Date(ms)) % 24;
const dayOfB = (ms) => DAY_B.format(new Date(ms));
/** Ortstag + Ortsstunde (Europe/Berlin) → UTC (ms) */
export function localUtc(day, h) {
  const [y, m, d] = String(day).split('-').map(Number); let x = Date.UTC(y, m - 1, d, h) - 3600e3;
  if (hourOfB(x) !== h || dayOfB(x) !== day) x -= 3600e3;
  return x;
}
const CACHE = new Map();
/** Neuer Sammler-Lauf: Wetter neu laden */
export const resetWeatherCache = () => CACHE.clear();
/**
 * slots: [[Ortstag, Ortsstunde]] → je Slot { t: °C, p: mm/h } oder null. scope = AGS (Wetterzelle der Gemeinde) oder null (Mittel aller Zellen).
 * getJson(url, opts) → { ok, json }; base = Datenzweig-URL (endet auf /).
 */
export async function weatherFor(slots, scope, getJson, base) {
  const ts = slots.map(([d, h]) => localUtc(d, h)), days = [...new Set(ts.map(x => new Date(x).toISOString().slice(0, 10)))];
  const docs = new Map(await Promise.all(days.map(async (d) => {
    const k = `${base}weather/${d}.json`;
    if (!CACHE.has(k)) CACHE.set(k, Promise.resolve(getJson(k, { timeout: 30000 })).then(r => (r?.ok ? r.json : null)).catch(() => null));
    return [d, await CACHE.get(k)];
  })));
  const ok = (v) => Number.isFinite(v) && Math.abs(v) < 60;
  return ts.map((x) => {
    const doc = docs.get(new Date(x).toISOString().slice(0, 10)); if (!doc?.hours?.length || !doc.cells) return null;
    const i = Math.round((x - Date.parse(doc.hours[0])) / 3600e3); if (!(i >= 0 && i < doc.hours.length)) return null;
    const cells = scope ? [doc.cells[doc.ags?.[scope]]].filter(Boolean) : Object.values(doc.cells);
    const tv = cells.map(c => c?.t?.[i]).filter(ok), pv = cells.map(c => c?.p?.[i]).filter(v => Number.isFinite(v) && v >= 0 && v < 200);
    return tv.length ? { t: tv.reduce((a, b) => a + b, 0) / tv.length, p: pv.length ? pv.reduce((a, b) => a + b, 0) / pv.length : null } : null;
  });
}
const f1 = (v) => numFmt(1).format(v);
/**
 * Wetterstreifen (SVG) unter einem Stundendiagramm mit derselben x-Achse: viewBox-Breite W, Ränder pl/pr, eine Spalte je Wert.
 * Temperatur als Linie (eigene Skala, Min/Max links), Niederschlag als Balken von unten (Maximum rechts). hours: Ortsstunde je Spalte (Tooltip).
 */
export function weatherSvg(vals, { W, pl, pr, hours = [], H = 84, esc = (s) => s, svgAttrs = '' }) {
  const have = vals.filter(Boolean); if (!have.length) return '';
  const n = vals.length, bw = (W - pl - pr) / n, top = 10, bot = H - 6, rainH = 26;
  const ts = have.map(v => v.t), lo = Math.floor(Math.min(...ts) - 0.5), hi = Math.ceil(Math.max(...ts) + 0.5), y = (v) => top + (bot - top - 4) * (1 - (v - lo) / Math.max(1, hi - lo));
  const pmax = Math.max(0, ...have.map(v => v.p ?? 0)), pScale = Math.max(1, pmax);
  const rain = vals.map((v, i) => (v?.p > 0.05 ? `<rect class="wx-p" x="${(pl + i * bw + 1).toFixed(1)}" y="${(bot - rainH * v.p / pScale).toFixed(1)}" width="${Math.max(1.2, bw - 2).toFixed(1)}" height="${(rainH * v.p / pScale).toFixed(1)}"/>` : '')).join('');
  let d = '', open = false;
  vals.forEach((v, i) => { if (!v) { open = false; return; } d += `${open ? 'L' : 'M'}${(pl + i * bw + bw / 2).toFixed(1)} ${y(v.t).toFixed(1)}`; open = true; });
  const hit = vals.map((v, i) => (v ? `<rect class="hit" x="${(pl + i * bw).toFixed(1)}" y="0" width="${bw.toFixed(1)}" height="${H}"><title>${esc(t('wx.tip', { h: String(hours[i] ?? '').padStart(2, '0'), t: f1(v.t), p: v.p == null ? '–' : f1(v.p) }))}</title></rect>` : '')).join('');
  // Min/Max links neben der Achse; ohne linken Rand (pl < 24) innen am linken Rand
  const lx = pl >= 24 ? pl - 5 : pl + 2, la = pl >= 24 ? 'end' : 'start';
  const lab = `<text x="${lx}" y="${(y(hi) + 4).toFixed(1)}" text-anchor="${la}">${hi}°</text><text x="${lx}" y="${(y(lo) + 4).toFixed(1)}" text-anchor="${la}">${lo}°</text>`
    + (pmax > 0.05 ? `<text x="${W - pr}" y="9" text-anchor="end" class="wx-pl">${esc(t('wx.rainMax', { p: f1(pmax) }))}</text>` : '');
  return `<svg viewBox="0 0 ${W} ${H}" ${svgAttrs} role="img" aria-label="${esc(t('wx.aria', { lo, hi, p: f1(pmax) }))}"><line class="gl" x1="${pl}" x2="${W - pr}" y1="${bot}" y2="${bot}"/>${rain}<path class="wx-t" d="${d}"/>${lab}${hit}</svg>`;
}
export const WX_CSS = '.wx-t{fill:none;stroke:var(--warn);stroke-width:2;stroke-linejoin:round}.wx-p{fill:color-mix(in srgb,var(--info) 55%,transparent)}.wx-pl{fill:var(--info)}';
