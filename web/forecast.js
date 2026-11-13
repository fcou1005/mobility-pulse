// Mobility Pulse — Prognose-Ansicht: Plan heute, Ist bis jetzt und Live-Prognose bis Ende morgen als Zeitreihe, Lernstand und Trefferquote der Prognose,
// Bewertung der bekannten Deploy- und Parkspots (Wichtigkeit, Soll, Ist, Fehlbestand).
// Eigener Hauptreiter mit drei Segmenten: renderForecastView(el, ctx, { part: 'verlauf' | 'spots' | 'basis' }) – Verlauf (Lernstand, Zeitreihe, Trefferquote),
// Spots (Bewertung der bekannten Spots), Grundlagen & Kontrolle (alles, was genutzt, erzeugt oder vermutet wird, mit Selbstprüfungen und Rohdaten).
// ctx = { state, CFG, esc, fmt, getJson, muniName, setScope, setFilter, resetFilters, loadUsageIndex, loadEvents, loadCells, loadOnce };
// Leaflet (L) global. Daten: forecast/series.json, forecast/latest.json, forecast/log.json (Sammler, lib/pulse-forecast.js); Spots über lib/pulse-spots.js.
// Je Fahrzeugfamilie ein eigenes Modell (FC.FAMILY_DIR: forecast/, forecast/moped/, forecast/car/); die Familie folgt der Fahrzeugart-Auswahl
// oder dem Umschalter in der Kopfleiste.
// Werte aus Daten gehen durch ctx.esc; Texte im Wörterbuch web/i18n.js (Schlüssel fv.*).
// Fassade: der Code steht in forecast-data.js, forecast-parts.js, forecast-view.js; Importe dieser Datei bleiben unverändert.
export * from './forecast-data.js';
export * from './forecast-parts.js';
export * from './forecast-view.js';
