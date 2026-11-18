// Streckenverläufe aus OSM-Landesextrakten (scripts/geo/wege-osm.mjs, osm-extract.py; 18.11.2026): Länderwahl, Ausschnitt im Overpass-Format,
// Busnetz daraus wie bisher (buildNet). Der Ausschnitt läuft nur, wo python3 mit osmium vorhanden ist (pip install osmium), sonst übersprungen.
import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import * as O from '../scripts/geo/wege-osm.mjs';
import * as W from '../lib/pulse-geo-wege.js';
let ok = 0, bad = 0;
const assert = (c, m) => { if (!c) { bad++; console.error('FEHLER:', m); } else { ok++; console.log('ok:', m); } };

const sq = (ags, s, w, n, e) => ({ properties: { ags }, geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] } });
const bounds = { features: [sq('08111000', 48.69, 9.04, 48.87, 9.32), sq('08115003', 48.6, 8.9, 48.7, 9.1), sq('09162000', 48.06, 11.36, 48.25, 11.72), sq('11000000', 52.34, 13.09, 52.68, 13.76)] };
const boxes = O.landBoxes(bounds);
assert(JSON.stringify(boxes['08']) === JSON.stringify([48.6, 8.9, 48.87, 9.32]) && boxes['09'] && boxes['11'], `Landesrechtecke aus den Gemeinden (${JSON.stringify(boxes)})`);
assert(O.landsFor([{ bb: [48.7, 9.0, 48.9, 9.4] }], boxes).join() === '08' && O.landsFor([{ bb: [47.5, 8.0, 49.5, 12.0] }], boxes).join() === '08,09', 'nur Länder, die ein Auftrag berührt');
assert(O.OSM_SRC.url.includes('{slug}') && O.LAND_SLUG['08'] === 'baden-wuerttemberg' && Object.keys(O.LAND_SLUG).length === 16, 'Geofabrik-Adresse je Land');

const hasOsmium = spawnSync('python3', ['-c', 'import osmium'], { stdio: 'ignore' }).status === 0;
if (!hasOsmium) console.log('übersprungen: Ausschnitt (python3 ohne osmium)');
else {
  const TMP = await mkdtemp(path.join(os.tmpdir(), 'wege-osm-')), pbf = path.join(TMP, 't.osm.pbf');
  // kleines Netz: Hauptstraße 1–2–3, Einbahn-Abkürzung 1–4–3 (gegen die Richtung), Zufahrt (fällt weg), Straßenbahn, Abstellgleis (fällt weg)
  const py = `import osmium
w = osmium.SimpleWriter(${JSON.stringify(pbf)})
for i, la, lo in [(1,48.770,9.170),(2,48.775,9.180),(3,48.770,9.190),(4,48.768,9.180),(5,48.780,9.175),(6,48.781,9.185),(7,48.782,9.186)]:
    w.add_node(osmium.osm.mutable.Node(id=i, location=(lo, la)))
w.add_way(osmium.osm.mutable.Way(id=10, nodes=[1,2,3], tags={'highway':'primary'}))
w.add_way(osmium.osm.mutable.Way(id=11, nodes=[3,4,1], tags={'highway':'residential','oneway':'yes'}))
w.add_way(osmium.osm.mutable.Way(id=12, nodes=[2,5], tags={'highway':'service','service':'driveway'}))
w.add_way(osmium.osm.mutable.Way(id=13, nodes=[5,6], tags={'railway':'tram'}))
w.add_way(osmium.osm.mutable.Way(id=14, nodes=[6,7], tags={'railway':'rail','service':'siding'}))
w.close()`;
  const mk = spawnSync('python3', ['-c', py], { encoding: 'utf8' });
  assert(mk.status === 0, `Test-Extrakt geschrieben ${mk.stderr || ''}`);
  const logs = [], get = await O.osmExtract({ jobs: [{ key: 'road-A', kind: 'road', bb: [48.76, 9.16, 48.79, 9.2] }, { key: 'rail-1_2', kind: 'rail', bb: [48.5, 9.0, 49.0, 9.75] }], bounds, TMP, log: (s) => logs.push(s), files: [pbf, pbf] });
  const road = await get('road-A'), rail = await get('rail-1_2'), ways = (el) => el.filter(e => e.type === 'way').map(e => e.id).sort((a, b) => a - b);
  assert(ways(road).join() === '10,11' && road.find(e => e.id === 11)?.tags?.oneway === 'yes' && road.filter(e => e.type === 'node').length === 4, `Straßen: Hauptstraße und Einbahn mit Tags, Zufahrt fällt weg, doppelte Datei zählt einmal (${ways(road)})`);
  assert(ways(rail).join() === '13' && !rail.find(e => e.type === 'way').tags, 'Gleise: Straßenbahn ohne Tags, Abstellgleis fällt weg');
  const net = W.buildNet(road, { directed: true }), r = W.makeRouter(net).route([48.770, 9.170], [{ key: 'x', b: [48.770, 9.190] }], 50).get('x');
  assert(net.n === 4 && r && r.pts.some(p => Math.abs(p[0] - 48.775) < 1e-6), 'Bus fährt über die Hauptstraße (Einbahn-Abkürzung nur in Gegenrichtung)');
  assert(logs.some(s => /osm-extract: road-A: 2 Wege, 4 Knoten/.test(s)), 'Protokoll je Auftrag');
  await rm(TMP, { recursive: true, force: true });
}
console.log(`\n${ok} ok, ${bad} Fehler`);
if (bad) process.exit(1);
