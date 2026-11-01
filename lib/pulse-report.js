// Mobility Pulse — Kommunal-Bericht, Obergrenzen-Wächter, Wochen-Heatmap, Preis-Log und Feed-Prüfung.
// Reine Rechenfunktionen ohne DOM (Browser und Node). Grundlage: events/<Tag>.json (Stundenwerte, Läufe),
// history/<Tag>.json (Bestand je Lauf), cells/<Tag>/<Land>.json (Zellen), latest.json, reference.json.
import { GAP_MS, CELL_LAT, CELL_LON } from './pulse-track.js';
import { DEFAULT_PROFILE, DEFAULTS } from './pulse-econ.js';
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
export function weekHeatmap(docs, keep = () => true, { minObs = HEAT_MIN_OBS } = {}) {
  const cells = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ sum: 0, raw: 0, n: 0, gapDays: 0, thinDays: 0, dates: [], mean: null })));
  const days = zeros(7), dayList = Array.from({ length: 7 }, () => []);
  for (const doc of docs || []) {
    if (!doc?.day) continue;
    const wd = weekdayOf(doc.day); days[wd]++; dayList[wd].push(doc.day);
    const hq = hourQuality(doc.runs, doc.gapHours);
    const starts = zeros(24);
    for (const [k, g] of Object.entries(doc.groups || {})) if (keep(k)) for (let h = 0; h < 24; h++) starts[h] += g.start?.[h] || 0;
    for (let h = 0; h < 24; h++) {
      const c = cells[wd][h];
      if (hq.gap[h]) { c.gapDays++; continue; }
      if (hq.obs[h] < minObs) { if (hq.obs[h] > 0) c.thinDays++; continue; }
      c.sum += starts[h] * 60 / Math.min(60, hq.obs[h]); c.raw += starts[h]; c.n++; c.dates.push(doc.day);
    }
  }
  let max = 0, measured = 0;
  for (const row of cells) for (const c of row) { if (c.n) { c.mean = c.sum / c.n; measured++; if (c.mean > max) max = c.mean; } }
  return { cells, days, dayList, max, measured };
}

// ---------- Kommunal-Bericht ----------
/** Tagesgang (Anteil je Stunde) aus vollen Messtagen; unter MIN_FULL_DAYS die Standardkurve der Umsatzschätzung */
export function measuredProfile(docs) {
  const w = zeros(24), n = zeros(24); let days = 0;
  for (const d of docs || []) {
    if (!d) continue; const hq = hourQuality(d.runs, d.gapHours); if (!hq.full) continue; days++;
    const starts = zeros(24); for (const g of Object.values(d.groups || {})) for (let h = 0; h < 24; h++) starts[h] += g.start?.[h] || 0;
    for (let h = 0; h < 24; h++) if (hq.obsOk[h] >= FULL_HOUR_MIN) { w[h] += starts[h] / (Math.min(60, hq.obsOk[h]) / 60); n[h]++; }
  }
  if (days < MIN_FULL_DAYS) return { profile: DEFAULT_PROFILE, source: 'Standardkurve', days };
  const rate = w.map((x, h) => (n[h] ? x / n[h] : 0)); const s = sum(rate);
  return s > 0 ? { profile: rate.map(x => x / s), source: `gemessen (${days} volle Tage)`, days } : { profile: DEFAULT_PROFILE, source: 'Standardkurve', days };
}
/** Anteil des Tagesgangs, der an einem Tag beobachtet wurde (nur Stunden ohne Lücken-Lauf) */
export const dayCoverage = (hq, profile = DEFAULT_PROFILE) => profile.reduce((a, p, h) => a + p * Math.min(1, (hq.obsOk[h] || 0) / 60), 0);
// Fahrzeugminuten nur, wenn jeder Lauf mit Fenster sie gezählt hat (Flag 0/1 vorhanden); sonst Ø Bestand aus dem Verlauf
const vminCounted = (runs) => (runs || []).every(r => r[1] == null || r[2] === 1 || r[2] === 0);

function histStats(hist, key) {
  const ser = hist?.series?.[key]; if (!ser?.total) return null;
  const f = hist.f || [];
  let n = 0, total = 0, disabled = 0, available = 0;
  for (let i = 0; i < ser.total.length; i++) {
    if (f[i] === 0 || ser.total[i] == null) continue;
    n++; total += ser.total[i]; disabled += ser.disabled?.[i] || 0; available += ser.available?.[i] || 0;
  }
  return n ? { n, fleet: total / n, total, disabled, available: available / n } : null;
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
  for (const [k, byDay] of Object.entries(daily.series)) { const v = byDay?.[day]; if (!v) continue; series[k] = { total: [v[fi.total]], available: [fi.available != null ? v[fi.available] : null], disabled: [fi.disabled != null ? v[fi.disabled] : 0] }; }
  return { day, t: [null], f: [1], series, fromDaily: true };
}

/**
 * Kennzahlen einer Gemeinde über mehrere Tage.
 * docs: Tagesdokumente events/<Tag>.json (aufsteigend); hists: { Tag → history/<Tag>.json } (optional, für Flotte und Sperrquote);
 * cells: { Tag → { zelle → [start,end,present,reloc,…] } } der Gemeinde, cellRuns: { Tag → Läufe der Zellendatei };
 * latestGroups: latest.json groups (Ersatz, wenn nichts gemessen ist); pop: Einwohner.
 */
export function municipalReport({ docs = [], hists = {}, cells = {}, cellRuns = {}, ags, pop = null, operator = 'all', type = 'all', latestGroups = null } = {}) {
  const keep = keyFilter({ ags, operator, type });
  const list = docs.filter(d => d?.day).sort((a, b) => a.day.localeCompare(b.day));
  const prof = measuredProfile(list);
  const G = new Map(); // op|ty → Akkumulator
  const acc = (op, ty) => { const k = `${op}|${ty}`; if (!G.has(k)) G.set(k, { op, ty, key: k, fleetDays: [], fleetSrc: new Set(), rides: 0, ends: 0, reloc: 0, cov: 0, durSum: 0, durN: 0, distSum: 0, distN: 0, dis: 0, tot: 0, disSrc: null, days: new Set() }); return G.get(k); };
  const daily = [];
  const q = { days: list.length, runs: 0, counted: 0, gapRuns: 0, gaps: [], obsMin: 0, fullDays: 0, excludedHours: 0, taintedDays: [], fleetFromHistory: [] };
  for (const doc of list) {
    const hq = hourQuality(doc.runs, doc.gapHours);
    const cov = dayCoverage(hq, prof.profile);
    const vOk = vminCounted(doc.runs);
    const hist = hists[doc.day] || null;
    q.runs += hq.runs; q.counted += hq.counted; q.gapRuns += hq.gaps.length; q.obsMin += hq.obsMin; q.excludedHours += hq.excludedHours;
    for (const g of hq.gaps) q.gaps.push({ ...g, day: doc.day });
    if (hq.full) q.fullDays++;
    const tainted = hq.tainted > 0; if (tainted) q.taintedDays.push(doc.day);
    const obsRaw = hq.obs.reduce((a, m, h) => a + (hq.ok[h] ? m : 0), 0);
    const row = { day: doc.day, weekday: weekdayOf(doc.day), obsHours: hq.obsMin / 60, runs: hq.runs, gapRuns: hq.gaps.length, coverage: cov, full: hq.full, fleet: 0, fleetKnown: false, rides: 0, byGroup: {} };
    const keys = new Set([...Object.keys(doc.groups || {}), ...Object.keys(hist?.series || {})].filter(keep));
    let histUsed = false;
    for (const k of keys) {
      const [, op, ty] = k.split('|'); const a = acc(op, ty);
      const g = doc.groups?.[k];
      let rides = 0, ends = 0, reloc = 0, vt = 0;
      if (g) for (let h = 0; h < 24; h++) { if (!hq.ok[h]) continue; rides += g.start?.[h] || 0; ends += g.end?.[h] || 0; reloc += g.reloc?.[h] || 0; vt += g.vminTot?.[h] || 0; }
      let fleet = null;
      if (vOk && obsRaw > 0 && vt > 0) { fleet = vt / obsRaw; a.fleetSrc.add('gemessen'); }
      else { const hs = histStats(hist, k); if (hs) { fleet = hs.fleet; a.fleetSrc.add('Verlauf'); histUsed = true; } }
      const hs = histStats(hist, k); if (hs) { a.dis += hs.disabled; a.tot += hs.total; a.disSrc = 'Verlauf'; }
      const present = (fleet || 0) > 0 || rides > 0;
      if (fleet != null) a.fleetDays.push({ day: doc.day, fleet });
      a.rides += rides; a.ends += ends; a.reloc += reloc;
      if (present) { a.cov += cov; a.days.add(doc.day); }
      if (g && !tainted) { a.durSum += g.tripDurSum || 0; a.durN += g.tripDurN || 0; a.distSum += g.tripDistSum || 0; a.distN += g.tripDistN || 0; }
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
  const groups = [...G.values()].map(a => {
    const fl = a.fleetDays.map(x => x.fleet);
    const fleet = fl.length ? sum(fl) / fl.length : null;
    const ridesDay = a.cov > 0 ? a.rides / a.cov : null;
    const rvd = ridesDay != null && fleet > 0 ? ridesDay / fleet : null;
    const flags = [];
    if (rvd != null && rvd > DEFAULTS.maxRvd) flags.push('unplausibel hoch – Kennungen wechseln vermutlich ohne Fahrt');
    if (a.ends > a.rides * 1.3 && a.rides > 20) flags.push('deutlich mehr Fahrtenden als -beginne (Neuaufstellungen oder Kennungswechsel)');
    const measured = (n) => n >= DEFAULTS.minTripsMeasured;
    return {
      key: a.key, op: a.op, ty: a.ty, fleet, fleetMin: fl.length ? Math.min(...fl) : null, fleetMax: fl.length ? Math.max(...fl) : null, fleetDays: a.fleetDays,
      fleetSource: [...a.fleetSrc].join(' + ') || null, rides: a.rides, ends: a.ends, reloc: a.reloc, coverageDays: a.cov, ridesDay, rvd,
      disabledShare: a.tot > 0 ? a.dis / a.tot : null, disabledSource: a.disSrc,
      avgMin: measured(a.durN) ? a.durSum / a.durN / 60e3 : null, avgKm: measured(a.distN) ? a.distSum / a.distN / 1000 : null, durN: a.durN, distN: a.distN,
      per1000Fleet: per1000(fleet), per1000Rides: per1000(ridesDay), plausible: !flags.some(f => f.startsWith('unplausibel')), flags,
    };
  }).filter(g => (g.fleet || 0) > 0 || g.rides > 0).sort((x, y) => (y.fleet || 0) - (x.fleet || 0) || y.rides - x.rides);
  const good = groups.filter(g => g.plausible);
  const fleetT = sum(groups.map(g => g.fleet));
  const ridesDayT = good.some(g => g.ridesDay != null) ? sum(good.map(g => g.ridesDay)) : null;
  const fleetGood = sum(good.map(g => g.fleet));
  const disT = groups.reduce((a, g) => a + (g.disabledShare != null && g.fleet ? g.disabledShare * g.fleet : 0), 0);
  const disW = groups.reduce((a, g) => a + (g.disabledShare != null && g.fleet ? g.fleet : 0), 0);
  const totals = {
    fleet: groups.length ? fleetT : null, rides: sum(groups.map(g => g.rides)), ridesDay: ridesDayT,
    rvd: ridesDayT != null && fleetGood > 0 ? ridesDayT / fleetGood : null, disabledShare: disW > 0 ? disT / disW : null,
    per1000Fleet: per1000(groups.length ? fleetT : null), per1000Rides: per1000(ridesDayT), excluded: groups.filter(g => !g.plausible).map(g => g.key),
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
const DISTRICT_KEYS = [['innenstadtbezirke', 'Innenstadtbezirke'], ['zentraleInnenstadt', 'Zentrale Innenstadt']];
/** Gültige Gesamtgrenze zum Zeitpunkt asOf: „ab“ + „gesamtAb“ lösen „gesamt“ ab */
export function capLimit(entry, asOf = Date.now()) {
  const ab = entry?.ab ? Date.parse(`${entry.ab}T00:00:00+01:00`) : null;
  if (ab != null && Number.isFinite(ab) && entry.gesamtAb != null) {
    if (asOf >= ab) return { limit: entry.gesamtAb, since: entry.ab, previous: entry.gesamt ?? null, next: null };
    return { limit: entry.gesamt ?? null, since: entry.seit || null, previous: null, next: { limit: entry.gesamtAb, from: entry.ab } };
  }
  return { limit: entry?.gesamt ?? null, since: entry?.seit || null, previous: null, next: null };
}
/**
 * Bestand gegen Obergrenzen je Gemeinde. groups: latest.json groups; Bestand = alle im Feed gemeldeten Fahrzeuge der Art
 * (verfügbar, reserviert, gesperrt), nach Abgleich der Quellen. Bezirksgrenzen sind ohne Bezirksgeometrie nicht prüfbar.
 */
export function capsCheck(reference, groups, { ags = 'DE', asOf = Date.now() } = {}) {
  const out = [];
  for (const e of reference?.obergrenzen || []) {
    if (!e?.ags || (ags !== 'DE' && e.ags !== ags)) continue;
    const ty = e.type || 'scooter';
    const byOp = new Map();
    for (const [k, st] of Object.entries(groups || {})) {
      const [a, op, t] = k.split('|'); if (a !== e.ags || t !== ty) continue;
      const o = byOp.get(op) || { op, total: 0, available: 0, disabled: 0, reserved: 0 };
      o.total += st.total || 0; o.available += st.available || 0; o.disabled += st.disabled || 0; o.reserved += st.reserved || 0; byOp.set(op, o);
    }
    const lim = capLimit(e, asOf);
    const ops = [...byOp.values()].sort((a, b) => b.total - a.total).map(o => ({ ...o, limit: e.jeAnbieter ?? null, ...capStatus(o.total, e.jeAnbieter) }));
    const total = sum(ops.map(o => o.total));
    const districts = DISTRICT_KEYS.filter(([k]) => e[k] != null).map(([k, label]) => ({ key: k, label, limit: e[k], status: 'unchecked' }));
    out.push({ ags: e.ags, ort: e.ort || e.ags, type: ty, total, ...lim, ...capStatus(total, lim.limit), perOperator: e.jeAnbieter ?? null, operators: ops, districts, quelle: e.quelle || null, url: e.url || null });
  }
  return out;
}

// ---------- CSV ----------
/** Zelle für CSV mit Semikolon: Zahlen mit Dezimalkomma; Text mit = + - @ (auch Tab/CR) am Anfang bekommt ' davor (Formel-Injection) */
export function csvCell(v, digits = null) {
  if (v == null || (typeof v === 'number' && !Number.isFinite(v))) return '';
  let s;
  if (typeof v === 'number') s = (digits == null ? String(+v.toFixed(4)) : v.toFixed(digits)).replace('.', ',');
  else { s = String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; }
  return /[";\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}
export const toCsv = (rows) => rows.map(r => r.map(c => (Array.isArray(c) ? csvCell(c[0], c[1]) : csvCell(c))).join(';')).join('\r\n');
/** Bericht als Tabelle in Langform: je Tag × Anbieter × Art eine Zeile, dazu je Anbieter × Art die Zeitraumwerte (Tag = „Zeitraum“) */
export function reportCsvRows(rep, { name = '', typeLabel = (t) => t } = {}) {
  const head = ['Gemeinde', 'AGS', 'Zeitraum_von', 'Zeitraum_bis', 'Tag', 'Anbieter', 'Fahrzeugart', 'Flotte_Mittel', 'Flotte_Quelle', 'Fahrten_gemessen', 'Fahrten_je_Tag_hochgerechnet', 'Fahrten_je_Fahrzeug_Tag', 'Sperrquote', 'Dauer_Mittel_min', 'Distanz_Mittel_km_Luftlinie', 'Fahrzeuge_je_1000_EW', 'Fahrten_je_1000_EW_Tag', 'Beobachtet_h', 'Luecken_Laeufe', 'vorlaeufig', 'Hinweis'];
  const rows = [head];
  const base = [name, rep.ags, rep.from, rep.to];
  const prelim = rep.quality.prelim ? 'ja' : 'nein';
  for (const d of rep.daily) {
    for (const [k, v] of Object.entries(d.byGroup)) {
      const [op, ty] = k.split('|');
      rows.push([...base, d.day, op, typeLabel(ty), [v.fleet, 1], '', v.rides, '', '', '', '', '', '', '', [d.obsHours, 1], d.gapRuns, prelim, '']);
    }
  }
  for (const g of rep.groups) {
    rows.push([...base, 'Zeitraum', g.op, typeLabel(g.ty), [g.fleet, 1], g.fleetSource || '', g.rides, [g.ridesDay, 1], [g.rvd, 2], [g.disabledShare, 3], [g.avgMin, 1], [g.avgKm, 2], [g.per1000Fleet, 2], [g.per1000Rides, 2], [rep.quality.obsMin / 60, 1], rep.quality.gapRuns, prelim, g.flags.join(' | ')]);
  }
  const t = rep.totals;
  rows.push([...base, 'Zeitraum', 'Alle', 'Alle', [t.fleet, 1], '', t.rides, [t.ridesDay, 1], [t.rvd, 2], [t.disabledShare, 3], '', '', [t.per1000Fleet, 2], [t.per1000Rides, 2], [rep.quality.obsMin / 60, 1], rep.quality.gapRuns, prelim, t.excluded.length ? `ohne ${t.excluded.join(', ')} (unplausibel)` : '']);
  return rows;
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
export const RANGE_ONLY_OPS = ['Lime']; // wie app.js: Feeds nur mit Reichweite – „niedrig“ relativ zur üblichen Reichweite
export const RANGE_REL = 0.25;          // niedrig = unter ¼ des 95. Perzentils der Reichweite des Anbieters

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
const p95 = (arr) => { const v = arr.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.floor(0.95 * (v.length - 1))] : null; };
/**
 * Einsatzbereitschaft je Gemeinde aus ops/<Land>.json (je Fahrzeug Flags, Ladestand, Reichweite).
 * Energie ausreichend: Ladestand ≥ charge; ohne Ladestand Reichweite ≥ range km; Anbieter nur mit Reichweite (rangeOnly):
 * Reichweite ≥ ¼ des 95. Perzentils dieses Anbieters im Land. Ohne Angabe zählt das Fahrzeug nicht (known).
 * Rückgabe Map ags → { total, known, ready, okEnergy }.
 */
export function readinessFromOps(opsDoc, { operator = 'all', type = 'all', charge = 20, range = 5, rangeOnly = (op) => RANGE_ONLY_OPS.includes(op) } = {}) {
  const out = new Map(); if (!opsDoc?.vehicles) return out;
  const F = String(opsDoc.vehicleFields || '').split(/,(?![^(]*\))/); // Kommas in Klammern („flags(1=reserviert,2=gesperrt)“) trennen nicht
  const at = (name, d) => { const i = F.findIndex(f => f.startsWith(name)); return i >= 0 ? i : d; };
  const iOp = at('op', 2), iTy = at('type', 3), iFl = at('flags', 4), iBat = at('akku', 5), iRg = at('reichweite', 6), iMu = at('gemeinde', 8);
  const ops = opsDoc.ops || [], types = opsDoc.types || [], munis = opsDoc.munis || [];
  const rel = new Map(); // Anbieter → Schwelle (km) für reine Reichweite-Feeds
  const rg = new Map(); for (const v of opsDoc.vehicles) { const op = ops[v[iOp]]; if (rangeOnly(op) && v[iRg] != null) { if (!rg.has(op)) rg.set(op, []); rg.get(op).push(+v[iRg]); } }
  for (const [op, list] of rg) { const p = p95(list); if (p > 0) rel.set(op, RANGE_REL * p); }
  for (const v of opsDoc.vehicles) {
    const op = ops[v[iOp]], ty = types[v[iTy]] ?? 'unknown', ags = munis[v[iMu]];
    if (!ags || (operator !== 'all' && op !== operator) || (type !== 'all' && ty !== type)) continue;
    const o = out.get(ags) || { total: 0, known: 0, ready: 0, okEnergy: 0 }; o.total++;
    const bookable = !((v[iFl] || 0) & 3); // 1 = reserviert, 2 = gesperrt
    let ok = null;
    if (rangeOnly(op)) { if (v[iRg] != null && rel.has(op)) ok = +v[iRg] >= rel.get(op); }
    else if (v[iBat] != null) ok = +v[iBat] >= charge;
    else if (v[iRg] != null) ok = +v[iRg] >= range;
    if (ok != null) { o.known++; if (ok) { o.okEnergy++; if (bookable) o.ready++; } }
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
export function availabilityCsvRows(rows, { operator = 'all', type = 'all', at = null, typeLabel = (t) => t, day = null } = {}) {
  const head = ['AGS', 'Stadt', 'Land', 'Anbieter_Filter', 'Fahrzeugart_Filter', 'Gemeldet', 'Buchbar', 'Verfuegbarkeit', 'Einsatzbereit', 'Energieangabe_Fahrzeuge', 'Gesperrt_Anteil', 'Reserviert', 'Anbieter_Anzahl', 'Anbieter', 'Tagesmittel_Verfuegbarkeit', 'Tagesminimum_Verfuegbarkeit', 'Sammler_Punkte', 'Tag', 'Stand'];
  const stand = at ? new Date(at).toISOString() : '';
  return [head, ...rows.map(r => [r.ags, r.name, r.state || '', operator === 'all' ? 'alle' : operator, type === 'all' ? 'alle' : typeLabel(type), r.total, r.available, [r.avail, 4], [r.ready, 4], r.readyKnown ?? '', [r.disabledShare, 4], r.reserved, r.opCount, r.operators.join(', '), [r.dayMean, 4], [r.dayMin, 4], r.dayN ?? '', day || '', stand])];
}

// ---------- Datenschutz-Schwelle ----------
export const MIN_COUNT = 2; // Orte/Zellen mit weniger als 2 Fahrten werden als „< 2“ ausgewiesen (Schwelle wie Portland)
export const suppressed = (v, min = MIN_COUNT) => v != null && Number.isFinite(+v) && +v < min;
/** Orte als CSV-Zeilen: Zählungen unter der Schwelle als „<2“ */
export function cellsCsvRows(cs, { ags = '', name = '', from = '', to = '', minCount = MIN_COUNT } = {}) {
  const m = (v) => (suppressed(v, minCount) ? `<${minCount}` : v);
  return [['Gemeinde', 'AGS', 'Zeitraum_von', 'Zeitraum_bis', 'Zelle', 'Breite', 'Laenge', 'Fahrtbeginne', 'Fahrtenden', 'Verfuegbar_je_Lauf', 'Umsetzungen'],
    ...[...cs.grid].sort((a, b) => b.start + b.end - (a.start + a.end)).map(c => [name, ags, from, to, c.cell, [c.lat, 5], [c.lon, 5], m(c.start), m(c.end), [c.presAvg, 1], m(c.reloc)])];
}

// ---------- Städte-Rangliste (je Stadt × Fahrzeugart) ----------
// je Schlüssel Gemeinde|Anbieter|Art: gemessene Fahrten (ohne Lücken-Stunden), Tagesflotte, beobachteter Anteil des Tagesgangs
function accumulate(list, hists, keep, profile) {
  const G = new Map();
  for (const doc of list) {
    const hq = hourQuality(doc.runs, doc.gapHours), cov = dayCoverage(hq, profile), vOk = vminCounted(doc.runs), hist = hists?.[doc.day] || null;
    const obsRaw = hq.obs.reduce((a, m, h) => a + (hq.ok[h] ? m : 0), 0);
    const keys = new Set([...Object.keys(doc.groups || {}), ...Object.keys(hist?.series || {})].filter(keep));
    for (const k of keys) {
      const g = doc.groups?.[k]; let rides = 0, vt = 0;
      if (g) for (let h = 0; h < 24; h++) if (hq.ok[h]) { rides += g.start?.[h] || 0; vt += g.vminTot?.[h] || 0; }
      let fleet = null;
      if (vOk && obsRaw > 0 && vt > 0) fleet = vt / obsRaw; else { const hs = histStats(hist, k); if (hs) fleet = hs.fleet; }
      const a = G.get(k) || { fleetDays: [], rides: 0, cov: 0 };
      if (fleet != null) a.fleetDays.push(fleet);
      a.rides += rides; if ((fleet || 0) > 0 || rides > 0) a.cov += cov; G.set(k, a);
    }
  }
  return G;
}
/**
 * Rangliste je Gemeinde × Fahrzeugart über die Tagesdateien: Ø Flotte, Fahrten/Tag (hochgerechnet), Fahrten je Fahrzeug und Tag,
 * je 1.000 Einwohner. Anbieter mit unplausibler Quote (> 15) zählen nur bei der Flotte, nicht bei den Fahrten.
 */
export function cityRanking(docs, hists, latest, { type = 'all', operator = 'all', minFleet = MIN_FLEET } = {}) {
  const list = (docs || []).filter(d => d?.day).sort((a, b) => a.day.localeCompare(b.day));
  const prof = measuredProfile(list);
  const G = accumulate(list, hists, keyFilter({ ags: 'DE', operator, type }), prof.profile);
  const by = new Map();
  for (const [k, a] of G) {
    const [ags, op, ty] = k.split('|');
    const fleet = a.fleetDays.length ? sum(a.fleetDays) / a.fleetDays.length : 0;
    const ridesDay = a.cov > 0 ? a.rides / a.cov : null;
    const ok = !(ridesDay != null && fleet > 0 && ridesDay / fleet > DEFAULTS.maxRvd);
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
