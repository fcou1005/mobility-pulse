// Sammler, Phase „baustellen“ (S3.9: aus scripts/collect.mjs geschnitten; Ablauf und Zeitmessung in scripts/collect.mjs).
// ctx trägt, was Phasen voneinander brauchen; let-Werte stehen nur in ctx, Konstanten und Funktionen werden hier ausgepackt.
import * as C from '../../lib/pulse-core.js';
import * as T from '../../lib/pulse-track.js';
import * as CX from '../../lib/pulse-context.js';

export async function run(ctx) {
  const { fetchJson, incidentDocs, log, now, writeIncidents } = ctx;
  // Baustellen und Sperrungen in Städten (lib/pulse-context.js WORKS_SOURCES: MobiData BW, Hamburg, München; dl-de/by-2.0): einmal je Ortsstunde,
  // frische Vollsperrungen je Gemeinde → incidents/<Tag>.json ags[].works. Nur gesammelt (nicht in CTX_KEYS), keine Wirkung auf die Prognose.
  // WORKS=0 = aus (Fixture-Test).
  if (process.env.WORKS !== '0' && ctx.index) {
    try {
      const docs = await incidentDocs([T.dayOf(now)]), doc = docs.get(T.dayOf(now)), last = Date.parse(doc.sources?.works?.at || 0);
      if (!(Number.isFinite(last) && T.dayOf(last) === T.dayOf(now) && T.hourOf(last) === T.hourOf(now))) {
        const stats = {}, items = [];
        await Promise.all(CX.WORKS_SOURCES.map(async (src) => { const r = await fetchJson(src.url, { retry: 0 }); if (!r.ok) { stats[src.id] = { error: r.error || `HTTP ${r.status}` }; return; } const w = CX.worksItems(src, r.json, now); stats[src.id] = w.stat; items.push(...w.items); }));
        const n = CX.addWorks(docs, items, (lat, lon) => C.assignMunicipality(ctx.index, lat, lon)?.ags ?? null, now);
        doc.sources.works = { at: new Date(now).toISOString(), items: items.length, src: stats };
        await writeIncidents(docs);
        log(`Baustellen (Städte): ${Object.entries(stats).map(([k, v]) => `${k} ${v.error ? `Fehler (${v.error})` : `${v.fresh}/${v.closed} frische Vollsperrungen von ${v.features}`}`).join(', ')} · ${n} Gemeinden`);
      }
    } catch (e) { log(`Baustellen: ${e.message} – übersprungen`); }
  }
}
