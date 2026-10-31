#!/usr/bin/env node
// Lädt die Gemeindegrenzen (BKG VG250, Stand 01.01., dl-de/by-2-0), projiziert nach WGS84,
// vereinfacht (~30 m), quantisiert (5 Nachkommastellen ≈ 1 m) und schreibt data/boundaries.json.
// Benötigt ogr2ogr (gdal-bin) und unzip. Nutzung: node scripts/prepare-boundaries.mjs [zip-url]
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const WORK = path.join(ROOT, '.work', 'vg250');
const OUT = process.env.BOUNDARIES_OUT || path.join(ROOT, 'data', 'boundaries.json');
const CANDIDATES = [
  process.argv[2],
  process.env.VG250_URL,
  'https://daten.gdz.bkg.bund.de/produkte/vg/vg250-ew_ebenen_0101/aktuell/vg250-ew_01-01.utm32s.shape.ebenen.zip', // mit Einwohnerzahl (EWZ)
  'https://daten.gdz.bkg.bund.de/produkte/vg/vg250_ebenen_0101/aktuell/vg250_01-01.utm32s.shape.ebenen.zip',
].filter(Boolean);
const log = (...a) => console.error('[boundaries]', ...a);

await rm(WORK, { recursive: true, force: true });
await mkdir(WORK, { recursive: true });
const zip = path.join(WORK, 'vg250.zip');
let used = null;
for (const url of CANDIDATES) {
  try {
    log('lade', url);
    const r = await fetch(url, { headers: { 'user-agent': 'mobility-pulse/1.0' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    await writeFile(zip, Buffer.from(await r.arrayBuffer()));
    used = url; break;
  } catch (e) { log('fehlgeschlagen:', e.message); }
}
if (!used) { log('Kein VG250-Download erreichbar'); process.exit(2); }
execFileSync('unzip', ['-oq', zip, '-d', WORK]);
const find = execFileSync('find', [WORK, '-iname', 'VG250_GEM.shp']).toString().trim().split('\n').filter(Boolean);
if (!find.length) { log('VG250_GEM.shp nicht im Archiv'); process.exit(2); }
const shp = find[0];
const raw = path.join(WORK, 'gem.geojson');
log('ogr2ogr', shp);
const ogr = (fields) => execFileSync('ogr2ogr', ['-f', 'GeoJSON', '-t_srs', 'EPSG:4326', '-select', fields, '-where', 'GF=4', '-simplify', '0.0003', '-lco', 'COORDINATE_PRECISION=5', raw, shp], { stdio: 'inherit' });
try { ogr('AGS,GEN,BEZ,SN_L,EWZ'); } catch { log('Feld EWZ fehlt – ohne Einwohnerzahl'); await rm(raw, { force: true }); ogr('AGS,GEN,BEZ,SN_L'); }
const fc = JSON.parse(await readFile(raw, 'utf8'));
const STATES = { '01': 'SH', '02': 'HH', '03': 'NI', '04': 'HB', '05': 'NW', '06': 'HE', '07': 'RP', '08': 'BW', '09': 'BY', '10': 'SL', '11': 'BE', '12': 'BB', '13': 'MV', '14': 'SN', '15': 'ST', '16': 'TH' };
const bboxOf = (geom) => {
  let a = [180, 90, -180, -90];
  const walk = (c) => { if (typeof c[0] === 'number') { if (c[0] < a[0]) a[0] = c[0]; if (c[0] > a[2]) a[2] = c[0]; if (c[1] < a[1]) a[1] = c[1]; if (c[1] > a[3]) a[3] = c[1]; } else c.forEach(walk); };
  walk(geom.coordinates); return a.map(v => Math.round(v * 1e5) / 1e5);
};
const features = fc.features.map(f => ({
  type: 'Feature',
  properties: { ags: f.properties.AGS, name: f.properties.GEN, kind: f.properties.BEZ, state: STATES[f.properties.SN_L] || f.properties.SN_L, pop: f.properties.EWZ ?? null },
  bbox: bboxOf(f.geometry),
  geometry: f.geometry,
}));
// Gemeinden können in mehrere Features zerfallen (Exklaven): nach AGS zu MultiPolygon zusammenführen
const byAgs = new Map();
for (const f of features) {
  const k = f.properties.ags;
  if (!byAgs.has(k)) { byAgs.set(k, f); continue; }
  const prev = byAgs.get(k);
  const polys = (g) => g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  prev.geometry = { type: 'MultiPolygon', coordinates: [...polys(prev.geometry), ...polys(f.geometry)] };
  prev.bbox = [Math.min(prev.bbox[0], f.bbox[0]), Math.min(prev.bbox[1], f.bbox[1]), Math.max(prev.bbox[2], f.bbox[2]), Math.max(prev.bbox[3], f.bbox[3])];
}
const out = { type: 'FeatureCollection', source: used, license: 'dl-de/by-2-0', attribution: '© GeoBasis-DE / BKG (Gemeindegrenzen VG250, vereinfacht ca. 30 m, quantisiert ca. 1 m)', generatedAt: new Date().toISOString(), features: [...byAgs.values()] };
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(out));
log(`→ ${OUT}: ${out.features.length} Gemeinden, ${(Buffer.byteLength(JSON.stringify(out)) / 1e6).toFixed(1)} MB`);
if (!process.env.KEEP_WORK) await rm(WORK, { recursive: true, force: true });
