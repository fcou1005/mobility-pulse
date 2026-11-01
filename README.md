# Mobility Pulse

Sharing-Daten für Deutschland (E-Scooter, Bikesharing, Lastenräder) aus offenen Quellen – gesammelt, geprüft, zusammengeführt.

- **Branch `main`:** Code (Katalog-Builder, Sammler, Kernbibliothek, Dashboard).
- **Branch `data`:** Datenstand, alle 20 Minuten neu geschrieben (ein Commit, kein Verlauf im Git):
  `latest.json`, `status.json`, `sources.json`, `history/<Tag>.json`, `snapshot/*.json`, `boundaries-active.json`,
  `events/<Tag>.json` (Fahrten, Umsetzungen, Akkutausch, Abholungen, Sperren je Stunde und Gemeinde × Anbieter × Fahrzeugart),
  `cells/<Tag>/<Land>.json` (Start/Ziel/Präsenz je ≈250-m-Zelle), `idle.json`, `idle-long.json`, `stations-quota.json`,
  `reliability.json`, `pricing.json`, `zones/*.json` (GBFS-Betriebszonen, täglich), `pricing-log.json` (Tarifänderungen, 180 Tage), `history/daily.json` (verdichtete Tageswerte), `DATA-LICENSE.md` (Quellen und Lizenzen). Der Verfolgungszustand (Kennungen per HMAC mit privatem Salt) liegt seit 01.11.2026 im Actions-Cache (`TRACK_DIR`), nicht mehr auf `data`;
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
- Bewegung: Kennung verschwindet = Fahrtbeginn (gesperrt/leer = Abholung), neue Kennung = Fahrtende, bekannte Kennung kehrt zurück = Fahrtende mit Dauer (stabile Kennungen). Kennungswechsel am Ort: verschwundene und neue Kennungen werden je Anbieter global nach Abstand und Ladestand gepaart (gleicher Ladestand ± 2 Punkte bis 100 m, ohne Ladestand bis 40 m). Stabile Kennungen: Versatz ≥ 150 m ist eine Fahrt (3,5–24 km/h), Sammeltransport (≥ 3 Ankünfte ≤ 40 m) oder Sperrung eine Umsetzung. Ladestand < 40 % → ≥ 85 % am Ort = Akkutausch. Läufe nach Lücken > 45 Min. zählen keine Ereignisse; Quellenausfälle erzeugen keine Ereignisse. `lib/pulse-track.js`, Test `test/track.test.mjs`.

## Disposition (`lib/pulse-ops.js`, Ansicht „Disposition“)

- **Nachfrage:** Fahrtbeginne je ≈250-m-Zelle und Tageszeit-Band (Nacht, Morgen, Vormittag, Mittag, Nachmittag, Abend) ÷ Messstunden; Markt über alle Anbieter, Anbieteranteil = Anteil am verfügbaren Bestand.
- **Deploy-Spots:** MCDA mit AHP-Gewichten (Netto-Abfluss 0,52 · Nachfrage 0,28 · ÖPNV-Nähe 0,10 · Abstellfläche 0,10; CR 0,0015). Netto-Abfluss = (Fahrtbeginne − Fahrtenden) ÷ Messstunden je Zelle; Bedarf = Netto-Abfluss × Horizont + Grundbestand, Fehlmenge = Bedarf − Bestand im Umkreis von 150 m, Abstellverbote aus den GBFS-Zonen als Ausschluss, Mindestabstand, ±20-%-Sensitivität je Gewicht. Spots rasten auf E-Scooter-Stellflächen, amtliche Flächen (Berlin WFS) oder Sharing-Punkte ein; Radabstellanlagen zählen halb.
- **Touren:** Umsetzen (Überschuss → Spots mit Bedarf, Transporterkapazität, erst einsammeln, dann ausbringen), Akkutausch (Priorität aus Ladestand und Nachfrage), Werkstatt (gesperrte Fahrzeuge), Stationsausgleich (≤ 20 % aus ≥ 80 % auf 50 %). Reihenfolge Nächster Nachbar + 2-opt + Or-opt; optional OSRM-Straßenrouting im Browser.
- **Exporte:** Spots-CSV im Backend-Format (`name,lat,lng,deploymentStatus,parkingStatus,deploymentRadius,deploymentVehicles`), Analyse-CSV, Touren-CSV, GeoJSON. Test: `node test/ops.test.mjs`.

## Umsatz & Kennzahlen (`lib/pulse-econ.js`, Ansicht „Nutzung & Bewegung“)

- **Fahrten:** verschwundene verfügbare Fahrzeuge; verschwindet eine Kennung und taucht ≤ 40 m daneben eine neue desselben Anbieters auf, ist das ein Kennungswechsel am Ort (keine Fahrt, Standzeit läuft weiter).
- **Rides per Vehicle per Day (RVD):** Fahrten hochgerechnet auf 24 h (Tagesgang aus ≥ 3 vollen Tagen, sonst Standardkurve) ÷ Ø Fahrzeuge auf der Straße (Fahrzeugminuten aus den Sammler-Läufen).
- **Auslastung:** RVD × Ø Fahrtdauer ÷ 1440 Min. Dauer gemessen bei stabilen Kennungen (≥ 20 Fahrten), sonst Annahme (E-Scooter 12 Min., E-Bike 16, Rad 18, Lastenrad 40).
- **Kalibrierung:** `lib/pulse-calib.js` + `data/reference.json`. Ø Fahrtdauer E-Scooter aus den Berliner Quartalswerten (7,1 Min.), Methodenfaktor k = amtliche Berliner Fahrten je E-Scooter und Tag ÷ eigene Berliner Messung (nur plausible Anbieter, Spanne aus den Quartalen, vorläufig unter 7 Messtagen), Messungen über 3,47 Fahrten je Fahrzeug und Tag werden nicht kalibriert. Abdeckung gegen die genehmigte (Berlin) bzw. aktive (München) Flotte. Test: `node test/econ.test.mjs`.
- **Fahrtrouten:** nur Quellen mit stabilen Kennungen; Start-Ziel-Ströme zwischen 250-m-Zellen ab 2 Fahrten je Tag, veröffentlicht nach Tagesende (`flows/<Tag>.json`), Route im Browser per Fahrrad-OSRM (`web/flows.js`).
- **Vermutete Deploy-Spots:** ab 4 Fahrzeugen eines Anbieters ≤ 40 m in einem Lauf; dauerhaft in `groups/<JJJJ-MM>.json` (+ `groups/index.json`), `groups.json` (30 Tage) bleibt für das Briefing.
- **Obergrenzen:** `caps-log.json` (Sammler prüft je Lauf gegen `data/reference.json` → `obergrenzen`).
- **Umsatz:** Fahrten × Preis einer Ø Fahrt im Standardtarif aus `system_pricing_plans` (Abos/Pässe ausgeschlossen), netto ohne 19 % MwSt. und mit Realisierungsquote (Standard 85 %). RVD über 15 gilt als unplausibel und bleibt außerhalb der Summen. Test: `node test/econ.test.mjs`.

## Lokal

```
node scripts/build-catalog.mjs     # data/sources.json
node scripts/prepare-boundaries.mjs # braucht gdal-bin, unzip
node scripts/collect.mjs
node test/run.mjs                   # Fixture-Test
node test/track.test.mjs && node test/ops.test.mjs && node test/econ.test.mjs && node test/core.test.mjs && node test/report.test.mjs
```
