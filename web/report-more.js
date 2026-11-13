// Mobility Pulse — Bericht (Ansicht) – Verfügbar ÷ erlaubt, Gebühren, Einsatzbereitschaft, Prognose-Abschnitte (aus report.js geschnitten; report.js bleibt die Fassade für alle Importe).
import * as R from './pulse-report.js';
import { t, tx, lang, fmtLocale, fcReason } from './i18n.js';
import { weatherFor, weatherSvg, WX_CSS } from './weather.js';
import { mbChecksText, mbLevel, mbNum, mbPct, mbRules } from './ui-shared.js';
import { FCL, archiveDayList, archiveFor, badge, bindOnce, cellsDoc, dailyDoc, dd, download, emptyBox, eventsDoc, fetchJson, fleetLabel, head, hideTip, histFor, histIndex, lastOf, loadCalibration, pctTxt, plural, reference, safeLink, srcTxt, st, stamp, tile, tripTxt, typeName, usageIndex } from './report-core.js';
import { TYPE_ORDER } from './report-watch.js';
import { bindCity, bindFilters, bindSort, cityCell, filterCtl, groupOptions, initFilters, miniBar, moreBtn, pctFine, prep2, showRowsTip, sortHead } from './report-avail.js';

// ---------- Verfügbar ÷ erlaubt je Anbieter gegen die Obergrenzen ----------
// Überschreitung (über 100 %) mit Symbol und Text, nahe (ab 90 %) mit Symbol und Text – nie nur über die Farbe. Gerechnete Grenze
// (nicht in der Quelle): statt „Überschreitung/nahe“ nur ein Hinweis-Zeichen, kein Verstoß.
export const overMark = (v, derived = false) => (v != null && v > 1 ? (derived ? ` <span class="rp-status hint rp-over">${t('rep.iAboveCalculatedFigure')}</span>` : ` <span class="rp-status over rp-over">${t('rep.exceedance')}</span>`) : '');
const nearMark = (v, derived = false) => (v != null && v <= 1 && v >= R.NEAR_CAP && !derived ? ` <span class="rp-status near rp-over">${t('rep.near2')}</span>` : '');
// knapp an 100 % mit einer Nachkommastelle („100,1 %“ statt „100 %“ neben „Überschreitung“, „> 99,9 %“ knapp darunter)
export const rateTxt = (ctx, v) => (v >= 0.995 && v < 1.005 ? pctFine(ctx, v, 1) : pctTxt(ctx, v, 0));
export const rateCell = (ctx, v, bar = false, derived = false) => (v == null ? '<span class="muted">—</span>' : `<b>${rateTxt(ctx, v)}</b>${bar ? miniBar(Math.min(1, v)) : ''}${overMark(v, derived)}${bar ? nearMark(v, derived) : ''}`);
export const standTxt = (x) => (/^\d{4}-\d{2}-\d{2}$/.test(x || '') ? dd(x) : /^\d{4}-\d{2}$/.test(x || '') ? `${x.slice(5)}/${x.slice(0, 4)}` : x || '');
export const DERIVED_TXT_DEF = () => (t('rep.calculatedNotInSource'));
const numsTxt = (ctx, a) => (a?.length ? a.map(v => ctx.fmt(v)).join('–') : null);
// Zahlen eines Eintrags ohne Kennzahl in einem Satz: „gesamt 9.000–10.000 · je Anbieter 800 · Teilgebiete: Innenstadt 19.000 (je Anbieter 4.750, gerechnet)“
export function capInfoTxt(ctx, x) {
  const parts = [];
  const g = numsTxt(ctx, x.info?.gesamt), j = numsTxt(ctx, x.info?.jeAnbieter);
  if (g) parts.push(t('rep.total4', { g })); if (j) parts.push(t('rep.perOperator2', { j }));
  const lim = (d) => `${srcTxt(ctx.esc, d.label)} ${[d.limit != null ? ctx.fmt(d.limit) : null, d.perOperator != null ? t('rep.perOperator', { perOperator: ctx.fmt(d.perOperator), v1: d.perOperatorDerived ? ` (${DERIVED_TXT_DEF()})` : '' }) : null].filter(Boolean).join(', ')}`;
  const ds = (x.districts || []).filter(d => d.limit != null || d.perOperator != null);
  // mit vermuteter Abgrenzung gezählt (Zonen-Beobachtung): Zahl der Quelle und heutiger Bestand im Teilgebiet, ohne Prüfung
  const zc = ds.filter(d => d.check).map(d => `${lim(d)} (${t('zv.nowInArea', { n: ctx.fmt(d.check.total) })})`), z = ds.filter(d => !d.check).map(lim);
  if (zc.length) parts.push(t('zv.subAreasCounted', { v1: zc.join('; ') }));
  if (z.length) parts.push(t('rep.onlyNotCheckableWithoutArea', { v0: z.length > 1 ? t('rep.subAreas') : t('rep.subArea'), v1: z.join('; ') }));
  return parts.join(' · ');
}
// Verfügbar ÷ erlaubt je Anbieter steht im Kommunal-Bericht (Obergrenzen-Wächter, Steckbrief): hier nur ein Satz mit Link und die CSV (UI-10)
export function capLink(ctx, s) {
  if (s.ref === undefined) return `<p class="note small rp-caplink">${t('rep.loadingFleetCaps')}</p>`;
  if (!s.ref?.obergrenzen?.length) return `<p class="note small rp-caplink">${t('rep.noFleetCapsStoredReference')}</p>`;
  const ca = R.capAvailability(s.ref, ctx.state.latest, { hist: s.hist, operator: s.op, type: s.type, asOf: ctx.state.latest.at || Date.now() }); s.capRows = ca.rows;
  return `<div class="note small rp-caplink"><span>${t('rep.capLinkNote', { v0: plural(ca.cities, t('rep.officialCap'), t('rep.officialCaps')) })}</span> <a href="#bericht" data-rp-jump="rp-caps">${t('rep.capLinkGo')}</a>${ca.rows.length ? `<button type="button" class="rp-noprint" data-rp="capcsv" title="${t('rep.allRowsInFilter')}">${t('rep.capCsv')}</button>` : ''}</div>`;
}
export function capCsv(el) {
  const s = st(el); if (!s.capRows) return; const ctx = s.ctx;
  download(t('rep.availablePerAllowedCsv', { op: s.op, type: s.type, v2: new Date(ctx.state.latest?.at || Date.now()).toISOString().slice(0, 16).replace(/[:T]/g, '-') }), R.toCsv(R.capAvailabilityCsvRows(s.capRows, { operator: s.op, type: s.type, at: ctx.state.latest?.at, typeLabel: typeName, day: s.hist?.day || s.day , lang: lang() }), lang()));
}
export function availCsv(el) {
  const s = st(el); if (!s.rows) return; const ctx = s.ctx;
  download(`${t('file.availability')}_${s.op}_${s.type}_${new Date(ctx.state.latest?.at || Date.now()).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`, R.toCsv(R.availabilityCsvRows(s.rows, { operator: s.op, type: s.type, at: ctx.state.latest?.at, typeLabel: typeName, day: s.day , lang: lang() }), lang()));
}

// ======================================================================
// 8. Städte-Rangliste (je Stadt × Fahrzeugart) und 9. Dichte gegen Nutzung
// ======================================================================
const RANK_CACHE = new Map();
async function rankingInputs(ctx) {
  const idx = await usageIndex(ctx); const days = (idx.days || []).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)); const [hidx, daily] = await Promise.all([histIndex(ctx), dailyDoc(ctx)]);
  const [docs, hs] = await Promise.all([Promise.all(days.map(d => eventsDoc(ctx, idx, d))), Promise.all(days.map(d => histFor(ctx, hidx, daily, d)))]);
  const ok = docs.map((d, i) => [d, days[i], hs[i]]).filter(([d]) => d);
  const limits = (await loadCalibration(ctx)).limits || null;
  return { docs: ok.map(x => x[0]), hists: Object.fromEntries(ok.filter(x => x[2]).map(x => [x[1], x[2]])), limits, breaks: daily?.breaks || null }; // breaks: Bruchmarken (daily.json)
}
function rankingFor(ctx, inp, type, operator = 'all') {
  const rvdLimit = inp.limits || null; // Überzählung (über der Kalibrier-Grenze) zählt wie bisher nur bei der Flotte
  const k = `${ctx.state.latest?.at}|${inp.docs.map(d => d.day).join(',')}|${type}|${operator}|${JSON.stringify(rvdLimit)}`;
  const o = { type, operator, minFleet: 0, rvdLimit, eventChecks: ctx.state.latest?.eventChecks, breaks: inp.breaks || null };
  if (!RANK_CACHE.has(k)) { const cur = R.cityRanking(inp.docs, inp.hists, ctx.state.latest, o); const per = R.rankingPeriods(inp.docs); let prev = null;
    if (!per.reason) { const a = R.cityRanking(per.cur, inp.hists, ctx.state.latest, o), b = R.cityRanking(per.prev, inp.hists, ctx.state.latest, o); prev = { n: per.n, cur: new Map(a.rows.map(r => [r.key, r])), prev: new Map(b.rows.map(r => [r.key, r])), from: per.prev[0].day, to: lastOf(per.prev).day, curFrom: per.cur[0].day, curTo: lastOf(per.cur).day }; }
    RANK_CACHE.set(k, { ...cur, prev, reason: per.reason || null }); }
  return RANK_CACHE.get(k);
}
const RK_COLS_DEF = () => ([['name', t('rep.cityState'), false, 'asc'], ['ty', t('rep.type'), false, 'asc'], ['fleet', t('rep.avgFleet'), true, 'desc'], ['ridesDay', t('rep.tripsDay2'), true, 'desc'], ['rvd', t('rep.perVehAndDay'), true, 'desc', t('rep.tripsPerVehiclePerDay2')], ['per1000Fleet', t('rep.vehPer1000Residents'), true, 'desc'], ['per1000Rides', t('rep.tripsPer1000ResidentsDay'), true, 'desc'], ['opCount', t('rep.operator2'), true, 'desc']]);
/**
 * Rangliste der Städte: Fahrten je Fahrzeug und Tag je Stadt × Fahrzeugart, Flotte, Fahrten/Tag, je 1.000 Einwohner; Vorperiode ab 2 × 3 vollen Messtagen.
 * Daten: events/<Tag>.json, history/<Tag>.json, latest.json municipalities (pop). Optional ctx.setScope(ags).
 */
export async function renderCityRanking(el, ctx) {
  if (!el) return;
  const s = prep2(el, ctx); const { state } = ctx;
  if (!s.sort) s.sort = { key: 'rvd', dir: 'desc' };
  if (state.latest) initFilters(s, ctx, { type: groupOptions(state.latest).types.includes(state.type) ? state.type : 'scooter' });
  const draw = () => drawRanking(el);
  bindOnce(el, 'rank', () => { bindFilters(el, s, draw); bindSort(el, s, [...RK_COLS_DEF(), ['delta', '', true, 'desc']], draw); bindCity(el, ctx); el.addEventListener('click', (e) => { if (e.target.closest('button[data-rp="rkcsv"]')) rankingCsv(el); }); });
  const title = head(t('rep.cityRanking'), t('rep.tripsPerVehiclePerDayByCity'));
  if (!state.latest) { el.innerHTML = title + emptyBox(t('rep.noDataSnapshotYet'), ''); return; }
  const tok = ++s.tok; el.classList.add('rp-busy'); if (!s.inp) el.innerHTML = title + `<div class="muted small">${t('rep.loadingDailyFiles')}</div>`;
  try {
    const [inp, archDays] = await Promise.all([rankingInputs(ctx), archiveDayList(ctx).catch(() => [])]); if (tok !== s.tok) return; s.inp = inp;
    // Vorquartal aus dem Langzeit-Archiv, sobald zwei aufeinanderfolgende Quartale vollständig vorliegen
    const rq = R.rankingQuarters(archDays);
    if (rq && s.rq?.cur !== rq.cur) { const { archive, fields } = await archiveFor(ctx, [...rq.prevDays, ...rq.curDays]); if (tok !== s.tok) return; s.rq = { ...rq, archive, fields }; }
    else if (!rq) s.rq = null;
    draw();
  }
  catch (e) { console.error('Rangliste', e); if (tok === s.tok) el.innerHTML = title + emptyBox(t('rep.rankingCannotBeCreated'), t('rep.dailyFilesNotLoadable')); }
  finally { if (tok === s.tok) el.classList.remove('rp-busy'); }
}
function drawRanking(el) {
  const s = st(el); const ctx = s.ctx; const { esc, fmt, state } = ctx; if (!s.inp) return;
  const title = (right = '') => head(t('rep.cityRanking'), t('rep.tripsPerVehiclePerDayByCity2', { v0: plural(s.inp.docs.length, t('rep.day'), t('rep.days')), v1: s.inp.limits?.scooter ? ctx.fmt(s.inp.limits.scooter, 2) : '15' }), right);
  if (!s.inp.docs.length) { el.innerHTML = title() + emptyBox(t('rep.noDailyFilesYet'), t('rep.tripsAriseFromSecond')); return; }
  const rk = rankingFor(ctx, s.inp, s.type, s.op);
  const scope = state.scope && state.scope !== 'DE' ? state.scope : null;
  let rows = rk.rows.filter(r => r.fleet >= s.min || r.ags === scope);
  if (rk.prev) for (const r of rows) { const a = rk.prev.cur.get(r.key), b = rk.prev.prev.get(r.key); r.delta = a?.rvd != null && b?.rvd != null ? a.rvd - b.rvd : null; }
  // Quartalsvergleich (Archiv) vor dem Wochenvergleich
  let qcmp = null;
  if (s.rq) {
    const A = (ds) => new Map(R.cityRankingArchive(s.rq.archive, state.latest, { fields: s.rq.fields, type: s.type, operator: s.op, days: ds, rvdLimit: s.inp.limits, breaks: s.inp.breaks || null, eventChecks: state.latest?.eventChecks }).rows.map(r => [r.key, r]));
    const ck = `${s.rq.cur}|${s.type}|${s.op}`; if (s.qcmpKey !== ck) { s.qcmp = { cur: A(s.rq.curDays), prev: A(s.rq.prevDays) }; s.qcmpKey = ck; } qcmp = s.qcmp;
    for (const r of rows) { const a = qcmp.cur.get(r.key), b = qcmp.prev.get(r.key); r.delta = a?.rvd != null && b?.rvd != null ? a.rvd - b.rvd : null; }
  }
  // Audit UXM-07: Namen auch für Gemeinden, die im aktuellen Stand fehlen (Grenzen-Datei); Zeilen ohne Messung ans Ende
  for (const r of rows) if (!r.name || r.name === r.ags) r.name = ctx.muniName?.(r.ags) || r.ags;
  rows = R.sortRows(rows, s.sort.key, s.sort.dir); rows = [...rows.filter(r => r.ridesDay > 0), ...rows.filter(r => !(r.ridesDay > 0))]; s.rows = rows; s.rk = rk;
  const qLab = (q) => R.periodRange(`q:${q}`).label;
  const cols = qcmp ? [...RK_COLS_DEF(), ['delta', t('rep.toPreviousQuarter'), true, 'desc', t('rep.perVehAndDayAgainstArchive', { v0: qLab(s.rq.cur), v1: qLab(s.rq.prev) })]] : rk.prev ? [...RK_COLS_DEF(), ['delta', t('rep.toPreviousPeriod'), true, 'desc', t('rep.perVehAndDayAgainst', { v0: dd(rk.prev.curFrom), v1: dd(rk.prev.curTo), v2: dd(rk.prev.from), v3: dd(rk.prev.to) })]] : RK_COLS_DEF();
  const show = rows.slice(0, s.limit);
  const body = show.map((r, i) => `<tr${r.ags === scope ? ' class="rp-sel" aria-current="true"' : ''}><td>${cityCell(ctx, r.ags, r.name, r.state)}${r.excluded.length ? `<div class="sub-line">${t('rep.tripsWithoutImplausible', { join: esc(r.excluded.join(', ')) })}</div>` : ''}</td><td>${esc(typeName(r.ty))}</td>
    <td class="n">${r.fleetGood != null && Math.abs(r.fleetGood - r.fleet) >= 0.5 ? `${fmt(r.fleetGood)}<div class="sub-line">${t('rep.fleetAll', { v: fmt(r.fleet) })}</div>` : fmt(r.fleet)}</td><td class="n">${r.ridesDay > 0 ? fmt(r.ridesDay) : `<span class="muted">${r.ridesDay == null ? '—' : t('rep.noMeasure')}</span>`}</td><td class="n"><b>${r.rvd == null || !(r.ridesDay > 0) ? '—' : fmt(r.rvd, 2)}</b></td><td class="n">${r.per1000Fleet == null ? '—' : fmt(r.per1000Fleet, 1)}</td><td class="n">${r.per1000Rides == null ? '—' : fmt(r.per1000Rides, 1)}</td><td class="n">${r.opCount}</td>
    ${qcmp || rk.prev ? `<td class="n">${r.delta == null ? '—' : `${r.delta > 0 ? '+' : ''}${fmt(r.delta, 2)}`}</td>` : ''}</tr>`).join('');
  const note = `<div class="note small" style="margin-bottom:var(--s3)">${t('rep.typeOfRankingAsInFluctuo', { v0: rk.prelim ? `${t('rep.preliminaryOnlyFull', { fullDays: rk.fullDays, profileSource: esc(tx(rk.profileSource)) })} ` : '', v1: qcmp ? t('rep.previousPeriodAgainstFrom', { qLab: esc(qLab(s.rq.cur)), qLab2: esc(qLab(s.rq.prev)) }) : rk.reason ? t('rep.columnHiddenQuarter', { reason: esc(tx(rk.reason)) }) : t('rep.previousPeriodDaysEach', { n: rk.prev.n }) })}</div>`;
  el.innerHTML = title(`<div class="rp-ctl rp-noprint"><button type="button" data-rp="rkcsv">↓ CSV</button></div>`) + filterCtl(ctx, s, { minLabel: t('rep.minimumFleet2') }) + note
    + `<div class="tbl"><table>${sortHead(cols, s.sort)}<tbody>${body || `<tr><td colspan="${cols.length}" class="empty">${t('rep.noCityInFilterLowerMinimum2')}</td></tr>`}</tbody></table></div>${moreBtn(show.length, rows.length)}`;
}
function rankingCsv(el) {
  const s = st(el); if (!s.rows) return;
  const vp = s.rq ? t('rep.against', { cur: s.rq.cur, prev: s.rq.prev }) : s.rk.prev ? t('rep.against2', { curFrom: s.rk.prev.curFrom, curTo: s.rk.prev.curTo, from: s.rk.prev.from, to: s.rk.prev.to }) : '';
  const rows = [[t('rep.rank'), 'AGS', t('rep.city'), t('rep.state'), t('rep.vehicleType'), R.csvText('Flotte_Mittel', lang()), t('rep.tripsperday'), t('rep.tripspervehicleday'), t('rep.vehiclesper1000residents'), t('rep.tripsper1000residentsday'), t('rep.operator2'), t('rep.csvDeltaPrev'), t('rep.days'), t('rep.csvPrelim'), t('rep.note'), t('rep.previousPeriod')],
    ...s.rows.map((r, i) => [i + 1, r.ags, r.name, r.state || '', typeName(r.ty), [r.fleet, 1], [r.ridesDay, 1], [r.rvd, 2], [r.per1000Fleet, 2], [r.per1000Rides, 2], r.opCount, [r.delta, 2], s.rk.days.length, s.rk.prelim ? t('rep.yes') : t('rep.no'), r.excluded.length ? t('rep.without', { v0: r.excluded.join(', ') }) : '', vp])];
  download(`${t('file.cityRanking')}_${s.type}_${lastOf(s.rk.days)}.csv`, R.toCsv(rows, lang()));
}
/**
 * Streudiagramm Fahrten je Fahrzeug und Tag gegen Fahrzeuge je km² je Gemeinde (Ansatz Universität St. Gallen).
 * Fläche aus latest.json municipalities[].areaKm2; fehlt sie, Leerzustand. Punktgröße fest, Tooltip, Tabellenansicht.
 */
export async function renderDensityScatter(el, ctx) {
  if (!el) return;
  const s = prep2(el, ctx); const { state } = ctx;
  if (state.latest) initFilters(s, ctx, { type: 'scooter' });
  const draw = () => drawScatter(el);
  bindOnce(el, 'scatter', () => {
    bindFilters(el, s, draw); bindCity(el, ctx);
    el.addEventListener('click', (e) => { if (e.target.closest('button[data-rp="sctable"]')) { s.showTable = !s.showTable; draw(); } });
    const near = (svg, ev) => { const c = s.sc; if (!c) return null; const r = svg.getBoundingClientRect(); const k = c.W / r.width; const px = (ev.clientX - r.left) * k, py = (ev.clientY - r.top) * k; let best = null, bd = 24 * k; c.pts.forEach((p, i) => { const d = Math.hypot(p.px - px, p.py - py); if (d < bd) { bd = d; best = i; } }); return best; };
    const show = (svg, i) => { const c = s.sc; const box = svg.closest('.rp-chart'); svg.querySelectorAll('circle.on').forEach(x => x.classList.remove('on')); if (i == null) { hideTip(box); return; } const p = c.pts[i]; svg.querySelector(`circle[data-i="${i}"]`)?.classList.add('on'); const r = svg.getBoundingClientRect(); const k = r.width / c.W;
      showRowsTip(box, svg, r.left + p.px * k, r.top + p.py * k - 6, `${p.name}${p.state ? ` (${p.state})` : ''} · ${typeName(p.ty)}`, [{ color: 'transparent', value: s.ctx.fmt(p.rvd, 2), label: t('rep.tripsPerVehiclePerDay2') }, { color: 'transparent', value: s.ctx.fmt(p.density, 1), label: t('rep.vehiclesPerKm2') }, { color: 'transparent', value: s.ctx.fmt(p.fleet), label: t('rep.avgFleetKm2', { v0: s.ctx.fmt(p.areaKm2, 1) }) }]); c.i = i; };
    el.addEventListener('pointermove', (e) => { const svg = e.target.closest?.('svg.rp-scatter'); if (svg) show(svg, near(svg, e)); });
    el.addEventListener('pointerout', (e) => { const svg = e.target.closest?.('svg.rp-scatter'); if (svg && !svg.contains(e.relatedTarget)) show(svg, null); });
    el.addEventListener('keydown', (e) => { const svg = e.target.closest?.('svg.rp-scatter'); if (!svg || !s.sc) return; const d = { ArrowRight: 1, ArrowLeft: -1, ArrowUp: 1, ArrowDown: -1 }[e.key]; if (!d) return; e.preventDefault(); const n = s.sc.pts.length; show(svg, (((s.sc.i ?? -1) + d) % n + n) % n); });
    el.addEventListener('focusout', (e) => { if (e.target.matches?.('svg.rp-scatter')) show(e.target, null); });
  });
  const title = head(t('rep.densityVersusUsage'), t('rep.tripsPerVehiclePerDayAgainst'));
  if (!state.latest) { el.innerHTML = title + emptyBox(t('rep.noDataSnapshotYet'), ''); return; }
  const tok = ++s.tok; el.classList.add('rp-busy');
  try { const inp = await rankingInputs(ctx); if (tok !== s.tok) return; s.inp = inp; draw(); }
  catch (e) { console.error('Dichte', e); if (tok === s.tok) el.innerHTML = title + emptyBox(t('rep.chartCannotBeCreated'), t('rep.dailyFilesNotLoadable')); }
  finally { if (tok === s.tok) el.classList.remove('rp-busy'); }
}
function drawScatter(el) {
  const s = st(el); const ctx = s.ctx; const { esc, fmt, state } = ctx; if (!s.inp) return;
  const title = (right = '') => head(t('rep.densityVersusUsage'), t('rep.tripsPerVehiclePerDayAgainst2', { v0: plural(s.inp.docs.length, t('rep.day'), t('rep.days')) }), right);
  const hasArea = Object.values(state.latest.municipalities || {}).some(m => +m.areaKm2 > 0);
  if (!hasArea) { s.sc = null; el.innerHTML = title() + emptyBox(t('rep.areaPerMunicipalityIsMissing'), t('rep.chartAppearsAsSoonAsLatest')); return; }
  const rk = rankingFor(ctx, s.inp, s.type, s.op);
  const scope = state.scope && state.scope !== 'DE' ? state.scope : null;
  const pts = R.densityPoints(rk.rows.filter(r => r.fleet >= s.min || r.ags === scope));
  const btn = `<div class="rp-ctl rp-noprint"><button type="button" data-rp="sctable" aria-expanded="${s.showTable ? 'true' : 'false'}">${s.showTable ? t('rep.asChart') : t('rep.asTable')}</button></div>`;
  const note = `<div class="muted small" style="margin-top:var(--s2)">${t('rep.municipalitiesWithAreaAnd', { length: pts.length, v1: rk.prelim ? ` · ${t('rep.preliminaryUnder3Full')}` : '', v2: pts.some(p => p.excluded.length) ? ` · ${t('rep.implausibleOperatorsOnlyIn')}` : '' })}</div>`;
  if (!pts.length) { s.sc = null; el.innerHTML = title(btn) + filterCtl(ctx, s, { minLabel: t('rep.minimumFleet2') }) + emptyBox(t('rep.noMunicipalityInFilter'), t('rep.lowerMinimumFleetOrChange')); return; }
  if (s.showTable) {
    const rows = R.sortRows(pts, 'rvd', 'desc');
    s.sc = null; el.innerHTML = title(btn) + filterCtl(ctx, s, { minLabel: t('rep.minimumFleet2') }) + `<div class="tbl"><table><thead><tr><th>${t('rep.cityState')}</th><th>${t('rep.type')}</th><th class="n">${t('rep.vehiclesPerKm2')}</th><th class="n">${t('rep.tripsPerVehAndDay')}</th><th class="n">${t('rep.avgFleet')}</th><th class="n">${t('rep.areaKm2')}</th></tr></thead><tbody>${rows.map(p => `<tr${p.ags === scope ? ' class="rp-sel"' : ''}><td>${cityCell(ctx, p.ags, p.name, p.state)}</td><td>${esc(typeName(p.ty))}</td><td class="n">${fmt(p.density, 1)}</td><td class="n">${fmt(p.rvd, 2)}</td><td class="n">${fmt(p.fleet)}</td><td class="n">${fmt(p.areaKm2, 1)}</td></tr>`).join('')}</tbody></table></div>` + note;
    return;
  }
  const W = 900, H = 340, P = { l: 48, r: 24, t: 14, b: 40 };
  const lx = pts.map(p => Math.log10(p.density)); let x0 = Math.floor(Math.min(...lx)), x1 = Math.ceil(Math.max(...lx)); if (x1 === x0) x1 = x0 + 1;
  const ymax = Math.max(1, Math.ceil(Math.max(...pts.map(p => p.rvd)) * 1.1));
  const X = (d) => P.l + ((Math.log10(d) - x0) / (x1 - x0)) * (W - P.l - P.r), Y = (v) => P.t + (1 - v / ymax) * (H - P.t - P.b);
  let g = ''; const yStep = ymax <= 4 ? 1 : ymax <= 10 ? 2 : 5;
  for (let v = 0; v <= ymax; v += yStep) g += `<line class="${v === 0 ? 'base' : 'grid'}" x1="${P.l}" x2="${W - P.r}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${P.l - 6}" y="${Y(v) + 3.5}" text-anchor="end">${fmt(v)}</text>`;
  for (let e = x0; e <= x1; e++) { const d = 10 ** e; g += `<line class="grid" x1="${X(d)}" x2="${X(d)}" y1="${P.t}" y2="${H - P.b}"/><text x="${X(d)}" y="${H - P.b + 16}" text-anchor="middle">${fmt(d, d < 1 ? 1 : 0)}</text>`; }
  g += `<text x="${(P.l + W - P.r) / 2}" y="${H - 4}" text-anchor="middle">${t('rep.vehiclesPerKm2Log')}</text><text x="12" y="${P.t + (H - P.t - P.b) / 2}" text-anchor="middle" transform="rotate(-90 12 ${P.t + (H - P.t - P.b) / 2})">${t('rep.tripsPerVehAndDay')}</text>`;
  const P2 = pts.map(p => ({ ...p, px: X(p.density), py: Y(p.rvd) }));
  // Beschriftung sparsam: gewählte Stadt, höchste Quote, höchste Dichte
  const lab = new Set([scope && P2.findIndex(p => p.ags === scope), P2.indexOf(R.sortRows(P2, 'rvd', 'desc')[0]), P2.indexOf(R.sortRows(P2, 'density', 'desc')[0])].filter(i => i != null && i >= 0));
  const dots = P2.map((p, i) => `<circle data-i="${i}" cx="${p.px.toFixed(1)}" cy="${p.py.toFixed(1)}" r="${p.ags === scope ? 6 : 4.5}" class="${p.ags === scope ? 'sel-pt' : ''}"/>`).join('');
  const placed = []; const labels = [...lab].map(i => { const p = P2[i]; const right = p.px < W - 160; const w = 7 * p.name.length + 4; const bx = right ? p.px + 9 : p.px - 9 - w; const box = [bx, p.py - 9, bx + w, p.py + 5];
    if (placed.some(q => box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1])) return ''; placed.push(box);
    return `<text class="lab" x="${(p.px + (right ? 9 : -9)).toFixed(1)}" y="${(p.py + 4).toFixed(1)}" text-anchor="${right ? 'start' : 'end'}">${esc(p.name)}</text>`; }).join('');
  s.sc = { pts: P2, W, i: null };
  el.innerHTML = title(btn) + filterCtl(ctx, s, { minLabel: t('rep.minimumFleet2') }) + `<div class="rp-chart"><svg class="rp-line rp-scatter" viewBox="0 0 ${W} ${H}" role="img" tabindex="0" aria-label="${t('rep.scatterPlotWith', { length: P2.length })}">${g}<g class="pts">${dots}</g>${labels}</svg></div>` + note;
}
export const EXTRA_CSS_2 = `
svg.rp-bars .bar{fill:var(--accent)}svg.rp-bars .hit{fill:transparent}svg.rp-bars g.on .bar{fill:color-mix(in oklab,var(--accent) 72%,var(--fg))}
svg.rp-bars .lim{stroke:var(--fg-2);stroke-width:1.5;stroke-dasharray:5 4}
.rp-seg{display:inline-flex;border:1px solid var(--line-2);border-radius:var(--r-sm);overflow:hidden}.rp-seg button{border:0;border-radius:0;background:transparent}.rp-seg button[aria-pressed="true"]{background:color-mix(in srgb,var(--accent) 16%,var(--panel));color:var(--fg);font-weight:600}
svg.rp-scatter .pts circle{fill:color-mix(in srgb,var(--accent) 78%,transparent);stroke:var(--panel);stroke-width:2}
svg.rp-scatter .pts circle.sel-pt{fill:var(--accent);stroke:var(--fg);stroke-width:2}
svg.rp-scatter .pts circle.on{stroke:var(--fg);stroke-width:2.5}
`;

// ======================================================================
// 10. Gebührenrechner (Sondernutzungsgebühr)
// ======================================================================
const euro = (ctx, v) => (v == null ? '—' : `${ctx.fmt(v)} €`);
const span = (ctx, a, b) => (a == null ? '—' : a === b ? euro(ctx, a) : `${ctx.fmt(a)}–${euro(ctx, b)}`);
/**
 * Gebührenrechner: gezählte Fahrzeuge × Gebührensatz je Gemeinde aus reference.json → gebuehren (nur Sätze mit Quelle);
 * eigener Satz für die gewählte Gemeinde. Daten: reference.json (CFG.MAIN), latest.json groups.
 */
export async function renderFeeCalculator(el, ctx) {
  if (!el) return;
  const s = prep2(el, ctx); const { state } = ctx;
  if (!s.own) s.own = { rate: '', unit: 'jahr', type: 'scooter' };
  bindOnce(el, 'fee', () => {
    el.addEventListener('input', (e) => { const k = e.target.dataset?.own; if (!k) return; s.own[k] = e.target.value; const out = el.querySelector('[data-rp="ownout"]'); if (out) out.innerHTML = ownOut(s.ctx, s); });
    el.addEventListener('change', (e) => { const k = e.target.dataset?.own; if (!k) return; s.own[k] = e.target.value; const out = el.querySelector('[data-rp="ownout"]'); if (out) out.innerHTML = ownOut(s.ctx, s); });
  });
  const tok = ++s.tok;
  const title = head(t('rep.feeCalculator'), t('rep.specialUseFeeFromCounted', { v0: stamp(state.latest?.at) }));
  if (!state.latest) { el.innerHTML = title + emptyBox(t('rep.noDataSnapshotYet'), ''); return; }
  const ref = await reference(ctx); if (tok !== s.tok) return;
  const list = R.feeEstimates(ref, state.latest.groups, { ags: state.scope || 'DE' });
  const { esc, fmt } = ctx;
  const rows = list.map(e => `<tr><td>${esc(e.ort || state.latest.municipalities?.[e.ags]?.name || e.ags)}</td><td>${esc(e.types.map(typeName).join(', ') || t('rep.all'))}</td>
    <td class="n">${e.rate ? `${e.rate.range ? `${fmt(+[].concat(e.satz)[0])}–${fmt(+[].concat(e.satz).slice(-1)[0])}` : fmt(+[].concat(e.satz)[0], 2)}${/€/.test(e.einheit || '') ? '' : ' €'}` : '—'}<div class="sub-line">${esc(tx(e.einheit || ''))}</div></td><td class="small" translate="no">${esc(e.gebiet || '–')}</td>
    <td class="n">${fmt(e.count)}<div class="sub-line">${plural(e.operators.length, t('rep.operatorOne'), t('rep.operatorMany'))}</div></td><td class="n"><b>${span(ctx, e.yearMin, e.yearMax)}</b></td><td class="n">${span(ctx, e.monthMin, e.monthMax)}</td><td class="small">${safeLink(ctx, e.url, e.quelle || t('rep.source'))}${e.stand ? `<div class="sub-line">${t('rep.asOf4', { v0: /^\d{4}-\d{2}-\d{2}$/.test(e.stand) ? dd(e.stand) : esc(e.stand) })}</div>` : ''}</td></tr>`).join('');
  const table = list.length ? `<div class="tbl"><table><thead><tr><th>${t('rep.city')}</th><th>${t('rep.type')}</th><th class="n">${t('rep.rate')}</th><th>${t('rep.area')}</th><th class="n">${t('rep.counted')}</th><th class="n">${t('rep.perYear')}</th><th class="n">${t('rep.perMonth')}</th><th>${t('rep.source')}</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : emptyBox(ref?.gebuehren?.length ? t('rep.noFeeRateWithSourceIsStored') : t('rep.noFeeRatesWithSourceStored'), ref?.gebuehren?.length ? t('rep.storedForOwnRateBelow', { list: [...new Set(ref.gebuehren.map(g => g.ort))].map(esc).join(', ') }) : t('rep.referenceJsonGebuehrenIs'));
  const { types } = groupOptions(state.latest);
  const own = `<div class="panel-head" style="margin-top:var(--s4)"><div><h3 style="margin:0;font-size:14px">${t('rep.ownRate')}</h3><div class="sub">${t('rep.forMunicipalitiesWithoutRate')}</div></div></div>
    <div class="rp-ctl rp-noprint"><label>${t('rep.rate')} <input type="number" data-own="rate" min="0" step="0.5" value="${esc(s.own.rate)}" placeholder="z. B. 50" style="width:7em" aria-label="${t('rep.ownFeeRateInEuros')}"> €</label>
    <label>${t('rep.perVehicleAnd')} <select data-own="unit"><option value="jahr"${s.own.unit === 'jahr' ? ' selected' : ''}>${t('rep.year')}</option><option value="monat"${s.own.unit === 'monat' ? ' selected' : ''}>${t('rep.month')}</option></select></label>
    <label>${t('rep.vehicleType')} <select data-own="type">${types.map(tq => `<option value="${esc(tq)}"${tq === s.own.type ? ' selected' : ''}>${esc(typeName(tq))}</option>`).join('')}</select></label></div>
    <div data-rp="ownout" aria-live="polite" style="margin-top:var(--s2)">${ownOut(ctx, s)}</div>`;
  el.innerHTML = title + `<div class="note small" style="margin-bottom:var(--s3)">${t('rep.countedVehiclesOfType')}</div>` + table + own;
}
function ownOut(ctx, s) {
  const { state, fmt, esc } = ctx; const scope = state.scope;
  const rate = parseFloat(String(s.own.rate).replace(',', '.'));
  if (!scope || scope === 'DE') return `<span class="muted small">${t('rep.chooseMunicipalityAboveUnder')}</span>`;
  const count = Object.entries(state.latest?.groups || {}).filter(([k]) => { const [a, , tq] = k.split('|'); return a === scope && tq === s.own.type; }).reduce((a, [, g]) => a + (g.total || 0), 0);
  const name = state.latest?.municipalities?.[scope]?.name || scope;
  if (!Number.isFinite(rate)) return `<span class="muted small">${t('rep.countedEnterRate', { name: esc(name), count: fmt(count), typeName: esc(typeName(s.own.type)) })}</span>`;
  const r = R.ownFee(rate, s.own.unit, count);
  return `<div class="tiles">${tile(`${esc(name)} · ${esc(typeName(s.own.type))}`, fmt(count), t('rep.countedVehicles'))}${tile(t('rep.perYear'), euro(ctx, r.year), t('rep.perVehicleAndOwnRate', { rate: fmt(rate, 2), v1: s.own.unit === 'monat' ? t('rep.month') : t('rep.year') }))}${tile(t('rep.perMonth'), euro(ctx, r.month), t('rep.ownRateWithoutSource'))}</div>`;
}

// ======================================================================
// 11. Steckbrief Regulierung
// ======================================================================
/** Steckbrief je Stadt aus reference.json (Obergrenzen, Gebühren, Referenzwerte) und Anbieter laut Daten; bei 'DE' alle Städte mit Eintrag */
export async function renderRegulationProfile(el, ctx) {
  if (!el) return;
  const s = prep2(el, ctx); const { state, esc, fmt } = ctx; const tok = ++s.tok;
  const title = head(t('rep.regulationProfile'), t('rep.fleetCapsFeesAndReference'));
  if (!state.latest) { el.innerHTML = title + emptyBox(t('rep.noDataSnapshotYet'), ''); return; }
  const ref = await reference(ctx); if (tok !== s.tok) return;
  if (!ref) { el.innerHTML = title + emptyBox(t('rep.referenceValuesNotLoadable'), t('rep.referenceJsonIsMissingOr2')); return; }
  const profs = R.regulationProfiles(ref, state.latest, { ags: state.scope || 'DE', asOf: state.latest.at || Date.now() });
  const src = (e) => safeLink(ctx, e.url, e.quelle || t('rep.source'));
  const card = (p) => {
    const caps = p.caps.map(c => t('rep.inTotalCounted', { limit: fmt(c.limit), typeName: esc(typeName(c.type)), v2: c.perOperator != null ? t('rep.perOperator4', { perOperator: fmt(c.perOperator) }) : '', v3: c.districts.length ? `; ${c.districts.map(d => `${srcTxt(esc, d.label)} ${d.limit != null ? fmt(d.limit) : d.perOperator != null ? t('rep.perOperatorZone', { perOperator: fmt(d.perOperator) }) : '—'}`).join(', ')}` : '', v4: c.previous != null ? ` <span class="muted">${t('rep.fromBeforeThat', { v0: dd(c.since), previous: fmt(c.previous) })}</span>` : '', v5: badge(c.status), total: fmt(c.total), c: src(c) })).join('<br>') || `<span class="muted">${t('rep.notStored')}</span>`;
    const fees = p.fees.map(f => `${esc([].concat(f.satz).join('–'))} ${esc(tx(f.einheit || ''))} · ${esc([].concat(f.type || []).map(typeName).join(', '))}${f.gebiet ? ` · ${srcTxt(esc, f.gebiet)}` : ''} · ${src(f)}`).join('<br>') || `<span class="muted">${t('rep.noRateWithSourceStored')}</span>`;
    const ops = Object.entries(p.operators).sort((a, b) => TYPE_ORDER.indexOf(a[0]) - TYPE_ORDER.indexOf(b[0])).map(([ty, l]) => `${esc(typeName(ty))}: ${l.length} <span class="muted">(${l.map(esc).join(', ')})</span>`).join('<br>') || `<span class="muted">${t('rep.noVehiclesInOpenFeeds')}</span>`;
    const refs = p.refs.map(r => { const v = r.kind === 'fahrt' ? tripTxt(ctx, r) : fmt(r.wert, r.kind === 'rvd' ? 2 : 0);
      return `${({ rvd: t('rep.tripsPerVehAndDay'), flotte: fleetLabel(r), fahrt: t('rep.trip2'), fahrten: t('rep.trips') })[r.kind]} ${esc(typeName(r.type))}: ${v} <span class="muted">(${esc(r.zeitraum || r.stand || '')})</span> · ${src(r)}`; }).join('<br>') || `<span class="muted">${t('rep.none')}</span>`;
    return `<div class="card"><b>${esc(p.name)}${p.state ? ` <span class="muted">(${esc(p.state)})</span>` : ''}</b><div class="foot">AGS ${esc(p.ags)}${p.pop ? ` · ${t('rep.residents', { pop: fmt(p.pop) })}` : ''}</div>
      <dl><dt>${t('rep.fleetCaps')}</dt><dd>${caps}${p.caps.length ? `<div><a href="#bericht" data-rp-jump="rp-caps">${t('rep.capCheckLink')}</a></div>` : ''}</dd><dt>${t('rep.fees')}</dt><dd>${fees}</dd><dt>${t('rep.operatorsAccordingToData')}</dt><dd>${ops}</dd><dt>${t('rep.referenceValues')}</dt><dd>${refs}</dd><dt>${t('rep.accidents')}</dt><dd><span class="muted">${t('rep.noMapUnfallatlasDoesNotListE')}</span></dd></dl></div>`;
  };
  el.innerHTML = title + (profs.length ? `<div class="rp-prof">${profs.map(card).join('')}</div>` : emptyBox(t('rep.noRegulationDataStored'), t('rep.referenceJsonHasNoEntryFor')))
    + `<div class="muted small" style="margin-top:var(--s2)">${t('rep.onlyInformationStatedIn')}</div>`;
}

// ======================================================================
// 12. Hotspot-Stabilität
// ======================================================================
/**
 * Überlappung der Top-200-Startzellen zwischen beobachteten Tagen der gewählten Gemeinde (Tag-zu-Tag-Stabilität,
 * keine Validierung gegen Betreiberdaten). Daten: events/index.json (cellDays), cells/<Tag>/<Land>.json, events/<Tag>.json (Beobachtung).
 */
export async function renderHotspotStability(el, ctx) {
  if (!el) return;
  const s = prep2(el, ctx); const { state, esc, fmt } = ctx; const tok = ++s.tok;
  const title = head(t('rep.hotspotStability'), t('rep.overlapOfTop200StartCells'));
  if (!state.latest) { el.innerHTML = title + emptyBox(t('rep.noDataSnapshotYet'), ''); return; }
  if (!state.scope || state.scope === 'DE') { el.innerHTML = title + emptyBox(t('rep.chooseMunicipality'), t('rep.stabilityIsCalculatedPer')); return; }
  el.classList.add('rp-busy');
  try {
    const ags = state.scope, land = state.latest.municipalities?.[ags]?.state; const idx = await usageIndex(ctx);
    const days = (idx.cellDays || []).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
    const [cdocs, edocs] = await Promise.all([Promise.all(days.map(d => cellsDoc(ctx, idx, d, land))), Promise.all(days.map(d => ((idx.days || []).includes(d) ? eventsDoc(ctx, idx, d) : null)))]);
    if (tok !== s.tok) return;
    const cells = Object.fromEntries(days.map((d, i) => [d, cdocs[i]?.munis?.[ags] || null]));
    const stb = R.hotspotStability(cells, { top: 200 });
    const obs = Object.fromEntries(days.map((d, i) => [d, edocs[i] ? R.hourQuality(edocs[i].runs, edocs[i].gapHours) : null]));
    const oh = (d) => (obs[d] ? `${fmt(obs[d].obsMin / 60, 1)} h` : '–');
    const thin = stb.pairs.some(p => !obs[p.a]?.full || !obs[p.b]?.full);
    const tiles = `<div class="tiles">${tile(t('rep.avgOverlap'), stb.meanShare == null ? '—' : pctTxt(ctx, stb.meanShare, 0), t('rep.sharedTopCellsSmallerTopSet', { v0: thin ? ` · ${t('rep.preliminary')}` : '' }))}${tile(t('rep.dayPairs'), fmt(stb.pairs.length), t('rep.withCells', { v0: plural(stb.days.length, t('rep.day'), t('rep.days')) }))}${tile(t('rep.topCellsPerDay'), t('rep.upTo', { top: stb.top }), t('rep.onlyCellsWithTripStarts', { minCount: stb.minCount }))}</div>`;
    const rows = stb.pairs.map(p => `<tr><td>${dd(p.a)} → ${dd(p.b)}</td><td class="n">${fmt(p.nA)} / ${fmt(p.nB)}</td><td class="n">${fmt(p.common)}</td><td class="n"><b>${pctTxt(ctx, p.share, 0)}</b></td><td class="n">${pctTxt(ctx, p.jaccard, 0)}</td><td class="n">${oh(p.a)} / ${oh(p.b)}</td></tr>`).join('');
    el.innerHTML = title + tiles + (stb.pairs.length ? `<div class="tbl" style="margin-top:var(--s3)"><table><thead><tr><th>${t('rep.days')}</th><th class="n">${t('rep.topCells')}</th><th class="n">${t('rep.shared')}</th><th class="n">${t('rep.overlap')}</th><th class="n">Jaccard</th><th class="n">${t('rep.observed3')}</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyBox(t('rep.onlyOneDayWithCellsSoFar'), t('rep.overlapNeedsAtLeastTwo')))
      + `<div class="note small" style="margin-top:var(--s3)">${t('rep.measureAsInValidationBy', { v0: thin ? t('rep.caseHere') : t('rep.under20Hours') })}</div>`;
  } catch (e) { console.error('Hotspots', e); if (tok === s.tok) el.innerHTML = title + emptyBox(t('rep.notComputable'), t('rep.cellFilesNotLoadable')); }
  finally { if (tok === s.tok) el.classList.remove('rp-busy'); }
}

// ======================================================================
// Prognose (forecast/latest.json, forecast/log.json): erwartete Fahrtbeginne der nächsten 24 Stunden, Selbstprüfung, Live-Abgleich
// ======================================================================
const FC_MIN_FLEET = 5, FC_HIGH = 1.25, FC_LOW = 0.6;
function fcBars(ctx, series, local, width) {
  const W = Math.max(300, Math.min(1100, Math.round(width || 720))), H = 140, pl = 4, pb = 22, pt = 8, n = series.length, max = Math.max(1, ...series), bw = (W - 2 * pl) / n, total = series.reduce((a, b) => a + b, 0), every = W < 480 ? 6 : 3;
  const bars = series.map((v, i) => { const h = Math.max(1, (H - pt - pb) * v / max); return `<rect class="fcb" style="fill:var(--accent)" x="${(pl + i * bw + 1.5).toFixed(1)}" y="${(H - pb - h).toFixed(1)}" width="${Math.max(2, bw - 3).toFixed(1)}" height="${h.toFixed(1)}" rx="2"><title>${local[i][1]}:00 · ${ctx.fmt(v, v < 10 ? 1 : 0)}</title></rect>`; }).join('');
  const lab = local.map(([, h], i) => (i % every === 0 ? `<text x="${(pl + i * bw + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" fill="currentColor" opacity=".75" font-size="11">${h}</text>` : '')).join('');
  return `<div class="rp-chart"><svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;max-width:${W}px" role="img" aria-label="${ctx.esc(t('fc.chartAria', { total: ctx.fmt(total) }))}">${bars}${lab}</svg></div>`;
}
export async function renderForecast(el, ctx) {
  if (!el) return;
  const s = prep2(el, ctx); const { state, esc, fmt } = ctx; const tok = ++s.tok;
  const title = head(t('fc.title'), t('fc.sub'));
  el.classList.add('rp-busy');
  try {
    const [fc, lg] = await Promise.all([fetchJson(ctx, 'forecast/latest.json', true), fetchJson(ctx, 'forecast/log.json', true)]); if (tok !== s.tok) return;
    if (!fc || fc.version !== 1) { el.innerHTML = title + emptyBox(t('fc.none'), t('fc.noneHint')); return; }
    const G = fc.gates || {}, minTrain = G.minTrainDays ?? 2, minEval = G.minEvalDays ?? 3;
    const modelName = (m) => (m ? t(`fc.model.${m}`) : '–');
    const status = fc.status === 'active' ? t('fc.statusActive', { model: modelName(fc.active), reason: esc(fcReason(fc)) })
      : fc.status === 'learning' ? t('fc.statusLearning', { n: fc.evalDays || 0, min: minEval }) : t('fc.statusInsufficient', { n: fc.trainDays || 0, min: minTrain });
    const badge = `<p class="note small" style="margin:0 0 var(--s3)"><span class="rp-status ${fc.status === 'active' ? 'ok' : 'near'}" style="white-space:normal;align-items:flex-start"><i aria-hidden="true" style="margin-top:2px">${fc.status === 'active' ? '✓' : '!'}</i>${esc(status)}</span></p>`;
    if (!fc.horizon || !fc.totals) { el.innerHTML = title + badge + emptyBox(t('fc.none'), t('fc.noneHint')); return; }
    const ags = state.scope && state.scope !== 'DE' ? state.scope : null;
    const series = ags ? fc.municipalities?.[ags] : fc.totals, local = fc.horizon.local;
    const pct = (v) => (v == null ? '–' : `${fmt(v * 100, 0)} %`);
    // Live-Abgleich: Mittel der letzten bewerteten Prognosen
    // gleiche Rechnung wie Prognose › Verlauf (lib/pulse-forecast.js liveSummary, Audit MET-08): Modell und „wie gestern“ über dieselben Stunden, 7 Tage
    const ls = FCL.liveSummary(fc.live, { now: fc.generatedAt ? Date.parse(fc.generatedAt) : null });
    const ev = lg?.evals || {}, evDays = Object.keys(ev).sort().slice(-(G.evalWindow || 7));
    const evAvg = (m) => { const v = evDays.map(d => ev[d]?.models?.[m]?.wapeGD).filter(x => x != null); return v.length >= minEval ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    const wg = fc.weather?.gate || {};
    const time = new Intl.DateTimeFormat(fmtLocale(), { hour: '2-digit', minute: '2-digit', timeZone: R.TZ }).format(new Date(fc.horizon.from));
    const scopeTxt = ags ? esc(ctx.muniName?.(ags) || state.latest?.municipalities?.[ags]?.name || ags) : t('fc.scopeDE');
    const tiles = `<div class="tiles">`
      + tile(t('fc.expected'), series ? fmt(series.reduce((a, b) => a + b, 0), 0) : '—', t('fc.expectedSub', { time, scope: scopeTxt }))
      + tile(t('fc.liveError'), ls ? pct(ls.a) : '—', ls ? t('fc.liveErrorSub', { n: ls.n, naive: pct(ls.b), skill: ls.skill == null ? '–' : pct(ls.skill) }) : t('fc.liveNone'))
      + tile(t('fc.backtest'), evAvg(fc.active || 'pooled') == null ? '—' : pct(evAvg(fc.active || 'pooled')), evAvg('pooled') == null ? t('fc.backtestNone') : t('fc.backtestSub', { n: evDays.length, profile: pct(evAvg('profile')), pooled: pct(evAvg('pooled')) }))
      + tile(t('fc.weather'), fc.weather?.used ? t('fc.weatherOn') : t('fc.weatherOff'), t('fc.weatherSub', { k: fmt(wg.tempRangeK ?? 0, 1), rain: wg.rainDays ?? 0, dry: wg.dryDays ?? 0, kmin: G.wxTempRangeK ?? 5, dmin: G.wxRainDays ?? 2 }))
      + `</div>`;
    const chart = series ? `<div style="margin-top:var(--s3)">${fcBars(ctx, series, local, el.clientWidth - 40)}<div class="rp-chart fc-wx"></div></div>` : `<div class="note" style="margin-top:var(--s3)">${t('fc.noMuni')}</div>`;
    // Auslastung: erwartete Fahrtbeginne je Fahrzeug gegen den Median der Fahrzeugart (Gruppen ab FC_MIN_FLEET Fahrzeugen)
    const rows = Object.entries(fc.groups || {}).map(([k, g]) => { const [a, op, ty] = k.split('|'); return { k, ags: a, op, ty, fleet: g.fleet, starts: g.start.reduce((x, y) => x + y, 0), perVeh: g.perVeh }; });
    const med = {}; for (const key of new Set(rows.map(r => `${r.op}|${r.ty}`))) { const v = rows.filter(r => `${r.op}|${r.ty}` === key && r.fleet >= FC_MIN_FLEET && r.perVeh != null).map(r => r.perVeh).sort((a, b) => a - b); if (v.length >= 3) med[key] = v[Math.floor(v.length / 2)]; }
    for (const r of rows) { r.vs = med[`${r.op}|${r.ty}`] && r.fleet >= FC_MIN_FLEET && r.perVeh != null ? r.perVeh / med[`${r.op}|${r.ty}`] : null; r.cls = r.vs == null ? null : r.vs >= FC_HIGH ? 'high' : r.vs <= FC_LOW ? 'low' : 'mid'; }
    const clsTxt = (c) => (c === 'high' ? `<span class="rp-status near"><i aria-hidden="true">▲</i>${t('fc.high')}</span>` : c === 'low' ? `<span class="rp-status over"><i aria-hidden="true">▼</i>${t('fc.low')}</span>` : c === 'mid' ? t('fc.mid') : '–');
    const line = (r, withMuni) => `<tr><td>${withMuni ? `${esc(ctx.muniName?.(r.ags) || state.latest?.municipalities?.[r.ags]?.name || r.ags)} · ` : ''}${esc(r.op)} · ${esc(typeName(r.ty))}</td><td class="n">${fmt(r.fleet, 0)}</td><td class="n">${fmt(r.starts, 0)}</td><td class="n">${r.perVeh == null ? '–' : fmt(r.perVeh, 1)}</td><td class="n">${r.vs == null ? '–' : `${fmt(r.vs, 2)}×`}</td><td>${clsTxt(r.cls)}</td></tr>`;
    const thead = (first) => `<thead><tr><th>${first}</th><th class="n">${t('fc.colFleet')}</th><th class="n">${t('fc.colStarts')}</th><th class="n">${t('fc.colPerVeh')}</th><th class="n">${t('fc.colVs')}</th><th>${t('fc.colClass')}</th></tr></thead>`;
    let body = '';
    if (ags) {
      const mine = rows.filter(r => r.ags === ags).sort((a, b) => b.starts - a.starts);
      if (mine.length) body = `<h3 style="margin:var(--s4) 0 var(--s1);font-size:14px">${t('fc.tableTitle')}</h3><div class="tbl" tabindex="0" role="region" aria-label="${esc(t('fc.tableTitle'))}"><table>${thead(t('fc.colOperator'))}<tbody>${mine.map(r => line(r, false)).join('')}</tbody></table></div>`;
    } else {
      const top = Object.entries(fc.municipalities || {}).map(([a, v]) => [a, v.reduce((x, y) => x + y, 0)]).sort((a, b) => b[1] - a[1]).slice(0, 8);
      const big = rows.filter(r => r.fleet >= 20 && r.vs != null), hi = [...big].sort((a, b) => b.vs - a.vs).slice(0, 8), lo = [...big].sort((a, b) => a.vs - b.vs).slice(0, 8);
      body = `<div class="grid" style="margin-top:var(--s4)"><div class="c4"><h3 style="margin:0 0 var(--s1);font-size:14px">${t('fc.topMunis')}</h3><div class="tbl" tabindex="0" role="region" aria-label="${esc(t('fc.topMunis'))}"><table><tbody>${top.map(([a, v]) => `<tr><td>${esc(ctx.muniName?.(a) || state.latest?.municipalities?.[a]?.name || a)}</td><td class="n">${fmt(v, 0)}</td></tr>`).join('')}</tbody></table></div></div>`
        + `<div class="c8"><h3 style="margin:0 0 var(--s1);font-size:14px">${t('fc.topHigh', { min: 20 })}</h3><div class="tbl" tabindex="0" role="region" aria-label="${esc(t('fc.topHigh', { min: 20 }))}"><table>${thead(t('fc.colOperator'))}<tbody>${hi.map(r => line(r, true)).join('')}</tbody></table></div>`
        + `<h3 style="margin:var(--s3) 0 var(--s1);font-size:14px">${t('fc.topLow', { min: 20 })}</h3><div class="tbl" tabindex="0" role="region" aria-label="${esc(t('fc.topLow', { min: 20 }))}"><table>${thead(t('fc.colOperator'))}<tbody>${lo.map(r => line(r, true)).join('')}</tbody></table></div></div></div>`;
    }
    el.innerHTML = title + badge + tiles + chart + body + `<div class="note small" style="margin-top:var(--s3)">${t('fc.note', { min: FC_MIN_FLEET })}</div>`;
    // Wetter der nächsten 24 Stunden unter den Balken (gleiche x-Achse wie fcBars: W, Rand 4)
    const wxBox = el.querySelector('.fc-wx');
    if (wxBox && series && Array.isArray(local)) weatherFor(local.map(([d, h]) => [d, h]), ags, ctx.getJson, ctx.CFG.DATA).then((vals) => {
      if (!wxBox.isConnected || tok !== s.tok) return; const W = Math.max(300, Math.min(1100, Math.round(el.clientWidth - 40 || 720)));
      const svg = weatherSvg(vals, { W, pl: 4, pr: 4, hours: local.map(([, h]) => h), esc, svgAttrs: `width="100%" style="display:block;max-width:${W}px"` });
      wxBox.innerHTML = svg ? `<style>${WX_CSS}.fc-wx text{fill:currentColor;opacity:.75;font-size:11px}.fc-wx .gl{stroke:var(--line);stroke-width:1}.fc-wx rect.hit{fill:transparent}</style>${svg}<div class="note small">${t('wx.legend', { scope: scopeTxt })}</div>` : '';
    });
  } catch (e) { console.error('Prognose', e); if (tok === s.tok) el.innerHTML = title + emptyBox(t('rep.notComputable'), t('fc.noneHint')); }
  finally { if (tok === s.tok) el.classList.remove('rp-busy'); }
}

// ======================================================================
// Messbasis: Reifegrad je Kennzahl (research Nr. 15) und Ampel der Ereignisregeln (datamine Nr. 18)
// ======================================================================
// Messbasis-Abzeichen (mbBase, mbBadge, …) liegen seit S3.4 in web/ui-shared.js (Start und Disposition ohne report.js)
/** Flag-Text im Bericht: Ampel rot vor anderen Flags (Grund für den Ausschluss) */
export const mbFlagText = (flags) => (flags.includes(R.AMPEL_RED) ? t('mb.flagRed') : tx(flags[0]));
/** Ampel je Gruppe für die Feed-Prüfung (Gebiet und Anbieter wie oben; gelb und rot zuerst, höchstens 60 Zeilen) */
export function mbAmpelHtml(ctx) {
  const { state, esc } = ctx; const ec = state.latest?.eventChecks;
  const h = `<h3 class="mb-h">${t('mb.ampelTitle', { day: ec?.day ? dd(ec.day) : '–' })}</h3>`;
  if (!ec?.groups) return h + `<div class="muted small">${t('mb.ampelNone')}</div>`;
  const W0 = { bad: 2, warn: 1 };
  const rows = Object.entries(ec.groups).filter(([k]) => { const [a, op] = k.split('|'); return (!state.scope || state.scope === 'DE' || a === state.scope) && (state.operator === 'all' || op === state.operator); })
    .sort((a, b) => (W0[b[1].level] || 0) - (W0[a[1].level] || 0) || (b[1].checks?.rides || 0) - (a[1].checks?.rides || 0));
  const shown = rows.filter(([, v]) => v.level !== 'ok').slice(0, 60), n = (lv) => rows.filter(([, v]) => v.level === lv).length, R0 = ec.rules || {};
  const body = shown.map(([k, v]) => { const [a, op, ty] = k.split('|'); const c = v.checks || {};
    return `<tr><td><span class="op"><i style="background:${ctx.opColor(op)}"></i>${esc(op)}</span><div class="sub-line">${esc(typeName(ty))} · ${esc(ctx.muniName(a))}</div></td><td>${mbLevel(v.level)}</td><td class="n">${mbNum(c.rides)}</td><td class="n">${mbPct(c.pickupShare)}<div class="sub-line">r ${mbNum(c.r, 2)}</div></td><td class="n">${mbNum(c.se, 2)}</td><td class="n">${mbNum(c.swapsPer100, 1)}</td><td class="small">${esc(mbChecksText(c))}</td></tr>`; }).join('');
  const rules = t('mb.ampelRules', { pw: mbPct(R0.pickupWarn ?? 0.1), pb: mbPct(R0.pickupBad ?? 0.2), r: mbNum(R0.pickupR ?? 0.5, 1), lo: mbNum(R0.seWarn?.[0] ?? 0.7, 1), hi: mbNum(R0.seWarn?.[1] ?? 1.3, 1), sw: mbNum(R0.swapZeroRides ?? 300), min: mbNum(R0.minRides ?? 50) });
  const old = ec.ruleCurrent === false ? ` ${t('mb.ampelOldRule', { rule: esc(mbRules(ec.dayRules)), now: esc(ec.ruleNow || '–'), n: rows.filter(([, v]) => v.was === 'bad').length })}` : '';
  return h + `<div class="muted small" style="margin-bottom:var(--s2)">${t('mb.ampelSummary', { red: n('bad'), yellow: n('warn'), ok: n('ok') })}${old} ${rules}</div>`
    + (body ? `<div class="tbl" tabindex="0" role="region" aria-label="${t('mb.ampelAria')}"><table><thead><tr><th>${t('rep.operator2')}</th><th>${t('mb.ampel')}</th><th class="n">${t('mb.rides')}</th><th class="n">${t('mb.pickupShare')}</th><th class="n">${t('mb.se')}</th><th class="n">${t('mb.swaps100')}</th><th>${t('mb.findings')}</th></tr></thead><tbody>${body}</tbody></table></div>` : `<div class="muted small">${t('mb.ampelAllOk')}</div>`);
}
