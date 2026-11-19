// @ts-check
// Disposition: Plan-Erfolgskontrolle (F31). Ein Plan wird im Browser gemerkt (localStorage, nur für diesen Browser); sobald ein Band nach dem Plan
// gemessen ist, zeigt die Tabelle, ob die Zielzellen befüllt wurden und wie viele Fahrten dort danach begannen – gegen die Vergleichstage und gegen die
// übrigen Zellen der Gemeinde (lib/pulse-ops-check.js).
import * as O from './pulse-ops.js';
import { t } from './i18n.js';
import { $, DAY_BERLIN, HOUR_BERLIN, S, X } from './ops-data.js';

const KEY = 'mp-plan-kontrolle';
const read = () => { try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const write = (/** @type {any[]} */ list) => { try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, O.CHECK.keep))); return true; } catch { return false; } };
const weekend = (/** @type {string} */ d) => [0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay());
const pct = (/** @type {number} */ x) => `${x < 0 ? '−' : '+'}${X.fmt(Math.abs(x) * 100, 0)} %`;

function ensurePanel() {
  if ($('#ops-chk-panel')) return;
  const after = $('#ops-soll-panel') || $('#ops-shift-panel'); if (!after) return;
  after.insertAdjacentHTML('afterend', `<div class="panel c12" id="ops-chk-panel"><div class="panel-head"><div><h2>${t('ops.chkTitle')}</h2><div class="sub">${t('ops.chkSub')}</div></div>
    <div class="inline-form"><button id="ops-chk-save" type="button" disabled>${t('ops.chkSave')}</button></div></div><div id="ops-chk-out" aria-live="polite"></div></div>`);
  $('#ops-chk-save').addEventListener('click', () => {
    const p = S.plan, st = X.state.latest?.municipalities?.[p?.ags]?.state, now = new Date();
    const rec = p && st ? O.planRecord(p, { at: now.getTime(), day: DAY_BERLIN.format(now), hour: +HOUR_BERLIN.format(now) % 24, state: st, name: X.muniName(p.ags) }) : null;
    if (!rec) return;
    const okW = write([rec, ...read().filter(r => !(r.ags === rec.ags && r.op === rec.op && r.day === rec.day && r.band === rec.band))]);
    $('#ops-chk-save').textContent = okW ? t('ops.chkSaved') : t('ops.chkNoStorage');
    renderChecks();
  });
  $('#ops-chk-out').addEventListener('click', (/** @type {any} */ e) => { const at = e.target?.closest?.('button[data-at]')?.dataset.at; if (!at) return; write(read().filter(r => String(r.at) !== at)); renderChecks(); });
}

/** Knopf freigeben, gemerkte Pläne prüfen (aufgerufen nach jeder neuen Planung) */
export function renderPlanCheck() {
  ensurePanel(); const b = $('#ops-chk-save'); if (!b) return;
  const has = !!S.plan?.rebalance?.needs?.some((/** @type {any} */ n) => n.need > 0);
  b.disabled = !has; b.textContent = t('ops.chkSave'); b.title = has ? '' : t('ops.chkNoTargets');
  renderChecks();
}

async function renderChecks() {
  const out = $('#ops-chk-out'); if (!out) return;
  const list = read();
  if (!list.length) { out.innerHTML = `<div class="empty">${t('ops.chkNone')}</div>`; return; }
  const idx = await X.loadUsageIndex(), cellDays = idx?.cellDays || [];
  const rows = await Promise.all(list.map(async (rec) => {
    const prev = cellDays.filter((/** @type {string} */ d) => d < rec.day).slice(-O.CHECK.baseDays);
    const [dayDoc, ...baseDocs] = await Promise.all([rec.day, ...prev].map(d => (cellDays.includes(d) ? X.loadCells(d, rec.state) : null)));
    return { rec, r: O.planCheck(rec, dayDoc, baseDocs.filter(Boolean), { weekend }) };
  }));
  const when = (/** @type {any} */ rec) => `${rec.day.split('-').reverse().join('.')}, ${t(`band.${rec.band}`)}`;
  out.innerHTML = `<div class="tbl" tabindex="0" role="region" aria-label="${X.esc(t('ops.chkTitle'))}"><table id="ops-chk"><thead><tr><th>${t('ops.chkWhen')}</th><th>${t('ops.chkWho')}</th><th class="n">${t('ops.chkFilled')}</th><th class="n">${t('ops.chkStarts')}</th><th class="n">${t('ops.chkEffect')}</th><th></th></tr></thead><tbody>
    ${rows.map(({ rec, r }) => `<tr><td>${when(rec)}</td><td>${X.esc(rec.name || rec.ags)} · ${X.esc(rec.op)}</td>
      ${r.status === 'ok' ? `<td class="n">${t('ops.chkOfN', { k: X.fmt(r.filled), n: X.fmt(r.spots) })}</td><td class="n">${X.fmt(r.after)} <span class="muted">(${t('ops.chkUsual', { v: X.fmt(r.afterBase, 1) })})</span></td>
        <td class="n">${r.effect == null ? `<span class="muted">${t('ops.chkFew')}</span>` : `<b>${pct(r.effect)}</b> <span class="muted small">${t('ops.chkVs', { t: pct((r.ratioT ?? 1) - 1), c: pct((r.ratioC ?? 1) - 1) })}</span>`}</td>`
        : `<td class="n" colspan="3"><span class="muted">${r.status === 'wartet' ? t('ops.chkWait') : t('ops.chkNoData')}</span></td>`}
      <td><button type="button" class="link" data-at="${rec.at}" aria-label="${X.esc(t('ops.chkRemove'))}">✕</button></td></tr>`).join('')}</tbody></table></div>
    <p class="muted small">${t('ops.chkNote')}</p>`;
}
