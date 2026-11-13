// Dashboard: Nutzung & Bewegung, Umsatz & Kennzahlen (S3.9: aus web/app.js geschnitten, Einstieg bleibt web/app.js).
import * as E from './pulse-econ.js';
import * as K from './pulse-calib.js';
import * as UI from './ui-shared.js';
import * as R from './pulse-report.js';
import { t, tx, lang, dateFmt } from './i18n.js';
import { totalsDoc } from './pulse-split.js';
import { $, $$, GLOSS, QS, TYPE, abbr, dateTimeText, esc, flagText, fmt, isClient, opColor, palette, pctf, sig2, state, timeText } from './app-core.js';
import { FC_dayOfNow, cached, emptyRow, failedText, loadDaily, loadHistory, setChips } from './app-load.js';
import { muniName } from './app-scope.js';
import { mod, rpCtx } from './app-router.js';
import { tile } from './app-lang.js';
import { chartWidth } from './app-energy.js';
import { BERLIN_DAY } from './app-signals.js';
import { GAP_MS, T_add, T_empty, atLeast, calibAll, calibFor, dayNote, hourChart, hourMask, hourOf, isGapRun, loadWeather, renderArchive, renderCellsTable, renderMbMatrix, renderQuota } from './app-calib.js';

// ---------- Nutzung & Bewegung ----------
state.usage = { index: null, day: /^\d{4}-\d{2}-\d{2}$/.test(QS.get('day') || '') ? QS.get('day') : null, docs: {}, cells: {}, idle: null, idleLong: null, quota: null, pricing: null, zonesIndex: null, zones: {}, reliability: null, consistency: null, weather: {} };
// Alle Lader über den Promise-Cache: parallele Aufrufer teilen sich einen Download, fehlende Dateien werden nicht je Aufruf neu angefragt
export async function loadUsageIndex() { if (!state.usage.index) { const r = await cached('events/index.json', 25000); state.usage.index = r.json || { days: [], cellDays: [] }; } return state.usage.index; }
export async function loadEvents(day) { if (!(day in state.usage.docs)) { const r = await cached(`events/${day}.json`, 60000); state.usage.docs[day] = r.json || null; } return state.usage.docs[day]; }
// S3.8: Ereignisse eines Tages nur für ein Land (events/<Tag>/<Land>.json, Kopf wie die Tagesdatei); fehlt die Teilung (älterer Datenstand), die ganze Datei
export async function loadEventsState(day, st) { const c = (state.usage.docsSt ??= {}), k = `${day}/${st}`; if (!(k in c)) { const r = await cached(`events/${day}/${st}.json`, 60000); c[k] = r.json || await loadEvents(day); } return c[k]; }
export async function loadCells(day, st) { const k = `${day}/${st}`; if (!(k in state.usage.cells)) { const r = await cached(`cells/${day}/${st}.json`, 60000); state.usage.cells[k] = r.json || null; } return state.usage.cells[k]; }
export async function loadOnce(name, file, timeout = 60000) { if (state.usage[name] === undefined || state.usage[name] === null) { const r = await cached(file, timeout); state.usage[name] = r.json || null; } return state.usage[name]; }
export const scopeState = () => state.latest?.municipalities?.[state.scope]?.state || null;
export const groupInScope = (k) => { const [ags, op, ty] = k.split('|'); if (ags === 'DE') return false; if (state.scope !== 'DE' && ags !== state.scope) return false; if (state.operator !== 'all' && op !== state.operator) return false; if (state.type !== 'all' && ty !== state.type) return false; return true; };
export const sum = (a) => a.reduce((x, y) => x + y, 0);
export const durText = (ms) => ms == null || !Number.isFinite(ms) ? '—' : ms < 3600e3 ? t('app.min', { v0: fmt(ms / 60e3) }) : t('app.h', { v0: fmt(ms / 3600e3, 1) });

// Vorauswahl Nutzung (und Umsatz der Disposition): letzter voller Messtag (≥ R.FULL_DAY_HOURS Stunden mit ≥ R.FULL_HOUR_MIN Min. Beobachtung,
// wie Bericht und Tagesgang-Profil), sonst der letzte abgeschlossene Tag. Der laufende Tag (Tag des jüngsten Sammler-Laufs) bleibt wählbar.
export const runningDay = (days) => { const d = days[days.length - 1]; return d && state.latest?.at && BERLIN_DAY.format(state.latest.at) === d ? d : null; };
export const partialHour = () => String(hourOf(state.latest.at)).padStart(2, '0'); // Ereignisse des laufenden Tages reichen bis zum Beginn dieser Stunde
export async function defaultUsageDay(days, st = null) {
  const run = runningDay(days), cand = days.slice(-7).filter(d => d !== run).reverse();
  for (const d of cand) { const doc = st ? await loadEventsState(d, st) : await loadEvents(d); if (doc && R.hourQuality(doc.runs, doc.gapHours).full) return d; }
  return cand[0] || days[days.length - 1];
}
export async function renderUsage() {
  const idx = await loadUsageIndex();
  const days = idx.days || [];
  const box = $('#usage-tiles');
  renderArchive().catch(() => {});
  if (!days.length) { renderIdle(days).catch(() => {}); renderQuota().catch(() => {}); box.innerHTML = ''; $('#usage-note').textContent = t('app.noEventDataYetCollectorNeeds'); $('#chart-usage').innerHTML = `<div class="empty">${t('app.noMovementsMeasuredYetThey')}</div>`; $('#tbl-usage tbody').innerHTML = `<tr><td colspan="6" class="empty">${t('app.noDataYetMovementsAppear')}</td></tr>`; $('#tbl-usage-more tbody').innerHTML = `<tr><td colspan="7" class="empty">${t('app.noDataYet2')}</td></tr>`; return; }
  const day = state.usage.day && days.includes(state.usage.day) ? state.usage.day : await defaultUsageDay(days);
  state.usage.day = day;
  // laufender Tag: „02.11. bis 08 Uhr“ (Ereignisse nur aus abgeschlossenen Stunden)
  const run = runningDay(days), runH = run ? partialHour() : null;
  setChips($('#usage-days'), 'data-uday', days.slice(-7).map(d => { const note = dayNote(d), dm = `${esc(d.slice(8))}.${esc(d.slice(5, 7))}.`, tip = [d === run ? t('app.usagePartialDayTip', { h: runH }) : '', note || ''].filter(Boolean).join(' · '); return `<button class="chip ${d === day ? 'on' : ''}${note ? ' special' : ''}" aria-pressed="${d === day}" data-uday="${esc(d)}"${tip ? ` title="${esc(tip)}"` : ''}>${d === run ? t('app.usageDayUntil', { d: dm, h: runH }) : dm}${note ? '<span aria-hidden="true"> ✱</span>' : ''}</button>`; }).join(''));
  const doc = await loadEvents(day);
  // Standzeiten (idle.json) und Stationsquote (stations-quota.json) hängen nicht an der Ereignisdatei: auch ohne sie zeichnen
  renderIdle(days).catch(e => console.error('Standzeiten', e)); renderQuota().catch(e => console.error('Stationsquote', e));
  if (!doc) {
    box.innerHTML = ''; $('#usage-note').textContent = t('app.chooseAnotherDayOrReload', { v0: failedText(`events/${day}.json`) });
    $('#chart-usage').innerHTML = `<div class="empty">${t('app.eventFileNotLoadableChoose')}</div>`;
    for (const [id, n] of [['#tbl-usage', 6], ['#tbl-usage-more', 7], ['#tbl-cells', 5], ['#tbl-econ', 6], ['#tbl-econ-more', 7]]) { const tb = $(`${id} tbody`); if (tb) tb.innerHTML = emptyRow(n, t('app.noEventDataForThisDay'), t('app.chooseAnotherDay')); }
    for (const id of ['#econ-tiles', '#econ-calib', '#econ-excl']) { const el = $(id); if (el) el.innerHTML = ''; }
    return;
  }
  const runs = doc.runs || [];
  // Messlücken: Stunden ohne Lauf oder mit Lauf nach > 45 Min. Pause zählen weder in Summen noch im Tagesgang (Vertrag 5, doc.gapHours)
  const mask = hourMask(runs, doc.gapHours);
  const observedMs = runs.filter(r => r[1] != null && !isGapRun(r) && mask.ok[hourOf(r[0])]).reduce((a, r) => a + Math.min(r[1], GAP_MS), 0);
  const gapH = mask.gap.filter(Boolean).length;
  const note = dayNote(day);
  $('#usage-note').innerHTML = t('app.collectorRunsOn0024Observed', { v0: note ? `<b>${esc(note)}</b> · ` : '', length: fmt(runs.length), join: esc(day.split('-').reverse().join('.')), observedMs: durText(observedMs), v4: timeText(runs[0]?.[0]), v5: timeText(runs[runs.length - 1]?.[0]), v6: gapH ? ` · ${t('app.notCounted', { v0: abbr(t('app.hAfterMeasurementGap', { gapH }), 'gap') })}` : '' });
  // Gruppen im Scope aggregieren
  const byOp = new Map(); const tot = T_empty();
  for (const [k, g] of Object.entries(doc.groups || {})) {
    if (!groupInScope(k)) continue;
    const [, op, ty] = k.split('|'); const name = state.scope === 'DE' && state.operator === 'all' ? (TYPE[ty] || ty) : op;
    const a = byOp.get(name) || T_empty(); T_add(a, g, mask.ok); byOp.set(name, a); T_add(tot, g, mask.ok);
  }
  // Eine Fahrten-Definition: gemessene Fahrtbeginne im Beobachtungszeitraum (Hochrechnung und RVD stehen unter Umsatz & Kennzahlen)
  const starts = sum(tot.start), ends = sum(tot.end), reloc = sum(tot.reloc), swaps = sum(tot.swap), pickups = sum(tot.pickup);
  box.innerHTML = [
    tile(t('app.tripsMeasured'), fmt(starts), (day === run ? `${t('app.usagePartialDay', { h: runH })} · ` : '') + t('app.inOfObservationTripEnds', { observedMs: durText(observedMs), ends: fmt(ends), v2: gapH ? ` · ${t('app.excludingHAfterMeasurement', { gapH })}` : '' })),
    tile(abbr(t('app.rebalancing'), 'reloc'), fmt(reloc), t('app.sameIdMoved150MDidNot')),
    tile(t('app.batterySwaps'), fmt(swaps), tot.swapWaitN ? t('app.avgBelow20UntilSwap', { v0: atLeast(tot.swapWaitCens, durText(tot.swapWaitSum / tot.swapWaitN)) }) + (tot.swapWaitCens ? ` · ${t('trk.censoredOf', { n: fmt(tot.swapWaitCens), of: fmt(tot.swapWaitN) })}` : '') : t('app.jumpFrom40To85AtSameSpot')),
    tile(abbr(t('app.pickups'), 'pickup'), fmt(pickups), t('app.disabledOrNearlyEmpty2')),
    tile(t('app.disabledDuration'), tot.disDurN ? atLeast(tot.disDurCens, durText(tot.disDurSum / tot.disDurN)) : '—', t('app.vehiclesReleasedAgain', { sum: fmt(sum(tot.disOff)) }) + (tot.disDurCens ? ` · ${t('trk.censoredOf', { n: fmt(tot.disDurCens), of: fmt(tot.disDurN) })}` : '')),
  ].join('');
  // Tagesgang: eigene Filter im Panel (Vorgabe aus den globalen Filtern); Änderung zeichnet nur das Diagramm neu
  let weather = null;
  if ($('#chk-weather').checked) weather = await loadWeather(day);
  state.usage.chartData = { doc, weather, runs, mask };
  usageChartOptions(doc); renderUsageChart(); renderMbMatrix();
  // Tabelle je Anbieter: sechs Standardspalten, der Rest unter „Weitere Spalten“
  const list = [...byOp].sort((a, b) => sum(b[1].start) - sum(a[1].start));
  const opCell = (name) => `<td><span class="op"><i style="background:${opColor(name)}"></i>${esc(name)}</span></td>`;
  $('#tbl-usage tbody').innerHTML = list.map(([name, a]) => `<tr>${opCell(name)}<td class="n">${fmt(sum(a.start))}</td><td class="n">${fmt(sum(a.end))}</td><td class="n">${fmt(sum(a.reloc))}</td><td class="n">${fmt(sum(a.swap))}</td><td class="n">${fmt(sum(a.pickup))}</td></tr>`).join('') || `<tr><td colspan="6" class="empty">${t('app.noEventsInFilterSetOperator')}</td></tr>`;
  $('#tbl-usage-more tbody').innerHTML = list.map(([name, a]) => { const modes = Object.entries(doc.srcModes || {}).filter(([id]) => (state.latest?.sources || []).some(r => r.id === id && r.operator === name && (state.scope === 'DE' || (r.municipalities || []).includes(state.scope)))).map(([, m]) => m); const mk = modes.includes('stable') ? 'stable' : modes.includes('rotating') ? 'rotating' : 'open', mode = { stable: t('app.stableIds'), rotating: t('app.rotatingIds'), open: t('app.open') }[mk];
    return `<tr>${opCell(name)}<td class="n">${a.tripDurN ? durText(a.tripDurSum / a.tripDurN) : '—'}</td><td class="n">${a.tripDistN ? `${fmt(a.tripDistSum / a.tripDistN / 1000, 1)} km` : '—'}</td><td class="n">${a.swapWaitN ? atLeast(a.swapWaitCens, durText(a.swapWaitSum / a.swapWaitN)) : '—'}</td><td class="n">${fmt(sum(a.disOff))}</td><td class="n">${a.disDurN ? atLeast(a.disDurCens, durText(a.disDurSum / a.disDurN)) : '—'}</td><td class="small">${mode}<div class="sub-line">${mk === 'stable' ? t('app.durationDistanceMeasurable') : mk === 'rotating' ? t('app.startDestinationCountsOnly') : t('app.tooFewRunsYet')}</div></td></tr>`; }).join('') || `<tr><td colspan="7" class="empty">${t('app.noEventsInFilter')}</td></tr>`;
  renderCellsTable(day); if (!isClient()) renderEcon(day, doc).catch(e => console.error('Umsatz', e)); // Kalibrierung steht nur unter Datenvertrauen › Quellen
}
// Standzeiten der verfügbaren Fahrzeuge (idle.json, Sammler-Stand), unabhängig vom gewählten Tag
export async function renderIdle(days) {
  const idle = await loadOnce('idle', 'idle.json');
  if (!idle) { $('#idle-bars').innerHTML = `<div class="empty">${esc(failedText('idle.json'))}</div>`; return; }
  // Klassen aus idle.json (ab 02.11.2026 sechs mit „> 72 h“, die Summe steht dahinter); censored = davon Mindestwerte (seit Beginn der Verfolgung unbewegt, Z6)
  const labels0 = idle.buckets || ['<2 h', '2–8 h', '8–24 h', '1–2 Tage', '>2 Tage'], nb = labels0.length;
  const ib = new Array(nb).fill(0), ic = new Array(nb).fill(0); let in_ = 0;
  for (const [k, a] of Object.entries(idle.groups || {})) { if (!groupInScope(k)) continue; for (let i = 0; i < nb; i++) ib[i] += a[i] || 0; in_ += a[nb] || 0; const c = idle.censored?.[k]; if (c) for (let i = 0; i < nb; i++) ic[i] += c[i] || 0; }
  const labels = labels0.map(l => l === '2–3 Tage' ? t('trk.idle23d') : l === '> 72 h' ? t('trk.idle72h') : tx(l)); // Beschriftungen aus idle.json (Sammler, deutsch)
  const imax = Math.max(1, ...ib), cn = ic.reduce((a, b) => a + b, 0);
  // Anteil der Mindestwerte hell am Ende des Balkens
  const bg = (i) => { const col = i >= 3 ? 'var(--warn)' : 'var(--accent)', cs = ib[i] ? ic[i] / ib[i] : 0, p = ((1 - cs) * 100).toFixed(1); return cs ? `linear-gradient(90deg,${col} ${p}%,color-mix(in srgb,${col} 35%,transparent) ${p}%)` : col; };
  const dt2 = (ms) => dateTimeText(ms, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }), ts = idle.trackStart;
  // Quellen ohne Standzeit (Z5) im Gebiet und für den Anbieter der Auswahl
  const unus = (idle.unusable || []).filter(id => { const r = (state.latest?.sources || []).find(x => x.id === id); return r && (state.scope === 'DE' || (r.municipalities || []).includes(state.scope)) && (state.operator === 'all' || r.operator === state.operator); });
  const cnote = ts ? `<div class="muted small" style="margin-top:4px">${t('trk.idleMeasurable', { start: dt2(ts), d48: dt2(ts + 48 * 3600e3), d72: dt2(ts + 72 * 3600e3), share: pctf(cn, in_) })}</div>` : '';
  $('#idle-bars').innerHTML = in_ ? labels.map((l, i) => `<div class="hbar"${ic[i] ? ` title="${esc(t('trk.idleClassCensored', { share: pctf(ic[i], ib[i]) }))}"` : ''}><span>${esc(l)}</span><div class="bar"><i style="width:${(ib[i] / imax) * 100}%;background:${bg(i)}"></i></div><span class="n mono">${pctf(ib[i], in_)}</span></div>`).join('') + `<div class="muted small" style="margin-top:6px">${t('app.availableVehiclesAsOfTime', { in_: fmt(in_), v1: timeText(idle.at), join: esc((days[0] || '').split('-').reverse().join('.')) })}</div>${cnote}${unus.length ? `<div class="muted small" style="margin-top:4px">${t('trk.idleUnusableNote', { n: fmt(unus.length) })}</div>` : ''}` : `<div class="empty">${t('app.noIdleTimesInFilterSet')}</div>`;
}
// Tagesgang-Filter: Anbieter und Arten mit Ereignissen im Gebiet am Tag; eigene Wahl bleibt, bis sich oben Gebiet, Anbieter oder Art ändern
export const inArea = (ags) => ags !== 'DE' && (state.scope === 'DE' || ags === state.scope);
export function usageChartOptions(doc) {
  const key = `${state.scope}|${state.operator}|${state.type}`;
  if (state.usage.chartSel?.key !== key) state.usage.chartSel = { key, op: state.operator, type: state.type };
  const s = state.usage.chartSel, ops = new Set(), types = new Set();
  for (const [k, g] of Object.entries(doc.groups || {})) {
    const [ags, op, ty] = k.split('|');
    if (!inArea(ags) || !['start', 'end', 'reloc', 'swap', 'pickup'].some(f => sum(g[f] || []) > 0)) continue;
    ops.add(op); types.add(ty);
  }
  if (s.op !== 'all') ops.add(s.op); if (s.type !== 'all') types.add(s.type);
  const order = Object.keys(TYPE), rank = (tq) => order.includes(tq) ? order.indexOf(tq) : 99;
  $('#usage-op').innerHTML = `<option value="all">${t('app.all')}</option>` + [...ops].sort((a, b) => a.localeCompare(b, 'de')).map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
  $('#usage-type').innerHTML = `<option value="all">${t('app.all')}</option>` + [...types].sort((a, b) => rank(a) - rank(b)).map(tq => `<option value="${esc(tq)}">${esc(TYPE[tq] || tq)}</option>`).join('');
  $('#usage-op').value = s.op; $('#usage-type').value = s.type;
}
// Ein Anbieter gewählt: eine Linie je Fahrzeugart; sonst eine Linie je Anbieter (gefiltert nach Art, Top 8)
export function renderUsageChart() {
  const c = state.usage.chartData, s = state.usage.chartSel; if (!c || !s) return;
  const { op, type } = s, perType = op !== 'all';
  const by = new Map();
  for (const [k, g] of Object.entries(c.doc.groups || {})) {
    const [ags, o, ty] = k.split('|');
    if (!inArea(ags) || (perType && o !== op) || (type !== 'all' && ty !== type)) continue;
    const name = perType ? ty : o; const a = by.get(name) || new Array(24).fill(0);
    for (let h = 0; h < 24; h++) a[h] += g.start?.[h] || 0;
    by.set(name, a);
  }
  const order = Object.keys(TYPE), ok = c.mask?.ok || new Array(24).fill(true);
  // nicht gemessene Stunden und Stunden nach Messlücke: null (Linie unterbrochen), nicht 0
  const all = [...by].map(([name, raw]) => { const values = raw.map((v, h) => ok[h] ? v : null); return perType ? { name: TYPE[name] || name, values, color: palette(Math.max(0, order.indexOf(name))) } : { name, values, color: opColor(name) }; }).sort((x, y) => sum(y.values) - sum(x.values));
  const series = all.slice(0, 8), tyLabel = TYPE[type] || type;
  const box = $('#chart-usage');
  box.innerHTML = series.length ? hourChart(series, c.weather, c.runs, c.mask, dayNote(state.usage.day), chartWidth(box, () => renderUsageChart())) : `<div class="empty">${t('app.noTripStartsForThisSelection')}</div>`;
  $('#usage-chart-sub').textContent = (perType ? t('app.tripStartsPerHourByVehicle', { op, v1: type !== 'all' ? ` ${t('app.only', { tyLabel })}` : '' }) : t('app.tripStartsPerHourAndOperator', { v0: type !== 'all' ? ` · ${tyLabel}` : '', v1: all.length > 8 ? ` · ${t('app.top8Of', { length: all.length })}` : '' })) + (c.weather ? ` · ${t('app.weather', { name: c.weather.name })}` : '');
  $('#usage-legend').innerHTML = series.map((x, i) => `<span><i class="dot" style="background:${x.color || palette(i)}"></i>${esc(x.name)} <span class="mono">${fmt(sum(x.values))}</span></span>`).join('') + (c.weather && series.length ? `<span><i class="sq rain-key"></i>${t('app.precipitationBarsTemperature')}</span>` : '') +(series.length && ok.some(v => !v) ? `<span><i class="sq gap-key"></i>${abbr(t('app.notMeasuredAfterMeasurement'), 'gap')}</span>` : '');
}
// ---------- Umsatz & Kennzahlen ----------
export function econOpts() {
  const m = +$('#econ-min')?.value;
  return { rideMin: Number.isFinite(m) && m > 0 ? m : null, realization: Math.min(1, Math.max(0.1, (+$('#econ-real')?.value || 85) / 100)), net: $('#econ-net') ? $('#econ-net').checked : true };
}
// Tagesgang je Tagtyp des gewählten Tags im Land des Gebiets (lib/pulse-econ.js dayType, calendar.json): geladen werden nur volle Tage
// desselben Typs laut Messbasis (latest.json → measure, die jüngsten 7); ohne Messbasis die letzten 7 abgeschlossenen Tage wie bisher
export async function econProfile(day) {
  const land = state.scope === 'DE' ? null : scopeState(), cal = state.calendar || null, ty = E.dayType(day, land, cal), key = `${ty}|${land}|${state.latest?.at}`;
  const P = (econProfile.cache ??= new Map()); if (P.has(key)) return (state.usage.profile = P.get(key)); // state.usage.profile: zuletzt genutzte Kurve (Disposition)
  const idx = await loadUsageIndex(); const all = (idx.days || []).slice(0, -1); // abgeschlossene Tage
  const md = state.latest?.measure?.version >= 1 ? state.latest.measure.days || {} : null;
  const pick = md ? all.filter(d => md[d]?.full && E.dayType(d, land, cal) === ty).slice(-7) : all.slice(-7);
  // S3.8: Stundensummen aller Gruppen (events/hour-totals.json, gleiches Profil wie aus den Tagesdateien) statt bis zu 7 Tagesdateien
  const ht = await loadOnce('hourTotals', 'events/hour-totals.json', 25000);
  const fromTotals = ht?.version === 1 && ht.at >= (state.latest?.at ?? Infinity) && pick.every(d => ht.days?.[d]);
  const prof = E.hourProfile(fromTotals ? pick.map(d => totalsDoc(d, ht.days[d])) : await Promise.all(pick.map(loadEvents)), { dayType: ty, land, calendar: cal });
  P.set(key, prof); return (state.usage.profile = prof);
}
// Kennzahlen je Gruppe (Gemeinde|Anbieter|Art) eines Tages; Ergebnis je Schlüssel.
// Je Gruppe: m = gemessen (Ø Fahrt aus der Kalibrierung: E-Scooter Berliner Quartalswerte, sonst Annahme), cal = × Faktor (pulse-calib factorFor:
// eigene Korrektur übersteuert, sonst k für E-Scooter), lo/hi = Spanne des Faktors; die Gruppe selbst trägt die Werte des gewählten Modus.
export async function econGroups(day, keep, st = null) {
  // Audit OPS-04: für abgeschlossene Tage reicht das Tagesmittel aus history/daily.json (Ø Bestand als Rückfall), statt je Tag history/<Tag>.json (3–5 MB)
  const histDay = async (d) => { if (d < FC_dayOfNow()) { const dl = await loadDaily(); const h = dl ? R.histFromDaily(dl, d) : null; if (h) return h; } return loadHistory(d); };
  const [doc, pricing, hist, prof, calib] = await Promise.all([st ? loadEventsState(day, st) : loadEvents(day), loadOnce('pricing', 'pricing.json'), histDay(day), econProfile(day), getCalib()]);
  if (!doc) return null;
  // Fahrzeugminuten nur nutzen, wenn alle Läufe des Tages sie gezählt haben (Umstellungstag: Ø Bestand aus dem Verlauf)
  // Stunden ohne Messung oder mit Lücken-Lauf (> 45 Min. Pause, Flag 0) fallen aus Beobachtungszeit, Fahrten und Fahrzeugminuten: keine Hochrechnung aus Lücken
  const runs = doc.runs || [], mask = hourMask(runs, doc.gapHours);
  // Fahrzeugminuten gelten, wenn jeder Lauf ein Flag trägt (1 = zählt, 0 = Lücke); ältere Tage ohne Flag: Ø Bestand aus dem Verlauf
  const vminOk = runs.every(r => r[1] == null || r[2] === 1 || r[2] === 0 || isGapRun(r));
  const obsMin = E.observedMinutes(runs).map((m, h) => mask.ok[h] ? m : 0), obsMinV = vminOk ? E.observedMinutesEnd(runs).map((m, h) => mask.ok[h] ? m : 0) : new Array(24).fill(0); const o = econOpts(); // S1.1: Abdeckung anteilig, Fahrzeugminuten in der Endstunde
  const maskG = (g) => { const out = { ...g }; for (const f of ['start', 'end', 'rot', 'vmin', 'vminTot']) if (Array.isArray(g[f])) out[f] = g[f].map((v, h) => mask.ok[h] ? (v || 0) : 0); return out; };
  const assume = calib?.assume || null, mode = calibMode();
  const planCache = new Map(); const out = new Map();
  for (const [k, g] of Object.entries(doc.groups || {})) {
    if (!keep(k)) continue;
    const [ags, op, ty] = k.split('|');
    const pk = `${op}|${ags}|${ty}`; if (!planCache.has(pk)) planCache.set(pk, E.planFor(pricing, op, ags, ty, assume?.[ty] || undefined));
    const pl = planCache.get(pk);
    const series = hist?.series?.[k]?.total?.filter(x => x != null) || [];
    const fleetFallback = series.length ? series.reduce((a, b) => a + b, 0) / series.length : (state.latest?.groups?.[k]?.total ?? null);
    // Messung über der Plausibilitätsgrenze (Überzählung): nicht kalibrieren, nicht in Summen
    const chk = K.checkMeasured(E.kpis({ g: maskG(g), obsMin, obsMinV, profile: prof.profile, plan: pl?.plan || null, type: ty, fleetFallback, ride: o.rideMin ? { min: o.rideMin } : null, assume, realization: o.realization, net: o.net, hourMin: doc.hourMin || null }), ty, calib?.limits);
    const m = chk.kpi;
    const fac = K.factorFor(ty, { manual: calibFor(op), k: calib?.k, mode: 'kal', suspended: chk.suspended, kind: calib?.kinds?.[k] ?? null, op }); // k nur für die Kennungsart der Berliner Referenz
    // kalibrierte Fahrten je Fahrzeug und Tag höchstens bis zur Plausibilitätsgrenze der Art (lib/pulse-calib.js cappedFactor)
    const lim = { limit: calib?.limits?.[ty] ?? null };
    const cal = K.applyFactor(m, fac.f, lim);
    out.set(k, { ...(mode === 'kal' ? cal : m), m, cal, lo: K.applyFactor(m, fac.lo, lim), hi: K.applyFactor(m, fac.hi, lim), fac, plan: pl, op, ty, ags });
  }
  return { out, doc, obsMin, profile: prof, gapH: mask.gap.filter(Boolean).length, calib };
}
// für die Disposition: Kennzahlen eines Anbieters in einer Gemeinde (letzter voller Tag wie die Vorauswahl der Nutzung, Werte des gewählten Modus)
export async function econFor(ags, op, type) {
  const idx = await loadUsageIndex(); if (!idx.days?.length) return null;
  const st = state.latest?.municipalities?.[ags]?.state || null; // S3.8: nur die Ereignisse des Landes der Gemeinde
  const day = await defaultUsageDay(idx.days, st);
  const r = await econGroups(day, (k) => { const [a, o, tq] = k.split('|'); return a === ags && o === op && (type === 'all' || tq === type); }, st);
  return r ? E.combine([...r.out.values()]) : null;
}
// Kalibrierung: geteilt mit dem Bericht (report.js loadCalibration), Modus „kalibriert“ / „gemessen“ je Browser gemerkt
export const getCalib = () => mod('rp').then(m => m.loadCalibration(rpCtx()));
export const MODE_KEY = 'mp-calib-mode';
export function calibMode() { try { return localStorage.getItem(MODE_KEY) === 'mess' ? 'mess' : 'kal'; } catch { return 'kal'; } }
export function setCalibMode(m) { try { localStorage.setItem(MODE_KEY, m === 'mess' ? 'mess' : 'kal'); } catch { /* privates Fenster: Standard „kalibriert“ */ } }
// Schalter zeigt den wirksamen Zustand (B3): „kalibriert“ gedrückt nur, wenn ein Faktor tatsächlich wirkt (k angewandt oder eigene Korrektur);
// sonst gesperrt (aria-disabled, Klick ohne Wirkung), Zustand im Knopftext („gesperrt“, „vorläufig“ …), Grund per aria-describedby (#econ-calib-state).
export function syncCalibToggle(st = null) {
  const m = calibMode(), eff = st ? st.effective : true;
  $$('#econ-mode button[data-cmode]').forEach(b => {
    const kalB = b.dataset.cmode === 'kal';
    b.setAttribute('aria-pressed', String(kalB ? m === 'kal' && eff : m === 'mess' || !eff));
    if (!kalB || !st) return;
    const lock = eff ? '' : st.label;
    b.textContent = lock ? `${t('html.calibrated')} · ${lock}` : t('html.calibrated');
    if (lock) { b.setAttribute('aria-disabled', 'true'); b.setAttribute('aria-describedby', 'econ-calib-state'); } else { b.removeAttribute('aria-disabled'); b.removeAttribute('aria-describedby'); }
  });
}
export async function renderEcon(day) {
  const r = await econGroups(day, groupInScope);
  syncCalibToggle(r ? null : { effective: false, label: t('cal.btnOff') });
  if (!r) { $('#econ-tiles').innerHTML = ''; $('#econ-excl').innerHTML = ''; $('#econ-calib').innerHTML = ''; $('#econ-badge').textContent = t('app.estimate'); $('#tbl-econ tbody').innerHTML = emptyRow(6, t('app.noEventDataForThisDay'), t('app.chooseAnotherDay')); $('#tbl-econ-more tbody').innerHTML = emptyRow(7, t('app.noEventDataForThisDay'), t('app.chooseAnotherDay')); return; }
  const kal = calibMode() === 'kal', k = r.calib?.k, sc = r.calib?.assume?.scooter;
  const byName = new Map();
  for (const x of r.out.values()) { const name = `${x.op}|${x.ty}`; if (!byName.has(name)) byName.set(name, []); byName.get(name).push(x); }
  // je Anbieter × Art: Gemeinden mit unplausibler Messung (Überzählung, > 15) fallen aus der Zeile; sind alle unplausibel, ist die Zeile es
  const rows = [...byName].map(([name, list0]) => { const [op, ty] = name.split('|'); const okL = list0.filter(x => x.m.plausible); const list = okL.length ? okL : list0; const dropped = okL.length ? list0.filter(x => !x.m.plausible) : [];
    const c = E.combine(list); const plans = [...new Set(list.map(x => x.plan?.plan ? E.planLabel(x.plan.plan) : null).filter(Boolean))];
    return { op, ty, c, cm: E.combine(list.map(x => x.m)), cc: E.combine(list.map(x => x.cal)), lo: E.combine(list.map(x => x.lo)), hi: E.combine(list.map(x => x.hi)), fac: list[0].fac, dur: [...new Set(list.map(x => x.m.durationSource))], list, dropped, plans, planScope: list.find(x => x.plan)?.plan?.scope, planUnclear: list.find(x => x.plan?.unclear)?.plan || null }; })
    .filter(x => x.c && x.c.fleet > 0).sort((a, b) => (b.c.revDay || 0) - (a.c.revDay || 0) || b.c.rides - a.c.rides);
  const good = rows.filter(x => x.c.plausible);
  const T = { cm: E.combine(good.map(x => x.cm)), cc: E.combine(good.map(x => x.cc)), lo: E.combine(good.map(x => x.lo)), hi: E.combine(good.map(x => x.hi)) };
  const tot = kal ? T.cc : T.cm;
  // Wirksamer Faktor (B3): k angewandt und für eine Zeile passend (Kennungsart) bzw. eigene Korrektur; sonst gemessen mit Zustand von k
  const facs = rows.flatMap(x => x.list.map(y => y.fac)), anyK = facs.some(f => f.source === 'kalibriert'), anyCorr = facs.some(f => f.source === 'Korrektur');
  const skipOps = [...new Set(rows.filter(x => x.list.some(y => y.fac.skip === 'kind')).map(x => `${x.op} (${K.kindText(x.list.find(y => y.fac.skip === 'kind').fac.kind, lang())})`))];
  const kShort = !k ? t('cal.btnOff') : k.applied ? (anyK ? '' : t('cal.btnNoEffect')) : { locked: t('cal.btnLocked'), prelim: t('cal.btnPrelim') }[k.status] || t('cal.btnOff');
  const effective = kal && (anyK || anyCorr);
  syncCalibToggle({ effective: anyK || anyCorr, label: kShort });
  const facTag = effective ? (anyK ? t('cal.tileK', { k: fmt(k.k, 2) }) : t('cal.tileCorr')) : t('cal.tileNoK', { v0: kal && kShort ? ` (k ${kShort})` : '' });
  const cov = Math.max(0, ...rows.map(x => x.c.coverage || 0));
  const o = econOpts(); const euro = (v, d = 0) => v == null ? '—' : `${fmt(v, d)} €`;
  // Reifegrad: Läufe und Messbeginn am Panel; unter 3 vollen Messtagen Hochrechnungen nur als Spanne
  const idx = await loadUsageIndex(); const first = (idx.days || [])[0]; const runsN = (r.doc.runs || []).length;
  const dd = (d) => d ? dateFmt({ day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${d.slice(0, 10)}T12:00:00Z`)) : '–';
  $('#econ-badge').textContent = first && first !== day ? t('app.estimateRunsOnDataSince', { runsN: fmt(runsN), day: dd(day), first: dd(first) }) : t('app.estimateRunsSince', { runsN: fmt(runsN), v1: dd(first || day) });
  const prelim = r.profile.source === 'Standardkurve' || (r.profile.days ?? 0) < 3;
  const pb = $('#econ-prelim'); pb.hidden = !prelim; pb.title = t('app.onlyFullMeasurementDaysSoFar', { v0: fmt(r.profile.days ?? 0) });
  const rng = (v, d = 0, unit = '') => { if (v == null || !Number.isFinite(v)) return '—'; if (!prelim || v === 0) return `${fmt(v, d)}${unit}`; const f = (x) => x >= 100 ? fmt(sig2(x)) : fmt(x, d); return `${f(v * 0.7)}–${f(v * 1.3)}${unit}`; };
  const fu = (v, d = 0, unit = '') => (v == null || !Number.isFinite(v) ? '—' : `${v >= 1000 && d === 0 ? fmt(sig2(v)) : fmt(v, d)}${unit}`);
  // gemessen und kalibriert nebeneinander: Hauptwert nach Modus, der andere darunter; ohne Faktor wie bisher
  const pair = (x, key, { d = 0, unit = '', scale = 1, mKey = 'app.measured', m2Key = 'app.measured2' } = {}) => {
    const g = (o2) => (o2?.[key] == null ? null : o2[key] * scale);
    const m = g(x.cm), c = g(x.cc), lo = g(x.lo), hi = g(x.hi);
    if (m == null || c == null || Math.abs(c - m) <= 1e-9 * Math.max(1, Math.abs(m))) return { main: rng(m, d, unit), sub: '' };
    const span = lo != null && hi != null && Math.abs(hi - lo) > 1e-9 ? `${fu(lo, d)}–${fu(hi, d, unit)}` : null;
    return kal ? { main: fu(c, d, unit), sub: t(mKey, { v0: span ? `${t('app.range', { span })} · ` : '', v1: rng(m, d, unit) }), lines: [span ? t('app.range', { span }) : null, t(m2Key, { v0: rng(m, d, unit) })].filter(Boolean) } : { main: rng(m, d, unit), sub: t('app.calibrated', { v0: fu(c, d, unit) }), lines: [t('app.calibrated', { v0: fu(c, d, unit) })] };
  };
  // Tabellenzelle: Hauptwert, darunter Spanne und Vergleichswert je eine Zeile (schmale Spalten)
  const cell = (p, bold = false) => `${bold ? '<b>' : ''}${p.main}${bold ? '</b>' : ''}${(p.lines || []).map(l => `<div class="sub-line">${l}</div>`).join('')}`;
  const tsub = (p, base) => [p.sub, base, facTag].filter(Boolean).join(' · '); // Fahrten-Kacheln nennen, ob ein Faktor drin ist (B3)
  $('#econ-tiles').classList.toggle('prelim', prelim);
  // Einheiten mit geschütztem Leerzeichen: Spanne „a–b €“ bricht nie zwischen Zahl und Einheit
  const pR = pair(T, 'ridesDay', { mKey: 'app.measuredDayFill', m2Key: 'app.measuredDayFill2' }), pV = pair(T, 'rvd', { d: 2 }), pU = pair(T, 'utilization', { d: 1, unit: ' %', scale: 100 }), pD = pair(T, 'revDay', { unit: ' €' }), pF = pair(T, 'revPerVehicleDay', { d: 2, unit: ' €' });
  // „Fahrten je Tag“ mit Basis (gewählter Tag, mit Faktor oder gemessen); der Kommunal-Bericht nennt dort „Ø n Tage“
  const run = runningDay(idx.days || []), dayLbl = `${day.slice(8)}.${day.slice(5, 7)}.`;
  $('#econ-tiles').innerHTML = tot ? [
    tile(t('app.tripsDay', { d: day === run ? t('app.usageDayUntil', { d: dayLbl, h: partialHour() }) : dayLbl }), pR.main, [facTag, pR.sub, t('app.fromMeasuredOfDailyProfile', { rides: fmt(T.cm.rides), v1: fmt(cov * 100) })].filter(Boolean).join(' · ')),
    tile(abbr(t('app.tripsVehDay'), 'rvd'), pV.main, tsub(pV, t('app.avgVehiclesOnStreet', { fleet: fmt(tot.fleet) }))),
    tile(abbr(t('app.utilisation'), 'util'), pU.main, tsub(pU, t('app.timeOnTripsAvgMinPerTrip', { avgMin: fmt(tot.avgMin, 1) }))),
    tile(t('app.revenueDay', { v0: o.net ? t('common.net') : t('common.gross') }), pD.main, tsub(pD, t('app.listPricesOfFeeds', { v0: abbr(t('app.realisation'), 'real'), v1: fmt(o.realization * 100) }))),
    tile(t('app.revenueVehDay'), pF.main, tsub(pF, t('app.perTrip', { v0: euro(tot.perRide, 2) }))),
  ].join('') : `<div class="empty" style="grid-column:1/-1">${t('app.noReliableRowInFilterAllRows')}</div>`;
  // Reifegrad an den Hochrechnungen (Fahrten/Tag, je Fahrzeug, Auslastung, Umsatz): Tagtyp des gewählten Tags, Tagesgang dieses Typs
  { const land = state.scope === 'DE' ? null : scopeState(); UI.mbTiles($('#econ-tiles'), UI.mbBadge(UI.mbBase(state, { land }), 'full3', { dayType: E.dayType(day, land, state.calendar), curve: t('mb.curve', { v: `${esc(tx(r.profile.source))} (${UI.mbTypeName(r.profile.dayType || 'W')})` }) })); }
  // Unplausible Zeilen sind aus den Summen raus – sichtbar machen
  const bad = [...rows.filter(x => !x.c.plausible), ...rows.flatMap(x => (x.dropped || []).map(d => ({ ...x, c: d.m, where: muniName(d.ags) })))]; const names = bad.map(x => `${x.op} ${TYPE[x.ty] || x.ty}${x.where ? ` ${x.where}` : ''}`);
  const ex = $('#econ-excl'); ex.innerHTML = bad.length ? `${t('app.totalsWithout', { join: esc(names.slice(0, 4).join(', ')), v1: names.length > 4 ? ` ${t('app.andMore', { v0: names.length - 4 })}` : '' })} <span class="muted">${t('app.notReliable')}</span>` : '';
  ex.title = bad.map(x => `${x.op} ${TYPE[x.ty] || x.ty}: ${flagText(x.c.flags[0]) || t('app.implausible')}`).join('\n');
  const cal = calibAll();
  const facTxt = (x) => (x.fac.source === 'Korrektur' ? t('app.correction', { f: fmt(x.fac.f, 2) }) : x.fac.source === 'kalibriert' ? t('app.calibrated2', { f: fmt(x.fac.f, 2) }) : '');
  const DUR = { kalibriert: t('app.berlinMean'), gemessen: t('app.measured3'), Annahme: t('app.assumption'), Vorgabe: t('app.default') };
  // Sechs Standardspalten; Korrektur, Auslastung, Dauer, Tarif und Einzelpreise unter „Weitere Spalten“. Nicht belastbare Zeilen: Kennzeichnung statt Ausgrauen.
  const nameCell = (x) => { const c = x.c; const dr = x.dropped || []; return `<td><span class="op"><i style="background:${opColor(x.op)}"></i>${esc(x.op)}</span><div class="sub-line">${esc(TYPE[x.ty] || x.ty)}${state.scope === 'DE' ? ` · ${x.list.length} ${x.list.length === 1 ? t('app.municipality') : t('app.municipalities2')}` : ''}</div>${!c.plausible ? `<span class="pill excl-tag">${t('app.notInTotal')}</span>` : ''}${c.flags.length ? `<div class="sub-line warn-text flag-line">${esc(flagText(c.flags[0]))}</div>` : ''}${dr.length ? `<div class="sub-line warn-text flag-line">${t('app.without', { join: esc(dr.slice(0, 3).map(d => muniName(d.ags)).join(', ')), v1: dr.length > 3 ? ` +${dr.length - 3}` : '', v2: esc(flagText(dr[0].m.flags[0]) || t('app.implausible')) })}</div>` : ''}</td>`; };
  $('#tbl-econ tbody').innerHTML = rows.map(x => { const c = x.cm;
    return `<tr${!x.c.plausible ? ' class="row-excl"' : ''}>${nameCell(x)}
      <td class="n">${fmt(c.fleet)}</td><td class="n">${fmt(c.rides)}<div class="sub-line">${kal && x.fac.source === 'ausgesetzt' ? t('app.notCalibrated') : kal && x.fac.skip === 'op' ? esc(t('cal.notOp', { ops: (x.fac.ops || []).join(', ') })) : kal && x.fac.skip ? esc(t('cal.notKind', { v0: K.kindText(x.fac.kind, lang()) })) : kal && facTxt(x) ? esc(facTxt(x)) : c.rot ? `${fmt(c.rot)} ${abbr(t('app.idRotation'), 'rot')}` : ''}</div></td>
      <td class="n">${cell(pair(x, 'ridesDay'))}</td><td class="n">${cell(pair(x, 'rvd', { d: 2 }), true)}</td><td class="n">${cell(pair(x, 'revDay', { unit: ' €' }), true)}</td></tr>`; }).join('') || emptyRow(6, t('app.noTripsInFilter'), t('app.setOperatorOrVehicleTypeTo'));
  $('#tbl-econ-more tbody').innerHTML = rows.map(x => { const c = x.cm; const fac = calibFor(x.op);
    return `<tr${!x.c.plausible ? ' class="row-excl"' : ''}>${nameCell(x)}
      <td class="n"><input type="number" class="calib" data-op="${esc(x.op)}" value="${fac}" min="0.1" max="5" step="0.05" style="width:4.8em${fac !== 1 ? ';border-color:var(--accent)' : ''}" aria-label="${t('app.tripCorrectionFactor', { op: esc(x.op) })}" title="${esc(GLOSS.calib)}">${fac !== 1 ? `<div class="sub-line">${t('app.overridden')}</div>` : x.fac.source === 'kalibriert' ? `<div class="sub-line">${t('app.calibrated3', { f: fmt(x.fac.f, 2) })}</div>` : x.fac.source === 'ausgesetzt' ? `<div class="sub-line">${t('app.suspended')}</div>` : ''}</td>
      <td class="n">${cell(pair(x, 'utilization', { d: 1, unit: ' %', scale: 100 }))}</td><td class="n">${fmt(c.avgMin, 1)} min<div class="sub-line">${esc(x.dur.map(d => DUR[d] || d).join(', '))}</div></td>
      <td class="small">${x.plans.slice(0, 2).map(esc).join('<br>') || `<span class="muted">${t('app.noTariffInFeed')}</span>`}${x.planScope === 'Anbieter' ? `<div class="sub-line">${t('app.tariffOfAnotherCity')}</div>` : ''}${x.planUnclear ? `<div class="sub-line warn-text" title="${esc(t('econ.tariffUnclearTip'))}">${t('econ.tariffUnclear', { lo: fmt(x.planUnclear.fareMin, 2), hi: fmt(x.planUnclear.fareMax, 2) })}</div>` : ''}</td>
      <td class="n">${euro(c.perRide, 2)}</td><td class="n">${cell(pair(x, 'revPerVehicleDay', { d: 2, unit: ' €' }))}</td></tr>`; }).join('') || emptyRow(7, t('app.noTripsInFilter'), t('app.setOperatorOrVehicleTypeTo'));
  // Kalibrierung in zwei Zeilen; Einzelheiten im Panel „Kalibrierung“
  const calOps = Object.keys(cal);
  const kTxt = k?.applied ? `${t('app.eScooterTrips', { k: fmt(k.k, 2) })} <span class="muted">${t('app.range2', { kLow: fmt(k.kLow, 2), kHigh: fmt(k.kHigh, 2) })}</span> ${t('app.officialBerlinMeasuredBerlin', { quarter: esc(k.quarter), wert: fmt(k.ref.wert, 2), rvd: fmt(k.measured.rvd, 2), v3: abbr(t('app.tripsVehDay2'), 'rvd') })} <span class="muted">(${esc(k.source)})</span>${k.prelim ? ` <span class="pill prelim badge" title="${esc(k.prelimWhy.join(', '))}">${t('app.preliminary')}</span>` : ''}${k.single ? ` <span class="muted">· ${t('app.onlyOneOperator')}</span>` : ''} · ${esc(k.statusText || '')}${k.onlyKind ? ` · <span class="muted">${esc(k.onlyKind)}</span>` : ''}${skipOps.length ? ` · ${t('cal.skipped', { v0: esc(skipOps.join(', ')) })}` : ''}` : t('app.tripsNotCalibrated', { v0: esc(k?.reason || t('app.referenceValuesNotLoadable')) });
  const aTxt = sc?.calibrated ? t('app.avgEScooterTripMinInsteadOf', { min: fmt(sc.min, 1), min2: fmt(sc.previous.min), from: esc(sc.from), to: esc(sc.to) }) : t('app.avgEScooterTripMinAssumption', { v0: fmt(sc?.min ?? 12) });
  $('#econ-calib').innerHTML = `<div id="econ-calib-state"><b>${effective ? t('app.calibrated4') : t('app.measured4')}</b> · ${kTxt}</div><div>${t('app.bikesEBikesCargoBikes', { aTxt, v1: r.calib?.limits?.scooter ? ` · ${t('app.aboveTripsVehDayCalibration', { scooter: fmt(r.calib.limits.scooter, 2) })}` : '', v2: calOps.length ? ` · ${t('app.correctionOverriddenFor', { join: esc(calOps.join(', ')) })}` : '' })} · <span class="muted">${t('app.derivationInCalibrationPanel')}</span></div>`;
  const excludedN = rows.length - good.length;
  // sichtbar bleibt der erste Satz (was als Fahrt zählt), die Methodik steht aufklappbar darunter
  const noteHtml = t('app.tripsDisappearedAvailable', { v0: abbr(t('app.idRotation'), 'rot'), source: esc(tx(r.profile.source)), v2: prelim ? t('app.measuredValuesUnder3Full') : '', v3: o.rideMin ? t('app.defaultMin', { rideMin: fmt(o.rideMin) }) : t('app.measuredWhereIdsAreStable20', { v0: sc?.calibrated ? t('app.minFromBerlinQuarterlyValues', { min: fmt(sc.min, 1) }) : t('app.n12Min') }), v4: o.net ? `${t('app.excluding19Vat')} ` : '', v5: abbr(t('app.realisationRate'), 'real'), v6: r.gapH ? ` ${t('app.afterMeasurementGapOver45Min', { gapH: r.gapH, v1: r.gapH === 1 ? t('app.hour') : t('app.hours') })}` : '', v7: excludedN ? ` ${t('app.withImplausibleTripCountAre', { excludedN, v1: excludedN === 1 ? t('app.row') : t('app.rows2') })}` : '', v8: calOps.length ? ` ${t('app.activeFor', { join: esc(calOps.join(', ')) })}` : '' });
  const m = noteHtml.match(/^([\s\S]*?\)\.)\s+([\s\S]+)$/);
  const keepOpen = $('#econ-note details')?.open;
  $('#econ-note').innerHTML = m ? `${m[1]} <details class="more"${keepOpen ? ' open' : ''}><summary>${t('app.methodSummary')}</summary><p style="margin:0">${m[2]}</p></details>` : noteHtml;
}
