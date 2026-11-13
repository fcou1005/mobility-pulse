// @ts-check
// Mobility Pulse — Bericht – Energie, Datenschutz-Schwelle, Städte-Rangliste, Gebühren, Hotspots, Zonen-Beobachtung (aus pulse-report.js geschnitten; pulse-report.js bleibt die Fassade für alle Importe).
import { GAP_MS, CELL_MIN } from './pulse-track.js';
import { DEFAULTS } from './pulse-econ.js';
import { TYPE_RANGE_LOW_KM } from './pulse-core.js';
import { MIN_FULL_DAYS, NEAR_CAP, dayCoverage, histStats, hourMinOf, hourOfMs, hourQuality, keyFilter, mbRedSet, measuredProfile, overLimit, ruleEra, sum, vminCounted, zeros } from './pulse-report-base.js';
import { MIN_FLEET, RANGE_ONLY_OPS, berlinDay, capsCheck, csvText, rateStatus } from './pulse-report-caps.js';

// ---------- Energie niedrig: eine Regel für Übersicht, Leistung, Briefing, Karte und Einsatzbereitschaft ----------
// Wie die Disposition (lib/pulse-ops.js needsSwap): Ladestand < 20 % UND Reichweite < 5 km, wo beides gemeldet ist; sonst entscheidet
// die gemeldete Angabe. Anbieter, die nur Reichweite melden (rangeOnly, z. B. Lime: die Kernbibliothek leitet den Ladestand aus
// Reichweite ÷ Maximalreichweite ab), zählen nur über die Reichweite. Ohne Energieangabe: null (nicht im Nenner).
// Anders als needsSwap zählen gesperrte Fahrzeuge mit: es geht um den Zustand der Flotte, nicht um die Tauschliste.
export const ENERGY_CHARGE = 20, ENERGY_RANGE_KM = 5;
const finite = (x) => x != null && x !== '' && Number.isFinite(+x);
// rangeDerived (M-16): Reichweite aus dem Ladestand gerechnet (pulse-core rangeDerivedCheck, ops-Feld „reichweiteAbgeleitet“) → nur der Ladestand
// rangeLimit: Reichweiten-Schwelle der Quelle (pulse-core rangeLimitCheck, ops-Feld „reichweiteSchwelleKm“; null = Standard) → Reichweite < min(range, rangeLimit)
// rangeFlat: Reichweite der Quelle konstant (Platzhalter, pulse-core rangeFlatCheck, ops-Feld „reichweiteKonstant“) → Reichweite unbekannt
// type: E-Roller und Autos haben eine eigene Reichweiten-Schwelle (pulse-core TYPE_RANGE_LOW_KM: 10 bzw. 50 km statt range)
export function energyLow(battery, rangeKm, { charge = ENERGY_CHARGE, range = ENERGY_RANGE_KM, rangeOnly = false, rangeDerived = false, rangeLimit = null, rangeFlat = false, type = null } = {}) {
  if (rangeDerived && finite(battery)) return +battery < charge;
  const rg = TYPE_RANGE_LOW_KM[type] ?? range, lim = finite(rangeLimit) ? Math.min(rg, +rangeLimit) : rg;
  const b = !rangeOnly && finite(battery) ? +battery < charge : null, r = !rangeFlat && finite(rangeKm) ? +rangeKm < lim : null;
  if (b == null && r == null) return null;
  return (b ?? true) && (r ?? true);
}
/** Zähler: known = mit Energieangabe, low = Energie niedrig, rangeOnly/rangeOnlyLow = davon nur über die Reichweite beurteilt */
export const emptyEnergy = () => ({ known: 0, low: 0, rangeOnly: 0, rangeOnlyLow: 0 });
export function addEnergy(e, battery, rangeKm, opts = {}) {
  const l = energyLow(battery, rangeKm, opts); if (l == null) return e;
  e.known++; if (l) e.low++;
  if (!(opts.rangeDerived && finite(battery)) && (opts.rangeOnly || !finite(battery))) { e.rangeOnly++; if (l) e.rangeOnlyLow++; }
  return e;
}
export function sumEnergy(list) { const o = emptyEnergy(); for (const e of list || []) if (e) for (const k of Object.keys(o)) o[k] += e[k] || 0; return o; }
// Spalten von ops/<Land>.json (vehicleFields), mit Rückfall auf die bekannte Reihenfolge
function opsFields(opsDoc) {
  const F = String(opsDoc?.vehicleFields || '').split(/,(?![^(]*\))/); // Kommas in Klammern („flags(1=reserviert,2=gesperrt)“) trennen nicht
  const at = (name, d) => { const i = F.findIndex(f => f.startsWith(name)); return i >= 0 ? i : d; };
  // Feld 10–12 fehlen in älteren Dateien bzw. am Zeilenende ohne Wert → nicht abgeleitet, Standardschwelle, nicht konstant
  return { iOp: at('op', 2), iTy: at('type', 3), iFl: at('flags', 4), iBat: at('akku', 5), iRg: at('reichweite', 6), iMu: at('gemeinde', 8), iRd: at('reichweiteAbgeleitet', 9), iRl: at('reichweiteSchwelle', 10), iRf: at('reichweiteKonstant', 11) };
}
/**
 * Energie je Gruppe „Gemeinde|Anbieter|Art“ aus den Einzelfahrzeugen in ops/<Land>.json (Regel energyLow).
 * keep(ags, op, type) filtert; rangeOnly(op) markiert Anbieter, deren Ladestand nicht zählt. Rückgabe Map Schlüssel → Zähler.
 */
export function energyFromOps(opsDoc, { charge = ENERGY_CHARGE, range = ENERGY_RANGE_KM, rangeOnly = (op) => RANGE_ONLY_OPS.includes(op), keep = null } = {}) {
  const out = new Map(); if (!opsDoc?.vehicles) return out;
  const { iOp, iTy, iBat, iRg, iMu, iRd, iRl, iRf } = opsFields(opsDoc); const ops = opsDoc.ops || [], types = opsDoc.types || [], munis = opsDoc.munis || [];
  const ro = new Map();
  for (const v of opsDoc.vehicles) {
    const op = ops[v[iOp]], ty = types[v[iTy]] ?? 'unknown', ags = munis[v[iMu]];
    if (!ags || (keep && !keep(ags, op, ty))) continue;
    if (!ro.has(op)) ro.set(op, !!rangeOnly(op));
    const k = `${ags}|${op}|${ty}`; const e = out.get(k) || emptyEnergy();
    addEnergy(e, v[iBat], v[iRg], { charge, range, rangeOnly: ro.get(op), rangeDerived: v[iRd] === 1, rangeLimit: v[iRl] ?? null, rangeFlat: v[iRf] === 1, type: ty }); out.set(k, e);
  }
  return out;
}

/** Zeilen je Gemeinde aus latest.json groups, gefiltert nach Anbieter/Art; unter minTotal nur die Gemeinde keepAgs */
export function availabilityRows(latest, { operator = 'all', type = 'all', minTotal = MIN_FLEET, keepAgs = null } = {}) {
  const by = new Map();
  for (const [k, g] of Object.entries(latest?.groups || {})) {
    const [ags, op, ty] = k.split('|');
    if (!ags || ags === 'DE' || (operator !== 'all' && op !== operator) || (type !== 'all' && ty !== type)) continue;
    const r = by.get(ags) || { ags, total: 0, available: 0, disabled: 0, reserved: 0, opTotals: new Map() };
    r.total += g.total || 0; r.available += g.available || 0; r.disabled += g.disabled || 0; r.reserved += g.reserved || 0;
    r.opTotals.set(op, (r.opTotals.get(op) || 0) + (g.total || 0)); by.set(ags, r);
  }
  return [...by.values()].filter(r => r.total > 0 && (r.total >= minTotal || r.ags === keepAgs)).map(r => {
    const m = latest?.municipalities?.[r.ags] || {};
    const operators = [...r.opTotals].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([o]) => o);
    return { ags: r.ags, name: m.name || r.ags, state: m.state || null, total: r.total, available: r.available, disabled: r.disabled, reserved: r.reserved,
      avail: r.available / r.total, disabledShare: r.disabled / r.total, operators, opCount: operators.length, below: r.total < minTotal };
  });
}
/**
 * Einsatzbereitschaft je Gemeinde aus ops/<Land>.json (je Fahrzeug Flags, Ladestand, Reichweite).
 * Energie ausreichend = nicht „Energie niedrig“ (energyLow): Ladestand ≥ charge oder Reichweite ≥ range km, wo beides gemeldet;
 * sonst die gemeldete Angabe; Anbieter nur mit Reichweite (rangeOnly) über die Reichweite. Ohne Angabe zählt das Fahrzeug nicht (known).
 * Rückgabe Map ags → { total, known, ready, okEnergy }.
 */
export function readinessFromOps(opsDoc, { operator = 'all', type = 'all', charge = ENERGY_CHARGE, range = ENERGY_RANGE_KM, rangeOnly = (op) => RANGE_ONLY_OPS.includes(op) } = {}) {
  const out = new Map(); if (!opsDoc?.vehicles) return out;
  const { iOp, iTy, iFl, iBat, iRg, iMu, iRd, iRl, iRf } = opsFields(opsDoc);
  const ops = opsDoc.ops || [], types = opsDoc.types || [], munis = opsDoc.munis || [];
  const ro = new Map();
  for (const v of opsDoc.vehicles) {
    const op = ops[v[iOp]], ty = types[v[iTy]] ?? 'unknown', ags = munis[v[iMu]];
    if (!ags || (operator !== 'all' && op !== operator) || (type !== 'all' && ty !== type)) continue;
    if (!ro.has(op)) ro.set(op, !!rangeOnly(op));
    const o = out.get(ags) || { total: 0, known: 0, ready: 0, okEnergy: 0 }; o.total++;
    const bookable = !((v[iFl] || 0) & 3); // 1 = reserviert, 2 = gesperrt
    const low = energyLow(v[iBat], v[iRg], { charge, range, rangeOnly: ro.get(op), rangeDerived: v[iRd] === 1, rangeLimit: v[iRl] ?? null, rangeFlat: v[iRf] === 1, type: ty });
    if (low != null) { o.known++; if (!low) { o.okEnergy++; if (bookable) o.ready++; } }
    out.set(ags, o);
  }
  return out;
}
/** Tagesmittel und -minimum der Verfügbarkeit je Gemeinde aus den Sammler-Punkten (history/<Tag>.json) */
export function histAvailability(hist, { operator = 'all', type = 'all' } = {}) {
  const t = hist?.t || []; const byAgs = new Map();
  for (const [k, ser] of Object.entries(hist?.series || {})) {
    const [ags, op, ty] = k.split('|');
    if (!ags || ags === 'DE' || (operator !== 'all' && op !== operator) || (type !== 'all' && ty !== type)) continue;
    const a = byAgs.get(ags) || { tot: zeros(t.length), av: zeros(t.length), seen: new Array(t.length).fill(false) };
    for (let i = 0; i < t.length; i++) { const tt = ser.total?.[i], aa = ser.available?.[i]; if (tt == null || aa == null) continue; a.tot[i] += tt; a.av[i] += aa; a.seen[i] = true; }
    byAgs.set(ags, a);
  }
  const out = new Map();
  for (const [ags, a] of byAgs) {
    let s = 0, n = 0, min = null, minAt = null;
    for (let i = 0; i < t.length; i++) { if (!a.seen[i] || !(a.tot[i] > 0)) continue; const v = a.av[i] / a.tot[i]; s += v; n++; if (min == null || v < min) { min = v; minAt = t[i]; } }
    if (n) out.set(ags, { mean: s / n, min, minAt, n });
  }
  return { byAgs: out, n: t.length, from: t[0] ?? null, to: t[t.length - 1] ?? null, day: hist?.day || null };
}
/** Verlauf der Verfügbarkeit je Anbieter in einer Gemeinde: t[], series [{ op, values: [Anteil | null], total: Ø gemeldet }] */
export function availabilitySeries(hist, ags, { operator = 'all', type = 'all' } = {}) {
  const t = hist?.t || []; const by = new Map();
  for (const [k, ser] of Object.entries(hist?.series || {})) {
    const [a, op, ty] = k.split('|');
    if (a !== ags || (operator !== 'all' && op !== operator) || (type !== 'all' && ty !== type)) continue;
    const s = by.get(op) || { tot: zeros(t.length), av: zeros(t.length), seen: new Array(t.length).fill(false) };
    for (let i = 0; i < t.length; i++) { const tt = ser.total?.[i], aa = ser.available?.[i]; if (tt == null || aa == null) continue; s.tot[i] += tt; s.av[i] += aa; s.seen[i] = true; }
    by.set(op, s);
  }
  const series = [...by].map(([op, s]) => {
    const values = t.map((_, i) => (s.seen[i] && s.tot[i] > 0 ? s.av[i] / s.tot[i] : null));
    const seen = s.tot.filter((x, i) => s.seen[i] && x > 0);
    return { op, values, total: seen.length ? sum(seen) / seen.length : 0 };
  }).filter(s => s.values.some(v => v != null)).sort((a, b) => b.total - a.total);
  return { t, series };
}
/** Abschnitte einer Linie: Unterbrechung bei fehlendem Wert oder Abstand über gapMs */
export function lineSegments(t, values, gapMs = GAP_MS) {
  const segs = []; let cur = [];
  for (let i = 0; i < t.length; i++) {
    const v = values[i];
    if (v == null) { if (cur.length) segs.push(cur); cur = []; continue; }
    if (cur.length && t[i] - t[cur[cur.length - 1]] > gapMs) { segs.push(cur); cur = []; }
    cur.push(i);
  }
  if (cur.length) segs.push(cur);
  return segs;
}
/** Sortieren mit leeren Werten immer am Ende */
export function sortRows(rows, key, dir = 'asc') {
  const f = dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = a[key], y = b[key];
    if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;
    if (typeof x === 'string' || typeof y === 'string') return f * String(x).localeCompare(String(y), 'de');
    return f * (x - y) || String(a.name).localeCompare(String(b.name), 'de');
  });
}
export function availabilityCsvRows(rows, { operator = 'all', type = 'all', at = null, typeLabel = (t) => t, day = null, lang = 'de' } = {}) {
  const X = (v) => csvText(v, lang);
  const head = ['AGS', 'Stadt', 'Land', 'Anbieter_Filter', 'Fahrzeugart_Filter', 'Gemeldet', 'Buchbar', 'Verfuegbarkeit', 'Einsatzbereit', 'Energieangabe_Fahrzeuge', 'Gesperrt_Anteil', 'Reserviert', 'Anbieter_Anzahl', 'Anbieter', 'Tagesmittel_Verfuegbarkeit', 'Tagesminimum_Verfuegbarkeit', 'Sammler_Punkte', 'Tag', 'Stand'];
  const stand = at ? new Date(at).toISOString() : '';
  return [head.map(X), ...rows.map(r => [r.ags, r.name, r.state || '', operator === 'all' ? X('alle') : operator, type === 'all' ? X('alle') : typeLabel(type), r.total, r.available, [r.avail, 4], [r.ready, 4], r.readyKnown ?? '', [r.disabledShare, 4], r.reserved, r.opCount, r.operators.join(', '), [r.dayMean, 4], [r.dayMin, 4], r.dayN ?? '', day || '', stand])];
}

// ---------- Datenschutz-Schwelle ----------
// Datenschutz-Schwelle eine Stelle: wie die veröffentlichten Zellen (lib/pulse-track.js CELL_MIN = 3); Orte/Zellen mit weniger Fahrten
// erscheinen als „< 3“ (vorher eigene Schwelle 2 „wie Portland“ – widersprach der Regel „unter 3 unterdrückt“)
export const MIN_COUNT = CELL_MIN;
export const suppressed = (v, min = MIN_COUNT) => v != null && Number.isFinite(+v) && +v < min;
/** Orte als CSV-Zeilen: Zählungen unter der Schwelle als „<2“ */
export function cellsCsvRows(cs, { ags = '', name = '', from = '', to = '', minCount = MIN_COUNT, lang = 'de' } = {}) {
  const m = (v) => (suppressed(v, minCount) ? `<${minCount}` : v);
  return [['Gemeinde', 'AGS', 'Zeitraum_von', 'Zeitraum_bis', 'Zelle', 'Breite', 'Laenge', 'Fahrtbeginne', 'Fahrtenden', 'Verfuegbar_je_Lauf', 'Umsetzungen'].map(h => csvText(h, lang)),
    ...[...cs.grid].sort((a, b) => b.start + b.end - (a.start + a.end)).map(c => [name, ags, from, to, c.cell, [c.lat, 5], [c.lon, 5], m(c.start), m(c.end), [c.presAvg, 1], m(c.reloc)])];
}

// ---------- Städte-Rangliste (je Stadt × Fahrzeugart) ----------
// je Schlüssel Gemeinde|Anbieter|Art: gemessene Fahrten (ohne Lücken-Stunden), Tagesflotte, beobachteter Anteil des Tagesgangs
// breaks (history/daily.json → breaks) wie municipalReport: Tage vor dem Bruch zählen für die Reihe nicht, am Bruchtag nur Stunden mit dem
// letzten Regelstand des Tages (bis 02.11.2026 fehlte das hier: Köln nextbike in der Rangliste Ø 5.806 statt ≈ 2.400 Räder)
function accumulate(list, hists, keep, profile, breaks = null) {
  const G = new Map();
  for (const doc of list) {
    const hq = hourQuality(doc.runs, doc.gapHours), cov = dayCoverage(hq, profile, hourMinOf(doc)), vOk = vminCounted(doc.runs), hist = hists?.[doc.day] || null;
    const obsRaw = hq.obsEnd.reduce((a, m, h) => a + (hq.ok[h] ? m : 0), 0); // Nenner der Flotte: Fahrzeugminuten zählen in der Endstunde
    const runsA = (doc.runs || []).filter(Array.isArray), lastEra = breaks && new Set(runsA.map(ruleEra)).size > 1 ? ruleEra(runsA[runsA.length - 1]) : null;
    const late = lastEra ? Array.from({ length: 24 }, (_, h) => runsA.every(r => hourOfMs(r[0]) !== h || ruleEra(r) === lastEra)) : null;
    const keys = new Set([...Object.keys(doc.groups || {}), ...Object.keys(hist?.series || {})].filter(keep));
    for (const k of keys) {
      const bd = breaks?.[k] ?? null; if (bd && doc.day < bd) continue;
      const cut = bd === doc.day && late ? late : null, okH = (h) => hq.ok[h] && (!cut || cut[h]);
      const obsG = cut ? hq.obsEnd.reduce((s, m, h) => s + (okH(h) ? m : 0), 0) : obsRaw;
      const covG = cut ? dayCoverage({ ...hq, obsOk: hq.obsOk.map((m, h) => (cut[h] ? m : 0)) }, profile, hourMinOf(doc)) : cov;
      const g = doc.groups?.[k]; let rides = 0, vt = 0;
      if (g) for (let h = 0; h < 24; h++) if (okH(h)) { rides += g.start?.[h] || 0; vt += g.vminTot?.[h] || 0; }
      let fleet = null;
      if (vOk && obsG > 0 && vt > 0) fleet = vt / obsG; else if (!cut) { const hs = histStats(hist, k); if (hs && !hs.incomplete) fleet = hs.fleet; } // Tagesmittel mischt am Bruchtag beide Stände
      const a = G.get(k) || { fleetDays: [], rides: 0, cov: 0 };
      if (fleet != null) a.fleetDays.push(fleet);
      a.rides += rides; if ((fleet || 0) > 0 || rides > 0) a.cov += covG; G.set(k, a);
    }
  }
  return G;
}
/**
 * Rangliste je Gemeinde × Fahrzeugart über die Tagesdateien: Ø Flotte, Fahrten/Tag (hochgerechnet), Fahrten je Fahrzeug und Tag,
 * je 1.000 Einwohner. Anbieter mit unplausibler Quote (> 15) zählen nur bei der Flotte, nicht bei den Fahrten.
 */
// eventChecks (latest.json → eventChecks): Gruppen mit Ampel rot zählen wie unplausible nur bei der Flotte (excluded); breaks: Bruchmarken (accumulate)
export function cityRanking(docs, hists, latest, { type = 'all', operator = 'all', minFleet = MIN_FLEET, rvdLimit = null, eventChecks = null, breaks = null } = {}) {
  const ampelRed = mbRedSet(eventChecks);
  const list = (docs || []).filter(d => d?.day).sort((a, b) => a.day.localeCompare(b.day));
  const prof = measuredProfile(list);
  const G = accumulate(list, hists, keyFilter({ ags: 'DE', operator, type }), prof.profile, breaks);
  const by = new Map();
  for (const [k, a] of G) {
    const [ags, op, ty] = k.split('|');
    const fleet = a.fleetDays.length ? sum(a.fleetDays) / a.fleetDays.length : 0;
    const ridesDay = a.cov > 0 ? a.rides / a.cov : null;
    const ok = !(ridesDay != null && fleet > 0 && (ridesDay / fleet > DEFAULTS.maxRvd || overLimit(ridesDay / fleet, ty, rvdLimit))) && !ampelRed.has(k);
    const r = by.get(`${ags}|${ty}`) || { ags, ty, fleet: 0, fleetGood: 0, ridesDay: 0, rides: 0, hasRides: false, ops: new Set(), excluded: [] };
    r.fleet += fleet; r.ops.add(op);
    if (ok) { r.fleetGood += fleet; if (ridesDay != null) { r.ridesDay += ridesDay; r.rides += a.rides; r.hasRides = true; } } else r.excluded.push(op);
    by.set(`${ags}|${ty}`, r);
  }
  const rows = [...by.values()].filter(r => r.fleet >= minFleet).map(r => {
    const m = latest?.municipalities?.[r.ags] || {}; const pop = m.pop || null;
    const ridesDay = r.hasRides ? r.ridesDay : null;
    return { key: `${r.ags}|${r.ty}`, ags: r.ags, name: m.name || r.ags, state: m.state || null, ty: r.ty, fleet: r.fleet, fleetGood: r.fleetGood, rides: r.rides, ridesDay,
      rvd: ridesDay != null && r.fleetGood > 0 ? ridesDay / r.fleetGood : null, per1000Fleet: pop ? (r.fleet / pop) * 1000 : null, per1000Rides: pop && ridesDay != null ? (ridesDay / pop) * 1000 : null,
      opCount: r.ops.size, excluded: r.excluded, pop, areaKm2: Number.isFinite(+m.areaKm2) && +m.areaKm2 > 0 ? +m.areaKm2 : null };
  });
  const fullDays = list.filter(d => hourQuality(d.runs, d.gapHours).full).length;
  return { rows, days: list.map(d => d.day), fullDays, prelim: fullDays < MIN_FULL_DAYS, profileSource: prof.source };
}
/**
 * Vorperiode: die letzten 2·N Tage (N ≤ 7) in zwei gleich lange Hälften; Vergleich nur, wenn jede Hälfte ≥ MIN_FULL_DAYS volle Messtage hat.
 * Rückgabe { cur, prev, n } oder { reason } (Vergleich ausgeblendet).
 */
export function rankingPeriods(docs, { maxDays = 7 } = {}) {
  const list = (docs || []).filter(d => d?.day).sort((a, b) => a.day.localeCompare(b.day));
  const n = Math.min(maxDays, Math.floor(list.length / 2));
  const need = `Vergleich zur Vorperiode ab 2 × ${MIN_FULL_DAYS} vollen Messtagen; bisher ${list.filter(d => hourQuality(d.runs, d.gapHours).full).length} volle von ${list.length} Tagen`;
  if (n < MIN_FULL_DAYS) return { reason: need };
  const cur = list.slice(-n), prev = list.slice(-2 * n, -n);
  const full = (l) => l.filter(d => hourQuality(d.runs, d.gapHours).full).length;
  if (full(cur) < MIN_FULL_DAYS || full(prev) < MIN_FULL_DAYS) return { reason: need };
  return { cur, prev, n };
}
/** Punkte für Dichte gegen Nutzung: Fahrzeuge je km² (Ø Flotte ÷ Fläche) gegen Fahrten je Fahrzeug und Tag */
export const densityPoints = (rows) => rows.filter(r => r.areaKm2 && r.rvd != null && r.fleet > 0).map(r => ({ ...r, density: r.fleet / r.areaKm2 }));

// ---------- Gebühren und Regulierung ----------
/** Satz aus reference.gebuehren: Zahl oder [min, max]; Einheit „€ je Fahrzeug und Jahr/Monat“ → Jahresbetrag je Fahrzeug */
export function feeRate(entry) {
  const s = entry?.satz; const arr = Array.isArray(s) ? s.map(Number) : s != null ? [Number(s), Number(s)] : null;
  if (!arr || !arr.every(Number.isFinite)) return null;
  const monthly = /monat/i.test(String(entry.einheit || '')); const f = monthly ? 12 : 1;
  return { min: Math.min(...arr) * f, max: Math.max(...arr) * f, monthly, range: arr[0] !== arr[arr.length - 1] };
}
const typesOf = (e) => [].concat(e?.type || []).map(String);
/** Gebühren je Eintrag: gezählte Fahrzeuge der Art(en) × Satz, als Jahres- und Monatsbetrag (Spanne bei Satz-Spanne) */
export function feeEstimates(reference, groups, { ags = 'DE' } = {}) {
  return (reference?.gebuehren || []).filter(e => e?.ags && (ags === 'DE' || e.ags === ags)).map(e => {
    const types = typesOf(e); let count = 0; const ops = new Set();
    for (const [k, g] of Object.entries(groups || {})) { const [a, op, ty] = k.split('|'); if (a === e.ags && (!types.length || types.includes(ty)) && g.total) { count += g.total; ops.add(op); } }
    const r = feeRate(e);
    return { ...e, types, count, operators: [...ops], rate: r, yearMin: r ? r.min * count : null, yearMax: r ? r.max * count : null, monthMin: r ? (r.min * count) / 12 : null, monthMax: r ? (r.max * count) / 12 : null };
  });
}
/** Eigener Satz: Betrag je Fahrzeug und Monat oder Jahr × Anzahl */
export function ownFee(rate, unit, count) {
  if (!(rate >= 0) || !(count >= 0)) return null;
  const year = unit === 'monat' ? rate * 12 * count : rate * count;
  return { year, month: year / 12 };
}
/** Steckbrief Regulierung: Obergrenzen, Gebühren, Referenzwerte und Anbieter je Art laut Daten für eine Gemeinde (bei 'DE' alle mit Eintrag) */
export function regulationProfiles(reference, latest, { ags = 'DE', asOf = Date.now() } = {}) {
  const lists = ['obergrenzen', 'gebuehren', 'rvd', 'flotte', 'fahrt', 'fahrten'];
  const set = new Set();
  for (const l of lists) for (const e of reference?.[l] || []) if (e?.ags) set.add(e.ags);
  if (ags !== 'DE') { set.clear(); set.add(ags); }
  return [...set].map(a => {
    const m = latest?.municipalities?.[a] || {};
    const opsByType = {}; for (const [k, g] of Object.entries(latest?.groups || {})) { const [x, op, ty] = k.split('|'); if (x !== a || !g.total) continue; (opsByType[ty] ??= new Set()).add(op); }
    const caps = capsCheck(reference, latest?.groups, { ags: a, asOf });
    return { ags: a, name: m.name || (reference?.obergrenzen || []).concat(reference?.gebuehren || []).find(e => e.ags === a)?.ort || a, state: m.state || null, pop: m.pop || null,
      operators: Object.fromEntries(Object.entries(opsByType).map(([ty, s]) => [ty, [...s].sort((x, y) => x.localeCompare(y, 'de'))])),
      caps, fees: (reference?.gebuehren || []).filter(e => e.ags === a), refs: ['rvd', 'flotte', 'fahrt', 'fahrten'].flatMap(l => (reference?.[l] || []).filter(e => e.ags === a).map(e => ({ ...e, kind: l }))) };
  }).sort((x, y) => String(x.name).localeCompare(String(y.name), 'de'));
}

// ---------- Hotspot-Stabilität ----------
/**
 * Überlappung der Top-N-Startzellen zwischen beobachteten Tagen (Tag-zu-Tag-Stabilität, keine Validierung gegen Betreiberdaten).
 * cellsByDay: { Tag → { zelle → [start, …] } }; Zellen unter minCount Fahrtbeginnen zählen nicht.
 * Anteil = gemeinsame Zellen ÷ kleinere der beiden Top-Mengen; Jaccard = gemeinsam ÷ Vereinigung.
 */
export function hotspotStability(cellsByDay = {}, { top = 200, minCount = MIN_COUNT } = {}) {
  const days = Object.keys(cellsByDay).filter(d => cellsByDay[d]).sort();
  const sets = days.map(d => { const list = Object.entries(cellsByDay[d]).filter(([, v]) => (v?.[0] || 0) >= minCount).sort((a, b) => b[1][0] - a[1][0] || a[0].localeCompare(b[0])).slice(0, top); return { day: d, cells: new Set(list.map(([c]) => c)), n: list.length }; });
  const pairs = [];
  for (let i = 1; i < sets.length; i++) {
    const A = sets[i - 1], B = sets[i]; let common = 0; for (const c of A.cells) if (B.cells.has(c)) common++;
    const minN = Math.min(A.n, B.n), uni = A.n + B.n - common;
    pairs.push({ a: A.day, b: B.day, nA: A.n, nB: B.n, common, share: minN ? common / minN : null, jaccard: uni ? common / uni : null });
  }
  const valid = pairs.filter(p => p.share != null);
  return { days: sets.map(s => ({ day: s.day, n: s.n })), pairs, meanShare: valid.length ? sum(valid.map(p => p.share)) / valid.length : null, top, minCount };
}

// ---------- Zonen-Beobachtung (zone-watch.json) ----------
// Umrisse aus data/zonen-vermutet.json (vermutete Abgrenzungen, aus der Beschreibung der Stadt abgeleitet, nicht amtlich) und optional
// privat aus ZONE_WATCH. Veröffentlicht werden Name, Gemeinde, Beschreibung/Genauigkeit und der Bestand je Zone, Anbieter und Fahrzeugart;
// Zahlen/Limits in den Eigenschaften der Datei werden verworfen (Grenzwerte nur aus reference.json). Je Lauf (2 Tage), je Tag Min/Max/Mittel (30 Tage).
export const ZONE_LOG_DAYS = 30, ZONE_RUN_DAYS = 2;
export const ZONE_RUN_FIELDS = ['at', 'zone', 'operator', 'type', 'total', 'available'];
export const ZONE_DAILY_FIELDS = ['day', 'zone', 'operator', 'type', 'min', 'max', 'mean', 'runs'];
const slug = (s) => String(s || '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'zone';
const ringBbox = (rings, b) => { for (const r of rings) for (const [x, y] of r) { if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y; } return b; };
const inRing = (ring, x, y) => { let inside = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside; } return inside; };
const inPoly = (rings, x, y) => inRing(rings[0], x, y) && !rings.slice(1).some(h => inRing(h, x, y));
/** Liegt (lon, lat) in der Zone (Polygon/MultiPolygon, Löcher ausgenommen)? Rest-Zonen (ohne Umriss) nie – die zählt zoneCounts */
export function zoneContains(z, lon, lat) {
  const b = z.bbox; if (!b || lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) return false;
  return z.polys.some(rings => inPoly(rings, lon, lat));
}
/**
 * ZONE_WATCH lesen: GeoJSON Feature, FeatureCollection oder Feature-Liste, auch base64. Liefert [{ id, name, ags, polys, bbox }];
 * aus den Eigenschaften bleiben nur name (bzw. id) und ags. Ungültiges wird übersprungen. Rest-Zone: properties.rest = true mit ags,
 * Geometrie leer (null) – „übriges Stadtgebiet“ = Fahrzeuge der Gemeinde außerhalb aller Umrisse dieser Gemeinde (rest: true, polys [], bbox null).
 * properties.umfassend = true: Umriss bewusst größer als das beschriebene Gebiet (superset: true) – Bestand ist eine Obergrenze.
 */
export function parseZoneWatch(text) {
  if (!text || !String(text).trim()) return [];
  let raw = String(text).trim();
  if (!raw.startsWith('{') && !raw.startsWith('[')) { try { raw = (typeof atob === 'function' ? atob(raw) : globalThis.Buffer.from(raw, 'base64').toString('utf8')).trim(); } catch { return []; } }
  let doc; try { doc = JSON.parse(raw); } catch { return []; }
  const feats = Array.isArray(doc) ? doc : doc?.type === 'FeatureCollection' ? doc.features || [] : [doc];
  const out = [], ids = new Set();
  for (const f of feats) {
    const g = f?.geometry, p = f?.properties || {};
    const polys = g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : null;
    const rest = p.rest === true && /^\d{8}$/.test(String(p.ags || ''));
    if (!rest && (!polys?.length || !polys.every(rs => Array.isArray(rs) && rs.length && rs.every(r => Array.isArray(r) && r.length >= 4 && r.every(pt => Number.isFinite(pt?.[0]) && Number.isFinite(pt?.[1])))))) continue;
    const name = String(p.name || p.id || `Zone ${out.length + 1}`).slice(0, 80);
    let id = slug(name); while (ids.has(id)) id += '-2'; ids.add(id);
    out.push({ id, name, ags: /^\d{8}$/.test(String(p.ags || '')) ? String(p.ags) : null, ...(rest ? { rest: true } : {}), ...(p.umfassend === true ? { superset: true } : {}), assumed: p.vermutet === true, description: typeof p.beschreibung === 'string' ? p.beschreibung.slice(0, 400) : null,
      accuracyM: Number.isFinite(p.genauigkeit_m) ? p.genauigkeit_m : null, polys: rest ? [] : polys, bbox: rest ? null : polys.reduce((b, rs) => ringBbox(rs, b), [Infinity, Infinity, -Infinity, -Infinity]) });
  }
  return out;
}
/**
 * Bestand je Zone, Anbieter, Art: Map 'zone|operator|type' → [gesamt, verfügbar] (Fahrzeuge mit Position, nach Dubletten-Bereinigung).
 * Rest-Zone: Fahrzeuge mit v.ags der Gemeinde (Zuordnung des Sammlers), die in keinem Umriss derselben Gemeinde liegen.
 */
export function zoneCounts(zones, vehicles) {
  const out = new Map(), shapes = zones.filter(z => !z.rest), rests = zones.filter(z => z.rest);
  for (const v of vehicles || []) {
    if (!Number.isFinite(v?.lat) || !Number.isFinite(v?.lon)) continue;
    const hit = shapes.filter(z => zoneContains(z, v.lon, v.lat));
    for (const z of rests) if (v.ags === z.ags && !hit.some(h => h.ags === z.ags)) hit.push(z);
    for (const z of hit) {
      const k = `${z.id}|${v.operator}|${v.type || 'unknown'}`; const c = out.get(k) || [0, 0];
      c[0]++; if (!v.reserved && !v.disabled) c[1]++; out.set(k, c);
    }
  }
  return out;
}
/** zone-watch.json fortschreiben: Läufe der letzten ZONE_RUN_DAYS Tage, Tageswerte (Min/Max/Mittel des Bestands) ZONE_LOG_DAYS Tage */
export function zoneLogUpdate(prev, zones, counts, { at = Date.now(), days = ZONE_LOG_DAYS, runDays = ZONE_RUN_DAYS, flag = 1, carryZero = (..._a) => true } = {}) {
  const day = berlinDay(at);
  const keepRun = at - runDays * 864e5, keepDay = berlinDay(at - (days - 1) * 864e5);
  const runs = (Array.isArray(prev?.runs) ? prev.runs : []).filter(r => Array.isArray(r) && r[0] >= keepRun && r[0] < at);
  const daily = new Map((Array.isArray(prev?.daily) ? prev.daily : []).filter(r => Array.isArray(r) && r[0] >= keepDay).map(r => [`${r[0]}|${r[1]}|${r[2]}|${r[3]}`, r.slice()]));
  const known = new Set(zones.map(z => z.id));
  // Schlüssel, die heute schon Bestand hatten und in diesem Lauf keinen: mit 0 fortschreiben (Minimum stimmt) – nur wenn carryZero
  // bestätigt, dass der Anbieter in diesem Lauf überhaupt Daten lieferte (Feed-Ausfall ist kein Nullbestand)
  const keys = new Map(counts);
  for (const r of daily.values()) if (r[0] === day && known.has(r[1]) && !keys.has(`${r[1]}|${r[2]}|${r[3]}`) && carryZero(r[1], r[2], r[3])) keys.set(`${r[1]}|${r[2]}|${r[3]}`, [0, 0]);
  if (flag !== 0) {
    for (const [k, [total, avail]] of keys) {
      const [zone, op, ty] = k.split('|');
      runs.push([at, zone, op, ty, total, avail]);
      const dk = `${day}|${zone}|${op}|${ty}`, d = daily.get(dk);
      if (!d) daily.set(dk, [day, zone, op, ty, total, total, total, 1]);
      else { d[4] = Math.min(d[4], total); d[5] = Math.max(d[5], total); d[6] = +((d[6] * d[7] + total) / (d[7] + 1)).toFixed(1); d[7]++; }
    }
  }
  const zonesOut = zones.map(z => ({ id: z.id, name: z.name, ags: z.ags, ...(z.rest ? { rest: true } : {}), ...(z.superset ? { superset: true } : {}), ...(z.assumed ? { assumed: true } : {}), ...(z.description ? { description: z.description } : {}), ...(z.accuracyM ? { accuracyM: z.accuracyM } : {}) }));
  for (const z of prev?.zones || []) if (!known.has(z.id) && [...daily.values()].some(r => r[1] === z.id)) zonesOut.push({ ...z, retired: true });
  return { updatedAt: at, days, runDays, zones: zonesOut, runFields: ZONE_RUN_FIELDS, runs, dailyFields: ZONE_DAILY_FIELDS,
    daily: [...daily.values()].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[2].localeCompare(b[2]) || a[3].localeCompare(b[3])),
    note: 'Umrisse vermutet (data/zonen-vermutet.json, nicht amtlich); Bestand = Fahrzeuge mit Position in der Zone nach Dubletten-Bereinigung' };
}
/**
 * Übersicht je Zone und Anbieter (für die Anzeige): jetzt, heute Min–Max, Ø der Tagesmittel (7 Tage), Maximum (30 Tage), Tagesmaxima als Verlauf.
 * filter: { operator, type } wie oben im Dashboard ('all' = alle); Summenzeile '*' über die Anbieter.
 */
export function zoneSummary(log, { operator = 'all', type = 'all', asOf = null } = {}) {
  if (!log?.zones?.length) return [];
  const at = asOf ?? log.updatedAt; const today = berlinDay(at), since7 = berlinDay(at - 6 * 864e5);
  const ok = (op, ty) => (operator === 'all' || op === operator) && (type === 'all' || ty === type);
  return log.zones.map(z => {
    const byOp = new Map();
    // letzter Lauf je Zone (live nachgezählte Zonen können einen anderen Zeitpunkt haben als das Protokoll)
    const lastAt = (log.runs || []).reduce((m, r) => (r[1] === z.id && r[0] > m ? r[0] : m), 0);
    const row = (op) => { let r = byOp.get(op); if (!r) byOp.set(op, r = { op, now: 0, avail: 0, todayMin: null, todayMax: null, days: new Map() }); return r; };
    for (const r of log.runs || []) if (r[1] === z.id && r[0] === lastAt && ok(r[2], r[3])) { for (const x of [row(r[2]), row('*')]) { x.now += r[4]; x.avail += r[5]; } }
    // Tageswerte je Anbieter über die Arten summiert (Min/Max je Art, daher Summe = obere bzw. untere Schranke; Mittel exakt)
    for (const d of log.daily || []) {
      if (d[1] !== z.id || !ok(d[2], d[3])) continue;
      for (const x of [row(d[2]), row('*')]) { const e = x.days.get(d[0]) || { min: 0, max: 0, mean: 0 }; e.min += d[4]; e.max += d[5]; e.mean += d[6]; x.days.set(d[0], e); }
    }
    // Summenzeile: Tagesmaximum aller Anbieter aus den Läufen, wo vorhanden (gleichzeitiger Bestand statt Summe der Einzelmaxima)
    const star = byOp.get('*');
    if (star) {
      const perRun = new Map(); for (const r of log.runs || []) if (r[1] === z.id && ok(r[2], r[3])) perRun.set(r[0], (perRun.get(r[0]) || 0) + r[4]);
      const perDay = new Map(); for (const [t, n] of perRun) { const d = berlinDay(t); const e = perDay.get(d) || { min: Infinity, max: 0 }; e.min = Math.min(e.min, n); e.max = Math.max(e.max, n); perDay.set(d, e); }
      for (const [d, e] of perDay) { const x = star.days.get(d); if (x) { x.max = e.max; x.min = e.min; } }
    }
    const rows = [...byOp.values()].map(x => {
      const days = [...x.days].sort((a, b) => a[0].localeCompare(b[0]));
      const t = x.days.get(today), last7 = days.filter(([d]) => d >= since7);
      return { op: x.op, now: lastAt ? x.now : null, avail: lastAt ? x.avail : null, todayMin: t?.min ?? null, todayMax: t?.max ?? null,
        mean7: last7.length ? +(last7.reduce((s, [, e]) => s + e.mean, 0) / last7.length).toFixed(1) : null, max30: days.length ? Math.max(...days.map(([, e]) => e.max)) : null,
        series: days.map(([d, e]) => [d, e.max]) };
    }).filter(r => r.now || r.max30).sort((a, b) => Number(a.op === '*') - Number(b.op === '*') || (b.now || 0) - (a.now || 0) || a.op.localeCompare(b.op, 'de'));
    return { ...z, at: lastAt || null, rows };
  });
}
/**
 * Teilgebiet einer Obergrenze gegen die Zonen-Beobachtung prüfen (reference.json → zonen[].beobachtung = Zonen-ID in zone-watch.json).
 * Bestand je Anbieter (Arten der Obergrenze) im letzten Lauf gegen jeAnbieter bzw. gesamt; dazu aus den Tageswerten das Maximum heute
 * und in 30 Tagen sowie die Zahl der Tage, an denen das Tagesmaximum über der Grenze lag (Summe der Tagesmaxima je Art = obere Schranke).
 * Ohne passende Zone oder ohne Lauf: null (bleibt „nicht prüfbar“).
 * Anteils-Regeln (zonen[].anteilMax / anteilMin, z. B. Dresden „max. 30 % der Flotte“): fleet = Map Anbieter → Bestand in der Gemeinde
 * (Arten der Obergrenze); fleetShare = Bestand im Teilgebiet ÷ Bestand in der Gemeinde, über anteilMax „over“ (ab 90 % davon „near“),
 * unter anteilMin „below“. Nicht amtliche Einträge (official false): nur zählen, Status „info“. Umfassender Umriss (zone.superset): Bestand ist
 * eine Obergrenze – „über/nahe“ wird zu „hint“ (kein Verstoß), ebenso beim Höchstanteil; „unter Mindestanteil“ bleibt (dann sicher).
 */
export function zoneCapCheck(d, log, { types = ['scooter'], licensed = (..._a) => null, fleet = null, official = true } = {}) {
  const zone = d?.watch && (log?.zones || []).find(z => z.id === d.watch && !z.retired);
  if (!zone) return null;
  const runs = (log.runs || []).filter(r => r[1] === zone.id && types.includes(r[3]));
  const at = runs.length ? Math.max(...runs.map(r => r[0])) : null;
  if (!at) return null;
  const today = berlinDay(at);
  const byOp = new Map(); const O = (op) => { let o = byOp.get(op); if (!o) byOp.set(op, o = { op, now: 0, available: 0, days: new Map() }); return o; };
  for (const r of runs) if (r[0] === at) { const o = O(r[2]); o.now += r[4]; o.available += r[5]; }
  for (const x of log.daily || []) if (x[1] === zone.id && types.includes(x[3])) { const o = O(x[2]); o.days.set(x[0], (o.days.get(x[0]) || 0) + x[5]); }
  const per = official ? d.perOperator : null, sMax = official ? d.shareMax ?? null : null, sMin = official ? d.shareMin ?? null : null;
  const rank = { below: 3, over: 3, near: 2, hint: 1, ok: 0 };
  const worstOf = (list) => list.filter(x => x in rank).sort((a, b) => rank[b] - rank[a])[0];
  if (sMin != null && fleet) for (const [op, f] of fleet) if (f > 0) O(op); // Mindestanteil: auch Anbieter ganz ohne Fahrzeug im Teilgebiet
  const sup = !!zone.superset, soft = (s) => (sup && (s === 'over' || s === 'near') ? 'hint' : s);
  const ops = [...byOp.values()].map(o => {
    const lic = licensed(o.op), limit = lic === false ? null : per;
    const st = lic === false ? { status: 'unlicensed', share: null } : !official ? { status: 'info', share: null } : rateStatus(o.now, limit, d.perOperatorDerived || sup);
    const f = fleet?.get?.(o.op) ?? null, fleetShare = f > 0 ? o.now / f : null;
    const shareStatus = lic === false || fleetShare == null || (sMax == null && sMin == null) ? null
      : soft(sMax != null && fleetShare > sMax ? 'over' : sMin != null && fleetShare < sMin ? 'below' : sMax != null && fleetShare >= NEAR_CAP * sMax ? 'near' : 'ok');
    const days = [...o.days.values()];
    return { op: o.op, now: o.now, available: o.available, limit, ...st, ...(shareStatus ? { status: worstOf([st.status, shareStatus]), countStatus: st.status } : {}), fleet: f, fleetShare, shareStatus,
      todayMax: o.days.get(today) ?? null, max30: days.length ? Math.max(...days) : null, daysOver: limit > 0 ? days.filter(v => v > limit).length : null, daysLogged: days.length };
  }).filter(o => o.now || o.max30 || o.shareStatus === 'below').sort((a, b) => b.now - a.now || a.op.localeCompare(b.op, 'de'));
  const total = sum(ops.map(o => o.now));
  const totalSt = !official ? { status: 'info', share: null } : d.limit > 0 ? rateStatus(total, d.limit, sup) : { status: 'unknown', share: null };
  const worst = !official ? 'info' : worstOf([totalSt, ...ops].map(o => o.status)) || (per > 0 || d.limit > 0 || sMax != null || sMin != null ? 'ok' : 'unknown');
  return { zone: zone.id, zoneName: zone.name, assumed: !!zone.assumed, rest: !!zone.rest, superset: sup, live: !!zone.live, accuracyM: zone.accuracyM ?? null, at, total, totalStatus: totalSt.status, totalShare: totalSt.share ?? null,
    shareMax: sMax, shareMin: sMin, operators: ops, status: worst };
}
