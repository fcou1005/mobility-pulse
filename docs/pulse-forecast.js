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
import * as E from './pulse-econ.js?v=mwf6frp1';
import { hourOf, dayOf } from './pulse-track.js?v=mwf6frp1';
import { CTX_KEYS, ctxLookup } from './pulse-context.js?v=mwf6frp1';
import { familyOf, FAMILIES } from './pulse-core.js?v=mwf6frp1';
export { CTX_KEYS };
export const dayOfLocal = (ms) => dayOf(ms);
// Je Fahrzeugfamilie ein eigenes Modell (seit 08.11.2026): micro (E-Scooter, Räder, Lastenräder, Sonstige) wie bisher in forecast/, E-Roller in
// forecast/moped/, Carsharing in forecast/car/ – Tagesgang, Wetterwirkung und Gruppeneffekte lernen nicht über Familien hinweg.
export { FAMILIES };
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
const NCLS = 4, CLS = { W: 0, F: 1, S: 2, H: 3 }, NERA = 8;
// Fahrzeugarten für Art × Stunde (Option typeHour); unbekannte → other
export const TYPES = ['scooter', 'bike', 'ebike', 'cargo', 'other'];
const NTY = TYPES.length, typeIx = (key) => { const t = TYPES.indexOf(String(key).split('|')[2]); return t < 0 ? NTY - 1 : t; };
// S2.5: Wochenende × Stunde (I_WE) teilen sich Samstag und Sonn-/Feiertag; der eigene Tagtyp-Anteil weicht davon nur ab. Fehlen einem der beiden
// Stunden im Training (31.10./01.11.2026: Sonntag/Allerheiligen erst ab 9 Uhr gezählt), gilt für ihn das Wochenende statt des Werktags (08.11. 8 Uhr
// sonst 4,9 × zu hoch). Kleiner Ridge (2) für den gemeinsamen Teil, 20 für die Tagtyp-Abweichung: der gemeinsame Teil trägt den Großteil.
// A13: weitere Wettermerkmale hinten angehängt (Parameter ab I_WX2, Wirkungen hinter den Umgebungsmerkmalen – das Gedächtnis wächst nur hinten):
// Regen ≥ 1 mm/h und ≥ 4 mm/h (mit „Regen ≥ 0,1 mm/h“ drei Stufen: leicht, mäßig, stark) und Regen in der Vorstunde.
const NCTX = CTX_KEYS.length, I_HOUR = 0, I_CLS = 24, I_ERA = I_CLS + NCLS * 24, I_WX = I_ERA + NERA, I_CTX = I_WX + 3, I_TH = I_CTX + NCTX, I_WE = I_TH + NTY * 24, I_WX2 = I_WE + 24, P = I_WX2 + 3;
const WE_CLS = 2; // Tagtypen ab hier (S = 2, H = 3) sind Wochenende
/** Wirkungen mit Langzeitgedächtnis: Wetter (kalt, warm, Regen) und Umgebungsmerkmale, Reihenfolge wie im Parametervektor ab I_WX */
export const EFFECTS = ['cold', 'warm', 'rain', ...CTX_KEYS, 'rain1', 'rain4', 'rainPrev'];
const NE = EFFECTS.length, NW = 6;
const WX_EFF = [0, 1, 2, NE - 3, NE - 2, NE - 1]; // Wirkung je Wettermerkmal R.w[0..5]
const pos = (e) => (e < 3 + NCTX ? I_WX + e : I_WX2 + (e - 3 - NCTX)); // Stelle einer Wirkung im Parametervektor
const LAMBDA = (j) => (j < I_CLS ? 1e-3 : j < I_ERA ? 20 : j < I_WX ? 5 : j < I_TH ? 8 : j < I_WE ? 20 : j < I_WX2 ? 2 : 8);
const Z80 = 1.2816, ALPHA = 4;
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
const pinball = (q, y, yq) => (y >= yq ? q * (y - yq) : (1 - q) * (yq - y));
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
const sum = (a) => a.reduce((s, x) => s + x, 0);

/** Wetter-Merkmale aus Temperatur (°C), Niederschlag (mm/h) und Niederschlag der Vorstunde: [kalt, warm, Regen ≥ 0,1, ≥ 1, ≥ 4, Vorstunde ≥ 0,1]
 *  mit Knick bei 10 °C (A13: drei Regenstufen und Vorstunde; ohne Vorstundenwert 0) */
export const wxFeatures = (t, p, pPrev = null) => (t == null || p == null ? null : [Math.min(t - 10, 0) / 10, Math.max(t - 10, 0) / 10, p >= 0.1 ? 1 : 0, p >= 1 ? 1 : 0, p >= 4 ? 1 : 0, pPrev != null && pPrev >= 0.1 ? 1 : 0]);

/** Tagtyp 'W' | 'F' | 'S' | 'H' → 0..3 */
export const classOf = (dt) => CLS[dt] ?? 0;

/**
 * Zeilen aufbauen. days: [{ day, cls (Funktion ags → 0..3), era (ganze Zahl ≥ 0, Regelstand-Folge), complete, hourMin[24], groups: { 'ags|op|ty': { start[24], vmin[24] } } }]
 * wx(ags, day, h) → [kalt, warm, Regen] | null. Rückgabe: Spaltenfelder für schnelle Schleifen.
 */
export function buildRows(days, wx = () => null, { hourMin = GATES.hourMinObserved, ctx = null } = {}) {
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
const eta = (m, R, i, wxOn) => m.beta[I_HOUR + R.hr[i]] + m.beta[I_CLS + R.cl[i] * 24 + R.hr[i]] + (R.cl[i] >= WE_CLS ? m.beta[I_WE + R.hr[i]] : 0) + (R.era[i] > 0 ? m.beta[I_ERA + R.era[i] - 1] : 0) + (m.typeHour ? m.beta[I_TH + m.gType[R.g[i]] * 24 + R.hr[i]] : 0)
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
const shiftDay = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
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
export function predictAll(R, days, before, trainSel, F, sel, want, { envFit = {}, fb = null, dayOfRow = () => null, chronosOf = null, fbC = null } = {}) {
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
export function buildFuture(R, fut, expo, wx = () => null, ctx = null) {
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
export function actualOfDay(d, { hourMin = GATES.hourMinObserved, per60 = false } = {}) {
  const out = new Map();
  for (const [key, g] of Object.entries((per60 ? d.groups : d.groupsRaw ?? d.groups) || {})) { // gezählt (Verlauf); per60 = je volle Stunde
    if (!Array.isArray(g.start) || !Array.isArray(g.vmin)) continue;
    const scs = scopesOfKey(key);
    for (let h = 0; h < 24; h++) {
      if (!(d.hourMin?.[h] >= hourMin) || !((g.vmin[h] || 0) > 0)) continue;
      for (const sc of scs) { let a = out.get(sc); if (!a) out.set(sc, a = new Array(24).fill(null)); a[h] = (a[h] || 0) + (g.start[h] || 0); }
    }
  }
  return out;
}
/**
 * Erwartete Fahrzeugstunden je Gruppe und Stunde (Flottenannahme für Plan, Live-Prognose und Selbstprüfung), nur Tage mit Index < beforeIdx.
 * mode 'last' = zuletzt beobachteter Wert derselben Stunde; 'class' = dasselbe, aber vom letzten Tag desselben Tagtyps wie der Zieltag
 * (target(ags) → Tagtyp; sonst 'last'); 'mean' = Mittel der letzten EXPOSURE.n beobachteten Werte; 'classMean' = Mittel der letzten EXPOSURE.n
 * Werte desselben Tagtyps (sonst 'mean'). Stunden, die nie beobachtet wurden: Mittel der beobachteten Stunden der Gruppe.
 */
export const EXPOSURE = { mode: 'last', n: 3 };
/**
 * Abweichung ausgegebener Prognosen (Live-Abgleich) für Ansicht und Bericht aus einer Quelle (Audit MET-08): je Anbieter und Stunde
 * wapeOpHn gegen naiveOpH über dieselben Stunden, Mittel der Prognosen der letzten `days` Tage (Bezug: now oder jüngste Prognose).
 * Rückgabe { a, b, ratio, skill, n, h, targetDays } oder null.
 */
export function liveSummary(live = [], { days = 7, now = null } = {}) {
  const list = (live || []).filter(x => x && x.wapeOpHn != null && x.naiveOpH != null), ref = now ?? Math.max(0, ...list.map(x => x.at || 0));
  const rec = list.filter(x => !ref || !x.at || ref - x.at <= days * 86400e3); if (!rec.length) return null;
  const mean = (f) => rec.reduce((s, x) => s + f(x), 0) / rec.length, a = mean(x => x.wapeOpHn), b = mean(x => x.naiveOpH);
  return { a, b, ratio: b > 0 ? a / b : null, skill: b > 0 ? 1 - a / b : null, n: rec.length, h: mean(x => x.hours ?? 24), targetDays: new Set(rec.map(x => dayOf(x.from ?? x.at))).size };
}
export function lastExposure(days, beforeIdx = days.length, { target = null, mode = EXPOSURE.mode } = {}) {
  const hist = new Map(), byClass = target && (mode === 'class' || mode === 'classMean'), multi = mode === 'mean' || mode === 'classMean';
  for (let di = 0; di < Math.min(beforeIdx, days.length); di++) { const d = days[di];
    for (const [k, g] of Object.entries(d.groups)) {
      if (!Array.isArray(g.vmin)) continue; let a = hist.get(k); if (!a) hist.set(k, a = Array.from({ length: 24 }, () => []));
      const c = byClass ? d.cls(k.split('|')[0]) : 0;
      for (let h = 0; h < 24; h++) if (d.hourMin[h] >= GATES.hourMinObserved && (g.vmin[h] || 0) > 0) a[h].push([g.vmin[h] / 60, c]);
    }
  }
  const last = new Map();
  for (const [k, a] of hist) {
    const tc = byClass ? target(k.split('|')[0]) : null;
    const out = a.map(list => {
      if (!list.length) return 0;
      const same = tc != null ? list.filter(x => x[1] === tc) : list, src = same.length ? same : list, take = multi ? src.slice(-EXPOSURE.n) : src.slice(-1);
      return take.reduce((t, x) => t + x[0], 0) / take.length;
    });
    const seen = out.filter(x => x > 0);
    if (seen.length && seen.length < 24) { const m = sum(seen) / seen.length; for (let h = 0; h < 24; h++) if (!(out[h] > 0)) out[h] = m; }
    last.set(k, out);
  }
  return last;
}
/**
 * Plan eines Tags (Index di in days): Modell nur mit Tagen < di, Fahrzeugstunden vom letzten beobachteten Wert vor di, Wetter des Tags.
 * Modellwahl wie im Betrieb: chooseModel über die Auswertungen der Tage < Tag. Rückgabe { model, trainDays, scopes } oder null (zu wenige Tage).
 */
export function planDay(R, days, di, day, wx, calendar, evals, fb = null, { mem = null, prior: memPrior = null, ctx = null, live = null, ext = null, fbC = null } = {}) {
  const trainSel = []; for (let i = 0; i < R.n; i++) if (R.day[i] < di) trainSel.push(i);
  const trainDays = new Set(trainSel.map(i => R.day[i])).size;
  if (trainDays < GATES.minTrainDays) return null;
  const prior = Object.fromEntries(Object.entries(evals || {}).filter(([d]) => d < day));
  const env = envOf(R, trainSel, mem, memPrior), envFit = env.on ? { weather: env.weather, ctx: env.ctx, prior: memPrior } : {}, pick = (a) => (a === 'pooledWx' ? (env.on ? 'pooledWx' : 'pooled') : a || 'pooled');
  // Entscheidungsregel wie im Betrieb, mit dem, was vor dem Tag bekannt war (Selbstprüfung bis Vortag, Live-Prognosen, die vor Tagesbeginn ausgewertet waren)
  const dayStart = localToUtcMs(day, 0);
  const gate = []; // S2.3: Chronos/Mischung über den DM-Test in chooseModel (Selbstprüfung bis vor dem Tag)
  let model = pick(chooseModel(prior, { trainDays, live, untilMs: dayStart, nowMs: dayStart, without: gate }).active);
  // lernendes Modell nur, wenn der Lernstand ausschließlich Tage vor dem geplanten Tag kennt (rückwirkende Pläne sonst ohne Rückkopplung)
  if (model === 'adaptive' && !(fb?.upto && fb.upto < day)) model = pick(chooseModel(prior, { trainDays, without: ['adaptive', ...gate], live, untilMs: dayStart, nowMs: dayStart }).active);
  if (model === 'blend' && !(fbC?.upto && fbC.upto < day)) model = pick(chooseModel(prior, { trainDays, without: ['blend', 'adaptive'], live, untilMs: dayStart, nowMs: dayStart }).active);
  const rec = dayFromDoc({ day, runs: [], groups: {} }, calendar), fut = Array.from({ length: 24 }, (_, h) => ({ day, h, cls: rec.cls }));
  const last = lastExposure(days, di, { target: rec.cls }), F = buildFuture(R, fut, (k, h) => last.get(k)?.[h] ?? 0, wx, ctx), sel = Array.from({ length: F.n }, (_, i) => i);
  // Chronos für den Plan: Vortagsprognose des Tags, sonst der Lauf, der den Tag abdeckt
  const tH = Array.from({ length: 24 }, (_, h) => localToUtcMs(day, h)), useBack = !!ext?.hasBack(day);
  const chronosOf = ext ? (i) => { const t = tH[F.hr[i]], k = R.keys[F.g[i]]; return useBack ? ext.back(k, t) : ext.live(k, t); } : null;
  let mu = predictAll(R, days, di, trainSel, F, sel, new Set([model]), { envFit: model === 'pooled' ? {} : envFit, fb, dayOfRow: () => day, chronosOf, fbC }).mu.get(model);
  // S2.8: Plan mit derselben Verzerrungskorrektur wie die Veröffentlichung, aus den Prüfungen vor dem Tag
  let bias = null;
  if (BIAS.models.includes(model) && mu) { const tf = typeFactors(prior, model); if (Object.keys(tf).length) { const af = agsFactors(prior, model, tf); bias = { ...tf, ...(Object.keys(af).length ? { ags: af } : {}) }; mu = Float64Array.from(mu, (x, j) => x * biasFactorOf(R.keys[F.g[sel[j]]], tf, af)); } }
  const scopes = new Map(); for (const [sc, d] of aggregateFuture(R, F, mu, fut)) scopes.set(sc, d[day]);
  return { day, model, trainDays, scopes, ...(bias ? { bias } : {}) };
}
/**
 * Reihen des Dashboards. plans: Map Ortstag → planDay-Ergebnis (nur neu gerechnete), live: Map Gebiet → { [Ortstag]: number[24] } (Prognose ab der nächsten
 * vollen Stunde), nowH: erste Stunde der Prognose je Ortstag { [Tag]: ab Stunde }, prev: forecast/series.json des letzten Laufs.
 */
/**
 * S2.1: Faktor von „je volle Stunde“ auf „gezählt“ für Plan und Live-Prognose im Verlauf (dort bleibt alles gezählt, die Ansicht normiert wie bisher
 * mit den Minuten des zuletzt beobachteten Tags davor): Minuten der Endstunde (obsEnd) am letzten Tag vor `day` mit ≥ 50 Minuten in Stunde h ÷ 60.
 */
export function countedFactor(days, day, h) {
  for (let i = days.length - 1; i >= 0; i--) { const d = days[i]; if (d.day >= day) continue; const o = d.obsEnd?.[h]; if (o >= GATES.hourMinObserved) return o / 60; }
  return 1;
}
export function buildSeries({ days, today, tomorrow, plans, live, liveFrom, prev = null, now, status, active }) {
  const cf = new Map(), toC = (day, arr) => { let f = cf.get(day); if (!f) cf.set(day, f = Array.from({ length: 24 }, (_, h) => countedFactor(days, day, h))); return arr.map((x, h) => (x == null ? x : x * f[h])); };
  const keepFrom = dayOf(now - (SERIES_KEEP_DAYS - 1) * 86400e3), out = { version: 1, generatedAt: new Date(now).toISOString(), tz: 'Europe/Berlin', today, tomorrow, status, active, plans: {}, days: {} };
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
      const pn = plan?.scopes.get(sc), p = pn ? toC(day, pn) : o.p ?? null; if (p) e.p = p.map(rv); // neuer Plan je volle Stunde → gezählt; eingefrorene bleiben
      const a = act?.get(sc) ?? (day <= today ? o.a : null); if (a) e.a = a.map(rv);
      const l0 = live.get(sc)?.[day], l = l0 ? toC(day, l0) : null; if (l) { const from = liveFrom[day] ?? 0; e.l = l.map((x, h) => (h >= from ? rv(x) : null)); }
      if (e.p || e.a || e.l) entry[sc] = e;
    }
    if (Object.keys(entry).length) out.days[day] = entry;
    // Herkunft des Plans (Kontrolle im Dashboard): Modell, Trainingstage, Zeitpunkt des Einfrierens; bleibt mit dem Plan stehen
    if (plan) out.plans[day] = { model: plan.model, trainDays: plan.trainDays, at: new Date(now).toISOString(), retro: day < today };
    else if (prev?.plans?.[day] && out.days[day]) out.plans[day] = prev.plans[day];
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
// ext = chronosLookup(chronos.json) aus lib/pulse-chronos.js oder null (ohne Chronos: kein „chronos“, „blend“ = Hybrid)
export function runForecast({ docs, calendar = null, weather = [], weatherFc = null, breaks = null, incidents = [], curated = [], prevLog = null, prevSeries = null, now = Date.now(), horizon = 24, minGroupDay = 3, issueEveryMs = 6 * 3600e3, exclude = null, ext = null, pending = [], pendingFrom = null, family = null }) {
  const days = assignEras((docs || []).filter(d => d?.day && d.groups).map(d => dayFromDoc(d, calendar)).sort((a, b) => (a.day < b.day ? -1 : 1)));
  // Gruppen mit rotem Befund der Ereignis-Ampel (nicht plausibel gezählt) bleiben aus Training und Prognose
  if (exclude?.size) for (const d of days) { const g = {}; for (const [k, v] of Object.entries(d.groups)) if (!exclude.has(k)) g[k] = v; d.groups = g; }
  // S2.8: Strukturbruch je Gruppe (calib.json → breaks: erster Tag mit neuer Zählregel) – Tage davor lernen für diese Gruppe nicht mit (Ist bleibt im Verlauf)
  let broken = 0; if (breaks) for (const d of days) for (const k of Object.keys(d.groups)) if (breaks[k] && d.day < breaks[k]) { if (d.groups === d.groupsRaw) d.groups = { ...d.groups }; delete d.groups[k]; broken++; }
  const today = dayOf(now), wx = wxLookup(weather);
  const prev = prevLog?.version === FORECAST_VERSION ? prevLog : null;
  // andere Fassung der Selbstprüfung (EVAL_VERSION): Auswertungen und Lernstand neu aufbauen; ausgegebene Prognosen, Live-Abgleich und Verlauf bleiben
  const evalSame = prev?.evalVersion === EVAL_VERSION;
  const log = { version: FORECAST_VERSION, evalVersion: EVAL_VERSION, evals: evalSame ? { ...(prev?.evals || {}) } : {}, issued: { ...(prev?.issued || {}) }, live: { ...(prev?.live || {}) }, liveDropped: prev?.liveDropped || 0, history: [...(prev?.history || [])], activeSince: prev?.activeSince ?? null };
  const ctx = ctxLookup(incidents, curated), R = buildRows(days, wx, { ctx });
  const trainDays = new Set(Array.from(R.day)).size;
  // Langzeitgedächtnis (bleibt auch bei neuer Prüffassung): Tage, die das Fenster verlassen haben, übernehmen; Prior für das Fenstermodell
  const pm = prev?.memory?.v === MEMORY.v ? prev.memory : null;
  const mem = pm ? memoryResize({ v: MEMORY.v, upto: pm.upto, old: pm.old ? { ...pm.old } : null, days: { ...(pm.days || {}) }, wxDays: { ...(pm.wxDays || {}) } }) : emptyMemory();
  if (days.length) memoryMerge(mem, days[0].day);
  const prior = memoryPrior(mem, today);
  // Lernstand aus den eigenen Fehlern (log.feedback); fehlt er (erster Lauf, neue Fassung), wird das Fenster neu ausgewertet, damit das lernende
  // Modell sofort Vergleichswerte hat – Tage werden in zeitlicher Reihenfolge bewertet und erst danach in den Lernstand übernommen
  const pfb = evalSame && prev?.feedback?.v === FEEDBACK.v ? prev.feedback : null;
  const fb = pfb ? { ...emptyFeedback(), upto: pfb.upto, days: pfb.days || 0, groups: Object.fromEntries(Object.entries(pfb.groups || {}).map(([k, s]) => [k, [...s]])) } : emptyFeedback();
  // Lernstand der Mischung Chronos/Hybrid: nur fortschreiben, wenn auch der Lernstand von adaptive weiterläuft (sonst beide neu aus dem Fenster)
  const pfbC = pfb && prev?.feedbackC?.v === FEEDBACK.v ? prev.feedbackC : null;
  const fbC = pfbC ? { ...emptyFeedback(), upto: pfbC.upto, days: pfbC.days || 0, groups: Object.fromEntries(Object.entries(pfbC.groups || {}).map(([k, s]) => [k, [...s]])) } : emptyFeedback();
  // Rolling Origin: jeder volle, abgeschlossene Tag, der noch nicht ausgewertet ist (ältere Tage ohne Vortraining entfallen von selbst)
  const win = days.map((d, i) => (d.complete && d.day < today ? i : -1)).filter(i => i >= 0).slice(-(GATES.evalWindow + 2));
  const evalIdx = pfb ? win.filter(i => !log.evals[days[i].day]) : win;
  const ev = evaluateDays(R, evalIdx, { fb, dayName: (i) => days[i].day, expoBefore: (d) => lastExposure(days, d, { target: days[d].cls }), days, mem, prior, ext, fbC, wxTest: weatherFc ? wxLookup(weatherFc) : null });
  for (const [di, e] of Object.entries(ev)) {
    const test = []; for (let i = 0; i < R.n; i++) if (R.day[i] === +di) test.push(i);
    const mk = e.mask; e.models.naive = scoreDay(R, test, predictNaive(R, test, +di), 1, { split: true, mask: mk }); delete e.mask; delete e.maskWeek;
    const wk = days.findIndex(x => x.day === shiftDay(days[+di].day, -7)); if (wk >= 0) e.models.week = scoreDay(R, test, predictLag(R, test, wk), 1, { split: true, mask: mk }); // gleicher Wochentag der Vorwoche (fair mit derselben Maske, S2.2)
    log.evals[days[+di].day] = { trainDays: e.trainDays, wxGate: e.wxGate, ...(e.wxFc != null ? { wxFc: e.wxFc } : {}), ...(e.env ? { env: e.env } : {}), ...(e.expoErr != null ? { expoErr: e.expoErr } : {}), ...(e.expoErrAlt ? { expoErrAlt: e.expoErrAlt } : {}), models: e.models };
  }
  for (const d of Object.keys(log.evals).sort().slice(0, -21)) delete log.evals[d];
  // je Gemeinde nur so lange, wie die Korrektur sie liest (log.json bleibt klein)
  for (const d of Object.keys(log.evals).sort().slice(0, -(BIAS.days + 3))) for (const r of Object.values(log.evals[d]?.models || {})) delete r.byAgsType;
  log.feedback = compactFeedback(fb); log.feedbackC = compactFeedback(fbC);
  const all = Array.from({ length: R.n }, (_, i) => i);
  // neue vollständige Tage ins Gedächtnis (Beiträge aus einem Fenstermodell mit allen Wirkungen, die Daten haben; nur Zeilen mit Wetter, sofern vorhanden)
  {
    const withW = all.filter(i => R.hasW[i]), selM = withW.length ? withW : all, hasRows = new Set(selM.map(i => R.day[i]));
    const fresh = days.map((d, i) => (d.complete && d.day < today && !mem.days[d.day] && !(mem.old && d.day <= mem.old.at) && hasRows.has(i) ? i : -1)).filter(i => i >= 0);
    if (fresh.length) { const ctxAny = CTX_KEYS.map((_, k) => k).filter(k => selM.some(i => R.c[k][i])), mM = fitPooled(R, selM, { weather: withW.length > 0, ctx: ctxAny, prior }); memoryAddDays(mem, R, mM, selM, fresh, (i) => days[i].day); }
  }
  log.memory = compactMemory(mem);
  // Abgleich ausgegebener Prognosen (Live-Abgleich): bewertet, sobald die 24 Stunden vorbei sind (3 Stunden Puffer) und mindestens
  // GATES.liveMinHours davon beobachtet sind; Stunden ohne Beobachtung zählen nicht (bis 6.11.2026 mussten alle 24 beobachtet sein – nie bewertet).
  // Seit 6.11.2026 abends (v 2): alle Kandidaten als Schattenprognose (rec.shadow) und zwei faire Vergleichswerte – „wie gestern“ = letzte gleiche
  // Stunde, die zum Zeitpunkt der Ausgabe schon vorbei war (vorher: der Vortag des Zieltags, auch wenn er bei Ausgabe noch nicht vorlag), und gleicher
  // Wochentag der Vorwoche (fehlt er, gilt „wie gestern“). Alle Vergleiche über dieselben Stunden (beobachtet, mit Vergleichswert). Dazu Spitzen
  // (Deutschland-Summe und je Anbieter) und die Trefferquote des 80-%-Bands der veröffentlichten Prognose. lead = Abweichung der Summe je Vorlaufstunde.
  const dayBy = new Map(days.map(d => [d.day, d]));
  const actualOp = (day, h) => { const d = dayBy.get(day); if (!d || !(d.hourMin[h] >= GATES.hourMinObserved)) return null; const m = new Map(); for (const [k, g] of Object.entries(d.groups)) { const op = k.split('|')[1]; m.set(op, (m.get(op) || 0) + (g.start?.[h] || 0)); } return m; };
  let conf = prev?.conformal?.v === CONFORMAL.v ? prev.conformal : emptyConformal();
  for (const [at, rec] of Object.entries(log.issued)) {
    const endAt = rec.local?.length ? localToUtcMs(rec.local.at(-1)[0], rec.local.at(-1)[1]) + 3600e3 : Infinity;
    if (now < endAt + 3 * 3600e3) continue;
    const ops = Object.keys(rec.byOp || {}), comps = { [rec.model]: rec.byOp, ...(rec.shadow || {}) };
    const rows = [], rowsTot = [], lead = [], C = Object.fromEntries([...Object.keys(comps), 'naive', 'week'].map(m => [m, []])), pk = Object.fromEntries(Object.keys(C).map(m => [m, { de: { a: new Map(), f: new Map() }, ops: new Map() }]));
    let hours = 0, inside = 0, nBand = 0, hoursC = 0, pin = 0, pinY = 0; const kB = rec.kBand || conf.k, miss = CONFORMAL.bands.map(() => [0, 0]);
    for (let i = 0; i < rec.local.length; i++) {
      const [day, h] = rec.local[i], a = actualOp(day, h); if (!a) { lead.push(null); continue; }
      hours++;
      // Vergleichswerte, die bei Ausgabe bekannt waren
      let nv = null; for (let k = 1; k <= 7 && !nv; k++) { const pd = shiftDay(day, -k); if (localToUtcMs(pd, h) + 3600e3 <= +at) nv = actualOp(pd, h); }
      const wv = actualOp(shiftDay(day, -7), h) || nv;
      let tot = 0, totM = 0;
      for (const op of ops) { const y = a.get(op) || 0, f = rec.byOp[op][i]; rows.push([y, f]); tot += y; totM += f;
        const b = bandIx(h), wq = rec.bandQ?.[op]?.[i], [lo, hi] = wq ? bandOfQ(f, wq, kB[b] ?? 1) : bandOf80(f, rec.phi || 1, kB[b] ?? 1); nBand++; const ok = y >= lo && y <= hi; if (ok) inside++; miss[b][0] += ok ? 0 : 1; miss[b][1]++;
        pin += pinball(0.1, y, lo) + pinball(0.9, y, hi); pinY += y; }
      rowsTot.push([tot, totM]); lead.push(tot > 0 ? +(Math.abs(tot - totM) / tot).toFixed(3) : null);
      if (!nv) continue;
      hoursC++;
      const val = (m, op) => (m === 'naive' ? nv.get(op) || 0 : m === 'week' ? wv.get(op) || 0 : comps[m]?.[op]?.[i] ?? 0);
      for (const m of Object.keys(C)) for (const op of ops) {
        const y = a.get(op) || 0, f = val(m, op); C[m].push([y, f]);
        const P = pk[m], o = P.ops.get(op) || (P.ops.set(op, { a: new Map(), f: new Map() }), P.ops.get(op));
        for (const x of [P.de, o]) { x.a.set(i, (x.a.get(i) || 0) + y); x.f.set(i, (x.f.get(i) || 0) + f); }
      }
    }
    if (hours >= GATES.liveMinHours) {
      const s0 = wape(rows), t = wape(rowsTot), W = (m) => (C[m].length ? wape(C[m]) : null), nW = W('naive'), wW = W('week'), mW = W(rec.model);
      const models = Object.fromEntries(Object.keys(C).map(m => { const w = W(m), p = peakScore([pk[m].de, ...pk[m].ops.values()], { minHours: PEAK.minHoursLive }); return [m, { w: w && +w.wape.toFixed(4), ...(p ? { peak: p } : {}) }]; }));
      log.live[at] = { v: 2, model: rec.model, from: rec.from, hours, hoursC, wapeOpH: s0 && +s0.wape.toFixed(4), bias: s0 && +s0.bias.toFixed(4), wapeTotalH: t && +t.wape.toFixed(4),
        naiveOpH: nW && +nW.wape.toFixed(4), wapeOpHn: mW && +mW.wape.toFixed(4), weekOpH: wW && +wW.wape.toFixed(4), skill: mW && nW && nW.wape > 0 ? +(1 - mW.wape / nW.wape).toFixed(3) : null,
        cover80: nBand ? +(inside / nBand).toFixed(3) : null, pinball: pinY > 0 ? +(pin / pinY).toFixed(4) : null, kBand: kB, peak: models[rec.model]?.peak ?? null, models, starts: s0?.starts ?? 0, lead, ...(rec.ext ? { ext: rec.ext } : {}) };
      conf = conformalUpdate(conf, miss); // S2.7: Band nachführen
    } else log.liveDropped++; // zu wenige beobachtete Stunden: nicht bewertbar
    delete log.issued[at];
  }
  for (const k of Object.keys(log.live).sort().slice(0, -60)) delete log.live[k];
  log.conformal = conf;
  const prevActive = [...(prev?.history || [])].reverse().find(h => h.active)?.active ?? null;
  // S2.3: seit wann das aktive Modell gilt (log.activeSince, ab 13.11.2026 mitgeschrieben) – höchstens ein Wechsel je DECIDE.minSwitchDays
  const switchedAt = prev?.activeSince?.model && prev.activeSince.model === prevActive ? Date.parse(prev.activeSince.at) : null;
  let choice = chooseModel(log.evals, { trainDays, live: log.live, prevActive, switchedAt, nowMs: now }); const fbw = feedbackWeights(fb);
  // S2.6: E-Roller und Carsharing erst ab MIN_VOLUME Fahrtbeginnen je Tag (Mittel der letzten 7 vollständigen Tage, gezählt); darunter wird die
  // Vorwoche veröffentlicht (gleicher Wochentag, als Vergleichswert ausgewiesen) oder – ohne Vorwoche – nichts
  const volume = volumeOf(days), small = family && MIN_VOLUME[family] != null && volume != null && volume < MIN_VOLUME[family];
  if (small) { const hasWeek = days.some(d => d.day === shiftDay(today, -7)) || days.some(d => d.day === shiftDay(today, -6));
    choice = { ...choice, active: hasWeek ? 'week' : null, status: 'small', reason: `zu wenig Volumen: ${Math.round(volume)} Fahrtbeginne je Tag (Mittel 7 Tage, nötig ${MIN_VOLUME[family]}) – ${hasWeek ? 'veröffentlicht wird die Vorwoche' : 'keine Prognose'}`, why: { small: true, volume: Math.round(volume), min: MIN_VOLUME[family] } }; }
  const env = envOf(R, all, mem, prior), gate = env.gate, usesEnv = ['pooledWx', 'adaptive', 'hybrid', 'naive', 'week'].includes(choice.active) && env.on;
  const useWx = usesEnv && env.weather, envFit = env.on ? { weather: env.weather, ctx: env.ctx, prior } : {};
  const incSum = { days: incidents.filter(d => d?.ags).length, warnAt: incidents.map(d => d?.sources?.warn?.at).filter(Boolean).sort().at(-1) ?? null, roadAt: incidents.map(d => d?.sources?.road?.at).filter(Boolean).sort().at(-1) ?? null, curated: curated.length,
    upcoming: curated.filter(e => String(e.bis ?? e.von).slice(0, 10) >= today).slice(0, 10).map(e => ({ art: e.art, von: e.von, bis: e.bis ?? e.von, gebiet: e.gebiet, titel: e.titel ?? null, quelle: e.quelle })) };
  const support = Object.fromEntries(CTX_KEYS.map((k, j) => { let n = 0; const ds = new Set(); for (const i of all) if (R.c[j][i]) { n++; ds.add(R.day[i]); } return [k, { rows: n, days: ds.size, memRows: Math.round(prior?.n?.[3 + j] || 0), memDays: +(prior?.dk?.[3 + j] || 0).toFixed(1) }]; }));
  // zurückgehaltene Einträge (Lernphase: Veranstaltungen, Sport, Volksfeste erst ab pendingFrom): nur zählen, wie viele Gemeinde-Stunden sie
  // im Training kennzeichnen würden – fließt nicht ins Modell, zeigt im Dashboard „erfasst, wirkt ab …“
  if (pending?.length) {
    const pc = ctxLookup([], pending), agsOf = R.keys.map(k => k.split('|')[0]), pn = CTX_KEYS.map(() => 0), pd = CTX_KEYS.map(() => new Set());
    for (const i of all) { const x = pc(agsOf[R.g[i]], days[R.day[i]].day, R.hr[i]); for (let j = 0; j < NCTX; j++) if (x[j]) { pn[j]++; pd[j].add(R.day[i]); } }
    CTX_KEYS.forEach((k, j) => { if (pn[j]) support[k].pending = { rows: pn[j], days: pd[j].size }; });
  }
  const out = { version: FORECAST_VERSION, generatedAt: new Date(now).toISOString(), status: trainDays < GATES.minTrainDays ? 'insufficient' : choice.status, active: trainDays < GATES.minTrainDays ? null : (choice.active === 'pooledWx' && !env.on ? 'pooled' : choice.active), reason: choice.reason, scores: choice.scores, evalDays: choice.evalDays, trainDays,
    volume: volume == null ? null : Math.round(volume), ...(small ? { minVolume: MIN_VOLUME[family] } : {}),
    excluded: exclude?.size || 0, gates: { ...GATES }, weather: { gate, used: useWx, source: weather.length ? weather[0].source ?? null : null },
    env: { keys: CTX_KEYS, ready: env.ctx.map(k => CTX_KEYS[k]), active: usesEnv ? env.ctx.map(k => CTX_KEYS[k]) : [], support, sources: incSum, ...(pending?.length && pendingFrom ? { pendingFrom } : {}) }, memory: null,
    band: { level: CONFORMAL.target, z: Z80, k: conf.k, bands: CONFORMAL.bands, n: conf.n, source: 'poisson' }, // S2.7: Band je Stunde = k[Band(h)] · z · √(φ·μ) + 0,5; bei Chronos/Mischung aus den Quantilen (source 'chronos')
    decision: { rule: { ...DECIDE, dm: { ...DM } }, live: choice.live || null, combined: choice.combined || null, why: choice.why || null, dm: choice.dm || null },
    learn: fb.upto ? learnSummary(fb, fbw) : null,
    blend: { activeFrom: new Date(BLEND.activeFrom).toISOString(), chronos: ext ? { at: ext.at, model: ext.model, backDays: ext.backDays } : null, learn: fbC.upto ? learnSummary(fbC, feedbackWeights(fbC)) : null },
    horizon: null, totals: null, groups: {}, municipalities: {} };
  const tomorrow = dayOf(localToUtcMs(today, 12) + 24 * 3600e3);
  let live = new Map(); const liveFrom = {}; let portable = null;
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
    const last = lastExposure(days), byDay = new Map(), expo = (k, h, f) => { let m = byDay.get(f.day); if (!m) byDay.set(f.day, m = lastExposure(days, days.length, { target: f.cls })); return m.get(k)?.[h] ?? 0; };
    const F = buildFuture(R, fut, expo, wx, ctx), sel = Array.from({ length: F.n }, (_, i) => i);
    // Ausgabe fällig? Dann alle Kandidaten mitrechnen (Schattenprognosen für den Live-Abgleich)
    const lastIssued = Math.max(0, ...Object.keys(log.issued).map(Number)), issuing = now - lastIssued >= issueEveryMs;
    const chronosOn = !!ext?.usable(t0), chronosOf = chronosOn ? (i) => ext.live(R.keys[F.g[i]], fut[F.fh[i]].t) : null;
    const cands = [...MODELS.filter(m => (m !== 'pooledWx' || env.on) && (m !== 'blend' || chronosOn)), ...(chronosOn ? SHADOW_ONLY : [])], want = new Set([out.active, ...(issuing ? cands : [])]);
    const PA = predictAll(R, days, days.length, all, F, sel, want, { envFit, fb, dayOfRow: (i) => fut[F.fh[i]].day, chronosOf, fbC });
    try { portable = portableModel(PA.fitted(), R, { family: family || 'micro', now, trainDays: out.trainDays, active: out.active, days: days.map(d => d.day) }); } catch { portable = null; }
    // S2.8: Verzerrung je Art korrigieren (je Modell aus dessen Selbstprüfung; Vergleichswerte bleiben roh)
    const biasCorr = {};
    for (const [m, arr] of PA.mu) { if (!BIAS.models.includes(m)) continue; const tf = typeFactors(log.evals, m); if (!Object.keys(tf).length) continue; const af = agsFactors(log.evals, m, tf);
      biasCorr[m] = { ...tf, ...(Object.keys(af).length ? { ags: af } : {}) };
      PA.mu.set(m, Float64Array.from(arr, (x, j) => x * biasFactorOf(R.keys[F.g[sel[j]]], tf, af))); }
    out.biasCorr = Object.keys(biasCorr).length ? biasCorr : null; out.breaks = broken;
    let mu = PA.mu.get(out.active), phi = PA.phi(out.active);
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
    if (issuing) {
      const opOf = (m) => { const o = new Map(); sel.forEach((i, j) => { if (F.fh[i] >= horizon) return; const op = R.keys[F.g[i]].split('|')[1]; let a = o.get(op); if (!a) o.set(op, a = new Array(horizon).fill(0)); a[F.fh[i]] += m[j]; }); return Object.fromEntries([...o].map(([k, a]) => [k, a.map(x => Math.round(x * 10) / 10)])); };
      const shadow = Object.fromEntries([...PA.mu].filter(([m]) => m !== out.active && cands.includes(m)).map(([m, v]) => [m, opOf(v)]));
      // Chronos-Meta: Stand des Laufs, Alter bei Ausgabe, Anteil der Fahrten (aktives Modell) in Gruppen mit Chronos-Wert
      let extMeta = null;
      if (chronosOn) { let cov = 0, tot = 0; sel.forEach((i, j) => { if (F.fh[i] >= horizon) return; tot += mu[j]; if (Number.isFinite(chronosOf(i))) cov += mu[j]; }); extMeta = { chronos: { at: ext.at, ageH: +((t0 - Date.parse(ext.at)) / 3600e3).toFixed(1), cover: tot > 0 ? +(cov / tot).toFixed(3) : 0 } }; }
      const bandQ = chronosOn && QBAND_MODELS.includes(out.active) && typeof ext.quant === 'function' ? quantileBands(R.keys, sel.map(i => [F.g[i], F.fh[i], fut[F.fh[i]].t]), ext.quant, horizon) : null;
      if (bandQ) out.band.source = 'chronos';
      log.issued[now] = { v: 2, model: out.active, from: t0, phi: +phi.toFixed(2), kBand: [...conf.k], ...(bandQ ? { bandQ } : {}), local: out.horizon.local, total: out.totals, byOp: Object.fromEntries([...byOp].map(([k, a]) => [k, a.slice(0, horizon).map(x => Math.round(x * 10) / 10)])), shadow, ...(extMeta ? { ext: extMeta } : {}) };
    }
    log.history.push({ at: out.generatedAt, active: out.active, status: out.status, reason: out.reason });
    log.activeSince = prev?.activeSince?.model === out.active ? prev.activeSince : { model: out.active, at: out.generatedAt };
  } else log.history.push({ at: out.generatedAt, active: null, status: out.status, reason: out.status === 'small' ? out.reason : `${trainDays} Tage Daten – zu wenig` });
  log.history = log.history.slice(-60);
  out.memory = memorySummary(mem, today, out.phi ?? 1);
  out.live = Object.entries(log.live).sort((a, b) => a[0] - b[0]).slice(-12).map(([at, v]) => ({ at: +at, ...v }));
  // Stundenreihen für das Dashboard: Plan heute (und für noch nicht gespeicherte, abgeschlossene Tage), Ist, Live-Prognose bis Ende morgen
  const plans = new Map(), has = (d) => Object.values(prevSeries?.version === 1 ? prevSeries.days?.[d] || {} : {}).some(x => x.p), keepFrom = dayOf(now - (SERIES_KEEP_DAYS - 1) * 86400e3);
  if (trainDays >= GATES.minTrainDays) {
    days.forEach((d, pi) => { if (d.day >= keepFrom && d.day < today && d.complete && !has(d.day)) { const r = planDay(R, days, pi, d.day, wx, calendar, log.evals, fb, { mem, prior, ctx, live: log.live, ext, fbC }); if (r) plans.set(d.day, r); } });
    if (!has(today)) { const ti = days.findIndex(d => d.day === today), r = planDay(R, days, ti >= 0 ? ti : days.filter(d => d.day < today).length, today, wx, calendar, log.evals, fb, { mem, prior, ctx, live: log.live, ext, fbC }); if (r) plans.set(today, r); }
  }
  const series = buildSeries({ days, today, tomorrow, plans, live, liveFrom, prev: prevSeries, now, status: out.status, active: out.active });
  if (family) { out.family = family; series.family = family; }
  return { latest: out, log, series, model: portable };
}
