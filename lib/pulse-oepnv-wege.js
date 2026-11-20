// @ts-check
// Mobility Pulse – Streckenverläufe für die Live-Karte im Reiter ÖPNV (17.11.2026), Teil für den Browser.
// Der freie Fahrplan von gtfs.de hat keine shapes.txt; der Geo-Lauf (scripts/geo/wege.mjs, lib/pulse-geo-wege.js) legt je Verbindung Station → Station
// den kürzesten Weg im OpenStreetMap-Netz ab (Bahnen auf Gleisen, Busse auf Straßen) → wege/<AGS>.json. Schlüssel: Netz und die Lage beider Stationen,
// genau wie in den Fahrzeugwegen (oepnv/live/<AGS>.json, 5 Nachkommastellen). Fehlt ein Verlauf, setzt wegeLookup ihn aus Nachbarabschnitten zusammen (CHAIN).
import { distM } from './pulse-geo-proj.js';

export const WEGE = Object.freeze({ version: 1, precision: 1e5 });
/** Lücken überbrücken (18.11.2026): Die Echtzeit lässt Halte aus (Abschnitt Feuerbach → Zuffenhausen statt über Neuwirtshaus); fehlt eine Verbindung,
 * setzt die Karte sie aus bekannten Abschnitten über höchstens maxHops Stationen zusammen, wenn der Umweg (Summe der Luftlinien) höchstens
 * ratio × Luftlinie + extraM ist. Stuttgart 18.11. 23:16: 193 von 904 Abschnitten ohne Verlauf. Schiene seit 20.11.2026 über bis zu maxHopsRail
 * Stationen: Bahnen meldet der Strom oft nur mit erstem und letztem Halt (Karlsruhe 20.11. 23:30: 0 von 32 Straßenbahn-Abschnitten mit Verlauf). */
export const CHAIN = Object.freeze({ maxHops: 8, maxHopsRail: 40, ratio: 1.5, extraM: 300 });
/** Netz eines Verkehrsmittels: 's' = Straße (Bus), 'r' = Schiene (alles andere); 'sonst' versucht beide */
export const netOf = (/** @type {string} */ art) => (art === 'bus' ? 's' : art === 'sonst' ? null : 'r');
/** Schlüssel einer gerichteten Verbindung (Lage wie in den Fahrzeugwegen) */
export const segKey = (/** @type {string} */ net, /** @type {number} */ aLat, /** @type {number} */ aLon, /** @type {number} */ bLat, /** @type {number} */ bLon) => `${net}:${aLat},${aLon}|${bLat},${bLon}`;

/** Polyline-Kodierung (Google, 5 Nachkommastellen) von [[lat, lon], …] */
/** @param {number[][]} pts */
export function encodePolyline(pts, p = WEGE.precision) {
  let out = '', pa = 0, po = 0;
  const enc = (/** @type {number} */ v) => { let x = v < 0 ? ~(v << 1) : v << 1; while (x >= 0x20) { out += String.fromCharCode((0x20 | (x & 0x1f)) + 63); x >>= 5; } out += String.fromCharCode(x + 63); };
  for (const [la, lo] of pts) { const a = Math.round(la * p), o = Math.round(lo * p); enc(a - pa); enc(o - po); pa = a; po = o; }
  return out;
}
/** @param {string} s @returns {number[][]} */
export function decodePolyline(s, p = WEGE.precision) {
  const out = []; let i = 0, la = 0, lo = 0;
  const dec = () => { let r = 0, sh = 0, b; do { b = s.charCodeAt(i++) - 63; r |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20 && i < s.length); return r & 1 ? ~(r >> 1) : r >> 1; };
  while (i < s.length) { la += dec(); lo += dec(); out.push([la / p, lo / p]); }
  return out;
}

/**
 * Nachschlagen in wege/<AGS>.json: get(art, aLat, aLon, bLat, bLon) → Punkte von a nach b (dekodiert, zwischengespeichert; liegt nur die Gegenrichtung
 * vor, umgedreht) oder null. stats() zählt Treffer und Fehlschläge seit dem letzten reset().
 */
/** @param {any} doc */
export function wegeLookup(doc) {
  const segs = doc?.segs || {}, cache = new Map(); let hit = 0, miss = 0;
  /** @param {string} key */
  const one = (key) => { if (cache.has(key)) return cache.get(key); const s = segs[key]; const v = typeof s === 'string' ? decodePolyline(s) : null; cache.set(key, v); return v; };
  /** @param {string | null} net @param {number} aLat @param {number} aLon @param {number} bLat @param {number} bLon @returns {number[][] | null} */
  const find = (net, aLat, aLon, bLat, bLon) => {
    for (const n of net ? [net] : ['r', 's']) {
      const f = one(segKey(n, aLat, aLon, bLat, bLon)); if (f) return f;
      const r = one(segKey(n, bLat, bLon, aLat, aLon)); if (r) { const v = r.slice().reverse(); cache.set(segKey(n, aLat, aLon, bLat, bLon), v); return v; }
    }
    return null;
  };
  // Stationsnetz je Netz aus den Schlüsseln (ungerichtet, Gewicht = Luftlinie), erst beim ersten Fehlschlag
  /** @type {Map<string, Map<string, Array<[string, number]>>>} */ const graphs = new Map();
  const graph = (/** @type {string} */ n) => { let g = graphs.get(n); if (g) return g; g = new Map(); graphs.set(n, g);
    for (const k of Object.keys(segs)) { if (!k.startsWith(`${n}:`)) continue; const [a, b] = k.slice(n.length + 1).split('|'); if (!a || !b) continue;
      const pa = a.split(',').map(Number), pb = b.split(',').map(Number), d = distM(pa[0], pa[1], pb[0], pb[1]);
      for (const [x, y] of [[a, b], [b, a]]) { let l = g.get(x); if (!l) g.set(x, l = []); if (!l.some(e => e[0] === y)) l.push([y, d]); } }
    return g; };
  /** @param {string} n @param {number} aLat @param {number} aLon @param {number} bLat @param {number} bLon @returns {number[][] | null} */
  const chain = (n, aLat, aLon, bLat, bLon) => {
    const g = graph(n), A = `${aLat},${aLon}`, B = `${bLat},${bLon}`; if (!g.has(A) || !g.has(B)) return null;
    const lim = CHAIN.ratio * distM(aLat, aLon, bLat, bLon) + CHAIN.extraM, maxHops = n === 'r' ? CHAIN.maxHopsRail : CHAIN.maxHops, best = new Map([[A, 0]]), prev = new Map(), hops = new Map([[A, 0]]);
    /** @type {Array<[number, string]>} */ const q = [[0, A]]; // Binärhalde nach Länge
    const push = (/** @type {[number, string]} */ x) => { q.push(x); for (let i = q.length - 1; i > 0;) { const p = (i - 1) >> 1; if (q[p][0] <= q[i][0]) break; [q[p], q[i]] = [q[i], q[p]]; i = p; } };
    const pop = () => { const top = q[0], last = /** @type {[number, string]} */ (q.pop()); if (q.length) { q[0] = last; for (let i = 0; ;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < q.length && q[l][0] < q[m][0]) m = l; if (r < q.length && q[r][0] < q[m][0]) m = r; if (m === i) break; [q[m], q[i]] = [q[i], q[m]]; i = m; } } return top; };
    while (q.length) {
      const [d, v] = pop();
      if (v === B) break; if (d > (best.get(v) ?? Infinity) || (hops.get(v) || 0) >= maxHops) continue;
      for (const [u, w] of g.get(v) || []) { const nd = d + w; if (nd > lim || nd >= (best.get(u) ?? Infinity)) continue; best.set(u, nd); prev.set(u, v); hops.set(u, (hops.get(v) || 0) + 1); push([nd, u]); }
    }
    if (!prev.has(B)) return null;
    const st = [B]; for (let v = B; v !== A;) { v = /** @type {string} */ (prev.get(v)); st.push(v); } st.reverse();
    const out = []; for (let i = 1; i < st.length; i++) { const [p, r] = [st[i - 1], st[i]].map(x => x.split(',').map(Number)); const f = find(n, p[0], p[1], r[0], r[1]); if (!f) return null; for (const pt of out.length ? f.slice(1) : f) out.push(pt); }
    return out.length > 1 ? out : null;
  };
  /** @param {string | null} net @param {number} aLat @param {number} aLon @param {number} bLat @param {number} bLon */
  const findOrChain = (net, aLat, aLon, bLat, bLon) => {
    const v = find(net, aLat, aLon, bLat, bLon); if (v) return v;
    const ck = `c|${net}|${aLat},${aLon}|${bLat},${bLon}`; if (cache.has(ck)) return cache.get(ck);
    let c = null; for (const n of net ? [net] : ['r', 's']) { c = chain(n, aLat, aLon, bLat, bLon); if (c) break; }
    cache.set(ck, c); return c;
  };
  return {
    size: Object.keys(segs).length,
    /** @param {string} art @param {number} aLat @param {number} aLon @param {number} bLat @param {number} bLon */
    get(art, aLat, aLon, bLat, bLon) { const v = findOrChain(netOf(art), aLat, aLon, bLat, bLon); if (v) hit++; else miss++; return v; },
    stats: () => ({ hit, miss }), reset() { hit = 0; miss = 0; },
  };
}

/** Kumulierte Längen (m) einer Punktfolge */
/** @param {number[][]} pts */
export function cumLen(pts) { const c = [0]; for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + distM(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1])); return c; }
/** Punkt beim Anteil f (0–1) der Länge einer Punktfolge; cum = cumLen(pts) */
/** @param {number[][]} pts @param {number[]} cum @param {number} f */
export function pointAt(pts, cum, f) {
  const L = cum[cum.length - 1]; if (!(L > 0) || pts.length < 2) return pts[0];
  const d = Math.max(0, Math.min(1, f)) * L; let i = 1; while (i < cum.length - 1 && cum[i] < d) i++;
  const s = cum[i] - cum[i - 1], g = s > 0 ? (d - cum[i - 1]) / s : 0;
  return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * g, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * g];
}
/**
 * Wie positionAt (lib/pulse-oepnv-karte.js), zwischen zwei Stationen aber entlang des Streckenverlaufs geom(i) (Punkte von Station i−1 nach i oder null
 * = Luftlinie). Der Anteil der Zeit wird zum Anteil der Länge. geom liefert zwischengespeicherte Punkte samt cum.
 * snap (Live-Karte, 18.11.2026): ohne Verlauf steht das Fahrzeug an der näheren Station statt quer über Häuser auf der Luftlinie.
 */
/** @param {number[]} w @param {number} dt @param {(i: number) => { pts: number[][], cum: number[] } | null} geom @param {number} [waitSec] @param {boolean} [snap] */
export function positionAlong(w, dt, geom, waitSec = 120, snap = false) {
  const n = w.length / 3; if (n < 1) return null;
  if (dt < w[2]) return w[2] - dt <= waitSec ? [w[0], w[1]] : null;
  for (let i = 1; i < n; i++) {
    const t0 = w[3 * i - 1], t1 = w[3 * i + 2]; if (dt > t1) continue;
    const f = t1 > t0 ? (dt - t0) / (t1 - t0) : 1, g = geom(i);
    if (g) return pointAt(g.pts, g.cum, f);
    if (snap) return f < 0.5 ? [w[3 * i - 3], w[3 * i - 2]] : [w[3 * i], w[3 * i + 1]];
    return [w[3 * i - 3] + (w[3 * i] - w[3 * i - 3]) * f, w[3 * i - 2] + (w[3 * i + 1] - w[3 * i - 2]) * f];
  }
  return null;
}
/** Ganzer Weg [lat, lon, dt, …] als Punktfolge, mit Streckenverlauf, wo vorhanden */
/** @param {number[]} w @param {(i: number) => { pts: number[][] } | null} geom */
export function pathPoints(w, geom) {
  const out = []; const n = w.length / 3; if (n) out.push([w[0], w[1]]);
  for (let i = 1; i < n; i++) { const g = geom(i); if (g) for (let k = 1; k < g.pts.length; k++) out.push(g.pts[k]); else out.push([w[3 * i], w[3 * i + 1]]); }
  return out;
}
