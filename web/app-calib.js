// Dashboard: Kalibrierung: Referenzwerte gegen die eigene Messung (S3.9: aus web/app.js geschnitten, Einstieg bleibt web/app.js).
import * as E from './pulse-econ.js';
import * as K from './pulse-calib.js';
import * as UI from './ui-shared.js';
import { weatherFor } from './weather.js';
import { t, tx, lang, dateFmt, fmtLocale } from './i18n.js';
import { $, $$, CFG, esc, fmt, link, palette, pctf, sig2, state } from './app-core.js';
import { cached, emptyRow, getJson, getJsonShared } from './app-load.js';
import { muniName } from './app-scope.js';
import { niceTicks, seriesSummary } from './app-energy.js';
import { econGroups, econOpts, getCalib, loadCells, loadOnce, scopeState } from './app-usage.js';

// ---------- Kalibrierung: Referenzwerte (data/reference.json, Branch main) gegen die eigene Messung, Regeln in lib/pulse-calib.js ----------
// Voi: Umsatz je Fahrzeug und Tag (gemessen, netto × Realisierung) über die Tage der Kalibrierung, Flotte-Tage gewichtet
export async function voiRevenue(days) {
  let rev = 0, fleet = 0, n = 0, rides = 0;
  for (const d of days || []) {
    const r = await econGroups(d, (key) => { const [a, op, tq] = key.split('|'); return a !== 'DE' && op === 'Voi' && tq === 'scooter'; }); if (!r) continue;
    const c = E.combine([...r.out.values()].map(x => x.m).filter(x => x.plausible)); if (c?.revDay != null && c.fleet > 0) { rev += c.revDay; fleet += c.fleet; rides += c.ridesDay || 0; n++; }
  }
  // Umsatz je Fahrt (Vergleich mit Voi FY2025 1,54 €): vom Faktor unabhängig, weil Umsatz und Fahrten gleich skalieren
  return fleet > 0 ? { revPerVehicleDay: rev / fleet, revPerRide: rides > 0 ? rev / rides : null, days: n } : null;
}
export async function renderCalibPanel() {
  const els = ['calib-panel', 'calib-src'].map(id => document.getElementById(id)).filter(Boolean); if (!els.length) return;
  const head = `<div class="panel-head"><div><h2>${t('app.calibration')}</h2><div class="sub">${t('app.publicReferenceValuesWith')}</div></div></div>`;
  const calib = await getCalib(); const k = calib.k, a = calib.assume?.scooter, ref = calib.ref;
  if (!ref) { for (const el of els) el.innerHTML = head + `<div class="empty">${t('app.referenceValuesNotLoadable2')}</div>`; return; }
  const voi = await voiRevenue(calib.days).catch(() => null);
  const checks = K.plausibilityChecks(ref, { ...calib.own, voi: { ...(calib.own?.voi || {}), revPerVehicleDay: voi?.revPerVehicleDay ?? null, revPerRide: voi?.revPerRide ?? null } }, k, lang());
  const src = (e) => (e?.url ? link(e.url, `${esc(e.quelle || t('app.source3'))} ↗`) : esc(e?.quelle || '—'));
  const dd = (d) => d ? dateFmt({ day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${d.slice(0, 10)}T12:00:00Z`)) : '–';
  const f2 = (v) => fmt(v, 2);
  const rows = [];
  // 1. Fahrtdauer
  if (a?.calibrated) rows.push([`${t('app.avgEScooterTrip')}<div class="sub-line">${t('app.berlinQuarters', { from: esc(a.from), to: esc(a.to), n: a.n })}</div>`, `${t('app.avgMinAvgKm', { min: fmt(a.min, 1), v1: f2(a.km) })}<div class="sub-line">${t('app.quartersMinKm', { v0: fmt(a.minRange[0], 1), v1: fmt(a.minRange[1], 1), v2: fmt(a.kmRange[0], 1), v3: fmt(a.kmRange[1], 1) })}</div>`, src(a),
    `${t('app.notMeasurable')}<div class="sub-line">${t('app.idsChangeWithEveryTripStable')}</div>`, `${f2(a.min / a.previous.min)}<div class="sub-line">${t('app.versusPreviouslyMin', { min: fmt(a.previous.min) })}</div>`, t('app.assumptionMinUtilisation', { min: fmt(a.previous.min), min2: fmt(a.min, 1), v2: f2(a.min / a.previous.min) })]);
  for (const e of (ref.fahrt || []).filter(x => x.ags !== K.BERLIN && x.type === 'scooter')) rows.push([`${t('app.eScooterTrip')}<div class="sub-line">${esc(tx(e.ort))}, ${esc(e.zeitraum)}</div>`, [e.minMedian != null ? t('app.medianMin', { minMedian: fmt(e.minMedian, 1) }) : '', e.minMittel != null ? t('app.avgMin', { minMittel: fmt(e.minMittel, 1) }) : '', e.kmMedian != null ? t('app.medianKm', { v0: f2(e.kmMedian) }) : '', e.kmMittel != null ? `Ø ${f2(e.kmMittel)} km` : ''].filter(Boolean).join(' · '), src(e), '—', a?.calibrated && e.minMittel ? `${f2(a.min / e.minMittel)}<div class="sub-line">${t('app.berlinAvgAvgHere')}</div>` : '—', t('app.crossCheckNotPartOfRuleOne')]);
  // 2. Methodenfaktor
  const kr = k?.ref || (ref.rvd || []).filter(e => e.ags === K.BERLIN && e.type === 'scooter').slice(-1)[0];
  if (kr) rows.push([`${t('app.tripsPerVehAndDayEScooter')}<div class="sub-line">${t('app.berlin', { v0: esc(k?.applied ? `${k.quarter} (${k.rule})` : kr.zeitraum) })}</div>`, `<b>${f2(kr.wert)}</b>${k?.refMin != null ? `<div class="sub-line">${t('app.quarters', { v0: f2(k.refMin), v1: f2(k.refMax) })}</div>` : ''}`, src(kr),
    k?.measured?.rvd ? `${f2(k.measured.rvd)}<div class="sub-line">${t('app.ofHoursObserved', { v0: esc(k.source || ''), v1: dd(k.measured.from), v2: dd(k.measured.to), days: k.measured.days, v4: k.measured.days === 1 ? t('app.day2') : t('app.days2'), v5: fmt(k.obsShare * 100) })}</div>${(k.measured.excluded || []).length ? `<div class="sub-line">${t('app.excludedOvercount', { join: esc(k.measured.excluded.map(x => `${x.op} ${f2(x.rvd)}`).join(', ')) })}</div>` : ''}` : '—',
    k?.applied ? `k = <b>${f2(k.k)}</b><div class="sub-line">${f2(k.kLow)}–${f2(k.kHigh)}</div>` : '—',
    k?.applied ? t('app.eScooterTripsNationwide', { v0: f2(k.k), calibLabel: esc(UI.calibLabel(k)), v2: f2(calib.limits?.scooter), v3: k.prelim ? `<div class="sub-line">${t('app.preliminary2', { join: esc(k.prelimWhy.join(', ')) })}</div>` : '', v4: (k.single ? `<div class="sub-line">${t('app.limitation', { single: esc(k.single) })}</div>` : '') + `<div class="sub-line">${esc(k.statusText || '')}${k.onlyKind ? ` · ${esc(k.onlyKind)}` : ''}</div>` }) : t('app.noCalibration', { v0: esc(k?.reason || '') })]);
  // 3. Abdeckung (+ Hochrechnung nur hier)
  for (const c of calib.coverage || []) {
    // k nur bei angewandtem k und Kennungsart der Stadt wie die Referenz, höchstens bis zur Grenze (K.calibratedRvd); sonst gemessen mit Hinweis
    const ob = calib.own?.byAgs?.[c.ags]; const cr = K.calibratedRvd(ob?.rvd, k, { kind: ob?.kind ?? null, limit: calib.limits?.scooter ?? null }); const rvdCal = cr.rvd;
    const crNote = cr.skip === 'op' ? `<div class="sub-line">${esc(t('cal.notOp', { ops: (cr.ops || []).join(', ') }))}</div>` : cr.skip === 'kind' ? `<div class="sub-line">${esc(t('cal.notKind', { v0: K.kindText(cr.kind, lang()) }))}</div>` : cr.skip === 'suspended' ? `<div class="sub-line warn-text">${esc(tx(UI.SUSPENDED_TXT))}</div>` : cr.capped ? `<div class="sub-line">${t('rep.cappedAtLimit')}</div>` : '';
    rows.push([`${t('app.eScooters', { v0: esc(c.label[0].toUpperCase() + c.label.slice(1)) })}<div class="sub-line">${esc(c.ort)}, ${c.stand ? t('app.asOf3', { v0: dd(c.stand) }) : ''}</div>`, `<b>${c.art === 'aktiv' ? `${t('app.approx')} ` : ''}${fmt(c.official)}</b><div class="sub-line">${esc(c.label)}</div>`, src(c), `${fmt(c.ours)}<div class="sub-line">${t('app.inOpenFeeds', { v0: c.operators.length ? ` (${esc(c.operators.map(o => o.op).join(', '))})` : '' })}</div>`, `<b>${fmt(c.share * 100, 1)} %</b>`,
      `${esc(c.shareLabel)}${rvdCal != null ? `<div class="sub-line">${t('app.extrapolationOnlyHereTrips', { rvdCal: f2(rvdCal), official: fmt(c.official), sig2: fmt(sig2(rvdCal * c.official)), v3: c.art === 'genehmigt' ? ` ${t('app.ofLicensedFleetHenceUpper')}` : ` ${t('app.ofActiveFleet')}` })}</div>` : ''}${crNote}`]);
  }
  // 4. Prüfwerte ohne Faktor
  for (const x of checks) {
    const u = x.unit === '€' ? ' €' : '';
    const mv = x.measured == null ? '—' : `${f2(x.measured)}${u}${x.calibrated != null ? `<div class="sub-line">${t('app.calibrated5', { v0: f2(x.calibrated), u })}</div>` : x.suspended ? `<div class="sub-line warn-text">${esc(tx(UI.SUSPENDED_TXT))}</div>` : x.notOp?.length ? `<div class="sub-line">${esc(t('cal.notOp', { ops: x.notOp.join(', ') }))}</div>` : ''}<div class="sub-line">${esc(x.kind === 'Untergrenze' ? t('app.openFeeds', { ort: tx(x.ref.ort) }) : x.scope || '')}${x.unit === '€' && voi ? `, ${voi.days} ${voi.days === 1 ? t('app.day2') : t('app.days2')}` : ''}</div>`;
    const ratio = x.ratioCal ?? x.ratio;
    rows.push([`${esc(tx(x.label.replace(/: .*/, '')))}<div class="sub-line">${esc(x.label.replace(/^[^:]*: /, ''))} · ${esc(x.ref.zeitraum || '')}</div>`, `<b>${x.kind === 'Untergrenze' ? '≥ ' : ''}${f2(x.refValue)}${u}</b>${x.how ? `<div class="sub-line">${esc(t('app.mTripsFleetCap', { v0: fmt(x.trips / 1e6, 2), v1: x.year % 4 ? 365 : 366, limit: fmt(x.limit) }))}</div>` : x.ref.hinweis ? `<div class="sub-line"><span translate="no">${esc(x.ref.hinweis)}</span></div>` : ''}`, `${src(x.ref)}${x.cap && x.cap.url !== x.ref.url ? ` · ${src(x.cap)}` : ''}`, mv,
      ratio == null ? '—' : `${f2(ratio)}<div class="sub-line">${t('app.reference', { v0: x.ratioCal != null ? t('app.calibrated6') : t('app.measured3') })}</div>`, x.suspended ? t('app.measurementAbove15Largest', { v0: f2(calib.limits?.scooter) }) : x.kind === 'Untergrenze' ? t('app.checkNoFactorLowerBound') : t('app.comparisonNoFactor')]);
  }
  const rules = `<ol class="calib-rules small"><li>${t('app.tripDurationAvgEScooterTrip', { v0: a?.calibrated ? ` (${fmt(a.min, 1)} Min., ${f2(a.km)} km)` : '' })}</li>
    <li>${t('cal.methodFactorK', { CALIB_DAYS: UI.CALIB_DAYS, minDays: K.CALIB.minDays })}</li>
    <li>${t('app.plausibilityIfOperatorS', { v0: calib.limits?.scooter ? f2(calib.limits.scooter) : '–', overFactor: fmt(K.CALIB.overFactor, 1), v2: k?.source ? ` (${esc(k.source)})` : '', v3: k?.single ? t('app.onlyOneOperatorOthersMay') : '' })}</li>
    <li>${t('app.preliminaryBelowMeasurement', { minDays: K.CALIB.minDays, v1: K.CALIB.minObsShare * 100, kMin: fmt(K.CALIB.kMin, 1), kMax: fmt(K.CALIB.kMax) })}</li>
    <li>${t('cal.ruleRelease', { minDays: K.CALIB.minDays, v1: esc(k?.statusText || '–'), v2: esc(k?.refKindText || K.kindText('unknown', lang())) })}</li>
    <li>${t('app.coverageAndCheckOwnEScooters')}</li></ol>`;
  const table = `<div class="tbl" tabindex="0" role="region" aria-label="${t('app.calibrationReferenceValues')}"><table class="calib-tbl"><thead><tr><th>${t('app.reference2')}</th><th class="n">${t('app.value')}</th><th>${t('app.source3')}</th><th class="n">${t('app.ourMeasurement')}</th><th class="n">${t('app.ratio')}</th><th>${t('app.effect')}</th></tr></thead><tbody>${rows.map(r => `<tr><td>${r[0]}</td><td class="n">${r[1]}</td><td class="small">${r[2]}</td><td class="n">${r[3]}</td><td class="n">${r[4]}</td><td class="small">${r[5]}</td></tr>`).join('')}</tbody></table></div>`;
  const foot = `<div class="muted small" style="margin-top:var(--s2)">${t('app.measurementPeriodVoiRevenue', { v0: calib.days.length ? `${dd(calib.days[0])}–${dd(calib.days[calib.days.length - 1])}` : '–', v1: econOpts().net ? t('common.net') : t('common.gross'), v2: fmt(econOpts().realization * 100), v3: esc(ref.updatedAt || '–') })}</div>`;
  for (const el of els) el.innerHTML = head + rules + table + foot;
}
// Korrekturfaktoren je Anbieter, lokal im Browser (localStorage, fehlertolerant)
export const CALIB_KEY = 'mp-calib';
export function calibAll() { try { const v = JSON.parse(localStorage.getItem(CALIB_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } }
export function calibFor(op) { const v = +calibAll()[op]; return Number.isFinite(v) && v > 0 ? v : 1; }
export function setCalib(op, v) { try { const all = calibAll(); if (!Number.isFinite(v) || v <= 0 || Math.abs(v - 1) < 1e-9) delete all[op]; else all[op] = Math.min(5, Math.max(0.1, v)); localStorage.setItem(CALIB_KEY, JSON.stringify(all)); } catch { /* privates Fenster: Faktor gilt nicht */ } }
// Langzeit-Archiv (Tageswerte je Monat): nur Hinweis auf Umfang
export async function renderArchive() {
  const el = $('#usage-archive'); if (!el) return;
  const idx = await loadOnce('archiveIndex', 'archive/index.json');
  const months = (idx?.months || []).filter(m => /^\d{4}-\d{2}$/.test(m)).sort();
  if (!months.length) { el.textContent = ''; return; }
  // Tage und erster Tag stehen im Index (Vertrag 7); nur bei altem Datenstand die Monatsdateien zum Zählen laden
  if (state.usage.archiveDays == null) {
    if (Number.isFinite(idx.days)) state.usage.archiveDays = idx.days;
    else { const docs = await Promise.all(months.map(m => cached(`archive/${m}.json`, 60000))); state.usage.archiveDays = docs.reduce((a, d) => a + Object.keys(d.json?.days || {}).length, 0); }
  }
  const n = state.usage.archiveDays; const first = /^\d{4}-\d{2}-\d{2}$/.test(idx.firstDay || '') ? idx.firstDay : null; const m0 = months[0];
  el.textContent = `· ${t('app.archiveSince', { v0: first ? new Date(`${first}T12:00:00`).toLocaleDateString(fmtLocale(), { day: 'numeric', month: 'long', year: 'numeric' }) : new Date(+m0.slice(0, 4), +m0.slice(5, 7) - 1, 1).toLocaleDateString(fmtLocale(), { month: 'long', year: 'numeric' }), n: fmt(n), v2: n === 1 ? t('app.day2') : t('app.days2') })}`;
}
export function T_empty() { return { start: new Array(24).fill(0), end: new Array(24).fill(0), reloc: new Array(24).fill(0), swap: new Array(24).fill(0), pickup: new Array(24).fill(0), disOn: new Array(24).fill(0), disOff: new Array(24).fill(0), swapWaitSum: 0, swapWaitN: 0, disDurSum: 0, disDurN: 0, tripDurSum: 0, tripDurN: 0, tripDistSum: 0, tripDistN: 0, swapWaitCens: 0, disDurCens: 0 }; }
// swapWaitCens/disDurCens (ab 02.11.2026): davon Mindestwerte (unter 20 % bzw. gesperrt seit erster Sichtung zu Beginn der Verfolgung, Z6) → Anzeige „≥“
export function T_add(a, g, ok = null) { for (const f of ['start', 'end', 'reloc', 'swap', 'pickup', 'disOn', 'disOff']) for (let i = 0; i < 24; i++) if (!ok || ok[i]) a[f][i] += g[f]?.[i] || 0; for (const f of ['swapWaitSum', 'swapWaitN', 'disDurSum', 'disDurN', 'tripDurSum', 'tripDurN', 'tripDistSum', 'tripDistN', 'swapWaitCens', 'disDurCens']) a[f] += g[f] || 0; }
export const atLeast = (cens, text) => cens > 0 ? `≥ ${text}` : text; // Mittel mit zensierten Werten ist ein Mindestwert
// Wetter aus dem Cache des Sammlers (weather/<UTC-Tag>.json, DWD über Bright Sky), derselbe Stand wie in Bericht und Prognose;
// kein Abruf bei Drittanbietern (Open-Meteo erlaubt die kostenlose Nutzung nur nicht-kommerziell). Ganz Deutschland: Mittel aller Wetterzellen.
export async function loadWeather(day) {
  const scope = state.scope === 'DE' ? null : state.scope, key = `${day}|${scope || 'DE'}`;
  if (!(key in state.usage.weather)) {
    const vals = await weatherFor(Array.from({ length: 24 }, (_, h) => [day, h]), scope, getJsonShared, CFG.DATA).catch(() => null);
    state.usage.weather[key] = vals?.some(Boolean) ? { temp: vals.map(v => (v ? v.t : null)), rain: vals.map(v => v?.p ?? null), name: scope ? muniName(scope) : t('app.centreOfGermany') } : null;
  }
  return state.usage.weather[key];
}
// Messlücken (Vertrag 5): Lauf mit Flag 0 oder über 45 Min. nach dem vorigen zählt nicht; seine Stunde (Berliner Zeit) gilt als Lücke
export const GAP_MS = 45 * 60e3;
export const BERLIN_HOUR = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Europe/Berlin' });
export const hourOf = (ms) => +BERLIN_HOUR.format(new Date(ms)) % 24;
export const isGapRun = (r) => r[2] === 0 || (r[1] != null && r[1] > GAP_MS);
// ok[h] = Stunde gemessen und ohne Lücken-Lauf; gap[h] = Stunde mit Lücken-Lauf (aus runs und, falls vorhanden, doc.gapHours des Sammlers)
export function hourMask(runs, gapHours = null) {
  const measured = new Array(24).fill(false), gap = new Array(24).fill(false);
  for (const r of runs || []) { const h = hourOf(r[0]); if (isGapRun(r)) gap[h] = true; else if (r[1] != null) measured[h] = true; }
  for (const h of Array.isArray(gapHours) ? gapHours : []) if (h >= 0 && h < 24) gap[h] = true;
  return { ok: measured.map((m, h) => m && !gap[h]), gap, measured };
}
// Eine Achse: Wetter steht als eigenes Band unter dem Diagramm (Regenbalken und Temperatur als Text), nicht als zweite Skala im Diagramm.
// Je Stunde eine unsichtbare Trefferfläche mit Tooltip (alle Werte der Stunde); Feiertag oben rechts.
export function hourChart(series, weather, runs, mask = null, holiday = null, W = 900) {
  const WB = weather ? 58 : 0, HT = holiday ? 16 : 0, H = (W < 520 ? 200 : 260) + WB + HT, P = { l: 54, r: 12, t: 12 + HT, b: 26 + WB }, HS = W < 520 ? 6 : 3; // Stundenmarken alle 3 h, schmal alle 6 h
  const vals = series.flatMap(s => s.values).filter(v => v != null);
  const nt = niceTicks(Math.max(1, ...vals) * 1.05), max = nt.top; // runde Achsenwerte statt 96/191/287/383
  const x = (h) => P.l + ((h + 0.5) / 24) * (W - P.l - P.r), cw = (W - P.l - P.r) / 24;
  const y = (v) => P.t + (1 - v / max) * (H - P.t - P.b);
  let g = '';
  // nicht gemessene Stunden und Stunden nach Messlücke grau hinterlegen (statt einer Nulllinie)
  const m = mask || hourMask(runs);
  for (let h = 0; h < 24; h++) if (!m.ok[h]) g += `<rect class="gap" x="${(x(h) - cw / 2).toFixed(1)}" y="${P.t}" width="${cw.toFixed(1)}" height="${H - P.t - P.b}"><title>${t('app.text2', { h, v1: h + 1, v2: m.gap[h] ? t('app.runAfterPauseOfMoreThan45Min') : t('app.noCollectorRunNotMeasured') })}</title></rect>`;
  for (let h = 0; h < 24; h++) if (!m.ok[h] && (h === 0 || m.ok[h - 1])) { let e = h; while (e < 23 && !m.ok[e + 1]) e++; if (e - h >= 2) g += `<text x="${((x(h) + x(e)) / 2).toFixed(1)}" y="${P.t + 12}" text-anchor="middle">${t('app.notMeasured')}</text>`; }
  for (const v of nt.ticks) g += `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text x="${P.l - 6}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${fmt(v, nt.step < 1 ? 1 : 0)}</text>`;
  const yAx = H - WB - 8;
  for (let h = 0; h < 24; h += HS) g += `<text x="${x(h).toFixed(1)}" y="${yAx}" text-anchor="middle">${t('app.n00', { h })}</text>`;
  if (holiday) g += `<text class="hol" x="${W - P.r}" y="${P.t - 6}" text-anchor="end">${esc(holiday)}</text>`; // über der Fläche, kollidiert nicht mit „nicht gemessen“
  let wx = '';
  if (weather) {
    // eigenes Band: Regen als Balken (eigene Höhe, kein Bezug zur y-Achse), Temperatur als Zahl alle 3 Stunden
    const b0 = H - WB + 6, bh = 26, rmax = Math.max(1, ...weather.rain.map(v => v || 0));
    wx += `<text x="${P.l - 6}" y="${b0 + 12}" text-anchor="end">${t('app.weather2')}</text><line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${b0 + bh}" y2="${b0 + bh}"/>`;
    for (let h = 0; h < 24; h++) if (weather.rain[h] > 0) { const hh = Math.max(2, (weather.rain[h] / rmax) * bh); wx += `<rect class="rain" x="${(x(h) - cw / 2 + 2).toFixed(1)}" y="${(b0 + bh - hh).toFixed(1)}" width="${(cw - 4).toFixed(1)}" height="${hh.toFixed(1)}"><title>${t('app.n00MmPrecipitation', { h, v1: fmt(weather.rain[h], 1) })}</title></rect>`; }
    for (let h = 0; h < 24; h += HS) if (weather.temp[h] != null) wx += `<text x="${x(h).toFixed(1)}" y="${b0 + bh + 14}" text-anchor="middle">${fmt(weather.temp[h])}°</text>`;
  }
  // Linie an fehlenden Stunden unterbrochen; einzelne gemessene Stunden als Punkt (≥ 8 px)
  const paths = series.map((s, i) => { const col = s.color || palette(i); let d = '', open = false, dots = ''; s.values.forEach((v, h) => { if (v == null) { open = false; return; } const alone = (h === 0 || s.values[h - 1] == null) && (h === 23 || s.values[h + 1] == null); if (alone) dots += `<circle cx="${x(h).toFixed(1)}" cy="${y(v).toFixed(1)}" r="4" fill="${col}" stroke="var(--panel)" stroke-width="2"/>`; d += `${open ? 'L' : 'M'}${x(h).toFixed(1)} ${y(v).toFixed(1)} `; open = true; }); return `<path d="${d}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round"/>${dots}`; }).join('');
  // Trefferflächen je Stunde mit allen Werten (Tooltip)
  let hits = '';
  for (let h = 0; h < 24; h++) { const lines = m.ok[h] ? series.filter(s => s.values[h] != null).sort((a, b) => b.values[h] - a.values[h]).map(s => `${s.name} ${fmt(s.values[h])}`) : [m.gap[h] ? t('app.afterMeasurementGapNot') : t('app.notMeasured')]; if (weather && weather.temp[h] != null) lines.push(`${fmt(weather.temp[h])} °C · ${fmt(weather.rain[h] || 0, 1)} mm`); hits += `<rect class="hit" x="${(x(h) - cw / 2).toFixed(1)}" y="${P.t}" width="${cw.toFixed(1)}" height="${H - P.t - 8}"><title>${t('app.text3', { h, v1: h + 1, join: esc(lines.join('\n')) })}</title></rect>`; }
  return `<svg class="chart" data-px="1" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${t('app.tripStartsPerHourGreyNot', { v0: holiday ? `; ${esc(holiday)}` : '' })}. ${esc(seriesSummary(series))}">${g}${wx}${paths}${hits}</svg>`;
}
// Feiertage: lokal gerechnet (lib/pulse-econ.js localHolidays, Ostern nach Gauß/Meeus); wo calendar.json (OpenHolidays) den Tag abdeckt,
// gilt je Land der Kalender – Länder mit Feiertag laut Kalender ohne lokalen Namen erscheinen als „Feiertag“
export const HOL_NAME = { newYear: () => t('app.newYearSDay'), epiphany: () => t('app.epiphany'), womensDay: () => t('app.womenSDay'), goodFriday: () => t('app.goodFriday'), easterSunday: () => t('app.easterSunday'),
  easterMonday: () => t('app.easterMonday'), labourDay: () => t('app.labourDay'), ascension: () => t('app.ascensionDay'), whitSunday: () => t('app.whitSunday'), whitMonday: () => t('app.whitMonday'),
  corpusChristi: () => t('app.corpusChristi'), assumption: () => t('app.assumptionDay'), childrensDay: () => t('app.worldChildrenSDay'), unity: () => t('app.germanUnityDay'), reformation: () => t('app.reformationDay'),
  allSaints: () => t('app.allSaintsDay'), repentance: () => t('app.dayOfRepentanceAndPrayer'), christmas: () => t('app.christmasDay'), boxingDay: () => t('app.boxingDay') };
export function holidaysOf(day) {
  const loc = E.localHolidays(day).map(h => [day, HOL_NAME[h.id]?.() || h.id, h.lands]);
  if (!E.calendarCovers(state.calendar, day)) return loc;
  const H = new Set(E.calendarLands(state.calendar, day, 'H'));
  const out = loc.map(([d, n, lands]) => [d, n, lands.filter(l => l.endsWith('*') || H.has(l))]).filter(x => x[2].length);
  const rest = [...H].filter(l => !out.some(x => x[2].includes(l)));
  if (rest.length) out.push([day, t('mb.publicHoliday'), rest]);
  return out;
}
// Schulferien laut Kalender (Tagtyp F, nur Mo–Fr): im Land des Gebiets bzw. Zahl der Länder
export function schoolNote(day) {
  const L = E.calendarLands(state.calendar, day, 'F'); if (!L.length) return null;
  const st = state.scope === 'DE' ? null : scopeState();
  return st ? (L.includes(st) ? t('mb.schoolHolidaysIn', { st }) : null) : t('mb.schoolHolidaysStates', { n: L.length });
}
// Messbasis unter dem Tagesgang: Matrix Stunde × Tagtyp mit Messminuten (latest.json → measure, Tagtyp im Land des Gebiets), damit sichtbar
// ist, welche Stunden an welchen Tagtypen gemessen sind. Nicht gemessen = Zeichen „·“ (nicht nur Farbe), Minuten im Text für Screenreader.
export function renderMbMatrix() {
  let box = $('#mb-matrix');
  if (!box) { const lg = $('#usage-legend'); if (!lg) return; lg.insertAdjacentHTML('afterend', '<div id="mb-matrix" class="mb-matrix"></div>'); box = $('#mb-matrix'); }
  const land = state.scope === 'DE' ? null : scopeState(), b = UI.mbBase(state, { land });
  const lvl = (m) => (m <= 0 ? 0 : m < 50 ? 1 : m < 120 ? 2 : m < 240 ? 3 : 4), hh = (h) => String(h).padStart(2, '0');
  const head = `<tr><th scope="col"><span class="vh">${t('mb.dayType')}</span></th>${Array.from({ length: 24 }, (_, h) => `<th scope="col" class="mb-hh">${h % 3 === 0 ? hh(h) : `<span class="vh">${hh(h)}</span>`}</th>`).join('')}<th scope="col" class="n">${t('mb.sum')}</th></tr>`;
  const rows = E.DAY_TYPES.map(k => `<tr><th scope="row" title="${esc(UI.mbTypeName(k))}">${k}<span class="vh"> ${esc(UI.mbTypeName(k))}</span></th>${b.matrix[k].map((m, h) => `<td class="mb-c mb-l${lvl(m)}" title="${esc(t('mb.cellTitle', { type: UI.mbTypeName(k), h: hh(h), h2: hh((h + 1) % 24), m: fmt(m) }))}">${m > 0 ? `<span class="vh">${fmt(m)}</span>` : '<span aria-hidden="true">·</span><span class="vh">0</span>'}</td>`).join('')}<td class="n mono">${fmt(b.byType[k], 1)}&nbsp;h<div class="sub-line">${t(b.days[k] === 1 ? 'mb.nDay' : 'mb.nDays', { n: b.days[k] })}</div></td></tr>`).join('');
  const never = Array.from({ length: 24 }, (_, h) => h).filter(h => E.DAY_TYPES.every(k => !b.matrix[k][h]));
  box.innerHTML = `<div class="mb-mh"><b>${t('mb.matrixTitle')}</b> <span class="muted">${t('mb.matrixSub', { h: fmt(b.hours, 1), never: never.length ? never.map(hh).join(', ') : '–' })}</span></div>
    <div class="tbl" tabindex="0" role="region" aria-label="${t('mb.matrixAria')}"><table class="mb-mx"><thead>${head}</thead><tbody>${rows}</tbody></table></div>
    <div class="legend mb-leg"><span>${E.DAY_TYPES.map(k => `${k} ${esc(UI.mbTypeName(k))}`).join(' · ')}</span><span><span aria-hidden="true">·</span> ${t('mb.lv0')}</span>${[1, 2, 3, 4].map(l => `<span><i class="sq mb-c mb-l${l}"></i>${t(`mb.lv${l}`)}</span>`).join('')}</div>`;
}
// Text für den gewählten Tag und das Gebiet: Feiertag im Land der Gemeinde, deutschlandweit mit Zahl der Länder; sonst Sonntag
export function dayNote(day) { const a = dayNoteHol(day), f = /^\d{4}-\d{2}-\d{2}$/.test(day || '') ? schoolNote(day) : null; return a && f ? `${a} · ${f}` : a || f; }
export function dayNoteHol(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return null;
  const st = state.scope === 'DE' ? null : scopeState();
  const hits = holidaysOf(day).map(([, name, lands]) => ({ name, lands: lands.map(l => l.replace('*', '')), part: lands.some(l => l.endsWith('*') && (!st || l.startsWith(st))) })).filter(h => !st || h.lands.includes(st));
  const sunday = new Date(`${day}T12:00:00Z`).getUTCDay() === 0;
  if (hits.length) return `Feiertag: ${hits.map(h => `${h.name}${st ? ` (${st}${h.part ? t('app.partly') : ''})` : h.lands.length === 16 ? ' (bundesweit)' : ` ${t('app.states', { length: h.lands.length })}`}`).join(', ')}${sunday ? ` · ${t('app.sunday')}` : ''}`;
  return sunday ? t('app.sunday') : null;
}
export async function cellsForScope(day) {
  if (state.scope === 'DE') return null;
  const st = scopeState(); if (!st) return null;
  const doc = await loadCells(day, st); return doc?.munis?.[state.scope] || null;
}
export async function renderCellsTable(day) {
  const tb = $('#tbl-cells tbody');
  const cells = await cellsForScope(day);
  if (!cells) { tb.innerHTML = state.scope === 'DE' ? emptyRow(5, t('app.cellsExistPerMunicipality'), t('app.chooseAreaAbove')) : emptyRow(5, t('app.noCellsForThisDayYet'), t('app.chooseAnotherDay')); return; }
  // Präsenz (fast immer 100 %) entfällt; Lage als Straße/Stadtteil (Nominatim, nur die gezeigten Top 20)
  const rows = Object.entries(cells).map(([cell, v]) => ({ cell, start: v[0], end: v[1], present: v[2], reloc: v[3], net: v[1] - v[0] })).filter(r => r.start + r.end + r.reloc > 0).sort((a, b) => b.start - a.start).slice(0, 20);
  const pts = rows.map(r => { const [lat, lon] = cellCenterOf(r.cell); return { ...r, lat, lon, k: geoKey(lat, lon) }; });
  tb.innerHTML = pts.map(r => `<tr><td><a href="#live" class="pick-cell" data-lat="${r.lat}" data-lon="${r.lon}"><span translate="no" data-geo="${r.k}">${esc(GEO.get(r.k) || t('app.cell'))}</span></a><div class="sub-line mono">${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}</div></td><td class="n">${fmt(r.start)}</td><td class="n">${fmt(r.end)}</td><td class="n" style="color:var(--${r.net > 0 ? 'ok' : r.net < 0 ? 'bad' : 'muted'})">${r.net > 0 ? '+' : ''}${fmt(r.net)}</td><td class="n">${fmt(r.reloc)}</td></tr>`).join('') || emptyRow(5, t('app.noMovementsInThisArea'), t('app.chooseAnotherDay'));
  queueGeo(pts);
}
// Straße/Stadtteil per Nominatim wie in der Disposition: höchstens 1 Anfrage je Sekunde, Cache (Sitzung), nur gezeigte Zeilen (≤ 20)
export const GEO = new Map();
 export const geoQueue = [];
 export let geoBusy = false;
export const geoKey = (lat, lon) => `${lat.toFixed(4)},${lon.toFixed(4)}`;
try { for (const [k, v] of Object.entries(JSON.parse(sessionStorage.getItem('mp-geo') || '{}'))) GEO.set(k, v); } catch { /* ohne Sitzungsspeicher */ }
export function geoText(j) { const a = j?.address || {}; const street = a.road || a.pedestrian || a.footway || a.square || a.path || a.cycleway || a.place || j?.name || null; const area = a.suburb || a.city_district || a.quarter || a.neighbourhood || a.village || a.town || null; return [street, area].filter(Boolean).join(' · ') || null; }
export function queueGeo(points) { for (const p of points.slice(0, 20)) if (!GEO.has(p.k) && !geoQueue.some(q => q.k === p.k)) geoQueue.push({ k: p.k, lat: p.lat, lon: p.lon }); pumpGeo(); }
export async function pumpGeo() {
  if (geoBusy) return; geoBusy = true;
  try {
    while (geoQueue.length) {
      const q = geoQueue.shift(); if (GEO.has(q.k)) continue;
      const r = await getJson(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&lat=${q.lat.toFixed(6)}&lon=${q.lon.toFixed(6)}&accept-language=de`, { timeout: 15000 });
      if (!r.status) { geoQueue.length = 0; break; } // Dienst nicht erreichbar: nicht weiter anfragen (nächster Aufruf versucht es erneut)
      GEO.set(q.k, r.ok ? geoText(r.json) : null);
      try { sessionStorage.setItem('mp-geo', JSON.stringify(Object.fromEntries(GEO))); } catch { /* voll/privat */ }
      $$(`[data-geo="${q.k}"]`).forEach(el => { const tq = GEO.get(q.k); if (tq) el.textContent = tq; });
      if (geoQueue.length) await new Promise(res => setTimeout(res, 1100)); // Nominatim-Nutzungsregel: höchstens 1 Anfrage je Sekunde
    }
  } finally { geoBusy = false; }
}
export const CELL_LAT = 0.0025, CELL_LON = 0.0035;
export function cellCenterOf(cell) { const [a, b] = cell.split(':').map(Number); return [a * CELL_LAT, b * CELL_LON]; }
export async function renderQuota() {
  const q = await loadOnce('quota', 'stations-quota.json'); const tb = $('#tbl-quota tbody');
  if (!q) { tb.innerHTML = `<tr><td colspan="5" class="empty">${t('app.noStationDataRateIsBuiltFrom')}</td></tr>`; return; }
  // virtuelle Stationen (Abstellzonen ohne Dock, Feld „virtual“) sind kein Versorgungsmangel, wenn leer → nicht in der Leer-Quote
  const vi = (q.fields || []).indexOf('virtual');
  let rows = q.stations.filter(s => (state.scope === 'DE' || s[0] === state.scope) && (state.operator === 'all' || s[1] === state.operator) && s[5] >= 3 && !(vi >= 0 && s[vi]));
  rows.sort((a, b) => (b[6] / b[5]) - (a[6] / a[5]) || b[5] - a[5]);
  rows = rows.slice(0, 25);
  tb.innerHTML = rows.map(s => `<tr><td translate="no">${esc(s[2] || t('app.station'))}${state.scope === 'DE' ? `<div class="sub-line">${esc(muniName(s[0]))}</div>` : ''}</td><td>${esc(s[1])}</td><td class="n">${fmt(s[5])}</td><td class="n"><span style="color:var(--${s[6] / s[5] >= 0.5 ? 'bad' : s[6] / s[5] >= 0.25 ? 'warn' : 'fg'})">${pctf(s[6], s[5])}</span></td><td class="n">${pctf(s[7], s[5])}</td></tr>`).join('') || `<tr><td colspan="5" class="empty">${t('app.noStationsWithEnoughRunsIn')}</td></tr>`;
}
