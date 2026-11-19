// Zeitraffer der Bestandsdichte (F33, lib/pulse-zeitraffer.js): Bänder aus den Zelldateien, GIF-Kodierung (Rückweg mit eigenem Decoder)
import * as ZR from '../lib/pulse-zeitraffer.js';
let ok = 0, bad = 0;
const assert = (c, m) => { if (!c) { bad++; console.error('FEHLER:', m); } else { ok++; console.log('ok:', m); } };

// Zelldatei wie im Sammler: start,end,present,reloc,start×6,present×6,end×6,angebot×6 (present×6 ab Wert 10)
const six = (a) => a, row = (pres) => [0, 0, pres.reduce((x, y) => x + y, 0), 0, ...six([0, 0, 0, 0, 0, 0]), ...pres, ...six([0, 0, 0, 0, 0, 0]), ...six([0, 0, 0, 0, 0, 0])];
const doc = { day: '2026-11-18', fields: 'start,end,present,reloc,start×6,present×6,end×6,angebot×6', bandRuns: [12, 12, 12, 1, 12, 12],
  munis: { '08111000': { '100:200': row([24, 12, 0, 5, 36, 0]), '101:200': row([0, 0, 0, 0, 0, 0]), '100:201': row([0, 0, 0, 0, 12, 24]) } } };
const D = ZR.bandDensity(doc, '08111000');
assert(D && D.cells.join() === '100:200,100:201', `Zellen ohne Fahrzeug fallen weg (${D?.cells})`);
assert(D.bands[0].get('100:200') === 2 && D.bands[1].get('100:200') === 1 && D.bands[4].get('100:200') === 3 && D.bands[5].get('100:201') === 2, 'Mittel je Band = present×6 ÷ Läufe');
assert(D.bands[3] === null && D.max === 3, 'Band mit einem Lauf zählt nicht');
const old = { ...doc, fields: 'start,end,present,reloc,start×6,present×6,end×6', munis: { '08111000': { '100:200': row([24, 12, 0, 5, 36, 0]).slice(0, 22) } } };
assert(ZR.bandDensity(old, '08111000').bands[4].get('100:200') === 3, 'ältere Dateien ohne angebot×6');
assert(ZR.bandDensity(doc, '08416041') === null && ZR.bandLabel(4) === '15–19' && ZR.bandLabel(0) === '00–06', 'andere Gemeinde: nichts; Bandname');

// GIF: Kopf, Bilder, Rückweg über einen kleinen LZW-Decoder (auch mit vollem Codebuch: Rauschen)
const w = 160, h = 120, pal = [[255, 255, 255], [0, 0, 0], [15, 118, 110], [200, 0, 0], [1, 2, 3]];
let s = 7; const noise = Uint8Array.from({ length: w * h }, () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % 5; });
const stripes = Uint8Array.from({ length: w * h }, (_, i) => ((i % w) >> 3) % 5);
const gif = ZR.gifEncode([{ pixels: stripes }, { pixels: noise, delayCs: 50 }], w, h, pal);
const head = String.fromCharCode(...gif.slice(0, 6));
function decode(b) {
  let p = 13 + 3 * (1 << ((b[10] & 7) + 1)); const frames = [];
  while (b[p] !== 0x3B) {
    if (b[p] === 0x21) { p += 2; while (b[p]) p += b[p] + 1; p++; continue; }
    p += 10; const min = b[p++], data = []; while (b[p]) { for (let i = 1; i <= b[p]; i++) data.push(b[p + i]); p += b[p] + 1; } p++;
    const clear = 1 << min, out = []; let size = min + 1, dict = [], prev = null, bit = 0;
    const read = () => { let c = 0; for (let i = 0; i < size; i++, bit++) c |= ((data[bit >> 3] >> (bit & 7)) & 1) << i; return c; };
    const reset = () => { dict = Array.from({ length: clear + 2 }, (_, i) => [i]); size = min + 1; prev = null; };
    reset();
    for (;;) {
      const c = read(); if (c === clear) { reset(); continue; } if (c === clear + 1) break;
      const e = c < dict.length ? dict[c] : [...dict[prev], dict[prev][0]];
      out.push(...e); if (prev !== null && dict.length < 4096) dict.push([...dict[prev], e[0]]);
      if (dict.length === (1 << size) && size < 12) size++;
      prev = c;
    }
    frames.push(out);
  }
  return frames;
}
const F = decode(gif);
assert(head === 'GIF89a' && gif[6] === w && gif[8] === h && gif.at(-1) === 0x3B, 'GIF89a-Kopf, Größe, Abschluss');
assert(F.length === 2 && F[0].join() === Array.from(stripes).join() && F[1].join() === Array.from(noise).join(), 'Bilder kommen unverändert zurück (auch über 4096 Codes)');

console.log(`\n${ok} ok, ${bad} Fehler`);
if (bad) process.exit(1);
