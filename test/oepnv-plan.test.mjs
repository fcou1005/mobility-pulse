// Fahrplan für die Live-Karte (lib/pulse-oepnv-plan.js, 20.11.2026): Dienste, Muster, Tabelle, Zusammenführen mit dem Strom, Fahrten ohne Echtzeit
import * as PL from '../lib/pulse-oepnv-plan.js';
import * as NZ from '../lib/pulse-oepnv-netz.js';
let ok = 0, bad = 0;
const assert = (c, m) => { if (!c) { bad++; console.error('FEHLER:', m); } else { ok++; console.log('ok:', m); } };

// Dienste: Mo–Fr, Sa, ein Zusatztag, ein entfallener Tag; 20.11.2026 ist ein Freitag
const cal = 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nwk,1,1,1,1,1,0,0,20261101,20261231\nsa,0,0,0,0,0,1,0,20261101,20261231\nold,1,1,1,1,1,1,1,20250101,20250201\n';
const dates = 'service_id,date,exception_type\nwk,20261123,2\nx1,20261122,1\nsa,20261121,2\n';
const M = PL.serviceMasks(cal, dates, '2026-11-19', 14);
const bits = (...b) => b.reduce((x, k) => x | (1 << k), 0);
assert(M.get('wk') === bits(0, 1, 5, 6, 7, 8, 11, 12, 13) && M.get('sa') === bits(9) && M.get('x1') === bits(3) && !M.has('old'),
  `Dienste als Bitmaske ab Vortag: Wochenplan, Zusatztag, entfallene Tage (wk ${M.get('wk')?.toString(2)}, sa ${M.get('sa')?.toString(2)})`);

// Fahrten und Halte (stop_times unsortiert); a und a2 gehören zur Station 0, zz zu keiner Station
const routes = { r1: ['5', 3], r2: ['RB63', 2], r3: ['', null] };
const trips = 'route_id,service_id,trip_id,trip_headsign\nr1,wk,A1,Neckarbrücke\nr1,wk,A2,Neckarbrücke\nr1,wk,A3,Neckarbrücke\nr2,wk,B1,Stuttgart Hbf\nr1,sa,S1,\nr1,wk,Z1,\nr3,wk,N1,\nr1,old,O1,\nr9,wk,U1,\n';
const st = 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\n' + [
  'A1,11:12:00,11:12:00,c,4', 'A1,11:00:00,11:00:00,a,1', 'A1,11:01:00,11:01:00,a2,2', 'A1,11:05:00,11:05:00,b,3',
  'A2,11:20:00,11:20:00,a,1', 'A2,11:21:00,11:21:00,a2,2', 'A2,11:25:00,11:25:00,b,3', 'A2,11:32:00,11:32:00,c,4', 'A2,11:33:00,11:33:00,zz,5',
  'A3,10:30:00,10:30:00,a,1', 'A3,10:35:00,10:35:00,b,2', 'A3,10:42:00,10:42:00,c,3',
  'B1,11:00:00,11:00:00,b,1', 'B1,11:40:00,11:40:00,d,2', 'S1,11:00:00,11:00:00,a,1', 'S1,11:30:00,11:30:00,c,2', 'Z1,11:00:00,11:00:00,a,1', 'Z1,11:02:00,11:02:00,a2,2',
  'N1,11:00:00,11:00:00,a,1', 'N1,11:10:00,11:10:00,b,2', 'U1,11:00:00,11:00:00,a,1', 'U1,11:10:00,11:10:00,b,2'].join('\n') + '\n';
const stLookup = new Map([['a', 0], ['a2', 0], ['b', 1], ['c', 2], ['d', 3]]);
const tr = PL.planTrips(trips, routes, M);
assert(tr.idOf.size === 6 && !tr.idOf.has('N1') && !tr.idOf.has('O1') && !tr.idOf.has('U1') && tr.routes.length === 3, `Fahrten mit Linie und aktivem Dienst (${[...tr.idOf.keys()].join()})`);
const sc = PL.stopTimesCollector(tr, stLookup); for (const l of st.split('\n')) sc.add(l);
const g = sc.finish(), P = PL.buildPlan(tr, g, { day0: '2026-11-19', builtAt: 1, feed: 'x' });
assert(g.rows === 22 && g.used === 17 && P.trips === 5 && P.patterns === 4, `Halte an Stationen, Fahrten mit zwei Stationen, Muster geteilt (${g.used}/${g.rows}, ${P.trips} Fahrten, ${P.patterns} Muster)`);
const V0 = PL.planView(P), iA1 = V0.find('A1'), iA2 = V0.find('A2');
assert(iA1 >= 0 && iA2 >= 0 && V0.find('Z1') < 0 && V0.find('nix') < 0 && P.tPat[iA1] === P.tPat[iA2] && [...V0.stops(iA1).q].join() === '0,1,2' && [...V0.stops(iA1).dt].join() === '60,300,720' && P.tStart[iA1] === 39600,
  `Muster: gleiche Station hintereinander einmal (Abfahrt), Sekunden ab Fahrtbeginn (${[...V0.stops(iA1).dt]})`);
const P2 = PL.unpackPlan(PL.packPlan(P));
assert(P2.trips === P.trips && P2.day0 === '2026-11-19' && P2.feed === 'x' && [...P2.tH1].join() === [...P.tH1].join() && [...P2.pDt].join() === [...P.pDt].join() && [...P2.svc].join() === [...P.svc].join() && P2.routes[1][0] === 'RB63',
  'Tabelle als Bytes und zurück');
let threw = false; try { PL.unpackPlan(Buffer.from('XXXX00000000')); } catch { threw = true; }
assert(threw, 'fremde Bytes: Fehler');
const now = Date.parse('2026-11-20T10:10:00Z'), V = PL.planView(P2); // 11:10 Uhr Ortszeit
assert(V.runs(V.find('A1'), '2026-11-20') && !V.runs(V.find('A1'), '2026-11-21') && !V.runs(V.find('S1'), '2026-11-20') && V.days(now).join() === '2026-11-19,2026-11-20,2026-11-21', 'Betriebstage der Fahrt');
assert(!PL.planStale({ v: 1, day0: '2026-11-19', days: 14 }, now) && PL.planStale({ v: 1, day0: '2026-11-08', days: 14 }, now) && PL.planStale({ v: 1, day0: '2026-11-20', days: 14 }, now) && PL.planStale(null, now), 'Tabelle fällig: fehlt, deckt gestern oder die nächsten Tage nicht');

// Zusammenführen: der Strom meldet von A1 nur den letzten Halt (3 Min. verspätet) → ganzer Weg, Verspätung nach vorn übernommen
const t = (hm) => Date.parse(`2026-11-20T${hm}:00+01:00`);
const m = PL.mergeTrip(V, 'A1', [{ q: 2, t: t('11:15'), d: 180 }], [], null, now);
assert(m && m.day === '2026-11-20' && m.pts.map(p => p.q).join() === '0,1,2' && m.pts.map(p => (p.t - t('11:00')) / 60e3).join() === '4,8,15' && m.pts.every(p => p.d === 180), `Weg aus dem Fahrplan, Zeiten mit Verspätung (${m?.pts.map(p => (p.t - t('11:00')) / 60e3)})`);
const m2 = PL.mergeTrip(V, 'A1', [{ q: 0, t: t('11:02'), d: null }, { q: 2, t: t('11:16'), d: null }], [1], '2026-11-20', now);
assert(m2 && m2.pts.map(p => p.q).join() === '0,2' && m2.sk.map(x => `${x.q}:${x.k}`).join() === '1:1' && m2.pts[0].d === 60 && m2.pts[1].d === 240, 'ausgefallene Station fehlt im Weg, Verspätung aus Plan und Meldung');
assert(PL.mergeTrip(V, 'A1', [{ q: 2, t: t('13:30'), d: null }], [], null, now) === null && PL.mergeTrip(V, 'nix', [{ q: 2, t: t('11:15'), d: 0 }], [], null, now) === null, 'über eine Stunde daneben oder unbekannte Fahrt: kein Zusammenführen');

// Wege eines Laufs: A1 im Strom (nur ein Halt), B1 abgesagt, A2 ohne Echtzeit; Q9 (andere trip_id) an Station 0 um 11:21 mit Linie 5
const ix = { ags: ['08416041', '08111000'], routes, st: { id: ['s0', 's1', 's2', 's3'], name: ['Hbf', 'Uni', 'Neckarbrücke', 'Stuttgart Hbf'], lat: [48.515, 48.52, 48.522, 48.78], lon: [9.05, 9.06, 9.057, 9.18], a: [0, 0, 0, 1] } };
const run = (withQ9, plan = V) => {
  const pc = NZ.pathCollector(stLookup, ix, now, { plan });
  pc.onTrip('A1', 'r1', false, [{ stop: 'c', tt: t('11:15'), delay: 180, sr: 0 }], null);
  pc.onTrip('B1', 'r2', false, [{ stop: 'b', tt: null, delay: null, sr: 1 }, { stop: 'd', tt: null, delay: null, sr: 1 }], '2026-11-20');
  if (withQ9) pc.onTrip('Q9', 'r1', false, [{ stop: 'a', tt: t('11:21'), delay: 0, sr: 0 }, { stop: 'b', tt: t('11:25'), delay: 0, sr: 0 }], null);
  pc.planPass(); return pc.result();
};
const R = run(false), tue = R.by.get('08416041') || [], live = NZ.liveRows(tue, ix);
const rt = tue.find(r => r[7] === 'echtzeit'), pl = tue.filter(r => r[7] === 'fahrplan');
assert(rt && rt[0] === '5' && rt[2] === 180 && rt[3].length === 6 && rt[6].join() === '1,2' && R.merged === 1 && R.trips === 1, `Fahrt im Strom mit Weg aus dem Fahrplan (Quelle echtzeit, ${rt?.[6]})`);
assert(pl.length === 1 && pl[0][0] === '5' && pl[0][2] === null && pl[0][5] === 'Neckarbrücke' && pl[0][3][2] === 660 && R.planTrips === 1 && !(R.by.get('08111000') || []).length, `ohne Echtzeit nach Fahrplan (A2), abgesagte B1 nicht (${pl.map(r => r[0])})`);
assert(live.trips.every(r => r.length === 8) && live.trips.some(r => r[7] === 'fahrplan') && NZ.LIVE_FIELDS.at(-1) === 'quelle', 'Live-Datei: Quelle als achtes Feld');
const R2 = run(true);
assert(R2.planTrips === 0 && R2.planDup === 1 && (R2.by.get('08416041') || []).filter(r => r[7] === 'echtzeit').length === 2, `andere trip_id, gleiche Linie, Station und Minute: nicht doppelt (${R2.planDup})`);
const R3 = run(false, null);
assert(R3.trips === 0 && R3.planTrips === 0 && !(R3.by.get('08416041') || []).length, 'ohne Fahrplan wie bisher: ein gemeldeter Halt ergibt keinen Weg');

console.log(`\n${ok} ok, ${bad} Fehler`);
if (bad) process.exit(1);
