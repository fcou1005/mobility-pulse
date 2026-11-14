// Mobility Pulse – S6.5 Akku-Prognose (F15): Welche Fahrzeuge fallen bis zum nächsten Morgen 8 Uhr unter 20 % Ladestand, und wann je Zone?
// Modell je Anbieter und Fahrzeugart (gelernt im Sammler, lib/pulse-akku-learn.js, privat; veröffentlicht nur die Kennzahlen, akku/<AGS>.json):
//   drain  Prozentpunkte je Stunde Standzeit (Selbstentladung, IoT), aus Fahrzeugen, die zwischen zwei Läufen am Ort blieben
//   trip   Prozentpunkte je Fahrt, aus Ladestandsprüngen stabiler Kennungen (Ort ≥ 200 m versetzt); rotierende Kennungen zeigen keine Fahrt
//          am selben Fahrzeug → Wert der Fahrzeugart über alle Anbieter, sonst ein Startwert
//   rate   Fahrten je verfügbarer Fahrzeugstunde je Stunde des Tages (Berlin), je Gemeinde, Anbieter und Art
// Ladestand um 8 Uhr = jetzt − drain × Stunden − trip × N, N ~ Poisson(Σ rate × Stunden). „Unter 20 %“, wenn P(Ladestand < 20) ≥ 0,5.
// Zeitpunkt je Fahrzeug: wann der erwartete Verlauf (ohne Zufall) die 20 % unterschreitet; je Zone der Median.
// Geteilt mit der Disposition (web/ops-akku.js): dort rechnet die Seite mit dem aktuellen Bestand und dem veröffentlichten Modell.
export const AKKU = Object.freeze({ low: 20, targetHour: 8, eveningHour: 20, pCut: 0.5, tz: 'Europe/Berlin', maxH: 26,
  // Startwerte, solange nichts gelernt ist: 4 Prozentpunkte je Fahrt (≈ 2 km × 12 Wh/km bei 0,6 kWh Akku), 0,3 Punkte je Stunde Standzeit
  tripStart: 4, drainStart: 0.3 });
export const AKKU_BASIS = Object.freeze({ group: 'gruppe', type: 'art', start: 'startwert' });

const FMT = new Map();
const fmt = (tz) => { let f = FMT.get(tz); if (!f) FMT.set(tz, f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })); return f; };
/** Stunde (0–23) und Minute in der Zeitzone */
export function clockOf(ms, tz = AKKU.tz) { const [h, m] = fmt(tz).format(new Date(ms)).split(':').map(Number); return [h % 24, m]; }

/**
 * Stundenabschnitte von now bis zum nächsten targetHour:00 (Ortszeit): [{ t0, h (Stunden), hour (Ortsstunde) }], target (ms).
 * Ortsstunden wechseln zur vollen UTC-Stunde (Deutschland: ganze Stunden Versatz), Sommerzeit-Wechsel inklusive.
 */
export function slotsUntil(now, { targetHour = AKKU.targetHour, tz = AKKU.tz, maxH = AKKU.maxH } = {}) {
  const slots = []; let t = now;
  for (let i = 0; i <= maxH; i++) {
    const [h, m] = clockOf(t, tz);
    if (h === targetHour && m === 0 && t > now) return { slots, target: t };
    const next = Math.floor(t / 3600e3) * 3600e3 + 3600e3;
    slots.push({ t0: t, h: (next - t) / 3600e3, hour: h });
    t = next;
  }
  return { slots, target: t };
}

/** P(N ≥ k) für N ~ Poisson(λ) */
export function poissonTail(lambda, k) {
  if (k <= 0) return 1; if (!(lambda > 0)) return 0;
  let p = Math.exp(-lambda), cdf = p;
  for (let i = 1; i < k; i++) { p *= lambda / i; cdf += p; }
  return Math.max(0, Math.min(1, 1 - cdf));
}

/**
 * Prognose für ein Fahrzeug mit Ladestand bat (%) und Modell g { drain, trip, rate[24] } über die Abschnitte slots.
 * Rückgabe { p (Wahrscheinlichkeit unter low bis zum Ziel), morning (erwarteter Ladestand am Ziel), cross (Zeitpunkt ms, an dem der
 *   erwartete Verlauf low unterschreitet, null = nicht bis zum Ziel), trips (erwartete Fahrten) }
 */
export function forecastVehicle(bat, g, slots, { low = AKKU.low } = {}) {
  let b = bat, lam = 0, drain = 0, cross = bat < low ? slots[0]?.t0 ?? null : null;
  for (const s of slots) {
    const r = Math.max(0, g.rate?.[s.hour] || 0), e = (g.drain || 0) * s.h + (g.trip || 0) * r * s.h;
    if (cross == null && e > 0 && b - e < low) cross = Math.round(s.t0 + ((b - low) / e) * s.h * 3600e3);
    b -= e; lam += r * s.h; drain += (g.drain || 0) * s.h;
  }
  const need = bat - drain - low;
  const p = need <= 0 ? 1 : g.trip > 0 ? poissonTail(lam, Math.floor(need / g.trip) + 1) : 0;
  return { p, morning: b, cross, trips: lam };
}

/** Modell einer Gruppe aus akku/<AGS>.json: doc.groups['Anbieter|Art'] = [drain, trip, basisDrain, basisTrip, ...rate×24] */
export function groupModel(doc, op, ty) {
  const r = doc?.groups?.[`${op}|${ty}`];
  if (!r) return null;
  return { drain: r[0], trip: r[1], basisDrain: r[2], basisTrip: r[3], rate: r.slice(4, 28) };
}
export const AKKU_FIELDS = ['drain', 'trip', 'basisDrain', 'basisTrip', 'rate0', '…', 'rate23'];

/**
 * Prognose für einen Bestand (Disposition): vehicles mit { lat, lon, operator, type, battery, reserved, disabled }, Modell doc.
 * Nur Fahrzeuge mit Ladestand und Modell; gesperrte und reservierte zählen nicht. Rückgabe { target, known, nowLow, morning, items:
 *   [{ v, p, cross, morningBat }] (nur Fahrzeuge jetzt ≥ low mit p ≥ pCut), zones: [{ cell, lat, lon, op, type, nowLow, morning, cross }] }
 */
export function fleetForecast(vehicles, doc, now, { low = doc?.low ?? AKKU.low, pCut = AKKU.pCut, cellOf = null } = {}) {
  const { slots, target } = slotsUntil(now, { targetHour: doc?.targetHour ?? AKKU.targetHour });
  const out = { target, known: 0, nowLow: 0, morning: 0, items: [], zones: [] }, zones = new Map();
  const Z = (v) => { const c = cellOf ? cellOf(v.lat, v.lon) : `${v.lat.toFixed(3)}:${v.lon.toFixed(3)}`, k = `${c}|${v.operator}|${v.type}`; let z = zones.get(k); if (!z) zones.set(k, z = { cell: c, lat: 0, lon: 0, n: 0, op: v.operator, type: v.type, nowLow: 0, morning: 0, crosses: [] }); return z; };
  for (const v of vehicles || []) {
    if (v.battery == null || !Number.isFinite(v.battery) || v.disabled || v.reserved) continue;
    const g = groupModel(doc, v.operator, v.type); if (!g) continue;
    out.known++;
    const z = Z(v); z.lat += v.lat; z.lon += v.lon; z.n++;
    if (v.battery < low) { out.nowLow++; z.nowLow++; continue; }
    const f = forecastVehicle(v.battery, g, slots, { low });
    if (f.p >= pCut) { out.morning++; z.morning++; if (f.cross != null) z.crosses.push(f.cross); out.items.push({ v, p: f.p, cross: f.cross, morningBat: f.morning }); }
  }
  for (const z of zones.values()) {
    if (!z.nowLow && !z.morning) continue;
    const cs = z.crosses.sort((a, b) => a - b);
    out.zones.push({ cell: z.cell, lat: z.lat / z.n, lon: z.lon / z.n, op: z.op, type: z.type, nowLow: z.nowLow, morning: z.morning, cross: cs.length ? cs[cs.length >> 1] : null });
  }
  out.zones.sort((a, b) => b.morning - a.morning || b.nowLow - a.nowLow || (a.cross ?? Infinity) - (b.cross ?? Infinity));
  return out;
}

/** Ladestand um 8 Uhr statt jetzt (Tauschplanung „bis morgen früh“): Fahrzeuge mit Modell bekommen den erwarteten Morgenwert */
export function atMorning(vehicles, doc, now) {
  const { slots } = slotsUntil(now, { targetHour: doc?.targetHour ?? AKKU.targetHour });
  return (vehicles || []).map(v => {
    if (v.battery == null || !Number.isFinite(v.battery)) return v;
    const g = groupModel(doc, v.operator, v.type); if (!g) return v;
    const f = forecastVehicle(v.battery, g, slots);
    return { ...v, battery: Math.max(0, Math.round(Math.min(v.battery, f.morning))), batteryNow: v.battery };
  });
}

/** Trefferquote aus Zählwerten: precision = getroffen ÷ vorhergesagt, recall = getroffen ÷ tatsächlich unter 20 % */
export function scores(c) {
  const pred = (c.tp || 0) + (c.fp || 0), act = (c.tp || 0) + (c.fn || 0);
  return { precision: pred ? (c.tp || 0) / pred : null, recall: act ? (c.tp || 0) / act : null, n: (c.tp || 0) + (c.fp || 0) + (c.fn || 0) + (c.tn || 0) };
}
