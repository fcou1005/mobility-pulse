// Mobility Pulse – S8.6 Umwegfaktor je bewohnter 100-m-Zelle (F21) aus dem OSM-Fußwegnetz (© OpenStreetMap-Mitwirkende, ODbL):
// Weg im Netz ÷ Luftlinie zu bis zu 8 Zielen in 300–800 m (je 45°-Sektor das Ziel nächst 500 m), Median je Zelle. Speist S8.2 und S8.4.
// Graph aus Overpass („out skel“), Dijkstra mit Abbruch bei 2,5 × der weitesten Zielentfernung.
import { pointIndex, distM } from './pulse-geo-proj.js';

export const NET = Object.freeze({ ringFrom: 300, ringTo: 800, ringMid: 500, sectors: 8, snapM: 60, minTargets: 3, cutoffFactor: 2.5, maxPoints: 15000,
  highways: 'footway|path|pedestrian|living_street|residential|service|unclassified|tertiary|tertiary_link|secondary|secondary_link|primary|primary_link|steps|track|road|crossing|platform|pier',
  noAccess: 'no|private|agricultural|forestry|delivery|customers|permit|military', noFoot: 'no|private|use_sidepath' });

/** Overpass-Abfrage für das Fußwegnetz in bbox [Süd, West, Nord, Ost]. Gesperrte Zugänge fallen weg (foot hat Vorrang vor access);
 *  Radwege nur mit foot=yes/designated/permissive – ein reiner Radweg (Zeichen 237) ist für Fußgänger nicht freigegeben. */
export const overpassFoot = (bb) => { const b = `(${bb.join(',')})`, acc = `["access"!~"^(${NET.noAccess})$"]`, ft = `["foot"!~"^(${NET.noFoot})$"]`;
  return `[out:json][timeout:300];(way["highway"~"^(${NET.highways})$"]${ft}${acc}${b};way["highway"~"^(${NET.highways})$"]["foot"~"^(yes|designated|permissive)$"]${b};way["highway"="cycleway"]["foot"~"^(yes|designated|permissive)$"]${b};);(._;>;);out skel qt;`; };

/** Graph (CSR) aus Overpass-JSON: { n, lat, lon, off, adj, w } */
export function buildGraph(json) {
  const idx = new Map(), lat = [], lon = [], edges = [];
  for (const e of json?.elements || []) if (e.type === 'node') { idx.set(e.id, lat.length); lat.push(e.lat); lon.push(e.lon); }
  for (const e of json?.elements || []) if (e.type === 'way' && e.nodes?.length > 1) for (let i = 1; i < e.nodes.length; i++) {
    const a = idx.get(e.nodes[i - 1]), b = idx.get(e.nodes[i]); if (a == null || b == null || a === b) continue;
    const d = distM(lat[a], lon[a], lat[b], lon[b]); edges.push(a, b, d);
  }
  const n = lat.length, deg = new Int32Array(n + 1);
  for (let i = 0; i < edges.length; i += 3) { deg[edges[i]]++; deg[edges[i + 1]]++; }
  const off = new Int32Array(n + 1); for (let i = 0; i < n; i++) off[i + 1] = off[i] + deg[i];
  const pos = off.slice(0, n), adj = new Int32Array(off[n]), w = new Float32Array(off[n]);
  for (let i = 0; i < edges.length; i += 3) { const a = edges[i], b = edges[i + 1], d = edges[i + 2]; adj[pos[a]] = b; w[pos[a]++] = d; adj[pos[b]] = a; w[pos[b]++] = d; }
  return { n, lat: Float64Array.from(lat), lon: Float64Array.from(lon), off, adj, w };
}

/** Dijkstra mit Abbruch; dist wird wiederverwendet (touched setzt zurück) */
export function dijkstraFactory(g) {
  const dist = new Float64Array(g.n).fill(Infinity), heapN = new Int32Array(Math.max(16, g.off[g.n] + g.n)), heapD = new Float64Array(heapN.length); let touched = [];
  return function run(src, cutoff) {
    for (const t of touched) dist[t] = Infinity; touched = [src]; dist[src] = 0;
    let hs = 0; const push = (v, d) => { let i = hs++; while (i > 0) { const p = (i - 1) >> 1; if (heapD[p] <= d) break; heapN[i] = heapN[p]; heapD[i] = heapD[p]; i = p; } heapN[i] = v; heapD[i] = d; };
    let pv = 0, pd = 0;
    const pop = () => { pv = heapN[0]; pd = heapD[0]; const ln = heapN[--hs], ld = heapD[hs]; let i = 0; while (true) { let c = 2 * i + 1; if (c >= hs) break; if (c + 1 < hs && heapD[c + 1] < heapD[c]) c++; if (heapD[c] >= ld) break; heapN[i] = heapN[c]; heapD[i] = heapD[c]; i = c; } heapN[i] = ln; heapD[i] = ld; };
    push(src, 0);
    while (hs > 0) {
      pop(); const v = pv, d = pd; if (d > dist[v]) continue; if (d > cutoff) break;
      for (let k = g.off[v]; k < g.off[v + 1]; k++) { const u = g.adj[k], nd = d + g.w[k]; if (nd < dist[u] && hs < heapN.length) { if (dist[u] === Infinity) touched.push(u); dist[u] = nd; push(u, nd); } }
    }
    return dist;
  };
}

/** Umwegfaktor je Punkt [[lat, lon, ew]] → [[lat, lon, faktor|null, ziele]] und Kennzahlen */
export function detourFactors(g, pts, { seed = 1 } = {}) {
  const nodes = pointIndex(Array.from({ length: g.n }, (_, i) => [g.lat[i], g.lon[i]]), 100), snap = (la, lo) => { const ids = nodes.within(la, lo, NET.snapM); let b = -1, bd = Infinity; for (const id of ids) { const d = distM(la, lo, g.lat[id], g.lon[id]); if (d < bd) { bd = d; b = id; } } return b; };
  let use = pts; if (pts.length > NET.maxPoints) { let s = seed; const r = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648); use = pts.filter(() => r() < NET.maxPoints / pts.length); }
  const pix = pointIndex(use.map(p => [p[0], p[1]]), 400), run = dijkstraFactory(g), out = [], fs = [];
  for (let i = 0; i < use.length; i++) {
    const [la, lo] = use[i], src = snap(la, lo); if (src < 0) { out.push([la, lo, null, 0]); continue; }
    const best = new Array(NET.sectors).fill(null);
    for (const j of pix.within(la, lo, NET.ringTo)) {
      if (j === i) continue; const d = distM(la, lo, use[j][0], use[j][1]); if (d < NET.ringFrom) continue;
      const sec = Math.floor(((Math.atan2(use[j][0] - la, (use[j][1] - lo) * Math.cos(la * Math.PI / 180)) + Math.PI) / (2 * Math.PI)) * NET.sectors) % NET.sectors;
      if (!best[sec] || Math.abs(d - NET.ringMid) < Math.abs(best[sec][1] - NET.ringMid)) best[sec] = [j, d];
    }
    const tg = best.filter(Boolean).map(([j]) => snap(use[j][0], use[j][1])).filter(t => t >= 0 && t !== src);
    if (tg.length < NET.minTargets) { out.push([la, lo, null, tg.length]); continue; }
    const far = Math.max(...tg.map(t => distM(g.lat[src], g.lon[src], g.lat[t], g.lon[t])));
    const dist = run(src, far * NET.cutoffFactor), ratios = [];
    for (const t of tg) { const air = distM(g.lat[src], g.lon[src], g.lat[t], g.lon[t]); if (air > 50) ratios.push(Number.isFinite(dist[t]) ? dist[t] / air : NET.cutoffFactor); }
    if (ratios.length < NET.minTargets) { out.push([la, lo, null, ratios.length]); continue; }
    ratios.sort((a, b) => a - b); const f = ratios[ratios.length >> 1]; fs.push(f); out.push([la, lo, Math.round(f * 100) / 100, ratios.length]);
  }
  fs.sort((a, b) => a - b);
  return { cells: out, n: fs.length, median: fs.length ? fs[fs.length >> 1] : null, p90: fs.length ? fs[Math.floor(fs.length * 0.9)] : null, over15: fs.length ? fs.filter(x => x > 1.5).length / fs.length : null, sampled: use.length < pts.length };
}

/** Netzentfernung zwischen zwei Punkten (für die Stichproben gegen einen externen Router) */
export function netDistance(g, a, b) { return netPath(g, a, b)?.d ?? null; }

/** Wie netDistance, dazu die angefahrenen Netzknoten { d, from, to, snapA, snapB } – für Router-Stichproben auf denselben Punkten */
export function netPath(g, a, b) {
  const nodes = pointIndex(Array.from({ length: g.n }, (_, i) => [g.lat[i], g.lon[i]]), 100);
  const snap = (p) => { let best = -1, bd = Infinity; for (const id of nodes.within(p[0], p[1], NET.snapM)) { const d = distM(p[0], p[1], g.lat[id], g.lon[id]); if (d < bd) { bd = d; best = id; } } return [best, bd]; };
  const [s, sa] = snap(a), [t, sb] = snap(b); if (s < 0 || t < 0) return null;
  const d = dijkstraFactory(g)(s, distM(a[0], a[1], b[0], b[1]) * 4)[t];
  return Number.isFinite(d) ? { d, from: [g.lat[s], g.lon[s]], to: [g.lat[t], g.lon[t]], snapA: sa, snapB: sb } : null;
}
