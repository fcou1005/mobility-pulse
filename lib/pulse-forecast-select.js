// @ts-check
// Mobility Pulse — Prognose – Hybrid, Entscheidungsregel, Modellwahl gegen die bessere Basis, Modell zum Mitnehmen, Eingabe (aus pulse-forecast.js geschnitten; pulse-forecast.js bleibt die Fassade für alle Importe).
import * as E from './pulse-econ.js';
import { hourOf, dayOf } from './pulse-track.js';
import { CTX_KEYS } from './pulse-context.js';
import { ALPHA, CLS, EFFECTS, GATES, I_CLS, I_CTX, I_HOUR, I_TH, I_WE, I_WX, MODELS, NE, NW, SHADOW_ONLY, TYPES, WE_CLS, WX_EFF, classOf, envOf, eta, feedbackUpdate, feedbackWeights, fitPooled, pos, predictAdaptive, predictPooled, predictProfile, scoreDay, scoreOf, sum, typeIx, wxFeatures } from './pulse-forecast-model.js';
import { lastExposure } from './pulse-forecast-series.js';

// ---------- Hybrid: Niveau „wie gestern“, Tagesgang aus dem Modell (Kandidat „hybrid“) ----------
// „Wie gestern“ trifft das Tagesniveau einer Gruppe gut, das Modell den Tagesgang. Der Hybrid nimmt die Basisprognose (Mittel aus eigenem Profil
// und gepooltem Modell) und skaliert sie je Gruppe so, dass ihre Summe über die Stunden, die am Bezugstag beobachtet wurden, den dort gezählten
// Fahrtbeginnen entspricht (geschrumpft mit HYBRID.k Pseudo-Fahrten). Bezugstag = letzter vollständiger Tag desselben Tagtyps (≤ HYBRID.maxBack
// Tage zurück); für Werktage notfalls ein Ferienwerktag und umgekehrt. Für Samstag oder Sonn-/Feiertag ohne passenden Bezugstag bleibt die Basis
// unverändert (bis 6.11.2026 nahm er dann den letzten vollständigen Tag – ein Freitag hätte das Niveau des Samstags gesetzt). Geprüft an den echten Tagen 3.–5.11.2026: Wertung 16,2 % gegen 17,1 % (profile), 17,2 %
// (Mittel profile/pooled) und 18,2 % („wie gestern“). Wird nur aktiv, wenn er in der Selbstprüfung um GATES.adGain besser ist.
export const HYBRID = { k: 20, maxBack: 7 };
/** rows[j] = { g, h, ags, cls } passend zu base[j]; before = Index des Zieltags in days (Bezugstage < before, nur vollständige) */
export function hybridAdjust(R, days, before, rows, base, { k = HYBRID.k } = {}) {
  const cand = []; for (let j = Math.min(before, days.length) - 1; j >= Math.max(0, before - HYBRID.maxBack); j--) if (days[j]?.complete) cand.push(j);
  if (!cand.length) return Float64Array.from(base);
  const want = new Set(cand), yOf = new Map();
  for (let i = 0; i < R.n; i++) { const j = R.day[i]; if (!want.has(j)) continue; let m = yOf.get(j); if (!m) yOf.set(j, m = new Map()); m.set(R.g[i] * 24 + R.hr[i], R.y[i]); }
  // je Gruppe und Tagtyp des Ziels (eine Live-Prognose kann über Mitternacht in einen anderen Tagtyp reichen)
  const refOf = new Map(), Y = new Map(), M = new Map(), key = (r) => r.g * 16 + r.cls;
  const WEEKDAY = [CLS.W, CLS.F], ok2 = (c, t) => c === t || (WEEKDAY.includes(c) && WEEKDAY.includes(t));
  const ref = (r) => { const q = key(r); let x = refOf.get(q); if (x === undefined) { x = cand.find(j => days[j].cls(r.ags) === r.cls) ?? cand.find(j => ok2(days[j].cls(r.ags), r.cls)) ?? null; refOf.set(q, x); } return x; };
  rows.forEach((r, j) => { const rj = ref(r); if (rj == null) return; const y = yOf.get(rj)?.get(r.g * 24 + r.h); if (y == null || !Number.isFinite(base[j])) return; const q = key(r); Y.set(q, (Y.get(q) || 0) + y); M.set(q, (M.get(q) || 0) + base[j]); });
  return Float64Array.from(base, (b, j) => { const q = key(rows[j]), y = Y.get(q), m = M.get(q); return y == null || !(m > 0) ? b : b * (y + k) / (m + k); });
}
const blendBase = (muP, muQ) => Float64Array.from(muQ, (q, j) => (Number.isFinite(muP[j]) ? 0.5 * muP[j] + 0.5 * q : q));

/**
 * Rolling-Origin-Auswertung der Tage evalIdx (Indizes in R.day; nur vollständige, bisher nicht ausgewertete). Rückgabe { [dayIdx]: { trainDays, models } }.
 */
export function evaluateDays(R, evalIdx, { weatherEnabled = true, fb = null, dayName = (d) => String(d), expoBefore = null, days = null, mem = null, prior = null, ext = null, fbC = null, wxTest = null } = {}) {
  const out = {};
  for (const d of evalIdx) {
    const train = [], test = []; for (let i = 0; i < R.n; i++) { if (R.day[i] < d) train.push(i); else if (R.day[i] === d) test.push(i); }
    // S2.4: Wetter des Prüftags nur aus der damals gesicherten Vorhersage (weather-fc/), nie das beobachtete; ohne Vorhersage ohne Wetter
    const restore = wxTest ? swapTestWeather(R, test, (i) => wxTest(String(R.keys[R.g[i]]).split('|')[0], dayName(d), R.hr[i])) : null;
    try {
    const trainDays = new Set(train.map(i => R.day[i])).size;
    if (trainDays < GATES.minTrainDays || !test.length) continue;
    const res = { trainDays, models: {} };
    // Maske (fair): Zeilen, für die „wie gestern“ und – sofern der Tag eine Woche zurück vorliegt – die Vorwoche einen Wert haben (S2.2: Lücken maskiert)
    const wk = days ? days.findIndex(x => x.day === shiftDay(days[d]?.day, -7)) : -1;
    const prevHas = new Set(), wkHas = new Set(); for (let i = 0; i < R.n; i++) { if (R.day[i] === d - 1) prevHas.add(R.g[i] * 24 + R.hr[i]); if (wk >= 0 && R.day[i] === wk) wkHas.add(R.g[i] * 24 + R.hr[i]); }
    const mask = Uint8Array.from(test, (i) => (prevHas.has(R.g[i] * 24 + R.hr[i]) && (wk < 0 || wkHas.has(R.g[i] * 24 + R.hr[i])) ? 1 : 0)); res.mask = mask; res.maskWeek = wk >= 0;
    // Exposition wie im Betrieb: Plan und Live-Prognose kennen nur die Fahrzeugstunden der Vortage (lastExposure), nicht die des Prüftags.
    // Alle Modelle sind proportional zur Exposition, also Prognose × (Exposition der Vortage ÷ tatsächliche) je Zeile; ohne Vortagswert 0.
    const last = expoBefore ? expoBefore(d) : null;
    const scale = Float64Array.from(test, (i) => { if (!last) return 1; const v = last.get(R.keys[R.g[i]])?.[R.hr[i]] ?? 0; return R.e[i] > 0 ? v / R.e[i] : 0; });
    const sc = (mu) => Float64Array.from(mu, (x, j) => (Number.isFinite(x) ? x * scale[j] : x));
    if (last) { let se = 0, sa = 0; test.forEach((i, j) => { se += R.e[i]; sa += Math.abs(R.e[i] * scale[j] - R.e[i]); }); res.expoErr = se > 0 ? +(sa / se).toFixed(4) : null; }
    const muP = sc(predictProfile(R, train, test, R, NaN));
    res.models.profile = scoreDay(R, test, muP.map(x => (Number.isFinite(x) ? x : 0)), 1, { split: true, mask, byAgs: true });
    const m1 = fitPooled(R, train, { weather: false }), mu1 = sc(predictPooled(m1, R, test)); res.models.pooled = scoreDay(R, test, mu1, m1.phi, { split: true, mask, byAgs: true });
    // Modell mit Umgebung (Wetter, wenn das Gate offen ist; Umgebungsmerkmale mit genug Ereignissen; Wirkungen mit Gedächtnis als Prior)
    const env = weatherEnabled ? envOf(R, train, mem, prior) : { weather: false, ctx: [], on: false };
    let muQ = mu1;
    if (env.on) { const m2 = fitPooled(R, train, { weather: env.weather, ctx: env.ctx, prior }); muQ = sc(predictPooled(m2, R, test)); res.models.pooledWx = scoreDay(R, test, muQ, m2.phi, { split: true, mask, byAgs: true }); }
    res.wxGate = env.weather ? true : false; if (env.ctx.length) res.env = env.ctx.map(k => CTX_KEYS[k]);
    // lernendes Modell: Lernstand nur aus Tagen vor d (kein Vorgriff), danach mit d fortschreiben
    const day = dayName(d);
    if (fb && !(fb.upto && fb.upto >= day)) {
      res.models.adaptive = scoreDay(R, test, predictAdaptive(muP, muQ, (j) => R.keys[R.g[test[j]]], feedbackWeights(fb)), m1.phi, { split: true, mask, byAgs: true });
      feedbackUpdate(fb, day, R, test, muP, muQ);
    }
    // Hybrid (Niveau des Bezugstags, Tagesgang aus profile/pooled) und Vergleich der Flottenannahmen (nur mitgeschrieben)
    if (days) {
      const rows = test.map(i => ({ g: R.g[i], h: R.hr[i], ags: String(R.keys[R.g[i]]).split('|')[0], cls: R.cl[i] }));
      const muH = hybridAdjust(R, days, d, rows, blendBase(muP, muQ));
      res.models.hybrid = scoreDay(R, test, muH, m1.phi, { split: true, mask });
      // Chronos: Vortagsprognose (Kontext bis 0 Uhr des Tags, Fahrzeugstunden wie oben aus den Vortagen); fehlende Gruppen nehmen Hybrid
      if (ext?.hasBack?.(day)) {
        const tH = Array.from({ length: 24 }, (_, h) => localToUtcMs(day, h)), muC = Float64Array.from(test, (i) => ext.back(R.keys[R.g[i]], tH[R.hr[i]]));
        if (muC.some(Number.isFinite)) {
          res.models.chronos = scoreDay(R, test, Float64Array.from(muC, (c, j) => (Number.isFinite(c) ? c : muH[j])), m1.phi, { split: true, mask });
          if (fbC && !(fbC.upto && fbC.upto >= day)) {
            res.models.blend = scoreDay(R, test, predictAdaptive(muC, muH, (j) => R.keys[R.g[test[j]]], feedbackWeights(fbC)), m1.phi, { split: true, mask });
            feedbackUpdate(fbC, day, R, test, muC, muH);
          }
        }
      }
      if (last) { const alt = {}; for (const mode of ['class', 'mean']) { const lx = lastExposure(days, d, { target: days[d].cls, mode }); let se = 0, sa = 0; for (const i of test) { const v = lx.get(R.keys[R.g[i]])?.[R.hr[i]] ?? 0; se += R.e[i]; sa += Math.abs(v - R.e[i]); } alt[mode] = se > 0 ? +(sa / se).toFixed(4) : null; } res.expoErrAlt = alt; }
    }
    if (restore) res.wxFc = restore.share;
    out[d] = res;
    } finally { restore?.(); }
  }
  return out;
}
/** S2.4: Wettermerkmale der Zeilen sel vorübergehend durch f(i) ersetzen (null → ohne Wetter); Rückgabe: Funktion zum Zurücksetzen, .share = Anteil mit Vorhersage */
export function swapTestWeather(R, sel, f) {
  const K = R.w.length, old = sel.map(i => [...R.w.map(a => a[i]), R.hasW[i]]); let n = 0;
  for (const i of sel) { const x = f(i); if (x) n++; for (let k = 0; k < K; k++) R.w[k][i] = x ? x[k] ?? 0 : 0; R.hasW[i] = x ? 1 : 0; }
  const back = () => { sel.forEach((i, j) => { for (let k = 0; k < K; k++) R.w[k][i] = old[j][k]; R.hasW[i] = old[j][K]; }); };
  back.share = sel.length ? +(n / sel.length).toFixed(3) : null;
  return back;
}

/** Modellwahl aus den letzten Auswertungen { 'YYYY-MM-DD': { models: { profile: {wapeGD…} … } } } */
// ---------- Entscheidungsregel (seit 6.11.2026 abends) ----------
// Ziel: so nah wie möglich am Ist. Jede Prognose wird gegen das Ist gewichtet, sobald es vorliegt – in der Selbstprüfung (Rolling Origin, ein Tag voraus)
// und live (jede veröffentlichte Prognose mit allen Kandidaten als Schattenprognose). Maßstab je Kandidat: Abweichung ÷ Abweichung von „wie gestern“
// über dieselben Stunden (< 1 = besser). Live zählt mit dem Gewicht n ÷ (n + DECIDE.liveK) (n = bewertete Live-Prognosen des Kandidaten, jüngere
// mit Halbwertszeit DECIDE.halfLifeDays stärker), sobald DECIDE.liveMin vorliegen; sonst gilt die Selbstprüfung allein (Stufen wie bisher).
// Gewechselt wird nur, wenn ein Kandidat das bisher aktive Modell um DECIDE.switchGain schlägt (kein Hin und Her). Schlägt kein Modell die
// Vergleichswerte („wie gestern“ zum Zeitpunkt der Ausgabe, gleicher Wochentag der Vorwoche) bei mindestens DECIDE.baseMin Live-Prognosen,
// wird der bessere Vergleichswert veröffentlicht – und als solcher ausgewiesen.
// S2.6: Mindestvolumen je Familie (Fahrtbeginne je Tag, Mittel der letzten 7 vollständigen Tage, gezählt); micro ohne Grenze
export const MIN_VOLUME = { moped: 500, car: 500 };
export function volumeOf(days, n = 7) {
  const full = (days || []).filter(d => d.complete).slice(-n); if (!full.length) return null;
  let s = 0; for (const d of full) for (const g of Object.values(d.groupsRaw ?? d.groups ?? {})) for (const x of g?.start || []) s += x || 0;
  return s / full.length;
}
// S2.8: Verzerrung je Fahrzeugart aus der Selbstprüfung (letzte BIAS.days reife Tage, Σ Ist ÷ Σ Prognose des Modells, geschrumpft mit BIAS.k
// Fahrtbeginnen, begrenzt auf [0,8; 1,25]) – angewandt auf Veröffentlichung und Schattenprognosen; Prüfung bleibt unkorrigiert (kein Vorgriff).
// Nur Modelle ohne eigenes Tagesniveau: hybrid, blend und chronos übernehmen das Niveau des letzten Tags – eine 7-Tage-Korrektur liefe dort einem
// Trend hinterher (synthetischer Saisonabfall: hybrid 10,3 → 11,0 %, gepoolt 14,1 → 10,8 %).
export const BIAS = { days: 7, k: 500, min: 0.8, max: 1.25, models: ['profile', 'pooled', 'pooledWx', 'adaptive'], agsMin: 20, kAgs: 500 };
export function typeFactors(evals, model, { before = null } = {}) {
  const ds = Object.keys(evals || {}).sort().filter(d => (!before || d < before) && !(evals[d]?.trainDays < GATES.minEvalTrainDays) && evals[d]?.models?.[model]?.byType).slice(-BIAS.days);
  const acc = {}; for (const d of ds) for (const [t, a] of Object.entries(evals[d].models[model].byType)) { if (!(a?.length >= 4)) continue; const x = acc[t] || (acc[t] = [0, 0]); x[0] += a[2]; x[1] += a[3]; }
  return Object.fromEntries(Object.entries(acc).filter(([, x]) => x[1] > 0).map(([t, [y, m]]) => [t, +Math.min(BIAS.max, Math.max(BIAS.min, (y + BIAS.k) / (m + BIAS.k))).toFixed(4)]));
}
// S2.8 je Gemeinde: Σ Ist ÷ Σ Prognose je Gemeinde und Art über dieselben Tage, geschrumpft zum Faktor der Art (kAgs Fahrtbeginne):
// f = (Y + kAgs · f_Art) ÷ (M + kAgs), begrenzt wie oben. Gemeinden unter agsMin Fahrtbeginnen am Tag fehlen in byAgsType und behalten f_Art.
export function agsFactors(evals, model, tf, { before = null } = {}) {
  const ds = Object.keys(evals || {}).sort().filter(d => (!before || d < before) && !(evals[d]?.trainDays < GATES.minEvalTrainDays) && evals[d]?.models?.[model]?.byType).slice(-BIAS.days);
  const acc = {}; for (const d of ds) for (const [k, a] of Object.entries(evals[d].models[model].byAgsType || {})) { const x = acc[k] || (acc[k] = [0, 0]); x[0] += a[0]; x[1] += a[1]; }
  const out = {};
  for (const [k, [y, m]] of Object.entries(acc)) { const ft = tf?.[k.split('|')[1]] ?? 1, f = Math.min(BIAS.max, Math.max(BIAS.min, (y + BIAS.kAgs * ft) / (m + BIAS.kAgs))); if (Math.abs(f - ft) >= 0.005) out[k] = +f.toFixed(4); }
  return out;
}
/** Faktor je Gruppe 'ags|op|ty': Gemeinde und Art, sonst Art, sonst 1 */
export const biasFactorOf = (key, tf, af) => { const [ags, , ty] = String(key).split('|'); return af?.[`${ags}|${ty}`] ?? tf?.[ty] ?? 1; };
export const DECIDE = { liveMin: 6, liveK: 6, halfLifeDays: 3, switchGain: 0.02, baseMin: 12, minSwitchDays: 7, holdOverride: 0.10 };
// ---------- S2.2/S2.3 (A11): Maßstab = bessere Basis, Summenverhältnis; Chronos und Mischung erst nach geprüftem Vorsprung ----------
// Maßstab je Kandidat: Σ Abweichung ÷ min(Σ Abweichung „wie gestern“, Σ Abweichung „Vorwoche“) über dieselben Tage bzw. Live-Prognosen (vorher Mittel der
// Verhältnisse gegen „wie gestern“ allein – ein schlechter Vergleichstag zog das Mittel). Selbstprüfung über die Stunden, für die beide Vergleichswerte
// einen Wert haben (fair, Lücken maskiert), sofern der Tag so gewertet ist. Chronos und blend: wählbar erst, wenn Diebold-Mariano (HLN-Korrektur,
// Tagesverluste, ≥ DM.minDays Tage) gegen das gewählte Modell p < DM.p ergibt. Gewechselt wird höchstens alle DECIDE.minSwitchDays Tage.
export const DM = { minDays: 14, p: 0.10, gated: ['chronos', 'blend'] };
const scoreFair = (x) => scoreOf(x?.fair ?? x);
function betacf(a, b, x) { let c = 1, d = 1 - (a + b) * x / (a + 1); d = 1 / (Math.abs(d) < 1e-30 ? 1e-30 : d); let h = d;
  for (let m = 1; m <= 200; m++) { const m2 = 2 * m; let aa = m * (b - m) * x / ((a + m2 - 1) * (a + m2)); d = 1 + aa * d; d = 1 / (Math.abs(d) < 1e-30 ? 1e-30 : d); c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30; h *= d * c;
    aa = -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1)); d = 1 + aa * d; d = 1 / (Math.abs(d) < 1e-30 ? 1e-30 : d); c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30; const del = d * c; h *= del; if (Math.abs(del - 1) < 3e-12) break; }
  return h; }
const lgam = (x) => { const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]; let y = x, t = x + 5.5; t -= (x + 0.5) * Math.log(t); let ser = 1.000000000190015; for (const c of g) ser += c / ++y; return -t + Math.log(2.5066282746310005 * ser / x); };
const ibeta = (a, b, x) => { if (x <= 0) return 0; if (x >= 1) return 1; const bt = Math.exp(lgam(a + b) - lgam(a) - lgam(b) + a * Math.log(x) + b * Math.log(1 - x)); return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b; };
/** Verteilungsfunktion der t-Verteilung mit nu Freiheitsgraden */
export const tCdf = (t, nu) => { const p = 0.5 * ibeta(nu / 2, 0.5, nu / (nu + t * t)); return t < 0 ? p : 1 - p; };
/**
 * Diebold-Mariano mit Harvey-Leybourne-Newbold-Korrektur (h = 1), einseitig: kleiner ist besser. a, b = Tagesverluste gleicher Tage.
 * Rückgabe { n, d (mittlere Differenz a − b), stat, p } – p klein = a schlägt b; null unter 3 Tagen oder ohne Streuung.
 */
export function dmTest(a, b) {
  const n = Math.min(a.length, b.length); if (n < 3) return null;
  const dd = Array.from({ length: n }, (_, i) => a[i] - b[i]), m = sum(dd) / n, g0 = dd.reduce((s, x) => s + (x - m) ** 2, 0) / n;
  if (!(g0 > 0)) return { n, d: m, stat: m < 0 ? -Infinity : m > 0 ? Infinity : 0, p: m < 0 ? 0 : 1 };
  const stat = (m / Math.sqrt(g0 / n)) * Math.sqrt((n - 1) / n);
  return { n, d: +m.toFixed(5), stat: +stat.toFixed(4), p: +tCdf(stat, n - 1).toFixed(4) };
}
/** Tagesverluste (scoreOf, fair, sonst gesamt) von Kandidat und Bezug über gemeinsame reife Tage bis vor `before` (Ortstag, exklusiv) */
export function dailyLosses(evals, cand, ref, { before = null } = {}) {
  const ds = Object.keys(evals || {}).sort().filter(d => (!before || d < before) && !(evals[d]?.trainDays < GATES.minEvalTrainDays));
  const a = [], b = [];
  for (const d of ds) { const x = scoreFair(evals[d]?.models?.[cand]), y = scoreFair(evals[d]?.models?.[ref]); if (x != null && y != null) { a.push(x); b.push(y); } }
  return { a, b };
}
/** Gesperrte Kandidaten (DM.gated ohne geprüften Vorsprung gegen ref) und die Testergebnisse je Kandidat */
export function dmGate(evals, ref, { before = null } = {}) {
  const tests = {}, without = [];
  for (const m of DM.gated) {
    if (m === ref) continue;
    const { a, b } = dailyLosses(evals, m, ref || 'hybrid', { before }), t = a.length >= DM.minDays ? dmTest(a, b) : null;
    tests[m] = t ? { ...t, ok: t.p < DM.p } : { n: a.length, ok: false };
    if (!tests[m].ok) without.push(m);
  }
  return { without, tests };
}
/** Live-Maßstab je Kandidat aus log.live (nur Einträge mit Schattenwerten, v ≥ 2): { m: { r, n } }; untilMs = nur bis dahin abgeschlossene */
export function liveRelative(live, { untilMs = Infinity, nowMs = Date.now() } = {}) {
  const acc = {};
  for (const rec of Object.values(live || {})) {
    if (!(rec?.v >= 2) || !rec.models?.naive?.w || !(rec.from + 27 * 3600e3 <= untilMs)) continue;
    const w = 2 ** (-Math.max(0, (nowMs - rec.from) / 86400e3) / DECIDE.halfLifeDays), bn = rec.models.naive.w, bw = rec.models.week?.w ?? bn;
    for (const [m, x] of Object.entries(rec.models)) { if (x?.w == null) continue; const a = (acc[m] ||= { s: 0, bn: 0, bw: 0, n: 0 }); a.s += w * x.w; a.bn += w * bn; a.bw += w * bw; a.n++; }
  }
  // S2.2: Σ Abweichung ÷ min(Σ „wie gestern“, Σ Vorwoche) über dieselben Prognosen (Summenverhältnis gegen die bessere Basis)
  return Object.fromEntries(Object.entries(acc).map(([m, a]) => [m, { r: +(a.s / Math.min(a.bn, a.bw)).toFixed(4), n: a.n, base: a.bw < a.bn ? 'week' : 'naive' }]));
}
/** S2.2: Selbstprüfung relativ zur besseren Basis über die reifen Tage days: Σ Wertung ÷ min(Σ „wie gestern“, Σ Vorwoche) (fair, wo vorhanden) */
export function selfRelative(evals, m, days) {
  let s = 0, bn = 0, bw = 0, n = 0;
  for (const d of days) { const x = scoreFair(evals[d]?.models?.[m]), a = scoreFair(evals[d]?.models?.naive); if (x == null || !(a > 0)) continue; const b = scoreFair(evals[d]?.models?.week) ?? a; s += x; bn += a; bw += b; n++; }
  return n >= GATES.minEvalDays ? { r: s / Math.min(bn, bw), n, base: bw < bn ? 'week' : 'naive' } : null;
}
export function chooseModel(evals, { trainDays = 0, without = [], live = null, prevActive = null, switchedAt = null, nowMs = Date.now(), untilMs = Infinity } = {}) {
  // S2.3: Chronos und Mischung nur mit geprüftem Vorsprung (Diebold-Mariano gegen das bisher aktive Modell, sonst gegen Hybrid)
  const dm = dmGate(evals, prevActive && !DM.gated.includes(prevActive) ? prevActive : 'hybrid', { before: untilMs < Infinity ? dayOf(untilMs) : null });
  without = [...new Set([...without, ...dm.without])];
  const base = chooseModelSelf(evals, { trainDays, without });
  const L = liveRelative(live, { untilMs, nowMs }), liveN = Math.max(0, ...Object.values(L).map(x => x.n));
  // Wechselsperre: innerhalb von DECIDE.minSwitchDays nach dem letzten Wechsel bleibt das bisherige Modell, außer der neue Kandidat ist um mindestens
  // DECIDE.holdOverride besser (ratio = neuer ÷ bisheriger Maßstab) oder das bisherige steht nicht mehr zur Wahl
  const hold = (r, ratio) => { const q = ratio?.(r.active, prevActive);
    return prevActive && switchedAt != null && r.active && r.active !== prevActive && !without.includes(prevActive) && nowMs - switchedAt < DECIDE.minSwitchDays * 86400e3 && !(q != null && q <= 1 - DECIDE.holdOverride)
      ? { ...r, active: prevActive, reason: `${r.reason}; bleibt ${prevActive}: höchstens ein Wechsel je ${DECIDE.minSwitchDays} Tage`, why: { ...(r.why || { model: prevActive }), model: prevActive, held: r.active } } : r; };
  const selfRatio = (a, b) => (base.scores?.[a] != null && base.scores?.[b] > 0 ? base.scores[a] / base.scores[b] : null);
  if (!base.active || liveN < DECIDE.liveMin) return hold({ ...base, live: Object.keys(L).length ? L : null, dm: dm.tests }, selfRatio);
  // Selbstprüfung relativ zur besseren Basis über dieselben reifen Tage
  const days = Object.keys(evals || {}).sort().filter(d => !(evals[d]?.trainDays < GATES.minEvalTrainDays)).slice(-GATES.evalWindow);
  const selfRel = (m) => selfRelative(evals, m, days)?.r ?? null;
  const comb = {};
  for (const m of [...MODELS, ...SHADOW_ONLY, 'naive', 'week']) {
    if (without.includes(m)) continue;
    const s = m === 'naive' ? 1 : selfRel(m), l = L[m];
    if (['naive', 'week'].includes(m) && !(l?.n >= DECIDE.baseMin)) continue; // Vergleichswerte erst nach genug Live-Prognosen wählbar
    if (l?.n >= DECIDE.liveMin) { const w = l.n / (l.n + DECIDE.liveK); comb[m] = { r: s == null ? l.r : (1 - w) * s + w * l.r, w, n: l.n, self: s, live: l.r }; }
    else if (s != null && !['naive', 'week'].includes(m)) comb[m] = { r: s, w: 0, n: 0, self: s, live: null };
  }
  const ranked = Object.entries(comb).sort((a, b) => a[1].r - b[1].r);
  if (!ranked.length) return { ...base, live: L };
  let [act, c] = ranked[0];
  const keep = prevActive && comb[prevActive] && comb[prevActive].r <= c.r * (1 + DECIDE.switchGain) ? prevActive : null;
  if (keep) { act = keep; c = comb[keep]; }
  const f2 = (x) => (x == null ? '–' : x.toFixed(2).replace('.', ','));
  const reason = `Live und Selbstprüfung: ${act} liegt bei ${f2(c.r)} × bessere Basis („wie gestern“ oder Vorwoche) (live ${f2(c.live)} aus ${c.n} Prognosen, Gewicht ${Math.round(c.w * 100)} %, Selbstprüfung ${f2(c.self)})${keep && ranked[0][0] !== keep ? `; bleibt, ${ranked[0][0]} ist nur ${f2(ranked[0][1].r)} – unter ${Math.round(DECIDE.switchGain * 100)} % Vorsprung` : ''}${['naive', 'week'].includes(act) ? ' – kein Modell schlägt die Vergleichswerte, veröffentlicht wird der bessere Vergleichswert' : ''}`;
  // why: dieselbe Begründung als Felder, damit die Oberfläche sie übersetzt und Modellnamen ausschreibt (Audit 11.11.2026, MET-08/UXM-23);
  // ändert die Wahl nicht
  const why = { model: act, r: +c.r.toFixed(4), live: c.live == null ? null : +c.live.toFixed(4), n: c.n, w: +c.w.toFixed(2), self: c.self == null ? null : +c.self.toFixed(4), ...(keep && ranked[0][0] !== keep ? { kept: true, best: ranked[0][0], bestR: +ranked[0][1].r.toFixed(4) } : {}) };
  return hold({ ...base, active: act, reason, why, live: L, dm: dm.tests, combined: Object.fromEntries(Object.entries(comb).map(([m, x]) => [m, { r: +x.r.toFixed(4), w: +x.w.toFixed(2), n: x.n }])) }, (a, b) => (comb[a] && comb[b]?.r > 0 ? comb[a].r / comb[b].r : null));
}
/** Modellwahl allein aus der Selbstprüfung (Stufen: gepoolt/Profil, Wetter, lernend/Hybrid) */
function chooseModelSelf(evals, { trainDays = 0, without = [] } = {}) {
  // nur reife Tage (≥ GATES.minEvalTrainDays Trainingstage; ältere Einträge ohne Angabe zählen)
  const days = Object.keys(evals || {}).sort().filter(d => !(evals[d]?.trainDays < GATES.minEvalTrainDays)).slice(-GATES.evalWindow);
  const mean = (m, ds = days) => { const v = ds.map(d => scoreOf(evals[d]?.models?.[m])).filter(x => x != null); return v.length >= GATES.minEvalDays ? { w: sum(v) / v.length, n: v.length } : null; };
  const sc = Object.fromEntries(MODELS.map(m => [m, mean(m)]));
  const pool = sc.pooled, prof = sc.profile, wx = sc.pooledWx, P0 = (x) => `${(x * 100).toFixed(0)} %`;
  let active = trainDays >= GATES.minTrainDays ? 'pooled' : null, reason = 'zu wenige ausgewertete Tage – gepooltes Modell vorläufig';
  if (pool && prof) { active = pool.w <= prof.w ? 'pooled' : 'profile'; reason = `Mittel der letzten ${pool.n} Tage: pooled ${P0(pool.w)}, profile ${P0(prof.w)} Abweichung (Tag und Stunde je Gruppe)`; }
  if (wx && pool && wx.w <= pool.w * (1 - GATES.wxGain) && (!prof || wx.w <= prof.w)) { active = 'pooledWx'; reason = `Wetter verbessert pooled von ${P0(pool.w)} auf ${P0(wx.w)}`; }
  // Erweiterungen (lernendes Modell, Hybrid): über dieselben Tage verglichen wie das bisher gewählte, müssen es um GATES.adGain schlagen (kein
  // Überlernen); bei beiden gewinnt der größere Vorsprung
  if (active && pool && prof) {
    let best = null;
    for (const c of ['adaptive', 'hybrid', 'blend', ...SHADOW_ONLY]) {
      if (without.includes(c)) continue;
      const ds = days.filter(d => scoreOf(evals[d]?.models?.[c]) != null && scoreOf(evals[d]?.models?.[active]) != null), a = mean(c, ds), cur = mean(active, ds);
      if (a && cur && a.w <= cur.w * (1 - GATES.adGain) && (!best || a.w / cur.w < best.r)) best = { c, r: a.w / cur.w, a, cur };
    }
    if (best) { reason = `${best.c === 'hybrid' ? 'Niveau wie gestern, Tagesgang aus dem Modell' : best.c === 'blend' ? 'Mischung aus Chronos-2 und Hybrid' : best.c === 'chronos' ? 'Chronos-2 (geprüfter Vorsprung)' : 'lernt aus Fehlern je Gruppe'}: ${P0(best.a.w)} statt ${P0(best.cur.w)} (${active}) über ${best.a.n} Tage`; active = best.c; }
  }
  return { active, status: pool && prof ? 'active' : 'learning', reason, scores: Object.fromEntries(MODELS.map(m => [m, sc[m] ? +sc[m].w.toFixed(4) : null])), evalDays: days.length };
}

/** Naive Vergleichsprognose: dieselbe Gruppe und Stunde am Vortag (Zeilen des Tags dayIdx − 1); ohne Vortag oder Gruppenzeile 0 */
export function predictNaive(R, testSel, dayIdx) { return predictLag(R, testSel, dayIdx - 1); }
/** dieselbe Gruppe und Stunde am Tag lagIdx (Index in days); ohne Zeile 0 */
export function predictLag(R, testSel, lagIdx) {
  const prev = new Map(); for (let i = 0; i < R.n; i++) if (R.day[i] === lagIdx) prev.set(R.g[i] * 24 + R.hr[i], R.y[i]);
  return Float64Array.from(testSel, (i) => prev.get(R.g[i] * 24 + R.hr[i]) ?? 0);
}
export const shiftDay = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
/**
 * Vergleichswerte als Prognose (zum Veröffentlichen, wenn kein Modell sie schlägt): naive = letzte beobachtete gleiche Stunde je Gruppe vor dem Tag
 * `before` (Index in days; im Betrieb days.length, also inklusive der heute schon beobachteten Stunden), week = derselbe Wochentag eine Woche vor
 * dem Zieltag. dayOfRow(i) = Ortstag der Zukunftszeile i. Ohne Wert NaN (Aufrufer füllt mit dem Modell).
 */
export function predictBaseline(R, days, before, F, sel, kind, dayOfRow) {
  const out = new Float64Array(sel.length).fill(NaN);
  if (kind === 'naive') {
    const last = new Map(); for (let i = 0; i < R.n; i++) { if (R.day[i] >= before) continue; const k = R.g[i] * 24 + R.hr[i], c = last.get(k); if (!c || R.day[i] > c[0]) last.set(k, [R.day[i], R.y[i]]); }
    sel.forEach((i, j) => { const c = last.get(F.g[i] * 24 + F.hr[i]); if (c) out[j] = c[1]; });
  } else if (kind === 'week') {
    const idx = new Map(days.map((d, i) => [d.day, i])), want = new Map();
    sel.forEach((i, j) => { const di = idx.get(shiftDay(dayOfRow(i), -7)); if (di != null && di < before) want.set(`${di}|${F.g[i] * 24 + F.hr[i]}`, j); });
    for (let i = 0; i < R.n; i++) { const j = want.get(`${R.day[i]}|${R.g[i] * 24 + R.hr[i]}`); if (j != null) out[j] = R.y[i]; }
  }
  return out;
}
/**
 * Alle gewünschten Modelle auf denselben Zukunftszeilen (Plan, Live-Prognose, Schattenprognosen): want = Set der Modellnamen (MODELS, 'naive', 'week').
 * envFit = Umgebung für das gepoolte Modell mit Umgebung (auch Basis von adaptive/hybrid), before = Index des Zieltags für Hybrid und Vergleichswerte.
 */
export function predictAll(R, days, before, trainSel, F, sel, want, { envFit = {}, fb = null, dayOfRow = (..._a) => null, chronosOf = null, fbC = null } = {}) {
  const out = new Map(); let phiQ = 1, phiP = 1, muPn = null, muQ = null, mQ = null, mP = null;
  const profN = () => (muPn ??= predictProfile(R, trainSel, sel, F, NaN));
  const envQ = () => { if (!muQ) { const m = fitPooled(R, trainSel, envFit); mQ = m; phiQ = m.phi; muQ = predictPooled(m, F, sel); } return muQ; };
  const rows = () => sel.map(i => ({ g: F.g[i], h: F.hr[i], ags: String(R.keys[F.g[i]]).split('|')[0], cls: F.cl[i] }));
  if (want.has('pooled')) { const m = fitPooled(R, trainSel, {}); mP = m; phiP = m.phi; out.set('pooled', predictPooled(m, F, sel)); }
  if (want.has('pooledWx')) out.set('pooledWx', envQ());
  if (want.has('profile')) out.set('profile', Float64Array.from(profN(), x => (Number.isFinite(x) ? x : 0)));
  if (want.has('adaptive')) out.set('adaptive', predictAdaptive(profN(), envQ(), (j) => R.keys[F.g[sel[j]]], feedbackWeights(fb)));
  if (['hybrid', 'naive', 'week', 'blend', 'chronos'].some(m => want.has(m))) out.set('hybrid', hybridAdjust(R, days, before, rows(), blendBase(profN(), envQ())));
  // Chronos (chronosOf(i) = Wert der Zukunftszeile i oder NaN): ohne Wert gilt Hybrid; blend mit den gelernten Gewichten (ohne Lernstand: Gesamtgewicht 0,5)
  if (want.has('chronos') || want.has('blend')) {
    const hyb = out.get('hybrid'), muC = chronosOf ? Float64Array.from(sel, (i) => chronosOf(i)) : null;
    if (want.has('chronos')) out.set('chronos', muC ? Float64Array.from(muC, (c, j) => (Number.isFinite(c) ? c : hyb[j])) : Float64Array.from(hyb)); // ohne Chronos-Lauf: Hybrid
    if (want.has('blend')) out.set('blend', muC ? predictAdaptive(muC, hyb, (j) => R.keys[F.g[sel[j]]], feedbackWeights(fbC)) : Float64Array.from(hyb));
  }
  for (const k of ['naive', 'week']) if (want.has(k)) { const b = predictBaseline(R, days, before, F, sel, k, dayOfRow), fill = out.get('hybrid'); out.set(k, Float64Array.from(b, (x, j) => (Number.isFinite(x) ? x : fill[j]))); }
  // Überstreuung je Modell für das 80-%-Band: gepoolt aus seinem Fit, Profil 1, sonst aus dem Modell mit Umgebung
  return { mu: out, phi: (m) => (m === 'pooled' ? phiP : m === 'profile' ? 1 : phiQ), fitted: () => mQ || mP };
}

// ---------- Vortrainiertes Modell zum Mitnehmen (forecast/model.json) ----------
/**
 * Das gepoolte Modell als portable Datei für Dritte (z. B. ein neuer Sharing-Anbieter): Fahrtbeginne je verfügbarem Fahrzeug und Stunde
 *   λ = exp(Niveau + Stunde[h] + Tagtyp[T][h] + Art[A][h] + Wetter·(kalt, warm, Regen) + Σ Ereignisse)
 * Niveau: Anbieter × Art (gelernt, operators), sonst typisches Niveau der Art (Median, nach Fahrzeugstunden gewichtet) plus Stadtzuschlag
 * (city: mittlere Abweichung der Gruppen einer Gemeinde vom Niveau ihres Anbieters). Eigene Zählungen kalibrieren das Niveau wie im Modell
 * (Gamma-Prior, alpha). Reine Ausgabe, wirkt nicht auf die Prognose. Werte auf der Log-Skala, 4 Nachkommastellen.
 */
/**
 * A13: Standardfehler der Wirkungen (Wetter, Umgebung) geclustert nach Tagen – Zeilen eines Tags sind nicht unabhängig (gemeinsames Wetter,
 * Ereignisse). Diagonale Sandwich-Näherung je Wirkung: √(Σ_Tag (Σ (y − μ)·x)²) ÷ Σ μ·x² (übrige Parameter fest). Rückgabe { Wirkung: se } (Log-Skala).
 */
export function daySE(m, R, sel = null) {
  const act = [...(m.weather ? WX_EFF : []), ...(m.ctx || []).map(k => 3 + k)]; if (!act.length) return {};
  const sc = new Map(), info = new Float64Array(NE), rows = sel || Array.from({ length: R.n }, (_, i) => i);
  for (const i of rows) {
    const mu = R.e[i] * Math.exp(m.a[R.g[i]] + eta(m, R, i, m.weather)), r = R.y[i] - mu; let d = sc.get(R.day[i]); if (!d) sc.set(R.day[i], d = new Float64Array(NE));
    for (const e of act) { const k = WX_EFF.indexOf(e), x = k >= 0 ? R.w[k]?.[i] ?? 0 : R.c?.[e - 3]?.[i] ?? 0; if (!x) continue; d[e] += r * x; info[e] += mu * x * x; }
  }
  const out = {}; for (const e of act) { if (!(info[e] > 0)) continue; let v = 0; for (const d of sc.values()) v += d[e] ** 2; out[EFFECTS[e]] = +(Math.sqrt(v) / info[e]).toFixed(4); }
  return out;
}
export function portableModel(m, R, { family = 'micro', now = Date.now(), trainDays = null, active = null, phi = null, days = [] } = {}) {
  if (!m?.beta || !R?.nGroups) return null;
  const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : null), arr = (o) => Array.from({ length: 24 }, (_, h) => r4(m.beta[o + h]));
  // Fahrzeugstunden je Gruppe (Gewicht) und tatsächliche Fahrzeugarten je Typ-Index (E-Roller/Carsharing laufen unter „other“)
  const eG = new Float64Array(R.nGroups); for (let i = 0; i < R.n; i++) eG[R.g[i]] += R.e[i];
  const tyNames = new Map(); R.keys.forEach((k, g) => { const ti = m.gType ? m.gType[g] : typeIx(k), t = String(k).split('|')[2]; if (!tyNames.has(ti)) tyNames.set(ti, new Map()); tyNames.get(ti).set(t, (tyNames.get(ti).get(t) || 0) + eG[g]); });
  const typeName = (ti) => { const mm = tyNames.get(ti); return mm ? [...mm].sort((a, b) => b[1] - a[1])[0][0] : TYPES[ti]; };
  const wq = (pairs, q) => { const v = pairs.filter(([x, w]) => Number.isFinite(x) && w > 0).sort((a, b) => a[0] - b[0]), tot = v.reduce((s, x) => s + x[1], 0); let acc = 0; for (const [x, w] of v) { acc += w; if (acc >= q * tot) return x; } return v.length ? v[v.length - 1][0] : null; };
  const types = {};
  for (const ti of [...tyNames.keys()].sort()) {
    const gs = R.keys.map((k, g) => g).filter(g => (m.gType ? m.gType[g] : typeIx(R.keys[g])) === ti && eG[g] > 0), pairs = gs.map(g => [m.a[g], eG[g]]);
    types[typeName(ti)] = { hour: m.typeHour ? arr(I_TH + ti * 24) : new Array(24).fill(0), level: { p25: r4(wq(pairs, 0.25)), p50: r4(wq(pairs, 0.5)), p75: r4(wq(pairs, 0.75)) },
      vehicleHours: Math.round(gs.reduce((s, g) => s + eG[g], 0)), groups: gs.length, also: [...(tyNames.get(ti)?.keys() || [])].filter(t => t !== typeName(ti)) };
  }
  // Anbieter × Art (gelerntes Niveau) und Stadtzuschlag je Gemeinde (Abweichung vom eigenen Anbieter, nach Fahrzeugstunden gemittelt, geschrumpft)
  const operators = {}; if (m.aot) for (const [k, v] of m.aot) operators[k] = r4(v);
  const cityAcc = new Map();
  R.keys.forEach((k, g) => { if (!(eG[g] > 0)) return; const [ags, op, ty] = k.split('|'), base = m.aot?.get(`${op}|${ty}`); if (base == null) return; const c = cityAcc.get(ags) || [0, 0]; c[0] += eG[g] * (m.a[g] - base); c[1] += eG[g]; cityAcc.set(ags, c); });
  const city = {}; for (const [ags, [sw, w]] of cityAcc) city[ags] = r4((sw / w) * (w / (w + 200))); // < 200 Fahrzeugstunden: Richtung 0 geschrumpft
  const ctx = {}; for (const k of m.ctx || []) ctx[CTX_KEYS[k]] = r4(m.beta[I_CTX + k]);
  return {
    version: 1, kind: 'mobility-pulse/portable-model', family, trainedAt: new Date(now).toISOString(), trainDays, activeModel: active, days: days.slice(-30),
    unit: 'Fahrtbeginne je verfügbarem Fahrzeug und Stunde (Log-Skala: λ = exp(Summe))',
    formula: 'lambda = exp(level + hour[h] + dayType[T][h] + type[A].hour[h] + weather.cold*min(t-10,0)/10 + weather.warm*max(t-10,0)/10 + weather.rain*(p>=0.1) + Σ ctx[k]); erwartet = verfügbare Fahrzeuge × lambda',
    level: 'operators["Anbieter|Art"] (bekannter Anbieter) oder types[Art].level.p50 + city[Gemeindeschlüssel]; eigene Zählung: level = log((Σ gezählt + alpha·exp(level0)) ÷ (Σ erwartet bei level 0 + alpha))',
    alpha: ALPHA, phi: r4(phi ?? m.phi), band80: 'erwartet ± 1,2816·√(phi·erwartet) – nur Zählrauschen; Abweichung je Anbieter und Stunde lag live bei 15–25 %',
    hour: arr(I_HOUR), dayType: Object.fromEntries(Object.entries(CLS).map(([k, c]) => [k, c >= WE_CLS ? Array.from({ length: 24 }, (_, h) => r4(m.beta[I_CLS + c * 24 + h] + m.beta[I_WE + h])) : arr(I_CLS + c * 24)])) /* S2.5: Wochenend-Anteil eingerechnet */, dayTypes: { W: 'Werktag', F: 'Werktag in den Schulferien', S: 'Samstag', H: 'Sonn- und Feiertag' },
    types, seDay: daySE(m, R), weather: m.weather ? { cold: r4(m.beta[I_WX]), warm: r4(m.beta[I_WX + 1]), rain: r4(m.beta[I_WX + 2]), rain1: r4(m.beta[pos(NE - 3)]), rain4: r4(m.beta[pos(NE - 2)]), rainPrev: r4(m.beta[pos(NE - 1)]) } : null, ctx, ctxKeys: { warn: 'DWD-Warnung ab Stufe 2', road: 'Autobahn-Sperrung/Stau in der Gemeinde', strike: 'ÖPNV-Streik', rail: 'Bahnstreik', event: 'Veranstaltung', fest: 'Volksfest', sport: 'Heimspiel' },
    operators, city,
    license: 'Abgeleitet aus offenen GBFS-Daten der Anbieter und Verzeichnisse (Lizenzen und Namensnennung: DATA-LICENSE.md im Datenzweig von github.com/fcou1005/mobility-pulse); Weitergabe mit Namensnennung, bei CC-BY-SA-Quellen unter gleichen Bedingungen. Wetter: DWD (Bright Sky). Keine Gewähr.',
  };
}

// ---------- Eingabe: Tagesdokumente → Tage, Wetter, Zukunftszeilen ----------
export const LAND_OF_AGS = { '01': 'SH', '02': 'HH', '03': 'NI', '04': 'HB', '05': 'NW', '06': 'HE', '07': 'RP', '08': 'BW', '09': 'BY', '10': 'SL', '11': 'BE', '12': 'BB', '13': 'MV', '14': 'SN', '15': 'ST', '16': 'TH' };
/** events/<Tag>.json → Tag für buildRows: beobachtete Minuten je Stunde (ohne Lücken), Regelstand (Zeichenfolge), Tagtyp je Gemeinde aus calendar.json */
/**
 * S2.1: Fahrtbeginne und Fahrzeugminuten je Gruppe auf volle 60 Beobachtungsminuten je Uhrzeitstunde. Der Sammler läuft alle ~18 Min., eine Stunde
 * zählt 3 oder 4 Läufe (50–76 Minuten) – Ziel und Flotte sprangen mit dem Takt (Stundenfehler Deutschland 18,8 statt 13,4 % ohne Sprünge).
 * Stunden mit anteiligen Feldern (S1.1, doc.obsP ≥ 30 Min.): startP/vminP × 60 ÷ obsP; sonst start/vmin × 60 ÷ Minuten der Endstunde (obsEnd).
 * Die Rate je Fahrzeugstunde bleibt gleich (Zähler und Nenner gleich skaliert); Flotte und Ziel sind damit je volle Stunde.
 */
export function per60Groups(doc, m = E.measureDay(doc)) {
  const P = doc?.pVersion >= 1 && Array.isArray(doc.obsP), out = {};
  for (const [k, g] of Object.entries(doc?.groups || {})) {
    if (!Array.isArray(g?.start) || !Array.isArray(g?.vmin)) { out[k] = g; continue; }
    const usP = P && Array.isArray(g.startP) && Array.isArray(g.vminP), s = new Array(24), v = new Array(24);
    for (let h = 0; h < 24; h++) {
      const op = usP ? doc.obsP[h] || 0 : 0;
      if (op >= 30) { const f = 60 / op; s[h] = (g.startP[h] || 0) * f; v[h] = (g.vminP[h] || 0) * f; continue; }
      const oe = m.obsEnd?.[h] || 0, f = oe >= 30 ? 60 / oe : 1; s[h] = (g.start[h] || 0) * f; v[h] = (g.vmin[h] || 0) * f;
    }
    out[k] = { ...g, start: s, vmin: v };
  }
  return out;
}
export function dayFromDoc(doc, calendar = null) {
  const m = E.measureDay(doc), rules = m.rules.filter(Boolean), types = new Map();
  const cls = (ags) => { const land = LAND_OF_AGS[String(ags).slice(0, 2)] ?? null; let c = types.get(land); if (c === undefined) { c = classOf(E.dayType(doc.day, land, calendar)); types.set(land, c); } return c; };
  // groups: je volle Stunde (S2.1, Modell, Selbstprüfung, Live-Abgleich, Chronos); groupsRaw: gezählt (Ist-Reihen im Verlauf, wie bisher)
  return { day: doc.day, cls, rule: rules.length ? rules.join('+') : '', hourMin: m.obs, obsEnd: m.obsEnd, groups: per60Groups(doc, m), groupsRaw: doc.groups || {}, complete: doc.published?.complete !== false && m.full, full: m.full, era: 0 };
}
/** Regelstände nach Zeit ordnen: der jüngste ist Era 0 (Grundlinie, für die Prognose gilt der aktuelle Stand), ältere zählen 1, 2 … */
export function assignEras(days) {
  const order = []; for (const d of days) if (!order.includes(d.rule)) order.push(d.rule);
  for (const d of days) d.era = order.length - 1 - order.indexOf(d.rule);
  return days;
}
/** Ortszeit (Tag, Stunde) → UTC-Millisekunden */
export function localToUtcMs(day, h) {
  const base = Date.parse(`${day}T${String(h).padStart(2, '0')}:00:00Z`);
  for (const off of [2, 1]) { const t = base - off * 3600e3; if (dayOf(t) === day && hourOf(t) === h) return t; }
  return base - 3600e3;
}
/** Wetter-Cache (weather/<UTC-Tag>.json, Liste der Dokumente) → wx(ags, localDay, localHour) = [kalt, warm, Regen] | null */
export function wxLookup(docs) {
  const byDay = new Map(); for (const w of docs || []) if (w?.day && w.cells && w.ags) byDay.set(w.day, w);
  if (!byDay.size) return () => null;
  const when = new Map(); // (Ortstag, Stunde) → [UTC-Tag, UTC-Stunde]; Intl ist teuer, also einmal je Stunde
  return (ags, day, h) => {
    const key = `${day}|${h}`; let u = when.get(key);
    if (!u) { const t = localToUtcMs(day, h), iso = new Date(t).toISOString(); u = [iso.slice(0, 10), +iso.slice(11, 13)]; when.set(key, u); }
    const w = byDay.get(u[0]); if (!w) return null;
    const c = w.cells[w.ags[ags]]; if (!c) return null;
    // Vorstunde (A13): gleiche Zelle, eine UTC-Stunde früher (um Mitternacht aus der Datei des Vortags)
    let pp = null; if (u[1] > 0) pp = c.p?.[u[1] - 1] ?? null; else { const wp = byDay.get(new Date(Date.parse(`${u[0]}T00:00:00Z`) - 3600e3).toISOString().slice(0, 10)); pp = wp?.cells?.[wp.ags?.[ags]]?.p?.[23] ?? null; }
    return wxFeatures(c.t?.[u[1]] ?? null, c.p?.[u[1]] ?? null, pp);
  };
}
/** Zukunftszeilen (gleiche Gruppenindizes wie R): expo(key, h) liefert erwartete Fahrzeugstunden, fut = [{ day, h, era: 0 }] */
export function buildFuture(R, fut, expo, wx = (..._a) => null, ctx = null) {
  const cols = { y: [], e: [], g: [], hr: [], cl: [], era: [], w: Array.from({ length: NW }, () => []), hasW: [], fh: [] }, cc = CTX_KEYS.map(() => []);
  R.keys.forEach((key, gi) => {
    const ags = key.split('|')[0];
    fut.forEach((f, fi) => {
      const e = expo(key, f.h, f); if (!(e > 0)) return;
      const x = wx(ags, f.day, f.h);
      cols.y.push(0); cols.e.push(e); cols.g.push(gi); cols.hr.push(f.h); cols.cl.push(f.cls(ags)); cols.era.push(0); cols.fh.push(fi);
      for (let k = 0; k < NW; k++) cols.w[k].push(x ? x[k] ?? 0 : 0); cols.hasW.push(x ? 1 : 0);
      const c = ctx ? ctx(ags, f.day, f.h) : null; for (let k = 0; k < CTX_KEYS.length; k++) cc[k].push(c ? c[k] : 0);
    });
  });
  return { n: cols.y.length, keys: R.keys, nGroups: R.nGroups, y: Float64Array.from(cols.y), e: Float64Array.from(cols.e), g: Int32Array.from(cols.g), hr: Int8Array.from(cols.hr), cl: Int8Array.from(cols.cl),
    era: Int8Array.from(cols.era), w: cols.w.map(a => Float64Array.from(a)), hasW: Int8Array.from(cols.hasW), fh: Int16Array.from(cols.fh), c: cc.map(a => Int8Array.from(a)) };
}
