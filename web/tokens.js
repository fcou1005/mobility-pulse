// Mobility Pulse — Farbwerte (S4.3): alle Hex-Werte der Seite außer den Themen-Variablen in index.html stehen hier.
// Palette MP-7 plus Grau: sieben Kategorie-Farben mit festem Platz je Anbieter (die sieben größten Flotten in Deutschland, Stand 13.11.2026),
// alle übrigen Anbieter grau als „Weitere“. Geprüft mit test/palette.test.mjs (Nachbarpaare: hell CVD ΔE 13,3, dunkel 14,9; Normalsicht ≥ 15;
// Kontrast ≥ 3:1 gegen die Fläche). Reihen ohne Anbieter (Fahrzeugarten, Modelle) nehmen die Plätze der Reihe nach, ohne Wiederholung:
// was über sieben hinausgeht, fällt unter „Weitere“ (S4.6, keine zyklische Palette).
export const MP7 = Object.freeze({
  light: Object.freeze(['#2a78d6', '#d4572a', '#b05090', '#5b8f2b', '#0f8fa8', '#a0652b', '#6250d6']),
  dark: Object.freeze(['#3987e5', '#d95926', '#cc6fae', '#6fa02a', '#2aa3bd', '#c48244', '#9085e9']),
});
export const MORE = Object.freeze({ light: '#a7b0b9', dark: '#5b6573' }); // „Weitere“
export const SURFACE = Object.freeze({ light: '#ffffff', dark: '#161d26' }); // Fläche der Panels (index.html --panel)
/** fester Platz (0–6) je Anbieter; alle anderen: „Weitere“ */
export const OP_SLOT = Object.freeze({ nextbike: 0, Dott: 1, Voi: 2, Lime: 3, Donkey: 4, Bolt: 5, 'DB Connect': 6 });
export const SLOTS = MP7.light.length;

// Neutrale und feste Farben (Karten, Diagramme, Druck)
export const NEUTRAL = Object.freeze({
  disabled: '#7d8794', // gesperrt: neutrales Grau statt Rot (Rot ist eine Kategorie-Farbe)
  slate: '#3d4a5c', // Ströme mehrerer Anbieter auf den hellen OSM-Kacheln (≥ 7:1)
  tileBg: '#f2efe9', // Grundton der OSM-Kacheln (Legende wie auf der Karte)
  white: '#ffffff', black: '#000000', ink: '#111820', inkSoft: '#3b4855', paperSoft: '#eef1f4', fallback: '#888888',
  fg2: '#555555', warn: '#cc9900',
});
// Zonenarten auf Karten (Langsamzone; die übrigen kommen aus den Status-Variablen --bad/--warn/--info)
export const ZONE = Object.freeze({ slow: { light: '#7c3aed', dark: '#c084fc' } });
// Touren der Disposition: Linienstil trägt die Art (S4.7), Farbe zusätzlich
export const RUN = Object.freeze({
  rebalance: { light: '#2563eb', dark: '#60a5fa' }, swap: { light: '#047857', dark: '#34d399' },
  workshop: { light: '#c93c3c', dark: '#ef6b6b' }, station: { light: '#b45309', dark: '#f59e0b' },
});
export const IDLE = Object.freeze({ light: '#7c3aed', dark: '#c084fc' }); // lange Standzeit
// Prognose: Modelle (Reihen ohne Anbieter) und Trefferbilanz
export const MODEL = Object.freeze({ chronos: '#14b8a6', blend: '#f59e0b', hybrid: '#8b5cf6' });
export const HIT = Object.freeze({ miss: '#e3703d', ok: '#2fa36b', over: '#4f8fe0', none: '#8a949e' });
// Druck (Bericht): helle Werte wie @media print in index.html
export const PRINT = Object.freeze({ accent: '#0f766e', panel: '#ffffff' });
// Zonen-Beobachtung: Reihen je Zone (kleine Vielfache, höchstens sechs)
export const ZONE_SERIES = Object.freeze(['#0f766e', '#c2410c', '#6d28d9', '#a16207', '#be185d', '#1d4ed8']);

const dark = () => typeof document !== 'undefined' && (document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches));
const mode = () => (dark() ? 'dark' : 'light');
/** Farbe eines Anbieters: fester Platz oder Grau („Weitere“) */
export const slotColor = (op) => (Object.hasOwn(OP_SLOT, op) ? MP7[mode()][OP_SLOT[op]] : MORE[mode()]);
/** i-te Reihe ohne Anbieter: Plätze der Reihe nach, ab dem achten Grau */
export const seriesColor = (i) => (i >= 0 && i < SLOTS ? MP7[mode()][i] : MORE[mode()]);
export const moreColor = () => MORE[mode()];
export const themed = (pair) => pair[mode()];
