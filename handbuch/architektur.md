# Architektur

Mobility Pulse besteht aus einem Sammler, der alle 20 Minuten offene Sharing-Daten abruft und auswertet, einem Datenstand im Branch
`data` und einem Dashboard, das diesen Datenstand im Browser liest. Es gibt keinen Server und keine Datenbank.

```text
Feeds (GBFS, MobiData BW, MOBIDROM NRW, CityBikes, …)
        │  abrufen, prüfen, zusammenführen
        ▼
scripts/collect.mjs  ── privater Zustand (Kennungen nur als HMAC) im Actions-Cache, nie im Datenstand
        │  ein Commit je Lauf, Force-Push
        ▼
Branch data  ──  raw.githubusercontent.com (300 s Cache, gzip, offenes CORS)
        │
        ▼
docs/ (GitHub Pages)  ←  web/ + lib/ gebündelt mit esbuild (scripts/build-web.mjs)
```

## Bausteine

| Ort | Aufgabe |
| --- | --- |
| `scripts/build-catalog.mjs` | Quellenkatalog `data/sources.json` aus den Verzeichnissen ([Quellen](quellen.md)) |
| `scripts/prepare-boundaries.mjs` | Gemeindegrenzen (BKG VG250) |
| `scripts/collect.mjs` | Sammler-Ablauf: ruft die Phasen in `scripts/collect/` nacheinander auf und misst je Phase die Zeit (`status.json` → `phases`) |
| `scripts/collect/NN-<phase>.mjs` | je Phase eine Funktion `run(ctx)`: Abruf, Auswertung, Dubletten, Verfolgung (Fahrten, Umsetzungen, Akkutausch), Ereignisse und Zellen, Prognose, Kalibrierung, Grenzen, Abschluss |
| `lib/pulse-*.js` | gemeinsame Rechenkerne ohne Abhängigkeiten, im Sammler und im Browser dieselben |
| `web/` | Dashboard-Quelle; `app.js` ist Einstieg und Steuerung, `app-*.js` die Teile der Startseite, Ansichten werden beim ersten Öffnen nachgeladen |
| `docs/` | gebaute Seite (nicht von Hand ändern) |
| `schemas/` | Datenverträge der wichtigsten Dateien ([Datenformate](datenformate.md)) |
| `test/` | Tests; `test/fixtures/web-data` ist ein fester Ausschnitt des Datenstands |

## Sammler in Phasen

`scripts/collect.mjs` legt ein leeres `ctx` an, ruft `scripts/collect/00-start.mjs` (Umgebung, Katalog, Vorlauf) und danach die Phasen in
fester Reihenfolge auf. Was eine Phase für spätere braucht, legt sie in `ctx` ab: Konstanten und Funktionen packen spätere Phasen am Anfang
von `run` aus, veränderliche Werte (`let`) stehen nur in `ctx` und werden dort gelesen und geschrieben. Die Phasennamen sind dieselben wie in
`status.json` → `phases` und in der Statusansicht.

| Phase | Inhalt |
| --- | --- |
| `start` | Umgebung, Verfolgungs-Salt, Katalog, Grenzen, Vorlauf, Abruf-Helfer |
| `abruf`, `auswertung` | Quellen abrufen, Fahrzeuge und Stationen je Gemeinde, Feed-Prüfung |
| `preise-zonen`, `konsistenz`, `dubletten` | Tarife und Zonen, Abgleich zwischen Quellen, Dubletten und Spiegel |
| `betriebsgebiete`, `messbasis`, `obergrenzen`, `zonen-beobachtung` | Präsenz, `latest.json`, Messbasis, Obergrenzen, Zonen |
| `kalender-wetter`, `verkehr`, `baustellen`, `oepnv` | Umgebung der Prognose |
| `verfolgung`, `abdeckung`, `ereignisse` | Fahrten, Umsetzungen, Zellen, Ströme, Bestand je Land und Gemeinde, Daten nach Gebiet |
| `sport-termine`, `streiks`, `prognose`, `training` | Termine, Streiks, Prognose, Trainingsarchiv |
| `kalibrierung`, `grenzen` | Kalibrierung, Gemeindegrenzen |
| `gebiet` | Dateien je Gemeinde für die Disposition (`scripts/gebiet.mjs`): `latest-core.json`, `ops-input/cells`, `ops-input/area`, `ops-input/zones` |
| `alarme` | Alarme je Gemeinde (Obergrenze, Quelle aus, Zonen, Preise, Flottensprung) → `auflagen/alarme.json`, Atom-Feeds `feeds/<AGS>.xml` |
| `datenvertraege`, `abschluss` | Formatversion, Lizenzen und `status.json` |

## Startseite in Modulen

| Datei | Inhalt |
| --- | --- |
| `web/app.js` | Einstieg und Steuerung: Bedienelemente, Adresse, Sprungleiste, Start |
| `web/app-core.js` | Einstellungen, Formatierung, Farben, Glossar, Zustand |
| `web/app-load.js` | Dateien des Datenstands, Cache, Hinweise, Grenzen, Verlauf |
| `web/app-scope.js`, `web/app-live.js` | Gebiet, Live-Abruf |
| `web/app-router.js` | Ansichten, nachgeladene Module, nur die sichtbare Ansicht zeichnen |
| `web/app-lang.js` | Sprache, Kopfzeile, Übersicht und Leistung |
| `web/app-map.js`, `web/app-energy.js`, `web/app-signals.js` | Karte und Ebenen, Energie, Signale |
| `web/app-sources.js`, `web/app-usage.js`, `web/app-calib.js` | Quellen und Datenvertrauen, Nutzung und Umsatz, Kalibrierung |

Gemeinsame Bausteine der Oberfläche: `web/answer.js` (Antwort-Komponente), `web/charttip.js` (Hover-Layer für alle Diagramme), `web/tokens.js` (Farben), `web/app-terms.js` (Begriffe, Erstbesuch). Das Stadt-Paket (`web/stadt.js`) lädt wie die anderen Ansichten erst beim Öffnen.

Die nachgeladenen Ansichten sind ebenso geteilt: `web/ops.js` (Disposition), `web/report.js` (Bericht) und `web/forecast.js` (Prognose) sind
Fassaden mit `export *` aus `ops-data|plan|extra.js`, `report-core|maps|watch|avail|more.js` und `forecast-data|parts|view.js`. Das
Wörterbuch `web/i18n-dict.js` fügt `web/i18n-de-1…7.js` und `web/i18n-en-1…7.js` in der ursprünglichen Reihenfolge zusammen.

## Rechenkerne in `lib/`

Keine Datei hat mehr als 600 Zeilen. Fünf große Module sind Fassaden (`export *` aus ihren Teilen, Importe bleiben gleich):
`pulse-core.js` (`-base`, `-feeds`, `-agg`), `pulse-track.js` (`-rules`, `-run`, `-publish`), `pulse-report.js` (`-base`, `-caps`, `-city`),
`pulse-ops.js` (`-model`, `-tours`, `-places`) und `pulse-forecast.js` (`-model`, `-select`, `-series`). Der Download der Prognose-Engine
liefert die Teile mit.

| Datei | Inhalt |
| --- | --- |
| `pulse-core.js` | Feeds lesen, Bestand, Dubletten, Energie, sichere Texte |
| `pulse-track.js` | Verfolgung: Fahrten, Umsetzungen, Zellen, Ströme, Veröffentlichungsregeln |
| `pulse-econ.js` | Kennzahlen, Tagesgang, Tagtypen, Messbasis |
| `pulse-calib.js`, `pulse-report.js` | Kalibrierung, Kommunal-Bericht, Obergrenzen |
| `pulse-ops.js`, `pulse-idle.js` | Disposition: Nachfragemodell, Spots, Touren; Standzeit-Klassen |
| `pulse-forecast.js`, `pulse-context.js`, `pulse-chronos.js` | Prognose, Umgebung (Wetter, Veranstaltungen, Verkehr), Chronos-Band |
| `pulse-flowest.js` | geschätzte Ströme für rotierende Kennungen |
| `pulse-status.js` | Laufzeit-Budget und `status.json` |
| `pulse-schema.js` | Formatversion je Dateifamilie |
| `pulse-split.js` | Daten nach Gebiet (Ereignisse je Land, Stundensummen, `ops-input`, Ausschnitte je Gemeinde, `latest-core.json`) |
| `pulse-coverage.js`, `pulse-compare.js`, `pulse-spots.js` | Abdeckung (Anbieter-Website gegen Feeds), Anbieter-Vergleich, Spot-Abgleich |
| `pulse-strike.js`, `pulse-termine.js`, `pulse-oepnv.js` | Streiks, Termine aus Quellenseiten, ÖPNV-Störungen (Umgebung der Prognose) |
| `pulse-train.js` | Langzeitarchiv der Trainingsdaten (`train/`, `train-cells/`) |
| `pulse-track-next.js` | Kandidat der Fahrterkennung im Schattenbetrieb (`shadow/`) |

## Dashboard

`scripts/build-web.mjs` bündelt `web/app.js` mit esbuild (ESM, Code-Splitting). Das Startpaket enthält die Übersicht; Disposition,
Bericht, Ströme, Abdeckung, Vergleich, Spots, Prognose und Status kommen per `import()` beim ersten Öffnen. Die Texte liegen je Sprache
und Bereich in `docs/i18n/<de|en>/<bereich>.json` (Quelle `web/i18n-dict.js`). Budgets: Start höchstens 180 KB, Disposition höchstens
270 KB gzip (`--budget`).

Dateien des Datenstands lädt die Seite über einen gemeinsamen Cache je Datenstand (`web/app.js` `cached`). Passt die MAJOR-Version
einer Datei nicht, erscheint ein Hinweis ([Datenformate](datenformate.md)). Für eine Gemeinde liest die Disposition nur Dateien dieser
Gemeinde unter `ops-input/` ([Entscheidungen](entscheidungen.md#aufteilung-der-daten)). Öffnet jemand die Seite direkt in der Disposition,
startet sie mit `latest-core.json` (Quellen ohne Prüfdetails, ohne `groups`); jede andere Ansicht lädt vor dem Zeichnen `latest.json`
(`web/app-load.js` `ensureFullLatest`).

## Datenschutz

Fahrzeugkennungen verlassen den Sammler nur als HMAC mit privatem Salt und nur im privaten Zustand (Actions-Cache). Veröffentlicht werden
Summen: Ereignisse erst nach Stundenende, Zellen erst nach Ende eines Tageszeit-Bands und unter 3 Ereignissen nur als Summe, Standzeit nur
als Klasse. Einzelheiten: [Datenstand](datenstand.md), [Regeln](regeln.md), `web/datenschutz.html`.
