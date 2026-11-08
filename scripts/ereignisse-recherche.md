# Auftrag: Großveranstaltungen je Stadt für eine Nachfrageprognose (E-Scooter/Bike-Sharing)

Datum und Zeitraum stehen im Auftrag (bei der ersten Recherche: heute 08.11.2026, Zeitraum 31.10.2026–10.02.2027). Ein Dashboard prognostiziert stündlich die Fahrtbeginne von Sharing-Fahrzeugen je Gemeinde.
Große Veranstaltungen verschieben die Nachfrage (Anreise vorher, Abreise nachher). Gesucht ist eine **belegte** Liste der
Veranstaltungen in den unten genannten Gemeinden im Zeitraum laut Auftrag (vergangene Tage sind erwünscht – sie dienen als
Trainingsdaten).

## Was rein soll
Nur Veranstaltungen mit **mindestens ca. 5.000 Besuchern am Tag** oder spürbarem Menschenauflauf in der Innenstadt:
- Konzerte/Shows/Sport in Arenen und Stadien ab ca. 5.000 Plätzen (auch Handball HBL, Basketball BBL, Boxen, Eiskunstlauf, Shows)
- Messen und Ausstellungen mit vielen Besuchern (Publikumsmessen, große Fachmessen), auch mehrtägig bis ca. 10 Tage
- Karneval/Fasching/Fastnacht/Fasnet: Sitzungs- und Straßenkarneval mit Umzügen und Massenauflauf (insbesondere Weiberfastnacht
  04.02.2027, Rosenmontag 08.02.2027, Veilchendienstag 09.02.2027, Umzüge an den Wochenenden davor)
- Läufe (Marathon, Silvesterlauf), große Silvesterfeiern/-partys im öffentlichen Raum, Lichter-/Lichtfeste, Stadtfeste,
  große angemeldete Demonstrationen, Martinszüge nur, wenn außergewöhnlich groß (≥ 5.000)

## Was NICHT rein soll (kommt schon automatisch oder verzerrt die Prognose)
- Fußball 1./2./3. Bundesliga, DFB-Pokal, Champions League; Eishockey DEL – kommen automatisch aus OpenLigaDB
- Alle Termine in diesen Hallen (werden schon automatisch von deren Programmseiten gelesen): Uber Arena Berlin, Barclays Arena
  Hamburg, Lanxess Arena Köln, Porsche-Arena und Hanns-Martin-Schleyer-Halle Stuttgart, SAP Arena Mannheim, Olympiapark München
  (Olympiahalle, Olympiastadion, Eissportzentrum), ZAG Arena Hannover
- Weihnachtsmärkte, Eiswelten, Winterzirkus und alles, was wochenlang läuft (> 10 Tage) – die Prognose würde sonst die Saison
  als Veranstaltungswirkung lernen
- Schon erfasst: Karneval 11.11.2026 in Köln, Düsseldorf und Mainz
- Kleine Termine (Clubs, Theater, Kino, Vorträge), reine Online-Events, abgesagte Termine

## Recherche
- WebSearch/WebFetch. Jede Zeile braucht eine **offizielle Quelle** (Veranstalter, Halle/Arena, Messe, Stadt, Verein) als URL,
  die du tatsächlich geöffnet hast und auf der Datum (und wenn vorhanden Uhrzeit) steht. Ticketportale (Eventim, Ticketmaster)
  nur, wenn es keine offizielle Seite gibt. Nichts schätzen oder erfinden: kein Datum ohne Beleg.
- Pro Arena/Messe lieber die Programmseite der Halle bzw. den Messekalender durchgehen als einzelne Künstler suchen.
- Größere Hallen zuerst. Wenn eine Stadt nichts Relevantes hat, ist eine leere Liste richtig.

## Ausgabe
Schreibe eine JSON-Datei (Pfad steht in deinem Auftrag) mit genau diesem Aufbau:

```json
{
  "region": "…",
  "umfang": "voll | volksfest | ergaenzung",
  "geprueft": [ { "ags": "08111000", "stadt": "Stuttgart", "quellen": ["https://…programm…"], "hinweis": "kurz, was durchgesehen wurde" } ],
  "veranstaltungen": [
    {
      "ags": "08111000",
      "stadt": "Stuttgart",
      "titel": "Kurzer Name (Ort)",
      "ort": "Name der Halle/des Platzes",
      "beginn": "2026-11-21",
      "ende": "2026-11-21",
      "uhrVon": "20:00",
      "uhrBis": null,
      "besucher": 15000,
      "kategorie": "konzert | sport | messe | karneval | lauf | silvester | fest | demo | show",
      "quelle": "https://…",
      "sicher": "bestätigt | angekündigt"
    }
  ]
}
```

- `umfang`: `voll` = für die Gemeinden unter `geprueft` ist die Liste im Zeitraum vollständig (bei laufender Aktualisierung werden ihre bisherigen
  recherchierten Veranstaltungen im Zeitraum ersetzt); `volksfest` = dasselbe nur für Volksfeste; `ergaenzung` = nur hinzufügen, nichts ersetzen.
- `beginn`/`ende` = Ortsdatum; bei mehrtägigen Messen erster und letzter Tag; `uhrVon`/`uhrBis` = Beginn/Ende Ortszeit
  (Einlass nicht; bei Messen Öffnungszeiten; `null`, wenn nicht belegt).
- `besucher` = Kapazität der Halle oder erwartete Besucher je Tag laut Quelle, sonst `null`.
- Gleiche Veranstaltung an mehreren Tagen in derselben Halle (z. B. Tourstopp zwei Abende): eine Zeile je Abend.

Antworte am Ende in maximal 8 Zeilen: Anzahl Veranstaltungen je Stadt, welche Städte du nicht prüfen konntest und warum.

## Folgerunden (Ergänzung)

Für Folgerunden gilt der Auftrag oben (Kriterien, Ausschlüsse, Ausgabeformat) mit diesen Änderungen:

- **Suchbudget: höchstens 45 WebSearch-Aufrufe** (das Kontingent teilen sich vier Rechercheure). Zähle mit. Nutze WebFetch auf
  Programm- und Kalenderseiten, die in Suchergebnissen auftauchen, statt für jeden Termin neu zu suchen. Wenn das Budget zu Ende
  geht: Ergebnis schreiben, offene Städte in `geprueft` weglassen und in der Antwort nennen.
- **Bereits erfasst** (nicht noch einmal liefern): alles in data/ereignisse.json im Repo – lies die Datei
  zuerst (Feld `ereignisse`, Titel, `von`, `gebiet.ags`) und liefere nur Neues.
- **Zeitraum** steht in deinem Auftrag.
- Ticketportale (Eventim, Ticketmaster) sind als Quelle zulässig, wenn die Halle selbst keinen abrufbaren Kalender hat; dann
  `sicher: "angekündigt"`.
- Volksfeste und Feste über 10 Tage weiterhin nicht (z. B. Cannstatter Wasen, Oktoberfest), Weihnachtsmärkte nicht.
