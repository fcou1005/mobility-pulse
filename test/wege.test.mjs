// Streckenverläufe für die Live-Karte (17.11.2026): lib/pulse-geo-wege.js (Geo-Lauf) und lib/pulse-oepnv-wege.js (Browser) mit kleinen Netzen
import * as W from '../lib/pulse-geo-wege.js';
import * as K from '../lib/pulse-oepnv-wege.js';
import { distM } from '../lib/pulse-geo-proj.js';
const assert = (c, m) => { if (!c) { console.error('FEHLER:', m); process.exitCode = 1; } else console.log('ok:', m); };

// ---------- Polyline, Schlüssel, Nachschlagen ----------
{
  const pts = [[48.78300, 9.17981], [48.78412, 9.18001], [48.77052, 9.15787], [-0.00001, 179.99999]];
  const enc = K.encodePolyline(pts), dec = K.decodePolyline(enc);
  assert(K.encodePolyline([[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]) === '_p~iF~ps|U_ulLnnqC_mqNvxq`@' && dec.length === 4 && dec.every((p, i) => Math.abs(p[0] - pts[i][0]) < 1e-9 && Math.abs(p[1] - pts[i][1]) < 1e-9),
    `Polyline wie Google (Referenzbeispiel), hin und zurück verlustfrei (${enc.length} Zeichen)`);
  assert(K.segKey('r', 48.783, 9.17981, 48.77052, 9.15787) === 'r:48.783,9.17981|48.77052,9.15787' && K.netOf('bus') === 's' && K.netOf('sbahn') === 'r' && K.netOf('tram') === 'r' && K.netOf('sonst') === null, 'Schlüssel wie die Fahrzeugwege, Netz je Verkehrsmittel');
  const doc = { segs: { [K.segKey('r', 1, 1, 2, 2)]: K.encodePolyline([[1, 1], [1.5, 1.2], [2, 2]]), [K.segKey('s', 3, 3, 4, 4)]: K.encodePolyline([[3, 3], [3.2, 3.9], [4, 4]]) } };
  const lk = K.wegeLookup(doc), f = lk.get('ubahn', 1, 1, 2, 2), r = lk.get('ubahn', 2, 2, 1, 1), s = lk.get('sonst', 3, 3, 4, 4), no = lk.get('bus', 1, 1, 2, 2);
  assert(lk.size === 2 && f.length === 3 && r[0].join() === '2,2' && r[2].join() === '1,1' && s?.length === 3 && no === null && lk.stats().hit === 3 && lk.stats().miss === 1,
    'Nachschlagen: Richtung, Gegenrichtung umgedreht, „sonst“ sucht in beiden Netzen, Bus nicht auf Gleisen');
}
// ---------- Lücken überbrücken (ausgelassene Halte, 18.11.2026) ----------
{
  const A = [48.0, 9.0], B = [48.0, 9.01], C = [48.0005, 9.0105], D = [48.01, 9.02], E = [48.2, 9.5];
  const key = (n, p, q) => K.segKey(n, p[0], p[1], q[0], q[1]);
  const doc = { segs: { [key('r', A, B)]: K.encodePolyline([A, [48.001, 9.005], B]), [key('r', C, B)]: K.encodePolyline([C, B]), [key('r', C, D)]: K.encodePolyline([C, D]), [key('s', A, E)]: K.encodePolyline([A, E]) } };
  const lk = K.wegeLookup(doc), get = (art, p, q) => lk.get(art, p[0], p[1], q[0], q[1]);
  const ac = get('sbahn', A, C), ad = get('sbahn', A, D), da = get('sbahn', D, A), far = get('sbahn', A, E), none = get('bus', B, D);
  assert(ac && ac.length === 4 && ac[1][0] === 48.001 && ac.at(-1).join() === C.join() && ad && ad.length === 5 && da && da[0].join() === D.join() && da.at(-1).join() === A.join() && !far && !none,
    'ausgelassener Halt: A → C über B zusammengesetzt (kurzes Glied gerade), auch rückwärts; ohne Netz der Art oder zu großer Umweg kein Verlauf');
  // Schiene über viele Stationen (Straßenbahn nur mit erstem und letztem Halt gemeldet), Straße höchstens CHAIN.maxHops
  const line = Array.from({ length: 21 }, (_, i) => [48.1, 9 + i * 0.004]), segs2 = {}; for (let i = 1; i < line.length; i++) { segs2[key('r', line[i - 1], line[i])] = K.encodePolyline([line[i - 1], line[i]]); segs2[key('s', line[i - 1], line[i])] = K.encodePolyline([line[i - 1], line[i]]); }
  const lk2 = K.wegeLookup({ segs: segs2 }), tram = lk2.get('tram', ...line[0], ...line[20]), bus = lk2.get('bus', ...line[0], ...line[20]);
  assert(tram && tram.length === 21 && tram.at(-1).join() === line[20].join() && !bus && K.CHAIN.maxHopsRail >= 20, `Schiene über 20 Stationen zusammengesetzt, Straße nicht (${tram?.length})`);
  const W = await import('../lib/pulse-geo-wege.js'), out = W.routePairs([{ net: 'r', a: [48.0, 9.0], b: [48.0003, 9.0003] }], () => null);
  assert(out.stats.short === 1 && K.decodePolyline(out.segs[K.segKey('r', 48.0, 9.0, 48.0003, 9.0003)]).length === 2, 'Verbindung unter 100 m wird gerade abgelegt (Glied für das Überbrücken)');
}
// ---------- Lage entlang des Verlaufs ----------
{
  const w = [48.0, 9.0, 0, 48.0, 9.02, 600, 48.01, 9.02, 900]; // Station A, B (10 min), C (5 min)
  const bend = [[48.0, 9.0], [48.005, 9.0], [48.005, 9.02], [48.0, 9.02]], cum = K.cumLen(bend);
  const geom = (i) => (i === 1 ? { pts: bend, cum } : null);
  const half = K.positionAlong(w, 300, geom), q = K.positionAlong(w, 750, geom), path = K.pathPoints(w, geom);
  assert(Math.abs(half[0] - 48.005) < 1e-6 && Math.abs(half[1] - 9.01) < 1e-4 && Math.abs(q[0] - 48.005) < 1e-9 && Math.abs(q[1] - 9.02) < 1e-9 && path.length === 5 && K.positionAlong(w, 2000, geom) === null,
    `Fahrzeug fährt den Bogen statt der Luftlinie (Mitte ${half.map(x => x.toFixed(4))}), ohne Verlauf Luftlinie; Weg mit allen Punkten`);
  const s1 = K.positionAlong(w, 650, geom, 120, true), s2 = K.positionAlong(w, 850, geom, 120, true), s3 = K.positionAlong(w, 300, geom, 120, true);
  assert(s1.join() === '48,9.02' && s2.join() === '48.01,9.02' && Math.abs(s3[0] - 48.005) < 1e-6, 'Live-Karte ohne Verlauf: Fahrzeug an der näheren Station, mit Verlauf weiter auf dem Bogen');
}
// ---------- Netz, Einbahn, Router ----------
{
  // Straßenleiter: Hauptstraße 0–1–2–3 (Einbahn ostwärts), Umgehung 0–4–5–3 beidseitig; Bus darf im Abschnitt 1–2 auch zurück (oneway:bus=no)
  const N = (id, lat, lon) => ({ type: 'node', id, lat, lon });
  const el = [N(1, 48.0, 9.0), N(2, 48.0, 9.005), N(3, 48.0, 9.010), N(4, 48.0, 9.015), N(5, 48.003, 9.0), N(6, 48.003, 9.015),
    { type: 'way', id: 10, nodes: [1, 2], tags: { highway: 'primary', oneway: 'yes' } }, { type: 'way', id: 11, nodes: [2, 3], tags: { highway: 'primary', oneway: 'yes', 'oneway:bus': 'no' } },
    { type: 'way', id: 12, nodes: [3, 4], tags: { highway: 'primary', oneway: 'yes' } }, { type: 'way', id: 13, nodes: [1, 5, 6, 4], tags: { highway: 'secondary' } }, N(1, 48.0, 9.0)];
  assert(W.onewayOf({ oneway: 'yes' }) === 1 && W.onewayOf({ oneway: '-1' }) === -1 && W.onewayOf({ junction: 'roundabout' }) === 1 && W.onewayOf({ oneway: 'yes', 'oneway:psv': 'no' }) === 0 && W.onewayOf({ highway: 'motorway' }) === 1 && W.onewayOf(undefined) === 0,
    'Einbahn: oneway, Kreisverkehr, Autobahn; Busse frei bei oneway:bus/psv = no');
  const g = W.buildNet(el, { directed: true }), r = W.makeRouter(g, { ...W.WEGE_GEO, penalty: 2 });
  assert(g.n === 6 && g.off[g.n] === 1 + 2 + 1 + 6 && g.adj.length === 10, `Gerichteter Graph: ${g.n} Knoten (doppelter Knoten einmal), ${g.off[g.n]} Kanten`);
  const A = [48.0, 9.0], D = [48.0, 9.015], ab = r.route(A, [{ key: 'ab', b: D }], 50).get('ab'), ba = r.route(D, [{ key: 'ba', b: A }], 50).get('ba');
  assert(ab.pts.length === 4 && ab.pts[1][1] === 9.005 && Math.abs(ab.len - distM(48, 9, 48, 9.015)) < 1 && ba.pts.length === 4 && ba.pts[1][0] === 48.003, `Ostwärts über die Hauptstraße (${Math.round(ab.len)} m), westwärts über die Umgehung (${Math.round(ba.len)} m)`);
  // Straßenart: Bus nimmt die etwas längere Hauptstraße statt der Wohnstraße, bei großem Umweg aber die Wohnstraße
  const mk = (dLat) => [N(1, 48.0, 9.0), N(2, 48.0, 9.01), N(3, 48 + dLat, 9.005), { type: 'way', id: 1, nodes: [1, 2], tags: { highway: 'residential' } }, { type: 'way', id: 2, nodes: [1, 3, 2], tags: { highway: 'primary' } }];
  const via = (dLat) => W.makeRouter(W.buildNet(mk(dLat), { directed: true })).route([48, 9], [{ key: 'k', b: [48, 9.01] }], 30).get('k');
  const near = via(0.002), far = via(0.006);
  assert(W.costOf({ highway: 'residential' }) === 1.4 && W.costOf({ highway: 'service', bus: 'designated' }) === 0.8 && W.costOf({ highway: 'primary', 'bus:lanes': 'designated|' }) === 0.9 && W.costOf({ highway: 'track' }) === 1.5 && W.costOf(undefined) === 1
    && near?.pts.length === 3 && far?.pts.length === 2 && Math.round(near.len) > Math.round(far.len), `Straßenart: Hauptstraße bei ${Math.round(near?.len)} m statt 745 m Wohnstraße, bei ${Math.round(distM(48, 9, 48.006, 9.005) * 2)} m Umweg die Wohnstraße`);
  // Bahnhof mit zwei Gleisen: die Station liegt zwischen ihnen; Mehrfachstart wählt das Gleis, das zum Ziel führt
  const R = [N(1, 50.0, 8.0), N(2, 50.0, 8.02), N(3, 50.0006, 8.0), N(4, 50.0006, 8.0), N(5, 50.01, 8.03), { type: 'way', id: 1, nodes: [1, 2] }, { type: 'way', id: 2, nodes: [3, 5] }];
  const gr = W.buildNet(R), rr = W.makeRouter(gr), st = [50.0003, 8.0], hit = rr.route(st, [{ key: 'x', b: [50.01, 8.03] }, { key: 'y', b: [50.0, 8.02] }], 300);
  assert(hit.get('x')?.pts[0][0] === 50.0006 && hit.get('y')?.pts[0][0] === 50.0 && rr.route([10, 10], [{ key: 'z', b: [50, 8] }], 300).size === 0, 'Bahnhof: je Ziel das passende Gleis; ohne Netz in der Nähe kein Weg');
}
// ---------- Verbindungen aus dem Fahrplan und Routen einer Stadt ----------
{
  const trips = new Map([['t1', 'r'], ['t2', 's']]), st = new Map([['a1', 0], ['a2', 0], ['b', 1], ['c', 2], ['x', 3]]);
  const pc = W.pairCollector(trips, st);
  for (const [t, s, q] of [['t1', 3, 'c'], ['t2', 1, 'b'], ['t1', 1, 'a1'], ['t9', 1, 'a1'], ['t1', 2, 'a2'], ['t1', 4, 'zz'], ['t1', 5, 'b'], ['t2', 2, 'x'], ['t1', 6, 'b']]) pc.add(String(t), Number(s), String(q));
  const res = pc.result();
  assert([...res.pairs].map(([k, n]) => `${k}:${n}`).sort().join() === 'r|0|2:1,r|2|1:1,s|1|3:1' && res.rows === 9 && res.used === 7 && res.trips === 2,
    `Verbindungen: unsortierte stop_times nach Fahrt und Halt geordnet, gleiche Station zusammen, Halte ohne Station übersprungen (${[...res.pairs.keys()].join(' ')})`);
  assert(W.netOfRoute(3, '42') === 's' && W.netOfRoute(109, 'S1') === 'r' && W.netOfRoute(900, '1') === 'r' && W.netOfRoute(4, 'Fähre') === null, 'Netz je Linie: Bus Straße, Bahnen Schiene, Fähre keins');
  const N = (id, lat, lon) => ({ type: 'node', id, lat, lon }), el = [N(1, 48.0, 9.0), N(2, 48.004, 9.006), N(3, 48.0, 9.012), N(4, 48.0, 9.040), { type: 'way', id: 1, nodes: [1, 2, 3] }];
  const rt = W.makeRouter(W.buildNet(el));
  const out = W.routePairs([{ net: 'r', a: [48.0, 9.0], b: [48.0, 9.012] }, { net: 'r', a: [48.0, 9.0], b: [48.0, 9.0005] }, { net: 'r', a: [48.0, 9.012], b: [48.0, 9.04] }, { net: 's', a: [48, 9], b: [48, 9.012] }], (n) => (n === 'r' ? rt : null));
  const line = K.decodePolyline(out.segs[K.segKey('r', 48, 9, 48, 9.012)]);
  assert(out.stats.routed === 1 && out.stats.short === 1 && out.stats.noPath === 1 && out.stats.noNet === 1 && line.length === 3 && line[1][0] === 48.004,
    `Stadt: Bogen über den Mittelknoten, zu kurz und ohne Netz bleiben Luftlinie (${JSON.stringify(out.stats)})`);
  const tl = W.railTiles([48.6, 8.9, 48.95, 9.4]);
  assert(tl.length === 2 && tl[0].key === '97:11' && tl[1].bb.join() === '48.5,9,49,9.75', `Gleisnetz in Kacheln (${tl.map(x => x.key).join(', ')})`);
  const zig = [[48, 9], [48.00001, 9.001], [48, 9.002], [48.002, 9.003]], sz = W.simplify(zig, 4);
  assert(sz.length === 3 && sz[1].join() === '48,9.002', 'Vereinfachen: Zacken unter 4 m fallen weg, Ecken bleiben');
}
