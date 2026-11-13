// Datenauflagen-Check (S5.1, lib/pulse-auflagen.js): Jahresbuch der Feed-Verfügbarkeit und Auflagen je Anbieter
import * as A from '../lib/pulse-auflagen.js';
let ok = 0, bad = 0;
const assert = (c, m) => { if (!c) { bad++; console.error('FEHLER:', m); } else { ok++; console.log('ok:', m); } };

// state.rel wie die Verfolgung: je Quelle und Tag [Läufe, live, verzögert, veraltet, Fehler, Latenz]
/** @returns {Record<string, number[]>} */
const rel = (/** @type {string} */ from, /** @type {number} */ n, /** @type {(i: number) => number[]} */ f) => { const o = /** @type {Record<string, number[]>} */ ({}); for (let i = 0; i < n; i++) { const d = new Date(Date.parse(`${from}T12:00:00Z`) + i * 864e5).toISOString().slice(0, 10); o[d] = f(i); } return o; };
let L = null;
// 40 Tage Betrieb, jeden Tag mit einem 8-Tage-Fenster wie state.rel: Quelle a immer verfügbar, b an 3 von 80 Läufen pro Tag mit Fehler
for (let day = 0; day < 40; day++) {
  const today = new Date(Date.parse('2026-10-01T12:00:00Z') + day * 864e5).toISOString().slice(0, 10);
  const start = new Date(Date.parse(`${today}T12:00:00Z`) - 7 * 864e5).toISOString().slice(0, 10);
  const win = Math.min(8, day + 1), from = day < 7 ? '2026-10-01' : start;
  L = A.updateLedger(L, { a: rel(from, win, () => [80, 78, 2, 0, 0, 0]), b: rel(from, win, () => [80, 70, 3, 4, 3, 0]) }, { today, now: day });
}
const ya = A.yearAvailability(L, 'a'), yb = A.yearAvailability(L, 'b');
assert(ya.runs === 40 * 80 && ya.share === 1 && ya.from === '2026-10-01', `Quelle a: ${ya.runs} Läufe in 40 Tagen, 100 % verfügbar, seit 01.10.`);
assert(yb.runs === 40 * 80 && Math.abs(yb.share - 73 / 80) < 1e-9, `Quelle b: verfügbar = live + verzögert (${(yb.share * 100).toFixed(2)} %), veraltet und Fehler zählen nicht`);
assert(Object.keys(L.sources.a.d).length <= 11 && Object.keys(L.sources.a.mo).length >= 1, `Tage nach ${Object.keys(L.sources.a.d).length} Tagen zu Monaten verdichtet (klein bleibt die Datei)`);
// Fenster rückwirkend: derselbe Lauf zweimal ändert nichts (idempotent)
const again = A.updateLedger(L, { a: rel('2026-11-02', 8, () => [80, 78, 2, 0, 0, 0]) }, { today: '2026-11-09', now: 99 });
assert(A.yearAvailability(again, 'a').runs === ya.runs, 'dasselbe Fenster zweimal: keine doppelten Läufe');
const nov = A.monthAvailability(L, 'b', '2026-11');
assert(nov.runs === 9 * 80, `Monatsnachweis November: ${nov.runs} Läufe an 9 Tagen`);
// Jahreswechsel: neues Buch
const ny = A.updateLedger(L, { a: { '2027-01-01': [10, 10, 0, 0, 0, 0] } }, { today: '2027-01-01', now: 1 });
assert(ny.year === 2027 && A.yearAvailability(ny, 'a').runs === 10, 'Jahreswechsel: neues Buch, nur Läufe des neuen Jahres');
// Ampel gegen 96 %
assert(A.availLevel(0.97) === 'ok' && A.availLevel(0.96) === 'ok' && A.availLevel(0.93) === 'near' && A.availLevel(0.5) === 'bad' && A.availLevel(null) === 'unknown', 'Ampel: ab 96 % ok, ab 90 % nahe, darunter unter');
// Auflagen je Anbieter: Dubletten zählen nicht, zwei Feeds eines Anbieters zusammen, Zonen/Preise aus den Feeds
const latest = { sources: [
  { id: 'a', operator: 'Voi', status: 'live', municipalities: ['08121000'], feedAgeMs: 60e3, feeds: ['free_bike_status', 'geofencing_zones', 'system_pricing_plans'], licenseId: 'CC0-1.0', version: '2.3', api: 'gbfs' },
  { id: 'b', operator: 'Voi', status: 'stale', municipalities: ['08121000'], feedAgeMs: 4e6, feeds: ['free_bike_status'], version: '2.3', api: 'gbfs' },
  { id: 'c', operator: 'Lime', status: 'duplicate', municipalities: ['08121000'] },
  { id: 'd', operator: 'Bolt', status: 'live', municipalities: ['08111000'] },
] };
const rows = A.obligations(latest, L, { ags: '08121000' });
assert(rows.length === 1 && rows[0].op === 'Voi', 'nur Anbieter der Gemeinde, Dubletten ausgelassen');
const v = rows[0];
assert(v.feed && v.zones && v.prices && v.license === 'CC0-1.0' && v.version === '2.3' && v.ageMs === 4e6, 'Feed, Zonen, Preise, Lizenz, GBFS-Version, Datenalter (ältester Feed)');
assert(Math.abs(v.avail - (80 + 73) / 160) < 1e-9 && v.level === 'near', `zwei Feeds zusammen: ${(v.avail * 100).toFixed(1)} % → nahe`);
console.log(`${bad ? '✗' : '✓'} auflagen: ${ok} ok, ${bad} fehlgeschlagen`);
process.exit(bad ? 1 : 0);
