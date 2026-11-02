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
// ---------- Kalibrierung an Referenzwerten (lib/pulse-calib.js) ----------
{
  const K = await import('../lib/pulse-calib.js');
  const Q = (z, w, m, km) => ({ ags: '11000000', ort: 'Berlin', type: 'scooter', zeitraum: z, wert: w, minMittel: m, kmMittel: km, quelle: 'Abgeordnetenhaus', url: 'https://example.org' });
  const ref = { rvd: [Q('Q1/2025', 1.54), Q('Q2/2025', 2.25), Q('Q3/2025', 2.31), Q('Q4/2025', 1.72), Q('Q1/2026', 1.42), { ags: null, ort: 'Europa', type: 'scooter', zeitraum: '2024', wert: 1.6 }, { ags: null, ort: 'Voi gesamt', type: 'scooter', zeitraum: 'Q4/2025', wert: 2.4 }],
    umsatz: [{ ags: null, ort: 'Voi gesamt', type: 'scooter', zeitraum: 'Q4/2025', wert: 3.64 }],
    fahrt: [Q('Q1/2025', null, 7.3, 1.5), Q('Q2/2025', null, 8.0, 1.6), Q('Q3/2025', null, 7.4, 1.7), Q('Q4/2025', null, 6.4, 1.3), Q('Q1/2026', null, 6.5, 1.6), { ags: '08121000', type: 'scooter', zeitraum: '04/2025–04/2026', minMedian: 6.9, minMittel: 8.7 }],
    flotte: [{ ags: '11000000', ort: 'Berlin', type: 'scooter', stand: '2026-04-01', wert: 46450, art: 'genehmigt' }, { ags: '09162000', ort: 'München', type: 'scooter', wert: 21000, art: 'aktiv' }],
    fahrten: [{ ags: '06412000', ort: 'Frankfurt am Main', type: 'scooter', zeitraum: '2025', wert: 10490000 }],
    obergrenzen: [{ ags: '06412000', type: 'scooter', gesamt: 12000, ab: '2026-07-01', gesamtAb: 10500 }] };
  // Quartale
  assert(K.quarterOf('2026-11-01') === 'Q4/2026' && K.quarterOf('2027-03-31') === 'Q1/2027' && K.quarterKey('Q4/2025') === 2025 * 4 + 3 && K.quarterKey('2025') === null, 'Quartal eines Tages, fortlaufende Quartalsnummer');
  const qs = ref.rvd.slice(0, 5);
  assert(K.pickQuarter(qs, '2026-11-01').entry.zeitraum === 'Q4/2025' && K.pickQuarter(qs, '2026-11-01').rule === 'Vorjahresquartal', 'Referenzquartal: gleiches Kalenderquartal des Vorjahres (Q4/2026 → Q4/2025)');
  assert(K.pickQuarter(qs, '2027-05-02').entry.zeitraum === 'Q1/2026' && K.pickQuarter(qs, '2027-05-02').rule === 'jüngstes Quartal' && K.pickQuarter(qs, '2026-02-10').rule === 'gleiches Quartal', 'ohne Vorjahresquartal das jüngste; gleiches Quartal, wenn schon veröffentlicht');
  // 1. Fahrtdauer
  const ra = K.rideAssumption(ref, 'scooter');
  assert(ra.calibrated && near(ra.min, 7.12, 1e-9) && near(ra.km, 1.54, 1e-9) && ra.from === 'Q1/2025' && ra.to === 'Q1/2026' && ra.minRange[0] === 6.4 && ra.minRange[1] === 8.0 && ra.previous.min === 12, 'E-Scooter: Ø 7,12 Min. / 1,54 km aus fünf Berliner Quartalen (bisher 12 Min.)');
  assert(!K.rideAssumption(ref, 'ebike').calibrated && K.rideAssumption(ref, 'ebike').min === E.DEFAULT_RIDE.ebike.min && !K.rideAssumption({}, 'scooter').calibrated && K.rideAssumption({}, 'scooter').min === 12, 'E-Bike ohne Beleg und E-Scooter ohne Referenz: bisherige Annahme');
  const as = K.rideAssumptions(ref);
  const kc = E.kpis({ g, obsMin: full, plan: bolt, type: 'scooter', realization: 1, net: false, assume: as });
  assert(near(kc.avgMin, 7.12, 1e-9) && kc.durationSource === 'kalibriert' && near(kc.utilization, 3 * 7.12 / 1440, 1e-9) && near(kc.perRide, 0.99 + 8 * 0.24), 'kalibrierte Dauer wirkt auf Auslastung und Preis je Fahrt (angefangene Minuten)');
  const gm = { ...g, tripDurSum: 30 * 25 * 60e3, tripDurN: 30, tripDistSum: 30 * 900, tripDistN: 30 };
  const km1 = E.kpis({ g: gm, obsMin: full, plan: bolt, type: 'scooter', assume: as }), km2 = E.kpis({ g: { ...gm, tripDurSum: 30 * 5 * 60e3, tripDistSum: 30 * 2400 }, obsMin: full, plan: bolt, type: 'scooter', assume: as });
  assert(near(km1.avgMin, 7.12, 1e-9) && km1.durationSource === 'kalibriert' && near(km1.avgKm, 1.54, 1e-9) && near(km2.avgMin, 5) && km2.durationSource === 'gemessen' && near(km2.avgKm, 2.4), 'gemessene Dauer (20-Min.-Raster) nur unter der Referenz, gemessene Luftlinie nur darüber');
  assert(near(E.kpis({ g: gm, obsMin: full, plan: bolt, type: 'scooter' }).avgMin, 24), 'ohne Kalibrierung wie bisher: gemessen, höchstens doppelte Annahme');
  // 2. Methodenfaktor
  const meas = { rvd: 1.075, fleet: 4570, ridesDay: 4913, days: 2, fullDays: 0, obsMin: 276, possibleMin: 2880, from: '2026-10-31', to: '2026-11-01' };
  const kf = K.methodFactor(ref, meas);
  assert(near(kf.k, 1.72 / 1.075, 1e-9) && kf.quarter === 'Q4/2025' && near(kf.kLow, 1.42 / 1.075, 1e-9) && near(kf.kHigh, 2.31 / 1.075, 1e-9), 'k = 1,72 (Q4/2025) ÷ 1,075 gemessen = 1,60; Spanne aus 1,42 und 2,31');
  assert(kf.prelim && kf.prelimWhy.length === 2 && !K.methodFactor(ref, { ...meas, days: 7, fullDays: 7, obsMin: 1500 }).prelim && K.methodFactor(ref, { ...meas, days: 7, obsMin: 1500 }).prelim, 'vorläufig unter 7 vollen Messtagen oder unter 50 % beobachteter Stunden (7 Tage ohne volle Tage bleiben vorläufig)');
  // M-5: vorläufig = nicht angewandt (k nur angezeigt), erst mit 7 vollen Messtagen und ≥ 50 % der Stunden
  const kfA = K.methodFactor(ref, { ...meas, days: 7, fullDays: 7, obsMin: 1500 });
  assert(!kf.applied && kf.reason === 'vorläufiger Faktor k = 1,60 (1,32–2,15) nicht angewandt: erst 0 von 7 vollen Messtagen; 10 % statt 50 % der Tagesstunden beobachtet' && kfA.applied && !kfA.reason, 'M-5: 2 Messtage → applied false, prelim true, Grund nennt k und Vorbehalte; 7 volle Tage → angewandt');
  assert(K.factorFor('scooter', { k: kf }).f === 1 && K.factorFor('scooter', { k: kf }).source === 'gemessen', 'M-5: vorläufiges k wirkt nicht auf die Fahrten');
  assert(!K.methodFactor(ref, null).applied && /keine Berliner/.test(K.methodFactor(ref, { ...meas, rvd: null }).reason) && !K.methodFactor({}, meas).applied && !K.methodFactor(ref, { ...meas, rvd: 0.1 }).applied, 'keine Kalibrierung ohne Berliner Messung, ohne Quartalswerte oder bei unplausiblem Faktor (> 5)');
  // Faktor je Gruppe: Korrektur übersteuert, k nur E-Scooter im Modus „kalibriert“
  assert(K.factorFor('scooter', { k: kfA }).source === 'kalibriert' && K.factorFor('ebike', { k: kfA }).f === 1 && K.factorFor('scooter', { k: kfA, mode: 'mess' }).f === 1 && K.factorFor('scooter', { k: kfA, manual: 1.3 }).f === 1.3 && K.factorFor('scooter', { k: kfA, manual: 1.3 }).source === 'Korrektur', 'Faktor: Korrektur × übersteuert, k nur für E-Scooter, „gemessen“ ohne Faktor');
  const kk = K.applyFactor(kc, 2);
  assert(near(kk.ridesDay, 2 * kc.ridesDay) && near(kk.rvd, 2 * kc.rvd) && near(kk.utilization, 2 * kc.utilization) && near(kk.revDay, 2 * kc.revDay) && near(kk.perRide, kc.perRide) && near(kk.fleet, kc.fleet), 'Faktor skaliert Fahrten, RVD, Auslastung, Umsatz; Preis je Fahrt und Flotte bleiben');
  const rep = { pop: 1e6, groups: [{ key: 'Dott|scooter', op: 'Dott', ty: 'scooter', fleet: 100, ridesDay: 100, plausible: true }, { key: 'nb|bike', op: 'nb', ty: 'bike', fleet: 50, ridesDay: 50, plausible: true }] };
  const cr = K.calibrateReport(rep, { applied: true, k: 2, kLow: 1.5, kHigh: 3 });
  assert(cr.applied && cr.groups.get('Dott|scooter').ridesDay === 200 && cr.groups.get('nb|bike').ridesDay === 50 && cr.totals.ridesDay === 250 && cr.totals.lo === 200 && cr.totals.hi === 350 && near(cr.totals.rvd, 250 / 150) && near(cr.totals.per1000Rides, 0.25), 'Bericht kalibriert: nur E-Scooter × k, Spanne aus kLow/kHigh, Summen');
  // 3. Abdeckung
  const cov = K.fleetCoverage(ref, { '11000000|Dott|scooter': { total: 4557 }, '11000000|nextbike|bike': { total: 999 }, '09162000|Dott|scooter': { total: 3392 } });
  assert(cov.length === 2 && cov[0].ours === 4557 && near(cov[0].share, 4557 / 46450) && cov[0].art === 'genehmigt' && near(cov[1].share, 3392 / 21000), 'Abdeckung: eigene E-Scooter ÷ amtliche Flotte (Berlin 9,8 %, München 16 %)');
  // 4. Plausibilität
  const pc = K.plausibilityChecks(ref, { byAgs: { '06412000': { rvd: 1.2 } }, national: { rvd: 1.0 }, voi: { rvd: 2, revPerVehicleDay: 5 } }, kfA);
  const ff = pc.find(x => x.key === 'fahrten:06412000');
  assert(ff && ff.kind === 'Untergrenze' && ff.limit === 12000 && near(ff.refValue, 10490000 / 365 / 12000, 1e-9) && near(ff.calibrated, 1.2 * kfA.k, 1e-9), 'Frankfurt: 10,49 Mio. ÷ 365 ÷ 12.000 (Obergrenze 2025) = Untergrenze 2,39');
  assert(pc.some(x => x.ref.ort === 'Europa' && x.measured === 1) && pc.some(x => x.ref.ort === 'Voi gesamt' && x.measured === 2 && x.kind === 'Vergleich') && pc.some(x => x.unit === '€' && x.measured === 5 && near(x.ratio, 5 / 3.64)), 'Europa und Voi (Fahrten und Umsatz je Fahrzeug) als Vergleich ohne Faktor');
  const bRep = (groups, q = {}) => ({ quality: { fullDays: 0, obsMin: 276, possibleMin: 2880, ...q }, days: ['2026-10-31', '2026-11-01'], from: '2026-10-31', to: '2026-11-01', groups });
  const dott = { op: 'Dott', ty: 'scooter', plausible: true, flags: [], ridesDay: 4913, fleet: 4570, rides: 681, rvd: 4913 / 4570 };
  const all = K.calibration(ref, { berlinReport: bRep([dott]), groups: {} });
  assert(!all.k.applied && all.k.prelim && K.calibration(ref, { berlinReport: bRep([dott], { fullDays: 7, obsMin: 1500 }), groups: {} }).k.applied && near(all.k.k, 1.72 / (4913 / 4570), 1e-9) && all.assume.scooter.calibrated && all.coverage.length === 2 && near(all.limits.scooter, 2.31 * 1.5, 1e-9), 'Kalibrierung gesamt aus Berliner Bericht; Plausibilitätsgrenze 2,31 × 1,5');
  // Herkunft von k offenlegen, Einschränkung bei nur einem Anbieter; unplausible Berliner Anbieter gehen nicht in k ein
  assert(all.k.source === 'aus Dott Berlin, 681 Fahrten, 4,6 Messstunden' && /nur aus einem Anbieter \(Dott\)/.test(all.k.single), 'k: Herkunft „aus Dott Berlin, n Fahrten, x Messstunden“ und Hinweis auf nur einen Anbieter');
  const lime = { op: 'Lime', ty: 'scooter', plausible: false, flags: [K.SUSPENDED], ridesDay: 9000, fleet: 1000, rides: 900, rvd: 9 };
  const two = K.calibration(ref, { berlinReport: bRep([dott, lime]), groups: {} });
  assert(near(two.k.k, all.k.k, 1e-9) && two.k.measured.excluded[0].op === 'Lime' && two.k.single && two.k.source.startsWith('aus Dott Berlin'), 'unplausibler Berliner Anbieter (Lime) geht nicht in k ein und wird als ausgeschlossen geführt');
  const none = K.calibration(ref, { berlinReport: bRep([lime]), groups: {} });
  assert(!none.k.applied && /keine plausible Berliner/.test(none.k.reason) && /Lime/.test(none.k.reason), 'nur unplausible Berliner Messung: keine Kalibrierung, Grund nennt den Anbieter');
  // Englische Oberfläche (lang 'en'): Texte übersetzt, Zahlen mit Dezimalpunkt, Kennungen (kind, Flags) sprachunabhängig, Werte gleich
  const allEn = K.calibration(ref, { berlinReport: bRep([dott]), groups: {}, lang: 'en' });
  assert(allEn.lang === 'en' && allEn.k.source === 'from Dott Berlin, 681 trips, 4.6 measured hours' && /^k comes from only one operator \(Dott\)/.test(allEn.k.single) && near(allEn.k.k, all.k.k, 1e-12) && allEn.k.rule === 'same quarter of the previous year',
    'EN: Herkunft „from Dott Berlin, 681 trips, 4.6 measured hours“, Hinweis auf einen Anbieter, Referenzregel; k unverändert');
  assert(allEn.k.prelimWhy.join(' | ') === 'only 0 of 7 full measurement days | 10 % instead of 50 % of the hours of the day observed' && /^provisional factor k = 1\.60 \(1\.32–2\.15\) not applied: only 0/.test(allEn.k.reason) && allEn.assume.ebike.label === 'assumption (no official evidence)' && allEn.coverage[0].label === 'licensed fleet' && allEn.coverage[0].shareLabel.startsWith('Share of the licensed fleet'),
    'EN: Vorbehalte, Annahme und Abdeckung übersetzt');
  const ffEn = allEn.checks.find(x => x.key === 'fahrten:06412000');
  assert(ffEn.kind === 'Untergrenze' && ffEn.label === 'Frankfurt am Main: trips per vehicle per day' && ffEn.how === '10490000 trips 2025 ÷ 365 days ÷ fleet cap 12000' && allEn.checks.some(x => x.scope === 'Voi in open feeds (Germany)'), 'EN: Prüfwerte beschriftet, kind bleibt Kennung');
  const noneEn = K.calibration(ref, { berlinReport: bRep([lime]), groups: {}, lang: 'en' });
  assert(noneEn.k.reason === 'no plausible Berlin e-scooter measurement (Lime excluded: overcount likely)' && K.methodFactor({}, meas, { lang: 'en' }).reason === 'no official Berlin quarterly values in reference.json', 'EN: Gründe ohne Kalibrierung');
  const outEn = K.methodFactor(ref, { ...meas, rvd: 0.1 }, { lang: 'en' }), outDe = K.methodFactor(ref, { ...meas, rvd: 0.1 });
  assert(!outEn.applied && outEn.reason === 'Factor 17.20 outside 0.2–5: check the measurement, not applied' && outDe.reason === 'Faktor 17,20 außerhalb 0,2–5: Messung prüfen, nicht angewandt', 'Faktor außerhalb der Spanne: Dezimalzeichen je Sprache');
  const kv = E.kpis({ g: { ...g, start: g.start.map(x => x * 1.5) }, obsMin: full, plan: bolt, type: 'scooter' }); // RVD 4,5 > 3,47
  const ck = K.checkMeasured(kv, 'scooter', all.limits), cok = K.checkMeasured(kc, 'scooter', all.limits);
  assert(ck.suspended && !ck.kpi.plausible && ck.kpi.flags[0] === K.SUSPENDED && !cok.suspended && cok.kpi === kc && !K.checkMeasured(kv, 'ebike', all.limits).suspended, 'Messung über der Grenze: Kalibrierung ausgesetzt, nicht plausibel (aus Summen); E-Bikes ohne Grenze');
  assert(K.factorFor('scooter', { k: kf, suspended: true }).f === 1 && K.factorFor('scooter', { k: kf, suspended: true }).source === 'ausgesetzt', 'kein Faktor auf unplausible Messungen');
  const crs = K.calibrateReport({ pop: 1e6, groups: [{ key: 'Lime|scooter', op: 'Lime', ty: 'scooter', fleet: 100, ridesDay: 900, plausible: false, flags: [K.SUSPENDED] }, { key: 'Dott|scooter', op: 'Dott', ty: 'scooter', fleet: 100, ridesDay: 100, plausible: true, flags: [] }] }, { applied: true, k: 2, kLow: 1.5, kHigh: 3 });
  assert(crs.groups.get('Lime|scooter').factor === 1 && crs.groups.get('Lime|scooter').suspended && crs.totals.ridesDay === 200 && near(crs.totals.rvd, 2), 'Bericht: unplausible E-Scooter-Zeile nicht kalibriert und nicht in der Summe');
  const crn = K.calibrateReport({ pop: 1e6, groups: [{ key: 'Lime|scooter', op: 'Lime', ty: 'scooter', fleet: 100, ridesDay: 900, plausible: false, flags: [K.SUSPENDED] }, { key: 'nb|bike', op: 'nb', ty: 'bike', fleet: 50, ridesDay: 50, plausible: true, flags: [] }] }, { applied: true, k: 2, kLow: 1.5, kHigh: 3 });
  assert(!crn.applied, 'alle E-Scooter-Zeilen ausgesetzt: Bericht gilt als nicht kalibriert (keine Kalibrier-Beschriftung)');
  const pcs = K.plausibilityChecks(ref, { byAgs: { '06412000': { rvd: 9.64 } }, national: { rvd: 1.9 }, voi: { rvd: 3.6, revPerVehicleDay: 5 } }, kfA);
  assert(pcs.find(x => x.key === 'fahrten:06412000').calibrated === null && pcs.find(x => x.key === 'fahrten:06412000').suspended && pcs.find(x => x.unit === '€').calibrated === null && pcs.find(x => x.ref.ort === 'Europa').calibrated != null, 'Prüfwerte: Frankfurt 9,64 und Voi 3,6 über der Grenze → keine kalibrierten Vergleichswerte');
  assert(cov[0].label === 'genehmigte Flotte' && /Untergrenze der Feed-Abdeckung/.test(cov[0].shareLabel) && cov[1].label === 'aktive Flotte', 'Beschriftung: Berlin genehmigte Flotte (Anteil = Untergrenze der Abdeckung), München aktive Flotte');
  // M-5: kalibrierte Werte höchstens bis zur eigenen Überzählungsgrenze (2,31 × 1,5 ≈ 3,47), gekennzeichnet
  {
    const k266 = { applied: true, k: 2.66, kLow: 2.2, kHigh: 3.57 };
    const cv = K.calibrateReport({ pop: 1e6, groups: [{ key: 'Voi|scooter', op: 'Voi', ty: 'scooter', fleet: 100, ridesDay: 202, rvd: 2.02, plausible: true, flags: [] }, { key: 'Dott|scooter', op: 'Dott', ty: 'scooter', fleet: 100, ridesDay: 60, rvd: 0.6, plausible: true, flags: [] }] }, k266, { limits: all.limits });
    const voi = cv.groups.get('Voi|scooter'), dt = cv.groups.get('Dott|scooter');
    assert(near(voi.rvd, all.limits.scooter, 1e-9) && voi.capped && voi.rvdHi <= all.limits.scooter + 1e-9 && near(dt.rvd, 0.6 * 2.66, 1e-9) && !dt.capped && cv.capped, 'M-5: k = 2,66 auf Voi mit RVD 2,02 → kalibriert ≤ 3,47 und gekappt markiert; Dott 0,6 × 2,66 unverändert');
    const ak = K.applyFactor({ rides: 202, ridesDay: 202, rvd: 2.02, revDay: 100 }, 2.66, { limit: all.limits.scooter });
    assert(near(ak.rvd, all.limits.scooter, 1e-9) && ak.capped && near(ak.revDay, 100 * all.limits.scooter / 2.02, 1e-9) && !K.applyFactor({ rvd: 0.5 }, 2, { limit: 3.47 }).capped, 'M-5: applyFactor mit Grenze kappt rvd × f, Umsatz skaliert mit');
    const kA = { ...kfA, k: 2.66 };
    const pk = K.plausibilityChecks(ref, { byAgs: {}, national: { rvd: 2.0 }, voi: { rvd: 3.0, revPerVehicleDay: 5 } }, kA);
    assert(pk.filter(x => x.calibrated != null && x.unit !== '€').every(x => x.calibrated <= all.limits.scooter + 1e-9) && pk.find(x => x.unit === '€').calibrated <= 5 * all.limits.scooter / 3 + 1e-9, 'M-5: Prüfwerte kalibriert höchstens bis zur Grenze');
  }
  // echte Referenzdatei: Regeln greifen auf dem eingecheckten Stand
  const { readFileSync } = await import('node:fs');
  const real = JSON.parse(readFileSync(new URL('../data/reference.json', import.meta.url), 'utf8'));
  const rr = K.rideAssumption(real, 'scooter'), kr = K.methodFactor(real, meas, { day: '2026-11-01' });
  assert(rr.calibrated && rr.n === 5 && near(rr.min, 7.12, 1e-9) && kr.quarter === 'Q4/2025' && real.umsatz?.[0]?.wert === 3.64 && real.fahrt.find(e => e.ags === '08121000').minMittel === 8.7, 'reference.json: fünf Berliner Quartale (Ø 7,1 Min.), Referenzquartal Q4/2025, Voi 3,64 €, Heilbronn Mittel 8,7 Min.');
}
