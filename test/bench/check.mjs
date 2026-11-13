// Gemeinsame Prüfungen des Prüfstands (P1): ein Regel-Modul über alle Szenarien × Kennungsarten rechnen, gegen eine Basis vergleichen.
// Ausgabe im Format der Repo-Tests: „ok: …“ / „FEHLER: …“ (zählen), „Hinweis: …“ (Zielgrenze verfehlt, bricht nicht ab).
import * as SIM from './sim.mjs';
import { runCase, metrics, table, TRACK } from './bench.mjs';

export const assert = (c, m) => { if (!c) { console.log('FEHLER:', m); process.exitCode = 1; } else console.log('ok:', m); };
export const note = (c, m) => { if (!c) console.log('Hinweis:', m); };

// Zielgrenzen (Abnahme einer neuen Regelversion) je Szenario; null = nicht geprüft. Anteile, nicht Prozent.
const Z = { precision: 0.97, recall: 0.95, count: 0.03, dur: 0.15, dist: 0.10, vanAsTrip: 0.05, vmin: 0.01, modeOk: 0.99 };
export const LIMITS = {
  basis: { ...Z }, gps: { ...Z }, 'res-sperre': { ...Z, precision: 0.95 }, akku: { ...Z, precision: 0.95 },
  umsetzung: { ...Z, precision: 0.95 }, kurz: { ...Z, recall: 0.93 }, rundfahrt: { ...Z, recall: 0.90, dist: 0.15 },
  luecken: { ...Z, recall: null, count: 0.05 }, alles: { ...Z, precision: 0.90, recall: 0.88, count: 0.05, dist: 0.15 },
  klein50: { ...Z, count: 0.05 }, klein25: { ...Z, count: 0.05, modeOk: null }, ausblendung: { ...Z, precision: 0.95 },
  ausfall: { ...Z, recall: null, count: null }, sommerzeit: { ...Z }, rad: { ...Z, recall: 0.85, count: 0.15 }, 'rad-wechsel': { ...Z, recall: 0.85, count: 0.15 },
  teilausfall: { ...Z, count: 0.08 },
};
export const TOL = { rate: 0.02, van: 0.05, mode: 0.02 }; // erlaubte Verschlechterung gegen die Basis

const r1 = (x) => x == null ? null : Math.round(x * 1e4) / 1e4;
/** Alle Fälle rechnen; Rückgabe { out: { 'szenario/kennung': Kennzahlen }, rows, ms } */
export async function runAll(file = 'pulse-track.js', { checkTrace = true, scenarios = Object.keys(SIM.SCENARIOS) } = {}) {
  const T = await TRACK(file), out = {}, rows = [], t0 = Date.now();
  let traced = !checkTrace;
  for (const sc of scenarios) {
    const w = SIM.simulate({ ...SIM.SCENARIOS[sc], seed: 1 });
    for (const mode of SIM.ID_MODES) {
      const check = !traced && sc === 'alles' && mode === 'trip';
      const res = await runCase(w, mode, { T, check }), m = metrics(w, mode, res, T), id = `${sc}/${mode}`;
      if (check) { assert(res.equal, `${file} ${id}: trace-Rückruf ändert nichts (hourly, srcModes, state gleich)`); traced = true; }
      assert(m.tp + m.fp === m.detected && m.detected === m.detectedLog, `${file} ${id}: Buchhaltung TP + FP = erkannt (${m.detected})`);
      out[id] = { precision: r1(m.precision), recall: r1(m.recall), countErr: r1(m.countErr), endRatio: r1(m.endRatio), durErr: m.durN >= 20 ? r1(m.durErr) : null, distErr: m.distN >= 20 ? r1(m.distErr) : null, vanAsTrip: r1(m.vanAsTrip), vminErr: r1(m.vminErr), modeOk: r1(m.modeOk), modeFlips: m.modeFlips, gapRuns: m.gapRuns, fnWhy: m.fnWhy, fpWhy: m.fpWhy };
      rows.push({ sc, mode, m });
    }
  }
  return { out, rows, T, ms: Date.now() - t0 };
}

/** Zielgrenzen als Hinweise, Fahrzeugminuten hart */
export function targets(out, label) {
  for (const [id, o] of Object.entries(out)) {
    const L = LIMITS[id.split('/')[0]], P = (x, d = 1) => (100 * x).toFixed(d);
    if (L.precision != null && o.precision != null) note(o.precision >= L.precision, `${label} ${id}: Präzision ${P(o.precision)} % < Ziel ${100 * L.precision} %`);
    if (L.recall != null && o.recall != null) note(o.recall >= L.recall, `${label} ${id}: Trefferquote ${P(o.recall)} % < Ziel ${100 * L.recall} %`);
    if (L.count != null && o.countErr != null) note(Math.abs(o.countErr) <= L.count, `${label} ${id}: Fahrtenzahl ${P(o.countErr)} % außerhalb ±${100 * L.count} %`);
    if (L.dur != null && o.durErr != null) note(Math.abs(o.durErr) <= L.dur, `${label} ${id}: Ø Dauer ${P(o.durErr, 0)} % außerhalb ±${100 * L.dur} %`);
    if (L.dist != null && o.distErr != null) note(Math.abs(o.distErr) <= L.dist, `${label} ${id}: Ø Distanz ${P(o.distErr, 0)} % außerhalb ±${100 * L.dist} %`);
    if (L.vanAsTrip != null && o.vanAsTrip != null) note(o.vanAsTrip <= L.vanAsTrip, `${label} ${id}: Umsetzung als Fahrt ${P(o.vanAsTrip, 0)} % > Ziel ${100 * L.vanAsTrip} %`);
    if (L.modeOk != null && o.modeOk != null) note(o.modeOk >= L.modeOk, `${label} ${id}: Kennungsmodus nur in ${P(o.modeOk, 0)} % der Tagesläufe richtig`);
    assert(o.vminErr == null || Math.abs(o.vminErr) <= Z.vmin, `${label} ${id}: Fahrzeugminuten ${P(o.vminErr ?? 0, 2)} % innerhalb ±1 %`);
  }
}

/** Keine Verschlechterung gegen eine Basis (hart); skip = Fälle, die bewusst anders rechnen dürfen */
export function noWorse(out, base, label, { skip = new Set() } = {}) {
  const P = (x) => (100 * x).toFixed(1);
  for (const [id, o] of Object.entries(out)) {
    const b = base?.[id]; if (!b || skip.has(id)) continue;
    if (o.precision != null && b.precision != null) assert(o.precision >= b.precision - TOL.rate && o.recall >= b.recall - TOL.rate, `${label} ${id}: Präzision/Treffer nicht schlechter als Basis − 2 Pp (${P(o.precision)}/${P(o.recall)} gegen ${P(b.precision)}/${P(b.recall)})`);
    if (o.countErr != null && b.countErr != null) assert(Math.abs(o.countErr) <= Math.abs(b.countErr) + TOL.rate, `${label} ${id}: |Δ Fahrtenzahl| ${P(Math.abs(o.countErr))} ≤ Basis ${P(Math.abs(b.countErr))} + 2 Pp`);
    if (b.vanAsTrip != null && o.vanAsTrip != null) assert(o.vanAsTrip <= b.vanAsTrip + TOL.van, `${label} ${id}: Umsetzung als Fahrt ${P(o.vanAsTrip)} ≤ Basis ${P(b.vanAsTrip)} + 5 Pp`);
    if (b.modeOk != null && o.modeOk != null) assert(o.modeOk >= b.modeOk - TOL.mode, `${label} ${id}: Kennungsmodus nicht instabiler als Basis (${P(o.modeOk)} gegen ${P(b.modeOk)} %)`);
  }
}
export { table, SIM };
