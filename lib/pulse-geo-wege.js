// @ts-check
// Mobility Pulse – Streckenverläufe für die Live-Karte (Geo-Lauf, 17.11.2026). Der freie Fahrplan von gtfs.de hat keine shapes.txt (Mobility Database,
// Merkmale des Feeds nv_free: ohne „Shapes“; gtfs.de reichert nur die bezahlten Fassungen mit Geodaten an). Darum je Verbindung Station → Station, wie sie
// im Fahrplan vorkommt, der kürzeste Weg im OpenStreetMap-Netz (© OpenStreetMap-Mitwirkende, ODbL): Bahnen (S-, U-, Stadt-, Straßen-, Regional-,
// Fernbahn) auf Gleisen, Busse auf Straßen mit Einbahnregeln. Stationen werden an alle Netzknoten im Umkreis angebunden (Mehrfachstart, Abstand mal
// Strafe), damit große Bahnhöfe nicht am falschen Gleis hängen. Ein Weg gilt nur, wenn er höchstens maxRatio × Luftlinie + maxExtraM lang ist.
// Ergebnis je Stadt: Schlüssel wie lib/pulse-oepnv-wege.js segKey → Polyline (Douglas-Peucker, tolRoad/tolRail Meter).
import { distM, pointIndex } from './pulse-geo-proj.js';
import { encodePolyline, segKey } from './pulse-oepnv-wege.js';
import { modeClass } from './pulse-oepnv-karte.js';

export const WEGE_GEO = Object.freeze({ cities: 30, budgetMin: 150, roadBufM: 2000, railBufM: 25000, railMaxM: 130000, tileLat: 0.5, tileLon: 0.75,
  snapRoad: 120, snapRail: 300, maxCand: 40, penalty: 2, maxRatio: 2.5, maxExtraM: 3000, minAirM: 100, tolRoad: 4, tolRail: 8 });
const ROADS = 'motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service|busway|bus_guideway|road';
/** Straßennetz für Busse in bbox [Süd, West, Nord, Ost] (mit Tags für Einbahnregeln); Zufahrten, Parkplatzgassen und gesperrte Wege fallen weg, Busspuren bleiben */
export const overpassRoad = (/** @type {number[]} */ bb) => { const b = `(${bb.join(',')})`;
  return `[out:json][timeout:300];(way["highway"~"^(${ROADS})$"]["access"!~"^(no|private)$"]["service"!~"^(parking_aisle|driveway|drive-through|emergency_access)$"]${b};way["highway"]["bus"~"^(yes|designated)$"]${b};way["highway"]["psv"~"^(yes|designated)$"]${b};);out body qt;>;out skel qt;`; };
/** Gleisnetz in bbox (ohne Abstell- und Rangiergleise); ohne Tags */
export const overpassRail = (/** @type {number[]} */ bb) => `[out:json][timeout:300];way["railway"~"^(rail|light_rail|subway|tram|narrow_gauge|monorail)$"]["service"!~"^(yard|siding|spur)$"](${bb.join(',')});(._;>;);out skel qt;`;
/** Kacheln (Schlüssel 'i:j', bbox [S, W, N, O]) für das Gleisnetz, die bbox überdecken: benachbarte Städte teilen sich die Abfragen */
export function railTiles(/** @type {number[]} */ bb, T = WEGE_GEO) {
  const out = []; for (let i = Math.floor(bb[0] / T.tileLat); i * T.tileLat < bb[2]; i++) for (let j = Math.floor(bb[1] / T.tileLon); j * T.tileLon < bb[3]; j++) out.push({ key: `${i}:${j}`, bb: [i * T.tileLat, j * T.tileLon, (i + 1) * T.tileLat, (j + 1) * T.tileLon].map(x => Math.round(x * 1000) / 1000) });
  return out;
}

/** Richtung eines Wegs für Busse: 1 = nur vorwärts, −1 = nur rückwärts, 0 = beide (Busse dürfen gegen die Einbahn, wo oneway:bus/psv = no) */
export function onewayOf(/** @type {Record<string, string> | undefined} */ t) {
  if (!t) return 0; if ((t['oneway:bus'] || t['oneway:psv']) === 'no' || t.busway === 'opposite_lane') return 0;
  const o = t.oneway; if (o === 'yes' || o === '1' || o === 'true') return 1; if (o === '-1' || o === 'reverse') return -1;
  if (o !== 'no' && (t.junction === 'roundabout' || t.junction === 'circular' || t.highway === 'motorway')) return 1;
  return 0;
}
/** Kostenfaktor je Straßenart für Busse: Hauptstraßen und Busspuren vor Wohn- und Nebenstraßen, damit der Verlauf der Linie folgt statt kürzesten Abkürzungen */
export const ROAD_COST = Object.freeze({ motorway: 1, motorway_link: 1, trunk: 1, trunk_link: 1, primary: 1, primary_link: 1, secondary: 1, secondary_link: 1,
  tertiary: 1.1, tertiary_link: 1.1, unclassified: 1.25, road: 1.25, residential: 1.4, service: 2, living_street: 2.5, busway: 0.8, bus_guideway: 0.8 });
/** Faktor eines Wegs: Busspur oder für Busse ausgewiesen 0,8 bzw. 0,9; sonst nach Straßenart (unbekannt 1,5) */
export function costOf(/** @type {Record<string, string> | undefined} */ t) {
  if (!t) return 1; if (t.bus === 'designated' || t.psv === 'designated') return 0.8;
  if (t.busway === 'lane' || t['busway:both'] === 'lane' || t['busway:left'] === 'lane' || t['busway:right'] === 'lane' || t['bus:lanes'] || t['lanes:bus'] || t['psv:lanes']) return 0.9;
  return /** @type {Record<string, number>} */ (ROAD_COST)[t.highway] ?? 1.5;
}
/** Gerichteter Graph (CSR) aus Overpass-Elementen (auch mehrere Antworten hintereinander; doppelte Knoten zählen einmal): { n, lat, lon, off, adj, w }; w = Meter × Faktor (Straße) */
/** @param {any[]} elements @param {{ directed?: boolean }} [o] */
export function buildNet(elements, { directed = false } = {}) {
  const idx = new Map(), lat = [], lon = [];
  for (const e of elements) if (e.type === 'node' && !idx.has(e.id)) { idx.set(e.id, lat.length); lat.push(e.lat); lon.push(e.lon); }
  const ea = [], eb = [], ew = [];
  for (const e of elements) if (e.type === 'way' && e.nodes?.length > 1) {
    const dir = directed ? onewayOf(e.tags) : 0, f = directed ? costOf(e.tags) : 1;
    for (let i = 1; i < e.nodes.length; i++) {
      const a = idx.get(e.nodes[i - 1]), b = idx.get(e.nodes[i]); if (a == null || b == null || a === b) continue;
      const d = distM(lat[a], lon[a], lat[b], lon[b]) * f;
      if (dir >= 0) { ea.push(a); eb.push(b); ew.push(d); } if (dir <= 0) { ea.push(b); eb.push(a); ew.push(d); }
    }
  }
  const n = lat.length, off = new Int32Array(n + 1); for (const a of ea) off[a + 1]++; for (let i = 0; i < n; i++) off[i + 1] += off[i];
  const pos = off.slice(0, n), adj = new Int32Array(ea.length), w = new Float32Array(ea.length);
  for (let k = 0; k < ea.length; k++) { const p = pos[ea[k]]++; adj[p] = eb[k]; w[p] = ew[k]; }
  return { n, lat: Float64Array.from(lat), lon: Float64Array.from(lon), off, adj, w };
}

/**
 * Router auf einem Netz: route(a, targets, snapM) mit a = [lat, lon] und targets = [{ key, b: [lat, lon] }] → Map key → { pts: [[lat, lon], …] (Knotenfolge
 * ohne die Stationen), len (m, mit Anbindung) }. Start und Ziel an bis zu maxCand Knoten im Umkreis snapM, Anbindung zählt penalty-fach.
 */
/** @param {ReturnType<typeof buildNet>} g */
export function makeRouter(g, T = WEGE_GEO) {
  const nodes = pointIndex(Array.from({ length: g.n }, (_, i) => [g.lat[i], g.lon[i]]), 100);
  const dist = new Float64Array(g.n).fill(Infinity), prev = new Int32Array(g.n).fill(-1); let touched = /** @type {number[]} */ ([]);
  let hn = new Int32Array(1024), hd = new Float64Array(1024), hs = 0;
  const push = (/** @type {number} */ v, /** @type {number} */ d) => {
    if (hs >= hn.length) { const n2 = new Int32Array(hn.length * 2), d2 = new Float64Array(hn.length * 2); n2.set(hn); d2.set(hd); hn = n2; hd = d2; }
    let i = hs++; while (i > 0) { const p = (i - 1) >> 1; if (hd[p] <= d) break; hn[i] = hn[p]; hd[i] = hd[p]; i = p; } hn[i] = v; hd[i] = d;
  };
  const pop = () => { const v = hn[0], d = hd[0], ln = hn[--hs], ld = hd[hs]; let i = 0; for (;;) { let c = 2 * i + 1; if (c >= hs) break; if (c + 1 < hs && hd[c + 1] < hd[c]) c++; if (hd[c] >= ld) break; hn[i] = hn[c]; hd[i] = hd[c]; i = c; } hn[i] = ln; hd[i] = ld; return [v, d]; };
  const cand = (/** @type {number[]} */ p, /** @type {number} */ r) => nodes.within(p[0], p[1], r).map(id => [id, distM(p[0], p[1], g.lat[id], g.lon[id])]).sort((x, y) => x[1] - y[1]).slice(0, T.maxCand);
  return {
    cand,
    /** @param {number[]} a @param {{ key: string, b: number[] }[]} targets @param {number} snapM */
    route(a, targets, snapM) {
      const out = new Map(), src = cand(a, snapM); if (!src.length) return out;
      const tg = targets.map(x => ({ ...x, c: cand(x.b, snapM), air: distM(a[0], a[1], x.b[0], x.b[1]) })).filter(x => x.c.length);
      if (!tg.length) return out;
      const cutoff = Math.max(...tg.map(x => x.air * T.maxRatio + T.maxExtraM)) + snapM * T.penalty * 2;
      for (const v of touched) { dist[v] = Infinity; prev[v] = -1; } touched = []; hs = 0;
      for (const [id, d] of src) { const dd = d * T.penalty; if (dd < dist[id]) { if (dist[id] === Infinity) touched.push(id); dist[id] = dd; push(id, dd); } }
      while (hs > 0) {
        const [v, d] = pop(); if (d > dist[v]) continue; if (d > cutoff) break;
        for (let k = g.off[v]; k < g.off[v + 1]; k++) { const u = g.adj[k], nd = d + g.w[k]; if (nd < dist[u]) { if (dist[u] === Infinity) touched.push(u); dist[u] = nd; prev[u] = v; push(u, nd); } }
      }
      for (const x of tg) {
        let best = -1, bd = Infinity; for (const [id, d] of x.c) { const v = dist[id] + d * T.penalty; if (v < bd) { bd = v; best = id; } }
        if (best < 0 || !Number.isFinite(bd)) continue;
        const path = []; for (let v = best, guard = 0; v >= 0 && guard < 1e6; v = prev[v], guard++) path.push([g.lat[v], g.lon[v]]);
        path.reverse();
        let len = distM(a[0], a[1], path[0][0], path[0][1]) + distM(path[path.length - 1][0], path[path.length - 1][1], x.b[0], x.b[1]);
        for (let i = 1; i < path.length; i++) len += distM(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
        out.set(x.key, { pts: path, len, air: x.air });
      }
      return out;
    },
  };
}

/** Douglas-Peucker in Metern (örtliche Projektion) */
/** @param {number[][]} pts @param {number} tol */
export function simplify(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const k = Math.cos(pts[0][0] * Math.PI / 180) * 111320, P = pts.map(p => [p[1] * k, p[0] * 111320]), keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const st = [[0, pts.length - 1]];
  while (st.length) {
    const [i, j] = /** @type {number[]} */ (st.pop()); let md = 0, mi = -1;
    const [x1, y1] = P[i], [x2, y2] = P[j], dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy;
    for (let m = i + 1; m < j; m++) { const [x, y] = P[m]; let t = L2 > 0 ? ((x - x1) * dx + (y - y1) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t)); const d = Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)); if (d > md) { md = d; mi = m; } }
    if (mi >= 0 && md > tol) { keep[mi] = 1; st.push([i, mi], [mi, j]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * Verbindungen aus stop_times.txt: add(tripId, stopSequence, stopId) für jede Zeile; result() → Map 'Netz|qA|qB' → Fahrten. Nur Fahrten aus trips
 * (Map tripId → Netz 'r' | 's') und Halte mit Station (stLookup: stop_id → Station); wie die Fahrzeugwege der Live-Datei: Halte ohne Station fallen weg,
 * gleiche Station hintereinander zählt einmal. Zählsortierung nach Fahrt, dann je Fahrt nach Halt-Nummer (stop_times muss nicht sortiert sein).
 */
/** @param {Map<string, string>} trips @param {Map<string, number>} stLookup */
export function pairCollector(trips, stLookup) {
  const tIx = new Map(), tNet = []; let T = new Int32Array(1 << 20), S = new Int32Array(1 << 20), Q = new Int32Array(1 << 20), n = 0, rows = 0;
  const grow = () => { const m = T.length * 2, t2 = new Int32Array(m), s2 = new Int32Array(m), q2 = new Int32Array(m); t2.set(T); s2.set(S); q2.set(Q); T = t2; S = s2; Q = q2; };
  return {
    /** @param {string} tripId @param {number} seq @param {string} stopId */
    add(tripId, seq, stopId) {
      rows++; const net = trips.get(tripId); if (!net) return; const q = stLookup.get(stopId); if (q == null) return;
      let ti = tIx.get(tripId); if (ti == null) { ti = tNet.length; tIx.set(tripId, ti); tNet.push(net); }
      if (n >= T.length) grow(); T[n] = ti; S[n] = seq; Q[n] = q; n++;
    },
    result() {
      const nt = tNet.length, start = new Int32Array(nt + 1); for (let i = 0; i < n; i++) start[T[i] + 1]++; for (let i = 0; i < nt; i++) start[i + 1] += start[i];
      const pos = start.slice(0, nt), ord = new Int32Array(n); for (let i = 0; i < n; i++) ord[pos[T[i]]++] = i;
      /** @type {Map<string, number>} */ const pairs = new Map();
      for (let t = 0; t < nt; t++) {
        const a = start[t], b = start[t + 1]; if (b - a < 2) continue;
        const g = Array.from(ord.subarray(a, b)).sort((x, y) => S[x] - S[y]); let last = -1;
        for (const i of g) { const q = Q[i]; if (q === last) continue; if (last >= 0) { const k = `${tNet[t]}|${last}|${q}`; pairs.set(k, (pairs.get(k) || 0) + 1); } last = q; }
      }
      return { pairs, rows, used: n, trips: nt };
    },
  };
}
/** Netz einer Fahrt aus der Linie (routes.txt: route_type, Kurzname): Bus → 's', alle Bahnen → 'r', anderes (Fähre, Seilbahn) → null */
export const netOfRoute = (/** @type {number | null} */ rt, /** @type {string} */ name) => { const m = modeClass(rt, name); return m === 'bus' ? 's' : m === 'sonst' ? null : 'r'; };

/**
 * Verbindungen einer Stadt routen. pairs: [{ net, a: [lat, lon], b: [lat, lon] }]; routerOf(net) → Router oder null (Netz fehlt).
 * Rückgabe { segs: { segKey → Polyline }, stats: { pairs, routed, short, noNet, noPath, tooLong } }. Gleicher Start wird zusammen gerechnet.
 */
/** @param {Array<{ net: string, a: number[], b: number[] }>} pairs @param {(net: string) => ReturnType<typeof makeRouter> | null} routerOf */
export function routePairs(pairs, routerOf, T = WEGE_GEO) {
  /** @type {Record<string, string>} */ const segs = {}; const stats = { pairs: pairs.length, routed: 0, short: 0, noNet: 0, noPath: 0, tooLong: 0 };
  /** @type {Map<string, { net: string, a: number[], list: { key: string, b: number[] }[] }>} */ const bySrc = new Map();
  for (const p of pairs) {
    if (distM(p.a[0], p.a[1], p.b[0], p.b[1]) < T.minAirM) { stats.short++; continue; }
    const k = `${p.net}|${p.a}`; let s = bySrc.get(k); if (!s) bySrc.set(k, s = { net: p.net, a: p.a, list: [] });
    s.list.push({ key: segKey(p.net, p.a[0], p.a[1], p.b[0], p.b[1]), b: p.b });
  }
  for (const s of bySrc.values()) {
    const r = routerOf(s.net); if (!r) { stats.noNet += s.list.length; continue; }
    const res = r.route(s.a, s.list, s.net === 's' ? T.snapRoad : T.snapRail);
    for (const x of s.list) {
      const v = res.get(x.key); if (!v) { stats.noPath++; continue; }
      const air = distM(s.a[0], s.a[1], x.b[0], x.b[1]); if (v.len > air * T.maxRatio + T.maxExtraM) { stats.tooLong++; continue; }
      const line = simplify([s.a, ...v.pts, x.b], s.net === 's' ? T.tolRoad : T.tolRail); if (line.length <= 2) { stats.short++; continue; }
      segs[x.key] = encodePolyline(line); stats.routed++;
    }
  }
  return { segs, stats };
}
