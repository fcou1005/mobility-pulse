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

- Der Strom enthält Haltezeiten, keine Fahrzeugpositionen. Der Sammler schreibt je Fahrt die Stationen der nächsten 70 Minuten mit Ankunftszeit inklusive Verspätung (`oepnv/live/<AGS>.json`, höchstens 1.500 Fahrten je Gemeinde, 24 Punkte je Fahrt).
- Die Seite setzt das Fahrzeug zwischen zwei Stationen gleichmäßig auf den Streckenverlauf, wo er bekannt ist (`positionAlong` in `lib/pulse-oepnv-wege.js`, Anteil der Zeit = Anteil der Länge); ohne Verlauf steht es an der näheren der beiden Stationen (seit 18.11.2026, vorher quer auf der Luftlinie), und rechnet die Lage jede Sekunde neu (bei „Bewegung reduzieren“ alle 15 Sekunden, bei verdecktem Fenster gar nicht). Jede Minute fragt sie nach einer neueren Meldung; der Sammler liefert etwa alle 20 Minuten eine.
- Fahrzeuge sind Schildchen mit dem Liniennamen (`web/oepnv-karte.js`), Rand nach Verspätung am nächsten Halt: pünktlich, ab 2 Minuten, ab 5 Minuten, ohne Angabe. Unter Zoomstufe 13 werden daraus Punkte, ab Zoomstufe 15 steht das Ziel mit auf dem Schildchen. Darüberfahren zeigt Linie, Ziel, nächsten Halt mit Uhrzeit und Verspätung; Klick listet die nächsten bis zu 10 Halte mit Uhrzeit (Verspätung eingerechnet). Ziel und Haltenamen seit Format 1.6 (17.11.2026): `ziel` je Fahrt aus `trip_headsign` des Fahrplans (Fahrtentabelle `LINIEN` Version 2, `OEPNV.version` 3 erzwingt den Neubau), sonst der Name der letzten Station im Strom; `halte` je Fahrt verweist auf `names`, die Namensliste der Datei.
- Verkehrsmittel (`modeClass`, seit Format 1.2) aus `route_type` und Linienname: Bus, Straßenbahn, U- und Stadtbahn, S-Bahn, Regionalbahn, Fernverkehr; je Verkehrsmittel ein Schalter.
- Linienwege (`segmentsOf`): jede Verbindung Station → Station aus den Fahrzeugwegen der letzten Meldung, Farbe nach Verkehrsmittel. Es sind nur die Abschnitte, die in den nächsten 70 Minuten befahren werden. Gezeichnet wird ein Abschnitt nur im Streckenverlauf; Luftlinien von Halt zu Halt ergaben ein unlesbares Strichgewirr (seit 17.11.2026 nicht mehr). Ohne Verlauf zeigt die Karte nur Fahrzeuge (an der näheren Station) und Stationen.
- Streckenverläufe (seit 17.11.2026, `wege/<AGS>.json`): Der freie Fahrplan von gtfs.de hat keine `shapes.txt` (Mobility Database, Feed nv_free ohne „Shapes“). Der Geo-Lauf (Teil `wege`, `scripts/geo/wege.mjs`, `lib/pulse-geo-wege.js`, monatlich) nimmt jede Verbindung Station → Station, die am Stichtag im Fahrplan vorkommt (Stationen wie die Live-Datei aus `oepnv/haltestellen.json.gz`), und legt den kürzesten Weg im OpenStreetMap-Netz ab: Bahnen auf Gleisen (`railway` rail, light_rail, subway, tram, narrow_gauge; ohne Abstell- und Rangiergleise, in Kacheln von 0,5° × 0,75°, die sich benachbarte Städte teilen), Busse auf Straßen mit Einbahnregeln (Busse frei bei `oneway:bus=no`, Busspuren dabei). Für Busse zählt die Straßenart (`costOf`, `ROAD_COST`): Länge × 1 auf Bundes-, Haupt- und Nebenstraßen, × 1,1 Kreisstraßen, × 1,25 sonstige, × 1,4 Wohnstraßen, × 2 Erschließungswege, × 2,5 verkehrsberuhigt, × 0,8 Busstraßen und für Busse ausgewiesene Wege, × 0,9 Straßen mit Busspur; so folgt der Weg der Hauptstraße statt einer kürzeren Abkürzung durchs Wohngebiet. Die Station hängt an allen Netzknoten bis 300 m (Gleis) bzw. 120 m (Straße), damit große Bahnhöfe das richtige Gleis finden. Ein Weg gilt nur bis 2,5 × Luftlinie + 3 km; vereinfacht auf 8 m (Gleis) bzw. 4 m (Straße). Für alle Städte ab 100 Sharing-Fahrzeugen (seit 19.11.2026, 99 Städte; vorher die 30 größten, Tübingen auf Platz 42 fehlte), Straßennetz Stadt + 6 km (bis 18.11.2026: 2 km; Linien wie die 92 nach Leonberg fehlten), Gleisnetz Stadt + 25 km und Verbindungen bis 130 km. Das Netz kommt seit 18.11.2026 aus den Landesextrakten von Geofabrik (`.osm.pbf` je Land, das ein Ausschnitt berührt; `scripts/geo/wege-osm.mjs`, Ausschneiden mit pyosmium in `scripts/geo/osm-extract.py`, Ausgabe im Format einer Overpass-Antwort): Der öffentliche Overpass-Server war am 18.11.2026 voll ausgelastet und lieferte in 3 Stunden für keine Stadt ein Netz. Antwortet Geofabrik nicht (19.11.2026: ECONNREFUSED), lädt der Lauf das Land von openstreetmap.fr. Overpass bleibt Rückfall, wenn das Ausschneiden scheitert, und Quelle der Tests (`GEO_OVERPASS`); scheitern dort die ersten zwei Städte, bricht der Teil ab, statt stundenlang zu warten. Liefert der Teil für keine Stadt einen Verlauf, endet der Workflow rot statt „ok“. Verbindungen unter 100 m liegen gerade im Datensatz. Lässt die Echtzeit Halte aus (Abschnitt Feuerbach → Zuffenhausen), setzt die Karte den Verlauf aus bekannten Abschnitten über höchstens 8 Stationen zusammen, wenn der Umweg höchstens 1,5 × Luftlinie + 300 m ist (`CHAIN` in `lib/pulse-oepnv-wege.js`; Stuttgart 18.11. 23:16: 79 % → 85 % der Abschnitte mit Verlauf). Die Statuszeile unter der Karte nennt den Anteil der Abschnitte im Streckenverlauf; der Rest wird nicht gezeichnet (Städte ohne Lauf, Verbindungen über ausgefallene Halte, neue Stationen seit dem Stichtag).
- Ausfälle (seit 17.11.2026, Format 1.5) getrennt von Verspätungen, eigene Farbe und eigene Form: ausgefallener Halt einer fahrenden Fahrt als × an der Station (`ausgefallene_halte` je Fahrt, zwischen erstem und letztem Punkt des Wegs), Fahrten mit ausgefallenen Halten mit Ring ums Schildchen, ganz ausgefallene Fahrten (`ausfall`) gestrichelt auf ihrem Weg, wenn der Strom eine Zeit im Fenster von 30 Minuten zurück bis 70 Minuten voraus nennt. Bei gtfs.de nennen die meisten abgesagten Fahrten nur Fahrt und Betriebstag; sie stehen gezählt je Linie unter der Karte. Stationen mit Störung: Ring in der Ausfall-Farbe, wenn mindestens 15 % der Halte ausgefallen sind, sonst in der Farbe „ab 5 Minuten verspätet“. Schalter „Ausfälle zeigen“.
- Sharing-Fahrzeuge lassen sich einblenden (`ops-input/fleet/<AGS>.json`).
- Geschäftsgebiet (seit 19.11.2026, `lib/pulse-oepnv-gebiet.js`, Feld `gebiet` in `oepnv/<AGS>.json`): Als Bedarf an Sharing-Fahrzeugen zählen nur Haltestellen im Gebiet der Anbieter: „Jetzt gestört“ (Haltestellen außerhalb stehen in der Liste, ohne Bedarfshinweis), Stationsvorschläge und Ziele an gestörten Stationen in der Disposition. Karte, Suche und übrige Listen zeigen alle Haltestellen der Gemeinde. Gemessen: Zellen (≈ 280 × 250 m), in denen in den letzten 7 Tagen ein verfügbares Fahrzeug stand (`cells/<Tag>/<Land>.json`, Feld `present`), plus eine Zelle Rand; einmal je Tag gelesen. Tübingen 19.11.: 192 von 224 Stationen innen, außen Kilchberg, Pfrondorf, Hirschau, Unterjesingen, Hagelloch, Weilheim, Bebenhausen. Unter 10 bedienten Zellen gilt kein Gebiet. Die Störungskorrektur der Prognose nutzt weiter die Lage der ganzen Gemeinde.
- Grenzen: echtes Tempo ist unbekannt (gleichmäßig zwischen zwei Stationen); der Streckenverlauf ist der günstigste Weg im Netz (Gleise nach Länge, Straßen nach Länge und Straßenart), nicht die gefahrene Route (Umleitungen, Schleifen und Wenden fehlen); ohne Verlauf springt das Fahrzeug von Station zu Station, die Linie dazu fehlt. Nach dem Ende der 70 Minuten ohne neuen Lauf sagt die Karte das und zeigt keine Fahrzeuge mehr.
- Verworfen: Fahrzeugpositionen von Transitous (nur für nicht-kommerzielle Open-Source-Projekte freigegeben).

## Jetzt gestört (`recentCounter`, `hotspots`, `hotspotHints`)

- Je Lauf: Stationen mit mindestens 8 Halten mit Echtzeit in den letzten 2 Stunden, von denen mindestens 30 % ausgefallen oder verspätet oder 15 % ausgefallen sind (`jetzt` in `oepnv/<AGS>.json`, seit Format 1.3, höchstens 40 je Gemeinde).
- Die Seite zählt die verfügbaren Sharing-Fahrzeuge im Umkreis von 300 m (`ops-input/fleet/<AGS>.json`) und sortiert: kein Fahrzeug, höchstens zwei, genug vor Ort. Auf der Karte ein Kreis je Station, kräftig, wenn kein Fahrzeug in der Nähe steht.
- Ein Hinweis für die Disposition, keine Prognose: wie stark Störungen die Nachfrage einer Stadt heben, steht unter Wirkung auf Sharing und ist nur in einzelnen Städten belegt.
- Darunter (seit 16.11.2026 abends) die Prognose bei dieser Störung: Störungskorrektur der Prognose für die Stadt, in Prozent und Fahrtbeginnen für die nächsten 3 Stunden, aus `forecast/dispo.json` `corrections`. Solange sie in der Probe ist, steht dabei, dass sie noch nicht eingerechnet ist, mit Lernzeit oder bewerteten Tagen; Freigabe wie in [Prognose](prognose.md).

## Linien (`lib/pulse-oepnv-linien.js`)

- Der Strom nennt je Fahrt nur `trip_id`. Die Linie kommt aus `trips.txt` des Fahrplans: bei jedem neuen Fahrplan baut der Sammler eine Tabelle Fahrt → Linie (zwei 32-Bit-Hashes je Fahrt, 12 Bytes je Fahrt) und legt sie im Zwischenspeicher ab (`TRACK_DIR/oepnv-fahrten.bin.gz`), nicht im Datenstand. Scheitert der Abruf, bleiben Fahrzeuge ohne Liniennamen bis zum nächsten Fahrplan.
- Zählung je Linie wie je Station (Schlüssel Gemeinde, Art, Linienname; 6-Stunden-Blöcke, 7 Tage Halbwertszeit), nur Halte im Stadtgebiet. Veröffentlicht werden je Gemeinde 80 Linien (`lines` in `oepnv/<AGS>.json`). Linien gleichen Namens verschiedener Betreiber fallen zusammen.
- Die Ansicht zeigt die 15 Linien mit dem höchsten Anteil ausgefallener und verspäteter Halte ab 40 Halten.

## Tagesgang und Nachtnetz-Lücke (`dayProfile`)

- Mittel je Ortsstunde über die vollen Tage im 8-Tage-Fenster: ÖPNV-Halte mit Echtzeit gegen Sharing-Fahrtbeginne (`forecast/series.json`).
- Lücke: ÖPNV unter 25 % seines Tageshöchstwerts und mindestens 3 Sharing-Fahrtbeginne in der Stunde. Die Ansicht nennt die Stunden und den Anteil der Sharing-Fahrten darin.
- Halte ohne Echtzeit fehlen; in Städten mit wenig Echtzeit wirkt der ÖPNV dünner, als er ist.

## Alarm „ÖPNV gestört“ (`lib/pulse-alarme.js`)

- Thema `oepnv` in den Alarmen und Feeds je Gemeinde: Die letzte volle Stunde wechselt auf stark gestört, das heißt mindestens 15 % der Halte ausgefallen oder 50 % verspätet (`PT_ALARM`; strenger als das Kennzeichen „gestört“, weil im Feierabendverkehr des 16.11. 13 Großstädte in einem Lauf bei 30 bis 44 % verspätet lagen). Nur Gemeinden ab 100 Fahrzeugen und 150 Halten mit Echtzeit in der Stunde (mit 20 Fahrzeugen ohne Halte-Grenze kamen am 16.11. in drei Stunden 42 Alarme, 34 aus Kleinstädten), höchstens ein Alarm je Gemeinde in 6 Stunden, der erste Lauf meldet nichts.
- Der Text nennt Stunde, Anteile und die verfügbaren Sharing-Fahrzeuge im Stadtgebiet; Push über ntfy wie bei den anderen Themen.

## Wirkung auf Sharing (`ptEffect`)

- Je Stunde zwischen 6 und 22 Uhr: Sharing-Fahrtbeginne ÷ Prognose des Vortags − 1. Je Gemeinde und Tag ein Wert: Mittel der gestörten Stunden minus Mittel der übrigen Stunden desselben Tages.
- 90-%-Intervall (Student-t) aus den Tageswerten, je Gemeinde ab 3 Tagen mit Störung, über alle Gemeinden ab 5 Stadt-Tagen. Urteil „mehr“ oder „weniger“ nur, wenn das Intervall die Null nicht enthält.
- Passives Lernen (`mergeDaily`, `learnEffects`, seit 16.11. abends): Die Tageswerte je Stadt bleiben im Zustand des Sammlers bis 60 Tage, über das 8-Tage-Fenster hinaus. Je Stadt: Mittel ihrer gestörten Tage, mit 5 Tagen zur Wirkung aller Städte gezogen (unter 5 Stadt-Tagen insgesamt zur Null). Spalte „gelernt“ in der Tabelle; die Prognose rechnet damit nur im Schatten ([Prognose](prognose.md)).
- Zusammenhang, keine Ursache: Wetter und Großereignisse bewegen beide Seiten. Die Prognose zeigt die Störungskorrektur an und rechnet sie erst ein, wenn sie im gezielten Abgleich gewinnt ([Prognose](prognose.md), Freigabe der Korrekturen).

## Letzte Meile (`farMask`, `lastMile` in `lib/pulse-geo-cover.js`)

- Fern vom ÖPNV heißt: weiter als 400 m Luftlinie von jeder Haltestelle mit mindestens 20 Abfahrten am Stichtag des Fahrplans (gebündelte Haltestellen aus dem Branch `geo`). Gezählt werden die Einwohner des Zensus 2022 im 100-m-Gitter.
- Für diese Einwohner zählt der Anteil der Läufe zwischen 7 und 22 Uhr, in denen ein verfügbares Sharing-Fahrzeug in 200 m stand (dieselben Zählfelder wie die Versorgung in [Umfeld](umfeld.md)). Einwohner „ohne beides“ = fern vom ÖPNV × (1 − dieser Anteil).
- Die Sammler-Phase `geo` schreibt den Wert des laufenden Tages mit jedem Stundenwechsel nach `versorgung/<AGS>.json` (`letzteMeile`, Familie `geo` 1.2), dazu die 40 Zellen (250 m) mit den meisten Einwohnern ohne beides.
- Grenzen: Luftlinie statt Fußweg; Anbieter ohne offenen Feed fehlen, dort steht mehr, als die Zahl zeigt; Rufbusse und Haltestellen unter 20 Abfahrten zählen nicht als Angebot.

## Vorschläge für Sharing-Stationen (`hubCandidates`)

- Kandidaten: Stationen ab 30 Halten je Tag ohne Abstellinsel eines Anbieters in 50 m (Inseln aus den Zonen-Feeds, `parkingIslands`).
- Punkte = 40 % ÖPNV-Halte (log), 30 % Störquote (ausgefallen + verspätet ÷ Halte), 30 % Sharing-Fahrtenden im Umkreis von 150 m (log, Monatszählung je 50-m-Zelle aus `abstell/<AGS>.json`), jeweils als z-Wert unter den Stationen der Gemeinde. Gezeigt werden die 20 besten, mit CSV.
- Der Vorschlag kennt weder Gehwegbreite noch Eigentum; er ersetzt keine Ortsbegehung. Flächen mit Geometrie plant der Abstellflächen-Planer in [Umfeld](umfeld.md).

## Tests

- `node test/oepnv.test.mjs` (Zählung, Stationsbündelung, Wege, Wirkung), Browser-Test `oepnv` gegen den synthetischen Stand aus `scripts/oepnv-fixture.mjs` (`test/fixtures/oepnv-synth`).
