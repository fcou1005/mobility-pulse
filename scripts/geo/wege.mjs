// Geo-Lauf, Streckenverläufe (17.11.2026): je Verbindung Station → Station des Fahrplans der kürzeste Weg im OSM-Netz → wege/<AGS>.json, wege/index.json
// für die Städte mit den größten Flotten (lib/pulse-geo-wege.js). Stationen und Lage wie die Live-Karte: oepnv/haltestellen.json.gz aus dem Datenstand.
//   GEO_WEGE_CITIES (Vorgabe 30), GEO_WEGE_BUDGET_MIN (150), GEO_OVERPASS (Overpass-Adresse)
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import * as W from '../../lib/pulse-geo-wege.js';
import * as G from '../../lib/pulse-geo-gtfs.js';
import { stationLookup } from '../../lib/pulse-oepnv.js';
import { bboxOf } from '../../lib/pulse-zones-geo.js';
import { distM } from '../../lib/pulse-geo-proj.js';
import { UA, sleep, download, zipAll, zipLines, zipNames } from './common.mjs';

const CFG = { cities: +(process.env.GEO_WEGE_CITIES || W.WEGE_GEO.cities), budgetMin: +(process.env.GEO_WEGE_BUDGET_MIN || W.WEGE_GEO.budgetMin),
  overpass: (process.env.GEO_OVERPASS || 'https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter').split(','), pauseMs: 5000 };

async function overpass(q) {
  for (let i = 0; i < 4; i++) {
    const url = CFG.overpass[i % CFG.overpass.length];
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA }, body: `data=${encodeURIComponent(q)}`, signal: AbortSignal.timeout(400e3) }).catch(e => ({ ok: false, status: e.message }));
    if (r.ok) { const j = await /** @type {Response} */ (r).json().catch(() => null); if (Array.isArray(j?.elements) && !j.remark) return j.elements; }
    await sleep(30e3 * (i + 1));
  }
  throw new Error('Overpass nicht erreichbar');
}
const grow = (bb, m) => { const dLat = m / 111320, dLon = m / (111320 * Math.cos(((bb[0] + bb[2]) / 2) * Math.PI / 180)); return [bb[0] - dLat, bb[1] - dLon, bb[2] + dLat, bb[3] + dLon]; };
const inside = (bb, p) => p[0] >= bb[0] && p[0] <= bb[2] && p[1] >= bb[1] && p[1] <= bb[3];

/** Verbindungen aus dem Fahrplan am Stichtag (alle Fahrten des Tages, Netz je Linie) */
async function loadPairs(zip, ix, ymd, log) {
  const t0 = Date.now(), names = zipNames(zip), has = (n) => names.includes(n);
  const on = G.activeServices(has('calendar.txt') ? await zipAll(zip, 'calendar.txt') : [], has('calendar_dates.txt') ? await zipAll(zip, 'calendar_dates.txt') : [], ymd);
  const routes = {}; let rh = null;
  await zipLines(zip, 'routes.txt', (line, n) => { if (n === 0) { rh = G.headerIx(line); return; } if (!line) return; const c = G.csvLine(line); routes[c[rh.route_id]] = W.netOfRoute(rh.route_type != null && c[rh.route_type] !== '' ? +c[rh.route_type] : null, (rh.route_short_name != null && c[rh.route_short_name]) || (rh.route_long_name != null && c[rh.route_long_name]) || ''); });
  const trips = new Map(); let th = null;
  await zipLines(zip, 'trips.txt', (line, n) => { if (n === 0) { th = G.headerIx(line); return; } if (!line) return; const c = G.csvLine(line); if (!on.has(c[th.service_id])) return; const net = routes[c[th.route_id]]; if (net) trips.set(c[th.trip_id], net); });
  const pc = W.pairCollector(trips, stationLookup(ix)); let sh = null;
  await zipLines(zip, 'stop_times.txt', (line, n) => { if (n === 0) { sh = G.headerIx(line); return; } if (!line) return; const c = line.indexOf('"') >= 0 ? G.csvLine(line) : line.split(','); pc.add(c[sh.trip_id], +c[sh.stop_sequence], c[sh.stop_id]); });
  const res = pc.result();
  log(`Wege: Fahrplan ${ymd}, ${trips.size} Fahrten, ${res.used} von ${res.rows} Halten mit Station, ${res.pairs.size} Verbindungen (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  return res.pairs;
}

export async function runWege({ OUT, TMP, DATA, bounds, log, now, top }) {
  const t0 = Date.now(), dir = path.join(OUT, 'wege'); await mkdir(dir, { recursive: true });
  const hf = path.join(DATA, 'oepnv', 'haltestellen.json.gz'); if (!existsSync(hf)) throw new Error('oepnv/haltestellen.json.gz fehlt im Datenstand');
  const ix = JSON.parse(gunzipSync(await readFile(hf)).toString('utf8')); if (!ix?.st?.id?.length) throw new Error('Stationsindex ohne Stationen');
  const zip = path.join(TMP, 'gtfs.zip'); if (!existsSync(zip)) await download(process.env.GEO_GTFS_URL || G.GTFS.url, zip, { timeoutMs: 30 * 60e3 });
  const ymd = G.nextTuesday(now), all = await loadPairs(zip, ix, ymd, log); await rm(zip, { force: true });
  const P = [...all].map(([k]) => { const [net, a, b] = k.split('|'); return { net, a: [ix.st.lat[+a], ix.st.lon[+a]], b: [ix.st.lat[+b], ix.st.lon[+b]], ga: ix.ags[ix.st.a[+a]], gb: ix.ags[ix.st.a[+b]] }; });
  const feat = new Map(bounds.features.map(f => [f.properties.ags, f])), tiles = new Map(), idx = {};
  const tileElements = async (key, bb) => { if (!tiles.has(key)) { tiles.set(key, await overpass(W.overpassRail(bb))); await sleep(CFG.pauseMs); } return tiles.get(key); };
  for (const [ags, fleet, name] of top.slice(0, CFG.cities)) {
    if ((Date.now() - t0) / 60e3 > CFG.budgetMin) { log(`Wege: Zeitbudget erreicht vor ${name}`); break; }
    const f = feat.get(ags); if (!f) continue;
    try {
      const t1 = Date.now(), b0 = bboxOf(f.geometry), city = [b0[1], b0[0], b0[3], b0[2]];
      const roadBb = grow(city, W.WEGE_GEO.roadBufM), railNear = grow(city, W.WEGE_GEO.railBufM);
      const road = P.filter(p => p.net === 's' && inside(roadBb, p.a) && inside(roadBb, p.b) && (p.ga === ags || p.gb === ags || inside(city, p.a) || inside(city, p.b)));
      const rail = P.filter(p => p.net === 'r' && (inside(railNear, p.a) || inside(railNear, p.b)) && distM(p.a[0], p.a[1], p.b[0], p.b[1]) <= W.WEGE_GEO.railMaxM);
      let railBb = railNear; for (const p of rail) for (const q of [p.a, p.b]) railBb = [Math.min(railBb[0], q[0]), Math.min(railBb[1], q[1]), Math.max(railBb[2], q[0]), Math.max(railBb[3], q[1])];
      railBb = grow(railBb, 3000);
      const roadEl = road.length ? await overpass(W.overpassRoad(roadBb.map(x => +x.toFixed(4)))) : []; if (road.length) await sleep(CFG.pauseMs);
      const railEl = []; if (rail.length) for (const tl of W.railTiles(railBb)) for (const e of await tileElements(tl.key, tl.bb)) railEl.push(e);
      const rr = road.length ? W.makeRouter(W.buildNet(roadEl, { directed: true })) : null, rl = rail.length ? W.makeRouter(W.buildNet(railEl)) : null;
      const res = W.routePairs([...road, ...rail], (net) => (net === 's' ? rr : rl));
      const doc = JSON.stringify({ schemaVersion: '1.0', ags, at: now, day: ymd, attribution: '© OpenStreetMap-Mitwirkende (ODbL); Fahrplan: gtfs.de (DELFI e. V. u. a.), CC BY 4.0', license: 'ODbL 1.0',
        note: 'kürzester Weg im OSM-Netz je Verbindung Station → Station (Schlüssel: Netz r = Schiene, s = Straße, Lage beider Stationen), Polyline 5 Nachkommastellen', stats: res.stats, segs: res.segs });
      await writeFile(path.join(dir, `${ags}.json`), doc);
      idx[ags] = { name, fleet, road: road.length, rail: rail.length, ...res.stats, bytes: doc.length, s: Math.round((Date.now() - t1) / 1000) };
      log(`Wege ${name}: ${res.stats.routed} von ${res.stats.pairs} Verbindungen mit Verlauf (Straße ${road.length}, Schiene ${rail.length}; zu kurz ${res.stats.short}, ohne Weg ${res.stats.noPath}, zu lang ${res.stats.tooLong}), ${(doc.length / 1e6).toFixed(2)} MB, ${idx[ags].s} s`);
    } catch (e) { log(`Wege ${name}: ${e.message}`); idx[ags] = { name, fleet, error: e.message }; }
  }
  await writeFile(path.join(dir, 'index.json'), JSON.stringify({ schemaVersion: '1.0', at: now, day: ymd, rule: { ...W.WEGE_GEO }, railTiles: tiles.size, cities: idx }));
}
