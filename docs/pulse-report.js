// Mobility Pulse — Kommunal-Bericht, Obergrenzen-Wächter, Wochen-Heatmap, Preis-Log und Feed-Prüfung.
// Reine Rechenfunktionen ohne DOM (Browser und Node). Grundlage: events/<Tag>.json (Stundenwerte, Läufe),
// history/<Tag>.json (Bestand je Lauf), cells/<Tag>/<Land>.json (Zellen), latest.json, reference.json.
import { GAP_MS, CELL_LAT, CELL_LON, CELL_MIN } from './pulse-track.js?v=mwcktwks';
import { DEFAULT_PROFILE, DEFAULTS } from './pulse-econ.js?v=mwcktwks';
import { hourMinutes, TYPE_RANGE_LOW_KM } from './pulse-core.js?v=mwcktwks';
export { CELL_LAT, CELL_LON };

export const TZ = 'Europe/Berlin';
export const MIN_FULL_DAYS = 3;                    // darunter ist der Bericht „vorläufig“
export const FULL_HOUR_MIN = 50, FULL_DAY_HOURS = 20; // voller Messtag: ≥ 20 Stunden mit ≥ 50 beobachteten Minuten (wie hourProfile)
export const HEAT_MIN_OBS = 30;                    // Heatmap: Stunde gilt ab 30 beobachteten Minuten als gemessen
export const NEAR_CAP = 0.9;                       // Obergrenze: ab 90 % „nahe“
export const WEAK_MIN_PRESENT = 2;
export const MIN_TRIPS_MEASURED = DEFAULTS.minTripsMeasured; // Ø Dauer/Distanz erst ab so vielen Messungen                 // schwache Orte: im Mittel mindestens 2 verfügbare Fahrzeuge je Lauf
export const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
export const WEEKDAYS_LONG = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];

const sum = (a) => (a || []).reduce((x, y) => x + (y || 0), 0);
const zeros = (n) => new Array(n).fill(0);
const hourFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: TZ });
export const hourOfMs = (ms) => +hourFmt.format(new Date(ms)) % 24;
/** Wochentag eines Kalendertags 'YYYY-MM-DD', 0 = Montag … 6 = Sonntag */
export const weekdayOf = (day) => (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7;
// Minuten je Ortsstunde eines Tages (Zeitumstellung: Stunde 2 = 120 bzw. 0 Min.): aus dem Tagesdokument, sonst gerechnet (M-20)
const HM = new Map();
export const hourMinOf = (doc) => (Array.isArray(doc?.hourMin) && doc.hourMin.length === 24 ? doc.hourMin : doc?.day ? (HM.get(doc.day) || HM.set(doc.day, hourMinutes(doc.day, TZ)).get(doc.day)) : new Array(24).fill(60));
/** Mitternacht eines Kalendertags 'YYYY-MM-DD' in Europe/Berlin als UTC-Millisekunden (Winter +01:00, Sommer +02:00) */
const DAY_FMT_MID = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
export function berlinMidnight(day) {
  const g = Date.parse(`${day}T00:00:00Z`); if (!Number.isFinite(g)) return null;
  for (const off of [1, 2, 0]) { const t = g - off * 3600e3; if (hourOfMs(t) === 0 && DAY_FMT_MID.format(new Date(t)) === day) return t; }
  return g - 3600e3;
}
export const dayLabel = (day) => (day ? `${day.slice(8, 10)}.${day.slice(5, 7)}.${day.slice(0, 4)}` : '–');

// ---------- Läufe und Lücken ----------
/**
 * Lauf nach einer Lücke: Flag 0 (Sammler zählt nichts: Abstand > 45 Min. oder Lauf ohne Zählung) oder Abstand zum vorigen
 * Lauf über 45 Min. (ältere Tagesdateien ohne Flag haben die Ereignisse solcher Läufe mitgezählt, siehe isTaintedRun).
 * Ein Lauf ist [at, dt, flag?] (events/<Tag>.json → runs).
 */
export function isGapRun(r) {
  if (!Array.isArray(r)) return false;
  if (r[2] === 0) return true;
  return r[1] != null && r[1] > GAP_MS;
}
/** Lücken-Lauf, dessen Ereignisse trotzdem in den Stundenwerten stecken (kein Flag 0): Stunde ganz verwerfen */
export const isTaintedRun = (r) => isGapRun(r) && r[2] !== 0;

// ---------- Regelstand (Datenvertrag 1/2) ----------
/** Regelstand eines Laufs: METHOD_VERSION-Teil von runs[k][3] („2026-11-01b@1cf42c8“ → „2026-11-01b“); null für ältere Läufe ohne Angabe */
export const ruleOf = (r) => { const s = Array.isArray(r) ? r[3] : null; return typeof s === 'string' && s ? s.split('@')[0] : null; };
// Regelwechsel aus der Zeit vor der Angabe je Lauf (runs[k][3] erst ab 02.11.2026 07:17): Läufe ab `at` zählen nach einem anderen Stand.
// 01.11.2026: Lime-Versatz ohne Ladestandverlust ab dem Umzugslauf 14:13 als GPS-Sprung (slow) statt Umsetzung (reloc), Tausch erst danach.
export const UNTAGGED_RULE_CHANGES = [{ at: Date.parse('2026-11-01T13:00:00Z'), id: 'ohne Angabe ab 01.11.2026 14:13' }];
/** Regelstand für Vergleiche: ruleOf, sonst der Abschnitt vor der Angabe (unterscheidet den Wechsel am 01.11. ohne Kennzeichnung) */
export const ruleEra = (r) => ruleOf(r) ?? (UNTAGGED_RULE_CHANGES.filter(c => Array.isArray(r) && r[0] >= c.at).pop()?.id || 'ohne Angabe');
/** Gezählter Lauf (Beobachtungsfenster ohne Lücke) – nur diese bestimmen Regelstand und Regelstand-Tage */
const countedRun = (r) => Array.isArray(r) && Number.isFinite(r[0]) && r[1] != null && !isGapRun(r);
/** Regelstand eines Tagesdokuments: ruleOf aller gezählten Läufe, wenn einheitlich; sonst null (gemischt, alt oder ohne Lauf) */
export function docRule(doc) { const rs = new Set((doc?.runs || []).filter(countedRun).map(ruleOf)); return rs.size === 1 ? [...rs][0] : null; }
// Bruchmarken (history/daily.json → breaks, Z2): springt der Bestand einer Reihe Gemeinde|Anbieter|Art im ersten Lauf mit neuem Regelstand um
// mindestens BREAK_JUMP (und BREAK_MIN Fahrzeuge) gegenüber dem letzten Lauf mit altem, gilt die Reihe ab dem Tag dieses Laufs als neu gezählt.
export const BREAK_JUMP = 0.1, BREAK_MIN = 5;
/**
 * Bruchmarken aus Regelwechseln. runs: [[at, regelstand?], …] (runs.json at/regelstand, der laufende Lauf mit RULE); hists: history/<Tag>.json
 * der betroffenen Tage ({ day, t, series }); since: nur Wechsel nach diesem Zeitpunkt (null = alle, rückwirkend). Rückgabe { Schlüssel: Tag }.
 */
export function ruleBreaks(runs, hists, { since = null, minJump = BREAK_JUMP, minAbs = BREAK_MIN } = {}) {
  const rs = (runs || []).filter(r => Array.isArray(r) && Number.isFinite(r[0])).sort((a, b) => a[0] - b[0]);
  const era = rs.map(r => ruleEra([r[0], null, null, r[1]]));
  const at = new Map(); for (const h of hists || []) (h?.t || []).forEach((t, j) => at.set(t, { h, j }));
  const val = (i, k) => { const e = at.get(rs[i]?.[0]); const v = e?.h.series?.[k]?.total?.[e.j]; return v == null ? null : v; };
  const out = {};
  for (let i = 1; i < rs.length; i++) {
    if (era[i] === era[i - 1] || (since != null && rs[i][0] <= since)) continue;
    const cur = at.get(rs[i][0]); if (!cur) continue;
    const keys = new Set([...Object.keys(cur.h.series || {}), ...Object.keys(at.get(rs[i - 1][0])?.h.series || {})]);
    for (const k of keys) {
      let o = null; for (let p = i - 1; p >= 0 && era[p] === era[i - 1] && o == null; p--) o = val(p, k); // letzter Lauf mit altem Stand und Wert
      const n = val(i, k);
      if (o > 0 && n != null && Math.abs(n - o) >= minAbs && Math.abs(n - o) / o >= minJump) out[k] = cur.h.day;
    }
  }
  return out;
}

/**
 * Beobachtung je Stunde eines Tages. Ein Lauf deckt das Fenster seit dem vorigen ab (höchstens 45 Min.) und zählt in der
 * Stunde seines Zeitpunkts – genau dort verbucht der Sammler auch die Ereignisse.
 * ok[h]: Stunde beobachtet und ohne Lücken-Lauf. Stunden mit Lücken-Lauf zählen in Bericht und Heatmap nicht.
 * gapHours: Stunden, die der Sammler selbst als gestört führt (events/<Tag>.json → gapHours), werden ebenso ausgenommen.
 */
export function hourQuality(runs, gapHours = []) {
  const obs = zeros(24), n = zeros(24), gap = new Array(24).fill(false);
  const gaps = []; let counted = 0, tainted = 0;
  for (const r of runs || []) {
    if (!Array.isArray(r) || !Number.isFinite(r[0])) continue;
    const h = hourOfMs(r[0]);
    if (isGapRun(r)) {
      gap[h] = true;
      if (isTaintedRun(r)) tainted++;
      gaps.push({ at: r[0], from: Number.isFinite(r[1]) ? r[0] - r[1] : null, ms: Number.isFinite(r[1]) ? r[1] : null, tainted: isTaintedRun(r), hour: h });
      continue;
    }
    if (r[1] == null) continue; // erster Lauf: kein Beobachtungsfenster
    obs[h] += Math.min(r[1], GAP_MS) / 60e3; n[h]++; counted++;
  }
  for (const h of gapHours || []) if (Number.isInteger(h) && h >= 0 && h < 24) gap[h] = true;
  const ok = obs.map((m, h) => m > 0 && !gap[h]);
  const obsOk = obs.map((m, h) => (ok[h] ? m : 0));
  const fullHours = obsOk.filter(m => m >= FULL_HOUR_MIN).length;
  return { obs, obsOk, ok, gap, n, gaps, counted, tainted, runs: (runs || []).length, fullHours, full: fullHours >= FULL_DAY_HOURS, obsMin: sum(obsOk), excludedHours: gap.filter(Boolean).length };
}

/** Schlüsselfilter Gemeinde|Anbieter|Art; ags 'DE' = alle Gemeinden (ohne die Bundessummen) */
export function keyFilter({ ags = 'DE', operator = 'all', type = 'all' } = {}) {
  return (k) => {
    const [a, op, ty] = String(k).split('|');
    if (!a || a === 'DE') return false;
    if (ags !== 'DE' && a !== ags) return false;
    if (operator !== 'all' && op !== operator) return false;
    if (type !== 'all' && ty !== type) return false;
    return true;
  };
}

// ---------- Heatmap Stunde × Wochentag ----------
/**
 * Fahrtbeginne je Stunde und Wochentag, gemittelt über die beobachteten Tage.
 * Je Tag und Stunde: gemessen, wenn ≥ HEAT_MIN_OBS Minuten beobachtet und kein Lücken-Lauf; Wert auf 60 Min. bezogen.
 * Rückgabe: cells[wd][h] = { mean, n, gapDays, dates }, days[wd] = Anzahl Tagesdateien je Wochentag, max.
 */
// field: 'start' (Fahrtbeginne, Standard) oder 'end' (Fahrtenden) – Umschalter Start/Ziel wie in Portland
export function weekHeatmap(docs, keep = () => true, { minObs = HEAT_MIN_OBS, field = 'start' } = {}) {
  const cells = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ sum: 0, raw: 0, n: 0, gapDays: 0, thinDays: 0, dates: [], mean: null })));
  const days = zeros(7), dayList = Array.from({ length: 7 }, () => []);
  for (const doc of docs || []) {
    if (!doc?.day) continue;
    const wd = weekdayOf(doc.day); days[wd]++; dayList[wd].push(doc.day);
    const hq = hourQuality(doc.runs, doc.gapHours), hm = hourMinOf(doc);
    const starts = zeros(24);
    for (const [k, g] of Object.entries(doc.groups || {})) if (keep(k)) for (let h = 0; h < 24; h++) starts[h] += g[field]?.[h] || 0;
    for (let h = 0; h < 24; h++) {
      const c = cells[wd][h];
      if (hq.gap[h]) { c.gapDays++; continue; }
      if (hq.obs[h] < minObs) { if (hq.obs[h] > 0) c.thinDays++; continue; }
      c.sum += starts[h] * 60 / Math.min(hm[h] || 60, hq.obs[h]); c.raw += starts[h]; c.n++; c.dates.push(doc.day); // je 60 Min.; Stunde 2 am Umstellungstag hat 120
    }
  }
  let max = 0, measured = 0;
  for (const row of cells) for (const c of row) { if (c.n) { c.mean = c.sum / c.n; measured++; if (c.mean > max) max = c.mean; } }
  return { cells, days, dayList, max, measured, field };
}

// ---------- Kommunal-Bericht ----------
/** Tagesgang (Anteil je Stunde) aus vollen Messtagen; unter MIN_FULL_DAYS die Standardkurve der Umsatzschätzung */
export function measuredProfile(docs) {
  const w = zeros(24), n = zeros(24); let days = 0;
  for (const d of docs || []) {
    if (!d) continue; const hq = hourQuality(d.runs, d.gapHours); if (!hq.full) continue; days++; const hm = hourMinOf(d);
    const starts = zeros(24); for (const g of Object.values(d.groups || {})) for (let h = 0; h < 24; h++) starts[h] += g.start?.[h] || 0;
    for (let h = 0; h < 24; h++) if (hq.obsOk[h] >= FULL_HOUR_MIN) { w[h] += starts[h] / (Math.min(hm[h] || 60, hq.obsOk[h]) / 60); n[h]++; }
  }
  if (days < MIN_FULL_DAYS) return { profile: DEFAULT_PROFILE, source: 'Standardkurve', days };
  const rate = w.map((x, h) => (n[h] ? x / n[h] : 0)); const s = sum(rate);
  return s > 0 ? { profile: rate.map(x => x / s), source: `gemessen (${days} volle Tage)`, days } : { profile: DEFAULT_PROFILE, source: 'Standardkurve', days };
}
/** Anteil des Tagesgangs, der an einem Tag beobachtet wurde (nur Stunden ohne Lücken-Lauf) */
// hourMin: Minuten je Ortsstunde (Umstellungstag: Stunde 2 deckt bis zu 2 Stunden des Tagesgangs ab, wie pulse-econ kpis)
export const dayCoverage = (hq, profile = DEFAULT_PROFILE, hourMin = null) => profile.reduce((a, p, h) => a + p * Math.min((hourMin?.[h] ?? 60) / 60, (hq.obsOk[h] || 0) / 60), 0);
// Fahrzeugminuten nur, wenn jeder Lauf mit Fenster sie gezählt hat (Flag 0/1 vorhanden); sonst Ø Bestand aus dem Verlauf
const vminCounted = (runs) => (runs || []).every(r => r[1] == null || r[2] === 1 || r[2] === 0);

// Präsenz: Anteil der zählenden Läufe des Tages, in denen die Gruppe einen Wert hat. Unter MIN_PRESENCE (z. B. „Gebündelte“ aus dem
// konflationierten MOBIDROM-Feed in 1 von 16 Läufen) ist die Gruppe unvollständig: ihr Mittel über die Läufe mit Wert wäre eine volle
// Tagesflotte – sie zählt dann weder als Flotte noch in der Sperrquote (incomplete). Fehlende Werte sonst = Ausfall (kein Nullbestand).
export const MIN_PRESENCE = 0.5;
function histStats(hist, key, { minPresence = MIN_PRESENCE } = {}) {
  const ser = hist?.series?.[key]; if (!ser?.total) return null;
  const f = hist.f || [];
  let n = 0, total = 0, disabled = 0, available = 0, counted = 0;
  for (let i = 0; i < ser.total.length; i++) {
    if (f[i] === 0) continue; counted++;
    if (ser.total[i] == null) continue;
    n++; total += ser.total[i]; disabled += ser.disabled?.[i] || 0; available += ser.available?.[i] || 0;
  }
  const presence = Number.isFinite(ser.presence) ? ser.presence : counted ? n / counted : 1;
  return n ? { n, fleet: total / n, total, disabled, available: available / n, presence, incomplete: presence < minPresence } : null;
}

/**
 * Tageswerte aus history/daily.json ({ days, fields, series: { key: { Tag: [Werte …] } } }) in die Form einer Tagesdatei bringen:
 * ein Punkt je Schlüssel mit den Tagesmitteln – histStats liefert daraus Ø Flotte und Sperrquote. null, wenn der Tag fehlt.
 */
export function histFromDaily(daily, day) {
  if (!daily?.series || !(daily.days || []).includes(day)) return null;
  const fi = Object.fromEntries((daily.fields || []).map((f, i) => [f, i]));
  if (fi.total == null) return null;
  const series = {};
  const dayRuns = daily.dayRuns?.[day] ?? null; // zählende Läufe des Tages (ältere daily.json ohne Angabe: keine Präsenzprüfung)
  for (const [k, byDay] of Object.entries(daily.series)) { const v = byDay?.[day]; if (!v) continue; const runs = fi.runs != null ? v[fi.runs] : null;
    series[k] = { total: [v[fi.total]], available: [fi.available != null ? v[fi.available] : null], disabled: [fi.disabled != null ? v[fi.disabled] : 0], ...(dayRuns > 0 && runs != null ? { presence: runs / dayRuns } : {}) }; }
  return { day, t: [null], f: [1], series, fromDaily: true };
}

/**
 * Kennzahlen einer Gemeinde über mehrere Tage.
 * docs: Tagesdokumente events/<Tag>.json (aufsteigend); hists: { Tag → history/<Tag>.json } (optional, für Flotte und Sperrquote);
 * cells: { Tag → { zelle → [start,end,present,reloc,…] } } der Gemeinde, cellRuns: { Tag → Läufe der Zellendatei };
 * latestGroups: latest.json groups (Ersatz, wenn nichts gemessen ist); pop: Einwohner.
 */
// rvdLimit: Plausibilitätsgrenze je Art aus der Kalibrierung (pulse-calib rvdLimits, z. B. { scooter: 3,47 }); darüber gilt die Messung als
// Überzählung: Flag SUSPENDED, nicht in Summen, nicht kalibriert. Ohne rvdLimit nur die feste Grenze DEFAULTS.maxRvd (15).
export const SUSPENDED = 'Kalibrierung ausgesetzt – Messung unplausibel (Überzählung wahrscheinlich)';
export const INCOMPLETE = 'unvollständig – an einzelnen Tagen nur in wenigen Läufen gemeldet, dort nicht als Flotte gezählt';
function SUSPENDED_ID() { return SUSPENDED; }
export const overLimit = (rvd, ty, rvdLimit) => rvd != null && rvdLimit?.[ty] != null && rvd > rvdLimit[ty];
// Ampel rot (latest.json → eventChecks, lib/pulse-econ.js eventChecks): Ereignisregeln der Gruppe am letzten vollständigen Tag nicht plausibel
export const AMPEL_RED = 'ampel-rot';
const mbRedSet = (ec) => new Set(Object.entries(ec?.groups || {}).filter(([, v]) => v?.level === 'bad').map(([k]) => k));
const isPlausible = (flags) => !flags.some(f => f.startsWith('unplausibel') || f === SUSPENDED || f === AMPEL_RED);
// breaks: Bruchmarken aus history/daily.json ({ 'Gemeinde|Anbieter|Art': erster Tag mit neuem Regelstand }): Tage davor zählen für diese Reihe
// nicht (Flotte, Fahrten, Hochrechnung); am Bruchtag nur Stunden, deren Läufe alle den letzten Regelstand des Tages tragen. quality.breaks nennt sie.
export function municipalReport({ docs = [], hists = {}, cells = {}, cellRuns = {}, ags, pop = null, operator = 'all', type = 'all', latestGroups = null, rvdLimit = null, breaks = null, eventChecks = null } = {}) {
  const ampelRed = mbRedSet(eventChecks); // eventChecks: latest.json → eventChecks; rote Gruppen nicht plausibel (AMPEL_RED)
  const keep = keyFilter({ ags, operator, type });
  const list = docs.filter(d => d?.day).sort((a, b) => a.day.localeCompare(b.day));
  const prof = measuredProfile(list);
  const G = new Map(); // op|ty → Akkumulator
  const acc = (op, ty) => { const k = `${op}|${ty}`; if (!G.has(k)) G.set(k, { op, ty, key: k, fleetDays: [], fleetSrc: new Set(), rides: 0, ends: 0, reloc: 0, cov: 0, durSum: 0, durN: 0, distSum: 0, distN: 0, dis: 0, tot: 0, disSrc: null, days: new Set(), incompleteDays: new Set(), breakDay: null, breakDays: new Set(), breakCut: false }); return G.get(k); };
  const daily = [];
  const q = { days: list.length, runs: 0, counted: 0, gapRuns: 0, gaps: [], obsMin: 0, fullDays: 0, excludedHours: 0, taintedDays: [], fleetFromHistory: [], incompleteGroups: [], mixedRuleDays: [], breaks: [], rule: null, ruleFullDays: 0 };
  const dayRule = []; // je Tag { full, rule } für q.ruleFullDays
  for (const doc of list) {
    const hq = hourQuality(doc.runs, doc.gapHours);
    const cov = dayCoverage(hq, prof.profile, hourMinOf(doc));
    const vOk = vminCounted(doc.runs);
    const hist = hists[doc.day] || null;
    q.runs += hq.runs; q.counted += hq.counted; q.gapRuns += hq.gaps.length; q.obsMin += hq.obsMin; q.excludedHours += hq.excludedHours;
    for (const g of hq.gaps) q.gaps.push({ ...g, day: doc.day });
    if (hq.full) q.fullDays++;
    const tainted = hq.tainted > 0; if (tainted) q.taintedDays.push(doc.day);
    // Tag mit mehreren Regelständen (M-19): nur der Teil vor „@“ zählt; ohne Angabe getrennt am bekannten Wechsel (01.11. 14:13)
    const runsA = (doc.runs || []).filter(Array.isArray), eras = [...new Set(runsA.map(ruleEra))];
    if (eras.length > 1) q.mixedRuleDays.push({ day: doc.day, rules: eras });
    dayRule.push({ full: hq.full, rule: docRule(doc) });
    // Bruchtag: Stunden, deren Läufe alle den letzten Regelstand des Tages tragen (late[h])
    const lastEra = eras.length > 1 ? ruleEra(runsA[runsA.length - 1]) : null;
    const late = lastEra ? Array.from({ length: 24 }, (_, h) => runsA.every(r => hourOfMs(r[0]) !== h || ruleEra(r) === lastEra)) : null;
    const obsRaw = hq.obs.reduce((a, m, h) => a + (hq.ok[h] ? m : 0), 0);
    const row = { day: doc.day, weekday: weekdayOf(doc.day), obsHours: hq.obsMin / 60, runs: hq.runs, gapRuns: hq.gaps.length, coverage: cov, full: hq.full, fleet: 0, fleetKnown: false, rides: 0, byGroup: {} };
    const keys = new Set([...Object.keys(doc.groups || {}), ...Object.keys(hist?.series || {})].filter(keep));
    let histUsed = false;
    for (const k of keys) {
      const [, op, ty] = k.split('|'); const a = acc(op, ty);
      // Bruchmarke: Tage vor dem Regelwechsel zählen für diese Reihe nicht, am Bruchtag nur Stunden mit dem neuen Stand
      const bd = breaks?.[k] ?? null; if (bd) a.breakDay = bd;
      if (bd && doc.day < bd) { a.breakDays.add(doc.day); continue; }
      const cut = bd === doc.day && late ? late : null; if (cut) a.breakCut = true;
      const okH = (h) => hq.ok[h] && (!cut || cut[h]);
      const obsG = cut ? hq.obs.reduce((s, m, h) => s + (okH(h) ? m : 0), 0) : obsRaw;
      const covG = cut ? dayCoverage({ ...hq, obsOk: hq.obsOk.map((m, h) => (cut[h] ? m : 0)) }, prof.profile, hourMinOf(doc)) : cov;
      const g = doc.groups?.[k];
      let rides = 0, ends = 0, reloc = 0, vt = 0;
      if (g) for (let h = 0; h < 24; h++) { if (!okH(h)) continue; rides += g.start?.[h] || 0; ends += g.end?.[h] || 0; reloc += g.reloc?.[h] || 0; vt += g.vminTot?.[h] || 0; }
      let fleet = null;
      const hs = cut ? null : histStats(hist, k); // Tagesmittel mischt am Bruchtag beide Stände
      if (vOk && obsG > 0 && vt > 0) { fleet = vt / obsG; a.fleetSrc.add('gemessen'); }
      else if (hs?.incomplete) a.incompleteDays.add(doc.day); // nur in einzelnen Läufen gemeldet: keine Tagesflotte
      else if (hs) { fleet = hs.fleet; a.fleetSrc.add('Verlauf'); histUsed = true; }
      if (hs && !hs.incomplete) { a.dis += hs.disabled; a.tot += hs.total; a.disSrc = 'Verlauf'; }
      const present = (fleet || 0) > 0 || rides > 0;
      if (fleet != null) a.fleetDays.push({ day: doc.day, fleet });
      a.rides += rides; a.ends += ends; a.reloc += reloc;
      if (present) { a.cov += covG; a.days.add(doc.day); }
      if (g && !tainted && !cut) { a.durSum += g.tripDurSum || 0; a.durN += g.tripDurN || 0; a.distSum += g.tripDistSum || 0; a.distN += g.tripDistN || 0; }
      row.rides += rides; if (fleet != null) { row.fleet += fleet; row.fleetKnown = true; }
      row.byGroup[`${op}|${ty}`] = { fleet, rides };
    }
    if (histUsed) q.fleetFromHistory.push(doc.day);
    row.ridesDay = cov > 0 ? row.rides / cov : null;
    if (!row.fleetKnown) row.fleet = null;
    daily.push(row);
  }
  // Gruppen ohne jede Messung: aktueller Bestand aus latest.json
  if (latestGroups) for (const [k, st] of Object.entries(latestGroups)) {
    if (!keep(k)) continue; const [, op, ty] = k.split('|'); const a = acc(op, ty);
    if (!a.fleetDays.length && st?.total != null) { a.fleetDays.push({ day: null, fleet: st.total }); a.fleetSrc.add('aktuell'); }
    if (!a.tot && st?.total) { a.dis = st.disabled || 0; a.tot = st.total; a.disSrc = 'aktuell'; }
  }
  const per1000 = (v) => (pop > 0 && v != null ? (v / pop) * 1000 : null);
  let groups = [...G.values()].map(a => {
    const fl = a.fleetDays.map(x => x.fleet);
    const fleet = fl.length ? sum(fl) / fl.length : null;
    const ridesDay = a.cov > 0 ? a.rides / a.cov : null;
    const rvd = ridesDay != null && fleet > 0 ? ridesDay / fleet : null;
    const flags = [];
    if (rvd != null && rvd > DEFAULTS.maxRvd) flags.push('unplausibel hoch – Kennungen wechseln vermutlich ohne Fahrt');
    else if (overLimit(rvd, a.ty, rvdLimit)) flags.push(SUSPENDED);
    if (a.ends > a.rides * 1.3 && a.rides > 20) flags.push('deutlich mehr Fahrtenden als -beginne (Neuaufstellungen oder Kennungswechsel)');
    if (a.incompleteDays.size) flags.push(INCOMPLETE);
    if (ampelRed.has(`${ags}|${a.key}`)) flags.push(AMPEL_RED);
    const measured = (n) => n >= DEFAULTS.minTripsMeasured;
    return {
      key: a.key, op: a.op, ty: a.ty, fleet, fleetMin: fl.length ? Math.min(...fl) : null, fleetMax: fl.length ? Math.max(...fl) : null, fleetDays: a.fleetDays,
      fleetSource: [...a.fleetSrc].join(' + ') || null, rides: a.rides, ends: a.ends, reloc: a.reloc, coverageDays: a.cov, ridesDay, rvd,
      disabledShare: a.tot > 0 ? a.dis / a.tot : null, disabledSource: a.disSrc,
      avgMin: measured(a.durN) ? a.durSum / a.durN / 60e3 : null, avgKm: measured(a.distN) ? a.distSum / a.distN / 1000 : null, durN: a.durN, distN: a.distN,
      per1000Fleet: per1000(fleet), per1000Rides: per1000(ridesDay), plausible: isPlausible(flags), flags, incompleteDays: [...a.incompleteDays].sort(),
      breakDay: a.breakDays.size || a.breakCut ? a.breakDay : null, breakSkipped: [...a.breakDays].sort(),
    };
  });
  for (const g of groups) if (g.incompleteDays.length && !((g.fleet || 0) > 0)) q.incompleteGroups.push(g.key);
  for (const g of groups) if (g.breakDay) q.breaks.push({ key: g.key, day: g.breakDay, skipped: g.breakSkipped });
  // Regelstand (Datenvertrag 2): des jüngsten gezählten Laufs; volle Messtage, an denen alle gezählten Läufe ihn tragen
  for (let i = list.length - 1; i >= 0 && q.rule == null; i--) { const rs = (list[i].runs || []).filter(countedRun); if (rs.length) q.rule = ruleOf(rs[rs.length - 1]); }
  q.ruleFullDays = q.rule == null ? 0 : dayRule.filter(d => d.full && d.rule === q.rule).length;
  groups = groups.filter(g => (g.fleet || 0) > 0 || g.rides > 0).sort((x, y) => (y.fleet || 0) - (x.fleet || 0) || y.rides - x.rides);
  const good = groups.filter(g => g.plausible);
  const fleetT = sum(groups.map(g => g.fleet));
  const ridesDayT = good.some(g => g.ridesDay != null) ? sum(good.map(g => g.ridesDay)) : null;
  const fleetGood = sum(good.map(g => g.fleet));
  const disT = groups.reduce((a, g) => a + (g.disabledShare != null && g.fleet ? g.disabledShare * g.fleet : 0), 0);
  const disW = groups.reduce((a, g) => a + (g.disabledShare != null && g.fleet ? g.fleet : 0), 0);
  // Marktanteil nach Bestand (robust gegen rotierende Kennungen, anders als Fahrten) und Konzentration (HHI, 0–10.000) je Anbieter über alle Arten
  const byOp = new Map(); for (const g of groups) if ((g.fleet || 0) > 0) byOp.set(g.op, (byOp.get(g.op) || 0) + g.fleet);
  const opShares = [...byOp].map(([op, f]) => ({ op, fleet: f, share: f / fleetT })).sort((x, y) => y.share - x.share);
  for (const g of groups) g.fleetShare = fleetT > 0 && (g.fleet || 0) > 0 ? g.fleet / fleetT : null;
  const totals = {
    fleet: groups.length ? fleetT : null, rides: sum(groups.map(g => g.rides)), ridesDay: ridesDayT,
    rvd: ridesDayT != null && fleetGood > 0 ? ridesDayT / fleetGood : null, disabledShare: disW > 0 ? disT / disW : null,
    per1000Fleet: per1000(groups.length ? fleetT : null), per1000Rides: per1000(ridesDayT), excluded: groups.filter(g => !g.plausible).map(g => g.key),
    hhi: opShares.length ? Math.round(sum(opShares.map(o => (o.share * 100) ** 2))) : null, opCount: opShares.length, topOp: opShares[0]?.op ?? null, topShare: opShares[0]?.share ?? null,
  };
  q.possibleMin = list.length * 1440; q.prelim = q.fullDays < MIN_FULL_DAYS; q.profileSource = prof.source; q.profileDays = prof.days;
  q.longestGapMs = q.gaps.reduce((m, g) => Math.max(m, g.ms || 0), 0);
  return { ags, pop, from: list[0]?.day || null, to: list[list.length - 1]?.day || null, days: list.map(d => d.day), quality: q, groups, totals, daily, cells: cellStats(cells, cellRuns) };
}

/** Stärkste und schwächste Zellen sowie das Raster für die Start/Ziel-Heatmap (alle Anbieter und Arten der Gemeinde) */
export function cellStats(cellsByDay = {}, runsByDay = {}, { top = 5, weakMinPresent = WEAK_MIN_PRESENT } = {}) {
  const agg = new Map(); let runs = 0, days = 0;
  for (const [day, cells] of Object.entries(cellsByDay)) {
    if (!cells) continue; days++; runs += runsByDay[day] || 0;
    for (const [cell, v] of Object.entries(cells)) {
      const a = agg.get(cell) || { cell, start: 0, end: 0, present: 0, reloc: 0 };
      a.start += v[0] || 0; a.end += v[1] || 0; a.present += v[2] || 0; a.reloc += v[3] || 0; agg.set(cell, a);
    }
  }
  const grid = [...agg.values()].map(a => {
    const [i, j] = a.cell.split(':').map(Number);
    return { ...a, i, j, lat: i * CELL_LAT, lon: j * CELL_LON, presAvg: runs ? a.present / runs : null };
  }).filter(c => Number.isFinite(c.i) && Number.isFinite(c.j) && (c.start + c.end + c.present + c.reloc) > 0);
  const strong = grid.filter(c => c.start > 0).sort((a, b) => b.start - a.start || b.end - a.end).slice(0, top);
  // schwach: Bestand vorhanden, aber wenige Fahrtbeginne je verfügbarem Fahrzeug
  const weak = grid.filter(c => c.presAvg != null && c.presAvg >= weakMinPresent).map(c => ({ ...c, perVehicle: c.start / c.presAvg }))
    .sort((a, b) => a.perVehicle - b.perVehicle || b.presAvg - a.presAvg).slice(0, top);
  const max = grid.reduce((m, c) => Math.max(m, c.start, c.end), 0);
  return { days, runs, n: grid.length, grid, strong, weak, max };
}

/** Klasse 0…steps einer Heatmap-Zelle: 0 = null; Wurzel-Skala (gestaucht, damit wenige Spitzen nicht alles hell machen) oder linear */
export function heatClass(v, max, steps = 8, { sqrt = true } = {}) {
  if (!(v > 0) || !(max > 0)) return 0;
  const x = Math.min(1, v / max);
  return Math.max(1, Math.min(steps, Math.ceil(steps * (sqrt ? Math.sqrt(x) : x))));
}
/** Untergrenze der Klasse k in derselben Skala */
export const heatClassFloor = (k, max, steps = 8, { sqrt = true } = {}) => (k <= 0 ? 0 : max * (sqrt ? ((k - 1) / steps) ** 2 : (k - 1) / steps));

// ---------- Obergrenzen ----------
export function capStatus(value, limit) {
  if (!(limit > 0) || value == null) return { status: 'unknown', share: null };
  const share = value / limit;
  return { status: share > 1 ? 'over' : share >= NEAR_CAP ? 'near' : 'ok', share };
}
// Einträge in reference.json → obergrenzen: ags, ort, type ('scooter' | 'bike'), gesamt, jeAnbieter, ab + gesamtAb (Wechsel am Stichtag),
// zonen [{ name, gesamt?, jeAnbieter?, jeAnbieterAbgeleitet?, anteilMax?, anteilMin? (Anteil an der Flotte des Anbieters, 0–1), hinweis?,
// beobachtung? (Zonen-ID in zone-watch.json, vermutete Abgrenzung) }], anbieter [Namen laut Quelle], anbieterZahl, status, statusText,
// hinweis, art, stand, seit, quelle/url (+ quelle2, url2, url3), jeAnbieterAbgeleitet / gesamtAbgeleitet. Unbekannte Felder stören nicht.
// Regeln: Nur amtliche Einträge (status 'amtlich'; ohne status wie bisher amtlich) ergeben Kennzahlen und Verstöße; 'geplant', 'presse',
// 'ungeprüft', 'veraltet' nur zur Information, 'keine' = keine Obergrenze laut Quelle. Zonen gelten nur in einem Teilgebiet und sind ohne
// Gebietsgrenze nicht prüfbar (nie gegen den Bestand der ganzen Gemeinde); mit beobachtung gegen die vermutete Abgrenzung (zoneCapCheck). Gerechnete Grenzen (…Abgeleitet: nicht in der Quelle) liefern
// Kennzahlen, aber keinen Verstoß (Status „hint“). Ohne gesamt und ohne jeAnbieter keine Rate. Anbieter außerhalb einer vollständigen
// anbieter-Liste: „ohne Zulassung laut Quelle“ (kein Verstoß, keine Rate je Anbieter).
const DISTRICT_KEYS = [['innenstadtbezirke', 'Innenstadtbezirke'], ['zentraleInnenstadt', 'Zentrale Innenstadt']];
export const CAP_SOURCE_STATUS = { amtlich: 'amtlich', geplant: 'geplant', presse: 'nur Pressebericht', 'ungeprüft': 'ungeprüft', veraltet: 'veraltet', keine: 'keine Obergrenze laut Quelle' };
export const capOfficial = (e) => e?.status == null || e.status === 'amtlich';
const numOrNull = (x) => (x == null || x === '' || typeof x === 'boolean' || Array.isArray(x) || !Number.isFinite(+x) ? null : +x);
/** Zahl oder Spanne aus der Quelle (gesamt: [9000, 10000]) als Liste, nur zur Anzeige */
const numsOf = (x) => (Array.isArray(x) ? x : [x]).map(numOrNull).filter(v => v != null);
/** Gültige Gesamtgrenze zum Zeitpunkt asOf: „ab“ + „gesamtAb“ lösen „gesamt“ ab */
export function capLimit(entry, asOf = Date.now()) {
  const g = numOrNull(entry?.gesamt), gAb = numOrNull(entry?.gesamtAb);
  const ab = entry?.ab ? berlinMidnight(entry.ab) : null; // Stichtag 0 Uhr Ortszeit (im Sommer +02:00)
  if (ab != null && Number.isFinite(ab) && gAb != null) {
    if (asOf >= ab) return { limit: gAb, since: entry.ab, previous: g, next: null };
    return { limit: g, since: entry.seit || null, previous: null, next: { limit: gAb, from: entry.ab } };
  }
  return { limit: g, since: entry?.seit || null, previous: null, next: null };
}
const LIMIT_KEYS = ['limit', 'grenze', 'max', 'fahrzeuge', 'gesamt', 'wert', 'jeAnbieter', 'anzahl'];
const NAME_KEYS = ['anbieter', 'name', 'op', 'operator'];
const limitOf = (v) => (typeof v === 'object' && v ? LIMIT_KEYS.map(k => numOrNull(v[k])).find(x => x != null) ?? null : numOrNull(v));
// Fahrzeugart einer Grenze: 'bike' deckt Räder und E-Räder ab (Dresden: Lime-E-Räder zählen zur Rad-Grenze), außer exakteArt: true
const typesOfCap = (e) => { const t = [].concat(e?.type || 'scooter').map(String).filter(Boolean); const out = t.length ? t : ['scooter']; return e?.exakteArt === true ? out : [...new Set(out.flatMap(x => (x === 'bike' ? ['bike', 'ebike'] : [x])))]; };
// Anbieternamen vergleichbar machen: „Dott (TIER)“ → dott, tier; TIER und Dott sind seit 2024 ein Unternehmen, die Feeds heißen Dott
const OP_ALIAS = { tier: 'dott', limebike: 'lime', 'voi technology': 'voi' };
const nameKeys = (n) => String(n ?? '').toLowerCase().split(/[()\/,;+&]|\sund\s/).map(x => x.trim()).filter(Boolean).flatMap(x => [x, OP_ALIAS[x]].filter(Boolean));
/**
 * Anbieter eines Eintrags: jeAnbieter gilt für alle (jeAnbieterAbgeleitet: gerechnet); das Feld anbieter ist eine Namensliste (zugelassene
 * Anbieter laut Quelle) oder Objekte/Map mit eigener Zahl. Rückgabe { perOperator, perOperatorDerived, of(op), own(op), listed, licensed(op) }:
 * licensed → true/false nur bei vollständiger Liste (anbieterZahl fehlt oder Liste so lang), sonst null.
 */
export function capOperatorLimits(entry) {
  const perOperator = numOrNull(entry?.jeAnbieter); const by = new Map(); const names = [];
  const put = (name, v) => { if (name == null || name === '') return; names.push(String(name).trim()); const l = limitOf(v); if (l != null) for (const k of nameKeys(name)) by.set(k, l); };
  const a = entry?.anbieter;
  if (Array.isArray(a)) for (const x of a) { if (typeof x === 'string') put(x, null); else if (x && typeof x === 'object') put(NAME_KEYS.map(k => x[k]).find(n => typeof n === 'string'), x); }
  else if (a && typeof a === 'object') for (const [n, v] of Object.entries(a)) put(n, v);
  const n = numOrNull(entry?.anbieterZahl), complete = names.length > 0 && (n == null || names.length >= n);
  const keys = new Set(names.flatMap(nameKeys));
  const ownKey = (op) => nameKeys(op).find(k => by.has(k));
  return { perOperator, perOperatorDerived: !!entry?.jeAnbieterAbgeleitet, listed: names.length ? names : null, complete,
    of: (op) => { const k = ownKey(op); return k ? by.get(k) : perOperator; }, own: (op) => !!ownKey(op),
    licensed: (op) => (complete ? nameKeys(op).some(k => keys.has(k)) : null) };
}
/** Teilgebiete mit eigener Grenze (zonen, sonst die alten Felder innenstadtbezirke/zentraleInnenstadt): ohne Gebietsgrenze nicht prüfbar */
function capDistricts(e) {
  const z = e?.zonen; const out = [];
  const add = (label, v, i) => { if (!label) return; const o = v && typeof v === 'object' ? v : { gesamt: v };
    const limit = numOrNull(o.gesamt) ?? (o.jeAnbieter == null ? limitOf(o) : null), per = numOrNull(o.jeAnbieter);
    // Anteil an der Flotte des Anbieters (anteilMax/anteilMin, 0–1; Werte über 1 als Prozent gelesen)
    const frac = (x) => { const v = numOrNull(x); return v == null || v < 0 ? null : v > 1 ? v / 100 : v; };
    out.push({ key: `zone${i}`, label: String(label), limit, perOperator: per, perOperatorDerived: !!o.jeAnbieterAbgeleitet, hinweis: typeof o.hinweis === 'string' ? o.hinweis : null, status: 'unchecked',
      watch: typeof o.beobachtung === 'string' && o.beobachtung ? o.beobachtung : null, shareMax: frac(o.anteilMax), shareMin: frac(o.anteilMin) }); };
  if (Array.isArray(z)) z.forEach((x, i) => { if (x && typeof x === 'object') add(['name', 'label', 'zone', 'bezeichnung'].map(k => x[k]).find(n => typeof n === 'string'), x, i); });
  else if (z && typeof z === 'object') Object.entries(z).forEach(([n, v], i) => add(n, v, i));
  if (!out.length) for (const [k, label] of DISTRICT_KEYS) if (e?.[k] != null) out.push({ key: k, label, limit: numOrNull(e[k]), perOperator: null, perOperatorDerived: false, hinweis: null, status: 'unchecked' });
  return out;
}
// Status einer Kennzahl gegen eine Grenze; gerechnete Grenze: statt „nahe/über“ nur „hint“ (Hinweis, kein Verstoß)
const rateStatus = (v, limit, derived) => { const s = capStatus(v, limit); return derived && (s.status === 'over' || s.status === 'near') ? { ...s, status: 'hint' } : s; };
/**
 * Bestand gegen Obergrenzen je Eintrag (Gemeinde × Art). groups: latest.json groups; Bestand = alle im Feed gemeldeten Fahrzeuge der Art
 * (verfügbar, reserviert, gesperrt), nach Abgleich der Quellen. Zonen/Bezirke: nicht prüfbar. Nicht amtliche Einträge: limit null,
 * status 'info' ('none' bei status 'keine'); die Zahlen der Quelle stehen in info. Je Anbieter zusätzlich buchbar (available) und
 * Verfügbar ÷ erlaubt: availShare = buchbar ÷ eigene Grenze; ohne eigene Grenze capShare/capShareAvail = gemeldet bzw. buchbar ÷ Gesamtgrenze.
 */
export function capsCheck(reference, groups, { ags = 'DE', asOf = Date.now(), zoneWatch = null } = {}) {
  const out = [];
  for (const e of reference?.obergrenzen || []) {
    if (!e?.ags || (ags !== 'DE' && e.ags !== ags)) continue;
    const types = typesOfCap(e), official = capOfficial(e), src = typeof e.status === 'string' ? e.status : 'amtlich';
    const byOp = new Map();
    for (const [k, st] of Object.entries(groups || {})) {
      const [a, op, t] = k.split('|'); if (a !== e.ags || !types.includes(t)) continue;
      if ((e.ausgenommeneAnbieter || []).includes(op)) continue; // laut Quelle nicht von der Grenze erfasst (z. B. Bestandsschutz)
      const o = byOp.get(op) || { op, total: 0, available: 0, disabled: 0, reserved: 0 };
      o.total += st.total || 0; o.available += st.available || 0; o.disabled += st.disabled || 0; o.reserved += st.reserved || 0; byOp.set(op, o);
    }
    const lim0 = capLimit(e, asOf); const L = capOperatorLimits(e);
    const lim = official ? lim0 : { ...lim0, limit: null, previous: null, next: null };
    const limitDerived = !!e.gesamtAbgeleitet;
    const share = (v, l) => (l > 0 && v != null ? v / l : null);
    const ops = [...byOp.values()].sort((a, b) => b.total - a.total).map(o => {
      const licensed = L.licensed(o.op);
      const limit = official && licensed !== false ? L.of(o.op) : null, derived = !L.own(o.op) && L.perOperatorDerived;
      const st = licensed === false ? { status: 'unlicensed', share: null } : rateStatus(o.total, limit, derived);
      return { ...o, licensed, limit, derived, ...st, availShare: share(o.available, limit), availStatus: licensed === false ? 'unlicensed' : rateStatus(o.available, limit, derived).status,
        capShare: share(o.total, lim.limit), capShareAvail: share(o.available, lim.limit) };
    });
    const total = sum(ops.map(o => o.total)), available = sum(ops.map(o => o.available));
    const tot = official ? (lim.limit > 0 ? rateStatus(total, lim.limit, limitDerived) : { status: 'unknown', share: null }) : { status: src === 'keine' ? 'none' : 'info', share: null };
    const links = [[e.url2, e.quelle2], [e.url3, null]].filter(([u]) => typeof u === 'string' && u).map(([url, quelle]) => ({ url, quelle: quelle || null }));
    out.push({ ags: e.ags, ort: e.ort || e.ags, type: types[0], types, official, sourceStatus: src, statusText: typeof e.statusText === 'string' ? e.statusText : CAP_SOURCE_STATUS[src] || null,
      art: typeof e.art === 'string' ? e.art : null, hinweis: typeof e.hinweis === 'string' ? e.hinweis : null, info: { gesamt: numsOf(e.gesamt), jeAnbieter: numsOf(e.jeAnbieter) },
      total, available, ...lim, limitDerived, ...tot, availShare: share(available, lim.limit), availStatus: lim.limit > 0 ? rateStatus(available, lim.limit, limitDerived).status : tot.status,
      perOperator: official ? L.perOperator : null, perOperatorDerived: L.perOperatorDerived, hasRate: official && (lim.limit > 0 || ops.some(o => o.limit > 0) || L.perOperator > 0),
      listed: L.listed, listComplete: L.complete, operators: ops, districts: capDistricts(e).map(d => { const ck = zoneWatch ? zoneCapCheck(d, zoneWatch, { types, licensed: L.licensed, fleet: new Map([...byOp].map(([op, o]) => [op, o.total])), official }) : null; return ck ? { ...d, status: ck.status, check: ck } : d; }), quelle: e.quelle || null, url: e.url || null, links, stand: typeof e.stand === 'string' ? e.stand : null, seit: e.seit || null });
  }
  return out;
}
/**
 * Verfügbar ÷ erlaubt je Gemeinde × Art × Anbieter (Leistung › Verfügbarkeit je Stadt), nur amtliche Einträge mit stadtweiter Zahl.
 * Je Anbieter mit eigener Grenze (jeAnbieter/anbieter): buchbare Fahrzeuge ÷ seine Grenze (kind 'operator'). Gibt es nur eine Gesamtgrenze:
 * buchbar ÷ Gesamtgrenze als Anteil des Anbieters an der Gesamtgrenze (kind 'share'); die Zeile op '*' (nur ohne Anbieterfilter) stellt die
 * Summe der Gesamtgrenze gegenüber (kind 'total'). Anbieter außerhalb der Zulassungsliste: kind 'unlicensed' ohne Rate. Gemeldet ÷ erlaubt
 * ebenso mit allen gemeldeten Fahrzeugen. Gezählt wird nur die Fahrzeugart der Obergrenze. Tagesmittel/-minimum: je Sammler-Punkt aus
 * history/<Tag>.json buchbar ÷ Grenze zu diesem Zeitpunkt. Rückgabe { rows, cities: Einträge mit Rate, skipped: Grenze gilt für eine andere Art,
 * info: Einträge ohne Rate (nicht amtlich, keine Grenze, nur Teilgebiete) }.
 */
export function capAvailability(reference, latest, { hist = null, operator = 'all', type = 'all', asOf = Date.now() } = {}) {
  const rows = [], skipped = [], info = []; let cities = 0;
  const t = hist?.t || [];
  for (const e of reference?.obergrenzen || []) {
    if (!e?.ags) continue;
    const c = capsCheck({ obergrenzen: [e] }, latest?.groups, { ags: e.ags, asOf })[0]; if (!c) continue;
    if (!c.hasRate) { info.push({ ags: c.ags, ort: c.ort, types: c.types, sourceStatus: c.sourceStatus, statusText: c.statusText, art: c.art, info: c.info, districts: c.districts, official: c.official, quelle: c.quelle, url: c.url, stand: c.stand }); continue; }
    cities++;
    if (type !== 'all' && !c.types.includes(type)) { skipped.push({ ags: c.ags, ort: c.ort, types: c.types }); continue; }
    const L = capOperatorLimits(e); const limAt = t.map(tt => capLimit(e, tt).limit);
    // Sammler-Punkte je Anbieter: buchbar je Punkt (null = keine Angabe in diesem Lauf)
    const pts = new Map();
    for (const [k, ser] of Object.entries(hist?.series || {})) {
      const [a, op, ty] = k.split('|'); if (a !== c.ags || !c.types.includes(ty)) continue;
      const p = pts.get(op) || new Array(t.length).fill(null);
      for (let i = 0; i < t.length; i++) { const v = ser.available?.[i]; if (v != null && Number.isFinite(+v)) p[i] = (p[i] || 0) + +v; }
      pts.set(op, p);
    }
    const dayStats = (avail, limitFn) => { let s = 0, n = 0, min = null, minAt = null; for (let i = 0; i < t.length; i++) { const l = limitFn(i); if (avail[i] == null || !(l > 0)) continue; const v = avail[i] / l; s += v; n++; if (min == null || v < min) { min = v; minAt = t[i]; } } return n ? { dayMean: s / n, dayMin: min, dayMinAt: minAt, dayN: n } : { dayMean: null, dayMin: null, dayMinAt: null, dayN: 0 }; };
    const base = { ags: c.ags, ort: c.ort, types: c.types, capTotal: c.limit ?? null, since: c.since ?? null, next: c.next ?? null, previous: c.previous ?? null, quelle: c.quelle, url: c.url, links: c.links, stand: c.stand, art: c.art, listed: c.listed, listComplete: c.listComplete, districts: c.districts };
    for (const o of c.operators) {
      if ((operator !== 'all' && o.op !== operator) || !(o.total > 0 || o.available > 0)) continue; // Anbieter ohne Fahrzeuge im Feed: keine Zeile
      const own = o.limit > 0, unl = o.licensed === false;
      const kind = unl ? 'unlicensed' : own ? 'operator' : c.limit > 0 ? 'share' : 'none';
      const limit = kind === 'operator' ? o.limit : kind === 'share' ? c.limit : null, derived = kind === 'operator' ? o.derived : kind === 'share' ? c.limitDerived : false;
      const p = pts.get(o.op) || [];
      rows.push({ ...base, op: o.op, kind, limit, derived, licensed: o.licensed, total: o.total, available: o.available, disabled: o.disabled, reserved: o.reserved,
        availRate: limit > 0 ? o.available / limit : null, totalRate: limit > 0 ? o.total / limit : null, availStatus: rateStatus(o.available, limit, derived).status, totalStatus: rateStatus(o.total, limit, derived).status,
        ...(limit > 0 ? dayStats(p, (i) => (kind === 'operator' ? o.limit : limAt[i])) : dayStats([], () => null)) });
    }
    if (operator === 'all' && c.limit > 0 && c.operators.length) {
      const all = new Array(t.length).fill(null);
      for (const p of pts.values()) p.forEach((v, i) => { if (v != null) all[i] = (all[i] || 0) + v; });
      rows.push({ ...base, op: '*', kind: 'total', limit: c.limit, derived: c.limitDerived, total: c.total, available: c.available, availRate: c.available / c.limit, totalRate: c.total / c.limit,
        availStatus: rateStatus(c.available, c.limit, c.limitDerived).status, totalStatus: rateStatus(c.total, c.limit, c.limitDerived).status, ...dayStats(all, (i) => limAt[i]) });
    }
  }
  return { rows, cities, skipped, info };
}
export function capAvailabilityCsvRows(rows, { operator = 'all', type = 'all', at = null, day = null, typeLabel = (x) => x, lang = 'de' } = {}) {
  const head = ['AGS', 'Stadt', 'Anbieter', 'Fahrzeugart_Grenze', 'Anbieter_Filter', 'Fahrzeugart_Filter', 'Gemeldet', 'Buchbar', 'Erlaubt', 'Bezug', 'Grenze_gerechnet', 'Verfuegbar_je_erlaubt', 'Gemeldet_je_erlaubt', 'Tagesmittel_Verfuegbar_je_erlaubt', 'Tagesminimum_Verfuegbar_je_erlaubt', 'Sammler_Punkte', 'Tag', 'Quelle', 'Quelle_URL', 'Stand_Quelle', 'Stand'];
  const X = (v) => csvText(v, lang);
  const kind = { operator: X('Grenze je Anbieter'), share: X('Anteil an der Gesamtgrenze'), total: X('Gesamtgrenze, alle Anbieter'), unlicensed: X('ohne Zulassung laut Quelle'), none: X('keine Zahl') };
  return [head.map(X), ...rows.map(r => [r.ags, r.ort, r.op === '*' ? X('alle Anbieter') : r.op, r.types.map(typeLabel).join(', '), operator === 'all' ? X('alle') : operator, type === 'all' ? X('alle') : typeLabel(type), r.total, r.available, r.limit ?? '', kind[r.kind] || '', r.derived ? X('ja') : '',
    [r.availRate, 4], [r.totalRate, 4], [r.dayMean, 4], [r.dayMin, 4], r.dayN || '', day || '', r.quelle || '', r.url || '', r.stand || '', at ? new Date(at).toISOString() : ''])];
}

// ---------- Obergrenzen-Protokoll (caps-log.json, schreibt der Sammler je Lauf) ----------
const dayFmt = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: TZ });
export const berlinDay = (ms) => dayFmt.format(new Date(ms));
export const CAPS_LOG_FIELDS = ['at', 'ags', 'operator', 'count', 'limit', 'dtMs'];
export const CAPS_DAILY_FIELDS = ['day', 'ags', 'operator', 'max', 'limit', 'at'];
/**
 * Protokoll fortschreiben: Läufe mit Bestand ≥ 90 % der Grenze (gesamt '*' und je Anbieter) als Prüfung, dazu je Tag × Gemeinde × Anbieter
 * das Tagesmaximum (auch unter 90 %, für den Verlauf). caps: Ergebnis von capsCheck; dt: Fenster seit dem vorigen Lauf (ms) für die Dauer.
 * Behält days Tage, höchstens maxChecks Prüfungen (älteste fallen zuerst).
 */
// Schlüssel im Protokoll: AGS (E-Scooter, wie bisher) bzw. „AGS~Art“ für weitere Arten derselben Gemeinde (Dresden: E-Scooter und Räder)
export const capLogKey = (c) => (!c?.type || c.type === 'scooter' ? c.ags : `${c.ags}~${c.type}`);
export function capsLogUpdate(prev, caps, { at = Date.now(), dt = null, days = 30, maxChecks = 6000 } = {}) {
  const cut = at - days * 86400e3, today = berlinDay(at), dayCut = berlinDay(cut);
  const checks = (Array.isArray(prev?.checks) ? prev.checks : []).filter(c => Array.isArray(c) && c[0] >= cut && c[0] < at);
  const daily = new Map((Array.isArray(prev?.daily) ? prev.daily : []).filter(d => Array.isArray(d) && d[0] >= dayCut).map(d => [`${d[0]}|${d[1]}|${d[2]}`, d]));
  const dtMs = Number.isFinite(dt) && dt > 0 ? Math.min(dt, GAP_MS) : null;
  // nur amtliche, in der Quelle genannte Grenzen: gerechnete (…Abgeleitet) und nicht amtliche Einträge erzeugen keine Prüfung
  const counted = (caps || []).filter(c => c.official !== false && c.hasRate !== false);
  for (const c of counted) {
    const lk = capLogKey(c);
    for (const [op, n, lim] of [['*', c.total, c.limitDerived ? null : c.limit], ...(c.operators || []).map(o => [o.op, o.total, o.derived || o.licensed === false ? null : o.limit])]) {
      if (!(n > 0) && op !== '*') continue;
      if (lim > 0 && n / lim >= NEAR_CAP) checks.push([at, lk, op, n, lim, dtMs]);
      const k = `${today}|${lk}|${op}`, d = daily.get(k);
      if (!d || n > d[3]) daily.set(k, [today, lk, op, n, lim ?? null, at]);
    }
  }
  const rules = counted.map(c => ({ ags: capLogKey(c), ort: c.ort, type: c.type, limit: c.limit ?? null, perOperator: c.perOperator ?? null, since: c.since ?? null, next: c.next ?? null, quelle: c.quelle ?? null, url: c.url ?? null }));
  return { updatedAt: at, days, fields: CAPS_LOG_FIELDS, dailyFields: CAPS_DAILY_FIELDS, rules, checks: checks.sort((a, b) => a[0] - b[0]).slice(-maxChecks), daily: [...daily.values()].sort((a, b) => a[0].localeCompare(b[0]) || String(a[1]).localeCompare(String(b[1])) || String(a[2]).localeCompare(String(b[2]))) };
}
/**
 * Verstöße der letzten days Tage je Gemeinde: je Anbieter (und '*' gesamt) Dauer über der Grenze, Dauer nahe (90–100 %), Spitzenwert,
 * Zahl der Läufe; Verlauf = Tagesmaximum gesamt. Läufe ohne Fenster (dtMs null) zählen mit defaultDt.
 */
export function capsViolations(log, { ags = 'DE', asOf = Date.now(), days = 30, defaultDt = 20 * 60e3 } = {}) {
  if (!log || !Array.isArray(log.checks)) return [];
  const cut = asOf - days * 86400e3, dayCut = berlinDay(cut);
  const by = new Map();
  const A = (a) => { if (!by.has(a)) { const rule = (log.rules || []).find(r => r.ags === a) || { ags: a }; by.set(a, { ags: a, ort: rule.ort || a, rule, ops: new Map(), daily: [] }); } return by.get(a); };
  const mine = (a) => ags === 'DE' || a === ags || String(a).startsWith(`${ags}~`);
  for (const r of log.rules || []) if (mine(r.ags)) A(r.ags);
  for (const c of log.checks) {
    const [at, a, op, n, lim, dt] = c; if (!(at >= cut) || !mine(a) || !(lim > 0)) continue;
    const g = A(a); const o = g.ops.get(op) || { op, overMs: 0, nearMs: 0, overRuns: 0, nearRuns: 0, peak: 0, peakAt: null, limit: lim, lastOverAt: null, firstAt: at };
    const w = Number.isFinite(dt) && dt > 0 ? dt : defaultDt;
    if (n > lim) { o.overMs += w; o.overRuns++; o.lastOverAt = at; } else { o.nearMs += w; o.nearRuns++; }
    if (n > o.peak) { o.peak = n; o.peakAt = at; o.limit = lim; }
    g.ops.set(op, o);
  }
  for (const d of log.daily || []) { const [day, a, op, max, lim] = d; if (day < dayCut || !mine(a) || op !== '*') continue; A(a).daily.push({ day, max, limit: lim }); }
  return [...by.values()].map(g => ({ ...g, ops: [...g.ops.values()].sort((x, y) => (x.op === '*' ? -1 : y.op === '*' ? 1 : y.overMs - x.overMs || y.peak - x.peak)), daily: g.daily.sort((x, y) => x.day.localeCompare(y.day)) }));
}

// ---------- CSV ----------
/** Zelle für CSV: Deutsch (Standard) mit Semikolon und Dezimalkomma, Englisch (lang 'en') mit Komma und Dezimalpunkt;
 *  Text mit = + - @ (auch Tab/CR) am Anfang bekommt ' davor (Formel-Injection) */
export const csvSep = (lang = 'de') => (lang === 'en' ? ',' : ';');
export function csvCell(v, digits = null, lang = 'de') {
  if (v == null || (typeof v === 'number' && !Number.isFinite(v))) return '';
  let s;
  if (typeof v === 'number') s = (digits == null ? String(+v.toFixed(4)) : v.toFixed(digits)).replace('.', lang === 'en' ? '.' : ',');
  else { s = String(v); if (/^[\s\u00a0]*[=+\-@\t\r]/.test(s)) s = `'${s}`; } // Formel-Schutz, auch hinter führenden Leerzeichen
  return s.includes(csvSep(lang)) || /["\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}
export const toCsv = (rows, lang = 'de') => rows.map(r => r.map(c => (Array.isArray(c) ? csvCell(c[0], c[1], lang) : csvCell(c, null, lang))).join(csvSep(lang))).join('\r\n');
// Spaltenköpfe und feste Zellwerte der CSV-Exporte je Sprache (Deutsch bleibt das Archivformat; Englisch für die englische Oberfläche)
const CSV_EN = {
  AGS: 'AGS', Stadt: 'City', Land: 'State', Anbieter: 'Operator', Gemeinde: 'Municipality', Tag: 'Day', Fahrzeugart: 'Vehicle_type', Fahrzeugart_Grenze: 'Vehicle_type_cap', Anbieter_Filter: 'Operator_filter',
  Fahrzeugart_Filter: 'Vehicle_type_filter', Gemeldet: 'Reported', Buchbar: 'Bookable', Erlaubt: 'Allowed', Bezug: 'Basis', Grenze_gerechnet: 'Cap_calculated', Verfuegbar_je_erlaubt: 'Available_per_allowed',
  Gemeldet_je_erlaubt: 'Reported_per_allowed', Tagesmittel_Verfuegbar_je_erlaubt: 'Daily_mean_available_per_allowed', Tagesminimum_Verfuegbar_je_erlaubt: 'Daily_min_available_per_allowed',
  Sammler_Punkte: 'Collector_points', Quelle: 'Source', Quelle_URL: 'Source_URL', Stand_Quelle: 'Source_as_of', Stand: 'As_of', Zeitraum_von: 'Period_from', Zeitraum_bis: 'Period_to',
  Flotte_Mittel: 'Fleet_mean', Flotte_Quelle: 'Fleet_source', Fahrten_gemessen: 'Trips_measured', Fahrten_je_Tag_hochgerechnet: 'Trips_per_day_extrapolated', Fahrten_je_Fahrzeug_Tag: 'Trips_per_vehicle_day',
  Sperrquote: 'Disabled_rate', Dauer_Mittel_min: 'Duration_mean_min', Distanz_Mittel_km_Luftlinie: 'Distance_mean_km_straight_line', Fahrzeuge_je_1000_EW: 'Vehicles_per_1000_residents',
  Fahrten_je_1000_EW_Tag: 'Trips_per_1000_residents_day', Beobachtet_h: 'Observed_h', Luecken_Laeufe: 'Gap_runs', vorlaeufig: 'preliminary', Hinweis: 'Note', Fahrten_je_Tag_kalibriert: 'Trips_per_day_calibrated',
  Fahrten_je_Tag_kalibriert_von: 'Trips_per_day_calibrated_from', Fahrten_je_Tag_kalibriert_bis: 'Trips_per_day_calibrated_to', Fahrten_je_Fahrzeug_Tag_kalibriert: 'Trips_per_vehicle_day_calibrated',
  Kalibrierfaktor: 'Calibration_factor', Kalibrierung: 'Calibration', Zeitraum_Art: 'Period_type', Zeitraum_Name: 'Period_name', Quartal: 'Quarter', Verfuegbarkeit: 'Availability', Einsatzbereit: 'Ready_to_ride',
  Energieangabe_Fahrzeuge: 'Vehicles_with_energy_data', Gesperrt_Anteil: 'Disabled_share', Reserviert: 'Reserved', Anbieter_Anzahl: 'Operator_count', Tagesmittel_Verfuegbarkeit: 'Daily_mean_availability',
  Tagesminimum_Verfuegbarkeit: 'Daily_min_availability', Zelle: 'Cell', Breite: 'Latitude', Laenge: 'Longitude', Fahrtbeginne: 'Trip_starts', Fahrtenden: 'Trip_ends', Verfuegbar_je_Lauf: 'Available_per_run',
  Umsetzungen: 'Rebalancing',
  // Werte
  alle: 'all', 'alle Anbieter': 'all operators', ja: 'yes', nein: 'no', Alle: 'All', Zeitraum: 'Period', Monat: 'Month', Tage: 'Days', 'Grenze je Anbieter': 'Cap per operator',
  'Anteil an der Gesamtgrenze': 'Share of the total cap', 'Gesamtgrenze, alle Anbieter': 'Total cap, all operators', 'ohne Zulassung laut Quelle': 'not licensed according to source', 'keine Zahl': 'no figure',
  'ohne {x} (unplausibel)': 'without {x} (implausible)', [SUSPENDED_ID()]: 'Calibration suspended – measurement implausible (overcount likely)',
  'unplausibel hoch – Kennungen wechseln vermutlich ohne Fahrt': 'implausibly high – IDs probably rotate without a trip',
  'deutlich mehr Fahrtenden als -beginne (Neuaufstellungen oder Kennungswechsel)': 'clearly more trip ends than starts (redeployments or ID rotation)',
  'weniger als ein Viertel des Tagesgangs beobachtet': 'less than a quarter of the daily profile observed',
};
/** Kopf oder fester Wert in der Sprache der CSV (unbekannte Texte bleiben) */
export const csvText = (s, lang = 'de', vars = null) => { if (lang !== 'en' || s == null) return s; const v = CSV_EN[s] ?? s; return vars ? v.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : v; };
/** Bericht als Tabelle in Langform: je Tag × Anbieter × Art eine Zeile, dazu je Anbieter × Art die Zeitraumwerte (Tag = „Zeitraum“) */
// cal: Ergebnis von pulse-calib calibrateReport (optional) und calLabel (z. B. „Berlin Q4/2025, vorläufig“); period: { kind: 'Quartal'|'Monat'|'Tage', label }
export function reportCsvRows(rep, { name = '', typeLabel = (t) => t, cal = null, calLabel = '', period = null, lang = 'de' } = {}) {
  const X = (v, vars) => csvText(v, lang, vars);
  const head = ['Gemeinde', 'AGS', 'Zeitraum_von', 'Zeitraum_bis', 'Tag', 'Anbieter', 'Fahrzeugart', 'Flotte_Mittel', 'Flotte_Quelle', 'Fahrten_gemessen', 'Fahrten_je_Tag_hochgerechnet', 'Fahrten_je_Fahrzeug_Tag', 'Sperrquote', 'Dauer_Mittel_min', 'Distanz_Mittel_km_Luftlinie', 'Fahrzeuge_je_1000_EW', 'Fahrten_je_1000_EW_Tag', 'Beobachtet_h', 'Luecken_Laeufe', 'vorlaeufig', 'Hinweis',
    'Fahrten_je_Tag_kalibriert', 'Fahrten_je_Tag_kalibriert_von', 'Fahrten_je_Tag_kalibriert_bis', 'Fahrten_je_Fahrzeug_Tag_kalibriert', 'Kalibrierfaktor', 'Kalibrierung', 'Zeitraum_Art', 'Zeitraum_Name', 'Quartal'];
  const rows = [head.map(X)];
  const base = [name, rep.ags, rep.from, rep.to];
  const prelim = X(rep.quality.prelim ? 'ja' : 'nein');
  const pk = X(period?.kind || 'Tage'), pl = period?.label || '';
  const qOf = (d) => (d && /^\d{4}-\d{2}/.test(d) ? `${d.slice(0, 4)}-Q${Math.floor((+d.slice(5, 7) - 1) / 3) + 1}` : '');
  const qSpan = qOf(rep.from) === qOf(rep.to) ? qOf(rep.from) : `${qOf(rep.from)}–${qOf(rep.to)}`;
  const noCal = ['', '', '', '', '', ''];
  for (const d of rep.daily) {
    for (const [k, v] of Object.entries(d.byGroup)) {
      const [op, ty] = k.split('|');
      rows.push([...base, d.day, op, typeLabel(ty), [v.fleet, 1], '', v.rides, '', '', '', '', '', '', '', [d.obsHours, 1], d.gapRuns ?? '', prelim, '', ...noCal, pk, pl, qOf(d.day)]);
    }
  }
  const calCols = (c) => (c?.calibrated ? [[c.ridesDay, 1], [c.lo, 1], [c.hi, 1], [c.rvd, 2], [c.factor, 3], calLabel] : noCal);
  for (const g of rep.groups) {
    rows.push([...base, X('Zeitraum'), g.op, typeLabel(g.ty), [g.fleet, 1], g.fleetSource || '', g.rides, [g.ridesDay, 1], [g.rvd, 2], [g.disabledShare, 3], [g.avgMin, 1], [g.avgKm, 2], [g.per1000Fleet, 2], [g.per1000Rides, 2], [rep.quality.obsMin / 60, 1], rep.quality.gapRuns ?? '', prelim, g.flags.map(f => X(f)).join(' | '), ...calCols(cal?.groups?.get(g.key)), pk, pl, qSpan]);
  }
  const t = rep.totals, ct = cal?.applied ? cal.totals : null;
  rows.push([...base, X('Zeitraum'), X('Alle'), X('Alle'), [t.fleet, 1], '', t.rides, [t.ridesDay, 1], [t.rvd, 2], [t.disabledShare, 3], '', '', [t.per1000Fleet, 2], [t.per1000Rides, 2], [rep.quality.obsMin / 60, 1], rep.quality.gapRuns ?? '', prelim, t.excluded.length ? X('ohne {x} (unplausibel)', { x: t.excluded.join(', ') }).replace('{x}', t.excluded.join(', ')) : '',
    ...(ct ? [[ct.ridesDay, 1], [ct.lo, 1], [ct.hi, 1], [ct.rvd, 2], '', calLabel] : noCal), pk, pl, qSpan]);
  return rows;
}

// ---------- Zeiträume: Monat und Quartal (Tagesdateien 30 Tage, darüber das Langzeit-Archiv) ----------
export const ARCHIVE_FIELDS = ['flotte_avg', 'fahrten', 'fahrtenden', 'kennungswechsel', 'umsetzungen', 'akkutausch', 'abholungen', 'sperren', 'beobachtet_min'];
const MONTHS = { de: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] };
const pad = (n) => String(n).padStart(2, '0');
const lastDayOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m = 1…12
/** Zeitraum 'm:YYYY-MM' oder 'q:YYYY-Qn' → { kind, key, from, to, label }; kind ist eine Kennung ('Monat' | 'Quartal'), label in der Sprache lang */
export function periodRange(period, lang = 'de') {
  let m = /^m:(\d{4})-(\d{2})$/.exec(String(period || ''));
  if (m) { const y = +m[1], mo = +m[2]; return { kind: 'Monat', key: `${m[1]}-${m[2]}`, from: `${m[1]}-${m[2]}-01`, to: `${m[1]}-${m[2]}-${pad(lastDayOfMonth(y, mo))}`, label: `${(MONTHS[lang] || MONTHS.de)[mo - 1]} ${y}` }; }
  m = /^q:(\d{4})-Q([1-4])$/.exec(String(period || ''));
  if (m) { const y = +m[1], q = +m[2], m0 = (q - 1) * 3 + 1, m1 = m0 + 2; return { kind: 'Quartal', key: `${y}-Q${q}`, from: `${y}-${pad(m0)}-01`, to: `${y}-${pad(m1)}-${pad(lastDayOfMonth(y, m1))}`, label: `Q${q}/${y}` }; }
  return null;
}
/** Monate mit Daten: { key 'YYYY-MM', period 'm:…', label, days, complete } (vollständig = Daten reichen vom 1. bis zum Monatsende) */
export function monthsOf(days, lang = 'de') {
  const list = [...new Set(days || [])].filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort(); if (!list.length) return [];
  const by = new Map(); for (const d of list) by.set(d.slice(0, 7), (by.get(d.slice(0, 7)) || 0) + 1);
  return [...by].map(([k, n]) => { const r = periodRange(`m:${k}`, lang); return { key: k, period: `m:${k}`, label: r.label, days: n, complete: list[0] <= r.from && list[list.length - 1] >= r.to }; });
}
/** Quartale, über die die Daten ganz reichen (erster Tag ≤ Quartalsbeginn, letzter Tag ≥ Quartalsende): ['YYYY-Qn', …] */
export function completeQuarters(days) {
  const list = [...new Set(days || [])].filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort(); if (!list.length) return [];
  const out = []; const y0 = +list[0].slice(0, 4), y1 = +list[list.length - 1].slice(0, 4);
  for (let y = y0; y <= y1; y++) for (let q = 1; q <= 4; q++) { const r = periodRange(`q:${y}-Q${q}`); if (list[0] <= r.from && list[list.length - 1] >= r.to) out.push(r.key); }
  return out;
}
export const daysIn = (period, days) => { const r = periodRange(period); return r ? (days || []).filter(d => d >= r.from && d <= r.to).sort() : []; };
/**
 * Bericht aus dem Langzeit-Archiv (archive/<Monat>.json: je Tag und Gemeinde|Anbieter|Art Tageswerte), wenn der Zeitraum über die
 * 30 Tage der Tagesdateien hinausreicht. Gleiche Form wie municipalReport; Hochrechnung linear über die beobachtete Zeit
 * (Tagesgang je Stunde ist im Archiv nicht enthalten), ohne Orte, Dauer, Distanz und Sperrquote.
 */
// breaks/eventChecks wie municipalReport: Tage vor dem Bruch zählen für die Reihe nicht (der Bruchtag zählt ganz – das Archiv hat keine Stundenwerte;
// Marken reichen so weit wie history/daily.json, 30 Tage); rote Gruppen (Ampel) nicht plausibel (AMPEL_RED)
export function archiveReport({ archive = {}, fields = ARCHIVE_FIELDS, ags, pop = null, operator = 'all', type = 'all', days = null, rvdLimit = null, breaks = null, eventChecks = null } = {}) {
  const keep = keyFilter({ ags, operator, type }), ampelRed = mbRedSet(eventChecks);
  const F = (n) => fields.indexOf(n); const iF = F('flotte_avg'), iR = F('fahrten'), iE = F('fahrtenden'), iRl = F('umsetzungen'), iO = F('beobachtet_min');
  const list = (days || Object.keys(archive)).filter(d => archive[d]).sort();
  const G = new Map(); const acc = (op, ty) => { const k = `${op}|${ty}`; if (!G.has(k)) G.set(k, { op, ty, key: k, fleetDays: [], rides: 0, ends: 0, reloc: 0, cov: 0, breakDay: null, breakDays: new Set() }); return G.get(k); };
  const daily = []; let obsT = 0, full = 0;
  for (const day of list) {
    const rows = archive[day] || {}; let obs = 0; for (const v of Object.values(rows)) obs = Math.max(obs, +v?.[iO] || 0);
    const cov = Math.min(1, obs / 1440); obsT += obs; const isFull = obs >= FULL_DAY_HOURS * FULL_HOUR_MIN; if (isFull) full++;
    const row = { day, weekday: weekdayOf(day), obsHours: obs / 60, runs: null, gapRuns: null, coverage: cov, full: isFull, fleet: 0, fleetKnown: false, rides: 0, byGroup: {} };
    for (const [k, v] of Object.entries(rows)) {
      if (!keep(k) || !Array.isArray(v)) continue; const [, op, ty] = k.split('|'); const a = acc(op, ty);
      const bd = breaks?.[k] ?? null; if (bd) { a.breakDay = bd; if (day < bd) { a.breakDays.add(day); continue; } }
      const fleet = v[iF] == null ? null : +v[iF], rides = +v[iR] || 0;
      if (fleet != null) { a.fleetDays.push({ day, fleet }); row.fleet += fleet; row.fleetKnown = true; }
      a.rides += rides; a.ends += +v[iE] || 0; a.reloc += +v[iRl] || 0; if ((fleet || 0) > 0 || rides > 0) a.cov += cov;
      row.rides += rides; row.byGroup[`${op}|${ty}`] = { fleet, rides };
    }
    row.ridesDay = cov > 0 ? row.rides / cov : null; if (!row.fleetKnown) row.fleet = null; daily.push(row);
  }
  const per1000 = (v) => (pop > 0 && v != null ? (v / pop) * 1000 : null);
  const groups = [...G.values()].map(a => {
    const fl = a.fleetDays.map(x => x.fleet); const fleet = fl.length ? sum(fl) / fl.length : null;
    const ridesDay = a.cov > 0 ? a.rides / a.cov : null; const rvd = ridesDay != null && fleet > 0 ? ridesDay / fleet : null;
    const flags = []; if (rvd != null && rvd > DEFAULTS.maxRvd) flags.push('unplausibel hoch – Kennungen wechseln vermutlich ohne Fahrt'); else if (overLimit(rvd, a.ty, rvdLimit)) flags.push(SUSPENDED);
    if (ampelRed.has(`${ags}|${a.key}`)) flags.push(AMPEL_RED);
    return { key: a.key, op: a.op, ty: a.ty, fleet, fleetMin: fl.length ? Math.min(...fl) : null, fleetMax: fl.length ? Math.max(...fl) : null, fleetDays: a.fleetDays, fleetSource: 'Archiv', rides: a.rides, ends: a.ends, reloc: a.reloc,
      coverageDays: a.cov, ridesDay, rvd, disabledShare: null, disabledSource: null, avgMin: null, avgKm: null, durN: 0, distN: 0, per1000Fleet: per1000(fleet), per1000Rides: per1000(ridesDay), plausible: isPlausible(flags), flags,
      breakDay: a.breakDays.size || list.includes(a.breakDay) ? a.breakDay : null, breakSkipped: [...a.breakDays].sort() };
  }).filter(g => (g.fleet || 0) > 0 || g.rides > 0).sort((x, y) => (y.fleet || 0) - (x.fleet || 0) || y.rides - x.rides);
  const good = groups.filter(g => g.plausible); const fleetT = sum(groups.map(g => g.fleet)); const ridesDayT = good.some(g => g.ridesDay != null) ? sum(good.map(g => g.ridesDay)) : null; const fleetGood = sum(good.map(g => g.fleet));
  const totals = { fleet: groups.length ? fleetT : null, rides: sum(groups.map(g => g.rides)), ridesDay: ridesDayT, rvd: ridesDayT != null && fleetGood > 0 ? ridesDayT / fleetGood : null, disabledShare: null,
    per1000Fleet: per1000(groups.length ? fleetT : null), per1000Rides: per1000(ridesDayT), excluded: groups.filter(g => !g.plausible).map(g => g.key) };
  const quality = { source: 'archiv', days: list.length, runs: null, counted: null, gapRuns: null, gaps: [], obsMin: obsT, fullDays: full, excludedHours: 0, taintedDays: [], fleetFromHistory: [], possibleMin: list.length * 1440,
    prelim: full < MIN_FULL_DAYS, profileSource: 'linear über die beobachtete Zeit (Archiv ohne Stundenwerte)', profileDays: 0, longestGapMs: 0,
    breaks: groups.filter(g => g.breakDay).map(g => ({ key: g.key, day: g.breakDay, skipped: g.breakSkipped })) };
  return { ags, pop, from: list[0] || null, to: list[list.length - 1] || null, days: list, quality, groups, totals, daily, cells: cellStats({}, {}) };
}
/** Rangliste aus dem Archiv (je Gemeinde × Art): Ø Flotte, Fahrten/Tag linear hochgerechnet, Fahrten je Fahrzeug und Tag */
// breaks/eventChecks wie archiveReport (Tage vor dem Bruch nicht; rote Gruppen nur bei der Flotte)
export function cityRankingArchive(archive, latest, { fields = ARCHIVE_FIELDS, type = 'all', operator = 'all', days = null, rvdLimit = null, breaks = null, eventChecks = null } = {}) {
  const iF = fields.indexOf('flotte_avg'), iR = fields.indexOf('fahrten'), iO = fields.indexOf('beobachtet_min'), ampelRed = mbRedSet(eventChecks);
  const keep = keyFilter({ ags: 'DE', operator, type }); const list = (days || Object.keys(archive || {})).filter(d => archive?.[d]).sort();
  const G = new Map();
  for (const day of list) {
    const rows = archive[day]; let obs = 0; for (const v of Object.values(rows)) obs = Math.max(obs, +v?.[iO] || 0); const cov = Math.min(1, obs / 1440);
    for (const [k, v] of Object.entries(rows)) { if (!keep(k) || !Array.isArray(v) || (breaks?.[k] && day < breaks[k])) continue; const a = G.get(k) || { fl: [], rides: 0, cov: 0 }; if (v[iF] != null) a.fl.push(+v[iF]); a.rides += +v[iR] || 0; if ((+v[iF] || 0) > 0 || (+v[iR] || 0) > 0) a.cov += cov; G.set(k, a); }
  }
  const by = new Map();
  for (const [k, a] of G) {
    const [ags, , ty] = k.split('|'); const fleet = a.fl.length ? sum(a.fl) / a.fl.length : 0; const rd = a.cov > 0 ? a.rides / a.cov : null; const ok = !(rd != null && fleet > 0 && (rd / fleet > DEFAULTS.maxRvd || overLimit(rd / fleet, ty, rvdLimit))) && !ampelRed.has(k);
    const r = by.get(`${ags}|${ty}`) || { ags, ty, fleet: 0, fleetGood: 0, ridesDay: 0, has: false }; r.fleet += fleet; if (ok) { r.fleetGood += fleet; if (rd != null) { r.ridesDay += rd; r.has = true; } } by.set(`${ags}|${ty}`, r);
  }
  return { days: list, rows: [...by.values()].map(r => ({ key: `${r.ags}|${r.ty}`, ags: r.ags, ty: r.ty, name: latest?.municipalities?.[r.ags]?.name || r.ags, fleet: r.fleet, ridesDay: r.has ? r.ridesDay : null, rvd: r.has && r.fleetGood > 0 ? r.ridesDay / r.fleetGood : null })) };
}
/** Vorquartal für die Rangliste: die zwei jüngsten vollständigen Quartale, wenn sie aufeinanderfolgen; sonst null */
export function rankingQuarters(days) {
  const qs = completeQuarters(days); if (qs.length < 2) return null;
  const cur = qs[qs.length - 1], prev = qs[qs.length - 2];
  const n = (q) => +q.slice(0, 4) * 4 + +q.slice(6) - 1;
  return n(cur) - n(prev) === 1 ? { cur, prev, curDays: daysIn(`q:${cur}`, days), prevDays: daysIn(`q:${prev}`, days) } : null;
}

// ---------- Preisänderungs-Log ----------
const firstArr = (...xs) => xs.find(Array.isArray) || [];
/**
 * Einträge aus pricing-log.json in eine Form bringen: { at, day, operator, munis, plan, field, from, to, kind, sourceId }.
 * Format des Sammlers: { fields: ['at','sourceId','operator','planId','field','old','new'], changes: [[…], …] }; ältere/andere Formen als Rückfall.
 * sources (latest.json): Gebiet über sourceId → municipalities; pricing (pricing.json): Tarifname über sourceId + planId.
 */
export function priceLogEntries(log, { sources = null, pricing = null } = {}) {
  const srcMunis = new Map((sources || []).map(r => [r.id, r.municipalities || []]));
  const planName = new Map(); for (const p of pricing?.plans || []) for (const pl of p.plans || []) planName.set(`${p.sourceId}|${pl.id}`, pl.name);
  const raw = Array.isArray(log) ? log : firstArr(log?.changes, log?.entries, log?.events, log?.log);
  const fields = Array.isArray(log?.fields) ? log.fields : null;
  return raw.map(e => {
    const o = Array.isArray(e) && fields ? Object.fromEntries(fields.map((f, i) => [f, e[i]])) : (e && typeof e === 'object' ? e : {});
    const at = Number.isFinite(+o.at) ? +o.at : Date.parse(o.at || o.date || o.day || '') || null;
    const sourceId = o.sourceId ?? o.source ?? null;
    const munis = Array.isArray(o.municipalities) ? o.municipalities : o.ags ? [o.ags].flat() : (sourceId != null && srcMunis.get(sourceId)) || [];
    const planId = o.planId ?? o.plan_id ?? null;
    const plan = o.plan ?? o.planName ?? o.plan_name ?? (planId != null ? planName.get(`${sourceId}|${planId}`) ?? planId : null) ?? o.name ?? null;
    return { at, day: o.day || (at ? new Date(at).toISOString().slice(0, 10) : null), operator: o.operator ?? o.op ?? null, munis, plan: plan && typeof plan === 'object' ? (plan.name || plan.id || null) : plan,
      field: o.field ?? o.feld ?? null, from: o.old ?? o.from ?? o.before ?? o.alt ?? null, to: o.new ?? o.to ?? o.after ?? o.neu ?? null, kind: o.kind ?? o.type ?? o.change ?? o.art ?? null, sourceId, planId, note: o.note ?? o.desc ?? null };
  }).filter(e => e.operator || e.plan);
}
export function filterPriceLog(entries, { ags = 'DE', operator = 'all' } = {}) {
  return entries.filter(e => (ags === 'DE' || !e.munis.length || e.munis.includes(ags)) && (operator === 'all' || e.operator === operator)).sort((a, b) => (b.at || 0) - (a.at || 0));
}

// ---------- Feed-Prüfung ----------
// Befund als Text: „Datei: Meldung (Anzahl)“ – checkGbfs liefert { level, feed, msg, n? }
const textOf = (x) => {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  const msg = x.msg || x.message || x.text || [x.field || x.path, x.rule || x.code].filter(Boolean).join(' · ');
  const where = x.feed || x.file;
  return msg ? `${where ? `${where}: ` : ''}${msg}${Number.isFinite(+x.n) && x.n != null ? ` (${x.n})` : ''}` : JSON.stringify(x);
};
/** sources[].checks lesen: Listen oder Zählungen von Fehlern und Warnungen, dazu die ersten Befunde */
export function normalizeChecks(checks) {
  if (!checks || typeof checks !== 'object') return null;
  let errors = [], warnings = [], nE = null, nW = null;
  if (Array.isArray(checks)) {
    for (const c of checks) { const lv = String(c?.level || c?.severity || c?.sev || '').toLowerCase(); (/err|fehler|fail|crit/.test(lv) ? errors : warnings).push(textOf(c)); }
  } else {
    const ce = checks.errors ?? checks.fehler, cw = checks.warnings ?? checks.warnungen;
    if (Array.isArray(ce)) errors = ce.map(textOf); else if (Number.isFinite(+ce)) nE = +ce;
    if (Array.isArray(cw)) warnings = cw.map(textOf); else if (Number.isFinite(+cw)) nW = +cw;
    const f = firstArr(checks.findings, checks.befunde, checks.issues, checks.items, checks.first);
    for (const c of f) { const lv = String(c?.level || c?.severity || '').toLowerCase(); (/err|fehler|fail|crit/.test(lv) ? errors : warnings).push(textOf(c)); }
  }
  const findings = [...errors.map(t => ({ level: 'error', text: t })), ...warnings.map(t => ({ level: 'warn', text: t }))].filter(x => x.text);
  return { errors: nE ?? errors.length, warnings: nW ?? warnings.length, findings, label: Array.isArray(checks) ? null : checks.label ?? null, at: checks.at ?? checks.checkedAt ?? null, version: checks.version ?? null };
}

// ---------- Verfügbarkeit je Stadt ----------
// Verfügbarkeit = buchbar ÷ gemeldet (latest.json groups: available ÷ total; buchbar = nicht gesperrt, nicht reserviert,
// bei Stationsfeeds ohne Fahrzeugliste die buchbaren Fahrzeuge an Stationen). Einsatzbereit = buchbar und Energie ausreichend,
// bezogen auf die Fahrzeuge mit Energieangabe (je Fahrzeug aus ops/<Land>.json desselben Sammler-Laufs).
export const MIN_FLEET = 50;
export const RANGE_ONLY_OPS = ['Lime']; // wie app.js: Feeds nur mit Reichweite – der Ladestand im Datenstand ist abgeleitet und zählt nicht
/** Anbieter, die nur Reichweite melden: RANGE_ONLY_OPS und Anbieter, von denen keine Quelle mit Fahrzeugen (live/verzögert) einen Ladestand aus dem
 *  Feed liefert (counts.batteryNative === 0 bei allen). Eine einzelne Quelle ohne Ladestand (z. B. Räder ohne Akku, voi_de) macht den Anbieter nicht
 *  dazu – dort fehlt der Ladestand ohnehin je Fahrzeug bzw. ist abgeleitet (batteryDerived) und zählt je Fahrzeug nur über die Reichweite. */
export function rangeOnlyOperators(sources) {
  const has = new Map();
  for (const r of sources || []) {
    if (!r?.operator || !(r.counts?.vehicles > 0) || !['live', 'delayed'].includes(r.feedStatus || r.status)) continue;
    has.set(r.operator, !!has.get(r.operator) || r.counts.batteryNative !== 0);
  }
  return new Set([...RANGE_ONLY_OPS, ...[...has].filter(([, b]) => !b).map(([op]) => op)]);
}

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
    const obsRaw = hq.obs.reduce((a, m, h) => a + (hq.ok[h] ? m : 0), 0);
    const runsA = (doc.runs || []).filter(Array.isArray), lastEra = breaks && new Set(runsA.map(ruleEra)).size > 1 ? ruleEra(runsA[runsA.length - 1]) : null;
    const late = lastEra ? Array.from({ length: 24 }, (_, h) => runsA.every(r => hourOfMs(r[0]) !== h || ruleEra(r) === lastEra)) : null;
    const keys = new Set([...Object.keys(doc.groups || {}), ...Object.keys(hist?.series || {})].filter(keep));
    for (const k of keys) {
      const bd = breaks?.[k] ?? null; if (bd && doc.day < bd) continue;
      const cut = bd === doc.day && late ? late : null, okH = (h) => hq.ok[h] && (!cut || cut[h]);
      const obsG = cut ? hq.obs.reduce((s, m, h) => s + (okH(h) ? m : 0), 0) : obsRaw;
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
    return { key: `${r.ags}|${r.ty}`, ags: r.ags, name: m.name || r.ags, state: m.state || null, ty: r.ty, fleet: r.fleet, rides: r.rides, ridesDay,
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
  if (!raw.startsWith('{') && !raw.startsWith('[')) { try { raw = (typeof atob === 'function' ? atob(raw) : Buffer.from(raw, 'base64').toString('utf8')).trim(); } catch { return []; } }
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
export function zoneLogUpdate(prev, zones, counts, { at = Date.now(), days = ZONE_LOG_DAYS, runDays = ZONE_RUN_DAYS, flag = 1, carryZero = () => true } = {}) {
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
    }).filter(r => r.now || r.max30).sort((a, b) => (a.op === '*') - (b.op === '*') || (b.now || 0) - (a.now || 0) || a.op.localeCompare(b.op, 'de'));
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
export function zoneCapCheck(d, log, { types = ['scooter'], licensed = () => null, fleet = null, official = true } = {}) {
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
