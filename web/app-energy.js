// Dashboard: Energie niedrig: eine Regel für Übersicht, Briefing, Leistung, Karte und CSV (S3.9: aus web/app.js geschnitten, Einstieg bleibt web/app.js).
import * as R from './pulse-report.js';
import { t } from './i18n.js';
import { $, TYPE, abbr, ageText, emptyTip, esc, fmt, foldSeries, isClient, opColor, palette, pctf, state, timeText } from './app-core.js';
import { cached, emptyRow, failedText, loadHistory, setChips } from './app-load.js';
import { USABLE, effStatus, liveRec, muniName, operatorRows, scopeGroups, sourcesForScope, sumStats } from './app-scope.js';
import { markDirty } from './app-router.js';
import { tile } from './app-lang.js';
import { hourOf } from './app-calib.js';
import { chartSpec, tableButton } from './charttip.js';

// ---------- Energie niedrig: eine Regel für Übersicht, Briefing, Leistung, Karte und CSV (lib/pulse-report.js energyLow) ----------
// Wie die Disposition (lib/pulse-ops.js needsSwap): Ladestand < 20 % UND Reichweite < 5 km, wo beides gemeldet ist; sonst entscheidet die
// gemeldete Angabe. Anbieter, deren Feeds nur Reichweite melden (Lime; die Kernbibliothek leitet für sie einen Ladestand aus Reichweite ÷
// Maximalreichweite ab), zählen nur über die Reichweite. Gezählt je Fahrzeug: Live-Abruf (state.live.vehicles) oder Sammler-Stand
// (ops/<Land>.json; für Deutschland alle Länder, geteilter Cache mit Karte und Disposition). Fehlt die Datei: Rückfall auf die Zähler der
// Gruppe – genau, wo nur eine Angabe vorliegt; mit beiden Angaben höchstens min(Ladestand niedrig, Reichweite niedrig), als „≈“ markiert.
export const RANGE_ONLY_OPS = new Set(R.RANGE_ONLY_OPS);
// Nur Reichweite je Anbieter: dieselbe Regel wie der Sammler (R.rangeOnlyOperators über latest.sources, = latest.energy.rangeOnlyOps); je Fahrzeug
// zusätzlich, wenn der Ladestand nur abgeleitet ist (v.batteryDerived; ops/<Land>.json und Momentaufnahmen tragen dann keinen Ladestand)
export let roCache = null;
export const rangeOnly = (op) => { if (roCache?.at !== state.latest?.at) roCache = { at: state.latest?.at, set: R.rangeOnlyOperators(state.latest?.sources) }; return roCache.set.has(op); };
export const energyLimits = () => (state.mode === 'live' && state.live ? { charge: state.thresholds.charge, range: state.thresholds.range } : { charge: state.latest?.thresholds?.chargeThreshold ?? R.ENERGY_CHARGE, range: state.latest?.thresholds?.rangeThreshold ?? R.ENERGY_RANGE_KM });
export const ENERGY = new Map();
 export let energyWait = 0; // `${Stand}|${Land}` → Map(Gruppe → Zähler) | 'loading' | null (Datei fehlt)
export function energyLand(land) {
  const k = `${state.latest?.at}|${land}`;
  if (!ENERGY.has(k)) {
    ENERGY.set(k, 'loading'); energyWait++;
    const lim = { charge: state.latest?.thresholds?.chargeThreshold ?? R.ENERGY_CHARGE, range: state.latest?.thresholds?.rangeThreshold ?? R.ENERGY_RANGE_KM }; // Sammler-Stand: Grenzen des Sammlers
    cached(`ops/${land}.json`, 90000).then(r => { ENERGY.set(k, r.ok && r.json?.vehicles ? R.energyFromOps(r.json, { charge: lim.charge, range: lim.range, rangeOnly }) : null); }, () => ENERGY.set(k, null))
      .finally(() => { if (--energyWait === 0) markDirty('live', 'lab', 'signals'); });
  }
  return ENERGY.get(k);
}
export let liveEnergy = null;
export function liveEnergyGroups() {
  if (!(state.mode === 'live' && state.live?.vehicles?.length)) return null;
  const lim = energyLimits(), key = `${state.live.at}|${lim.charge}|${lim.range}|${state.live.vehicles.length}`;
  if (liveEnergy?.key !== key) {
    const m = new Map();
    for (const v of state.live.vehicles) { const k = `${v.ags}|${v.operator}|${v.type}`; const e = m.get(k) || R.emptyEnergy(); R.addEnergy(e, v.batteryPct, v.rangeKm, { ...lim, rangeOnly: rangeOnly(v.operator) || !!v.batteryDerived, rangeDerived: !!v.rangeDerived, rangeLimit: v.rangeLimitKm ?? null, rangeFlat: !!v.rangeFlat, type: v.type }); m.set(k, e); }
    liveEnergy = { key, map: m };
  }
  return liveEnergy.map;
}
// Rückfall ohne Einzelfahrzeuge: aus den Zählern der Gruppe
export function energyFromStats(op, st) {
  if (rangeOnly(op) || !st.batteryKnown) return { known: st.rangeKnown || 0, low: st.lowRange || 0, rangeOnly: st.rangeKnown || 0, rangeOnlyLow: st.lowRange || 0 };
  if (!st.rangeKnown) return { known: st.batteryKnown, low: st.lowBattery, rangeOnly: 0, rangeOnlyLow: 0 };
  return { known: Math.max(st.batteryKnown, st.rangeKnown), low: Math.min(st.lowBattery, st.lowRange), rangeOnly: Math.max(0, st.rangeKnown - st.batteryKnown), rangeOnlyLow: 0, approx: true };
}
export function groupEnergy(k, st) {
  const live = liveEnergyGroups(); if (live?.has(k)) return live.get(k);
  // Sammler zählt Energie je Gruppe selbst (latest.energy gesetzt: fehlendes Feld = 0) → keine ops/<Land>.json mehr für Kacheln, Signale, Leistung
  if (state.latest?.energy) { const g = state.latest.groups?.[k] || st || {}; return { known: g.energyKnown || 0, low: g.energyLow || 0, rangeOnly: g.energyRangeOnly || 0, rangeOnlyLow: g.energyRangeOnlyLow || 0 }; }
  const land = state.latest?.municipalities?.[k.split('|')[0]]?.state;
  const m = land ? energyLand(land) : null;
  if (m === 'loading') return { pending: true };
  if (m instanceof Map) return m.get(k) || R.emptyEnergy(); // Gruppe ohne Fahrzeugliste (z. B. nur Stationen): keine Energieangabe
  return energyFromStats(k.split('|')[1], st);
}
// Energie über die Gruppen im Gebiet und Filter; keep(key) wählt zusätzlich aus (Anbieter, Art)
export function energyFor(keep = null) {
  const out = { ...R.emptyEnergy(), pending: false, approx: false };
  for (const [k, st] of scopeGroups()) { if (keep && !keep(k)) continue; const e = groupEnergy(k, st); if (e.pending) { out.pending = true; continue; } if (e.approx) out.approx = true; for (const f of ['known', 'low', 'rangeOnly', 'rangeOnlyLow']) out[f] += e[f] || 0; }
  return out;
}
export const energyOfOp = (op) => energyFor(k => k.split('|')[1] === op);
export const energyRule = () => { const l = energyLimits(); return t('app.chargeAndRangeKm', { charge: fmt(l.charge), range: fmt(l.range) }); };
export const energyVal = (e) => (e.pending ? '…' : e.known ? `${e.approx ? '≈ ' : ''}${pctf(e.low, e.known)}` : t('common.na'));
export const energySub = (e) => (e.pending ? t('app.evaluatingEnergyPerVehicle') : e.known ? t('app.ofWithEnergyData', { v0: energyRule(), low: fmt(e.low), known: fmt(e.known), v3: e.rangeOnly ? ` ${t('app.ofWhichRangeOnly', { rangeOnly: fmt(e.rangeOnly) })}` : '', v4: e.approx ? `, ${t('app.upperBoundWithoutIndividual')}` : '' }) : t('app.noEnergyData'));
export function renderLab() {
  const groups = scopeGroups(); const st = sumStats([...groups.values()]);
  // Energie niedrig je Fahrzeug nach der Regel der Disposition; Anbieter nur mit Reichweite (Lime) zählen über die Reichweite mit
  const en = energyFor(); const lim = energyLimits();
  // Kacheln ohne Doppelung zur Übersicht (dort: verfügbar, gesperrt, Stationen, Energie niedrig, Quellen): Reichweite, Rückgabeplätze, Datenalter, Quellenqualität
  const recs = sourcesForScope().filter(r => state.operator === 'all' || r.operator === state.operator).map(r => liveRec(r.id) || r);
  const eff = recs.map(effStatus), use = eff.filter(e => USABLE.has(e.status) && e.age != null).map(e => e.age).sort((a, b) => a - b);
  const qual = recs.filter((r, i) => USABLE.has(eff[i].status) && Number.isFinite(r.quality)).map(r => r.quality);
  $('#lab-tiles').innerHTML = [
    tile(t('app.rangeBelowKm', { range: fmt(lim.range) }), st.rangeKnown ? pctf(st.lowRange, st.rangeKnown) : t('common.na'), st.rangeKnown ? t('app.ofWithRangeRegardlessOf', { lowRange: fmt(st.lowRange), rangeKnown: fmt(st.rangeKnown) }) : t('app.noRangeData')),
    tile(t('app.labFreeDocks'), st.stations ? fmt(st.stationDocks) : '—', st.stations ? t('app.labFreeDocksSub', { n: fmt(st.stations), full: fmt(st.stationsFull) }) + (st.stationDocksBad ? `, ${t('app.docksBad', { n: fmt(st.stationDocksBad) })}` : '') : t('app.noStationsInFilter')),
    tile(abbr(t('app.labDataAge'), 'fresh'), use.length ? ageText(use[Math.floor(use.length / 2)]) : '—', use.length ? t('app.labDataAgeSub', { n: fmt(use.length) }) : t('app.noSourcesInArea')),
    tile(t('app.labQuality'), qual.length ? fmt(qual.reduce((a, b) => a + b, 0) / qual.length) : '—', qual.length ? t('app.labQualitySub', { n: fmt(qual.length) }) : t('app.noSourcesInArea')),
  ].join('');
  // Fahrzeugarten
  const byType = new Map();
  for (const [k, s] of groups) { const ty = k.split('|')[2]; byType.set(ty, [...(byType.get(ty) || []), s]); }
  $('#tbl-types tbody').innerHTML = [...byType].map(([ty, list]) => { const s = sumStats(list); const e = energyFor(k => k.split('|')[2] === ty); return `<tr><td>${esc(TYPE[ty] || ty)}</td><td class="n">${fmt(s.total)}</td><td class="n">${fmt(s.available)}<div class="sub-line">${pctf(s.available, s.total)}</div></td><td class="n">${fmt(s.disabled)}</td><td class="n">${energyVal(e)}<div class="sub-line">${!e.pending && e.known ? `n = ${fmt(e.known)}${e.rangeOnly ? `, ${t('app.rangeOnly2', { rangeOnly: fmt(e.rangeOnly) })}` : ''}` : ''}</div></td><td class="n">${s.rangeKnown ? pctf(s.lowRange, s.rangeKnown) : t('common.na')}</td></tr>`; }).sort().join('') || emptyRow(6, t('app.noVehiclesInFilter'), t('app.setVehicleTypeOrOperatorTo'));
  // Stationen je Anbieter
  const byOp = new Map();
  for (const [k, s] of groups) { const op = k.split('|')[1]; byOp.set(op, [...(byOp.get(op) || []), s]); }
  $('#tbl-stations tbody').innerHTML = [...byOp].map(([op, list]) => ({ op, s: sumStats(list) })).filter(x => x.s.stations).map(({ op, s }) => `<tr><td><span class="op"><i style="background:${opColor(op)}"></i>${esc(op)}</span></td><td class="n">${fmt(s.stations)}</td><td class="n">${fmt(s.stationsRenting)}</td><td class="n" title="${esc(emptyTip(s))}">${fmt(s.stationsEmpty)}${s.stationsEmptyDock != null ? `<div class="sub-line">${t('app.docksParkingZones', { stationsEmptyDock: fmt(s.stationsEmptyDock), v1: fmt(s.stationsEmptyVirtual) })}</div>` : ''}</td><td class="n">${fmt(s.stationsFull)}</td><td class="n">${fmt(s.stationPhysical)}</td><td class="n">${fmt(s.stationBookable)}</td><td class="n">${fmt(s.stationDocks)}</td></tr>`).join('') || emptyRow(8, t('app.noStationsInFilter2'), t('app.stationsAreMostlyReportedBy'));
  // Scorecard
  const rows = operatorRows().filter(r => !r.gap);
  // Score = gleich gewichtetes Mittel der vorhandenen Teilwerte; die Gewichte stehen im Kopf, die genutzten Teile je Zeile im Tooltip
  $('#tbl-score tbody').innerHTML = rows.map(r => { const s = r.st; const avail = s.total ? s.available / s.total : null; const dis = s.total ? s.disabled / s.total : null; const e = energyOfOp(r.op); const low = !e.pending && e.known ? e.low / e.known : null; const emp = s.stations ? s.stationsEmpty / s.stations : null;
    const named = [[t('app.available2'), avail != null ? avail * 100 : null], [t('app.n100DisabledRate'), dis != null ? 100 - dis * 100 : null], [t('app.n100LowEnergy'), low != null ? 100 - low * 100 : null], [t('app.n100EmptyStations'), emp != null ? 100 - emp * 100 : null], [t('app.sourceQuality'), r.quality]].filter(x => x[1] != null);
    const score = named.length ? Math.round(named.reduce((a, x) => a + x[1], 0) / named.length) : null;
    const how = named.length ? t('app.weightEach', { v0: named.map(([l, v]) => `${l} ${fmt(v)}`).join(', '), v1: fmt(100 / named.length) }) : '';
    return `<tr><td><span class="op"><i style="background:${opColor(r.op)}"></i>${esc(r.op)}</span></td><td class="n">${fmt(s.total)}</td><td class="n">${avail == null ? '—' : pctf(s.available, s.total)}</td><td class="n">${dis == null ? '—' : pctf(s.disabled, s.total)}</td><td class="n">${e.pending ? '…' : low == null ? t('common.na') : energyVal(e)}</td><td class="n"${emp == null ? '' : ` title="${esc(emptyTip(s))}"`}>${emp == null ? '—' : pctf(s.stationsEmpty, s.stations)}</td><td class="n">${esc(r.quality ?? '—')}</td><td class="n" title="${esc(how)}"><b>${score ?? '—'}</b><div class="sub-line">${t('app.partialScores', { length: named.length })}</div></td></tr>`; }).join('') || emptyRow(8, t('app.noOperatorsInFilter'), t('app.chooseAreaWithService'));
  renderHistory();
}
// Ansicht „Städte“: Gebietsvergleich aller Gemeinden (Sammler-Stand); das gewählte Gebiet steht fett und immer in der Liste
export function renderCities() {
  const munis = state.latest?.municipalities || {};
  const src = new Map(Object.entries(state.latest?.groups || {})); // Gebietsvergleich immer aus dem Sammler-Stand (vollständig)
  const per = new Map();
  for (const [k, s] of src) { const [ags, op, ty] = k.split('|'); if (ags === 'DE' || ags === 'unbekannt') continue; if (state.operator !== 'all' && op !== state.operator) continue; if (state.type !== 'all' && ty !== state.type) continue; const m = per.get(ags) || { ags, available: 0, ops: new Set(), scooter: 0, bikes: 0, other: 0 }; m.available += s.available; m.ops.add(op); if (ty === 'scooter') m.scooter += s.available; else if (ty === 'bike' || ty === 'ebike' || ty === 'cargo') m.bikes += s.available; else m.other += s.available; per.set(ags, m); } // Audit UXM-03: Autos und Roller nicht als Räder
  const sorted = [...per.values()].sort((a, b) => b.available - a.available), list = sorted.slice(0, 25);
  if (state.scope !== 'DE' && per.has(state.scope) && !list.includes(per.get(state.scope))) list.push(per.get(state.scope));
  $('#cities-title').textContent = state.scope === 'DE' ? t('app.cityAndAreaComparison') : t('app.areaComparisonInContext', { v0: muniName(state.scope) });
  $('#tbl-cities tbody').innerHTML = list.map(m => { const mi = munis[m.ags]; const pop = mi?.pop; return `<tr${m.ags === state.scope ? ' style="font-weight:600"' : ''}><td><a href="#live" class="pick-muni" data-ags="${esc(m.ags)}">${esc(mi?.name || m.ags)}</a> <span class="muted">${esc(mi?.state || '')}</span></td><td class="n">${fmt(m.available)}</td><td class="n">${pop ? fmt((m.available / pop) * 1e4, 1) : '—'}</td><td class="n">${m.ops.size}</td><td class="n">${fmt(m.scooter)}</td><td class="n">${fmt(m.bikes)}</td><td class="n">${fmt(m.other)}</td></tr>`; }).join('') || emptyRow(7, t('app.noMunicipalitiesInFilter'), state.latest ? t('app.setOperatorOrVehicleTypeTo') : failedText('latest.json'));
}
export async function renderHistory() {
  const idx = state.histIndex; const box = $('#chart-hist');
  if (!idx?.days?.length) { box.innerHTML = `<div class="empty">${t('app.noCollectorPointsYetHistory')}</div>`; return; }
  const day = state.histDay || idx.days[idx.days.length - 1];
  setChips($('#hist-days'), 'data-day', idx.days.slice(-7).map(d => `<button class="chip ${d === day ? 'on' : ''}" aria-pressed="${d === day}" data-day="${esc(d)}">${esc(d.slice(8))}.${esc(d.slice(5, 7))}.</button>`).join(''));
  const h = await loadHistory(day);
  if (!h) { box.innerHTML = `<div class="empty">${t('app.historyNotLoadableChoose', { failedText: esc(failedText(`history/${day}.json`)) })}</div>`; return; }
  const byOp = new Map();
  for (const [k, ser] of Object.entries(h.series)) {
    const [ags, op, ty] = k.split('|');
    if (state.scope === 'DE' ? ags !== 'DE' : ags !== state.scope) continue;
    if (state.scope === 'DE' && state.operator !== 'all') continue; // DE-Totale je Art, kein Anbieter
    if (state.operator !== 'all' && op !== state.operator) continue;
    if (state.type !== 'all' && ty !== state.type) continue;
    const name = state.scope === 'DE' ? (TYPE[ty] || ty) : op;
    const arr = byOp.get(name) || new Array(h.t.length).fill(null);
    alignSeries(ser.available, h.t.length).forEach((v, i) => { if (v != null) arr[i] = (arr[i] || 0) + v; });
    byOp.set(name, arr);
  }
  // S4.6: Farbe nach Anbieter bzw. Fahrzeugart (fester Platz), nicht nach Rang; graue Anbieter als eine Reihe „Weitere“
  const tyIdx = (name) => Object.values(TYPE).indexOf(name);
  const series0 = [...byOp].map(([name, values]) => ({ name, values, color: state.scope === 'DE' ? palette(Math.max(0, tyIdx(name))) : opColor(name) })).sort((a, b) => Math.max(...b.values.filter(x => x != null), 0) - Math.max(...a.values.filter(x => x != null), 0));
  const series = state.scope === 'DE' ? series0 : foldSeries(series0, t('app.moreOperators'));
  const changes = (state.latest?.sources || []).filter(r => r.sourceChanged && (state.scope === 'DE' || (r.municipalities || []).includes(state.scope)));
  // Verlaufsdateien laufen nach UTC-Tag (ab 01:00 bzw. 02:00 Uhr), Ereignisdateien unter Nutzung nach Berliner Tag – daher andere Laufzahlen je Tag
  const utcStart = timeText(Date.parse(`${day}T00:00:00Z`));
  const sub = $('#hist-sub'); sub.innerHTML = isClient() ? t('app.availableVehiclesOn', { join: esc(day.split('-').reverse().join('.')), v1: timeText(h.t[0]), v2: timeText(h.t[h.t.length - 1]), v3: abbr(t('app.dataPoints', { length: fmt(h.t.length) }), 'point') })
    : t('app.onHistoryDayStartsUtcUsage', { v0: abbr(t('app.collectorPoints', { length: fmt(h.t.length) }), 'point'), join: esc(day.split('-').reverse().join('.')), v2: timeText(h.t[0]), v3: timeText(h.t[h.t.length - 1]), utcStart, v5: changes.length ? `, ${t('app.sourceChangesComparison', { length: changes.length })}` : '' });
  box.innerHTML = lineChart(h.t, series, chartWidth(box, () => renderHistory()));
  $('#chart-legend').innerHTML = series.map((s, i) => `<span><i class="dot" style="background:${s.color || palette(i)}"></i>${esc(s.name)} <span class="mono">${fmt(s.values.filter(x => x != null).pop())}</span></span>`).join('');
}
// Verlaufsreihe auf die Länge von t bringen: Die DE-Summen (DE||Art) haben im aktuellen Datenstand je Lauf einen zusätzlichen null-Eintrag
// (Sammler schreibt null und den Wert); dann die Werte rechtsbündig auf die Läufe legen. Gleich lange Reihen bleiben unverändert.
export function alignSeries(arr, n) {
  if (!Array.isArray(arr) || arr.length === n) return arr || [];
  const v = arr.filter(x => x != null);
  return v.length >= n ? v.slice(-n) : [...new Array(n - v.length).fill(null), ...v];
}
// Achsenwerte auf runde Schritte (1, 2, 2,5, 5 × 10^k): z. B. 0/100/200/300/400 statt 96/191/287/383
export function niceTicks(max, n = 4) {
  if (!(max > 0)) return { step: 1, top: n, ticks: Array.from({ length: n + 1 }, (_, i) => i) };
  const raw = max / n, p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  const top = Math.ceil(max / step) * step;
  return { step, top, ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step) };
}
// Diagramme in echten Pixeln: Breite = Breite des Kastens, Schrift bleibt 11 px (statt mit dem viewBox auf 4–15 px zu skalieren).
// Ändert sich die Breite um mehr als 24 px (Fenster, Drehen), zeichnet der Kasten sich neu.
export const CHART_RO = typeof ResizeObserver === 'function' ? new ResizeObserver((es) => { for (const e of es) { const el = e.target, w = Math.round(e.contentRect.width); if (w > 0 && el._cw && Math.abs(el._cw - w) > 24) { el._cw = w; try { el._redraw?.(); } catch (err) { console.error('Diagramm', err); } } } }) : null;
export function chartWidth(box, redraw) {
  const w = Math.round(box?.clientWidth || 0) || 900;
  if (box) { box._cw = w; box._redraw = redraw; CHART_RO?.observe(box); }
  return Math.max(280, w);
}
// Kurzfassung für Screenreader: je Reihe letzter Wert sowie Min/Max (die Werte stecken sonst nur in den Hover-Flächen)
export const seriesSummary = (series, f = (v) => fmt(v)) => series.map(s => { const v = s.values.filter(x => x != null); return v.length ? t('app.chartSeriesSummary', { name: s.name, last: f(v[v.length - 1]), min: f(Math.min(...v)), max: f(Math.max(...v)) }) : null; }).filter(Boolean).join('; ');
export function lineChart(tq, series, W = 900) {
  const H = W < 520 ? 200 : 260, P = { l: 48, r: 12, t: 12, b: 26 };
  const vals = series.flatMap(s => s.values).filter(x => x != null);
  if (!vals.length) return `<div class="empty">${t('app.noPointsForThisFilterSet')}</div>`;
  const nt = niceTicks(Math.max(...vals) * 1.04 || 1), max = nt.top, min = 0;
  // Zeitachse statt Punktindex: Pausen über 45 Min. bleiben sichtbar (grau) und die Linie wird dort unterbrochen
  const t0 = tq[0], t1 = Math.max(tq[tq.length - 1], t0 + 3600e3), GAP = 45 * 60e3;
  const x = (i) => P.l + ((tq[i] - t0) / (t1 - t0)) * (W - P.l - P.r), xt = (ms) => P.l + ((ms - t0) / (t1 - t0)) * (W - P.l - P.r);
  const y = (v) => P.t + (1 - (v - min) / (max - min)) * (H - P.t - P.b);
  let g = '';
  for (let i = 1; i < tq.length; i++) if (tq[i] - tq[i - 1] > GAP) { const w = x(i) - x(i - 1); g += `<rect class="gap" x="${x(i - 1).toFixed(1)}" y="${P.t}" width="${w.toFixed(1)}" height="${H - P.t - P.b}"/>${w > 60 ? `<text x="${(x(i - 1) + w / 2).toFixed(1)}" y="${P.t + 12}" text-anchor="middle">${t('app.notMeasured')}</text>` : ''}`; }
  for (const v of nt.ticks) g += `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text x="${P.l - 6}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${fmt(v, nt.step < 1 ? 1 : 0)}</text>`;
  // volle Stunden (Berliner Zeit; Stundengrenzen fallen mit UTC zusammen)
  // Abstand der Stundenmarken nach Breite: höchstens eine Beschriftung je ≈ 56 px
  const span = t1 - t0, fit = Math.max(1, Math.floor((W - P.l - P.r) / 56)), stepH = [1, 2, 3, 4, 6, 12, 24].find(s => span / (s * 3600e3) <= fit) || 24;
  for (let ms = Math.ceil(t0 / 3600e3) * 3600e3; ms <= t1; ms += 3600e3) if (!(hourOf(ms) % stepH)) g += `<text x="${xt(ms).toFixed(1)}" y="${H - 8}" text-anchor="middle">${timeText(ms)}</text>`;
  if (span <= 3600e3 * 1.5) g += `<text x="${x(0).toFixed(1)}" y="${H - 8}" text-anchor="start">${timeText(t0)}</text>`;
  series.forEach(s => { if (s.values.length > tq.length) s.values = s.values.slice(0, tq.length); }); // nie über die Zeitachse hinaus
  const paths = series.map((s, i) => { let d = '', open = false; s.values.forEach((v, j) => { if (v == null || (j && tq[j] - tq[j - 1] > GAP)) open = false; if (v == null) return; d += `${open ? 'L' : 'M'}${x(j).toFixed(1)} ${y(v).toFixed(1)} `; open = true; }); const last = s.values.map((v, j) => [v, j]).filter(([v]) => v != null).pop(); const dots = tq.length <= 12 ? s.values.map((v, j) => v == null ? '' : `<circle cx="${x(j).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.5" fill="${s.color || palette(i)}"/>`).join('') : ''; return `<path d="${d}" fill="none" stroke="${s.color || palette(i)}" stroke-width="2" stroke-linejoin="round"/>${dots}${last ? `<circle cx="${x(last[1]).toFixed(1)}" cy="${y(last[0]).toFixed(1)}" r="3.5" fill="${s.color || palette(i)}"/>` : ''}`; }).join('');
  // S4.5: alle Werte je Sammler-Punkt im gemeinsamen Hover-Layer (web/charttip.js), auch als Tabelle; Pausen über 45 Min. im Tooltip
  const cols = series.map((s, i) => s.color || palette(i));
  const sp = chartSpec({ n: tq.length, x, top: P.t, bottom: H - P.b, head: (i) => (i && tq[i] - tq[i - 1] > GAP ? t('ct.afterGap', { at: timeText(tq[i]), from: timeText(tq[i - 1]) }) : timeText(tq[i])), label: t('app.historyOfAvailableVehicles'), colHead: t('ct.timeCol'), cols: series.map(s => s.name),
    cell: (i, k) => (series[k].values[i] == null ? '–' : fmt(series[k].values[i])), rows: (i) => series.map((s, k) => ({ color: cols[k], label: s.name, value: s.values[i] == null ? '–' : fmt(s.values[i]), sort: s.values[i] ?? -1 })) });
  return `<svg class="chart" data-px="1" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" ${sp.attrs} aria-label="${esc(`${t('app.historyOfAvailableVehicles')}. ${seriesSummary(series)}`)}">${g}${paths}</svg>${tableButton(sp.id)}`;
}
