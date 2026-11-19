// Regen-Elastizität (F34, lib/pulse-markt-regen.js): Verdichtung eines Trainingstags, Wirkung und Intervall, Schwellen, Grafik der Woche
import * as K from '../lib/pulse-markt.js';
let ok = 0, bad = 0;
const assert = (c, m) => { if (!c) { bad++; console.error('FEHLER:', m); } else { ok++; console.log('ok:', m); } };

// Synthetisch: Stadt A (Stuttgart) 100 Fahrten je Stunde trocken, bei Regen 60 (−40 %); Stadt B (Tübingen) halbiert; Carsharing zählt nicht.
// Zwei Anbieter in A werden summiert. Regen 12–15 Uhr an jedem zweiten Tag (10 von 20 Tagen); Lücke 14 Uhr am 6. Tag (Regentag).
const A = '08111000', B = '08416041', H = 24;
const day = (i) => `2026-11-${String(i + 1).padStart(2, '0')}`;
const docOf = (i) => {
  const wet = i % 2 === 1, rain = (h) => (wet && h >= 12 && h < 16 ? 1.2 : 0);
  const series = (base, f) => Array.from({ length: H }, (_, h) => (h >= 6 && h < 23 ? Math.round(base * (rain(h) > 0 ? f : 1)) : 0));
  return {
    day: day(i), f: ['start', 'end'], gapHours: i === 5 ? [14] : [], hourMin: Array(H).fill(60), dayType: { BW: 'W' },
    g: { [`${A}|Voi|scooter`]: [series(60, 0.6), 0], [`${A}|Bolt|scooter`]: [series(40, 0.6), 0], [`${B}|Bolt|scooter`]: [series(20, 0.5), 0], [`${A}|stadtmobil|car`]: [series(30, 0.1), 0] },
    wx: { cells: { '48.5|9.0': [Array(H).fill(8), Array.from({ length: H }, (_, h) => rain(h))] }, ags: { [A]: '48.5|9.0', [B]: '48.5|9.0' } },
  };
};
const docs = Array.from({ length: 20 }, (_, i) => docOf(i));
const c = K.regenDay(docs[5]);
assert(Object.keys(c.rows).sort().join() === `${A}|scooter,${B}|scooter`, 'verdichtet: je Stadt und Art, Carsharing nicht');
assert(c.rows[`${A}|scooter`].y[10] === 100 && c.rows[`${A}|scooter`].y[6] === null && c.rows[`${A}|scooter`].y[14] === null, 'Anbieter summiert; nur 7–21 Uhr, Lückenstunde nicht gezählt');
assert(c.rows[`${A}|scooter`].q[13] === 1.2 && c.rows[`${A}|scooter`].q[12] === 0 && c.rows[`${A}|scooter`].dt === 'W', 'Vorstunde und Tagtyp');

const R = K.rainElasticity(docs.map(K.regenDay), { names: { [A]: 'Stuttgart', [B]: 'Tübingen' } });
const ra = R.rows.find(r => r.ags === A), rb = R.rows.find(r => r.ags === B);
assert(R.days === 20 && R.first === '2026-11-01' && R.last === '2026-11-20', 'Zeitraum');
assert(ra && Math.abs(ra.effect + 0.4) < 0.005 && ra.lo <= ra.effect && ra.effect <= ra.hi, `Stuttgart −40 % (${ra?.effect}, ${ra?.lo} … ${ra?.hi})`);
assert(rb && Math.abs(rb.effect + 0.5) < 0.01, `Tübingen −50 % (${rb?.effect})`);
assert(ra.wetDays === 10 && ra.wetHours === 39 && ra.name === 'Stuttgart' && R.rows[0].ags === A, `Regenstunden 10 × 4 − 1 Lücke (${ra.wetHours}), Reihenfolge nach Fahrten`);
assert(R.de.length === 0, 'Deutschland erst ab 5 Städten');

// gleiches Ergebnis bei gleichem Eingang (feste Saat)
const R2 = K.rainElasticity(docs.map(K.regenDay));
assert(JSON.stringify(R2.rows.map(r => [r.lo, r.hi])) === JSON.stringify(R.rows.map(r => [r.lo, r.hi])), 'Intervall reproduzierbar');

// zu wenig Regen: nur 2 Regentage → kein Ergebnis
const few = docs.map((d, i) => (i % 2 === 1 && i > 4 ? { ...d, wx: { ...d.wx, cells: { '48.5|9.0': [Array(H).fill(8), Array(H).fill(0)] } } } : d));
assert(K.rainElasticity(few.map(K.regenDay)).rows.length === 0, 'unter 3 Regentagen kein Ergebnis');

// Grafik der Woche: eine Zeile je Stadt, Rückgang in Prozent
const g = K.regenGraphic({ ...R, rows: [...R.rows, { ...ra, type: 'bike', tripsDay: 1 }] }, '2026-W48');
assert(g.theme === 'regen' && /KW 48/.test(g.title) && (g.svg.match(/Stuttgart/g) || []).length === 1 && /40 % weniger/.test(g.svg) && /Tübingen/.test(g.svg), 'Grafik: eine Zeile je Stadt');

console.log(`\n${ok} ok, ${bad} Fehler`);
if (bad) process.exit(1);
