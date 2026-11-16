// @ts-check
// Mobility Pulse — Reiter ÖPNV, weitere Tafeln: Linien nach Zuverlässigkeit und Tagesgang ÖPNV gegen Sharing (Nachtnetz-Lücke).
// Daten: oepnv/<AGS>.json (lines, profile; seit Format 1.1). Texte unter pt.* (Bereich oepnv).
import { t } from './i18n.js';

const csvNum = (/** @type {number | null} */ x, d = 1) => (x == null ? '' : (+x).toFixed(d).replace('.', ','));
const artTxt = (/** @type {string} */ a) => (a === 'bus' ? t('pt.artBus') : a === 'tram' ? t('pt.artTram') : a === 'bahn' ? t('pt.artBahn') : t('pt.artSonst'));
const pct = (/** @type {any} */ ctx, /** @type {number | null} */ x, d = 1) => (x == null || !Number.isFinite(x) ? '–' : `${ctx.fmt(x * 100, d)} %`);

/** Linien mit dem höchsten Anteil ausgefallener oder verspäteter Halte (ab 40 Halten in der Summe) */
/** @param {any} ctx @param {any} doc @param {number} days */
export function linesPanel(ctx, doc, days) {
  const R = doc?.lines?.rows || [], f = ctx.fmt; if (!doc) return '';
  const worst = R.filter((/** @type {any[]} */ r) => r[2] >= 40).map((/** @type {any[]} */ r) => ({ r, q: (r[3] + r[4]) / r[2] })).sort((/** @type {any} */ a, /** @type {any} */ b) => b.q - a.q || b.r[2] - a.r[2]).slice(0, 15);
  return `<div class="panel" id="pt-lines-panel"><div class="panel-head"><div><h2>${t('pt.lnTitle')}</h2><div class="sub">${t('pt.lnSub', { n: f(R.length), days: f(days, 1) })}</div></div>
    <div class="panel-actions"><button class="chip" type="button" id="pt-ln-csv"${R.length ? '' : ' disabled'}>${t('pt.csv')}</button></div></div>
    ${worst.length ? `<div class="tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('pt.lnTitle'))}"><table id="pt-lines"><thead><tr><th>${t('pt.colLine')}</th><th>${t('pt.colArt')}</th><th class="n">${t('pt.colPerDay')}</th><th class="n">${t('pt.colSkip')}</th><th class="n">${t('pt.colLate')}</th><th class="n">${t('pt.colDelay')}</th></tr></thead><tbody>
    ${worst.map((/** @type {any} */ { r }) => `<tr><td>${ctx.esc(r[0])}</td><td>${artTxt(r[1])}</td><td class="n">${f(r[2] / days)}</td><td class="n">${pct(ctx, r[3] / r[2])}</td><td class="n">${pct(ctx, r[4] / r[2])}</td><td class="n">${r[5] == null ? '–' : f(r[5], 1)}</td></tr>`).join('')}</tbody></table></div>
    <p class="muted small">${t('pt.lnNote')}</p>` : `<div class="empty">${R.length ? t('pt.lnFew') : t('pt.lnEmpty')}</div>`}</div>`;
}
/** Tagesgang: Stunden, in denen der ÖPNV kaum fährt und Sharing genutzt wird */
/** @param {any} ctx @param {any} doc @param {string} name */
export function profilePanel(ctx, doc, name) {
  const P = doc?.profile, f = ctx.fmt; if (!doc) return '';
  if (!P) return `<div class="panel" id="pt-profile-panel"><div class="panel-head"><div><h2>${t('pt.pfTitle')}</h2></div></div><div class="empty">${t('pt.pfEmpty', { name })}</div></div>`;
  const tot = P.sharing.reduce((/** @type {number} */ s, /** @type {number} */ x) => s + x, 0), gapSum = P.gap.reduce((/** @type {number} */ s, /** @type {number} */ h) => s + P.sharing[h], 0), peak = Math.max(...P.pt), peakS = Math.max(...P.sharing, 1);
  // zusammenhängende Stunden als Spannen (23 und 0 Uhr gehören zusammen)
  const spans = []; for (const h of P.gap) { const l = spans[spans.length - 1]; if (l && l[1] === h) l[1] = h + 1; else spans.push([h, h + 1]); }
  if (spans.length > 1 && spans[0][0] === 0 && spans[spans.length - 1][1] === 24) { spans[0][0] = spans.pop()[0]; }
  const spanTxt = spans.map(([a, b]) => t('pt.pfSpan', { a, b: b % 24 })).join(', ');
  const bar = (/** @type {number} */ x, /** @type {number} */ max, /** @type {string} */ c) => `<span class="pt-bar-cell"><i style="width:${Math.round(100 * x / (max || 1))}%;background:${c}"></i></span>`;
  return `<div class="panel" id="pt-profile-panel"><div class="panel-head"><div><h2>${t('pt.pfTitle')}</h2><div class="sub">${t('pt.pfSub', { days: f(P.days) })}</div></div></div>
    <p>${P.gap.length ? t('pt.pfGap', { name, spans: spanTxt, share: pct(ctx, P.gapShare, 0), n: `<b>${f(gapSum, 0)}</b>`, p: pct(ctx, tot ? gapSum / tot : null) }) : t('pt.pfNoGap', { name, share: pct(ctx, P.gapShare, 0), min: f(P.minSharing) })}</p>
    <div class="tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('pt.pfTitle'))}"><table id="pt-profile"><thead><tr><th>${t('pt.colHour')}</th><th class="n">${t('pt.colPtStops')}</th><th aria-hidden="true"></th><th class="n">${t('pt.colShareStarts')}</th><th aria-hidden="true"></th><th>${t('pt.colState')}</th></tr></thead><tbody>
    ${P.pt.map((/** @type {number} */ n, /** @type {number} */ h) => `<tr><td>${h}–${h + 1} h</td><td class="n">${f(n)}</td><td aria-hidden="true">${bar(n, peak, 'var(--muted)')}</td><td class="n">${f(P.sharing[h], 1)}</td><td aria-hidden="true">${bar(P.sharing[h], peakS, 'var(--accent)')}</td><td>${P.gap.includes(h) ? `▲ ${t('pt.pfIsGap')}` : ''}</td></tr>`).join('')}</tbody></table></div>
    <p class="muted small">${t('pt.pfNote', { share: pct(ctx, P.gapShare, 0), min: f(P.minSharing) })}</p></div>`;
}
/** @param {HTMLElement} el @param {any} doc @param {string} ags @param {number} days @param {(name: string, text: string) => void} download */
export function bindMehr(el, doc, ags, days, download) {
  el.querySelector('#pt-ln-csv')?.addEventListener('click', () => download(`oepnv_linien_${ags}.csv`, ['linie;art;halte_je_tag;ausgefallen_anteil;verspaetet_anteil;verspaetung_min', ...(doc?.lines?.rows || []).map((/** @type {any[]} */ r) => [`"${String(r[0]).replace(/"/g, '""')}"`, r[1], csvNum(r[2] / days), csvNum(r[3] / r[2], 3), csvNum(r[4] / r[2], 3), csvNum(r[5])].join(';'))].join('\n') + '\n'));
}
