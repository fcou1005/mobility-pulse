// Sammler, Phase „oepnv“ (S3.9: aus scripts/collect.mjs geschnitten; Ablauf und Zeitmessung in scripts/collect.mjs).
// ctx trägt, was Phasen voneinander brauchen; let-Werte stehen nur in ctx, Konstanten und Funktionen werden hier ausgepackt.
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as C from '../../lib/pulse-core.js';
import * as T from '../../lib/pulse-track.js';
import * as OE from '../../lib/pulse-oepnv.js';
import { gzipSync, gunzipSync, inflateRawSync } from 'node:zlib';

export async function run(ctx) {
  const { DATA, UA, incidentDocs, log, now, writeIncidents } = ctx;
  // ÖPNV-Störungen (lib/pulse-oepnv.js; gtfs.de: Echtzeit CC BY-SA 4.0, Haltestellen CC BY 4.0): je Lauf ein Abruf des Echtzeit-Stroms (~11 MB gzip),
  // Halte je Gemeinde und Ortsstunde → incidents/<Tag>.json ags[].ptN/ptSkip/ptLate/pt. Haltestellen → Gemeinde aus stops.txt des freien statischen
  // Feeds: nur dieser Eintrag wird per Range geladen (~12 MB statt 264 MB), neu gebaut, wenn sich der Feed ändert (Prüfung höchstens alle 20 h),
  // gespeichert in oepnv/haltestellen.json.gz. Nur gesammelt (nicht in CTX_KEYS). OEPNV=0 = aus (Fixture-Test), OEPNV_URL/OEPNV_STATIC_URL überschreiben.
  if (process.env.OEPNV !== '0' && ctx.index) {
    const t0 = Date.now(), dir = path.join(DATA, 'oepnv'), ixFile = path.join(dir, 'haltestellen.json.gz');
    const getBuf = async (url, { method = 'GET', headers = {}, ms = 90e3 } = {}) => {
      const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), ms);
      try { const r = await fetch(url, { method, headers: { 'user-agent': UA, ...headers }, signal: ctrl.signal }); return { r, buf: method === 'HEAD' ? null : new Uint8Array(await r.arrayBuffer()) }; } finally { clearTimeout(timer); }
    };
    try {
      let ix = null; if (existsSync(ixFile)) { try { ix = JSON.parse(gunzipSync(await readFile(ixFile)).toString('utf8')); } catch { ix = null; } }
      const stale = !ix || ix.version !== OE.OEPNV.version || !(now - Date.parse(ix.checkedAt || 0) < OE.OEPNV.checkEveryH * 3600e3);
      if (stale) {
        const url = process.env.OEPNV_STATIC_URL || OE.OEPNV.staticUrl, { r: h } = await getBuf(url, { method: 'HEAD', ms: 30e3 });
        const len = +h.headers.get('content-length'), stand = { lastModified: h.headers.get('last-modified'), etag: h.headers.get('etag') };
        if (!h.ok || !(len > 0)) throw new Error(`statischer Feed: HTTP ${h.status}`);
        if (ix && ix.version === OE.OEPNV.version && ix.etag === stand.etag && ix.lastModified === stand.lastModified) ix.checkedAt = new Date(now).toISOString();
        else {
          const tailAt = Math.max(0, len - 65536), { r: tr, buf: tail } = await getBuf(url, { headers: { range: `bytes=${tailAt}-${len - 1}` } });
          if (tr.status !== 206) throw new Error(`statischer Feed: kein Teilabruf (HTTP ${tr.status}) – ganzer Feed wird nicht geladen`);
          const e = OE.zipEntries(tail, tailAt).find(x => x.name === 'stops.txt'); if (!e) throw new Error('stops.txt fehlt im Feed');
          const { buf: head } = await getBuf(url, { headers: { range: `bytes=${e.at}-${e.at + 29}` } }), start = OE.zipDataStart(head, e.at);
          const { r: dr, buf: comp } = await getBuf(url, { headers: { range: `bytes=${start}-${start + e.csize - 1}` }, ms: 180e3 });
          if (dr.status !== 206 || comp.length !== e.csize) throw new Error(`stops.txt unvollständig (${comp.length} von ${e.csize} Bytes)`);
          const text = (e.method === 8 ? inflateRawSync(comp) : Buffer.from(comp)).toString('utf8');
          const si = OE.stopIndex(text, (lat, lon) => C.assignMunicipality(ctx.index, lat, lon)?.ags ?? null);
          ix = { version: OE.OEPNV.version, builtAt: new Date(now).toISOString(), checkedAt: new Date(now).toISOString(), ...stand, source: url, license: 'CC BY 4.0 (gtfs.de, Germany Full free)', rows: si.rows, stops: si.stops, mapped: si.mapped, ags: si.ags, id: si.id, a: si.a };
          log(`ÖPNV-Haltestellen: ${si.mapped} von ${si.stops} Halten (${si.rows} Zeilen) ${si.ags.length} Gemeinden zugeordnet, Feed ${stand.lastModified || '?'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
        }
        await mkdir(dir, { recursive: true }); await writeFile(ixFile, gzipSync(JSON.stringify(ix), { level: 9 }));
      }
      const t1 = Date.now(), { r: rr, buf } = await getBuf(process.env.OEPNV_URL || OE.OEPNV.rtUrl, { headers: { 'accept-encoding': 'gzip' }, ms: 120e3 });
      if (!rr.ok) throw new Error(`Echtzeit: HTTP ${rr.status}`);
      if (buf.length > OE.OEPNV.maxBytes) throw new Error(`Echtzeit: ${(buf.length / 1e6).toFixed(0)} MB, zu groß`);
      let keep = null; try { keep = new Set(JSON.parse(await readFile(path.join(DATA, 'boundaries-active.json'), 'utf8')).features.map(f => f.properties?.ags).filter(Boolean)); } catch { /* ohne Liste: alle Gemeinden */ }
      const { by, cancel, stats } = OE.ptCounts(buf, OE.stopLookup(ix), now, { keep });
      // alle Tage laden, die addPt berührt (Fenster der Halte, ganz ausgefallene Fahrten gestern bis morgen), sonst überschriebe ein leeres Dokument die Datei
      const docs = await incidentDocs([T.dayOf(now - OE.OEPNV.backH * 3600e3), T.dayOf(now - 86400e3), T.dayOf(now - 12 * 3600e3), T.dayOf(now), T.dayOf(now + 86400e3)]), w = OE.addPt(docs, by, cancel);
      const src = { at: new Date(now).toISOString(), feedAt: stats.ts ? new Date(stats.ts).toISOString() : null, bytes: buf.length, ms: Date.now() - t1, trips: stats.trips, stops: stats.stops, matched: stats.matched, unmatched: stats.unmatched, noTime: stats.noTime, inWindow: stats.inWindow, ags: stats.ags, flagged: w.flagged, cancelTrips: stats.cancelTrips, cancelAgs: stats.cancelAgs, stopsFeed: ix.lastModified || null };
      docs.get(T.dayOf(now)).sources.pt = src;
      await writeIncidents(docs);
      log(`ÖPNV (gtfs.de): ${stats.trips} Fahrten, ${stats.stops} Halte, ${stats.matched} zugeordnet (${stats.unmatched} ohne Haltestelle), ${stats.inWindow} in den letzten ${OE.OEPNV.backH} h in ${stats.ags} Gemeinden mit Flotte, ${w.flagged} Gemeinde-Stunden gestört, ${stats.cancelTrips} ganz ausgefallene Fahrten in ${stats.cancelAgs} Gemeinden (ohne Uhrzeit, je Tag), ${(buf.length / 1e6).toFixed(1)} MB in ${((Date.now() - t1) / 1000).toFixed(1)} s`);
    } catch (e) { log(`ÖPNV: ${e.message} – übersprungen`); }
  }
  // Momentaufnahmen (nur Zugangs-Quellen)
  for (const f of await readdir(path.join(DATA, 'snapshot')).catch(() => [])) if (f.endsWith('.json')) await rm(path.join(DATA, 'snapshot', f));
  for (const snap of ctx.snapshots) await writeFile(path.join(DATA, 'snapshot', `${snap.id.replace(/[^\w.-]+/g, '_')}.json`), JSON.stringify(snap));
}
