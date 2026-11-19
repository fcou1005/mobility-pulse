// Geo-Lauf, Streckenverläufe (18.11.2026): Straßen- und Gleisnetz aus den Landesextrakten von Geofabrik statt Overpass (scripts/geo/osm-extract.py).
// Anlass: overpass-api.de antwortete am 18.11.2026 mit „502 … All query workers are busy“ und empfiehlt für automatische Nutzung eine eigene
// Instanz; der Lauf brauchte 3 Stunden und lieferte für keine der sieben Städte einen Streckenverlauf. Geofabrik stellt die Extrakte zum
// Herunterladen bereit (einmal im Monat je Land, kein Abfrage-Server). Ablauf: Länder bestimmen, deren Fläche ein Auftrag berührt,
// .osm.pbf laden, pyosmium in einer eigenen venv einrichten (falls nicht vorhanden), alle Aufträge in einem Durchgang je Datei ausschneiden.
//   GEO_OSM_URL: Vorlage der Download-Adresse mit {slug} (Vorgabe Geofabrik), GEO_OSM_PY: Python mit osmium (sonst venv in TMP)
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bboxOf } from '../../lib/pulse-zones-geo.js';
import { download } from './common.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const OSM_SRC = Object.freeze({ url: process.env.GEO_OSM_URL || 'https://download.geofabrik.de/europe/germany/{slug}-latest.osm.pbf', pyosmium: 'osmium==4.3.2', timeoutMin: 120,
  // zweite Quelle (19.11.2026: Geofabrik antwortete dem Lauf mit ECONNREFUSED): Landesextrakte von openstreetmap.fr, eigene Schreibweise ({fr})
  mirror: process.env.GEO_OSM_URL ? null : 'https://download.openstreetmap.fr/extracts/europe/germany/{fr}-latest.osm.pbf' });
/** Geofabrik-Name je Land (erste zwei Stellen des Gemeindeschlüssels) */
export const LAND_SLUG = Object.freeze({ '01': 'schleswig-holstein', '02': 'hamburg', '03': 'niedersachsen', '04': 'bremen', '05': 'nordrhein-westfalen', '06': 'hessen',
  '07': 'rheinland-pfalz', '08': 'baden-wuerttemberg', '09': 'bayern', '10': 'saarland', '11': 'berlin', '12': 'brandenburg', '13': 'mecklenburg-vorpommern', '14': 'sachsen',
  '15': 'sachsen-anhalt', '16': 'thueringen' });

/** Schreibweise bei openstreetmap.fr (Unterstriche, ohne Umlaut-Ersatz) */
export const LAND_FR = Object.freeze({ '01': 'schleswig_holstein', '02': 'hamburg', '03': 'niedersachsen', '04': 'bremen', '05': 'nordrhein_westfalen', '06': 'hessen',
  '07': 'rheinland_pfalz', '08': 'baden_wurttemberg', '09': 'bayern', '10': 'saarland', '11': 'berlin', '12': 'brandenburg', '13': 'mecklenburg_vorpommern', '14': 'sachsen',
  '15': 'sachsen_anhalt', '16': 'thuringen' });
const meets = (a, b) => !(a[3] < b[1] || a[1] > b[3] || a[2] < b[0] || a[0] > b[2]);
/** Rechteck [S, W, N, O] je Land aus den Gemeindegrenzen */
export function landBoxes(bounds) {
  const out = {};
  for (const f of bounds?.features || []) {
    const l = String(f.properties?.ags || '').slice(0, 2); if (!LAND_SLUG[l] || !f.geometry) continue;
    const b = bboxOf(f.geometry), bb = [b[1], b[0], b[3], b[2]], o = out[l];
    out[l] = o ? [Math.min(o[0], bb[0]), Math.min(o[1], bb[1]), Math.max(o[2], bb[2]), Math.max(o[3], bb[3])] : bb;
  }
  return out;
}
/** Länder, deren Rechteck mindestens einen Auftrag berührt (sortiert) */
export const landsFor = (jobs, boxes) => Object.keys(boxes).filter(l => jobs.some(j => meets(j.bb, boxes[l]))).sort();

/** Python mit osmium: GEO_OSM_PY, sonst python3 mit osmium, sonst venv in TMP (pip install) */
function pythonWithOsmium(TMP, log) {
  const ok = (py) => spawnSync(py, ['-c', 'import osmium'], { stdio: 'ignore' }).status === 0;
  if (process.env.GEO_OSM_PY) { if (ok(process.env.GEO_OSM_PY)) return process.env.GEO_OSM_PY; throw new Error(`GEO_OSM_PY ohne osmium: ${process.env.GEO_OSM_PY}`); }
  if (ok('python3')) return 'python3';
  const venv = path.join(TMP, 'osm-venv'), py = path.join(venv, 'bin', 'python');
  if (!existsSync(py)) { const v = spawnSync('python3', ['-m', 'venv', venv], { encoding: 'utf8' }); if (v.status !== 0) throw new Error(`venv: ${(v.stderr || '').slice(0, 200)}`); }
  const p = spawnSync(py, ['-m', 'pip', 'install', '-q', OSM_SRC.pyosmium], { encoding: 'utf8', timeout: 10 * 60e3 });
  if (p.status !== 0 || !ok(py)) throw new Error(`pip install ${OSM_SRC.pyosmium}: ${(p.stderr || '').slice(-300)}`);
  log(`Wege: ${OSM_SRC.pyosmium} in ${venv} eingerichtet`);
  return py;
}

/**
 * Aufträge [{ key, kind: 'road' | 'rail', bb: [S, W, N, O] }] aus den Landesextrakten ausschneiden → async (key) → Overpass-Elemente.
 * Wirft, wenn ein Schritt scheitert (Aufrufer fällt dann auf Overpass zurück).
 */
export async function osmExtract({ jobs, bounds, TMP, log, files = null }) {
  const t0 = Date.now(), dir = path.join(TMP, 'osm'); await mkdir(dir, { recursive: true });
  const py = pythonWithOsmium(TMP, log);
  let pbf = files;
  if (!pbf) {
    const lands = landsFor(jobs, landBoxes(bounds)); pbf = [];
    for (const l of lands) {
      const slug = LAND_SLUG[l], f = path.join(dir, `${slug}.osm.pbf`), urls = [OSM_SRC.url.replace('{slug}', slug), ...(OSM_SRC.mirror ? [OSM_SRC.mirror.replace('{fr}', LAND_FR[l])] : [])];
      let r = null, err = '';
      for (const url of urls) { try { r = await download(url, f, { timeoutMs: 30 * 60e3, tries: 4, waitMs: 30e3 }); log(`Wege: OSM ${slug} ${(r.bytes / 1e6).toFixed(0)} MB von ${new URL(url).host}${r.lastModified ? ` (Stand ${r.lastModified})` : ''}`); break; } catch (e) { err += `${new URL(url).host}: ${e.message}; `; } }
      if (!r) throw new Error(`${slug}: ${err}`);
      pbf.push(f);
    }
  }
  const jf = path.join(dir, 'auftraege.json'), out = path.join(dir, 'aus');
  await writeFile(jf, JSON.stringify({ files: pbf, jobs }));
  const p = spawnSync(py, [path.join(HERE, 'osm-extract.py'), jf, out], { encoding: 'utf8', timeout: OSM_SRC.timeoutMin * 60e3, maxBuffer: 64e6 });
  for (const line of String(p.stdout || '').split('\n').filter(Boolean)) log(line);
  if (p.status !== 0) throw new Error(`osm-extract: ${p.error?.message || ''} ${(p.stderr || '').slice(-400)}`.trim());
  if (!files) for (const f of pbf) await rm(f, { force: true });
  log(`Wege: OSM-Ausschnitte für ${jobs.length} Aufträge (${((Date.now() - t0) / 60e3).toFixed(1)} min)`);
  // erst beim Bedarf lesen: alle Städte zugleich im Speicher wären mehrere GB
  return async (key) => { const f = path.join(out, `${key}.json`); return existsSync(f) ? JSON.parse(await readFile(f, 'utf8')).elements : []; };
}
