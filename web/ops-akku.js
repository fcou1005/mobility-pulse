// @ts-check
// Disposition, S6.5 Akku-Prognose: welche Fahrzeuge bis morgen 8 Uhr unter 20 % fallen, je Zone mit Zeitpunkt, und Tauschtouren mit dem
// Ladestand um 8 Uhr. Modell je Anbieter und Art aus akku/<AGS>.json (Sammler, Phase „akku“), gerechnet mit dem Bestand dieser Seite.
import * as AK from './pulse-akku.js';
import { cellOf } from './pulse-track-rules.js';
import { t, lang } from './i18n.js';
import { $, S, X, download, slug } from './ops-data.js';

const AKS = { docs: new Map(), eval: undefined, on: false, last: null };
const HM = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });

/** Modell der Gemeinde (zwischengespeichert; null = gibt es nicht) */
async function loadAkku(ags) {
  if (!AKS.docs.has(ags)) { const r = await X.getJson(`${X.CFG.DATA}akku/${ags}.json`, { timeout: 30000 }); AKS.docs.set(ags, r.ok && r.json?.ags === ags ? r.json : null); }
  if (AKS.eval === undefined) { const r = await X.getJson(`${X.CFG.DATA}akku/bewertung.json`, { timeout: 30000 }); AKS.eval = r.ok ? r.json : null; }
  return AKS.docs.get(ags);
}
/** Fahrzeuge für die Tauschtouren: mit Häkchen der erwartete Ladestand um 8 Uhr (sonst unverändert) */
export function akkuVehicles(p, vehicles) {
  const doc = AKS.on && p ? AKS.docs.get(p.ags) : null;
  if (doc) p.akkuApplied = true;
  return doc ? AK.atMorning(vehicles, doc, Date.now()) : vehicles;
}

function ensurePanel() {
  if ($('#ops-akku-panel')) return true;
  const after = $('#ops-soll-panel'); if (!after) return false;
  after.insertAdjacentHTML('afterend', `
  <div class="panel c12" id="ops-akku-panel"><div class="panel-head"><div><h2>${t('ops.akkuTitle', { hour: AK.AKKU.targetHour })}</h2><div class="sub" id="ops-akku-sub" aria-live="polite"></div></div>
    <div class="inline-form"><label class="check"><input type="checkbox" id="ops-akku-swap"> ${t('ops.akkuSwap', { hour: AK.AKKU.targetHour })}</label>
      <button id="ops-akku-csv" type="button" disabled>${t('ops.akkuCsv')}</button></div></div>
    <p class="small muted" id="ops-akku-model"></p><p class="small" id="ops-akku-hits"></p>
    <div class="tbl" tabindex="0" role="region" aria-label="${X.esc(t('ops.akkuTitle', { hour: AK.AKKU.targetHour }))}"><table id="ops-akku"><thead><tr><th>${t('ops.akkuZone')}</th><th class="n">${t('ops.akkuNow', { low: AK.AKKU.low })}</th><th class="n">${t('ops.akkuMorning', { hour: AK.AKKU.targetHour })}</th><th class="n">${t('ops.akkuFrom')}</th></tr></thead><tbody></tbody></table></div></div>`);
  $('#ops-akku-swap').addEventListener('change', (e) => { AKS.on = /** @type {HTMLInputElement} */ (e.target).checked; import('./ops-plan.js').then(m => m.replanRuns()); });
  $('#ops-akku-csv').addEventListener('click', () => AKS.last && download(`akku_${slug()}.csv`, zonesCsv(AKS.last), 'text/csv'));
  return true;
}

const pct = (x) => (x == null ? '–' : `${X.fmt(x * 100, 0)} %`);
function hitsText(ev) {
  const tot = ev?.total, bt = ev?.backtest?.total;
  const parts = [];
  const nightsText = (n) => (n === 1 ? t('ops.akkuNightOne') : t('ops.akkuNightMany', { n: X.fmt(n) }));
  if (tot?.nights) parts.push(t('ops.akkuHits', { p: pct(tot.precision), n: X.fmt(tot.tp + tot.fp), nights: nightsText(tot.nights), r: pct(tot.recall), pb: pct(tot.base?.precision) }));
  if (bt?.nights) parts.push(t('ops.akkuHitsBack', { p: pct(bt.precision), n: X.fmt(bt.tp + bt.fp), nights: nightsText(bt.nights), r: pct(bt.recall), groups: (ev.backtest.groups || []).map(g => `${g.split('|')[0]} ${X.muniName(g.split('|')[1])}`).join(', ') }));
  return parts.length ? parts.join(' ') : t('ops.akkuHitsNone', { hour: AK.AKKU.targetHour });
}
function zonesCsv(ff) {
  const en = lang() === 'en', head = en ? ['zone', 'lat', 'lon', 'operator', 'type', `below_${AK.AKKU.low}_now`, `below_${AK.AKKU.low}_by_${AK.AKKU.targetHour}`, 'from'] : ['zone', 'lat', 'lon', 'anbieter', 'art', `unter_${AK.AKKU.low}_jetzt`, `unter_${AK.AKKU.low}_bis_${AK.AKKU.targetHour}`, 'ab'];
  const num = (x, d) => (en ? x.toFixed(d) : x.toFixed(d).replace('.', ','));
  return [head, ...ff.zones.map(z => [z.cell, num(z.lat, 5), num(z.lon, 5), z.op, z.type, z.nowLow, z.morning, z.cross == null ? '' : HM.format(z.cross)])].map(r => r.join(';')).join('\n') + '\n';
}

/** nach jedem Plan (und wenn das Modell nachgeladen ist) */
export async function renderAkku() {
  const p = S.plan; if (!p || !ensurePanel()) return;
  const sub = $('#ops-akku-sub'), body = $('#ops-akku tbody'), csv = /** @type {HTMLButtonElement} */ ($('#ops-akku-csv'));
  const doc = await loadAkku(p.ags); if (S.plan !== p) return;
  $('#ops-akku-hits').textContent = hitsText(AKS.eval);
  if (!doc) { sub.textContent = t('ops.akkuNoData', { min: 20 }); body.innerHTML = ''; $('#ops-akku-model').textContent = ''; csv.disabled = true; AKS.last = null; return; }
  const ff = AK.fleetForecast(p.fleet.vehicles, doc, Date.now(), { cellOf }); AKS.last = ff;
  if (!ff.known) { sub.textContent = t('ops.akkuNoBattery'); body.innerHTML = ''; $('#ops-akku-model').textContent = ''; csv.disabled = true; return; }
  const f = X.fmt;
  sub.textContent = t('ops.akkuSub', { when: HM.format(ff.target), morning: f(ff.morning), known: f(ff.known), low: AK.AKKU.low, now: f(ff.nowLow) });
  const ops = [...new Set(p.fleet.vehicles.filter(v => v.battery != null).map(v => `${v.operator}|${v.type}`))].map(k => [k, AK.groupModel(doc, ...k.split('|'))]).filter(([, g]) => g);
  $('#ops-akku-model').textContent = ops.slice(0, 4).map(([k, g]) => t('ops.akkuModel', { op: `${k.split('|')[0]} (${X.TYPE[k.split('|')[1]] || k.split('|')[1]})`, drain: f(g.drain, 2), basis: t(`ops.akkuBasis.${g.basisDrain}`) })).join(' ') + ' ' + t('ops.akkuStays');
  csv.disabled = !ff.zones.length;
  const rows = ff.zones.slice(0, 30);
  body.innerHTML = rows.map(z => `<tr><td><a href="https://www.openstreetmap.org/?mlat=${z.lat.toFixed(5)}&mlon=${z.lon.toFixed(5)}#map=17/${z.lat.toFixed(5)}/${z.lon.toFixed(5)}" target="_blank" rel="noopener">${z.lat.toFixed(4)}, ${z.lon.toFixed(4)}</a>${ops.length > 1 ? ` <span class="muted">${X.esc(z.op)}</span>` : ''}</td><td class="n">${f(z.nowLow)}</td><td class="n">${f(z.morning)}</td><td class="n">${z.cross == null ? '–' : HM.format(z.cross)}</td></tr>`).join('')
    + (ff.zones.length > rows.length ? `<tr><td colspan="4" class="muted">${t('ops.akkuMore', { n: f(ff.zones.length - rows.length) })}</td></tr>` : '');
  if (AKS.on && !p.akkuApplied) { p.akkuApplied = true; import('./ops-plan.js').then(m => m.replanRuns()); }
}
