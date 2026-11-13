// S3.8 Rest (Disposition unter 0,4 MB): Dateien je Gemeinde aus dem fertigen Datenstand, nur aus Dateien auf der Platte. Der Sammler ruft das
// in der Phase „gebiet“ nach der Kalibrierung auf, scripts/make-fixture.mjs für den festen Datenstand der Browser-Tests. Formate: lib/pulse-split.js.
//   ops-input/area/<AGS>.json, ops-input/zones/<AGS>/<n>.json, latest-core.json
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as SP from '../lib/pulse-split.js';
import * as SV from '../lib/pulse-schema.js';
import { hourQuality } from '../lib/pulse-report.js';
import { dayOf } from '../lib/pulse-track.js';

const rdj = async (f) => (existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : null);

/** Rahmen je Gemeinde aus boundaries/<Land>.json (bbox wie C.geomBounds, Phase „grenzen“) */
export async function bboxFromDisk(DATA) {
  const out = new Map(), idx = await rdj(path.join(DATA, 'boundaries', 'index.json'));
  for (const st of Object.keys(idx?.states || {})) {
    const doc = await rdj(path.join(DATA, 'boundaries', `${st}.json`));
    for (const f of doc?.features || []) if (f?.properties?.ags && f.bbox) out.set(f.properties.ags, f.bbox);
  }
  return out;
}

/**
 * ops-input/cells/<AGS>.json aus ops-input/<AGS>.json (Zellen spaltenweise, SP.cellsCompact) und flows/<Tag>.json (Ströme der Gemeinde für die
 * Zellen-Tage); ops-input/index.json bekommt compact = Version, wenn alle Gemeinden geschrieben sind.
 */
/** @param {string} DATA @param {{ log?: (s: string) => void }} [opt] */
export async function writeCellsCompact(DATA, { log = (_s) => {} } = {}) {
  const dir = path.join(DATA, 'ops-input'), idxFile = path.join(dir, 'index.json'), idx = await rdj(idxFile);
  if (!idx?.ags) return 0;
  const cDir = path.join(dir, 'cells'); await mkdir(cDir, { recursive: true });
  const flIdx = await rdj(path.join(DATA, 'flows', 'index.json')), flDocs = [];
  for (const d of idx.cellDays || []) if ((flIdx?.days || []).includes(d)) { const f = await rdj(path.join(DATA, 'flows', `${d}.json`)); if (f) flDocs.push(f); }
  const keep = new Set(idx.ags); let n = 0;
  for (const f of await readdir(cDir)) if (/^\d{8}\.json$/.test(f) && !keep.has(f.slice(0, 8))) await rm(path.join(cDir, f));
  for (const ags of idx.ags) {
    const d = await rdj(path.join(dir, `${ags}.json`)); if (!d?.cells) continue;
    const { cells, version: _v, schemaVersion: _s, ...head } = d;
    await writeFile(path.join(cDir, `${ags}.json`), JSON.stringify({ schemaVersion: SV.SCHEMA.ops, version: SP.COMPACT_VERSION, ...head,
      cells: SP.cellsCompact(cells, ags), flows: { indexed: !!flIdx, days: flIdx?.days || [], docs: SP.flowsSlice(flDocs, ags) } }));
    n++;
  }
  const all = n === idx.ags.length;
  await writeFile(idxFile, JSON.stringify({ ...idx, ...(all ? { compact: SP.COMPACT_VERSION } : {}) }));
  log(`Gebiet: Zellen spaltenweise für ${n} Gemeinden${all ? '' : ' (unvollständig, Seite nutzt ops-input/<AGS>.json)'}`);
  return n;
}

/**
 * Schreibt latest-core.json, ops-input/area/<AGS>.json und ops-input/zones/<AGS>/<n>.json für alle Gemeinden mit Bestand oder Nachfrage-Eingabe.
 * @param {string} DATA Datenverzeichnis
 * @param {{ bbox?: Map<string, number[]>, log?: (s: string) => void }} [opt]
 */
export async function writeArea(DATA, { bbox = null, log = (_s) => {} } = {}) {
  const t0 = Date.now();
  const latest = await rdj(path.join(DATA, 'latest.json')); if (!latest?.at) { log('Gebiet: kein latest.json'); return null; }
  await writeFile(path.join(DATA, 'latest-core.json'), JSON.stringify({ schemaVersion: SV.SCHEMA.latest, ...SP.latestCore(latest) }));
  const inIdx = await rdj(path.join(DATA, 'ops-input', 'index.json')), flIdx = await rdj(path.join(DATA, 'ops-input', 'fleet', 'index.json'));
  const agsList = [...new Set([...(flIdx?.ags || []), ...(inIdx?.ags || [])])].sort();
  const box = bbox || await bboxFromDisk(DATA);

  // Umsatz: Vorauswahl-Tag wie web/app-usage.js defaultUsageDay (Kopf der Tage aus events/hour-totals.json: runs, gapHours)
  const evIdx = await rdj(path.join(DATA, 'events', 'index.json')), days = evIdx?.days || [];
  const ht = await rdj(path.join(DATA, 'events', 'hour-totals.json'));
  const runDay = days.length && dayOf(latest.at) === days[days.length - 1] ? days[days.length - 1] : null;
  const day = days.length ? SP.pickUsageDay(days, runDay, (d) => ht?.days?.[d] || null, (doc) => hourQuality(doc.runs, doc.gapHours).full) : null;
  const evByState = new Map(); // Land → events/<Tag>/<Land>.json des Vorauswahl-Tages
  if (day && existsSync(path.join(DATA, 'events', day))) for (const f of await readdir(path.join(DATA, 'events', day))) if (/^[A-Z]{2}\.json$/.test(f)) evByState.set(f.slice(0, 2), await rdj(path.join(DATA, 'events', day, f)));
  const [daily, pricing, calib, catalog] = await Promise.all(['history/daily.json', 'pricing.json', 'calib.json', 'sources.json'].map(f => rdj(path.join(DATA, f))));
  const calibOk = calib?.version === 1 && Math.abs((calib.at || 0) - latest.at) <= 2 * 3600e3 ? calib : null; // wie report.js loadCalibration
  const shared = calibOk ? SP.econCalib(calibOk) : null;

  // Gruppen-Ereignisse aller Monate
  const gIdx = await rdj(path.join(DATA, 'groups', 'index.json')), months = Array.isArray(gIdx?.months) ? gIdx.months : null;
  const gDocs = months ? await Promise.all(months.map(m => rdj(path.join(DATA, 'groups', `${m}.json`)))) : [];
  const gOk = months && gDocs.every(Boolean);

  // Zonen je Anbieter: Dateien laut zones/index.json, die die Gemeinde nennen
  const zIdx = await rdj(path.join(DATA, 'zones', 'index.json')), zByAgs = new Map(), zCache = new Map();
  for (const z of zIdx?.zones || []) for (const a of z.municipalities || []) { if (!zByAgs.has(a)) zByAgs.set(a, []); zByAgs.get(a).push(z); }
  const zoneDoc = async (file) => { if (!zCache.has(file)) { const d = await rdj(path.join(DATA, 'zones', file)); zCache.set(file, d ? { d, boxes: SP.featureBoxes(d) } : null); } return zCache.get(file); };

  const aDir = path.join(DATA, 'ops-input', 'area'), zDir = path.join(DATA, 'ops-input', 'zones');
  await mkdir(aDir, { recursive: true }); await mkdir(zDir, { recursive: true });
  if (shared) await writeFile(path.join(aDir, 'calib.json'), JSON.stringify({ schemaVersion: SV.SCHEMA.ops, ...shared }));
  else await rm(path.join(aDir, 'calib.json'), { force: true });
  let nArea = 0, nZone = 0, bytes = 0;
  const keep = new Set(agsList);
  for (const ags of agsList) {
    const st = latest.municipalities?.[ags]?.state || null;
    const econ = day && st ? SP.econSlice({ ags, day, doc: evByState.get(st) || null, daily, pricing, calib: calibOk, latestGroups: latest.groups }) : null;
    const groups = gOk ? SP.groupsSlice(gDocs, months, ags) : null;
    const zones = {}, b = box.get(ags) || null, zl = zByAgs.get(ags) || [];
    let zonesOk = !!zIdx && (!zl.length || !!b); // false: Seite nimmt zones/index.json wie bisher
    if (b && zl.length) {
      const byOp = new Map(); for (const z of zl) { if (!byOp.has(z.operator)) byOp.set(z.operator, []); byOp.get(z.operator).push(z); }
      const dir = path.join(zDir, ags), cover = SP.zoneCover(b);
      let n = 0;
      for (const [op, list] of [...byOp].sort((x, y) => String(x[0]).localeCompare(String(y[0])))) {
        const files = [];
        for (const z of list) {
          const zd = await zoneDoc(z.file); if (!zd) { files.length = 0; break; }
          const sl = SP.zonesSlice(zd.d, cover, { boxes: zd.boxes }); files.push(sl ? { file: z.file, at: z.at ?? null, doc: sl } : { file: z.file, at: z.at ?? null, full: true });
        }
        if (!files.length) { zonesOk = false; continue; } // Datei fehlt auf der Platte
        const list2 = list.map(z => ({ file: z.file, at: z.at ?? null }));
        if (files.every(f => f.full)) { zones[op] = { path: null, files: list2 }; continue; } // nur ganze Dateien: Seite lädt zones/<Datei>.json
        if (!n) await mkdir(dir, { recursive: true });
        const rel = `ops-input/zones/${ags}/${n++}.json`, str = JSON.stringify({ schemaVersion: SV.SCHEMA.ops, version: SP.AREA_VERSION, ags, operator: op, bbox: b, cover, files });
        await writeFile(path.join(DATA, rel), str); bytes += str.length; nZone++;
        zones[op] = { path: rel, files: list2 };
      }
      if (!n) await rm(dir, { recursive: true, force: true });
      else for (const f of await readdir(dir)) if (/^\d+\.json$/.test(f) && +f.slice(0, -5) >= n) await rm(path.join(dir, f));
    }
    const parking = catalog ? Object.fromEntries(Object.entries(catalog.parking_reference || {}).filter(([k, r]) => !k.startsWith('_') && r?.ags === ags)) : null; // amtliche Abstellflächen (web/ops.js officialData)
    const str = JSON.stringify({ schemaVersion: SV.SCHEMA.ops, version: SP.AREA_VERSION, ags, at: latest.at, zonesAt: zIdx?.at ?? null, econ, groups, zones: zonesOk ? zones : null, parking });
    await writeFile(path.join(aDir, `${ags}.json`), str); bytes += str.length; nArea++;
  }
  for (const f of await readdir(aDir)) if (/^\d{8}\.json$/.test(f) && !keep.has(f.slice(0, 8))) await rm(path.join(aDir, f));
  for (const f of await readdir(zDir, { withFileTypes: true })) if (f.isDirectory() && (!keep.has(f.name) || !zByAgs.has(f.name))) await rm(path.join(zDir, f.name), { recursive: true, force: true });
  log(`Gebiet: ${nArea} Gemeinden, ${nZone} Zonen-Dateien, Umsatz-Tag ${day || '–'}, ${(bytes / 1e6).toFixed(1)} MB, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return { nArea, nZone, day };
}
