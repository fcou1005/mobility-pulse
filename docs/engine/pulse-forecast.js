// @ts-check
// Prognose-Engine (Fahrtbeginne je Anbieter × Gemeinde × Art und Stunde): ein Modell über ALLE Gruppen, das sich täglich selbst prüft.
//
// Idee: Jede Gruppe (Gemeinde|Anbieter|Art) liefert je Stunde Starts y und Fahrzeugstunden e (Summe der Fahrzeugminuten ÷ 60). Gepoolt gilt
//   y ~ Poisson(μ),  log μ = log e + a_g + Stunde[h] + Tagtyp×Stunde[c,h] + Regelstand[era] + Wetter(T, Regen)
// a_g ist der Gruppeneffekt (Empirical-Bayes-geschrumpft Richtung „durchschnittliche Gruppe“), alles andere wird von allen Gruppen gemeinsam
// gelernt – eine neue oder kleine Gruppe erbt damit Tagesgang, Wochentagsmuster und Wetterreaktion der anderen. Wetter und Tagtyp×Stunde
// schalten sich erst frei, wenn die Daten sie tragen (Tagtyp: ≥ 1 Tag; Wetter: Temperaturspanne und Regen-/Trockentage, GATES).
//
// Selbstprüfung (Rolling Origin, ein Tag voraus): für jeden abgeschlossenen Tag d wird mit den Tagen < d trainiert, d vorhergesagt und mit der
// Realität verglichen (WAPE, Verzerrung, Abdeckung des 80-%-Bandes). Drei Modelle laufen gegeneinander: profile (je Gruppe, ohne Pooling),
// pooled (ohne Wetter), pooledWx (mit Wetter). Aktiv ist das mit dem kleinsten mittleren Fehler der letzten Tage; das Wettermodell muss das
// gepoolte um GATES.wxGain schlagen. Solange zu wenige Tage ausgewertet sind, steht status = 'learning' und die Prognose ist vorläufig.
// Beim Backtest zählt das beobachtete Wetter des Tages (Orakel); die Prognose selbst nutzt die Wettervorhersage (Bright Sky/MOSMIX).
// Fassade: der Code steht in pulse-forecast-model.js, pulse-forecast-select.js, pulse-forecast-series.js; Importe dieser Datei bleiben unverändert.
export * from './pulse-forecast-model.js';
export * from './pulse-forecast-select.js';
export * from './pulse-forecast-series.js';
export { CTX_KEYS } from './pulse-context.js';
export { FAMILIES } from './pulse-core.js';
