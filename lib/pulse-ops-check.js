// @ts-check
// Mobility Pulse – Plan-Erfolgskontrolle (F31, Review 18.11.2026): Hat ein gemerkter Plan der Disposition gewirkt?
// Grundlage sind die Zelldateien (cells/<Tag>/<Land>.json, je Zelle und Band: Fahrtbeginne start×6, verfügbare Fahrzeuge present×6 als Summe über
// die Läufe, Läufe je Band bandRuns). Gemessen über alle Anbieter der Zelle – die Zelldateien kennen keine Anbieter.
//  - Befüllt: im Band nach dem Plan standen im Mittel mindestens halb so viele Fahrzeuge mehr als im Band des Plans wie gefordert (mindestens 1).
//  - Fahrtbeginne danach: Summe der Fahrtbeginne in den Zielzellen in den Bändern nach dem Plan, gegen das Mittel derselben Zellen und Bänder an den
//    Vergleichstagen (bis 7 Tage davor, gleiche Tagart Werktag/Wochenende, wenn genug da sind). Vergleichsgruppe: alle übrigen Zellen der Gemeinde mit
//    Fahrtbeginnen an den Vergleichstagen. Wirkung = (Ziel heute ÷ Ziel sonst) ÷ (übrige heute ÷ übrige sonst) − 1 (Differenz der Differenzen,
//    multiplikativ): Wetter und Wochentag treffen beide Gruppen und kürzen sich heraus. Kein Intervall; wenige Zellen sind ein Hinweis, kein Beweis.
import { BANDS, bandOf } from './pulse-track-rules.js';

export const CHECK = Object.freeze({ version: 1, keep: 30, baseDays: 7, minBaseStarts: 5 });
const offsets = (doc) => { const F = String(doc?.fields || '').split(','), at = (name) => { const i = F.indexOf(name); return i < 0 ? -1 : F.slice(0, i).reduce((n, f) => n + (/×6$/.test(f) ? 6 : 1), 0); }; return { s: at('start×6'), p: at('present×6') }; };

/**
 * Plan der Disposition zum Merken: Zielzellen mit Fehlmenge aus planRebalance (needs). Rückgabe null ohne Ziel.
 * @param {any} plan S.plan der Disposition @param {{ at: number, day: string, hour: number, state: string, name?: string }} when
 */
export function planRecord(plan, { at, day, hour, state, name = '' }) {
  const needs = (plan?.rebalance?.needs || []).filter((/** @type {any} */ n) => n.need > 0 && n.cell);
  if (!needs.length) return null;
  return { v: CHECK.version, at, day, band: bandOf(hour), ags: plan.ags, state, name, op: plan.op, type: plan.type || 'all', spots: needs.map((/** @type {any} */ n) => ({ cell: n.cell, need: n.need, have: n.have })) };
}

/**
 * Wirkung eines gemerkten Plans. dayDoc: Zelldatei des Plantags, baseDocs: Zelldateien der Tage davor (gleiches Land).
 * Rückgabe { status: 'wartet' | 'ok' | 'ohne Daten', filled, spots, after, afterBase, ratioT, ratioC, effect, bands, baseDays } – status 'wartet', solange
 * kein Band nach dem Plan gemessen ist.
 * @param {any} rec planRecord @param {any} dayDoc @param {any[]} baseDocs @param {{ weekend?: (day: string) => boolean }} [opts]
 */
export function planCheck(rec, dayDoc, baseDocs, { weekend = null } = {}) {
  const cells = dayDoc?.munis?.[rec.ags]; if (!cells) return { status: 'ohne Daten' };
  const O = offsets(dayDoc), runs = dayDoc.bandRuns || [], b0 = rec.band, after = BANDS.map(b => b.id).filter(b => b > b0 && (runs[b] || 0) > 0);
  if (!after.length || O.s < 0 || O.p < 0) return { status: 'wartet', spots: rec.spots.length };
  const pres = (v, b) => ((runs[b] || 0) > 0 ? (v?.[O.p + b] || 0) / runs[b] : 0), st = (v, bs) => bs.reduce((n, b) => n + (v?.[O.s + b] || 0), 0);
  const filled = rec.spots.filter((/** @type {any} */ sp) => pres(cells[sp.cell], after[0]) - pres(cells[sp.cell], b0) >= Math.max(1, sp.need / 2)).length;
  // Vergleichstage: gleiche Tagart, wenn mindestens 3 vorhanden, sonst alle
  const same = weekend ? baseDocs.filter(d => weekend(d.day) === weekend(rec.day)) : baseDocs, base = (same.length >= 3 ? same : baseDocs).filter(d => d?.munis?.[rec.ags]).slice(-CHECK.baseDays);
  if (!base.length) return { status: 'ohne Daten', filled, spots: rec.spots.length };
  const target = new Set(rec.spots.map((/** @type {any} */ s) => s.cell)), bo = base.map(offsets);
  const mean = (cell) => base.reduce((n, d, i) => n + (bo[i].s < 0 ? 0 : after.reduce((m, b) => m + (d.munis[rec.ags][cell]?.[bo[i].s + b] || 0), 0)), 0) / base.length;
  let tNow = 0, tBase = 0, cNow = 0, cBase = 0;
  const all = new Set([...Object.keys(cells), ...base.flatMap(d => Object.keys(d.munis[rec.ags]))]);
  for (const cell of all) { const now = st(cells[cell], after), was = mean(cell); if (target.has(cell)) { tNow += now; tBase += was; } else if (was > 0) { cNow += now; cBase += was; } }
  const ratioT = tBase > 0 ? tNow / tBase : null, ratioC = cBase > 0 ? cNow / cBase : null;
  const effect = ratioT != null && ratioC && tBase >= CHECK.minBaseStarts ? ratioT / ratioC - 1 : null;
  const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);
  return { status: 'ok', filled, spots: rec.spots.length, after: tNow, afterBase: Math.round(tBase * 10) / 10, ratioT: r3(ratioT), ratioC: r3(ratioC), effect: r3(effect), bands: after, baseDays: base.length };
}
