// @ts-check
// Mobility Pulse — Verspätungsprognose für Bus und Bahn (18.11.2026, F28): Anteil verspäteter (≥ 5 Min.) und ausgefallener Halte je Gemeinde
// und Ortsstunde für die nächsten 24 Stunden, dazu je Linie für die nächsten Stunden. Grundlage: incidents/<Tag>.json (ptN, ptLate, ptSkip je
// Ortsstunde), Lückenstunden des Stroms (gapHours) zählen nicht. Modell: gewichtetes Mittel derselben Stunde an Tagen desselben Tagtyps
// (Werktag, Samstag, Sonntag; jüngere Tage zählen mehr), mit k Tagen zum Mittel aller Tage dieser Stunde gezogen. Selbstprüfung: jeder der
// letzten Tage nur mit den Tagen davor vorhergesagt, gegen „wie gestern“ (dieselbe Stunde am Vortag).
import { dayOf, hourOf } from './pulse-track.js';
import { gapHours } from './pulse-oepnv-netz.js';

export const PTP = Object.freeze({ version: 1, days: 21, halfLifeDays: 7, k: 3, minN: 100, horizonH: 24, evalDays: 7, aheadH: 3, lineTop: 10, lineMinStops: 40 });
const r4 = (/** @type {number} */ x) => Math.round(x * 1e4) / 1e4;
/** Tagtyp eines Ortstags: W Werktag, S Samstag, H Sonntag (Feiertage zählen hier als ihr Wochentag) */
export const dayType = (/** @type {string} */ day) => { const d = new Date(`${day}T12:00:00Z`).getUTCDay(); return d === 0 ? 'H' : d === 6 ? 'S' : 'W'; };
const dayDiff = (/** @type {string} */ a, /** @type {string} */ b) => Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86400e3);

/**
 * Tageswerte einer Gemeinde: Map Tag → { n, late, skip } je Stunde (24), Lückenstunden auf 0 gesetzt.
 * @param {Map<string, any>} docs @param {string} ags
 */
export function cityDays(docs, ags) {
  const ds = [...docs].filter(([, d]) => d?.ags?.[ags]?.ptN).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const gaps = gapHours(ds.map(([, d]) => d.ags[ags].ptN)), out = new Map();
  ds.forEach(([day, d], i) => { const a = d.ags[ags], g = gaps[i]; out.set(day, { n: a.ptN.map((/** @type {number} */ x, /** @type {number} */ h) => (g[h] ? 0 : x)), late: a.ptLate || new Array(24).fill(0), skip: a.ptSkip || new Array(24).fill(0) }); });
  return out;
}

/**
 * Vorhersage für einen Zieltag aus den Tagen davor: { late: [24], skip: [24], n: [24] } (Anteile; null ohne Grundlage).
 * @param {Map<string, { n: number[], late: number[], skip: number[] }>} days @param {string} target
 */
export function predictDay(days, target, o = PTP) {
  const type = dayType(target), late = /** @type {(number|null)[]} */ ([]), skip = /** @type {(number|null)[]} */ ([]), n = /** @type {(number|null)[]} */ ([]);
  const prior = [...days].filter(([d]) => d < target && dayDiff(target, d) <= o.days);
  for (let h = 0; h < 24; h++) {
    let wA = 0, lA = 0, sA = 0, wT = 0, lT = 0, sT = 0, nT = 0;
    for (const [d, v] of prior) {
      const N = v.n[h]; if (!(N >= o.minN)) continue;
      const w = Math.pow(0.5, dayDiff(target, d) / o.halfLifeDays), L = v.late[h] / N, S = v.skip[h] / N;
      wA += w; lA += w * L; sA += w * S;
      if (dayType(d) === type) { wT += w; lT += w * L; sT += w * S; nT += w * N; }
    }
    if (!wA) { late.push(null); skip.push(null); n.push(null); continue; }
    const pL = lA / wA, pS = sA / wA, kk = o.k * (wA / Math.max(1, prior.length)); // k Tage mittleren Gewichts
    late.push(r4((lT + kk * pL) / (wT + kk))); skip.push(r4((sT + kk * pS) / (wT + kk))); n.push(wT ? Math.round(nT / wT) : null);
  }
  return { late, skip, n };
}

/**
 * Nächste horizonH Stunden ab der nächsten vollen Ortsstunde: [[Tag, Stunde, verspätet, ausgefallen, Halte erwartet]].
 * @param {Map<string, any>} days @param {number} now
 */
export function nextHours(days, now, o = PTP) {
  const out = []; const memo = new Map();
  for (let i = 1; i <= o.horizonH; i++) {
    const t = now + i * 3600e3, d = dayOf(t), h = hourOf(t);
    let p = memo.get(d); if (!p) memo.set(d, p = predictDay(days, d, o));
    if (p.late[h] != null && (p.n[h] ?? 0) >= o.minN) out.push([d, h, p.late[h], p.skip[h], p.n[h]]);
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
  let hours = 0, e = 0, eN = 0; const used = [];
  for (const d of list) {
    const p = predictDay(days, d, o), act = days.get(d), prev = days.get([...days.keys()].filter(x => x < d).sort().pop() || ''); if (!act || !prev) continue;
    let any = false;
    for (let h = 0; h < 24; h++) {
      if (!(act.n[h] >= o.minN) || !(prev.n[h] >= o.minN) || p.late[h] == null) continue;
      const a = act.late[h] / act.n[h]; e += Math.abs(/** @type {number} */ (p.late[h]) - a); eN += Math.abs(prev.late[h] / prev.n[h] - a); hours++; any = true;
    }
    if (any) used.push(d);
  }
  if (!hours) return null;
  const mae = r4(e / hours), maeNaive = r4(eN / hours);
  return { days: used.length, hours, mae, maeNaive, better: mae < maeNaive };
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
export function cityOutlook(docs, ags, now, lineRows, o = PTP) {
  const days = cityDays(docs, ags); if (days.size < 3) return null;
  const next = nextHours(days, now, o); if (!next.length) return null;
  let n = 0, l = 0, s = 0; for (const [d, v] of days) { if (d >= dayOf(now)) continue; for (let h = 0; h < 24; h++) if (v.n[h] >= o.minN) { n += v.n[h]; l += v.late[h]; s += v.skip[h]; } }
  const mean = { late: n ? r4(l / n) : 0, skip: n ? r4(s / n) : 0 };
  return { at: now, fields: ['tag', 'stunde', 'verspaetet', 'ausgefallen', 'halte'], next, eval: backtest(days, dayOf(now), o), mean, lines: lineOutlook(lineRows, next, mean, o) };
}
