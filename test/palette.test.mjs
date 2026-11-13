// S4.3 Palette MP-7 plus Grau (web/tokens.js): Farbabstände für Normalsicht und Farbsehschwächen, Kontrast gegen die Fläche, und
// Hex-Werte stehen nur in web/tokens.js. Abstand = OKLab-Distanz × 100; Farbsehschwäche nach Machado, Oliveira & Fernandes (2009),
// Schweregrad 1,0 (Protanopie, Deuteranopie), Nachbarpaare der festen Reihenfolge.
import { readFileSync, readdirSync } from 'node:fs';
import { MP7, MORE, SURFACE } from '../web/tokens.js';

let ok = 0, bad = 0;
const check = (c, m) => { if (c) { ok++; console.log(`ok: ${m}`); } else { bad++; console.log(`FEHLER ${m}`); } };
const rgb = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const M = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
};
const oklab = ([r, g, b]) => {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
};
const sim = (h, k) => { const c = rgb(h).map(lin); if (!k) return c; return M[k].map(row => Math.max(0, Math.min(1, row[0] * c[0] + row[1] * c[1] + row[2] * c[2]))); };
const dE = (a, b, k) => { const x = oklab(sim(a, k)), y = oklab(sim(b, k)); return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); };
const lum = (h) => { const [r, g, b] = rgb(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

for (const mode of ['light', 'dark']) {
  const p = MP7[mode], surf = SURFACE[mode];
  check(p.length === 7 && new Set(p).size === 7, `${mode}: sieben verschiedene Farben`);
  let cvd = Infinity, normal = Infinity;
  for (let i = 0; i + 1 < p.length; i++) { cvd = Math.min(cvd, dE(p[i], p[i + 1], 'protan'), dE(p[i], p[i + 1], 'deutan')); normal = Math.min(normal, dE(p[i], p[i + 1])); }
  check(cvd >= 8, `${mode}: Nachbarpaare bei Farbsehschwäche ΔE ≥ 8 (kleinster ${cvd.toFixed(1)})`);
  check(normal >= 15, `${mode}: Nachbarpaare Normalsicht ΔE ≥ 15 (kleinster ${normal.toFixed(1)})`);
  const cmin = Math.min(...p.map(c => contrast(c, surf)));
  check(cmin >= 3, `${mode}: Kontrast gegen ${surf} ≥ 3:1 (kleinster ${cmin.toFixed(2)})`);
  const lmin = Math.min(...p.map(c => oklab(sim(c))[0])), lmax = Math.max(...p.map(c => oklab(sim(c))[0]));
  check(lmax - lmin < 0.3, `${mode}: Helligkeit im Band (OKLab L ${lmin.toFixed(2)}–${lmax.toFixed(2)})`);
  check(Math.min(...p.map(c => dE(c, MORE[mode]))) >= 10, `${mode}: „Weitere“ (${MORE[mode]}) unterscheidbar von allen sieben`);
}
// Hex-Werte nur in web/tokens.js (Themen-Variablen in index.html bleiben dort)
const web = new URL('../web/', import.meta.url);
const offenders = readdirSync(web).filter(f => f.endsWith('.js') && f !== 'tokens.js' && !/^i18n-/.test(f)).filter(f => /['"`(:\s]#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b/.test(readFileSync(new URL(f, web), 'utf8')));
check(!offenders.length, `Hex-Werte nur in web/tokens.js${offenders.length ? ` (noch in ${offenders.join(', ')})` : ''}`);
// S4.4 Typografie: Schriftgrößen in rem (px nur in SVG), keine Versal-Labels, Mono nur für Kennungen/Formeln/Koordinaten, deutsche Texte ohne „ · “
const srcs = readdirSync(web).filter(f => (f.endsWith('.js') && !/^i18n-/.test(f)) || f === 'index.html').map(f => [f, readFileSync(new URL(f, web), 'utf8')]);
const SVG_SEL = /svg|(^|[\s>,+~])(text|tspan)($|[\s,.:[>#])/;
const pxRules = [], upper = [], mono = [];
for (const [f, s] of srcs) {
  for (const m of s.matchAll(/([^{}`'"]*)\{([^{}]*)\}/g)) {
    const sel = m[1].trim(), decl = m[2];
    if (/font(-size)?:[^;}]*\d(\.\d+)?px/.test(decl) && !/font-size:\s*0\b/.test(decl) && !SVG_SEL.test(sel) && /font-size:\s*[\d.]+px|font:\s*([^;}]*\s)?[\d.]+px/.test(decl)) pxRules.push(`${f}: ${sel.slice(-40)}`);
    if (/text-transform:\s*uppercase/.test(decl)) upper.push(`${f}: ${sel.slice(-40)}`);
    if (/var\(--mono\)/.test(decl) && !/(^|[\s,])\.mono\b|kbd|code|\.fv-formula|\.brand \.logo|^\s*:root/.test(sel) && !/--mono:/.test(decl)) mono.push(`${f}: ${sel.slice(-40)}`);
  }
  for (const m of s.matchAll(/style="[^"]*font-size:\s*[\d.]+px/g)) { const before = s.slice(Math.max(0, m.index - 120), m.index); if (!/<(text|tspan|svg|g)\b[^>]*$/.test(before)) pxRules.push(`${f}: style="…"`); }
}
check(!pxRules.length, `Schriftgrößen in rem, px nur in SVG${pxRules.length ? ` (${pxRules.length}: ${pxRules.slice(0, 5).join('; ')})` : ''}`);
check(!upper.length, `keine Versal-Labels${upper.length ? ` (${upper.slice(0, 5).join('; ')})` : ''}`);
check(!mono.length, `Mono nur für Kennungen, Formeln, Koordinaten${mono.length ? ` (${mono.slice(0, 5).join('; ')})` : ''}`);
const deDots = readdirSync(web).filter(f => /^i18n-de-\d\.js$/.test(f)).flatMap(f => readFileSync(new URL(f, web), 'utf8').split('\n').filter(l => !/^\s*\/\//.test(l) && l.includes(' · ')).map(l => `${f}: ${l.trim().slice(0, 50)}`));
check(!deDots.length, `deutsche Texte ohne „ · “${deDots.length ? ` (${deDots.length}: ${deDots.slice(0, 3).join('; ')})` : ''}`);
console.log(`${bad ? '✗' : '✓'} palette: ${ok} ok, ${bad} fehlgeschlagen`);
process.exit(bad ? 1 : 0);
