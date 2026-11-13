// @ts-check
// Mobility Pulse — Bericht – Läufe und Lücken, Regelstand, Heatmap, Kommunal-Bericht (aus pulse-report.js geschnitten; pulse-report.js bleibt die Fassade für alle Importe).
import { GAP_MS, CELL_LAT, CELL_LON } from './pulse-track.js';
import { DEFAULT_PROFILE, DEFAULTS, windowMinutes, startsOf, bootstrapDays } from './pulse-econ.js';
import { hourMinutes } from './pulse-core.js';

export const TZ = 'Europe/Berlin';
export const MIN_FULL_DAYS = 3;                    // darunter ist der Bericht „vorläufig“
export const FULL_HOUR_MIN = 50, FULL_DAY_HOURS = 20; // voller Messtag: ≥ 20 Stunden mit ≥ 50 beobachteten Minuten (wie hourProfile)
export const HEAT_MIN_OBS = 30;                    // Heatmap: Stunde gilt ab 30 beobachteten Minuten als gemessen
export const NEAR_CAP = 0.9;                       // Obergrenze: ab 90 % „nahe“
export const WEAK_MIN_PRESENT = 2;
export const MIN_TRIPS_MEASURED = DEFAULTS.minTripsMeasured; // Ø Dauer/Distanz erst ab so vielen Messungen                 // schwache Orte: im Mittel mindestens 2 verfügbare Fahrzeuge je Lauf
export const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
export const WEEKDAYS_LONG = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];

export const sum = (a) => (a || []).reduce((x, y) => x + (y || 0), 0);
export const zeros = (n) => new Array(n).fill(0);
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
  const obs = zeros(24), obsEnd = zeros(24), n = zeros(24), gap = new Array(24).fill(false);
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
    windowMinutes(r[0], r[1], 'Europe/Berlin', obs); n[h]++; counted++; // anteilig je Stunde (S1.1)
    obsEnd[h] += Math.min(r[1], GAP_MS) / 60e3; // Endstunde: Nenner der Fahrzeugminuten (je Lauf in seiner Endstunde gezählt)
  }
  for (const h of gapHours || []) if (Number.isInteger(h) && h >= 0 && h < 24) gap[h] = true;
  // gezählte Stunde: anteilig beobachtet oder Endstunde eines gezählten Laufs (dessen Fahrtbeginne und Fahrzeugminuten dort stehen), ohne Lücken-Lauf
  const ok = obs.map((m, h) => (m > 0 || obsEnd[h] > 0) && !gap[h]);
  const obsOk = obs.map((m, h) => (ok[h] ? m : 0));
  const fullHours = obsOk.filter(m => m >= FULL_HOUR_MIN).length;
  return { obs, obsEnd, obsOk, ok, gap, n, gaps, counted, tainted, runs: (runs || []).length, fullHours, full: fullHours >= FULL_DAY_HOURS, obsMin: sum(obsOk), excludedHours: gap.filter(Boolean).length };
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
export function weekHeatmap(docs, keep = (..._a) => true, { minObs = HEAT_MIN_OBS, field = 'start' } = {}) {
  const cells = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ sum: 0, raw: 0, n: 0, gapDays: 0, thinDays: 0, dates: [], mean: null })));
  const days = zeros(7), dayList = Array.from({ length: 7 }, () => []);
  for (const doc of docs || []) {
    if (!doc?.day) continue;
    const wd = weekdayOf(doc.day); days[wd]++; dayList[wd].push(doc.day);
    const hq = hourQuality(doc.runs, doc.gapHours), hm = hourMinOf(doc);
    const starts = zeros(24);
    for (const [k, g] of Object.entries(doc.groups || {})) if (keep(k)) { const v = field === 'start' ? startsOf(doc, g) : g[field]; for (let h = 0; h < 24; h++) starts[h] += v?.[h] || 0; }
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
    const starts = zeros(24); for (const g of Object.values(d.groups || {})) { const st = startsOf(d, g); for (let h = 0; h < 24; h++) starts[h] += st?.[h] || 0; }
    for (let h = 0; h < 24; h++) if (hq.obsOk[h] >= FULL_HOUR_MIN) { w[h] += starts[h] / (Math.min(hm[h] || 60, hq.obsOk[h]) / 60); n[h]++; }
  }
  if (days < MIN_FULL_DAYS) return { profile: DEFAULT_PROFILE, source: 'Standardkurve', days };
  const rate = w.map((x, h) => (n[h] ? x / n[h] : 0)); const s = sum(rate);
  return s > 0 ? { profile: rate.map(x => x / s), source: `gemessen (${days} volle Tage)`, days } : { profile: DEFAULT_PROFILE, source: 'Standardkurve', days };
}
/**
 * Sprint 1, A7: Umrechnungsfaktor je Reihe aus dem Schattenbetrieb (shadow/diff-<Tag>.json, gleiche Läufe nach geltender und neuer Regel):
 * Faktor = Fahrtbeginne Kandidat ÷ geltend je Gemeinde|Anbieter|Art über alle übergebenen Tage, ab minRides geltenden Beginnen. Damit lassen
 * sich ältere Tage beim Regelwechsel umrechnen; eine Bruchmarke braucht es dann nur noch bei echten Feed-Sprüngen.
 */
export function shadowFactors(docs, { minRides = 20, field = 'start' } = {}) {
  const sums = new Map();
  for (const d of [].concat(docs || []).filter(Boolean)) { const j = (d.fields || []).indexOf(field); if (j < 0) continue; for (const [k, row] of Object.entries(d.groups || {})) { const s = sums.get(k) || [0, 0]; s[0] += row[j]?.[0] || 0; s[1] += row[j]?.[1] || 0; sums.set(k, s); } }
  const out = {}; for (const [k, [a, b]] of sums) if (a >= minRides) out[k] = Math.round((b / a) * 1000) / 1000;
  return out;
}
/** Anteil des Tagesgangs, der an einem Tag beobachtet wurde (nur Stunden ohne Lücken-Lauf) */
// hourMin: Minuten je Ortsstunde (Umstellungstag: Stunde 2 deckt bis zu 2 Stunden des Tagesgangs ab, wie pulse-econ kpis)
export const dayCoverage = (hq, profile = DEFAULT_PROFILE, hourMin = null) => profile.reduce((a, p, h) => a + p * Math.min((hourMin?.[h] ?? 60) / 60, (hq.obsOk[h] || 0) / 60), 0);
// Fahrzeugminuten nur, wenn jeder Lauf mit Fenster sie gezählt hat (Flag 0/1 vorhanden); sonst Ø Bestand aus dem Verlauf
export const vminCounted = (runs) => (runs || []).every(r => r[1] == null || r[2] === 1 || r[2] === 0);

// Präsenz: Anteil der zählenden Läufe des Tages, in denen die Gruppe einen Wert hat. Unter MIN_PRESENCE (z. B. „Gebündelte“ aus dem
// konflationierten MOBIDROM-Feed in 1 von 16 Läufen) ist die Gruppe unvollständig: ihr Mittel über die Läufe mit Wert wäre eine volle
// Tagesflotte – sie zählt dann weder als Flotte noch in der Sperrquote (incomplete). Fehlende Werte sonst = Ausfall (kein Nullbestand).
export const MIN_PRESENCE = 0.5;
export function histStats(hist, key, { minPresence = MIN_PRESENCE } = {}) {
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
export function SUSPENDED_ID() { return SUSPENDED; }
export const overLimit = (rvd, ty, rvdLimit) => rvd != null && rvdLimit?.[ty] != null && rvd > rvdLimit[ty];
// Ampel rot (latest.json → eventChecks, lib/pulse-econ.js eventChecks): Ereignisregeln der Gruppe am letzten vollständigen Tag nicht plausibel
export const AMPEL_RED = 'ampel-rot';
export const mbRedSet = (ec) => new Set(Object.entries(ec?.groups || {}).filter(([, v]) => v?.level === 'bad').map(([k]) => k));
export const isPlausible = (flags) => !flags.some(f => f.startsWith('unplausibel') || f === SUSPENDED || f === AMPEL_RED);
// breaks: Bruchmarken aus history/daily.json ({ 'Gemeinde|Anbieter|Art': erster Tag mit neuem Regelstand }): Tage davor zählen für diese Reihe
// nicht (Flotte, Fahrten, Hochrechnung); am Bruchtag nur Stunden, deren Läufe alle den letzten Regelstand des Tages tragen. quality.breaks nennt sie.
export function municipalReport({ docs = [], hists = {}, cells = {}, cellRuns = {}, ags = undefined, pop = null, operator = 'all', type = 'all', latestGroups = null, rvdLimit = null, breaks = null, eventChecks = null } = {}) {
  const ampelRed = mbRedSet(eventChecks); // eventChecks: latest.json → eventChecks; rote Gruppen nicht plausibel (AMPEL_RED)
  const keep = keyFilter({ ags, operator, type });
  const list = docs.filter(d => d?.day).sort((a, b) => a.day.localeCompare(b.day));
  const prof = measuredProfile(list);
  const G = new Map(); // op|ty → Akkumulator
  const acc = (op, ty) => { const k = `${op}|${ty}`; if (!G.has(k)) G.set(k, { op, ty, key: k, fleetDays: [], perDay: [], fleetSrc: new Set(), rides: 0, ends: 0, reloc: 0, cov: 0, durSum: 0, durN: 0, distSum: 0, distN: 0, dis: 0, tot: 0, disSrc: null, days: new Set(), incompleteDays: new Set(), breakDay: null, breakDays: new Set(), breakCut: false }); return G.get(k); };
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
    const obsRaw = hq.obsEnd.reduce((a, m, h) => a + (hq.ok[h] ? m : 0), 0); // Nenner der Flotte: Fahrzeugminuten zählen in der Endstunde
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
      const obsG = cut ? hq.obsEnd.reduce((s, m, h) => s + (okH(h) ? m : 0), 0) : obsRaw;
      const covG = cut ? dayCoverage({ ...hq, obsOk: hq.obsOk.map((m, h) => (cut[h] ? m : 0)) }, prof.profile, hourMinOf(doc)) : cov;
      const g = doc.groups?.[k];
      let rides = 0, ends = 0, reloc = 0, vt = 0;
      if (g) for (let h = 0; h < 24; h++) { if (!okH(h)) continue; rides += g.start?.[h] || 0; ends += g.end?.[h] || 0; reloc += g.reloc?.[h] || 0; vt += g.vminTot?.[h] || 0; }
      if (g?.rest && !cut) { rides += g.rest.start || 0; ends += g.rest.end || 0; reloc += g.rest.reloc || 0; } // A20: Tageswert ohne Stunde (Kleinstmengen)
      let fleet = null;
      const hs = cut ? null : histStats(hist, k); // Tagesmittel mischt am Bruchtag beide Stände
      if (vOk && obsG > 0 && vt > 0) { fleet = vt / obsG; a.fleetSrc.add('gemessen'); }
      else if (hs?.incomplete) a.incompleteDays.add(doc.day); // nur in einzelnen Läufen gemeldet: keine Tagesflotte
      else if (hs) { fleet = hs.fleet; a.fleetSrc.add('Verlauf'); histUsed = true; }
      if (hs && !hs.incomplete) { a.dis += hs.disabled; a.tot += hs.total; a.disSrc = 'Verlauf'; }
      const present = (fleet || 0) > 0 || rides > 0;
      if (fleet != null) a.fleetDays.push({ day: doc.day, fleet });
      a.rides += rides; a.ends += ends; a.reloc += reloc;
      if (present) { a.cov += covG; a.days.add(doc.day); a.perDay.push({ day: doc.day, rides, cov: covG, fleet }); }
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
  let groups = [...G.values()].map(/** @returns {any} */ (a) => {
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
    // A8: 90-%-Band für Fahrten je Tag und je Fahrzeug, Bootstrap über ganze Tage (Verhältnis der Summen)
    const rdOf = (s) => { let r = 0, c = 0; for (const d of s) { r += d.rides; c += d.cov; } return c > 0 ? r / c : NaN; };
    const flOf = (s) => { const f = s.filter(d => d.fleet != null); return f.length ? f.reduce((x, d) => x + d.fleet, 0) / f.length : NaN; };
    const ridesDayBand = ridesDay != null ? bootstrapDays(a.perDay, rdOf, { key: `${ags}|${a.key}|r` }) : null;
    const rvdBand = rvd != null ? bootstrapDays(a.perDay, (s) => rdOf(s) / flOf(s), { key: `${ags}|${a.key}|v` }) : null;
    return {
      key: a.key, op: a.op, ty: a.ty, fleet, ridesDayBand, rvdBand, perDay: a.perDay, fleetMin: fl.length ? Math.min(...fl) : null, fleetMax: fl.length ? Math.max(...fl) : null, fleetDays: a.fleetDays,
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
