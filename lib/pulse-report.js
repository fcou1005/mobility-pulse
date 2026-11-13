// @ts-check
// Mobility Pulse — Kommunal-Bericht, Obergrenzen-Wächter, Wochen-Heatmap, Preis-Log und Feed-Prüfung.
// Reine Rechenfunktionen ohne DOM (Browser und Node). Grundlage: events/<Tag>.json (Stundenwerte, Läufe),
// history/<Tag>.json (Bestand je Lauf), cells/<Tag>/<Land>.json (Zellen), latest.json, reference.json.
// Fassade: der Code steht in pulse-report-base.js, pulse-report-caps.js, pulse-report-city.js; Importe dieser Datei bleiben unverändert.
export * from './pulse-report-base.js';
export * from './pulse-report-caps.js';
export * from './pulse-report-city.js';
export { CELL_LAT, CELL_LON } from './pulse-track.js';
