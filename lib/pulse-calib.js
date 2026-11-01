// Mobility Pulse — Kalibrierung an öffentlichen Referenzwerten (data/reference.json). Reine Funktionen für Browser und Node.
// Regeln (auch im Methodentext und im Panel „Kalibrierung“):
//  1. Ø Fahrtdauer/-strecke E-Scooter = Mittel der Berliner Quartalswerte (reference.fahrt, Berlin, Quartale). Gemessene Dauer
//     (20-Min.-Raster) ist eine Obergrenze und gilt nur, wenn sie darunter liegt; gemessene Distanz (Luftlinie) ist eine Untergrenze
//     und gilt nur, wenn sie darüber liegt. Räder, E-Bikes, Lastenräder: keine Kalibrierung, bisherige Annahmen.
//  2. Methodenfaktor k = amtliche Fahrten je Fahrzeug und Tag Berlin (E-Scooter) im passenden Quartal ÷ eigene Messung Berlin
//     (Zeitraum der Tagesdateien). Passendes Quartal: dasselbe Quartal, falls veröffentlicht, sonst dasselbe Kalenderquartal des
//     Vorjahres, sonst das jüngste. Spanne aus dem kleinsten und größten Quartalswert. k gilt für E-Scooter bundesweit.
//     „vorläufig“ unter 7 Messtagen oder unter 50 % beobachteter Tagesstunden; keine Kalibrierung ohne Berliner Messung.
//  3. Abdeckung = eigene E-Scooter ÷ amtliche Flotte (Stand und Art der Zahl laut Quelle).
//  4. Plausibilität ohne Faktor: Frankfurt (Jahresfahrten ÷ Tage ÷ Obergrenze = Untergrenze), Europa, Voi Konzern.
import { DEFAULT_RIDE } from './pulse-econ.js';
import { capLimit, SUSPENDED } from './pulse-report.js';
export { SUSPENDED };

export const BERLIN = '11000000';
// overFactor: gemessene Fahrten je Fahrzeug und Tag über dem größten amtlichen Berliner Quartalswert × 1,5 gelten als Überzählung (kein Faktor, nicht in Summen)
export const CALIB = { minDays: 7, minObsShare: 0.5, kMin: 0.2, kMax: 5, overFactor: 1.5 };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const fin = (v) => v != null && Number.isFinite(+v);

// ---------- Quartale ----------
/** 'YYYY-MM-DD' → 'Q4/2026' */
export const quarterOf = (day) => (/^\d{4}-\d{2}/.test(String(day || '')) ? `Q${Math.floor((+day.slice(5, 7) - 1) / 3) + 1}/${day.slice(0, 4)}` : null);
/** 'Q4/2026' → fortlaufende Nummer (Jahr × 4 + Quartal − 1), sonst null */
export function quarterKey(z) { const m = /^Q([1-4])\/(\d{4})$/.exec(String(z || '')); return m ? +m[2] * 4 + (+m[1] - 1) : null; }
const keyToQuarter = (k) => `Q${(k % 4) + 1}/${Math.floor(k / 4)}`;
/**
 * Referenzquartal zu einem Messtag: dasselbe Quartal (falls schon veröffentlicht), sonst dasselbe Kalenderquartal des Vorjahres,
 * sonst das jüngste vorhandene. entries: Einträge mit zeitraum 'Qn/JJJJ'.
 */
export function pickQuarter(entries, day) {
  const list = (entries || []).filter(e => quarterKey(e?.zeitraum) != null).sort((a, b) => quarterKey(a.zeitraum) - quarterKey(b.zeitraum));
  if (!list.length) return null;
  const q = quarterOf(day); const k = quarterKey(q);
  if (k != null) {
    const same = list.find(e => quarterKey(e.zeitraum) === k); if (same) return { entry: same, rule: 'gleiches Quartal' };
    const prev = list.find(e => quarterKey(e.zeitraum) === k - 4); if (prev) return { entry: prev, rule: 'Vorjahresquartal' };
  }
  return { entry: list[list.length - 1], rule: 'jüngstes Quartal' };
}

// ---------- 1. Fahrtdauer ----------
const berlinQuarters = (reference, list, type = 'scooter') => (reference?.[list] || []).filter(e => e?.ags === BERLIN && e.type === type && quarterKey(e.zeitraum) != null)
  .sort((a, b) => quarterKey(a.zeitraum) - quarterKey(b.zeitraum));
/**
 * Ø Fahrt je Fahrzeugart für die Umsatzschätzung. E-Scooter: Mittel der Berliner Quartalswerte (min, km), falls vorhanden;
 * sonst und für alle anderen Arten die bisherige Annahme (DEFAULT_RIDE).
 * Rückgabe { min, km, calibrated, label, from, to, n, minRange, kmRange, previous, refs }.
 */
export function rideAssumption(reference, type) {
  const def = DEFAULT_RIDE[type] || DEFAULT_RIDE.unknown;
  const base = { min: def.min, km: def.km, calibrated: false, previous: { ...def }, refs: [] };
  if (type !== 'scooter') return { ...base, label: 'Annahme (keine amtlichen Belege)' };
  const q = berlinQuarters(reference, 'fahrt').filter(e => fin(e.minMittel));
  if (!q.length) return { ...base, label: 'Annahme (Referenz fehlt)' };
  const mins = q.map(e => +e.minMittel), kms = q.filter(e => fin(e.kmMittel)).map(e => +e.kmMittel);
  return { min: mean(mins), km: kms.length ? mean(kms) : def.km, calibrated: true, label: `Berlin ${q[0].zeitraum}–${q[q.length - 1].zeitraum}`, from: q[0].zeitraum, to: q[q.length - 1].zeitraum, n: q.length,
    minRange: [Math.min(...mins), Math.max(...mins)], kmRange: kms.length ? [Math.min(...kms), Math.max(...kms)] : null, previous: { ...def }, refs: q, quelle: q[0].quelle, url: q[0].url };
}
/** Annahmen für alle Fahrzeugarten (Schlüssel wie DEFAULT_RIDE) */
export function rideAssumptions(reference) { return Object.fromEntries(Object.keys(DEFAULT_RIDE).map(t => [t, rideAssumption(reference, t)])); }
/**
 * Plausibilitätsgrenze je Art: größter amtlicher Berliner Quartalswert × CALIB.overFactor (E-Scooter 2,31 × 1,5 ≈ 3,47). Darüber gilt eine
 * Messung (Anbieter × Gebiet × Art) als Überzählung: keine Kalibrierung, nicht in Summen. Arten ohne Referenz: keine Grenze (nur die feste 15).
 */
export function rvdLimits(reference, opts = CALIB) {
  const q = berlinQuarters(reference, 'rvd').filter(e => fin(e.wert));
  return q.length ? { scooter: Math.max(...q.map(e => +e.wert)) * opts.overFactor } : {};
}
/** Kennzahlen einer Gruppe prüfen: über der Grenze → plausible false, Flag SUSPENDED vorn; Rückgabe { kpi, suspended } */
export function checkMeasured(kpi, type, limits) {
  const lim = limits?.[type];
  if (!kpi || lim == null || kpi.rvd == null || !(kpi.rvd > lim) || !kpi.plausible) return { kpi, suspended: false };
  return { kpi: { ...kpi, plausible: false, flags: [SUSPENDED, ...(kpi.flags || [])] }, suspended: true };
}

// ---------- 2. Methodenfaktor ----------
/** Messung aus einem Kommunal-Bericht (pulse-report municipalReport) der Gemeinde Berlin, Art E-Scooter */
// Nur plausible Berliner Anbieter gehen in k ein (Bericht mit rvdLimit erstellen); sources legt offen, aus welchen Anbietern k stammt.
export function measuredFromReport(rep) {
  if (!rep) return null;
  const q = rep.quality || {};
  const good = (rep.groups || []).filter(g => g.plausible && g.ridesDay != null && g.fleet > 0);
  const excluded = (rep.groups || []).filter(g => !g.plausible).map(g => ({ op: g.op, rvd: g.rvd, reason: g.flags?.[0] || 'unplausibel' }));
  const ridesDay = good.reduce((a, g) => a + g.ridesDay, 0), fleet = good.reduce((a, g) => a + g.fleet, 0);
  return { rvd: fleet > 0 ? ridesDay / fleet : null, fleet: fleet || null, ridesDay: good.length ? ridesDay : null, rides: good.reduce((a, g) => a + (g.rides || 0), 0), days: (rep.days || []).length, fullDays: q.fullDays ?? 0,
    obsMin: q.obsMin ?? 0, possibleMin: q.possibleMin ?? 0, from: rep.from ?? null, to: rep.to ?? null, operators: [...new Set(good.map(g => g.op))],
    sources: good.map(g => ({ op: g.op, rides: g.rides, ridesDay: g.ridesDay, fleet: g.fleet, rvd: g.rvd })), excluded };
}
/**
 * k = amtlicher Wert (Berlin, E-Scooter, Referenzquartal) ÷ gemessener Wert. Spanne kLow–kHigh aus kleinstem/größtem Quartalswert.
 * Nicht angewandt ohne Berliner Messung oder ohne Quartalswerte; außerhalb CALIB.kMin–kMax als unplausibel nicht angewandt.
 */
export function methodFactor(reference, measured, { day = null, opts = CALIB } = {}) {
  const refs = berlinQuarters(reference, 'rvd').filter(e => fin(e.wert));
  if (!refs.length) return { applied: false, reason: 'keine amtlichen Berliner Quartalswerte in reference.json' };
  if (!measured || !(measured.rvd > 0) || !(measured.fleet > 0)) return { applied: false, reason: measured?.excluded?.length ? `keine plausible Berliner E-Scooter-Messung (${measured.excluded.map(x => x.op).join(', ')} ausgeschlossen: Überzählung wahrscheinlich)` : 'keine Berliner E-Scooter-Messung im Zeitraum', refs, measured };
  const pick = pickQuarter(refs, day || measured.to);
  const vals = refs.map(e => +e.wert);
  const k = pick.entry.wert / measured.rvd;
  const obsShare = measured.possibleMin > 0 ? measured.obsMin / measured.possibleMin : 0;
  const why = [];
  if (measured.days < opts.minDays) why.push(`erst ${measured.days} von ${opts.minDays} Messtagen`);
  if (obsShare < opts.minObsShare) why.push(`${Math.round(obsShare * 100)} % statt ${Math.round(opts.minObsShare * 100)} % der Tagesstunden beobachtet`);
  const ok = k >= opts.kMin && k <= opts.kMax;
  // Herkunft offenlegen: „aus Dott Berlin, n Fahrten, x Messstunden“; nur ein Anbieter = Einschränkung
  const ops = measured.operators || [];
  const source = `aus ${ops.join(', ') || 'unbekannt'} Berlin, ${Math.round(measured.rides || 0)} Fahrten, ${(measured.obsMin / 60).toFixed(1).replace('.', ',')} Messstunden`;
  const single = ops.length === 1 ? `k stammt nur aus einem Anbieter (${ops[0]}); andere Anbieter können anders zählen (Kennungswechsel, Kettenfahrten)` : null;
  return { applied: ok, k, kLow: Math.min(...vals) / measured.rvd, kHigh: Math.max(...vals) / measured.rvd, ref: pick.entry, rule: pick.rule, quarter: pick.entry.zeitraum, source, single,
    refMin: Math.min(...vals), refMax: Math.max(...vals), refs, measured, obsShare, prelim: why.length > 0, prelimWhy: why,
    reason: ok ? null : `Faktor ${k.toFixed(2).replace('.', ',')} außerhalb ${String(opts.kMin).replace('.', ',')}–${String(opts.kMax).replace('.', ',')}: Messung prüfen, nicht angewandt` };
}
/**
 * Faktor auf die gemessenen Fahrten einer Gruppe: Modus „gemessen“ immer 1; sonst übersteuert die eigene Korrektur (manual ≠ 1),
 * dann k für E-Scooter; sonst 1. Rückgabe { f, lo, hi, source: 'Korrektur' | 'kalibriert' | 'gemessen' }.
 */
export function factorFor(type, { manual = 1, k = null, mode = 'kal', suspended = false } = {}) {
  if (mode === 'mess') return { f: 1, lo: 1, hi: 1, source: 'gemessen' };
  if (suspended) return { f: 1, lo: 1, hi: 1, source: 'ausgesetzt' };
  if (Number.isFinite(manual) && manual > 0 && Math.abs(manual - 1) > 1e-9) return { f: manual, lo: manual, hi: manual, source: 'Korrektur' };
  if (mode === 'kal' && type === 'scooter' && k?.applied) return { f: k.k, lo: k.kLow, hi: k.kHigh, source: 'kalibriert' };
  return { f: 1, lo: 1, hi: 1, source: 'gemessen' };
}
const LINEAR = ['rides', 'ridesDay', 'rvd', 'rvdAvail', 'utilization', 'revDay', 'revPerVehicleDay', 'revPerHour'];
/** Kennzahlen (pulse-econ kpis/combine) mit Faktor f auf die Fahrten: alle fahrtabhängigen Werte skalieren linear */
export function applyFactor(c, f) {
  if (!c) return c; if (f === 1) return { ...c, factor: 1 };
  const out = { ...c, factor: f };
  for (const k of LINEAR) if (c[k] != null && Number.isFinite(c[k])) out[k] = c[k] * f;
  return out;
}
/**
 * Kommunal-Bericht kalibrieren: E-Scooter-Gruppen × k (Spanne kLow–kHigh), andere Arten unverändert.
 * Rückgabe { groups: Map key → { ridesDay, rvd, per1000Rides, lo, hi, factor }, totals: { ridesDay, rvd, per1000Rides, lo, hi }, applied }.
 */
export function calibrateReport(rep, k) {
  const groups = new Map(); const on = !!k?.applied;
  let rd = 0, lo = 0, hi = 0, fleet = 0, any = false;
  for (const g of rep?.groups || []) {
    const suspended = (g.flags || []).includes(SUSPENDED);
    const f = on && g.ty === 'scooter' && g.plausible ? { f: k.k, lo: k.kLow, hi: k.kHigh } : { f: 1, lo: 1, hi: 1 };
    const v = g.ridesDay;
    const x = { factor: f.f, calibrated: f.f !== 1, suspended, ridesDay: v == null ? null : v * f.f, lo: v == null ? null : v * f.lo, hi: v == null ? null : v * f.hi };
    x.rvd = x.ridesDay != null && g.fleet > 0 ? x.ridesDay / g.fleet : null; x.rvdLo = x.lo != null && g.fleet > 0 ? x.lo / g.fleet : null; x.rvdHi = x.hi != null && g.fleet > 0 ? x.hi / g.fleet : null;
    x.per1000Rides = rep.pop > 0 && x.ridesDay != null ? (x.ridesDay / rep.pop) * 1000 : null;
    groups.set(g.key, x);
    if (g.plausible && v != null) { any = true; rd += x.ridesDay; lo += x.lo; hi += x.hi; fleet += g.fleet || 0; }
  }
  const per = (v) => (rep?.pop > 0 && v != null ? (v / rep.pop) * 1000 : null);
  const totals = any ? { ridesDay: rd, lo, hi, rvd: fleet > 0 ? rd / fleet : null, rvdLo: fleet > 0 ? lo / fleet : null, rvdHi: fleet > 0 ? hi / fleet : null, per1000Rides: per(rd), per1000Lo: per(lo), per1000Hi: per(hi) } : null;
  // angewandt nur, wenn mindestens eine Zeile tatsächlich kalibriert ist (alle E-Scooter ausgesetzt → wie gemessen anzeigen)
  return { groups, totals, applied: on && [...groups.values()].some(x => x.calibrated) };
}

// ---------- 3. Abdeckung ----------
/** Eigene Fahrzeuge (latest.json groups, total) ÷ amtliche Flotte je Eintrag in reference.flotte */
export function fleetCoverage(reference, groups, { type = 'scooter' } = {}) {
  return (reference?.flotte || []).filter(e => e?.ags && e.type === type && fin(e.wert) && +e.wert > 0).map(e => {
    let ours = 0; const ops = new Map();
    for (const [key, g] of Object.entries(groups || {})) { const [a, op, t] = key.split('|'); if (a !== e.ags || t !== type || !g?.total) continue; ours += g.total; ops.set(op, (ops.get(op) || 0) + g.total); }
    // genehmigt ≥ auf der Straße → Anteil ist eine Untergrenze der Feed-Abdeckung; „aktiv“ = laut Quelle im Einsatz
    const label = e.art === 'genehmigt' ? 'genehmigte Flotte' : e.art === 'aktiv' ? 'aktive Flotte' : 'Flotte laut Quelle';
    const shareLabel = e.art === 'genehmigt' ? 'Anteil an der genehmigten Flotte (Untergrenze der Feed-Abdeckung)' : e.art === 'aktiv' ? 'Anteil an der aktiven Flotte (laut Quelle gerundet)' : 'Anteil an der Flotte laut Quelle';
    return { ags: e.ags, ort: e.ort || e.ags, type, ours, official: +e.wert, share: ours / +e.wert, label, shareLabel, stand: e.stand || null, art: e.art || null, hinweis: e.hinweis || null, quelle: e.quelle || null, url: e.url || null,
      operators: [...ops].sort((a, b) => b[1] - a[1]).map(([op, n]) => ({ op, n })) };
  });
}

// ---------- 4. Plausibilität ----------
const daysOfYear = (y) => ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365);
/**
 * Prüfwerte ohne Faktor. own: { frankfurt: { rvd } , national: { rvd }, voi: { rvd, revPerVehicleDay } } (gemessen),
 * k: Ergebnis von methodFactor (für die kalibrierten Vergleichswerte). Rückgabe Liste { key, label, refValue, kind, ref, measured, calibrated, … }.
 */
export function plausibilityChecks(reference, own = {}, k = null) {
  const out = []; const f = k?.applied ? k.k : null; const lim = rvdLimits(reference).scooter ?? null;
  const over = (rvd) => rvd != null && lim != null && rvd > lim; // Überzählung: kein Faktor
  const cal = (v, rvd = v) => (v != null && f != null && !over(rvd) ? v * f : null);
  // Frankfurt u. a.: Jahresfahrten ÷ Tage ÷ Obergrenze (gültig im Jahr der Fahrten) = Untergrenze der Fahrten je Fahrzeug und Tag
  for (const t of reference?.fahrten || []) {
    if (!t?.ags || t.type !== 'scooter' || !fin(t.wert)) continue;
    const cap = (reference.obergrenzen || []).find(o => o.ags === t.ags && (o.type || 'scooter') === 'scooter');
    const year = /^\d{4}$/.test(String(t.zeitraum)) ? +t.zeitraum : null;
    const lim = cap ? capLimit(cap, year ? Date.parse(`${year}-07-01T00:00:00Z`) : Date.now()).limit : null;
    if (!year || !(lim > 0)) continue;
    const v = t.wert / daysOfYear(year) / lim; const m = own.byAgs?.[t.ags]?.rvd ?? null;
    out.push({ key: `fahrten:${t.ags}`, label: `${t.ort}: Fahrten je Fahrzeug und Tag`, kind: 'Untergrenze', refValue: v, how: `${t.wert} Fahrten ${t.zeitraum} ÷ ${daysOfYear(year)} Tage ÷ Obergrenze ${lim}`, limit: lim, trips: t.wert, year, ref: t, cap,
      measured: m, calibrated: cal(m), suspended: over(m), ratio: m != null ? m / v : null, ratioCal: cal(m) != null ? cal(m) / v : null, ok: cal(m) != null ? cal(m) >= v * 0.8 : null });
  }
  for (const e of reference?.rvd || []) {
    if (e?.ags != null || e.type !== 'scooter' || !fin(e.wert)) continue;
    const voi = /voi/i.test(e.ort || ''); const m = voi ? own.voi?.rvd ?? null : own.national?.rvd ?? null;
    out.push({ key: `rvd:${e.ort}:${e.zeitraum}`, label: `${e.ort}: Fahrten je Fahrzeug und Tag`, kind: 'Vergleich', refValue: +e.wert, ref: e, scope: voi ? 'Voi in offenen Feeds (Deutschland)' : 'E-Scooter in offenen Feeds (Deutschland)',
      measured: m, calibrated: cal(m), suspended: over(m), ratio: m != null ? m / e.wert : null, ratioCal: cal(m) != null ? cal(m) / e.wert : null });
  }
  for (const e of reference?.umsatz || []) {
    if (!fin(e?.wert)) continue; const m = /voi/i.test(e.ort || '') ? own.voi?.revPerVehicleDay ?? null : null; const r = own.voi?.rvd ?? null;
    out.push({ key: `umsatz:${e.ort}:${e.zeitraum}`, label: `${e.ort}: Umsatz je Fahrzeug und Tag`, kind: 'Vergleich', refValue: +e.wert, unit: '€', ref: e, scope: 'Voi in offenen Feeds (Deutschland), Schätzung netto',
      measured: m, calibrated: cal(m, r), suspended: over(r), ratio: m != null ? m / e.wert : null, ratioCal: cal(m, r) != null ? cal(m, r) / e.wert : null });
  }
  return out;
}

/** Alles zusammen für Panel und Bericht */
export function calibration(reference, { berlinReport = null, groups = null, day = null, own = {} } = {}) {
  const measured = measuredFromReport(berlinReport);
  const k = methodFactor(reference, measured, { day: day || measured?.to || null });
  return { at: Date.now(), assume: rideAssumptions(reference), limits: rvdLimits(reference), k, coverage: fleetCoverage(reference, groups), checks: plausibilityChecks(reference, own, k), hasReference: !!reference };
}
export { keyToQuarter };
