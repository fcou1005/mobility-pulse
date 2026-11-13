// Sammler, Phase „gebiet“ (S3.8 Rest): Dateien je Gemeinde für die Disposition aus dem fertigen Datenstand (scripts/gebiet.mjs):
// ops-input/cells/<AGS>.json (Zellen spaltenweise), latest-core.json, ops-input/area/<AGS>.json (Umsatz-Eingabe, Gruppen-Ereignisse, Zonen je Anbieter), ops-input/zones/<AGS>/<n>.json.
// Nach „kalibrierung“ (calib.json) und „grenzen“; Fehler hier halten den Lauf nicht an (die Seite fällt auf die großen Dateien zurück).
import * as C from '../../lib/pulse-core.js';
import { writeArea, writeCellsCompact } from '../gebiet.mjs';

export async function run(ctx) {
  const { DATA, log } = ctx;
  try {
    await writeCellsCompact(DATA, { log });
    const bbox = new Map(); for (const ft of ctx.boundaries?.features || []) if (ft.properties?.ags) bbox.set(ft.properties.ags, C.geomBounds(ft.geometry));
    await writeArea(DATA, { bbox: bbox.size ? bbox : null, log });
  } catch (e) { log(`Gebiet: ${e.message}`); }
}
