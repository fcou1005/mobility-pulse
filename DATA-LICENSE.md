# Daten und Lizenzen

Stand: 2026-11-14T13:15:08.872Z · erzeugt vom Sammler (scripts/collect.mjs) bei jedem Lauf.

Dieser Datenzweig enthält aus offenen Quellen abgeleitete Daten: Bestände, Ereignisse (Fahrten, Umsetzungen, Akkutausch), Zellen, Archiv und Momentaufnahmen. Die Lizenzangaben stammen aus den Feeds (GBFS `system_information`: `license_id`, `license_url`, `attribution_organization_name`) bzw. aus den Verzeichnissen; maßgeblich sind die Bedingungen der jeweiligen Quelle. Je Quelle stehen sie auch in `latest.json` → `sources[]` (`licenseId`, `licenseUrl`, `attribution`, `attributionUrl`).

## Veröffentlichung von Ereignissen und Zellen

Ereignisse (`events/<Tag>.json`) erscheinen für den laufenden Tag erst nach Stundenende und enthalten nur abgeschlossene Stunden. Zellen (`cells/<Tag>/<Land>.json`) erscheinen erst nach dem Ende eines Tageszeit-Bands und enthalten nur abgeschlossene Bänder. Nach Tagesende folgen beide vollständig (`published.complete`). In Zellendateien ist jede Zelle × Band mit weniger als 3 Ereignissen (Fahrtbeginne + Fahrtenden) unterdrückt; diese Summen stehen je Gemeinde in `below`. Läge dort weniger als 3 (also womöglich eine einzelne Zelle), fällt zusätzlich die kleinste veröffentlichte Zelle des Bands in `below` (`suppress: 2`). Start-Ziel-Ströme (`flows/<Tag>.json`) erscheinen erst nach Tagesende und nur für Zellenpaare mit mindestens 5 Fahrten am Tag; Wochensummen (`flows-week/<Montag>.json`, 500-m-Zellen) erst nach Ende der Kalenderwoche, ebenfalls ab 5 Fahrten je Zeile; geschätzte Ströme (`flows-est/`) ab 2 erwarteten Fahrten aus mindestens 5 Fahrtbeginnen. Fahrzeugkennungen werden nicht veröffentlicht; sie bleiben privat (HMAC mit privatem Salt). Dieselben Ereignisse stehen je Land unter `events/<Tag>/<Land>.json`, als Tagessummen je Gruppe in `events/daily-summary.json` und als Stundensummen in `events/hour-totals.json`; die Zellen einer Gemeinde der letzten 7 Tage für die Disposition unter `ops-input/<AGS>.json` (gleiche Unterdrückung wie die Landesdateien).

## Live-Bestand und Momentaufnahmen

Veröffentlicht wird der jeweils letzte Bestand ohne Kennung: `ops/<Land>.json` (je sichtbarem Fahrzeug Position, Anbieter, Art, Ladestand, Reichweite, Standzeit-Klasse) und `snapshot/<Quelle>.json` (Bestand von Quellen, die der Browser nicht selbst lesen kann). Reichweite in ganzen km (Quellen mit eigener Reichweiten-Skala: 0,1 km). Die Standzeit erscheint nur als Klasse: unter 6 h, 6–24 h, danach ganze Tage (auch `idle-long.json`). Eine minutengenaue Standzeit zeigte, wann an einer Adresse die letzte Fahrt endete. Frühere Bestände bleiben nicht im Datenzweig (ein Commit je Lauf ohne Vorgänger).

## Grundlagen

- Gemeindegrenzen: © GeoBasis-DE / BKG 2026 (Gemeindegrenzen VG250-EW, Gebietsstand 31.12., vereinfacht ca. 30 m, quantisiert ca. 1 m) – Lizenz Datenlizenz Deutschland – Namensnennung – Version 2.0 (dl-de/by-2-0, https://www.govdata.de/dl-de/by-2-0).
- Umgebung (`context/`: ÖPNV-Haltepunkte, Abstellflächen): © OpenStreetMap-Mitwirkende, Open Database License 1.0 (ODbL, https://opendatacommons.org/licenses/odbl/1-0/).
- Wetter-Cache (`weather/<Tag>.json`): Beobachtungen und Vorhersage (MOSMIX) des Deutschen Wetterdienstes (DWD Open Data), abgerufen über Bright Sky (https://brightsky.dev). Quelle: Deutscher Wetterdienst; Nutzungsbedingungen des DWD gelten (Quellenvermerk-Wortlaut noch nicht amtlich geprüft).
- Umgebungsereignisse (`incidents/<Tag>.json`, nur Kennzeichen je Gemeinde und Stunde, keine Meldungstexte): Wetterwarnungen des Deutschen Wetterdienstes (DWD Open Data, über Bright Sky); Sperrungen und Staus auf Autobahnen aus der Verkehrsinformation der Autobahn GmbH des Bundes (verkehr.autobahn.de; ausdrückliche Nutzungsbedingungen der Schnittstelle nicht gefunden, Quelle: Die Autobahn GmbH des Bundes). Streiks und Veranstaltungen aus der gepflegten Liste `data/ereignisse.json` im Code-Zweig (je Eintrag mit Quelle).
- Termine aus den Quellenseiten (Branch `termine`, `termine.json`; in `ereignisse.json` mit `auto: true`): offizielle Seiten von Volksfesten, Messen, Stadien und Festen aus `data/termin-quellen.json`, wöchentlich im Workflow „Termine“ gelesen (Regeln, sonst ein kleines lokales Sprachmodell); je Termin der Link zur Quelle.
- Streiks im Nahverkehr und bei der Bahn (`streiks.json`): im Sammler automatisch erkannt aus der Nachrichtensuche der tagesschau-App (www.tagesschau.de/api2u, mit den Regionalmeldungen der ARD-Anstalten); gespeichert sind nur abgeleitete Angaben (Art, Tage, Gebiet, erkannte Orte und Betriebe) und der Link zur jeweiligen Meldung, keine Meldungstexte. Nutzung: Die Schnittstelle ist vom Anbieter nicht öffentlich dokumentiert, die Inhalte sind laut Beschreibung für den privaten Gebrauch; eine kommerzielle Nutzung ist ungeklärt (vor bezahlten Aufträgen klären oder mit leerem `STRIKE_URL` abschalten).
- Veranstaltungsorte und Termine (`veranstaltungen.json`): Orte mit Kapazität aus Wikidata (CC0 1.0); Termine (Name, Beginn, Ort, Link) aus den öffentlichen Programmseiten und Kalendern der Orte (Quelle je Termin verlinkt; `data/veranstaltungskalender.json`), höchstens 60 Tage behalten.
- Sport-Ereignisse (`sport.json`: Heimspiele 1.–3. Liga mit Anstoßzeit, daraus Veranstaltungen je Stadion-Gemeinde): Spielpläne aus OpenLigaDB (https://www.openligadb.de), Open Database License 1.0 (ODbL); `sport.json` steht unter der ODbL 1.0.
- Prognose (`forecast/latest.json`, `forecast/log.json`, `forecast/series.json`; E-Roller und Carsharing je mit eigenem Modell in `forecast/moped/` und `forecast/car/`): abgeleitet aus den Ereignissen dieses Datenstands, dem Tagtyp-Kalender, dem Wetter-Cache und den Umgebungsereignissen; statistisches Modell des Projekts, keine Betreiberdaten.
- Baustellen in Städten (`incidents/<Tag>.json` → `works`, nur Zahl frischer Vollsperrungen je Gemeinde und Stunde): MobiData BW (Baustellen BEMaS), Freie und Hansestadt Hamburg (Behörde für Verkehr und Mobilitätswende), Landeshauptstadt München; jeweils Datenlizenz Deutschland – Namensnennung – Version 2.0 (dl-de/by-2.0).
- ÖPNV-Störungen (`incidents/<Tag>.json` → `ptN`, `ptSkip`, `ptLate`, `pt`: Halte mit Echtzeit, ausgefallene und verspätete Halte je Gemeinde und Stunde; `oepnv/haltestellen.json.gz`: Haltestelle → Gemeinde): abgeleitet aus dem GTFS-Realtime-Strom von gtfs.de (Creative Commons BY-SA 4.0, https://gtfs.de/de/realtime/, Datengeber dort aufgeführt) und dem freien deutschlandweiten GTFS-Feed von gtfs.de (Creative Commons BY 4.0). Die abgeleiteten ÖPNV-Felder stehen deshalb unter CC BY-SA 4.0.
- Trainingsarchiv (`train/<Jahr>/<Tag>.json.gz`, `train-cells/<Jahr>/<Jahr>-W<KW>.json.gz`, `weather-fc/<Tag>.json`): dauerhafte Ablage der oben genannten Tagesdaten (Stundenwerte je Gemeinde, Anbieter und Fahrzeugart; Wochensummen der veröffentlichten Zellen; Wetter samt der ausgegebenen Vorhersage), abgeleitet aus denselben Quellen und unter denselben Bedingungen weiterzugeben (Namensnennung; bei CC-BY-SA-Quellen Weitergabe unter gleichen Bedingungen; Kalender ODbL). Keine Fahrzeugkennungen, keine Fahrzeugkoordinaten; Gruppen mit 1–2 Fahrtbeginnen am Tag nur als Tagessumme.
- Tagtyp-Kalender (`calendar.json`: gesetzliche Feiertage und Schulferien je Land): OpenHolidays API (https://www.openholidaysapi.org), Open Database License 1.0 (ODbL); `calendar.json` steht unter der ODbL 1.0.
- Verzeichnisse: MobilityData GBFS systems.csv, MobiData BW, MOBIDROM NRW, CityBikes, Betreiber-Direktfeeds.

## Quellen nach Lizenz

298 Quellen mit Daten in diesem Stand (Kopien anderer Quellen und nicht erreichbare Quellen ausgenommen).

| Lizenz | Quellen | Namensnennung / Anbieter |
|---|---|---|
| ohne Angabe | 119 | AB mit Lara, ALF - das Affstätter Lastenfahrrad, Bolt Technology OÜ, Ökostadt Renningen e.V., confitech Dienstleistungs GmbH, Deutsche Bahn Connect GmbH, Deutsche Bahn AG, deer, Autohaus Schmid Waldkirch GmbH, Donkey, Donkey Republic, Dott, überall GmbH, FaRe - das Bananologen Lastenrad, Ford-Händler Dienstleistungsgesellschaft mbH, Getaround, Gülf - das Gültsteiner Lastenrad, Autohaus Hertlein GmbH, Energieagentur Rems-Murr gGmbH, Lastenrad-Initiative für die Region Karlsruhe, LastenVelo Freiburg e.V., LastenVelo Freiburg, mikar GmbH, naturenergie sharing GmbH, Nextbike GmbH u. a. (45) |
| CC0-1.0 (https://creativecommons.org/publicdomain/zero/1.0/) | 86 | nextbike GmbH, Karl-Heine-Str. 46, 04229 Leipzig, Donkey, Donkey Republic, Feine Räder, esel.ac, nextbike by TIER - Karl-Heine-Str. 46 - D-04229 Leipzig, nextbike GmbH, Lievelingsweg 104 A (Im Hinterhof), 53119 Bonn, VAG Verkehrs-Aktiengesellschaft, Südliche Fürther Straße 5, 90429 Nürnberg, nextbike GmbH, MVGmeinRad GmbH, Mozartstraße 8, 55118 Mainz, UsedomRad GmbH, Hauptstraße 8, 17459 Ückeritz |
| CC-BY-SA-4.0 (https://creativecommons.org/licenses/by-sa/4.0/) | 42 | Voi Technology Germany GmbH, Bolt Technology OÜ, Lime |
| CC-BY-4.0 (https://bolt.eu/en/legal/security-gbfs-license/?category=micromobility) | 23 | Bolt Technology OÜ, sigo |
| dl-de/by-2-0 (https://www.govdata.de/dl-de/by-2-0) | 19 | cambio Mobilitätsservice GmbH & Co. KG, Stadtteilauto CarSharing Münster GmbH, Car-ship e.G. i.Gr., Lime |
| https://www.li.me/gbfs-terms | 5 | Lime |
| https://hopp.bike/privacy-policy/ | 1 | Hopp Konstanz |
| dl-de/zero-2-0 (https://www.govdata.de/dl-de/zero-2-0) | 1 | nextbike GmbH, Karl-Heine-Str. 46, 04229 Leipzig |
| https://www.stella-sharing.de/agb/ | 1 | stella |
| ODbL-1.0 (https://spdx.org/licenses/ODbL-1.0.html) | 1 | SWA |

## Weitergabe unter gleichen Bedingungen

42 Quellen stehen unter CC BY-SA (Voi, Bolt, Lime). Daten, die aus diesen Quellen abgeleitet sind (Bestände, Ereignisse, Zellen, Archiv der betroffenen Gebiete und Anbieter), stehen unter CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/).
Aus OpenStreetMap abgeleitete Datenbankteile (`context/`) stehen unter der ODbL 1.0.

Quellen ohne Lizenzangabe sind oben als „ohne Angabe“ geführt (119: AB mit Lara, ALF - das Affstätter Lastenfahrrad, Bolt, CarSharing Renningen, Conficars, DB Connect, deer, Die Grüne Flotte, Donkey, Dott, Einfach Unterwegs, FaRe - das Bananologen Lastenrad, Flinkster, Ford Carsharing, Getaround, Gülf - das Gültsteiner Lastenrad, HERTLEIN, LaRa to go, Lastenkarle Karlsruhe, LastenVelo Freiburg, MIKAR, naturenergie sharing, nextbike, OberSchwabenMobil, RegioRad Stuttgart, SEEFAHRER, stadtmobil, StadtRAD, Stadtwerk Tauberfranken, Stadtwerke Wertheim, swu2go, Szabo Mobility, teilAuto, VCD, Voi, Yoio, zeo, Zeus). Ihre Lizenz ist ungeklärt; sie gelten hier nicht als gemeinfrei (CC0). Maßgeblich sind die Nutzungsbedingungen des jeweiligen Betreibers bzw. Verzeichnisses.
Bei 1 Quelle (Hopp Konstanz) führt der Lizenz-Link zu einer Datenschutzerklärung, nicht zu einer Lizenz: Lizenz ebenfalls ungeklärt.
