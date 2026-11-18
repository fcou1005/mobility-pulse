// Sammler, Phase „oepnv“ (S3.9: aus scripts/collect.mjs geschnitten; Ablauf und Zeitmessung in scripts/collect.mjs).
// ctx trägt, was Phasen voneinander brauchen; let-Werte stehen nur in ctx, Konstanten und Funktionen werden hier ausgepackt.
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as C from '../../lib/pulse-core.js';
import * as T from '../../lib/pulse-track.js';
import * as OE from '../../lib/pulse-oepnv.js';
import * as NZ from '../../lib/pulse-oepnv-netz.js';
import * as LN from '../../lib/pulse-oepnv-linien.js';
import * as SV from '../../lib/pulse-schema.js';
import { gzipSync, gunzipSync, inflateRawSync } from 'node:zlib';

export async function run(ctx) {
  const { DATA, UA, incidentDocs, log, now, writeIncidents } = ctx;
  // ÖPNV-Störungen (lib/pulse-oepnv.js; gtfs.de: Echtzeit CC BY-SA 4.0, Haltestellen CC BY 4.0): je Lauf ein Abruf des Echtzeit-Stroms (~11 MB gzip),
  // Halte je Gemeinde und Ortsstunde → incidents/<Tag>.json ags[].ptN/ptSkip/ptLate/pt. Haltestellen → Gemeinde aus stops.txt des freien statischen
  // Feeds: nur dieser Eintrag wird per Range geladen (~12 MB statt 264 MB), neu gebaut, wenn sich der Feed ändert (Prüfung höchstens alle 20 h),
  // gespeichert in oepnv/haltestellen.json.gz. Nur gesammelt (nicht in CTX_KEYS). OEPNV=0 = aus (Fixture-Test), OEPNV_URL/OEPNV_STATIC_URL überschreiben.
  if (process.env.OEPNV !== '0' && ctx.index) {
    const t0 = Date.now(), dir = path.join(DATA, 'oepnv'), ixFile = path.join(dir, 'haltestellen.json.gz');
    // Fahrt → Linie (trips.txt, lib/pulse-oepnv-linien.js): rund 25 MB, liegt nur im Zwischenspeicher des Sammlers
    const tripFile = ctx.TRACK_DIR ? path.join(ctx.TRACK_DIR, 'oepnv-fahrten.bin.gz') : null;
    const getBuf = async (url, { method = 'GET', headers = {}, ms = 90e3 } = {}) => {
      const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), ms);
      try { const r = await fetch(url, { method, headers: { 'user-agent': UA, ...headers }, signal: ctrl.signal }); return { r, buf: method === 'HEAD' ? null : new Uint8Array(await r.arrayBuffer()) }; } finally { clearTimeout(timer); }
    };
    try {
      let ix = null; if (existsSync(ixFile)) { try { ix = JSON.parse(gunzipSync(await readFile(ixFile)).toString('utf8')); } catch { ix = null; } }
      let keep = null; try { keep = new Set(JSON.parse(await readFile(path.join(DATA, 'boundaries-active.json'), 'utf8')).features.map(f => f.properties?.ags).filter(Boolean)); } catch { /* ohne Liste: alle Gemeinden */ }
      // Stationen (Name, Lage) nur für Gemeinden mit Flotte: kommt eine dazu, wird der Index neu gebaut
      const keptOk = !keep || (Array.isArray(ix?.kept) && [...keep].every(g => ix.kept.includes(g))), rebuild = !ix || ix.version !== OE.OEPNV.version || !keptOk || (!!tripFile && !existsSync(tripFile) && ix.trips !== 'failed');
      const stale = rebuild || !(now - Date.parse(ix.checkedAt || 0) < OE.OEPNV.checkEveryH * 3600e3);
      if (stale) {
        const url = process.env.OEPNV_STATIC_URL || OE.OEPNV.staticUrl, { r: h } = await getBuf(url, { method: 'HEAD', ms: 30e3 });
        const len = +h.headers.get('content-length'), stand = { lastModified: h.headers.get('last-modified'), etag: h.headers.get('etag') };
        if (!h.ok || !(len > 0)) throw new Error(`statischer Feed: HTTP ${h.status}`);
        if (!rebuild && ix.etag === stand.etag && ix.lastModified === stand.lastModified) ix.checkedAt = new Date(now).toISOString();
        else {
          const tailAt = Math.max(0, len - 65536), { r: tr, buf: tail } = await getBuf(url, { headers: { range: `bytes=${tailAt}-${len - 1}` } });
          if (tr.status !== 206) throw new Error(`statischer Feed: kein Teilabruf (HTTP ${tr.status}) – ganzer Feed wird nicht geladen`);
          const entries = OE.zipEntries(tail, tailAt);
          const memberBuf = async (name, must, maxSize = 4e9) => { const e = entries.find(x => x.name === name); if (!e) { if (must) throw new Error(`${name} fehlt im Feed`); return null; }
            if (e.size > maxSize) throw new Error(`${name} hat ${(e.size / 1e6).toFixed(0)} MB, zu groß`);
            const { buf: head } = await getBuf(url, { headers: { range: `bytes=${e.at}-${e.at + 29}` } }), start = OE.zipDataStart(head, e.at);
            const { r: dr, buf: comp } = await getBuf(url, { headers: { range: `bytes=${start}-${start + e.csize - 1}` }, ms: 180e3 });
            if (dr.status !== 206 || comp.length !== e.csize) throw new Error(`${name} unvollständig (${comp.length} von ${e.csize} Bytes)`);
            return e.method === 8 ? inflateRawSync(comp) : Buffer.from(comp); };
          const member = async (name, must) => (await memberBuf(name, must))?.toString('utf8') ?? null;
          const text = await member('stops.txt', true);
          const si = OE.stopIndex(text, (lat, lon) => C.assignMunicipality(ctx.index, lat, lon)?.ags ?? null, keep);
          // Linien (Name, Art) für die Karte: fehlt die Datei oder scheitert der Abruf, bleiben die Fahrzeuge ohne Liniennamen
          let routes = {}; try { const rt = await member('routes.txt', false); if (rt) routes = OE.routeIndex(rt); } catch (e) { log(`ÖPNV-Linien: ${e.message} – ohne Liniennamen`); }
          let tripsState = tripFile ? 'failed' : 'off';
          if (tripFile && Object.keys(routes).length) try { const tt0 = Date.now(), tb = await memberBuf('trips.txt', false, 700e6); if (tb) { const tt = LN.tripTable(tb, routes), gz = gzipSync(LN.packTrips(tt), { level: 6 }); await mkdir(path.dirname(tripFile), { recursive: true }); await writeFile(tripFile, gz); tripsState = 'ok'; log(`ÖPNV-Fahrten: ${tt.n} von ${tt.lines} Fahrten mit Linie (${tt.routes.length} Einträge Linie × Ziel, ${tt.headsigns} Fahrten mit Ziel), Tabelle ${(gz.length / 1e6).toFixed(1)} MB in ${((Date.now() - tt0) / 1000).toFixed(1)} s`); } } catch (e) { log(`ÖPNV-Fahrten: ${e.message} – Fahrzeuge ohne Liniennamen bis zum nächsten Fahrplan`); }
          ix = { version: OE.OEPNV.version, trips: tripsState, builtAt: new Date(now).toISOString(), checkedAt: new Date(now).toISOString(), ...stand, source: url, license: 'CC BY 4.0 (gtfs.de, Germany Full free)', rows: si.rows, stops: si.stops, mapped: si.mapped, ags: si.ags, id: si.id, a: si.a, s: si.s, st: si.st, routes, kept: keep ? [...keep].sort() : null };
          log(`ÖPNV-Haltestellen: ${si.mapped} von ${si.stops} Halten (${si.rows} Zeilen) ${si.ags.length} Gemeinden zugeordnet, ${si.st.id.length} Stationen in Gemeinden mit Flotte, ${Object.keys(routes).length} Linien, Feed ${stand.lastModified || '?'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
        }
        await mkdir(dir, { recursive: true }); await writeFile(ixFile, gzipSync(JSON.stringify(ix), { level: 9 }));
      }
      const t1 = Date.now(), { r: rr, buf } = await getBuf(process.env.OEPNV_URL || OE.OEPNV.rtUrl, { headers: { 'accept-encoding': 'gzip' }, ms: 120e3 });
      if (!rr.ok) throw new Error(`Echtzeit: HTTP ${rr.status}`);
      if (buf.length > OE.OEPNV.maxBytes) throw new Error(`Echtzeit: ${(buf.length / 1e6).toFixed(0)} MB, zu groß`);
      let routeOf = null; if (tripFile && existsSync(tripFile)) try { routeOf = LN.tripLookup(gunzipSync(await readFile(tripFile))).of; } catch (e) { log(`ÖPNV-Fahrten: ${e.message} – Tabelle wird neu gebaut`); await rm(tripFile, { force: true }); }
      const stLk = OE.stationLookup(ix), counter = NZ.stationCounter(stLk, ix.st?.id || []), paths = NZ.pathCollector(stLk, ix, now, { routeOf }), lines = LN.lineCounter(stLk, ix, now, { routeOf, backH: OE.OEPNV.backH }), recent = LN.recentCounter(stLk, now);
      const { by, cancel, stats } = OE.ptCounts(buf, OE.stopLookup(ix), now, { keep, onStop: (s, t, sk, d) => { counter.onStop(s, t, sk, d); recent.onStop(s, t, sk, d); }, onTrip: (id, rid, canc, stu) => { paths.onTrip(id, rid, canc, stu); lines.onTrip(id, rid, canc, stu); } });
      // alle Tage laden, die addPt berührt (Fenster der Halte, ganz ausgefallene Fahrten gestern bis morgen), sonst überschriebe ein leeres Dokument die Datei
      const docs = await incidentDocs([T.dayOf(now - OE.OEPNV.backH * 3600e3), T.dayOf(now - 86400e3), T.dayOf(now - 12 * 3600e3), T.dayOf(now), T.dayOf(now + 86400e3)]), w = OE.addPt(docs, by, cancel);
      const src = { at: new Date(now).toISOString(), feedAt: stats.ts ? new Date(stats.ts).toISOString() : null, bytes: buf.length, ms: Date.now() - t1, trips: stats.trips, stops: stats.stops, matched: stats.matched, unmatched: stats.unmatched, noTime: stats.noTime, inWindow: stats.inWindow, ags: stats.ags, flagged: w.flagged, cancelTrips: stats.cancelTrips, cancelAgs: stats.cancelAgs, stopsFeed: ix.lastModified || null };
      docs.get(T.dayOf(now)).sources.pt = src;
      await writeIncidents(docs);
      log(`ÖPNV (gtfs.de): ${stats.trips} Fahrten, ${stats.stops} Halte, ${stats.matched} zugeordnet (${stats.unmatched} ohne Haltestelle), ${stats.inWindow} in den letzten ${OE.OEPNV.backH} h in ${stats.ags} Gemeinden mit Flotte, ${w.flagged} Gemeinde-Stunden gestört, ${stats.cancelTrips} ganz ausgefallene Fahrten in ${stats.cancelAgs} Gemeinden (ohne Uhrzeit, je Tag), ${(buf.length / 1e6).toFixed(1)} MB in ${((Date.now() - t1) / 1000).toFixed(1)} s`);
      // ---------- Reiter ÖPNV (lib/pulse-oepnv-netz.js): Halte je Station, geschätzte Fahrzeugwege, Wirkung auf Sharing ----------
      try {
        const t2 = Date.now(), stFile = ctx.TRACK_DIR ? path.join(ctx.TRACK_DIR, 'oepnv-netz.json.gz') : path.join(dir, 'zustand.json.gz');
        let st = null; try { st = existsSync(stFile) ? JSON.parse(gunzipSync(await readFile(stFile)).toString('utf8')) : null; } catch { st = null; }
        if (st?.v !== NZ.NETZ.version) st = NZ.emptyNetzState();
        const mc = NZ.mergeCounts(st, counter.result(), now); st.lines ||= NZ.emptyNetzState(); const ml = NZ.mergeCounts(st.lines, lines.result(), now); await writeFile(stFile, gzipSync(JSON.stringify(st)));
        const today = T.dayOf(now), totals = NZ.stationTotals(st, today), byAgs = NZ.stationsByAgs(ix), pr = paths.result();
        const days8 = Array.from({ length: 8 }, (_, i) => T.dayOf(now - (7 - i) * 86400e3)), hist = await incidentDocs(days8), lineBy = LN.lineRows(NZ.stationTotals(st.lines, today)), hot = LN.hotspots(ix, recent.result());
        let series = null; try { series = JSON.parse(await readFile(path.join(DATA, 'forecast', 'series.json'), 'utf8')); } catch { series = null; }
        const ptNow = {}, hNow = T.hourOf(now - 3600e3), dNow = T.dayOf(now - 3600e3); // letzte volle Ortsstunde je Gemeinde für die Alarme (Phase alarme)
        const liveDir = path.join(dir, 'live'); await mkdir(liveDir, { recursive: true });
        const cities = {}; let files = 0, vehicles = 0;
        for (const [ags, qs] of byAgs) {
          const rows = NZ.stationRows(ix, qs, totals), hours = NZ.hoursOf(hist, ags, days8), trips = pr.by.get(ags) || [];
          if (!rows.length && !hours.days.length && !trips.length) continue;
          const lr = lineBy.get(ags) || [], profile = series ? LN.dayProfile(hist, series, ags, { today }) : null;
          const aN = hist.get(dNow)?.ags?.[ags]; if (aN?.ptN?.[hNow] >= NZ.NETZ.minHourN) ptNow[ags] = { day: dNow, hour: hNow, n: aN.ptN[hNow], skip: aN.ptSkip?.[hNow] || 0, late: aN.ptLate?.[hNow] || 0, flag: aN.pt?.[hNow] ? 1 : 0 };
          await writeFile(path.join(dir, `${ags}.json`), JSON.stringify(SV.withSchema('oepnv', { ags, at: now, feedAt: stats.ts ?? null, license: NZ.NETZ_LICENSE, attribution: NZ.NETZ_ATTRIBUTION, halfLifeDays: NZ.NETZ.halfLifeDays, days: Math.round(NZ.netzDays(st, now) * 100) / 100, stations: qs.length, fields: NZ.STATION_FIELDS, rows, hours, lines: { fields: LN.LINE_FIELDS, rows: lr }, profile, jetzt: { windowH: LN.JETZT.windowH, minN: LN.JETZT.minN, fields: LN.JETZT_FIELDS, rows: hot.get(ags) || [] } })));
          await writeFile(path.join(liveDir, `${ags}.json`), JSON.stringify(SV.withSchema('oepnv', { ags, at: now, feedAt: stats.ts ?? null, aheadMin: NZ.NETZ.aheadMin, license: NZ.NETZ_LICENSE, attribution: NZ.NETZ_ATTRIBUTION, fields: NZ.LIVE_FIELDS, ...NZ.liveRows(trips, ix), ausfall: NZ.cancelDoc(pr.cancel.get(ags)) })));
          const td = hours.days.at(-1) === today ? hours.days.length - 1 : -1, sum = (a) => (td < 0 ? 0 : a[td].reduce((x, y) => x + y, 0));
          cities[ags] = [rows.length, sum(hours.n), sum(hours.skip), sum(hours.late), trips.length]; files++; vehicles += trips.length;
        }
        // Wirkung auf Sharing: Prognose-Reihen des vorigen Laufs (forecast/series.json) gegen die Störungs-Stunden
        ctx.ptNow = ptNow;
        const { daily, ...eff } = series ? NZ.ptEffect(hist, series, { today }) : { daily: {}, rule: null, pooled: null, cities: [] };
        // passives Lernen: Tageswerte je Stadt über das 8-Tage-Fenster hinaus im Zustand, Schätzung für alle Städte (Kandidat „stoerung“ der Prognose)
        st.learn = NZ.mergeDaily(st.learn, daily, today); await writeFile(stFile, gzipSync(JSON.stringify(st)));
        const learn = NZ.learnEffects(st.learn);
        await writeFile(path.join(dir, 'wirkung.json'), JSON.stringify(SV.withSchema('oepnv', { at: now, days: days8, ...eff, learn })));
        await writeFile(path.join(dir, 'index.json'), JSON.stringify(SV.withSchema('oepnv', { at: now, feedAt: stats.ts ?? null, license: NZ.NETZ_LICENSE, attribution: NZ.NETZ_ATTRIBUTION, aheadMin: NZ.NETZ.aheadMin, days: Math.round(NZ.netzDays(st, now) * 100) / 100, trips: pr.trips, withRoute: pr.withRoute, fields: ['stationen', 'halte_heute', 'ausgefallen_heute', 'verspaetet_heute', 'fahrzeuge'], cities })));
        log(`ÖPNV-Netz: ${files} Gemeinden, ${mc.stations} Stationen in der Summe (${mc.open} Blöcke offen, ${mc.closed} geschlossen), ${pr.trips} Fahrzeugwege (${pr.withRoute} mit Linie, ${pr.skipped} mit ausgefallenen Halten), ${pr.canceled} Fahrten ganz ausgefallen, ${ml.stations} Linien in der Summe, ${[...hot.values()].reduce((s, l) => s + l.length, 0)} Stationen jetzt gestört in ${hot.size} Gemeinden, ${vehicles} Einträge je Gemeinde, Wirkung ${eff.pooled ? `${(eff.pooled.effect * 100).toFixed(1)} % (${eff.pooled.cityDays} Stadt-Tage)` : '–'}, gelernt ${Object.keys(learn.cities).length} Städte aus ${learn.pooled.cityDays} Stadt-Tagen seit ${learn.since}, ${Date.now() - t2} ms`);
      } catch (e) { log(`ÖPNV-Netz: ${e.message} – übersprungen`); }
    } catch (e) { log(`ÖPNV: ${e.message} – übersprungen`); }
  }
  // Momentaufnahmen (nur Zugangs-Quellen)
  for (const f of await readdir(path.join(DATA, 'snapshot')).catch(() => [])) if (f.endsWith('.json')) await rm(path.join(DATA, 'snapshot', f));
  for (const snap of ctx.snapshots) await writeFile(path.join(DATA, 'snapshot', `${snap.id.replace(/[^\w.-]+/g, '_')}.json`), JSON.stringify(snap));
}
