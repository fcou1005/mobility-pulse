// @ts-check
// Mobility Pulse – Reiter ÖPNV (16.11.2026): Halte je Station, geschätzte Fahrzeugwege, Wirkung von Störungen auf Sharing und Vorschläge für
// Sharing-Stationen. Grundlage ist derselbe GTFS-Realtime-Strom wie in lib/pulse-oepnv.js (gtfs.de, CC BY-SA 4.0; Haltestellen CC BY 4.0).
// Fahrzeugwege sind keine Ortung: der Strom nennt je Fahrt die Haltezeiten samt Verspätung, die Lage zwischen zwei Halten ist die Luftlinie
// zwischen den Stationen, zeitlich gleichmäßig durchfahren. Je Station zählt jeder Lauf die Halte der letzten Stunden in 6-Stunden-Blöcken;
// je Block gilt der Lauf mit den meisten Halten (spätere Läufe sehen beendete Fahrten nicht mehr), geschlossene Blöcke gehen in eine Summe
// mit Halbwertszeit. Keine Fahrgastzahlen, keine Fahrzeugkennungen.
import { dayOf, hourOf } from './pulse-track.js';
import { berlinUtc } from './pulse-context.js';
import { NETZ, modeClass } from './pulse-oepnv-karte.js';
export * from './pulse-oepnv-karte.js';

const r1 = (/** @type {number} */ x) => Math.round(x * 10) / 10, r3 = (/** @type {number} */ x) => Math.round(x * 1000) / 1000;

// ---------- Halte je Station ----------
/** @returns {any} */
export function emptyNetzState() { return { v: NETZ.version, open: {}, tot: {}, days: 0, day: null }; }
/**
 * Zähler für einen Lauf: onStop(stop, t, skipped, delay) für jeden Halt im Fenster; result() = { 'Tag|Block': { Station: [Halte, ausgefallen,
 * verspätet, Σ Verspätung s, Halte mit Verspätungsangabe] } }. stLookup: stop_id → Stationsindex, ids: Stationskennungen.
 */
/** @param {Map<string, number>} stLookup @param {string[]} ids @param {any} [opts] */
export function stationCounter(stLookup, ids, { lateSec = 300 } = {}) {
  /** @type {Record<string, Record<string, number[]>>} */ const out = {};
  return {
    onStop(/** @type {string} */ stop, /** @type {number} */ t, /** @type {boolean} */ skipped, /** @type {number | null} */ delay) {
      const q = stLookup.get(stop); if (q == null) return;
      const key = `${dayOf(t)}|${Math.floor(hourOf(t) / NETZ.blockH)}`, o = (out[key] ||= {}), c = (o[ids[q]] ||= [0, 0, 0, 0, 0]);
      c[0]++; if (skipped) c[1]++; else { if (delay != null && delay >= lateSec) c[2]++; if (delay != null) { c[3] += Math.max(0, delay); c[4]++; } }
    },
    result: () => out,
  };
}
/** Zählung eines Laufs in den Zustand: je Block und Station der Lauf mit den meisten Halten; abgelaufene Blöcke in die Summe, Summe altert je Tag */
/** @param {any} st @param {Record<string, Record<string, number[]>>} counts @param {number} now */
export function mergeCounts(st, counts, now) {
  const today = dayOf(now);
  if (st.day && st.day !== today) {
    const k = Math.max(1, Math.round((berlinUtc(today, 12, 0) - berlinUtc(st.day, 12, 0)) / 86400e3)), f = Math.pow(0.5, k / NETZ.halfLifeDays);
    for (const [id, a] of Object.entries(st.tot)) { for (let i = 0; i < a.length; i++) a[i] *= f; if (a[0] < 0.5) delete st.tot[id]; }
    st.days *= f;
  }
  st.day = today;
  for (const [key, m] of Object.entries(counts)) { const o = (st.open[key] ||= {}); for (const [id, c] of Object.entries(m)) if (!o[id] || c[0] >= o[id][0]) o[id] = c; }
  let closed = 0;
  for (const key of Object.keys(st.open)) {
    const [d, b] = key.split('|'), end = berlinUtc(d, 0, 0) + (+b + 1) * NETZ.blockH * 3600e3;
    if (now < end + NETZ.closeAfterH * 3600e3) continue;
    for (const [id, c] of Object.entries(st.open[key])) { const a = (st.tot[id] ||= [0, 0, 0, 0, 0]); for (let i = 0; i < 5; i++) a[i] += c[i]; }
    st.days += NETZ.blockH / 24; delete st.open[key]; closed++;
  }
  return { closed, open: Object.keys(st.open).length, stations: Object.keys(st.tot).length };
}
/** Summe je Station (geschlossen + offen) und die Halte des Tages day: Map Station → { tot: [5], day: [5] } */
/** @param {any} st @param {string} day */
export function stationTotals(st, day) {
  /** @type {Map<string, { tot: number[], day: number[] }>} */ const out = new Map();
  const E = (/** @type {string} */ id) => { let e = out.get(id); if (!e) out.set(id, e = { tot: [0, 0, 0, 0, 0], day: [0, 0, 0, 0, 0] }); return e; };
  for (const [id, a] of Object.entries(st.tot)) { const e = E(id); for (let i = 0; i < 5; i++) e.tot[i] += a[i]; }
  for (const [key, m] of Object.entries(st.open)) { const isDay = key.startsWith(`${day}|`); for (const [id, c] of Object.entries(/** @type {Record<string, number[]>} */ (m))) { const e = E(id); for (let i = 0; i < 5; i++) { e.tot[i] += c[i]; if (isDay) e.day[i] += c[i]; } } }
  return out;
}
export const STATION_FIELDS = ['station', 'name', 'lat', 'lon', 'halte', 'ausgefallen', 'verspaetet', 'verspaetung_min', 'halte_heute', 'ausgefallen_heute', 'verspaetet_heute'];
/** Stationen je Gemeinde aus dem Index: Map AGS → [Stationsindex …] */
/** @param {any} ix */
export function stationsByAgs(ix) { const m = new Map(); (ix?.st?.id || []).forEach((/** @type {string} */ _, /** @type {number} */ q) => { const g = ix.ags[ix.st.a[q]]; let l = m.get(g); if (!l) m.set(g, l = []); l.push(q); }); return m; }
/** Zeilen einer Gemeinde (STATION_FIELDS), nach Halten absteigend, höchstens top */
/** @param {any} ix @param {number[]} qs @param {Map<string, { tot: number[], day: number[] }>} totals @param {number} [top] */
export function stationRows(ix, qs, totals, top = NETZ.top) {
  const rows = [];
  for (const q of qs || []) { const e = totals.get(ix.st.id[q]); if (!e || !(e.tot[0] > 0)) continue; const a = e.tot, d = e.day;
    rows.push([ix.st.id[q], ix.st.name[q], ix.st.lat[q], ix.st.lon[q], r1(a[0]), r1(a[1]), r1(a[2]), a[4] > 0 ? r1(a[3] / a[4] / 60) : null, d[0], d[1], d[2]]); }
  return rows.sort((x, y) => y[4] - x[4] || (x[0] < y[0] ? -1 : 1)).slice(0, top);
}
/** Stunden der Gemeinde aus den Störungs-Dokumenten (incidents/<Tag>.json): { days, n, skip, late, flag } je Tag 24 Werte, dazu ganz ausgefallene Fahrten */
/** @param {Map<string, any>} docs @param {string} ags @param {string[]} days */
export function hoursOf(docs, ags, days) {
  /** @type {any} */ const out = { days: [], n: [], skip: [], late: [], flag: [], cancel: [] };
  for (const d of days) { const a = docs.get(d)?.ags?.[ags]; if (!a?.ptN) continue; out.days.push(d); out.n.push(a.ptN); out.skip.push(a.ptSkip || new Array(24).fill(0)); out.late.push(a.ptLate || new Array(24).fill(0)); out.flag.push(a.pt || new Array(24).fill(0)); out.cancel.push(docs.get(d)?.ptDay?.[ags]?.[0] ?? 0); }
  return out;
}

// ---------- geschätzte Fahrzeugwege ----------
/**
 * Sammler der Wege eines Laufs: onTrip(tripId, routeId, abgesagt, Halte) je Fahrt; result() = Map AGS → [[Linie, Art, Verspätung s, [lat, lon, dt s, …]]].
 * Ein Weg reicht vom letzten Halt vor now bis zum ersten Halt nach now + aheadMin; ausgefallene Halte und Halte ohne bekannte Station fehlen.
 */
/** @param {Map<string, number>} stLookup @param {any} ix @param {number} now @param {any} [opts] */
export function pathCollector(stLookup, ix, now, { aheadMin = NETZ.aheadMin, maxPts = NETZ.maxPts, maxTrips = NETZ.maxTrips, routeOf = null } = {}) {
  const by = new Map(), until = now + aheadMin * 60e3; let trips = 0, withRoute = 0;
  return {
    onTrip(/** @type {string | null} */ _id, /** @type {string | null} */ routeId, /** @type {boolean} */ canceled, /** @type {any[]} */ stu) {
      if (canceled) return;
      /** @type {{ q: number, t: number, d: number | null }[]} */ const pts = [];
      for (const s of stu) { if (s.sr === 1 || s.tt == null || s.stop == null) continue; const q = stLookup.get(s.stop); if (q == null) continue; if (pts.length && pts[pts.length - 1].q === q) { pts[pts.length - 1].t = Math.max(pts[pts.length - 1].t, s.tt); continue; } pts.push({ q, t: s.tt, d: s.delay }); }
      if (pts.length < 2 || pts[pts.length - 1].t <= now || pts[0].t > until) return;
      let i0 = 0; for (let i = 0; i < pts.length; i++) if (pts[i].t <= now) i0 = i;
      let i1 = pts.length - 1; for (let i = i0 + 1; i < pts.length; i++) if (pts[i].t >= until) { i1 = i; break; }
      const cut = pts.slice(i0, Math.min(i1 + 1, i0 + maxPts)); if (cut.length < 2) return;
      const next = cut.find(p => p.t > now) || cut[cut.length - 1], r = (routeId != null ? ix.routes?.[routeId] : null) || (routeOf && _id != null ? routeOf(_id) : null), flat = [];
      for (const p of cut) flat.push(ix.st.lat[p.q], ix.st.lon[p.q], Math.round((p.t - now) / 1000));
      const row = [r?.[0] || null, modeClass(r?.[1], r?.[0]), next.d ?? null, flat]; trips++; if (r) withRoute++;
      for (const g of new Set(cut.map(p => ix.ags[ix.st.a[p.q]]))) { let l = by.get(g); if (!l) by.set(g, l = []); if (l.length < maxTrips) l.push(row); }
    },
    result: () => ({ by, trips, withRoute }),
  };
}
// ---------- Wirkung von Störungen auf Sharing ----------
// Je Gemeinde und Stunde (6–22 Uhr): Abweichung der Sharing-Fahrtbeginne von der am Vortag ausgegebenen Prognose (forecast/series.json), in
// gestörten Stunden (Kennzeichen pt) gegen die übrigen Stunden derselben Gemeinde. Stunden eines Tages hängen zusammen: gezählt wird je Tag
// ein Wert (Mittel der gestörten Stunden minus Mittel der normalen Stunden der Gemeinde), das 90-%-Intervall kommt aus diesen Tageswerten (t-Verteilung).
const tq95 = (/** @type {number} */ df) => (df >= 30 ? 1.645 : [6.314, 2.920, 2.353, 2.132, 2.015, 1.943, 1.895, 1.860, 1.833, 1.812, 1.796, 1.782, 1.771, 1.761, 1.753, 1.746, 1.740, 1.734, 1.729, 1.725, 1.721, 1.717, 1.714, 1.711, 1.708, 1.706, 1.703, 1.701, 1.699][Math.max(1, Math.floor(df)) - 1]);
/** @param {number[]} v */
const tInterval = (v) => { const n = v.length, m = v.reduce((s, x) => s + x, 0) / n, sd = Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)), h = tq95(n - 1) * sd / Math.sqrt(n); return { m, lo: m - h, hi: m + h }; };
/**
 * docs: Map Tag → Störungs-Dokument, series: forecast/series.json. Rückgabe { rule, pooled, cities: [{ ags, effect, ci, days, hours, normalHours, verdict }] };
 * effect = Anteil (0,12 = 12 % mehr Fahrtbeginne als sonst in gestörten Stunden); verdict 'mehr' | 'weniger' | 'nicht unterscheidbar' | 'zu wenig Tage'.
 */
/** @param {Map<string, any>} docs @param {any} series @param {any} [opts] */
export function ptEffect(docs, series, { today = '9999', minFlagDays = NETZ.minFlagDays, fromHour = NETZ.fromHour, toHour = NETZ.toHour, minForecast = NETZ.minForecast } = {}) {
  const cities = [], all = []; let hoursAll = 0;
  const agsSet = new Set(); for (const d of docs.values()) for (const g of Object.keys(d?.ags || {})) if (d.ags[g].ptN) agsSet.add(g);
  for (const ags of [...agsSet].sort()) {
    /** @type {number[]} */ const normal = [];
    /** @type {Array<[string, number[]]>} */ const flagged = [];
    for (const [day, d] of docs) {
      if (day >= today) continue; const a = d?.ags?.[ags], s = series?.days?.[day]?.[`ags:${ags}`]; if (!a?.ptN || !s?.a || !s?.p) continue;
      /** @type {number[]} */ const fl = [];
      for (let h = fromHour; h < toHour; h++) { const y = s.a[h], p = s.p[h]; if (!Number.isFinite(y) || !(p >= minForecast) || !(a.ptN[h] >= NETZ.minHourN)) continue; (a.pt?.[h] ? fl : normal).push(y / p - 1); }
      if (fl.length) flagged.push([day, fl]);
    }
    if (!flagged.length || normal.length < 12) continue;
    const base = normal.reduce((s, x) => s + x, 0) / normal.length, vals = flagged.map(([, fl]) => fl.reduce((s, x) => s + x, 0) / fl.length - base), hours = flagged.reduce((s, [, fl]) => s + fl.length, 0);
    all.push(...vals); hoursAll += hours;
    /** @type {any} */ const row = { ags, days: vals.length, hours, normalHours: normal.length, effect: r3(vals.reduce((s, x) => s + x, 0) / vals.length) };
    if (vals.length >= minFlagDays) { const ci = tInterval(vals); row.ci = [r3(ci.lo), r3(ci.hi)]; row.verdict = ci.lo > 0 ? 'mehr' : ci.hi < 0 ? 'weniger' : 'nicht unterscheidbar'; } else row.verdict = 'zu wenig Tage';
    cities.push(row);
  }
  /** @type {any} */ let pooled = null;
  if (all.length >= 5) { const ci = tInterval(all); pooled = { effect: r3(ci.m), ci: [r3(ci.lo), r3(ci.hi)], cityDays: all.length, hours: hoursAll, cities: cities.length, verdict: ci.lo > 0 ? 'mehr' : ci.hi < 0 ? 'weniger' : 'nicht unterscheidbar' }; }
  cities.sort((a, b) => b.days - a.days || b.hours - a.hours || (a.ags < b.ags ? -1 : 1));
  return { rule: `Fahrtbeginne ÷ Prognose des Vortags − 1 je Stunde (${fromHour}–${toHour} Uhr, ab ${NETZ.minHourN} Halten mit Echtzeit); gestörte Stunden (ab 15 % Ausfall oder 30 % verspätet) minus übrige Stunden der Gemeinde, je Tag ein Wert, 90-%-Intervall aus den Tageswerten`, pooled, cities };
}
