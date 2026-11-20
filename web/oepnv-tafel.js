// @ts-check
// Mobility Pulse — Suche, Abfahrtstafel und „Linie ausgefallen? Sharing entlang der Strecke“ (18.11.2026, F29/F35) für die Live-Karte im Reiter ÖPNV.
// Rechnet mit lib/pulse-oepnv-tafel.js aus der Live-Datei; Zustand der Karte (Linienfilter, Fokus) steht in M (oepnv-karte.js).
import * as TF from './pulse-oepnv-tafel.js';
import { t, dateFmt } from './i18n.js';

const tm = (/** @type {number} */ ms) => dateFmt({ hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' }).format(new Date(ms));
const LINE_PREFIX = () => t('pt.findLinePrefix');

/** Suchfeld mit Vorschlägen (Linien und Stationen) und Schnellwahl der Linien mit vielen Ausfällen heute */
/** @param {any} ctx @param {any} live @param {any[][]} lineRows */
export function findHtml(ctx, live, lineRows) {
  const ix = TF.searchIndex(live), cl = TF.cancelledLines(lineRows || []), pct = (/** @type {number} */ x) => `${ctx.fmt(Math.round(x * 100))} %`;
  return `<div class="pt-find"><label for="pt-find">${t('pt.findLabel')}</label> <input id="pt-find" list="pt-find-list" autocomplete="off" placeholder="${ctx.esc(t('pt.findPh'))}">
    <datalist id="pt-find-list">${ix.lines.slice(0, 200).map(l => `<option value="${ctx.esc(`${LINE_PREFIX()} ${l.name}`)}"></option>`).join('')}${ix.stations.slice(0, 800).map(s => `<option value="${ctx.esc(s.name)}"></option>`).join('')}</datalist>
    <button type="button" class="chip" id="pt-find-clear" hidden>${t('pt.findClear')}</button>
    ${cl.length ? `<p class="small" id="pt-cl">${t('pt.clLead')} ${cl.map(x => `<button type="button" class="chip" data-line="${ctx.esc(x.linie)}">${ctx.esc(x.linie)} (${pct(x.share)})</button>`).join(' ')}</p>` : ''}
    <div id="pt-find-out" aria-live="polite"></div></div>`;
}

/** Abfahrtstafel einer Station */
/** @param {any} ctx @param {any} live @param {string} name */
function boardHtml(ctx, live, name) {
  const dep = TF.departures(live, name, Date.now());
  if (!dep.length) return `<p class="small">${t('pt.boardNone', { name: ctx.esc(name) })}</p>`;
  const late = (/** @type {{ verspaetung_s: number|null, plan?: boolean }} */ d) => { const s = d.verspaetung_s; return d.plan ? t('pt.planShort') : s == null ? t('pt.noDelay') : s >= 60 ? `+${ctx.fmt(Math.round(s / 60))} min` : t('pt.onTime'); };
  return `<h3>${t('pt.boardTitle', { name: ctx.esc(name) })}</h3><div class="tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('pt.boardTitle', { name }))}"><table><thead><tr><th>${t('pt.colTime')}</th><th>${t('pt.colLine')}</th><th>${t('pt.colDest')}</th><th class="n">${t('pt.colDelay')}</th></tr></thead><tbody>
    ${dep.map(d => `<tr><td>${tm(d.at)}</td><td>${ctx.esc(d.linie || t('pt.noLine'))}</td><td>${d.endet ? t('pt.boardEnds') : ctx.esc(d.ziel || '–')}</td><td class="n">${late(d)}</td></tr>`).join('')}</tbody></table></div>
    <p class="muted small">${t('pt.boardNote')}</p>`;
}

/** Stationen entlang einer Linie mit Sharing-Fahrzeugen im Umkreis */
/** @param {any} ctx @param {any} live @param {string} line @param {any[]|null} fleet */
function lineHtml(ctx, live, line, fleet) {
  const n = (live?.trips || []).filter((/** @type {any[]} */ r) => r[0] === line).length, rows = TF.alongLine(live, line, fleet || []);
  const lead = t('pt.lineLead', { l: ctx.esc(line), n: ctx.fmt(n), s: ctx.fmt(rows.length), low: ctx.fmt(rows.filter(r => r.low).length), r: TF.TAFEL.radiusM });
  if (!rows.length) return `<p class="small">${lead}</p>`;
  return `<h3>${t('pt.lineTitle', { l: ctx.esc(line) })}</h3><p class="small">${lead}</p>${fleet ? '' : `<p class="muted small">${t('pt.lineNoFleet')}</p>`}
    <div class="tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('pt.lineTitle', { l: line }))}"><table><thead><tr><th>${t('pt.colStation')}</th><th class="n">${t('pt.colShare300')}</th><th>${t('pt.colHint')}</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td>${ctx.esc(r.name || t('pt.lineStop'))}</td><td class="n">${fleet ? ctx.fmt(r.vehicles) : '–'}</td><td>${fleet && r.low ? `▲ ${t('pt.lineLow')}` : ''}</td></tr>`).join('')}</tbody></table></div>`;
}

/**
 * Ereignisse binden. onLine(name|null) setzt den Linienfilter der Karte, onStation({ name, lat, lon }|null) den Fokus.
 * @param {any} ctx @param {HTMLElement} el @param {() => any} liveOf @param {() => any[]|null} fleetOf
 * @param {{ onLine: (l: string|null) => void, onStation: (s: any) => void }} cb
 */
export function bindFind(ctx, el, liveOf, fleetOf, cb) {
  const inp = /** @type {HTMLInputElement | null} */ (el.querySelector('#pt-find')), out = el.querySelector('#pt-find-out'), clr = /** @type {HTMLElement | null} */ (el.querySelector('#pt-find-clear'));
  if (!inp || !out) return;
  const show = (/** @type {string} */ v) => {
    const live = liveOf(), q = v.trim(), pre = `${LINE_PREFIX()} `;
    if (!q) { out.innerHTML = ''; cb.onLine(null); cb.onStation(null); if (clr) clr.hidden = true; return; }
    const ix = TF.searchIndex(live), ln = q.startsWith(pre) ? q.slice(pre.length) : (ix.lines.find(l => l.name.toLowerCase() === q.toLowerCase())?.name ?? null);
    if (ln != null && ix.lines.some(l => l.name === ln)) { cb.onStation(null); cb.onLine(ln); out.innerHTML = lineHtml(ctx, live, ln, fleetOf()); }
    else { const st = ix.stations.find(s => s.name === q) || ix.stations.find(s => s.name.toLowerCase().includes(q.toLowerCase()));
      cb.onLine(null); if (st) { cb.onStation(st); out.innerHTML = boardHtml(ctx, live, st.name); } else { cb.onStation(null); out.innerHTML = `<p class="small">${t('pt.findNone', { q: ctx.esc(q) })}</p>`; } }
    if (clr) clr.hidden = false;
  };
  inp.addEventListener('change', () => show(inp.value));
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); show(inp.value); } });
  clr?.addEventListener('click', () => { inp.value = ''; show(''); inp.focus(); });
  for (const b of el.querySelectorAll('#pt-cl [data-line]')) b.addEventListener('click', () => { inp.value = `${LINE_PREFIX()} ${/** @type {HTMLElement} */ (b).dataset.line}`; show(inp.value); });
}
