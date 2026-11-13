// Mobility Pulse — Prognose (Ansicht) – Zeugnis, Lernkurve, Steckbrief, Spots, Kopfleiste (aus forecast.js geschnitten; forecast.js bleibt die Fassade für alle Importe).
import * as FC from './pulse-forecast.js';
import * as SP from './pulse-spots.js';
import { groupPlaces, DEFAULTS as OPS } from './pulse-ops.js';
import { VEHICLE_TYPE_LABEL, familyOf } from './pulse-core.js';
import { toCsv } from './pulse-report.js';
import { t, tMap, lang, dateFmt, numFmt, fcReason } from './i18n.js';
import { mapKeys } from './mapkeys.js';
import { DEMAND_DAYS, FAM, MODEL_COLOR, MODEL_ORDER, SPOT_ROWS, TZ, accRows, allTag, blendTxt, dayTxt, famNow, head, loadDemand, loadFleet, loadGroups, mature, modelName, n0, n1, pc, raceOf, setFam, setLastRated, sg, sum, tile } from './forecast-data.js';
import { renderForecastView, scopeLabel, timeTxt } from './forecast-view.js';
import { HIT } from './tokens.js';
import { chartSpec, tableButton } from './charttip.js';

// ---------- Zeugnis: wie gut ist die Prognose, besser als „wie gestern“? ----------
export const judge = (a, b) => (a == null || b == null ? null : Math.abs(a - b) <= 0.05 * b ? 'eq' : a < b ? 'better' : 'worse');
/** Drei Ebenen: gewähltes Gebiet je Stunde (Plan gegen Ist), Gruppen je Stunde und je Tag (Selbstprüfung des aktiven Modells) – jeweils gegen „wie gestern“ */
export function gradeOf(S0, sel, G, L) {
  const mean = (a) => (a.length ? sum(a) / a.length : null), rows = S0 ? accRows(S0, sel, G).filter(r => r.naive != null) : [];
  const scope = rows.length ? { a: mean(rows.map(r => r.wape)), b: mean(rows.map(r => r.naive)), n: rows.length, bias: mean(rows.map(r => r.bias)) } : null;
  const ev = G?.evals || {}, act = L?.active || 'pooled', win = L?.gates?.evalWindow ?? FC.GATES.evalWindow;
  const days = Object.keys(ev).sort().filter(d => mature(G, d)).slice(-win).filter(d => ev[d]?.models?.[act] && ev[d]?.models?.naive);
  const gm = (k) => (days.length ? { a: mean(days.map(d => ev[d].models[act][k])), b: mean(days.map(d => ev[d].models.naive[k])), n: days.length } : null);
  // ausgegebene Prognosen (Live-Abgleich, letzte 7 Tage): je Anbieter und Stunde gegen „wie gestern“ über dieselben Stunden
  const liveLv = FC.liveSummary(L?.live, { now: L?.generatedAt ? Date.parse(L.generatedAt) : null }); // eine Quelle mit dem Bericht (Audit MET-08)
  // Audit UXP-07: live, gh und gd gelten für Deutschland gesamt; bei einer Auswahl (Gemeinde, Anbieter, Art) urteilt nur deren eigene Ebene
  const local = !(sel?.ags === 'DE' || !sel?.ags) || (sel?.op && sel.op !== 'all') || (sel?.ty && sel.ty !== 'all');
  const lv = [['live', liveLv], ['scope', scope], ['gh', gm('wapeGH')], ['gd', gm('wapeGD')]].filter(([, x]) => x && x.a != null && x.b != null).map(([k, x]) => ({ k, ...x, j: judge(x.a, x.b), nat: local && k !== 'scope' }));
  const vl = local && lv.some(x => x.k === 'scope') ? lv.filter(x => x.k === 'scope') : lv, main = vl[0] || null;
  const nb = vl.filter(x => x.j === 'better').length, nw = vl.filter(x => x.j === 'worse').length;
  // Audit UXP-06: Haken nur, wenn mindestens eine Ebene besser ist und die Hauptebene unter GRADE_USABLE Abweichung liegt
  const unusable = main != null && main.a >= GRADE_USABLE;
  const lvl = !vl.length ? 'none' : nw === 0 && nb >= 1 && !unusable ? 'ok' : nb === 0 && nw > 0 ? 'bad' : 'near';
  const biasG = days.length ? mean(days.map(d => ev[d].models[act].bias).filter(x => x != null)) : null;
  return { lv, vl, main, local, natOnly: local && !lv.some(x => x.k === 'scope'), unusable, nb, nw, lvl, act, evalDays: days.length, win, bias: scope?.bias ?? biasG };
}
const GRADE_USABLE = 0.5; // Abweichung je Stunde ab 50 %: „nur als Größenordnung lesen“, kein grüner Haken
/** Hauptsatz des Urteils (S4.2: das einzige Prognose-Urteil, aus gradeOf) */
export function verdictMain(g) {
  if (!g.vl?.length) return t('fv.vNone');
  const n = g.vl.length, x = g.main;
  return g.unusable ? t('fv.vUnusable', { a: pc(x.a), b: pc(x.b) })
    : n === 1 ? t(x.j === 'better' ? 'fv.vOne' : x.j === 'worse' ? 'fv.vOneWorse' : 'fv.vOneEq', { a: pc(x.a), b: pc(x.b) })
    : g.nw === 0 ? (g.nb === n ? t('fv.vAll', { n }) : t('fv.vNoWorse', { b: g.nb, n })) : g.nb === 0 ? t('fv.vNotYet', { w: g.nw, n }) : t('fv.vMixed', { b: g.nb, w: g.nw, n });
}
/** Verzerrung, Grundlage und Geltungsbereich des Urteils */
export function verdictMore(g) {
  if (!g.vl?.length) return '';
  const nat = g.natOnly ? ` ${t('fv.vNational')}` : '';
  const basis = g.evalDays < g.win ? t('fv.vBasisEarly', { n: g.evalDays, win: g.win }) : t('fv.vBasis', { n: g.evalDays });
  const bias = g.bias == null ? '' : Math.abs(g.bias) < 0.05 ? t('fv.vBiasNone', { d: sg(g.bias, 0) }) : t(g.bias < 0 ? 'fv.vBiasLow' : 'fv.vBiasHigh', { d: pc(Math.abs(g.bias)) });
  return `${bias} ${basis}${nat}`.trim();
}
function verdictText(ctx, g) {
  if (!g.vl?.length) return t('fv.vNone');
  return `<b>${ctx.esc(verdictMain(g))}</b> ${ctx.esc(verdictMore(g))}`;
}
/** Zeugnis in einer Zeile über dem Diagramm (Audit UXP-05), Details im Panel darunter */
export function gradeLine(ctx, S0, sel, G, L) {
  const g = gradeOf(S0, sel, G, L), ico = g.lvl === 'ok' ? '✓' : g.lvl === 'near' ? '!' : g.lvl === 'bad' ? '✗' : '–';
  return `<p class="fv-verdict fv-gline ${g.lvl}"><i aria-hidden="true">${ico}</i><span>${verdictText(ctx, g)} <a href="#fv-grade">${t('fv.gDetails')}</a></span></p>`;
}
export const jChip = (j) => (j ? `<span class="fv-j ${j}">${t(j === 'better' ? 'fv.gBetter' : j === 'worse' ? 'fv.gWorse' : 'fv.gEqual')}</span>` : '–');
export function gradePanel(ctx, S0, sel, G, L) {
  const g = gradeOf(S0, sel, G, L), scopeTxt = scopeLabel(ctx, sel);
  const label = (x) => (x.k === 'live' ? [t('fv.gRowLive'), t('fv.gRowLiveSub', { n: x.n, h: n0(x.h) })] : x.k === 'scope' ? [t('fv.gRowScope', { s: scopeTxt }), t('fv.gRowScopeSub', { n: x.n })] : x.k === 'gh' ? [t('fv.gRowGH'), t('fv.gRowGroupSub', { n: x.n, model: modelName(g.act) })] : [t('fv.gRowGD'), t('fv.gRowGroupSub', { n: x.n, model: modelName(g.act) })]);
  const tbl = g.lv.length ? `<div class="tbl fv-tbl full" tabindex="0" role="region" aria-label="${ctx.esc(t('fv.gradeTitle'))}"><table><thead><tr><th>${t('fv.gLevel')}</th><th class="n">${t('fv.gModel')}</th><th class="n">${t('fv.gNaive')}</th><th class="mh">${t('fv.gVerdict')}</th></tr></thead><tbody>${g.lv.map(x => { const [l, s] = label(x); return `<tr><td class="wrap"><span class="lv">${ctx.esc(l)}</span>${x.nat ? ` <span class="fv-chip D">${t('fv.gNat')}</span>` : ''}<span class="lvs">${ctx.esc(s)}</span><span class="m-only">${jChip(x.j)}</span></td><td class="n">${pc(x.a)}</td><td class="n">${pc(x.b)}</td><td class="mh">${jChip(x.j)}</td></tr>`; }).join('')}</tbody></table></div>` : '';
  const ico = g.lvl === 'ok' ? '✓' : g.lvl === 'near' ? '!' : g.lvl === 'bad' ? '✗' : '–';
  return `<div class="panel" id="fv-grade">${head(t('fv.gradeTitle'), t('fv.gradeSub'))}<p class="fv-verdict ${g.lvl}"><i aria-hidden="true">${ico}</i><span>${verdictText(ctx, g)}</span></p>${tbl}<div class="fv-sub">${t('fv.gHow')}</div>${dlRow(true)}</div>`;
}

// ---------- Lernkurve: Wertung je Tag und Modell, Modellvergleich, was das lernende Modell gelernt hat ----------
function curveSvg(ctx, G, L, width) {
  const ev = G?.evals || {}, days = Object.keys(ev).sort().slice(-14), ms = MODEL_ORDER.filter(m => days.some(d => FC.scoreOf(ev[d]?.models?.[m]) != null));
  if (days.length < 2 || !ms.length) return '';
  const W = Math.max(320, Math.min(1100, Math.round(width))), H = 230, pl = 40, pr = 16, pt = 14, pb = 30, vals = days.flatMap(d => ms.map(m => FC.scoreOf(ev[d]?.models?.[m]))).filter(Number.isFinite);
  const top = Math.max(0.1, Math.ceil(Math.max(...vals) * 10 + 0.5) / 10), y = (v) => pt + (H - pt - pb) * (1 - v / top), x = (i) => pl + (days.length === 1 ? 0 : i * (W - pl - pr) / (days.length - 1));
  const grid = [0, 0.25, 0.5, 0.75, 1].map(f => `<line class="gl" x1="${pl}" x2="${W - pr}" y1="${y(top * f).toFixed(1)}" y2="${y(top * f).toFixed(1)}"/><text x="${pl - 5}" y="${(y(top * f) + 4).toFixed(1)}" text-anchor="end">${numFmt(0).format(top * f * 100)} %</text>`).join('');
  const every = Math.max(1, Math.ceil(days.length / (W < 520 ? 4 : 8)));
  const xl = days.map((d, i) => (i % every === 0 || i === days.length - 1 ? `<text x="${x(i).toFixed(1)}" y="${H - 10}" text-anchor="${i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle'}">${ctx.esc(dayTxt(d, { day: 'numeric', month: 'numeric' }))}</text>` : '')).join('');
  const lines = ms.map(m => { let d = '', open = false, dots = '';
    days.forEach((day, i) => { const v = FC.scoreOf(ev[day]?.models?.[m]); if (v == null) { open = false; return; } d += `${open ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`; open = true; dots += `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${m === L?.active ? 3.6 : 2.6}" fill="${MODEL_COLOR[m]}"/>`; });
    return `<path class="${m === L?.active ? 'act' : ''}${m === 'naive' || m === 'week' ? ' nv' : ''}" style="stroke:${MODEL_COLOR[m]}" d="${d}"/>${dots}`; }).join('');
  const keys = ms.map(m => `<span><i class="${m === 'naive' || m === 'week' ? 'nv' : ''}" style="border-color:${MODEL_COLOR[m]}"></i>${m === L?.active ? `<b>${ctx.esc(modelName(m))}</b> (${t('fv.activeTag')})` : ctx.esc(modelName(m))}</span>`).join('');
  // S4.5: Werte je Tag im gemeinsamen Hover-Layer statt <title> an 3-px-Punkten
  const cs = chartSpec({ n: days.length, x, top: pt, bottom: H - pb, head: (i) => dayTxt(days[i]), label: t('fv.curveAria'), colHead: t('ct.dayCol'), cols: ms.map(modelName),
    cell: (i, k) => { const v = FC.scoreOf(ev[days[i]]?.models?.[ms[k]]); return v == null ? '–' : pc(v, 1); },
    rows: (i) => ms.map(m => ({ m, v: FC.scoreOf(ev[days[i]]?.models?.[m]) })).filter(r => r.v != null).map(r => ({ color: MODEL_COLOR[r.m], label: modelName(r.m), value: pc(r.v, 1), sort: -r.v })) });
  return `<div class="fv-keys2">${keys}</div><div class="fv-curve"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${ctx.esc(t('fv.curveAria'))}" ${cs.attrs}>${grid}${lines}${xl}</svg></div>${tableButton(cs.id)}`;
}
function curveTrend(ctx, G, L) {
  const ev = G?.evals || {}, act = L?.active, days = Object.keys(ev).sort().slice(-14).filter(d => FC.scoreOf(ev[d]?.models?.[act]) != null);
  if (!act || !days.length) return '';
  if (days.length < 2) return t('fv.curveOne');
  const d1 = days[0], d2 = days.at(-1), a = FC.scoreOf(ev[d1].models[act]), b = FC.scoreOf(ev[d2].models[act]);
  return t('fv.curveTrend', { model: ctx.esc(modelName(act)), a: pc(a), d1: ctx.esc(dayTxt(d1)), t1: ev[d1].trainDays ?? '–', b: pc(b), d2: ctx.esc(dayTxt(d2)), t2: ev[d2].trainDays ?? '–' });
}
const groupLabel = (ctx, key) => { const [ags, op, ty] = String(key).split('|'), tl = tMap('type', VEHICLE_TYPE_LABEL); return `${ctx.muniName?.(ags) || ags}, ${op}, ${tl[ty] || ty}`; };
function learnedHtml(ctx, L) {
  const x = L?.learn, gain = pc(L?.gates?.adGain ?? FC.GATES.adGain);
  if (!x) return `<h3 class="rp-h3" style="margin:var(--s4) 0 var(--s2);font-size:.875rem">${t('fv.learnedTitle')}</h3><p class="fv-sub">${t('fv.learnedNone')}</p>`;
  const lead = t('fv.learnedLead', { days: n1(x.days), own: n0(x.leanOwn), pool: n0(x.leanPool), mixed: n0(x.mixed), judged: n0(x.judged), share: pc(x.ownShare), eo: pc(x.errOwn), ep: pc(x.errPooled) });
  const state = L.active === 'adaptive' ? t('fv.learnedActive') : t('fv.learnedCandidate', { gain });
  const rows = [...(x.own || []).filter(r => r[1] >= 0.55).map(r => ['own', ...r]), ...(x.pool || []).filter(r => r[1] <= 0.45).map(r => ['pool', ...r])];
  const tbl = rows.length ? `<div class="tbl fv-tbl full" tabindex="0" role="region" aria-label="${ctx.esc(t('fv.learnedTitle'))}"><table><thead><tr><th>${t('fv.colGroup')}</th><th>${t('fv.colLearnsFrom')}</th><th class="n">${t('fv.colOwnW')}</th><th class="n mh">${t('fv.colErrOwn')}</th><th class="n mh">${t('fv.colErrPool')}</th><th class="n mh">${t('fv.colStarts')}</th></tr></thead><tbody>${rows.map(([dir, k, w, eo, ep, y]) => `<tr><td class="wrap">${ctx.esc(groupLabel(ctx, k))}</td><td><span class="fv-chip${dir === 'own' ? ' A' : ''}">${t(dir === 'own' ? 'fv.fromOwn' : 'fv.fromAll')}</span></td><td class="n">${pc(w)}</td><td class="n mh">${pc(eo)}</td><td class="n mh">${pc(ep)}</td><td class="n mh">${n0(y)}</td></tr>`).join('')}</tbody></table></div>` : '';
  return `<h3 class="rp-h3" style="margin:var(--s4) 0 var(--s2);font-size:.875rem">${t('fv.learnedTitle')}</h3><p class="fv-sub" style="margin-top:0">${ctx.esc(lead)} ${ctx.esc(state)}</p>${tbl}<div class="fv-sub">${t('fv.learnedNote')}</div>`;
}
/** Letzter reifer Prüftag: aktives Modell gegen „wie gestern“ je Fahrzeugart und Gruppengröße (die Gesamtwertung ist nach Volumen gewichtet) */
function partsHtml(ctx, G, L) {
  const ev = G?.evals || {}, act = L?.active, d = Object.keys(ev).sort().filter(x => mature(G, x) && ev[x]?.models?.[act]?.byType && ev[x]?.models?.naive?.byType).at(-1);
  if (!d) return '';
  const A = ev[d].models[act], N = ev[d].models.naive, tl = tMap('type', VEHICLE_TYPE_LABEL);
  const rows = [...Object.keys(A.byType).filter(k => A.byType[k][2] > 0).sort((a, b) => A.byType[b][2] - A.byType[a][2]).map(k => [tl[k] || k, A.byType[k], N.byType[k]]),
    ...['L', 'M', 'S'].filter(k => A.bySize?.[k]?.[2] > 0).map(k => [t(`fv.size${k}`), A.bySize[k], N.bySize?.[k]])];
  const sc = (x) => (x ? (x[0] + x[1]) / 2 : null);
  return `<h3 class="rp-h3" style="margin:var(--s4) 0 var(--s2);font-size:.875rem">${t('fv.partsTitle')}</h3><div class="tbl fv-tbl full" tabindex="0" role="region" aria-label="${ctx.esc(t('fv.partsTitle'))}"><table><thead><tr><th>${t('fv.colPart')}</th><th class="n mh">${t('fv.colStarts')}</th><th class="n">${t('fv.gModel')}</th><th class="n">${t('fv.gNaive')}</th><th class="mh">${t('fv.gVerdict')}</th></tr></thead><tbody>${rows.map(([l, a, n]) => `<tr><td class="wrap"><span class="lv">${ctx.esc(l)}</span><span class="m-only">${jChip(judge(sc(a), sc(n)))}</span></td><td class="n mh">${n0(a[2])}</td><td class="n"><span class="v2">${pc(a[0])}</span><span class="v2">${pc(a[1])}</span></td><td class="n">${n ? `<span class="v2">${pc(n[0])}</span><span class="v2">${pc(n[1])}</span>` : '–'}</td><td class="mh">${jChip(judge(sc(a), sc(n)))}</td></tr>`).join('')}</tbody></table></div><div class="fv-sub">${t('fv.partsNote', { d: ctx.esc(dayTxt(d)), model: ctx.esc(modelName(act)) })}</div>`;
}
/** Umgebung und Langzeitgedächtnis: was gelernt ist (Faktor mit 90-%-Bereich), wie viel Erfahrung dahintersteht, ob es im Modell ist */
const fx = (x) => (x == null || !Number.isFinite(x) ? '–' : `×${numFmt(2).format(x)}`);
export function envHtml(ctx, L, { title = true } = {}) {
  const M = L?.memory, E = L?.env, esc = ctx.esc;
  if (!M && !E) return '';
  const wxUsed = !!L?.weather?.used, act = new Set(E?.active || []), ready = new Set(E?.ready || []);
  const rows = (FC.EFFECTS || []).map(k => {
    const e = M?.effects?.[k] || {}, isWx = ['cold', 'warm', 'rain'].includes(k), inv = k === 'cold'; // kalt: Merkmal ≤ 0, „10 K kälter“ = exp(−b)
    const f = e.b == null ? null : Math.exp(inv ? -e.b : e.b), lo = e.b == null ? null : inv ? 1 / e.hi : e.lo, hi = e.b == null ? null : inv ? 1 / e.lo : e.hi;
    const sup = E?.support?.[k], n = isWx ? e.n : (sup ? sup.rows + sup.memRows : e.n), days = isWx ? e.days : (sup ? sup.days + sup.memDays : e.days);
    let st = isWx ? (wxUsed ? 'on' : e.b == null ? 'none' : 'wait') : act.has(k) ? 'on' : ready.has(k) ? 'ready' : n > 0 ? 'wait' : 'none';
    // Lernphase: erfasst, aber noch zurückgehalten (Sport, Veranstaltungen, Volksfeste ab E.pendingFrom) – Erfahrung = was sie kennzeichnen würden
    if (!isWx && st === 'none' && sup?.pending?.rows) return { k, f, lo, hi, n: sup.pending.rows, days: sup.pending.days, st: 'held' };
    return { k, f, lo, hi, n, days, st };
  });
  const heldFrom = E?.pendingFrom && Number.isFinite(Date.parse(E.pendingFrom)) ? dateFmt({ day: 'numeric', month: 'numeric', timeZone: TZ }).format(new Date(E.pendingFrom)) : '–';
  const chip = (st) => `<span class="fv-chip${st === 'on' ? ' A' : st === 'ready' || st === 'held' ? ' B' : ''}">${t(`fv.envSt.${st}`, { d: heldFrom })}</span>`;
  const tbl = `<div class="tbl fv-tbl full" tabindex="0" role="region" aria-label="${esc(t('fv.envTitle'))}"><table><thead><tr><th>${t('fv.envColWhat')}</th><th class="n">${t('fv.envColEffect')}</th><th class="n mh">${t('fv.envColRange')}</th><th class="n mh">${t('fv.envColExp')}</th><th>${t('fv.envColState')}</th></tr></thead><tbody>${rows.map(r => `<tr><td class="wrap">${t(`fv.env.${r.k}`)}</td><td class="n">${fx(r.f)}</td><td class="n mh">${r.lo == null ? '–' : `${fx(r.lo)} – ${fx(r.hi)}`}</td><td class="n mh">${t('fv.envExp', { n: n0(r.n), d: n1(r.days) })}</td><td>${chip(r.st)}</td></tr>`).join('')}</tbody></table></div>`;
  const S = E?.sources || {}, up = (S.upcoming || []).map(e => `${esc(e.titel || t(`fv.envArt.${e.art}`))} (${esc(String(e.von))}${e.bis && e.bis !== e.von ? `–${esc(String(e.bis))}` : ''})`).join(', ');
  const lead = M ? t('fv.envLead', { since: M.since ? esc(dayTxt(M.since, { day: 'numeric', month: 'short', year: 'numeric' })) : '–', days: n1(M.days), old: n1(M.oldDays), hl: M.halfLifeDays }) : '';
  const src = t('fv.envSources', { warn: S.warnAt ? timeTxt(S.warnAt) : t('fv.envNever'), road: S.roadAt ? timeTxt(S.roadAt) : t('fv.envNever'), n: n0(S.curated || 0) }) + (up ? ` ${t('fv.envUpcoming')} ${up}` : '');
  return `${title ? `<h3 class="rp-h3" style="margin:var(--s4) 0 var(--s2);font-size:.875rem">${t('fv.envTitle')}</h3>` : ''}<p class="fv-sub" style="margin-top:0">${lead}</p>${tbl}<div class="fv-sub">${src}</div><div class="fv-sub">${t('fv.envNote', { rows: FC.GATES.ctxMinRows, days: FC.GATES.ctxMinDays })}</div>`;
}
export function curvePanel(ctx, G, L, width) {
  const race = raceOf(G, L), cand = race.filter(r => r.m !== 'naive'), best = cand.length ? Math.min(...cand.map(r => r.sc.v)) : null, maxS = Math.max(0.01, ...race.map(r => r.sc.v));
  const raceHtml = race.length ? `<h3 class="rp-h3" style="margin:var(--s4) 0 var(--s2);font-size:.875rem">${t('fv.raceTitle')}</h3><div class="tbl fv-tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('fv.raceTitle'))}"><table><thead><tr><th>${t('fv.colModel')}</th><th class="n">${t('fv.colScore')}</th><th class="n mh">${t('fv.colGD')}</th><th class="n mh">${t('fv.colGH')}</th><th class="n mh">${t('fv.colBias')}</th><th class="n mh">${t('fv.colCover')}</th><th class="n mh">${t('fv.colDays')}</th></tr></thead><tbody>${race.map(r => `<tr><td>${ctx.esc(modelName(r.m))}${r.m === L?.active ? ` <span class="fv-chip B">${t('fv.activeTag')}</span>` : ''}${r.m !== 'naive' && r.sc.v === best ? ` <span class="fv-chip A">${t('fv.bestTag')}</span>` : ''}</td><td class="n bars"><span class="t">${pc(r.sc.v)}</span><span class="fv-bar${r.m === 'naive' ? ' n' : ''}" style="width:${Math.round(r.sc.v / maxS * 110)}px"></span></td><td class="n mh">${pc(r.gd?.v)}</td><td class="n mh">${pc(r.gh?.v)}</td><td class="n mh">${sg(r.bias?.v, 1)}</td><td class="n mh">${pc(r.cov?.v)}</td><td class="n mh">${r.sc.n}</td></tr>`).join('')}</tbody></table></div><div class="fv-sub">${t('fv.raceNote')}</div>` : '';
  const svg = curveSvg(ctx, G, L, width), trend = curveTrend(ctx, G, L);
  return `<div class="panel" id="fv-curve">${head(t('fv.curveTitle'), t('fv.curveSub'), allTag(ctx))}${trend ? `<p class="fv-lead" style="margin-top:var(--s2)">${trend}</p>` : ''}${svg}${raceHtml}${partsHtml(ctx, G, L)}${learnedHtml(ctx, L)}${envHtml(ctx, L)}</div>`;
}

// ---------- Algorithmus herunterladen: Steckbrief (Markdown, aus den aktuellen Daten) und Quellcode der Engine ----------
const ENGINE_FILES = ['pulse-forecast.js', 'pulse-context.js', 'pulse-econ.js', 'pulse-track.js', 'pulse-core.js'];
export function dlRow(short = false) {
  const files = short ? ENGINE_FILES.slice(0, 1) : ENGINE_FILES;
  return `<div class="fv-dl"><span>${t('fv.dlLead')}</span><button type="button" class="chip" data-fv-dl="md">${t('fv.dlMd')}</button>${files.map(f => `<button type="button" class="chip" data-fv-dl="code" data-f="${f}">${f === 'pulse-forecast.js' ? t('fv.dlEngine') : f}</button>`).join('')}${short ? `<span>${t('fv.dlMore')} <a href="#prognose-basis">${t('fv.segBasis')}</a></span>` : ''}</div>`;
}
function saveText(name, text, type) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.style.display = 'none';
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
const mdEsc = (v) => String(v ?? '–').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const mdTable = (head, rows) => `| ${head.map(mdEsc).join(' | ')} |\n|${head.map(() => ' --- ').join('|')}|\n${rows.map(r => `| ${r.map(mdEsc).join(' | ')} |`).join('\n')}\n`;
/** Parameter der Prognose (aus dem Code) – Grundlagen-Tabelle und Steckbrief */
export function paramRows(L) {
  const gates = { ...FC.GATES, ...(L?.gates || {}) };
  return [
    ['minTrainDays', gates.minTrainDays, t('fv.pMinTrain')], ['minEvalDays', gates.minEvalDays, t('fv.pMinEval')], ['hourMinObserved', gates.hourMinObserved, t('fv.pHourMin')],
    ['wxTempRangeK', gates.wxTempRangeK, t('fv.pWxRange')], ['wxRainDays', gates.wxRainDays, t('fv.pWxRain')], ['wxMissingMax', gates.wxMissingMax, t('fv.pWxMiss')], ['wxGain', gates.wxGain, t('fv.pWxGain')],
    ['adGain', gates.adGain ?? FC.GATES.adGain, t('fv.pAdGain')], ['evalWindow', gates.evalWindow, t('fv.pWindow')], ['minEvalTrainDays', gates.minEvalTrainDays ?? FC.GATES.minEvalTrainDays, t('fv.pMinEvalTrain')],
    ['liveMinHours', gates.liveMinHours ?? FC.GATES.liveMinHours, t('fv.pLiveMin')], ['wxShareDay', gates.wxShareDay ?? FC.GATES.wxShareDay, t('fv.pWxShare')],
    ['HYBRID.k', FC.HYBRID.k, t('fv.pHybK')], ['HYBRID.maxBack', FC.HYBRID.maxBack, t('fv.pHybBack')],
    ['ctxMinRows', gates.ctxMinRows ?? FC.GATES.ctxMinRows, t('fv.pCtxRows')], ['ctxMinDays', gates.ctxMinDays ?? FC.GATES.ctxMinDays, t('fv.pCtxDays')], ['MEMORY.halfLifeDays', FC.MEMORY.halfLifeDays, t('fv.pMemHl')], ['POOLED.typeHour', String(FC.POOLED.typeHour), t('fv.pTypeHour')], ['POOLED.hier', String(FC.POOLED.hier), t('fv.pHier')], ['POOLED.halfLife', FC.POOLED.halfLife, t('fv.pHalfLife7')],
    ['FEEDBACK.halfLifeDays', FC.FEEDBACK.halfLifeDays, t('fv.pHalfLife')], ['FEEDBACK.kBlend', FC.FEEDBACK.kBlend, t('fv.pKBlend')], ['FEEDBACK.sharp', FC.FEEDBACK.sharp, t('fv.pSharp')],
    ['SERIES_KEEP_DAYS', FC.SERIES_KEEP_DAYS, t('fv.pKeep')], ['SERIES_MIN.ags', FC.SERIES_MIN.ags, t('fv.pSerAgs')], ['SERIES_MIN.group', FC.SERIES_MIN.group, t('fv.pSerGroup')], ['SERIES_MIN.groupMax', FC.SERIES_MIN.groupMax, t('fv.pSerMax')],
    ['baseH', OPS.baseH, t('fv.pBase')], ['minPerSpot', OPS.minPerSpot, t('fv.pMinSpot')], ['maxPerSpot', OPS.maxPerSpot, t('fv.pMaxSpot')], ['spotRadiusM', OPS.spotRadiusM, t('fv.pRadius')], ['horizonH', OPS.horizonH, t('fv.pHorizon')], ['prelimH', OPS.prelimH, t('fv.pPrelim')],
    ['RATE.classA', SP.RATE.classA, t('fv.pClassA')], ['RATE.classB', SP.RATE.classB, t('fv.pClassB')], ['RATE.linkM', SP.RATE.linkM, t('fv.pLink')], ['DEMAND_DAYS', DEMAND_DAYS, t('fv.pDemandDays')],
  ];
}
export const NOT_KEYS = ['nTrain', 'nStrike', 'nEvents', 'nRoad', 'nOp', 'nZones'];
// Stand je Einfluss (11.11.2026): erfasst = wird je Tag gesammelt (eingriffe.json, train/), wirkt aber noch nicht; teilweise = nur ein Teil abgedeckt; fehlt = keine offene Quelle
export const NOT_STATE = { nTrain: 'part', nStrike: 'part', nEvents: 'part', nRoad: 'part', nOp: 'done', nZones: 'done' };
export function steckbrief(ctx, S0, L, G, sel) {
  const g = gradeOf(S0, sel, G, L), scopeTxt = scopeLabel(ctx, sel), gates = { ...FC.GATES, ...(L?.gates || {}) }, now = dateFmt({ dateStyle: 'medium', timeStyle: 'short', timeZone: TZ }).format(new Date());
  const strip = (h) => String(h).replace(/<[^>]+>/g, '');
  const levelName = (x) => (x.k === 'live' ? t('fv.gRowLive') : x.k === 'scope' ? t('fv.gRowScope', { s: scopeTxt }) : x.k === 'gh' ? t('fv.gRowGH') : t('fv.gRowGD'));
  const jTxt = (j) => (j ? t(j === 'better' ? 'fv.gBetter' : j === 'worse' ? 'fv.gWorse' : 'fv.gEqual') : '–');
  const out = [];
  out.push(`# ${t('fv.mdTitle')}\n`, `${t('fv.mdStand', { time: now, data: timeTxt(L?.generatedAt), url: location.href.split('#')[0] })}\n`);
  out.push(`## ${t('fv.mdVerdict')}\n`, `${strip(verdictText({ esc: (x) => x }, g))}\n`);
  if (g.lv.length) out.push(mdTable([t('fv.gLevel'), t('fv.gModel'), t('fv.gNaive'), t('fv.gVerdict')], g.lv.map(x => [levelName(x), pc(x.a), pc(x.b), jTxt(x.j)])), `\n${strip(t('fv.gHow'))}\n`);
  out.push(`## ${t('fv.mdWhat')}\n`, `${t('fv.mdWhatTxt', { g: n0(L?.learn?.groups ?? Object.keys(L?.groups || {}).length), m: n0(Object.keys(L?.municipalities || {}).length) })}\n`);
  out.push(`## ${t('fv.mdModels')}\n`, '```\n' + `${t('fv.formula')}\n` + '```\n');
  for (const [m, k] of [['profile', 'fv.mProfile'], ['pooled', 'fv.mPooled'], ['pooledWx', 'fv.mPooledWx'], ['adaptive', 'fv.mAdaptive'], ['hybrid', 'fv.mHybrid'], ['blend', 'fv.mBlend'], ['chronos', 'fv.mChronos'], ['naive', 'fv.mNaive']]) out.push(`- **${modelName(m)}**${m === L?.active ? ` (${t('fv.activeTag')})` : ''}: ${m === 'blend' ? blendTxt(L) : t(k, { hl: FC.FEEDBACK.halfLifeDays, k: FC.HYBRID.k, back: FC.HYBRID.maxBack, min: L?.external?.chronos?.minStarts ?? 20 })}`);
  out.push('', `${t('fv.chooseRule', { min: gates.minEvalDays, win: gates.evalWindow, gain: pc(gates.wxGain), again: pc(gates.adGain ?? FC.GATES.adGain), mt: gates.minEvalTrainDays ?? FC.GATES.minEvalTrainDays })}\n`, `${t('fv.mdActive', { model: L?.active ? modelName(L.active) : '–', reason: (L?.reason || L?.decision?.why) ? fcReason(L) : '–' })}\n`);
  const x = L?.learn;
  out.push(`## ${t('fv.mdLearn')}\n`, `${t('fv.mAdaptive', { hl: FC.FEEDBACK.halfLifeDays })}\n`);
  if (x) { out.push(`${t('fv.learnedLead', { days: n1(x.days), own: n0(x.leanOwn), pool: n0(x.leanPool), mixed: n0(x.mixed), judged: n0(x.judged), share: pc(x.ownShare), eo: pc(x.errOwn), ep: pc(x.errPooled) })}\n`);
    const rows = [...(x.own || []).map(r => [t('fv.fromOwn'), ...r]), ...(x.pool || []).map(r => [t('fv.fromAll'), ...r])];
    if (rows.length) out.push(mdTable([t('fv.colGroup'), t('fv.colLearnsFrom'), t('fv.colOwnW'), t('fv.colErrOwn'), t('fv.colErrPool'), t('fv.colStarts')], rows.map(([dir, k, w, eo, ep, y]) => [groupLabel(ctx, k), dir, pc(w), pc(eo), pc(ep), n0(y)])));
  } else out.push(`${t('fv.learnedNone')}\n`);
  if (L?.memory) { out.push(`\n## ${t('fv.envTitle')}\n`, `${strip(envHtml({ esc: (x) => x }, L, { title: false }).replace(/<table>[\s\S]*<\/table>/, '').replace(/<\/(p|div)>/g, '\n'))}\n`);
    out.push(mdTable([t('fv.envColWhat'), t('fv.envColEffect'), t('fv.envColRange'), t('fv.envColExp')], (FC.EFFECTS || []).map(k => { const e = L.memory.effects?.[k] || {}, inv = k === 'cold'; return [t(`fv.env.${k}`), e.b == null ? '–' : fx(Math.exp(inv ? -e.b : e.b)), e.b == null ? '–' : `${fx(inv ? 1 / e.hi : e.lo)} – ${fx(inv ? 1 / e.lo : e.hi)}`, t('fv.envExp', { n: n0(e.n), d: n1(e.days) })]; }))); }
  const ev = G?.evals || {}, evRows = [];
  for (const d of Object.keys(ev).sort()) for (const m of MODEL_ORDER) { const r = ev[d]?.models?.[m]; if (r) evRows.push([d, ev[d].trainDays ?? '–', modelName(m), pc(FC.scoreOf(r), 1), pc(r.wapeGD, 1), pc(r.wapeGH, 1), sg(r.bias, 1), pc(r.cover80)]); }
  out.push(`\n## ${t('fv.mdEval')}\n`, `${strip(t('fv.raceNote'))}\n`, evRows.length ? mdTable([t('fv.colDay'), t('fv.colTrain'), t('fv.colModel'), t('fv.colScore'), t('fv.colGD'), t('fv.colGH'), t('fv.colBias'), t('fv.colCover')], evRows) : `${t('fv.accNone')}\n`);
  const lvAll = (L?.live || []).slice().reverse();
  if (lvAll.length) out.push(`\n## ${t('fv.liveTitle')}\n`, mdTable([t('fv.colIssued'), t('fv.colModel'), t('fv.colHours'), t('fv.colErrOp'), t('fv.colNaive'), t('fv.colSkill')], lvAll.map(x => [dateFmt({ dateStyle: 'short', timeStyle: 'short', timeZone: TZ }).format(new Date(x.at)), x.model ? modelName(x.model) : '–', x.hours ?? 24, pc(x.wapeOpH), pc(x.naiveOpH), x.skill == null ? '–' : sg(x.skill)])), `\n${strip(t('fv.liveNote', { min: FC.GATES.liveMinHours }))}\n`);
  const pr = S0 ? accRows(S0, sel, G) : [];
  out.push(`\n## ${t('fv.mdPlan', { scope: scopeTxt })}\n`, pr.length ? mdTable([t('fv.colDay'), t('fv.colIst'), t('fv.colPlan'), t('fv.colBias'), t('fv.colErr'), t('fv.colNaive'), t('fv.colSkill'), t('fv.colTrain')], pr.map(r => [r.d, n0(r.ist), n0(r.plan), sg(r.bias, 1), pc(r.wape), pc(r.naive), r.skill == null ? '–' : sg(r.skill), r.train ?? '–'])) : `${t('fv.accNone')}\n`, `\n${strip(t('fv.accNote'))}\n`);
  out.push(`\n## ${t('fv.mdParams')}\n`, mdTable([t('fv.colParam'), t('fv.colValue'), t('fv.colEffect')], paramRows(L).map(([k, v, d]) => [k, v, d])));
  out.push(`\n## ${t('fv.mdNot')}\n`, NOT_KEYS.map(k => `- ${t(`fv.${k}`)}`).join('\n'), `\n\n${strip(t('fv.notNote'))}\n`);
  out.push(`\n## ${t('fv.mdCode')}\n`, `${t('fv.mdCodeTxt', { repo: ctx.CFG?.REPO || '' })}\n`);
  return out.join('\n');
}
export function bindDl(el, ctx, S0, L, G, sel) {
  el.querySelectorAll('[data-fv-dl="md"]').forEach(b => b.addEventListener('click', () => saveText(`prognose-algorithmus_${S0?.today || 'stand'}.md`, steckbrief(ctx, S0, L, G, sel), 'text/markdown;charset=utf-8')));
  el.querySelectorAll('[data-fv-dl="code"]').forEach(b => b.addEventListener('click', async () => {
    const f = b.dataset.f; if (!ENGINE_FILES.includes(f)) return;
    try {
      // unverändert kopiert (scripts/build-web.mjs, S3.4); seit dem Schnitt in Teile ist die Datei eine Fassade: die Teile (export * from …) kommen mit
      const get = async (name) => { const r = await fetch(new URL(`engine/${name}`, document.baseURI), { cache: 'no-store' }); if (!r.ok) throw new Error(String(r.status)); return (await r.text()).replace(/(from '\.\/[\w-]+\.js)\?v=[\w]+'/g, "$1'"); }; // Versionsanhang des Builds entfernen = Datei wie im Repo
      const main = await get(f), parts = [...main.matchAll(/^export \* from '\.\/(pulse-[\w-]+\.js)';$/gm)].map(m => m[1]);
      const texts = await Promise.all(parts.map(get));
      saveText(f, main, 'text/javascript;charset=utf-8'); parts.forEach((p, i) => saveText(p, texts[i], 'text/javascript;charset=utf-8'));
    } catch { window.open(`${ctx.CFG?.REPO || ''}/blob/main/lib/${f}`, '_blank', 'noopener'); }
  }));
}

// ---------- Spots ----------
const COLORS = HIT;
export function spotsPanelShell(ctx, s0) { return `<div class="panel" id="fv-spots">${head(t('fv.spotsTitle'), t('fv.spotsSub'))}<div id="fv-spots-body">${s0 || ''}</div></div>`; }
export async function paintSpots(el, ctx, s, S0, L, sel) {
  const box = el.querySelector('#fv-spots-body'); if (!box) return; const tok = s.tok;
  const ags = ctx.state.scope, land = ctx.state.latest?.municipalities?.[ags]?.state, csvB = el.querySelector('[data-fv-csv="spots"]');
  s.rated = null; if (csvB) csvB.disabled = true;
  if (!ags || ags === 'DE' || !land) {
    const top = Object.entries(S0.days[S0.tomorrow] || {}).filter(([k]) => k.startsWith('ags:')).map(([k, e]) => [k.slice(4), sum(e.l || e.p || [])]).sort((a, b) => b[1] - a[1]).slice(0, 12);
    box.innerHTML = `<div class="empty"><b>${t('fv.spotsPick')}</b>${t('fv.spotsPickHint')}</div>${top.length ? `<div class="fv-munis">${top.map(([a, v]) => `<button class="chip" data-ags="${ctx.esc(a)}">${ctx.esc(ctx.muniName?.(a) || a)}, ${n0(v)}</button>`).join('')}</div>` : ''}`;
    box.querySelectorAll('button[data-ags]').forEach(b => b.addEventListener('click', () => ctx.setScope?.(b.dataset.ags))); return;
  }
  box.innerHTML = `<div class="note small">${t('fv.spotsLoading')}</div>`;
  const [fleet, dem, grp, quota] = await Promise.all([loadFleet(ctx, land), loadDemand(ctx, land, ags), loadGroups(ctx), Promise.resolve(ctx.loadOnce?.('quota', 'stations-quota.json')).catch(() => null)]);
  if (tok !== s.tok) return;
  if (!fleet) { box.innerHTML = `<div class="empty"><b>${t('fv.spotsNoFleet')}</b>${t('fv.spotsNoFleetHint')}</div>`; return; }
  // nur Anbieter der gewählten Fahrzeugfamilie (Audit 11.11.2026, UXP-04: vorher teilAuto als Standard in Tübingen, „75 Fahrzeuge fehlen“
  // mit Scooter-Nachfrage); Arten je Anbieter aus den Fahrzeugen und den Gruppen des Sammler-Stands (Stationen haben keine Art)
  const fam = famNow(ctx), tys = new Map();
  for (const v of fleet.vehicles) if (v.ags === ags) { let m = tys.get(v.operator); if (!m) tys.set(v.operator, m = new Set()); m.add(v.type); }
  for (const k of Object.keys(ctx.state?.latest?.groups || {})) { const [a, o, y] = k.split('|'); if (a !== ags) continue; let m = tys.get(o); if (!m) tys.set(o, m = new Set()); m.add(y); }
  const famOk = (o) => { const m = tys.get(o); return m ? [...m].some(y => familyOf(y) === fam) : fam === 'micro'; };
  const ops = [...new Set([...fleet.vehicles.filter(v => v.ags === ags).map(v => v.operator), ...fleet.stations.filter(x => x.ags === ags).map(x => x.operator)])].filter(o => o && famOk(o));
  const cnt = (o) => fleet.vehicles.filter(v => v.ags === ags && v.operator === o && familyOf(v.type) === fam).length + fleet.stations.filter(x => x.ags === ags && x.operator === o).length;
  ops.sort((a, b) => cnt(b) - cnt(a) || a.localeCompare(b, 'de'));
  const want = ctx.state.operator !== 'all' ? ctx.state.operator : s.op;
  const op = ops.includes(want) ? want : ops[0]; s.op = op;
  if (!op) { box.innerHTML = `<div class="empty"><b>${t('fv.spotsNoOp')}</b></div>`; return; }
  const gp = groupPlaces(grp?.docs || [], { ags });
  // Prognose des Anbieters in der Gemeinde: Summe der Gruppen (alle Arten oder die gewählte Art) aus latest.json, ab der nächsten vollen Stunde
  const ty = ctx.state.type !== 'all' ? ctx.state.type : null, day24 = new Array(24).fill(0); let hasFc = false;
  for (const [k, g] of Object.entries(L.groups || {})) { const [a, o, y] = k.split('|'); if (a === ags && o === op && (!ty || y === ty)) { hasFc = true; g.start.forEach((v, h) => { day24[h] += v; }); } }
  const R = SP.rateSpots(fleet, { ags, op, demand: dem?.model, groups: gp, quota, fc: hasFc ? { day24 } : null, type: ty || 'all' });
  s.rated = R; s.ratedAgs = ags; setLastRated({ ags, op, R }); if (csvB) csvB.disabled = !R.items.length;
  const T = R.total, opSel = ctx.state.operator !== 'all' ? '' : `<label>${t('fv.operator')} <select id="fv-op">${ops.map(o => `<option value="${ctx.esc(o)}"${o === op ? ' selected' : ''}>${ctx.esc(o)}</option>`).join('')}</select></label>`;
  const lead = !R.items.length ? t('fv.spotsNone', { op: ctx.esc(op) })
    : `<p class="fv-lead">${t('fv.spotsLead', { spots: `<b>${n0(T.spots)}</b>`, miss: `<b>${n0(T.missing)}</b>`, nMiss: `<b>${n0(T.spotsMissing)}</b>`, imp: `<b>${n0(T.missingAB)}</b>`, op: ctx.esc(op) })}</p>`;
  const tiles = R.items.length ? `<div class="tiles">${tile(t('fv.tSpots'), n0(T.spots), t('fv.tSpotsSub', { d: T.deploy, p: T.park, b: T.both }))}${tile(t('fv.tClasses'), `${T.byCls.A}, ${T.byCls.B}, ${T.byCls.C}`, t('fv.tClassesSub', { d: T.byCls.D }))}${tile(t('fv.tTarget'), n0(T.target), t('fv.tTargetSub', { have: n0(T.have) }), T.missing ? 'warn' : 'ok')}${tile(t('fv.tMissing'), n0(T.missing), t('fv.tMissingSub', { n: T.spotsMissing, ab: T.importantMissing }), T.missing ? 'warn' : 'ok')}</div>` : '';
  const rows = R.items.slice(0, s.rows), maxI = 1;
  const kindTxt = (x) => (x.kind === 'both' ? t('fv.kBoth') : x.kind === 'deploy' ? t('fv.kDeploy') : t('fv.kPark'));
  const info = (x) => [x.deploy ? t('fv.infDeploy', { n: x.deploy.count, avg: n1(x.deploy.avg) }) : '', x.deploy?.last ? t('fv.infLast', { d: dateFmt({ day: '2-digit', month: '2-digit', timeZone: TZ }).format(new Date(x.deploy.last)) }) : '', x.park?.emptyShare != null && x.park.runs >= SP.MIN_RUNS ? t('fv.infEmpty', { p: pc(x.park.emptyShare) }) : '', x.sharedWith ? t('fv.infShared', { n: x.sharedWith }) : ''].filter(Boolean).join(', ');
  const tbl = R.items.length ? `<div class="tbl fv-tbl" tabindex="0" role="region" aria-label="${ctx.esc(t('fv.spotsTitle'))}"><table><thead><tr><th class="n">#</th><th>${t('fv.colSpot')}</th><th>${t('fv.colClass')}</th><th class="n">${t('fv.colImp')}</th><th class="n">${t('fv.colExp')}</th><th class="n">${t('fv.colTarget')}</th><th class="n">${t('fv.colHave')}</th><th class="n">${t('fv.colMissing')}</th><th>${t('fv.colInfo')}</th></tr></thead><tbody>${rows.map(x => `<tr data-i="${x.rank - 1}"><td class="n">${x.rank}</td><td><button class="fv-link" data-i="${x.rank - 1}">${ctx.esc(x.label || `${x.lat.toFixed(4)}, ${x.lon.toFixed(4)}`)}</button> <span class="fv-chip">${kindTxt(x)}</span></td><td><span class="fv-chip ${x.cls}">${x.cls}</span></td><td class="n bars"><span class="t">${x.cls === 'D' ? '–' : pc(x.importance)}</span><span class="fv-bar" style="width:${Math.round(x.importance / maxI * 80)}px"></span></td><td class="n">${x.expected24 == null ? '–' : n0(x.expected24)}</td><td class="n">${x.cls === 'D' ? '–' : n0(x.targetFc)}</td><td class="n">${n0(x.have)}</td><td class="n"><span class="fv-miss${x.missing ? '' : ' z'}">${x.missing ? n0(x.missing) : '0'}</span></td><td class="sub-line" style="white-space:normal;min-width:18ch">${ctx.esc(info(x))}</td></tr>`).join('')}</tbody></table></div>${R.items.length > rows.length ? `<p><button class="chip" id="fv-more">${t('fv.more', { n: R.items.length - rows.length })}</button></p>` : ''}` : '';
  const notes = [R.prelim ? t('fv.nPrelim', { h: n0(R.hours) }) : '', !R.fc ? t('fv.nNoFc') : '', !dem?.model ? t('fv.nNoDemand') : '', ops.length > 1 ? '' : ''].filter(Boolean).join(' ');
  box.innerHTML = `${opSel ? `<div class="fv-ctl">${opSel}</div>` : ''}${lead}${tiles}${R.items.length ? `<div class="fv-map" id="fv-map" role="region" aria-label="${ctx.esc(t('fv.mapAria'))}"></div><div class="fv-keys"><span><i style="background:${COLORS.miss}"></i>${t('fv.keyMiss')}</span><span><i style="background:${COLORS.ok}"></i>${t('fv.keyOk')}</span><span><i style="background:${COLORS.over}"></i>${t('fv.keyOver')}</span><span><i style="background:${COLORS.none}"></i>${t('fv.keyNone')}</span><span>${t('fv.keySize')}</span></div>` : ''}${tbl}<div class="fv-sub">${t('fv.spotsNote', { r: R.radiusM, h: R.horizonH })} ${ctx.esc(notes)}</div>`;
  box.querySelector('#fv-op')?.addEventListener('change', (e) => { s.op = e.target.value; s.rows = SPOT_ROWS; paintSpots(el, ctx, s, S0, L, sel); });
  box.querySelector('#fv-more')?.addEventListener('click', () => { s.rows += 50; paintSpots(el, ctx, s, S0, L, sel); });
  if (R.items.length) drawMap(box.querySelector('#fv-map'), ctx, s, R, rows);
}
function drawMap(mapEl, ctx, s, R, rows) {
  const Lf = globalThis.L; if (!Lf || !mapEl) return;
  if (s.map) { try { s.map.remove(); } catch { /* weg */ } s.map = null; }
  const map = s.map = Lf.map(mapEl, { zoomControl: true, preferCanvas: true });
  Lf.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: t('app.openstreetmapContributors') }).addTo(map);
  const pts = [], layer = Lf.layerGroup().addTo(map), byRank = new Map();
  for (const x of R.items) {
    const c = x.cls === 'D' ? COLORS.none : x.missing > 0 ? COLORS.miss : x.surplus > 0 ? COLORS.over : COLORS.ok;
    const m = Lf.circleMarker([x.lat, x.lon], { radius: 5 + Math.round(x.importance * 11), color: c, weight: 2, fillColor: c, fillOpacity: x.cls === 'D' ? 0.25 : 0.55 }).addTo(layer);
    m.bindPopup(`<b>${ctx.esc(x.label || `${x.lat.toFixed(4)}, ${x.lon.toFixed(4)}`)}</b><br>${ctx.esc(t('fv.popup', { cls: x.cls, imp: pc(x.importance), target: x.cls === 'D' ? '–' : n0(x.targetFc), have: n0(x.have), miss: n0(x.missing) }))}`);
    byRank.set(x.rank, m); pts.push([x.lat, x.lon]);
  }
  s.markers = byRank;
  map.invalidateSize();
  if (pts.length) map.fitBounds(pts, { padding: [24, 24], maxZoom: 16, animate: false }); else map.setView([51.1, 10.4], 6);
  setTimeout(() => { map.invalidateSize(); if (pts.length) map.fitBounds(pts, { padding: [24, 24], maxZoom: 16, animate: false }); }, 150);
  try { mapKeys(map); } catch { /* optional */ }
  mapEl.closest('#fv-spots-body')?.querySelectorAll('button.fv-link[data-i]').forEach(b => b.addEventListener('click', () => { const x = rows[+b.dataset.i]; if (!x) return; map.setView([x.lat, x.lon], Math.max(map.getZoom(), 16)); byRank.get(x.rank)?.openPopup(); mapEl.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); }));
}

// ---------- Kopfleiste: gewählte Filter sichtbar und einzeln lösbar (die Auswahl selbst steht in der Filterleiste oben) ----------
export function topBar(ctx, sel, extra = '') {
  const { esc } = ctx, S1 = ctx.state, ty = tMap('type', VEHICLE_TYPE_LABEL);
  const a = !!sel.ags && sel.ags !== 'DE', o = S1.operator !== 'all', y = S1.type !== 'all', ign = !!sel.ignored;
  const pill = (kind, label, val, on, off) => `<span class="fv-pill${on ? '' : ' dim'}${off ? ' ign' : ''}"${off ? ` title="${esc(t('fv.nIgnored'))}"` : ''}>${label}: <b>${esc(val)}</b>${on ? `<button type="button" data-fv-clear="${kind}" aria-label="${esc(t('fv.clearFilter', { f: label }))}">×</button>` : ''}</span>`;
  const fam = famNow(ctx), famTog = `<div class="fv-tog fv-fam" role="group" aria-label="${esc(t('fv.famAria'))}">${FC.FAMILIES.map(f => `<button type="button" data-fv-fam="${f}" aria-pressed="${f === fam}">${t(`fv.fam.${f}`)}</button>`).join('')}</div>`;
  return `<div class="fv-top" role="group" aria-label="${esc(t('fv.topAria'))}">${famTog}<span class="lbl">${t('fv.filter')}</span>`
    + pill('scope', t('fv.fArea'), a ? (ctx.muniName?.(sel.ags) || sel.ags) : t('fc.scopeDE'), a, false)
    + pill('op', t('fv.fOp'), o ? S1.operator : t('fv.fAll'), o, ign && o)
    + pill('type', t('fv.fType'), y ? (ty[S1.type] || S1.type) : t('fv.fAll'), y, ign && y)
    + (a || o || y ? `<button type="button" class="chip" data-fv-clear="all">${t('fv.resetAll')}</button>` : '')
    + `<span class="sp"></span>${extra}<span class="hint">${t('fv.filterHint')}</span></div>`;
}
export function bindTop(el, ctx) {
  // Familie wechseln: passt die gewählte Fahrzeugart nicht, wird sie aufgehoben (das rendert alle Ansichten neu), sonst nur dieses Segment
  el.querySelectorAll('[data-fv-fam]').forEach(b => b.addEventListener('click', () => {
    const f = b.dataset.fvFam; if (f === famNow(ctx)) return; setFam(f);
    const ty = ctx.state?.type; if (ty && ty !== 'all' && familyOf(ty) !== f) ctx.setFilter?.('type', 'all'); else renderForecastView(el, ctx, { part: el.dataset.fvPart });
  }));
  el.querySelectorAll('[data-fv-clear]').forEach(b => b.addEventListener('click', () => { const k = b.dataset.fvClear; if (k === 'all') ctx.resetFilters?.(); else ctx.setFilter?.(k, k === 'scope' ? 'DE' : 'all'); }));
}
export function download(name, rows) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + toCsv(rows, lang())], { type: 'text/csv;charset=utf-8' })); a.download = name; a.style.display = 'none';
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
export const fileTag = (ctx, sel) => [FAM !== 'micro' ? FAM : null, sel.ags && sel.ags !== 'DE' ? sel.ags : 'DE', ctx.state.operator !== 'all' ? ctx.state.operator : null, ctx.state.type !== 'all' ? ctx.state.type : null].filter(Boolean).join('_').replace(/[^\w.-]+/g, '-');
export const csvBtn = (key, label, disabled = false) => `<button type="button" class="chip" data-fv-csv="${key}"${disabled ? ' disabled' : ''}>${label}</button>`;
