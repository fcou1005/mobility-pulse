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
assert(r.idle['08416041|Bolt|scooter'][0] === 4 && r.idle['08416041|Bolt|scooter'][6] === 4 && r.idle['08416041|Bolt|scooter'].length === 7, 'Standzeiten unter 2 h (6 Klassen + Summe, Z6)');
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
// Gruppen: 6 neue Kennungen am selben Ort = Ausbringen; 6 verschwinden zusammen = Einsammeln (nachts, außerhalb des Nachfrage-Hauptfensters, Z7)
{
  const u0 = Date.parse('2026-11-01T23:00:00Z');
  const base = [...Array(40)].map((_, i) => V('b' + i, 48.40 + i * 0.01, 9.00));
  let q = T.trackRun(null, { vehicles: base, stations: [], sourceRecs: recs, now: u0 });
  q = T.trackRun(q.state, { vehicles: base, stations: [], sourceRecs: recs, now: u0 + 20 * 60e3 });
  const drop = [...Array(6)].map((_, i) => V('d' + i, 48.70 + i * 0.00005, 9.20));
  q = T.trackRun(q.state, { vehicles: [...base, ...drop], stations: [], sourceRecs: recs, now: u0 + 40 * 60e3 });
  const g = q.groups.filter(x => x.kind === 'deploy');
  assert(g.length === 1 && g[0].n === 6 && g[0].op === 'Bolt', 'Ausbringen: 6 Fahrzeuge ≤ 40 m als Gruppe erkannt');
  q = T.trackRun(q.state, { vehicles: base, stations: [], sourceRecs: recs, now: u0 + 60 * 60e3 });
  assert(q.groups.some(x => x.kind === 'collect' && x.n === 6), 'Einsammeln: 6 verschwinden zusammen');
  const few = [...Array(3)].map((_, i) => V('f' + i, 48.80, 9.30 + i * 0.00005));
  q = T.trackRun(q.state, { vehicles: [...base, ...few], stations: [], sourceRecs: recs, now: u0 + 80 * 60e3 });
  assert(T.GROUP_MIN === 4 && !q.groups.length, 'unter 4 Fahrzeugen keine Gruppe (3 zusammen)');
  const four = [...Array(4)].map((_, i) => V('q' + i, 48.85, 9.35 + i * 0.00005));
  q = T.trackRun(q.state, { vehicles: [...base, ...few, ...four], stations: [], sourceRecs: recs, now: u0 + 100 * 60e3 });
  assert(q.groups.length === 1 && q.groups[0].kind === 'deploy' && q.groups[0].n === 4, 'ab 4 Fahrzeugen ≤ 40 m: Ausbringung erkannt');
  const spread = [...Array(4)].map((_, i) => V('s' + i, 48.86, 9.36 + i * 0.0004)); // je ≈ 30 m, äußere 90 m auseinander
  q = T.trackRun(q.state, { vehicles: [...base, ...few, ...four, ...spread], stations: [], sourceRecs: recs, now: u0 + 120 * 60e3 });
  assert(!q.groups.some(g => g.kind === 'deploy'), '4 Fahrzeuge über 90 m verteilt: keine Gruppe (40 m um ein Fahrzeug)');
}
// Gruppen dauerhaft in Monatsdateien (groups/<JJJJ-MM>.json), nichts wird gelöscht, Dubletten einmal
{
  const g = (iso, kind = 'deploy', lat = 48.5) => T.groupRow({ at: Date.parse(iso), kind, op: 'Dott', ags: '08416041', lat, lon: 9.05, n: 4, types: { scooter: 4 } });
  const old = { month: '2026-10', fields: T.GROUP_FIELDS, events: [g('2026-10-02T10:00:00Z')] };
  const rows = [g('2026-10-31T22:30:00Z'), g('2026-10-31T23:30:00Z'), g('2026-10-02T10:00:00Z'), g('2026-11-01T08:00:00Z', 'collect')];
  const ch = T.mergeGroupMonths({ '2026-10': old, '2026-11': null }, rows, { at: 1 });
  assert(Object.keys(ch).sort().join() === '2026-10,2026-11', 'Monat nach Ortszeit: 31.10. 23:30 UTC = 01.11. 00:30 in Berlin → November');
  assert(ch['2026-10'].events.length === 2 && ch['2026-11'].events.length === 2 && old.events.length === 1, 'Oktober: alter + neuer Eintrag, Dublette einmal, Eingabe unverändert');
  assert(ch['2026-11'].events[0][0] < ch['2026-11'].events[1][0] && ch['2026-11'].fields.join() === 'at,art,anbieter,gemeinde,lat,lon,anzahl,arten' && ch['2026-11'].month === '2026-11', 'nach Zeit sortiert, Felder wie groups.json');
  const again = T.mergeGroupMonths(ch, rows, { at: 2 });
  assert(again['2026-10'].events.length === 2 && again['2026-11'].events.length === 2, 'erneuter Lauf mit denselben Zeilen fügt nichts hinzu');
  const ix = T.groupIndex(['2026-11', '2026-10', 'x'], { '2026-10': 2, '2026-11': 2 }, { at: 3, first: 10, last: 20 });
  assert(ix.months.join() === '2026-10,2026-11' && ix.events === 4 && ix.min === 4 && ix.radiusM === 40 && ix.counts['2026-11'] === 2, 'groups/index.json: Monate, Anzahl, Regeln (≥ 4 Fzg., 40 m)');
}
// M1 – Lauf nach Lücke (> 45 Min): Zustand wird fortgeschrieben, aber keine Ereignisse, Fahrzeugminuten, Zellen, Gruppen
{
  const u0 = Date.parse('2026-11-03T10:00:00Z');
  const base = [...Array(8)].map((_, i) => V('g' + i, 48.40 + i * 0.01, 9.00));
  let q = T.trackRun(null, { vehicles: base, stations: [], sourceRecs: recs, now: u0 });
  q = T.trackRun(q.state, { vehicles: base, stations: [], sourceRecs: recs, now: u0 + 20 * 60e3 });
  // nach 7 h: g0 weg, g1 um 1 km versetzt, n0..n5 neu am selben Ort (wäre sonst Ausbringen), g2 Akku 10 → 100 (wäre Tausch)
  const t = u0 + 20 * 60e3 + 7 * 3600e3;
  const after = [V('g1', 48.42, 9.00), V('g2', 48.42, 9.00, { batteryPct: 100 }), ...base.slice(3), ...[...Array(6)].map((_, i) => V('n' + i, 48.70, 9.20 + i * 0.00005))];
  q = T.trackRun(q.state, { vehicles: after, stations: [], sourceRecs: recs, now: t });
  assert(q.gap === true && q.dt === 7 * 3600e3, 'Lücke erkannt (dt > 45 Min)');
  assert(q.hourly.size === 0 && q.cells.size === 0 && q.groups.length === 0, 'Lücken-Lauf zählt nichts (keine Stunden, Zellen, Gruppen)');
  assert(q.state.v[T.vehicleKey('Bolt', 'g0')][3] & 4 && q.state.v[T.vehicleKey('Bolt', 'n0')] && q.state.v[T.vehicleKey('Bolt', 'g1')][0] === 4842000, 'Zustand fortgeschrieben: g0 fehlt, n0 angelegt, g1 neue Position');
  assert(q.state.v[T.vehicleKey('Bolt', 'g1')][8] === t && q.state.v[T.vehicleKey('Bolt', 'g2')][2] === 100, 'Standzeit/Akku fortgeschrieben');
  const ev = T.mergeHourly(null, q.hourly, { day: q.day, at: t, dt: q.dt, srcModes: q.srcModes, gap: q.gap });
  assert(ev.runs[0][2] === 0 && ev.runs[0][1] === q.dt, 'Tagesdatei: Lauf mit Flag 0 eingetragen');
  const cd = T.mergeCells(null, q.cells, munis, q.day, { dt: q.dt, hour: q.hour, gap: q.gap });
  assert(cd.bandRuns.every(x => x === 0) && cd.bandMin.every(x => x === 0), 'Zellen: Lücken-Lauf erhöht bandRuns/bandMin nicht');
  // nächster Lauf (20 Min) zählt wieder sauber: g1 fährt 1 km weiter → bei rotierender/unbekannter Quelle Umsetzung
  q = T.trackRun(q.state, { vehicles: after.map(v => v.rawId === 'g1' ? V('g1', 48.43, 9.00) : v), stations: [], sourceRecs: recs, now: t + 20 * 60e3 });
  const hh = q.hourly.get('08416041|Bolt|scooter');
  assert(q.gap === false && hh && hh.reloc[T.hourOf(t + 20 * 60e3)] === 1 && Math.abs(hh.vminTot[T.hourOf(t + 20 * 60e3)] - 13 * 20) < 1e-9, 'Lauf danach zählt wieder (1 Umsetzung, 13 × 20 Fahrzeugminuten)');
}
// M2 – stabile Kennungen: Versatz = Fahrt, Sammeltransport (≥ 3 am selben Ziel) = Umsetzung, rotierende Quelle unverändert
{
  const L = (id, lat, lon, extra = {}) => V(id, lat, lon, { operator: 'Lime', sourceId: 'lime', ...extra });
  const recsL = [{ id: 'lime', status: 'live', latencyMs: 50 }, { id: 'bolt', status: 'live', latencyMs: 50 }];
  const u0 = Date.parse('2026-11-04T10:00:00Z');
  const fleet = [L('s1', 48.50, 9.00), L('s2', 48.50, 9.01), L('s3', 48.50, 9.02), L('s4', 48.50, 9.03), L('s5', 48.50, 9.04, { disabled: true }), V('r1', 48.50, 9.05)];
  let q = T.trackRun(null, { vehicles: fleet, stations: [], sourceRecs: recsL, now: u0 });
  q = T.trackRun(q.state, { vehicles: fleet, stations: [], sourceRecs: recsL, now: u0 + 20 * 60e3 });
  // Kennungsmodus aus dem Zustand: lime stabil (Rückkehrer/Bewegte überwiegen), bolt rotierend
  q.state.srcStats.lime = { runs: 10, present: 500, gone: 20, moved: 40, newc: 30, returned: 30 };
  q.state.srcStats.bolt = { runs: 10, present: 500, gone: 200, moved: 2, newc: 190, returned: 0 };
  const t = u0 + 40 * 60e3, hr = T.hourOf(t);
  // s1 allein 2,2 km weiter (6,7 km/h, Akku 50 → 46) = Fahrt; s2, s3, s4 kommen gemeinsam am selben Punkt an = Transporter; s5 (gesperrt) versetzt = Umsetzung; r1 (Bolt, rotierend) versetzt = Umsetzung
  const moved = [L('s1', 48.52, 9.00, { batteryPct: 46 }), L('s2', 48.55, 9.10), L('s3', 48.55005, 9.10), L('s4', 48.5501, 9.10005), L('s5', 48.51, 9.04, { disabled: true }), V('r1', 48.51, 9.05)];
  q = T.trackRun(q.state, { vehicles: moved, stations: [], sourceRecs: recsL, now: t });
  const hl = q.hourly.get('08416041|Lime|scooter'), hb = q.hourly.get('08416041|Bolt|scooter');
  assert(q.srcModes.lime === 'stable' && q.srcModes.bolt === 'rotating', 'Kennungsmodus: lime stabil, bolt rotierend');
  assert(hl.start[hr] === 1 && hl.end[hr] === 1 && hl.tripDistN === 1 && hl.tripDistSum > 2000 && hl.tripDurSum === 20 * 60e3, 'stabiler Einzelversatz = Fahrt (Start + Ende, Distanz, Dauer ≤ dt)');
  assert(hl.reloc[hr] === 4, 'Sammeltransport (3 am selben Ziel) + gesperrtes Fahrzeug = 4 Umsetzungen');
  assert(hb.reloc[hr] === 1 && hb.start[hr] === 0, 'rotierende Quelle: Versatz bleibt Umsetzung');
  const cl = q.cells.get('08416041');
  assert(cl.get(T.cellOf(48.50, 9.00))[0] === 1 && cl.get(T.cellOf(48.52, 9.00))[1] === 1, 'Zellen: Start am alten Ort, Ziel am neuen');
}
// M10 – Schlüssel mit/ohne Salt, Umzug des Zustands auf neue Schlüssel
{
  const { createHmac } = await import('node:crypto');
  const mk = (salt) => (s) => T.keyFromDigest(createHmac('sha256', salt).update(s).digest());
  const a = mk('salz-1'), b = mk('salz-2');
  assert(T.vehicleKey('Bolt', 'x1') === T.vehicleKey('Bolt', 'x1') && /^[0-9a-z]+$/.test(T.vehicleKey('Bolt', 'x1')), 'alter Schlüssel ohne Salt stabil');
  assert(T.vehicleKey('Bolt', 'x1', a) === T.vehicleKey('Bolt', 'bike:x1', a) && T.vehicleKey('Bolt', 'x1', a) !== T.vehicleKey('Bolt', 'x1', b) && T.vehicleKey('Bolt', 'x1', a) !== T.vehicleKey('Bolt', 'x1'), 'gesalzener Schlüssel: normalisiert, salzabhängig, ungleich dem alten');
  assert(T.vehicleKey('Bolt', 'x1', a).length <= 13, 'gesalzener Schlüssel auf 64 Bit gekürzt');
  const u0 = Date.parse('2026-11-05T10:00:00Z');
  const fleet = [V('m1', 48.50, 9.00), V('m2', 48.50, 9.01), V('m3', 48.50, 9.02)];
  let q = T.trackRun(null, { vehicles: fleet, stations: [], sourceRecs: recs, now: u0 });
  q = T.trackRun(q.state, { vehicles: fleet, stations: [], sourceRecs: recs, now: u0 + 20 * 60e3 });
  const mig = T.migrateState(q.state, fleet.slice(0, 2), (op, id) => T.vehicleKey(op, id), (op, id) => T.vehicleKey(op, id, a));
  assert(mig.moved === 2 && mig.dropped === 1 && Object.keys(mig.state.v).length === 2 && mig.state.v[T.vehicleKey('Bolt', 'm1', a)] && !mig.state.v[T.vehicleKey('Bolt', 'm1')], 'Umzug: 2 Treffer unter neuem Schlüssel, 1 alter Eintrag verworfen');
  assert(mig.state.version === 2 && mig.state.salted === true && mig.state.srcStats.bolt && mig.state.at === q.state.at, 'Umzug: Version 2, gesalzen, übrige Felder übernommen');
  q = T.trackRun(mig.state, { vehicles: fleet.slice(0, 2), stations: [], sourceRecs: recs, now: u0 + 40 * 60e3, hmac: a });
  const hh = q.hourly.get('08416041|Bolt|scooter');
  assert(hh.start.every(x => !x) && hh.pickup.every(x => !x) && hh.end.every(x => !x) && q.state.v[T.vehicleKey('Bolt', 'm1', a)][7] === u0, 'Umzugslauf: keine Fahrten/Abholungen, erste Sichtung bleibt');
}
// M1 – nach der Lücke: in der Lücke verschwundene Kennung kehrt still zurück (kein Fahrtende ohne Beginn); Quellenausfall ebenso
{
  const u0 = Date.parse('2026-11-06T10:00:00Z');
  const base = [V('k1', 48.40, 9.00), V('k2', 48.41, 9.00), V('k3', 48.42, 9.00)];
  let q = T.trackRun(null, { vehicles: base, stations: [], sourceRecs: recs, now: u0 });
  q = T.trackRun(q.state, { vehicles: base, stations: [], sourceRecs: recs, now: u0 + 20 * 60e3 });
  const t = u0 + 20 * 60e3 + 3 * 3600e3; // 3 h Lücke: k1 fehlt
  q = T.trackRun(q.state, { vehicles: base.slice(1), stations: [], sourceRecs: recs, now: t });
  assert(q.gap && q.hourly.size === 0, 'Lücken-Lauf: k1 fehlt, nichts gezählt');
  q = T.trackRun(q.state, { vehicles: base, stations: [], sourceRecs: recs, now: t + 20 * 60e3 });
  let hh = q.hourly.get('08416041|Bolt|scooter');
  assert(!q.gap && hh.end.every(x => !x) && hh.start.every(x => !x), 'Rückkehr nach Lücke zählt kein Fahrtende');
  // Quellenausfall: Fahrzeuge bleiben still, Rückkehr nach dem Ausfall zählt nichts (vorher: Fahrtenden für die ganze Flotte)
  q = T.trackRun(q.state, { vehicles: [], stations: [], sourceRecs: [{ id: 'bolt', status: 'error', latencyMs: 0 }], now: t + 40 * 60e3 });
  q = T.trackRun(q.state, { vehicles: base, stations: [], sourceRecs: recs, now: t + 60 * 60e3 });
  hh = q.hourly.get('08416041|Bolt|scooter');
  assert(hh.end.every(x => !x) && hh.start.every(x => !x) && q.state.srcStats.bolt.returned === 0, 'Rückkehr nach Quellenausfall: kein Fahrtende, nicht als Rückkehrer im Kennungsmodus');
  // noEvents (Umzug): Lauf zählt nichts, Flag 0
  q = T.trackRun(q.state, { vehicles: base.slice(1), stations: [], sourceRecs: recs, now: t + 80 * 60e3, noEvents: true });
  assert(q.gap === true && q.hourly.size === 0 && q.groups.length === 0, 'noEvents: wie Lücken-Lauf');
}
// M1 – Tagesdokument: Altbestand mit dt > 45 Min. wird nachträglich auf 0 gesetzt, gapHours nennt die gestörten Stunden (Europe/Berlin)
{
  const at = (iso) => Date.parse(iso);
  let doc = { day: '2026-11-01', runs: [[at('2026-10-31T23:13:02Z'), 18 * 60e3, 1], [at('2026-11-01T07:25:45Z'), 456 * 60e3, 1], [at('2026-11-01T07:45:16Z'), 20 * 60e3, 1]], groups: {}, version: 2 };
  doc = T.mergeHourly(doc, new Map(), { day: '2026-11-01', at: at('2026-11-01T08:04:30Z'), dt: 19 * 60e3, srcModes: {} });
  assert(doc.runs[1][2] === 0 && doc.runs[0][2] === 1 && doc.runs[3][2] === 1 && JSON.stringify(doc.gapHours) === '[8]', 'Altbestand: Lauf 07:25 UTC (dt 456 Min.) → Flag 0, gestörte Stunde 8 (MEZ)');
  doc = T.mergeHourly(doc, new Map(), { day: '2026-11-01', at: at('2026-11-01T12:30:00Z'), dt: 60 * 60e3, srcModes: {}, gap: true });
  assert(JSON.stringify(doc.gapHours) === '[8,13]' && doc.runs[4][2] === 0, 'neuer Lücken-Lauf ergänzt gapHours');
}
// M14 – Kennungswechsel nur bei gleichem Ladestand; global nach Kosten vergeben; bis 100 m mit, 40 m ohne Ladestand; Akkutausch mit neuer Kennung
{
  const u0 = Date.parse('2026-11-07T10:00:00Z'), hr = T.hourOf(u0 + 40 * 60e3);
  const run = (a, b) => { let q = T.trackRun(null, { vehicles: a, stations: [], sourceRecs: recs, now: u0 }); q = T.trackRun(q.state, { vehicles: a, stations: [], sourceRecs: recs, now: u0 + 20 * 60e3 }); return T.trackRun(q.state, { vehicles: b, stations: [], sourceRecs: recs, now: u0 + 40 * 60e3 }); };
  const G = (q) => q.hourly.get('08416041|Bolt|scooter');
  // gleicher Ladestand (61 → 60), 80 m daneben: Kennungswechsel
  let q = run([V('o1', 48.50, 9.00, { batteryPct: 61 })], [V('n1', 48.50072, 9.00, { batteryPct: 60 })]);
  assert(G(q).rot[hr] === 1 && G(q).start[hr] === 0 && G(q).end[hr] === 0, 'gleicher Ladestand ±2, 80 m: Kennungswechsel');
  // anderer Ladestand (61 → 40), 10 m daneben: kein Kennungswechsel → Fahrtbeginn + Fahrtende
  q = run([V('o1', 48.50, 9.00, { batteryPct: 61 })], [V('n1', 48.50009, 9.00, { batteryPct: 40 })]);
  assert(G(q).rot[hr] === 0 && G(q).start[hr] === 1 && G(q).end[hr] === 1, 'Ladestand weicht ab: kein Kennungswechsel');
  // ohne Ladestand: 30 m ja, 60 m nein
  q = run([V('o1', 48.50, 9.00, { batteryPct: null })], [V('n1', 48.50027, 9.00, { batteryPct: null })]);
  assert(G(q).rot[hr] === 1, 'ohne Ladestand: 30 m = Kennungswechsel');
  q = run([V('o1', 48.50, 9.00, { batteryPct: null })], [V('n1', 48.50054, 9.00, { batteryPct: null })]);
  assert(G(q).rot[hr] === 0 && G(q).start[hr] === 1, 'ohne Ladestand: 60 m = kein Kennungswechsel');
  // global: o1 (Akku 50) und o2 (Akku 70) verschwinden; n2 (70) liegt o1 am nächsten, n1 (50) etwas weiter – erster Treffer hätte o1↔n2 gepaart (Ladestand falsch)
  q = run([V('o1', 48.50, 9.00), V('o2', 48.5006, 9.00, { batteryPct: 70 })], [V('n2', 48.50025, 9.00, { batteryPct: 70 }), V('n1', 48.49955, 9.00)]);
  assert(G(q).rot[hr] === 2 && G(q).start[hr] === 0 && G(q).end[hr] === 0, 'globaler Abgleich: beide Paare nach Ladestand richtig');
  // Akkutausch mit neuer Kennung: o1 (Akku 12, seit Lauf 1 niedrig) verschwindet, n1 mit 98 % 5 m daneben
  q = run([V('o1', 48.50, 9.00, { batteryPct: 12 })], [V('n1', 48.500045, 9.00, { batteryPct: 98 })]);
  assert(G(q).swap[hr] === 1 && G(q).rot[hr] === 0 && G(q).start[hr] === 0 && G(q).pickup[hr] === 0 && G(q).end[hr] === 0 && G(q).swapWaitN === 1, 'Akkutausch mit neuer Kennung: keine Fahrt, kein Abholen');
  assert(q.state.v[T.vehicleKey('Bolt', 'n1')][7] === u0 && !q.state.v[T.vehicleKey('Bolt', 'o1')], 'Akkutausch: erste Sichtung übernommen, alte Kennung entfernt');
}
// M14 – stabile Kennungen: über 24 km/h = fast, kurzer Versatz < 500 m ohne Ladestandverlust = slow (M-4), ≥ 2 km ohne Ladestandverlust = Umsetzung, Sammeltransport mit Rückkehrern
{
  const L = (id, lat, lon, extra = {}) => V(id, lat, lon, { operator: 'Lime', sourceId: 'lime', ...extra });
  const recsL = [{ id: 'lime', status: 'live', latencyMs: 50 }];
  const u0 = Date.parse('2026-11-08T10:00:00Z'), t = u0 + 40 * 60e3, hr = T.hourOf(t);
  const fleet = [L('a', 48.50, 9.00), L('b', 48.50, 9.02), L('c', 48.50, 9.04), L('d', 48.50, 9.06), L('e', 48.50, 9.08), L('f', 48.50, 9.10), L('g', 48.50, 9.12)];
  let q = T.trackRun(null, { vehicles: fleet, stations: [], sourceRecs: recsL, now: u0 });
  q = T.trackRun(q.state, { vehicles: fleet.filter(v => v.rawId !== 'g'), stations: [], sourceRecs: recsL, now: u0 + 20 * 60e3 }); // g verschwindet (Fahrtbeginn)
  q.state.srcStats.lime = { runs: 10, present: 500, gone: 20, moved: 40, newc: 30, returned: 30 };
  // a: 300 m, Akku gleich = slow (GPS-Sprung); b: 9 km (27 km/h, Akku 50 → 30) = fast; c: 2,2 km, Akku 50 → 50 = Umsetzung ohne Energieverlust; d: 2,2 km, Akku 50 → 47 = Fahrt
  // e, f (versetzt) und g (Rückkehrer) kommen ≤ 40 m beieinander an = Sammeltransport → e, f Umsetzung
  const after = [L('a', 48.5027, 9.00), L('b', 48.58, 9.02, { batteryPct: 30 }), L('c', 48.52, 9.04), L('d', 48.52, 9.06, { batteryPct: 47 }), L('e', 48.60, 9.20), L('f', 48.60005, 9.20), L('g', 48.6001, 9.20005)];
  q = T.trackRun(q.state, { vehicles: after, stations: [], sourceRecs: recsL, now: t });
  const h = q.hourly.get('08416041|Lime|scooter');
  assert(h.slow[hr] === 1 && h.fast[hr] === 1, 'kurz ohne Ladestandverlust (slow 1) und über 24 km/h (fast 1) gesondert');
  assert(h.reloc[hr] === 3 && h.start[hr] === 1 && h.end[hr] === 2, 'Umsetzung: ohne Energieverlust (c) + Sammeltransport mit Rückkehrer (e, f); Fahrt nur d; Ende d + Rückkehr g');
  const doc = T.mergeHourly(null, q.hourly, { day: q.day, at: t, dt: q.dt, srcModes: q.srcModes });
  assert(doc.groups['08416041|Lime|scooter'].slow[hr] === 1 && T.HOUR_FIELDS.includes('fast'), 'slow/fast in der Tagesdatei');
}
// M9 – Stationsquote: virtuelle Stationen gekennzeichnet (letzte Spalte)
{
  const St = (id, isVirtual) => ({ operator: 'Voi', id, name: 'Zone ' + id, lat: 48.78, lon: 9.18, ags: '08111000', bookable: 0, docksAvailable: null, renting: true, installed: true, returning: true, isVirtual });
  const q = T.trackRun(null, { vehicles: [], stations: [St('z1', true), St('d1', false)], sourceRecs: [], now: Date.parse('2026-11-09T10:00:00Z') });
  const sq = T.stationQuota(q.state);
  assert(sq.find(x => x[2] === 'Zone z1')[8] === 1 && sq.find(x => x[2] === 'Zone d1')[8] === 0, 'Stationsquote: virtuell 1, Dock 0');
}
// Start-Ziel-Ströme: nur stabile Kennungen mit bekanntem Start und Ziel; rotierende Quelle, Lücke, Abholung, Aufladen, Sammeltransport ohne Strom
{
  const L = (id, lat, lon, extra = {}) => V(id, lat, lon, { operator: 'Lime', sourceId: 'lime', ...extra });
  const recsL = [{ id: 'lime', status: 'live', latencyMs: 50 }, { id: 'bolt', status: 'live', latencyMs: 50 }];
  const u0 = Date.parse('2026-11-10T07:00:00Z'), t = u0 + 40 * 60e3, b = T.bandOf(T.hourOf(t));
  const fleet = [L('a', 48.50, 9.00), L('b', 48.50, 9.02), L('c', 48.50, 9.04, { batteryPct: 10 }), L('d', 48.50, 9.06, { disabled: true }), L('e', 48.50, 9.08), L('f', 48.50, 9.10), L('g1', 48.50, 9.12), L('g2', 48.50, 9.14), L('g3', 48.50, 9.16), L('h', 48.50, 9.18), V('r', 48.50, 9.20)];
  let q = T.trackRun(null, { vehicles: fleet, stations: [], sourceRecs: recsL, now: u0 });
  // b, c (Akku 10), d (gesperrt), e, f, g1–g3, h verschwinden; a bleibt
  q = T.trackRun(q.state, { vehicles: [fleet[0], fleet[10]], stations: [], sourceRecs: recsL, now: u0 + 20 * 60e3 });
  assert(q.flows instanceof Map && q.flows.size === 0, 'flows: Map, ohne Bewegung leer');
  q.state.srcStats.lime = { runs: 10, present: 500, gone: 20, moved: 40, newc: 30, returned: 30 };
  q.state.srcStats.bolt = { runs: 10, present: 500, gone: 200, moved: 2, newc: 190, returned: 0 };
  // a: 2,2 km Versatz (Fahrt); b: kehrt 1,1 km weiter zurück, Akku 50 → 44 (Strom); c: Rückkehr nach Abholung (Akku 10); d: gesperrt verschwunden;
  // e: kommt aufgeladen zurück (50 → 90); f: nur 100 m weiter; g1–g3: kehren gemeinsam an einen Punkt zurück (Sammeltransport); h: 30 km weiter (zu schnell);
  // r (Bolt, rotierend): 2 km versetzt = Umsetzung, kein Strom
  const after = [L('a', 48.52, 9.00, { batteryPct: 46 }), L('b', 48.51, 9.02, { batteryPct: 44 }), L('c', 48.51, 9.04, { batteryPct: 9 }), L('d', 48.51, 9.06, { batteryPct: 40 }), L('e', 48.51, 9.08, { batteryPct: 90 }), L('f', 48.5009, 9.10, { batteryPct: 45 }),
    L('g1', 48.60, 9.30, { batteryPct: 45 }), L('g2', 48.60005, 9.30, { batteryPct: 45 }), L('g3', 48.6001, 9.30005, { batteryPct: 45 }), L('h', 48.77, 9.18, { batteryPct: 30 }), V('r', 48.518, 9.20)];
  q = T.trackRun(q.state, { vehicles: after, stations: [], sourceRecs: recsL, now: t });
  const fl = q.flows.get(`08416041|Lime|scooter|${b}`);
  const fa = fl?.get(`${T.cellOf(48.50, 9.00)}>${T.cellOf(48.52, 9.00)}`), fb = fl?.get(`${T.cellOf(48.50, 9.02)}>${T.cellOf(48.51, 9.02)}`);
  assert(fl && fl.size === 2 && fa?.count === 1 && fa.durSum === 20 * 60e3 && Math.abs(fa.distSum - 2224) < 5, 'Versatz a: Strom alte Zelle → neue Zelle, Dauer = Laufintervall, Luftlinie ≈ 2,2 km');
  assert(fb?.count === 1 && fb.durSum === 20 * 60e3 && Math.abs(fb.distSum - 1112) < 5, 'Rückkehr b: Strom vom Ort des Verschwindens, Dauer seit dem Verschwinden');
  assert(![...q.flows.keys()].some(k => k.includes('|Bolt|')), 'rotierende Quelle (Bolt): kein Strom');
  assert([...q.flows.values()].reduce((s, m) => s + [...m.values()].reduce((x, f) => x + f.count, 0), 0) === 2, 'keine Ströme für Abholung (c), Sperrung (d), Aufladen (e), < 150 m (f), Sammeltransport (g1–g3), > 24 km/h (h)');
  // Lücken-Lauf: keine Ströme, auch bei Versatz
  const g = T.trackRun(q.state, { vehicles: after.map(v => v.rawId === 'a' ? L('a', 48.54, 9.00, { batteryPct: 40 }) : v), stations: [], sourceRecs: recsL, now: t + 3 * 3600e3 });
  assert(g.gap && g.flows.size === 0, 'Lücken-Lauf: keine Ströme');
}
// Ströme: Tagessumme, Mindestschwelle 2 je Zellenpaar mit Zusammenfassung (Anbieter → Band → Art), Top-N je Gemeinde, stabile Anbieter je Gemeinde
{
  const F = (entries) => new Map(entries.map(([k, pairs]) => [k, new Map(pairs.map(([p, n, dur, dist]) => [p, { count: n, durSum: dur, distSum: dist }]))]));
  let raw = T.mergeFlows(null, F([['A1|Lime|scooter|1', [['1:1>2:2', 2, 600e3, 2000], ['5:5>6:6', 1, 300e3, 900]]]]), { day: '2026-11-10', stable: { A1: ['Lime'] } });
  raw = T.mergeFlows(raw, F([['A1|Lime|scooter|3', [['3:3>4:4', 1, 300e3, 1000]]], ['A1|Lime|scooter|1', [['3:3>4:4', 1, 300e3, 1200]]], ['A1|Voi|scooter|2', [['1:1>2:2', 1, 120e3, 800]]],
    ['A1|Bolt|scooter|2', [['1:1>2:2', 1, 180e3, 700]]], ['A1|Lime|bike|4', [['7:7>8:8', 1, 240e3, 600]]], ['A1|Bolt|scooter|5', [['7:7>8:8', 1, 360e3, 1500]]]]), { day: '2026-11-10', stable: { A1: ['Bolt'], A2: ['DB Connect'] } });
  assert(raw.runs === 2 && raw.rows['A1|Lime|scooter|1']['1:1>2:2'][0] === 2 && raw.stable.A1.join() === 'Bolt,Lime' && raw.stable.A2[0] === 'DB Connect', 'mergeFlows: Läufe, Zählung und stabile Anbieter summiert');
  assert(T.mergeFlows(raw, new Map(), { day: '2026-11-11' }).runs === 1 && T.mergeFlows(raw, new Map(), { day: '2026-11-11' }).day === '2026-11-11' && !Object.keys(T.mergeFlows(raw, new Map(), { day: '2026-11-11' }).rows).length, 'mergeFlows: neuer Tag beginnt neue Summe');
  const pub = T.publishFlows(raw, { at: 1 });
  const R = (from, to) => pub.flows.filter(r => r[1] === from && r[2] === to);
  assert(pub.fields.join() === T.FLOW_FIELDS.join() && pub.cell[0] === T.CELL_LAT && pub.day === '2026-11-10' && pub.min === 2, 'publishFlows: Felder, Zellmaß, Tag, Mindestschwelle');
  assert(pub.flows.every(r => r[6] >= 2), 'keine veröffentlichte Zeile unter 2 Fahrten');
  assert(JSON.stringify(R('1:1', '2:2').map(r => r.slice(3, 7))) === JSON.stringify([['Lime', 'scooter', 1, 2], [null, 'scooter', 2, 2]]), 'Zellenpaar 1: Lime einzeln (2), Voi + Bolt (je 1, gleiches Band) als „mehrere Anbieter“');
  assert(JSON.stringify(R('3:3', '4:4').map(r => r.slice(3, 9))) === JSON.stringify([['Lime', 'scooter', null, 2, 600, 2200]]), 'Zellenpaar 3: Lime in zwei Bändern → Band zusammengefasst, Dauer/Luftlinie summiert');
  assert(JSON.stringify(R('7:7', '8:8').map(r => r.slice(3, 7))) === JSON.stringify([[null, null, null, 2]]), 'Zellenpaar 7: verschiedene Anbieter, Arten und Bänder → ganz zusammengefasst');
  assert(!R('5:5', '6:6').length && pub.munis.A1.below === 1 && pub.munis.A1.trips === 9 && pub.munis.A1.shown === 8 && pub.total.trips === pub.total.shown + pub.total.below + pub.total.cut, 'Einzelfahrt unter Mindestschwelle nur als Summe; trips = shown + below + cut');
  assert(pub.munis.A1.ops.Lime === 6 && pub.munis.A1.ops.Bolt === 2 && pub.munis.A1.ops.Voi === 1 && pub.stable.A2[0] === 'DB Connect', 'Fahrten je Anbieter und stabile Anbieter je Gemeinde');
  const top = T.publishFlows(raw, { top: 2 });
  assert(top.flows.length === 2 && top.munis.A1.cut === 4 && top.munis.A1.shown === 4 && top.munis.A1.below === 1 && top.flows[0][6] >= top.flows[1][6], 'Top-N je Gemeinde: Rest als „außerhalb Top“');
  const st = T.stableOps({ s1: 'stable', s2: 'rotating', s3: 'stable' }, [{ id: 's1', operator: 'Lime', municipalities: ['A1', 'A2'] }, { id: 's2', operator: 'Voi', municipalities: ['A1'] }, { id: 's3', operator: 'DB Connect', municipalities: ['A1'] }]);
  assert(JSON.stringify(st) === JSON.stringify({ A1: ['DB Connect', 'Lime'], A2: ['Lime'] }), 'stableOps: nur stabile Quellen je Gemeinde');
  assert(T.publishFlows(null).flows.length === 0 && T.publishFlows(null).total.trips === 0, 'publishFlows ohne Tagessumme: leer');
}
// Zeitumstellung: Tagesdatei trägt Minuten je Ortsstunde
{
  const doc = T.mergeHourly(null, new Map(), { day: '2026-10-25', at: Date.parse('2026-10-25T01:30:00Z'), dt: 20 * 60e3, srcModes: {} });
  assert(doc.hourMin[2] === 120 && doc.hourMin.reduce((a, b) => a + b, 0) === 1500 && T.hourOf(Date.parse('2026-10-25T00:30:00Z')) === 2 && T.hourOf(Date.parse('2026-10-25T01:30:00Z')) === 2, 'hourMin im Tagesdokument, beide Stunden 2 am 25.10.');
}
// ---------- Methodenprüfung 01.11.2026 (M-2, M-4, M-6, M-8, M-9) ----------
const sumH = (m, f) => [...m.values()].reduce((a, h) => a + h[f].reduce((x, y) => x + y, 0), 0);
const cnt = (o) => Object.values(o).reduce((a, m) => a + Object.values(m).reduce((x, y) => x + y, 0), 0);
// M-6: Quelle fehlt in sourceRecs (Manifest ausgefallen) → keine Fahrtbeginne, Kennungen still; Rückkehr ohne Fahrtende
{
  const u0 = Date.parse('2026-11-02T10:00:00Z'), dt = 20 * 60e3;
  const M = [...Array(50)].map((_, i) => V('m' + i, 48.40 + i * 0.001, 9.18, { operator: 'Voi', sourceId: 'M:child', batteryPct: 60 }));
  let q = null; for (let k = 0; k < 3; k++) q = T.trackRun(q?.state ?? null, { vehicles: M, stations: [], sourceRecs: [{ id: 'M:child', status: 'live' }], now: u0 + k * dt });
  q = T.trackRun(q.state, { vehicles: [], stations: [], sourceRecs: [{ id: 'M', status: 'error' }], now: u0 + 3 * dt });
  assert(sumH(q.hourly, 'start') === 0 && sumH(q.hourly, 'pickup') === 0, 'M-6: Kindquelle fehlt in sourceRecs → 0 Fahrtbeginne');
  assert(M.every(v => (q.state.v[T.vehicleKey('Voi', v.rawId)][3] & 12) === 12), 'M-6: Kennungen tragen F_MISSING|F_SILENT');
  q = T.trackRun(q.state, { vehicles: M, stations: [], sourceRecs: [{ id: 'M:child', status: 'live' }], now: u0 + 4 * dt });
  assert(sumH(q.hourly, 'end') === 0, 'M-6: Rückkehr der Quelle ohne Fahrtenden');
}
// M-8: rotierende Quelle fällt einen Lauf aus und kommt mit neuen Kennungen zurück → keine Fahrtenden; danach normale Zählung
{
  const u0 = Date.parse('2026-11-03T10:00:00Z'), dt = 20 * 60e3;
  const L = (id, i, extra = {}) => V(id, 48.30 + i * 0.001, 9.18, { operator: 'Lime', sourceId: 'L', batteryPct: 40 + (i % 50), ...extra });
  let fleet = [...Array(50)].map((_, i) => L('a' + i, i));
  let q = null; for (let k = 0; k < 3; k++) q = T.trackRun(q?.state ?? null, { vehicles: fleet, stations: [], sourceRecs: [{ id: 'L', status: 'live' }], now: u0 + k * dt });
  q = T.trackRun(q.state, { vehicles: [], stations: [], sourceRecs: [{ id: 'L', status: 'error' }], now: u0 + 3 * dt });
  fleet = fleet.map((v, i) => ({ ...v, rawId: 'b' + i }));
  q = T.trackRun(q.state, { vehicles: fleet, stations: [], sourceRecs: [{ id: 'L', status: 'live' }], now: u0 + 4 * dt });
  assert(sumH(q.hourly, 'end') === 0 && sumH(q.hourly, 'start') === 0, 'M-8: Rückkehr nach Ausfall mit neuen Kennungen → 0 Fahrtenden');
  assert(cnt(q.est.e) === 0 && !q.groups.length, 'M-8: Massenwechsel auch nicht in Schätzung und Gruppen');
  // nächster Lauf: ein Fahrzeug verschwindet, eines taucht 2 km entfernt neu auf (echte Fahrt)
  const next = [...fleet.slice(1), L('c0', 30, { lat: 48.33, lon: 9.21 })];
  q = T.trackRun(q.state, { vehicles: next, stations: [], sourceRecs: [{ id: 'L', status: 'live' }], now: u0 + 5 * dt });
  assert(sumH(q.hourly, 'start') === 1 && sumH(q.hourly, 'end') === 1, 'M-8: danach normale Zählung (1 Beginn, 1 Ende)');
  // Teilausfall bei laufender Quelle: 30 von 50 verschwinden in einem Lauf → keine Fahrtbeginne, still behalten
  const half = next.slice(0, 20);
  q = T.trackRun(q.state, { vehicles: half, stations: [], sourceRecs: [{ id: 'L', status: 'live' }], now: u0 + 6 * dt });
  assert(sumH(q.hourly, 'start') === 0 && sumH(q.hourly, 'pickup') === 0, 'M-8: Massenverschwinden (30 von 50) → 0 Fahrtbeginne');
  q = T.trackRun(q.state, { vehicles: next, stations: [], sourceRecs: [{ id: 'L', status: 'live' }], now: u0 + 7 * dt });
  assert(sumH(q.hourly, 'end') === 0, 'M-8: Rückkehr nach Massenverschwinden ohne Fahrtenden');
}
// M-9: Quelle wechselt jede Kennung in jedem Lauf (Lime direkt) – kein Massenwechsel, Schätzung zählt die echten Fahrten, Gruppen werden erkannt
{
  const u0 = Date.parse('2026-11-04T10:00:00Z'), dt = 20 * 60e3;
  const mk = (id, lat, lon, bat) => ({ operator: 'Lime', rawId: id, lat, lon, batteryPct: bat, disabled: false, reserved: false, type: 'scooter', ags: '08416041', sourceId: 'LR' });
  let F = [...Array(200)].map((_, i) => mk('r0-' + i, 48.40 + (i % 20) * 0.003, 9.00 + Math.floor(i / 20) * 0.004, 60));
  let q = null;
  for (let k = 0; k < 8; k++) {
    F = F.map((v, i) => ({ ...v, rawId: `r${k}-${i}`, ...(k > 0 && i < 10 ? { lat: v.lat + 0.0135, batteryPct: v.batteryPct - 3 } : {}) }));
    q = T.trackRun(q?.state ?? null, { vehicles: F, stations: [], sourceRecs: [{ id: 'LR', status: 'live' }], now: u0 + k * dt });
  }
  assert(sumH(q.hourly, 'start') === 10 && sumH(q.hourly, 'end') === 10 && sumH(q.hourly, 'rot') === 190, 'M-9: Lime-Muster 10 Fahrten, 190 Kennungswechsel');
  assert(cnt(q.est.s) === 10 && cnt(q.est.e) === 10, 'M-9: est.s = est.e = 10 (vorher 0: als Massenwechsel verworfen)');
  const drop = [...Array(5)].map((_, i) => mk('dep' + i, 48.70 + i * 0.00005, 9.30, 100));
  F = F.map((v, i) => ({ ...v, rawId: `r9-${i}` }));
  q = T.trackRun(q.state, { vehicles: [...F, ...drop], stations: [], sourceRecs: [{ id: 'LR', status: 'live' }], now: u0 + 8 * dt });
  assert(q.groups.some(g => g.kind === 'deploy' && g.op === 'Lime' && g.n === 5), 'M-9: Ausbringen bei rotierender Quelle erkannt');
  assert(!q.idleUnusable.LR && q.idle['08416041|Lime|scooter']?.[6] === 200 && q.idle['08416041|Lime|scooter'][1] === 190 && q.idleCens['08416041|Lime|scooter'][1] === 190, 'Z5: Kennungswechsel in jedem Lauf (Lime-Muster) ist nicht „unbrauchbar“; gepaarte stehen mit übernommener Standzeit (190 seit Beginn, 2:40 h) in idle (bisher fehlend), neue Ausbringung nicht');
}
// M-4: stabile Kennung, Versatz innerhalb eines Laufs – Untergrenze 3,5 km/h gilt nicht mehr
{
  const L = (id, lat, lon, extra = {}) => V(id, lat, lon, { operator: 'DB Connect', sourceId: 'db', type: 'ebike', ...extra });
  const recsD = [{ id: 'db', status: 'live', latencyMs: 50 }];
  const u0 = Date.parse('2026-11-05T10:00:00Z'), t = u0 + 40 * 60e3, hr = T.hourOf(t);
  const fleet = ['a', 'b', 'c', 'd', 'e'].map((id, i) => L(id, 48.50, 9.00 + i * 0.03, { batteryPct: 60 }));
  let q = T.trackRun(null, { vehicles: fleet, stations: [], sourceRecs: recsD, now: u0 });
  q = T.trackRun(q.state, { vehicles: fleet, stations: [], sourceRecs: recsD, now: u0 + 20 * 60e3 });
  q.state.srcStats.db = { runs: 10, present: 500, gone: 20, moved: 40, newc: 30, returned: 30 };
  // a: 800 m, Akku 60 → 57 = Fahrt; b: 200 m, Akku gleich = slow; c: 1,5 km, Akku gleich = Fahrt; d: 300 m, Akku 60 → 58 = Fahrt; e bleibt
  const after = [L('a', 48.5072, 9.00, { batteryPct: 57 }), L('b', 48.5018, 9.03, { batteryPct: 60 }), L('c', 48.5135, 9.06, { batteryPct: 60 }), L('d', 48.5027, 9.09, { batteryPct: 58 }), fleet[4]];
  q = T.trackRun(q.state, { vehicles: after, stations: [], sourceRecs: recsD, now: t });
  const h = q.hourly.get('08416041|DB Connect|ebike');
  assert(h.start[hr] === 3 && h.end[hr] === 3 && h.slow[hr] === 1, 'M-4: 800 m/20 Min. mit Akku −3, 1,5 km und 300 m mit Akku −2 = Fahrt; 200 m ohne Verlust = slow');
  assert(h.tripDurN === 3 && Math.abs(h.tripDistSum - (800 + 1501 + 300)) < 10, 'M-4: Dauer/Distanz der drei Fahrten erfasst');
}
// M-2: Ladestand mit unplausibler Skala nur als Fingerabdruck (batteryFp): keine Abholung, kein Akkutausch, Kennungswechsel weiter über den Wert
{
  const u0 = Date.parse('2026-11-06T10:00:00Z'), dt = 20 * 60e3;
  const S = (id, lat, fp) => V(id, lat, 9.00, { operator: 'Lime', sourceId: 'ls', batteryPct: null, batteryFp: fp });
  const recsS = [{ id: 'ls', status: 'live' }];
  const base = [...Array(30)].map((_, i) => S('z' + i, 48.20 + i * 0.01, 25));
  let q = T.trackRun(null, { vehicles: [...base, S('lo', 48.60, 10), S('sw', 48.61, 30), S('ro', 48.62, 33)], stations: [], sourceRecs: recsS, now: u0 });
  q = T.trackRun(q.state, { vehicles: [...base, S('lo', 48.60, 10), S('sw', 48.61, 30), S('ro', 48.62, 33)], stations: [], sourceRecs: recsS, now: u0 + dt });
  assert((q.state.v[T.vehicleKey('Lime', 'lo')][3] & 16) === 16 && q.state.v[T.vehicleKey('Lime', 'lo')][2] === 10 && !q.state.v[T.vehicleKey('Lime', 'lo')][9], 'M-2: Fingerabdruck im Zustand (F_BATREL), keine „niedrig seit“-Zeit');
  // lo (10) verschwindet = Fahrtbeginn (keine Abholung); sw (30) verschwindet, neue Kennung 5 m daneben mit 90 = kein Akkutausch; ro (33) → neue Kennung 80 m daneben mit 33 = Kennungswechsel
  q = T.trackRun(q.state, { vehicles: [...base, S('sw2', 48.610045, 90), S('ro2', 48.62072, 33)], stations: [], sourceRecs: recsS, now: u0 + 2 * dt });
  assert(sumH(q.hourly, 'pickup') === 0 && sumH(q.hourly, 'swap') === 0 && sumH(q.hourly, 'start') === 2 && sumH(q.hourly, 'end') === 1 && sumH(q.hourly, 'rot') === 1,
    'M-2: Ladestand 10 % → Fahrtbeginn statt Abholung; Sprung 30 → 90 kein Akkutausch; gleicher Fingerabdruck 80 m = Kennungswechsel');
}
// Abgeleiteter Ladestand (batteryDerived: Reichweite ÷ Maximalreichweite, Lime BW) wie die unplausible Skala: nur Fingerabdruck, keine Abholschwelle
{
  const u0 = Date.parse('2026-11-06T14:00:00Z'), dt = 20 * 60e3;
  const S = (id, lat, b) => V(id, lat, 9.00, { operator: 'Lime', sourceId: 'lb', batteryPct: b, batteryDerived: true });
  const recsS = [{ id: 'lb', status: 'live' }];
  const base = [...Array(30)].map((_, i) => S('y' + i, 48.20 + i * 0.01, 25));
  let q = T.trackRun(null, { vehicles: [...base, S('lo', 48.60, 10), S('sw', 48.61, 30)], stations: [], sourceRecs: recsS, now: u0 });
  q = T.trackRun(q.state, { vehicles: [...base, S('lo', 48.60, 10), S('sw', 48.61, 30)], stations: [], sourceRecs: recsS, now: u0 + dt });
  assert((q.state.v[T.vehicleKey('Lime', 'lo')][3] & 16) === 16 && q.state.v[T.vehicleKey('Lime', 'lo')][2] === 10, 'abgeleiteter Ladestand: Fingerabdruck im Zustand (F_BATREL)');
  q = T.trackRun(q.state, { vehicles: [...base, S('sw2', 48.610045, 90)], stations: [], sourceRecs: recsS, now: u0 + 2 * dt });
  assert(sumH(q.hourly, 'pickup') === 0 && sumH(q.hourly, 'swap') === 0 && sumH(q.hourly, 'start') === 2, 'abgeleiteter Ladestand 10 % → Fahrtbeginn statt Abholung; Sprung 30 → 90 kein Akkutausch');
}
// M-3: Altlauf (dt > 45 Min., vor der Lückenregel gezählt) in Zellendateien – Band fällt für den Tag aus
{
  const day = '2026-11-01', at = (hm) => Date.parse(`${day}T${hm}:00Z`); // 07:25 UTC = 08:25 Uhr (Band Morgen)
  const cell = () => { const c = new Array(T.CELL_LEN).fill(0); c[0] = 50; c[4 + 1] = 40; c[4 + 2] = 10; c[1] = 30; c[16 + 1] = 25; c[16 + 2] = 5; c[2] = 12; c[10 + 1] = 6; c[10 + 2] = 6; c[3] = 2; return c; };
  const legacy = () => ({ day, version: 2, bandMin: [0, 64.5, 40, 0, 0, 0], bandRuns: [0, 2, 2, 0, 0, 0], states: { BE: { '11000000': { '1:1': cell() } } } });
  const runs = [[at('06:00'), 20 * 60e3, 1], [at('07:25'), 456 * 60e3, 0], [at('07:45'), 20 * 60e3, 1], [at('08:05'), 20 * 60e3, 1], [at('12:13'), 22 * 60e3, 0]];
  const { doc, bands } = T.repairCells(legacy(), runs);
  const c = doc.states.BE['11000000']['1:1'];
  assert(bands.join() === '1' && doc.bandTainted[1] === 1 && doc.bandMin[1] === 0 && doc.bandRuns[1] === 0 && doc.bandMin[2] === 40, 'M-3: Band Morgen (Altlauf 07:25 UTC) ohne Messminuten; Lauf ohne Zählung (dt 22 Min., Flag 0) zählt nicht als Altlauf');
  assert(c[0] === 10 && c[5] === 0 && c[6] === 10 && c[1] === 5 && c[17] === 0 && c[2] === 6 && c[11] === 0 && c[3] === 2 && doc.relocUnrepaired, 'M-3: Starts/Enden/Präsenz des Bands abgezogen, übrige Bänder bleiben; Umsetzungen ohne Bandaufteilung bleiben (relocUnrepaired)');
  assert(T.repairCells(doc, runs).bands.length === 0 && doc.taintChecked === T.CELLS_TAINT_VERSION, 'M-3: Reparatur nur einmal (taintChecked)');
  const st = { BE: { '11000000': { '1:1': cell() } } };
  const ps = T.repairCells({ day, bandMin: [0, 64.5, 40, 0, 0, 0], bandRuns: [0, 2, 2, 0, 0, 0], munis: st.BE }, runs);
  assert(ps.bands.join() === '1' && ps.doc.munis['11000000']['1:1'][0] === 10, 'M-3: Landesdatei (munis) ebenso');
  // mergeCells: ältere Tagesdatei wird beim nächsten Lauf repariert, neue Datei gilt als geprüft
  const merged = T.mergeCells(legacy(), new Map(), { '11000000': { state: 'BE' } }, day, { dt: 20 * 60e3, hour: 10, runs: [...runs, [at('09:00'), 20 * 60e3, 1]], at: at('09:00') });
  assert(merged.bandTainted[1] === 1 && merged.taintChecked && merged.bandMin[2] === 60, 'M-3: mergeCells repariert ältere Tagesdatei, laufender Lauf zählt weiter');
  const fresh = T.mergeCells(null, new Map(), {}, day, { dt: 20 * 60e3, hour: 10, runs: [[at('07:25'), 456 * 60e3, 0]], at: at('09:00') });
  assert(fresh.taintChecked && !fresh.bandTainted, 'M-3: neue Tagesdatei: keine Reparatur nötig');
  // Nachfrage danach ohne Morgen-Band (Disposition liest bandMin/Bänder)
  assert(T.taintedBands(runs).join() === '1' && T.taintedBands(runs, { exclude: at('07:25') }).length === 0, 'M-3: taintedBands (laufender Lauf ausgenommen)');
}
// M-7: Kennung wechselt je Fahrt (nextbike, Dott) – Ausleihe und Rückgabe am selben Ort im selben Lauf sind zwei Fahrten
{
  const u0 = Date.parse('2026-11-07T10:00:00Z'), dt = 20 * 60e3;
  const N = (id, lat, extra = {}) => V(id, lat, 13.40, { operator: 'nextbike', sourceId: 'nb', type: 'bike', batteryPct: null, ...extra });
  const recsN = [{ id: 'nb', status: 'live' }];
  const stn = [{ operator: 'nextbike', id: 's1', name: 'Station', lat: 52.52, lon: 13.40, ags: '08416041', bookable: 8, docksAvailable: 2, renting: true, installed: true, returning: true }];
  const S8 = [...Array(8)].map((_, i) => N('n' + i, 52.52)), far = [...Array(20)].map((_, i) => N('f' + i, 52.60 + i * 0.002));
  let q = null; for (let k = 0; k < 4; k++) q = T.trackRun(q?.state ?? null, { vehicles: [...S8, ...far], stations: stn, sourceRecs: recsN, now: u0 + k * dt });
  q = T.trackRun(q.state, { vehicles: [...S8.slice(1), N('n-new', 52.52005), ...far], stations: stn, sourceRecs: recsN, now: u0 + 4 * dt });
  assert(sumH(q.hourly, 'start') === 1 && sumH(q.hourly, 'end') === 1 && sumH(q.hourly, 'rot') === 0, 'M-7: Station, Wechsel je Fahrt: Ausleihe + Rückgabe 5 m daneben = 1 Beginn, 1 Ende (vorher 1 Kennungswechsel)');
  // frei abgestellt (keine Station), gleicher Ladestand, 3 m: weiterhin Kennungswechsel; 20 m: nicht mehr
  const E = (id, lat, bat) => N(id, lat, { type: 'ebike', batteryPct: bat });
  const eb = [...Array(20)].map((_, i) => E('e' + i, 52.70 + i * 0.002, 50 + i));
  q = null; for (let k = 0; k < 4; k++) q = T.trackRun(q?.state ?? null, { vehicles: eb, stations: stn, sourceRecs: recsN, now: u0 + k * dt });
  q = T.trackRun(q.state, { vehicles: [...eb.slice(2), E('x0', 52.70 + 0.000027, 50), E('x1', 52.702 + 0.00018, 51)], stations: stn, sourceRecs: recsN, now: u0 + 4 * dt });
  assert(sumH(q.hourly, 'rot') === 1 && sumH(q.hourly, 'start') === 1 && sumH(q.hourly, 'end') === 1, 'M-7: Wechsel je Fahrt: ≤ 5 m mit gleichem Ladestand = Kennungswechsel, 20 m = Fahrt');
}
// M-13: Spiegelkopien desselben Ursprungsfeeds (MOBIDROM-Manifeste) teilen Statistik und Kennungsmodus, auch wenn der Dublettensieger wechselt
{
  assert(T.canonSource('mobidrom_voi-nrw:source-voi-moenchengladbach') === 'source-voi-moenchengladbach' && T.canonSource('mobidrom_e-scooter-sharing-nrw:source-voi-moenchengladbach') === 'source-voi-moenchengladbach' && T.canonSource('lime_bw') === 'lime_bw', 'M-13: kanonischer Feed (Teil nach dem Manifest)');
  const u0 = Date.parse('2026-11-08T10:00:00Z'), dt = 20 * 60e3, A = 'mobidrom_voi-nrw:source-voi-mg', B = 'mobidrom_voi-mg:source-voi-mg';
  const recsAB = [{ id: A, status: 'live' }, { id: B, status: 'live' }];
  const fleet = [...Array(30)].map((_, i) => V('v' + i, 51.18 + i * 0.002, 6.44, { operator: 'Voi', batteryPct: 40 + i }));
  let q = null;
  for (let k = 0; k < 8; k++) { // Sieger wechselt je Lauf; jeder Lauf: 3 Fahrzeuge verschwinden, 3 frühere kehren zurück (stabile Kennungen)
    const vis = fleet.filter((_, i) => (i + k) % 10 !== 0).map(v => ({ ...v, sourceId: k % 2 ? A : B }));
    q = T.trackRun(q?.state ?? null, { vehicles: vis, stations: [], sourceRecs: recsAB, now: u0 + k * dt });
  }
  assert(q.srcModes[A] === q.srcModes[B] && q.srcModes[A] === 'stable' && Object.keys(q.state.srcStats).includes('source-voi-mg') && !Object.keys(q.state.srcStats).includes(A), 'M-13: wechselnder Dublettensieger → derselbe Modus (stabil) für beide Kopien');
  // eine Kopie fällt aus, die andere läuft: Verschwinden zählt (Quelle lief), Kennungen der ausgefallenen Kopie nicht still
  const r2 = T.trackRun(q.state, { vehicles: fleet.slice(1).map(v => ({ ...v, sourceId: A })), stations: [], sourceRecs: [{ id: A, status: 'live' }, { id: B, status: 'error' }], now: u0 + 8 * dt });
  assert(sumH(r2.hourly, 'start') + sumH(r2.hourly, 'pickup') >= 1, 'M-13: eine laufende Kopie genügt als Quellenstatus');
  // Altzustand mit Schlüsseln je Quelle: Umstieg übernimmt die Statistik mit den meisten Läufen
  const old = { ...T.emptyState(0), at: u0, srcStats: { [A]: { runs: 9, present: 100, gone: 10, moved: 20, newc: 5, returned: 20 }, [B]: { runs: 2, present: 5, gone: 50, moved: 0, newc: 50, returned: 0 } } };
  const r3 = T.trackRun(old, { vehicles: [], stations: [], sourceRecs: recsAB, now: u0 + 20 * 60e3 });
  assert(r3.state.srcCanon === 1 && r3.state.srcStats['source-voi-mg'].runs >= 9 && !r3.state.srcStats[A], 'M-13: Altzustand auf kanonische Schlüssel umgestellt (Statistik mit den meisten Läufen)');
}
// M-14: ≥ 4 Räder an einer eigenen Dockstation in einem Lauf zurückgegeben/ausgeliehen = Nutzerverkehr, keine Gruppe; virtuelle Station (Abstellzone) schon
// (nicht stationsgebundenes System, nachts; Z7 siehe unten)
{
  const u0 = Date.parse('2026-11-09T01:00:00Z'), dt = 20 * 60e3;
  const N = (id, lat, lon, extra = {}) => V(id, lat, lon, { operator: 'nextbike', sourceId: 'nbs', type: 'bike', batteryPct: null, ...extra });
  const recsN = [{ id: 'nbs', status: 'live' }];
  const dock = { operator: 'nextbike', id: 'd1', name: 'Dock', lat: 52.50, lon: 13.30, ags: '08416041', bookable: 5, docksAvailable: 3, renting: true, installed: true, returning: true, isVirtual: false };
  const zone = { ...dock, id: 'z1', name: 'Zone', lat: 52.55, lon: 13.35, isVirtual: true };
  const base = [...Array(60)].map((_, i) => N('b' + i, 52.40 + i * 0.001, 13.20));
  let q = T.trackRun(null, { vehicles: base, stations: [dock, zone], sourceRecs: recsN, now: u0 });
  q = T.trackRun(q.state, { vehicles: base, stations: [dock, zone], sourceRecs: recsN, now: u0 + dt });
  const atDock = [...Array(5)].map((_, i) => N('r' + i, 52.50 + i * 0.00002, 13.30)), atZone = [...Array(5)].map((_, i) => N('z' + i, 52.55 + i * 0.00002, 13.35));
  q = T.trackRun(q.state, { vehicles: [...base, ...atDock, ...atZone], stations: [dock, zone], sourceRecs: recsN, now: u0 + 2 * dt });
  assert(q.groups.length === 1 && q.groups[0].kind === 'deploy' && Math.abs(q.groups[0].lat - 52.55) < 0.001, 'M-14: 5 Räder an der Dockstation = keine Gruppe; 5 an einer Abstellzone = Ausbringung');
  q = T.trackRun(q.state, { vehicles: base, stations: [dock, zone], sourceRecs: recsN, now: u0 + 3 * dt });
  assert(q.groups.filter(g => g.kind === 'collect').length === 1 && Math.abs(q.groups[0].lat - 52.55) < 0.001, 'M-14: gemeinsames Verschwinden an der Dockstation = keine Einsammlung');
}
// M-19: Regelstand je Lauf; Tag mit mehreren Regelständen gekennzeichnet
{
  let d = T.mergeHourly(null, new Map(), { day: '2026-11-10', at: 1, dt: 20 * 60e3, srcModes: {} });
  d = T.mergeHourly(d, new Map(), { day: '2026-11-10', at: 2, dt: 20 * 60e3, srcModes: {}, rule: `${T.METHOD_VERSION}@abc1234` });
  assert(d.runs[0].length === 3 && d.runs[1][3] === `${T.METHOD_VERSION}@abc1234` && d.mixedRules?.length === 2, 'M-19: runs[k][3] = Regelstand, Tag mit altem und neuem Stand als mixedRules');
  const e = T.mergeHourly(null, new Map(), { day: '2026-11-11', at: 1, dt: null, srcModes: {}, rule: 'x@1' });
  assert(!e.mixedRules, 'M-19: ein Regelstand → keine Kennzeichnung');
}
// M-22: Regression auf dem echten Datenstand (.realdata, falls vorhanden): nach der Reparatur kein Morgen-Band über 2 × Tagesmittel
{
  const { existsSync, readFileSync, readdirSync } = await import('node:fs');
  const D = new URL('../.realdata/', import.meta.url).pathname;
  if (existsSync(`${D}cells`) && existsSync(`${D}events`)) {
    const days = readdirSync(`${D}cells`).filter(f => /^\d{4}-\d{2}-\d{2}$/.test(f) && existsSync(`${D}events/${f}.json`));
    let worst = 0, where = '';
    for (const day of days) {
      const runs = JSON.parse(readFileSync(`${D}events/${day}.json`, 'utf8')).runs;
      for (const f of readdirSync(`${D}cells/${day}`)) {
        const doc = JSON.parse(readFileSync(`${D}cells/${day}/${f}`, 'utf8')); T.repairCells(doc, runs);
        const hDay = doc.bandMin.reduce((a, b) => a + b, 0) / 60; if (!(hDay > 0)) continue;
        let sDay = 0; const sB = new Array(6).fill(0); for (const m of Object.values(doc.munis)) for (const c of Object.values(m)) { sDay += c[0]; for (let b = 0; b < 6; b++) sB[b] += c[4 + b] || 0; }
        if (sDay < 500) continue;
        for (let b = 0; b < 6; b++) { if (!(doc.bandMin[b] >= 30)) continue; const r = (sB[b] / (doc.bandMin[b] / 60)) / (sDay / hDay); if (r > worst) { worst = r; where = `${day} ${f} ${T.BANDS[b].label}`; } }
      }
    }
    assert(worst <= 2, `M-22 echte Daten: nach der Reparatur kein Band über 2 × Tagesmittel (höchstens ${worst.toFixed(2)}${where ? `, ${where}` : ''})`);
  } else console.log('ok: M-22 echte Zellen übersprungen (.realdata fehlt)');
}
// M-18 (Teil): nach einer Lücke von 5 h gilt ± 7 Punkte als gleicher Ladestand – rotierende Kennung behält die Standzeit
{
  const u0 = Date.parse('2026-11-10T06:00:00Z');
  const L = (id, bat) => V(id, 48.30, 9.30, { operator: 'Voi', sourceId: 'vg', batteryPct: bat });
  let q = T.trackRun(null, { vehicles: [L('a1', 60)], stations: [], sourceRecs: [{ id: 'vg', status: 'live' }], now: u0 });
  q = T.trackRun(q.state, { vehicles: [L('a1', 60)], stations: [], sourceRecs: [{ id: 'vg', status: 'live' }], now: u0 + 20 * 60e3 });
  q = T.trackRun(q.state, { vehicles: [L('a2', 54)], stations: [], sourceRecs: [{ id: 'vg', status: 'live' }], now: u0 + 20 * 60e3 + 5 * 3600e3 });
  assert(q.gap && q.state.v[T.vehicleKey('Voi', 'a2')][7] === u0 && !q.state.v[T.vehicleKey('Voi', 'a1')], 'M-18: Lücke 5 h, Ladestand 60 → 54 am Ort = Kennungswechsel, erste Sichtung bleibt');
}
// M-11: Zelle × Band unter 3 Ereignissen unterdrückt, Summen je Gemeinde in below, Präsenz und Umsetzungen bleiben
{
  const C3 = (b, st, en, pres = 0, reloc = 0) => { const c = new Array(T.CELL_LEN).fill(0); c[4 + b] = st; c[16 + b] = en; c[0] = st; c[1] = en; c[10 + b] = pres; c[2] = pres; c[3] = reloc; return c; };
  const two = C3(1, 1, 1, 4, 1); two[4 + 2] = 5; two[0] += 5; // Band 1: 2 Ereignisse (unterdrückt), Band 2: 5 (bleibt)
  const m = { A: { '1:1': two, '2:2': C3(3, 1, 0), '3:3': C3(4, 2, 2) }, B: { '9:9': C3(0, 0, 1) } };
  const r = T.suppressCells(m);
  assert(r.munis.A['1:1'][5] === 0 && r.munis.A['1:1'][17] === 0 && r.munis.A['1:1'][6] === 5 && r.munis.A['1:1'][0] === 5 && r.munis.A['1:1'][1] === 0 && r.munis.A['1:1'][2] === 4 && r.munis.A['1:1'][3] === 1, 'M-11: Band unter 3 Ereignissen auf 0, Summenfelder neu, Präsenz/Umsetzung bleiben');
  assert(!r.munis.A['2:2'] && r.munis.A['3:3'][8] === 2 && !r.munis.B && r.below.A[1] === 1 && r.below.A[7] === 1 && r.below.A[3] === 1 && r.below.B[6] === 1 && m.A['1:1'][5] === 1, 'M-11: leere Zellen entfallen, Summen in below je Gemeinde (Start/Ende je Band), Eingabe unverändert');
  const old = T.suppressCells({ A: { 'x': [1, 1, 0, 0], 'y': [3, 1, 2, 0] } });
  assert(!old.munis.A.x && old.munis.A.y[0] === 3 && old.below.A[12] === 1 && old.below.A[13] === 1, 'M-11: ältere Zellen ohne Bandfelder: ganze Zelle unter 3 → below');
}
{
  const c = new Array(T.CELL_LEN).fill(0); c[0] = 6; c[4 + 2] = 4; c[1] = 1; // 2 Beginne ohne Bandangabe + 1 Ende ohne Band (zusammen 3: bleibt)
  const d = new Array(T.CELL_LEN).fill(0); d[0] = 5; d[4 + 2] = 4; // 1 Beginn ohne Band: unterdrückt
  const r = T.suppressCells({ A: { c, d } });
  assert(r.munis.A.c[0] === 6 && r.munis.A.c[1] === 1 && r.munis.A.d[0] === 4 && r.below.A[12] === 1, 'M-11: Anteil ohne Bandangabe bleibt ab 3 Ereignissen, sonst below (Summen stimmen)');
}
// Datenschutz-Invariante: in keiner veröffentlichten Zelle steht je Band ein Wert, der unter der Schwelle liegt (zufällige Eingaben, feste Saat)
{
  let seed = 12345; const rnd = (n) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
  const munis = { A: {}, B: {} }; let sumIn = 0;
  for (const ags of ['A', 'B']) for (let i = 0; i < 300; i++) {
    const c = new Array(T.CELL_LEN).fill(0); let s0 = 0, s1 = 0;
    for (let k = 0; k < 6; k++) { const st = rnd(4) === 0 ? rnd(6) : 0, en = rnd(4) === 0 ? rnd(6) : 0; c[4 + k] = st; c[16 + k] = en; s0 += st; s1 += en; c[10 + k] = rnd(3); }
    c[0] = s0; c[1] = s1; sumIn += s0 + s1; munis[ags][`c${i}`] = c;
  }
  const r = T.suppressCells(munis); let bad = 0, sumOut = 0, sumBelow = 0;
  for (const cells of Object.values(r.munis)) for (const c of Object.values(cells)) for (let k = 0; k < 6; k++) { const n = c[4 + k] + c[16 + k]; sumOut += n; if (n > 0 && n < T.CELL_MIN) bad++; }
  for (const b of Object.values(r.below)) for (let i = 0; i < 12; i++) sumBelow += b[i];
  assert(bad === 0 && sumOut + sumBelow === sumIn, 'Datenschutz: keine veröffentlichte Zelle × Band unter der Schwelle; veröffentlicht + unterdrückt = Eingabe');
}
// Z4: Ausblendung bei niedrigem Akku (Quelle mit Untergrenze 15 %): Verschwinden bis 20 % = hide, nicht Fahrtbeginn; gesperrt = Abholung
{
  const u0 = Date.parse('2026-11-12T10:00:00Z'), dt = 20 * 60e3, hr = T.hourOf(u0 + 2 * dt);
  const D = (id, bat, extra = {}) => V(id, 48.20 + Number(id.slice(1)) * 0.01, 9.40, { operator: 'Dott', sourceId: 'dott-x', batteryPct: bat, ...extra });
  const fleet = [D('a1', 18), D('a2', 25), D('a3', 12), D('a4', 18, { disabled: true }), D('a5', 18, { reserved: true }), D('a6', 60), D('a7', 60), D('a8', 60)];
  const run = (recs) => { let q = T.trackRun(null, { vehicles: fleet, stations: [], sourceRecs: recs, now: u0 }); q = T.trackRun(q.state, { vehicles: fleet, stations: [], sourceRecs: recs, now: u0 + dt }); return T.trackRun(q.state, { vehicles: fleet.slice(5), stations: [], sourceRecs: recs, now: u0 + 2 * dt }).hourly.get('08416041|Dott|scooter'); };
  const h = run([{ id: 'dott-x', status: 'live', batteryFloor: 15 }]);
  assert(T.HOUR_FIELDS.at(-1) === 'hide' && h.hide[hr] === 2 && h.start[hr] === 2 && h.pickup[hr] === 1, 'Z4: Untergrenze 15 %: 18 % und 12 % verschwunden = hide (2), 25 % und reserviert = Fahrtbeginn (2), gesperrt = Abholung (1)');
  const h0 = run([{ id: 'dott-x', status: 'live' }]);
  assert(h0.hide[hr] === 0 && h0.start[hr] === 3 && h0.pickup[hr] === 2, 'Z4: ohne Untergrenze wie bisher (18 % Fahrt, 12 % Abholung)');
  const fp = fleet.map(v => ({ ...v, batteryFp: v.batteryPct, batteryPct: null }));
  let q = T.trackRun(null, { vehicles: fp, stations: [], sourceRecs: [{ id: 'dott-x', status: 'live', batteryFloor: 15 }], now: u0 });
  q = T.trackRun(q.state, { vehicles: fp.slice(5), stations: [], sourceRecs: [{ id: 'dott-x', status: 'live', batteryFloor: 15 }], now: u0 + dt });
  assert(q.hourly.get('08416041|Dott|scooter').hide.every(x => !x), 'Z4: relativer Ladestand (Fingerabdruck) zählt nie als Ausblendung');
}
// Z4: stabile Kennung kehrt am Ort (≤ 50 m) mit ≥ 30 Punkten mehr zurück = Akkutausch (zählt zusätzlich das Fahrtende, damit der beim Verschwinden
// gezählte Fahrtbeginn ein Gegenstück hat – Scheinfahrt als bekannte Obergrenze); weiter weg = Fahrtende
{
  const L = (id, lat, lon, extra = {}) => V(id, lat, lon, { operator: 'Lime', sourceId: 'lime', ...extra });
  const recsL = [{ id: 'lime', status: 'live' }];
  const u0 = Date.parse('2026-11-12T10:00:00Z'), dt = 20 * 60e3, hr = T.hourOf(u0 + 2 * dt);
  const fleet = [L('a', 48.50, 9.00, { batteryPct: 18 }), L('b', 48.50, 9.02, { batteryPct: 18 }), L('c', 48.50, 9.04)];
  let q = T.trackRun(null, { vehicles: fleet, stations: [], sourceRecs: recsL, now: u0 });
  q = T.trackRun(q.state, { vehicles: [fleet[2]], stations: [], sourceRecs: recsL, now: u0 + dt });
  const s1 = q.hourly.get('08416041|Lime|scooter').start[T.hourOf(u0 + dt)];
  q.state.srcStats.lime = { runs: 10, present: 500, gone: 20, moved: 40, newc: 30, returned: 30 };
  q = T.trackRun(q.state, { vehicles: [L('a', 48.5001, 9.00, { batteryPct: 95 }), L('b', 48.503, 9.02, { batteryPct: 95 }), fleet[2]], stations: [], sourceRecs: recsL, now: u0 + 2 * dt });
  const h = q.hourly.get('08416041|Lime|scooter'), ea = q.state.v[T.vehicleKey('Lime', 'a')];
  const cEnd = [...q.cells.get('08416041').values()].reduce((s, c) => s + c[1], 0);
  assert(h.swap[hr] === 1 && h.end[hr] === 2 && s1 === 2 && cEnd === 2 && h.swapWaitN === 1 && h.swapWaitSum === 2 * dt, 'Z4: Rückkehr 11 m mit 18 → 95 % = Tausch und Fahrtende (Beginne 2 = Enden 2, auch je Zelle); 330 m entfernt = Fahrtende');
  assert(ea[8] === u0 && ea[9] === 0 && h.swapWaitCens === 1, 'Z4: Rückkehr-Tausch: Standzeit läuft weiter, unter 20 % seit Messbeginn = zensierte Wartezeit');
}
// Z5: Standzeit-Plausibilität je Quelle (≥ 200 Fahrzeuge, > 50 % unter einem Laufintervall = unbrauchbar)
{
  const u0 = Date.parse('2026-11-12T10:00:00Z'), dt = 20 * 60e3;
  const N = (k, i) => V(`r${k}-${i}`, 48.0 + i * 0.002, 8.5, { operator: 'nextbike', sourceId: 'nbk', type: 'bike', batteryPct: null });
  const W = (i) => V('v' + i, 47.5 + i * 0.002, 8.0, { operator: 'Voi', sourceId: 'voi', batteryPct: 50 + (i % 40) });
  const recs2 = [{ id: 'nbk', status: 'live' }, { id: 'voi', status: 'live' }];
  const rk = (k, n = 250) => [...Array(n)].map((_, i) => N(k, i)), voi = [...Array(250)].map((_, i) => W(i));
  let q = T.trackRun(null, { vehicles: [...rk(0), ...voi], stations: [], sourceRecs: recs2, now: u0 });
  q.state.srcStats.nbk = { runs: 10, present: 500, gone: 50, moved: 0, newc: 50, returned: 0, rotated: 0 }; // Wechsel je Fahrt (streng), ohne Ladestand: keine Paarung
  q = T.trackRun(q.state, { vehicles: [...rk(1), ...voi], stations: [], sourceRecs: recs2, now: u0 + dt });
  assert(q.idleUnusable.nbk?.share === 1 && q.idleUnusable.nbk.n === 250 && !q.idleUnusable.voi, 'Z5: Kennung je Lauf neu (250 Räder, 100 % unter 20 Min.) = Standzeit unbrauchbar; stabile Quelle nicht');
  assert(!Object.keys(q.idle).some(k => k.includes('nextbike')) && q.idle['08416041|Voi|scooter']?.[6] === 250, 'Z5: unbrauchbare Quelle fehlt in idle, übrige bleiben');
  q = T.trackRun(q.state, { vehicles: [...rk(2), ...voi], stations: [], sourceRecs: recs2, now: u0 + dt + 3 * 3600e3 });
  assert(q.gap && q.idleUnusable.nbk, 'Z5: Lauf nach Lücke übernimmt den Befund des Vorlaufs');
  q = T.trackRun(q.state, { vehicles: [...rk(3, 150), ...voi], stations: [], sourceRecs: recs2, now: u0 + 2 * dt + 3 * 3600e3 });
  assert(!q.idleUnusable.nbk, 'Z5: unter 200 Fahrzeugen kein Befund');
  // Positionen springen je Lauf um 60 m (Standzeit beginnt neu, kein Massenwechsel): Quelle unbrauchbar, ihre gemeinsamen Ankünfte bilden keine Gruppe (Z7)
  const n0 = Date.parse('2026-11-12T01:00:00Z'), J = (k, i) => V('j' + i, 48.0 + i * 0.002 + (k % 2) * 0.00055, 8.5, { operator: 'nextbike', sourceId: 'nbj', type: 'bike', batteryPct: null });
  const jit = (k) => [...Array(250)].map((_, i) => J(k, i)), five = [...Array(5)].map((_, i) => V('x' + i, 49.0 + i * 0.00002, 8.9, { operator: 'nextbike', sourceId: 'nbj', type: 'bike', batteryPct: null }));
  let w = T.trackRun(null, { vehicles: jit(0), stations: [], sourceRecs: [{ id: 'nbj', status: 'live' }], now: n0 });
  w = T.trackRun(w.state, { vehicles: jit(1), stations: [], sourceRecs: [{ id: 'nbj', status: 'live' }], now: n0 + dt });
  w = T.trackRun(w.state, { vehicles: [...jit(2), ...five], stations: [], sourceRecs: [{ id: 'nbj', status: 'live' }], now: n0 + 2 * dt });
  assert(w.idleUnusable.nbj && !w.groups.length, 'Z5/Z7: springende Positionen = Standzeit unbrauchbar; 5 neue Räder dieser Quelle nachts keine Ausbringung');
}
// Z5: stiller Quellenausfall (Quelle einen Lauf error) – Rückkehr am Ort (< 50 m) behält die Standzeit und zählt nicht in die Standzeit-Prüfung;
// versetzt zurück = bewegt; Rückkehr nach Verschwinden bei laufender Quelle beginnt die Standzeit wie bisher neu
{
  const u0 = Date.parse('2026-11-12T10:00:00Z'), dt = 20 * 60e3;
  const W = (i) => V('w' + i, 47.5 + i * 0.002, 8.0, { operator: 'Voi', sourceId: 'voiS', batteryPct: 60 });
  const fleet = [...Array(250)].map((_, i) => W(i)), live = [{ id: 'voiS', status: 'live' }], err = [{ id: 'voiS', status: 'error' }];
  let q = T.trackRun(null, { vehicles: fleet, stations: [], sourceRecs: live, now: u0 });
  for (let k = 1; k < 4; k++) q = T.trackRun(q.state, { vehicles: fleet, stations: [], sourceRecs: live, now: u0 + k * dt });
  q = T.trackRun(q.state, { vehicles: [], stations: [], sourceRecs: err, now: u0 + 4 * dt });
  const back = fleet.map((v, i) => (i === 0 ? { ...v, lat: v.lat + 0.0027 } : v)); // w0 300 m versetzt
  q = T.trackRun(q.state, { vehicles: back, stations: [], sourceRecs: live, now: u0 + 5 * dt });
  const K = (id) => q.state.v[T.vehicleKey('Voi', id)];
  assert(!q.idleUnusable.voiS && K('w1')[8] === u0 && K('w0')[8] === u0 + 5 * dt && q.idle['08416041|Voi|scooter']?.[6] === 250 && q.idleCens['08416041|Voi|scooter']?.[0] === 249,
    'Z5: nach stillem Ausfall am Ort zurück = Standzeit läuft weiter (249 seit Beginn, zensiert), nicht „unbrauchbar“; 300 m versetzt = bewegt');
  q = T.trackRun(q.state, { vehicles: back.filter((v, i) => i !== 2), stations: [], sourceRecs: live, now: u0 + 6 * dt });
  q = T.trackRun(q.state, { vehicles: back, stations: [], sourceRecs: live, now: u0 + 7 * dt });
  assert(K('w2')[8] === u0 + 7 * dt && K('w1')[8] === u0 && !q.idleUnusable.voiS, 'Z5: Rückkehr nach Verschwinden bei laufender Quelle (Fahrt) beginnt die Standzeit neu');
}
// Z6: Standzeit, Wartezeit bis Tausch und Sperrdauer linkszensiert (seit Beginn der Verfolgung unbewegt bzw. seit erster Sichtung niedrig/gesperrt)
{
  const u0 = Date.parse('2026-11-12T10:00:00Z'), dt = 20 * 60e3, hr = T.hourOf(u0 + 2 * dt);
  const B = (id, lat, extra = {}) => V(id, lat, 9.6, { operator: 'Bolt', sourceId: 'bc', ...extra });
  const rc = [{ id: 'bc', status: 'live' }];
  const r1 = [B('a', 48.1), B('b', 48.2, { batteryPct: 10 }), B('c', 48.3, { disabled: true }), B('m', 48.4)];
  let q = T.trackRun(null, { vehicles: r1, stations: [], sourceRecs: rc, now: u0 });
  q = T.trackRun(q.state, { vehicles: [...r1, B('n', 48.5)], stations: [], sourceRecs: rc, now: u0 + dt });
  q = T.trackRun(q.state, { vehicles: [B('a', 48.1), B('b', 48.2, { batteryPct: 95 }), B('c', 48.3), B('m', 48.402), B('n', 48.5), B('o', 48.6)], stations: [], sourceRecs: rc, now: u0 + 2 * dt });
  const lim = T.censorLimit(q.state), E = (id) => q.state.v[T.vehicleKey('Bolt', id)], C = (id) => T.isCensored(lim, E(id)[8], E(id)[7]);
  assert(q.state.trackStart === u0 && q.state.trackStart2 === u0 + dt && lim === u0 + dt, 'Z6: Verfolgungsbeginn und zweiter Lauf im Zustand');
  assert(C('a') && C('n') && !C('o') && !C('m'), 'Z6: zensiert = erste Sichtung im 1./2. Lauf und seitdem unbewegt (a, n); neu im 3. Lauf (o) bzw. bewegt (m) nicht');
  const k = '08416041|Bolt|scooter', h = q.hourly.get(k);
  assert(q.idle[k][6] === 5 && q.idleCens[k][0] === 4, 'Z6: idle 5 Fahrzeuge (neue ohne Standzeit), davon 4 zensiert (a, b, c, n)');
  assert(h.swap[hr] === 1 && h.swapWaitCens === 1 && h.disOff[hr] === 1 && h.disDurCens === 1, 'Z6: Tausch und Entsperrung nach Niedrig/Gesperrt seit erster Sichtung = zensierte Werte');
  const legacy = { ...q.state }; delete legacy.trackStart; delete legacy.trackStart2;
  const q2 = T.trackRun(legacy, { vehicles: [B('a', 48.1)], stations: [], sourceRecs: rc, now: u0 + 3 * dt });
  assert(q2.state.trackStart === u0 && q2.state.trackStart2 === u0 + dt, 'Z6: älterer Zustand ohne Angabe: kleinste und zweitkleinste erste Sichtung');
  const old = { day: '2026-11-12', runs: [], groups: { [k]: { ...T.emptyHourly() } } }; delete old.groups[k].hide; delete old.groups[k].swapWaitCens;
  const md = T.mergeHourly(old, q.hourly, { day: '2026-11-12', at: u0 + 2 * dt, dt, srcModes: {} });
  assert(md.groups[k].hide.length === 24 && md.groups[k].swapWaitCens === 1 && md.groups[k].disDurCens === 1, 'Z6: ältere Tagesdatei ohne hide/Zensur-Zähler wird ergänzt');
  assert(T.IDLE_LABELS.length === T.IDLE_BUCKETS.length + 1 && T.IDLE_LABELS.at(-1) === '> 72 h', 'Z6: Klasse > 72 h');
}
// Z7: Gruppen – frei abgestellt tagsüber nur Ausbringungen voller Fahrzeuge (≥ 85 %), Einsammeln nur nachts; stationsgebunden auch virtuelle Stationen aus
{
  const dt = 20 * 60e3;
  const D = (id, lat, lon, bat) => V(id, lat, lon, { operator: 'Dott', sourceId: 'dg', batteryPct: bat });
  const rc = [{ id: 'dg', status: 'live' }];
  const base = [...Array(40)].map((_, i) => D('b' + i, 48.40 + i * 0.01, 9.00, 60));
  const full = [...Array(4)].map((_, i) => D('f' + i, 48.90, 9.50 + i * 0.00005, 90)), half = [...Array(4)].map((_, i) => D('h' + i, 48.95, 9.55 + i * 0.00005, 50));
  const seq = (u0) => { let q = T.trackRun(null, { vehicles: base, stations: [], sourceRecs: rc, now: u0 }); q = T.trackRun(q.state, { vehicles: base, stations: [], sourceRecs: rc, now: u0 + dt });
    const a = T.trackRun(q.state, { vehicles: [...base, ...full, ...half], stations: [], sourceRecs: rc, now: u0 + 2 * dt }); const b = T.trackRun(a.state, { vehicles: base, stations: [], sourceRecs: rc, now: u0 + 3 * dt }); return [a.groups, b.groups]; };
  const [dDep, dCol] = seq(Date.parse('2026-11-13T09:00:00Z')); // 10–11 Uhr Ortszeit
  assert(dDep.length === 1 && dDep[0].kind === 'deploy' && Math.abs(dDep[0].lat - 48.90) < 1e-4 && !dCol.length, 'Z7: tagsüber 4 neue mit 90 % = Ausbringung, 4 mit 50 % keine; gemeinsames Verschwinden tagsüber keine Einsammlung');
  const [nDep, nCol] = seq(Date.parse('2026-11-13T01:00:00Z')); // 2–3 Uhr Ortszeit
  assert(nDep.length === 2 && nCol.length === 2 && nCol.every(g => g.kind === 'collect'), 'Z7: nachts beide Ausbringungen und beide Einsammlungen');
  // stationsgebunden (alle Räder an eigenen virtuellen Stationen): 5 neue an einer Abstellzone = Nutzerverkehr, auch nachts
  const u0 = Date.parse('2026-11-13T01:00:00Z');
  const Nb = (id, lat, lon) => V(id, lat, lon, { operator: 'nextbike', sourceId: 'nbz', type: 'bike', batteryPct: null });
  const st = [...Array(20)].map((_, i) => ({ operator: 'nextbike', id: 's' + i, name: 'S' + i, lat: 52.40 + i * 0.01, lon: 13.20, ags: '08416041', bookable: 1, docksAvailable: null, renting: true, installed: true, returning: true, isVirtual: true }));
  const zone = { ...st[0], id: 'z', lat: 52.70, lon: 13.50 };
  const nb = st.map((s, i) => Nb('n' + i, s.lat + 0.0001, s.lon)), rc2 = [{ id: 'nbz', status: 'live' }];
  let q = T.trackRun(null, { vehicles: nb, stations: [...st, zone], sourceRecs: rc2, now: u0 });
  q = T.trackRun(q.state, { vehicles: nb, stations: [...st, zone], sourceRecs: rc2, now: u0 + dt });
  q = T.trackRun(q.state, { vehicles: [...nb, ...[...Array(5)].map((_, i) => Nb('z' + i, 52.70 + i * 0.00002, 13.50))], stations: [...st, zone], sourceRecs: rc2, now: u0 + 2 * dt });
  assert(!q.groups.length, 'Z7: stationsgebundenes System: 5 Räder an einer virtuellen Station = keine Ausbringung');
  const night = T.groupNight([[Date.parse('2026-11-13T22:30:00Z'), 'deploy', 'Dott'], [Date.parse('2026-11-13T11:00:00Z'), 'deploy', 'Dott'], [Date.parse('2026-11-13T17:00:00Z'), 'collect', 'nextbike']]);
  assert(night.Dott.n === 2 && night.Dott.share === 0.5 && night.nextbike.share === 0, 'Z7: Nachtanteil je Anbieter (22–7 Uhr Ortszeit)');
  const ix = T.groupIndex(['2026-11'], { '2026-11': 3 }, { night });
  assert(ix.night30.Dott.share === 0.5 && ix.rules.demandMain.from === 7 && ix.rules.deployMinBattery === 85, 'Z7: groups/index.json mit Nachtanteil und Regeln');
}
