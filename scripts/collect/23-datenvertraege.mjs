// Sammler, Phase „datenvertraege“ (S3.9: aus scripts/collect.mjs geschnitten; Ablauf und Zeitmessung in scripts/collect.mjs).
// ctx trägt, was Phasen voneinander brauchen; let-Werte stehen nur in ctx, Konstanten und Funktionen werden hier ausgepackt.
import { readFile, writeFile, readdir, open } from 'node:fs/promises';
import path from 'node:path';
import * as SV from '../../lib/pulse-schema.js';

export async function run(ctx) {
  const { DATA, log } = ctx;
  // S3.7: Dateien der Vertragsfamilien (lib/pulse-schema.js), die noch ohne schemaVersion im Datenzweig liegen (frühere Tage, seltener
  // geschriebene Dateien), einmalig nachstempeln. Danach kostet die Prüfung je Datei 40 gelesene Bytes.
  {
    let n = 0; const head = Buffer.alloc(40);
    try {
      const rels = (await readdir(DATA, { recursive: true })).map(String).filter(f => f.endsWith('.json') && SV.familyOf(f.split(path.sep).join('/')));
      for (const rel of rels) {
        const f = path.join(DATA, rel), fh = await open(f); let got = 0;
        try { ({ bytesRead: got } = await fh.read(head, 0, head.length, 0)); } finally { await fh.close(); }
        if (/^\{\s*"schemaVersion"/.test(head.toString('utf8', 0, got))) continue;
        const doc = JSON.parse(await readFile(f, 'utf8')); if (!doc || typeof doc !== 'object' || Array.isArray(doc)) continue;
        await writeFile(f, JSON.stringify(SV.withSchema(SV.familyOf(rel.split(path.sep).join('/')).family, doc))); n++;
      }
      if (n) log(`Datenverträge: ${n} ältere Dateien mit schemaVersion versehen`);
    } catch (e) { log(`Datenverträge: ${e.message}`); }
  }
}
