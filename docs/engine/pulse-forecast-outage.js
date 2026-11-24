// @ts-check
// Ausfallstunden je Gruppe (24.11.2026): Stunden, in denen die Quelle einer Gruppe mindestens einen Lauf lang nicht geliefert hat, aus history/<Tag>.json
// (series[Gruppe].total je Lauf, null = Quelle im Fehler). In solchen Stunden fehlen Fahrtbeginne, während Fahrzeugminuten zum Teil gezählt sind;
// nach einem Ausfall erscheinen Fahrzeuge an neuen Orten, ein Teil davon zählt als Fahrt. Rückblick 2.–23.11.2026: Stunden mit 1–2 von 3 Läufen im
// Fehler Ist ÷ Erwartung 0,92–0,94, Stunden mit fast nur Fehlern 4,4 bis 58 (Scheinfahrten auf winzigen Fahrzeugminuten). Diese Gruppen-Stunden
// lernen und zählen in der Selbstprüfung nicht mit (buildRows); das Ist im Verlauf bleibt.
// Nur Gruppen mit mindestens OUTAGE.minMedian Fahrzeugen (Tagesmedian): markiert wird die Stunde jedes Laufs ohne Wert (null) oder mit Einbruch unter
// OUTAGE.drop × Median und die Stunde des ersten Laufs danach. Kleine Gruppen fehlen in einem Lauf auch ohne Ausfall (null = kein Fahrzeug im Ort),
// Stationsflotten und Carsharing zeigen gebuchte Fahrzeuge nicht (Probe 8.11.: 166 Gruppen mit ≥ 8 Stunden bei 50 % des Medians).

export const OUTAGE = Object.freeze({ drop: 0.1, minMedian: 50 });

const hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', hourCycle: 'h23' });
const localHour = (/** @type {number} */ ms) => +hourFmt.format(new Date(ms)) % 24;

/**
 * Ausfallmaske eines Tages: { Gruppe: Bitmaske der Ortsstunden 0–23 } (nur Gruppen mit Ausfall). hist = history/<Tag>.json oder null.
 * @param {{ t?: number[], series?: Record<string, { total?: (number|null)[] }> } | null} hist
 * @returns {Record<string, number>}
 */
export function outageMask(hist, { drop = OUTAGE.drop, minMedian = OUTAGE.minMedian } = {}) {
  const out = /** @type {Record<string, number>} */ ({}), t = Array.isArray(hist?.t) ? hist.t : [];
  if (!t.length || !hist?.series) return out;
  const hr = t.map(localHour);
  for (const [k, s] of Object.entries(hist.series)) {
    const tot = s?.total; if (!Array.isArray(tot)) continue;
    const ok = tot.filter(x => x != null).sort((a, b) => a - b), med = ok.length ? ok[Math.floor(ok.length / 2)] : 0;
    let m = 0, after = false;
    for (let i = 0; i < t.length && i < tot.length; i++) {
      const bad = med >= minMedian && (tot[i] == null || tot[i] < drop * med);
      if (bad || after) m |= 1 << hr[i];
      after = bad;
    }
    if (m) out[k] = m;
  }
  return out;
}

/** Anteil markierter Gruppen-Stunden je Tag (für das Protokoll): { Tag: [Gruppen, Stunden] } */
export function outageSummary(/** @type {Record<string, Record<string, number>>} */ masks) {
  const pop = (/** @type {number} */ x) => { let c = 0; for (; x; x &= x - 1) c++; return c; };
  return Object.fromEntries(Object.entries(masks || {}).map(([d, m]) => [d, [Object.keys(m).length, Object.values(m).reduce((a, x) => a + pop(x), 0)]]));
}
