// @ts-check
// Mobility Pulse – Zeitraffer der Bestandsdichte (F33, Review 18.11.2026): verfügbare Fahrzeuge je Zelle (≈ 280 × 250 m) in den sechs Tagesbändern
// der Zelldateien (cells/<Tag>/<Land>.json, Felder present×6 und bandRuns; Bänder wie BANDS: 0–6, 6–9, 9–12, 12–15, 15–19, 19–24 Uhr), als Animation
// auf der Karte und als GIF.
// Datenschutz: nur veröffentlichte Zellen (unter minCount schon im Sammler zurückgehalten), keine Einzelfahrzeuge, keine Wege.
// GIF89a ohne Abhängigkeiten: feste Palette (höchstens 256 Farben), LZW wie im Standard, Endlosschleife (NETSCAPE2.0).
import { BANDS } from './pulse-track-rules.js';

export const ZEIT = Object.freeze({ bands: BANDS.length, delayCs: 120, minRuns: 2 });
export const bandLabel = (/** @type {number} */ b) => `${String(BANDS[b].from).padStart(2, '0')}–${String(BANDS[b].to).padStart(2, '0')}`;

/**
 * Mittel verfügbarer Fahrzeuge je Zelle und Band: present×6[b] ÷ bandRuns[b] (Summe über die Läufe ÷ Zahl der Läufe im Band).
 * Rückgabe { day, cells: [Zell-ID], bands: [Map(Zelle → Mittel) | null je Band], max, scale } oder null ohne Zellen; Bänder mit weniger als 2 Läufen null.
 * scale = 95. Perzentil aller Werte: Farbstufen danach, damit ein Depot oder ein Bahnhof mit 60 Fahrzeugen nicht alle übrigen Zellen blass macht.
 * @param {any} doc cells/<Tag>/<Land>.json @param {string} ags @returns {any}
 */
export function bandDensity(doc, ags) {
  // Feldliste mit Breiten: „x×6“ belegt sechs Werte (start,end,present,reloc,start×6,present×6 … → present×6 ab Wert 10)
  const cells = doc?.munis?.[ags], F = String(doc?.fields || '').split(','), at = F.indexOf('present×6');
  if (!cells || at < 0) return null;
  const p0 = F.slice(0, at).reduce((n, f) => n + (/×6$/.test(f) ? 6 : 1), 0);
  const bands = Array.from({ length: ZEIT.bands }, (_, b) => ((doc.bandRuns?.[b] || 0) >= ZEIT.minRuns ? new Map() : null));
  let max = 0; const ids = [];
  for (const [cell, v] of Object.entries(cells)) {
    let any = false;
    for (let b = 0; b < ZEIT.bands; b++) { const m = bands[b]; if (!m) continue; const x = (v[p0 + b] || 0) / doc.bandRuns[b]; if (x > 0) { m.set(cell, x); any = true; if (x > max) max = x; } }
    if (any) ids.push(cell);
  }
  const all = bands.flatMap(m => (m ? [...m.values()] : [])).sort((a, b) => a - b), scale = all.length ? Math.max(0.5, all[Math.floor(0.95 * (all.length - 1))]) : 1;
  return ids.length ? { day: doc.day, cells: ids.sort(), bands, max, scale } : null;
}

/** LZW-Codes eines Bildes (Palettenindizes) nach GIF-Standard */
function lzw(/** @type {ArrayLike<number>} */ px, /** @type {number} */ minCode) {
  const clear = 1 << minCode, eoi = clear + 1, out = /** @type {number[]} */ ([]);
  let size = minCode + 1, next = eoi + 1, dict = new Map(), cur = 0, nbits = 0;
  const emit = (/** @type {number} */ code) => { cur |= code << nbits; nbits += size; while (nbits >= 8) { out.push(cur & 255); cur >>>= 8; nbits -= 8; } };
  emit(clear);
  let prefix = px[0];
  for (let i = 1; i < px.length; i++) {
    const k = px[i], key = (prefix << 8) | k, hit = dict.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    emit(prefix);
    if (next === 4096) { emit(clear); dict = new Map(); size = minCode + 1; next = eoi + 1; } else { if (next >= (1 << size)) size++; dict.set(key, next++); }
    prefix = k;
  }
  emit(prefix); emit(eoi);
  if (nbits > 0) out.push(cur & 255);
  return out;
}

/**
 * Animiertes GIF aus Bildern mit Palettenindizes. frames: [{ pixels: Uint8Array(w·h), delayCs? }], palette: [[r, g, b], …] (≤ 256).
 * @param {{ pixels: ArrayLike<number>, delayCs?: number }[]} frames @param {number} w @param {number} h @param {number[][]} palette
 * @param {{ delayCs?: number }} [opts] @returns {Uint8Array}
 */
export function gifEncode(frames, w, h, palette, { delayCs = ZEIT.delayCs } = {}) {
  const bytes = /** @type {number[]} */ ([]), push = (/** @type {number[]} */ ...b) => { for (const x of b) bytes.push(x & 255); }, word = (/** @type {number} */ v) => push(v & 255, (v >> 8) & 255);
  const bits = Math.max(1, Math.ceil(Math.log2(Math.max(2, palette.length)))), size = 1 << bits, minCode = Math.max(2, bits);
  for (const c of 'GIF89a') push(c.charCodeAt(0));
  word(w); word(h); push(0x80 | ((bits - 1) << 4) | (bits - 1), 0, 0);
  for (let i = 0; i < size; i++) { const c = palette[i] || [0, 0, 0]; push(c[0], c[1], c[2]); }
  push(0x21, 0xFF, 11); for (const c of 'NETSCAPE2.0') push(c.charCodeAt(0)); push(3, 1, 0, 0, 0);
  for (const f of frames) {
    push(0x21, 0xF9, 4, 0); word(f.delayCs ?? delayCs); push(0, 0);
    push(0x2C); word(0); word(0); word(w); word(h); push(0, minCode);
    const data = lzw(f.pixels, minCode);
    for (let i = 0; i < data.length; i += 255) { const n = Math.min(255, data.length - i); push(n); for (let j = 0; j < n; j++) push(data[i + j]); }
    push(0);
  }
  push(0x3B);
  return Uint8Array.from(bytes);
}
