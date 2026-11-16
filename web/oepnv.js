// @ts-check
// Mobility Pulse — Reiter ÖPNV (16.11.2026): Live-Karte mit geschätzten Fahrzeugwegen (Sharing als zweite Ebene), Pünktlichkeit je Tag und Stunde,
// Stationen mit den meisten Störungen, Wirkung von Störungen auf Sharing und Vorschläge für Sharing-Stationen. renderOepnv(el, ctx), ctx = rpCtx().
// Daten aus dem Sammler (Phase „oepnv“, lib/pulse-oepnv-netz.js): oepnv/index.json, oepnv/wirkung.json, oepnv/<AGS>.json, oepnv/live/<AGS>.json;
// dazu abstell/<AGS>.json (Fahrtenden), ops-input/fleet/<AGS>.json (Sharing-Bestand) und zones/ (Abstellinseln der Anbieter).
// Die Fahrzeuge der Karte sind keine Ortung: der Echtzeit-Strom nennt Haltezeiten, die Lage dazwischen ist geschätzt (Luftlinie zwischen den Stationen).
import * as NZ from './pulse-oepnv-karte.js';
import * as PL from './pulse-geo-plan.js';
import * as Z from './pulse-zones.js';
import { decodeFleet } from './pulse-ops.js';
import { t, dateFmt } from './i18n.js';
import { putAnswer } from './answer.js';
import { linesPanel, profilePanel, nowPanel, lastMilePanel, bindMehr } from './oepnv-mehr.js';
import { M, KARTE_CSS, mapPanel as mapPanelHtml, setupMap, stopTimer } from './oepnv-karte.js';

const cache = new Map(), S = { run: 0, fleet: null, hub: null, rows: null };
const load = (ctx, url, fresh = false) => { if (fresh || !cache.has(url)) cache.set(url, ctx.getJson(url, { timeout: 30000 }).then(r => (r?.ok ? r.json : null)).catch(() => null)); return cache.get(url); };
const pct = (ctx, x, d = 0) => (x == null || !Number.isFinite(x) ? '–' : `${ctx.fmt(x * 100, d)} %`);
const osm = (lat, lon, text) => `<a href="https://www.openstreetmap.org/?mlat=${lat.toFixed(5)}&mlon=${lon.toFixed(5)}#map=17/${lat.toFixed(5)}/${lon.toFixed(5)}" target="_blank" rel="noopener">${text}</a>`;
const dayTxt = (d) => (d ? dateFmt({ weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`)) : '');
const timeTxt = (ms) => (ms ? dateFmt({ hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' }).format(new Date(ms)) : '–');
const sum = (a) => (a || []).reduce((x, y) => x + (y || 0), 0);
const download = (name, text) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0); };
const csvNum = (x, d = 1) => (x == null ? '' : (+x).toFixed(d).replace('.', ','));
const VERDICT = () => ({ mehr: t('pt.vMore'), weniger: t('pt.vLess'), 'nicht unterscheidbar': t('pt.vNone'), 'zu wenig Tage': t('pt.vFew') });
export const OEPNV_CSS = `.pt-map{height:440px;border:1px solid var(--line);border-radius:var(--r-md);background:var(--panel-2)}
.pt-bar{display:flex;flex-wrap:wrap;gap:var(--s3);align-items:center;margin:var(--s3) 0}
.pt-legend{display:flex;flex-wrap:wrap;gap:var(--s3);font-size:.875rem;color:var(--fg-2)}
.pt-legend i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:middle}
.pt-legend i.sq{border-radius:2px;width:8px;height:8px}
.pt-bar-cell{display:inline-block;width:90px;height:8px;background:var(--panel-2);border-radius:4px;overflow:hidden;vertical-align:middle}
.pt-bar-cell i{display:block;height:100%;border-radius:4px}
@media (max-width:640px){.pt-map{height:320px}}`;
function ensureCss() { if (document.getElementById('pt-css')) return; const s = document.createElement('style'); s.id = 'pt-css'; s.textContent = OEPNV_CSS + KARTE_CSS; document.head.appendChild(s); }

export async function renderOepnv(el, ctx) {
  ensureCss();
  const ags = ctx.state.scope, run = ++S.run, D = ctx.CFG.DATA, f = ctx.fmt, city = ags && ags !== 'DE';
  stopTimer(); el.innerHTML = `<div class="panel"><p class="muted">${t('pt.loading')}</p></div>`;
  const [idx, wirk] = await Promise.all(['oepnv/index.json', 'oepnv/wirkung.json'].map(x => load(ctx, D + x)));
  const [doc, live, abs, fleetDoc, zIdx, ver] = city ? await Promise.all([load(ctx, `${D}oepnv/${ags}.json`), load(ctx, `${D}oepnv/live/${ags}.json`, true), load(ctx, `${D}abstell/${ags}.json`), load(ctx, `${D}ops-input/fleet/${ags}.json`), load(ctx, `${D}zones/index.json`), load(ctx, `${D}versorgung/${ags}.json`)]) : [null, null, null, null, null, null];
  if (run !== S.run) return;
  const name = city ? ctx.esc(ctx.muniName(ags)) : t('pt.germany');
  M.live = live; M.fleet = S.fleet = fleetDoc ? (decodeFleet(fleetDoc)?.vehicles || []).filter(v => !v.disabled && !v.reserved && Number.isFinite(v.lat)) : null;
  const H = doc?.hours, last = H?.days?.length ? H.days.length - 1 : -1;
  const dayRow = (i) => { const n = sum(H.n[i]), sk = sum(H.skip[i]), la = sum(H.late[i]); return { day: H.days[i], n, sk, la, ok: n ? (n - sk - la) / n : null, flag: sum(H.flag?.[i]), cancel: H.cancel?.[i] ?? 0 }; };
  const today = last >= 0 ? dayRow(last) : null, liveN = live ? (live.trips || []).length : 0;
  // ---------- Antwort ----------
  if (city && today && today.n) {
    putAnswer(el, { id: 'oepnv', sentence: t('pt.answer', { name, p: `<strong>${pct(ctx, today.ok)}</strong>`, n: f(today.n), skip: f(today.sk), late: f(today.la), day: dayTxt(today.day) }),
      kpis: [{ label: t('pt.kOk'), value: pct(ctx, today.ok), n: today.ok * 100, cmp: t('pt.kOkCmp'), eq: '#pt-days tbody tr:first-child td.pt-ok' },
        { label: t('pt.kSkip'), value: pct(ctx, today.sk / today.n, 1), cmp: t('pt.kSkipCmp', { n: f(today.cancel) }) },
        { label: t('pt.kLive'), value: f(liveN), cmp: t('pt.kLiveCmp') }], how: t('pt.how'), asOf: timeTxt(doc.at) });
  } else if (!city && idx?.cities && Object.keys(idx.cities).length) {
    const all = Object.values(idx.cities), n = sum(all.map(r => r[1])), bad = sum(all.map(r => r[2] + r[3]));
    putAnswer(el, { id: 'oepnv', sentence: t('pt.answerDe', { cities: f(all.length), p: `<strong>${pct(ctx, n ? (n - bad) / n : null)}</strong>`, n: f(n) }),
      kpis: [{ label: t('pt.kOk'), value: pct(ctx, n ? (n - bad) / n : null), cmp: t('pt.kCities', { n: f(all.length) }) }, { label: t('pt.kLive'), value: f(idx.trips || 0), cmp: t('pt.kLiveCmp') }], how: t('pt.how'), asOf: timeTxt(idx.at) });
  } else putAnswer(el, { id: 'oepnv', sentence: t('pt.answerNone', { name }), kpis: [{ label: t('pt.kOk'), value: '–' }, { label: t('pt.kSkip'), value: '–' }, { label: t('pt.kLive'), value: '–' }], how: t('pt.how') });

  // ---------- Live-Karte ----------
  const mapPanel = city ? mapPanelHtml(ctx, name, live) : '';

  // ---------- Verspätungs-Dashboard ----------
  let dash = '';
  if (city && H?.days?.length) {
    const rows = H.days.map((_, i) => dayRow(i)).reverse();
    const hr = today ? H.n[last].map((n, h) => ({ h, n, sk: H.skip[last][h], la: H.late[last][h], fl: H.flag?.[last]?.[h] })).filter(x => x.n > 0) : [];
    dash = `<div class="panel"><div class="panel-head"><div><h2>${t('pt.dashTitle', { name })}</h2><div class="sub">${t('pt.dashSub')}</div></div></div>
      <div class="tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('pt.dashTitle', { name }))}"><table id="pt-days"><thead><tr><th>${t('pt.colDay')}</th><th class="n">${t('pt.colStops')}</th><th class="n">${t('pt.colOk')}</th><th class="n">${t('pt.colSkip')}</th><th class="n">${t('pt.colLate')}</th><th class="n">${t('pt.colFlagH')}</th><th class="n">${t('pt.colCancel')}</th></tr></thead><tbody>
      ${rows.map(r => `<tr><td>${dayTxt(r.day)}</td><td class="n">${f(r.n)}</td><td class="n pt-ok">${pct(ctx, r.ok)}</td><td class="n">${pct(ctx, r.n ? r.sk / r.n : null, 1)}</td><td class="n">${pct(ctx, r.n ? r.la / r.n : null, 1)}</td><td class="n">${f(r.flag)}</td><td class="n">${f(r.cancel)}</td></tr>`).join('')}</tbody></table></div>
      ${hr.length ? `<h3>${t('pt.hoursTitle', { day: dayTxt(today.day) })}</h3><div class="tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('pt.hoursTitle', { day: dayTxt(today.day) }))}"><table><thead><tr><th>${t('pt.colHour')}</th><th class="n">${t('pt.colStops')}</th><th class="n">${t('pt.colSkip')}</th><th class="n">${t('pt.colLate')}</th><th>${t('pt.colState')}</th></tr></thead><tbody>
      ${hr.map(x => `<tr><td>${x.h}–${x.h + 1} h</td><td class="n">${f(x.n)}</td><td class="n">${pct(ctx, x.sk / x.n, 1)}</td><td class="n">${pct(ctx, x.la / x.n, 1)}</td><td>${x.fl ? `▲ ${t('pt.stateBad')}` : `○ ${t('pt.stateOk')}`}</td></tr>`).join('')}</tbody></table></div>` : ''}
      <p class="muted small">${t('pt.dashNote')}</p></div>`;
  } else if (city) dash = `<div class="panel"><div class="empty">${t('pt.dashEmpty', { name })}</div></div>`;

  // ---------- Stationen ----------
  const R = doc?.rows || [], days = Math.max(0.25, doc?.days || 0.25); S.rows = R;
  const worst = R.filter(r => r[4] >= 40).map(r => ({ r, q: (r[5] + r[6]) / r[4] })).sort((a, b) => b.q - a.q || b.r[4] - a.r[4]).slice(0, 15);
  const stPanel = city ? (R.length ? `<div class="panel"><div class="panel-head"><div><h2>${t('pt.stTitle')}</h2><div class="sub">${t('pt.stSub', { n: f(R.length), all: f(doc.stations || R.length), days: f(days, 1), hl: doc.halfLifeDays || 7 })}</div></div>
      <div class="panel-actions"><button class="chip" type="button" id="pt-st-csv">${t('pt.csv')}</button></div></div>
      ${worst.length ? `<div class="tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('pt.stTitle'))}"><table><thead><tr><th>${t('pt.colStation')}</th><th class="n">${t('pt.colPerDay')}</th><th class="n">${t('pt.colSkip')}</th><th class="n">${t('pt.colLate')}</th><th class="n">${t('pt.colDelay')}</th></tr></thead><tbody>
      ${worst.map(({ r }) => `<tr><td>${osm(r[2], r[3], ctx.esc(r[1]))}</td><td class="n">${f(r[4] / days)}</td><td class="n">${pct(ctx, r[5] / r[4], 1)}</td><td class="n">${pct(ctx, r[6] / r[4], 1)}</td><td class="n">${r[7] == null ? '–' : f(r[7], 1)}</td></tr>`).join('')}</tbody></table></div>` : `<div class="empty">${t('pt.stFew')}</div>`}</div>`
    : `<div class="panel"><div class="empty">${t('pt.stEmpty', { name })}</div></div>`) : '';

  // ---------- Wirkung auf Sharing ----------
  const V = VERDICT(), mine = city ? (wirk?.cities || []).find(c => c.ags === ags) : null, P = wirk?.pooled;
  const effTxt = (x) => (x == null ? '–' : `${x >= 0 ? '+' : '−'}${f(Math.abs(x) * 100, 1)} %`), ciTxt = (ci) => (ci ? `${effTxt(ci[0])} … ${effTxt(ci[1])}` : '–');
  const effPanel = `<div class="panel"><div class="panel-head"><div><h2>${t('pt.effTitle')}</h2><div class="sub">${t('pt.effSub')}</div></div></div>
    ${(wirk?.cities || []).length ? `<p>${P ? t('pt.effPooled', { e: `<b>${effTxt(P.effect)}</b>`, ci: ciTxt(P.ci), n: f(P.cityDays), c: f(P.cities), v: V[P.verdict] || P.verdict }) : t('pt.effPooledNone')}${city ? ` ${mine ? t('pt.effMine', { name, e: effTxt(mine.effect), ci: ciTxt(mine.ci), d: f(mine.days), v: V[mine.verdict] || mine.verdict }) : t('pt.effMineNone', { name })}` : ''}</p>
      <div class="tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('pt.effTitle'))}"><table><thead><tr><th>${t('pt.city')}</th><th class="n">${t('pt.colEffDays')}</th><th class="n">${t('pt.colEffHours')}</th><th class="n">${t('pt.colEff')}</th><th>${t('pt.colCi')}</th><th>${t('pt.colVerdict')}</th></tr></thead><tbody>
      ${wirk.cities.slice(0, 15).map(c => `<tr><td><button type="button" class="chip" data-ags="${c.ags}">${ctx.esc(ctx.muniName(c.ags))}</button></td><td class="n">${f(c.days)}</td><td class="n">${f(c.hours)}</td><td class="n">${effTxt(c.effect)}</td><td>${ciTxt(c.ci)}</td><td>${V[c.verdict] || c.verdict}</td></tr>`).join('')}</tbody></table></div>
      <p class="muted small">${t('pt.effNote')}</p>` : `<div class="empty">${t('pt.effEmpty')}</div>`}</div>`;

  // ---------- Vorschläge für Sharing-Stationen ----------
  let hubPanel = '';
  if (city && R.length) {
    const mineZ = (zIdx?.zones || []).filter(z => (z.municipalities || []).includes(ags)), zDocs = (await Promise.all(mineZ.map(z => load(ctx, `${D}zones/${z.file}`)))).filter(Boolean);
    if (run !== S.run) return;
    const isl = PL.parkingIslands(Z.zonesFor(zDocs)), demand = PL.demandFromDoc(abs);
    const hub = NZ.hubCandidates(R, { days, demand, vehicles: S.fleet || [], existing: isl }); S.hub = hub;
    const why = (x) => Object.entries(x.parts).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => (k === 'pt' ? t('pt.whyPt', { n: f(x.perDay) }) : k === 'stoer' ? t('pt.whyStoer', { p: pct(ctx, x.stoer) }) : t('pt.whyEnds', { n: f(x.ends) }))).join('; ');
    hubPanel = `<div class="panel"><div class="panel-head"><div><h2>${t('pt.hubTitle')}</h2><div class="sub">${t('pt.hubSub', { r: NZ.NETZ.hubRadiusM, n: f(hub.stations), has: f(hub.withArea), min: NZ.NETZ.hubMinPerDay })}</div></div>
      <div class="panel-actions"><button class="chip" type="button" id="pt-hub-csv"${hub.rows.length ? '' : ' disabled'}>${t('pt.csv')}</button></div></div>
      ${hub.rows.length ? `<div class="tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('pt.hubTitle'))}"><table id="pt-hub"><thead><tr><th>${t('pt.colRank')}</th><th>${t('pt.colStation')}</th><th class="n">${t('pt.colPerDay')}</th><th class="n">${t('pt.colStoer')}</th><th class="n">${t('pt.colEnds')}</th><th class="n">${t('pt.colVeh')}</th><th>${t('pt.colWhy')}</th></tr></thead><tbody>
      ${hub.rows.map((x, i) => `<tr><td>${i + 1}</td><td>${osm(x.lat, x.lon, ctx.esc(x.name))}</td><td class="n">${f(x.perDay)}</td><td class="n">${pct(ctx, x.stoer)}</td><td class="n">${f(x.ends)}</td><td class="n">${S.fleet ? f(x.vehicles) : '–'}</td><td class="wrap">${why(x)}</td></tr>`).join('')}</tbody></table></div>` : `<div class="empty">${t('pt.hubEmpty')}</div>`}
      <p class="muted small">${t('pt.hubNote', { isl: f(isl.length), abs: abs ? t('pt.hubAbsYes') : t('pt.hubAbsNo') })}</p></div>`;
  }

  const hints = city ? NZ.hotspotHints(doc?.jetzt?.rows || [], S.fleet) : []; M.hot = hints;
  // ---------- Städte (ohne Auswahl) ----------
  const cityList = !city ? `<div class="panel"><div class="panel-head"><div><h2>${t('pt.listTitle')}</h2><div class="sub">${t('pt.listSub')}</div></div></div>${idx?.cities && Object.keys(idx.cities).length ? `<div class="tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('pt.listTitle'))}"><table><thead><tr><th>${t('pt.city')}</th><th class="n">${t('pt.colStops')}</th><th class="n">${t('pt.colOk')}</th><th class="n">${t('pt.colSkip')}</th><th class="n">${t('pt.colLate')}</th><th class="n">${t('pt.kLive')}</th></tr></thead><tbody>
    ${Object.entries(idx.cities).sort((a, b) => b[1][1] - a[1][1]).slice(0, 40).map(([a, r]) => `<tr><td><button type="button" class="chip" data-ags="${a}">${ctx.esc(ctx.muniName(a))}</button></td><td class="n">${f(r[1])}</td><td class="n">${pct(ctx, r[1] ? (r[1] - r[2] - r[3]) / r[1] : null)}</td><td class="n">${pct(ctx, r[1] ? r[2] / r[1] : null, 1)}</td><td class="n">${pct(ctx, r[1] ? r[3] / r[1] : null, 1)}</td><td class="n">${f(r[4])}</td></tr>`).join('')}</tbody></table></div>` : `<div class="empty">${t('pt.listEmpty')}</div>`}</div>` : '';

  el.innerHTML = `${mapPanel}${city ? nowPanel(ctx, doc, name, hints, mine) : ''}${cityList}${dash}${stPanel}${city ? linesPanel(ctx, doc, days) : ''}${effPanel}${city ? profilePanel(ctx, doc, name) : ''}${city ? lastMilePanel(ctx, ver, name) : ''}${hubPanel}<p class="muted small">${t('pt.source', { attr: ctx.esc(doc?.attribution || idx?.attribution || NZ.NETZ_ATTRIBUTION) })}</p>`;
  for (const b of el.querySelectorAll('button[data-ags]')) b.addEventListener('click', () => { const sel = /** @type {HTMLSelectElement | null} */ (document.querySelector('#sel-scope')); if (sel) { sel.value = /** @type {HTMLElement} */ (b).dataset.ags || ''; sel.dispatchEvent(new Event('change', { bubbles: true })); } });
  el.querySelector('#pt-st-csv')?.addEventListener('click', () => download(`oepnv_stationen_${ags}.csv`, ['station;name;lat;lon;halte_je_tag;ausgefallen_anteil;verspaetet_anteil;verspaetung_min', ...(S.rows || []).map(r => [r[0], `"${String(r[1]).replace(/"/g, '""')}"`, csvNum(r[2], 5), csvNum(r[3], 5), csvNum(r[4] / days), csvNum(r[5] / r[4], 3), csvNum(r[6] / r[4], 3), csvNum(r[7])].join(';'))].join('\n') + '\n'));
  el.querySelector('#pt-hub-csv')?.addEventListener('click', () => S.hub && download(`sharing_stationen_${ags}.csv`, ['rang;station;name;lat;lon;halte_je_tag;gestoert_anteil;fahrtenden_150m;fahrzeuge_jetzt_150m;punkte', ...S.hub.rows.map((x, i) => [i + 1, x.id, `"${String(x.name).replace(/"/g, '""')}"`, csvNum(x.lat, 5), csvNum(x.lon, 5), csvNum(x.perDay), csvNum(x.stoer, 3), x.ends, x.vehicles, csvNum(x.score, 3)].join(';'))].join('\n') + '\n'));
  bindMehr(el, doc, ags, days, download, hints, ver);
  if (city && live) setupMap(ctx, el, R, () => load(ctx, `${D}oepnv/live/${ags}.json?t=${Math.floor(Date.now() / 60000)}`, true));
}
