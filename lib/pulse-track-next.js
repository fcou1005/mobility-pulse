// Kandidat der Fahrterkennung (Sprint 1, Schattenbetrieb P4): dieselbe Verfolgung wie lib/pulse-track.js, mit den Kandidaten-Regeln
// (Beschreibung bei trackRun). Der Sammler rechnet sie mit eigenem Zustand neben den geltenden Regeln und schreibt nur shadow/diff-<Tag>.json;
// veröffentlicht wird weiter nach lib/pulse-track.js. Abgelöst wird erst nach 7 vollen Tagen im Schatten mit bestandenem Prüfstand
// (test/algo-next.test.mjs); dann werden die Regeln Standard und METHOD_VERSION in lib/pulse-track.js steigt.
export * from './pulse-track.js';
import { trackRun as trackRunBase } from './pulse-track.js';

export const METHOD_VERSION = '2026-11-13-kandidat';
export const NEXT_RULES = Object.freeze({
  stableAbove: 0.35, rotBelow: 0.15, // S1.3 Hysterese des Kennungsmodus (bisher eine Schwelle 0,25)
  massShare: 0.15, // S1.9 Teilausfall: ab 15 % der Flotte (≥ 10 Fahrzeuge) in einem Lauf verschwunden bzw. neu = Feedfehler (bisher 30 %; Spitzenlauf ≈ 5 % Fahrtbeginne)
  minEvents: 8,
  groupMin: 3, collectNightM: 300,
  gapMaxMs: 3 * 3600e3, // A22: Lücken bis 3 h schätzen (Ereignisse des Lückenlaufs zählen, als geschätzt markiert) // A4/A21: Einsammeln und Ausbringen als Gruppe ab 3 Fahrzeugen (bisher nur Ereignis-Anzeige ab 4, Fahrten zählten trotzdem)
  stationExactM: 1.5, stationChurnMin: 0.06, // A2: an Stationen ≤ 1,5 m paaren (Zustand speichert Positionen auf ~1 m genau), wenn die Quelle ≥ 6 % neue Kennungen je Lauf hat (normal 2–5 %) // A23: Modus ab 8 Ereignissen im gedämpften Fenster (bisher 20 – kleine Flotten blieben stundenlang „unbekannt“, Versätze zählten als Umsetzung)
});
export const trackRun = (prev, opts) => trackRunBase(prev, { ...opts, next: NEXT_RULES });
