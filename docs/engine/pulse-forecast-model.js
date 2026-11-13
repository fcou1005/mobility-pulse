// @ts-check
// Mobility Pulse — Prognose – Grundmodell, Lernen aus Fehlern, Spitzen, Langzeitgedächtnis (aus pulse-forecast.js geschnitten; pulse-forecast.js bleibt die Fassade für alle Importe).
import { dayOf } from './pulse-track.js';
import { CTX_KEYS } from './pulse-context.js';
import { familyOf } from './pulse-core.js';
import { BIAS } from './pulse-forecast-select.js';

export const dayOfLocal = (ms) => dayOf(ms);
export const FAMILY_DIR = Object.freeze({ micro: 'forecast', moped: 'forecast/moped', car: 'forecast/car' });
/** Tagesdokumente (events/<Tag>.json) auf die Gruppen einer Familie beschränken (Schlüssel Gemeinde|Anbieter|Art); übrige Felder bleiben */
export const familyDocs = (docs, fam) => (docs || []).map(d => (d?.groups ? { ...d, groups: Object.fromEntries(Object.entries(d.groups).filter(([k]) => familyOf(String(k).split('|')[2]) === fam)) } : d));
/** Hat die Familie in den Tagesdokumenten mindestens eine Gruppe mit Fahrzeugminuten? */
export const familyHasData = (docs) => (docs || []).some(d => Object.values(d?.groups || {}).some(g => Array.isArray(g?.vmin) && g.vmin.some(x => x > 0)));
export const FORECAST_VERSION = 1;
// Fassung der Selbstprüfung: 2 = Prüfzeilen mit der Exposition der Vortage (lastExposure) wie Plan und Live-Prognose; bis 6.11.2026 rechnete
// die Prüfung mit den tatsächlichen Fahrzeugstunden des Prüftags (Vorwissen) und lag zu günstig. 3 = Hybrid. 4 = Wetter der Tage vor dem 3.11.
// nachgeholt, Umgebungsmerkmale und Langzeitgedächtnis im Modell mit Umgebung. 5 = Art × Stunde, Anbieter-Prior, jüngere Tage zählen mehr (POOLED).
// 6 = Spitzen je Modell und Vergleich „gleicher Wochentag der Vorwoche“. 7 = Chronos-2 (Vortagsprognosen) und blend mit Lernstand log.feedbackC.
// Andere Fassung im Log → evals und Lernstand neu.
export const EVAL_VERSION = 7;
export const GATES = {
  minTrainDays: 2,        // weniger Tage: keine Prognose
  minEvalDays: 3,         // ausgewertete Tage, ab denen ein Modell zur Wahl steht
  hourMinObserved: 50,    // Minuten beobachtet je Stunde; darunter fehlen Fahrtbeginne und die Stunde zählt nicht
  wxTempRangeK: 5,        // Spanne der Tagesmitteltemperatur über die Trainingstage
  wxRainDays: 2,          // Tage mit Regen und Tage ohne Regen (mindestens je so viele)
  wxMissingMax: 0.3,      // Anteil Zeilen ohne Wetter, darüber bleibt das Wettermodell aus
  wxGain: 0.03,           // relative Verbesserung des Wettermodells gegenüber pooled, die zur Wahl nötig ist
  adGain: 0.02,           // relative Verbesserung, die das lernende Modell (Fehler-Rückkopplung je Gruppe) gegenüber dem gewählten braucht
  minEvalTrainDays: 3,    // geprüfte Tage zählen in der Modellwahl erst ab so vielen Trainingstagen (unreife Starttage nicht)
  liveMinHours: 16,       // Live-Abgleich: bewertet, sobald so viele der 24 Stunden beobachtet sind (fehlende Stunden zählen nicht)
  wxShareDay: 0.1,        // Wetter-Gate: Regen- bzw. Trockentag = an diesem Tag in mindestens 10 % der Gemeinde-Tage Regen bzw. kein Regen
  evalWindow: 7,          // Tage der Modellwahl
  ctxMinRows: 100,        // Umgebungsmerkmal (Warnung, Autobahn, Streik, Veranstaltung) ins Modell erst ab so vielen Gemeinde-Stunden mit Ereignis (Fenster + Gedächtnis)
  ctxMinDays: 2,          // … und an mindestens so vielen verschiedenen Tagen
};
export const MODELS = ['profile', 'pooled', 'pooledWx', 'adaptive', 'hybrid', 'blend'];
// Chronos-2 (lib/pulse-chronos.js, seit 7.11.2026): „chronos“ läuft nur als Vergleich mit (nie wählbar). „blend“ mischt je Gruppe Chronos und das
// Hybrid-Modell: Gewicht nach den bisherigen Fehlern beider (wie adaptive: Bates–Granger, geschrumpft Richtung Gesamtgewicht, Halbwertszeit
// FEEDBACK.halfLifeDays), gelernt aus den Vortagsprognosen von Chronos in der Selbstprüfung (log.feedbackC). Ohne Chronos-Wert gilt Hybrid.
// Wählbar wie jede Erweiterung (GATES.adGain bzw. Live-Regel), seit 13.11.2026 (S2.3) erst nach geprüftem Vorsprung (DM-Test über ≥ 14 Tage, siehe DM);
// BLEND.activeFrom bleibt als Angabe im Dashboard. Chronos selbst ist unter derselben Bedingung wählbar.
export const SHADOW_ONLY = ['chronos'];
export const BLEND = { activeFrom: Date.parse('2026-11-28T10:00:00+01:00') };
/** Wertung eines Modells an einem Tag: Mittel aus Abweichung je Gruppe und Tag (Niveau) und je Gruppe und Stunde (Tagesgang); ohne Stundenwert nur der Tageswert */
export const scoreOf = (x) => (x?.wapeGD == null ? null : x.wapeGH == null ? x.wapeGD : (x.wapeGD + x.wapeGH) / 2);
export const NCLS = 4, CLS = { W: 0, F: 1, S: 2, H: 3 }, NERA = 8;
// Fahrzeugarten für Art × Stunde (Option typeHour); unbekannte → other
export const TYPES = ['scooter', 'bike', 'ebike', 'cargo', 'other'];
export const NTY = TYPES.length, typeIx = (key) => { const t = TYPES.indexOf(String(key).split('|')[2]); return t < 0 ? NTY - 1 : t; };
// S2.5: Wochenende × Stunde (I_WE) teilen sich Samstag und Sonn-/Feiertag; der eigene Tagtyp-Anteil weicht davon nur ab. Fehlen einem der beiden
// Stunden im Training (31.10./01.11.2026: Sonntag/Allerheiligen erst ab 9 Uhr gezählt), gilt für ihn das Wochenende statt des Werktags (08.11. 8 Uhr
// sonst 4,9 × zu hoch). Kleiner Ridge (2) für den gemeinsamen Teil, 20 für die Tagtyp-Abweichung: der gemeinsame Teil trägt den Großteil.
// A13: weitere Wettermerkmale hinten angehängt (Parameter ab I_WX2, Wirkungen hinter den Umgebungsmerkmalen – das Gedächtnis wächst nur hinten):
// Regen ≥ 1 mm/h und ≥ 4 mm/h (mit „Regen ≥ 0,1 mm/h“ drei Stufen: leicht, mäßig, stark) und Regen in der Vorstunde.
export const NCTX = CTX_KEYS.length, I_HOUR = 0, I_CLS = 24, I_ERA = I_CLS + NCLS * 24, I_WX = I_ERA + NERA, I_CTX = I_WX + 3, I_TH = I_CTX + NCTX, I_WE = I_TH + NTY * 24, I_WX2 = I_WE + 24, P = I_WX2 + 3;
export const WE_CLS = 2; // Tagtypen ab hier (S = 2, H = 3) sind Wochenende
/** Wirkungen mit Langzeitgedächtnis: Wetter (kalt, warm, Regen) und Umgebungsmerkmale, Reihenfolge wie im Parametervektor ab I_WX */
export const EFFECTS = ['cold', 'warm', 'rain', ...CTX_KEYS, 'rain1', 'rain4', 'rainPrev'];
export const NE = EFFECTS.length, NW = 6;
export const WX_EFF = [0, 1, 2, NE - 3, NE - 2, NE - 1]; // Wirkung je Wettermerkmal R.w[0..5]
export const pos = (e) => (e < 3 + NCTX ? I_WX + e : I_WX2 + (e - 3 - NCTX)); // Stelle einer Wirkung im Parametervektor
const LAMBDA = (j) => (j < I_CLS ? 1e-3 : j < I_ERA ? 20 : j < I_WX ? 5 : j < I_TH ? 8 : j < I_WE ? 20 : j < I_WX2 ? 2 : 8);
export const Z80 = 1.2816, ALPHA = 4;
// S2.7 (A12): adaptives konformes 80-%-Band je Tageszeit-Band (Gibbs & Candès 2021, ACI auf den Skalenfaktor): Band = k_b · Z80 · √(φ·μ) + 0,5;
// nach jeder bewerteten Live-Prognose k_b ← k_b · exp(γ · (Fehlquote_b − 0,2)), begrenzt auf [0,5; 4]. Ziel: Trefferquote 75–85 % (vorher 67,5 %).
// Dazu Pinball-Verlust der 10-%- und 90-%-Grenze (je Fahrtbeginn) im Live-Abgleich.
export const CONFORMAL = { v: 1, gamma: 0.3, target: 0.8, kMin: 0.5, kMax: 4, bands: [[0, 6], [6, 9], [9, 12], [12, 15], [15, 19], [19, 24]] };
export const bandIx = (h) => CONFORMAL.bands.findIndex(([a, b]) => h >= a && h < b);
export const emptyConformal = () => ({ v: CONFORMAL.v, k: CONFORMAL.bands.map(() => 1), n: CONFORMAL.bands.map(() => 0) });
/** Grenzen des Bands für Prognose f (Starts) mit Skalenfaktor k */
export const bandOf80 = (f, phi = 1, k = 1) => { const w = k * Z80 * Math.sqrt(phi * Math.max(f, 0)) + 0.5; return [Math.max(0, f - w), f + w]; };
/** k je Band nachführen: miss[b] = [Fehler, Zahl] einer Live-Prognose */
export function conformalUpdate(cf, miss) {
  const c = cf?.v === CONFORMAL.v ? { k: [...cf.k], n: [...cf.n], v: cf.v } : emptyConformal();
  miss.forEach(([m, n], b) => { if (!n) return; c.k[b] = Math.min(CONFORMAL.kMax, Math.max(CONFORMAL.kMin, c.k[b] * Math.exp(CONFORMAL.gamma * (m / n - (1 - CONFORMAL.target))))); c.n[b] += 1; });
  c.k = c.k.map(x => +x.toFixed(4)); return c;
}
export const pinball = (q, y, yq) => (y >= yq ? q * (y - yq) : (1 - q) * (yq - y));
// S2.7: Ist Chronos oder die Mischung aktiv, kommt die Breite des Bands aus den Chronos-Quantilen (10/90 %) statt aus √(φ·μ): je Anbieter und Stunde
// Wurzel aus der Quadratsumme der Gruppenbreiten (Gruppen unabhängig), skaliert mit demselben konformen k. Ohne Quantile: Poisson-Band.
export const QBAND_MODELS = ['chronos', 'blend'];
export const bandOfQ = (f, w, k = 1) => [Math.max(0, f - k * w[0]), f + k * w[1]];
export function quantileBands(keys, rows, quant, horizon) {
  const acc = new Map();
  for (const [g, fi, t] of rows) { if (fi >= horizon) continue; const q = quant(keys[g], t); if (!q) continue; const op = String(keys[g]).split('|')[1];
    let a = acc.get(op); if (!a) acc.set(op, a = Array.from({ length: horizon }, () => [0, 0])); a[fi][0] += q[0] * q[0]; a[fi][1] += q[1] * q[1]; }
  return acc.size ? Object.fromEntries([...acc].map(([op, a]) => [op, a.map(([l, h]) => [+Math.sqrt(l).toFixed(1), +Math.sqrt(h).toFixed(1)])])) : null;
}
export const sum = (a) => a.reduce((s, x) => s + x, 0);

/** Wetter-Merkmale aus Temperatur (°C), Niederschlag (mm/h) und Niederschlag der Vorstunde: [kalt, warm, Regen ≥ 0,1, ≥ 1, ≥ 4, Vorstunde ≥ 0,1]
 *  mit Knick bei 10 °C (A13: drei Regenstufen und Vorstunde; ohne Vorstundenwert 0) */
export const wxFeatures = (t, p, pPrev = null) => (t == null || p == null ? null : [Math.min(t - 10, 0) / 10, Math.max(t - 10, 0) / 10, p >= 0.1 ? 1 : 0, p >= 1 ? 1 : 0, p >= 4 ? 1 : 0, pPrev != null && pPrev >= 0.1 ? 1 : 0]);

/** Tagtyp 'W' | 'F' | 'S' | 'H' → 0..3 */
export const classOf = (dt) => CLS[dt] ?? 0;

/**
 * Zeilen aufbauen. days: [{ day, cls (Funktion ags → 0..3), era (ganze Zahl ≥ 0, Regelstand-Folge), complete, hourMin[24], groups: { 'ags|op|ty': { start[24], vmin[24] } } }]
 * wx(ags, day, h) → [kalt, warm, Regen] | null. Rückgabe: Spaltenfelder für schnelle Schleifen.
 */
export function buildRows(days, wx = (..._a) => null, { hourMin = GATES.hourMinObserved, ctx = null } = {}) {
  const keys = [], keyIx = new Map(), cols = { y: [], e: [], g: [], hr: [], cl: [], era: [], w: Array.from({ length: NW }, () => []), hasW: [], day: [] }, cc = CTX_KEYS.map(() => []);
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
        for (let k = 0; k < NW; k++) cols.w[k].push(f ? f[k] ?? 0 : 0); cols.hasW.push(f ? 1 : 0);
        const x = ctx ? ctx(ags, d.day, h) : null; for (let k = 0; k < NCTX; k++) cc[k].push(x ? x[k] : 0);
      }
    }
  });
  return { n: cols.y.length, keys, nGroups: keys.length, nDays: days.length, y: Float64Array.from(cols.y), e: Float64Array.from(cols.e), g: Int32Array.from(cols.g), hr: Int8Array.from(cols.hr),
    cl: Int8Array.from(cols.cl), era: Int8Array.from(cols.era), w: cols.w.map(a => Float64Array.from(a)), hasW: Int8Array.from(cols.hasW), day: Int32Array.from(cols.day), c: cc.map(a => Int8Array.from(a)) };
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

const ctxPart = (m, R, i) => { let s = 0; if (m.ctx?.length && R.c) for (const k of m.ctx) if (R.c[k][i]) s += m.beta[I_CTX + k]; return s; };
export const eta = (m, R, i, wxOn) => m.beta[I_HOUR + R.hr[i]] + m.beta[I_CLS + R.cl[i] * 24 + R.hr[i]] + (R.cl[i] >= WE_CLS ? m.beta[I_WE + R.hr[i]] : 0) + (R.era[i] > 0 ? m.beta[I_ERA + R.era[i] - 1] : 0) + (m.typeHour ? m.beta[I_TH + m.gType[R.g[i]] * 24 + R.hr[i]] : 0)
  + (wxOn ? wxPart(m, R, i) : 0) + ctxPart(m, R, i);
const wxPart = (m, R, i) => { let s = 0; for (let k = 0; k < R.w.length && k < NW; k++) if (R.w[k][i]) s += m.beta[pos(WX_EFF[k])] * R.w[k][i]; return s; };

/** Gelernte Wetterwirkung eines Modells: Steigung je 10 K unter/über 10 °C (Log-Skala) und Faktor bei Regen */
export const wxEffects = (m) => ({ cold: m.beta[I_WX], warm: m.beta[I_WX + 1], rain: Math.exp(m.beta[I_WX + 2]), rain1: Math.exp(m.beta[pos(NE - 3)]), rain4: Math.exp(m.beta[pos(NE - 2)]), rainPrev: Math.exp(m.beta[pos(NE - 1)]) });
/** Wirkung eines Umgebungsmerkmals als Faktor (1 = keine) */
export const ctxEffect = (m, key) => Math.exp(m.beta[I_CTX + CTX_KEYS.indexOf(key)]);

/**
 * Gepooltes Poisson-Modell auf den Zeilen sel (Index-Array); weather schaltet die Wetter-Merkmale ein, ctx = Indizes der Umgebungsmerkmale (CTX_KEYS).
 * prior = Langzeitgedächtnis { b, P } über EFFECTS (Mittel und Präzision aus Tagen außerhalb des Fensters): ersetzt für die eingeschalteten Wirkungen
 * die Schrumpfung Richtung 0 durch eine Schrumpfung Richtung des bisher Gelernten.
 */
export function fitPooled(R, sel, { weather = false, ctx = [], prior = null, outer = 5, newton = 3, typeHour = POOLED.typeHour, hier = POOLED.hier, halfLife = POOLED.halfLife } = {}) {
  const beta = new Float64Array(P), a = new Float64Array(R.nGroups), m = { beta, a, weather, ctx: R.c ? [...ctx] : [], phi: 1, nRows: sel.length, typeHour, hier, gType: Int8Array.from(R.keys, typeIx) };
  // Aktualitätsgewicht je Zeile (Option halfLife in Tagen, jüngster Trainingstag = 1)
  let dMax = -Infinity; if (halfLife) for (const i of sel) if (R.day[i] > dMax) dMax = R.day[i];
  const wOf = halfLife ? (i) => 2 ** (-(dMax - R.day[i]) / halfLife) : () => 1;
  const act = [...(weather ? WX_EFF : []), ...m.ctx.map(k => 3 + k)]; // eingeschaltete Wirkungen (Index in EFFECTS)
  const hy = new Float64Array(24), he = new Float64Array(24), beta0 = new Float64Array(P);
  for (const i of sel) { const w = wOf(i); hy[R.hr[i]] += w * R.y[i]; he[R.hr[i]] += w * R.e[i]; }
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
  if (prior) for (const e of act) beta[pos(e)] = prior.b[e] ?? 0;
  const idx = new Int32Array(16), val = new Float64Array(16);
  for (let o = 0; o < outer; o++) {
    for (let it = 0; it < newton; it++) {
      const s = new Float64Array(P), H = new Float64Array(P * P);
      for (const i of sel) {
        const w = wOf(i), mu = R.e[i] * Math.exp(a[R.g[i]] + eta(m, R, i, weather)), r = w * (R.y[i] - mu), wmu = w * mu; let nz = 0;
        idx[nz] = I_HOUR + R.hr[i]; val[nz++] = 1; idx[nz] = I_CLS + R.cl[i] * 24 + R.hr[i]; val[nz++] = 1;
        if (R.cl[i] >= WE_CLS) { idx[nz] = I_WE + R.hr[i]; val[nz++] = 1; }
        if (typeHour) { idx[nz] = I_TH + m.gType[R.g[i]] * 24 + R.hr[i]; val[nz++] = 1; }
        if (R.era[i] > 0) { idx[nz] = I_ERA + R.era[i] - 1; val[nz++] = 1; }
        if (weather) for (let k = 0; k < NW && k < R.w.length; k++) if (R.w[k][i] !== 0) { idx[nz] = pos(WX_EFF[k]); val[nz++] = R.w[k][i]; }
        for (const k of m.ctx) if (R.c[k][i]) { idx[nz] = I_CTX + k; val[nz++] = 1; }
        for (let p = 0; p < nz; p++) { s[idx[p]] += r * val[p]; for (let q = 0; q < nz; q++) H[idx[p] * P + idx[q]] += wmu * val[p] * val[q]; }
      }
      for (let j = 0; j < P; j++) { s[j] -= LAMBDA(j) * (beta[j] - beta0[j]); H[j * P + j] += LAMBDA(j); }
      if (prior) for (const e of act) for (const f of act) { const pv = prior.P[e * NE + f]; if (!pv) continue; s[pos(e)] -= pv * (beta[pos(f)] - (prior.b[f] ?? 0)); H[pos(e) * P + pos(f)] += pv; }
      const d = solveSpd(H, s);
      for (let j = 0; j < P; j++) beta[j] += Math.max(-1, Math.min(1, d[j]));
    }
    // Gruppeneffekte: Gamma(α, α)-Prior → a_g = log((Σy + α) ÷ (Σμ ohne a + α)); Option hier: Prior-Mittel = Niveau desselben Anbieters und
    // derselben Art über alle Gemeinden (a_g = log((Σy + α·e^{a_ot}) ÷ (Σμ + α))) – eine neue oder kleine Gruppe startet beim Anbieter, nicht beim Durchschnitt
    const sy = new Float64Array(R.nGroups), sm = new Float64Array(R.nGroups);
    for (const i of sel) { const w = wOf(i); sy[R.g[i]] += w * R.y[i]; sm[R.g[i]] += w * R.e[i] * Math.exp(eta(m, R, i, weather)); }
    let aot = null;
    if (hier) { const oy = new Map(), om = new Map(); for (let g = 0; g < R.nGroups; g++) { const k = R.keys[g].split('|').slice(1).join('|'); oy.set(k, (oy.get(k) || 0) + sy[g]); om.set(k, (om.get(k) || 0) + sm[g]); }
      aot = new Map([...oy].map(([k, y]) => [k, Math.log((y + ALPHA) / ((om.get(k) || 0) + ALPHA))])); m.aot = aot; }
    for (let g = 0; g < R.nGroups; g++) { const pm = aot ? Math.exp(aot.get(R.keys[g].split('|').slice(1).join('|')) ?? 0) : 1; a[g] = sy[g] + sm[g] > 0 ? Math.log((sy[g] + ALPHA * pm) / (sm[g] + ALPHA)) : (aot ? Math.log(pm) : 0); }
  }
  let chi = 0, n = 0; for (const i of sel) { const mu = R.e[i] * Math.exp(a[R.g[i]] + eta(m, R, i, weather)); if (mu >= 0.3) { chi += (R.y[i] - mu) ** 2 / mu; n++; } }
  m.phi = n > P ? Math.max(1, chi / (n - P)) : 1;
  return m;
}
// Gepooltes Modell und Profil (seit 6.11.2026 abends, EVAL_VERSION 5), geprüft an den echten Tagen 3.–5.11.2026 (ehrliche Selbstprüfung):
//   typeHour – eigener Tagesgang je Fahrzeugart (E-Scooter, Rad, E-Rad, Lastenrad) statt einem für alle,
//   hier     – Gruppeneffekt schrumpft Richtung Anbieter × Art über alle Gemeinden statt Richtung Durchschnittsgruppe (neue Städte bekannter Anbieter),
//   halfLife – jüngere Tage zählen mehr (Halbwertszeit in Tagen), damit ein Saisonabfall nicht vom Fenstermittel verdeckt wird.
// Wertung gepoolt 19,3 → 18,8 %, Profil 17,1 → 17,0 %, Hybrid 16,2 → 16,1 %; an keinem der drei Tage schlechter. Halbwertszeit 3 Tage war auf den
// kurzen Fenstern noch etwas besser (gepoolt 18,6 %), nimmt bei 21 Tagen aber Wochenenden zu viel Gewicht (letzter Samstag zählte ein Fünftel).
// Nowcast (Rest des Tages aus den heute schon gezählten Stunden nachskalieren) wurde geprüft und verworfen: je Gruppe, Gemeinde, Anbieter oder
// bundesweit schlechter um 8 und 16 Uhr (z. B. je Anbieter und Stunde 14,9 → 17,5–19,5 % um 8 Uhr), um 12 Uhr gleichauf. Die Live-Prognose
// lernt die heutigen Stunden ohnehin mit (sie sind Teil des Trainings).
export const POOLED = { typeHour: true, hier: true, halfLife: 7 };
export const predictPooled = (m, R, sel) => Float64Array.from(sel, (i) => R.e[i] * Math.exp(m.a[R.g[i]] + eta(m, R, i, m.weather)));

/** Profil je Gruppe ohne Pooling (Vergleichsmodell): Rate je Gruppe × Tagtyp × Stunde, sonst je Gruppe × Stunde, sonst missing (Standard 0) */
export function predictProfile(R, trainSel, testSel, T = R, missing = 0, { halfLife = POOLED.halfLife } = {}) {
  const A = new Map(), B = new Map();
  let dMax = -Infinity; if (halfLife) for (const i of trainSel) if (R.day[i] > dMax) dMax = R.day[i];
  for (const i of trainSel) {
    const ka = (R.g[i] * NCLS + R.cl[i]) * 24 + R.hr[i], kb = R.g[i] * 24 + R.hr[i], w = halfLife ? 2 ** (-(dMax - R.day[i]) / halfLife) : 1;
    const a = A.get(ka) || [0, 0], b = B.get(kb) || [0, 0]; a[0] += w * R.y[i]; a[1] += w * R.e[i]; b[0] += w * R.y[i]; b[1] += w * R.e[i]; A.set(ka, a); B.set(kb, b);
  }
  // S2.5: fehlt die Stunde im eigenen Tagtyp, zuerst der Geschwister-Tagtyp (Samstag ↔ Sonn-/Feiertag, Werktag ↔ Ferienwerktag), dann alle Tage
  const SIB = [CLS.F, CLS.W, CLS.H, CLS.S];
  return Float64Array.from(testSel, (i) => { const a = A.get((T.g[i] * NCLS + T.cl[i]) * 24 + T.hr[i]) || A.get((T.g[i] * NCLS + SIB[T.cl[i]]) * 24 + T.hr[i]) || B.get(T.g[i] * 24 + T.hr[i]); return a && a[1] > 0 ? T.e[i] * a[0] / a[1] : missing; });
}

// ---------- Lernen aus den eigenen Fehlern (Kandidat „adaptive“) ----------
// Jeder ausgewertete Tag hinterlässt je Gruppe, wie weit das eigene Profil und das gepoolte Modell danebenlagen (außerhalb der Stichprobe,
// Rolling Origin). Daraus entsteht ein Lernstand, der mit jedem Tag fortgeschrieben wird (ältere Tage verblassen mit Halbwertszeit):
//   Prognose = w_g × eigenes Profil + (1 − w_g) × gepooltes Modell (von allen Gruppen gelernt)
// w_g: Gruppen, deren eigene Historie zuletzt besser traf, stützen sich mehr auf sich selbst; wo sie schlechter traf (oder fehlt), lernt die
// Gruppe von allen anderen. Gewicht nach Bates–Granger (umgekehrt zum quadrierten Fehler), geschrumpft Richtung Gesamtgewicht: wenig eigene
// Erfahrung → Verhalten der Gesamtheit. Eine zusätzliche Niveaukorrektur je Gruppe aus dem Fehler der Vortage wurde mit den echten Daten
// (2.–4.11.2026) geprüft und verschlechterte die Tagessumme (10,5 statt 7,2 % je Gruppe am 4.11.) – das tägliche Neutraining gleicht das
// Niveau schon aus; sie ist deshalb nicht enthalten.
// Der Kandidat läuft in der Selbstprüfung mit und wird nur aktiv, wenn er das bisher gewählte Modell messbar schlägt (GATES.adGain).
export const FEEDBACK = { v: 1, halfLifeDays: 7, kBlend: 50, sharp: 2 };
/** Leerer Lernstand: groups[key] = [Starts, erwartet Profil, erwartet gepoolt, |Fehler| Profil, |Fehler| gepoolt] (je Gruppe-Stunde, verblassend) */
export const emptyFeedback = () => ({ v: FEEDBACK.v, upto: null, days: 0, groups: {} });
const dayGap = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400e3);
/** Lernstand um einen ausgewerteten Tag fortschreiben (muP: Profil mit NaN, wo die Gruppe keine eigene Historie hat; muQ: gepooltes Modell) */
export function feedbackUpdate(fb, day, R, sel, muP, muQ) {
  if (fb.upto) {
    const f = 0.5 ** (Math.max(0, dayGap(fb.upto, day)) / FEEDBACK.halfLifeDays); fb.days *= f;
    for (const [k, s] of Object.entries(fb.groups)) { for (let j = 0; j < 5; j++) s[j] *= f; if (s[0] < 0.05 && s[1] < 0.05 && s[2] < 0.05) delete fb.groups[k]; }
  }
  sel.forEach((i, j) => {
    const key = R.keys[R.g[i]], y = R.y[i], q = muQ[j], p = Number.isFinite(muP[j]) ? muP[j] : q;
    const s = fb.groups[key] || (fb.groups[key] = [0, 0, 0, 0, 0]); s[0] += y; s[1] += p; s[2] += q; s[3] += Math.abs(y - p); s[4] += Math.abs(y - q);
  });
  fb.upto = day; fb.days += 1;
  return fb;
}
/** Gewichte aus dem Lernstand: of(key) → { w (Anteil eigenes Profil), eP/eQ (Fehler je Start: eigenes Profil / gepoolt, geschrumpft), y (Starts) } */
export function feedbackWeights(fb) {
  const G = Object.entries(fb?.groups || {}); let Y = 0, AP = 0, AQ = 0;
  for (const [, s] of G) { Y += s[0]; AP += s[3]; AQ += s[4]; }
  const eP = Y > 0 ? AP / Y : 1, eQ = Y > 0 ? AQ / Y : 1, K = FEEDBACK.kBlend, g = FEEDBACK.sharp;
  const wOf = (a, b) => (a + b > 0 ? b ** g / (a ** g + b ** g) : 0.5), w0 = wOf(eP, eQ), map = new Map();
  for (const [k, s] of G) { const ep = (s[3] + K * eP) / (s[0] + K), eq = (s[4] + K * eQ) / (s[0] + K); map.set(k, { w: wOf(ep, eq), eP: ep, eQ: eq, y: s[0] }); }
  const dflt = { w: w0, eP, eQ, y: 0 };
  return { w0, eP, eQ, map, of: (k) => map.get(k) || dflt };
}
/** Prognose des lernenden Modells aus Profil (NaN = keine eigene Historie) und gepooltem Modell, keyOf(j) = Gruppenschlüssel der Zeile j */
export function predictAdaptive(muP, muQ, keyOf, fbw) {
  return Float64Array.from(muQ, (q, j) => { const { w } = fbw.of(keyOf(j)), p = muP[j]; return Number.isFinite(p) ? w * p + (1 - w) * q : q; });
}
/** Lernstand für log.json: auf 0,1 gerundet */
export const compactFeedback = (fb) => ({ v: fb.v, upto: fb.upto, days: +fb.days.toFixed(2), groups: Object.fromEntries(Object.entries(fb.groups).map(([k, s]) => [k, s.map(x => Math.round(x * 10) / 10)])) });
/** Was das lernende Modell gerade gelernt hat (Anzeige): Anteil eigenes Profil, wie viele Gruppen sich eher auf sich selbst oder auf alle stützen, Beispiele */
export function learnSummary(fb, fbw = feedbackWeights(fb)) {
  const rows = [...fbw.map].map(([k, v]) => ({ k, ...v })), big = rows.filter(r => r.y >= 30), Y = sum(rows.map(r => r.y)) || 1;
  const ex = (r) => [r.k, +r.w.toFixed(2), +r.eP.toFixed(3), +r.eQ.toFixed(3), Math.round(r.y)];
  return { upto: fb.upto, days: +fb.days.toFixed(1), groups: rows.length, judged: big.length, ownShare: +(sum(rows.map(r => r.w * r.y)) / Y).toFixed(3), ownGlobal: +fbw.w0.toFixed(3),
    errOwn: +fbw.eP.toFixed(3), errPooled: +fbw.eQ.toFixed(3), leanOwn: big.filter(r => r.w >= 0.6).length, leanPool: big.filter(r => r.w <= 0.4).length, mixed: big.filter(r => r.w > 0.4 && r.w < 0.6).length,
    own: big.slice().sort((a, b) => b.w - a.w || b.y - a.y).slice(0, 5).map(ex), pool: big.slice().sort((a, b) => a.w - b.w || b.y - a.y).slice(0, 5).map(ex) };
}

/** Kennzahlen eines Tages: WAPE je Gruppe-Stunde und Gruppe-Tag, Verzerrung (Σ erwartet ÷ Σ real − 1), Abdeckung des 80-%-Bandes */
export const SIZE_CLASSES = [['S', 20], ['M', 200], ['L', Infinity]]; // Gruppengröße nach Fahrtbeginnen des Prüftags: < 20, < 200, ab 200
export function scoreDay(R, sel, mu, phi = 1, { split = false, mask = null, byAgs = false } = {}) {
  let sy = 0, sabs = 0, smu = 0, inside = 0, n = 0; const gd = new Map();
  sel.forEach((i, j) => {
    const y = R.y[i], m = mu[j]; sy += y; smu += m; sabs += Math.abs(y - m); n++;
    if (Math.abs(y - m) <= Z80 * Math.sqrt(phi * m) + 0.5) inside++;
    const t = gd.get(R.g[i]) || [0, 0, 0]; t[0] += y; t[1] += m; t[2] += Math.abs(y - m); gd.set(R.g[i], t);
  });
  let sabsG = 0; for (const [, t] of gd) sabsG += Math.abs(t[0] - t[1]);
  const q = (x) => (x == null ? null : +x.toFixed(4));
  const out = { n, groups: gd.size, starts: Math.round(sy), wapeGH: sy > 0 ? q(sabs / sy) : null, wapeGD: sy > 0 ? q(sabsG / sy) : null, bias: sy > 0 ? q(smu / sy - 1) : null, cover80: n ? q(inside / n) : null };
  // Schattenwertung (Audit MET-03): nur Zeilen, für die „wie gestern“ einen Vortagswert hat (mask[j] = 1) – wie der Live-Abgleich. Wirkt nicht
  // auf die Modellwahl (chooseModel liest wapeGH/wapeGD); ab 28.11. Grundlage einer fairen Selbstprüfung.
  if (mask) { let fy = 0, fa = 0, fm = 0, fn = 0; const fg = new Map();
    sel.forEach((i, j) => { if (!mask[j]) return; const y = R.y[i], m = mu[j]; fy += y; fm += m; fa += Math.abs(y - m); fn++; const t = fg.get(R.g[i]) || [0, 0]; t[0] += y; t[1] += m; fg.set(R.g[i], t); });
    let fG = 0; for (const [, t] of fg) fG += Math.abs(t[0] - t[1]);
    out.fair = { n: fn, starts: Math.round(fy), wapeGH: fy > 0 ? q(fa / fy) : null, wapeGD: fy > 0 ? q(fG / fy) : null, bias: fy > 0 ? q(fm / fy - 1) : null }; }
  if (split) {
    // je Fahrzeugart und Größenklasse: [Abweichung Gruppe-Tag, Abweichung Gruppe-Stunde, Fahrtbeginne] – die Gesamtwertung ist nach Volumen gewichtet,
    // hier sieht man, wie es kleinen Gruppen und einzelnen Arten geht
    const acc = (m, k, t) => { const a = m[k] || (m[k] = [0, 0, 0, 0]); a[0] += Math.abs(t[0] - t[1]); a[1] += t[2]; a[2] += t[0]; a[3] += t[1]; };
    const ty = {}, sz = {};
    for (const [g, t] of gd) { acc(ty, String(R.keys[g]).split('|')[2] || '?', t); acc(sz, SIZE_CLASSES.find(([, lim]) => t[0] < lim)[0], t); }
    // [Abweichung Gruppe-Tag, Abweichung Gruppe-Stunde, Fahrtbeginne, erwartete Fahrtbeginne] – das vierte Feld seit S2.8 (Verzerrung je Art)
    const fin = (m) => Object.fromEntries(Object.entries(m).map(([k, a]) => [k, [a[2] > 0 ? q(a[0] / a[2]) : null, a[2] > 0 ? q(a[1] / a[2]) : null, Math.round(a[2]), Math.round(a[3])]]));
    out.byType = fin(ty); out.bySize = fin(sz);
    // S2.8: Σ Ist und Σ Prognose je Gemeinde und Art (nur Modelle mit Verzerrungskorrektur; ab BIAS.agsMin Fahrtbeginnen am Tag, sonst nur die Art)
    if (byAgs) { const ga = {}; for (const [g, t] of gd) { const [ags, , tyk] = String(R.keys[g]).split('|'); const x = ga[`${ags}|${tyk}`] || (ga[`${ags}|${tyk}`] = [0, 0]); x[0] += t[0]; x[1] += t[1]; }
      out.byAgsType = Object.fromEntries(Object.entries(ga).filter(([, x]) => Math.max(x[0], x[1]) >= BIAS.agsMin).map(([k, x]) => [k, [Math.round(x[0]), Math.round(x[1])]])); }
    // Spitzen: Deutschland-Summe und je Anbieter (Stundenreihe über die beobachteten Stunden)
    const de = { a: new Map(), f: new Map() }, ops = new Map();
    sel.forEach((i, j) => { const h = R.hr[i], op = String(R.keys[R.g[i]]).split('|')[1]; let o = ops.get(op); if (!o) ops.set(op, o = { a: new Map(), f: new Map() });
      for (const x of [de, o]) { x.a.set(h, (x.a.get(h) || 0) + R.y[i]); x.f.set(h, (x.f.get(h) || 0) + mu[j]); } });
    const pk = peakScore([de, ...ops.values()]), pde = peakScore([de]);
    if (pk) out.peak = pk; if (pde) out.peakDE = pde;
  }
  return out;
}
// ---------- Spitzen ----------
// Für die Disposition zählen Zeitpunkt und Höhe der Spitze: Spitzenstunde genau bzw. ±1 Stunde getroffen, Abweichung in den drei stärksten Ist-Stunden.
// Je Gebiet (Deutschland-Summe, je Anbieter) über die beobachteten Stunden; Gebiete mit weniger als PEAK.minStarts Fahrtbeginnen oder zu wenigen
// beobachteten Stunden zählen nicht (bis 5.11.2026 fehlte die Abendspitze 17–19 Uhr wegen der Sammler-Lücke, solche Tage fallen so heraus).
export const PEAK = { minHours: 23, minHoursLive: 16, minStarts: 100 };
/** list = [{ a: Map(Stunde → Ist), f: Map(Stunde → Prognose) }] → { n, hit, hit1, top3 } oder null */
export function peakScore(list, { minHours = PEAK.minHours, minStarts = PEAK.minStarts } = {}) {
  let n = 0, hit = 0, hit1 = 0, ta = 0, te = 0;
  for (const { a, f } of list) {
    const hs = [...a.keys()]; if (hs.length < minHours) continue;
    let tot = 0; for (const h of hs) tot += a.get(h); if (tot < minStarts) continue;
    const ha = hs.reduce((b, h) => (a.get(h) > a.get(b) ? h : b), hs[0]), hf = hs.reduce((b, h) => ((f.get(h) || 0) > (f.get(b) || 0) ? h : b), hs[0]);
    n++; if (ha === hf) hit++; if (Math.abs(ha - hf) <= 1) hit1++;
    for (const h of [...hs].sort((x, y) => a.get(y) - a.get(x)).slice(0, 3)) { ta += a.get(h); te += Math.abs(a.get(h) - (f.get(h) || 0)); }
  }
  return n ? { n, hit: +(hit / n).toFixed(3), hit1: +(hit1 / n).toFixed(3), top3: ta > 0 ? +(te / ta).toFixed(4) : null } : null;
}

/**
 * Wetter-Freischaltung über Gemeinde-Tage (Gemeinde aus dem Gruppenschlüssel): Temperaturspanne = 90. minus 10. Perzentil der Tagesmittel je
 * Gemeinde-Tag; Regentag = Tag, an dem ≥ GATES.wxShareDay der Gemeinde-Tage ≥ 3 Regenstunden hatten, Trockentag = an dem ≥ wxShareDay ohne Regen
 * blieben; dazu wenig Zeilen ohne Wetter. Bis 6.11.2026 zählte ein Tag nur als trocken, wenn bundesweit keine einzige Gruppe-Stunde Regen hatte –
 * bei ~1.000 Gruppen nie, das Gate blieb damit dauerhaft zu.
 */
export function weatherGate(R, sel, memDays = []) {
  const gdays = new Map(); let miss = 0;
  for (const i of sel) {
    if (!R.hasW[i]) { miss++; continue; }
    const k = `${R.day[i]}|${String(R.keys[R.g[i]]).split('|')[0]}`, h = R.hr[i];
    const d = gdays.get(k) || { day: R.day[i], t: 0, n: 0, rainH: new Set() }; d.t += (R.w[0][i] + R.w[1][i]) * 10 + 10; d.n++; if (R.w[2][i]) d.rainH.add(h); gdays.set(k, d);
  }
  const byDay = new Map(), means = [];
  for (const d of gdays.values()) { means.push(d.t / d.n); const b = byDay.get(d.day) || { n: 0, rain: 0, dry: 0 }; b.n++; if (d.rainH.size >= 3) b.rain++; if (!d.rainH.size) b.dry++; byDay.set(d.day, b); }
  means.sort((a, b) => a - b);
  const pq = (p) => (means.length ? means[Math.min(means.length - 1, Math.floor(p * means.length))] : 0);
  const days = [...byDay.values()]; let rainy = days.filter(b => b.rain >= GATES.wxShareDay * b.n).length, dry = days.filter(b => b.dry >= GATES.wxShareDay * b.n).length;
  let lo = means.length ? pq(0.1) : Infinity, hi = means.length ? pq(0.9) : -Infinity;
  // Langzeitgedächtnis: Tage, die das Fenster verlassen haben, zählen mit (je Tag [p10, p90 der Gemeinde-Tagesmittel, Regentag, Trockentag])
  for (const [a, b, r, d] of memDays || []) { lo = Math.min(lo, a); hi = Math.max(hi, b); rainy += r ? 1 : 0; dry += d ? 1 : 0; }
  const range = hi > lo ? hi - lo : 0, missShare = sel.length ? miss / sel.length : 1;
  return { ok: range >= GATES.wxTempRangeK && rainy >= GATES.wxRainDays && dry >= GATES.wxRainDays && missShare <= GATES.wxMissingMax, tempRangeK: +range.toFixed(1), rainDays: rainy, dryDays: dry, missingShare: +missShare.toFixed(3), days: byDay.size, memDays: (memDays || []).length, places: gdays.size };
}

// ---------- Langzeitgedächtnis für Wetter- und Umgebungswirkungen ----------
// Das Fenster (21 Tage) vergisst alles Ältere – für den Alltag richtig, für seltene Ereignisse (Streik, Unwetter) nicht: sie kommen in 21 Tagen
// höchstens einmal vor. Deshalb hinterlässt jeder vollständige Tag beim ersten Lauf danach seine Information über die Wirkungen (EFFECTS):
// H_d = Σ μ·x·xᵀ und u_d = H_d·β̂ + Σ (y − μ)·x (quadratische Näherung seiner Log-Likelihood um das Fenstermodell, nur Zeilen mit Wetter).
// Solange der Tag im Fenster liegt, lernt das Modell ihn direkt; verlässt er das Fenster, wandert (H_d, u_d) ins Gedächtnis (old, Halbwertszeit
// MEMORY.halfLifeDays). Das Gedächtnis ist dann der Prior der Wirkungen im Fenstermodell (fitPooled prior) – kein Tag zählt doppelt.
export const MEMORY = { v: 1, halfLifeDays: 180, keepWxDays: 365 };
export const emptyMemory = () => ({ v: MEMORY.v, upto: null, old: null, days: {}, wxDays: {} });
const gapDays = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400e3);
const decayTo = (o, day) => (o ? 2 ** (-Math.max(0, gapDays(o.at, day)) / MEMORY.halfLifeDays) : 1);
/** Tage vor beforeDay aus dem Fenster ins Gedächtnis übernehmen (mit Abklingen bis zum jeweiligen Tag) */
export function memoryMerge(mem, beforeDay) {
  for (const d of Object.keys(mem.days).sort()) {
    if (d >= beforeDay) continue;
    const x = mem.days[d], o = mem.old || { at: d, P: new Array(NE * NE).fill(0), h: new Array(NE).fill(0), n: new Array(NE).fill(0), dk: new Array(NE).fill(0), days: 0 }, f = decayTo(o, d);
    o.P = o.P.map((v, i) => v * f + (x.H[i] || 0)); o.h = o.h.map((v, i) => v * f + (x.u[i] || 0)); o.n = o.n.map((v, i) => v * f + (x.n[i] || 0)); o.dk = o.dk.map((v, i) => v * f + (x.n[i] > 0 ? 1 : 0)); o.days = o.days * f + 1; o.at = d;
    mem.old = o; if (x.wx) mem.wxDays[d] = x.wx; delete mem.days[d];
  }
  for (const d of Object.keys(mem.wxDays).sort().slice(0, -MEMORY.keepWxDays)) delete mem.wxDays[d];
  return mem;
}
function solveSmall(Pm, h, ridge = 1e-6) { const H = Float64Array.from(Pm); for (let i = 0; i < NE; i++) H[i * NE + i] += ridge; return solveSpd(H, Float64Array.from(h)); }
/** Prior aus dem Gedächtnis zum Tag day: { b, P, n, dk, days } oder null */
/**
 * Gedächtnis aus einer Fassung mit weniger Wirkungen (EFFECTS) auf die aktuelle Länge bringen: neue Merkmale stehen hinten (CTX_KEYS),
 * also bleiben alte Einträge an ihrem Platz und die neuen beginnen mit 0 (seit 08.11.2026: fest). Ändert mem an Ort und Stelle.
 */
export function memoryResize(mem) {
  const vec = (a) => (Array.isArray(a) && a.length < NE ? [...a, ...new Array(NE - a.length).fill(0)] : a);
  const mat = (a) => { if (!Array.isArray(a) || a.length >= NE * NE) return a; const k = Math.round(Math.sqrt(a.length)); if (k * k !== a.length) return a; const o = new Array(NE * NE).fill(0); for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) o[i * NE + j] = a[i * k + j]; return o; };
  if (mem?.old) Object.assign(mem.old, { P: mat(mem.old.P), h: vec(mem.old.h), n: vec(mem.old.n), dk: vec(mem.old.dk) });
  for (const [d, x] of Object.entries(mem?.days || {})) mem.days[d] = { ...x, H: mat(x.H), u: vec(x.u), n: vec(x.n) };
  return mem;
}
export function memoryPrior(mem, day) {
  const o = mem?.old; if (!o || !(o.days > 0)) return null;
  const f = decayTo(o, day), Pm = o.P.map(v => v * f), h = o.h.map(v => v * f);
  return { b: solveSmall(Pm, h), P: Float64Array.from(Pm), n: o.n.map(v => v * f), dk: o.dk.map(v => v * f), days: o.days * f };
}
/** Tagesbeiträge ergänzen: m = Fenstermodell (mit allen Wirkungen), dayIdx = Tage (Index in R.day), dayName(i) → 'YYYY-MM-DD' */
export function memoryAddDays(mem, R, m, sel, dayIdx, dayName) {
  const want = new Set(dayIdx), acc = new Map();
  const on = [...(m.weather ? WX_EFF : []), ...m.ctx.map(k => 3 + k)];
  for (const i of sel) {
    if (!want.has(R.day[i])) continue;
    let a = acc.get(R.day[i]); if (!a) acc.set(R.day[i], a = { H: new Float64Array(NE * NE), s: new Float64Array(NE), n: new Float64Array(NE), gd: new Map() });
    const mu = R.e[i] * Math.exp(m.a[R.g[i]] + eta(m, R, i, m.weather)), r = R.y[i] - mu, x = new Float64Array(NE);
    if (m.weather) for (let k = 0; k < NW && k < R.w.length; k++) x[WX_EFF[k]] = R.w[k][i];
    for (const k of m.ctx) x[3 + k] = R.c[k][i];
    for (const e of on) { if (!x[e]) continue; a.s[e] += r * x[e]; a.n[e] += 1; for (const f of on) if (x[f]) a.H[e * NE + f] += mu * x[e] * x[f]; }
    if (R.hasW[i]) { const k = `${R.keys[R.g[i]]}`.split('|')[0], g = a.gd.get(k) || { t: 0, n: 0, rainH: new Set() }; g.t += (R.w[0][i] + R.w[1][i]) * 10 + 10; g.n++; if (R.w[2][i]) g.rainH.add(R.hr[i]); a.gd.set(k, g); }
  }
  const r6 = (v) => (v === 0 ? 0 : +v.toPrecision(6));
  for (const [di, a] of acc) {
    const u = new Float64Array(NE); for (const e of on) { let v = a.s[e]; for (const f of on) v += a.H[e * NE + f] * m.beta[pos(f)]; u[e] = v; }
    let wx = null;
    if (a.gd.size) { const ms = [...a.gd.values()].map(g => g.t / g.n).sort((x, y) => x - y), q = (p) => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))], gs = [...a.gd.values()];
      wx = [r6(q(0.1)), r6(q(0.9)), gs.filter(g => g.rainH.size >= 3).length >= GATES.wxShareDay * gs.length ? 1 : 0, gs.filter(g => !g.rainH.size).length >= GATES.wxShareDay * gs.length ? 1 : 0]; }
    mem.days[dayName(di)] = { H: [...a.H].map(r6), u: [...u].map(r6), n: [...a.n].map(r6), wx };
    if (!mem.upto || dayName(di) > mem.upto) mem.upto = dayName(di);
  }
  return mem;
}
/** Stand je Wirkung (Gedächtnis + Tage im Fenster): Faktor exp(b), 90-%-Bereich (mit Überstreuung phi), Gemeinde-Stunden mit Ereignis, Tage mit Ereignis */
export function memorySummary(mem, day, phi = 1) {
  if (!mem) return null;
  const o = mem.old, f = decayTo(o, day), Pm = new Array(NE * NE).fill(0), h = new Array(NE).fill(0), n = new Array(NE).fill(0), dk = new Array(NE).fill(0);
  if (o) for (let i = 0; i < NE * NE; i++) Pm[i] = o.P[i] * f;
  if (o) for (let i = 0; i < NE; i++) { h[i] = o.h[i] * f; n[i] = o.n[i] * f; dk[i] = o.dk[i] * f; }
  const win = Object.values(mem.days); for (const x of win) { for (let i = 0; i < NE * NE; i++) Pm[i] += x.H[i] || 0; for (let i = 0; i < NE; i++) { h[i] += x.u[i] || 0; n[i] += x.n[i] || 0; dk[i] += x.n[i] > 0 ? 1 : 0; } }
  const b = solveSmall(Pm, h), effects = {};
  EFFECTS.forEach((e, i) => {
    const info = Pm[i * NE + i]; if (!(info > 1e-9)) { effects[e] = { b: null, n: Math.round(n[i]), days: +dk[i].toFixed(1) }; return; }
    // Randvarianz aus der Inversen (über die Wirkungen mit Information)
    const idx = EFFECTS.map((_, j) => j).filter(j => Pm[j * NE + j] > 1e-9), k = idx.length, A = new Float64Array(k * k);
    idx.forEach((p, a) => idx.forEach((q, c) => { A[a * k + c] = Pm[p * NE + q] + (a === c ? 1e-9 : 0); }));
    const ei = new Float64Array(k); ei[idx.indexOf(i)] = 1;
    const col = (() => { const L = new Float64Array(k * k); for (let r = 0; r < k; r++) for (let c = 0; c <= r; c++) { let s0 = A[r * k + c]; for (let t = 0; t < c; t++) s0 -= L[r * k + t] * L[c * k + t]; L[r * k + c] = r === c ? Math.sqrt(Math.max(s0, 1e-18)) : s0 / L[c * k + c]; }
      const z = new Float64Array(k), x = new Float64Array(k); for (let r = 0; r < k; r++) { let s0 = ei[r]; for (let t = 0; t < r; t++) s0 -= L[r * k + t] * z[t]; z[r] = s0 / L[r * k + r]; }
      for (let r = k - 1; r >= 0; r--) { let s0 = z[r]; for (let t = r + 1; t < k; t++) s0 -= L[t * k + r] * x[t]; x[r] = s0 / L[r * k + r]; } return x; })();
    const se = Math.sqrt(Math.max(col[idx.indexOf(i)], 0) * Math.max(1, phi));
    effects[e] = { b: +b[i].toFixed(4), se: +se.toFixed(4), lo: +Math.exp(b[i] - 1.645 * se).toFixed(3), hi: +Math.exp(b[i] + 1.645 * se).toFixed(3), n: Math.round(n[i]), days: +dk[i].toFixed(1) };
  });
  return { v: mem.v, upto: mem.upto, days: +((o?.days || 0) * f + win.length).toFixed(1), oldDays: +((o?.days || 0) * f).toFixed(1), windowDays: win.length, since: [...Object.keys(mem.wxDays), ...Object.keys(mem.days)].sort()[0] || null, halfLifeDays: MEMORY.halfLifeDays, effects };
}
export const compactMemory = (mem) => { const r = (v) => (v === 0 ? 0 : +(+v).toPrecision(6)); const o = mem.old ? { at: mem.old.at, P: mem.old.P.map(r), h: mem.old.h.map(r), n: mem.old.n.map(r), dk: mem.old.dk.map(r), days: r(mem.old.days) } : null; return { v: mem.v, upto: mem.upto, old: o, days: mem.days, wxDays: mem.wxDays }; };
/** Umgebungsmerkmale, die ins Modell dürfen: genug Gemeinde-Stunden mit Ereignis an genug Tagen (Fenster sel + Gedächtnis prior) */
export const CTX_OFF = ['road'];
export function ctxActive(R, sel, prior = null) {
  if (!R.c) return [];
  const out = [];
  for (let k = 0; k < NCTX; k++) {
    if (CTX_OFF.includes(CTX_KEYS[k])) continue; // A13: Autobahn nicht mehr als Merkmal (Sperrung/Stau in der Gemeinde trägt keine messbare Wirkung, kostet Varianz)
    let n = 0; const ds = new Set(); for (const i of sel) if (R.c[k][i]) { n++; ds.add(R.day[i]); }
    if (n + Math.round(prior?.n?.[3 + k] || 0) >= GATES.ctxMinRows && ds.size + Math.round(prior?.dk?.[3 + k] || 0) >= GATES.ctxMinDays) out.push(k); // Gedächtnis gerundet (abgeklungen)
  }
  return out;
}
/** Umgebung eines Fensters: Wetter (Gate inkl. Gedächtnis) und eingeschaltete Merkmale */
export function envOf(R, sel, mem = null, prior = null) {
  const gate = weatherGate(R, sel, Object.values(mem?.wxDays || {})), ctx = ctxActive(R, sel, prior);
  return { gate, weather: gate.ok, ctx, on: gate.ok || ctx.length > 0 };
}
