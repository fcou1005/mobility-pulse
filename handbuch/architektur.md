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
| `scripts/collect.mjs` | Sammler: Abruf, Bestand, Verfolgung (Fahrten, Umsetzungen, Akkutausch), Zellen, Ströme, Prognose, Kalibrierung; Phasen mit Zeitmessung in `status.json` |
| `lib/pulse-*.js` | gemeinsame Rechenkerne ohne Abhängigkeiten, im Sammler und im Browser dieselben |
| `web/` | Dashboard-Quelle; `app.js` ist der Einstieg, Ansichten werden beim ersten Öffnen nachgeladen |
| `docs/` | gebaute Seite (nicht von Hand ändern) |
| `schemas/` | Datenverträge der wichtigsten Dateien ([Datenformate](datenformate.md)) |
| `test/` | Tests; `test/fixtures/web-data` ist ein fester Ausschnitt des Datenstands |

## Rechenkerne in `lib/`

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
| `pulse-split.js` | Daten nach Gebiet (Ereignisse je Land, Stundensummen, `ops-input`) |
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
einer Datei nicht, erscheint ein Hinweis ([Datenformate](datenformate.md)). Für eine Gemeinde liest die Disposition nur
`ops-input/<AGS>.json` und die Ereignisse ihres Landes ([Entscheidungen](entscheidungen.md#aufteilung-der-daten)).

## Datenschutz

Fahrzeugkennungen verlassen den Sammler nur als HMAC mit privatem Salt und nur im privaten Zustand (Actions-Cache). Veröffentlicht werden
Summen: Ereignisse erst nach Stundenende, Zellen erst nach Ende eines Tageszeit-Bands und unter 3 Ereignissen nur als Summe, Standzeit nur
als Klasse. Einzelheiten: [Datenstand](datenstand.md), [Regeln](regeln.md), `web/datenschutz.html`.
