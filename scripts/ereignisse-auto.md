# Ereignisliste automatisch pflegen (geplante Läufe)

Zwei geplante Läufe halten `data/ereignisse.json` aktuell. Sie laufen als eigene Sitzung ohne Gedächtnis an frühere Läufe; alles Nötige
steht hier. Grundregeln aus `CLAUDE.md` gelten: nur Konto `fcou1005`, `.github/workflows/*` nie ändern, keine Workflows starten.

## Vorbereitung (beide Läufe)

```bash
cd ~ && (test -d mobility-pulse || git clone https://github.com/fcou1005/mobility-pulse.git) && cd mobility-pulse
git checkout main && git pull --rebase origin main
```

Nach jeder Änderung an `data/ereignisse.json`:

```bash
node -e "import('./lib/pulse-context.js').then(CX=>{const r=CX.checkCurated(require('./data/ereignisse.json'));console.log('ok',r.ok.length,'fehlerhaft',r.bad.length,r.bad.slice(0,5));process.exit(r.bad.length?1:0)})"
node test/forecast.test.mjs | grep -c FEHLER   # muss 0 sein
node test/run.mjs | grep -c FEHLER             # muss 0 sein (nutzt Port 8765)
git add data/ereignisse.json && git commit -m "…" && git pull --rebase origin main && git push origin HEAD:main
```

Commit-Nachricht endet mit
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Nichts finden = nichts committen.

## A. Streik-Check (täglich)

Ziel: angekündigte und laufende Streiks, die Sharing-Fahrten verschieben, bevor sie stattfinden.

1. Suchen (WebSearch, höchstens 25 Suchen): Warnstreik/Streik im **ÖPNV** (ver.di, TV-N, Nahverkehr, einzelne Verkehrsbetriebe wie SSB,
   KVB, Rheinbahn, BVG, MVG, VGF, ÜSTRA, LVB, DVB, VAG) und bei der **Bahn** (GDL, EVG, DB, S-Bahn) für heute bis 7 Tage voraus.
   Quellen: Pressemitteilungen von ver.di/GDL/EVG/Verkehrsbetrieb, sonst zwei unabhängige seriöse Medien (tagesschau.de, Regionalsender,
   Lokalzeitung). Gerüchte, Urabstimmungen ohne Termin und Streiks außerhalb des ÖPNV/der Bahn nicht.
2. Je Streik ein Eintrag in `data/ereignisse.json` → `ereignisse`:
   ```json
   { "art": "streik-oepnv", "von": "2026-11-12T03:00", "bis": "2026-11-13T03:00", "gebiet": { "laender": ["BW"] },
     "titel": "Warnstreik ver.di im Nahverkehr Baden-Württemberg", "quelle": "https://…", "id": "streik:<Kurzname-Datum>", "stand": "<heute>" }
   ```
   - `art`: `streik-oepnv` (Busse, Straßen-, U-, Stadtbahnen) oder `streik-bahn` (Fern-/Regionalverkehr, S-Bahn).
   - `gebiet`: ganze Länder `{ "laender": ["BW", "NW", …] }` (Kürzel wie in `lib/pulse-context.js` LAND_OF_AGS), einzelne Städte
     `{ "ags": ["08111000"] }` (AGS aus `data` → `boundaries/index.json` oder `latest.json` → `municipalities`), bundesweit `"DE"`.
   - `von`/`bis`: Ortszeit `YYYY-MM-DDTHH:MM`, sonst ganze Tage `YYYY-MM-DD` (bis einschließlich).
3. Bestehende Streik-Einträge der nächsten 7 Tage prüfen: abgesagt oder verschoben → Eintrag löschen bzw. Datum anpassen.
4. Prüfen, testen, committen (`Streik: …`), pushen. Unklares Gebiet oder Datum: nicht eintragen, im Abschluss nennen.
5. Abschluss (Deutsch, höchstens 5 Zeilen): eingetragene/geänderte Streiks mit Datum und Gebiet, oder „kein Streik angekündigt“.

## B. Wochen-Aktualisierung der Veranstaltungen (wöchentlich, Rotation)

Region nach Kalenderwoche: `node -e "const d=new Date();d.setUTCDate(d.getUTCDate()+4-(d.getUTCDay()||7));const w=Math.ceil(((d-new Date(Date.UTC(d.getUTCFullYear(),0,1)))/864e5+1)/7);console.log(w%5)"`

| Rest | Recherche | umfang | Zeitraum |
|---|---|---|---|
| 0 | Region Süd-West | voll | heute bis +4 Monate |
| 1 | Region Rheinland | voll | heute bis +4 Monate |
| 2 | Region Ruhr/Westfalen/Nord | voll | heute bis +4 Monate |
| 3 | Region Ost/Bayern | voll | heute bis +4 Monate |
| 4 | Volksfeste (alle Städte, `kategorie: "volksfest"`) und Großtermine (Stadionkonzerte, Messen, Marathons, Stadtfeste) | volksfest bzw. ergaenzung | heute bis +15 Monate |

Gemeinden je Region (AGS Name):
- **Süd-West:** 08111000 Stuttgart, 08116078 Leinfelden-Echterdingen (Messe Stuttgart), 08212000 Karlsruhe, 08215108 Rheinstetten (Messe Karlsruhe),
  08222000 Mannheim, 08311000 Freiburg im Breisgau, 08221000 Heidelberg, 08416041 Tübingen, 08415061 Reutlingen, 08335043 Konstanz, 08121000 Heilbronn,
  08231000 Pforzheim, 08326074 Villingen-Schwenningen, 08115003 Böblingen, 08115045 Sindelfingen, 08317096 Offenburg, 08317065 Lahr/Schwarzwald,
  08335075 Singen (Hohentwiel), 07314000 Ludwigshafen am Rhein, 07312000 Kaiserslautern, 07315000 Mainz, 06414000 Wiesbaden, 06411000 Darmstadt,
  06412000 Frankfurt am Main, 06534014 Marburg, 06531005 Gießen, 06611000 Kassel
- **Rheinland:** 05315000 Köln, 05111000 Düsseldorf, 05314000 Bonn, 05334002 Aachen, 05116000 Mönchengladbach, 05124000 Wuppertal, 05112000 Duisburg,
  05162024 Neuss, 05316000 Leverkusen, 05382060 Siegburg, 05382056 Sankt Augustin, 05362012 Brühl, 05122000 Solingen, 05158016 Hilden,
  05158020 Langenfeld (Rhld.), 05158026 Monheim am Rhein, 05378004 Bergisch Gladbach
- **Ruhr/Westfalen/Nord:** 05913000 Dortmund, 05113000 Essen, 05515000 Münster, 05911000 Bochum, 05119000 Oberhausen, 05916000 Herne, 05774032 Paderborn,
  05711000 Bielefeld, 05974040 Soest, 05954036 Witten, 03241001 Hannover, 03241010 Langenhagen, 03241009 Laatzen, 03241005 Garbsen, 04011000 Bremen,
  03101000 Braunschweig, 01002000 Kiel, 03159016 Göttingen, 01060063 Norderstedt, 03353040 Winsen (Luhe)
- **Ost/Bayern:** 11000000 Berlin, 12054000 Potsdam, 14612000 Dresden, 14713000 Leipzig, 15002000 Halle (Saale), 16051000 Erfurt, 09162000 München,
  09564000 Nürnberg, 09562000 Erlangen, 09563000 Fürth, 09761000 Augsburg, 09663000 Würzburg, 09184119 Garching b.München

Ablauf:
1. Auftrag `scripts/ereignisse-recherche.md` lesen (Kriterien, Ausschlüsse, Ausgabeformat, Folgerunden). Zuerst `data/ereignisse.json` lesen.
2. Recherche für die Region der Woche, höchstens 150 Websuchen insgesamt; bei großen Regionen auf 2–3 parallele Recherchen aufteilen (je eine
   JSON-Datei in einem Ordner außerhalb des Repos). `geprueft` nur für Gemeinden, die wirklich vollständig durchgesehen wurden – nur deren
   bisherige Einträge im Zeitraum werden ersetzt.
3. Zusammenführen (Grenzen der Gemeinden mit Sharing-Daten vorher laden):
   ```bash
   curl -s https://raw.githubusercontent.com/fcou1005/mobility-pulse/data/boundaries/index.json -o /tmp/bidx.json
   FROM=<heute> TO=<Ende des Zeitraums> node scripts/ereignisse-merge.mjs <Ordner> /tmp/bidx.json /tmp/vorschau.json --write --rolling
   ```
   Die Ausgabe nennt ersetzt/eingetragen und Verworfenes; offensichtlich Falsches (Datum, Ort) in den JSON-Dateien korrigieren und wiederholen.
4. Stichprobe: drei neue Einträge gegen ihre Quelle prüfen (WebFetch). Dann prüfen, testen, committen
   (`Ereignisliste: Aktualisierung <Region> (KW <n>)`), pushen.
5. Abschluss (Deutsch, höchstens 8 Zeilen): Region, ersetzt/eingetragen je Stadt, was nicht prüfbar war.
