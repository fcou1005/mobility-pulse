// ÖPNV-Störungen aus dem freien GTFS-Realtime-Strom von gtfs.de (CC BY-SA 4.0) mit den Haltestellen des freien statischen Feeds (CC BY 4.0).
// Je Gemeinde und Ortsstunde: Halte mit Echtzeit (ptN), davon ausgefallen (ptSkip) und ≥ 5 Min. verspätet (ptLate), dazu das Kennzeichen pt.
// Nur gesammelt (nicht in CTX_KEYS): bis zum Ende der Lernphase keine Wirkung auf die Prognose. Ohne Abhängigkeiten; Entpacken macht der Aufrufer.
// Geprüft am 12.11.2026: Strom 10,8 MB gzip (27,7 MB), 108.347 Fahrten, 637.550 Halte, jede Halt-Meldung mit stop_id; ausgefallene Halte
// (SKIPPED) ohne Zeit; stop_id der Stichprobe 146/146 in stops.txt des freien Feeds (691.296 Zeilen, davon 441.184 Halte).
import { dayOf, hourOf } from './pulse-track.js';
import { emptyIncidentDoc, berlinUtc } from './pulse-context.js';

export const OEPNV = {
  rtUrl: 'https://realtime.gtfs.de/realtime-free.pb',
  staticUrl: 'https://download.gtfs.de/germany/free/latest.zip',
  version: 1,
  checkEveryH: 20, // Stand des statischen Feeds höchstens so oft prüfen (HEAD)
  maxBytes: 120e6, // Echtzeit größer als das (entpackt): verwerfen
  backH: 26, // Halte bis so weit zurück zählen (der Strom hält vergangene Fahrten etwa 12 Stunden)
  lateSec: 300, // ab 5 Minuten Verspätung gilt ein Halt als verspätet
  minN: 20, // Kennzeichen erst ab so vielen Halten mit Echtzeit in der Gemeinde-Stunde
  skipShare: 0.15, // vorläufig: ≥ 15 % ausgefallene Halte (bundesweit am 12.11.2026 morgens 5,8 %) …
  lateShare: 0.3, // … oder ≥ 30 % verspätete Halte → pt = 1; nach zwei Wochen gegen den Median je Gemeinde und Wochenstunde prüfen
  keys: ['ptN', 'ptSkip', 'ptLate', 'pt'],
};

// ---------- Protobuf (nur was GTFS-Realtime braucht) ----------
/** Felder einer Nachricht: [Feldnummer, Wire-Typ, Wert]; Wert = Zahl (Varint), [Anfang, Ende] (Länge) oder null; lo = untere 32 Bit (int32 mit Vorzeichen) */
export function* pbFields(b, s = 0, e = b.length) {
  let p = s;
  while (p < e) {
    let k = 0, sh = 0, x;
    do { x = b[p++]; k += (x & 127) * 2 ** sh; sh += 7; } while (x & 128 && p < e);
    const f = Math.floor(k / 8), w = k % 8;
    if (w === 0) {
      let v = 0, lo = 0; sh = 0;
      do { x = b[p++]; v += (x & 127) * 2 ** sh; if (sh < 32) lo |= (x & 127) << sh; sh += 7; } while (x & 128 && p <= e);
      yield [f, 0, v, lo | 0];
    } else if (w === 2) {
      let l = 0; sh = 0;
      do { x = b[p++]; l += (x & 127) * 2 ** sh; sh += 7; } while (x & 128);
      if (p + l > e) throw new Error(`Protobuf: Feld ${f} reicht über das Ende`);
      yield [f, 2, [p, p + l], 0]; p += l;
    } else if (w === 1) { yield [f, 1, null, 0]; p += 8; } else if (w === 5) { yield [f, 5, null, 0]; p += 4; } else throw new Error(`Protobuf: Wire-Typ ${w} an Stelle ${p}`);
  }
}
const utf8 = new TextDecoder();
const str = (b, r) => utf8.decode(b.subarray(r[0], r[1]));

/**
 * Halte eines GTFS-Realtime-Stroms einzeln an cb(stopId, t, skipped, delay) geben (t in ms; delay in s oder null).
 * Ausgefallene Halte tragen bei gtfs.de keine Zeit: sie bekommen die Zeit des nächsten Halts derselben Fahrt davor (sonst danach,
 * sonst den Fahrtbeginn aus start_date/start_time). Fahrten mit CANCELED: alle Halte ausgefallen. Rückgabe: Kopf und Zähler.
 */
export function forEachStop(buf, cb) {
  const out = { ts: null, incr: null, trips: 0, stops: 0, noTime: 0, alerts: 0, canceled: 0 };
  for (const [f, w, v] of pbFields(buf)) {
    if (f === 1 && w === 2) for (const [g, , gv] of pbFields(buf, ...v)) { if (g === 2) out.incr = gv; if (g === 3) out.ts = gv * 1000; }
    if (f !== 2 || w !== 2) continue;
    for (const [g, gw, gv] of pbFields(buf, ...v)) {
      if (g === 5 && gw === 2) out.alerts++;
      if (g !== 3 || gw !== 2) continue;
      out.trips++;
      let tripSr = 0, sDate = null, sTime = null; const stu = [];
      for (const [h, hw, hv] of pbFields(buf, ...gv)) {
        if (h === 1 && hw === 2) for (const [i, , iv] of pbFields(buf, ...hv)) { if (i === 4) tripSr = iv; if (i === 2) sTime = str(buf, iv); if (i === 3) sDate = str(buf, iv); }
        else if (h === 2 && hw === 2) {
          const s = { stop: null, t: null, delay: null, sr: 0 };
          for (const [i, iw, iv] of pbFields(buf, ...hv)) {
            if (i === 4 && iw === 2) s.stop = str(buf, iv);
            else if (i === 5) s.sr = iv;
            else if ((i === 3 || i === 2) && iw === 2) { // departure (3) vor arrival (2)
              let t = null, d = null;
              for (const [j, , jv, jlo] of pbFields(buf, ...iv)) { if (j === 2) t = jv; if (j === 1) d = jlo; }
              if (t != null && (s.t == null || i === 3)) s.t = t * 1000;
              if (d != null && (s.delay == null || i === 3)) s.delay = d;
            }
          }
          stu.push(s);
        }
      }
      if (tripSr === 3) out.canceled++;
      let start = null;
      if (sDate && /^\d{8}$/.test(sDate) && sTime && /^\d{1,2}:\d{2}/.test(sTime)) {
        const [hh, mm] = sTime.split(':').map(Number), day = `${sDate.slice(0, 4)}-${sDate.slice(4, 6)}-${sDate.slice(6, 8)}`;
        start = berlinUtc(day, 0, 0) + (hh * 60 + mm) * 60e3; // Betriebstag-Zeit (auch über 24 Uhr)
      }
      for (let k = 0; k < stu.length; k++) {
        const s = stu[k]; if (s.stop == null) continue;
        let t = s.t;
        if (t == null) { for (let j = k - 1; j >= 0 && t == null; j--) t = stu[j].t; for (let j = k + 1; j < stu.length && t == null; j++) t = stu[j].t; if (t == null) t = start; }
        out.stops++;
        if (t == null) { out.noTime++; continue; }
        cb(s.stop, t, tripSr === 3 || s.sr === 1, s.delay);
      }
    }
  }
  return out;
}

// ---------- ZIP (nur Verzeichnis lesen; Entpacken mit zlib.inflateRawSync beim Aufrufer) ----------
/** Einträge aus dem Ende einer ZIP-Datei: tail = letzte Bytes, tailAt = deren Position in der Datei */
export function zipEntries(tail, tailAt) {
  const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1; for (let i = tail.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('ZIP: Verzeichnisende nicht gefunden');
  const n = dv.getUint16(eocd + 10, true), cdOff = dv.getUint32(eocd + 16, true);
  if (cdOff === 0xffffffff || n === 0xffff) throw new Error('ZIP64 wird nicht unterstützt');
  let p = cdOff - tailAt; if (p < 0) throw new Error('ZIP: Verzeichnis liegt vor dem gelesenen Ende');
  const out = [];
  for (let i = 0; i < n; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('ZIP: Verzeichniseintrag beschädigt');
    const fl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    out.push({ name: utf8.decode(tail.subarray(p + 46, p + 46 + fl)), method: dv.getUint16(p + 10, true), csize: dv.getUint32(p + 20, true), size: dv.getUint32(p + 24, true), at: dv.getUint32(p + 42, true) });
    p += 46 + fl + xl + cl;
  }
  return out;
}
/** Beginn der Daten hinter dem lokalen Kopf (mindestens 30 Bytes ab entry.at) */
export function zipDataStart(head, at) {
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (dv.getUint32(0, true) !== 0x04034b50) throw new Error('ZIP: lokaler Kopf beschädigt');
  return at + 30 + dv.getUint16(26, true) + dv.getUint16(28, true);
}

// ---------- Haltestellen → Gemeinde ----------
/** Eine CSV-Zeile mit Anführungszeichen */
export function csvLine(l) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (q) { if (c === '"') { if (l[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur); return out;
}
/** stops.txt → { ags: [AGS …], id: [stop_id …], a: [Index in ags …], rows, stops, mapped }; nur Halte (location_type leer/0) mit Gemeinde */
export function stopIndex(text, locate) {
  const lines = text.split(/\r?\n/), cols = csvLine((lines[0] || '').replace(/^﻿/, ''));
  const I = Object.fromEntries(cols.map((c, i) => [c.trim(), i]));
  if (I.stop_id == null || I.stop_lat == null || I.stop_lon == null) throw new Error('stops.txt: Spalten stop_id/stop_lat/stop_lon fehlen');
  const agsIdx = new Map(), ags = [], id = [], a = []; let rows = 0, stops = 0;
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i]; if (!l) continue; rows++;
    const c = csvLine(l), lt = I.location_type != null ? c[I.location_type] : '';
    if (lt && lt !== '0') continue; stops++;
    const lat = +c[I.stop_lat], lon = +c[I.stop_lon]; if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const g = locate(lat, lon); if (!g) continue;
    let k = agsIdx.get(g); if (k == null) { k = ags.length; agsIdx.set(g, k); ags.push(g); }
    id.push(c[I.stop_id]); a.push(k);
  }
  return { ags, id, a, rows, stops, mapped: id.length };
}
/** Gespeicherten Index zur Suche: stop_id → AGS */
export function stopLookup(ix) { const m = new Map(); for (let i = 0; i < ix.id.length; i++) m.set(ix.id[i], ix.ags[ix.a[i]]); return m; }

// ---------- Zählen und eintragen ----------
/**
 * Halte je Gemeinde und UTC-Stunde: Map(AGS → Map(Stundenbeginn ms → [Halte, ausgefallen, verspätet])).
 * Gezählt werden Halte mit Zeit in [now − backH, now); künftige Halte sind Vorhersagen und zählen nicht.
 */
export function ptCounts(buf, lookup, now, { backH = OEPNV.backH, lateSec = OEPNV.lateSec, keep = null } = {}) {
  const by = new Map(), from = now - backH * 3600e3; let matched = 0, unmatched = 0, inWindow = 0;
  const head = forEachStop(buf, (stop, t, skipped, delay) => {
    const g = lookup.get(stop); if (!g) { unmatched++; return; } matched++;
    if (t < from || t >= now || (keep && !keep.has(g))) return; inWindow++;
    const hs = Math.floor(t / 3600e3) * 3600e3; let m = by.get(g); if (!m) by.set(g, m = new Map());
    let c = m.get(hs); if (!c) m.set(hs, c = [0, 0, 0]);
    c[0]++; if (skipped) c[1]++; else if (delay != null && delay >= lateSec) c[2]++;
  });
  return { by, stats: { ...head, matched, unmatched, inWindow, ags: by.size } };
}
/** Kennzeichen aus den Zahlen einer Gemeinde-Stunde */
export const ptFlag = (n, skip, late, o = OEPNV) => (n >= o.minN && (skip >= o.skipShare * n || late >= o.lateShare * n) ? 1 : 0);
const slot = (doc, ags, key) => { const a = (doc.ags[ags] ||= {}); return (a[key] ||= new Array(24).fill(0)); };
/** In incidents-Dokumente (Map Tag → Dokument) eintragen: je Stunde das Maximum über die Läufe (spätere Läufe sehen beendete Fahrten nicht mehr) */
export function addPt(docs, by) {
  let cells = 0, flagged = 0;
  for (const [g, m] of by) for (const [hs, [n, skip, late]] of m) {
    const day = dayOf(hs), h = hourOf(hs); let doc = docs.get(day); if (!doc) docs.set(day, doc = emptyIncidentDoc(day));
    const N = slot(doc, g, 'ptN'), S = slot(doc, g, 'ptSkip'), L = slot(doc, g, 'ptLate'), F = slot(doc, g, 'pt');
    if (n >= N[h]) { N[h] = n; S[h] = skip; L[h] = late; }
    F[h] = ptFlag(N[h], S[h], L[h]); cells++; flagged += F[h];
  }
  return { cells, flagged };
}
