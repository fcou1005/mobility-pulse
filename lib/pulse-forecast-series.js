// @ts-check
// Mobility Pulse — Prognose – Stundenreihen für das Prognose-Dashboard (aus pulse-forecast.js geschnitten; pulse-forecast.js bleibt die Fassade für alle Importe).
import { hourOf, dayOf } from './pulse-track.js';
import { CTX_KEYS, ctxLookup } from './pulse-context.js';
import { BLEND, CONFORMAL, EVAL_VERSION, FEEDBACK, FORECAST_VERSION, GATES, MEMORY, MODELS, NCTX, PEAK, QBAND_MODELS, SHADOW_ONLY, Z80, bandIx, bandOf80, bandOfQ, buildRows, compactFeedback, compactMemory, conformalUpdate, emptyConformal, emptyFeedback, emptyMemory, envOf, feedbackWeights, fitPooled, learnSummary, memoryAddDays, memoryMerge, memoryPrior, memoryResize, memorySummary, peakScore, pinball, quantileBands, scoreDay, sum } from './pulse-forecast-model.js';
import { BIAS, DECIDE, DM, MIN_VOLUME, agsFactors, assignEras, biasFactorOf, buildFuture, chooseModel, dayFromDoc, evaluateDays, localToUtcMs, portableModel, predictAll, predictLag, predictNaive, shiftDay, typeFactors, volumeOf, wxLookup } from './pulse-forecast-select.js';

// ---------- Stundenreihen für das Prognose-Dashboard (forecast/series.json) ----------
// Je Gebiet (scope) und Ortstag drei Reihen zu 24 Stunden: p = Plan (Tagesprognose, mit Tagen < Tag gerechnet und beim ersten Lauf des Tags
// eingefroren), a = Ist (gezählte Fahrtbeginne, null = Stunde nicht beobachtet), l = aktuelle Prognose für die noch kommenden Stunden.
export const SERIES_KEEP_DAYS = 8;
export const SERIES_MIN = { ags: 40, group: 80, groupMax: 120 }; // Gemeinden ab 40, Gruppen ab 80 Plan-Fahrtbeginnen je Tag (höchstens 120 Gruppen)
/** Gruppenschlüssel 'ags|op|ty' → Gebietsschlüssel (Deutschland, Anbieter, Art, Gemeinde, Gruppe) */
export const scopesOfKey = (key) => { const [ags, op, ty] = key.split('|'); return ['DE', `op:${op}`, `ty:${ty}`, `ags:${ags}`, `g:${key}`]; };
const rv = (x) => (x == null || !Number.isFinite(x) ? null : x < 10 ? Math.round(x * 10) / 10 : Math.round(x));
/** Zeilen einer Vorhersage (Zukunftszeilen F, Erwartung mu) → Map Gebiet → { [Ortstag]: number[24] } */
function aggregateFuture(R, F, mu, fut) {
  const out = new Map();
  for (let i = 0; i < F.n; i++) {
    const f = fut[F.fh[i]], v = mu[i]; if (!(v > 0)) continue;
    for (const sc of scopesOfKey(R.keys[F.g[i]])) { let d = out.get(sc); if (!d) out.set(sc, d = {}); (d[f.day] || (d[f.day] = new Array(24).fill(0)))[f.h] += v; }
  }
  return out;
}
/** Ist eines Tags: Map Gebiet → number[24] mit null in Stunden ohne ausreichende Beobachtung; nur Gruppen-Stunden mit Fahrzeugminuten (wie buildRows) */
export function actualOfDay(d, { hourMin = GATES.hourMinObserved, per60 = false } = {}) {
  const out = new Map();
  for (const [key, g] of Object.entries((per60 ? d.groups : d.groupsRaw ?? d.groups) || {})) { // gezählt (Verlauf); per60 = je volle Stunde
    if (!Array.isArray(g.start) || !Array.isArray(g.vmin)) continue;
    const scs = scopesOfKey(key);
    for (let h = 0; h < 24; h++) {
      if (!(d.hourMin?.[h] >= hourMin) || !((g.vmin[h] || 0) > 0)) continue;
      for (const sc of scs) { let a = out.get(sc); if (!a) out.set(sc, a = new Array(24).fill(null)); a[h] = (a[h] || 0) + (g.start[h] || 0); }
    }
  }
  return out;
}
/**
 * Erwartete Fahrzeugstunden je Gruppe und Stunde (Flottenannahme für Plan, Live-Prognose und Selbstprüfung), nur Tage mit Index < beforeIdx.
 * mode 'last' = zuletzt beobachteter Wert derselben Stunde; 'class' = dasselbe, aber vom letzten Tag desselben Tagtyps wie der Zieltag
 * (target(ags) → Tagtyp; sonst 'last'); 'mean' = Mittel der letzten EXPOSURE.n beobachteten Werte; 'classMean' = Mittel der letzten EXPOSURE.n
 * Werte desselben Tagtyps (sonst 'mean'). Stunden, die nie beobachtet wurden: Mittel der beobachteten Stunden der Gruppe.
 */
export const EXPOSURE = { mode: 'last', n: 3 };
/**
 * Abweichung ausgegebener Prognosen (Live-Abgleich) für Ansicht und Bericht aus einer Quelle (Audit MET-08): je Anbieter und Stunde
 * wapeOpHn gegen naiveOpH über dieselben Stunden, Mittel der Prognosen der letzten `days` Tage (Bezug: now oder jüngste Prognose).
 * Rückgabe { a, b, ratio, skill, n, h, targetDays } oder null.
 */
export function liveSummary(live = [], { days = 7, now = null } = {}) {
  const list = (live || []).filter(x => x && x.wapeOpHn != null && x.naiveOpH != null), ref = now ?? Math.max(0, ...list.map(x => x.at || 0));
  const rec = list.filter(x => !ref || !x.at || ref - x.at <= days * 86400e3); if (!rec.length) return null;
  const mean = (f) => rec.reduce((s, x) => s + f(x), 0) / rec.length, a = mean(x => x.wapeOpHn), b = mean(x => x.naiveOpH);
  return { a, b, ratio: b > 0 ? a / b : null, skill: b > 0 ? 1 - a / b : null, n: rec.length, h: mean(x => x.hours ?? 24), targetDays: new Set(rec.map(x => dayOf(x.from ?? x.at))).size };
}
export function lastExposure(days, beforeIdx = days.length, { target = null, mode = EXPOSURE.mode } = {}) {
  const hist = new Map(), byClass = target && (mode === 'class' || mode === 'classMean'), multi = mode === 'mean' || mode === 'classMean';
  for (let di = 0; di < Math.min(beforeIdx, days.length); di++) { const d = days[di];
    for (const [k, g] of Object.entries(d.groups)) {
      if (!Array.isArray(g.vmin)) continue; let a = hist.get(k); if (!a) hist.set(k, a = Array.from({ length: 24 }, () => []));
      const c = byClass ? d.cls(k.split('|')[0]) : 0;
      for (let h = 0; h < 24; h++) if (d.hourMin[h] >= GATES.hourMinObserved && (g.vmin[h] || 0) > 0) a[h].push([g.vmin[h] / 60, c]);
    }
  }
  const last = new Map();
  for (const [k, a] of hist) {
    const tc = byClass ? target(k.split('|')[0]) : null;
    const out = a.map(list => {
      if (!list.length) return 0;
      const same = tc != null ? list.filter(x => x[1] === tc) : list, src = same.length ? same : list, take = multi ? src.slice(-EXPOSURE.n) : src.slice(-1);
      return take.reduce((t, x) => t + x[0], 0) / take.length;
    });
    const seen = out.filter(x => x > 0);
    if (seen.length && seen.length < 24) { const m = sum(seen) / seen.length; for (let h = 0; h < 24; h++) if (!(out[h] > 0)) out[h] = m; }
    last.set(k, out);
  }
  return last;
}
/**
 * Plan eines Tags (Index di in days): Modell nur mit Tagen < di, Fahrzeugstunden vom letzten beobachteten Wert vor di, Wetter des Tags.
 * Modellwahl wie im Betrieb: chooseModel über die Auswertungen der Tage < Tag. Rückgabe { model, trainDays, scopes } oder null (zu wenige Tage).
 */
export function planDay(R, days, di, day, wx, calendar, evals, fb = null, { mem = null, prior: memPrior = null, ctx = null, live = null, ext = null, fbC = null } = {}) {
  const trainSel = []; for (let i = 0; i < R.n; i++) if (R.day[i] < di) trainSel.push(i);
  const trainDays = new Set(trainSel.map(i => R.day[i])).size;
  if (trainDays < GATES.minTrainDays) return null;
  const prior = Object.fromEntries(Object.entries(evals || {}).filter(([d]) => d < day));
  const env = envOf(R, trainSel, mem, memPrior), envFit = env.on ? { weather: env.weather, ctx: env.ctx, prior: memPrior } : {}, pick = (a) => (a === 'pooledWx' ? (env.on ? 'pooledWx' : 'pooled') : a || 'pooled');
  // Entscheidungsregel wie im Betrieb, mit dem, was vor dem Tag bekannt war (Selbstprüfung bis Vortag, Live-Prognosen, die vor Tagesbeginn ausgewertet waren)
  const dayStart = localToUtcMs(day, 0);
  const gate = []; // S2.3: Chronos/Mischung über den DM-Test in chooseModel (Selbstprüfung bis vor dem Tag)
  let model = pick(chooseModel(prior, { trainDays, live, untilMs: dayStart, nowMs: dayStart, without: gate }).active);
  // lernendes Modell nur, wenn der Lernstand ausschließlich Tage vor dem geplanten Tag kennt (rückwirkende Pläne sonst ohne Rückkopplung)
  if (model === 'adaptive' && !(fb?.upto && fb.upto < day)) model = pick(chooseModel(prior, { trainDays, without: ['adaptive', ...gate], live, untilMs: dayStart, nowMs: dayStart }).active);
  if (model === 'blend' && !(fbC?.upto && fbC.upto < day)) model = pick(chooseModel(prior, { trainDays, without: ['blend', 'adaptive'], live, untilMs: dayStart, nowMs: dayStart }).active);
  const rec = dayFromDoc({ day, runs: [], groups: {} }, calendar), fut = Array.from({ length: 24 }, (_, h) => ({ day, h, cls: rec.cls }));
  const last = lastExposure(days, di, { target: rec.cls }), F = buildFuture(R, fut, (k, h) => last.get(k)?.[h] ?? 0, wx, ctx), sel = Array.from({ length: F.n }, (_, i) => i);
  // Chronos für den Plan: Vortagsprognose des Tags, sonst der Lauf, der den Tag abdeckt
  const tH = Array.from({ length: 24 }, (_, h) => localToUtcMs(day, h)), useBack = !!ext?.hasBack(day);
  const chronosOf = ext ? (i) => { const t = tH[F.hr[i]], k = R.keys[F.g[i]]; return useBack ? ext.back(k, t) : ext.live(k, t); } : null;
  let mu = predictAll(R, days, di, trainSel, F, sel, new Set([model]), { envFit: model === 'pooled' ? {} : envFit, fb, dayOfRow: () => day, chronosOf, fbC }).mu.get(model);
  // S2.8: Plan mit derselben Verzerrungskorrektur wie die Veröffentlichung, aus den Prüfungen vor dem Tag
  let bias = null;
  if (BIAS.models.includes(model) && mu) { const tf = typeFactors(prior, model); if (Object.keys(tf).length) { const af = agsFactors(prior, model, tf); bias = { ...tf, ...(Object.keys(af).length ? { ags: af } : {}) }; mu = Float64Array.from(mu, (x, j) => x * biasFactorOf(R.keys[F.g[sel[j]]], tf, af)); } }
  const scopes = new Map(); for (const [sc, d] of aggregateFuture(R, F, mu, fut)) scopes.set(sc, d[day]);
  return { day, model, trainDays, scopes, ...(bias ? { bias } : {}) };
}
/**
 * Reihen des Dashboards. plans: Map Ortstag → planDay-Ergebnis (nur neu gerechnete), live: Map Gebiet → { [Ortstag]: number[24] } (Prognose ab der nächsten
 * vollen Stunde), nowH: erste Stunde der Prognose je Ortstag { [Tag]: ab Stunde }, prev: forecast/series.json des letzten Laufs.
 */
/**
 * S2.1: Faktor von „je volle Stunde“ auf „gezählt“ für Plan und Live-Prognose im Verlauf (dort bleibt alles gezählt, die Ansicht normiert wie bisher
 * mit den Minuten des zuletzt beobachteten Tags davor): Minuten der Endstunde (obsEnd) am letzten Tag vor `day` mit ≥ 50 Minuten in Stunde h ÷ 60.
 */
export function countedFactor(days, day, h) {
  for (let i = days.length - 1; i >= 0; i--) { const d = days[i]; if (d.day >= day) continue; const o = d.obsEnd?.[h]; if (o >= GATES.hourMinObserved) return o / 60; }
  return 1;
}
export function buildSeries({ days, today, tomorrow, plans, live, liveFrom, prev = null, now, status, active }) {
  const cf = new Map(), toC = (day, arr) => { let f = cf.get(day); if (!f) cf.set(day, f = Array.from({ length: 24 }, (_, h) => countedFactor(days, day, h))); return arr.map((x, h) => (x == null ? x : x * f[h])); };
  const keepFrom = dayOf(now - (SERIES_KEEP_DAYS - 1) * 86400e3), out = { version: 1, generatedAt: new Date(now).toISOString(), tz: 'Europe/Berlin', today, tomorrow, status, active, plans: {}, days: {} };
  const prevDays = prev?.version === 1 ? prev.days || {} : {}, dayBy = new Map(days.map(d => [d.day, d]));
  const dayList = [...new Set([...Object.keys(prevDays), ...plans.keys(), ...days.map(d => d.day), tomorrow])].filter(d => d >= keepFrom && d <= tomorrow).sort();
  for (const day of dayList) {
    const old = prevDays[day] || {}, plan = plans.get(day), doc = dayBy.get(day), act = doc ? actualOfDay(doc) : null, entry = {};
    // Gebiete: bereits gespeicherte bleiben (Plan eingefroren), neu geplante Tage wählen nach Größe
    let scopes;
    if (plan && !Object.values(old).some(x => x.p)) {
      scopes = new Set(['DE']); const gs = [];
      for (const [sc, arr] of plan.scopes) { const tot = sum(arr);
        if (sc.startsWith('op:') || sc.startsWith('ty:')) scopes.add(sc); else if (sc.startsWith('ags:') && tot >= SERIES_MIN.ags) scopes.add(sc); else if (sc.startsWith('g:') && tot >= SERIES_MIN.group) gs.push([sc, tot]); }
      for (const [sc] of gs.sort((a, b) => b[1] - a[1]).slice(0, SERIES_MIN.groupMax)) scopes.add(sc);
    } else scopes = new Set(Object.keys(old));
    if (day === tomorrow && !scopes.size) for (const sc of live.keys()) { const d = live.get(sc)?.[day]; if (!d) continue; const tot = sum(d);
      if (sc === 'DE' || sc.startsWith('op:') || sc.startsWith('ty:') || (sc.startsWith('ags:') && tot >= SERIES_MIN.ags) || (sc.startsWith('g:') && tot >= SERIES_MIN.group)) scopes.add(sc); }
    for (const sc of scopes) {
      const o = old[sc] || {}, e = {};
      const pn = plan?.scopes.get(sc), p = pn ? toC(day, pn) : o.p ?? null; if (p) e.p = p.map(rv); // neuer Plan je volle Stunde → gezählt; eingefrorene bleiben
      const a = act?.get(sc) ?? (day <= today ? o.a : null); if (a) e.a = a.map(rv);
      const l0 = live.get(sc)?.[day], l = l0 ? toC(day, l0) : null; if (l) { const from = liveFrom[day] ?? 0; e.l = l.map((x, h) => (h >= from ? rv(x) : null)); }
      if (e.p || e.a || e.l) entry[sc] = e;
    }
    if (Object.keys(entry).length) out.days[day] = entry;
    // Herkunft des Plans (Kontrolle im Dashboard): Modell, Trainingstage, Zeitpunkt des Einfrierens; bleibt mit dem Plan stehen
    if (plan) out.plans[day] = { model: plan.model, trainDays: plan.trainDays, at: new Date(now).toISOString(), retro: day < today };
    else if (prev?.plans?.[day] && out.days[day]) out.plans[day] = prev.plans[day];
  }
  return out;
}

const r1 = (x) => Math.round(x * 10) / 10;
const wape = (rows) => { let y = 0, a = 0, m = 0; for (const [yy, mm] of rows) { y += yy; a += Math.abs(yy - mm); m += mm; } return y > 0 ? { wape: a / y, bias: m / y - 1, starts: Math.round(y) } : null; };

/**
 * Prognoselauf. docs: events/<Tag>.json (beliebige Reihenfolge), calendar: calendar.json, weather: weather/<Tag>.json-Dokumente, prevLog: forecast/log.json.
 * Ergebnis { latest, log }: latest = Prognose der nächsten 24 Ortsstunden (Gruppe → Starts je Stunde, Gemeinde-Summen, Modellwahl, Gates),
 * log = Rolling-Origin-Auswertungen je Tag (evals), ausgegebene Prognosen mit Live-Abgleich (issued/live), Verlauf der Modellwahl.
 */
// ext = chronosLookup(chronos.json) aus lib/pulse-chronos.js oder null (ohne Chronos: kein „chronos“, „blend“ = Hybrid)
export function runForecast({ docs, calendar = null, weather = [], weatherFc = null, breaks = null, incidents = [], curated = [], prevLog = null, prevSeries = null, now = Date.now(), horizon = 24, minGroupDay = 3, issueEveryMs = 6 * 3600e3, exclude = null, ext = null, pending = [], pendingFrom = null, family = null }) {
  const days = assignEras((docs || []).filter(d => d?.day && d.groups).map(d => dayFromDoc(d, calendar)).sort((a, b) => (a.day < b.day ? -1 : 1)));
  // Gruppen mit rotem Befund der Ereignis-Ampel (nicht plausibel gezählt) bleiben aus Training und Prognose
  if (exclude?.size) for (const d of days) { const g = {}; for (const [k, v] of Object.entries(d.groups)) if (!exclude.has(k)) g[k] = v; d.groups = g; }
  // S2.8: Strukturbruch je Gruppe (calib.json → breaks: erster Tag mit neuer Zählregel) – Tage davor lernen für diese Gruppe nicht mit (Ist bleibt im Verlauf)
  let broken = 0; if (breaks) for (const d of days) for (const k of Object.keys(d.groups)) if (breaks[k] && d.day < breaks[k]) { if (d.groups === d.groupsRaw) d.groups = { ...d.groups }; delete d.groups[k]; broken++; }
  const today = dayOf(now), wx = wxLookup(weather);
  const prev = prevLog?.version === FORECAST_VERSION ? prevLog : null;
  // andere Fassung der Selbstprüfung (EVAL_VERSION): Auswertungen und Lernstand neu aufbauen; ausgegebene Prognosen, Live-Abgleich und Verlauf bleiben
  const evalSame = prev?.evalVersion === EVAL_VERSION;
  const log = { version: FORECAST_VERSION, evalVersion: EVAL_VERSION, evals: evalSame ? { ...(prev?.evals || {}) } : {}, issued: { ...(prev?.issued || {}) }, live: { ...(prev?.live || {}) }, liveDropped: prev?.liveDropped || 0, history: [...(prev?.history || [])], activeSince: prev?.activeSince ?? null };
  const ctx = ctxLookup(incidents, curated), R = buildRows(days, wx, { ctx });
  const trainDays = new Set(Array.from(R.day)).size;
  // Langzeitgedächtnis (bleibt auch bei neuer Prüffassung): Tage, die das Fenster verlassen haben, übernehmen; Prior für das Fenstermodell
  const pm = prev?.memory?.v === MEMORY.v ? prev.memory : null;
  const mem = pm ? memoryResize({ v: MEMORY.v, upto: pm.upto, old: pm.old ? { ...pm.old } : null, days: { ...(pm.days || {}) }, wxDays: { ...(pm.wxDays || {}) } }) : emptyMemory();
  if (days.length) memoryMerge(mem, days[0].day);
  const prior = memoryPrior(mem, today);
  // Lernstand aus den eigenen Fehlern (log.feedback); fehlt er (erster Lauf, neue Fassung), wird das Fenster neu ausgewertet, damit das lernende
  // Modell sofort Vergleichswerte hat – Tage werden in zeitlicher Reihenfolge bewertet und erst danach in den Lernstand übernommen
  const pfb = evalSame && prev?.feedback?.v === FEEDBACK.v ? prev.feedback : null;
  const fb = pfb ? { ...emptyFeedback(), upto: pfb.upto, days: pfb.days || 0, groups: Object.fromEntries(Object.entries(pfb.groups || {}).map(([k, s]) => [k, [...s]])) } : emptyFeedback();
  // Lernstand der Mischung Chronos/Hybrid: nur fortschreiben, wenn auch der Lernstand von adaptive weiterläuft (sonst beide neu aus dem Fenster)
  const pfbC = pfb && prev?.feedbackC?.v === FEEDBACK.v ? prev.feedbackC : null;
  const fbC = pfbC ? { ...emptyFeedback(), upto: pfbC.upto, days: pfbC.days || 0, groups: Object.fromEntries(Object.entries(pfbC.groups || {}).map(([k, s]) => [k, [...s]])) } : emptyFeedback();
  // Rolling Origin: jeder volle, abgeschlossene Tag, der noch nicht ausgewertet ist (ältere Tage ohne Vortraining entfallen von selbst)
  const win = days.map((d, i) => (d.complete && d.day < today ? i : -1)).filter(i => i >= 0).slice(-(GATES.evalWindow + 2));
  const evalIdx = pfb ? win.filter(i => !log.evals[days[i].day]) : win;
  const ev = evaluateDays(R, evalIdx, { fb, dayName: (i) => days[i].day, expoBefore: (d) => lastExposure(days, d, { target: days[d].cls }), days, mem, prior, ext, fbC, wxTest: weatherFc ? wxLookup(weatherFc) : null });
  for (const [di, e] of Object.entries(ev)) {
    const test = []; for (let i = 0; i < R.n; i++) if (R.day[i] === +di) test.push(i);
    const mk = e.mask; e.models.naive = scoreDay(R, test, predictNaive(R, test, +di), 1, { split: true, mask: mk }); delete e.mask; delete e.maskWeek;
    const wk = days.findIndex(x => x.day === shiftDay(days[+di].day, -7)); if (wk >= 0) e.models.week = scoreDay(R, test, predictLag(R, test, wk), 1, { split: true, mask: mk }); // gleicher Wochentag der Vorwoche (fair mit derselben Maske, S2.2)
    log.evals[days[+di].day] = { trainDays: e.trainDays, wxGate: e.wxGate, ...(e.wxFc != null ? { wxFc: e.wxFc } : {}), ...(e.env ? { env: e.env } : {}), ...(e.expoErr != null ? { expoErr: e.expoErr } : {}), ...(e.expoErrAlt ? { expoErrAlt: e.expoErrAlt } : {}), models: e.models };
  }
  for (const d of Object.keys(log.evals).sort().slice(0, -21)) delete log.evals[d];
  // je Gemeinde nur so lange, wie die Korrektur sie liest (log.json bleibt klein)
  for (const d of Object.keys(log.evals).sort().slice(0, -(BIAS.days + 3))) for (const r of Object.values(log.evals[d]?.models || {})) delete r.byAgsType;
  log.feedback = compactFeedback(fb); log.feedbackC = compactFeedback(fbC);
  const all = Array.from({ length: R.n }, (_, i) => i);
  // neue vollständige Tage ins Gedächtnis (Beiträge aus einem Fenstermodell mit allen Wirkungen, die Daten haben; nur Zeilen mit Wetter, sofern vorhanden)
  {
    const withW = all.filter(i => R.hasW[i]), selM = withW.length ? withW : all, hasRows = new Set(selM.map(i => R.day[i]));
    const fresh = days.map((d, i) => (d.complete && d.day < today && !mem.days[d.day] && !(mem.old && d.day <= mem.old.at) && hasRows.has(i) ? i : -1)).filter(i => i >= 0);
    if (fresh.length) { const ctxAny = CTX_KEYS.map((_, k) => k).filter(k => selM.some(i => R.c[k][i])), mM = fitPooled(R, selM, { weather: withW.length > 0, ctx: ctxAny, prior }); memoryAddDays(mem, R, mM, selM, fresh, (i) => days[i].day); }
  }
  log.memory = compactMemory(mem);
  // Abgleich ausgegebener Prognosen (Live-Abgleich): bewertet, sobald die 24 Stunden vorbei sind (3 Stunden Puffer) und mindestens
  // GATES.liveMinHours davon beobachtet sind; Stunden ohne Beobachtung zählen nicht (bis 6.11.2026 mussten alle 24 beobachtet sein – nie bewertet).
  // Seit 6.11.2026 abends (v 2): alle Kandidaten als Schattenprognose (rec.shadow) und zwei faire Vergleichswerte – „wie gestern“ = letzte gleiche
  // Stunde, die zum Zeitpunkt der Ausgabe schon vorbei war (vorher: der Vortag des Zieltags, auch wenn er bei Ausgabe noch nicht vorlag), und gleicher
  // Wochentag der Vorwoche (fehlt er, gilt „wie gestern“). Alle Vergleiche über dieselben Stunden (beobachtet, mit Vergleichswert). Dazu Spitzen
  // (Deutschland-Summe und je Anbieter) und die Trefferquote des 80-%-Bands der veröffentlichten Prognose. lead = Abweichung der Summe je Vorlaufstunde.
  const dayBy = new Map(days.map(d => [d.day, d]));
  const actualOp = (day, h) => { const d = dayBy.get(day); if (!d || !(d.hourMin[h] >= GATES.hourMinObserved)) return null; const m = new Map(); for (const [k, g] of Object.entries(d.groups)) { const op = k.split('|')[1]; m.set(op, (m.get(op) || 0) + (g.start?.[h] || 0)); } return m; };
  let conf = prev?.conformal?.v === CONFORMAL.v ? prev.conformal : emptyConformal();
  for (const [at, rec] of Object.entries(log.issued)) {
    const endAt = rec.local?.length ? localToUtcMs(rec.local.at(-1)[0], rec.local.at(-1)[1]) + 3600e3 : Infinity;
    if (now < endAt + 3 * 3600e3) continue;
    const ops = Object.keys(rec.byOp || {}), comps = { [rec.model]: rec.byOp, ...(rec.shadow || {}) };
    const rows = [], rowsTot = [], lead = [], C = Object.fromEntries([...Object.keys(comps), 'naive', 'week'].map(m => [m, []])), pk = Object.fromEntries(Object.keys(C).map(m => [m, { de: { a: new Map(), f: new Map() }, ops: new Map() }]));
    let hours = 0, inside = 0, nBand = 0, hoursC = 0, pin = 0, pinY = 0; const kB = rec.kBand || conf.k, miss = CONFORMAL.bands.map(() => [0, 0]);
    for (let i = 0; i < rec.local.length; i++) {
      const [day, h] = rec.local[i], a = actualOp(day, h); if (!a) { lead.push(null); continue; }
      hours++;
      // Vergleichswerte, die bei Ausgabe bekannt waren
      let nv = null; for (let k = 1; k <= 7 && !nv; k++) { const pd = shiftDay(day, -k); if (localToUtcMs(pd, h) + 3600e3 <= +at) nv = actualOp(pd, h); }
      const wv = actualOp(shiftDay(day, -7), h) || nv;
      let tot = 0, totM = 0;
      for (const op of ops) { const y = a.get(op) || 0, f = rec.byOp[op][i]; rows.push([y, f]); tot += y; totM += f;
        const b = bandIx(h), wq = rec.bandQ?.[op]?.[i], [lo, hi] = wq ? bandOfQ(f, wq, kB[b] ?? 1) : bandOf80(f, rec.phi || 1, kB[b] ?? 1); nBand++; const ok = y >= lo && y <= hi; if (ok) inside++; miss[b][0] += ok ? 0 : 1; miss[b][1]++;
        pin += pinball(0.1, y, lo) + pinball(0.9, y, hi); pinY += y; }
      rowsTot.push([tot, totM]); lead.push(tot > 0 ? +(Math.abs(tot - totM) / tot).toFixed(3) : null);
      if (!nv) continue;
      hoursC++;
      const val = (m, op) => (m === 'naive' ? nv.get(op) || 0 : m === 'week' ? wv.get(op) || 0 : comps[m]?.[op]?.[i] ?? 0);
      for (const m of Object.keys(C)) for (const op of ops) {
        const y = a.get(op) || 0, f = val(m, op); C[m].push([y, f]);
        const P = pk[m], o = P.ops.get(op) || (P.ops.set(op, { a: new Map(), f: new Map() }), P.ops.get(op));
        for (const x of [P.de, o]) { x.a.set(i, (x.a.get(i) || 0) + y); x.f.set(i, (x.f.get(i) || 0) + f); }
      }
    }
    if (hours >= GATES.liveMinHours) {
      const s0 = wape(rows), t = wape(rowsTot), W = (m) => (C[m].length ? wape(C[m]) : null), nW = W('naive'), wW = W('week'), mW = W(rec.model);
      const models = Object.fromEntries(Object.keys(C).map(m => { const w = W(m), p = peakScore([pk[m].de, ...pk[m].ops.values()], { minHours: PEAK.minHoursLive }); return [m, { w: w && +w.wape.toFixed(4), ...(p ? { peak: p } : {}) }]; }));
      log.live[at] = { v: 2, model: rec.model, from: rec.from, hours, hoursC, wapeOpH: s0 && +s0.wape.toFixed(4), bias: s0 && +s0.bias.toFixed(4), wapeTotalH: t && +t.wape.toFixed(4),
        naiveOpH: nW && +nW.wape.toFixed(4), wapeOpHn: mW && +mW.wape.toFixed(4), weekOpH: wW && +wW.wape.toFixed(4), skill: mW && nW && nW.wape > 0 ? +(1 - mW.wape / nW.wape).toFixed(3) : null,
        cover80: nBand ? +(inside / nBand).toFixed(3) : null, pinball: pinY > 0 ? +(pin / pinY).toFixed(4) : null, kBand: kB, peak: models[rec.model]?.peak ?? null, models, starts: s0?.starts ?? 0, lead, ...(rec.ext ? { ext: rec.ext } : {}) };
      conf = conformalUpdate(conf, miss); // S2.7: Band nachführen
    } else log.liveDropped++; // zu wenige beobachtete Stunden: nicht bewertbar
    delete log.issued[at];
  }
  for (const k of Object.keys(log.live).sort().slice(0, -60)) delete log.live[k];
  log.conformal = conf;
  const prevActive = [...(prev?.history || [])].reverse().find(h => h.active)?.active ?? null;
  // S2.3: seit wann das aktive Modell gilt (log.activeSince, ab 13.11.2026 mitgeschrieben) – höchstens ein Wechsel je DECIDE.minSwitchDays
  const switchedAt = prev?.activeSince?.model && prev.activeSince.model === prevActive ? Date.parse(prev.activeSince.at) : null;
  let choice = chooseModel(log.evals, { trainDays, live: log.live, prevActive, switchedAt, nowMs: now }); const fbw = feedbackWeights(fb);
  // S2.6: E-Roller und Carsharing erst ab MIN_VOLUME Fahrtbeginnen je Tag (Mittel der letzten 7 vollständigen Tage, gezählt); darunter wird die
  // Vorwoche veröffentlicht (gleicher Wochentag, als Vergleichswert ausgewiesen) oder – ohne Vorwoche – nichts
  const volume = volumeOf(days), small = family && MIN_VOLUME[family] != null && volume != null && volume < MIN_VOLUME[family];
  if (small) { const hasWeek = days.some(d => d.day === shiftDay(today, -7)) || days.some(d => d.day === shiftDay(today, -6));
    choice = { ...choice, active: hasWeek ? 'week' : null, status: 'small', reason: `zu wenig Volumen: ${Math.round(volume)} Fahrtbeginne je Tag (Mittel 7 Tage, nötig ${MIN_VOLUME[family]}) – ${hasWeek ? 'veröffentlicht wird die Vorwoche' : 'keine Prognose'}`, why: { small: true, volume: Math.round(volume), min: MIN_VOLUME[family] } }; }
  const env = envOf(R, all, mem, prior), gate = env.gate, usesEnv = ['pooledWx', 'adaptive', 'hybrid', 'naive', 'week'].includes(choice.active) && env.on;
  const useWx = usesEnv && env.weather, envFit = env.on ? { weather: env.weather, ctx: env.ctx, prior } : {};
  const incSum = { days: incidents.filter(d => d?.ags).length, warnAt: incidents.map(d => d?.sources?.warn?.at).filter(Boolean).sort().at(-1) ?? null, roadAt: incidents.map(d => d?.sources?.road?.at).filter(Boolean).sort().at(-1) ?? null, curated: curated.length,
    upcoming: curated.filter(e => String(e.bis ?? e.von).slice(0, 10) >= today).slice(0, 10).map(e => ({ art: e.art, von: e.von, bis: e.bis ?? e.von, gebiet: e.gebiet, titel: e.titel ?? null, quelle: e.quelle })) };
  const support = Object.fromEntries(CTX_KEYS.map(/** @returns {[string, any]} */ (k, j) => { let n = 0; const ds = new Set(); for (const i of all) if (R.c[j][i]) { n++; ds.add(R.day[i]); } return [k, { rows: n, days: ds.size, memRows: Math.round(prior?.n?.[3 + j] || 0), memDays: +(prior?.dk?.[3 + j] || 0).toFixed(1) }]; }));
  // zurückgehaltene Einträge (Lernphase: Veranstaltungen, Sport, Volksfeste erst ab pendingFrom): nur zählen, wie viele Gemeinde-Stunden sie
  // im Training kennzeichnen würden – fließt nicht ins Modell, zeigt im Dashboard „erfasst, wirkt ab …“
  if (pending?.length) {
    const pc = ctxLookup([], pending), agsOf = R.keys.map(k => k.split('|')[0]), pn = CTX_KEYS.map(() => 0), pd = CTX_KEYS.map(() => new Set());
    for (const i of all) { const x = pc(agsOf[R.g[i]], days[R.day[i]].day, R.hr[i]); for (let j = 0; j < NCTX; j++) if (x[j]) { pn[j]++; pd[j].add(R.day[i]); } }
    CTX_KEYS.forEach((k, j) => { if (pn[j]) support[k].pending = { rows: pn[j], days: pd[j].size }; });
  }
  /** @type {any} */ const out = { version: FORECAST_VERSION, generatedAt: new Date(now).toISOString(), status: trainDays < GATES.minTrainDays ? 'insufficient' : choice.status, active: trainDays < GATES.minTrainDays ? null : (choice.active === 'pooledWx' && !env.on ? 'pooled' : choice.active), reason: choice.reason, scores: choice.scores, evalDays: choice.evalDays, trainDays,
    volume: volume == null ? null : Math.round(volume), ...(small ? { minVolume: MIN_VOLUME[family] } : {}),
    excluded: exclude?.size || 0, gates: { ...GATES }, weather: { gate, used: useWx, source: weather.length ? weather[0].source ?? null : null },
    env: { keys: CTX_KEYS, ready: env.ctx.map(k => CTX_KEYS[k]), active: usesEnv ? env.ctx.map(k => CTX_KEYS[k]) : [], support, sources: incSum, ...(pending?.length && pendingFrom ? { pendingFrom } : {}) }, memory: null,
    band: { level: CONFORMAL.target, z: Z80, k: conf.k, bands: CONFORMAL.bands, n: conf.n, source: 'poisson' }, // S2.7: Band je Stunde = k[Band(h)] · z · √(φ·μ) + 0,5; bei Chronos/Mischung aus den Quantilen (source 'chronos')
    decision: { rule: { ...DECIDE, dm: { ...DM } }, live: choice.live || null, combined: choice.combined || null, why: choice.why || null, dm: choice.dm || null },
    learn: fb.upto ? learnSummary(fb, fbw) : null,
    blend: { activeFrom: new Date(BLEND.activeFrom).toISOString(), chronos: ext ? { at: ext.at, model: ext.model, backDays: ext.backDays } : null, learn: fbC.upto ? learnSummary(fbC, feedbackWeights(fbC)) : null },
    horizon: null, totals: null, groups: {}, municipalities: {} };
  const tomorrow = dayOf(localToUtcMs(today, 12) + 24 * 3600e3);
  let live = new Map(); const liveFrom = {}; let portable = null;
  if (out.active) {
    // Horizont: ab der nächsten vollen Stunde mindestens 24 Ortsstunden, danach bis zum Ende von morgen (Dashboard); die Felder von latest.json
    // (totals, groups, municipalities, horizon) behalten ihre 24 Stunden
    const t0 = (Math.floor(now / 3600e3) + 1) * 3600e3, fut = [];
    const clsCache = new Map();
    for (let k = 0; k < 60; k++) {
      const t = t0 + k * 3600e3, day = dayOf(t); if (k >= horizon && day > tomorrow) break;
      const rec = clsCache.get(day) ?? (clsCache.set(day, dayFromDoc({ day, runs: [], groups: {} }, calendar)), clsCache.get(day)); fut.push({ day, h: hourOf(t), cls: rec.cls, t });
    }
    const HL = fut.length; for (const f of fut) if (liveFrom[f.day] == null) liveFrom[f.day] = f.h;
    // erwartete Fahrzeugstunden: zuletzt beobachteter Wert derselben Stunde je Gruppe
    const last = lastExposure(days), byDay = new Map(), expo = (k, h, f) => { let m = byDay.get(f.day); if (!m) byDay.set(f.day, m = lastExposure(days, days.length, { target: f.cls })); return m.get(k)?.[h] ?? 0; };
    const F = buildFuture(R, fut, expo, wx, ctx), sel = Array.from({ length: F.n }, (_, i) => i);
    // Ausgabe fällig? Dann alle Kandidaten mitrechnen (Schattenprognosen für den Live-Abgleich)
    const lastIssued = Math.max(0, ...Object.keys(log.issued).map(Number)), issuing = now - lastIssued >= issueEveryMs;
    const chronosOn = !!ext?.usable(t0), chronosOf = chronosOn ? (i) => ext.live(R.keys[F.g[i]], fut[F.fh[i]].t) : null;
    const cands = [...MODELS.filter(m => (m !== 'pooledWx' || env.on) && (m !== 'blend' || chronosOn)), ...(chronosOn ? SHADOW_ONLY : [])], want = new Set([out.active, ...(issuing ? cands : [])]);
    const PA = predictAll(R, days, days.length, all, F, sel, want, { envFit, fb, dayOfRow: (i) => fut[F.fh[i]].day, chronosOf, fbC });
    try { portable = portableModel(PA.fitted(), R, { family: family || 'micro', now, trainDays: out.trainDays, active: out.active, days: days.map(d => d.day) }); } catch { portable = null; }
    // S2.8: Verzerrung je Art korrigieren (je Modell aus dessen Selbstprüfung; Vergleichswerte bleiben roh)
    const biasCorr = {};
    for (const [m, arr] of PA.mu) { if (!BIAS.models.includes(m)) continue; const tf = typeFactors(log.evals, m); if (!Object.keys(tf).length) continue; const af = agsFactors(log.evals, m, tf);
      biasCorr[m] = { ...tf, ...(Object.keys(af).length ? { ags: af } : {}) };
      PA.mu.set(m, Float64Array.from(arr, (x, j) => x * biasFactorOf(R.keys[F.g[sel[j]]], tf, af))); }
    out.biasCorr = Object.keys(biasCorr).length ? biasCorr : null; out.breaks = broken;
    let mu = PA.mu.get(out.active), phi = PA.phi(out.active);
    out.phi = +phi.toFixed(2);
    live = aggregateFuture(R, F, mu, fut);
    const total = new Array(HL).fill(0), byGroup = new Map(), byMuni = new Map(), byOp = new Map();
    sel.forEach((i, j) => {
      const key = R.keys[F.g[i]], fi = F.fh[i], v = mu[j]; total[fi] += v;
      let a = byGroup.get(key); if (!a) byGroup.set(key, a = new Array(HL).fill(0)); a[fi] += v;
      const ags = key.split('|')[0], op = key.split('|')[1]; let b = byMuni.get(ags); if (!b) byMuni.set(ags, b = new Array(HL).fill(0)); b[fi] += v;
      let c = byOp.get(op); if (!c) byOp.set(op, c = new Array(HL).fill(0)); c[fi] += v;
    });
    out.horizon = { from: t0, hours: horizon, local: fut.slice(0, horizon).map(f => [f.day, f.h]), hoursLong: HL, tomorrow };
    out.totals = total.slice(0, horizon).map(r1);
    for (const [k, a0] of byGroup) { const a = a0.slice(0, horizon); if (a.reduce((x, y) => x + y, 0) >= minGroupDay) { const fleet = sum(Array.from({ length: 24 }, (_, h) => last.get(k)?.[h] || 0)) / 24, st = a.reduce((x, y) => x + y, 0); out.groups[k] = { start: a.map(r1), fleet: r1(fleet), perVeh: fleet >= 1 ? +(st / fleet).toFixed(2) : null }; } }
    for (const [k, a] of byMuni) out.municipalities[k] = a.slice(0, horizon).map(r1);
    // Live-Abgleich: ausgegebene Prognose festhalten (höchstens alle issueEveryMs), später gegen die Realität prüfen
    if (issuing) {
      const opOf = (m) => { const o = new Map(); sel.forEach((i, j) => { if (F.fh[i] >= horizon) return; const op = R.keys[F.g[i]].split('|')[1]; let a = o.get(op); if (!a) o.set(op, a = new Array(horizon).fill(0)); a[F.fh[i]] += m[j]; }); return Object.fromEntries([...o].map(([k, a]) => [k, a.map(x => Math.round(x * 10) / 10)])); };
      const shadow = Object.fromEntries([...PA.mu].filter(([m]) => m !== out.active && cands.includes(m)).map(([m, v]) => [m, opOf(v)]));
      // Chronos-Meta: Stand des Laufs, Alter bei Ausgabe, Anteil der Fahrten (aktives Modell) in Gruppen mit Chronos-Wert
      let extMeta = null;
      if (chronosOn) { let cov = 0, tot = 0; sel.forEach((i, j) => { if (F.fh[i] >= horizon) return; tot += mu[j]; if (Number.isFinite(chronosOf(i))) cov += mu[j]; }); extMeta = { chronos: { at: ext.at, ageH: +((t0 - Date.parse(ext.at)) / 3600e3).toFixed(1), cover: tot > 0 ? +(cov / tot).toFixed(3) : 0 } }; }
      const bandQ = chronosOn && QBAND_MODELS.includes(out.active) && typeof ext.quant === 'function' ? quantileBands(R.keys, sel.map(i => [F.g[i], F.fh[i], fut[F.fh[i]].t]), ext.quant, horizon) : null;
      if (bandQ) out.band.source = 'chronos';
      log.issued[now] = { v: 2, model: out.active, from: t0, phi: +phi.toFixed(2), kBand: [...conf.k], ...(bandQ ? { bandQ } : {}), local: out.horizon.local, total: out.totals, byOp: Object.fromEntries([...byOp].map(([k, a]) => [k, a.slice(0, horizon).map(x => Math.round(x * 10) / 10)])), shadow, ...(extMeta ? { ext: extMeta } : {}) };
    }
    log.history.push({ at: out.generatedAt, active: out.active, status: out.status, reason: out.reason });
    log.activeSince = prev?.activeSince?.model === out.active ? prev.activeSince : { model: out.active, at: out.generatedAt };
  } else log.history.push({ at: out.generatedAt, active: null, status: out.status, reason: out.status === 'small' ? out.reason : `${trainDays} Tage Daten – zu wenig` });
  log.history = log.history.slice(-60);
  out.memory = memorySummary(mem, today, out.phi ?? 1);
  out.live = Object.entries(log.live).sort((a, b) => +a[0] - +b[0]).slice(-12).map(([at, v]) => ({ at: +at, ...v }));
  // Stundenreihen für das Dashboard: Plan heute (und für noch nicht gespeicherte, abgeschlossene Tage), Ist, Live-Prognose bis Ende morgen
  const plans = new Map(), has = (d) => Object.values(prevSeries?.version === 1 ? prevSeries.days?.[d] || {} : {}).some(x => x.p), keepFrom = dayOf(now - (SERIES_KEEP_DAYS - 1) * 86400e3);
  if (trainDays >= GATES.minTrainDays) {
    days.forEach((d, pi) => { if (d.day >= keepFrom && d.day < today && d.complete && !has(d.day)) { const r = planDay(R, days, pi, d.day, wx, calendar, log.evals, fb, { mem, prior, ctx, live: log.live, ext, fbC }); if (r) plans.set(d.day, r); } });
    if (!has(today)) { const ti = days.findIndex(d => d.day === today), r = planDay(R, days, ti >= 0 ? ti : days.filter(d => d.day < today).length, today, wx, calendar, log.evals, fb, { mem, prior, ctx, live: log.live, ext, fbC }); if (r) plans.set(today, r); }
  }
  const series = buildSeries({ days, today, tomorrow, plans, live, liveFrom, prev: prevSeries, now, status: out.status, active: out.active });
  if (family) { out.family = family; series.family = family; }
  return { latest: out, log, series, model: portable };
}
