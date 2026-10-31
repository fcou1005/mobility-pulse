# Mobility Pulse

Sharing-Daten für Deutschland (E-Scooter, Bikesharing, Lastenräder) aus offenen Quellen – gesammelt, geprüft, zusammengeführt.

- **Branch `main`:** Code (Katalog-Builder, Sammler, Kernbibliothek, Dashboard).
- **Branch `data`:** Datenstand, alle 20 Minuten neu geschrieben (ein Commit, kein Verlauf im Git):
  `latest.json`, `status.json`, `sources.json`, `history/<Tag>.json`, `snapshot/*.json`, `boundaries-active.json`,
  `events/<Tag>.json` (Fahrten, Umsetzungen, Akkutausch, Abholungen, Sperren je Stunde und Gemeinde × Anbieter × Fahrzeugart),
  `cells/<Tag>/<Land>.json` (Start/Ziel/Präsenz je ≈250-m-Zelle), `idle.json`, `idle-long.json`, `stations-quota.json`,
  `reliability.json`, `pricing.json`, `zones/*.json` (GBFS-Betriebszonen, täglich), `track/state.json.gz` (gehashte Kennungen, interner Zustand),
  `ops/<Land>.json` (Flotte je Bundesland mit Akku, Reichweite, Standzeit, Stationsfüllstand – Grundlage der Disposition).

## Quellen

| Verzeichnis | Inhalt | Zugang |
|---|---|---|
| [MobilityData systems.csv](https://github.com/MobilityData/gbfs/blob/master/systems.csv) | alle DE-Systeme des GBFS-Katalogs | offen |
| [MobiData BW](https://api.mobidata-bw.de/sharing/gbfs) | Landesfeeds Baden-Württemberg (bevorzugt) | offen |
| [MOBIDROM NRW](https://www.mobilitaetsdaten.nrw/api/ckan/organization/angemeldet) | Landesfeeds NRW (konflationiert) | OAuth-Dienstzugang laut Datensatzbeschreibung, wird zur Laufzeit gelesen |
| [CityBikes](https://api.citybik.es/v2/networks) | Ergänzung (Stationszähler) | offen |
| Direktfeeds Dott, Lime, Zeus, Bird | `data/sources-manual.json` → `direct_candidates` | offen, Kandidaten werden je Lauf geprüft |
| [DB API Marketplace](https://developers.deutschebahn.com/db-api-marketplace/apis/) | Call a Bike, StadtRAD Hamburg (GBFS) | kostenlose Registrierung, Secrets `DB_CLIENT_ID`/`DB_API_KEY` |

Carsharing wird ausgeschlossen (`data/sources-manual.json`). Gemeindezuordnung über BKG VG250 (dl-de/by-2-0), vereinfacht ca. 30 m.

## Regeln (Kurzfassung)

- Frische: ≤ 5 Min aktuell, ≤ 30 Min verzögert, darüber veraltet (fließt nicht in Kennzahlen ein).
- Stationen: physischer Bestand, buchbarer Bestand (`is_installed && is_renting`) und Rückgabeplätze getrennt.
- Dubletten je Anbieter über alle Quellen (UUID/Präfix-Normalisierung, Nähe ≤ 300 m); gleiche Kennung weit entfernt bleibt als Prüffall.
- Quellenwechsel: Fingerabdruck aus Endpunkt, Version, Feeds, Fahrzeugarten – Wechsel bricht Zeitvergleiche.
- Energie: Ladestand und Reichweite mit getrennten Nennern (nur Fahrzeuge mit Angabe).
- Fehlender öffentlicher Datenzugang (z. B. Dott Tübingen seit 25.09.2026) wird als Datenlücke geführt, nicht als Nullbestand.
- Bewegung: Kennung verschwindet = Fahrtbeginn (gesperrt/leer = Abholung), neue Kennung = Fahrtende, bekannte Kennung kehrt zurück = Fahrtende mit Dauer (stabile Kennungen), gleiche Kennung > 150 m versetzt ohne Verschwinden = Umsetzung, Ladestand < 40 % → ≥ 85 % am Ort = Akkutausch. Quellenausfälle erzeugen keine Ereignisse. `lib/pulse-track.js`, Test `test/track.test.mjs`.

## Disposition (`lib/pulse-ops.js`, Ansicht „Disposition“)

- **Nachfrage:** Fahrtbeginne je ≈250-m-Zelle und Tageszeit-Band (Nacht, Morgen, Vormittag, Mittag, Nachmittag, Abend) ÷ Messstunden; Markt über alle Anbieter, Anbieteranteil = Anteil am verfügbaren Bestand.
- **Deploy-Spots:** MCDA mit AHP-Gewichten (Nachfrage 0,56 · Unterversorgung 0,25 · ÖPNV-Nähe 0,10 · Abstellfläche 0,10; CR 0,016), Abstellverbote aus den GBFS-Zonen als Ausschluss, Mindestabstand, ±20-%-Sensitivität je Gewicht. Spots rasten auf E-Scooter-Stellflächen, amtliche Flächen (Berlin WFS) oder Sharing-Punkte ein; Radabstellanlagen zählen halb.
- **Touren:** Umsetzen (Überschuss → Spots mit Bedarf, Transporterkapazität, erst einsammeln, dann ausbringen), Akkutausch (Priorität aus Ladestand und Nachfrage), Werkstatt (gesperrte Fahrzeuge), Stationsausgleich (≤ 20 % aus ≥ 80 % auf 50 %). Reihenfolge Nächster Nachbar + 2-opt + Or-opt; optional OSRM-Straßenrouting im Browser.
- **Exporte:** Spots-CSV im Backend-Format (`name,lat,lng,deploymentStatus,parkingStatus,deploymentRadius,deploymentVehicles`), Analyse-CSV, Touren-CSV, GeoJSON. Test: `node test/ops.test.mjs`.

## Lokal

```
node scripts/build-catalog.mjs     # data/sources.json
node scripts/prepare-boundaries.mjs # braucht gdal-bin, unzip
node scripts/collect.mjs
node test/run.mjs                   # Fixture-Test
node test/track.test.mjs && node test/ops.test.mjs
```
