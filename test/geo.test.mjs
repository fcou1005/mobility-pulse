// Sprint 8 (Geo): Projektion, Zensus, Versorgung, Unfallatlas, GTFS, Umwegfaktor, Abstellflächen-Planer und der Geo-Lauf mit Ersatz-Servern
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import * as P from '../lib/pulse-geo-proj.js';
import * as Z from '../lib/pulse-geo-pop.js';
import * as C from '../lib/pulse-geo-cover.js';
import * as U from '../lib/pulse-geo-unfall.js';
import * as G from '../lib/pulse-geo-gtfs.js';
import * as N from '../lib/pulse-geo-net.js';
import * as PL from '../lib/pulse-geo-plan.js';
import { cellOf } from '../lib/pulse-track-rules.js';
const assert = (c, m) => { if (!c) { console.error('FEHLER:', m); process.exitCode = 1; } else console.log('ok:', m); };
const near = (a, b, e) => Math.abs(a - b) <= e;
let seed = 11; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

// ---------- Projektion ----------
{
  const [x, y] = P.toLaea(50, 5);
  assert(near(x, 3962799.45, 0.01) && near(y, 2999718.85, 0.01), 'LAEA: Beispiel der EPSG-Anleitung (50° N, 5° O → 3962799,45 / 2999718,85)');
  let worst = 0; for (let i = 0; i < 200; i++) { const la = 47 + rnd() * 8, lo = 6 + rnd() * 9, [a, b] = P.fromLaea(...P.toLaea(la, lo)); worst = Math.max(worst, Math.abs(a - la), Math.abs(b - lo)); }
  assert(worst < 1e-7, `LAEA: hin und zurück auf < 1 cm genau (${worst.toExponential(1)}°)`);
  const s = P.splitToCells(48.77612, 9.18011, ...P.half100(48.77612));
  assert(near(s.reduce((a, b) => a + b[1], 0), 1, 1e-9) && s.length >= 1 && s.length <= 4, `Zensuszelle auf ${s.length} Veröffentlichungszellen verteilt, Summe 1`);
  const ix = P.pointIndex([[48.7, 9.1], [48.701, 9.1]]); assert(near(ix.nearestWithin(48.7005, 9.1, 100), 55.66, 0.5) && ix.nearestWithin(48.75, 9.1, 300) === Infinity && ix.within(48.7, 9.1, 120).length === 2, 'Nachbarsuche im Raster');
}
// ---------- Zensus ----------
const square = (ags, s, w, n, e, pop) => ({ type: 'Feature', properties: { ags, name: `G${ags}`, pop }, geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] } });
const FEAT = [square('08111000', 48.70, 9.10, 48.80, 9.25, 10000), square('08416041', 48.50, 9.00, 48.55, 9.10, 2000)];
function censusCsv() {
  const lines = ['GITTER_ID_100m;x_mp_100m;y_mp_100m;Einwohner'];
  for (let i = 0; i < 400; i++) { const la = 48.71 + rnd() * 0.08, lo = 9.11 + rnd() * 0.13, [x, y] = P.toLaea(la, lo); lines.push(`CRS3035RES100mN${Math.round(y)}E${Math.round(x)};${Math.round(x / 100) * 100 + 50};${Math.round(y / 100) * 100 + 50};25`); }
  for (let i = 0; i < 80; i++) { const la = 48.505 + rnd() * 0.04, lo = 9.01 + rnd() * 0.08, [x, y] = P.toLaea(la, lo); lines.push(`id;${Math.round(x / 100) * 100 + 50};${Math.round(y / 100) * 100 + 50};26`); }
  lines.push('id;4300050;2900050;–'); lines.push('id;4200050;2700050;3'); // geheim, außerhalb aktiver Gemeinden
  return lines.join('\n') + '\n';
}
{
  const lines = censusCsv().trim().split('\n'), ix = Z.censusHeader(lines[0]), loc = Z.muniLocator(FEAT), acc = Z.popAccumulator(loc);
  for (const l of lines.slice(1)) { const r = Z.censusRow(l, ix); if (r) acc.add(r); }
  const res = acc.result(), st = res.by.get('08111000');
  assert(res.rows === 481 && st.ew === 10000 && res.by.get('08416041').ew === 2080 && near([...st.cells.values()].reduce((a, b) => a + b, 0), 10000, 1e-6), 'Zensus: Zeilen gelesen, geheime übersprungen, je Gemeinde summiert, 250-m-Zellen flächengleich');
  const pk = Z.packAgs(st), back = Z.unpackPts(pk.pts);
  assert(back.length === 400 && near(back.reduce((a, p) => a + p[2], 0), 10000, 0) && pk.cells.length > 50, 'Zensus: Δ-kodiert und zurück');
  const sum = Z.popSummary(res.by, FEAT);
  assert(sum.n === 2 && sum.within === 1 && near(sum.rows.find(r => r.ags === '08416041').dev, 0.04, 1e-9), 'Abgleich VG250-EW: Stuttgart 0 %, Tübingen +4 % (außerhalb ±3 %)');
}
// ---------- Versorgung ----------
{
  const pts = []; for (let i = 0; i < 30; i++) for (let j = 0; j < 30; j++) pts.push([48.75 + i * 0.0009, 9.15 + j * 0.00137, 10]);
  const prep = C.prepareAgs(pts, cellOf), acc = C.emptyAcc(prep, '2026-11-14');
  const veh = []; for (let k = 0; k < 40; k++) veh.push([48.75 + rnd() * 0.027, 9.15 + rnd() * 0.041]);
  for (let run = 0; run < 45; run++) { const v = veh.map(([a, b]) => [a + (rnd() - 0.5) * 0.002, b + (rnd() - 0.5) * 0.003]); C.coverRun(prep, acc, v, { hour: 7 + Math.floor(run / 3), runIdx: run }); }
  const d = C.finalizeDay(prep, acc);
  assert(d.share[0] > 0.2 && d.share[0] < d.share[1] && d.share[1] < d.share[2] && d.share[2] <= 1, `Versorgung: Einwohneranteil 150/200/300 m ${d.share.map(x => (x * 100).toFixed(1)).join(' / ')} %`);
  assert(d.runsDay === 45 && d.runsDay3 === 15 && d.diffPP != null && d.diffPP < 5, `jeder dritte Lauf: Abweichung ${d.diffPP.toFixed(2)} Punkte`);
  assert(d.gini != null && d.gini > 0 && d.gini < 1 && d.cells.length === prep.cells.length, `Gini auf 1 km ${d.gini.toFixed(3)}, Zellwerte je 250-m-Zelle`);
  assert(near(C.gini([1, 1, 1, 1], [5, 5, 5, 5]), 0, 1e-12) && C.gini([1, 1, 1, 1], [0, 0, 0, 20]) > 0.7, 'Gini: gleich verteilt 0, alles in einer Zelle nahe 1');
  const j = JSON.parse(JSON.stringify(C.accToJson(acc))), back = C.accFromJson(j, prep);
  assert(back && back.pt[1][17] === acc.pt[1][17] && back.k1veh.length === acc.k1veh.length && C.accFromJson(j, C.prepareAgs(pts.slice(1), cellOf)) === null, 'Zähler privat gespeichert und geladen; anderer Zensus → neu');
  const mo = C.missingOperators([{ ags: '08111000', anbieter: ['Bolt', 'Lime', 'Dott (TIER)', 'Voi'], anbieterZahl: 5 }], '08111000', new Set(['Bolt', 'Dott', 'Lime']));
  assert(mo.missing.length === 1 && mo.missing[0] === 'Voi' && mo.countGap === 2, 'Anbieter mit Genehmigung ohne offenen Feed markiert (Voi, 2 von 5 fehlen)');
}
// ---------- Unfallatlas ----------
function unfallCsv(y) {
  const l = ['OBJECTID;UIDENTSTLAE;ULAND;UREGBEZ;UKREIS;UGEMEINDE;UJAHR;UMONAT;USTUNDE;UWOCHENTAG;UKATEGORIE;UART;UTYP1;ULICHTVERH;IstRad;IstPKW;IstFuss;IstKrad;IstGkfz;IstSonstige;LINREFX;LINREFY;XGCSWGS84;YGCSWGS84;STRZUSTAND'];
  const row = (la, lo, kat, rad) => `1;x;8;1;11;0;${y};5;12;3;${kat};5;1;0;${rad};1;0;0;0;0;1;2;${lo.toFixed(6).replace('.', ',')};${la.toFixed(6).replace('.', ',')};0`;
  for (let i = 0; i < 25; i++) l.push(row(48.7750 + (rnd() - 0.5) * 0.0015, 9.1800 + (rnd() - 0.5) * 0.002, i < 3 ? 2 : 3, i % 2)); // Schwerpunkt
  for (let i = 0; i < 40; i++) l.push(row(48.705 + rnd() * 0.09, 9.105 + rnd() * 0.14, 3, 0));
  return l.join('\r\n') + '\r\n';
}
{
  const lines = unfallCsv(2023).trim().split(/\r?\n/), ix = U.unfallHeader(lines[0]), r = U.unfallRow(lines[1], ix);
  assert(r && r.ags === '08111000' && r.year === 2023 && near(r.lat, 48.775, 0.001) && r.cats.includes('alle') && r.cats.includes('schwer'), 'Unfallatlas: Zeile mit Dezimalkomma, AGS aus Land/RB/Kreis/Gemeinde, Kategorien');
  const acc = U.unfallAccumulator(new Set(['08111000'])); for (const y of [2018, 2019, 2023, 2024]) { const ls = unfallCsv(y).trim().split(/\r?\n/), h = U.unfallHeader(ls[0]); for (const l of ls.slice(1)) acc.add(U.unfallRow(l, h)); }
  const a = acc.result().get('08111000'), universe = []; for (let i = Math.round(48.70 / 0.0025); i <= Math.round(48.80 / 0.0025); i++) for (let j = Math.round(9.10 / 0.0035); j <= Math.round(9.25 / 0.0035); j++) universe.push(`${i}:${j}`);
  const res = U.analyseAgs(universe, a, [2018, 2019, 2023, 2024]);
  assert(res.cellSum === res.srcSum && res.srcSum === 4 * 65, `Summen je Gemeinde = Quelle (${res.srcSum})`);
  assert(res.hot >= 1 && res.overlap === 1 && res.cells[0][res.cells[0].length - 1] === 1, `Schwerpunkt erkannt (${res.hot} Zellen), in beiden Zeithälften (Überlappung ${res.overlap})`);
  assert(near(U.normSf(1.6449), 0.05, 1e-4) && U.fdr([0.001, 0.02, 0.04, 0.5], 0.05).size === 2, 'Normalverteilung und Benjamini-Hochberg');
  const eb = U.ebRates(new Map([['a', 10], ['b', 0], ['c', 1], ['d', 0]]), 5); assert(eb.get('a') < 2 && eb.get('b') > 0, 'Empirical Bayes zieht Ausreißer zur Mitte');
}
// ---------- GTFS ----------
{
  const cal = ['service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date', 'wk,1,1,1,1,1,0,0,20261101,20261231', 'we,0,0,0,0,0,1,1,20261101,20261231'];
  const dates = ['service_id,date,exception_type', 'we,20261117,1', 'wk,20261117,2'];
  const on = G.activeServices(cal, dates, '20261117');
  assert(on.has('we') && !on.has('wk') && G.nextTuesday(Date.parse('2026-11-14T12:00:00Z')) === '20261117', 'GTFS: Dienste am Stichtag mit Ausnahmen, nächster Dienstag');
  const cnt = G.departureCounter(new Set(['t1', 't2'])); for (const l of ['trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type', 't1,08:00:00,08:00:00,A1,1,0', 't1,08:05:00,08:05:00,A2,2,1', 't2,09:00:00,09:00:00,A1,1,0', 't3,09:00:00,09:00:00,A1,1,0']) cnt.add(l);
  const { dep } = cnt.result(); assert(dep.get('A1') === 2 && !dep.has('A2'), 'Abfahrten je Steig (nur aktive Fahrten, kein Nur-Ausstieg)');
  const b = G.bundleStops([{ id: 'A1', name: 'Rathaus', lat: 48.7758, lon: 9.1829, parent: 'P' }, { id: 'A3', name: 'Rathaus', lat: 48.7759, lon: 9.1831, parent: 'P' }, { id: 'B', name: 'Markt', lat: 48.78, lon: 9.19, parent: null }, { id: 'B2', name: 'Markt', lat: 48.7801, lon: 9.1901, parent: null }], new Map([['A1', 10], ['A3', 4], ['B', 3], ['B2', 2]]));
  assert(b.length === 2 && b.find(x => x.name === 'Rathaus').dep === 14 && b.find(x => x.name === 'Markt').n === 2, 'Bündel: Elternstation bzw. gleicher Name in 150 m');
  const f = G.feederIndex(b); assert(f.dep === 19 && f.near(48.7765, 9.1829) && !f.near(48.79, 9.19) && near(G.indexValue(38, 19), 200, 1e-9), 'Zubringer: Punkt in 150 m, Index je 100 Abfahrten');
}
{ const h = 'ULAND;UREGBEZ;UKREIS;UGEMEINDE;UJAHR;UKATEGORIE;IstRad;XGCSWGS84;YGCSWGS84', ix = U.unfallHeader(h), r = U.unfallRow('11;0;03;000;2024;3;1;13,41;52,52', ix);
  assert(r?.ags === '11000000' && U.unfallRow('02;0;00;000;2024;3;0;10,0;53,55', ix)?.ags === '02000000', 'Unfallatlas: Berliner Bezirke (Kreis 01–12) zählen zu Berlin 11000000'); }
{ // Grenzzelle zwischen zwei Gemeinden: anteilig, Summe bleibt
  const sq = (ags, a, b, c, d) => ({ type: 'Feature', properties: { ags }, geometry: { type: 'Polygon', coordinates: [[[b, a], [d, a], [d, c], [b, c], [b, a]]] } });
  const acc = Z.popAccumulator(Z.muniLocator([sq('1', 48.0, 9.0, 48.1, 9.1), sq('2', 48.0, 9.1, 48.1, 9.2)])); acc.add({ lat: 48.05, lon: 9.1, ew: 100 }); acc.add({ lat: 48.05, lon: 9.05, ew: 10 });
  const r = acc.result(), e1 = r.by.get('1')?.ew, e2 = r.by.get('2')?.ew;
  assert(r.split === 1 && near(e1 + e2, 110, 1e-9) && near(e1, 60, 1e-9) && near(e2, 50, 1e-9) && r.by.get('2').pts[0][1] > 9.1, `Zensus: Zelle auf der Grenze halb und halb verteilt (${e1} / ${e2})`); }
// ---------- Umwegfaktor ----------
function gridOsm(n, stepDeg) {
  const els = []; let id = 1; const nid = (i, j) => i * 1000 + j + 1;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) els.push({ type: 'node', id: nid(i, j), lat: 48.7 + i * stepDeg, lon: 9.1 + j * stepDeg * 1.5 });
  for (let i = 0; i < n; i++) { els.push({ type: 'way', id: 1e6 + id++, nodes: Array.from({ length: n }, (_, j) => nid(i, j)) }); els.push({ type: 'way', id: 1e6 + id++, nodes: Array.from({ length: n }, (_, j) => nid(j, i)) }); }
  return { elements: els };
}
{
  const g = N.buildGraph(gridOsm(25, 0.0009)), pts = []; for (let i = 0; i < 25; i += 2) for (let j = 0; j < 25; j += 2) pts.push([48.7 + i * 0.0009, 9.1 + j * 0.00135, 5]);
  const r = N.detourFactors(g, pts);
  assert(g.n === 625 && r.n > 50 && r.median > 1.0 && r.median < 1.45, `Raster-Straßennetz: Umwegfaktor Median ${r.median?.toFixed(2)} (Manhattan, Erwartung 1–1,41)`);
  const d = N.netDistance(g, [48.7, 9.1], [48.7, 9.1 + 10 * 0.00135]); assert(d != null && near(d, 10 * 0.00135 * 111320 * Math.cos(48.7 * Math.PI / 180), 2), `Netzentfernung entlang einer Straße = Luftlinie (${d?.toFixed(0)} m)`);
}
// ---------- Abstellflächen-Planer ----------
{
  const osm = { elements: [
    { type: 'way', id: 1, nodes: [1, 2], tags: { highway: 'residential', sidewalk: 'both' }, geometry: [{ lat: 48.7750, lon: 9.1800 }, { lat: 48.7750, lon: 9.1900 }] },
    { type: 'way', id: 2, nodes: [3, 4], tags: { highway: 'residential' }, geometry: [{ lat: 48.7700, lon: 9.1850 }, { lat: 48.7800, lon: 9.1850 }] },
    { type: 'way', id: 3, nodes: [4, 5], tags: { highway: 'pedestrian' }, geometry: [{ lat: 48.7800, lon: 9.1850 }, { lat: 48.7800, lon: 9.1950 }] },
    { type: 'node', id: 9, lat: 48.7750, lon: 9.1820, tags: { highway: 'bus_stop' } },
    { type: 'node', id: 10, lat: 48.7751, lon: 9.1880, tags: { amenity: 'kick-scooter_parking' } } ] };
  const o = PL.parseOsm(osm); o.roads[1].geom.splice(1, 0, [48.7750, 9.1850]); o.roads[1].nodes = [3, 99, 4]; o.roads[0].geom.splice(1, 0, [48.7750, 9.1850]); o.roads[0].nodes = [1, 99, 2];
  const cr = PL.crossings(o.roads), cands = PL.candidatesAlong(o.ways);
  assert(o.ways.length === 2 && o.stops.length === 1 && o.existing.length === 1 && cr.length >= 1 && cands.length > 50, `OSM zerlegt: ${o.ways.length} Wege mit Gehweg, ${cands.length} Kandidaten alle 25 m, ${cr.length} Kreuzung`);
  const demand = [[48.7752, 9.1881, 12], [48.7752, 9.1822, 9], [48.7801, 9.1900, 7], [48.7749, 9.1851, 6]];
  const noPark = (la, lo) => la > 48.7795 && lo > 9.1880; // Verbotszone über der Fußgängerzone
  const pl = PL.planSpots(demand, cands, { k: 3, noPark, stops: o.stops, cross: cr });
  assert(pl.picks.length >= 2 && !pl.picks.some(p => noPark(p.lat, p.lon)) && pl.excluded.noPark > 0 && pl.excluded.stop > 0 && pl.excluded.cross > 0, `kein Vorschlag in Verbotszone, an Haltestelle oder Kreuzung (${JSON.stringify(pl.excluded)})`);
  assert(pl.picks[0].covered === 12 && PL.nearExisting(pl.picks, o.existing, 50) > 0, `größte Nachfrage zuerst, Anteil an vorhandener Fläche ${PL.nearExisting(pl.picks, o.existing, 50)}`);
}
// ---------- Geo-Lauf mit Ersatz-Servern ----------
{
  const T = await mkdtemp(path.join(tmpdir(), 'geo-')), DATA = path.join(T, 'data'), OUT = path.join(T, 'geo'), SRV = path.join(T, 'srv');
  await mkdir(path.join(DATA, 'boundaries'), { recursive: true }); await mkdir(SRV, { recursive: true });
  await writeFile(path.join(DATA, 'boundaries', 'index.json'), JSON.stringify({ states: { BW: { features: 2 } } }));
  await writeFile(path.join(DATA, 'boundaries', 'BW.json'), JSON.stringify({ type: 'FeatureCollection', features: FEAT }));
  await writeFile(path.join(DATA, 'latest.json'), JSON.stringify({ municipalities: { '08111000': { name: 'Stuttgart', operators: { Dott: { types: { scooter: 1000 } } } }, '08416041': { name: 'Tübingen', operators: { nextbike: { types: { bike: 300 } } } } } }));
  await writeFile(path.join(SRV, 'Zensus2022_Bevoelkerungszahl_100m-Gitter.csv'), censusCsv()); execFileSync('zip', ['-qj', path.join(SRV, 'zensus.zip'), path.join(SRV, 'Zensus2022_Bevoelkerungszahl_100m-Gitter.csv')]);
  await writeFile(path.join(SRV, 'Datensatzbeschreibung.txt'), 'Beschreibung\n');
  for (const y of [2016, 2020, 2024]) { const f = `Unfallorte${y}_LinRef.${y === 2016 ? 'txt' : 'csv'}`; await writeFile(path.join(SRV, f), unfallCsv(y)); execFileSync('zip', ['-qj', path.join(SRV, `unfall-${y}.zip`), path.join(SRV, 'Datensatzbeschreibung.txt'), path.join(SRV, f)]); } // 2016 wie die älteren Jahre als .txt
  const gd = path.join(SRV, 'g'); await mkdir(gd);
  await writeFile(path.join(gd, 'calendar.txt'), 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nwk,1,1,1,1,1,0,0,20200101,20301231\n');
  await writeFile(path.join(gd, 'trips.txt'), 'route_id,service_id,trip_id\nr,wk,t1\nr,wk,t2\n');
  await writeFile(path.join(gd, 'stops.txt'), 'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\nA,"Hauptbahnhof, Stuttgart",48.7840,9.1820,0,\nB,Rathaus,48.7758,9.1829,0,\n');
  await writeFile(path.join(gd, 'stop_times.txt'), 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nt1,08:00:00,08:00:00,A,1\nt1,08:05:00,08:05:00,B,2\nt2,09:00:00,09:00:00,A,1\n');
  execFileSync('zip', ['-qj', path.join(SRV, 'gtfs.zip'), ...['calendar.txt', 'trips.txt', 'stops.txt', 'stop_times.txt'].map(f => path.join(gd, f))]);
  const osm = JSON.stringify(gridOsm(60, 0.0018));
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/overpass') { res.setHeader('content-type', 'application/json'); return res.end(osm); }
    if (u.pathname.startsWith('/route/')) { res.setHeader('content-type', 'application/json'); const m = /([\d.]+),([\d.]+);([\d.]+),([\d.]+)/.exec(u.pathname); const d = Math.hypot((+m[4] - +m[2]) * 111320, (+m[3] - +m[1]) * 111320 * Math.cos(48.75 * Math.PI / 180)) * 1.25; return res.end(JSON.stringify({ routes: [{ distance: d }] })); }
    try { const b = await readFile(path.join(SRV, u.pathname.slice(1))); res.end(b); } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(r => server.listen(8795, '127.0.0.1', () => r(null)));
  const env = { ...process.env, GEO_FORCE: '1', GEO_ZENSUS_URL: 'http://127.0.0.1:8795/zensus.zip', GEO_UNFALL_URL: 'http://127.0.0.1:8795/unfall-{y}.zip', GEO_GTFS_URL: 'http://127.0.0.1:8795/gtfs.zip', GEO_OVERPASS: 'http://127.0.0.1:8795/overpass', GEO_ROUTER: 'http://127.0.0.1:8795/route', GEO_UMWEG_CITIES: '1', GEO_PAUSE_MS: '0' };
  const out = await new Promise((res) => { let s = ''; const p = spawn(process.execPath, ['scripts/geo.mjs', DATA, OUT], { env }); p.stdout.on('data', d => { s += d; }); p.stderr.on('data', d => { s += d; }); p.on('close', (c) => res({ c, s })); });
  server.close();
  const files = (await readdir(OUT, { recursive: true })).map(String).sort();
  const pop = JSON.parse(await readFile(path.join(OUT, 'pop', 'index.json'), 'utf8')), un = JSON.parse(await readFile(path.join(OUT, 'unfall', 'index.json'), 'utf8'));
  const gt = JSON.parse(await readFile(path.join(OUT, 'gtfs', 'BW.json'), 'utf8')), um = JSON.parse(await readFile(path.join(OUT, 'umweg', 'index.json'), 'utf8'));
  assert(out.c === 0 && files.includes('pop/BW.json') && files.includes('unfall/08111000.json') && files.includes('index.json'), `Geo-Lauf: ${files.length} Dateien${out.c ? `\n${out.s}` : ''}`);
  assert(pop.n === 2 && pop.within === 1 && pop.ags['08111000'][0] === 10000, 'Geo-Lauf: Zensus je Gemeinde mit Abgleich');
  assert(un.years.length === 3 && un.missingYears.length >= 5 && un.checks.sumsEqual === un.checks.municipalities, `Geo-Lauf: Unfallatlas ${un.years.join(', ')} (fehlende Jahre protokolliert), Summen gleich`);
  assert(gt.ags['08111000']?.length === 2 && gt.ags['08111000'][0][2] === 2 && gt.ags['08111000'][0][3] === 'Hauptbahnhof, Stuttgart', 'Geo-Lauf: Haltestellen mit Abfahrten am Dienstag');
  const st = um.cities['08111000']; assert(st && st.cells > 10 && st.samples.length >= 1 && st.median > 1, `Geo-Lauf: Umwegfaktor Stuttgart Median ${st?.median?.toFixed(2)}, Stichproben ${st?.samples?.map(s => s.dev).join('/')}`);
}
