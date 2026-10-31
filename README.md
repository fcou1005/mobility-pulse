# Mobility Pulse

Sharing-Daten für Deutschland (E-Scooter, Bikesharing, Lastenräder) aus offenen Quellen – gesammelt, geprüft, zusammengeführt.

- **Branch `main`:** Code (Katalog-Builder, Sammler, Kernbibliothek, Dashboard).
- **Branch `data`:** Datenstand, alle 20 Minuten neu geschrieben (ein Commit, kein Verlauf im Git):
  `latest.json`, `status.json`, `sources.json`, `history/<Tag>.json`, `snapshot/*.json`, `boundaries-active.json`.

## Quellen

| Verzeichnis | Inhalt | Zugang |
|---|---|---|
| [MobilityData systems.csv](https://github.com/MobilityData/gbfs/blob/master/systems.csv) | alle DE-Systeme des GBFS-Katalogs | offen |
| [MobiData BW](https://api.mobidata-bw.de/sharing/gbfs) | Landesfeeds Baden-Württemberg (bevorzugt) | offen |
| [MOBIDROM NRW](https://www.mobilitaetsdaten.nrw/api/ckan/organization/angemeldet) | Landesfeeds NRW (konflationiert) | OAuth-Dienstzugang laut Datensatzbeschreibung, wird zur Laufzeit gelesen |
| [CityBikes](https://api.citybik.es/v2/networks) | Ergänzung (Stationszähler) | offen |
| Dott Direktfeeds | `gbfs.api.ridedott.com/public/v2/<stadt>/gbfs.json` | offen, Kandidaten werden geprüft |

Carsharing wird ausgeschlossen (`data/sources-manual.json`). Gemeindezuordnung über BKG VG250 (dl-de/by-2-0), vereinfacht ca. 30 m.

## Regeln (Kurzfassung)

- Frische: ≤ 5 Min aktuell, ≤ 30 Min verzögert, darüber veraltet (fließt nicht in Kennzahlen ein).
- Stationen: physischer Bestand, buchbarer Bestand (`is_installed && is_renting`) und Rückgabeplätze getrennt.
- Dubletten je Anbieter über alle Quellen (UUID/Präfix-Normalisierung, Nähe ≤ 300 m); gleiche Kennung weit entfernt bleibt als Prüffall.
- Quellenwechsel: Fingerabdruck aus Endpunkt, Version, Feeds, Fahrzeugarten – Wechsel bricht Zeitvergleiche.
- Energie: Ladestand und Reichweite mit getrennten Nennern (nur Fahrzeuge mit Angabe).
- Fehlender öffentlicher Datenzugang (z. B. Dott Tübingen seit 25.09.2026) wird als Datenlücke geführt, nicht als Nullbestand.

## Lokal

```
node scripts/build-catalog.mjs     # data/sources.json
node scripts/prepare-boundaries.mjs # braucht gdal-bin, unzip
node scripts/collect.mjs
node test/run.mjs                   # Fixture-Test
```
