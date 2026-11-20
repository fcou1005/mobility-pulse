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
import { mergeTrip, planOnly } from './pulse-oepnv-plan.js';
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
/**
 * Zählung eines Laufs in den Zustand: je Block (1 Ortsstunde, wie ptN) und Station der Lauf mit den meisten Halten; abgelaufene Blöcke in die
 * Summe, Summe altert je Tag. Der Strom hält beendete Fahrten nicht: ein Lauf sieht nur, was gerade fährt. Mit 6-Stunden-Blöcken sah der beste
 * Lauf rund ein Drittel der Halte (Charlottenplatz 130 je Tag gegen 2.295 Abfahrten im Fahrplan, bis 18.11.2026). Blöcke, die schon in der
 * Summe stehen, zählen nicht noch einmal (spätere Läufe sehen noch Halte lange laufender Fahrten).
 */
/** @param {any} st @param {Record<string, Record<string, number[]>>} counts @param {number} now */
export function mergeCounts(st, counts, now) {
  const today = dayOf(now);
  if (st.day && st.day !== today) {
    const k = Math.max(1, Math.round((berlinUtc(today, 12, 0) - berlinUtc(st.day, 12, 0)) / 86400e3)), f = Math.pow(0.5, k / NETZ.halfLifeDays);
    for (const [id, a] of Object.entries(st.tot)) { for (let i = 0; i < a.length; i++) a[i] *= f; if (a[0] < 0.5) delete st.tot[id]; }
    st.days *= f;
  }
  st.day = today;
  for (const [key, m] of Object.entries(counts)) {
    if (now >= blockEnd(key) + NETZ.closeAfterH * 3600e3) continue;
    const o = (st.open[key] ||= {}); for (const [id, c] of Object.entries(m)) if (!o[id] || c[0] >= o[id][0]) o[id] = c;
  }
  let closed = 0;
  for (const key of Object.keys(st.open)) {
    if (now < blockEnd(key) + NETZ.closeAfterH * 3600e3) continue;
    for (const [id, c] of Object.entries(st.open[key])) { const a = (st.tot[id] ||= [0, 0, 0, 0, 0]); for (let i = 0; i < 5; i++) a[i] += c[i]; }
    st.days += NETZ.blockH / 24; delete st.open[key]; closed++;
  }
  return { closed, open: Object.keys(st.open).length, stations: Object.keys(st.tot).length };
}
/** Ende eines Blocks 'Tag|Block' (ms) */
const blockEnd = (/** @type {string} */ key) => { const [d, b] = key.split('|'); return berlinUtc(d, 0, 0) + (+b + 1) * NETZ.blockH * 3600e3; };
/** Tage hinter stationTotals (geschlossen + begonnene offene Blöcke), Teiler für „je Tag“ */
/** @param {any} st @param {number} now */
export function netzDays(st, now) {
  let open = 0; for (const key of Object.keys(st?.open || {})) open += Math.min(1, Math.max(0, (now - (blockEnd(key) - NETZ.blockH * 3600e3)) / (NETZ.blockH * 3600e3)));
  return (st?.days || 0) + open * NETZ.blockH / 24;
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
  out.gap = gapHours(out.n);
  return out;
}
/**
 * Lücken im Echtzeit-Strom: Stunde h eines Tages mit weniger als GAP.share des Medians derselben Stunde an den übrigen Tagen (mindestens
 * GAP.minDays Vergleichstage, Median ab GAP.minN Halte). Sa 14.11.2026 Stuttgart 11–19 Uhr: rund 360 statt 4.000–5.000 Halte je Stunde.
 * Rückgabe je Tag 24 Werte (1 = unvollständig); diese Stunden zählen weder für die Pünktlichkeit noch für die Wirkung.
 */
export const GAP = Object.freeze({ share: 0.25, minDays: 3, minN: 200 });
/** @param {number[][]} n */
export function gapHours(n, o = GAP) {
  return n.map((row, i) => row.map((x, h) => {
    const ref = n.filter((_, j) => j !== i).map(r => r[h]).filter(v => v > 0).sort((a, b) => a - b);
    if (ref.length < o.minDays) return 0; const med = ref[Math.floor(ref.length / 2)];
    return med >= o.minN && x > 0 && x < o.share * med ? 1 : 0;
  }));
}

// ---------- geschätzte Fahrzeugwege ----------
/**
 * Sammler der Wege eines Laufs: onTrip(tripId, routeId, abgesagt, Halte, Betriebstag) je Fahrt; planPass() danach (nur mit plan); result() = { by: Map AGS →
 * [[Linie, Art, Verspätung s, [lat, lon, dt s, …], ausgefallene Halte im Fenster [lat, lon, …] oder null, Ziel oder null, [Station je Punkt des Wegs (Index in
 * ix.st)], Quelle]], cancel: Map AGS → { rows: [[Linie, Art, [lat, lon, dt s, …], Ziel]], lines: Map 'Art|Linie' → [Fahrten, ohne Zeit] } }. Ein Weg reicht vom
 * letzten Halt vor now bis zum ersten Halt nach now + aheadMin; ausgefallene Halte und Halte ohne bekannte Station fehlen im Weg. Seit 17.11.2026: ausgefallene
 * Halte einer fahrenden Fahrt zwischen erstem und letztem Punkt des Wegs (höchstens maxSkip) und ganz ausgefallene Fahrten: mit Zeit im Fenster
 * [now − backMin, now + aheadMin] als Weg (rows, höchstens maxCancel je Gemeinde), alle je Linie gezählt (ohne Zeit = der Strom nennt nur Fahrt und
 * Betriebstag, gtfs.de 12.11.2026: 2.642 von 2.642 abgesagten Fahrten). Ziel (seit 17.11.2026): trip_headsign aus der Fahrten-Tabelle, sonst der letzte Halt
 * der Fahrt im Strom, wenn er eine Station hat. Seit 20.11.2026 mit plan (lib/pulse-oepnv-plan.js planView): Fahrten im Strom bekommen den ganzen Weg aus
 * dem Fahrplan (Quelle 'echtzeit'), planPass() setzt die Fahrten ohne Echtzeit dazu (Quelle 'fahrplan', ohne Verspätung, hinter den Fahrten mit Echtzeit).
 */
/** @param {Map<string, number>} stLookup @param {any} ix @param {number} now @param {any} [opts] */
export function pathCollector(stLookup, ix, now, { aheadMin = NETZ.aheadMin, maxPts = NETZ.maxPts, maxTrips = NETZ.maxTrips, routeOf = null, maxSkip = 12, maxCancel = 200, backMin = 30, plan = null } = {}) {
  const by = new Map(), cancel = new Map(), until = now + aheadMin * 60e3; let trips = 0, withRoute = 0, skipped = 0, canceled = 0, merged = 0, planTrips = 0, planDup = 0;
  const seen = new Set(), keys = new Set();
  const lineOf = (/** @type {string | null} */ id, /** @type {string | null} */ routeId) => (routeId != null ? ix.routes?.[routeId] : null) || (routeOf && id != null ? routeOf(id) : null);
  const agsOf = (/** @type {number} */ q) => ix.ags[ix.st.a[q]];
  /** Ziel einer Fahrt: Fahrtziel des Fahrplans, sonst Name der Station des letzten Halts im Strom */
  const zielOf = (/** @type {any} */ r, /** @type {any[]} */ stu, /** @type {string | null} */ id = null) => { const h = r?.[2] || (routeOf && id != null ? routeOf(id)?.[2] : null); if (h) return String(h); for (let k = stu.length - 1; k >= 0; k--) { if (stu[k].stop == null) continue; const q = stLookup.get(stu[k].stop); return q == null ? null : ix.st.name?.[q] ?? null; } return null; };
  /** Weg aus Punkten [{ q, t, d, k }] (k = Reihenfolge, auch der ausgefallenen Halte sk) schneiden und je Gemeinde ablegen; false = nicht im Fenster */
  const emit = (/** @type {Array<{ q: number, t: number, d: number | null, k: number }>} */ pts, /** @type {Array<{ q: number, k: number }>} */ sk, /** @type {any} */ r, /** @type {string | null} */ ziel, /** @type {string} */ quelle) => {
    if (pts.length < 2 || pts[pts.length - 1].t <= now || pts[0].t > until) return false;
    let i0 = 0; for (let i = 0; i < pts.length; i++) if (pts[i].t <= now) i0 = i;
    let i1 = pts.length - 1; for (let i = i0 + 1; i < pts.length; i++) if (pts[i].t >= until) { i1 = i; break; }
    const cut = pts.slice(i0, Math.min(i1 + 1, i0 + maxPts)); if (cut.length < 2) return false;
    const next = cut.find(p => p.t > now) || cut[cut.length - 1], flat = [];
    for (const p of cut) flat.push(ix.st.lat[p.q], ix.st.lon[p.q], Math.round((p.t - now) / 1000));
    const kA = cut[0].k, kB = cut[cut.length - 1].k, gone = [], seenQ = new Set();
    for (const x of sk) if (x.k > kA && x.k < kB && !seenQ.has(x.q) && seenQ.size < maxSkip) { seenQ.add(x.q); gone.push(ix.st.lat[x.q], ix.st.lon[x.q]); }
    const row = [r?.[0] || null, modeClass(r?.[1], r?.[0]), quelle === 'fahrplan' ? null : next.d ?? null, flat, gone.length ? gone : null, ziel, cut.map(p => p.q), quelle];
    if (quelle === 'fahrplan') planTrips++; else { trips++; if (r) withRoute++; if (gone.length) skipped++; }
    for (const g of new Set(cut.map(p => agsOf(p.q)))) { let l = by.get(g); if (!l) by.set(g, l = []); if (l.length < maxTrips) l.push(row); }
    return true;
  };
  return {
    onTrip(/** @type {string | null} */ _id, /** @type {string | null} */ routeId, /** @type {boolean} */ canc, /** @type {any[]} */ stu, /** @type {string | null} */ date = null) {
      // ganz ausgefallen: abgesagt (CANCELED) oder jeder Halt ausgefallen (so meldet gtfs.de abgesagte Fahrten, 17.11.2026: 0 CANCELED, rund 1.500 Fahrten
      // nur mit ausgefallenen Halten ohne Zeit); je Gemeinde zählen, mit Zeit im Fenster auch als Weg
      const allSkip = stu.length > 0 && stu.every(s => s.stop == null || s.sr === 1);
      if (canc || allSkip) {
        if (plan) { const t = plan.find(_id); if (t >= 0) for (const d of date ? [date] : plan.days(now)) seen.add(`${t}|${d}`); }
        /** @type {{ q: number, t: number | null }[]} */ const qs = [];
        for (const s of stu) { if (s.stop == null) continue; const q = stLookup.get(s.stop); if (q == null || (qs.length && qs[qs.length - 1].q === q)) continue; qs.push({ q, t: s.tt ?? null }); }
        if (!qs.length) return; canceled++;
        const r = lineOf(_id, routeId), art = modeClass(r?.[1], r?.[0]), name = r?.[0] || null, timed = qs.filter(p => p.t != null);
        const inWin = timed.length >= 2 && timed[timed.length - 1].t >= now - backMin * 60e3 && timed[0].t <= until;
        const flat = []; if (inWin) for (const p of timed.slice(0, maxPts)) flat.push(ix.st.lat[p.q], ix.st.lon[p.q], Math.round((/** @type {number} */ (p.t) - now) / 1000));
        for (const g of new Set(qs.map(p => agsOf(p.q)))) {
          let c = cancel.get(g); if (!c) cancel.set(g, c = { rows: [], lines: new Map() });
          const k = `${art}|${name ?? ''}`, n = c.lines.get(k) || [0, 0]; n[0]++; if (!timed.length) n[1]++; c.lines.set(k, n);
          if (inWin && c.rows.length < maxCancel) c.rows.push([name, art, flat, zielOf(r, stu, _id)]);
        }
        return;
      }
      /** @type {{ q: number, t: number, d: number | null, k: number }[]} */ let pts = [];
      /** @type {{ q: number, k: number }[]} */ let sk = [];
      for (let k = 0; k < stu.length; k++) {
        const s = stu[k]; if (s.stop == null) continue; const q = stLookup.get(s.stop); if (q == null) continue;
        if (s.sr === 1) { sk.push({ q, k }); continue; } if (s.tt == null) continue;
        if (pts.length && pts[pts.length - 1].q === q) { pts[pts.length - 1].t = Math.max(pts[pts.length - 1].t, s.tt); continue; }
        pts.push({ q, t: s.tt, d: s.delay ?? null, k });
      }
      const r = lineOf(_id, routeId);
      if (plan) {
        const m = pts.length ? mergeTrip(plan, _id, pts, sk.map(x => x.q), date, now) : null, t = m ? m.t : plan.find(_id);
        if (m) { seen.add(`${m.t}|${m.day}`); if (m.pts.length > pts.length) merged++; pts = m.pts; sk = m.sk; }
        else if (t >= 0) for (const d of date ? [date] : plan.days(now)) seen.add(`${t}|${d}`); // im Fahrplan, aber Halte passen nicht: nur nicht doppelt zeigen
        else for (const p of pts) keys.add(`${p.q}|${Math.floor((p.t - (p.d ?? 0) * 1000) / 60e3)}|${r?.[0] || ''}`); // andere trip_id: Halte merken, damit der Fahrplan die Fahrt nicht doppelt zeigt
      }
      emit(pts, sk, r, zielOf(r, stu, _id), 'echtzeit');
    },
    /** Fahrten ohne Echtzeit aus dem Fahrplan (nach dem Strom aufrufen) */
    planPass() {
      if (!plan) return;
      const res = planOnly(plan, now, until, seen, keys, (t, _d, pts) => { const r = plan.route(t), last = pts[pts.length - 1]; emit(pts, [], r, r?.[2] || ix.st.name?.[last.q] || null, 'fahrplan'); });
      planDup = res.dup;
    },
    result: () => ({ by, cancel, trips, withRoute, skipped, canceled, merged, planTrips, planDup }),
  };
}
/**
 * Fahrten einer Gemeinde für die Live-Datei (seit Format 1.6): die Stationen je Punkt werden zu Indizes in names (Namen der Stationen dieser Datei).
 * Rückgabe { trips: [[Linie, Art, Verspätung, Weg, ausgefallene Halte | null, Ziel | null, [Index in names je Punkt], Quelle ('echtzeit' | 'fahrplan', seit 1.9)]], names }.
 */
/** @param {any[][]} rows @param {any} ix */
export function liveRows(rows, ix) {
  /** @type {Map<number, number>} */ const idx = new Map(), names = /** @type {string[]} */ ([]);
  const loc = (/** @type {number} */ q) => { let i = idx.get(q); if (i == null) { i = names.length; idx.set(q, i); names.push(ix.st.name?.[q] || ix.st.id?.[q] || '?'); } return i; };
  return { trips: rows.map(r => [r[0], r[1], r[2], r[3], r[4] ?? null, r[5] ?? null, (r[6] || []).map(loc), r[7] || 'echtzeit']), names };
}
/** Ausfälle einer Gemeinde für die Live-Datei: { fields, rows: [[Linie, Art, Weg]], lines: [[Linie, Art, Fahrten, ohne Zeit]] } (nach Fahrten, ohne Linie zuletzt), oder null */
export function cancelDoc(/** @type {{ rows: any[][], lines: Map<string, number[]> } | undefined} */ c) {
  if (!c) return null;
  const lines = [...c.lines].map(([k, n]) => { const i = k.indexOf('|'); return /** @type {[string | null, string, number, number]} */ ([k.slice(i + 1) || null, k.slice(0, i), n[0], n[1]]); }).sort((a, b) => b[2] - a[2] || (a[0] == null ? 1 : 0) - (b[0] == null ? 1 : 0) || String(a[0]).localeCompare(String(b[0]), 'de', { numeric: true }));
  return { fields: ['linie', 'art', 'weg', 'ziel'], rows: c.rows, lineFields: ['linie', 'art', 'fahrten', 'ohne_zeit'], lines };
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
  /** @type {Record<string, Record<string, number[]>>} */ const daily = {};
  const agsSet = new Set(); for (const d of docs.values()) for (const g of Object.keys(d?.ags || {})) if (d.ags[g].ptN) agsSet.add(g);
  for (const ags of [...agsSet].sort()) {
    /** @type {number[]} */ const normal = [];
    /** @type {Array<[string, number[]]>} */ const flagged = [];
    // Lückenstunden des Stroms (gapHours) zählen weder als gestört noch als normal
    const dn = [...docs].filter(([, d]) => d?.ags?.[ags]?.ptN), gaps = new Map(gapHours(dn.map(([, d]) => d.ags[ags].ptN)).map((g, i) => [dn[i][0], g]));
    for (const [day, d] of docs) {
      if (day >= today) continue; const a = d?.ags?.[ags], s = series?.days?.[day]?.[`ags:${ags}`]; if (!a?.ptN || !s?.a || !s?.p) continue;
      /** @type {number[]} */ const fl = [], gp = gaps.get(day) || [];
      for (let h = fromHour; h < toHour; h++) { const y = s.a[h], p = s.p[h]; if (gp[h] || !Number.isFinite(y) || !(p >= minForecast) || !(a.ptN[h] >= NETZ.minHourN)) continue; (a.pt?.[h] ? fl : normal).push(y / p - 1); }
      if (fl.length) flagged.push([day, fl]);
    }
    if (!flagged.length || normal.length < 12) continue;
    const base = normal.reduce((s, x) => s + x, 0) / normal.length, vals = flagged.map(([, fl]) => fl.reduce((s, x) => s + x, 0) / fl.length - base), hours = flagged.reduce((s, [, fl]) => s + fl.length, 0);
    all.push(...vals); hoursAll += hours; daily[ags] = Object.fromEntries(flagged.map(([day, fl], i) => [day, [r3(vals[i]), fl.length]]));
    /** @type {any} */ const row = { ags, days: vals.length, hours, normalHours: normal.length, effect: r3(vals.reduce((s, x) => s + x, 0) / vals.length) };
    if (vals.length >= minFlagDays) { const ci = tInterval(vals); row.ci = [r3(ci.lo), r3(ci.hi)]; row.verdict = ci.lo > 0 ? 'mehr' : ci.hi < 0 ? 'weniger' : 'nicht unterscheidbar'; } else row.verdict = 'zu wenig Tage';
    cities.push(row);
  }
  /** @type {any} */ let pooled = null;
  if (all.length >= 5) { const ci = tInterval(all); pooled = { effect: r3(ci.m), ci: [r3(ci.lo), r3(ci.hi)], cityDays: all.length, hours: hoursAll, cities: cities.length, verdict: ci.lo > 0 ? 'mehr' : ci.hi < 0 ? 'weniger' : 'nicht unterscheidbar' }; }
  cities.sort((a, b) => b.days - a.days || b.hours - a.hours || (a.ags < b.ags ? -1 : 1));
  return { daily, rule: `Fahrtbeginne ÷ Prognose des Vortags − 1 je Stunde (${fromHour}–${toHour} Uhr, ab ${NETZ.minHourN} Halten mit Echtzeit); gestörte Stunden (ab 15 % Ausfall oder 30 % verspätet) minus übrige Stunden der Gemeinde, je Tag ein Wert, 90-%-Intervall aus den Tageswerten`, pooled, cities };
}

// ---------- Passives Lernen der Wirkung je Stadt (seit 16.11.2026) ----------
// ptEffect sieht nur das 8-Tage-Fenster der Störungsdokumente. Der Sammler hebt die Tageswerte je Stadt im Zustand auf (keepDays) und schätzt daraus
// für jede Stadt eine Wirkung, die mit k Tagen zur Gesamtwirkung aller Städte gezogen wird: e = (n · Mittel der Stadt + k · Gesamt) ÷ (n + k).
// Städte ohne eigenen Tag bekommen die Gesamtwirkung. Die Prognose zeigt das als Störungskorrektur (Kandidat „stoerung“) und rechnet es nach Freigabe ein (CORR_GATE, frühestens nach passiveDays Lernzeit).
export const LEARN = Object.freeze({ k: 5, keepDays: 60, minPooled: 5, passiveDays: 7 });
/** Tageswerte (ptEffect().daily) in den Lernzustand übernehmen; Tage älter als keepDays fallen weg. learn: { since, days: { AGS: { Tag: [Wert, Stunden] } } } */
/** @param {any} learn @param {Record<string, Record<string, number[]>>} daily @param {string} today */
export function mergeDaily(learn, daily, today, L = LEARN) {
  const out = learn?.days ? learn : { since: today, days: {} }, cut = new Date(Date.parse(`${today}T12:00:00Z`) - L.keepDays * 86400e3).toISOString().slice(0, 10);
  for (const [ags, m] of Object.entries(daily || {})) { const d = (out.days[ags] ||= {}); for (const [day, v] of Object.entries(m)) if (day < today) d[day] = v; }
  for (const [ags, d] of Object.entries(out.days)) { for (const day of Object.keys(d)) if (day < cut) delete d[day]; if (!Object.keys(d).length) delete out.days[ags]; }
  return out;
}
/** Geschätzte Wirkung je Stadt: { since, until (frühestens einschalten), k, pooled: { effect, cityDays }, fields, cities: { AGS: [Tage, Wirkung, Mittel der Stadt] } } */
/** @param {any} learn */
export function learnEffects(learn, L = LEARN) {
  const vals = [], cities = /** @type {Record<string, number[]>} */ ({});
  for (const d of Object.values(learn?.days || {})) for (const v of Object.values(/** @type {Record<string, number[]>} */ (d))) vals.push(v[0]);
  const M = vals.length >= L.minPooled ? vals.reduce((s, x) => s + x, 0) / vals.length : 0;
  for (const [ags, d] of Object.entries(learn?.days || {})) { const v = Object.values(/** @type {Record<string, number[]>} */ (d)).map(x => x[0]), n = v.length, m = v.reduce((s, x) => s + x, 0) / n; cities[ags] = [n, r3((n * m + L.k * M) / (n + L.k)), r3(m)]; }
  const since = learn?.since || null, until = since ? new Date(Date.parse(`${since}T12:00:00Z`) + L.passiveDays * 86400e3).toISOString().slice(0, 10) : null;
  return { since, until, k: L.k, pooled: { effect: r3(M), cityDays: vals.length }, fields: ['tage', 'wirkung', 'mittel_stadt'], cities };
}
