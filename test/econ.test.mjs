import * as E from '../lib/pulse-econ.js';
const assert = (c, m) => { if (!c) { console.error('FEHLER:', m); process.exitCode = 1; } else console.log('ok:', m); };
const near = (a, b, eps = 0.011) => Math.abs(a - b) < eps;
// Tarife (GBFS-Segmente)
const bolt = { unlock: 0.99, perMin: [{ start: 0, rate: 0.24, interval: 1, end: null }], perKm: [] };
assert(near(E.fare(bolt, 12), 0.99 + 12 * 0.24), 'Bolt: 0,99 € + 12 × 0,24 €');
const nb = { unlock: 0, perMin: [{ start: 1, rate: 2.5, interval: 15, end: 136 }, { start: 136, rate: 2.5, interval: 0, end: 1441 }], perKm: [] };
assert(E.fare(nb, 12) === 2.5 && E.fare(nb, 18) === 5 && E.fare(nb, 200) === 25, 'nextbike: 2,50 € je angefangene 15 Min, Tageskappe');
const hopp = { unlock: 1, perMin: [], perKm: [], desc: '€1.00 to start and €0.25 per minute.' };
assert(near(E.fare(hopp, 12), 1 + 3), 'Tarif aus Beschreibung (Hopp)');
const cab = { unlock: 0, perMin: [], perKm: [], desc: '0,12€/min + 1€ Freischaltgebühr, max. 13€/Tag' };
assert(near(E.fare(cab, 10), 1 + 1.2), 'Beschreibung deutsch (Call a Bike)');
const km = { unlock: 1, perMin: [], perKm: [{ start: 0, rate: 0.5, interval: 1, end: null }] };
assert(near(E.fare(km, 10, 2.4), 1 + 1.5), 'Kilometertarif: angefangene km');
// Tarifwahl
const pricing = { plans: [
  { operator: 'Zeus', municipalities: ['A'], plans: [{ id: '4', name: 'Simple rate gold', unlock: 0, perMin: [{ start: 0, rate: 0.23, interval: 1 }], perKm: [] }, { id: '2', name: 'Simple rate standard', unlock: 1, perMin: [{ start: 0, rate: 0.23, interval: 1 }], perKm: [] }] },
  { operator: 'Voi', municipalities: ['B'], plans: [{ id: 'x:ebike-pricing-plan', name: 'Pay as you go', unlock: 0, perMin: [{ start: 0, rate: 0.30, interval: 1 }], perKm: [] }, { id: 'x:scooter-pricing-plan', name: 'Pay as you go', unlock: 0, perMin: [{ start: 0, rate: 0.25, interval: 1 }], perKm: [] }, { id: 'p', name: 'Voi Pass Monat', unlock: 0, perMin: [{ start: 0, rate: 0, interval: 1 }], perKm: [] }] },
] };
assert(E.planFor(pricing, 'Zeus', 'A', 'scooter').plan.name === 'Simple rate standard', 'Standardtarif vor Mitgliedsstufen');
assert(E.planFor(pricing, 'Voi', 'B', 'scooter').plan.id === 'x:scooter-pricing-plan' && E.planFor(pricing, 'Voi', 'B', 'ebike').plan.id === 'x:ebike-pricing-plan', 'Tarif passend zur Fahrzeugart');
assert(E.planFor(pricing, 'Voi', 'Z', 'scooter').scope === 'Anbieter', 'andere Gemeinde: Tarif des Anbieters');
assert(E.planFor(pricing, 'Lime', 'A', 'scooter') === null, 'ohne Tarif: null');
// Beobachtung und Hochrechnung
const at = (h) => Date.parse(`2026-11-01T${String(h - 1).padStart(2, '0')}:30:00Z`); // Berlin = UTC+1
const runs = [[at(8), null], [at(8) + 20 * 60e3, 20 * 60e3], [at(8) + 40 * 60e3, 20 * 60e3], [at(9) + 0, 20 * 60e3]];
const obs = E.observedMinutes(runs);
assert(obs[8] === 20 && obs[9] === 40 && E.observedMinutes([[at(10), 3 * 3600e3]])[10] === 45, 'beobachtete Minuten je Stunde, Fenster ≤ 45 Min');
// 100 Fahrzeuge, ganzer Tag beobachtet, 300 Fahrten → RVD 3
const full = new Array(24).fill(60);
const g = { start: new Array(24).fill(12.5), end: new Array(24).fill(12.5), rot: new Array(24).fill(0), vmin: new Array(24).fill(90 * 60), vminTot: new Array(24).fill(100 * 60), tripDurSum: 0, tripDurN: 0, tripDistSum: 0, tripDistN: 0 };
const k = E.kpis({ g, obsMin: full, plan: bolt, type: 'scooter', realization: 1, net: false });
assert(near(k.fleet, 100) && near(k.ridesDay, 300) && near(k.rvd, 3), 'RVD = 300 Fahrten / 100 Fahrzeuge');
assert(near(k.utilization, 3 * 12 / 1440, 1e-6), 'Auslastung = RVD × Ø Dauer / 1440');
assert(near(k.perRide, 0.99 + 12 * 0.24) && near(k.revDay, 300 * (0.99 + 12 * 0.24), 0.05), 'Umsatz brutto = Fahrten × Tarif');
const kn = E.kpis({ g, obsMin: full, plan: bolt, type: 'scooter' });
assert(near(kn.revDay, k.revDay / 1.19 * 0.85, 0.05), 'netto ohne MwSt. und mit Realisierungsquote 85 %');
// halber Tag beobachtet: Hochrechnung über den Tagesgang
const half = full.map((x, h) => (h >= 12 ? 60 : 0));
const gh = { ...g, start: g.start.map((x, h) => (h >= 12 ? x : 0)), vminTot: g.vminTot.map((x, h) => (h >= 12 ? x : 0)), vmin: g.vmin.map((x, h) => (h >= 12 ? x : 0)) };
const flat = new Array(24).fill(1 / 24);
const k2 = E.kpis({ g: gh, obsMin: half, profile: flat, plan: bolt, type: 'scooter' });
assert(near(k2.coverage, 0.5, 1e-9) && near(k2.ridesDay, 300) && near(k2.fleet, 100), 'Hochrechnung: halber Tag → doppelte Fahrten, Flotte gleich');
// Plausibilität
const gx = { ...g, start: g.start.map(x => x * 10) };
assert(!E.kpis({ g: gx, obsMin: full, plan: bolt, type: 'scooter' }).plausible, 'RVD 30 als unplausibel markiert');
// Zusammenfassen
const c = E.combine([k, k]);
assert(near(c.rvd, 3) && near(c.fleet, 200) && near(c.revDay, 2 * k.revDay, 0.1), 'Kombination gewichtet nach Flotte');
// Tagesgang aus Messung
const day = { runs: [...Array(72)].map((_, i) => [Date.parse('2026-11-01T00:10:00Z') - 3600e3 + i * 20 * 60e3, 20 * 60e3]), groups: { a: { start: [...Array(24)].map((_, h) => (h === 8 ? 30 : 10)) } } };
const hp = E.hourProfile([day, day, day]);
assert(hp.source.startsWith('gemessen') && hp.profile[8] > hp.profile[3] * 2.5, 'Tagesgang aus 3 vollen Tagen gemessen');
assert(E.hourProfile([day]).source === 'Standardkurve', 'zu wenige Tage: Standardkurve');
assert(E.planLabel(bolt) === '0.99 € Start + 0.24 €/min', 'Tariflabel');
// Fahrzeugminuten nur aus Läufen, die sie zählen
const gv = { ...g, vminTot: g.vminTot.map((x, h) => (h === 23 ? 100 * 20 : 0)), vmin: g.vmin.map((x, h) => (h === 23 ? 90 * 20 : 0)) };
const obsV = new Array(24).fill(0); obsV[23] = 20;
assert(near(E.kpis({ g: gv, obsMin: full, obsMinV: obsV, plan: bolt, type: 'scooter' }).fleet, 100), 'Flotte aus Fahrzeugminuten der zählenden Läufe');
