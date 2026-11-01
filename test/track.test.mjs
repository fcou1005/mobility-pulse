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
// Gruppen: 6 neue Kennungen am selben Ort = Ausbringen; 6 verschwinden zusammen = Einsammeln
{
  const u0 = Date.parse('2026-11-02T10:00:00Z');
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
  assert(!q.groups.length, 'unter 5 Fahrzeugen keine Gruppe');
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
// M14 – stabile Kennungen: Tempo-Grenzen 3,5–24 km/h (slow/fast), ≥ 2 km ohne Ladestandverlust = Umsetzung, Sammeltransport mit Rückkehrern
{
  const L = (id, lat, lon, extra = {}) => V(id, lat, lon, { operator: 'Lime', sourceId: 'lime', ...extra });
  const recsL = [{ id: 'lime', status: 'live', latencyMs: 50 }];
  const u0 = Date.parse('2026-11-08T10:00:00Z'), t = u0 + 40 * 60e3, hr = T.hourOf(t);
  const fleet = [L('a', 48.50, 9.00), L('b', 48.50, 9.02), L('c', 48.50, 9.04), L('d', 48.50, 9.06), L('e', 48.50, 9.08), L('f', 48.50, 9.10), L('g', 48.50, 9.12)];
  let q = T.trackRun(null, { vehicles: fleet, stations: [], sourceRecs: recsL, now: u0 });
  q = T.trackRun(q.state, { vehicles: fleet.filter(v => v.rawId !== 'g'), stations: [], sourceRecs: recsL, now: u0 + 20 * 60e3 }); // g verschwindet (Fahrtbeginn)
  q.state.srcStats.lime = { runs: 10, present: 500, gone: 20, moved: 40, newc: 30, returned: 30 };
  // a: 500 m (1,5 km/h) = slow; b: 9 km (27 km/h, Akku 50 → 30) = fast; c: 2,2 km, Akku 50 → 50 = Umsetzung ohne Energieverlust; d: 2,2 km, Akku 50 → 47 = Fahrt
  // e, f (versetzt) und g (Rückkehrer) kommen ≤ 40 m beieinander an = Sammeltransport → e, f Umsetzung
  const after = [L('a', 48.5045, 9.00), L('b', 48.58, 9.02, { batteryPct: 30 }), L('c', 48.52, 9.04), L('d', 48.52, 9.06, { batteryPct: 47 }), L('e', 48.60, 9.20), L('f', 48.60005, 9.20), L('g', 48.6001, 9.20005)];
  q = T.trackRun(q.state, { vehicles: after, stations: [], sourceRecs: recsL, now: t });
  const h = q.hourly.get('08416041|Lime|scooter');
  assert(h.slow[hr] === 1 && h.fast[hr] === 1, 'Tempo außerhalb 3,5–24 km/h: gesondert (slow 1, fast 1)');
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
// Zeitumstellung: Tagesdatei trägt Minuten je Ortsstunde
{
  const doc = T.mergeHourly(null, new Map(), { day: '2026-10-25', at: Date.parse('2026-10-25T01:30:00Z'), dt: 20 * 60e3, srcModes: {} });
  assert(doc.hourMin[2] === 120 && doc.hourMin.reduce((a, b) => a + b, 0) === 1500 && T.hourOf(Date.parse('2026-10-25T00:30:00Z')) === 2 && T.hourOf(Date.parse('2026-10-25T01:30:00Z')) === 2, 'hourMin im Tagesdokument, beide Stunden 2 am 25.10.');
}
