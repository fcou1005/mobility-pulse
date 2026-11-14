// Geo-Lauf, S8.1: Zensus 2022 (100-m-Gitter) → pop/<Land>.json (Punkte und 250-m-Zellen je aktiver Gemeinde), pop/index.json (Abgleich VG250-EW)
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import * as P from '../../lib/pulse-geo-pop.js';
import { download, zipNames, zipLines } from './common.mjs';

export async function runZensus({ OUT, TMP, bounds, log, now }) {
  const t0 = Date.now(), zip = path.join(TMP, 'zensus.zip');
  const url = process.env.GEO_ZENSUS_URL || P.ZENSUS.url, dl = await download(url, zip);
  const member = zipNames(zip).find(n => P.ZENSUS.member.test(n)); if (!member) throw new Error('Zensus: keine 100-m-CSV im ZIP');
  log(`Zensus: ${(dl.bytes / 1e6).toFixed(1)} MB, Eintrag ${member}`);
  const locate = P.muniLocator(bounds.features), acc = P.popAccumulator(locate); let ix = null, bad = 0;
  // Die CSV der Statistikämter ist meist UTF-8, ältere Fassungen Latin-1; Kopf und Zahlen sind ASCII
  await zipLines(zip, member, (line, n) => { if (n === 0) { ix = P.censusHeader(line); return; } const r = P.censusRow(line, ix); if (r) acc.add(r); else bad++; });
  const res = acc.result();
  await mkdir(path.join(OUT, 'pop'), { recursive: true });
  for (const [st, list] of Object.entries(bounds.byState)) {
    const ags = {}; for (const a of list) { const v = res.by.get(a); if (v) ags[a] = P.packAgs(v); }
    await writeFile(path.join(OUT, 'pop', `${st}.json`), JSON.stringify({ schemaVersion: '1.0', state: st, at: now, attribution: P.ZENSUS.attribution, license: P.ZENSUS.license, fields: ['dLat·1e5', 'dLon·1e5', 'Einwohner'], cellFields: ['zelle', 'einwohner'], ags }));
  }
  const sum = P.popSummary(res.by, bounds.features);
  const doc = { schemaVersion: '1.0', at: now, source: url, attribution: P.ZENSUS.attribution, license: P.ZENSUS.license, member, bytes: dl.bytes, lastModified: dl.lastModified,
    rows: res.rows, skipped: bad, ewGermany: res.ewAll, ewInActive: res.ewIn, maxDev: sum.maxDev, n: sum.n, within: sum.within, share: sum.share, worst: sum.worst,
    ags: Object.fromEntries(sum.rows.map(r => [r.ags, [r.zensus, r.vg250, Math.round(r.dev * 10000) / 10000]])), agsFields: ['zensus', 'vg250', 'abweichung'] };
  await writeFile(path.join(OUT, 'pop', 'index.json'), JSON.stringify(doc));
  log(`Zensus: ${res.rows} Zellen, ${Math.round(res.ewAll)} Einwohner, davon ${Math.round(res.ewIn)} in ${res.by.size} aktiven Gemeinden, ${res.split} Grenzzellen anteilig; ${sum.within} von ${sum.n} Gemeinden innerhalb ±${sum.maxDev * 100} % zu VG250-EW (${(Date.now() - t0) / 1000} s)`);
  return { by: res.by, summary: sum };
}
