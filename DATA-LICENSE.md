# Daten und Lizenzen

Stand: 2026-11-21T19:19:38.128Z · erzeugt vom Sammler (scripts/collect.mjs) bei jedem Lauf.

Dieser Datenzweig enthält aus offenen Quellen abgeleitete Daten: Bestände, Ereignisse (Fahrten, Umsetzungen, Akkutausch), Zellen, Archiv und Momentaufnahmen. Die Lizenzangaben stammen aus den Feeds (GBFS `system_information`: `license_id`, `license_url`, `attribution_organization_name`) bzw. aus den Verzeichnissen; maßgeblich sind die Bedingungen der jeweiligen Quelle. Je Quelle stehen sie auch in `latest.json` → `sources[]` (`licenseId`, `licenseUrl`, `attribution`, `attributionUrl`).

## Veröffentlichung von Ereignissen und Zellen

Ereignisse (`events/<Tag>.json`) erscheinen für den laufenden Tag erst nach Stundenende und enthalten nur abgeschlossene Stunden. Zellen (`cells/<Tag>/<Land>.json`) erscheinen erst nach dem Ende eines Tageszeit-Bands und enthalten nur abgeschlossene Bänder. Nach Tagesende folgen beide vollständig (`published.complete`). In Zellendateien ist jede Zelle × Band mit weniger als 3 Ereignissen (Fahrtbeginne + Fahrtenden) unterdrückt; diese Summen stehen je Gemeinde in `below`. Läge dort weniger als 3 (also womöglich eine einzelne Zelle), fällt zusätzlich die kleinste veröffentlichte Zelle des Bands in `below` (`suppress: 2`). Start-Ziel-Ströme (`flows/<Tag>.json`) erscheinen erst nach Tagesende und nur für Zellenpaare mit mindestens 5 Fahrten am Tag; Wochensummen (`flows-week/<Montag>.json`, 500-m-Zellen) erst nach Ende der Kalenderwoche, ebenfalls ab 5 Fahrten je Zeile; geschätzte Ströme (`flows-est/`) ab 2 erwarteten Fahrten aus mindestens 5 Fahrtbeginnen. Fahrzeugkennungen werden nicht veröffentlicht; sie bleiben privat (HMAC mit privatem Salt). Dieselben Ereignisse stehen je Land unter `events/<Tag>/<Land>.json`, als Tagessummen je Gruppe in `events/daily-summary.json` und als Stundensummen in `events/hour-totals.json`; die Zellen einer Gemeinde der letzten 7 Tage für die Disposition unter `ops-input/<AGS>.json` (gleiche Unterdrückung wie die Landesdateien).

## Live-Bestand und Momentaufnahmen

Veröffentlicht wird der jeweils letzte Bestand ohne Kennung: `ops/<Land>.json` (je sichtbarem Fahrzeug Position, Anbieter, Art, Ladestand, Reichweite, Standzeit-Klasse) und `snapshot/<Quelle>.json` (Bestand von Quellen, die der Browser nicht selbst lesen kann). Reichweite in ganzen km (Quellen mit eigener Reichweiten-Skala: 0,1 km). Die Standzeit erscheint nur als Klasse: unter 6 h, 6–24 h, danach ganze Tage (auch `idle-long.json`). Eine minutengenaue Standzeit zeigte, wann an einer Adresse die letzte Fahrt endete. Frühere Bestände bleiben nicht im Datenzweig (ein Commit je Lauf ohne Vorgänger).

## Grundlagen

- Gemeindegrenzen: © GeoBasis-DE / BKG 2026 (Gemeindegrenzen VG250-EW, Gebietsstand 31.12., vereinfacht ca. 30 m, quantisiert ca. 1 m) – Lizenz Datenlizenz Deutschland – Namensnennung – Version 2.0 (dl-de/by-2-0, https://www.govdata.de/dl-de/by-2-0).
- Umgebung (`context/`: ÖPNV-Haltepunkte, Abstellflächen): © OpenStreetMap-Mitwirkende, Open Database License 1.0 (ODbL, https://opendatacommons.org/licenses/odbl/1-0/).
- Streckenverläufe der ÖPNV-Karte (`wege/`, aufbereitet im Branch `geo`): kürzester Weg im Netz von OpenStreetMap je Verbindung des Fahrplans, © OpenStreetMap-Mitwirkende, Open Database License 1.0 (ODbL); Stationen aus dem Fahrplan von gtfs.de (CC BY 4.0).
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
- Umfeld (`versorgung/`, `unfall/`, `umweg/`, `pop/index.json`, `zubringer/index.json`, `abstell/`; Sprint 8, aufbereitet im Branch `geo`): Zensus 2022, Bevölkerung im 100-m-Gitter (© Statistisches Bundesamt, dl-de/by-2-0); Unfallatlas (© Statistische Ämter des Bundes und der Länder, dl-de/by-2-0); Fahrplan gtfs.de (CC BY 4.0); Fußwegenetz © OpenStreetMap-Mitwirkende (ODbL 1.0).
- Verzeichnisse: MobilityData GBFS systems.csv, MobiData BW, MOBIDROM NRW, CityBikes, Betreiber-Direktfeeds.

Kommerzielle Nutzung der Grundlagen: ja mit Namensnennung bei Gemeindegrenzen, Zensus, Unfallatlas, Baustellen (dl-de/by-2-0), DWD Open Data, Fahrplan gtfs.de (CC BY 4.0) und Wikidata (CC0); ja mit Weitergabe unter gleichen Bedingungen bei OpenStreetMap, OpenHolidays, OpenLigaDB (ODbL) und dem Echtzeit-Strom von gtfs.de (CC BY-SA 4.0); ungeklärt bei der Verkehrsinformation der Autobahn GmbH, der Nachrichtensuche der tagesschau-App (Streiks) und den Terminen aus Programmseiten und Quellenseiten.

## Quellen nach Lizenz

304 Quellen mit Daten in diesem Stand (Kopien anderer Quellen und nicht erreichbare Quellen ausgenommen).

| Lizenz | Kommerziell | Quellen | Namensnennung / Anbieter |
|---|---|---|---|
| CC0-1.0 (https://creativecommons.org/publicdomain/zero/1.0/) | ja (frei) | 89 | nextbike GmbH, Karl-Heine-Str. 46, 04229 Leipzig, Donkey, Donkey Republic, Feine Räder, esel.ac, nextbike by TIER - Karl-Heine-Str. 46 - D-04229 Leipzig, nextbike GmbH, Lievelingsweg 104 A (Im Hinterhof), 53119 Bonn, VAG Verkehrs-Aktiengesellschaft, Südliche Fürther Straße 5, 90429 Nürnberg, nextbike GmbH, MVGmeinRad GmbH, Mozartstraße 8, 55118 Mainz, UsedomRad GmbH, Hauptstraße 8, 17459 Ückeritz |
| ohne Angabe | ja (Namensnennung, Lizenz des Datensatzes bei MobiData BW (dl-de/by-2-0)) | 60 | ALF - das Affstätter Lastenfahrrad, Bolt Technology OÜ, Ökostadt Renningen e.V., confitech Dienstleistungs GmbH, Deutsche Bahn Connect GmbH, deer, Autohaus Schmid Waldkirch GmbH, Donkey Republic, Dott, überall GmbH, FaRe - das Bananologen Lastenrad, Ford-Händler Dienstleistungsgesellschaft mbH, Gülf - das Gültsteiner Lastenrad, Autohaus Hertlein GmbH, Energieagentur Rems-Murr gGmbH, Lastenrad-Initiative für die Region Karlsruhe, LastenVelo Freiburg, mikar GmbH, naturenergie sharing GmbH, nextbike GmbH, Karl-Heine-Str. 46, 04229 Leipzig, nextbike by TIER - Karl-Heine-Str. 46 - D-04229 Leipzig, OberSchwabenMobil e.V., Stadtwerke Radolfzell GmbH, Stadtmobil CarSharing GmbH & Co. KG, Stadtmobil Rhein-Neckar AG u. a. (38) |
| ohne Angabe | ungeklärt (ohne Angabe) | 43 | AB mit Lara, Deutsche Bahn AG, Donkey, Dott, Getaround, LastenVelo Freiburg e.V., Nextbike GmbH, VCD Carsharing Aschaffenburg, Yoio, Zeus |
| CC-BY-SA-4.0 (https://creativecommons.org/licenses/by-sa/4.0/) | ja (Namensnennung, gleiche Bedingungen) | 42 | Voi Technology Germany GmbH, Bolt Technology OÜ, Lime |
| CC-BY-4.0 (https://bolt.eu/en/legal/security-gbfs-license/?category=micromobility) | ja (Namensnennung) | 23 | Bolt Technology OÜ, sigo |
| dl-de/by-2-0 (https://www.govdata.de/dl-de/by-2-0) | ja (Namensnennung) | 19 | cambio Mobilitätsservice GmbH & Co. KG, Stadtteilauto CarSharing Münster GmbH, Car-ship e.G. i.Gr., Lime |
| ohne Angabe | nein (Dott-Direktfeed ohne Lizenzangabe: Dott stellt die Daten nur unter einem API-Lizenzvertrag bereit) | 19 | Dott |
| https://www.li.me/gbfs-terms | nein (Lime Public GBFS Terms: Nutzung nur für interne, nicht kommerzielle Zwecke) | 5 | Lime |
| https://hopp.bike/privacy-policy/ | ungeklärt (Link auf Datenschutzerklärung) | 1 | Hopp Konstanz |
| dl-de/zero-2-0 (https://www.govdata.de/dl-de/zero-2-0) | ja (frei) | 1 | nextbike GmbH, Karl-Heine-Str. 46, 04229 Leipzig |
| https://www.stella-sharing.de/agb/ | ungeklärt (Lizenz-Link führt zu den Kunden-AGB, keine Datenlizenz; Anfrage bei stella nötig) | 1 | stella |
| ODbL-1.0 (https://spdx.org/licenses/ODbL-1.0.html) | ja (Namensnennung, gleiche Bedingungen) | 1 | SWA |

## Kommerzielle Nutzung je Anbieter

Je Quelle eingestuft nach der Lizenz im Feed: ja (offene Lizenz, mit Namensnennung bzw. Weitergabe unter gleichen Bedingungen), nein (nicht kommerziell), ungeklärt (ohne Angabe, eigene Bedingungen des Betreibers oder Link auf eine Datenschutzerklärung). Keine Rechtsberatung; vor einem bezahlten Auftrag gelten die Bedingungen der jeweiligen Quelle. Ein Anbieter gilt als „ja“, wenn alle seine Quellen „ja“ sind, als „teils“, wenn sie gemischt sind. Spiegel einer anderen Quelle (Fahrzeuge verworfen) zählen hier nicht. Gelesene Bedingungen: Lime (Public GBFS Terms: nur interne, nicht kommerzielle Nutzung, https://www.li.me/legal/public-gbfs-terms), Dott-Direktfeeds (nur mit API-Lizenzvertrag, https://ridedott.com/api-license); Feeds über MobiData BW ohne eigene Angabe: Lizenz des Datensatzes im Portal (dl-de/by-2-0).

| Anbieter | Quellen | ja | nein | ungeklärt | Einstufung |
|---|---|---|---|---|---|
| nextbike | 86 | 80 | 0 | 6 | teils |
| Voi | 35 | 35 | 0 | 0 | ja |
| Donkey | 21 | 16 | 0 | 5 | teils |
| Dott | 20 | 4 | 15 | 1 | nein |
| Zeus | 18 | 7 | 0 | 11 | teils |
| Bolt | 15 | 15 | 0 | 0 | ja |
| sigo | 15 | 15 | 0 | 0 | ja |
| cambio | 14 | 14 | 0 | 0 | ja |
| Lime | 11 | 6 | 5 | 0 | nein |
| Getaround | 7 | 0 | 0 | 7 | ungeklärt |
| DB Connect | 6 | 1 | 0 | 5 | teils |
| stadtmobil | 3 | 3 | 0 | 0 | ja |
| StadtRAD | 3 | 1 | 0 | 2 | teils |
| teilAuto | 3 | 3 | 0 | 0 | ja |
| Yoio | 3 | 1 | 0 | 2 | teils |
| Ford Carsharing | 2 | 2 | 0 | 0 | ja |
| LastenVelo Freiburg | 2 | 1 | 0 | 1 | teils |
| RegioRad Stuttgart | 2 | 1 | 0 | 1 | teils |
| AB mit Lara | 1 | 0 | 0 | 1 | ungeklärt |
| ALF - das Affstätter Lastenfahrrad | 1 | 1 | 0 | 0 | ja |
| Car-Ship | 1 | 1 | 0 | 0 | ja |
| CarSharing Renningen | 1 | 1 | 0 | 0 | ja |
| Conficars | 1 | 1 | 0 | 0 | ja |
| deer | 1 | 1 | 0 | 0 | ja |
| Die Grüne Flotte | 1 | 1 | 0 | 0 | ja |
| Einfach Unterwegs | 1 | 1 | 0 | 0 | ja |
| esel.ac | 1 | 1 | 0 | 0 | ja |
| FaRe - das Bananologen Lastenrad | 1 | 1 | 0 | 0 | ja |
| Flinkster | 1 | 1 | 0 | 0 | ja |
| Gülf - das Gültsteiner Lastenrad | 1 | 1 | 0 | 0 | ja |
| HERTLEIN | 1 | 1 | 0 | 0 | ja |
| Hopp Konstanz | 1 | 0 | 0 | 1 | ungeklärt |
| LaRa to go | 1 | 1 | 0 | 0 | ja |
| Lastenkarle Karlsruhe | 1 | 1 | 0 | 0 | ja |
| MIKAR | 1 | 1 | 0 | 0 | ja |
| naturenergie sharing | 1 | 1 | 0 | 0 | ja |
| OberSchwabenMobil | 1 | 1 | 0 | 0 | ja |
| SEEFAHRER | 1 | 1 | 0 | 0 | ja |
| Stadtwerk Tauberfranken | 1 | 1 | 0 | 0 | ja |
| Stadtwerke Wertheim | 1 | 1 | 0 | 0 | ja |
| stella | 1 | 0 | 0 | 1 | ungeklärt |
| swabi - augsburg | 1 | 1 | 0 | 0 | ja |
| swu2go | 1 | 1 | 0 | 0 | ja |
| Szabo Mobility | 1 | 1 | 0 | 0 | ja |
| VCD | 1 | 0 | 0 | 1 | ungeklärt |
| zeo | 1 | 1 | 0 | 0 | ja |

## Weitergabe unter gleichen Bedingungen

42 Quellen stehen unter CC BY-SA (Voi, Bolt, Lime). Daten, die aus diesen Quellen abgeleitet sind (Bestände, Ereignisse, Zellen, Archiv der betroffenen Gebiete und Anbieter), stehen unter CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/).
Aus OpenStreetMap abgeleitete Datenbankteile (`context/`, `wege/`) stehen unter der ODbL 1.0.

Quellen ohne Lizenzangabe sind oben als „ohne Angabe“ geführt (122: AB mit Lara, ALF - das Affstätter Lastenfahrrad, Bolt, CarSharing Renningen, Conficars, DB Connect, deer, Die Grüne Flotte, Donkey, Dott, Einfach Unterwegs, FaRe - das Bananologen Lastenrad, Flinkster, Ford Carsharing, Getaround, Gülf - das Gültsteiner Lastenrad, HERTLEIN, LaRa to go, Lastenkarle Karlsruhe, LastenVelo Freiburg, MIKAR, naturenergie sharing, nextbike, OberSchwabenMobil, RegioRad Stuttgart, SEEFAHRER, stadtmobil, StadtRAD, Stadtwerk Tauberfranken, Stadtwerke Wertheim, swu2go, Szabo Mobility, teilAuto, VCD, Voi, Yoio, zeo, Zeus). Ihre Lizenz ist ungeklärt; sie gelten hier nicht als gemeinfrei (CC0). Maßgeblich sind die Nutzungsbedingungen des jeweiligen Betreibers bzw. Verzeichnisses.
Bei 1 Quelle (Hopp Konstanz) führt der Lizenz-Link zu einer Datenschutzerklärung, nicht zu einer Lizenz: Lizenz ebenfalls ungeklärt.
