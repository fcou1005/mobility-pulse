// Sammler, Phase „zonen-beobachtung“ (S3.9: aus scripts/collect.mjs geschnitten; Ablauf und Zeitmessung in scripts/collect.mjs).
// ctx trägt, was Phasen voneinander brauchen; let-Werte stehen nur in ctx, Konstanten und Funktionen werden hier ausgepackt.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as R from '../../lib/pulse-report.js';

export async function run(ctx) {
  const { DATA, dv, groupsOut, log, now, zonesFile } = ctx;
  if ((zonesFile && existsSync(zonesFile)) || process.env.ZONE_WATCH) {
    try {
      const seen = new Set();
      const zones = [...(zonesFile && existsSync(zonesFile) ? R.parseZoneWatch(await readFile(zonesFile, 'utf8')) : []), ...R.parseZoneWatch(process.env.ZONE_WATCH || '')].filter(z => !seen.has(z.id) && seen.add(z.id));
      // Gemeinde der Zone (falls nicht angegeben): die häufigste Gemeinde der Fahrzeuge darin
      for (const z of zones) if (!z.ags) { const n = new Map(); for (const v of dv.vehicles) if (v.ags && Number.isFinite(v.lat) && R.zoneContains(z, v.lon, v.lat)) n.set(v.ags, (n.get(v.ags) || 0) + 1); z.ags = [...n].sort((a, b) => b[1] - a[1])[0]?.[0] || null; }
      if (zones.length) {
        const f = path.join(DATA, 'zone-watch.json');
        const prevZ = existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : null;
        const counts = R.zoneCounts(zones, dv.vehicles);
        const agsOf = new Map(zones.map(z => [z.id, z.ags]));
        const doc = R.zoneLogUpdate(prevZ, zones, counts, { at: now, carryZero: (zone, op, ty) => (groupsOut[`${agsOf.get(zone)}|${op}|${ty}`]?.total || 0) > 0 });
        await writeFile(f, JSON.stringify(doc));
        log(`Zonen-Beobachtung: ${zones.map(z => `${z.name} ${[...counts].filter(([k]) => k.startsWith(`${z.id}|`)).reduce((s, [, c]) => s + c[0], 0)}`).join(', ')}`);
      } else log('Zonen-Beobachtung: keine gültigen Umrisse');
    } catch (e) { log(`Zonen-Beobachtung: ${e.message}`); }
  }
}
