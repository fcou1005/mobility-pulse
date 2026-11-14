// Mobility Pulse – S6.3 Zensurkorrigierte Nachfrage und Soll-Verteilung je Tageszeit-Band (F12)
// Ohne Angebot kann keine Fahrt beginnen: eine Zelle, in der morgens nie ein Fahrzeug stand, zeigt null Starts, obwohl dort Nachfrage
// sein kann (Zensur). Seit 14.11.2026 schreibt der Sammler je Zelle und Band die Läufe mit Angebot (cells: Felder 22–27, CELL_SUPPLY).
// Nachfrage je Zelle und Band = Starts ÷ Stunden mit Angebot, geglättet (Empirical Bayes: Vorwert aus den 8 Nachbarzellen, sonst der
// Gemeinde, Gewicht priorH Stunden). Tage ohne Angebotsfelder (vor dem 14.11.) zählen wie bisher mit der vollen Bandlänge (unzensiert).
// Soll je Band: verfügbare Flotte im Verhältnis der Nachfrage auf die Zellen verteilt (größte Reste, Summe = Flotte), Lagerflächen
// (isStorageCell: viele Umsetzungen, wenige Starts) und Zellen außerhalb von allow(cell) ausgenommen.
import { BANDS, CELL_SUPPLY, cellCenter } from './pulse-track.js';
import { isStorageCell, sum } from './pulse-ops-model.js';
import { csvRows, spotsCsv } from './pulse-ops-tours.js';

export const SOLL = Object.freeze({ priorH: 1, neighborMinH: 1 });
const parse = (cell) => { const i = cell.indexOf(':'); return [+cell.slice(0, i), +cell.slice(i + 1)]; };

/**
 * Zensurkorrigierte Nachfrage für ein Band (0–5) aus Tageszellen (cells/<Tag>/<Land>.json bzw. ops-input, wie buildDemandModel).
 * Rückgabe { ags, band, days, daysCensored, bandH (Messstunden des Bands), pooled (Starts/h je Zelle mit Angebot), cells: Map(zelle → { cell,
 *   lat, lon, starts, ends, reloc, startsDay, supplyH, rate (geglättet, Starts/h), rateRaw (Starts ÷ Stunden mit Angebot), prior, storage }) }
 */
export function censoredDemand(cellDocs, ags, band, { priorH = SOLL.priorH, neighborMinH = SOLL.neighborMinH } = {}) {
  const b = +band; if (!(b >= 0 && b < BANDS.length)) throw new Error(`Band ${band} unbekannt`);
  const cells = new Map(), E = (cell) => { let e = cells.get(cell); if (!e) cells.set(cell, e = { cell, starts: 0, ends: 0, reloc: 0, startsDay: 0, supplyH: 0, openH: 0 }); return e; };
  let days = 0, daysCensored = 0, bandH = 0, openH = 0;
  for (const doc of cellDocs || []) {
    const m = doc?.munis?.[ags]; if (!m) continue;
    const runs = doc.bandRuns?.[b] || 0, min = doc.bandMin?.[b] || 0; if (!(runs > 0 && min > 0)) continue;
    const vals = Object.values(m).filter(Array.isArray), censored = vals.length > 0 && vals.every(c => c.length >= CELL_SUPPLY + BANDS.length);
    days++; bandH += min / 60; if (censored) daysCensored++; else openH += min / 60;
    const perRunH = min / runs / 60;
    for (const [cell, c] of Object.entries(m)) {
      if (!Array.isArray(c) || c.length < 22) continue;
      const e = E(cell); e.starts += c[4 + b] || 0; e.ends += c[16 + b] || 0; e.reloc += c[3] || 0; e.startsDay += c[0] || 0;
      if (censored) e.supplyH += Math.min(runs, c[CELL_SUPPLY + b] || 0) * perRunH;
    }
  }
  // unzensierte Tage: jede Zelle des Fensters gilt die ganze Bandlänge als versorgt (wie buildDemandModel)
  for (const e of cells.values()) e.supplyH += openH;
  let S = 0, H = 0; for (const e of cells.values()) { S += e.starts; H += e.supplyH; }
  const pooled = H > 0 ? S / H : 0;
  for (const e of cells.values()) {
    const [i, j] = parse(e.cell); let nS = 0, nH = 0;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) { if (!di && !dj) continue; const n = cells.get(`${i + di}:${j + dj}`); if (n) { nS += n.starts; nH += n.supplyH; } }
    e.prior = nH >= neighborMinH ? nS / nH : pooled;
    e.rateRaw = e.supplyH > 0 ? e.starts / e.supplyH : null;
    e.rate = (e.starts + priorH * e.prior) / (e.supplyH + priorH);
    e.storage = isStorageCell(e);
    const [lat, lon] = cellCenter(e.cell); e.lat = lat; e.lon = lon; delete e.openH;
  }
  return { ags, band: b, days, daysCensored, bandH, pooled, cells };
}

/**
 * Soll-Verteilung: fleet Fahrzeuge (verfügbare Flotte des Anbieters) auf die Zellen nach rate; Lagerflächen und Zellen mit allow(e) = false
 * bekommen nichts. Ganzzahlig nach größten Resten, Summe = fleet (solange es Zellen mit Nachfrage gibt).
 * Rückgabe { band, fleet, sum, storageExcluded, notAllowed, cells: [{ cell, lat, lon, soll, rate, rateRaw, supplyH, starts, share }] } (Soll absteigend)
 */
export function sollPlan(dem, { fleet = 0, allow = null } = {}) {
  const all = [...(dem?.cells?.values() || [])];
  const storage = all.filter(e => e.storage), blocked = all.filter(e => !e.storage && allow && !allow(e));
  const cand = all.filter(e => !e.storage && (!allow || allow(e)) && e.rate > 0);
  const W = sum(cand.map(e => e.rate)), N = Math.max(0, Math.round(fleet));
  const rows = cand.map(e => { const q = W > 0 ? N * e.rate / W : 0; return { e, q, soll: Math.floor(q) }; });
  let left = N - sum(rows.map(r => r.soll));
  for (const r of rows.slice().sort((a, b) => (b.q - b.soll) - (a.q - a.soll) || b.e.rate - a.e.rate || (a.e.cell < b.e.cell ? -1 : 1))) { if (left <= 0) break; r.soll++; left--; }
  const cells = rows.map(({ e, soll }) => ({ cell: e.cell, lat: e.lat, lon: e.lon, soll, rate: +e.rate.toFixed(3), rateRaw: e.rateRaw == null ? null : +e.rateRaw.toFixed(3), supplyH: +e.supplyH.toFixed(2), starts: e.starts, share: W > 0 ? +(e.rate / W).toFixed(4) : 0 }))
    .sort((a, b) => b.soll - a.soll || b.rate - a.rate);
  return { band: dem?.band ?? null, fleet: N, sum: sum(cells.map(c => c.soll)), storageExcluded: storage.length, notAllowed: blocked.length, days: dem?.days ?? 0, daysCensored: dem?.daysCensored ?? 0, cells };
}

export const SOLL_FIELDS = ['zelle', 'lat', 'lng', 'band', 'soll', 'nachfrage_je_h', 'starts_je_h_mit_angebot', 'stunden_mit_angebot', 'starts', 'anteil'];
const SOLL_EN = { zelle: 'cell', band: 'band', soll: 'target', nachfrage_je_h: 'demand_per_h', starts_je_h_mit_angebot: 'starts_per_h_with_supply', stunden_mit_angebot: 'hours_with_supply', starts: 'starts', anteil: 'share' };
/** Soll als Auswertungs-CSV (Deutsch: Semikolon; Englisch: Komma, englische Spalten); nur Zellen mit Soll ≥ 1 */
export function sollCsv(plan, { lang = 'de' } = {}) {
  const head = lang === 'en' ? SOLL_FIELDS.map(h => SOLL_EN[h] ?? h) : SOLL_FIELDS, band = BANDS[plan.band]?.label ?? plan.band;
  const rows = plan.cells.filter(c => c.soll > 0).map(c => [c.cell, c.lat.toFixed(6), c.lon.toFixed(6), band, c.soll, c.rate, c.rateRaw ?? '', c.supplyH, c.starts, c.share]);
  return csvRows([head, ...rows], lang === 'en' ? ',' : ';');
}
/** Soll als Spots-CSV im Backend-Format (spotsCsv: name, lat, lng, deploymentStatus, parkingStatus, deploymentRadius, deploymentVehicles) */
export function sollSpotsCsv(plan, { name = 'Soll', radius = 50 } = {}) {
  const label = `${name} ${BANDS[plan.band]?.label ?? ''}`.trim();
  return spotsCsv(plan.cells.filter(c => c.soll > 0).map((c, i) => ({ rank: i + 1, lat: c.lat, lon: c.lon, target: c.soll })), { name: label, radius });
}
