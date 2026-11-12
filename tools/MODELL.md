# Vortrainiertes Nachfragemodell zum Mitnehmen

Mobility Pulse lernt jeden Tag aus den offenen GBFS-Daten aller Sharing-Anbieter in Deutschland, wann und wie viele Fahrten beginnen. Das
gelernte Modell liegt als kleine Datei im Datenzweig und lässt sich ohne Konto, ohne Schlüssel und ohne Abhängigkeiten für die eigene Flotte
nutzen, auch als **neuer Anbieter** ohne eigene Vergangenheitsdaten.

| Familie | Modelldatei (immer der neueste Stand) |
|---|---|
| E-Scooter, Räder, E-Bikes, Lastenräder | https://raw.githubusercontent.com/fcou1005/mobility-pulse/data/forecast/model.json |
| E-Roller (Mopeds) | https://raw.githubusercontent.com/fcou1005/mobility-pulse/data/forecast/moped/model.json |
| Carsharing | https://raw.githubusercontent.com/fcou1005/mobility-pulse/data/forecast/car/model.json |

Die Dateien entstehen bei jedem Prognose-Lauf (stündlich), sobald für die Familie eine Prognose aktiv ist.

## Schnellstart

```sh
curl -O https://raw.githubusercontent.com/fcou1005/mobility-pulse/main/tools/prognose-modell.mjs
node prognose-modell.mjs --art scooter --gemeinde 08111000 --flotte 300 > prognose.csv
```

Das Ergebnis enthält morgen für Stuttgart je Stunde die erwarteten Fahrtbeginne bei 300 verfügbaren E-Scootern
(`datum;stunde;tagtyp;fahrzeuge;erwartet;band80_von;band80_bis;temperatur;niederschlag`). Eine Zusammenfassung mit Summe und Spitze steht auf
der Konsole. `node prognose-modell.mjs --hilfe` zeigt alle Optionen.

| Option | Wirkung |
|---|---|
| `--art` | `scooter`, `bike`, `ebike`, `cargo`, mit `--familie moped` bzw. `car` auch `moped`, `car` |
| `--flotte N` / `--flotte-csv DATEI` | verfügbare Fahrzeuge, konstant oder je Stunde (`stunde;fahrzeuge` oder `datum;stunde;fahrzeuge`) |
| `--gemeinde AGS` | Gemeindeschlüssel: Stadtzuschlag und Feiertage/Ferien des Landes |
| `--anbieter NAME` | Niveau eines im Modell bekannten Anbieters (z. B. Voi, Bolt, Dott, Lime, nextbike) |
| `--niveau p25\|p50\|p75` | ohne Anbieter: zurückhaltend, typisch (Standard), stark |
| `--zaehlung DATEI` | eigene Zählung `datum;stunde;fahrten;fahrzeuge` – kalibriert das Niveau auf die eigene Flotte |
| `--von`, `--tage` | Zeitraum (Standard: morgen, 1 Tag) |
| `--wetter --lat B --lon L` | DWD-Vorhersage über Bright Sky (kostenlos) statt neutralem Wetter (10 °C, trocken) |
| `--ereignis sport=2026-11-15T14/2026-11-15T19` | Ereignis als Kennzeichen; wirkt nur, wenn das Modell die Wirkung gelernt hat (`ctx`) |
| `--modell DATEI` | gespeicherten Modellstand verwenden (z. B. für reproduzierbare Planung) |

## Was im Modell steckt

Erwartete Fahrtbeginne in einer Stunde = verfügbare Fahrzeuge × λ mit

```
λ = exp( Niveau + hour[h] + dayType[T][h] + types[Art].hour[h]
         + weather.cold·min(t−10, 0)/10 + weather.warm·max(t−10, 0)/10 + weather.rain·(Niederschlag ≥ 0,1 mm)
         + Σ ctx[Ereignis] )
```

- `hour`, `dayType` (W Werktag, F Werktag in den Schulferien, S Samstag, H Sonn- und Feiertag), `types[Art].hour`: Tagesgang auf der Log-Skala
- `weather`: Wirkung von Kälte, Wärme (je 10 K) und Regen
- `ctx`: gelernte Ereigniswirkungen (DWD-Warnung, Autobahn, Streik, Veranstaltung, Volksfest, Heimspiel), sobald genug Fälle vorliegen
- Niveau: `operators["Anbieter|Art"]` für bekannte Anbieter, sonst `types[Art].level.p50` (Median aller Gruppen, nach Fahrzeugstunden
  gewichtet) plus `city[Gemeindeschlüssel]` (wie stark die Anbieter in dieser Gemeinde über oder unter ihrem eigenen Niveau liegen)
- Kalibrierung mit eigener Zählung wie im Modell selbst: `Niveau = log((Σ gezählt + alpha·exp(Niveau₀)) ÷ (Σ erwartet bei Niveau 0 + alpha))`
- `phi`: Überstreuung für das 80-%-Band `erwartet ± 1,2816·√(phi·erwartet)`. Das Band enthält nur das Zählrauschen. Die tatsächliche
  Abweichung je Anbieter und Stunde lag zuletzt bei 15–25 %.

Ohne Skript reicht die Datei „Raten je Fahrzeug (CSV)“ aus der Ansicht *Prognose › Grundlagen & Kontrolle*: Fahrten je verfügbarem Fahrzeug
und Stunde je Fahrzeugart, Tagtyp und Stunde (zurückhaltend, typisch, stark). Mit der eigenen Flotte multiplizieren.

## Grenzen

- „Verfügbar“ heißt fahrbereit und nicht reserviert. Mit der Gesamtflotte (inklusive gesperrter Fahrzeuge) gerechnet, fällt die Prognose zu
  hoch aus.
- Das Modell kennt nur, was in offenen Daten sichtbar ist. Preisaktionen, ÖPNV-Störungen und Baustellen in der Stadt wirken nicht.
  Zonenänderungen und Eingriffe der Anbieter werden seit 11.11.2026 erkannt (`eingriffe.json`), Vollsperrungen in BW, Hamburg und
  München sowie ÖPNV-Störungen (gtfs.de, seit 12.11.2026) gesammelt; das fließt noch nicht ins Modell (siehe *Nicht berücksichtigt* in der Ansicht).
- Bis zum 28.11.2026 läuft eine Lernphase: Veranstaltungen, Volksfeste und Heimspiele werden gesammelt, wirken aber noch nicht.
- Fahrten werden aus wechselnden Fahrzeugstandorten abgeleitet. Bei Anbietern mit rotierenden Kennungen ist die Zählung unsicher; das
  Niveau eines solchen Anbieters ist mit Vorsicht zu lesen.

## Lizenz

Abgeleitet aus offenen GBFS-Daten der Anbieter und Verzeichnisse (Lizenzen und Namensnennung: `DATA-LICENSE.md` im Datenzweig), Wetter: DWD
über Bright Sky, Feiertage und Ferien: OpenHolidays (ODbL). Weitergabe mit Namensnennung „Mobility Pulse (github.com/fcou1005/mobility-pulse)“,
bei Quellen unter CC BY-SA unter gleichen Bedingungen. Keine Gewähr.
