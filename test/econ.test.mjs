import * as E from '../lib/pulse-econ.js';
import * as C from '../lib/pulse-core.js';
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
assert(obs[8] === 20 && obs[9] === 40 && E.observedMinutes([[at(10), 40 * 60e3, 1]])[10] === 40, 'beobachtete Minuten je Stunde');
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
// M1 – Lücken: Lauf nach Lücke (Flag 0 oder Altbestand dt > 45 Min.) macht die Stunde „gestört“: keine Beobachtung, Ereignisse zählen nicht
{
  const r2 = [[at(7), 20 * 60e3, 1], [at(8) + 5 * 60e3, 456 * 60e3, 1], [at(8) + 25 * 60e3, 20 * 60e3, 1], [at(9), 20 * 60e3, 1]];
  const gh = E.gapHours(r2), om = E.observedMinutes(r2);
  assert(gh[8] && !gh[7] && !gh[9] && om[8] === 0 && om[7] === 20 && om[9] === 20, 'Altbestand dt 456 Min.: Stunde 8 gestört, 0 Min. beobachtet');
  assert(E.gapHours([[at(12), 60 * 60e3, 0]])[12] && E.observedMinutes([[at(12), 20 * 60e3, 0]])[12] === 0, 'Flag 0 = gestört, auch bei kurzem dt (noEvents)');
  // Voi Stuttgart 01.11.: 348 von 492 Fahrtbeginnen in der gestörten Stunde → fallen aus der Hochrechnung
  const st = new Array(24).fill(0); st[0] = 106; st[8] = 348; st[9] = 38;
  const obsD = new Array(24).fill(0); obsD[0] = 60; obsD[9] = 60; obsD[8] = 0;
  const kd = E.kpis({ g: { ...g, start: st, vminTot: new Array(24).fill(1000 * 20), vmin: new Array(24).fill(900 * 20) }, obsMin: obsD, profile: flat, plan: bolt, type: 'scooter' });
  assert(kd.rides === 144 && near(kd.coverage, 2 / 24, 1e-9) && near(kd.fleet, 1000 * 20 * 2 / 120), 'gestörte Stunde: Fahrten und Fahrzeugminuten nicht gezählt');
}
// M17a – Preisänderungen je Quelle/Tarif
{
  const p0 = { plans: [{ sourceId: 's', operator: 'Bolt', plans: [{ id: 'a', name: 'Standard', currency: 'EUR', unlock: 1, perMin: [{ start: 0, rate: 0.22, interval: 1, end: null }], perKm: [] }, { id: 'old', name: 'Alt', unlock: 0, perMin: [], perKm: [] }] },
    { sourceId: 'x', operator: 'Voi', plans: [{ id: 'v', name: 'Pay', unlock: 1, perMin: [], perKm: [] }] }] };
  const p1 = { plans: [{ sourceId: 's', operator: 'Bolt', plans: [{ id: 'a', name: 'Standard', currency: 'EUR', unlock: 1.5, perMin: [{ start: 0, rate: 0.25, interval: 1, end: null }], perKm: [] }, { id: 'neu', name: 'Nacht', unlock: 0, perMin: [], perKm: [] }] }] };
  const ch = E.pricingChanges(p0, p1, 123);
  const f = ch.map(c => `${c[3]}:${c[4]}`).sort().join(',');
  assert(f === 'a:perMin,a:unlock,neu:+plan,old:-plan' && ch.find(c => c[4] === 'unlock')[5] === 1 && ch.find(c => c[4] === 'unlock')[6] === 1.5 && ch.every(c => c[0] === 123 && c[1] === 's'), 'Änderungen: Entsperrpreis, Minutenpreis, neuer und entfallener Tarif; Quelle ohne aktuellen Stand (Ausfall) ohne Eintrag');
}
// Zeitumstellung 25.10.2026: Stunde 2 gibt es zweimal (120 Min.) – Fahrten je Tag nicht doppelt hochrechnen
{
  const day = '2026-10-25', hm = C.hourMinutes(day);
  const runsD = []; for (let t = Date.parse('2026-10-24T22:00:00Z'); t < Date.parse('2026-10-25T23:00:00Z'); t += 20 * 60e3) runsD.push([t, 20 * 60e3, 1]); // 25 Ortsstunden
  const om = E.observedMinutes(runsD);
  assert(hm[2] === 120 && om[2] === 120 && om[3] === 60 && om.reduce((a, b) => a + b, 0) === 1500, 'Zeitumstellung: Stunde 2 = 120 Min. beobachtet, Tag 25 h');
  const st = new Array(24).fill(10); st[2] = 20; // je echte Stunde 10 Fahrten
  const kd = E.kpis({ g: { ...g, start: st }, obsMin: om, hourMin: hm, profile: flat, plan: bolt, type: 'scooter' });
  assert(near(kd.coverage, 25 / 24, 1e-9) && near(kd.ridesDay, 240, 1e-6), 'Zeitumstellung: Hochrechnung auf 24 h (250 Fahrten in 25 h → 240 je Tag)');
}
