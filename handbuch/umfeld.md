# Umfeld (Sprint 8)

Ansicht Auswerten › Umfeld (`#umfeld`, `web/umfeld.js`; Kurzlinks `#versorgung`, `#unfaelle`, `#zubringer`, `#umweg`, `#abstellflaechen`). Fünf Fragen an den Raum um die Fahrzeuge: Wie viele Einwohner haben ein Fahrzeug in der Nähe, wo häufen sich Unfälle, wie oft beginnen oder enden Fahrten an Haltestellen, wie weit ist der Fußweg wirklich, wo fehlen Abstellflächen.

## Datenfluss

Zwei Stufen, weil die Quelldateien groß sind und selten neu erscheinen:

1. **Workflow „Geo“** (`scripts/geo.mjs`, Vorlage `scripts/geo-workflow.yml`, am 2. jedes Monats um 2:17 UTC und von Hand): lädt Zensus 2022, Unfallatlas, Fahrplan (gtfs.de), das Fußwegenetz sowie Gleis- und Straßennetz für die Streckenverläufe der ÖPNV-Karte (Overpass, Teil `wege`, siehe [ÖPNV](oepnv.md)) und schreibt die aufbereiteten Dateien in den Branch `geo` (`pop/`, `unfall/`, `gtfs/`, `umweg/`, `index.json`). Der Rechenjob hat nur Leserechte; ein zweiter Job veröffentlicht. Fällig sind Zensus und Unfallatlas nach 330 Tagen (Unfallatlas auch, solange Jahre fehlen), Fahrplan und Fußwegenetz nach 27 Tagen; `only` und `force` beim Start von Hand überschreiben das.
2. **Sammler-Phase `geo`** (`scripts/collect/29-geo.mjs`, nach `akku`): liest den Branch `geo` alle 6 Stunden über `raw.githubusercontent.com` (Zwischenspeicher `TRACK_DIR/geo`), rechnet je Lauf die Versorgung mit den genauen Fahrzeugpositionen und schreibt `versorgung/`, `zubringer/index.json`, `abstell/` und Kopien von `unfall/`, `umweg/` und `pop/index.json` für die aktiven Gemeinden in den Branch `data`. Zustand privat in `TRACK_DIR/geo-state.json.gz`, keine Fahrzeugkennungen in veröffentlichten Dateien.

Formate: [Datenformate](datenformate.md) (Familie `geo`).

## Einwohner (S8.1)

- Quelle: Zensus 2022, Bevölkerung im 100-m-Gitter (Destatis, dl-de/by-2-0, Stichtag 15.05.2022). Zellen mit geheimgehaltenem Wert („–“) zählen nicht.
- Zuordnung: Mittelpunkt der Zelle (EPSG:3035, Lambert-Flächentreu, Umrechnung `lib/pulse-geo-proj.js` nach Snyder) → Gemeinde per Punkt-in-Polygon gegen VG250. Für die Veröffentlichung wird jede 100-m-Zelle flächenanteilig auf die ≈250-m-Zellen des Dashboards verteilt; gerechnet wird mit den Mittelpunkten.
- Abgleich: Summe je Gemeinde gegen die Einwohnerzahl der Gemeindegrenzen (VG250-EW); Abnahme ±3 % (`pop/index.json`: `n`, `within`).
- VG250-EW und Zensus haben verschiedene Stichtage, und die Fortschreibung verschiebt ein Land als Ganzes (Live-Stand November 2026: Median −1,0 %, 946 von 1.212 Gemeinden in ±3 %). Darum zusätzlich `withinAdj`: Abweichung nach Teilen durch den Median von Zensus ÷ VG250-EW im selben Land (`landFactor`); was dann noch über ±3 % liegt, ist Zuordnung (Grenzzellen, geheimgehaltene Zellen) oder eine echte Abweichung der Gemeinde. Je Gemeinde stehen beide Werte in `ags` (`abweichung`, `abweichungLandBereinigt`). Der saubere Vergleich wären die amtlichen Zensus-Ergebnisse je Gemeinde zum selben Stichtag; sie sind nicht eingebunden.

## Versorgung (S8.2)

- Je Lauf und bewohntem 100-m-Mittelpunkt: Abstand zum nächsten verfügbaren Fahrzeug (nicht gesperrt, nicht reserviert, keine Autos). Anteil = Einwohner mit Fahrzeug in 150, 200, 300 m ÷ alle Einwohner der Gemeinde.
- Tageswert 7 bis 22 Uhr: Mittel über die Läufe; „mindestens die Hälfte der Zeit“ = Einwohner, die in mindestens 50 % dieser Läufe ein Fahrzeug in Reichweite hatten. Dazu die Tageszeit-Bänder des Dashboards.
- Gini über 1-km-Zellen: Fahrzeuge je Einwohner, 0 = überall gleich, 1 = alles an einem Ort.
- Prüfung „jeder dritte Lauf“: dieselben Werte nur aus jedem dritten Lauf; Abnahme höchstens 1 Prozentpunkt Abweichung (`diffPP`).
- Untererfassung: Anbieter mit amtlicher Genehmigung in `data/reference.json`, die keinen offenen Feed liefern, stehen in `missingOps` und fehlen in der Rechnung.
- Veröffentlicht ab 20 Fahrzeugen je Gemeinde, stündlich als `today` (vorläufig), abgeschlossene Tage in `days` (30 Tage), schwächste Zellen des letzten Tages in `cells`.

## Unfälle (S8.3)

- Quelle: Unfallatlas der Statistischen Ämter (Unfälle mit Personenschaden, dl-de/by-2-0), alle Jahre ab 2016, die erreichbar sind; fehlende Jahre stehen in `unfall/index.json` → `missingYears`.
- Frühe Jahre enthalten nicht alle Länder. Ein Land gilt in einem Jahr als erfasst, wenn es dort mindestens ein Fünftel seines stärksten Jahres hat (`landsByYear`); jede Gemeinde rechnet nur mit den Jahren ihres Landes (`years` in `unfall/<AGS>.json` und `ags.<AGS>.years`). Ohne diese Regel zählte ein fehlendes Jahr als Jahr ohne Unfälle und drückte Rate und Schwerpunkte.
- Kategorien: alle, mit Rad, mit Fußgänger, mit Motorrad, mit Sonstigen (E-Scooter haben keine eigene Spalte), Getötete oder Schwerverletzte.
- Glättung: Empirical Bayes (Poisson-Gamma, Momente über alle Zellen der Gemeinde) je ≈250-m-Zelle, Rate je Jahr.
- Schwerpunkte: Getis-Ord Gi* mit 3 × 3 Nachbarschaft über alle Zellen der Gemeinde (auch ohne Unfall), Benjamini-Hochberg-Korrektur bei 5 % (FDR). Stabilität: Schwerpunkte der ersten und der zweiten Hälfte der Jahre, Überlappung = gemeinsame ÷ kleinere Menge; Abnahme mindestens 70 %.
- Kontrolle: Summe der Zellen = Summe der Quelle je Gemeinde (`cellSum`, `srcSum`).
- Keine Rate je Fahrt: Unfälle und Sharing-Fahrten lassen sich nicht verknüpfen.

## ÖPNV-Zubringer (S8.5)

- Fahrplan: gtfs.de (CC BY 4.0), aktive Dienste am nächsten Dienstag nach dem Download (Stichtag), Abfahrten je Halt; Halte im Abstand bis 150 m werden gebündelt.
- Je Lauf: Fahrtbeginne und -enden aus dem Vergleich mit dem vorigen Lauf (verschwunden über der Ausblend-Grenze oder mindestens 200 m versetzt = Beginn, neu aufgetaucht oder versetzt = Ende; verliert eine Gruppe über 30 % ihrer Fahrzeuge, zählt ihr Verschwinden nicht).
- Umsetzungen durch den Betreiber zählen nicht: drei oder mehr Fahrzeuge eines Anbieters, die im selben Lauf in 25 m verschwinden oder auftauchen (Ausbringen, Einsammeln, `dropBatches`), und versetzte Fahrzeuge mit mindestens 15 Punkten mehr Akku (Akkutausch). Die Zahl steht als `moved` in `zubringer/index.json`. Einzelne Umsetzungen bei Anbietern mit wechselnder Kennung bleiben unerkannt.
- Grundlinie `base`: Anteil der abgestellten verfügbaren Fahrzeuge in 150 m um einen Halt mit Abfahrten (Mittel über die Läufe). Faktor = Anteil der Beginne und Enden ÷ Grundlinie; über 1 heißt, Fahrten beginnen und enden öfter an Halten, als Fahrzeuge dort stehen. Ohne Grundlinie sagt der Anteil wenig, weil in dichten Innenstädten fast jeder Punkt nahe an einem Halt liegt.
- Index = Beginne und Enden in 150 m um einen gebündelten Halt mit Abfahrten ÷ Abfahrten am Stichtag × 100; Anteil = davon ÷ alle Beginne und Enden. Für die 30 Gemeinden mit den größten Flotten.

## Umwegfaktor (S8.6)

- Fußwegenetz aus OpenStreetMap (Overpass, ODbL) für die 30 größten Flottenstädte, monatlich; Graph in `lib/pulse-geo-net.js` (Dijkstra mit Heap).
- Je bewohnter 100-m-Zelle bis zu acht Ziele (je Himmelsrichtung eines) in 300 bis 800 m Luftlinie; Faktor = Median von Netzweg ÷ Luftlinie; ein Ziel, das im Netz nicht erreichbar ist, zählt mit 2,5. Punkte weiter als 60 m vom Netz zählen nicht. Über 15.000 Zellen wird zufällig ausgewählt (`sampled`).
- Netz: Wege mit `access` no, private, agricultural, forestry, delivery, customers, permit, military und mit `foot` no, private, use_sidepath fallen weg, außer `foot` ist yes, designated oder permissive. Reine Radwege (`highway=cycleway`) zählen nur mit `foot=yes`, `designated` oder `permissive`.
- Gegenprobe: drei Paare je Stadt gegen den Fußgänger-Router von FOSSGIS (`routing.openstreetmap.de`); Abweichung bis ±15 % gilt als passend (`samplesOk`). Seit Format 1.1 bekommt der Router die Netzknoten, an die die Zellmitten angebunden wurden (`a`, `b`, Anbinde-Abstand in `snap`), sodass beide Seiten zwischen denselben Punkten messen.

## Abstellflächen-Planer (S8.4)

- Nachfrage: Fahrtenden je 50-m-Zelle im laufenden Monat (`abstell/<AGS>.json`, nur Zellen mit mindestens 3 Enden).
- Auf Knopfdruck lädt die Seite für den Bereich mit den meisten Enden (höchstens 6 × 6 km) Straßen mit Gehweg, Fußwege, Haltestellen und vorhandene Abstell- und Sharing-Punkte aus OpenStreetMap. Kandidaten alle 25 m entlang von Wegen mit Gehweg; ausgeschlossen sind Orte in Abstell- oder Fahrverbotszonen der Anbieter, unter 20 m an einer Haltestelle und unter 15 m an einer Kreuzung.
- Auswahl: gierig die Orte, die die meisten noch nicht abgedeckten Enden in 50 m abdecken (Abstand der Vorschläge mindestens 50 m). Abnahme: mindestens die Hälfte der Vorschläge liegt in 50 m an einer vorhandenen Fläche (Gegenprobe gegen OSM).

## Tests und Fixture

- `node test/geo.test.mjs`: Projektion, Zensus, Versorgung, Unfälle (Gi*, FDR, EB), Fahrplan, Netz, Planer und ein ganzer Geo-Lauf gegen Ersatz-Server (Port 8795).
- `node test/geo-sammler.test.mjs`: Sammler-Phase `geo` über acht Läufe und einen Tageswechsel.
- Browser: `node test/browser.mjs` prüft die Ansicht und den Planer mit einem Ersatz-Overpass. Solange der Datenstand keine echten Geo-Dateien hat, nimmt `scripts/make-fixture.mjs` den synthetischen Stand aus `test/fixtures/geo-synth` (neu erzeugen mit `node scripts/geo-fixture.mjs`, Port 8794; alle Zahlen dort sind ausgedacht).

## Grenzen

- Die 100-m-Zensuszellen werden als Rechtecke im Gradnetz angenähert (Drehung gegen LAEA unter 4°); für Anteile auf 250-m-Zellen reicht das.
- Fahrtbeginne und -enden kommen aus dem Vergleich zweier Läufe: gebündelte Umsetzungen und Akkutausch sind herausgefiltert, einzelne Umsetzungen bei Anbietern mit wechselnder Kennung nicht, und Fahrten unter 20 Minuten zwischen zwei Läufen mit Rückkehr zum Startort fehlen.
- Der Zubringer-Index hängt am Fahrplan eines Stichtags; in Ferien oder bei Bauarbeiten weicht er ab.
- Der Planer hängt an der Vollständigkeit von OpenStreetMap (Gehweg-Tags, vorhandene Flächen) und an der Erreichbarkeit von Overpass. Als vorhandene Fläche zählen seit 15.11.2026 auch die Abstellinseln der Anbieter (Zonen mit erlaubtem oder vorgeschriebenem Abstellen unter 2.000 m² aus `zones/`): OSM kennt in Stuttgart 69 Flächen, die Feeds 552 Inseln.
- Die Adressen der Quelldateien (Destatis, Unfallatlas) sind im Code hinterlegt; ändern die Ämter sie, meldet der Geo-Lauf den Fehler und die Seite zeigt den letzten Stand.
