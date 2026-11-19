# Geo-Lauf, Streckenverläufe (18.11.2026): Straßen- und Gleisnetz aus OSM-Extrakten (Geofabrik, .osm.pbf je Land) statt Overpass.
# Der öffentliche Overpass-Server war am 18.11.2026 voll ausgelastet („All query workers are busy“, für automatische Nutzung eigene Instanz
# empfohlen); alle sieben Städte des Laufs scheiterten. Dieses Skript liest die Extrakte einmal und schreibt je Auftrag eine Datei im Format
# einer Overpass-Antwort ({"elements": [...]}), damit lib/pulse-geo-wege.js (buildNet) unverändert bleibt.
#   python3 osm-extract.py <auftraege.json> <ausgabe-ordner>
#   auftraege.json: {"files": ["…/baden-wuerttemberg-latest.osm.pbf", …], "jobs": [{"key": "road-08111000", "kind": "road", "bb": [S, W, N, O]}, …]}
# Auswahl wie die Overpass-Abfragen (overpassRoad, overpassRail in lib/pulse-geo-wege.js): Weg mit passenden Tags, dessen Umriss das
# Rechteck schneidet; alle Knoten des Wegs kommen mit (wie „>;“). Straßen mit den Tags für Einbahn und Busspur, Gleise ohne Tags.
# Ein Weg, der in zwei Landesextrakten steht (Grenze), zählt einmal (Schlüssel: OSM-Kennung).
import json
import os
import sys
import time

import osmium

ROADS = set('motorway motorway_link trunk trunk_link primary primary_link secondary secondary_link tertiary tertiary_link unclassified '
            'residential living_street service busway bus_guideway road'.split())
NO_SERVICE = {'parking_aisle', 'driveway', 'drive-through', 'emergency_access'}
NO_ACCESS = {'no', 'private'}
BUS_OK = {'yes', 'designated'}
RAIL = {'rail', 'light_rail', 'subway', 'tram', 'narrow_gauge', 'monorail'}
RAIL_NO_SERVICE = {'yard', 'siding', 'spur'}
KEEP = ('highway', 'oneway', 'oneway:bus', 'oneway:psv', 'junction', 'busway', 'busway:both', 'busway:left', 'busway:right', 'bus:lanes',
        'lanes:bus', 'psv:lanes', 'bus', 'psv', 'access', 'service')


def road_ok(t):
    hw = t.get('highway')
    if not hw:
        return False
    if hw in ROADS and t.get('access') not in NO_ACCESS and t.get('service') not in NO_SERVICE:
        return True
    return t.get('bus') in BUS_OK or t.get('psv') in BUS_OK


def rail_ok(t):
    return t.get('railway') in RAIL and t.get('service') not in RAIL_NO_SERVICE


def main(job_file, out_dir):
    cfg = json.load(open(job_file, encoding='utf-8'))
    jobs = cfg['jobs']
    road = [j for j in jobs if j['kind'] == 'road']
    rail = [j for j in jobs if j['kind'] == 'rail']
    res = {j['key']: {'nodes': {}, 'ways': {}} for j in jobs}

    # Raster 0,1° → Aufträge, die die Rasterzelle berühren (bei 100+ Städten wäre der Vergleich mit allen Aufträgen je Weg zu langsam)
    def grid(lst):
        g = {}
        for j in lst:
            s, w, n, e = j['bb']
            for a in range(int(s * G), int(n * G) + 1):
                for b in range(int(w * G), int(e * G) + 1):
                    g.setdefault((a, b), []).append(j)
        return g

    G = 10
    grids = {'road': grid(road), 'rail': grid(rail)}

    def hits(kind, s, w, n, e):
        g, seen, out = grids[kind], set(), []
        for a in range(int(s * G), int(n * G) + 1):
            for b in range(int(w * G), int(e * G) + 1):
                for j in g.get((a, b), ()):
                    if j['key'] in seen:
                        continue
                    seen.add(j['key'])
                    if not (e < j['bb'][1] or w > j['bb'][3] or n < j['bb'][0] or s > j['bb'][2]):
                        out.append(j)
        return out

    for f in cfg['files']:
        t0, seen = time.time(), 0
        fp = osmium.FileProcessor(f).with_locations('sparse_mem_array').with_filter(osmium.filter.EntityFilter(osmium.osm.WAY)) \
            .with_filter(osmium.filter.KeyFilter('highway', 'railway'))
        for o in fp:
            t = o.tags
            is_road = bool(road) and road_ok(t)
            is_rail = bool(rail) and not is_road and rail_ok(t)
            if not (is_road or is_rail):
                continue
            pts = []
            for nd in o.nodes:
                loc = nd.location
                if loc.valid():
                    pts.append((nd.ref, round(loc.lat, 7), round(loc.lon, 7)))
            if len(pts) < 2:
                continue
            lats = [p[1] for p in pts]
            lons = [p[2] for p in pts]
            sel = hits('road' if is_road else 'rail', min(lats), min(lons), max(lats), max(lons))
            if not sel:
                continue
            seen += 1
            tags = {k: t.get(k) for k in KEEP if k in t} if is_road else None
            for j in sel:
                r = res[j['key']]
                if o.id in r['ways']:
                    continue
                r['ways'][o.id] = ([p[0] for p in pts], tags)
                for p in pts:
                    r['nodes'][p[0]] = (p[1], p[2])
        print(f'osm-extract: {os.path.basename(f)}: {seen} Wege ausgewählt, {time.time() - t0:.0f} s', flush=True)

    os.makedirs(out_dir, exist_ok=True)
    for key, r in res.items():
        el = [{'type': 'node', 'id': i, 'lat': la, 'lon': lo} for i, (la, lo) in r['nodes'].items()]
        for i, (nds, tags) in r['ways'].items():
            w = {'type': 'way', 'id': i, 'nodes': nds}
            if tags:
                w['tags'] = tags
            el.append(w)
        with open(os.path.join(out_dir, f'{key}.json'), 'w', encoding='utf-8') as fh:
            json.dump({'elements': el}, fh, separators=(',', ':'))
        print(f'osm-extract: {key}: {len(r["ways"])} Wege, {len(r["nodes"])} Knoten', flush=True)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
