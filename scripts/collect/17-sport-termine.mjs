// Sammler, Phase „sport-termine“ (S3.9: aus scripts/collect.mjs geschnitten; Ablauf und Zeitmessung in scripts/collect.mjs).
// ctx trägt, was Phasen voneinander brauchen; let-Werte stehen nur in ctx, Konstanten und Funktionen werden hier ausgepackt.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as C from '../../lib/pulse-core.js';
import * as T from '../../lib/pulse-track.js';
import * as CX from '../../lib/pulse-context.js';

export async function run(ctx) {
  const { DATA, ROOT, UA, log, munis, now } = ctx;
  // Sport-Ereignisse (lib/pulse-context.js SPORT): Heimspiele 1.–3. Liga aus OpenLigaDB (ODbL), je Liga höchstens alle 6 h abgefragt; Spielorte aus
  // data/sport-spielorte.json → sport.json (kompakte Spiele im Fenster, Einträge wie data/ereignisse.json, Vereine ohne Spielort). In die Prognose
  // (Merkmal event) erst ab aktivAb – gesammelt wird vorher schon. Fällt OpenLigaDB aus, bleiben die zuletzt geholten Spiele. SPORT_URL leer = aus.
  ctx.sportCurated = []; ctx.sportPending = []; ctx.sportFrom = null; // Pending: gesammelt, aber erst ab aktivAb in der Prognose (nur gezählt)
  {
    const base = process.env.SPORT_URL ?? 'https://api.openligadb.de', sf = path.join(DATA, 'sport.json');
    try {
      const venues = JSON.parse(await readFile(process.env.SPORT_VENUES_FILE || path.join(ROOT, 'data', 'sport-spielorte.json'), 'utf8'));
      const prev = existsSync(sf) ? JSON.parse(await readFile(sf, 'utf8')) : null;
      let rows = Array.isArray(prev?.matches) ? prev.matches : []; const fetched = { ...(prev?.fetched || {}) };
      if (base) {
        const season = CX.sportSeason(now);
        for (const lg of CX.SPORT.leagues) {
          if (fetched[lg]?.at && now - fetched[lg].at < CX.SPORT.refreshH * 3600e3 && fetched[lg].season === season) continue;
          const ctrl = new AbortController(), tm = setTimeout(() => ctrl.abort(), 20e3);
          try {
            const r = await fetch(`${base}/getmatchdata/${lg}/${season}`, { headers: { 'User-Agent': UA, accept: 'application/json' }, signal: ctrl.signal });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const list = CX.compactMatches(await r.json(), lg);
            rows = [...rows.filter(x => x[1] !== lg), ...list]; fetched[lg] = { at: now, season, n: list.length };
          } catch (e) { fetched[lg] = { ...(fetched[lg] || {}), failedAt: now, error: String(e?.message || e).slice(0, 80) }; log(`Sport ${lg}: ${e?.message || e}`); } finally { clearTimeout(tm); }
        }
      }
      // nur das Fenster behalten, das die Prognose braucht (rückwärts Training und Gedächtnis, vorwärts Ansetzungen der nächsten Wochen)
      rows = rows.filter(x => x[2] >= now - CX.SPORT.pastDays * 86400e3 && x[2] <= now + CX.SPORT.keepAheadDays * 86400e3).sort((a, b) => a[2] - b[2] || String(a[0]).localeCompare(String(b[0])));
      const sp = CX.sportEntries(rows, venues, { now, resolve: CX.placeResolver(ctx.boundaries?.features), base: base || 'https://api.openligadb.de' });
      const activeFrom = Date.parse(venues.aktivAb ?? ''), active = !Number.isFinite(activeFrom) || now >= activeFrom;
      ctx.sportCurated = active ? CX.checkCurated({ ereignisse: sp.entries }).ok : []; ctx.sportPending = active ? [] : CX.checkCurated({ ereignisse: sp.entries }).ok; ctx.sportFrom = venues.aktivAb ?? null;
      await writeFile(sf, JSON.stringify({ version: 1, at: now, source: 'OpenLigaDB (https://www.openligadb.de), Open Database License (ODbL) 1.0', license: 'ODbL-1.0', leagues: CX.SPORT.leagues,
        window: { beforeMin: CX.SPORT.beforeMin, afterMin: CX.SPORT.afterMin, pastDays: CX.SPORT.pastDays, aheadDays: CX.SPORT.aheadDays }, activeFrom: venues.aktivAb ?? null, active, fetched,
        matchFields: ['id', 'liga', 'anstoss_utc_ms', 'heim', 'gast'], matches: rows, entries: sp.entries, unknown: sp.unknown, noAgs: sp.noAgs }));
      if (sp.unknown.length || sp.noAgs.length) log(`Sport: ohne Spielort ${sp.unknown.join(', ') || '–'} · ohne Gemeinde ${sp.noAgs.join(', ') || '–'}`);
      log(`Sport: ${rows.length} Spiele im Fenster, ${sp.entries.length} Heimspiele als Veranstaltung${active ? ' (in der Prognose)' : ` (in der Prognose ab ${venues.aktivAb})`}`);
    } catch (e) { log(`Sport: ${e.message}`); }
  }
  // Veranstaltungen an großen Orten (lib/pulse-context.js VENUES): Orte ab 5.000 Plätzen aus Wikidata (CC0, wöchentlich, Gemeinde über die Grenzen),
  // Termine aus den öffentlichen Programmseiten bzw. ICS-Kalendern der Orte (data/veranstaltungskalender.json; kein Konto, kein Schlüssel; robots.txt
  // wird beachtet; je Lauf höchstens VENUES.perRun Quellen, jede alle 6 h; bis ein Jahr voraus (alles, was die Seiten zeigen), 60 Tage behalten) → veranstaltungen.json (Liste mit Ort,
  // Adresse, Plätzen). In die Prognose wie data/ereignisse.json erst ab veranstaltungenAb. WIKIDATA_URL leer = keine Orte; KALENDER_FILE leer = keine Termine.
  ctx.venueCurated = [];
  {
    const vf = path.join(DATA, 'veranstaltungen.json');
    try {
      const prev = existsSync(vf) ? JSON.parse(await readFile(vf, 'utf8')) : null;
      let venues = Array.isArray(prev?.venues) ? prev.venues : [], venuesAt = prev?.venuesAt ?? null, rows = Array.isArray(prev?.events) && prev.version >= 2 ? prev.events : [];
      const fetched = { ...(prev?.version >= 2 ? prev.fetched || {} : {}) }, robots = { ...(prev?.robots || {}) }, V = CX.VENUES, wd = process.env.WIKIDATA_URL ?? 'https://query.wikidata.org/sparql';
      const get = async (url, ms, accept = 'application/json') => { const ctrl = new AbortController(), tm = setTimeout(() => ctrl.abort(), ms); try { return await fetch(url, { headers: { 'User-Agent': UA, accept }, signal: ctrl.signal, redirect: 'follow' }); } finally { clearTimeout(tm); } };
      if (wd && (!venuesAt || now - venuesAt > V.refreshDays * 86400e3)) {
        try {
          const r = await get(`${wd}?format=json&query=${encodeURIComponent(CX.wikidataVenueQuery())}`, 60e3); if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const list = CX.parseVenues(await r.json());
          if (list.length) { venues = list.map(v => ({ ...v, ags: ctx.index ? C.assignMunicipality(ctx.index, v.lat, v.lon)?.ags ?? null : null })); venuesAt = now; }
        } catch (e) { log(`Veranstaltungsorte (Wikidata): ${e?.message || e}`); }
      }
      const kf = process.env.KALENDER_FILE ?? path.join(ROOT, 'data', 'veranstaltungskalender.json');
      const srcs = kf && existsSync(kf) ? (JSON.parse(await readFile(kf, 'utf8')).quellen || []).filter(q => q?.url && (q.ort || q.orte)).map(q => ({ ...q, id: q.id || q.url, art: q.art === 'ics' ? 'ics' : 'seite' })) : [];
      const due = srcs.filter(q => !(now - (fetched[q.id]?.at || 0) < V.refreshH * 3600e3)).slice(0, V.perRun), t0 = Date.now(), lines = [];
      for (const q of due) {
        if (Date.now() - t0 > 60e3) break;
        const u = new URL(q.url), host = u.origin;
        try {
          if (!robots[host] || now - robots[host].at > 7 * 86400e3) { let txt = ''; try { const r = await get(`${host}/robots.txt`, 10e3, 'text/plain'); if (r.ok) txt = (await r.text()).slice(0, 20e3); } catch { /* ohne robots.txt: erlaubt */ } robots[host] = { at: now, txt }; }
          if (!CX.robotsAllowed(robots[host].txt, u.pathname + u.search)) { fetched[q.id] = { at: now, error: 'robots.txt verbietet den Abruf' }; lines.push(`${q.name || host}: robots.txt`); continue; }
          const r = await get(q.url, 20e3, q.art === 'ics' ? 'text/calendar' : 'text/html'); if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const body = (await r.text()).slice(0, V.maxBytes), got = CX.calendarRows(body, q);
          // Neues ersetzt Gespeichertes dieser Quelle für die Zukunft (verschobene, abgesagte Termine verschwinden); Begonnenes bleibt, auch wenn die
          // Seite es schon entfernt hat. Neu aufgenommen wird ab heute 0 Uhr (Ortszeit), damit Termine von heute ohne Uhrzeit oder mehrtägige (Zeile
          // je Tag um 0 Uhr) beim ersten Abruf am Tag nicht fehlen; Neues steht vorn und gewinnt bei gleichem Ort und Beginn (Abgleich unten).
          const dayStart = CX.berlinUtc(T.dayOf(now), 0, 0);
          rows = [...got.filter(x => x[2] >= dayStart), ...rows.filter(x => !(String(x[0]).startsWith(`${q.id}|`) && x[2] >= now))];
          fetched[q.id] = { at: now, n: got.length }; lines.push(`${q.name || host} ${got.length}`);
        } catch (e) { fetched[q.id] = { ...(fetched[q.id] || {}), at: now, error: String(e?.message || e).slice(0, 80) }; lines.push(`${q.name || host}: ${e?.message || e}`); }
        await new Promise(res => setTimeout(res, 500));
      }
      if (lines.length) log(`Veranstaltungskalender: ${lines.join(' · ')}`);
      // Fenster; je Ort und Beginn nur eine Zeile
      const seen = new Set(); rows = rows.filter(r => r[2] >= now - V.pastDays * 86400e3 && r[2] <= now + V.aheadDays * 86400e3).sort((a, b) => a[2] - b[2] || String(a[3]).localeCompare(String(b[3]))).filter(r => { const k = `${r[3]}|${r[2]}`; if (seen.has(k)) return false; seen.add(k); return true; });
      ctx.venueCurated = CX.checkCurated({ ereignisse: CX.venueEntries(rows, venues, { now }) }).ok;
      const covered = venues.filter(v => v.ags && munis.has(v.ags));
      await writeFile(vf, JSON.stringify({ version: 2, at: now, sources: { orte: 'Wikidata (CC0 1.0): Bauwerke in Deutschland mit Kapazität (P1083) ab ' + V.minCap + ' Plätzen', termine: 'öffentliche Programmseiten und Kalender der Orte (data/veranstaltungskalender.json), je Termin mit Link; robots.txt beachtet' },
        venuesAt, venueFields: 'id (Wikidata), name, cap (Plätze), lat, lon, web, addr, types, ags', venues, quellen: srcs.map(q => ({ id: q.id, name: q.name || null, url: q.url, art: q.art, ...(fetched[q.id] || {}) })), fetched, robots,
        eventFields: ['id', 'name', 'beginn_utc_ms', 'ort', 'art', 'genre', 'url', 'ohneZeit (0 = mit Uhrzeit, 1 = mehrtägig, 2 = ohne Uhrzeit)'], events: rows, entries: ctx.venueCurated.length }));
      log(`Veranstaltungsorte: ${venues.length} (${covered.length} in Gemeinden mit Sharing-Daten), ${srcs.length} Kalender, ${rows.length} Termine, ${ctx.venueCurated.length} für die Prognose`);
    } catch (e) { log(`Veranstaltungen: ${e?.message || e}`); }
  }
}
