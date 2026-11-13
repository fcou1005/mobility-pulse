// @ts-check
// Mobility Pulse — Umsatzschätzung und Kennzahlen (Rides per Vehicle per Day, Auslastung, Umsatz je Fahrzeug).
// Reine Funktionen für Browser und Node. Grundlage: Ereignisse je Stunde (events/<Tag>.json) und Tarife (pricing.json).

// Ø Fahrt, falls nicht gemessen (rotierende Kennungen machen Dauer/Distanz unsichtbar). Annahmen, im Dashboard änderbar.
// E-Roller und Carsharing (seit 08.11.2026): grobe Annahmen bis zur eigenen Messung (Carsharing in den offenen Feeds überwiegend stationsgebunden,
// Buchungen über Stunden; gemessen wird die Dauer zurückkehrender Kennungen, pulse-track TYPE_RULES).
export const DEFAULT_RIDE = { scooter: { min: 12, km: 2.0 }, ebike: { min: 16, km: 3.2 }, bike: { min: 18, km: 2.8 }, cargo: { min: 40, km: 3.5 }, other: { min: 15, km: 2.5 }, unknown: { min: 15, km: 2.5 },
  moped: { min: 18, km: 5.0 }, car: { min: 180, km: 40 } };
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
 * Standardtarif für Anbieter × Gemeinde × Fahrzeugart: zuerst die Quelle mit den wenigsten Gemeinden, die diese Gemeinde enthält
 * (Stadtfeed vor Sammelfeed, Audit MET-11: Voi Köln bekam den Mönchengladbacher Plan), dann alle Quellen der Gemeinde, sonst des
 * Anbieters bundesweit; Abos/Pässe/Business raus; passend zur Fahrzeugart, wenn erkennbar; Median der Kosten einer Referenzfahrt.
 * Rückgabe { plan, scope, candidates, refFare, fareMin, fareMax, unclear, sourceId } – unclear: mehrere Pläne ohne Stadtbezug,
 * Referenzfahrt streut um mehr als 20 % (Median nur Platzhalter, Spanne zeigen).
 */
const pickPlans = (list, type, ref) => {
  let plans = list.flatMap(x => (x.plans || []).map(p => ({ p, src: x.sourceId ?? null }))).filter(({ p }) => !excluded(p) && fare(p, ref.min, ref.km) != null);
  const typed = plans.filter(({ p }) => TYPE_WORDS[type]?.test(`${p.id} ${p.name} ${p.desc}`));
  if (typed.length) plans = typed;
  else if (type in TYPE_WORDS) plans = plans.filter(({ p }) => !Object.entries(TYPE_WORDS).some(([t, re]) => t !== type && re.test(`${p.id} ${p.name}`) && !(type === 'ebike' && t === 'bike')));
  const std = plans.filter(({ p }) => /standard|pay as you go|pay-as-you-go|basis|regul|default|normal/i.test(p.name || ''));
  return std.length ? std : plans;
};
export function planFor(pricing, operator, ags, type, ref = DEFAULT_RIDE[type] || DEFAULT_RIDE.unknown) {
  const all = (pricing?.plans || []).filter(x => x.operator === operator);
  const local = all.filter(x => (x.municipalities || []).includes(ags));
  const nMin = local.length ? Math.min(...local.map(x => (x.municipalities || []).length)) : 0;
  const own = local.filter(x => (x.municipalities || []).length === nMin);
  const tiers = [['Quelle', own], ['Gemeinde', local], ['Anbieter', all]].filter(([sc, l]) => l.length && !(sc === 'Gemeinde' && l.length === own.length));
  for (const [scope, list] of tiers) {
    const plans = pickPlans(list, type, ref);
    if (!plans.length) continue;
    const priced = plans.map(({ p, src }) => ({ p, src, f: fare(p, ref.min, ref.km) })).sort((a, b) => a.f - b.f);
    const pick = priced[Math.floor((priced.length - 1) / 2)], fareMin = priced[0].f, fareMax = priced[priced.length - 1].f;
    const multi = scope !== 'Quelle' || nMin > 1;
    return { plan: pick.p, scope: scope === 'Quelle' ? 'Gemeinde' : scope, candidates: priced.length, refFare: pick.f, fareMin, fareMax, sourceId: pick.src,
      unclear: multi && priced.length > 1 && pick.f > 0 && (fareMax - fareMin) / pick.f > 0.2 };
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

// ---------- Bootstrap über Tage (Sprint 1, A6/A8) ----------
// Festes Zufallsmuster (Seed aus dem Schlüssel), damit veröffentlichte Bänder von Lauf zu Lauf nicht zittern.
export const seededRng = (key) => { let h = 2166136261; for (const c of String(key)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } let a = h || 1; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
export const quantile = (sorted, p) => { if (!sorted.length) return null; const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); };
/**
 * 90-%-Band einer Kennzahl über ganze Tage: days = [{ …Tageswerte }], stat(stichprobe) → Zahl oder null; B Ziehungen mit Zurücklegen.
 * Rückgabe [q05, q95] oder null (unter minDays Tagen oder ohne Werte). Tage statt Stunden: Stunden eines Tags sind nicht unabhängig.
 */
export function bootstrapDays(days, stat, { B = 400, minDays = 3, key = 'x', lo = 0.05, hi = 0.95 } = {}) {
  if (!Array.isArray(days) || days.length < minDays) return null;
  const r = seededRng(key), n = days.length, out = [];
  for (let b = 0; b < B; b++) { const s = new Array(n); for (let i = 0; i < n; i++) s[i] = days[Math.floor(r() * n)]; const v = stat(s, r); if (Number.isFinite(v)) out.push(v); }
  if (out.length < B / 2) return null;
  out.sort((x, y) => x - y); return [quantile(out, lo), quantile(out, hi)];
}

// ---------- Fahrtdauer als Intervallschätzung (Sprint 1, A3) ----------
// spans: { 'a|b': n } – je stabiler Fahrt das Intervall [a, b) in Minuten, in dem die Dauer liegt (Versatz zwischen zwei Läufen: [0, Laufabstand);
// Rückkehr nach m Läufen: (Fehlzeit − Laufabstand, Fehlzeit + Laufabstand)). Lognormal per Maximum-Likelihood über ein Gitter (μ, σ), weil 57 %
// der Fahrten in einem einzigen Laufintervall liegen (Turnbull scheidet aus). Rückgabe { mean, median, mu, sigma, n } oder null (unter minN).
const normCdf = (z) => { const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989422804014327 * Math.exp(-z * z / 2), p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))); return z > 0 ? 1 - p : p; };
export function durationFromSpans(spans, { minN = 50 } = {}) {
  const obs = Object.entries(spans || {}).map(([k, n]) => { const [a, b] = k.split('|').map(Number); return [a, b, n]; }).filter(([a, b, n]) => b > a && n > 0);
  const n = obs.reduce((s, o) => s + o[2], 0); if (n < minN) return null;
  const ll = (mu, sg) => { let s = 0; for (const [a, b, c] of obs) { const fa = a > 0 ? normCdf((Math.log(a) - mu) / sg) : 0, fb = normCdf((Math.log(b) - mu) / sg); s += c * Math.log(Math.max(fb - fa, 1e-12)); } return s; };
  /** @type {any} */ let best = null; const grid = (m0, m1, dm, s0, s1, ds) => { for (let mu = m0; mu <= m1; mu += dm) for (let sg = Math.max(0.1, s0); sg <= s1; sg += ds) { const v = ll(mu, sg); if (!best || v > best.v) best = { v, mu, sg }; } };
  grid(Math.log(1.5), Math.log(90), 0.1, 0.15, 1.6, 0.1); // grob, dann fein um das Optimum
  grid(best.mu - 0.12, best.mu + 0.12, 0.01, best.sg - 0.12, best.sg + 0.12, 0.01);
  return { mean: Math.exp(best.mu + best.sg ** 2 / 2), median: Math.exp(best.mu), mu: best.mu, sigma: best.sg, n };
}

// ---------- Beobachtung ----------
export const GAP_MS = 45 * 60e3; // Lauf nach größerem Abstand = Lücke (zählt nicht, siehe pulse-track)
const HOUR_FMT = new Map();
const hourFmt = (tz) => { let f = HOUR_FMT.get(tz); if (!f) HOUR_FMT.set(tz, (f = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: tz }))); return f; };
const isGapRun = (r) => r[2] === 0 || (r[1] != null && r[1] > GAP_MS);
/** Gestörte Stunden (true): Stunde enthält einen Lauf nach Lücke (runs[k][2] === 0 bzw. dt > 45 Min.) – grau zeigen, nicht hochrechnen. */
export function gapHours(runs, tz = 'Europe/Berlin') {
  const g = new Array(24).fill(false); const fmt = hourFmt(tz);
  for (const r of runs || []) if (isGapRun(r)) g[+fmt.format(new Date(r[0])) % 24] = true;
  return g;
}
const DAY_FMT = new Map();
const dayFmt = (tz) => { let f = DAY_FMT.get(tz); if (!f) DAY_FMT.set(tz, (f = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: tz }))); return f; };
/**
 * Beobachtungsfenster eines Laufs [at − min(dt, 45 Min.), at] anteilig auf die Ortsstunden seines Tages (Sprint 1, S1.1). Bis 13.11.2026 zählte
 * das ganze Fenster in der Stunde, in der der Lauf endet: bei ~18 Minuten Takt bekam eine Stunde 3 oder 4 Läufe (50–67 Minuten, Sägezahn),
 * die Kappung auf 60 Minuten in der Abdeckung hob die Hochrechnung im Median um 6,6 %. Teile vor Mitternacht gehören zum Vortag und fallen weg
 * (ihre Fahrtbeginne zählen dort auch nicht); die letzte Stunde eines Tages endet daher mit seinem letzten Lauf. Zeitumstellung: Stunde 2 = bis zu 120 Min.
 * out: Feld je Ortsstunde, wird ergänzt und zurückgegeben.
 */
export function windowMinutes(at, dt, tz = 'Europe/Berlin', out = new Array(24).fill(0)) {
  const w = Math.min(dt, GAP_MS); if (!(w > 0) || !Number.isFinite(at)) return out;
  const a = at - w, day = dayFmt(tz).format(new Date(at)), hf = hourFmt(tz), df = dayFmt(tz);
  for (let t = Math.floor(a / 3600e3) * 3600e3; t < at; t += 3600e3) {
    const ov = Math.min(t + 3600e3, at) - Math.max(t, a); if (!(ov > 0)) continue;
    const mid = Math.max(t, a) + ov / 2; if (df.format(new Date(mid)) !== day) continue;
    out[+hf.format(new Date(mid)) % 24] += ov / 60e3;
  }
  return out;
}
/** Beobachtete Minuten je Stunde aus den Läufen eines Tages (Lauf = Fenster seit dem vorigen, höchstens 45 Min., anteilig je Stunde); gestörte Stunden = 0. */
export function observedMinutes(runs, tz = 'Europe/Berlin') {
  const m = new Array(24).fill(0);
  for (const r of runs || []) { const [at, dt] = r; if (dt == null || isGapRun(r)) continue; windowMinutes(at, dt, tz, m); }
  const g = gapHours(runs, tz); for (let h = 0; h < 24; h++) if (g[h]) m[h] = 0;
  return m.map(x => Math.round(x * 100) / 100);
}
/**
 * Beobachtete Minuten je Stunde in der Endstunde der Läufe (Stand bis 13.11.2026), gestörte Stunden = 0. Nur noch Nenner für Fahrzeugminuten
 * (vmin, vminTot) und Fahrten je Fahrzeug: beide zählt die Verfolgung je Lauf in der Stunde seines Endes, samt Fensteranteil vor Mitternacht.
 */
export function observedMinutesEnd(runs, tz = 'Europe/Berlin') {
  const m = new Array(24).fill(0), fmt = hourFmt(tz);
  for (const r of runs || []) { const [at, dt] = r; if (dt == null || isGapRun(r)) continue; m[+fmt.format(new Date(at)) % 24] += Math.min(dt, GAP_MS) / 60e3; }
  const g = gapHours(runs, tz); for (let h = 0; h < 24; h++) if (g[h]) m[h] = 0;
  return m;
}
/** Fahrtbeginne je Stunde passend zu observedMinutes: anteilig (startP, Tagesdateien ab 12.11.2026, pVersion 1), sonst in der Endstunde des Laufs */
export const startsOf = (doc, g) => (doc?.pVersion >= 1 && Array.isArray(g?.startP) ? g.startP : g?.start);
/**
 * Tagesgang aus mehreren Tagesdateien (nur Stunden, die voll beobachtet sind); zu wenig Daten → Standardkurve.
 * dayType ('W' | 'F' | 'S' | 'H'): nur volle Tage dieses Tagtyps (Land und Kalender wie dayType unten, oder typeOf(day)); unter minDays
 * solchen Tagen Standardkurve. Ergebnis: basis = Tagtyp der Kurve ('alle' ohne dayType) oder 'Standardkurve', typeDays = volle Tage je Typ.
 */
export function hourProfile(eventDocs, { minDays = 3, dayType: want = null, land = null, calendar = null, typeOf = null } = {}) {
  const w = new Array(24).fill(0), n = new Array(24).fill(0);
  const typeFn = typeOf || ((day) => dayType(day, land, calendar));
  const typeDays = { W: 0, F: 0, S: 0, H: 0 };
  let days = 0;
  for (const d of eventDocs || []) {
    if (!d) continue; const obs = observedMinutes(d.runs); if (obs.filter(x => x >= 50).length < 20) continue;
    const ty = d.day ? typeFn(d.day) : null; if (ty in typeDays) typeDays[ty]++;
    if (want && ty !== want) continue; days++;
    const starts = new Array(24).fill(0); for (const g of Object.values(d.groups || {})) { const st = startsOf(d, g); for (let h = 0; h < 24; h++) starts[h] += st?.[h] || 0; }
    for (let h = 0; h < 24; h++) if (obs[h] >= 50) { w[h] += starts[h] / (obs[h] / 60); n[h]++; }
  }
  const std = { profile: DEFAULT_PROFILE, source: 'Standardkurve', days, dayType: want, basis: 'Standardkurve', typeDays };
  if (days < minDays) return std;
  const rate = w.map((x, h) => (n[h] ? x / n[h] : 0)); const s = sum(rate);
  return s > 0 ? { profile: rate.map(x => x / s), source: `gemessen (${days} Tage)`, days, dayType: want, basis: want || 'alle', typeDays } : std;
}

// ---------- Tagtyp (Kalender) ----------
// W Werktag, F Ferienwerktag (Schulferien Mo–Fr), S Samstag, H Sonn- und Feiertag – je Land. calendar.json (Sammler, OpenHolidays API, ODbL)
// führt nur die Ausnahmen F und H je Land; Samstag und Sonntag folgen aus dem Datum. Ohne Kalender oder außerhalb seines Zeitraums gelten
// die gesetzlichen Feiertage aus der lokalen Rechnung (localHolidays), Schulferien sind dann unbekannt (Werktag).
export const DAY_TYPES = ['W', 'F', 'S', 'H'];
export const LANDS = ['BW', 'BY', 'BE', 'BB', 'HB', 'HH', 'HE', 'MV', 'NI', 'NW', 'RP', 'SL', 'SN', 'ST', 'SH', 'TH'];
export const CALENDAR_SOURCE = 'OpenHolidays API (openholidaysapi.org, ODbL)';
const isDay = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
const weekdayUtc = (day) => new Date(`${day}T12:00:00Z`).getUTCDay(); // 0 = Sonntag
// Ostersonntag (Gauß/Meeus) als UTC-Millisekunden
const easterMs = (y) => { const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451), mo = Math.floor((h + l - 7 * m + 114) / 31), da = ((h + l - 7 * m + 114) % 31) + 1; return Date.UTC(y, mo - 1, da); };
/** Gesetzliche Feiertage eines Tages, lokal gerechnet: [{ id, lands }]; 'BY*' = nur in Teilen des Landes (zählt nicht als Feiertag des Landes) */
export function localHolidays(day) {
  if (!isDay(day)) return [];
  const y = +day.slice(0, 4), E0 = easterMs(y), iso = (ms) => new Date(ms).toISOString().slice(0, 10), fx = (md) => `${y}-${md}`, off = (n) => iso(E0 + n * 86400e3);
  const bub = iso(Date.UTC(y, 10, 22) - ((new Date(Date.UTC(y, 10, 22)).getUTCDay() + 4) % 7) * 86400e3); // Mittwoch vor dem 23. November
  return [
    ['newYear', fx('01-01'), LANDS], ['epiphany', fx('01-06'), ['BW', 'BY', 'ST']], ['womensDay', fx('03-08'), ['BE', 'MV']],
    ['goodFriday', off(-2), LANDS], ['easterSunday', off(0), ['BB']], ['easterMonday', off(1), LANDS], ['labourDay', fx('05-01'), LANDS],
    ['ascension', off(39), LANDS], ['whitSunday', off(49), ['BB']], ['whitMonday', off(50), LANDS], ['corpusChristi', off(60), ['BW', 'BY', 'HE', 'NW', 'RP', 'SL']],
    ['assumption', fx('08-15'), ['SL', 'BY*']], ['childrensDay', fx('09-20'), ['TH']], ['unity', fx('10-03'), LANDS],
    ['reformation', fx('10-31'), ['BB', 'HB', 'HH', 'MV', 'NI', 'SN', 'ST', 'SH', 'TH']], ['allSaints', fx('11-01'), ['BW', 'BY', 'NW', 'RP', 'SL']],
    ['repentance', bub, ['SN']], ['christmas', fx('12-25'), LANDS], ['boxingDay', fx('12-26'), LANDS],
  ].filter(([, d]) => d === day).map(([id, , lands]) => ({ id, lands }));
}
/** Kalender deckt den Tag ab (Zeitraum from–to der Datei) */
export const calendarCovers = (cal, day) => !!(cal && cal.states && typeof cal.states === 'object' && isDay(cal.from) && isDay(cal.to) && isDay(day) && day >= cal.from && day <= cal.to);
/** Länder mit Ausnahme v ('F' | 'H') an einem Tag laut Kalender (leer, wenn der Kalender den Tag nicht abdeckt) */
export const calendarLands = (cal, day, v) => (calendarCovers(cal, day) ? LANDS.filter(l => cal.states[l]?.[day] === v) : []);
/**
 * Tagtyp eines Kalendertags 'YYYY-MM-DD' in einem Land ('BW' …): 'W' | 'F' | 'S' | 'H' (Sonntag = 'H'). land null = Deutschland: Feiertag
 * nur, wenn er in allen Ländern gilt; Ferien zählen dann nicht. Ohne Kalender Rückfall auf die lokale Feiertagsrechnung.
 */
export function dayType(day, land = null, calendar = null) {
  if (!isDay(day)) return null;
  const wd = weekdayUtc(day);
  let ex = null;
  if (calendarCovers(calendar, day)) ex = land ? calendar.states[land]?.[day] ?? null : LANDS.every(l => calendar.states[l]?.[day] === 'H') ? 'H' : null;
  else ex = localHolidays(day).some(h => (land ? h.lands.includes(land) : h.lands.length === LANDS.length)) ? 'H' : null;
  if (wd === 0 || ex === 'H') return 'H';
  if (wd === 6) return 'S';
  return ex === 'F' ? 'F' : 'W';
}
/**
 * calendar.json aus den Antworten der OpenHolidays API (/PublicHolidays, /SchoolHolidays; Felder startDate, endDate, type, temporalScope,
 * nationwide, subdivisions[].code 'DE-BY'): nur Ausnahmen je Land, H vor F, F nur Mo–Fr. Örtliche Feiertage (DE-BY-AU, Augsburg) und halbe
 * Tage zählen nicht. Unplausible Antwort (zu wenige Einträge für den Zeitraum, kaum Länder) → null: der Sammler behält die alte Datei.
 */
export function calendarFromApi(pub, school, { from = undefined, to = undefined, at = Date.now() } = {}) {
  if (!Array.isArray(pub) || !Array.isArray(school) || !isDay(from) || !isDay(to) || to < from) return null;
  const states = {}; let nPub = 0, nSch = 0, nation = 0;
  const put = (l, d, v) => { const s = (states[l] ??= {}); if (s[d] !== 'H') s[d] = v; };
  const landsOf = (h) => (h.nationwide === true ? LANDS : (Array.isArray(h.subdivisions) ? h.subdivisions : []).map(s => /^DE-([A-Z]{2})$/.exec(s?.code || '')?.[1]).filter(l => LANDS.includes(l)));
  const each = (h, fn) => { for (let ms = Date.parse(`${h.startDate}T12:00:00Z`), e = Math.min(Date.parse(`${h.endDate}T12:00:00Z`), Date.parse(`${to}T12:00:00Z`)), k = 0; ms <= e && k < 400; ms += 86400e3, k++) { const d = new Date(ms).toISOString().slice(0, 10); if (d >= from) fn(d, new Date(ms).getUTCDay()); } };
  const valid = (h) => h && isDay(h.startDate) && isDay(h.endDate) && h.endDate >= h.startDate;
  for (const h of pub) { if (!valid(h) || h.type !== 'Public' || h.temporalScope === 'HalfDay') continue; const L = landsOf(h); if (!L.length) continue; nPub++; if (L.length === LANDS.length) nation++; each(h, (d) => { for (const l of L) put(l, d, 'H'); }); }
  for (const h of school) { if (!valid(h) || (h.type && h.type !== 'School')) continue; const L = landsOf(h); if (!L.length) continue; nSch++; each(h, (d, wd) => { if (wd >= 1 && wd <= 5) for (const l of L) put(l, d, 'F'); }); }
  const span = (Date.parse(to) - Date.parse(from)) / 86400e3 + 1;
  // grobe Mindestmengen: ≈ 10 Feiertage und ≈ 120 Ferienabschnitte je Jahr in Deutschland
  if (nPub < Math.max(1, Math.floor(span / 120)) || nSch < Math.max(1, Math.floor(span / 40)) || (span >= 120 && !nation) || Object.keys(states).length < Math.min(12, Math.ceil(span / 30))) return null;
  const sorted = Object.fromEntries(Object.keys(states).sort().map(l => [l, Object.fromEntries(Object.entries(states[l]).sort((a, b) => a[0].localeCompare(b[0])))]));
  return { version: 1, generatedAt: new Date(at).toISOString(), source: CALENDAR_SOURCE, from, to, states: sorted };
}

// ---------- Messbasis und Reifegrad ----------
// Regelstand eines Laufs: METHOD_VERSION vor „@“ in runs[k][3] (der Commit-Teil wechselt je Push); ältere Läufe ohne Regelstand: null
export const ruleVersion = (r) => (Array.isArray(r) && typeof r[3] === 'string' && r[3] ? r[3].split('@')[0] : null);
export const FULL_DAY = { hourMin: 50, hours: 20 }; // voller Messtag: ≥ 20 Stunden mit ≥ 50 beobachteten Minuten (wie hourProfile)
/**
 * Messbasis eines Tagesdokuments (events/<Tag>.json): Minuten je Stunde ohne Lücken (runs, gapHours), gezählte Läufe, Regelstände der
 * gezählten Läufe, voller Tag. Kompakt für latest.json → measure.days (Sammler) und als Rückfall im Browser.
 */
export function measureDay(doc) {
  const obs = observedMinutes(doc?.runs), obsEnd = observedMinutesEnd(doc?.runs);
  for (const h of Array.isArray(doc?.gapHours) ? doc.gapHours : []) if (h >= 0 && h < 24) { obs[h] = 0; obsEnd[h] = 0; }
  const counted = (doc?.runs || []).filter(r => Array.isArray(r) && r[1] != null && !isGapRun(r));
  const rules = [...new Set(counted.map(r => ruleVersion(r) ?? ''))].sort();
  // obsEnd: Minuten in der Endstunde der Läufe (wie die gezählten Fahrtbeginne je Stunde) – Normierung „je volle Stunde“ in der Prognose-Ansicht
  return { obs: obs.map(m => Math.round(m)), obsEnd: obsEnd.map(m => Math.round(m)), runs: (doc?.runs || []).length, counted: counted.length, rules, full: obs.filter(m => m >= FULL_DAY.hourMin).length >= FULL_DAY.hours };
}
/**
 * Messbasis über Tage: days = { Tag: measureDay(...) } (latest.json → measure.days). Gezählte Stunden gesamt und je Tagtyp, Matrix
 * Stunde × Tagtyp (Minuten), volle Tage je Typ, davon mit einheitlichem Regelstand rule (Vorgabe: Regelstand des jüngsten Tags mit Regelstand).
 */
export function measureBase(days, { land = null, calendar = null, typeOf = null, rule = undefined, until = null } = {}) {
  const typeFn = typeOf || ((day) => dayType(day, land, calendar));
  const z = () => ({ W: 0, F: 0, S: 0, H: 0 });
  const matrix = Object.fromEntries(DAY_TYPES.map(k => [k, new Array(24).fill(0)])), dayN = z(), hours = z(), full = z(), fullRule = z();
  const list = Object.entries(days || {}).filter(([d, m]) => isDay(d) && m && Array.isArray(m.obs) && (!until || d <= until)).sort((a, b) => a[0].localeCompare(b[0]));
  const cur = rule !== undefined ? rule : ([...list].reverse().map(([, m]) => (m.rules || []).filter(Boolean).sort().at(-1)).find(Boolean) ?? null);
  for (const [d, m] of list) {
    const ty = typeFn(d); if (!(ty in dayN)) continue;
    const mins = sum(m.obs); if (!(mins > 0)) continue;
    dayN[ty]++; hours[ty] += mins / 60;
    for (let h = 0; h < 24; h++) matrix[ty][h] += m.obs[h] || 0;
    if (m.full) { full[ty]++; if (cur && (m.rules || []).length === 1 && m.rules[0] === cur) fullRule[ty]++; }
  }
  const total = sum(Object.values(hours));
  return { hours: total, byType: hours, days: dayN, matrix, full, fullRule, rule: cur, ruleFullDays: sum(Object.values(fullRule)), types: DAY_TYPES.filter(k => hours[k] > 0), from: list[0]?.[0] || null, to: list.at(-1)?.[0] || null };
}
// Reifegrad je Kennzahl (research Nr. 15): 'now' sofort belastbar, 'full3' ab 3 vollen Tagen gleichen Tagtyps und Regelstands,
// 'weeks2' / 'weeks4' ab 14 / 28 vollen Tagen gleichen Regelstands
export const MATURITY = { now: 0, full3: 3, weeks2: 14, weeks4: 28 };
/** Stufe einer Kennzahl aus der Messbasis: { need, want, have, met, dayType } – full3 zählt nur Tage des Tagtyps dayType (sonst den stärksten Typ) */
export function maturity(base, need = 'full3', { dayType: ty = null } = {}) {
  const want = MATURITY[need] ?? MATURITY.full3;
  if (!want) return { need, want: 0, have: null, met: true, dayType: ty };
  const fr = base?.fullRule || {};
  const pick = need === 'full3' ? (ty && ty in fr ? ty : DAY_TYPES.reduce((a, k) => ((fr[k] || 0) > (fr[a] || 0) ? k : a), 'W')) : null;
  const have = need === 'full3' ? fr[pick] || 0 : base?.ruleFullDays || 0;
  return { need, want, have, met: have >= want, dayType: pick };
}

// ---------- Ampel je Gruppe: Selbsttest der Ereignisregeln (datamine Nr. 18) ----------
// Schwellen sind heuristisch (vor dem Einstellen ≥ 7 Tage beobachten). Ein Befund setzt 'warn' (gelb) oder 'bad' (rot); rote Gruppen gelten
// im Kommunal-Bericht als nicht plausibel (lib/pulse-report.js AMPEL_RED) und fallen aus Ranglisten und Kalibrierbasis.
export const EVENT_CHECKS = {
  version: 3, // 2 (13.11.2026, S1.6): Median ohne geprüfte Gruppe, relocTrips, modeFlip; 3: cityDev (A6)
  minRides: 50,                                  // Anteile und Verhältnis erst ab 50 Fahrtbeginnen am Tag
  minHours: 6,                                   // Korrelation erst ab 6 gemessenen Stunden
  pickupWarn: 0.10, pickupBad: 0.20, pickupR: 0.5, // Abholungsanteil pickup ÷ (pickup + start) bei r(pickup, start) je Stunde > 0,5: Abholungen sind vermutlich Fahrten
  seWarn: [0.7, 1.3], seBad: [0.5, 2],           // Fahrtbeginne ÷ Fahrtenden außerhalb der Spanne
  swapZeroRides: 300,                            // E-Scooter: 0 Akkutausche bei ≥ 300 Fahrten (Akkus vermutlich ausgeblendet, Fahrten überschätzt)
  hideWarn: 0.10,                                // Ausblendungen ÷ (Ausblendungen + Fahrtbeginne) (Feld hide, falls vorhanden)
  idleUnusableWarn: 0.5,                         // Anteil Standzeit unter einem Laufintervall (sources[].idleUnusable = true, idleCheck.shortShare)
  batteryFloorWarn: 10,                          // Ladestand-Untergrenze der Quelle ≥ 10 % (sources[].batteryFloor.p005, hides): blendet niedrige Akkus aus – nur ohne gezählte hide
  relHigh: 3, relMinFleet: 20, relMinGroups: 3,  // Audit MET-12: Fahrten je Fahrzeug > 3 × flottengewichteter Median desselben Anbieters und derselben Art (≥ 3 Gemeinden mit ≥ 20 Fzg.) → gelb, nie rot
                                                 // Sprint 1, S1.6: Median ohne die geprüfte Gruppe (eine große Flotte zog ihn bisher selbst nach oben, z. B. nextbike Köln)
  relocWarn: 0.10, relocR: 0.4,                  // S1.6 „Umsetzung im Fahrtentakt“: Umsetzungen ÷ (Umsetzungen + Fahrtbeginne) > 10 % und r(Umsetzungen, Fahrtbeginne) je Stunde > 0,4
                                                 // → Fahrten zählen vermutlich als Umsetzung (stabile Kennungen im Modus „unbekannt“ oder „rotierend“)
  modeFlip: true,                                // S1.6 „Moduswechsel heute“: Kennungsmodus einer Quelle der Gruppe hat am Tag gewechselt (events → modeChanges)
  cityDev: [0.5, 2], cityMinOps: 3,              // A6: Fahrten je Fahrzeug unter 0,5 × bzw. über 2 × Median der übrigen Anbieter derselben Art in der Stadt (≥ 3 Anbieter mit ≥ 20 Fzg.) → gelb
};
const LEVEL = { ok: 0, warn: 1, bad: 2 };
const numOf = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : v && typeof v === 'object' ? [v.p005, v.pct, v.share, v.value, v.floor].find(x => typeof x === 'number' && Number.isFinite(x)) ?? null : null);
const corr = (a, b) => { const n = a.length; if (n < 2) return null; const ma = sum(a) / n, mb = sum(b) / n; let ab = 0, aa = 0, bb = 0; for (let i = 0; i < n; i++) { ab += (a[i] - ma) * (b[i] - mb); aa += (a[i] - ma) ** 2; bb += (b[i] - mb) ** 2; } return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : null; };
const r3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);
/**
 * Ampel je Gemeinde|Anbieter|Art aus einem Tagesdokument (nur gemessene Stunden ohne Lücke). sources: latest.json sources (für
 * idleUnusable/batteryFloor der Quellen des Anbieters in der Gemeinde; fehlende Felder = kein Befund). Rückgabe { day, rules, groups } mit
 * groups[k] = { level, checks: { rides, pickupShare, r, swapsPer100, se, hideShare?, idleUnusable?, batteryFloor?, flags[] } } – nur
 * Gruppen mit ≥ minRides Fahrten oder einem Quellenbefund.
 * ruleNow: aktueller Regelstand (METHOD_VERSION) des Sammlers. dayRules = Regelstände der gezählten Läufe des Tags (Teil vor „@“, "" = ohne,
 * mehrere = gemischter Tag); ruleCurrent = Tag einheitlich mit ruleNow (null ohne ruleNow). Sonst wird rot zu gelb (was: 'bad', Flag oldRule,
 * checks.oldRule = dayRules): Befund aus älterem Regelstand, kein Ausschluss (bis 02.11.2026 blieben Lime Stuttgart/Essen/Wuppertal wegen des
 * schon behobenen Ladestand-Fehlers bis zum ersten vollen Tag mit neuem Regelstand rot und fielen aus Bericht und Rangliste).
 */
export function eventChecks(doc, sources = [], rules = EVENT_CHECKS, { ruleNow = null } = {}) {
  if (!doc?.groups) return null;
  const dayRules = [...new Set((doc.runs || []).filter(r => Array.isArray(r) && r[1] != null && !isGapRun(r)).map(r => ruleVersion(r) ?? ''))].sort();
  const ruleCurrent = ruleNow == null ? null : dayRules.length === 1 && dayRules[0] === ruleNow;
  const obs = observedMinutesEnd(doc.runs); for (const h of Array.isArray(doc.gapHours) ? doc.gapHours : []) if (h >= 0 && h < 24) obs[h] = 0; // Endstunde wie Ereignisse und Fahrzeugminuten
  const hrs = obs.map((m, h) => (m > 0 ? h : -1)).filter(h => h >= 0);
  const live = (sources || []).filter(s => s && ['live', 'delayed', 'stale'].includes(s.status));
  const srcOf = (ags, op) => live.filter(s => s.operator === op && (s.municipalities || []).includes(ags));
  const groups = {}, rel = [], pending = new Map();
  for (const [k, g] of Object.entries(doc.groups)) {
    const [ags, op, ty] = k.split('|'); if (!ags || ags === 'DE' || !g) continue;
    const at = (f) => hrs.map(h => +(g[f]?.[h]) || 0);
    const st = at('start'), pu = at('pickup'), rl = at('reloc'), rides = sum(st), ends = sum(at('end')), pick = sum(pu), swaps = sum(at('swap')), hide = sum(at('hide')), reloc = sum(rl);
    const c = { rides, flags: [] }; let lv = 0;
    { const vm = sum(at('vminTot')), om = sum(hrs.map(h => obs[h])); if (om > 0 && vm > 0) rel.push({ k, key: `${op}|${ty}`, fleet: vm / om, rvd: rides / (vm / om) * (1440 / Math.max(om, 1)) }); }
    const flag = (name, l) => { c.flags.push(name); lv = Math.max(lv, LEVEL[l]); };
    if (rides >= rules.minRides) {
      c.pickupShare = r3(pick / (pick + rides)); c.r = hrs.length >= rules.minHours ? r3(corr(pu, st)) : null; c.se = ends > 0 ? r3(rides / ends) : null;
      c.swapsPer100 = r3((swaps / rides) * 100);
      if (c.r != null && c.r > rules.pickupR && c.pickupShare > rules.pickupWarn) flag('pickup', c.pickupShare > rules.pickupBad ? 'bad' : 'warn');
      if (c.se != null && (c.se < rules.seWarn[0] || c.se > rules.seWarn[1])) flag('se', c.se < rules.seBad[0] || c.se > rules.seBad[1] ? 'bad' : 'warn');
      if (ty === 'scooter' && swaps === 0 && rides >= rules.swapZeroRides) flag('swap0', 'warn');
      if (hide > 0) { c.hideShare = r3(hide / (hide + rides)); if (c.hideShare > rules.hideWarn) flag('hide', 'warn'); }
      if (rules.relocWarn != null && reloc > 0) {
        c.relocShare = r3(reloc / (reloc + rides)); c.relocR = hrs.length >= rules.minHours ? r3(corr(rl, st)) : null;
        if (c.relocShare > rules.relocWarn && c.relocR != null && c.relocR > rules.relocR) flag('relocTrips', 'warn');
      }
    }
    // Quellenfelder (lib/pulse-core.js, Sammler): idleUnusable true mit idleCheck.shortShare bzw. Anteil; batteryFloor { p005, hides } bzw. Zahl in %.
    // Untergrenze nur als Befund, solange am Tag keine Ausblendungen (hide) gezählt sind – sonst ist die Korrektur schon aktiv.
    const src = srcOf(ags, op);
    if (rules.modeFlip && Array.isArray(doc.modeChanges) && doc.modeChanges.length) {
      const ids = new Set(src.map(s => s.id)), n = doc.modeChanges.filter(m => ids.has(m[1])).length;
      if (n) { c.modeChanges = n; flag('modeFlip', 'warn'); }
    }
    const idle = src.map(s => (s.idleUnusable === true ? numOf(s.idleCheck?.shortShare) ?? 1 : s.idleUnusable === false ? null : numOf(s.idleUnusable))).filter(v => v != null);
    const fl = src.map(s => s.batteryFloor).filter(v => v != null && v !== false), floor = fl.map(v => numOf(v)).filter(v => v != null);
    const hides = fl.some(v => (v && typeof v === 'object' ? v.hides === true : numOf(v) >= rules.batteryFloorWarn));
    if (idle.length) { c.idleUnusable = r3(Math.max(...idle)); if (c.idleUnusable > rules.idleUnusableWarn) flag('idle', 'warn'); }
    if (floor.length) { c.batteryFloor = Math.max(...floor); if (hides && c.batteryFloor >= rules.batteryFloorWarn && !(hide > 0)) flag('batteryFloor', 'warn'); }
    pending.set(k, { c, lv, rides, idle: idle.length, floor: floor.length });
    if (rides < rules.minRides && !c.flags.length && !idle.length && !floor.length) continue;
    if (lv === 2 && ruleCurrent === false) { c.flags.push('oldRule'); c.oldRule = dayRules; groups[k] = { level: 'warn', was: 'bad', checks: c }; continue; }
    groups[k] = { level: lv === 2 ? 'bad' : lv === 1 ? 'warn' : 'ok', checks: c };
  }
  // relative Prüfung (MET-12): Gruppe weit über dem Median ihres Anbieters und ihrer Art (z. B. nextbike Köln 6,85 Fahrten je Rad gegen 1–2)
  if (rules.relHigh) {
    const by = new Map(); for (const x of rel) if (x.fleet >= (rules.relMinFleet ?? 20)) (by.get(x.key) || by.set(x.key, []).get(x.key)).push(x);
    for (const list of by.values()) {
      if (list.length < (rules.relMinGroups ?? 3)) continue;
      // nach Flotte gewichteter Median: viele kleine Orte mit wenig Nutzung (nextbike-Kleinstädte) sollen den Maßstab nicht drücken
      const wmed = (arr) => { const v = arr.slice().sort((a, b) => a.rvd - b.rvd), half = arr.reduce((s, x) => s + x.fleet, 0) / 2; let acc = 0; for (const x of v) { acc += x.fleet; if (acc >= half) return x.rvd; } return v[v.length - 1].rvd; };
      for (const x of list) { const med = wmed(list.filter(y => y !== x)); if (!(med > 0 && x.rvd > rules.relHigh * med)) continue; // Median ohne die geprüfte Gruppe (S1.6)
        const p = pending.get(x.k); if (!p || p.rides < rules.minRides) continue;
        const gr = groups[x.k] || (groups[x.k] = { level: 'ok', checks: p.c });
        gr.checks.relHigh = r3(x.rvd / med); gr.checks.relMedian = r3(med); if (!gr.checks.flags.includes('relHigh')) gr.checks.flags.push('relHigh');
        if (gr.level === 'ok') gr.level = 'warn';
      }
    }
  }
  // A6: zweite Prüfgröße – Abweichung vom Median der übrigen Anbieter derselben Art in derselben Stadt (Dott in Köln/Stuttgart/Essen bei 39–62 % von Voi und Bolt)
  if (rules.cityDev) {
    const by = new Map(); for (const x of rel) if (x.fleet >= (rules.relMinFleet ?? 20)) { const [ags, , ty] = x.k.split('|'); const kk = `${ags}|${ty}`; (by.get(kk) || by.set(kk, []).get(kk)).push(x); }
    for (const list of by.values()) {
      if (list.length < (rules.cityMinOps ?? 3)) continue;
      for (const x of list) {
        const o = list.filter(y => y !== x).map(y => y.rvd).sort((a, b) => a - b), med = o.length % 2 ? o[o.length >> 1] : (o[o.length / 2 - 1] + o[o.length / 2]) / 2;
        if (!(med > 0)) continue; const f = x.rvd / med; if (f >= rules.cityDev[0] && f <= rules.cityDev[1]) continue;
        const p = pending.get(x.k); if (!p || p.rides < rules.minRides) continue;
        const gr = groups[x.k] || (groups[x.k] = { level: 'ok', checks: p.c });
        gr.checks.cityDev = r3(f); gr.checks.cityMedian = r3(med); if (!gr.checks.flags.includes('cityDev')) gr.checks.flags.push('cityDev');
        if (gr.level === 'ok') gr.level = 'warn';
      }
    }
  }
  return { day: doc.day || null, version: rules.version, rules, dayRules, ruleNow, ruleCurrent, groups };
}
/** Rote Gruppen (Schlüssel Gemeinde|Anbieter|Art) aus latest.json → eventChecks */
export const ampelRed = (ec) => new Set(Object.entries(ec?.groups || {}).filter(([, v]) => v?.level === 'bad').map(([k]) => k));

// ---------- Kennzahlen ----------
/**
 * Kennzahlen einer Gruppe (oder Summe mehrerer Gruppen gleicher Art) für einen Tag.
 * g: Stundenwerte (start, end, rot, vmin, vminTot, tripDur*, tripDist*), obsMin: beobachtete Minuten je Stunde,
 * fleetFallback: Ø Flotte, wenn noch keine Fahrzeugminuten vorliegen (ältere Tagesdateien).
 */
// hourMin: Minuten je Ortsstunde des Tages (events/<Tag>.json → hourMin; Zeitumstellung: Stunde 2 = 120 bzw. 0 Min.). Die Abdeckung
// rechnet je Stunde bis zu hourMin/60 Stunden an; ridesDay bezieht sich so immer auf einen 24-Stunden-Tag (Stunde 2 nicht doppelt).
// assume: Ø Fahrt je Art aus der Kalibrierung (pulse-calib rideAssumptions: { scooter: { min, km, calibrated } … }); fehlt sie, gilt DEFAULT_RIDE.
export function kpis({ g, obsMin, obsMinV = null, profile = DEFAULT_PROFILE, plan = null, type = 'scooter', fleetFallback = null, ride = null, assume = null, realization = DEFAULTS.realization, net = true, hourMin = null }) {
  // Stunden ohne Beobachtung (z. B. gestörte Stunden nach einer Lücke) zählen auch mit ihren Ereignissen und Fahrzeugminuten nicht
  const on = (a) => (a || []).map((x, h) => ((obsMin[h] || 0) > 0 || (obsMinV?.[h] || 0) > 0 ? x : 0)); // Endstunde eines Laufs zählt mit (S1.1)
  g = { ...g, start: on(g.start), end: on(g.end), rot: on(g.rot), vmin: on(g.vmin), vminTot: on(g.vminTot) };
  const rides = sum(g.start), ends = sum(g.end), rot = sum(g.rot);
  // Abdeckung (S1.2): beobachtete Minuten anteilig je Stunde (observedMinutes), daher keine Kappung auf 60 Minuten mehr nötig; die Grenze
  // hourMin (Länge der Ortsstunde) greift nur bei fehlerhaften Eingaben
  const coverage = profile.reduce((a, p, h) => a + p * Math.min((hourMin?.[h] ?? 60) / 60, (obsMin[h] || 0) / 60), 0);
  const obsTotal = sum(obsMin);
  // Nenner für Fahrzeugminuten: nur Läufe, die sie gezählt haben (ältere Tagesdateien: Ø Bestand aus dem Verlauf)
  const obsV = obsMinV ? sum(obsMinV) : obsTotal;
  const vminTot = sum(g.vminTot), vmin = sum(g.vmin);
  const fleet = vminTot > 0 && obsV > 0 ? vminTot / obsV : fleetFallback;
  const avail = vmin > 0 && obsV > 0 ? vmin / obsV : null;
  const ridesDay = coverage > 0 ? rides / coverage : null;
  const def = assume?.[type] || DEFAULT_RIDE[type] || DEFAULT_RIDE.unknown;
  const cal = !!def.calibrated;
  const measured = (g.tripDurN || 0) >= DEFAULTS.minTripsMeasured;
  // gemessene Dauer ist auf das Sammler-Raster (20 Min) gerundet → nur als Obergrenze nutzen: mit kalibrierter Annahme gilt sie nur darunter,
  // sonst höchstens die doppelte Annahme. Gemessene Distanz ist Luftlinie (Untergrenze): mit kalibrierter Annahme gilt sie nur darüber.
  const mMin = measured ? g.tripDurSum / g.tripDurN / 60e3 : null;
  const avgMin = ride?.min ?? (measured ? Math.min(mMin, cal ? def.min : def.min * 2) : def.min);
  const mKm = (g.tripDistN || 0) >= DEFAULTS.minTripsMeasured ? g.tripDistSum / g.tripDistN / 1000 : null;
  const avgKm = ride?.km ?? (mKm != null ? (cal ? Math.max(mKm, def.km) : mKm) : def.km);
  const durationSource = ride?.min != null ? 'Vorgabe' : measured && (!cal || mMin < def.min) ? 'gemessen' : cal ? 'kalibriert' : 'Annahme';
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
    avgMin, avgKm, durationSource, utilization, perRide, revDay,
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

// ---------- Preisänderungen ----------
const PRICE_FIELDS = ['name', 'currency', 'unlock', 'perMin', 'perKm', 'taxable', 'surge'];
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/**
 * Änderungen an system_pricing_plans zwischen zwei Ständen (pricing.json-Format { plans: [{ sourceId, operator, plans: [...] }] }).
 * Nur Quellen, die in beiden Ständen Tarife haben (Ausfall ≠ Abschaffung). Rückgabe [[at, sourceId, operator, planId, field, alt, neu]];
 * field '+plan' / '-plan' für neue bzw. entfallene Tarife (Wert = Name).
 */
export function pricingChanges(prev, next, at) {
  const out = [];
  const bySrc = new Map((prev?.plans || []).map(p => [p.sourceId, p]));
  for (const n of next?.plans || []) {
    const p = bySrc.get(n.sourceId); if (!p?.plans?.length || !n.plans?.length) continue;
    const old = new Map(p.plans.map(x => [String(x.id), x])), cur = new Map(n.plans.map(x => [String(x.id), x]));
    for (const [id, x] of cur) {
      const o = old.get(id);
      if (!o) { out.push([at, n.sourceId, n.operator, id, '+plan', null, x.name ?? null]); continue; }
      for (const f of PRICE_FIELDS) if (!same(o[f], x[f])) out.push([at, n.sourceId, n.operator, id, f, o[f] ?? null, x[f] ?? null]);
    }
    for (const [id, o] of old) if (!cur.has(id)) out.push([at, n.sourceId, n.operator, id, '-plan', o.name ?? null, null]);
  }
  return out;
}
