# Entscheidungen

Kurz festgehalten, warum etwas so gebaut ist – mit den Zahlen, auf denen die Entscheidung beruht. Neue Entscheidungen unten anfügen.

## Datenhost: raw statt Pages

Das Dashboard liest den Datenstand direkt aus `raw.githubusercontent.com` (Branch `data`). Gemessen: 300 s Cache, gzip und offenes CORS –
das reicht für einen Datenstand, der alle 20 Minuten neu entsteht. Ein Pages-Artefakt des Datenstands bleibt ein Test für den Fall, dass raw
drosselt. jsDelivr scheidet aus: der Branch `data` liegt mit 196 MB über der Paketgrenze von 150 MB.

## Ein Commit je Lauf, Force-Push

Der Branch `data` hat keinen Verlauf: jeder Sammler-Lauf schreibt einen neuen Commit ohne Vorgänger und überschreibt den Branch. So bleibt
das Repository klein, und frühere Bestände liegen nicht im Git (Datenschutz, [Datenstand](datenstand.md)). Damit ein Fehler den Datenstand
nicht löscht: der Abruf des alten Stands unterscheidet „Branch fehlt“ von „Abruf gescheitert“ und bricht nach 3 Versuchen ab, und vor dem
Push prüft `scripts/data-guard.mjs`, ob mindestens 90 % der Dateien sowie `archive/`, `train/` und `train-cells/` da sind. Gesichert wird der
Stand zusätzlich als Vorabversion (`backup.yml`).

## Sammler-Kette und Wächter

Der Zeitplan von GitHub springt nur alle 4–8 Stunden an. Der Sammler stößt sich deshalb am Ende jedes Laufs selbst an (Takt 20 Min.), und
der Wächter startet ihn, wenn die Kette steht. `workflow_run` taugt dafür nicht, weil vom `GITHUB_TOKEN` angestoßene Läufe keine anderen
Workflows starten. Einzelheiten: [Betrieb](betrieb.md).

## esbuild mit Code-Splitting

Bis Sprint 3 kopierte der Build die Module unverändert; die Startseite lud 694 KB gzip Skript. Mit esbuild (Bündeln, Minify, Splitting,
jede Ansicht per `import()`) und Wörterbüchern je Sprache und Bereich sind es 159 KB, die Disposition 224 KB. Die Rechenkerne aus `lib/`
bleiben ohne Abhängigkeiten, damit der Sammler ohne `npm ci` läuft; nur Build und Tests haben devDependencies. Die Prognose-Engine liegt
für den Download unverändert unter `docs/engine/`. Budgets prüft `node scripts/build-web.mjs --budget`, Lighthouse prüft Skript ≤ 300 KB.

## Aufteilung der Daten

Die großen Tagesdateien gelten für ganz Deutschland; eine Ansicht für eine Gemeinde lud trotzdem alles. Gemessen (13.11.2026, Stuttgart):
13 Ereignistage 2,15 MB gzip, nur Stuttgart 96 KB; die Disposition lud 3,2 MB. Seit Sprint 3 schreibt der Sammler zusätzlich
`events/<Tag>/<Land>.json`, `events/hour-totals.json`, `events/daily-summary.json`, `ops-input/<AGS>.json` und
`ops-input/fleet/<AGS>.json` (`lib/pulse-split.js`); die Disposition lädt damit 0,92 MB bei Zeichen für Zeichen gleichem Ergebnis. Die
bisherigen Dateien laufen mindestens bis 27.11.2026 parallel.

Für das Ziel 0,4 MB kamen in der Phase `gebiet` dazu: `ops-input/cells/<AGS>.json` (Zellen spaltenweise ohne die zwei Tagessummen, die das
Nachfragemodell nicht liest, dazu die Ströme der Gemeinde), `ops-input/area/<AGS>.json` (Umsatz-Eingabe mit vorab gewähltem Tag und Tarif,
Gruppen-Ereignisse der Gemeinde, Liste der Zonen-Dateien je Anbieter), `ops-input/zones/<AGS>/<n>.json` (Zonen im Rahmen ± 0,02° + 200 m,
übrige Features `null`, damit Kennungen und Zählungen gleich bleiben) und `latest-core.json` (Quellen mit 12 Kernfeldern, ohne `groups`). Die
Seite prüft vor jeder Nutzung Stand, Rahmen und Fahrzeuge und fällt sonst auf die großen Dateien zurück. Gemessen auf dem Datenstand vom
13.11.2026: Stuttgart 918 → 392 KB gzip, Tübingen 724 → 193 KB, Köln 1,43 MB → 1,03 MB (sehr viele Zellen und drei gleiche Voi-Zonendateien).
Die Reihenfolge der Zellen bleibt wie in den Landesdateien, obwohl sortiert 20 KB kleiner wäre: Der Bootstrap der Spots zieht je Zelle in
dieser Reihenfolge.

Bewusst nicht: DuckDB-WASM mit Parquet. Die WASM-Datei hat gezippt 8,1 MB, und Parquet ist über 13 Tage mit 2,32 MB nicht kleiner als
JSON mit gzip (2,15 MB).

## Datenverträge

Die wichtigsten Dateifamilien tragen `schemaVersion` („MAJOR.MINOR“), die Schemas liegen in `schemas/`. ajv läuft nur in den Tests, der
Sammler bleibt ohne Abhängigkeiten. Vorher hatten 28 von 57 Dateifamilien ein Versionsfeld, uneinheitlich benannt (`version`, `v`).
[Datenformate](datenformate.md).
