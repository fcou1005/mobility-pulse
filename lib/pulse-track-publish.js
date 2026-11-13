// @ts-check
// Mobility Pulse — Fahrzeug-Verfolgung – Gruppen-Monatsdateien, Altläufe, Zellen und Ströme veröffentlichen (aus pulse-track.js geschnitten; pulse-track.js bleibt die Fassade für alle Importe).
import { hourMinutes } from './pulse-core.js';
import { BANDS, CELL_LAT, CELL_LEN, CELL_LON, DEMAND_MAIN, GAP_MS, HOUR_FIELDS, HOUR_SUMS, STATION_BOUND, SWAP_TO, TRACK_VERSION, arr, bandOf, dayOf, emptyHourly, hourOf, isNightHour } from './pulse-track-rules.js';
import { GROUP_M, GROUP_MIN } from './pulse-track-run.js';

// ---------- Gruppen-Ereignisse dauerhaft: groups/<JJJJ-MM>.json (Monat nach Europe/Berlin) + groups/index.json ----------
// Zeile nach GROUP_FIELDS: [at (ms), art ('deploy'|'collect'), anbieter, gemeinde (AGS), lat, lon, anzahl, arten {Fahrzeugart: n}]
export const GROUP_FIELDS = ['at', 'art', 'anbieter', 'gemeinde', 'lat', 'lon', 'anzahl', 'arten'];
export const GROUP_VERSION = 1;
export const groupRow = (g) => [g.at, g.kind, g.op, g.ags, g.lat, g.lon, g.n, g.types];
const groupKey = (e) => `${e[0]}|${e[1]}|${e[2]}|${e[4]}|${e[5]}`;
/**
 * Ereignisse in Monatsdokumente einsortieren. docs = { 'JJJJ-MM': bisheriges Dokument | null }, rows = neue Zeilen.
 * Rückgabe: nur die geänderten Monate { 'JJJJ-MM': { version, month, fields, events (nach at sortiert), updatedAt } }; dasselbe Ereignis
 * (gleicher Lauf, Art, Anbieter, Ort) steht nur einmal darin. Nichts wird gelöscht.
 */
export function mergeGroupMonths(docs, rows, { at = null, tz = 'Europe/Berlin' } = {}) {
  const out = {}, keys = {};
  for (const r of rows || []) {
    if (!Array.isArray(r) || !Number.isFinite(r[0])) continue;
    const m = dayOf(r[0], tz).slice(0, 7);
    if (!out[m]) { const d = docs?.[m]; out[m] = { version: GROUP_VERSION, month: m, fields: GROUP_FIELDS, events: d?.month === m && Array.isArray(d.events) ? d.events.slice() : [] }; keys[m] = new Set(out[m].events.map(groupKey)); }
    const k = groupKey(r); if (keys[m].has(k)) continue; keys[m].add(k); out[m].events.push(r);
  }
  for (const d of Object.values(out)) { d.events.sort((a, b) => a[0] - b[0]); d.updatedAt = at; }
  return out;
}
/**
 * Nachtanteil je Anbieter (Z7, Gütemaß der Gruppen-Erkennung): Betriebsfahrten liegen überwiegend außerhalb des Nachfrage-Hauptfensters
 * (Dott-Ausbringungen 58 % nachts), Nutzerverkehr an Stationen folgt dem Fahrtengang (nextbike vor dem 02.11.2026: 16 %).
 * rows = Zeilen nach GROUP_FIELDS; Rückgabe { Anbieter: { n, night, share } } (share = Anteil 22–7 Uhr Ortszeit, null unter 1 Ereignis).
 */
export function groupNight(rows, { since = null, tz = 'Europe/Berlin' } = {}) {
  const out = {};
  for (const r of rows || []) { if (!Array.isArray(r) || !Number.isFinite(r[0]) || (since != null && r[0] < since)) continue; const o = (out[r[2]] ??= { n: 0, night: 0, share: null }); o.n++; if (isNightHour(hourOf(r[0], tz))) o.night++; }
  for (const o of Object.values(out)) o.share = o.n ? +(o.night / o.n).toFixed(3) : null;
  return out;
}
/** Verzeichnis groups/index.json: months (aufsteigend), counts je Monat, Gesamtzahl, erstes/letztes Ereignis, Regeln der Erkennung, Nachtanteil je Anbieter (30 Tage) */
export function groupIndex(months, counts, { at = null, first = null, last = null, night = null } = {}) {
  const ms = [...new Set(months || [])].filter(m => /^\d{4}-\d{2}$/.test(m)).sort();
  return { version: GROUP_VERSION, months: ms, counts: Object.fromEntries(ms.map(m => [m, counts?.[m] ?? 0])), events: ms.reduce((s, m) => s + (counts?.[m] ?? 0), 0), first, last, fields: GROUP_FIELDS, min: GROUP_MIN, radiusM: GROUP_M,
    rules: { demandMain: DEMAND_MAIN, stationBound: STATION_BOUND, deployMinBattery: SWAP_TO, since: '2026-11-02a' }, ...(night ? { night30: night } : {}), updatedAt: at };
}
export function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400e3); }

// Tagesdatei zusammenführen: bestehende Stundenwerte + neue
// runs[k] = [at, dt, flag, regelstand?]: 1 = Lauf zählt Ereignisse und Fahrzeugminuten, 0 = Lauf nach Lücke (> 45 Min.) bzw. ohne Zählung;
// regelstand = METHOD_VERSION@Commit (ältere Läufe ohne Angabe).
// gapHours = Stunden (tz) mit einem Lauf mit Flag 0: gestört → Seite zeigt sie grau und nimmt sie aus Hochrechnungen.
// Ältere Läufe mit dt > 45 Min. (vor der Lückenregel, Ereignisse wurden noch gezählt) werden nachträglich auf 0 gesetzt.
export function gapHoursOf(runs, tz = 'Europe/Berlin') { return [...new Set((runs || []).filter(r => r[2] === 0).map(r => hourOf(r[0], tz)))].sort((a, b) => a - b); }
// Audit MET-01b (Zusatz, ändert keine bestehenden Felder): Fahrtbeginne und Fahrzeugminuten zusätzlich anteilig auf die Uhrstunden verteilen,
// die das Intervall [at − dt, at] eines Laufs überdeckt (startP, vminP je Gruppe; obsP = so verteilte Beobachtungsminuten je Stunde).
// Grund: alle Zählungen eines Laufs landen sonst in der Stunde seines Endes; eine Stunde bekommt 3 oder 4 Läufe (Sägezahn). Teile vor
// Mitternacht fallen weg – in Zählung und obsP gleich, die Rate bleibt unverzerrt. Grundlage einer Modelländerung nach der Lernphase.
export const P_FIELDS = ['start', 'vmin'];
export function hourShares(at, dt, day, tz = 'Europe/Berlin') {
  const fr = arr(24); if (!(dt > 0)) return fr; const a = at - dt;
  for (let t = Math.floor(a / 3600e3) * 3600e3; t < at; t += 3600e3) { const ov = Math.min(t + 3600e3, at) - Math.max(t, a); if (ov > 0 && dayOf(t + 1, tz) === day) fr[hourOf(t + 1, tz)] += ov / dt; }
  return fr;
}
export function mergeHourly(dayDoc, hourly, { day, at, dt, srcModes, gap = false, tz = 'Europe/Berlin', rule = null }) {
  const doc = dayDoc && dayDoc.day === day ? dayDoc : { day, runs: [], groups: {}, version: TRACK_VERSION };
  doc.runs.push(rule ? [at, dt, gap ? 0 : 1, rule] : [at, dt, gap ? 0 : 1]);
  const rules = [...new Set(doc.runs.map(r => r[3] ?? null))];
  if (rules.length > 1) doc.mixedRules = rules; else delete doc.mixedRules; // Tag mit mehreren Regelständen (null = vor der Kennzeichnung)
  for (const r of doc.runs) if (r[1] != null && r[1] > GAP_MS && r[2] !== 0) r[2] = 0;
  doc.gapHours = gapHoursOf(doc.runs, tz);
  doc.hourMin ??= hourMinutes(day, tz); // Minuten je Ortsstunde (Zeitumstellung: Stunde 2 = 120 bzw. 0)
  for (const [k, h] of hourly) {
    const g = doc.groups[k] || (doc.groups[k] = emptyHourly());
    for (const f of HOUR_FIELDS) { g[f] ??= arr(24); for (let i = 0; i < 24; i++) g[f][i] += h[f][i]; }
    for (const f of HOUR_SUMS) g[f] = (g[f] || 0) + (h[f] || 0); // ältere Tagesdateien ohne die Zensur-Zähler
  }
  if (!gap && dt > 0 && dt <= GAP_MS) {
    const fr = hourShares(at, dt, day, tz), rd = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
    doc.obsP ??= arr(24); for (let i = 0; i < 24; i++) if (fr[i]) doc.obsP[i] = rd(doc.obsP[i] + (fr[i] * dt) / 60e3, 2);
    for (const [k, h] of hourly) { const g = doc.groups[k];
      for (const f of P_FIELDS) { const tot = (h[f] || []).reduce((x, y) => x + (y || 0), 0); if (!tot) continue; const pf = `${f}P`; g[pf] ??= arr(24); for (let i = 0; i < 24; i++) if (fr[i]) g[pf][i] = rd(g[pf][i] + tot * fr[i], f === 'vmin' ? 1 : 3); } }
    doc.pVersion = 1;
  }
  // S1.6: Wechsel des Kennungsmodus je Quelle im Lauf des Tages (Ampel „Moduswechsel heute“); unbekannt zählt nicht als Modus
  const pm = doc.srcModes; if (pm) for (const [src, m] of Object.entries(srcModes || {})) if (pm[src] && pm[src] !== m && pm[src] !== 'unknown' && m !== 'unknown') (doc.modeChanges ??= []).push([at, src, pm[src], m]);
  doc.srcModes = srcModes;
  return doc;
}
// Sprint 1, S1.7: Zwischenstand eines Tages (published.complete = false, Veröffentlichung beim Stundenwechsel) ohne Dauer- und Distanzsummen –
// die Differenz zweier Stundenstände verriete sonst Dauer und Luftlinie einer einzelnen Fahrt – und ohne Kleinstgruppen (bis dahin weniger als
// PUB_MIN_STARTS Fahrtbeginne). Tagessummen sind keine Einzelfahrt: der Tagesend-Stand (complete) behält Dauer und Distanz.
// A20 (beide Stände): jede veröffentlichte Gruppe-Stunde ist 0 oder ≥ PUB_MIN_STARTS (poolSmall); Tagessummen bleiben gleich, was sich keiner
// Stunde zuordnen lässt, steht je Feld in g.rest (Tageswert ohne Stunde; aus Lückenstunden in g.restGap, zählt wie diese nicht zur Messung).
export const PUB_MIN_STARTS = 3, PUB_WITHHELD = ['tripDurSum', 'tripDurN', 'tripDistSum', 'tripDistN'];
export const POOL_FIELDS = ['start', 'end', 'reloc', 'swap', 'pickup', 'disOn', 'disOff', 'rot', 'slow', 'fast', 'hide', 'startP'];
/**
 * A20: Stundenwerte einer Reihe auf 0 oder ≥ min bringen. Kleine Werte (> 0 und < min) wandern innerhalb ihres Tagesabschnitts (BANDS) und
 * derselben Lückenart (gap[h]) vorwärts, bis die Summe min erreicht oder eine Stunde mit ≥ min kommt; ein Rest am Abschnittsende geht in die
 * letzte Stunde ≥ min des Abschnitts, sonst in die zeitlich nächste Stunde ≥ min gleicher Lückenart des Tages, sonst nach rest (restGap).
 * Rückgabe { out, rest, restGap, moved } – Summe(out) + rest + restGap = Summe(arr); moved = verschobene Menge.
 */
export function poolSmall(arr, gap = null, min = PUB_MIN_STARTS) {
  const out = Array.from({ length: 24 }, (_, h) => +arr?.[h] || 0), isGap = (h) => !!gap?.[h], big = (v) => v >= min - 1e-9;
  const r3 = (v) => Math.round(v * 1000) / 1000;
  /** @type {[number, boolean, number][]} */ const left = []; let moved = 0;
  for (const b of BANDS) for (const gp of [false, true]) {
    let acc = 0;
    for (let h = b.from; h < b.to; h++) {
      if (isGap(h) !== gp || !(out[h] > 0)) continue;
      if (big(out[h])) { if (acc > 0) { out[h] = r3(out[h] + acc); acc = 0; } continue; }
      acc = r3(acc + out[h]); moved += out[h]; out[h] = 0;
      if (big(acc)) { out[h] = acc; acc = 0; }
    }
    if (acc > 0) {
      let t = -1; for (let h = b.to - 1; h >= b.from; h--) if (isGap(h) === gp && big(out[h])) { t = h; break; }
      if (t >= 0) out[t] = r3(out[t] + acc); else left.push([b.from, gp, acc]);
    }
  }
  let rest = 0, restGap = 0;
  for (const [h0, gp, v] of left) {
    let t = -1; for (let d = 1; d < 24 && t < 0; d++) for (const h of [h0 - d, h0 + d]) if (h >= 0 && h < 24 && isGap(h) === gp && big(out[h])) { t = h; break; }
    if (t >= 0) out[t] = r3(out[t] + v); else if (gp) restGap = r3(restGap + v); else rest = r3(rest + v);
  }
  return { out, rest, restGap, moved: r3(moved) };
}
export function publicEventsDoc(doc, complete) {
  if (!doc?.groups) return doc;
  const gap = new Array(24).fill(false); for (const h of doc.gapHours || []) if (h >= 0 && h < 24) gap[h] = true;
  const groups = {}; let small = 0, moved = 0, rest = 0;
  for (const [k, g] of Object.entries(doc.groups)) {
    if (!complete && (g.start || []).reduce((a, b) => a + (b || 0), 0) + (g.rest?.start || 0) < PUB_MIN_STARTS) { small++; continue; }
    const o = { ...g }; if (!complete) for (const f of PUB_WITHHELD) delete o[f];
    const rs = { ...(g.rest || {}) }, rg = { ...(g.restGap || {}) }, add = (m, f, v) => { if (v) m[f] = Math.round(((m[f] || 0) + v) * 1000) / 1000; };
    for (const f of POOL_FIELDS) if (Array.isArray(g[f])) { const p = poolSmall(g[f], gap); o[f] = p.out; moved += p.moved; add(rs, f, p.rest); add(rg, f, p.restGap); if (f === 'start') rest += p.rest; }
    if (Object.keys(rs).length) o.rest = rs; else delete o.rest;
    if (Object.keys(rg).length) o.restGap = rg; else delete o.restGap;
    groups[k] = o;
  }
  return { ...doc, groups, withheld: { minStarts: PUB_MIN_STARTS, fields: complete ? [] : PUB_WITHHELD, groups: small, pooled: Math.round(moved), restStarts: rest } };
}
// ---------- Altläufe in Zellendateien (vor der Lückenregel gezählt) ----------
// Die Lückenregel steht in events/ nachträglich (Flag 0, gapHours), Zellen sind dagegen Tagessummen ohne Laufbezug: Ein Lauf nach > 45 Min.,
// der noch gezählt hat (z. B. 01.11.2026 08:25 Uhr, 21.379 Fahrtbeginne in einem Lauf), steckt ganz im Band seiner Stunde. Ältere Zellendateien
// (ohne taintChecked) werden einmalig repariert: jedes Band mit einem Lauf > 45 Min. (laut events/<Tag>.json → runs) fällt für diesen Tag aus
// (Starts, Enden, Präsenz und Messminuten des Bands auf 0, bandTainted[b] = 1). Umsetzungen (Feld 3) haben keine Bandaufteilung und bleiben
// (relocUnrepaired). Neue Dateien zählen Lücken-Läufe nicht und brauchen keine Reparatur.
export const CELLS_TAINT_VERSION = 1;
/** Bänder mit einem Lauf nach Lücke (dt > 45 Min.); exclude = Zeitpunkt des laufenden Laufs (zählt ohnehin nicht) */
export function taintedBands(runs, { tz = 'Europe/Berlin', exclude = null } = {}) {
  const out = new Set();
  for (const r of runs || []) if (Array.isArray(r) && Number.isFinite(r[0]) && r[0] !== exclude && r[1] != null && r[1] > GAP_MS) out.add(bandOf(hourOf(r[0], tz)));
  return [...out].sort((a, b) => a - b);
}
/** Band b in { ags: { zelle: [...] } } neutralisieren (Summenfelder um den Bandanteil verringern) */
function neutralizeBand(munis, b) {
  for (const cells of Object.values(munis || {})) for (const c of Object.values(cells || {})) {
    if (!Array.isArray(c) || c.length < CELL_LEN) continue;
    c[0] = Math.max(0, (c[0] || 0) - (c[4 + b] || 0)); c[2] = Math.max(0, (c[2] || 0) - (c[10 + b] || 0)); c[1] = Math.max(0, (c[1] || 0) - (c[16 + b] || 0));
    c[4 + b] = 0; c[10 + b] = 0; c[16 + b] = 0;
  }
}
/**
 * Zellendatei (Tagesdatei { states: { Land: { ags: … } } } oder Landesdatei { munis: { ags: … } }) einmalig reparieren. runs = events/<Tag>.json → runs.
 * Rückgabe { doc, bands } (bands = neutralisierte Bänder; leer, wenn schon geprüft).
 */
export function repairCells(doc, runs, { tz = 'Europe/Berlin', exclude = null } = {}) {
  if (!doc || doc.taintChecked) return { doc, bands: [] };
  const bands = taintedBands(runs, { tz, exclude });
  const z = () => new Array(BANDS.length).fill(0);
  doc.bandMin ??= z(); doc.bandRuns ??= z(); doc.bandTainted ??= z();
  for (const b of bands) { for (const m of doc.states ? Object.values(doc.states) : [doc.munis]) neutralizeBand(m, b); doc.bandMin[b] = 0; doc.bandRuns[b] = 0; doc.bandTainted[b] = 1; }
  if (bands.length) doc.relocUnrepaired = true;
  doc.taintChecked = CELLS_TAINT_VERSION;
  return { doc, bands };
}
// ---------- Veröffentlichung der Zellen (M-11) ----------
// Eine je Lauf fortgeschriebene Zellendatei zeigt im Vergleich zweier Stände Start- und Zielzelle einzelner Fahrten. Daher: laufender Tag nur mit
// abgeschlossenen Tageszeit-Bändern (der Sammler veröffentlicht den privaten Arbeitsstand beim Bandwechsel), und in jeder veröffentlichten Datei
// Zelle × Band mit weniger als CELL_MIN Ereignissen (Beginne + Enden) unterdrückt; die unterdrückten Summen stehen je Gemeinde in below.
export const CELL_MIN = 3;
/**
 * Landesteil { ags: { zelle: [...] } } für die Veröffentlichung: Rückgabe { munis, below: { ags: [start×6, end×6] } } (neue Objekte, Eingabe bleibt).
 * Präsenz (Felder 2, 10–15) und Umsetzungen (Feld 3) bleiben; Feld 0/1 = Summe der veröffentlichten Bänder. Zellen ohne Werte entfallen.
 * Ältere Zellen ohne Bandfelder bzw. Anteile ohne Bandangabe: unter min → below als Summe ohne Band (Index 12/13).
 */
export function suppressCells(munis, { min = CELL_MIN } = {}) {
  const out = {}, below = {};
  const B = (ags) => (below[ags] ??= new Array(2 * BANDS.length + 2).fill(0));
  for (const [ags, cells] of Object.entries(munis || {})) {
    const m = {};
    for (const [cell, c0] of Object.entries(cells || {})) {
      if (!Array.isArray(c0)) continue;
      const c = c0.slice();
      if (c.length < CELL_LEN) { const n = (c[0] || 0) + (c[1] || 0); if (n > 0 && n < min) { const b = B(ags); b[12] += c[0] || 0; b[13] += c[1] || 0; c[0] = 0; c[1] = 0; } }
      else {
        // Anteil ohne Bandangabe (Läufe vor Einführung der Bandfelder): wie ein eigenes Band behandeln
        let b0 = 0, b1 = 0; for (let k = 0; k < BANDS.length; k++) { b0 += c[4 + k] || 0; b1 += c[16 + k] || 0; }
        let r0 = Math.max(0, (c[0] || 0) - b0), r1 = Math.max(0, (c[1] || 0) - b1);
        if (r0 + r1 > 0 && r0 + r1 < min) { const b = B(ags); b[12] += r0; b[13] += r1; r0 = 0; r1 = 0; }
        for (let k = 0; k < BANDS.length; k++) { const st = c[4 + k] || 0, en = c[16 + k] || 0; if (st + en > 0 && st + en < min) { const b = B(ags); b[k] += st; b[6 + k] += en; c[4 + k] = 0; c[16 + k] = 0; } }
        let s0 = r0, s1 = r1; for (let k = 0; k < BANDS.length; k++) { s0 += c[4 + k] || 0; s1 += c[16 + k] || 0; } c[0] = s0; c[1] = s1;
      }
      if (c.some(x => x)) m[cell] = c;
    }
    if (Object.keys(m).length) out[ags] = m;
  }
  secondarySuppress(out, below, { min });
  return { munis: out, below };
}
// Sekundärunterdrückung (ab 6.11.2026, SUPPRESS_VERSION 2): Liegt in Gemeinde × Band weniger als min in below, kann es eine einzelne Zelle sein –
// below nennte dann ihren Wert genau. Dann fällt zusätzlich die kleinste veröffentlichte Zelle dieses Bands in below (below ≥ min, aus ≥ 2 Zellen).
// Arbeitet auf veröffentlichten Daten (auch nachträglich für ältere Dateien): below < min heißt höchstens eine unterdrückte Zelle oder zwei mit je 1.
export const SUPPRESS_VERSION = 2;
export function secondarySuppress(munis, below, { min = CELL_MIN } = {}) {
  let n = 0;
  for (const [ags, b] of Object.entries(below || {})) {
    const m = munis?.[ags]; if (!m) continue;
    for (let k = 0; k < BANDS.length; k++) {
      const s = (b[k] || 0) + (b[6 + k] || 0); if (!(s > 0 && s < min)) continue;
      let best = null, bn = Infinity;
      for (const [cell, c] of Object.entries(m)) { const x = (c[4 + k] || 0) + (c[16 + k] || 0); if (x > 0 && (x < bn || (x === bn && cell < best))) { bn = x; best = cell; } }
      if (!best) continue;
      const c = m[best], st = c[4 + k] || 0, en = c[16 + k] || 0;
      b[k] += st; b[6 + k] += en; c[0] = Math.max(0, (c[0] || 0) - st); c[1] = Math.max(0, (c[1] || 0) - en); c[4 + k] = 0; c[16 + k] = 0; n++;
      if (!c.some(x => x)) delete m[best];
    }
    if (!Object.keys(m).length) delete munis[ags];
  }
  return n;
}
// Zellen je Bundesland: { ags: { cell: [start,end,present,reloc] } }
// runs/at: Läufe des Tages aus events/<Tag>.json und Zeitpunkt dieses Laufs – ältere Dateien werden damit einmalig repariert (repairCells)
export function mergeCells(doc, cells, munis, day, { dt = null, hour = null, gap = false, runs = null, at = null } = {}) {
  const fresh = !(doc && doc.day === day);
  const out = fresh ? { day, version: TRACK_VERSION, states: {}, taintChecked: CELLS_TAINT_VERSION } : doc;
  if (!fresh && !out.taintChecked && runs) repairCells(out, runs, { exclude: at });
  out.bandMin ??= new Array(BANDS.length).fill(0); out.bandRuns ??= new Array(BANDS.length).fill(0);
  if (hour != null && !gap) { const b = bandOf(hour); out.bandRuns[b]++; if (dt != null) out.bandMin[b] += Math.min(dt, GAP_MS) / 60e3; }
  for (const [ags, m] of cells) {
    const st = munis[ags]?.state || 'XX';
    const sdoc = (out.states[st] ??= {});
    const a = (sdoc[ags] ??= {});
    for (const [cell, v] of m) { const c = a[cell] || (a[cell] = new Array(CELL_LEN).fill(0)); while (c.length < CELL_LEN) c.push(0); for (let i = 0; i < CELL_LEN; i++) c[i] += v[i] || 0; }
  }
  return out;
}
// ---------- Start-Ziel-Ströme: Tagessumme (privat) und veröffentlichte Tagesdatei ----------
// Rohsummen liegen nur neben dem Verfolgungszustand (TRACK_DIR, nicht im Datenzweig). Veröffentlicht wird ein Tag erst, wenn er vorbei ist:
// eine je Lauf fortgeschriebene Datei würde im Vergleich zweier Stände einzelne Fahrten (Zellenpaar, 20-Min.-Fenster) zeigen.
export const FLOW_VERSION = 1;
// je Tag und Zellenpaar mindestens 5 Fahrten in jeder veröffentlichten Zeile (bis 6.11.2026: 2). Die Paare stammen aus stabilen Kennungen, also aus
// echten Fahrten; bei 2 lagen am 5.11.2026 88 % der Zeilen genau auf der Schwelle. 5 ist die übliche Schwelle für Fahrtdaten (k = 5).
export const FLOW_MIN = 5;
export const FLOW_TOP = 300; // je Gemeinde höchstens so viele Zeilen (nach Anzahl), Rest als „außerhalb Top“
export const FLOW_FIELDS = ['gemeinde', 'von', 'nach', 'anbieter', 'art', 'band', 'anzahl', 'dauer_s', 'luftlinie_m'];
/** Gemeinde → Anbieter mit stabilen Kennungen (aus srcModes und den Quellen-Datensätzen {id, operator, municipalities}) */
export function stableOps(srcModes, sources) {
  const out = {};
  for (const r of sources || []) { if (srcModes?.[r.id] !== 'stable') continue; for (const ags of r.municipalities || []) { const a = (out[ags] ??= []); if (!a.includes(r.operator)) a.push(r.operator); } }
  for (const a of Object.values(out)) a.sort();
  return out;
}
/** Tagessumme fortschreiben: { version, day, runs, rows: { 'ags|op|type|band': { 'von>nach': [anzahl, dauerMs, luftlinieM] } }, stable: { ags: [op] } }; neuer Tag = neue Summe */
export function mergeFlows(raw, flows, { day = undefined, gap = false, stable = null } = {}) {
  const doc = raw && raw.day === day && raw.version === FLOW_VERSION ? raw : { version: FLOW_VERSION, day, runs: 0, rows: {}, stable: {} };
  if (!gap) doc.runs++;
  for (const [k, m] of flows || []) { const r = (doc.rows[k] ??= {}); for (const [p, f] of m) { const a = (r[p] ??= [0, 0, 0]); a[0] += f.count; a[1] += f.durSum; a[2] += f.distSum; } }
  for (const [ags, ops] of Object.entries(stable || {})) { const a = (doc.stable[ags] ??= []); for (const op of ops) if (!a.includes(op)) a.push(op); a.sort(); }
  return doc;
}
// Zusammenfassung je Zellenpaar, von fein nach grob: [Anbieter, Art, Band] behalten (1) oder zusammenfassen (0).
// Jede Stufe nimmt nur, was die feinere übrig ließ; Zeilen sind überschneidungsfrei, jede mit ≥ min Fahrten. Was auch grob unter min bleibt: „unter Mindestschwelle“.
const FLOW_LEVELS = [[1, 1, 1], [1, 1, 0], [0, 1, 1], [0, 1, 0], [0, 0, 0]];
/**
 * Veröffentlichte Tagesdatei aus der Tagessumme. flows-Zeilen nach FLOW_FIELDS: [ags(Start), von, nach (Zellen wie cellOf), anbieter|null, art|null, band|null,
 * anzahl, dauer_s (Summe), luftlinie_m (Summe)]; null = über mehrere zusammengefasst (einzeln unter der Mindestschwelle).
 * munis[ags] = { trips, shown, below, cut, ops: {Anbieter: Fahrten} }: trips = shown + below + cut.
 */
// minSupport (geschätzte Ströme, A10): eine Zeile braucht zusätzlich so viele beitragende Fahrtbeginne (a[3]); gemessene Zeilen haben kein a[3]
export function publishFlows(raw, { min = FLOW_MIN, top = FLOW_TOP, at = null, minSupport = 0 } = {}) {
  const pairs = new Map(), munis = {};
  const M = (ags) => (munis[ags] ??= { trips: 0, shown: 0, below: 0, cut: 0, ops: {} });
  for (const [k, r] of Object.entries(raw?.rows || {})) {
    const [ags, op, ty, b] = k.split('|');
    for (const [p, a] of Object.entries(r)) {
      if (!(a[0] > 0)) continue;
      const pk = `${ags}|${p}`; if (!pairs.has(pk)) pairs.set(pk, []);
      pairs.get(pk).push({ op, ty, band: +b, n: a[0], dur: a[1], dist: a[2], sup: a[3] ?? Infinity });
      const m = M(ags); m.trips += a[0]; m.ops[op] = (m.ops[op] || 0) + a[0];
    }
  }
  const byAgs = new Map();
  for (const [pk, units] of pairs) {
    const i = pk.indexOf('|'), ags = pk.slice(0, i), [from, to] = pk.slice(i + 1).split('>');
    let rest = units;
    for (const [kOp, kTy, kBand] of FLOW_LEVELS) {
      if (!rest.length) break;
      const g = new Map();
      for (const u of rest) { const gk = `${kOp ? u.op : ''}\u0000${kTy ? u.ty : ''}\u0000${kBand ? u.band : ''}`; if (!g.has(gk)) g.set(gk, []); g.get(gk).push(u); }
      rest = [];
      for (const list of g.values()) {
        const n = list.reduce((s, u) => s + u.n, 0);
        if (n < min || (minSupport > 0 && list.reduce((s, u) => s + u.sup, 0) < minSupport)) { rest.push(...list); continue; }
        const u0 = list[0];
        const row = [ags, from, to, kOp ? u0.op : null, kTy ? u0.ty : null, kBand ? u0.band : null, n, Math.round(list.reduce((s, u) => s + u.dur, 0) / 1000), Math.round(list.reduce((s, u) => s + u.dist, 0))];
        if (!byAgs.has(ags)) byAgs.set(ags, []); byAgs.get(ags).push(row);
      }
    }
    M(ags).below += rest.reduce((s, u) => s + u.n, 0);
  }
  const flows = [];
  for (const [ags, rows] of [...byAgs].sort((a, b) => a[0].localeCompare(b[0]))) {
    rows.sort((a, b) => b[6] - a[6] || b[8] - a[8] || `${a[1]}>${a[2]}`.localeCompare(`${b[1]}>${b[2]}`) || String(a[3]).localeCompare(String(b[3])) || String(a[4]).localeCompare(String(b[4])) || (a[5] ?? 9) - (b[5] ?? 9));
    const keep = rows.slice(0, top); flows.push(...keep);
    M(ags).shown = keep.reduce((s, r) => s + r[6], 0); M(ags).cut = rows.slice(top).reduce((s, r) => s + r[6], 0);
  }
  const total = { trips: 0, shown: 0, below: 0, cut: 0 };
  for (const m of Object.values(munis)) for (const f of Object.keys(total)) total[f] += m[f];
  return { version: FLOW_VERSION, day: raw?.day ?? null, at, runs: raw?.runs ?? 0, min, top, cell: [CELL_LAT, CELL_LON], bands: BANDS.map(({ label, from, to }) => ({ label, from, to })), fields: FLOW_FIELDS, flows, munis, stable: raw?.stable || {}, total };
}
/**
 * Bereits veröffentlichte Tagesdatei (flows/<Tag>.json) auf eine höhere Mindestschwelle bringen: Zeilen unter min entfallen, ihre Fahrten zählen
 * je Gemeinde zu below (Zeilen sind überschneidungsfrei, es entsteht keine Differenz, die eine einzelne Zeile verrät). Gibt true zurück, wenn geändert.
 */
export function tightenFlows(doc, min = FLOW_MIN) {
  if (!doc || !Array.isArray(doc.flows) || !(doc.min < min)) return false;
  const keep = [];
  for (const r of doc.flows) {
    if (r[6] >= min) { keep.push(r); continue; }
    const m = doc.munis?.[r[0]]; if (m) { m.shown -= r[6]; m.below += r[6]; }
  }
  const r1 = (x) => Math.round(x * 10) / 10;
  for (const m of Object.values(doc.munis || {})) { m.shown = r1(m.shown); m.below = r1(m.below); }
  doc.flows = keep; doc.min = min;
  doc.total = { trips: 0, shown: 0, below: 0, cut: 0 };
  for (const m of Object.values(doc.munis || {})) for (const f of Object.keys(doc.total)) doc.total[f] += m[f] || 0;
  for (const f of Object.keys(doc.total)) doc.total[f] = r1(doc.total[f]);
  return true;
}
// ---------- Wochenströme (A10, seit 13.11.2026) ----------
// Tagesdateien (250 m, ≥ 5 Fahrten je Tag) zeigten 0–2,4 % der gemessenen Fahrten (1.–12.11.2026). Dazu: Kalenderwoche Mo–So auf 500-m-Zellen,
// dieselbe Schwelle FLOW_MIN je Zeile, veröffentlicht einmal nach Wochenende (keine gleitende Woche: zwei überlappende Summen ergäben im Vergleich
// die Fahrten einzelner Tage). Privat (TRACK_DIR) liegen die vergröberten Tagessummen der letzten WEEK_KEEP Tage.
export const WEEK_FACTOR = 2, WEEK_KEEP = 14;
export const coarseCell = (cell, f = WEEK_FACTOR) => { if (f === 1) return cell; const [a, b] = cell.split(':').map(Number); return `${Math.round(a / f)}:${Math.round(b / f)}`; };
/** Montag der Kalenderwoche (UTC-Datum 'YYYY-MM-DD') */
export const weekStart = (day) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
const addDays = (day, n) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
/** Tagessumme (mergeFlows) vergröbert in den privaten Wochenspeicher { version, days: { Tag: { runs, rows, stable } } } übernehmen */
export function mergeWeekFlows(store, dayRaw, { f = WEEK_FACTOR, keep = WEEK_KEEP } = {}) {
  const doc = store?.version === FLOW_VERSION && store.days ? store : { version: FLOW_VERSION, f, days: {} };
  if (dayRaw?.day) {
    const rows = {};
    for (const [k, r] of Object.entries(dayRaw.rows || {})) {
      const out = (rows[k] ??= {});
      for (const [p, a] of Object.entries(r)) { const [x, y] = p.split('>'); const q = `${coarseCell(x, f)}>${coarseCell(y, f)}`; const b = (out[q] ??= [0, 0, 0]); b[0] += a[0]; b[1] += a[1]; b[2] += a[2]; }
    }
    doc.days[dayRaw.day] = { runs: dayRaw.runs || 0, rows, stable: dayRaw.stable || {} };
  }
  for (const d of Object.keys(doc.days).sort().slice(0, -keep)) delete doc.days[d];
  return doc;
}
/** Veröffentlichte Wochendatei flows-week/<Montag>.json: Summe Mo–So, Zeilen wie flows/<Tag>.json (Zellen 500 m), week = { from, to, days, complete } */
export function publishWeekFlows(store, monday, { min = FLOW_MIN, top = FLOW_TOP, at = null } = {}) {
  const f = store?.f || WEEK_FACTOR, days = [], rows = {}, stable = {}; let runs = 0;
  for (let i = 0; i < 7; i++) {
    const day = addDays(monday, i), d = store?.days?.[day]; if (!d) continue;
    days.push(day); runs += d.runs || 0;
    for (const [k, r] of Object.entries(d.rows || {})) { const out = (rows[k] ??= {}); for (const [p, a] of Object.entries(r)) { const b = (out[p] ??= [0, 0, 0]); b[0] += a[0]; b[1] += a[1]; b[2] += a[2]; } }
    for (const [ags, ops] of Object.entries(d.stable || {})) { const a = (stable[ags] ??= []); for (const op of ops) if (!a.includes(op)) a.push(op); a.sort(); }
  }
  const doc = publishFlows({ day: monday, runs, rows, stable }, { min, top, at });
  return { ...doc, cell: [CELL_LAT * f, CELL_LON * f], factor: f, week: { from: monday, to: addDays(monday, 6), days, complete: days.length === 7 } };
}
export function stationQuota(state) {
  const out = [];
  for (const e of Object.values(state.s)) {
    let runs = 0, empty = 0, full = 0; for (const d of Object.values(e.d)) { runs += d[0]; empty += d[1]; full += d[2]; }
    if (!runs) continue;
    out.push([state.dict.ags[e.ags], state.dict.op[e.op], e.name, e.lat, e.lon, runs, empty, full, e.vs ? 1 : 0]); // letzte Spalte: virtuell (1) / Dock (0)
  }
  return out;
}
export function reliability(state) {
  const out = {};
  for (const [id, e] of Object.entries(state.rel)) { let runs = 0, live = 0, delayed = 0, stale = 0, err = 0, lat = 0; for (const d of Object.values(e)) { runs += d[0]; live += d[1]; delayed += d[2]; stale += d[3]; err += d[4]; lat += d[5]; } out[id] = { runs, live, delayed, stale, err, latencyAvg: runs ? Math.round(lat / runs) : null, days: Object.keys(e).length }; }
  return out;
}
