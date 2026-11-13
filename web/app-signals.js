// Dashboard: Signale (S3.9: aus web/app.js geschnitten, Einstieg bleibt web/app.js).
import * as C from './pulse-core.js';
import * as UI from './ui-shared.js';
import * as R from './pulse-report.js';
import { GROUP_MIN, GROUP_M } from './pulse-track.js';
import { t, tx, lang } from './i18n.js';
import { $, DEMO, DIRS, STATUS, TYPE, ageText, esc, fmt, pctf, state } from './app-core.js';
import { dailyBaseline, emptyRow, failedText, loadDaily, loadHistory, seriesOf, setChips } from './app-load.js';
import { liveRec, muniName, scopeGroups, sourcesForScope, sumStats } from './app-scope.js';
import { currentView, dirty, markDirty } from './app-router.js';
import { renderBriefing, renderLede } from './app-lang.js';
import { ENERGY, alignSeries, energyRule, energyVal, energyWait, groupEnergy } from './app-energy.js';
import { groupInScope, loadOnce } from './app-usage.js';
import { gapFitsType } from './app.js';

// ---------- Signale ----------
export let sigFilter = 'all';
export const setSigFilter = (v) => { sigFilter = v; }; // S3.9: Setzen aus der Steuerung
// Schwere der drei Bestandsalarme (gesperrt, Energie, Stationen): „kritisch“ nur, wenn der Anteil ≥ 15 Punkte über dem Mittel der vorigen Tage liegt
// (history/daily.json, Vertrag 6); liegt er darunter: „auffällig“; ohne Vergleichswert: „Hinweis“.
// Ab 5 Punkten über dem Mittel „auffällig“, ab 15 „kritisch“; im üblichen Rahmen (dauerhaft hoher Anteil) nur „Hinweis“.
export function severity(share, baseline, src = 'Vortage') { // src: Kennung 'Tag' | 'Vortage'
  if (baseline == null) return { sev: 'info', foot: t('app.noComparisonValueNoDailyMean') };
  const d = (share - baseline) * 100;
  return { sev: d >= 15 ? 'bad' : d >= 5 ? 'warn' : 'info', foot: t('app.avgPoints', { v0: src === 'Tag' ? t('app.ofDaySoFar') : t('app.ofPreviousDays'), v1: fmt(baseline * 100), v2: d >= 0 ? '+' : '', d: fmt(d), v4: d < 5 ? ` ${t('app.usual')}` : '' }) };
}
// Rückfall ohne history/daily.json (bzw. für Stationen, die dort fehlen): Mittel der früheren Sammler-Punkte des geladenen Verlaufstags
export function histBaseline(ags, op) {
  const h = state.hist[state.histIndex?.days?.slice(-1)[0]]; if (!h || h.t.length < 3) return null;
  const n = h.t.length - 1; let tot = 0, dis = 0, low = 0, sta = 0, emp = 0;
  for (const ser of seriesOf(h, ags, op)) { for (let i = 0; i < n; i++) { tot += ser.total?.[i] || 0; dis += ser.disabled?.[i] || 0; low += ser.lowBattery?.[i] || 0; sta += ser.stations?.[i] || 0; emp += ser.stationsEmptyDock?.[i] ?? ser.stationsEmpty?.[i] ?? 0; } }
  return tot || sta ? { src: 'Tag', disabled: tot ? dis / tot : null, low: tot ? low / tot : null, emptyDock: sta ? emp / sta : null } : null;
}
// Lede, Briefing und Signale lesen dasselbe Ergebnis: neu gerechnet nur, wenn sich Datenstand, Filter, Verlaufstag, Tagesmittel, Gruppen,
// Energie-Stand, Live-Abruf, Kundenansicht oder Sprache geändert haben
export let sigMemo = null;
export function computeSignals() {
  const key = [state.latest?.at, state.scope, state.operator, state.type, state.mode, state.live?.at, state.histDay, Object.keys(state.hist).length, !!state.daily, !!state.usage?.groups, !!state.usage?.consistency, ENERGY.size, energyWait, lang(), state.thresholds.charge, state.thresholds.range].join('|');
  if (sigMemo?.key === key) return sigMemo.out;
  const out = computeSignalsNow();
  sigMemo = { key, out };
  return out;
}
export function computeSignalsNow() {
  const groups = scopeGroups(); const munis = state.latest?.municipalities || {};
  const by = new Map();
  const ebk = new Map(); // Energie je Gemeinde|Anbieter (Einzelfahrzeuge, Regel energyLow)
  for (const [k, s] of groups) {
    const [ags, op] = k.split('|'); const key = `${ags}|${op}`; (by.get(key) || by.set(key, []).get(key)).push(s);
    const g = groupEnergy(k, s), e = ebk.get(key) || { ...R.emptyEnergy(), pending: false, approx: false };
    if (g.pending) e.pending = true; else { if (g.approx) e.approx = true; for (const f of ['known', 'low', 'rangeOnly', 'rangeOnlyLow']) e[f] += g[f] || 0; }
    ebk.set(key, e);
  }
  const out = [];
  const place = (ags) => state.scope === 'DE' ? ` · ${munis[ags]?.name || ags}` : '';
  const daily = state.daily || null, today = BERLIN_DAY.format(state.latest?.at || Date.now());
  for (const [key, list] of by) {
    const [ags, op] = key.split('|'); const s = sumStats(list);
    const db = dailyBaseline(daily, ags, op, today), hb = histBaseline(ags, op);
    // Tagesmittel der Vortage, wo vorhanden; Stationen (nicht in daily.json) und alter Datenstand: Mittel des Tages bisher
    const base = { disabled: db?.disabled ?? hb?.disabled, low: db?.low ?? hb?.low, emptyDock: db?.emptyDock ?? hb?.emptyDock, src: db ? 'Vortage' : 'Tag', srcSt: db?.emptyDock != null ? 'Vortage' : 'Tag' };
    // short: Titel ohne die Zahl für die kompakte Briefing-Karte (dort steht n daneben)
    const who = { op, ags: place(ags) };
    if (s.total >= 5 && s.disabled / s.total >= 0.25) { const sv = severity(s.disabled / s.total, base.disabled, base.src); out.push({ cat: 'disabled', sev: sv.sev, w: s.disabled, n: fmt(s.disabled), short: t('app.sigShortDisabled', who), title: t('app.disabled4', { op, ags: place(ags), disabled: fmt(s.disabled), disabled2: pctf(s.disabled, s.total) }), text: t('app.feedMarksVehiclesAsUnusable'), foot: t('app.reportedIsdisabledStation', { foot: sv.foot }) }); }
    // Energie niedrig: feste Regel für alle Anbieter (auch Lime über die Reichweite), wie Kacheln und Disposition. Die Stufe misst die
    // Abweichung vom Vortagesmittel am Ladestand-Anteil am Bestand – die Tageswerte (history/daily.json) kennen nur diesen Zähler.
    const e = ebk.get(key);
    if (!e.pending && e.known >= 5 && e.low / e.known >= 0.3) {
      const sv = severity(s.total ? s.lowBattery / s.total : 0, base.low, base.src); const ro = e.rangeOnly === e.known;
      out.push({ cat: 'energy', sev: sv.sev, w: e.low, n: energyVal(e), short: t('app.sigShortEnergy', who), title: `${op}${place(ags)}: ${t('app.nLowEnergy', { n: energyVal(e) })}`, text: t('app.ofVehiclesWithEnergyData', { low: fmt(e.low), known: fmt(e.known), v2: energyRule(), v3: ro ? ` ${t('app.feedReportsRangeOnlyBelow')}` : e.rangeOnly ? t('app.withRangeOnly', { rangeOnly: fmt(e.rangeOnly) }) : '' }), foot: t('app.energyPerVehicleWorkOrderNot', { foot: sv.foot }) });
    }
    // Leer zählt nur effektiv: gemeldet leer und kein verfügbares Fahrzeug desselben Anbieters ≤ 50 m. Alarm nur für Docks; virtuelle Stationen getrennt (Vertrag 3)
    const nearM = C.STATION_NEAR_M ?? 50, nearN = s.stationsEmptyNearby || 0;
    const otherN = s.stationsEmptyOtherNearby || 0;
    const nearTxt = (nearN ? ` ${t('app.anotherReportedEmptyBut', { nearN: fmt(nearN), nearM })}` : '') + (otherN ? ` ${t('app.atOfEmptyOnesVehiclesOfOther', { otherN: fmt(otherN), nearM })}` : '');
    const dockKnown = s.stationsEmptyDock != null;
    const docks = dockKnown ? s.stations - (s.stationsVirtual || 0) : s.stations, emptyDock = dockKnown ? s.stationsEmptyDock : s.stationsEmpty;
    if (docks >= 3 && emptyDock / docks >= 0.3) { const sv = severity(emptyDock / docks, base.emptyDock, base.srcSt); out.push({ cat: 'stations', sev: sv.sev, w: emptyDock, n: fmt(emptyDock), short: t('app.sigShortEmpty', who), title: t('app.emptyStations', { op, ags: place(ags), emptyDock: fmt(emptyDock), v3: dockKnown ? 'Dock-' : '', emptyDock2: pctf(emptyDock, docks) }), text: t('app.ofReportedStationsCurrently', { emptyDock: fmt(emptyDock), docks: fmt(docks), v2: dockKnown ? 'Dock-' : '', nearM, nearTxt }), foot: t('app.stationStatusAndVehicle', { foot: sv.foot }) }); }
    else if (docks >= 3 && nearN / s.stations >= 0.3) out.push({ cat: 'data', sev: 'info', w: nearN, n: fmt(nearN), short: t('app.sigShortReportedEmpty', who), title: t('app.stationsReportedEmpty', { op, ags: place(ags), nearN: fmt(nearN) }), text: t('app.stationFeedReportsNoBookable', { nearM, stationsEmpty: fmt(s.stationsEmpty) }), foot: t('app.stationStatusAndVehicle2') });
    if (dockKnown && s.stationsEmptyVirtual > 0) out.push({ cat: 'stations', sev: 'info', w: s.stationsEmptyVirtual, n: fmt(s.stationsEmptyVirtual), short: t('app.sigShortZones', who), title: t('app.parkingZonesWithoutVehicle', { op, ags: place(ags), v2: fmt(s.stationsEmptyVirtual) }), text: t('app.ofVirtualStationsParking', { v0: fmt(s.stationsEmptyVirtual), stationsVirtual: fmt(s.stationsVirtual) }), foot: t('app.isvirtualstationInStation') });
    if (s.stations >= 3 && s.stationsFull / s.stations >= 0.3) out.push({ cat: 'stations', sev: 'info', w: s.stationsFull, n: fmt(s.stationsFull), short: t('app.sigShortFull', who), title: `${op}${place(ags)}: ${t('app.nFullStations', { n: fmt(s.stationsFull) })}`, text: t('app.returningVehiclesToThese'), foot: 'num_docks_available = 0' });
    if (s.total >= 5 && s.geoStation / s.total >= 0.5) out.push({ cat: 'data', sev: 'info', w: s.geoStation, n: fmt(s.geoStation), short: t('app.sigShortGeo', who), title: t('app.positionsMostlyStation', { op, ags: place(ags) }), text: t('app.ofVehiclesWithoutOwn', { geoStation: fmt(s.geoStation), total: fmt(s.total) }), foot: t('app.geoCheck') });
  }
  // Quellenzustand; geprüfte Direktfeed-Kandidaten ohne Feed sind kein Ausfall (wie in der Ampel)
  const recs = sourcesForScope().map(r => liveRec(r.id) || r);
  for (const r of recs) {
    if (r.candidate && !['live', 'delayed', 'stale', 'unknown', 'empty'].includes(r.status)) continue;
    // Audit UXM-04: Anbieter- und Art-Filter gelten auch für Quellen-Signale (vorher meldete „Voi · E-Scooter“ RegioRad als kritisch)
    if (state.operator !== 'all' && r.operator !== state.operator) continue;
    if (state.type !== 'all' && Array.isArray(r.vehicleTypes) && r.vehicleTypes.length && !r.vehicleTypes.includes(state.type)) continue;
    // Zustand statt Zahl: die Karte zeigt ein Zeichen, der Titel nennt den Zustand („Quelle: Fehler“)
    if (['stale', 'gone', 'error', 'auth'].includes(r.status)) out.push({ cat: 'data', sev: r.status === 'stale' ? 'warn' : 'bad', w: 1, n: null, icon: true, title: t('app.source2', { operator: r.operator, v1: STATUS[r.status] || r.status }), text: `${r.name || r.id}${r.feedAgeMs != null ? ` · ${t('app.feedOld', { v0: ageText(r.feedAgeMs) })}` : ''}${r.errors?.length ? ` · ${esc(tx(r.errors[0]))}` : ''}`, foot: `${(r.directories || []).map(d => DIRS[d] || d).join(' · ')}` });
    if (r.sourceChanged) out.push({ cat: 'data', sev: 'info', w: 1, n: null, icon: true, title: t('app.sourceChangeDetected', { operator: r.operator }), text: t('app.endpointVersionFeedsOr', { v0: r.name || r.id }), foot: t('app.fingerprint') });
  }
  for (const e of state.usage?.consistency?.systems || []) { if (e.verdict !== 'divergent') continue; const r = (state.latest?.sources || []).find(x => x.id === e.sourceId); if (!r || (state.scope !== 'DE' && !(r.municipalities || []).includes(state.scope)) || (state.operator !== 'all' && e.operator !== state.operator)) continue; out.push({ cat: 'data', sev: 'warn', w: Math.abs((e.primary?.vehicles || 0) - (e.alt?.vehicles || 0)), n: fmt(Math.abs((e.primary?.vehicles || 0) - (e.alt?.vehicles || 0))), short: t('app.sigShortDivergent', { op: e.operator }), title: t('app.stateAndOperatorFeedDiffer', { operator: e.operator }), text: t('app.vsVehiclesMedianDistance', { sourceId: e.sourceId, v1: fmt(e.primary?.vehicles), v2: fmt(e.alt?.vehicles), v3: e.idOverlap == null ? '' : pctf(e.idOverlap, 1) + ` ${t('app.sharedIds')} `, v4: e.medianDistM == null ? '—' : fmt(e.medianDistM) + ' m' }), foot: t('app.consistencyCheck') }); }
  for (const g of state.latest?.gaps || []) if ((state.scope === 'DE' || muniName(state.scope) === g.city) && (state.operator === 'all' || g.operator === state.operator) && gapFitsType(g)) out.push({ cat: 'data', sev: 'info', w: 1, n: null, icon: true, title: t('app.publicDataMissingSince', { operator: g.operator, city: g.city, v2: String(g.since || '').split('-').reverse().join('.') }), text: (lang() === 'en' && g.note_en) || g.note, foot: g.probeOk ? t('app.feedReachableAgain') : t('app.feedChecked', { v0: g.probeStatus ?? '–' }) });
  // Bestandssprung gegen Verlauf
  const h = state.histDay ? state.hist[state.histDay] : state.hist[state.histIndex?.days?.slice(-1)[0]];
  if (h && h.t.length >= 3) {
    for (const [key, list] of by) {
      const [ags, op] = key.split('|'); let prev = 0, cur = 0, n = 0;
      for (const ser of seriesOf(h, ags, op)) { const a = ser.available; const lastIdx = a.length - 1; if (a[lastIdx] == null || a[lastIdx - 3] == null) continue; cur += a[lastIdx]; prev += a[lastIdx - 3]; n++; }
      if (n && prev >= 20 && Math.abs(cur - prev) / prev >= 0.3) out.push({ cat: 'jump', sev: 'warn', w: Math.abs(cur - prev), n: `${cur > prev ? '+' : ''}${fmt(cur - prev)}`, short: t('app.sigShortJump', { op, ags: place(ags) }), title: t('app.fleetWithinHour', { op, ags: place(ags), v2: cur > prev ? '+' : '', v3: fmt(cur - prev) }), text: t('app.availableOverLastThree', { prev: fmt(prev), cur: fmt(cur) }), foot: t('app.collectorHistory') });
    }
  }
  // Ampel der Ereignisregeln je Gruppe (latest.json → eventChecks, letzter vollständiger Tag): gelb und rot als Datenhinweis
  for (const [k, v] of Object.entries(state.latest?.eventChecks?.groups || {})) {
    if (v?.level !== 'warn' && v?.level !== 'bad' || !groupInScope(k)) continue; const [ags, op, ty] = k.split('|');
    out.push({ cat: 'data', sev: v.level, w: v.checks?.rides || 1, n: null, icon: true, short: t('mb.sigShort', { op, ags: place(ags) }), title: t('mb.sigTitle', { op, ty: TYPE[ty] || ty, ags: place(ags), lv: v.level === 'bad' ? t('mb.red') : t('mb.yellow') }),
      text: `${UI.mbChecksText(v.checks)}. ${v.level === 'bad' ? t('mb.sigRed') : t('mb.sigYellow')}`, foot: t('mb.sigFoot', { day: state.latest.eventChecks.day || '–' }) });
  }
  out.push(...groupSignals());
  const sevW = { bad: 3, warn: 2, info: 1 };
  return out.sort((a, b) => sevW[b.sev] - sevW[a.sev] || b.w - a.w);
}
// Tagesmittel für die Alarm-Schwere einmal je Datenstand laden; danach Briefing und Signale neu zeichnen
// Dazu der letzte Verlaufstag (Bestandssprung, Rückfall-Mittel); Briefing/Signale werden danach neu gezeichnet, je nach aktiver Ansicht
export let dailyLoaded = false;
export function ensureDaily() {
  if (dailyLoaded) return; dailyLoaded = true;
  const last = state.histIndex?.days?.slice(-1)[0];
  Promise.all([loadDaily(), last && !state.hist[last] ? loadHistory(last) : null]).then(([d, h]) => { state.daily = d; if (!d && !h) return; if (currentView === 'live') { renderBriefing(); renderLede(); } else dirty.add('live'); markDirty('signals'); });
}
// Gruppen-Ausbringungen (groups.json): einmal je Sammler-Stand anfragen, auch wenn die Datei fehlt; danach Briefing neu zeichnen
export let groupsReq = null;
export const resetSignalData = () => { groupsReq = null; dailyLoaded = false; }; // S3.9: Zurücksetzen aus app.js
export const loadGroups = () => groupsReq ??= loadOnce('groups', 'groups.json', 30000);
export const BERLIN_DAY = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' });
export function groupSignals() {
  ensureDaily();
  if (!groupsReq) loadGroups().then(d => { if (!d?.events?.length) return; renderBriefing(); if (currentView === 'signals') renderSignals(); });
  const d = state.usage.groups; if (!d?.events?.length) return [];
  const ix = Object.fromEntries((d.fields || ['at', 'art', 'anbieter', 'gemeinde', 'lat', 'lon', 'anzahl', 'arten']).map((f, i) => [f, i]));
  const ref = DEMO && state.latest?.at ? state.latest.at : Date.now(), today = BERLIN_DAY.format(ref);
  const by = new Map();
  for (const e of d.events) {
    if (e[ix.art] !== 'deploy' || !(e[ix.at] > ref - 30 * 3600e3) || BERLIN_DAY.format(e[ix.at]) !== today) continue;
    const ags = e[ix.gemeinde], op = e[ix.anbieter];
    if ((state.scope !== 'DE' && ags !== state.scope) || (state.operator !== 'all' && op !== state.operator) || (state.type !== 'all' && !(e[ix.arten]?.[state.type] > 0))) continue;
    const a = by.get(`${ags}|${op}`) || { n: 0, veh: 0 }; a.n++; a.veh += e[ix.anzahl] || 0; by.set(`${ags}|${op}`, a);
  }
  return [...by].map(([k, a]) => { const [ags, op] = k.split('|'); return { cat: 'deploy', sev: 'info', w: a.n, n: `${fmt(a.n)}×`, short: t('app.sigShortDeploy', { op, ags: ` · ${muniName(ags)}` }), title: t('app.groupsDeployedTodayAvg', { op, ags: muniName(ags), n: fmt(a.n), v3: fmt(a.veh / a.n) }), text: t('app.atLeast5OfOperatorSVehicles', { n: GROUP_MIN, m: GROUP_M }), foot: t('app.derivedFromObservationNo') }; });
}
export const CATS = { get all() { return t('app.all'); }, get disabled() { return t('app.disabled2'); }, get energy() { return t('app.energy'); }, get stations() { return t('app.stations'); }, get jump() { return t('app.fleetJump'); }, get deploy() { return t('app.deployment'); }, get data() { return t('app.dataQuality'); } };
export const SEV_LABEL = { get bad() { return t('app.critical'); }, get warn() { return t('app.notable'); }, get info() { return t('app.note'); } };
// compact: Briefing-Karte mit Zahl + einer Zeile; Begründung und Grundlage unter „Warum?“
export function sigCard(s, compact = false) {
  const head = `<div class="k">${esc(CATS[s.cat] || s.cat)} · ${SEV_LABEL[s.sev] || esc(s.sev)}</div>`;
  // kompakt: Zahl + Kurztitel (ohne die Zahl ein zweites Mal); Zustandsmeldungen ohne Zahl tragen ein Zeichen
  const lead = s.icon || s.n == null ? `<span class="num ico" aria-hidden="true">${s.sev === 'bad' ? '!' : s.sev === 'warn' ? '!' : 'i'}</span>` : `<span class="num">${esc(s.n)}</span>`;
  if (compact) return `<div class="card ${esc(s.sev)}">${head}<b>${lead} ${esc(s.short || s.title)}</b><details><summary>${t('app.why')}</summary><p>${esc(s.text)}</p><div class="foot">${esc(s.foot)}</div></details></div>`;
  return `<div class="card ${esc(s.sev)}">${head}<b>${esc(s.title)}</b><p>${esc(s.text)}</p><div class="foot">${esc(s.foot)}</div></div>`;
}
export function renderSignals() {
  const all = computeSignals();
  const counts = {}; for (const s of all) counts[s.cat] = (counts[s.cat] || 0) + 1;
  setChips($('#sig-filter'), 'data-cat', Object.entries(CATS).map(([k, l]) => `<button class="chip ${sigFilter === k ? 'on' : ''}" aria-pressed="${sigFilter === k}" data-cat="${k}">${l} <span class="mono">${k === 'all' ? all.length : counts[k] || 0}</span></button>`).join(''));
  const list = (sigFilter === 'all' ? all : all.filter(s => s.cat === sigFilter)).slice(0, 60);
  $('#sig-cards').innerHTML = list.length ? list.map(s => sigCard(s)).join('') : `<div class="empty" style="grid-column:1/-1">${t('app.noSignalsInSelectedFilter', { v0: sigFilter !== 'all' ? t('app.chooseCategoryAll') : t('app.nothingNotableInAreaRightNow') })}</div>`;
  renderStability();
}
export async function renderStability() {
  const day = state.histDay || state.histIndex?.days?.slice(-1)[0];
  const tb = $('#tbl-stability tbody');
  if (!day) { tb.innerHTML = emptyRow(7, t('app.noHistoryYet'), t('app.itStartsWithFirstCollector')); return; }
  const h = await loadHistory(day); if (!h) { tb.innerHTML = emptyRow(7, t('app.historyNotLoadable'), t('app.reloadPageLater', { v0: failedText(`history/${day}.json`) })); return; }
  const byOp = new Map();
  for (const [k, ser] of Object.entries(h.series)) { const [ags, op, ty] = k.split('|'); if (state.scope === 'DE' ? ags !== 'DE' : ags !== state.scope) continue; if (state.operator !== 'all' && op !== state.operator) continue; if (state.type !== 'all' && ty !== state.type) continue; const name = state.scope === 'DE' ? (TYPE[ty] || ty) : op; const arr = byOp.get(name) || new Array(h.t.length).fill(null); alignSeries(ser.available, h.t.length).forEach((v, i) => { if (v != null) arr[i] = (arr[i] || 0) + v; }); byOp.set(name, arr); }
  tb.innerHTML = [...byOp].map(([name, arr]) => { const v = arr.filter(x => x != null); if (!v.length) return ''; const min = Math.min(...v), max = Math.max(...v), last = v[v.length - 1], first = v[0]; const d = last - first; const drop = max && (max - last) / max; return `<tr><td>${esc(name)}</td><td class="n">${v.length}</td><td class="n">${fmt(min)}</td><td class="n">${fmt(max)}</td><td class="n">${fmt(last)}</td><td class="n">${d > 0 ? '+' : ''}${fmt(d)}</td><td class="small">${drop >= 0.3 ? `<span class="pill stale">${t('app.belowDailyMaximum', { v0: pctf(max - last, max) })}</span>` : v.length < 3 ? `<span class="muted">${t('app.tooFewPoints')}</span>` : `<span class="muted">${t('app.stable')}</span>`}</td></tr>`; }).join('') || emptyRow(7, t('app.noPointsInFilter'), t('app.setOperatorOrVehicleTypeTo'));
}
