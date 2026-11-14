// Sprint 6 (Betreiber-Paket): Soll je Band (S6.3), Schichtplaner (S6.4), Fahrer-Tour (S6.2), Zonen-Werkbank (S6.1)
import * as O from '../lib/pulse-ops.js';
import { cellOf } from '../lib/pulse-track.js';
const assert = (c, m) => { if (!c) { console.error('FEHLER:', m); process.exitCode = 1; } else console.log('ok:', m); };
const AGS = '08111000', base = [48.78, 9.18];
const cellAt = (i, j) => cellOf(base[0] + i * 0.0025 + 1e-6, base[1] + j * 0.0035 + 1e-6);

// ---------- S6.3: zensurkorrigierte Nachfrage und Soll ----------
// 5 × 5 Zellen, Band 1 (Morgen) mit 9 Läufen à 20 Min. (3 h); Zelle A hatte nur in 3 von 9 Läufen Angebot und 6 Starts (2/h mit Angebot),
// Zelle B in allen 9 Läufen und 6 Starts (2/3 h): unzensiert gleich, zensiert A dreimal so hoch. Zelle L = Lagerfläche (Umsetzungen).
function doc({ supply = true, day = '2026-11-13' } = {}) {
  const m = {};
  for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) { const c = new Array(supply ? 28 : 22).fill(0); c[4 + 1] = 1; c[0] = 1; c[10 + 1] = 9; c[2] = 9; if (supply) c[22 + 1] = 9; m[cellAt(i, j)] = c; }
  const A = m[cellAt(0, 0)], B = m[cellAt(2, 2)], L = m[cellAt(-2, -2)];
  A[4 + 1] = 6; A[0] = 6; if (supply) A[22 + 1] = 3;
  B[4 + 1] = 6; B[0] = 6;
  L[3] = 30; L[4 + 1] = 2; L[0] = 2;
  return { day, bandMin: [0, 180, 0, 0, 0, 0], bandRuns: [0, 9, 0, 0, 0, 0], munis: { [AGS]: m } };
}
{
  const dC = O.censoredDemand([doc()], AGS, 1), dU = O.censoredDemand([doc({ supply: false })], AGS, 1);
  const A = dC.cells.get(cellAt(0, 0)), B = dC.cells.get(cellAt(2, 2));
  assert(dC.daysCensored === 1 && dU.daysCensored === 0 && Math.abs(A.supplyH - 1) < 1e-9 && Math.abs(B.supplyH - 3) < 1e-9, 'S6.3: Stunden mit Angebot = Läufe mit Angebot × Laufdauer (1 h bzw. 3 h); ohne Angebotsfelder volle Bandlänge');
  assert(Math.abs(A.rateRaw - 6) < 1e-9 && Math.abs(B.rateRaw - 2) < 1e-9 && Math.abs(dU.cells.get(cellAt(0, 0)).rateRaw - 2) < 1e-9, 'S6.3: Nachfrage = Starts ÷ Stunden mit Angebot (A 6/h statt 2/h unzensiert)');
  assert(A.rate < A.rateRaw && A.rate > B.rate && Math.abs(A.rate - (6 + A.prior) / 2) < 1e-9, 'S6.3: geglättet (Vorwert der Nachbarn mit 1 h Gewicht), A bleibt vor B');
  assert(dC.cells.get(cellAt(-2, -2)).storage && !A.storage, 'S6.3: Lagerfläche erkannt (viele Umsetzungen, wenige Starts)');
  for (const fleet of [0, 1, 7, 50, 333]) {
    const p = O.sollPlan(dC, { fleet });
    assert(p.sum === fleet && p.cells.every(c => c.cell !== cellAt(-2, -2)) && p.storageExcluded === 1, `S6.3: Soll summiert sich auf die Flotte (${fleet}), Lagerfläche ausgenommen`);
  }
  const p = O.sollPlan(dC, { fleet: 50 }), sA = p.cells.find(c => c.cell === cellAt(0, 0)).soll, sB = p.cells.find(c => c.cell === cellAt(2, 2)).soll;
  assert(sA > sB && p.cells[0].cell === cellAt(0, 0), `S6.3: zensierte Zelle bekommt mehr (A ${sA}, B ${sB})`);
  const pa = O.sollPlan(dC, { fleet: 20, allow: (e) => e.cell !== cellAt(0, 0) });
  assert(pa.sum === 20 && !pa.cells.some(c => c.cell === cellAt(0, 0)) && pa.notAllowed === 1, 'S6.3: Zellen außerhalb von allow (z. B. Abstellverbot) bekommen nichts');
  const csv = O.sollCsv(p).split('\n'), spots = O.sollSpotsCsv(p).split('\n');
  assert(csv[0].startsWith('zelle;lat;lng;band;soll') && csv.length === 1 + p.cells.filter(c => c.soll > 0).length && spots[0] === 'name,lat,lng,deploymentStatus,parkingStatus,deploymentRadius,deploymentVehicles' && spots[1].startsWith('Soll Morgen 01,'), 'S6.3: Auswertungs-CSV und Spots-CSV im Backend-Format');
  const sumV = spots.slice(1).reduce((a, l) => a + +l.split(',').pop(), 0);
  assert(sumV === 50, 'S6.3: Spots-CSV trägt das ganze Soll (deploymentVehicles = 50)');
}

// ---------- S6.4: Schichtplaner (Pickup-and-Delivery) ----------
const depot = { lat: 48.78, lon: 9.18 };
const at = (dn, de) => ({ lat: depot.lat + dn / 111320, lon: depot.lon + de / (111320 * Math.cos(depot.lat * Math.PI / 180)) });
{
  // Pendel: Abholung und Ziel liegen paarweise nah beieinander, die Paare weit verteilt – „erst einsammeln, dann ausbringen“ fährt alles zweimal ab
  const pts = [[3000, 0], [0, 3000], [-3000, 0], [0, -3000], [2100, 2100], [-2100, -2100]];
  const rebalance = { runs: [{ id: 'R1', stops: [...pts.map(([n, e], i) => ({ type: 'pickup', ...at(n, e), count: 2, prio: 1 + i / 10 })), ...pts.map(([n, e]) => ({ type: 'drop', ...at(n + 150, e + 150), count: 2, prio: 1 }))] }] };
  const swaps = { runs: [{ id: 'S1', stops: [at(1500, -1500), at(-1500, 1500), at(2500, 500)].map(p => ({ type: 'swap', ...p, count: 3, prio: 0.8 })) }] };
  const workshop = { runs: [{ id: 'W1', stops: [{ type: 'pickup_disabled', ...at(-2500, 800), count: 2, prio: 0.6 }] }] };
  const jobs = O.shiftJobs({ rebalance, swaps, workshop });
  assert(jobs.length === 6 + 3 + 1 && jobs.filter(j => j.kind === 'move').every(j => j.count === 2 && O.dist(j.p, j.d) < 300), 'S6.4: Aufträge aus den Touren (Paare nächstgelegen, Tausch, Werkstatt)');
  const sp = O.planShift(jobs, { drivers: 2, startMin: 6 * 60, endMin: 14 * 60, depot, vanCapacity: 4 });
  assert(sp.planned === jobs.length && sp.unplanned.length === 0 && sp.overMin === 0 && sp.drivers.every(d => d.endMin <= 14 * 60), `S6.4: 2 Fahrer à 8 h, alles eingeplant, ohne Zeitüberschreitung (Ende ${sp.drivers.map(d => O.minText(d.endMin)).join(', ')})`);
  assert(sp.km < sp.baselineKm && sp.savingKm > 0, `S6.4: weniger km als „erst einsammeln, dann ausbringen“ (${sp.km} statt ${sp.baselineKm} km)`);
  const legal = sp.drivers.every(d => d.stops.every(s => s.load >= 0 && s.load <= 4)) && sp.drivers.every(d => { const seen = new Map(); return d.stops.every(s => { if (s.type === 'pickup') seen.set(s.job, s.trip); if (s.type === 'drop') return seen.get(s.job) === s.trip; return true; }); });
  assert(legal, 'S6.4: Ladung nie über der Kapazität, Abholung vor Ausbringung in derselben Fahrt');
  const etaOk = sp.drivers.every(d => d.stops.every((s, k) => !k || s.eta >= d.stops[k - 1].eta) && d.stops[0].eta === 6 * 60);
  assert(etaOk && sp.drivers.every(d => d.stops[0].type === 'depot' && d.stops.at(-1).type === 'depot'), 'S6.4: Ankunftszeit je Stopp steigend ab Schichtbeginn, Depot am Anfang und Ende');
  const ws = sp.drivers.flatMap(d => d.stops.map((s, k) => ({ s, d, k }))).find(x => x.s.type === 'pickup_disabled');
  assert(ws && ws.d.stops.slice(ws.k + 1).some(s => s.type === 'depot' && s.trip === ws.s.trip), 'S6.4: Werkstattfahrzeug wird am Ende seiner Fahrt am Depot abgeladen');
  const short = O.planShift(jobs, { drivers: 1, startMin: 6 * 60, endMin: 6 * 60 + 45, depot, vanCapacity: 4 });
  assert(short.unplanned.length > 0 && short.overMin === 0 && short.drivers[0].endMin <= 6 * 60 + 45, `S6.4: kurze Schicht – Rest „nicht eingeplant“ statt Überschreitung (${short.unplanned.length} offen)`);
  const hi = short.drivers[0].stops.filter(s => s.job).map(s => jobs.find(j => j.id === s.job).prio), lo = short.unplanned.map(j => j.prio);
  assert(Math.min(...hi) >= Math.min(...lo), 'S6.4: Dringendes zuerst eingeplant');
  const csv = O.shiftCsv(sp).split('\n');
  assert(csv[0] === 'fahrer;fahrt;stopp;ankunft;typ;lat;lng;anzahl;ladung_danach' && csv[1].startsWith('F1;0;0;06:00;depot'), 'S6.4: Schichtplan als CSV');
}

// ---------- S6.2: Tour als Link ----------
{
  const F = await import('../lib/pulse-fahrer.js');
  const stops = Array.from({ length: 20 }, (_, i) => ({ type: ['pickup', 'drop', 'swap', 'pickup_disabled'][i % 4], lat: 48.7 + i * 0.00317, lon: 9.1 + i * 0.00411, count: 1 + (i % 3), eta: 360 + i * 7, note: i === 1 ? 'Spot 3 – „Marktplatz“' : '' }));
  const tour = F.makeTour({ id: 'F1', title: 'Stuttgart · Voi', at: Date.parse('2026-11-14T05:30:00Z'), day: '2026-11-14', depot, stops });
  const txt = F.encodeTour(tour), back = F.decodeTour(txt);
  assert(tour.stops.length === 22 && tour.stops[0].type === 'depot' && tour.stops.at(-1).type === 'depot', 'S6.2: Tour mit Depot am Anfang und Ende');
  assert(back && back.stops.length === 22 && back.stops.every((s, i) => s.type === tour.stops[i].type && Math.abs(s.lat - tour.stops[i].lat) <= 5e-6 && Math.abs(s.lon - tour.stops[i].lon) <= 5e-6 && s.count === tour.stops[i].count && s.eta === tour.stops[i].eta) && back.stops[2].note === 'Spot 3 – „Marktplatz“' && back.title === 'Stuttgart · Voi' && back.at === tour.at,
    `S6.2: Link hin und zurück verlustfrei (Lage auf 1 m, Umlaute; ${txt.length} Zeichen für 20 Stopps)`);
  assert(/^[A-Za-z0-9_-]+$/.test(txt) && txt.length < 1200, 'S6.2: Linktext nur Base64url, kurz genug für einen QR-Code');
  assert(F.decodeTour('kaputt') === null && F.decodeTour(txt.slice(0, 40)) === null && F.decodeTour('') === null, 'S6.2: kaputter Link → keine Tour');
  const st = { done: { 1: 1, 2: 1 }, issue: { 3: 'missing', 4: 'broken' } }, p = F.progress(tour, st);
  assert(p.total === 20 && p.done === 2 && p.issues === 2 && p.open === 16 && p.next.i === 5 && !p.complete, 'S6.2: Fortschritt und nächster offener Stopp');
  const fb = F.feedbackText(tour, st, { now: Date.parse('2026-11-14T09:00:00Z') }).split('\n');
  assert(fb[0] === 'Tour F1 (Stuttgart · Voi): 2/20 erledigt, 2 mit Problem, 16 offen' && fb[1].startsWith('Stopp 3 (06:14): nicht gefunden – 48.70') && fb[2].includes('defekt') && fb.length === 4, 'S6.2: Rückmeldung als Text mit Lage je Problem');
  assert(F.tourKey(txt) === F.tourKey(txt) && F.tourKey(txt) !== F.tourKey(txt + 'A') && F.navUrl(tour.stops[1]).startsWith('https://www.google.com/maps/dir/?api=1&destination=48.700000,9.100000'), 'S6.2: Speicherschlüssel je Tour, Navigation je Stopp');
}
