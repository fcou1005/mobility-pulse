# ÖPNV (16.11.2026)

Ansicht Heute › ÖPNV (`#oepnv`, `web/oepnv.js`; Kurzlinks `#nahverkehr`, `#verspaetung`, `#transit`). Busse und Bahnen in den Gemeinden mit Sharing-Flotte: Live-Karte, Pünktlichkeit je Tag und Stunde, Stationen mit den meisten Störungen, Wirkung von Störungen auf die Sharing-Nachfrage und Vorschläge für Sharing-Stationen. Formate: [Datenformate](datenformate.md) (Familie `oepnv`).

## Quelle und Lizenz

- Echtzeit: freier GTFS-Realtime-Strom von gtfs.de (`realtime-free.pb`, DELFI e. V. u. a., CC BY-SA 4.0), ein Abruf je Sammler-Lauf (Phase `oepnv`, `scripts/collect/13-oepnv.mjs`). Der Abruf ist derselbe wie für die Störungsmerkmale der [Prognose](prognose.md); es kommt kein zweiter dazu.
- Haltestellen und Linien: `stops.txt` und `routes.txt` aus dem Deutschland-Fahrplan von gtfs.de (CC BY 4.0), per Bereichsabruf aus dem Zip, neu nur bei geändertem Fahrplan.
- Die Dateien unter `oepnv/` sind aus dem Strom abgeleitet und stehen deshalb unter CC BY-SA 4.0, abweichend vom übrigen Datenstand. Jede Datei trägt `license` und `attribution`.
- Keine Fahrgastzahlen, keine Ortung. Fahrten ohne Echtzeit fehlen im Strom und damit überall in dieser Ansicht.

## Zählung (`lib/pulse-oepnv-netz.js`)

- Haltestellen mit gleicher `parent_station` bilden eine Station; fehlt sie, zählen die ersten drei Teile der DELFI-Kennung (`de:08111:6115:1:2` → `de:08111:6115`). Gezählt wird je Station und je Gemeinde (Punkt-in-Polygon gegen VG250).
- Ein Halt zählt als verspätet ab 5 Minuten, als ausgefallen bei `SKIPPED` oder ausgefallener Fahrt. Jeder Halt zählt einmal je 6-Stunden-Block, auch wenn mehrere Läufe ihn sehen.
- Summen je Station altern mit 7 Tagen Halbwertszeit (`NETZ.halfLifeDays`); `days` in der Datei ist die gewichtete Zahl der Tage, Halte je Tag = `halte ÷ days`. Veröffentlicht werden je Gemeinde höchstens 300 Stationen nach Halten.
- Stunden: 24 Ortsstunden je Tag über 8 Tage. Gestört heißt ab 20 Halten mit Echtzeit mindestens 15 % ausgefallen oder 30 % verspätet (gleiche Regel wie die Störungsmerkmale der Prognose).

## Live-Karte (`lib/pulse-oepnv-karte.js`)

- Der Strom enthält Haltezeiten, keine Fahrzeugpositionen. Der Sammler schreibt je Fahrt die Stationen der nächsten 45 Minuten mit Ankunftszeit inklusive Verspätung (`oepnv/live/<AGS>.json`, höchstens 1.500 Fahrten je Gemeinde, 14 Punkte je Fahrt).
- Die Seite setzt das Fahrzeug zwischen zwei Stationen gleichmäßig auf die Luftlinie (`positionAt`) und zeichnet alle 5 Sekunden neu (bei „Bewegung reduzieren“ alle 30 Sekunden). Alle 5 Minuten lädt sie die Datei nach.
- Farbe nach Verspätung am nächsten Halt: pünktlich, ab 2 Minuten, ab 5 Minuten, ohne Angabe. Sharing-Fahrzeuge lassen sich einblenden (`ops-input/fleet/<AGS>.json`).
- Grenzen: echte Strecke und echtes Tempo sind unbekannt; ein Fahrzeug kann auf der Karte quer über einen Häuserblock fahren. Nach dem Ende der 45 Minuten ohne neuen Lauf sagt die Karte das und zeigt keine Fahrzeuge mehr.
- Verworfen: Fahrzeugpositionen von Transitous (nur für nicht-kommerzielle Open-Source-Projekte freigegeben).

## Linien (`lib/pulse-oepnv-linien.js`)

- Der Strom nennt je Fahrt nur `trip_id`. Die Linie kommt aus `trips.txt` des Fahrplans: bei jedem neuen Fahrplan baut der Sammler eine Tabelle Fahrt → Linie (zwei 32-Bit-Hashes je Fahrt, 12 Bytes je Fahrt) und legt sie im Zwischenspeicher ab (`TRACK_DIR/oepnv-fahrten.bin.gz`), nicht im Datenstand. Scheitert der Abruf, bleiben Fahrzeuge ohne Liniennamen bis zum nächsten Fahrplan.
- Zählung je Linie wie je Station (Schlüssel Gemeinde, Art, Linienname; 6-Stunden-Blöcke, 7 Tage Halbwertszeit), nur Halte im Stadtgebiet. Veröffentlicht werden je Gemeinde 80 Linien (`lines` in `oepnv/<AGS>.json`). Linien gleichen Namens verschiedener Betreiber fallen zusammen.
- Die Ansicht zeigt die 15 Linien mit dem höchsten Anteil ausgefallener und verspäteter Halte ab 40 Halten.

## Tagesgang und Nachtnetz-Lücke (`dayProfile`)

- Mittel je Ortsstunde über die vollen Tage im 8-Tage-Fenster: ÖPNV-Halte mit Echtzeit gegen Sharing-Fahrtbeginne (`forecast/series.json`).
- Lücke: ÖPNV unter 25 % seines Tageshöchstwerts und mindestens 3 Sharing-Fahrtbeginne in der Stunde. Die Ansicht nennt die Stunden und den Anteil der Sharing-Fahrten darin.
- Halte ohne Echtzeit fehlen; in Städten mit wenig Echtzeit wirkt der ÖPNV dünner, als er ist.

## Alarm „ÖPNV gestört“ (`lib/pulse-alarme.js`)

- Thema `oepnv` in den Alarmen und Feeds je Gemeinde: Die letzte volle Stunde wechselt von normal auf gestört (Regel wie oben). Nur Gemeinden ab 20 Fahrzeugen, höchstens ein Alarm je Gemeinde in 6 Stunden, der erste Lauf meldet nichts.
- Der Text nennt Stunde, Anteile und die verfügbaren Sharing-Fahrzeuge im Stadtgebiet; Push über ntfy wie bei den anderen Themen.

## Wirkung auf Sharing (`ptEffect`)

- Je Stunde zwischen 6 und 22 Uhr: Sharing-Fahrtbeginne ÷ Prognose des Vortags − 1. Je Gemeinde und Tag ein Wert: Mittel der gestörten Stunden minus Mittel der übrigen Stunden desselben Tages.
- 90-%-Intervall (Student-t) aus den Tageswerten, je Gemeinde ab 3 Tagen mit Störung, über alle Gemeinden ab 5 Stadt-Tagen. Urteil „mehr“ oder „weniger“ nur, wenn das Intervall die Null nicht enthält.
- Zusammenhang, keine Ursache: Wetter und Großereignisse bewegen beide Seiten. Die Prognose nutzt die Störungsmerkmale erst, wenn sie im Schattenvergleich gewinnen ([Prognose](prognose.md)).

## Vorschläge für Sharing-Stationen (`hubCandidates`)

- Kandidaten: Stationen ab 30 Halten je Tag ohne Abstellinsel eines Anbieters in 50 m (Inseln aus den Zonen-Feeds, `parkingIslands`).
- Punkte = 40 % ÖPNV-Halte (log), 30 % Störquote (ausgefallen + verspätet ÷ Halte), 30 % Sharing-Fahrtenden im Umkreis von 150 m (log, Monatszählung je 50-m-Zelle aus `abstell/<AGS>.json`), jeweils als z-Wert unter den Stationen der Gemeinde. Gezeigt werden die 20 besten, mit CSV.
- Der Vorschlag kennt weder Gehwegbreite noch Eigentum; er ersetzt keine Ortsbegehung. Flächen mit Geometrie plant der Abstellflächen-Planer in [Umfeld](umfeld.md).

## Tests

- `node test/oepnv.test.mjs` (Zählung, Stationsbündelung, Wege, Wirkung), Browser-Test `oepnv` gegen den synthetischen Stand aus `scripts/oepnv-fixture.mjs` (`test/fixtures/oepnv-synth`).
