# Quellen

## Verzeichnisse und Feeds

| Verzeichnis | Inhalt | Zugang |
|---|---|---|
| [MobilityData systems.csv](https://github.com/MobilityData/gbfs/blob/master/systems.csv) | alle DE-Systeme des GBFS-Katalogs | offen |
| [MobiData BW](https://api.mobidata-bw.de/sharing/gbfs) | Landesfeeds Baden-Württemberg (bevorzugt) | offen |
| [MOBIDROM NRW](https://www.mobilitaetsdaten.nrw/api/ckan/organization/angemeldet) | Landesfeeds NRW (konflationiert) | OAuth-Dienstzugang laut Datensatzbeschreibung, wird zur Laufzeit gelesen |
| [CityBikes](https://api.citybik.es/v2/networks) | Ergänzung (Stationszähler) | offen; Abrufe nacheinander im Abstand von 1,2 s (`CB_GAP_MS`), bei HTTP 429/Fehler gilt der letzte gute Abruf bis 45 Min. weiter (privat in `TRACK_DIR`, Hinweis in der Feed-Prüfung) |
| Direktfeeds Dott, Lime, Zeus, Bird | `data/sources-manual.json` → `direct_candidates` | offen, Kandidaten werden je Lauf geprüft |
| [DB API Marketplace](https://developers.deutschebahn.com/db-api-marketplace/apis/) | Call a Bike, StadtRAD Hamburg (GBFS) | kostenlose Registrierung, Secrets `DB_CLIENT_ID`/`DB_API_KEY` |

## Länder (Reiter Länder)

Seit 28.11.2026, Stufe 1: alle übrigen Länder Europas und Japan aus dem GBFS-Verzeichnis von MobilityData ([systems.csv](https://github.com/MobilityData/gbfs/blob/master/systems.csv), Stand 28.11.2026: 843 Systeme in 31 Ländern Europas ohne Deutschland, 4 in Japan). Deutschland bleibt im bestehenden Sammler.

- Ein Prozess je Land (`scripts/welt.mjs <Land>`, Rechenlogik `lib/pulse-welt.js`): ein Absturz oder ein hängender Feed trifft nur dieses Land. Die Phase `welt-start` stößt die Länder gleich nach dem Start des Sammlers an (vier gleichzeitig), sie laufen parallel zum deutschen Lauf; die Phase `welt` wartet am Ende höchstens bis zur Frist (5 Minuten ab Start) und schreibt `welt/index.json`. Länder, die nicht drankommen, stehen im nächsten Lauf vorn. Kein eigener Workflow nötig.
- Je System `readGbfsSystem` wie in Deutschland; ohne Systeme mit Zugangsdaten. Abgänge/Zugänge geschätzt: Stationen über die Bestandsänderung je Station, frei abgestellte Fahrzeuge über die Position (im Umkreis von 30 m steht im nächsten Lauf keines mehr), unabhängig von wechselnden Kennungen. Vergleichsstand privat in `TRACK_DIR/welt/<Land>.json.gz`.
- Abdeckung: nur Anbieter mit Eintrag im Verzeichnis. Lime, Voi und Bolt stehen dort nur mit einem Teil ihrer Städte (Lime 19, Voi 9, Bolt 2 Systeme); weitere Direktfeeds folgen in Stufe 2.
- Schalter: `WELT=0` aus, `WELT_LAENDER=FR,JP` beschränkt, `WELT_BUDGET_MS` Frist, `WELT_CSV` Verzeichnis (Standard `data/cache/systems.csv` aus `build-catalog`).
- Geplant: Stufe 2 Fahrten und Prognose je Stadt (Feiertage und Wetter je Land), Stufe 3 ÖPNV je Land mit offenen Echtzeit-Feeds, Stufe 4 Gemeindegrenzen, Bericht und Disposition.

## Tokio (Reiter Länder)

Seit 28.11.2026 als Gegenbild zu Deutschland: stationsgebundene Leihräder in Tokio, im Reiter Länder unter Japan (keine Prognose, kein Archiv). Phase `tokio` (`scripts/collect/30-tokio.mjs`, Rechenlogik `lib/pulse-tokio.js`), Abruf über die offenen GBFS-Feeds des Public Transportation Open Data Center (ODPT, ohne Schlüssel):

| System | Feed | Auswahl Tokio | Lizenz |
|---|---|---|---|
| docomo bike share | [docomo-cycle-tokyo](https://api-public.odpt.org/api/v4/gbfs/docomo-cycle-tokyo/gbfs.json) | ganzes System (Koordinaten nur auf Plausibilität geprüft) | CC BY 4.0 (`license_url` im Feed) |
| HELLO CYCLING (OpenStreet Corp.) | [hellocycling](https://api-public.odpt.org/api/v4/gbfs/hellocycling/gbfs.json) | ganz Japan; nur Ports mit Adresse `東京都` | wahlweise CC BY 4.0, ODC-BY 1.0 oder ODbL 1.0 ([Lizenzdatei](https://d1yl7kw204zjxn.cloudfront.net/gbfs/v2/public/hellocycling_gbfs_licence.txt)); gewählt CC BY 4.0 |

- `station_status` je Lauf (HELLO CYCLING rund 5 MB), `station_information` höchstens alle 20 h (HELLO CYCLING rund 8 MB). `TOKIO_URL` überschreibt die Basis, leer = aus.
- Fahrten stehen nicht im Feed: Abgänge/Zugänge = Summe der Bestandsänderungen je Port zwischen zwei Läufen (höchstens 40 Minuten Abstand), also eine Untergrenze; Umsetzungen der Betreiber zählen mit.
- LUUP veröffentlicht keinen offenen Feed und fehlt.

Seit 08.11.2026 auch Carsharing und E-Roller: alle offenen deutschen Feeds der Verzeichnisse (u. a. stadtmobil, teilAuto, Flinkster, Getaround, deer, MIKAR, swu2go, Ford Carsharing, stella; MOBIDROM-Datensätze mit Schlagwort Carsharing); ausgeschlossen bleiben nur Systeme außerhalb Deutschlands (`data/sources-manual.json` → `exclude_patterns`). SHARE NOW, MILES und SIXT share haben keine offenen Feeds. Gemeindezuordnung über BKG VG250 (dl-de/by-2-0), vereinfacht ca. 30 m.

## Fahrzeugarten E-Roller und Carsharing

- Art aus GBFS `form_factor`: `car` → `car` (Carsharing), `moped` → `moped` (E-Roller); ohne Angabe am Namen der Quelle (`C.classifyVehicleType`). Bis 07.11.2026 liefen beide unter `other`. Die neuen Arten stehen am Ende von `C.VEHICLE_TYPES` (Index in `ops/<Land>.json` → `types` bleibt für die bisherigen Arten gleich).
- Stationsgebundene Autos melden die Station statt eigener Koordinaten; sie stehen an der Stationsposition und zählen wie Räder an Stationen. Ist die Fahrzeugliste vorhanden, aber leer, während die Stationen Autos bzw. E-Roller melden (deer), zählen die Stationen den Bestand (`vehicleListEmpty`). Quellen nur mit Stationszählern (cambio über MOBIDROM, ZEO, Car-Ship, deer) liefern Bestand und Verfügbarkeit, aber keine Fahrten (keine Kennungen) und damit keine Prognose; die cambio-Feeds bei MOBIDROM sind seit Ende Oktober 2026 nicht mehr aktualisiert (veraltet, zählen nicht).
- Energie niedrig: Ladestand bzw. Tank < 20 % und Reichweite unter 50 km (Auto) bzw. 10 km (E-Roller) statt 5 km (`C.TYPE_RANGE_LOW_KM`, `latest.thresholds.rangeByType`).
- Verfolgung (`lib/pulse-track.js` → `TYPE_RULES`, Mikromobilität unverändert, Regelstand bleibt `2026-11-02a`): E-Roller bis 60 km/h Luftlinie je Laufintervall, Umsetzung „ohne Energieverlust“ erst ab 5 km. Autos: Fahrten bis 72 h, verschwundene Kennungen 7 Tage behalten, bis 120 km/h; kein Akkutausch und keine Abholung bei wenig Energie (ein Auto mit 10 % Tank, das verschwindet, ist eine Ausleihe), kein Sammeltransport, keine Ausbring-/Einsammelgruppen, keine Umsetzungsregel „≥ 2 km ohne Energieverlust“; Rückgabe an derselben Stelle (stationsgebunden) zählt mit ihrer Dauer in Ø Dauer, ohne Distanz.
- Fahrten bei Carsharing (seit 9.11.2026; der erste Tag zählte 2 Fahrtbeginne bei 4.696 Autos): Stationsgebundene Autos bleiben während der Buchung im Feed und kehren an dieselbe Station zurück. Gezählt wird deshalb (`lib/pulse-track.js` → `resTrips`, `CAR_TRIPS`): frei → reserviert = Fahrtbeginn, reserviert → frei = Fahrtende mit Buchungsdauer (Distanz nur, wenn das Auto woanders steht); bei Quellen ohne Fahrzeugliste (deer, ZEO, Car-Ship) weniger buchbare Autos an einer Station = Fahrtbeginne, mehr = Fahrtenden, Fahrzeugminuten = buchbare Autos × Laufintervall; beides mit Massenregel je Quelle. Viele Feeds melden jedes Auto immer als verfügbar (stadtmobil, teilAuto, naturenergie, Grüne Flotte, Getaround, swu2go …) – Buchungen sind dort unsichtbar. Ein Anbieter gilt erst als messbar, wenn er in 7 Tagen ≥ 3 Fahrtbeginne und ≥ 0,05 je Auto und Tag hat; sonst fallen seine Autos aus Ereignissen, Standzeiten, Strömen und Prognose (nur Bestand), `latest.json` → `carTrips` (`measurable`, `unmeasurable`, `perOp`). Autos zählen nicht in den Zellen (Nachfrage-Modell der Disposition).
- Umsatz: Annahmen bis zur Messung Carsharing 180 Min./40 km, E-Roller 18 Min./5 km je Fahrt (`E.DEFAULT_RIDE`); geschätzte Ströme mit eigenen Familien (`FE.TYPE_FALLBACK`).
- Disposition: Voreinstellung je Art (`O.TYPE_PRESETS`): Autos setzt ein Fahrer einzeln um (Transporter = 1), „Tausch“ = Tanken/Laden, Schwelle 25 % und 50 km; E-Roller acht je Transporter, Reichweite 10 km.
- Prognose: je Familie ein eigenes Modell – Mikromobilität (`forecast/`, unverändert), E-Roller (`forecast/moped/`), Carsharing (`forecast/car/`); Umschalter in der Kopfleiste der Prognose, die Familie folgt auch der Fahrzeugart-Auswahl.

## Kommerzielle Nutzung (Lizenz-Matrix)

Marktauftritt M2, `commercialUse` in `lib/pulse-core-base.js`. Jede Quelle bekommt aus der Lizenz im Feed eine Einstufung; keine Rechtsberatung, maßgeblich bleiben die Bedingungen der Quelle.

| Einstufung | Wann |
| --- | --- |
| ja | CC0, dl-de/zero (frei); CC BY, dl-de/by (Namensnennung); CC BY-SA, ODbL (Namensnennung, abgeleitete Daten unter gleichen Bedingungen) |
| ja | Feed über MobiData BW ohne eigene Angabe: Lizenz des Datensatzes im Portal (Sharing-Angebote, dl-de/by-2-0, Stand 14.11.2026) |
| nein | NC-Lizenzen (nicht kommerziell); Lime: Public GBFS Terms erlauben nur interne, nicht kommerzielle Nutzung ([li.me](https://www.li.me/legal/public-gbfs-terms)); Dott-Direktfeeds ohne Lizenzangabe: nur mit API-Lizenzvertrag ([ridedott.com](https://ridedott.com/api-license)) |
| ungeklärt | ohne Angabe, Link auf Kunden-AGB (stella) oder auf eine Datenschutzerklärung |

- `DATA-LICENSE.md` im Datenzweig: Spalte „Kommerziell“ je Lizenz und eine Tabelle je Anbieter (ja, wenn alle Quellen ja sind; teils bei gemischten Quellen), dazu die Einstufung der Grundlagen (ungeklärt: Verkehrsinformation der Autobahn GmbH, Nachrichtensuche der tagesschau-App, Termine aus Programmseiten).
- Quellen-Ansicht: Spalte „Kommerziell“ in der Lizenz-Übersicht.
- Kommunal-Bericht: Schalter „nur Quellen mit geklärter kommerzieller Nutzung“ (`?lizenz=1`) blendet jeden Anbieter aus, der in der Gemeinde eine Quelle mit anderer Einstufung als „ja“ hat (`licenseExclude` in `lib/pulse-report-base.js`); Spiegel einer anderen Quelle (Fahrzeuge verworfen, z. B. Dott-Direktfeed neben MobiData BW) zählen nicht. Der Bericht nennt die ausgeblendeten Anbieter.
- Gelesene Bedingungen stehen in `LICENSE_TERMS` (`lib/pulse-core-base.js`) mit Quelle und Stand; sie gehen der Datensatz-Lizenz eines Verzeichnisses vor, eine Lizenz im Feed geht ihnen vor.
