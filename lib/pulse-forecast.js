// Prognose-Engine (Fahrtbeginne je Anbieter × Gemeinde × Art und Stunde): ein Modell über ALLE Gruppen, das sich täglich selbst prüft.
//
// Idee: Jede Gruppe (Gemeinde|Anbieter|Art) liefert je Stunde Starts y und Fahrzeugstunden e (Summe der Fahrzeugminuten ÷ 60). Gepoolt gilt
//   y ~ Poisson(μ),  log μ = log e + a_g + Stunde[h] + Tagtyp×Stunde[c,h] + Regelstand[era] + Wetter(T, Regen)
// a_g ist der Gruppeneffekt (Empirical-Bayes-geschrumpft Richtung „durchschnittliche Gruppe“), alles andere wird von allen Gruppen gemeinsam
// gelernt – eine neue oder kleine Gruppe erbt damit Tagesgang, Wochentagsmuster und Wetterreaktion der anderen. Wetter und Tagtyp×Stunde
// schalten sich erst frei, wenn die Daten sie tragen (Tagtyp: ≥ 1 Tag; Wetter: Temperaturspanne und Regen-/Trockentage, GATES).
//
// Selbstprüfung (Rolling Origin, ein Tag voraus): für jeden abgeschlossenen Tag d wird mit den Tagen < d trainiert, d vorhergesagt und mit der
// Realität verglichen (WAPE, Verzerrung, Abdeckung des 80-%-Bandes). Drei Modelle laufen gegeneinander: profile (je Gruppe, ohne Pooling),
// pooled (ohne Wetter), pooledWx (mit Wetter). Aktiv ist das mit dem kleinsten mittleren Fehler der letzten Tage; das Wettermodell muss das
// gepoolte um GATES.wxGain schlagen. Solange zu wenige Tage ausgewertet sind, steht status = 'learning' und die Prognose ist vorläufig.
// Beim Backtest zählt das beobachtete Wetter des Tages (Orakel); die Prognose selbst nutzt die Wettervorhersage (Bright Sky/MOSMIX).
import * as E from './pulse-econ.js';
import { hourOf, dayOf } from './pulse-track.js';
export const FORECAST_VERSION = 1;
export const GATES = {
  minTrainDays: 2,        // weniger Tage: keine Prognose
  minEvalDays: 3,         // ausgewertete Tage, ab denen ein Modell zur Wahl steht
  hourMinObserved: 50,    // Minuten beobachtet je Stunde; darunter fehlen Fahrtbeginne und die Stunde zählt nicht
  wxTempRangeK: 5,        // Spanne der Tagesmitteltemperatur über die Trainingstage
  wxRainDays: 2,          // Tage mit Regen und Tage ohne Regen (mindestens je so viele)
  wxMissingMax: 0.3,      // Anteil Zeilen ohne Wetter, darüber bleibt das Wettermodell aus
  wxGain: 0.03,           // relative Verbesserung des Wettermodells gegenüber pooled, die zur Wahl nötig ist
  evalWindow: 7,          // Tage der Modellwahl
};
export const MODELS = ['profile', 'pooled', 'pooledWx'];
const NCLS = 4, CLS = { W: 0, F: 1, S: 2, H: 3 }, NERA = 8;
const I_HOUR = 0, I_CLS = 24, I_ERA = I_CLS + NCLS * 24, I_WX = I_ERA + NERA, P = I_WX + 3;
const LAMBDA = (j) => (j < I_CLS ? 1e-3 : j < I_ERA ? 20 : j < I_WX ? 5 : 8);
const Z80 = 1.2816, ALPHA = 4;
const sum = (a) => a.reduce((s, x) => s + x, 0);

/** Wetter-Merkmale aus Temperatur (°C) und Niederschlag (mm/h): [kalt, warm, Regen] mit Knick bei 10 °C */
export const wxFeatures = (t, p) => (t == null || p == null ? null : [Math.min(t - 10, 0) / 10, Math.max(t - 10, 0) / 10, p >= 0.1 ? 1 : 0]);

/** Tagtyp 'W' | 'F' | 'S' | 'H' → 0..3 */
export const classOf = (dt) => CLS[dt] ?? 0;

/**
 * Zeilen aufbauen. days: [{ day, cls (Funktion ags → 0..3), era (ganze Zahl ≥ 0, Regelstand-Folge), complete, hourMin[24], groups: { 'ags|op|ty': { start[24], vmin[24] } } }]
 * wx(ags, day, h) → [kalt, warm, Regen] | null. Rückgabe: Spaltenfelder für schnelle Schleifen.
 */
export function buildRows(days, wx = () => null, { hourMin = GATES.hourMinObserved } = {}) {
  const keys = [], keyIx = new Map(), cols = { y: [], e: [], g: [], hr: [], cl: [], era: [], w0: [], w1: [], w2: [], hasW: [], day: [] };
  days.forEach((d, di) => {
    for (const [k, g] of Object.entries(d.groups || {})) {
      if (!Array.isArray(g.start) || !Array.isArray(g.vmin)) continue;
      const ags = k.split('|')[0], c = d.cls(ags);
      let gi = keyIx.get(k); if (gi == null) { gi = keys.length; keyIx.set(k, gi); keys.push(k); }
      for (let h = 0; h < 24; h++) {
        if (!(d.hourMin?.[h] >= hourMin)) continue;
        const e = (g.vmin[h] || 0) / 60; if (!(e > 0)) continue;
        const f = wx(ags, d.day, h);
        cols.y.push(g.start[h] || 0); cols.e.push(e); cols.g.push(gi); cols.hr.push(h); cols.cl.push(c); cols.era.push(Math.min(d.era || 0, NERA)); cols.day.push(di);
        cols.w0.push(f ? f[0] : 0); cols.w1.push(f ? f[1] : 0); cols.w2.push(f ? f[2] : 0); cols.hasW.push(f ? 1 : 0);
      }
    }
  });
  return { n: cols.y.length, keys, nGroups: keys.length, nDays: days.length, y: Float64Array.from(cols.y), e: Float64Array.from(cols.e), g: Int32Array.from(cols.g), hr: Int8Array.from(cols.hr),
    cl: Int8Array.from(cols.cl), era: Int8Array.from(cols.era), w: [Float64Array.from(cols.w0), Float64Array.from(cols.w1), Float64Array.from(cols.w2)], hasW: Int8Array.from(cols.hasW), day: Int32Array.from(cols.day) };
}

// Cholesky-Löser für (H) x = b (H symmetrisch, positiv definit durch die Ridge-Diagonale)
function solveSpd(H, b) {
  const n = b.length, L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let s = H[i * n + j]; for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
    L[i * n + j] = i === j ? Math.sqrt(Math.max(s, 1e-12)) : s / L[j * n + j];
  }
  const z = new Float64Array(n), x = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i * n + k] * z[k]; z[i] = s / L[i * n + i]; }
  for (let i = n - 1; i >= 0; i--) { let s = z[i]; for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k]; x[i] = s / L[i * n + i]; }
  return x;
}

const eta = (m, R, i, wxOn) => m.beta[I_HOUR + R.hr[i]] + m.beta[I_CLS + R.cl[i] * 24 + R.hr[i]] + (R.era[i] > 0 ? m.beta[I_ERA + R.era[i] - 1] : 0)
  + (wxOn ? m.beta[I_WX] * R.w[0][i] + m.beta[I_WX + 1] * R.w[1][i] + m.beta[I_WX + 2] * R.w[2][i] : 0);

/** Gelernte Wetterwirkung eines Modells: Steigung je 10 K unter/über 10 °C (Log-Skala) und Faktor bei Regen */
export const wxEffects = (m) => ({ cold: m.beta[I_WX], warm: m.beta[I_WX + 1], rain: Math.exp(m.beta[I_WX + 2]) });

/** Gepooltes Poisson-Modell auf den Zeilen sel (Index-Array); weather schaltet die Wetter-Merkmale ein. */
export function fitPooled(R, sel, { weather = false, outer = 5, newton = 3 } = {}) {
  const beta = new Float64Array(P), a = new Float64Array(R.nGroups), m = { beta, a, weather, phi: 1, nRows: sel.length };
  const hy = new Float64Array(24), he = new Float64Array(24), beta0 = new Float64Array(P);
  for (const i of sel) { hy[R.hr[i]] += R.y[i]; he[R.hr[i]] += R.e[i]; }
  const tot = sum([...hy]) / Math.max(1e-9, sum([...he])), known = [];
  for (let h = 0; h < 24; h++) if (he[h] > 0) known.push(h);
  // Stundenprior: beobachtete Rate je Stunde; Stunden ohne Trainingsdaten (Nachtlücken früher Tage) erben die Rate der nächsten beobachteten
  // Nachbarn (log-linear, zirkulär) – nie 0 (= eine Fahrt je Fahrzeugstunde), sonst explodiert die Prognose dort
  const lr = (h) => Math.log(Math.max(hy[h] / he[h], tot * 0.02, 1e-6));
  for (let h = 0; h < 24; h++) {
    if (he[h] > 0) { beta0[I_HOUR + h] = lr(h); continue; }
    if (!known.length) { beta0[I_HOUR + h] = Math.log(Math.max(tot, 1e-6)); continue; }
    let dp = 1, dn = 1; while (!(he[(h - dp + 24) % 24] > 0)) dp++; while (!(he[(h + dn) % 24] > 0)) dn++;
    beta0[I_HOUR + h] = (lr((h - dp + 24) % 24) * dn + lr((h + dn) % 24) * dp) / (dp + dn);
  }
  beta.set(beta0);
  const idx = new Int32Array(8), val = new Float64Array(8);
  for (let o = 0; o < outer; o++) {
    for (let it = 0; it < newton; it++) {
      const s = new Float64Array(P), H = new Float64Array(P * P);
      for (const i of sel) {
        const mu = R.e[i] * Math.exp(a[R.g[i]] + eta(m, R, i, weather)), r = R.y[i] - mu; let nz = 0;
        idx[nz] = I_HOUR + R.hr[i]; val[nz++] = 1; idx[nz] = I_CLS + R.cl[i] * 24 + R.hr[i]; val[nz++] = 1;
        if (R.era[i] > 0) { idx[nz] = I_ERA + R.era[i] - 1; val[nz++] = 1; }
        if (weather) for (let k = 0; k < 3; k++) if (R.w[k][i] !== 0) { idx[nz] = I_WX + k; val[nz++] = R.w[k][i]; }
        for (let p = 0; p < nz; p++) { s[idx[p]] += r * val[p]; for (let q = 0; q < nz; q++) H[idx[p] * P + idx[q]] += mu * val[p] * val[q]; }
      }
      for (let j = 0; j < P; j++) { s[j] -= LAMBDA(j) * (beta[j] - beta0[j]); H[j * P + j] += LAMBDA(j); }
      const d = solveSpd(H, s);
      for (let j = 0; j < P; j++) beta[j] += Math.max(-1, Math.min(1, d[j]));
    }
    // Gruppeneffekte: Gamma(α, α)-Prior → a_g = log((Σy + α) ÷ (Σμ ohne a + α))
    const sy = new Float64Array(R.nGroups), sm = new Float64Array(R.nGroups);
    for (const i of sel) { sy[R.g[i]] += R.y[i]; sm[R.g[i]] += R.e[i] * Math.exp(eta(m, R, i, weather)); }
    for (let g = 0; g < R.nGroups; g++) a[g] = sy[g] + sm[g] > 0 ? Math.log((sy[g] + ALPHA) / (sm[g] + ALPHA)) : 0;
  }
  let chi = 0, n = 0; for (const i of sel) { const mu = R.e[i] * Math.exp(a[R.g[i]] + eta(m, R, i, weather)); if (mu >= 0.3) { chi += (R.y[i] - mu) ** 2 / mu; n++; } }
  m.phi = n > P ? Math.max(1, chi / (n - P)) : 1;
  return m;
}
export const predictPooled = (m, R, sel) => Float64Array.from(sel, (i) => R.e[i] * Math.exp(m.a[R.g[i]] + eta(m, R, i, m.weather)));

/** Profil je Gruppe ohne Pooling (Vergleichsmodell): Rate je Gruppe × Tagtyp × Stunde, sonst je Gruppe × Stunde, sonst 0 */
export function predictProfile(R, trainSel, testSel, T = R) {
  const A = new Map(), B = new Map();
  for (const i of trainSel) {
    const ka = (R.g[i] * NCLS + R.cl[i]) * 24 + R.hr[i], kb = R.g[i] * 24 + R.hr[i];
    const a = A.get(ka) || [0, 0], b = B.get(kb) || [0, 0]; a[0] += R.y[i]; a[1] += R.e[i]; b[0] += R.y[i]; b[1] += R.e[i]; A.set(ka, a); B.set(kb, b);
  }
  return Float64Array.from(testSel, (i) => { const a = A.get((T.g[i] * NCLS + T.cl[i]) * 24 + T.hr[i]) || B.get(T.g[i] * 24 + T.hr[i]); return a && a[1] > 0 ? T.e[i] * a[0] / a[1] : 0; });
}

/** Kennzahlen eines Tages: WAPE je Gruppe-Stunde und Gruppe-Tag, Verzerrung (Σ erwartet ÷ Σ real − 1), Abdeckung des 80-%-Bandes */
export function scoreDay(R, sel, mu, phi = 1) {
  let sy = 0, sabs = 0, smu = 0, inside = 0, n = 0; const gd = new Map();
  sel.forEach((i, j) => {
    const y = R.y[i], m = mu[j]; sy += y; smu += m; sabs += Math.abs(y - m); n++;
    if (Math.abs(y - m) <= Z80 * Math.sqrt(phi * m) + 0.5) inside++;
    const t = gd.get(R.g[i]) || [0, 0]; t[0] += y; t[1] += m; gd.set(R.g[i], t);
  });
  let sabsG = 0; for (const [, t] of gd) sabsG += Math.abs(t[0] - t[1]);
  const q = (x) => (x == null ? null : +x.toFixed(4));
  return { n, groups: gd.size, starts: Math.round(sy), wapeGH: sy > 0 ? q(sabs / sy) : null, wapeGD: sy > 0 ? q(sabsG / sy) : null, bias: sy > 0 ? q(smu / sy - 1) : null, cover80: n ? q(inside / n) : null };
}

/** Wetter-Freischaltung: genügend Spanne und Regen-/Trockentage in den Trainingstagen, wenig fehlende Zeilen */
export function weatherGate(R, sel) {
  const byDay = new Map(); let miss = 0;
  for (const i of sel) {
    if (!R.hasW[i]) { miss++; continue; }
    const d = byDay.get(R.day[i]) || { t: 0, n: 0, rain: 0 }; d.t += (R.w[0][i] + R.w[1][i]) * 10 + 10; d.n++; d.rain += R.w[2][i]; byDay.set(R.day[i], d);
  }
  const days = [...byDay.values()], means = days.map(d => d.t / d.n), rainy = days.filter(d => d.rain >= 3).length, dry = days.filter(d => d.rain < 1).length;
  const range = means.length ? Math.max(...means) - Math.min(...means) : 0, missShare = sel.length ? miss / sel.length : 1;
  return { ok: range >= GATES.wxTempRangeK && rainy >= GATES.wxRainDays && dry >= GATES.wxRainDays && missShare <= GATES.wxMissingMax, tempRangeK: +range.toFixed(1), rainDays: rainy, dryDays: dry, missingShare: +missShare.toFixed(3), days: byDay.size };
}

/**
 * Rolling-Origin-Auswertung der Tage evalIdx (Indizes in R.day; nur vollständige, bisher nicht ausgewertete). Rückgabe { [dayIdx]: { trainDays, models } }.
 */
export function evaluateDays(R, evalIdx, { weatherEnabled = true } = {}) {
  const out = {};
  for (const d of evalIdx) {
    const train = [], test = []; for (let i = 0; i < R.n; i++) { if (R.day[i] < d) train.push(i); else if (R.day[i] === d) test.push(i); }
    const trainDays = new Set(train.map(i => R.day[i])).size;
    if (trainDays < GATES.minTrainDays || !test.length) continue;
    const res = { trainDays, models: {} };
    res.models.profile = scoreDay(R, test, predictProfile(R, train, test));
    const m1 = fitPooled(R, train, { weather: false }); res.models.pooled = scoreDay(R, test, predictPooled(m1, R, test), m1.phi);
    const gate = weatherEnabled ? weatherGate(R, train) : { ok: false };
    if (gate.ok) { const m2 = fitPooled(R, train, { weather: true }); res.models.pooledWx = scoreDay(R, test, predictPooled(m2, R, test), m2.phi); }
    res.wxGate = gate.ok ? true : false;
    out[d] = res;
  }
  return out;
}

/** Modellwahl aus den letzten Auswertungen { 'YYYY-MM-DD': { models: { profile: {wapeGD…} … } } } */
export function chooseModel(evals, { trainDays = 0 } = {}) {
  const days = Object.keys(evals || {}).sort().slice(-GATES.evalWindow);
  const mean = (m) => { const v = days.map(d => evals[d]?.models?.[m]?.wapeGD).filter(x => x != null); return v.length >= GATES.minEvalDays ? { w: sum(v) / v.length, n: v.length } : null; };
  const sc = Object.fromEntries(MODELS.map(m => [m, mean(m)]));
  const pool = sc.pooled, prof = sc.profile, wx = sc.pooledWx;
  let active = trainDays >= GATES.minTrainDays ? 'pooled' : null, reason = 'zu wenige ausgewertete Tage – gepooltes Modell vorläufig';
  if (pool && prof) { active = pool.w <= prof.w ? 'pooled' : 'profile'; reason = `Mittel der letzten ${pool.n} Tage: pooled ${(pool.w * 100).toFixed(0)} %, profile ${(prof.w * 100).toFixed(0)} % Abweichung je Gruppe-Tag`; }
  if (wx && pool && wx.w <= pool.w * (1 - GATES.wxGain) && (!prof || wx.w <= prof.w)) { active = 'pooledWx'; reason = `Wetter verbessert pooled von ${(pool.w * 100).toFixed(0)} auf ${(wx.w * 100).toFixed(0)} %`; }
  return { active, status: pool && prof ? 'active' : 'learning', reason, scores: Object.fromEntries(MODELS.map(m => [m, sc[m] ? +sc[m].w.toFixed(4) : null])), evalDays: days.length };
}


/** Naive Vergleichsprognose: dieselbe Gruppe und Stunde am Vortag (Zeilen des Tags dayIdx − 1); ohne Vortag oder Gruppenzeile 0 */
export function predictNaive(R, testSel, dayIdx) {
  const prev = new Map(); for (let i = 0; i < R.n; i++) if (R.day[i] === dayIdx - 1) prev.set(R.g[i] * 24 + R.hr[i], R.y[i]);
  return Float64Array.from(testSel, (i) => prev.get(R.g[i] * 24 + R.hr[i]) ?? 0);
}

// ---------- Eingabe: Tagesdokumente → Tage, Wetter, Zukunftszeilen ----------
export const LAND_OF_AGS = { '01': 'SH', '02': 'HH', '03': 'NI', '04': 'HB', '05': 'NW', '06': 'HE', '07': 'RP', '08': 'BW', '09': 'BY', '10': 'SL', '11': 'BE', '12': 'BB', '13': 'MV', '14': 'SN', '15': 'ST', '16': 'TH' };
/** events/<Tag>.json → Tag für buildRows: beobachtete Minuten je Stunde (ohne Lücken), Regelstand (Zeichenfolge), Tagtyp je Gemeinde aus calendar.json */
export function dayFromDoc(doc, calendar = null) {
  const m = E.measureDay(doc), rules = m.rules.filter(Boolean), types = new Map();
  const cls = (ags) => { const land = LAND_OF_AGS[String(ags).slice(0, 2)] ?? null; let c = types.get(land); if (c === undefined) { c = classOf(E.dayType(doc.day, land, calendar)); types.set(land, c); } return c; };
  return { day: doc.day, cls, rule: rules.length ? rules.join('+') : '', hourMin: m.obs, groups: doc.groups || {}, complete: doc.published?.complete !== false && m.full, full: m.full, era: 0 };
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
    return wxFeatures(c.t?.[u[1]] ?? null, c.p?.[u[1]] ?? null);
  };
}
/** Zukunftszeilen (gleiche Gruppenindizes wie R): expo(key, h) liefert erwartete Fahrzeugstunden, fut = [{ day, h, era: 0 }] */
export function buildFuture(R, fut, expo, wx = () => null) {
  const cols = { y: [], e: [], g: [], hr: [], cl: [], era: [], w0: [], w1: [], w2: [], hasW: [], fh: [] };
  R.keys.forEach((key, gi) => {
    const ags = key.split('|')[0];
    fut.forEach((f, fi) => {
      const e = expo(key, f.h); if (!(e > 0)) return;
      const x = wx(ags, f.day, f.h);
      cols.y.push(0); cols.e.push(e); cols.g.push(gi); cols.hr.push(f.h); cols.cl.push(f.cls(ags)); cols.era.push(0); cols.fh.push(fi);
      cols.w0.push(x ? x[0] : 0); cols.w1.push(x ? x[1] : 0); cols.w2.push(x ? x[2] : 0); cols.hasW.push(x ? 1 : 0);
    });
  });
  return { n: cols.y.length, keys: R.keys, nGroups: R.nGroups, y: Float64Array.from(cols.y), e: Float64Array.from(cols.e), g: Int32Array.from(cols.g), hr: Int8Array.from(cols.hr), cl: Int8Array.from(cols.cl),
    era: Int8Array.from(cols.era), w: [Float64Array.from(cols.w0), Float64Array.from(cols.w1), Float64Array.from(cols.w2)], hasW: Int8Array.from(cols.hasW), fh: Int16Array.from(cols.fh) };
}


// ---------- Stundenreihen für das Prognose-Dashboard (forecast/series.json) ----------
// Je Gebiet (scope) und Ortstag drei Reihen zu 24 Stunden: p = Plan (Tagesprognose, mit Tagen < Tag gerechnet und beim ersten Lauf des Tags
// eingefroren), a = Ist (gezählte Fahrtbeginne, null = Stunde nicht beobachtet), l = aktuelle Prognose für die noch kommenden Stunden.
export const SERIES_KEEP_DAYS = 8;
export const SERIES_MIN = { ags: 40, group: 80, groupMax: 120 }; // Gemeinden ab 40, Gruppen ab 80 Plan-Fahrtbeginnen je Tag (höchstens 120 Gruppen)
/** Gruppenschlüssel 'ags|op|ty' → Gebietsschlüssel (Deutschland, Anbieter, Art, Gemeinde, Gruppe) */
export const scopesOfKey = (key) => { const [ags, op, ty] = key.split('|'); return ['DE', `op:${op}`, `ty:${ty}`, `ags:${ags}`, `g:${key}`]; };
const rv = (x) => (x == null || !Number.isFinite(x) ? null : x < 10 ? Math.round(x * 10) / 10 : Math.round(x));
/** Zeilen einer Vorhersage (Zukunftszeilen F, Erwartung mu) → Map Gebiet → { [Ortstag]: number[24] } */
function aggregateFuture(R, F, mu, fut) {
  const out = new Map();
  for (let i = 0; i < F.n; i++) {
    const f = fut[F.fh[i]], v = mu[i]; if (!(v > 0)) continue;
    for (const sc of scopesOfKey(R.keys[F.g[i]])) { let d = out.get(sc); if (!d) out.set(sc, d = {}); (d[f.day] || (d[f.day] = new Array(24).fill(0)))[f.h] += v; }
  }
  return out;
}
/** Ist eines Tags: Map Gebiet → number[24] mit null in Stunden ohne ausreichende Beobachtung; nur Gruppen-Stunden mit Fahrzeugminuten (wie buildRows) */
export function actualOfDay(d, { hourMin = GATES.hourMinObserved } = {}) {
  const out = new Map();
  for (const [key, g] of Object.entries(d.groups || {})) {
    if (!Array.isArray(g.start) || !Array.isArray(g.vmin)) continue;
    const scs = scopesOfKey(key);
    for (let h = 0; h < 24; h++) {
      if (!(d.hourMin?.[h] >= hourMin) || !((g.vmin[h] || 0) > 0)) continue;
      for (const sc of scs) { let a = out.get(sc); if (!a) out.set(sc, a = new Array(24).fill(null)); a[h] = (a[h] || 0) + (g.start[h] || 0); }
    }
  }
  return out;
}
/** Erwartete Fahrzeugstunden je Gruppe und Stunde: zuletzt beobachteter Wert derselben Stunde, nur Tage mit Index < beforeIdx */
function lastExposure(days, beforeIdx = days.length) {
  const last = new Map();
  for (let di = 0; di < Math.min(beforeIdx, days.length); di++) { const d = days[di];
    for (const [k, g] of Object.entries(d.groups)) { if (!Array.isArray(g.vmin)) continue; let a = last.get(k); if (!a) last.set(k, a = new Array(24).fill(0)); for (let h = 0; h < 24; h++) if (d.hourMin[h] >= GATES.hourMinObserved && (g.vmin[h] || 0) > 0) a[h] = g.vmin[h] / 60; } }
  // Stunden, die an keinem Tag beobachtet wurden (Lücken früher Tage): Mittel der beobachteten Stunden der Gruppe, sonst fehlt dort jede Prognose
  for (const a of last.values()) { const seen = a.filter(x => x > 0); if (!seen.length || seen.length === 24) continue; const m = sum(seen) / seen.length; for (let h = 0; h < 24; h++) if (!(a[h] > 0)) a[h] = m; }
  return last;
}
/**
 * Plan eines Tags (Index di in days): Modell nur mit Tagen < di, Fahrzeugstunden vom letzten beobachteten Wert vor di, Wetter des Tags.
 * Modellwahl wie im Betrieb: chooseModel über die Auswertungen der Tage < Tag. Rückgabe { model, trainDays, scopes } oder null (zu wenige Tage).
 */
export function planDay(R, days, di, day, wx, calendar, evals) {
  const trainSel = []; for (let i = 0; i < R.n; i++) if (R.day[i] < di) trainSel.push(i);
  const trainDays = new Set(trainSel.map(i => R.day[i])).size;
  if (trainDays < GATES.minTrainDays) return null;
  const prior = Object.fromEntries(Object.entries(evals || {}).filter(([d]) => d < day));
  const ch = chooseModel(prior, { trainDays }), gate = weatherGate(R, trainSel);
  const model = ch.active === 'pooledWx' && gate.ok ? 'pooledWx' : ch.active === 'profile' ? 'profile' : 'pooled';
  const rec = dayFromDoc({ day, runs: [], groups: {} }, calendar), fut = Array.from({ length: 24 }, (_, h) => ({ day, h, cls: rec.cls }));
  const last = lastExposure(days, di), F = buildFuture(R, fut, (k, h) => last.get(k)?.[h] ?? 0, wx), sel = Array.from({ length: F.n }, (_, i) => i);
  const mu = model === 'profile' ? predictProfile(R, trainSel, sel, F) : predictPooled(fitPooled(R, trainSel, { weather: model === 'pooledWx' }), F, sel);
  const scopes = new Map(); for (const [sc, d] of aggregateFuture(R, F, mu, fut)) scopes.set(sc, d[day]);
  return { day, model, trainDays, scopes };
}
/**
 * Reihen des Dashboards. plans: Map Ortstag → planDay-Ergebnis (nur neu gerechnete), live: Map Gebiet → { [Ortstag]: number[24] } (Prognose ab der nächsten
 * vollen Stunde), nowH: erste Stunde der Prognose je Ortstag { [Tag]: ab Stunde }, prev: forecast/series.json des letzten Laufs.
 */
export function buildSeries({ days, today, tomorrow, plans, live, liveFrom, prev = null, now, status, active }) {
  const keepFrom = dayOf(now - (SERIES_KEEP_DAYS - 1) * 86400e3), out = { version: 1, generatedAt: new Date(now).toISOString(), tz: 'Europe/Berlin', today, tomorrow, status, active, days: {} };
  const prevDays = prev?.version === 1 ? prev.days || {} : {}, dayBy = new Map(days.map(d => [d.day, d]));
  const dayList = [...new Set([...Object.keys(prevDays), ...plans.keys(), ...days.map(d => d.day), tomorrow])].filter(d => d >= keepFrom && d <= tomorrow).sort();
  for (const day of dayList) {
    const old = prevDays[day] || {}, plan = plans.get(day), doc = dayBy.get(day), act = doc ? actualOfDay(doc) : null, entry = {};
    // Gebiete: bereits gespeicherte bleiben (Plan eingefroren), neu geplante Tage wählen nach Größe
    let scopes;
    if (plan && !Object.values(old).some(x => x.p)) {
      scopes = new Set(['DE']); const gs = [];
      for (const [sc, arr] of plan.scopes) { const tot = sum(arr);
        if (sc.startsWith('op:') || sc.startsWith('ty:')) scopes.add(sc); else if (sc.startsWith('ags:') && tot >= SERIES_MIN.ags) scopes.add(sc); else if (sc.startsWith('g:') && tot >= SERIES_MIN.group) gs.push([sc, tot]); }
      for (const [sc] of gs.sort((a, b) => b[1] - a[1]).slice(0, SERIES_MIN.groupMax)) scopes.add(sc);
    } else scopes = new Set(Object.keys(old));
    if (day === tomorrow && !scopes.size) for (const sc of live.keys()) { const d = live.get(sc)?.[day]; if (!d) continue; const tot = sum(d);
      if (sc === 'DE' || sc.startsWith('op:') || sc.startsWith('ty:') || (sc.startsWith('ags:') && tot >= SERIES_MIN.ags) || (sc.startsWith('g:') && tot >= SERIES_MIN.group)) scopes.add(sc); }
    for (const sc of scopes) {
      const o = old[sc] || {}, e = {};
      const p = plan?.scopes.get(sc) ?? o.p ?? null; if (p) e.p = p.map(rv);
      const a = act?.get(sc) ?? (day <= today ? o.a : null); if (a) e.a = a.map(rv);
      const l = live.get(sc)?.[day]; if (l) { const from = liveFrom[day] ?? 0; e.l = l.map((x, h) => (h >= from ? rv(x) : null)); }
      if (e.p || e.a || e.l) entry[sc] = e;
    }
    if (Object.keys(entry).length) out.days[day] = entry;
  }
  return out;
}

const r1 = (x) => Math.round(x * 10) / 10;
const wape = (rows) => { let y = 0, a = 0, m = 0; for (const [yy, mm] of rows) { y += yy; a += Math.abs(yy - mm); m += mm; } return y > 0 ? { wape: a / y, bias: m / y - 1, starts: Math.round(y) } : null; };

/**
 * Prognoselauf. docs: events/<Tag>.json (beliebige Reihenfolge), calendar: calendar.json, weather: weather/<Tag>.json-Dokumente, prevLog: forecast/log.json.
 * Ergebnis { latest, log }: latest = Prognose der nächsten 24 Ortsstunden (Gruppe → Starts je Stunde, Gemeinde-Summen, Modellwahl, Gates),
 * log = Rolling-Origin-Auswertungen je Tag (evals), ausgegebene Prognosen mit Live-Abgleich (issued/live), Verlauf der Modellwahl.
 */
export function runForecast({ docs, calendar = null, weather = [], prevLog = null, prevSeries = null, now = Date.now(), horizon = 24, minGroupDay = 3, issueEveryMs = 6 * 3600e3, exclude = null }) {
  const days = assignEras((docs || []).filter(d => d?.day && d.groups).map(d => dayFromDoc(d, calendar)).sort((a, b) => (a.day < b.day ? -1 : 1)));
  // Gruppen mit rotem Befund der Ereignis-Ampel (nicht plausibel gezählt) bleiben aus Training und Prognose
  if (exclude?.size) for (const d of days) { const g = {}; for (const [k, v] of Object.entries(d.groups)) if (!exclude.has(k)) g[k] = v; d.groups = g; }
  const today = dayOf(now), wx = wxLookup(weather);
  const prev = prevLog?.version === FORECAST_VERSION ? prevLog : null;
  const log = { version: FORECAST_VERSION, evals: { ...(prev?.evals || {}) }, issued: { ...(prev?.issued || {}) }, live: { ...(prev?.live || {}) }, history: [...(prev?.history || [])] };
  const R = buildRows(days, wx);
  const trainDays = new Set(Array.from(R.day)).size;
  // Rolling Origin: jeder volle, abgeschlossene Tag, der noch nicht ausgewertet ist (ältere Tage ohne Vortraining entfallen von selbst)
  const evalIdx = days.map((d, i) => (d.complete && d.day < today ? i : -1)).filter(i => i >= 0).slice(-(GATES.evalWindow + 2)).filter(i => !log.evals[days[i].day]);
  const ev = evaluateDays(R, evalIdx);
  for (const [di, e] of Object.entries(ev)) {
    const test = []; for (let i = 0; i < R.n; i++) if (R.day[i] === +di) test.push(i);
    e.models.naive = scoreDay(R, test, predictNaive(R, test, +di));
    log.evals[days[+di].day] = { trainDays: e.trainDays, wxGate: e.wxGate, models: e.models };
  }
  for (const d of Object.keys(log.evals).sort().slice(0, -21)) delete log.evals[d];
  const choice = chooseModel(log.evals, { trainDays });
  const all = Array.from({ length: R.n }, (_, i) => i), gate = weatherGate(R, all);
  const useWx = choice.active === 'pooledWx' && gate.ok;
  const out = { version: FORECAST_VERSION, generatedAt: new Date(now).toISOString(), status: trainDays < GATES.minTrainDays ? 'insufficient' : choice.status, active: trainDays < GATES.minTrainDays ? null : (choice.active === 'pooledWx' && !useWx ? 'pooled' : choice.active), reason: choice.reason, scores: choice.scores, evalDays: choice.evalDays, trainDays,
    excluded: exclude?.size || 0, gates: { ...GATES }, weather: { gate, used: useWx, source: weather.length ? weather[0].source ?? null : null }, horizon: null, totals: null, groups: {}, municipalities: {} };
  const tomorrow = dayOf(localToUtcMs(today, 12) + 24 * 3600e3);
  let live = new Map(); const liveFrom = {};
  if (out.active) {
    // Horizont: ab der nächsten vollen Stunde mindestens 24 Ortsstunden, danach bis zum Ende von morgen (Dashboard); die Felder von latest.json
    // (totals, groups, municipalities, horizon) behalten ihre 24 Stunden
    const t0 = (Math.floor(now / 3600e3) + 1) * 3600e3, fut = [];
    const clsCache = new Map();
    for (let k = 0; k < 60; k++) {
      const t = t0 + k * 3600e3, day = dayOf(t); if (k >= horizon && day > tomorrow) break;
      const rec = clsCache.get(day) ?? (clsCache.set(day, dayFromDoc({ day, runs: [], groups: {} }, calendar)), clsCache.get(day)); fut.push({ day, h: hourOf(t), cls: rec.cls, t });
    }
    const HL = fut.length; for (const f of fut) if (liveFrom[f.day] == null) liveFrom[f.day] = f.h;
    // erwartete Fahrzeugstunden: zuletzt beobachteter Wert derselben Stunde je Gruppe
    const last = lastExposure(days), expo = (k, h) => last.get(k)?.[h] ?? 0;
    const F = buildFuture(R, fut, expo, wx), sel = Array.from({ length: F.n }, (_, i) => i);
    let mu, phi = 1;
    if (out.active === 'profile') mu = predictProfile(R, all, sel, F);
    else { const m = fitPooled(R, all, { weather: useWx }); phi = m.phi; mu = predictPooled(m, F, sel); }
    out.phi = +phi.toFixed(2);
    live = aggregateFuture(R, F, mu, fut);
    const total = new Array(HL).fill(0), byGroup = new Map(), byMuni = new Map(), byOp = new Map();
    sel.forEach((i, j) => {
      const key = R.keys[F.g[i]], fi = F.fh[i], v = mu[j]; total[fi] += v;
      let a = byGroup.get(key); if (!a) byGroup.set(key, a = new Array(HL).fill(0)); a[fi] += v;
      const ags = key.split('|')[0], op = key.split('|')[1]; let b = byMuni.get(ags); if (!b) byMuni.set(ags, b = new Array(HL).fill(0)); b[fi] += v;
      let c = byOp.get(op); if (!c) byOp.set(op, c = new Array(HL).fill(0)); c[fi] += v;
    });
    out.horizon = { from: t0, hours: horizon, local: fut.slice(0, horizon).map(f => [f.day, f.h]), hoursLong: HL, tomorrow };
    out.totals = total.slice(0, horizon).map(r1);
    for (const [k, a0] of byGroup) { const a = a0.slice(0, horizon); if (a.reduce((x, y) => x + y, 0) >= minGroupDay) { const fleet = sum(Array.from({ length: 24 }, (_, h) => last.get(k)?.[h] || 0)) / 24, st = a.reduce((x, y) => x + y, 0); out.groups[k] = { start: a.map(r1), fleet: r1(fleet), perVeh: fleet >= 1 ? +(st / fleet).toFixed(2) : null }; } }
    for (const [k, a] of byMuni) out.municipalities[k] = a.slice(0, horizon).map(r1);
    // Live-Abgleich: ausgegebene Prognose festhalten (höchstens alle issueEveryMs), später gegen die Realität prüfen
    const lastIssued = Math.max(0, ...Object.keys(log.issued).map(Number));
    if (now - lastIssued >= issueEveryMs) log.issued[now] = { model: out.active, from: t0, local: out.horizon.local, total: out.totals, byOp: Object.fromEntries([...byOp].map(([k, a]) => [k, a.slice(0, horizon).map(x => Math.round(x))])) };
    log.history.push({ at: out.generatedAt, active: out.active, status: out.status, reason: out.reason });
  } else log.history.push({ at: out.generatedAt, active: null, status: out.status, reason: `${trainDays} Tage Daten – zu wenig` });
  log.history = log.history.slice(-60);
  // Abgleich ausgegebener Prognosen: alle 24 Stunden beobachtet (Minuten ≥ Schwelle) → bewerten und die große Kopie verwerfen
  const dayBy = new Map(days.map(d => [d.day, d]));
  for (const [at, rec] of Object.entries(log.issued)) {
    const rows = [], rowsNaive = [], rowsTot = []; let ok = true;
    const actualOp = (day, h) => { const d = dayBy.get(day); if (!d || !(d.hourMin[h] >= GATES.hourMinObserved)) return null; const m = new Map(); for (const [k, g] of Object.entries(d.groups)) { const op = k.split('|')[1]; m.set(op, (m.get(op) || 0) + (g.start?.[h] || 0)); } return m; };
    for (let i = 0; i < rec.local.length && ok; i++) {
      const [day, h] = rec.local[i], a = actualOp(day, h); if (!a) { ok = false; break; }
      const pd = dayOf(localToUtcMs(day, h) - 24 * 3600e3), pa = actualOp(pd, h);
      let tot = 0, totM = 0; for (const [op, arr] of Object.entries(rec.byOp)) { const y = a.get(op) || 0; rows.push([y, arr[i]]); if (pa) rowsNaive.push([y, pa.get(op) || 0]); tot += y; totM += arr[i]; }
      rowsTot.push([tot, totM]);
    }
    if (ok) { const s = wape(rows), n = rowsNaive.length ? wape(rowsNaive) : null, t = wape(rowsTot); log.live[at] = { model: rec.model, from: rec.from, wapeOpH: s && +s.wape.toFixed(4), bias: s && +s.bias.toFixed(4), wapeTotalH: t && +t.wape.toFixed(4), naiveOpH: n && +n.wape.toFixed(4), skill: s && n && n.wape > 0 ? +(1 - s.wape / n.wape).toFixed(3) : null, starts: s?.starts ?? 0 }; delete log.issued[at]; }
    else if (+at < now - 4 * 86400e3) delete log.issued[at];
  }
  for (const k of Object.keys(log.live).sort().slice(0, -60)) delete log.live[k];
  out.live = Object.entries(log.live).sort((a, b) => a[0] - b[0]).slice(-12).map(([at, v]) => ({ at: +at, ...v }));
  // Stundenreihen für das Dashboard: Plan heute (und für noch nicht gespeicherte, abgeschlossene Tage), Ist, Live-Prognose bis Ende morgen
  const plans = new Map(), has = (d) => Object.values(prevSeries?.version === 1 ? prevSeries.days?.[d] || {} : {}).some(x => x.p), keepFrom = dayOf(now - (SERIES_KEEP_DAYS - 1) * 86400e3);
  if (trainDays >= GATES.minTrainDays) {
    days.forEach((d, pi) => { if (d.day >= keepFrom && d.day < today && d.complete && !has(d.day)) { const r = planDay(R, days, pi, d.day, wx, calendar, log.evals); if (r) plans.set(d.day, r); } });
    if (!has(today)) { const ti = days.findIndex(d => d.day === today), r = planDay(R, days, ti >= 0 ? ti : days.filter(d => d.day < today).length, today, wx, calendar, log.evals); if (r) plans.set(today, r); }
  }
  const series = buildSeries({ days, today, tomorrow, plans, live, liveFrom, prev: prevSeries, now, status: out.status, active: out.active });
  return { latest: out, log, series };
}
