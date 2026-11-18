// Familien ohne tragfähiges Volumen (lib/pulse-forecast-small.js, 18.11.2026): keine Schein-Prognose für E-Roller, Befund je Anbieter
import * as FC from '../lib/pulse-forecast.js';
let ok = 0, bad = 0;
const assert = (c, m) => { if (!c) { bad++; console.error('FEHLER:', m); } else { ok++; console.log('ok:', m); } };

// Schwelle: unter 50 Fahrtbeginnen je Tag keine Prognose, auch nicht die Vorwoche; Carsharing mit 205 je Tag behält die Vorwoche
assert(FC.smallNoForecast({ status: 'small', active: 'week', volume: 1 }) && FC.smallNoForecast({ status: 'small', active: null, volume: 300 })
  && FC.smallNoForecast({ status: 'insufficient' }) && !FC.smallNoForecast({ status: 'small', active: 'week', volume: 205 })
  && !FC.smallNoForecast({ status: 'active', active: 'pooled', volume: 1 }) && !FC.smallNoForecast(null), 'smallNoForecast: E-Roller 1 je Tag ja, Carsharing 205 je Tag nein');

// Stand je Anbieter: stella 169 Roller, 7 Tage ohne Fahrt → still; franke ohne Fahrzeuge, Quelle mit Fehler → down; Fahrten nur aus Tagen vor heute
const zero = () => new Array(24).fill(0), one = (h, n) => { const a = zero(); a[h] = n; return a; };
const days = {};
for (const d of ['2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18'])
  days[d] = { DE: { a: zero() }, 'op:stella': { a: zero() }, 'op:franke': { a: d === '2026-11-11' ? one(6, 6) : zero() } };
days['2026-11-18']['op:stella'].a = one(9, 4); // heute zählt nicht mit
const series = { today: '2026-11-18', days };
const munis = { '08111000': { operators: { stella: { types: { moped: 169 } }, Lime: { types: { scooter: 1395 } } } }, '08311000': { operators: { Voi: { types: { scooter: 10 } } } } };
const sources = [{ id: 'stella', operator: 'stella', status: 'live' }, { id: 'freibe', operator: 'franke', status: 'error' }, { id: 'x', operator: 'franke', status: 'live', candidate: true }];
const S = FC.smallState(series, munis, ['moped'], '2026-11-18', { sources });
const st = S.rows.find(r => r.op === 'stella'), fr = S.rows.find(r => r.op === 'franke');
assert(S.days === 7 && S.starts === 6 && Math.abs(S.perDay - 6 / 7) < 1e-9 && S.vehicles === 169 && S.rows.length === 2, `Summen: 7 Tage, 6 Fahrtbeginne, 169 Fahrzeuge (${JSON.stringify(S)})`);
assert(st && st.vehicles === 169 && st.starts === 0 && st.still && !st.down && st.ags.join() === '08111000', 'stella: 169 gemeldet, 0 Fahrten, steht still');
assert(fr && fr.vehicles === 0 && fr.starts === 6 && !fr.still && fr.down, 'franke: keine Fahrzeuge, 6 Fahrten am 11.11., Quelle mit Fehler (Kandidat zählt nicht)');
assert(S.rows[0].op === 'stella' && !S.rows.some(r => r.op === 'Lime' || r.op === 'Voi'), 'nur Arten der Familie, größte Flotte zuerst');
const SA = FC.smallState(series, munis, ['moped'], '2026-11-18', { ags: '08311000' });
assert(SA.vehicles === 0 && !SA.rows.some(r => r.op === 'stella'), 'Gebiet Freiburg: stella (Stuttgart) fällt bei den Fahrzeugen weg');
const S3 = FC.smallState({ today: '2026-11-13', days: { '2026-11-12': days['2026-11-12'], '2026-11-13': days['2026-11-13'] } }, munis, ['moped'], '2026-11-13');
assert(S3.days === 1 && !S3.rows.find(r => r.op === 'stella').still, 'unter 3 Tagen kein Befund „steht still“');

console.log(`\n${ok} ok, ${bad} Fehler`);
if (bad) process.exit(1);
