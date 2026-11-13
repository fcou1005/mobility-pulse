# Mobility Pulse

Sharing-Daten für Deutschland (E-Scooter, Bikesharing, Lastenräder, E-Roller, Carsharing frei und stationsgebunden) aus offenen
Quellen – gesammelt, geprüft, zusammengeführt. Ein Sammler ruft alle 20 Minuten rund 490 Quellen ab, zählt Bestand, Fahrten,
Umsetzungen und Akkutausch je Gemeinde, Anbieter und Fahrzeugart und veröffentlicht nur Summen. Das Dashboard zeigt Marktbild,
Prognose, Disposition und Datenqualität für jede Gemeinde.

- **Dashboard:** GitHub Pages aus `docs/` (gebaut aus `web/` und `lib/`).
- **Branch `main`:** Code – Katalog-Builder, Sammler, Rechenkerne, Dashboard, Tests.
- **Branch `data`:** Datenstand, alle 20 Minuten als ein Commit ohne Verlauf neu geschrieben ([Datenstand](handbuch/datenstand.md)).

## Handbuch

| Seite | Inhalt |
| --- | --- |
| [Architektur](handbuch/architektur.md) | Bausteine, Datenfluss, Rechenkerne, Dashboard, Datenschutz |
| [Datenstand](handbuch/datenstand.md) und [Datenformate](handbuch/datenformate.md) | Dateien im Branch `data`, Datenverträge |
| [Quellen](handbuch/quellen.md) und [Regeln](handbuch/regeln.md) | woher die Daten kommen und wie gezählt wird |
| [Kennzahlen](handbuch/kennzahlen.md), [Disposition](handbuch/disposition.md), [Prognose](handbuch/prognose.md) | Methoden der Ansichten |
| [Dashboard](handbuch/dashboard.md) | Bedienung, Ansichten, Sprache |
| [Betrieb](handbuch/betrieb.md) | Workflows, Sammler-Kette, lokal arbeiten, Tests |
| [Entscheidungen](handbuch/entscheidungen.md) | warum etwas so gebaut ist |

## Schnellstart

```sh
npm ci                               # nur für Build und Tests; der Sammler läuft ohne Abhängigkeiten
node scripts/collect.mjs             # Sammler (Datenstand nach data/)
node scripts/build-web.mjs --budget  # Dashboard nach docs/
node scripts/test-all.mjs            # alle Testdateien ohne Netz
node test/browser.mjs                # alle Ansichten mit festem Datenstand
```

Mehr in [Betrieb](handbuch/betrieb.md). Hinweise für Änderungen am Repository stehen in `CLAUDE.md`.

## Lizenz und Datenschutz

Die Daten stammen aus offenen Quellen; Namensnennung und Lizenzen je Quelle stehen im Datenstand (`DATA-LICENSE.md`,
`latest.json` → `sources[]`). Fahrzeugkennungen werden nicht veröffentlicht. Datenschutzerklärung des Dashboards: `web/datenschutz.html`.
