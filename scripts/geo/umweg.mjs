// Geo-Lauf, S8.6: Umwegfaktor je bewohnter 100-m-Zelle für die größten Flottenstädte → umweg/<AGS>.json, umweg/index.json.
// Fußwegnetz aus Overpass je Stadtrahmen; drei Stichproben je Stadt gegen den Fußgänger-Router von FOSSGIS (routing.openstreetmap.de).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as N from '../../lib/pulse-geo-net.js';
import { unpackPts } from '../../lib/pulse-geo-pop.js';
import { bboxOf } from '../../lib/pulse-zones-geo.js';
import { UA, sleep } from './common.mjs';

export const UMWEG = Object.freeze({ cities: +(process.env.GEO_UMWEG_CITIES || 30), overpass: process.env.GEO_OVERPASS || 'https://overpass-api.de/api/interpreter', router: process.env.GEO_ROUTER || 'https://routing.openstreetmap.de/routed-foot/route/v1/foot', budgetMin: 150, maxDev: 0.15, pauseMs: +(process.env.GEO_PAUSE_MS ?? 10e3) });

async function overpass(q) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(UMWEG.overpass, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA }, body: `data=${encodeURIComponent(q)}`, signal: AbortSignal.timeout(400e3) }).catch(e => ({ ok: false, status: e.message }));
    if (r.ok) return /** @type {Response} */ (r).json();
    await sleep(30e3 * (i + 1));
  }
  throw new Error('Overpass nicht erreichbar');
}
async function routerDist(a, b) {
  const r = await fetch(`${UMWEG.router}/${a[1]},${a[0]};${b[1]},${b[0]}?overview=false`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30e3) }).catch(() => null);
  if (!r?.ok) return null; const j = await r.json().catch(() => null); return j?.routes?.[0]?.distance ?? null;
}

export async function runUmweg({ OUT, bounds, log, now, top }) {
  const t0 = Date.now(), dir = path.join(OUT, 'umweg'); await mkdir(dir, { recursive: true });
  const feat = new Map(bounds.features.map(f => [f.properties.ags, f])), idx = {}, popCache = {};
  for (const [ags, fleet, name] of top.slice(0, UMWEG.cities)) {
    if ((Date.now() - t0) / 60e3 > UMWEG.budgetMin) { log(`Umweg: Zeitbudget erreicht vor ${name}`); break; }
    const f = feat.get(ags), st = bounds.stateOf.get(ags); if (!f || !st) continue;
    const pf = path.join(OUT, 'pop', `${st}.json`); if (!existsSync(pf)) { log(`Umweg ${name}: keine Zensus-Datei`); continue; }
    popCache[st] ??= JSON.parse(await readFile(pf, 'utf8'));
    const pa = popCache[st].ags?.[ags]; if (!pa) continue;
    try {
      const t1 = Date.now(), bb = bboxOf(f.geometry), json = await overpass(N.overpassFoot([bb[1], bb[0], bb[3], bb[2]]));
      const g = N.buildGraph(json), pts = unpackPts(pa.pts), res = N.detourFactors(g, pts);
      // Stichproben gegen den Router: drei Paare aus bewohnten Zellen in 400–900 m Abstand. Der Router bekommt die Netzknoten, an die wir
      // die Zellmitten angebunden haben – sonst misst er von einem anderen Punkt aus (Zellmitte im Park, im Hof) und die Abweichung zeigt den Anbindepunkt statt des Netzes
      const samples = [];
      for (let k = 0; k < pts.length && samples.length < 3; k += Math.max(1, Math.floor(pts.length / 7))) {
        const a = pts[k], b = pts.find(p => { const d = Math.hypot((p[0] - a[0]) * 111320, (p[1] - a[1]) * 111320 * Math.cos(a[0] * Math.PI / 180)); return d > 400 && d < 900; }); if (!b) continue;
        const np = N.netPath(g, a, b); if (!np) continue;
        const ext = await routerDist(np.from, np.to); await sleep(Math.min(1100, UMWEG.pauseMs));
        const r5 = (p) => p.map(v => Math.round(v * 1e5) / 1e5);
        if (ext != null) samples.push({ a: r5(np.from), b: r5(np.to), ours: Math.round(np.d), router: Math.round(ext), dev: Math.round((np.d / ext - 1) * 1000) / 1000, snap: [Math.round(np.snapA), Math.round(np.snapB)] });
      }
      idx[ags] = { name, fleet, nodes: g.n, cells: res.n, median: res.median, p90: res.p90, over15: res.over15, sampled: res.sampled, samples, samplesOk: samples.filter(s => Math.abs(s.dev) <= UMWEG.maxDev).length, s: Math.round((Date.now() - t1) / 1000) };
      await writeFile(path.join(dir, `${ags}.json`), JSON.stringify({ schemaVersion: '1.1', ags, at: now, attribution: '© OpenStreetMap-Mitwirkende (ODbL); Zensus 2022 © Destatis', fields: ['lat', 'lon', 'faktor', 'ziele'], rows: res.cells.map(([la, lo, fa, n]) => [Math.round(la * 1e5) / 1e5, Math.round(lo * 1e5) / 1e5, fa, n]), median: res.median, p90: res.p90, over15: res.over15, sampled: res.sampled, samples }));
      log(`Umweg ${name}: ${g.n} Knoten, ${res.n} Zellen, Median ${res.median?.toFixed(2)}, Stichproben ${samples.map(s => `${(s.dev * 100).toFixed(0)} %`).join('/')} (${idx[ags].s} s)`);
      await sleep(UMWEG.pauseMs); // Overpass schonen
    } catch (e) { log(`Umweg ${name}: ${e.message}`); idx[ags] = { name, fleet, error: e.message }; }
  }
  await writeFile(path.join(dir, 'index.json'), JSON.stringify({ schemaVersion: '1.1', at: now, maxDev: UMWEG.maxDev, router: UMWEG.router, samplePoints: 'netzknoten', cities: idx }));
}
