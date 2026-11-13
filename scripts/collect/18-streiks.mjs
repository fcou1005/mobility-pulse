// Sammler, Phase „streiks“ (S3.9: aus scripts/collect.mjs geschnitten; Ablauf und Zeitmessung in scripts/collect.mjs).
// ctx trägt, was Phasen voneinander brauchen; let-Werte stehen nur in ctx, Konstanten und Funktionen werden hier ausgepackt.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as CX from '../../lib/pulse-context.js';
import * as ST from '../../lib/pulse-strike.js';

export async function run(ctx) {
  const { DATA, ROOT, fetchJson, log, munis, now } = ctx;
  // Streiks automatisch erkennen (lib/pulse-strike.js): Nachrichtensuche der tagesschau-App (frei, ohne Schlüssel; Regionalmeldungen der ARD-Anstalten
  // eingeschlossen), höchstens alle STRIKE.refreshMin Minuten, je Lauf etwa 12–25 Abrufe (die App erlaubt 60 je Stunde), vollständiger Text nur für
  // neue Streik-Meldungen (höchstens maxDetails) → streiks.json: nur abgeleitete Angaben (Art, Tage, Gebiet, erkannte Orte/Betriebe) und Link, keine
  // Meldungstexte. Sichere Erkennungen (Tag und Gebiet) wirken in der Prognose sofort wie Streiks der gepflegten Liste; Doppel zu ihr fallen weg.
  // Erkanntes bleibt 60 Tage (Training). STRIKE_URL leer = aus.
  ctx.strikeAuto = [];
  {
    const sf = path.join(DATA, 'streiks.json'), base = process.env.STRIKE_URL ?? ST.STRIKE.base;
    try {
      const prev = existsSync(sf) ? JSON.parse(await readFile(sf, 'utf8')) : null;
      let doc = prev ? { erkannt: prev.erkannt || [], hinweise: prev.hinweise || [] } : { erkannt: [], hinweise: [] }, stats = prev?.abruf || null;
      if (base && !(prev?.abgerufen && now - prev.abgerufen < ST.STRIKE.refreshMin * 60e3 && prev.v === ST.STRIKE.version)) { // neuer Auswertungsstand: sofort
        const feats = (ctx.boundaries?.features || []).filter(f => munis.has(f.properties?.ags));
        const places = ST.strikePlaces(feats, JSON.parse(await readFile(path.join(ROOT, 'data', 'streik-betriebe.json'), 'utf8')));
        const items = new Map(), since = Math.max(now - ST.STRIKE.maxAgeDays * 86400e3, prev?.abgerufen ? prev.abgerufen - 6 * 3600e3 : 0), errors = [];
        let calls = 0, details = 0;
        for (const q of ST.STRIKE.queries) for (let p = 0; p < ST.STRIKE.maxPages; p++) {
          const r = await fetchJson(ST.strikeSearchUrl(q, p, base)); calls++;
          if (!r.ok) { errors.push(`${q}: ${r.error || `HTTP ${r.status}`}`); break; }
          const list = ST.searchItems(r.json);
          for (const it of list) { const k = it.shareURL || it.details || it.title; if (k && !items.has(k) && (Date.parse(it.date) || 0) >= now - ST.STRIKE.maxAgeDays * 86400e3) items.set(k, it); }
          if (list.length < ST.STRIKE.pageSize || Math.min(...list.map(x => Date.parse(x.date) || now)) < since) break; // neueste zuerst: weiter nur bis zum letzten Abruf
        }
        // schon ausgewertete Meldungen (gleicher Link, gleicher Stand) nicht erneut abrufen
        const known = new Map([...doc.erkannt, ...doc.hinweise].filter(c => c.link).map(c => [c.link, c])), cands = [];
        for (const it of items.values()) {
          const link = it.shareURL || it.detailsweb || null, old = link && known.get(link), at = new Date(Date.parse(it.date) || now).toISOString();
          if (old && old.at === at && (old.v || 1) === ST.STRIKE.version && (old.det || !ST.strikeLead(it) || !ST.detailUrlOk(it.details))) continue;
          let full = it, det = false;
          if (ST.strikeLead(it) && ST.detailUrlOk(it.details) && details < ST.STRIKE.maxDetails) {
            const r = await fetchJson(it.details); calls++; details++;
            if (r.ok && Array.isArray(r.json?.content)) { full = { ...it, content: r.json.content, regionIds: r.json.regionIds ?? it.regionIds }; det = true; }
          }
          const c = ST.strikeFromItem(full, places, { now }); if (c) cands.push({ ...c, v: ST.STRIKE.version, ...(det ? { det: true } : {}) });
        }
        doc = ST.mergeStrikes(doc, cands, { now });
        stats = { at: now, abrufe: calls, volltexte: details, meldungen: items.size, neu: cands.length, ...(errors.length ? { fehler: errors.slice(0, 5) } : {}) };
        if (errors.length) log(`Streik-Erkennung: ${errors.length} Abfragen ohne Antwort (${errors.slice(0, 2).join('; ')})`);
        await writeFile(sf, JSON.stringify({ version: 1, v: ST.STRIKE.version, at: now, abgerufen: errors.length >= ST.STRIKE.queries.length ? prev?.abgerufen ?? null : now,
          quelle: 'Nachrichtensuche der tagesschau-App (https://www.tagesschau.de/api2u/search/), ausgewertet im Sammler; gespeichert nur abgeleitete Angaben und der Link zur Meldung',
          felder: 'art, tage (Ortstage), gebiet (DE | {laender} | {ags}), sicher (Tag und Gebiet erkannt, nicht abgesagt), aus (Absage/Einigung), sammel (Sammelmeldung), grund (erkannte Orte/Betriebe), link, at (Meldung), det (Volltext ausgewertet), teile (Gemeinden mit eigenen Tagen), v (Stand der Auswertung)',
          abruf: stats, erkannt: doc.erkannt, hinweise: doc.hinweise }));
      }
      const curStrikes = CX.checkCurated(existsSync(path.join(ROOT, 'data', 'ereignisse.json')) ? JSON.parse(await readFile(path.join(ROOT, 'data', 'ereignisse.json'), 'utf8')) : null).ok.filter(e => String(e.art).startsWith('streik'));
      ctx.strikeAuto = CX.checkCurated({ ereignisse: ST.strikeEntries(doc, curStrikes) }).ok;
      log(`Streik-Erkennung: ${doc.erkannt.length} erkannt, ${doc.hinweise.length} Hinweise, ${ctx.strikeAuto.length} für die Prognose${stats?.at === now ? ` (${stats.abrufe} Abrufe, ${stats.meldungen} Meldungen, ${stats.volltexte} Volltexte)` : ''}`);
    } catch (e) { log(`Streik-Erkennung: ${e?.message || e}`); }
  }
  // Prognose-Engine (lib/pulse-forecast.js): je Fahrzeugfamilie ein gepooltes Modell über alle Anbieter und Gemeinden (micro → forecast/,
  // E-Roller → forecast/moped/, Carsharing → forecast/car/, gleiche Dateien je Ordner), Selbstprüfung per Rolling Origin (ein Tag voraus)
  // und Live-Abgleich ausgegebener Prognosen mit der Realität → forecast/latest.json (nächste 24 Stunden) und forecast/log.json. Höchstens alle
  // FORECAST_EVERY_MIN Minuten (Standard 60); FORECAST=0 = aus. Bei Fehler bleiben die alten Dateien.
  // forecast/series.json: Stundenreihen fürs Dashboard (Plan heute eingefroren, Ist, Live-Prognose bis Ende morgen, je Anbieter, Art, Gemeinde und große Gruppe).
  ctx.trainCtx = null; // Einträge, die in diesem Lauf in der Prognose wirken bzw. zurückgehalten sind (fürs Trainingsarchiv, unten)
}
