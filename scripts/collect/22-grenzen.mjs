// Sammler, Phase „grenzen“ (S3.9: aus scripts/collect.mjs geschnitten; Ablauf und Zeitmessung in scripts/collect.mjs).
// ctx trägt, was Phasen voneinander brauchen; let-Werte stehen nur in ctx, Konstanten und Funktionen werden hier ausgepackt.
import { writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import * as C from '../../lib/pulse-core.js';
import * as SV from '../../lib/pulse-schema.js';

export async function run(ctx) {
  const { DATA, latest, log, munis } = ctx;
  // Aktive Gemeindegrenzen fürs Dashboard
  if (ctx.boundaries) {
    const activeAgs = new Set(munis.keys());
    const feats = ctx.boundaries.features.filter(f => activeAgs.has(f.properties.ags));
    await writeFile(path.join(DATA, 'boundaries-active.json'), JSON.stringify({ type: 'FeatureCollection', attribution: ctx.boundaries.attribution, license: ctx.boundaries.license, generatedAt: latest.generatedAt, features: feats }));
    // je Bundesland (Q-6): boundaries/<Land>.json mit bbox je Gemeinde [minLon, minLat, maxLon, maxLat], dazu boundaries/index.json; Altdatei bleibt
    try {
      const bDir = path.join(DATA, 'boundaries'); await mkdir(bDir, { recursive: true });
      const byState = new Map();
      for (const f of feats) { const st = f.properties?.state || 'XX'; if (!byState.has(st)) byState.set(st, []); byState.get(st).push({ ...f, bbox: C.geomBounds(f.geometry) }); }
      for (const f of await readdir(bDir)) if (/^[A-Z]{2}\.json$/.test(f) && !byState.has(f.slice(0, 2))) await rm(path.join(bDir, f));
      const states = {};
      for (const [st, list] of [...byState].sort((a, b) => a[0].localeCompare(b[0]))) {
        const doc = JSON.stringify({ schemaVersion: SV.SCHEMA.boundaries, type: 'FeatureCollection', state: st, attribution: ctx.boundaries.attribution, license: ctx.boundaries.license, generatedAt: latest.generatedAt, features: list });
        await writeFile(path.join(bDir, `${st}.json`), doc);
        const bb = list.map(f => f.bbox).filter(Boolean);
        states[st] = { features: list.length, bytes: doc.length, bbox: bb.length ? [Math.min(...bb.map(b => b[0])), Math.min(...bb.map(b => b[1])), Math.max(...bb.map(b => b[2])), Math.max(...bb.map(b => b[3]))] : null, ags: list.map(f => f.properties.ags) };
      }
      await writeFile(path.join(bDir, 'index.json'), JSON.stringify({ schemaVersion: SV.SCHEMA.boundaries, version: 1, generatedAt: latest.generatedAt, attribution: ctx.boundaries.attribution, license: ctx.boundaries.license, bboxFields: 'minLon,minLat,maxLon,maxLat', states }));
    } catch (e) { log(`Grenzen je Land: ${e.message}`); }
    log(`Aktive Gemeinden: ${feats.length}`);
  }
}
