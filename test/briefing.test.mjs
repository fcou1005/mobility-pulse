// Tagesbriefing (F32, lib/pulse-briefing.js): Prognose des Tages, ÖPNV, Text, Fälligkeit
import * as BR from '../lib/pulse-briefing.js';
let ok = 0, bad = 0;
const assert = (c, m) => { if (!c) { bad++; console.error('FEHLER:', m); } else { ok++; console.log('ok:', m); } };

const local = Array.from({ length: 24 }, (_, i) => [i < 18 ? '2026-11-19' : '2026-11-20', (6 + i) % 24]);
const fc = { horizon: { local }, municipalities: { A: local.map(([, h]) => (h === 17 ? 600 : 300)) } };
const f = BR.dayForecast(fc, 'A', '2026-11-19');
assert(f && f.total === 17 * 300 + 600 && f.peakH === 17 && f.peak === 600 && f.hours === 18 && BR.dayForecast(fc, 'B', '2026-11-19') === null, `Prognose des Tages: nur Stunden des Ortstags, Spitze 17 Uhr (${JSON.stringify(f)})`);

const H = { days: ['2026-11-18'], n: [new Array(24).fill(100)], skip: [new Array(24).fill(2)], late: [new Array(24).fill(8)], gap: [new Array(24).fill(0).map((_, h) => (h === 3 ? 1 : 0))] };
const pt = BR.ptBrief({ hours: H, prognose: { next: [['2026-11-19', 7, 0.06, 0.01, 4000], ['2026-11-19', 8, 0.08, 0.01, 4000], ['2026-11-19', 9, 0.04, 0.01, 4000]], lines: [['S4', 'sbahn', 0.4, 0.3], ['S5', 'sbahn', 0.5, 0.2], ['U6', 'ubahn', 0.1, 0], ['X', 'bus', 0, 0]] } }, '2026-11-18');
assert(Math.abs(pt.yOk - 0.9) < 1e-9 && Math.abs(pt.late3 - 0.06) < 1e-9 && pt.lines.join() === 'S4,S5,U6' && BR.ptBrief(null, 'x') === null, 'ÖPNV: Pünktlichkeit des Vortags ohne Lückenstunden, nächste 3 Stunden, drei Linien');

const b = BR.briefingText({ name: 'Stuttgart', day: '2026-11-19', fc: f, akku: { morning: 38, nowLow: 155 }, pt, events: [{ titel: 'PITBULL', ort: 'Hanns-Martin-Schleyer-Halle', cap: 15500, zeit: null }], cap: { total: 4906, limit: 6000 } });
assert(b.title === 'Briefing Stuttgart, 19.11.2026' && /Prognose: 5\.700 Fahrtbeginne, Spitze 17–18 Uhr \(600\)\./.test(b.text) && /Akku: 38 Fahrzeuge unter 20 % bis 8 Uhr, jetzt 155\./.test(b.text)
  && /ÖPNV: gestern 90 % pünktlich; nächste 3 Stunden erwartet 6,0 % verspätet, 1,0 % ausgefallen \(am stärksten: S4, S5, U6\)\./.test(b.text) && /PITBULL \(Hanns-Martin-Schleyer-Halle, 15\.500 Plätze\)/.test(b.text) && /Obergrenze: 4\.906 von 6\.000 E-Scootern \(82 %\)\./.test(b.text),
  `Text mit allen Teilen:\n${b.text}`);
assert(BR.briefingText({ name: 'X', day: '2026-11-19' }) === null, 'ohne Daten kein Briefing');
assert(!BR.briefingDue(null, '2026-11-19', 5) && BR.briefingDue(null, '2026-11-19', 6) && !BR.briefingDue('2026-11-19', '2026-11-19', 9) && BR.briefingDue('2026-11-18', '2026-11-19', 7), 'einmal je Ortstag ab 6 Uhr');
console.log(`${bad ? '✗' : '✓'} briefing: ${ok} ok, ${bad} fehlgeschlagen`);
process.exit(bad ? 1 : 0);
