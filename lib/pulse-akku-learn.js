// Mobility Pulse – S6.5 Akku-Prognose, Lernen und Selbstprüfung im Sammler (nur Sammler und Tests; die Seite braucht lib/pulse-akku.js).
// Zustand privat im Track-Verzeichnis (akku-state.json.gz, gesalzene Kennungen wie state.json.gz) – veröffentlicht werden nur Kennzahlen je
// Anbieter und Art, Zonen-Summen und die Trefferquote je Nacht (akku/<AGS>.json, akku/bewertung.json), keine Fahrzeughistorien.
// Lernen je Lauf (Abstand 5–45 Minuten), Summen mit Halbwertszeit 7 Tage:
//   Standzeit: am Ort (< 50 m), Ladestand −2 … +10 Punkte → drop += Δ, h += Stunden
//   Fahrt:     stabile Kennung 200 m … 15 km versetzt (auch Rückkehr nach Verschwinden), Ladestand 1 … 40 Punkte gesunken → tripDrop += Δ, trips += 1
//   Fahrten je verfügbarer Fahrzeugstunde je Ortsstunde: verschwunden (nicht ausgeblendet: Ladestand > Untergrenze + 5) oder versetzt = Beginn
// Selbstprüfung: erster Lauf ab 20 Uhr legt die Prognose für morgen 8 Uhr ab (Fahrzeuge mit 20–49 %), erster Lauf ab 8 Uhr prüft sie:
//   da mit Ladestand: unter 20 %? Ladestand ≥ 15 Punkte gestiegen = getauscht (zählt nicht); weg mit letztem Ladestand ≤ Untergrenze + 5 =
//   ausgeblendet (unter 20 %); sonst weg = unbekannt (gefahren oder abgeholt, zählt nicht). Vergleich: Regel „heute Abend unter 25 %“.
import { haversineM } from './pulse-core-base.js';
import { F_BATREL, F_DISABLED, F_MISSING, F_RESERVED, dayOf } from './pulse-track-rules.js';
import { AKKU, AKKU_BASIS, clockOf, forecastVehicle, scores, slotsUntil } from './pulse-akku.js';

// tripMin 1: versetzt ohne Ladestandsverlust ist meist ein Umsetzen im Transporter (erster echter Lauf 14.11.2026: Dott 0,9, Voi 0,5 Punkte je „Fahrt“)
export const LEARN = Object.freeze({ halfLifeDays: 7, minGapMin: 5, maxGapMin: 45, stayM: 50, moveM: 200, tripMaxM: 15000, dropMin: -2, dropMax: 10, tripMin: 1, tripMax: 40,
  minDrainH: 200, minTrips: 30, rateK: 5, minRateH: 20, massLoss: 0.3, massMin: 20, keepBelow: 50, swapUp: 15, hideBand: 5, floorDefault: 15,
  evalUntilHour: 10, keepNights: 60, baseRule: 25 });
export const AKKU_STATE_V = 1;
export function emptyAkkuState() { return { version: AKKU_STATE_V, at: null, g: {}, r: {}, fc: null, nights: [] }; }

const r3 = (x) => Math.round(x * 1000) / 1000;
const absBat = (b) => (b != null && Number.isFinite(b) ? Math.round(b) : null);

/** Schnappschuss aus dem Verfolgungszustand (state.v: [lat·1e5, lon·1e5, Ladestand, Flags, Art, Anbieter-Index, Gemeinde-Index, …]) */
export function snapFromTrack(state) {
  const m = new Map(), d = state?.dict || {};
  for (const [k, e] of Object.entries(state?.v || {})) {
    const fl = e[3] || 0;
    m.set(k, { lat: e[0] / 1e5, lon: e[1] / 1e5, bat: fl & F_BATREL ? null : absBat(e[2]), dis: !!(fl & F_DISABLED), res: !!(fl & F_RESERVED), missing: !!(fl & F_MISSING), ty: e[4], op: d.op?.[e[5]], ags: d.ags?.[e[6]] });
  }
  return m;
}
/** Schnappschuss aus den Fahrzeugen eines Laufs (nur absoluter Ladestand; abgeleitet oder unplausible Skala zählt nicht) */
export function snapFromVehicles(vehicles, keyOf) {
  const m = new Map();
  for (const v of vehicles || []) {
    const bat = v.batteryDerived ? null : absBat(v.batteryPct); if (bat == null) continue;
    m.set(keyOf(v.operator, v.rawId), { lat: v.lat, lon: v.lon, bat, dis: !!v.disabled, res: !!v.reserved, missing: false, ty: v.type || 'unknown', op: v.operator, ags: v.ags });
  }
  return m;
}

/** Untergrenze der Ausblendung je Anbieter (größte der Quellen, die ausblenden), sonst floorDefault */
export const floorOf = (floors, op) => (floors && Number.isFinite(floors[op]) ? floors[op] : LEARN.floorDefault);

/** ein Lernschritt zwischen zwei Schnappschüssen (prev zur Zeit prevAt, cur zur Zeit now); verändert st */
export function learnStep(st, prev, cur, { prevAt, now, floors = null, tz = AKKU.tz }) {
  const dtMs = prevAt != null ? now - prevAt : null;
  if (st.at != null && now > st.at) { const f = Math.pow(0.5, (now - st.at) / (LEARN.halfLifeDays * 86400e3)); for (const a of Object.values(st.g)) for (let i = 0; i < a.length; i++) a[i] *= f; for (const a of Object.values(st.r)) for (let i = 0; i < a.length; i++) a[i] *= f; }
  st.at = now;
  if (!prev || dtMs == null || dtMs < LEARN.minGapMin * 60e3 || dtMs > LEARN.maxGapMin * 60e3) return { learned: false };
  const dtH = dtMs / 3600e3, hour = clockOf(prevAt, tz)[0];
  const G = (op, ty) => (st.g[`${op}|${ty}`] ??= [0, 0, 0, 0]), R = (ags, op, ty) => (st.r[`${ags}|${op}|${ty}`] ??= new Array(48).fill(0));
  // Ausfall-Schutz: verliert eine Gruppe (Anbieter|Gemeinde) in einem Lauf mehr als 30 % ihrer Fahrzeuge, zählt ihr Verschwinden nicht
  const present = new Map(), gone = new Map();
  for (const [k, p] of prev) { if (p.missing || p.bat == null) continue; const gk = `${p.op}|${p.ags}`; present.set(gk, (present.get(gk) || 0) + 1); if (!cur.has(k)) gone.set(gk, (gone.get(gk) || 0) + 1); }
  const outage = (gk) => (present.get(gk) || 0) >= LEARN.massMin && (gone.get(gk) || 0) / present.get(gk) > LEARN.massLoss;
  let stays = 0, trips = 0, starts = 0;
  for (const [k, p] of prev) {
    if (p.bat == null || p.op == null) continue;
    const c = cur.get(k);
    if (!p.missing && !p.dis && !p.res) R(p.ags, p.op, p.ty)[24 + hour] += dtH; // verfügbare Fahrzeugstunden im Abschnitt
    if (!c) {
      if (!p.missing && !p.dis && !p.res && p.bat > floorOf(floors, p.op) + LEARN.hideBand && !outage(`${p.op}|${p.ags}`)) { R(p.ags, p.op, p.ty)[hour]++; starts++; }
      continue;
    }
    const d = p.bat - c.bat, dist = haversineM(p.lat, p.lon, c.lat, c.lon);
    if (!p.missing && dist < LEARN.stayM && d >= LEARN.dropMin && d <= LEARN.dropMax && !c.res) { const a = G(p.op, p.ty); a[0] += d; a[1] += dtH; stays++; }
    else if (dist >= LEARN.moveM && dist <= LEARN.tripMaxM && d >= LEARN.tripMin && d <= LEARN.tripMax && !p.dis && !c.dis) {
      const a = G(p.op, p.ty); a[2] += d; a[3]++; trips++;
      if (!p.missing && !p.res) { R(p.ags, p.op, p.ty)[hour]++; starts++; } // stabile Kennung blieb während der Fahrt im Feed
    }
  }
  return { learned: true, stays, trips, starts, hour, dtH };
}

/**
 * Modelle je Gruppe aus dem Zustand: drain/trip je Anbieter|Art, sonst je Art über alle Anbieter, sonst Startwert; Raten geglättet
 * @returns {(ags: string, op: string, ty: string) => { drain: number, trip: number, basisDrain: string, basisTrip: string, rate: number[] }}
 */
export function modelsOf(st) {
  const byType = {}, rateOp = {};
  for (const [k, a] of Object.entries(st.g)) { const ty = k.slice(k.lastIndexOf('|') + 1), t = (byType[ty] ??= [0, 0, 0, 0]); for (let i = 0; i < 4; i++) t[i] += a[i]; }
  for (const [k, a] of Object.entries(st.r)) { const i = k.indexOf('|'), g = k.slice(i + 1), t = (rateOp[g] ??= new Array(48).fill(0)); for (let j = 0; j < 48; j++) t[j] += a[j]; }
  /** @type {(op: string, ty: string) => [number, string]} */
  const drainOf = (op, ty) => { const a = st.g[`${op}|${ty}`], t = byType[ty]; return a && a[1] >= LEARN.minDrainH ? [Math.max(0, a[0] / a[1]), AKKU_BASIS.group] : t && t[1] >= LEARN.minDrainH ? [Math.max(0, t[0] / t[1]), AKKU_BASIS.type] : [AKKU.drainStart, AKKU_BASIS.start]; };
  /** @type {(op: string, ty: string) => [number, string]} */
  const tripOf = (op, ty) => { const a = st.g[`${op}|${ty}`], t = byType[ty]; return a && a[3] >= LEARN.minTrips ? [a[2] / a[3], AKKU_BASIS.group] : t && t[3] >= LEARN.minTrips ? [t[2] / t[3], AKKU_BASIS.type] : [AKKU.tripStart, AKKU_BASIS.start]; };
  const rateOf = (a) => { const s = a.slice(0, 24).reduce((x, y) => x + y, 0), h = a.slice(24).reduce((x, y) => x + y, 0), prior = h > 0 ? s / h : 0; return a.slice(0, 24).map((x, i) => (x + prior * LEARN.rateK) / (a[24 + i] + LEARN.rateK)); };
  /** Modell für Gemeinde|Anbieter|Art */
  return (ags, op, ty) => {
    const [drain, bd] = drainOf(op, ty), [trip, bt] = tripOf(op, ty);
    const a = st.r[`${ags}|${op}|${ty}`], vh = a ? a.slice(24).reduce((x, y) => x + y, 0) : 0, base = vh >= LEARN.minRateH ? a : rateOp[`${op}|${ty}`];
    return { drain, trip, basisDrain: bd, basisTrip: bt, rate: base ? rateOf(base) : new Array(24).fill(0) };
  };
}
export const packModel = (m) => [r3(m.drain), r3(m.trip), m.basisDrain, m.basisTrip, ...m.rate.map(x => Math.round(x * 1e4) / 1e4)];

/** Abend: Prognose für morgen 8 Uhr ablegen (einmal je Tag, erster Lauf ab eveningHour) */
export function storeForecast(st, cur, now, modelOf, { tz = AKKU.tz } = {}) {
  const [h] = clockOf(now, tz), day = dayOf(now, tz);
  if (h < AKKU.eveningHour || st.fc?.day === day) return null;
  const { slots, target } = slotsUntil(now, { tz }), items = {};
  for (const [k, c] of cur) {
    if (c.dis || c.res || c.bat < AKKU.low || c.bat >= LEARN.keepBelow) continue;
    const f = forecastVehicle(c.bat, modelOf(c.ags, c.op, c.ty), slots);
    items[k] = [c.bat, Math.round(f.p * 100), c.op, c.bat]; // [Ladestand am Abend, p in %, Anbieter, zuletzt gesehener Ladestand]
  }
  st.fc = { day, at: now, target, items };
  return st.fc;
}

/** je Lauf zwischen Abend und Morgen: zuletzt gesehenen Ladestand der abgelegten Fahrzeuge fortschreiben (für „ausgeblendet“ am Morgen) */
export function followForecast(st, cur) {
  if (!st.fc) return 0; let n = 0;
  for (const [k, it] of Object.entries(st.fc.items)) { const c = cur.get(k); if (c) { it[3] = c.bat; n++; } }
  return n;
}

/**
 * Morgen: Prognose prüfen (erster Lauf ab targetHour bis evalUntilHour am Folgetag). cur = Fahrzeuge jetzt (snapFromVehicles), floors je
 * Anbieter. Verschwundene: zuletzt gesehener Ladestand (followForecast). Ergebnis der Nacht (nur Zählwerte).
 * @returns {any}
 */
export function evaluateForecast(st, cur, now, { floors = null, tz = AKKU.tz } = {}) {
  const fc = st.fc; if (!fc) return null;
  const [h] = clockOf(now, tz), day = dayOf(now, tz);
  if (day === fc.day || now < fc.target) return null;
  if (h >= LEARN.evalUntilHour || now - fc.target > 2 * 3600e3) { st.fc = null; return { day: fc.day, late: true }; }
  const c = { tp: 0, fp: 0, fn: 0, tn: 0 }, base = { tp: 0, fp: 0, fn: 0, tn: 0 }, byOp = {};
  let swapped = 0, unknown = 0, hidden = 0;
  for (const [k, [bat0, p100, op, seen]] of Object.entries(fc.items)) {
    const now1 = cur.get(k); let under;
    if (now1) { if (now1.bat >= bat0 + LEARN.swapUp) { swapped++; continue; } under = now1.bat < AKKU.low; }
    else if ((seen ?? bat0) <= floorOf(floors, op) + LEARN.hideBand) { under = true; hidden++; } else { unknown++; continue; }
    const pred = p100 >= AKKU.pCut * 100, rule = bat0 < LEARN.baseRule, o = (byOp[op] ??= { tp: 0, fp: 0, fn: 0, tn: 0 });
    for (const [x, pr] of [[c, pred], [o, pred], [base, rule]]) x[pr ? (under ? 'tp' : 'fp') : (under ? 'fn' : 'tn')]++;
  }
  st.fc = null;
  const s = scores(c), sb = scores(base);
  return { day: fc.day, at: now, ...c, swapped, unknown, hidden, precision: s.precision, recall: s.recall, base: { ...base, precision: sb.precision, recall: sb.recall }, byOp };
}

/** Summe über Nächte */
export function totalOf(nights) {
  const t = { nights: 0, tp: 0, fp: 0, fn: 0, tn: 0, swapped: 0, unknown: 0, hidden: 0, base: { tp: 0, fp: 0, fn: 0, tn: 0 } };
  for (const n of nights || []) { if (n.late) continue; t.nights++; for (const k of ['tp', 'fp', 'fn', 'tn', 'swapped', 'unknown', 'hidden']) t[k] += n[k] || 0; for (const k of ['tp', 'fp', 'fn', 'tn']) t.base[k] += n.base?.[k] || 0; }
  const s = scores(t), sb = scores(t.base);
  return { ...t, precision: s.precision, recall: s.recall, base: { ...t.base, precision: sb.precision, recall: sb.recall } };
}

/**
 * Rückblick auf die goldenen Tage (TRACK_DIR/golden/<Tag>.jsonl.gz, je Lauf { at, fields, groups: { 'Anbieter|AGS': [[key, lat, lon, bat,
 * flags, type, source, station], …] } }): derselbe Ablauf wie im Betrieb, Lauf für Lauf ohne Blick nach vorn. Untergrenze der Ausblendung je
 * Anbieter = 0,5-%-Quantil der Ladestände, wenn ≥ 10 (sonst blendet die Quelle nicht aus). Ohne Anbieter in skipOps (Ladestand nur aus der
 * Reichweite, latest.energy.rangeOnlyOps – im Betrieb zählen sie ebenfalls nicht) und ohne Zeilen mit Bit 4. Ergebnis: Nächte wie evaluateForecast.
 */
export function backtestGolden(runs, { tz = AKKU.tz, skipOps = [] } = {}) {
  const skip = new Set(skipOps || []);
  const st = emptyAkkuState(), nights = [], bats = {};
  const sorted = [...(runs || [])].filter(r => r?.groups).sort((a, b) => a.at - b.at);
  const usable = (op, x) => x[3] != null && !(x[4] & 4) && !skip.has(op); // Bit 4 = Ladestand aus der Reichweite abgeleitet (ab 14.11.2026)
  for (const r of sorted) for (const [g, rows] of Object.entries(r.groups)) { const op = g.slice(0, g.indexOf('|')); for (const x of rows) if (usable(op, x)) (bats[op] ??= []).push(x[3]); }
  const floors = {}; for (const [op, a] of Object.entries(bats)) { a.sort((x, y) => x - y); const q = a[Math.floor(a.length * 0.005)]; if (a.length >= 500 && q >= 10) floors[op] = q; }
  let prev = null, prevAt = null;
  for (const r of sorted) {
    const cur = new Map();
    for (const [g, rows] of Object.entries(r.groups)) {
      const i = g.indexOf('|'), op = g.slice(0, i), ags = g.slice(i + 1);
      for (const x of rows) if (usable(op, x)) cur.set(x[0], { lat: x[1], lon: x[2], bat: Math.round(x[3]), dis: !!(x[4] & 1), res: !!(x[4] & 2), missing: false, ty: x[5] || 'unknown', op, ags });
    }
    learnStep(st, prev, cur, { prevAt, now: r.at, floors, tz });
    followForecast(st, cur);
    const ev = evaluateForecast(st, cur, r.at, { floors, tz }); if (ev) nights.push(ev);
    const enough = Object.values(st.g).some(a => a[1] >= LEARN.minDrainH / 4);
    if (enough) storeForecast(st, cur, r.at, modelsOf(st), { tz });
    prev = cur; prevAt = r.at;
  }
  return { nights, total: totalOf(nights), floors, runs: sorted.length, from: sorted[0]?.at ?? null, to: sorted.at(-1)?.at ?? null };
}
