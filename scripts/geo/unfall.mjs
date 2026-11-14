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
  const t0 = Date.now(), lastYear = new Date(now).getUTCFullYear() - 1, acc = U.unfallAccumulator(new Set(keep)), years = [], missing = [], files = {}, lands = new Map(); // Jahr → Land → Unfälle (alle Gemeinden)
  for (let y = U.UNFALL.from; y <= lastYear; y++) {
    let ok = false;
    for (const url of process.env.GEO_UNFALL_URL ? [process.env.GEO_UNFALL_URL.replace('{y}', String(y))] : U.UNFALL.urls(y)) {
      try {
        const zip = path.join(TMP, `unfall-${y}.zip`), dl = await download(url, zip, { timeoutMs: 10 * 60e3 });
        // CSV-Datei im ZIP: neuere Jahre .csv, ältere .txt (gleicher Inhalt, Semikolon); Beschreibungen und macOS-Reste nicht
        const names = zipNames(zip).filter(n => !/^__MACOSX|\/$/.test(n)), pick = (re) => names.find(n => re.test(n));
        const member = pick(/unfallorte[^/]*\.(csv|txt)$/i) || pick(/\.csv$/i) || pick(/\.txt$/i); if (!member) throw new Error(`keine CSV im ZIP (${names.slice(0, 6).join(', ')})`);
        let ix = null, rows = 0;
        await zipLines(zip, member, (line, n) => { if (n === 0) { ix = U.unfallHeader(line); return; } const r = U.unfallRow(line, ix); if (r) { rows++; acc.add(r); const lm = lands.get(y) || lands.set(y, new Map()).get(y), ld = r.ags.slice(0, 2); lm.set(ld, (lm.get(ld) || 0) + 1); } }, { encoding: 'latin1' });
        files[y] = { url, member, bytes: dl.bytes, rows }; years.push(y); ok = true; await rm(zip, { force: true });
        log(`Unfallatlas ${y}: ${rows} Unfälle (${(dl.bytes / 1e6).toFixed(1)} MB)`); break;
      } catch (e) { log(`Unfallatlas ${y}: ${url} – ${e.message}`); }
    }
    if (!ok) missing.push(y);
  }
  const by = acc.result(), dir = path.join(OUT, 'unfall'); await mkdir(dir, { recursive: true });
  const feat = new Map(bounds.features.map(f => [f.properties.ags, f])), idx = {}; let checks = 0, equal = 0, ovN = 0, ovOk = 0;
  // Frühe Jahre des Unfallatlas enthalten nicht alle Länder. Ein Land gilt in einem Jahr als erfasst, wenn es dort mindestens
  // ein Fünftel seines stärksten Jahres hat; sonst fehlt das Jahr für seine Gemeinden (statt als Jahr ohne Unfälle zu zählen)
  const peak = new Map(); for (const m of lands.values()) for (const [l, n] of m) peak.set(l, Math.max(peak.get(l) || 0, n));
  const covered = (y, land) => { const n = lands.get(y)?.get(land) || 0; return n > 0 && n >= 0.2 * (peak.get(land) || 0); };
  for (const [ags, a] of by) {
    const f = feat.get(ags); if (!f) continue;
    const yA = years.filter(y => covered(y, ags.slice(0, 2)));
    if (!yA.length) continue;
    const r = U.analyseAgs(universeOf(f), a, yA);
    checks++; if (r.cellSum === r.srcSum) equal++;
    if (r.overlap != null) { ovN++; if (r.overlap >= 0.7) ovOk++; }
    idx[ags] = { years: yA, sums: a.sums, hot: r.hot, hotA: r.hotA, hotB: r.hotB, both: r.both, overlap: r.overlap, cellSum: r.cellSum, srcSum: r.srcSum };
    await writeFile(path.join(dir, `${ags}.json`), JSON.stringify({ schemaVersion: '1.1', ags, at: now, years: yA, halves: r.halves, attribution: U.UNFALL.attribution, license: U.UNFALL.license,
      fields: ['zelle', ...U.UNFALL.cats, 'eb_alle_je_jahr', 'gi_z', 'schwerpunkt'], rows: r.cells, hot: r.hot, overlap: r.overlap, sums: a.sums }));
  }
  const landsByYear = Object.fromEntries(years.map(y => [y, [...(lands.get(y)?.keys() || [])].filter(l => covered(y, l)).sort()]));
  await writeFile(path.join(dir, 'index.json'), JSON.stringify({ schemaVersion: '1.1', at: now, years, missingYears: missing, landsByYear, files, attribution: U.UNFALL.attribution, license: U.UNFALL.license, cats: U.UNFALL.cats, q: U.UNFALL.q,
    checks: { municipalities: checks, sumsEqual: equal, overlapN: ovN, overlapAtLeast70: ovOk }, ags: idx }));
  const gaps = years.map(y => ({ y, l: [...peak.keys()].filter(l => !covered(y, l)).sort() })).filter(g => g.l.length).map(g => `${g.y} ohne Land ${g.l.join('/')}`);
  log(`Unfallatlas: ${years.length} Jahre (${missing.length ? `fehlen ${missing.join(', ')}` : 'alle'}${gaps.length ? `; ${gaps.join(', ')}` : ''}), ${checks} Gemeinden, Summen gleich ${equal}, Überlappung ≥ 70 % in ${ovOk} von ${ovN} (${(Date.now() - t0) / 1000} s)`);
  return { years, missing };
}
