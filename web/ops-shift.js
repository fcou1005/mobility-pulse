// @ts-check
// Disposition, Sprint 6: Schichtplaner (S6.4), Soll je Tageszeit (S6.3), Tour als Link/QR-Code für den Fahrermodus (S6.2)
import * as O from './pulse-ops.js';
import { encodeTour, makeTour } from './pulse-fahrer.js';
import { t, lang } from './i18n.js';
import { $, DAY_BERLIN, S, X, allRuns, download, slug } from './ops-data.js';

const SH = { plan: null, soll: null, forPlan: null };
const minOf = (v, d) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '')); return m ? +m[1] * 60 + +m[2] : d; };
const hm = O.minText;

function ensurePanels() {
  if ($('#ops-shift-panel')) return;
  const after = $('#ops-spots')?.closest('.panel'); if (!after) return;
  const bands = O.BANDS.map(b => `<option value="${b.id}"${b.id === 1 ? ' selected' : ''}>${X.esc(t(`band.${b.id}`))}</option>`).join('');
  after.insertAdjacentHTML('afterend', `
  <div class="panel c12" id="ops-shift-panel"><div class="panel-head"><div><h2>${t('ops.shiftTitle')}</h2><div class="sub" id="ops-shift-sub">${t('ops.shiftSub')}</div></div>
    <form class="inline-form" id="ops-shift-form" novalidate>
      <label>${t('ops.shiftDrivers')}<input type="number" id="ops-shift-n" value="2" min="1" max="12" inputmode="numeric"></label>
      <label>${t('ops.shiftFrom')}<input type="time" id="ops-shift-from" value="06:00"></label>
      <label>${t('ops.shiftTo')}<input type="time" id="ops-shift-to" value="14:00"></label>
      <button class="primary" id="ops-shift-run" type="submit">${t('ops.shiftRun')}</button>
      <button id="ops-shift-csv" type="button" disabled>${t('ops.shiftCsv')}</button>
    </form></div>
    <div id="ops-shift-out" aria-live="polite"></div></div>
  <div class="panel c12" id="ops-soll-panel"><div class="panel-head"><div><h2>${t('ops.sollTitle')}</h2><div class="sub" id="ops-soll-sub"></div></div>
    <div class="inline-form"><label>${t('ops.sollBand')}<select id="ops-soll-band">${bands}</select></label>
      <button id="ops-soll-spots" type="button" disabled>${t('ops.sollSpotsCsv')}</button><button id="ops-soll-csv" type="button" disabled>${t('ops.sollCsv')}</button></div></div>
    <div class="tbl" tabindex="0" role="region" aria-label="${X.esc(t('ops.sollTitle'))}"><table id="ops-soll"><thead><tr><th>${t('ops.sollCell')}</th><th class="n">${t('ops.sollTarget')}</th><th class="n">${t('ops.sollRate')}</th><th class="n">${t('ops.sollRaw')}</th><th class="n">${t('ops.sollHours')}</th><th class="n">${t('ops.sollStarts')}</th></tr></thead><tbody></tbody></table></div></div>
  <dialog id="ops-driver-dlg" aria-labelledby="ops-driver-h"><h2 id="ops-driver-h">${t('ops.driverLinkTitle')}</h2><p class="small" id="ops-driver-what"></p>
    <div id="ops-driver-qr" class="qr"></div><p><input id="ops-driver-url" readonly aria-label="${X.esc(t('ops.driverLinkTitle'))}" style="width:100%"></p>
    <div class="ops-actions"><button id="ops-driver-copy" type="button">${t('ops.driverCopy')}</button><a id="ops-driver-open" target="_blank" rel="noopener">${t('ops.driverOpen')}</a><button id="ops-driver-close" type="button">${t('ops.driverClose')}</button></div>
    <p class="muted small">${t('ops.driverHint')}</p></dialog>`);
  $('#ops-shift-form').addEventListener('submit', (e) => { e.preventDefault(); runShift(); });
  $('#ops-shift-csv').addEventListener('click', () => SH.plan && download(`schicht_${slug()}.csv`, O.shiftCsv(SH.plan, { lang: lang() }), 'text/csv'));
  $('#ops-soll-band').addEventListener('change', renderSoll);
  $('#ops-soll-spots').addEventListener('click', () => SH.soll && download(`soll_${slug()}_band${SH.soll.band}.csv`, O.sollSpotsCsv(SH.soll, { name: lang() === 'en' ? 'Target' : 'Soll' }), 'text/csv'));
  $('#ops-soll-csv').addEventListener('click', () => SH.soll && download(`soll_auswertung_${slug()}_band${SH.soll.band}.csv`, O.sollCsv(SH.soll, { lang: lang() }), 'text/csv'));
  $('#ops-shift-out').addEventListener('click', (e) => { const b = /** @type {HTMLElement} */ (e.target).closest('[data-shift-driver]'); if (b) openDriver(shiftTour(b.getAttribute('data-shift-driver'))); });
  $('#ops-runs')?.addEventListener('click', (e) => { const b = /** @type {HTMLElement} */ (e.target).closest('[data-driver]'); if (!b) return; e.stopPropagation(); const r = allRuns().find(x => x.id === b.getAttribute('data-driver')); if (r) openDriver(runTour(r)); });
  $('#ops-driver-close').addEventListener('click', () => /** @type {HTMLDialogElement} */ ($('#ops-driver-dlg')).close());
  $('#ops-driver-copy').addEventListener('click', async () => { const i = /** @type {HTMLInputElement} */ ($('#ops-driver-url')); try { await navigator.clipboard.writeText(i.value); X.notice?.(t('ops.driverCopied')); } catch { i.select(); } });
}

/** nach jedem Plan: Soll neu, Schichtplan zurücksetzen (er gehört zum alten Plan) */
export function renderShiftPanels() {
  ensurePanels(); if (!$('#ops-shift-panel')) return;
  if (SH.forPlan !== S.plan) { SH.forPlan = S.plan; SH.plan = null; $('#ops-shift-out').innerHTML = ''; /** @type {HTMLButtonElement} */ ($('#ops-shift-csv')).disabled = true; }
  renderSoll();
}

function noteOf(s) {
  const i = s.info || {};
  if (s.type === 'drop') return i.spotRank != null ? `Spot ${i.spotRank}` : '';
  if (s.type === 'swap') return i.battery?.length ? t('ops.noteBattery', { v0: i.battery.slice(0, 4).join('/') }) : '';
  if (s.type === 'pickup_disabled') return i.idleMaxH != null ? t('ops.noteLocked', { v0: X.fmt(i.idleMaxH) }) : '';
  return i.idleMaxH ? t('ops.noteIdle', { v0: X.fmt(i.idleMaxH) }) : '';
}
const titleOf = () => `${X.muniName(S.plan.ags)} · ${S.plan.op}`;
function shiftTour(id) {
  const d = SH.plan?.drivers.find(x => x.id === id); if (!d) return null;
  return makeTour({ id: d.id, title: titleOf(), at: S.plan.at || Date.now(), day: DAY_BERLIN.format(new Date()), stops: d.stops.map(s => ({ ...s, note: s.type === 'depot' ? '' : noteOf(s) })) });
}
function runTour(r) {
  const note = (s) => (s.type === 'drop' && s.spotRank != null ? `Spot ${s.spotRank}` : s.type === 'swap' && s.battery?.length ? t('ops.noteBattery', { v0: s.battery.slice(0, 4).join('/') }) : '');
  return makeTour({ id: r.id, title: titleOf(), at: S.plan.at || Date.now(), day: DAY_BERLIN.format(new Date()), depot: S.plan.depot, stops: r.stops.map(s => ({ type: s.type, lat: s.lat, lon: s.lon, count: s.count, note: note(s) })) });
}
async function openDriver(tour) {
  if (!tour) return;
  const url = `${new URL('fahrer.html', location.href).href}#t=${encodeTour(tour)}`, n = tour.stops.filter(s => s.type !== 'depot').length;
  /** @type {HTMLInputElement} */ ($('#ops-driver-url')).value = url; /** @type {HTMLAnchorElement} */ ($('#ops-driver-open')).href = url;
  $('#ops-driver-what').textContent = t('ops.driverWhat', { id: tour.id, n: X.fmt(n), title: tour.title, len: X.fmt(url.length) });
  const box = $('#ops-driver-qr'); box.removeAttribute('role'); box.removeAttribute('aria-label'); box.textContent = t('ops.driverQrLoading');
  const dlg = /** @type {HTMLDialogElement} */ ($('#ops-driver-dlg')); if (!dlg.open) dlg.showModal();
  try {
    // bis etwa Version 25 (1.273 Zeichen bei Stufe L) bleibt der Code am Handy lesbar; längere Touren als Link schicken
    if (url.length > 1270) { box.textContent = t('ops.driverQrTooLong'); return; }
    const { default: qrcode } = await import('qrcode-generator');
    const qr = qrcode(0, url.length > 800 ? 'L' : 'M'); qr.addData(url, 'Byte'); qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 3, margin: 3, scalable: true }); box.setAttribute('role', 'img'); box.setAttribute('aria-label', t('ops.driverQrAlt', { id: tour.id }));
  } catch { box.textContent = t('ops.driverQrTooLong'); }
}

function runShift() {
  const p = S.plan, out = $('#ops-shift-out'); if (!p || !out) return;
  const n = Math.max(1, Math.min(12, +(/** @type {HTMLInputElement} */ ($('#ops-shift-n')).value) || 2));
  const from = minOf(/** @type {HTMLInputElement} */ ($('#ops-shift-from')).value, 360), to0 = minOf(/** @type {HTMLInputElement} */ ($('#ops-shift-to')).value, 840), to = to0 <= from ? to0 + 1440 : to0;
  const pr = p.params || {}, jobs = O.shiftJobs(p);
  if (!jobs.length) { out.innerHTML = `<p class="muted">${t('ops.shiftNoJobs')}</p>`; return; }
  const sp = O.planShift(jobs, { drivers: n, startMin: from, endMin: to, depot: p.depot, vanCapacity: pr.van ?? O.DEFAULTS.vanCapacity, swapCapacity: pr.swapCapacity ?? O.DEFAULTS.swapCapacity });
  SH.plan = sp; /** @type {HTMLButtonElement} */ ($('#ops-shift-csv')).disabled = false;
  const f = X.fmt, esc = X.esc, LBL = { depot: t('ops.depot'), pickup: t('ops.pickUp'), drop: t('ops.dropOff'), swap: t('ops.swapBattery'), pickup_disabled: t('ops.shiftWorkshop') };
  const head = t('ops.shiftSummary', { planned: f(sp.planned), jobs: f(sp.jobs), km: f(sp.km, 1), base: f(sp.baselineKm, 1), save: f(Math.max(0, sp.savingKm), 1), drivers: f(n), from: hm(from), to: hm(to) });
  const warn = sp.unplanned.length ? ` <span class="warn-text">${t('ops.shiftUnplanned', { n: f(sp.unplanned.length) })}</span>` : '';
  out.innerHTML = `<p>${head}${warn}</p><div class="cards">${sp.drivers.map(d => `<div class="card"><b>${esc(d.id)}</b> · ${hm(d.startMin)}–${hm(d.endMin)} · ${f(d.km, 1)} km · ${t('ops.shiftDriverLine', { jobs: f(d.jobs), veh: f(d.vehicles), trips: f(d.trips) })}
    <details><summary>${t('ops.stopList')}</summary><ol class="small">${d.stops.map(s => `<li><span class="mono">${hm(s.eta)}</span> ${esc(LBL[s.type] || s.type)}${s.count ? ` × ${f(s.count)}` : ''}${s.type !== 'depot' ? ` <span class="muted">${esc(noteOf(s))}</span>` : ''}</li>`).join('')}</ol></details>
    <div class="foot"><button class="chip" type="button" data-shift-driver="${esc(d.id)}"${d.jobs ? '' : ' disabled'}>${t('ops.driverLink')}</button></div></div>`).join('')}</div>`;
}

export function renderSoll() {
  const p = S.plan, body = $('#ops-soll tbody'), sub = $('#ops-soll-sub'); if (!p || !body) return;
  const b = +(/** @type {HTMLSelectElement} */ ($('#ops-soll-band')).value), btn = ['#ops-soll-spots', '#ops-soll-csv'].map(s => /** @type {HTMLButtonElement} */ ($(s)));
  if (p.noDemand || !p.cellDocs?.length) { body.innerHTML = ''; sub.textContent = t('ops.sollNoData'); btn.forEach(x => { x.disabled = true; }); return; }
  const dem = O.censoredDemand(p.cellDocs, p.ags, b), fleet = p.fleet.vehicles.filter(O.isAvailable).length;
  const geoms = O.boxed(p.np?.geoms || []), allow = geoms.length ? (e) => !geoms.some(({ g, b: bb }) => e.lon >= bb[0] && e.lon <= bb[2] && e.lat >= bb[1] && e.lat <= bb[3] && O.geomContains(g, e.lat, e.lon)) : null;
  const sp = O.sollPlan(dem, { fleet, allow }); SH.soll = sp; btn.forEach(x => { x.disabled = !sp.sum; });
  const f = X.fmt, rows = sp.cells.filter(c => c.soll > 0);
  sub.textContent = t('ops.sollSub', { sum: f(sp.sum), fleet: f(sp.fleet), cells: f(rows.length), storage: f(sp.storageExcluded), blocked: f(sp.notAllowed), days: f(sp.days), cens: f(sp.daysCensored) });
  body.innerHTML = rows.slice(0, 40).map(c => `<tr><td><a href="https://www.openstreetmap.org/?mlat=${c.lat.toFixed(5)}&mlon=${c.lon.toFixed(5)}#map=17/${c.lat.toFixed(5)}/${c.lon.toFixed(5)}" target="_blank" rel="noopener">${c.lat.toFixed(4)}, ${c.lon.toFixed(4)}</a></td><td class="n">${f(c.soll)}</td><td class="n">${f(c.rate, 2)}</td><td class="n">${c.rateRaw == null ? '–' : f(c.rateRaw, 2)}</td><td class="n">${f(c.supplyH, 1)}</td><td class="n">${f(c.starts)}</td></tr>`).join('')
    + (rows.length > 40 ? `<tr><td colspan="6" class="muted">${t('ops.sollMore', { n: f(rows.length - 40) })}</td></tr>` : '');
}
