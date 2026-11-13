// Mobility Pulse — Prognose (Ansicht) – Hauptansicht, Grundlagen, Modell zum Mitnehmen, Veranstaltungen (aus forecast.js geschnitten; forecast.js bleibt die Fassade für alle Importe).
import * as FC from './pulse-forecast.js';
import * as CX from './pulse-context.js';
import * as SP from './pulse-spots.js';
import { DEFAULTS as OPS } from './pulse-ops.js';
import { VEHICLE_TYPE_LABEL } from './pulse-core.js';
import { dayType } from './pulse-econ.js';
import { t, tMap, dateFmt, numFmt, fcReason } from './i18n.js';
import { weatherFor, weatherSvg } from './weather.js';
import { FAM, LAST_RATED, TZ, accRows, accuracyPanel, addDays, badge, berlinNow, blendTxt, css, dayStats, dayTxt, famFile, famNow, fj, head, learnPanel, memo, modelName, n0, pc, pickScope, raceOf, scopePanel, seriesOf, sg, st, sum, tile, timeline } from './forecast-data.js';
import { NOT_KEYS, NOT_STATE, bindDl, bindTop, csvBtn, curvePanel, dlRow, download, envHtml, fileTag, gradeLine, gradePanel, judge, paintSpots, paramRows, spotsPanelShell, topBar } from './forecast-parts.js';

// ---------- Hauptansicht ----------
/** part: 'verlauf' (Standard) | 'spots' | 'basis' – jedes Segment des Reiters „Prognose“ hat einen eigenen Container */
export async function renderForecastView(el, ctx, opts = {}) {
  if (!el) return;
  const part = ['spots', 'basis'].includes(opts.part) ? opts.part : 'verlauf';
  css(); const s = st(el), tok = ++s.tok; el.classList.add('fv-root'); el.dataset.fvPart = part;
  if (!el.firstChild) el.innerHTML = `<div class="note small">${t('fv.loading')}</div>`;
  const fam = famNow(ctx);
  // ohne Prognose der gewählten Familie: Umschalter bleibt sichtbar, damit man zurückwechseln kann
  const none = () => { el.innerHTML = (fam === 'micro' ? '' : topBar(ctx, { ags: ctx.state?.scope || 'DE' })) + `<div class="panel"><div class="empty"><b>${fam === 'micro' ? t('fv.none') : t('fv.noneFam', { fam: t(`fv.fam.${fam}`) })}</b>${fam === 'micro' ? t('fv.noneHint') : t('fv.noneFamHint')}</div></div>`; if (fam !== 'micro') bindTop(el, ctx); };
  try {
    const [S0, L, G] = await Promise.all([fj(ctx, famFile(fam, 'series')), fj(ctx, famFile(fam, 'latest')), fj(ctx, famFile(fam, 'log'))]); if (tok !== s.tok) return;
    if (!S0 || S0.version !== 1 || !L) { none(); return; }
    if (part === 'spots') return await renderSpotsPart(el, ctx, s, S0, L);
    if (part === 'basis') return renderBasisPart(el, ctx, s, S0, L, G);
    await renderVerlauf(el, ctx, s, tok, S0, L, G);
  } catch (e) { console.error('Prognose-Ansicht', e); if (tok === s.tok) none(); }
}

async function renderVerlauf(el, ctx, s, tok, S0, L, G) {
  const { esc } = ctx;
  const sel = pickScope(S0, ctx.state), today = S0.today, bn = berlinNow();
  // heutige Ist-Werte frisch aus der Tagesdatei (der Sammler schreibt die Reihen höchstens stündlich)
  const fresh = await freshActual(ctx, S0, sel, today); if (tok !== s.tok) return;
  if (s.norm == null) { try { s.norm = localStorage.getItem('fv-norm') !== '0'; } catch { s.norm = true; } }
  const live = fresh?.a || null, norm = s.norm !== false, stale = bn.day !== today;
  const dayList = Object.keys(S0.days).filter(d => d <= today).sort().reverse(); // heute, gestern, …
  const view = s.day && (s.day === 'ahead' || dayList.includes(s.day)) ? s.day : 'ahead';
  s.day = view;
  const nowH = bn.day === today ? bn.h : bn.day > today ? 24 : 0, T = today, TM = addDays(today, 1);
  const eT = seriesOf(S0, T, sel), eM = seriesOf(S0, TM, sel);
  if (live) eT.a = live;
  // Zeilen des Diagramms; norm: je volle Stunde (Audit MET-01: der Sammler läuft alle ~18 Min., eine Stunde zählt 3 oder 4 Läufe und damit
  // 50–76 Minuten. Ist × 60 ÷ beobachtete Minuten des Tages; Plan und Live-Prognose × 60 ÷ beobachtete Minuten des Tages, dessen Fahrzeugstunden
  // sie verwenden (zuletzt beobachteter Tag davor, wie lib/pulse-forecast.js lastExposure). Nur Anzeige; Summen und Kacheln bleiben gezählt.
  // Ist zählt je Lauf in der Endstunde: Normierung mit den Minuten der Endstunde (obsEnd, seit 13.11.2026; obs ist seitdem anteilig je Stunde, S1.1)
  const obsOf = (d) => (d === today && fresh?.obs ? fresh.obs : (ctx.state.latest?.measure?.days?.[d]?.obsEnd ?? ctx.state.latest?.measure?.days?.[d]?.obs)) || null;
  const mDays = [...new Set([...Object.keys(ctx.state.latest?.measure?.days || {}), today])].sort();
  const fA = (d, h) => { const o = obsOf(d)?.[h]; return norm && o >= 30 ? 60 / o : 1; };
  const fP = (d, h) => { if (!norm) return 1; for (let i = mDays.length - 1; i >= 0; i--) { const e = mDays[i]; if (e >= d) continue; const o = obsOf(e)?.[h]; if (o >= FC.GATES.hourMinObserved) return 60 / o; } return 1; };
  const nz = (v, f) => (v == null ? null : v * f);
  // üblicher Bereich (Audit UXP-09): gezählte Werte derselben Stunde an den letzten 3 Tagen gleicher Art (Werktag / Samstag / Sonn- und Feiertag) vor dem Tag
  const land = sel.ags && sel.ags !== 'DE' ? FC.LAND_OF_AGS[String(sel.ags).slice(0, 2)] ?? null : null, clsOf = (d) => FC.classOf(dayType(d, land, ctx.state.calendar || null));
  const pastDays = Object.keys(S0.days).filter(d => d <= today).sort();
  const usualOf = (day, h) => { const c = clsOf(day), v = [];
    for (let i = pastDays.length - 1; i >= 0 && v.length < 3; i--) { const d = pastDays[i]; if (d >= day || clsOf(d) !== c) continue; const a = (d === today && live ? live : seriesOf(S0, d, sel).a)?.[h]; if (a != null) v.push(a * fA(d, h)); }
    return v.length >= 2 ? [Math.min(...v), Math.max(...v)] : null; };
  const mk = (day, e, withLive) => Array.from({ length: 24 }, (_, h) => ({ day, h, p: nz(e.p?.[h], fP(day, h)), a: nz(e.a?.[h], fA(day, h)), l: withLive ? nz(e.l?.[h], fP(day, h)) : null, c: e.c?.[h] ?? null, u: usualOf(day, h) }));
  let rows, blocks, nowIdx = null, title;
  if (view === 'ahead') {
    rows = [...mk(T, eT, true), ...mk(TM, eM, true)];
    // Audit UXP-10: nach Mitternacht, bevor der erste Lauf des neuen Tags die Reihen fortschreibt, stimmt „Heute“ nicht – dann nur Datum
    blocks = stale ? [{ from: 0, to: 24, label: dayTxt(T) }, { from: 24, to: 48, label: dayTxt(TM) }] : [{ from: 0, to: 24, label: `${t('fv.today')} · ${dayTxt(T)}` }, { from: 24, to: 48, label: `${t('fv.tomorrow')} · ${dayTxt(TM)}` }];
    nowIdx = nowH < 24 ? nowH : null; title = t('fv.chartAhead');
  } else {
    const e = seriesOf(S0, view, sel); rows = mk(view, e, false); blocks = [{ from: 0, to: 24, label: dayTxt(view, { weekday: 'long', day: 'numeric', month: 'long' }) }]; title = t('fv.chartDay', { d: dayTxt(view) });
  }
  const scopeTxt = scopeLabel(ctx, sel);
  const segs = [['ahead', t('fv.todayTomorrow')], ...dayList.filter(d => d < T).slice(0, 4).map(d => [d, d === addDays(T, -1) ? t('fv.yesterday') : dayTxt(d, { weekday: 'short', day: 'numeric', month: 'numeric' })])];
  const noSeries = !sel.keys.length || (!eT.p && !eT.l && !eT.a);
  // Kacheln
  const prevA = seriesOf(S0, addDays(T, -1), sel).a, stT = dayStats({ p: eT.p, a: eT.a }, prevA);
  // Erwartung bis Tagesende: gezählte Stunden + für alle übrigen Stunden die Live-Prognose, wo es keine gibt der Plan
  const doneIst = eT.a ? sum(eT.a.filter(x => x != null)) : 0, planDay = eT.p ? sum(eT.p) : null, totalM = eM.l ? sum(eM.l) : eM.p ? sum(eM.p) : null;
  const expectDay = Array.from({ length: 24 }, (_, h) => eT.a?.[h] ?? eT.l?.[h] ?? eT.p?.[h] ?? 0).reduce((x, y) => x + y, 0);
  // Spitze je Tag (Audit UXP-08) aus den angezeigten Stundenwerten: gezählt, sonst Live-Prognose, sonst Plan
  const peakOf = (from, to) => { let bi = -1, bv = -1; for (let i = from; i < to; i++) { const r = rows[i], v = r?.a ?? r?.l ?? r?.p; if (v != null && v > bv) { bv = v; bi = i; } } return bi < 0 ? null : { i: bi, h: rows[bi].h, v: bv, src: rows[bi].a != null ? 'a' : rows[bi].l != null ? 'l' : 'p' }; };
  const peaks = view === 'ahead' ? [peakOf(0, 24), peakOf(24, 48)] : [peakOf(0, 24)];
  const pkTile = (pk, lbl) => tile(lbl, pk ? t('fv.kPeakV', { h: String(pk.h).padStart(2, '0'), h2: String((pk.h + 1) % 24).padStart(2, '0') }) : '–', pk ? t(pk.src === 'a' ? 'fv.kPeakSubA' : 'fv.kPeakSubF', { v: n0(pk.v), u: norm ? t('fv.perFullHour') : '' }) : t('fv.kNoPlan'));
  const tiles = noSeries ? '' : `<div class="tiles">${tile(t('fv.kSoFar'), n0(doneIst), stT ? t('fv.kSoFarSub', { plan: n0(stT.plan), d: sg(stT.bias, 1) }) : t('fv.kNoPlan'))}`
    + `${tile(t('fv.kErr'), stT ? pc(stT.wape) : '–', stT ? (stT.naive != null ? t('fv.kErrSub', { naive: pc(stT.naive), verdict: t(judge(stT.wape, stT.naive) === 'better' ? 'fv.gBetter' : judge(stT.wape, stT.naive) === 'worse' ? 'fv.gWorse' : 'fv.gEqual') }) : t('fv.kErrSub1', { n: stT.n })) : t('fv.kNoPlan'))}`
    + `${tile(t('fv.kDay'), n0(expectDay), planDay != null ? t('fv.kDaySub', { plan: n0(planDay), d: sg(planDay > 0 ? expectDay / planDay - 1 : null, 1) }) : t('fv.kNoPlan'))}`
    + `${tile(t('fv.kTomorrow'), totalM == null ? '–' : n0(totalM), totalM != null && expectDay > 0 ? t('fv.kTomorrowSub', { d: sg(totalM / expectDay - 1, 0) }) : t('fv.kNoPlan'))}`
    + (view === 'ahead' ? `${pkTile(peaks[0], stale ? t('fv.kPeakD', { d: dayTxt(T) }) : t('fv.kPeakToday'))}${pkTile(peaks[1], stale ? t('fv.kPeakD', { d: dayTxt(TM) }) : t('fv.kPeakTomorrow'))}` : pkTile(peaks[0], t('fv.kPeakD', { d: dayTxt(view) }))) + '</div>';
  const lead = noSeries ? `<div class="empty"><b>${t('fv.noScope')}</b>${esc(t('fv.noScopeHint'))}</div>` : '';
  const dataTable = noSeries ? '' : `<details class="fv-data"><summary>${t('fv.tableToggle')}</summary><div class="tbl" tabindex="0" role="region" aria-label="${esc(t('fv.tableToggle'))}"><table><thead><tr><th>${t('fv.colDay')}</th><th class="n">${t('fv.colHour')}</th><th class="n">${t('fv.colIst')}</th><th class="n">${t('fv.colPlan')}</th><th class="n">${t('fv.colLive')}</th></tr></thead><tbody>${rows.map(r => `<tr><td>${esc(dayTxt(r.day))}</td><td class="n">${String(r.h).padStart(2, '0')}:00</td><td class="n">${n0(r.a)}</td><td class="n">${n0(r.p)}</td><td class="n">${n0(r.l)}</td></tr>`).join('')}</tbody></table></div></details>`;
  const notes = [sel.partial ? t('fv.nPartial') : '', sel.ignored ? t('fv.nIgnored') : '', S0.generatedAt ? t('fv.asOf', { time: dateFmt({ dateStyle: 'short', timeStyle: 'short', timeZone: TZ }).format(new Date(S0.generatedAt)) }) : ''].filter(Boolean).join(' ');
  const accRowsNow = accRows(S0, sel, G);
  el.innerHTML = topBar(ctx, sel, noSeries ? '' : `${csvBtn('series', t('fv.csvSeries'))}${accRowsNow.length ? csvBtn('days', t('fv.csvDays')) : ''}`)
    + `<div class="fv-grid"><div class="panel">${head(title, t('fv.chartSub'), `<span class="fv-scope">${t('fv.scope')}: <b>${esc(scopeTxt)}</b></span>`)}${gradeLine(ctx, S0, sel, G, L)}${stale ? `<p class="fv-stale warn-text">${esc(t('fv.staleDay', { time: S0.generatedAt ? dateFmt({ dateStyle: 'short', timeStyle: 'short', timeZone: TZ }).format(new Date(S0.generatedAt)) : '–' }))}</p>` : ''}${lead || ''}`
    + `<div class="fv-ctl"><div class="fv-tog" role="group" aria-label="${esc(t('fv.dayAria'))}">${segs.map(([v, l]) => `<button data-v="${esc(v)}" aria-pressed="${v === view}">${esc(l)}</button>`).join('')}</div>`
    + `<div class="fv-tog fv-norm" role="group" aria-label="${esc(t('fv.normAria'))}"><button data-n="1" aria-pressed="${norm}" title="${esc(t('fv.normTip'))}">${t('fv.normOn')}</button><button data-n="0" aria-pressed="${!norm}">${t('fv.normOff')}</button></div></div>`
    + (noSeries ? '' : `${tiles}<div class="fv-legend" style="margin-top:var(--s3)"><span><i class="k-a"></i>${t('fv.ist')}</span><span><i class="k-l"></i>${t('fv.live')}</span><span><i class="k-p"></i>${t('fv.plan')}</span>${rows.some(r => r.u) ? `<span title="${esc(t('fv.usualTip'))}"><i class="k-u"></i>${t('fv.usual')}</span>` : ''}${rows.some(r => r.c != null) ? `<span title="${esc(t('fv.chronosTip'))}"><i class="k-c"></i>${t('fv.chronos')}</span>` : ''}</div>${timeline(ctx, rows, { nowIdx: view === 'ahead' && !stale ? nowIdx : null, width: el.clientWidth - 40, blocks, peaks: peaks.filter(Boolean).map(p => p.i) })}<div class="fv-chart fv-wx"></div><div class="fv-sub">${t('fv.chartNote')} ${norm ? t('fv.normNote') : ''} ${esc(notes)}</div>${dataTable}`) + '</div>'
    + `${gradePanel(ctx, S0, sel, G, L)}${scopePanel(ctx, S0, sel, G, L)}`
    + `${eventsMainShell(ctx, sel)}${accuracyPanel(ctx, S0, sel, G, L)}${curvePanel(ctx, G, L, el.clientWidth - 40)}${learnPanel(ctx, L, G)}<p class="fv-sub">${t('fv.moreBasis')} <a href="#prognose-basis">${t('fv.segBasis')}</a>.</p></div>`;
  bindTop(el, ctx); bindDl(el, ctx, S0, L, G, sel);
  el.querySelectorAll('.fv-tog button[data-v]').forEach(b => b.addEventListener('click', () => { s.day = b.dataset.v; renderForecastView(el, ctx, { part: 'verlauf' }); }));
  el.querySelectorAll('.fv-norm button').forEach(b => b.addEventListener('click', () => { s.norm = b.dataset.n === '1'; try { localStorage.setItem('fv-norm', s.norm ? '1' : '0'); } catch {} renderForecastView(el, ctx, { part: 'verlauf' }); }));
  el.querySelector('.fv-gline a')?.addEventListener('click', (e) => { e.preventDefault(); el.querySelector('#fv-grade')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  if (!noSeries) fillWx(el.querySelector('.fv-wx'), ctx, rows, sel, el.clientWidth - 40);
  if (!noSeries) markEvents(el, ctx, rows, sel);
  fillEventsMain(el.querySelector('#fv-ev-main .fv-ev-body'), ctx, sel, S0);
  el.querySelector('[data-fv-csv="series"]')?.addEventListener('click', () => download(`prognose_stundenreihe_${fileTag(ctx, sel)}_${view === 'ahead' ? today : view}.csv`,
    [[t('fv.colScope'), t('fv.colDay'), t('fv.colHour'), t('fv.colIst'), t('fv.colPlan'), t('fv.colLive'), t('fv.chronos'), t('fv.colUsualLo'), t('fv.colUsualHi'), t('fv.colUnit')], ...rows.map(r => [scopeTxt, r.day, r.h, r.a == null ? null : [r.a, 1], r.p == null ? null : [r.p, 1], r.l == null ? null : [r.l, 1], r.c == null ? null : [r.c, 0], r.u ? [r.u[0], 1] : null, r.u ? [r.u[1], 1] : null, norm ? t('fv.normOn') : t('fv.normOff')])]));
  el.querySelector('[data-fv-csv="days"]')?.addEventListener('click', () => download(`prognose_tage_${fileTag(ctx, sel)}.csv`,
    [[t('fv.colScope'), t('fv.colDay'), t('fv.colIst'), t('fv.colPlan'), t('fv.colBias'), t('fv.colErr'), t('fv.colNaive'), t('fv.colSkill'), t('fv.colTrain')], ...accRowsNow.map(r => [scopeTxt, r.d, [r.ist, 0], [r.plan, 0], r.bias == null ? null : [r.bias, 4], r.wape == null ? null : [r.wape, 4], r.naive == null ? null : [r.naive, 4], r.skill == null ? null : [r.skill, 4], r.train])]));
}

// Wetter unter dem Stundendiagramm (gleiche x-Achse wie timeline: W, pl 40, pr 8): Temperatur und Niederschlag der Gemeinde bzw. Mittel aller Zellen
async function fillWx(box, ctx, rows, sel, width) {
  if (!box || !rows.length) return;
  const scope = sel.ags && sel.ags !== 'DE' ? sel.ags : null;
  const vals = await weatherFor(rows.map(r => [r.day, r.h]), scope, ctx.getJson, ctx.CFG.DATA);
  if (!box.isConnected) return;
  const svg = weatherSvg(vals, { W: Math.max(320, Math.min(1100, Math.round(width))), pl: 40, pr: 8, hours: rows.map(r => r.h), esc: ctx.esc });
  box.innerHTML = svg ? `${svg}<div class="fv-sub">${t('wx.legend', { scope: ctx.esc(scope ? (ctx.muniName?.(scope) || scope) : t('wx.scopeDE')) })}</div>` : `<div class="fv-sub">${t('wx.none')}</div>`;
}

async function renderSpotsPart(el, ctx, s, S0, L) {
  const sel = pickScope(S0, ctx.state);
  el.innerHTML = topBar(ctx, sel, csvBtn('spots', t('fv.csvSpots'), true)) + `<div class="fv-grid">${spotsPanelShell(ctx)}<p class="fv-sub">${t('fv.moreBasis')} <a href="#prognose-basis">${t('fv.segBasis')}</a>. ${t('fv.spotsElsewhere')} <a href="#spots">${t('app.spots')}</a> · <a href="#ops">${t('app.operations')}</a>.</p></div>`;
  bindTop(el, ctx);
  el.querySelector('[data-fv-csv="spots"]')?.addEventListener('click', () => {
    const R = s.rated; if (!R?.items?.length) return;
    const ags = s.ratedAgs || '', name = ctx.muniName?.(ags) || ags;
    download(`prognose_spots_${ags}_${(s.op || '').replace(/[^\w.-]+/g, '-')}.csv`, [[t('fv.colRank'), t('fv.colSpot'), t('fv.colKind'), t('fv.colClass'), t('fv.colImp'), t('fv.colExp'), t('fv.colTarget'), t('fv.colHave'), t('fv.colMissing'), t('fv.colLat'), t('fv.colLon'), t('fv.fOp'), t('fv.fArea')],
      ...R.items.map(x => [x.rank, x.label || '', x.kind === 'both' ? t('fv.kBoth') : x.kind === 'deploy' ? t('fv.kDeploy') : t('fv.kPark'), x.cls, [x.importance, 3], x.expected24 == null ? null : [x.expected24, 1], x.cls === 'D' ? null : [x.targetFc, 0], [x.have, 0], [x.missing, 0], [x.lat, 5], [x.lon, 5], s.op, name])]);
  });
  await paintSpots(el, ctx, s, S0, L, sel);
}

// ---------- Grundlagen & Kontrolle ----------
const n1v = (x) => (x == null || !Number.isFinite(x) ? '–' : numFmt(1).format(x));
const kv = (rows) => `<dl class="fv-kv">${rows.map(([k, v, sub]) => `<div><dt>${k}</dt><dd>${v}${sub ? `<small>${sub}</small>` : ''}</dd></div>`).join('')}</dl>`;
const tag = (k) => `<span class="fv-tag ${k}">${t(`fv.tag.${k}`)}</span>`;
export const timeTxt = (iso) => (iso ? dateFmt({ dateStyle: 'short', timeStyle: 'short', timeZone: TZ }).format(new Date(iso)) : '–');

/** Selbstkontrollen: jede mit Ampel (ok / near / none) und einem Satz Begründung aus den Daten */
function checksOf(ctx, S0, L, G, race) {
  const { esc } = ctx, gates = { ...FC.GATES, ...(L.gates || {}) }, wg = L.weather?.gate || {}, out = [], add = (lvl, title, why) => out.push({ lvl, title, why });
  const age = S0.generatedAt ? (Date.now() - Date.parse(S0.generatedAt)) / 3600e3 : null;
  add(age == null ? 'none' : age <= 3 ? 'ok' : 'near', t('fv.cFresh'), age == null ? t('fv.cFreshNone') : t('fv.cFreshWhy', { time: timeTxt(S0.generatedAt), h: n1v(Math.max(0, age)) }));
  const nT = L.trainDays || 0, nE = L.evalDays || 0;
  add(nT >= gates.minTrainDays ? 'ok' : 'none', t('fv.cTrain'), t('fv.cTrainWhy', { n: nT, min: gates.minTrainDays }));
  add(nE >= gates.minEvalDays ? 'ok' : 'near', t('fv.cEval'), t('fv.cEvalWhy', { n: nE, min: gates.minEvalDays }));
  const act = race.find(r => r.m === L.active) || race.find(r => r.m === 'pooled'), nv = race.find(r => r.m === 'naive');
  if (act && nv) add(act.sc.v <= nv.sc.v ? 'ok' : 'near', t('fv.cNaive'), act.sc.v <= nv.sc.v ? t('fv.cNaiveOk', { model: modelName(act.m), a: pc(act.sc.v), n: pc(nv.sc.v) }) : t('fv.cNaiveBad', { model: modelName(act.m), a: pc(act.sc.v), n: pc(nv.sc.v) }));
  else add('none', t('fv.cNaive'), t('fv.cNaiveNone'));
  const models = race.filter(r => r.m !== 'naive'), best = models.slice().sort((a, b) => a.sc.v - b.sc.v)[0];
  if (best && act && best.m !== act.m && best.sc.v < act.sc.v - 0.005) add('near', t('fv.cBest'), t('fv.cBestBad', { best: modelName(best.m), b: pc(best.sc.v), act: modelName(act.m), a: pc(act.sc.v), min: gates.minEvalDays }));
  else if (best) add('ok', t('fv.cBest'), t('fv.cBestOk', { model: modelName(act?.m || best.m) }));
  add(L.weather?.used ? 'ok' : 'near', t('fv.cWx'), L.weather?.used ? t('fv.cWxOn') : t('fv.cWxOff', { range: n1v(wg.tempRangeK), need: gates.wxTempRangeK, rain: wg.rainDays ?? 0, dry: wg.dryDays ?? 0, n: gates.wxRainDays, miss: pc(wg.missingShare) }));
  const ex = L.excluded || 0;
  add(ex ? 'near' : 'ok', t('fv.cExcl'), ex ? t('fv.cExclWhy', { n: ex }) : t('fv.cExclNone'));
  const pl = S0.plans?.[S0.today], hasP = Object.values(S0.days?.[S0.today] || {}).some(e => e.p);
  add(pl ? 'ok' : hasP ? 'near' : 'none', t('fv.cPlan'), pl ? t('fv.cPlanWhy', { model: t(`fc.model.${pl.model}`), n: pl.trainDays, time: timeTxt(pl.at) }) : hasP ? t('fv.cPlanOld') : t('fv.cPlanNone'));
  const nl = (L.live || []).length;
  add(nl ? 'ok' : 'near', t('fv.cLive'), nl ? t('fv.cLiveWhy', { n: nl }) : t('fv.cLiveNone'));
  return `<ul class="fv-checks">${out.map(c => `<li>${badge(c.lvl, c.lvl === 'ok' ? '✓' : c.lvl === 'near' ? '!' : '–', esc(c.title))}<span class="why">${esc(c.why)}</span></li>`).join('')}</ul>`;
}

function renderBasisPart(el, ctx, s, S0, L, G) {
  const { esc } = ctx, sel = pickScope(S0, ctx.state), gates = { ...FC.GATES, ...(L.gates || {}) }, race = raceOf(G, L), ck = ctx.state.latest?.eventChecks || null;
  const checks = checksOf(ctx, S0, L, G, race), nGroups = Object.keys(L.groups || {}).length, nMuni = Object.keys(L.municipalities || {}).length, cal = ctx.state.calendar || null;
  const wg = L.weather?.gate || {}, evKeys = Object.keys(G?.evals || {}).sort();
  const files = ['latest', 'log', 'series'].map(f => `<a class="chip" href="${esc(`${ctx.CFG.DATA}${famFile(FAM, f)}`)}" target="_blank" rel="noopener">${esc(famFile(FAM, f))}</a>`).join('')
    + (L?.env?.sources?.days ? `<a class="chip" href="${esc(`${ctx.CFG.DATA}incidents/${FC.dayOfLocal(Date.now())}.json`)}" target="_blank" rel="noopener">incidents/${esc(FC.dayOfLocal(Date.now()))}.json</a>` : '')
    + (ctx.CFG?.REPO ? `<a class="chip" href="${esc(`https://github.com/${ctx.CFG.REPO}/blob/main/data/ereignisse.json`)}" target="_blank" rel="noopener">data/ereignisse.json</a>` : '');
  // Panel 1: Kontrollen
  const p1 = `<div class="panel">${head(t('fv.checksTitle'), t('fv.checksSub'))}${checks}</div>`;
  // Panel 2: Eingangsdaten und Herkunft der Pläne
  const prov = accRows(S0, sel, G, { withToday: true }).reverse();
  const provRows = prov.map(r => { const pl = S0.plans?.[r.d], odd = r.bias != null && Math.abs(r.bias) > 0.25;
    return `<tr><td>${esc(dayTxt(r.d))}${r.d === S0.today ? ` <span class="fv-chip B">${t('fv.today')}</span>` : ''}</td><td class="wrap">${pl ? `${esc(t(`fc.model.${pl.model}`))} · ${t('fv.provDays', { n: pl.trainDays })} · ${pl.retro ? t('fv.provRetro') : t('fv.provFrozen', { time: esc(timeTxt(pl.at)) })}` : '–'}</td><td class="n">${n0(r.ist)}</td><td class="n">${n0(r.plan)}</td><td class="n">${odd ? `<span class="fv-flag" title="${esc(t('fv.oddTip'))}">${sg(r.bias, 1)} ⚑</span>` : sg(r.bias, 1)}</td></tr>`; }).join('');
  const provTbl = prov.length ? `<h3 class="rp-h3" style="margin:var(--s4) 0 var(--s2);font-size:14px">${t('fv.provTitle')}</h3><div class="tbl fv-tbl full" tabindex="0" role="region" aria-label="${esc(t('fv.provTitle'))}"><table><thead><tr><th>${t('fv.colDay')}</th><th>${t('fv.colPlanFrom')}</th><th class="n">${t('fv.colIst')}</th><th class="n">${t('fv.colPlan')}</th><th class="n">${t('fv.colBias')}</th></tr></thead><tbody>${provRows}</tbody></table></div><div class="fv-sub">${t('fv.provNote')} ${esc(t('fv.nScopeOf', { s: scopeLabel(ctx, sel) }))}</div>` : '';
  const p2 = `<div class="panel">${head(t('fv.inTitle'), t('fv.inSub'))}${kv([
    [t('fv.kvTrain'), n0(L.trainDays), t('fv.kvTrainSub')],
    [t('fv.kvEval'), n0(L.evalDays), evKeys.length ? evKeys.slice(-4).map(d => dayTxt(d, { day: 'numeric', month: 'numeric' })).join(', ') : t('fv.kvEvalNone')],
    [t('fv.kvGroups'), n0(nGroups), t('fv.kvGroupsSub', { m: n0(nMuni) })],
    [t('fv.kvExcl'), n0(L.excluded || 0), ck?.ruleNow ? t('fv.kvExclSub', { rule: esc(ck.ruleNow) }) : t('fv.kvExclSub0')],
    [t('fv.kvPhi'), n1v(L.phi), t('fv.kvPhiSub')],
    (() => { const d = evKeys.filter(x => G?.evals?.[x]?.expoErr != null).at(-1); const alt = d ? G.evals[d].expoErrAlt : null; return [t('fv.kvExpo'), d ? pc(G.evals[d].expoErr) : '–', d ? t('fv.kvExpoSub', { d: esc(dayTxt(d)) }) + (alt?.mean != null ? ` ${t('fv.kvExpoAlt', { c: pc(alt.class), m: pc(alt.mean) })}` : '') : t('fv.kvExpoNone')]; })(),
    // Audit MET-03: faire Selbstprüfung als Schatten (nur Stunden mit Vortagswert), ab 28.11. Grundlage der Modellwahl
    (() => { const act = L.active || 'pooled', ds = evKeys.filter(d => G.evals[d]?.models?.[act]?.fair && G.evals[d]?.models?.naive?.fair).slice(-7);
      if (!ds.length) return [t('fv.kvFair'), '–', t('fv.kvFairNone')];
      const m = (k) => ds.reduce((x, d) => x + (G.evals[d].models[k].fair.wapeGH || 0), 0) / ds.length, a = m(act), b = m('naive');
      const raw = ds.reduce((x, d) => x + (G.evals[d].models[act].wapeGH || 0), 0) / ds.length, rb = ds.reduce((x, d) => x + (G.evals[d].models.naive.wapeGH || 0), 0) / ds.length;
      return [t('fv.kvFair'), b > 0 ? `${numFmt(2).format(a / b)} ×` : '–', t('fv.kvFairSub', { model: esc(modelName(act)), a: pc(a), b: pc(b), n: ds.length, raw: rb > 0 ? numFmt(2).format(raw / rb) : '–' })]; })(),
    [t('fv.kvWx'), esc(L.weather?.source || '–'), L.weather?.used ? t('fv.kvWxOn') : t('fv.kvWxOff', { range: n1v(wg.tempRangeK), rain: wg.rainDays ?? 0, dry: wg.dryDays ?? 0, miss: pc(wg.missingShare) })],
    [t('fv.kvCal'), cal?.source ? esc(cal.source) : t('fv.kvCalNone'), cal?.from ? `${esc(cal.from)} – ${esc(cal.to)}` : t('fv.kvCalFallback')],
    [t('fv.kvHorizon'), t('fv.kvHorizonV', { h: L.horizon?.hours ?? 24 }), L.horizon?.from ? t('fv.kvHorizonSub', { time: timeTxt(new Date(L.horizon.from).toISOString()), d: esc(L.horizon.tomorrow || '') }) : ''],
    [t('fv.kvStand'), timeTxt(L.generatedAt), t('fv.kvStandSub', { time: timeTxt(S0.generatedAt) })],
  ])}${provTbl}</div>`;
  // Panel 3: Modell
  const modelRows = [['profile', t('fv.mProfile')], ['pooled', t('fv.mPooled')], ['pooledWx', t('fv.mPooledWx')], ['adaptive', t('fv.mAdaptive', { hl: FC.FEEDBACK.halfLifeDays })], ['hybrid', t('fv.mHybrid', { k: FC.HYBRID.k, back: FC.HYBRID.maxBack })], ['blend', blendTxt(L)], ['chronos', t('fv.mChronos', { min: L?.external?.chronos?.minStarts ?? 20 })], ['naive', t('fv.mNaive')]];
  const p3 = `<div class="panel">${head(t('fv.modelTitle'), t('fv.modelSub'))}<code class="fv-formula">${esc(t('fv.formula'))}</code>`
    + `<div class="tbl fv-tbl full" tabindex="0" role="region" aria-label="${esc(t('fv.modelTitle'))}"><table style="margin-top:var(--s3)"><thead><tr><th>${t('fv.colModel')}</th><th>${t('fv.colWhat')}</th></tr></thead><tbody>${modelRows.map(([m, d]) => `<tr><td>${m === 'naive' ? t('fv.naive') : t(`fc.model.${m}`)}${m === L.active ? ` <span class="fv-chip B">${t('fv.activeTag')}</span>` : ''}</td><td class="wrap">${esc(d)}</td></tr>`).join('')}</tbody></table></div>`
    + `<p class="fv-sub">${esc(t('fv.chooseRule', { min: gates.minEvalDays, win: gates.evalWindow, gain: pc(gates.wxGain), again: pc(gates.adGain ?? FC.GATES.adGain), mt: gates.minEvalTrainDays ?? FC.GATES.minEvalTrainDays }))}</p>${L.reason ? `<p class="fv-sub">${t('fv.reasonNow')} <i>${esc(fcReason(L))}</i></p>` : ''}</div>`;
  // Panel 4: gemessen · abgeleitet · modelliert · vermutet
  const A = [
    ['derived', t('fv.aStarts'), t('fv.aStartsHow')], ['measured', t('fv.aExposure'), t('fv.aExposureHow')], ['external', t('fv.aDayType'), t('fv.aDayTypeHow')],
    ['external', t('fv.aWeather'), t('fv.aWeatherHow')], ['derived', t('fv.aEra'), t('fv.aEraHow')], ['modelled', t('fv.aPlan'), t('fv.aPlanHow')], ['modelled', t('fv.aWeight'), t('fv.aWeightHow', { hl: FC.FEEDBACK.halfLifeDays })], ['external', t('fv.aEnv'), t('fv.aEnvHow')], ['modelled', t('fv.aMem'), t('fv.aMemHow', { hl: FC.MEMORY.halfLifeDays })], ['modelled', t('fv.aBand'), t('fv.aBandHow')],
    ['assumed', t('fv.aDeploy'), t('fv.aDeployHow')], ['derived', t('fv.aPark'), t('fv.aParkHow')], ['modelled', t('fv.aDemand'), t('fv.aDemandHow')], ['assumed', t('fv.aShare'), t('fv.aShareHow')],
    ['rule', t('fv.aTarget'), t('fv.aTargetHow', { base: OPS.baseH, min: OPS.minPerSpot, max: OPS.maxPerSpot, h: OPS.horizonH })], ['measured', t('fv.aHave'), t('fv.aHaveHow', { r: OPS.spotRadiusM })],
    ['derived', t('fv.aMissing'), t('fv.aMissingHow')], ['rule', t('fv.aClasses'), t('fv.aClassesHow', { a: pc(SP.RATE.classA), b: pc(SP.RATE.classB) })],
  ];
  const last = LAST_RATED;
  const lastRow = last?.R?.items?.length ? `<p class="fv-sub">${t('fv.lastSpots', { n: n0(last.R.total.spots), d: n0(last.R.total.deploy), p: n0(last.R.total.park), b: n0(last.R.total.both), op: esc(last.op), m: esc(ctx.muniName?.(last.ags) || last.ags) })}</p>` : '';
  const p4 = `<div class="panel">${head(t('fv.assumeTitle'), t('fv.assumeSub'))}<div class="fv-legend" style="margin-top:var(--s2)">${['measured', 'derived', 'modelled', 'assumed', 'rule', 'external'].map(k => `<span>${tag(k)}</span>`).join('')}</div>`
    + `<div class="tbl fv-tbl full" tabindex="0" role="region" aria-label="${esc(t('fv.assumeTitle'))}"><table><thead><tr><th>${t('fv.colWhat')}</th><th>${t('fv.colKind')}</th><th>${t('fv.colHow')}</th></tr></thead><tbody>${A.map(([k, n, h]) => `<tr><td class="wrap"><b>${esc(n)}</b></td><td>${tag(k)}</td><td class="wrap">${esc(h)}</td></tr>`).join('')}</tbody></table></div>${lastRow}</div>`;
  // Panel 5: Parameter (aus dem Code, nicht frei einstellbar)
  const P = paramRows(L);

  const p5 = `<div class="panel">${head(t('fv.paramTitle'), t('fv.paramSub'))}<div class="tbl fv-tbl full" tabindex="0" role="region" aria-label="${esc(t('fv.paramTitle'))}"><table><thead><tr><th>${t('fv.colParam')}</th><th class="n">${t('fv.colValue')}</th><th>${t('fv.colEffect')}</th></tr></thead><tbody>${P.map(([k, v, d]) => `<tr><td><code>${esc(k)}</code></td><td class="n">${esc(String(v))}</td><td class="wrap">${esc(d)}</td></tr>`).join('')}</tbody></table></div></div>`;
  // Panel 6: nicht berücksichtigt
  const NO = NOT_KEYS;
  const chipOf = (st) => `<span class="fv-chip ${st === 'done' ? 'A' : st === 'part' ? 'B' : 'D'}">${t(`fv.nState.${st}`)}</span>`;
  const p6 = `<div class="panel" id="fv-not">${head(t('fv.notTitle'), t('fv.notSub'))}<ul class="fv-list fv-not">${NO.map(k => `<li>${chipOf(NOT_STATE[k])} <b>${esc(t(`fv.${k}`))}</b><div class="fv-sub" style="margin:2px 0 0">${t(`fv.${k}How`)}</div></li>`).join('')}</ul>`
    + `<div class="fv-ops-body"></div><p class="fv-sub">${t('fv.notNote')}</p></div>`;
  // Panel 7: Rohdaten
  const p7 = `<div class="panel">${head(t('fv.rawTitle'), t('fv.rawSub'))}<div class="fv-links">${files}</div><p class="fv-sub">${t('fv.rawNote')}</p></div>`;
  const p9 = `<div class="panel" id="fv-env">${head(t('fv.envTitle'), t('fv.envSub'))}${envHtml(ctx, L, { title: false })}</div>`;
  const p10 = `<div class="panel" id="fv-events">${head(t('fv.evTitle'), t('fv.evSub'))}<div class="fv-ev-body"><p class="fv-sub">${t('fv.evLoading')}</p></div></div>`;
  const p8 = `<div class="panel" id="fv-dl">${head(t('fv.dlTitle'), t('fv.dlSub'))}${dlRow(false)}<p class="fv-sub">${t('fv.dlNote', { repo: esc(ctx.CFG?.REPO || '') })}</p></div>`;
  const p11 = `<div class="panel" id="fv-pm">${head(t('fv.pmTitle'), t('fv.pmSub'))}<div class="fv-pm-body"><p class="fv-sub">${t('fv.pmLoading')}</p></div></div>`;
  el.innerHTML = topBar(ctx, sel) + `<div class="fv-grid">${p1}${p2}${p3}${p9}${p10}${p11}${p8}${p4}${p5}${p6}${p7}</div>`;
  bindTop(el, ctx); bindDl(el, ctx, S0, L, G, sel);
  fillEvents(el.querySelector('#fv-events .fv-ev-body'), ctx, sel, S0);
  fillPortable(el.querySelector('#fv-pm .fv-pm-body'), ctx, sel);
  fillOps(el.querySelector('#fv-not .fv-ops-body'), ctx, sel);
}
// Erfasste Eingriffe der Anbieter und Ausfälle (eingriffe.json, Sammler: lib/pulse-train.js opsSignals) für die Auswahl, letzte 14 Tage
async function fillOps(box, ctx, sel) {
  if (!box) return;
  const doc = await fj(ctx, 'eingriffe.json'); if (!box.isConnected) return;
  const esc = ctx.esc, op = ctx.state.operator && ctx.state.operator !== 'all' ? ctx.state.operator : null, ty = ctx.state.type && ctx.state.type !== 'all' ? ctx.state.type : null, ags = sel.ags && sel.ags !== 'DE' ? sel.ags : null;
  if (!Array.isArray(doc?.entries)) { box.innerHTML = `<p class="fv-sub">${t('fv.opsNone')}</p>`; return; }
  const cut = addDays(FC.dayOfLocal(Date.now()), -14), tl = tMap('type', VEHICLE_TYPE_LABEL);
  const fit = (e) => { if (e.day < cut) return false; if (e.key) { const [a, o, y] = e.key.split('|'); return (!ags || a === ags) && (!op || o === op) && (!ty || y === ty); } return (!ags || (e.munis || []).includes(ags)) && (!op || e.op === op); };
  const list = doc.entries.filter(fit), counts = ['price', 'zone', 'fleet', 'outage'].map(k => [k, list.filter(e => e.kind === k).length]);
  const where = (e) => { if (e.key) { const [a, o, y] = e.key.split('|'); return `${esc(o)} · ${esc(tl[y] || y)} · ${esc(ctx.muniName?.(a) || a)}`; } const m = e.munis || []; return `${esc(e.op)} · ${m.length === 1 ? esc(ctx.muniName?.(m[0]) || m[0]) : t('fv.opsMunis', { n: m.length })}`; };
  const what = (e) => e.kind === 'price' ? t('fv.opsPrice', { n: e.n }) : e.kind === 'zone' ? t('fv.opsZone', { a: e.added, r: e.removed }) : e.kind === 'fleet' ? t('fv.opsFleet', { from: n0(e.from), to: n0(e.to), d: sg(e.ratio - 1, 0) }) : t('fv.opsOutage', { h: e.hours, fleet: n0(e.fleet) });
  box.innerHTML = `<h3 class="rp-h3" style="margin:var(--s4) 0 var(--s2);font-size:14px">${t('fv.opsTitle')}</h3><p class="fv-sub">${t('fv.opsLead', { list: counts.map(([k, n]) => `${t(`fv.opsKind.${k}`)} ${n}`).join(' · ') })}</p>`
    + (list.length ? `<div class="tbl fv-tbl full" tabindex="0" role="region" aria-label="${esc(t('fv.opsTitle'))}"><table><thead><tr><th>${t('fv.colDay')}</th><th>${t('fv.opsColKind')}</th><th>${t('fv.opsColWho')}</th><th>${t('fv.opsColWhat')}</th></tr></thead><tbody>`
      + list.slice(0, 40).map(e => `<tr><td>${esc(dayTxt(e.day))}</td><td>${t(`fv.opsKind.${e.kind}`)}</td><td class="wrap">${where(e)}</td><td class="wrap">${what(e)}</td></tr>`).join('') + `</tbody></table></div>${list.length > 40 ? `<p class="fv-sub">${t('fv.opsMore', { n: list.length - 40 })}</p>` : ''}` : `<p class="fv-sub">${t('fv.opsEmpty')}</p>`);
}

// ---------- Vortrainiertes Modell zum Mitnehmen (forecast/model.json, tools/prognose-modell.mjs) ----------
const PM_CLS = ['W', 'F', 'S', 'H'];
/** Rate je verfügbarem Fahrzeug und Stunde (neutrales Wetter, ohne Ereignisse) */
export const pmRate = (M, ty, T, level, h) => Math.exp(level + M.hour[h] + M.dayType[T][h] + (M.types[ty]?.hour?.[h] ?? 0));
async function fillPortable(box, ctx, sel) {
  if (!box) return;
  const M = await fj(ctx, famFile(FAM, 'model')); if (!box.isConnected) return;
  const esc = ctx.esc, repo = ctx.CFG?.REPO || 'fcou1005/mobility-pulse';
  if (M?.kind !== 'mobility-pulse/portable-model') { box.innerHTML = `<p class="fv-sub">${t('fv.pmNone')}</p>`; return; }
  const types = Object.entries(M.types).filter(([, x]) => x.vehicleHours >= 10000).map(([k]) => k), tl = tMap('type', VEHICLE_TYPE_LABEL);
  const opSel = ctx.state.operator && ctx.state.operator !== 'all' ? ctx.state.operator : null, tySel = ctx.state.type && types.includes(ctx.state.type) ? ctx.state.type : types[0];
  const days = Array.from({ length: 7 }, (_, k) => addDays(FC.dayOfLocal(Date.now()), k + 1)), city = sel.ags && sel.ags !== 'DE' ? sel.ags : null;
  const land = city ? FC.LAND_OF_AGS[city.slice(0, 2)] ?? null : null;
  const st = { ty: tySel, fleet: 100, day: days[0], q: 'p50' };
  box.innerHTML = `<p class="fv-lead" style="margin-top:var(--s2)">${t('fv.pmLead', { at: esc(timeTxt(M.trainedAt)), n: M.trainDays ?? '–', types: types.map(x => esc(tl[x] || x)).join(', '), ops: Object.keys(M.operators || {}).length, cities: Object.keys(M.city || {}).length })}</p>`
    + `<div class="fv-links" style="margin:var(--s2) 0 var(--s3)"><button type="button" class="chip" data-pm="json">${t('fv.pmJson')}</button><button type="button" class="chip" data-pm="csv">${t('fv.pmCsv')}</button>`
    + `<a class="chip" href="https://raw.githubusercontent.com/${esc(repo)}/main/tools/prognose-modell.mjs" target="_blank" rel="noopener">${t('fv.pmScript')}</a><a class="chip" href="https://github.com/${esc(repo)}/blob/main/tools/MODELL.md" target="_blank" rel="noopener">${t('fv.pmGuide')}</a></div>`
    + `<h3 class="rp-h3" style="margin:var(--s3) 0 var(--s2);font-size:14px">${t('fv.pmCalc')}</h3><div class="fv-ctl">`
    + `<label>${t('fv.pmType')} <select data-pmi="ty">${types.map(x => `<option value="${esc(x)}"${x === tySel ? ' selected' : ''}>${esc(tl[x] || x)}</option>`).join('')}</select></label>`
    + `<label>${t('fv.pmFleet')} <input data-pmi="fleet" type="number" min="1" max="100000" step="1" value="${st.fleet}" style="width:7em"></label>`
    + `<label>${t('fv.pmDay')} <select data-pmi="day">${days.map((d, i) => `<option value="${d}">${esc(i === 0 ? `${t('fv.tomorrow')} · ${dayTxt(d)}` : dayTxt(d))}</option>`).join('')}</select></label>`
    + `<label>${t('fv.pmLevel')} <select data-pmi="q">${opSel ? `<option value="op">${esc(t('fv.pmLevelOp', { op: opSel }))}</option>` : ''}<option value="p25">${t('fv.pmP25')}</option><option value="p50" selected>${t('fv.pmP50')}</option><option value="p75">${t('fv.pmP75')}</option></select></label></div>`
    + `<div class="fv-pm-out"></div><p class="fv-sub">${t('fv.pmNote', { phi: n1v(M.phi) })}</p>`;
  if (opSel) { const o = box.querySelector('[data-pmi="q"]'); o.value = 'op'; st.q = 'op'; }
  const paint = () => {
    const out = box.querySelector('.fv-pm-out'), T = PM_CLS.includes(dayType(st.day, land, ctx.state.calendar || null)) ? dayType(st.day, land, ctx.state.calendar || null) : 'W';
    const opKey = st.q === 'op' && opSel ? `${opSel}|${st.ty}` : null, hasOp = opKey && M.operators?.[opKey] != null;
    const level = hasOp ? M.operators[opKey] : (M.types[st.ty]?.level?.[st.q === 'op' ? 'p50' : st.q] ?? 0) + (city ? M.city?.[city] ?? 0 : 0);
    const rows = Array.from({ length: 24 }, (_, h) => ({ day: st.day, h, p: null, a: null, l: st.fleet * pmRate(M, st.ty, T, level, h), c: null }));
    const tot = sum(rows.map(r => r.l)), pk = rows.reduce((b, r) => (r.l > b.l ? r : b), rows[0]);
    out.innerHTML = `<div class="tiles">${tile(t('fv.pmTotal'), n0(tot), t('fv.pmTotalSub', { per: n1v(tot / Math.max(1, st.fleet)), T: t(`fv.dt.${T}`) }))}${tile(t('fv.kPeakD', { d: dayTxt(st.day) }), t('fv.kPeakV', { h: String(pk.h).padStart(2, '0'), h2: String((pk.h + 1) % 24).padStart(2, '0') }), t('fv.kPeakSubF', { v: n0(pk.l), u: '' }))}`
      + `${tile(t('fv.pmLevelTile'), hasOp ? esc(opSel) : st.q === 'op' ? t('fv.pmP50') : t(`fv.pm${st.q.toUpperCase()}`), `${hasOp ? t('fv.pmLevelOpSub') : t('fv.pmLevelTypSub')}${city && !hasOp && M.city?.[city] != null ? ` · ${t('fv.pmCity', { c: esc(ctx.muniName?.(city) || city), f: sg(Math.exp(M.city[city]) - 1, 0) })}` : ''}${st.q === 'op' && !hasOp ? ` · ${t('fv.pmOpMissing', { op: esc(opSel) })}` : ''}`)}</div>`
      + timeline(ctx, rows, { width: box.clientWidth - 20, blocks: [{ from: 0, to: 24, label: dayTxt(st.day) }] });
  };
  box.querySelectorAll('[data-pmi]').forEach(inp => inp.addEventListener(inp.tagName === 'INPUT' ? 'input' : 'change', () => { const k = inp.dataset.pmi; st[k] = k === 'fleet' ? Math.max(1, Math.min(100000, +inp.value || 1)) : inp.value; paint(); }));
  box.querySelector('[data-pm="json"]').addEventListener('click', () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(M, null, 1)], { type: 'application/json' })); a.download = `mobility-pulse-modell_${FAM}_${(M.trainedAt || '').slice(0, 10)}.json`; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000); });
  box.querySelector('[data-pm="csv"]').addEventListener('click', () => download(`mobility-pulse-raten_${FAM}_${(M.trainedAt || '').slice(0, 10)}.csv`,
    [[t('fv.pmColType'), t('fv.pmColDayType'), t('fv.colHour'), t('fv.pmColP25'), t('fv.pmColP50'), t('fv.pmColP75')],
      ...types.flatMap(ty => PM_CLS.flatMap(T => Array.from({ length: 24 }, (_, h) => [tl[ty] || ty, t(`fv.dt.${T}`), h, ...['p25', 'p50', 'p75'].map(q => [pmRate(M, ty, T, M.types[ty].level[q], h), 4])])))]));
  paint();
}
// ---------- Veranstaltungen: eine Liste aus sport.json (Heimspiele, OpenLigaDB), veranstaltungen.json (Termine an Orten ab 5.000 Plätzen) und
// ereignisse.json (gepflegte Liste data/ereignisse.json, vom Sammler geprüft) – Zeitfenster wie in der Prognose (lib/pulse-context.js eventList) ----------
const loadEvents = (ctx) => memo(`events|${ctx.state?.latest?.at || ''}`, async () => {
  const [sp, vd, cu] = await Promise.all([fj(ctx, 'sport.json'), fj(ctx, 'veranstaltungen.json'), fj(ctx, 'ereignisse.json')]);
  return { list: CX.eventList({ sport: sp, venues: vd, curated: cu?.ereignisse || [], now: Date.now(), pastDays: 8, aheadDays: 430 }), sp, vd, cu };
});
const LIGA = { bl1: '1. Bundesliga', bl2: '2. Bundesliga', bl3: '3. Liga', del: 'DEL', dfb: 'DFB-Pokal', ucl: 'Champions League' };
const evWhen = (e, until = null) => {
  const d = (x, o) => dateFmt({ ...o, timeZone: TZ }).format(new Date(x)), day = { weekday: 'short', day: '2-digit', month: '2-digit' };
  if (until) return `${d(e.beginn, day)}–${d(CX.localMs(until), { day: '2-digit', month: '2-digit' })}`;
  return e.noTime ? `${d(e.beginn, day)} · ${t(e.noTime === 1 ? 'fv.evAllDay' : 'fv.evNoTime')}` : d(e.beginn, { ...day, hour: '2-digit', minute: '2-digit' });
};
const evKind = (e) => (e.src === 'sport' ? `${t('fv.evSport')} · ${LIGA[e.liga] || e.liga || ''}` : e.src === 'liste' ? `${e.kind ? t(`fv.evKind.${e.kind}`) : t('fv.evListe')}${e.auto ? ` · ${t('fv.evAuto')}` : ''}` : e.kind || t('fv.evVenue'));
const evWhat = (ctx, e) => (e.quelle && /^https?:/.test(e.quelle) && e.src !== 'sport' ? `<a href="${ctx.esc(e.quelle)}" target="_blank" rel="noopener">${ctx.esc(e.titel)}</a>` : ctx.esc(e.titel));
/** gleiche Veranstaltung an Folgetagen (Turnier, Messe) als eine Zeile */
function evRuns(list) {
  const out = [];
  for (const e of list) {
    const last = out[out.length - 1], k = `${e.src}|${e.titel}|${e.ort}|${e.ags[0] || ''}`;
    if (last && last.k === k && (e.noTime ? last.e.noTime : !last.e.noTime && e.von.slice(11) === last.e.von.slice(11)) && Date.parse(`${e.von.slice(0, 10)}T12:00:00Z`) - Date.parse(`${(last.until || last.e.von).slice(0, 10)}T12:00:00Z`) <= 86400e3) { last.until = e.von.slice(0, 10); last.days.push(e); continue; }
    out.push({ k, e, until: null, days: [e] });
  }
  return out;
}
/** Wirkung (Ist gegen Plan im Zeitfenster, bereinigt um den übrigen Tag) als Zelle */
function effCell(f) {
  if (!f) return '<span class="muted">–</span>';
  const cls = f.uplift >= 0.05 ? 'up' : f.uplift <= -0.05 ? 'down' : '', pct = (x) => (Math.round(Math.abs(x) * 100) === 0 ? '±0 %' : `${x >= 0 ? '+' : '−'}${n0(Math.abs(x) * 100)} %`);
  return `<span class="fv-eff ${cls}" title="${t('fv.evEffTip', { ist: n0(f.ist), plan: n0(f.plan), h: f.hours, rel: pct(f.rel), rest: f.rest == null ? '–' : pct(f.rest) })}">${pct(f.uplift)}</span>`;
}
const evEffect = (S0, e) => (e.ags.length === 1 ? CX.eventEffect(S0?.days, `ags:${e.ags[0]}`, e) : null);
const activeFromTxt = (cu, sp) => { const a = Date.parse(cu?.veranstaltungenAb || sp?.activeFrom || ''); return Number.isFinite(a) ? dateFmt({ day: 'numeric', month: 'numeric', year: 'numeric', timeZone: TZ }).format(new Date(a)) : '–'; };

function eventsMainShell(ctx, sel) {
  const where = sel.ags && sel.ags !== 'DE' ? (ctx.muniName?.(sel.ags) || sel.ags) : t('fc.scopeDE');
  return `<div class="panel" id="fv-ev-main">${head(t('fv.evMainTitle', { where: ctx.esc(where) }), t('fv.evMainSub'))}<div class="fv-ev-body"><p class="fv-sub">${t('fv.evLoading')}</p></div></div>`;
}
// Kurzfassung in der Prognose: was in den nächsten 14 Tagen ansteht (je Gebiet), was zuletzt war und wie stark es die Fahrten bewegt hat
async function fillEventsMain(box, ctx, sel, S0) {
  if (!box) return;
  const ev = await loadEvents(ctx); if (!box.isConnected) return;
  const { esc } = ctx, now = Date.now(), scope = sel.ags && sel.ags !== 'DE' ? sel.ags : null, list = (ev?.list || []).filter(e => CX.eventInScope(e, scope));
  const muni = (a) => ctx.muniName?.(a) || a || '–', known = (e) => !!e.ags[0] && muni(e.ags[0]) !== e.ags[0], withWhere = !scope;
  const endMs = (e) => e.endMs ?? CX.localMs(e.bis), big = (e) => e.src === 'liste' || (e.cap || 0) >= 10000 || ['bl1', 'ucl', 'dfb'].includes(e.liga);
  // ohne Gebiet: nur Gemeinden mit Sharing-Daten (Spielorte wie Sinsheim fallen sonst als Kennziffer auf)
  const upAll = list.filter(e => endMs(e) >= now && e.beginn <= now + 14 * 864e5 && (scope || known(e))), up = scope ? upAll : upAll.filter(e => big(e) && e.beginn <= now + 7 * 864e5);
  const past = list.filter(e => endMs(e) < now && e.beginn >= now - 7 * 864e5 && (scope || known(e))).reverse();
  // Zusammenfassung
  const runs = evRuns(upAll), nS = upAll.filter(e => e.src === 'sport').length, nO = runs.filter(r => r.e.src === 'ort').length, nL = runs.filter(r => r.e.src === 'liste').length;
  const top = runs.filter(r => r.e.cap).sort((a, b) => b.e.cap - a.e.cap)[0];
  const parts = [nS ? t(nS === 1 ? 'fv.evSumS1' : 'fv.evSumS', { n: n0(nS) }) : '', nO ? t('fv.evSumO', { n: n0(nO) }) : '', nL ? t('fv.evSumL', { n: n0(nL) }) : ''].filter(Boolean).join(', ');
  let html = `<p class="fv-ev-sum">${t(runs.length === 1 ? 'fv.evSum1' : 'fv.evSum', { n: `<b>${n0(runs.length)}</b>`, parts: parts ? ` (${parts})` : '' })}${top ? ` ${t('fv.evSumTop', { what: esc(top.e.titel), cap: n0(top.e.cap), when: esc(evWhen(top.e, top.until)) })}` : ''}</p>`;
  if (!scope) {
    const by = new Map(); for (const r of runs) { const a = r.e.ags[0]; if (a) by.set(a, (by.get(a) || 0) + 1); }
    const cities = [...by].sort((a, b) => b[1] - a[1]).slice(0, 14);
    if (cities.length) html += `<div class="fv-ev-cities" role="list" aria-label="${esc(t('fv.evCities'))}">${cities.map(([a, n]) => `<a role="listitem" class="chip" href="?scope=${esc(a)}#prognose">${esc(muni(a))} <b>${n0(n)}</b></a>`).join('')}</div>`;
  }
  // gemessene Wirkung über alle Städte (letzte 8 Tage), Median je Art – zeigt, was die Prognose ab der Freischaltung lernen kann
  { const grp = (e) => (e.src === 'sport' ? (e.liga === 'del' ? 'icehockey' : 'football') : e.src === 'ort' ? 'venue' : e.kind === 'volksfest' ? 'fair' : e.kind === 'messe' ? 'tradefair' : 'other');
    const by = new Map();
    for (const e of ev?.list || []) { if (e.ags.length !== 1 || !(endMs(e) < now) || e.beginn < now - 8 * 864e5) continue; const f = evEffect(S0, e); if (!f) continue; const g = grp(e); let a = by.get(g); if (!a) by.set(g, a = []); a.push(f.uplift); }
    const med = (a) => { const b = [...a].sort((x, y) => x - y), n = b.length; return (b[(n - 1) >> 1] + b[n >> 1]) / 2; }, pct = (x) => (Math.round(Math.abs(x) * 100) === 0 ? '±0 %' : `${x >= 0 ? '+' : '−'}${n0(Math.abs(x) * 100)} %`);
    const parts = ['football', 'icehockey', 'venue', 'tradefair', 'fair', 'other'].filter(g => (by.get(g) || []).length >= 3).map(g => t('fv.evEffPart', { what: t(`fv.evGrp.${g}`), eff: pct(med(by.get(g))), n: n0(by.get(g).length) }));
    if (parts.length) html += `<p class="fv-sub">${t('fv.evEffAll', { list: parts.join(' · ') })}</p>`; }
  const upRuns = evRuns(up);
  const upRow = (r) => `<tr><td>${esc(evWhen(r.e, r.until))}</td>${withWhere ? `<td>${esc(muni(r.e.ags[0]))}</td>` : ''}<td class="wrap">${evWhat(ctx, r.e)}</td><td class="mh">${esc(r.e.ort || (r.e.src === 'liste' ? (r.e.kind ? evKind(r.e) : '–') : evKind(r.e)))}</td><td class="n mh">${r.e.cap ? n0(r.e.cap) : '–'}</td></tr>`;
  const upHead = `<thead><tr><th>${t('fv.evColWhen')}</th>${withWhere ? `<th>${t('fv.evColWhere')}</th>` : ''}<th>${t('fv.evColWhat')}</th><th class="mh">${t('fv.evColVenue')}</th><th class="n mh">${t('fv.evColCap')}</th></tr></thead>`;
  html += `<div class="fv-ev-h">${t(scope ? 'fv.evNext' : 'fv.evNextBig')}</div>`;
  html += upRuns.length ? `<div class="tbl fv-tbl full" data-csv="0" tabindex="0" role="region" aria-label="${esc(t('fv.evNext'))}"><table>${upHead}<tbody>${upRuns.slice(0, 8).map(upRow).join('')}</tbody></table></div>${upRuns.length > 8 ? `<details class="fv-data"><summary>${t('fv.evMore', { n: upRuns.length - 8 })}</summary><div class="tbl fv-tbl full" data-csv="0"><table>${upHead}<tbody>${upRuns.slice(8).map(upRow).join('')}</tbody></table></div></details>` : ''}` : `<p class="fv-sub">${t('fv.evNoneNext')}</p>`;
  // zuletzt: gemessene Wirkung
  const pastRows = past.slice(0, scope ? 10 : 12).map(e => ({ e, f: evEffect(S0, e) }));
  html += `<div class="fv-ev-h">${t('fv.evPast')}</div>`;
  html += pastRows.length ? `<div class="tbl fv-tbl full" data-csv="0" tabindex="0" role="region" aria-label="${esc(t('fv.evPast'))}"><table><thead><tr><th>${t('fv.evColWhat')}</th><th class="n" title="${esc(t('fv.evColEffTip'))}">${t('fv.evColEff')}</th></tr></thead><tbody>${pastRows.map(({ e, f }) => `<tr><td class="wrap"><span class="lv">${evWhat(ctx, e)}</span><span class="lvs">${esc([evWhen(e), withWhere ? muni(e.ags[0]) : '', e.ort || evKind(e)].filter(Boolean).join(' · '))}</span></td><td class="n">${effCell(f)}</td></tr>`).join('')}</tbody></table></div>` : `<p class="fv-sub">${t('fv.evNonePast')}</p>`;
  const later = list.filter(e => e.beginn > now + 14 * 864e5 && (scope || known(e)));
  if (later.length) html += `<p class="fv-sub">${t('fv.evLater', { n: n0(evRuns(later).length), d: esc(dateFmt({ day: '2-digit', month: '2-digit', year: 'numeric', timeZone: TZ }).format(new Date(later[later.length - 1].beginn))) })}</p>`;
  html += `<p class="fv-sub">${t('fv.evMainNote', { d: esc(activeFromTxt(ev?.cu, ev?.sp)) })} <a href="#prognose-basis">${t('fv.evAllLink')}</a></p>`;
  box.innerHTML = html;
}
// Veranstaltungen im Stundenverlauf: Band über den Stunden des Zeitfensters (wie es die Prognose sieht), Name oben, im Tooltip der Stunde
async function markEvents(el, ctx, rows, sel) {
  const svg = el.querySelector('.fv-chart svg[data-pl]'); if (!svg || !sel.ags || sel.ags === 'DE') return;
  const ev = await loadEvents(ctx); if (!svg.isConnected || !ev?.list?.length) return;
  const pl = +svg.dataset.pl, bw = +svg.dataset.bw, pt = +svg.dataset.pt, ph = +svg.dataset.ph, W = +svg.viewBox.baseVal.width;
  const st = rows.map(r => `${r.day}T${String(r.h).padStart(2, '0')}`), marks = [];
  for (const e of ev.list) {
    if (!CX.eventInScope(e, sel.ags) || e.all || e.laender.length) continue;
    const from = e.von.slice(0, 13); let i0 = -1, i1 = -1;
    st.forEach((s, i) => { if (s >= from && `${s}:00` < e.bis) { if (i0 < 0) i0 = i; i1 = i; } });
    if (i0 >= 0) marks.push({ e, i0, i1 });
  }
  if (!marks.length) return;
  marks.sort((a, b) => a.i0 - b.i0 || a.i1 - b.i1);
  let bands = '', labels = ''; const lanes = [];
  for (const m of marks) {
    const x0 = pl + m.i0 * bw, x1 = pl + (m.i1 + 1) * bw;
    bands += `<rect class="ev-band" x="${x0.toFixed(1)}" y="${pt}" width="${(x1 - x0).toFixed(1)}" height="${ph}"/><rect class="ev-bar" x="${x0.toFixed(1)}" y="${pt - 3}" width="${(x1 - x0).toFixed(1)}" height="3"/>`;
    const txt = m.e.titel.length > 26 ? `${m.e.titel.slice(0, 25)}…` : m.e.titel, w = txt.length * 6 + 6;
    let lane = lanes.findIndex(end => end <= x0); if (lane < 0 && lanes.length < 3) { lane = lanes.length; lanes.push(0); } if (lane < 0) continue;
    const x = Math.max(pl, Math.min(x0 + 3, W - w)); lanes[lane] = x + w;
    labels += `<text class="ev-t" x="${x.toFixed(1)}" y="${(pt + 12 + lane * 13).toFixed(1)}">${ctx.esc(txt)}</text>`;
  }
  svg.insertAdjacentHTML('afterbegin', bands);
  const firstHit = svg.querySelector('rect.hit'); if (firstHit) firstHit.insertAdjacentHTML('beforebegin', labels); else svg.insertAdjacentHTML('beforeend', labels);
  const hits = svg.querySelectorAll('rect.hit');
  for (const m of marks) for (let i = m.i0; i <= m.i1; i++) { const tt = hits[i]?.querySelector('title'); if (tt) tt.textContent += `\n◆ ${m.e.titel}${m.e.ort ? ` (${m.e.ort})` : ''}`; }
  el.querySelector('.fv-legend')?.insertAdjacentHTML('beforeend', `<span><i class="k-ev"></i>${t('fv.evMark')}</span>`);
}
// Grundlagen: vollständige Liste im gewählten Gebiet, 7 Tage zurück bis 14 Tage voraus, mit Quelle und gemessener Wirkung
let EV_RANGE = 14; // Grundlagen: Tage voraus (14, 90 oder 400 = alles)
async function fillEvents(box, ctx, sel, S0 = null) {
  if (!box) return;
  const ev = await loadEvents(ctx); if (!box.isConnected) return;
  const { esc } = ctx, now = Date.now(), scope = sel.ags && sel.ags !== 'DE' ? sel.ags : null, vd = ev?.vd, sp = ev?.sp;
  const list = (ev?.list || []).filter(e => e.beginn >= now - 7 * 864e5 && e.beginn <= now + EV_RANGE * 864e5 && CX.eventInScope(e, scope));
  const tog = `<div class="fv-ctl"><div class="fv-tog" role="group" aria-label="${esc(t('fv.evRange'))}">${[[14, t('fv.evR14')], [90, t('fv.evR90')], [400, t('fv.evRAll')]].map(([v, l]) => `<button type="button" data-evr="${v}" aria-pressed="${v === EV_RANGE}">${l}</button>`).join('')}</div></div>`;
  const nSrc = (vd?.quellen || []).length, okSrc = (vd?.quellen || []).filter(q => q.n > 0).length, nAuto = (ev?.cu?.ereignisse || []).filter(e => e.auto).length, nCur = (ev?.cu?.ereignisse || []).length - nAuto;
  const notes = [t('fv.evNote', { from: activeFromTxt(ev?.cu, sp) }), nSrc ? t('fv.evSrc', { ok: okSrc, n: nSrc }) : '', t('fv.evCur', { n: n0(nCur) }), nAuto ? t('fv.evAutoN', { n: n0(nAuto) }) : ''].filter(Boolean).join(' ');
  const shown = list.slice(0, EV_RANGE > 14 ? 400 : 80);
  box.innerHTML = tog + (shown.length ? `<div class="tbl fv-tbl full" tabindex="0" role="region" aria-label="${esc(t('fv.evTitle'))}"><table><thead><tr><th>${t('fv.evColWhen')}</th><th>${t('fv.evColWhere')}</th><th>${t('fv.evColWhat')}</th><th class="mh">${t('fv.evColVenue')}</th><th class="n">${t('fv.evColCap')}</th><th class="mh">${t('fv.evColKind')}</th><th class="n" title="${esc(t('fv.evColEffTip'))}">${t('fv.evColEff')}</th></tr></thead><tbody>`
    + shown.map(e => `<tr${e.beginn < now ? ' class="muted"' : ''}><td>${esc(evWhen(e))}</td><td>${esc(e.all ? t('fc.scopeDE') : e.laender.length ? e.laender.join(', ') : (ctx.muniName?.(e.ags[0]) || e.ags[0] || '–'))}</td><td class="wrap">${evWhat(ctx, e)}</td><td class="mh">${esc(e.ort || '–')}</td><td class="n">${e.cap ? n0(e.cap) : '–'}</td><td class="mh">${esc(evKind(e))}</td><td class="n">${e.beginn < now ? effCell(evEffect(S0, e)) : ''}</td></tr>`).join('')
    + `</tbody></table></div>` : `<p class="fv-sub">${t('fv.evNone')}</p>`) + `<p class="fv-sub">${list.length > shown.length ? `${t('fv.evMore', { n: list.length - shown.length })} ` : ''}${notes}</p>`;
  box.querySelectorAll('[data-evr]').forEach(b => b.addEventListener('click', () => { EV_RANGE = +b.dataset.evr; fillEvents(box, ctx, sel, S0); }));
}

export function scopeLabel(ctx, sel) {
  const parts = [sel.ags && sel.ags !== 'DE' ? (ctx.muniName?.(sel.ags) || sel.ags) : t('fc.scopeDE'), sel.op && sel.op !== 'all' && !sel.ignored ? sel.op : null, sel.ty && sel.ty !== 'all' && !sel.ignored ? sel.ty : null].filter(Boolean);
  return parts.join(' · ');
}
/** Ist des heutigen Tags frisch aus events/<Tag>.json (Sammler-Lauf alle paar Minuten); null = Datei fehlt, dann gelten die Reihen aus series.json */
async function freshActual(ctx, S0, sel, today) {
  try {
    if (!ctx.loadEvents || !sel.keys.length) return null;
    const doc = await ctx.loadEvents(today); if (!doc?.groups) return null;
    const bad = new Set(Object.entries(ctx.state.latest?.eventChecks?.groups || {}).filter(([, g]) => g?.level === 'bad').map(([k]) => k));
    const groups = Object.fromEntries(Object.entries(doc.groups).filter(([k]) => !bad.has(k)));
    const D = FC.dayFromDoc({ ...doc, groups }, ctx.state.calendar || null), A = FC.actualOfDay(D), out = new Array(24).fill(null);
    for (const k of sel.keys) { const a = A.get(k); if (!a) continue; a.forEach((v, h) => { if (v != null) out[h] = (out[h] || 0) + v; }); }
    return out.some(x => x != null) ? { a: out, obs: D.obsEnd ?? D.hourMin } : null;
  } catch { return null; }
}
