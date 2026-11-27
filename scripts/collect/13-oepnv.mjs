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
import * as PG from '../../lib/pulse-oepnv-prog.js';
import * as GB from '../../lib/pulse-oepnv-gebiet.js';
import * as CX from '../../lib/pulse-context.js';
import * as PL from '../../lib/pulse-oepnv-plan.js';
import { Readable, pipeline } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import * as SV from '../../lib/pulse-schema.js';
import { gzipSync, gunzipSync, inflateRawSync, createInflateRaw } from 'node:zlib';

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
    // Fahrplan für die Live-Karte (lib/pulse-oepnv-plan.js, 20.11.2026): Fahrten an Stationen mit Flotte über PL.PLAN.days Tage, nur im Zwischenspeicher;
    // gebaut, wenn der Feed neu ist, der Stationsindex neu gebaut wird oder die Tage auslaufen. OEPNV_PLAN=0 = aus
    const planFile = ctx.TRACK_DIR && process.env.OEPNV_PLAN !== '0' ? path.join(ctx.TRACK_DIR, 'oepnv-fahrplan.bin.gz') : null, planMetaFile = planFile ? planFile.replace(/\.bin\.gz$/, '.json') : null;
    let planMeta = null; if (planMetaFile && existsSync(planMetaFile)) { try { planMeta = JSON.parse(await readFile(planMetaFile, 'utf8')); } catch { planMeta = null; } }
    const getBuf = async (url, { method = 'GET', headers = {}, ms = 90e3 } = {}) => {
      const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), ms);
      try { const r = await fetch(url, { method, headers: { 'user-agent': UA, ...headers }, signal: ctrl.signal }); return { r, buf: method === 'HEAD' ? null : new Uint8Array(await r.arrayBuffer()) }; } finally { clearTimeout(timer); }
    };
    try {
      let ix = null; if (existsSync(ixFile)) { try { ix = JSON.parse(gunzipSync(await readFile(ixFile)).toString('utf8')); } catch { ix = null; } }
      let keep = null; try { keep = new Set(JSON.parse(await readFile(path.join(DATA, 'boundaries-active.json'), 'utf8')).features.map(f => f.properties?.ags).filter(Boolean)); } catch { /* ohne Liste: alle Gemeinden */ }
      // Stationen (Name, Lage) nur für Gemeinden mit Flotte: kommt eine dazu, wird der Index neu gebaut
      // Fahrplan fällig (fehlt, andere Fassung, Tage laufen aus, anderer Stationsindex); nach einem Fehlschlag frühestens nach checkEveryH wieder
      const planNeed = !!planFile && !(planMeta?.failedAt && now - planMeta.failedAt < OE.OEPNV.checkEveryH * 3600e3) && (PL.planStale(planMeta, now) || !existsSync(planFile) || planMeta?.ixBuilt !== ix?.builtAt);
      // neue Gemeinden mit Flotte: erst keepRebuildH nach dem letzten Bau neu bauen (sie kommen und gehen je Lauf); gebaut wird für die alten und neuen zusammen
      const newKeep = keep && Array.isArray(ix?.kept) ? [...keep].filter(g => !ix.kept.includes(g)) : [], keptOk = !keep || (Array.isArray(ix?.kept) && (!newKeep.length || now - Date.parse(ix.builtAt || 0) < OE.OEPNV.keepRebuildH * 3600e3));
      const why = !ix ? 'kein Index' : ix.version !== OE.OEPNV.version ? 'neue Fassung' : !keptOk ? `${newKeep.length} Gemeinden neu mit Flotte` : !!tripFile && !existsSync(tripFile) && ix.trips !== 'failed' ? 'Fahrten-Tabelle fehlt' : planNeed ? 'Fahrplan fällig' : null, rebuild = !!why;
      const keepIx = keep && Array.isArray(ix?.kept) ? new Set([...keep, ...ix.kept]) : keep; // Index für bisherige und neue Gemeinden (fällt eine weg, bleiben ihre Stationen)
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
          // große Einträge (stop_times.txt, rund 37 Mio. Zeilen) zeilenweise entpacken, ohne sie ganz in den Speicher zu legen
          const memberLines = async (name, onLine) => { const e = entries.find(x => x.name === name); if (!e) throw new Error(`${name} fehlt im Feed`);
            const { buf: head } = await getBuf(url, { headers: { range: `bytes=${e.at}-${e.at + 29}` } }), start = OE.zipDataStart(head, e.at), ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 900e3);
            try { const r = await fetch(url, { headers: { 'user-agent': UA, range: `bytes=${start}-${start + e.csize - 1}` }, signal: ctrl.signal }); if (r.status !== 206 || !r.body) throw new Error(`${name}: kein Teilabruf (HTTP ${r.status})`);
              const src = Readable.fromWeb(/** @type {any} */ (r.body)), z = e.method === 8 ? createInflateRaw() : null, out = z || src; if (z) pipeline(src, z, (err) => { if (err) z.destroy(err); });
              const dec = new StringDecoder('utf8'); let carry = '';
              for await (const chunk of out) { const s = carry + dec.write(chunk); let p = 0, i; while ((i = s.indexOf('\n', p)) >= 0) { onLine(i > p && s.charCodeAt(i - 1) === 13 ? s.slice(p, i - 1) : s.slice(p, i)); p = i + 1; } carry = s.slice(p); }
              carry += dec.end(); if (carry) onLine(carry.replace(/\r$/, '')); } finally { clearTimeout(timer); } };
          const text = await member('stops.txt', true);
          const si = OE.stopIndex(text, (lat, lon) => C.assignMunicipality(ctx.index, lat, lon)?.ags ?? null, keepIx);
          // Linien (Name, Art) für die Karte: fehlt die Datei oder scheitert der Abruf, bleiben die Fahrzeuge ohne Liniennamen
          let routes = {}; try { const rt = await member('routes.txt', false); if (rt) routes = OE.routeIndex(rt); } catch (e) { log(`ÖPNV-Linien: ${e.message} – ohne Liniennamen`); }
          let tripsState = tripFile ? 'failed' : 'off', tb = null;
          if (tripFile && Object.keys(routes).length) try { const tt0 = Date.now(); tb = await memberBuf('trips.txt', false, 700e6); if (tb) { const tt = LN.tripTable(tb, routes), gz = gzipSync(LN.packTrips(tt), { level: 6 }); await mkdir(path.dirname(tripFile), { recursive: true }); await writeFile(tripFile, gz); tripsState = 'ok'; log(`ÖPNV-Fahrten: ${tt.n} von ${tt.lines} Fahrten mit Linie (${tt.routes.length} Einträge Linie × Ziel, ${tt.headsigns} Fahrten mit Ziel), Tabelle ${(gz.length / 1e6).toFixed(1)} MB in ${((Date.now() - tt0) / 1000).toFixed(1)} s`); } } catch (e) { log(`ÖPNV-Fahrten: ${e.message} – Fahrzeuge ohne Liniennamen bis zum nächsten Fahrplan`); }
          if (planFile && tb) try {
            // erst als gescheitert vermerken: bricht der Lauf beim Bauen ab (Speicher, Zeit), versucht der nächste es nicht sofort wieder
            if (planMetaFile) await writeFile(planMetaFile, JSON.stringify({ v: PL.PLAN.version, failedAt: now, error: 'Bau abgebrochen' }));
            const tp0 = Date.now(), day0 = T.dayOf(now - 86400e3), masks = PL.serviceMasks(await memberBuf('calendar.txt', false), await memberBuf('calendar_dates.txt', false), day0);
            const tr = PL.planTrips(tb, routes, masks), sc = PL.stopTimesCollector(tr, OE.stationLookup(si)); tb = null;
            await memberLines('stop_times.txt', (l) => sc.add(l));
            const g = sc.finish(), table = PL.buildPlan(tr, g, { day0, builtAt: now, feed: stand.lastModified }), gz = gzipSync(PL.packPlan(table), { level: 6 });
            await mkdir(path.dirname(planFile), { recursive: true }); await writeFile(planFile, gz);
            planMeta = { v: PL.PLAN.version, day0, days: table.days, builtAt: now, ixBuilt: new Date(now).toISOString(), feed: stand.lastModified, services: masks.size, trips: table.trips, patterns: table.patterns, rows: g.rows, used: g.used, bytes: gz.length };
            log(`ÖPNV-Fahrplan: ${table.trips} Fahrten an Stationen mit Flotte in ${table.patterns} Mustern (${g.used} von ${g.rows} Halten, ${masks.size} Dienste ab ${day0} für ${table.days} Tage), ${(gz.length / 1e6).toFixed(1)} MB in ${((Date.now() - tp0) / 1000).toFixed(1)} s`);
          } catch (e) { planMeta = { v: PL.PLAN.version, failedAt: now, error: String(e.message).slice(0, 200) }; log(`ÖPNV-Fahrplan: ${e.message} – Karte nur mit Echtzeit`); }
          if (planMetaFile && planMeta) await writeFile(planMetaFile, JSON.stringify(planMeta));
          ix = { version: OE.OEPNV.version, trips: tripsState, builtAt: new Date(now).toISOString(), checkedAt: new Date(now).toISOString(), ...stand, source: url, license: 'CC BY 4.0 (gtfs.de, Germany Full free)', rows: si.rows, stops: si.stops, mapped: si.mapped, ags: si.ags, id: si.id, a: si.a, s: si.s, st: si.st, routes, kept: keepIx ? [...keepIx].sort() : null };
          log(`ÖPNV-Haltestellen: ${si.mapped} von ${si.stops} Halten (${si.rows} Zeilen) ${si.ags.length} Gemeinden zugeordnet, ${si.st.id.length} Stationen in Gemeinden mit Flotte, ${Object.keys(routes).length} Linien, Feed ${stand.lastModified || '?'}, Anlass: ${why || 'neuer Feed'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
        }
        await mkdir(dir, { recursive: true }); await writeFile(ixFile, gzipSync(JSON.stringify(ix), { level: 9 }));
      }
      const t1 = Date.now(), { r: rr, buf } = await getBuf(process.env.OEPNV_URL || OE.OEPNV.rtUrl, { headers: { 'accept-encoding': 'gzip' }, ms: 120e3 });
      if (!rr.ok) throw new Error(`Echtzeit: HTTP ${rr.status}`);
      if (buf.length > OE.OEPNV.maxBytes) throw new Error(`Echtzeit: ${(buf.length / 1e6).toFixed(0)} MB, zu groß`);
      let routeOf = null; if (tripFile && existsSync(tripFile)) try { routeOf = LN.tripLookup(gunzipSync(await readFile(tripFile))).of; } catch (e) { log(`ÖPNV-Fahrten: ${e.message} – Tabelle wird neu gebaut`); await rm(tripFile, { force: true }); }
      let plan = null; if (planFile && planMeta?.ixBuilt === ix.builtAt && existsSync(planFile)) try { plan = PL.planView(PL.unpackPlan(gunzipSync(await readFile(planFile)))); } catch (e) { log(`ÖPNV-Fahrplan: ${e.message} – Tabelle wird neu gebaut`); await rm(planFile, { force: true }); }
      const stLk = OE.stationLookup(ix), counter = NZ.stationCounter(stLk, ix.st?.id || []), paths = NZ.pathCollector(stLk, ix, now, { routeOf, plan }), lines = LN.lineCounter(stLk, ix, now, { routeOf, backH: OE.OEPNV.backH }), recent = LN.recentCounter(stLk, now);
      const timeOf = plan ? PL.scheduleTimes(plan, stLk) : null; // Strom nur mit Verspätungen (gtfs.de seit 22.11.2026): Zeit aus dem Fahrplan
      // Zustand des Netzes und Geschäftsgebiet vor der Zählung (27.11.2026): Halte je Gemeinde-Stunde zusätzlich nur an Haltestellen im Gebiet
      // (Alarm, Störungswirkung, ÖPNV-Merkmale der Prognose). Gebiet = bediente Zellen der letzten GB.GEBIET.days Ortstage vor heute (19.11.2026),
      // einmal je Tag gelesen (Zwischenstand in st.gebiet)
      const stFile = ctx.TRACK_DIR ? path.join(ctx.TRACK_DIR, 'oepnv-netz.json.gz') : path.join(dir, 'zustand.json.gz');
      let st = null; try { st = existsSync(stFile) ? JSON.parse(gunzipSync(await readFile(stFile)).toString('utf8')) : null; } catch { st = null; }
      if (st?.v !== NZ.NETZ.version) st = NZ.emptyNetzState();
      const gDays = Array.from({ length: GB.GEBIET.days }, (_, i) => T.dayOf(now - (GB.GEBIET.days - i) * 86400e3));
      if (st.gebiet?.key !== gDays.join()) {
        try {
          const gDocs = []; for (const d of gDays) { const dd = path.join(DATA, 'cells', d); if (!existsSync(dd)) continue; for (const f of (await readdir(dd)).filter(x => /^[A-Z]{2}\.json$/.test(x))) { try { gDocs.push(JSON.parse(await readFile(path.join(dd, f), 'utf8'))); } catch { /* Tag unvollständig */ } } }
          st.gebiet = { key: gDays.join(), days: new Set(gDocs.map(d => d.day)).size, served: Object.fromEntries([...GB.servedFrom(gDocs)].map(([a, c]) => [a, [...c]])) };
        } catch (e) { log(`ÖPNV-Geschäftsgebiet: ${e.message} – Stand vom Vortag`); }
      }
      const served = new Map(Object.entries(st.gebiet?.served || {}).map(([a, c]) => [a, new Set(/** @type {string[]} */ (c))])), areaAgs = GB.areaAgs(served), inArea = GB.stopAreaLookup(ix, served);
      const { by, cancel, stats } = OE.ptCounts(buf, OE.stopLookup(ix), now, { keep, timeOf, inArea, onStop: (s, t, sk, d) => { counter.onStop(s, t, sk, d); recent.onStop(s, t, sk, d); }, onTrip: (id, rid, canc, stu, date) => { paths.onTrip(id, rid, canc, stu, date); lines.onTrip(id, rid, canc, stu); } });
      paths.planPass();
      // alle Tage laden, die addPt berührt (Fenster der Halte, ganz ausgefallene Fahrten gestern bis morgen), sonst überschriebe ein leeres Dokument die Datei
      const docs = await incidentDocs([T.dayOf(now - OE.OEPNV.backH * 3600e3), T.dayOf(now - 86400e3), T.dayOf(now - 12 * 3600e3), T.dayOf(now), T.dayOf(now + 86400e3)]), w = OE.addPt(docs, by, cancel, { areaAgs });
      const src = { at: new Date(now).toISOString(), feedAt: stats.ts ? new Date(stats.ts).toISOString() : null, bytes: buf.length, ms: Date.now() - t1, trips: stats.trips, stops: stats.stops, matched: stats.matched, unmatched: stats.unmatched, noTime: stats.noTime, fromPlan: stats.fromPlan, inWindow: stats.inWindow, ags: stats.ags, flagged: w.flagged, cancelTrips: stats.cancelTrips, cancelAgs: stats.cancelAgs, stopsFeed: ix.lastModified || null };
      docs.get(T.dayOf(now)).sources.pt = src;
      await writeIncidents(docs);
      log(`ÖPNV (gtfs.de): ${stats.trips} Fahrten, ${stats.stops} Halte, ${stats.matched} zugeordnet (${stats.unmatched} ohne Haltestelle${stats.fromPlan ? `, ${stats.fromPlan} mit Zeit aus Fahrplan + Verspätung` : ''}${stats.noTime ? `, ${stats.noTime} ohne Zeit` : ''}), ${stats.inWindow} in den letzten ${OE.OEPNV.backH} h in ${stats.ags} Gemeinden mit Flotte, ${w.flagged} Gemeinde-Stunden gestört, ${stats.cancelTrips} ganz ausgefallene Fahrten in ${stats.cancelAgs} Gemeinden (ohne Uhrzeit, je Tag), ${(buf.length / 1e6).toFixed(1)} MB in ${((Date.now() - t1) / 1000).toFixed(1)} s`);
      if (stats.stops > 1000 && !stats.matched) log(`ÖPNV-Echtzeit: keiner der ${stats.stops} Halte hat eine Zeit${plan ? '' : ' und kein Fahrplan geladen'} – Strom geändert? Karte und Pünktlichkeit nur nach Fahrplan`);
      // ---------- Reiter ÖPNV (lib/pulse-oepnv-netz.js): Halte je Station, geschätzte Fahrzeugwege, Wirkung auf Sharing ----------
      try {
        const t2 = Date.now();
        const mc = NZ.mergeCounts(st, counter.result(), now); st.lines ||= NZ.emptyNetzState(); const ml = NZ.mergeCounts(st.lines, lines.result(), now); await writeFile(stFile, gzipSync(JSON.stringify(st)));
        const today = T.dayOf(now), totals = NZ.stationTotals(st, today), byAgs = NZ.stationsByAgs(ix), pr = paths.result();
        // F28: Verspätungsprognose aus bis zu PG.PTP.days Tagen (Ortstage vor heute plus heute)
        const daysP = Array.from({ length: PG.PTP.days + 1 }, (_, i) => T.dayOf(now - (PG.PTP.days - i) * 86400e3)), histP = await incidentDocs(daysP); let progN = 0;
        const days8 = daysP.slice(-8), hist = new Map(/** @type {Array<[string, any]>} */ (days8.filter(d => histP.has(d)).map(d => [d, histP.get(d)]))), lineBy = LN.lineRows(NZ.stationTotals(st.lines, today)), hot = LN.hotspots(ix, recent.result());
        let series = null; try { series = JSON.parse(await readFile(path.join(DATA, 'forecast', 'series.json'), 'utf8')); } catch { series = null; }
        const ptNow = {}, hNow = T.hourOf(now - 3600e3), dNow = T.dayOf(now - 3600e3); // letzte volle Ortsstunde je Gemeinde für die Alarme (Phase alarme)
        const liveDir = path.join(dir, 'live'); await mkdir(liveDir, { recursive: true });
        let gebietN = 0;
        const cities = {}; let files = 0, vehicles = 0;
        for (const [ags, qs] of byAgs) {
          const rows = NZ.stationRows(ix, qs, totals), hours = NZ.hoursOf(hist, ags, days8), trips = pr.by.get(ags) || [];
          if (!rows.length && !hours.days.length && !trips.length) continue;
          const lr = lineBy.get(ags) || [], profile = series ? LN.dayProfile(hist, series, ags, { today }) : null;
          const prognose = PG.cityOutlook(histP, ags, now, lr); if (prognose) progN++;
          const gebiet = GB.gebietOf(rows, served.get(ags), st.gebiet?.days ?? 0); if (gebiet) gebietN++;
          const aN = CX.ptArea(hist.get(dNow), ags); if (aN && aN.n[hNow] >= NZ.NETZ.minHourN) ptNow[ags] = { day: dNow, hour: hNow, n: aN.n[hNow], skip: aN.skip[hNow] || 0, late: aN.late[hNow] || 0, flag: aN.flag[hNow] ? 1 : 0 }; // Alarm: nur Haltestellen im Gebiet
          await writeFile(path.join(dir, `${ags}.json`), JSON.stringify(SV.withSchema('oepnv', { ags, at: now, feedAt: stats.ts ?? null, license: NZ.NETZ_LICENSE, attribution: NZ.NETZ_ATTRIBUTION, halfLifeDays: NZ.NETZ.halfLifeDays, days: Math.round(NZ.netzDays(st, now) * 100) / 100, stations: qs.length, fields: NZ.STATION_FIELDS, rows, hours, lines: { fields: LN.LINE_FIELDS, rows: lr }, profile, jetzt: { windowH: LN.JETZT.windowH, minN: LN.JETZT.minN, fields: LN.JETZT_FIELDS, rows: hot.get(ags) || [] }, prognose, gebiet })));
          await writeFile(path.join(liveDir, `${ags}.json`), JSON.stringify(SV.withSchema('oepnv', { ags, at: now, feedAt: stats.ts ?? null, aheadMin: NZ.NETZ.aheadMin, license: NZ.NETZ_LICENSE, attribution: NZ.NETZ_ATTRIBUTION, fields: NZ.LIVE_FIELDS, ...NZ.liveRows(trips, ix), ausfall: NZ.cancelDoc(pr.cancel.get(ags)) })));
          const td = hours.days.at(-1) === today ? hours.days.length - 1 : -1, sum = (a) => (td < 0 ? 0 : a[td].reduce((x, y) => x + y, 0));
          const nPlan = trips.filter(r => r[7] === 'fahrplan').length; cities[ags] = [rows.length, sum(hours.n), sum(hours.skip), sum(hours.late), trips.length - nPlan, nPlan]; files++; vehicles += trips.length;
        }
        log(`ÖPNV-Geschäftsgebiet: ${gebietN} Gemeinden mit bedienten Zellen (${st.gebiet?.days ?? 0} Tage), ${[...inArea.values()].filter(v => !v).length} von ${inArea.size} Halten dieser Gemeinden draußen`);
        log(`ÖPNV-Verspätungsprognose: ${progN} Gemeinden (Tage ${[...histP.values()].filter(d => Object.keys(d?.ags || {}).length).length})`);
        // Wirkung auf Sharing: Prognose-Reihen des vorigen Laufs (forecast/series.json) gegen die Störungs-Stunden
        ctx.ptNow = ptNow;
        const { daily, ...eff } = series ? NZ.ptEffect(hist, series, { today }) : { daily: {}, rule: null, pooled: null, cities: [] };
        // passives Lernen: Tageswerte je Stadt über das 8-Tage-Fenster hinaus im Zustand, Schätzung für alle Städte (Kandidat „stoerung“ der Prognose)
        // seit 27.11.2026 nur gestörte Stunden an Haltestellen im Geschäftsgebiet: das Gelernte davor (alle Haltestellen) fällt einmal weg (learnV 2)
        if (st.learnV !== 2) { st.learn = null; st.learnV = 2; }
        st.learn = NZ.mergeDaily(st.learn, daily, today); await writeFile(stFile, gzipSync(JSON.stringify(st)));
        const learn = NZ.learnEffects(st.learn);
        await writeFile(path.join(dir, 'wirkung.json'), JSON.stringify(SV.withSchema('oepnv', { at: now, days: days8, ...eff, learn })));
        await writeFile(path.join(dir, 'index.json'), JSON.stringify(SV.withSchema('oepnv', { at: now, feedAt: stats.ts ?? null, license: NZ.NETZ_LICENSE, attribution: NZ.NETZ_ATTRIBUTION, aheadMin: NZ.NETZ.aheadMin, days: Math.round(NZ.netzDays(st, now) * 100) / 100, trips: pr.trips, withRoute: pr.withRoute, plan: plan ? { builtAt: planMeta.builtAt, feed: planMeta.feed ?? null, trips: pr.planTrips, merged: pr.merged } : null, fields: ['stationen', 'halte_heute', 'ausgefallen_heute', 'verspaetet_heute', 'fahrzeuge', 'fahrzeuge_fahrplan'], cities })));
        log(`ÖPNV-Netz: ${files} Gemeinden, ${mc.stations} Stationen in der Summe (${mc.open} Blöcke offen, ${mc.closed} geschlossen), ${pr.trips} Fahrzeugwege (${pr.withRoute} mit Linie, ${pr.skipped} mit ausgefallenen Halten, ${pr.merged} mit Weg aus dem Fahrplan), ${plan ? `${pr.planTrips} nach Fahrplan ohne Echtzeit (${pr.planDup} als doppelt erkannt)` : 'ohne Fahrplan'}, ${pr.canceled} Fahrten ganz ausgefallen, ${ml.stations} Linien in der Summe, ${[...hot.values()].reduce((s, l) => s + l.length, 0)} Stationen jetzt gestört in ${hot.size} Gemeinden, ${vehicles} Einträge je Gemeinde, Wirkung ${eff.pooled ? `${(eff.pooled.effect * 100).toFixed(1)} % (${eff.pooled.cityDays} Stadt-Tage)` : '–'}, gelernt ${Object.keys(learn.cities).length} Städte aus ${learn.pooled.cityDays} Stadt-Tagen seit ${learn.since}, ${Date.now() - t2} ms`);
      } catch (e) { log(`ÖPNV-Netz: ${e.message} – übersprungen`); }
    } catch (e) { log(`ÖPNV: ${e.message} – übersprungen`); }
  }
  // Momentaufnahmen (nur Zugangs-Quellen)
  for (const f of await readdir(path.join(DATA, 'snapshot')).catch(() => [])) if (f.endsWith('.json')) await rm(path.join(DATA, 'snapshot', f));
  for (const snap of ctx.snapshots) await writeFile(path.join(DATA, 'snapshot', `${snap.id.replace(/[^\w.-]+/g, '_')}.json`), JSON.stringify(snap));
}
