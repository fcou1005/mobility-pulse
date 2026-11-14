// @ts-check
// Mobility Pulse — Markt (Sprint 7): Deutschland-Index (S7.1), Ereignis-Wirkung (S7.2), Preis-Wirkung (S7.3), Expansions-Scout (S7.4),
// offene Daten-Pakete und Grafik der Woche (S7.5). renderMarkt(el, ctx), ctx = rpCtx(). Daten aus dem Sammler (Phase „markt“):
// index/index.json, index/<JJJJ-MM>.json, index/laufend.json, markt/wirkung.json, markt/scout.json, grafik/index.json, offen/index.json.
import * as K from './pulse-markt.js';
import { t, tMap, dateFmt } from './i18n.js';
import { putAnswer } from './answer.js';

const cache = new Map(), S = { month: null, type: null };
const load = (ctx, url) => { if (!cache.has(url)) cache.set(url, ctx.getJson(url, { timeout: 30000 }).then(r => (r?.ok ? r.json : null)).catch(() => null)); return cache.get(url); };
let cssDone = false;
function css() {
  if (cssDone) return; cssDone = true;
  const s = document.createElement('style'); s.textContent = `
.mk-chart img,.mk-week img{display:block;width:100%;max-width:760px;height:auto;border-radius:var(--r-sm);background:white;margin:var(--s3) 0}
.mk-v.up{color:var(--ok)}.mk-v.down{color:var(--bad)}.mk-pkg{display:flex;flex-wrap:wrap;gap:var(--s2);align-items:center}.mk-files{display:flex;flex-wrap:wrap;gap:var(--s2)}
@media print{body.mk-printing .app>:not(main),body.mk-printing .topbar,body.mk-printing .filters,body.mk-printing #notice,body.mk-printing .view:not(.active),body.mk-printing .mk-noprint,body.mk-printing .toc{display:none!important}}`;
  document.head.appendChild(s);
}
const pctTxt = (ctx, x) => (x == null ? '–' : `${x >= 0 ? '+' : '−'}${ctx.fmt(Math.abs(x) * 100, 0)} %`);
const dayTxt = (d) => dateFmt({ dateStyle: 'medium', timeZone: 'Europe/Berlin' }).format(new Date(`${d}T12:00:00Z`));
const svgBlob = (svg) => URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
const download = (name, text, type) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); };

export async function renderMarkt(el, ctx) {
  css();
  const D = ctx.CFG.DATA, ags = ctx.state.scope, TY = tMap('type', Object.fromEntries(Object.keys(K.TYPE_DE).map(k => [k, 1])));
  el.innerHTML = `<div class="panel"><p class="muted">${t('mk.loading')}</p></div>`;
  const [list, wirk, scout, gList, oList] = await Promise.all(['index/index.json', 'markt/wirkung.json', 'markt/scout.json', 'grafik/index.json', 'offen/index.json'].map(f => load(ctx, `${D}${f}`)));
  const months = (list?.months || []).filter(m => m.complete).map(m => m.month);
  const want = S.month && (S.month === 'laufend' || months.includes(S.month)) ? S.month : 'laufend';
  let index = await load(ctx, `${D}index/${want}.json`); if (!index && want !== 'laufend') index = await load(ctx, `${D}index/laufend.json`);
  if ((!index || !index.rows?.length) && months.length) index = await load(ctx, `${D}index/${months[0]}.json`); // laufender Monat noch ohne vollen Tag: letzter abgeschlossener
  const types = index ? [...new Set(index.rows.map(r => r.type))].sort((a, b) => (index.de[b]?.tripsDay || 0) - (index.de[a]?.tripsDay || 0)) : [];
  const type = types.includes(S.type) ? S.type : types.includes(ctx.state.type) ? ctx.state.type : types[0];
  const row = index && ags !== 'DE' ? index.rows.find(r => r.ags === ags && r.type === type) : null, de = index?.de?.[type];
  const mTxt = index ? `${K.monthText(index.month)}${index.complete ? '' : ` ${t('mk.provisional')}`}` : '';
  // Antwort: gewählte Stadt und Art, sonst Deutschland
  if (index && (row || de)) {
    const r = row || { name: t('mk.germany'), tripsDay: de.tripsDay, fleet: de.fleet, tvd: de.tvd, change: null };
    putAnswer(el, { id: 'markt', sentence: t('mk.answer', { month: mTxt, name: ctx.esc(r.name), trips: `<strong>${ctx.fmt(r.tripsDay)}</strong>`, type: ctx.esc(TY[type] || type), fleet: ctx.fmt(r.fleet), tvd: ctx.fmt(r.tvd ?? 0, 2) }),
      kpis: [{ label: t('mk.kTrips'), value: ctx.fmt(r.tripsDay), n: r.tripsDay, cmp: r.change?.trips != null ? t('mk.kVsPrev', { v: pctTxt(ctx, r.change.trips) }) : t('mk.kNoPrev'), eq: row ? `#mk-idx tr[data-ags="${ags}"] td.mk-trips` : '' },
        { label: t('mk.kFleet'), value: ctx.fmt(r.fleet), cmp: r.change?.fleet != null ? t('mk.kVsPrev', { v: pctTxt(ctx, r.change.fleet) }) : t('mk.kFleetCmp') },
        { label: t('mk.kTvd'), value: ctx.fmt(r.tvd ?? 0, 2), cmp: de && row ? t('mk.kTvdDe', { v: ctx.fmt(de.tvd ?? 0, 2) }) : t('mk.kTvdCmp') }], how: t('mk.how'), asOf: index.lastDay ? dayTxt(index.lastDay) : '' });
  } else putAnswer(el, { id: 'markt', sentence: index ? t('mk.answerNoCity', { name: ctx.esc(ctx.muniName(ags)), month: mTxt }) : t('mk.answerNone'), kpis: [], how: t('mk.how') });

  const top = index ? index.rows.filter(r => r.type === type).slice(0, 30) : [];
  const pk = (oList?.packages || []).find(p => p.month === index?.month);
  el.innerHTML = `<div class="panel"><div class="panel-head"><div><h2>${t('mk.indexTitle', { month: mTxt })}</h2><div class="sub">${t('mk.indexSub')}</div></div>
      <div class="inline-form mk-noprint"><label>${t('mk.month')}<select id="mk-month"><option value="laufend"${want === 'laufend' ? ' selected' : ''}>${t('mk.current')}</option>${months.map(m => `<option value="${m}"${m === want ? ' selected' : ''}>${K.monthText(m)}</option>`).join('')}</select></label>
      <label>${t('mk.type')}<select id="mk-type">${types.map(ty => `<option value="${ty}"${ty === type ? ' selected' : ''}>${ctx.esc(TY[ty] || ty)}</option>`).join('')}</select></label>
      <button type="button" id="mk-svg"${index ? '' : ' disabled'}>${t('mk.svg')}</button><button type="button" id="mk-print">${t('mk.print')}</button><a href="https://github.com/fcou1005/mobility-pulse/blob/main/handbuch/kennzahlen.md#deutschland-index" target="_blank" rel="noopener">${t('mk.method')} ↗</a></div></div>
    ${index ? `<div class="mk-chart" id="mk-chart"></div>
    <div class="tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('mk.indexTitle', { month: mTxt }))}"><table id="mk-idx"><thead><tr><th class="n">#</th><th>${t('mk.city')}</th><th class="n">${t('mk.kTrips')}</th><th class="n">${t('mk.kFleet')}</th><th class="n">${t('mk.kTvd')}</th><th class="n">${t('mk.ops')}</th><th class="n">${t('mk.days')}</th><th class="n">${t('mk.change')}</th></tr></thead><tbody>
      ${top.map((r, i) => `<tr data-ags="${r.ags}"${r.ags === ags ? ' class="hl"' : ''}><td class="n">${i + 1}</td><td>${ctx.esc(r.name)}</td><td class="n mk-trips">${ctx.fmt(r.tripsDay)}</td><td class="n">${ctx.fmt(r.fleet)}</td><td class="n">${ctx.fmt(r.tvd ?? 0, 2)}</td><td class="n">${ctx.fmt(r.operators)}</td><td class="n">${ctx.fmt(r.days)}</td><td class="n mk-v ${(r.change?.trips ?? 0) >= 0 ? 'up' : 'down'}">${pctTxt(ctx, r.change?.trips)}</td></tr>`).join('')}
      ${row && !top.includes(row) ? `<tr data-ags="${row.ags}" class="hl"><td class="n">${index.rows.filter(r => r.type === type).indexOf(row) + 1}</td><td>${ctx.esc(row.name)}</td><td class="n mk-trips">${ctx.fmt(row.tripsDay)}</td><td class="n">${ctx.fmt(row.fleet)}</td><td class="n">${ctx.fmt(row.tvd ?? 0, 2)}</td><td class="n">${ctx.fmt(row.operators)}</td><td class="n">${ctx.fmt(row.days)}</td><td class="n">${pctTxt(ctx, row.change?.trips)}</td></tr>` : ''}</tbody></table></div>
    <p class="muted small">${t('mk.indexNote')}</p>` : `<div class="empty">${t('mk.noIndex')}</div>`}</div>
  <div class="panel mk-noprint"><div class="panel-head"><div><h2>${t('mk.weekTitle')}</h2><div class="sub">${t('mk.weekSub')}</div></div></div><div class="mk-week" id="mk-week">${gList?.weeks?.length ? '' : `<div class="empty">${t('mk.noWeek')}</div>`}</div></div>
  <div class="panel mk-noprint"><div class="panel-head"><div><h2>${t('mk.openTitle')}</h2><div class="sub">${t('mk.openSub')}</div></div></div>${(oList?.packages || []).length ? `<ul class="plain">${oList.packages.map(p => `<li class="mk-pkg"><b>${K.monthText(p.month)}</b> <span class="mk-files">${p.files.map(f => `<a href="${D}offen/${p.month}/${f}" target="_blank" rel="noopener" download>${ctx.esc(f)}</a>`).join(' ')}</span> <span class="muted small">${t('mk.openRows', { tage: ctx.fmt(p.rows?.tage ?? 0), monat: ctx.fmt(p.rows?.monat ?? 0) })}</span></li>`).join('')}</ul>` : `<div class="empty">${t('mk.noOpen')}</div>`}</div>
  ${eventsPanel(ctx, wirk, ags)}${pricesPanel(ctx, wirk, ags)}${scoutPanel(ctx, scout)}`;
  el.querySelector('#mk-month').addEventListener('change', (e) => { S.month = /** @type {HTMLSelectElement} */ (e.target).value; renderMarkt(el, ctx); });
  el.querySelector('#mk-type').addEventListener('change', (e) => { S.type = /** @type {HTMLSelectElement} */ (e.target).value; renderMarkt(el, ctx); });
  const svg = index ? (row ? K.citySvg(index, row) : K.indexSvg(index, { type })) : null;
  if (svg) { const img = new Image(); img.src = svgBlob(svg); img.alt = row ? t('mk.chartCity', { name: row.name }) : t('mk.chartDe'); el.querySelector('#mk-chart')?.appendChild(img); }
  el.querySelector('#mk-svg')?.addEventListener('click', () => svg && download(`mobility-pulse_index_${index.month}_${row ? row.ags : 'de'}_${type}.svg`, svg, 'image/svg+xml'));
  el.querySelector('#mk-print').addEventListener('click', () => { document.body.classList.add('mk-printing'); const end = () => { document.body.classList.remove('mk-printing'); window.removeEventListener('afterprint', end); }; window.addEventListener('afterprint', end); window.print(); setTimeout(end, 60e3); });
  if (gList?.weeks?.length) {
    const w = gList.weeks[0], box = el.querySelector('#mk-week');
    fetch(`${D}grafik/${w.file}`).then(r => (r.ok ? r.text() : null)).then(txt => { if (!txt || !box) return; const img = new Image(); img.src = svgBlob(txt); img.alt = w.title; box.innerHTML = `<p><b>${ctx.esc(w.title)}</b></p>`; box.appendChild(img);
      box.insertAdjacentHTML('beforeend', `<p class="muted small">${t('mk.weekMore')} ${gList.weeks.slice(0, 12).map(x => `<a href="${D}grafik/${x.file}" target="_blank" rel="noopener">${x.week}</a>`).join(', ')}</p>`); }).catch(() => {});
  }
}

function eventsPanel(ctx, wirk, ags) {
  const all = wirk?.events || [], mine = ags !== 'DE' ? all.filter(e => e.ags === ags) : all, list = (mine.length ? mine : all).slice(0, 40);
  const V = { mehr: t('mk.vMore'), weniger: t('mk.vLess'), 'nicht unterscheidbar': t('mk.vSame') };
  const body = list.length ? `<div class="tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('mk.evTitle'))}"><table><thead><tr><th>${t('mk.day')}</th><th>${t('mk.city')}</th><th>${t('mk.event')}</th><th class="n">${t('mk.actual')}</th><th class="n">${t('mk.forecast')}</th><th class="n">${t('mk.effect')}</th><th>${t('mk.band')}</th><th>${t('mk.verdict')}</th></tr></thead><tbody>${list.map(e => `<tr><td>${dayTxt(e.day)} ${e.window[0]}–${e.window[1]} h</td><td>${ctx.esc(ctx.muniName(e.ags))}</td><td>${e.quelle ? `<a href="${ctx.esc(e.quelle)}" target="_blank" rel="noopener">${ctx.esc(e.titel || e.art)}</a>` : ctx.esc(e.titel || e.art)}</td><td class="n">${ctx.fmt(e.actual)}</td><td class="n">${ctx.fmt(e.forecast)}</td><td class="n">${e.effect >= 0 ? '+' : '−'}${ctx.fmt(Math.abs(e.effect))} (${pctTxt(ctx, e.rel)})</td><td>${ctx.fmt(e.band[0])} … ${ctx.fmt(e.band[1])}</td><td>${V[e.verdict] || e.verdict}</td></tr>`).join('')}</tbody></table></div>`
    : `<div class="empty">${t('mk.noEvents')}</div>`;
  return `<div class="panel"><div class="panel-head"><div><h2>${t('mk.evTitle')}</h2><div class="sub">${t('mk.evSub', { n: ctx.fmt(all.length), mine: ags !== 'DE' && !mine.length ? t('mk.evNoneHere', { name: ctx.esc(ctx.muniName(ags)) }) : '' })}</div></div></div>${body}</div>`;
}
function pricesPanel(ctx, wirk, ags) {
  const all = wirk?.prices || [], list = (ags !== 'DE' && all.some(p => p.ags === ags) ? all.filter(p => p.ags === ags) : all).slice(0, 40);
  const ST = { ok: t('mk.pOk'), wartet: t('mk.pWait'), 'ohne Vergleich': t('mk.pNoCtrl'), 'zu wenig Tage': t('mk.pFewDays') };
  const body = list.length ? `<div class="tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('mk.prTitle'))}"><table><thead><tr><th>${t('mk.day')}</th><th>${t('mk.operator')}</th><th>${t('mk.city')}</th><th>${t('mk.type')}</th><th>${t('mk.status')}</th><th class="n">${t('mk.effect')}</th><th>${t('mk.ci')}</th></tr></thead><tbody>${list.map(p => `<tr><td>${dayTxt(p.day)}</td><td>${ctx.esc(p.operator)}</td><td>${ctx.esc(ctx.muniName(p.ags))}</td><td>${ctx.esc(p.type)}</td><td>${p.status === 'wartet' ? t('mk.pWaitUntil', { d: dayTxt(p.readyOn) }) : ST[p.status] || p.status}</td><td class="n">${p.status === 'ok' ? pctTxt(ctx, p.effect) : '–'}</td><td>${p.status === 'ok' ? `${pctTxt(ctx, p.ci[0])} … ${pctTxt(ctx, p.ci[1])}` : '–'}</td></tr>`).join('')}</tbody></table></div>`
    : `<div class="empty">${t('mk.noPrices')}</div>`;
  return `<div class="panel"><div class="panel-head"><div><h2>${t('mk.prTitle')}</h2><div class="sub">${t('mk.prSub')}</div></div></div>${body}</div>`;
}
// Begründung je Rang aus den zwei stärksten Merkmalen (in der Sprache der Seite; die Datei enthält dieselbe auf Deutsch)
const reasonOf = (ctx, r, km) => Object.entries(r.parts || {}).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => (k === 'pop' ? t('mk.rPop', { v: ctx.fmt(r.pop) }) : k === 'density' ? t('mk.rDensity', { v: ctx.fmt(r.densityKm2 ?? 0) })
  : k === 'near' ? t('mk.rNear', { name: r.nearest?.name || '–', km: ctx.fmt(r.nearest?.km ?? 0, 1) }) : t('mk.rFleet', { n: ctx.fmt(r.fleetNear), c: ctx.fmt(r.sharingNear), km: ctx.fmt(km) }))).join('; ');
function scoutPanel(ctx, sc) {
  const body = sc?.rows?.length ? `<div class="tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('mk.scTitle'))}"><table><thead><tr><th class="n">#</th><th>${t('mk.city')}</th><th class="n">${t('mk.pop')}</th><th class="n">${t('mk.density')}</th><th>${t('mk.nearest')}</th><th class="n">${t('mk.fleetNear')}</th><th>${t('mk.reason')}</th></tr></thead><tbody>${sc.rows.map(r => `<tr><td class="n">${r.rank}</td><td>${ctx.esc(r.name)} <span class="muted">${ctx.esc(r.state || '')}</span></td><td class="n">${ctx.fmt(r.pop)}</td><td class="n">${ctx.fmt(r.densityKm2 ?? 0)}</td><td>${r.nearest ? `${ctx.esc(r.nearest.name)} (${ctx.fmt(r.nearest.km, 1)} km)` : '–'}</td><td class="n">${ctx.fmt(r.fleetNear)}</td><td class="small">${ctx.esc(reasonOf(ctx, r, sc.radiusKm ?? 15))}</td></tr>`).join('')}</tbody></table></div>`
    : `<div class="empty">${t('mk.noScout')}</div>`;
  return `<div class="panel"><div class="panel-head"><div><h2>${t('mk.scTitle')}</h2><div class="sub">${t('mk.scSub', { n: ctx.fmt(sc?.candidates ?? 0), pop: ctx.fmt(sc?.minPop ?? 20000), km: ctx.fmt(sc?.radiusKm ?? 15) })}</div></div></div>${body}</div>`;
}
