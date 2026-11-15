// @ts-check
// Mobility Pulse — Umfeld (Sprint 8): Versorgung der Einwohner (S8.2), Unfälle (S8.3), ÖPNV-Zubringer (S8.5), Umwegfaktor (S8.6),
// Abstellflächen-Planer (S8.4) und der Zensus-Abgleich (S8.1). renderUmfeld(el, ctx), ctx = rpCtx(). Daten aus dem Sammler (Phase „geo“):
// versorgung/, unfall/, zubringer/index.json, umweg/, abstell/<AGS>.json, pop/index.json. Der Planer lädt OSM (Overpass) erst auf Knopfdruck.
import * as PL from './pulse-geo-plan.js';
import * as Z from './pulse-zones.js';
import { t, dateFmt } from './i18n.js';
import { putAnswer } from './answer.js';

const cache = new Map(), S = { run: 0, plan: null, planFor: null };
const load = (ctx, url) => { if (!cache.has(url)) cache.set(url, ctx.getJson(url, { timeout: 30000 }).then(r => (r?.ok ? r.json : null)).catch(() => null)); return cache.get(url); };
const pct = (ctx, x, d = 0) => (x == null ? '–' : `${ctx.fmt(x * 100, d)} %`);
const osm = (lat, lon) => `<a href="https://www.openstreetmap.org/?mlat=${lat.toFixed(5)}&mlon=${lon.toFixed(5)}#map=17/${lat.toFixed(5)}/${lon.toFixed(5)}" target="_blank" rel="noopener">${lat.toFixed(4)}, ${lon.toFixed(4)}</a>`;
const cellLL = (c) => { const i = c.indexOf(':'); return [+c.slice(0, i) * 0.0025, +c.slice(i + 1) * 0.0035]; };
const dayTxt = (d) => (d ? dateFmt({ day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`)) : '');
const monthTxt = (m) => (m ? dateFmt({ month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${m}-15T12:00:00Z`)) : '');
const median = (a) => { const s = a.filter(x => x != null).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };
const download = (name, text) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0); };

export async function renderUmfeld(el, ctx) {
  const ags = ctx.state.scope, run = ++S.run, D = ctx.CFG.DATA;
  el.innerHTML = `<div class="panel"><p class="muted">${t('geo.loading')}</p></div>`;
  const [vIdx, uIdx, zub, wIdx, pIdx] = await Promise.all(['versorgung/index.json', 'unfall/index.json', 'zubringer/index.json', 'umweg/index.json', 'pop/index.json'].map(f => load(ctx, D + f)));
  if (run !== S.run) return;
  const city = ags && ags !== 'DE';
  const [ver, unf, umw, abs] = city ? await Promise.all([`versorgung/${ags}.json`, `unfall/${ags}.json`, `umweg/${ags}.json`, `abstell/${ags}.json`].map(f => load(ctx, D + f))) : [null, null, null, null];
  if (run !== S.run) return;
  const f = ctx.fmt, name = city ? ctx.esc(ctx.muniName(ags)) : t('geo.germany');
  const vi = vIdx?.ags || {}, allShare = Object.values(vi).map(r => r[3]), med200 = median(allShare), medBig = median(Object.values(vi).filter(r => r[1] >= 100000).map(r => r[3]));
  const runsTxt = (n) => (n === 1 ? t('geo.runOne') : t('geo.runMany', { n: f(n || 0) }));
  // ---------- Antwort ----------
  const last = ver?.days?.at(-1) || null, cur = last || ver?.today || null;
  if (city && cur) {
    putAnswer(el, { id: 'umfeld', sentence: t('geo.answer', { name, p: `<strong>${pct(ctx, cur.share[1])}</strong>`, from: ver.dayFrom, to: ver.dayTo }),
      kpis: [{ label: t('geo.k200'), value: pct(ctx, cur.share[1]), n: cur.share[1] * 100, cmp: medBig != null ? t('geo.kCmpAll', { v: pct(ctx, medBig) }) : t('geo.kCmpNone'), eq: '#geo-ver td.geo-s200' },
        { label: t('geo.kTime50'), value: pct(ctx, cur.time50[1]), cmp: t('geo.kTime50Cmp') },
        { label: t('geo.kGini'), value: cur.gini == null ? '–' : f(cur.gini, 2), cmp: t('geo.kGiniCmp') }], how: t('geo.how'), asOf: last ? dayTxt(last.day) : t('geo.provisional') });
  } else if (!city && Object.keys(vi).length) {
    putAnswer(el, { id: 'umfeld', sentence: t('geo.answerDe', { n: f(Object.keys(vi).length), p: `<strong>${pct(ctx, med200)}</strong>` }), kpis: [{ label: t('geo.k200Median'), value: pct(ctx, med200), cmp: t('geo.kCities', { n: f(Object.keys(vi).length) }) }], how: t('geo.how') });
  } else putAnswer(el, { id: 'umfeld', sentence: t('geo.answerNone', { name }), kpis: [{ label: t('geo.k200'), value: '–' }, { label: t('geo.kTime50'), value: '–' }, { label: t('geo.kGini'), value: '–' }], how: t('geo.how') });

  // ---------- Versorgung ----------
  const radii = ver?.radii || [150, 200, 300];
  const verPanel = city ? (cur ? `<div class="panel"><div class="panel-head"><div><h2>${t('geo.verTitle', { name })}</h2><div class="sub">${t('geo.verSub', { day: last ? dayTxt(last.day) : t('geo.provisional'), runs: runsTxt(cur.runsDay), pop: f(ver.pop) })}</div></div></div>
      <div class="tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('geo.verTitle', { name }))}"><table id="geo-ver"><thead><tr><th>${t('geo.band')}</th>${radii.map(r => `<th class="n">${t('geo.within', { r })}</th>`).join('')}</tr></thead><tbody>
      <tr><td>${t('geo.day7to22')}</td>${cur.share.map((x, i) => `<td class="n${i === 1 ? ' geo-s200' : ''}">${pct(ctx, x, 1)}</td>`).join('')}</tr>
      <tr><td>${t('geo.time50Row')}</td>${cur.time50.map(x => `<td class="n">${pct(ctx, x, 1)}</td>`).join('')}</tr>
      ${(cur.band || []).map((b, i) => (b ? `<tr><td>${t(`band.${i}`)}</td>${b.map(x => `<td class="n">${pct(ctx, x, 1)}</td>`).join('')}</tr>` : '')).join('')}</tbody></table></div>
      <p class="small">${t('geo.subCheck', { d: f(cur.diffPP ?? 0, 2), n: runsTxt(cur.runsDay3 || 0) })}</p>
      ${ver.missingOps?.length ? `<p class="small warn-text">${t('geo.missingOps', { ops: ctx.esc(ver.missingOps.join(', ')) })}</p>` : ''}
      ${ver.cells?.rows?.length ? `<h3>${t('geo.lowCells')}</h3><div class="tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('geo.lowCells'))}"><table><thead><tr><th>${t('geo.cell')}</th><th class="n">${t('geo.pop')}</th>${radii.map(r => `<th class="n">${t('geo.within', { r })}</th>`).join('')}</tr></thead><tbody>
        ${ver.cells.rows.filter(r => r[1] >= 50).sort((a, b) => (a[3] ?? 1) - (b[3] ?? 1) || b[1] - a[1]).slice(0, 15).map(r => `<tr><td>${osm(...cellLL(r[0]))}</td><td class="n">${f(r[1])}</td>${r.slice(2).map(x => `<td class="n">${pct(ctx, x)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : ''}
      <p class="muted small">${t('geo.verNote')}</p></div>`
    : `<div class="panel"><div class="empty">${t('geo.verNone', { name })}</div></div>`)
    : `<div class="panel"><div class="panel-head"><div><h2>${t('geo.verTop')}</h2><div class="sub">${t('geo.verTopSub')}</div></div></div>${Object.keys(vi).length ? `<div class="tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('geo.verTop'))}"><table><thead><tr><th>${t('geo.city')}</th><th class="n">${t('geo.pop')}</th>${radii.map(r => `<th class="n">${t('geo.within', { r })}</th>`).join('')}<th class="n">${t('geo.kGini')}</th></tr></thead><tbody>
      ${Object.entries(vi).sort((a, b) => b[1][1] - a[1][1]).slice(0, 30).map(([a, r]) => `<tr><td><button type="button" class="chip" data-ags="${a}">${ctx.esc(ctx.muniName(a))}</button></td><td class="n">${f(r[1])}</td>${r.slice(2, 5).map(x => `<td class="n">${pct(ctx, x)}</td>`).join('')}<td class="n">${r[8] == null ? '–' : f(r[8], 2)}</td></tr>`).join('')}</tbody></table></div>` : `<div class="empty">${t('geo.verNoneDe')}</div>`}</div>`;
  // ---------- Unfälle ----------
  const ui = city ? uIdx?.ags?.[ags] : null, years = unf?.years || ui?.years || uIdx?.years || [], landGap = (uIdx?.years || []).filter(y => !years.includes(y));
  const unfPanel = city ? `<div class="panel"><div class="panel-head"><div><h2>${t('geo.unfTitle', { name })}</h2><div class="sub">${unf ? t('geo.unfSub', { from: years[0], to: years.at(-1), hot: f(unf.hot || 0) }) : ''}</div></div></div>
      ${unf ? `<div class="tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('geo.unfYears'))}"><table><thead><tr><th>${t('geo.year')}</th>${['alle', 'rad', 'fuss', 'krad', 'sonst', 'schwer'].map(k => `<th class="n">${t(`geo.cat.${k}`)}</th>`).join('')}</tr></thead><tbody>
        ${Object.entries(unf.sums || {}).filter(([y]) => years.includes(+y)).sort().map(([y, s]) => `<tr><td>${y}</td>${['alle', 'rad', 'fuss', 'krad', 'sonst', 'schwer'].map(k => `<td class="n">${f(s[k] || 0)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
        <h3>${t('geo.hotTitle')}</h3><div class="tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('geo.hotTitle'))}"><table id="geo-hot"><thead><tr><th>${t('geo.cell')}</th><th class="n">${t('geo.cat.alle')}</th><th class="n">${t('geo.cat.rad')}</th><th class="n">${t('geo.cat.schwer')}</th><th class="n">${t('geo.ebRate')}</th><th class="n">Gi*</th></tr></thead><tbody>
        ${unf.rows.filter(r => r.at(-1) === 1).slice(0, 15).map(r => `<tr><td>${osm(...cellLL(r[0]))}</td><td class="n">${f(r[1])}</td><td class="n">${f(r[2])}</td><td class="n">${f(r[6])}</td><td class="n">${f(r[7], 2)}</td><td class="n">${f(r[8], 1)}</td></tr>`).join('') || `<tr><td colspan="6" class="muted">${t('geo.noHot')}</td></tr>`}</tbody></table></div>
        <p class="small">${t('geo.overlap', { o: unf.overlap == null ? '–' : pct(ctx, unf.overlap), a: (unf.halves?.[0] || []).join('–'), b: (unf.halves?.[1] || []).join('–') })}${ui ? ` ${t('geo.sumCheck', { a: f(ui.cellSum), b: f(ui.srcSum) })}` : ''}</p>
        <p class="muted small">${t('geo.unfNote')}${uIdx?.missingYears?.length ? ` ${t('geo.missingYears', { y: uIdx.missingYears.join(', ') })}` : ''}${landGap.length ? ` ${t('geo.unfLandGap', { y: landGap.join(', ') })}` : ''}</p>` : `<div class="empty">${t('geo.unfNone')}</div>`}</div>` : '';
  // ---------- Zubringer ----------
  const zc = zub?.cities || [], me = zc.find(c => c.ags === ags);
  const zubPanel = `<div class="panel"><div class="panel-head"><div><h2>${t('geo.zubTitle')}</h2><div class="sub">${t('geo.zubSub', { day: zub?.timetableDay ? dayTxt(`${zub.timetableDay.slice(0, 4)}-${zub.timetableDay.slice(4, 6)}-${zub.timetableDay.slice(6, 8)}`) : '–' })}</div></div></div>
    ${zc.length ? `${me ? (() => { const v = me.last || me.today || {}, x = v.base > 0 && v.share != null ? v.share / v.base : null; return `<p>${t('geo.zubMe', { name, i: f(v.index ?? 0, (v.index ?? 0) < 1 ? 2 : 1), s: pct(ctx, v.share), b: pct(ctx, v.base), x: x == null ? '–' : f(x, 2), dep: f(me.dep) })}${v.moved ? ` ${f(v.moved)} ${t('geo.zubMoved')}.` : ''}</p>`; })() : ''}<div class="tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('geo.zubTitle'))}"><table id="geo-zub"><thead><tr><th class="n">#</th><th>${t('geo.city')}</th><th class="n">${t('geo.zubIndex')}</th><th class="n">${t('geo.zubShare')}</th><th class="n">${t('geo.zubBase')}</th><th class="n">${t('geo.zubFactor')}</th><th class="n">${t('geo.zubDep')}</th></tr></thead><tbody>
      ${[...zc].sort((a, b) => ((b.last || b.today)?.index ?? -1) - ((a.last || a.today)?.index ?? -1)).map((c, i) => { const v = c.last || c.today; return `<tr${c.ags === ags ? ' class="hl"' : ''}><td class="n">${i + 1}</td><td>${ctx.esc(c.name)}</td><td class="n">${v?.index == null ? '–' : f(v.index, v.index < 1 ? 2 : 1)}</td><td class="n">${pct(ctx, v?.share)}</td><td class="n">${pct(ctx, v?.base)}</td><td class="n">${v?.base > 0 && v?.share != null ? f(v.share / v.base, 2) : '–'}</td><td class="n">${f(c.dep)}</td></tr>`; }).join('')}</tbody></table></div><p class="muted small">${t('geo.zubNote')}</p>` : `<div class="empty">${t('geo.zubNone')}</div>`}</div>`;
  // ---------- Umwegfaktor ----------
  const wi = city ? wIdx?.cities?.[ags] : null;
  const umwPanel = city ? `<div class="panel"><div class="panel-head"><div><h2>${t('geo.umwTitle', { name })}</h2><div class="sub">${t('geo.umwSub')}</div></div></div>
    ${umw ? `<p>${t('geo.umwMe', { m: f(umw.median ?? 0, 2), p90: f(umw.p90 ?? 0, 2), o: pct(ctx, umw.over15) })}</p>${(umw.samples || wi?.samples || []).length ? `<p class="small">${t('geo.umwSamples', { list: (umw.samples || wi.samples).map(s => `${f(s.ours)} m / ${f(s.router)} m (${s.dev >= 0 ? '+' : '−'}${f(Math.abs(s.dev) * 100, 0)} %)`).join('; ') })}</p>` : ''}
      <div class="tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('geo.umwWorst'))}"><table><thead><tr><th>${t('geo.cell')}</th><th class="n">${t('geo.umwFactor')}</th></tr></thead><tbody>${umw.rows.filter(r => r[2] != null).sort((a, b) => b[2] - a[2]).slice(0, 10).map(r => `<tr><td>${osm(r[0], r[1])}</td><td class="n">${f(r[2], 2)}</td></tr>`).join('')}</tbody></table></div><p class="muted small">${t('geo.umwNote')}</p>` : `<div class="empty">${t('geo.umwNone')}</div>`}</div>` : '';
  // ---------- Planer ----------
  const demand = PL.demandFromDoc(abs);
  const planPanel = city ? `<div class="panel"><div class="panel-head"><div><h2>${t('geo.planTitle')}</h2><div class="sub">${abs ? t('geo.planSub', { n: f(demand.length), month: monthTxt(abs.month) }) : ''}</div></div>
      ${demand.length ? `<form class="inline-form" id="geo-plan-form" novalidate><label>${t('geo.planK')}<input type="number" id="geo-plan-k" value="20" min="1" max="100" inputmode="numeric"></label><button class="primary" type="submit">${t('geo.planRun')}</button><button type="button" id="geo-plan-csv" disabled>${t('geo.planCsv')}</button></form>` : ''}</div>
    ${demand.length ? `<p class="small" id="geo-plan-status" role="status">${t('geo.planHint')}</p><div id="geo-plan-out"></div>` : `<div class="empty">${t('geo.planNone')}</div>`}</div>` : '';
  const popNote = pIdx ? `<p class="muted small">${t('geo.popCheck', { w: f(pIdx.within || 0), n: f(pIdx.n || 0), d: f((pIdx.maxDev || 0.03) * 100) })}${pIdx.withinAdj != null ? ` ${t('geo.popCheckAdj', { w: f(pIdx.withinAdj), n: f(pIdx.n || 0) })}` : ''}</p>` : '';
  el.innerHTML = verPanel + unfPanel + zubPanel + umwPanel + planPanel + `<div class="panel"><p class="muted small">${t('geo.sources')}</p>${popNote}</div>`;
  el.querySelectorAll('button[data-ags]').forEach(b => b.addEventListener('click', () => ctx.setScope?.(b.getAttribute('data-ags'))));
  const form = el.querySelector('#geo-plan-form'); if (form) form.addEventListener('submit', (e) => { e.preventDefault(); runPlan(el, ctx, ags, demand); });
  el.querySelector('#geo-plan-csv')?.addEventListener('click', () => S.plan && download(`abstellflaechen_${ags}.csv`, ['lat;lon;fahrtenden_50m;vorhandene_flaeche_50m', ...S.plan.picks.map(p => `${p.lat.toFixed(5).replace('.', ',')};${p.lon.toFixed(5).replace('.', ',')};${p.covered};${p.near ? 'ja' : 'nein'}`)].join('\n') + '\n'));
}

async function runPlan(el, ctx, ags, demand) {
  const st = el.querySelector('#geo-plan-status'), out = el.querySelector('#geo-plan-out'), k = Math.max(1, Math.min(100, +(/** @type {HTMLInputElement} */ (el.querySelector('#geo-plan-k'))).value || 20));
  const bb = PL.demandBox(demand); if (!bb) return;
  st.textContent = t('geo.planLoading');
  let osmJson = null;
  for (const ep of ctx.CFG.OVERPASS || []) {
    try { const ctrl = new AbortController(), tq = setTimeout(() => ctrl.abort(), 120000); const r = await fetch(ep, { method: 'POST', body: new URLSearchParams({ data: PL.overpassPlan(bb) }), signal: ctrl.signal }); clearTimeout(tq); if (r.ok) { const j = await r.json(); if (Array.isArray(j?.elements)) { osmJson = j; break; } } } catch { /* nächster Spiegel */ }
  }
  if (!osmJson) { st.textContent = t('geo.planFail'); return; }
  // Abstell- und Fahrverbote aller Anbieter in der Gemeinde
  const idx = await load(ctx, `${ctx.CFG.DATA}zones/index.json`), mine = (idx?.zones || []).filter(z => (z.municipalities || []).includes(ags));
  const docs = (await Promise.all(mine.map(z => load(ctx, `${ctx.CFG.DATA}zones/${z.file}`)))).filter(Boolean);
  const zAll = Z.zonesFor(docs), isl = PL.parkingIslands(zAll), bans = zAll.filter(z => z.kind === 'no_park' || z.kind === 'no_ride').map(z => ({ g: z.geometry, bb: Z.bboxOf(z.geometry) }));
  const noPark = (la, lo) => bans.some(b => lo >= b.bb[0] && lo <= b.bb[2] && la >= b.bb[1] && la <= b.bb[3] && Z.contains(b.g, lo, la));
  const o = PL.parseOsm(osmJson), cands = PL.candidatesAlong(o.ways), res = PL.planSpots(demand.filter(d => d[0] >= bb[0] && d[0] <= bb[2] && d[1] >= bb[1] && d[1] <= bb[3]), cands, { k, noPark, stops: o.stops, cross: PL.crossings(o.roads) });
  const have = [...o.existing, ...isl], share = PL.nearExisting(res.picks, have, 50); for (const p of res.picks) p.near = PL.isNear(p, have, 50);
  S.plan = res; /** @type {HTMLButtonElement} */ (el.querySelector('#geo-plan-csv')).disabled = !res.picks.length;
  const f = ctx.fmt;
  st.textContent = t('geo.planDone', { k: f(res.picks.length), c: f(res.covered), tot: f(res.total), cand: f(res.usable), np: f(res.excluded.noPark), s: f(res.excluded.stop), x: f(res.excluded.cross), near: share == null ? '–' : `${f(share * 100, 0)} %`, ex: f(o.existing.length), isl: f(isl.length), zones: f(bans.length) });
  out.innerHTML = `<div class="tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('geo.planTitle'))}"><table id="geo-plan"><thead><tr><th class="n">#</th><th>${t('geo.planSpot')}</th><th class="n">${t('geo.planCovered')}</th><th>${t('geo.planNear')}</th></tr></thead><tbody>${res.picks.map((p, i) => `<tr><td class="n">${i + 1}</td><td>${osm(p.lat, p.lon)}</td><td class="n">${f(p.covered)}</td><td>${p.near ? t('geo.yes') : t('geo.no')}</td></tr>`).join('')}</tbody></table></div>`;
}
