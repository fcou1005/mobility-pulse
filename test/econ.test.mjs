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
    obergrenzen: [{ ags: '06412000', type: 'scooter', gesamt: 12000, ab: '2026-07-01', gesamtAb: 10500 }],
    kalibrierung: { freigabe: { regelstand: '2026-11-02a', datum: '2026-11-09' } } }; // Z3: Freigabe für den Regelstand der Messung
  const KI = { '11000000|Dott|scooter': 'perTrip', '11000000|Lime|scooter': 'stable' }; // Kennungsart je Gruppe (groupKinds)
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
  const meas = { rvd: 1.075, fleet: 4570, ridesDay: 4913, days: 2, fullDays: 0, obsMin: 276, possibleMin: 2880, from: '2026-10-31', to: '2026-11-01', rule: '2026-11-02a', ruleFullDays: 0, kind: 'perTrip', operators: ['Dott'] };
  const kf = K.methodFactor(ref, meas);
  assert(near(kf.k, 1.72 / 1.075, 1e-9) && kf.quarter === 'Q4/2025' && near(kf.kLow, 1.42 / 1.075, 1e-9) && near(kf.kHigh, 2.31 / 1.075, 1e-9), 'k = 1,72 (Q4/2025) ÷ 1,075 gemessen = 1,60; Spanne aus 1,42 und 2,31');
  assert(kf.prelim && kf.prelimWhy.length === 2 && !K.methodFactor(ref, { ...meas, days: 7, fullDays: 7, ruleFullDays: 7, obsMin: 1500 }).prelim && K.methodFactor(ref, { ...meas, days: 7, fullDays: 7, obsMin: 1500 }).prelim, 'vorläufig unter 7 vollen Messtagen mit Regelstand oder unter 50 % beobachteter Stunden (7 volle Tage ohne Regelstand-Tage bleiben vorläufig)');
  // M-5: vorläufig = nicht angewandt (k nur angezeigt), erst mit 7 vollen Regelstand-Tagen und ≥ 50 % der Stunden
  const kfA = K.methodFactor(ref, { ...meas, days: 7, fullDays: 7, ruleFullDays: 7, obsMin: 1500 });
  assert(!kf.applied && kf.reason === 'vorläufiger Faktor k = 1,60 (1,32–2,15) nicht angewandt: erst 0 von 7 vollen Messtagen mit Regelstand 2026-11-02a; 10 % statt 50 % der Tagesstunden beobachtet' && kfA.applied && !kfA.reason, 'M-5: 2 Messtage → applied false, prelim true, Grund nennt k und Vorbehalte; 7 volle Regelstand-Tage → angewandt');
  // Z3: Zustände gesperrt / vorläufig / angewandt, je Sprache begründet
  {
    const noRel = { ...ref, kalibrierung: { freigabe: null } }, other = { ...ref, kalibrierung: { freigabe: { regelstand: '2026-11-01b', datum: '2026-11-02' } } };
    const m7 = { ...meas, days: 7, fullDays: 7, ruleFullDays: 7, obsMin: 1500 }, l1 = K.methodFactor(noRel, m7), l2 = K.methodFactor(other, m7), l3 = K.methodFactor({ ...ref, kalibrierung: undefined }, m7);
    assert(!l1.applied && l1.status === 'locked' && l1.statusText === 'gesperrt: Freigabe fehlt' && l1.reason === 'Faktor k = 1,60 (1,32–2,15) nicht angewandt – gesperrt: Freigabe fehlt' && !l3.applied && l3.status === 'locked',
      'Z3b: ohne Freigabe (null oder fehlender Block) gesperrt, auch mit 7 vollen Regelstand-Tagen');
    assert(!l2.applied && l2.status === 'locked' && l2.statusText === 'gesperrt: Freigabe gilt für Regelstand 2026-11-01b, Messung hat 2026-11-02a', 'Z3b: Freigabe für einen anderen Regelstand sperrt');
    const p3 = K.methodFactor(ref, { ...m7, ruleFullDays: 3 }), p3en = K.methodFactor(ref, { ...m7, ruleFullDays: 3 }, { lang: 'en' });
    assert(!p3.applied && p3.status === 'prelim' && p3.statusText === 'vorläufig: 3 von 7 vollen Tagen mit Regelstand 2026-11-02a' && p3en.statusText === 'provisional: 3 of 7 full days with rule version 2026-11-02a', 'Z3a: freigegeben, aber erst 3 von 7 Regelstand-Tagen: vorläufig (de/en)');
    const aEn = K.methodFactor(ref, m7, { lang: 'en' });
    assert(kfA.status === 'applied' && kfA.statusText === 'angewandt (freigegeben am 09.11.2026)' && aEn.statusText === 'applied (released on 2026-11-09)' && kfA.refKind === 'perTrip' && /nur für Kennungswechsel je Fahrt wie Dott Berlin/.test(kfA.onlyKind) && aEn.onlyKind.startsWith('k only applies to IDs changing with every trip'),
      'Z3: angewandt mit Freigabedatum; k gilt nur für die Kennungsart der Referenz (de/en)');
    const lockNo = K.methodFactor(noRel, meas), lockEn = K.methodFactor(noRel, meas, { lang: 'en' });
    assert(lockNo.reason === 'Faktor k = 1,60 (1,32–2,15) nicht angewandt – gesperrt: Freigabe fehlt; erst 0 von 7 vollen Messtagen mit Regelstand 2026-11-02a; 10 % statt 50 % der Tagesstunden beobachtet' && lockEn.statusText === 'locked: release missing',
      'Z3: gesperrt und vorläufig zugleich: Grund nennt Freigabe und Regelstand-Tage');
    const mix = K.methodFactor(ref, { ...m7, kind: 'mixed' }), unk = K.methodFactor(ref, { ...m7, kind: null });
    assert(!mix.applied && mix.status === 'off' && /Kennungsart der Berliner Referenz unklar \(gemischte Kennungsarten\)/.test(mix.reason) && !unk.applied && mix.refKind === null, 'Z3c: Berliner Referenz mit gemischter oder unbekannter Kennungsart: kein k');
    // je Gruppe: stabile oder periodisch wechselnde Kennungen bekommen k = 1 und bleiben „gemessen“
    const fs = K.factorFor('scooter', { k: kfA, kind: 'stable' }), fp = K.factorFor('scooter', { k: kfA, kind: 'periodic' }), ft = K.factorFor('scooter', { k: kfA, kind: 'perTrip' }), fn = K.factorFor('scooter', { k: kfA });
    assert(fs.f === 1 && fs.source === 'gemessen' && fs.skip === 'kind' && fs.kind === 'stable' && fp.f === 1 && fp.kind === 'periodic' && near(ft.f, kfA.k) && ft.source === 'kalibriert' && fn.f === 1 && fn.kind === 'unknown', 'Z3c: factorFor – k nur für Kennungswechsel je Fahrt; stabile/periodische/unbekannte Kennungen Faktor 1');
    assert(K.kindText('stable') === 'stabile Kennungen' && K.kindText('stable', 'en') === 'stable IDs' && K.kindText('periodic', 'en') === 'periodically rotating IDs', 'Kennungsart je Sprache');
    const crk = K.calibrateReport({ ags: '06412000', pop: 1e6, groups: [{ key: 'Lime|scooter', op: 'Lime', ty: 'scooter', fleet: 100, ridesDay: 260, rvd: 2.6, plausible: true, flags: [] }, { key: 'Dott|scooter', op: 'Dott', ty: 'scooter', fleet: 100, ridesDay: 70, rvd: 0.7, plausible: true, flags: [] }] },
      kfA, { kinds: { '06412000|Lime|scooter': 'periodic', '06412000|Dott|scooter': 'perTrip' } });
    assert(crk.applied && crk.groups.get('Lime|scooter').factor === 1 && crk.groups.get('Lime|scooter').skipKind === 'periodic' && near(crk.groups.get('Dott|scooter').factor, kfA.k) && crk.skipped.length === 1 && crk.skipped[0].op === 'Lime' && near(crk.totals.ridesDay, 260 + 70 * kfA.k),
      'Z3c: Bericht – Lime (periodisch) bleibt gemessen, Dott (je Fahrt) × k; skipped nennt Lime');
    const pck = K.plausibilityChecks(ref, { byAgs: { '06412000': { rvd: 2.64, kind: 'periodic' } }, national: { rvd: 1.0, kind: 'mixed' }, voi: { rvd: 1.5, revPerVehicleDay: 3, kind: 'perTrip' } }, kfA);
    assert(pck.find(x => x.key === 'fahrten:06412000').calibrated === null && pck.find(x => x.key === 'fahrten:06412000').measured === 2.64 && pck.find(x => x.ref.ort === 'Europa').calibrated === null && near(pck.find(x => x.ref.ort === 'Voi gesamt' && !x.unit).calibrated, 1.5 * kfA.k),
      'Z3c: Frankfurt (Lime periodisch) nur gegen die amtliche Untergrenze geprüft, ohne k; Deutschland gemischt ohne k; Voi (je Fahrt) mit k');
    // Abdeckung/Hochrechnung je Stadt (Kalibrier-Panel): k nur bei passender Kennungsart, höchstens bis zur Grenze (bisher rv × k ungeprüft)
    const lim = K.rvdLimits(ref).scooter, cv = (rvd, kind, kk = kfA) => K.calibratedRvd(rvd, kk, { kind, limit: lim });
    const okC = cv(1.2, 'perTrip'), capC = cv(2.6, 'perTrip'), perC = cv(2.6, 'periodic'), mixC = cv(1.2, 'mixed'), susC = cv(lim + 0.1, 'perTrip'), offC = cv(1.2, 'perTrip', kf);
    assert(near(okC.rvd, 1.2 * kfA.k) && !okC.capped && near(capC.rvd, lim) && capC.capped && perC.rvd === null && perC.skip === 'kind' && perC.kind === 'periodic' && mixC.skip === 'kind' && susC.rvd === null && susC.skip === 'suspended' && offC.rvd === null && offC.skip === 'off',
      `Abdeckung: k je Stadt nur für Kennungswechsel je Fahrt (1,2 → ${okC.rvd?.toFixed(2)}), über der Grenze gekappt (2,6 → ${capC.rvd?.toFixed(2)}), periodisch/gemischt gemessen, Überzählung ausgesetzt, k nicht angewandt = gemessen`);
  }
  assert(K.factorFor('scooter', { k: kf }).f === 1 && K.factorFor('scooter', { k: kf }).source === 'gemessen', 'M-5: vorläufiges k wirkt nicht auf die Fahrten');
  assert(!K.methodFactor(ref, null).applied && /keine Berliner/.test(K.methodFactor(ref, { ...meas, rvd: null }).reason) && !K.methodFactor({}, meas).applied && !K.methodFactor(ref, { ...meas, rvd: 0.1 }).applied, 'keine Kalibrierung ohne Berliner Messung, ohne Quartalswerte oder bei unplausiblem Faktor (> 5)');
  // Faktor je Gruppe: Korrektur übersteuert, k nur E-Scooter im Modus „kalibriert“
  assert(K.factorFor('scooter', { k: kfA, kind: 'perTrip' }).source === 'kalibriert' && K.factorFor('ebike', { k: kfA }).f === 1 && K.factorFor('scooter', { k: kfA, mode: 'mess' }).f === 1 && K.factorFor('scooter', { k: kfA, manual: 1.3 }).f === 1.3 && K.factorFor('scooter', { k: kfA, manual: 1.3 }).source === 'Korrektur', 'Faktor: Korrektur × übersteuert, k nur für E-Scooter, „gemessen“ ohne Faktor');
  const kk = K.applyFactor(kc, 2);
  assert(near(kk.ridesDay, 2 * kc.ridesDay) && near(kk.rvd, 2 * kc.rvd) && near(kk.utilization, 2 * kc.utilization) && near(kk.revDay, 2 * kc.revDay) && near(kk.perRide, kc.perRide) && near(kk.fleet, kc.fleet), 'Faktor skaliert Fahrten, RVD, Auslastung, Umsatz; Preis je Fahrt und Flotte bleiben');
  const rep = { pop: 1e6, groups: [{ key: 'Dott|scooter', op: 'Dott', ty: 'scooter', fleet: 100, ridesDay: 100, plausible: true }, { key: 'nb|bike', op: 'nb', ty: 'bike', fleet: 50, ridesDay: 50, plausible: true }] };
  const cr = K.calibrateReport(rep, { applied: true, k: 2, kLow: 1.5, kHigh: 3 });
  assert(cr.applied && cr.groups.get('Dott|scooter').ridesDay === 200 && cr.groups.get('nb|bike').ridesDay === 50 && cr.totals.ridesDay === 250 && cr.totals.lo === 200 && cr.totals.hi === 350 && near(cr.totals.rvd, 250 / 150) && near(cr.totals.per1000Rides, 0.25), 'Bericht kalibriert: nur E-Scooter × k, Spanne aus kLow/kHigh, Summen');
  // 3. Abdeckung
  const cov = K.fleetCoverage(ref, { '11000000|Dott|scooter': { total: 4557 }, '11000000|nextbike|bike': { total: 999 }, '09162000|Dott|scooter': { total: 3392 } });
  assert(cov.length === 2 && cov[0].ours === 4557 && near(cov[0].share, 4557 / 46450) && cov[0].art === 'genehmigt' && near(cov[1].share, 3392 / 21000), 'Abdeckung: eigene E-Scooter ÷ amtliche Flotte (Berlin 9,8 %, München 16 %)');
  // 4. Plausibilität
  const pc = K.plausibilityChecks(ref, { byAgs: { '06412000': { rvd: 1.2, kind: 'perTrip' } }, national: { rvd: 1.0, kind: 'perTrip' }, voi: { rvd: 2, revPerVehicleDay: 5, kind: 'perTrip' } }, kfA);
  const ff = pc.find(x => x.key === 'fahrten:06412000');
  assert(ff && ff.kind === 'Untergrenze' && ff.limit === 12000 && near(ff.refValue, 10490000 / 365 / 12000, 1e-9) && near(ff.calibrated, 1.2 * kfA.k, 1e-9), 'Frankfurt: 10,49 Mio. ÷ 365 ÷ 12.000 (Obergrenze 2025) = Untergrenze 2,39');
  assert(pc.some(x => x.ref.ort === 'Europa' && x.measured === 1) && pc.some(x => x.ref.ort === 'Voi gesamt' && x.measured === 2 && x.kind === 'Vergleich') && pc.some(x => x.unit === '€' && x.measured === 5 && near(x.ratio, 5 / 3.64)), 'Europa und Voi (Fahrten und Umsatz je Fahrzeug) als Vergleich ohne Faktor');
  const bRep = (groups, q = {}) => ({ ags: '11000000', quality: { fullDays: 0, obsMin: 276, possibleMin: 2880, rule: '2026-11-02a', ruleFullDays: 0, ...q }, days: ['2026-10-31', '2026-11-01'], from: '2026-10-31', to: '2026-11-01', groups });
  const dott = { op: 'Dott', ty: 'scooter', plausible: true, flags: [], ridesDay: 4913, fleet: 4570, rides: 681, rvd: 4913 / 4570 };
  const all = K.calibration(ref, { berlinReport: bRep([dott]), groups: {}, kinds: KI });
  assert(all.k.measured.rule === '2026-11-02a' && all.k.measured.kind === 'perTrip' && all.k.measured.sources[0].kind === 'perTrip' && K.measuredFromReport(bRep([dott])).kind === null, 'Vertrag 2: Messung trägt Regelstand und Kennungsart der Berliner Anbieter (ohne kinds: null)');
  assert(!all.k.applied && all.k.prelim && !K.calibration(ref, { berlinReport: bRep([dott], { fullDays: 7, obsMin: 1500 }), groups: {}, kinds: KI }).k.applied && K.calibration(ref, { berlinReport: bRep([dott], { fullDays: 7, ruleFullDays: 7, obsMin: 1500 }), groups: {}, kinds: KI }).k.applied && near(all.k.k, 1.72 / (4913 / 4570), 1e-9) && all.assume.scooter.calibrated && all.coverage.length === 2 && near(all.limits.scooter, 2.31 * 1.5, 1e-9), 'Kalibrierung gesamt aus Berliner Bericht; Plausibilitätsgrenze 2,31 × 1,5');
  // Herkunft von k offenlegen, Einschränkung bei nur einem Anbieter; unplausible Berliner Anbieter gehen nicht in k ein
  assert(all.k.source === 'aus Dott Berlin, 681 Fahrten, 4,6 Messstunden' && /nur aus einem Anbieter \(Dott\)/.test(all.k.single), 'k: Herkunft „aus Dott Berlin, n Fahrten, x Messstunden“ und Hinweis auf nur einen Anbieter');
  const lime = { op: 'Lime', ty: 'scooter', plausible: false, flags: [K.SUSPENDED], ridesDay: 9000, fleet: 1000, rides: 900, rvd: 9 };
  const two = K.calibration(ref, { berlinReport: bRep([dott, lime]), groups: {} });
  assert(near(two.k.k, all.k.k, 1e-9) && two.k.measured.excluded[0].op === 'Lime' && two.k.single && two.k.source.startsWith('aus Dott Berlin'), 'unplausibler Berliner Anbieter (Lime) geht nicht in k ein und wird als ausgeschlossen geführt');
  const none = K.calibration(ref, { berlinReport: bRep([lime]), groups: {} });
  assert(!none.k.applied && /keine plausible Berliner/.test(none.k.reason) && /Lime/.test(none.k.reason), 'nur unplausible Berliner Messung: keine Kalibrierung, Grund nennt den Anbieter');
  // Englische Oberfläche (lang 'en'): Texte übersetzt, Zahlen mit Dezimalpunkt, Kennungen (kind, Flags) sprachunabhängig, Werte gleich
  const allEn = K.calibration(ref, { berlinReport: bRep([dott]), groups: {}, lang: 'en', kinds: KI });
  assert(allEn.lang === 'en' && allEn.k.source === 'from Dott Berlin, 681 trips, 4.6 measured hours' && /^k comes from only one operator \(Dott\)/.test(allEn.k.single) && near(allEn.k.k, all.k.k, 1e-12) && allEn.k.rule === 'same quarter of the previous year',
    'EN: Herkunft „from Dott Berlin, 681 trips, 4.6 measured hours“, Hinweis auf einen Anbieter, Referenzregel; k unverändert');
  assert(allEn.k.prelimWhy.join(' | ') === 'only 0 of 7 full measurement days with rule version 2026-11-02a | 10 % instead of 50 % of the hours of the day observed' && /^provisional factor k = 1\.60 \(1\.32–2\.15\) not applied: only 0/.test(allEn.k.reason) && allEn.assume.ebike.label === 'assumption (no official evidence)' && allEn.coverage[0].label === 'licensed fleet' && allEn.coverage[0].shareLabel.startsWith('Share of the licensed fleet'),
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
  const pcs = K.plausibilityChecks(ref, { byAgs: { '06412000': { rvd: 9.64, kind: 'perTrip' } }, national: { rvd: 1.9, kind: 'perTrip' }, voi: { rvd: 3.6, revPerVehicleDay: 5, kind: 'perTrip' } }, kfA);
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
    const pk = K.plausibilityChecks(ref, { byAgs: {}, national: { rvd: 2.0, kind: 'perTrip' }, voi: { rvd: 3.0, revPerVehicleDay: 5, kind: 'perTrip' } }, kA);
    assert(pk.filter(x => x.calibrated != null && x.unit !== '€').length === 2 && pk.filter(x => x.calibrated != null && x.unit !== '€').every(x => x.calibrated <= all.limits.scooter + 1e-9) && near(pk.find(x => x.unit === '€').calibrated, 5 * all.limits.scooter / 3, 1e-9), 'M-5: Prüfwerte kalibriert höchstens bis zur Grenze');
  }
  // echte Referenzdatei: Regeln greifen auf dem eingecheckten Stand
  const { readFileSync } = await import('node:fs');
  const real = JSON.parse(readFileSync(new URL('../data/reference.json', import.meta.url), 'utf8'));
  const rr = K.rideAssumption(real, 'scooter'), kr = K.methodFactor(real, meas, { day: '2026-11-01' });
  assert(rr.calibrated && rr.n === 5 && near(rr.min, 7.12, 1e-9) && kr.quarter === 'Q4/2025' && real.umsatz?.[0]?.wert === 3.64 && real.fahrt.find(e => e.ags === '08121000').minMittel === 8.7, 'reference.json: fünf Berliner Quartale (Ø 7,1 Min.), Referenzquartal Q4/2025, Voi 3,64 €, Heilbronn Mittel 8,7 Min.');
  // Z3b: eingecheckt ist k für Regelstand 2026-11-02a freigegeben (Felix, 02.11.2026): wirkt erst mit 7 vollen Tagen dieses Regelstands,
  // nicht für einen anderen Regelstand und nicht mit weniger Tagen
  { const kz = K.methodFactor(real, { ...meas, rule: '2026-11-02a', ruleFullDays: 7, obsMin: 2880 }), k3 = K.methodFactor(real, { ...meas, rule: '2026-11-02a', ruleFullDays: 3, obsMin: 2880 }),
      ko = K.methodFactor(real, { ...meas, rule: '2026-11-01b', ruleFullDays: 7, obsMin: 2880 });
    assert(real.kalibrierung?.freigabe?.regelstand === '2026-11-02a' && kz.applied && kz.release?.regelstand === '2026-11-02a' && !k3.applied && k3.status !== 'applied' && !ko.applied && ko.status !== 'applied',
      'reference.json: Freigabe 2026-11-02a → k erst mit 7 vollen Tagen dieses Regelstands; 3 Tage bzw. anderer Regelstand → nicht angewandt'); }
  // Düsseldorf (SMM-CPI 2025) und Voi FY2025 je Fahrt als Plausibilitätsprobe, nicht als Schätzer
  {
    const du = real.rvd.find(e => e.ags === '05111000'), vr = real.umsatz.find(e => e.einheit === '€ je Fahrt');
    assert(du && du.type === 'all' && du.wert === 1.8 && du.flotteJe1000 === 13.9 && du.fahrtenJe1000 === 25.7 && /Jahresmittel, alle Arten, MDS/.test(du.hinweis) && /scoop2\.city/.test(du.url) && vr?.wert === 1.54 && vr.zeitraum === '2025',
      'reference.json: Düsseldorf 1,8 / 13,9 / 25,7 (Jahresmittel, alle Arten, MDS), Voi 2025 1,54 € je Fahrt');
    const kD = { ...kfA, k: 2 };
    const pd = K.plausibilityChecks(real, { byAgs: {}, byAgsAll: { '05111000': { rvd: 1.36, per1000Fleet: 14.1, per1000Rides: 19.2, rvdCal: 2.1, per1000RidesCal: 29 } }, national: {}, voi: { rvd: 1.5, revPerVehicleDay: 2.4, revPerRide: 1.6, kind: 'perTrip' } }, kD);
    const g = (k) => pd.find(x => x.key.startsWith(k));
    assert(near(g('rvd:05111000').refValue, 1.8) && g('rvd:05111000').measured === 1.36 && g('rvd:05111000').calibrated === 2.1 && near(g('flotteJe1000:05111000').ratio, 14.1 / 13.9, 1e-9) && g('flotteJe1000:05111000').calibrated === null
      && g('fahrtenJe1000:05111000').calibrated === 29 && g('rvd:05111000').label === 'Düsseldorf: Fahrten je Fahrzeug und Tag' && g('rvd:05111000').scope === 'Düsseldorf, alle Fahrzeugarten in offenen Feeds',
      'Plausibilität Düsseldorf: drei Prüfwerte gegen die eigene Messung aller Arten, kalibriert nur aus byAgsAll');
    const ur = g('umsatzFahrt:Voi'), uv = g('umsatz:Voi');
    assert(ur && ur.unit === '€' && ur.perRide && ur.measured === 1.6 && near(ur.ratio, 1.6 / 1.54, 1e-9) && ur.calibrated === null && uv.measured === 2.4 && near(uv.calibrated, 4.8, 1e-9) && !pd.some(x => x.key.startsWith('rvd:11000000')),
      'Voi € je Fahrt: Umsatz ÷ Fahrten ohne Faktor; € je Fahrzeug und Tag weiter mit k; Berliner Quartale nicht als Prüfwert');
  }
  // Z3c: Kennungsart je Gruppe aus srcModes, Quellen und Wechseltakt (synthetisch)
  {
    const runs = [...Array(30)].map((_, i) => [Date.parse('2026-11-03T05:00:00Z') + i * 20 * 60e3, i ? 20 * 60e3 : null, 1]);
    const arr = (v) => new Array(24).fill(v);
    const doc = { day: '2026-11-03', runs, srcModes: { a: 'rotating', b: 'rotating', c: 'stable', d: 'unknown', e1: 'stable', e2: 'rotating' }, groups: {
      '1|Dott|scooter': { rot: arr(2), vminTot: arr(1000 * 60) }, '2|Lime|scooter': { rot: arr(3000), vminTot: arr(1000 * 60) }, '3|Lime|scooter': { rot: arr(0), vminTot: arr(500 * 60) },
      '4|X|scooter': { rot: arr(0), vminTot: arr(60) }, '5|Y|bike': { rot: arr(0), vminTot: arr(60) }, '6|Dott|scooter': { rot: arr(0), vminTot: arr(10) } } };
    const src = [{ id: 'a', operator: 'Dott', municipalities: ['1', '6'] }, { id: 'b', operator: 'Lime', municipalities: ['2'] }, { id: 'c', operator: 'Lime', municipalities: ['3'] }, { id: 'd', operator: 'X', municipalities: ['4'] }, { id: 'e1', operator: 'Y', municipalities: ['5'] }, { id: 'e2', operator: 'Y', municipalities: ['5'] }];
    const kd = K.groupKinds([doc], src);
    assert(kd['1|Dott|scooter'] === 'perTrip' && kd['2|Lime|scooter'] === 'periodic' && kd['3|Lime|scooter'] === 'stable' && kd['4|X|scooter'] === 'unknown' && kd['5|Y|bike'] === 'mixed' && kd['6|Dott|scooter'] === 'rotating',
      'groupKinds: wenig Wechsel je Fahrzeug und Lauf = je Fahrt, ≥ 0,2 = periodisch, stabil aus srcModes, unbekannt/gemischt, zu wenig Fahrzeugläufe = wechselnd ohne Takt');
    assert(K.commonKind(['perTrip', 'perTrip']) === 'perTrip' && K.commonKind(['perTrip', 'stable']) === 'mixed' && K.commonKind([]) === null, 'commonKind');
  }
  // Z3 auf dem echten Datenstand (.realdata, falls vorhanden): Dott Berlin je Fahrt, Lime Frankfurt periodisch, Lime BW stabil; heute kein k;
  // mit Freigabe und 7 vollen Regelstand-Tagen (simuliert) angewandt, aber nicht für Lime
  {
    const { existsSync } = await import('node:fs'); const RD = new URL('../.realdata/', import.meta.url);
    if (existsSync(new URL('events/index.json', RD)) && existsSync(new URL('latest.json', RD))) {
      const R = await import('../lib/pulse-report.js');
      const J = (f) => JSON.parse(readFileSync(new URL(f, RD), 'utf8'));
      const days = (J('events/index.json').days || []).filter(d => existsSync(new URL(`events/${d}.json`, RD))), docs = days.map(d => J(`events/${d}.json`));
      const latest = J('latest.json'), daily = existsSync(new URL('history/daily.json', RD)) ? J('history/daily.json') : null;
      const H = Object.fromEntries(days.map(d => [d, R.histFromDaily(daily, d)]).filter(x => x[1])), limits = K.rvdLimits(real);
      const kinds = K.groupKinds(docs, latest.sources);
      assert(kinds['11000000|Dott|scooter'] === 'perTrip' && kinds['06412000|Lime|scooter'] === 'periodic' && kinds['08111000|Lime|scooter'] === 'stable' && kinds['08111000|Voi|scooter'] === 'perTrip',
        'Datenstand: Dott Berlin Kennungswechsel je Fahrt, Lime Frankfurt periodisch, Lime Stuttgart (lime_bw) stabil, Voi je Fahrt');
      const br = R.municipalReport({ docs, hists: H, ags: K.BERLIN, type: 'scooter', rvdLimit: limits });
      const c = K.calibration(real, { berlinReport: br, groups: latest.groups, kinds });
      assert(!c.k.applied && c.k.status !== 'applied' && c.k.refKind === 'perTrip' && br.quality.rule === '2026-11-01b' && br.quality.ruleFullDays === 0,
        `Datenstand: kein k (gesperrt, Regelstand ${br.quality.rule}, ${br.quality.ruleFullDays} volle Regelstand-Tage; k wäre ${c.k.k?.toFixed(2)})`);
      const rel = { ...real, kalibrierung: { freigabe: { regelstand: br.quality.rule, datum: '2026-11-09' } } }, m = K.measuredFromReport(br, kinds);
      const k7 = K.methodFactor(rel, { ...m, ruleFullDays: 7, obsMin: m.possibleMin }), kp = K.methodFactor(rel, m);
      assert(k7.applied && k7.status === 'applied' && !kp.applied && kp.status === 'prelim', 'Datenstand mit Freigabe: angewandt erst mit 7 vollen Regelstand-Tagen (simuliert), sonst vorläufig');
      const st = R.municipalReport({ docs, hists: H, ags: '08111000', type: 'scooter', rvdLimit: limits }), cs = K.calibrateReport(st, k7, { limits, kinds });
      const ff = R.municipalReport({ docs, hists: H, ags: '06412000', type: 'scooter', rvdLimit: limits }), cf = K.calibrateReport(ff, k7, { limits, kinds });
      assert(cs.applied && cs.groups.get('Lime|scooter')?.factor === 1 && cs.groups.get('Lime|scooter').skipKind === 'stable' && cs.groups.get('Dott|scooter')?.calibrated && !cf.applied && cf.groups.get('Lime|scooter')?.skipKind === 'periodic'
        && K.factorFor('scooter', { k: k7, kind: kinds['08111000|Lime|scooter'] }).f === 1,
        'Datenstand mit Freigabe: Stuttgart Dott × k, Lime (stabil) gemessen; Frankfurt Lime (periodisch) gemessen, nur gegen die amtliche Untergrenze geprüft');
    } else console.log('übersprungen: .realdata fehlt (Z3-Datenstand-Test)');
  }
}
// ---------- Messbasis: Tagtyp-Kalender, Tagesgang je Tagtyp, Reifegrad, Ampel (Agent M) ----------
{
  // lokale Feiertagsrechnung (ohne Kalender)
  assert(E.dayType('2026-11-01', 'BW') === 'H' && E.dayType('2026-10-31', 'BW') === 'S' && E.dayType('2026-10-31', 'NI') === 'H' && E.dayType('2026-11-02', 'BY') === 'W'
    && E.dayType('2026-11-18', 'SN') === 'H' && E.dayType('2026-11-18', 'BW') === 'W' && E.dayType('2026-12-25', null) === 'H' && E.dayType('2026-01-06', null) === 'W' && E.dayType('2025-08-15', 'BY') === 'W' && E.dayType('2025-08-15', 'SL') === 'H' && E.dayType('x', 'BW') === null,
    'dayType ohne Kalender: Sonntag/Feiertag H (Allerheiligen BW, Reformationstag NI am Samstag, Buß- und Bettag SN), Samstag S, Deutschland nur bundesweite Feiertage, Mariä Himmelfahrt BY nur teilweise');
  const pub = [{ startDate: '2026-11-01', endDate: '2026-11-01', type: 'Public', nationwide: false, subdivisions: [{ code: 'DE-BW' }, { code: 'DE-BY' }] },
    { startDate: '2026-12-25', endDate: '2026-12-25', type: 'Public', nationwide: true, subdivisions: null },
    { startDate: '2026-11-04', endDate: '2026-11-04', type: 'Public', nationwide: false, subdivisions: [{ code: 'DE-BY' }] },
    { startDate: '2026-11-11', endDate: '2026-11-11', type: 'Public', nationwide: false, regionalScope: 'Local', subdivisions: [{ code: 'DE-BY-AU' }] },
    { startDate: '2026-12-24', endDate: '2026-12-24', type: 'Public', temporalScope: 'HalfDay', nationwide: true }];
  const school = [{ startDate: '2026-11-02', endDate: '2026-11-06', type: 'School', nationwide: false, subdivisions: [{ code: 'DE-BY' }] },
    { startDate: '2026-10-31', endDate: '2026-10-31', type: 'School', nationwide: false, subdivisions: [{ code: 'DE-BW' }] }];
  const cal = E.calendarFromApi(pub, school, { from: '2026-10-30', to: '2026-12-31', at: Date.parse('2026-11-02T08:00:00Z') });
  assert(cal?.version === 1 && cal.source === E.CALENDAR_SOURCE && cal.from === '2026-10-30' && cal.generatedAt === '2026-11-02T08:00:00.000Z' && Object.keys(cal.states).length === 16
    && cal.states.BY['2026-11-02'] === 'F' && cal.states.BY['2026-11-04'] === 'H' && cal.states.BY['2026-11-01'] === 'H' && !cal.states.BW['2026-10-31'] && !cal.states.BY['2026-11-11'] && !cal.states.BE['2026-12-24'] && cal.states.BE['2026-12-25'] === 'H',
    'calendarFromApi: nur Ausnahmen je Land, Feiertag vor Ferien, Ferien nur Mo–Fr, örtliche (DE-BY-AU) und halbe Tage ausgelassen');
  assert(E.dayType('2026-11-02', 'BY', cal) === 'F' && E.dayType('2026-11-02', 'BW', cal) === 'W' && E.dayType('2026-11-04', 'BY', cal) === 'H' && E.dayType('2026-11-07', 'BY', cal) === 'S' && E.dayType('2027-01-01', 'BW', cal) === 'H' && E.dayType('2027-01-06', 'NI', cal) === 'W',
    'dayType mit Kalender: Ferienwerktag F, Feiertag aus dem Kalender, außerhalb des Zeitraums lokale Rechnung');
  assert(E.calendarFromApi({ error: 'x' }, [], { from: '2026-10-30', to: '2026-12-31' }) === null && E.calendarFromApi([], [], { from: '2025-09-28', to: '2027-12-06' }) === null && E.calendarFromApi(pub, school, { from: '2025-09-28', to: '2027-12-06' }) === null,
    'calendarFromApi: Fehlerobjekt, leere oder für 800 Tage zu dünne Antwort → null (alte Datei bleibt)');
  // Tagesgang je Tagtyp: 3 Werktage mit Spitze um 8 Uhr, ein Sonntag mit Spitze um 15 Uhr
  const mk = (d, peak, rule = null) => ({ day: d, runs: day.runs.map(r => (rule ? [r[0], r[1], 1, rule] : r)), groups: { a: { start: [...Array(24)].map((_, h) => (h === peak ? 40 : 10)) } } });
  const docs = [mk('2026-11-02', 8), mk('2026-11-03', 8), mk('2026-11-04', 8), mk('2026-11-08', 15)];
  const pW = E.hourProfile(docs, { dayType: 'W', land: 'BW' }), pH = E.hourProfile(docs, { dayType: 'H', land: 'BW' }), pA = E.hourProfile(docs);
  assert(pW.basis === 'W' && pW.days === 3 && pW.source === 'gemessen (3 Tage)' && pW.profile[8] > pW.profile[15] * 3 && pW.typeDays.W === 3 && pW.typeDays.H === 1
    && pH.basis === 'Standardkurve' && pH.profile === E.DEFAULT_PROFILE && pH.days === 1 && pA.basis === 'alle' && pA.days === 4,
    'hourProfile je Tagtyp: nur Tage desselben Typs, unter 3 solchen Tagen Standardkurve (basis nennt die Quelle der Kurve)');
  { const pF = E.hourProfile(docs, { dayType: 'F', land: 'BY', calendar: cal }); assert(pF.typeDays.F === 2 && pF.typeDays.H === 2 && pF.typeDays.W === 0 && pF.basis === 'Standardkurve', 'hourProfile mit Kalender: Bayern 02./03.11. Ferienwerktage, 04.11. Feiertag – 2 Tage Typ F reichen nicht'); }
  // Messbasis und Reifegrad
  const R1 = '2026-11-02a@abc1234', md = E.measureDay(mk('2026-11-02', 8, R1));
  const gapDoc = { ...mk('2026-11-05', 8, R1), gapHours: [5] }, mg = E.measureDay(gapDoc);
  assert(md.full && md.counted === 72 && md.rules.join() === '2026-11-02a' && md.obs[8] === 60 && mg.obs[5] === 0 && mg.full && E.ruleVersion([0, 1, 1, R1]) === '2026-11-02a' && E.ruleVersion([0, 1, 1]) === null,
    'measureDay: Minuten je Stunde ohne Lücken-Stunden, gezählte Läufe, Regelstand vor „@“, voller Tag');
  const old = E.measureDay(mk('2026-11-01', 8)); const days = { '2026-11-01': old, '2026-11-02': md, '2026-11-03': E.measureDay(mk('2026-11-03', 8, R1)), '2026-11-04': E.measureDay(mk('2026-11-04', 8, R1)), '2026-11-07': { obs: new Array(24).fill(0).map((_, h) => (h > 20 ? 40 : 0)), rules: ['2026-11-02a'], full: false } };
  const base = E.measureBase(days, { land: 'BW' });
  assert(base.rule === '2026-11-02a' && base.fullRule.W === 3 && base.full.H === 1 && base.fullRule.H === 0 && base.ruleFullDays === 3 && base.types.join() === 'W,S,H' && base.matrix.W[8] === 180 && near(base.byType.S, 2, 1e-9) && base.days.S === 1,
    `measureBase: volle Tage je Tagtyp mit einheitlichem Regelstand (W ${base.fullRule.W}), Matrix Stunde × Tagtyp, Altlauf ohne Regelstand zählt nicht`);
  const m3 = E.maturity(base, 'full3', { dayType: 'W' }), mS = E.maturity(base, 'full3', { dayType: 'S' }), m14 = E.maturity(base, 'weeks2'), m0 = E.maturity(base, 'now');
  assert(m3.met && m3.have === 3 && !mS.met && mS.have === 0 && !m14.met && m14.want === 14 && m0.met && E.maturity(base, 'full3').dayType === 'W' && !E.maturity(null, 'weeks4').met, 'maturity: ab 3 vollen Tagen gleichen Typs und Regelstands, ab 2/4 Wochen, sofort');
  // Ampel je Gruppe
  const H24 = (f) => [...Array(24)].map((_, h) => f(h));
  const ev = { day: '2026-11-02', runs: day.runs, groups: {
    'A|Lime|scooter': { start: H24(h => 10 + h), end: H24(h => 10 + h), pickup: H24(h => 5 + h), swap: H24(() => 0) },
    'A|Voi|scooter': { start: H24(h => 10 + (h % 5)), end: H24(h => 10 + (h % 5)), pickup: H24(() => 0), swap: H24(() => 1) },
    'A|Bolt|scooter': { start: H24(() => 10), end: H24(() => 20), pickup: H24(() => 0), swap: H24(() => 1) },
    'A|Dott|scooter': { start: H24(() => 3), end: H24(() => 3), swap: H24(() => 1) },
    'A|Hid|scooter': { start: H24(() => 10), end: H24(() => 10), swap: H24(() => 1), hide: H24(() => 3) },
    'A|Tiny|bike': { start: H24(() => 1), end: H24(() => 1) }, 'DE|Lime|scooter': { start: H24(() => 99) } } };
  const ec = E.eventChecks(ev, [{ operator: 'Dott', status: 'live', municipalities: ['A'], batteryFloor: { p005: 15, p001: 13, n: 1200, hides: true }, idleUnusable: true, idleCheck: { n: 300, shortShare: 0.97 } },
    { operator: 'Voi', status: 'error', municipalities: ['A'], batteryFloor: 30 }, { operator: 'Hid', status: 'live', municipalities: ['A'], batteryFloor: 16 }]);
  const G = ec.groups;
  assert(G['A|Lime|scooter'].level === 'bad' && G['A|Lime|scooter'].checks.flags.join() === 'pickup,swap0' && near(G['A|Lime|scooter'].checks.pickupShare, 0.434, 0.001) && G['A|Lime|scooter'].checks.r === 1
    && G['A|Voi|scooter'].level === 'ok' && G['A|Voi|scooter'].checks.r === null && G['A|Bolt|scooter'].level === 'warn' && G['A|Bolt|scooter'].checks.se === 0.5
    && G['A|Dott|scooter'].level === 'warn' && G['A|Dott|scooter'].checks.flags.join() === 'idle,batteryFloor' && G['A|Dott|scooter'].checks.batteryFloor === 15 && G['A|Hid|scooter'].checks.flags.join() === 'hide'
    && !G['A|Tiny|bike'] && !G['DE|Lime|scooter'] && ec.day === '2026-11-02' && ec.rules.pickupBad === 0.2,
    'eventChecks: Abholung im Takt der Fahrten rot, S/E 0,5 gelb, 0 Tausche bei ≥ 300 Fahrten, Quellenfelder (batteryFloor, idleUnusable) und hide tolerant gelesen, kleine Gruppen ausgelassen');
  assert([...E.ampelRed(ec)].join() === 'A|Lime|scooter' && E.ampelRed(null).size === 0 && E.eventChecks(null) === null, 'ampelRed: nur rote Gruppen');
  // Regelstand des ausgewerteten Tags (Teil vor „@“): rot schließt nur aus, wenn er dem aktuellen entspricht; älterer oder gemischter Tag = gelb mit Hinweis
  const evR = (rules) => ({ ...ev, runs: ev.runs.map((r, i) => (rules[i % rules.length] ? [r[0], r[1], 1, rules[i % rules.length]] : [r[0], r[1], 1])) });
  const ecOld = E.eventChecks(evR(['2026-11-01b@x']), [], E.EVENT_CHECKS, { ruleNow: '2026-11-02a' }), ecMix = E.eventChecks(evR(['2026-11-02a@y', '']), [], E.EVENT_CHECKS, { ruleNow: '2026-11-02a' });
  const ecCur = E.eventChecks(evR(['2026-11-02a@y', '2026-11-02a@z']), [], E.EVENT_CHECKS, { ruleNow: '2026-11-02a' });
  const lO = ecOld.groups['A|Lime|scooter'], lM = ecMix.groups['A|Lime|scooter'];
  assert(ecOld.dayRules.join() === '2026-11-01b' && ecOld.ruleNow === '2026-11-02a' && ecOld.ruleCurrent === false && lO.level === 'warn' && lO.was === 'bad' && lO.checks.flags.join() === 'pickup,swap0,oldRule' && E.ampelRed(ecOld).size === 0
    && ecMix.dayRules.join() === ',2026-11-02a' && ecMix.ruleCurrent === false && lM.level === 'warn' && lM.checks.oldRule.join() === ',2026-11-02a'
    && ecCur.ruleCurrent === true && ecCur.dayRules.join() === '2026-11-02a' && ecCur.groups['A|Lime|scooter'].level === 'bad' && [...E.ampelRed(ecCur)].join() === 'A|Lime|scooter'
    && ec.ruleCurrent === null && G['A|Lime|scooter'].level === 'bad' && ecOld.groups['A|Bolt|scooter'].level === 'warn' && !ecOld.groups['A|Bolt|scooter'].was,
    'eventChecks: Regelstand des Tags mitgeführt (dayRules, gemischt erkennbar); rot nur bei aktuellem Regelstand, sonst gelb „älterer Regelstand“ (was: bad), kein Ausschluss; ohne ruleNow wie bisher');
}

// Annahmen für E-Roller und Carsharing (08.11.2026)
assert(E.DEFAULT_RIDE.car.min === 180 && E.DEFAULT_RIDE.moped.km === 5 && E.DEFAULT_RIDE.scooter.min === 12, 'DEFAULT_RIDE: Carsharing 180 Min./40 km, E-Roller 18 Min./5 km, E-Scooter unverändert');
{
  const pricing = { plans: [{ operator: 'stadtmobil', municipalities: ['08111000'], plans: [{ id: 'small_hour_daytime', name: 'Kleinwagen Stunde Tag', perMin: [{ start: 0, rate: 3, interval: 60 }], perKm: [{ start: 0, rate: 0.3, interval: 1 }] }] }] };
  const pf = E.planFor(pricing, 'stadtmobil', '08111000', 'car');
  assert(pf?.plan?.id === 'small_hour_daytime' && pf.refFare === 3 * 3 + 0.3 * 40, `planFor Carsharing: Stundentarif + km (Referenzfahrt 180 Min., 40 km = ${pf?.refFare} €)`);
}
