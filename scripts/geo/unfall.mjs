// Geo-Lauf, S8.3: Unfallatlas je Jahr → unfall/<AGS>.json (Zellen, Schwerpunkte) und unfall/index.json (Summen je Jahr, Abgleich, Überlappung)
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import * as U from '../../lib/pulse-geo-unfall.js';
import { bboxOf, contains } from '../../lib/pulse-zones-geo.js';
import { CELL_LAT, CELL_LON } from '../../lib/pulse-track-rules.js';
import { download, zipNames, zipLines } from './common.mjs';

/** Zellen (250 m), deren Mitte in der Gemeinde liegt */
export function universeOf(feature) {
  const g = feature.geometry, bb = bboxOf(g), out = [];
  for (let i = Math.round(bb[1] / CELL_LAT); i <= Math.round(bb[3] / CELL_LAT); i++) for (let j = Math.round(bb[0] / CELL_LON); j <= Math.round(bb[2] / CELL_LON); j++) if (contains(g, j * CELL_LON, i * CELL_LAT)) out.push(`${i}:${j}`);
  return out;
}

export async function runUnfall({ OUT, TMP, bounds, log, now, keep }) {
  const t0 = Date.now(), lastYear = new Date(now).getUTCFullYear() - 1, acc = U.unfallAccumulator(new Set(keep)), years = [], missing = [], files = {};
  for (let y = U.UNFALL.from; y <= lastYear; y++) {
    let ok = false;
    for (const url of process.env.GEO_UNFALL_URL ? [process.env.GEO_UNFALL_URL.replace('{y}', String(y))] : U.UNFALL.urls(y)) {
      try {
        const zip = path.join(TMP, `unfall-${y}.zip`), dl = await download(url, zip, { timeoutMs: 10 * 60e3 });
        const member = zipNames(zip).find(n => /\.csv$/i.test(n) && !/^__MACOSX/.test(n)); if (!member) throw new Error('keine CSV im ZIP');
        let ix = null, rows = 0;
        await zipLines(zip, member, (line, n) => { if (n === 0) { ix = U.unfallHeader(line); return; } const r = U.unfallRow(line, ix); if (r) { rows++; acc.add(r); } }, { encoding: 'latin1' });
        files[y] = { url, member, bytes: dl.bytes, rows }; years.push(y); ok = true; await rm(zip, { force: true });
        log(`Unfallatlas ${y}: ${rows} Unfälle (${(dl.bytes / 1e6).toFixed(1)} MB)`); break;
      } catch (e) { log(`Unfallatlas ${y}: ${url} – ${e.message}`); }
    }
    if (!ok) missing.push(y);
  }
  const by = acc.result(), dir = path.join(OUT, 'unfall'); await mkdir(dir, { recursive: true });
  const feat = new Map(bounds.features.map(f => [f.properties.ags, f])), idx = {}; let checks = 0, equal = 0, ovN = 0, ovOk = 0;
  for (const [ags, a] of by) {
    const f = feat.get(ags); if (!f) continue;
    const r = U.analyseAgs(universeOf(f), a, years);
    checks++; if (r.cellSum === r.srcSum) equal++;
    if (r.overlap != null) { ovN++; if (r.overlap >= 0.7) ovOk++; }
    idx[ags] = { sums: a.sums, hot: r.hot, hotA: r.hotA, hotB: r.hotB, both: r.both, overlap: r.overlap, cellSum: r.cellSum, srcSum: r.srcSum };
    await writeFile(path.join(dir, `${ags}.json`), JSON.stringify({ schemaVersion: '1.0', ags, at: now, years, halves: r.halves, attribution: U.UNFALL.attribution, license: U.UNFALL.license,
      fields: ['zelle', ...U.UNFALL.cats, 'eb_alle_je_jahr', 'gi_z', 'schwerpunkt'], rows: r.cells, hot: r.hot, overlap: r.overlap, sums: a.sums }));
  }
  await writeFile(path.join(dir, 'index.json'), JSON.stringify({ schemaVersion: '1.0', at: now, years, missingYears: missing, files, attribution: U.UNFALL.attribution, license: U.UNFALL.license, cats: U.UNFALL.cats, q: U.UNFALL.q,
    checks: { municipalities: checks, sumsEqual: equal, overlapN: ovN, overlapAtLeast70: ovOk }, ags: idx }));
  log(`Unfallatlas: ${years.length} Jahre (${missing.length ? `fehlen ${missing.join(', ')}` : 'alle'}), ${checks} Gemeinden, Summen gleich ${equal}, Überlappung ≥ 70 % in ${ovOk} von ${ovN} (${(Date.now() - t0) / 1000} s)`);
  return { years, missing };
}
