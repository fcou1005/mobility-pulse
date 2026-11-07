# Daten und Lizenzen

Stand: 2026-11-07T13:32:25.198Z · erzeugt vom Sammler (scripts/collect.mjs) bei jedem Lauf.

Dieser Datenzweig enthält aus offenen Quellen abgeleitete Daten: Bestände, Ereignisse (Fahrten, Umsetzungen, Akkutausch), Zellen, Archiv und Momentaufnahmen. Die Lizenzangaben stammen aus den Feeds (GBFS `system_information`: `license_id`, `license_url`, `attribution_organization_name`) bzw. aus den Verzeichnissen; maßgeblich sind die Bedingungen der jeweiligen Quelle. Je Quelle stehen sie auch in `latest.json` → `sources[]` (`licenseId`, `licenseUrl`, `attribution`, `attributionUrl`).

## Veröffentlichung von Ereignissen und Zellen

Ereignisse (`events/<Tag>.json`) erscheinen für den laufenden Tag erst nach Stundenende und enthalten nur abgeschlossene Stunden. Zellen (`cells/<Tag>/<Land>.json`) erscheinen erst nach dem Ende eines Tageszeit-Bands und enthalten nur abgeschlossene Bänder. Nach Tagesende folgen beide vollständig (`published.complete`). In Zellendateien ist jede Zelle × Band mit weniger als 3 Ereignissen (Fahrtbeginne + Fahrtenden) unterdrückt; diese Summen stehen je Gemeinde in `below`. Läge dort weniger als 3 (also womöglich eine einzelne Zelle), fällt zusätzlich die kleinste veröffentlichte Zelle des Bands in `below` (`suppress: 2`). Start-Ziel-Ströme (`flows/<Tag>.json`) erscheinen erst nach Tagesende und nur für Zellenpaare mit mindestens 5 Fahrten am Tag; geschätzte Ströme (`flows-est/`) ab 2 erwarteten Fahrten. Fahrzeugkennungen werden nicht veröffentlicht; sie bleiben privat (HMAC mit privatem Salt).

## Live-Bestand und Momentaufnahmen

Veröffentlicht wird der jeweils letzte Bestand ohne Kennung: `ops/<Land>.json` (je sichtbarem Fahrzeug Position, Anbieter, Art, Ladestand, Reichweite, Standzeit-Klasse) und `snapshot/<Quelle>.json` (Bestand von Quellen, die der Browser nicht selbst lesen kann). Reichweite in ganzen km (Quellen mit eigener Reichweiten-Skala: 0,1 km). Die Standzeit erscheint nur als Klasse: unter 6 h, 6–24 h, danach ganze Tage (auch `idle-long.json`). Eine minutengenaue Standzeit zeigte, wann an einer Adresse die letzte Fahrt endete. Frühere Bestände bleiben nicht im Datenzweig (ein Commit je Lauf ohne Vorgänger).

## Grundlagen

- Gemeindegrenzen: © GeoBasis-DE / BKG 2026 (Gemeindegrenzen VG250-EW, Gebietsstand 31.12., vereinfacht ca. 30 m, quantisiert ca. 1 m) – Lizenz Datenlizenz Deutschland – Namensnennung – Version 2.0 (dl-de/by-2-0, https://www.govdata.de/dl-de/by-2-0).
- Umgebung (`context/`: ÖPNV-Haltepunkte, Abstellflächen): © OpenStreetMap-Mitwirkende, Open Database License 1.0 (ODbL, https://opendatacommons.org/licenses/odbl/1-0/).
- Wetter-Cache (`weather/<Tag>.json`): Beobachtungen und Vorhersage (MOSMIX) des Deutschen Wetterdienstes (DWD Open Data), abgerufen über Bright Sky (https://brightsky.dev). Quelle: Deutscher Wetterdienst; Nutzungsbedingungen des DWD gelten (Quellenvermerk-Wortlaut noch nicht amtlich geprüft).
- Umgebungsereignisse (`incidents/<Tag>.json`, nur Kennzeichen je Gemeinde und Stunde, keine Meldungstexte): Wetterwarnungen des Deutschen Wetterdienstes (DWD Open Data, über Bright Sky); Sperrungen und Staus auf Autobahnen aus der Verkehrsinformation der Autobahn GmbH des Bundes (verkehr.autobahn.de; ausdrückliche Nutzungsbedingungen der Schnittstelle nicht gefunden, Quelle: Die Autobahn GmbH des Bundes). Streiks und Veranstaltungen aus der gepflegten Liste `data/ereignisse.json` im Code-Zweig (je Eintrag mit Quelle).
- Veranstaltungsorte und Termine (`veranstaltungen.json`): Orte mit Kapazität aus Wikidata (CC0 1.0); Termine (Name, Beginn, Ort, Link) aus den öffentlichen Programmseiten und Kalendern der Orte (Quelle je Termin verlinkt; `data/veranstaltungskalender.json`), höchstens 60 Tage behalten.
- Sport-Ereignisse (`sport.json`: Heimspiele 1.–3. Liga mit Anstoßzeit, daraus Veranstaltungen je Stadion-Gemeinde): Spielpläne aus OpenLigaDB (https://www.openligadb.de), Open Database License 1.0 (ODbL); `sport.json` steht unter der ODbL 1.0.
- Prognose (`forecast/latest.json`, `forecast/log.json`, `forecast/series.json`): abgeleitet aus den Ereignissen dieses Datenstands, dem Tagtyp-Kalender, dem Wetter-Cache und den Umgebungsereignissen; statistisches Modell des Projekts, keine Betreiberdaten.
- Tagtyp-Kalender (`calendar.json`: gesetzliche Feiertage und Schulferien je Land): OpenHolidays API (https://www.openholidaysapi.org), Open Database License 1.0 (ODbL); `calendar.json` steht unter der ODbL 1.0.
- Verzeichnisse: MobilityData GBFS systems.csv, MobiData BW, MOBIDROM NRW, CityBikes, Betreiber-Direktfeeds.

## Quellen nach Lizenz

255 Quellen mit Daten in diesem Stand (Kopien anderer Quellen und nicht erreichbare Quellen ausgenommen).

| Lizenz | Quellen | Namensnennung / Anbieter |
|---|---|---|
| CC0-1.0 (https://creativecommons.org/publicdomain/zero/1.0/) | 90 | nextbike GmbH, Karl-Heine-Str. 46, 04229 Leipzig, Donkey, Donkey Republic, nextbike by TIER - Karl-Heine-Str. 46 - D-04229 Leipzig, Feine Räder, esel.ac, nextbike GmbH, Lievelingsweg 104 A (Im Hinterhof), 53119 Bonn, VAG Verkehrs-Aktiengesellschaft, Südliche Fürther Straße 5, 90429 Nürnberg, nextbike GmbH, MVGmeinRad GmbH, Mozartstraße 8, 55118 Mainz, UsedomRad GmbH, Hauptstraße 8, 17459 Ückeritz |
| ohne Angabe | 88 | AB mit Lara, ALF - das Affstätter Lastenfahrrad, Bolt Technology OÜ, Deutsche Bahn Connect GmbH, Deutsche Bahn AG, Donkey, Donkey Republic, Dott, FaRe - das Bananologen Lastenrad, Gülf - das Gültsteiner Lastenrad, Energieagentur Rems-Murr gGmbH, Lastenrad-Initiative für die Region Karlsruhe, LastenVelo Freiburg e.V., LastenVelo Freiburg, Nextbike GmbH, nextbike GmbH, Karl-Heine-Str. 46, 04229 Leipzig, nextbike by TIER - Karl-Heine-Str. 46 - D-04229 Leipzig, stadtRad - das stadtnavi Lastenrad, VOI, Yoio, Zeo, Zeus |
| CC-BY-SA-4.0 (https://creativecommons.org/licenses/by-sa/4.0/) | 42 | Voi Technology Germany GmbH, Bolt Technology OÜ, Lime |
| CC-BY-4.0 (https://bolt.eu/en/legal/security-gbfs-license/?category=micromobility) | 23 | Bolt Technology OÜ, sigo |
| https://www.li.me/gbfs-terms | 5 | Lime |
| dl-de/by-2-0 (https://www.li.me/gbfs-terms) | 4 | Lime |
| https://hopp.bike/privacy-policy/ | 1 | Hopp Konstanz |
| dl-de/zero-2-0 (https://www.govdata.de/dl-de/zero-2-0) | 1 | nextbike GmbH, Karl-Heine-Str. 46, 04229 Leipzig |
| ODbL-1.0 (https://spdx.org/licenses/ODbL-1.0.html) | 1 | SWA |

## Weitergabe unter gleichen Bedingungen

42 Quellen stehen unter CC BY-SA (Voi, Bolt, Lime). Daten, die aus diesen Quellen abgeleitet sind (Bestände, Ereignisse, Zellen, Archiv der betroffenen Gebiete und Anbieter), stehen unter CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/).
Aus OpenStreetMap abgeleitete Datenbankteile (`context/`) stehen unter der ODbL 1.0.

Quellen ohne Lizenzangabe sind oben als „ohne Angabe“ geführt (88: AB mit Lara, ALF - das Affstätter Lastenfahrrad, Bolt, DB Connect, Donkey, Dott, FaRe - das Bananologen Lastenrad, Gülf - das Gültsteiner Lastenrad, LaRa to go, Lastenkarle Karlsruhe, LastenVelo Freiburg, nextbike, RegioRad Stuttgart, StadtRAD, Voi, Yoio, zeo, Zeus). Ihre Lizenz ist ungeklärt; sie gelten hier nicht als gemeinfrei (CC0). Maßgeblich sind die Nutzungsbedingungen des jeweiligen Betreibers bzw. Verzeichnisses.
Bei 1 Quelle (Hopp Konstanz) führt der Lizenz-Link zu einer Datenschutzerklärung, nicht zu einer Lizenz: Lizenz ebenfalls ungeklärt.
