// Sammler, Phase „obergrenzen“ (S3.9: aus scripts/collect.mjs geschnitten; Ablauf und Zeitmessung in scripts/collect.mjs).
// ctx trägt, was Phasen voneinander brauchen; let-Werte stehen nur in ctx, Konstanten und Funktionen werden hier ausgepackt.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as R from '../../lib/pulse-report.js';

export async function run(ctx) {
  const { DATA, ROOT, groupsOut, log, now, prev } = ctx;
  // Obergrenzen je Lauf prüfen (Gemeinden mit Eintrag in reference.json → obergrenzen, liegt auf main im Checkout): Läufe ab 90 % der Grenze
  // gesamt und je Anbieter, dazu je Tag das Maximum; 30 Tage (caps-log.json, Format in lib/pulse-report.js capsLogUpdate)
  try {
    const refFile = process.env.REFERENCE_FILE || path.join(ROOT, 'data', 'reference.json');
    const ref = existsSync(refFile) ? JSON.parse(await readFile(refFile, 'utf8')) : null;
    if (ref?.obergrenzen?.length) {
      const f = path.join(DATA, 'caps-log.json');
      const prevLog = existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : null;
      const caps = R.capsCheck(ref, groupsOut, { ags: 'DE', asOf: now });
      ctx.caps = caps; // S5.2: Alarme vergleichen den Status mit dem vorigen Lauf
      const doc = R.capsLogUpdate(prevLog, caps, { at: now, dt: prev?.at ? now - prev.at : null, days: 30 });
      await writeFile(f, JSON.stringify(doc));
      const over = caps.flatMap(c => [c, ...c.operators].filter(x => x.status === 'over').map(x => `${c.ort}${x.op ? ` ${x.op}` : ''} ${x.total}/${x.limit}`));
      if (over.length) log(`Obergrenzen überschritten: ${over.join(', ')}`);
    }
  } catch (e) { log(`Obergrenzen-Protokoll: ${e.message}`); }
  // Zonen-Beobachtung: vermutete Umrisse aus data/zonen-vermutet.json (ZONES_FILE, leer = keine) und optional privat aus ZONE_WATCH;
  // Bestand je Zone × Anbieter × Art → zone-watch.json (Läufe 2 Tage, Tageswerte 30 Tage; Format in lib/pulse-report.js zoneLogUpdate)
  const zonesFile = process.env.ZONES_FILE ?? path.join(ROOT, 'data', 'zonen-vermutet.json');
  ctx.zonesFile = zonesFile;
}
