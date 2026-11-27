// @ts-check
// Mobility Pulse — Verspätungsprognose für Bus und Bahn (18.11.2026, F28): Anteil verspäteter (≥ 5 Min.) und ausgefallener Halte je Gemeinde
// und Ortsstunde für die nächsten 24 Stunden, dazu je Linie für die nächsten Stunden. Grundlage: incidents/<Tag>.json (ptN, ptLate, ptSkip je
// Ortsstunde), Lückenstunden des Stroms (gapHours) zählen nicht. Modell: gewichtetes Mittel derselben Stunde an Tagen desselben Tagtyps
// (Werktag, Samstag, Sonntag; jüngere Tage zählen mehr), mit k Tagen zum Mittel aller Tage dieser Stunde gezogen. Selbstprüfung: jeder der
// letzten Tage nur mit den Tagen davor vorhergesagt, gegen „wie gestern“ (dieselbe Stunde am Vortag).
import { dayOf, hourOf } from './pulse-track.js';
import { gapHours } from './pulse-oepnv-netz.js';
import { ptArea } from './pulse-context.js';
import { dayType as econDayType } from './pulse-econ.js';

// v 2 (26.11.2026, Rückblick 19.–25.11., 1.382 Städte, 17.700 Stunden): k 3 → 1 (Verspätung 5,50 → 5,37 Prozentpunkte, „wie gestern“ 6,81);
// Ausfälle aus dem Vortag statt aus dem Profil (0,93 → 0,75, „wie gestern“ 0,76) – Ausfälle halten über Tage (Baustellen, gestrichene Fahrten).
// v 3 (27.11.2026): Tageskorrektur aus der letzten vollen Stunde (Abweichung × nowBeta^Abstand; Rückblick 22.–27.11., 1.201 Städte: in 1 Stunde
// 5,51 → 4,86, in 2 Stunden 5,43 → 5,23 Prozentpunkte, Ausfälle 0,66 → 0,58) und Tagtyp aus dem Kalender (Feiertage wie Sonntag, Schulferien
// eigener Typ F, ohne F-Tage im Fenster wie Werktag; typeOf über typeOfFor).
export const PTP = Object.freeze({ version: 3, days: 21, halfLifeDays: 7, k: 1, minN: 100, horizonH: 24, evalDays: 7, aheadH: 3, lineTop: 10, lineMinStops: 40, skipPrevW: 0.5, skipPrevMaxAge: 2, seriesDays: 3, nowBeta: 0.5, nowLead: 2,
  adjDays: 7, adjMin: 2000, adjRainMin: 200,
  typeOf: /** @type {((day: string) => string) | null} */ (null), rainOf: /** @type {((day: string, h: number) => number | null) | null} */ (null),
  adj: /** @type {Map<string, { lvl: number, rain: number, n: number, nRain: number }> | null} */ (null) });
const r4 = (/** @type {number} */ x) => Math.round(x * 1e4) / 1e4;
/** Tagtyp eines Ortstags: W Werktag, S Samstag, H Sonntag ohne Kalender (Feiertage zählen hier als ihr Wochentag) */
export const dayType = (/** @type {string} */ day) => { const d = new Date(`${day}T12:00:00Z`).getUTCDay(); return d === 0 ? 'H' : d === 6 ? 'S' : 'W'; };
const LAND = [null, 'SH', 'HH', 'NI', 'HB', 'NW', 'HE', 'RP', 'BW', 'BY', 'SL', 'BE', 'BB', 'MV', 'SN', 'ST', 'TH'];
/**
 * Tagtyp mit Kalender (calendar.json wie die Sharing-Prognose, lib/pulse-econ.js dayType): W, F (Schulferien Mo–Fr), S (auch 31.12.), H (Sonntag,
 * Feiertag des Landes, 24.12.). Ohne Kalender die lokale Feiertagsrechnung.
 * @param {string} ags @param {any} calendar
 */
export const typeOfFor = (ags, calendar) => { const land = LAND[+String(ags).slice(0, 2)] || null, memo = new Map();
  return (/** @type {string} */ day) => { let v = memo.get(day); if (v == null) memo.set(day, v = econDayType(day, land, calendar) || dayType(day)); return v; }; };
const dayDiff = (/** @type {string} */ a, /** @type {string} */ b) => Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86400e3);

/**
 * Tageswerte einer Gemeinde: Map Tag → { n, late, skip } je Stunde (24), Lückenstunden auf 0 gesetzt. area: nur Haltestellen im Geschäftsgebiet
 * (ptArea, für das Merkmal ptRisk der Sharing-Prognose, seit 27.11.2026; Tage ohne Gebietszählung fehlen); Lücken des Stroms aus allen Halten.
 * @param {Map<string, any>} docs @param {string} ags @param {{ area?: boolean }} [opts]
 */
export function cityDays(docs, ags, { area = false } = {}) {
  const ds = [...docs].filter(([, d]) => d?.ags?.[ags]?.ptN && (!area || ptArea(d, ags))).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const gaps = gapHours(ds.map(([, d]) => d.ags[ags].ptN)), out = new Map();
  ds.forEach(([day, d], i) => { const a = area ? /** @type {any} */ (ptArea(d, ags)) : { n: d.ags[ags].ptN, late: d.ags[ags].ptLate, skip: d.ags[ags].ptSkip }, g = gaps[i];
    out.set(day, { n: a.n.map((/** @type {number} */ x, /** @type {number} */ h) => (g[h] ? 0 : x)), late: a.late || new Array(24).fill(0), skip: a.skip || new Array(24).fill(0) }); });
  return out;
}

/**
 * Vorhersage für einen Zieltag aus den Tagen davor: { late: [24], skip: [24], n: [24] } (Anteile; null ohne Grundlage).
 * @param {Map<string, { n: number[], late: number[], skip: number[] }>} days @param {string} target
 */
export function predictDay(days, target, o = PTP) {
  const tOf = o.typeOf || dayType, late = /** @type {(number|null)[]} */ ([]), skip = /** @type {(number|null)[]} */ ([]), n = /** @type {(number|null)[]} */ ([]);
  const prior = [...days].filter(([d]) => d < target && dayDiff(target, d) <= o.days), pType = new Map(prior.map(([d]) => [d, tOf(d)]));
  // Schulferien-Werktag ohne Ferientag im Fenster: wie Werktag (erster Ferientag)
  let type = tOf(target); if (type === 'F' && ![...pType.values()].includes('F')) type = 'W';
  for (let h = 0; h < 24; h++) {
    let wA = 0, lA = 0, sA = 0, wT = 0, lT = 0, sT = 0, nT = 0;
    for (const [d, v] of prior) {
      const N = v.n[h]; if (!(N >= o.minN)) continue;
      const w = Math.pow(0.5, dayDiff(target, d) / o.halfLifeDays), L = v.late[h] / N, S = v.skip[h] / N;
      wA += w; lA += w * L; sA += w * S;
      if (pType.get(d) === type) { wT += w; lT += w * L; sT += w * S; nT += w * N; }
    }
    if (!wA) { late.push(null); skip.push(null); n.push(null); continue; }
    const pL = lA / wA, pS = sA / wA, kk = o.k * (wA / Math.max(1, prior.length)); // k Tage mittleren Gewichts
    late.push(r4((lT + kk * pL) / (wT + kk))); skip.push(r4((sT + kk * pS) / (wT + kk))); n.push(wT ? Math.round(nT / wT) : null);
  }
  // Ausfälle: Hälfte gleiche Stunde am Vortag, Hälfte Tagesmittel des Vortags (fehlt die Stunde: Tagesmittel); ohne Vortag (≤ skipPrevMaxAge Tage) das Profil
  const prevDay = prior.map(([d]) => d).sort().pop(), pv = prevDay && dayDiff(target, prevDay) <= o.skipPrevMaxAge ? days.get(prevDay) : null;
  if (pv) { let s = 0, c = 0; for (let h = 0; h < 24; h++) if (pv.n[h] >= o.minN) { s += pv.skip[h] / pv.n[h]; c++; }
    if (c) { const lvl = s / c; for (let h = 0; h < 24; h++) if (skip[h] != null) skip[h] = r4(o.skipPrevW * (pv.n[h] >= o.minN ? pv.skip[h] / pv.n[h] : lvl) + (1 - o.skipPrevW) * lvl); } }
  return { late, skip, n };
}

/** Lage aller Städte (v 3): Tagesprognose + Niveau + Regen × Aufschlag; adj aus learnAdj, für kommende Tage der jüngste Eintrag */
const adjFor = (/** @type {any} */ adj, /** @type {string} */ d) => { if (!adj?.size) return null; if (adj.has(d)) return adj.get(d); let k = null; for (const x of adj.keys()) if (x <= d && (!k || x > k)) k = x; return k ? adj.get(k) : null; };
/** @param {Map<string, any>} days @param {string} target */
export function predictAdj(days, target, o = PTP) {
  const p = predictDay(days, target, o), A = adjFor(o.adj, target); if (!A) return p;
  return { ...p, late: p.late.map((v, h) => (v == null ? null : r4(Math.max(0, v + A.lvl + (A.rain ? (o.rainOf?.(target, h) || 0) * A.rain : 0))))) };
}
/**
 * Reste der Tagesprognose (ohne Lage) der letzten adjDays + evalDays Tage vor today: [[Tag, Ist − Prognose, Regen 0…1]] für learnAdj.
 * @param {Map<string, any>} days @param {string} today
 */
export function residualRows(days, today, o = PTP) {
  const out = /** @type {Array<[string, number, number]>} */ ([]), lo = dayOf(Date.parse(`${today}T12:00:00Z`) - (o.adjDays + o.evalDays) * 86400e3);
  for (const [d, act] of days) { if (d >= today || d < lo) continue; const p = predictDay(days, d, o);
    for (let h = 0; h < 24; h++) if (act.n[h] >= o.minN && p.late[h] != null) out.push([d, act.late[h] / act.n[h] - /** @type {number} */ (p.late[h]), o.rainOf?.(d, h) || 0]); }
  return out;
}
const med = (/** @type {number[]} */ a) => { const s = Float64Array.from(a).sort(), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
/**
 * Lage aus den Resten aller Städte (Median, denn die Prüfung zählt mittlere Abweichung): je Tag der letzten evalDays Tage und heute gelernt nur aus
 * den adjDays Tagen davor (Rückblick ohne Vorgriff). Rückblick 13.–27.11.2026, 285 Städte: Tagesprognose 5,34 → 5,23, mit Tageskorrektur 2 Stunden
 * voraus 5,12 → 5,05 Prozentpunkte; Niveau zuletzt −1,25 (Mittel über Tage liegt über dem typischen Wert), Regen +1,92.
 * @param {Array<[string, number, number]>} rows @param {string} today
 */
export function learnAdj(rows, today, o = PTP) {
  const by = new Map(); for (const r of rows) { let b = by.get(r[0]); if (!b) by.set(r[0], b = []); b.push(r); }
  const out = new Map(), targets = [...[...by.keys()].filter(d => d < today).sort().slice(-o.evalDays), today];
  for (const D of targets) {
    const lo = dayOf(Date.parse(`${D}T12:00:00Z`) - o.adjDays * 86400e3), tr = [...by].filter(([d]) => d < D && d >= lo).flatMap(([, v]) => v); if (tr.length < o.adjMin) continue;
    const off = tr.filter(r => r[2] < 0.5).map(r => r[1]), on = tr.filter(r => r[2] >= 0.5).map(r => r[1]); if (!off.length) continue;
    const a = med(off); out.set(D, { lvl: r4(a), rain: on.length >= o.adjRainMin ? r4(med(on) - a) : 0, n: tr.length, nRain: on.length });
  }
  return out;
}

/**
 * Nächste horizonH Stunden ab der nächsten vollen Ortsstunde: [[Tag, Stunde, verspätet, ausgefallen, Halte erwartet]].
 * @param {Map<string, any>} days @param {number} now
 */
export function nextHours(days, now, o = PTP) {
  const out = []; const memo = new Map(), pOf = (/** @type {string} */ d) => { let p = memo.get(d); if (!p) memo.set(d, p = predictAdj(days, d, o)); return p; };
  // Tageskorrektur (v 3): Abweichung der letzten vollen Stunde von ihrer Prognose, je Stunde Abstand mit nowBeta abklingend
  const tL = now - 3600e3, dL = dayOf(tL), hL = hourOf(tL), act = days.get(dL), p0 = act && act.n[hL] >= o.minN ? pOf(dL) : null;
  const dev = p0 && p0.late[hL] != null ? act.late[hL] / act.n[hL] - p0.late[hL] : 0, devS = p0 && p0.skip[hL] != null ? act.skip[hL] / act.n[hL] - p0.skip[hL] : 0;
  for (let i = 1; i <= o.horizonH; i++) {
    const t = now + i * 3600e3, d = dayOf(t), h = hourOf(t), p = pOf(d), f = o.nowBeta ** (i + 1);
    if (p.late[h] != null && (p.n[h] ?? 0) >= o.minN) out.push([d, h, r4(Math.max(0, p.late[h] + f * dev)), r4(Math.max(0, (p.skip[h] ?? 0) + f * devS)), p.n[h]]);
  }
  return out;
}

/**
 * Selbstprüfung über die letzten evalDays vollständigen Tage: mittlere absolute Abweichung (Prozentpunkte) des Verspätungsanteils je Stunde
 * gegen „wie gestern“. Rückgabe { days, hours, mae, maeNaive, better } oder null.
 * @param {Map<string, any>} days @param {string} today
 */
export function backtest(days, today, o = PTP) {
  const list = [...days.keys()].filter(d => d < today).sort().slice(-o.evalDays);
  let hours = 0, e = 0, eN = 0, eS = 0, eSN = 0; const used = [], byDay = [], series = [];
  // Tageskorrektur rückwirkend (v 3): Prognose für Stunde h, gerechnet mit der Abweichung der Stunde h − nowLead (so weit voraus wie die erste Zeile von next)
  let cH = 0, cE = 0, cB = 0, cS = 0, cSB = 0; const fL = o.nowBeta ** o.nowLead;
  for (const d of list) {
    const p = predictAdj(days, d, o), act = days.get(d), prev = days.get([...days.keys()].filter(x => x < d).sort().pop() || ''); if (!act || !prev) continue;
    let n = 0, de = 0, deN = 0, ds = 0, dsN = 0; const keep = list.indexOf(d) >= list.length - o.seriesDays;
    for (let h = 0; h < 24; h++) {
      if (!(act.n[h] >= o.minN) || !(prev.n[h] >= o.minN) || p.late[h] == null) continue;
      const a = act.late[h] / act.n[h], aS = act.skip[h] / act.n[h], nv = prev.late[h] / prev.n[h];
      de += Math.abs(/** @type {number} */ (p.late[h]) - a); deN += Math.abs(nv - a); ds += Math.abs(/** @type {number} */ (p.skip[h]) - aS); dsN += Math.abs(prev.skip[h] / prev.n[h] - aS); n++;
      if (keep) series.push([d, h, p.late[h], r4(a), r4(nv)]);
      const hL = h - o.nowLead;
      if (hL >= 0 && act.n[hL] >= o.minN && p.late[hL] != null) {
        const dev = act.late[hL] / act.n[hL] - /** @type {number} */ (p.late[hL]), devS = act.skip[hL] / act.n[hL] - /** @type {number} */ (p.skip[hL]);
        cB += Math.abs(/** @type {number} */ (p.late[h]) - a); cE += Math.abs(Math.max(0, /** @type {number} */ (p.late[h]) + fL * dev) - a);
        cSB += Math.abs(/** @type {number} */ (p.skip[h]) - aS); cS += Math.abs(Math.max(0, /** @type {number} */ (p.skip[h]) + fL * devS) - aS); cH++;
      }
    }
    if (!n) continue;
    used.push(d); hours += n; e += de; eN += deN; eS += ds; eSN += dsN;
    byDay.push([d, r4(de / n), r4(deN / n), r4(ds / n), r4(dsN / n), n]);
  }
  if (!hours) return null;
  const mae = r4(e / hours), maeNaive = r4(eN / hours);
  // seit PTP v 2 (26.11.2026): Ausfälle, Werte je Tag und die Stunden der letzten seriesDays Tage (Prognose, Ist, „wie gestern“) für das Diagramm
  const nowcast = cH ? { lead: o.nowLead, beta: o.nowBeta, hours: cH, mae: r4(cE / cH), maeBase: r4(cB / cH), maeSkip: r4(cS / cH), maeSkipBase: r4(cSB / cH) } : null;
  return { days: used.length, hours, mae, maeNaive, better: mae < maeNaive, maeSkip: r4(eS / hours), maeSkipNaive: r4(eSN / hours), byDay, series, nowcast };
}

/**
 * Linien für die nächsten aheadH Stunden: eigener Verspätungsanteil (Summe, LINE_FIELDS) × Verhältnis der Stadtprognose zum Mittel der Stadt.
 * Rückgabe [[Linie, Art, erwartet verspätet, erwartet ausgefallen]] absteigend, höchstens lineTop.
 * @param {any[][]} lineRows @param {Array<any[]>} next @param {{ late: number, skip: number }} cityMean
 */
export function lineOutlook(lineRows, next, cityMean, o = PTP) {
  const ahead = next.slice(0, o.aheadH); if (!ahead.length || !(cityMean.late > 0)) return [];
  const fl = ahead.reduce((s, x) => s + x[2], 0) / ahead.length / cityMean.late, fs = cityMean.skip > 0 ? ahead.reduce((s, x) => s + x[3], 0) / ahead.length / cityMean.skip : 1;
  return (lineRows || []).filter(r => r[0] && r[2] >= o.lineMinStops).map(r => [r[0], r[1], r4(Math.min(1, (r[4] / r[2]) * fl)), r4(Math.min(1, (r[3] / r[2]) * fs))])
    .sort((a, b) => b[2] + b[3] - a[2] - a[3]).slice(0, o.lineTop);
}

/**
 * Alles für oepnv/<AGS>.json (Feld prognose): { at, next, eval, lines, mean } oder null ohne Grundlage.
 * @param {Map<string, any>} docs @param {string} ags @param {number} now @param {any[][]} lineRows
 */
/**
 * Heute bis zur laufenden Stunde (27.11.2026) für das Diagramm: Prognose aus den Vortagen (predictDay, kennt heute nicht) gegen das bisher
 * Gezählte; die laufende Stunde ohne Zählung. Zeilen wie backtest().series: [Tag, Stunde, Prognose, tatsächlich | null, wie gestern | null].
 * In die Selbstprüfung (mae) kommt der Tag erst, wenn er vorbei ist.
 */
export function todaySeries(days, now, o = PTP) {
  const td = dayOf(now), hNow = hourOf(now), p = predictAdj(days, td, o), act = days.get(td), prev = days.get([...days.keys()].filter(x => x < td).sort().pop() || ''), out = [];
  for (let h = 0; h <= hNow; h++) {
    if (p.late[h] == null || !((p.n[h] ?? 0) >= o.minN)) continue;
    const a = h < hNow && act && act.n[h] >= o.minN ? r4(act.late[h] / act.n[h]) : null, nv = prev && prev.n[h] >= o.minN ? r4(prev.late[h] / prev.n[h]) : null;
    out.push([td, h, p.late[h], a, nv]);
  }
  return out;
}

export function cityOutlook(docs, ags, now, lineRows, o = PTP) {
  const days = cityDays(docs, ags); if (days.size < 3) return null;
  const next = nextHours(days, now, o); if (!next.length) return null;
  let n = 0, l = 0, s = 0; for (const [d, v] of days) { if (d >= dayOf(now)) continue; for (let h = 0; h < 24; h++) if (v.n[h] >= o.minN) { n += v.n[h]; l += v.late[h]; s += v.skip[h]; } }
  const mean = { late: n ? r4(l / n) : 0, skip: n ? r4(s / n) : 0 };
  const ev = backtest(days, dayOf(now), o); if (ev) ev.series = [...ev.series, ...todaySeries(days, now, o)];
  const A = adjFor(o.adj, dayOf(now)); if (ev) ev.adj = A ? { lvl: A.lvl, rain: A.rain, days: o.adjDays } : null;
  return { at: now, fields: ['tag', 'stunde', 'verspaetet', 'ausgefallen', 'halte'], next, eval: ev, mean, lines: lineOutlook(lineRows, next, mean, o) };
}
