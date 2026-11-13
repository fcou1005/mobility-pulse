// Mobility Pulse — Kalibrierung an öffentlichen Referenzwerten (data/reference.json). Reine Funktionen für Browser und Node.
// Regeln (auch im Methodentext und im Panel „Kalibrierung“):
//  1. Ø Fahrtdauer/-strecke E-Scooter = Mittel der Berliner Quartalswerte (reference.fahrt, Berlin, Quartale). Gemessene Dauer
//     (20-Min.-Raster) ist eine Obergrenze und gilt nur, wenn sie darunter liegt; gemessene Distanz (Luftlinie) ist eine Untergrenze
//     und gilt nur, wenn sie darüber liegt. Räder, E-Bikes, Lastenräder: keine Kalibrierung, bisherige Annahmen.
//  2. Methodenfaktor k = amtliche Fahrten je Fahrzeug und Tag Berlin (E-Scooter) im passenden Quartal ÷ eigene Messung Berlin
//     (Zeitraum der Tagesdateien). Passendes Quartal: dasselbe Quartal, falls veröffentlicht, sonst dasselbe Kalenderquartal des
//     Vorjahres, sonst das jüngste. Spanne aus dem kleinsten und größten Quartalswert. k gilt für E-Scooter bundesweit.
//     Angewandt (Z3) nur, wenn alle drei gelten: (a) ≥ 7 volle Messtage mit dem Regelstand der Messung (q.ruleFullDays) und ≥ 50 % beobachteter
//     Tagesstunden, sonst „vorläufig“; (b) Freigabe in reference.json → kalibrierung.freigabe { regelstand, datum } für genau diesen Regelstand,
//     sonst „gesperrt“; (c) je Gruppe nur bei derselben Kennungsart wie die Berliner Referenz (groupKinds: stabil / periodisch / je Fahrt), sonst
//     Faktor 1 („gemessen“, z. B. stabile Kennungen). Keine Kalibrierung ohne Berliner Messung. Kalibrierte Fahrten je Fahrzeug und Tag höchstens
//     bis zur Plausibilitätsgrenze (rvdLimits), gekennzeichnet (capped).
//  3. Abdeckung = eigene E-Scooter ÷ amtliche Flotte (Stand und Art der Zahl laut Quelle).
//  4. Plausibilität ohne Faktor: Frankfurt (Jahresfahrten ÷ Tage ÷ Obergrenze = Untergrenze), Düsseldorf (SMM-CPI, alle Arten), Europa, Voi Konzern.
import { DEFAULT_RIDE, bootstrapDays, dayType } from './pulse-econ.js?v=mwezzyep';
import { capLimit, SUSPENDED, hourQuality, municipalReport, cityRanking, docRule } from './pulse-report.js?v=mwezzyep';
import { PERIODIC_RATE } from './pulse-track.js?v=mwezzyep';
export { SUSPENDED };

export const BERLIN = '11000000';
// Texte je Sprache: Funktionen mit Text nehmen lang ('de' Standard, 'en'); Zahlen mit dem Dezimalzeichen der Sprache.
// Kennungen (kind 'Untergrenze'/'Vergleich', factorFor source) bleiben sprachunabhängig.
const TXT = {
  de: { sameQ: 'gleiches Quartal', prevYearQ: 'Vorjahresquartal', latestQ: 'jüngstes Quartal', assumeNoRef: 'Annahme (keine amtlichen Belege)', assumeMissing: 'Annahme (Referenz fehlt)',
    noQuarters: 'keine amtlichen Berliner Quartalswerte in reference.json', noPlausible: 'keine plausible Berliner E-Scooter-Messung ({ops} ausgeschlossen: Überzählung wahrscheinlich)',
    noMeasure: 'keine Berliner E-Scooter-Messung im Zeitraum', fewDays: 'erst {days} von {min} vollen Messtagen mit Regelstand {rule}', noRule: 'ohne Angabe',
    lockNone: 'gesperrt: Freigabe fehlt', lockOther: 'gesperrt: Freigabe gilt für Regelstand {rel}, Messung hat {rule}', lockedNot: 'Faktor k = {k} ({lo}–{hi}) nicht angewandt – {why}',
    stApplied: 'angewandt (freigegeben am {date})', stPrelim: 'vorläufig: {days} von {min} vollen Tagen mit Regelstand {rule}', noRefKind: 'Kennungsart der Berliner Referenz unklar ({kind})',
    kStable: 'stabile Kennungen', kPeriodic: 'periodisch wechselnde Kennungen', kPerTrip: 'Kennungswechsel je Fahrt', kRotating: 'wechselnde Kennungen (Takt unbekannt)', kMixed: 'gemischte Kennungsarten', kUnknown: 'unbekannte Kennungsart',
    notKind: 'nicht für {kind}', onlyKind: 'k gilt nur für {kind} wie {ops} Berlin; andere Kennungsarten bleiben gemessen',
    fleet1000Of: '{ort}: Fahrzeuge je 1.000 Einwohner', rides1000Of: '{ort}: Fahrten je 1.000 Einwohner und Tag', revRideOf: '{ort}: Umsatz je Fahrt',
    scopeCityAll: '{ort}, alle Fahrzeugarten in offenen Feeds', scopeCity: '{ort}, E-Scooter in offenen Feeds', scopeRevRide: 'Voi in offenen Feeds (Deutschland), Umsatz ÷ Fahrten (ohne Faktor gleich)',
    prelimNot: 'vorläufiger Faktor k = {k} ({lo}–{hi}) nicht angewandt: {why}', fewHours: '{a} % statt {b} % der Tagesstunden beobachtet',
    source: 'aus {ops} Berlin, {rides} Fahrten, {hours} Messstunden', unknown: 'unbekannt', single: 'k stammt nur aus einem Anbieter ({op}); andere Anbieter können anders zählen (Kennungswechsel, Kettenfahrten)',
    outside: 'Faktor {k} außerhalb {min}–{max}: Messung prüfen, nicht angewandt', licensed: 'genehmigte Flotte', active: 'aktive Flotte', perSource: 'Flotte laut Quelle',
    shareLicensed: 'Anteil an der genehmigten Flotte (Untergrenze der Feed-Abdeckung)', shareActive: 'Anteil an der aktiven Flotte (laut Quelle gerundet)', sharePerSource: 'Anteil an der Flotte laut Quelle',
    rvdOf: '{ort}: Fahrten je Fahrzeug und Tag', revOf: '{ort}: Umsatz je Fahrzeug und Tag', how: '{trips} Fahrten {year} ÷ {days} Tage ÷ Obergrenze {lim}',
    scopeVoi: 'Voi in offenen Feeds (Deutschland)', scopeAll: 'E-Scooter in offenen Feeds (Deutschland)', scopeRev: 'Voi in offenen Feeds (Deutschland), Schätzung netto' },
  en: { sameQ: 'same quarter', prevYearQ: 'same quarter of the previous year', latestQ: 'latest quarter', assumeNoRef: 'assumption (no official evidence)', assumeMissing: 'assumption (reference missing)',
    noQuarters: 'no official Berlin quarterly values in reference.json', noPlausible: 'no plausible Berlin e-scooter measurement ({ops} excluded: overcount likely)',
    noMeasure: 'no Berlin e-scooter measurement in the period', fewDays: 'only {days} of {min} full measurement days with rule version {rule}', noRule: 'not stated',
    lockNone: 'locked: release missing', lockOther: 'locked: release applies to rule version {rel}, measurement has {rule}', lockedNot: 'Factor k = {k} ({lo}–{hi}) not applied – {why}',
    stApplied: 'applied (released on {date})', stPrelim: 'provisional: {days} of {min} full days with rule version {rule}', noRefKind: 'ID type of the Berlin reference unclear ({kind})',
    kStable: 'stable IDs', kPeriodic: 'periodically rotating IDs', kPerTrip: 'IDs changing with every trip', kRotating: 'rotating IDs (interval unknown)', kMixed: 'mixed ID types', kUnknown: 'unknown ID type',
    notKind: 'not for {kind}', onlyKind: 'k only applies to {kind} as at {ops} Berlin; other ID types stay measured',
    fleet1000Of: '{ort}: vehicles per 1,000 residents', rides1000Of: '{ort}: trips per 1,000 residents per day', revRideOf: '{ort}: revenue per trip',
    scopeCityAll: '{ort}, all vehicle types in open feeds', scopeCity: '{ort}, e-scooters in open feeds', scopeRevRide: 'Voi in open feeds (Germany), revenue ÷ trips (same without factor)',
    prelimNot: 'provisional factor k = {k} ({lo}–{hi}) not applied: {why}', fewHours: '{a} % instead of {b} % of the hours of the day observed',
    source: 'from {ops} Berlin, {rides} trips, {hours} measured hours', unknown: 'unknown', single: 'k comes from only one operator ({op}); other operators may count differently (ID rotation, chained trips)',
    outside: 'Factor {k} outside {min}–{max}: check the measurement, not applied', licensed: 'licensed fleet', active: 'active fleet', perSource: 'fleet according to source',
    shareLicensed: 'Share of the licensed fleet (lower bound of feed coverage)', shareActive: 'Share of the active fleet (rounded according to source)', sharePerSource: 'Share of the fleet according to source',
    rvdOf: '{ort}: trips per vehicle per day', revOf: '{ort}: revenue per vehicle per day', how: '{trips} trips {year} ÷ {days} days ÷ fleet cap {lim}',
    scopeVoi: 'Voi in open feeds (Germany)', scopeAll: 'E-scooters in open feeds (Germany)', scopeRev: 'Voi in open feeds (Germany), net estimate' },
};
const tx = (lang, k, v = {}) => (TXT[lang]?.[k] ?? TXT.de[k]).replace(/\{(\w+)\}/g, (m, x) => (x in v ? String(v[x]) : m));
const dec = (lang, n, d) => (d == null ? String(n) : n.toFixed(d)).replace('.', lang === 'en' ? '.' : ',');
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
export function pickQuarter(entries, day, lang = 'de') {
  const list = (entries || []).filter(e => quarterKey(e?.zeitraum) != null).sort((a, b) => quarterKey(a.zeitraum) - quarterKey(b.zeitraum));
  if (!list.length) return null;
  const q = quarterOf(day); const k = quarterKey(q);
  if (k != null) {
    const same = list.find(e => quarterKey(e.zeitraum) === k); if (same) return { entry: same, rule: tx(lang, 'sameQ') };
    const prev = list.find(e => quarterKey(e.zeitraum) === k - 4); if (prev) return { entry: prev, rule: tx(lang, 'prevYearQ') };
  }
  return { entry: list[list.length - 1], rule: tx(lang, 'latestQ') };
}

// ---------- 1. Fahrtdauer ----------
const berlinQuarters = (reference, list, type = 'scooter') => (reference?.[list] || []).filter(e => e?.ags === BERLIN && e.type === type && quarterKey(e.zeitraum) != null)
  .sort((a, b) => quarterKey(a.zeitraum) - quarterKey(b.zeitraum));
/**
 * Ø Fahrt je Fahrzeugart für die Umsatzschätzung. E-Scooter: Mittel der Berliner Quartalswerte (min, km), falls vorhanden;
 * sonst und für alle anderen Arten die bisherige Annahme (DEFAULT_RIDE).
 * Rückgabe { min, km, calibrated, label, from, to, n, minRange, kmRange, previous, refs }.
 */
export function rideAssumption(reference, type, lang = 'de') {
  const def = DEFAULT_RIDE[type] || DEFAULT_RIDE.unknown;
  const base = { min: def.min, km: def.km, calibrated: false, previous: { ...def }, refs: [] };
  if (type !== 'scooter') return { ...base, label: tx(lang, 'assumeNoRef') };
  const q = berlinQuarters(reference, 'fahrt').filter(e => fin(e.minMittel));
  if (!q.length) return { ...base, label: tx(lang, 'assumeMissing') };
  const mins = q.map(e => +e.minMittel), kms = q.filter(e => fin(e.kmMittel)).map(e => +e.kmMittel);
  return { min: mean(mins), km: kms.length ? mean(kms) : def.km, calibrated: true, label: `Berlin ${q[0].zeitraum}–${q[q.length - 1].zeitraum}`, from: q[0].zeitraum, to: q[q.length - 1].zeitraum, n: q.length,
    minRange: [Math.min(...mins), Math.max(...mins)], kmRange: kms.length ? [Math.min(...kms), Math.max(...kms)] : null, previous: { ...def }, refs: q, quelle: q[0].quelle, url: q[0].url };
}
/** Annahmen für alle Fahrzeugarten (Schlüssel wie DEFAULT_RIDE) */
export function rideAssumptions(reference, lang = 'de') { return Object.fromEntries(Object.keys(DEFAULT_RIDE).map(t => [t, rideAssumption(reference, t, lang)])); }
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

// ---------- Kennungsart je Gruppe (Z3c) ----------
// srcModes je Quelle (events/<Tag>.json: 'stable' | 'rotating' | 'unknown', jüngster bekannte Wert) über latest.sources (id, operator,
// municipalities) auf Gemeinde|Anbieter; 'rotating' nach Takt wie pulse-track (PERIODIC_RATE): Kennungswechsel je Fahrzeug und Lauf aus den
// Stundenwerten (rot ÷ Fahrzeugläufe, Fahrzeugläufe = vminTot × Läufe ÷ Messminuten) ab 0,2 = 'periodic' (Lime direkt: jede Kennung je Lauf),
// darunter 'perTrip' (Dott, Voi, nextbike). Mehrere bekannte Modi für eine Gruppe = 'mixed', keiner = 'unknown'. Nur Zählungen, keine Kennungen.
export const KIND_TXT = { stable: 'kStable', periodic: 'kPeriodic', perTrip: 'kPerTrip', rotating: 'kRotating', mixed: 'kMixed', unknown: 'kUnknown' };
export const kindText = (kind, lang = 'de') => tx(lang, KIND_TXT[kind] || 'kUnknown');
const MIN_VEH_RUNS = 100; // darunter kein Takturteil ('rotating')
export function groupKinds(docs = [], sources = [], { periodicRate = PERIODIC_RATE } = {}) {
  const list = (docs || []).filter(d => d?.groups).sort((a, b) => String(a.day).localeCompare(String(b.day)));
  const modes = {};
  for (const d of list) for (const [id, m] of Object.entries(d.srcModes || {})) if (m && (m !== 'unknown' || !(id in modes))) modes[id] = m;
  const bySrc = new Map();
  for (const r of sources || []) { const m = modes[r?.id]; if (!m || m === 'unknown' || r.status === 'retired') continue; for (const a of r.municipalities || []) { const k = `${a}|${r.operator}`; (bySrc.get(k) || bySrc.set(k, new Set()).get(k)).add(m); } }
  const rot = new Map();
  for (const d of list) {
    const hq = hourQuality(d.runs, d.gapHours);
    for (const [k, g] of Object.entries(d.groups)) {
      if (k.startsWith('DE|')) continue; let w = 0, vr = 0;
      for (let h = 0; h < 24; h++) { if (!hq.ok[h] || !(hq.obs[h] > 0) || !hq.n[h]) continue; w += g.rot?.[h] || 0; vr += (g.vminTot?.[h] || 0) * hq.n[h] / hq.obs[h]; }
      const a = rot.get(k) || [0, 0]; a[0] += w; a[1] += vr; rot.set(k, a);
    }
  }
  const out = {};
  for (const [k, [w, vr]] of rot) {
    const [ags, op] = k.split('|'); const ms = bySrc.get(`${ags}|${op}`);
    let kind = !ms?.size ? 'unknown' : ms.size > 1 ? 'mixed' : [...ms][0];
    if (kind === 'rotating' && vr >= MIN_VEH_RUNS) kind = w / vr >= periodicRate ? 'periodic' : 'perTrip';
    out[k] = kind;
  }
  return out;
}
/** Eine Kennungsart für mehrere Gruppen: gleich → diese, verschieden → 'mixed', keine → null */
export const commonKind = (list) => { const s = new Set((list || []).filter(Boolean)); return s.size === 1 ? [...s][0] : s.size ? 'mixed' : null; };
// k wirkt auf eine Gruppe nur bei der Kennungsart der Referenz; k ohne refKind (ältere/handgebaute Objekte) wirkt wie bisher auf alle
const kindMatches = (k, kind) => k?.refKind === undefined || (kind != null && kind === k.refKind);
// k gilt nur für die Anbieter, aus deren Berliner Messung es stammt (Audit 11.11.2026, MET-07): der Faktor aus Dott Berlin (≈ 1,9) machte
// Voi Stuttgart von 1,81 zu 3,46 Fahrten je Fahrzeug, obwohl Voi, Bolt und Lime ohne Faktor schon über Dott liegen. Ohne Anbieterliste
// (ältere k) wie bisher; für Summen über mehrere Anbieter (op = null) kein Faktor.
export const opMatches = (k, op) => { const o = k?.measured?.operators || []; return !o.length || (op != null && o.includes(op)); };

// ---------- 2. Methodenfaktor ----------
/** Messung aus einem Kommunal-Bericht (pulse-report municipalReport) der Gemeinde Berlin, Art E-Scooter */
// Nur plausible Berliner Anbieter gehen in k ein (Bericht mit rvdLimit erstellen); sources legt offen, aus welchen Anbietern k stammt.
// kinds (groupKinds): Kennungsart der Anbieter, aus denen k stammt (kind; null ohne kinds). rule/ruleFullDays: Regelstand der Messung (Vertrag 2).
export function measuredFromReport(rep, kinds = null) {
  if (!rep) return null;
  const q = rep.quality || {};
  const good = (rep.groups || []).filter(g => g.plausible && g.ridesDay != null && g.fleet > 0);
  const excluded = (rep.groups || []).filter(g => !g.plausible).map(g => ({ op: g.op, rvd: g.rvd, reason: g.flags?.[0] || 'unplausibel' }));
  const ridesDay = good.reduce((a, g) => a + g.ridesDay, 0), fleet = good.reduce((a, g) => a + g.fleet, 0);
  const kindOf = (g) => kinds?.[`${rep.ags ?? BERLIN}|${g.op}|${g.ty}`] || 'unknown';
  // A6: Tageswerte der plausiblen Gruppen (Fahrten je Tag hochgerechnet, Flotte) für das Band von k und k je Tagtyp
  const byDay = new Map(); for (const g of good) for (const d of g.perDay || []) { if (!(d.cov > 0)) continue; const x = byDay.get(d.day) || { day: d.day, ridesDay: 0, fleet: 0 }; x.ridesDay += d.rides / d.cov; if (d.fleet != null) x.fleet += d.fleet; byDay.set(d.day, x); }
  const dayVals = [...byDay.values()].filter(x => x.fleet > 0).sort((a, b) => (a.day < b.day ? -1 : 1));
  return { rvd: fleet > 0 ? ridesDay / fleet : null, fleet: fleet || null, ridesDay: good.length ? ridesDay : null, dayVals, rides: good.reduce((a, g) => a + (g.rides || 0), 0), days: (rep.days || []).length, fullDays: q.fullDays ?? 0,
    obsMin: q.obsMin ?? 0, possibleMin: q.possibleMin ?? 0, from: rep.from ?? null, to: rep.to ?? null, operators: [...new Set(good.map(g => g.op))],
    rule: q.rule ?? null, ruleFullDays: q.ruleFullDays ?? 0, kind: kinds ? commonKind(good.map(kindOf)) : null,
    sources: good.map(g => ({ op: g.op, rides: g.rides, ridesDay: g.ridesDay, fleet: g.fleet, rvd: g.rvd, ...(kinds ? { kind: kindOf(g) } : {}) })), excluded };
}
/** Freigabe aus reference.json → kalibrierung.freigabe ({ regelstand, datum }); null = gesperrt */
export function releaseOf(reference) {
  const f = reference?.kalibrierung?.freigabe;
  return f && typeof f.regelstand === 'string' && f.regelstand.trim() ? { regelstand: f.regelstand.trim(), datum: typeof f.datum === 'string' ? f.datum : null } : null;
}
const dateTxt = (lang, d) => (!/^\d{4}-\d{2}-\d{2}/.test(String(d || '')) ? '–' : lang === 'en' ? d.slice(0, 10) : `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`);
/**
 * k = amtlicher Wert (Berlin, E-Scooter, Referenzquartal) ÷ gemessener Wert. Spanne kLow–kHigh aus kleinstem/größtem Quartalswert.
 * Nicht angewandt ohne Berliner Messung oder ohne Quartalswerte; außerhalb CALIB.kMin–kMax als unplausibel nicht angewandt.
 */
// Zustand (status): 'applied' (angewandt, freigegeben), 'locked' (Freigabe fehlt oder gilt für einen anderen Regelstand), 'prelim' (freigegeben,
// aber unter 7 vollen Regelstand-Tagen oder 50 % der Stunden), 'off' (keine Messung, k außerhalb kMin–kMax, Kennungsart der Referenz unklar).
// statusText: kurzer Zustand je Sprache für Schalter und Kacheln; reason: ausführlicher Grund, solange k nicht angewandt ist.
export function methodFactor(reference, measured, { day = null, opts = CALIB, lang = 'de' } = {}) {
  const refs = berlinQuarters(reference, 'rvd').filter(e => fin(e.wert));
  const off = (reason, x = {}) => ({ applied: false, status: 'off', statusText: reason, reason, release: releaseOf(reference), refKind: null, ...x });
  if (!refs.length) return off(tx(lang, 'noQuarters'));
  if (!measured || !(measured.rvd > 0) || !(measured.fleet > 0)) return off(measured?.excluded?.length ? tx(lang, 'noPlausible', { ops: measured.excluded.map(x => x.op).join(', ') }) : tx(lang, 'noMeasure'), { refs, measured });
  const pick = pickQuarter(refs, day || measured.to, lang);
  const vals = refs.map(e => +e.wert);
  const k = pick.entry.wert / measured.rvd;
  const obsShare = measured.possibleMin > 0 ? measured.obsMin / measured.possibleMin : 0;
  const why = [];
  // (a) Kalibrierbasis: volle Messtage (≥ 20 Stunden mit ≥ 50 Min.) mit dem Regelstand der Messung; ohne Angabe 0
  const fullDays = Number.isFinite(measured.fullDays) ? measured.fullDays : measured.days;
  const ruleId = measured.rule ?? null, ruleDays = ruleId != null && Number.isFinite(measured.ruleFullDays) ? measured.ruleFullDays : 0, ruleTxt = ruleId ?? tx(lang, 'noRule');
  if (!(ruleDays >= opts.minDays)) why.push(tx(lang, 'fewDays', { days: ruleDays, min: opts.minDays, rule: ruleTxt }));
  if (obsShare < opts.minObsShare) why.push(tx(lang, 'fewHours', { a: Math.round(obsShare * 100), b: Math.round(opts.minObsShare * 100) }));
  // (b) Freigabe für genau diesen Regelstand
  const release = releaseOf(reference);
  const lock = !release ? tx(lang, 'lockNone') : release.regelstand !== ruleId ? tx(lang, 'lockOther', { rel: release.regelstand, rule: ruleTxt }) : null;
  // (c) Kennungsart der Referenz: eindeutig und bekannt (stabil, periodisch, je Fahrt, wechselnd)
  const refKind = ['mixed', 'unknown'].includes(measured.kind) ? null : measured.kind ?? null;
  const kindWhy = refKind ? null : tx(lang, 'noRefKind', { kind: kindText(measured.kind || 'unknown', lang) });
  const ok = k >= opts.kMin && k <= opts.kMax;
  // A6/A8: 90-%-Band aus Bootstrap über die Messtage und der Streuung der Quartale (je Ziehung ein Quartalswert); unter 3 Tagen wie bisher
  // die Spanne kleinster/größter Quartalswert. k je Tagtyp (Berlin, ohne Feiertagskalender; W Werktag, S Samstag, H Sonn-/Feiertag).
  const dv = measured.dayVals || [], ratio = (s) => { let r = 0, f = 0; for (const d of s) { r += d.ridesDay; f += d.fleet; } return f > 0 ? r / f : NaN; };
  const band = bootstrapDays(dv, (s, rnd) => vals[Math.floor(rnd() * vals.length)] / ratio(s), { key: `k|${measured.from}|${measured.to}` });
  const kLow = band ? band[0] : Math.min(...vals) / measured.rvd, kHigh = band ? band[1] : Math.max(...vals) / measured.rvd;
  const kByType = {}; for (const ty of ['W', 'S', 'F', 'H']) { const ds = dv.filter(d => dayType(d.day, 'BE', null) === ty); if (ds.length) kByType[ty] = pick.entry.wert / ratio(ds); }
  // Herkunft offenlegen: „aus Dott Berlin, n Fahrten, x Messstunden“; nur ein Anbieter = Einschränkung
  const ops = measured.operators || [];
  const source = tx(lang, 'source', { ops: ops.join(', ') || tx(lang, 'unknown'), rides: Math.round(measured.rides || 0), hours: dec(lang, measured.obsMin / 60, 1) });
  const single = ops.length === 1 ? tx(lang, 'single', { op: ops[0] }) : null;
  const applied = ok && !why.length && !lock && !kindWhy;
  const status = !ok || kindWhy ? 'off' : lock ? 'locked' : why.length ? 'prelim' : 'applied';
  const kv = { k: dec(lang, k, 2), lo: dec(lang, kLow, 2), hi: dec(lang, kHigh, 2) };
  const outside = tx(lang, 'outside', { k: kv.k, min: dec(lang, opts.kMin), max: dec(lang, opts.kMax) });
  const reason = applied ? null : !ok ? outside : kindWhy ? tx(lang, 'lockedNot', { ...kv, why: kindWhy }) : lock ? tx(lang, 'lockedNot', { ...kv, why: [lock, ...why].join('; ') }) : tx(lang, 'prelimNot', { ...kv, why: why.join('; ') });
  const statusText = status === 'applied' ? tx(lang, 'stApplied', { date: dateTxt(lang, release.datum) }) : status === 'locked' ? lock
    : status === 'prelim' ? (ruleDays < opts.minDays ? tx(lang, 'stPrelim', { days: ruleDays, min: opts.minDays, rule: ruleTxt }) : why[0]) : !ok ? outside : kindWhy;
  // angewandt erst mit Kalibrierbasis, Freigabe und bekannter Kennungsart; sonst k nur anzeigen (reason nennt Wert und Vorbehalte)
  return { applied, status, statusText, k, kLow, kHigh, kBand: band ? 'bootstrap' : 'quartale', kByType, ref: pick.entry, rule: pick.rule, quarter: pick.entry.zeitraum, source, single,
    refMin: Math.min(...vals), refMax: Math.max(...vals), refs, measured, obsShare, fullDays, ruleId, ruleDays, release, lock, refKind, refKindText: refKind ? kindText(refKind, lang) : null,
    onlyKind: refKind ? tx(lang, 'onlyKind', { kind: kindText(refKind, lang), ops: ops.join(', ') || tx(lang, 'unknown') }) : null,
    prelim: why.length > 0, prelimWhy: why, reason };
}
/**
 * Faktor auf die gemessenen Fahrten einer Gruppe: Modus „gemessen“ immer 1; sonst übersteuert die eigene Korrektur (manual ≠ 1),
 * dann k für E-Scooter derselben Kennungsart wie die Referenz (kind, groupKinds); sonst 1.
 * Rückgabe { f, lo, hi, source: 'Korrektur' | 'kalibriert' | 'gemessen' | 'ausgesetzt', skip?: 'kind', kind? } – skip: k angewandt, aber nicht für diese Kennungsart.
 */
export function factorFor(type, { manual = 1, k = null, mode = 'kal', suspended = false, kind = null, op = undefined } = {}) {
  if (mode === 'mess') return { f: 1, lo: 1, hi: 1, source: 'gemessen' };
  if (suspended) return { f: 1, lo: 1, hi: 1, source: 'ausgesetzt' };
  if (Number.isFinite(manual) && manual > 0 && Math.abs(manual - 1) > 1e-9) return { f: manual, lo: manual, hi: manual, source: 'Korrektur' };
  if (mode === 'kal' && type === 'scooter' && k?.applied && op !== undefined && !opMatches(k, op)) return { f: 1, lo: 1, hi: 1, source: 'gemessen', skip: 'op', ops: k.measured?.operators || [] };
  if (mode === 'kal' && type === 'scooter' && k?.applied) return kindMatches(k, kind) ? { f: k.k, lo: k.kLow, hi: k.kHigh, source: 'kalibriert' } : { f: 1, lo: 1, hi: 1, source: 'gemessen', skip: 'kind', kind: kind || 'unknown' };
  return { f: 1, lo: 1, hi: 1, source: 'gemessen' };
}
const LINEAR = ['rides', 'ridesDay', 'rvd', 'rvdAvail', 'utilization', 'revDay', 'revPerVehicleDay', 'revPerHour'];
/** Faktor so begrenzen, dass rvd × f die Plausibilitätsgrenze nicht übersteigt (keine kalibrierten Werte über der eigenen Überzählungsgrenze) */
export function cappedFactor(f, rvd, limit) {
  if (!(f > 1) || limit == null || !(rvd > 0) || rvd * f <= limit) return { f, capped: false };
  return { f: Math.max(1, limit / rvd), capped: true };
}
/**
 * Fahrten je Fahrzeug und Tag einer Gemeinde mit k (Abdeckung/Hochrechnung): nur bei angewandtem k, gemessenem Wert nicht über der Grenze und
 * Kennungsart der Gemeinde (own.byAgs[ags].kind, commonKind) gleich der Referenz (k.refKind); Faktor über cappedFactor begrenzt.
 * Rückgabe { rvd, capped, skip: null | 'off' | 'suspended' | 'kind', kind? } – rvd null = gemessen lassen (skip nennt den Grund).
 */
export function calibratedRvd(rvd, k, { kind = null, limit = null, op = null } = {}) {
  if (!(rvd > 0) || !k?.applied) return { rvd: null, capped: false, skip: 'off' };
  if (!opMatches(k, op)) return { rvd: null, capped: false, skip: 'op', ops: k.measured?.operators || [] };
  if (limit != null && rvd > limit) return { rvd: null, capped: false, skip: 'suspended' };
  if (!kindMatches(k, kind)) return { rvd: null, capped: false, skip: 'kind', kind: kind || 'unknown' };
  const cf = cappedFactor(k.k, rvd, limit); return { rvd: rvd * cf.f, capped: cf.capped, skip: null };
}
/** Kennzahlen (pulse-econ kpis/combine) mit Faktor f auf die Fahrten: alle fahrtabhängigen Werte skalieren linear; limit: Grenze für rvd × f */
export function applyFactor(c, f, { limit = null } = {}) {
  if (!c) return c; if (f === 1) return { ...c, factor: 1 };
  const cf = cappedFactor(f, c.rvd, limit); f = cf.f;
  const out = { ...c, factor: f, ...(cf.capped ? { capped: true } : {}) };
  for (const k of LINEAR) if (c[k] != null && Number.isFinite(c[k])) out[k] = c[k] * f;
  return out;
}
/**
 * Kommunal-Bericht kalibrieren: E-Scooter-Gruppen × k (Spanne kLow–kHigh), andere Arten unverändert. limits (rvdLimits): kalibrierte Fahrten je
 * Fahrzeug und Tag höchstens bis zur Grenze (Faktor gekappt, capped: true).
 * kinds (groupKinds, Schlüssel Gemeinde|Anbieter|Art): k nur für E-Scooter mit der Kennungsart der Referenz, sonst Faktor 1 (skipKind = Art).
 * Rückgabe { groups: Map key → { ridesDay, rvd, per1000Rides, lo, hi, factor, capped, skipKind }, totals: { ridesDay, rvd, per1000Rides, lo, hi }, applied, capped, skipped }.
 */
export function calibrateReport(rep, k, { limits = null, kinds = null } = {}) {
  const groups = new Map(); const on = !!k?.applied; const skipped = [];
  let rd = 0, lo = 0, hi = 0, fleet = 0, any = false, cappedAny = false;
  for (const g of rep?.groups || []) {
    const suspended = (g.flags || []).includes(SUSPENDED);
    const lim = limits?.[g.ty] ?? null, cap = (x) => cappedFactor(x, g.rvd, lim);
    const kind = kinds?.[`${rep.ags}|${g.op}|${g.ty}`] ?? null, kindOk = kindMatches(k, kind) && opMatches(k, g.op);
    const f = on && g.ty === 'scooter' && g.plausible && kindOk ? { f: cap(k.k).f, lo: cap(k.kLow).f, hi: cap(k.kHigh).f, capped: cap(k.k).capped } : { f: 1, lo: 1, hi: 1, capped: false };
    const v = g.ridesDay;
    const x = { factor: f.f, calibrated: f.f !== 1, suspended, capped: f.capped, ridesDay: v == null ? null : v * f.f, lo: v == null ? null : v * f.lo, hi: v == null ? null : v * f.hi,
      skipKind: on && g.ty === 'scooter' && g.plausible && !kindOk ? kind || 'unknown' : null };
    if (x.skipKind) skipped.push({ key: g.key, op: g.op, kind: x.skipKind });
    if (f.capped) cappedAny = true;
    x.rvd = x.ridesDay != null && g.fleet > 0 ? x.ridesDay / g.fleet : null; x.rvdLo = x.lo != null && g.fleet > 0 ? x.lo / g.fleet : null; x.rvdHi = x.hi != null && g.fleet > 0 ? x.hi / g.fleet : null;
    x.per1000Rides = rep.pop > 0 && x.ridesDay != null ? (x.ridesDay / rep.pop) * 1000 : null;
    groups.set(g.key, x);
    if (g.plausible && v != null) { any = true; rd += x.ridesDay; lo += x.lo; hi += x.hi; fleet += g.fleet || 0; }
  }
  const per = (v) => (rep?.pop > 0 && v != null ? (v / rep.pop) * 1000 : null);
  const totals = any ? { ridesDay: rd, lo, hi, rvd: fleet > 0 ? rd / fleet : null, rvdLo: fleet > 0 ? lo / fleet : null, rvdHi: fleet > 0 ? hi / fleet : null, per1000Rides: per(rd), per1000Lo: per(lo), per1000Hi: per(hi) } : null;
  // angewandt nur, wenn mindestens eine Zeile tatsächlich kalibriert ist (alle E-Scooter ausgesetzt → wie gemessen anzeigen)
  return { groups, totals, applied: on && [...groups.values()].some(x => x.calibrated), capped: cappedAny, skipped };
}

// ---------- 3. Abdeckung ----------
/** Eigene Fahrzeuge (latest.json groups, total) ÷ amtliche Flotte je Eintrag in reference.flotte */
export function fleetCoverage(reference, groups, { type = 'scooter', lang = 'de' } = {}) {
  return (reference?.flotte || []).filter(e => e?.ags && e.type === type && fin(e.wert) && +e.wert > 0).map(e => {
    let ours = 0; const ops = new Map();
    for (const [key, g] of Object.entries(groups || {})) { const [a, op, t] = key.split('|'); if (a !== e.ags || t !== type || !g?.total) continue; ours += g.total; ops.set(op, (ops.get(op) || 0) + g.total); }
    // genehmigt ≥ auf der Straße → Anteil ist eine Untergrenze der Feed-Abdeckung; „aktiv“ = laut Quelle im Einsatz
    const label = tx(lang, e.art === 'genehmigt' ? 'licensed' : e.art === 'aktiv' ? 'active' : 'perSource');
    const shareLabel = tx(lang, e.art === 'genehmigt' ? 'shareLicensed' : e.art === 'aktiv' ? 'shareActive' : 'sharePerSource');
    return { ags: e.ags, ort: e.ort || e.ags, type, ours, official: +e.wert, share: ours / +e.wert, label, shareLabel, stand: e.stand || null, art: e.art || null, hinweis: e.hinweis || null, quelle: e.quelle || null, url: e.url || null,
      operators: [...ops].sort((a, b) => b[1] - a[1]).map(([op, n]) => ({ op, n })) };
  });
}

// ---------- 4. Plausibilität ----------
const daysOfYear = (y) => ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365);
/**
 * Prüfwerte ohne Faktor. own: { byAgs: { ags: { rvd, kind } }, byAgsAll: { ags: { rvd, per1000Fleet, per1000Rides, rvdCal, per1000RidesCal } },
 * national: { rvd, kind }, voi: { rvd, revPerVehicleDay, revPerRide, kind } } (gemessen; kind = Kennungsart der E-Scooter dort, commonKind),
 * k: Ergebnis von methodFactor (für die kalibrierten Vergleichswerte, nur bei passender Kennungsart). Rückgabe Liste { key, label, refValue, kind, ref, measured, calibrated, … }.
 * Stadtwerte mit ags (außer Berlin) in reference.rvd: Vergleich mit der eigenen Messung dort (type 'all' = alle Arten, byAgsAll), dazu
 * flotteJe1000/fahrtenJe1000 desselben Eintrags; Umsatz mit einheit „€ je Fahrt“ gegen Umsatz ÷ Fahrten (vom Faktor unabhängig).
 */
export function plausibilityChecks(reference, own = {}, k = null, lang = 'de') {
  const out = []; const f = k?.applied ? k.k : null; const lim = rvdLimits(reference).scooter ?? null;
  const over = (rvd) => rvd != null && lim != null && rvd > lim; // Überzählung: kein Faktor
  const cal = (v, rvd = v, kind, op = null) => (v != null && f != null && !over(rvd) && kindMatches(k, kind) && opMatches(k, op) ? v * cappedFactor(f, rvd, lim).f : null); // höchstens bis zur Grenze, nur passende Kennungsart und Anbieter
  const notOp = (op = null) => (f != null && !opMatches(k, op) ? k.measured.operators : null); // MET-07: k stammt nur von diesen Anbietern
  // Frankfurt u. a.: Jahresfahrten ÷ Tage ÷ Obergrenze (gültig im Jahr der Fahrten) = Untergrenze der Fahrten je Fahrzeug und Tag
  for (const t of reference?.fahrten || []) {
    if (!t?.ags || t.type !== 'scooter' || !fin(t.wert)) continue;
    const cap = (reference.obergrenzen || []).find(o => o.ags === t.ags && (o.type || 'scooter') === 'scooter');
    const year = /^\d{4}$/.test(String(t.zeitraum)) ? +t.zeitraum : null;
    const lim = cap ? capLimit(cap, year ? Date.parse(`${year}-07-01T00:00:00Z`) : Date.now()).limit : null;
    if (!year || !(lim > 0)) continue;
    const v = t.wert / daysOfYear(year) / lim; const o = own.byAgs?.[t.ags] || {}, m = o.rvd ?? null, c = cal(m, m, o.kind);
    out.push({ key: `fahrten:${t.ags}`, label: tx(lang, 'rvdOf', { ort: t.ort }), kind: 'Untergrenze', refValue: v, how: tx(lang, 'how', { trips: t.wert, year: t.zeitraum, days: daysOfYear(year), lim }), limit: lim, trips: t.wert, year, ref: t, cap,
      measured: m, calibrated: c, suspended: over(m), ratio: m != null ? m / v : null, ratioCal: c != null ? c / v : null, ok: c != null ? c >= v * 0.8 : null, idKind: o.kind ?? null, notOp: notOp() });
  }
  for (const e of reference?.rvd || []) {
    if (e?.ags != null || e.type !== 'scooter' || !fin(e.wert)) continue;
    const voi = /voi/i.test(e.ort || ''), op = voi ? 'Voi' : null; const o = (voi ? own.voi : own.national) || {}, m = o.rvd ?? null, c = cal(m, m, o.kind, op);
    out.push({ key: `rvd:${e.ort}:${e.zeitraum}`, label: tx(lang, 'rvdOf', { ort: e.ort }), kind: 'Vergleich', refValue: +e.wert, ref: e, scope: tx(lang, voi ? 'scopeVoi' : 'scopeAll'),
      measured: m, calibrated: c, suspended: over(m), ratio: m != null ? m / e.wert : null, ratioCal: c != null ? c / e.wert : null, idKind: o.kind ?? null, notOp: notOp(op) });
  }
  // Stadtwerte (z. B. Düsseldorf, SMM-CPI): Fahrten je Fahrzeug und Tag, Fahrzeuge und Fahrten je 1.000 Einwohner; kalibriert nur, wenn byAgsAll es liefert
  for (const e of reference?.rvd || []) {
    if (e?.ags == null || e.ags === BERLIN || !fin(e.wert) || (e.type !== 'all' && e.type !== 'scooter')) continue; // Räder (KVB-Rad) nur im Bericht, eigene Messung dort ist E-Scooter
    const all = e.type === 'all', o = (all ? own.byAgsAll?.[e.ags] : own.byAgs?.[e.ags]) || {}, scope = tx(lang, all ? 'scopeCityAll' : 'scopeCity', { ort: e.ort });
    const row = (key, label, refValue, m, c) => ({ key: `${key}:${e.ags}:${e.zeitraum}`, label, kind: 'Vergleich', refValue, ref: e, scope, measured: m ?? null, calibrated: c ?? null, suspended: false,
      ratio: m != null ? m / refValue : null, ratioCal: c != null ? c / refValue : null });
    out.push({ ...row('rvd', tx(lang, 'rvdOf', { ort: e.ort }), +e.wert, o.rvd, all ? o.rvdCal : cal(o.rvd, o.rvd, o.kind)), notOp: all ? null : notOp() });
    if (fin(e.flotteJe1000)) out.push(row('flotteJe1000', tx(lang, 'fleet1000Of', { ort: e.ort }), +e.flotteJe1000, o.per1000Fleet, null));
    if (fin(e.fahrtenJe1000)) out.push(row('fahrtenJe1000', tx(lang, 'rides1000Of', { ort: e.ort }), +e.fahrtenJe1000, o.per1000Rides, o.per1000RidesCal));
  }
  for (const e of reference?.umsatz || []) {
    if (!fin(e?.wert)) continue; const voi = /voi/i.test(e.ort || '');
    if (/je Fahrt\b/.test(e.einheit || '')) { // € je Fahrt: Umsatz und Fahrten skalieren mit demselben Faktor – Vergleich ohne Faktor
      const m = voi ? own.voi?.revPerRide ?? null : null;
      out.push({ key: `umsatzFahrt:${e.ort}:${e.zeitraum}`, label: tx(lang, 'revRideOf', { ort: e.ort }), kind: 'Vergleich', refValue: +e.wert, unit: '€', perRide: true, ref: e, scope: tx(lang, 'scopeRevRide'),
        measured: m, calibrated: null, suspended: false, ratio: m != null ? m / e.wert : null, ratioCal: null });
      continue;
    }
    const m = voi ? own.voi?.revPerVehicleDay ?? null : null; const r = own.voi?.rvd ?? null, c = cal(m, r, own.voi?.kind, voi ? 'Voi' : null);
    out.push({ key: `umsatz:${e.ort}:${e.zeitraum}`, label: tx(lang, 'revOf', { ort: e.ort }), kind: 'Vergleich', refValue: +e.wert, unit: '€', ref: e, scope: tx(lang, 'scopeRev'),
      measured: m, calibrated: c, suspended: over(r), ratio: m != null ? m / e.wert : null, ratioCal: c != null ? c / e.wert : null, notOp: notOp(voi ? 'Voi' : null) });
  }
  return out;
}

/** Alles zusammen für Panel und Bericht */
// kinds: groupKinds der Tagesdateien (Kennungsart je Gemeinde|Anbieter|Art) – Referenzart von k und Filter für factorFor/calibrateReport
export function calibration(reference, { berlinReport = null, groups = null, day = null, own = {}, lang = 'de', kinds = null } = {}) {
  const measured = measuredFromReport(berlinReport, kinds);
  const k = methodFactor(reference, measured, { day: day || measured?.to || null, lang });
  return { at: Date.now(), lang, assume: rideAssumptions(reference, lang), limits: rvdLimits(reference), k, kinds, coverage: fleetCoverage(reference, groups, { lang }), checks: plausibilityChecks(reference, own, k, lang), hasReference: !!reference };
}
export { keyToQuarter };

/**
 * Kalibrierung aus Tagesdateien (gemeinsam für Sammler → calib.json und Browser-Rückfall, Audit OPS-04): Berliner Messung = Kommunal-Bericht
 * Berlin (E-Scooter, Ampel rot nicht in k, ab 7 vollen Regelstand-Tagen nur Tage dieses Regelstands); Vergleichswerte Deutschland/Voi aus der
 * Städte-Rangliste ohne Überzählungen, Gemeinden roh; Stadtwerte (reference.rvd mit ags, alle Arten) kalibriert wie der Bericht.
 * docs: events/<Tag>.json (aufsteigend), hists: { Tag: history/<Tag>.json bzw. Tagesmittel }, latest: latest.json, breaks: daily.json → breaks.
 * Rückgabe { langs: { de, en }: calibration() + checks, kinds, own, days }.
 */
export function calibrationFromDocs({ ref = null, docs = [], hists = {}, latest = null, breaks = null, langs = ['de'] } = {}) {
  const D = docs.filter(Boolean), H = hists, limits = rvdLimits(ref), ec = latest?.eventChecks, kinds = groupKinds(D, latest?.sources || []);
  const bRep = (ds) => (ds.length ? municipalReport({ docs: ds, hists: H, ags: BERLIN, type: 'scooter', latestGroups: null, rvdLimit: limits, eventChecks: ec, breaks }) : null);
  let berlinReport = bRep(D); const bq = berlinReport?.quality;
  if (bq?.rule && bq.ruleFullDays >= CALIB.minDays) { const same = D.filter(d => docRule(d) === bq.rule); if (same.length && same.length < D.length) berlinReport = bRep(same); }
  const all = D.length ? cityRanking(D, H, latest, { type: 'scooter', minFleet: 0, rvdLimit: limits, eventChecks: ec, breaks }) : { rows: [] };
  const raw = D.length ? cityRanking(D, H, latest, { type: 'scooter', minFleet: 0, breaks }) : { rows: [] };
  const voi = D.length ? cityRanking(D, H, latest, { type: 'scooter', operator: 'Voi', minFleet: 0, rvdLimit: limits, eventChecks: ec, breaks }) : { rows: [] };
  const natRvd = (rows) => { let rd = 0, fl = 0; for (const r of rows) if (r.rvd > 0 && r.ridesDay != null) { rd += r.ridesDay; fl += r.ridesDay / r.rvd; } return fl > 0 ? { rvd: rd / fl, ridesDay: rd, fleet: fl } : null; };
  const kindsOf = (pred) => commonKind(Object.entries(kinds).filter(([key]) => { const [a, op, ty] = key.split('|'); return ty === 'scooter' && pred(a, op); }).map(([, v]) => v));
  const byAgs = Object.fromEntries(raw.rows.map(r => [r.ags, { rvd: r.rvd, fleet: r.fleet, ridesDay: r.ridesDay, kind: kindsOf((a) => a === r.ags) }]));
  const own = { national: { ...natRvd(all.rows), kind: kindsOf(() => true) }, voi: { ...natRvd(voi.rows), kind: kindsOf((a, op) => op === 'Voi') }, byAgs, byAgsAll: {} };
  const bR = berlinReport && berlinReport.groups.length ? berlinReport : null, out = {};
  for (const lang of langs) {
    const c = calibration(ref, { berlinReport: bR, groups: latest?.groups, own, lang, kinds });
    if (!Object.keys(own.byAgsAll).length) for (const e of (ref?.rvd || []).filter(x => x.ags && x.ags !== BERLIN && x.type === 'all')) {
      const rp = D.length ? municipalReport({ docs: D, hists: H, ags: e.ags, pop: latest?.municipalities?.[e.ags]?.pop || null, rvdLimit: limits, eventChecks: ec, breaks }) : null; if (!rp) continue;
      const cr = calibrateReport(rp, c.k, { limits, kinds }), ct = cr.applied ? cr.totals : null;
      own.byAgsAll[e.ags] = { rvd: rp.totals.rvd, per1000Fleet: rp.totals.per1000Fleet, per1000Rides: rp.totals.per1000Rides, rvdCal: ct?.rvd ?? null, per1000RidesCal: ct?.per1000Rides ?? null, breaks: rp.quality.breaks };
    }
    c.checks = plausibilityChecks(ref, own, c.k, lang); out[lang] = c;
  }
  return { langs: out, kinds, own, days: D.map(d => d.day), berlinReport };
}
