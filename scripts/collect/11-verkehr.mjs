// Sammler, Phase „verkehr“ (S3.9: aus scripts/collect.mjs geschnitten; Ablauf und Zeitmessung in scripts/collect.mjs).
// ctx trägt, was Phasen voneinander brauchen; let-Werte stehen nur in ctx, Konstanten und Funktionen werden hier ausgepackt.
import * as C from '../../lib/pulse-core.js';
import * as T from '../../lib/pulse-track.js';
import * as CX from '../../lib/pulse-context.js';

export async function run(ctx) {
  const { fetchJson, incidentDocs, log, now, writeIncidents } = ctx;
  // Autobahn (verkehr.autobahn.de, Autobahn GmbH des Bundes): Sperrungen und Staus mit Koordinate → Gemeinde, eingetragen zur aktuellen Ortsstunde
  // in incidents/<Ortstag>.json (Merkmal „road“ der Prognose). Einmal je Ortsstunde (rund 220 Abrufe: Liste der Autobahnen, je Autobahn Sperrungen
  // und Verkehrsmeldungen), damit keine Stunde ohne Beobachtung bleibt; nur frische Sperrungen und Staus (CX.ROAD_FRESH), keine Dauer-Baustellen.
  // AUTOBAHN_URL leer = aus.
  // Gespeichert werden nur Gemeinde und Stunde, keine Meldungstexte.
  {
    const base = process.env.AUTOBAHN_URL ?? 'https://verkehr.autobahn.de/o/autobahn';
    if (base && ctx.index) {
      try {
        const docs = await incidentDocs([T.dayOf(now)]), doc = docs.get(T.dayOf(now)), last = Date.parse(doc.sources?.road?.at || 0);
        // Fassung 2 (6.11.2026 abends): Fassung 1 zählte auch monatelange Bauphasen – deren Kennzeichen des Tages einmal löschen
        if (doc.sources?.road && !(doc.sources.road.v >= 2)) { for (const a of Object.values(doc.ags)) delete a.road; doc.sources.road.v = 2; }
        if (!(now - last < 55 * 60e3) || !(Number.isFinite(last) && T.dayOf(last) === T.dayOf(now) && T.hourOf(last) === T.hourOf(now))) {
          const list = await fetchJson(`${base}/`, { retry: 0 }), roads = Array.isArray(list.json?.roads) ? list.json.roads.filter(r => /^A\d+$/.test(String(r).trim())).map(r => String(r).trim()) : [];
          if (!roads.length) log(`Autobahn: Liste nicht erreichbar${list.status ? ` (HTTP ${list.status})` : ''}`);
          else {
            const items = []; let fails = 0, done = 0; const until = Date.now() + 60e3; // höchstens 60 s je Lauf; Rest beim nächsten Mal
            const jobs = roads.flatMap(r => ['closure', 'warning'].map(sv => [r, sv]));
            for (let i = 0; i < jobs.length && Date.now() < until; i += 6) await Promise.all(jobs.slice(i, i + 6).map(async ([r, sv]) => {
              done++; const x = await fetchJson(`${base}/${encodeURIComponent(r)}/services/${sv}`, { retry: 0 }), arr = x.json?.[sv];
              if (!x.ok || !Array.isArray(arr)) { fails++; return; }
              for (const it of arr) { const v = CX.roadItem(it, sv, now); if (v) items.push(v); }
            }));
            const n = CX.addRoad(docs, items, (lat, lon) => C.assignMunicipality(ctx.index, lat, lon)?.ags ?? null, now);
            doc.sources.road = { v: 2, at: new Date(now).toISOString(), roads: roads.length, items: items.length, fails, ...(done < jobs.length ? { partial: +(done / jobs.length).toFixed(2) } : {}) };
            await writeIncidents(docs);
            log(`Autobahn: ${roads.length} Autobahnen, ${items.filter(x => x.kind === 'closure').length} Sperrungen, ${items.filter(x => x.kind === 'jam').length} Staus, ${n} Gemeinden betroffen${fails ? `, ${fails} Abrufe ohne Antwort` : ''}`);
          }
        }
      } catch (e) { log(`Autobahn: ${e.message} – übersprungen`); }
    }
  }
}
