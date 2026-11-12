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
}

console.log(`${oks} ok, ${fails} Fehler`);
if (fails) process.exitCode = 1;
