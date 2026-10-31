// Mobility Pulse — Umsatzschätzung und Kennzahlen (Rides per Vehicle per Day, Auslastung, Umsatz je Fahrzeug).
// Reine Funktionen für Browser und Node. Grundlage: Ereignisse je Stunde (events/<Tag>.json) und Tarife (pricing.json).

// Ø Fahrt, falls nicht gemessen (rotierende Kennungen machen Dauer/Distanz unsichtbar). Annahmen, im Dashboard änderbar.
export const DEFAULT_RIDE = { scooter: { min: 12, km: 2.0 }, ebike: { min: 16, km: 3.2 }, bike: { min: 18, km: 2.8 }, cargo: { min: 40, km: 3.5 }, other: { min: 15, km: 2.5 }, unknown: { min: 15, km: 2.5 } };
export const VAT = 0.19;
export const DEFAULTS = { realization: 0.85, minTripsMeasured: 20, maxRvd: 15 };
// Tagesgang der Fahrten (Anteil je Stunde), bis eigene Messungen über mehrere volle Tage vorliegen. Grobe Mikromobilitäts-Kurve.
export const DEFAULT_PROFILE = (() => { const w = [1.2, 0.8, 0.6, 0.4, 0.3, 0.5, 1.5, 3.5, 5.0, 4.0, 4.0, 4.8, 5.6, 5.8, 5.8, 6.2, 7.0, 7.6, 7.0, 6.0, 5.0, 4.2, 3.4, 2.2]; const s = w.reduce((a, b) => a + b, 0); return w.map(x => x / s); })();
const sum = (a) => (a || []).reduce((x, y) => x + (y || 0), 0);
const median = (a) => { const v = a.filter(Number.isFinite).sort((x, y) => x - y); if (!v.length) return null; const m = Math.floor(v.length / 2); return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };

// ---------- Tarife ----------
// GBFS per_min_pricing/per_km_pricing: Betrag `rate` fällig ab `start` und dann alle `interval` Einheiten bis vor `end`; interval 0 = einmalig.
function segCost(segs, x) {
  let c = 0;
  for (const s of segs || []) {
    const start = +s.start || 0, rate = +s.rate || 0, iv = +s.interval || 0, end = s.end == null ? Infinity : +s.end;
    if (!(rate > 0) || x <= start && start > 0) continue;
    if (!iv) { c += rate; continue; }
    const until = Math.min(end, x); if (until <= start) { if (start === 0) c += rate; continue; }
    c += Math.ceil((until - start) / iv) * rate;
  }
  return c;
}
// Tarif ohne Segmente: aus der Beschreibung lesen („€1.00 to start and €0.25 per minute“, „0,12€/min + 1€ Freischaltgebühr“)
export function parseDesc(desc) {
  const t = String(desc || '').replace(/,(\d)/g, '.$1');
  const per = t.match(/(?:€|EUR)\s*(\d+(?:\.\d+)?)\s*(?:per|pro|\/)\s*min|(\d+(?:\.\d+)?)\s*(?:€|EUR)\s*(?:per|pro|\/)\s*min/i);
  const unl = t.match(/(?:€|EUR)\s*(\d+(?:\.\d+)?)\s*(?:to start|unlock|Freischalt|Entsperr)|(\d+(?:\.\d+)?)\s*(?:€|EUR)\s*(?:to start|unlock|Freischalt|Entsperr|Grundgebühr)|(?:unlock|Freischalt\w*|Entsperr\w*)\s*(\d+(?:\.\d+)?)\s*(?:€|EUR)/i);
  return { perMin: per ? +(per[1] || per[2]) : null, unlock: unl ? +(unl[1] || unl[2] || unl[3]) : null };
}
export function fare(plan, min, km = 0) {
  if (!plan) return null;
  let c = +plan.unlock || 0;
  const hasSeg = (plan.perMin || []).length || (plan.perKm || []).length;
  if (hasSeg) c += segCost(plan.perMin, min) + segCost(plan.perKm, km);
  else { const d = parseDesc(plan.desc); if (d.perMin != null) c += d.perMin * min; if (!plan.unlock && d.unlock != null) c += d.unlock; }
  return +c.toFixed(2);
}
const TYPE_WORDS = { scooter: /scoot|roller|es\d|kick/i, ebike: /e[-_ ]?bike|pedelec|e_bike/i, bike: /(^|[^-_e])bike|rad|velo/i, cargo: /cargo|lasten/i };
const excluded = (p) => /business|abo|subscription|pass|pauschal|test|hold|student|monat|month|jahres|annual|minutenpaket|bundle/i.test(`${p.name} ${p.desc}`) || ((p.perMin || []).every(s => +s.start >= 9999 || !(+s.rate > 0)) && !(+p.unlock > 0) && !parseDesc(p.desc).perMin);
/**
 * Standardtarif für Anbieter × Gemeinde × Fahrzeugart: Pläne der Gemeinde, sonst des Anbieters bundesweit;
 * Abos/Pässe/Business raus; passend zur Fahrzeugart, wenn erkennbar; Median der Kosten einer Referenzfahrt.
 */
export function planFor(pricing, operator, ags, type, ref = DEFAULT_RIDE[type] || DEFAULT_RIDE.unknown) {
  const all = (pricing?.plans || []).filter(x => x.operator === operator);
  const local = all.filter(x => (x.municipalities || []).includes(ags));
  for (const [scope, list] of [['Gemeinde', local], ['Anbieter', all]]) {
    let plans = list.flatMap(x => x.plans || []).filter(p => !excluded(p) && fare(p, ref.min, ref.km) != null);
    const typed = plans.filter(p => TYPE_WORDS[type]?.test(`${p.id} ${p.name} ${p.desc}`));
    if (typed.length) plans = typed;
    else if (type in TYPE_WORDS) plans = plans.filter(p => !Object.entries(TYPE_WORDS).some(([t, re]) => t !== type && re.test(`${p.id} ${p.name}`) && !(type === 'ebike' && t === 'bike')));
    if (!plans.length) continue;
    const std = plans.filter(p => /standard|pay as you go|pay-as-you-go|basis|regul|default|normal/i.test(p.name || ''));
    if (std.length) plans = std;
    const priced = plans.map(p => ({ p, f: fare(p, ref.min, ref.km) })).sort((a, b) => a.f - b.f);
    const pick = priced[Math.floor((priced.length - 1) / 2)];
    return { plan: pick.p, scope, candidates: priced.length, refFare: pick.f };
  }
  return null;
}
export function planLabel(plan) {
  if (!plan) return '—';
  const seg = (plan.perMin || []).find(s => +s.rate > 0);
  const d = parseDesc(plan.desc);
  const perMin = seg ? (seg.interval > 1 ? `${seg.rate.toFixed(2)} €/${seg.interval} min` : `${(+seg.rate).toFixed(2)} €/min`) : d.perMin != null ? `${d.perMin.toFixed(2)} €/min` : '';
  const unlock = +plan.unlock || d.unlock || 0;
  return [unlock ? `${unlock.toFixed(2)} € Start` : '0 € Start', perMin].filter(Boolean).join(' + ');
}

// ---------- Beobachtung ----------
/** Beobachtete Minuten je Stunde aus den Läufen eines Tages (Lauf = Fenster seit dem vorigen, höchstens 45 Min). */
export function observedMinutes(runs, tz = 'Europe/Berlin') {
  const m = new Array(24).fill(0);
  const fmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: tz });
  for (const [at, dt] of runs || []) { if (dt == null) continue; m[+fmt.format(new Date(at)) % 24] += Math.min(dt, 45 * 60e3) / 60e3; }
  return m;
}
/** Tagesgang aus mehreren Tagesdateien (nur Stunden, die voll beobachtet sind); zu wenig Daten → Standardkurve. */
export function hourProfile(eventDocs, { minDays = 3 } = {}) {
  const w = new Array(24).fill(0), n = new Array(24).fill(0);
  let days = 0;
  for (const d of eventDocs || []) {
    if (!d) continue; const obs = observedMinutes(d.runs); if (obs.filter(x => x >= 50).length < 20) continue; days++;
    const starts = new Array(24).fill(0); for (const g of Object.values(d.groups || {})) for (let h = 0; h < 24; h++) starts[h] += g.start?.[h] || 0;
    for (let h = 0; h < 24; h++) if (obs[h] >= 50) { w[h] += starts[h] / (obs[h] / 60); n[h]++; }
  }
  if (days < minDays) return { profile: DEFAULT_PROFILE, source: 'Standardkurve', days };
  const rate = w.map((x, h) => (n[h] ? x / n[h] : 0)); const s = sum(rate);
  return s > 0 ? { profile: rate.map(x => x / s), source: `gemessen (${days} Tage)`, days } : { profile: DEFAULT_PROFILE, source: 'Standardkurve', days };
}

// ---------- Kennzahlen ----------
/**
 * Kennzahlen einer Gruppe (oder Summe mehrerer Gruppen gleicher Art) für einen Tag.
 * g: Stundenwerte (start, end, rot, vmin, vminTot, tripDur*, tripDist*), obsMin: beobachtete Minuten je Stunde,
 * fleetFallback: Ø Flotte, wenn noch keine Fahrzeugminuten vorliegen (ältere Tagesdateien).
 */
export function kpis({ g, obsMin, obsMinV = null, profile = DEFAULT_PROFILE, plan = null, type = 'scooter', fleetFallback = null, ride = null, realization = DEFAULTS.realization, net = true }) {
  const rides = sum(g.start), ends = sum(g.end), rot = sum(g.rot);
  const coverage = profile.reduce((a, p, h) => a + p * Math.min(1, (obsMin[h] || 0) / 60), 0);
  const obsTotal = sum(obsMin);
  // Nenner für Fahrzeugminuten: nur Läufe, die sie gezählt haben (ältere Tagesdateien: Ø Bestand aus dem Verlauf)
  const obsV = obsMinV ? sum(obsMinV) : obsTotal;
  const vminTot = sum(g.vminTot), vmin = sum(g.vmin);
  const fleet = vminTot > 0 && obsV > 0 ? vminTot / obsV : fleetFallback;
  const avail = vmin > 0 && obsV > 0 ? vmin / obsV : null;
  const ridesDay = coverage > 0 ? rides / coverage : null;
  const def = DEFAULT_RIDE[type] || DEFAULT_RIDE.unknown;
  const measured = (g.tripDurN || 0) >= DEFAULTS.minTripsMeasured;
  // gemessene Dauer ist auf das Sammler-Raster (20 Min) gerundet → nur als Obergrenze nutzen
  const avgMin = ride?.min ?? (measured ? Math.min(g.tripDurSum / g.tripDurN / 60e3, def.min * 2) : def.min);
  const avgKm = ride?.km ?? ((g.tripDistN || 0) >= DEFAULTS.minTripsMeasured ? g.tripDistSum / g.tripDistN / 1000 : def.km);
  const rvd = ridesDay != null && fleet > 0 ? ridesDay / fleet : null;
  const utilization = rvd != null ? (rvd * avgMin) / 1440 : null;
  const perRide = plan ? fare(plan, avgMin, avgKm) : null;
  const k = (net ? 1 / (1 + VAT) : 1) * realization;
  const revDay = perRide != null && ridesDay != null ? ridesDay * perRide * k : null;
  const flags = [];
  if (rvd != null && rvd > DEFAULTS.maxRvd) flags.push('unplausibel hoch – Kennungen wechseln vermutlich ohne Fahrt');
  if (ends > rides * 1.3 && rides > 20) flags.push('deutlich mehr Fahrtenden als -beginne (Neuaufstellungen oder Kennungswechsel)');
  if (coverage < 0.25) flags.push('weniger als ein Viertel des Tagesgangs beobachtet');
  return {
    rides, ends, rot, coverage, obsMin: obsTotal, fleet, avail, ridesDay, rvd, rvdAvail: ridesDay != null && avail > 0 ? ridesDay / avail : null,
    avgMin, avgKm, durationSource: ride?.min != null ? 'Vorgabe' : measured ? 'gemessen' : 'Annahme', utilization, perRide, revDay,
    revPerVehicleDay: revDay != null && fleet > 0 ? revDay / fleet : null, revPerHour: revDay != null ? revDay / 24 : null, plausible: !flags.some(f => f.startsWith('unplausibel')), flags,
  };
}
/** Summe mehrerer Kennzahl-Ergebnisse (z. B. Anbieter über Fahrzeugarten oder Gemeinden). */
export function combine(list) {
  const ok = list.filter(Boolean); if (!ok.length) return null;
  const s = (f) => ok.reduce((a, x) => a + (x[f] || 0), 0);
  const fleet = s('fleet'), ridesDay = ok.every(x => x.ridesDay != null) ? s('ridesDay') : null, revDay = ok.some(x => x.revDay != null) ? s('revDay') : null;
  const minW = ok.reduce((a, x) => a + (x.ridesDay || 0) * x.avgMin, 0);
  return {
    rides: s('rides'), ends: s('ends'), rot: s('rot'), fleet, avail: s('avail'), ridesDay, revDay,
    rvd: ridesDay != null && fleet ? ridesDay / fleet : null, utilization: ridesDay != null && fleet ? minW / (fleet * 1440) : null,
    avgMin: ridesDay ? minW / ridesDay : median(ok.map(x => x.avgMin)), perRide: ridesDay && revDay != null ? revDay / ridesDay : median(ok.map(x => x.perRide)),
    revPerVehicleDay: revDay != null && fleet ? revDay / fleet : null, coverage: median(ok.map(x => x.coverage)), plausible: ok.every(x => x.plausible), flags: [...new Set(ok.flatMap(x => x.flags))].sort((a, b) => b.startsWith('unplausibel') - a.startsWith('unplausibel')),
  };
}
