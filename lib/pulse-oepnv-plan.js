// @ts-check
// Mobility Pulse – Fahrplan für die Live-Karte (20.11.2026). Der Echtzeit-Strom von gtfs.de enthält nicht alle Fahrten (Tübingen am 20.11.2026:
// rund 68 % der Abfahrten des Fahrplans, Linien 6 und 11 gar nicht) und meldet viele Fahrten nur mit zwei, drei Halten. Darum hebt der Sammler
// aus dem freien Fahrplan derselben Quelle (gtfs.de, CC BY 4.0; dieselben trip_id wie der Strom) die Fahrten an Stationen in Gemeinden mit Flotte
// auf und nutzt sie zweifach:
//   1. Fahrten im Strom bekommen den ganzen Weg aus dem Fahrplan; gemeldete Halte behalten ihre Zeit, die übrigen bekommen den Fahrplan plus die
//      Verspätung des letzten gemeldeten Halts davor (sonst des ersten danach), wie GTFS-Realtime es vorsieht.
//   2. Fahrten ohne Echtzeit stehen „nach Fahrplan“ auf der Karte (Quelle 'fahrplan', ohne Verspätung). Doppelt gezählt wird nichts: gleiche
//      trip_id am selben Betriebstag, sonst gleiche Linie an derselben Station zur selben Plan-Minute (± tolMin).
// Tabelle (Zwischenspeicher des Sammlers, nicht im Datenstand): Dienste als Bitmaske über days Tage ab day0, Muster (Stationsfolge mit Sekunden ab
// Fahrtbeginn, von vielen Fahrten geteilt) und Fahrten (Muster, Beginn in Sekunden ab Betriebstag, Dienst, Linie, zwei 32-Bit-Hashes der trip_id).
import { berlinUtc } from './pulse-context.js';
import { dayOf } from './pulse-track.js';
import { tripHash } from './pulse-oepnv-linien.js';

export const PLAN = Object.freeze({ version: 1, magic: 'MPF1', days: 14, renewBefore: 3, maxStops: 120, maxDt: 65535, maxDelaySec: 3600, tolMin: 2 });
const DAY = 86400e3;
const addDay = (/** @type {string} */ d, /** @type {number} */ n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const dayDiff = (/** @type {string} */ a, /** @type {string} */ b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY);
/** Beginn eines Betriebstags im Sinn von GTFS (Mittag minus 12 Stunden, Ortszeit), ms */
export const serviceBase = (/** @type {string} */ day) => berlinUtc(day, 12, 0) - 12 * 3600e3;
/** 'H:MM:SS' (auch über 24 Uhr) → Sekunden ab Betriebstag, sonst null */
export function gtfsSec(/** @type {string | undefined} */ s) {
  if (!s) return null; const m = /^\s*(\d{1,3}):(\d{2}):(\d{2})\s*$/.exec(s); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null;
}
const cells = (/** @type {string} */ line) => { if (!line.includes('"')) return line.split(','); const out = []; let cur = '', q = false; for (let i = 0; i < line.length; i++) { const c = line[i]; if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; } else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; } out.push(cur); return out; };
const header = (/** @type {string} */ line) => Object.fromEntries(cells(line.replace(/^﻿/, '').replace(/\r$/, '')).map((h, i) => [h.trim(), i]));
/** Zeilen eines Textes oder Buffers an fn (ohne \r) */
function eachLine(/** @type {string | Uint8Array | null} */ src, /** @type {(l: string, n: number) => void} */ fn) {
  if (!src) return; const B = typeof src === 'string' ? Buffer.from(src, 'utf8') : Buffer.from(src.buffer, src.byteOffset, src.byteLength);
  let n = 0; for (let pos = 0; pos < B.length;) { let end = B.indexOf(10, pos); if (end < 0) end = B.length; const e = end > pos && B[end - 1] === 13 ? end - 1 : end; fn(B.toString('utf8', pos, e), n++); pos = end + 1; }
}

/**
 * Dienste (calendar.txt, calendar_dates.txt) → Map service_id → Bitmaske über days Tage ab day0 (Bit i = Tag day0 + i). Ausnahmen (1 = hinzu,
 * 2 = entfällt) gelten nach dem Wochenplan.
 * @param {string | Uint8Array | null} cal @param {string | Uint8Array | null} dates @param {string} day0 @param {number} [days]
 */
export function serviceMasks(cal, dates, day0, days = PLAN.days) {
  const ymd = Array.from({ length: days }, (_, i) => addDay(day0, i).replace(/-/g, '')), wd = ymd.map(d => ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T12:00:00Z`).getUTCDay()]);
  /** @type {Map<string, number>} */ const m = new Map(); let h = null;
  eachLine(cal, (l, n) => { if (n === 0) { h = header(l); return; } if (!l || !h) return; const c = cells(l); let k = 0; for (let i = 0; i < days; i++) if (c[h[wd[i]]] === '1' && c[h.start_date] <= ymd[i] && c[h.end_date] >= ymd[i]) k |= 1 << i; if (k) m.set(c[h.service_id], (m.get(c[h.service_id]) || 0) | k); });
  const ix = new Map(ymd.map((d, i) => [d, i])); h = null;
  eachLine(dates, (l, n) => { if (n === 0) { h = header(l); return; } if (!l || !h) return; const c = cells(l), i = ix.get(c[h.date]); if (i == null) return; const id = c[h.service_id], k = m.get(id) || 0; if (c[h.exception_type] === '1') m.set(id, k | (1 << i)); else if (c[h.exception_type] === '2') { if (k & (1 << i)) m.set(id, k & ~(1 << i)); } });
  for (const [k, v] of m) if (!v) m.delete(k);
  return m;
}

/**
 * trips.txt → Fahrten der aktiven Dienste: { idOf: Map trip_id → Index, route, svc, h1, h2 (je Fahrt), routes [[Linie, route_type, Ziel]], svcMask }.
 * routes: route_id → [Name, route_type] (OE.routeIndex); Fahrten ohne Linie (weder Name noch Art) und ohne aktiven Dienst fallen weg.
 * @param {Uint8Array | string} buf @param {Record<string, any>} routes @param {Map<string, number>} masks
 */
export function planTrips(buf, routes, masks) {
  /** @type {Map<string, number>} */ const idOf = new Map(), sIdx = new Map(), rKey = new Map(); /** @type {any[]} */ const rList = [], svcMask = [];
  const route = [], svc = [], h1 = [], h2 = []; let h = null, iT = -1, iR = -1, iS = -1, iH = -1;
  eachLine(buf, (l, n) => {
    if (n === 0) { h = header(l); iT = h.trip_id ?? -1; iR = h.route_id ?? -1; iS = h.service_id ?? -1; iH = h.trip_headsign ?? -1; if (iT < 0 || iR < 0 || iS < 0) throw new Error('trips.txt ohne trip_id, route_id oder service_id'); return; }
    if (!l) return; const c = cells(l), tid = c[iT], mask = masks.get(c[iS]); if (!tid || !mask || idOf.has(tid)) return;
    const r = routes[c[iR]]; if (!r || (!r[0] && r[1] == null)) return;
    const hs = iH >= 0 ? (c[iH] || '').trim() : '', k = `${r[0]}\u0001${r[1]}\u0001${hs}`; let ri = rKey.get(k); if (ri == null) { ri = rList.length; rList.push([r[0], r[1], hs]); rKey.set(k, ri); }
    let si = sIdx.get(c[iS]); if (si == null) { si = svcMask.length; svcMask.push(mask); sIdx.set(c[iS], si); }
    const [a, b] = tripHash(tid); idOf.set(tid, route.length); route.push(ri); svc.push(si); h1.push(a); h2.push(b);
  });
  return { idOf, route: Uint32Array.from(route), svc: Uint32Array.from(svc), h1: Uint32Array.from(h1), h2: Uint32Array.from(h2), routes: rList, svcMask: Uint16Array.from(svcMask) };
}

/**
 * Sammler für stop_times.txt (zeilenweise, auch über 30 Mio. Zeilen): nur Halte an Stationen (stLookup: stop_id → Station) von Fahrten aus planTrips.
 * finish() ordnet nach Fahrt und stop_sequence (Zählsortierung, die Datei muss nicht sortiert sein): { off (je Fahrt), q, s (Sekunden), rows, used }.
 * @param {ReturnType<typeof planTrips>} tr @param {Map<string, number>} stLookup
 */
export function stopTimesCollector(tr, stLookup) {
  let cap = 1 << 20, n = 0, rows = 0, h = null, iT = -1, iS = -1, iD = -1, iA = -1, iQ = -1;
  let aT = new Uint32Array(cap), aQ = new Uint32Array(cap), aS = new Int32Array(cap), aN = new Uint32Array(cap);
  const grow = () => { cap *= 2; const g = (/** @type {any} */ o, /** @type {any} */ C) => { const x = new C(cap); x.set(o); return x; }; aT = g(aT, Uint32Array); aQ = g(aQ, Uint32Array); aS = g(aS, Int32Array); aN = g(aN, Uint32Array); };
  return {
    add(/** @type {string} */ line) {
      if (!h) { h = header(line); iT = h.trip_id ?? -1; iS = h.stop_id ?? -1; iD = h.departure_time ?? -1; iA = h.arrival_time ?? -1; iQ = h.stop_sequence ?? -1; if (iT < 0 || iS < 0 || iQ < 0 || (iD < 0 && iA < 0)) throw new Error('stop_times.txt ohne trip_id, stop_id, stop_sequence oder Zeit'); return; }
      if (!line) return; rows++;
      const c = line.indexOf('"') >= 0 ? cells(line) : line.split(','), t = tr.idOf.get(c[iT]); if (t == null) return;
      const q = stLookup.get(c[iS]); if (q == null) return;
      const s = gtfsSec((iD >= 0 && c[iD]) || (iA >= 0 ? c[iA] : '')); if (s == null) return;
      if (n === cap) grow(); aT[n] = t; aQ[n] = q; aS[n] = s; aN[n] = +c[iQ] >>> 0; n++;
    },
    finish() {
      const T = tr.route.length, off = new Uint32Array(T + 1); for (let i = 0; i < n; i++) off[aT[i] + 1]++; for (let t = 0; t < T; t++) off[t + 1] += off[t];
      const pos = off.slice(0, T), q = new Uint32Array(n), s = new Int32Array(n), sq = new Uint32Array(n);
      for (let i = 0; i < n; i++) { const p = pos[aT[i]]++; q[p] = aQ[i]; s[p] = aS[i]; sq[p] = aN[i]; }
      for (let t = 0; t < T; t++) for (let i = off[t] + 1; i < off[t + 1]; i++) { // nach stop_sequence (Einfügen, Fahrten sind kurz und meist schon geordnet)
        const kq = q[i], ks = s[i], kn = sq[i]; let j = i - 1; while (j >= off[t] && sq[j] > kn) { q[j + 1] = q[j]; s[j + 1] = s[j]; sq[j + 1] = sq[j]; j--; } q[j + 1] = kq; s[j + 1] = ks; sq[j + 1] = kn;
      }
      return { off, q, s, rows, used: n };
    },
  };
}

/**
 * Fahrten und Halte → Tabelle. Gleiche Station hintereinander zählt einmal (Abfahrt), Fahrten mit weniger als zwei Stationen fallen weg, Muster
 * enden nach maxStops Stationen oder maxDt Sekunden. Fahrten nach Hash sortiert (Suche je trip_id).
 * @param {ReturnType<typeof planTrips>} tr @param {ReturnType<ReturnType<typeof stopTimesCollector>['finish']>} g @param {{ day0: string, days?: number, builtAt?: number, feed?: any }} o
 */
export function buildPlan(tr, g, { day0, days = PLAN.days, builtAt = 0, feed = null }) {
  /** @type {Map<string, number[]>} */ const pKey = new Map(); const pOff = [0], pQ = /** @type {number[]} */ ([]), pDt = /** @type {number[]} */ ([]);
  const keep = /** @type {number[]} */ ([]), tPat = /** @type {number[]} */ ([]), tStart = /** @type {number[]} */ ([]);
  const qs = /** @type {number[]} */ ([]), ds = /** @type {number[]} */ ([]);
  for (let t = 0; t < tr.route.length; t++) {
    qs.length = 0; ds.length = 0; let s0 = 0;
    for (let i = g.off[t]; i < g.off[t + 1]; i++) {
      const q = g.q[i], s = g.s[i];
      if (qs.length && qs[qs.length - 1] === q) { ds[ds.length - 1] = Math.max(ds[ds.length - 1], s - s0); continue; }
      if (!qs.length) s0 = s; const dt = s - s0; if (dt > PLAN.maxDt || qs.length >= PLAN.maxStops) break;
      qs.push(q); ds.push(Math.max(dt, ds.length ? ds[ds.length - 1] : 0));
    }
    if (qs.length < 2) continue;
    let a = 2166136261, b = 0x9747b28c; for (let i = 0; i < qs.length; i++) { a = Math.imul(a ^ qs[i], 16777619) >>> 0; a = Math.imul(a ^ ds[i], 16777619) >>> 0; b = Math.imul(b ^ (qs[i] * 31 + ds[i]), 2246822519) >>> 0; }
    const k = `${a}:${b}:${qs.length}`, cand = pKey.get(k) || []; let p = -1;
    for (const c of cand) { let same = pOff[c + 1] - pOff[c] === qs.length; for (let i = 0; same && i < qs.length; i++) same = pQ[pOff[c] + i] === qs[i] && pDt[pOff[c] + i] === ds[i]; if (same) { p = c; break; } }
    if (p < 0) { p = pOff.length - 1; for (let i = 0; i < qs.length; i++) { pQ.push(qs[i]); pDt.push(ds[i]); } pOff.push(pQ.length); cand.push(p); pKey.set(k, cand); }
    keep.push(t); tPat.push(p); tStart.push(s0);
  }
  const ord = keep.map((_, i) => i).sort((x, y) => tr.h1[keep[x]] - tr.h1[keep[y]] || tr.h2[keep[x]] - tr.h2[keep[y]]);
  const T = keep.length, P = Uint32Array, out = { tPat: new P(T), tStart: new Int32Array(T), tSvc: new P(T), tRoute: new P(T), tH1: new P(T), tH2: new P(T) };
  ord.forEach((i, j) => { const t = keep[i]; out.tPat[j] = tPat[i]; out.tStart[j] = tStart[i]; out.tSvc[j] = tr.svc[t]; out.tRoute[j] = tr.route[t]; out.tH1[j] = tr.h1[t]; out.tH2[j] = tr.h2[t]; });
  return { v: PLAN.version, day0, days, builtAt, feed, routes: tr.routes, svc: tr.svcMask, pOff: Uint32Array.from(pOff), pQ: Uint32Array.from(pQ), pDt: Uint16Array.from(pDt), ...out, trips: T, patterns: pOff.length - 1 };
}

const ARR = /** @type {const} */ ([['svc', Uint16Array], ['pOff', Uint32Array], ['pQ', Uint32Array], ['pDt', Uint16Array], ['tPat', Uint32Array], ['tStart', Int32Array], ['tSvc', Uint32Array], ['tRoute', Uint32Array], ['tH1', Uint32Array], ['tH2', Uint32Array]]);
/** Tabelle → Bytes: 'MPF1', Länge des JSON-Kopfs (uint32 LE), Kopf, dann die Felder (je auf 4 Bytes ausgerichtet, Byte-Reihenfolge der Maschine: LE) */
/** @param {ReturnType<typeof buildPlan>} t */
export function packPlan(t) {
  const head = Buffer.from(JSON.stringify({ v: t.v, day0: t.day0, days: t.days, builtAt: t.builtAt, feed: t.feed, routes: t.routes, n: ARR.map(([k]) => /** @type {any} */ (t)[k].length) }), 'utf8');
  const parts = [Buffer.from(PLAN.magic, 'latin1'), Buffer.alloc(4), head]; parts[1].writeUInt32LE(head.length, 0); let len = 8 + head.length;
  for (const [k] of ARR) { const pad = (4 - len % 4) % 4; if (pad) { parts.push(Buffer.alloc(pad)); len += pad; } const a = /** @type {any} */ (t)[k]; parts.push(Buffer.from(a.buffer, a.byteOffset, a.byteLength)); len += a.byteLength; }
  return Buffer.concat(parts);
}
/** Bytes → Tabelle (Felder als Sichten auf eine ausgerichtete Kopie) */
/** @param {Uint8Array} bytes */
export function unpackPlan(bytes) {
  const B = new Uint8Array(bytes), dv = new DataView(B.buffer); // Kopie: Anfang auf 0, damit die Sichten ausgerichtet sind
  if (Buffer.from(B.subarray(0, 4)).toString('latin1') !== PLAN.magic) throw new Error('Fahrplan-Tabelle: falsches Format');
  const hl = dv.getUint32(4, true), head = JSON.parse(Buffer.from(B.subarray(8, 8 + hl)).toString('utf8')); if (head.v !== PLAN.version) throw new Error('Fahrplan-Tabelle: andere Fassung');
  /** @type {any} */ const t = { v: head.v, day0: head.day0, days: head.days, builtAt: head.builtAt, feed: head.feed, routes: head.routes }; let p = 8 + hl;
  ARR.forEach(([k, C], i) => { p += (4 - p % 4) % 4; const n = head.n[i]; if (p + n * C.BYTES_PER_ELEMENT > B.length) throw new Error('Fahrplan-Tabelle: abgeschnitten'); t[k] = new C(B.buffer, p, n); p += n * C.BYTES_PER_ELEMENT; });
  t.trips = t.tPat.length; t.patterns = t.pOff.length - 1;
  return /** @type {ReturnType<typeof buildPlan>} */ (t);
}
/** Muss die Tabelle neu gebaut werden? (fehlt, andere Fassung, deckt morgen nicht mehr mit renewBefore Tagen Vorlauf ab) */
export function planStale(/** @type {{ v?: number, day0?: string, days?: number } | null} */ meta, /** @type {number} */ now) {
  if (!meta || meta.v !== PLAN.version || !meta.day0 || !meta.days) return true;
  const i = dayDiff(meta.day0, dayOf(now)); return i < 1 || i > meta.days - PLAN.renewBefore;
}

/**
 * Nachschlagen in der Tabelle: find(trip_id) → Index oder −1; runs(t, Tag); startOf(t, Tag) ms; stops(t) → { q, dt } (Sichten); route(t) →
 * [Linie, route_type, Ziel]; days(now) → Betriebstage gestern, heute, morgen, soweit in der Tabelle.
 * @param {ReturnType<typeof buildPlan>} P
 */
export function planView(P) {
  /** @type {Map<string, number>} */ const base = new Map(), di = new Map();
  const B = (/** @type {string} */ d) => { let b = base.get(d); if (b == null) base.set(d, b = serviceBase(d)); return b; };
  const I = (/** @type {string} */ d) => { let i = di.get(d); if (i == null) di.set(d, i = dayDiff(P.day0, d)); return i; };
  return {
    P,
    find(/** @type {string | null} */ id) {
      if (id == null) return -1; const [a, b] = tripHash(id); let lo = 0, hi = P.tH1.length - 1; if (hi < 0) return -1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (P.tH1[m] < a) lo = m + 1; else hi = m; }
      for (let i = lo; i < P.tH1.length && P.tH1[i] === a; i++) if (P.tH2[i] === b) return i;
      return -1;
    },
    runs(/** @type {number} */ t, /** @type {string} */ d) { const i = I(d); return i >= 0 && i < P.days && ((P.svc[P.tSvc[t]] >> i) & 1) === 1; },
    startOf: (/** @type {number} */ t, /** @type {string} */ d) => B(d) + P.tStart[t] * 1000,
    stops(/** @type {number} */ t) { const p = P.tPat[t]; return { q: P.pQ.subarray(P.pOff[p], P.pOff[p + 1]), dt: P.pDt.subarray(P.pOff[p], P.pOff[p + 1]) }; },
    route: (/** @type {number} */ t) => P.routes[P.tRoute[t]],
    days: (/** @type {number} */ now) => [dayOf(now - DAY), dayOf(now), dayOf(now + DAY)].filter(d => I(d) >= 0 && I(d) < P.days),
  };
}

/**
 * Fahrt aus dem Strom mit dem Fahrplan zusammenführen. rt: gemeldete Halte [{ q, t (ms), d (s | null) }] in Reihenfolge, skip: ausgefallene Stationen
 * [q …], date: Betriebstag aus dem Strom ('JJJJ-MM-TT' oder null). Rückgabe null (Fahrt fehlt im Fahrplan, kein Halt passt, Abweichung über
 * maxDelaySec) oder { t, day, pts: [{ q, t, d, k }], sk: [{ q, k }], matched } mit k = Index im Muster.
 * @param {ReturnType<typeof planView>} V @param {string | null} id @param {Array<{ q: number, t: number, d: number | null }>} rt @param {number[]} skip @param {string | null} date @param {number} now
 */
export function mergeTrip(V, id, rt, skip, date, now) {
  const t = V.find(id); if (t < 0 || !rt.length) return null;
  const { q: Q, dt } = V.stops(t), n = Q.length;
  let best = null;
  for (const d of date ? [date] : V.days(now)) {
    if (!V.runs(t, d)) continue; const s0 = V.startOf(t, d);
    /** @type {number[]} */ const at = new Array(rt.length).fill(-1); let j = 0, cost = 0, hit = 0;
    for (let r = 0; r < rt.length; r++) { for (let i = j; i < n; i++) if (Q[i] === rt[r].q) { at[r] = i; j = i + 1; break; } if (at[r] >= 0) { hit++; cost += Math.abs(rt[r].t - (rt[r].d ?? 0) * 1000 - (s0 + dt[at[r]] * 1000)); } }
    if (hit && (!best || hit > best.hit || (hit === best.hit && cost < best.cost))) best = { d, s0, at, hit, cost };
  }
  if (!best) return null;
  /** @type {Array<number | null>} */ const tAt = new Array(n).fill(null), dAt = new Array(n).fill(null);
  for (let r = 0; r < rt.length; r++) { const i = best.at[r]; if (i < 0) continue; const delay = (rt[r].t - (best.s0 + dt[i] * 1000)) / 1000; if (Math.abs(delay) > PLAN.maxDelaySec) return null; tAt[i] = rt[r].t; dAt[i] = rt[r].d ?? Math.round(delay); }
  const skipSet = new Set(skip), pts = [], sk = []; let cur = null, prevT = -Infinity;
  const first = dAt.findIndex(x => x != null); cur = first >= 0 ? dAt[first] : 0;
  for (let i = 0; i < n; i++) {
    if (dAt[i] != null) cur = dAt[i];
    if (skipSet.has(Q[i]) && tAt[i] == null) { sk.push({ q: Q[i], k: i }); continue; }
    const tt = Math.max(prevT, tAt[i] ?? best.s0 + (dt[i] + (cur || 0)) * 1000); prevT = tt;
    pts.push({ q: Q[i], t: tt, d: dAt[i] ?? cur ?? null, k: i });
  }
  return { t, day: best.d, pts, sk, matched: best.hit };
}

/**
 * Fahrten ohne Echtzeit im Fenster [now, until] (letzter Halt nach now, erster Halt vor until): je Fahrt cb(t, Tag, pts [{ q, t, d: null, k }]).
 * seen: Set 't|Tag' der Fahrten, die der Strom schon nennt; keys: Set 'Station|Plan-Minute|Linie' der Halte von Fahrten im Strom, die im Fahrplan
 * nicht gefunden wurden (andere trip_id); passt ein Halt (± tolMin), gilt die Fahrt als im Strom.
 * @param {ReturnType<typeof planView>} V @param {number} now @param {number} until @param {Set<string>} seen @param {Set<string>} keys
 * @param {(t: number, day: string, pts: Array<{ q: number, t: number, d: null, k: number }>) => void} cb
 */
export function planOnly(V, now, until, seen, keys, cb) {
  const P = V.P; let n = 0, dup = 0;
  for (const d of V.days(now)) {
    const b = serviceBase(d), i = dayDiff(P.day0, d);
    for (let t = 0; t < P.tPat.length; t++) {
      if (((P.svc[P.tSvc[t]] >> i) & 1) === 0) continue;
      const p = P.tPat[t], a = P.pOff[p], e = P.pOff[p + 1], s0 = b + P.tStart[t] * 1000;
      if (s0 > until || s0 + P.pDt[e - 1] * 1000 <= now || seen.has(`${t}|${d}`)) continue;
      const line = P.routes[P.tRoute[t]]?.[0] || '', pts = []; let hit = false;
      for (let k = a; k < e; k++) { const tt = s0 + P.pDt[k] * 1000; pts.push({ q: P.pQ[k], t: tt, d: null, k: k - a }); if (!hit && keys.size && tt >= now - 3600e3 && tt <= until + 3600e3) { const m = Math.floor(tt / 60e3); for (let x = -PLAN.tolMin; x <= PLAN.tolMin && !hit; x++) hit = keys.has(`${P.pQ[k]}|${m + x}|${line}`); } }
      if (hit) { dup++; continue; }
      n++; cb(t, d, /** @type {any} */ (pts));
    }
  }
  return { trips: n, dup };
}

/**
 * Fahrplanzeit je Halt einer Fahrt für Ströme ohne Zeiten (nur Verspätung, gtfs.de seit 22.11.2026): (tripId, Tag) → null (Fahrt nicht im Fahrplan
 * oder fährt an dem Tag nicht) oder (stopId) → ms | null. Halte in Reihenfolge abfragen: gesucht wird ab dem zuletzt getroffenen Musterplatz
 * (Schleifen). Nur Stationen in Gemeinden mit Flotte stehen im Muster, andere Halte bleiben ohne Zeit.
 * @param {ReturnType<typeof planView>} V @param {Map<string, number>} stLk Halt → Station (OE.stationLookup, derselbe Index wie beim Bau)
 */
export function scheduleTimes(V, stLk) {
  return (/** @type {string | null} */ id, /** @type {string} */ day) => {
    const t = V.find(id); if (t < 0 || !V.runs(t, day)) return null;
    const { q: Q, dt } = V.stops(t), s0 = V.startOf(t, day); let j = 0;
    return (/** @type {string} */ stop) => { const q = stLk.get(stop); if (q == null) return null; for (let i = j; i < Q.length; i++) if (Q[i] === q) { j = i + 1; return s0 + dt[i] * 1000; } return null; };
  };
}
