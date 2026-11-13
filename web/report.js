// Mobility Pulse — Bericht: Kommunal-Bericht (druckbar, CSV), Obergrenzen-Wächter, Heatmap Stunde × Wochentag,
// Preisänderungs-Log und Feed-Prüfung. Eigenständiges Modul; app.js übergibt
// ctx = { state, CFG, esc, fmt, getJson, opColor, muniName } und optional loadUsageIndex, loadEvents, loadHistory, loadCells (geteilter Cache).
// Rechenlogik in pulse-report.js; alle Werte aus Daten gehen durch ctx.esc, Tooltip-Texte über textContent.
// Fassade: der Code steht in report-core.js, report-maps.js, report-watch.js, report-avail.js, report-more.js; Importe dieser Datei bleiben unverändert.
export * from './report-core.js';
export * from './report-maps.js';
export * from './report-watch.js';
export * from './report-avail.js';
export * from './report-more.js';
export { CALIB_DAYS, SUSPENDED_TXT, calibLabel, mbTypeName, mbBase, mbMainType, mbBadge, mbInTile, mbTiles, mbChecksText, mbLevel } from './ui-shared.js';
