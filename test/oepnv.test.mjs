// ÖPNV-Störungen aus gtfs.de (lib/pulse-oepnv.js): Protobuf, ZIP-Teilabruf, Haltestellen → Gemeinde, Zählung, Eintrag
import { inflateRawSync } from 'node:zlib';
import * as OE from '../lib/pulse-oepnv.js';
import * as T from '../lib/pulse-track.js';
import * as CX from '../lib/pulse-context.js';
import { encodeFeed, makeZip, pbInt, pbMsg } from './fixtures/gtfs.mjs';

let fails = 0, oks = 0;
const assert = (c, m) => { if (!c) { console.error('FEHLER:', m); fails++; } else { console.log('ok:', m); oks++; } };

// Protobuf: negatives int32 (Verspätung −60 s) und große Zeiten
{
  const b = Buffer.concat([pbInt(1, -60), pbInt(2, 1794470361), pbMsg(3, 'abc')]), f = [...OE.pbFields(b)];
  assert(f[0][3] === -60 && f[1][2] === 1794470361 && f[2][1] === 2 && b.subarray(...f[2][2]).toString() === 'abc', 'Protobuf: negatives int32 exakt, int64-Zeit, Längenfeld');
}

// Halte einer Fahrt: ausgefallener Halt ohne Zeit erbt die Zeit davor, Fahrt ohne Zeiten nimmt den Fahrtbeginn, abgesagte Fahrt = alle ausgefallen
{
  const t0 = Date.parse('2026-11-12T07:00:00Z');
  const buf = encodeFeed([
    { id: 'a', stops: [{ stop: 1, t: t0, delay: 30 }, { stop: 2, t: null, skipped: true }, { stop: 3, t: t0 + 600e3, delay: 420 }] },
    { id: 'b', startDate: '20261112', startTime: '08:15:00', stops: [{ stop: 4, t: null, skipped: true }] },
    { id: 'c', canceled: true, stops: [{ stop: 5, t: t0 + 60e3 }, { stop: 6, t: t0 + 120e3 }] },
  ], { ts: t0, alerts: 2 });
  const seen = []; const head = OE.forEachStop(buf, (s, t, sk, d) => seen.push([s, t, sk, d]));
  assert(head.trips === 3 && head.stops === 6 && head.alerts === 2 && head.canceled === 1 && head.ts === t0 && head.incr === 0, 'Kopf und Zähler (3 Fahrten, 6 Halte, 2 Meldungen, 1 abgesagt)');
  assert(seen[1][0] === '2' && seen[1][1] === t0 && seen[1][2] === true, 'ausgefallener Halt ohne Zeit: Zeit des Halts davor');
  assert(seen[2][3] === 420 && seen[0][3] === 30 && seen[2][2] === false, 'Verspätung je Halt');
  assert(seen[3][1] === Date.parse('2026-11-12T07:15:00Z') && seen[3][2], 'Fahrt ohne Zeiten: Fahrtbeginn aus start_date/start_time (Ortszeit)');
  assert(seen[4][2] && seen[5][2], 'abgesagte Fahrt: alle Halte ausgefallen');
}

// ZIP: nur stops.txt aus dem Ende lesen und entpacken
{
  const stops = 'stop_name,parent_station,stop_id,stop_lat,stop_lon,location_type,platform_code\n"Hbf, Gleis 1",9,10,48.7840,9.1820,,1\nHbf,,9,48.7841,9.1817,1,\n"Tübingen ""Mitte""",,20,48.5200,9.0550,0,\nAusland,,30,47.0,8.0,,\nOhne Lage,,40,,,,\n';
  const zip = makeZip({ 'agency.txt': 'agency_id\n1\n', 'stops.txt': stops, 'trips.txt': 'x\n' }), tailAt = Math.max(0, zip.length - 250);
  const e = OE.zipEntries(zip.subarray(tailAt), tailAt).find(x => x.name === 'stops.txt'), start = OE.zipDataStart(zip.subarray(e.at, e.at + 30), e.at);
  const text = inflateRawSync(zip.subarray(start, start + e.csize)).toString('utf8');
  assert(e.method === 8 && e.size === Buffer.byteLength(stops) && text === stops, 'ZIP: Verzeichnis aus dem Ende, lokaler Kopf mit Extrafeld, Inhalt gleich');
  assert(JSON.stringify(OE.csvLine('"a, b",,"c ""d"""')) === JSON.stringify(['a, b', '', 'c "d"']), 'CSV mit Kommas und doppelten Anführungszeichen');
  const ix = OE.stopIndex(text, (lat) => (lat > 48.7 ? '08111000' : lat > 48 ? '08416041' : null));
  assert(ix.rows === 5 && ix.stops === 4 && ix.mapped === 2 && ix.ags.join() === '08111000,08416041' && ix.id.join() === '10,20', 'Haltestellen: Stationen (location_type 1), Ausland und Halte ohne Lage fallen weg');
  const lk = OE.stopLookup(ix); assert(lk.get('10') === '08111000' && lk.get('20') === '08416041' && !lk.has('9'), 'Suche stop_id → AGS');
}

// Zählen: Fenster [now − 26 h, now), künftige Halte zählen nicht, nur Gemeinden mit Flotte (keep); Kennzeichen ab 20 Halten
{
  const now = Date.parse('2026-11-12T09:30:00Z'), h0 = Date.parse('2026-11-12T08:00:00Z'), lookup = new Map([['1', '08111000'], ['2', '08416041'], ['3', '09162000']]);
  const stops = [...Array(25)].map((_, i) => ({ stop: 1, t: h0 + i * 60e3, delay: i < 3 ? 400 : 0, skipped: i >= 20 }));
  stops.push({ stop: 1, t: now + 600e3 }, { stop: 1, t: now - 30 * 3600e3 }, { stop: 2, t: h0 + 5e3 }, { stop: 3, t: h0 + 5e3 }, { stop: 99, t: h0 });
  const buf = encodeFeed([{ id: 'x', stops: stops.filter(s => !s.skipped || true).map(s => (s.skipped ? { ...s, t: null } : s)) }]);
  const { by, stats } = OE.ptCounts(buf, lookup, now, { keep: new Set(['08111000', '08416041']) });
  const c = by.get('08111000')?.get(h0);
  assert(c && c[0] === 25 && c[1] === 5 && c[2] === 3, `Stuttgart 9 Uhr: 25 Halte, 5 ausgefallen, 3 verspätet (${c})`);
  assert(stats.unmatched === 1 && stats.matched === 29 && stats.inWindow === 26 && !by.has('09162000') && by.get('08416041')?.get(h0)?.[0] === 1, 'Zuordnung, Fenster und Gemeinden ohne Flotte');
  const docs = new Map(), w = OE.addPt(docs, by), d = docs.get(T.dayOf(h0)), h = T.hourOf(h0);
  assert(d.ags['08111000'].ptN[h] === 25 && d.ags['08111000'].pt[h] === 1 && d.ags['08416041'].pt[h] === 0 && w.flagged === 1 && w.cells === 2, 'Eintrag: 20 % ausgefallen → pt = 1; ein Halt reicht nicht');
  // späterer Lauf sieht beendete Fahrten nicht mehr: weniger Halte überschreiben nicht
  OE.addPt(docs, new Map([['08111000', new Map([[h0, [10, 0, 0]]])]]));
  assert(d.ags['08111000'].ptN[h] === 25 && d.ags['08111000'].ptSkip[h] === 5 && d.ags['08111000'].pt[h] === 1, 'Maximum über die Läufe: späterer Lauf mit weniger Halten ändert nichts');
  OE.addPt(docs, new Map([['08111000', new Map([[h0, [40, 1, 2]]])]]));
  assert(d.ags['08111000'].ptN[h] === 40 && d.ags['08111000'].pt[h] === 0, 'mehr Halte: neue Zahlen, Kennzeichen neu berechnet');
  assert(OE.ptFlag(20, 0, 6) === 1 && OE.ptFlag(19, 19, 19) === 0 && OE.ptFlag(100, 14, 29) === 0, 'Kennzeichen: Schwellen 15 % ausgefallen oder 30 % verspätet ab 20 Halten');
  assert(OE.OEPNV.keys.every(k => !CX.CTX_KEYS.includes(k)), 'ÖPNV-Felder sind keine Modellmerkmale (Lernphase)');
  // ganz ausgefallene Fahrten ohne Zeit (nur trip_id und start_date): je Betriebstag und Gemeinde, Fahrten einmal je Gemeinde
  const cbuf = encodeFeed([{ id: 'k1', startDate: '20261112', stops: [{ stop: 1, t: null, skipped: true }, { stop: 1, t: null, skipped: true }, { stop: 2, t: null, skipped: true }] },
    { id: 'k2', startDate: '20261112', stops: [{ stop: 1, t: null, skipped: true }] }, { id: 'k3', startDate: '20260101', stops: [{ stop: 1, t: null, skipped: true }] }, { id: 'k4', stops: [{ stop: 1, t: null, skipped: true }] }]);
  const r = OE.ptCounts(cbuf, lookup, now, { keep: new Set(['08111000', '08416041']) });
  assert(r.cancel.get('08111000')?.get('2026-11-12')?.join() === '2,3' && r.cancel.get('08416041')?.get('2026-11-12')?.join() === '1,1' && r.stats.cancelTrips === 3 && r.stats.noTime === 6 && r.by.size === 0,
    'ausgefallene Fahrten ohne Zeit: Stuttgart 2 Fahrten/3 Halte, Tübingen 1/1; alter Tag und Fahrt ohne Datum fallen weg');
  const cd = new Map([['2026-11-12', CX.emptyIncidentDoc('2026-11-12')]]); OE.addPt(cd, r.by, r.cancel); OE.addPt(cd, new Map(), new Map([['08111000', new Map([['2026-11-12', [1, 1]]])]]));
  assert(cd.get('2026-11-12').ptDay['08111000'].join() === '2,3' && cd.size === 1, 'ptDay: Maximum über die Läufe, kein neuer Tag ohne Grund');
}

// ---------- Reiter ÖPNV (lib/pulse-oepnv-netz.js): Stationen, Zählung, Fahrzeugwege, Wirkung, Vorschläge ----------
{
  const NZ = await import('../lib/pulse-oepnv-netz.js');
  const stops = 'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\nde:08111:10:1:1,Hauptbahnhof,48.7840,9.1820,,\nde:08111:10:2:3,Hauptbahnhof,48.7844,9.1824,,\nde:08111:20:0:1,Stadtmitte,48.7760,9.1730,,\np1,Uni,48.7500,9.1000,,par\nde:08416:5:0:1,Tübingen Hbf,48.5160,9.0550,,\n';
  const ix = OE.stopIndex(stops, (lat) => (lat > 48.7 ? '08111000' : '08416041'), new Set(['08111000']));
  assert(ix.st.id.join() === 'de:08111:10,de:08111:20,par' && ix.st.name[0] === 'Hauptbahnhof' && ix.st.lat[0] === 48.7842 && ix.s.join() === '0,0,1,2,-1' && OE.stationLookup(ix).size === 4 && OE.stationKey('abc') === 'abc',
    'Stationen: Steige einer DELFI-Kennung zusammen, parent_station geht vor, Lage = Mittel, nur Gemeinden mit Flotte');
  ix.routes = OE.routeIndex('route_id,route_short_name,route_long_name,route_type\nr1,U6,,400\nr2,,Stadtbus 42,3\n');
  assert(ix.routes.r1.join() === 'U6,400' && ix.routes.r2[0] === 'Stadtbus 42' && NZ.typeClass(400) === 'bahn' && NZ.typeClass(3) === 'bus' && NZ.typeClass(900) === 'tram' && NZ.typeClass(null) === 'sonst', 'Linien: Kurzname, sonst Langname; Art aus route_type');
  const now = Date.parse('2026-11-16T10:00:00Z'), m = 60e3; // 11 Uhr Ortszeit
  const feed = encodeFeed([
    { id: 'a', route: 'r1', stops: [{ stop: 'de:08111:10:1:1', t: now - 4 * m, delay: 360 }, { stop: 'de:08111:20:0:1', t: now + 6 * m, delay: 360 }, { stop: 'p1', t: now + 70 * m, delay: 300 }] },
    { id: 'b', route: 'r2', stops: [{ stop: 'de:08111:20:0:1', t: now - 30 * m, delay: 0 }, { stop: 'de:08111:10:2:3', t: now - 20 * m, delay: 60 }] },
    { id: 'c', canceled: true, stops: [{ stop: 'de:08111:10:1:1', t: now - 10 * m }, { stop: 'de:08111:20:0:1', t: now + 5 * m }] },
    { id: 'd', stops: [{ stop: 'de:08111:10:1:1', t: now + 2 * m, delay: 0 }, { stop: 'zzz', t: now + 4 * m }, { stop: 'de:08111:20:0:1', t: null, skipped: true }, { stop: 'p1', t: now + 12 * m, delay: 0 }] },
  ], { ts: now });
  const lk = OE.stationLookup(ix), counter = NZ.stationCounter(lk, ix.st.id), paths = NZ.pathCollector(lk, ix, now);
  OE.ptCounts(feed, OE.stopLookup(ix), now, { onStop: counter.onStop, onTrip: paths.onTrip });
  const cnt = counter.result(), blk = cnt['2026-11-16|1'];
  assert(Object.keys(cnt).join() === '2026-11-16|1' && blk['de:08111:10'].join() === '3,1,1,420,2' && blk['de:08111:20'].join() === '1,0,0,0,1', `Zählung je Station im Block 6–12 Uhr: Hbf 3 Halte, 1 ausgefallen, 1 verspätet (${JSON.stringify(blk)})`);
  const pr = paths.result(), tr = pr.by.get('08111000');
  assert(pr.trips === 2 && pr.withRoute === 1 && tr.length === 2 && tr[0][0] === 'U6' && tr[0][1] === 'bahn' && tr[0][2] === 360 && tr[0][3].join() === '48.7842,9.1822,-240,48.776,9.173,360,48.75,9.1,4200' && tr[1][0] === null && tr[1][3].length === 6,
    `Fahrzeugwege: laufende Fahrten ab dem letzten Halt, abgesagte und beendete fehlen, ausgefallener Halt und unbekannte Station übersprungen (${JSON.stringify(tr)})`);
  const w = tr[0][3], p0 = NZ.positionAt(w, 0), pEnd = NZ.positionAt(w, 5000), d = tr[1][3];
  assert(Math.abs(p0[0] - (48.7842 + (48.776 - 48.7842) * 0.4)) < 1e-9 && pEnd === null && NZ.positionAt(d, 0).join() === '48.7842,9.1822' && NZ.positionAt(d, -200) === null && NZ.positionAt(w, 360).join() === '48.776,9.173', 'Lage: 4 von 10 Minuten zwischen zwei Stationen, vor der Abfahrt höchstens 2 Minuten am ersten Halt, nach dem Ende weg');
  // Zustand: je Block der Lauf mit den meisten Halten, nach 14 Stunden in die Summe, Summe altert
  const st = NZ.emptyNetzState(); NZ.mergeCounts(st, cnt, now); NZ.mergeCounts(st, { '2026-11-16|1': { 'de:08111:10': [2, 0, 0, 0, 2], 'de:08111:20': [5, 1, 0, 60, 4] } }, now + 20 * m);
  assert(st.open['2026-11-16|1']['de:08111:10'][0] === 3 && st.open['2026-11-16|1']['de:08111:20'][0] === 5 && st.days === 0, 'Zustand: je Block und Station gilt der Lauf mit den meisten Halten');
  const t1 = NZ.stationTotals(st, '2026-11-16'), rows = NZ.stationRows(ix, NZ.stationsByAgs(ix).get('08111000'), t1);
  assert(rows.length === 2 && rows[0][0] === 'de:08111:20' && rows[0].join() === 'de:08111:20,Stadtmitte,48.776,9.173,5,1,0,0.3,5,1,0' && rows[1][7] === 3.5, `Zeilen je Station, nach Halten (${rows[0].join()})`);
  const r2 = NZ.mergeCounts(st, {}, Date.parse('2026-11-17T02:30:00Z'));
  assert(r2.closed === 1 && !st.open['2026-11-16|1'] && Math.abs(st.tot['de:08111:10'][0] - 3) < 1e-9 && st.days === 0.25 && NZ.stationTotals(st, '2026-11-17').get('de:08111:10').day[0] === 0, 'Block 14 Stunden nach seinem Ende in der Summe (0,25 Tage)');
  NZ.mergeCounts(st, {}, Date.parse('2026-11-24T10:00:00Z'));
  assert(Math.abs(st.tot['de:08111:10'][0] - 1.5) < 1e-9 && Math.abs(st.days - 0.125) < 1e-9, 'Summe halbiert sich nach 7 Tagen');
  // Stunden aus den Störungs-Dokumenten
  const doc = (day, flagH, mult) => ({ ags: { '08111000': { ptN: new Array(24).fill(100), ptSkip: new Array(24).fill(0).map((_, h) => (flagH.includes(h) ? 20 : 2)), ptLate: new Array(24).fill(5), pt: new Array(24).fill(0).map((_, h) => (flagH.includes(h) ? 1 : 0)) } }, ptDay: { '08111000': [4, 30] }, mult });
  const days = ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13'], docs = new Map(days.map((d, i) => [d, doc(d, i < 3 ? [8, 9, 17] : [], 1)]));
  const hrs = NZ.hoursOf(docs, '08111000', [...days, '2026-11-14']);
  assert(hrs.days.length === 4 && hrs.skip[0][8] === 20 && hrs.flag[3][8] === 0 && hrs.cancel.join() === '4,4,4,4', 'Stunden je Tag aus den Störungs-Dokumenten, Tag ohne Daten fehlt');
  // Wirkung: gestörte Stunden +20 % Fahrten gegen die Prognose, sonst ±0 (mit kleinem Rauschen je Tag)
  const series = { days: Object.fromEntries(days.map((d, i) => [d, { 'ags:08111000': { p: new Array(24).fill(100), a: new Array(24).fill(0).map((_, h) => (i < 3 && [8, 9, 17].includes(h) ? 120 + i : 100 + (h % 3) - 1)) } }])) };
  const eff = NZ.ptEffect(docs, series, { today: '2026-11-14' }), c = eff.cities[0];
  assert(eff.cities.length === 1 && c.days === 3 && c.hours === 9 && c.verdict === 'mehr' && Math.abs(c.effect - 0.21) < 0.005 && c.ci[0] > 0.15 && eff.pooled === null, `Wirkung: +21 % in gestörten Stunden, je Tag ein Wert, Intervall über der Null (${JSON.stringify(c)})`);
  assert(NZ.ptEffect(docs, series, { today: '2026-11-11' }).cities[0].verdict === 'zu wenig Tage' && NZ.ptEffect(new Map(), series).cities.length === 0, 'Wirkung: unter 3 gestörten Tagen kein Urteil');
  // Vorschläge für Sharing-Stationen
  const sr = [['a', 'Viel und gestört', 48.78, 9.18, 4000, 400, 800, 3, 0, 0, 0], ['b', 'Viel, pünktlich', 48.79, 9.19, 4000, 10, 40, 1, 0, 0, 0], ['c', 'Hat Fläche', 48.77, 9.17, 5000, 500, 900, 3, 0, 0, 0], ['d', 'Klein', 48.76, 9.16, 40, 0, 0, 0, 0, 0, 0]];
  const hub = NZ.hubCandidates(sr, { days: 4, demand: [[48.7801, 9.1801, 50], [48.7901, 9.1901, 5], [48.90, 9.3, 999]], vehicles: [{ lat: 48.7802, lon: 9.1802 }, { lat: 48.5, lon: 9 }], existing: [[48.7701, 9.1701, 10]] });
  assert(hub.rows.length === 2 && hub.rows[0].id === 'a' && hub.rows[0].ends === 50 && hub.rows[0].vehicles === 1 && hub.rows[0].perDay === 1000 && hub.rows[0].stoer === 0.3 && hub.withArea === 1 && hub.stations === 3 && hub.rows[0].score > hub.rows[1].score,
    `Vorschläge: viel ÖPNV, oft gestört, Nachfrage vorhanden zuerst; Station mit Fläche zählt nicht, unter 30 Halten je Tag fällt weg (${hub.rows.map(x => x.id + ' ' + x.score).join(', ')})`);
}

// ---------- Linien aus trips.txt, Zählung je Linie, Tagesgang (lib/pulse-oepnv-linien.js) ----------
{
  const LN = await import('../lib/pulse-oepnv-linien.js'), NZ = await import('../lib/pulse-oepnv-netz.js');
  const routes = OE.routeIndex('route_id,route_short_name,route_long_name,route_type\nr1,U6,,400\nr2,,Stadtbus 42,3\nr3,U6,,400\nr4,,,\n');
  const many = Array.from({ length: 5000 }, (_, i) => `r${1 + i % 3},svc,trip-${i},"Ziel, mit Komma"`).join('\r\n');
  const tt = LN.tripTable(Buffer.from(`﻿route_id,service_id,trip_id,trip_headsign\n${many}\nr4,svc,ohne-linie,x\nr9,svc,unbekannt,x\n`), routes);
  const lk = LN.tripLookup(LN.packTrips(tt));
  assert(tt.n === 5000 && tt.lines === 5002 && tt.routes.length === 2 && lk.n === 5000 && lk.of('trip-0').join() === 'U6,400' && lk.of('trip-1')[0] === 'Stadtbus 42' && lk.of('trip-2')[0] === 'U6' && lk.of('trip-4999')[0] === (4999 % 3 === 1 ? 'Stadtbus 42' : 'U6') && lk.of('ohne-linie') === null && lk.of('gibt-es-nicht') === null,
    `Fahrten-Tabelle: 5.000 Fahrten gepackt und gefunden, gleiche Liniennamen zusammen, Linie ohne Namen und unbekannte Fahrt = null (${tt.n}, ${tt.routes.length})`);
  let threw = false; try { LN.tripLookup(Buffer.from('XXXX0000')); } catch { threw = true; } assert(threw, 'Fahrten-Tabelle: fremdes Format wird abgelehnt');
  const stops = 'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\nde:08111:10:1:1,Hauptbahnhof,48.7840,9.1820,,\nde:08111:20:0:1,Stadtmitte,48.7760,9.1730,,\n';
  const ix = OE.stopIndex(stops, () => '08111000', new Set(['08111000'])); ix.routes = {};
  const now = Date.parse('2026-11-16T10:00:00Z'), m = 60e3, of = (id) => (id === 'a' ? ['U6', 400] : id === 'b' ? ['42', 3] : null);
  const feed = encodeFeed([
    { id: 'a', stops: [{ stop: 'de:08111:10:1:1', t: now - 20 * m, delay: 400 }, { stop: 'de:08111:20:0:1', t: now - 10 * m, delay: 60 }, { stop: 'de:08111:10:1:1', t: now + 10 * m, delay: 60 }] },
    { id: 'b', stops: [{ stop: 'de:08111:10:1:1', t: now - 5 * m }, { stop: 'de:08111:20:0:1', t: null, skipped: true }] },
    { id: 'c', stops: [{ stop: 'de:08111:10:1:1', t: now - 5 * m, delay: 0 }] },
  ], { ts: now });
  const sl = OE.stationLookup(ix), lines = LN.lineCounter(sl, ix, now, { routeOf: of }), paths = NZ.pathCollector(sl, ix, now, { routeOf: of });
  OE.ptCounts(feed, OE.stopLookup(ix), now, { onTrip: (...a) => { lines.onTrip(...a); paths.onTrip(...a); } });
  const st = NZ.emptyNetzState(); NZ.mergeCounts(st, lines.result(), now);
  const rows = LN.lineRows(NZ.stationTotals(st, '2026-11-16')).get('08111000');
  assert(lines.trips() === 2 && rows.length === 2 && rows[1].join() === 'U6,bahn,2,0,1,3.8,2,0,1' && rows[0].slice(0, 5).join() === '42,bus,2,1,0',
    `Linien: nur vergangene Halte, Fahrt ohne Linie fällt weg, ausgefallener Halt zählt, verspätet ab 5 Minuten (${JSON.stringify(rows)})`);
  assert(paths.result().withRoute === 1 && paths.result().by.get('08111000')[0][0] === 'U6', 'Fahrzeugwege: Linie aus der Fahrten-Tabelle, wenn der Strom keine nennt');
  const day = (n, a) => ({ ags: { '08111000': { ptN: n } }, _a: a }), ptN = Array.from({ length: 24 }, (_, h) => (h >= 5 && h < 23 ? 400 : h === 23 ? 60 : 0)), sh = Array.from({ length: 24 }, (_, h) => (h < 2 ? 12 : h < 5 ? 1 : h === 23 ? 20 : 30));
  const docs = new Map([['2026-11-14', day(ptN)], ['2026-11-15', day(ptN)], ['2026-11-16', day(ptN.map(x => x * 9))]]), series = { days: { '2026-11-14': { 'ags:08111000': { a: sh } }, '2026-11-15': { 'ags:08111000': { a: sh } } } };
  const pf = LN.dayProfile(docs, series, '08111000', { today: '2026-11-16' });
  assert(pf.days === 2 && pf.pt[8] === 400 && pf.sharing[0] === 12 && pf.gap.join() === '0,1,23' && LN.dayProfile(docs, null, '08111000') === null,
    `Tagesgang: Mittel ohne den laufenden Tag; Lücke = ÖPNV unter 25 % des Höchstwerts und ≥ 3 Fahrtbeginne (${pf.gap.join()})`);
}

console.log(`${oks} ok, ${fails} Fehler`);
if (fails) process.exitCode = 1;
