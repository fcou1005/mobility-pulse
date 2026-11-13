// Sammler, Phase „alarme“ (S5.2, F3): Ereignisse je Gemeinde aus dem Vergleich mit dem vorigen Lauf (lib/pulse-alarme.js) → auflagen/alarme.json
// und Atom-Feeds feeds/<AGS>.xml (alle Themen) und feeds/<AGS>-<Thema>.xml. Feeds werden nur neu geschrieben, wenn sich ihr Inhalt ändert.
// Optional Push über ntfy (NTFY_TOPIC, z. B. aus einer Repository-Variable im Workflow): höchstens 20 neue Alarme je Lauf.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as AL from '../../lib/pulse-alarme.js';
import * as SV from '../../lib/pulse-schema.js';

const BASE = 'https://fcou1005.github.io/mobility-pulse/', DATA_BASE = 'https://raw.githubusercontent.com/fcou1005/mobility-pulse/data/';

export async function run(ctx) {
  const { DATA, latest, log, now } = ctx;
  try {
    const rd = async (f) => (existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : null);
    const logFile = path.join(DATA, 'auflagen', 'alarme.json');
    const prev = await rd(logFile).catch(() => null);
    const pricing = await rd(path.join(DATA, 'pricing.json')).catch(() => null);
    const munis = latest?.municipalities || {};
    const name = (ags) => munis[ags]?.name || ags;
    const cur = AL.snapshot({ latest, caps: ctx.caps || null, pricing });
    const fresh = AL.detect(prev?.state || null, cur, { now, muniName: name });
    const doc = SV.withSchema('auflagen', AL.updateLog(prev, fresh, { now, state: cur }));
    await mkdir(path.join(DATA, 'auflagen'), { recursive: true });
    await writeFile(logFile, JSON.stringify(doc));
    if (fresh.length) log(`Alarme: ${fresh.length} neu (${AL.KINDS.map(k => [k, fresh.filter(x => x.kind === k).length]).filter(x => x[1]).map(([k, n]) => `${AL.KIND_DE[k]} ${n}`).join(', ')})`);
    // Feeds je Gemeinde mit mindestens einer Quelle; „since“ = erster Lauf mit Feeds (fester Wert, damit leere Feeds stabil bleiben)
    await mkdir(path.join(DATA, 'feeds'), { recursive: true });
    const since = prev?.feedsSince || now; doc.feedsSince = since; await writeFile(logFile, JSON.stringify(doc));
    const agsList = [...new Set((latest?.sources || []).filter(r => !r.candidate && !['duplicate', 'retired'].includes(r.status)).flatMap(r => r.municipalities || []))].filter(a => /^\d{8}$/.test(a)).sort();
    let written = 0;
    for (const ags of agsList) for (const kind of [null, ...AL.KINDS]) {
      const f = path.join(DATA, 'feeds', `${ags}${kind ? `-${kind}` : ''}.xml`);
      const xml = AL.atomFeed({ ags, name: name(ags), kind, items: doc.items, base: BASE, dataBase: DATA_BASE, since });
      if (existsSync(f) && (await readFile(f, 'utf8')) === xml) continue;
      await writeFile(f, xml); written++;
    }
    await writeFile(path.join(DATA, 'feeds', 'index.json'), JSON.stringify({ at: since, kinds: AL.KINDS, municipalities: agsList }));
    if (written) log(`Feeds: ${written} geschrieben (${agsList.length} Gemeinden × ${AL.KINDS.length + 1})`);
    // Push über ntfy (frei, ohne Konto): nur wenn ein Thema gesetzt ist
    const topic = process.env.NTFY_TOPIC;
    if (topic && fresh.length) for (const x of fresh.slice(0, 20)) {
      await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, { method: 'POST', body: x.text, headers: { Title: x.title, Tags: x.kind, Priority: x.level === 'bad' ? '4' : '3', Click: `${BASE}?scope=${x.ags}#stadt` }, signal: AbortSignal.timeout(8000) }).catch(e => log(`ntfy: ${e.message}`));
    }
  } catch (e) { log(`Alarme: ${e.message}`); }
}
