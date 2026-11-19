// Plan-Erfolgskontrolle (F31, lib/pulse-ops-check.js): gemerkter Plan, Befüllung, Fahrtbeginne gegen Vergleichstage und übrige Zellen
import * as O from '../lib/pulse-ops.js';
let ok = 0, bad = 0;
const assert = (c, m) => { if (!c) { bad++; console.error('FEHLER:', m); } else { ok++; console.log('ok:', m); } };

const A = '08111000', FIELDS = 'start,end,present,reloc,start×6,present×6,end×6,angebot×6';
// Zellwerte: Fahrtbeginne je Band (6), mittlere Fahrzeuge je Band (6) → present×6 = Mittel × Läufe
const RUNS = [18, 9, 9, 9, 12, 15];
const row = (starts, pres) => [starts.reduce((a, b) => a + b, 0), 0, 0, 0, ...starts, ...pres.map((p, b) => p * RUNS[b]), 0, 0, 0, 0, 0, 0, ...RUNS];
const doc = (day, munis, runs = RUNS) => ({ day, fields: FIELDS, bandRuns: runs, munis: { [A]: munis } });
const base = (day) => doc(day, { 'z1': row([0, 2, 2, 2, 4, 2], [1, 1, 1, 1, 1, 1]), 'z2': row([0, 1, 1, 1, 2, 1], [0, 0, 0, 0, 0, 0]), 'k1': row([0, 5, 5, 5, 10, 5], [3, 3, 3, 3, 3, 3]), 'k2': row([0, 5, 5, 5, 10, 5], [3, 3, 3, 3, 3, 3]) });
const days = ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-16', '2026-11-17'].map(base);
// Plantag: Plan um 10 Uhr (Band 2), z1 und z2 bekommen Fahrzeuge (Bestand +3 bzw. +0), Fahrtbeginne in z1/z2 doppelt, übrige Zellen +20 %
const today = doc('2026-11-18', { 'z1': row([0, 2, 2, 4, 8, 4], [1, 1, 1, 4, 4, 4]), 'z2': row([0, 1, 1, 2, 4, 2], [0, 0, 0, 0, 0, 0]), 'k1': row([0, 5, 5, 6, 12, 6], [3, 3, 3, 3, 3, 3]), 'k2': row([0, 5, 5, 6, 12, 6], [3, 3, 3, 3, 3, 3]) });

const plan = { ags: A, op: 'Voi', type: 'scooter', rebalance: { needs: [{ rank: 1, cell: 'z1', need: 4, have: 1 }, { rank: 2, cell: 'z2', need: 2, have: 0 }, { rank: 3, cell: 'k1', need: 0, have: 3 }] } };
const rec = O.planRecord(plan, { at: 1, day: '2026-11-18', hour: 10, state: 'BW', name: 'Stuttgart' });
assert(rec && rec.band === 2 && rec.spots.map(s => s.cell).join() === 'z1,z2' && rec.op === 'Voi', 'gemerkt: Band 2, nur Ziele mit Fehlmenge');
assert(O.planRecord({ ...plan, rebalance: { needs: [] } }, { at: 1, day: 'x', hour: 1, state: 'BW' }) === null, 'ohne Ziel nichts zu merken');

const r = O.planCheck(rec, today, days);
assert(r.status === 'ok' && r.bands.join() === '3,4,5' && r.baseDays === 6, `gemessen in Band 3–5 gegen 6 Tage (${r.bands})`);
assert(r.filled === 1 && r.spots === 2, `befüllt: z1 (+3 bei Bedarf 4), z2 nicht (${r.filled} von ${r.spots})`);
assert(r.after === 24 && r.afterBase === 12 && r.ratioT === 2 && r.ratioC === 1.2 && Math.abs(r.effect - (2 / 1.2 - 1)) < 0.002, `Wirkung ×2 gegen ×1,2 übrige = +67 % (${r.effect})`);

// noch kein Band nach dem Plan gemessen
const early = O.planCheck(rec, { ...today, bandRuns: [18, 9, 9, 0, 0, 0] }, days);
assert(early.status === 'wartet', 'wartet, solange kein Band danach gemessen ist');
assert(O.planCheck(rec, null, days).status === 'ohne Daten', 'ohne Zelldatei: ohne Daten');

// gleiche Tagart: Wochenendtag mit nur Werktags-Vergleich (unter 3 gleichen) nimmt alle
const we = (d) => [0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay());
assert(O.planCheck(rec, today, days, { weekend: we }).baseDays === 6, 'Tagart: Werktag gegen Werktage');

console.log(`\n${ok} ok, ${bad} Fehler`);
if (bad) process.exit(1);
