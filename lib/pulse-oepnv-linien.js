// @ts-check
// Mobility Pulse — ÖPNV-Linien (Sammler-Teil): Der Echtzeit-Strom von gtfs.de nennt je Fahrt nur trip_id, keine Linie. Die Zuordnung
// Fahrt → Linie kommt aus trips.txt des Fahrplans (rund 2 Mio. Zeilen). Gespeichert wird sie als sortierte Hash-Tabelle (zwei 32-Bit-Hashes
// je Fahrt + Linienindex, rund 12 Bytes je Fahrt) im Zwischenspeicher des Sammlers, nicht im Datenstand. Dazu die Zählung je Linie.
import { dayOf, hourOf } from './pulse-track.js';
import { NETZ, modeClass } from './pulse-oepnv-karte.js';

// Fassung 2 (17.11.2026): je Eintrag auch das Fahrtziel (trip_headsign) für die Live-Karte – Eintrag = [Linie, route_type, Ziel]
export const LINIEN = { version: 2, magic: 'MPL1', top: 80, minStops: 40 };
/** FNV-1a über die UTF-16-Einheiten; zwei Startwerte geben zwei unabhängige Hashes */
const fnv = (/** @type {string} */ s, /** @type {number} */ seed) => { let h = seed >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; };
const S1 = 2166136261, S2 = 0x9747b28c;
/** Beide Hashes einer trip_id (auch die Fahrplan-Tabelle, lib/pulse-oepnv-plan.js, sucht damit) */
export const tripHash = (/** @type {string} */ id) => /** @type {[number, number]} */ ([fnv(id, S1), fnv(id, S2)]);
const cells = (/** @type {string} */ line) => { if (!line.includes('"')) return line.split(','); const out = []; let cur = '', q = false; for (let i = 0; i < line.length; i++) { const c = line[i]; if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; } else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; } out.push(cur); return out; };

/**
 * trips.txt (Bytes) → Tabelle. routes: route_id → [Name, route_type] (routeIndex). Linien ohne Namen und Art fallen weg. Je Fahrt der Index eines
 * Eintrags [Linie, route_type, Ziel] (Ziel aus trip_headsign, leer, wenn die Spalte fehlt); gleiche Einträge teilen sich einen Index.
 * @param {Uint8Array} buf @param {Record<string, any>} routes
 * @returns {{ n: number, h1: Uint32Array, h2: Uint32Array, r: Uint32Array, routes: any[], lines: number, headsigns: number }}
 */
export function tripTable(buf, routes) {
  const B = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 0, end = B.indexOf(10, pos); if (end < 0) end = B.length;
  const head = cells(B.toString('utf8', pos, end).replace(/^﻿/, '').replace(/\r$/, '')).map(c => c.trim()), iT = head.indexOf('trip_id'), iR = head.indexOf('route_id'), iH = head.indexOf('trip_headsign');
  if (iT < 0 || iR < 0) throw new Error('trips.txt ohne trip_id oder route_id');
  /** @type {Map<string, number>} */ const rIdx = new Map(), rKey = new Map(); /** @type {Array<[string, number | null, string]>} */ const rList = [];
  let cap = 1 << 20, n = 0, lines = 0, heads = 0, a1 = new Uint32Array(cap), a2 = new Uint32Array(cap), ar = new Uint32Array(cap);
  for (pos = end + 1; pos < B.length; pos = end + 1) {
    end = B.indexOf(10, pos); if (end < 0) end = B.length; if (end <= pos) continue; lines++;
    const c = cells(B.toString('utf8', pos, B[end - 1] === 13 ? end - 1 : end)), tid = c[iT], rid = c[iR]; if (!tid || !rid) continue;
    let ri = rIdx.get(rid);
    if (ri == null) { const r = routes[rid]; ri = !r || (!r[0] && r[1] == null) ? -1 : 0; rIdx.set(rid, ri); }
    if (ri < 0) continue;
    const r = routes[rid], hs = iH >= 0 ? (c[iH] || '').trim() : '', k = `${r[0]}\u0001${r[1]}\u0001${hs}`; if (hs) heads++;
    let j = rKey.get(k); if (j == null) { j = rList.length; rList.push([r[0], r[1], hs]); rKey.set(k, j); } ri = j;
    if (n === cap) { cap *= 2; const g = (/** @type {Uint32Array} */ o) => { const x = new Uint32Array(cap); x.set(o); return x; }; a1 = g(a1); a2 = g(a2); ar = g(ar); }
    a1[n] = fnv(tid, S1); a2[n] = fnv(tid, S2); ar[n] = ri; n++;
  }
  const ord = new Uint32Array(n); for (let i = 0; i < n; i++) ord[i] = i; ord.sort((x, y) => a1[x] - a1[y] || a2[x] - a2[y]);
  const h1 = new Uint32Array(n), h2 = new Uint32Array(n), r = new Uint32Array(n); for (let i = 0; i < n; i++) { const o = ord[i]; h1[i] = a1[o]; h2[i] = a2[o]; r[i] = ar[o]; }
  return { n, h1, h2, r, routes: rList, lines, headsigns: heads };
}
/** Tabelle → Bytes: 'MPL1', Länge des JSON-Kopfs (uint32 LE), Kopf { v, n, routes }, dann h1, h2, r als uint32 LE */
/** @param {ReturnType<typeof tripTable>} t */
export function packTrips(t) {
  const head = Buffer.from(JSON.stringify({ v: LINIEN.version, n: t.n, routes: t.routes }), 'utf8'), pad = (4 - (8 + head.length) % 4) % 4, out = Buffer.alloc(8 + head.length + pad + t.n * 12);
  out.write(LINIEN.magic, 0, 'latin1'); out.writeUInt32LE(head.length, 4); head.copy(out, 8); let p = 8 + head.length + pad;
  for (const a of [t.h1, t.h2, t.r]) { for (let i = 0; i < t.n; i++) out.writeUInt32LE(a[i], p + i * 4); p += t.n * 4; }
  return out;
}
/** Bytes → Nachschlagen: (trip_id) → [Name, route_type, Ziel] oder null (Fassung 1 ohne Ziel wird noch gelesen) */
/** @param {Uint8Array} bytes @returns {{ n: number, routes: number, of: (tripId: string) => [string, number | null, string?] | null }} */
export function tripLookup(bytes) {
  const B = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (B.toString('latin1', 0, 4) !== LINIEN.magic) throw new Error('Fahrten-Tabelle: falsches Format');
  const hl = B.readUInt32LE(4), head = JSON.parse(B.toString('utf8', 8, 8 + hl)); if (head.v !== LINIEN.version && head.v !== 1) throw new Error('Fahrten-Tabelle: andere Fassung');
  const n = head.n, p0 = 8 + hl + (4 - (8 + hl) % 4) % 4; if (B.length < p0 + n * 12) throw new Error('Fahrten-Tabelle: abgeschnitten');
  const rd = (/** @type {number} */ k, /** @type {number} */ i) => B.readUInt32LE(p0 + k * n * 4 + i * 4);
  return { n, routes: head.routes.length, of(tripId) {
    const a = fnv(tripId, S1), b = fnv(tripId, S2); let lo = 0, hi = n - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (rd(0, m) < a) lo = m + 1; else hi = m; }
    for (let i = lo; i < n && rd(0, i) === a; i++) if (rd(1, i) === b) return head.routes[rd(2, i)] || null;
    return null;
  } };
}

// ---------- Zählung je Linie ----------
export const LINE_FIELDS = ['linie', 'art', 'halte', 'ausgefallen', 'verspaetet', 'verspaetung_min', 'halte_heute', 'ausgefallen_heute', 'verspaetet_heute'];
/**
 * Zähler je Lauf wie stationCounter, Schlüssel 'AGS|Art|Linie': onTrip(tripId, routeId, abgesagt, Halte) → result() für mergeCounts.
 * Gezählt werden Halte mit Zeit in [now − backH, now) an Stationen in Gemeinden mit Flotte; Fahrten ohne Linie fallen weg.
 */
/** @param {Map<string, number>} stLookup @param {any} ix @param {number} now @param {any} [opts] */
export function lineCounter(stLookup, ix, now, { routeOf = null, backH = 24, lateSec = 300 } = {}) {
  /** @type {Record<string, Record<string, number[]>>} */ const out = {}, from = now - backH * 3600e3; let trips = 0;
  return {
    onTrip(/** @type {string | null} */ id, /** @type {string | null} */ routeId, /** @type {boolean} */ canceled, /** @type {any[]} */ stu) {
      const r = (routeId != null ? ix.routes?.[routeId] : null) || (routeOf && id != null ? routeOf(id) : null); if (!r || !r[0]) return;
      const tag = `|${modeClass(r[1], r[0])}|${r[0]}`; let any = false;
      for (const s of stu) {
        if (s.tt == null || s.tt < from || s.tt >= now || s.stop == null) continue; const q = stLookup.get(s.stop); if (q == null) continue;
        const key = `${dayOf(s.tt)}|${Math.floor(hourOf(s.tt) / NETZ.blockH)}`, o = (out[key] ||= {}), c = (o[ix.ags[ix.st.a[q]] + tag] ||= [0, 0, 0, 0, 0]), skipped = canceled || s.sr === 1;
        c[0]++; any = true; if (skipped) c[1]++; else { if (s.delay != null && s.delay >= lateSec) c[2]++; if (s.delay != null) { c[3] += Math.max(0, s.delay); c[4]++; } }
      }
      if (any) trips++;
    },
    result: () => out, trips: () => trips,
  };
}
/** Zeilen je Gemeinde (LINE_FIELDS) aus stationTotals des Linien-Zustands: Map AGS → Zeilen, nach Halten absteigend, höchstens top */
/** @param {Map<string, { tot: number[], day: number[] }>} totals @param {number} [top] */
export function lineRows(totals, top = LINIEN.top) {
  /** @type {Map<string, any[][]>} */ const by = new Map(), r1 = (/** @type {number} */ x) => Math.round(x * 10) / 10;
  // Summen aus der Zeit vor Format 1.2 tragen die Art 'bahn': sie zählen zur Art aus dem Liniennamen, damit keine Linie doppelt steht
  /** @type {Map<string, { tot: number[], day: number[] }>} */ const merged = new Map();
  for (const [id, e] of totals) { const i = id.indexOf('|'), j = id.indexOf('|', i + 1), art = id.slice(i + 1, j), name = id.slice(j + 1), k = `${id.slice(0, i)}|${art === 'bahn' ? modeClass(2, name) : art}|${name}`, m = merged.get(k);
    if (!m) merged.set(k, { tot: [...e.tot], day: [...e.day] }); else for (let x = 0; x < 5; x++) { m.tot[x] += e.tot[x]; m.day[x] += e.day[x]; } }
  for (const [id, e] of merged) { const i = id.indexOf('|'), j = id.indexOf('|', i + 1), a = e.tot, d = e.day; if (!(a[0] > 0)) continue; let l = by.get(id.slice(0, i)); if (!l) by.set(id.slice(0, i), l = []);
    l.push([id.slice(j + 1), id.slice(i + 1, j), r1(a[0]), r1(a[1]), r1(a[2]), a[4] > 0 ? r1(a[3] / a[4] / 60) : null, d[0], d[1], d[2]]); }
  for (const [g, l] of by) by.set(g, l.sort((x, y) => y[2] - x[2] || (x[0] < y[0] ? -1 : 1)).slice(0, top));
  return by;
}

// ---------- Jetzt gestört: Stationen mit Ausfällen und Verspätungen in den letzten Stunden ----------
export const JETZT = { windowH: 2, minN: 8, share: 0.3, skipShare: 0.15, top: 40 };
export const JETZT_FIELDS = ['station', 'name', 'lat', 'lon', 'halte', 'ausgefallen', 'verspaetet'];
/** Zähler je Lauf: onStop(stop, t, ausgefallen, Verspätung s) für Halte in [now − windowH, now); result() = Map Stationsindex → [Halte, ausgefallen, verspätet] */
/** @param {Map<string, number>} stLookup @param {number} now @param {any} [opts] */
export function recentCounter(stLookup, now, { windowH = JETZT.windowH, lateSec = 300 } = {}) {
  /** @type {Map<number, number[]>} */ const m = new Map(), from = now - windowH * 3600e3;
  return {
    onStop(/** @type {string} */ stop, /** @type {number} */ t, /** @type {boolean} */ skipped, /** @type {number | null} */ delay) {
      if (t < from || t >= now) return; const q = stLookup.get(stop); if (q == null) return; let c = m.get(q); if (!c) m.set(q, c = [0, 0, 0]);
      c[0]++; if (skipped) c[1]++; else if (delay != null && delay >= lateSec) c[2]++;
    },
    result: () => m,
  };
}
/**
 * Gestörte Stationen je Gemeinde: ab minN Halten im Fenster und mindestens share ausgefallen oder verspätet (oder skipShare ausgefallen).
 * Rückgabe Map AGS → Zeilen (JETZT_FIELDS), nach Zahl der gestörten Halte absteigend, höchstens top.
 */
/** @param {any} ix @param {Map<number, number[]>} counts @param {any} [opts] */
export function hotspots(ix, counts, { minN = JETZT.minN, share = JETZT.share, skipShare = JETZT.skipShare, top = JETZT.top } = {}) {
  /** @type {Map<string, any[][]>} */ const by = new Map();
  for (const [q, c] of counts) { if (c[0] < minN || !(c[1] + c[2] >= share * c[0] || c[1] >= skipShare * c[0])) continue; const g = ix.ags[ix.st.a[q]]; let l = by.get(g); if (!l) by.set(g, l = []); l.push([ix.st.id[q], ix.st.name[q], ix.st.lat[q], ix.st.lon[q], c[0], c[1], c[2]]); }
  for (const [g, l] of by) by.set(g, l.sort((x, y) => (y[5] + y[6]) - (x[5] + x[6]) || y[4] - x[4] || (x[0] < y[0] ? -1 : 1)).slice(0, top));
  return by;
}

// ---------- Tagesgang: ÖPNV-Halte gegen Sharing-Fahrtbeginne je Ortsstunde ----------
/**
 * Mittel je Ortsstunde über die Tage vor today: pt = Halte mit Echtzeit (incidents ptN), sharing = Fahrtbeginne (forecast/series.json a).
 * Lücke = Stunden, in denen der ÖPNV unter gapShare seines Tageshöchstwerts liegt und Sharing mindestens minSharing Fahrtbeginne hat.
 */
/** @param {Map<string, any>} docs @param {any} series @param {string} ags @param {any} [opts] */
export function dayProfile(docs, series, ags, { today = '9999', gapShare = 0.25, minSharing = 3 } = {}) {
  const pt = new Array(24).fill(0), sh = new Array(24).fill(0); let dp = 0, ds = 0;
  for (const [day, d] of docs) { if (day >= today) continue; const a = d?.ags?.[ags]?.ptN; if (a && a.some((/** @type {number} */ x) => x > 0)) { dp++; for (let h = 0; h < 24; h++) pt[h] += a[h] || 0; }
    const s = series?.days?.[day]?.[`ags:${ags}`]?.a; if (s && s.some((/** @type {number} */ x) => Number.isFinite(x))) { ds++; for (let h = 0; h < 24; h++) sh[h] += Number.isFinite(s[h]) ? s[h] : 0; } }
  if (!dp || !ds) return null;
  const P = pt.map(x => Math.round(x / dp)), Sh = sh.map(x => Math.round(x / ds * 10) / 10), peak = Math.max(...P), gap = [];
  for (let h = 0; h < 24; h++) if (peak > 0 && P[h] < gapShare * peak && Sh[h] >= minSharing) gap.push(h);
  return { days: Math.min(dp, ds), pt: P, sharing: Sh, gap, gapShare, minSharing };
}
