import * as T from '../lib/pulse-track.js';
const assert = (c, m) => { if (!c) { console.error('FEHLER:', m); process.exitCode = 1; } else console.log('ok:', m); };
const V = (id, lat, lon, extra = {}) => ({ operator: 'Bolt', rawId: id, lat, lon, batteryPct: 50, disabled: false, reserved: false, type: 'scooter', ags: '08416041', sourceId: 'bolt', ...extra });
const recs = [{ id: 'bolt', status: 'live', latencyMs: 100 }];
const munis = { '08416041': { state: 'BW' } };
const t0 = Date.parse('2026-10-31T10:00:00Z');
// Lauf 1: Zustand anlegen
let r = T.trackRun(null, { vehicles: [V('a', 48.52, 9.05), V('b', 48.521, 9.051, { batteryPct: 10 }), V('c', 48.53, 9.06, { disabled: true })], stations: [], sourceRecs: recs, now: t0 });
assert(r.first && Object.keys(r.state.v).length === 3, 'erster Lauf legt 3 Fahrzeuge an');
assert([...r.hourly.values()].every(h => h.start.every(x => !x) && h.end.every(x => !x)), 'erster Lauf erzeugt keine Ereignisse');
// Lauf 2: a verschwindet (Fahrt), b verschwindet (Abholung, Akku 10), c wird entsperrt, d neu (Fahrtende), e neu
const t1 = t0 + 20 * 60e3;
r = T.trackRun(r.state, { vehicles: [V('c', 48.53, 9.06), V('d', 48.54, 9.07), V('e', 48.55, 9.08)], stations: [], sourceRecs: recs, now: t1 });
let h = r.hourly.get('08416041|Bolt|scooter');
const hr = T.hourOf(t1);
assert(h.start[hr] === 1, 'eine Fahrt begonnen (a)');
assert(h.pickup[hr] === 1, 'eine Abholung (b, Akku 10)');
assert(h.end[hr] === 2, 'zwei Fahrtenden (d, e neu)');
assert(h.disOff[hr] === 1 && h.disDurN === 1 && h.disDurSum === 20 * 60e3, 'Entsperrung mit Dauer 20 Min');
// Lauf 3: a kehrt zurück an anderem Ort (stabile Kennung → Fahrtende mit Dauer), c bewegt sich 1 km (Umsetzung), d Akku-Swap
const t2 = t1 + 20 * 60e3;
r = T.trackRun(r.state, { vehicles: [V('a', 48.56, 9.10), V('c', 48.539, 9.06), V('d', 48.54, 9.07, { batteryPct: 95 }), V('e', 48.55, 9.08)], stations: [], sourceRecs: recs, now: t2 });
h = r.hourly.get('08416041|Bolt|scooter');
assert(h.end[T.hourOf(t2)] === 1 && h.tripDurN === 1, 'Rückkehr von a = Fahrtende mit Dauer');
assert(h.reloc[T.hourOf(t2)] === 1, 'c um 1 km bewegt = Umsetzung');
assert(h.swap[T.hourOf(t2)] === 0, 'd: Akkusprung 50→95 zählt nicht als Tausch (Start nicht unter 40)');
// Lauf 4: e Akku fällt auf 10, dann Lauf 5 Sprung auf 100 = Swap mit Wartezeit
const t3 = t2 + 20 * 60e3, t4 = t3 + 20 * 60e3;
r = T.trackRun(r.state, { vehicles: [V('a', 48.56, 9.10), V('c', 48.539, 9.06), V('d', 48.54, 9.07, { batteryPct: 95 }), V('e', 48.55, 9.08, { batteryPct: 10 })], stations: [], sourceRecs: recs, now: t3 });
r = T.trackRun(r.state, { vehicles: [V('a', 48.56, 9.10), V('c', 48.539, 9.06), V('d', 48.54, 9.07, { batteryPct: 95 }), V('e', 48.55, 9.08, { batteryPct: 100 })], stations: [], sourceRecs: recs, now: t4 });
h = r.hourly.get('08416041|Bolt|scooter');
assert(h.swap[T.hourOf(t4)] === 1 && h.swapWaitN === 1 && h.swapWaitSum === 20 * 60e3, 'Akkutausch mit 20 Min Wartezeit');
// Standzeit: a steht seit t2 → bei t4 40 Min → Bucket 0; Zellen
assert(r.idle['08416041|Bolt|scooter'][0] === 4 && r.idle['08416041|Bolt|scooter'][5] === 4, 'Standzeiten unter 2 h');
assert(r.cells.get('08416041').size >= 3, 'Zellen gefüllt');
const cellsT4 = r.cells;
// Quelle ausgefallen: Verschwinden zählt nicht als Fahrt
const t5 = t4 + 20 * 60e3;
r = T.trackRun(r.state, { vehicles: [], stations: [], sourceRecs: [{ id: 'bolt', status: 'error', latencyMs: 0 }], now: t5 });
h = r.hourly.get('08416041|Bolt|scooter');
assert(!h || h.start.every(x => !x), 'Quellenausfall erzeugt keine Fahrten');
// Stationen
const S = (id, bookable, docks) => ({ operator: 'nextbike', id, name: 'S' + id, lat: 48.52, lon: 9.05, ags: '08416041', bookable, docksAvailable: docks, renting: true, installed: true, returning: true });
r = T.trackRun(r.state, { vehicles: [], stations: [S('1', 0, 5), S('2', 3, 0)], sourceRecs: recs, now: t5 + 1 });
const q = T.stationQuota(r.state);
assert(q.length === 2 && q.find(x => x[2] === 'S1')[6] === 1 && q.find(x => x[2] === 'S2')[7] === 1, 'Stationsquote leer/voll');
const rel = T.reliability(r.state);
assert(rel.bolt.runs === 7 && rel.bolt.err === 1, 'Zuverlässigkeit: 7 Läufe, 1 Fehler');
// Merge
const doc = T.mergeHourly(null, r.hourly, { day: r.day, at: t5, dt: 20 * 60e3, srcModes: r.srcModes });
assert(doc.runs.length === 1, 'Tagesdatei angelegt');
const cd = T.mergeCells(null, cellsT4, munis, r.day);
assert(cd.states.BW && cd.states.BW['08416041'], 'Zellen nach Bundesland');
// Kennungswechsel am Ort: x verschwindet, y taucht 10 m daneben auf → keine Fahrt, Standzeit bleibt
{
  const u0 = Date.parse('2026-11-01T10:00:00Z');
  let q1 = T.trackRun(null, { vehicles: [V('x', 48.60, 9.10), V('z', 48.61, 9.11)], stations: [], sourceRecs: recs, now: u0 });
  q1 = T.trackRun(q1.state, { vehicles: [V('x', 48.60, 9.10), V('z', 48.61, 9.11)], stations: [], sourceRecs: recs, now: u0 + 20 * 60e3 });
  const firstSeenX = q1.state.v[T.vehicleKey('Bolt', 'x')][7];
  q1 = T.trackRun(q1.state, { vehicles: [V('y', 48.60009, 9.10), V('z', 48.61, 9.11)], stations: [], sourceRecs: recs, now: u0 + 40 * 60e3 });
  const hh = q1.hourly.get('08416041|Bolt|scooter'), hr2 = T.hourOf(u0 + 40 * 60e3);
  assert(hh.rot[hr2] === 1 && hh.start[hr2] === 0 && hh.end[hr2] === 0, 'Kennungswechsel am Ort: keine Fahrt, als Wechsel gezählt');
  assert(q1.state.v[T.vehicleKey('Bolt', 'y')][7] === firstSeenX && !q1.state.v[T.vehicleKey('Bolt', 'x')], 'neue Kennung übernimmt erste Sichtung, alte entfernt');
  assert(Math.abs(hh.vminTot[hr2] - 40) < 1e-9 && Math.abs(hh.vmin[hr2] - 40) < 1e-9, 'Fahrzeugminuten: 2 Fahrzeuge × 20 Min');
  // echte Fahrt: 2 km weiter → Start + Ende
  q1 = T.trackRun(q1.state, { vehicles: [V('w', 48.62, 9.10), V('z', 48.61, 9.11)], stations: [], sourceRecs: recs, now: u0 + 60 * 60e3 });
  const h3 = q1.hourly.get('08416041|Bolt|scooter'), hr3 = T.hourOf(u0 + 60 * 60e3);
  assert(h3.start[hr3] === 1 && h3.end[hr3] === 1 && h3.rot[hr3] === 0, 'Wechsel mit Ortswechsel bleibt Fahrt');
}
