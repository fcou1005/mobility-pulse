// Geo-Lauf, S8.5: freier GTFS-Fahrplan von gtfs.de → gtfs/<Land>.json (gebündelte Haltestellen mit Abfahrten am Stichtag je aktiver Gemeinde)
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import * as G from '../../lib/pulse-geo-gtfs.js';
import { muniLocator } from '../../lib/pulse-geo-pop.js';
import { download, zipAll, zipLines, zipNames } from './common.mjs';

export async function runGtfs({ OUT, TMP, bounds, log, now }) {
  const t0 = Date.now(), zip = path.join(TMP, 'gtfs.zip'), url = process.env.GEO_GTFS_URL || G.GTFS.url, dl = await download(url, zip, { timeoutMs: 30 * 60e3 });
  const names = zipNames(zip), has = (n) => names.includes(n);
  const ymd = G.nextTuesday(now), on = G.activeServices(has('calendar.txt') ? await zipAll(zip, 'calendar.txt') : [], has('calendar_dates.txt') ? await zipAll(zip, 'calendar_dates.txt') : [], ymd);
  const trips = new Set(); let th = null;
  await zipLines(zip, 'trips.txt', (line, n) => { if (n === 0) { th = G.headerIx(line); return; } if (!line) return; const c = G.csvLine(line); if (on.has(c[th.service_id])) trips.add(c[th.trip_id]); });
  const cnt = G.departureCounter(trips); await zipLines(zip, 'stop_times.txt', (line) => cnt.add(line));
  const { dep, rows, used } = cnt.result(), stops = []; let sh = null;
  await zipLines(zip, 'stops.txt', (line, n) => { if (n === 0) { sh = G.headerIx(line); return; } if (!line) return; const c = G.csvLine(line); const lat = +c[sh.stop_lat], lon = +c[sh.stop_lon]; if (!Number.isFinite(lat) || !Number.isFinite(lon)) return; if (c[sh.location_type] && c[sh.location_type] !== '0') return; stops.push({ id: c[sh.stop_id], name: c[sh.stop_name], lat, lon, parent: c[sh.parent_station] || null }); });
  const bundles = G.bundleStops(stops, dep), locate = muniLocator(bounds.features), by = new Map();
  for (const b of bundles) { const a = locate(b.lat, b.lon); if (!a) continue; let l = by.get(a); if (!l) by.set(a, l = []); l.push([Math.round(b.lat * 1e5) / 1e5, Math.round(b.lon * 1e5) / 1e5, b.dep, b.name]); }
  await mkdir(path.join(OUT, 'gtfs'), { recursive: true });
  for (const [st, list] of Object.entries(bounds.byState)) {
    const ags = {}; for (const a of list) if (by.has(a)) ags[a] = by.get(a).sort((x, y) => y[2] - x[2]);
    await writeFile(path.join(OUT, 'gtfs', `${st}.json`), JSON.stringify({ schemaVersion: '1.0', state: st, at: now, day: ymd, attribution: G.GTFS.attribution, license: G.GTFS.license, fields: ['lat', 'lon', 'abfahrten', 'name'], ags }));
  }
  await writeFile(path.join(OUT, 'gtfs', 'index.json'), JSON.stringify({ schemaVersion: '1.0', at: now, day: ymd, source: url, lastModified: dl.lastModified, bytes: dl.bytes, services: on.size, trips: trips.size, stopTimes: rows, departures: used, stops: stops.length, bundles: bundles.length, municipalities: by.size, attribution: G.GTFS.attribution, license: G.GTFS.license }));
  await rm(zip, { force: true });
  log(`GTFS ${ymd}: ${trips.size} Fahrten, ${used} von ${rows} Halten als Abfahrt, ${bundles.length} Bündel, ${by.size} Gemeinden (${(Date.now() - t0) / 1000} s)`);
}
