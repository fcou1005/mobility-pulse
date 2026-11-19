// @ts-check
// Mobility Pulse – Regen-Elastizität je Stadt und Fahrzeugart (F34, Review 18.11.2026): Wie stark bricht Sharing bei Regen ein?
// Grundlage sind die Stundenwerte des Trainingsarchivs train/<JJJJ>/<Tag>.json.gz (Fahrtbeginne je Gemeinde|Anbieter|Art, beobachtetes Wetter
// je 0,5°-Zelle des DWD über Bright Sky, Tagtyp je Land). Gezählt werden die Stunden 7 bis 21 Uhr mit vollständiger Messung.
//  - Regenstunde: Niederschlag ≥ 0,5 mm/h. Vergleichsbasis: Mittel derselben Stunde und desselben Tagtyps (Werktag / Wochenende-Feiertag) über
//    trockene Stunden (kein Niederschlag in der Stunde und der Vorstunde), mindestens 3 solche Stunden.
//  - Wirkung = Σ Fahrten in Regenstunden ÷ Σ Vergleichsbasis derselben Stunden − 1; 90-%-Intervall aus 400 Bootstrap-Ziehungen über die Regentage
//    (feste Saat, gleiche Daten → gleiches Ergebnis). Kein Modell, keine Temperatur- oder Trendbereinigung: Regentage im November sind oft auch
//    kühler; das steckt in der Zahl mit drin.
//  - Je Stadt und Art erst ab 8 Regenstunden an 3 Regentagen und 50 Fahrten je Tag; Carsharing bleibt außen vor (Buchungen über Stunden).
// Wirkung auf Prognose und Disposition: keine; die Prognose lernt ihre eigene Regenwirkung (lib/pulse-forecast-model.js, wxEffects).
import { barsSvg, TYPE_DE } from './pulse-markt-index.js';

export const REGEN = Object.freeze({ version: 1, wetMm: 0.5, h0: 7, h1: 22, minBase: 3, minWetHours: 8, minWetDays: 3, minTripsDay: 50, boot: 400, maxDays: 42, minCities: 5, hourMin: 50 });
const LAND = { '01': 'SH', '02': 'HH', '03': 'NI', '04': 'HB', '05': 'NW', '06': 'HE', '07': 'RP', '08': 'BW', '09': 'BY', '10': 'SL', '11': 'BE', '12': 'BB', '13': 'MV', '14': 'SN', '15': 'ST', '16': 'TH' };
const r3 = (x) => Math.round(x * 1000) / 1000;
const fmtPct = (x) => `${x < 0 ? '−' : '+'}${Math.round(Math.abs(x) * 100)} %`;

/**
 * Ein Tag des Trainingsarchivs, verdichtet auf das, was die Rechnung braucht: { day, rows: { 'AGS|Art': { dt, y, p, q } } } mit y = Fahrtbeginne,
 * p = Niederschlag, q = Niederschlag der Vorstunde je gezählter Stunde (null = nicht gezählt). Über die Anbieter summiert, ohne Carsharing.
 * @param {any} doc train/<JJJJ>/<Tag>.json.gz (entpackt) @returns {any}
 */
export function regenDay(doc) {
  const out = { day: doc?.day, rows: /** @type {Record<string, any>} */ ({}) };
  const fi = (doc?.f || []).indexOf('start'), cells = doc?.wx?.cells || {}, map = doc?.wx?.ags || {}, gap = new Set(doc?.gapHours || []), hm = doc?.hourMin || doc?.obs || [];
  if (fi < 0) return out;
  const sums = new Map();
  for (const [k, v] of Object.entries(doc.g || {})) {
    const [ags, , type] = k.split('|'); if (type === 'car') continue;
    const s = v[fi], key = `${ags}|${type}`, acc = sums.get(key) || Array(24).fill(0);
    for (let h = 0; h < 24; h++) acc[h] += Array.isArray(s) ? (s[h] || 0) : (s || 0);
    sums.set(key, acc);
  }
  for (const [key, y] of sums) {
    const ags = key.split('|')[0], wx = cells[map[ags]], p = wx?.[1]; if (!Array.isArray(p)) continue;
    const dt = (doc.dayType?.[LAND[ags.slice(0, 2)]] || 'W') === 'W' ? 'W' : 'S';
    const ok = (/** @type {number} */ h) => h >= REGEN.h0 && h < REGEN.h1 && !gap.has(h) && (hm[h] ?? 0) >= REGEN.hourMin && p[h] != null;
    out.rows[key] = { dt, y: y.map((x, h) => (ok(h) ? x : null)), p: p.map((x, h) => (ok(h) ? x : null)), q: p.map((_, h) => (ok(h) ? (h > 0 ? p[h - 1] ?? 0 : 0) : null)) };
  }
  return out;
}

// Saat-Zufall (mulberry32): gleiche Daten, gleiches Intervall
const rng = (seed) => () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const q = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(p * arr.length)))];

/** Wirkung mit Intervall aus Regenstunden je Tag: wet = Map(Tag → [Σ Fahrten, Σ Basis]) */
function estimate(wet, seed) {
  const ds = [...wet.keys()].sort(), sum = (keys) => { let y = 0, b = 0; for (const d of keys) { const e = wet.get(d); y += e[0]; b += e[1]; } return b > 0 ? y / b : null; };
  const est = sum(ds); if (est == null) return null;
  const r = rng(seed), bs = [];
  for (let i = 0; i < REGEN.boot; i++) { const v = sum(ds.map(() => ds[Math.floor(r() * ds.length)])); if (v != null) bs.push(v); }
  bs.sort((a, b) => a - b);
  return { effect: r3(est - 1), lo: r3(q(bs, 0.05) - 1), hi: r3(q(bs, 0.95) - 1) };
}

/**
 * Regen-Elastizität aus verdichteten Tagen (regenDay). Rückgabe { version, rule, days, first, last, rows, de }:
 * rows je Gemeinde und Art { ags, name, type, effect, lo, hi, wetHours, wetDays, tripsDay } nach Fahrten je Tag absteigend;
 * de je Art über alle Städte mit Ergebnis gepoolt { type, effect, lo, hi, wetHours, cities }.
 * @param {any[]} days @param {{ names?: Record<string, string> }} [opts] @returns {any}
 */
export function rainElasticity(days, { names = {} } = {}) {
  const D = (days || []).filter(d => d?.day).sort((a, b) => (a.day < b.day ? -1 : 1)), byKey = new Map();
  for (const d of D) for (const [key, r] of Object.entries(d.rows || {})) { const l = byKey.get(key) || []; l.push({ day: d.day, ...r }); byKey.set(key, l); }
  const rows = [], pool = new Map();
  let seed = 1;
  for (const [key, L] of [...byKey].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    seed++;
    let trips = 0; const base = new Map();
    for (const e of L) for (let h = 0; h < 24; h++) { if (e.y[h] == null) continue; trips += e.y[h]; if (e.p[h] === 0 && e.q[h] === 0) { const k = `${e.dt}${h}`, b = base.get(k) || [0, 0]; b[0] += e.y[h]; b[1]++; base.set(k, b); } }
    const tripsDay = trips / L.length; if (tripsDay < REGEN.minTripsDay) continue;
    const wet = new Map(); let wetHours = 0;
    for (const e of L) for (let h = 0; h < 24; h++) {
      if (e.y[h] == null || !(e.p[h] >= REGEN.wetMm)) continue;
      const b = base.get(`${e.dt}${h}`); if (!b || b[1] < REGEN.minBase) continue;
      const w = wet.get(e.day) || [0, 0]; w[0] += e.y[h]; w[1] += b[0] / b[1]; wet.set(e.day, w); wetHours++;
    }
    if (wetHours < REGEN.minWetHours || wet.size < REGEN.minWetDays) continue;
    const est = estimate(wet, seed); if (!est) continue;
    const [ags, type] = key.split('|');
    rows.push({ ags, name: names[ags] || ags, type, ...est, wetHours, wetDays: wet.size, tripsDay: Math.round(tripsDay) });
    const P = pool.get(type) || { wet: new Map(), hours: 0, cities: 0 }; for (const [d, w] of wet) { const x = P.wet.get(d) || [0, 0]; x[0] += w[0]; x[1] += w[1]; P.wet.set(d, x); } P.hours += wetHours; P.cities++; pool.set(type, P);
  }
  rows.sort((a, b) => b.tripsDay - a.tripsDay || (a.ags < b.ags ? -1 : 1));
  const de = [...pool].filter(([, P]) => P.cities >= REGEN.minCities).map(([type, P]) => ({ type, ...estimate(P.wet, 7), wetHours: P.hours, cities: P.cities })).sort((a, b) => b.cities - a.cities);
  return { version: REGEN.version, rule: { wetMm: REGEN.wetMm, hours: [REGEN.h0, REGEN.h1], minWetHours: REGEN.minWetHours, minWetDays: REGEN.minWetDays, minTripsDay: REGEN.minTripsDay, level: 0.9 }, days: D.length, first: D[0]?.day || null, last: D.at(-1)?.day || null, rows, de };
}

/** Grafik der Woche, Thema „regen“: die zehn Städte mit den meisten Fahrten je Tag (eine Zeile je Stadt, größte Art) und ihr Einbruch bei Regen */
/** @param {any} regen markt/regen.json @param {string} week @returns {any} */
export function regenGraphic(regen, week) {
  const nr = +week.slice(-2), seen = new Set(), rows = [];
  for (const r of regen?.rows || []) { if (seen.has(r.ags) || r.effect >= 0) continue; seen.add(r.ags); rows.push(r); if (rows.length === 10) break; }
  const title = `So stark bricht Sharing bei Regen ein, KW ${nr}`;
  // Spanne vorn, damit barsSvg sie als Rückgang färbt (Zeichen −); Art dahinter, eine Zeile je Stadt
  const bars = rows.map(r => ({ label: r.name, value: -r.effect * 100, sub: `${fmtPct(r.hi)} bis ${fmtPct(r.lo)} (90 %), ${TYPE_DE[r.type] || r.type}` }));
  return { week, theme: 'regen', title, svg: barsSvg(bars, { title, unit: ' % weniger,', w: 800, textW: 310, subtitle: `Fahrten in Stunden mit ≥ 0,5 mm Regen gegen trockene Stunden gleicher Uhrzeit und Tagart, ${regen.first} bis ${regen.last}` }) };
}
