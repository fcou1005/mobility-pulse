# Datenstand (Branch data)

Was der Sammler alle 20 Minuten in den Branch `data` schreibt. Formate mit Versionsfeld: [Datenformate](datenformate.md).

## Dateien

Sharing-Daten für Deutschland (E-Scooter, Bikesharing, Lastenräder, E-Roller, Carsharing frei und stationsgebunden) aus offenen Quellen – gesammelt, geprüft, zusammengeführt.

- **Branch `main`:** Code (Katalog-Builder, Sammler, Kernbibliothek, Dashboard).
- **Branch `data`:** Datenstand, alle 20 Minuten neu geschrieben (ein Commit, kein Verlauf im Git):
  `latest.json`, `status.json`, `sources.json`, `history/<Tag>.json`, `snapshot/*.json`, `boundaries-active.json`, `boundaries/<Land>.json` (alle Gemeinden eines Landes mit `bbox`, Verzeichnis `boundaries/index.json`; das Dashboard lädt nur das Land der Auswahl),
  `events/<Tag>.json` (Fahrten, Umsetzungen, Akkutausch, Abholungen, Sperren je Stunde und Gemeinde × Anbieter × Fahrzeugart; laufender Tag nur abgeschlossene Stunden),
  `cells/<Tag>/<Land>.json` (Start/Ziel/Präsenz je ≈250-m-Zelle; laufender Tag nur abgeschlossene Tageszeit-Bänder, Zelle × Band unter 3 Ereignissen nur als Summe je Gemeinde), `idle.json`, `idle-long.json`, `stations-quota.json`,
  `reliability.json`, `pricing.json`, `zones/*.json` (GBFS-Betriebszonen, täglich), `pricing-log.json` (Tarifänderungen, 180 Tage), `history/daily.json` (verdichtete Tageswerte; seit 02.11.2026 `breaks: { 'Gemeinde|Anbieter|Art': 'JJJJ-MM-TT' }` = erster Tag mit neuem Regelstand, wenn der Bestand der Reihe im ersten Lauf mit neuem Regelstand um ≥ 10 % und ≥ 5 Fahrzeuge gegenüber dem letzten Lauf mit altem sprang; einmal rückwirkend aus `runs.json` und `history/<Tag>.json`, z. B. 82 Reihen am 02.11.2026: Spiegelquellen bis 07:17 doppelt, Köln nextbike 4.952 → 2.406), `DATA-LICENSE.md` (Quellen und Lizenzen). Der Verfolgungszustand (Kennungen per HMAC mit privatem Salt) liegt seit 01.11.2026 im Actions-Cache (`TRACK_DIR`), nicht mehr auf `data`;
  `ops/<Land>.json` (Flotte je Bundesland mit Akku, Reichweite, Standzeit, Stationsfüllstand – Grundlage der Disposition; Felder am Ende einer Fahrzeugzeile ohne Wert entfallen, fehlend = null, `vehicleFieldsNote`; seit 02.11.2026 Feld 13 `standzeitMindestens` = 1, wenn das Fahrzeug seit Beginn der Verfolgung unbewegt ist, und `trackStart` im Kopf; Feld 8 seit 6.11.2026 `standzeitKlasseMin` = Untergrenze der Standzeit-Klasse in Minuten: 0, 360, dann ganze Tage; null bei Quellen mit unbrauchbarer Standzeit).
  `idle.json` (Version 2): `buckets` `<2 h`, `2–8 h`, `8–24 h`, `1–2 Tage`, `2–3 Tage`, `> 72 h`; `groups[Gemeinde|Anbieter|Art]` = Anzahl je Klasse, dann Summe (bis 02.11.2026 fünf Klassen mit `>2 Tage`, Summe an Stelle 6); `censored` = davon Mindestwerte je Klasse; `trackStart`; `unusable` = Quellen ohne Standzeit. `idle-long.json`: Punkte ab 48 h, `censored: 1` = Mindestwert.
  `coverage.json` (Städte laut Anbieter gegen Feeds), `zone-watch.json` (Bestand je privat hinterlegter Zone, 30 Tage), `flows-est/<Tag>.json` (geschätzte Ströme für rotierende Kennungen), `flows-week/<Montag>.json` (gemessene Ströme je Kalenderwoche, 500 m).
  `calendar.json` (Tagtyp-Kalender, OpenHolidays API, ODbL; einmal je Berliner Tag, heute −400 bis +400 Tage): `{ version: 1, generatedAt, source, from, to, states: { BW: { 'JJJJ-MM-TT': 'F' | 'H' } } }` – nur Ausnahmen je Land (H gesetzlicher Feiertag, F Schulferien-Werktag Mo–Fr; örtliche Feiertage wie DE-BY-AU und halbe Tage ausgelassen, Ferien nur für einzelne Schularten in MV gelten für das ganze Land). Fehlt das Netz oder kommt eine unplausible Antwort, bleibt die alte Datei; `CALENDAR_URL` leer schaltet den Abruf ab (Fixture-Test).
  `latest.json` → `measure` (Version 1): je veröffentlichtem Ereignistag `days[Tag] = { obs: Minuten je Ortsstunde 0–23 ohne Lücken-Stunden, runs, counted, rules: METHOD_VERSION der gezählten Läufe ("" = ohne), full: ≥ 20 h mit ≥ 50 Min., complete }` (`E.measureDay`; abgeschlossene Tage werden übernommen). `latest.json` → `eventChecks`: Ampel je Gemeinde|Anbieter|Art am letzten vollständigen Tag `{ day, version, rules, dayRules, ruleNow, ruleCurrent, groups: { 'ags|op|type': { level: 'ok'|'warn'|'bad', was?: 'bad', checks: { rides, pickupShare, r, se, swapsPer100, hideShare?, idleUnusable?, batteryFloor?, oldRule?, flags } } } }` (`E.eventChecks`, nur Gruppen ab 50 Fahrten oder mit Quellenbefund; berechnet nach der Verfolgung, damit `idleUnusable` dieses Laufs eingeht). `dayRules` = Regelstände (Teil vor „@“, `""` = ohne Angabe) der gezählten Läufe des Tags, mehrere = gemischter Tag; `ruleNow` = METHOD_VERSION des Sammlers; `ruleCurrent` = Tag einheitlich mit `ruleNow`. Sonst wird rot zu gelb (`was: 'bad'`, Flag `oldRule`, `checks.oldRule = dayRules`): Befund aus älterem Regelstand, kein Ausschluss.

## Daten nach Gebiet (seit 13.11.2026)

Neben den Tagesdateien schreibt der Sammler kleinere Dateien für eine Gemeinde oder ein Land (`lib/pulse-split.js`); die bisherigen Dateien
bleiben mindestens bis 27.11.2026 parallel:

- `events/<Tag>/<Land>.json`: dieselbe Tagesdatei nur mit den Gruppen des Landes (Kopf gleich, Feld `state`).
- `events/hour-totals.json`: je Tag die Läufe und die Fahrtbeginne je Stunde über alle Gruppen – daraus entsteht das Tagesgang-Profil.
- `events/daily-summary.json`: Tagessummen je Gruppe (`fields`: start, end, reloc, swap, vmin).
- `ops-input/<AGS>.json`: Zellen der letzten 7 Zellen-Tage nur dieser Gemeinde und ihr Begrenzungsrahmen für die Disposition;
  `ops-input/index.json` listet die Gemeinden und Tage.
