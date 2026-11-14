// Mobility Pulse – S8.3 Sicherheits-Ebene (F14): Unfallatlas der Statistischen Ämter des Bundes und der Länder (Unfälle mit Personenschaden,
// dl-de/by-2-0) je 250-m-Zelle × Kategorie × Jahr, Empirical-Bayes-Glättung, Schwerpunkte mit Getis-Ord Gi* und FDR (Benjamini-Hochberg).
// Keine Rate je Fahrt: Unfälle und Sharing-Fahrten lassen sich nicht verknüpfen. E-Scooter haben im Unfallatlas keine eigene Spalte
// (sie stecken unter „Sonstige“, zusammen mit z. B. Pedelecs ohne Rad-Zuordnung und landwirtschaftlichen Fahrzeugen).
import { cell250 } from './pulse-geo-proj.js';

export const UNFALL = Object.freeze({
  // Muster der Dateien (je Jahr ein ZIP mit CSV, Koordinaten WGS84 in XGCSWGS84/YGCSWGS84); mehrere Varianten, die erste erreichbare gilt
  urls: (y) => [`https://www.opengeodata.nrw.de/produkte/transport_verkehr/unfallatlas/Unfallorte${y}_EPSG25832_CSV.zip`, `https://www.opengeodata.nrw.de/produkte/transport_verkehr/unfallatlas/Unfallorte_${y}_EPSG25832_CSV.zip`],
  from: 2016, cats: ['alle', 'rad', 'fuss', 'krad', 'sonst', 'schwer'], q: 0.05, attribution: '© Statistische Ämter des Bundes und der Länder, Unfallatlas', license: 'dl-de/by-2-0',
});

/** Kopfzeile → Spaltenindizes (Namen schwanken zwischen den Jahren in Groß-/Kleinschreibung) */
export function unfallHeader(line) {
  const sep = line.includes(';') ? ';' : ',', h = line.replace(/^﻿/, '').split(sep).map(s => s.trim().replace(/^"|"$/g, '').toLowerCase());
  const f = (re) => h.findIndex(c => re.test(c));
  const ix = { sep, land: f(/^uland$/), rb: f(/^uregbez$/), kreis: f(/^ukreis$/), gem: f(/^ugemeinde$/), jahr: f(/^ujahr$/), kat: f(/^ukategorie$/), rad: f(/^istrad$/), fuss: f(/^istfuss$/), krad: f(/^istkrad$/), sonst: f(/^istsonstig/), x: f(/^xgcswgs84$/), y: f(/^ygcswgs84$/) };
  for (const k of ['land', 'rb', 'kreis', 'gem', 'jahr', 'kat', 'x', 'y']) if (ix[k] < 0) throw new Error(`Unfallatlas: Spalte ${k} fehlt (${h.join(sep)})`);
  return ix;
}
const num = (s) => Number(String(s ?? '').trim().replace(',', '.'));
/** Datenzeile → { ags, year, lat, lon, cats: Set } */
export function unfallRow(line, ix) {
  const c = line.split(ix.sep); if (c.length < 8) return null;
  const pad = (v, n) => String(Math.trunc(num(v))).padStart(n, '0');
  // Berlin führt im Unfallatlas die Bezirke als Kreise (11 0 01 000 …); im Dashboard ist Berlin eine Gemeinde (11000000), Hamburg ebenso
  const land = pad(c[ix.land], 2), ags = land === '11' || land === '02' ? `${land}000000` : land + pad(c[ix.rb], 1) + pad(c[ix.kreis], 2) + pad(c[ix.gem], 3);
  const lon = num(c[ix.x]), lat = num(c[ix.y]), year = num(c[ix.jahr]), kat = num(c[ix.kat]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !(year > 2000) || ags.length !== 8) return null;
  const cats = ['alle']; for (const k of ['rad', 'fuss', 'krad', 'sonst']) if (ix[k] >= 0 && num(c[ix[k]]) === 1) cats.push(k);
  if (kat === 1 || kat === 2) cats.push('schwer');
  return { ags, year, lat, lon, cats };
}

/** Sammler je Gemeinde: Zellen × Kategorie × Jahr und Summen direkt aus den Zeilen (für den Abgleich) */
export function unfallAccumulator(keep = null) {
  const by = new Map();
  return {
    add(r) {
      if (!r || (keep && !keep.has(r.ags))) return;
      let a = by.get(r.ags); if (!a) by.set(r.ags, a = { sums: {}, cells: new Map() });
      const sy = (a.sums[r.year] ??= {}); for (const k of r.cats) sy[k] = (sy[k] || 0) + 1;
      const c = cell250(r.lat, r.lon); let e = a.cells.get(c); if (!e) a.cells.set(c, e = {});
      const ey = (e[r.year] ??= {}); for (const k of r.cats) ey[k] = (ey[k] || 0) + 1;
    },
    result: () => by,
  };
}

/** Normalverteilung: obere Fläche ab z */
export function normSf(z) {
  // Abramowitz-Stegun 7.1.26 für erfc, Fehler < 1,5e-7
  const x = Math.abs(z) / Math.SQRT2, t = 1 / (1 + 0.3275911 * x);
  const erfc = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x);
  return z >= 0 ? erfc / 2 : 1 - erfc / 2;
}
/** Benjamini-Hochberg: Indizes mit p ≤ Schwelle bei FDR q */
export function fdr(pvals, q = UNFALL.q) {
  const ord = pvals.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]); let k = -1;
  for (let j = 0; j < ord.length; j++) if (ord[j][0] <= ((j + 1) / ord.length) * q) k = j;
  return new Set(ord.slice(0, k + 1).map(x => x[1]));
}
/**
 * Getis-Ord Gi* auf dem 250-m-Raster: Werte x je Zelle (Map Zelle → Wert, Universum = alle Zellen der Gemeinde, auch 0), Nachbarn = 3 × 3
 * einschließlich der Zelle selbst (binäre Gewichte). Rückgabe Map Zelle → z
 */
export function giStar(values) {
  const cells = [...values.keys()], n = cells.length; if (n < 3) return new Map();
  let s1 = 0, s2 = 0; for (const v of values.values()) { s1 += v; s2 += v * v; }
  const mean = s1 / n, S = Math.sqrt(Math.max(0, s2 / n - mean * mean)), out = new Map();
  if (!(S > 0)) return out;
  for (const c of cells) {
    const [i, j] = c.split(':').map(Number); let sw = 0, swx = 0;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const v = values.get(`${i + a}:${j + b}`); if (v != null) { sw++; swx += v; } }
    const den = S * Math.sqrt((n * sw - sw * sw) / (n - 1));
    out.set(c, den > 0 ? (swx - mean * sw) / den : 0);
  }
  return out;
}
/** Schwerpunkte: Gi* > 0 und nach FDR signifikant (einseitig) */
export function hotspots(values, q = UNFALL.q) {
  const z = giStar(values), keys = [...z.keys()], p = keys.map(k => normSf(z.get(k))), sig = fdr(p, q);
  return { z, hot: new Set(keys.filter((k, i) => sig.has(i) && z.get(k) > 0)) };
}
/** Empirical Bayes (Poisson-Gamma, Momente über die Zellen der Gemeinde): geglättete Rate je Jahr */
export function ebRates(counts, years) {
  const v = [...counts.values()], n = v.length; if (!n || !(years > 0)) return new Map();
  const m = v.reduce((a, b) => a + b, 0) / n, s2 = v.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, n - 1);
  const mu = m / years, varRate = s2 / years / years - mu / years;
  const out = new Map();
  if (!(varRate > 0) || !(mu > 0)) { for (const k of counts.keys()) out.set(k, mu); return out; }
  const alpha = (mu * mu) / varRate, beta = mu / varRate;
  for (const [k, y] of counts) out.set(k, (y + alpha) / (years + beta));
  return out;
}

/**
 * Auswertung einer Gemeinde: universe = Zellen der Gemeinde (Mitte im Gebiet), a = { sums, cells } aus unfallAccumulator, years = Jahre im
 * Bestand. Schwerpunkte für „alle“ über alle Jahre und getrennt je Zeithälfte; Überlappung = gemeinsame ÷ kleinere Menge.
 */
export function analyseAgs(universe, a, years, { cat = 'alle' } = {}) {
  const ys = [...years].sort(), mid = ys[Math.floor(ys.length / 2)], h1 = ys.filter(y => y < mid), h2 = ys.filter(y => y >= mid);
  const sumOf = (e, list, k = cat) => list.reduce((s, y) => s + (e?.[y]?.[k] || 0), 0);
  const val = (list) => { const m = new Map(); for (const c of universe) m.set(c, sumOf(a.cells.get(c), list)); for (const [c, e] of a.cells) if (!m.has(c)) m.set(c, sumOf(e, list)); return m; };
  const all = val(ys), hs = hotspots(all), hA = hotspots(val(h1)).hot, hB = hotspots(val(h2)).hot;
  const both = [...hA].filter(c => hB.has(c)).length, overlap = Math.min(hA.size, hB.size) ? both / Math.min(hA.size, hB.size) : null;
  const eb = ebRates(all, ys.length);
  const cells = [...a.cells.keys()].map(c => [c, ...UNFALL.cats.map(k => sumOf(a.cells.get(c), ys, k)), Math.round((eb.get(c) ?? 0) * 100) / 100, Math.round((hs.z.get(c) ?? 0) * 100) / 100, hs.hot.has(c) ? 1 : 0]).sort((x, y) => y[1] - x[1]);
  const cellSum = cells.reduce((s, r) => s + r[1], 0), srcSum = ys.reduce((s, y) => s + (a.sums[y]?.alle || 0), 0);
  return { years: ys, halves: [h1, h2], hot: hs.hot.size, hotA: hA.size, hotB: hB.size, both, overlap, cellSum, srcSum, cells };
}
