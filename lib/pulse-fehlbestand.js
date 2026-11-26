// @ts-check
// Wo fehlen laut Prognose Fahrzeuge? (26.11.2026) Übersicht je Gemeinde und Anbieter mit derselben Rechnung wie Prognose › Spots (rateSpots in
// lib/pulse-spots.js): Soll je Spot aus der Prognose der nächsten Stunden und der gemessenen Nachfrage der Zelle, Ist = verfügbare Fahrzeuge
// des Anbieters im Umkreis, Fehlbestand = Soll − Ist. Der Sammler rechnet alle Gemeinden mit Prognose auf einmal (forecast/fehlbestand.json);
// die Seite zeigt die größten Lücken und führt zu den Spots der Gemeinde.
import { rateSpots } from './pulse-spots.js';
import { familyOf } from './pulse-core.js';

export const GAPS = Object.freeze({ top: 6, minMissing: 1 }); // top: größte Lücken je Gemeinde × Anbieter (Tabelle zeigt 3, Karte alle)

/**
 * Zeilen je Gemeinde × Anbieter mit Fehlbestand, sortiert nach Fehlbestand an wichtigen Spots (Klasse A und B), dann gesamt.
 * groups: forecast/latest.json → groups ({ 'AGS|Anbieter|Art': { start[24] } }, ab der nächsten vollen Stunde); landOf(ags) → Land;
 * fleetOf(land) → decodeFleet(ops/<Land>.json) | null; demandOf(land, ags) → Nachfragemodell | null; placesOf(ags) → groupPlaces(...) | null.
 * @param {{ groups: Record<string, { start?: number[] }>, landOf: (ags: string) => string|null|undefined, fleetOf: (land: string) => any,
 *   demandOf: (land: string, ags: string) => any, placesOf: (ags: string) => any, quota?: any }} p
 */
export function shortageRows({ groups, landOf, fleetOf, demandOf, placesOf, quota = null }) {
  const by = new Map();
  for (const [k, g] of Object.entries(groups || {})) {
    const [ags, op, ty] = k.split('|'); if (!ags || !op || familyOf(ty) !== 'micro' || !Array.isArray(g?.start)) continue;
    let d = by.get(`${ags}|${op}`); if (!d) by.set(`${ags}|${op}`, d = new Array(24).fill(0));
    g.start.forEach((v, h) => { if (h < 24) d[h] += +v || 0; });
  }
  const rows = [];
  for (const [key, day24] of by) {
    const [ags, op] = key.split('|'), land = landOf(ags); if (!land) continue;
    const fleet = fleetOf(land); if (!fleet) continue;
    const R = rateSpots(fleet, { ags, op, demand: demandOf(land, ags), groups: placesOf(ags), quota, fc: { day24 }, type: 'all' }), T = R.total;
    if (!(T.missing >= GAPS.minMissing)) continue;
    rows.push({ ags, op, missing: Math.round(T.missing), missingAB: Math.round(T.missingAB), spotsMissing: T.spotsMissing, spots: T.spots, have: T.have,
      expected: Math.round(R.fc?.nextH ?? 0), horizonH: R.horizonH, prelim: !!R.prelim,
      top: R.items.filter(x => x.missing > 0).slice(0, GAPS.top).map(x => ({ label: x.label || '', lat: +(+x.lat).toFixed(5), lon: +(+x.lon).toFixed(5), missing: Math.round(x.missing * 10) / 10, cls: x.cls })) });
  }
  return rows.sort((a, b) => b.missingAB - a.missingAB || b.missing - a.missing || a.ags.localeCompare(b.ags));
}
